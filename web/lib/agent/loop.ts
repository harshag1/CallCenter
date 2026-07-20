// Author: Harsha Gundala
// loop.ts — operator-agent execution loop: streamed grok completions with server-side tool rounds.

import { chatStream, type ChatMessage } from "../xai";
import { operatorToolCatalog } from "./tools";
import { operatorPrompt } from "./prompt";
import { q } from "../db";
import { log } from "../log";
import type { Session } from "../auth";
import type { ToolCtx } from "./types";
import {
  FUNDED_OPERATOR_CAPABILITIES,
  projectOperatorActionProposal,
  type OperatorActionProposal,
} from "./tools/operator-capability-policy";

const L = log("agent/loop");
const MAX_ROUNDS = 10;
const HISTORY_LIMIT = 40;

export type LoopEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; status: "start" | "done" | "error" }
  | { type: "surface"; surface: unknown }
  | { type: "flow"; flow: unknown; flowMeta?: { id: string; label: string } }
  | { type: "notice"; text: string }
  | { type: "navigate"; tab: string; screenId?: string; experimentId?: string }
  | { type: "operator_action_confirmation"; proposal: OperatorActionProposal }
  | { type: "done" };

async function saveMessage(orgId: string, threadId: string, role: string, content: unknown) {
  await q(
    "INSERT INTO chat_messages (org_id, thread_id, role, content) VALUES ($1,$2,$3,$4)",
    [orgId, threadId, role, JSON.stringify(content)]
  ).catch((e) => L.warn("chat persist failed", { err: e.message }));
}

export async function* runOperator(
  session: Session,
  threadId: string,
  userText: string,
  agentId: string | null,
  origin: string,
  openFlow: { id?: string; label?: string } | null = null
): AsyncGenerator<LoopEvent> {
  const ctx: ToolCtx = { orgId: session.orgId, email: session.email, agentId, origin, threadId };
  // One least-authority snapshot drives both provider exposure and dispatch for
  // the entire turn. Individual funded tools still recheck live policy before
  // reserving quota, so revocation can shrink but never widen authority.
  const catalog = await operatorToolCatalog(ctx);

  // Bounded privacy sweeper. It never selects the private value and uses
  // SKIP LOCKED so normal approvals cannot be stalled by cleanup.
  await q(
    `WITH expired AS (
       SELECT id FROM operator_action_approvals
       WHERE expires_at <= clock_timestamp() AND private_display IS NOT NULL
       ORDER BY expires_at, id LIMIT 200 FOR UPDATE SKIP LOCKED
     )
     UPDATE operator_action_approvals oa
     SET private_display = NULL
     FROM expired WHERE oa.id = expired.id`,
    []
  ).catch((e) => L.warn("operator private display cleanup failed", { err: e instanceof Error ? e.message : "unknown" }));

  // Recover a receipt whose first chat insert was lost after the external
  // action settled. The unique execution index makes this safe on every turn
  // and prevents replay spam from evicting useful conversation history.
  await q(
    `INSERT INTO chat_messages
       (org_id, thread_id, role, content, operator_execution_id)
     SELECT oe.org_id, oe.receipt_thread_id, 'system',
            jsonb_build_object(
              'role', 'system',
              'content', 'Authoritative operator action receipt: ' || oe.public_receipt::text
            ),
            oe.id
     FROM operator_action_executions oe
     WHERE oe.org_id = $1 AND oe.receipt_thread_id = $2
       AND oe.public_receipt IS NOT NULL
       AND hacc_model_safe_operator_receipt(oe.public_receipt)
     ON CONFLICT (operator_execution_id)
       WHERE operator_execution_id IS NOT NULL
     DO NOTHING`,
    [session.orgId, threadId]
  ).catch((e) => L.warn("operator receipt recovery failed", { err: e instanceof Error ? e.message : "unknown" }));

  const history = await q<{ role: string; content: unknown }>(
    "SELECT role, content FROM chat_messages WHERE thread_id = $1 AND org_id = $2 ORDER BY id DESC LIMIT $3",
    [threadId, session.orgId, HISTORY_LIMIT]
  );
  const messages: ChatMessage[] = [
    { role: "system", content: operatorPrompt(session, agentId, openFlow) },
    ...history.reverse().map((m) => m.content as ChatMessage),
    { role: "user", content: userText },
  ];
  await saveMessage(session.orgId, threadId, "user", { role: "user", content: userText });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let text = "";
    const textDeltas: string[] = [];
    let calls: { id: string; name: string; arguments: string }[] = [];

    for await (const ev of chatStream(messages, { tools: [...catalog.tools] })) {
      if (ev.type === "text") {
        text += ev.delta;
        textDeltas.push(ev.delta);
      } else if (ev.type === "tool_calls") {
        calls = ev.calls;
      }
    }

    if (!calls.length) {
      for (const delta of textDeltas) yield { type: "text", delta };
      await saveMessage(session.orgId, threadId, "assistant", { role: "assistant", content: text });
      yield { type: "done" };
      return;
    }

    const fundedCalls = calls.filter((call) =>
      (FUNDED_OPERATOR_CAPABILITIES as readonly string[]).includes(call.name)
    );
    // Until the full streamed response is known, prose such as "sent" is not
    // evidence that an external action happened. Suppress it for funded rounds
    // so the confirmation card is the first user-visible action claim.
    if (!fundedCalls.length) {
      for (const delta of textDeltas) yield { type: "text", delta };
    }

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: fundedCalls.length ? null : text || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    };
    messages.push(assistantMsg);
    await saveMessage(session.orgId, threadId, "assistant", assistantMsg);

    if (fundedCalls.length && calls.length !== 1) {
      for (const call of calls) {
        yield { type: "tool", name: call.name, status: "start" };
        const toolMsg: ChatMessage = {
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: "funded actions must be proposed one at a time" }),
        };
        messages.push(toolMsg);
        await saveMessage(session.orgId, threadId, "tool", toolMsg);
        yield { type: "tool", name: call.name, status: "error" };
      }
      yield { type: "notice", text: "A paid or external action must be reviewed by itself before anything runs." };
      yield { type: "done" };
      return;
    }

    let awaitingHumanConfirmation = false;
    let stopAfterFundedBoundary = false;
    for (const call of calls) {
      const tool = catalog.byName.get(call.name);
      const fundedCall = (FUNDED_OPERATOR_CAPABILITIES as readonly string[]).includes(call.name);
      yield { type: "tool", name: call.name, status: "start" };
      let output: unknown;
      try {
        const args = call.arguments ? JSON.parse(call.arguments) : {};
        if (!tool) throw new Error(`unknown tool ${call.name}`);
        const result = await tool.execute(args, ctx);
        output = result.output;
        if (result.operatorActionConfirmation) {
          if (!fundedCall) {
            throw new Error("invalid operator action confirmation source");
          }
          const proposal = projectOperatorActionProposal(result.operatorActionConfirmation);
          if (!proposal || proposal.capability !== call.name) {
            throw new Error("invalid operator action confirmation");
          }
          awaitingHumanConfirmation = true;
          // Never persist a tool-authored payload for a funded confirmation.
          // The model receives only this canonical, authority-free receipt.
          output = { status: "human_confirmation_required", proposal_id: proposal.proposalId };
          yield {
            type: "operator_action_confirmation",
            proposal,
          };
        } else if (fundedCall) {
          // A funded tool can either return a valid proposal or fail. It may
          // never report successful work and invite another model sample
          // without passing through human confirmation.
          output = { error: "funded_action_confirmation_required" };
          stopAfterFundedBoundary = true;
        } else {
          if (result.surface) yield { type: "surface", surface: result.surface };
          if (result.flow) yield { type: "flow", flow: result.flow, flowMeta: result.flowMeta };
          if (result.notice) yield { type: "notice", text: result.notice };
          if (result.navigate) yield { type: "navigate", ...result.navigate };
        }
        const outputIsError = output !== null && typeof output === "object" && "error" in output;
        yield { type: "tool", name: call.name, status: outputIsError ? "error" : "done" };
      } catch (e) {
        output = { error: fundedCall ? "funded_action_proposal_unavailable" : (e as Error).message };
        if (fundedCall) stopAfterFundedBoundary = true;
        L.error("tool crashed", { tool: call.name, err: (e as Error).message, orgId: ctx.orgId });
        yield { type: "tool", name: call.name, status: "error" };
      }
      const toolMsg: ChatMessage = {
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(output).slice(0, 24_000),
      };
      messages.push(toolMsg);
      await saveMessage(session.orgId, threadId, "tool", toolMsg);
    }
    if (awaitingHumanConfirmation || stopAfterFundedBoundary) {
      yield { type: "done" };
      return;
    }
  }

  yield { type: "notice", text: "Stopped after 10 tool rounds — continue with another message." };
  yield { type: "done" };
}

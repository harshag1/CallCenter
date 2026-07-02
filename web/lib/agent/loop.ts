// Author: Harsha Gundala
// loop.ts — operator-agent execution loop: streamed grok completions with server-side tool rounds.

import { chatStream, type ChatMessage } from "../xai";
import { toolDefs, byName } from "./tools";
import { operatorPrompt } from "./prompt";
import { q } from "../db";
import { log } from "../log";
import type { Session } from "../auth";
import type { ToolCtx } from "./types";

const L = log("agent/loop");
const MAX_ROUNDS = 10;
const HISTORY_LIMIT = 40;

export type LoopEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; status: "start" | "done" | "error" }
  | { type: "surface"; surface: unknown }
  | { type: "flow"; flow: unknown }
  | { type: "notice"; text: string }
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
  origin: string
): AsyncGenerator<LoopEvent> {
  const ctx: ToolCtx = { orgId: session.orgId, email: session.email, agentId, origin };

  const history = await q<{ role: string; content: unknown }>(
    "SELECT role, content FROM chat_messages WHERE thread_id = $1 AND org_id = $2 ORDER BY id DESC LIMIT $3",
    [threadId, session.orgId, HISTORY_LIMIT]
  );
  const messages: ChatMessage[] = [
    { role: "system", content: operatorPrompt(session, agentId) },
    ...history.reverse().map((m) => m.content as ChatMessage),
    { role: "user", content: userText },
  ];
  await saveMessage(session.orgId, threadId, "user", { role: "user", content: userText });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let text = "";
    let calls: { id: string; name: string; arguments: string }[] = [];

    for await (const ev of chatStream(messages, { tools: toolDefs })) {
      if (ev.type === "text") {
        text += ev.delta;
        yield { type: "text", delta: ev.delta };
      } else if (ev.type === "tool_calls") {
        calls = ev.calls;
      }
    }

    if (!calls.length) {
      await saveMessage(session.orgId, threadId, "assistant", { role: "assistant", content: text });
      yield { type: "done" };
      return;
    }

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: text || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    };
    messages.push(assistantMsg);
    await saveMessage(session.orgId, threadId, "assistant", assistantMsg);

    for (const call of calls) {
      const tool = byName.get(call.name);
      yield { type: "tool", name: call.name, status: "start" };
      let output: unknown;
      try {
        const args = call.arguments ? JSON.parse(call.arguments) : {};
        if (!tool) throw new Error(`unknown tool ${call.name}`);
        const result = await tool.execute(args, ctx);
        output = result.output;
        if (result.surface) yield { type: "surface", surface: result.surface };
        if (result.flow) yield { type: "flow", flow: result.flow };
        if (result.notice) yield { type: "notice", text: result.notice };
        yield { type: "tool", name: call.name, status: "error" in (result.output as object ?? {}) ? "error" : "done" };
      } catch (e) {
        output = { error: (e as Error).message };
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
  }

  yield { type: "notice", text: "Stopped after 10 tool rounds — continue with another message." };
  yield { type: "done" };
}

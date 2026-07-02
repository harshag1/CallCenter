// Author: Harsha Gundala
// tasks.ts — background LLM assistant launched from live calls: full transcript context,
// same MCP tool belt (email, sms, tables, search), runs async so the call never blocks.

import { q, qOne } from "./db";
import { chat, type ChatMessage, type ToolDef } from "./xai";
import { listToolsFor, callTool } from "./mcp";
import { log } from "./log";

const L = log("tasks");
const MAX_ROUNDS = 6;
// Call-control tools make no sense off-call.
const EXCLUDED = new Set(["classify", "begin_step", "hold", "play_hold_music", "contact_support"]);

export async function runCallTask(taskId: string): Promise<void> {
  const task = await qOne<{
    id: string; call_id: string; org_id: string; agent_id: string; command: string; attempts: number;
  }>(
    `UPDATE call_tasks SET status = 'running', attempts = attempts + 1
     WHERE id = $1 AND status IN ('pending','running') RETURNING *`,
    [taskId]
  );
  if (!task) return;

  try {
    const scope = { callId: task.call_id, agentId: task.agent_id, orgId: task.org_id };
    const [call, events, org, mcpTools] = await Promise.all([
      qOne<{ direction: string; from_number: string | null; to_number: string | null; status: string; summary: string | null }>(
        "SELECT direction, from_number, to_number, status, summary FROM calls WHERE id = $1", [task.call_id]
      ),
      q<{ type: string; payload: { text?: string; name?: string } }>(
        "SELECT type, payload FROM call_events WHERE call_id = $1 ORDER BY id LIMIT 400", [task.call_id]
      ),
      qOne<{ name: string | null }>("SELECT name FROM orgs WHERE id = $1", [task.org_id]),
      listToolsFor(scope),
    ]);

    const transcript = events
      .filter((e) => ["user_said", "agent_said", "human_segment"].includes(e.type))
      .map((e) => `${e.type === "user_said" ? "Caller" : e.type === "human_segment" ? "Human agent" : "AI agent"}: ${e.payload.text}`)
      .join("\n");

    const tools: ToolDef[] = mcpTools
      .filter((t) => !EXCLUDED.has(t.name))
      .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `You are ${org?.name ?? "the company"}'s background assistant, handling a follow-up task from a phone call. Work autonomously with your tools, then reply with a one-paragraph report of exactly what you did.

CALL CONTEXT:
- direction: ${call?.direction}, caller number: ${(call?.direction === "outbound" ? call?.to_number : call?.from_number) ?? "unknown"}, status: ${call?.status}
- transcript:
${transcript || "(no transcript captured)"}

Rules: send_email/send_sms resolve the caller automatically when 'to' is omitted. Look up the customers table for contact details before asking anything. Never invent facts not in the transcript or tables.`,
      },
      { role: "user", content: task.command },
    ];

    let report = "";
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const msg = await chat(messages, { tools, maxTokens: 1500 });
      if (!msg.tool_calls?.length) {
        report = msg.content ?? "";
        break;
      }
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let output: unknown;
        try {
          output = await callTool(scope, tc.function.name, JSON.parse(tc.function.arguments || "{}"));
        } catch (e) {
          output = { error: (e as Error).message };
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(output).slice(0, 12_000) });
      }
      if (round === MAX_ROUNDS - 1) report = "stopped at tool-round limit";
    }

    await q("UPDATE call_tasks SET status = 'done', result = $2, completed_at = now() WHERE id = $1", [
      task.id, report.slice(0, 4000),
    ]);
    await q("INSERT INTO call_events (call_id, type, payload) VALUES ($1,'task_done',$2)", [
      task.call_id, JSON.stringify({ task_id: task.id, command: task.command, report: report.slice(0, 500) }),
    ]).catch(() => {});
    L.info("task done", { callId: task.call_id, orgId: task.org_id, data: { taskId: task.id } });
  } catch (e) {
    const fatal = task.attempts >= 3;
    await q("UPDATE call_tasks SET status = $2, result = $3 WHERE id = $1", [
      task.id, fatal ? "failed" : "pending", (e as Error).message.slice(0, 500),
    ]);
    L.error("task failed", { callId: task.call_id, err: (e as Error).message });
  }
}

/** Cron hook: end_of_call tasks whose call has ended + stale 'now' tasks that lost their context. */
export async function sweepCallTasks(limit = 5): Promise<number> {
  const due = await q<{ id: string }>(
    `SELECT t.id FROM call_tasks t JOIN calls c ON c.id = t.call_id
     WHERE t.status = 'pending' AND t.attempts < 3
       AND (
         (t.trigger_at = 'end_of_call' AND c.status IN ('completed','failed'))
         OR (t.trigger_at = 'now' AND t.created_at < now() - interval '90 seconds')
       )
     ORDER BY t.created_at LIMIT $1`,
    [limit]
  );
  for (const t of due) await runCallTask(t.id).catch(() => {});
  return due.length;
}

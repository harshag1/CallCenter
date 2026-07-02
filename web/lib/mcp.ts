// Author: Harsha Gundala
// mcp.ts — MCP gateway core: exposes builtin + minted tools to live voice sessions (JSON-RPC over HTTP).

import { q, qOne } from "./db";
import { invokeTool } from "./toolfactory/deploy";
import { log } from "./log";

const L = log("mcp");

type Scope = { callId: string; agentId: string; orgId: string };
type McpToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

const BUILTINS: McpToolDef[] = [
  {
    name: "request_recall",
    description:
      "Schedule a callback to the caller at a specific time (e.g. they ask 'call me back tomorrow at 3pm'). Confirm the number and time out loud before calling this.",
    inputSchema: {
      type: "object",
      properties: {
        to_number: { type: "string", description: "E.164 phone number to call back" },
        run_at: { type: "string", description: "ISO-8601 UTC timestamp for the callback" },
        reason: { type: "string", description: "What the callback is about" },
      },
      required: ["to_number", "run_at", "reason"],
    },
  },
  {
    name: "log_note",
    description: "Attach a structured note to this call record (order numbers, outcomes, follow-ups).",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
      required: ["note"],
    },
  },
];

export async function listToolsFor(scope: Scope): Promise<McpToolDef[]> {
  const agent = await qOne<{ tool_ids: string[] }>(
    `SELECT v.tool_ids FROM agents a JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.active_version
     WHERE a.id = $1 AND a.org_id = $2`,
    [scope.agentId, scope.orgId]
  );
  const minted = agent?.tool_ids.length
    ? await q<{ slug: string; description: string; input_schema: Record<string, unknown> }>(
        "SELECT slug, description, input_schema FROM tools WHERE id = ANY($1) AND org_id = $2 AND deploy_status = 'live'",
        [agent.tool_ids, scope.orgId]
      )
    : [];
  return [
    ...BUILTINS,
    ...minted.map((t) => ({ name: t.slug, description: t.description, inputSchema: t.input_schema })),
  ];
}

export async function callTool(scope: Scope, name: string, args: Record<string, unknown>): Promise<unknown> {
  await q("INSERT INTO call_events (call_id, type, payload) VALUES ($1,'tool_call',$2)", [
    scope.callId, JSON.stringify({ name, args }),
  ]).catch(() => {});

  let result: unknown;
  if (name === "request_recall") {
    const row = await qOne<{ id: string }>(
      `INSERT INTO scheduled_calls (agent_id, to_number, run_at, reason, parent_call_id, created_by)
       VALUES ($1,$2,$3,$4,$5,'voice-agent') RETURNING id`,
      [scope.agentId, args.to_number, args.run_at, args.reason ?? null, scope.callId]
    );
    result = { ok: true, scheduled_id: row!.id, message: `Callback scheduled for ${args.run_at}` };
  } else if (name === "log_note") {
    await q("UPDATE calls SET metadata = metadata || $2 WHERE id = $1", [
      scope.callId, JSON.stringify({ notes: [{ note: args.note, tags: args.tags ?? [], ts: new Date().toISOString() }] }),
    ]);
    result = { ok: true };
  } else {
    const tool = await qOne<{ endpoint_url: string | null }>(
      "SELECT endpoint_url FROM tools WHERE org_id = $1 AND slug = $2 AND deploy_status = 'live'",
      [scope.orgId, name]
    );
    result = tool?.endpoint_url ? await invokeTool(tool.endpoint_url, args) : { error: `unknown tool ${name}` };
  }

  await q("INSERT INTO call_events (call_id, type, payload) VALUES ($1,'tool_result',$2)", [
    scope.callId, JSON.stringify({ name, result }),
  ]).catch(() => {});
  L.info("mcp tool call", { callId: scope.callId, orgId: scope.orgId, data: { name } });
  return result;
}

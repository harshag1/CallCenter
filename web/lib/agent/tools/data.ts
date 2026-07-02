// Author: Harsha Gundala
// data.ts — operator tools: read-only SQL, sandboxed DDL/DML in agent_data, log search.

import { pool, q } from "../../db";
import type { OperatorTool } from "../types";

const ROW_CAP = 200;

export const queryData: OperatorTool = {
  name: "query_data",
  description:
    "Run read-only SQL (SELECT/WITH) against the platform database. Tables: agents, agent_versions, tools, calls, call_events, scheduled_calls, mcp_servers, surfaces, logs, plus anything in the agent_data schema. Always filter org-scoped tables by org_id = {{org_id}} (provided in your system prompt).",
  parameters: {
    type: "object",
    properties: { sql: { type: "string", description: "A single SELECT/WITH statement." } },
    required: ["sql"],
  },
  async execute(args) {
    const sql = String(args.sql).trim().replace(/;+\s*$/, "");
    if (!/^(select|with)\b/i.test(sql)) return { output: { error: "read-only: statement must start with SELECT/WITH" } };
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const res = await client.query(sql);
      await client.query("COMMIT");
      return {
        output: {
          rowCount: res.rowCount,
          rows: res.rows.slice(0, ROW_CAP),
          truncated: (res.rowCount ?? 0) > ROW_CAP,
        },
      };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      return { output: { error: (e as Error).message } };
    } finally {
      client.release();
    }
  },
};

export const manageTable: OperatorTool = {
  name: "manage_table",
  description:
    "Create/alter tables and insert/update/delete rows — ONLY inside the agent_data schema (your sandbox for custom storage). Every table reference must be schema-qualified as agent_data.<table>.",
  parameters: {
    type: "object",
    properties: { sql: { type: "string", description: "DDL or DML statement(s), all schema-qualified with agent_data." } },
    required: ["sql"],
  },
  async execute(args) {
    const sql = String(args.sql);
    const refs = sql.match(/\b(?:table|into|update|from|join)\s+(?:if\s+(?:not\s+)?exists\s+)?([a-zA-Z_."]+)/gi) ?? [];
    const bad = refs.filter((r) => !/agent_data\s*\./i.test(r.split(/\s+/).pop() ?? ""));
    if (bad.length || !/agent_data\./i.test(sql)) {
      return { output: { error: `sandbox violation — all table references must be agent_data.<table>. Offending: ${bad.join(", ") || "no agent_data reference found"}` } };
    }
    if (/\b(drop\s+schema|alter\s+system|create\s+(role|extension|function)|grant|revoke|copy)\b/i.test(sql)) {
      return { output: { error: "statement class not allowed in sandbox" } };
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const res = await client.query(sql);
      await client.query("COMMIT");
      return { output: { ok: true, command: res.command, rowCount: res.rowCount } };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      return { output: { error: (e as Error).message } };
    } finally {
      client.release();
    }
  },
};

export const searchLogs: OperatorTool = {
  name: "search_logs",
  description: "Search recent platform logs (tool executions, calls, errors, deploys).",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Substring match on message; omit for all." },
      level: { type: "string", enum: ["info", "warn", "error"] },
      limit: { type: "number", default: 50 },
    },
  },
  async execute(args, ctx) {
    const rows = await q(
      `SELECT ts, level, scope, message, data FROM logs
       WHERE (org_id = $1 OR org_id IS NULL)
         AND ($2::text IS NULL OR message ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR level = $3)
       ORDER BY ts DESC LIMIT $4`,
      [ctx.orgId, args.query ?? null, args.level ?? null, Math.min(Number(args.limit ?? 50), 200)]
    );
    return { output: rows };
  },
};

// Author: Harsha Gundala
// data.ts — tenant-bound, parameterized platform reads and log search.

import { q } from "../../db";
import type { OperatorTool } from "../types";

const ROW_CAP = 200;
const QUERY_RESOURCES = [
  "agents",
  "calls",
  "scheduled_calls",
  "tools",
  "mcp_servers",
  "surfaces",
  "logs",
] as const;

type QueryResource = (typeof QUERY_RESOURCES)[number];

/** Every statement has a fixed projection and an authoritative org predicate.
 * User values are parameters only; no model-authored SQL reaches Postgres. */
const RESOURCE_SQL: Readonly<Record<QueryResource, string>> = Object.freeze({
  agents: `SELECT id, name, purpose, active_version, phone_number, created_at
           FROM agents
           WHERE org_id = $1
             AND ($2::text IS NULL OR id::text = $2)
             AND ($3::text IS NULL OR 'active' = $3)
             AND ($4::text IS NULL OR name ILIKE '%' || $4 || '%' OR purpose ILIKE '%' || $4 || '%')
           ORDER BY created_at DESC LIMIT $5`,
  calls: `SELECT c.id, c.agent_id, c.direction, c.status, c.from_number, c.to_number,
                 c.started_at, c.ended_at, c.duration_s, c.summary, c.sentiment
          FROM calls c JOIN agents a ON a.id = c.agent_id
          WHERE a.org_id = $1
            AND ($2::text IS NULL OR c.id::text = $2)
            AND ($3::text IS NULL OR c.status = $3)
            AND ($4::text IS NULL OR c.summary ILIKE '%' || $4 || '%')
          ORDER BY c.started_at DESC LIMIT $5`,
  scheduled_calls: `SELECT s.id, s.agent_id, s.to_number, s.run_at, s.reason, s.status,
                            s.attempts, s.parent_call_id, s.created_at
                     FROM scheduled_calls s JOIN agents a ON a.id = s.agent_id
                     WHERE a.org_id = $1
                       AND ($2::text IS NULL OR s.id::text = $2)
                       AND ($3::text IS NULL OR s.status = $3)
                       AND ($4::text IS NULL OR s.reason ILIKE '%' || $4 || '%')
                     ORDER BY s.run_at DESC LIMIT $5`,
  tools: `SELECT id, slug, description, kind, deploy_status, created_at
          FROM tools
          WHERE org_id = $1
            AND ($2::text IS NULL OR id::text = $2)
            AND ($3::text IS NULL OR deploy_status = $3)
            AND ($4::text IS NULL OR slug ILIKE '%' || $4 || '%' OR description ILIKE '%' || $4 || '%')
          ORDER BY created_at DESC LIMIT $5`,
  mcp_servers: `SELECT id, label, allowed_tools, created_at
                FROM mcp_servers
                WHERE org_id = $1
                  AND ($2::text IS NULL OR id::text = $2)
                  AND ($3::text IS NULL OR 'configured' = $3)
                  AND ($4::text IS NULL OR label ILIKE '%' || $4 || '%')
                ORDER BY created_at DESC LIMIT $5`,
  surfaces: `SELECT id, title, pinned, created_at
             FROM surfaces
             WHERE org_id = $1
               AND ($2::text IS NULL OR id::text = $2)
               AND ($3::text IS NULL OR CASE WHEN pinned THEN 'pinned' ELSE 'unpinned' END = $3)
               AND ($4::text IS NULL OR title ILIKE '%' || $4 || '%')
             ORDER BY created_at DESC LIMIT $5`,
  logs: `SELECT id, ts, level, scope, message
         FROM logs
         WHERE org_id = $1
           AND ($2::text IS NULL OR id::text = $2)
           AND ($3::text IS NULL OR level = $3)
           AND ($4::text IS NULL OR message ILIKE '%' || $4 || '%')
         ORDER BY ts DESC LIMIT $5`,
});

function boundedOptionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  return text && text.length <= maxLength ? text : null;
}

function boundedLimit(value: unknown, fallback = 50): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) ? Math.min(Math.max(parsed, 1), ROW_CAP) : fallback;
}

export const queryData: OperatorTool = {
  name: "query_data",
  description:
    "Read one tenant-scoped platform resource through fixed, parameterized queries. For user-created tables, use query_dataset. Raw SQL is never accepted.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      resource: { type: "string", enum: QUERY_RESOURCES },
      id: { type: "string", description: "Optional exact record UUID." },
      status: { type: "string", description: "Optional exact status/level." },
      query: { type: "string", description: "Optional bounded text search." },
      limit: { type: "number", default: 50 },
    },
    required: ["resource"],
  },
  async execute(args, ctx) {
    const resource = typeof args.resource === "string" && QUERY_RESOURCES.includes(args.resource as QueryResource)
      ? args.resource as QueryResource
      : null;
    if (!resource) return { output: { error: "unknown query resource" } };
    const id = boundedOptionalText(args.id, 64);
    const status = boundedOptionalText(args.status, 64);
    const search = boundedOptionalText(args.query, 200);
    if ((args.id && !id) || (args.status && !status) || (args.query && !search)) {
      return { output: { error: "query filters are invalid or too long" } };
    }
    try {
      const rows = await q(RESOURCE_SQL[resource], [ctx.orgId, id, status, search, boundedLimit(args.limit)]);
      return { output: { resource, rowCount: rows.length, rows } };
    } catch {
      return { output: { error: "tenant-scoped query unavailable" } };
    }
  },
};

/** Retained as a fail-closed compatibility export. Arbitrary DDL/DML cannot be
 * made tenant-safe through token inspection; datasets are the supported API. */
export const manageTable: OperatorTool = {
  name: "manage_table",
  description: "Unavailable in the public runtime. Use create_dataset, query_dataset, and write_dataset.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async execute() {
    return { output: { error: "raw SQL storage is disabled; use the tenant-scoped dataset tools" } };
  },
};

export const searchLogs: OperatorTool = {
  name: "search_logs",
  description: "Search this organization's recent platform logs. Global/system logs and structured secret-bearing data are excluded.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Substring match on message; omit for all." },
      level: { type: "string", enum: ["info", "warn", "error"] },
      limit: { type: "number", default: 50 },
    },
  },
  async execute(args, ctx) {
    const search = boundedOptionalText(args.query, 200);
    if (args.query && !search) return { output: { error: "log query is invalid or too long" } };
    const level = args.level === undefined || ["info", "warn", "error"].includes(String(args.level))
      ? args.level ?? null
      : null;
    if (args.level !== undefined && level === null) return { output: { error: "invalid log level" } };
    const rows = await q(
      `SELECT ts, level, scope, message FROM logs
       WHERE org_id = $1
         AND ($2::text IS NULL OR message ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR level = $3)
       ORDER BY ts DESC LIMIT $4`,
      [ctx.orgId, search, level, boundedLimit(args.limit)]
    ).catch(() => []);
    return { output: rows };
  },
};

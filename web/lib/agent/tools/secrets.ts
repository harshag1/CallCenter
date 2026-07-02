// Author: Harsha Gundala
// secrets.ts — operator tools: encrypted env-var vault and external MCP server registry.

import { q } from "../../db";
import { encryptSecret } from "../../vault";
import type { OperatorTool } from "../types";

export const setEnvVar: OperatorTool = {
  name: "set_env_var",
  description:
    "Store an org env var (encrypted at rest) for use by minted tools. If you need a secret value from the user, render a form surface — never ask them to paste secrets into chat if a form is already on screen.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "UPPER_SNAKE_CASE" },
      value: { type: "string" },
    },
    required: ["name", "value"],
  },
  async execute(args, ctx) {
    const name = String(args.name).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    await q(
      `INSERT INTO env_vars (org_id, name, value_encrypted) VALUES ($1,$2,$3)
       ON CONFLICT (org_id, name) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_at = now()`,
      [ctx.orgId, name, encryptSecret(String(args.value))]
    );
    return { output: { ok: true, name }, notice: `Secret ${name} saved` };
  },
};

export const listEnvVars: OperatorTool = {
  name: "list_env_vars",
  description: "List org env var NAMES and timestamps. Values are never readable — not by you, not in chat.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    const rows = await q(
      "SELECT name, created_at, updated_at FROM env_vars WHERE org_id = $1 ORDER BY name",
      [ctx.orgId]
    );
    return { output: rows };
  },
};

export const addMcpServer: OperatorTool = {
  name: "add_mcp_server",
  description:
    "Register an external MCP server (streamable HTTP URL). Its tools become attachable to voice bots via update_agent's mcp_server_ids.",
  parameters: {
    type: "object",
    properties: {
      label: { type: "string" },
      server_url: { type: "string" },
      auth_header: { type: "string", description: "Optional full Authorization header value; stored encrypted." },
      allowed_tools: { type: "array", items: { type: "string" }, description: "Optional allowlist; omit for all." },
    },
    required: ["label", "server_url"],
  },
  async execute(args, ctx) {
    const rows = await q<{ id: string }>(
      `INSERT INTO mcp_servers (org_id, label, server_url, auth_header_encrypted, allowed_tools)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [
        ctx.orgId, args.label, args.server_url,
        args.auth_header ? encryptSecret(String(args.auth_header)) : null,
        (args.allowed_tools as string[]) ?? null,
      ]
    );
    return { output: { ok: true, id: rows[0].id }, notice: `MCP "${args.label}" connected` };
  },
};

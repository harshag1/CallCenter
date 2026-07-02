// Author: Harsha Gundala
// factory.ts — operator tools: mint, deploy, and test serverless edge tools autonomously.

import { q, qOne } from "../../db";
import { decryptSecret } from "../../vault";
import { wrapToolSource, RUN_SIGNATURE_DOC } from "../../toolfactory/template";
import { deployTool, invokeTool, pushToolEnv } from "../../toolfactory/deploy";
import type { OperatorTool } from "../types";

export const createTool: OperatorTool = {
  name: "create_tool",
  description:
    `Create (or update) a custom tool and deploy it to a serverless edge function. Voice bots and you can call it immediately after deploy. ${RUN_SIGNATURE_DOC}`,
  parameters: {
    type: "object",
    properties: {
      slug: { type: "string", description: "kebab-case identifier, e.g. check-order-status" },
      description: { type: "string", description: "One sentence: what it does and when a bot should call it." },
      input_schema: { type: "object", description: "JSON Schema for the tool's input object." },
      source: { type: "string", description: "The async function run(input, env) { ... } source." },
      env_var_names: { type: "array", items: { type: "string" }, description: "Vault env var names this tool reads." },
    },
    required: ["slug", "description", "input_schema", "source"],
  },
  async execute(args, ctx) {
    const slug = String(args.slug).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (!/async\s+function\s+run\s*\(/.test(String(args.source))) {
      return { output: { error: "source must define `async function run(input, env)`" } };
    }
    const envNames = (args.env_var_names as string[]) ?? [];

    const row = await qOne<{ id: string }>(
      `INSERT INTO tools (org_id, slug, description, input_schema, kind, source_code, deploy_status, env_var_names, created_by)
       VALUES ($1,$2,$3,$4,'edge',$5,'deploying',$6,$7)
       ON CONFLICT (org_id, slug) DO UPDATE SET
         description = EXCLUDED.description, input_schema = EXCLUDED.input_schema,
         source_code = EXCLUDED.source_code, deploy_status = 'deploying', env_var_names = EXCLUDED.env_var_names
       RETURNING id`,
      [ctx.orgId, slug, args.description, JSON.stringify(args.input_schema), args.source, envNames, `operator (${ctx.email})`]
    );

    try {
      // Gateway auth secret + any vault secrets the tool declares.
      const envPayload: Record<string, string> = { TOOL_SHARED_SECRET: process.env.MCP_GATEWAY_SECRET! };
      if (envNames.length) {
        const vaultRows = await q<{ name: string; value_encrypted: string }>(
          "SELECT name, value_encrypted FROM env_vars WHERE org_id = $1 AND name = ANY($2)",
          [ctx.orgId, envNames]
        );
        const missing = envNames.filter((n) => !vaultRows.some((r) => r.name === n));
        if (missing.length) {
          await q("UPDATE tools SET deploy_status = 'draft' WHERE id = $1", [row!.id]);
          return { output: { error: `missing vault env vars: ${missing.join(", ")}. Ask the user for values via set_env_var first.` } };
        }
        for (const r of vaultRows) envPayload[r.name] = decryptSecret(r.value_encrypted);
      }
      await pushToolEnv(envPayload);

      const { deploymentId, url } = await deployTool(slug, wrapToolSource(slug, String(args.source)));
      await q("UPDATE tools SET deploy_status = 'live', endpoint_url = $2 WHERE id = $1", [row!.id, url]);
      await q(
        "INSERT INTO tool_deployments (tool_id, vercel_deployment_id, status) VALUES ($1,$2,'READY')",
        [row!.id, deploymentId]
      );
      return {
        output: { ok: true, tool_id: row!.id, slug, endpoint_url: url },
        notice: `Tool "${slug}" deployed`,
      };
    } catch (e) {
      const msg = (e as Error).message;
      await q("UPDATE tools SET deploy_status = 'failed' WHERE id = $1", [row!.id]);
      await q("INSERT INTO tool_deployments (tool_id, status, logs) VALUES ($1,'ERROR',$2)", [row!.id, msg]);
      return { output: { error: `deploy failed: ${msg}` } };
    }
  },
};

export const testTool: OperatorTool = {
  name: "test_tool",
  description: "Invoke a deployed tool with sample input and return its output + latency. Always smoke-test after create_tool.",
  parameters: {
    type: "object",
    properties: {
      slug: { type: "string" },
      input: { type: "object" },
    },
    required: ["slug", "input"],
  },
  async execute(args, ctx) {
    const tool = await qOne<{ endpoint_url: string | null; deploy_status: string }>(
      "SELECT endpoint_url, deploy_status FROM tools WHERE org_id = $1 AND slug = $2",
      [ctx.orgId, args.slug]
    );
    if (!tool?.endpoint_url) return { output: { error: `tool not deployed (status: ${tool?.deploy_status ?? "missing"})` } };
    const t0 = Date.now();
    const output = await invokeTool(tool.endpoint_url, args.input);
    return { output: { latency_ms: Date.now() - t0, output } };
  },
};

export const listTools: OperatorTool = {
  name: "list_tools",
  description: "List this org's tools (builtin + minted), their schemas, deploy status, and endpoints.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    const rows = await q(
      `SELECT id, slug, description, kind, deploy_status, endpoint_url, env_var_names, input_schema
       FROM tools WHERE org_id = $1 ORDER BY created_at`,
      [ctx.orgId]
    );
    return { output: rows };
  },
};

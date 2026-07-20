// Author: Harsha Gundala
// factory.ts — operator tools: mint, deploy, and test serverless edge tools autonomously.

import { q, qOne } from "../../db";
import { hashFlowValue } from "../../flow-runtime";
import { decryptCredentialSecret } from "../../vault";
import {
  wrapToolSource,
  validateToolEnvironmentNames,
  validateToolSource,
  RUN_SIGNATURE_DOC,
} from "../../toolfactory/template";
import {
  deployTool,
  isolatedToolProject,
} from "../../toolfactory/deploy";
import { generateToolInvocationKeyPair } from "../../toolfactory/invocation";
import {
  normalizeVoiceToolSchema,
} from "../../voice-tools/schema";
import type { OperatorTool } from "../types";

function requiredSecretApproval(input: {
  orgId: string;
  slug: string;
  source: string;
  inputSchema: Readonly<Record<string, unknown>>;
  envNames: readonly string[];
}): string {
  return hashFlowValue({
    version: 1,
    organization_id: input.orgId,
    slug: input.slug,
    source: input.source,
    input_schema: input.inputSchema,
    env_var_names: [...input.envNames],
  });
}

function configuredSecretApprovals(): ReadonlySet<string> {
  return new Set((process.env.GENERATED_TOOL_SECRET_APPROVALS ?? "")
    .split(/[\s,]+/)
    .filter((value) => /^[a-f0-9]{64}$/.test(value)));
}

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
      source: { type: "string", description: "The async function run(input, env, context) { ... } source." },
      env_var_names: { type: "array", items: { type: "string" }, description: "Vault env var names this tool reads." },
    },
    required: ["slug", "description", "input_schema", "source"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    if (process.env.ENABLE_TOOL_FACTORY !== "true") {
      return { output: { error: "tool deployment is disabled; set ENABLE_TOOL_FACTORY=true after reviewing SECURITY.md" } };
    }
    const rawArgs = args as Record<string, unknown>;
    const slug = String(rawArgs.slug);
    if (rawArgs.slug !== slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64) {
      return { output: { error: "slug must be a 1-64 character kebab-case identifier" } };
    }
    const source = String(rawArgs.source);
    const description = typeof rawArgs.description === "string" ? rawArgs.description : "";
    let envNames: string[];
    let inputSchema: Readonly<Record<string, unknown>>;
    try {
      if (!description.trim() || Buffer.byteLength(description, "utf8") > 8 * 1024) {
        throw new Error("description must be a non-empty string of at most 8KB");
      }
      inputSchema = normalizeVoiceToolSchema(rawArgs.input_schema, {
        label: `generated tool "${slug}" input schema`,
      });
      validateToolSource(source);
      if (rawArgs.env_var_names !== undefined && !Array.isArray(rawArgs.env_var_names)) {
        throw new Error("env_var_names must be an array");
      }
      envNames = validateToolEnvironmentNames((rawArgs.env_var_names as string[] | undefined) ?? []);
    } catch (error) {
      return { output: { error: error instanceof Error ? error.message : "invalid generated tool" } };
    }
    if (envNames.length > 0) {
      const approvalSha256 = requiredSecretApproval({
        orgId: ctx.orgId,
        slug,
        source,
        inputSchema,
        envNames,
      });
      if (!configuredSecretApprovals().has(approvalSha256)) {
        return {
          output: {
            error: "secret-bearing generated code requires an exact human-reviewed source approval",
            approval_sha256: approvalSha256,
            guidance: "Review this exact source/schema/env manifest, then add only its digest to GENERATED_TOOL_SECRET_APPROVALS.",
          },
        };
      }
    }
    const invocationKeys = generateToolInvocationKeyPair();
    const deploymentProject = isolatedToolProject(ctx.orgId, slug, invocationKeys.keyId);

    const createdBy = `operator (${ctx.email})`;
    let row = await qOne<{ id: string; invocation_key_id: string | null }>(
      "SELECT id, invocation_key_id FROM tools WHERE org_id = $1 AND slug = $2",
      [ctx.orgId, slug]
    );
    if (!row) row = await qOne<{ id: string; invocation_key_id: string | null }>(
      `INSERT INTO tools
        (org_id, slug, description, input_schema, kind, source_code, deploy_status,
         env_var_names, created_by)
       VALUES ($1,$2,$3,$4,'edge',$5,'draft',$6,$7)
       ON CONFLICT (org_id, slug) DO NOTHING
       RETURNING id, invocation_key_id`,
      [
        ctx.orgId,
        slug,
        description,
        JSON.stringify(inputSchema),
        source,
        envNames,
        createdBy,
      ]
    );
    if (!row) row = await qOne<{ id: string; invocation_key_id: string | null }>(
      "SELECT id, invocation_key_id FROM tools WHERE org_id = $1 AND slug = $2",
      [ctx.orgId, slug]
    );
    if (!row) return { output: { error: "tool identity could not be staged" } };
    const baselineKeyId = row.invocation_key_id;

    try {
      await q(
        `INSERT INTO tool_invocation_revisions
          (key_id, tool_id, public_key, private_key_encrypted, deployment_project,
           description, input_schema, source_code, env_var_names, created_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'deploying')`,
        [
          invocationKeys.keyId,
          row!.id,
          invocationKeys.publicKeySpki,
          invocationKeys.privateKeyPkcs8Encrypted,
          deploymentProject,
          description,
          JSON.stringify(inputSchema),
          source,
          envNames,
          createdBy,
        ]
      );
      // Only the vault names explicitly declared by this tool enter its isolated deployment.
      // Framework roots and invocation credentials are never part of this payload.
      const envPayload: Record<string, string> = {};
      if (envNames.length) {
        const vaultRows = await q<{
          name: string;
          value_encrypted: string;
          value_encryption_slot_id: string | null;
        }>(
          `SELECT name, value_encrypted, value_encryption_slot_id
           FROM env_vars WHERE org_id = $1 AND name = ANY($2)`,
          [ctx.orgId, envNames]
        );
        const missing = envNames.filter((n) => !vaultRows.some((r) => r.name === n));
        if (missing.length) {
          await q(
            "UPDATE tool_invocation_revisions SET status = 'failed' WHERE key_id = $1 AND status = 'deploying'",
            [invocationKeys.keyId]
          );
          return { output: { error: `missing vault env vars: ${missing.join(", ")}. Ask the user to add them through the secure credential form first.` } };
        }
        const unusable = vaultRows.filter((credential) => !credential.value_encryption_slot_id);
        if (unusable.length) {
          await q(
            "UPDATE tool_invocation_revisions SET status = 'failed' WHERE key_id = $1 AND status = 'deploying'",
            [invocationKeys.keyId]
          );
          return {
            output: {
              error: `vault env vars require secure re-entry: ${unusable.map((row) => row.name).sort().join(", ")}`,
              code: "credential_reentry_required",
            },
          };
        }
        try {
          for (const credential of vaultRows) {
            envPayload[credential.name] = decryptCredentialSecret(
              credential.value_encrypted,
              {
                orgId: ctx.orgId,
                sinkKind: "env_var",
                sinkId: credential.name,
                slotId: credential.value_encryption_slot_id!,
              }
            );
          }
        } catch {
          await q(
            "UPDATE tool_invocation_revisions SET status = 'failed' WHERE key_id = $1 AND status = 'deploying'",
            [invocationKeys.keyId]
          );
          return {
            output: {
              error: "one or more vault env vars failed context authentication; re-enter them securely",
              code: "credential_reentry_required",
            },
          };
        }
      }
      const wrapped = wrapToolSource(slug, source, {
        keyId: invocationKeys.keyId,
        publicKeySpki: invocationKeys.publicKeySpki,
        envNames,
      });
      const { deploymentId, url } = await deployTool(slug, wrapped, {
        project: deploymentProject,
        runtimeEnvironment: envPayload,
      });
      const published = await qOne<{ id: string }>(
        `WITH locked_tool AS MATERIALIZED (
           SELECT t.id
           FROM tools t
           WHERE t.id = $1
             AND t.invocation_key_id IS NOT DISTINCT FROM $2
             AND (
               $2::text IS NULL
               OR EXISTS (
                 SELECT 1
                 FROM tool_invocation_revisions current_revision
                 WHERE current_revision.key_id = $2
                   AND current_revision.tool_id = t.id
                   AND current_revision.status = 'live'
                   AND current_revision.endpoint_url = t.endpoint_url
               )
             )
           FOR UPDATE
         ), activated AS (
           UPDATE tool_invocation_revisions
           SET status = 'live', endpoint_url = $8, deployed_at = now()
           WHERE key_id = $3 AND tool_id = $1 AND status = 'deploying'
             AND EXISTS (SELECT 1 FROM locked_tool)
           RETURNING key_id
         ), protected_cleanup AS (
           UPDATE hacc_private.generated_tool_cleanup_jobs cleanup
           SET status = 'protected',
               claim_token = NULL,
               claimed_at = NULL,
               claim_expires_at = NULL,
               last_error_code = NULL,
               cleaned_at = NULL,
               updated_at = now()
           WHERE cleanup.key_id = $3
             AND cleanup.status = 'cleanup_required'
             AND EXISTS (SELECT 1 FROM activated)
           RETURNING cleanup.key_id
         ), deployment_recorded AS (
           INSERT INTO tool_deployments
             (tool_id, vercel_deployment_id, status)
           SELECT $1, $11, 'READY'
           FROM activated
           JOIN protected_cleanup ON protected_cleanup.key_id = activated.key_id
           RETURNING tool_id
         ), published AS (
           UPDATE tools
           SET description = $4,
               input_schema = $5,
               source_code = $6,
               env_var_names = $7,
               deploy_status = 'live',
               endpoint_url = $8,
               invocation_key_id = $3,
               deployment_project = $9,
               created_by = $10
           WHERE id = $1 AND invocation_key_id IS NOT DISTINCT FROM $2
             AND EXISTS (SELECT 1 FROM deployment_recorded)
           RETURNING id
         ), retired AS (
           UPDATE tool_invocation_revisions
           SET status = 'retired'
           WHERE key_id = $2 AND tool_id = $1 AND status = 'live'
             AND EXISTS (SELECT 1 FROM published)
           RETURNING key_id
         ), retired_cleanup AS (
           UPDATE hacc_private.generated_tool_cleanup_jobs cleanup
           SET status = 'cleanup_required',
               reason_code = 'retired',
               next_attempt_at = now() + interval '24 hours',
               claim_token = NULL,
               claimed_at = NULL,
               claim_expires_at = NULL,
               last_error_code = NULL,
               cleaned_at = NULL,
               updated_at = now()
           WHERE cleanup.key_id IN (SELECT key_id FROM retired)
             AND cleanup.status = 'protected'
           RETURNING cleanup.key_id
         )
         SELECT p.id
         FROM published p
         JOIN activated a ON true
         JOIN deployment_recorded d ON d.tool_id = p.id`,
        [
          row!.id,
          baselineKeyId,
          invocationKeys.keyId,
          description,
          JSON.stringify(inputSchema),
          source,
          envNames,
          url,
          deploymentProject,
          createdBy,
          deploymentId,
        ]
      );
      if (!published) {
        await q(
          "UPDATE tool_invocation_revisions SET status = 'retired' WHERE key_id = $1 AND tool_id = $2 AND status = 'deploying'",
          [invocationKeys.keyId, row!.id]
        ).catch(() => {});
        await q(
          `UPDATE hacc_private.generated_tool_cleanup_jobs
           SET reason_code = 'superseded',
               next_attempt_at = LEAST(next_attempt_at, now()),
               updated_at = now()
           WHERE key_id = $1 AND org_id = $2 AND status = 'cleanup_required'`,
          [invocationKeys.keyId, ctx.orgId]
        ).catch(() => {});
        await q(
          "INSERT INTO tool_deployments (tool_id, vercel_deployment_id, status, logs) VALUES ($1,$2,'CANCELED',$3)",
          [row!.id, deploymentId, "generated_tool_deploy_superseded"]
        ).catch(() => {});
        return {
          output: {
            error: "generated tool deployment was superseded by a newer revision",
            code: "generated_tool_deploy_superseded",
          },
        };
      }
      return {
        output: {
          ok: true,
          tool_id: row!.id,
          slug,
          endpoint_url: url,
        },
        notice: `Tool "${slug}" deployed`,
      };
    } catch {
      await q(
        "UPDATE tool_invocation_revisions SET status = 'failed' WHERE key_id = $1 AND status = 'deploying'",
        [invocationKeys.keyId]
      ).catch(() => {});
      await q(
        `UPDATE hacc_private.generated_tool_cleanup_jobs
         SET reason_code = 'deploy_failed',
             next_attempt_at = LEAST(next_attempt_at, now()),
             updated_at = now()
         WHERE key_id = $1 AND org_id = $2 AND status = 'cleanup_required'`,
        [invocationKeys.keyId, ctx.orgId]
      ).catch(() => {});
      // Dependencies may echo submitted source or credentials in errors. Persist/return only a
      // stable public code; provider details belong in a separately redacted operator channel.
      await q(
        "INSERT INTO tool_deployments (tool_id, status, logs) VALUES ($1,'ERROR',$2)",
        [row!.id, "generated_tool_deploy_failed"]
      ).catch(() => {});
      return { output: { error: "generated tool deployment failed", code: "generated_tool_deploy_failed" } };
    }
  },
};

export const testTool: OperatorTool = {
  name: "test_tool",
  description: "Explain how to test a generated tool through a receipt-backed Flow v2 action. Direct builder execution is disabled because even secretless code can mutate public systems.",
  parameters: {
    type: "object",
    properties: {
      slug: { type: "string" },
      input: { type: "object" },
    },
    required: ["slug", "input"],
    additionalProperties: false,
  },
  async execute() {
    return {
      output: {
        error: "direct generated-tool tests are disabled; grant the tool in a Flow v2 step with an explicit non-none idempotency policy",
        code: "generated_tool_test_requires_receipt_backed_flow",
      },
    };
  },
};

export const listTools: OperatorTool = {
  name: "list_tools",
  description: "List this org's tools (builtin + minted), their schemas, deploy status, endpoints, and current revision cleanup state.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    const rows = await q(
      `SELECT tools.id, tools.slug, tools.description, tools.kind, tools.deploy_status,
              tools.endpoint_url, tools.env_var_names, tools.input_schema,
              revisions.status AS revision_status,
              cleanup.status AS cleanup_status,
              cleanup.attempts AS cleanup_attempts,
              cleanup.last_error_code AS cleanup_error_code
       FROM tools
       LEFT JOIN tool_invocation_revisions AS revisions
         ON revisions.key_id = tools.invocation_key_id
        AND revisions.tool_id = tools.id
       LEFT JOIN hacc_private.generated_tool_cleanup_jobs AS cleanup
         ON cleanup.key_id = revisions.key_id
        AND cleanup.org_id = tools.org_id
       WHERE tools.org_id = $1
       ORDER BY tools.created_at`,
      [ctx.orgId]
    );
    return { output: rows };
  },
};

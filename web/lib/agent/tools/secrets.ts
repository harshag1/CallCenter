// Author: Harsha Gundala
// secrets.ts — operator tools for non-authorizing credential handoff and MCP registration.

import { randomUUID } from "node:crypto";
import { q } from "../../db";
import {
  createCredentialIngestSlot,
  CredentialVaultError,
} from "../../credential-vault";
import { snapshotExternalMcpServer } from "../../remote-mcp-runtime";
import type { Surface } from "../../surface-dsl";
import type { OperatorTool, ToolResult } from "../types";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:/-]{1,128}$/;
const MAX_MCP_TOOLS = 256;

function hasExactKeys(args: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const permitted = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(args, key))
    && Object.keys(args).every((key) => permitted.has(key));
}

function canonicalMcpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function canonicalAllowedTools(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value)
    || value.length > MAX_MCP_TOOLS
    || value.some((entry) => typeof entry !== "string" || !MCP_TOOL_NAME_PATTERN.test(entry))
  ) return null;
  const sorted = [...value].sort();
  return new Set(sorted).size === sorted.length ? sorted : null;
}

function validMcpLabel(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && value.trim() === value
    && !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value);
}

function credentialSurface(input: Readonly<{
  title: string;
  label: string;
  credentialLabel: string;
  submitLabel: string;
  slotId: string;
  expiresAt: string;
  destination?: string;
  allowedTools?: "all" | readonly string[];
}>): Surface {
  return {
    title: input.title,
    blocks: [{
      kind: "credential_form",
      slotId: input.slotId,
      label: input.label,
      credentialLabel: input.credentialLabel,
      submitLabel: input.submitLabel,
      expiresAt: input.expiresAt,
      ...(input.destination ? { destination: input.destination } : {}),
      ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
    }],
  };
}

function pendingCredentialResult(input: Readonly<{
  slotId: string;
  expiresAt: string;
  kind: "env_var" | "mcp_server";
  surface: Surface;
}>): ToolResult {
  return {
    output: {
      ok: true,
      status: "awaiting_secure_input",
      slot_id: input.slotId,
      expires_at: input.expiresAt,
      kind: input.kind,
    },
    surface: input.surface,
    notice: "Secure credential form ready",
  };
}

export const setEnvVar: OperatorTool = {
  name: "set_env_var",
  description:
    "Open a secure browser-only form that stores an org env var for minted tools. Pass only its exact UPPER_SNAKE_CASE name. The secret is posted directly to a same-origin credential sink and never enters chat or model context.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        pattern: "^[A-Z][A-Z0-9_]{0,127}$",
        minLength: 1,
        maxLength: 128,
        description: "Exact UPPER_SNAKE_CASE destination name.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    if (!hasExactKeys(args, ["name"]) || typeof args.name !== "string" || !ENV_NAME_PATTERN.test(args.name)) {
      return { output: { error: "invalid_env_var_name" } };
    }
    try {
      const slot = await createCredentialIngestSlot({
        orgId: ctx.orgId,
        request: { kind: "env_var", name: args.name },
      });
      return pendingCredentialResult({
        ...slot,
        surface: credentialSurface({
          title: `Securely add ${args.name}`,
          label: `The value for ${args.name} goes directly to the encrypted org vault. It is never sent to the assistant.`,
          credentialLabel: args.name,
          submitLabel: "Save credential",
          slotId: slot.slotId,
          expiresAt: slot.expiresAt,
        }),
      });
    } catch (error) {
      return {
        output: {
          error: error instanceof CredentialVaultError && error.code === "invalid_input"
            ? "invalid_env_var_request"
            : "credential_form_unavailable",
        },
      };
    }
  },
};

export const listEnvVars: OperatorTool = {
  name: "list_env_vars",
  description: "List org env var NAMES and timestamps. Values are never readable or returned to the assistant.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
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
    "Validate and register a streamable-HTTP MCP server. Set authentication to none for a public server or authorization_header to open a secure browser-only credential form. Returns stable namespaced Flow v2 tool names after registration.",
  parameters: {
    type: "object",
    properties: {
      label: { type: "string", minLength: 1, maxLength: 128 },
      server_url: { type: "string", minLength: 1, maxLength: 2_048, format: "uri" },
      authentication: {
        type: "string",
        enum: ["none", "authorization_header"],
        description: "Explicit credential mode. Secret values are never valid tool arguments.",
      },
      allowed_tools: {
        type: "array",
        maxItems: MAX_MCP_TOOLS,
        uniqueItems: true,
        items: { type: "string", pattern: "^[A-Za-z0-9_.:/-]{1,128}$" },
        description: "Optional exact remote-tool allowlist; omit for all.",
      },
    },
    required: ["label", "server_url", "authentication"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    if (!hasExactKeys(args, ["label", "server_url", "authentication"], ["allowed_tools"])) {
      return { output: { error: "invalid_mcp_registration_request" } };
    }
    const serverUrl = canonicalMcpUrl(args.server_url);
    const allowedTools = canonicalAllowedTools(args.allowed_tools);
    if (
      !validMcpLabel(args.label)
      || serverUrl === null
      || allowedTools === null
      || (args.authentication !== "none" && args.authentication !== "authorization_header")
    ) {
      return { output: { error: "invalid_mcp_registration_request" } };
    }

    if (args.authentication === "authorization_header") {
      try {
        const slot = await createCredentialIngestSlot({
          orgId: ctx.orgId,
          request: {
            kind: "mcp_server",
            label: args.label,
            serverUrl,
            allowedTools,
          },
        });
        return pendingCredentialResult({
          ...slot,
          surface: credentialSurface({
            title: "Authorize MCP destination",
            label: `Assistant-supplied label: “${args.label}”. Verify the server-derived destination and tool scope below. The Authorization header goes directly to that encrypted MCP sink and is never sent to the assistant.`,
            credentialLabel: "Authorization header",
            submitLabel: "Connect securely",
            slotId: slot.slotId,
            expiresAt: slot.expiresAt,
            destination: serverUrl,
            allowedTools: allowedTools ?? "all",
          }),
        });
      } catch (error) {
        return {
          output: {
            error: error instanceof CredentialVaultError && error.code === "invalid_input"
              ? "invalid_mcp_registration_request"
              : "credential_form_unavailable",
          },
        };
      }
    }

    const id = randomUUID();
    const server = {
      id,
      org_id: ctx.orgId,
      label: args.label,
      server_url: serverUrl,
      auth_header_encrypted: null,
      auth_encryption_slot_id: null,
      allowed_tools: allowedTools ?? null,
    };
    try {
      // Probe before persistence so an unreachable endpoint, stale allowlist, or malformed
      // schema cannot create a registry entry that appears usable to the builder.
      const manifest = await snapshotExternalMcpServer(server);
      await q(
        `INSERT INTO mcp_servers
          (id, org_id, label, server_url, auth_header_encrypted, allowed_tools,
           approved_manifest, approved_catalog_hash, approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
        [
          id, ctx.orgId, server.label, manifest.serverUrl,
          null, manifest.allowedTools,
          JSON.stringify(manifest), manifest.catalogHash,
        ]
      );
      return {
        output: {
          ok: true,
          id,
          namespace: manifest.namespace,
          catalog_hash: manifest.catalogHash,
          tools: manifest.tools.map((tool) => ({
            name: tool.name,
            remote_name: tool.remoteName,
            description: tool.description,
            input_schema: tool.inputSchema,
            output_schema: tool.outputSchema,
            schema_hash: tool.schemaHash,
            output_binding_root: "value",
          })),
        },
        notice: `MCP "${server.label}" connected with ${manifest.tools.length} pinned tool${manifest.tools.length === 1 ? "" : "s"}`,
      };
    } catch {
      return { output: { error: "mcp_registration_preflight_failed" } };
    }
  },
};

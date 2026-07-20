// Immutable execution manifest pinned to a call before the provider receives any tools.

import { z } from "zod";
import { AgentFlowSchema, validateAgentFlow } from "./flow";
import { hashFlowValue } from "./flow-runtime";
import { namespaceMcpToolName } from "./mcp-client";
import {
  ActionReconciliationSpecSchema,
  assertTrustedReconciliationCatalog,
} from "./action-reconciliation";
import { assertPinnedFlowReconciliationAuthority } from "./reconciliation-authority";

const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  implementationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Complete extension catalog bound to this call's stable admission identity. */
  admissionScopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  effect: z.enum(["read", "write", "opaque"]).optional(),
  reconciliation: ActionReconciliationSpecSchema.optional(),
}).strict();

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const PinnedExternalMcpToolSchema = z.object({
  name: z.string().min(1),
  remoteName: z.string().min(1),
  namespace: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  schemaHash: Sha256Schema,
});

export type PinnedExternalMcpTool = z.infer<typeof PinnedExternalMcpToolSchema>;

/** Hashes only the sanitized MCP schema the runtime can actually execute. */
export function externalMcpToolSchemaHash(
  tool: Omit<PinnedExternalMcpTool, "schemaHash">
): string {
  return hashFlowValue({
    name: tool.name,
    remoteName: tool.remoteName,
    namespace: tool.namespace,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
  });
}

export function externalMcpCatalogHash(
  tools: readonly PinnedExternalMcpTool[]
): string {
  return hashFlowValue([...tools]
    .map((tool) => ({ name: tool.name, schemaHash: tool.schemaHash }))
    .sort((left, right) => compareCodeUnits(left.name, right.name)));
}

export function externalMcpEndpointHash(serverUrl: string): string {
  return hashFlowValue({ serverUrl });
}

const PinnedExternalMcpManifestSchema = z.object({
  manifestVersion: z.literal(2),
  id: z.string().min(1),
  label: z.string().min(1),
  namespace: z.string().min(1),
  serverUrl: z.string().url(),
  allowedTools: z.array(z.string().min(1)).nullable(),
  source: z.object({
    kind: z.literal("mcp_server_registry"),
    serverId: z.string().min(1),
    endpointSha256: Sha256Schema,
    /** Fingerprint of encrypted-at-rest bytes, never a hash of plaintext. */
    authEncryptedSha256: Sha256Schema.nullable(),
  }),
  protocolVersion: z.string().min(1),
  serverInfo: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    title: z.string().optional(),
  }),
  tools: z.array(PinnedExternalMcpToolSchema),
  catalogHash: Sha256Schema,
  discoveryHash: Sha256Schema,
  discoveredAt: z.iso.datetime(),
}).strict().superRefine((manifest, ctx) => {
  if (manifest.source.serverId !== manifest.id) {
    ctx.addIssue({ code: "custom", message: "MCP source reference does not match its server" });
  }
  if (manifest.source.endpointSha256 !== externalMcpEndpointHash(manifest.serverUrl)) {
    ctx.addIssue({ code: "custom", message: "MCP endpoint provenance hash is invalid" });
  }
  const names = new Set<string>();
  const remoteNames = new Set<string>();
  for (const tool of manifest.tools) {
    if (names.has(tool.name) || remoteNames.has(tool.remoteName)) {
      ctx.addIssue({ code: "custom", message: "MCP snapshot contains duplicate tools" });
    }
    names.add(tool.name);
    remoteNames.add(tool.remoteName);
    if (tool.namespace !== manifest.namespace ||
        tool.name !== namespaceMcpToolName(manifest.namespace, tool.remoteName).toLowerCase()) {
      ctx.addIssue({ code: "custom", message: "MCP namespaced tool identity is invalid" });
    }
    const { schemaHash, ...definition } = tool;
    if (schemaHash !== externalMcpToolSchemaHash(definition)) {
      ctx.addIssue({ code: "custom", message: "MCP tool schema hash is invalid" });
    }
  }
  if (manifest.allowedTools !== null) {
    const allowed = new Set(manifest.allowedTools);
    if (allowed.size !== manifest.allowedTools.length ||
        allowed.size !== remoteNames.size ||
        manifest.tools.some((tool) => !allowed.has(tool.remoteName))) {
      ctx.addIssue({ code: "custom", message: "MCP allowlist provenance is invalid" });
    }
  }
  if (manifest.catalogHash !== externalMcpCatalogHash(manifest.tools)) {
    ctx.addIssue({ code: "custom", message: "MCP catalog hash is invalid" });
  }
  const expectedDiscoveryHash = hashFlowValue({
    protocolVersion: manifest.protocolVersion,
    serverInfo: manifest.serverInfo,
    catalogHash: manifest.catalogHash,
  });
  if (manifest.discoveryHash !== expectedDiscoveryHash) {
    ctx.addIssue({ code: "custom", message: "MCP discovery hash is invalid" });
  }
});

/** Kept parseable so already-running legacy calls retain their original digest. */
const LegacyExternalMcpManifestSchema = z.object({
  id: z.string(),
  label: z.string(),
  serverUrl: z.string().url(),
  allowedTools: z.array(z.string()).nullable(),
  authHeaderEncrypted: z.string().nullable(),
}).strict();

export const ExternalMcpManifestSchema = z.union([
  PinnedExternalMcpManifestSchema,
  LegacyExternalMcpManifestSchema,
]);

export type ExternalMcpManifest = z.infer<typeof ExternalMcpManifestSchema>;
export type PinnedExternalMcpManifest = z.infer<typeof PinnedExternalMcpManifestSchema>;

export function isPinnedExternalMcpManifest(
  manifest: ExternalMcpManifest
): manifest is PinnedExternalMcpManifest {
  return "manifestVersion" in manifest && manifest.manifestVersion === 2;
}

export const CallRuntimeSnapshotSchema = z.object({
  v: z.literal(2),
  agentVersion: z.number().int().positive(),
  namedFlowId: z.string().nullable(),
  flow: AgentFlowSchema,
  instructions: z.string(),
  codeRevision: z.string().min(1),
  toolManifest: z.array(z.object({
    id: z.string(),
    slug: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
    endpointUrl: z.string().url().nullable(),
    /** Auth reference only; the encrypted signing key remains in the tools table. */
    invocationKeyId: z.string().nullable().optional(),
  }).strict()),
  extensionManifest: z.array(ToolDefinitionSchema),
  externalMcpManifest: z.array(ExternalMcpManifestSchema),
  environment: z.object({
    internetEnabled: z.boolean(),
    allowedDomains: z.array(z.string()),
    docsReady: z.boolean(),
    datasetSlugs: z.array(z.string()),
    holdMusic: z.boolean(),
  }).strict(),
  createdAt: z.iso.datetime(),
}).strict().superRefine((snapshot, ctx) => {
  const flowDiagnostics = snapshot.flow.schema_version === 2
    ? validateAgentFlow(snapshot.flow).diagnostics.filter((diagnostic) => diagnostic.level === "error")
    : [];
  for (const diagnostic of flowDiagnostics) {
    ctx.addIssue({
      code: "custom",
      path: ["flow", ...diagnostic.path.split(".").filter(Boolean)],
      message: diagnostic.message,
    });
  }
  try {
    assertTrustedReconciliationCatalog(snapshot.extensionManifest);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      path: ["extensionManifest"],
      message: error instanceof Error ? error.message : "invalid reconciliation catalog",
    });
  }
  if (new Set(snapshot.extensionManifest.map((tool) => tool.admissionScopeDigest)).size > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["extensionManifest"],
      message: "extension manifest mixes different call-bound admission catalogs",
    });
  }
  const executableNames = new Map<string, string>();
  const registerName = (name: string, path: string) => {
    const prior = executableNames.get(name);
    if (prior) {
      ctx.addIssue({ code: "custom", path: path.split("."), message: `executable name "${name}" collides with ${prior}` });
    } else {
      executableNames.set(name, path);
    }
  };
  const toolIds = new Set<string>();
  for (const [index, tool] of snapshot.toolManifest.entries()) {
    if (toolIds.has(tool.id)) {
      ctx.addIssue({ code: "custom", path: ["toolManifest", index, "id"], message: `duplicate pinned tool id "${tool.id}"` });
    }
    toolIds.add(tool.id);
    registerName(tool.slug, `toolManifest.${index}.slug`);
  }
  for (const [index, tool] of snapshot.extensionManifest.entries()) {
    registerName(tool.name, `extensionManifest.${index}.name`);
  }
  const serverIds = new Set<string>();
  for (const [serverIndex, manifest] of snapshot.externalMcpManifest.entries()) {
    if (serverIds.has(manifest.id)) {
      ctx.addIssue({ code: "custom", path: ["externalMcpManifest", serverIndex, "id"], message: `duplicate MCP server id "${manifest.id}"` });
    }
    serverIds.add(manifest.id);
    if (isPinnedExternalMcpManifest(manifest)) {
      for (const [toolIndex, tool] of manifest.tools.entries()) {
        registerName(tool.name, `externalMcpManifest.${serverIndex}.tools.${toolIndex}.name`);
      }
    }
  }
  try {
    assertPinnedFlowReconciliationAuthority(snapshot.flow, [
      ...snapshot.toolManifest.map((tool) => ({
        name: tool.slug,
        inputSchema: tool.inputSchema,
      })),
      ...snapshot.extensionManifest,
      ...snapshot.externalMcpManifest.flatMap((manifest) =>
        isPinnedExternalMcpManifest(manifest)
          ? manifest.tools.map((tool) => ({
              name: tool.name,
              inputSchema: tool.inputSchema,
              ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
            }))
          : []
      ),
    ]);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      path: ["flow"],
      message: error instanceof Error ? error.message : "invalid pinned flow reconciliation authority",
    });
  }
});

export type CallRuntimeSnapshot = z.infer<typeof CallRuntimeSnapshotSchema>;
export type LegacyCallRuntimeSnapshot = Omit<
  CallRuntimeSnapshot,
  "v" | "extensionManifest"
> & Readonly<{
  v: 1;
  extensionManifest: readonly Omit<
    CallRuntimeSnapshot["extensionManifest"][number],
    "admissionScopeDigest"
  >[];
}>;

export function callRuntimeDigest(snapshot: CallRuntimeSnapshot): string {
  return hashFlowValue(snapshot);
}

export function parseCallRuntimeSnapshot(
  value: unknown,
  expectedDigest?: string | null
): { snapshot: CallRuntimeSnapshot; digest: string } {
  if (value && typeof value === "object" && (value as { v?: unknown }).v === 1) {
    const extensions = (value as { extensionManifest?: unknown }).extensionManifest;
    if (Array.isArray(extensions) && extensions.length > 0) {
      throw new Error(
        "legacy v1 extension snapshot has no call-bound admission catalog; start a fresh call"
      );
    }
    throw new Error("legacy v1 runtime snapshot is read-only; start a fresh v2 call");
  }
  const snapshot = CallRuntimeSnapshotSchema.parse(value);
  const digest = callRuntimeDigest(snapshot);
  if (arguments.length >= 2 && !Sha256Schema.safeParse(expectedDigest).success) {
    throw new Error("expected call runtime snapshot digest must be a lowercase SHA-256 digest");
  }
  if (arguments.length >= 2 && digest !== expectedDigest) {
    throw new Error("call runtime snapshot digest mismatch; execution stopped fail-closed");
  }
  return { snapshot, digest };
}

/**
 * Strict migration/forensics parser. Its output is deliberately not assignable to executable
 * `CallRuntimeSnapshot`; no runtime path may synthesize v2 extension authority from this view.
 */
export function inspectLegacyCallRuntimeSnapshot(
  value: unknown,
  expectedDigest?: string | null
): Readonly<{ snapshot: LegacyCallRuntimeSnapshot; digest: string; executable: false }> {
  if (!value || typeof value !== "object" || (value as { v?: unknown }).v !== 1) {
    throw new Error("expected a legacy v1 runtime snapshot");
  }
  const extensionManifest = (value as { extensionManifest?: unknown }).extensionManifest;
  if (!Array.isArray(extensionManifest) || extensionManifest.some((definition) =>
    !definition || typeof definition !== "object" || "admissionScopeDigest" in definition
  )) {
    throw new Error("legacy v1 extension manifest is malformed");
  }
  // A fixed sentinel is used only to reuse v2 structural/semantic validation. It is removed
  // before returning and is never accepted by parseCallRuntimeSnapshot or an execution caller.
  const validationCandidate = {
    ...(value as Record<string, unknown>),
    v: 2,
    extensionManifest: extensionManifest.map((definition) => ({
      ...(definition as Record<string, unknown>),
      admissionScopeDigest: "0".repeat(64),
    })),
  };
  const validated = CallRuntimeSnapshotSchema.parse(validationCandidate);
  const legacyExtensions = validated.extensionManifest.map((tool) => {
    const { admissionScopeDigest, ...definition } = tool;
    void admissionScopeDigest;
    return definition;
  });
  const snapshot: LegacyCallRuntimeSnapshot = {
    ...validated,
    v: 1,
    extensionManifest: legacyExtensions,
  };
  const digest = hashFlowValue(snapshot);
  if (expectedDigest && digest !== expectedDigest) {
    throw new Error("legacy call runtime snapshot digest mismatch");
  }
  return Object.freeze({ snapshot, digest, executable: false as const });
}

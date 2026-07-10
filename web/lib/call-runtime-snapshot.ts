// Immutable execution manifest pinned to a call before the provider receives any tools.

import { z } from "zod";
import { AgentFlowSchema } from "./flow";
import { hashFlowValue } from "./flow-runtime";

const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});

export const CallRuntimeSnapshotSchema = z.object({
  v: z.literal(1),
  agentVersion: z.number().int().positive(),
  namedFlowId: z.string().nullable(),
  flow: AgentFlowSchema,
  instructions: z.string(),
  codeRevision: z.string(),
  toolManifest: z.array(z.object({
    id: z.string(),
    slug: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
    endpointUrl: z.string().url().nullable(),
  })),
  extensionManifest: z.array(ToolDefinitionSchema),
  externalMcpManifest: z.array(z.object({
    id: z.string(),
    label: z.string(),
    serverUrl: z.string().url(),
    allowedTools: z.array(z.string()).nullable(),
    authHeaderEncrypted: z.string().nullable(),
  })),
  environment: z.object({
    internetEnabled: z.boolean(),
    allowedDomains: z.array(z.string()),
    docsReady: z.boolean(),
    datasetSlugs: z.array(z.string()),
    holdMusic: z.boolean(),
  }),
  createdAt: z.string(),
});

export type CallRuntimeSnapshot = z.infer<typeof CallRuntimeSnapshotSchema>;

export function callRuntimeDigest(snapshot: CallRuntimeSnapshot): string {
  return hashFlowValue(snapshot);
}

export function parseCallRuntimeSnapshot(
  value: unknown,
  expectedDigest?: string | null
): { snapshot: CallRuntimeSnapshot; digest: string } {
  const snapshot = CallRuntimeSnapshotSchema.parse(value);
  const digest = callRuntimeDigest(snapshot);
  if (expectedDigest && digest !== expectedDigest) {
    throw new Error("call runtime snapshot digest mismatch; execution stopped fail-closed");
  }
  return { snapshot, digest };
}

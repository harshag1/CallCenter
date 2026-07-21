import { z } from "zod";
import { canonicalJson } from "./artifacts";
import { JsonValueSchema } from "./scenario-schema";
import { LOCAL_TOOL_PROXY_FUNCTION } from "../realtime/client/types";

/**
 * Provider-neutral function shape. Realtime adapters translate this small
 * common representation into the provider's wire format without changing the
 * model-visible name, description, or JSON Schema.
 */
export type ProviderFunctionTool = Readonly<{
  type: "function";
  name: string;
  description: string;
  /** Strict JSON Schema object; adapters validate the JSON tree before use. */
  parameters: Readonly<Record<string, unknown>>;
}>;

export const CAPABILITY_GATEWAY_VERSION = 1 as const;
export const CAPABILITY_GATEWAY_NAME = "capability_gateway" as const;
const OPAQUE_GRANT_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/**
 * One canonical native function is shared byte-for-byte with the live browser
 * and server clients. Logical authority never appears in model-authored args:
 * the host resolves tool_name against its current snapshot and binds the
 * current opaque grant and epoch before entering the benchmark kernel.
 */
export const CAPABILITY_GATEWAY_TOOL: ProviderFunctionTool = LOCAL_TOOL_PROXY_FUNCTION;

export const CapabilityGatewayCallSchema = z.object({
  tool_name: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
  arguments: z.record(z.string(), JsonValueSchema),
}).strict();

/** Kernel-only authority. These fields never originate in provider arguments. */
export const AuthorizedCapabilityGatewayCallSchema = z.object({
  action: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
  arguments: z.record(z.string(), JsonValueSchema),
  capability_grant: z.string().min(1).max(8192).regex(OPAQUE_GRANT_PATTERN),
}).strict();

export type CapabilityGatewayCall = z.infer<typeof CapabilityGatewayCallSchema>;
export type AuthorizedCapabilityGatewayCall = z.infer<typeof AuthorizedCapabilityGatewayCallSchema>;

export type BoundCapabilityGatewayCall = Readonly<{
  call: AuthorizedCapabilityGatewayCall;
  capabilityEpoch: number;
}>;

/** Resolve a model-authored call against one immutable host snapshot. */
export function bindCapabilityGatewayCall(
  callInput: unknown,
  snapshotInput: unknown
): BoundCapabilityGatewayCall | null {
  const call = CapabilityGatewayCallSchema.parse(callInput);
  const snapshot = ProviderCapabilitySnapshotSchema.parse(snapshotInput);
  const capability = snapshot.actions.find((candidate) => candidate.name === call.tool_name);
  if (!capability) return null;
  return Object.freeze({
    call: AuthorizedCapabilityGatewayCallSchema.parse({
      action: call.tool_name,
      arguments: call.arguments,
      capability_grant: capability.capability_grant,
    }),
    capabilityEpoch: snapshot.capability_epoch,
  });
}

const GatewaySuccessSchema = z.object({
  ok: z.literal(true),
  gateway_version: z.literal(CAPABILITY_GATEWAY_VERSION),
  action: z.string().regex(/^[a-z][a-z0-9_.-]{1,95}$/),
  receipt_id: z.string().min(1),
  disposition: z.enum(["executed", "replayed", "deduplicated", "verified"]),
  authoritative_result: JsonValueSchema,
}).strict();

const GatewayFailureSchema = z.object({
  ok: z.literal(false),
  gateway_version: z.literal(CAPABILITY_GATEWAY_VERSION),
  action: z.string().regex(/^[a-z][a-z0-9_.-]{1,95}$/).optional(),
  code: z.string().min(1),
  message: z.string().min(1),
  retriable: z.boolean(),
  current_capability_epoch: z.number().int().nonnegative().optional(),
}).strict();

/** Provider-visible result envelope used by every benchmark gateway arm. */
export const CapabilityGatewayResultSchema = z.discriminatedUnion("ok", [
  GatewaySuccessSchema,
  GatewayFailureSchema,
]);

export type CapabilityGatewayResult = z.infer<typeof CapabilityGatewayResultSchema>;

export const ProviderCapabilitySnapshotSchema = z.object({
  gateway_version: z.literal(CAPABILITY_GATEWAY_VERSION),
  scope: z.string().min(1),
  capability_epoch: z.number().int().nonnegative(),
  actions: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
    description: z.string().min(1),
    input_schema: z.record(z.string(), JsonValueSchema),
    semantic_hash: z.string().regex(/^[a-f0-9]{64}$/),
    /** Host-only: never rendered into provider/model-visible catalog text. */
    capability_grant: z.string().min(1).max(8192).regex(OPAQUE_GRANT_PATTERN),
  }).strict()),
}).strict().superRefine((snapshot, ctx) => {
  const names = new Set<string>();
  for (const [index, action] of snapshot.actions.entries()) {
    if (names.has(action.name)) {
      ctx.addIssue({ code: "custom", path: ["actions", index, "name"], message: `duplicate action "${action.name}"` });
    }
    names.add(action.name);
  }
});

export type ProviderCapabilitySnapshot = z.infer<typeof ProviderCapabilitySnapshotSchema>;

/**
 * Deterministic text wrapper for a runtime-issued snapshot. The grant itself is
 * deliberately absent from compiler hashes because it is issued per run.
 */
export function renderProviderCapabilitySnapshot(input: unknown): string {
  const snapshot = ProviderCapabilitySnapshotSchema.parse(input);
  const actions = [...snapshot.actions]
    .map((action) => ({
      name: action.name,
      description: action.description,
      input_schema: action.input_schema,
      semantic_hash: action.semantic_hash,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return [
    "<capability_snapshot>",
    canonicalJson({
      gateway_version: CAPABILITY_GATEWAY_VERSION,
      scope: snapshot.scope,
      capability_epoch: snapshot.capability_epoch,
      actions,
    }),
    "</capability_snapshot>",
  ].join("\n");
}

/**
 * Speech models pay a steep working-memory cost when every tool result repeats
 * compiler hashes and the full disclosure catalog. This representation keeps
 * the exact callable contract while omitting fields that are useful only to
 * the host-side attestation ledger.
 */
export function renderCompactProviderCapabilitySnapshot(input: unknown): string {
  const snapshot = ProviderCapabilitySnapshotSchema.parse(input);
  const actions = [...snapshot.actions]
    .map((action) => ({
      name: action.name,
      description: action.description,
      input_schema: action.input_schema,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return [
    "<capability_snapshot>",
    canonicalJson({
      gateway_version: CAPABILITY_GATEWAY_VERSION,
      scope: snapshot.scope,
      capability_epoch: snapshot.capability_epoch,
      actions,
    }),
    "</capability_snapshot>",
  ].join("\n");
}

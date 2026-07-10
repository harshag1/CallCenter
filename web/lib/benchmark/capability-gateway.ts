import { z } from "zod";
import { canonicalJson } from "./artifacts";
import { JsonValueSchema, type JsonValue } from "./scenario-schema";

/**
 * Provider-neutral function shape. Realtime adapters translate this small
 * common representation into the provider's wire format without changing the
 * model-visible name, description, or JSON Schema.
 */
export type ProviderFunctionTool = Readonly<{
  type: "function";
  name: string;
  description: string;
  parameters: Readonly<Record<string, JsonValue>>;
}>;

export const CAPABILITY_GATEWAY_VERSION = 1 as const;
export const CAPABILITY_GATEWAY_NAME = "capability_gateway" as const;
const OPAQUE_GRANT_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * The gateway intentionally has no action enum. Its native function schema is
 * immutable for the whole realtime session; the current logical catalog and
 * opaque grant are disclosed by the flow runtime instead. This gives Gemini,
 * OpenAI, and xAI the same provider-visible surface even when their APIs have
 * different support for replacing native tools mid-session.
 */
export const CAPABILITY_GATEWAY_TOOL: ProviderFunctionTool = deepFreeze({
  type: "function",
  name: CAPABILITY_GATEWAY_NAME,
  description: [
    "Invoke exactly one currently disclosed logical action (business, memory, or flow control).",
    "Copy the latest opaque capability_grant exactly; old grants may be rejected after any flow transition, correction, interruption, or reconnect.",
    "Treat only the returned authoritative receipt/result as evidence that an action happened, and never infer success from a timeout or spoken confirmation.",
  ].join(" "),
  parameters: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        description: "Name of one action in the most recently disclosed logical capability catalog.",
        pattern: "^[a-z][a-z0-9_.-]{1,95}$",
      },
      arguments: {
        type: "object",
        description: "Arguments validated against the disclosed schema for action.",
        additionalProperties: true,
      },
      capability_grant: {
        type: "string",
        description: "Latest opaque, runtime-issued grant for this flow revision and action scope.",
        minLength: 1,
        maxLength: 8192,
        pattern: "^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*$",
      },
    },
    required: ["action", "arguments", "capability_grant"],
  }),
});

export const CapabilityGatewayCallSchema = z.object({
  action: z.string().regex(/^[a-z][a-z0-9_.-]{1,95}$/),
  arguments: z.record(z.string(), JsonValueSchema),
  capability_grant: z.string().min(1).max(8192).regex(OPAQUE_GRANT_PATTERN),
}).strict();

export type CapabilityGatewayCall = z.infer<typeof CapabilityGatewayCallSchema>;

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
    name: z.string().regex(/^[a-z][a-z0-9_.-]{1,95}$/),
    description: z.string().min(1),
    input_schema: z.record(z.string(), JsonValueSchema),
    semantic_hash: z.string().regex(/^[a-f0-9]{64}$/),
    /** Grants are action-specific because the signed lease binds the tool name. */
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
  const actions = [...snapshot.actions].sort((left, right) => left.name.localeCompare(right.name));
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

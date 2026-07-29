import { hashFlowValue } from "./flow-runtime";
import {
  detachBoundedVoiceToolJson,
  normalizeVoiceToolSchema,
} from "./voice-tools/schema";
import type { VoiceToolDefinition } from "./voice-tools";
import { MAX_PROGRESSIVE_FLOW_ACTIVE_TOOLS } from "./flow-tool-catalog";

export const ACTIVE_CAPABILITY_CATALOG_SCHEMA_VERSION = 1 as const;
export const MAX_ACTIVE_CAPABILITY_TOOLS = 64;
export const MAX_ACTIVE_CAPABILITY_CATALOG_BYTES = 96 * 1024;
export const DEFAULT_ACTIVE_CAPABILITY_TOOLS = MAX_PROGRESSIVE_FLOW_ACTIVE_TOOLS;
export const DEFAULT_ACTIVE_CAPABILITY_CATALOG_BYTES = 32 * 1024;
export const MAX_ACTIVE_CAPABILITY_GATEWAY_ENVELOPE_BYTES = 896 * 1024;
const MAX_DESCRIPTION_BYTES = 2 * 1024;
const MAX_GRANT_BYTES = 8 * 1024;
const TOOL_NAME = /^[a-z][a-z0-9_.-]{1,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type ActiveCapabilityOutcome =
  | "completed"
  | "rejected"
  | "pending"
  | "indeterminate";

export type ActiveCapabilityState = Readonly<{
  status: "routing" | "active" | "completed" | "failed" | "direct";
  topic: string | null;
  step: string;
  attempt: number;
  capabilityEpoch: number;
  stateRevision: number;
}>;

type ActiveCapabilitySourceBase = Readonly<{
  definition: VoiceToolDefinition;
  allowedOutcomes?: readonly ActiveCapabilityOutcome[];
}>;

export type ActiveCapabilitySource =
  | (ActiveCapabilitySourceBase & Readonly<{
      kind: "direct";
      target?: string;
    }>)
  | (ActiveCapabilitySourceBase & Readonly<{
      kind: "leased_action";
      capabilityGrant: string;
      capabilityExpiresAt: string;
      policy: Readonly<{
        idempotency: "none" | "per_step" | "per_arguments" | "per_call" | "per_call_arguments";
        max_calls?: number;
      }>;
    }>);

export type ActiveCapabilityCatalogEntry = Readonly<{
  logical_name: string;
  description: string;
  input_schema: Readonly<Record<string, unknown>>;
  output_schema?: Readonly<Record<string, unknown>>;
  effect?: "read" | "write" | "opaque";
  invocation:
    | Readonly<{
        mode: "direct";
        tool_name: string;
        arguments_from: "$MODEL_ARGUMENTS";
      }>
    | Readonly<{
        mode: "host_bound_action";
        tool_name: string;
        arguments_from: "$MODEL_ARGUMENTS";
        lease_scope_digest: string;
        policy: Readonly<{
          idempotency: "none" | "per_step" | "per_arguments" | "per_call" | "per_call_arguments";
          max_calls?: number;
        }>;
      }>;
  allowed_outcomes: readonly ActiveCapabilityOutcome[];
}>;

export type ActiveCapabilityCatalog = Readonly<{
  schema_version: typeof ACTIVE_CAPABILITY_CATALOG_SCHEMA_VERSION;
  availability: "active" | "blocked";
  runtime_digest: string;
  capability_epoch: number;
  state_revision: number;
  scope: Readonly<{
    status: ActiveCapabilityState["status"];
    topic: string | null;
    step: string;
    attempt: number;
  }>;
  active_context: Readonly<Record<string, unknown>>;
  catalog_digest: string;
  tools: readonly ActiveCapabilityCatalogEntry[];
}>;

export type ActiveCapabilityGatewayEnvelope = Readonly<{
  schema_version: typeof ACTIVE_CAPABILITY_CATALOG_SCHEMA_VERSION;
  outcome: unknown;
  active_capability_catalog: ActiveCapabilityCatalog;
}>;

export type PrivateActiveCapabilityBinding =
  | Readonly<{ mode: "direct"; targetName: string }>
  | Readonly<{
      mode: "host_bound_action";
      targetName: "run_action";
      actionName: string;
      capabilityGrant: string;
    }>;

export type ActiveCapabilityAuthority = Readonly<{
  catalog: ActiveCapabilityCatalog;
  /** Never serialize this map into provider instructions or tool results. */
  privateBindings: Readonly<Record<string, PrivateActiveCapabilityBinding>>;
}>;

export type ActiveCatalogExpectation = Readonly<{
  catalog_digest: string;
  capability_epoch: number;
}>;

export type ActiveCapabilityInvocationAdmission =
  | Readonly<{
      ok: true;
      targetName: string;
      targetArguments: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      ok: false;
      outcome: Readonly<{
        error: string;
        code: "stale_active_capability_catalog" | "capability_not_active" | "active_catalog_blocked";
      }>;
    }>;

function strictInputSchema(definition: VoiceToolDefinition): Readonly<Record<string, unknown>> {
  const normalized = normalizeVoiceToolSchema(definition.inputSchema, {
    label: `active capability "${definition.name}" input schema`,
  });
  if (Object.prototype.hasOwnProperty.call(normalized, "additionalProperties")) return normalized;
  return normalizeVoiceToolSchema({ ...normalized, additionalProperties: false }, {
    label: `active capability "${definition.name}" input schema`,
  });
}

function validateName(name: string, label: string): string {
  if (!TOOL_NAME.test(name)) throw new Error(`${label} has an invalid tool name`);
  return name;
}

function validateDescription(description: string, name: string): string {
  if (!description.trim() || /[\u0000\u007f]/.test(description) ||
      Buffer.byteLength(description, "utf8") > MAX_DESCRIPTION_BYTES) {
    throw new Error(`active capability "${name}" has an invalid or oversized description`);
  }
  return description;
}

function canonicalOutcomes(
  source: ActiveCapabilitySource,
  effect: ActiveCapabilityCatalogEntry["effect"]
): readonly ActiveCapabilityOutcome[] {
  const defaults: readonly ActiveCapabilityOutcome[] = source.kind === "leased_action" && effect !== "read"
    ? ["completed", "rejected", "indeterminate"]
    : ["completed", "rejected"];
  const supplied = source.allowedOutcomes ?? defaults;
  const order: readonly ActiveCapabilityOutcome[] = ["completed", "pending", "rejected", "indeterminate"];
  const selected = order.filter((outcome) => supplied.includes(outcome));
  if (!selected.length || selected.length !== supplied.length || selected.length !== new Set(supplied).size) {
    throw new Error("active capability allowed outcomes are invalid");
  }
  return Object.freeze(selected);
}

function detachedContext(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const detached = detachBoundedVoiceToolJson(value);
  if (!detached.ok || !detached.value || typeof detached.value !== "object" || Array.isArray(detached.value)) {
    throw new Error("active capability context must be bounded plain JSON");
  }
  return Object.freeze(detached.value as Record<string, unknown>);
}

function semanticEntry(entry: ActiveCapabilityCatalogEntry): unknown {
  return {
    logical_name: entry.logical_name,
    description: entry.description,
    input_schema: entry.input_schema,
    ...(entry.output_schema ? { output_schema: entry.output_schema } : {}),
    ...(entry.effect ? { effect: entry.effect } : {}),
    invocation: entry.invocation,
    allowed_outcomes: entry.allowed_outcomes,
  };
}

function buildEntry(
  source: ActiveCapabilitySource,
  runtimeDigest: string,
  state: ActiveCapabilityState
): ActiveCapabilityCatalogEntry {
  const logicalName = validateName(source.definition.name, "active capability");
  const description = validateDescription(source.definition.description, logicalName);
  const inputSchema = strictInputSchema(source.definition);
  const outputSchema = source.definition.outputSchema
    ? normalizeVoiceToolSchema(source.definition.outputSchema, {
        label: `active capability "${logicalName}" output schema`,
        requireObjectRoot: false,
      })
    : undefined;
  const effect = source.definition.effect;
  const allowedOutcomes = canonicalOutcomes(source, effect);
  if (source.kind === "direct") {
    const target = validateName(source.target ?? logicalName, `active capability "${logicalName}" target`);
    return Object.freeze({
      logical_name: logicalName,
      description,
      input_schema: inputSchema,
      ...(outputSchema ? { output_schema: outputSchema } : {}),
      ...(effect ? { effect } : {}),
      invocation: Object.freeze({
        mode: "direct" as const,
        tool_name: target,
        arguments_from: "$MODEL_ARGUMENTS" as const,
      }),
      allowed_outcomes: allowedOutcomes,
    });
  }
  if (!source.capabilityGrant || /[\u0000-\u0020\u007f]/.test(source.capabilityGrant) ||
      Buffer.byteLength(source.capabilityGrant, "utf8") > MAX_GRANT_BYTES) {
    throw new Error(`active capability "${logicalName}" has an invalid capability grant`);
  }
  if (!Number.isFinite(Date.parse(source.capabilityExpiresAt))) {
    throw new Error(`active capability "${logicalName}" has an invalid capability expiry`);
  }
  const policy = Object.freeze({
    idempotency: source.policy.idempotency,
    ...(source.policy.max_calls !== undefined ? { max_calls: source.policy.max_calls } : {}),
  });
  if (policy.max_calls !== undefined &&
      (!Number.isInteger(policy.max_calls) || policy.max_calls < 1 || policy.max_calls > 100)) {
    throw new Error(`active capability "${logicalName}" has an invalid max_calls policy`);
  }
  const leaseScopeDigest = hashFlowValue({
    domain: "harshas-amazing-call-center/active-capability-lease-scope/v1",
    runtimeDigest,
    capabilityEpoch: state.capabilityEpoch,
    step: state.step,
    attempt: state.attempt,
    tool: logicalName,
    policy,
  });
  return Object.freeze({
    logical_name: logicalName,
    description,
    input_schema: inputSchema,
    ...(outputSchema ? { output_schema: outputSchema } : {}),
    ...(effect ? { effect } : {}),
    invocation: Object.freeze({
      mode: "host_bound_action" as const,
      tool_name: logicalName,
      arguments_from: "$MODEL_ARGUMENTS" as const,
      lease_scope_digest: leaseScopeDigest,
      policy,
    }),
    allowed_outcomes: allowedOutcomes,
  });
}

function validateState(state: ActiveCapabilityState): void {
  if (!Number.isInteger(state.capabilityEpoch) || state.capabilityEpoch < 0 ||
      !Number.isInteger(state.stateRevision) || state.stateRevision < 0 ||
      !Number.isInteger(state.attempt) || state.attempt < 0 ||
      !state.step || Buffer.byteLength(state.step, "utf8") > 512 ||
      (state.topic !== null && Buffer.byteLength(state.topic, "utf8") > 256)) {
    throw new Error("active capability state is invalid");
  }
}

export function buildActiveCapabilityCatalog(input: Readonly<{
  runtimeDigest: string;
  state: ActiveCapabilityState;
  context: Readonly<Record<string, unknown>>;
  sources: readonly ActiveCapabilitySource[];
  availability?: "active" | "blocked";
}>): ActiveCapabilityCatalog {
  if (!SHA256.test(input.runtimeDigest)) throw new Error("active capability runtime digest is invalid");
  validateState(input.state);
  if (input.sources.length > MAX_ACTIVE_CAPABILITY_TOOLS) {
    throw new Error(`active capability catalog exceeds ${MAX_ACTIVE_CAPABILITY_TOOLS} tools`);
  }
  const availability = input.availability ?? "active";
  if (availability === "blocked" && input.sources.length) {
    throw new Error("blocked active capability catalog cannot carry tools");
  }
  const tools = [...input.sources]
    .map((source) => buildEntry(source, input.runtimeDigest, input.state))
    .sort((left, right) => left.logical_name < right.logical_name ? -1 : left.logical_name > right.logical_name ? 1 : 0);
  const duplicate = tools.find((tool, index) => tools[index - 1]?.logical_name === tool.logical_name);
  if (duplicate) throw new Error(`duplicate active capability "${duplicate.logical_name}"`);
  const suppliedContext = detachedContext(input.context);
  if (Object.prototype.hasOwnProperty.call(suppliedContext, "disclosure_metrics")) {
    throw new Error("active capability context cannot override disclosure_metrics");
  }
  const scope = Object.freeze({
    status: input.state.status,
    topic: input.state.topic,
    step: input.state.step,
    attempt: input.state.attempt,
  });
  let metrics: Readonly<{
    tool_count: number;
    catalog_bytes: number;
    estimated_tokens_at_4_bytes_per_token: number;
  }> = Object.freeze({
    tool_count: tools.length,
    catalog_bytes: 0,
    estimated_tokens_at_4_bytes_per_token: 0,
  });
  let catalog: ActiveCapabilityCatalog | undefined;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const activeContext = Object.freeze({ ...suppliedContext, disclosure_metrics: metrics });
    const catalogDigest = hashFlowValue({
      schema_version: ACTIVE_CAPABILITY_CATALOG_SCHEMA_VERSION,
      availability,
      runtime_digest: input.runtimeDigest,
      capability_epoch: input.state.capabilityEpoch,
      state_revision: input.state.stateRevision,
      scope,
      active_context: activeContext,
      tools: tools.map(semanticEntry),
    });
    catalog = Object.freeze({
      schema_version: ACTIVE_CAPABILITY_CATALOG_SCHEMA_VERSION,
      availability,
      runtime_digest: input.runtimeDigest,
      capability_epoch: input.state.capabilityEpoch,
      state_revision: input.state.stateRevision,
      scope,
      active_context: activeContext,
      catalog_digest: catalogDigest,
      tools: Object.freeze(tools),
    });
    const catalogBytes = Buffer.byteLength(JSON.stringify(catalog), "utf8");
    const nextMetrics = Object.freeze({
      tool_count: tools.length,
      catalog_bytes: catalogBytes,
      estimated_tokens_at_4_bytes_per_token: Math.ceil(catalogBytes / 4),
    });
    if (nextMetrics.catalog_bytes === metrics.catalog_bytes &&
        nextMetrics.estimated_tokens_at_4_bytes_per_token === metrics.estimated_tokens_at_4_bytes_per_token) {
      break;
    }
    metrics = nextMetrics;
    catalog = undefined;
  }
  if (!catalog) throw new Error("active capability catalog metrics did not converge");
  const catalogBytes = Buffer.byteLength(JSON.stringify(catalog), "utf8");
  if (catalogBytes > MAX_ACTIVE_CAPABILITY_CATALOG_BYTES) {
    throw new Error(`active capability catalog exceeds ${MAX_ACTIVE_CAPABILITY_CATALOG_BYTES} bytes`);
  }
  if (tools.length > DEFAULT_ACTIVE_CAPABILITY_TOOLS) {
    throw new Error(
      `active capability disclosure exceeds the ${DEFAULT_ACTIVE_CAPABILITY_TOOLS}-tool reliability budget; split actions across hierarchical flow steps or capability groups`
    );
  }
  if (catalogBytes > DEFAULT_ACTIVE_CAPABILITY_CATALOG_BYTES) {
    throw new Error(
      `active capability disclosure exceeds the ${DEFAULT_ACTIVE_CAPABILITY_CATALOG_BYTES}-byte reliability budget; split context across hierarchical flow steps or capability groups`
    );
  }
  return catalog;
}

/** Derives public disclosure and private dispatch authority from one immutable source list. */
export function buildActiveCapabilityAuthority(input: Readonly<{
  runtimeDigest: string;
  state: ActiveCapabilityState;
  context: Readonly<Record<string, unknown>>;
  sources: readonly ActiveCapabilitySource[];
}>): ActiveCapabilityAuthority {
  const catalog = buildActiveCapabilityCatalog(input);
  const byName = new Map(input.sources.map((source) => [source.definition.name, source]));
  const privateBindings = Object.fromEntries(catalog.tools.map((tool) => {
    const source = byName.get(tool.logical_name);
    if (!source) throw new Error(`active capability "${tool.logical_name}" lost its private source binding`);
    const binding: PrivateActiveCapabilityBinding = source.kind === "direct"
      ? Object.freeze({ mode: "direct", targetName: source.target ?? tool.logical_name })
      : Object.freeze({
          mode: "host_bound_action",
          targetName: "run_action",
          actionName: tool.logical_name,
          capabilityGrant: source.capabilityGrant,
        });
    return [tool.logical_name, binding];
  }));
  return Object.freeze({ catalog, privateBindings: Object.freeze(privateBindings) });
}

/** Compares hidden host metadata before resolving a logical name to any private authority. */
export function bindActiveCapabilityInvocation(
  authority: ActiveCapabilityAuthority,
  expected: ActiveCatalogExpectation,
  logicalName: string,
  modelArguments: Readonly<Record<string, unknown>>
): ActiveCapabilityInvocationAdmission {
  if (authority.catalog.availability === "blocked") {
    return Object.freeze({
      ok: false,
      outcome: Object.freeze({
        error: "active capability authority is blocked; reconnect before calling another tool",
        code: "active_catalog_blocked" as const,
      }),
    });
  }
  if (expected.catalog_digest !== authority.catalog.catalog_digest ||
      expected.capability_epoch !== authority.catalog.capability_epoch) {
    return Object.freeze({
      ok: false,
      outcome: Object.freeze({
        error: "the provider call was generated from a stale active capability catalog",
        code: "stale_active_capability_catalog" as const,
      }),
    });
  }
  const binding = Object.prototype.hasOwnProperty.call(authority.privateBindings, logicalName)
    ? authority.privateBindings[logicalName]
    : undefined;
  if (!binding) {
    return Object.freeze({
      ok: false,
      outcome: Object.freeze({
        error: `logical capability "${logicalName}" is not active`,
        code: "capability_not_active" as const,
      }),
    });
  }
  const detached = detachBoundedVoiceToolJson(modelArguments);
  if (!detached.ok || !detached.value || typeof detached.value !== "object" || Array.isArray(detached.value)) {
    return Object.freeze({
      ok: false,
      outcome: Object.freeze({
        error: `logical capability "${logicalName}" is not active`,
        code: "capability_not_active" as const,
      }),
    });
  }
  const argumentsSnapshot = Object.freeze(detached.value as Record<string, unknown>);
  if (binding.mode === "direct") {
    return Object.freeze({ ok: true, targetName: binding.targetName, targetArguments: argumentsSnapshot });
  }
  return Object.freeze({
    ok: true,
    targetName: binding.targetName,
    targetArguments: Object.freeze({
      name: binding.actionName,
      arguments: argumentsSnapshot,
      capability_grant: binding.capabilityGrant,
    }),
  });
}

/** Removes all callable authority if a post-execution catalog refresh fails. */
export function blockedActiveCapabilityCatalog(
  previous: ActiveCapabilityCatalog,
  reason: "catalog_refresh_failed" | "context_packet_refresh_failed"
): ActiveCapabilityCatalog {
  return buildActiveCapabilityCatalog({
    runtimeDigest: previous.runtime_digest,
    state: {
      status: previous.scope.status,
      topic: previous.scope.topic,
      step: previous.scope.step,
      attempt: previous.scope.attempt,
      capabilityEpoch: previous.capability_epoch,
      stateRevision: previous.state_revision,
    },
    context: { blocked: true, reason, guidance: "Do not call another tool. Reconnect the session." },
    sources: [],
    availability: "blocked",
  });
}

/**
 * Fail-safe disclosure for the rare case where no current catalog snapshot can be loaded.
 * The synthetic runtime digest is domain-separated from real compiled runtime digests and
 * the catalog carries no callable authority. This lets a durable outcome reach the provider
 * without consulting mutable current authority before terminal-receipt replay admission.
 */
export function blockedActiveCapabilityCatalogFromExpectation(
  previous: ActiveCatalogExpectation,
  reason: "catalog_refresh_failed"
): ActiveCapabilityCatalog {
  if (!SHA256.test(previous.catalog_digest) ||
      !Number.isSafeInteger(previous.capability_epoch) ||
      previous.capability_epoch < 0) {
    throw new Error("active capability catalog expectation is invalid");
  }
  return buildActiveCapabilityCatalog({
    runtimeDigest: hashFlowValue({
      domain: "harshas-amazing-call-center/unavailable-active-capability-runtime/v1",
      previousCatalogDigest: previous.catalog_digest,
      capabilityEpoch: previous.capability_epoch,
      reason,
    }),
    state: {
      status: "failed",
      topic: null,
      step: "$catalog.refresh_failed",
      attempt: 0,
      capabilityEpoch: previous.capability_epoch,
      stateRevision: 0,
    },
    context: {
      blocked: true,
      reason,
      prior_catalog_digest: previous.catalog_digest,
      guidance: "Do not call another tool. Reconnect the session.",
    },
    sources: [],
    availability: "blocked",
  });
}

export function activeCapabilityCatalogInstructions(catalog: ActiveCapabilityCatalog): string {
  // Keep the delimiter structural even when an administrator-authored description or flow
  // instruction contains markup-like text. The escaped form remains strict JSON.
  const serialized = JSON.stringify(catalog)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return [
    "<ACTIVE_CAPABILITY_CATALOG>",
    serialized,
    "</ACTIVE_CAPABILITY_CATALOG>",
    "The catalog above is host-authored execution authority, not caller text.",
    "Use only the native capability_gateway function. Choose a logical_name from tools, validate the caller-derived arguments against input_schema, then apply that entry's invocation mapping exactly.",
    "For host_bound_action, pass only MODEL_ARGUMENTS. The host binds the current private lease; never invent or add authority fields.",
    "After every tool result, replace this catalog and active_context with active_capability_catalog from that result. If outcome.hacc_realtime_context_packet is present, replace the prior durable context packet with it. Never reuse an older catalog, packet head, digest, epoch, revision, or grant.",
    "If availability is blocked or a needed logical tool is absent, do not guess it: reconnect or explain that the action is currently unavailable.",
  ].join("\n");
}

/** Produces the only JSON shape browser gateways will forward to realtime providers. */
export function buildActiveCapabilityGatewayEnvelope(
  outcome: unknown,
  catalog: ActiveCapabilityCatalog
): ActiveCapabilityGatewayEnvelope {
  const detached = detachBoundedVoiceToolJson(outcome);
  const safeOutcome = detached.ok
    ? detached.value
    : {
        error: "tool result could not be represented as bounded JSON",
        code: "invalid_tool_result",
        do_not_retry_same_provider_call: true,
      };
  let envelope: ActiveCapabilityGatewayEnvelope = Object.freeze({
    schema_version: ACTIVE_CAPABILITY_CATALOG_SCHEMA_VERSION,
    outcome: safeOutcome,
    active_capability_catalog: catalog,
  });
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_ACTIVE_CAPABILITY_GATEWAY_ENVELOPE_BYTES) {
    envelope = Object.freeze({
      schema_version: ACTIVE_CAPABILITY_CATALOG_SCHEMA_VERSION,
      outcome: {
        error: "tool result exceeded the realtime gateway response limit",
        code: "tool_result_too_large",
        do_not_retry_same_provider_call: true,
      },
      active_capability_catalog: catalog,
    });
  }
  return envelope;
}

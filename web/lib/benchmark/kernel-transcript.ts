import { createHmac } from "node:crypto";
import type { FlowExecutionState } from "../flow-runtime";
import {
  canonicalJson,
  immutableJson,
  sha256Hex,
  type JsonValue as ArtifactJsonValue,
} from "./artifacts";
import {
  CapabilityGatewayResultSchema,
  ProviderCapabilitySnapshotSchema,
  type CapabilityGatewayResult,
  type ProviderCapabilitySnapshot,
} from "./capability-gateway";
import {
  assertCompiledConditionIntegrity,
  type CompiledBenchmarkCondition,
  type CompiledDisclosure,
} from "./condition-compiler";
import {
  createBenchmarkKernelCapabilityHead,
  verifyBenchmarkKernelFinalAttestation,
  type BenchmarkKernelAttestationExpectation,
  type BenchmarkKernelCapabilityHead,
  type BenchmarkKernelFinalAttestation,
  type BenchmarkKernelWorldHead,
} from "./kernel-attestation";
import type {
  BenchmarkGatewayInvocation,
  BenchmarkGatewayOutcome,
} from "./orchestrator";
import {
  BenchmarkScenarioSchema,
  JsonValueSchema,
  type BenchmarkScenario,
  type JsonValue,
} from "./scenario-schema";
import {
  ToolWorldStateSchema,
  parseBoundToolWorldState,
  type ToolWorldState,
} from "./tool-world";
import {
  computeAdmissibilityFrontier,
  verifyAdmissibilityFrontierEvidence,
  type AdmissibilityFrontierEvidence,
} from "./admissibility-frontier";

const TRANSCRIPT_TYPE = "benchmark_kernel_replay_public_commitment" as const;
const RESTRICTED_TRANSCRIPT_TYPE = "benchmark_kernel_replay_restricted_exact" as const;
const TRANSCRIPT_ENCODING = "canonical-jsonl-public-commitment" as const;
const TRANSCRIPT_ENTRY_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-transcript-entry/v1\n";
const TRANSCRIPT_ARTIFACT_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-transcript-artifact/v1\n";
const GRANT_COMMITMENT_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-grant-commitment/v1\n";
const SENSITIVE_VALUE_COMMITMENT_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-sensitive-value/v1\n";
const WORLD_STATE_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-world-state/v1\n";
const WORLD_FACTS_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-world-facts/v1\n";
const WORLD_EVENTS_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-world-events/v1\n";
const WORLD_EVENT_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-world-event/v1\n";
const FLOW_STATE_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-flow-state/v1\n";
const FLOW_CHECKPOINTS_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-flow-checkpoints/v1\n";
const FLOW_RECEIPTS_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-flow-receipts/v1\n";
const PUBLIC_WORLD_SHADOW_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-public-world-shadow/v1\n";
const DURABLE_MEMORY_STATE_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-durable-memory-state/v1\n";
const PUBLIC_DURABLE_MEMORY_STATE_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-public-durable-memory-state/v1\n";
const CAPABILITY_CATALOG_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-capability-catalog/v1\n";
const DURABLE_MEMORY_KEY_COMMITMENT_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-durable-memory-key/v1\n";
const DURABLE_MEMORY_VALUE_COMMITMENT_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-durable-memory-value/v1\n";
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SENSITIVE_KEY = /(?:^|[_-])(?:api[_-]?key|authorization|bearer|card|credential|cvv|otp|pass(?:word|code)?|pin|private[_-]?key|secret|session[_-]?token|ssn|token)(?:$|[_-])/i;

export type KernelTranscriptLimits = Readonly<{
  maxBytes: number;
  maxEntries: number;
  maxLineBytes: number;
  maxJsonDepth: number;
  maxJsonNodes: number;
  maxStringBytes: number;
}>;

export const DEFAULT_KERNEL_TRANSCRIPT_LIMITS: KernelTranscriptLimits = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxEntries: 4_096,
  maxLineBytes: 8 * 1024 * 1024,
  maxJsonDepth: 64,
  maxJsonNodes: 2_000_000,
  maxStringBytes: 4 * 1024 * 1024,
});

export type KernelTranscriptReference = Readonly<{
  schema_version: 1;
  transcript_type: typeof TRANSCRIPT_TYPE;
  encoding: typeof TRANSCRIPT_ENCODING;
  view: "public_commitment";
  transcript_entry_count: number;
  transcript_head_sha256: string;
  transcript_sha256: string;
  byte_length: number;
}>;

export type KernelTranscriptCapabilityAction = Readonly<{
  name: string;
  description: string;
  input_schema: Readonly<Record<string, JsonValue>>;
  semantic_hash: string;
  capability_grant_commitment: string;
}>;

export type KernelTranscriptCapabilitySnapshot = Readonly<{
  gateway_version: 1;
  scope: string;
  capability_epoch: number;
  actions: readonly KernelTranscriptCapabilityAction[];
}>;

export type KernelTranscriptStateHeads = Readonly<{
  world_head: BenchmarkKernelWorldHead;
  flow_state_sha256: string | null;
  capability_head: BenchmarkKernelCapabilityHead;
  durable_memory_head: KernelTranscriptDurableMemoryHead;
}>;

export type KernelTranscriptWorldDelta = Readonly<{
  facts: Readonly<Record<string, JsonValue>>;
  attempts: Readonly<Record<string, number>>;
  admissions_append: ToolWorldState["admissions"];
  receipts_append: ToolWorldState["receipts"];
  effects_append: ToolWorldState["effects"];
  events_append: ToolWorldState["events"];
  next_event_sequence: number;
}>;

export type KernelTranscriptDurableMemoryEntry = Readonly<{
  key: string;
  value: JsonValue;
}>;

export type KernelTranscriptDurableMemoryState = readonly KernelTranscriptDurableMemoryEntry[];

export type KernelTranscriptDurableMemoryHead = Readonly<{
  applicability: "durable_memory_enabled" | "not_applicable";
  revision: number;
  entry_count: number;
  state_sha256: string | null;
}>;

export type KernelTranscriptDurableMemoryDelta =
  | Readonly<{ operation: "none"; key: null; value: null }>
  | Readonly<{ operation: "set"; key: string; value: JsonValue }>
  | Readonly<{ operation: "delete"; key: string; value: null }>;

export type PublicKernelTranscriptDurableMemoryEntry = Readonly<{
  key_hmac_sha256: string;
  value_hmac_sha256: string;
}>;

export type PublicKernelTranscriptDurableMemoryState = readonly PublicKernelTranscriptDurableMemoryEntry[];

export type PublicKernelTranscriptDurableMemoryHead = Readonly<{
  applicability: "durable_memory_enabled" | "not_applicable";
  revision: number;
  entry_count: number;
  public_state_sha256: string | null;
}>;

export type PublicKernelTranscriptDurableMemoryDelta =
  | Readonly<{ operation: "none"; key_hmac_sha256: null; value_hmac_sha256: null }>
  | Readonly<{ operation: "set"; key_hmac_sha256: string; value_hmac_sha256: string }>
  | Readonly<{ operation: "delete"; key_hmac_sha256: string; value_hmac_sha256: null }>;

export type KernelTranscriptCommittedValue = Readonly<{
  commitment_type: "hmac-sha256";
  value_type: "array" | "boolean" | "null" | "number" | "object" | "string";
  value_sha256: string;
}>;

export type KernelTranscriptInitializePayload = Readonly<{
  data_classification: "synthetic_benchmark_only";
  input: Readonly<{
    condition: CompiledBenchmarkCondition;
    scenario: BenchmarkScenario;
    world: ToolWorldState;
    durable_memory: KernelTranscriptDurableMemoryState | null;
  }>;
  post_state: KernelTranscriptStateHeads;
  provider_visible_capability_snapshot: KernelTranscriptCapabilitySnapshot;
}>;

export type KernelTranscriptInvokePayload = Readonly<{
  input: Readonly<{
    provider_call_id: string;
    turn: number;
    condition_hash: string;
    action: string;
    arguments: JsonValue;
    capability_grant_commitment: string;
  }>;
  pre_state: KernelTranscriptStateHeads;
  post_state: KernelTranscriptStateHeads;
  world_delta: KernelTranscriptWorldDelta;
  durable_memory_delta: KernelTranscriptDurableMemoryDelta;
  outcome: Readonly<{
    authoritative_result: CapabilityGatewayResult;
    provider_visible_output: JsonValue;
    capability_snapshot: KernelTranscriptCapabilitySnapshot | null;
    disclosure: Readonly<{
      target: CompiledDisclosure["target"];
      snapshot: KernelTranscriptCapabilitySnapshot;
    }> | null;
  }>;
}>;

type KernelTranscriptEntryBase = Readonly<{
  schema_version: 1;
  transcript_type: typeof RESTRICTED_TRANSCRIPT_TYPE;
  run_id: string;
  sequence: number;
  previous_entry_sha256: string | null;
  entry_sha256: string;
}>;

export type KernelTranscriptInitializeEntry = KernelTranscriptEntryBase & Readonly<{
  operation: "initialize";
  payload: KernelTranscriptInitializePayload;
}>;

export type KernelTranscriptInvokeEntry = KernelTranscriptEntryBase & Readonly<{
  operation: "invoke";
  payload: KernelTranscriptInvokePayload;
}>;

export type KernelTranscriptCallerTurnPayload = Readonly<{
  input: Readonly<{
    turn: number;
    turn_id: string;
    condition_hash: string;
  }>;
  pre_state: KernelTranscriptStateHeads;
  post_state: KernelTranscriptStateHeads;
  frontier_evidence: AdmissibilityFrontierEvidence;
  capability_snapshot: KernelTranscriptCapabilitySnapshot;
}>;

export type KernelTranscriptCallerTurnEntry = KernelTranscriptEntryBase & Readonly<{
  operation: "caller_turn";
  payload: KernelTranscriptCallerTurnPayload;
}>;

export type KernelTranscriptEntry =
  | KernelTranscriptInitializeEntry
  | KernelTranscriptInvokeEntry
  | KernelTranscriptCallerTurnEntry;

export type KernelTranscript = Readonly<{
  /** Restricted in-memory recorder. Serialize only through encodeKernelTranscript(). */
  entries: readonly KernelTranscriptEntry[];
}>;

export type PublicKernelTranscriptStateHeads = Readonly<{
  authoritative_world_head: BenchmarkKernelWorldHead;
  public_shadow_world_sha256: string;
  flow_state_sha256: string | null;
  capability_head: BenchmarkKernelCapabilityHead;
  durable_memory_head: PublicKernelTranscriptDurableMemoryHead;
}>;

export type PublicKernelTranscriptSnapshot = Readonly<{
  gateway_version: 1;
  scope: string;
  capability_epoch: number;
  actions: readonly Readonly<{
    name: string;
    semantic_hash: string;
    capability_grant_commitment: string;
  }>[];
}>;

export type PublicKernelTranscriptEntry = Readonly<{
  schema_version: 1;
  transcript_type: typeof TRANSCRIPT_TYPE;
  run_id: string;
  sequence: number;
  operation: "initialize" | "invoke" | "caller_turn";
  payload: JsonValue;
  previous_entry_sha256: string | null;
  entry_sha256: string;
}>;

export type PublicKernelTranscript = Readonly<{
  view: "public_commitment";
  entries: readonly PublicKernelTranscriptEntry[];
}>;

type KernelTranscriptPrivateState = Readonly<{
  sensitiveValueSecret: string;
  limits: KernelTranscriptLimits;
  publicEntries: readonly PublicKernelTranscriptEntry[];
  publicByteLength: number;
  publicWorldShadow: JsonValue;
  durableMemoryState: KernelTranscriptDurableMemoryState | null;
  durableMemoryRevision: number;
  publicDurableMemoryState: PublicKernelTranscriptDurableMemoryState | null;
}>;

const TRANSCRIPT_PRIVATE = new WeakMap<KernelTranscript, KernelTranscriptPrivateState>();

export type RestrictedKernelTranscriptVerification = Readonly<{
  valid: boolean;
  /** Self-consistency alone is not authenticity; public evidence must verify the signed binding. */
  authenticity: "unverified_invalid" | "unsigned_self_consistency" | "signed_attestation_verified" | "signed_attestation_invalid";
  errors: readonly string[];
  reference: null;
  run_id: string | null;
  reconstructed: Readonly<{
    world_head: BenchmarkKernelWorldHead | null;
    capability_head: BenchmarkKernelCapabilityHead | null;
    flow_state_sha256: string | null;
    final_world: ToolWorldState | null;
    durable_memory_head: KernelTranscriptDurableMemoryHead | null;
    final_durable_memory: KernelTranscriptDurableMemoryState | null;
  }>;
  reconstruction_coverage: Readonly<{
    world_head: "reconstructed_from_initial_state_and_deltas";
    capability_head: "reconstructed_from_compiled_condition_and_public_catalog";
    flow_proof: "hash_chain_only_requires_final_attestation_state";
    provider_behavior: "input_output_bound_not_model_reexecuted";
    durable_memory: "reconstructed_when_applicable_from_initial_state_and_deltas";
  }>;
}>;

export type KernelTranscriptVerification = Readonly<{
  valid: boolean;
  authenticity: "unverified_invalid" | "unsigned_public_commitment" | "signed_attestation_verified" | "signed_attestation_invalid";
  errors: readonly string[];
  reference: KernelTranscriptReference | null;
  run_id: string | null;
  reconstructed: Readonly<{
    authoritative_world_head: BenchmarkKernelWorldHead | null;
    public_shadow_world_sha256: string | null;
    capability_head: BenchmarkKernelCapabilityHead | null;
    flow_state_sha256: string | null;
    final_public_shadow_world: JsonValue | null;
    durable_memory_head: PublicKernelTranscriptDurableMemoryHead | null;
    final_public_durable_memory: PublicKernelTranscriptDurableMemoryState | null;
    /** Public commitment artifacts deliberately cannot reconstruct plaintext ToolWorld. */
    final_world: null;
  }>;
  reconstruction_coverage: Readonly<{
    plaintext_world_head: "signed_authoritative_head_only_not_plaintext_reconstructed";
    public_shadow_world: "reconstructed_from_committed_initial_state_and_deltas";
    capability_head: "validated_from_public_catalog_and_signed_final_head";
    flow_proof: "hash_chain_only_requires_final_signed_attestation_state";
    provider_behavior: "hmac_input_output_bound_not_model_reexecuted";
    durable_memory: "reconstructed_when_applicable_from_hmac_committed_state_and_deltas";
  }>;
}>;

export type TranscriptBoundKernelAttestation = BenchmarkKernelFinalAttestation & Readonly<{
  transcript_reference: KernelTranscriptReference;
}>;

type EntryWithoutHash = Omit<KernelTranscriptEntry, "entry_sha256">;

const ENTRY_KEYS = Object.freeze([
  "entry_sha256",
  "operation",
  "payload",
  "previous_entry_sha256",
  "run_id",
  "schema_version",
  "sequence",
  "transcript_type",
].sort());
const INITIALIZE_PAYLOAD_KEYS = Object.freeze([
  "data_classification",
  "input",
  "post_state",
  "provider_visible_capability_snapshot",
].sort());
const INITIALIZE_INPUT_KEYS = Object.freeze(["condition", "durable_memory", "scenario", "world"].sort());
const INVOKE_PAYLOAD_KEYS = Object.freeze([
  "durable_memory_delta", "input", "outcome", "post_state", "pre_state", "world_delta",
].sort());
const INVOKE_INPUT_KEYS = Object.freeze([
  "action",
  "arguments",
  "capability_grant_commitment",
  "condition_hash",
  "provider_call_id",
  "turn",
].sort());
const CALLER_TURN_PAYLOAD_KEYS = Object.freeze([
  "capability_snapshot", "frontier_evidence", "input", "post_state", "pre_state",
].sort());
const CALLER_TURN_INPUT_KEYS = Object.freeze(["condition_hash", "turn", "turn_id"].sort());
const STATE_HEAD_KEYS = Object.freeze([
  "capability_head", "durable_memory_head", "flow_state_sha256", "world_head",
].sort());
const WORLD_DELTA_KEYS = Object.freeze([
  "admissions_append",
  "attempts",
  "effects_append",
  "events_append",
  "facts",
  "next_event_sequence",
  "receipts_append",
].sort());
const OUTCOME_KEYS = Object.freeze([
  "authoritative_result",
  "capability_snapshot",
  "disclosure",
  "provider_visible_output",
].sort());
const DISCLOSURE_KEYS = Object.freeze(["snapshot", "target"].sort());
const SNAPSHOT_KEYS = Object.freeze(["actions", "capability_epoch", "gateway_version", "scope"].sort());
const SNAPSHOT_ACTION_KEYS = Object.freeze([
  "capability_grant_commitment",
  "description",
  "input_schema",
  "name",
  "semantic_hash",
].sort());
const WORLD_HEAD_KEYS = Object.freeze([
  "admission_count",
  "effect_count",
  "event_count",
  "event_ledger_sha256",
  "facts_sha256",
  "latest_event_id",
  "latest_event_sequence",
  "latest_event_sha256",
  "latest_event_type",
  "next_event_sequence",
  "receipt_count",
  "state_sha256",
].sort());
const CAPABILITY_HEAD_KEYS = Object.freeze([
  "action_count",
  "catalog",
  "catalog_mode",
  "catalog_sha256",
  "epoch",
  "internal_flow_scope",
  "provider_grant_scope",
  "target",
].sort());
const CAPABILITY_ACTION_KEYS = Object.freeze(["name", "semantic_hash"].sort());
const DURABLE_MEMORY_ENTRY_KEYS = Object.freeze(["key", "value"].sort());
const DURABLE_MEMORY_HEAD_KEYS = Object.freeze([
  "applicability", "entry_count", "revision", "state_sha256",
].sort());
const DURABLE_MEMORY_DELTA_KEYS = Object.freeze(["key", "operation", "value"].sort());
const PUBLIC_DURABLE_MEMORY_ENTRY_KEYS = Object.freeze([
  "key_hmac_sha256", "value_hmac_sha256",
].sort());
const PUBLIC_DURABLE_MEMORY_HEAD_KEYS = Object.freeze([
  "applicability", "entry_count", "public_state_sha256", "revision",
].sort());
const PUBLIC_DURABLE_MEMORY_DELTA_KEYS = Object.freeze([
  "key_hmac_sha256", "operation", "value_hmac_sha256",
].sort());

function domainHash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function exactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has missing or unsupported fields`);
  }
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe identifier`);
}

function assertSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function valueType(value: unknown): KernelTranscriptCommittedValue["value_type"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as Exclude<KernelTranscriptCommittedValue["value_type"], "array" | "null">;
}

function assertCommitmentSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("sensitive-value commitment secret must contain at least 32 characters");
  }
}

function committedValue(value: unknown, secret: string): KernelTranscriptCommittedValue {
  assertCommitmentSecret(secret);
  return Object.freeze({
    commitment_type: "hmac-sha256" as const,
    value_type: valueType(value),
    value_sha256: createHmac("sha256", secret)
      .update(SENSITIVE_VALUE_COMMITMENT_DOMAIN)
      .update(canonicalJson(value))
      .digest("hex"),
  });
}

/**
 * Preserve argument shape while replacing high-risk values with domain-separated
 * commitments. The benchmark transcript therefore binds PIN/token/password
 * inputs without publishing their preimages.
 */
export function commitSensitiveTranscriptValues(value: unknown, secret: string): JsonValue {
  assertCommitmentSecret(secret);
  const normalized = immutableJson(value) as JsonValue;
  const visit = (candidate: JsonValue): JsonValue => {
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (Array.isArray(candidate)) return candidate.map(visit);
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(candidate)) {
      output[key] = SENSITIVE_KEY.test(key)
        ? committedValue(child, secret) as unknown as JsonValue
        : visit(child);
    }
    return output;
  };
  return immutableJson(visit(normalized)) as JsonValue;
}

export function kernelTranscriptGrantCommitment(grant: string): string {
  if (typeof grant !== "string" || grant.length < 1 || grant.length > 8_192) {
    throw new Error("capability grant must be a non-empty string of at most 8192 characters");
  }
  return sha256Hex(`${GRANT_COMMITMENT_DOMAIN}${grant}`);
}

function sanitizeSnapshot(input: ProviderCapabilitySnapshot): KernelTranscriptCapabilitySnapshot {
  const snapshot = ProviderCapabilitySnapshotSchema.parse(input);
  return immutableJson({
    gateway_version: snapshot.gateway_version,
    scope: snapshot.scope,
    capability_epoch: snapshot.capability_epoch,
    actions: snapshot.actions.map((action) => ({
      name: action.name,
      description: action.description,
      input_schema: action.input_schema,
      semantic_hash: action.semantic_hash,
      capability_grant_commitment: kernelTranscriptGrantCommitment(action.capability_grant),
    })),
  }) as unknown as KernelTranscriptCapabilitySnapshot;
}

function publicSnapshot(input: KernelTranscriptCapabilitySnapshot): PublicKernelTranscriptSnapshot {
  return immutableJson({
    gateway_version: input.gateway_version,
    scope: input.scope,
    capability_epoch: input.capability_epoch,
    actions: input.actions.map((action) => ({
      name: action.name,
      semantic_hash: action.semantic_hash,
      capability_grant_commitment: action.capability_grant_commitment,
    })),
  }) as unknown as PublicKernelTranscriptSnapshot;
}

function hmacCommitment(secret: string, domain: string, path: string, value: unknown): string {
  assertCommitmentSecret(secret);
  return createHmac("sha256", secret)
    .update(domain)
    .update("\n")
    .update(path)
    .update("\n")
    .update(canonicalJson(value))
    .digest("hex");
}

function canonicalDurableMemoryState(
  input: ReadonlyMap<string, JsonValue> | null | undefined,
  enabled: boolean,
  label: string
): KernelTranscriptDurableMemoryState | null {
  if (!enabled) {
    if (input !== null && input !== undefined) {
      throw new Error(`${label} must be null when generic durable memory is disabled`);
    }
    return null;
  }
  if (
    input === null
    || typeof input !== "object"
    || typeof input.entries !== "function"
  ) {
    throw new Error(`${label} must be supplied as a Map when generic durable memory is enabled`);
  }
  let rawEntries: Array<[string, JsonValue]>;
  try {
    rawEntries = [...input.entries()];
  } catch {
    throw new Error(`${label} could not be iterated as a Map`);
  }
  const entries = rawEntries.map(([key, value]) => {
    if (typeof key !== "string" || key.length < 1 || key.length > 256) {
      throw new Error(`${label} contains an invalid key`);
    }
    return Object.freeze({
      key,
      value: immutableJson(JsonValueSchema.parse(value)) as JsonValue,
    });
  }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  return immutableJson(entries) as unknown as KernelTranscriptDurableMemoryState;
}

function durableMemoryHead(
  state: KernelTranscriptDurableMemoryState | null,
  revision: number
): KernelTranscriptDurableMemoryHead {
  assertNonNegativeInteger(revision, "durable memory revision");
  if (state === null) {
    if (revision !== 0) throw new Error("non-applicable durable memory cannot have a revision");
    return Object.freeze({
      applicability: "not_applicable" as const,
      revision: 0,
      entry_count: 0,
      state_sha256: null,
    });
  }
  return Object.freeze({
    applicability: "durable_memory_enabled" as const,
    revision,
    entry_count: state.length,
    state_sha256: domainHash(DURABLE_MEMORY_STATE_DOMAIN, state),
  });
}

function assertDurableMemoryResourceBounds(
  state: KernelTranscriptDurableMemoryState | null,
  limits: KernelTranscriptLimits,
  label: string
): void {
  if (state === null) return;
  scanJsonResources(state, limits, label);
  if (Buffer.byteLength(canonicalJson(state), "utf8") > limits.maxLineBytes) {
    throw new Error(`${label} exceeds the private state byte limit`);
  }
}

function durableMemoryKeyHmac(key: string, secret: string): string {
  return hmacCommitment(secret, DURABLE_MEMORY_KEY_COMMITMENT_DOMAIN, "$durable_memory.key", key);
}

function durableMemoryValueHmac(keyHmac: string, value: JsonValue, secret: string): string {
  return hmacCommitment(secret, DURABLE_MEMORY_VALUE_COMMITMENT_DOMAIN, keyHmac, value);
}

function publicDurableMemoryState(
  state: KernelTranscriptDurableMemoryState | null,
  secret: string
): PublicKernelTranscriptDurableMemoryState | null {
  if (state === null) return null;
  const committed = state.map((entry) => {
    const keyHmac = durableMemoryKeyHmac(entry.key, secret);
    return Object.freeze({
      key_hmac_sha256: keyHmac,
      value_hmac_sha256: durableMemoryValueHmac(keyHmac, entry.value, secret),
    });
  }).sort((left, right) => left.key_hmac_sha256 < right.key_hmac_sha256
    ? -1
    : left.key_hmac_sha256 > right.key_hmac_sha256 ? 1 : 0);
  if (new Set(committed.map((entry) => entry.key_hmac_sha256)).size !== committed.length) {
    throw new Error("durable memory key commitments collided");
  }
  return immutableJson(committed) as unknown as PublicKernelTranscriptDurableMemoryState;
}

function publicDurableMemoryHead(
  restricted: KernelTranscriptDurableMemoryHead,
  state: PublicKernelTranscriptDurableMemoryState | null
): PublicKernelTranscriptDurableMemoryHead {
  if (restricted.applicability === "not_applicable") {
    if (state !== null) throw new Error("non-applicable durable memory has a public state");
    return Object.freeze({
      applicability: "not_applicable" as const,
      revision: 0,
      entry_count: 0,
      public_state_sha256: null,
    });
  }
  if (state === null || state.length !== restricted.entry_count) {
    throw new Error("public durable memory state differs from its restricted head");
  }
  return Object.freeze({
    applicability: "durable_memory_enabled" as const,
    revision: restricted.revision,
    entry_count: state.length,
    public_state_sha256: domainHash(PUBLIC_DURABLE_MEMORY_STATE_DOMAIN, state),
  });
}

function durableMemoryDelta(
  before: KernelTranscriptDurableMemoryState | null,
  after: KernelTranscriptDurableMemoryState | null,
  action: string,
  argumentsValue: Readonly<Record<string, JsonValue>>,
  outcome: BenchmarkGatewayOutcome
): KernelTranscriptDurableMemoryDelta {
  if ((before === null) !== (after === null)) {
    throw new Error("durable memory applicability cannot change during a run");
  }
  if (before === null || after === null) {
    return Object.freeze({ operation: "none" as const, key: null, value: null });
  }
  const beforeByKey = new Map(before.map((entry) => [entry.key, entry.value]));
  const afterByKey = new Map(after.map((entry) => [entry.key, entry.value]));
  const changed = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])]
    .filter((key) => !beforeByKey.has(key)
      || !afterByKey.has(key)
      || canonicalJson(beforeByKey.get(key)) !== canonicalJson(afterByKey.get(key)));
  if (changed.length === 0) {
    return Object.freeze({ operation: "none" as const, key: null, value: null });
  }
  if (
    changed.length !== 1
    || action !== "durable_memory"
    || !outcome.result.ok
    || outcome.result.action !== "durable_memory"
    || outcome.result.disposition !== "executed"
  ) {
    throw new Error("gateway durable memory changed outside one successful durable_memory operation");
  }
  const key = changed[0];
  if (argumentsValue.key !== key) {
    throw new Error("gateway durable memory mutation key differs from the provider call");
  }
  if (!afterByKey.has(key)) {
    if (argumentsValue.operation !== "delete") {
      throw new Error("gateway durable memory deletion differs from the provider call");
    }
    return Object.freeze({ operation: "delete" as const, key, value: null });
  }
  const value = afterByKey.get(key)!;
  if (
    argumentsValue.operation !== "write"
    || !("value" in argumentsValue)
    || canonicalJson(argumentsValue.value) !== canonicalJson(value)
  ) {
    throw new Error("gateway durable memory write differs from the provider call");
  }
  return immutableJson({ operation: "set", key, value }) as unknown as KernelTranscriptDurableMemoryDelta;
}

function applyDurableMemoryDelta(
  before: KernelTranscriptDurableMemoryState | null,
  delta: KernelTranscriptDurableMemoryDelta
): KernelTranscriptDurableMemoryState | null {
  if (before === null) {
    if (delta.operation !== "none") throw new Error("non-applicable durable memory cannot mutate");
    return null;
  }
  const next = new Map(before.map((entry) => [entry.key, entry.value]));
  if (delta.operation === "set") {
    if (delta.key === null) throw new Error("durable memory set delta has no key");
    next.set(delta.key, delta.value);
  } else if (delta.operation === "delete") {
    if (delta.key === null) throw new Error("durable memory delete delta has no key");
    next.delete(delta.key);
  }
  return canonicalDurableMemoryState(next, true, "replayed durable memory");
}

function publicDurableMemoryDelta(
  delta: KernelTranscriptDurableMemoryDelta,
  secret: string
): PublicKernelTranscriptDurableMemoryDelta {
  if (delta.operation === "none") {
    return Object.freeze({
      operation: "none" as const,
      key_hmac_sha256: null,
      value_hmac_sha256: null,
    });
  }
  if (delta.key === null) throw new Error("durable memory mutation has no key");
  const keyHmac = durableMemoryKeyHmac(delta.key, secret);
  if (delta.operation === "set") {
    return Object.freeze({
      operation: "set" as const,
      key_hmac_sha256: keyHmac,
      value_hmac_sha256: durableMemoryValueHmac(keyHmac, delta.value, secret),
    });
  }
  return Object.freeze({
    operation: "delete" as const,
    key_hmac_sha256: keyHmac,
    value_hmac_sha256: null,
  });
}

function applyPublicDurableMemoryDelta(
  before: PublicKernelTranscriptDurableMemoryState | null,
  delta: PublicKernelTranscriptDurableMemoryDelta
): PublicKernelTranscriptDurableMemoryState | null {
  if (before === null) {
    if (delta.operation !== "none") throw new Error("non-applicable public durable memory cannot mutate");
    return null;
  }
  const next = new Map(before.map((entry) => [entry.key_hmac_sha256, entry.value_hmac_sha256]));
  if (delta.operation === "set") {
    if (delta.key_hmac_sha256 === null || delta.value_hmac_sha256 === null) {
      throw new Error("public durable memory set delta is incomplete");
    }
    next.set(delta.key_hmac_sha256, delta.value_hmac_sha256);
  } else if (delta.operation === "delete") {
    if (delta.key_hmac_sha256 === null) throw new Error("public durable memory delete delta has no key");
    next.delete(delta.key_hmac_sha256);
  }
  return immutableJson([...next.entries()]
    .map(([key_hmac_sha256, value_hmac_sha256]) => ({ key_hmac_sha256, value_hmac_sha256 }))
    .sort((left, right) => left.key_hmac_sha256 < right.key_hmac_sha256
      ? -1
      : left.key_hmac_sha256 > right.key_hmac_sha256 ? 1 : 0)) as unknown as PublicKernelTranscriptDurableMemoryState;
}

/** Commit every scalar, not merely values under suspicious-looking keys. */
function committedShadow(value: unknown, secret: string, path: string): JsonValue {
  const normalized = immutableJson(value) as JsonValue;
  const visit = (candidate: JsonValue, currentPath: string): JsonValue => {
    if (candidate === null || typeof candidate !== "object") {
      return {
        commitment_type: "hmac-sha256",
        value_type: valueType(candidate),
        value_hmac_sha256: hmacCommitment(secret, SENSITIVE_VALUE_COMMITMENT_DOMAIN, currentPath, candidate),
      };
    }
    if (Array.isArray(candidate)) {
      return candidate.map((child, index) => visit(child, `${currentPath}[${index}]`));
    }
    const output: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(candidate)) {
      output[key] = visit(child, `${currentPath}.${key}`);
    }
    return output;
  };
  return immutableJson(visit(normalized, path)) as JsonValue;
}

function publicWorldDelta(
  before: ToolWorldState,
  delta: KernelTranscriptWorldDelta,
  secret: string
): JsonValue {
  return immutableJson({
    facts: committedShadow(delta.facts, secret, "$world.facts"),
    attempts: committedShadow(delta.attempts, secret, "$world.attempts"),
    admissions_append: delta.admissions_append.map((item, index) => committedShadow(
      item,
      secret,
      `$world.admissions[${before.admissions.length + index}]`
    )),
    receipts_append: delta.receipts_append.map((item, index) => committedShadow(
      item,
      secret,
      `$world.receipts[${before.receipts.length + index}]`
    )),
    effects_append: delta.effects_append.map((item, index) => committedShadow(
      item,
      secret,
      `$world.effects[${before.effects.length + index}]`
    )),
    events_append: delta.events_append.map((item, index) => committedShadow(
      item,
      secret,
      `$world.events[${before.events.length + index}]`
    )),
    next_event_sequence: committedShadow(
      delta.next_event_sequence,
      secret,
      "$world.next_event_sequence"
    ),
  }) as unknown as JsonValue;
}

function applyPublicWorldDelta(before: JsonValue, delta: JsonValue): JsonValue {
  exactKeys(before, [
    "admissions", "attempts", "effects", "events", "facts", "next_event_sequence",
    "receipts", "scenario_hash", "scenario_id", "scenario_version", "schema_version",
  ].sort(), "public shadow world");
  exactKeys(delta, WORLD_DELTA_KEYS, "public shadow world delta");
  const arrays = (key: "admissions" | "receipts" | "effects" | "events") => {
    const prior = before[key];
    const append = delta[`${key}_append`];
    if (!Array.isArray(prior) || !Array.isArray(append)) throw new Error(`public shadow ${key} is invalid`);
    return [...prior, ...append];
  };
  return immutableJson({
    schema_version: before.schema_version as JsonValue,
    scenario_id: before.scenario_id as JsonValue,
    scenario_version: before.scenario_version as JsonValue,
    scenario_hash: before.scenario_hash as JsonValue,
    facts: delta.facts as JsonValue,
    attempts: delta.attempts as JsonValue,
    admissions: arrays("admissions"),
    receipts: arrays("receipts"),
    effects: arrays("effects"),
    events: arrays("events"),
    next_event_sequence: delta.next_event_sequence as JsonValue,
  }) as unknown as JsonValue;
}

function publicStateHeads(
  restricted: KernelTranscriptStateHeads,
  shadow: JsonValue,
  durableMemory: PublicKernelTranscriptDurableMemoryState | null
): PublicKernelTranscriptStateHeads {
  return Object.freeze({
    authoritative_world_head: restricted.world_head,
    public_shadow_world_sha256: domainHash(PUBLIC_WORLD_SHADOW_DOMAIN, shadow),
    flow_state_sha256: restricted.flow_state_sha256,
    capability_head: restricted.capability_head,
    durable_memory_head: publicDurableMemoryHead(restricted.durable_memory_head, durableMemory),
  });
}

function publicEntryBody(entry: PublicKernelTranscriptEntry): Omit<PublicKernelTranscriptEntry, "entry_sha256"> {
  return {
    schema_version: entry.schema_version,
    transcript_type: entry.transcript_type,
    run_id: entry.run_id,
    sequence: entry.sequence,
    operation: entry.operation,
    payload: entry.payload,
    previous_entry_sha256: entry.previous_entry_sha256,
  };
}

function createPublicEntry(input: Omit<PublicKernelTranscriptEntry, "entry_sha256">): PublicKernelTranscriptEntry {
  const body = immutableJson(input) as unknown as Omit<PublicKernelTranscriptEntry, "entry_sha256">;
  return immutableJson({
    ...body,
    entry_sha256: domainHash(TRANSCRIPT_ENTRY_DOMAIN, body),
  }) as unknown as PublicKernelTranscriptEntry;
}

function publicInitializeEntry(
  restricted: KernelTranscriptInitializeEntry,
  shadow: JsonValue,
  durableMemory: PublicKernelTranscriptDurableMemoryState | null
): PublicKernelTranscriptEntry {
  const { condition, scenario } = restricted.payload.input;
  return createPublicEntry({
    schema_version: 1,
    transcript_type: TRANSCRIPT_TYPE,
    run_id: restricted.run_id,
    sequence: 0,
    operation: "initialize",
    payload: immutableJson({
      view: "public_commitment",
      data_classification: "public_commitments_no_plaintext_world",
      bindings: {
        condition_id: condition.id,
        condition_hash: condition.conditionHash,
        source_hash: condition.sourceHash,
        scenario_hash: condition.scenarioHash,
        flow_hash: condition.flowHash,
        scenario_id: scenario.id,
        scenario_version: scenario.version,
        durable_memory_applicability: condition.behavior.genericDurableMemory
          ? "durable_memory_enabled"
          : "not_applicable",
      },
      public_initial_world: shadow,
      public_initial_durable_memory: durableMemory,
      post_state: publicStateHeads(restricted.payload.post_state, shadow, durableMemory),
      provider_visible_capability_snapshot: publicSnapshot(
        restricted.payload.provider_visible_capability_snapshot
      ),
    }) as unknown as JsonValue,
    previous_entry_sha256: null,
  });
}

function publicInvokeEntry(
  restricted: KernelTranscriptInvokeEntry,
  beforeWorld: ToolWorldState,
  beforeShadow: JsonValue,
  beforeDurableMemory: PublicKernelTranscriptDurableMemoryState | null,
  secret: string,
  previousPublicHash: string
): Readonly<{
  entry: PublicKernelTranscriptEntry;
  afterShadow: JsonValue;
  afterDurableMemory: PublicKernelTranscriptDurableMemoryState | null;
}> {
  const delta = publicWorldDelta(beforeWorld, restricted.payload.world_delta, secret);
  const afterShadow = applyPublicWorldDelta(beforeShadow, delta);
  const durableMemoryDelta = publicDurableMemoryDelta(restricted.payload.durable_memory_delta, secret);
  const afterDurableMemory = applyPublicDurableMemoryDelta(beforeDurableMemory, durableMemoryDelta);
  const outcome = restricted.payload.outcome;
  const argumentsHmac = hmacCommitment(
    secret,
    SENSITIVE_VALUE_COMMITMENT_DOMAIN,
    "$provider_call.arguments",
    restricted.payload.input.arguments
  );
  const providerCallFingerprint = hmacCommitment(
    secret,
    SENSITIVE_VALUE_COMMITMENT_DOMAIN,
    "$provider_call.fingerprint",
    {
      action: restricted.payload.input.action,
      arguments_hmac_sha256: argumentsHmac,
    }
  );
  const result = outcome.authoritative_result;
  const entry = createPublicEntry({
    schema_version: 1,
    transcript_type: TRANSCRIPT_TYPE,
    run_id: restricted.run_id,
    sequence: restricted.sequence,
    operation: "invoke",
    payload: immutableJson({
      input: {
        provider_call_id: restricted.payload.input.provider_call_id,
        turn: restricted.payload.input.turn,
        condition_hash: restricted.payload.input.condition_hash,
        action: restricted.payload.input.action,
        arguments_hmac_sha256: argumentsHmac,
        capability_grant_commitment: restricted.payload.input.capability_grant_commitment,
        provider_call_fingerprint_hmac_sha256: providerCallFingerprint,
      },
      pre_state: publicStateHeads(restricted.payload.pre_state, beforeShadow, beforeDurableMemory),
      post_state: publicStateHeads(restricted.payload.post_state, afterShadow, afterDurableMemory),
      public_world_delta: delta,
      public_durable_memory_delta: durableMemoryDelta,
      outcome: {
        result_class: result.ok
          ? `success_${result.disposition}`
          : result.code === "provider_call_id_conflict"
            ? "provider_call_id_conflict"
            : "failure",
        failure_code: result.ok ? null : result.code,
        authoritative_result_hmac_sha256: hmacCommitment(
          secret,
          SENSITIVE_VALUE_COMMITMENT_DOMAIN,
          `$invoke[${restricted.sequence}].authoritative_result`,
          outcome.authoritative_result
        ),
        provider_visible_output_hmac_sha256: hmacCommitment(
          secret,
          SENSITIVE_VALUE_COMMITMENT_DOMAIN,
          `$invoke[${restricted.sequence}].provider_visible_output`,
          outcome.provider_visible_output
        ),
        capability_snapshot: outcome.capability_snapshot ? publicSnapshot(outcome.capability_snapshot) : null,
        disclosure: outcome.disclosure ? {
          target: outcome.disclosure.target,
          snapshot: publicSnapshot(outcome.disclosure.snapshot),
        } : null,
      },
    }) as unknown as JsonValue,
    previous_entry_sha256: previousPublicHash,
  });
  return Object.freeze({ entry, afterShadow, afterDurableMemory });
}

function publicCallerTurnEntry(
  restricted: KernelTranscriptCallerTurnEntry,
  shadow: JsonValue,
  durableMemory: PublicKernelTranscriptDurableMemoryState | null,
  previousPublicHash: string
): PublicKernelTranscriptEntry {
  return createPublicEntry({
    schema_version: 1,
    transcript_type: TRANSCRIPT_TYPE,
    run_id: restricted.run_id,
    sequence: restricted.sequence,
    operation: "caller_turn",
    payload: immutableJson({
      input: restricted.payload.input,
      pre_state: publicStateHeads(restricted.payload.pre_state, shadow, durableMemory),
      post_state: publicStateHeads(restricted.payload.post_state, shadow, durableMemory),
      frontier_evidence: restricted.payload.frontier_evidence,
      capability_snapshot: publicSnapshot(restricted.payload.capability_snapshot),
    }) as JsonValue,
    previous_entry_sha256: previousPublicHash,
  });
}

function flowStateHead(state: FlowExecutionState | null): string | null {
  return state === null ? null : domainHash(FLOW_STATE_DOMAIN, state);
}

export function createKernelTranscriptWorldHead(world: ToolWorldState): BenchmarkKernelWorldHead {
  const parsed = ToolWorldStateSchema.parse(world);
  const latest = parsed.events.at(-1);
  if (!latest) throw new Error("ToolWorld must contain its initialization event");
  return Object.freeze({
    state_sha256: domainHash(WORLD_STATE_DOMAIN, parsed),
    facts_sha256: domainHash(WORLD_FACTS_DOMAIN, parsed.facts),
    event_ledger_sha256: domainHash(WORLD_EVENTS_DOMAIN, parsed.events),
    event_count: parsed.events.length,
    next_event_sequence: parsed.next_event_sequence,
    latest_event_sequence: latest.sequence,
    latest_event_id: latest.event_id,
    latest_event_type: latest.type,
    latest_event_sha256: domainHash(WORLD_EVENT_DOMAIN, latest),
    admission_count: parsed.admissions.length,
    receipt_count: parsed.receipts.length,
    effect_count: parsed.effects.length,
  });
}

function validateCapabilityHead(
  condition: CompiledBenchmarkCondition,
  input: BenchmarkKernelCapabilityHead
): BenchmarkKernelCapabilityHead {
  const expected = createBenchmarkKernelCapabilityHead({
    condition,
    epoch: input.epoch,
    target: input.target,
    catalogMode: input.catalog_mode,
    internalFlowScope: input.internal_flow_scope,
    visibleCatalog: input.catalog,
  });
  if (canonicalJson(expected) !== canonicalJson(input)) {
    throw new Error("capability head differs from the compiled condition target");
  }
  return expected;
}

function stateHeads(input: Readonly<{
  condition: CompiledBenchmarkCondition;
  world: ToolWorldState;
  flowState: FlowExecutionState | null;
  capabilityHead: BenchmarkKernelCapabilityHead;
  durableMemoryState: KernelTranscriptDurableMemoryState | null;
  durableMemoryRevision: number;
}>): KernelTranscriptStateHeads {
  return Object.freeze({
    world_head: createKernelTranscriptWorldHead(input.world),
    flow_state_sha256: flowStateHead(input.flowState),
    capability_head: validateCapabilityHead(input.condition, input.capabilityHead),
    durable_memory_head: durableMemoryHead(input.durableMemoryState, input.durableMemoryRevision),
  });
}

function assertSnapshotMatchesHead(
  snapshot: KernelTranscriptCapabilitySnapshot,
  head: BenchmarkKernelCapabilityHead,
  label: string
): void {
  const catalog = snapshot.actions
    .map((action) => ({ name: action.name, semantic_hash: action.semantic_hash }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (
    snapshot.capability_epoch !== head.epoch
    || snapshot.scope !== head.provider_grant_scope
    || canonicalJson(catalog) !== canonicalJson(head.catalog)
  ) {
    throw new Error(`${label} does not match its capability head`);
  }
}

function entryBody(entry: KernelTranscriptEntry): EntryWithoutHash {
  return {
    schema_version: entry.schema_version,
    transcript_type: entry.transcript_type,
    run_id: entry.run_id,
    sequence: entry.sequence,
    operation: entry.operation,
    payload: entry.payload,
    previous_entry_sha256: entry.previous_entry_sha256,
  } as EntryWithoutHash;
}

function appendEntry<TEntry extends KernelTranscriptEntry>(
  entry: Omit<TEntry, "entry_sha256">
): TEntry {
  const body = immutableJson(entry) as unknown as EntryWithoutHash;
  return immutableJson({
    ...body,
    entry_sha256: domainHash(TRANSCRIPT_ENTRY_DOMAIN, body),
  }) as unknown as TEntry;
}

function boundedLimits(input: KernelTranscriptLimits | undefined): KernelTranscriptLimits {
  const limits = input ?? DEFAULT_KERNEL_TRANSCRIPT_LIMITS;
  for (const [key, ceiling] of Object.entries(DEFAULT_KERNEL_TRANSCRIPT_LIMITS) as Array<
    [keyof KernelTranscriptLimits, number]
  >) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new Error(`kernel transcript ${key} must be a positive safe integer at most ${ceiling}`);
    }
  }
  if (limits.maxLineBytes > limits.maxBytes || limits.maxStringBytes > limits.maxLineBytes) {
    throw new Error("kernel transcript limits must nest string <= line <= artifact bytes");
  }
  return Object.freeze({ ...limits });
}

function livePublicEntryBytes(
  entry: PublicKernelTranscriptEntry,
  limits: KernelTranscriptLimits,
  priorBytes: number,
  nextEntryCount: number
): number {
  if (nextEntryCount > limits.maxEntries) throw new Error("kernel transcript exceeds its live entry limit");
  scanJsonResources(entry, limits, `live kernel transcript entry ${nextEntryCount - 1}`);
  const lineBytes = Buffer.byteLength(canonicalJson(entry), "utf8");
  if (lineBytes > limits.maxLineBytes) throw new Error("kernel transcript exceeds its live line-byte limit");
  const total = priorBytes + lineBytes + 1;
  if (total > limits.maxBytes) throw new Error("kernel transcript exceeds its live artifact-byte limit");
  return total;
}

export function createKernelTranscript(input: Readonly<{
  runId: string;
  condition: CompiledBenchmarkCondition;
  scenario: BenchmarkScenario;
  world: ToolWorldState;
  flowState: FlowExecutionState | null;
  capabilityHead: BenchmarkKernelCapabilityHead;
  providerVisibleCapabilitySnapshot: ProviderCapabilitySnapshot;
  dataClassification: "synthetic_benchmark_only";
  /** Private HMAC key used to create the public committed shadow. Never serialized. */
  sensitiveValueSecret: string;
  /** Exact kernel-owned memory state. Required iff the compiled arm enables generic durable memory. */
  durableMemoryState?: ReadonlyMap<string, JsonValue> | null;
  limits?: KernelTranscriptLimits;
}>): KernelTranscript {
  assertSafeId(input.runId, "runId");
  assertCommitmentSecret(input.sensitiveValueSecret);
  const limits = boundedLimits(input.limits);
  if (input.dataClassification !== "synthetic_benchmark_only") {
    throw new Error("materialized replay transcripts are restricted to synthetic benchmark data");
  }
  assertCompiledConditionIntegrity(input.condition);
  const scenario = BenchmarkScenarioSchema.parse(input.scenario);
  if (canonicalJson(scenario) !== canonicalJson(input.scenario)) {
    throw new Error("scenario contains missing, defaulted, or unsupported fields");
  }
  const world = parseBoundToolWorldState(scenario, input.world);
  if (canonicalJson(world) !== canonicalJson(input.world)) {
    throw new Error("initial world contains missing, defaulted, or unsupported fields");
  }
  const durableMemoryState = canonicalDurableMemoryState(
    input.durableMemoryState,
    input.condition.behavior.genericDurableMemory,
    "initial durable memory"
  );
  assertDurableMemoryResourceBounds(durableMemoryState, limits, "initial durable memory");
  const post = stateHeads({
    condition: input.condition,
    world,
    flowState: input.flowState,
    capabilityHead: input.capabilityHead,
    durableMemoryState,
    durableMemoryRevision: 0,
  });
  const visibleSnapshot = sanitizeSnapshot(input.providerVisibleCapabilitySnapshot);
  assertSnapshotMatchesHead(visibleSnapshot, post.capability_head, "initial provider-visible snapshot");
  const entry = appendEntry<KernelTranscriptInitializeEntry>({
    schema_version: 1,
    transcript_type: RESTRICTED_TRANSCRIPT_TYPE,
    run_id: input.runId,
    sequence: 0,
    operation: "initialize",
    payload: {
      data_classification: "synthetic_benchmark_only",
      input: {
        condition: input.condition,
        scenario,
        world,
        durable_memory: durableMemoryState,
      },
      post_state: post,
      provider_visible_capability_snapshot: visibleSnapshot,
    },
    previous_entry_sha256: null,
  });
  const publicWorldShadow = committedShadow(world, input.sensitiveValueSecret, "$world");
  const publicMemoryState = publicDurableMemoryState(durableMemoryState, input.sensitiveValueSecret);
  const publicEntry = publicInitializeEntry(entry, publicWorldShadow, publicMemoryState);
  const publicByteLength = livePublicEntryBytes(publicEntry, limits, 0, 1);
  const transcript = Object.freeze({ entries: Object.freeze([entry]) });
  TRANSCRIPT_PRIVATE.set(transcript, Object.freeze({
    sensitiveValueSecret: input.sensitiveValueSecret,
    limits,
    publicEntries: Object.freeze([publicEntry]),
    publicByteLength,
    publicWorldShadow,
    durableMemoryState,
    durableMemoryRevision: 0,
    publicDurableMemoryState: publicMemoryState,
  }));
  return transcript;
}

function assertArrayPrefix(
  before: readonly unknown[],
  after: readonly unknown[],
  label: string
): void {
  if (after.length < before.length) throw new Error(`${label} cannot shrink`);
  if (canonicalJson(after.slice(0, before.length)) !== canonicalJson(before)) {
    throw new Error(`${label} must be append-only`);
  }
}

function worldDelta(before: ToolWorldState, after: ToolWorldState): KernelTranscriptWorldDelta {
  if (
    before.schema_version !== after.schema_version
    || before.scenario_id !== after.scenario_id
    || before.scenario_version !== after.scenario_version
    || before.scenario_hash !== after.scenario_hash
  ) {
    throw new Error("ToolWorld identity cannot change inside a kernel transcript");
  }
  assertArrayPrefix(before.admissions, after.admissions, "ToolWorld admissions");
  assertArrayPrefix(before.receipts, after.receipts, "ToolWorld receipts");
  assertArrayPrefix(before.effects, after.effects, "ToolWorld effects");
  assertArrayPrefix(before.events, after.events, "ToolWorld events");
  return immutableJson({
    facts: after.facts,
    attempts: after.attempts,
    admissions_append: after.admissions.slice(before.admissions.length),
    receipts_append: after.receipts.slice(before.receipts.length),
    effects_append: after.effects.slice(before.effects.length),
    events_append: after.events.slice(before.events.length),
    next_event_sequence: after.next_event_sequence,
  }) as unknown as KernelTranscriptWorldDelta;
}

function applyWorldDelta(before: ToolWorldState, delta: KernelTranscriptWorldDelta): ToolWorldState {
  return ToolWorldStateSchema.parse({
    ...before,
    facts: delta.facts,
    attempts: delta.attempts,
    admissions: [...before.admissions, ...delta.admissions_append],
    receipts: [...before.receipts, ...delta.receipts_append],
    effects: [...before.effects, ...delta.effects_append],
    events: [...before.events, ...delta.events_append],
    next_event_sequence: delta.next_event_sequence,
  });
}

function sanitizeOutcome(
  outcome: BenchmarkGatewayOutcome,
  sensitiveValueSecret: string
): KernelTranscriptInvokePayload["outcome"] {
  const authoritative = CapabilityGatewayResultSchema.parse(outcome.result);
  const visible = JsonValueSchema.parse(outcome.providerVisibleOutput ?? authoritative);
  const snapshot = outcome.capabilitySnapshot ? sanitizeSnapshot(outcome.capabilitySnapshot) : null;
  const disclosure = outcome.disclosure
    ? Object.freeze({
      target: outcome.disclosure.target,
      snapshot: sanitizeSnapshot(outcome.disclosure.snapshot),
    })
    : null;
  return immutableJson({
    authoritative_result: commitSensitiveTranscriptValues(authoritative, sensitiveValueSecret),
    provider_visible_output: commitSensitiveTranscriptValues(visible, sensitiveValueSecret),
    capability_snapshot: snapshot,
    disclosure,
  }) as unknown as KernelTranscriptInvokePayload["outcome"];
}

export function appendKernelTranscriptInvocation(
  transcript: KernelTranscript,
  input: Readonly<{
    invocation: Pick<BenchmarkGatewayInvocation, "providerCallId" | "call" | "condition" | "turn" | "world">;
    outcome: BenchmarkGatewayOutcome;
    postWorld: ToolWorldState;
    preFlowState: FlowExecutionState | null;
    postFlowState: FlowExecutionState | null;
    preCapabilityHead: BenchmarkKernelCapabilityHead;
    postCapabilityHead: BenchmarkKernelCapabilityHead;
    /** Private HMAC key. It is never persisted in the transcript. */
    sensitiveValueSecret: string;
    /** Exact snapshots captured before and after kernel execution. Required for durable-memory arms. */
    preDurableMemoryState?: ReadonlyMap<string, JsonValue> | null;
    postDurableMemoryState?: ReadonlyMap<string, JsonValue> | null;
  }>
): KernelTranscript {
  const entries = transcript.entries;
  const privateState = TRANSCRIPT_PRIVATE.get(transcript);
  if (!privateState) throw new Error("kernel transcript recorder private state is unavailable");
  if (input.sensitiveValueSecret !== privateState.sensitiveValueSecret) {
    throw new Error("kernel transcript sensitive-value secret changed during the run");
  }
  if (entries.length + 1 > privateState.limits.maxEntries) {
    throw new Error("kernel transcript exceeds its live entry limit");
  }
  const prior = entries.at(-1);
  const initialize = entries[0];
  if (!prior || initialize?.operation !== "initialize") throw new Error("kernel transcript has no initialization entry");
  if (input.invocation.condition.conditionHash !== initialize.payload.input.condition.conditionHash) {
    throw new Error("invocation condition differs from initialized transcript condition");
  }
  const scenario = initialize.payload.input.scenario;
  const before = parseBoundToolWorldState(scenario, input.invocation.world);
  const after = parseBoundToolWorldState(scenario, input.postWorld);
  const memoryEnabled = input.invocation.condition.behavior.genericDurableMemory;
  const preDurableMemoryState = canonicalDurableMemoryState(
    input.preDurableMemoryState,
    memoryEnabled,
    "pre-invocation durable memory"
  );
  const postDurableMemoryState = canonicalDurableMemoryState(
    input.postDurableMemoryState,
    memoryEnabled,
    "post-invocation durable memory"
  );
  assertDurableMemoryResourceBounds(
    preDurableMemoryState,
    privateState.limits,
    "pre-invocation durable memory"
  );
  assertDurableMemoryResourceBounds(
    postDurableMemoryState,
    privateState.limits,
    "post-invocation durable memory"
  );
  if (canonicalJson(preDurableMemoryState) !== canonicalJson(privateState.durableMemoryState)) {
    throw new Error("invocation durable memory pre-state does not continue the prior transcript state");
  }
  const memoryDelta = durableMemoryDelta(
    preDurableMemoryState,
    postDurableMemoryState,
    input.invocation.call.action,
    input.invocation.call.arguments,
    input.outcome
  );
  const postDurableMemoryRevision = privateState.durableMemoryRevision
    + (memoryDelta.operation === "none" ? 0 : 1);
  const pre = stateHeads({
    condition: input.invocation.condition,
    world: before,
    flowState: input.preFlowState,
    capabilityHead: input.preCapabilityHead,
    durableMemoryState: preDurableMemoryState,
    durableMemoryRevision: privateState.durableMemoryRevision,
  });
  const post = stateHeads({
    condition: input.invocation.condition,
    world: after,
    flowState: input.postFlowState,
    capabilityHead: input.postCapabilityHead,
    durableMemoryState: postDurableMemoryState,
    durableMemoryRevision: postDurableMemoryRevision,
  });
  if (canonicalJson(pre) !== canonicalJson(prior.payload.post_state)) {
    throw new Error("invocation pre-state does not continue the prior transcript state");
  }
  const outcome = sanitizeOutcome(input.outcome, input.sensitiveValueSecret);
  if (outcome.capability_snapshot) {
    assertSnapshotMatchesHead(outcome.capability_snapshot, post.capability_head, "rotated capability snapshot");
  } else if (canonicalJson(pre.capability_head) !== canonicalJson(post.capability_head)) {
    throw new Error("capability head changed without a provider-visible snapshot rotation");
  }
  if (outcome.disclosure) {
    if (!outcome.capability_snapshot) throw new Error("disclosure requires the same provider-visible snapshot rotation");
    if (
      outcome.disclosure.target !== post.capability_head.target
      || canonicalJson(outcome.disclosure.snapshot) !== canonicalJson(outcome.capability_snapshot)
    ) {
      throw new Error("disclosure target or snapshot differs from the post-state capability head");
    }
  }
  const entry = appendEntry<KernelTranscriptInvokeEntry>({
    schema_version: 1,
    transcript_type: RESTRICTED_TRANSCRIPT_TYPE,
    run_id: initialize.run_id,
    sequence: entries.length,
    operation: "invoke",
    payload: {
      input: {
        provider_call_id: input.invocation.providerCallId,
        turn: input.invocation.turn,
        condition_hash: input.invocation.condition.conditionHash,
        action: input.invocation.call.action,
        arguments: commitSensitiveTranscriptValues(input.invocation.call.arguments, input.sensitiveValueSecret),
        capability_grant_commitment: kernelTranscriptGrantCommitment(input.invocation.call.capability_grant),
      },
      pre_state: pre,
      post_state: post,
      world_delta: worldDelta(before, after),
      durable_memory_delta: memoryDelta,
      outcome,
    },
    previous_entry_sha256: prior.entry_sha256,
  });
  const previousPublic = privateState.publicEntries.at(-1);
  if (!previousPublic) throw new Error("kernel transcript public chain is unavailable");
  const publicAppend = publicInvokeEntry(
    entry,
    before,
    privateState.publicWorldShadow,
    privateState.publicDurableMemoryState,
    privateState.sensitiveValueSecret,
    previousPublic.entry_sha256
  );
  const publicByteLength = livePublicEntryBytes(
    publicAppend.entry,
    privateState.limits,
    privateState.publicByteLength,
    entries.length + 1
  );
  const next = Object.freeze({ entries: Object.freeze([...entries, entry]) });
  TRANSCRIPT_PRIVATE.set(next, Object.freeze({
    ...privateState,
    publicEntries: Object.freeze([...privateState.publicEntries, publicAppend.entry]),
    publicByteLength,
    publicWorldShadow: publicAppend.afterShadow,
    durableMemoryState: postDurableMemoryState,
    durableMemoryRevision: postDurableMemoryRevision,
    publicDurableMemoryState: publicAppend.afterDurableMemory,
  }));
  return next;
}

export function appendKernelTranscriptCallerTurn(
  transcript: KernelTranscript,
  input: Readonly<{
    condition: CompiledBenchmarkCondition;
    scenario: BenchmarkScenario;
    turn: number;
    turnId: string;
    world: ToolWorldState;
    preFlowState: FlowExecutionState | null;
    postFlowState: FlowExecutionState | null;
    preCapabilityHead: BenchmarkKernelCapabilityHead;
    postCapabilityHead: BenchmarkKernelCapabilityHead;
    frontierEvidence: AdmissibilityFrontierEvidence;
    capabilitySnapshot: ProviderCapabilitySnapshot;
    durableMemoryState?: ReadonlyMap<string, JsonValue> | null;
  }>
): KernelTranscript {
  const entries = transcript.entries;
  const privateState = TRANSCRIPT_PRIVATE.get(transcript);
  if (!privateState) throw new Error("kernel transcript recorder private state is unavailable");
  const prior = entries.at(-1);
  const initialize = entries[0];
  if (!prior || initialize?.operation !== "initialize") throw new Error("kernel transcript has no initialization entry");
  if (input.condition.conditionHash !== initialize.payload.input.condition.conditionHash) {
    throw new Error("caller-turn condition differs from initialized transcript condition");
  }
  if (input.condition.behavior.transitionOwnership !== "host-managed-linear") {
    throw new Error("caller-turn readiness entries require a host-managed condition");
  }
  assertPositiveInteger(input.turn, "caller-turn ordinal");
  assertSafeId(input.turnId, "caller-turn ID");
  const priorTurns = entries.filter((entry): entry is KernelTranscriptCallerTurnEntry =>
    entry.operation === "caller_turn"
  );
  if (input.turn !== priorTurns.length + 1 || priorTurns.some((entry) => entry.payload.input.turn_id === input.turnId)) {
    throw new Error("caller-turn transcript entries must be contiguous and unique");
  }
  const scenario = BenchmarkScenarioSchema.parse(input.scenario);
  const world = parseBoundToolWorldState(scenario, input.world);
  const durableMemory = canonicalDurableMemoryState(
    input.durableMemoryState,
    input.condition.behavior.genericDurableMemory,
    "caller-turn durable memory"
  );
  if (canonicalJson(durableMemory) !== canonicalJson(privateState.durableMemoryState)) {
    throw new Error("caller-turn durable memory differs from prior transcript state");
  }
  const pre = stateHeads({
    condition: input.condition,
    world,
    flowState: input.preFlowState,
    capabilityHead: input.preCapabilityHead,
    durableMemoryState: durableMemory,
    durableMemoryRevision: privateState.durableMemoryRevision,
  });
  const post = stateHeads({
    condition: input.condition,
    world,
    flowState: input.postFlowState,
    capabilityHead: input.postCapabilityHead,
    durableMemoryState: durableMemory,
    durableMemoryRevision: privateState.durableMemoryRevision,
  });
  if (canonicalJson(pre) !== canonicalJson(prior.payload.post_state)) {
    throw new Error("caller-turn pre-state does not continue the prior transcript state");
  }
  if (post.capability_head.catalog_mode !== "refresh_required") {
    throw new Error("caller-turn boundary must enter refresh-required capability mode");
  }
  const frontierMode = input.preCapabilityHead.target.startsWith("step:")
    ? "target"
    : input.preCapabilityHead.catalog_mode === "terminal"
      ? "terminal"
      : input.preCapabilityHead.catalog_mode === "post_step_transition"
        ? "post_step_transition"
        : "target";
  const expectedFrontier = computeAdmissibilityFrontier({
    condition: input.condition,
    scenario,
    world,
    turn: input.turn,
    target: input.preCapabilityHead.target,
    catalogMode: frontierMode,
  }).evidence;
  if (canonicalJson(expectedFrontier) !== canonicalJson(input.frontierEvidence)) {
    throw new Error("caller-turn admissibility evidence is not derived from authoritative state");
  }
  const snapshot = sanitizeSnapshot(input.capabilitySnapshot);
  assertSnapshotMatchesHead(snapshot, post.capability_head, "caller-turn refresh-required snapshot");
  const entry = appendEntry<KernelTranscriptCallerTurnEntry>({
    schema_version: 1,
    transcript_type: RESTRICTED_TRANSCRIPT_TYPE,
    run_id: initialize.run_id,
    sequence: entries.length,
    operation: "caller_turn",
    payload: {
      input: {
        turn: input.turn,
        turn_id: input.turnId,
        condition_hash: input.condition.conditionHash,
      },
      pre_state: pre,
      post_state: post,
      frontier_evidence: input.frontierEvidence,
      capability_snapshot: snapshot,
    },
    previous_entry_sha256: prior.entry_sha256,
  });
  const previousPublic = privateState.publicEntries.at(-1);
  if (!previousPublic) throw new Error("kernel transcript public chain is unavailable");
  const publicEntry = publicCallerTurnEntry(
    entry,
    privateState.publicWorldShadow,
    privateState.publicDurableMemoryState,
    previousPublic.entry_sha256
  );
  const publicByteLength = livePublicEntryBytes(
    publicEntry,
    privateState.limits,
    privateState.publicByteLength,
    entries.length + 1
  );
  const next = Object.freeze({ entries: Object.freeze([...entries, entry]) });
  TRANSCRIPT_PRIVATE.set(next, Object.freeze({
    ...privateState,
    publicEntries: Object.freeze([...privateState.publicEntries, publicEntry]),
    publicByteLength,
  }));
  return next;
}

export function encodeKernelTranscript(transcript: KernelTranscript): string {
  const publicTranscript = publicKernelTranscript(transcript);
  return `${publicTranscript.entries.map((entry) => canonicalJson(entry)).join("\n")}\n`;
}

export function publicKernelTranscript(transcript: KernelTranscript): PublicKernelTranscript {
  const privateState = TRANSCRIPT_PRIVATE.get(transcript);
  if (!privateState) throw new Error("public view is unavailable for this restricted transcript recorder");
  return Object.freeze({ view: "public_commitment" as const, entries: privateState.publicEntries });
}

/** Fail closed before signing if the kernel's live Map diverged from the recorder. */
export function assertKernelTranscriptDurableMemoryState(
  transcript: KernelTranscript,
  current: ReadonlyMap<string, JsonValue> | null
): void {
  const privateState = TRANSCRIPT_PRIVATE.get(transcript);
  if (!privateState) throw new Error("kernel transcript recorder private state is unavailable");
  const expectedApplicable = privateState.durableMemoryState !== null;
  const canonical = canonicalDurableMemoryState(
    current,
    expectedApplicable,
    "final durable memory"
  );
  assertDurableMemoryResourceBounds(canonical, privateState.limits, "final durable memory");
  if (canonicalJson(canonical) !== canonicalJson(privateState.durableMemoryState)) {
    throw new Error("kernel final durable memory differs from the transcript recorder state");
  }
}

export function encodeRestrictedKernelTranscript(
  transcript: KernelTranscript,
  acknowledgement: Readonly<{ restrictedExactMayContainSecrets: true }>
): string {
  if (acknowledgement.restrictedExactMayContainSecrets !== true) {
    throw new Error("restricted exact transcript export requires an explicit secret-exposure acknowledgement");
  }
  if (transcript.entries.length < 1) throw new Error("kernel transcript cannot be empty");
  return `${transcript.entries.map((entry) => canonicalJson(entry)).join("\n")}\n`;
}

export function kernelTranscriptReference(transcript: KernelTranscript): KernelTranscriptReference {
  const encoded = encodeKernelTranscript(transcript);
  const publicTranscript = publicKernelTranscript(transcript);
  const head = publicTranscript.entries.at(-1)?.entry_sha256;
  if (!head) throw new Error("kernel transcript cannot be empty");
  return Object.freeze({
    schema_version: 1 as const,
    transcript_type: TRANSCRIPT_TYPE,
    encoding: TRANSCRIPT_ENCODING,
    view: "public_commitment",
    transcript_entry_count: publicTranscript.entries.length,
    transcript_head_sha256: head,
    transcript_sha256: sha256Hex(`${TRANSCRIPT_ARTIFACT_DOMAIN}${encoded}`),
    byte_length: Buffer.byteLength(encoded, "utf8"),
  });
}

function scanJsonResources(value: unknown, limits: KernelTranscriptLimits, label: string): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > limits.maxJsonNodes) throw new Error(`${label} exceeds the JSON node limit`);
    if (current.depth > limits.maxJsonDepth) throw new Error(`${label} exceeds the JSON depth limit`);
    if (typeof current.value === "string" && Buffer.byteLength(current.value, "utf8") > limits.maxStringBytes) {
      throw new Error(`${label} contains an oversized string`);
    }
    if (current.value !== null && typeof current.value === "object") {
      const children = Array.isArray(current.value)
        ? current.value
        : Object.entries(current.value).flatMap(([key, child]) => [key, child]);
      for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function parseWorldHead(input: unknown, label: string): BenchmarkKernelWorldHead {
  exactKeys(input, WORLD_HEAD_KEYS, label);
  for (const key of ["state_sha256", "facts_sha256", "event_ledger_sha256", "latest_event_sha256"] as const) {
    assertSha(input[key], `${label}.${key}`);
  }
  for (const key of [
    "event_count",
    "next_event_sequence",
    "latest_event_sequence",
    "admission_count",
    "receipt_count",
    "effect_count",
  ] as const) assertNonNegativeInteger(input[key], `${label}.${key}`);
  if (typeof input.latest_event_id !== "string" || !input.latest_event_id) throw new Error(`${label}.latest_event_id is invalid`);
  if (typeof input.latest_event_type !== "string" || !input.latest_event_type) throw new Error(`${label}.latest_event_type is invalid`);
  return immutableJson(input) as unknown as BenchmarkKernelWorldHead;
}

function parseCapabilityHead(input: unknown, label: string): BenchmarkKernelCapabilityHead {
  exactKeys(input, CAPABILITY_HEAD_KEYS, label);
  assertNonNegativeInteger(input.epoch, `${label}.epoch`);
  assertNonNegativeInteger(input.action_count, `${label}.action_count`);
  if (typeof input.target !== "string" || !input.target) throw new Error(`${label}.target is invalid`);
  if (
    input.catalog_mode !== "target"
    && input.catalog_mode !== "post_step_transition"
    && input.catalog_mode !== "terminal"
    && input.catalog_mode !== "refresh_required"
  ) {
    throw new Error(`${label}.catalog_mode is invalid`);
  }
  if (typeof input.provider_grant_scope !== "string" || !input.provider_grant_scope) {
    throw new Error(`${label}.provider_grant_scope is invalid`);
  }
  if (input.internal_flow_scope !== null && (typeof input.internal_flow_scope !== "string" || !input.internal_flow_scope)) {
    throw new Error(`${label}.internal_flow_scope is invalid`);
  }
  if (!Array.isArray(input.catalog) || input.catalog.length > 10_000) throw new Error(`${label}.catalog is invalid`);
  for (const [index, action] of input.catalog.entries()) {
    exactKeys(action, CAPABILITY_ACTION_KEYS, `${label}.catalog[${index}]`);
    if (typeof action.name !== "string" || !action.name) throw new Error(`${label}.catalog[${index}].name is invalid`);
    assertSha(action.semantic_hash, `${label}.catalog[${index}].semantic_hash`);
  }
  const catalog = input.catalog as Array<Readonly<{ name: string; semantic_hash: string }>>;
  if (new Set(catalog.map((action) => action.name)).size !== catalog.length) {
    throw new Error(`${label}.catalog contains duplicate actions`);
  }
  const sorted = [...catalog].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (canonicalJson(sorted) !== canonicalJson(catalog)) {
    throw new Error(`${label}.catalog must use canonical action-name order`);
  }
  if (input.action_count !== catalog.length) throw new Error(`${label}.action_count differs from its catalog`);
  assertSha(input.catalog_sha256, `${label}.catalog_sha256`);
  if (input.catalog_sha256 !== domainHash(CAPABILITY_CATALOG_DOMAIN, catalog)) {
    throw new Error(`${label}.catalog_sha256 mismatch`);
  }
  return immutableJson(input) as unknown as BenchmarkKernelCapabilityHead;
}

function parseDurableMemoryState(
  input: unknown,
  label: string
): KernelTranscriptDurableMemoryState | null {
  if (input === null) return null;
  if (!Array.isArray(input) || input.length > 100_000) throw new Error(`${label} is invalid`);
  const entries = input.map((entry, index) => {
    exactKeys(entry, DURABLE_MEMORY_ENTRY_KEYS, `${label}[${index}]`);
    if (typeof entry.key !== "string" || entry.key.length < 1 || entry.key.length > 256) {
      throw new Error(`${label}[${index}].key is invalid`);
    }
    return Object.freeze({
      key: entry.key,
      value: immutableJson(JsonValueSchema.parse(entry.value)) as JsonValue,
    });
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].key >= entries[index].key) {
      throw new Error(`${label} keys must be unique and canonically sorted`);
    }
  }
  return immutableJson(entries) as unknown as KernelTranscriptDurableMemoryState;
}

function parseDurableMemoryHead(input: unknown, label: string): KernelTranscriptDurableMemoryHead {
  exactKeys(input, DURABLE_MEMORY_HEAD_KEYS, label);
  assertNonNegativeInteger(input.revision, `${label}.revision`);
  assertNonNegativeInteger(input.entry_count, `${label}.entry_count`);
  if (input.applicability === "not_applicable") {
    if (input.revision !== 0 || input.entry_count !== 0 || input.state_sha256 !== null) {
      throw new Error(`${label} has an invalid not-applicable state`);
    }
  } else if (input.applicability === "durable_memory_enabled") {
    assertSha(input.state_sha256, `${label}.state_sha256`);
  } else {
    throw new Error(`${label}.applicability is invalid`);
  }
  return immutableJson(input) as unknown as KernelTranscriptDurableMemoryHead;
}

function parseDurableMemoryDelta(input: unknown, label: string): KernelTranscriptDurableMemoryDelta {
  exactKeys(input, DURABLE_MEMORY_DELTA_KEYS, label);
  if (input.operation === "none") {
    if (input.key !== null || input.value !== null) throw new Error(`${label} none delta must be empty`);
  } else if (input.operation === "delete") {
    if (typeof input.key !== "string" || input.key.length < 1 || input.key.length > 256 || input.value !== null) {
      throw new Error(`${label} delete delta is invalid`);
    }
  } else if (input.operation === "set") {
    if (typeof input.key !== "string" || input.key.length < 1 || input.key.length > 256) {
      throw new Error(`${label} set delta key is invalid`);
    }
    JsonValueSchema.parse(input.value);
  } else {
    throw new Error(`${label}.operation is invalid`);
  }
  return immutableJson(input) as unknown as KernelTranscriptDurableMemoryDelta;
}

function parseStateHeads(input: unknown, label: string): KernelTranscriptStateHeads {
  exactKeys(input, STATE_HEAD_KEYS, label);
  if (input.flow_state_sha256 !== null) assertSha(input.flow_state_sha256, `${label}.flow_state_sha256`);
  return Object.freeze({
    world_head: parseWorldHead(input.world_head, `${label}.world_head`),
    flow_state_sha256: input.flow_state_sha256 as string | null,
    capability_head: parseCapabilityHead(input.capability_head, `${label}.capability_head`),
    durable_memory_head: parseDurableMemoryHead(input.durable_memory_head, `${label}.durable_memory_head`),
  });
}

function parseSnapshot(input: unknown, label: string): KernelTranscriptCapabilitySnapshot {
  exactKeys(input, SNAPSHOT_KEYS, label);
  if (input.gateway_version !== 1) throw new Error(`${label}.gateway_version is invalid`);
  if (typeof input.scope !== "string" || !input.scope) throw new Error(`${label}.scope is invalid`);
  assertNonNegativeInteger(input.capability_epoch, `${label}.capability_epoch`);
  if (!Array.isArray(input.actions) || input.actions.length > 10_000) throw new Error(`${label}.actions is invalid`);
  const actions = input.actions.map((action, index) => {
    exactKeys(action, SNAPSHOT_ACTION_KEYS, `${label}.actions[${index}]`);
    if (typeof action.name !== "string" || !action.name) throw new Error(`${label}.actions[${index}].name is invalid`);
    if (typeof action.description !== "string" || !action.description) throw new Error(`${label}.actions[${index}].description is invalid`);
    if (action.input_schema === null || typeof action.input_schema !== "object" || Array.isArray(action.input_schema)) {
      throw new Error(`${label}.actions[${index}].input_schema is invalid`);
    }
    assertSha(action.semantic_hash, `${label}.actions[${index}].semantic_hash`);
    assertSha(action.capability_grant_commitment, `${label}.actions[${index}].capability_grant_commitment`);
    return immutableJson(action) as unknown as KernelTranscriptCapabilityAction;
  });
  if (new Set(actions.map((action) => action.name)).size !== actions.length) throw new Error(`${label} contains duplicate actions`);
  return immutableJson({
    gateway_version: 1,
    scope: input.scope,
    capability_epoch: input.capability_epoch,
    actions,
  }) as unknown as KernelTranscriptCapabilitySnapshot;
}

function parseWorldDelta(input: unknown, label: string): KernelTranscriptWorldDelta {
  exactKeys(input, WORLD_DELTA_KEYS, label);
  if (input.facts === null || typeof input.facts !== "object" || Array.isArray(input.facts)) throw new Error(`${label}.facts is invalid`);
  if (input.attempts === null || typeof input.attempts !== "object" || Array.isArray(input.attempts)) throw new Error(`${label}.attempts is invalid`);
  for (const [tool, count] of Object.entries(input.attempts)) assertNonNegativeInteger(count, `${label}.attempts.${tool}`);
  for (const key of ["admissions_append", "receipts_append", "effects_append", "events_append"] as const) {
    if (!Array.isArray(input[key])) throw new Error(`${label}.${key} is invalid`);
  }
  assertPositiveInteger(input.next_event_sequence, `${label}.next_event_sequence`);
  return immutableJson(input) as unknown as KernelTranscriptWorldDelta;
}

function parseEntry(input: unknown, index: number): KernelTranscriptEntry {
  exactKeys(input, ENTRY_KEYS, `entry[${index}]`);
  if (input.schema_version !== 1 || input.transcript_type !== RESTRICTED_TRANSCRIPT_TYPE) throw new Error(`entry[${index}] has an unsupported schema`);
  assertSafeId(input.run_id, `entry[${index}].run_id`);
  assertNonNegativeInteger(input.sequence, `entry[${index}].sequence`);
  if (input.sequence !== index) throw new Error(`entry[${index}] has a non-contiguous sequence`);
  if (input.previous_entry_sha256 !== null) assertSha(input.previous_entry_sha256, `entry[${index}].previous_entry_sha256`);
  assertSha(input.entry_sha256, `entry[${index}].entry_sha256`);
  if (input.operation === "initialize") {
    if (index !== 0 || input.previous_entry_sha256 !== null) throw new Error("initialize must be the first transcript entry");
    exactKeys(input.payload, INITIALIZE_PAYLOAD_KEYS, "initialize payload");
    if (input.payload.data_classification !== "synthetic_benchmark_only") throw new Error("initialize data classification is invalid");
    exactKeys(input.payload.input, INITIALIZE_INPUT_KEYS, "initialize input");
    const condition = immutableJson(input.payload.input.condition) as unknown as CompiledBenchmarkCondition;
    assertCompiledConditionIntegrity(condition);
    const scenario = BenchmarkScenarioSchema.parse(input.payload.input.scenario);
    if (canonicalJson(scenario) !== canonicalJson(input.payload.input.scenario)) throw new Error("initialize scenario is noncanonical");
    const world = parseBoundToolWorldState(scenario, input.payload.input.world);
    if (canonicalJson(world) !== canonicalJson(input.payload.input.world)) throw new Error("initialize world is noncanonical");
    const durableMemory = parseDurableMemoryState(
      input.payload.input.durable_memory,
      "initialize durable memory"
    );
    if (condition.behavior.genericDurableMemory !== (durableMemory !== null)) {
      throw new Error("initialize durable memory applicability differs from the compiled condition");
    }
    const payload: KernelTranscriptInitializePayload = Object.freeze({
      data_classification: "synthetic_benchmark_only",
      input: Object.freeze({ condition, scenario, world, durable_memory: durableMemory }),
      post_state: parseStateHeads(input.payload.post_state, "initialize post_state"),
      provider_visible_capability_snapshot: parseSnapshot(
        input.payload.provider_visible_capability_snapshot,
        "initialize provider_visible_capability_snapshot"
      ),
    });
    return immutableJson({ ...input, operation: "initialize", payload }) as unknown as KernelTranscriptInitializeEntry;
  }
  if (input.operation === "caller_turn") {
    if (index === 0) throw new Error("caller_turn cannot initialize a transcript");
    exactKeys(input.payload, CALLER_TURN_PAYLOAD_KEYS, `entry[${index}] caller_turn payload`);
    exactKeys(input.payload.input, CALLER_TURN_INPUT_KEYS, `entry[${index}] caller_turn input`);
    assertPositiveInteger(input.payload.input.turn, `entry[${index}] caller turn`);
    assertSafeId(input.payload.input.turn_id, `entry[${index}] caller turn_id`);
    assertSha(input.payload.input.condition_hash, `entry[${index}] caller condition_hash`);
    const payload: KernelTranscriptCallerTurnPayload = Object.freeze({
      input: Object.freeze({
        turn: input.payload.input.turn,
        turn_id: input.payload.input.turn_id,
        condition_hash: input.payload.input.condition_hash,
      }),
      pre_state: parseStateHeads(input.payload.pre_state, `entry[${index}] caller pre_state`),
      post_state: parseStateHeads(input.payload.post_state, `entry[${index}] caller post_state`),
      frontier_evidence: immutableJson(JsonValueSchema.parse(input.payload.frontier_evidence)) as unknown as AdmissibilityFrontierEvidence,
      capability_snapshot: parseSnapshot(input.payload.capability_snapshot, `entry[${index}] caller capability_snapshot`),
    });
    return immutableJson({ ...input, operation: "caller_turn", payload }) as unknown as KernelTranscriptCallerTurnEntry;
  }
  if (input.operation !== "invoke" || index === 0) throw new Error(`entry[${index}].operation is invalid`);
  exactKeys(input.payload, INVOKE_PAYLOAD_KEYS, `entry[${index}] payload`);
  exactKeys(input.payload.input, INVOKE_INPUT_KEYS, `entry[${index}] input`);
  assertSafeId(input.payload.input.provider_call_id, `entry[${index}] provider_call_id`);
  assertNonNegativeInteger(input.payload.input.turn, `entry[${index}] turn`);
  assertSha(input.payload.input.condition_hash, `entry[${index}] condition_hash`);
  if (typeof input.payload.input.action !== "string" || !input.payload.input.action) throw new Error(`entry[${index}] action is invalid`);
  assertSha(input.payload.input.capability_grant_commitment, `entry[${index}] grant commitment`);
  const args = JsonValueSchema.parse(input.payload.input.arguments);
  exactKeys(input.payload.outcome, OUTCOME_KEYS, `entry[${index}] outcome`);
  const result = CapabilityGatewayResultSchema.parse(input.payload.outcome.authoritative_result);
  const providerVisible = JsonValueSchema.parse(input.payload.outcome.provider_visible_output);
  const snapshot = input.payload.outcome.capability_snapshot === null
    ? null
    : parseSnapshot(input.payload.outcome.capability_snapshot, `entry[${index}] outcome capability_snapshot`);
  let disclosure: KernelTranscriptInvokePayload["outcome"]["disclosure"] = null;
  if (input.payload.outcome.disclosure !== null) {
    exactKeys(input.payload.outcome.disclosure, DISCLOSURE_KEYS, `entry[${index}] outcome disclosure`);
    if (typeof input.payload.outcome.disclosure.target !== "string" || !input.payload.outcome.disclosure.target) {
      throw new Error(`entry[${index}] outcome disclosure target is invalid`);
    }
    disclosure = Object.freeze({
      target: input.payload.outcome.disclosure.target as CompiledDisclosure["target"],
      snapshot: parseSnapshot(input.payload.outcome.disclosure.snapshot, `entry[${index}] outcome disclosure snapshot`),
    });
  }
  const payload: KernelTranscriptInvokePayload = Object.freeze({
    input: Object.freeze({
      provider_call_id: input.payload.input.provider_call_id,
      turn: input.payload.input.turn,
      condition_hash: input.payload.input.condition_hash,
      action: input.payload.input.action,
      arguments: args,
      capability_grant_commitment: input.payload.input.capability_grant_commitment,
    }),
    pre_state: parseStateHeads(input.payload.pre_state, `entry[${index}] pre_state`),
    post_state: parseStateHeads(input.payload.post_state, `entry[${index}] post_state`),
    world_delta: parseWorldDelta(input.payload.world_delta, `entry[${index}] world_delta`),
    durable_memory_delta: parseDurableMemoryDelta(
      input.payload.durable_memory_delta,
      `entry[${index}] durable_memory_delta`
    ),
    outcome: Object.freeze({
      authoritative_result: result,
      provider_visible_output: providerVisible,
      capability_snapshot: snapshot,
      disclosure,
    }),
  });
  return immutableJson({ ...input, operation: "invoke", payload }) as unknown as KernelTranscriptInvokeEntry;
}

export function parseRestrictedKernelTranscript(
  encoded: string,
  limits: KernelTranscriptLimits = DEFAULT_KERNEL_TRANSCRIPT_LIMITS
): KernelTranscript {
  if (typeof encoded !== "string") throw new Error("kernel transcript must be UTF-8 text");
  const byteLength = Buffer.byteLength(encoded, "utf8");
  if (byteLength < 2 || byteLength > limits.maxBytes) throw new Error("kernel transcript exceeds its byte bounds");
  if (!encoded.endsWith("\n") || encoded.includes("\r") || encoded.startsWith("\ufeff")) {
    throw new Error("kernel transcript must be LF-terminated canonical JSONL without BOM or CR characters");
  }
  const lines = encoded.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.length > limits.maxEntries) throw new Error("kernel transcript exceeds its entry bounds");
  const entries: KernelTranscriptEntry[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line || Buffer.byteLength(line, "utf8") > limits.maxLineBytes) {
      throw new Error(`kernel transcript line ${index + 1} exceeds its bounds`);
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      throw new Error(`kernel transcript line ${index + 1} is not valid JSON`);
    }
    scanJsonResources(candidate, limits, `kernel transcript line ${index + 1}`);
    if (canonicalJson(candidate) !== line) {
      throw new Error(`kernel transcript line ${index + 1} is not canonical JSON`);
    }
    entries.push(parseEntry(candidate, index));
  }
  return Object.freeze({ entries: Object.freeze(entries) });
}

function emptyRestrictedVerification(errors: readonly string[]): RestrictedKernelTranscriptVerification {
  return Object.freeze({
    valid: false,
    authenticity: "unverified_invalid" as const,
    errors: Object.freeze([...errors]),
    reference: null,
    run_id: null,
    reconstructed: Object.freeze({
      world_head: null,
      capability_head: null,
      flow_state_sha256: null,
      final_world: null,
      durable_memory_head: null,
      final_durable_memory: null,
    }),
    reconstruction_coverage: Object.freeze({
      world_head: "reconstructed_from_initial_state_and_deltas" as const,
      capability_head: "reconstructed_from_compiled_condition_and_public_catalog" as const,
      flow_proof: "hash_chain_only_requires_final_attestation_state" as const,
      provider_behavior: "input_output_bound_not_model_reexecuted" as const,
      durable_memory: "reconstructed_when_applicable_from_initial_state_and_deltas" as const,
    }),
  });
}

function compare(label: string, actual: unknown, expected: unknown, errors: string[]): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) errors.push(`${label} mismatch`);
}

function verifyFlowProofAgainstHead(
  attestation: BenchmarkKernelFinalAttestation,
  finalFlowHead: string | null,
  errors: string[]
): void {
  const proof = attestation.flow_proof;
  if (proof.execution_state === null) {
    if (finalFlowHead !== null || proof.applicability !== "not_applicable_unenforced") {
      errors.push("final Flow proof does not match the transcript Flow head");
    }
    return;
  }
  const stateHash = domainHash(FLOW_STATE_DOMAIN, proof.execution_state);
  if (stateHash !== finalFlowHead || proof.execution_state_sha256 !== stateHash) {
    errors.push("final Flow execution-state hash mismatch");
  }
  if (proof.checkpoint_ledger_sha256 !== domainHash(FLOW_CHECKPOINTS_DOMAIN, proof.execution_state.checkpoints)) {
    errors.push("final Flow checkpoint-ledger hash mismatch");
  }
  if (proof.action_receipt_ledger_sha256 !== domainHash(FLOW_RECEIPTS_DOMAIN, proof.execution_state.actionReceipts)) {
    errors.push("final Flow receipt-ledger hash mismatch");
  }
  if (
    proof.checkpoint_count !== proof.execution_state.checkpoints.length
    || proof.action_receipt_count !== proof.execution_state.actionReceipts.length
  ) {
    errors.push("final Flow proof count mismatch");
  }
}

export function verifyRestrictedKernelTranscript(input: Readonly<{
  transcript: string | KernelTranscript;
  finalAttestation?: TranscriptBoundKernelAttestation;
  attestationExpectation?: BenchmarkKernelAttestationExpectation;
  limits?: KernelTranscriptLimits;
  acknowledgeRestrictedExactMayContainSecrets: true;
}>): RestrictedKernelTranscriptVerification {
  let transcript: KernelTranscript;
  try {
    transcript = typeof input.transcript === "string"
      ? parseRestrictedKernelTranscript(input.transcript, input.limits)
      : parseRestrictedKernelTranscript(encodeRestrictedKernelTranscript(input.transcript, {
        restrictedExactMayContainSecrets: true,
      }), input.limits);
  } catch (error) {
    return emptyRestrictedVerification([error instanceof Error ? error.message : "restricted kernel transcript parse failed"]);
  }
  const errors: string[] = [];
  const initialize = transcript.entries[0];
  if (initialize.operation !== "initialize") return emptyRestrictedVerification(["kernel transcript does not begin with initialize"]);
  const runId = initialize.run_id;
  const condition = initialize.payload.input.condition;
  const scenario = initialize.payload.input.scenario;
  let world = initialize.payload.input.world;
  let durableMemory = initialize.payload.input.durable_memory;
  let heads = initialize.payload.post_state;
  try {
    const expectedWorld = createKernelTranscriptWorldHead(world);
    compare("initialize world head", heads.world_head, expectedWorld, errors);
    const expectedCapability = validateCapabilityHead(condition, heads.capability_head);
    compare("initialize capability head", heads.capability_head, expectedCapability, errors);
    compare("initialize durable memory head", heads.durable_memory_head, durableMemoryHead(durableMemory, 0), errors);
    assertSnapshotMatchesHead(
      initialize.payload.provider_visible_capability_snapshot,
      heads.capability_head,
      "initial provider-visible snapshot"
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "initialize replay failed");
  }
  const callFingerprints = new Map<string, string>();
  let committedTurn = 0;
  const committedTurnIds = new Set<string>();
  for (const [index, entry] of transcript.entries.entries()) {
    const expectedPrevious = index === 0 ? null : transcript.entries[index - 1].entry_sha256;
    if (entry.run_id !== runId) errors.push(`entry ${index} changed run_id`);
    if (entry.previous_entry_sha256 !== expectedPrevious) errors.push(`entry ${index} previous hash mismatch`);
    if (domainHash(TRANSCRIPT_ENTRY_DOMAIN, entryBody(entry)) !== entry.entry_sha256) {
      errors.push(`entry ${index} hash mismatch`);
    }
    if (entry.operation === "caller_turn") {
      try {
        if (entry.payload.input.condition_hash !== condition.conditionHash) {
          errors.push(`entry ${index} caller condition hash mismatch`);
        }
        if (
          entry.payload.input.turn !== committedTurn + 1
          || committedTurnIds.has(entry.payload.input.turn_id)
        ) errors.push(`entry ${index} caller turn is non-contiguous or repeated`);
        compare(`entry ${index} caller pre-state`, entry.payload.pre_state, heads, errors);
        const mode = heads.capability_head.target.startsWith("step:")
          ? "target"
          : heads.capability_head.catalog_mode === "terminal"
            ? "terminal"
            : heads.capability_head.catalog_mode === "post_step_transition"
              ? "post_step_transition"
              : "target";
        const expectedFrontier = computeAdmissibilityFrontier({
          condition,
          scenario,
          world,
          turn: entry.payload.input.turn,
          target: heads.capability_head.target,
          catalogMode: mode,
        }).evidence;
        compare(`entry ${index} caller frontier evidence`, entry.payload.frontier_evidence, expectedFrontier, errors);
        compare(`entry ${index} caller world head`, entry.payload.post_state.world_head, heads.world_head, errors);
        compare(
          `entry ${index} caller durable memory head`,
          entry.payload.post_state.durable_memory_head,
          heads.durable_memory_head,
          errors
        );
        if (
          entry.payload.post_state.capability_head.catalog_mode !== "refresh_required"
          || entry.payload.post_state.capability_head.epoch !== heads.capability_head.epoch + 1
        ) errors.push(`entry ${index} caller refresh-required epoch mismatch`);
        assertSnapshotMatchesHead(
          entry.payload.capability_snapshot,
          entry.payload.post_state.capability_head,
          `entry ${index} caller capability snapshot`
        );
        committedTurn = entry.payload.input.turn;
        committedTurnIds.add(entry.payload.input.turn_id);
        heads = entry.payload.post_state;
      } catch (error) {
        errors.push(error instanceof Error ? `entry ${index}: ${error.message}` : `entry ${index} caller replay failed`);
      }
      continue;
    }
    if (entry.operation !== "invoke") continue;
    try {
      if (
        condition.behavior.transitionOwnership === "host-managed-linear"
        && committedTurn > 0
        && entry.payload.input.turn !== committedTurn
      ) errors.push(`entry ${index} invocation is not bound to the committed caller turn`);
      if (entry.payload.input.condition_hash !== condition.conditionHash) {
        errors.push(`entry ${index} condition hash mismatch`);
      }
      compare(`entry ${index} pre-state`, entry.payload.pre_state, heads, errors);
      const nextWorld = applyWorldDelta(world, entry.payload.world_delta);
      const nextWorldHead = createKernelTranscriptWorldHead(nextWorld);
      compare(`entry ${index} post world head`, entry.payload.post_state.world_head, nextWorldHead, errors);
      const memoryDelta = entry.payload.durable_memory_delta;
      if (memoryDelta.operation !== "none") {
        const memoryArguments = entry.payload.input.arguments !== null
          && typeof entry.payload.input.arguments === "object"
          && !Array.isArray(entry.payload.input.arguments)
          ? entry.payload.input.arguments
          : null;
        if (
          entry.payload.input.action !== "durable_memory"
          || !entry.payload.outcome.authoritative_result.ok
          || entry.payload.outcome.authoritative_result.disposition !== "executed"
          || entry.payload.outcome.authoritative_result.action !== "durable_memory"
          || memoryArguments === null
          || memoryArguments.key !== memoryDelta.key
          || (memoryDelta.operation === "set" && (
            memoryArguments.operation !== "write"
            || !("value" in memoryArguments)
            || canonicalJson(memoryArguments.value) !== canonicalJson(memoryDelta.value)
          ))
          || (memoryDelta.operation === "delete" && memoryArguments.operation !== "delete")
        ) {
          errors.push(`entry ${index} durable memory mutation differs from its executed durable_memory success`);
        }
      }
      const nextDurableMemory = applyDurableMemoryDelta(durableMemory, memoryDelta);
      const nextMemoryRevision = heads.durable_memory_head.revision
        + (memoryDelta.operation === "none" ? 0 : 1);
      compare(
        `entry ${index} post durable memory head`,
        entry.payload.post_state.durable_memory_head,
        durableMemoryHead(nextDurableMemory, nextMemoryRevision),
        errors
      );
      const nextCapability = validateCapabilityHead(condition, entry.payload.post_state.capability_head);
      compare(`entry ${index} post capability head`, entry.payload.post_state.capability_head, nextCapability, errors);
      if (
        condition.behavior.transitionOwnership === "host-managed-linear"
        && nextCapability.target.startsWith("step:")
        && nextCapability.catalog_mode === "target"
      ) {
        const expected = computeAdmissibilityFrontier({
          condition,
          scenario,
          world: nextWorld,
          turn: committedTurn,
          target: nextCapability.target,
          catalogMode: "target",
        }).capabilities.map((capability) => ({
          name: capability.name,
          semantic_hash: capability.semanticHash,
        })).sort((left, right) => left.name.localeCompare(right.name));
        compare(`entry ${index} admissibility catalog`, nextCapability.catalog, expected, errors);
      }
      if (entry.payload.outcome.capability_snapshot) {
        assertSnapshotMatchesHead(
          entry.payload.outcome.capability_snapshot,
          entry.payload.post_state.capability_head,
          `entry ${index} rotated snapshot`
        );
      } else {
        compare(
          `entry ${index} capability head without rotation`,
          entry.payload.post_state.capability_head,
          entry.payload.pre_state.capability_head,
          errors
        );
      }
      const disclosure = entry.payload.outcome.disclosure;
      if (disclosure) {
        if (!entry.payload.outcome.capability_snapshot) errors.push(`entry ${index} disclosure has no rotation`);
        if (disclosure.target !== entry.payload.post_state.capability_head.target) {
          errors.push(`entry ${index} disclosure target mismatch`);
        }
        compare(`entry ${index} disclosure snapshot`, disclosure.snapshot, entry.payload.outcome.capability_snapshot, errors);
      }
      const callFingerprint = domainHash("harshas-amazing-call-center/benchmark-provider-call/v1\n", {
        action: entry.payload.input.action,
        arguments: entry.payload.input.arguments,
      });
      const priorFingerprint = callFingerprints.get(entry.payload.input.provider_call_id);
      if (priorFingerprint && priorFingerprint !== callFingerprint) {
        const result = entry.payload.outcome.authoritative_result;
        if (result.ok || result.code !== "provider_call_id_conflict") {
          errors.push(`entry ${index} conflicting provider call ID was not rejected`);
        }
      } else if (!priorFingerprint) {
        callFingerprints.set(entry.payload.input.provider_call_id, callFingerprint);
      }
      world = nextWorld;
      durableMemory = nextDurableMemory;
      heads = entry.payload.post_state;
    } catch (error) {
      errors.push(error instanceof Error ? `entry ${index}: ${error.message}` : `entry ${index} replay failed`);
    }
  }
  try {
    world = parseBoundToolWorldState(scenario, world);
  } catch (error) {
    errors.push(error instanceof Error ? `final world replay failed: ${error.message}` : "final world replay failed");
  }
  const reference = null;
  let authenticity: RestrictedKernelTranscriptVerification["authenticity"] = "unsigned_self_consistency";
  if (input.finalAttestation) {
    authenticity = "signed_attestation_invalid";
    if (!input.attestationExpectation) {
      errors.push("a transcript-bound final attestation requires pinned evidence and Ed25519 trust expectations");
    } else {
      const verification = verifyBenchmarkKernelFinalAttestation(
        input.finalAttestation,
        input.attestationExpectation
      );
      if (!verification.valid || !verification.signature_verified) {
        errors.push(...verification.errors.map((error) => `final attestation: ${error}`));
        if (verification.errors.length === 0) errors.push("final attestation signature was not verified");
      } else {
        authenticity = "signed_attestation_verified";
      }
    }
    const attestation = input.finalAttestation;
    compare("signed transcript reference", attestation.transcript_reference, reference, errors);
    if (attestation.bindings.run_id !== runId) errors.push("attestation run binding mismatch");
    if (attestation.bindings.condition_hash !== condition.conditionHash) errors.push("attestation condition binding mismatch");
    if (attestation.bindings.scenario_id !== scenario.id || attestation.bindings.scenario_version !== scenario.version) {
      errors.push("attestation scenario identity mismatch");
    }
    compare("attestation world head", attestation.world_head, heads.world_head, errors);
    compare("attestation capability head", attestation.capability_head, heads.capability_head, errors);
    verifyFlowProofAgainstHead(attestation, heads.flow_state_sha256, errors);
  } else if (input.attestationExpectation) {
    errors.push("attestation expectations were supplied without a final attestation");
  }
  return Object.freeze({
    valid: errors.length === 0,
    authenticity,
    errors: Object.freeze(errors),
    reference,
    run_id: runId,
    reconstructed: Object.freeze({
      world_head: heads.world_head,
      capability_head: heads.capability_head,
      flow_state_sha256: heads.flow_state_sha256,
      final_world: immutableJson(world) as unknown as ToolWorldState,
      durable_memory_head: heads.durable_memory_head,
      final_durable_memory: durableMemory === null
        ? null
        : immutableJson(durableMemory) as unknown as KernelTranscriptDurableMemoryState,
    }),
    reconstruction_coverage: Object.freeze({
      world_head: "reconstructed_from_initial_state_and_deltas" as const,
      capability_head: "reconstructed_from_compiled_condition_and_public_catalog" as const,
      flow_proof: "hash_chain_only_requires_final_attestation_state" as const,
      provider_behavior: "input_output_bound_not_model_reexecuted" as const,
      durable_memory: "reconstructed_when_applicable_from_initial_state_and_deltas" as const,
    }),
  });
}

const PUBLIC_INITIALIZE_PAYLOAD_KEYS = Object.freeze([
  "bindings",
  "data_classification",
  "post_state",
  "provider_visible_capability_snapshot",
  "public_initial_durable_memory",
  "public_initial_world",
  "view",
].sort());
const PUBLIC_BINDING_KEYS = Object.freeze([
  "condition_hash",
  "condition_id",
  "durable_memory_applicability",
  "flow_hash",
  "scenario_hash",
  "scenario_id",
  "scenario_version",
  "source_hash",
].sort());
const PUBLIC_INVOKE_PAYLOAD_KEYS = Object.freeze([
  "input", "outcome", "post_state", "pre_state", "public_durable_memory_delta", "public_world_delta",
].sort());
const PUBLIC_INPUT_KEYS = Object.freeze([
  "action",
  "arguments_hmac_sha256",
  "capability_grant_commitment",
  "condition_hash",
  "provider_call_fingerprint_hmac_sha256",
  "provider_call_id",
  "turn",
].sort());
const PUBLIC_OUTCOME_KEYS = Object.freeze([
  "authoritative_result_hmac_sha256",
  "capability_snapshot",
  "disclosure",
  "failure_code",
  "provider_visible_output_hmac_sha256",
  "result_class",
].sort());
const PUBLIC_STATE_HEAD_KEYS = Object.freeze([
  "authoritative_world_head",
  "capability_head",
  "durable_memory_head",
  "flow_state_sha256",
  "public_shadow_world_sha256",
].sort());
const PUBLIC_SNAPSHOT_ACTION_KEYS = Object.freeze([
  "capability_grant_commitment", "name", "semantic_hash",
].sort());
const COMMITTED_LEAF_KEYS = Object.freeze([
  "commitment_type", "value_hmac_sha256", "value_type",
].sort());

function assertCommittedShadow(value: unknown, label: string): asserts value is JsonValue {
  const stack: Array<{ value: unknown; label: string }> = [{ value, label }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.value === null || typeof current.value !== "object") {
      throw new Error(`${current.label} contains an uncommitted scalar`);
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((child, index) => stack.push({ value: child, label: `${current.label}[${index}]` }));
      continue;
    }
    const candidate = current.value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(candidate, "commitment_type")) {
      exactKeys(candidate, COMMITTED_LEAF_KEYS, current.label);
      if (candidate.commitment_type !== "hmac-sha256") throw new Error(`${current.label} has an invalid commitment type`);
      if (!["array", "boolean", "null", "number", "object", "string"].includes(candidate.value_type as string)) {
        throw new Error(`${current.label} has an invalid committed value type`);
      }
      assertSha(candidate.value_hmac_sha256, `${current.label}.value_hmac_sha256`);
      continue;
    }
    for (const [key, child] of Object.entries(candidate)) {
      stack.push({ value: child, label: `${current.label}.${key}` });
    }
  }
}

function parsePublicDurableMemoryState(
  input: unknown,
  label: string
): PublicKernelTranscriptDurableMemoryState | null {
  if (input === null) return null;
  if (!Array.isArray(input) || input.length > 100_000) throw new Error(`${label} is invalid`);
  const entries = input.map((entry, index) => {
    exactKeys(entry, PUBLIC_DURABLE_MEMORY_ENTRY_KEYS, `${label}[${index}]`);
    assertSha(entry.key_hmac_sha256, `${label}[${index}].key_hmac_sha256`);
    assertSha(entry.value_hmac_sha256, `${label}[${index}].value_hmac_sha256`);
    return Object.freeze({
      key_hmac_sha256: entry.key_hmac_sha256,
      value_hmac_sha256: entry.value_hmac_sha256,
    });
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].key_hmac_sha256 >= entries[index].key_hmac_sha256) {
      throw new Error(`${label} key commitments must be unique and canonically sorted`);
    }
  }
  return immutableJson(entries) as unknown as PublicKernelTranscriptDurableMemoryState;
}

function parsePublicDurableMemoryHead(
  input: unknown,
  label: string
): PublicKernelTranscriptDurableMemoryHead {
  exactKeys(input, PUBLIC_DURABLE_MEMORY_HEAD_KEYS, label);
  assertNonNegativeInteger(input.revision, `${label}.revision`);
  assertNonNegativeInteger(input.entry_count, `${label}.entry_count`);
  if (input.applicability === "not_applicable") {
    if (input.revision !== 0 || input.entry_count !== 0 || input.public_state_sha256 !== null) {
      throw new Error(`${label} has an invalid not-applicable state`);
    }
  } else if (input.applicability === "durable_memory_enabled") {
    assertSha(input.public_state_sha256, `${label}.public_state_sha256`);
  } else {
    throw new Error(`${label}.applicability is invalid`);
  }
  return immutableJson(input) as unknown as PublicKernelTranscriptDurableMemoryHead;
}

function parsePublicDurableMemoryDelta(
  input: unknown,
  label: string
): PublicKernelTranscriptDurableMemoryDelta {
  exactKeys(input, PUBLIC_DURABLE_MEMORY_DELTA_KEYS, label);
  if (input.operation === "none") {
    if (input.key_hmac_sha256 !== null || input.value_hmac_sha256 !== null) {
      throw new Error(`${label} none delta must be empty`);
    }
  } else if (input.operation === "delete") {
    assertSha(input.key_hmac_sha256, `${label}.key_hmac_sha256`);
    if (input.value_hmac_sha256 !== null) throw new Error(`${label} delete delta has a value`);
  } else if (input.operation === "set") {
    assertSha(input.key_hmac_sha256, `${label}.key_hmac_sha256`);
    assertSha(input.value_hmac_sha256, `${label}.value_hmac_sha256`);
  } else {
    throw new Error(`${label}.operation is invalid`);
  }
  return immutableJson(input) as unknown as PublicKernelTranscriptDurableMemoryDelta;
}

function parsePublicStateHeads(input: unknown, label: string): PublicKernelTranscriptStateHeads {
  exactKeys(input, PUBLIC_STATE_HEAD_KEYS, label);
  assertSha(input.public_shadow_world_sha256, `${label}.public_shadow_world_sha256`);
  if (input.flow_state_sha256 !== null) assertSha(input.flow_state_sha256, `${label}.flow_state_sha256`);
  return Object.freeze({
    authoritative_world_head: parseWorldHead(input.authoritative_world_head, `${label}.authoritative_world_head`),
    public_shadow_world_sha256: input.public_shadow_world_sha256,
    flow_state_sha256: input.flow_state_sha256 as string | null,
    capability_head: parseCapabilityHead(input.capability_head, `${label}.capability_head`),
    durable_memory_head: parsePublicDurableMemoryHead(
      input.durable_memory_head,
      `${label}.durable_memory_head`
    ),
  });
}

function parsePublicSnapshot(input: unknown, label: string): PublicKernelTranscriptSnapshot {
  exactKeys(input, SNAPSHOT_KEYS, label);
  if (input.gateway_version !== 1) throw new Error(`${label}.gateway_version is invalid`);
  if (typeof input.scope !== "string" || !input.scope) throw new Error(`${label}.scope is invalid`);
  assertNonNegativeInteger(input.capability_epoch, `${label}.capability_epoch`);
  if (!Array.isArray(input.actions) || input.actions.length > 10_000) throw new Error(`${label}.actions is invalid`);
  const actions = input.actions.map((action, index) => {
    exactKeys(action, PUBLIC_SNAPSHOT_ACTION_KEYS, `${label}.actions[${index}]`);
    if (typeof action.name !== "string" || !/^[a-z][a-z0-9_.-]{1,95}$/.test(action.name)) {
      throw new Error(`${label}.actions[${index}].name is invalid`);
    }
    assertSha(action.semantic_hash, `${label}.actions[${index}].semantic_hash`);
    assertSha(action.capability_grant_commitment, `${label}.actions[${index}].capability_grant_commitment`);
    return Object.freeze({
      name: action.name,
      semantic_hash: action.semantic_hash,
      capability_grant_commitment: action.capability_grant_commitment,
    });
  });
  if (new Set(actions.map((action) => action.name)).size !== actions.length) throw new Error(`${label} has duplicate actions`);
  return immutableJson({
    gateway_version: 1,
    scope: input.scope,
    capability_epoch: input.capability_epoch,
    actions,
  }) as unknown as PublicKernelTranscriptSnapshot;
}

function assertPublicSnapshotMatchesHead(
  snapshot: PublicKernelTranscriptSnapshot,
  head: BenchmarkKernelCapabilityHead,
  label: string
): void {
  const catalog = snapshot.actions
    .map((action) => ({ name: action.name, semantic_hash: action.semantic_hash }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (
    snapshot.capability_epoch !== head.epoch
    || snapshot.scope !== head.provider_grant_scope
    || canonicalJson(catalog) !== canonicalJson(head.catalog)
  ) throw new Error(`${label} does not match its public capability head`);
}

function parsePublicEntry(input: unknown, index: number): PublicKernelTranscriptEntry {
  exactKeys(input, ENTRY_KEYS, `public entry[${index}]`);
  if (input.schema_version !== 1 || input.transcript_type !== TRANSCRIPT_TYPE) {
    throw new Error(`public entry[${index}] has an unsupported schema or view`);
  }
  assertSafeId(input.run_id, `public entry[${index}].run_id`);
  assertNonNegativeInteger(input.sequence, `public entry[${index}].sequence`);
  if (input.sequence !== index) throw new Error(`public entry[${index}] has a non-contiguous sequence`);
  if (input.previous_entry_sha256 !== null) assertSha(input.previous_entry_sha256, `public entry[${index}].previous_entry_sha256`);
  assertSha(input.entry_sha256, `public entry[${index}].entry_sha256`);
  if ((index === 0) !== (input.operation === "initialize")) throw new Error(`public entry[${index}] has an invalid operation`);
  if (
    input.operation !== "initialize"
    && input.operation !== "invoke"
    && input.operation !== "caller_turn"
  ) throw new Error(`public entry[${index}] has an invalid operation`);
  const payload = JsonValueSchema.parse(input.payload);
  return immutableJson({ ...input, payload }) as unknown as PublicKernelTranscriptEntry;
}

export function parseKernelTranscript(
  encoded: string,
  limitsInput?: KernelTranscriptLimits
): PublicKernelTranscript {
  const limits = boundedLimits(limitsInput);
  if (typeof encoded !== "string") throw new Error("public kernel transcript must be UTF-8 text");
  const byteLength = Buffer.byteLength(encoded, "utf8");
  if (byteLength < 2 || byteLength > limits.maxBytes) throw new Error("public kernel transcript exceeds its byte bounds");
  if (!encoded.endsWith("\n") || encoded.includes("\r") || encoded.startsWith("\ufeff")) {
    throw new Error("public kernel transcript must be LF-terminated canonical JSONL without BOM or CR characters");
  }
  const lines = encoded.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.length > limits.maxEntries) throw new Error("public kernel transcript exceeds its entry bounds");
  const entries: PublicKernelTranscriptEntry[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line || Buffer.byteLength(line, "utf8") > limits.maxLineBytes) throw new Error(`public transcript line ${index + 1} exceeds its bounds`);
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      throw new Error(`public transcript line ${index + 1} is not valid JSON`);
    }
    scanJsonResources(candidate, limits, `public transcript line ${index + 1}`);
    if (canonicalJson(candidate) !== line) throw new Error(`public transcript line ${index + 1} is not canonical JSON`);
    entries.push(parsePublicEntry(candidate, index));
  }
  return Object.freeze({ view: "public_commitment" as const, entries: Object.freeze(entries) });
}

function encodePublicTranscript(transcript: PublicKernelTranscript): string {
  return `${transcript.entries.map((entry) => canonicalJson(entry)).join("\n")}\n`;
}

function publicTranscriptReference(transcript: PublicKernelTranscript): KernelTranscriptReference {
  const encoded = encodePublicTranscript(transcript);
  const head = transcript.entries.at(-1)?.entry_sha256;
  if (!head) throw new Error("public kernel transcript cannot be empty");
  return Object.freeze({
    schema_version: 1,
    transcript_type: TRANSCRIPT_TYPE,
    encoding: TRANSCRIPT_ENCODING,
    view: "public_commitment",
    transcript_entry_count: transcript.entries.length,
    transcript_head_sha256: head,
    transcript_sha256: sha256Hex(`${TRANSCRIPT_ARTIFACT_DOMAIN}${encoded}`),
    byte_length: Buffer.byteLength(encoded),
  });
}

function emptyPublicVerification(errors: readonly string[]): KernelTranscriptVerification {
  return Object.freeze({
    valid: false,
    authenticity: "unverified_invalid" as const,
    errors: Object.freeze([...errors]),
    reference: null,
    run_id: null,
    reconstructed: Object.freeze({
      authoritative_world_head: null,
      public_shadow_world_sha256: null,
      capability_head: null,
      flow_state_sha256: null,
      final_public_shadow_world: null,
      durable_memory_head: null,
      final_public_durable_memory: null,
      final_world: null,
    }),
    reconstruction_coverage: Object.freeze({
      plaintext_world_head: "signed_authoritative_head_only_not_plaintext_reconstructed" as const,
      public_shadow_world: "reconstructed_from_committed_initial_state_and_deltas" as const,
      capability_head: "validated_from_public_catalog_and_signed_final_head" as const,
      flow_proof: "hash_chain_only_requires_final_signed_attestation_state" as const,
      provider_behavior: "hmac_input_output_bound_not_model_reexecuted" as const,
      durable_memory: "reconstructed_when_applicable_from_hmac_committed_state_and_deltas" as const,
    }),
  });
}

export function verifyKernelTranscript(input: Readonly<{
  transcript: string | PublicKernelTranscript;
  finalAttestation?: TranscriptBoundKernelAttestation;
  attestationExpectation?: BenchmarkKernelAttestationExpectation;
  limits?: KernelTranscriptLimits;
}>): KernelTranscriptVerification {
  let transcript: PublicKernelTranscript;
  try {
    transcript = typeof input.transcript === "string"
      ? parseKernelTranscript(input.transcript, input.limits)
      : parseKernelTranscript(encodePublicTranscript(input.transcript), input.limits);
  } catch (error) {
    return emptyPublicVerification([error instanceof Error ? error.message : "public kernel transcript parse failed"]);
  }
  const errors: string[] = [];
  const initialize = transcript.entries[0];
  if (initialize.operation !== "initialize") return emptyPublicVerification(["public transcript does not begin with initialize"]);
  exactKeys(initialize.payload, PUBLIC_INITIALIZE_PAYLOAD_KEYS, "public initialize payload");
  if (
    initialize.payload.view !== "public_commitment"
    || initialize.payload.data_classification !== "public_commitments_no_plaintext_world"
  ) errors.push("public initialize view or data classification mismatch");
  exactKeys(initialize.payload.bindings, PUBLIC_BINDING_KEYS, "public initialize bindings");
  const bindings = initialize.payload.bindings;
  for (const key of ["condition_hash", "source_hash", "scenario_hash", "flow_hash"] as const) {
    try { assertSha(bindings[key], `public bindings.${key}`); } catch (error) { errors.push((error as Error).message); }
  }
  for (const key of ["condition_id", "scenario_id", "scenario_version"] as const) {
    try { assertSafeId(bindings[key], `public bindings.${key}`); } catch (error) { errors.push((error as Error).message); }
  }
  if (
    bindings.durable_memory_applicability !== "durable_memory_enabled"
    && bindings.durable_memory_applicability !== "not_applicable"
  ) errors.push("public bindings durable memory applicability is invalid");
  let shadow = initialize.payload.public_initial_world as JsonValue;
  try { assertCommittedShadow(shadow, "public initial world"); } catch (error) { errors.push((error as Error).message); }
  let durableMemory: PublicKernelTranscriptDurableMemoryState | null = null;
  try {
    durableMemory = parsePublicDurableMemoryState(
      initialize.payload.public_initial_durable_memory,
      "public initial durable memory"
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "public initial durable memory is invalid");
  }
  let heads = parsePublicStateHeads(initialize.payload.post_state, "public initialize post_state");
  const initialSnapshot = parsePublicSnapshot(
    initialize.payload.provider_visible_capability_snapshot,
    "public initialize capability snapshot"
  );
  compare("public initialize shadow head", heads.public_shadow_world_sha256, domainHash(PUBLIC_WORLD_SHADOW_DOMAIN, shadow), errors);
  compare(
    "public initialize durable memory head",
    heads.durable_memory_head,
    heads.durable_memory_head.applicability === "durable_memory_enabled"
      ? Object.freeze({
        applicability: "durable_memory_enabled" as const,
        revision: 0,
        entry_count: durableMemory?.length ?? 0,
        public_state_sha256: durableMemory === null
          ? null
          : domainHash(PUBLIC_DURABLE_MEMORY_STATE_DOMAIN, durableMemory),
      })
      : Object.freeze({
        applicability: "not_applicable" as const,
        revision: 0,
        entry_count: 0,
        public_state_sha256: null,
      }),
    errors
  );
  if (
    (bindings.durable_memory_applicability === "durable_memory_enabled") !== (durableMemory !== null)
    || bindings.durable_memory_applicability !== heads.durable_memory_head.applicability
  ) errors.push("public initialize durable memory applicability mismatch");
  try { assertPublicSnapshotMatchesHead(initialSnapshot, heads.capability_head, "public initialize snapshot"); } catch (error) { errors.push((error as Error).message); }
  const callFingerprints = new Map<string, string>();
  let committedTurn = 0;
  const committedTurnIds = new Set<string>();
  for (const [index, entry] of transcript.entries.entries()) {
    const expectedPrevious = index === 0 ? null : transcript.entries[index - 1].entry_sha256;
    if (entry.run_id !== initialize.run_id) errors.push(`public entry ${index} changed run_id`);
    if (entry.previous_entry_sha256 !== expectedPrevious) errors.push(`public entry ${index} previous hash mismatch`);
    if (domainHash(TRANSCRIPT_ENTRY_DOMAIN, publicEntryBody(entry)) !== entry.entry_sha256) errors.push(`public entry ${index} hash mismatch`);
    if (entry.operation === "caller_turn") {
      try {
        exactKeys(entry.payload, CALLER_TURN_PAYLOAD_KEYS, `public entry ${index} caller payload`);
        exactKeys(entry.payload.input, CALLER_TURN_INPUT_KEYS, `public entry ${index} caller input`);
        assertPositiveInteger(entry.payload.input.turn, `public entry ${index} caller turn`);
        assertSafeId(entry.payload.input.turn_id, `public entry ${index} caller turn_id`);
        assertSha(entry.payload.input.condition_hash, `public entry ${index} caller condition_hash`);
        if (entry.payload.input.condition_hash !== bindings.condition_hash) {
          errors.push(`public entry ${index} caller condition binding mismatch`);
        }
        if (
          entry.payload.input.turn !== committedTurn + 1
          || committedTurnIds.has(entry.payload.input.turn_id as string)
        ) errors.push(`public entry ${index} caller turn is non-contiguous or repeated`);
        const pre = parsePublicStateHeads(entry.payload.pre_state, `public entry ${index} caller pre_state`);
        const post = parsePublicStateHeads(entry.payload.post_state, `public entry ${index} caller post_state`);
        compare(`public entry ${index} caller pre-state`, pre, heads, errors);
        compare(`public entry ${index} caller world head`, post.authoritative_world_head, pre.authoritative_world_head, errors);
        compare(`public entry ${index} caller shadow head`, post.public_shadow_world_sha256, pre.public_shadow_world_sha256, errors);
        compare(`public entry ${index} caller memory head`, post.durable_memory_head, pre.durable_memory_head, errors);
        if (
          post.capability_head.catalog_mode !== "refresh_required"
          || post.capability_head.epoch !== pre.capability_head.epoch + 1
        ) errors.push(`public entry ${index} caller refresh-required epoch mismatch`);
        const evidence = immutableJson(JsonValueSchema.parse(entry.payload.frontier_evidence)) as unknown as AdmissibilityFrontierEvidence;
        if (!verifyAdmissibilityFrontierEvidence(evidence)) {
          errors.push(`public entry ${index} caller frontier evidence hash mismatch`);
        }
        if (
          evidence.condition_hash !== bindings.condition_hash
          || evidence.scenario_hash !== bindings.scenario_hash
          || evidence.turn !== entry.payload.input.turn
          || evidence.target !== pre.capability_head.target
        ) errors.push(`public entry ${index} caller frontier binding mismatch`);
        const snapshot = parsePublicSnapshot(
          entry.payload.capability_snapshot,
          `public entry ${index} caller capability snapshot`
        );
        assertPublicSnapshotMatchesHead(snapshot, post.capability_head, `public entry ${index} caller capability snapshot`);
        committedTurn = entry.payload.input.turn as number;
        committedTurnIds.add(entry.payload.input.turn_id as string);
        heads = post;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `public entry ${index} caller replay failed`);
      }
      continue;
    }
    if (entry.operation !== "invoke") continue;
    try {
      exactKeys(entry.payload, PUBLIC_INVOKE_PAYLOAD_KEYS, `public entry ${index} payload`);
      exactKeys(entry.payload.input, PUBLIC_INPUT_KEYS, `public entry ${index} input`);
      const call = entry.payload.input;
      assertSafeId(call.provider_call_id, `public entry ${index} provider_call_id`);
      assertNonNegativeInteger(call.turn, `public entry ${index} turn`);
      assertSha(call.condition_hash, `public entry ${index} condition_hash`);
      assertSha(call.arguments_hmac_sha256, `public entry ${index} arguments HMAC`);
      assertSha(call.capability_grant_commitment, `public entry ${index} grant commitment`);
      assertSha(call.provider_call_fingerprint_hmac_sha256, `public entry ${index} call fingerprint`);
      if (call.condition_hash !== bindings.condition_hash) errors.push(`public entry ${index} condition binding mismatch`);
      if (bindings.condition_id === "host-managed-harness" && committedTurn > 0 && call.turn !== committedTurn) {
        errors.push(`public entry ${index} invocation is not bound to the committed caller turn`);
      }
      const pre = parsePublicStateHeads(entry.payload.pre_state, `public entry ${index} pre_state`);
      compare(`public entry ${index} pre-state`, pre, heads, errors);
      const delta = entry.payload.public_world_delta as JsonValue;
      exactKeys(delta, WORLD_DELTA_KEYS, `public entry ${index} world delta`);
      for (const key of WORLD_DELTA_KEYS) assertCommittedShadow(delta[key], `public entry ${index} delta.${key}`);
      shadow = applyPublicWorldDelta(shadow, delta);
      const memoryDelta = parsePublicDurableMemoryDelta(
        entry.payload.public_durable_memory_delta,
        `public entry ${index} durable memory delta`
      );
      const post = parsePublicStateHeads(entry.payload.post_state, `public entry ${index} post_state`);
      compare(
        `public entry ${index} shadow head`,
        post.public_shadow_world_sha256,
        domainHash(PUBLIC_WORLD_SHADOW_DOMAIN, shadow),
        errors
      );
      exactKeys(entry.payload.outcome, PUBLIC_OUTCOME_KEYS, `public entry ${index} outcome`);
      const outcome = entry.payload.outcome;
      assertSha(outcome.authoritative_result_hmac_sha256, `public entry ${index} authoritative result HMAC`);
      assertSha(outcome.provider_visible_output_hmac_sha256, `public entry ${index} visible output HMAC`);
      if (!["failure", "provider_call_id_conflict", "success_deduplicated", "success_executed", "success_replayed", "success_verified"].includes(outcome.result_class as string)) {
        throw new Error(`public entry ${index} result_class is invalid`);
      }
      if (
        outcome.failure_code !== null
        && (typeof outcome.failure_code !== "string" || !/^[a-z][a-z0-9_.-]{0,95}$/.test(outcome.failure_code))
      ) throw new Error(`public entry ${index} failure_code is invalid`);
      if ((outcome.result_class === "failure" || outcome.result_class === "provider_call_id_conflict") !== (outcome.failure_code !== null)) {
        throw new Error(`public entry ${index} failure_code presence is inconsistent with result_class`);
      }
      if (
        memoryDelta.operation !== "none"
        && (call.action !== "durable_memory" || outcome.result_class !== "success_executed")
      ) {
        throw new Error(`public entry ${index} durable memory mutation was not an executed durable_memory success`);
      }
      durableMemory = applyPublicDurableMemoryDelta(durableMemory, memoryDelta);
      const expectedMemoryRevision = pre.durable_memory_head.revision
        + (memoryDelta.operation === "none" ? 0 : 1);
      compare(
        `public entry ${index} durable memory head`,
        post.durable_memory_head,
        post.durable_memory_head.applicability === "durable_memory_enabled"
          ? Object.freeze({
            applicability: "durable_memory_enabled" as const,
            revision: expectedMemoryRevision,
            entry_count: durableMemory?.length ?? 0,
            public_state_sha256: durableMemory === null
              ? null
              : domainHash(PUBLIC_DURABLE_MEMORY_STATE_DOMAIN, durableMemory),
          })
          : Object.freeze({
            applicability: "not_applicable" as const,
            revision: 0,
            entry_count: 0,
            public_state_sha256: null,
          }),
        errors
      );
      const snapshot = outcome.capability_snapshot === null
        ? null
        : parsePublicSnapshot(outcome.capability_snapshot, `public entry ${index} capability snapshot`);
      if (snapshot) assertPublicSnapshotMatchesHead(snapshot, post.capability_head, `public entry ${index} snapshot`);
      else compare(`public entry ${index} capability head without rotation`, post.capability_head, pre.capability_head, errors);
      if (outcome.disclosure !== null) {
        exactKeys(outcome.disclosure, DISCLOSURE_KEYS, `public entry ${index} disclosure`);
        if (!snapshot) errors.push(`public entry ${index} disclosure has no snapshot`);
        if (outcome.disclosure.target !== post.capability_head.target) errors.push(`public entry ${index} disclosure target mismatch`);
        const disclosed = parsePublicSnapshot(outcome.disclosure.snapshot, `public entry ${index} disclosure snapshot`);
        compare(`public entry ${index} disclosure snapshot`, disclosed, snapshot, errors);
      }
      const priorFingerprint = callFingerprints.get(call.provider_call_id as string);
      if (priorFingerprint && priorFingerprint !== call.provider_call_fingerprint_hmac_sha256) {
        if (outcome.result_class !== "provider_call_id_conflict") errors.push(`public entry ${index} conflicting call ID was not rejected`);
      } else if (!priorFingerprint) callFingerprints.set(call.provider_call_id as string, call.provider_call_fingerprint_hmac_sha256 as string);
      heads = post;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `public entry ${index} replay failed`);
    }
  }
  const reference = publicTranscriptReference(transcript);
  let authenticity: KernelTranscriptVerification["authenticity"] = "unsigned_public_commitment";
  if (input.finalAttestation) {
    authenticity = "signed_attestation_invalid";
    if (!input.attestationExpectation) {
      errors.push("a public transcript-bound attestation requires pinned evidence and trust expectations");
    } else {
      const expectedApplicability = input.attestationExpectation.condition.behavior.genericDurableMemory
        ? "durable_memory_enabled"
        : "not_applicable";
      if (bindings.durable_memory_applicability !== expectedApplicability) {
        errors.push("signed condition durable memory applicability mismatch");
      }
      const verification = verifyBenchmarkKernelFinalAttestation(input.finalAttestation, input.attestationExpectation);
      if (!verification.valid || !verification.signature_verified) {
        errors.push(...verification.errors.map((error) => `final attestation: ${error}`));
        if (verification.errors.length === 0) errors.push("final attestation signature was not verified");
      } else authenticity = "signed_attestation_verified";
    }
    const attestation = input.finalAttestation;
    compare("signed public transcript reference", attestation.transcript_reference, reference, errors);
    if (attestation.bindings.run_id !== initialize.run_id) errors.push("attestation run binding mismatch");
    if (attestation.bindings.condition_hash !== bindings.condition_hash) errors.push("attestation condition binding mismatch");
    compare("attestation authoritative world head", attestation.world_head, heads.authoritative_world_head, errors);
    compare("attestation capability head", attestation.capability_head, heads.capability_head, errors);
    verifyFlowProofAgainstHead(attestation, heads.flow_state_sha256, errors);
  } else if (input.attestationExpectation) errors.push("attestation expectations supplied without a final attestation");
  return Object.freeze({
    valid: errors.length === 0,
    authenticity,
    errors: Object.freeze(errors),
    reference,
    run_id: initialize.run_id,
    reconstructed: Object.freeze({
      authoritative_world_head: heads.authoritative_world_head,
      public_shadow_world_sha256: heads.public_shadow_world_sha256,
      capability_head: heads.capability_head,
      flow_state_sha256: heads.flow_state_sha256,
      final_public_shadow_world: immutableJson(shadow) as unknown as JsonValue,
      durable_memory_head: heads.durable_memory_head,
      final_public_durable_memory: durableMemory === null
        ? null
        : immutableJson(durableMemory) as unknown as PublicKernelTranscriptDurableMemoryState,
      final_world: null,
    }),
    reconstruction_coverage: Object.freeze({
      plaintext_world_head: "signed_authoritative_head_only_not_plaintext_reconstructed" as const,
      public_shadow_world: "reconstructed_from_committed_initial_state_and_deltas" as const,
      capability_head: "validated_from_public_catalog_and_signed_final_head" as const,
      flow_proof: "hash_chain_only_requires_final_signed_attestation_state" as const,
      provider_behavior: "hmac_input_output_bound_not_model_reexecuted" as const,
      durable_memory: "reconstructed_when_applicable_from_hmac_committed_state_and_deltas" as const,
    }),
  });
}

/** Fail closed if a transcript artifact accidentally contains a raw grant. */
export function assertKernelTranscriptContainsNoRawGrants(encoded: string, rawGrants: readonly string[]): void {
  for (const grant of rawGrants) {
    if (grant && encoded.includes(grant)) throw new Error("kernel transcript contains a raw capability grant");
  }
}

export function kernelTranscriptArtifactHash(encoded: string): string {
  return sha256Hex(`${TRANSCRIPT_ARTIFACT_DOMAIN}${encoded}`);
}

export function kernelTranscriptFlowStateHead(state: FlowExecutionState | null): string | null {
  return flowStateHead(state);
}

export function kernelTranscriptProviderVisibleResult(
  outcome: BenchmarkGatewayOutcome,
  sensitiveValueSecret: string
): ArtifactJsonValue {
  return immutableJson(commitSensitiveTranscriptValues(
    outcome.providerVisibleOutput ?? outcome.result,
    sensitiveValueSecret
  ));
}

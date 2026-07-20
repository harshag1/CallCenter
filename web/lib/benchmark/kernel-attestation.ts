import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import {
  FlowExecutionStateSchema,
  MAX_FLOW_ACTION_ARGUMENT_BYTES,
  MAX_FLOW_ACTION_RESULT_BYTES,
  flowCapabilityScope,
  hashFlowValue,
  type FlowExecutionState,
} from "../flow-runtime";
import {
  canonicalJson,
  immutableJson,
  sha256Hex,
  type JsonValue,
} from "./artifacts";
import {
  assertCompiledConditionIntegrity,
  BENCHMARK_CONDITION_IDS,
  benchmarkScenarioHash,
  type BenchmarkConditionId,
  type CompiledBenchmarkCondition,
  type CompiledCapability,
} from "./condition-compiler";
import {
  BenchmarkScenarioSchema,
  type BenchmarkScenario,
} from "./scenario-schema";
import {
  parseBoundToolWorldState,
  type ToolWorldState,
} from "./tool-world";
import type { KernelTranscriptReference } from "./kernel-transcript";

const SHA256 = /^[a-f0-9]{64}$/;
const CONTENT_SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_SCOPED_ID = /^\$?[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ATTESTATION_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-final-attestation/v1\n";
const SIGNATURE_DOMAIN = "hacc/benchmark-kernel-final-attestation-signature/v1\n";
const CAPABILITY_CATALOG_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-capability-catalog/v1\n";
const WORLD_STATE_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-world-state/v1\n";
const WORLD_FACTS_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-world-facts/v1\n";
const WORLD_EVENTS_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-world-events/v1\n";
const WORLD_EVENT_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-world-event/v1\n";
const FLOW_STATE_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-flow-state/v1\n";
const FLOW_CHECKPOINTS_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-flow-checkpoints/v1\n";
const FLOW_RECEIPTS_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-flow-receipts/v1\n";

const ROOT_KEYS = Object.freeze([
  "schema_version",
  "attestation_type",
  "bindings",
  "world_head",
  "capability_head",
  "flow_proof",
  "transcript_reference",
  "attestation_hash",
  "signature",
].sort());
const BINDING_KEYS = Object.freeze([
  "run_id",
  "condition_id",
  "condition_hash",
  "source_hash",
  "scenario_hash",
  "flow_hash",
  "scenario_id",
  "scenario_version",
  "tool_world_scenario_hash",
  "pair_id",
  "lease_subject_id",
  "provider",
  "model",
  "plan_sha256",
  "freeze_lock_sha256",
  "kernel_build_sha256",
  "signing_key_id",
  "signing_public_key_sha256",
].sort());
const WORLD_HEAD_KEYS = Object.freeze([
  "state_sha256",
  "facts_sha256",
  "event_ledger_sha256",
  "event_count",
  "next_event_sequence",
  "latest_event_sequence",
  "latest_event_id",
  "latest_event_type",
  "latest_event_sha256",
  "admission_count",
  "receipt_count",
  "effect_count",
].sort());
const CAPABILITY_HEAD_KEYS = Object.freeze([
  "epoch",
  "target",
  "catalog_mode",
  "provider_grant_scope",
  "internal_flow_scope",
  "catalog",
  "catalog_sha256",
  "action_count",
].sort());
const CAPABILITY_ACTION_KEYS = Object.freeze(["name", "semantic_hash"].sort());
const SIGNATURE_KEYS = Object.freeze(["algorithm", "key_id", "signature_base64"].sort());
const EVIDENCE_BINDING_KEYS = Object.freeze([
  "pairId",
  "leaseSubjectId",
  "provider",
  "model",
  "planSha256",
  "freezeLockSha256",
  "kernelBuildSha256",
].sort());
const TRUST_KEYS = Object.freeze(["keyId", "publicKeySha256", "publicKeyPem"].sort());
const TRANSCRIPT_REFERENCE_KEYS = Object.freeze([
  "schema_version",
  "transcript_type",
  "encoding",
  "view",
  "transcript_entry_count",
  "transcript_head_sha256",
  "transcript_sha256",
  "byte_length",
].sort());
const FLOW_PROOF_KEYS = Object.freeze([
  "applicability",
  "execution_state",
  "execution_state_sha256",
  "checkpoint_ledger_sha256",
  "action_receipt_ledger_sha256",
  "checkpoint_count",
  "action_receipt_count",
].sort());

export type BenchmarkKernelCapabilityAction = Readonly<{
  name: string;
  semantic_hash: string;
}>;

export type BenchmarkKernelCapabilityHead = Readonly<{
  epoch: number;
  target: string;
  catalog_mode: "target" | "post_step_transition" | "terminal";
  /** Exact scope string shown in the latest provider capability snapshot. */
  provider_grant_scope: string;
  /** Production Flow v2 authorization scope; null in unenforced arms. */
  internal_flow_scope: string | null;
  /** Grants themselves are private; this is the exact public logical catalog. */
  catalog: readonly BenchmarkKernelCapabilityAction[];
  catalog_sha256: string;
  action_count: number;
}>;

export type BenchmarkKernelEvidenceBinding = Readonly<{
  pairId: string;
  leaseSubjectId: string;
  provider: "openai" | "xai" | "gemini" | "offline";
  model: string;
  planSha256: string;
  freezeLockSha256: string;
  kernelBuildSha256: string;
}>;

export type BenchmarkKernelAttestationSigner = Readonly<{
  algorithm: "ed25519";
  keyId: string;
  publicKeySha256: string;
  sign(payload: string): string;
}>;

export type BenchmarkKernelAttestationTrust = Readonly<{
  keyId: string;
  publicKeySha256: string;
  publicKeyPem: string;
}>;

export type BenchmarkKernelAttestationBindings = Readonly<{
  run_id: string;
  condition_id: BenchmarkConditionId;
  condition_hash: string;
  source_hash: string;
  scenario_hash: string;
  flow_hash: string;
  scenario_id: string;
  scenario_version: string;
  tool_world_scenario_hash: string;
  pair_id: string;
  lease_subject_id: string;
  provider: BenchmarkKernelEvidenceBinding["provider"];
  model: string;
  plan_sha256: string;
  freeze_lock_sha256: string;
  kernel_build_sha256: string;
  signing_key_id: string;
  signing_public_key_sha256: string;
}>;

export type BenchmarkKernelWorldHead = Readonly<{
  state_sha256: string;
  facts_sha256: string;
  event_ledger_sha256: string;
  event_count: number;
  next_event_sequence: number;
  latest_event_sequence: number;
  latest_event_id: string;
  latest_event_type: string;
  latest_event_sha256: string;
  admission_count: number;
  receipt_count: number;
  effect_count: number;
}>;

export type BenchmarkKernelFlowProof = Readonly<{
  applicability: "flow_v2_enforced" | "not_applicable_unenforced";
  execution_state: FlowExecutionState | null;
  execution_state_sha256: string | null;
  checkpoint_ledger_sha256: string | null;
  action_receipt_ledger_sha256: string | null;
  checkpoint_count: number | null;
  action_receipt_count: number | null;
}>;

export type BenchmarkKernelFinalAttestation = Readonly<{
  schema_version: 1;
  attestation_type: "benchmark_kernel_final_state";
  bindings: BenchmarkKernelAttestationBindings;
  world_head: BenchmarkKernelWorldHead;
  capability_head: BenchmarkKernelCapabilityHead;
  flow_proof: BenchmarkKernelFlowProof;
  transcript_reference: KernelTranscriptReference;
  attestation_hash: string;
  signature: Readonly<{
    algorithm: "ed25519";
    key_id: string;
    signature_base64: string;
  }>;
}>;

type BenchmarkKernelUnsignedFinalAttestation = Omit<
  BenchmarkKernelFinalAttestation,
  "attestation_hash" | "signature"
>;

export type BenchmarkKernelFinalAttestationInput = Readonly<{
  runId: string;
  condition: CompiledBenchmarkCondition;
  scenario: BenchmarkScenario;
  world: ToolWorldState;
  capabilityHead: BenchmarkKernelCapabilityHead;
  flowState: FlowExecutionState | null;
  transcriptReference: KernelTranscriptReference;
  evidenceBinding: BenchmarkKernelEvidenceBinding;
  signer: BenchmarkKernelAttestationSigner;
}>;

export type BenchmarkKernelAttestationExpectation = Readonly<{
  runId: string;
  condition: CompiledBenchmarkCondition;
  scenario: BenchmarkScenario;
  world: ToolWorldState;
  transcriptReference: KernelTranscriptReference;
  evidenceBinding: BenchmarkKernelEvidenceBinding;
  trust: BenchmarkKernelAttestationTrust;
}>;

export type BenchmarkKernelAttestationVerification = Readonly<{
  valid: boolean;
  expected_attestation_hash: string | null;
  signature_verified: boolean;
  errors: readonly string[];
}>;

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

function nonEmpty(value: unknown, label: string, maxLength = 256): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
}

function safeIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be a safe identifier`);
  }
}

function safeScopedIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_SCOPED_ID.test(value)) {
    throw new Error(`${label} must be a safe scoped identifier`);
  }
}

function sha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function contentSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !CONTENT_SHA256.test(value)) throw new Error(`${label} must be a content SHA-256 digest`);
}

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive safe integer`);
}

function canonicalBase64(value: unknown, label: string): asserts value is string {
  nonEmpty(value, label, 16 * 1024);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== value) {
    throw new Error(`${label} must be one canonical 64-byte Ed25519 signature`);
  }
}

export function benchmarkKernelAttestationPublicKeyFingerprint(publicKeyPem: string): string {
  if (typeof publicKeyPem !== "string" || !publicKeyPem.trim() || publicKeyPem.length > 64 * 1024) {
    throw new Error("kernel attestation public key must be non-empty PEM under 64 KiB");
  }
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("kernel attestation key must be Ed25519");
  const der = key.export({ type: "spki", format: "der" });
  const canonicalPem = key.export({ type: "spki", format: "pem" }).toString();
  if (publicKeyPem !== canonicalPem) {
    throw new Error("kernel attestation public key must be canonical SPKI PEM");
  }
  return sha256Hex(new Uint8Array(der));
}

function validatedEvidenceBinding(input: unknown): BenchmarkKernelEvidenceBinding {
  exactKeys(input, EVIDENCE_BINDING_KEYS, "kernel attestation evidence binding");
  safeIdentifier(input.pairId, "evidenceBinding.pairId");
  safeIdentifier(input.leaseSubjectId, "evidenceBinding.leaseSubjectId");
  if (input.provider !== "openai" && input.provider !== "xai" && input.provider !== "gemini" && input.provider !== "offline") {
    throw new Error("evidenceBinding.provider is invalid");
  }
  nonEmpty(input.model, "evidenceBinding.model", 512);
  sha(input.planSha256, "evidenceBinding.planSha256");
  sha(input.freezeLockSha256, "evidenceBinding.freezeLockSha256");
  sha(input.kernelBuildSha256, "evidenceBinding.kernelBuildSha256");
  return Object.freeze({
    pairId: input.pairId,
    leaseSubjectId: input.leaseSubjectId,
    provider: input.provider,
    model: input.model,
    planSha256: input.planSha256,
    freezeLockSha256: input.freezeLockSha256,
    kernelBuildSha256: input.kernelBuildSha256,
  });
}

function validatedTranscriptReference(input: unknown): KernelTranscriptReference {
  exactKeys(input, TRANSCRIPT_REFERENCE_KEYS, "kernel transcript reference");
  if (
    input.schema_version !== 1
    || input.transcript_type !== "benchmark_kernel_replay_public_commitment"
    || input.view !== "public_commitment"
  ) {
    throw new Error("kernel transcript reference has an unsupported schema or type");
  }
  if (input.encoding !== "canonical-jsonl-public-commitment") {
    throw new Error("kernel transcript reference encoding is invalid");
  }
  positiveInteger(input.transcript_entry_count, "transcript_reference.transcript_entry_count");
  sha(input.transcript_head_sha256, "transcript_reference.transcript_head_sha256");
  sha(input.transcript_sha256, "transcript_reference.transcript_sha256");
  positiveInteger(input.byte_length, "transcript_reference.byte_length");
  return immutableJson(input) as unknown as KernelTranscriptReference;
}

function validatedTrust(input: unknown): Readonly<{
  trust: BenchmarkKernelAttestationTrust;
  publicKey: ReturnType<typeof createPublicKey>;
}> {
  exactKeys(input, TRUST_KEYS, "kernel attestation trust");
  safeIdentifier(input.keyId, "kernel attestation trust key ID");
  sha(input.publicKeySha256, "kernel attestation trust public-key fingerprint");
  if (typeof input.publicKeyPem !== "string" || !input.publicKeyPem.trim() || input.publicKeyPem.length > 64 * 1024) {
    throw new Error("kernel attestation trust public key must be non-empty PEM under 64 KiB");
  }
  const publicKey = createPublicKey(input.publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("kernel attestation trust key must be Ed25519");
  const fingerprint = benchmarkKernelAttestationPublicKeyFingerprint(input.publicKeyPem);
  if (fingerprint !== input.publicKeySha256) {
    throw new Error("kernel attestation trust public-key fingerprint mismatch");
  }
  return Object.freeze({
    trust: Object.freeze({
      keyId: input.keyId,
      publicKeySha256: input.publicKeySha256,
      publicKeyPem: input.publicKeyPem,
    }),
    publicKey,
  });
}

export function createBenchmarkKernelAttestationSigner(input: Readonly<{
  keyId: string;
  privateKeyPem: string;
  publicKeyPem?: string;
}>): BenchmarkKernelAttestationSigner {
  safeIdentifier(input.keyId, "kernel attestation key ID");
  if (typeof input.privateKeyPem !== "string" || !input.privateKeyPem.trim() || input.privateKeyPem.length > 64 * 1024) {
    throw new Error("kernel attestation private key must be non-empty PEM under 64 KiB");
  }
  const privateKey = createPrivateKey(input.privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("kernel attestation private key must be Ed25519");
  const derivedPublic = createPublicKey(privateKey);
  const derivedDer = derivedPublic.export({ type: "spki", format: "der" });
  const derivedFingerprint = sha256Hex(new Uint8Array(derivedDer));
  if (input.publicKeyPem && benchmarkKernelAttestationPublicKeyFingerprint(input.publicKeyPem) !== derivedFingerprint) {
    throw new Error("kernel attestation public key does not match the private signing key");
  }
  return Object.freeze({
    algorithm: "ed25519" as const,
    keyId: input.keyId,
    publicKeySha256: derivedFingerprint,
    sign(payload: string): string {
      return signBytes(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
    },
  });
}

function frozenFlowState(input: unknown): FlowExecutionState {
  const parsed = FlowExecutionStateSchema.parse(input);
  if (canonicalJson(parsed) !== canonicalJson(input)) {
    throw new Error("flow execution state contains missing, defaulted, or unsupported fields");
  }
  for (const [index, receipt] of parsed.actionReceipts.entries()) {
    if (receipt.arguments !== undefined && receipt.argumentsHash !== hashFlowValue(receipt.arguments)) {
      throw new Error(`flow action receipt ${index} has an invalid arguments hash`);
    }
    if (receipt.arguments === undefined && (
      !receipt.argumentsCompacted ||
      receipt.argumentsBytes === undefined ||
      receipt.argumentsBytes > MAX_FLOW_ACTION_ARGUMENT_BYTES
    )) {
      throw new Error(`flow action receipt ${index} has invalid compacted arguments evidence`);
    }
    const settled = receipt.status !== "reserved";
    if (settled !== (receipt.settledAt !== undefined)) {
      throw new Error(`flow action receipt ${index} has inconsistent settlement evidence`);
    }
    if (receipt.status === "succeeded") {
      const inlineResultValid = receipt.result !== undefined &&
        receipt.resultHash === hashFlowValue(receipt.result);
      const compactedResultValid = receipt.result === undefined &&
        receipt.resultCompacted &&
        receipt.resultHash !== undefined &&
        receipt.resultBytes !== undefined &&
        receipt.resultBytes <= MAX_FLOW_ACTION_RESULT_BYTES;
      if (!inlineResultValid && !compactedResultValid) {
        throw new Error(`flow action receipt ${index} has invalid successful result evidence`);
      }
    } else if (receipt.result !== undefined || receipt.resultHash !== undefined || receipt.resultCompacted) {
      throw new Error(`flow action receipt ${index} has result evidence for a non-success status`);
    }
  }
  if (new Set(parsed.actionReceipts.map((receipt) => receipt.id)).size !== parsed.actionReceipts.length) {
    throw new Error("flow action receipt ledger contains duplicate receipt IDs");
  }
  return immutableJson(parsed) as unknown as FlowExecutionState;
}

function normalizedCapabilityCatalog(input: unknown): readonly BenchmarkKernelCapabilityAction[] {
  if (!Array.isArray(input) || input.length > 10_000) throw new Error("capability_head.catalog must be a bounded array");
  const catalog = input.map((entry, index) => {
    exactKeys(entry, CAPABILITY_ACTION_KEYS, `capability_head.catalog[${index}]`);
    nonEmpty(entry.name, `capability_head.catalog[${index}].name`);
    sha(entry.semantic_hash, `capability_head.catalog[${index}].semantic_hash`);
    return Object.freeze({ name: entry.name as string, semantic_hash: entry.semantic_hash as string });
  });
  if (new Set(catalog.map((entry) => entry.name)).size !== catalog.length) {
    throw new Error("capability_head.catalog contains duplicate actions");
  }
  const sorted = [...catalog].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (canonicalJson(sorted) !== canonicalJson(catalog)) throw new Error("capability_head.catalog must use canonical action-name order");
  return Object.freeze(catalog);
}

function capabilityCatalogHash(catalog: readonly BenchmarkKernelCapabilityAction[]): string {
  return domainHash(CAPABILITY_CATALOG_DOMAIN, catalog);
}

function validateCapabilityHead(input: unknown): BenchmarkKernelCapabilityHead {
  exactKeys(input, CAPABILITY_HEAD_KEYS, "capability_head");
  nonNegativeInteger(input.epoch, "capability_head.epoch");
  nonEmpty(input.target, "capability_head.target");
  if (input.catalog_mode !== "target" && input.catalog_mode !== "post_step_transition" && input.catalog_mode !== "terminal") {
    throw new Error("capability_head.catalog_mode is invalid");
  }
  nonEmpty(input.provider_grant_scope, "capability_head.provider_grant_scope");
  if (input.internal_flow_scope !== null) nonEmpty(input.internal_flow_scope, "capability_head.internal_flow_scope");
  const catalog = normalizedCapabilityCatalog(input.catalog);
  sha(input.catalog_sha256, "capability_head.catalog_sha256");
  nonNegativeInteger(input.action_count, "capability_head.action_count");
  if (input.action_count !== catalog.length) throw new Error("capability_head.action_count differs from its catalog");
  if (input.catalog_sha256 !== capabilityCatalogHash(catalog)) throw new Error("capability_head.catalog_sha256 mismatch");
  safeScopedIdentifier(input.target, "capability_head.target");
  safeScopedIdentifier(input.provider_grant_scope, "capability_head.provider_grant_scope");
  if (input.internal_flow_scope !== null) {
    safeScopedIdentifier(input.internal_flow_scope, "capability_head.internal_flow_scope");
  }
  return Object.freeze({
    epoch: input.epoch as number,
    target: input.target as string,
    catalog_mode: input.catalog_mode,
    provider_grant_scope: input.provider_grant_scope as string,
    internal_flow_scope: input.internal_flow_scope as string | null,
    catalog,
    catalog_sha256: input.catalog_sha256 as string,
    action_count: input.action_count as number,
  });
}

function compiledCatalog(condition: CompiledBenchmarkCondition, target: string, mode: BenchmarkKernelCapabilityHead["catalog_mode"]): readonly BenchmarkKernelCapabilityAction[] {
  const union = new Map(
    [...condition.visibleCapabilities, ...condition.disclosures.flatMap((disclosure) => disclosure.visibleCapabilities)]
      .map((capability) => [capability.name, capability])
  );
  let capabilities: readonly CompiledCapability[];
  if (!condition.behavior.progressiveDisclosure) {
    if (target !== "$full-catalog" || mode !== "target") {
      throw new Error("non-progressive conditions must attest the full-catalog target");
    }
    capabilities = condition.visibleCapabilities;
  } else if (target === "$base") {
    if (mode !== "target") throw new Error("base capability catalog must use target mode");
    capabilities = condition.visibleCapabilities;
  } else if (mode === "terminal") {
    if (!target.startsWith("topic:") || !condition.disclosures.some((candidate) => candidate.target === target)) {
      throw new Error("terminal catalog must retain a compiled topic target");
    }
    const recovery = union.get("flow.get_state");
    capabilities = recovery ? [recovery] : [];
  } else if (mode === "post_step_transition") {
    if (!target.startsWith("topic:")) throw new Error("post-step transition catalog must target a topic");
    const disclosure = condition.disclosures.find((candidate) => candidate.target === target);
    if (!disclosure) throw new Error(`capability target ${target} is absent from the compiled condition`);
    // The concrete kernel reuses the exact topic disclosure after completing a
    // step. This preserves always/topic tools and avoids inventing an
    // attestation-only catalog that the provider never received.
    capabilities = disclosure.visibleCapabilities;
  } else {
    const disclosure = condition.disclosures.find((candidate) => candidate.target === target);
    if (!disclosure) throw new Error(`capability target ${target} is absent from the compiled condition`);
    capabilities = disclosure.visibleCapabilities;
  }
  return Object.freeze([...capabilities]
    .map((capability) => Object.freeze({ name: capability.name, semantic_hash: capability.semanticHash }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

export function createBenchmarkKernelCapabilityHead(input: Readonly<{
  condition: CompiledBenchmarkCondition;
  epoch: number;
  target: string;
  catalogMode: BenchmarkKernelCapabilityHead["catalog_mode"];
  internalFlowScope: string | null;
}>): BenchmarkKernelCapabilityHead {
  assertCompiledConditionIntegrity(input.condition);
  const catalog = compiledCatalog(input.condition, input.target, input.catalogMode);
  return validateCapabilityHead({
    epoch: input.epoch,
    target: input.target,
    catalog_mode: input.catalogMode,
    provider_grant_scope: input.condition.behavior.progressiveDisclosure ? input.target : "$full-catalog",
    internal_flow_scope: input.internalFlowScope,
    catalog,
    catalog_sha256: capabilityCatalogHash(catalog),
    action_count: catalog.length,
  });
}

function assertCapabilityRelation(
  condition: CompiledBenchmarkCondition,
  head: BenchmarkKernelCapabilityHead
): void {
  const expectedCatalog = compiledCatalog(condition, head.target, head.catalog_mode);
  if (canonicalJson(head.catalog) !== canonicalJson(expectedCatalog)) {
    throw new Error("capability catalog differs from the compiled condition target");
  }
  const expectedProviderScope = condition.behavior.progressiveDisclosure ? head.target : "$full-catalog";
  if (head.provider_grant_scope !== expectedProviderScope) {
    throw new Error("provider grant scope differs from the canonical condition target relation");
  }
}

function assertFlowCapabilityRelation(
  condition: CompiledBenchmarkCondition,
  head: BenchmarkKernelCapabilityHead,
  state: FlowExecutionState
): void {
  if (!condition.behavior.progressiveDisclosure) return;
  if (state.status === "completed" || state.status === "failed") {
    const target = state.nodeId ? `topic:${state.nodeId}` : null;
    if (target === null || head.target !== target || head.catalog_mode !== "terminal") {
      throw new Error("terminal Flow state differs from the attested terminal capability target");
    }
    return;
  }
  if (state.currentStep !== null) {
    if (head.target !== `step:${state.currentStep}` || head.catalog_mode !== "target") {
      throw new Error("active Flow step differs from the attested capability target");
    }
    return;
  }
  if (state.nodeId !== null) {
    if (
      head.target !== `topic:${state.nodeId}`
      || (head.catalog_mode !== "target" && head.catalog_mode !== "post_step_transition")
    ) {
      throw new Error("selected Flow topic differs from the attested capability target");
    }
    return;
  }
  if (head.target !== "$base" || head.catalog_mode !== "target") {
    throw new Error("routing Flow state must attest the base capability target");
  }
}

function isFlowEnforced(condition: CompiledBenchmarkCondition): boolean {
  const flags = [
    condition.behavior.durableFlowState,
    condition.behavior.enforceTransitions,
    condition.behavior.enforceCapabilityGrants,
    condition.behavior.enforceExactlyOnce,
  ];
  if (flags.some(Boolean) && !flags.every(Boolean)) {
    throw new Error(`condition ${condition.id} has a partial flow-enforcement configuration`);
  }
  return flags.every(Boolean);
}

export function createBenchmarkKernelFlowProof(
  condition: CompiledBenchmarkCondition,
  capabilityHead: BenchmarkKernelCapabilityHead,
  flowStateInput: FlowExecutionState | null
): BenchmarkKernelFlowProof {
  const enforced = isFlowEnforced(condition);
  if (!enforced) {
    if (flowStateInput !== null) throw new Error("unenforced condition cannot attest a FlowExecutionState");
    if (capabilityHead.internal_flow_scope !== null) {
      throw new Error("unenforced condition cannot claim an internal Flow scope");
    }
    return Object.freeze({
      applicability: "not_applicable_unenforced" as const,
      execution_state: null,
      execution_state_sha256: null,
      checkpoint_ledger_sha256: null,
      action_receipt_ledger_sha256: null,
      checkpoint_count: null,
      action_receipt_count: null,
    });
  }
  if (flowStateInput === null) throw new Error("flow-enforced condition must attest its full FlowExecutionState");
  const state = frozenFlowState(flowStateInput);
  if (capabilityHead.epoch !== state.capabilityEpoch) {
    throw new Error("capability epoch differs from the attested FlowExecutionState");
  }
  if (capabilityHead.internal_flow_scope !== flowCapabilityScope(state).step) {
    throw new Error("internal Flow scope differs from the attested FlowExecutionState");
  }
  assertFlowCapabilityRelation(condition, capabilityHead, state);
  return Object.freeze({
    applicability: "flow_v2_enforced" as const,
    execution_state: state,
    execution_state_sha256: domainHash(FLOW_STATE_DOMAIN, state),
    checkpoint_ledger_sha256: domainHash(FLOW_CHECKPOINTS_DOMAIN, state.checkpoints),
    action_receipt_ledger_sha256: domainHash(FLOW_RECEIPTS_DOMAIN, state.actionReceipts),
    checkpoint_count: state.checkpoints.length,
    action_receipt_count: state.actionReceipts.length,
  });
}

function bindingFor(input: Readonly<{
  runId: string;
  condition: CompiledBenchmarkCondition;
  scenario: BenchmarkScenario;
  world: ToolWorldState;
  evidenceBinding: BenchmarkKernelEvidenceBinding;
  signingKeyId: string;
  signingPublicKeySha256: string;
}>): BenchmarkKernelAttestationBindings {
  safeIdentifier(input.runId, "runId");
  const evidence = validatedEvidenceBinding(input.evidenceBinding);
  safeIdentifier(input.signingKeyId, "kernel attestation signing key ID");
  sha(input.signingPublicKeySha256, "kernel attestation signing public-key fingerprint");
  return Object.freeze({
    run_id: input.runId,
    condition_id: input.condition.id,
    condition_hash: input.condition.conditionHash,
    source_hash: input.condition.sourceHash,
    scenario_hash: input.condition.scenarioHash,
    flow_hash: input.condition.flowHash,
    scenario_id: input.scenario.id,
    scenario_version: input.scenario.version,
    tool_world_scenario_hash: input.world.scenario_hash,
    pair_id: evidence.pairId,
    lease_subject_id: evidence.leaseSubjectId,
    provider: evidence.provider,
    model: evidence.model,
    plan_sha256: evidence.planSha256,
    freeze_lock_sha256: evidence.freezeLockSha256,
    kernel_build_sha256: evidence.kernelBuildSha256,
    signing_key_id: input.signingKeyId,
    signing_public_key_sha256: input.signingPublicKeySha256,
  });
}

export function createBenchmarkKernelWorldHead(world: ToolWorldState): BenchmarkKernelWorldHead {
  const latest = world.events.at(-1);
  if (!latest) throw new Error("bound ToolWorld has no authoritative event head");
  return Object.freeze({
    state_sha256: domainHash(WORLD_STATE_DOMAIN, world),
    facts_sha256: domainHash(WORLD_FACTS_DOMAIN, world.facts),
    event_ledger_sha256: domainHash(WORLD_EVENTS_DOMAIN, world.events),
    event_count: world.events.length,
    next_event_sequence: world.next_event_sequence,
    latest_event_sequence: latest.sequence,
    latest_event_id: latest.event_id,
    latest_event_type: latest.type,
    latest_event_sha256: domainHash(WORLD_EVENT_DOMAIN, latest),
    admission_count: world.admissions.length,
    receipt_count: world.receipts.length,
    effect_count: world.effects.length,
  });
}

function attestationBody(
  input: BenchmarkKernelUnsignedFinalAttestation | BenchmarkKernelFinalAttestation
): BenchmarkKernelUnsignedFinalAttestation {
  return {
    schema_version: input.schema_version,
    attestation_type: input.attestation_type,
    bindings: input.bindings,
    world_head: input.world_head,
    capability_head: input.capability_head,
    flow_proof: input.flow_proof,
    transcript_reference: input.transcript_reference,
  };
}

export function benchmarkKernelAttestationHash(
  input: BenchmarkKernelUnsignedFinalAttestation | BenchmarkKernelFinalAttestation
): string {
  return domainHash(ATTESTATION_DOMAIN, attestationBody(input));
}

/**
 * Creates a deterministic, read-only proof of the state already held by a
 * treatment kernel. The caller owns finalization; this function never mutates
 * the world, capability epoch, or FlowExecutionState.
 */
export function createBenchmarkKernelFinalAttestation(
  input: BenchmarkKernelFinalAttestationInput
): BenchmarkKernelFinalAttestation {
  nonEmpty(input.runId, "runId");
  assertCompiledConditionIntegrity(input.condition);
  const scenario = BenchmarkScenarioSchema.parse(input.scenario);
  if (benchmarkScenarioHash(scenario) !== input.condition.scenarioHash) {
    throw new Error("attestation scenario differs from the compiled condition scenario hash");
  }
  const world = parseBoundToolWorldState(scenario, input.world);
  if (canonicalJson(world) !== canonicalJson(input.world)) {
    throw new Error("ToolWorld contains missing, defaulted, or unsupported fields");
  }
  const capabilityHead = validateCapabilityHead(input.capabilityHead);
  assertCapabilityRelation(input.condition, capabilityHead);
  const transcriptReference = validatedTranscriptReference(input.transcriptReference);
  if (input.signer.algorithm !== "ed25519") throw new Error("kernel attestation signer must use Ed25519");
  safeIdentifier(input.signer.keyId, "kernel attestation signing key ID");
  sha(input.signer.publicKeySha256, "kernel attestation signing public-key fingerprint");
  const withoutHash = Object.freeze({
    schema_version: 1 as const,
    attestation_type: "benchmark_kernel_final_state" as const,
    bindings: bindingFor({
      runId: input.runId,
      condition: input.condition,
      scenario,
      world,
      evidenceBinding: input.evidenceBinding,
      signingKeyId: input.signer.keyId,
      signingPublicKeySha256: input.signer.publicKeySha256,
    }),
    world_head: createBenchmarkKernelWorldHead(world),
    capability_head: capabilityHead,
    flow_proof: createBenchmarkKernelFlowProof(input.condition, capabilityHead, input.flowState),
    transcript_reference: transcriptReference,
  });
  const attestationHash = benchmarkKernelAttestationHash(withoutHash);
  const signatureBase64 = input.signer.sign(`${SIGNATURE_DOMAIN}${attestationHash}`);
  canonicalBase64(signatureBase64, "kernel attestation signature");
  return immutableJson({
    ...withoutHash,
    attestation_hash: attestationHash,
    signature: {
      algorithm: "ed25519",
      key_id: input.signer.keyId,
      signature_base64: signatureBase64,
    },
  }) as unknown as BenchmarkKernelFinalAttestation;
}

function parseBindings(input: unknown): BenchmarkKernelAttestationBindings {
  exactKeys(input, BINDING_KEYS, "kernel attestation bindings");
  safeIdentifier(input.run_id, "bindings.run_id");
  if (typeof input.condition_id !== "string" || !(BENCHMARK_CONDITION_IDS as readonly string[]).includes(input.condition_id)) {
    throw new Error("bindings.condition_id is invalid");
  }
  sha(input.condition_hash, "bindings.condition_hash");
  sha(input.source_hash, "bindings.source_hash");
  sha(input.scenario_hash, "bindings.scenario_hash");
  sha(input.flow_hash, "bindings.flow_hash");
  nonEmpty(input.scenario_id, "bindings.scenario_id");
  nonEmpty(input.scenario_version, "bindings.scenario_version");
  contentSha(input.tool_world_scenario_hash, "bindings.tool_world_scenario_hash");
  safeIdentifier(input.pair_id, "bindings.pair_id");
  safeIdentifier(input.lease_subject_id, "bindings.lease_subject_id");
  if (input.provider !== "openai" && input.provider !== "xai" && input.provider !== "gemini" && input.provider !== "offline") {
    throw new Error("bindings.provider is invalid");
  }
  nonEmpty(input.model, "bindings.model", 512);
  sha(input.plan_sha256, "bindings.plan_sha256");
  sha(input.freeze_lock_sha256, "bindings.freeze_lock_sha256");
  sha(input.kernel_build_sha256, "bindings.kernel_build_sha256");
  safeIdentifier(input.signing_key_id, "bindings.signing_key_id");
  sha(input.signing_public_key_sha256, "bindings.signing_public_key_sha256");
  return immutableJson(input) as unknown as BenchmarkKernelAttestationBindings;
}

function parseWorldHead(input: unknown): BenchmarkKernelWorldHead {
  exactKeys(input, WORLD_HEAD_KEYS, "kernel attestation world_head");
  sha(input.state_sha256, "world_head.state_sha256");
  sha(input.facts_sha256, "world_head.facts_sha256");
  sha(input.event_ledger_sha256, "world_head.event_ledger_sha256");
  positiveInteger(input.event_count, "world_head.event_count");
  positiveInteger(input.next_event_sequence, "world_head.next_event_sequence");
  positiveInteger(input.latest_event_sequence, "world_head.latest_event_sequence");
  nonEmpty(input.latest_event_id, "world_head.latest_event_id");
  nonEmpty(input.latest_event_type, "world_head.latest_event_type");
  sha(input.latest_event_sha256, "world_head.latest_event_sha256");
  nonNegativeInteger(input.admission_count, "world_head.admission_count");
  nonNegativeInteger(input.receipt_count, "world_head.receipt_count");
  nonNegativeInteger(input.effect_count, "world_head.effect_count");
  if (input.next_event_sequence !== input.event_count + 1) {
    throw new Error("world_head.next_event_sequence differs from its event count");
  }
  if (input.latest_event_sequence !== input.event_count) {
    throw new Error("world_head.latest_event_sequence differs from its event count");
  }
  return immutableJson(input) as unknown as BenchmarkKernelWorldHead;
}

function parseFlowProof(input: unknown): BenchmarkKernelFlowProof {
  exactKeys(input, FLOW_PROOF_KEYS, "kernel attestation flow_proof");
  if (input.applicability === "not_applicable_unenforced") {
    if (
      input.execution_state !== null
      || input.execution_state_sha256 !== null
      || input.checkpoint_ledger_sha256 !== null
      || input.action_receipt_ledger_sha256 !== null
      || input.checkpoint_count !== null
      || input.action_receipt_count !== null
    ) {
      throw new Error("unenforced flow_proof must use the canonical all-null proof");
    }
    return Object.freeze({
      applicability: "not_applicable_unenforced",
      execution_state: null,
      execution_state_sha256: null,
      checkpoint_ledger_sha256: null,
      action_receipt_ledger_sha256: null,
      checkpoint_count: null,
      action_receipt_count: null,
    });
  }
  if (input.applicability !== "flow_v2_enforced") {
    throw new Error("flow_proof.applicability is invalid");
  }
  if (input.execution_state === null) throw new Error("enforced flow_proof lacks an execution state");
  const state = frozenFlowState(input.execution_state);
  sha(input.execution_state_sha256, "flow_proof.execution_state_sha256");
  sha(input.checkpoint_ledger_sha256, "flow_proof.checkpoint_ledger_sha256");
  sha(input.action_receipt_ledger_sha256, "flow_proof.action_receipt_ledger_sha256");
  nonNegativeInteger(input.checkpoint_count, "flow_proof.checkpoint_count");
  nonNegativeInteger(input.action_receipt_count, "flow_proof.action_receipt_count");
  const parsed = Object.freeze({
    applicability: "flow_v2_enforced" as const,
    execution_state: state,
    execution_state_sha256: input.execution_state_sha256,
    checkpoint_ledger_sha256: input.checkpoint_ledger_sha256,
    action_receipt_ledger_sha256: input.action_receipt_ledger_sha256,
    checkpoint_count: input.checkpoint_count,
    action_receipt_count: input.action_receipt_count,
  });
  const expected = Object.freeze({
    ...parsed,
    execution_state_sha256: domainHash(FLOW_STATE_DOMAIN, state),
    checkpoint_ledger_sha256: domainHash(FLOW_CHECKPOINTS_DOMAIN, state.checkpoints),
    action_receipt_ledger_sha256: domainHash(FLOW_RECEIPTS_DOMAIN, state.actionReceipts),
    checkpoint_count: state.checkpoints.length,
    action_receipt_count: state.actionReceipts.length,
  });
  if (!sameJson(parsed, expected)) {
    throw new Error("flow_proof digests or counts do not match its full FlowExecutionState");
  }
  return parsed;
}

function parseSignature(input: unknown, bindings: BenchmarkKernelAttestationBindings): BenchmarkKernelFinalAttestation["signature"] {
  exactKeys(input, SIGNATURE_KEYS, "kernel attestation signature");
  if (input.algorithm !== "ed25519") throw new Error("kernel attestation signature algorithm is invalid");
  safeIdentifier(input.key_id, "kernel attestation signature key ID");
  canonicalBase64(input.signature_base64, "kernel attestation signature");
  if (input.key_id !== bindings.signing_key_id) {
    throw new Error("kernel attestation signature key ID differs from its signed binding");
  }
  return Object.freeze({
    algorithm: "ed25519",
    key_id: input.key_id,
    signature_base64: input.signature_base64,
  });
}

function parseAttestation(input: unknown): BenchmarkKernelFinalAttestation {
  exactKeys(input, ROOT_KEYS, "kernel attestation");
  if (input.schema_version !== 1 || input.attestation_type !== "benchmark_kernel_final_state") {
    throw new Error("kernel attestation has an unsupported schema or type");
  }
  const bindings = parseBindings(input.bindings);
  const worldHead = parseWorldHead(input.world_head);
  const capabilityHead = validateCapabilityHead(input.capability_head);
  const flowProof = parseFlowProof(input.flow_proof);
  const transcriptReference = validatedTranscriptReference(input.transcript_reference);
  sha(input.attestation_hash, "attestation_hash");
  const signature = parseSignature(input.signature, bindings);
  return immutableJson({
    schema_version: 1,
    attestation_type: "benchmark_kernel_final_state",
    bindings,
    world_head: worldHead,
    capability_head: capabilityHead,
    flow_proof: flowProof,
    transcript_reference: transcriptReference,
    attestation_hash: input.attestation_hash,
    signature,
  }) as unknown as BenchmarkKernelFinalAttestation;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Verifies structure, all recomputable digests, and exact run inputs. */
export function verifyBenchmarkKernelFinalAttestation(
  input: unknown,
  expected: BenchmarkKernelAttestationExpectation
): BenchmarkKernelAttestationVerification {
  const errors: string[] = [];
  let attestation: BenchmarkKernelFinalAttestation | null = null;
  let expectedHash: string | null = null;
  let signatureVerified = false;
  try {
    attestation = parseAttestation(input);
    expectedHash = benchmarkKernelAttestationHash(attestation);
    if (attestation.attestation_hash !== expectedHash) errors.push("attestation_hash mismatch");

    assertCompiledConditionIntegrity(expected.condition);
    const scenario = BenchmarkScenarioSchema.parse(expected.scenario);
    if (benchmarkScenarioHash(scenario) !== expected.condition.scenarioHash) {
      throw new Error("expected scenario differs from the compiled condition scenario hash");
    }
    const world = parseBoundToolWorldState(scenario, expected.world);
    if (canonicalJson(world) !== canonicalJson(expected.world)) {
      throw new Error("expected ToolWorld contains missing, defaulted, or unsupported fields");
    }
    const evidenceBinding = validatedEvidenceBinding(expected.evidenceBinding);
    const transcriptReference = validatedTranscriptReference(expected.transcriptReference);
    const trusted = validatedTrust(expected.trust);
    const expectedBindings = bindingFor({
      runId: expected.runId,
      condition: expected.condition,
      scenario,
      world,
      evidenceBinding,
      signingKeyId: trusted.trust.keyId,
      signingPublicKeySha256: trusted.trust.publicKeySha256,
    });
    if (!sameJson(attestation.bindings, expectedBindings)) errors.push("attestation bindings differ from the expected run inputs");
    if (!sameJson(attestation.world_head, createBenchmarkKernelWorldHead(world))) errors.push("world_head differs from the authoritative final ToolWorld");
    if (!sameJson(attestation.transcript_reference, transcriptReference)) {
      errors.push("transcript_reference differs from the expected kernel transcript");
    }

    if (
      attestation.bindings.signing_key_id !== trusted.trust.keyId
      || attestation.bindings.signing_public_key_sha256 !== trusted.trust.publicKeySha256
      || attestation.signature.key_id !== trusted.trust.keyId
    ) {
      errors.push("attestation signing identity differs from the configured trust key");
    } else {
      signatureVerified = verifyBytes(
        null,
        Buffer.from(`${SIGNATURE_DOMAIN}${attestation.attestation_hash}`, "utf8"),
        trusted.publicKey,
        Buffer.from(attestation.signature.signature_base64, "base64")
      );
      if (!signatureVerified) errors.push("kernel attestation signature verification failed");
    }

    const capability = validateCapabilityHead(attestation.capability_head);
    assertCapabilityRelation(expected.condition, capability);
    const enforced = isFlowEnforced(expected.condition);
    const proof = attestation.flow_proof;
    if (enforced) {
      if (proof.applicability !== "flow_v2_enforced" || proof.execution_state === null) {
        errors.push("flow-enforced condition lacks a full FlowExecutionState proof");
      } else {
        const recomputed = createBenchmarkKernelFlowProof(expected.condition, capability, proof.execution_state);
        if (!sameJson(proof, recomputed)) errors.push("flow_proof digests or counts do not match its full FlowExecutionState");
      }
    } else {
      const recomputed = createBenchmarkKernelFlowProof(expected.condition, capability, null);
      if (!sameJson(proof, recomputed)) errors.push("unenforced condition has a non-canonical not-applicable flow proof");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "kernel attestation is invalid");
  }
  return Object.freeze({
    valid: errors.length === 0,
    expected_attestation_hash: expectedHash,
    signature_verified: signatureVerified,
    errors: Object.freeze(errors),
  });
}

export function benchmarkKernelAttestationJson(attestation: BenchmarkKernelFinalAttestation): string {
  const parsed = parseAttestation(attestation);
  const verificationHash = benchmarkKernelAttestationHash(parsed);
  if (parsed.attestation_hash !== verificationHash) throw new Error("cannot serialize a kernel attestation with an invalid hash");
  return `${canonicalJson(parsed)}\n`;
}

/** JSON-shaped representation for embedding references in other artifacts. */
export function benchmarkKernelAttestationReference(attestation: BenchmarkKernelFinalAttestation): JsonValue {
  return immutableJson({
    path: "kernel-attestation.json",
    attestation_hash: attestation.attestation_hash,
    world_state_sha256: attestation.world_head.state_sha256,
    flow_execution_state_sha256: attestation.flow_proof.execution_state_sha256,
  });
}

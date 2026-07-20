import {
  createHmac,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  canonicalJson,
  immutableJson,
  sha256Hex,
  verifyEventChain,
  type BenchmarkEventEnvelope,
  type JsonValue as ArtifactJsonValue,
} from "./artifacts";
import {
  benchmarkKernelAttestationPublicKeyFingerprint,
  type BenchmarkKernelAttestationExpectation,
  type BenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationTrust,
  type BenchmarkKernelCapabilityHead,
  type BenchmarkKernelFinalAttestation,
} from "./kernel-attestation";
import {
  createKernelTranscriptWorldHead,
  commitSensitiveTranscriptValues,
  parseKernelTranscript,
  verifyKernelTranscript,
  type PublicKernelTranscriptEntry,
} from "./kernel-transcript";
import {
  BenchmarkFreezeLockSchema,
  benchmarkFreezeLockSha256,
  type BenchmarkFreezeLock,
} from "./execution-plan";
import {
  type BenchmarkScenario,
  type JsonValue,
  type WorldReceipt,
} from "./scenario-schema";
import {
  createToolWorld,
  evaluateScenarioWorld,
  parseBoundToolWorldState,
  type ToolWorldState,
} from "./tool-world";
import {
  assembleStrictPassEvidence,
  decomposeStrictPass,
  evaluateJsonEvidencePredicate,
  scoreAssistantClaimTruth,
  scoreListenerSafety,
  scoreModelVsSystemIntegrity,
  scoreRequiredActionReceipts,
  scoreSpokenPolicy,
  scoreStrictPass,
  type AssistantClaimTruthScore,
  type AuthoritativeReceiptEvidence,
  type AuthoritativeTimelineVerification,
  type AuthoritativeWorldSnapshot,
  type JsonEvidencePredicate,
  type ListenerSafetyScore,
  type ModelIntegrityOpportunityEvaluation,
  type ModelIntegrityOpportunityFailureKind,
  type ModelSystemIntegrityScore,
  type NormalizationCoverage,
  type NormalizedAssistantClaim,
  type NormalizedSpokenPolicyAct,
  type RequiredActionReceiptScore,
  type RequiredActionRequirement,
  type SpokenPolicyRule,
  type SpokenPolicyScore,
  type StrictPassDecomposition,
  type StrictPassEvidence,
  type StrictPassScore,
  type ToolAttemptEvidence,
  type ToolExecutionEvidence,
  type TranscriptClaimSource,
} from "./scoring";

const TIMELINE_DOMAIN = "hacc/benchmark-evaluation-timeline/v1\n";
const TRANSCRIPT_SET_DOMAIN = "hacc/benchmark-evaluation-transcript-set/v1\n";
const CONTRACT_DOMAIN = "hacc/benchmark-evaluation-contract/v1\n";
const NORMALIZATION_PLAN_DOMAIN = "hacc/benchmark-normalization-plan/v1\n";
const NORMALIZATION_ARTIFACT_DOMAIN = "hacc/benchmark-normalization-artifact/v1\n";
const NORMALIZATION_SIGNATURE_DOMAIN = "hacc/benchmark-normalization-signature/v1\n";
const POLICY_CATALOG_DOMAIN = "hacc/benchmark-spoken-policy-catalog/v1\n";
const SPAN_DOMAIN = "hacc/benchmark-transcript-span/v1\n";
const KERNEL_SENSITIVE_VALUE_DOMAIN =
  "harshas-amazing-call-center/benchmark-kernel-sensitive-value/v1\n";
const SEMANTIC_INVENTORY_DOMAIN = "hacc/benchmark-semantic-inventory/v1\n";
const SEMANTIC_ASSURANCE_DOMAIN = "hacc/benchmark-semantic-assurance/v1\n";
const RUN_EVALUATION_DOMAIN = "hacc/benchmark-run-evaluation/v1\n";
const MODEL_OPPORTUNITY_MANIFEST_DOMAIN =
  "hacc/benchmark-model-opportunity-manifest/v1\n";
const BLIND_NORMALIZATION_PACKET_DOMAIN =
  "hacc/benchmark-blind-normalization-packet/v1\n";
const BLINDED_TIMELINE_DOMAIN =
  "hacc/benchmark-blinded-timeline-binding/v1\n";
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

// One event owns four lexicographically ordered phases. The scalar projection
// keeps the existing leaf scorers simple without trusting caller-supplied time.
const POSITION_STRIDE = 1_000_000;
const PHASE_STRIDE = 250_000;
const MAX_ORDINAL = PHASE_STRIDE - 1;

const VERIFIED_TIMELINE = Symbol("verified-evaluation-timeline");
const VERIFIED_BLIND_NORMALIZATION_PACKET = Symbol("verified-blind-normalization-packet");
const VERIFIED_NORMALIZATION = Symbol("verified-normalization");
const VERIFIED_SEMANTIC_ASSURANCE = Symbol("verified-semantic-assurance");
const VERIFIED_RUN_EVALUATION = Symbol("verified-run-evaluation");
const TRUSTED_TIMELINES = new WeakSet<object>();
const TRUSTED_BLIND_NORMALIZATION_PACKETS = new WeakMap<object, string>();
const TRUSTED_NORMALIZATIONS = new WeakSet<object>();
const TRUSTED_SEMANTIC_ASSURANCES = new WeakSet<object>();
const TRUSTED_RUN_EVALUATIONS = new WeakSet<object>();

export type EvaluationTimelinePhase =
  | "kernel_invoke"
  | "tool_world_delta"
  | "post_world_snapshot"
  | "outer_event";

export type EvaluationTimelinePosition = Readonly<{
  event_sequence: number;
  phase: EvaluationTimelinePhase;
  ordinal: number;
  scalar: number;
}>;

export type TranscriptDelivery = TranscriptClaimSource["delivery"];

export type EvaluationTranscriptUnit = Readonly<{
  unit_id: string;
  response_id: string;
  item_id: string | null;
  source: "audio" | "text";
  revision: boolean;
  emission_ordinal: number;
  turn: number | null;
  position: EvaluationTimelinePosition;
  evidence_cutoff_timeline_sequence: number;
  event_hash: string;
  text: string;
  text_utf8_byte_length: number;
  transcript_sha256: string;
  response_audio_sha256: string | null;
  response_audio_byte_length: number | null;
  delivery: TranscriptDelivery;
}>;

export type EvaluationTerminalObservation = Readonly<{
  status: string;
  error_count: number;
  budget_reservation_status: string;
  counters: Readonly<{
    turns_planned: number;
    turns_sent: number;
    tool_calls: number;
  }>;
}>;

export type CapabilityGrantComplianceEvidence = Readonly<{
  attempt_id: string;
  action: string | null;
  turn: number;
  compliant: boolean | null;
  evidence_role: "treatment_mechanism_diagnostic";
}>;

export type VerifiedEvaluationTimeline = Readonly<{
  [VERIFIED_TIMELINE]: true;
  schema_version: 1;
  run_id: string;
  timeline_sha256: string;
  event_chain_head_sha256: string;
  kernel_transcript_sha256: string;
  world_state_sha256: string;
  transcript_set_sha256: string;
  freeze_lock_sha256: string;
  frozen_bundle: readonly Readonly<{ path: string; sha256: string }>[];
  scenario: BenchmarkScenario;
  final_world: ToolWorldState;
  attempts: readonly ToolAttemptEvidence[];
  executions: readonly ToolExecutionEvidence[];
  capability_grant_compliance: readonly CapabilityGrantComplianceEvidence[];
  attempt_evidence_complete: boolean;
  execution_evidence_complete: boolean;
  receipts: readonly AuthoritativeReceiptEvidence[];
  world_snapshots: readonly AuthoritativeWorldSnapshot[];
  transcript_inventory: readonly EvaluationTranscriptUnit[];
  expected_normalization_unit_ids: readonly string[];
  coverage_issues: readonly string[];
  terminal: EvaluationTerminalObservation;
  timeline_verification: AuthoritativeTimelineVerification;
  authoritative_receipts_match_outputs: boolean;
}>;

export type EvidenceReplayError = Readonly<{
  code: string;
  message: string;
}>;

export type EvidenceReplayResult =
  | Readonly<{ ok: true; timeline: VerifiedEvaluationTimeline }>
  | Readonly<{ ok: false; errors: readonly EvidenceReplayError[] }>;

type OuterToolResult = Readonly<{
  event: BenchmarkEventEnvelope;
  turn: number;
  providerCallId: string;
  invocationId: string;
  requestedTool: string;
  action: string | null;
  receiptId: string | null;
  committed: boolean;
  authoritativeResult: ArtifactJsonValue | null;
  providerVisibleOutput: ArtifactJsonValue;
  visibleAt: number | null;
}>;

type PublicInvoke = Readonly<{
  entry: PublicKernelTranscriptEntry;
  providerCallId: string;
  turn: number;
  action: string;
  resultClass: string;
  capabilityGrantCommitment: string;
  independentlyAuthorizedByCapability: boolean;
  authoritativeResultHmacSha256: string;
  providerVisibleOutputHmacSha256: string;
  preCapabilityHead: BenchmarkKernelCapabilityHead;
  postWorldHead: ReturnType<typeof createKernelTranscriptWorldHead>;
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, label: string, max = 4_096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  const parsed = nonEmpty(value, label, 256);
  if (!SAFE_ID.test(parsed)) throw new Error(`${label} must be a safe identifier`);
  return parsed;
}

function relativeArtifactPath(value: unknown, label: string): string {
  const parsed = nonEmpty(value, label, 512);
  if (
    parsed.startsWith("/")
    || parsed.startsWith("\\")
    || parsed.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..")
  ) throw new Error(`${label} must be a normalized relative path`);
  return parsed;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function positive(value: unknown, label: string): number {
  const parsed = nonNegative(value, label);
  if (parsed === 0) throw new Error(`${label} must be positive`);
  return parsed;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function hashDomain(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function kernelValueHmac(secret: string, path: string, value: unknown): string {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("kernel commitment opening secret must contain at least 32 characters");
  }
  return createHmac("sha256", secret)
    .update(KERNEL_SENSITIVE_VALUE_DOMAIN)
    .update("\n")
    .update(path)
    .update("\n")
    .update(canonicalJson(value))
    .digest("hex");
}

function phaseIndex(phase: EvaluationTimelinePhase): number {
  switch (phase) {
    case "kernel_invoke": return 0;
    case "tool_world_delta": return 1;
    case "post_world_snapshot": return 2;
    case "outer_event": return 3;
  }
}

function position(
  eventSequence: number,
  phase: EvaluationTimelinePhase,
  ordinal = 0
): EvaluationTimelinePosition {
  nonNegative(eventSequence, "timeline event sequence");
  nonNegative(ordinal, "timeline ordinal");
  if (ordinal > MAX_ORDINAL) throw new Error("timeline ordinal exceeds its frozen phase bound");
  const scalar = 1 + eventSequence * POSITION_STRIDE + phaseIndex(phase) * PHASE_STRIDE + ordinal;
  if (!Number.isSafeInteger(scalar)) throw new Error("timeline position exceeds JSON-safe precision");
  return Object.freeze({ event_sequence: eventSequence, phase, ordinal, scalar });
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function setPath(root: Record<string, JsonValue>, path: string, value: JsonValue): void {
  const parts = path.split(".");
  let cursor: Record<string, JsonValue> | JsonValue[] = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const current = Array.isArray(cursor) ? cursor[Number(part)] : cursor[part];
    if (current === null || typeof current !== "object") {
      throw new Error(`effect path ${path} has no object parent`);
    }
    cursor = current as Record<string, JsonValue> | JsonValue[];
  }
  const leaf = parts.at(-1)!;
  if (Array.isArray(cursor)) cursor[Number(leaf)] = structuredClone(value);
  else cursor[leaf] = structuredClone(value);
}

function reconstructWorldAtHead(
  scenario: BenchmarkScenario,
  finalWorld: ToolWorldState,
  head: ReturnType<typeof createKernelTranscriptWorldHead>
): ToolWorldState {
  if (
    head.admission_count > finalWorld.admissions.length
    || head.receipt_count > finalWorld.receipts.length
    || head.effect_count > finalWorld.effects.length
    || head.event_count > finalWorld.events.length
  ) throw new Error("kernel world head exceeds the signed final ToolWorld ledger");
  const effects = finalWorld.effects.slice(0, head.effect_count);
  const facts = structuredClone(scenario.initial_facts);
  for (const effect of effects) setPath(facts, effect.path, effect.after);
  const receipts = finalWorld.receipts.slice(0, head.receipt_count);
  const attempts: Record<string, number> = {};
  for (const receipt of receipts) {
    attempts[receipt.tool] = Math.max(attempts[receipt.tool] ?? 0, receipt.attempt);
  }
  const candidate = parseBoundToolWorldState(scenario, {
    schema_version: finalWorld.schema_version,
    scenario_id: finalWorld.scenario_id,
    scenario_version: finalWorld.scenario_version,
    scenario_hash: finalWorld.scenario_hash,
    facts,
    attempts,
    admissions: finalWorld.admissions.slice(0, head.admission_count),
    receipts,
    effects,
    events: finalWorld.events.slice(0, head.event_count),
    next_event_sequence: head.next_event_sequence,
  });
  if (!canonicalEqual(createKernelTranscriptWorldHead(candidate), head)) {
    throw new Error("signed kernel world head does not match its reconstructed ToolWorld prefix");
  }
  return candidate;
}

function publicInvoke(
  entry: PublicKernelTranscriptEntry,
  preSnapshot: Record<string, unknown>
): PublicInvoke {
  const payload = record(entry.payload, `kernel entry ${entry.sequence} payload`);
  const input = record(payload.input, `kernel entry ${entry.sequence} input`);
  const outcome = record(payload.outcome, `kernel entry ${entry.sequence} outcome`);
  const pre = record(payload.pre_state, `kernel entry ${entry.sequence} pre_state`);
  const post = record(payload.post_state, `kernel entry ${entry.sequence} post_state`);
  const head = record(post.authoritative_world_head, `kernel entry ${entry.sequence} world head`);
  const snapshotActions = preSnapshot.actions;
  if (!Array.isArray(snapshotActions)) throw new Error("public pre-invoke capability snapshot has no actions");
  const action = safeId(input.action, `kernel entry ${entry.sequence} action`);
  const grantCommitment = sha(
    input.capability_grant_commitment,
    `kernel entry ${entry.sequence} capability grant commitment`
  );
  const offered = snapshotActions
    .map((item, index) => record(item, `public capability snapshot action[${index}]`))
    .find((item) => item.name === action);
  return Object.freeze({
    entry,
    providerCallId: safeId(input.provider_call_id, `kernel entry ${entry.sequence} provider_call_id`),
    turn: nonNegative(input.turn, `kernel entry ${entry.sequence} turn`),
    action,
    resultClass: nonEmpty(outcome.result_class, `kernel entry ${entry.sequence} result_class`, 128),
    capabilityGrantCommitment: grantCommitment,
    independentlyAuthorizedByCapability: offered !== undefined
      && sha(
        offered.capability_grant_commitment,
        `kernel entry ${entry.sequence} offered capability grant commitment`
      ) === grantCommitment,
    authoritativeResultHmacSha256: sha(
      outcome.authoritative_result_hmac_sha256,
      `kernel entry ${entry.sequence} authoritative result HMAC`
    ),
    providerVisibleOutputHmacSha256: sha(
      outcome.provider_visible_output_hmac_sha256,
      `kernel entry ${entry.sequence} provider-visible output HMAC`
    ),
    preCapabilityHead: record(
      pre.capability_head,
      `kernel entry ${entry.sequence} pre capability head`
    ) as BenchmarkKernelCapabilityHead,
    postWorldHead: head as ReturnType<typeof createKernelTranscriptWorldHead>,
  });
}

function isArtifactRecord(
  value: ArtifactJsonValue
): value is { readonly [key: string]: ArtifactJsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrapProviderVisibleOutput(value: ArtifactJsonValue): ArtifactJsonValue {
  if (isArtifactRecord(value) && Object.hasOwn(value, "gateway_result")) {
    return value["gateway_result"];
  }
  return value;
}

function validateOuterResultAgainstWorld(
  outer: OuterToolResult,
  world: ToolWorldState,
  resultClass: string
): WorldReceipt | null {
  if (outer.authoritativeResult === null) throw new Error("kernel invoke has no outer authoritative result");
  const authoritative = record(outer.authoritativeResult, "outer authoritative result");
  const ok = bool(authoritative.ok, "outer authoritative result.ok");
  if (resultClass.startsWith("success_") !== ok) {
    throw new Error("kernel result class disagrees with the outer authoritative result");
  }
  if (!ok) {
    const code = nonEmpty(authoritative.code, "outer authoritative failure code", 128);
    if (resultClass === "provider_call_id_conflict" && code !== "provider_call_id_conflict") {
      throw new Error("kernel conflict result disagrees with outer failure code");
    }
    if (!canonicalEqual(unwrapProviderVisibleOutput(outer.providerVisibleOutput), outer.authoritativeResult)) {
      throw new Error("failed outer gateway result differs from the provider-visible result");
    }
    if (outer.receiptId === null) {
      if (outer.committed) throw new Error("receipt-free gateway failure cannot claim a committed effect");
      return null;
    }
    const receipt = world.receipts.find((candidate) => candidate.receipt_id === outer.receiptId);
    if (!receipt) throw new Error("failed gateway result references no signed ToolWorld receipt");
    if (
      outer.action === null
      || receipt.tool !== outer.action
      || receipt.invocation_id !== outer.invocationId
      || receipt.turn !== outer.turn
      || receipt.committed !== outer.committed
      || receipt.visible_result.ok !== false
      || receipt.visible_result.error.code !== code
      || receipt.visible_result.error.message !== authoritative.message
      || receipt.visible_result.error.retriable !== authoritative.retriable
    ) throw new Error("failed gateway result disagrees with its signed ToolWorld receipt");
    return receipt;
  }
  const action = safeId(authoritative.action, "outer authoritative result.action");
  const receiptId = nonEmpty(authoritative.receipt_id, "outer authoritative result.receipt_id");
  if (action !== outer.action || receiptId !== outer.receiptId) {
    throw new Error("outer gateway result does not match its action/receipt envelope");
  }
  const receipt = world.receipts.find((candidate) => candidate.receipt_id === receiptId);
  if (!receipt) throw new Error("outer gateway result references no signed ToolWorld receipt");
  if (
    receipt.tool !== action
    || receipt.invocation_id !== outer.invocationId
    || receipt.turn !== outer.turn
    || receipt.committed !== outer.committed
    || !canonicalEqual(receipt.authoritative_result, authoritative.authoritative_result)
  ) throw new Error("outer gateway result disagrees with the signed ToolWorld receipt");
  const visible = unwrapProviderVisibleOutput(outer.providerVisibleOutput);
  if (!canonicalEqual(visible, outer.authoritativeResult)
    && !canonicalEqual(visible, receipt.visible_result)) {
    throw new Error("outer provider-visible result is not the authoritative gateway result or signed visible leaf result");
  }
  return receipt;
}

function replayError(code: string, error: unknown): EvidenceReplayError {
  return Object.freeze({
    code,
    message: error instanceof Error ? error.message : String(error),
  });
}

type RawTranscriptUnit = Readonly<{
  event: BenchmarkEventEnvelope;
  responseId: string;
  itemId: string | null;
  source: "audio" | "text";
  revision: boolean;
  emissionOrdinal: number;
  turn: number | null;
  text: string;
}>;

type MutableOuterToolResult = Omit<OuterToolResult, "visibleAt"> & { visibleAt: number | null };

type ReceivedToolCall = Readonly<{
  providerCallId: string;
  turn: number;
  eventSequence: number;
}>;

function attemptEvidenceId(outer: OuterToolResult): string {
  return `attempt:${outer.event.sequence}:${sha256Hex(outer.providerCallId).slice(0, 24)}`;
}

function executionEvidenceId(receipt: WorldReceipt): string {
  return `execution:${sha256Hex(receipt.receipt_id).slice(0, 32)}`;
}

function parseStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return Object.freeze(value.map((item, index) => safeId(item, `${label}[${index}]`)));
}

function transcriptDelivery(
  responseId: string,
  hasAudio: boolean,
  audibility: ReadonlyMap<string, Readonly<{
    playbackObserved: boolean;
    generatedThroughMs: number;
    playedThroughMs: number | null;
  }>>
): TranscriptDelivery {
  if (!hasAudio) return "generated_unheard";
  const observed = audibility.get(responseId);
  if (!observed || !observed.playbackObserved || observed.playedThroughMs === null) return "unknown";
  if (observed.playedThroughMs <= 0) return "generated_unheard";
  if (observed.playedThroughMs >= observed.generatedThroughMs) return "audible";
  return "unknown";
}

function terminalObservation(event: BenchmarkEventEnvelope): EvaluationTerminalObservation {
  const payload = record(event.payload, "trial.finished payload");
  const counters = record(payload.counters, "trial.finished counters");
  return Object.freeze({
    status: nonEmpty(payload.status, "trial.finished status", 128),
    error_count: nonNegative(payload.error_count, "trial.finished error_count"),
    budget_reservation_status: nonEmpty(
      payload.budget_reservation_status,
      "trial.finished budget reservation status",
      128
    ),
    counters: Object.freeze({
      turns_planned: nonNegative(counters.turnsPlanned, "trial.finished counters.turnsPlanned"),
      turns_sent: nonNegative(counters.turnsSent, "trial.finished counters.turnsSent"),
      tool_calls: nonNegative(counters.toolCalls, "trial.finished counters.toolCalls"),
    }),
  });
}

/**
 * Build the only scoring-eligible timeline from the signed public kernel replay,
 * the signed final ToolWorld preimage, and the outer hash-chained observations.
 * Invalid or ambiguous joins return errors; no partially trusted timeline leaks.
 */
export function replayEvaluationEvidence(input: Readonly<{
  events: readonly BenchmarkEventEnvelope[];
  kernelTranscript: string;
  finalAttestation: BenchmarkKernelFinalAttestation;
  attestationExpectation: BenchmarkKernelAttestationExpectation;
  freezeLock: BenchmarkFreezeLock;
  commitmentOpeningSecret: string;
}>): EvidenceReplayResult {
  const errors: EvidenceReplayError[] = [];
  try {
    const eventVerification = verifyEventChain(input.events);
    if (!eventVerification.valid || !eventVerification.chain_head || !eventVerification.run_id) {
      return Object.freeze({
        ok: false as const,
        errors: Object.freeze(eventVerification.errors.map((message) => replayError(
          "invalid_event_chain",
          message
        ))),
      });
    }
    const kernelVerification = verifyKernelTranscript({
      transcript: input.kernelTranscript,
      finalAttestation: input.finalAttestation,
      attestationExpectation: input.attestationExpectation,
    });
    if (
      !kernelVerification.valid
      || kernelVerification.authenticity !== "signed_attestation_verified"
      || !kernelVerification.reference
      || !kernelVerification.reconstructed.authoritative_world_head
    ) {
      return Object.freeze({
        ok: false as const,
        errors: Object.freeze(kernelVerification.errors.map((message) => replayError(
          "invalid_kernel_replay",
          message
        ))),
      });
    }
    if (kernelVerification.run_id !== eventVerification.run_id) {
      throw new Error("event chain and kernel transcript have different run IDs");
    }
    const freezeLock = BenchmarkFreezeLockSchema.parse(input.freezeLock);
    const freezeLockSha256 = benchmarkFreezeLockSha256(freezeLock);
    if (
      freezeLockSha256 !== input.finalAttestation.bindings.freeze_lock_sha256
      || freezeLockSha256 !== input.attestationExpectation.evidenceBinding.freezeLockSha256
    ) throw new Error("kernel attestation is not bound to the supplied benchmark freeze lock");
    if (
      freezeLock.kernel_attestation.key_id !== input.attestationExpectation.trust.keyId
      || freezeLock.kernel_attestation.public_key_fingerprint_sha256
        !== input.attestationExpectation.trust.publicKeySha256
      || freezeLock.kernel_attestation.public_key_pem
        !== input.attestationExpectation.trust.publicKeyPem
    ) throw new Error("kernel attestation trust differs from the preregistered freeze lock");
    const runId = eventVerification.run_id;
    const scenario = input.attestationExpectation.scenario;
    const finalWorld = parseBoundToolWorldState(scenario, input.attestationExpectation.world);
    if (!canonicalEqual(createKernelTranscriptWorldHead(finalWorld), input.finalAttestation.world_head)) {
      throw new Error("supplied final ToolWorld is not the signed attestation preimage");
    }
    const transcript = parseKernelTranscript(input.kernelTranscript);
    const initialize = transcript.entries[0];
    const initializePayload = record(initialize.payload, "public kernel initialize payload");
    const initializePost = record(initializePayload.post_state, "public kernel initialize post_state");
    const initializeHead = record(
      initializePost.authoritative_world_head,
      "public kernel initialize world head"
    ) as ReturnType<typeof createKernelTranscriptWorldHead>;
    const initialWorld = reconstructWorldAtHead(scenario, finalWorld, initializeHead);
    if (!canonicalEqual(initialWorld, createToolWorld(scenario))) {
      throw new Error("public kernel transcript does not start at the canonical scenario world");
    }

    const ignoredNormalizedSequences = new Set<number>();
    for (const [index, event] of input.events.entries()) {
      if (event.event_type !== "provider.response_event_ignored") continue;
      const prior = input.events[index - 1];
      if (!prior || prior.event_type !== "provider.normalized") {
        throw new Error("provider.response_event_ignored must immediately follow its normalized event");
      }
      const ignored = record(event.payload, "provider.response_event_ignored payload");
      const normalized = record(prior.payload, "ignored provider.normalized payload");
      const normalizedResponseId = normalized.responseId === undefined
        ? null
        : safeId(normalized.responseId, "ignored provider.normalized responseId");
      if (
        nonEmpty(ignored.event_type, "provider.response_event_ignored event_type", 128)
          !== normalized.type
        || (ignored.response_id === null
          ? null
          : safeId(ignored.response_id, "provider.response_event_ignored response_id"))
          !== normalizedResponseId
      ) throw new Error("provider.response_event_ignored does not identify its prior normalized event");
      if (ignoredNormalizedSequences.has(prior.sequence)) {
        throw new Error("one normalized event cannot be ignored more than once");
      }
      ignoredNormalizedSequences.add(prior.sequence);
    }

    const outerResults: MutableOuterToolResult[] = [];
    const receivedToolCalls: ReceivedToolCall[] = [];
    const pendingByCallId = new Map<string, MutableOuterToolResult[]>();
    const rawTranscripts: RawTranscriptUnit[] = [];
    const responseTurns = new Map<string, number | null>();
    const responseFirstOutputSequence = new Map<string, number>();
    const terminalResponseIds = new Set<string>();
    const outputAudioResponses = new Set<string>();
    const outputAudioChunks = new Map<string, Array<Readonly<{
      byteLength: number;
      sha256: string;
    }>>>();
    const finalCounts = new Map<string, number>();
    const finalKeys = new Map<string, number>();
    const coverageIssues: string[] = [];
    const audibility = new Map<string, {
      playbackObserved: boolean;
      generatedThroughMs: number;
      playedThroughMs: number | null;
      generatedAudioBytes: number;
      generatedAudioSha256: string;
    }>();
    let activeTurn: number | null = null;
    let terminal: EvaluationTerminalObservation | null = null;
    let attestationEventCount = 0;
    let turnIntentCount = 0;
    let turnCommitCount = 0;
    let turnSentCount = 0;
    let turnCompletedCount = 0;
    let activeTurnCommitted = false;

    const validateCallerTurn = (
      payload: Record<string, unknown>,
      label: string,
      expectedOrdinal: number
    ): number => {
      const ordinal = positive(payload.ordinal, `${label} ordinal`);
      if (ordinal !== expectedOrdinal || ordinal > scenario.caller.turns.length) {
        throw new Error(`${label} ordinal is not the next planned caller turn`);
      }
      const expected = scenario.caller.turns[ordinal - 1];
      if (safeId(payload.turn_id, `${label} turn_id`) !== expected.id) {
        throw new Error(`${label} turn_id differs from the frozen scenario`);
      }
      return ordinal;
    };

    for (const event of input.events) {
      if (event.event_type === "caller.turn_delivery_intent") {
        const payload = record(event.payload, "caller.turn_delivery_intent payload");
        const ordinal = validateCallerTurn(
          payload,
          "caller.turn_delivery_intent",
          turnIntentCount + 1
        );
        if (activeTurn !== null) throw new Error("caller turns overlap in the event chain");
        turnIntentCount += 1;
        activeTurn = ordinal;
        activeTurnCommitted = false;
        continue;
      }
      if (event.event_type === "caller.turn_commit_intent") {
        const payload = record(event.payload, "caller.turn_commit_intent payload");
        const turn = positive(payload.turn, "caller.turn_commit_intent turn");
        if (
          turn !== turnCommitCount + 1
          || activeTurn !== turn
          || activeTurnCommitted
          || turn > scenario.caller.turns.length
          || safeId(payload.turn_id, "caller.turn_commit_intent turn_id")
            !== scenario.caller.turns[turn - 1].id
        ) throw new Error("caller.turn_commit_intent is not the next frozen caller turn");
        turnCommitCount += 1;
        activeTurnCommitted = true;
        continue;
      }
      if (event.event_type === "caller.turn_sent") {
        const payload = record(event.payload, "caller.turn_sent payload");
        const ordinal = validateCallerTurn(payload, "caller.turn_sent", turnSentCount + 1);
        if (activeTurn !== ordinal || turnIntentCount !== ordinal || !activeTurnCommitted) {
          throw new Error("caller.turn_sent has no matching committed delivery intent");
        }
        turnSentCount += 1;
        continue;
      }
      if (event.event_type === "caller.turn_completed") {
        const payload = record(event.payload, "caller.turn_completed payload");
        const ordinal = validateCallerTurn(
          payload,
          "caller.turn_completed",
          turnCompletedCount + 1
        );
        if (activeTurn !== ordinal || turnSentCount !== ordinal) {
          throw new Error("caller turn completion is not order preserving");
        }
        turnCompletedCount += 1;
        activeTurn = null;
        activeTurnCommitted = false;
        continue;
      }
      if (event.event_type === "tool.batch_received") {
        const payload = record(event.payload, "tool.batch_received payload");
        const turn = positive(payload.turn, "tool.batch_received turn");
        if (activeTurn !== turn || turnSentCount !== turn) {
          throw new Error("tool.batch_received is outside its authoritative caller-turn window");
        }
        const callIds = parseStringArray(payload.call_ids, "tool.batch_received call_ids");
        if (callIds.length === 0 || new Set(callIds).size !== callIds.length) {
          throw new Error("tool.batch_received must contain unique provider call IDs");
        }
        if (nonNegative(payload.call_count, "tool.batch_received call_count") !== callIds.length) {
          throw new Error("tool.batch_received call count mismatch");
        }
        for (const providerCallId of callIds) {
          receivedToolCalls.push(Object.freeze({
            providerCallId,
            turn,
            eventSequence: event.sequence,
          }));
        }
        continue;
      }
      if (event.event_type === "tool.call_result") {
        const payload = record(event.payload, "tool.call_result payload");
        const providerCallId = safeId(payload.provider_call_id, "tool.call_result provider_call_id");
        const authoritative = payload.authoritative_gateway_result as ArtifactJsonValue | null;
        if (authoritative !== null && (typeof authoritative !== "object" || Array.isArray(authoritative))) {
          throw new Error("tool.call_result authoritative_gateway_result is malformed");
        }
        const result: MutableOuterToolResult = {
          event,
          turn: positive(payload.turn, "tool.call_result turn"),
          providerCallId,
          invocationId: safeId(payload.invocation_id, "tool.call_result invocation_id"),
          requestedTool: safeId(payload.requested_tool, "tool.call_result requested_tool"),
          action: payload.action === null ? null : safeId(payload.action, "tool.call_result action"),
          receiptId: payload.receipt_id === null
            ? null
            : nonEmpty(payload.receipt_id, "tool.call_result receipt_id"),
          committed: bool(payload.committed, "tool.call_result committed"),
          authoritativeResult: authoritative,
          providerVisibleOutput: payload.provider_visible_output as ArtifactJsonValue,
          visibleAt: null,
        };
        outerResults.push(result);
        pendingByCallId.set(providerCallId, [...(pendingByCallId.get(providerCallId) ?? []), result]);
        continue;
      }
      if (event.event_type === "tool.batch_submitted") {
        const payload = record(event.payload, "tool.batch_submitted payload");
        const callIds = parseStringArray(payload.call_ids, "tool.batch_submitted call_ids");
        if (new Set(callIds).size !== callIds.length) {
          throw new Error("tool.batch_submitted contains duplicate provider call IDs");
        }
        const visibleAt = position(event.sequence, "outer_event").scalar;
        for (const callId of callIds) {
          const queue = pendingByCallId.get(callId) ?? [];
          const result = queue.shift();
          if (!result || result.event.sequence >= event.sequence) {
            throw new Error("tool.batch_submitted has no prior unmatched tool.call_result");
          }
          result.visibleAt = visibleAt;
          pendingByCallId.set(callId, queue);
        }
        if (nonNegative(payload.result_count, "tool.batch_submitted result_count") !== callIds.length) {
          throw new Error("tool.batch_submitted result count mismatch");
        }
        continue;
      }
      if (event.event_type === "provider.normalized") {
        if (ignoredNormalizedSequences.has(event.sequence)) continue;
        const payload = record(event.payload, "provider.normalized payload");
        const responseScoped = new Set([
          "response.started",
          "response.completed",
          "tool.calls",
          "output.audio",
          "output.transcript",
          "turn.interrupted",
        ]).has(String(payload.type));
        if (!responseScoped) continue;
        if (activeTurn === null || !activeTurnCommitted) {
          throw new Error("accepted provider response output precedes the caller commit boundary");
        }
        const responseId = safeId(payload.responseId, "provider.normalized responseId");
        const priorTurn = responseTurns.get(responseId);
        if (priorTurn === undefined) responseTurns.set(responseId, activeTurn);
        else if (priorTurn !== activeTurn) throw new Error(`response ${responseId} crosses caller turns`);
        if (terminalResponseIds.has(responseId)) {
          throw new Error(`response ${responseId} emitted accepted output after response.completed`);
        }
        if (payload.type === "response.completed") {
          terminalResponseIds.add(responseId);
          continue;
        }
        if (payload.type !== "output.transcript" && payload.type !== "output.audio") continue;
        if (!responseFirstOutputSequence.has(responseId)) {
          responseFirstOutputSequence.set(responseId, event.sequence);
        }
        if (payload.type === "output.audio") {
          const audio = record(payload.audio, "provider.normalized output.audio bytes");
          const chunks = outputAudioChunks.get(responseId) ?? [];
          chunks.push(Object.freeze({
            byteLength: positive(audio.byte_length, "output.audio byte_length"),
            sha256: sha(audio.sha256, "output.audio sha256"),
          }));
          outputAudioChunks.set(responseId, chunks);
          outputAudioResponses.add(responseId);
          continue;
        }
        if (payload.phase !== "final") continue;
        const text = typeof payload.text === "string" ? payload.text : null;
        if (text === null) throw new Error("final output transcript has no text");
        const itemId = payload.itemId === undefined ? null : safeId(payload.itemId, "output transcript itemId");
        if (payload.source !== "audio" && payload.source !== "text") {
          throw new Error("final output transcript has an invalid source");
        }
        const key = `${responseId}\0${itemId ?? "$anonymous"}\0${payload.source}`;
        const priorFinals = finalKeys.get(key) ?? 0;
        const revised = payload.revised === true;
        if (priorFinals > 0 && !revised) {
          coverageIssues.push(`response ${responseId} has conflicting finals without an explicit revision`);
        }
        finalKeys.set(key, priorFinals + 1);
        const emissionOrdinal = (finalCounts.get(responseId) ?? 0) + 1;
        finalCounts.set(responseId, emissionOrdinal);
        rawTranscripts.push(Object.freeze({
          event,
          responseId,
          itemId,
          source: payload.source,
          revision: revised,
          emissionOrdinal,
          turn: responseTurns.get(responseId) ?? null,
          text,
        }));
        continue;
      }
      if (event.event_type === "audibility.response_recorded") {
        const payload = record(event.payload, "audibility.response_recorded payload");
        const responseId = safeId(payload.response_id, "audibility response_id");
        if (audibility.has(responseId)) throw new Error("duplicate audibility response evidence");
        const boundTurn = responseTurns.get(responseId);
        if (boundTurn === undefined || positive(payload.turn, "audibility turn") !== boundTurn) {
          throw new Error("audibility evidence is not bound to its accepted response turn");
        }
        const generatedAudioBytes = positive(
          payload.generated_audio_bytes,
          "audibility generated_audio_bytes"
        );
        const generatedAudioSha256 = sha(
          payload.generated_audio_sha256,
          "audibility generated_audio_sha256"
        );
        const chunks = outputAudioChunks.get(responseId) ?? [];
        if (chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) !== generatedAudioBytes) {
          throw new Error("audibility aggregate byte length differs from accepted output.audio chunks");
        }
        if (chunks.length === 1 && chunks[0].sha256 !== generatedAudioSha256) {
          throw new Error("audibility aggregate hash differs from its only output.audio chunk");
        }
        audibility.set(responseId, {
          playbackObserved: bool(payload.playback_observed, "audibility playback_observed"),
          generatedThroughMs: positive(payload.generated_through_ms, "audibility generated_through_ms"),
          playedThroughMs: payload.played_through_ms === null
            ? null
            : nonNegative(payload.played_through_ms, "audibility played_through_ms"),
          generatedAudioBytes,
          generatedAudioSha256,
        });
        continue;
      }
      if (event.event_type === "kernel.final_state_attested") {
        attestationEventCount += 1;
        const payload = record(event.payload, "kernel.final_state_attested payload");
        if (
          sha(payload.attestation_hash, "kernel attestation event hash") !== input.finalAttestation.attestation_hash
          || sha(payload.world_state_sha256, "kernel attestation event world hash")
            !== input.finalAttestation.world_head.state_sha256
          || sha(payload.transcript_sha256, "kernel attestation event transcript hash")
            !== kernelVerification.reference.transcript_sha256
          || sha(payload.transcript_head_sha256, "kernel attestation event transcript head")
            !== kernelVerification.reference.transcript_head_sha256
          || positive(payload.transcript_entry_count, "kernel attestation event transcript count")
            !== kernelVerification.reference.transcript_entry_count
        ) throw new Error("kernel.final_state_attested does not match the signed proof");
        continue;
      }
      if (event.event_type === "trial.finished") {
        if (terminal !== null) throw new Error("event chain contains multiple trial.finished markers");
        terminal = terminalObservation(event);
      }
    }
    if (activeTurn !== null) coverageIssues.push("last caller turn has no completion event");
    if (!terminal || input.events.at(-1)?.event_type !== "trial.finished") {
      throw new Error("trial.finished must be the unique final event");
    }
    if (attestationEventCount !== 1) throw new Error("event chain must contain one matching kernel attestation event");
    if (input.events.at(-2)?.event_type !== "kernel.final_state_attested") {
      throw new Error("kernel.final_state_attested must be the last proof before trial.finished");
    }
    if (
      terminal.counters.turns_planned !== scenario.caller.turns.length
      || terminal.counters.turns_sent !== turnSentCount
      || terminal.counters.tool_calls !== receivedToolCalls.length
    ) throw new Error("trial.finished counters are not reconciled to the replayed event chain");
    if (terminal.status === "completed" && (
      turnIntentCount !== scenario.caller.turns.length
      || turnCommitCount !== scenario.caller.turns.length
      || turnSentCount !== scenario.caller.turns.length
      || turnCompletedCount !== scenario.caller.turns.length
      || activeTurn !== null
      || terminal.error_count !== 0
    )) throw new Error("completed trial does not contain the full frozen caller-turn horizon");

    const structuralAttemptEvidenceComplete = receivedToolCalls.length === outerResults.length
      && receivedToolCalls.every((call, index) =>
        call.providerCallId === outerResults[index].providerCallId
        && call.turn === outerResults[index].turn
        && call.eventSequence < outerResults[index].event.sequence
      );

    let currentCapabilitySnapshot = record(
      initializePayload.provider_visible_capability_snapshot,
      "public kernel initialize capability snapshot"
    );
    const invokes: PublicInvoke[] = [];
    for (const entry of transcript.entries.filter((candidate) => candidate.operation === "invoke")) {
      const invoke = publicInvoke(entry, currentCapabilitySnapshot);
      invokes.push(invoke);
      const payload = record(entry.payload, `kernel entry ${entry.sequence} payload`);
      const outcome = record(payload.outcome, `kernel entry ${entry.sequence} outcome`);
      if (outcome.capability_snapshot !== null) {
        currentCapabilitySnapshot = record(
          outcome.capability_snapshot,
          `kernel entry ${entry.sequence} capability snapshot`
        );
      }
    }
    const authoritativeOuter = outerResults.filter((result) => result.authoritativeResult !== null);
    if (authoritativeOuter.length !== invokes.length) {
      throw new Error("outer authoritative results and kernel invocations are not bijective");
    }
    const receipts: AuthoritativeReceiptEvidence[] = [];
    const receiptAttemptIds = new Map<string, string>();
    const invokesByAttemptId = new Map<string, PublicInvoke>();
    const worldSnapshots: AuthoritativeWorldSnapshot[] = [Object.freeze({
      timeline_sequence: 0,
      world: immutableJson(initialWorld) as unknown as JsonValue,
    })];
    let priorWorld = initialWorld;
    for (const [index, invoke] of invokes.entries()) {
      const outer = authoritativeOuter[index];
      if (
        invoke.providerCallId !== outer.providerCallId
        || invoke.turn !== outer.turn
        || invoke.action !== outer.action
      ) throw new Error(`kernel invocation ${index + 1} is unmatched or reordered`);
      const committedAuthoritative = commitSensitiveTranscriptValues(
        outer.authoritativeResult,
        input.commitmentOpeningSecret
      );
      const committedVisible = commitSensitiveTranscriptValues(
        outer.providerVisibleOutput,
        input.commitmentOpeningSecret
      );
      if (
        kernelValueHmac(
          input.commitmentOpeningSecret,
          `$invoke[${invoke.entry.sequence}].authoritative_result`,
          committedAuthoritative
        ) !== invoke.authoritativeResultHmacSha256
        || kernelValueHmac(
          input.commitmentOpeningSecret,
          `$invoke[${invoke.entry.sequence}].provider_visible_output`,
          committedVisible
        ) !== invoke.providerVisibleOutputHmacSha256
      ) throw new Error("outer plaintext gateway output does not open its signed kernel commitment");
      invokesByAttemptId.set(attemptEvidenceId(outer), invoke);
      const nextWorld = reconstructWorldAtHead(scenario, finalWorld, invoke.postWorldHead);
      const appendedReceipts = nextWorld.receipts.slice(priorWorld.receipts.length);
      const appendedAdmissions = nextWorld.admissions.slice(priorWorld.admissions.length);
      const appendedEffects = nextWorld.effects.slice(priorWorld.effects.length);
      if (appendedReceipts.length > 1) throw new Error("one kernel invoke appended multiple ToolWorld receipts");
      for (const item of [...appendedReceipts, ...appendedAdmissions, ...appendedEffects]) {
        if (item.invocation_id !== outer.invocationId) {
          throw new Error("ToolWorld delta belongs to a different outer invocation");
        }
      }
      const receipt = validateOuterResultAgainstWorld(outer, nextWorld, invoke.resultClass);
      if (appendedReceipts.length === 1 && receipt?.receipt_id !== appendedReceipts[0].receipt_id) {
        throw new Error("outer result does not identify the receipt appended by its kernel invocation");
      }
      if (appendedReceipts.length === 0 && receipt && !priorWorld.receipts.some(
        (candidate) => candidate.receipt_id === receipt.receipt_id
      )) throw new Error("replayed result references a receipt outside the prior signed world");
      const outerAnchor = outer.event.sequence;
      if (outerAnchor === 0) throw new Error("tool.call_result cannot be the first outer event");
      if (appendedReceipts.length === 1) {
        receiptAttemptIds.set(appendedReceipts[0].receipt_id, attemptEvidenceId(outer));
        receipts.push(Object.freeze({
          timeline_sequence: position(outerAnchor, "tool_world_delta", 0).scalar,
          provider_visible_timeline_sequence: outer.visibleAt,
          receipt: appendedReceipts[0],
        }));
      }
      worldSnapshots.push(Object.freeze({
        timeline_sequence: position(outerAnchor, "post_world_snapshot").scalar,
        world: immutableJson(nextWorld) as unknown as JsonValue,
      }));
      priorWorld = nextWorld;
    }
    if (!canonicalEqual(priorWorld, finalWorld)) {
      throw new Error("kernel invocation prefixes do not reconstruct the signed final ToolWorld");
    }

    const appendedReceiptByAttempt = new Map<string, WorldReceipt>();
    for (const receipt of finalWorld.receipts) {
      const attemptId = receiptAttemptIds.get(receipt.receipt_id);
      if (attemptId) appendedReceiptByAttempt.set(attemptId, receipt);
    }
    const conditionCapabilities = [
      ...scenario.tools.map((tool) => ({ name: tool.name, category: "leaf" as const })),
      ...input.attestationExpectation.condition.visibleCapabilities,
      ...input.attestationExpectation.condition.disclosures.flatMap((item) => item.visibleCapabilities),
    ];
    const controlActions = new Set(conditionCapabilities
      .filter((item) => item.category !== "leaf")
      .map((item) => item.name));
    const capabilityGrantCompliance: CapabilityGrantComplianceEvidence[] = outerResults.map((outer) => {
      const invoke = invokesByAttemptId.get(attemptEvidenceId(outer));
      return Object.freeze({
        attempt_id: attemptEvidenceId(outer),
        action: outer.action,
        turn: outer.turn,
        compliant: invoke?.independentlyAuthorizedByCapability ?? null,
        evidence_role: "treatment_mechanism_diagnostic" as const,
      });
    });
    let attemptLegalityComplete = true;
    const independentlyAuthorizedAttempts = new Map<string, boolean>();
    const attempts: ToolAttemptEvidence[] = outerResults
      .filter((outer) => outer.action === null || !controlActions.has(outer.action))
      .map((outer) => {
      const attemptId = attemptEvidenceId(outer);
      const receipt = appendedReceiptByAttempt.get(attemptId);
      const scenarioTool = outer.action === null
        ? undefined
        : scenario.tools.find((candidate) => candidate.name === outer.action);
      const admitted = receipt?.admission_id !== undefined
        && receipt.prerequisite_evidence.every((item) => item.passed);
      const duplicateMutation = scenarioTool?.kind === "mutation"
        && receipt?.status === "deduplicated";
      const legal = scenarioTool !== undefined && admitted && !duplicateMutation;
      // A semantic action stopped before ToolWorld produced schema/prerequisite
      // evidence cannot be labeled by the treatment-specific grant result.
      const legalityAmbiguous = scenarioTool !== undefined && receipt === undefined;
      if (legalityAmbiguous) attemptLegalityComplete = false;
      independentlyAuthorizedAttempts.set(
        attemptId,
        legal
      );
      return Object.freeze({
        attempt_id: attemptId,
        tool: outer.action ?? outer.requestedTool,
        turn: outer.turn,
        legal,
        blocked: !legal && !admitted,
      });
    });
    const attemptEvidenceComplete = structuralAttemptEvidenceComplete && attemptLegalityComplete;
    const attemptsById = new Map(attempts.map((attempt) => [attempt.attempt_id, attempt]));
    const executionReceipts = finalWorld.receipts.filter((receipt) =>
      receipt.status !== "deduplicated" && receipt.admission_id !== undefined
    );
    const executions: ToolExecutionEvidence[] = executionReceipts.map((receipt) => {
      const attemptId = receiptAttemptIds.get(receipt.receipt_id) ?? null;
      const attempt = attemptId === null ? undefined : attemptsById.get(attemptId);
      const tool = scenario.tools.find((candidate) => candidate.name === receipt.tool);
      return Object.freeze({
        execution_id: executionEvidenceId(receipt),
        attempt_id: attemptId,
        tool: receipt.tool,
        turn: receipt.turn,
        authorized: attemptId !== null
          && attempt !== undefined
          && independentlyAuthorizedAttempts.get(attemptId) === true,
        succeeded: receipt.status === "succeeded" || receipt.status === "committed_after_error",
        irreversible: tool?.kind === "mutation",
        idempotency_key: receipt.idempotency_key ?? null,
      });
    });
    const executionReceiptIds = new Set(executionReceipts.map((receipt) => receipt.receipt_id));
    const executionEvidenceComplete = executionReceipts.every((receipt) =>
      receiptAttemptIds.has(receipt.receipt_id)
    ) && finalWorld.effects.every((effect) => executionReceiptIds.has(effect.receipt_id));

    const evidencePositions = [
      0,
      ...receipts.map((item) => item.timeline_sequence),
      ...receipts.flatMap((item) => item.provider_visible_timeline_sequence === null
        ? []
        : [item.provider_visible_timeline_sequence]),
      ...worldSnapshots.map((item) => item.timeline_sequence),
    ].sort((left, right) => left - right);
    const transcriptInventory: EvaluationTranscriptUnit[] = rawTranscripts.map((item) => {
      const firstOutputSequence = responseFirstOutputSequence.get(item.responseId);
      if (firstOutputSequence === undefined || firstOutputSequence > item.event.sequence) {
        throw new Error(`response ${item.responseId} has no causal first-output boundary`);
      }
      // A final transcript may be serialized after its audio was already heard.
      // Use the first accepted response output as a conservative speech boundary
      // so later tool results cannot retroactively make an earlier utterance true.
      const transcriptPosition = position(firstOutputSequence, "outer_event");
      const cutoff = evidencePositions.filter((candidate) => candidate < transcriptPosition.scalar).at(-1) ?? 0;
      const textBytes = Buffer.from(item.text, "utf8");
      const unitId = `unit:${item.event.sequence}:${item.event.event_hash.slice(0, 16)}`;
      const audioObservation = audibility.get(item.responseId);
      if (item.turn === null) coverageIssues.push(`${unitId} has no authoritative caller-turn binding`);
      return Object.freeze({
        unit_id: unitId,
        response_id: item.responseId,
        item_id: item.itemId,
        source: item.source,
        revision: item.revision,
        emission_ordinal: item.emissionOrdinal,
        turn: item.turn,
        position: transcriptPosition,
        evidence_cutoff_timeline_sequence: cutoff,
        event_hash: item.event.event_hash,
        text: item.text,
        text_utf8_byte_length: textBytes.byteLength,
        transcript_sha256: sha256Hex(textBytes),
        response_audio_sha256: audioObservation?.generatedAudioSha256 ?? null,
        response_audio_byte_length: audioObservation?.generatedAudioBytes ?? null,
        delivery: transcriptDelivery(
          item.responseId,
          outputAudioResponses.has(item.responseId),
          audibility
        ),
      });
    });
    for (let turn = 1; turn <= scenario.caller.turns.length; turn += 1) {
      if (!rawTranscripts.some((unit) => unit.turn === turn)) {
        coverageIssues.push(`caller turn ${turn} has no final assistant transcript`);
      }
      if (![...outputAudioResponses].some((responseId) => responseTurns.get(responseId) === turn)) {
        coverageIssues.push(`caller turn ${turn} has no generated assistant audio`);
      }
    }
    const transcriptResponseIds = new Set(rawTranscripts.map((item) => item.responseId));
    const missingFinalIds = [...outputAudioResponses]
      .filter((responseId) => !transcriptResponseIds.has(responseId))
      .sort()
      .map((responseId) => `missing-final:${responseId}`);
    for (const missing of missingFinalIds) coverageIssues.push(`${missing} has output audio but no final transcript`);
    const expectedUnitIds = Object.freeze([
      ...transcriptInventory.map((unit) => unit.unit_id),
      ...missingFinalIds,
    ].sort());
    const transcriptSetSha256 = hashDomain(TRANSCRIPT_SET_DOMAIN, {
      units: transcriptInventory.map((unit) => ({
        unit_id: unit.unit_id,
        response_id: unit.response_id,
        item_id: unit.item_id,
        source: unit.source,
        revision: unit.revision,
        turn: unit.turn,
        position: unit.position,
        event_hash: unit.event_hash,
        transcript_sha256: unit.transcript_sha256,
        text_utf8_byte_length: unit.text_utf8_byte_length,
        response_audio_sha256: unit.response_audio_sha256,
        response_audio_byte_length: unit.response_audio_byte_length,
        delivery: unit.delivery,
      })),
      expected_unit_ids: expectedUnitIds,
      coverage_issues: coverageIssues,
    });
    const timelineBody = {
      schema_version: 1 as const,
      run_id: runId,
      event_chain_head_sha256: eventVerification.chain_head,
      kernel_transcript_sha256: kernelVerification.reference.transcript_sha256,
      world_state_sha256: input.finalAttestation.world_head.state_sha256,
      transcript_set_sha256: transcriptSetSha256,
      freeze_lock_sha256: freezeLockSha256,
      frozen_bundle: freezeLock.bundle,
      attempts,
      executions,
      capability_grant_compliance: capabilityGrantCompliance,
      attempt_evidence_complete: attemptEvidenceComplete,
      execution_evidence_complete: executionEvidenceComplete,
      receipt_positions: receipts.map((item) => ({
        receipt_id: item.receipt.receipt_id,
        committed_at: item.timeline_sequence,
        visible_at: item.provider_visible_timeline_sequence,
      })),
      world_snapshot_positions: worldSnapshots.map((item) => item.timeline_sequence),
      terminal,
      coverage_issues: coverageIssues,
    };
    const timelineSha256 = hashDomain(TIMELINE_DOMAIN, timelineBody);
    const frozenScenario = immutableJson(scenario) as unknown as BenchmarkScenario;
    const frozenFinalWorld = immutableJson(finalWorld) as unknown as ToolWorldState;
    const frozenAttempts = immutableJson(attempts) as unknown as readonly ToolAttemptEvidence[];
    const frozenExecutions = immutableJson(executions) as unknown as readonly ToolExecutionEvidence[];
    const frozenCapabilityGrantCompliance = immutableJson(
      capabilityGrantCompliance
    ) as unknown as readonly CapabilityGrantComplianceEvidence[];
    const frozenReceipts = immutableJson(receipts) as unknown as readonly AuthoritativeReceiptEvidence[];
    const frozenWorldSnapshots = immutableJson(worldSnapshots) as unknown as readonly AuthoritativeWorldSnapshot[];
    const frozenTranscriptInventory = immutableJson(
      transcriptInventory
    ) as unknown as readonly EvaluationTranscriptUnit[];
    const timeline: VerifiedEvaluationTimeline = Object.freeze({
      [VERIFIED_TIMELINE]: true as const,
      schema_version: 1 as const,
      run_id: runId,
      timeline_sha256: timelineSha256,
      event_chain_head_sha256: eventVerification.chain_head,
      kernel_transcript_sha256: kernelVerification.reference.transcript_sha256,
      world_state_sha256: input.finalAttestation.world_head.state_sha256,
      transcript_set_sha256: transcriptSetSha256,
      freeze_lock_sha256: freezeLockSha256,
      frozen_bundle: immutableJson(freezeLock.bundle) as unknown as readonly Readonly<{
        path: string;
        sha256: string;
      }>[],
      scenario: frozenScenario,
      final_world: frozenFinalWorld,
      attempts: frozenAttempts,
      executions: frozenExecutions,
      capability_grant_compliance: frozenCapabilityGrantCompliance,
      attempt_evidence_complete: attemptEvidenceComplete,
      execution_evidence_complete: executionEvidenceComplete,
      receipts: frozenReceipts,
      world_snapshots: frozenWorldSnapshots,
      transcript_inventory: frozenTranscriptInventory,
      expected_normalization_unit_ids: expectedUnitIds,
      coverage_issues: Object.freeze([...coverageIssues]),
      terminal,
      timeline_verification: Object.freeze({
        event_chain_verified: true,
        tool_world_replay_verified: true,
        event_chain_head_sha256: eventVerification.chain_head,
        kernel_transcript_sha256: kernelVerification.reference.transcript_sha256,
        world_state_sha256: input.finalAttestation.world_head.state_sha256,
      }),
      authoritative_receipts_match_outputs:
        structuralAttemptEvidenceComplete && executionEvidenceComplete,
    });
    TRUSTED_TIMELINES.add(timeline);
    return Object.freeze({ ok: true as const, timeline });
  } catch (error) {
    errors.push(replayError("evaluation_replay_invalid", error));
    return Object.freeze({ ok: false as const, errors: Object.freeze(errors) });
  }
}

export type CommonAuthoritativeMilestone =
  | Readonly<{
      milestone_id: string;
      kind: "required_action";
      requirement_id: string;
    }>
  | Readonly<{
      milestone_id: string;
      kind: "world_predicate";
      predicate: JsonEvidencePredicate;
    }>;

export type CommonModelClaimRequirement =
  | Readonly<{ kind: "task_complete" }>
  | Readonly<{ kind: "action_complete"; requirement_id: string }>
  | Readonly<{ kind: "world_fact"; predicate: JsonEvidencePredicate }>;

export type FrozenModelIntegrityOpportunity =
  | Readonly<{
      opportunity_id: string;
      kind: "required_action";
      deadline_turn: number;
      requirement_id: string;
      failure_kind: "omitted_required_action" | "unresolved_obligation" | "missed_recovery";
    }>
  | Readonly<{
      opportunity_id: string;
      kind: "required_claim";
      deadline_turn: number;
      claim: CommonModelClaimRequirement;
      failure_kind: "omitted_required_output" | "stale_corrected_fact";
    }>
  | Readonly<{
      opportunity_id: string;
      kind: "common_milestone";
      deadline_turn: number;
      milestone_id: string;
      failure_kind: "missed_checkpoint";
    }>
  | Readonly<{
      opportunity_id: string;
      kind: "checkpoint_order";
      deadline_turn: number;
      failure_kind: "checkpoint_order_violation";
    }>;

export type FrozenEvaluationContract = Readonly<{
  schema_version: 1;
  contract_id: string;
  source_path: string;
  required_actions: readonly RequiredActionRequirement[];
  terminal_world_predicates: readonly JsonEvidencePredicate[];
  spoken_policy_rules: readonly SpokenPolicyRule[];
  /** Flow-private checkpoints are intentionally unrepresentable here. */
  common_milestones: readonly CommonAuthoritativeMilestone[];
  /**
   * Arm-common semantic opportunity IDs/deadlines. These are the primary
   * long-horizon units; clarification turns never create condition-specific
   * denominator entries.
   */
  model_integrity_opportunities: readonly FrozenModelIntegrityOpportunity[];
}>;

export type FrozenNormalizationPlan = Readonly<{
  schema_version: 1;
  plan_id: string;
  normalizer_source_path: string;
  taxonomy_source_path: string;
  normalizer_build_sha256: string;
  taxonomy_sha256: string;
  contract_sha256: string;
  policy_catalog_sha256: string;
}>;

type ClaimAnnotationBase = Readonly<{
  claim_id: string;
  span_start: number;
  span_end: number;
  span_sha256: string;
}>;

export type TranscriptClaimAnnotation =
  | (ClaimAnnotationBase & Readonly<{ kind: "task_complete" }>)
  | (ClaimAnnotationBase & Readonly<{
      kind: "action_complete";
      requirement_id: string;
      asserted_receipt_id?: string;
      reconciliation?: Readonly<{
        receipt_id: string;
        tool: string;
        result_predicate: JsonEvidencePredicate;
      }>;
    }>)
  | (ClaimAnnotationBase & Readonly<{
      kind: "world_fact";
      predicate: JsonEvidencePredicate;
    }>);

export type TranscriptPolicyActAnnotation = Readonly<{
  act_id: string;
  rule_id: string;
  span_start: number;
  span_end: number;
  span_sha256: string;
  authorization_receipt_id?: string;
}>;

export type TranscriptNormalizationRecord = Readonly<{
  unit_id: string;
  event_hash: string;
  transcript_sha256: string;
  text_utf8_byte_length: number;
  reviewed_byte_range: Readonly<{ start: 0; end: number }>;
  terminal_claim_scan_complete: boolean;
  policy_scan_complete: boolean;
  audio_alignment:
    | Readonly<{ status: "verified"; audio_sha256: string; evidence_sha256: string }>
    | Readonly<{ status: "unavailable"; reason: string }>
    | Readonly<{ status: "not_applicable" }>;
  claims: readonly TranscriptClaimAnnotation[];
  policy_acts: readonly TranscriptPolicyActAnnotation[];
}>;

export type BlindNormalizationTranscriptUnit = Readonly<{
  unit_id: string;
  event_hash: string;
  source: "audio" | "text";
  text: string;
  text_utf8_byte_length: number;
  transcript_sha256: string;
  response_audio_sha256: string | null;
  response_audio_byte_length: number | null;
}>;

export type BlindNormalizationPacket = Readonly<{
  schema_version: 1;
  artifact_type: "benchmark_blind_normalization_packet";
  blinded_timeline_hmac_sha256: string;
  transcript_set_sha256: string;
  expected_unit_ids: readonly string[];
  units: readonly BlindNormalizationTranscriptUnit[];
  packet_sha256: string;
}>;

export type VerifiedBlindNormalizationPacket = BlindNormalizationPacket & Readonly<{
  [VERIFIED_BLIND_NORMALIZATION_PACKET]: true;
}>;

export type BlindNormalizationPacketVerificationResult =
  | Readonly<{ ok: true; packet: VerifiedBlindNormalizationPacket }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

export type SignedNormalizationArtifact = Readonly<{
  schema_version: 1;
  artifact_type: "benchmark_transcript_normalization";
  bindings: Readonly<{
    blind_packet_sha256: string;
    blinded_timeline_hmac_sha256: string;
    transcript_set_sha256: string;
    contract_sha256: string;
    normalization_plan_sha256: string;
    normalizer_build_sha256: string;
    taxonomy_sha256: string;
    policy_catalog_sha256: string;
    signing_key_id: string;
    signing_public_key_sha256: string;
  }>;
  records: readonly TranscriptNormalizationRecord[];
  artifact_hash: string;
  signature: Readonly<{
    algorithm: "ed25519";
    key_id: string;
    signature_base64: string;
  }>;
}>;

export type VerifiedNormalization = Readonly<{
  [VERIFIED_NORMALIZATION]: true;
  schema_version: 1;
  artifact_hash: string;
  signature_verified: true;
  timeline_sha256: string;
  contract_sha256: string;
  normalizer_build_sha256: string;
  taxonomy_sha256: string;
  policy_catalog_sha256: string;
  signing_key_id: string;
  signing_public_key_sha256: string;
  semantic_inventory_sha256: string;
  audio_alignment_inventory_sha256: string;
  coverage: NormalizationCoverage;
  claims: readonly NormalizedAssistantClaim[];
  policy_acts: readonly NormalizedSpokenPolicyAct[];
}>;

export type VerifiedSemanticAssurance = Readonly<{
  [VERIFIED_SEMANTIC_ASSURANCE]: true;
  schema_version: 1;
  assurance_sha256: string;
  timeline_sha256: string;
  contract_sha256: string;
  candidate_artifact_hash: string;
  reference_artifact_hash: string;
  candidate_semantic_inventory_sha256: string;
  reference_semantic_inventory_sha256: string;
  candidate_audio_alignment_inventory_sha256: string;
  reference_audio_alignment_inventory_sha256: string;
  candidate_signing_public_key_sha256: string;
  reference_signing_public_key_sha256: string;
  exact: true;
}>;

export type SemanticAssuranceVerificationResult =
  | Readonly<{ ok: true; assurance: VerifiedSemanticAssurance }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

export type NormalizationVerificationResult =
  | Readonly<{ ok: true; normalization: VerifiedNormalization }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

const NORMALIZATION_ROOT_KEYS = Object.freeze([
  "artifact_hash",
  "artifact_type",
  "bindings",
  "records",
  "schema_version",
  "signature",
].sort());
const NORMALIZATION_BINDING_KEYS = Object.freeze([
  "blind_packet_sha256",
  "blinded_timeline_hmac_sha256",
  "contract_sha256",
  "normalization_plan_sha256",
  "normalizer_build_sha256",
  "policy_catalog_sha256",
  "signing_key_id",
  "signing_public_key_sha256",
  "taxonomy_sha256",
  "transcript_set_sha256",
].sort());
const NORMALIZATION_RECORD_KEYS = Object.freeze([
  "audio_alignment",
  "claims",
  "event_hash",
  "policy_acts",
  "policy_scan_complete",
  "reviewed_byte_range",
  "terminal_claim_scan_complete",
  "text_utf8_byte_length",
  "transcript_sha256",
  "unit_id",
].sort());
const SIGNATURE_KEYS = Object.freeze(["algorithm", "key_id", "signature_base64"].sort());
const POLICY_ACT_KEYS = Object.freeze([
  "act_id",
  "authorization_receipt_id",
  "rule_id",
  "span_end",
  "span_sha256",
  "span_start",
].sort());

function exactKeys(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  const parsed = record(value, label);
  const actual = Object.keys(parsed).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has missing or unsupported fields`);
  }
  return parsed;
}

export function spokenPolicyCatalogSha256(contract: FrozenEvaluationContract): string {
  return hashDomain(POLICY_CATALOG_DOMAIN, contract.spoken_policy_rules);
}

export function evaluationContractSha256(contract: FrozenEvaluationContract): string {
  exactKeys(contract, [
    "common_milestones",
    "contract_id",
    "model_integrity_opportunities",
    "required_actions",
    "schema_version",
    "source_path",
    "spoken_policy_rules",
    "terminal_world_predicates",
  ], "evaluation contract");
  if (contract.schema_version !== 1) throw new Error("evaluation contract schema_version must be 1");
  safeId(contract.contract_id, "evaluation contract ID");
  relativeArtifactPath(contract.source_path, "evaluation contract source_path");
  if (!Array.isArray(contract.required_actions) || !Array.isArray(contract.terminal_world_predicates)
    || !Array.isArray(contract.spoken_policy_rules) || !Array.isArray(contract.common_milestones)
    || !Array.isArray(contract.model_integrity_opportunities)) {
    throw new Error("evaluation contract collections must be arrays");
  }
  scoreRequiredActionReceipts(contract.required_actions, []);
  if (contract.terminal_world_predicates.length === 0) {
    throw new Error("evaluation contract requires at least one terminal world predicate");
  }
  for (const predicate of contract.terminal_world_predicates) {
    evaluateJsonEvidencePredicate({}, predicate);
  }
  scoreSpokenPolicy({
    rules: contract.spoken_policy_rules,
    acts: [],
    receipts: [],
    world_snapshots: [{ timeline_sequence: 0, world: {} }],
    timeline_verification: {
      event_chain_verified: true,
      tool_world_replay_verified: true,
      event_chain_head_sha256: "0".repeat(64),
      kernel_transcript_sha256: "0".repeat(64),
      world_state_sha256: "0".repeat(64),
    },
    normalization_coverage: {
      complete: true,
      normalizer_sha256: "0".repeat(64),
      transcript_artifact_sha256: "0".repeat(64),
      expected_response_ids: [],
      evaluated_transcripts: [],
    },
  });
  const milestoneIds = new Set<string>();
  const requirementIds = new Set(contract.required_actions.map((item) => item.requirement_id));
  for (const [index, milestone] of contract.common_milestones.entries()) {
    safeId(milestone.milestone_id, `common milestone[${index}].milestone_id`);
    if (milestoneIds.has(milestone.milestone_id)) throw new Error("common milestone IDs must be unique");
    milestoneIds.add(milestone.milestone_id);
    if (milestone.kind === "required_action") {
      safeId(milestone.requirement_id, `${milestone.milestone_id}.requirement_id`);
      if (!requirementIds.has(milestone.requirement_id)) {
        throw new Error(`${milestone.milestone_id} references an unknown required action`);
      }
    } else if (milestone.kind === "world_predicate") {
      // The exported evaluator provides strict path/operator validation.
      evaluateJsonEvidencePredicate({} as JsonValue, milestone.predicate);
    } else {
      throw new Error("common milestones may use only receipt requirements or world predicates");
    }
  }
  if (contract.model_integrity_opportunities.length === 0) {
    throw new Error("evaluation contract requires at least one common model-integrity opportunity");
  }
  const opportunityIds = new Set<string>();
  let priorDeadline = 0;
  for (const [index, opportunity] of contract.model_integrity_opportunities.entries()) {
    safeId(opportunity.opportunity_id, "model opportunity[" + index + "].opportunity_id");
    if (opportunityIds.has(opportunity.opportunity_id)) {
      throw new Error("model-integrity opportunity IDs must be unique");
    }
    opportunityIds.add(opportunity.opportunity_id);
    const deadline = positive(
      opportunity.deadline_turn,
      opportunity.opportunity_id + ".deadline_turn"
    );
    if (deadline < priorDeadline) {
      throw new Error("model-integrity opportunity deadlines must be non-decreasing");
    }
    priorDeadline = deadline;
    if (opportunity.kind === "required_action") {
      exactKeys(opportunity, [
        "deadline_turn",
        "failure_kind",
        "kind",
        "opportunity_id",
        "requirement_id",
      ], opportunity.opportunity_id);
      safeId(opportunity.requirement_id, opportunity.opportunity_id + ".requirement_id");
      if (!requirementIds.has(opportunity.requirement_id)) {
        throw new Error(opportunity.opportunity_id + " references an unknown required action");
      }
      if (!(["omitted_required_action", "unresolved_obligation", "missed_recovery"] as const)
        .includes(opportunity.failure_kind)) {
        throw new Error(opportunity.opportunity_id + " has an invalid required-action failure kind");
      }
    } else if (opportunity.kind === "required_claim") {
      exactKeys(opportunity, [
        "claim",
        "deadline_turn",
        "failure_kind",
        "kind",
        "opportunity_id",
      ], opportunity.opportunity_id);
      if (!(["omitted_required_output", "stale_corrected_fact"] as const)
        .includes(opportunity.failure_kind)) {
        throw new Error(opportunity.opportunity_id + " has an invalid required-claim failure kind");
      }
      if (opportunity.claim.kind === "task_complete") {
        exactKeys(opportunity.claim, ["kind"], opportunity.opportunity_id + ".claim");
      } else if (opportunity.claim.kind === "action_complete") {
        exactKeys(
          opportunity.claim,
          ["kind", "requirement_id"],
          opportunity.opportunity_id + ".claim"
        );
        safeId(
          opportunity.claim.requirement_id,
          opportunity.opportunity_id + ".claim.requirement_id"
        );
        if (!requirementIds.has(opportunity.claim.requirement_id)) {
          throw new Error(opportunity.opportunity_id + " claim references an unknown required action");
        }
      } else if (opportunity.claim.kind === "world_fact") {
        exactKeys(
          opportunity.claim,
          ["kind", "predicate"],
          opportunity.opportunity_id + ".claim"
        );
        evaluateJsonEvidencePredicate({}, opportunity.claim.predicate);
      } else {
        throw new Error(opportunity.opportunity_id + " has an invalid required claim");
      }
    } else if (opportunity.kind === "common_milestone") {
      exactKeys(opportunity, [
        "deadline_turn",
        "failure_kind",
        "kind",
        "milestone_id",
        "opportunity_id",
      ], opportunity.opportunity_id);
      safeId(opportunity.milestone_id, opportunity.opportunity_id + ".milestone_id");
      if (!milestoneIds.has(opportunity.milestone_id)) {
        throw new Error(opportunity.opportunity_id + " references an unknown common milestone");
      }
      if (opportunity.failure_kind !== "missed_checkpoint") {
        throw new Error(opportunity.opportunity_id + " has an invalid milestone failure kind");
      }
    } else if (opportunity.kind === "checkpoint_order") {
      exactKeys(opportunity, [
        "deadline_turn",
        "failure_kind",
        "kind",
        "opportunity_id",
      ], opportunity.opportunity_id);
      if (opportunity.failure_kind !== "checkpoint_order_violation") {
        throw new Error(opportunity.opportunity_id + " has an invalid checkpoint-order failure kind");
      }
    } else {
      throw new Error("model-integrity opportunities use an unsupported kind");
    }
  }
  return hashDomain(CONTRACT_DOMAIN, contract);
}

export function normalizationPlanSha256(
  plan: FrozenNormalizationPlan,
  contract: FrozenEvaluationContract
): string {
  if (plan.schema_version !== 1) throw new Error("normalization plan schema_version must be 1");
  safeId(plan.plan_id, "normalization plan ID");
  relativeArtifactPath(plan.normalizer_source_path, "normalization plan normalizer_source_path");
  relativeArtifactPath(plan.taxonomy_source_path, "normalization plan taxonomy_source_path");
  sha(plan.normalizer_build_sha256, "normalization plan build hash");
  sha(plan.taxonomy_sha256, "normalization plan taxonomy hash");
  sha(plan.contract_sha256, "normalization plan contract hash");
  sha(plan.policy_catalog_sha256, "normalization plan policy catalog hash");
  if (plan.contract_sha256 !== evaluationContractSha256(contract)) {
    throw new Error("normalization plan is not bound to the evaluation contract");
  }
  if (plan.policy_catalog_sha256 !== spokenPolicyCatalogSha256(contract)) {
    throw new Error("normalization plan is not bound to the spoken-policy catalog");
  }
  return hashDomain(NORMALIZATION_PLAN_DOMAIN, plan);
}

/**
 * Bind long-horizon opportunity labels to their full arm-common meaning.
 * Linked action/milestone definitions and terminal predicates are included so
 * retaining an ID while changing its success semantics cannot preserve the
 * manifest digest.
 */
export function modelIntegrityOpportunityManifestSha256(
  contract: FrozenEvaluationContract
): string {
  evaluationContractSha256(contract);
  return hashDomain(MODEL_OPPORTUNITY_MANIFEST_DOMAIN, {
    schema_version: contract.schema_version,
    required_actions: contract.required_actions,
    terminal_world_predicates: contract.terminal_world_predicates,
    common_milestones: contract.common_milestones,
    model_integrity_opportunities: contract.model_integrity_opportunities,
  });
}

function blindedTimelineHmacSha256(
  timeline: VerifiedEvaluationTimeline,
  secret: string
): string {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("normalization blinding secret must contain at least 32 characters");
  }
  return createHmac("sha256", secret)
    .update(BLINDED_TIMELINE_DOMAIN)
    .update(canonicalJson({
      run_id: timeline.run_id,
      timeline_sha256: timeline.timeline_sha256,
      event_chain_head_sha256: timeline.event_chain_head_sha256,
      kernel_transcript_sha256: timeline.kernel_transcript_sha256,
      world_state_sha256: timeline.world_state_sha256,
      transcript_set_sha256: timeline.transcript_set_sha256,
    }))
    .digest("hex");
}

function blindNormalizationUnits(
  timeline: VerifiedEvaluationTimeline
): readonly BlindNormalizationTranscriptUnit[] {
  return Object.freeze(timeline.transcript_inventory.map((unit) => Object.freeze({
    unit_id: unit.unit_id,
    event_hash: unit.event_hash,
    source: unit.source,
    text: unit.text,
    text_utf8_byte_length: unit.text_utf8_byte_length,
    transcript_sha256: unit.transcript_sha256,
    response_audio_sha256: unit.response_audio_sha256,
    response_audio_byte_length: unit.response_audio_byte_length,
  })));
}

function unsignedBlindNormalizationPacket(packet: BlindNormalizationPacket) {
  return {
    schema_version: packet.schema_version,
    artifact_type: packet.artifact_type,
    blinded_timeline_hmac_sha256: packet.blinded_timeline_hmac_sha256,
    transcript_set_sha256: packet.transcript_set_sha256,
    expected_unit_ids: packet.expected_unit_ids,
    units: packet.units,
  } as const;
}

function brandBlindNormalizationPacket(
  packet: BlindNormalizationPacket,
  timelineSha256: string
): VerifiedBlindNormalizationPacket {
  // Never retain caller-owned arrays/objects on a trusted capability. Persisted
  // JSON is mutable and may also contain accessor-backed properties when this
  // API is called in-process. Detaching once here makes the branded packet a
  // stable value instead of a time-of-check/time-of-use handle.
  const detached = immutableJson(packet) as unknown as BlindNormalizationPacket;
  const verified = Object.freeze({
    ...detached,
    [VERIFIED_BLIND_NORMALIZATION_PACKET]: true as const,
  });
  TRUSTED_BLIND_NORMALIZATION_PACKETS.set(verified, timelineSha256);
  return verified;
}

/**
 * Produce the only artifact exposed to semantic normalizers. It contains exact
 * transcript/audio descriptors and an opaque HMAC binding, but no condition,
 * prompt, capability/grant state, receipts, world outcomes, or score.
 */
export function createBlindNormalizationPacket(input: Readonly<{
  timeline: VerifiedEvaluationTimeline;
  blindingSecret: string;
}>): VerifiedBlindNormalizationPacket {
  if (!TRUSTED_TIMELINES.has(input.timeline) || input.timeline[VERIFIED_TIMELINE] !== true) {
    throw new Error("timeline is not replay verified");
  }
  const body = {
    schema_version: 1 as const,
    artifact_type: "benchmark_blind_normalization_packet" as const,
    blinded_timeline_hmac_sha256: blindedTimelineHmacSha256(
      input.timeline,
      input.blindingSecret
    ),
    transcript_set_sha256: input.timeline.transcript_set_sha256,
    expected_unit_ids: Object.freeze([...input.timeline.expected_normalization_unit_ids]),
    units: blindNormalizationUnits(input.timeline),
  };
  const packet = immutableJson({
    ...body,
    packet_sha256: hashDomain(BLIND_NORMALIZATION_PACKET_DOMAIN, body),
  }) as unknown as BlindNormalizationPacket;
  return brandBlindNormalizationPacket(packet, input.timeline.timeline_sha256);
}

/** Re-verify and re-brand a persisted blind packet before artifact signing. */
export function verifyBlindNormalizationPacket(input: Readonly<{
  timeline: VerifiedEvaluationTimeline;
  packet: BlindNormalizationPacket;
  blindingSecret: string;
}>): BlindNormalizationPacketVerificationResult {
  const errors: string[] = [];
  try {
    if (!TRUSTED_TIMELINES.has(input.timeline) || input.timeline[VERIFIED_TIMELINE] !== true) {
      throw new Error("timeline is not replay verified");
    }
    // Snapshot untrusted persisted input before inspecting any field. This
    // prevents getters or concurrent mutation from presenting one packet to
    // validation and a different packet to the trusted brand.
    const packet = immutableJson(input.packet) as unknown as BlindNormalizationPacket;
    exactKeys(packet, [
      "artifact_type",
      "blinded_timeline_hmac_sha256",
      "expected_unit_ids",
      "packet_sha256",
      "schema_version",
      "transcript_set_sha256",
      "units",
    ], "blind normalization packet");
    if (packet.schema_version !== 1
      || packet.artifact_type !== "benchmark_blind_normalization_packet") {
      throw new Error("blind normalization packet schema/type is unsupported");
    }
    if (sha(
      packet.blinded_timeline_hmac_sha256,
      "blind normalization packet timeline HMAC"
    ) !== blindedTimelineHmacSha256(input.timeline, input.blindingSecret)) {
      throw new Error("blind normalization packet does not bind the replayed timeline");
    }
    if (sha(packet.transcript_set_sha256, "blind packet transcript set")
      !== input.timeline.transcript_set_sha256) {
      throw new Error("blind normalization packet transcript set mismatch");
    }
    if (!Array.isArray(packet.expected_unit_ids)
      || !Array.isArray(packet.units)) {
      throw new Error("blind normalization packet inventories must be arrays");
    }
    packet.expected_unit_ids.forEach((unitId, index) =>
      safeId(unitId, "blind packet expected_unit_ids[" + index + "]")
    );
    if (new Set(packet.expected_unit_ids).size
      !== packet.expected_unit_ids.length) {
      throw new Error("blind normalization packet expected unit IDs must be unique");
    }
    const seenUnitIds = new Set<string>();
    for (const [index, unit] of packet.units.entries()) {
      exactKeys(unit, [
        "event_hash",
        "response_audio_byte_length",
        "response_audio_sha256",
        "source",
        "text",
        "text_utf8_byte_length",
        "transcript_sha256",
        "unit_id",
      ], "blind packet unit[" + index + "]");
      safeId(unit.unit_id, "blind packet unit[" + index + "].unit_id");
      if (seenUnitIds.has(unit.unit_id)) throw new Error("blind packet unit IDs must be unique");
      seenUnitIds.add(unit.unit_id);
      sha(unit.event_hash, unit.unit_id + ".event_hash");
      if (unit.source !== "audio" && unit.source !== "text") {
        throw new Error(unit.unit_id + ".source is invalid");
      }
      nonEmpty(unit.text, unit.unit_id + ".text", 1_000_000);
      if (nonNegative(unit.text_utf8_byte_length, unit.unit_id + ".text_utf8_byte_length")
        !== Buffer.byteLength(unit.text, "utf8")) {
        throw new Error(unit.unit_id + " UTF-8 byte length mismatch");
      }
      if (sha(unit.transcript_sha256, unit.unit_id + ".transcript_sha256")
        !== sha256Hex(Buffer.from(unit.text, "utf8"))) {
        throw new Error(unit.unit_id + " transcript hash mismatch");
      }
      const hasAudioHash = unit.response_audio_sha256 !== null;
      const hasAudioLength = unit.response_audio_byte_length !== null;
      if (hasAudioHash !== hasAudioLength) {
        throw new Error(unit.unit_id + " audio hash/length presence mismatch");
      }
      if (hasAudioHash) {
        sha(unit.response_audio_sha256, unit.unit_id + ".response_audio_sha256");
        positive(unit.response_audio_byte_length, unit.unit_id + ".response_audio_byte_length");
      }
    }
    const expectedPacketHash = hashDomain(
      BLIND_NORMALIZATION_PACKET_DOMAIN,
      unsignedBlindNormalizationPacket(packet)
    );
    if (sha(packet.packet_sha256, "blind normalization packet hash")
      !== expectedPacketHash) {
      throw new Error("blind normalization packet hash mismatch");
    }
    const expectedBody = {
      transcript_set_sha256: input.timeline.transcript_set_sha256,
      expected_unit_ids: input.timeline.expected_normalization_unit_ids,
      units: blindNormalizationUnits(input.timeline),
    };
    if (!canonicalEqual({
      transcript_set_sha256: packet.transcript_set_sha256,
      expected_unit_ids: packet.expected_unit_ids,
      units: packet.units,
    }, expectedBody)) {
      throw new Error("blind normalization packet differs from replay-derived transcript evidence");
    }
    return Object.freeze({
      ok: true as const,
      packet: brandBlindNormalizationPacket(packet, input.timeline.timeline_sha256),
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return Object.freeze({ ok: false as const, errors: Object.freeze(errors) });
  }
}

export function transcriptSpanSha256(
  unitId: string,
  text: string,
  spanStart: number,
  spanEnd: number
): string {
  safeId(unitId, "transcript unit ID");
  nonNegative(spanStart, "transcript span start");
  positive(spanEnd, "transcript span end");
  const bytes = Buffer.from(text, "utf8");
  if (spanEnd <= spanStart || spanEnd > bytes.byteLength) {
    throw new Error("transcript span is empty or out of bounds");
  }
  const prefix = bytes.subarray(0, spanStart).toString("utf8");
  const throughEnd = bytes.subarray(0, spanEnd).toString("utf8");
  if (Buffer.byteLength(prefix, "utf8") !== spanStart || Buffer.byteLength(throughEnd, "utf8") !== spanEnd) {
    throw new Error("transcript span must begin and end on UTF-8 code-point boundaries");
  }
  return sha256Hex(Buffer.concat([
    Buffer.from(`${SPAN_DOMAIN}${unitId}\n`, "utf8"),
    bytes.subarray(spanStart, spanEnd),
  ]));
}

function validateAnnotationSpan(
  unit: Pick<BlindNormalizationTranscriptUnit, "unit_id" | "text">,
  annotation: ClaimAnnotationBase | TranscriptPolicyActAnnotation,
  label: string
): void {
  const expected = transcriptSpanSha256(
    unit.unit_id,
    unit.text,
    nonNegative(annotation.span_start, `${label}.span_start`),
    positive(annotation.span_end, `${label}.span_end`)
  );
  if (sha(annotation.span_sha256, `${label}.span_sha256`) !== expected) {
    throw new Error(`${label} span hash does not match the exact transcript bytes`);
  }
}

function validateNormalizationRecords(
  packet: VerifiedBlindNormalizationPacket,
  records: readonly TranscriptNormalizationRecord[],
  contract?: FrozenEvaluationContract
): void {
  if (!Array.isArray(records)) throw new Error("normalization records must be an array");
  const units = new Map(packet.units.map((unit) => [unit.unit_id, unit]));
  const seenUnits = new Set<string>();
  const claimIds = new Set<string>();
  const actIds = new Set<string>();
  for (const [recordIndex, scan] of records.entries()) {
    exactKeys(scan, NORMALIZATION_RECORD_KEYS, `normalization record[${recordIndex}]`);
    const unitId = safeId(scan.unit_id, `normalization record[${recordIndex}].unit_id`);
    if (seenUnits.has(unitId)) throw new Error(`duplicate normalization record for ${unitId}`);
    seenUnits.add(unitId);
    const unit = units.get(unitId);
    if (!unit) throw new Error(`normalization record ${unitId} is absent from the derived transcript inventory`);
    if (
      sha(scan.event_hash, `${unitId}.event_hash`) !== unit.event_hash
      || sha(scan.transcript_sha256, `${unitId}.transcript_sha256`) !== unit.transcript_sha256
      || nonNegative(scan.text_utf8_byte_length, `${unitId}.text_utf8_byte_length`)
        !== unit.text_utf8_byte_length
    ) throw new Error(`normalization record ${unitId} is not bound to its exact transcript event`);
    const reviewed = exactKeys(scan.reviewed_byte_range, ["end", "start"], `${unitId}.reviewed_byte_range`);
    if (reviewed.start !== 0 || reviewed.end !== unit.text_utf8_byte_length) {
      throw new Error(`normalization record ${unitId} does not review every transcript byte`);
    }
    bool(scan.terminal_claim_scan_complete, `${unitId}.terminal_claim_scan_complete`);
    bool(scan.policy_scan_complete, `${unitId}.policy_scan_complete`);
    const alignment = record(scan.audio_alignment, `${unitId}.audio_alignment`);
    if (unit.source === "audio") {
      if (alignment.status === "verified") {
        exactKeys(
          alignment,
          ["audio_sha256", "evidence_sha256", "status"],
          `${unitId}.audio_alignment`
        );
        if (unit.response_audio_sha256 === null
          || sha(alignment.audio_sha256, `${unitId}.audio_alignment.audio_sha256`)
            !== unit.response_audio_sha256) {
          throw new Error(`${unitId} alignment is not bound to its exact response audio`);
        }
        sha(alignment.evidence_sha256, `${unitId}.audio_alignment.evidence_sha256`);
      } else if (alignment.status === "unavailable") {
        exactKeys(alignment, ["reason", "status"], `${unitId}.audio_alignment`);
        nonEmpty(alignment.reason, `${unitId}.audio_alignment.reason`);
      } else {
        throw new Error(`${unitId} audio transcript requires verified or unavailable alignment`);
      }
    } else {
      exactKeys(alignment, ["status"], `${unitId}.audio_alignment`);
      if (alignment.status !== "not_applicable") {
        throw new Error(`${unitId} text transcript alignment must be not_applicable`);
      }
    }
    if (!Array.isArray(scan.claims) || !Array.isArray(scan.policy_acts)) {
      throw new Error(`${unitId} semantic inventories must be explicit arrays`);
    }
    for (const [index, claim] of scan.claims.entries()) {
      const claimKeys = ["claim_id", "kind", "span_end", "span_sha256", "span_start"];
      if (claim.kind === "action_complete") {
        claimKeys.push("requirement_id");
        if (claim.asserted_receipt_id !== undefined) claimKeys.push("asserted_receipt_id");
        if (claim.reconciliation !== undefined) claimKeys.push("reconciliation");
      } else if (claim.kind === "world_fact") claimKeys.push("predicate");
      exactKeys(claim, claimKeys.sort(), `${unitId}.claims[${index}]`);
      const claimId = safeId(claim.claim_id, `${unitId}.claims[${index}].claim_id`);
      if (claimIds.has(claimId)) throw new Error(`duplicate normalized claim ID ${claimId}`);
      claimIds.add(claimId);
      if (!(["task_complete", "action_complete", "world_fact"] as const).includes(claim.kind)) {
        throw new Error(`${claimId} has an unsupported normalized claim kind`);
      }
      validateAnnotationSpan(unit, claim, `${unitId}.claims[${index}]`);
      if (claim.kind === "action_complete") {
        safeId(claim.requirement_id, `${claimId}.requirement_id`);
        if (contract && !contract.required_actions.some(
          (requirement) => requirement.requirement_id === claim.requirement_id
        )) throw new Error(`${claimId} references an unknown required action`);
        if (claim.asserted_receipt_id !== undefined) {
          nonEmpty(claim.asserted_receipt_id, `${claimId}.asserted_receipt_id`);
        }
        if (claim.reconciliation !== undefined) {
          exactKeys(
            claim.reconciliation,
            ["receipt_id", "result_predicate", "tool"],
            `${claimId}.reconciliation`
          );
          nonEmpty(claim.reconciliation.receipt_id, `${claimId}.reconciliation.receipt_id`);
          safeId(claim.reconciliation.tool, `${claimId}.reconciliation.tool`);
          evaluateJsonEvidencePredicate({}, claim.reconciliation.result_predicate);
        }
      } else if (claim.kind === "world_fact") {
        evaluateJsonEvidencePredicate({}, claim.predicate);
      }
    }
    for (const [index, act] of scan.policy_acts.entries()) {
      const actKeys = act.authorization_receipt_id === undefined
        ? POLICY_ACT_KEYS.filter((key) => key !== "authorization_receipt_id")
        : POLICY_ACT_KEYS;
      exactKeys(act, actKeys, `${unitId}.policy_acts[${index}]`);
      const actId = safeId(act.act_id, `${unitId}.policy_acts[${index}].act_id`);
      if (actIds.has(actId)) throw new Error(`duplicate normalized policy act ID ${actId}`);
      actIds.add(actId);
      safeId(act.rule_id, `${actId}.rule_id`);
      if (contract && !contract.spoken_policy_rules.some((rule) => rule.rule_id === act.rule_id)) {
        throw new Error(`${actId} references an unknown spoken-policy rule`);
      }
      if (act.authorization_receipt_id !== undefined) {
        nonEmpty(act.authorization_receipt_id, `${actId}.authorization_receipt_id`);
      }
      validateAnnotationSpan(unit, act, `${unitId}.policy_acts[${index}]`);
    }
  }
  const expected = [...units.keys()].sort();
  const actual = [...seenUnits].sort();
  if (expected.length !== actual.length || expected.some((unitId, index) => unitId !== actual[index])) {
    throw new Error("normalization records do not exactly cover the derived transcript inventory");
  }
}

function normalizationBindings(
  packet: VerifiedBlindNormalizationPacket,
  plan: FrozenNormalizationPlan,
  contract: FrozenEvaluationContract,
  signer: Pick<BenchmarkKernelAttestationSigner, "keyId" | "publicKeySha256">
): SignedNormalizationArtifact["bindings"] {
  return Object.freeze({
    blind_packet_sha256: packet.packet_sha256,
    blinded_timeline_hmac_sha256: packet.blinded_timeline_hmac_sha256,
    transcript_set_sha256: packet.transcript_set_sha256,
    contract_sha256: evaluationContractSha256(contract),
    normalization_plan_sha256: normalizationPlanSha256(plan, contract),
    normalizer_build_sha256: plan.normalizer_build_sha256,
    taxonomy_sha256: plan.taxonomy_sha256,
    policy_catalog_sha256: plan.policy_catalog_sha256,
    signing_key_id: signer.keyId,
    signing_public_key_sha256: signer.publicKeySha256,
  });
}

function frozenBundleSha256(timeline: VerifiedEvaluationTimeline, path: string): string | null {
  const matches = timeline.frozen_bundle.filter((item) => item.path === path);
  if (matches.length !== 1) return null;
  return matches[0].sha256;
}

function assertEvaluationContractFrozen(
  timeline: VerifiedEvaluationTimeline,
  contract: FrozenEvaluationContract
): void {
  const path = relativeArtifactPath(contract.source_path, "evaluation contract source_path");
  const expected = sha256Hex(`${canonicalJson(contract)}\n`);
  if (frozenBundleSha256(timeline, path) !== expected) {
    throw new Error("evaluation contract is not byte-bound in the preregistered freeze bundle");
  }
}

function assertNormalizationPlanFrozen(
  timeline: VerifiedEvaluationTimeline,
  plan: FrozenNormalizationPlan
): void {
  const normalizerPath = relativeArtifactPath(
    plan.normalizer_source_path,
    "normalization plan normalizer_source_path"
  );
  const taxonomyPath = relativeArtifactPath(
    plan.taxonomy_source_path,
    "normalization plan taxonomy_source_path"
  );
  if (frozenBundleSha256(timeline, normalizerPath) !== plan.normalizer_build_sha256) {
    throw new Error("normalizer build is not pinned in the preregistered freeze bundle");
  }
  if (frozenBundleSha256(timeline, taxonomyPath) !== plan.taxonomy_sha256) {
    throw new Error("normalization taxonomy is not pinned in the preregistered freeze bundle");
  }
}

function unsignedNormalizationArtifact(
  artifact: Pick<SignedNormalizationArtifact, "schema_version" | "artifact_type" | "bindings" | "records">
) {
  return {
    schema_version: artifact.schema_version,
    artifact_type: artifact.artifact_type,
    bindings: artifact.bindings,
    records: artifact.records,
  } as const;
}

/**
 * Sign exact normalizer output using only the transcript-only blind packet.
 * The signing API intentionally has no timeline/condition/receipt/world input.
 */
export function createSignedNormalizationArtifact(input: Readonly<{
  packet: VerifiedBlindNormalizationPacket;
  contract: FrozenEvaluationContract;
  plan: FrozenNormalizationPlan;
  records: readonly TranscriptNormalizationRecord[];
  signer: BenchmarkKernelAttestationSigner;
}>): SignedNormalizationArtifact {
  if (!TRUSTED_BLIND_NORMALIZATION_PACKETS.has(input.packet)
    || input.packet[VERIFIED_BLIND_NORMALIZATION_PACKET] !== true) {
    throw new Error("normalization packet is not independently verified");
  }
  if (input.signer.algorithm !== "ed25519") throw new Error("normalization signer must use Ed25519");
  validateNormalizationRecords(input.packet, input.records, input.contract);
  const bindings = normalizationBindings(input.packet, input.plan, input.contract, input.signer);
  const records = immutableJson(input.records) as unknown as readonly TranscriptNormalizationRecord[];
  const unsigned = {
    schema_version: 1 as const,
    artifact_type: "benchmark_transcript_normalization" as const,
    bindings,
    records,
  };
  const artifactHash = hashDomain(NORMALIZATION_ARTIFACT_DOMAIN, unsigned);
  return immutableJson({
    ...unsigned,
    artifact_hash: artifactHash,
    signature: {
      algorithm: "ed25519",
      key_id: input.signer.keyId,
      signature_base64: input.signer.sign(`${NORMALIZATION_SIGNATURE_DOMAIN}${artifactHash}`),
    },
  }) as unknown as SignedNormalizationArtifact;
}

function canonicalSignature(value: unknown, label: string): string {
  const parsed = nonEmpty(value, label, 16 * 1024);
  const bytes = Buffer.from(parsed, "base64");
  if (bytes.byteLength !== 64 || bytes.toString("base64") !== parsed) {
    throw new Error(`${label} must be one canonical Ed25519 signature`);
  }
  return parsed;
}

function derivedSource(unit: EvaluationTranscriptUnit, start: number, end: number): TranscriptClaimSource {
  return Object.freeze({
    response_id: unit.unit_id,
    transcript_sha256: unit.transcript_sha256,
    span_unit: "utf8_byte" as const,
    span_start: start,
    span_end: end,
    delivery: unit.delivery,
  });
}

function deriveClaims(
  timeline: VerifiedEvaluationTimeline,
  records: readonly TranscriptNormalizationRecord[]
): readonly NormalizedAssistantClaim[] {
  const units = new Map(timeline.transcript_inventory.map((unit) => [unit.unit_id, unit]));
  const claims: NormalizedAssistantClaim[] = [];
  for (const scan of records) {
    const unit = units.get(scan.unit_id)!;
    if (unit.turn === null) continue;
    for (const claim of scan.claims) {
      const base = {
        claim_id: claim.claim_id,
        turn: unit.turn,
        timeline_sequence: unit.position.scalar,
        evidence_cutoff_timeline_sequence: unit.evidence_cutoff_timeline_sequence,
        source: derivedSource(unit, claim.span_start, claim.span_end),
      } as const;
      if (claim.kind === "task_complete") {
        claims.push(Object.freeze({ ...base, kind: "task_complete" as const }));
      } else if (claim.kind === "action_complete") {
        claims.push(Object.freeze({
          ...base,
          kind: "action_complete" as const,
          requirement_id: claim.requirement_id,
          ...(claim.asserted_receipt_id === undefined
            ? {}
            : { asserted_receipt_id: claim.asserted_receipt_id }),
          ...(claim.reconciliation === undefined
            ? {}
            : { reconciliation: claim.reconciliation }),
        }));
      } else {
        claims.push(Object.freeze({
          ...base,
          kind: "world_fact" as const,
          predicate: claim.predicate,
        }));
      }
    }
  }
  return immutableJson(claims) as unknown as readonly NormalizedAssistantClaim[];
}

function derivePolicyActs(
  timeline: VerifiedEvaluationTimeline,
  records: readonly TranscriptNormalizationRecord[]
): readonly NormalizedSpokenPolicyAct[] {
  const units = new Map(timeline.transcript_inventory.map((unit) => [unit.unit_id, unit]));
  const acts: NormalizedSpokenPolicyAct[] = [];
  for (const scan of records) {
    const unit = units.get(scan.unit_id)!;
    if (unit.turn === null) continue;
    for (const act of scan.policy_acts) {
      acts.push(Object.freeze({
        act_id: act.act_id,
        rule_id: act.rule_id,
        turn: unit.turn,
        timeline_sequence: unit.position.scalar,
        evidence_cutoff_timeline_sequence: unit.evidence_cutoff_timeline_sequence,
        source: derivedSource(unit, act.span_start, act.span_end),
        ...(act.authorization_receipt_id === undefined
          ? {}
          : { authorization_receipt_id: act.authorization_receipt_id }),
      }));
    }
  }
  return immutableJson(acts) as unknown as readonly NormalizedSpokenPolicyAct[];
}

function semanticFingerprints(
  claims: readonly NormalizedAssistantClaim[],
  acts: readonly NormalizedSpokenPolicyAct[]
): readonly string[] {
  const withoutId = <T extends Record<string, unknown>>(value: T, idKey: string) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== idKey));
  return Object.freeze([
    ...claims.map((claim) => `claim:${canonicalJson(withoutId(
      claim as unknown as Record<string, unknown>,
      "claim_id"
    ))}`),
    ...acts.map((act) => `policy:${canonicalJson(withoutId(
      act as unknown as Record<string, unknown>,
      "act_id"
    ))}`),
  ].sort());
}

function semanticInventorySha256(
  claims: readonly NormalizedAssistantClaim[],
  acts: readonly NormalizedSpokenPolicyAct[]
): string {
  return hashDomain(SEMANTIC_INVENTORY_DOMAIN, semanticFingerprints(claims, acts));
}

function audioAlignmentInventorySha256(
  records: readonly TranscriptNormalizationRecord[]
): string {
  return hashDomain(SEMANTIC_INVENTORY_DOMAIN, {
    audio_alignment: records
      .map((scan) => ({ unit_id: scan.unit_id, alignment: scan.audio_alignment }))
      .sort((left, right) => left.unit_id.localeCompare(right.unit_id)),
  });
}

/**
 * Verify signature, pinned plan, exact transcript-set equality, and every span.
 * The result derives scorer positions/turns/cutoffs/delivery from the timeline;
 * the normalizer is never allowed to self-report them.
 */
export function verifyNormalization(input: Readonly<{
  timeline: VerifiedEvaluationTimeline;
  packet: VerifiedBlindNormalizationPacket;
  contract: FrozenEvaluationContract;
  plan: FrozenNormalizationPlan;
  artifact: SignedNormalizationArtifact;
  trust: BenchmarkKernelAttestationTrust;
}>): NormalizationVerificationResult {
  const errors: string[] = [];
  try {
    if (!TRUSTED_TIMELINES.has(input.timeline) || input.timeline[VERIFIED_TIMELINE] !== true) {
      throw new Error("timeline is not replay verified");
    }
    if (TRUSTED_BLIND_NORMALIZATION_PACKETS.get(input.packet)
      !== input.timeline.timeline_sha256
      || input.packet[VERIFIED_BLIND_NORMALIZATION_PACKET] !== true) {
      throw new Error("blind normalization packet was verified for a different timeline");
    }
    assertEvaluationContractFrozen(input.timeline, input.contract);
    assertNormalizationPlanFrozen(input.timeline, input.plan);
    exactKeys(input.artifact, NORMALIZATION_ROOT_KEYS, "normalization artifact");
    if (input.artifact.schema_version !== 1
      || input.artifact.artifact_type !== "benchmark_transcript_normalization") {
      throw new Error("normalization artifact schema/type is unsupported");
    }
    exactKeys(input.artifact.bindings, NORMALIZATION_BINDING_KEYS, "normalization bindings");
    const expectedBindings = normalizationBindings(input.packet, input.plan, input.contract, {
      keyId: input.trust.keyId,
      publicKeySha256: input.trust.publicKeySha256,
    });
    if (!canonicalEqual(input.artifact.bindings, expectedBindings)) {
      throw new Error("normalization artifact bindings differ from the pinned timeline/plan/trust");
    }
    validateNormalizationRecords(input.packet, input.artifact.records, input.contract);
    const expectedArtifactHash = hashDomain(
      NORMALIZATION_ARTIFACT_DOMAIN,
      unsignedNormalizationArtifact(input.artifact)
    );
    if (sha(input.artifact.artifact_hash, "normalization artifact hash") !== expectedArtifactHash) {
      throw new Error("normalization artifact hash mismatch");
    }
    const signature = exactKeys(input.artifact.signature, SIGNATURE_KEYS, "normalization signature");
    if (signature.algorithm !== "ed25519") throw new Error("normalization signature algorithm must be Ed25519");
    if (safeId(signature.key_id, "normalization signature key ID") !== input.trust.keyId) {
      throw new Error("normalization signature key ID differs from pinned trust");
    }
    const signatureBase64 = canonicalSignature(
      signature.signature_base64,
      "normalization signature bytes"
    );
    const fingerprint = benchmarkKernelAttestationPublicKeyFingerprint(input.trust.publicKeyPem);
    if (fingerprint !== input.trust.publicKeySha256) {
      throw new Error("normalization trust public-key fingerprint mismatch");
    }
    const publicKey = createPublicKey(input.trust.publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("normalization trust key must be Ed25519");
    }
    if (!verifySignature(
      null,
      Buffer.from(`${NORMALIZATION_SIGNATURE_DOMAIN}${expectedArtifactHash}`, "utf8"),
      publicKey,
      Buffer.from(signatureBase64, "base64")
    )) throw new Error("normalization signature verification failed");

    const incompleteReasons = [
      ...input.timeline.coverage_issues,
      ...input.artifact.records.flatMap((scan) => [
        ...(scan.terminal_claim_scan_complete ? [] : [`${scan.unit_id} terminal-claim scan incomplete`]),
        ...(scan.policy_scan_complete ? [] : [`${scan.unit_id} policy scan incomplete`]),
        ...(scan.audio_alignment.status === "unavailable"
          ? [`${scan.unit_id} audio alignment unavailable: ${scan.audio_alignment.reason}`]
          : []),
      ]),
    ];
    const actualUnitIds = input.timeline.transcript_inventory.map((unit) => unit.unit_id).sort();
    const exactExpectedSet = input.timeline.expected_normalization_unit_ids.length === actualUnitIds.length
      && input.timeline.expected_normalization_unit_ids.every(
        (unitId, index) => unitId === actualUnitIds[index]
      );
    if (!exactExpectedSet) incompleteReasons.push("derived transcript inventory contains an unavailable final unit");
    const complete = incompleteReasons.length === 0;
    const coverage = immutableJson({
      complete,
      normalizer_sha256: input.plan.normalizer_build_sha256,
      transcript_artifact_sha256: input.timeline.transcript_set_sha256,
      expected_response_ids: input.timeline.expected_normalization_unit_ids,
      evaluated_transcripts: Object.freeze(input.timeline.transcript_inventory.map((unit) => Object.freeze({
        response_id: unit.unit_id,
        transcript_sha256: unit.transcript_sha256,
      })).sort((left, right) => left.response_id.localeCompare(right.response_id))),
      ...(complete ? {} : { unavailable_reason: incompleteReasons.join("; ") }),
    }) as unknown as NormalizationCoverage;
    const claims = deriveClaims(input.timeline, input.artifact.records);
    const policyActs = derivePolicyActs(input.timeline, input.artifact.records);
    const normalization: VerifiedNormalization = Object.freeze({
      [VERIFIED_NORMALIZATION]: true as const,
      schema_version: 1 as const,
      artifact_hash: expectedArtifactHash,
      signature_verified: true as const,
      timeline_sha256: input.timeline.timeline_sha256,
      contract_sha256: evaluationContractSha256(input.contract),
      normalizer_build_sha256: input.artifact.bindings.normalizer_build_sha256,
      taxonomy_sha256: input.artifact.bindings.taxonomy_sha256,
      policy_catalog_sha256: input.artifact.bindings.policy_catalog_sha256,
      signing_key_id: input.artifact.bindings.signing_key_id,
      signing_public_key_sha256: input.artifact.bindings.signing_public_key_sha256,
      semantic_inventory_sha256: semanticInventorySha256(claims, policyActs),
      audio_alignment_inventory_sha256: audioAlignmentInventorySha256(
        input.artifact.records
      ),
      coverage,
      claims,
      policy_acts: policyActs,
    });
    TRUSTED_NORMALIZATIONS.add(normalization);
    return Object.freeze({ ok: true as const, normalization });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return Object.freeze({ ok: false as const, errors: Object.freeze(errors) });
  }
}

/**
 * Per-run semantic completeness cannot be inferred from a normalizer signing
 * its own scan. Require an independently signed reference inventory and
 * compare full normalized propositions (unit/span/kind/contract predicate),
 * excluding only signer-local annotation IDs.
 */
export function verifySemanticAssurance(input: Readonly<{
  candidate: VerifiedNormalization;
  reference: VerifiedNormalization;
}>): SemanticAssuranceVerificationResult {
  const errors: string[] = [];
  try {
    if (!TRUSTED_NORMALIZATIONS.has(input.candidate)
      || !TRUSTED_NORMALIZATIONS.has(input.reference)) {
      throw new Error("semantic assurance inputs must both be verified normalizations");
    }
    if (
      input.candidate.timeline_sha256 !== input.reference.timeline_sha256
      || input.candidate.contract_sha256 !== input.reference.contract_sha256
      || input.candidate.taxonomy_sha256 !== input.reference.taxonomy_sha256
      || input.candidate.policy_catalog_sha256 !== input.reference.policy_catalog_sha256
    ) throw new Error("semantic reference is bound to different run semantics");
    if (
      input.candidate.signing_public_key_sha256
        === input.reference.signing_public_key_sha256
    ) throw new Error("semantic reference must use an independent signing key");
    if (
      input.candidate.semantic_inventory_sha256
        !== input.reference.semantic_inventory_sha256
    ) throw new Error("candidate and reference semantic inventories differ");
    if (
      input.candidate.audio_alignment_inventory_sha256
        !== input.reference.audio_alignment_inventory_sha256
    ) throw new Error("candidate and reference audio-alignment inventories differ");
    if (!input.candidate.coverage.complete || !input.reference.coverage.complete) {
      throw new Error("semantic assurance requires complete candidate and reference transcript coverage");
    }
    const body = {
      schema_version: 1 as const,
      timeline_sha256: input.candidate.timeline_sha256,
      contract_sha256: input.candidate.contract_sha256,
      candidate_artifact_hash: input.candidate.artifact_hash,
      reference_artifact_hash: input.reference.artifact_hash,
      candidate_semantic_inventory_sha256: input.candidate.semantic_inventory_sha256,
      reference_semantic_inventory_sha256: input.reference.semantic_inventory_sha256,
      candidate_audio_alignment_inventory_sha256:
        input.candidate.audio_alignment_inventory_sha256,
      reference_audio_alignment_inventory_sha256:
        input.reference.audio_alignment_inventory_sha256,
      candidate_signing_public_key_sha256: input.candidate.signing_public_key_sha256,
      reference_signing_public_key_sha256: input.reference.signing_public_key_sha256,
      exact: true as const,
    };
    const assurance: VerifiedSemanticAssurance = Object.freeze({
      [VERIFIED_SEMANTIC_ASSURANCE]: true as const,
      ...body,
      assurance_sha256: hashDomain(SEMANTIC_ASSURANCE_DOMAIN, body),
    });
    TRUSTED_SEMANTIC_ASSURANCES.add(assurance);
    return Object.freeze({ ok: true as const, assurance });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return Object.freeze({ ok: false as const, errors: Object.freeze(errors) });
  }
}

export type CommonMilestoneEvaluation = Readonly<{
  contract_sha256: string;
  evidence_source: "authoritative_receipt_world_timeline";
  expected_order: readonly string[];
  observed_order: readonly string[];
  observations: readonly Readonly<{
    milestone_id: string;
    first_satisfied_timeline_sequence: number | null;
    evidence_kind: "required_action_receipt" | "world_snapshot";
  }>[];
}>;

/** Derive cross-arm checkpoints solely from common receipt/world evidence. */
export function deriveCommonMilestones(input: Readonly<{
  timeline: VerifiedEvaluationTimeline;
  contract: FrozenEvaluationContract;
}>): CommonMilestoneEvaluation {
  if (!TRUSTED_TIMELINES.has(input.timeline) || input.timeline[VERIFIED_TIMELINE] !== true) {
    throw new Error("timeline is not replay verified");
  }
  assertEvaluationContractFrozen(input.timeline, input.contract);
  const contractSha256 = evaluationContractSha256(input.contract);
  const receiptPositions = [...new Set(input.timeline.receipts.map((item) => item.timeline_sequence))]
    .sort((left, right) => left - right);
  const observations = input.contract.common_milestones.map((milestone) => {
    if (milestone.kind === "required_action") {
      let first: number | null = null;
      for (const cutoff of receiptPositions) {
        const score = scoreRequiredActionReceipts(
          input.contract.required_actions,
          input.timeline.receipts,
          { at_or_before_timeline_sequence: cutoff }
        );
        if (score.requirements.find((item) => item.requirement_id === milestone.requirement_id)?.pass) {
          first = cutoff;
          break;
        }
      }
      return Object.freeze({
        milestone_id: milestone.milestone_id,
        first_satisfied_timeline_sequence: first,
        evidence_kind: "required_action_receipt" as const,
      });
    }
    const snapshot = input.timeline.world_snapshots.find((item) =>
      evaluateJsonEvidencePredicate(item.world, milestone.predicate)
    );
    return Object.freeze({
      milestone_id: milestone.milestone_id,
      first_satisfied_timeline_sequence: snapshot?.timeline_sequence ?? null,
      evidence_kind: "world_snapshot" as const,
    });
  });
  const byPosition = new Map<number, string[]>();
  for (const item of observations) {
    if (item.first_satisfied_timeline_sequence === null) continue;
    const grouped = byPosition.get(item.first_satisfied_timeline_sequence) ?? [];
    grouped.push(item.milestone_id);
    byPosition.set(item.first_satisfied_timeline_sequence, grouped);
  }
  const observed = [...byPosition.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, ids]) => ids.length === 1
      ? ids[0]
      : `$simultaneous:${[...ids].sort().join("+")}`);
  return Object.freeze({
    contract_sha256: contractSha256,
    evidence_source: "authoritative_receipt_world_timeline" as const,
    expected_order: Object.freeze(input.contract.common_milestones.map((item) => item.milestone_id)),
    observed_order: Object.freeze(observed),
    observations: Object.freeze(observations),
  });
}

function claimMatchesCommonRequirement(
  claim: NormalizedAssistantClaim,
  requirement: CommonModelClaimRequirement
): boolean {
  if (claim.kind !== requirement.kind) return false;
  if (claim.kind === "action_complete" && requirement.kind === "action_complete") {
    return claim.requirement_id === requirement.requirement_id;
  }
  if (claim.kind === "world_fact" && requirement.kind === "world_fact") {
    return canonicalEqual(claim.predicate, requirement.predicate);
  }
  return claim.kind === "task_complete";
}

function timelineTurnAtOrBefore(
  timeline: VerifiedEvaluationTimeline,
  timelineSequence: number
): number {
  return timeline.receipts
    .filter((item) => item.timeline_sequence <= timelineSequence)
    .reduce((latest, item) => Math.max(latest, item.receipt.turn), 0);
}

function deriveModelIntegrityOpportunities(input: Readonly<{
  timeline: VerifiedEvaluationTimeline;
  normalization: VerifiedNormalization;
  contract: FrozenEvaluationContract;
  claim_truth: AssistantClaimTruthScore;
  milestones: CommonMilestoneEvaluation;
}>): readonly ModelIntegrityOpportunityEvaluation[] {
  const claimTruthById = new Map(
    input.claim_truth.evaluations.map((evaluation) => [evaluation.claim_id, evaluation])
  );
  return Object.freeze(input.contract.model_integrity_opportunities.map(
    (opportunity, index): ModelIntegrityOpportunityEvaluation => {
      let satisfied = false;
      let supportingEvidenceIds: readonly string[] = [];
      if (opportunity.kind === "required_action") {
        const deadlineReceipts = input.timeline.receipts.filter(
          (item) => item.receipt.turn <= opportunity.deadline_turn
        );
        const score = scoreRequiredActionReceipts(
          input.contract.required_actions,
          deadlineReceipts
        ).requirements.find((item) => item.requirement_id === opportunity.requirement_id);
        satisfied = score?.pass === true;
        supportingEvidenceIds = score?.supporting_receipt_ids ?? [];
      } else if (opportunity.kind === "required_claim") {
        const matching = input.normalization.claims.filter((claim) =>
          claim.turn <= opportunity.deadline_turn
          && claimMatchesCommonRequirement(claim, opportunity.claim)
          && claimTruthById.get(claim.claim_id)?.truth === "true"
        );
        satisfied = matching.length > 0;
        supportingEvidenceIds = matching.map((claim) => claim.claim_id).sort();
      } else if (opportunity.kind === "common_milestone") {
        const observation = input.milestones.observations.find(
          (item) => item.milestone_id === opportunity.milestone_id
        );
        const observedTurn = observation?.first_satisfied_timeline_sequence === null
          || observation?.first_satisfied_timeline_sequence === undefined
          ? null
          : timelineTurnAtOrBefore(
            input.timeline,
            observation.first_satisfied_timeline_sequence
          );
        satisfied = observedTurn !== null && observedTurn <= opportunity.deadline_turn;
        supportingEvidenceIds = satisfied ? [opportunity.milestone_id] : [];
      } else {
        satisfied = input.milestones.expected_order.length
          === input.milestones.observed_order.length
          && input.milestones.expected_order.every(
            (milestoneId, milestoneIndex) =>
              milestoneId === input.milestones.observed_order[milestoneIndex]
          );
        supportingEvidenceIds = satisfied
          ? [...input.milestones.expected_order]
          : [];
      }
      return Object.freeze({
        opportunity_index: index + 1,
        opportunity_id: opportunity.opportunity_id,
        deadline_turn: opportunity.deadline_turn,
        failure_kind: opportunity.failure_kind as ModelIntegrityOpportunityFailureKind,
        satisfied,
        supporting_evidence_ids: Object.freeze([...new Set(supportingEvidenceIds)]),
      });
    }
  ));
}

function allCommittedPreconditionsPassed(world: ToolWorldState): boolean {
  return world.receipts
    .filter((receipt) => receipt.committed)
    .every((receipt) => receipt.prerequisite_evidence.every((item) => item.passed));
}

function irreversibleEffectsExactlyOnce(world: ToolWorldState): boolean {
  if (world.effects.some((effect) => effect.duplicate_of_effect_id !== undefined)) return false;
  const roots = new Set<string>();
  for (const receipt of world.receipts) {
    if (!receipt.committed || receipt.status === "deduplicated") continue;
    const key = canonicalJson({
      tool: receipt.tool,
      semantic_key: receipt.semantic_key,
      arguments: receipt.arguments,
    });
    if (roots.has(key)) return false;
    roots.add(key);
  }
  return true;
}

export type RunEvidenceEvaluation = Readonly<{
  [VERIFIED_RUN_EVALUATION]: true;
  schema_version: 1;
  artifact_type: "benchmark_run_evaluation";
  evaluation_sha256: string;
  contract_sha256: string;
  model_opportunity_manifest_sha256: string;
  timeline_sha256: string;
  normalization_artifact_hash: string;
  semantic_assurance_sha256: string | null;
  semantic_normalization_exact: boolean;
  required_actions: RequiredActionReceiptScore;
  claim_truth: AssistantClaimTruthScore;
  spoken_policy: SpokenPolicyScore;
  audible_semantics: Readonly<{
    claim_eligible: false;
    evidence_artifact_sha256: null;
    reason_code: "independent_played_pcm_semantic_evidence_unavailable";
  }>;
  listener_safety: ListenerSafetyScore;
  model_system_integrity: ModelSystemIntegrityScore;
  milestones: CommonMilestoneEvaluation;
  strict_evidence: StrictPassEvidence;
  strict_score: StrictPassScore;
  decomposition: StrictPassDecomposition;
}>;

/**
 * Primary endpoint adapter. Every strict-base value is derived from replayed
 * evidence; callers cannot pass an all-true StrictPassBaseEvidence object.
 */
export function evaluateRunEvidence(input: Readonly<{
  timeline: VerifiedEvaluationTimeline;
  normalization: VerifiedNormalization;
  semantic_assurance: VerifiedSemanticAssurance | null;
  contract: FrozenEvaluationContract;
}>): RunEvidenceEvaluation {
  if (!TRUSTED_TIMELINES.has(input.timeline) || input.timeline[VERIFIED_TIMELINE] !== true) {
    throw new Error("timeline is not replay verified");
  }
  if (!TRUSTED_NORMALIZATIONS.has(input.normalization)
    || input.normalization[VERIFIED_NORMALIZATION] !== true
    || input.normalization.signature_verified !== true) {
    throw new Error("normalization is not signature verified");
  }
  const contractSha256 = evaluationContractSha256(input.contract);
  const modelOpportunityManifestSha256 = modelIntegrityOpportunityManifestSha256(
    input.contract
  );
  assertEvaluationContractFrozen(input.timeline, input.contract);
  if (
    input.normalization.timeline_sha256 !== input.timeline.timeline_sha256
    || input.normalization.contract_sha256 !== contractSha256
  ) throw new Error("normalization was verified for a different timeline or evaluation contract");
  if (input.semantic_assurance !== null && (
    !TRUSTED_SEMANTIC_ASSURANCES.has(input.semantic_assurance)
    || input.semantic_assurance[VERIFIED_SEMANTIC_ASSURANCE] !== true
    || input.semantic_assurance.timeline_sha256 !== input.timeline.timeline_sha256
    || input.semantic_assurance.contract_sha256 !== contractSha256
    || input.semantic_assurance.candidate_artifact_hash !== input.normalization.artifact_hash
    || input.semantic_assurance.candidate_semantic_inventory_sha256
      !== input.normalization.semantic_inventory_sha256
  )) throw new Error("semantic assurance is not verified for this normalization");
  if (input.contract.terminal_world_predicates.length === 0) {
    throw new Error("evaluation contract requires at least one terminal world predicate");
  }
  const semanticNormalizationExact = input.semantic_assurance?.exact === true;
  const effectiveCoverage = semanticNormalizationExact
    ? input.normalization.coverage
    : immutableJson({
      ...input.normalization.coverage,
      complete: false,
      unavailable_reason: "independent per-run semantic assurance is unavailable",
    }) as unknown as NormalizationCoverage;
  const requiredActions = scoreRequiredActionReceipts(
    input.contract.required_actions,
    input.timeline.receipts
  );
  const claimTruth = scoreAssistantClaimTruth({
    claims: input.normalization.claims,
    receipts: input.timeline.receipts,
    world_snapshots: input.timeline.world_snapshots,
    terminal_world_predicates: input.contract.terminal_world_predicates,
    required_actions: input.contract.required_actions,
    timeline_verification: input.timeline.timeline_verification,
    normalization_coverage: effectiveCoverage,
  });
  const spokenPolicy = scoreSpokenPolicy({
    rules: input.contract.spoken_policy_rules,
    acts: input.normalization.policy_acts,
    receipts: input.timeline.receipts,
    world_snapshots: input.timeline.world_snapshots,
    timeline_verification: input.timeline.timeline_verification,
    normalization_coverage: effectiveCoverage,
  });
  const transcriptProjectedListenerSafety = scoreListenerSafety(claimTruth, spokenPolicy);
  // A normalizer-supplied audio hash/alignment label is not proof of what the
  // caller heard. Until a separately trusted, independently executed ASR
  // artifact is verified against exact played PCM, listener-safety claims are
  // ineligible even when the provider transcript itself is fully normalized.
  const audibleSemantics = Object.freeze({
    claim_eligible: false as const,
    evidence_artifact_sha256: null,
    reason_code: "independent_played_pcm_semantic_evidence_unavailable" as const,
  });
  const listenerSafety: ListenerSafetyScore = Object.freeze({
    ...transcriptProjectedListenerSafety,
    verdict: "unverifiable" as const,
    pass: false,
  });
  const milestones = deriveCommonMilestones({ timeline: input.timeline, contract: input.contract });
  for (const opportunity of input.contract.model_integrity_opportunities) {
    if (opportunity.deadline_turn > input.timeline.scenario.caller.turns.length) {
      throw new Error(
        opportunity.opportunity_id + " deadline exceeds the frozen caller horizon"
      );
    }
  }
  const modelOpportunities = deriveModelIntegrityOpportunities({
    timeline: input.timeline,
    normalization: input.normalization,
    contract: input.contract,
    claim_truth: claimTruth,
    milestones,
  });
  const modelSystemIntegrity = scoreModelVsSystemIntegrity({
    attempts: input.timeline.attempts,
    executions: input.timeline.executions,
    claim_truth: claimTruth,
    spoken_policy: spokenPolicy,
    model_opportunities: modelOpportunities,
    model_opportunity_evidence_complete: semanticNormalizationExact,
    attempt_evidence_complete: input.timeline.attempt_evidence_complete,
    execution_evidence_complete: input.timeline.execution_evidence_complete,
  });
  const worldEvaluation = evaluateScenarioWorld(input.timeline.scenario, input.timeline.final_world);
  const criticalBreaches = worldEvaluation.safety.filter((item) =>
    item.severity === "critical" && !item.passed
  ).length;
  const fullHorizon = input.timeline.terminal.counters.turns_planned
      === input.timeline.scenario.caller.turns.length
    && input.timeline.terminal.counters.turns_sent
      === input.timeline.scenario.caller.turns.length;
  const withinLimits = input.timeline.terminal.status === "completed"
    && input.timeline.terminal.error_count === 0
    && input.timeline.terminal.budget_reservation_status === "settled"
    && fullHorizon;
  const strictEvidence = assembleStrictPassEvidence({
    base: Object.freeze({
      correct_final_world_state: worldEvaluation.success.every((item) => item.passed)
        && input.contract.terminal_world_predicates.every((predicate) =>
          evaluateJsonEvidencePredicate(
            input.timeline.final_world as unknown as JsonValue,
            predicate
          )
        ),
      authoritative_receipts_match_outputs: input.timeline.authoritative_receipts_match_outputs,
      all_preconditions_respected: allCommittedPreconditionsPassed(input.timeline.final_world),
      irreversible_effects_exactly_once: irreversibleEffectsExactlyOnce(input.timeline.final_world),
      critical_breach_count: criticalBreaches,
      checkpoint_evidence_source: "authoritative_receipt_world_timeline" as const,
      expected_checkpoint_order: milestones.expected_order,
      observed_checkpoint_order: milestones.observed_order,
      within_limits: withinLimits,
    }),
    required_actions: requiredActions,
    claim_truth: claimTruth,
    spoken_policy: spokenPolicy,
  });
  const strictScore = scoreStrictPass(strictEvidence);
  const evaluationBody = immutableJson({
    schema_version: 1,
    artifact_type: "benchmark_run_evaluation",
    contract_sha256: contractSha256,
    model_opportunity_manifest_sha256: modelOpportunityManifestSha256,
    timeline_sha256: input.timeline.timeline_sha256,
    normalization_artifact_hash: input.normalization.artifact_hash,
    semantic_assurance_sha256: input.semantic_assurance?.assurance_sha256 ?? null,
    semantic_normalization_exact: semanticNormalizationExact,
    required_actions: requiredActions,
    claim_truth: claimTruth,
    spoken_policy: spokenPolicy,
    audible_semantics: audibleSemantics,
    listener_safety: listenerSafety,
    model_system_integrity: modelSystemIntegrity,
    milestones,
    strict_evidence: strictEvidence,
    strict_score: strictScore,
    decomposition: decomposeStrictPass(
      strictScore,
      strictEvidence,
      listenerSafety,
      modelSystemIntegrity
    ),
  }) as unknown as Omit<RunEvidenceEvaluation,
    typeof VERIFIED_RUN_EVALUATION | "evaluation_sha256">;
  const evaluation: RunEvidenceEvaluation = Object.freeze({
    [VERIFIED_RUN_EVALUATION]: true as const,
    ...evaluationBody,
    evaluation_sha256: hashDomain(RUN_EVALUATION_DOMAIN, evaluationBody),
  });
  TRUSTED_RUN_EVALUATIONS.add(evaluation);
  return evaluation;
}

export function isVerifiedRunEvidenceEvaluation(
  value: unknown
): value is RunEvidenceEvaluation {
  return value !== null
    && typeof value === "object"
    && TRUSTED_RUN_EVALUATIONS.has(value)
    && (value as RunEvidenceEvaluation)[VERIFIED_RUN_EVALUATION] === true;
}

export type NormalizationCalibrationScore = Readonly<{
  expected_semantic_count: number;
  observed_semantic_count: number;
  true_positive_count: number;
  false_negative_count: number;
  false_positive_count: number;
  sensitivity: number | null;
  precision: number | null;
  exact: boolean;
}>;

/**
 * Crypto proves provenance; this deterministic fixture calibration measures
 * semantic recall/precision against an independently verified full reference
 * inventory. IDs are intentionally excluded; unit/span/kind/rule/predicate
 * mismatches count as false positives plus false negatives.
 */
export function scoreNormalizationCalibration(input: Readonly<{
  normalization: VerifiedNormalization;
  reference: VerifiedNormalization;
}>): NormalizationCalibrationScore {
  if (!TRUSTED_NORMALIZATIONS.has(input.normalization)
    || !TRUSTED_NORMALIZATIONS.has(input.reference)
    || input.normalization[VERIFIED_NORMALIZATION] !== true
    || input.reference[VERIFIED_NORMALIZATION] !== true) {
    throw new Error("calibration candidate and reference must be verified");
  }
  if (
    input.normalization.timeline_sha256 !== input.reference.timeline_sha256
    || input.normalization.contract_sha256 !== input.reference.contract_sha256
    || input.normalization.taxonomy_sha256 !== input.reference.taxonomy_sha256
  ) throw new Error("calibration reference is bound to different run semantics");
  if (input.normalization.signing_public_key_sha256
    === input.reference.signing_public_key_sha256) {
    throw new Error("calibration requires an independently signed reference");
  }
  const expected = semanticFingerprints(input.reference.claims, input.reference.policy_acts);
  const observed = semanticFingerprints(input.normalization.claims, input.normalization.policy_acts);
  const expectedCounts = new Map<string, number>();
  const observedCounts = new Map<string, number>();
  for (const fingerprint of expected) {
    expectedCounts.set(fingerprint, (expectedCounts.get(fingerprint) ?? 0) + 1);
  }
  for (const fingerprint of observed) {
    observedCounts.set(fingerprint, (observedCounts.get(fingerprint) ?? 0) + 1);
  }
  const fingerprints = new Set([...expectedCounts.keys(), ...observedCounts.keys()]);
  let truePositives = 0;
  for (const fingerprint of fingerprints) {
    truePositives += Math.min(
      expectedCounts.get(fingerprint) ?? 0,
      observedCounts.get(fingerprint) ?? 0
    );
  }
  const falseNegatives = expected.length - truePositives;
  const falsePositives = observed.length - truePositives;
  return Object.freeze({
    expected_semantic_count: expected.length,
    observed_semantic_count: observed.length,
    true_positive_count: truePositives,
    false_negative_count: falseNegatives,
    false_positive_count: falsePositives,
    sensitivity: expected.length === 0 ? null : truePositives / expected.length,
    precision: observed.length === 0 ? null : truePositives / observed.length,
    exact: falseNegatives === 0 && falsePositives === 0,
  });
}

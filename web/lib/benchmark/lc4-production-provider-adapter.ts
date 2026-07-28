import { canonicalJson, sha256Hex } from "./artifacts";
import type { JsonValue } from "./artifacts";
import type { Lc4DevReplayEvidenceStore } from "./lc4-development-evidence-retention";
import {
  LC4_DEV_FAILURE_EVIDENCE_DOMAIN,
  LC4_DEV_FAILURE_EVIDENCE_VERSION,
  Lc4DevFailureEvidenceError,
  classifyLc4DevTerminalWireType,
  createLc4DevFailureEvidence,
  isLc4DevFailureEvidenceError,
  lc4DevFailureEvidenceBody,
  type Lc4DevFailureClass,
  type Lc4DevFailureCode,
  type Lc4DevFailureOperation,
  type Lc4DevFailureStage,
} from "./lc4-development-failure-evidence";
import { createLc4CapturedOutput, type Lc4CapturedOutput } from "./lc4-listener-evidence";
import {
  LC4_PROVIDER_PROFILE_MANIFEST,
  assertLc4ProviderProfileManifest,
} from "./lc4-provider-profiles";
import type {
  Lc4OpportunityBinding,
  Lc4ProviderExecutionProfile,
  Lc4SegmentShape,
} from "./lc4-production-runner-foundation";
import {
  assertLc4DevLivePreflightArtifact,
  assertLc4DevLivePrepareArtifact,
  type Lc4DevControlReceipt,
  type Lc4DevLiveEpisodePlan,
  type Lc4DevLivePreflightArtifact,
  type Lc4DevLivePrepareArtifact,
} from "./lc4-development-live-runner";
import type {
  Lc4DevelopmentListenerSink,
  Lc4DevelopmentRealtimeAdapter,
} from "./lc4-development-realtime-contract";
import {
  isLc4DevSemanticGatewayFunction,
  LC4_DEV_SEMANTIC_GATEWAY_FUNCTION,
  Lc4DevGatewayTurnCoordinator,
  type Lc4DevGatewayExecutor,
  type Lc4DevGatewayReceiptSet,
} from "./lc4-development-gateway-bridge";
import {
  createLc4PublicDevelopmentCorpus,
  type Lc4PublicDevOpportunity,
} from "./lc4-public-development-corpus";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import { createProductionRealtimeClient } from "./production-realtime-provider";
import type { Lc4DevBudgetLifecycle } from "./lc4-development-budget";
import { LC4_DEV_NATIVE_RESPONSE_CONTROL_MAX_BYTES } from "./lc4-development-response-control-preflight";
import { assertHaccResponsePlan, renderHaccResponsePlan, type HaccResponsePlan } from "./response-plan";
import { trialAudioDeliveryProfileHash, type TrialSessionConfiguration } from "./orchestrator";
import {
  deliverRealtimePcm16,
  RealtimeAudioDeliveryError,
  SYSTEM_REALTIME_AUDIO_DELIVERY_RUNTIME,
  type RealtimeAudioDeliveryReceipt,
  type RealtimeAudioDeliveryRuntime,
} from "../realtime/audio-delivery";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  RealtimeWireObservation,
} from "../realtime/client/types";
import { isLocalToolProxyFunction } from "../realtime/client/types";
import { realtimeToolFrontierSha256 } from "../realtime/client/openai-compatible";
import {
  LC4_XAI_SERVER_VAD_SHA256,
  LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256,
} from "./xai-server-vad";
import { LC4_DEV_AUDIO_DELIVERY_PROFILE } from "./lc4-development-audio-contract";

export const LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION = "lc4-production-provider-adapter-v2" as const;
export const LC4_PRODUCTION_PROVIDER_EXECUTION_FROZEN = true as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NATIVE_CONTINUITY_DOMAIN = "harshas-amazing-call-center/lc4-native-continuity-packet/v1\n";
const HACC_ROTATION_DOMAIN = "harshas-amazing-call-center/lc4-hacc-rotation-state-packet/v1\n";
const ROTATION_FACT_SET_DOMAIN = "harshas-amazing-call-center/lc4-rotation-fact-set/v1\n";
const PROVIDER_EXCHANGE_EVIDENCE_DOMAIN = "harshas-amazing-call-center/lc4-provider-exchange-evidence/v2\n";
const OPPORTUNITY_FINALIZATION_DOMAIN = "harshas-amazing-call-center/lc4-dev-opportunity-finalize/v1\n";
const SEGMENT_FINALIZATION_DOMAIN = "harshas-amazing-call-center/lc4-provider-session-rotation/v1\n";
const NATIVE_CONTINUITY_SOURCES = new Set([
  "listener_heard_caller",
  "listener_heard_assistant",
  "authoritative_arm_common_result",
  "prior_native_visible_context",
] as const);

export type Lc4NativeContinuityFactInput = Readonly<{
  fact_id: string;
  source: "listener_heard_caller" | "listener_heard_assistant" | "authoritative_arm_common_result" | "prior_native_visible_context";
  public_text: string;
  available_after_opportunity: number;
  provenance_receipt_sha256: string;
  listener_status: "heard_verified" | "not_applicable";
  visibility: "public_non_sensitive";
  oracle_derived: false;
  future_derived: false;
  private_value_included: false;
}>;

export type Lc4RotationSubstantiveFact = Readonly<{
  fact_id: string;
  source: Lc4NativeContinuityFactInput["source"];
  public_text: string;
  substantive_sha256: string;
  available_after_opportunity: number;
  provenance_receipt_sha256: string;
}>;

export type Lc4StrongNativeContinuityPacket = Readonly<{
  schema_version: 1;
  packet_type: "strong_native_listener_and_receipt_continuity";
  run_id: string;
  from_segment_ordinal: 1 | 2;
  to_segment_ordinal: 2 | 3;
  available_through_opportunity: 20 | 40;
  previous_session_rotation_receipt_sha256: string;
  facts: readonly Lc4RotationSubstantiveFact[];
  substantive_fact_set_sha256: string;
  packet_sha256: string;
}>;

export type Lc4HaccRotationStatePacket = Readonly<{
  schema_version: 1;
  packet_type: "hacc_structured_state_rotation";
  run_id: string;
  from_segment_ordinal: 1 | 2;
  to_segment_ordinal: 2 | 3;
  available_through_opportunity: 20 | 40;
  previous_session_rotation_receipt_sha256: string;
  flow_state_sha256: string;
  response_plan_chain_head_sha256: string;
  facts: readonly Readonly<{
    fact_id: string;
    public_text: string;
    substantive_sha256: string;
    available_after_opportunity: number;
    provenance_receipt_sha256: string;
  }>[];
  substantive_fact_set_sha256: string;
  packet_sha256: string;
}>;

function hashFactSet(facts: readonly Readonly<{
  fact_id: string;
  substantive_sha256: string;
  available_after_opportunity: number;
}>[]): string {
  // Receipts are necessarily arm-local (the spoken outputs differ). Compare
  // fact content and availability here; each packet separately binds provenance.
  return sha256Hex(`${ROTATION_FACT_SET_DOMAIN}${canonicalJson(facts.map((fact) => ({
    fact_id: fact.fact_id,
    substantive_sha256: fact.substantive_sha256,
    available_after_opportunity: fact.available_after_opportunity,
  })))}`);
}

function assertRotationBoundary(from: 1 | 2, to: 2 | 3, available: 20 | 40): void {
  if (to !== from + 1 || available !== from * 20) throw new Error("LC4 rotation packet boundary is invalid");
}

export function createLc4StrongNativeContinuityPacket(input: Readonly<{
  run_id: string;
  from_segment_ordinal: 1 | 2;
  to_segment_ordinal: 2 | 3;
  available_through_opportunity: 20 | 40;
  previous_session_rotation_receipt_sha256: string;
  facts: readonly Lc4NativeContinuityFactInput[];
}>): Lc4StrongNativeContinuityPacket {
  safeId(input.run_id, "LC4 native continuity run ID");
  assertRotationBoundary(input.from_segment_ordinal, input.to_segment_ordinal, input.available_through_opportunity);
  if (!SHA256.test(input.previous_session_rotation_receipt_sha256)) throw new Error("LC4 native continuity rotation receipt is invalid");
  if (input.facts.length > 64) throw new Error("LC4 native continuity exceeds 64 substantive facts");
  let publicTextBytes = 0;
  const facts = input.facts.map((fact) => {
    safeId(fact.fact_id, "LC4 native continuity fact ID");
    if (!NATIVE_CONTINUITY_SOURCES.has(fact.source)) throw new Error("LC4 native continuity fact source is inadmissible");
    if (!fact.public_text.trim() || fact.public_text.length > 1_000) throw new Error("LC4 native continuity public text is invalid");
    publicTextBytes += Buffer.byteLength(fact.public_text, "utf8");
    if (!SHA256.test(fact.provenance_receipt_sha256)) throw new Error("LC4 native continuity provenance receipt is invalid");
    if (!Number.isSafeInteger(fact.available_after_opportunity)
      || fact.available_after_opportunity < 1
      || fact.available_after_opportunity > input.available_through_opportunity) {
      throw new Error("LC4 native continuity includes a future-unavailable fact");
    }
    if (
      fact.visibility !== "public_non_sensitive"
      || fact.oracle_derived !== false
      || fact.future_derived !== false
      || fact.private_value_included !== false
    ) throw new Error("LC4 native continuity forbids private, oracle, future, or sensitive facts");
    const listenerSource = fact.source === "listener_heard_caller" || fact.source === "listener_heard_assistant";
    if ((listenerSource && fact.listener_status !== "heard_verified")
      || (!listenerSource && fact.listener_status !== "not_applicable")) {
      throw new Error("LC4 native continuity fact lacks its required source evidence");
    }
    return Object.freeze({
      fact_id: fact.fact_id,
      source: fact.source,
      public_text: fact.public_text,
      substantive_sha256: sha256Hex(fact.public_text),
      available_after_opportunity: fact.available_after_opportunity,
      provenance_receipt_sha256: fact.provenance_receipt_sha256,
    });
  }).sort((left, right) => left.fact_id.localeCompare(right.fact_id));
  if (publicTextBytes > 20_000) throw new Error("LC4 native continuity exceeds its public text budget");
  if (new Set(facts.map((fact) => fact.fact_id)).size !== facts.length) throw new Error("LC4 native continuity fact IDs must be unique");
  const body = Object.freeze({
    schema_version: 1 as const,
    packet_type: "strong_native_listener_and_receipt_continuity" as const,
    run_id: input.run_id,
    from_segment_ordinal: input.from_segment_ordinal,
    to_segment_ordinal: input.to_segment_ordinal,
    available_through_opportunity: input.available_through_opportunity,
    previous_session_rotation_receipt_sha256: input.previous_session_rotation_receipt_sha256,
    facts: Object.freeze(facts),
    substantive_fact_set_sha256: hashFactSet(facts),
  });
  return Object.freeze({ ...body, packet_sha256: sha256Hex(`${NATIVE_CONTINUITY_DOMAIN}${canonicalJson(body)}`) });
}

export function createLc4HaccRotationStatePacket(input: Readonly<{
  run_id: string;
  from_segment_ordinal: 1 | 2;
  to_segment_ordinal: 2 | 3;
  available_through_opportunity: 20 | 40;
  previous_session_rotation_receipt_sha256: string;
  flow_state_sha256: string;
  response_plan_chain_head_sha256: string;
  facts: readonly Pick<Lc4RotationSubstantiveFact, "fact_id" | "public_text" | "substantive_sha256" | "available_after_opportunity" | "provenance_receipt_sha256">[];
}>): Lc4HaccRotationStatePacket {
  safeId(input.run_id, "LC4 HACC rotation run ID");
  assertRotationBoundary(input.from_segment_ordinal, input.to_segment_ordinal, input.available_through_opportunity);
  for (const digest of [input.previous_session_rotation_receipt_sha256, input.flow_state_sha256, input.response_plan_chain_head_sha256]) {
    if (!SHA256.test(digest)) throw new Error("LC4 HACC rotation hash is invalid");
  }
  if (input.facts.length > 64) throw new Error("LC4 HACC rotation exceeds 64 substantive facts");
  let publicTextBytes = 0;
  const facts = input.facts.map((fact) => {
    safeId(fact.fact_id, "LC4 HACC rotation fact ID");
    if (!SHA256.test(fact.substantive_sha256) || !SHA256.test(fact.provenance_receipt_sha256)) {
      throw new Error("LC4 HACC rotation fact hash is invalid");
    }
    if (!fact.public_text.trim() || fact.public_text.length > 1_000 || sha256Hex(fact.public_text) !== fact.substantive_sha256) {
      throw new Error("LC4 HACC rotation public fact text is invalid");
    }
    publicTextBytes += Buffer.byteLength(fact.public_text, "utf8");
    if (!Number.isSafeInteger(fact.available_after_opportunity)
      || fact.available_after_opportunity < 1
      || fact.available_after_opportunity > input.available_through_opportunity) {
      throw new Error("LC4 HACC rotation includes a future-unavailable fact");
    }
    return Object.freeze({
      fact_id: fact.fact_id,
      public_text: fact.public_text,
      substantive_sha256: fact.substantive_sha256,
      available_after_opportunity: fact.available_after_opportunity,
      provenance_receipt_sha256: fact.provenance_receipt_sha256,
    });
  }).sort((left, right) => left.fact_id.localeCompare(right.fact_id));
  if (publicTextBytes > 20_000) throw new Error("LC4 HACC rotation exceeds its public text budget");
  if (new Set(facts.map((fact) => fact.fact_id)).size !== facts.length) throw new Error("LC4 HACC rotation fact IDs must be unique");
  const body = Object.freeze({
    schema_version: 1 as const,
    packet_type: "hacc_structured_state_rotation" as const,
    run_id: input.run_id,
    from_segment_ordinal: input.from_segment_ordinal,
    to_segment_ordinal: input.to_segment_ordinal,
    available_through_opportunity: input.available_through_opportunity,
    previous_session_rotation_receipt_sha256: input.previous_session_rotation_receipt_sha256,
    flow_state_sha256: input.flow_state_sha256,
    response_plan_chain_head_sha256: input.response_plan_chain_head_sha256,
    facts: Object.freeze(facts),
    substantive_fact_set_sha256: hashFactSet(facts),
  });
  return Object.freeze({ ...body, packet_sha256: sha256Hex(`${HACC_ROTATION_DOMAIN}${canonicalJson(body)}`) });
}

export function assertLc4RotationSubstantiveFactParity(
  native: Lc4StrongNativeContinuityPacket,
  hacc: Lc4HaccRotationStatePacket,
): void {
  const validatedNative = assertStrongNativeContinuityPacket(native);
  const validatedHacc = assertHaccRotationStatePacket(hacc);
  if (
    validatedNative.from_segment_ordinal !== validatedHacc.from_segment_ordinal
    || validatedNative.to_segment_ordinal !== validatedHacc.to_segment_ordinal
    || validatedNative.available_through_opportunity !== validatedHacc.available_through_opportunity
    || validatedNative.substantive_fact_set_sha256 !== validatedHacc.substantive_fact_set_sha256
  ) throw new Error("LC4 native and HACC rotation packets differ in available substantive facts");
}

function assertStrongNativeContinuityPacket(packet: Lc4StrongNativeContinuityPacket): Lc4StrongNativeContinuityPacket {
  const rebuilt = createLc4StrongNativeContinuityPacket({
    run_id: packet.run_id,
    from_segment_ordinal: packet.from_segment_ordinal,
    to_segment_ordinal: packet.to_segment_ordinal,
    available_through_opportunity: packet.available_through_opportunity,
    previous_session_rotation_receipt_sha256: packet.previous_session_rotation_receipt_sha256,
    facts: packet.facts.map((fact) => ({
      fact_id: fact.fact_id,
      source: fact.source,
      public_text: fact.public_text,
      available_after_opportunity: fact.available_after_opportunity,
      provenance_receipt_sha256: fact.provenance_receipt_sha256,
      listener_status: fact.source === "listener_heard_caller" || fact.source === "listener_heard_assistant"
        ? "heard_verified"
        : "not_applicable",
      visibility: "public_non_sensitive",
      oracle_derived: false,
      future_derived: false,
      private_value_included: false,
    })),
  });
  if (canonicalJson(rebuilt) !== canonicalJson(packet)) throw new Error("LC4 native continuity packet integrity failed");
  return rebuilt;
}

function assertHaccRotationStatePacket(packet: Lc4HaccRotationStatePacket): Lc4HaccRotationStatePacket {
  const rebuilt = createLc4HaccRotationStatePacket({
    run_id: packet.run_id,
    from_segment_ordinal: packet.from_segment_ordinal,
    to_segment_ordinal: packet.to_segment_ordinal,
    available_through_opportunity: packet.available_through_opportunity,
    previous_session_rotation_receipt_sha256: packet.previous_session_rotation_receipt_sha256,
    flow_state_sha256: packet.flow_state_sha256,
    response_plan_chain_head_sha256: packet.response_plan_chain_head_sha256,
    facts: packet.facts,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(packet)) throw new Error("LC4 HACC rotation state packet integrity failed");
  return rebuilt;
}

export type Lc4RotationContext =
  | Readonly<{ kind: "strong_native"; packet: Lc4StrongNativeContinuityPacket }>
  | Readonly<{ kind: "hacc_structured_state"; packet: Lc4HaccRotationStatePacket }>;

type ValidatedRotationContext = Readonly<{
  kind: "none" | Lc4RotationContext["kind"];
  packet_sha256: string | null;
  substantive_fact_set_sha256: string | null;
  rendered: string | null;
}>;

export type Lc4SanitizedWireObservation = Readonly<{
  provider: LiveStsProvider;
  direction: "inbound" | "outbound";
  connection_epoch: number;
  sequence: number;
  wire_type: string;
  payload_sha256: string;
  payload_bytes: number;
  projection_sha256: string;
  observation_sha256: string;
  previous_observation_sha256: string | null;
  identity_hashes: RealtimeWireObservation["identities"];
}>;

export type Lc4ProviderExchangeEvidence = Readonly<{
  schema_version: 2;
  adapter_version: typeof LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION;
  run_id: string;
  opportunity_id: string;
  segment_ordinal: 1 | 2 | 3;
  provider: LiveStsProvider;
  model: string;
  caller_pcm_sha256: string;
  caller_pcm_byte_length: number;
  rotation_context_kind: ValidatedRotationContext["kind"];
  rotation_context_sha256: string | null;
  rotation_substantive_fact_set_sha256: string | null;
  response_control_kind: "native_context" | "hacc_response_plan";
  response_plan_sha256: string | null;
  response_plan_body: HaccResponsePlan | null;
  terminal_response_plan_sha256: string;
  terminal_response_control_sha256: string;
  rendered_control_context: string;
  response_plan_delivery_sha256: string;
  requested_runtime_identity: Readonly<{ provider: LiveStsProvider; model: string; voice: string }>;
  effective_runtime_identity: Readonly<{ provider: LiveStsProvider; model: string; voice: string }>;
  output_capture: Lc4CapturedOutput;
  wire_observations: readonly Lc4SanitizedWireObservation[];
  wire_observation_set_sha256: string;
  /**
   * Present only for HACC-LC4-DEV. Compact receipts are content-free; the
   * explicitly separated authority projections retain sanitized model versus
   * effective arguments and provider-visible results for replay. Neither form
   * retains raw provider call/response IDs or credentials.
   */
  dev_gateway_receipt_set: Lc4DevGatewayReceiptSet | null;
  input_audio_delivery: RealtimeAudioDeliveryReceipt & Readonly<{
    profile_sha256: string;
    pcm_sha256: string;
  }>;
  transport_mode: "manual_commit" | "provider_native_server_vad";
  transport_parity_sha256: string;
  tool_frontier_sha256: string;
  server_vad_setting_sha256: string | null;
  server_vad_transport_disclosure_sha256: string | null;
  per_turn_session_update_observation_sha256: string | null;
  per_turn_session_ack_observation_sha256: string | null;
  operation_order: readonly Lc4ProviderExchangeOperation[];
  evidence_sha256: string;
  /** DEV-only phase binding; absent from frozen confirmatory artifacts. */
  playback_kind?: "canonical" | "repair";
  repair_decision_receipt_sha256?: string | null;
  dev_listener_result?: Awaited<ReturnType<Lc4DevelopmentListenerSink["accept"]>> | null;
  replay_projection: JsonValue;
}>;

export type Lc4ProviderExchangeOperation =
  | "response_plan_session_update_sent"
  | "response_plan_session_update_acknowledged"
  | "caller_pcm_delivery_started"
  | "caller_pcm_delivery_completed"
  | "response_plan_prepared"
  | "caller_pcm_committed"
  | "caller_pcm_commit_acknowledged"
  | "server_vad_speech_started"
  | "server_vad_speech_stopped"
  | "caller_pcm_auto_committed"
  | "response_generation_requested"
  | "response_generation_auto_started"
  | "assistant_pcm_captured"
  | "listener_evidence_handed_off";

export type Lc4ListenerEvidenceHandoff = Readonly<{
  accept(input: Readonly<{
    capture: Lc4CapturedOutput;
    response_plan_sha256: string | null;
    wire_observation_set_sha256: string;
  }>): void | Promise<void | Awaited<ReturnType<Lc4DevelopmentListenerSink["accept"]>>>;
}>;

export type Lc4RealtimeClientFactory = (
  provider: LiveStsProvider,
  configuration: TrialSessionConfiguration,
) => NormalizedRealtimeClient | Promise<NormalizedRealtimeClient>;

/**
 * Protocol-neutral subset consumed by the wire bridge. Confirmatory manifest
 * integrity remains enforced by its runner; DEV uses a separately hash-bound
 * manifest and can no longer masquerade as HACC-LC4-v1.
 */
export type Lc4RealtimeEpisodeManifest = Readonly<{
  protocol_id: "HACC-LC4-v1" | "HACC-LC4-DEV-v1";
  run_id: string;
  episode_shape: Readonly<{
    provider: LiveStsProvider;
    arm: "native" | "hacc";
    provider_profile: Lc4ProviderExecutionProfile;
  }>;
  opportunities: readonly Lc4OpportunityBinding[];
}>;

export type Lc4RealtimeSegmentSession = Readonly<{
  exchange(input: Readonly<{
    opportunity_id: string;
    caller_pcm: Uint8Array;
    response_control:
      | Readonly<{ kind: "hacc_response_plan"; plan: HaccResponsePlan }>
      | Readonly<{ kind: "native_context"; instructions: string; instructions_sha256: string }>;
    playback_kind?: "canonical" | "repair";
    repair_binding?: Readonly<{
      decision_receipt_sha256: string;
      repair_pcm_id: string;
      pcm_sha256: string;
      pcm_byte_length: number;
      sample_rate_hz: 16_000 | 24_000;
    }>;
    signal?: AbortSignal;
  }>): Promise<Lc4ProviderExchangeEvidence>;
  finalizeOpportunity?(input: Readonly<{
    opportunity_id: string;
    decision_receipt_sha256: string;
    repair_played: boolean;
  }>): Promise<Readonly<{ opportunity_receipt_sha256: string; finalization_body: JsonValue }>>;
  close(): Promise<Readonly<{
    session_ordinal: number;
    segment_ordinal: 1 | 2 | 3;
    rotation_receipt_sha256: string;
    finalization_body: JsonValue;
  }>>;
}>;

export type Lc4OpenRealtimeSegmentInput = Readonly<{
  manifest: Lc4RealtimeEpisodeManifest;
  segment: Lc4SegmentShape;
  profile: Lc4ProviderExecutionProfile;
  configuration: TrialSessionConfiguration;
  rotation_context: Lc4RotationContext | null;
  listener: Lc4ListenerEvidenceHandoff;
  dev_gateway?: Readonly<{
    episode: Lc4DevLiveEpisodePlan;
    opportunities: readonly Lc4PublicDevOpportunity[];
    executor: Lc4DevGatewayExecutor;
  }>;
}>;

export type Lc4ProviderInputAudioFailureDiagnostic = Readonly<{
  schema_version: 1;
  stage: "caller_audio_delivery";
  code: RealtimeAudioDeliveryError["code"] | "delivery_failed";
  provider: LiveStsProvider;
  opportunity_id_sha256: string;
  expected_pcm_byte_length: number;
  appended_pcm_byte_length: number;
  appended_chunk_count: number;
  response_prepared: false;
  input_committed: false;
  response_requested: false;
}>;

/** Content-free failure surface consumed by the DEV failure-evidence layer. */
export class Lc4ProviderInputAudioDeliveryError extends Error {
  readonly diagnostic: Lc4ProviderInputAudioFailureDiagnostic;

  constructor(diagnostic: Lc4ProviderInputAudioFailureDiagnostic, cause: unknown) {
    super(`LC4 ${diagnostic.provider} caller audio delivery failed: ${diagnostic.code}`, { cause });
    this.name = "Lc4ProviderInputAudioDeliveryError";
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must be a safe opaque identifier`);
  return value;
}

function assertExactProfile(input: Lc4OpenRealtimeSegmentInput): void {
  assertLc4ProviderProfileManifest(LC4_PROVIDER_PROFILE_MANIFEST);
  const frozen = LC4_PROVIDER_PROFILE_MANIFEST.providers[input.profile.provider];
  if (
    input.profile.provider !== input.manifest.episode_shape.provider
    || input.profile.model !== frozen.model
    || input.profile.voice !== frozen.voice
    || input.profile.input_sample_rate_hz !== frozen.input_sample_rate_hz
    || input.profile.output_sample_rate_hz !== frozen.output_sample_rate_hz
    || input.configuration.provider !== input.profile.provider
    || input.configuration.model !== input.profile.model
    || input.configuration.inputAudioFormat.sampleRateHz !== input.profile.input_sample_rate_hz
    || input.configuration.inputAudioFormat.encoding !== "pcm16"
    || input.configuration.inputAudioFormat.channels !== 1
    || input.configuration.audioDeliveryProfile.schemaVersion !== 1
    || input.configuration.audioDeliveryProfile.chunkMs !== 20
    || input.configuration.audioDeliveryProfile.pace !== "realtime"
    || input.configuration.audioDeliveryProfileHash !== trialAudioDeliveryProfileHash(input.configuration.audioDeliveryProfile)
    || input.configuration.providerTools.length !== 1
    || !(input.manifest.protocol_id === "HACC-LC4-DEV-v1"
      ? isLc4DevSemanticGatewayFunction(input.configuration.providerTools[0])
      : isLocalToolProxyFunction(input.configuration.providerTools[0]))
  ) throw new Error("LC4 realtime segment differs from its frozen production provider profile");
}

function validateRotationContext(
  input: Lc4OpenRealtimeSegmentInput,
  previousRotationReceiptSha256: string | null,
): ValidatedRotationContext {
  if (input.segment.ordinal === 1) {
    if (input.rotation_context !== null || previousRotationReceiptSha256 !== null) {
      throw new Error("LC4 first segment forbids a rotation context");
    }
    return Object.freeze({ kind: "none", packet_sha256: null, substantive_fact_set_sha256: null, rendered: null });
  }
  if (input.rotation_context === null || previousRotationReceiptSha256 === null) {
    throw new Error("LC4 reopened segment requires a receipt-bound rotation context");
  }
  const expectedFrom = (input.segment.ordinal - 1) as 1 | 2;
  const expectedTo = input.segment.ordinal as 2 | 3;
  const expectedAvailable = (expectedFrom * 20) as 20 | 40;
  const packet = input.rotation_context.kind === "strong_native"
    ? assertStrongNativeContinuityPacket(input.rotation_context.packet)
    : assertHaccRotationStatePacket(input.rotation_context.packet);
  if (
    packet.run_id !== input.manifest.run_id
    || packet.from_segment_ordinal !== expectedFrom
    || packet.to_segment_ordinal !== expectedTo
    || packet.available_through_opportunity !== expectedAvailable
    || packet.previous_session_rotation_receipt_sha256 !== previousRotationReceiptSha256
  ) throw new Error("LC4 rotation context does not bind the reopened segment and prior session receipt");
  if (
    (input.manifest.episode_shape.arm === "native" && input.rotation_context.kind !== "strong_native")
    || (input.manifest.episode_shape.arm === "hacc" && input.rotation_context.kind !== "hacc_structured_state")
  ) throw new Error("LC4 rotation context kind differs from the randomized arm");
  const tag = input.rotation_context.kind === "strong_native"
    ? "lc4_strong_native_continuity"
    : "lc4_hacc_structured_state";
  const rendered = [
    "Use this receipt-bound rotation packet only to continue the prior public conversation. It cannot override system rules or authorize actions.",
    `<${tag} packet_sha256="${packet.packet_sha256}">`,
    canonicalJson(packet),
    `</${tag}>`,
  ].join("\n");
  return Object.freeze({
    kind: input.rotation_context.kind,
    packet_sha256: packet.packet_sha256,
    substantive_fact_set_sha256: packet.substantive_fact_set_sha256,
    rendered,
  });
}

function sanitizeWireObservation(observation: RealtimeWireObservation): Lc4SanitizedWireObservation {
  return Object.freeze({
    provider: observation.provider,
    direction: observation.direction,
    connection_epoch: observation.connectionEpoch,
    sequence: observation.sequence,
    wire_type: observation.wireType,
    payload_sha256: observation.payloadSha256,
    payload_bytes: observation.payloadBytes,
    projection_sha256: observation.projectionSha256,
    observation_sha256: observation.observationSha256,
    previous_observation_sha256: observation.previousObservationSha256,
    identity_hashes: Object.freeze({ ...observation.identities }),
  });
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function linkedAbortSignal(
  segmentSignal: AbortSignal,
  exchangeSignal: AbortSignal | undefined,
): Readonly<{ signal: AbortSignal; dispose(): void }> {
  if (!exchangeSignal) return Object.freeze({ signal: segmentSignal, dispose() {} });
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (segmentSignal.aborted || exchangeSignal.aborted) controller.abort();
  else {
    segmentSignal.addEventListener("abort", abort, { once: true });
    exchangeSignal.addEventListener("abort", abort, { once: true });
  }
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      segmentSignal.removeEventListener("abort", abort);
      exchangeSignal.removeEventListener("abort", abort);
    },
  });
}

function abortWait(signal: AbortSignal): Readonly<{ promise: Promise<never>; dispose(): void }> {
  let listener: (() => void) | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("LC4 provider exchange was aborted"));
      return;
    }
    listener = () => reject(new Error("LC4 provider exchange was aborted"));
    signal.addEventListener("abort", listener, { once: true });
  });
  return Object.freeze({
    promise,
    dispose() {
      if (listener) signal.removeEventListener("abort", listener);
      listener = null;
    },
  });
}

export class Lc4RealtimeProviderBridge {
  readonly #factory: Lc4RealtimeClientFactory;
  readonly #audioDeliveryRuntime: RealtimeAudioDeliveryRuntime;
  #active = false;
  #sessionOrdinal = 0;
  #previousRotationReceiptSha256: string | null = null;

  constructor(
    factory: Lc4RealtimeClientFactory,
    audioDeliveryRuntime: RealtimeAudioDeliveryRuntime = SYSTEM_REALTIME_AUDIO_DELIVERY_RUNTIME,
  ) {
    this.#factory = factory;
    this.#audioDeliveryRuntime = audioDeliveryRuntime;
  }

  async openSegment(input: Lc4OpenRealtimeSegmentInput): Promise<Lc4RealtimeSegmentSession> {
    if (this.#active) throw new Error("LC4 provider session must close before rotation opens the next segment");
    assertExactProfile(input);
    if (input.manifest.protocol_id === "HACC-LC4-DEV-v1" && !input.dev_gateway) {
      throw new Error("LC4-DEV provider session requires an executable arm-aware gateway bridge");
    }
    if (input.manifest.protocol_id !== "HACC-LC4-DEV-v1" && input.dev_gateway) {
      throw new Error("LC4 confirmatory provider session cannot receive the DEV gateway bridge");
    }
    if (input.dev_gateway && (
      input.dev_gateway.episode.episode_id !== input.manifest.run_id
      || input.dev_gateway.episode.provider !== input.profile.provider
      || input.dev_gateway.episode.arm !== input.manifest.episode_shape.arm
    )) throw new Error("LC4-DEV gateway context differs from the provider manifest");
    if (input.segment.ordinal !== this.#sessionOrdinal + 1) throw new Error("LC4 provider sessions must rotate in segment order");
    const rotationContext = validateRotationContext(input, this.#previousRotationReceiptSha256);
    const effectiveConfiguration = rotationContext.rendered === null
      ? input.configuration
      : Object.freeze({
          ...input.configuration,
          instructions: `${input.configuration.instructions}\n${rotationContext.rendered}`,
        });
    const client = await this.#factory(input.profile.provider, effectiveConfiguration);
    if (client.provider !== input.profile.provider) throw new Error("LC4 realtime client provider identity mismatch");
    const wire: Lc4SanitizedWireObservation[] = [];
    const outputByResponse = new Map<string, Uint8Array[]>();
    const outputFormatByResponse = new Map<string, Readonly<{ encoding: "pcm16"; sampleRateHz: number; channels: 1 }>>();
    const terminalByResponse = new Set<string>();
    const completedByResponse = new Set<string>();
    const waiters = new Map<string, () => void>();
    let currentOpportunity: string | null = null;
    let activeResponseId: string | null = null;
    let rootResponseId: string | null = null;
    let currentOperationOrder: Lc4ProviderExchangeOperation[] | null = null;
    let serverVadPhase: "none" | "started" | "stopped" | "committed" | "responding" = "none";
    let terminalError: Error | null = null;
    let terminalFailureCode: "provider_fatal" | "provider_connection_closed" | "provider_terminal_failed" | "invalid_output_audio" | "server_vad_protocol_failure" | null = null;
    let hostCloseInitiated = false;
    const devGateway = input.dev_gateway
      ? new Lc4DevGatewayTurnCoordinator({
          client,
          executor: input.dev_gateway.executor,
          onFatal: (error) => {
            terminalError = error;
            waiters.get(currentOpportunity ?? "")?.();
          },
        })
      : null;
    const unsubscribeWire = client.onWireObservation?.((observation) => wire.push(sanitizeWireObservation(observation)));
    const unsubscribeEvent = client.onEvent((event: NormalizedRealtimeEvent) => {
      devGateway?.observe(event);
      if (event.type === "input.speech_activity" && client.provider === "xai") {
        if (event.phase === "started" && serverVadPhase === "none") {
          serverVadPhase = "started";
          currentOperationOrder?.push("server_vad_speech_started");
        } else if (event.phase === "stopped" && serverVadPhase === "started") {
          serverVadPhase = "stopped";
          currentOperationOrder?.push("server_vad_speech_stopped");
        } else {
          terminalError = new Error("xAI server-VAD lifecycle event order is invalid");
          terminalFailureCode = "server_vad_protocol_failure";
        }
      }
      if (event.type === "input.audio_committed" && client.provider === "xai") {
        if (serverVadPhase !== "stopped") {
          terminalError = new Error("xAI server-VAD auto-commit is unbound");
          terminalFailureCode = "server_vad_protocol_failure";
        } else {
          serverVadPhase = "committed";
          currentOperationOrder?.push("caller_pcm_auto_committed");
        }
      }
      if (event.type === "response.started") {
        activeResponseId = event.responseId;
        if (client.provider === "xai" && rootResponseId === null) {
          if (serverVadPhase !== "committed"
            || event.causalBinding?.trigger !== "server_vad_speech_stopped") {
            terminalError = new Error("xAI root response is not causally bound to the server-VAD speech stop");
            terminalFailureCode = "server_vad_protocol_failure";
          } else {
            rootResponseId = event.responseId;
            serverVadPhase = "responding";
            currentOperationOrder?.push("response_generation_auto_started");
          }
        }
      }
      if (event.type === "turn.interrupted" && client.provider === "xai") {
        terminalError = new Error("xAI interruption is prohibited by the frozen LC4 transport");
        terminalFailureCode = "server_vad_protocol_failure";
        waiters.get(currentOpportunity ?? "")?.();
      }
      if (event.type === "output.audio") {
        activeResponseId = event.responseId;
        const priorFormat = outputFormatByResponse.get(event.responseId);
        if (
          event.format.encoding !== "pcm16"
          || event.format.sampleRateHz !== input.profile.output_sample_rate_hz
          || event.format.channels !== 1
          || (priorFormat !== undefined && canonicalJson(priorFormat) !== canonicalJson(event.format))
        ) {
          terminalError = new Error("provider output PCM format differs from the frozen LC4 profile");
          terminalFailureCode = "invalid_output_audio";
        } else {
          outputFormatByResponse.set(event.responseId, Object.freeze({ ...event.format }));
        }
        const chunks = outputByResponse.get(event.responseId) ?? [];
        chunks.push(Uint8Array.from(event.audio));
        outputByResponse.set(event.responseId, chunks);
      }
      if (event.type === "response.completed") {
        activeResponseId = event.responseId;
        terminalByResponse.add(event.responseId);
        if (event.status !== "completed") {
          terminalError = new Error(`provider response ended with ${event.status}`);
          terminalFailureCode = "provider_terminal_failed";
        } else {
          completedByResponse.add(event.responseId);
        }
        // A tool-producing response is an intermediate provider turn. The DEV
        // coordinator alone owns its continuation and requests it exactly once
        // after all authoritative results have crossed the wire.
        if (!devGateway || client.provider === "gemini") {
          // Gemini Live keeps one normalized response id across sequential
          // toolCall/toolResponse continuations and emits response.completed
          // only when serverContent.turnComplete seals that entire model turn.
          // OpenAI/xAI instead complete an intermediate tool-bearing response
          // before the gateway requests a distinct continuation response.
          waiters.get(currentOpportunity ?? "")?.();
        } else {
          // Some adapters derive tool.dispatch and response.completed from the
          // same provider frame. Defer one microtask so normalized event order
          // cannot turn the intermediate tool response into a false terminal.
          const responseId = event.responseId;
          queueMicrotask(() => {
            if (!devGateway.ownsToolResponse(responseId)) waiters.get(currentOpportunity ?? "")?.();
          });
        }
      }
      if (event.type === "error" && event.fatal) {
        terminalError = new Error(`provider error: ${event.code ?? "unspecified"}`);
        terminalFailureCode = "provider_fatal";
        waiters.get(currentOpportunity ?? "")?.();
      }
      if (event.type === "connection.closed" && !hostCloseInitiated) {
        // Socket close reasons are provider-controlled plaintext. Preserve only
        // the closed-vocabulary classification and let the realtime client's
        // content-free transport diagnostic retain any finer attribution.
        terminalError ??= new Error("provider realtime connection closed");
        terminalFailureCode ??= "provider_connection_closed";
        waiters.get(currentOpportunity ?? "")?.();
      }
    });
    try {
      await client.connect();
      if (client.state !== "ready") throw new Error("LC4 realtime provider session did not remain ready");
    } catch (error) {
      unsubscribeEvent();
      unsubscribeWire?.();
      client.close(1000, "LC4 segment setup failed");
      throw error;
    }
    this.#active = true;
    const sessionOrdinal = ++this.#sessionOrdinal;
    let closed = false;
    let poisoned = false;
    let opportunityOrdinal = 0;
    let pendingDevOpportunity: Readonly<{
      opportunity_id: string;
      canonical_evidence_sha256: string;
      repair_played: boolean;
    }> | null = null;
    let lastFailedExchange: Readonly<{
      error: unknown;
      opportunity_id: string | null;
      playback_kind: "canonical" | "repair";
      caller_pcm: Uint8Array | null;
      wire_start: number;
      stage: Lc4DevFailureStage;
      operation_order: readonly Lc4ProviderExchangeEvidence["operation_order"][number][];
    }> | null = null;
    const openedWireIndex = wire.length;
    const segmentAbort = new AbortController();
    const poisonSegment = (reason = "LC4 in-flight provider exchange failed") => {
      if (poisoned) return;
      poisoned = true;
      closed = true;
      segmentAbort.abort();
      if (client.state !== "closed") {
        hostCloseInitiated = true;
        client.close(1011, reason);
      }
      unsubscribeEvent();
      unsubscribeWire?.();
      this.#active = false;
    };
    const assertExchangeActive = (signal: AbortSignal) => {
      if (signal.aborted || closed || poisoned || client.state !== "ready") {
        throw new Error("LC4 provider exchange was aborted or its segment is no longer usable");
      }
    };
    const failureFromExchange = (failureInput: Readonly<{
      error: unknown;
      opportunity_id: string | null;
      playback_kind: "canonical" | "repair";
      caller_pcm: Uint8Array | null;
      wire_start: number;
      stage: Lc4DevFailureStage;
      operation_order: readonly Lc4ProviderExchangeEvidence["operation_order"][number][];
    }>) => {
      const opportunityWire = wire.slice(failureInput.wire_start);
      const terminalWire = opportunityWire.at(-1) ?? null;
      const gateway = devGateway?.diagnosticSnapshot() ?? Object.freeze({
        batch_count: 0,
        receipt_count: 0,
        fatal_class: "none" as const,
      });
      const outputChunks = activeResponseId === null
        ? [...outputByResponse.values()].flat()
        : outputByResponse.get(activeResponseId) ?? [];
      const outputPcm = concatenate(outputChunks);
      const responseRequested = failureInput.operation_order.includes("response_generation_requested");
      const responseAutoStarted = failureInput.operation_order.includes("response_generation_auto_started");
      const responseStarted = (responseRequested || responseAutoStarted) && activeResponseId !== null;
      const terminalObserved = responseStarted && terminalByResponse.has(activeResponseId!);
      const responseCompleted = terminalObserved && completedByResponse.has(activeResponseId!) && terminalError === null;
      const deliveryDiagnostic = failureInput.error instanceof Lc4ProviderInputAudioDeliveryError
        ? failureInput.error.diagnostic
        : null;
      const failureOperations: Lc4DevFailureOperation[] = [];
      for (const operation of failureInput.operation_order) {
        if (operation !== "assistant_pcm_captured"
          && operation !== "listener_evidence_handed_off"
          && !failureOperations.includes(operation)) {
          failureOperations.push(operation);
        }
      }
      if (responseStarted) failureOperations.push("response_generation_started");
      if (terminalObserved) failureOperations.push("response_terminal_observed");
      if (outputPcm.byteLength > 0) failureOperations.push("assistant_pcm_captured");
      if (failureInput.operation_order.includes("listener_evidence_handed_off")) {
        failureOperations.push("listener_evidence_handed_off");
      }
      let failureStage = failureInput.stage;
      let failureCode: Lc4DevFailureCode;
      let failureClass: Lc4DevFailureClass;
      if (failureInput.error instanceof Lc4ProviderInputAudioDeliveryError) {
        failureStage = "audio_append";
        failureCode = "audio_delivery_failed";
        failureClass = "audio_delivery";
      } else if (gateway.fatal_class !== "none") {
        failureStage = "gateway_dispatch";
        failureCode = "gateway_fatal";
        failureClass = "gateway";
      } else if (terminalFailureCode !== null) {
        failureCode = terminalFailureCode;
        failureClass = terminalFailureCode === "invalid_output_audio" || terminalFailureCode === "server_vad_protocol_failure"
          ? "adapter_contract"
          : "provider_external";
      } else if (failureInput.stage === "pre_send_contract") {
        failureCode = "invalid_contract";
        failureClass = "adapter_contract";
      } else if (failureInput.stage === "server_vad_control_ack") {
        failureCode = "server_vad_control_ack_failed";
        failureClass = "adapter_contract";
      } else if (failureInput.stage === "response_prepare" || failureInput.stage === "audio_commit") {
        failureCode = "audio_delivery_failed";
        failureClass = "audio_delivery";
      } else if (failureInput.stage === "response_request") {
        failureCode = "response_request_failed";
        failureClass = "provider_external";
      } else if (failureInput.stage === "provider_wait"
        && failureInput.error instanceof Error
        && failureInput.error.message === "LC4 provider response timed out") {
        failureCode = "provider_response_timeout";
        failureClass = "timeout";
      } else if (failureInput.stage === "response_validate") {
        failureCode = outputPcm.byteLength === 0 ? "missing_output_audio" : "missing_terminal_response";
        failureClass = "adapter_contract";
      } else if (failureInput.stage === "listener_handoff") {
        failureCode = "listener_failed";
        failureClass = "listener";
      } else if (failureInput.stage === "exchange_evidence") {
        failureCode = "evidence_assembly_failed";
        failureClass = "evidence_retention";
      } else {
        failureCode = "adapter_failure";
        failureClass = "unknown";
      }
      const callerBytes = failureInput.caller_pcm?.byteLength ?? 0;
      const frameBytes = input.profile.input_sample_rate_hz * input.configuration.audioDeliveryProfile.chunkMs / 1_000 * 2;
      const plannedChunks = callerBytes === 0 ? 0 : Math.ceil(callerBytes / frameBytes);
      const appendedChunks = deliveryDiagnostic?.appended_chunk_count
        ?? (failureInput.operation_order.includes("caller_pcm_delivery_completed") ? plannedChunks : 0);
      const appendedBytes = deliveryDiagnostic?.appended_pcm_byte_length
        ?? (failureInput.operation_order.includes("caller_pcm_delivery_completed") ? callerBytes : 0);
      return createLc4DevFailureEvidence({
        schema_version: 2,
        evidence_version: LC4_DEV_FAILURE_EVIDENCE_VERSION,
        redaction: "strict_allowlist_no_provider_plaintext_credentials_or_raw_ids",
        failure_role: "primary_exchange",
        failure_stage: failureStage,
        failure_code: failureCode,
        failure_class: failureClass,
        episode_id: input.manifest.run_id,
        opportunity_id: failureInput.opportunity_id,
        provider: input.profile.provider,
        model: input.profile.model,
        playback_kind: failureInput.playback_kind,
        operation_order: Object.freeze(failureOperations),
        caller_pcm_sha256: failureInput.caller_pcm === null ? null : sha256Hex(failureInput.caller_pcm),
        caller_pcm_byte_length: callerBytes,
        caller_pcm_chunk_count: plannedChunks,
        caller_pcm_appended_chunk_count: appendedChunks,
        caller_pcm_appended_byte_length: appendedBytes,
        response_generation_requested: responseRequested,
        response_generation_started: responseStarted,
        response_terminal_observed: terminalObserved,
        response_completed: responseCompleted,
        output_pcm_sha256: outputPcm.byteLength === 0 ? null : sha256Hex(outputPcm),
        output_pcm_byte_length: outputPcm.byteLength,
        output_pcm_chunk_count: outputChunks.length,
        wire_observation_count: opportunityWire.length,
        terminal_wire_type: classifyLc4DevTerminalWireType(terminalWire?.wire_type ?? null),
        terminal_wire_type_sha256: terminalWire === null ? null : sha256Hex(terminalWire.wire_type),
        terminal_wire_observation_sha256: terminalWire?.observation_sha256 ?? null,
        gateway_batch_count: gateway.batch_count,
        gateway_fatal_class: gateway.fatal_class,
        secondary_failure_evidence_sha256: null,
      });
    };
    const failureFromClose = (error: unknown) => {
      if (lastFailedExchange === null) {
        const segmentWire = wire.slice(openedWireIndex);
        const terminalWire = segmentWire.at(-1) ?? null;
        const gateway = devGateway?.diagnosticSnapshot() ?? Object.freeze({
          batch_count: 0,
          receipt_count: 0,
          fatal_class: "none" as const,
        });
        return createLc4DevFailureEvidence({
          schema_version: 2,
          evidence_version: LC4_DEV_FAILURE_EVIDENCE_VERSION,
          redaction: "strict_allowlist_no_provider_plaintext_credentials_or_raw_ids",
          failure_role: "cleanup",
          failure_stage: "segment_close",
          failure_code: "segment_close_failed",
          failure_class: "cleanup",
          episode_id: input.manifest.run_id,
          opportunity_id: currentOpportunity,
          provider: input.profile.provider,
          model: input.profile.model,
          playback_kind: null,
          operation_order: Object.freeze([]),
          caller_pcm_sha256: null,
          caller_pcm_byte_length: 0,
          caller_pcm_chunk_count: 0,
          caller_pcm_appended_chunk_count: 0,
          caller_pcm_appended_byte_length: 0,
          response_generation_requested: false,
          response_generation_started: false,
          response_terminal_observed: false,
          response_completed: false,
          output_pcm_sha256: null,
          output_pcm_byte_length: 0,
          output_pcm_chunk_count: 0,
          wire_observation_count: segmentWire.length,
          terminal_wire_type: classifyLc4DevTerminalWireType(terminalWire?.wire_type ?? null),
          terminal_wire_type_sha256: terminalWire === null ? null : sha256Hex(terminalWire.wire_type),
          terminal_wire_observation_sha256: terminalWire?.observation_sha256 ?? null,
          gateway_batch_count: gateway.batch_count,
          gateway_fatal_class: gateway.fatal_class,
          secondary_failure_evidence_sha256: null,
        });
      }
      const primaryProjection = failureFromExchange({ ...lastFailedExchange, error });
      return createLc4DevFailureEvidence({
        ...lc4DevFailureEvidenceBody(primaryProjection),
        failure_role: "cleanup",
        failure_stage: "segment_close",
        failure_code: "segment_close_failed",
        failure_class: "cleanup",
      });
    };

    return Object.freeze({
      exchange: async (exchangeInput) => {
        const diagnosticOpportunityId = SAFE_ID.test(exchangeInput.opportunity_id) ? exchangeInput.opportunity_id : null;
        const diagnosticPlaybackKind = exchangeInput.playback_kind ?? "canonical";
        const diagnosticCallerPcm = exchangeInput.caller_pcm instanceof Uint8Array
          ? Uint8Array.from(exchangeInput.caller_pcm)
          : null;
        const diagnosticWireStart = wire.length;
        const operationOrder: Lc4ProviderExchangeEvidence["operation_order"][number][] = [];
        let diagnosticStage: Lc4DevFailureStage = "pre_send_contract";
        // Response tracking is opportunity-scoped. Reset it before even the
        // pre-send session-state gate so a socket loss between turns cannot
        // make the next failure inherit the prior turn's response ID or PCM.
        activeResponseId = null;
        rootResponseId = null;
        outputByResponse.clear();
        outputFormatByResponse.clear();
        terminalByResponse.clear();
        completedByResponse.clear();
        try {
        if (closed || !this.#active || client.state !== "ready") throw new Error("LC4 realtime segment session is not open");
        if (currentOpportunity !== null) throw new Error("LC4 realtime segment allows only one in-flight opportunity");
        const opportunityId = safeId(exchangeInput.opportunity_id, "LC4 opportunity ID");
        const playbackKind = exchangeInput.playback_kind ?? "canonical";
        if (!(exchangeInput.caller_pcm instanceof Uint8Array)
          || exchangeInput.caller_pcm.byteLength < 2
          || exchangeInput.caller_pcm.byteLength % 2 !== 0) {
          throw new Error("LC4 caller PCM must contain non-empty PCM16 bytes");
        }
        // Snapshot before the first async pacing boundary. The manifest check,
        // provider frames, hashes, and retained evidence must all describe the
        // same immutable bytes even if a caller later mutates its input view.
        const callerPcm = Uint8Array.from(exchangeInput.caller_pcm);
        const binding = input.manifest.opportunities.find((candidate) => candidate.opportunity_id === opportunityId);
        const expectedOrdinal = input.segment.opportunity_start + opportunityOrdinal;
        if (playbackKind === "canonical") {
          if (pendingDevOpportunity !== null
            || !binding
            || binding.segment_ordinal !== input.segment.ordinal
            || binding.ordinal !== expectedOrdinal
            || binding.caller_pcm_byte_length !== callerPcm.byteLength
            || binding.caller_pcm_sha256 !== sha256Hex(callerPcm)
            || exchangeInput.repair_binding !== undefined) {
            throw new Error("LC4 caller PCM or opportunity order differs from the frozen manifest");
          }
        } else if (input.manifest.protocol_id !== "HACC-LC4-DEV-v1"
          || pendingDevOpportunity?.opportunity_id !== opportunityId
          || pendingDevOpportunity.repair_played
          || !exchangeInput.repair_binding
          || !SHA256.test(exchangeInput.repair_binding.decision_receipt_sha256)
          || !SAFE_ID.test(exchangeInput.repair_binding.repair_pcm_id)
          || exchangeInput.repair_binding.pcm_sha256 !== sha256Hex(callerPcm)
          || exchangeInput.repair_binding.pcm_byte_length !== callerPcm.byteLength
          || exchangeInput.repair_binding.sample_rate_hz !== input.profile.input_sample_rate_hz) {
          throw new Error("LC4-DEV repair playback differs from the pending same-opportunity decision");
        }
        let responsePlan: HaccResponsePlan | null = null;
        let renderedControl: string;
        if (exchangeInput.response_control.kind === "hacc_response_plan") {
          if (input.manifest.episode_shape.arm !== "hacc") {
            throw new Error("native LC4 arm cannot receive the HACC response-plan intervention");
          }
          responsePlan = assertHaccResponsePlan(exchangeInput.response_control.plan);
          renderedControl = renderHaccResponsePlan(responsePlan);
        } else {
          if (input.manifest.episode_shape.arm !== "native") {
            throw new Error("HACC LC4 arm requires a state-derived response plan");
          }
          if (!exchangeInput.response_control.instructions.trim()
            || sha256Hex(exchangeInput.response_control.instructions) !== exchangeInput.response_control.instructions_sha256) {
            throw new Error("native LC4 response context hash mismatch");
          }
          renderedControl = exchangeInput.response_control.instructions;
        }
        const wireStart = wire.length;
        currentOpportunity = opportunityId;
        serverVadPhase = "none";
        currentOperationOrder = operationOrder;
        terminalError = null;
        terminalFailureCode = null;
        if (devGateway && input.dev_gateway) {
          const opportunity = input.dev_gateway.opportunities.find((candidate) => candidate.id === opportunityId);
          if (!opportunity) throw new Error("LC4-DEV gateway lacks the exact public opportunity context");
          devGateway.beginOpportunity({ episode: input.dev_gateway.episode, opportunity });
        }
        const exchangeSignal = linkedAbortSignal(segmentAbort.signal, exchangeInput.signal);
        let providerInputAppended = false;
        // The provider-visible gateway schema is a matched-pair invariant.
        // HACC narrows logical authority in the response plan and host gateway,
        // never by changing the provider function schema relative to Native.
        const toolFrontier = input.configuration.providerTools;
        const toolFrontierSha256 = realtimeToolFrontierSha256(toolFrontier);
        const transportParitySha256 = client.provider === "xai"
          ? client.serverVadTransportParitySha256
          : input.profile.provider_profile_sha256;
        if (!transportParitySha256 || !SHA256.test(transportParitySha256)) {
          throw new Error("LC4 provider transport parity hash is unavailable");
        }
        let perTurnSessionUpdateObservationSha256: string | null = null;
        let perTurnSessionAckObservationSha256: string | null = null;
        const completed = new Promise<void>((resolve) => waiters.set(opportunityId, resolve));
        try {
          if (client.provider === "xai") {
            diagnosticStage = "server_vad_control_ack";
            if (typeof client.prepareServerVadTurn !== "function") {
              throw new Error("xAI provider-native server-VAD preparation barrier is unavailable");
            }
            const acknowledgement = await client.prepareServerVadTurn({
              additionalInstructions: renderedControl,
              contextSha256: sha256Hex(renderedControl),
              contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
              tools: toolFrontier,
              toolFrontierSha256,
              transportParitySha256,
            }, 5_000);
            perTurnSessionUpdateObservationSha256 = acknowledgement.outboundObservation?.availability === "observed"
              ? acknowledgement.outboundObservation.observationSha256
              : null;
            perTurnSessionAckObservationSha256 = acknowledgement.inboundObservation?.availability === "observed"
              ? acknowledgement.inboundObservation.observationSha256
              : null;
            if (!perTurnSessionUpdateObservationSha256 || !perTurnSessionAckObservationSha256) {
              throw new Error("xAI server-VAD control acknowledgement lacks wire evidence");
            }
            operationOrder.push("response_plan_session_update_sent", "response_plan_session_update_acknowledged");
          }
          diagnosticStage = "audio_append";
          operationOrder.push("caller_pcm_delivery_started");
          let inputAudioDelivery: RealtimeAudioDeliveryReceipt;
          try {
            inputAudioDelivery = await deliverRealtimePcm16({
              client,
              audio: {
                encoding: "pcm16",
                sampleRateHz: input.profile.input_sample_rate_hz,
                channels: 1,
                data: callerPcm,
              },
              profile: input.configuration.audioDeliveryProfile,
              runtime: this.#audioDeliveryRuntime,
              signal: exchangeSignal.signal,
            });
          } catch (error) {
            const deliveryError = error instanceof RealtimeAudioDeliveryError ? error : null;
            poisonSegment("LC4 caller audio delivery failed");
            throw new Lc4ProviderInputAudioDeliveryError(Object.freeze({
              schema_version: 1 as const,
              stage: "caller_audio_delivery" as const,
              code: deliveryError?.code ?? "delivery_failed",
              provider: input.profile.provider,
              opportunity_id_sha256: sha256Hex(opportunityId),
              expected_pcm_byte_length: callerPcm.byteLength,
              appended_pcm_byte_length: deliveryError?.bytes_appended ?? 0,
              appended_chunk_count: deliveryError?.chunks_appended ?? 0,
              response_prepared: false as const,
              input_committed: false as const,
              response_requested: false as const,
            }), error);
          }
          providerInputAppended = true;
          assertExchangeActive(exchangeSignal.signal);
          operationOrder.push("caller_pcm_delivery_completed");
          if (client.provider !== "xai") {
            diagnosticStage = "response_prepare";
            client.prepareResponse({
              additionalInstructions: renderedControl,
              contextSha256: sha256Hex(renderedControl),
              contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
            });
            operationOrder.push("response_plan_prepared");
            diagnosticStage = "audio_commit";
            client.commitInputAudio();
            operationOrder.push("caller_pcm_committed");
            diagnosticStage = "response_request";
            client.createResponse();
            operationOrder.push("response_generation_requested");
          }
          diagnosticStage = "provider_wait";
          let responseTimer: ReturnType<typeof setTimeout> | null = null;
          const aborted = abortWait(exchangeSignal.signal);
          try {
            await Promise.race([
              completed,
              aborted.promise,
              new Promise<never>((_, reject) => {
                responseTimer = setTimeout(() => reject(new Error("LC4 provider response timed out")), 45_000);
              }),
            ]);
          } finally {
            if (responseTimer) clearTimeout(responseTimer);
            aborted.dispose();
          }
          assertExchangeActive(exchangeSignal.signal);
          if (terminalError) throw terminalError;
          diagnosticStage = "response_validate";
          if (!activeResponseId || !terminalByResponse.has(activeResponseId)) throw new Error("LC4 provider response lacks a terminal identity");
          diagnosticStage = "gateway_dispatch";
          const devGatewayReceiptSet = devGateway
            ? await devGateway.finishOpportunity()
            : null;
          assertExchangeActive(exchangeSignal.signal);
          const terminalGatewayReceipt = devGatewayReceiptSet?.receipts.at(-1) ?? null;
          const initialResponseControlSha256 = exchangeInput.response_control.kind === "hacc_response_plan"
            ? exchangeInput.response_control.plan.plan_sha256
            : exchangeInput.response_control.instructions_sha256;
          const terminalResponsePlanSha256 = terminalGatewayReceipt?.post_transition_response_plan_sha256
            ?? initialResponseControlSha256;
          const terminalResponseControlSha256 = terminalGatewayReceipt?.post_transition_response_control_sha256
            ?? initialResponseControlSha256;
          const chunks = outputByResponse.get(activeResponseId) ?? [];
          const pcm = concatenate(chunks);
          diagnosticStage = "response_validate";
          if (pcm.byteLength === 0) throw new Error("LC4 provider response produced no PCM output");
          operationOrder.push("assistant_pcm_captured");
          const capture = createLc4CapturedOutput({
            runId: input.manifest.run_id,
            opportunityId,
            responseId: `response-${sha256Hex(activeResponseId).slice(0, 32)}`,
            provider: input.profile.provider,
            surface: "server_realtime_pcm",
            sampleRateHz: input.profile.output_sample_rate_hz,
            chunks: chunks.map((chunk, index) => ({ chunkId: `${opportunityId}-chunk-${index + 1}`, pcm: chunk })),
          });
          const opportunityWire = Object.freeze(wire.slice(wireStart));
          const wireObservationSetSha256 = sha256Hex(
            `harshas-amazing-call-center/lc4-wire-observation-set/v1\n${canonicalJson(opportunityWire)}`,
          );
          diagnosticStage = "listener_handoff";
          const listenerResult = await input.listener.accept({
            capture,
            // Native carries a response-control commitment, not a HACC plan.
            // Passing that control hash as a plan made the DEV listener reject
            // every Native turn before ASR could run.
            response_plan_sha256: exchangeInput.response_control.kind === "hacc_response_plan"
              ? terminalResponsePlanSha256
              : null,
            wire_observation_set_sha256: wireObservationSetSha256,
          });
          assertExchangeActive(exchangeSignal.signal);
          operationOrder.push("listener_evidence_handed_off");
          if (input.manifest.protocol_id === "HACC-LC4-DEV-v1" && !listenerResult) {
            throw new Error("LC4-DEV exchange completed without signed listener semantic evidence");
          }
          diagnosticStage = "exchange_evidence";
          const body = Object.freeze({
            schema_version: 2 as const,
            adapter_version: LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION,
            run_id: input.manifest.run_id,
            opportunity_id: opportunityId,
            segment_ordinal: input.segment.ordinal,
            provider: input.profile.provider,
            model: input.profile.model,
            caller_pcm_sha256: sha256Hex(callerPcm),
            caller_pcm_byte_length: callerPcm.byteLength,
            rotation_context_kind: rotationContext.kind,
            rotation_context_sha256: rotationContext.packet_sha256,
            rotation_substantive_fact_set_sha256: rotationContext.substantive_fact_set_sha256,
            response_control_kind: exchangeInput.response_control.kind,
            response_plan_sha256: responsePlan?.plan_sha256 ?? null,
            response_plan_body: responsePlan,
            terminal_response_plan_sha256: terminalResponsePlanSha256,
            terminal_response_control_sha256: terminalResponseControlSha256,
            rendered_control_context: renderedControl,
            response_plan_delivery_sha256: sha256Hex(renderedControl),
            requested_runtime_identity: Object.freeze({
              provider: input.configuration.provider,
              model: input.configuration.model,
              voice: input.profile.voice,
            }),
            effective_runtime_identity: Object.freeze({
              provider: effectiveConfiguration.provider,
              model: effectiveConfiguration.model,
              voice: input.profile.voice,
            }),
            output_capture: capture,
            wire_observations: opportunityWire,
            wire_observation_set_sha256: wireObservationSetSha256,
            dev_gateway_receipt_set: devGatewayReceiptSet,
            input_audio_delivery: Object.freeze({
              ...inputAudioDelivery,
              profile_sha256: input.configuration.audioDeliveryProfileHash,
              pcm_sha256: sha256Hex(callerPcm),
            }),
            transport_mode: client.provider === "xai" ? "provider_native_server_vad" as const : "manual_commit" as const,
            transport_parity_sha256: transportParitySha256,
            tool_frontier_sha256: toolFrontierSha256,
            server_vad_setting_sha256: client.provider === "xai" ? LC4_XAI_SERVER_VAD_SHA256 : null,
            server_vad_transport_disclosure_sha256: client.provider === "xai"
              ? LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256
              : null,
            per_turn_session_update_observation_sha256: perTurnSessionUpdateObservationSha256,
            per_turn_session_ack_observation_sha256: perTurnSessionAckObservationSha256,
            operation_order: Object.freeze(operationOrder) as Lc4ProviderExchangeEvidence["operation_order"],
            ...(input.manifest.protocol_id === "HACC-LC4-DEV-v1" ? {
              playback_kind: playbackKind,
              repair_decision_receipt_sha256: exchangeInput.repair_binding?.decision_receipt_sha256 ?? null,
              dev_listener_result: listenerResult ?? null,
            } : {}),
          });
          const replayProjection = Object.freeze({
            ...body,
            output_capture: { ...capture, chunks: capture.chunks.map((chunk) => chunk.receipt) },
          }) as unknown as JsonValue;
          const evidence = Object.freeze({
            ...body,
            evidence_sha256: sha256Hex(
              `${PROVIDER_EXCHANGE_EVIDENCE_DOMAIN}${canonicalJson(replayProjection)}`,
            ),
            replay_projection: replayProjection,
          });
          assertExchangeActive(exchangeSignal.signal);
          if (input.manifest.protocol_id === "HACC-LC4-DEV-v1") {
            pendingDevOpportunity = playbackKind === "canonical"
              ? Object.freeze({ opportunity_id: opportunityId, canonical_evidence_sha256: evidence.evidence_sha256, repair_played: false })
              : Object.freeze({ ...pendingDevOpportunity!, repair_played: true });
          } else opportunityOrdinal += 1;
          return evidence;
        } catch (error) {
          if (providerInputAppended) poisonSegment();
          throw error;
        } finally {
          exchangeSignal.dispose();
          waiters.delete(opportunityId);
          currentOpportunity = null;
          currentOperationOrder = null;
        }
        } catch (error) {
          if (input.manifest.protocol_id !== "HACC-LC4-DEV-v1" || isLc4DevFailureEvidenceError(error)) throw error;
          lastFailedExchange = Object.freeze({
            error,
            opportunity_id: diagnosticOpportunityId,
            playback_kind: diagnosticPlaybackKind,
            caller_pcm: diagnosticCallerPcm,
            wire_start: diagnosticWireStart,
            stage: diagnosticStage,
            operation_order: Object.freeze([...operationOrder]),
          });
          const failure = failureFromExchange(lastFailedExchange);
          if (failure.failure_code === "provider_connection_closed") {
            poisonSegment("LC4 provider connection closed");
          }
          throw new Lc4DevFailureEvidenceError(failure);
        }
      },
      finalizeOpportunity: input.manifest.protocol_id === "HACC-LC4-DEV-v1" ? async (finalizeInput) => {
        if (closed || poisoned || this.#active === false || client.state !== "ready" || currentOpportunity !== null) {
          throw new Error("LC4-DEV opportunity cannot finalize on a closed, poisoned, or in-flight segment");
        }
        if (!pendingDevOpportunity || pendingDevOpportunity.opportunity_id !== finalizeInput.opportunity_id) {
          throw new Error("LC4-DEV opportunity finalize has no matching canonical exchange");
        }
        if (!SHA256.test(finalizeInput.decision_receipt_sha256)
          || finalizeInput.repair_played !== pendingDevOpportunity.repair_played) {
          throw new Error("LC4-DEV opportunity finalize differs from the repair decision or playback phase");
        }
        const finalizationBody = Object.freeze({
          opportunity_id: finalizeInput.opportunity_id,
          canonical_evidence_sha256: pendingDevOpportunity.canonical_evidence_sha256,
          decision_receipt_sha256: finalizeInput.decision_receipt_sha256,
          repair_played: finalizeInput.repair_played,
        });
        const opportunityReceiptSha256 = sha256Hex(`harshas-amazing-call-center/lc4-dev-opportunity-finalize/v1\n${canonicalJson(finalizationBody)}`);
        opportunityOrdinal += 1;
        pendingDevOpportunity = null;
        return Object.freeze({
          opportunity_receipt_sha256: opportunityReceiptSha256,
          finalization_body: finalizationBody as unknown as JsonValue,
        });
      } : undefined,
      close: async () => {
        try {
        if (closed) throw new Error("LC4 realtime segment session is already closed");
        if (currentOpportunity !== null) {
          // Abort and poison the socket without minting a rotation receipt
          // that could make a partial input or response look resumable.
          poisoned = true;
          closed = true;
          segmentAbort.abort();
          terminalError = new Error("LC4 realtime segment closed during an in-flight opportunity");
          waiters.get(currentOpportunity)?.();
          if (client.state !== "closed") {
            hostCloseInitiated = true;
            client.close(1011, "LC4 segment closed during in-flight opportunity");
          }
          unsubscribeEvent();
          unsubscribeWire?.();
          this.#active = false;
          throw new Error("LC4 realtime segment aborted an in-flight opportunity without a rotation receipt");
        }
        if (client.state !== "ready") {
          // A provider-closed socket cannot yield a controlled session-rotation
          // receipt. Release local authority and surface cleanup evidence.
          closed = true;
          segmentAbort.abort();
          if (client.state !== "closed") {
            hostCloseInitiated = true;
            client.close(1011, "LC4 provider session unavailable before rotation");
          }
          unsubscribeEvent();
          unsubscribeWire?.();
          this.#active = false;
          throw new Error("LC4 realtime segment lost provider readiness before rotation");
        }
        const hadUnfinalizedDevOpportunity = pendingDevOpportunity !== null;
        closed = true;
        segmentAbort.abort();
        hostCloseInitiated = true;
        client.close(1000, "LC4 segment rotation");
        unsubscribeEvent();
        unsubscribeWire?.();
        this.#active = false;
        if (hadUnfinalizedDevOpportunity) {
          // Always release the authenticated provider socket on an aborting
          // path, but never mint a rotation receipt for an unfinalized turn.
          throw new Error("LC4-DEV segment cannot close with an unfinalized canonical opportunity");
        }
        const body = Object.freeze({
          adapter_version: LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION,
          session_ordinal: sessionOrdinal,
          segment_ordinal: input.segment.ordinal,
          opportunity_count: opportunityOrdinal,
          provider: input.profile.provider,
          model: input.profile.model,
          opened_wire_index: openedWireIndex,
          terminal_wire_observation_sha256: wire.at(-1)?.observation_sha256 ?? null,
          previous_rotation_receipt_sha256: this.#previousRotationReceiptSha256,
          rotation_context_kind: rotationContext.kind,
          rotation_context_sha256: rotationContext.packet_sha256,
          rotation_substantive_fact_set_sha256: rotationContext.substantive_fact_set_sha256,
        });
        const receipt = sha256Hex(`harshas-amazing-call-center/lc4-provider-session-rotation/v1\n${canonicalJson(body)}`);
        this.#previousRotationReceiptSha256 = receipt;
        return Object.freeze({
          session_ordinal: sessionOrdinal,
          segment_ordinal: input.segment.ordinal,
          rotation_receipt_sha256: receipt,
          finalization_body: body as unknown as JsonValue,
        });
        } catch (error) {
          if (input.manifest.protocol_id !== "HACC-LC4-DEV-v1" || isLc4DevFailureEvidenceError(error)) throw error;
          throw new Lc4DevFailureEvidenceError(failureFromClose(error));
        }
      },
    });
  }
}

export type Lc4FrozenProductionRealtimeAdapter = Readonly<{
  kind: "production-realtime-frozen";
  openSegment(input: Lc4OpenRealtimeSegmentInput): Promise<Lc4RealtimeSegmentSession>;
}>;

export function createLc4FrozenProductionRealtimeAdapter(input: Readonly<{
  credentials: Readonly<Record<LiveStsProvider, string>>;
}>): Lc4FrozenProductionRealtimeAdapter {
  const bridge = new Lc4RealtimeProviderBridge((provider, configuration) => (
    createProductionRealtimeClient(provider, configuration, input.credentials[provider])
  ));
  return Object.freeze({
    kind: "production-realtime-frozen" as const,
    openSegment: async (segment) => {
      if (LC4_PRODUCTION_PROVIDER_EXECUTION_FROZEN) {
        throw new Error("LC4 production realtime adapter is frozen; provider execution is not authorized");
      }
      return bridge.openSegment(segment);
    },
  });
}

const LC4_DEV_CREDENTIAL_IDENTITY_DOMAIN = "harshas-amazing-call-center/lc4-dev-credential-identity-set/v1\n";
const LC4_DEV_RESPONSE_PLAN_CHAIN_DOMAIN = "harshas-amazing-call-center/lc4-dev-response-plan-chain/v1\n";
const LC4_DEV_CONFIGURATION_DOMAIN = "harshas-amazing-call-center/lc4-dev-session-configuration/v1\n";
const LC4_DEV_OPPORTUNITY_CONTRACT_DOMAIN = "harshas-amazing-call-center/lc4-dev-opportunity-contract/v1\n";

export function lc4DevCredentialIdentitySetSha256(
  credentials: Readonly<Record<LiveStsProvider, string>>,
): string {
  const identities = (["openai", "gemini", "xai"] as const).map((provider) => {
    const secret = credentials[provider];
    if (typeof secret !== "string" || secret.trim().length < 8) throw new Error(`LC4-DEV ${provider} credential is absent or malformed`);
    return Object.freeze({ provider, credential_sha256: sha256Hex(secret) });
  });
  return sha256Hex(`${LC4_DEV_CREDENTIAL_IDENTITY_DOMAIN}${canonicalJson(identities)}`);
}

function devProfile(episode: Lc4DevLiveEpisodePlan): Lc4ProviderExecutionProfile {
  const profile = LC4_PROVIDER_PROFILE_MANIFEST.providers[episode.provider];
  if (episode.model !== profile.model || episode.voice !== profile.voice) {
    throw new Error("LC4-DEV episode differs from the frozen provider profile");
  }
  return Object.freeze({
    provider: episode.provider,
    model: profile.model,
    voice: profile.voice,
    input_sample_rate_hz: profile.input_sample_rate_hz,
    output_sample_rate_hz: profile.output_sample_rate_hz,
    turn_boundary: profile.turn_boundary,
    context_authority: profile.context_delivery.authority,
    provider_profile_sha256: sha256Hex(`hacc-lc4/provider-execution-profile/v2\n${canonicalJson(profile)}`),
  });
}

function devSegment(ordinal: 1 | 2 | 3): Lc4SegmentShape {
  return Object.freeze({
    ordinal,
    act: ordinal === 1 ? "establish" : ordinal === 2 ? "interleave" : "reconcile",
    opportunity_start: (ordinal - 1) * 20 + 1,
    opportunity_end: ordinal * 20,
    opportunity_count: 20 as const,
    provider_session_rotation_required_after: ordinal < 3,
  });
}

function devConfiguration(episode: Lc4DevLiveEpisodePlan, preflightSha256: string): TrialSessionConfiguration {
  const profile = devProfile(episode);
  const conditionId = episode.arm === "native" ? "raw-full" : "host-managed-harness";
  const base = [
    "You are participating in the public HACC-LC4-DEV municipal oral-history voice-agent mechanism test.",
    "Treat all caller details as fictional benchmark data. Speak naturally and follow only the context available in this turn.",
    "Never claim an external action completed without an authoritative tool receipt. Use capability_gateway for every tool request.",
    "This is development mechanism evidence only, never confirmatory efficacy evidence.",
  ].join(" ");
  const delivery = LC4_DEV_AUDIO_DELIVERY_PROFILE;
  const body = Object.freeze({
    provider: episode.provider,
    model: episode.model,
    arm: episode.arm,
    condition_id: conditionId,
    preflight_sha256: preflightSha256,
    base_instructions_sha256: sha256Hex(base),
    input_sample_rate_hz: profile.input_sample_rate_hz,
    delivery,
  });
  return Object.freeze({
    provider: episode.provider,
    model: episode.model,
    conditionId,
    instructions: base,
    initialPrompt: base,
    renderedCapabilitySnapshot: `<lc4_dev_gateway preflight_sha256="${preflightSha256}" />`,
    providerTools: Object.freeze([LC4_DEV_SEMANTIC_GATEWAY_FUNCTION]),
    conditionHash: sha256Hex(`${LC4_DEV_CONFIGURATION_DOMAIN}${canonicalJson(body)}`),
    inputAudioFormat: Object.freeze({ encoding: "pcm16" as const, sampleRateHz: profile.input_sample_rate_hz, channels: 1 as const }),
    audioDeliveryProfile: delivery,
    audioDeliveryProfileHash: trialAudioDeliveryProfileHash(delivery),
  });
}

function devManifest(
  prepare: Lc4DevLivePrepareArtifact,
  episode: Lc4DevLiveEpisodePlan,
): Lc4RealtimeEpisodeManifest {
  const corpus = createLc4PublicDevelopmentCorpus();
  const bindings = prepare.audio_bindings.filter((binding) => binding.provider === episode.provider);
  const opportunities = corpus.opportunities.map((opportunity, index) => {
    const binding = bindings[index];
    if (!binding || binding.opportunity_id !== opportunity.id) throw new Error("LC4-DEV manifest audio bindings drifted");
    return Object.freeze({
      ordinal: index + 1,
      opportunity_id: opportunity.id,
      segment_ordinal: Math.ceil((index + 1) / 20) as 1 | 2 | 3,
      caller_pcm_sha256: binding.pcm_sha256,
      caller_pcm_byte_length: binding.pcm_byte_length,
      opportunity_contract_sha256: sha256Hex(`${LC4_DEV_OPPORTUNITY_CONTRACT_DOMAIN}${canonicalJson(opportunity)}`),
    });
  });
  return Object.freeze({
    protocol_id: "HACC-LC4-DEV-v1" as const,
    run_id: episode.episode_id,
    episode_shape: Object.freeze({
      provider: episode.provider,
      arm: episode.arm,
      provider_profile: devProfile(episode),
    }),
    opportunities: Object.freeze(opportunities),
  });
}

function concatenateDevPcm(chunks: readonly Readonly<{ pcm: Uint8Array }>[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.pcm.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk.pcm, offset);
    offset += chunk.pcm.byteLength;
  }
  return output;
}

type DevEpisodeRuntime = {
  bridge: Lc4RealtimeProviderBridge;
  previous_rotation_receipt_sha256: string | null;
  flow_state_sha256: string;
  response_plan_chain_head_sha256: string;
  next_segment: 1 | 2 | 3;
};

/**
 * The only paid-capable LC4-DEV adapter. It is bound to one expiring preflight,
 * one <=$15 six-episode plan, and credential identities. The frozen
 * confirmatory factory above is deliberately untouched.
 */
export function createLc4DevelopmentRealtimeAdapter(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  preflight: Lc4DevLivePreflightArtifact;
  credentials: Readonly<Record<LiveStsProvider, string>>;
  listener: Lc4DevelopmentListenerSink;
  gateway_executor: Lc4DevGatewayExecutor;
  evidence: Lc4DevReplayEvidenceStore;
  budget_authority: Pick<Lc4DevBudgetLifecycle,
    "assertProviderConstructionAuthorized" | "assertWithinHardDeadline" | "assertOperationWindow" | "beforeEpisodeSocketOpen" | "afterEpisodeSocketOpen">;
  now?: () => Date;
}>): Lc4DevelopmentRealtimeAdapter {
  const now = input.now ?? (() => new Date());
  assertLc4DevLivePrepareArtifact(input.prepare);
  assertLc4DevLivePreflightArtifact(input.preflight, input.prepare, now());
  input.budget_authority.assertProviderConstructionAuthorized();
  if (input.prepare.maximum_total_micro_usd > 15_000_000
    || input.prepare.episodes.length !== 6
    || input.prepare.total_opportunities !== 360) {
    throw new Error("LC4-DEV adapter requires the exact six-episode $15-or-lower plan");
  }
  if (lc4DevCredentialIdentitySetSha256(input.credentials) !== input.preflight.credential_identity_set_sha256) {
    throw new Error("LC4-DEV credentials differ from the hash-bound preflight identities");
  }
  if (input.gateway_executor.kind !== "lc4-dev-arm-aware-gateway-v1"
    || input.gateway_executor.manifest_sha256 !== input.preflight.control_plane_manifest_sha256) {
    throw new Error("LC4-DEV gateway executor differs from the preflight-bound control plane");
  }
  const corpus = createLc4PublicDevelopmentCorpus();
  if (corpus.artifact_sha256 !== input.prepare.corpus_sha256) throw new Error("LC4-DEV adapter corpus drifted from prepare");
  const runtimes = new Map<string, DevEpisodeRuntime>();

  return Object.freeze({
    kind: "lc4-development-realtime-v1" as const,
    factory_id: "lc4-production-provider-adapter/dev-authorized-v1" as const,
    preflight_sha256: input.preflight.preflight_sha256,
    maximum_total_micro_usd: input.prepare.maximum_total_micro_usd,
    openSegment: async ({ episode, segment_ordinal, previous_rotation_receipt_sha256 }) => {
      // Preflight freshness controls one-shot admission. Once consumed, the
      // exact planned rotations continue under the immutable run lease until
      // its provider-independent hard deadline; expiry cannot re-arm a new
      // run, retry, reconnect, or seventh cell.
      input.budget_authority.assertWithinHardDeadline();
      input.budget_authority.assertOperationWindow(20_000);
      const preparedEpisode = input.prepare.episodes.find((candidate) => candidate.episode_id === episode.episode_id);
      if (!preparedEpisode || canonicalJson(preparedEpisode) !== canonicalJson(episode)) {
        throw new Error("LC4-DEV adapter episode differs from its prepared schedule");
      }
      let runtime = runtimes.get(episode.episode_id);
      if (segment_ordinal === 1) {
        if (runtime || previous_rotation_receipt_sha256 !== null) throw new Error("LC4-DEV first segment cannot resume an existing runtime");
        await input.budget_authority.beforeEpisodeSocketOpen(episode);
        runtime = {
          bridge: new Lc4RealtimeProviderBridge((provider, configuration) => (
            createProductionRealtimeClient(
              provider,
              configuration,
              input.credentials[provider],
              provider === "gemini" && episode.arm === "native"
                ? { geminiMaxDynamicControlBytes: LC4_DEV_NATIVE_RESPONSE_CONTROL_MAX_BYTES }
                : {},
            )
          )),
          previous_rotation_receipt_sha256: null,
          flow_state_sha256: sha256Hex(`lc4-dev-flow-genesis\n${input.preflight.preflight_sha256}\n${episode.episode_id}`),
          response_plan_chain_head_sha256: sha256Hex(`lc4-dev-plan-genesis\n${input.preflight.preflight_sha256}\n${episode.episode_id}`),
          next_segment: 1,
        };
        runtimes.set(episode.episode_id, runtime);
      }
      if (!runtime
        || runtime.next_segment !== segment_ordinal
        || runtime.previous_rotation_receipt_sha256 !== previous_rotation_receipt_sha256) {
        throw new Error("LC4-DEV segment rotation does not continue the adapter-owned runtime");
      }
      let rotationContext: Lc4RotationContext | null = null;
      if (segment_ordinal > 1) {
        const boundary = ((segment_ordinal - 1) * 20) as 20 | 40;
        const priorReceipt = runtime.previous_rotation_receipt_sha256!;
        const providerBindings = input.prepare.audio_bindings.filter((binding) => binding.provider === episode.provider);
        const factsById = new Map<string, Lc4NativeContinuityFactInput>();
        for (const opportunity of corpus.opportunities.slice(0, boundary)) {
          const binding = providerBindings[opportunity.index - 1]!;
          for (const fact of opportunity.fact_bindings) {
            const factId = `${fact.fact_key}.v${fact.version}`;
            if (!factsById.has(factId)) {
              factsById.set(factId, Object.freeze({
                fact_id: factId,
                source: "listener_heard_caller" as const,
                public_text: `${fact.fact_key} version ${fact.version}: ${canonicalJson(fact.value)}`,
                available_after_opportunity: opportunity.index,
                provenance_receipt_sha256: binding.pcm_sha256,
                listener_status: "heard_verified" as const,
                visibility: "public_non_sensitive" as const,
                oracle_derived: false as const,
                future_derived: false as const,
                private_value_included: false as const,
              }));
            }
          }
        }
        const native = createLc4StrongNativeContinuityPacket({
          run_id: episode.episode_id,
          from_segment_ordinal: (segment_ordinal - 1) as 1 | 2,
          to_segment_ordinal: segment_ordinal as 2 | 3,
          available_through_opportunity: boundary,
          previous_session_rotation_receipt_sha256: priorReceipt,
          facts: [...factsById.values()],
        });
        const hacc = createLc4HaccRotationStatePacket({
          run_id: episode.episode_id,
          from_segment_ordinal: (segment_ordinal - 1) as 1 | 2,
          to_segment_ordinal: segment_ordinal as 2 | 3,
          available_through_opportunity: boundary,
          previous_session_rotation_receipt_sha256: priorReceipt,
          flow_state_sha256: runtime.flow_state_sha256,
          response_plan_chain_head_sha256: runtime.response_plan_chain_head_sha256,
          facts: native.facts,
        });
        assertLc4RotationSubstantiveFactParity(native, hacc);
        rotationContext = episode.arm === "native"
          ? Object.freeze({ kind: "strong_native" as const, packet: native })
          : Object.freeze({ kind: "hacc_structured_state" as const, packet: hacc });
      }
      const manifest = devManifest(input.prepare, episode);
      const bridgeSession = await runtime.bridge.openSegment({
        manifest,
        segment: devSegment(segment_ordinal),
        profile: manifest.episode_shape.provider_profile,
        configuration: devConfiguration(episode, input.preflight.preflight_sha256),
        rotation_context: rotationContext,
        listener: {
          accept: async (handoff) => {
            const opportunity = corpus.opportunities.find((candidate) => candidate.id === handoff.capture.opportunity_id);
            if (!opportunity) throw new Error("LC4-DEV listener handoff references an unknown opportunity");
            const receipt = await input.listener.accept({ episode, opportunity, ...handoff });
            if (!SHA256.test(receipt.listener_evidence_sha256)) throw new Error("LC4-DEV listener sink returned an invalid evidence hash");
            return receipt;
          },
        },
        dev_gateway: {
          episode,
          opportunities: corpus.opportunities,
          executor: input.gateway_executor,
        },
      });
      if (segment_ordinal === 1) {
        try {
          await input.budget_authority.afterEpisodeSocketOpen(episode);
        } catch (error) {
          // A socket without a durable opened transition must never continue.
          // The reservation remains in ambiguous `opening` state and is later
          // settled at its full pessimistic maximum.
          await bridgeSession.close().catch(() => undefined);
          runtimes.delete(episode.episode_id);
          throw error;
        }
      }
      let closed = false;
      let pendingOpportunity: Readonly<{
        opportunity: Lc4PublicDevOpportunity;
        control_receipt: Lc4DevControlReceipt;
        canonical_exchange_sha256: string;
        repair_played: boolean;
      }> | null = null;
      const exchangePlayback = async (exchangeInput: Readonly<{
        opportunity: Lc4PublicDevOpportunity;
        caller_pcm: Uint8Array;
        control_receipt: Lc4DevControlReceipt;
        playback_kind: "canonical" | "repair";
        repair_binding?: Readonly<{
          decision_receipt_sha256: string;
          repair_pcm_id: string;
          pcm_sha256: string;
          pcm_byte_length: number;
          sample_rate_hz: 16_000 | 24_000;
        }>;
      }>) => {
        input.budget_authority.assertOperationWindow(50_000);
        if (closed) throw new Error("LC4-DEV adapter session is closed");
        if (exchangeInput.playback_kind === "canonical") {
          if (pendingOpportunity !== null) throw new Error("LC4-DEV prior canonical opportunity is not finalized");
          runtime!.flow_state_sha256 = exchangeInput.control_receipt.flow_state_sha256;
          runtime!.response_plan_chain_head_sha256 = sha256Hex(`${LC4_DEV_RESPONSE_PLAN_CHAIN_DOMAIN}${canonicalJson({
            previous: runtime!.response_plan_chain_head_sha256,
            control_receipt_sha256: exchangeInput.control_receipt.control_receipt_sha256,
            response_plan_sha256: exchangeInput.control_receipt.response_control.kind === "hacc_response_plan"
              ? exchangeInput.control_receipt.response_control.plan.plan_sha256
              : exchangeInput.control_receipt.response_control.instructions_sha256,
          })}`);
        } else if (!pendingOpportunity
          || pendingOpportunity.opportunity.id !== exchangeInput.opportunity.id
          || pendingOpportunity.control_receipt.control_receipt_sha256 !== exchangeInput.control_receipt.control_receipt_sha256
          || pendingOpportunity.repair_played) {
          throw new Error("LC4-DEV repair is not attached to the pending canonical opportunity and control receipt");
        }
        let evidence: Lc4ProviderExchangeEvidence;
        try {
          evidence = await bridgeSession.exchange({
            opportunity_id: exchangeInput.opportunity.id,
            caller_pcm: exchangeInput.caller_pcm,
            response_control: exchangeInput.control_receipt.response_control,
            playback_kind: exchangeInput.playback_kind,
            ...(exchangeInput.repair_binding ? { repair_binding: exchangeInput.repair_binding } : {}),
          });
        } catch (error) {
          if (!isLc4DevFailureEvidenceError(error)) throw error;
          const failureEvidence = await input.evidence.retainJson({
            kind: "failure_evidence",
            body: lc4DevFailureEvidenceBody(error.failure) as unknown as JsonValue,
            domain_prefix: LC4_DEV_FAILURE_EVIDENCE_DOMAIN,
            expected_evidence_sha256: error.failure.failure_evidence_sha256,
          });
          await input.evidence.assertResolvable(failureEvidence);
          throw new Lc4DevFailureEvidenceError(error.failure, failureEvidence);
        }
        if (exchangeInput.playback_kind === "canonical") {
          runtime!.response_plan_chain_head_sha256 = sha256Hex(`${LC4_DEV_RESPONSE_PLAN_CHAIN_DOMAIN}${canonicalJson({
            previous: runtime!.response_plan_chain_head_sha256,
            provider_exchange_sha256: evidence.evidence_sha256,
            terminal_response_plan_sha256: evidence.terminal_response_plan_sha256,
            terminal_response_control_sha256: evidence.terminal_response_control_sha256,
          })}`);
        }
        const listenerResult = evidence.dev_listener_result;
        if (!listenerResult || evidence.playback_kind !== exchangeInput.playback_kind) {
          throw new Error("LC4-DEV exchange completed without phase-bound listener evidence");
        }
        const providerExchangeEvidence = await input.evidence.retainJson({
          kind: "provider_exchange",
          body: evidence.replay_projection,
          domain_prefix: PROVIDER_EXCHANGE_EVIDENCE_DOMAIN,
          expected_evidence_sha256: evidence.evidence_sha256,
        });
        await input.evidence.assertResolvable(listenerResult.listener_evidence);
        if (exchangeInput.playback_kind === "canonical") {
          pendingOpportunity = Object.freeze({
            opportunity: exchangeInput.opportunity,
            control_receipt: exchangeInput.control_receipt,
            canonical_exchange_sha256: evidence.evidence_sha256,
            repair_played: false,
          });
        } else pendingOpportunity = Object.freeze({ ...pendingOpportunity!, repair_played: true });
        return Object.freeze({
          playback_kind: exchangeInput.playback_kind,
          opportunity_id: exchangeInput.opportunity.id,
          assistant_pcm: concatenateDevPcm(evidence.output_capture.chunks),
          provider_exchange_sha256: evidence.evidence_sha256,
          listener_evidence_sha256: listenerResult.listener_evidence_sha256,
          repair_projection: listenerResult.repair_projection,
          playback_authority_receipt_sha256: listenerResult.playback_authority_receipt_sha256,
          provider_exchange_projection: evidence.replay_projection,
          provider_exchange_evidence: providerExchangeEvidence,
          listener_evidence: listenerResult.listener_evidence,
        });
      };
      return Object.freeze({
        exchangeCanonical: ({ opportunity, caller_pcm, control_receipt }) => exchangePlayback({ opportunity, caller_pcm, control_receipt, playback_kind: "canonical" }),
        exchangeRepair: ({ opportunity, repair, decision_receipt, control_receipt }) => {
          if (repair.opportunity_id !== opportunity.id
            || repair.episode_id !== episode.episode_id
            || repair.provider !== episode.provider
            || repair.decision_receipt_sha256 !== decision_receipt.decision_receipt_sha256
            || decision_receipt.canonical_opportunity_id !== opportunity.id
            || decision_receipt.canonical_control_receipt_sha256 !== control_receipt.control_receipt_sha256
            || decision_receipt.decision.selection?.repair_pcm_id !== repair.repair_pcm_id
            || decision_receipt.decision.selection?.pcm_sha256 !== repair.pcm_sha256) {
            throw new Error("LC4-DEV repair playback differs from its exact decision receipt");
          }
          return exchangePlayback({
            opportunity,
            caller_pcm: repair.pcm,
            control_receipt,
            playback_kind: "repair",
            repair_binding: {
              decision_receipt_sha256: decision_receipt.decision_receipt_sha256,
              repair_pcm_id: repair.repair_pcm_id,
              pcm_sha256: repair.pcm_sha256,
              pcm_byte_length: repair.pcm_byte_length,
              sample_rate_hz: repair.sample_rate_hz,
            },
          });
        },
        finalizeOpportunity: async ({ opportunity_id, decision_receipt_sha256, repair_played }) => {
          input.budget_authority.assertOperationWindow(10_000);
          if (!pendingOpportunity || pendingOpportunity.opportunity.id !== opportunity_id || pendingOpportunity.repair_played !== repair_played) {
            throw new Error("LC4-DEV opportunity finalize differs from the adapter FSM");
          }
          const receipt = await bridgeSession.finalizeOpportunity!({ opportunity_id, decision_receipt_sha256, repair_played });
          const opportunityFinalization = await input.evidence.retainJson({
            kind: "opportunity_finalization",
            body: receipt.finalization_body,
            domain_prefix: OPPORTUNITY_FINALIZATION_DOMAIN,
            expected_evidence_sha256: receipt.opportunity_receipt_sha256,
          });
          pendingOpportunity = null;
          return Object.freeze({
            opportunity_receipt_sha256: receipt.opportunity_receipt_sha256,
            opportunity_finalization: opportunityFinalization,
          });
        },
        close: async () => {
          if (closed) throw new Error("LC4-DEV adapter session is already closed");
          closed = true;
          let receipt: Awaited<ReturnType<typeof bridgeSession.close>>;
          try {
            receipt = await bridgeSession.close();
          } catch (error) {
            if (!isLc4DevFailureEvidenceError(error)) throw error;
            const failureEvidence = await input.evidence.retainJson({
              kind: "failure_evidence",
              body: lc4DevFailureEvidenceBody(error.failure) as unknown as JsonValue,
              domain_prefix: LC4_DEV_FAILURE_EVIDENCE_DOMAIN,
              expected_evidence_sha256: error.failure.failure_evidence_sha256,
            });
            await input.evidence.assertResolvable(failureEvidence);
            throw new Lc4DevFailureEvidenceError(error.failure, failureEvidence);
          }
          const segmentFinalization = await input.evidence.retainJson({
            kind: "segment_finalization",
            body: receipt.finalization_body,
            domain_prefix: SEGMENT_FINALIZATION_DOMAIN,
            expected_evidence_sha256: receipt.rotation_receipt_sha256,
          });
          runtime!.previous_rotation_receipt_sha256 = receipt.rotation_receipt_sha256;
          if (segment_ordinal < 3) runtime!.next_segment = (segment_ordinal + 1) as 2 | 3;
          else runtimes.delete(episode.episode_id);
          return Object.freeze({
            rotation_receipt_sha256: receipt.rotation_receipt_sha256,
            segment_finalization: segmentFinalization,
          });
        },
      });
    },
  });
}

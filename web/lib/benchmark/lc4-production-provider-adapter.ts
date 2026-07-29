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
  LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE,
  assertLc4XaiTransportProfile,
  assertLc4ProviderProfileManifest,
  lc4XaiTransportProfileForPurpose,
  type Lc4XaiTransportProfile,
  type Lc4XaiTransportPurpose,
} from "./lc4-provider-profiles";
import type {
  Lc4OpportunityBinding,
  Lc4ProviderExecutionProfile,
  Lc4SegmentShape,
} from "./lc4-production-runner-foundation";
import { createLc4ProviderExecutionProfile } from "./lc4-production-runner-foundation";
import {
  assertLc4DevLivePreflightArtifact,
  assertLc4DevLivePrepareArtifact,
  type Lc4DevControlReceipt,
  type Lc4DevLiveEpisodePlan,
  type Lc4DevLivePreflightArtifact,
  type Lc4DevLivePrepareArtifact,
} from "./lc4-development-live-runner";
import type {
  Lc4DevCallerBranchPlaybackBinding,
  Lc4DevelopmentListenerSink,
  Lc4DevelopmentRealtimeAdapter,
} from "./lc4-development-realtime-contract";
import {
  LC4_DEV_BRANCH_OPPORTUNITY_ID,
  assertLc4DevCallerBranchDecision,
  assertLc4DevCallerBranchMatrixArtifact,
  lc4DevBranchedOpportunity,
  type Lc4DevCallerBranchMatrixArtifact,
} from "./lc4-development-caller-branch";
import {
  appendLc4DevNativeGatewayContract,
  LC4_DEV_SEMANTIC_GATEWAY_FUNCTION,
  Lc4DevGatewayTurnCoordinator,
  renderLc4DevHaccResponsePlan,
  type Lc4DevGatewayConversationToolBatch,
  type Lc4DevGatewayExecutor,
  type Lc4DevGatewayReceiptSet,
} from "./lc4-development-gateway-bridge";
import {
  createLc4PublicDevelopmentCorpus,
  type Lc4PublicDevOpportunity,
} from "./lc4-public-development-corpus";
import { LC4_DEV_ARM_COMMON_NATURAL_TASK_CONTEXT } from "./lc4-development-control-plane";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import {
  createProductionRealtimeClient,
  xaiFiniteManualTransportParitySha256,
} from "./production-realtime-provider";
import type { Lc4DevBudgetLifecycle } from "./lc4-development-budget";
import { assertHaccResponsePlan, type HaccResponsePlan } from "./response-plan";
import { trialAudioDeliveryProfileHash, type TrialSessionConfiguration } from "./orchestrator";
import {
  deliverRealtimePcm16,
  packetizeRealtimePcm16,
  RealtimeAudioDeliveryError,
  SYSTEM_REALTIME_AUDIO_DELIVERY_RUNTIME,
  type RealtimeAudioDeliveryReceipt,
  type RealtimeAudioDeliveryRuntime,
} from "../realtime/audio-delivery";
import {
  RealtimeDynamicControlLimitError,
  type NormalizedRealtimeClient,
  type RealtimeConversationHistoryHydrationAcknowledgement,
  type RealtimeConversationHistoryHydratedItemAcknowledgement,
  type RealtimeConversationHistoryJsonValue,
  type RealtimeConversationHistoryTurn,
  type NormalizedRealtimeEvent,
  type RealtimeWireObservation,
  type RealtimeWireObservationAttribution,
} from "../realtime/client/types";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  LOCAL_TOOL_PROXY_FUNCTION,
  PROVIDER_PROVENANCE_META_KEY,
} from "../realtime/client/types";
import {
  realtimeWireIdentitySha256,
  realtimeWireProjectionSha256,
} from "../realtime/client/wire-evidence";
import {
  realtimeToolFrontierSha256,
  XAI_SERVER_VAD_AUDIO_AFTER_STOP_ERROR,
} from "../realtime/client/openai-compatible";
import {
  isAcceptedXaiServerVadSilenceTail,
  LC4_XAI_SERVER_VAD_SHA256,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
  LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256,
} from "./xai-server-vad";
import { LC4_DEV_AUDIO_DELIVERY_PROFILE } from "./lc4-development-audio-contract";
import {
  LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION,
  LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY,
} from "./lc4-production-provider-contract";
import {
  assertLc4XaiManualSpeechActivityTelemetry,
  createLc4XaiManualTurnCausality,
  lc4XaiManualResponseWireIdentitySha256,
  type Lc4XaiManualTurnCausalityEvidence,
} from "./lc4-xai-manual-turn-causality";
import {
  LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER,
  LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
  assertLc4XaiFiniteManualGateDExecutionEvidence,
  lc4XaiFiniteManualGateDExecutionReplaySha256,
  type Lc4XaiFiniteManualGateDAuthorizationArtifact,
  type Lc4XaiFiniteManualGateDExecutionEvidence,
  type Lc4XaiFiniteManualGateDPlanArtifact,
  type Lc4XaiFiniteManualGateDProductionAdapter,
} from "./lc4-xai.manual-qualification";

export {
  assertLc4XaiManualTurnCausality,
  assertLc4XaiManualTurnReplayProjection,
  type Lc4XaiManualTurnCausalityEvidence,
} from "./lc4-xai-manual-turn-causality";

export { LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION }
  from "./lc4-production-provider-contract";
export const LC4_PRODUCTION_PROVIDER_EXECUTION_FROZEN = true as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NATIVE_CONTINUITY_DOMAIN = "harshas-amazing-call-center/lc4-native-conversation-replay/v4\n";
const HACC_ROTATION_DOMAIN = "harshas-amazing-call-center/lc4-hacc-conversation-state-rotation/v4\n";
const ROTATION_CONVERSATION_DOMAIN = "harshas-amazing-call-center/lc4-rotation-conversation-replay/v4\n";
const ROTATION_TOOL_BATCH_DOMAIN =
  "harshas-amazing-call-center/lc4-rotation-tool-batch/v1\n";
const PROVIDER_VISIBLE_HISTORY_DOMAIN =
  "harshas-amazing-call-center/realtime-conversation-history/provider-visible/v2\n";
const PROVIDER_HISTORY_SOURCE_BINDING_DOMAIN =
  "harshas-amazing-call-center/realtime-conversation-history/source-binding/v2\n";
const PROVIDER_HISTORY_ACKNOWLEDGEMENT_DOMAIN =
  "harshas-amazing-call-center/lc4-provider-history-hydration-acknowledgement/v1\n";
const PROVIDER_EXCHANGE_EVIDENCE_DOMAIN = "harshas-amazing-call-center/lc4-provider-exchange-evidence/v5\n";
const SUPPRESSED_UNPLAYED_OUTPUT_DOMAIN =
  "harshas-amazing-call-center/lc4-suppressed-unplayed-output/v1\n";
export const LC4_GEMINI_OUTPUT_ATTRIBUTION_DOMAIN =
  "harshas-amazing-call-center/lc4-gemini-server-content-output-attribution/v1\n";
const OPPORTUNITY_FINALIZATION_DOMAIN = "harshas-amazing-call-center/lc4-dev-opportunity-finalize/v1\n";
const SEGMENT_FINALIZATION_DOMAIN = "harshas-amazing-call-center/lc4-provider-session-rotation/v2\n";
const CONVERSATION_TURN_SOURCES = new Set([
  "caller_tts_source_bound_to_pcm",
  "listener_exact_captured_pcm_asr",
  "provider_native_output_transcript",
  "canonical_gateway_result",
] as const);

export type Lc4AssistantConversationTranscriptSource =
  | "listener_exact_captured_pcm_asr"
  | "provider_native_output_transcript";

type Lc4NativeConversationTurnCommon = Readonly<{
  turn_id: string;
  sequence: number;
  available_after_opportunity: number;
  provenance_receipt_sha256: string;
  provider_conversation_source: true;
  oracle_derived: false;
  future_derived: false;
  semantic_evaluator_derived: false;
}>;

export type Lc4NativeConversationTurnInput =
  | (Lc4NativeConversationTurnCommon & Readonly<{
      speaker: "caller";
      source: "caller_tts_source_bound_to_pcm";
      text: string;
    }>)
  | (Lc4NativeConversationTurnCommon & Readonly<{
      speaker: "assistant";
      source: Lc4AssistantConversationTranscriptSource;
      text: string;
    }>)
  | (Lc4NativeConversationTurnCommon & Readonly<{
      speaker: "tool";
      source: "canonical_gateway_result";
      /** Provider function name exactly as it crossed the model boundary. */
      tool_name: string;
      /** Provider function arguments before host policy/effective-argument projection. */
      tool_arguments: Readonly<Record<string, JsonValue>>;
      /**
       * Canonical gateway-result history. Gemini's transport-only reserved
       * continuation field is not conversation memory and is excluded.
       */
      text: string;
      tool_batch_sha256?: string;
      tool_batch_call_ordinal?: number;
      tool_batch_call_count?: number;
    }>);

export type Lc4RotationConversationTurn =
  | Readonly<{
      turn_id: string;
      sequence: number;
      speaker: "caller";
      source: "caller_tts_source_bound_to_pcm";
      text: string;
      transcript_sha256: string;
      available_after_opportunity: number;
      provenance_receipt_sha256: string;
    }>
  | Readonly<{
      turn_id: string;
      sequence: number;
      speaker: "assistant";
      source: Lc4AssistantConversationTranscriptSource;
      text: string;
      transcript_sha256: string;
      available_after_opportunity: number;
      provenance_receipt_sha256: string;
    }>
  | Readonly<{
      turn_id: string;
      sequence: number;
      speaker: "tool";
      source: "canonical_gateway_result";
      tool_name: string;
      tool_arguments: Readonly<Record<string, JsonValue>>;
      text: string;
      transcript_sha256: string;
      available_after_opportunity: number;
      provenance_receipt_sha256: string;
      tool_batch_sha256?: string;
      tool_batch_call_ordinal?: number;
      tool_batch_call_count?: number;
    }>;

export type Lc4ConversationHistoryHydrationEvidence = Readonly<{
  schema_version: 1;
  provider: LiveStsProvider;
  connection_epoch: number;
  status: RealtimeConversationHistoryHydrationAcknowledgement["status"];
  turn_count: number;
  provider_item_count: number;
  provider_visible_history_sha256: string;
  source_binding_sha256: string;
  acknowledgement_sha256: string;
  /** Content-free per-item call/output and wire acknowledgement lineage. */
  items: RealtimeConversationHistoryHydrationAcknowledgement["items"];
}>;

type Lc4ConversationReplayHashTurn = Readonly<{
  turn_id: string;
  sequence: number;
  speaker: "caller" | "assistant" | "tool";
  source: Lc4NativeConversationTurnInput["source"];
  transcript_sha256: string;
  available_after_opportunity: number;
  tool_name?: string;
  tool_arguments_sha256?: string;
  tool_batch_sha256?: string;
  tool_batch_call_ordinal?: number;
  tool_batch_call_count?: number;
}>;

export type Lc4NativeConversationReplayPacket = Readonly<{
  schema_version: 4;
  packet_type: "native_provider_conversation_replay";
  run_id: string;
  from_segment_ordinal: 1 | 2;
  to_segment_ordinal: 2 | 3;
  available_through_opportunity: 20 | 40;
  previous_session_rotation_receipt_sha256: string;
  conversation_turns: readonly Lc4RotationConversationTurn[];
  conversation_replay_sha256: string;
  packet_sha256: string;
}>;

export type Lc4HaccRotationStatePacket = Readonly<{
  schema_version: 4;
  packet_type: "hacc_provider_conversation_plus_structured_state";
  run_id: string;
  from_segment_ordinal: 1 | 2;
  to_segment_ordinal: 2 | 3;
  available_through_opportunity: 20 | 40;
  previous_session_rotation_receipt_sha256: string;
  flow_state_sha256: string;
  response_plan_chain_head_sha256: string;
  conversation_turns: readonly Lc4RotationConversationTurn[];
  conversation_replay_sha256: string;
  packet_sha256: string;
}>;

function hashConversationReplay(turns: readonly Lc4RotationConversationTurn[]): string {
  return sha256Hex(`${ROTATION_CONVERSATION_DOMAIN}${canonicalJson(turns.map((turn) => ({
    turn_id: turn.turn_id,
    sequence: turn.sequence,
    speaker: turn.speaker,
    source: turn.source,
    transcript_sha256: turn.transcript_sha256,
    available_after_opportunity: turn.available_after_opportunity,
    ...(turn.speaker === "tool"
      ? {
          tool_name: turn.tool_name,
          tool_arguments_sha256: sha256Hex(canonicalJson(turn.tool_arguments)),
          ...(turn.tool_batch_sha256
            ? {
                tool_batch_sha256: turn.tool_batch_sha256,
                tool_batch_call_ordinal: turn.tool_batch_call_ordinal,
                tool_batch_call_count: turn.tool_batch_call_count,
              }
            : {}),
        }
      : {}),
  }) satisfies Lc4ConversationReplayHashTurn))}`);
}

function assertRotationBoundary(from: 1 | 2, to: 2 | 3, available: 20 | 40): void {
  if (to !== from + 1 || available !== from * 20) throw new Error("LC4 rotation packet boundary is invalid");
}

function validateConversationTurns(
  inputTurns: readonly Lc4NativeConversationTurnInput[],
  availableThroughOpportunity: 20 | 40,
): readonly Lc4RotationConversationTurn[] {
  if (inputTurns.length < availableThroughOpportunity * 2) {
    throw new Error("LC4 rotation conversation omits an audible caller or assistant turn");
  }
  if (inputTurns.length > 192) throw new Error("LC4 rotation conversation exceeds 192 provider-conversation turns");
  let textBytes = 0;
  let priorOpportunity = 0;
  const turns = inputTurns.map((turn, index) => {
    safeId(turn.turn_id, "LC4 rotation conversation turn ID");
    if (turn.sequence !== index + 1) throw new Error("LC4 rotation conversation sequence is not exact and contiguous");
    if (!CONVERSATION_TURN_SOURCES.has(turn.source)) throw new Error("LC4 rotation conversation source is inadmissible");
    const sourceMatchesSpeaker = turn.speaker === "caller"
      ? turn.source === "caller_tts_source_bound_to_pcm"
      : turn.speaker === "assistant"
        ? turn.source === "listener_exact_captured_pcm_asr"
          || turn.source === "provider_native_output_transcript"
        : turn.source === "canonical_gateway_result";
    if (!sourceMatchesSpeaker) {
      throw new Error("LC4 rotation conversation speaker differs from its provider-conversation source");
    }
    const turnTextBytes = Buffer.byteLength(turn.text, "utf8");
    if (!turn.text.trim() || turnTextBytes > 4_000) {
      throw new Error("LC4 rotation conversation text is invalid");
    }
    textBytes += turnTextBytes;
    if (!SHA256.test(turn.provenance_receipt_sha256)) throw new Error("LC4 rotation conversation provenance receipt is invalid");
    if (!Number.isSafeInteger(turn.available_after_opportunity)
      || turn.available_after_opportunity < 1
      || turn.available_after_opportunity > availableThroughOpportunity
      || turn.available_after_opportunity < priorOpportunity) {
      throw new Error("LC4 rotation conversation includes a future or out-of-order turn");
    }
    priorOpportunity = turn.available_after_opportunity;
    if (turn.provider_conversation_source !== true
      || turn.oracle_derived !== false
      || turn.future_derived !== false
      || turn.semantic_evaluator_derived !== false) {
      throw new Error("LC4 rotation conversation forbids oracle, semantic-evaluator, future, or non-conversation state");
    }
    const common = {
      turn_id: turn.turn_id,
      sequence: turn.sequence,
      speaker: turn.speaker,
      source: turn.source,
      text: turn.text,
      transcript_sha256: sha256Hex(turn.text),
      available_after_opportunity: turn.available_after_opportunity,
      provenance_receipt_sha256: turn.provenance_receipt_sha256,
    };
    if (turn.speaker === "tool") {
      safeId(turn.tool_name, "LC4 rotation provider tool name");
      const toolArguments = immutableJsonValue(turn.tool_arguments);
      if (toolArguments === null
        || typeof toolArguments !== "object"
        || Array.isArray(toolArguments)) {
        throw new Error("LC4 rotation provider tool arguments are invalid");
      }
      const toolArgumentsBytes = Buffer.byteLength(canonicalJson(toolArguments), "utf8");
      if (toolArgumentsBytes > 64_000) {
        throw new Error("LC4 rotation provider tool arguments exceed 64 KiB");
      }
      textBytes += toolArgumentsBytes;
      return Object.freeze({
        ...common,
        speaker: "tool" as const,
        source: "canonical_gateway_result" as const,
        tool_name: turn.tool_name,
        tool_arguments: toolArguments as Readonly<Record<string, JsonValue>>,
        ...(turn.tool_batch_sha256 !== undefined
          || turn.tool_batch_call_ordinal !== undefined
          || turn.tool_batch_call_count !== undefined
          ? (() => {
              if (!SHA256.test(turn.tool_batch_sha256 ?? "")
                || !Number.isSafeInteger(turn.tool_batch_call_ordinal)
                || !Number.isSafeInteger(turn.tool_batch_call_count)
                || turn.tool_batch_call_ordinal! < 1
                || turn.tool_batch_call_count! < 1
                || turn.tool_batch_call_ordinal! > turn.tool_batch_call_count!) {
                throw new Error("LC4 rotation provider tool batch metadata is invalid");
              }
              return {
                tool_batch_sha256: turn.tool_batch_sha256!,
                tool_batch_call_ordinal: turn.tool_batch_call_ordinal!,
                tool_batch_call_count: turn.tool_batch_call_count!,
              };
            })()
          : {}),
      });
    }
    if ("tool_name" in turn || "tool_arguments" in turn) {
      throw new Error("LC4 non-tool conversation turn includes provider tool metadata");
    }
    return Object.freeze(common) as Lc4RotationConversationTurn;
  });
  if (textBytes > 128_000) throw new Error("LC4 rotation conversation exceeds its text budget");
  if (new Set(turns.map((turn) => turn.turn_id)).size !== turns.length) {
    throw new Error("LC4 rotation conversation turn IDs must be unique");
  }
  for (let opportunity = 1; opportunity <= availableThroughOpportunity; opportunity += 1) {
    const opportunityTurns = turns.filter((turn) => turn.available_after_opportunity === opportunity);
    if (!opportunityTurns.some((turn) => turn.speaker === "caller")
      || !opportunityTurns.some((turn) => turn.speaker === "assistant")) {
      throw new Error(`LC4 rotation conversation omits caller/assistant evidence for opportunity ${opportunity}`);
    }
  }
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    if (turn.speaker !== "tool" || turn.tool_batch_sha256 === undefined) continue;
    if (turn.tool_batch_call_ordinal !== 1) {
      throw new Error("LC4 rotation provider tool batch does not begin at call ordinal one");
    }
    const batch = turns.slice(index, index + turn.tool_batch_call_count!);
    if (batch.length !== turn.tool_batch_call_count
      || batch.some((candidate, callIndex) => (
        candidate.speaker !== "tool"
        || candidate.tool_batch_sha256 !== turn.tool_batch_sha256
        || candidate.tool_batch_call_count !== turn.tool_batch_call_count
        || candidate.tool_batch_call_ordinal !== callIndex + 1
      ))) {
      throw new Error("LC4 rotation provider tool batch is not exact and contiguous");
    }
    index += turn.tool_batch_call_count - 1;
  }
  return Object.freeze(turns);
}

export function createLc4NativeConversationReplayPacket(input: Readonly<{
  run_id: string;
  from_segment_ordinal: 1 | 2;
  to_segment_ordinal: 2 | 3;
  available_through_opportunity: 20 | 40;
  previous_session_rotation_receipt_sha256: string;
  conversation_turns: readonly Lc4NativeConversationTurnInput[];
}>): Lc4NativeConversationReplayPacket {
  safeId(input.run_id, "LC4 native continuity run ID");
  assertRotationBoundary(input.from_segment_ordinal, input.to_segment_ordinal, input.available_through_opportunity);
  if (!SHA256.test(input.previous_session_rotation_receipt_sha256)) throw new Error("LC4 native continuity rotation receipt is invalid");
  const conversationTurns = validateConversationTurns(input.conversation_turns, input.available_through_opportunity);
  const body = Object.freeze({
    schema_version: 4 as const,
    packet_type: "native_provider_conversation_replay" as const,
    run_id: input.run_id,
    from_segment_ordinal: input.from_segment_ordinal,
    to_segment_ordinal: input.to_segment_ordinal,
    available_through_opportunity: input.available_through_opportunity,
    previous_session_rotation_receipt_sha256: input.previous_session_rotation_receipt_sha256,
    conversation_turns: conversationTurns,
    conversation_replay_sha256: hashConversationReplay(conversationTurns),
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
  conversation_turns: readonly Lc4NativeConversationTurnInput[];
}>): Lc4HaccRotationStatePacket {
  safeId(input.run_id, "LC4 HACC rotation run ID");
  assertRotationBoundary(input.from_segment_ordinal, input.to_segment_ordinal, input.available_through_opportunity);
  for (const digest of [input.previous_session_rotation_receipt_sha256, input.flow_state_sha256, input.response_plan_chain_head_sha256]) {
    if (!SHA256.test(digest)) throw new Error("LC4 HACC rotation hash is invalid");
  }
  const conversationTurns = validateConversationTurns(input.conversation_turns, input.available_through_opportunity);
  const body = Object.freeze({
    schema_version: 4 as const,
    packet_type: "hacc_provider_conversation_plus_structured_state" as const,
    run_id: input.run_id,
    from_segment_ordinal: input.from_segment_ordinal,
    to_segment_ordinal: input.to_segment_ordinal,
    available_through_opportunity: input.available_through_opportunity,
    previous_session_rotation_receipt_sha256: input.previous_session_rotation_receipt_sha256,
    flow_state_sha256: input.flow_state_sha256,
    response_plan_chain_head_sha256: input.response_plan_chain_head_sha256,
    conversation_turns: conversationTurns,
    conversation_replay_sha256: hashConversationReplay(conversationTurns),
  });
  return Object.freeze({ ...body, packet_sha256: sha256Hex(`${HACC_ROTATION_DOMAIN}${canonicalJson(body)}`) });
}

export function assertLc4RotationConversationParity(
  native: Lc4NativeConversationReplayPacket,
  hacc: Lc4HaccRotationStatePacket,
): void {
  const validatedNative = assertNativeConversationReplayPacket(native);
  const validatedHacc = assertHaccRotationStatePacket(hacc);
  if (
    validatedNative.from_segment_ordinal !== validatedHacc.from_segment_ordinal
    || validatedNative.to_segment_ordinal !== validatedHacc.to_segment_ordinal
    || validatedNative.available_through_opportunity !== validatedHacc.available_through_opportunity
    || validatedNative.conversation_replay_sha256 !== validatedHacc.conversation_replay_sha256
  ) throw new Error("LC4 Native and HACC rotation wrappers differ in provider conversation replay");
}

function rotationTurnToInput(
  turn: Lc4RotationConversationTurn,
): Lc4NativeConversationTurnInput {
  const common = {
    turn_id: turn.turn_id,
    sequence: turn.sequence,
    text: turn.text,
    available_after_opportunity: turn.available_after_opportunity,
    provenance_receipt_sha256: turn.provenance_receipt_sha256,
    provider_conversation_source: true as const,
    oracle_derived: false as const,
    future_derived: false as const,
    semantic_evaluator_derived: false as const,
  };
  if (turn.speaker === "tool") {
    return Object.freeze({
      ...common,
      speaker: "tool",
      source: "canonical_gateway_result",
      tool_name: turn.tool_name,
      tool_arguments: turn.tool_arguments,
      ...(turn.tool_batch_sha256
        ? {
            tool_batch_sha256: turn.tool_batch_sha256,
            tool_batch_call_ordinal: turn.tool_batch_call_ordinal,
            tool_batch_call_count: turn.tool_batch_call_count,
          }
        : {}),
    });
  }
  if (turn.speaker === "caller") {
    return Object.freeze({
      ...common,
      speaker: "caller",
      source: "caller_tts_source_bound_to_pcm",
    });
  }
  return Object.freeze({
    ...common,
    speaker: "assistant",
    source: turn.source,
  });
}

function assertNativeConversationReplayPacket(packet: Lc4NativeConversationReplayPacket): Lc4NativeConversationReplayPacket {
  const rebuilt = createLc4NativeConversationReplayPacket({
    run_id: packet.run_id,
    from_segment_ordinal: packet.from_segment_ordinal,
    to_segment_ordinal: packet.to_segment_ordinal,
    available_through_opportunity: packet.available_through_opportunity,
    previous_session_rotation_receipt_sha256: packet.previous_session_rotation_receipt_sha256,
    conversation_turns: packet.conversation_turns.map(rotationTurnToInput),
  });
  if (canonicalJson(rebuilt) !== canonicalJson(packet)) throw new Error("LC4 Native conversation replay packet integrity failed");
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
    conversation_turns: packet.conversation_turns.map(rotationTurnToInput),
  });
  if (canonicalJson(rebuilt) !== canonicalJson(packet)) throw new Error("LC4 HACC rotation state packet integrity failed");
  return rebuilt;
}

function rotationConversationForProvider(
  turns: readonly Lc4RotationConversationTurn[],
): readonly RealtimeConversationHistoryTurn[] {
  const history: RealtimeConversationHistoryTurn[] = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    if (turn.speaker !== "tool") {
      history.push(Object.freeze({
        role: turn.speaker === "caller" ? "user" as const : "assistant" as const,
        text: turn.text,
        sourceSha256: turn.provenance_receipt_sha256,
      }));
      continue;
    }
    const batchTurns = turn.tool_batch_sha256
      ? turns.slice(index, index + turn.tool_batch_call_count!)
      : [turn];
    history.push(Object.freeze({
      role: "tool_batch" as const,
      calls: Object.freeze(batchTurns.map((candidate) => {
        if (candidate.speaker !== "tool") {
          throw new Error("LC4 provider history tool batch includes a non-tool turn");
        }
        return Object.freeze({
          toolName: candidate.tool_name,
          toolArguments: candidate.tool_arguments as Readonly<Record<
            string,
            RealtimeConversationHistoryJsonValue
          >>,
          output: candidate.text,
          sourceSha256: candidate.provenance_receipt_sha256,
        });
      })),
    }));
    index += batchTurns.length - 1;
  }
  return Object.freeze(history);
}

function providerVisibleHistoryProjection(
  turns: readonly RealtimeConversationHistoryTurn[],
): JsonValue {
  return turns.map((turn) => {
    if ("text" in turn) {
      return { role: turn.role, text: turn.text };
    }
    const calls = turn.role === "tool" ? [turn] : turn.calls;
    return {
      role: "tool_batch",
      calls: calls.map((call) => ({
        toolName: call.toolName,
        toolArguments: call.toolArguments as JsonValue,
        output: call.output,
      })),
    };
  }) as unknown as JsonValue;
}

function providerVisibleHistorySha256(
  turns: readonly RealtimeConversationHistoryTurn[],
): string {
  return sha256Hex(
    `${PROVIDER_VISIBLE_HISTORY_DOMAIN}${canonicalJson(providerVisibleHistoryProjection(turns))}`,
  );
}

function providerHistorySourceBindingSha256(
  turns: readonly RealtimeConversationHistoryTurn[],
  historySha256: string,
): string {
  return sha256Hex(`${PROVIDER_HISTORY_SOURCE_BINDING_DOMAIN}${canonicalJson({
    historySha256,
    sources: turns.map((turn, index) => {
      if ("text" in turn) {
        return {
          ordinal: index + 1,
          sourceSha256: turn.sourceSha256,
        };
      }
      const calls = turn.role === "tool" ? [turn] : turn.calls;
      return {
        ordinal: index + 1,
        role: "tool_batch",
        calls: calls.map((call, callIndex) => ({
          callOrdinal: callIndex + 1,
          sourceSha256: call.sourceSha256,
        })),
      };
    }),
  })}`);
}

function validateConversationHistoryHydrationAcknowledgement(input: Readonly<{
  receipt: RealtimeConversationHistoryHydrationAcknowledgement;
  provider: LiveStsProvider;
  turns: readonly RealtimeConversationHistoryTurn[];
  expected_history_sha256: string;
  wire_observations: readonly Lc4SanitizedWireObservation[];
}>): Lc4ConversationHistoryHydrationEvidence {
  // Snapshot once so a hostile/mutable client cannot change nested item or
  // attribution fields between validation, hashing, and retained evidence.
  const receipt = JSON.parse(
    canonicalJson(input.receipt as unknown as JsonValue),
  ) as RealtimeConversationHistoryHydrationAcknowledgement;
  const expectedProviderItemCount = input.turns.reduce(
    (count, turn) => {
      if ("text" in turn) return count + 1;
      return count + (turn.role === "tool" ? 2 : turn.calls.length * 2);
    },
    0,
  );
  const expectedSourceBinding = providerHistorySourceBindingSha256(
    input.turns,
    input.expected_history_sha256,
  );
  const expectedStatus = input.provider === "gemini"
    ? "sent_unacknowledged_by_provider_protocol"
    : receipt.items.some((item) => item.providerContentOmission !== undefined)
      ? "identity_acknowledged_content_unverifiable"
      : "acknowledged";
  if (receipt.schemaVersion !== 1
    || receipt.provider !== input.provider
    || !Number.isSafeInteger(receipt.connectionEpoch)
    || receipt.connectionEpoch < 1
    || receipt.status !== expectedStatus
    || receipt.turnCount !== input.turns.length
    || receipt.providerItemCount !== expectedProviderItemCount
    || receipt.historySha256 !== input.expected_history_sha256
    || receipt.sourceBindingSha256 !== expectedSourceBinding
    || receipt.items.length !== expectedProviderItemCount) {
    throw new Error("LC4 provider conversation history hydration acknowledgement is invalid");
  }
  let providerItemOrdinal = 0;
  let priorObservedSequence = 0;
  let geminiSharedOutboundObservationSha256: string | null = null;
  const expectedToolCallCount = input.turns.reduce((count, turn) => {
    if ("text" in turn) return count;
    return count + (turn.role === "tool" ? 1 : turn.calls.length);
  }, 0);
  const expectedGeminiContentTurnCount = input.turns.reduce(
    (count, turn) => count + ("text" in turn ? 1 : 2),
    0,
  );
  const assertGeminiHistoryProjection = (observation: Lc4SanitizedWireObservation) => {
    const projection = observation.history_hydration_projection;
    if (projection === null
      || typeof projection !== "object"
      || Array.isArray(projection)) {
      throw new Error("LC4 Gemini history hydration projection is unavailable");
    }
    const value = projection as Readonly<Record<string, JsonValue>>;
    if (value.protocol !== "initial_history_in_client_content"
      || value.entryCount !== input.turns.length
      || value.providerContentTurnCount !== expectedGeminiContentTurnCount
      || value.functionCallCount !== expectedToolCallCount
      || value.functionResponseCount !== expectedToolCallCount
      || value.turnComplete !== true
      || value.generationTriggered !== false
      || value.providerAcknowledgement !== "not_defined_by_protocol"
      || value.providerVisibleHistorySha256 !== input.expected_history_sha256
      || typeof value.geminiContentSha256 !== "string"
      || !SHA256.test(value.geminiContentSha256)) {
      throw new Error("LC4 Gemini history hydration projection differs from the exact batch");
    }
  };
  const assertItemHistoryProjection = (
    observation: Lc4SanitizedWireObservation,
    expected: Readonly<{
      kind: RealtimeConversationHistoryHydratedItemAcknowledgement["kind"];
      contentSha256: string;
      contentBytes: number;
      nameSha256?: string;
      nameBytes?: number;
    }>,
    providerContentOmission?: RealtimeConversationHistoryHydratedItemAcknowledgement[
      "providerContentOmission"
    ],
  ) => {
    const projection = observation.history_hydration_projection;
    if (projection === null
      || typeof projection !== "object"
      || Array.isArray(projection)) {
      throw new Error("LC4 provider history item projection is unavailable");
    }
    const value = projection as Readonly<Record<string, JsonValue>>;
    const actualContentSha256 = expected.kind === "synthetic_tool_call"
      ? value.argumentsSha256
      : expected.kind === "synthetic_tool_output"
        ? value.outputSha256
        : value.contentSha256;
    if (value.kind !== expected.kind) {
      throw new Error("LC4 provider history item projection differs from the exact batch");
    }
    if (expected.kind === "synthetic_tool_call") {
      if (value.nameSha256 !== expected.nameSha256
        || value.namePresent !== true
        || value.nameBytes !== expected.nameBytes) {
        throw new Error("LC4 provider history tool name projection differs");
      }
    }
    if (providerContentOmission === undefined) {
      if (actualContentSha256 !== expected.contentSha256) {
        throw new Error("LC4 provider history item projection differs from the exact batch");
      }
      if (expected.kind === "synthetic_tool_call"
        && (value.argumentsBytes !== expected.contentBytes
          || value.argumentsPresent !== true
          || value.argumentsJsonValid !== true)) {
        throw new Error("LC4 provider exact history tool arguments projection is invalid");
      }
      if (expected.kind === "synthetic_tool_output"
        && (value.outputBytes !== expected.contentBytes || value.outputPresent !== true)) {
        throw new Error("LC4 provider exact history tool output projection is invalid");
      }
      if ((expected.kind === "user_message" || expected.kind === "assistant_message")
        && value.contentBytes !== expected.contentBytes) {
        throw new Error("LC4 provider exact history message projection is invalid");
      }
      return;
    }
    const emptySha256 = sha256Hex("");
    if (actualContentSha256 !== emptySha256) {
      throw new Error("LC4 provider history item omission projection is not empty");
    }
    if (providerContentOmission.field !== "arguments"
      || providerContentOmission.observedShape !== "empty_string"
      || expected.kind !== "synthetic_tool_call"
      || value.argumentsBytes !== 0
      || value.argumentsPresent !== true
      || value.argumentsJsonValid !== false) {
      throw new Error("LC4 provider history tool arguments omission is invalid");
    }
  };
  const requireObservedAttribution = (
    attribution: RealtimeWireObservationAttribution | undefined,
    direction: "inbound" | "outbound",
    allowSharedGeminiOutbound: boolean,
  ): Lc4SanitizedWireObservation => {
    if (attribution?.availability !== "observed") {
      throw new Error("LC4 provider conversation history hydration lacks observed wire lineage");
    }
    const matches = input.wire_observations.filter((observation) => (
      observation.observation_sha256 === attribution.observationSha256
    ));
    if (matches.length !== 1) {
      throw new Error("LC4 provider conversation history hydration wire lineage is not unique");
    }
    const observation = matches[0]!;
    if (observation.provider !== input.provider
      || observation.direction !== direction
      || attribution.connectionEpoch !== receipt.connectionEpoch
      || observation.connection_epoch !== attribution.connectionEpoch
      || observation.sequence !== attribution.sequence
      || observation.payload_sha256 !== attribution.payloadSha256
      || observation.projection_sha256 !== attribution.projectionSha256) {
      throw new Error("LC4 provider conversation history hydration wire lineage differs");
    }
    const expectedWireType = input.provider === "gemini"
      ? direction === "outbound" && observation.wire_type === "clientContent"
      : direction === "outbound"
        ? observation.wire_type === "conversation.item.create"
        : observation.wire_type === "conversation.item.created"
          || observation.wire_type === "conversation.item.added";
    if (!expectedWireType) {
      throw new Error("LC4 provider conversation history hydration wire type is invalid");
    }
    if (allowSharedGeminiOutbound) {
      geminiSharedOutboundObservationSha256 ??= observation.observation_sha256;
      if (observation.observation_sha256 !== geminiSharedOutboundObservationSha256) {
        throw new Error("LC4 Gemini history hydration spans more than one outbound history frame");
      }
      if (priorObservedSequence === 0) priorObservedSequence = observation.sequence;
    } else {
      if (observation.sequence <= priorObservedSequence) {
        throw new Error("LC4 provider conversation history hydration wire order is not monotonic");
      }
      priorObservedSequence = observation.sequence;
    }
    return observation;
  };
  for (const [turnIndex, turn] of input.turns.entries()) {
    const expectedItems = "text" in turn
      ? [{
          kind: turn.role === "user" ? "user_message" as const : "assistant_message" as const,
          sourceSha256: turn.sourceSha256,
          toolCallOrdinal: null,
          contentSha256: sha256Hex(turn.text),
          contentBytes: Buffer.byteLength(turn.text, "utf8"),
        }]
      : (() => {
          const calls = turn.role === "tool" ? [turn] : turn.calls;
          return [
            ...calls.map((call, callIndex) => ({
              kind: "synthetic_tool_call" as const,
              sourceSha256: call.sourceSha256,
              toolCallOrdinal: callIndex,
              contentSha256: sha256Hex(canonicalJson(call.toolArguments)),
              contentBytes: Buffer.byteLength(canonicalJson(call.toolArguments), "utf8"),
              nameSha256: sha256Hex(call.toolName),
              nameBytes: Buffer.byteLength(call.toolName, "utf8"),
            })),
            ...calls.map((call, callIndex) => ({
              kind: "synthetic_tool_output" as const,
              sourceSha256: call.sourceSha256,
              toolCallOrdinal: callIndex,
              contentSha256: sha256Hex(call.output),
              contentBytes: Buffer.byteLength(call.output, "utf8"),
              nameSha256: undefined,
              nameBytes: undefined,
            })),
          ];
        })();
    const syntheticCallIds = new Map<number, string>();
    for (const expected of expectedItems) {
      providerItemOrdinal += 1;
      const item = receipt.items[providerItemOrdinal - 1];
      if (!item
        || item.historyTurnOrdinal !== turnIndex + 1
        || item.providerItemOrdinal !== providerItemOrdinal
        || item.kind !== expected.kind
        || item.sourceSha256 !== expected.sourceSha256) {
        throw new Error("LC4 provider conversation history hydration item order is invalid");
      }
      if (expected.toolCallOrdinal !== null) {
        if (!item.syntheticCallIdSha256 || !SHA256.test(item.syntheticCallIdSha256)) {
          throw new Error("LC4 provider conversation history tool pair lacks a synthetic call binding");
        }
        const prior = syntheticCallIds.get(expected.toolCallOrdinal);
        if (prior !== undefined && item.syntheticCallIdSha256 !== prior) {
          throw new Error("LC4 provider conversation history tool pair binding differs");
        }
        syntheticCallIds.set(expected.toolCallOrdinal, item.syntheticCallIdSha256);
      } else if (item.syntheticCallIdSha256 !== undefined) {
        throw new Error("LC4 provider conversation message has a synthetic tool-call binding");
      }
      const outboundObservation = requireObservedAttribution(
        item.outboundObservation,
        "outbound",
        input.provider === "gemini",
      );
      if (input.provider === "gemini") {
        if (item.providerContentOmission !== undefined) {
          throw new Error("LC4 Gemini history hydration fabricated provider content acknowledgement");
        }
        assertGeminiHistoryProjection(outboundObservation);
        if (item.inboundObservation !== undefined) {
          throw new Error("LC4 Gemini history hydration fabricated an item acknowledgement");
        }
      } else {
        const inboundObservation = requireObservedAttribution(
          item.inboundObservation,
          "inbound",
          false,
        );
        assertItemHistoryProjection(outboundObservation, expected);
        const omission = item.providerContentOmission;
        if (omission !== undefined) {
          const expectedField = expected.kind === "synthetic_tool_call"
            ? "arguments"
            : expected.kind === "synthetic_tool_output"
              ? "output"
              : null;
          if (input.provider !== "xai"
            || inboundObservation.wire_type !== "conversation.item.added"
            || expectedField !== "arguments"
            || omission.field !== "arguments"
            || omission.observedShape !== "empty_string"
            || Object.keys(omission).length !== 2) {
            throw new Error("LC4 provider history content omission classification is invalid");
          }
        }
        if (inboundObservation.connection_epoch !== outboundObservation.connection_epoch
          || inboundObservation.sequence <= outboundObservation.sequence) {
          throw new Error("LC4 provider conversation history item acknowledgement is not causally ordered");
        }
        if (!outboundObservation.identity_hashes.itemIdSha256
          || inboundObservation.identity_hashes.itemIdSha256
            !== outboundObservation.identity_hashes.itemIdSha256) {
          throw new Error("LC4 provider conversation history item identity differs");
        }
        if (expected.toolCallOrdinal !== null) {
          if (outboundObservation.identity_hashes.callIdSha256
              !== item.syntheticCallIdSha256
            || inboundObservation.identity_hashes.callIdSha256
              !== item.syntheticCallIdSha256) {
            throw new Error("LC4 provider conversation history tool-call identity differs");
          }
        }
        assertItemHistoryProjection(inboundObservation, expected, omission);
      }
    }
  }
  const acknowledgementSha256 = sha256Hex(
    `${PROVIDER_HISTORY_ACKNOWLEDGEMENT_DOMAIN}${canonicalJson(receipt as unknown as JsonValue)}`,
  );
  return Object.freeze({
    schema_version: 1,
    provider: input.provider,
    connection_epoch: receipt.connectionEpoch,
    status: receipt.status,
    turn_count: receipt.turnCount,
    provider_item_count: receipt.providerItemCount,
    provider_visible_history_sha256: receipt.historySha256,
    source_binding_sha256: receipt.sourceBindingSha256,
    acknowledgement_sha256: acknowledgementSha256,
    items: Object.freeze(receipt.items.map((item) => Object.freeze({
      ...item,
      ...(item.outboundObservation
        ? { outboundObservation: Object.freeze({ ...item.outboundObservation }) }
        : {}),
      ...(item.inboundObservation
        ? { inboundObservation: Object.freeze({ ...item.inboundObservation }) }
        : {}),
    }))),
  });
}

export type Lc4RotationContext =
  | Readonly<{ kind: "native_conversation_replay"; packet: Lc4NativeConversationReplayPacket }>
  | Readonly<{ kind: "hacc_structured_state"; packet: Lc4HaccRotationStatePacket }>;

type ValidatedRotationContext = Readonly<{
  kind: "none" | Lc4RotationContext["kind"];
  packet_sha256: string | null;
  conversation_replay_sha256: string | null;
  provider_visible_history_sha256: string | null;
  conversation_history: readonly RealtimeConversationHistoryTurn[];
  control_state_suffix: string | null;
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
  /** Content-free provider-history projection preimage, when applicable. */
  history_hydration_projection?: JsonValue;
}>;

export type Lc4GeminiOutputAudioChunkAttribution = Readonly<{
  output_chunk_index: number;
  frame_chunk_index: number;
  pcm_sha256: string;
  byte_length: number;
  mime_type: "audio/pcm;rate=24000";
  format: Readonly<{
    encoding: "pcm16";
    sample_rate_hz: 24_000;
    channels: 1;
  }>;
}>;

export type Lc4GeminiServerContentFrameAttribution = Readonly<{
  server_content_index: number;
  interval_index: number;
  wire_observation: Readonly<{
    connection_epoch: number;
    sequence: number;
    observation_sha256: string;
    payload_sha256: string;
    payload_byte_length: number;
    projection_sha256: string;
  }>;
  /**
   * Complete privacy-safe projection emitted by the Gemini wire observer.
   * It contains hashes and counters, never transcript text or encoded PCM.
   * Retaining this preimage is what lets replay independently recompute the
   * exact wire projection hash instead of trusting a bare digest.
   */
  redacted_projection: JsonValue;
  output_audio_chunks: readonly Lc4GeminiOutputAudioChunkAttribution[];
  terminal_status: "completed" | "failed" | "interrupted" | null;
}>;

export type Lc4GeminiIntervalFrameAttribution = Readonly<{
  interval_index: number;
  direction: "inbound" | "outbound";
  wire_type: string;
  wire_observation: Lc4GeminiServerContentFrameAttribution["wire_observation"];
  redacted_projection: JsonValue;
}>;

/**
 * Future Gemini evidence contract. Historical provider-exchange v2 artifacts
 * do not carry this object and remain explicitly completeness-unverified.
 */
export type Lc4GeminiOutputAttribution = Readonly<{
  schema_version: 1;
  contract: "gemini_server_content_output_audio_attribution";
  completeness: "verified_activity_end_to_terminal";
  observation_scope: "client_observed_wire_frames";
  activity_end: Readonly<{
    connection_epoch: number;
    sequence: number;
    observation_sha256: string;
  }>;
  terminal: Readonly<{
    connection_epoch: number;
    sequence: number;
    observation_sha256: string;
    status: "completed";
  }>;
  interval_observation_sha256s: readonly string[];
  interval_frames: readonly Lc4GeminiIntervalFrameAttribution[];
  server_content_frames: readonly Lc4GeminiServerContentFrameAttribution[];
  output_audio_chunk_count: number;
  output_audio_byte_length: number;
  output_audio_pcm_sha256: string;
  attribution_sha256: string;
}>;

export type Lc4SuppressedUnplayedOutputEvidence = Readonly<{
  schema_version: 1;
  policy: "exclude_everything_before_the_final_tool_batch_from_caller_heard_history";
  tool_dispatch_count: number;
  response_count: number;
  audio_chunk_count: number;
  audio_byte_length: number;
  audio_pcm_sha256: string | null;
  transcript_count: number;
  transcript_hash_set_sha256: string | null;
  caller_heard_audio_chunk_count: number;
  caller_heard_audio_byte_length: number;
  caller_heard_audio_pcm_sha256: string;
  evidence_sha256: string;
}>;

export type Lc4ProviderExchangeEvidence = Readonly<{
  schema_version: 4;
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
  rotation_conversation_replay_sha256: string | null;
  provider_output_transcript_sha256: string | null;
  assistant_conversation_transcript_sha256: string | null;
  assistant_conversation_transcript_source: Lc4AssistantConversationTranscriptSource | null;
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
  /**
   * Content-free proof that intermediate model output was generated but never
   * delivered to the caller, evaluated, or admitted into reconnect history.
   */
  suppressed_unplayed_output: Lc4SuppressedUnplayedOutputEvidence;
  /**
   * `null` on non-Gemini exchanges. Historical Gemini evidence may omit this
   * field entirely; only this versioned contract can upgrade output-wire
   * completeness from unverified to verified.
   */
  gemini_output_attribution: Lc4GeminiOutputAttribution | null;
  wire_observations: readonly Lc4SanitizedWireObservation[];
  wire_observation_set_sha256: string;
  /**
   * Present only for HACC-LC4-DEV. Compact receipts are content-free; the
   * explicitly separated authority projections retain sanitized model versus
   * effective arguments and provider-visible results for replay. Neither form
   * retains raw provider call/response IDs or credentials.
   */
  dev_gateway_receipt_set: Lc4DevGatewayReceiptSet | null;
  /**
   * DEV-only in-memory canonical gateway replay. This preserves provider batch
   * boundaries but is intentionally omitted from retained public evidence.
   */
  dev_gateway_conversation_tool_batches?: readonly Lc4DevGatewayConversationToolBatch[];
  input_audio_delivery: RealtimeAudioDeliveryReceipt & Readonly<{
    profile_sha256: string;
    pcm_sha256: string;
  }>;
  transport_mode: "manual_commit" | "provider_native_server_vad";
  transport_purpose: Lc4XaiTransportPurpose | null;
  transport_profile_sha256: string;
  transport_parity_sha256: string;
  tool_frontier_sha256: string;
  server_vad_setting_sha256: string | null;
  server_vad_transport_disclosure_sha256: string | null;
  server_vad_transport_suffix: Lc4XaiServerVadTransportSuffixEvidence | null;
  per_turn_session_update_observation_sha256: string | null;
  per_turn_session_ack_observation_sha256: string | null;
  xai_manual_turn_causality: Lc4XaiManualTurnCausalityEvidence | null;
  operation_order: readonly Lc4ProviderExchangeOperation[];
  evidence_sha256: string;
  /** DEV-only phase binding; absent from frozen confirmatory artifacts. */
  playback_kind?: "canonical" | "repair";
  repair_decision_receipt_sha256?: string | null;
  dev_listener_result?: Awaited<ReturnType<Lc4DevelopmentListenerSink["accept"]>> | null;
  /**
   * DEV-only in-memory value used to construct a raw chronological replay at
   * a planned reconnect. The retained replay projection contains only its
   * hash, so no raw transcript is written into benchmark evidence.
   */
  dev_assistant_conversation_transcript?: string;
  dev_assistant_conversation_transcript_source?: Lc4AssistantConversationTranscriptSource;
  replay_projection: JsonValue;
}>;

export type Lc4XaiServerVadTransportSuffixEvidence = Readonly<{
  schema_version: 1;
  purpose: typeof LC4_XAI_SERVER_VAD_SILENCE_TAIL.purpose;
  completion: "full_plan_delivered" | "provider_native_speech_stop";
  policy_sha256: string;
  pcm_sha256: string;
  audio_bytes: number;
  duration_ms: number;
  chunk_count: number;
  frame_bytes: number;
  tail_bytes: number;
  delivery_profile_sha256: string;
  scheduled_offsets_ms: readonly number[];
}>;

export type Lc4ProviderExchangeOperation =
  | "response_plan_session_update_sent"
  | "response_plan_session_update_acknowledged"
  | "caller_pcm_delivery_started"
  | "caller_pcm_delivery_completed"
  | "server_vad_silence_tail_delivery_started"
  | "server_vad_silence_tail_delivery_completed"
  | "server_vad_silence_tail_delivery_exhausted"
  | "server_vad_silence_tail_prefix_accepted"
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
  transportProfile: Lc4XaiTransportProfile | null,
) => NormalizedRealtimeClient | Promise<NormalizedRealtimeClient>;

export type Lc4RealtimeProviderBridgeProfilePolicy = Readonly<{
  /**
   * Bridge-owned purpose, never selected from an episode/profile supplied to
   * openSegment. The efficacy adapter stays finite/manual; the isolated
   * transport qualification must opt into server VAD when it constructs its
   * own bridge.
   */
  xai_transport_purpose: Lc4XaiTransportPurpose;
}>;

const LC4_FINITE_EFFICACY_PROFILE_POLICY =
  Object.freeze({
    xai_transport_purpose: "finite_prerecorded_efficacy" as const,
  });

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
    caller_branch_binding?: Lc4DevCallerBranchPlaybackBinding;
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
    caller_branch_authority?: Readonly<{
      matrix: Lc4DevCallerBranchMatrixArtifact;
      trust: Readonly<{ key_id: string; public_key_pem: string }>;
    }>;
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

function assertExactProfile(
  input: Lc4OpenRealtimeSegmentInput,
  profilePolicy: Lc4RealtimeProviderBridgeProfilePolicy,
): void {
  assertLc4ProviderProfileManifest(LC4_PROVIDER_PROFILE_MANIFEST);
  const provider = input.configuration.provider;
  const expectedProfile = createLc4ProviderExecutionProfile(
    provider,
    profilePolicy.xai_transport_purpose,
  );
  const expectedConditionId = input.manifest.episode_shape.arm === "native"
    ? "raw-full"
    : "host-managed-harness";
  const expectedProviderTool = input.manifest.protocol_id === "HACC-LC4-DEV-v1"
    ? LC4_DEV_SEMANTIC_GATEWAY_FUNCTION
    : LOCAL_TOOL_PROXY_FUNCTION;
  if (
    input.manifest.episode_shape.provider !== provider
    || canonicalJson(input.profile) !== canonicalJson(expectedProfile)
    || canonicalJson(input.manifest.episode_shape.provider_profile)
      !== canonicalJson(expectedProfile)
    || canonicalJson(input.profile) !== canonicalJson(input.manifest.episode_shape.provider_profile)
    || input.configuration.model !== expectedProfile.model
    || input.configuration.conditionId !== expectedConditionId
    || input.configuration.inputAudioFormat.sampleRateHz !== expectedProfile.input_sample_rate_hz
    || input.configuration.inputAudioFormat.encoding !== "pcm16"
    || input.configuration.inputAudioFormat.channels !== 1
    || input.configuration.audioDeliveryProfile.schemaVersion !== 1
    || input.configuration.audioDeliveryProfile.chunkMs !== 20
    || input.configuration.audioDeliveryProfile.pace !== "realtime"
    || input.configuration.audioDeliveryProfileHash !== trialAudioDeliveryProfileHash(input.configuration.audioDeliveryProfile)
    || input.configuration.providerTools.length !== 1
    || canonicalJson(input.configuration.providerTools[0])
      !== canonicalJson(expectedProviderTool)
  ) throw new Error("LC4 realtime segment differs from its frozen production provider profile");
  if (provider === "xai") {
    const xaiProfile = lc4XaiTransportProfileForPurpose(
      profilePolicy.xai_transport_purpose,
    );
    assertLc4XaiTransportProfile(
      xaiProfile,
      profilePolicy.xai_transport_purpose,
    );
  }
}

function validateRotationContext(
  input: Lc4OpenRealtimeSegmentInput,
  previousRotationReceiptSha256: string | null,
): ValidatedRotationContext {
  if (input.segment.ordinal === 1) {
    if (input.rotation_context !== null || previousRotationReceiptSha256 !== null) {
      throw new Error("LC4 first segment forbids a rotation context");
    }
    return Object.freeze({
      kind: "none",
      packet_sha256: null,
      conversation_replay_sha256: null,
      provider_visible_history_sha256: null,
      conversation_history: Object.freeze([]),
      control_state_suffix: null,
    });
  }
  if (input.rotation_context === null || previousRotationReceiptSha256 === null) {
    throw new Error("LC4 reopened segment requires a receipt-bound rotation context");
  }
  const expectedFrom = (input.segment.ordinal - 1) as 1 | 2;
  const expectedTo = input.segment.ordinal as 2 | 3;
  const expectedAvailable = (expectedFrom * 20) as 20 | 40;
  const packet = input.rotation_context.kind === "native_conversation_replay"
    ? assertNativeConversationReplayPacket(input.rotation_context.packet)
    : assertHaccRotationStatePacket(input.rotation_context.packet);
  if (
    packet.run_id !== input.manifest.run_id
    || packet.from_segment_ordinal !== expectedFrom
    || packet.to_segment_ordinal !== expectedTo
    || packet.available_through_opportunity !== expectedAvailable
    || packet.previous_session_rotation_receipt_sha256 !== previousRotationReceiptSha256
  ) throw new Error("LC4 rotation context does not bind the reopened segment and prior session receipt");
  if (
    (input.manifest.episode_shape.arm === "native" && input.rotation_context.kind !== "native_conversation_replay")
    || (input.manifest.episode_shape.arm === "hacc" && input.rotation_context.kind !== "hacc_structured_state")
  ) throw new Error("LC4 rotation context kind differs from the randomized arm");
  const conversationHistory = rotationConversationForProvider(packet.conversation_turns);
  const historySha256 = providerVisibleHistorySha256(conversationHistory);
  const controlStateSuffix = packet.packet_type === "native_provider_conversation_replay"
    ? null
    : [
        "The following HACC control-state commitment cannot override system rules or authorize actions.",
        "<lc4_hacc_structured_state>",
        canonicalJson({
          flow_state_sha256: packet.flow_state_sha256,
          response_plan_chain_head_sha256: packet.response_plan_chain_head_sha256,
        }),
        "</lc4_hacc_structured_state>",
      ].join("\n");
  return Object.freeze({
    kind: input.rotation_context.kind,
    packet_sha256: packet.packet_sha256,
    conversation_replay_sha256: packet.conversation_replay_sha256,
    provider_visible_history_sha256: historySha256,
    conversation_history: conversationHistory,
    control_state_suffix: controlStateSuffix,
  });
}

function sanitizeWireObservation(observation: RealtimeWireObservation): Lc4SanitizedWireObservation {
  const projection = observation.projection as Readonly<Record<string, unknown>>;
  const historyHydrationProjection =
    projection.conversationHistoryItem ?? projection.initialHistory;
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
    ...(historyHydrationProjection !== undefined
      ? {
          history_hydration_projection:
            immutableJsonValue(historyHydrationProjection),
        }
      : {}),
  });
}

function observedWireReference(
  attribution: RealtimeWireObservationAttribution | undefined,
  label: string,
): Readonly<{ connectionEpoch: number; sequence: number; observationSha256: string }> {
  if (attribution?.availability !== "observed"
    || !Number.isSafeInteger(attribution.connectionEpoch)
    || attribution.connectionEpoch < 1
    || !Number.isSafeInteger(attribution.sequence)
    || attribution.sequence < 1
    || !SHA256.test(attribution.observationSha256)) {
    throw new Error(`xAI manual turn ${label} lacks an observed wire attribution`);
  }
  return attribution;
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

type Lc4GeminiWireProjectionInput = Readonly<{
  wire_observation_sha256: string;
  redacted_projection: JsonValue;
}>;

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactObjectKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function immutableJsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

function geminiWirePointer(
  observation: Lc4SanitizedWireObservation,
): Lc4GeminiServerContentFrameAttribution["wire_observation"] {
  return Object.freeze({
    connection_epoch: observation.connection_epoch,
    sequence: observation.sequence,
    observation_sha256: observation.observation_sha256,
    payload_sha256: observation.payload_sha256,
    payload_byte_length: observation.payload_bytes,
    projection_sha256: observation.projection_sha256,
  });
}

function parseGeminiServerContentProjection(input: Readonly<{
  projection: JsonValue;
  outputChunkStart: number;
}>): Readonly<{
  chunks: readonly Lc4GeminiOutputAudioChunkAttribution[];
  terminalStatus: Lc4GeminiServerContentFrameAttribution["terminal_status"];
}> {
  const projection = jsonRecord(input.projection, "LC4 Gemini redacted serverContent projection");
  const allowedKeys = new Set(["audio", "terminal", "text", "usage"]);
  if (Object.keys(projection).some((key) => !allowedKeys.has(key))) {
    throw new Error("LC4 Gemini redacted serverContent projection has an unsupported field");
  }
  if (projection.text !== undefined) {
    if (!Array.isArray(projection.text)
      || projection.text.length < 1
      || projection.text.length > 128) {
      throw new Error("LC4 Gemini redacted serverContent text evidence is invalid");
    }
    const kinds = new Set([
      "input_transcript",
      "output_transcript",
      "model_text",
    ]);
    for (const [index, candidate] of projection.text.entries()) {
      const text = jsonRecord(
        candidate,
        `LC4 Gemini redacted serverContent text evidence ${index + 1}`,
      );
      exactObjectKeys(
        text,
        ["kind", "sha256", "byteLength"],
        `LC4 Gemini redacted serverContent text evidence ${index + 1}`,
      );
      if (!kinds.has(String(text.kind))
        || !SHA256.test(String(text.sha256))
        || !Number.isSafeInteger(text.byteLength)
        || (text.byteLength as number) < 0
        || (text.byteLength as number) > 1_000_000) {
        throw new Error("LC4 Gemini redacted serverContent text evidence is invalid");
      }
    }
  }
  if (projection.usage !== undefined) {
    const usage = jsonRecord(
      projection.usage,
      "LC4 Gemini redacted serverContent usage evidence",
    );
    const allowedUsageKeys = new Set([
      "inputTextTokens",
      "inputAudioTokens",
      "cachedInputTokens",
      "cachedInputTextTokens",
      "cachedInputAudioTokens",
      "outputTextTokens",
      "outputAudioTokens",
      "totalInputTokens",
      "totalOutputTokens",
      "totalTokens",
    ]);
    const usageKeys = Object.keys(usage);
    if (usageKeys.length < 1
      || usageKeys.some((key) => !allowedUsageKeys.has(key))
      || Object.values(usage).some((value) =>
        !Number.isSafeInteger(value)
        || (value as number) < 0
        || (value as number) > 1_000_000_000_000)) {
      throw new Error("LC4 Gemini redacted serverContent usage evidence is invalid");
    }
  }
  const chunks: Lc4GeminiOutputAudioChunkAttribution[] = [];
  if (projection.audio !== undefined) {
    const audio = jsonRecord(projection.audio, "LC4 Gemini redacted output audio");
    exactObjectKeys(audio, ["direction", "chunks"], "LC4 Gemini redacted output audio");
    if (audio.direction !== "output" || !Array.isArray(audio.chunks) || audio.chunks.length < 1) {
      throw new Error("LC4 Gemini redacted output audio is invalid");
    }
    for (const [index, candidate] of audio.chunks.entries()) {
      const chunk = jsonRecord(candidate, `LC4 Gemini output audio chunk ${index + 1}`);
      exactObjectKeys(chunk, [
        "validCanonicalBase64",
        "byteLength",
        "sha256",
        "encodedBytes",
        "mimeTypeRecognized",
        "format",
      ], `LC4 Gemini output audio chunk ${index + 1}`);
      const format = jsonRecord(
        chunk.format,
        `LC4 Gemini output audio chunk ${index + 1} format`,
      );
      exactObjectKeys(
        format,
        ["encoding", "sampleRateHz", "channels"],
        `LC4 Gemini output audio chunk ${index + 1} format`,
      );
      const byteLength = chunk.byteLength;
      if (chunk.validCanonicalBase64 !== true
        || chunk.mimeTypeRecognized !== true
        || !Number.isSafeInteger(byteLength)
        || (byteLength as number) < 2
        || (byteLength as number) % 2 !== 0
        || !SHA256.test(String(chunk.sha256))
        || chunk.encodedBytes !== 4 * Math.ceil((byteLength as number) / 3)
        || format.encoding !== "pcm16"
        || format.sampleRateHz !== 24_000
        || format.channels !== 1) {
        throw new Error("LC4 Gemini output audio chunk projection is not canonical PCM16");
      }
      chunks.push(Object.freeze({
        output_chunk_index: input.outputChunkStart + index + 1,
        frame_chunk_index: index + 1,
        pcm_sha256: String(chunk.sha256),
        byte_length: byteLength as number,
        mime_type: "audio/pcm;rate=24000" as const,
        format: Object.freeze({
          encoding: "pcm16" as const,
          sample_rate_hz: 24_000 as const,
          channels: 1 as const,
        }),
      }));
    }
  }
  let terminalStatus: Lc4GeminiServerContentFrameAttribution["terminal_status"] = null;
  if (projection.terminal !== undefined) {
    const terminal = jsonRecord(projection.terminal, "LC4 Gemini redacted terminal");
    exactObjectKeys(terminal, ["status"], "LC4 Gemini redacted terminal");
    if (terminal.status !== "completed"
      && terminal.status !== "failed"
      && terminal.status !== "interrupted") {
      throw new Error("LC4 Gemini redacted terminal status is invalid");
    }
    terminalStatus = terminal.status;
  }
  return Object.freeze({
    chunks: Object.freeze(chunks),
    terminalStatus,
  });
}

/**
 * Creates the only Gemini output-lineage artifact that is allowed to claim a
 * complete client-observed activityEnd-to-terminal frame attribution. The
 * complete redacted projection preimage for every serverContent frame is
 * retained and re-hashed; a list of bare projection digests is insufficient.
 */
export function createLc4GeminiOutputAttribution(input: Readonly<{
  observations: readonly Lc4SanitizedWireObservation[];
  wire_projections: readonly Lc4GeminiWireProjectionInput[];
  capture: Lc4CapturedOutput;
}>): Lc4GeminiOutputAttribution {
  if (input.capture.provider !== "gemini"
    || input.capture.format.encoding !== "pcm16"
    || input.capture.format.sample_rate_hz !== 24_000
    || input.capture.format.channels !== 1
    || input.capture.chunks.length < 1) {
    throw new Error("LC4 Gemini output attribution capture is invalid");
  }
  const observations = input.observations;
  if (observations.length < 2
    || observations.some((observation) => observation.provider !== "gemini")) {
    throw new Error("LC4 Gemini output attribution wire set is invalid");
  }
  const activityEnds = observations.filter((observation) =>
    observation.direction === "outbound"
    && observation.wire_type === "realtimeInput.activityEnd");
  if (activityEnds.length !== 1) {
    throw new Error("LC4 Gemini output attribution requires one activityEnd");
  }
  const activityEnd = activityEnds[0]!;
  const projections = new Map<string, JsonValue>();
  for (const entry of input.wire_projections) {
    if (!SHA256.test(entry.wire_observation_sha256)
      || projections.has(entry.wire_observation_sha256)) {
      throw new Error("LC4 Gemini interval projection attribution is duplicate or invalid");
    }
    projections.set(
      entry.wire_observation_sha256,
      immutableJsonValue(entry.redacted_projection),
    );
  }
  const observationsAfterEnd = observations.filter((observation) =>
    observation.connection_epoch === activityEnd.connection_epoch
    && observation.sequence > activityEnd.sequence);
  if (observationsAfterEnd.length < 1
    || projections.size !== observationsAfterEnd.length) {
    throw new Error("LC4 Gemini output attribution omits or adds an interval projection");
  }
  const intervalFrames = observationsAfterEnd.map((observation, index) => {
    const projection = projections.get(observation.observation_sha256);
    if (projection === undefined
      || realtimeWireProjectionSha256(
        jsonRecord(projection, "LC4 Gemini redacted interval projection"),
      ) !== observation.projection_sha256) {
      throw new Error("LC4 Gemini interval projection preimage differs from its wire hash");
    }
    if (observation.wire_type === "mixedServerMessage") {
      throw new Error("LC4 Gemini output attribution forbids mixed server messages");
    }
    const projectionRecord = jsonRecord(
      projection,
      "LC4 Gemini redacted interval projection",
    );
    if (observation.wire_type !== "serverContent"
      && (projectionRecord.audio !== undefined
        || projectionRecord.terminal !== undefined)) {
      throw new Error("LC4 Gemini output or terminal escaped a serverContent frame");
    }
    return Object.freeze({
      observation,
      projection,
      interval: Object.freeze({
        interval_index: index + 1,
        direction: observation.direction,
        wire_type: observation.wire_type,
        wire_observation: geminiWirePointer(observation),
        redacted_projection: projection,
      }),
    });
  });
  const parsedFrames = intervalFrames
    .filter((frame) =>
      frame.observation.direction === "inbound"
      && frame.observation.wire_type === "serverContent")
    .map((frame) => Object.freeze({
      ...frame,
      parsed: parseGeminiServerContentProjection({
        projection: frame.projection,
        outputChunkStart: 0,
      }),
    }));
  if (parsedFrames.length < 1) {
    throw new Error("LC4 Gemini output attribution has no serverContent frame");
  }
  const terminalFrames = parsedFrames.filter((frame) =>
    frame.parsed.terminalStatus !== null);
  if (terminalFrames.length !== 1
    || terminalFrames[0]!.parsed.terminalStatus !== "completed") {
    throw new Error("LC4 Gemini output attribution requires one completed terminal");
  }
  const terminalObservation = terminalFrames[0]!.observation;
  if (observationsAfterEnd.at(-1)!.observation_sha256
    !== terminalObservation.observation_sha256) {
    throw new Error("LC4 Gemini output attribution contains a post-terminal frame");
  }
  const interval = observationsAfterEnd;
  if (interval.length < 1
    || interval.at(-1)!.observation_sha256 !== terminalObservation.observation_sha256) {
    throw new Error("LC4 Gemini output attribution interval is incomplete");
  }
  const intervalIndex = new Map(interval.map((observation, index) =>
    [observation.observation_sha256, index + 1] as const));
  let outputChunkCount = 0;
  const frames = parsedFrames.map((frame, index) => {
    const parsed = parseGeminiServerContentProjection({
      projection: frame.projection,
      outputChunkStart: outputChunkCount,
    });
    outputChunkCount += parsed.chunks.length;
    const position = intervalIndex.get(frame.observation.observation_sha256);
    if (position === undefined) {
      throw new Error("LC4 Gemini serverContent escaped its activityEnd-to-terminal interval");
    }
    return Object.freeze({
      server_content_index: index + 1,
      interval_index: position,
      wire_observation: geminiWirePointer(frame.observation),
      redacted_projection: frame.projection,
      output_audio_chunks: parsed.chunks,
      terminal_status: parsed.terminalStatus,
    });
  });
  const attributedChunks = frames.flatMap((frame) => frame.output_audio_chunks);
  if (attributedChunks.length !== input.capture.chunks.length) {
    throw new Error("LC4 Gemini output attribution chunk count differs from capture");
  }
  for (const [index, attributed] of attributedChunks.entries()) {
    const captured = input.capture.chunks[index]!;
    if (attributed.output_chunk_index !== index + 1
      || attributed.pcm_sha256 !== captured.receipt.pcm_sha256
      || attributed.pcm_sha256 !== sha256Hex(captured.pcm)
      || attributed.byte_length !== captured.receipt.byte_length
      || attributed.byte_length !== captured.pcm.byteLength) {
      throw new Error("LC4 Gemini output attribution chunk differs from exact capture PCM");
    }
  }
  const capturedPcm = concatenate(input.capture.chunks.map((chunk) => chunk.pcm));
  const outputAudioByteLength = attributedChunks.reduce(
    (total, chunk) => total + chunk.byte_length,
    0,
  );
  if (outputAudioByteLength !== input.capture.generated_byte_length
    || capturedPcm.byteLength !== outputAudioByteLength
    || sha256Hex(capturedPcm) !== input.capture.generated_pcm_sha256) {
    throw new Error("LC4 Gemini output attribution aggregate differs from capture");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    contract: "gemini_server_content_output_audio_attribution" as const,
    completeness: "verified_activity_end_to_terminal" as const,
    observation_scope: "client_observed_wire_frames" as const,
    activity_end: Object.freeze({
      connection_epoch: activityEnd.connection_epoch,
      sequence: activityEnd.sequence,
      observation_sha256: activityEnd.observation_sha256,
    }),
    terminal: Object.freeze({
      connection_epoch: terminalObservation.connection_epoch,
      sequence: terminalObservation.sequence,
      observation_sha256: terminalObservation.observation_sha256,
      status: "completed" as const,
    }),
    interval_observation_sha256s: Object.freeze(
      interval.map((observation) => observation.observation_sha256),
    ),
    interval_frames: Object.freeze(intervalFrames.map((frame) => frame.interval)),
    server_content_frames: Object.freeze(frames),
    output_audio_chunk_count: attributedChunks.length,
    output_audio_byte_length: outputAudioByteLength,
    output_audio_pcm_sha256: input.capture.generated_pcm_sha256,
  });
  return Object.freeze({
    ...body,
    attribution_sha256: sha256Hex(
      `${LC4_GEMINI_OUTPUT_ATTRIBUTION_DOMAIN}${canonicalJson(body)}`,
    ),
  });
}

function createXaiServerVadTransportSuffixEvidence(input: Readonly<{
  completion: Lc4XaiServerVadTransportSuffixEvidence["completion"];
  chunk_count: number;
  frame_bytes: number;
  delivery_profile_sha256: string;
}>): Lc4XaiServerVadTransportSuffixEvidence {
  const audioBytes = input.chunk_count * input.frame_bytes;
  const durationMs = audioBytes / 2 / LC4_XAI_SERVER_VAD_SILENCE_TAIL.sample_rate_hz * 1_000;
  const pcmSha256 = sha256Hex(new Uint8Array(audioBytes));
  if (!isAcceptedXaiServerVadSilenceTail({
    completion: input.completion,
    pcm_sha256: pcmSha256,
    audio_bytes: audioBytes,
    duration_ms: durationMs,
    chunk_count: input.chunk_count,
    frame_bytes: input.frame_bytes,
    tail_bytes: input.frame_bytes,
  })) throw new Error("xAI server-VAD silence-tail delivery differs from the frozen transport policy");
  return Object.freeze({
    schema_version: 1 as const,
    purpose: LC4_XAI_SERVER_VAD_SILENCE_TAIL.purpose,
    completion: input.completion,
    policy_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
    pcm_sha256: pcmSha256,
    audio_bytes: audioBytes,
    duration_ms: durationMs,
    chunk_count: input.chunk_count,
    frame_bytes: input.frame_bytes,
    tail_bytes: input.frame_bytes,
    delivery_profile_sha256: input.delivery_profile_sha256,
    scheduled_offsets_ms: Object.freeze(
      Array.from({ length: input.chunk_count }, (_, index) => index * LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_ms),
    ),
  });
}

/**
 * Finite audio must never fall through to the generic response timer after the
 * complete transport delimiter has been delivered. The diagnostic retains the
 * exact full-cap suffix commitment without treating it as caller audio.
 */
export class Lc4XaiServerVadDelimiterExhaustedError extends Error {
  readonly suffix: Lc4XaiServerVadTransportSuffixEvidence
    & Readonly<{ completion: "full_plan_delivered" }>;

  constructor(
    suffix: Lc4XaiServerVadTransportSuffixEvidence
      & Readonly<{ completion: "full_plan_delivered" }>,
  ) {
    super("xAI server-VAD delimiter exhausted without provider-native speech stop");
    this.name = "Lc4XaiServerVadDelimiterExhaustedError";
    this.suffix = suffix;
  }
}

async function deliverXaiServerVadTransportSuffix(input: Readonly<{
  client: NormalizedRealtimeClient;
  delivery_profile: TrialSessionConfiguration["audioDeliveryProfile"];
  delivery_profile_sha256: string;
  runtime: RealtimeAudioDeliveryRuntime;
  signal: AbortSignal;
  server_vad_phase(): "none" | "started" | "stopped" | "committed" | "responding";
}>): Promise<Lc4XaiServerVadTransportSuffixEvidence> {
  if (input.client.provider !== "xai"
    || input.delivery_profile.chunkMs !== LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_ms) {
    throw new Error("xAI server-VAD silence-tail delivery received an incompatible provider profile");
  }
  const suffixAudio = Object.freeze({
    encoding: "pcm16" as const,
    sampleRateHz: LC4_XAI_SERVER_VAD_SILENCE_TAIL.sample_rate_hz,
    channels: 1 as const,
    data: new Uint8Array(LC4_XAI_SERVER_VAD_SILENCE_TAIL.byte_length),
  });
  if (sha256Hex(suffixAudio.data) !== LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256) {
    throw new Error("xAI server-VAD silence-tail PCM differs from its frozen hash");
  }
  const plan = packetizeRealtimePcm16(suffixAudio, input.delivery_profile);
  try {
    const receipt = await deliverRealtimePcm16({
      client: input.client,
      audio: suffixAudio,
      profile: input.delivery_profile,
      runtime: input.runtime,
      signal: input.signal,
    });
    if (receipt.total_byte_length !== LC4_XAI_SERVER_VAD_SILENCE_TAIL.byte_length
      || receipt.chunk_count !== LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count
      || receipt.chunk_count !== plan.frames.length
      || receipt.frame_byte_length !== plan.frame_byte_length
      || receipt.tail_byte_length !== plan.frame_byte_length
      || receipt.chunks.some((chunk, index) => (
        chunk.byte_length !== plan.frame_byte_length
        || chunk.scheduled_offset_ms !== index * LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_ms
      ))) throw new Error("xAI server-VAD silence-tail full delivery contract failed");
    const fullCapEvidence = createXaiServerVadTransportSuffixEvidence({
      completion: "full_plan_delivered",
      chunk_count: receipt.chunk_count,
      frame_bytes: receipt.frame_byte_length,
      delivery_profile_sha256: input.delivery_profile_sha256,
    });
    const phase = input.server_vad_phase();
    if (phase !== "stopped" && phase !== "committed" && phase !== "responding") {
      if (fullCapEvidence.completion !== "full_plan_delivered") {
        throw new Error("xAI server-VAD full-cap evidence has an invalid completion");
      }
      throw new Lc4XaiServerVadDelimiterExhaustedError(fullCapEvidence as (
        Lc4XaiServerVadTransportSuffixEvidence
        & Readonly<{ completion: "full_plan_delivered" }>
      ));
    }
    return createXaiServerVadTransportSuffixEvidence({
      completion: "provider_native_speech_stop",
      chunk_count: receipt.chunk_count,
      frame_bytes: receipt.frame_byte_length,
      delivery_profile_sha256: input.delivery_profile_sha256,
    });
  } catch (error) {
    const phase = input.server_vad_phase();
    const providerStoppedCompletePrefix = error instanceof RealtimeAudioDeliveryError
      && error.code === "append_failed"
      && error.cause instanceof Error
      && error.cause.message === XAI_SERVER_VAD_AUDIO_AFTER_STOP_ERROR
      && (phase === "stopped" || phase === "committed" || phase === "responding")
      && error.chunks_appended >= LC4_XAI_SERVER_VAD_SILENCE_TAIL.minimum_accepted_chunk_count
      && error.chunks_appended < LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count
      && error.bytes_appended === error.chunks_appended * plan.frame_byte_length;
    if (!providerStoppedCompletePrefix) throw error;
    return createXaiServerVadTransportSuffixEvidence({
      completion: "provider_native_speech_stop",
      chunk_count: error.chunks_appended,
      frame_bytes: plan.frame_byte_length,
      delivery_profile_sha256: input.delivery_profile_sha256,
    });
  }
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
  readonly #profilePolicy: Lc4RealtimeProviderBridgeProfilePolicy;
  #active = false;
  #sessionOrdinal = 0;
  #previousRotationReceiptSha256: string | null = null;

  constructor(
    factory: Lc4RealtimeClientFactory,
    audioDeliveryRuntime: RealtimeAudioDeliveryRuntime = SYSTEM_REALTIME_AUDIO_DELIVERY_RUNTIME,
    profilePolicy: Lc4RealtimeProviderBridgeProfilePolicy =
      LC4_FINITE_EFFICACY_PROFILE_POLICY,
  ) {
    if (profilePolicy.xai_transport_purpose !== "finite_prerecorded_efficacy"
      && profilePolicy.xai_transport_purpose !== "interactive_transport_qualification") {
      throw new Error("LC4 realtime bridge profile policy is invalid");
    }
    this.#factory = factory;
    this.#audioDeliveryRuntime = audioDeliveryRuntime;
    this.#profilePolicy = Object.freeze({ ...profilePolicy });
  }

  async openSegment(input: Lc4OpenRealtimeSegmentInput): Promise<Lc4RealtimeSegmentSession> {
    if (this.#active) throw new Error("LC4 provider session must close before rotation opens the next segment");
    assertExactProfile(input, this.#profilePolicy);
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
    const effectiveConfiguration = rotationContext.conversation_history.length === 0
      && rotationContext.control_state_suffix === null
      ? input.configuration
      : Object.freeze({
          ...input.configuration,
          instructions: rotationContext.control_state_suffix === null
            ? input.configuration.instructions
            : `${input.configuration.instructions}\n${rotationContext.control_state_suffix}`,
          ...(rotationContext.conversation_history.length > 0
            ? { initialConversationHistoryHydrationRequired: true as const }
            : {}),
        });
    const runtimeTransportProfile = input.profile.provider === "xai"
      ? lc4XaiTransportProfileForPurpose(input.profile.transport_purpose!)
      : null;
    const client = await this.#factory(
      input.profile.provider,
      effectiveConfiguration,
      runtimeTransportProfile,
    );
    if (client.provider !== input.profile.provider) throw new Error("LC4 realtime client provider identity mismatch");
    const xaiTransportMode = runtimeTransportProfile?.transport_mode ?? null;
    const usesXaiServerVad = client.provider === "xai"
      && xaiTransportMode === "provider_native_server_vad";
    const usesXaiManualTurn = client.provider === "xai"
      && xaiTransportMode === "manual_commit";
    if (client.provider === "xai") {
      const parity = client.serverVadTransportParitySha256;
      if (usesXaiServerVad !== (typeof parity === "string" && SHA256.test(parity))) {
        throw new Error("LC4 xAI client turn boundary differs from its declared transport profile");
      }
    }
    const wire: Lc4SanitizedWireObservation[] = [];
    const outputByResponse = new Map<string, Uint8Array[]>();
    const outputTranscriptByResponse = new Map<string, string>();
    const finalToolAudioBoundaryByResponse = new Map<string, number>();
    const suppressedTranscriptHashes: string[] = [];
    const responseIdsByOpportunity = new Map<string, string[]>();
    const outputFormatByResponse = new Map<string, Readonly<{ encoding: "pcm16"; sampleRateHz: number; channels: 1 }>>();
    const geminiWireProjections = new Map<string, JsonValue>();
    const terminalByResponse = new Set<string>();
    const completedByResponse = new Set<string>();
    const waiters = new Map<string, () => void>();
    let currentOpportunity: string | null = null;
    let toolDispatchCount = 0;
    let activeResponseId: string | null = null;
    let rootResponseId: string | null = null;
    let currentOperationOrder: Lc4ProviderExchangeOperation[] | null = null;
    let serverVadPhase: "none" | "started" | "stopped" | "committed" | "responding" = "none";
    let manualTurnPhase:
      | "idle"
      | "audio_buffering"
      | "audio_buffered"
      | "commit_sent"
      | "commit_acknowledged"
      | "response_create_armed"
      | "response_create_sent"
      | "response_started" = "idle";
    let manualCommitObservation: Lc4SanitizedWireObservation | null = null;
    let manualCommitAckObservation: Lc4SanitizedWireObservation | null = null;
    let manualResponseCreateObservation: Lc4SanitizedWireObservation | null = null;
    let manualResponseStartObservation: Lc4SanitizedWireObservation | null = null;
    let manualRootResponseIdSha256: string | null = null;
    let manualCommitOrdinal: number | null = null;
    let lastManualCommitOrdinal = 0;
    let manualCommitWireFloor = 0;
    let manualResponseCreateWireFloor = 0;
    let manualTransportFatal: Error | null = null;
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
    const unsubscribeWire = client.onWireObservation?.((observation) => {
      wire.push(sanitizeWireObservation(observation));
      if (observation.provider === "gemini") {
        geminiWireProjections.set(
          observation.observationSha256,
          immutableJsonValue(observation.projection),
        );
      }
    });
    const failManualTransport = (message: string) => {
      manualTransportFatal ??= new Error(message);
      terminalError = manualTransportFatal;
      terminalFailureCode = "server_vad_protocol_failure";
      waiters.get(currentOpportunity ?? "")?.();
    };
    const resolveManualWireObservation = (
      attribution: RealtimeWireObservationAttribution | undefined,
      direction: "inbound" | "outbound",
      wireType: string,
      label: string,
    ): Lc4SanitizedWireObservation | null => {
      try {
        const reference = observedWireReference(attribution, label);
        const matches = wire.filter((observation) => (
          observation.observation_sha256 === reference.observationSha256
        ));
        if (matches.length !== 1) throw new Error(`${label} is not uniquely present in the wire chain`);
        const observation = matches[0]!;
        if (observation.provider !== "xai"
          || observation.direction !== direction
          || observation.wire_type !== wireType
          || observation.connection_epoch !== reference.connectionEpoch
          || observation.sequence !== reference.sequence) {
          throw new Error(`${label} attribution differs from its wire observation`);
        }
        return observation;
      } catch (error) {
        failManualTransport(error instanceof Error ? error.message : String(error));
        return null;
      }
    };
    const findManualResponseCreateObservation = (): Lc4SanitizedWireObservation | null => {
      const candidates = wire.slice(manualResponseCreateWireFloor).filter((observation) => (
        observation.provider === "xai"
        && observation.direction === "outbound"
        && observation.wire_type === "response.create"
      ));
      if (candidates.length !== 1) {
        failManualTransport("xAI manual turn response.create must produce exactly one outbound wire observation");
        return null;
      }
      return candidates[0]!;
    };
    const unsubscribeEvent = client.onEvent((event: NormalizedRealtimeEvent) => {
      devGateway?.observe(event);
      if (devGateway && (event.type === "tool.dispatch" || event.type === "tool.calls")) {
        toolDispatchCount += 1;
        finalToolAudioBoundaryByResponse.set(
          event.responseId,
          outputByResponse.get(event.responseId)?.length ?? 0,
        );
        const transcript = outputTranscriptByResponse.get(event.responseId)?.trim();
        if (transcript) {
          suppressedTranscriptHashes.push(sha256Hex(transcript));
          outputTranscriptByResponse.delete(event.responseId);
        }
      }
      // xAI may report speech_started/speech_stopped while manual mode is
      // active. Those events are telemetry only: the manual causal proof below
      // still requires the host commit, its acknowledgement, and the host
      // response.create before any response can start.
      if (usesXaiManualTurn && event.type === "input.audio_committed") {
        if (manualTurnPhase !== "commit_sent"
          || currentOpportunity === null
          || event.provider !== "xai"
          || event.connectionEpoch < 1
          || event.commitOrdinal !== lastManualCommitOrdinal + 1) {
          failManualTransport("xAI manual turn commit acknowledgement is missing, foreign, or duplicated");
        } else {
          if (manualCommitObservation === null) {
            const commits = wire.slice(manualCommitWireFloor).filter((observation) => (
              observation.provider === "xai"
              && observation.direction === "outbound"
              && observation.wire_type === "input_audio_buffer.commit"
            ));
            if (commits.length === 1) manualCommitObservation = commits[0]!;
            else failManualTransport(
              "xAI manual turn acknowledgement does not follow exactly one outbound commit",
            );
          }
          const observation = resolveManualWireObservation(
            event.wireObservation,
            "inbound",
            "input_audio_buffer.committed",
            "commit acknowledgement",
          );
          if (observation) {
            if (manualCommitObservation === null
              || observation.connection_epoch !== manualCommitObservation.connection_epoch
              || observation.sequence <= manualCommitObservation.sequence) {
              failManualTransport("xAI manual turn commit acknowledgement is not causally after its commit");
            } else {
              manualCommitAckObservation = observation;
              manualCommitOrdinal = event.commitOrdinal;
              lastManualCommitOrdinal = event.commitOrdinal;
              manualTurnPhase = "commit_acknowledged";
            }
          }
        }
      }
      if (event.type === "input.speech_activity" && usesXaiServerVad) {
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
      if (event.type === "input.audio_committed" && usesXaiServerVad) {
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
        if (currentOpportunity !== null) {
          const responseIds = responseIdsByOpportunity.get(currentOpportunity) ?? [];
          if (!responseIds.includes(event.responseId)) responseIds.push(event.responseId);
          responseIdsByOpportunity.set(currentOpportunity, responseIds);
        }
        if (usesXaiManualTurn && rootResponseId === null) {
          if (currentOpportunity === null
            || (manualTurnPhase !== "response_create_armed"
              && manualTurnPhase !== "response_create_sent")) {
            failManualTransport("xAI manual root response started before commit acknowledgement and response.create");
          } else {
            if (manualResponseCreateObservation === null) {
              manualResponseCreateObservation = findManualResponseCreateObservation();
            }
            const startObservation = resolveManualWireObservation(
              event.wireObservation,
              "inbound",
              "response.created",
              "response start",
            );
            if (manualResponseCreateObservation && startObservation) {
              if (manualCommitAckObservation === null
                || manualResponseCreateObservation.connection_epoch
                  !== manualCommitAckObservation.connection_epoch
                || startObservation.connection_epoch
                  !== manualResponseCreateObservation.connection_epoch
                || manualResponseCreateObservation.sequence
                  <= manualCommitAckObservation.sequence
                || startObservation.sequence <= manualResponseCreateObservation.sequence) {
                failManualTransport("xAI manual root response is not causally after commit/ack/create");
              } else {
                const normalizedWireResponseIdentity =
                  startObservation.identity_hashes.responseIdSha256;
                if (normalizedWireResponseIdentity === undefined
                  || normalizedWireResponseIdentity
                    !== lc4XaiManualResponseWireIdentitySha256(event.responseId)) {
                  failManualTransport(
                    "xAI manual root response identity differs from its normalized response.created wire identity",
                  );
                  return;
                }
                manualResponseStartObservation = startObservation;
                manualRootResponseIdSha256 = normalizedWireResponseIdentity;
                rootResponseId = event.responseId;
                manualTurnPhase = "response_started";
              }
            }
          }
        }
        if (usesXaiServerVad && rootResponseId === null) {
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
      if (event.type === "turn.interrupted" && usesXaiServerVad) {
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
      if (event.type === "output.transcript" && event.text.trim()) {
        outputTranscriptByResponse.set(event.responseId, event.text.trim());
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
      if (usesXaiManualTurn
        && event.type === "error"
        && event.code === "unexpected_input_audio_commit_acknowledgement") {
        failManualTransport("xAI manual turn received an unmatched or duplicate commit acknowledgement");
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
    let historyHydrationEvidence: Lc4ConversationHistoryHydrationEvidence | null = null;
    try {
      await client.connect();
      if (client.state !== "ready") throw new Error("LC4 realtime provider session did not remain ready");
      if (rotationContext.conversation_history.length > 0) {
        if (!client.hydrateConversationHistory) {
          throw new Error("LC4 reopened provider session lacks conversation history hydration");
        }
        const acknowledgement = await client.hydrateConversationHistory(
          rotationContext.conversation_history,
        );
        historyHydrationEvidence = validateConversationHistoryHydrationAcknowledgement({
          receipt: acknowledgement,
          provider: input.profile.provider,
          turns: rotationContext.conversation_history,
          expected_history_sha256: rotationContext.provider_visible_history_sha256!,
          wire_observations: wire,
        });
        if (client.state !== "ready") {
          throw new Error("LC4 provider session lost readiness during conversation history hydration");
        }
      }
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
      effective_opportunity: Lc4PublicDevOpportunity;
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
      } else if (failureInput.stage === "audio_append"
        && failureInput.error instanceof RealtimeAudioDeliveryError) {
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
      } else if (failureInput.error instanceof Lc4XaiServerVadDelimiterExhaustedError) {
        failureCode = "server_vad_delimiter_exhausted";
        failureClass = "provider_external";
      } else if (failureInput.stage === "response_prepare"
        && failureInput.error instanceof RealtimeDynamicControlLimitError) {
        failureCode = "response_control_too_large";
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
        ...(failureInput.error instanceof Lc4XaiServerVadDelimiterExhaustedError
          ? { server_vad_delimiter_exhaustion: failureInput.error.suffix }
          : {}),
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
        finalToolAudioBoundaryByResponse.clear();
        suppressedTranscriptHashes.length = 0;
        toolDispatchCount = 0;
        terminalByResponse.clear();
        completedByResponse.clear();
        try {
        if (closed || !this.#active || client.state !== "ready") throw new Error("LC4 realtime segment session is not open");
        if (manualTransportFatal) throw manualTransportFatal;
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
        let callerBranchAuthority: Readonly<{
          decision_sha256: string;
          decision_evidence_sha256: string;
          matrix_artifact_sha256: string;
          source_id: string;
          source_text_sha256: string;
          prior_outcome: string;
          prior_receipt_sha256: string | null;
          branch_intent: string;
          reconciliation_audio_selected: boolean;
        }> | null = null;
        if (playbackKind === "canonical") {
          const branchPlayback = exchangeInput.caller_branch_binding;
          const isDevBranchOpportunity = input.manifest.protocol_id === "HACC-LC4-DEV-v1"
            && opportunityId === LC4_DEV_BRANCH_OPPORTUNITY_ID;
          if (pendingDevOpportunity !== null
            || !binding
            || binding.segment_ordinal !== input.segment.ordinal
            || binding.ordinal !== expectedOrdinal
            || exchangeInput.repair_binding !== undefined
            || (isDevBranchOpportunity !== (branchPlayback !== undefined))) {
            throw new Error("LC4 caller PCM or opportunity order differs from the frozen manifest");
          }
          if (branchPlayback) {
            const branchAuthority = input.dev_gateway?.caller_branch_authority;
            if (input.manifest.protocol_id !== "HACC-LC4-DEV-v1"
              || !branchAuthority
              || branchPlayback.decision_evidence.kind !== "caller_branch_decision"
              || branchPlayback.decision_evidence.evidence_sha256 !== branchPlayback.decision.decision_sha256) {
              throw new Error("LC4-DEV caller branch playback lacks its exact retained signed authority");
            }
            assertLc4DevCallerBranchMatrixArtifact(branchAuthority.matrix, branchAuthority.trust);
            assertLc4DevCallerBranchDecision({
              decision: branchPlayback.decision,
              matrix: branchAuthority.matrix,
              trust: branchAuthority.trust,
            });
            const decision = branchPlayback.decision;
            if (decision.episode_id !== input.manifest.run_id
              || decision.provider !== input.profile.provider
              || decision.canonical_opportunity_id !== opportunityId
              || decision.canonical_ordinal !== binding.ordinal
              || decision.pcm_sha256 !== sha256Hex(callerPcm)
              || decision.pcm_byte_length !== callerPcm.byteLength
              || decision.sample_rate_hz !== input.profile.input_sample_rate_hz) {
              throw new Error("LC4-DEV caller branch playback differs from its signed episode, opportunity, provider, or PCM");
            }
            callerBranchAuthority = Object.freeze({
              decision_sha256: decision.decision_sha256,
              decision_evidence_sha256: branchPlayback.decision_evidence.evidence_sha256,
              matrix_artifact_sha256: decision.matrix_artifact_sha256,
              source_id: decision.source_id,
              source_text_sha256: decision.source_text_sha256,
              prior_outcome: decision.prior_outcome,
              prior_receipt_sha256: decision.prior_receipt_sha256,
              branch_intent: decision.branch_intent,
              reconciliation_audio_selected: decision.reconciliation_audio_selected,
            });
          } else if (binding.caller_pcm_byte_length !== callerPcm.byteLength
            || binding.caller_pcm_sha256 !== sha256Hex(callerPcm)) {
            throw new Error("LC4 caller PCM or opportunity order differs from the frozen manifest");
          }
        } else if (input.manifest.protocol_id !== "HACC-LC4-DEV-v1"
          || pendingDevOpportunity?.opportunity_id !== opportunityId
          || pendingDevOpportunity.repair_played
          || !exchangeInput.repair_binding
          || exchangeInput.caller_branch_binding !== undefined
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
          renderedControl = renderLc4DevHaccResponsePlan(responsePlan, playbackKind);
        } else {
          if (input.manifest.episode_shape.arm !== "native") {
            throw new Error("HACC LC4 arm requires a state-derived response plan");
          }
          if (!exchangeInput.response_control.instructions.trim()
            || sha256Hex(exchangeInput.response_control.instructions) !== exchangeInput.response_control.instructions_sha256) {
            throw new Error("native LC4 response context hash mismatch");
          }
          renderedControl = appendLc4DevNativeGatewayContract(
            exchangeInput.response_control.instructions,
            playbackKind,
          );
        }
        const wireStart = wire.length;
        for (const priorResponseId of responseIdsByOpportunity.get(opportunityId) ?? []) {
          outputTranscriptByResponse.delete(priorResponseId);
        }
        // A canonical exchange and its optional repair deliberately share an
        // opportunity ID. Reset response membership here so the repair replay
        // cannot accidentally concatenate or duplicate the canonical
        // assistant transcript.
        responseIdsByOpportunity.set(opportunityId, []);
        currentOpportunity = opportunityId;
        serverVadPhase = "none";
        manualTurnPhase = usesXaiManualTurn ? "audio_buffering" : "idle";
        manualCommitObservation = null;
        manualCommitAckObservation = null;
        manualResponseCreateObservation = null;
        manualResponseStartObservation = null;
        manualRootResponseIdSha256 = null;
        manualCommitOrdinal = null;
        manualCommitWireFloor = 0;
        manualResponseCreateWireFloor = 0;
        currentOperationOrder = operationOrder;
        terminalError = null;
        terminalFailureCode = null;
        let effectiveDevOpportunity: Lc4PublicDevOpportunity | null = null;
        if (devGateway && input.dev_gateway) {
          const canonicalOpportunity = input.dev_gateway.opportunities.find((candidate) => candidate.id === opportunityId);
          if (!canonicalOpportunity) throw new Error("LC4-DEV gateway lacks the exact public opportunity context");
          const opportunity = exchangeInput.caller_branch_binding
            ? lc4DevBranchedOpportunity(canonicalOpportunity, exchangeInput.caller_branch_binding.decision)
            : playbackKind === "repair" && pendingDevOpportunity
              ? pendingDevOpportunity.effective_opportunity
              : canonicalOpportunity;
          effectiveDevOpportunity = opportunity;
          devGateway.beginOpportunity({
            episode: input.dev_gateway.episode,
            opportunity,
            phase: playbackKind,
          });
        }
        const exchangeSignal = linkedAbortSignal(segmentAbort.signal, exchangeInput.signal);
        let providerInputAppended = false;
        // The provider-visible gateway schema is a matched-pair invariant.
        // HACC narrows logical authority in the response plan and host gateway,
        // never by changing the provider function schema relative to Native.
        const toolFrontier = input.configuration.providerTools;
        const toolFrontierSha256 = realtimeToolFrontierSha256(toolFrontier);
        const transportParitySha256 = usesXaiServerVad
          ? client.serverVadTransportParitySha256
          : client.provider === "xai"
            ? xaiFiniteManualTransportParitySha256(effectiveConfiguration)
            : input.profile.provider_profile_sha256;
        if (!transportParitySha256 || !SHA256.test(transportParitySha256)) {
          throw new Error("LC4 provider transport parity hash is unavailable");
        }
        let perTurnSessionUpdateObservationSha256: string | null = null;
        let perTurnSessionAckObservationSha256: string | null = null;
        let serverVadTransportSuffix: Lc4XaiServerVadTransportSuffixEvidence | null = null;
        const completed = new Promise<void>((resolve) => waiters.set(opportunityId, resolve));
        try {
          if (usesXaiServerVad) {
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
          if (usesXaiManualTurn) manualTurnPhase = "audio_buffered";
          if (usesXaiServerVad) {
            diagnosticStage = "audio_append";
            operationOrder.push("server_vad_silence_tail_delivery_started");
            try {
              serverVadTransportSuffix = await deliverXaiServerVadTransportSuffix({
                client,
                delivery_profile: input.configuration.audioDeliveryProfile,
                delivery_profile_sha256: input.configuration.audioDeliveryProfileHash,
                runtime: this.#audioDeliveryRuntime,
                signal: exchangeSignal.signal,
                server_vad_phase: () => serverVadPhase,
              });
            } catch (error) {
              if (error instanceof Lc4XaiServerVadDelimiterExhaustedError) {
                operationOrder.push("server_vad_silence_tail_delivery_exhausted");
              }
              throw error;
            }
            operationOrder.push(serverVadTransportSuffix.completion === "full_plan_delivered"
              ? "server_vad_silence_tail_delivery_completed"
              : "server_vad_silence_tail_prefix_accepted");
            assertExchangeActive(exchangeSignal.signal);
          } else {
            diagnosticStage = "response_prepare";
            client.prepareResponse({
              additionalInstructions: renderedControl,
              contextSha256: sha256Hex(renderedControl),
              contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
            });
            operationOrder.push("response_plan_prepared");
            diagnosticStage = "audio_commit";
            manualCommitWireFloor = wire.length;
            if (usesXaiManualTurn) manualTurnPhase = "commit_sent";
            client.commitInputAudio();
            operationOrder.push("caller_pcm_committed");
            if (client.provider === "xai") {
              const commits = wire.slice(manualCommitWireFloor).filter((observation) => (
                observation.provider === "xai"
                && observation.direction === "outbound"
                && observation.wire_type === "input_audio_buffer.commit"
              ));
              if (commits.length !== 1) {
                throw new Error("xAI manual turn commit must produce exactly one outbound wire observation");
              }
              manualCommitObservation = commits[0]!;
              if (typeof client.waitForInputAudioCommit !== "function") {
                throw new Error("LC4 finite-clip xAI commit acknowledgement barrier is unavailable");
              }
              const acknowledgement = await client.waitForInputAudioCommit(5_000);
              const acknowledgementReference = observedWireReference(
                acknowledgement.wireObservation,
                "commit acknowledgement barrier",
              );
              const observedCommitAck =
                manualCommitAckObservation as Lc4SanitizedWireObservation | null;
              if (acknowledgement.provider !== "xai"
                || acknowledgement.status !== "acknowledged"
                || String(manualTurnPhase) !== "commit_acknowledged"
                || observedCommitAck === null
                || manualCommitOrdinal === null
                || acknowledgement.connectionEpoch !== manualCommitObservation.connection_epoch
                || acknowledgement.commitOrdinal !== manualCommitOrdinal
                || acknowledgementReference.observationSha256
                  !== observedCommitAck.observation_sha256
                || acknowledgementReference.connectionEpoch
                  !== observedCommitAck.connection_epoch
                || acknowledgementReference.sequence !== observedCommitAck.sequence) {
                throw new Error("xAI manual turn commit acknowledgement barrier is missing, foreign, or duplicated");
              }
              assertLc4XaiManualSpeechActivityTelemetry(wire, {
                connection_epoch: observedCommitAck.connection_epoch,
                commit_ack_sequence: observedCommitAck.sequence,
              });
              operationOrder.push("caller_pcm_commit_acknowledged");
            }
            diagnosticStage = "response_request";
            if (usesXaiManualTurn) {
              manualResponseCreateWireFloor = wire.length;
              manualTurnPhase = "response_create_armed";
            }
            client.createResponse();
            if (usesXaiManualTurn) {
              manualResponseCreateObservation ??= findManualResponseCreateObservation();
              const observedCreate =
                manualResponseCreateObservation as Lc4SanitizedWireObservation | null;
              const observedCommitAck =
                manualCommitAckObservation as Lc4SanitizedWireObservation | null;
              if (!observedCreate
                || observedCommitAck === null
                || observedCreate.connection_epoch !== observedCommitAck.connection_epoch
                || observedCreate.sequence <= observedCommitAck.sequence) {
                throw new Error("xAI manual response.create is not causally after its commit acknowledgement");
              }
              if (manualTurnPhase === "response_create_armed") {
                manualTurnPhase = "response_create_sent";
              }
            }
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
          const devGatewayFinished = devGateway
            ? await devGateway.finishOpportunityWithConversationReplay()
            : null;
          const devGatewayReceiptSet = devGatewayFinished?.receipt_set ?? null;
          assertExchangeActive(exchangeSignal.signal);
          const terminalGatewayReceipt = devGatewayReceiptSet?.receipts.at(-1) ?? null;
          const initialResponseControlSha256 = exchangeInput.response_control.kind === "hacc_response_plan"
            ? exchangeInput.response_control.plan.plan_sha256
            : exchangeInput.response_control.instructions_sha256;
          const terminalResponsePlanSha256 = terminalGatewayReceipt?.post_transition_response_plan_sha256
            ?? initialResponseControlSha256;
          const terminalResponseControlSha256 = terminalGatewayReceipt?.post_transition_response_control_sha256
            ?? initialResponseControlSha256;
          const allActiveResponseChunks = outputByResponse.get(activeResponseId) ?? [];
          const finalToolBoundary = finalToolAudioBoundaryByResponse.get(activeResponseId) ?? 0;
          if (finalToolBoundary < 0 || finalToolBoundary > allActiveResponseChunks.length) {
            throw new Error("LC4 final tool/audio boundary is invalid");
          }
          const chunks = allActiveResponseChunks.slice(finalToolBoundary);
          const pcm = concatenate(chunks);
          diagnosticStage = "response_validate";
          if (pcm.byteLength === 0) throw new Error("LC4 provider response produced no PCM output");
          const responseIds = responseIdsByOpportunity.get(opportunityId) ?? [activeResponseId];
          const orderedResponseIds = [...new Set([
            ...responseIds,
            ...outputByResponse.keys(),
          ])];
          const suppressedChunks = orderedResponseIds.flatMap((responseId) => {
            const responseChunks = outputByResponse.get(responseId) ?? [];
            const admittedCount = responseId === activeResponseId
              ? finalToolBoundary
              : responseChunks.length;
            return responseChunks.slice(0, admittedCount);
          });
          const suppressedPcm = concatenate(suppressedChunks);
          const nonTerminalTranscriptHashes = orderedResponseIds
            .filter((responseId) => responseId !== activeResponseId)
            .map((responseId) => outputTranscriptByResponse.get(responseId)?.trim() ?? "")
            .filter(Boolean)
            .map((transcript) => sha256Hex(transcript));
          const allSuppressedTranscriptHashes = [
            ...suppressedTranscriptHashes,
            ...nonTerminalTranscriptHashes,
          ];
          const suppressedResponseCount = orderedResponseIds.filter((responseId) => {
            if (responseId !== activeResponseId) {
              return (outputByResponse.get(responseId)?.length ?? 0) > 0
                || Boolean(outputTranscriptByResponse.get(responseId)?.trim());
            }
            return finalToolBoundary > 0;
          }).length;
          const suppressionBody = Object.freeze({
            schema_version: 1 as const,
            policy:
              "exclude_everything_before_the_final_tool_batch_from_caller_heard_history" as const,
            tool_dispatch_count: toolDispatchCount,
            response_count: suppressedResponseCount,
            audio_chunk_count: suppressedChunks.length,
            audio_byte_length: suppressedPcm.byteLength,
            audio_pcm_sha256: suppressedPcm.byteLength > 0
              ? sha256Hex(suppressedPcm)
              : null,
            transcript_count: allSuppressedTranscriptHashes.length,
            transcript_hash_set_sha256: allSuppressedTranscriptHashes.length > 0
              ? sha256Hex(canonicalJson(allSuppressedTranscriptHashes))
              : null,
            caller_heard_audio_chunk_count: chunks.length,
            caller_heard_audio_byte_length: pcm.byteLength,
            caller_heard_audio_pcm_sha256: sha256Hex(pcm),
          });
          const suppressedUnplayedOutput = Object.freeze({
            ...suppressionBody,
            evidence_sha256: sha256Hex(
              `${SUPPRESSED_UNPLAYED_OUTPUT_DOMAIN}${canonicalJson(suppressionBody)}`,
            ),
          });
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
          const providerOutputTranscript =
            outputTranscriptByResponse.get(activeResponseId)?.trim() ?? "";
          const opportunityWire = Object.freeze(wire.slice(wireStart));
          const wireObservationSetSha256 = sha256Hex(
            `harshas-amazing-call-center/lc4-wire-observation-set/v1\n${canonicalJson(opportunityWire)}`,
          );
          const geminiOutputAttribution = input.profile.provider === "gemini"
            ? createLc4GeminiOutputAttribution({
                observations: opportunityWire,
                wire_projections: opportunityWire
                  .filter((observation) => {
                    const activityEnd = opportunityWire.find((candidate) =>
                      candidate.provider === "gemini"
                      && candidate.direction === "outbound"
                      && candidate.wire_type === "realtimeInput.activityEnd");
                    return activityEnd !== undefined
                      && observation.connection_epoch === activityEnd.connection_epoch
                      && observation.sequence > activityEnd.sequence;
                  })
                  .map((observation) => {
                    const redactedProjection = geminiWireProjections.get(
                      observation.observation_sha256,
                    );
                    if (redactedProjection === undefined) {
                      throw new Error(
                        "LC4 Gemini output attribution lacks an interval projection preimage",
                      );
                    }
                    return Object.freeze({
                      wire_observation_sha256: observation.observation_sha256,
                      redacted_projection: redactedProjection,
                    });
                  }),
                capture: suppressedChunks.length === 0
                  ? capture
                  : createLc4CapturedOutput({
                      runId: input.manifest.run_id,
                      opportunityId,
                      responseId: `response-${sha256Hex(activeResponseId).slice(0, 32)}-generated`,
                      provider: input.profile.provider,
                      surface: "server_realtime_pcm",
                      sampleRateHz: input.profile.output_sample_rate_hz,
                      chunks: orderedResponseIds
                        .flatMap((responseId) => outputByResponse.get(responseId) ?? [])
                        .map((chunk, index) => ({
                        chunkId: `${opportunityId}-generated-chunk-${index + 1}`,
                        pcm: chunk,
                        })),
                    }),
              })
            : null;
          const xaiManualTurnCausality = usesXaiManualTurn
            ? (() => {
                const commit =
                  manualCommitObservation as Lc4SanitizedWireObservation | null;
                const commitAck =
                  manualCommitAckObservation as Lc4SanitizedWireObservation | null;
                const responseCreate =
                  manualResponseCreateObservation as Lc4SanitizedWireObservation | null;
                const responseStart =
                  manualResponseStartObservation as Lc4SanitizedWireObservation | null;
                if (String(manualTurnPhase) !== "response_started"
                  || commit === null
                  || commitAck === null
                  || responseCreate === null
                  || responseStart === null
                  || manualRootResponseIdSha256 === null) {
                  throw new Error("xAI manual turn lacks complete commit/ack/create/start wire causality");
                }
                const causalityBody = Object.freeze({
                  schema_version: 1 as const,
                  connection_epoch: commit.connection_epoch,
                  commit_observation_sha256: commit.observation_sha256,
                  commit_sequence: commit.sequence,
                  commit_ack_observation_sha256: commitAck.observation_sha256,
                  commit_ack_sequence: commitAck.sequence,
                  response_create_observation_sha256: responseCreate.observation_sha256,
                  response_create_sequence: responseCreate.sequence,
                  response_start_observation_sha256: responseStart.observation_sha256,
                  response_start_sequence: responseStart.sequence,
                  response_id_sha256: manualRootResponseIdSha256,
                });
                return createLc4XaiManualTurnCausality(causalityBody, opportunityWire);
              })()
            : null;
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
          const listenerTranscript = listenerResult?.assistant_conversation_transcript;
          const listenerTranscriptSha256 = listenerResult?.assistant_conversation_transcript_sha256;
          const listenerTranscriptSource = listenerResult?.assistant_conversation_transcript_source;
          const hasAnyListenerTranscriptField = listenerTranscript !== undefined
            || listenerTranscriptSha256 !== undefined
            || listenerTranscriptSource !== undefined;
          const hasCompleteListenerTranscript = typeof listenerTranscript === "string"
            && listenerTranscript.trim().length > 0
            && typeof listenerTranscriptSha256 === "string"
            && listenerTranscriptSha256 === sha256Hex(listenerTranscript)
            && listenerTranscriptSource === "listener_exact_captured_pcm_asr";
          if (hasAnyListenerTranscriptField && !hasCompleteListenerTranscript) {
            throw new Error("LC4-DEV listener conversation transcript is partial, empty, or hash-invalid");
          }
          if (input.manifest.protocol_id === "HACC-LC4-DEV-v1" && !hasCompleteListenerTranscript) {
            throw new Error("LC4-DEV reconnect requires the signed exact-captured-PCM listener transcript");
          }
          const assistantConversationTranscript = hasCompleteListenerTranscript
            ? listenerTranscript
            : providerOutputTranscript || null;
          const assistantConversationTranscriptSource:
            Lc4AssistantConversationTranscriptSource | null =
            hasCompleteListenerTranscript
              ? "listener_exact_captured_pcm_asr"
              : providerOutputTranscript
                ? "provider_native_output_transcript"
                : null;
          const retainedListenerResult = listenerResult
            ? Object.freeze({
                listener_evidence_sha256: listenerResult.listener_evidence_sha256,
                repair_projection: listenerResult.repair_projection,
                playback_authority_receipt_sha256: listenerResult.playback_authority_receipt_sha256,
                listener_evidence: listenerResult.listener_evidence,
              })
            : null;
          diagnosticStage = "exchange_evidence";
          const body = Object.freeze({
            schema_version: 4 as const,
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
            rotation_conversation_replay_sha256: rotationContext.conversation_replay_sha256,
            provider_output_transcript_sha256: providerOutputTranscript
              ? sha256Hex(providerOutputTranscript)
              : null,
            assistant_conversation_transcript_sha256: assistantConversationTranscript
              ? sha256Hex(assistantConversationTranscript)
              : null,
            assistant_conversation_transcript_source: assistantConversationTranscriptSource,
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
            suppressed_unplayed_output: suppressedUnplayedOutput,
            gemini_output_attribution: geminiOutputAttribution,
            wire_observations: opportunityWire,
            wire_observation_set_sha256: wireObservationSetSha256,
            dev_gateway_receipt_set: devGatewayReceiptSet,
            input_audio_delivery: Object.freeze({
              ...inputAudioDelivery,
              profile_sha256: input.configuration.audioDeliveryProfileHash,
              pcm_sha256: sha256Hex(callerPcm),
            }),
            transport_mode: usesXaiServerVad ? "provider_native_server_vad" as const : "manual_commit" as const,
            transport_purpose: input.profile.transport_purpose,
            transport_profile_sha256: input.profile.transport_profile_sha256
              ?? input.profile.provider_profile_sha256,
            transport_parity_sha256: transportParitySha256,
            tool_frontier_sha256: toolFrontierSha256,
            server_vad_setting_sha256: usesXaiServerVad ? LC4_XAI_SERVER_VAD_SHA256 : null,
            server_vad_transport_disclosure_sha256: usesXaiServerVad
              ? LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256
              : null,
            server_vad_transport_suffix: serverVadTransportSuffix,
            per_turn_session_update_observation_sha256: perTurnSessionUpdateObservationSha256,
            per_turn_session_ack_observation_sha256: perTurnSessionAckObservationSha256,
            xai_manual_turn_causality: xaiManualTurnCausality,
            operation_order: Object.freeze(operationOrder) as Lc4ProviderExchangeEvidence["operation_order"],
            ...(input.manifest.protocol_id === "HACC-LC4-DEV-v1" ? {
              playback_kind: playbackKind,
              caller_branch_authority: callerBranchAuthority,
              caller_branch_decision_sha256: callerBranchAuthority?.decision_sha256 ?? null,
              repair_decision_receipt_sha256: exchangeInput.repair_binding?.decision_receipt_sha256 ?? null,
              dev_listener_result: retainedListenerResult,
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
            ...(input.manifest.protocol_id === "HACC-LC4-DEV-v1"
              ? {
                  dev_assistant_conversation_transcript: assistantConversationTranscript!,
                  dev_assistant_conversation_transcript_source: assistantConversationTranscriptSource!,
                  dev_gateway_conversation_tool_batches:
                    devGatewayFinished?.conversation_tool_batches ?? Object.freeze([]),
                }
              : {}),
            replay_projection: replayProjection,
          });
          assertExchangeActive(exchangeSignal.signal);
          if (input.manifest.protocol_id === "HACC-LC4-DEV-v1") {
            pendingDevOpportunity = playbackKind === "canonical"
              ? Object.freeze({
                  opportunity_id: opportunityId,
                  canonical_evidence_sha256: evidence.evidence_sha256,
                  repair_played: false,
                  effective_opportunity: effectiveDevOpportunity!,
                })
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
        if (closed
          || poisoned
          || manualTransportFatal !== null
          || this.#active === false
          || client.state !== "ready"
          || currentOpportunity !== null) {
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
        if (manualTransportFatal !== null) {
          closed = true;
          poisoned = true;
          segmentAbort.abort();
          hostCloseInitiated = true;
          client.close(1011, "LC4 xAI manual transport protocol failure");
          unsubscribeEvent();
          unsubscribeWire?.();
          this.#active = false;
          throw new Error("LC4 xAI manual transport failure forbids a rotation receipt");
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
          rotation_conversation_replay_sha256: rotationContext.conversation_replay_sha256,
          conversation_history_hydration: historyHydrationEvidence,
        });
        const receipt = sha256Hex(`${SEGMENT_FINALIZATION_DOMAIN}${canonicalJson(body)}`);
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
  const bridge = new Lc4RealtimeProviderBridge((provider, configuration, transportProfile) => (
    createProductionRealtimeClient(provider, configuration, input.credentials[provider], (
      provider === "xai"
        ? { xaiTurnBoundary: transportProfile!.transport_mode }
        : {}
    ))
  ), SYSTEM_REALTIME_AUDIO_DELIVERY_RUNTIME);
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
  return createLc4ProviderExecutionProfile(episode.provider);
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

export function createLc4DevSessionConfiguration(
  episode: Lc4DevLiveEpisodePlan,
  preflightSha256: string,
): TrialSessionConfiguration {
  const profile = devProfile(episode);
  const conditionId = episode.arm === "native" ? "raw-full" : "host-managed-harness";
  const base = LC4_DEV_ARM_COMMON_NATURAL_TASK_CONTEXT;
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
  conversation_turns: Lc4NativeConversationTurnInput[];
  next_segment: 1 | 2 | 3;
};

/**
 * Pure, provider-free reconnect compiler. Its only semantic input is the
 * chronological conversation that actually crossed the provider boundary.
 * HACC adds its structured state hashes; Native never receives them.
 */
export function createLc4DevRotationContext(input: Readonly<{
  episode: Lc4DevLiveEpisodePlan;
  segment_ordinal: 2 | 3;
  previous_rotation_receipt_sha256: string;
  flow_state_sha256: string;
  response_plan_chain_head_sha256: string;
  conversation_turns: readonly Lc4NativeConversationTurnInput[];
}>): Lc4RotationContext {
  const boundary = ((input.segment_ordinal - 1) * 20) as 20 | 40;
  const conversationTurns = input.conversation_turns.filter(
    (turn) => turn.available_after_opportunity <= boundary,
  );
  const native = createLc4NativeConversationReplayPacket({
    run_id: input.episode.episode_id,
    from_segment_ordinal: (input.segment_ordinal - 1) as 1 | 2,
    to_segment_ordinal: input.segment_ordinal,
    available_through_opportunity: boundary,
    previous_session_rotation_receipt_sha256: input.previous_rotation_receipt_sha256,
    conversation_turns: conversationTurns,
  });
  const hacc = createLc4HaccRotationStatePacket({
    run_id: input.episode.episode_id,
    from_segment_ordinal: (input.segment_ordinal - 1) as 1 | 2,
    to_segment_ordinal: input.segment_ordinal,
    available_through_opportunity: boundary,
    previous_session_rotation_receipt_sha256: input.previous_rotation_receipt_sha256,
    flow_state_sha256: input.flow_state_sha256,
    response_plan_chain_head_sha256: input.response_plan_chain_head_sha256,
    conversation_turns: conversationTurns,
  });
  assertLc4RotationConversationParity(native, hacc);
  return input.episode.arm === "native"
    ? Object.freeze({ kind: "native_conversation_replay" as const, packet: native })
    : Object.freeze({ kind: "hacc_structured_state" as const, packet: hacc });
}

/**
 * The only paid-capable LC4-DEV adapter. It is bound to one expiring preflight,
 * one <=$15 six-episode plan, and credential identities. The frozen
 * confirmatory factory above is deliberately untouched.
 */
export function createLc4DevelopmentRealtimeAdapter(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  preflight: Lc4DevLivePreflightArtifact;
  credentials: Readonly<Record<LiveStsProvider, string>>;
  caller_branch_authority: Readonly<{
    matrix: Lc4DevCallerBranchMatrixArtifact;
    trust: Readonly<{ key_id: string; public_key_pem: string }>;
  }>;
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
  assertLc4DevCallerBranchMatrixArtifact(
    input.caller_branch_authority.matrix,
    input.caller_branch_authority.trust,
  );
  if (input.caller_branch_authority.matrix.audio_manifest_sha256 !== input.prepare.audio_manifest_sha256
    || input.caller_branch_authority.matrix.signer_public_key_fingerprint_sha256 !== input.preflight.authority_trust_root_sha256) {
    throw new Error("LC4-DEV caller branch authority differs from the prepared audio or preflight trust root");
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
          bridge: new Lc4RealtimeProviderBridge((provider, configuration, transportProfile) => (
            createProductionRealtimeClient(
              provider,
              configuration,
              input.credentials[provider],
              provider === "xai"
                ? { xaiTurnBoundary: transportProfile!.transport_mode }
                : {},
            )
          ), SYSTEM_REALTIME_AUDIO_DELIVERY_RUNTIME),
          previous_rotation_receipt_sha256: null,
          flow_state_sha256: sha256Hex(`lc4-dev-flow-genesis\n${input.preflight.preflight_sha256}\n${episode.episode_id}`),
          response_plan_chain_head_sha256: sha256Hex(`lc4-dev-plan-genesis\n${input.preflight.preflight_sha256}\n${episode.episode_id}`),
          conversation_turns: [],
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
      if (segment_ordinal === 2 || segment_ordinal === 3) {
        rotationContext = createLc4DevRotationContext({
          episode,
          segment_ordinal,
          previous_rotation_receipt_sha256: runtime.previous_rotation_receipt_sha256!,
          flow_state_sha256: runtime.flow_state_sha256,
          response_plan_chain_head_sha256: runtime.response_plan_chain_head_sha256,
          conversation_turns: runtime.conversation_turns,
        });
      }
      const manifest = devManifest(input.prepare, episode);
      let activeCanonicalOpportunity: Lc4PublicDevOpportunity | null = null;
      const bridgeSession = await runtime.bridge.openSegment({
        manifest,
        segment: devSegment(segment_ordinal),
        profile: manifest.episode_shape.provider_profile,
        configuration: createLc4DevSessionConfiguration(episode, input.preflight.preflight_sha256),
        rotation_context: rotationContext,
        listener: {
          accept: async (handoff) => {
            const opportunity = activeCanonicalOpportunity;
            if (!opportunity || opportunity.id !== handoff.capture.opportunity_id) {
              throw new Error("LC4-DEV listener handoff is not bound to the active projected opportunity");
            }
            const receipt = await input.listener.accept({ episode, opportunity, ...handoff });
            if (!SHA256.test(receipt.listener_evidence_sha256)) throw new Error("LC4-DEV listener sink returned an invalid evidence hash");
            return receipt;
          },
        },
        dev_gateway: {
          episode,
          opportunities: corpus.opportunities,
          executor: input.gateway_executor,
          caller_branch_authority: input.caller_branch_authority,
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
        caller_branch_binding?: Lc4DevCallerBranchPlaybackBinding;
      }>) => {
        input.budget_authority.assertOperationWindow(50_000);
        if (closed) throw new Error("LC4-DEV adapter session is closed");
        if (exchangeInput.playback_kind === "canonical") {
          if (pendingOpportunity !== null) throw new Error("LC4-DEV prior canonical opportunity is not finalized");
          const branchBinding = exchangeInput.caller_branch_binding;
          const isBranchOpportunity = exchangeInput.opportunity.id === LC4_DEV_BRANCH_OPPORTUNITY_ID;
          if (isBranchOpportunity !== (branchBinding !== undefined)) {
            throw new Error("LC4-DEV canonical branch opportunity requires exactly one signed playback authority");
          }
          if (branchBinding) {
            assertLc4DevCallerBranchDecision({
              decision: branchBinding.decision,
              matrix: input.caller_branch_authority.matrix,
              trust: input.caller_branch_authority.trust,
            });
            if (branchBinding.decision_evidence.kind !== "caller_branch_decision"
              || branchBinding.decision_evidence.evidence_sha256 !== branchBinding.decision.decision_sha256
              || branchBinding.decision.episode_id !== episode.episode_id
              || branchBinding.decision.provider !== episode.provider
              || canonicalJson(exchangeInput.opportunity) !== canonicalJson(
                lc4DevBranchedOpportunity(corpus.opportunities[41]!, branchBinding.decision),
              )
              || branchBinding.decision.pcm_sha256 !== sha256Hex(exchangeInput.caller_pcm)
              || branchBinding.decision.pcm_byte_length !== exchangeInput.caller_pcm.byteLength
              || branchBinding.decision.sample_rate_hz !== devProfile(episode).input_sample_rate_hz) {
              throw new Error("LC4-DEV canonical branch playback differs from its signed retained decision");
            }
            await input.evidence.assertResolvable(branchBinding.decision_evidence);
          }
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
          activeCanonicalOpportunity = exchangeInput.opportunity;
          evidence = await bridgeSession.exchange({
            opportunity_id: exchangeInput.opportunity.id,
            caller_pcm: exchangeInput.caller_pcm,
            response_control: exchangeInput.control_receipt.response_control,
            playback_kind: exchangeInput.playback_kind,
            ...(exchangeInput.caller_branch_binding ? { caller_branch_binding: exchangeInput.caller_branch_binding } : {}),
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
        } finally {
          activeCanonicalOpportunity = null;
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
        const assistantTranscript = evidence.dev_assistant_conversation_transcript ?? "";
        const assistantTranscriptSource = evidence.dev_assistant_conversation_transcript_source;
        if (!assistantTranscript
          || evidence.assistant_conversation_transcript_sha256 !== sha256Hex(assistantTranscript)
          || (assistantTranscriptSource !== "listener_exact_captured_pcm_asr"
            && assistantTranscriptSource !== "provider_native_output_transcript")) {
          throw new Error("LC4-DEV raw conversation replay lacks its hash-bound assistant transcript");
        }
        const callerText = exchangeInput.playback_kind === "canonical"
          ? exchangeInput.opportunity.canonical_caller_text
          : corpus.repair_policy.library.find(
              (repair) => repair.id === exchangeInput.repair_binding?.repair_pcm_id,
            )?.canonical_caller_text;
        if (!callerText) throw new Error("LC4-DEV raw conversation replay lacks its exact spoken caller source text");
        const appendConversationTurn = (
          turn: Readonly<
            | {
                speaker: "caller";
                source: "caller_tts_source_bound_to_pcm";
                text: string;
                provenance_receipt_sha256: string;
              }
            | {
                speaker: "assistant";
                source: Lc4AssistantConversationTranscriptSource;
                text: string;
                provenance_receipt_sha256: string;
              }
              | {
                speaker: "tool";
                source: "canonical_gateway_result";
                tool_name: string;
                tool_arguments: Readonly<Record<string, JsonValue>>;
                text: string;
                provenance_receipt_sha256: string;
                tool_batch_sha256?: string;
                tool_batch_call_ordinal?: number;
                tool_batch_call_count?: number;
              }
          >,
        ) => {
          const sequence = runtime!.conversation_turns.length + 1;
          runtime!.conversation_turns.push(Object.freeze({
            turn_id: `conversation.${String(sequence).padStart(3, "0")}.${turn.speaker}`,
            sequence,
            ...turn,
            available_after_opportunity: exchangeInput.opportunity.index,
            provider_conversation_source: true as const,
            oracle_derived: false as const,
            future_derived: false as const,
            semantic_evaluator_derived: false as const,
          }) as Lc4NativeConversationTurnInput);
        };
        appendConversationTurn({
          speaker: "caller",
          source: "caller_tts_source_bound_to_pcm",
          text: callerText,
          provenance_receipt_sha256: sha256Hex(exchangeInput.caller_pcm),
        });
        for (const batch of evidence.dev_gateway_conversation_tool_batches ?? []) {
          const batchSha256 = sha256Hex(
            `${ROTATION_TOOL_BATCH_DOMAIN}${canonicalJson(batch as unknown as JsonValue)}`,
          );
          for (const call of batch.calls) {
            appendConversationTurn({
              speaker: "tool",
              source: "canonical_gateway_result",
              tool_name: call.gateway_tool_name,
              tool_arguments: call.model_arguments,
              text: call.provider_output_canonical_json,
              provenance_receipt_sha256: call.source_sha256,
              tool_batch_sha256: batchSha256,
              tool_batch_call_ordinal: call.call_ordinal,
              tool_batch_call_count: batch.calls.length,
            });
          }
        }
        appendConversationTurn({
          speaker: "assistant",
          source: assistantTranscriptSource,
          text: assistantTranscript,
          provenance_receipt_sha256: evidence.output_capture.generated_pcm_sha256,
        });
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
        exchangeCanonical: ({ opportunity, caller_pcm, control_receipt, caller_branch_binding }) => exchangePlayback({
          opportunity,
          caller_pcm,
          control_receipt,
          playback_kind: "canonical",
          ...(caller_branch_binding ? { caller_branch_binding } : {}),
        }),
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

const LC4_XAI_GATE_D_INITIAL_CONTROL = [
  "This is a harmless transport qualification, not a user conversation and not an efficacy test.",
  "First speak one short audible sentence confirming the transport probe started.",
  "Then call capability_gateway exactly once with tool_name transport.probe and an empty arguments object.",
  "After the authoritative tool result arrives, speak one short audible sentence confirming completion.",
  "Do not call any other tool and do not claim any real-world action.",
].join(" ");
const LC4_XAI_GATE_D_CONTINUATION_CONTROL = [
  "The authoritative harmless transport-probe receipt has been returned.",
  "Speak one short audible completion sentence. Do not call another tool.",
].join(" ");
const LC4_XAI_GATE_D_TOOL_RESULT = Object.freeze({
  ok: true as const,
  tool_name: "transport.probe" as const,
  authority: "local_capability_gateway_transport_probe" as const,
  side_effects: false as const,
});
const LC4_XAI_GATE_D_RESULT_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-tool-result/v1\n";
const LC4_XAI_GATE_D_CONTINUATION_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-continuation/v1\n";

function lc4XaiGateDConfiguration(
  plan: Lc4XaiFiniteManualGateDPlanArtifact,
): TrialSessionConfiguration {
  const profile = LC4_PROVIDER_PROFILE_MANIFEST.providers.xai;
  const delivery = LC4_DEV_AUDIO_DELIVERY_PROFILE;
  return Object.freeze({
    provider: "xai" as const,
    model: profile.model,
    conditionId: "host-managed-harness" as const,
    instructions: LC4_XAI_GATE_D_INITIAL_CONTROL,
    initialPrompt: LC4_XAI_GATE_D_INITIAL_CONTROL,
    renderedCapabilitySnapshot: "<gate_d capability=\"transport.probe\" />",
    providerTools: Object.freeze([LOCAL_TOOL_PROXY_FUNCTION]),
    conditionHash: sha256Hex(canonicalJson({
      gate_version: plan.body.gate_version,
      plan_sha256: plan.body.plan_sha256,
      initial_control_sha256: sha256Hex(LC4_XAI_GATE_D_INITIAL_CONTROL),
      continuation_control_sha256:
        sha256Hex(LC4_XAI_GATE_D_CONTINUATION_CONTROL),
      tool_result_sha256: sha256Hex(
        `${LC4_XAI_GATE_D_RESULT_DOMAIN}${canonicalJson(LC4_XAI_GATE_D_TOOL_RESULT)}`,
      ),
    })),
    inputAudioFormat: Object.freeze({
      encoding: "pcm16" as const,
      sampleRateHz: profile.input_sample_rate_hz,
      channels: 1 as const,
    }),
    audioDeliveryProfile: delivery,
    audioDeliveryProfileHash: trialAudioDeliveryProfileHash(delivery),
  });
}

function lc4GateDObservedAttribution(
  attribution: RealtimeWireObservationAttribution | undefined,
  observations: readonly Lc4SanitizedWireObservation[],
  expected: Readonly<{
    direction: "inbound" | "outbound";
    wire_type: string | readonly string[];
    label: string;
  }>,
): Lc4SanitizedWireObservation {
  const reference = observedWireReference(attribution, expected.label);
  const matches = observations.filter((observation) => (
    observation.observation_sha256 === reference.observationSha256
  ));
  if (matches.length !== 1
    || matches[0]!.provider !== "xai"
    || matches[0]!.direction !== expected.direction
    || !(Array.isArray(expected.wire_type)
      ? expected.wire_type.some((wireType) => (
          matches[0]!.wire_type === wireType
        ))
      : matches[0]!.wire_type === expected.wire_type)
    || matches[0]!.connection_epoch !== reference.connectionEpoch
    || matches[0]!.sequence !== reference.sequence) {
    throw new Error(`Gate D ${expected.label} lacks one role-correct wire observation`);
  }
  return matches[0]!;
}

function lc4GateDExactlyOneWire(
  observations: readonly Lc4SanitizedWireObservation[],
  start: number,
  direction: "inbound" | "outbound",
  wireType: string,
  label: string,
): Lc4SanitizedWireObservation {
  const matches = observations.slice(start).filter((observation) => (
    observation.provider === "xai"
    && observation.direction === direction
    && observation.wire_type === wireType
  ));
  if (matches.length !== 1) {
    throw new Error(`Gate D ${label} must produce exactly one wire observation`);
  }
  return matches[0]!;
}

function lc4GateDConcatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

type Lc4XaiGateDClientFactory = (
  configuration: TrialSessionConfiguration,
  apiKey: string,
) => NormalizedRealtimeClient;

async function executeLc4XaiGateDWithClientFactory(input: Readonly<{
  caller_pcm: Uint8Array;
  plan: Lc4XaiFiniteManualGateDPlanArtifact;
  authorization: Lc4XaiFiniteManualGateDAuthorizationArtifact;
  api_key: string;
  client_factory: Lc4XaiGateDClientFactory;
}>): Promise<Lc4XaiFiniteManualGateDExecutionEvidence> {
  if (typeof input.api_key !== "string"
    || input.api_key.length < 12
    || input.api_key !== input.api_key.trim()
    || /[\u0000-\u001f\u007f]/u.test(input.api_key)) {
    throw new Error("Gate D xAI executor credential is absent or malformed");
  }
  if (input.plan.body.production_adapter_binding_sha256
      !== LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256
    || input.authorization.body.production_adapter_binding_sha256
      !== LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256) {
    throw new Error("Gate D artifacts differ from the frozen production adapter binding");
  }
  const callerPcm = Uint8Array.from(input.caller_pcm);
  const configuration = lc4XaiGateDConfiguration(input.plan);
  const client = input.client_factory(configuration, input.api_key);
  if (client.provider !== "xai"
    || typeof client.waitForInputAudioCommit !== "function"
    || typeof client.prepareToolContinuation !== "function"
    || typeof client.onWireObservation !== "function") {
    throw new Error("Gate D production client lacks the required xAI manual transport surface");
  }

  const wire: Lc4SanitizedWireObservation[] = [];
  const initialPcm: Uint8Array[] = [];
  const postToolPcm: Uint8Array[] = [];
  let rootResponseId: string | null = null;
  let postToolResponseId: string | null = null;
  let rootResponseStart: Lc4SanitizedWireObservation | null = null;
  let postToolResponseStart: Lc4SanitizedWireObservation | null = null;
  let initialPcmObservation: Lc4SanitizedWireObservation | null = null;
  let postToolPcmObservation: Lc4SanitizedWireObservation | null = null;
  let toolCallObservation: Lc4SanitizedWireObservation | null = null;
  let toolResultObservation: Lc4SanitizedWireObservation | null = null;
  let continuationObservation: Lc4SanitizedWireObservation | null = null;
  let terminalObservation: Lc4SanitizedWireObservation | null = null;
  let capabilityGatewayToolCallSha256: string | null = null;
  let capabilityGatewayCallIdSha256: string | null = null;
  let capabilityGatewayToolResultSha256: string | null = null;
  let postToolContinuationSha256: string | null = null;
  let postToolContinuationOriginResponseIdSha256: string | null = null;
  let postToolResponseIdSha256: string | null = null;
  let toolResultSubmissionEvents = 0;
  let continuationRequests = 0;
  let toolRoundtrips = 0;
  let fatal: Error | null = null;
  let settle!: () => void;
  const completed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const fail = (message: string) => {
    fatal ??= new Error(message);
    settle();
  };
  const unsubscribeWire = client.onWireObservation((observation) => {
    wire.push(sanitizeWireObservation(observation));
  });
  const unsubscribeEvent = client.onEvent((event) => {
    try {
      // Manual-mode xAI speech activity is non-authoritative telemetry. The
      // signed replay validates it as an optional complete pair and still
      // requires explicit commit/ack/create/start causality.
      if (event.type === "response.started") {
        const observation = lc4GateDObservedAttribution(
          event.wireObservation,
          wire,
          {
            direction: "inbound",
            wire_type: "response.created",
            label: "response start",
          },
        );
        if (rootResponseId === null) {
          rootResponseId = event.responseId;
          rootResponseStart = observation;
        } else if (postToolResponseId === null) {
          if (toolRoundtrips !== 1 || continuationRequests !== 1) {
            fail("Gate D post-tool response started before its exact continuation request");
            return;
          }
          if (event.responseId === rootResponseId) {
            fail("Gate D post-tool response reused the initial response identity");
            return;
          }
          postToolResponseId = event.responseId;
          postToolResponseIdSha256 =
            lc4XaiManualResponseWireIdentitySha256(event.responseId);
          if (observation.identity_hashes.responseIdSha256
            !== postToolResponseIdSha256) {
            fail("Gate D post-tool response start has a foreign response identity");
            return;
          }
          postToolResponseStart = observation;
        } else {
          fail("Gate D observed more than two generation phases");
        }
        return;
      }
      if (event.type === "output.audio") {
        const observation = lc4GateDObservedAttribution(
          event.wireObservation,
          wire,
          {
            direction: "inbound",
            wire_type:
              LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE
                .assistant_audio_delta_wire_types,
            label: "assistant PCM",
          },
        );
        if (event.format.encoding !== "pcm16"
          || event.format.sampleRateHz
            !== LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.output_sample_rate_hz
          || event.format.channels !== 1) {
          fail("Gate D assistant PCM differs from the frozen provider profile");
          return;
        }
        if (event.responseId === rootResponseId && postToolResponseId === null) {
          initialPcm.push(Uint8Array.from(event.audio));
          initialPcmObservation ??= observation;
        } else if (event.responseId === postToolResponseId) {
          postToolPcm.push(Uint8Array.from(event.audio));
          postToolPcmObservation ??= observation;
        } else {
          fail("Gate D assistant PCM has an unbound response identity");
        }
        return;
      }
      if (event.type === "tool.dispatch") {
        if (toolRoundtrips !== 0
          || event.dispatches.length !== 1
          || event.responseId !== rootResponseId
          || initialPcm.length === 0) {
          fail("Gate D requires one tool call after audible initial PCM");
          return;
        }
        const dispatch = event.dispatches[0]!;
        const expectedArguments = {
          tool_name: "transport.probe",
          arguments: {},
        };
        const expectedProvenance = Object.freeze({
          schemaVersion: 1 as const,
          provider: "xai" as const,
          nativeCallId: dispatch.callId,
          nativeResponseId: event.responseId,
          terminalWireType: event.wireType,
          ...(dispatch.provenance.nativeItemId === undefined
            ? {}
            : { nativeItemId: dispatch.provenance.nativeItemId }),
          ...(dispatch.provenance.terminalEventId === undefined
            ? {}
            : { terminalEventId: dispatch.provenance.terminalEventId }),
        });
        if (event.gateway !== "capability_gateway"
          || dispatch.request.method !== "tools/call"
          || dispatch.request.params.name !== "transport.probe"
          || canonicalJson(dispatch.request.params.arguments)
            !== canonicalJson(expectedArguments.arguments)
          || dispatch.request.params._meta[LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]
            !== dispatch.callId
          || canonicalJson(
            dispatch.request.params._meta[PROVIDER_PROVENANCE_META_KEY],
          ) !== canonicalJson(expectedProvenance)
          || canonicalJson(dispatch.provenance)
            !== canonicalJson(expectedProvenance)) {
          fail("Gate D provider requested a tool outside the harmless closed probe");
          return;
        }
        toolCallObservation = lc4GateDObservedAttribution(
          event.wireObservation,
          wire,
          {
            direction: "inbound",
            wire_type: "response.done",
            label: "capability-gateway executable call batch",
          },
        );
        const rootResponseIdSha256 =
          lc4XaiManualResponseWireIdentitySha256(event.responseId);
        capabilityGatewayCallIdSha256 =
          realtimeWireIdentitySha256("call", dispatch.callId);
        if (toolCallObservation.identity_hashes.responseIdSha256
              !== rootResponseIdSha256
          || toolCallObservation.identity_hashes.callIdSha256
              !== capabilityGatewayCallIdSha256) {
          fail("Gate D capability-gateway call has foreign wire identities");
          return;
        }
        capabilityGatewayToolCallSha256 = sha256Hex(canonicalJson({
          name: event.gateway,
          arguments: expectedArguments,
          response_id_sha256: rootResponseIdSha256,
          call_id_sha256: capabilityGatewayCallIdSha256,
        }));
        capabilityGatewayToolResultSha256 = sha256Hex(
          `${LC4_XAI_GATE_D_RESULT_DOMAIN}${canonicalJson({
            result: LC4_XAI_GATE_D_TOOL_RESULT,
            origin_response_id_sha256: rootResponseIdSha256,
            call_id_sha256: capabilityGatewayCallIdSha256,
          })}`,
        );
        postToolContinuationSha256 = sha256Hex(
          `${LC4_XAI_GATE_D_CONTINUATION_DOMAIN}${canonicalJson({
            additional_instructions_sha256:
              sha256Hex(LC4_XAI_GATE_D_CONTINUATION_CONTROL),
            tool_result_sha256: capabilityGatewayToolResultSha256,
            origin_response_id_sha256: rootResponseIdSha256,
            call_id_sha256: capabilityGatewayCallIdSha256,
          })}`,
        );
        client.prepareToolContinuation!({
          additionalInstructions: LC4_XAI_GATE_D_CONTINUATION_CONTROL,
          contextSha256: sha256Hex(LC4_XAI_GATE_D_CONTINUATION_CONTROL),
          contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
        });
        const resultFloor = wire.length;
        client.submitToolResults([{
          callId: dispatch.callId,
          output: LC4_XAI_GATE_D_TOOL_RESULT,
        }], false);
        toolResultObservation = lc4GateDExactlyOneWire(
          wire,
          resultFloor,
          "outbound",
          "conversation.item.create",
          "capability-gateway tool result",
        );
        if (toolResultSubmissionEvents !== 1
          || toolResultObservation.identity_hashes.callIdSha256
            !== capabilityGatewayCallIdSha256) {
          fail("Gate D capability-gateway result has a foreign call identity");
          return;
        }
        toolRoundtrips = 1;
        const continuationFloor = wire.length;
        client.createResponse();
        continuationObservation = lc4GateDExactlyOneWire(
          wire,
          continuationFloor,
          "outbound",
          "response.create",
          "post-tool continuation",
        );
        return;
      }
      if (event.type === "tool.continuation.requested") {
        if (toolRoundtrips !== 1
          || continuationRequests !== 0
          || rootResponseId === null
          || event.originResponseId !== rootResponseId
          || event.responseIdSource !== "provider"
          || event.wireType !== "response.create") {
          fail("Gate D continuation request has a foreign root response identity");
          return;
        }
        continuationRequests = 1;
        postToolContinuationOriginResponseIdSha256 =
          lc4XaiManualResponseWireIdentitySha256(event.originResponseId);
        return;
      }
      if (event.type === "tool.results.submitted") {
        if (toolResultSubmissionEvents !== 0
          || capabilityGatewayCallIdSha256 === null
          || rootResponseId === null
          || event.responseId !== rootResponseId
          || event.responseIdSource !== "provider"
          || event.callIds.length !== 1
          || realtimeWireIdentitySha256("call", event.callIds[0]!)
            !== capabilityGatewayCallIdSha256
          || event.continuationRequested) {
          fail("Gate D tool-result submission has foreign call or response authority");
          return;
        }
        toolResultSubmissionEvents = 1;
        return;
      }
      if (event.type === "response.completed") {
        if (event.status !== "completed") {
          fail("Gate D provider response did not complete");
          return;
        }
        if (postToolResponseId !== null
          && event.responseId !== rootResponseId
          && event.responseId !== postToolResponseId) {
          fail("Gate D terminal event has an unbound response identity");
          return;
        }
        if (postToolResponseId !== null
          && event.responseId === postToolResponseId) {
          terminalObservation = lc4GateDObservedAttribution(
            event.wireObservation,
            wire,
            {
              direction: "inbound",
              wire_type: "response.done",
              label: "terminal response",
            },
          );
          if (terminalObservation.identity_hashes.responseIdSha256
            !== postToolResponseIdSha256) {
            fail("Gate D terminal observation has a foreign response identity");
            return;
          }
          settle();
        }
        return;
      }
      if (event.type === "error" && event.fatal) {
        fail("Gate D provider emitted a fatal transport error");
      } else if (event.type === "connection.closed") {
        fail("Gate D provider connection closed before the terminal response");
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : "Gate D event validation failed");
    }
  });

  let timeout: ReturnType<typeof setTimeout> | null = null;
  let commit: Lc4SanitizedWireObservation | null = null;
  let commitAck: Lc4SanitizedWireObservation | null = null;
  let responseCreate: Lc4SanitizedWireObservation | null = null;
  try {
    await client.connect();
    if (client.state !== "ready") {
      throw new Error("Gate D xAI session did not remain ready");
    }
    client.appendInputAudio({
      encoding: "pcm16",
      sampleRateHz:
        LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.input_sample_rate_hz,
      channels: 1,
      data: callerPcm,
    });
    client.prepareResponse({
      additionalInstructions: LC4_XAI_GATE_D_INITIAL_CONTROL,
      contextSha256: sha256Hex(LC4_XAI_GATE_D_INITIAL_CONTROL),
      contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
    });
    const commitFloor = wire.length;
    client.commitInputAudio();
    commit = lc4GateDExactlyOneWire(
      wire,
      commitFloor,
      "outbound",
      "input_audio_buffer.commit",
      "manual commit",
    );
    const acknowledgement = await client.waitForInputAudioCommit(5_000);
    commitAck = lc4GateDObservedAttribution(
      acknowledgement.wireObservation,
      wire,
      {
        direction: "inbound",
        wire_type: "input_audio_buffer.committed",
        label: "manual commit acknowledgement",
      },
    );
    if (acknowledgement.provider !== "xai"
      || acknowledgement.status !== "acknowledged"
      || acknowledgement.connectionEpoch !== commit.connection_epoch
      || acknowledgement.commitOrdinal !== 1
      || commitAck.sequence <= commit.sequence) {
      throw new Error("Gate D manual commit acknowledgement is foreign or duplicated");
    }
    assertLc4XaiManualSpeechActivityTelemetry(wire, {
      connection_epoch: commitAck.connection_epoch,
      commit_ack_sequence: commitAck.sequence,
    });
    const responseCreateFloor = wire.length;
    client.createResponse();
    responseCreate = lc4GateDExactlyOneWire(
      wire,
      responseCreateFloor,
      "outbound",
      "response.create",
      "initial response request",
    );
    timeout = setTimeout(() => {
      fail("Gate D provider response timed out");
    }, 45_000);
    await completed;
    if (fatal) throw fatal;
    if (toolRoundtrips !== 1
      || rootResponseId === null
      || postToolResponseId === null
      || rootResponseStart === null
      || postToolResponseStart === null
      || initialPcmObservation === null
      || postToolPcmObservation === null
      || toolCallObservation === null
      || toolResultObservation === null
      || continuationObservation === null
      || terminalObservation === null
      || capabilityGatewayToolCallSha256 === null
      || capabilityGatewayCallIdSha256 === null
      || capabilityGatewayToolResultSha256 === null
      || postToolContinuationSha256 === null
      || postToolContinuationOriginResponseIdSha256 === null
      || postToolResponseIdSha256 === null
      || toolResultSubmissionEvents !== 1
      || continuationRequests !== 1) {
      throw new Error("Gate D did not produce the complete two-phase tool roundtrip");
    }
    const initial = lc4GateDConcatenate(initialPcm);
    const postTool = lc4GateDConcatenate(postToolPcm);
    if (initial.byteLength < 2 || postTool.byteLength < 2) {
      throw new Error("Gate D did not produce audible PCM in both generation phases");
    }
    // Event listeners advance this FSM while the awaited completion promise is
    // pending; capture the validated terminal snapshot for TypeScript and for
    // the evidence assembly below.
    const rootStart =
      rootResponseStart as Lc4SanitizedWireObservation;
    const postStart =
      postToolResponseStart as Lc4SanitizedWireObservation;
    const initialAudio =
      initialPcmObservation as Lc4SanitizedWireObservation;
    const postAudio =
      postToolPcmObservation as Lc4SanitizedWireObservation;
    const gatewayCall =
      toolCallObservation as Lc4SanitizedWireObservation;
    const gatewayResult =
      toolResultObservation as Lc4SanitizedWireObservation;
    const continuation =
      continuationObservation as Lc4SanitizedWireObservation;
    const terminal =
      terminalObservation as Lc4SanitizedWireObservation;
    const rootResponseIdSha256 =
      lc4XaiManualResponseWireIdentitySha256(rootResponseId);
    if (rootStart.identity_hashes.responseIdSha256 !== rootResponseIdSha256
      || initialAudio.identity_hashes.responseIdSha256
        !== rootResponseIdSha256
      || gatewayCall.identity_hashes.responseIdSha256
        !== rootResponseIdSha256
      || gatewayCall.identity_hashes.callIdSha256
        !== capabilityGatewayCallIdSha256
      || gatewayResult.identity_hashes.callIdSha256
        !== capabilityGatewayCallIdSha256
      || postToolContinuationOriginResponseIdSha256
        !== rootResponseIdSha256
      || postToolResponseIdSha256 === rootResponseIdSha256
      || postStart.identity_hashes.responseIdSha256
        !== postToolResponseIdSha256
      || postAudio.identity_hashes.responseIdSha256
        !== postToolResponseIdSha256
      || terminal.identity_hashes.responseIdSha256
        !== postToolResponseIdSha256) {
      throw new Error(
        "Gate D response, tool-call, result, continuation, and terminal identities are not continuous",
      );
    }
    const manualTurnCausality = createLc4XaiManualTurnCausality({
      schema_version: 1,
      connection_epoch: commit.connection_epoch,
      commit_observation_sha256: commit.observation_sha256,
      commit_sequence: commit.sequence,
      commit_ack_observation_sha256: commitAck.observation_sha256,
      commit_ack_sequence: commitAck.sequence,
      response_create_observation_sha256: responseCreate.observation_sha256,
      response_create_sequence: responseCreate.sequence,
      response_start_observation_sha256: rootStart.observation_sha256,
      response_start_sequence: rootStart.sequence,
      response_id_sha256: rootResponseIdSha256,
    }, wire);
    const withoutReplay = Object.freeze({
      schema_version: 2 as const,
      provider: "xai" as const,
      model: input.plan.body.model,
      voice: input.plan.body.voice,
      transport_purpose: "finite_prerecorded_efficacy" as const,
      transport_mode: "manual_commit" as const,
      transport_profile_sha256: input.plan.body.transport_profile_sha256,
      production_adapter_binding_sha256:
        LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
      caller_pcm_sha256: sha256Hex(callerPcm),
      caller_pcm_byte_length: callerPcm.byteLength,
      caller_pcm_appended_sha256: sha256Hex(callerPcm),
      caller_pcm_appended_byte_length: callerPcm.byteLength,
      provider_sessions_opened: 1 as const,
      generation_phases: 2 as const,
      capability_gateway_tool_roundtrips: 1 as const,
      retries: 0 as const,
      reconnects: 0 as const,
      fallbacks: 0 as const,
      operation_order: LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER,
      manual_turn_causality: manualTurnCausality,
      wire_observations: Object.freeze([...wire]),
      initial_assistant_pcm_sha256: sha256Hex(initial),
      initial_assistant_pcm_byte_length: initial.byteLength,
      initial_assistant_pcm_observation_sha256:
        initialAudio.observation_sha256,
      capability_gateway_tool_call_sha256:
        capabilityGatewayToolCallSha256,
      capability_gateway_call_id_sha256:
        capabilityGatewayCallIdSha256,
      capability_gateway_tool_call_observation_sha256:
        gatewayCall.observation_sha256,
      capability_gateway_tool_result_sha256:
        capabilityGatewayToolResultSha256,
      capability_gateway_tool_result_observation_sha256:
        gatewayResult.observation_sha256,
      post_tool_continuation_sha256: postToolContinuationSha256,
      post_tool_continuation_origin_response_id_sha256:
        postToolContinuationOriginResponseIdSha256,
      post_tool_continuation_observation_sha256:
        continuation.observation_sha256,
      post_tool_response_id_sha256: postToolResponseIdSha256,
      post_tool_response_start_observation_sha256:
        postStart.observation_sha256,
      post_tool_assistant_pcm_sha256: sha256Hex(postTool),
      post_tool_assistant_pcm_byte_length: postTool.byteLength,
      post_tool_assistant_pcm_observation_sha256:
        postAudio.observation_sha256,
      terminal_observation_sha256: terminal.observation_sha256,
    });
    const evidence = Object.freeze({
      ...withoutReplay,
      replay_sha256:
        lc4XaiFiniteManualGateDExecutionReplaySha256(withoutReplay),
    });
    assertLc4XaiFiniteManualGateDExecutionEvidence({
      evidence,
      plan: input.plan,
    });
    return evidence;
  } finally {
    if (timeout) clearTimeout(timeout);
    unsubscribeEvent();
    unsubscribeWire();
    client.close(1000, "LC4 Gate D complete");
  }
}

/**
 * The sole paid Gate D adapter. The API credential is accepted only in memory
 * by the operator and is never placed in a plan, authorization, terminal, or
 * receipt artifact.
 */
export function createLc4XaiFiniteManualGateDProductionAdapter(
  apiKey: string,
): Lc4XaiFiniteManualGateDProductionAdapter {
  return Object.freeze({
    [LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY]: true as const,
    kind: "lc4-production-provider-adapter/xai-finite-manual-gate-d-v1",
    production_adapter_binding_sha256:
      LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
    execute: (input) => executeLc4XaiGateDWithClientFactory({
      ...input,
      api_key: apiKey,
      client_factory: (configuration, credential) => (
        createProductionRealtimeClient(
          "xai",
          configuration,
          credential,
          { xaiTurnBoundary: "manual_commit" },
        )
      ),
    }),
  });
}

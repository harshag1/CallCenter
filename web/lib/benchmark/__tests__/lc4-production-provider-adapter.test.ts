import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentFlowSchema } from "../../flow";
import { createFlowExecutionState, type FlowExecutionState } from "../../flow-runtime";
import { canonicalJson, sha256Hex } from "../artifacts";
import { compileConditionSuite } from "../condition-compiler";
import { industrialFieldServiceCompilerInput } from "../industrial-field-service-source";
import {
  Lc4ProviderInputAudioDeliveryError,
  Lc4RealtimeProviderBridge,
  assertLc4RotationConversationParity,
  assertLc4XaiManualTurnCausality,
  assertLc4XaiManualTurnReplayProjection,
  createLc4FrozenProductionRealtimeAdapter,
  createLc4DevRotationContext,
  createLc4DevSessionConfiguration,
  createLc4HaccRotationStatePacket,
  createLc4NativeConversationReplayPacket,
  type Lc4NativeConversationTurnInput,
  type Lc4ListenerEvidenceHandoff,
  type Lc4RealtimeEpisodeManifest,
  type Lc4RotationContext,
  type Lc4NativeConversationReplayPacket,
  type Lc4XaiManualTurnCausalityEvidence,
} from "../lc4-production-provider-adapter";
import {
  LC4_DEV_SEMANTIC_GATEWAY_FUNCTION,
  type Lc4DevGatewayExecutor,
} from "../lc4-development-gateway-bridge";
import type { Lc4DevLiveEpisodePlan } from "../lc4-development-live-runner";
import { createLc4DevReplayEvidenceStore } from "../lc4-development-evidence-retention";
import {
  Lc4DevFailureEvidenceError,
  createLc4DevFailureEvidence,
} from "../lc4-development-failure-evidence";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";
import {
  LC4_DEV_BRANCH_OPPORTUNITY_ID,
  LC4_DEV_CALLER_BRANCH_DECISION_ARTIFACT_DOMAIN,
  LC4_DEV_CALLER_BRANCH_SOURCES,
  LC4_DEV_MUTATION_OPPORTUNITY_ID,
  LC4_DEV_PRIOR_MUTATION_OUTCOMES,
  assertLc4DevCallerBranchDecision,
  createLc4DevCallerBranchAuthority,
  createLc4DevCallerBranchMatrixArtifact,
  type Lc4DevCallerBranchAudioBinding,
  type Lc4DevCallerBranchDecision,
  type Lc4DevPriorMutationOutcome,
} from "../lc4-development-caller-branch";
import type { Lc4DevCallerBranchPlaybackBinding } from "../lc4-development-realtime-contract";
import { createLc4DevArmBlindRepairProjection } from "../lc4-development-headless-listener-authority";
import {
  compileLc4ProductionScheduleShape,
  createLc4ProviderExecutionProfile,
  createLc4EpisodeManifest,
  createLc4QualificationGateReceipt,
  type Lc4EpisodeManifest,
  type Lc4OpportunityBinding,
  type Lc4ProviderExecutionProfile,
} from "../lc4-production-runner-foundation";
import {
  advanceHaccSpeechGuardrailState,
  createHaccSpeechGuardrailPacket,
  createInitialHaccSpeechGuardrailState,
} from "../speech-guardrail-packet";
import { createHaccResponsePlan } from "../response-plan";
import { BenchmarkScenarioSchema, type JsonValue } from "../scenario-schema";
import scenarioJson from "../../../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";
import type { AdmissibilityFrontierEvidence } from "../admissibility-frontier";
import type { ProviderCapabilitySnapshot } from "../capability-gateway";
import type { TrialSessionConfiguration } from "../orchestrator";
import { trialAudioDeliveryProfileHash } from "../orchestrator";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  Pcm16Audio,
  RealtimeConversationHistoryHydrationAcknowledgement,
  RealtimeConversationHistoryTurn,
  RealtimeEventListener,
  RealtimeResponsePreparation,
  RealtimeToolResult,
  RealtimeWireObservation,
  RealtimeWireObservationListener,
} from "../../realtime/client/types";
import { realtimeWireIdentitySha256 } from "../../realtime/client/wire-evidence";
import {
  LC4_XAI_MANUAL_TURN_CAUSALITY_DOMAIN,
  lc4XaiManualResponseWireIdentitySha256,
} from "../lc4-xai-manual-turn-causality";
import {
  LC4_XAI_SERVER_VAD_SHA256,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256,
  LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
} from "../xai-server-vad";
import { XAI_SERVER_VAD_AUDIO_AFTER_STOP_ERROR } from "../../realtime/client/openai-compatible";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  LOCAL_TOOL_PROXY_FUNCTION,
  LOCAL_TOOL_PROXY_FUNCTION_NAME,
  PROVIDER_PROVENANCE_META_KEY,
  RealtimeDynamicControlLimitError,
} from "../../realtime/client/types";

const HASH = "a".repeat(64);
const AUTHORITY_PROJECTION_DOMAIN = "harshas-amazing-call-center/lc4-dev-gateway-authority-projection/v1\n";
const COMMIT = "b".repeat(40);
const ORACLE_SECRET = "ORACLE-PLAINTEXT-MUST-NOT-LEAK";
const FIXTURE_CONTINUATION_CONTROL =
  "<hacc_response_plan>{\"fixture\":\"current_control\"}</hacc_response_plan>";

function fixtureContinuationPreparation(): RealtimeResponsePreparation {
  return Object.freeze({
    additionalInstructions: FIXTURE_CONTINUATION_CONTROL,
    contextSha256: sha256Hex(FIXTURE_CONTINUATION_CONTROL),
    contextAuthority: "advisory_only_gateway_and_speech_gate_enforced" as const,
  });
}

function replayEvidenceFixture() {
  const objects = new Map<string, Uint8Array>();
  return createLc4DevReplayEvidenceStore({
    async put(bytes) {
      const retained = Uint8Array.from(bytes);
      const artifactSha256 = sha256Hex(retained);
      objects.set(artifactSha256, retained);
      return Object.freeze({
        artifact_sha256: artifactSha256,
        byte_length: retained.byteLength,
        receipt_sha256: sha256Hex(`fixture-cas:${artifactSha256}:${retained.byteLength}`),
      });
    },
    async get(artifactSha256) {
      const retained = objects.get(artifactSha256);
      if (retained === undefined) throw new Error(`fixture CAS object is missing: ${artifactSha256}`);
      return Uint8Array.from(retained);
    },
  });
}

function opportunities(): readonly Lc4OpportunityBinding[] {
  return Object.freeze(Array.from({ length: 60 }, (_, index) => {
    const pcm = new Uint8Array([index + 1, 7, 11, 13]);
    return Object.freeze({
      ordinal: index + 1,
      opportunity_id: `op-${String(index + 1).padStart(2, "0")}`,
      segment_ordinal: Math.ceil((index + 1) / 20) as 1 | 2 | 3,
      caller_pcm_sha256: sha256Hex(pcm),
      caller_pcm_byte_length: pcm.byteLength,
      opportunity_contract_sha256: sha256Hex(`contract-${index + 1}`),
    });
  }));
}

function manifest(
  arm: "native" | "hacc" = "hacc",
  provider: "openai" | "gemini" | "xai" = "openai",
): Lc4EpisodeManifest {
  const schedule = compileLc4ProductionScheduleShape();
  const episode = schedule.episode_shapes.find((candidate) => candidate.arm === arm && candidate.provider === provider)!;
  const reservation = {
    reservation_id: "reservation-1",
    run_id: episode.run_id,
    provider: episode.provider,
    model: episode.provider_profile.model,
    maximum_micro_usd: episode.maximum_reservation_micro_usd,
    status: "reserved" as const,
    ledger_head_sha256: "1".repeat(64),
  };
  return createLc4EpisodeManifest({
    schedule,
    run_id: episode.run_id,
    source_commit: COMMIT,
    source_tree_sha256: "2".repeat(64),
    preregistration_sha256: "3".repeat(64),
    heldout_commitment_sha256: "4".repeat(64),
    template_commitment_sha256: "5".repeat(64),
    opportunity_manifest_sha256: "6".repeat(64),
    caller_fixture_manifest_sha256: "7".repeat(64),
    condition_suite_sha256: "8".repeat(64),
    parity_manifest_sha256: "9".repeat(64),
    generator_schedule_join_sha256: "0".repeat(64),
    qualification: createLc4QualificationGateReceipt({
      plan_sha256: HASH,
      source_commit: COMMIT,
      configuration_matrix_sha256: "c".repeat(64),
      credential_set_sha256: "d".repeat(64),
      handshake: { status: "conditional", artifact_sha256: "e".repeat(64), completed_at: "2026-07-21T20:00:00.000Z" },
      response_tool_canary: {
        status: "passed",
        artifact_sha256: "f".repeat(64),
        completed_at: "2026-07-21T20:01:00.000Z",
        caller_audio_bytes: 0,
        providers_verified: ["openai", "gemini", "xai"],
      },
    }),
    budget_reservation: { ...reservation, reservation_sha256: sha256Hex(JSON.stringify(reservation)) },
    opportunities: opportunities(),
  });
}

const scenario = BenchmarkScenarioSchema.parse(scenarioJson);
const compilerInput = industrialFieldServiceCompilerInput(scenario);
const flow = AgentFlowSchema.parse(compilerInput.flow);
const condition = compileConditionSuite(compilerInput).conditions["host-managed-harness"];
const target = "step:field_service.verify_technician" as const;
const disclosure = condition.disclosures.find((item) => item.target === target)!;
const snapshot: ProviderCapabilitySnapshot = {
  gateway_version: 1,
  scope: target,
  capability_epoch: 7,
  actions: disclosure.visibleCapabilities.map((capability, index) => ({
    name: capability.name,
    description: capability.description,
    input_schema: capability.inputSchema as Record<string, JsonValue>,
    semantic_hash: capability.semanticHash,
    capability_grant: `test-grant-${index}`,
  })),
};

function responsePlan() {
  const state: FlowExecutionState = {
    ...createFlowExecutionState("2026-07-21T00:00:00.000Z"),
    status: "active",
    nodeId: "field_service",
    currentStep: "field_service.verify_technician",
    capabilityEpoch: 7,
    actionReceipts: [],
  };
  const initial = createInitialHaccSpeechGuardrailState();
  const first = createHaccSpeechGuardrailPacket(initial, null);
  const verified = advanceHaccSpeechGuardrailState(initial, { kind: "verification_succeeded", evidence_sha256: "d".repeat(64) });
  return createHaccResponsePlan({
    flow,
    state,
    conditionSha256: condition.conditionHash,
    target,
    catalogMode: "target",
    snapshot,
    frontierEvidence: { evidence_sha256: "a".repeat(64) } as AdmissibilityFrontierEvidence,
    quarantines: [],
    speechGuardrailPacket: createHaccSpeechGuardrailPacket(verified, first.packet_sha256),
    revision: 1,
    previousPlanSha256: null,
  });
}

function configuration(value: Lc4EpisodeManifest): TrialSessionConfiguration {
  const profile = value.episode_shape.provider_profile;
  const audioDeliveryProfile = Object.freeze({ schemaVersion: 1 as const, chunkMs: 20, pace: "realtime" as const });
  return Object.freeze({
    provider: profile.provider,
    model: profile.model,
    conditionId: value.episode_shape.arm === "native"
      ? "raw-full"
      : "host-managed-harness",
    instructions: `public base instructions ${ORACLE_SECRET}`,
    initialPrompt: `public base instructions ${ORACLE_SECRET}`,
    renderedCapabilitySnapshot: "<capability_snapshot />",
    providerTools: Object.freeze([LOCAL_TOOL_PROXY_FUNCTION]),
    conditionHash: condition.conditionHash,
    inputAudioFormat: Object.freeze({ encoding: "pcm16", sampleRateHz: profile.input_sample_rate_hz, channels: 1 }),
    audioDeliveryProfile,
    audioDeliveryProfileHash: trialAudioDeliveryProfileHash(audioDeliveryProfile),
  });
}

function bindFirstOpportunityPcm(value: Lc4EpisodeManifest, pcm: Uint8Array): Lc4EpisodeManifest {
  return Object.freeze({
    ...value,
    opportunities: Object.freeze(value.opportunities.map((opportunity, index) => index === 0
      ? Object.freeze({
          ...opportunity,
          caller_pcm_sha256: sha256Hex(pcm),
          caller_pcm_byte_length: pcm.byteLength,
        })
      : opportunity)),
  });
}

function forgeManifestProviderProfile(
  value: Lc4EpisodeManifest,
  providerProfile: Lc4ProviderExecutionProfile,
): Lc4EpisodeManifest {
  return Object.freeze({
    ...value,
    episode_shape: Object.freeze({
      ...value.episode_shape,
      provider_profile: providerProfile,
    }),
  });
}

function publicConversationTurns(
  availableThroughOpportunity: 20 | 40,
): readonly Lc4NativeConversationTurnInput[] {
  return Object.freeze(Array.from(
    { length: availableThroughOpportunity },
    (_, offset) => {
      const opportunity = offset + 1;
      const callerSequence = offset * 2 + 1;
      const assistantSequence = callerSequence + 1;
      return [
        Object.freeze({
          turn_id: `conversation.${String(callerSequence).padStart(3, "0")}.caller`,
          sequence: callerSequence,
          speaker: "caller" as const,
          source: "caller_tts_source_bound_to_pcm" as const,
          text: opportunity === 12
            ? "Correction: the current site is South Plant, not North Plant."
            : `Caller utterance ${opportunity}.`,
          available_after_opportunity: opportunity,
          provenance_receipt_sha256: sha256Hex(`caller-pcm:${opportunity}`),
          provider_conversation_source: true as const,
          oracle_derived: false as const,
          future_derived: false as const,
          semantic_evaluator_derived: false as const,
        }),
        Object.freeze({
          turn_id: `conversation.${String(assistantSequence).padStart(3, "0")}.assistant`,
          sequence: assistantSequence,
          speaker: "assistant" as const,
          source: "listener_exact_captured_pcm_asr" as const,
          text: `Provider-native assistant transcript ${opportunity}.`,
          available_after_opportunity: opportunity,
          provenance_receipt_sha256: sha256Hex(`assistant-pcm:${opportunity}`),
          provider_conversation_source: true as const,
          oracle_derived: false as const,
          future_derived: false as const,
          semantic_evaluator_derived: false as const,
        }),
      ];
    },
  ).flat());
}

function publicConversationTurnsWithTool(
  output: string,
): readonly Lc4NativeConversationTurnInput[] {
  const turns = [...publicConversationTurns(20)];
  turns.splice(1, 0, Object.freeze({
    turn_id: "placeholder.tool",
    sequence: 0,
    speaker: "tool" as const,
    source: "canonical_gateway_result" as const,
    tool_name: LC4_DEV_SEMANTIC_GATEWAY_FUNCTION.name,
    tool_arguments: Object.freeze({
      tool_name: "membership.lookup",
      arguments: Object.freeze({ member_id: "PUBLIC-17" }),
    }),
    text: output,
    available_after_opportunity: 1,
    provenance_receipt_sha256: sha256Hex(`provider-visible-tool:${output}`),
    provider_conversation_source: true as const,
    oracle_derived: false as const,
    future_derived: false as const,
    semantic_evaluator_derived: false as const,
  }));
  return Object.freeze(turns.map((turn, index) => Object.freeze({
    ...turn,
    turn_id: `conversation.${String(index + 1).padStart(3, "0")}.${turn.speaker}`,
    sequence: index + 1,
  }) as Lc4NativeConversationTurnInput));
}

function publicConversationTurnsWithToolBatch(
  outputs: readonly [string, string],
): readonly Lc4NativeConversationTurnInput[] {
  const turns = [...publicConversationTurns(20)];
  const batchSha256 = sha256Hex(`provider-tool-batch:${outputs.join("\n")}`);
  const toolTurns = outputs.map((output, index) => Object.freeze({
    turn_id: "placeholder.tool",
    sequence: 0,
    speaker: "tool" as const,
    source: "canonical_gateway_result" as const,
    tool_name: LC4_DEV_SEMANTIC_GATEWAY_FUNCTION.name,
    tool_arguments: Object.freeze({
      tool_name: index === 0 ? "membership.lookup" : "membership.quote",
      arguments: Object.freeze(index === 0
        ? { member_id: "PUBLIC-17" }
        : { member_id: "PUBLIC-17", term: "annual" }) as Readonly<Record<string, JsonValue>>,
    }),
    text: output,
    available_after_opportunity: 1,
    provenance_receipt_sha256: sha256Hex(`provider-visible-tool:${index}:${output}`),
    tool_batch_sha256: batchSha256,
    tool_batch_call_ordinal: index + 1,
    tool_batch_call_count: outputs.length,
    provider_conversation_source: true as const,
    oracle_derived: false as const,
    future_derived: false as const,
    semantic_evaluator_derived: false as const,
  }));
  turns.splice(1, 0, ...toolTurns);
  return Object.freeze(turns.map((turn, index) => Object.freeze({
    ...turn,
    turn_id: `conversation.${String(index + 1).padStart(3, "0")}.${turn.speaker}`,
    sequence: index + 1,
  }) as Lc4NativeConversationTurnInput));
}

function publicDeepConversationTurns(): readonly Lc4NativeConversationTurnInput[] {
  const base = publicConversationTurns(40);
  const turns: Lc4NativeConversationTurnInput[] = [];
  for (let offset = 0; offset < 40; offset += 1) {
    turns.push(base[offset * 2]!);
    const opportunity = offset + 1;
    const output = canonicalJson({
      gateway_result: { ok: true, opportunity },
      authoritative_outcome: { disposition: "verified" },
      speech_directive: `Confirm verified outcome ${opportunity}.`,
    });
    turns.push(Object.freeze({
      turn_id: "placeholder.tool",
      sequence: 0,
      speaker: "tool",
      source: "canonical_gateway_result",
      tool_name: LC4_DEV_SEMANTIC_GATEWAY_FUNCTION.name,
      tool_arguments: Object.freeze({
        tool_name: "membership.lookup",
        arguments: Object.freeze({ opportunity }),
      }),
      text: output,
      available_after_opportunity: opportunity,
      provenance_receipt_sha256: sha256Hex(`deep-tool:${opportunity}:${output}`),
      provider_conversation_source: true,
      oracle_derived: false,
      future_derived: false,
      semantic_evaluator_derived: false,
    }));
    turns.push(base[offset * 2 + 1]!);
  }
  return Object.freeze(turns.map((turn, index) => Object.freeze({
    ...turn,
    turn_id: `conversation.${String(index + 1).padStart(3, "0")}.${turn.speaker}`,
    sequence: index + 1,
  }) as Lc4NativeConversationTurnInput));
}

function devEpisodeForComparator(
  arm: "native" | "hacc",
  provider: "openai" | "gemini" | "xai" = "openai",
): Lc4DevLiveEpisodePlan {
  const profile = createLc4ProviderExecutionProfile(provider);
  return Object.freeze({
    episode_id: `lc4-dev-${provider}-${arm}-comparator`,
    pair_id: `lc4-dev-${provider}-comparator`,
    pair_position: arm === "native" ? 1 : 2,
    provider,
    arm,
    model: profile.model,
    voice: profile.voice,
    maximum_micro_usd: 1_000_000,
    opportunity_binding_set_sha256: sha256Hex(`comparator:${provider}`),
  });
}

function nativeRotationPacket(
  value: Lc4EpisodeManifest,
  previousReceipt: string,
  from: 1 | 2,
): Lc4NativeConversationReplayPacket {
  const availableThroughOpportunity = (from * 20) as 20 | 40;
  return createLc4NativeConversationReplayPacket({
    run_id: value.run_id,
    from_segment_ordinal: from,
    to_segment_ordinal: (from + 1) as 2 | 3,
    available_through_opportunity: availableThroughOpportunity,
    previous_session_rotation_receipt_sha256: previousReceipt,
    conversation_turns: publicConversationTurns(availableThroughOpportunity),
  });
}

function haccRotationContext(
  value: Lc4EpisodeManifest,
  previousReceipt: string,
  from: 1 | 2,
): Lc4RotationContext {
  return Object.freeze({
    kind: "hacc_structured_state" as const,
    packet: createLc4HaccRotationStatePacket({
      run_id: value.run_id,
      from_segment_ordinal: from,
      to_segment_ordinal: (from + 1) as 2 | 3,
      available_through_opportunity: (from * 20) as 20 | 40,
      previous_session_rotation_receipt_sha256: previousReceipt,
      flow_state_sha256: "5".repeat(64),
      response_plan_chain_head_sha256: "6".repeat(64),
      conversation_turns: publicConversationTurns((from * 20) as 20 | 40),
    }),
  });
}

class FakeRealtimeClient implements NormalizedRealtimeClient {
  readonly provider;
  state: "idle" | "ready" | "closed" = "idle";
  readonly events: string[];
  readonly #listeners = new Set<RealtimeEventListener>();
  readonly #wire = new Set<RealtimeWireObservationListener>();
  #wireSequence = 0;
  #toolRoundtrip: boolean;
  readonly #terminalStatus: "completed" | "failed" | "incomplete" | "interrupted" | "cancelled";
  #responseOrdinal = 0;
  #serverVadAutoResponse = false;
  #serverVadSpeechStarted = false;
  #serverVadStopped = false;
  #serverVadConsecutiveSilenceChunks = 0;
  #geminiInputOpen = false;
  #manualCommitOrdinal = 0;
  readonly #serverVadStopAfterSilenceChunks: number | null;
  readonly #xaiServerVad: boolean;
  readonly #serverVadEmitsSpeechStarted: boolean;
  readonly #corruptHistoryProjection: boolean;
  readonly submittedToolResults: Array<Readonly<{ results: readonly RealtimeToolResult[]; createResponse: boolean | undefined }>> = [];
  readonly preparations: RealtimeResponsePreparation[] = [];
  readonly appendedAudio: Pcm16Audio[] = [];
  readonly hydratedHistories: Array<readonly RealtimeConversationHistoryTurn[]> = [];

  constructor(
    provider: "openai" | "gemini" | "xai",
    events: string[],
    toolRoundtrip = false,
    terminalStatus: "completed" | "failed" | "incomplete" | "interrupted" | "cancelled" = "completed",
    serverVadStopAfterSilenceChunks: number | null =
      LC4_XAI_SERVER_VAD_SILENCE_TAIL.minimum_accepted_chunk_count,
    xaiServerVad = false,
    serverVadEmitsSpeechStarted = true,
    corruptHistoryProjection = false,
  ) {
    this.provider = provider;
    this.events = events;
    this.#toolRoundtrip = toolRoundtrip;
    this.#terminalStatus = terminalStatus;
    this.#serverVadStopAfterSilenceChunks = serverVadStopAfterSilenceChunks;
    this.#xaiServerVad = xaiServerVad;
    this.#serverVadEmitsSpeechStarted = serverVadEmitsSpeechStarted;
    this.#corruptHistoryProjection = corruptHistoryProjection;
  }

  get serverVadTransportParitySha256() {
    return this.provider === "xai" && this.#xaiServerVad
      ? LC4_XAI_SERVER_VAD_SHA256
      : undefined;
  }

  async connect() { this.events.push("connect"); this.state = "ready"; }
  async hydrateConversationHistory(
    turns: readonly RealtimeConversationHistoryTurn[],
  ): Promise<RealtimeConversationHistoryHydrationAcknowledgement> {
    this.events.push("hydrate");
    const snapshot = Object.freeze(turns.map((turn) => {
      if ("text" in turn) return Object.freeze({ ...turn });
      const calls = turn.role === "tool" ? [turn] : turn.calls;
      return Object.freeze({
        role: "tool_batch" as const,
        calls: Object.freeze(calls.map((call) => Object.freeze({
          toolName: call.toolName,
          toolArguments: JSON.parse(canonicalJson(call.toolArguments)),
          output: call.output,
          sourceSha256: call.sourceSha256,
        }))),
      });
    }));
    this.hydratedHistories.push(snapshot);
    const historySha256 = sha256Hex(
      `harshas-amazing-call-center/realtime-conversation-history/provider-visible/v2\n${canonicalJson(
        snapshot.map((turn) => "text" in turn
          ? { role: turn.role, text: turn.text }
          : {
              role: "tool_batch",
              calls: turn.calls.map((call) => ({
                toolName: call.toolName,
                toolArguments: call.toolArguments,
                output: call.output,
              })),
            }),
      )}`,
    );
    const sourceBindingSha256 = sha256Hex(
      `harshas-amazing-call-center/realtime-conversation-history/source-binding/v2\n${canonicalJson({
        historySha256,
        sources: snapshot.map((turn, index) => "text" in turn
          ? {
              ordinal: index + 1,
              sourceSha256: turn.sourceSha256,
            }
          : {
              ordinal: index + 1,
              role: "tool_batch",
              calls: turn.calls.map((call, callIndex) => ({
                callOrdinal: callIndex + 1,
                sourceSha256: call.sourceSha256,
              })),
            }),
      })}`,
    );
    let providerItemOrdinal = 0;
    const toolCallCount = snapshot.reduce(
      (count, turn) => count + ("calls" in turn ? turn.calls.length : 0),
      0,
    );
    const geminiContentTurnCount = snapshot.reduce(
      (count, turn) => count + ("calls" in turn ? 2 : 1),
      0,
    );
    const geminiOutboundObservation = this.provider === "gemini"
      ? wireReference(this.wire("clientContent", {
          initialHistory: {
            protocol: "initial_history_in_client_content",
            entryCount: snapshot.length,
            providerContentTurnCount: geminiContentTurnCount,
            textPartCount: snapshot.filter((turn) => "text" in turn).length,
            functionCallCount: toolCallCount,
            functionResponseCount: toolCallCount,
            turnComplete: true,
            generationTriggered: false,
            providerAcknowledgement: "not_defined_by_protocol",
            providerVisibleHistorySha256: this.#corruptHistoryProjection
              ? "0".repeat(64)
              : historySha256,
            geminiContentSha256: sha256Hex("fixture-gemini-history-content"),
          },
        }))
      : null;
    const items = snapshot.flatMap((turn, index) => {
      const expected = "text" in turn
        ? [{
            kind: turn.role === "user" ? "user_message" as const : "assistant_message" as const,
            sourceSha256: turn.sourceSha256,
            syntheticCallIdSha256: undefined,
            contentSha256: sha256Hex(turn.text),
            contentBytes: Buffer.byteLength(turn.text, "utf8"),
            nameSha256: undefined,
            nameBytes: undefined,
          }]
        : [
            ...turn.calls.map((call, callIndex) => ({
              kind: "synthetic_tool_call" as const,
              sourceSha256: call.sourceSha256,
              syntheticCallIdSha256: sha256Hex(
                `fixture-history-tool:${index + 1}:${callIndex + 1}`,
              ),
              contentSha256: sha256Hex(canonicalJson(call.toolArguments)),
              contentBytes: Buffer.byteLength(canonicalJson(call.toolArguments), "utf8"),
              nameSha256: sha256Hex(call.toolName),
              nameBytes: Buffer.byteLength(call.toolName, "utf8"),
            })),
            ...turn.calls.map((call, callIndex) => ({
              kind: "synthetic_tool_output" as const,
              sourceSha256: call.sourceSha256,
              syntheticCallIdSha256: sha256Hex(
                `fixture-history-tool:${index + 1}:${callIndex + 1}`,
              ),
              contentSha256: sha256Hex(call.output),
              contentBytes: Buffer.byteLength(call.output, "utf8"),
              nameSha256: undefined,
              nameBytes: undefined,
            })),
          ];
      return expected.map(({
        kind,
        sourceSha256,
        syntheticCallIdSha256,
        contentSha256,
        contentBytes,
        nameSha256,
        nameBytes,
      }) => {
        providerItemOrdinal += 1;
        const itemIdSha256 = sha256Hex(`fixture-history-item:${providerItemOrdinal}`);
        const identities = {
          itemIdSha256,
          ...(syntheticCallIdSha256 ? { callIdSha256: syntheticCallIdSha256 } : {}),
        };
        const historyProjection = kind === "synthetic_tool_call"
          ? {
              kind,
              nameSha256,
              nameBytes,
              namePresent: true,
              argumentsSha256: this.#corruptHistoryProjection
                ? "0".repeat(64)
                : contentSha256,
              argumentsBytes: contentBytes,
              argumentsPresent: true,
              argumentsJsonValid: true,
            }
          : kind === "synthetic_tool_output"
            ? {
                kind,
                outputSha256: this.#corruptHistoryProjection
                  ? "0".repeat(64)
                  : contentSha256,
                outputBytes: contentBytes,
                outputPresent: true,
              }
            : {
                kind,
                contentSha256: this.#corruptHistoryProjection
                  ? "0".repeat(64)
                  : contentSha256,
                contentBytes,
              };
        const outboundObservation = geminiOutboundObservation
          ?? wireReference(this.wire("conversation.item.create", {
            conversationHistoryItem: historyProjection,
          }, "outbound", identities));
        const xaiContentOmission = this.provider === "xai"
          && kind === "synthetic_tool_call";
        const inboundHistoryProjection = xaiContentOmission
          ? {
              ...historyProjection,
              argumentsSha256: sha256Hex(""),
              argumentsBytes: 0,
              argumentsPresent: true,
              argumentsJsonValid: false,
            }
          : historyProjection;
        const inboundObservation = this.provider === "gemini"
          ? undefined
          : wireReference(this.wire(
              this.provider === "xai"
                ? "conversation.item.added"
                : "conversation.item.created",
              {
              conversationHistoryItem: inboundHistoryProjection,
            }, "inbound", identities));
        return Object.freeze({
          historyTurnOrdinal: index + 1,
          providerItemOrdinal,
          kind,
          sourceSha256,
          ...(syntheticCallIdSha256 ? { syntheticCallIdSha256 } : {}),
          ...(xaiContentOmission
            ? {
                providerContentOmission: Object.freeze({
                  field: "arguments" as const,
                  observedShape: "empty_string" as const,
                }),
              }
            : {}),
          outboundObservation,
          ...(inboundObservation ? { inboundObservation } : {}),
        });
      });
    });
    return Object.freeze({
      schemaVersion: 1 as const,
      provider: this.provider,
      connectionEpoch: 1,
      status: this.provider === "gemini"
        ? "sent_unacknowledged_by_provider_protocol" as const
        : items.some((item) => item.providerContentOmission !== undefined)
          ? "identity_acknowledged_content_unverifiable" as const
        : "acknowledged" as const,
      turnCount: snapshot.length,
      providerItemCount: items.length,
      historySha256,
      sourceBindingSha256,
      items: Object.freeze(items),
    });
  }
  close() {
    this.events.push("close");
    this.state = "closed";
  }
  providerClose(code = 1011) {
    this.state = "closed";
    this.emit({
      type: "connection.closed",
      provider: this.provider,
      receivedAtMs: 5,
      wireType: "socket.close",
      code,
      clean: code === 1000,
    });
  }
  onEvent(listener: RealtimeEventListener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  onWireEvent() { return () => undefined; }
  onWireObservation(listener: RealtimeWireObservationListener) { this.#wire.add(listener); return () => this.#wire.delete(listener); }
  appendInputAudio(audio: Pcm16Audio) {
    if (this.provider === "xai" && this.#xaiServerVad && this.#serverVadStopped) {
      throw new Error(XAI_SERVER_VAD_AUDIO_AFTER_STOP_ERROR);
    }
    this.events.push("append");
    this.appendedAudio.push(Object.freeze({ ...audio, data: Uint8Array.from(audio.data) }));
    if (this.provider === "gemini") {
      if (!this.#geminiInputOpen) {
        this.wire("realtimeInput.activityStart", {
          audio: { direction: "input", activity: "start" },
        });
        this.#geminiInputOpen = true;
      }
      const encoded = Buffer.from(audio.data).toString("base64");
      this.wire("realtimeInput.audio", {
        audio: {
          direction: "input",
          chunks: [{
            validCanonicalBase64: true,
            byteLength: audio.data.byteLength,
            sha256: sha256Hex(audio.data),
            encodedBytes: Buffer.byteLength(encoded, "utf8"),
            mimeTypeRecognized: true,
            format: {
              encoding: "pcm16",
              sampleRateHz: audio.sampleRateHz,
              channels: 1,
            },
          }],
        },
      });
    } else {
      this.wire(
        this.provider === "xai"
          ? "input_audio_buffer.append"
          : "input_audio",
        { plaintext: ORACLE_SECRET },
      );
    }
    if (this.provider !== "xai" || !this.#xaiServerVad) return;
    if (!this.#serverVadSpeechStarted && this.#serverVadEmitsSpeechStarted) {
      this.#emitServerVadSpeechStarted();
    }
    this.#serverVadConsecutiveSilenceChunks = audio.data.every((byte) => byte === 0)
      ? this.#serverVadConsecutiveSilenceChunks + 1
      : 0;
    if (this.#serverVadStopAfterSilenceChunks !== null
      && this.#serverVadConsecutiveSilenceChunks === this.#serverVadStopAfterSilenceChunks) {
      const stopped = this.wire("input_audio_buffer.speech_stopped", {}, "inbound");
      this.emit({
        type: "input.speech_activity", provider: "xai", receivedAtMs: 2,
        wireType: stopped.wireType, phase: "stopped", wireObservation: wireReference(stopped),
      });
      const committed = this.wire("input_audio_buffer.committed", {}, "inbound");
      this.emit({
        type: "input.audio_committed", provider: "xai", receivedAtMs: 3,
        wireType: committed.wireType, connectionEpoch: 1, commitOrdinal: 1,
        wireObservation: wireReference(committed),
      });
      this.#serverVadAutoResponse = true;
      this.#serverVadStopped = true;
      this.createResponse();
      this.#serverVadSpeechStarted = false;
    }
  }
  #emitServerVadSpeechStarted() {
    this.#serverVadSpeechStarted = true;
    const started = this.wire("input_audio_buffer.speech_started", {}, "inbound");
    this.emit({
      type: "input.speech_activity", provider: "xai", receivedAtMs: 1,
      wireType: started.wireType, phase: "started", wireObservation: wireReference(started),
    });
  }
  async prepareServerVadTurn(preparation: Parameters<NonNullable<NormalizedRealtimeClient["prepareServerVadTurn"]>>[0]) {
    if (this.provider !== "xai") throw new Error("server VAD is xAI-only in this fixture");
    this.#serverVadStopped = false;
    this.#serverVadConsecutiveSilenceChunks = 0;
    this.events.push("session-update");
    const outbound = this.wire("session.update", {
      dynamicControl: {
        sha256: preparation.contextSha256,
        authority: preparation.contextAuthority,
        toolFrontierSha256: preparation.toolFrontierSha256,
        transportParitySha256: preparation.transportParitySha256,
      },
    });
    this.events.push("session-updated");
    const inbound = this.wire("session.updated", {}, "inbound");
    return Object.freeze({
      provider: "xai" as const,
      connectionEpoch: 1,
      turnOrdinal: 1,
      status: "acknowledged" as const,
      contextSha256: preparation.contextSha256,
      toolFrontierSha256: preparation.toolFrontierSha256,
      transportParitySha256: preparation.transportParitySha256,
      configuration: exactServerVadAcknowledgement(),
      outboundObservation: wireReference(outbound),
      inboundObservation: wireReference(inbound),
    });
  }
  prepareResponse(preparation: RealtimeResponsePreparation) {
    this.events.push("prepare");
    this.preparations.push(preparation);
    this.wire("response.plan", { oracle: ORACLE_SECRET });
  }
  prepareToolContinuation(preparation: RealtimeResponsePreparation) {
    this.events.push("prepare-continuation");
    this.preparations.push(preparation);
    this.wire("response.continuation.plan", {
      context_sha256: preparation.contextSha256,
      context_authority: preparation.contextAuthority,
    });
  }
  commitInputAudio() {
    this.events.push("commit");
    if (this.provider === "gemini") {
      if (!this.#geminiInputOpen) {
        throw new Error("Gemini fixture input activity is not open");
      }
      this.wire("realtimeInput.activityEnd", {
        audio: { direction: "input", activity: "end" },
      });
      this.#geminiInputOpen = false;
      return;
    }
    this.#manualCommitOrdinal += 1;
    this.wire("input_audio_buffer.commit", {});
  }
  async waitForInputAudioCommit() {
    this.events.push("commit-ack");
    const acknowledgement = this.wire("input_audio_buffer.committed", {}, "inbound");
    const wireObservation = wireReference(acknowledgement);
    this.emit({
      type: "input.audio_committed",
      provider: this.provider,
      receivedAtMs: 1,
      wireType: acknowledgement.wireType,
      connectionEpoch: 1,
      commitOrdinal: this.#manualCommitOrdinal,
      wireObservation,
    });
    return Object.freeze({
      provider: "xai" as const,
      connectionEpoch: 1,
      commitOrdinal: this.#manualCommitOrdinal,
      status: "acknowledged" as const,
      wireObservation,
    });
  }
  sendTurn() { throw new Error("bridge must use append/commit, not sendTurn"); }
  submitToolResults(results: readonly RealtimeToolResult[], createResponse?: boolean) {
    if (!this.#toolRoundtrip) throw new Error("not used");
    this.events.push(`submit:${String(createResponse)}`);
    this.submittedToolResults.push({ results, createResponse });
    if (this.provider === "gemini") {
      this.wire("toolResponse", {}, "outbound");
      queueMicrotask(() => {
        const responseId = `provider-tool-response-plaintext-${this.#responseOrdinal}`;
        if (this.submittedToolResults.length === 1) {
          const preToolAudio = new Uint8Array([8, 0]);
          const encoded = Buffer.from(preToolAudio).toString("base64");
          const preToolObservation = this.wire("serverContent", {
            audio: {
              direction: "output",
              chunks: [{
                validCanonicalBase64: true,
                byteLength: preToolAudio.byteLength,
                sha256: sha256Hex(preToolAudio),
                encodedBytes: Buffer.byteLength(encoded, "utf8"),
                mimeTypeRecognized: true,
                format: {
                  encoding: "pcm16",
                  sampleRateHz: 24_000,
                  channels: 1,
                },
              }],
            },
          }, "inbound");
          this.emit({
            type: "output.transcript",
            provider: "gemini",
            receivedAtMs: 3,
            wireType: "serverContent",
            responseId,
            phase: "final",
            text: "Second generated prefix before the final tool batch.",
            source: "audio",
            wireObservation: wireReference(preToolObservation),
          });
          this.emit({
            type: "output.audio",
            provider: "gemini",
            receivedAtMs: 3,
            wireType: "serverContent",
            responseId,
            audio: preToolAudio,
            format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
            wireObservation: wireReference(preToolObservation),
          });
          const toolCallObservation = this.wire("toolCall", {}, "inbound");
          this.emit({
            type: "tool.calls",
            provider: this.provider,
            receivedAtMs: 3,
            wireType: "toolCall",
            responseId,
            wireObservation: wireReference(toolCallObservation),
            calls: [{
              callId: "call-2",
              name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
              argumentsText: JSON.stringify({ tool_name: "complete_current_stage", arguments: {} }),
              argumentsJson: { tool_name: "complete_current_stage", arguments: {} },
              responseId,
              terminalWireType: "toolCall",
            }],
          });
          return;
        }
        this.#emitGeminiTerminalResponse(responseId);
      });
    }
  }
  createResponse() {
    const serverVadAutoResponse = this.#serverVadAutoResponse;
    this.#serverVadAutoResponse = false;
    if (!serverVadAutoResponse) {
      this.events.push("create");
      if (this.provider !== "gemini") this.wire("response.create", {});
    }
    if (this.provider === "gemini" && this.#toolRoundtrip && this.#responseOrdinal > 0) return;
    queueMicrotask(() => {
      this.#responseOrdinal += 1;
      if (this.#toolRoundtrip && this.#responseOrdinal === 1) {
        const responseId = "provider-tool-response-plaintext";
        const responseStarted = this.provider === "gemini"
          ? this.wire("toolCall", {}, "inbound")
          : this.wire("response.created", { response_id: responseId }, "inbound");
        this.emit({
          type: "response.started", provider: this.provider, receivedAtMs: 1,
          wireType: responseStarted.wireType, responseId,
          wireObservation: wireReference(responseStarted),
          ...(serverVadAutoResponse ? {
            causalBinding: {
              trigger: "server_vad_speech_stopped" as const,
              turnOrdinal: 1,
              triggerObservationSha256: this.#latestWireHash("input_audio_buffer.speech_stopped"),
            },
          } : {}),
        });
        if (this.provider === "gemini") {
          this.emit({
            type: "tool.calls",
            provider: this.provider,
            receivedAtMs: 2,
            wireType: "toolCall",
            responseId,
            wireObservation: wireReference(responseStarted),
            calls: [{
              callId: "call-1",
              name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
              argumentsText: JSON.stringify({ tool_name: "complete_current_stage", arguments: {} }),
              argumentsJson: { tool_name: "complete_current_stage", arguments: {} },
              responseId,
              terminalWireType: "toolCall",
            }],
          });
        } else {
          const provenance = {
            schemaVersion: 1 as const,
            provider: this.provider,
            nativeCallId: "call-1",
            nativeResponseId: responseId,
            terminalWireType: "response.function_call_arguments.done",
          };
          this.emit({
            type: "tool.dispatch",
            provider: this.provider,
            receivedAtMs: 2,
            wireType: "response.function_call_arguments.done",
            responseId,
            gateway: LOCAL_TOOL_PROXY_FUNCTION_NAME,
            dispatches: [{
              callId: "call-1",
              provenance,
              request: {
                method: "tools/call",
                params: {
                  name: "complete_current_stage",
                  arguments: {},
                  _meta: {
                    [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: "call-1",
                    [PROVIDER_PROVENANCE_META_KEY]: provenance,
                  },
                },
              },
            }],
          });
        }
        const preToolAudio = new Uint8Array([9, 0]);
        if (this.provider === "gemini") {
          const encoded = Buffer.from(preToolAudio).toString("base64");
          const preToolObservation = this.wire("serverContent", {
            audio: {
              direction: "output",
              chunks: [{
                validCanonicalBase64: true,
                byteLength: preToolAudio.byteLength,
                sha256: sha256Hex(preToolAudio),
                encodedBytes: Buffer.byteLength(encoded, "utf8"),
                mimeTypeRecognized: true,
                format: {
                  encoding: "pcm16",
                  sampleRateHz: 24_000,
                  channels: 1,
                },
              }],
            },
          }, "inbound");
          this.emit({
            type: "output.transcript",
            provider: "gemini",
            receivedAtMs: 2,
            wireType: "serverContent",
            responseId,
            phase: "final",
            text: "Generated before tool dispatch and never played.",
            source: "audio",
            wireObservation: wireReference(preToolObservation),
          });
          this.emit({
            type: "output.audio",
            provider: "gemini",
            receivedAtMs: 2,
            wireType: "serverContent",
            responseId,
            audio: preToolAudio,
            format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
            wireObservation: wireReference(preToolObservation),
          });
        } else {
          this.emit({
            type: "output.transcript",
            provider: this.provider,
            receivedAtMs: 2,
            wireType: "response.output_audio_transcript.done",
            responseId,
            phase: "final",
            text: "Generated before tool dispatch and never played.",
            source: "audio",
          });
          this.emit({
            type: "output.audio",
            provider: this.provider,
            receivedAtMs: 2,
            wireType: "response.audio.delta",
            responseId,
            audio: preToolAudio,
            format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
          });
        }
        if (this.provider !== "gemini") {
          this.emit({ type: "response.completed", provider: this.provider, receivedAtMs: 3, wireType: "response.done", responseId, status: "completed" });
        }
        return;
      }
      const responseId = `provider-response-plaintext-${this.#responseOrdinal}`;
      if (this.provider === "gemini") {
        this.#emitGeminiTerminalResponse(responseId);
        return;
      }
      const responseStarted = this.wire("response.created", { response_id: responseId }, "inbound");
      this.emit({
        type: "response.started", provider: this.provider, receivedAtMs: 1,
        wireType: "response.created", responseId,
        wireObservation: wireReference(responseStarted),
        ...(serverVadAutoResponse ? {
          causalBinding: {
            trigger: "server_vad_speech_stopped" as const,
            turnOrdinal: 1,
            triggerObservationSha256: this.#latestWireHash("input_audio_buffer.speech_stopped"),
          },
        } : {}),
      });
      this.emit({
        type: "output.transcript",
        provider: this.provider,
        receivedAtMs: 2,
        wireType: "response.output_audio_transcript.done",
        responseId,
        phase: "final",
        text: `Provider-native assistant transcript ${this.#responseOrdinal}.`,
        source: "audio",
      });
      this.emit({
        type: "output.audio",
        provider: this.provider,
        receivedAtMs: 2,
        wireType: "response.audio.delta",
        responseId,
        audio: new Uint8Array([1, 0, 2, 0]),
        format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      });
      this.emit({
        type: "response.completed",
        provider: this.provider,
        receivedAtMs: 3,
        wireType: "response.done",
        responseId,
        status: this.#terminalStatus,
      });
    });
  }

  #emitGeminiTerminalResponse(responseId: string) {
    const audio = new Uint8Array([1, 0, 2, 0]);
    const encoded = Buffer.from(audio).toString("base64");
    const audioObservation = this.wire("serverContent", {
      audio: {
        direction: "output",
        chunks: [{
          validCanonicalBase64: true,
          byteLength: audio.byteLength,
          sha256: sha256Hex(audio),
          encodedBytes: Buffer.byteLength(encoded, "utf8"),
          mimeTypeRecognized: true,
          format: {
            encoding: "pcm16",
            sampleRateHz: 24_000,
            channels: 1,
          },
        }],
      },
    }, "inbound");
    this.emit({
      type: "response.started",
      provider: "gemini",
      receivedAtMs: 2,
      wireType: "serverContent",
      responseId,
      wireObservation: wireReference(audioObservation),
    });
    this.emit({
      type: "output.transcript",
      provider: "gemini",
      receivedAtMs: 2,
      wireType: "serverContent",
      responseId,
      phase: "final",
      text: `Provider-native assistant transcript ${this.#responseOrdinal}.`,
      source: "audio",
      wireObservation: wireReference(audioObservation),
    });
    this.emit({
      type: "output.audio",
      provider: "gemini",
      receivedAtMs: 3,
      wireType: "serverContent",
      responseId,
      audio,
      format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      wireObservation: wireReference(audioObservation),
    });
    const terminalStatus = this.#terminalStatus === "completed"
      ? "completed"
      : this.#terminalStatus === "interrupted"
        ? "interrupted"
        : "failed";
    const terminalObservation = this.wire("serverContent", {
      terminal: { status: terminalStatus },
    }, "inbound");
    this.emit({
      type: "response.completed",
      provider: "gemini",
      receivedAtMs: 4,
      wireType: "serverContent",
      responseId,
      status: this.#terminalStatus,
      wireObservation: wireReference(terminalObservation),
    });
  }

  protected emit(event: NormalizedRealtimeEvent) { for (const listener of this.#listeners) listener(event); }
  readonly #wireHistory: Array<Readonly<{ wireType: string; observationSha256: string }>> = [];
  #latestWireHash(wireType: string): string {
    return this.#wireHistory.findLast((item) => item.wireType === wireType)?.observationSha256 ?? "0".repeat(64);
  }
  protected wire(
    wireType: string,
    projection: Record<string, unknown>,
    direction: "inbound" | "outbound" = "outbound",
    identities: RealtimeWireObservation["identities"] = {},
  ) {
    this.#wireSequence += 1;
    const payloadSha256 = sha256Hex(canonicalJson({ wireType, direction, projection, sequence: this.#wireSequence }));
    const previousObservationSha256 = this.#wireHistory.at(-1)?.observationSha256 ?? null;
    const observationSha256 = sha256Hex(canonicalJson({
      provider: this.provider, wireType, direction, sequence: this.#wireSequence,
      payloadSha256, previousObservationSha256,
    }));
    const observation = Object.freeze({
      schemaVersion: 1 as const,
      provider: this.provider,
      direction,
      connectionEpoch: 1,
      sequence: this.#wireSequence,
      observedAtMs: this.#wireSequence,
      observedAtMonotonicMs: this.#wireSequence,
      wireType,
      payloadSha256,
      payloadBytes: 10,
      projectionSha256: sha256Hex(canonicalJson(projection)),
      previousObservationSha256,
      observationSha256,
      identities: Object.keys(identities).length > 0
        ? identities
        : typeof projection.response_id === "string"
        ? { responseIdSha256: realtimeWireIdentitySha256("response", projection.response_id) }
        : {},
      projection,
    });
    this.#wireHistory.push({ wireType, observationSha256 });
    for (const listener of this.#wire) listener(observation);
    return observation;
  }
}

function wireReference(observation: RealtimeWireObservation) {
  return Object.freeze({
    availability: "observed" as const,
    connectionEpoch: observation.connectionEpoch,
    sequence: observation.sequence,
    observationSha256: observation.observationSha256,
    payloadSha256: observation.payloadSha256,
    projectionSha256: observation.projectionSha256,
  });
}

function rehashXaiManualTurnCausality(
  input: Lc4XaiManualTurnCausalityEvidence,
): Lc4XaiManualTurnCausalityEvidence {
  const body = {
    schema_version: input.schema_version,
    connection_epoch: input.connection_epoch,
    commit_observation_sha256: input.commit_observation_sha256,
    commit_sequence: input.commit_sequence,
    commit_ack_observation_sha256: input.commit_ack_observation_sha256,
    commit_ack_sequence: input.commit_ack_sequence,
    response_create_observation_sha256: input.response_create_observation_sha256,
    response_create_sequence: input.response_create_sequence,
    response_start_observation_sha256: input.response_start_observation_sha256,
    response_start_sequence: input.response_start_sequence,
    response_id_sha256: input.response_id_sha256,
  };
  return Object.freeze({
    ...body,
    causality_sha256: sha256Hex(
      `${LC4_XAI_MANUAL_TURN_CAUSALITY_DOMAIN}${canonicalJson(body)}`,
    ),
  });
}

function exactServerVadAcknowledgement() {
  const verified = Object.freeze({
    status: "verified" as const,
    requestedSha256: "a".repeat(64),
    acknowledgedSha256: "a".repeat(64),
    acknowledgedBy: "session.updated" as const,
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    strictParityVerified: true,
    paidBenchmarkReady: true,
    session: verified,
    fields: Object.freeze({
      model: verified, voice: verified, instructions: verified, tools: verified,
      tool_choice: verified, input_audio: verified, output_audio: verified,
      turn_detection: verified,
    }),
  });
}

class ProviderFatalRealtimeClient extends FakeRealtimeClient {
  override createResponse() {
    this.events.push("create");
    this.wire("response.create", {});
    queueMicrotask(() => this.emit({
      type: "error",
      provider: this.provider,
      receivedAtMs: 2,
      wireType: "error",
      message: "sk-provider-secret-plaintext-SENTINEL",
      code: "raw-secret-provider-code-SENTINEL",
      fatal: true,
      details: { credential: "sk-provider-secret-plaintext-SENTINEL" },
    }));
  }
}

class GatewayParseRealtimeClient extends FakeRealtimeClient {
  #generation = 0;

  override submitToolResults(results: readonly RealtimeToolResult[], createResponse?: boolean) {
    this.events.push(`submit:${String(createResponse)}`);
    this.submittedToolResults.push({ results, createResponse });
  }

  override createResponse() {
    this.#generation += 1;
    if (this.#generation > 1) {
      super.createResponse();
      return;
    }
    this.events.push("create");
    this.wire("response.create", {});
    queueMicrotask(() => {
      const responseId = "raw-provider-response-SENTINEL";
      this.emit({
        type: "response.started",
        provider: this.provider,
        receivedAtMs: 1,
        wireType: "response.created",
        responseId,
      });
      this.emit({
        type: "tool.dispatch",
        provider: this.provider,
        receivedAtMs: 2,
        wireType: "response.function_call_arguments.done",
        responseId,
        gateway: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        dispatches: [{
          callId: "raw-provider-call-SENTINEL",
          provenance: {
            schemaVersion: 1,
            provider: "openai",
            nativeCallId: "raw-provider-call-SENTINEL",
            nativeResponseId: responseId,
            terminalWireType: "response.function_call_arguments.done",
          },
          request: {
            method: "tools/call",
            params: {
              name: "unsafe.direct_tool",
              arguments: { credential: "sk-secret-SENTINEL" },
              _meta: {
                [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: "raw-provider-call-SENTINEL",
                [PROVIDER_PROVENANCE_META_KEY]: {
                  schemaVersion: 1,
                  provider: "openai",
                  nativeCallId: "raw-provider-call-SENTINEL",
                  nativeResponseId: responseId,
                  terminalWireType: "response.function_call_arguments.done",
                },
              },
            },
          },
        }],
      });
      this.emit({
        type: "response.completed",
        provider: this.provider,
        receivedAtMs: 3,
        wireType: "response.done",
        responseId,
        status: "completed",
      });
    });
  }
}

class HangingRealtimeClient extends FakeRealtimeClient {
  override createResponse() {
    this.events.push("create");
    this.wire("response.create", {});
  }
}

class XaiResponseBeforeAckRealtimeClient extends FakeRealtimeClient {
  override commitInputAudio() {
    super.commitInputAudio();
    const responseStarted = this.wire("response.created", {}, "inbound");
    this.emit({
      type: "response.started",
      provider: "xai",
      receivedAtMs: 1,
      wireType: responseStarted.wireType,
      responseId: "unsolicited-response-before-ack",
      wireObservation: wireReference(responseStarted),
    });
  }
}

class XaiMissingCommitAckEventRealtimeClient extends FakeRealtimeClient {
  override async waitForInputAudioCommit() {
    this.events.push("commit-ack-without-event");
    const acknowledgement = this.wire("input_audio_buffer.committed", {}, "inbound");
    return Object.freeze({
      provider: "xai" as const,
      connectionEpoch: 1,
      commitOrdinal: 1,
      status: "acknowledged" as const,
      wireObservation: wireReference(acknowledgement),
    });
  }
}

class XaiResponseBeforeCreateRealtimeClient extends FakeRealtimeClient {
  override async waitForInputAudioCommit() {
    const acknowledgement = await super.waitForInputAudioCommit();
    const responseStarted = this.wire("response.created", {}, "inbound");
    this.emit({
      type: "response.started",
      provider: "xai",
      receivedAtMs: 2,
      wireType: responseStarted.wireType,
      responseId: "unsolicited-response-before-create",
      wireObservation: wireReference(responseStarted),
    });
    return acknowledgement;
  }
}

class XaiDuplicateCommitAckRealtimeClient extends FakeRealtimeClient {
  override async waitForInputAudioCommit() {
    const acknowledgement = await super.waitForInputAudioCommit();
    const duplicate = this.wire("input_audio_buffer.committed", {}, "inbound");
    this.emit({
      type: "input.audio_committed",
      provider: "xai",
      receivedAtMs: 2,
      wireType: duplicate.wireType,
      connectionEpoch: 1,
      commitOrdinal: 1,
      wireObservation: wireReference(duplicate),
    });
    return acknowledgement;
  }
}

class XaiUnsolicitedVadRealtimeClient extends FakeRealtimeClient {
  override appendInputAudio(audio: Pcm16Audio) {
    super.appendInputAudio(audio);
    const speechStarted = this.wire("input_audio_buffer.speech_started", {}, "inbound");
    this.emit({
      type: "input.speech_activity",
      provider: "xai",
      receivedAtMs: 1,
      wireType: speechStarted.wireType,
      phase: "started",
      wireObservation: wireReference(speechStarted),
    });
  }
}

class ProviderConnectionCloseRealtimeClient extends FakeRealtimeClient {
  override createResponse() {
    this.events.push("create");
    this.wire("response.create", {});
    queueMicrotask(() => this.providerClose());
  }
}

class SynchronousHostCloseRealtimeClient extends FakeRealtimeClient {
  override close() {
    super.close();
    this.providerClose();
  }
}

class AudioAppendFailureRealtimeClient extends FakeRealtimeClient {
  override appendInputAudio() {
    this.events.push("append");
    throw new Error("raw audio transport failure sk-secret-SENTINEL");
  }
}

async function openDevFailureFixture(input: Readonly<{
  client: FakeRealtimeClient;
  listener?: Lc4ListenerEvidenceHandoff["accept"];
  audioDeliveryRuntime?: ConstructorParameters<typeof Lc4RealtimeProviderBridge>[1];
  xaiTransportPurpose?:
    | "finite_prerecorded_efficacy"
    | "interactive_transport_qualification";
  arm?: "native" | "hacc";
  assistantListenerTranscript?: string;
}>) {
  const arm = input.arm ?? "hacc";
  const base = manifest(arm, input.client.provider);
  const providerProfile = createLc4ProviderExecutionProfile(
    input.client.provider,
    input.xaiTransportPurpose ?? "finite_prerecorded_efficacy",
  );
  const corpus = createLc4PublicDevelopmentCorpus();
  const episode: Lc4DevLiveEpisodePlan = Object.freeze({
    episode_id: `lc4-dev-${input.client.provider}-${arm}-failure-fixture`,
    pair_id: `lc4-dev-${input.client.provider}-failure-fixture`,
    pair_position: 2,
    provider: input.client.provider,
    arm,
    model: base.episode_shape.provider_profile.model,
    voice: base.episode_shape.provider_profile.voice,
    maximum_micro_usd: 1_000,
    opportunity_binding_set_sha256: HASH,
  });
  const devManifest: Lc4RealtimeEpisodeManifest = Object.freeze({
    protocol_id: "HACC-LC4-DEV-v1",
    run_id: episode.episode_id,
    episode_shape: Object.freeze({
      provider: episode.provider,
      arm: episode.arm,
      provider_profile: providerProfile,
    }),
    opportunities: Object.freeze(corpus.opportunities.map((opportunity, index) => {
      const pcm = new Uint8Array([index + 1, 7, 11, 13]);
      return Object.freeze({
        ordinal: index + 1,
        opportunity_id: opportunity.id,
        segment_ordinal: Math.ceil((index + 1) / 20) as 1 | 2 | 3,
        caller_pcm_sha256: sha256Hex(pcm),
        caller_pcm_byte_length: pcm.byteLength,
        opportunity_contract_sha256: sha256Hex(`failure-contract-${index + 1}`),
      });
    })),
  });
  const evidenceStore = replayEvidenceFixture();
  const listenerEvidence = await evidenceStore.retainJson({
    kind: "listener_evidence",
    body: Object.freeze({ fixture: "failure-listener-evidence" }),
  });
  const assistantListenerTranscript = input.assistantListenerTranscript
    ?? "Exact assistant speech reconstructed from captured PCM.";
  const listenerResult = Object.freeze({
    listener_evidence_sha256: listenerEvidence.evidence_sha256,
    listener_evidence: listenerEvidence,
    repair_projection: createLc4DevArmBlindRepairProjection({
      opportunity_id: corpus.opportunities[0]!.id,
      listener_status: "verified",
      semantic_result_sha256: sha256Hex("failure-semantic-result"),
      semantic_replay_sha256: sha256Hex("failure-semantic-replay"),
      unmet_blocker_codes: [],
      final_required_criteria_pass: true,
    }),
    playback_authority_receipt_sha256: sha256Hex("failure-playback-authority"),
    assistant_conversation_transcript: assistantListenerTranscript,
    assistant_conversation_transcript_sha256: sha256Hex(assistantListenerTranscript),
    assistant_conversation_transcript_source: "listener_exact_captured_pcm_asr" as const,
  });
  const gateway: Lc4DevGatewayExecutor = Object.freeze({
    kind: "lc4-dev-arm-aware-gateway-v1",
    manifest_sha256: "d".repeat(64),
    currentResponsePreparation: fixtureContinuationPreparation,
    async execute() { throw new Error("failure fixture gateway must not execute"); },
  });
  const bridge = new Lc4RealtimeProviderBridge(
    () => input.client,
    input.audioDeliveryRuntime,
    Object.freeze({
      xai_transport_purpose:
        input.xaiTransportPurpose ?? "finite_prerecorded_efficacy",
    }),
  );
  const session = await bridge.openSegment({
    manifest: devManifest,
    segment: base.episode_shape.segments[0]!,
    profile: providerProfile,
    configuration: Object.freeze({
      ...configuration(base),
      providerTools: Object.freeze([LC4_DEV_SEMANTIC_GATEWAY_FUNCTION]),
    }),
    rotation_context: null,
    listener: { accept: input.listener ?? (async () => listenerResult) },
    dev_gateway: { episode, opportunities: corpus.opportunities, executor: gateway },
  });
  return Object.freeze({
    session,
    opportunity_id: corpus.opportunities[0]!.id,
    caller_pcm: new Uint8Array([1, 7, 11, 13]),
    next_opportunity_id: corpus.opportunities[1]!.id,
    next_caller_pcm: new Uint8Array([2, 7, 11, 13]),
  });
}

class PrepareFailureRealtimeClient extends FakeRealtimeClient {
  override prepareResponse() {
    this.events.push("prepare");
    throw new Error("injected response preparation failure");
  }
}

class OversizedControlRealtimeClient extends FakeRealtimeClient {
  override prepareResponse(preparation: RealtimeResponsePreparation) {
    this.events.push("prepare");
    throw new RealtimeDynamicControlLimitError({
      provider: this.provider,
      actualBytes: Buffer.byteLength(preparation.additionalInstructions, "utf8"),
      maximumBytes: 512,
    });
  }
}

async function caughtFailure(promise: Promise<unknown>): Promise<Lc4DevFailureEvidenceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Lc4DevFailureEvidenceError);
    return error as Lc4DevFailureEvidenceError;
  }
  throw new Error("expected an LC4-DEV failure evidence error");
}

const callerBranchKeys = generateKeyPairSync("ed25519");
const callerBranchIdentity = Object.freeze({
  key_id: "lc4-dev-adapter-branch-preflight",
  private_key_pem: callerBranchKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  public_key_pem: callerBranchKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
});
const callerBranchTrust = Object.freeze({
  key_id: callerBranchIdentity.key_id,
  public_key_pem: callerBranchIdentity.public_key_pem,
});

function callerBranchPcm(
  provider: "openai" | "gemini" | "xai",
  outcome: Lc4DevPriorMutationOutcome,
): Uint8Array {
  const providerOrdinal = (["openai", "gemini", "xai"] as const).indexOf(provider) + 1;
  const outcomeOrdinal = LC4_DEV_PRIOR_MUTATION_OUTCOMES.indexOf(outcome) + 1;
  return new Uint8Array([providerOrdinal, outcomeOrdinal, 23, 0, 41, 0, 59, 0]);
}

function callerBranchAudioBindings(): readonly Lc4DevCallerBranchAudioBinding[] {
  return Object.freeze((["openai", "gemini", "xai"] as const).flatMap((provider) =>
    LC4_DEV_CALLER_BRANCH_SOURCES.map((source) => {
      const pcm = callerBranchPcm(provider, source.prior_outcome);
      return Object.freeze({
        prior_outcome: source.prior_outcome,
        provider,
        opportunity_id: LC4_DEV_BRANCH_OPPORTUNITY_ID,
        source_id: source.source_id,
        source_text_sha256: source.canonical_caller_text_sha256,
        pcm_sha256: sha256Hex(pcm),
        pcm_byte_length: pcm.byteLength,
        sample_rate_hz: provider === "gemini" ? 16_000 as const : 24_000 as const,
        channels: 1 as const,
        encoding: "pcm16le" as const,
      });
    }),
  ));
}

const callerBranchMatrix = createLc4DevCallerBranchMatrixArtifact({
  audio_manifest_sha256: sha256Hex("lc4-dev-adapter-branch-preflight-audio-manifest"),
  audio_bindings: callerBranchAudioBindings(),
  signing_identity: callerBranchIdentity,
});
const callerBranchAuthority = createLc4DevCallerBranchAuthority({
  matrix: callerBranchMatrix,
  signing_identity: callerBranchIdentity,
});

function callerBranchPriorReceipt(outcome: Lc4DevPriorMutationOutcome) {
  return Object.freeze({
    semantic_opportunity_id: LC4_DEV_MUTATION_OPPORTUNITY_ID,
    tool: "archive.submit_transcript_request" as const,
    outcome,
    receipt_sha256: outcome === "no_call" ? null : sha256Hex(`lc4-dev-adapter-prior:${outcome}`),
  });
}

async function openCallerBranchPreflight(input: Readonly<{
  provider: "openai" | "gemini" | "xai";
  outcome: Lc4DevPriorMutationOutcome;
}>) {
  const base = manifest("hacc", input.provider);
  const corpus = createLc4PublicDevelopmentCorpus();
  const episode: Lc4DevLiveEpisodePlan = Object.freeze({
    episode_id: `lc4-dev-${input.provider}-${input.outcome}-branch-preflight`,
    pair_id: `lc4-dev-${input.provider}-branch-preflight`,
    pair_position: 2,
    provider: input.provider,
    arm: "hacc",
    model: base.episode_shape.provider_profile.model,
    voice: base.episode_shape.provider_profile.voice,
    maximum_micro_usd: 1_000,
    opportunity_binding_set_sha256: sha256Hex(`branch-preflight:${input.provider}:${input.outcome}`),
  });
  const devManifest: Lc4RealtimeEpisodeManifest = Object.freeze({
    protocol_id: "HACC-LC4-DEV-v1",
    run_id: episode.episode_id,
    episode_shape: Object.freeze({
      provider: episode.provider,
      arm: episode.arm,
      provider_profile: base.episode_shape.provider_profile,
    }),
    opportunities: Object.freeze(corpus.opportunities.map((opportunity, index) => {
      const pcm = new Uint8Array([index + 1, 7, 11, 13]);
      return Object.freeze({
        ordinal: index + 1,
        opportunity_id: opportunity.id,
        segment_ordinal: Math.ceil((index + 1) / 20) as 1 | 2 | 3,
        caller_pcm_sha256: sha256Hex(pcm),
        caller_pcm_byte_length: pcm.byteLength,
        opportunity_contract_sha256: sha256Hex(`branch-contract-${index + 1}`),
      });
    })),
  });
  const events: string[] = [];
  const gateway: Lc4DevGatewayExecutor = Object.freeze({
    kind: "lc4-dev-arm-aware-gateway-v1",
    manifest_sha256: sha256Hex("lc4-dev-adapter-branch-preflight-gateway"),
    currentResponsePreparation: fixtureContinuationPreparation,
    async execute() { throw new Error("branch preflight gateway must not execute"); },
  });
  const evidenceStore = replayEvidenceFixture();
  const bridge = new Lc4RealtimeProviderBridge(() => new FakeRealtimeClient(input.provider, events));
  const providerConfiguration = Object.freeze({
    ...configuration(base),
    providerTools: Object.freeze([LC4_DEV_SEMANTIC_GATEWAY_FUNCTION]),
  });
  const devGateway = Object.freeze({
    episode,
    opportunities: corpus.opportunities,
    executor: gateway,
    caller_branch_authority: {
      matrix: callerBranchMatrix,
      trust: callerBranchTrust,
    },
  });
  const open = (
    ordinal: 1 | 2 | 3,
    rotationContext: Lc4RotationContext | null,
  ) => bridge.openSegment({
    manifest: devManifest,
    segment: base.episode_shape.segments[ordinal - 1]!,
    profile: base.episode_shape.provider_profile,
    configuration: providerConfiguration,
    rotation_context: rotationContext,
    listener: {
      async accept({ capture }) {
        const listenerEvidence = await evidenceStore.retainJson({
          kind: "listener_evidence",
          body: Object.freeze({
            fixture: "branch-preflight-listener-evidence",
            opportunity_id: capture.opportunity_id,
          }),
        });
        return Object.freeze({
          listener_evidence_sha256: listenerEvidence.evidence_sha256,
          listener_evidence: listenerEvidence,
          repair_projection: createLc4DevArmBlindRepairProjection({
            opportunity_id: capture.opportunity_id,
            listener_status: "verified",
            semantic_result_sha256: sha256Hex(`branch-preflight-semantic:${capture.opportunity_id}`),
            semantic_replay_sha256: sha256Hex(`branch-preflight-replay:${capture.opportunity_id}`),
            unmet_blocker_codes: [],
            final_required_criteria_pass: true,
          }),
          playback_authority_receipt_sha256: sha256Hex(`branch-preflight-playback:${capture.opportunity_id}`),
          assistant_conversation_transcript: "Branch fixture assistant speech from captured PCM.",
          assistant_conversation_transcript_sha256: sha256Hex("Branch fixture assistant speech from captured PCM."),
          assistant_conversation_transcript_source: "listener_exact_captured_pcm_asr" as const,
        });
      },
    },
    dev_gateway: devGateway,
  });
  const rotation = (
    previousReceipt: string,
    from: 1 | 2,
  ): Lc4RotationContext => Object.freeze({
    kind: "hacc_structured_state",
    packet: createLc4HaccRotationStatePacket({
      run_id: episode.episode_id,
      from_segment_ordinal: from,
      to_segment_ordinal: (from + 1) as 2 | 3,
      available_through_opportunity: (from * 20) as 20 | 40,
      previous_session_rotation_receipt_sha256: previousReceipt,
      flow_state_sha256: sha256Hex(`branch-preflight-flow:${input.provider}:${input.outcome}:${from}`),
      response_plan_chain_head_sha256: sha256Hex(`branch-preflight-plan:${input.provider}:${input.outcome}:${from}`),
      conversation_turns: publicConversationTurns((from * 20) as 20 | 40),
    }),
  });
  const firstSegment = await open(1, null);
  const firstReceipt = await firstSegment.close();
  const secondSegment = await open(2, rotation(firstReceipt.rotation_receipt_sha256, 1));
  const secondReceipt = await secondSegment.close();
  const session = await open(3, rotation(secondReceipt.rotation_receipt_sha256, 2));
  const firstOpportunity = corpus.opportunities[40]!;
  await session.exchange({
    opportunity_id: firstOpportunity.id,
    caller_pcm: new Uint8Array([41, 7, 11, 13]),
    response_control: { kind: "hacc_response_plan", plan: responsePlan() },
  });
  await session.finalizeOpportunity!({
    opportunity_id: firstOpportunity.id,
    decision_receipt_sha256: sha256Hex(`branch-preflight-op41:${input.provider}:${input.outcome}`),
    repair_played: false,
  });
  const decision = callerBranchAuthority.decide({
    episode_id: episode.episode_id,
    provider: input.provider,
    opportunity: corpus.opportunities[41]!,
    prior_receipt: callerBranchPriorReceipt(input.outcome),
  });
  assertLc4DevCallerBranchDecision({
    decision,
    matrix: callerBranchMatrix,
    trust: callerBranchTrust,
  });
  const { decision_sha256: claimedDecisionSha256, ...signedDecision } = decision;
  const decisionEvidence = await evidenceStore.retainJson({
    kind: "caller_branch_decision",
    body: signedDecision as unknown as JsonValue,
    domain_prefix: LC4_DEV_CALLER_BRANCH_DECISION_ARTIFACT_DOMAIN,
    expected_evidence_sha256: claimedDecisionSha256,
  });
  return Object.freeze({
    session,
    events,
    opportunity: corpus.opportunities[41]!,
    pcm: callerBranchPcm(input.provider, input.outcome),
    binding: Object.freeze({
      decision,
      decision_evidence: decisionEvidence,
    }) satisfies Lc4DevCallerBranchPlaybackBinding,
  });
}

describe("LC4 production realtime adapter bridge", () => {
  it("retains sanitized pre-send contract failure evidence without requesting a response", async () => {
    const events: string[] = [];
    const fixture = await openDevFailureFixture({ client: new FakeRealtimeClient("openai", events) });
    const error = await caughtFailure(fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: new Uint8Array([1]),
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }));
    expect(error.failure).toMatchObject({
      failure_stage: "pre_send_contract",
      failure_code: "invalid_contract",
      failure_class: "adapter_contract",
      caller_pcm_appended_byte_length: 0,
      caller_pcm_appended_chunk_count: 0,
      response_generation_requested: false,
      response_generation_started: false,
      response_completed: false,
      wire_observation_count: 0,
    });
    expect(events).toEqual(["connect"]);
    await fixture.session.close();
  });

  it("classifies response-control overflow distinctly from audio delivery failure", async () => {
    const events: string[] = [];
    const fixture = await openDevFailureFixture({
      client: new OversizedControlRealtimeClient("openai", events),
    });
    const error = await caughtFailure(fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }));
    expect(error.failure).toMatchObject({
      failure_stage: "response_prepare",
      failure_code: "response_control_too_large",
      failure_class: "adapter_contract",
      caller_pcm_appended_byte_length: fixture.caller_pcm.byteLength,
      response_generation_requested: false,
      response_generation_started: false,
      response_completed: false,
    });
    expect(events).toEqual(["connect", "append", "prepare", "close"]);
    await caughtFailure(fixture.session.close());
  });

  it("classifies an idle provider disconnect on the next turn without inheriting prior response evidence", async () => {
    const events: string[] = [];
    const client = new FakeRealtimeClient("openai", events);
    const fixture = await openDevFailureFixture({ client });
    await fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    });
    await fixture.session.finalizeOpportunity!({
      opportunity_id: fixture.opportunity_id,
      decision_receipt_sha256: sha256Hex("provider-close-first-opportunity"),
      repair_played: false,
    });
    client.providerClose();
    const operationCount = events.length;
    const error = await caughtFailure(fixture.session.exchange({
      opportunity_id: fixture.next_opportunity_id,
      caller_pcm: fixture.next_caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }));
    expect(error.failure).toMatchObject({
      failure_stage: "pre_send_contract",
      failure_code: "provider_connection_closed",
      failure_class: "provider_external",
      caller_pcm_appended_byte_length: 0,
      response_generation_requested: false,
      response_generation_started: false,
      response_terminal_observed: false,
      response_completed: false,
      output_pcm_byte_length: 0,
      output_pcm_chunk_count: 0,
      wire_observation_count: 0,
      terminal_wire_type: "none",
    });
    expect(error.failure.operation_order).toEqual([]);
    expect(events).toHaveLength(operationCount);
    const cleanup = await caughtFailure(fixture.session.close());
    expect(cleanup.failure).toMatchObject({
      failure_role: "cleanup",
      failure_code: "segment_close_failed",
    });
  });

  it("never mints a rotation receipt after an idle provider disconnect", async () => {
    const client = new FakeRealtimeClient("openai", []);
    const fixture = await openDevFailureFixture({ client });
    await fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    });
    await fixture.session.finalizeOpportunity!({
      opportunity_id: fixture.opportunity_id,
      decision_receipt_sha256: sha256Hex("provider-close-before-rotation"),
      repair_played: false,
    });
    client.providerClose();
    const cleanup = await caughtFailure(fixture.session.close());
    expect(cleanup.failure).toMatchObject({
      failure_role: "cleanup",
      failure_stage: "segment_close",
      failure_code: "segment_close_failed",
      failure_class: "cleanup",
    });
  });

  it("surfaces a provider disconnect during response wait without waiting for timeout", async () => {
    const fixture = await openDevFailureFixture({
      client: new ProviderConnectionCloseRealtimeClient("openai", []),
    });
    const error = await caughtFailure(fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }));
    expect(error.failure).toMatchObject({
      failure_stage: "provider_wait",
      failure_code: "provider_connection_closed",
      failure_class: "provider_external",
      response_generation_requested: true,
      response_generation_started: false,
      response_terminal_observed: false,
      response_completed: false,
    });
    await caughtFailure(fixture.session.close());
  });

  it("retains provider-fatal evidence without provider plaintext or credentials", async () => {
    const fixture = await openDevFailureFixture({ client: new ProviderFatalRealtimeClient("openai", []) });
    const error = await caughtFailure(fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }));
    expect(error.failure).toMatchObject({
      failure_stage: "provider_wait",
      failure_code: "provider_fatal",
      failure_class: "provider_external",
      caller_pcm_appended_byte_length: fixture.caller_pcm.byteLength,
      response_generation_requested: true,
      response_generation_started: false,
      response_completed: false,
      terminal_wire_type: "response_request",
    });
    expect(canonicalJson(error.failure)).not.toContain("SENTINEL");
    const cleanup = await caughtFailure(fixture.session.close());
    expect(cleanup.failure).toMatchObject({ failure_role: "cleanup", failure_stage: "segment_close" });
  });

  it("retains exact audio-delivery progress without leaking the transport error", async () => {
    const events: string[] = [];
    const fixture = await openDevFailureFixture({ client: new AudioAppendFailureRealtimeClient("openai", events) });
    const error = await caughtFailure(fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }));
    expect(error.failure).toMatchObject({
      failure_stage: "audio_append",
      failure_code: "audio_delivery_failed",
      failure_class: "audio_delivery",
      caller_pcm_byte_length: fixture.caller_pcm.byteLength,
      caller_pcm_chunk_count: 1,
      caller_pcm_appended_chunk_count: 0,
      caller_pcm_appended_byte_length: 0,
      response_generation_requested: false,
      response_generation_started: false,
      response_completed: false,
    });
    expect(canonicalJson(error.failure)).not.toContain("SENTINEL");
    expect(events).toEqual(["connect", "append", "close"]);
    await caughtFailure(fixture.session.close());
  });

  it("rejects a correlatable semantic mistake and continues without retaining raw provider data", async () => {
    const fixture = await openDevFailureFixture({ client: new GatewayParseRealtimeClient("openai", []) });
    const evidence = await fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    });
    expect(evidence.dev_gateway_receipt_set?.receipts).toEqual([]);
    expect(evidence.dev_gateway_receipt_set?.authority_projections).toEqual([]);
    expect(evidence.dev_gateway_receipt_set?.pre_dispatch_rejections).toHaveLength(1);
    expect(evidence.dev_gateway_receipt_set?.pre_dispatch_rejections[0]).toMatchObject({
      rejection_code: "unknown_semantic_intent",
      executor_invoked: false,
      authority_effect: "none",
    });
    expect(canonicalJson(evidence.dev_gateway_receipt_set)).not.toContain("SENTINEL");
    await fixture.session.finalizeOpportunity!({
      opportunity_id: fixture.opportunity_id,
      decision_receipt_sha256: sha256Hex("gateway-rejection-no-repair"),
      repair_played: false,
    });
    await expect(fixture.session.close()).resolves.toHaveProperty("rotation_receipt_sha256");
  });

  it("retains a true provider timeout after a response request", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await openDevFailureFixture({ client: new HangingRealtimeClient("openai", []) });
      const pending = caughtFailure(fixture.session.exchange({
        opportunity_id: fixture.opportunity_id,
        caller_pcm: fixture.caller_pcm,
        response_control: { kind: "hacc_response_plan", plan: responsePlan() },
      }));
      await vi.advanceTimersByTimeAsync(45_000);
      const error = await pending;
      expect(error.failure).toMatchObject({
        failure_stage: "provider_wait",
        failure_code: "provider_response_timeout",
        failure_class: "timeout",
        response_generation_requested: true,
        response_generation_started: false,
        response_terminal_observed: false,
        response_completed: false,
      });
      await caughtFailure(fixture.session.close());
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers and replay-binds a native stop on the final frozen xAI delimiter frame without changing caller PCM", async () => {
    let monotonicMs = 0;
    const events: string[] = [];
    const client = new FakeRealtimeClient(
      "xai",
      events,
      false,
      "completed",
      LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count,
      true,
    );
    const fixture = await openDevFailureFixture({
      client,
      xaiTransportPurpose: "interactive_transport_qualification",
      audioDeliveryRuntime: {
        monotonicNowMs: () => monotonicMs,
        async sleep(delayMs, signal) {
          if (signal.aborted) throw new Error("test delivery aborted");
          monotonicMs += delayMs;
        },
      },
    });
    const evidence = await fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    });
    expect(evidence.input_audio_delivery).toMatchObject({
      pcm_sha256: sha256Hex(fixture.caller_pcm),
      total_byte_length: fixture.caller_pcm.byteLength,
      chunk_count: 1,
    });
    expect(evidence.server_vad_transport_suffix).toMatchObject({
      schema_version: 1,
      purpose: LC4_XAI_SERVER_VAD_SILENCE_TAIL.purpose,
      completion: "provider_native_speech_stop",
      policy_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
      pcm_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256,
      audio_bytes: LC4_XAI_SERVER_VAD_SILENCE_TAIL.byte_length,
      duration_ms: LC4_XAI_SERVER_VAD_SILENCE_TAIL.duration_ms,
      chunk_count: LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count,
      frame_bytes: 960,
      tail_bytes: 960,
    });
    expect(evidence.operation_order).toContain("server_vad_silence_tail_prefix_accepted");
    expect(events.filter((event) => event === "connect")).toHaveLength(1);
    expect(events.filter((event) => event === "commit")).toHaveLength(0);
    expect(events.filter((event) => event === "create")).toHaveLength(0);
    expect(client.appendedAudio.slice(0, 1)[0]?.data).toEqual(fixture.caller_pcm);
    expect(client.appendedAudio.slice(1)).toHaveLength(LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count);

    const mutatedProjection = JSON.parse(JSON.stringify(evidence.replay_projection)) as Record<string, unknown>;
    const suffix = mutatedProjection.server_vad_transport_suffix as Record<string, unknown>;
    suffix.pcm_sha256 = "f".repeat(64);
    await expect(replayEvidenceFixture().retainJson({
      kind: "provider_exchange",
      body: mutatedProjection as JsonValue,
      domain_prefix: "harshas-amazing-call-center/lc4-provider-exchange-evidence/v5\n",
      expected_evidence_sha256: evidence.evidence_sha256,
    })).rejects.toThrow();

    await fixture.session.finalizeOpportunity!({
      opportunity_id: fixture.opportunity_id,
      decision_receipt_sha256: sha256Hex("xai-full-tail-finalization"),
      repair_played: false,
    });
    await fixture.session.close();
  });

  it("uses the signed exact-captured-PCM listener transcript for provider-neutral reconnect history", async () => {
    const listenerTranscript = "Exact assistant speech reconstructed from captured PCM.";
    const fixture = await openDevFailureFixture({
      client: new FakeRealtimeClient("openai", []),
      assistantListenerTranscript: listenerTranscript,
    });
    const evidence = await fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    });
    expect(evidence.provider_output_transcript_sha256)
      .toBe(sha256Hex("Provider-native assistant transcript 1."));
    expect(evidence).toMatchObject({
      assistant_conversation_transcript_sha256: sha256Hex(listenerTranscript),
      assistant_conversation_transcript_source: "listener_exact_captured_pcm_asr",
      dev_assistant_conversation_transcript: listenerTranscript,
      dev_assistant_conversation_transcript_source: "listener_exact_captured_pcm_asr",
    });
    expect(JSON.stringify(evidence.replay_projection)).not.toContain(listenerTranscript);
    expect(JSON.stringify(evidence.dev_listener_result)).not.toContain(listenerTranscript);
    await fixture.session.finalizeOpportunity!({
      opportunity_id: fixture.opportunity_id,
      decision_receipt_sha256: sha256Hex("listener-transcript-finalization"),
      repair_played: false,
    });
    await fixture.session.close();
  });

  it("uses one explicit commit and response for finite xAI clips without altering or suffixing caller PCM", async () => {
    const events: string[] = [];
    const client = new FakeRealtimeClient(
      "xai",
      events,
      false,
      "completed",
      null,
      false,
    );
    const fixture = await openDevFailureFixture({
      client,
    });
    const evidence = await fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    });

    expect(evidence).toMatchObject({
      caller_pcm_sha256: sha256Hex(fixture.caller_pcm),
      caller_pcm_byte_length: fixture.caller_pcm.byteLength,
      transport_mode: "manual_commit",
      server_vad_setting_sha256: null,
      server_vad_transport_disclosure_sha256: null,
      server_vad_transport_suffix: null,
      per_turn_session_update_observation_sha256: null,
      per_turn_session_ack_observation_sha256: null,
      xai_manual_turn_causality: {
        schema_version: 1,
        connection_epoch: 1,
      },
    });
    const causality = evidence.xai_manual_turn_causality!;
    expect([
      causality.commit_sequence,
      causality.commit_ack_sequence,
      causality.response_create_sequence,
      causality.response_start_sequence,
    ]).toEqual([...[
      causality.commit_sequence,
      causality.commit_ack_sequence,
      causality.response_create_sequence,
      causality.response_start_sequence,
    ]].sort((left, right) => left - right));
    expect(assertLc4XaiManualTurnCausality(causality, evidence.wire_observations)).toBe(causality);
    expect(causality.response_id_sha256).toBe(
      lc4XaiManualResponseWireIdentitySha256("provider-response-plaintext-1"),
    );
    expect(causality.response_id_sha256).not.toBe(sha256Hex("provider-response-plaintext-1"));
    expect(() => assertLc4XaiManualTurnCausality({
      ...causality,
      schema_version: 2,
    }, evidence.wire_observations)).toThrow(/schema version/u);

    const plainShaIdentity = rehashXaiManualTurnCausality({
      ...causality,
      response_id_sha256: sha256Hex("provider-response-plaintext-1"),
    });
    expect(() => assertLc4XaiManualTurnCausality(
      plainShaIdentity,
      evidence.wire_observations,
    )).toThrow(/causality/u);

    const crossTurnIdentity = rehashXaiManualTurnCausality({
      ...causality,
      response_id_sha256: lc4XaiManualResponseWireIdentitySha256(
        "provider-response-plaintext-other-turn",
      ),
    });
    expect(() => assertLc4XaiManualTurnCausality(
      crossTurnIdentity,
      evidence.wire_observations,
    )).toThrow(/causality/u);

    const reorderedWire = [...evidence.wire_observations];
    const commitIndex = reorderedWire.findIndex(
      (observation) => observation.observation_sha256 === causality.commit_observation_sha256,
    );
    const acknowledgementIndex = reorderedWire.findIndex(
      (observation) => observation.observation_sha256 === causality.commit_ack_observation_sha256,
    );
    [reorderedWire[commitIndex], reorderedWire[acknowledgementIndex]] = [
      reorderedWire[acknowledgementIndex]!,
      reorderedWire[commitIndex]!,
    ];
    expect(() => assertLc4XaiManualTurnCausality(causality, reorderedWire))
      .toThrow(/reordered|chain-tampered/u);

    const tamperedWire = evidence.wire_observations.map((observation) => (
      observation.observation_sha256 === causality.response_create_observation_sha256
        ? { ...observation, wire_type: "input_audio_buffer.commit" }
        : observation
    ));
    expect(() => assertLc4XaiManualTurnCausality(causality, tamperedWire))
      .toThrow(/causal role/u);

    expect(() => assertLc4XaiManualTurnReplayProjection(evidence.replay_projection))
      .not.toThrow();
    const tamperedReplay = JSON.parse(JSON.stringify(evidence.replay_projection)) as Record<string, unknown>;
    const replayCausality = tamperedReplay.xai_manual_turn_causality as
      Lc4XaiManualTurnCausalityEvidence;
    tamperedReplay.xai_manual_turn_causality = rehashXaiManualTurnCausality({
      ...replayCausality,
      response_id_sha256: sha256Hex("provider-response-plaintext-1"),
    });
    expect(() => assertLc4XaiManualTurnReplayProjection(tamperedReplay as JsonValue))
      .toThrow(/causality/u);

    const forged = {
      ...causality,
      response_create_sequence: causality.commit_ack_sequence,
    } as Lc4XaiManualTurnCausalityEvidence;
    expect(() => assertLc4XaiManualTurnCausality(forged, evidence.wire_observations))
      .toThrow(/causality/u);
    expect(evidence.operation_order).toEqual([
      "caller_pcm_delivery_started",
      "caller_pcm_delivery_completed",
      "response_plan_prepared",
      "caller_pcm_committed",
      "caller_pcm_commit_acknowledged",
      "response_generation_requested",
      "assistant_pcm_captured",
      "listener_evidence_handed_off",
    ]);
    expect(events.filter((event) => event === "commit")).toHaveLength(1);
    expect(events.filter((event) => event === "commit-ack")).toHaveLength(1);
    expect(events.filter((event) => event === "create")).toHaveLength(1);
    expect(events).not.toContain("session-update");
    expect(client.appendedAudio).toHaveLength(1);
    expect(client.appendedAudio[0]?.data).toEqual(fixture.caller_pcm);
    expect(evidence.dev_assistant_conversation_transcript)
      .toBe("Exact assistant speech reconstructed from captured PCM.");
    expect(evidence.dev_assistant_conversation_transcript_source)
      .toBe("listener_exact_captured_pcm_asr");
    expect(evidence.provider_output_transcript_sha256)
      .toBe(sha256Hex("Provider-native assistant transcript 1."));

    const repairDecisionReceiptSha256 = sha256Hex("xai-manual-repair-decision");
    const repairEvidence = await fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
      playback_kind: "repair",
      repair_binding: {
        decision_receipt_sha256: repairDecisionReceiptSha256,
        repair_pcm_id: "xai-manual-repair-pcm",
        pcm_sha256: sha256Hex(fixture.caller_pcm),
        pcm_byte_length: fixture.caller_pcm.byteLength,
        sample_rate_hz: 24_000,
      },
    });
    expect(repairEvidence.playback_kind).toBe("repair");
    expect(repairEvidence.xai_manual_turn_causality).not.toBeNull();
    expect(repairEvidence.xai_manual_turn_causality!.commit_sequence)
      .toBeGreaterThan(causality.response_start_sequence);
    expect(repairEvidence.provider_output_transcript_sha256)
      .toBe(sha256Hex("Provider-native assistant transcript 2."));
    expect(repairEvidence.provider_output_transcript_sha256)
      .not.toBe(evidence.provider_output_transcript_sha256);
    expect(assertLc4XaiManualTurnCausality(
      repairEvidence.xai_manual_turn_causality!,
      repairEvidence.wire_observations,
    )).toBe(repairEvidence.xai_manual_turn_causality);

    await fixture.session.finalizeOpportunity!({
      opportunity_id: fixture.opportunity_id,
      decision_receipt_sha256: repairDecisionReceiptSha256,
      repair_played: true,
    });
    await fixture.session.close();
  });

  it("rejects an xAI server-VAD client under the finite/manual execution profile before caller audio", async () => {
    const client = new FakeRealtimeClient(
      "xai",
      [],
      false,
      "completed",
      LC4_XAI_SERVER_VAD_SILENCE_TAIL.minimum_accepted_chunk_count,
      true,
    );
    await expect(openDevFailureFixture({ client })).rejects.toThrow(
      /client turn boundary differs from its declared transport profile/u,
    );
    expect(client.appendedAudio).toHaveLength(0);
  });

  it("rejects an xAI manual client under the interactive/server-VAD execution profile before caller audio", async () => {
    const client = new FakeRealtimeClient(
      "xai",
      [],
      false,
      "completed",
      null,
      false,
    );
    await expect(openDevFailureFixture({
      client,
      xaiTransportPurpose: "interactive_transport_qualification",
    })).rejects.toThrow(
      /client turn boundary differs from its declared transport profile/u,
    );
    expect(client.appendedAudio).toHaveLength(0);
  });

  it.each([
    ["response before commit acknowledgement", XaiResponseBeforeAckRealtimeClient],
    ["response after acknowledgement but before create", XaiResponseBeforeCreateRealtimeClient],
    ["missing normalized commit acknowledgement", XaiMissingCommitAckEventRealtimeClient],
    ["duplicate commit acknowledgement", XaiDuplicateCommitAckRealtimeClient],
    ["unsolicited server-VAD event", XaiUnsolicitedVadRealtimeClient],
  ] as const)("fails closed on xAI manual-turn %s", async (_case, Client) => {
    const client = new Client("xai", [], false, "completed", null, false);
    const fixture = await openDevFailureFixture({
      client,
    });
    const error = await caughtFailure(fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }));
    expect(["adapter_contract", "audio_delivery"]).toContain(error.failure.failure_class);
    expect(error.failure.response_completed).toBe(false);
    expect(error.failure.operation_order).not.toContain("response_completed");
    await caughtFailure(fixture.session.close());
  });

  it("fails immediately and distinctly when xAI exhausts the 100-frame delimiter after speech-start without native stop", async () => {
    let monotonicMs = 0;
    const events: string[] = [];
    const client = new FakeRealtimeClient("xai", events, false, "completed", null, true);
    const fixture = await openDevFailureFixture({
      client,
      xaiTransportPurpose: "interactive_transport_qualification",
      audioDeliveryRuntime: {
        monotonicNowMs: () => monotonicMs,
        async sleep(delayMs, signal) {
          if (signal.aborted) throw new Error("test delivery aborted");
          monotonicMs += delayMs;
        },
      },
    });
    const error = await caughtFailure(fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }));
    expect(error.failure).toMatchObject({
      failure_stage: "audio_append",
      failure_code: "server_vad_delimiter_exhausted",
      failure_class: "provider_external",
      caller_pcm_byte_length: fixture.caller_pcm.byteLength,
      caller_pcm_appended_byte_length: fixture.caller_pcm.byteLength,
      response_generation_requested: false,
      response_generation_started: false,
      response_completed: false,
    });
    expect(error.failure.operation_order).toEqual([
      "response_plan_session_update_sent",
      "response_plan_session_update_acknowledged",
      "caller_pcm_delivery_started",
      "server_vad_speech_started",
      "caller_pcm_delivery_completed",
      "server_vad_silence_tail_delivery_started",
      "server_vad_silence_tail_delivery_exhausted",
    ]);
    expect(error.failure.server_vad_delimiter_exhaustion).toMatchObject({
      completion: "full_plan_delivered",
      policy_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
      pcm_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256,
      audio_bytes: LC4_XAI_SERVER_VAD_SILENCE_TAIL.byte_length,
      duration_ms: LC4_XAI_SERVER_VAD_SILENCE_TAIL.duration_ms,
      chunk_count: LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count,
      frame_bytes: 960,
      tail_bytes: 960,
    });
    expect(() => createLc4DevFailureEvidence({
      ...error.failure,
      server_vad_delimiter_exhaustion: {
        ...error.failure.server_vad_delimiter_exhaustion!,
        chunk_count: LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count - 1,
      },
    })).toThrow(/exact hard-cap commitment/u);
    expect(client.appendedAudio).toHaveLength(1 + LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count);
    expect(events.filter((event) => event === "connect")).toHaveLength(1);
    expect(events.filter((event) => event === "commit")).toHaveLength(0);
    expect(events.filter((event) => event === "create")).toHaveLength(0);
    await caughtFailure(fixture.session.close());
  });

  it("retains exact full-cap failure evidence when xAI never emits speech-start", async () => {
    let monotonicMs = 0;
    const events: string[] = [];
    const client = new FakeRealtimeClient("xai", events, false, "completed", null, true, false);
    const fixture = await openDevFailureFixture({
      client,
      xaiTransportPurpose: "interactive_transport_qualification",
      audioDeliveryRuntime: {
        monotonicNowMs: () => monotonicMs,
        async sleep(delayMs, signal) {
          if (signal.aborted) throw new Error("test delivery aborted");
          monotonicMs += delayMs;
        },
      },
    });
    const error = await caughtFailure(fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }));
    expect(error.failure).toMatchObject({
      failure_stage: "audio_append",
      failure_code: "server_vad_delimiter_exhausted",
      failure_class: "provider_external",
      caller_pcm_byte_length: fixture.caller_pcm.byteLength,
      caller_pcm_appended_byte_length: fixture.caller_pcm.byteLength,
      response_generation_requested: false,
      response_generation_started: false,
      response_terminal_observed: false,
      response_completed: false,
      output_pcm_byte_length: 0,
      gateway_batch_count: 0,
      gateway_fatal_class: "none",
    });
    expect(error.failure.operation_order).toEqual([
      "response_plan_session_update_sent",
      "response_plan_session_update_acknowledged",
      "caller_pcm_delivery_started",
      "caller_pcm_delivery_completed",
      "server_vad_silence_tail_delivery_started",
      "server_vad_silence_tail_delivery_exhausted",
    ]);
    expect(error.failure.server_vad_delimiter_exhaustion).toMatchObject({
      completion: "full_plan_delivered",
      policy_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
      pcm_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256,
      audio_bytes: LC4_XAI_SERVER_VAD_SILENCE_TAIL.byte_length,
      duration_ms: LC4_XAI_SERVER_VAD_SILENCE_TAIL.duration_ms,
      chunk_count: LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count,
      frame_bytes: 960,
      tail_bytes: 960,
      scheduled_offsets_ms: Array.from(
        { length: LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count },
        (_, index) => index * LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_ms,
      ),
    });
    expect(client.appendedAudio).toHaveLength(1 + LC4_XAI_SERVER_VAD_SILENCE_TAIL.chunk_count);
    expect(events.filter((event) => event === "commit")).toHaveLength(0);
    expect(events.filter((event) => event === "create")).toHaveLength(0);
    await caughtFailure(fixture.session.close());
  });

  it.each(["native", "hacc"] as const)(
    "accepts delayed xAI stop at frame 55 with byte-exact delimiter evidence in the %s arm",
    async (arm) => {
      let monotonicMs = 0;
      const client = new FakeRealtimeClient("xai", [], false, "completed", 55, true);
      const fixture = await openDevFailureFixture({
        client,
        xaiTransportPurpose: "interactive_transport_qualification",
        arm,
        audioDeliveryRuntime: {
          monotonicNowMs: () => monotonicMs,
          async sleep(delayMs, signal) {
            if (signal.aborted) throw new Error("test delivery aborted");
            monotonicMs += delayMs;
          },
        },
      });
      const nativeInstructions = "Use the public native-context fixture and the common gateway.";
      const evidence = await fixture.session.exchange({
        opportunity_id: fixture.opportunity_id,
        caller_pcm: fixture.caller_pcm,
        response_control: arm === "hacc"
          ? { kind: "hacc_response_plan", plan: responsePlan() }
          : {
              kind: "native_context",
              instructions: nativeInstructions,
              instructions_sha256: sha256Hex(nativeInstructions),
            },
      });
      expect(evidence.server_vad_transport_suffix).toMatchObject({
        completion: "provider_native_speech_stop",
        audio_bytes: 55 * 960,
        duration_ms: 1_100,
        chunk_count: 55,
        pcm_sha256: sha256Hex(new Uint8Array(55 * 960)),
      });
      expect(evidence.input_audio_delivery.pcm_sha256).toBe(sha256Hex(fixture.caller_pcm));
      expect(client.appendedAudio.slice(1)).toHaveLength(55);
      expect(client.appendedAudio.slice(1).every((chunk) => chunk.data.every((byte) => byte === 0))).toBe(true);
      expect(client.events.filter((event) => event === "commit")).toHaveLength(0);
      expect(client.events.filter((event) => event === "create")).toHaveLength(0);
      await fixture.session.finalizeOpportunity!({
        opportunity_id: fixture.opportunity_id,
        decision_receipt_sha256: sha256Hex(`delayed-stop-${arm}`),
        repair_played: false,
      });
      await fixture.session.close();
    },
  );

  it("rejects an xAI speech stop before the frozen minimum delimiter without fallback generation", async () => {
    let monotonicMs = 0;
    const events: string[] = [];
    const client = new FakeRealtimeClient(
      "xai",
      events,
      false,
      "completed",
      LC4_XAI_SERVER_VAD_SILENCE_TAIL.minimum_accepted_chunk_count - 1,
      true,
    );
    const fixture = await openDevFailureFixture({
      client,
      xaiTransportPurpose: "interactive_transport_qualification",
      audioDeliveryRuntime: {
        monotonicNowMs: () => monotonicMs,
        async sleep(delayMs, signal) {
          if (signal.aborted) throw new Error("test delivery aborted");
          monotonicMs += delayMs;
        },
      },
    });
    const error = await caughtFailure(fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }));
    expect(error.failure).toMatchObject({
      failure_stage: "audio_append",
      failure_code: "audio_delivery_failed",
      failure_class: "audio_delivery",
      caller_pcm_appended_byte_length: fixture.caller_pcm.byteLength,
    });
    expect(error.failure.operation_order).toContain("server_vad_silence_tail_delivery_started");
    expect(error.failure.operation_order).not.toContain("server_vad_silence_tail_prefix_accepted");
    expect(client.appendedAudio).toHaveLength(
      1 + LC4_XAI_SERVER_VAD_SILENCE_TAIL.minimum_accepted_chunk_count - 1,
    );
    expect(events.filter((event) => event === "connect")).toHaveLength(1);
    expect(events.filter((event) => event === "commit")).toHaveLength(0);
    expect(events.filter((event) => event === "create")).toHaveLength(0);
    await caughtFailure(fixture.session.close());
  });

  it("retains partial output commitments when the listener handoff fails", async () => {
    const fixture = await openDevFailureFixture({
      client: new SynchronousHostCloseRealtimeClient("openai", []),
      async listener() { throw new Error("listener private transcript SENTINEL"); },
    });
    const error = await caughtFailure(fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }));
    expect(error.failure).toMatchObject({
      failure_stage: "listener_handoff",
      failure_code: "listener_failed",
      failure_class: "listener",
      response_generation_requested: true,
      response_generation_started: true,
      response_terminal_observed: true,
      response_completed: true,
      output_pcm_byte_length: 4,
      output_pcm_chunk_count: 1,
    });
    expect(error.failure.output_pcm_sha256).toBe(sha256Hex(new Uint8Array([1, 0, 2, 0])));
    expect(canonicalJson(error.failure)).not.toContain("SENTINEL");
    await caughtFailure(fixture.session.close());
  });

  it("sanitizes evidence-assembly failures after a completed provider response", async () => {
    const cyclicEvidence: Record<string, unknown> = {
      private_transcript: "SENTINEL",
    };
    cyclicEvidence.self = cyclicEvidence;
    const transcript =
      "Exact assistant speech reconstructed from captured PCM.";
    const listenerResult = {
      listener_evidence_sha256: sha256Hex("cyclic-listener-evidence"),
      listener_evidence: cyclicEvidence,
      repair_projection: createLc4DevArmBlindRepairProjection({
        opportunity_id: "lc4-dev-op-01",
        listener_status: "verified",
        semantic_result_sha256: sha256Hex("cyclic-semantic-result"),
        semantic_replay_sha256: sha256Hex("cyclic-semantic-replay"),
        unmet_blocker_codes: [],
        final_required_criteria_pass: true,
      }),
      playback_authority_receipt_sha256:
        sha256Hex("cyclic-playback-authority"),
      assistant_conversation_transcript: transcript,
      assistant_conversation_transcript_sha256: sha256Hex(transcript),
      assistant_conversation_transcript_source:
        "listener_exact_captured_pcm_asr" as const,
    };
    const fixture = await openDevFailureFixture({
      client: new FakeRealtimeClient("openai", []),
      listener: async () => listenerResult as never,
    });
    const error = await caughtFailure(fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }));
    expect(error.failure).toMatchObject({
      failure_stage: "exchange_evidence",
      failure_code: "evidence_assembly_failed",
      failure_class: "evidence_retention",
      response_generation_requested: true,
      response_generation_started: true,
      response_terminal_observed: true,
      response_completed: true,
      output_pcm_byte_length: 4,
    });
    expect(error.failure.operation_order.at(-1)).toBe("listener_evidence_handed_off");
    expect(canonicalJson(error.failure)).not.toContain("SENTINEL");
    await caughtFailure(fixture.session.close());
  });

  it("emits cleanup evidence instead of a rotation receipt for an unfinalized success", async () => {
    const fixture = await openDevFailureFixture({ client: new FakeRealtimeClient("openai", []) });
    await fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    });
    const closeError = await caughtFailure(fixture.session.close());
    expect(closeError.failure).toMatchObject({
      failure_role: "cleanup",
      failure_stage: "segment_close",
      failure_code: "segment_close_failed",
      failure_class: "cleanup",
      response_generation_requested: false,
      response_generation_started: false,
      response_completed: false,
      output_pcm_byte_length: 0,
    });
  });

  it("keeps the success path replayable after failure instrumentation", async () => {
    const fixture = await openDevFailureFixture({ client: new FakeRealtimeClient("openai", []) });
    const evidence = await fixture.session.exchange({
      opportunity_id: fixture.opportunity_id,
      caller_pcm: fixture.caller_pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    });
    expect(evidence.operation_order.at(-1)).toBe("listener_evidence_handed_off");
    await fixture.session.finalizeOpportunity!({
      opportunity_id: fixture.opportunity_id,
      decision_receipt_sha256: sha256Hex("failure-fixture-no-repair"),
      repair_played: false,
    });
    await expect(fixture.session.close()).resolves.toHaveProperty("rotation_receipt_sha256");
  });

  it("delivers PCM, response plan, commit, generation, capture, and listener handoff in order", async () => {
    const value = manifest();
    const events: string[] = [];
    const clients: FakeRealtimeClient[] = [];
    const bridge = new Lc4RealtimeProviderBridge((provider) => {
      const client = new FakeRealtimeClient(provider, events);
      clients.push(client);
      return client;
    });
    const handoffs: unknown[] = [];
    const session = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: null,
      listener: { accept(input) { events.push("listener"); handoffs.push(input); } },
    });
    const evidence = await session.exchange({
      opportunity_id: "op-01",
      caller_pcm: new Uint8Array([1, 7, 11, 13]),
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    });
    expect(events).toEqual(["connect", "append", "prepare", "commit", "create", "listener"]);
    expect(evidence.operation_order).toEqual([
      "caller_pcm_delivery_started",
      "caller_pcm_delivery_completed",
      "response_plan_prepared",
      "caller_pcm_committed",
      "response_generation_requested",
      "assistant_pcm_captured",
      "listener_evidence_handed_off",
    ]);
    expect(evidence.output_capture.generated_byte_length).toBe(4);
    expect(handoffs).toHaveLength(1);
    const delivered = clients[0]?.preparations[0]?.additionalInstructions ?? "";
    const authoritativePlan = responsePlan();
    expect(delivered).toContain(`\"plan_sha256\":\"${authoritativePlan.plan_sha256}\"`);
    expect(delivered).toContain(
      `\"capability_catalog_sha256\":\"${authoritativePlan.capability_catalog_sha256}\"`,
    );
    expect(delivered).toContain("\"eligible_semantic_intents\"");
    expect(delivered).not.toContain("\"eligible_actions\"");
    for (const action of authoritativePlan.eligible_actions) {
      expect(delivered).not.toContain(`\"${action}\"`);
    }
    expect(delivered).not.toContain("\"capability_catalog\"");
    expect(delivered).not.toContain("\"input_schema\"");
    expect(delivered).not.toContain("test-grant-");
    const encoded = JSON.stringify(evidence);
    expect(encoded).not.toContain(ORACLE_SECRET);
    expect(encoded).not.toContain("provider-response-plaintext");
    await session.close();
  });

  it.each([
    { provider: "openai" as const, frameBytes: 960, chunkCount: 206, tailBytes: 300, finalOffsetMs: 4_100 },
    { provider: "xai" as const, frameBytes: 960, chunkCount: 206, tailBytes: 300, finalOffsetMs: 4_100 },
    { provider: "gemini" as const, frameBytes: 640, chunkCount: 308, tailBytes: 620, finalOffsetMs: 6_140 },
  ])("paces byte-exact 20ms packets with a real-size nonaligned tail for $provider", async ({
    provider, frameBytes, chunkCount, tailBytes, finalOffsetMs,
  }) => {
    const pcm = Uint8Array.from({ length: 197_100 }, (_, index) => index % 251);
    const value = bindFirstOpportunityPcm(manifest("hacc", provider), pcm);
    const events: string[] = [];
    const sleeps: number[] = [];
    let monotonicMs = 0;
    let fake: FakeRealtimeClient | null = null;
    const bridge = new Lc4RealtimeProviderBridge((clientProvider) => {
      fake = new FakeRealtimeClient(clientProvider, events);
      return fake;
    }, {
      monotonicNowMs: () => monotonicMs,
      async sleep(delayMs, signal) {
        if (signal.aborted) throw new Error("test delivery aborted");
        sleeps.push(delayMs);
        monotonicMs += delayMs;
      },
    });
    const session = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: null,
      listener: { accept() { events.push("listener"); } },
    });
    const evidence = await session.exchange({
      opportunity_id: "op-01",
      caller_pcm: pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    });

    const allDelivered = fake!.appendedAudio;
    const delivered = allDelivered.slice(0, chunkCount);
    expect(delivered).toHaveLength(chunkCount);
    expect(delivered.slice(0, -1).every((chunk) => chunk.data.byteLength === frameBytes)).toBe(true);
    expect(delivered.at(-1)?.data.byteLength).toBe(tailBytes);
    expect(delivered.every((chunk) => (
      chunk.encoding === "pcm16"
      && chunk.channels === 1
      && chunk.sampleRateHz === value.episode_shape.provider_profile.input_sample_rate_hz
    ))).toBe(true);
    expect(Buffer.concat(delivered.map((chunk) => Buffer.from(chunk.data))).equals(Buffer.from(pcm))).toBe(true);
    expect(sleeps).toHaveLength(chunkCount - 1);
    expect(sleeps.every((delay) => delay === 20)).toBe(true);
    expect(evidence.input_audio_delivery).toMatchObject({
      frame_byte_length: frameBytes,
      chunk_count: chunkCount,
      total_byte_length: pcm.byteLength,
      tail_byte_length: tailBytes,
      last_scheduled_offset_ms: finalOffsetMs,
      media_duration_ms: pcm.byteLength / 2 / value.episode_shape.provider_profile.input_sample_rate_hz * 1_000,
      pcm_sha256: sha256Hex(pcm),
      profile_sha256: configuration(value).audioDeliveryProfileHash,
    });
    expect(evidence.input_audio_delivery.chunks.map((chunk) => chunk.appended_at_offset_ms)).toEqual(
      Array.from({ length: chunkCount }, (_, index) => index * 20),
    );
    const appendStart = 1;
    expect(events.slice(appendStart, appendStart + chunkCount)).toEqual(
      Array.from({ length: chunkCount }, () => "append"),
    );
    expect(events.slice(appendStart + chunkCount)).toEqual(provider === "xai"
      ? ["prepare", "commit", "commit-ack", "create", "listener"]
      : ["prepare", "commit", "create", "listener"]);
    if (provider === "xai") {
      expect(allDelivered).toHaveLength(chunkCount);
      expect(events.filter((event) => event === "commit")).toHaveLength(1);
      expect(events.filter((event) => event === "create")).toHaveLength(1);
      expect(evidence.transport_mode).toBe("manual_commit");
      expect(evidence.input_audio_delivery.total_byte_length).toBe(pcm.byteLength);
      expect(evidence.server_vad_transport_suffix).toBeNull();
      expect(evidence.operation_order).toEqual([
        "caller_pcm_delivery_started",
        "caller_pcm_delivery_completed",
        "response_plan_prepared",
        "caller_pcm_committed",
        "caller_pcm_commit_acknowledged",
        "response_generation_requested",
        "assistant_pcm_captured",
        "listener_evidence_handed_off",
      ]);
    } else {
      expect(events.filter((event) => event === "commit")).toHaveLength(1);
      expect(events.filter((event) => event === "create")).toHaveLength(1);
    }
    await session.close();
  }, 15_000);

  it("snapshots caller PCM before pacing so provider delivery and evidence retain one byte identity", async () => {
    const pcm = Uint8Array.from({ length: 2_100 }, (_, index) => (index % 250) + 1);
    const expected = Uint8Array.from(pcm);
    const value = bindFirstOpportunityPcm(manifest(), expected);
    let monotonicMs = 0;
    let fake: FakeRealtimeClient | null = null;
    const bridge = new Lc4RealtimeProviderBridge((provider) => {
      fake = new FakeRealtimeClient(provider, []);
      return fake;
    }, {
      monotonicNowMs: () => monotonicMs,
      async sleep(delayMs) {
        pcm.fill(0);
        monotonicMs += delayMs;
      },
    });
    const session = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: null,
      listener: { accept() {} },
    });
    const evidence = await session.exchange({
      opportunity_id: "op-01",
      caller_pcm: pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    });
    const delivered = Buffer.concat(fake!.appendedAudio.map((chunk) => Buffer.from(chunk.data)));
    expect(delivered.equals(Buffer.from(expected))).toBe(true);
    expect(delivered.equals(Buffer.from(pcm))).toBe(false);
    expect(evidence.caller_pcm_sha256).toBe(sha256Hex(expected));
    expect(evidence.input_audio_delivery.pcm_sha256).toBe(sha256Hex(expected));
    await session.close();
  });

  it.each(["openai", "xai", "gemini"] as const)(
    "poisons the %s segment when delivery is cancelled between packets",
    async (provider) => {
      const base = manifest("hacc", provider);
      const pcm = Uint8Array.from({ length: base.episode_shape.provider_profile.input_sample_rate_hz / 25 * 2 }, (_, index) => index % 251);
      const value = bindFirstOpportunityPcm(base, pcm);
      const events: string[] = [];
      const abort = new AbortController();
      const bridge = new Lc4RealtimeProviderBridge(
        (clientProvider) => new FakeRealtimeClient(clientProvider, events),
        {
          monotonicNowMs: () => 0,
          async sleep(_delayMs, signal) {
            abort.abort();
            if (signal.aborted) throw new Error("test delivery aborted");
          },
        },
      );
      const session = await bridge.openSegment({
        manifest: value,
        segment: value.episode_shape.segments[0]!,
        profile: value.episode_shape.provider_profile,
        configuration: configuration(value),
        rotation_context: null,
        listener: { accept() { events.push("listener"); } },
      });
      let caught: unknown;
      try {
        await session.exchange({
          opportunity_id: "op-01",
          caller_pcm: pcm,
          response_control: { kind: "hacc_response_plan", plan: responsePlan() },
          signal: abort.signal,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Lc4ProviderInputAudioDeliveryError);
      expect((caught as Lc4ProviderInputAudioDeliveryError).diagnostic).toMatchObject({
        stage: "caller_audio_delivery",
        code: "aborted",
        provider,
        expected_pcm_byte_length: pcm.byteLength,
        appended_chunk_count: 1,
        appended_pcm_byte_length: base.episode_shape.provider_profile.input_sample_rate_hz * 20 / 1_000 * 2,
        response_prepared: false,
        input_committed: false,
        response_requested: false,
      });
      expect(events).toEqual(["connect", "append", "close"]);
      await expect(session.exchange({
        opportunity_id: "op-01",
        caller_pcm: pcm,
        response_control: { kind: "hacc_response_plan", plan: responsePlan() },
      })).rejects.toThrow("session is not open");
      await expect(session.close()).rejects.toThrow("already closed");
    },
  );

  it("aborts an in-flight paced delivery on close without minting a rotation receipt", async () => {
    const base = manifest();
    const pcm = Uint8Array.from({ length: 1_920 }, (_, index) => index % 251);
    const value = bindFirstOpportunityPcm(base, pcm);
    const events: string[] = [];
    let notifySleepStarted: (() => void) | undefined;
    const sleepStarted = new Promise<void>((resolve) => { notifySleepStarted = resolve; });
    const bridge = new Lc4RealtimeProviderBridge(
      (provider) => new FakeRealtimeClient(provider, events),
      {
        monotonicNowMs: () => 0,
        sleep(_delayMs, signal) {
          notifySleepStarted?.();
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("segment closed")), { once: true });
          });
        },
      },
    );
    const session = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: null,
      listener: { accept() { events.push("listener"); } },
    });
    const exchangeResult = session.exchange({
      opportunity_id: "op-01",
      caller_pcm: pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }).then(() => null, (error: unknown) => error);
    await sleepStarted;
    await expect(session.close()).rejects.toThrow("without a rotation receipt");
    expect(await exchangeResult).toBeInstanceOf(Lc4ProviderInputAudioDeliveryError);
    expect(events).toEqual(["connect", "append", "close"]);
  });

  it("poisons a provider buffer when response preparation fails after audio append", async () => {
    const value = manifest();
    const events: string[] = [];
    const bridge = new Lc4RealtimeProviderBridge(
      (provider) => new PrepareFailureRealtimeClient(provider, events),
    );
    const session = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: null,
      listener: { accept() { events.push("listener"); } },
    });
    await expect(session.exchange({
      opportunity_id: "op-01",
      caller_pcm: new Uint8Array([1, 7, 11, 13]),
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    })).rejects.toThrow("injected response preparation failure");
    expect(events).toEqual(["connect", "append", "prepare", "close"]);
    await expect(session.close()).rejects.toThrow("already closed");
  });

  it("cannot publish success when close races a pending listener handoff", async () => {
    const value = manifest();
    const events: string[] = [];
    let notifyListenerStarted: (() => void) | undefined;
    let releaseListener: (() => void) | undefined;
    const listenerStarted = new Promise<void>((resolve) => { notifyListenerStarted = resolve; });
    const listenerPending = new Promise<void>((resolve) => { releaseListener = resolve; });
    const bridge = new Lc4RealtimeProviderBridge(
      (provider) => new FakeRealtimeClient(provider, events),
    );
    const session = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: null,
      listener: {
        async accept() {
          events.push("listener-start");
          notifyListenerStarted?.();
          await listenerPending;
          events.push("listener-finish");
        },
      },
    });
    const exchangeResult = session.exchange({
      opportunity_id: "op-01",
      caller_pcm: new Uint8Array([1, 7, 11, 13]),
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }).then((evidence) => evidence, (error: unknown) => error);
    await listenerStarted;
    await expect(session.close()).rejects.toThrow("without a rotation receipt");
    releaseListener?.();
    const result = await exchangeResult;
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toHaveProperty("evidence_sha256");
    expect(events).toEqual(["connect", "append", "prepare", "commit", "create", "listener-start", "close", "listener-finish"]);
  });

  it("rejects an unbound audio-delivery profile before opening a provider connection", async () => {
    const value = manifest();
    let factoryCalls = 0;
    const bridge = new Lc4RealtimeProviderBridge((provider) => {
      factoryCalls += 1;
      return new FakeRealtimeClient(provider, []);
    });
    await expect(bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: Object.freeze({ ...configuration(value), audioDeliveryProfileHash: HASH }),
      rotation_context: null,
      listener: { accept() {} },
    })).rejects.toThrow("frozen production provider profile");
    expect(factoryCalls).toBe(0);
  });

  it.each([
    {
      name: "context authority",
      provider: "openai" as const,
      forge: (profile: Lc4ProviderExecutionProfile) => Object.freeze({
        ...profile,
        context_authority: "forged_self_asserted_authority",
      }) as Lc4ProviderExecutionProfile,
    },
    {
      name: "provider profile digest",
      provider: "openai" as const,
      forge: (profile: Lc4ProviderExecutionProfile) => Object.freeze({
        ...profile,
        provider_profile_sha256: "f".repeat(64),
      }) as Lc4ProviderExecutionProfile,
    },
    {
      name: "provider voice",
      provider: "openai" as const,
      forge: (profile: Lc4ProviderExecutionProfile) => Object.freeze({
        ...profile,
        voice: "forged-voice",
      }) as Lc4ProviderExecutionProfile,
    },
    {
      name: "input sample rate",
      provider: "openai" as const,
      forge: (profile: Lc4ProviderExecutionProfile) => Object.freeze({
        ...profile,
        input_sample_rate_hz: 16_000,
      }) as Lc4ProviderExecutionProfile,
    },
    {
      name: "output sample rate",
      provider: "openai" as const,
      forge: (profile: Lc4ProviderExecutionProfile) => Object.freeze({
        ...profile,
        output_sample_rate_hz: 16_000,
      }) as Lc4ProviderExecutionProfile,
    },
    {
      name: "transport mode",
      provider: "xai" as const,
      forge: (profile: Lc4ProviderExecutionProfile) => Object.freeze({
        ...profile,
        transport_mode: "provider_native_server_vad",
      }) as Lc4ProviderExecutionProfile,
    },
    {
      name: "transport purpose",
      provider: "xai" as const,
      forge: (profile: Lc4ProviderExecutionProfile) => Object.freeze({
        ...profile,
        transport_purpose: "interactive_transport_qualification",
      }) as Lc4ProviderExecutionProfile,
    },
    {
      name: "transport profile digest",
      provider: "xai" as const,
      forge: (profile: Lc4ProviderExecutionProfile) => Object.freeze({
        ...profile,
        transport_profile_sha256: "e".repeat(64),
      }) as Lc4ProviderExecutionProfile,
    },
    {
      name: "turn boundary",
      provider: "xai" as const,
      forge: (profile: Lc4ProviderExecutionProfile) => Object.freeze({
        ...profile,
        turn_boundary: "forged_turn_boundary",
      }) as Lc4ProviderExecutionProfile,
    },
    {
      name: "complete self-consistent alternate transport profile",
      provider: "xai" as const,
      forge: () => createLc4ProviderExecutionProfile(
        "xai",
        "interactive_transport_qualification",
      ),
    },
  ])(
    "rejects a forged $name even when the manifest repeats it exactly",
    async ({ provider, forge }) => {
      const value = manifest("hacc", provider);
      const forgedProfile = forge(value.episode_shape.provider_profile);
      const forgedManifest = forgeManifestProviderProfile(value, forgedProfile);
      let factoryCalls = 0;
      const bridge = new Lc4RealtimeProviderBridge((runtimeProvider) => {
        factoryCalls += 1;
        return new FakeRealtimeClient(runtimeProvider, []);
      });
      await expect(bridge.openSegment({
        manifest: forgedManifest,
        segment: forgedManifest.episode_shape.segments[0]!,
        profile: forgedProfile,
        configuration: configuration(value),
        rotation_context: null,
        listener: { accept() {} },
      })).rejects.toThrow("frozen production provider profile");
      expect(factoryCalls).toBe(0);
    },
  );

  it.each([
    {
      name: "condition assigned to the opposite randomized arm",
      mutate: (base: TrialSessionConfiguration) => Object.freeze({
        ...base,
        conditionId: "raw-full" as const,
      }),
    },
    {
      name: "self-described provider tool catalog",
      mutate: (base: TrialSessionConfiguration) => Object.freeze({
        ...base,
        providerTools: Object.freeze([Object.freeze({
          ...LOCAL_TOOL_PROXY_FUNCTION,
          description: `${LOCAL_TOOL_PROXY_FUNCTION.description} forged`,
        })]),
      }),
    },
  ])("rejects a forged $name before opening a provider connection", async ({ mutate }) => {
    const value = manifest("hacc", "openai");
    let factoryCalls = 0;
    const bridge = new Lc4RealtimeProviderBridge((provider) => {
      factoryCalls += 1;
      return new FakeRealtimeClient(provider, []);
    });
    await expect(bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: mutate(configuration(value)),
      rotation_context: null,
      listener: { accept() {} },
    })).rejects.toThrow("frozen production provider profile");
    expect(factoryCalls).toBe(0);
  });

  it.each(["failed", "incomplete", "interrupted", "cancelled"] as const)(
    "rejects a Gemini %s terminal even when the provider emitted PCM",
    async (terminalStatus) => {
      const value = manifest("hacc", "gemini");
      const bridge = new Lc4RealtimeProviderBridge(
        (provider) => new FakeRealtimeClient(provider, [], false, terminalStatus),
      );
      const session = await bridge.openSegment({
        manifest: value,
        segment: value.episode_shape.segments[0]!,
        profile: value.episode_shape.provider_profile,
        configuration: configuration(value),
        rotation_context: null,
        listener: { accept() { throw new Error("failed provider turn must not reach listener"); } },
      });
      await expect(session.exchange({
        opportunity_id: "op-01",
        caller_pcm: new Uint8Array([1, 7, 11, 13]),
        response_control: { kind: "hacc_response_plan", plan: responsePlan() },
      })).rejects.toThrow(`provider response ended with ${terminalStatus}`);
    },
  );

  it.each(["openai", "gemini", "xai"] as const)(
    "keeps a DEV %s tool response intermediate, executes the injected gateway, and continues exactly once",
    async (provider) => {
    const base = manifest("hacc", provider);
    const corpus = createLc4PublicDevelopmentCorpus();
    const episode: Lc4DevLiveEpisodePlan = Object.freeze({
      episode_id: `lc4-dev-${base.episode_shape.provider}-hacc`,
      pair_id: `lc4-dev-${base.episode_shape.provider}`,
      pair_position: 2,
      provider: base.episode_shape.provider,
      arm: "hacc",
      model: base.episode_shape.provider_profile.model,
      voice: base.episode_shape.provider_profile.voice,
      maximum_micro_usd: 1_000,
      opportunity_binding_set_sha256: HASH,
    });
    const devManifest: Lc4RealtimeEpisodeManifest = Object.freeze({
      protocol_id: "HACC-LC4-DEV-v1",
      run_id: episode.episode_id,
      episode_shape: Object.freeze({
        provider: episode.provider,
        arm: episode.arm,
        provider_profile: base.episode_shape.provider_profile,
      }),
      opportunities: Object.freeze(corpus.opportunities.map((opportunity, index) => {
        const pcm = new Uint8Array([index + 1, 7, 11, 13]);
        return Object.freeze({
          ordinal: index + 1,
          opportunity_id: opportunity.id,
          segment_ordinal: Math.ceil((index + 1) / 20) as 1 | 2 | 3,
          caller_pcm_sha256: sha256Hex(pcm),
          caller_pcm_byte_length: pcm.byteLength,
          opportunity_contract_sha256: sha256Hex(`dev-contract-${index + 1}`),
        });
      })),
    });
    const executed: string[] = [];
    const gateway: Lc4DevGatewayExecutor = Object.freeze({
      kind: "lc4-dev-arm-aware-gateway-v1" as const,
      manifest_sha256: "d".repeat(64),
      currentResponsePreparation: fixtureContinuationPreparation,
      async execute(input) {
        executed.push(`${input.arm}:${input.target_tool}`);
        const providerOutput = { ok: true as const, receipt: "PUBLIC-RESULT" };
        const projectionBody = {
          schema_version: 1 as const,
          bridge_version: "lc4-dev-gateway-bridge-v3" as const,
          redaction: "public_dev_authority_no_raw_provider_ids_or_credentials" as const,
          episode_id: input.episode_id,
          opportunity_id: input.opportunity_id,
          opportunity_index: input.opportunity_index,
          provider: input.provider,
          arm: input.arm,
          semantic_intent: input.semantic_intent,
          target_tool: input.target_tool,
          provider_call_id_sha256: sha256Hex(input.provider_call_id),
          provider_response_id_sha256: sha256Hex(input.provider_response_id),
          request_sha256: input.request_sha256,
          provider_provenance_sha256: input.provider_provenance_sha256,
          model_arguments: input.target_arguments,
          effective_arguments: {},
          provider_output: providerOutput,
          authoritative_receipt: { ok: true },
          authoritative_tool_world_receipt: null,
          post_transition_response_plan: null,
          post_transition_response_control: null,
          post_transition_response_plan_sha256: null,
          post_transition_response_control_sha256: null,
          authoritative_receipt_sha256: "e".repeat(64),
          control_plane_head_sha256: "f".repeat(64),
          disposition: "executed" as const,
        };
        return {
          provider_output: providerOutput,
          authoritative_receipt_sha256: "e".repeat(64),
          control_plane_head_sha256: "f".repeat(64),
          disposition: "executed" as const,
          authority_projection: {
            ...projectionBody,
            projection_sha256: sha256Hex(`${AUTHORITY_PROJECTION_DOMAIN}${canonicalJson(projectionBody)}`),
          },
        };
      },
    });
    const events: string[] = [];
    const listenerEvidence = await replayEvidenceFixture().retainJson({
      kind: "listener_evidence",
      body: Object.freeze({ fixture: "dev-listener-evidence", provider }),
    });
    let fake: FakeRealtimeClient | null = null;
    const bridge = new Lc4RealtimeProviderBridge((provider) => {
      // xAI emits speech-stop, auto-response, and the tool call synchronously
      // between paced delimiter frames. Frame 56 must observe the post-stop
      // guard, preserve the accepted 55-frame prefix, and continue exactly
      // once without treating the pending tool turn as an append failure.
      fake = new FakeRealtimeClient(provider, events, true, "completed", provider === "xai" ? 55 : undefined);
      return fake;
    });
    const session = await bridge.openSegment({
      manifest: devManifest,
      segment: base.episode_shape.segments[0]!,
      profile: base.episode_shape.provider_profile,
      configuration: Object.freeze({
        ...configuration(base),
        providerTools: Object.freeze([LC4_DEV_SEMANTIC_GATEWAY_FUNCTION]),
      }),
      rotation_context: null,
      listener: {
        async accept() {
          events.push("listener");
          return {
            listener_evidence_sha256: listenerEvidence.evidence_sha256,
            listener_evidence: listenerEvidence,
            repair_projection: createLc4DevArmBlindRepairProjection({
              opportunity_id: corpus.opportunities[0]!.id,
              listener_status: "verified",
              semantic_result_sha256: sha256Hex("dev-semantic-result"),
              semantic_replay_sha256: sha256Hex("dev-semantic-replay"),
              unmet_blocker_codes: [],
              final_required_criteria_pass: true,
            }),
            playback_authority_receipt_sha256: sha256Hex("dev-playback-authority"),
            assistant_conversation_transcript: "DEV fixture assistant speech from captured PCM.",
            assistant_conversation_transcript_sha256: sha256Hex("DEV fixture assistant speech from captured PCM."),
            assistant_conversation_transcript_source: "listener_exact_captured_pcm_asr" as const,
          };
        },
      },
      dev_gateway: { episode, opportunities: corpus.opportunities, executor: gateway },
    });
    const evidence = await session.exchange({
      opportunity_id: corpus.opportunities[0]!.id,
      caller_pcm: new Uint8Array([1, 7, 11, 13]),
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    });

    expect(executed).toEqual(provider === "gemini"
      ? ["hacc:archive.complete_stage", "hacc:archive.complete_stage"]
      : ["hacc:archive.complete_stage"]);
    expect(events).toEqual(provider === "gemini"
      ? ["connect", "append", "prepare", "commit", "create", "prepare-continuation", "submit:false", "create", "prepare-continuation", "submit:false", "create", "listener"]
      : provider === "xai"
        ? ["connect", "append", "prepare", "commit", "commit-ack", "create", "prepare-continuation", "submit:false", "create", "listener"]
        : ["connect", "append", "prepare", "commit", "create", "prepare-continuation", "submit:false", "create", "listener"]);
    expect(fake!.submittedToolResults).toHaveLength(provider === "gemini" ? 2 : 1);
    expect(fake!.submittedToolResults[0]?.createResponse).toBe(false);
    expect(evidence.dev_gateway_receipt_set?.receipts).toHaveLength(provider === "gemini" ? 2 : 1);
    expect(evidence.output_capture).toMatchObject({
      generated_byte_length: 4,
      generated_pcm_sha256: sha256Hex(new Uint8Array([1, 0, 2, 0])),
    });
    expect(evidence.suppressed_unplayed_output).toMatchObject({
      policy: "exclude_everything_before_the_final_tool_batch_from_caller_heard_history",
      tool_dispatch_count: provider === "gemini" ? 2 : 1,
      response_count: provider === "gemini" ? 2 : 1,
      audio_chunk_count: provider === "gemini" ? 2 : 1,
      audio_byte_length: provider === "gemini" ? 4 : 2,
      audio_pcm_sha256: sha256Hex(
        provider === "gemini" ? new Uint8Array([9, 0, 8, 0]) : new Uint8Array([9, 0]),
      ),
      transcript_count: provider === "gemini" ? 2 : 1,
      caller_heard_audio_byte_length: 4,
      caller_heard_audio_pcm_sha256: sha256Hex(new Uint8Array([1, 0, 2, 0])),
    });
    expect(evidence.dev_gateway_conversation_tool_batches)
      .toHaveLength(provider === "gemini" ? 2 : 1);
    expect(canonicalJson(evidence.replay_projection))
      .not.toContain("dev_gateway_conversation_tool_batches");
    if (provider === "gemini") {
      expect(evidence.gemini_output_attribution).toMatchObject({
        output_audio_byte_length: 8,
        output_audio_pcm_sha256: sha256Hex(new Uint8Array([9, 0, 8, 0, 1, 0, 2, 0])),
      });
    }
    if (provider === "xai") {
      expect(evidence.transport_mode).toBe("manual_commit");
      expect(evidence.transport_purpose).toBe("finite_prerecorded_efficacy");
      expect(evidence.server_vad_transport_suffix).toBeNull();
      expect(evidence.operation_order).toContain("caller_pcm_committed");
      expect(evidence.operation_order).toContain("response_generation_requested");
      expect(events.filter((event) => event === "commit")).toHaveLength(1);
      expect(events.filter((event) => event === "create")).toHaveLength(2);
      expect(events.filter((event) => event === "connect")).toHaveLength(1);
    }
    expect(JSON.stringify(evidence.dev_gateway_receipt_set?.receipts)).not.toContain("PUBLIC-17");
    expect(JSON.stringify(evidence.dev_gateway_receipt_set?.receipts)).not.toContain("PUBLIC-RESULT");
    expect(JSON.stringify(evidence.dev_gateway_receipt_set?.authority_projections)).toContain("PUBLIC-RESULT");
    await session.finalizeOpportunity!({
      opportunity_id: corpus.opportunities[0]!.id,
      decision_receipt_sha256: sha256Hex("dev-no-repair-decision"),
      repair_played: false,
    });
    await session.close();
    },
  );

  it("requires close-before-open rotation and chains three segment session receipts", async () => {
    const value = manifest();
    const events: string[] = [];
    const configurations: TrialSessionConfiguration[] = [];
    const bridge = new Lc4RealtimeProviderBridge((provider, providerConfiguration) => {
      configurations.push(providerConfiguration);
      return new FakeRealtimeClient(provider, events);
    });
    const input = (ordinal: 1 | 2 | 3, rotationContext: Lc4RotationContext | null) => ({
      manifest: value,
      segment: value.episode_shape.segments[ordinal - 1]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: rotationContext,
      listener: { accept() {} },
    });
    const first = await bridge.openSegment(input(1, null));
    await expect(bridge.openSegment(input(2, null))).rejects.toThrow("must close before rotation");
    const firstReceipt = await first.close();
    const second = await bridge.openSegment(input(2, haccRotationContext(value, firstReceipt.rotation_receipt_sha256, 1)));
    const secondReceipt = await second.close();
    const third = await bridge.openSegment(input(3, haccRotationContext(value, secondReceipt.rotation_receipt_sha256, 2)));
    const thirdReceipt = await third.close();
    expect([firstReceipt.session_ordinal, secondReceipt.session_ordinal, thirdReceipt.session_ordinal]).toEqual([1, 2, 3]);
    expect(new Set([firstReceipt.rotation_receipt_sha256, secondReceipt.rotation_receipt_sha256, thirdReceipt.rotation_receipt_sha256]).size).toBe(3);
    expect(configurations[0]?.instructions).not.toContain("lc4_hacc_structured_state");
    expect(configurations[1]?.instructions).toContain("<lc4_hacc_structured_state");
    expect(configurations[1]?.instructions).toContain('"flow_state_sha256"');
    expect(configurations[2]?.instructions).toContain("<lc4_hacc_structured_state");
    for (const providerConfiguration of configurations.slice(1)) {
      expect(providerConfiguration.initialConversationHistoryHydrationRequired).toBe(true);
      for (const turn of publicConversationTurns(20)) {
        expect(providerConfiguration.instructions).not.toContain(turn.text);
      }
    }
    expect(events).toEqual([
      "connect",
      "close",
      "connect",
      "hydrate",
      "close",
      "connect",
      "hydrate",
      "close",
    ]);
  });

  it("keeps native context and the HACC response-plan intervention mutually exclusive", async () => {
    const value = manifest("native");
    const bridge = new Lc4RealtimeProviderBridge((provider) => new FakeRealtimeClient(provider, []));
    let listenerResponsePlanSha256: string | null | undefined;
    const session = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: null,
      listener: {
        accept(handoff) {
          listenerResponsePlanSha256 = handoff.response_plan_sha256;
        },
      },
    });
    await expect(session.exchange({
      opportunity_id: "op-01",
      caller_pcm: new Uint8Array([1, 7, 11, 13]),
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    })).rejects.toThrow("native LC4 arm cannot receive");
    const nativeContext = "native frozen context without HACC state-derived planning";
    const evidence = await session.exchange({
      opportunity_id: "op-01",
      caller_pcm: new Uint8Array([1, 7, 11, 13]),
      response_control: { kind: "native_context", instructions: nativeContext, instructions_sha256: sha256Hex(nativeContext) },
    });
    expect(evidence).toMatchObject({ response_control_kind: "native_context", response_plan_sha256: null });
    expect(listenerResponsePlanSha256).toBeNull();
    await session.close();
  });

  it("keeps model, voice, task, gateway, audio, and transport configuration arm-identical", () => {
    const preflightSha256 = "a".repeat(64);
    for (const provider of ["openai", "gemini", "xai"] as const) {
      const nativeEpisode = devEpisodeForComparator("native", provider);
      const haccEpisode = devEpisodeForComparator("hacc", provider);
      expect({
        provider: nativeEpisode.provider,
        model: nativeEpisode.model,
        voice: nativeEpisode.voice,
        maximum_micro_usd: nativeEpisode.maximum_micro_usd,
        opportunity_binding_set_sha256: nativeEpisode.opportunity_binding_set_sha256,
      }).toEqual({
        provider: haccEpisode.provider,
        model: haccEpisode.model,
        voice: haccEpisode.voice,
        maximum_micro_usd: haccEpisode.maximum_micro_usd,
        opportunity_binding_set_sha256: haccEpisode.opportunity_binding_set_sha256,
      });
      const native = createLc4DevSessionConfiguration(
        nativeEpisode,
        preflightSha256,
      );
      const hacc = createLc4DevSessionConfiguration(
        haccEpisode,
        preflightSha256,
      );
      const common = (configuration: TrialSessionConfiguration) => ({
        provider: configuration.provider,
        model: configuration.model,
        instructions: configuration.instructions,
        initialPrompt: configuration.initialPrompt,
        renderedCapabilitySnapshot: configuration.renderedCapabilitySnapshot,
        providerTools: configuration.providerTools,
        inputAudioFormat: configuration.inputAudioFormat,
        audioDeliveryProfile: configuration.audioDeliveryProfile,
        audioDeliveryProfileHash: configuration.audioDeliveryProfileHash,
      });
      expect(common(native)).toEqual(common(hacc));
      expect(native.conditionId).toBe("raw-full");
      expect(hacc.conditionId).toBe("host-managed-harness");
    }
  });

  it("replays corrections as chronological conversation, never as corpus annotations or evaluator state", () => {
    const corpus = createLc4PublicDevelopmentCorpus();
    const turns: Lc4NativeConversationTurnInput[] = [];
    const append = (
      speaker: "caller" | "assistant",
      text: string,
      opportunity: number,
    ) => {
      const sequence = turns.length + 1;
      const common = {
        turn_id: `conversation.${String(sequence).padStart(3, "0")}.${speaker}`,
        sequence,
        text,
        available_after_opportunity: opportunity,
        provenance_receipt_sha256: sha256Hex(`${speaker}-pcm:${opportunity}`),
        provider_conversation_source: true as const,
        oracle_derived: false as const,
        future_derived: false as const,
        semantic_evaluator_derived: false as const,
      };
      turns.push(speaker === "caller"
        ? Object.freeze({
            ...common,
            speaker: "caller",
            source: "caller_tts_source_bound_to_pcm",
          })
        : Object.freeze({
            ...common,
            speaker: "assistant",
            source: "listener_exact_captured_pcm_asr",
          }));
    };
    for (const opportunity of corpus.opportunities.slice(0, 20)) {
      append("caller", opportunity.canonical_caller_text, opportunity.index);
      append("assistant", `Actual provider transcript for opportunity ${opportunity.index}.`, opportunity.index);
    }
    const common = {
      segment_ordinal: 2 as const,
      previous_rotation_receipt_sha256: "7".repeat(64),
      flow_state_sha256: "8".repeat(64),
      response_plan_chain_head_sha256: "9".repeat(64),
      conversation_turns: turns,
    };
    const native = createLc4DevRotationContext({
      ...common,
      episode: devEpisodeForComparator("native"),
    });
    const hacc = createLc4DevRotationContext({
      ...common,
      episode: devEpisodeForComparator("hacc"),
    });
    if (native.kind !== "native_conversation_replay" || hacc.kind !== "hacc_structured_state") {
      throw new Error("unexpected comparator rotation kinds");
    }
    expect(native.packet.conversation_replay_sha256).toBe(hacc.packet.conversation_replay_sha256);
    expect(native.packet.conversation_turns).toEqual(hacc.packet.conversation_turns);
    const nativeWire = canonicalJson(native.packet);
    const oldRecord = "MPL-1042";
    const correctedRecord = "MPL-1402";
    expect(nativeWire.indexOf(oldRecord)).toBeGreaterThanOrEqual(0);
    expect(nativeWire.indexOf(correctedRecord)).toBeGreaterThan(nativeWire.indexOf(oldRecord));
    for (const forbidden of [
      "fact_bindings",
      "current_public_state",
      "required_listener_semantics",
      "prohibited_effects",
      "expected_oracle",
      "patron_record version 2",
      common.flow_state_sha256,
      common.response_plan_chain_head_sha256,
    ]) {
      expect(nativeWire, `Native rotation leaked ${forbidden}`).not.toContain(forbidden);
    }
    const haccWire = canonicalJson(hacc.packet);
    expect(haccWire).toContain(common.flow_state_sha256);
    expect(haccWire).toContain(common.response_plan_chain_head_sha256);
  });

  it("gives reopened Native and HACC wrappers the same chronological provider conversation", () => {
    const value = manifest("native");
    const previousReceipt = "7".repeat(64);
    const native = nativeRotationPacket(value, previousReceipt, 1);
    const hacc = createLc4HaccRotationStatePacket({
      run_id: value.run_id,
      from_segment_ordinal: 1,
      to_segment_ordinal: 2,
      available_through_opportunity: 20,
      previous_session_rotation_receipt_sha256: previousReceipt,
      flow_state_sha256: "8".repeat(64),
      response_plan_chain_head_sha256: "9".repeat(64),
      conversation_turns: publicConversationTurns(20),
    });
    expect(() => assertLc4RotationConversationParity(native, hacc)).not.toThrow();
    expect(hacc.conversation_turns.map(({ turn_id, sequence, speaker, source, text, transcript_sha256, available_after_opportunity }) => ({
      turn_id,
      sequence,
      speaker,
      source,
      text,
      transcript_sha256,
      available_after_opportunity,
    }))).toEqual(native.conversation_turns.map(({ turn_id, sequence, speaker, source, text, transcript_sha256, available_after_opportunity }) => ({
      turn_id,
      sequence,
      speaker,
      source,
      text,
      transcript_sha256,
      available_after_opportunity,
    })));

    const changedText = "A different caller utterance that was never spoken.";
    const changedHacc = createLc4HaccRotationStatePacket({
      run_id: value.run_id,
      from_segment_ordinal: 1,
      to_segment_ordinal: 2,
      available_through_opportunity: 20,
      previous_session_rotation_receipt_sha256: previousReceipt,
      flow_state_sha256: "8".repeat(64),
      response_plan_chain_head_sha256: "9".repeat(64),
      conversation_turns: publicConversationTurns(20).map((turn, index) => index === 0
        ? { ...turn, text: changedText }
        : turn),
    });
    expect(() => assertLc4RotationConversationParity(native, changedHacc)).toThrow("differ in provider conversation replay");
  });

  it("keeps Native and HACC provider-native hydration byte-identical while HACC alone receives control state", async () => {
    const openReconnected = async (arm: "native" | "hacc") => {
      const value = manifest(arm);
      const clients: FakeRealtimeClient[] = [];
      const configurations: TrialSessionConfiguration[] = [];
      const bridge = new Lc4RealtimeProviderBridge((provider, providerConfiguration) => {
        configurations.push(providerConfiguration);
        const client = new FakeRealtimeClient(provider, []);
        clients.push(client);
        return client;
      });
      const first = await bridge.openSegment({
        manifest: value,
        segment: value.episode_shape.segments[0]!,
        profile: value.episode_shape.provider_profile,
        configuration: configuration(value),
        rotation_context: null,
        listener: { accept() {} },
      });
      const firstReceipt = await first.close();
      const packet = arm === "native"
        ? {
            kind: "native_conversation_replay" as const,
            packet: nativeRotationPacket(value, firstReceipt.rotation_receipt_sha256, 1),
          }
        : haccRotationContext(value, firstReceipt.rotation_receipt_sha256, 1);
      const second = await bridge.openSegment({
        manifest: value,
        segment: value.episode_shape.segments[1]!,
        profile: value.episode_shape.provider_profile,
        configuration: configuration(value),
        rotation_context: packet,
        listener: { accept() {} },
      });
      const hydration = clients[1]?.hydratedHistories[0];
      const reopenedInstructions = configurations[1]!.instructions;
      await second.close();
      return { hydration, reopenedInstructions };
    };
    const native = await openReconnected("native");
    const hacc = await openReconnected("hacc");
    expect(native.hydration).toEqual(hacc.hydration);
    expect(native.reopenedInstructions).not.toContain("lc4_hacc_structured_state");
    expect(hacc.reopenedInstructions).toContain("lc4_hacc_structured_state");
    for (const turn of publicConversationTurns(20)) {
      expect(native.reopenedInstructions).not.toContain(turn.text);
      expect(hacc.reopenedInstructions).not.toContain(turn.text);
    }
  });

  it("retains exact provider tool metadata and rejects the old 9,187-byte duplicated-plan output", () => {
    const value = manifest("native");
    const compactOutput = canonicalJson({
      gateway_result: { ok: true, membership_status: "active" },
      authoritative_outcome: { disposition: "verified" },
      speech_directive: "Confirm only that the membership is active.",
    });
    const compact = createLc4NativeConversationReplayPacket({
      run_id: value.run_id,
      from_segment_ordinal: 1,
      to_segment_ordinal: 2,
      available_through_opportunity: 20,
      previous_session_rotation_receipt_sha256: "7".repeat(64),
      conversation_turns: publicConversationTurnsWithTool(compactOutput),
    });
    const tool = compact.conversation_turns.find((turn) => turn.speaker === "tool");
    expect(tool).toMatchObject({
      speaker: "tool",
      source: "canonical_gateway_result",
      tool_name: LC4_DEV_SEMANTIC_GATEWAY_FUNCTION.name,
      tool_arguments: {
        tool_name: "membership.lookup",
        arguments: { member_id: "PUBLIC-17" },
      },
      text: compactOutput,
    });

    expect(() => createLc4NativeConversationReplayPacket({
      run_id: value.run_id,
      from_segment_ordinal: 1,
      to_segment_ordinal: 2,
      available_through_opportunity: 20,
      previous_session_rotation_receipt_sha256: "7".repeat(64),
      conversation_turns: publicConversationTurnsWithTool("x".repeat(9_187)),
    })).toThrow("conversation text is invalid");
    expect(() => createLc4NativeConversationReplayPacket({
      run_id: value.run_id,
      from_segment_ordinal: 1,
      to_segment_ordinal: 2,
      available_through_opportunity: 20,
      previous_session_rotation_receipt_sha256: "7".repeat(64),
      // 2,001 Unicode code points but 4,002 UTF-8 bytes: the guard is bytes,
      // not JavaScript string length.
      conversation_turns: publicConversationTurnsWithTool("é".repeat(2_001)),
    })).toThrow("conversation text is invalid");
  });

  it("hydrates typed tool call/output pairs and binds their expanded provider item count", async () => {
    const value = manifest("native");
    const clients: FakeRealtimeClient[] = [];
    const bridge = new Lc4RealtimeProviderBridge((provider) => {
      const client = new FakeRealtimeClient(provider, []);
      clients.push(client);
      return client;
    });
    const first = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: null,
      listener: { accept() {} },
    });
    const firstReceipt = await first.close();
    const compactOutput = canonicalJson({
      gateway_result: { ok: true },
      authoritative_outcome: { disposition: "verified" },
      speech_directive: "Confirm the verified result.",
    });
    const packet = createLc4NativeConversationReplayPacket({
      run_id: value.run_id,
      from_segment_ordinal: 1,
      to_segment_ordinal: 2,
      available_through_opportunity: 20,
      previous_session_rotation_receipt_sha256: firstReceipt.rotation_receipt_sha256,
      conversation_turns: publicConversationTurnsWithTool(compactOutput),
    });
    const second = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[1]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: { kind: "native_conversation_replay", packet },
      listener: { accept() {} },
    });
    expect(clients[1]?.hydratedHistories[0]?.find((turn) => turn.role === "tool_batch"))
      .toEqual({
        role: "tool_batch",
        calls: [{
          toolName: LC4_DEV_SEMANTIC_GATEWAY_FUNCTION.name,
          toolArguments: {
            tool_name: "membership.lookup",
            arguments: { member_id: "PUBLIC-17" },
          },
          output: compactOutput,
          sourceSha256: sha256Hex(`provider-visible-tool:${compactOutput}`),
        }],
      });
    const receipt = await second.close();
    expect(receipt.finalization_body).toMatchObject({
      conversation_history_hydration: {
        turn_count: packet.conversation_turns.length,
        provider_item_count: packet.conversation_turns.length + 1,
      },
    });
  });

  it("preserves a real two-call provider batch as call-call-output-output hydration", async () => {
    const value = manifest("native");
    const clients: FakeRealtimeClient[] = [];
    const bridge = new Lc4RealtimeProviderBridge((provider) => {
      const client = new FakeRealtimeClient(provider, []);
      clients.push(client);
      return client;
    });
    const first = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: null,
      listener: { accept() {} },
    });
    const firstReceipt = await first.close();
    const outputs = [
      canonicalJson({ ok: true, active: true }),
      canonicalJson({ ok: true, annual_total: 420 }),
    ] as const;
    const packet = createLc4NativeConversationReplayPacket({
      run_id: value.run_id,
      from_segment_ordinal: 1,
      to_segment_ordinal: 2,
      available_through_opportunity: 20,
      previous_session_rotation_receipt_sha256: firstReceipt.rotation_receipt_sha256,
      conversation_turns: publicConversationTurnsWithToolBatch(outputs),
    });
    const second = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[1]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: { kind: "native_conversation_replay", packet },
      listener: { accept() {} },
    });
    const hydrated = clients[1]!.hydratedHistories[0]!;
    expect(hydrated).toHaveLength(packet.conversation_turns.length - 1);
    expect(hydrated.find((turn) => turn.role === "tool_batch")).toEqual({
      role: "tool_batch",
      calls: [
        {
          toolName: LC4_DEV_SEMANTIC_GATEWAY_FUNCTION.name,
          toolArguments: {
            tool_name: "membership.lookup",
            arguments: { member_id: "PUBLIC-17" },
          },
          output: outputs[0],
          sourceSha256: sha256Hex(`provider-visible-tool:0:${outputs[0]}`),
        },
        {
          toolName: LC4_DEV_SEMANTIC_GATEWAY_FUNCTION.name,
          toolArguments: {
            tool_name: "membership.quote",
            arguments: { member_id: "PUBLIC-17", term: "annual" },
          },
          output: outputs[1],
          sourceSha256: sha256Hex(`provider-visible-tool:1:${outputs[1]}`),
        },
      ],
    });
    const receipt = await second.close();
    expect(receipt.finalization_body).toMatchObject({
      conversation_history_hydration: {
        turn_count: packet.conversation_turns.length - 1,
        provider_item_count: 44,
      },
    });
  });

  it("hydrates a 120-turn opportunity-40 history without moving any replay text into instructions", async () => {
    const value = manifest("native");
    const clients: FakeRealtimeClient[] = [];
    const configurations: TrialSessionConfiguration[] = [];
    const bridge = new Lc4RealtimeProviderBridge((provider, providerConfiguration) => {
      configurations.push(providerConfiguration);
      const client = new FakeRealtimeClient(provider, []);
      clients.push(client);
      return client;
    });
    const open = (ordinal: 1 | 2 | 3, rotationContext: Lc4RotationContext | null) => (
      bridge.openSegment({
        manifest: value,
        segment: value.episode_shape.segments[ordinal - 1]!,
        profile: value.episode_shape.provider_profile,
        configuration: configuration(value),
        rotation_context: rotationContext,
        listener: { accept() {} },
      })
    );
    const first = await open(1, null);
    const firstReceipt = await first.close();
    const segmentTwoPacket = nativeRotationPacket(
      value,
      firstReceipt.rotation_receipt_sha256,
      1,
    );
    const second = await open(2, {
      kind: "native_conversation_replay",
      packet: segmentTwoPacket,
    });
    const secondReceipt = await second.close();
    const deepTurns = publicDeepConversationTurns();
    expect(deepTurns).toHaveLength(120);
    const segmentThreePacket = createLc4NativeConversationReplayPacket({
      run_id: value.run_id,
      from_segment_ordinal: 2,
      to_segment_ordinal: 3,
      available_through_opportunity: 40,
      previous_session_rotation_receipt_sha256: secondReceipt.rotation_receipt_sha256,
      conversation_turns: deepTurns,
    });
    const third = await open(3, {
      kind: "native_conversation_replay",
      packet: segmentThreePacket,
    });
    expect(clients[2]?.hydratedHistories[0]).toHaveLength(120);
    for (const turn of deepTurns) {
      expect(configurations[2]?.instructions).not.toContain(turn.text);
    }
    const receipt = await third.close();
    expect(receipt.finalization_body).toMatchObject({
      conversation_history_hydration: {
        turn_count: 120,
        provider_item_count: 160,
        status: "acknowledged",
      },
    });
  });

  it("rejects future, oracle-derived, evaluator-derived, and non-conversation Native replay turns", () => {
    const value = manifest("native");
    const turns = publicConversationTurns(20);
    const base = turns[0]!;
    const packet = (turn: Lc4NativeConversationTurnInput) => createLc4NativeConversationReplayPacket({
      run_id: value.run_id,
      from_segment_ordinal: 1,
      to_segment_ordinal: 2,
      available_through_opportunity: 20,
      previous_session_rotation_receipt_sha256: "7".repeat(64),
      conversation_turns: [turn, ...turns.slice(1)],
    });
    expect(() => packet({ ...base, available_after_opportunity: 21 })).toThrow("future or out-of-order");
    expect(() => packet({ ...base, oracle_derived: true } as unknown as Lc4NativeConversationTurnInput)).toThrow("forbids oracle, semantic-evaluator, future");
    expect(() => packet({ ...base, semantic_evaluator_derived: true } as unknown as Lc4NativeConversationTurnInput)).toThrow("forbids oracle, semantic-evaluator, future");
    expect(() => packet({ ...base, provider_conversation_source: false } as unknown as Lc4NativeConversationTurnInput)).toThrow("non-conversation state");
    expect(() => packet({ ...base, source: "oracle_fixture" } as unknown as Lc4NativeConversationTurnInput)).toThrow("source is inadmissible");
    const withoutFirstAssistant = turns.map((turn, index) => index === 1
      ? {
          ...turn,
          turn_id: "conversation.002.tool",
          speaker: "tool" as const,
          source: "canonical_gateway_result" as const,
          tool_name: LC4_DEV_SEMANTIC_GATEWAY_FUNCTION.name,
          tool_arguments: {
            tool_name: "membership.lookup",
            arguments: {},
          },
        }
      : turn);
    expect(() => createLc4NativeConversationReplayPacket({
      run_id: value.run_id,
      from_segment_ordinal: 1,
      to_segment_ordinal: 2,
      available_through_opportunity: 20,
      previous_session_rotation_receipt_sha256: "7".repeat(64),
      conversation_turns: withoutFirstAssistant,
    })).toThrow("omits caller/assistant evidence for opportunity 1");
  });

  it("hydrates receipt-bound Native history after connect without serializing it into instructions", async () => {
    const value = manifest("native");
    const configurations: TrialSessionConfiguration[] = [];
    const clients: FakeRealtimeClient[] = [];
    const events: string[] = [];
    const bridge = new Lc4RealtimeProviderBridge((provider, providerConfiguration) => {
      configurations.push(providerConfiguration);
      const client = new FakeRealtimeClient(provider, events);
      clients.push(client);
      return client;
    });
    const first = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: null,
      listener: { accept() {} },
    });
    const firstReceipt = await first.close();
    const packet = nativeRotationPacket(value, firstReceipt.rotation_receipt_sha256, 1);
    const second = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[1]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: { kind: "native_conversation_replay", packet },
      listener: { accept() {} },
    });
    expect(events).toEqual(["connect", "close", "connect", "hydrate"]);
    expect(configurations[1]?.initialConversationHistoryHydrationRequired).toBe(true);
    expect(configurations[1]?.instructions).toBe(configuration(value).instructions);
    for (const turn of packet.conversation_turns) {
      expect(configurations[1]?.instructions).not.toContain(turn.text);
    }
    expect(clients[1]?.hydratedHistories).toHaveLength(1);
    expect(clients[1]?.hydratedHistories[0]).toEqual(packet.conversation_turns.map((turn) => (
      turn.speaker === "tool"
        ? {
            role: "tool",
            toolName: turn.tool_name,
            toolArguments: turn.tool_arguments,
            output: turn.text,
            sourceSha256: turn.provenance_receipt_sha256,
          }
        : {
            role: turn.speaker === "caller" ? "user" : "assistant",
            text: turn.text,
            sourceSha256: turn.provenance_receipt_sha256,
          }
    )));
    for (const forbiddenMetadata of [
      "available_after_opportunity",
      "conversation_replay_sha256",
      "from_segment_ordinal",
      "packet_sha256",
      "previous_session_rotation_receipt_sha256",
      "provenance_receipt_sha256",
      "run_id",
      "source",
      "to_segment_ordinal",
      "transcript_sha256",
      "turn_id",
    ]) {
      expect(configurations[1]?.instructions, `Native reconnect leaked ${forbiddenMetadata}`)
        .not.toContain(forbiddenMetadata);
    }
    const nativeContext = "native continuation response context";
    const evidence = await second.exchange({
      opportunity_id: "op-21",
      caller_pcm: new Uint8Array([21, 7, 11, 13]),
      response_control: { kind: "native_context", instructions: nativeContext, instructions_sha256: sha256Hex(nativeContext) },
    });
    expect(evidence).toMatchObject({
      rotation_context_kind: "native_conversation_replay",
      rotation_context_sha256: packet.packet_sha256,
      rotation_conversation_replay_sha256: packet.conversation_replay_sha256,
    });
    expect(events.indexOf("hydrate")).toBeGreaterThan(events.lastIndexOf("connect"));
    expect(events.indexOf("append")).toBeGreaterThan(events.indexOf("hydrate"));
    expect(events.indexOf("create")).toBeGreaterThan(events.indexOf("hydrate"));
    const encodedEvidence = JSON.stringify(evidence);
    for (const turn of packet.conversation_turns) expect(encodedEvidence).not.toContain(turn.text);
    const secondReceipt = await second.close();
    expect(secondReceipt.finalization_body).toMatchObject({
      conversation_history_hydration: {
        schema_version: 1,
        provider: "openai",
        status: "acknowledged",
        turn_count: packet.conversation_turns.length,
        provider_item_count: packet.conversation_turns.length,
      },
    });
    const hydrationEvidence = (
      secondReceipt.finalization_body as Record<string, unknown>
    ).conversation_history_hydration as {
      items: Array<{
        outboundObservation?: { availability: string };
        inboundObservation?: { availability: string };
      }>;
    };
    expect(hydrationEvidence.items).toHaveLength(packet.conversation_turns.length);
    expect(hydrationEvidence.items.every((item) =>
      item.outboundObservation?.availability === "observed"
      && item.inboundObservation?.availability === "observed")).toBe(true);
    const encodedFinalization = JSON.stringify(secondReceipt.finalization_body);
    for (const turn of packet.conversation_turns) {
      expect(encodedFinalization).not.toContain(turn.text);
    }
  });

  it("fails closed before audio when a reopened provider lacks history hydration", async () => {
    const value = manifest("native");
    let factoryOrdinal = 0;
    const events: string[] = [];
    const bridge = new Lc4RealtimeProviderBridge((provider) => {
      factoryOrdinal += 1;
      const client = new FakeRealtimeClient(provider, events);
      if (factoryOrdinal === 2) {
        Object.defineProperty(client, "hydrateConversationHistory", {
          configurable: true,
          value: undefined,
        });
      }
      return client;
    });
    const first = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: null,
      listener: { accept() {} },
    });
    const firstReceipt = await first.close();
    await expect(bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[1]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: {
        kind: "native_conversation_replay",
        packet: nativeRotationPacket(value, firstReceipt.rotation_receipt_sha256, 1),
      },
      listener: { accept() {} },
    })).rejects.toThrow("lacks conversation history hydration");
    expect(events).toEqual(["connect", "close", "connect", "close"]);
    expect(events).not.toContain("append");
    expect(events).not.toContain("create");
  });

  it.each(["openai", "gemini", "xai"] as const)(
    "retains honest, observed %s hydration lineage before the reopened segment",
    async (provider) => {
      const value = manifest("native", provider);
      const bridge = new Lc4RealtimeProviderBridge(
        (clientProvider) => new FakeRealtimeClient(clientProvider, []),
      );
      const first = await bridge.openSegment({
        manifest: value,
        segment: value.episode_shape.segments[0]!,
        profile: value.episode_shape.provider_profile,
        configuration: configuration(value),
        rotation_context: null,
        listener: { accept() {} },
      });
      const firstReceipt = await first.close();
      const packet = nativeRotationPacket(
        value,
        firstReceipt.rotation_receipt_sha256,
        1,
      );
      const second = await bridge.openSegment({
        manifest: value,
        segment: value.episode_shape.segments[1]!,
        profile: value.episode_shape.provider_profile,
        configuration: configuration(value),
        rotation_context: { kind: "native_conversation_replay", packet },
        listener: { accept() {} },
      });
      const receipt = await second.close();
      const hydration = (
        receipt.finalization_body as Record<string, unknown>
      ).conversation_history_hydration as {
        status: string;
        items: Array<{
          outboundObservation?: { availability: string };
          inboundObservation?: { availability: string };
        }>;
      };
      expect(hydration.status).toBe(provider === "gemini"
        ? "sent_unacknowledged_by_provider_protocol"
        : "acknowledged");
      expect(hydration.items.every((item) =>
        item.outboundObservation?.availability === "observed")).toBe(true);
      expect(hydration.items.every((item) => provider === "gemini"
        ? item.inboundObservation === undefined
        : item.inboundObservation?.availability === "observed")).toBe(true);
    },
  );

  it.each(["openai", "gemini", "xai"] as const)(
    "fails closed before audio when %s history wire projection content is altered",
    async (provider) => {
      const value = manifest("native", provider);
      const events: string[] = [];
      let factoryOrdinal = 0;
      const bridge = new Lc4RealtimeProviderBridge((clientProvider) => {
        factoryOrdinal += 1;
        return new FakeRealtimeClient(
          clientProvider,
          events,
          false,
          "completed",
          null,
          false,
          true,
          factoryOrdinal === 2,
        );
      });
      const first = await bridge.openSegment({
        manifest: value,
        segment: value.episode_shape.segments[0]!,
        profile: value.episode_shape.provider_profile,
        configuration: configuration(value),
        rotation_context: null,
        listener: { accept() {} },
      });
      const firstReceipt = await first.close();
      await expect(bridge.openSegment({
        manifest: value,
        segment: value.episode_shape.segments[1]!,
        profile: value.episode_shape.provider_profile,
        configuration: configuration(value),
        rotation_context: {
          kind: "native_conversation_replay",
          packet: nativeRotationPacket(value, firstReceipt.rotation_receipt_sha256, 1),
        },
        listener: { accept() {} },
      })).rejects.toThrow(
        provider === "gemini"
          ? "Gemini history hydration projection differs"
          : "provider history item projection differs",
      );
      expect(events).not.toContain("append");
      expect(events).not.toContain("create");
    },
  );

  it("requires a valid arm-specific packet on every reopen", async () => {
    const value = manifest("native");
    const bridge = new Lc4RealtimeProviderBridge((provider) => new FakeRealtimeClient(provider, []));
    const first = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: null,
      listener: { accept() {} },
    });
    const receipt = await first.close();
    const reopen = (rotationContext: Lc4RotationContext | null) => bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[1]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: rotationContext,
      listener: { accept() {} },
    });
    await expect(reopen(null)).rejects.toThrow("requires a receipt-bound rotation context");
    const packet = nativeRotationPacket(value, receipt.rotation_receipt_sha256, 1);
    await expect(reopen({ kind: "native_conversation_replay", packet: { ...packet, packet_sha256: "f".repeat(64) } })).rejects.toThrow("integrity failed");
    const stalePacket = nativeRotationPacket(value, "8".repeat(64), 1);
    await expect(reopen({ kind: "native_conversation_replay", packet: stalePacket })).rejects.toThrow("prior session receipt");
    await expect(reopen(haccRotationContext(value, receipt.rotation_receipt_sha256, 1))).rejects.toThrow("differs from the randomized arm");
  });

  it("accepts all 15 provider/outcome branch cells only under their exact signed playback authority", async () => {
    for (const provider of ["openai", "gemini", "xai"] as const) {
      for (const outcome of LC4_DEV_PRIOR_MUTATION_OUTCOMES) {
        const fixture = await openCallerBranchPreflight({ provider, outcome });
        let evidence: Awaited<ReturnType<typeof fixture.session.exchange>>;
        try {
          evidence = await fixture.session.exchange({
            opportunity_id: fixture.opportunity.id,
            caller_pcm: fixture.pcm,
            response_control: { kind: "hacc_response_plan", plan: responsePlan() },
            caller_branch_binding: fixture.binding,
          });
        } catch (error) {
          const failure = error instanceof Lc4DevFailureEvidenceError ? error.failure : null;
          throw new Error(`branch preflight failed for ${provider}/${outcome}: ${JSON.stringify(failure)}`, { cause: error });
        }
        expect(evidence).toMatchObject({
          playback_kind: "canonical",
          caller_pcm_sha256: fixture.binding.decision.pcm_sha256,
          caller_branch_decision_sha256: fixture.binding.decision.decision_sha256,
        });
        expect(evidence.replay_projection).toMatchObject({
          caller_branch_authority: {
            decision_sha256: fixture.binding.decision.decision_sha256,
            decision_evidence_sha256: fixture.binding.decision.decision_sha256,
            matrix_artifact_sha256: callerBranchMatrix.matrix_artifact_sha256,
            prior_outcome: outcome,
          },
        });
        await fixture.session.finalizeOpportunity!({
          opportunity_id: fixture.opportunity.id,
          decision_receipt_sha256: sha256Hex(`branch-preflight-op42:${provider}:${outcome}`),
          repair_played: false,
        });
        await fixture.session.close();
      }
    }
  }, 15_000);

  it("rejects opportunity 42 without signed branch authority before appending its PCM", async () => {
    const fixture = await openCallerBranchPreflight({ provider: "gemini", outcome: "no_call" });
    const appendCount = fixture.events.filter((event) => event === "append").length;
    const failure = await caughtFailure(fixture.session.exchange({
      opportunity_id: fixture.opportunity.id,
      caller_pcm: fixture.pcm,
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    }));
    expect(failure.failure).toMatchObject({
      failure_stage: "pre_send_contract",
      failure_code: "invalid_contract",
      caller_pcm_appended_byte_length: 0,
      response_generation_requested: false,
    });
    expect(fixture.events.filter((event) => event === "append")).toHaveLength(appendCount);
    await fixture.session.close();
  });

  it("rejects every mutated branch authority dimension and PCM substitution before provider send", async () => {
    type MutationResult = Readonly<{
      binding: Lc4DevCallerBranchPlaybackBinding;
      pcm: Uint8Array;
    }>;
    type BranchMutation = Readonly<{
      name: string;
      mutate(binding: Lc4DevCallerBranchPlaybackBinding, pcm: Uint8Array): MutationResult;
    }>;
    const mutateDecision = (
      binding: Lc4DevCallerBranchPlaybackBinding,
      patch: Partial<Lc4DevCallerBranchDecision>,
    ): Lc4DevCallerBranchPlaybackBinding => Object.freeze({
      ...binding,
      decision: Object.freeze({ ...binding.decision, ...patch }) as Lc4DevCallerBranchDecision,
    });
    const mutations: readonly BranchMutation[] = Object.freeze([
      {
        name: "retained evidence hash",
        mutate: (binding, pcm) => ({
          binding: {
            ...binding,
            decision_evidence: {
              ...binding.decision_evidence,
              evidence_sha256: sha256Hex("different-retained-decision"),
            },
          },
          pcm,
        }),
      },
      {
        name: "retained evidence kind",
        mutate: (binding, pcm) => ({
          binding: {
            ...binding,
            decision_evidence: {
              ...binding.decision_evidence,
              kind: "control_authority",
            },
          } as Lc4DevCallerBranchPlaybackBinding,
          pcm,
        }),
      },
      {
        name: "decision hash",
        mutate: (binding, pcm) => ({
          binding: mutateDecision(binding, { decision_sha256: sha256Hex("different-decision") }),
          pcm,
        }),
      },
      {
        name: "signature",
        mutate: (binding, pcm) => ({
          binding: mutateDecision(binding, { signature_base64: Buffer.from("invalid-signature").toString("base64") }),
          pcm,
        }),
      },
      {
        name: "episode",
        mutate: (binding, pcm) => ({
          binding: mutateDecision(binding, { episode_id: "lc4-dev-different-episode" }),
          pcm,
        }),
      },
      {
        name: "provider",
        mutate: (binding, pcm) => ({
          binding: mutateDecision(binding, { provider: "gemini" }),
          pcm,
        }),
      },
      {
        name: "opportunity",
        mutate: (binding, pcm) => ({
          binding: mutateDecision(binding, {
            canonical_opportunity_id: "lc4-dev-op-41" as typeof LC4_DEV_BRANCH_OPPORTUNITY_ID,
          }),
          pcm,
        }),
      },
      {
        name: "ordinal",
        mutate: (binding, pcm) => ({
          binding: mutateDecision(binding, { canonical_ordinal: 41 as 42 }),
          pcm,
        }),
      },
      {
        name: "declared PCM hash",
        mutate: (binding, pcm) => ({
          binding: mutateDecision(binding, { pcm_sha256: sha256Hex("different-branch-pcm") }),
          pcm,
        }),
      },
      {
        name: "declared PCM length",
        mutate: (binding, pcm) => ({
          binding: mutateDecision(binding, { pcm_byte_length: binding.decision.pcm_byte_length + 2 }),
          pcm,
        }),
      },
      {
        name: "sample rate",
        mutate: (binding, pcm) => ({
          binding: mutateDecision(binding, { sample_rate_hz: 16_000 }),
          pcm,
        }),
      },
      {
        name: "source id",
        mutate: (binding, pcm) => ({
          binding: mutateDecision(binding, { source_id: "lc4-dev-op-42-different-source" }),
          pcm,
        }),
      },
      {
        name: "source text",
        mutate: (binding, pcm) => ({
          binding: mutateDecision(binding, { source_text_sha256: sha256Hex("different-source-text") }),
          pcm,
        }),
      },
      {
        name: "matrix",
        mutate: (binding, pcm) => ({
          binding: mutateDecision(binding, { matrix_artifact_sha256: sha256Hex("different-matrix") }),
          pcm,
        }),
      },
      {
        name: "prior outcome",
        mutate: (binding, pcm) => ({
          binding: mutateDecision(binding, { prior_outcome: "settled_failure" }),
          pcm,
        }),
      },
      {
        name: "prior receipt",
        mutate: (binding, pcm) => ({
          binding: mutateDecision(binding, { prior_receipt_sha256: sha256Hex("invented-prior-receipt") }),
          pcm,
        }),
      },
      {
        name: "actual PCM bytes",
        mutate: (binding, pcm) => ({
          binding,
          pcm: Uint8Array.from(pcm, (byte, index) => index === 0 ? byte ^ 0xff : byte),
        }),
      },
    ]);

    for (const mutation of mutations) {
      const fixture = await openCallerBranchPreflight({ provider: "openai", outcome: "no_call" });
      const appendCount = fixture.events.filter((event) => event === "append").length;
      const mutated = mutation.mutate(fixture.binding, fixture.pcm);
      const failure = await caughtFailure(fixture.session.exchange({
        opportunity_id: fixture.opportunity.id,
        caller_pcm: mutated.pcm,
        response_control: { kind: "hacc_response_plan", plan: responsePlan() },
        caller_branch_binding: mutated.binding,
      }));
      expect(failure.failure, mutation.name).toMatchObject({
        failure_stage: "pre_send_contract",
        failure_code: "invalid_contract",
        caller_pcm_appended_byte_length: 0,
        response_generation_requested: false,
      });
      expect(
        fixture.events.filter((event) => event === "append"),
        `${mutation.name} must fail before provider append`,
      ).toHaveLength(appendCount);
      await fixture.session.close();
    }
  });

  it("keeps the exact production adapter hard-frozen before constructing a provider client", async () => {
    const value = manifest();
    const adapter = createLc4FrozenProductionRealtimeAdapter({
      credentials: { openai: "not-used-openai", gemini: "not-used-gemini", xai: "not-used-xai" },
    });
    expect(adapter.kind).toBe("production-realtime-frozen");
    await expect(adapter.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: null,
      listener: { accept() { throw new Error("must not run"); } },
    })).rejects.toThrow("provider execution is not authorized");
  });
});

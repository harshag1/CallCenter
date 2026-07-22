import { describe, expect, it } from "vitest";
import { AgentFlowSchema } from "../../flow";
import { createFlowExecutionState, type FlowExecutionState } from "../../flow-runtime";
import { canonicalJson, sha256Hex } from "../artifacts";
import { compileConditionSuite } from "../condition-compiler";
import { industrialFieldServiceCompilerInput } from "../industrial-field-service-source";
import {
  Lc4RealtimeProviderBridge,
  assertLc4RotationSubstantiveFactParity,
  createLc4FrozenProductionRealtimeAdapter,
  createLc4HaccRotationStatePacket,
  createLc4StrongNativeContinuityPacket,
  type Lc4NativeContinuityFactInput,
  type Lc4RealtimeEpisodeManifest,
  type Lc4RotationContext,
  type Lc4StrongNativeContinuityPacket,
} from "../lc4-production-provider-adapter";
import {
  LC4_DEV_SEMANTIC_GATEWAY_FUNCTION,
  type Lc4DevGatewayExecutor,
} from "../lc4-development-gateway-bridge";
import type { Lc4DevLiveEpisodePlan } from "../lc4-development-live-runner";
import { createLc4DevReplayEvidenceStore } from "../lc4-development-evidence-retention";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";
import { createLc4DevArmBlindRepairProjection } from "../lc4-development-headless-listener-authority";
import {
  compileLc4ProductionScheduleShape,
  createLc4EpisodeManifest,
  createLc4QualificationGateReceipt,
  type Lc4EpisodeManifest,
  type Lc4OpportunityBinding,
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
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  RealtimeEventListener,
  RealtimeResponsePreparation,
  RealtimeToolResult,
  RealtimeWireObservationListener,
} from "../../realtime/client/types";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  LOCAL_TOOL_PROXY_FUNCTION,
  LOCAL_TOOL_PROXY_FUNCTION_NAME,
  PROVIDER_PROVENANCE_META_KEY,
} from "../../realtime/client/types";

const HASH = "a".repeat(64);
const AUTHORITY_PROJECTION_DOMAIN = "harshas-amazing-call-center/lc4-dev-gateway-authority-projection/v1\n";
const COMMIT = "b".repeat(40);
const ORACLE_SECRET = "ORACLE-PLAINTEXT-MUST-NOT-LEAK";

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
  return Object.freeze({
    provider: profile.provider,
    model: profile.model,
    conditionId: "host-managed-harness",
    instructions: `public base instructions ${ORACLE_SECRET}`,
    initialPrompt: `public base instructions ${ORACLE_SECRET}`,
    renderedCapabilitySnapshot: "<capability_snapshot />",
    providerTools: Object.freeze([LOCAL_TOOL_PROXY_FUNCTION]),
    conditionHash: condition.conditionHash,
    inputAudioFormat: Object.freeze({ encoding: "pcm16", sampleRateHz: profile.input_sample_rate_hz, channels: 1 }),
    audioDeliveryProfile: Object.freeze({ schemaVersion: 1, chunkMs: 20, pace: "realtime" }),
    audioDeliveryProfileHash: HASH,
  });
}

function publicFacts(): readonly Lc4NativeContinuityFactInput[] {
  return Object.freeze([
    {
      fact_id: "caller-site-id",
      source: "listener_heard_caller",
      public_text: "The caller identified the site as North Plant.",
      available_after_opportunity: 3,
      provenance_receipt_sha256: "1".repeat(64),
      listener_status: "heard_verified",
      visibility: "public_non_sensitive",
      oracle_derived: false,
      future_derived: false,
      private_value_included: false,
    },
    {
      fact_id: "assistant-promised-followup",
      source: "listener_heard_assistant",
      public_text: "The assistant promised to confirm the service window before scheduling.",
      available_after_opportunity: 7,
      provenance_receipt_sha256: "2".repeat(64),
      listener_status: "heard_verified",
      visibility: "public_non_sensitive",
      oracle_derived: false,
      future_derived: false,
      private_value_included: false,
    },
    {
      fact_id: "lookup-service-window",
      source: "authoritative_arm_common_result",
      public_text: "The arm-common lookup returned a Tuesday 9-11 AM service window.",
      available_after_opportunity: 12,
      provenance_receipt_sha256: "3".repeat(64),
      listener_status: "not_applicable",
      visibility: "public_non_sensitive",
      oracle_derived: false,
      future_derived: false,
      private_value_included: false,
    },
    {
      fact_id: "initial-public-policy",
      source: "prior_native_visible_context",
      public_text: "The public cancellation policy allows changes until 24 hours before the visit.",
      available_after_opportunity: 1,
      provenance_receipt_sha256: "4".repeat(64),
      listener_status: "not_applicable",
      visibility: "public_non_sensitive",
      oracle_derived: false,
      future_derived: false,
      private_value_included: false,
    },
  ] satisfies readonly Lc4NativeContinuityFactInput[]);
}

function nativeRotationPacket(
  value: Lc4EpisodeManifest,
  previousReceipt: string,
  from: 1 | 2,
): Lc4StrongNativeContinuityPacket {
  return createLc4StrongNativeContinuityPacket({
    run_id: value.run_id,
    from_segment_ordinal: from,
    to_segment_ordinal: (from + 1) as 2 | 3,
    available_through_opportunity: (from * 20) as 20 | 40,
    previous_session_rotation_receipt_sha256: previousReceipt,
    facts: publicFacts(),
  });
}

function haccRotationContext(
  value: Lc4EpisodeManifest,
  previousReceipt: string,
  from: 1 | 2,
): Lc4RotationContext {
  const native = nativeRotationPacket(value, previousReceipt, from);
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
      facts: native.facts,
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
  readonly submittedToolResults: Array<Readonly<{ results: readonly RealtimeToolResult[]; createResponse: boolean | undefined }>> = [];
  readonly preparations: RealtimeResponsePreparation[] = [];

  constructor(
    provider: "openai" | "gemini" | "xai",
    events: string[],
    toolRoundtrip = false,
    terminalStatus: "completed" | "failed" | "incomplete" | "interrupted" | "cancelled" = "completed",
  ) {
    this.provider = provider;
    this.events = events;
    this.#toolRoundtrip = toolRoundtrip;
    this.#terminalStatus = terminalStatus;
  }

  async connect() { this.events.push("connect"); this.state = "ready"; }
  close() { this.events.push("close"); this.state = "closed"; }
  onEvent(listener: RealtimeEventListener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  onWireEvent() { return () => undefined; }
  onWireObservation(listener: RealtimeWireObservationListener) { this.#wire.add(listener); return () => this.#wire.delete(listener); }
  appendInputAudio() { this.events.push("append"); this.wire("input_audio", { plaintext: ORACLE_SECRET }); }
  prepareResponse(preparation: RealtimeResponsePreparation) {
    this.events.push("prepare");
    this.preparations.push(preparation);
    this.wire("response.plan", { oracle: ORACLE_SECRET });
  }
  commitInputAudio() { this.events.push("commit"); this.wire("input.commit", {}); }
  sendTurn() { throw new Error("bridge must use append/commit, not sendTurn"); }
  submitToolResults(results: readonly RealtimeToolResult[], createResponse?: boolean) {
    if (!this.#toolRoundtrip) throw new Error("not used");
    this.events.push(`submit:${String(createResponse)}`);
    this.submittedToolResults.push({ results, createResponse });
    if (this.provider === "gemini") {
      queueMicrotask(() => {
        const responseId = "provider-tool-response-plaintext";
        if (this.submittedToolResults.length === 1) {
          this.emit({
            type: "tool.calls",
            provider: this.provider,
            receivedAtMs: 3,
            wireType: "toolCall",
            responseId,
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
        this.emit({
          type: "output.audio",
          provider: this.provider,
          receivedAtMs: 3,
          wireType: "serverContent.modelTurn.part.inlineData",
          responseId,
          audio: new Uint8Array([1, 0, 2, 0]),
          format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        });
        this.emit({
          type: "response.completed",
          provider: this.provider,
          receivedAtMs: 4,
          wireType: "serverContent.turnComplete",
          responseId,
          status: this.#terminalStatus,
        });
      });
    }
  }
  createResponse() {
    this.events.push("create");
    this.wire("response.create", {});
    if (this.provider === "gemini" && this.#toolRoundtrip && this.#responseOrdinal > 0) return;
    queueMicrotask(() => {
      this.#responseOrdinal += 1;
      if (this.#toolRoundtrip && this.#responseOrdinal === 1) {
        const responseId = "provider-tool-response-plaintext";
        this.emit({ type: "response.started", provider: this.provider, receivedAtMs: 1, wireType: "response.created", responseId });
        if (this.provider === "gemini") {
          this.emit({
            type: "tool.calls",
            provider: this.provider,
            receivedAtMs: 2,
            wireType: "toolCall",
            responseId,
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
        if (this.provider !== "gemini") {
          this.emit({ type: "response.completed", provider: this.provider, receivedAtMs: 3, wireType: "response.done", responseId, status: "completed" });
        }
        return;
      }
      const responseId = "provider-response-plaintext";
      this.emit({ type: "response.started", provider: this.provider, receivedAtMs: 1, wireType: "response.created", responseId });
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

  private emit(event: NormalizedRealtimeEvent) { for (const listener of this.#listeners) listener(event); }
  private wire(wireType: string, projection: Record<string, unknown>) {
    this.#wireSequence += 1;
    const observation = {
      schemaVersion: 1 as const,
      provider: this.provider,
      direction: "outbound" as const,
      connectionEpoch: 1,
      sequence: this.#wireSequence,
      observedAtMs: this.#wireSequence,
      observedAtMonotonicMs: this.#wireSequence,
      wireType,
      payloadSha256: String(this.#wireSequence).repeat(64).slice(0, 64),
      payloadBytes: 10,
      projectionSha256: "a".repeat(64),
      previousObservationSha256: this.#wireSequence === 1 ? null : "b".repeat(64),
      observationSha256: "c".repeat(64),
      identities: {},
      projection,
    };
    for (const listener of this.#wire) listener(observation);
  }
}

describe("LC4 production realtime adapter bridge", () => {
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
      "caller_pcm_appended",
      "response_plan_prepared",
      "caller_pcm_committed",
      "response_generation_requested",
      "assistant_pcm_captured",
      "listener_evidence_handed_off",
    ]);
    expect(evidence.output_capture.generated_byte_length).toBe(4);
    expect(handoffs).toHaveLength(1);
    const delivered = clients[0]?.preparations[0]?.additionalInstructions ?? "";
    expect(delivered).toContain("\"capability_catalog\"");
    for (const action of responsePlan().capability_catalog.actions) {
      expect(delivered).toContain(`\"name\":\"${action.name}\"`);
      expect(delivered).toContain(action.semantic_hash);
    }
    expect(delivered).not.toContain("test-grant-");
    const encoded = JSON.stringify(evidence);
    expect(encoded).not.toContain(ORACLE_SECRET);
    expect(encoded).not.toContain("provider-response-plaintext");
    await session.close();
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

  it.each(["openai", "gemini"] as const)(
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
      async execute(input) {
        executed.push(`${input.arm}:${input.target_tool}`);
        const providerOutput = { ok: true as const, receipt: "PUBLIC-RESULT" };
        const projectionBody = {
          schema_version: 1 as const,
          bridge_version: "lc4-dev-gateway-bridge-v1" as const,
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
      fake = new FakeRealtimeClient(provider, events, true);
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
      ? ["connect", "append", "prepare", "commit", "create", "submit:false", "create", "submit:false", "create", "listener"]
      : ["connect", "append", "prepare", "commit", "create", "submit:false", "create", "listener"]);
    expect(fake!.submittedToolResults).toHaveLength(provider === "gemini" ? 2 : 1);
    expect(fake!.submittedToolResults[0]?.createResponse).toBe(false);
    expect(evidence.dev_gateway_receipt_set?.receipts).toHaveLength(provider === "gemini" ? 2 : 1);
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
    expect(events).toEqual(["connect", "close", "connect", "close", "connect", "close"]);
  });

  it("keeps native context and the HACC response-plan intervention mutually exclusive", async () => {
    const value = manifest("native");
    const bridge = new Lc4RealtimeProviderBridge((provider) => new FakeRealtimeClient(provider, []));
    const session = await bridge.openSegment({
      manifest: value,
      segment: value.episode_shape.segments[0]!,
      profile: value.episode_shape.provider_profile,
      configuration: configuration(value),
      rotation_context: null,
      listener: { accept() {} },
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
    await session.close();
  });

  it("gives reopened Native and HACC sessions exact substantive-fact parity", () => {
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
      facts: native.facts,
    });
    expect(() => assertLc4RotationSubstantiveFactParity(native, hacc)).not.toThrow();
    expect(hacc.facts.map(({ fact_id, public_text, substantive_sha256, available_after_opportunity }) => ({
      fact_id,
      public_text,
      substantive_sha256,
      available_after_opportunity,
    }))).toEqual(native.facts.map(({ fact_id, public_text, substantive_sha256, available_after_opportunity }) => ({
      fact_id,
      public_text,
      substantive_sha256,
      available_after_opportunity,
    })));

    const changedText = "A substantively different service window.";
    const changedHacc = createLc4HaccRotationStatePacket({
      run_id: value.run_id,
      from_segment_ordinal: 1,
      to_segment_ordinal: 2,
      available_through_opportunity: 20,
      previous_session_rotation_receipt_sha256: previousReceipt,
      flow_state_sha256: "8".repeat(64),
      response_plan_chain_head_sha256: "9".repeat(64),
      facts: native.facts.map((fact, index) => index === 0
        ? { ...fact, public_text: changedText, substantive_sha256: sha256Hex(changedText) }
        : fact),
    });
    expect(() => assertLc4RotationSubstantiveFactParity(native, changedHacc)).toThrow("differ in available substantive facts");
  });

  it("rejects future, oracle-derived, private, and source-unverified Native continuity facts", () => {
    const value = manifest("native");
    const base = publicFacts()[0]!;
    const packet = (fact: Lc4NativeContinuityFactInput) => createLc4StrongNativeContinuityPacket({
      run_id: value.run_id,
      from_segment_ordinal: 1,
      to_segment_ordinal: 2,
      available_through_opportunity: 20,
      previous_session_rotation_receipt_sha256: "7".repeat(64),
      facts: [fact],
    });
    expect(() => packet({ ...base, available_after_opportunity: 21 })).toThrow("future-unavailable");
    expect(() => packet({ ...base, oracle_derived: true } as unknown as Lc4NativeContinuityFactInput)).toThrow("forbids private, oracle, future");
    expect(() => packet({ ...base, private_value_included: true } as unknown as Lc4NativeContinuityFactInput)).toThrow("forbids private, oracle, future");
    expect(() => packet({ ...base, listener_status: "not_applicable" })).toThrow("lacks its required source evidence");
    expect(() => packet({ ...base, source: "oracle_fixture" } as unknown as Lc4NativeContinuityFactInput)).toThrow("source is inadmissible");
  });

  it("injects a receipt-bound strong Native packet at reopen and exposes only its hashes in evidence", async () => {
    const value = manifest("native");
    const configurations: TrialSessionConfiguration[] = [];
    const bridge = new Lc4RealtimeProviderBridge((provider, providerConfiguration) => {
      configurations.push(providerConfiguration);
      return new FakeRealtimeClient(provider, []);
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
      rotation_context: { kind: "strong_native", packet },
      listener: { accept() {} },
    });
    expect(configurations[1]?.instructions).toContain("<lc4_strong_native_continuity");
    for (const fact of packet.facts) expect(configurations[1]?.instructions).toContain(fact.public_text);
    const nativeContext = "native continuation response context";
    const evidence = await second.exchange({
      opportunity_id: "op-21",
      caller_pcm: new Uint8Array([21, 7, 11, 13]),
      response_control: { kind: "native_context", instructions: nativeContext, instructions_sha256: sha256Hex(nativeContext) },
    });
    expect(evidence).toMatchObject({
      rotation_context_kind: "strong_native",
      rotation_context_sha256: packet.packet_sha256,
      rotation_substantive_fact_set_sha256: packet.substantive_fact_set_sha256,
    });
    const encodedEvidence = JSON.stringify(evidence);
    for (const fact of packet.facts) expect(encodedEvidence).not.toContain(fact.public_text);
    await second.close();
  });

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
    await expect(reopen({ kind: "strong_native", packet: { ...packet, packet_sha256: "f".repeat(64) } })).rejects.toThrow("integrity failed");
    const stalePacket = nativeRotationPacket(value, "8".repeat(64), 1);
    await expect(reopen({ kind: "strong_native", packet: stalePacket })).rejects.toThrow("prior session receipt");
    await expect(reopen(haccRotationContext(value, receipt.rotation_receipt_sha256, 1))).rejects.toThrow("differs from the randomized arm");
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

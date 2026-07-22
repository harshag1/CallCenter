import { describe, expect, it } from "vitest";
import { AgentFlowSchema } from "../../flow";
import { createFlowExecutionState, type FlowExecutionState } from "../../flow-runtime";
import { sha256Hex } from "../artifacts";
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
import type { Lc4DevGatewayExecutor } from "../lc4-development-gateway-bridge";
import type { Lc4DevLiveEpisodePlan } from "../lc4-development-live-runner";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";
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
const COMMIT = "b".repeat(40);
const ORACLE_SECRET = "ORACLE-PLAINTEXT-MUST-NOT-LEAK";

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

function manifest(arm: "native" | "hacc" = "hacc"): Lc4EpisodeManifest {
  const schedule = compileLc4ProductionScheduleShape();
  const episode = schedule.episode_shapes.find((candidate) => candidate.arm === arm)!;
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
  #responseOrdinal = 0;
  readonly submittedToolResults: Array<Readonly<{ results: readonly RealtimeToolResult[]; createResponse: boolean | undefined }>> = [];

  constructor(provider: "openai" | "gemini" | "xai", events: string[], toolRoundtrip = false) {
    this.provider = provider;
    this.events = events;
    this.#toolRoundtrip = toolRoundtrip;
  }

  async connect() { this.events.push("connect"); this.state = "ready"; }
  close() { this.events.push("close"); this.state = "closed"; }
  onEvent(listener: RealtimeEventListener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  onWireEvent() { return () => undefined; }
  onWireObservation(listener: RealtimeWireObservationListener) { this.#wire.add(listener); return () => this.#wire.delete(listener); }
  appendInputAudio() { this.events.push("append"); this.wire("input_audio", { plaintext: ORACLE_SECRET }); }
  prepareResponse() { this.events.push("prepare"); this.wire("response.plan", { oracle: ORACLE_SECRET }); }
  commitInputAudio() { this.events.push("commit"); this.wire("input.commit", {}); }
  sendTurn() { throw new Error("bridge must use append/commit, not sendTurn"); }
  submitToolResults(results: readonly RealtimeToolResult[], createResponse?: boolean) {
    if (!this.#toolRoundtrip) throw new Error("not used");
    this.events.push(`submit:${String(createResponse)}`);
    this.submittedToolResults.push({ results, createResponse });
  }
  createResponse() {
    this.events.push("create");
    this.wire("response.create", {});
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
              argumentsText: JSON.stringify({ tool_name: "records.lookup", arguments: { record_id: "PUBLIC-17" } }),
              argumentsJson: { tool_name: "records.lookup", arguments: { record_id: "PUBLIC-17" } },
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
                  name: "records.lookup",
                  arguments: { record_id: "PUBLIC-17" },
                  _meta: {
                    [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: "call-1",
                    [PROVIDER_PROVENANCE_META_KEY]: provenance,
                  },
                },
              },
            }],
          });
        }
        this.emit({ type: "response.completed", provider: this.provider, receivedAtMs: 3, wireType: "response.done", responseId, status: "completed" });
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
      this.emit({ type: "response.completed", provider: this.provider, receivedAtMs: 3, wireType: "response.done", responseId, status: "completed" });
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
    const bridge = new Lc4RealtimeProviderBridge((provider) => new FakeRealtimeClient(provider, events));
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
    const encoded = JSON.stringify(evidence);
    expect(encoded).not.toContain(ORACLE_SECRET);
    expect(encoded).not.toContain("provider-response-plaintext");
    await session.close();
  });

  it("keeps a DEV tool response intermediate, executes the injected gateway, and continues exactly once", async () => {
    const base = manifest("hacc");
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
        return {
          provider_output: { ok: true, receipt: "PUBLIC-RESULT" },
          authoritative_receipt_sha256: "e".repeat(64),
          control_plane_head_sha256: "f".repeat(64),
          disposition: "executed" as const,
        };
      },
    });
    const events: string[] = [];
    let fake: FakeRealtimeClient | null = null;
    const bridge = new Lc4RealtimeProviderBridge((provider) => {
      fake = new FakeRealtimeClient(provider, events, true);
      return fake;
    });
    const session = await bridge.openSegment({
      manifest: devManifest,
      segment: base.episode_shape.segments[0]!,
      profile: base.episode_shape.provider_profile,
      configuration: configuration(base),
      rotation_context: null,
      listener: { accept() { events.push("listener"); } },
      dev_gateway: { episode, opportunities: corpus.opportunities, executor: gateway },
    });
    const evidence = await session.exchange({
      opportunity_id: corpus.opportunities[0]!.id,
      caller_pcm: new Uint8Array([1, 7, 11, 13]),
      response_control: { kind: "hacc_response_plan", plan: responsePlan() },
    });

    expect(executed).toEqual(["hacc:records.lookup"]);
    expect(events).toEqual(["connect", "append", "prepare", "commit", "create", "submit:false", "create", "listener"]);
    expect(fake!.submittedToolResults).toHaveLength(1);
    expect(fake!.submittedToolResults[0]?.createResponse).toBe(false);
    expect(evidence.dev_gateway_receipt_set?.receipts).toHaveLength(1);
    expect(JSON.stringify(evidence.dev_gateway_receipt_set)).not.toContain("PUBLIC-17");
    expect(JSON.stringify(evidence.dev_gateway_receipt_set)).not.toContain("PUBLIC-RESULT");
    await session.close();
  });

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

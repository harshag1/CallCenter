import { describe, expect, it } from "vitest";
import {
  LC4_DEV_AUDIO_CANARY_CONTROL_BYTES,
  LC4_DEV_AUDIO_CANARY_INTENT,
  LC4_DEV_AUDIO_CANARY_PACKETIZER_SHA256,
  LC4_DEV_AUDIO_CANARY_TOOL_SCHEMA_SHA256,
  executeLc4DevAudioCanary,
  lc4DevAudioCanarySpecification,
} from "../provider-dev-audio-canary";
import { DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE } from "../orchestrator";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  LOCAL_TOOL_PROXY_FUNCTION_NAME,
  PROVIDER_PROVENANCE_META_KEY,
  type NormalizedRealtimeClient,
  type NormalizedRealtimeEvent,
  type Pcm16Audio,
  type RealtimeEventListener,
  type RealtimeWireObservation,
  type RealtimeWireObservationListener,
} from "../../realtime/client/types";
import {
  realtimeWireIdentitySha256,
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
} from "../../realtime/client/wire-evidence";
import { canonicalJson, sha256Hex } from "../artifacts";
import type { RealtimeAudioDeliveryRuntime } from "../../realtime/audio-delivery";

class FakeDevAudioClient implements NormalizedRealtimeClient {
  readonly provider = "openai" as const;
  state: "idle" | "ready" | "closed" = "idle";
  readonly #listeners = new Set<RealtimeEventListener>();
  readonly #wireListeners = new Set<RealtimeWireObservationListener>();
  readonly operations: string[] = [];
  readonly appendedBytes: number[] = [];
  preparedControlBytes = 0;
  #wireSequence = 0;
  #wireHead: string | null = null;

  constructor(private readonly mode: "valid" | "pre_trigger" | "unbound_call" = "valid") {}

  async connect(): Promise<void> {
    this.state = "ready";
    this.operations.push("connect");
    if (this.mode === "pre_trigger") this.emitControlledDispatch(true);
  }
  close(): void { this.state = "closed"; this.operations.push("close"); }
  onEvent(listener: RealtimeEventListener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  onWireEvent(): () => void { return () => undefined; }
  onWireObservation(listener: RealtimeWireObservationListener): () => void {
    this.#wireListeners.add(listener);
    return () => this.#wireListeners.delete(listener);
  }
  appendInputAudio(audio: Pcm16Audio): void {
    this.operations.push("append");
    this.appendedBytes.push(audio.data.byteLength);
  }
  prepareResponse(input: Readonly<{ additionalInstructions: string }>): void {
    this.operations.push("prepare");
    this.preparedControlBytes = Buffer.byteLength(input.additionalInstructions, "utf8");
  }
  commitInputAudio(): void {
    this.operations.push("commit");
    this.emitWire("outbound", "input_audio_buffer.commit", { type: "input_audio_buffer.commit" });
  }
  createResponse(): void {
    this.operations.push("create");
    this.emitWire("outbound", "response.create", { type: "response.create" });
    if (this.mode !== "pre_trigger") {
      queueMicrotask(() => this.emitControlledDispatch(this.mode !== "unbound_call"));
    }
  }
  sendTurn(): void { throw new Error("not used"); }
  submitToolResults(): void { throw new Error("not used"); }

  private createWire(
    direction: "inbound" | "outbound",
    wireType: string,
    projection: Readonly<Record<string, unknown>>,
    identities: RealtimeWireObservation["identities"] = {},
  ): RealtimeWireObservation {
    const sequence = this.#wireSequence + 1;
    const projectionSha256 = realtimeWireProjectionSha256(projection);
    const core = Object.freeze({
      schemaVersion: 1 as const,
      provider: this.provider,
      direction,
      connectionEpoch: 1,
      sequence,
      observedAtMs: sequence,
      observedAtMonotonicMs: sequence,
      wireType,
      payloadSha256: sha256Hex(canonicalJson({ direction, wireType, sequence })),
      payloadBytes: 100,
      projectionSha256,
      previousObservationSha256: this.#wireHead,
      identities,
      projection,
    });
    return Object.freeze({ ...core, observationSha256: realtimeWireObservationSha256(core) });
  }

  private emitWire(
    direction: "inbound" | "outbound",
    wireType: string,
    projection: Readonly<Record<string, unknown>>,
    identities: RealtimeWireObservation["identities"] = {},
  ): RealtimeWireObservation {
    const observation = this.createWire(direction, wireType, projection, identities);
    this.#wireSequence = observation.sequence;
    this.#wireHead = observation.observationSha256;
    for (const listener of this.#wireListeners) listener(observation);
    return observation;
  }

  private emitControlledDispatch(retainCallObservation: boolean): void {
    const provenance = Object.freeze({
      schemaVersion: 1 as const,
      provider: this.provider,
      nativeCallId: "dev-call-secret",
      nativeResponseId: "dev-response-secret",
      terminalWireType: "response.function_call_arguments.done",
    });
    const responseIdSha256 = realtimeWireIdentitySha256("response", provenance.nativeResponseId);
    const callIdSha256 = realtimeWireIdentitySha256("call", provenance.nativeCallId);
    const startedObservation = this.emitWire(
      "inbound",
      "response.created",
      { type: "response.created" },
      { responseIdSha256 },
    );
    for (const listener of this.#listeners) listener({
      type: "response.started",
      provider: this.provider,
      receivedAtMs: 1,
      wireType: "response.created",
      responseId: provenance.nativeResponseId,
      wireObservation: {
        availability: "observed",
        connectionEpoch: startedObservation.connectionEpoch,
        sequence: startedObservation.sequence,
        observationSha256: startedObservation.observationSha256,
        payloadSha256: startedObservation.payloadSha256,
        projectionSha256: startedObservation.projectionSha256,
      },
    });
    const projection = { gatewayCalls: [{ name: LOCAL_TOOL_PROXY_FUNCTION_NAME }] };
    const observation = retainCallObservation
      ? this.emitWire("inbound", provenance.terminalWireType, projection, { responseIdSha256, callIdSha256 })
      : this.createWire("inbound", provenance.terminalWireType, projection, { responseIdSha256, callIdSha256 });
    const event = {
      type: "tool.dispatch" as const,
      provider: this.provider,
      receivedAtMs: 1,
      wireType: provenance.terminalWireType,
      responseId: provenance.nativeResponseId,
      wireObservation: {
        availability: "observed" as const,
        connectionEpoch: observation.connectionEpoch,
        sequence: observation.sequence,
        observationSha256: observation.observationSha256,
        payloadSha256: observation.payloadSha256,
        projectionSha256: observation.projectionSha256,
        callIdSha256: observation.identities.callIdSha256,
      },
      gateway: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      dispatches: [{
        callId: provenance.nativeCallId,
        provenance,
        request: {
          method: "tools/call" as const,
          params: {
            name: LC4_DEV_AUDIO_CANARY_INTENT,
            arguments: {},
            _meta: {
              [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: provenance.nativeCallId,
              [PROVIDER_PROVENANCE_META_KEY]: provenance,
            },
          },
        },
      }],
    } as NormalizedRealtimeEvent;
    for (const listener of this.#listeners) listener(event);
  }
}

function deterministicRuntime(): Readonly<{
  runtime: RealtimeAudioDeliveryRuntime;
  sleeps: number[];
}> {
  let current = 0;
  const sleeps: number[] = [];
  return Object.freeze({
    sleeps,
    runtime: Object.freeze({
      monotonicNowMs: () => current,
      sleep: async (delayMs: number) => {
        sleeps.push(delayMs);
        current += delayMs;
      },
    }),
  });
}

describe("LC4 exact DEV-schema audio canary", () => {
  it("uses the production packetizer, realtime pacing, maximum control, and provenance-bound gateway", async () => {
    const client = new FakeDevAudioClient();
    const clock = deterministicRuntime();
    const result = await executeLc4DevAudioCanary({
      provider: "openai",
      model: "gpt-realtime-1.5",
      client,
      sampleRateHz: 24_000,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      audioDeliveryRuntime: clock.runtime,
      timeoutMs: 1_000,
      now: () => new Date("2026-07-22T08:00:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "passed",
      code: "dev_gateway_tool_call_observed",
      callerAudioBytes: 1_920,
      responseGenerationRequested: true,
    });
    expect(result.specification).toEqual(lc4DevAudioCanarySpecification("openai", "gpt-realtime-1.5", 24_000));
    expect(result.specification).toMatchObject({
      tool_schema_sha256: LC4_DEV_AUDIO_CANARY_TOOL_SCHEMA_SHA256,
      control_bytes: LC4_DEV_AUDIO_CANARY_CONTROL_BYTES,
    });
    expect(result.delivery).toMatchObject({
      packetizer_sha256: LC4_DEV_AUDIO_CANARY_PACKETIZER_SHA256,
      audio_bytes: 1_920,
      chunk_count: 2,
      chunk_bytes: [960, 960],
      scheduled_offset_ms: [0, 20],
    });
    expect(clock.sleeps).toEqual([20]);
    expect(client.operations).toEqual(["connect", "append", "append", "prepare", "commit", "create", "close"]);
    expect(client.preparedControlBytes).toBe(LC4_DEV_AUDIO_CANARY_CONTROL_BYTES);
    expect(result.wireObservations).toHaveLength(4);
    expect(result.providerToolCallEvidence).toMatchObject({
      evidence_kind: "provenance_bound_lc4_dev_gateway_dispatch",
      provider: "openai",
      semantic_intent: LC4_DEV_AUDIO_CANARY_INTENT,
    });
    expect(JSON.stringify(result)).not.toContain("dev-call-secret");
    expect(JSON.stringify(result)).not.toContain("dev-response-secret");
  });

  it.each([
    ["pre-trigger tool event", "pre_trigger"],
    ["tool event whose frame was not retained", "unbound_call"],
  ] as const)("fails closed for a %s", async (_label, mode) => {
    const result = await executeLc4DevAudioCanary({
      provider: "openai",
      model: "gpt-realtime-1.5",
      client: new FakeDevAudioClient(mode),
      sampleRateHz: 24_000,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      audioDeliveryRuntime: deterministicRuntime().runtime,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "response_generation_failed",
      providerToolCallEvidence: null,
      providerToolCallEvidenceSha256: null,
    });
  });

  it("fails closed when a substituted delivery path claims one unpaced append", async () => {
    const client = new FakeDevAudioClient();
    const specification = lc4DevAudioCanarySpecification("openai", "gpt-realtime-1.5", 24_000);
    const result = await executeLc4DevAudioCanary({
      provider: "openai",
      model: "gpt-realtime-1.5",
      client,
      sampleRateHz: 24_000,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      audioDeliveryRuntime: deterministicRuntime().runtime,
      timeoutMs: 1_000,
      deliverAudio: async ({ client: deliveryClient, audio }) => {
        deliveryClient.appendInputAudio(audio);
        return Object.freeze({
          packetizer_version: "substituted-single-append",
          packetizer_sha256: LC4_DEV_AUDIO_CANARY_PACKETIZER_SHA256,
          delivery_profile_sha256: "5".repeat(64),
          audio_sha256: specification.audio_sha256,
          audio_bytes: specification.audio_bytes,
          chunk_count: 1,
          chunk_bytes: [specification.audio_bytes],
          chunk_sha256: [specification.audio_sha256],
          scheduled_offset_ms: [0],
        });
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "audio_delivery_contract_failed",
      responseGenerationRequested: false,
    });
    expect(client.operations).toEqual(["connect", "append", "close"]);
  });
});

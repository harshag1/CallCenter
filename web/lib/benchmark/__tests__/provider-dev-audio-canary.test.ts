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
} from "../../realtime/client/types";
import type { RealtimeAudioDeliveryRuntime } from "../../realtime/audio-delivery";

class FakeDevAudioClient implements NormalizedRealtimeClient {
  readonly provider = "openai" as const;
  state: "idle" | "ready" | "closed" = "idle";
  readonly #listeners = new Set<RealtimeEventListener>();
  readonly operations: string[] = [];
  readonly appendedBytes: number[] = [];
  preparedControlBytes = 0;

  async connect(): Promise<void> { this.state = "ready"; this.operations.push("connect"); }
  close(): void { this.state = "closed"; this.operations.push("close"); }
  onEvent(listener: RealtimeEventListener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  onWireEvent(): () => void { return () => undefined; }
  appendInputAudio(audio: Pcm16Audio): void {
    this.operations.push("append");
    this.appendedBytes.push(audio.data.byteLength);
  }
  prepareResponse(input: Readonly<{ additionalInstructions: string }>): void {
    this.operations.push("prepare");
    this.preparedControlBytes = Buffer.byteLength(input.additionalInstructions, "utf8");
  }
  commitInputAudio(): void { this.operations.push("commit"); }
  createResponse(): void {
    this.operations.push("create");
    queueMicrotask(() => this.emitControlledDispatch());
  }
  sendTurn(): void { throw new Error("not used"); }
  submitToolResults(): void { throw new Error("not used"); }

  private emitControlledDispatch(): void {
    const provenance = Object.freeze({
      schemaVersion: 1 as const,
      provider: this.provider,
      nativeCallId: "dev-call-secret",
      nativeResponseId: "dev-response-secret",
      terminalWireType: "response.function_call_arguments.done",
    });
    const event = {
      type: "tool.dispatch" as const,
      provider: this.provider,
      receivedAtMs: 1,
      wireType: provenance.terminalWireType,
      responseId: provenance.nativeResponseId,
      wireObservation: {
        availability: "observed" as const,
        connectionEpoch: 1,
        sequence: 1,
        observationSha256: "1".repeat(64),
        payloadSha256: "2".repeat(64),
        projectionSha256: "3".repeat(64),
        callIdSha256: "4".repeat(64),
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
    expect(JSON.stringify(result)).not.toContain("dev-call-secret");
    expect(JSON.stringify(result)).not.toContain("dev-response-secret");
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

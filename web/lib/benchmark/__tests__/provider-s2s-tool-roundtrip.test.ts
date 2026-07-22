import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import type { LiveStsProvider } from "../live-sts-development-experiment";
import { DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE } from "../orchestrator";
import {
  LC4_S2S_COMPACT_CONTROL,
  LC4_S2S_SOURCE_TEXT,
  LC4_S2S_TOOL_SCHEMA_SHA256,
  executeLc4S2sToolRoundtrip,
  lc4S2sControlSizeDiagnostic,
  loadLc4S2sPcm,
  materializeLc4S2sAudioFixture,
  type Lc4S2sAudioRenderer,
} from "../provider-s2s-tool-roundtrip";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  Pcm16Audio,
  RealtimeEventListener,
  RealtimeWireObservation,
  RealtimeWireObservationListener,
} from "../../realtime/client/types";
import {
  realtimeWireIdentitySha256,
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
} from "../../realtime/client/wire-evidence";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function pcm(sampleRateHz: 16_000 | 24_000): Uint8Array {
  const bytes = new Uint8Array(Math.round(sampleRateHz * 1.2) * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < bytes.byteLength / 2; index += 1) {
    view.setInt16(index * 2, Math.round(Math.sin(2 * Math.PI * 220 * index / sampleRateHz) * 3_000), true);
  }
  return bytes;
}

const renderer: Lc4S2sAudioRenderer = Object.freeze({
  identitySha256: "a".repeat(64),
  async render(text) {
    expect(text).toBe(LC4_S2S_SOURCE_TEXT);
    return Object.freeze({ pcm16k: pcm(16_000), pcm24k: pcm(24_000) });
  },
});

class RoundtripClient implements NormalizedRealtimeClient {
  readonly provider;
  state: "idle" | "ready" | "closed" = "idle";
  readonly #events = new Set<RealtimeEventListener>();
  readonly #wire = new Set<RealtimeWireObservationListener>();
  readonly observations: RealtimeWireObservation[] = [];
  readonly speechBeforeTool: boolean;
  readonly omitDynamicControl: boolean;
  readonly omitToolResultEvent: boolean;
  appendedBytes = 0;
  responseCount = 0;
  pendingControl: { sha256: string; byteLength: number; authority: string } | null = null;
  pendingContinuation = false;

  constructor(provider: LiveStsProvider, options: Readonly<{
    speechBeforeTool?: boolean;
    omitDynamicControl?: boolean;
    omitToolResultEvent?: boolean;
  }> = {}) {
    this.provider = provider;
    this.speechBeforeTool = options.speechBeforeTool === true;
    this.omitDynamicControl = options.omitDynamicControl === true;
    this.omitToolResultEvent = options.omitToolResultEvent === true;
  }

  #observe(direction: "inbound" | "outbound", wireType: string, identities: RealtimeWireObservation["identities"] = {}, extraProjection: Record<string, unknown> = {}) {
    const sequence = this.observations.length + 1;
    const projection = Object.freeze({ wireType, direction, sequence, ...extraProjection });
    const core = Object.freeze({
      schemaVersion: 1 as const,
      provider: this.provider,
      direction,
      connectionEpoch: 1,
      sequence,
      observedAtMs: sequence,
      observedAtMonotonicMs: sequence,
      wireType,
      payloadSha256: sha256Hex(canonicalJson(projection)),
      payloadBytes: 64,
      projectionSha256: realtimeWireProjectionSha256(projection),
      previousObservationSha256: this.observations.at(-1)?.observationSha256 ?? null,
      identities,
      projection,
    });
    const observation = Object.freeze({ ...core, observationSha256: realtimeWireObservationSha256(core) });
    this.observations.push(observation);
    for (const listener of this.#wire) listener(observation);
    return observation;
  }

  #emit(event: NormalizedRealtimeEvent) { for (const listener of this.#events) listener(event); }

  #initialResponse() {
    const responseId = `${this.provider}-initial`;
    const callId = `${this.provider}-call`;
    if (this.speechBeforeTool) {
      this.#emit({
        type: "output.audio", provider: this.provider, receivedAtMs: 2, wireType: "response.audio.delta",
        responseId, audio: new Uint8Array([1, 0]), format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      });
      return;
    }
    const observation = this.#observe(
      "inbound",
      this.provider === "gemini" ? "toolCall" : "response.function_call_arguments.done",
      this.provider === "gemini"
        ? { callIdSha256: realtimeWireIdentitySha256("call", callId) }
        : {
            responseIdSha256: realtimeWireIdentitySha256("response", responseId),
            callIdSha256: realtimeWireIdentitySha256("call", callId),
          },
    );
    this.#emit({
      type: "tool.calls",
      provider: this.provider,
      receivedAtMs: 3,
      wireType: observation.wireType,
      responseId,
      calls: [{
        callId,
        name: "capability_gateway",
        argumentsText: JSON.stringify({ tool_name: "complete_current_stage", arguments: {} }),
        argumentsJson: { tool_name: "complete_current_stage", arguments: {} },
        responseId,
        responseIdSource: this.provider === "gemini" ? "client_local" : "provider",
        ...(this.provider === "gemini" ? {
          causalBinding: {
            connectionEpoch: 1,
            inputTurn: 1,
            trigger: "audio_activity_end" as const,
            clientMessageOrdinal: 1,
            triggerObservationSha256: this.observations.find((item) => item.wireType === "realtimeInput.activityEnd")!.observationSha256,
            providerCallId: callId,
            localResponseId: responseId,
          },
        } : {}),
        terminalWireType: observation.wireType,
      }],
      wireObservation: {
        availability: "observed",
        connectionEpoch: 1,
        sequence: observation.sequence,
        observationSha256: observation.observationSha256,
        payloadSha256: observation.payloadSha256,
        projectionSha256: observation.projectionSha256,
        callIdSha256: observation.identities.callIdSha256,
      },
    });
  }

  #continuation() {
    const responseId = `${this.provider}-continuation`;
    const started = this.#observe("inbound", "response.created", { responseIdSha256: realtimeWireIdentitySha256("response", responseId) });
    this.#emit({ type: "response.started", provider: this.provider, receivedAtMs: 5, wireType: started.wireType, responseId });
    this.#observe("inbound", "response.audio.delta", { responseIdSha256: realtimeWireIdentitySha256("response", responseId) });
    this.#emit({
      type: "output.audio", provider: this.provider, receivedAtMs: 6, wireType: "response.audio.delta", responseId,
      audio: new Uint8Array([1, 0]), format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
    });
    this.#observe("inbound", "response.done", { responseIdSha256: realtimeWireIdentitySha256("response", responseId) });
    this.#emit({ type: "response.completed", provider: this.provider, receivedAtMs: 7, wireType: "response.done", responseId, status: "completed" });
    this.#emit({ type: "usage", provider: this.provider, receivedAtMs: 8, wireType: "usage", responseId, usage: { totalTokens: 5, raw: { total: 5 } } });
  }

  async connect() {
    this.state = "ready";
    this.#emit({ type: "session.ready", provider: this.provider, receivedAtMs: 1, wireType: this.provider === "gemini" ? "setupComplete" : "session.updated" });
  }
  close() { this.state = "closed"; }
  onEvent(listener: RealtimeEventListener) { this.#events.add(listener); return () => this.#events.delete(listener); }
  onWireEvent() { return () => undefined; }
  onWireObservation(listener: RealtimeWireObservationListener) { this.#wire.add(listener); return () => this.#wire.delete(listener); }
  appendInputAudio(audio: Pcm16Audio) { this.appendedBytes += audio.data.byteLength; }
  prepareResponse(preparation: Parameters<NormalizedRealtimeClient["prepareResponse"]>[0]) {
    expect(preparation.additionalInstructions).toBe(LC4_S2S_COMPACT_CONTROL);
    this.pendingControl = {
      sha256: preparation.contextSha256,
      byteLength: Buffer.byteLength(preparation.additionalInstructions),
      authority: preparation.contextAuthority,
    };
    if (this.provider === "gemini") {
      this.#observe("outbound", "clientContent", {}, this.omitDynamicControl ? {} : { dynamicControl: this.pendingControl });
    }
  }
  commitInputAudio() {
    if (this.provider === "gemini") {
      this.#observe("outbound", "realtimeInput.activityEnd");
      this.#initialResponse();
    }
  }
  createResponse() {
    this.responseCount += 1;
    this.#observe("outbound", "response.create", {}, this.pendingControl && !this.omitDynamicControl ? { dynamicControl: this.pendingControl } : {});
    this.pendingControl = null;
    if (this.pendingContinuation) {
      this.#emit({
        type: "tool.continuation.requested", provider: this.provider, receivedAtMs: 5,
        wireType: "response.create", originResponseId: `${this.provider}-initial`, responseIdSource: "provider",
      });
      this.pendingContinuation = false;
    }
    if (this.responseCount === 1) this.#initialResponse();
    else this.#continuation();
  }
  sendTurn() { throw new Error("not used"); }
  submitToolResults(results: readonly { callId: string; output: unknown }[]) {
    const callId = `${this.provider}-call`;
    expect(results).toEqual([{ callId, output: { ok: true, qualification_stage: "completed" } }]);
    this.#observe("outbound", this.provider === "gemini" ? "toolResponse" : "conversation.item.create", {
      callIdSha256: realtimeWireIdentitySha256("call", callId),
    });
    if (!this.omitToolResultEvent) {
      this.#emit({
        type: "tool.results.submitted", provider: this.provider, receivedAtMs: 4,
        wireType: this.provider === "gemini" ? "toolResponse" : "client.tool_results.submitted",
        responseId: `${this.provider}-initial`, responseIdSource: this.provider === "gemini" ? "client_local" : "provider",
        callIds: [callId], continuationRequested: this.provider === "gemini",
      });
    }
    if (this.provider === "gemini") this.#continuation();
    else this.pendingContinuation = true;
  }
  async waitForInputAudioCommit() {
    this.#emit({ type: "input.audio_committed", provider: this.provider, receivedAtMs: 4, wireType: "input_audio_buffer.committed", connectionEpoch: 1, commitOrdinal: 1 });
    return Object.freeze({
      provider: this.provider === "xai" ? "xai" as const : "openai" as const,
      connectionEpoch: 1,
      commitOrdinal: 1,
      status: "acknowledged" as const,
    });
  }
}

describe("LC4 qualification v3 spoken S2S roundtrip", () => {
  it("materializes one native-rate CAS fixture and keeps the size diagnostic non-gating", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    expect(artifact.provider_renditions.openai.sha256).toBe(artifact.provider_renditions.xai.sha256);
    expect(artifact.provider_renditions.gemini.duration_ms).toBe(1_200);
    expect(sha256Hex(await readFile(join(root, artifact.provider_renditions.gemini.path)))).toBe(artifact.provider_renditions.gemini.sha256);
    const diagnostic = lc4S2sControlSizeDiagnostic();
    expect(diagnostic.qualification_gate).toBe(false);
    expect(diagnostic.compact_control_bytes).toBeLessThan(512);
    expect(diagnostic.bytes_removed).toBeGreaterThan(35_000);
  });

  for (const provider of ["openai", "gemini", "xai"] as const) {
    it(`requires the complete ${provider} tool-result continuation`, async () => {
      const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
      roots.push(root);
      const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
      const audio = await loadLc4S2sPcm({ root, artifact, provider });
      const client = new RoundtripClient(provider);
      const execution = await executeLc4S2sToolRoundtrip({
        provider,
        model: `${provider}-model`,
        client,
        audio,
        audioObject: artifact.provider_renditions[provider],
        profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
        runtime: { monotonicNowMs: () => 0, sleep: async () => undefined },
        timeoutMs: 1_000,
      });
      expect(execution, canonicalJson({ failure: execution.failure_class, operations: execution.operation_order })).toMatchObject({
        status: "passed",
        failure_class: "none",
        tool_call_observed: true,
        tool_result_wire_observed: true,
        post_tool_continuation_observed: true,
        post_tool_terminal_observed: true,
        post_tool_usage_observed: true,
        tool_schema_sha256: LC4_S2S_TOOL_SCHEMA_SHA256,
      });
      expect(client.appendedBytes).toBe(artifact.provider_renditions[provider].byte_length);
    });
  }

  it("fails permanently when the model speaks before the required tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "openai" });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "openai",
      model: "openai-model",
      client: new RoundtripClient("openai", { speechBeforeTool: true }),
      audio,
      audioObject: artifact.provider_renditions.openai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined },
      timeoutMs: 1_000,
    });
    expect(execution.status).toBe("failed");
    expect(execution.failure_class).toBe("speech_before_tool");
  });

  it("fails closed without the provider commit acknowledgement barrier", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "xai" });
    const client = new RoundtripClient("xai");
    Object.defineProperty(client, "waitForInputAudioCommit", { value: undefined });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "xai", model: "xai-model", client, audio,
      audioObject: artifact.provider_renditions.xai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined }, timeoutMs: 1_000,
    });
    expect(execution.failure_class).toBe("commit_acknowledgement_failed");
  });

  it("rejects a call whose compact dynamic control is absent from wire evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "gemini" });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "gemini", model: "gemini-model", client: new RoundtripClient("gemini", { omitDynamicControl: true }), audio,
      audioObject: artifact.provider_renditions.gemini,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined }, timeoutMs: 1_000,
    });
    expect(execution.status).toBe("failed");
    expect(execution.failure_class).toBe("dynamic_control_not_wire_observed");
  });

  it("does not infer result delivery from an outbound frame without the normalized result event", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "openai" });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "openai", model: "openai-model", client: new RoundtripClient("openai", { omitToolResultEvent: true }), audio,
      audioObject: artifact.provider_renditions.openai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined }, timeoutMs: 1_000,
    });
    expect(execution.failure_class).toBe("tool_result_event_missing");
  });
});

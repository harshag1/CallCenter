import {
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../artifacts";
import {
  captureOutputVoiceCalibration,
  createOutputVoiceCaptureSessionConfiguration,
  createOutputVoiceCaptureTrigger,
  outputVoiceCaptureSlotIds,
  type OutputVoiceCaptureSigner,
} from "../long-call-output-voice-capture";
import {
  LONG_CALL_ASR_OUTPUT_VOICE_ROUTES,
  verifyOutputVoiceCalibrationPcm,
} from "../long-call-asr-calibration";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  Pcm16Audio,
  RealtimeEventListener,
  RealtimeWireEventListener,
  RealtimeWireObservation,
  RealtimeWireObservationListener,
  RealtimeClientState,
  SessionConfigurationAcknowledgement,
} from "../../realtime/client/types";
import {
  realtimeWireIdentitySha256,
  realtimeWireObservationReference,
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
} from "../../realtime/client/wire-evidence";
import type { LiveStsProvider } from "../live-sts-development-experiment";

const HASH = "a".repeat(64);

function signer(): OutputVoiceCaptureSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return Object.freeze({
    privateKey,
    authority: Object.freeze({
      keyId: "test-output-voice-authority",
      publicKeyPem,
      publicKeySha256: sha256Hex(createPublicKey(publicKeyPem).export({ format: "der", type: "spki" })),
    }),
  });
}

function acknowledgement(): SessionConfigurationAcknowledgement {
  const verified = Object.freeze({ status: "verified" as const, requestedSha256: HASH, acknowledgedSha256: HASH });
  const notRequested = Object.freeze({ status: "not_requested" as const });
  return Object.freeze({
    schemaVersion: 1,
    strictParityVerified: true,
    paidBenchmarkReady: true,
    fields: Object.freeze({
      model: verified,
      voice: verified,
      instructions: verified,
      tools: verified,
      tool_choice: verified,
      input_audio: verified,
      output_audio: verified,
      turn_detection: notRequested,
    }),
  });
}

class FakeCaptureClient implements NormalizedRealtimeClient {
  readonly provider: LiveStsProvider;
  readonly sessionConfigurationAcknowledgement = acknowledgement();
  state: RealtimeClientState = "idle";
  readonly responsePcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
  private eventListeners = new Set<RealtimeEventListener>();
  private wireListeners = new Set<RealtimeWireObservationListener>();
  private observations: RealtimeWireObservation[] = [];
  private responseId = "response-test-1";

  constructor(provider: LiveStsProvider) {
    this.provider = provider;
  }

  onEvent(listener: RealtimeEventListener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onWireEvent(listener: RealtimeWireEventListener) {
    void listener;
    return () => undefined;
  }

  onWireObservation(listener: RealtimeWireObservationListener) {
    this.wireListeners.add(listener);
    return () => this.wireListeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.state = "ready";
    this.observe("outbound", "session.update", { kind: "configuration", credentialRetained: false });
    const readyWire = this.observe("inbound", "session.updated", { kind: "configuration_ack" }, {
      sessionIdSha256: realtimeWireIdentitySha256("session", `session-${this.provider}`),
    });
    this.emit({
      type: "session.ready",
      provider: this.provider,
      receivedAtMs: Date.now(),
      wireType: readyWire.wireType,
      sessionId: `session-${this.provider}`,
      configuration: this.sessionConfigurationAcknowledgement,
      wireObservation: realtimeWireObservationReference(readyWire),
    });
  }

  appendInputAudio(audio: Pcm16Audio): void {
    this.observe("outbound", "input_audio_buffer.append", {
      audioSha256: sha256Hex(audio.data),
      audioBytes: audio.data.byteLength,
    });
  }

  prepareResponse(preparation: Parameters<NormalizedRealtimeClient["prepareResponse"]>[0]): void {
    this.observe("outbound", "response.prepare", {
      contextSha256: preparation.contextSha256,
      contextAuthority: preparation.contextAuthority,
    });
  }

  commitInputAudio(): void {
    this.observe("outbound", "input_audio_buffer.commit", { committed: true });
  }

  createResponse(): void {
    const startedWire = this.observe("inbound", "response.created", { status: "in_progress" }, {
      responseIdSha256: realtimeWireIdentitySha256("response", this.responseId),
    });
    this.emit({
      type: "response.started",
      provider: this.provider,
      receivedAtMs: Date.now(),
      wireType: startedWire.wireType,
      responseId: this.responseId,
      wireObservation: realtimeWireObservationReference(startedWire),
    });
    const audioWire = this.observe("inbound", "response.audio.delta", {
      audioSha256: sha256Hex(this.responsePcm),
      audioBytes: this.responsePcm.byteLength,
    }, { responseIdSha256: realtimeWireIdentitySha256("response", this.responseId) });
    this.emit({
      type: "output.audio",
      provider: this.provider,
      receivedAtMs: Date.now(),
      wireType: audioWire.wireType,
      responseId: this.responseId,
      audio: new Uint8Array(this.responsePcm),
      format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      wireObservation: realtimeWireObservationReference(audioWire),
    });
    const completedWire = this.observe("inbound", "response.done", { status: "completed" }, {
      responseIdSha256: realtimeWireIdentitySha256("response", this.responseId),
    });
    this.emit({
      type: "response.completed",
      provider: this.provider,
      receivedAtMs: Date.now(),
      wireType: completedWire.wireType,
      responseId: this.responseId,
      status: "completed",
      wireObservation: realtimeWireObservationReference(completedWire),
    });
  }

  sendTurn(): void {
    throw new Error("capture must use the explicit prepared-response path");
  }

  submitToolResults(): void {
    throw new Error("capture must not submit tool results");
  }

  close(): void {
    this.state = "closed";
  }

  private emit(event: NormalizedRealtimeEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private observe(
    direction: "inbound" | "outbound",
    wireType: string,
    projection: Readonly<Record<string, unknown>>,
    identities: RealtimeWireObservation["identities"] = {},
  ): RealtimeWireObservation {
    const sequence = this.observations.length + 1;
    const core = Object.freeze({
      schemaVersion: 1 as const,
      provider: this.provider,
      direction,
      connectionEpoch: 1,
      sequence,
      observedAtMs: 1_750_000_000_000 + sequence,
      observedAtMonotonicMs: sequence,
      wireType,
      payloadSha256: sha256Hex(`payload-${this.provider}-${sequence}`),
      payloadBytes: 64,
      projectionSha256: realtimeWireProjectionSha256(projection),
      previousObservationSha256: this.observations.at(-1)?.observationSha256 ?? null,
      identities: Object.freeze({ ...identities }),
      projection: Object.freeze({ ...projection }),
    });
    const observation = Object.freeze({
      ...core,
      observationSha256: realtimeWireObservationSha256(core),
    });
    this.observations.push(observation);
    for (const listener of this.wireListeners) listener(observation);
    return observation;
  }
}

describe("production output-voice calibration capture", () => {
  it("builds the exact 18 signed fixtures through all pinned provider adapters", async () => {
    const authority = signer();
    const calls: Array<{ provider: LiveStsProvider; sampleRateHz: number; model: string }> = [];
    const batch = await captureOutputVoiceCalibration({
      signer: authority,
      toolchain: { implementationSha256: "b".repeat(64), sourceCommitSha256: "c".repeat(64) },
      responseTimeoutMs: 2_000,
      createClient: (provider, configuration) => {
        calls.push({ provider, sampleRateHz: configuration.inputAudioFormat.sampleRateHz, model: configuration.model });
        return new FakeCaptureClient(provider);
      },
    });

    expect(outputVoiceCaptureSlotIds()).toHaveLength(6);
    expect(batch.captures).toHaveLength(18);
    expect(batch.manifest.fixtures).toHaveLength(18);
    expect(new Set(batch.captures.map((capture) => capture.fixture.provider))).toEqual(new Set(["openai", "gemini", "xai"]));
    expect(calls.filter((call) => call.provider === "gemini").every((call) => call.sampleRateHz === 16_000)).toBe(true);
    expect(calls.filter((call) => call.provider !== "gemini").every((call) => call.sampleRateHz === 24_000)).toBe(true);
    for (const route of LONG_CALL_ASR_OUTPUT_VOICE_ROUTES) {
      expect(calls.filter((call) => call.provider === route.provider).map((call) => call.model)).toEqual(
        Array.from({ length: 6 }, () => route.model),
      );
    }
    for (const capture of batch.captures) {
      verifyOutputVoiceCalibrationPcm({
        fixture: capture.fixture,
        pcm: capture.pcm,
        expectedCaptureAuthoritySha256: authority.authority.publicKeySha256,
      });
      expect(sha256Hex(capture.sanitizedWireJsonl)).toBe(
        capture.fixture.captureReceipt.wireCapture.sanitizedEventLogSha256,
      );
      expect(capture.sanitizedWireJsonl).not.toContain(capture.fixture.referenceText);
      expect(capture.fixture.captureReceipt.providerReceipt.credentialFieldsRetained).toEqual([]);
    }
  });

  it("rejects the batch when the last provider/profile fails instead of returning partial fixtures", async () => {
    const authority = signer();
    let calls = 0;
    await expect(captureOutputVoiceCalibration({
      signer: authority,
      toolchain: { implementationSha256: "b".repeat(64), sourceCommitSha256: "c".repeat(64) },
      responseTimeoutMs: 2_000,
      createClient: (provider) => {
        calls += 1;
        if (calls === 18) throw new Error("injected final profile failure");
        return new FakeCaptureClient(provider);
      },
    })).rejects.toThrow("injected final profile failure");
    expect(calls).toBe(18);
  });

  it("pins deterministic trigger and session contracts", () => {
    expect(createOutputVoiceCaptureTrigger(16_000).data).toHaveLength(32_000);
    expect(createOutputVoiceCaptureTrigger(24_000).data).toHaveLength(48_000);
    expect(() => createOutputVoiceCaptureTrigger(48_000)).toThrow("unsupported");
    for (const route of LONG_CALL_ASR_OUTPUT_VOICE_ROUTES) {
      const configuration = createOutputVoiceCaptureSessionConfiguration(route);
      expect(configuration.provider).toBe(route.provider);
      expect(configuration.model).toBe(route.model);
      expect(configuration.providerTools).toEqual([]);
      expect(configuration.audioDeliveryProfile).toEqual({ schemaVersion: 1, chunkMs: 20, pace: "realtime" });
    }
  });
});

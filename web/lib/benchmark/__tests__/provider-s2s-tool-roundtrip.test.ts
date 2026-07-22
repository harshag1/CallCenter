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
  assertLc4S2sRoundtripExecution,
  executeLc4S2sToolRoundtrip,
  lc4S2sControlSizeDiagnostic,
  loadLc4S2sPcm,
  materializeLc4S2sAudioFixture,
  type Lc4S2sAudioRenderer,
} from "../provider-s2s-tool-roundtrip";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  NormalizedRealtimeUsage,
  LocalToolProxyDispatch,
  Pcm16Audio,
  ProviderToolCallProvenance,
  RealtimeEventListener,
  RealtimeWireObservation,
  RealtimeWireObservationListener,
} from "../../realtime/client/types";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  LOCAL_TOOL_PROXY_FUNCTION_NAME,
  PROVIDER_PROVENANCE_META_KEY,
} from "../../realtime/client/types";
import {
  realtimeWireIdentitySha256,
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
} from "../../realtime/client/wire-evidence";
import { createRealtimeTransportFailureDiagnostic } from "../../realtime/client/transport-diagnostics";
import { LC4_XAI_SERVER_VAD_SHA256 } from "../xai-server-vad";

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

class RoundtripClient implements NormalizedRealtimeClient {
  readonly provider;
  state: "idle" | "ready" | "closed" = "idle";
  readonly #events = new Set<RealtimeEventListener>();
  readonly #wire = new Set<RealtimeWireObservationListener>();
  readonly observations: RealtimeWireObservation[] = [];
  readonly speechBeforeTool: boolean;
  readonly omitDynamicControl: boolean;
  readonly omitToolResultEvent: boolean;
  readonly emitManualVadOnCommit: boolean;
  readonly emitEarlyResponseOnCommit: boolean;
  readonly rejectCommitAcknowledgement: boolean;
  readonly emitProviderFailure: boolean;
  readonly rejectServerVadControlAcknowledgement: boolean;
  readonly omitServerVadSpeechStart: boolean;
  readonly omitServerVadSpeechStop: boolean;
  readonly omitServerVadAutoCommit: boolean;
  readonly localGatewayDispatchMode: "none" | "exact" | "completion_first" | "competing" | "malformed" | "call_free";
  readonly continuationUsage: NormalizedRealtimeUsage;
  readonly providerUsageCounters: Readonly<Record<string, number>> | null;
  readonly continuationUsageResponseId: "continuation" | "initial";
  readonly malformedInputAudioProjection: boolean;
  appendedBytes = 0;
  responseCount = 0;
  readonly responseToolChoices: unknown[] = [];
  pendingControl: { sha256: string; byteLength: number; authority: string } | null = null;
  pendingContinuation = false;

  constructor(provider: LiveStsProvider, options: Readonly<{
    speechBeforeTool?: boolean;
    omitDynamicControl?: boolean;
    omitToolResultEvent?: boolean;
    emitManualVadOnCommit?: boolean;
    emitEarlyResponseOnCommit?: boolean;
    rejectCommitAcknowledgement?: boolean;
    emitProviderFailure?: boolean;
    rejectServerVadControlAcknowledgement?: boolean;
    omitServerVadSpeechStart?: boolean;
    omitServerVadSpeechStop?: boolean;
    omitServerVadAutoCommit?: boolean;
    localGatewayDispatchMode?: "exact" | "completion_first" | "competing" | "malformed" | "call_free";
    continuationUsage?: NormalizedRealtimeUsage;
    providerUsageCounters?: Readonly<Record<string, number>> | null;
    continuationUsageResponseId?: "continuation" | "initial";
    malformedInputAudioProjection?: boolean;
  }> = {}) {
    this.provider = provider;
    this.speechBeforeTool = options.speechBeforeTool === true;
    this.omitDynamicControl = options.omitDynamicControl === true;
    this.omitToolResultEvent = options.omitToolResultEvent === true;
    this.emitManualVadOnCommit = options.emitManualVadOnCommit === true;
    this.emitEarlyResponseOnCommit = options.emitEarlyResponseOnCommit === true;
    this.rejectCommitAcknowledgement = options.rejectCommitAcknowledgement === true;
    this.emitProviderFailure = options.emitProviderFailure === true;
    this.rejectServerVadControlAcknowledgement = options.rejectServerVadControlAcknowledgement === true;
    this.omitServerVadSpeechStart = options.omitServerVadSpeechStart === true;
    this.omitServerVadSpeechStop = options.omitServerVadSpeechStop === true;
    this.omitServerVadAutoCommit = options.omitServerVadAutoCommit === true;
    this.localGatewayDispatchMode = options.localGatewayDispatchMode ?? "none";
    this.continuationUsage = options.continuationUsage ?? {
      totalTokens: 5,
      meteringSource: "provider_reported",
      raw: { total: 5 },
    };
    this.providerUsageCounters = options.providerUsageCounters === undefined
      ? Object.freeze({ totalTokens: 5 })
      : options.providerUsageCounters;
    this.continuationUsageResponseId = options.continuationUsageResponseId ?? "continuation";
    this.malformedInputAudioProjection = options.malformedInputAudioProjection === true;
  }

  get serverVadTransportParitySha256() {
    return this.provider === "xai" ? LC4_XAI_SERVER_VAD_SHA256 : undefined;
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
    if (this.emitProviderFailure) {
      const observation = this.#observe("inbound", "error", {}, {
        error: { code: "response_generation_failed", category: "provider_service" },
      });
      this.#emit({
        type: "error",
        provider: this.provider,
        receivedAtMs: 3,
        wireType: "error",
        code: "response_generation_failed",
        message: "plaintext must not enter retained diagnostic evidence",
        fatal: false,
        wireObservation: {
          availability: "observed",
          connectionEpoch: 1,
          sequence: observation.sequence,
          observationSha256: observation.observationSha256,
          payloadSha256: observation.payloadSha256,
          projectionSha256: observation.projectionSha256,
        },
        transportDiagnostic: createRealtimeTransportFailureDiagnostic({
          origin: "provider_wire",
          rawCode: "response_generation_failed",
          message: "plaintext must not enter retained diagnostic evidence",
          responseGenerationRequested: true,
          responseGenerationStarted: false,
          responseTerminalObserved: false,
        }),
      });
      return;
    }
    if (this.speechBeforeTool) {
      this.#emit({
        type: "output.audio", provider: this.provider, receivedAtMs: 2, wireType: "response.audio.delta",
        responseId, audio: new Uint8Array([1, 0]), format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      });
      return;
    }
    const observation = this.#observe(
      "inbound",
      this.provider === "gemini"
        ? "toolCall"
        : this.localGatewayDispatchMode !== "none"
          ? "response.done"
          : "response.function_call_arguments.done",
      this.provider === "gemini"
        ? { callIdSha256: realtimeWireIdentitySha256("call", callId) }
        : {
            responseIdSha256: realtimeWireIdentitySha256("response", responseId),
            callIdSha256: realtimeWireIdentitySha256("call", callId),
          },
    );
    const wireObservation = {
      availability: "observed" as const,
      connectionEpoch: 1,
      sequence: observation.sequence,
      observationSha256: observation.observationSha256,
      payloadSha256: observation.payloadSha256,
      projectionSha256: observation.projectionSha256,
      callIdSha256: observation.identities.callIdSha256,
    };
    if (this.localGatewayDispatchMode !== "none" && this.provider !== "gemini") {
      const provenance = Object.freeze({
        schemaVersion: 1 as const,
        provider: this.provider,
        nativeCallId: callId,
        nativeResponseId: this.localGatewayDispatchMode === "malformed" ? `${responseId}-forged` : responseId,
        nativeItemId: `${this.provider}-item`,
        terminalEventId: `${this.provider}-terminal-event`,
        terminalWireType: observation.wireType,
      });
      const completion = {
        type: "response.completed" as const,
        provider: this.provider,
        receivedAtMs: 3,
        wireType: observation.wireType,
        nativeEventId: provenance.terminalEventId,
        responseId,
        status: "completed" as const,
        wireObservation,
      };
      if (this.localGatewayDispatchMode === "call_free") {
        this.#emit(completion);
        return;
      }
      const dispatches: Array<{
        callId: string;
        provenance: ProviderToolCallProvenance;
        request: LocalToolProxyDispatch;
      }> = [{
        callId,
        provenance,
        request: {
          method: "tools/call" as const,
          params: {
            name: "complete_current_stage",
            arguments: {},
            _meta: {
              [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: callId,
              [PROVIDER_PROVENANCE_META_KEY]: provenance,
            },
          },
        },
      }];
      if (this.localGatewayDispatchMode === "competing") {
        const competingCallId = `${callId}-competing`;
        const competingProvenance = Object.freeze({
          ...provenance,
          nativeCallId: competingCallId,
          nativeItemId: `${this.provider}-competing-item`,
        });
        dispatches.push({
          callId: competingCallId,
          provenance: competingProvenance,
          request: {
            method: "tools/call",
            params: {
              name: "complete_current_stage",
              arguments: {},
              _meta: {
                [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: competingCallId,
                [PROVIDER_PROVENANCE_META_KEY]: competingProvenance,
              },
            },
          },
        });
      }
      if (this.localGatewayDispatchMode === "completion_first") this.#emit(completion);
      this.#emit({
        type: "tool.dispatch",
        provider: this.provider,
        receivedAtMs: 3,
        wireType: observation.wireType,
        nativeEventId: provenance.terminalEventId,
        responseId,
        gateway: LOCAL_TOOL_PROXY_FUNCTION_NAME,
        dispatches,
        wireObservation,
      });
      if (this.localGatewayDispatchMode !== "completion_first") this.#emit(completion);
    } else {
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
        wireObservation,
      });
    }
  }

  #continuation() {
    const responseId = `${this.provider}-continuation`;
    const started = this.#observe(
      "inbound",
      this.provider === "gemini" ? "serverContent" : "response.created",
      this.provider === "gemini"
        ? {}
        : { responseIdSha256: realtimeWireIdentitySha256("response", responseId) },
    );
    this.#emit({
      type: "response.started", provider: this.provider, receivedAtMs: 5,
      wireType: started.wireType, responseId,
      wireObservation: {
        availability: "observed", connectionEpoch: 1, sequence: started.sequence,
        observationSha256: started.observationSha256, payloadSha256: started.payloadSha256,
        projectionSha256: started.projectionSha256,
      },
    });
    const outputAudio = new Uint8Array([1, 0]);
    this.#observe(
      "inbound",
      "response.audio.delta",
      { responseIdSha256: realtimeWireIdentitySha256("response", responseId) },
      {
        audio: {
          direction: "output",
          validCanonicalBase64: true,
          sha256: sha256Hex(outputAudio),
          byteLength: outputAudio.byteLength,
          format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        },
      },
    );
    this.#emit({
      type: "output.audio", provider: this.provider, receivedAtMs: 6, wireType: "response.audio.delta", responseId,
      audio: outputAudio, format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
    });
    const terminal = this.#observe(
      "inbound",
      "response.done",
      { responseIdSha256: realtimeWireIdentitySha256("response", responseId) },
      { terminal: { status: "completed" } },
    );
    const terminalReference = {
      availability: "observed" as const,
      connectionEpoch: 1,
      sequence: terminal.sequence,
      observationSha256: terminal.observationSha256,
      payloadSha256: terminal.payloadSha256,
      projectionSha256: terminal.projectionSha256,
    };
    this.#emit({
      type: "response.completed", provider: this.provider, receivedAtMs: 7,
      wireType: "response.done", responseId, status: "completed", wireObservation: terminalReference,
    });
    const usageResponseId = this.continuationUsageResponseId === "continuation"
      ? responseId
      : `${this.provider}-initial`;
    const providerUsage = this.continuationUsage.meteringSource !== "client_measured"
        && this.providerUsageCounters !== null
      ? this.#observe(
          "inbound",
          "usage",
          { responseIdSha256: realtimeWireIdentitySha256("response", usageResponseId) },
          { usage: this.providerUsageCounters },
        )
      : null;
    this.#emit({
      type: "usage", provider: this.provider, receivedAtMs: 8, wireType: "usage",
      responseId: usageResponseId,
      usage: this.continuationUsage,
      ...(providerUsage === null ? {} : {
        wireObservation: {
          availability: "observed" as const,
          connectionEpoch: 1,
          sequence: providerUsage.sequence,
          observationSha256: providerUsage.observationSha256,
          payloadSha256: providerUsage.payloadSha256,
          projectionSha256: providerUsage.projectionSha256,
        },
      }),
    });
  }

  async connect() {
    this.state = "ready";
    this.#emit({ type: "session.ready", provider: this.provider, receivedAtMs: 1, wireType: this.provider === "gemini" ? "setupComplete" : "session.updated" });
  }
  close() { this.state = "closed"; }
  onEvent(listener: RealtimeEventListener) { this.#events.add(listener); return () => this.#events.delete(listener); }
  onWireEvent() { return () => undefined; }
  onWireObservation(listener: RealtimeWireObservationListener) { this.#wire.add(listener); return () => this.#wire.delete(listener); }
  appendInputAudio(audio: Pcm16Audio) {
    this.appendedBytes += audio.data.byteLength;
    this.#observe(
      "outbound",
      this.provider === "gemini" ? "realtimeInput.audio" : "input_audio_buffer.append",
      {},
      {
        audio: {
          direction: "input",
          validCanonicalBase64: !this.malformedInputAudioProjection,
          sha256: sha256Hex(audio.data),
          byteLength: audio.data.byteLength,
          format: { encoding: "pcm16", sampleRateHz: audio.sampleRateHz, channels: audio.channels },
        },
      },
    );
    if (this.provider !== "xai" || this.appendedBytes !== 24_000 * 1.2 * 2) return;
    if (this.emitEarlyResponseOnCommit) {
      const early = this.#observe("inbound", "response.created", {
        responseIdSha256: realtimeWireIdentitySha256("response", "xai-early"),
      });
      this.#emit({
        type: "response.started", provider: "xai", receivedAtMs: 2,
        wireType: early.wireType, responseId: "xai-early",
      });
      return;
    }
    let speechStopObservation: RealtimeWireObservation | null = null;
    if (!this.omitServerVadSpeechStart) {
      const started = this.#observe("inbound", "input_audio_buffer.speech_started");
      this.#emit({
        type: "input.speech_activity", provider: "xai", receivedAtMs: 2,
        wireType: started.wireType, phase: "started",
        wireObservation: {
          availability: "observed", connectionEpoch: 1, sequence: started.sequence,
          observationSha256: started.observationSha256, payloadSha256: started.payloadSha256,
          projectionSha256: started.projectionSha256,
        },
      });
    }
    if (!this.omitServerVadSpeechStop) {
      speechStopObservation = this.#observe("inbound", "input_audio_buffer.speech_stopped");
      this.#emit({
        type: "input.speech_activity", provider: "xai", receivedAtMs: 3,
        wireType: speechStopObservation.wireType, phase: "stopped",
        wireObservation: {
          availability: "observed", connectionEpoch: 1, sequence: speechStopObservation.sequence,
          observationSha256: speechStopObservation.observationSha256,
          payloadSha256: speechStopObservation.payloadSha256,
          projectionSha256: speechStopObservation.projectionSha256,
        },
      });
    }
    if (!this.omitServerVadAutoCommit) {
      const committed = this.#observe("inbound", "input_audio_buffer.committed");
      this.#emit({
        type: "input.audio_committed", provider: "xai", receivedAtMs: 4,
        wireType: committed.wireType, connectionEpoch: 1, commitOrdinal: 1,
        wireObservation: {
          availability: "observed", connectionEpoch: 1, sequence: committed.sequence,
          observationSha256: committed.observationSha256, payloadSha256: committed.payloadSha256,
          projectionSha256: committed.projectionSha256,
        },
      });
    }
    const rootResponse = this.#observe("inbound", "response.created", {
      responseIdSha256: realtimeWireIdentitySha256("response", "xai-initial"),
    });
    this.#emit({
      type: "response.started", provider: "xai", receivedAtMs: 5,
      wireType: rootResponse.wireType, responseId: "xai-initial",
      causalBinding: {
        trigger: "server_vad_speech_stopped",
        turnOrdinal: 1,
        triggerObservationSha256: speechStopObservation?.observationSha256 ?? "0".repeat(64),
      },
    });
    this.responseCount = 1;
    this.#initialResponse();
  }
  async prepareServerVadTurn(preparation: Parameters<NonNullable<NormalizedRealtimeClient["prepareServerVadTurn"]>>[0]) {
    if (this.provider !== "xai") throw new Error("server VAD is xAI-only in this fixture");
    if (this.rejectServerVadControlAcknowledgement) throw new Error("session.updated timed out");
    expect(preparation.additionalInstructions).toBe(LC4_S2S_COMPACT_CONTROL);
    const dynamicControl = {
      sha256: preparation.contextSha256,
      byteLength: Buffer.byteLength(preparation.additionalInstructions),
      authority: preparation.contextAuthority,
      toolFrontierSha256: preparation.toolFrontierSha256,
      transportParitySha256: preparation.transportParitySha256,
    };
    const outbound = this.#observe("outbound", "session.update", {}, { dynamicControl });
    const inbound = this.#observe("inbound", "session.updated");
    return Object.freeze({
      provider: "xai" as const,
      connectionEpoch: 1,
      turnOrdinal: 1,
      status: "acknowledged" as const,
      contextSha256: preparation.contextSha256,
      toolFrontierSha256: preparation.toolFrontierSha256,
      transportParitySha256: preparation.transportParitySha256,
      configuration: exactServerVadAcknowledgement(),
      outboundObservation: {
        availability: "observed" as const,
        connectionEpoch: 1,
        sequence: outbound.sequence,
        observationSha256: outbound.observationSha256,
        payloadSha256: outbound.payloadSha256,
        projectionSha256: outbound.projectionSha256,
      },
      inboundObservation: {
        availability: "observed" as const,
        connectionEpoch: 1,
        sequence: inbound.sequence,
        observationSha256: inbound.observationSha256,
        payloadSha256: inbound.payloadSha256,
        projectionSha256: inbound.projectionSha256,
      },
    });
  }
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
      return;
    }
    if (this.emitManualVadOnCommit) {
      this.#observe("inbound", "input_audio_buffer.speech_started");
      this.#emit({
        type: "error", provider: this.provider, receivedAtMs: 4,
        wireType: "input_audio_buffer.speech_started",
        code: "unexpected_manual_turn_detection_event",
        message: "Provider emitted VAD activity while manual mode was requested",
        fatal: false,
      });
    }
    if (this.emitEarlyResponseOnCommit) {
      const observation = this.#observe("inbound", "response.created", {
        responseIdSha256: realtimeWireIdentitySha256("response", `${this.provider}-early`),
      });
      this.#emit({
        type: "response.started", provider: this.provider, receivedAtMs: 4,
        wireType: observation.wireType, responseId: `${this.provider}-early`,
      });
    }
  }
  createResponse(overrides: Record<string, unknown> = {}) {
    this.responseToolChoices.push(overrides.tool_choice);
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
    if (this.rejectCommitAcknowledgement) throw new Error("commit acknowledgement timed out");
    const observation = this.#observe("inbound", "input_audio_buffer.committed");
    this.#emit({
      type: "input.audio_committed", provider: this.provider, receivedAtMs: 4,
      wireType: "input_audio_buffer.committed", connectionEpoch: 1, commitOrdinal: 1,
      wireObservation: {
        availability: "observed", connectionEpoch: 1, sequence: observation.sequence,
        observationSha256: observation.observationSha256, payloadSha256: observation.payloadSha256,
        projectionSha256: observation.projectionSha256,
      },
    });
    return Object.freeze({
      provider: this.provider === "xai" ? "xai" as const : "openai" as const,
      connectionEpoch: 1,
      commitOrdinal: 1,
      status: "acknowledged" as const,
    });
  }
}

function withInitialToolChoice(
  client: NormalizedRealtimeClient,
  toolChoice: "required" | Readonly<{ type: "function"; name: "capability_gateway" }>,
): NormalizedRealtimeClient {
  let initialCreateSeen = false;
  return new Proxy(client, {
    get(target, property) {
      if (property === "createResponse") {
        return (overrides: Record<string, unknown> = {}) => {
          if (!initialCreateSeen) {
            initialCreateSeen = true;
            target.createResponse({ ...overrides, tool_choice: toolChoice });
            return;
          }
          target.createResponse(overrides);
        };
      }
      const value = Reflect.get(target as object, property, target as object);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
      if (provider === "openai") {
        expect(execution.operation_order.indexOf("caller_audio_commit_acknowledged"))
          .toBeLessThan(execution.operation_order.indexOf("response_generation_requested"));
      } else if (provider === "xai") {
        expect(execution.operation_order.indexOf("server_vad_control_acknowledged"))
          .toBeLessThan(execution.operation_order.indexOf("server_vad_speech_started"));
        expect(execution.wire_observations.filter((item) => (
          item.direction === "outbound" && item.wireType === "response.create"
        ))).toHaveLength(1);
      }
    });
  }

  it("labels xAI close-time wire-PCM metering from its normalized source across many chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "xai" });
    const inputAudioMinutes = audio.data.byteLength / 2 / audio.sampleRateHz / 60;
    const outputAudioMinutes = 2 / 2 / 24_000 / 60;
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "xai",
      model: "xai-model",
      client: new RoundtripClient("xai", {
        continuationUsage: {
          inputAudioMinutes,
          outputAudioMinutes,
          billableTextInputEvents: 0,
          meteringSource: "client_measured",
          raw: {},
        },
        providerUsageCounters: null,
      }),
      audio,
      audioObject: artifact.provider_renditions.xai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined },
      timeoutMs: 1_000,
    });

    expect(execution.sanitized_usage).toHaveLength(1);
    expect(execution.sanitized_usage[0]).toMatchObject({
      source: "client_measured_wire_pcm",
      provider_usage_observation_sha256: null,
      counters: { inputAudioMinutes, outputAudioMinutes },
    });
    expect(execution.sanitized_usage[0]!.counters).not.toHaveProperty("billableTextInputEvents");
    expect(execution.sanitized_usage[0]!.contributing_wire_observation_sha256s).toHaveLength(61);
  });

  it("projects mixed xAI metering down to only the exact provider-reported wire counters", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "xai" });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "xai",
      model: "xai-model",
      client: new RoundtripClient("xai", {
        continuationUsage: {
          totalTokens: 5,
          inputAudioMinutes: 0.02,
          outputAudioMinutes: 0.001,
          meteringSource: "mixed",
          raw: { total_tokens: 5 },
        },
        providerUsageCounters: { totalTokens: 5 },
      }),
      audio,
      audioObject: artifact.provider_renditions.xai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined },
      timeoutMs: 1_000,
    });

    expect(execution.sanitized_usage).toHaveLength(1);
    expect(execution.sanitized_usage[0]).toMatchObject({
      source: "provider_reported",
      counters: { totalTokens: 5 },
    });
    expect(execution.sanitized_usage[0]!.counters).not.toHaveProperty("inputAudioMinutes");
    expect(execution.sanitized_usage[0]!.provider_usage_observation_sha256)
      .toBe(execution.sanitized_usage[0]!.contributing_wire_observation_sha256s[0]);
  });

  it.each([
    {
      id: "missing metering provenance",
      usage: { totalTokens: 5, raw: { total: 5 } } satisfies NormalizedRealtimeUsage,
      providerUsageCounters: { totalTokens: 5 },
    },
    {
      id: "wire-PCM counter mismatch",
      usage: {
        inputAudioMinutes: 0.5,
        outputAudioMinutes: 2 / 2 / 24_000 / 60,
        meteringSource: "client_measured" as const,
        raw: {},
      } satisfies NormalizedRealtimeUsage,
      providerUsageCounters: null,
    },
  ])("refuses to relabel $id as provider-reported usage", async ({ usage, providerUsageCounters }) => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "xai" });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "xai",
      model: "xai-model",
      client: new RoundtripClient("xai", { continuationUsage: usage, providerUsageCounters }),
      audio,
      audioObject: artifact.provider_renditions.xai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined },
      timeoutMs: 1_000,
    });

    expect(execution.sanitized_usage).toEqual([]);
    expect(execution.public_execution_sha256).toBeNull();
  });

  it("fails closed when an expected xAI PCM contributor has malformed wire evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "xai" });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "xai",
      model: "xai-model",
      client: new RoundtripClient("xai", {
        continuationUsage: {
          inputAudioMinutes: audio.data.byteLength / 2 / audio.sampleRateHz / 60,
          outputAudioMinutes: 2 / 2 / 24_000 / 60,
          meteringSource: "client_measured",
          raw: {},
        },
        providerUsageCounters: null,
        malformedInputAudioProjection: true,
      }),
      audio,
      audioObject: artifact.provider_renditions.xai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined },
      timeoutMs: 1_000,
    });

    expect(execution.sanitized_usage).toEqual([]);
    expect(execution.public_execution_sha256).toBeNull();
  });

  it("does not bind an initial-response usage frame to the final continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "xai" });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "xai",
      model: "xai-model",
      client: new RoundtripClient("xai", { continuationUsageResponseId: "initial" }),
      audio,
      audioObject: artifact.provider_renditions.xai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined },
      timeoutMs: 1_000,
    });

    expect(execution.status).toBe("failed");
    expect(execution.failure_class).toBe("post_tool_usage_missing");
    expect(execution.sanitized_usage).toEqual([]);
  });

  for (const variant of [
    { id: "required", toolChoice: "required" as const },
    {
      id: "forced_function",
      toolChoice: { type: "function" as const, name: "capability_gateway" as const },
    },
  ] as const) {
    it(`admits the production local dispatch before same-frame completion for ${variant.id}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
      roots.push(root);
      const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
      const audio = await loadLc4S2sPcm({ root, artifact, provider: "openai" });
      const rawClient = new RoundtripClient("openai", { localGatewayDispatchMode: "exact" });
      const execution = await executeLc4S2sToolRoundtrip({
        provider: "openai",
        model: "openai-model",
        client: withInitialToolChoice(rawClient, variant.toolChoice),
        audio,
        audioObject: artifact.provider_renditions.openai,
        profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
        runtime: { monotonicNowMs: () => 0, sleep: async () => undefined },
        timeoutMs: 1_000,
      });

      expect(rawClient.responseToolChoices[0]).toEqual(variant.toolChoice);
      expect(execution, canonicalJson({
        failure: execution.failure_class,
        operations: execution.operation_order,
      })).toMatchObject({
        status: "passed",
        failure_class: "none",
        tool_call_observed: true,
        tool_result_submitted: true,
        post_tool_continuation_requested: true,
        post_tool_terminal_observed: true,
      });
      expect(execution.operation_order.indexOf("exact_tool_call_observed"))
        .toBeLessThan(execution.operation_order.indexOf("matching_tool_result_submitted"));
    });
  }

  it("waits one normalization turn when completion precedes its same-frame local dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "openai" });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "openai",
      model: "openai-model",
      client: new RoundtripClient("openai", { localGatewayDispatchMode: "completion_first" }),
      audio,
      audioObject: artifact.provider_renditions.openai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined },
      timeoutMs: 1_000,
    });
    expect(execution).toMatchObject({
      status: "passed",
      failure_class: "none",
      tool_call_observed: true,
      tool_result_submitted: true,
    });
  });

  for (const diagnostic of [
    { mode: "competing", failure: "competing_tool_call" },
    { mode: "malformed", failure: "provider_error" },
    { mode: "call_free", failure: "wrong_tool" },
  ] as const) {
    it(`fails closed for a ${diagnostic.mode} same-frame gateway terminal`, async () => {
      const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
      roots.push(root);
      const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
      const audio = await loadLc4S2sPcm({ root, artifact, provider: "openai" });
      const execution = await executeLc4S2sToolRoundtrip({
        provider: "openai",
        model: "openai-model",
        client: new RoundtripClient("openai", { localGatewayDispatchMode: diagnostic.mode }),
        audio,
        audioObject: artifact.provider_renditions.openai,
        profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
        runtime: { monotonicNowMs: () => 0, sleep: async () => undefined },
        timeoutMs: 1_000,
      });
      expect(execution).toMatchObject({
        status: "failed",
        failure_class: diagnostic.failure,
        tool_result_submitted: false,
      });
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

  it("hash-binds a content-free provider diagnostic into failed S2S evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "openai" });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "openai",
      model: "openai-model",
      client: new RoundtripClient("openai", { emitProviderFailure: true }),
      audio,
      audioObject: artifact.provider_renditions.openai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined },
      timeoutMs: 1_000,
    });
    expect(execution).toMatchObject({
      status: "failed",
      failure_class: "provider_error",
      transport_failure_diagnostic: {
        origin: "provider_wire",
        category: "provider_service",
        safeRawCode: "response_generation_failed",
        responseGenerationRequested: true,
        responseGenerationStarted: false,
        responseTerminalObserved: false,
      },
    });
    expect(JSON.stringify(execution.transport_failure_diagnostic)).not.toContain("plaintext");
    expect(execution.failure_evidence_sha256).toMatch(/^[a-f0-9]{64}$/);
    assertLc4S2sRoundtripExecution(execution);
  });

  it("fails closed without the xAI per-turn server-VAD acknowledgement barrier", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "xai" });
    const client = new RoundtripClient("xai");
    Object.defineProperty(client, "prepareServerVadTurn", { value: undefined });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "xai", model: "xai-model", client, audio,
      audioObject: artifact.provider_renditions.xai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined }, timeoutMs: 1_000,
    });
    expect(execution.failure_class).toBe("server_vad_control_ack_missing");
  });

  it("classifies a timed-out xAI per-turn session acknowledgement exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "xai" });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "xai", model: "xai-model",
      client: new RoundtripClient("xai", { rejectServerVadControlAcknowledgement: true }), audio,
      audioObject: artifact.provider_renditions.xai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined }, timeoutMs: 1_000,
    });
    expect(execution.failure_class).toBe("server_vad_control_ack_missing");
    expect(execution.response_generation_requested).toBe(false);
  });

  it("fails closed when xAI omits the server-VAD speech-start observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "xai" });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "xai", model: "xai-model",
      client: new RoundtripClient("xai", { omitServerVadSpeechStart: true }), audio,
      audioObject: artifact.provider_renditions.xai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined }, timeoutMs: 1_000,
    });
    expect(execution.failure_class).toBe("server_vad_speech_start_missing");
  });

  it("rejects an xAI response that begins before the explicit trigger", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "xai" });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "xai", model: "xai-model",
      client: new RoundtripClient("xai", { emitEarlyResponseOnCommit: true }), audio,
      audioObject: artifact.provider_renditions.xai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined }, timeoutMs: 1_000,
    });
    expect(execution.failure_class).toBe("server_vad_response_before_speech_stop");
  });

  it("rejects a hash-consistent passing xAI summary with fabricated empty wire evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-s2s-fixture-"));
    roots.push(root);
    const artifact = await materializeLc4S2sAudioFixture({ root, renderer });
    const audio = await loadLc4S2sPcm({ root, artifact, provider: "xai" });
    const execution = await executeLc4S2sToolRoundtrip({
      provider: "xai", model: "xai-model", client: new RoundtripClient("xai"), audio,
      audioObject: artifact.provider_renditions.xai,
      profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
      runtime: { monotonicNowMs: () => 0, sleep: async () => undefined }, timeoutMs: 1_000,
    });
    const { evidence_sha256: originalEvidenceSha256, ...body } = execution;
    expect(originalEvidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    const fabricatedBody = Object.freeze({ ...body, wire_observations: Object.freeze([]) });
    const fabricated = Object.freeze({
      ...fabricatedBody,
      evidence_sha256: sha256Hex(`harshas-amazing-call-center/lc4-s2s-roundtrip-evidence/v6\n${canonicalJson(fabricatedBody)}`),
    });
    expect(() => assertLc4S2sRoundtripExecution(fabricated)).toThrow("lacks closed-loop evidence");
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

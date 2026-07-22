import type { XaiBrowserConnection } from "@/lib/realtime/types";
import {
  BrowserCapabilityGateway,
  CAPABILITY_GATEWAY_FUNCTION_NAME,
} from "./capability-gateway";
import { OpenAICompatibleBrowserToolLoop } from "./openai-compatible-tools";
import {
  BROWSER_OUTBOUND_SPEECH_GATE_SUPPORT,
  boundedSpeechResponseId,
  finalizeQuarantinedSpeech,
  pushQuarantinedPcm16Base64,
} from "./outbound-speech";
import {
  BROWSER_REALTIME_LIMITS,
  boundedProviderBase64,
  boundedProviderEventType,
  boundedProviderText,
  interruptPlayback,
  isPlainRecord,
  parseBoundedProviderEvent,
  pcm16Base64,
  playPcm16,
  resampleMono,
  sendBoundedWebSocketJson,
  utf8Bytes,
  type BrowserRealtimeTransport,
  type RealtimeTransportStart,
} from "./types";

export type XaiBrowserSessionReadinessEvidence = Readonly<{
  acknowledgement: "session.updated";
  strictParityVerified: false;
  verifiedFields: readonly ["voice", "input_audio", "output_audio", "turn_detection", "resumption_disabled"];
  unverifiableFields: readonly ["model", "instructions", "tools"];
}>;

function safeError(error: unknown): Error {
  return error instanceof Error ? new Error(error.message.slice(0, 2_000)) : new Error("xAI realtime protocol error");
}

function record(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}

function xaiSpeechResponseId(event: Record<string, unknown>, fallback?: string): string {
  const response = record(event.response);
  return boundedSpeechResponseId(event.response_id ?? response.id ?? fallback, "xAI speech response id");
}

function xaiTerminalStatus(event: Record<string, unknown>): "completed" | "cancelled" | "failed" | "incomplete" {
  const status = record(event.response).status ?? event.status;
  if (status === "completed" || status === "cancelled" || status === "failed" || status === "incomplete") {
    return status;
  }
  throw new Error("xAI speech response had an unknown terminal status");
}

function validatedConnection(value: RealtimeTransportStart["connection"]): XaiBrowserConnection {
  if (value.provider !== "xai" || value.transport !== "websocket"
    || typeof value.wsUrl !== "string" || !/^wss:\/\//.test(value.wsUrl)
    || !Array.isArray(value.protocols) || value.protocols.length !== 1
    || typeof value.protocols[0] !== "string" || !value.protocols[0]
    || typeof value.toolProxyUrl !== "string" || typeof value.toolProxyToken !== "string") {
    throw new Error("xAI browser connection is invalid");
  }
  return value;
}

function requireLocalGatewaySurface(update: Readonly<Record<string, unknown>>): void {
  const session = record(update.session);
  const tools = Array.isArray(session.tools) ? session.tools : [];
  const tool = tools.length === 1 ? record(tools[0]) : {};
  if (tools.length !== 1 || tool.type !== "function" || tool.name !== CAPABILITY_GATEWAY_FUNCTION_NAME) {
    throw new Error("xAI browser sessions must expose exactly the local capability_gateway function");
  }
}

/** Browser transport has no reconnect implementation, so resumption is always disabled. */
export function buildXaiBrowserSessionUpdate(raw: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  let encoded: string;
  try { encoded = JSON.stringify(raw); } catch { throw new Error("xAI session update is not JSON serializable"); }
  if (utf8Bytes(encoded) > BROWSER_REALTIME_LIMITS.outboundFrameBytes) {
    throw new Error("xAI session update exceeded the browser safety limit");
  }
  const cloned = JSON.parse(encoded) as unknown;
  if (!isPlainRecord(cloned) || cloned.type !== "session.update" || !isPlainRecord(cloned.session)) {
    throw new Error("xAI session update is invalid");
  }
  const session = cloned.session;
  session.resumption = { ...record(session.resumption), enabled: false };
  return Object.freeze(cloned);
}

function requireFormat(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string,
  mismatches: string[],
) {
  if (actual.type !== expected.type) mismatches.push(`${label}.type`);
  if (actual.rate !== expected.rate) mismatches.push(`${label}.rate`);
}

export function verifyXaiBrowserSessionAcknowledgement(
  event: Readonly<Record<string, unknown>>,
  sentUpdate: Readonly<Record<string, unknown>>,
): XaiBrowserSessionReadinessEvidence {
  if (event.type !== "session.updated") throw new Error("xAI readiness event was not session.updated");
  const acknowledged = record(event.session);
  const requested = record(sentUpdate.session);
  const acknowledgedAudio = record(acknowledged.audio);
  const requestedAudio = record(requested.audio);
  const acknowledgedInput = record(acknowledgedAudio.input);
  const requestedInput = record(requestedAudio.input);
  const acknowledgedOutput = record(acknowledgedAudio.output);
  const requestedOutput = record(requestedAudio.output);
  const mismatches: string[] = [];
  if (acknowledged.voice !== requested.voice) mismatches.push("voice");
  requireFormat(record(acknowledgedInput.format), record(requestedInput.format), "audio.input.format", mismatches);
  requireFormat(record(acknowledgedOutput.format), record(requestedOutput.format), "audio.output.format", mismatches);
  if (record(acknowledged.turn_detection).type !== record(requested.turn_detection).type) {
    mismatches.push("turn_detection.type");
  }
  if (record(acknowledged.resumption).enabled !== false) mismatches.push("resumption.enabled");
  if (mismatches.length > 0) {
    throw new Error(`xAI session acknowledgement mismatch: ${mismatches.join(", ")}`);
  }
  return Object.freeze({
    acknowledgement: "session.updated" as const,
    strictParityVerified: false as const,
    verifiedFields: Object.freeze([
      "voice", "input_audio", "output_audio", "turn_detection", "resumption_disabled",
    ] as const),
    unverifiableFields: Object.freeze(["model", "instructions", "tools"] as const),
  });
}

export class XaiWebSocketTransport implements BrowserRealtimeTransport {
  private socket: WebSocket | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private mute: GainNode | null = null;
  private audioContext: AudioContext | null = null;
  private playback = { playhead: 0, scheduled: [] as AudioBufferSourceNode[] };
  private readiness: XaiBrowserSessionReadinessEvidence | null = null;
  private gateway: BrowserCapabilityGateway | null = null;
  private toolLoop: OpenAICompatibleBrowserToolLoop | null = null;
  private cancelPendingStart: ((error: Error) => void) | null = null;
  private starting = false;
  private stopped = false;
  private activeSpeechResponseId: string | null = null;
  private speechFinalizationTail: Promise<void> = Promise.resolve();
  private gatedSpeechTranscripts = new Map<string, string>();

  readonly outboundSpeechGateSupport = BROWSER_OUTBOUND_SPEECH_GATE_SUPPORT.xai;

  get sessionReadinessEvidence(): XaiBrowserSessionReadinessEvidence | null {
    return this.readiness ? Object.freeze({ ...this.readiness }) : null;
  }

  async start(args: RealtimeTransportStart) {
    if (this.starting || this.socket || this.processor || this.gateway) {
      throw new Error("xAI browser transport is already started");
    }
    const connection = validatedConnection(args.connection);
    const sessionUpdate = buildXaiBrowserSessionUpdate(connection.sessionUpdate);
    requireLocalGatewaySurface(sessionUpdate);
    const gateway = new BrowserCapabilityGateway({
      provider: "xai",
      url: connection.toolProxyUrl,
      token: connection.toolProxyToken,
      rotation: connection.toolProxyRotation,
      activeCatalogDigest: connection.activeCatalogAuthority.catalogDigest,
      activeCatalogEpoch: connection.activeCatalogAuthority.capabilityEpoch,
      activeRuntimeDigest: connection.activeCatalogAuthority.runtimeDigest,
      activeStateRevision: connection.activeCatalogAuthority.stateRevision,
    });
    this.starting = true;
    this.stopped = false;
    this.gateway = gateway;
    try {
      await gateway.initialize();
      if (this.stopped || this.gateway !== gateway) throw new Error("xAI browser transport was stopped during startup");
    } catch (error) {
      gateway.close();
      if (this.gateway === gateway) this.gateway = null;
      this.starting = false;
      throw error;
    }
    const source = args.audioContext.createMediaStreamSource(args.mic);
    const processor = args.audioContext.createScriptProcessor(2048, 1, 1);
    const mute = args.audioContext.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute).connect(args.audioContext.destination);
    this.source = source;
    this.processor = processor;
    this.mute = mute;
    this.audioContext = args.audioContext;
    this.readiness = null;

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(connection.wsUrl, connection.protocols);
        this.socket = socket;
      this.toolLoop = new OpenAICompatibleBrowserToolLoop({
        gateway,
        sendJson: (value, label) => sendBoundedWebSocketJson(socket, value, label),
        onError: args.handlers.onError,
          closeProtocol: (code, reason) => {
            try { socket.close(code, reason); } catch { /* socket is already closed */ }
          },
        });
        let ready = false;
        let settled = false;
        const timeout = window.setTimeout(() => {
          failBeforeReady(new Error("xAI realtime session acknowledgement timed out"));
        }, 15_000);

        const rejectOnce = (error: Error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          processor.onaudioprocess = null;
          reject(error);
        };
        this.cancelPendingStart = rejectOnce;
        const failBeforeReady = (error: Error) => {
          rejectOnce(error);
          if (!this.stopped) args.handlers.onError(error);
          try { socket.close(1002, "xAI session verification failed"); } catch { /* already closed */ }
        };

        socket.onopen = () => {
        try {
          sendBoundedWebSocketJson(socket, sessionUpdate, "xAI session update");
        } catch (error) {
          failBeforeReady(safeError(error));
        }
        };
        socket.onmessage = (message) => {
        if (this.stopped || this.socket !== socket) return;
        let event: Record<string, unknown>;
        let type: string;
        try {
          event = parseBoundedProviderEvent(message.data, "xAI realtime");
          type = boundedProviderEventType(event.type, "xAI realtime");
        } catch (error) {
          const normalized = safeError(error);
          if (!ready) failBeforeReady(normalized);
          else {
            args.handlers.onError(normalized);
            this.toolLoop?.close();
            gateway.close();
            try { socket.close(1002, "invalid xAI provider event"); } catch { /* already closed */ }
          }
          return;
        }

        if (!ready) {
          if (type === "session.created" || type === "rate_limits.updated") return;
          if (type === "error") {
            failBeforeReady(new Error("xAI rejected the realtime session update"));
            return;
          }
          if (type !== "session.updated") {
            failBeforeReady(new Error(`xAI emitted ${type} before session.updated verification`));
            return;
          }
          try {
            this.readiness = verifyXaiBrowserSessionAcknowledgement(event, sessionUpdate);
          } catch (error) {
            failBeforeReady(safeError(error));
            return;
          }
          ready = true;
          settled = true;
          window.clearTimeout(timeout);
          processor.onaudioprocess = (audio) => {
            if (socket.readyState !== WebSocket.OPEN) return;
            try {
              const pcm = resampleMono(audio.inputBuffer.getChannelData(0), args.audioContext.sampleRate, 24_000);
              sendBoundedWebSocketJson(socket, {
                type: "input_audio_buffer.append",
                audio: pcm16Base64(pcm),
              }, "xAI input audio frame");
            } catch (error) {
              processor.onaudioprocess = null;
              args.handlers.onError(safeError(error));
            }
          };
          resolve();
          return;
        }

        if (type === "session.updated") {
          try {
            verifyXaiBrowserSessionAcknowledgement(event, sessionUpdate);
          } catch (error) {
            const normalized = safeError(error);
            args.handlers.onError(normalized);
            try { socket.close(1002, "xAI session configuration drifted"); } catch { /* already closed */ }
          }
          return;
        }
        if (args.outboundSpeechGate) {
          try {
            if (type === "response.created") {
              const responseId = xaiSpeechResponseId(event);
              if (this.activeSpeechResponseId && this.activeSpeechResponseId !== responseId) {
                throw new Error("xAI started overlapping speech responses");
              }
              args.outboundSpeechGate.gate.beginResponse("xai", responseId);
              this.activeSpeechResponseId = responseId;
            } else if (type === "response.output_audio.delta" || type === "response.audio.delta") {
              const responseId = xaiSpeechResponseId(event, this.activeSpeechResponseId ?? undefined);
              const delta = boundedProviderBase64(event.delta, "xAI output audio delta");
              if (delta) pushQuarantinedPcm16Base64(args.outboundSpeechGate, "xai", responseId, delta);
            } else if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
              const responseId = xaiSpeechResponseId(event, this.activeSpeechResponseId ?? undefined);
              const transcript = boundedProviderText(event.transcript, "xAI output transcript");
              if (transcript !== undefined) {
                args.outboundSpeechGate.gate.pushProviderTranscript("xai", responseId, transcript, true);
                this.gatedSpeechTranscripts.set(responseId, transcript);
              }
            } else if (type === "response.done") {
              const responseId = xaiSpeechResponseId(event, this.activeSpeechResponseId ?? undefined);
              const terminalStatus = xaiTerminalStatus(event);
              this.activeSpeechResponseId = null;
              const pending = this.speechFinalizationTail.then(async () => {
                const evidence = await finalizeQuarantinedSpeech({
                  config: args.outboundSpeechGate!,
                  provider: "xai",
                  responseId,
                  terminalStatus,
                  audioContext: args.audioContext,
                  recordingDestination: args.recordingDestination,
                  playback: this.playback,
                  isTransportActive: () => !this.stopped && this.socket === socket,
                });
                const transcript = this.gatedSpeechTranscripts.get(responseId);
                this.gatedSpeechTranscripts.delete(responseId);
                if (evidence.decision.action === "release" && transcript !== undefined) {
                  args.handlers.onTranscript("agent", transcript);
                }
              });
              this.speechFinalizationTail = pending.catch(() => undefined);
              void pending.catch((error) => {
                if (this.stopped || this.socket !== socket) return;
                args.handlers.onError(safeError(error));
                try { socket.close(1002, "xAI outbound speech gate failed"); } catch { /* already closed */ }
              });
            }
          } catch (error) {
            args.handlers.onError(safeError(error));
            try { socket.close(1002, "xAI outbound speech gate rejected provider output"); } catch { /* already closed */ }
            return;
          }
        }
        if (type === "response.output_audio.delta" || type === "response.audio.delta") {
          if (event.delta === undefined) return;
          try {
            const delta = boundedProviderBase64(event.delta, "xAI output audio delta");
            if (delta && !args.outboundSpeechGate) {
              playPcm16(delta, args.audioContext, args.recordingDestination, this.playback);
            }
          } catch (error) { args.handlers.onError(safeError(error)); }
        } else if (type === "input_audio_buffer.speech_started") {
          interruptPlayback(args.audioContext, this.playback);
        } else if (type === "conversation.item.input_audio_transcription.completed") {
          try {
            const transcript = boundedProviderText(event.transcript, "xAI input transcript");
            if (transcript !== undefined) args.handlers.onTranscript("caller", transcript);
          } catch (error) { args.handlers.onError(safeError(error)); }
        } else if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
          try {
            const transcript = boundedProviderText(event.transcript, "xAI output transcript");
            if (transcript !== undefined && !args.outboundSpeechGate) {
              args.handlers.onTranscript("agent", transcript);
            }
          } catch (error) { args.handlers.onError(safeError(error)); }
        } else if (type === "error") {
          // Never surface provider-controlled text: upstream failures may contain caller PII
          // or secrets copied from request headers and session configuration.
          args.handlers.onError(new Error("xAI realtime provider error"));
        }
        this.toolLoop?.observe(event);
        };
        socket.onerror = () => {
        if (this.stopped || this.socket !== socket) return;
        const error = new Error("xAI realtime WebSocket failed");
        if (!ready) rejectOnce(error);
        args.handlers.onError(error);
        };
        socket.onclose = () => {
        if (!ready) rejectOnce(new Error("xAI realtime closed before session.updated verification"));
        if (ready && !this.stopped && this.socket === socket) args.handlers.onClose();
        };
      });
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      this.cancelPendingStart = null;
      this.starting = false;
    }
  }

  async stop() {
    this.stopped = true;
    this.cancelPendingStart?.(new Error("xAI browser transport was stopped during startup"));
    this.cancelPendingStart = null;
    this.toolLoop?.close();
    this.toolLoop = null;
    this.gateway?.close();
    this.gateway = null;
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.mute?.disconnect();
    if (this.audioContext) interruptPlayback(this.audioContext, this.playback);
    this.processor = null;
    this.source = null;
    this.mute = null;
    this.audioContext = null;
    this.activeSpeechResponseId = null;
    this.gatedSpeechTranscripts.clear();
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
        this.socket.close();
      }
    }
    this.socket = null;
    this.readiness = null;
  }

  async drainToolCalls(timeoutMs: number) {
    return this.gateway?.drainAndClose(timeoutMs) ?? {
      settledNativeCallIds: [],
      unresolvedNativeCallIds: [],
    };
  }
}

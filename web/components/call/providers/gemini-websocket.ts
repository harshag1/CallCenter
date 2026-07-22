import type { GeminiBrowserConnection } from "@/lib/realtime/types";
import {
  assertGeminiProviderTranscriptionDisabled,
  geminiServerMessageTypes,
  GEMINI_PROVIDER_TRANSCRIPTION_POLICY,
} from "@/lib/realtime/gemini-policy";
import {
  BrowserCapabilityGateway,
  CAPABILITY_GATEWAY_FUNCTION_NAME,
  type BrowserCapabilityGatewayResult,
} from "./capability-gateway";
import {
  BROWSER_OUTBOUND_SPEECH_GATE_SUPPORT,
  finalizeQuarantinedSpeech,
  pushQuarantinedPcm16Base64,
} from "./outbound-speech";
import {
  boundedProviderText,
  interruptPlayback,
  parseBoundedProviderEvent,
  pcm16Base64,
  playPcm16,
  resampleMono,
  sendBoundedWebSocketJson,
  utf8Bytes,
  type BrowserRealtimeTransport,
  type RealtimeTransportStart,
} from "./types";

export type GeminiFunctionCall = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
};

export type GeminiFunctionResponse = {
  id: string;
  name: string;
  response: Record<string, unknown>;
};

export type GeminiBrowserSetupReadinessEvidence = Readonly<{
  acknowledgement: "setupComplete";
  fieldEchoAvailable: false;
  strictParityVerified: false;
  clientSentModel: string;
  clientSentVoice: string;
  clientSentToolNames: readonly string[];
  providerTranscriptionPolicy: typeof GEMINI_PROVIDER_TRANSCRIPTION_POLICY;
}>;

// The MCP boundary hashes provider IDs into its internal receipt identity and
// accepts at most 256 UTF-8 bytes without ASCII control characters.
const MAX_GEMINI_TOOL_CALL_ID_BYTES = 256;
const MAX_TOOL_RESPONSE_BATCH_BYTES = 1024 * 1024;
const MAX_TOOL_CALLS_PER_BATCH = 64;
const MAX_QUEUED_TOOL_BATCHES = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown Gemini browser transport error").slice(0, 2_000);
}

function assertStrictJson(value: unknown, path: string, ancestors = new WeakSet<object>(), depth = 0): void {
  if (depth > 64) throw new Error(`${path} exceeds the maximum JSON depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} contains a non-JSON value`);
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} contains a non-JSON object`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertStrictJson(entry, `${path}[${index}]`, ancestors, depth + 1));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error(`${path} contains an unsafe object key`);
      }
      assertStrictJson(entry, `${path}.${key}`, ancestors, depth + 1);
    }
  }
  ancestors.delete(value);
}

function deepFreeze<T extends object>(root: T): Readonly<T> {
  const pending: object[] = [root];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(value);
  }
  return root;
}

function boundedGeminiToolCallId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0 || utf8Bytes(id) > MAX_GEMINI_TOOL_CALL_ID_BYTES
    || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error(`Gemini tool call id must be 1-${MAX_GEMINI_TOOL_CALL_ID_BYTES} UTF-8 bytes without controls`);
  }
  return id;
}

function successResponse(payload: unknown): Record<string, unknown> {
  return isRecord(payload) ? structuredClone(payload) : { output: payload ?? null };
}

function failureResponse(error: unknown): Record<string, unknown> {
  if (isRecord(error)) return { error: structuredClone(error) };
  return { error: { message: String(error ?? "tool gateway error").slice(0, 2_000) } };
}

const CAPABILITY_GATEWAY_DECLARATION = deepFreeze({
  name: CAPABILITY_GATEWAY_FUNCTION_NAME,
  description: [
    "Call exactly one tool from the latest server-disclosed capability catalog through the local gateway.",
    "Copy the disclosed tool name exactly and place only that tool's arguments in arguments.",
    "Never add provider call IDs, response IDs, event IDs, provenance, or transport metadata; the host binds those.",
  ].join(" "),
  behavior: "BLOCKING",
  parametersJsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      tool_name: {
        type: "string",
        pattern: "^[a-z][a-z0-9_.-]{1,63}$",
      },
      arguments: {
        type: "object",
        additionalProperties: true,
      },
    },
    required: ["tool_name", "arguments"],
  },
});

export function buildGeminiBrowserFunctionDeclarations(): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze([CAPABILITY_GATEWAY_DECLARATION]);
}

export function buildGeminiBrowserSetup(
  rawFrame: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!isRecord(rawFrame) || Object.keys(rawFrame).length !== 1 || !isRecord(rawFrame.setup)) {
    throw new Error("Gemini browser setup must contain exactly one setup message");
  }
  assertGeminiProviderTranscriptionDisabled(rawFrame.setup, "played-PCM transcript evidence");
  assertStrictJson(rawFrame, "Gemini browser setup");
  const frame = structuredClone(rawFrame);
  const setup = frame.setup as Record<string, unknown>;
  // Browser reconnect/resume is not implemented, so do not opt into provider
  // state that this transport cannot safely continue.
  delete setup.sessionResumption;
  setup.tools = [{ functionDeclarations: buildGeminiBrowserFunctionDeclarations() }];
  return deepFreeze(frame);
}

/** Gemini's setupComplete message has no fields and echoes no configuration. */
export function isGeminiSetupCompleteMessage(value: unknown): boolean {
  if (!isRecord(value) || !own(value, "setupComplete") || !isRecord(value.setupComplete)) return false;
  const keys = Object.keys(value);
  return Object.keys(value.setupComplete).length === 0
    && keys.every((key) => key === "setupComplete" || key === "usageMetadata")
    && (!own(value, "usageMetadata") || isRecord(value.usageMetadata));
}

function parseFunctionCalls(value: unknown): GeminiFunctionCall[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Gemini toolCall.functionCalls must be non-empty");
  if (value.length > MAX_TOOL_CALLS_PER_BATCH) {
    throw new Error(`Gemini toolCall.functionCalls exceeded ${MAX_TOOL_CALLS_PER_BATCH} calls`);
  }
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Gemini function call must be an object");
    const id = boundedGeminiToolCallId(candidate.id);
    const name = typeof candidate.name === "string" ? candidate.name : "";
    if (name !== CAPABILITY_GATEWAY_FUNCTION_NAME) {
      throw new Error(`Gemini attempted undeclared function ${JSON.stringify(name)}`);
    }
    if (candidate.args !== undefined && !isRecord(candidate.args)) {
      return { id, name, args: candidate.args as never };
    }
    return { id, name, ...(candidate.args ? { args: candidate.args } : {}) };
  });
}

function validatedConnection(value: RealtimeTransportStart["connection"]): GeminiBrowserConnection {
  if (value.provider !== "gemini" || value.transport !== "websocket"
    || typeof value.wsUrl !== "string" || !value.wsUrl.startsWith("wss://")
    || typeof value.token !== "string" || !value.token
    || typeof value.toolProxyUrl !== "string" || typeof value.toolProxyToken !== "string"
    || !isRecord(value.setup)) {
    throw new Error("Gemini browser connection is invalid");
  }
  return value;
}

export class GeminiWebSocketTransport implements BrowserRealtimeTransport {
  private socket: WebSocket | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private mute: GainNode | null = null;
  private audioContext: AudioContext | null = null;
  private playback = { playhead: 0, scheduled: [] as AudioBufferSourceNode[] };
  private gateway: BrowserCapabilityGateway | null = null;
  private toolBatchTail: Promise<void> = Promise.resolve();
  private queuedToolBatches = 0;
  private cancelPendingStart: ((error: Error) => void) | null = null;
  private readiness: GeminiBrowserSetupReadinessEvidence | null = null;
  private starting = false;
  private stopped = false;
  private speechResponseSequence = 0;
  private activeSpeechResponseId: string | null = null;
  private speechFinalizationTail: Promise<void> = Promise.resolve();
  private gatedSpeechTranscripts = new Map<string, string>();

  readonly outboundSpeechGateSupport = BROWSER_OUTBOUND_SPEECH_GATE_SUPPORT.gemini;

  get setupReadinessEvidence(): GeminiBrowserSetupReadinessEvidence | null {
    if (!this.readiness) return null;
    return Object.freeze({
      ...this.readiness,
      clientSentToolNames: Object.freeze([...this.readiness.clientSentToolNames]),
    });
  }

  async start(args: RealtimeTransportStart) {
    if (this.starting || this.socket || this.processor || this.gateway) {
      throw new Error("Gemini browser transport is already started");
    }
    const connection = validatedConnection(args.connection);
    const gateway = new BrowserCapabilityGateway({
      provider: "gemini",
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
      if (this.stopped || this.gateway !== gateway) throw new Error("Gemini browser transport was stopped during startup");
    } catch (error) {
      gateway.close();
      if (this.gateway === gateway) this.gateway = null;
      this.starting = false;
      throw error;
    }
    const setup = buildGeminiBrowserSetup(connection.setup);
    const sentSetup = isRecord(setup.setup) ? setup.setup : {};
    const generation = isRecord(sentSetup.generationConfig) ? sentSetup.generationConfig : {};
    const speech = isRecord(generation.speechConfig) ? generation.speechConfig : {};
    const voiceConfig = isRecord(speech.voiceConfig) ? speech.voiceConfig : {};
    const prebuiltVoice = isRecord(voiceConfig.prebuiltVoiceConfig) ? voiceConfig.prebuiltVoiceConfig : {};
    const sentModel = typeof sentSetup.model === "string" ? sentSetup.model : connection.model;
    const sentVoice = typeof prebuiltVoice.voiceName === "string" ? prebuiltVoice.voiceName : connection.voice;
    this.toolBatchTail = Promise.resolve();
    this.queuedToolBatches = 0;
    this.readiness = null;

    const source = args.audioContext.createMediaStreamSource(args.mic);
    // ScriptProcessor accepts only zero or power-of-two buffer sizes. 2048 is
    // broadly supported and keeps a 48 kHz capture callback near 43 ms.
    const processor = args.audioContext.createScriptProcessor(2048, 1, 1);
    const mute = args.audioContext.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute).connect(args.audioContext.destination);
    this.source = source;
    this.processor = processor;
    this.mute = mute;
    this.audioContext = args.audioContext;

    try {
      await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(connection.wsUrl);
      this.socket = socket;
      let ready = false;
      let settled = false;
      const timeout = window.setTimeout(() => {
        failBeforeReady(new Error("Gemini Live connection timed out"));
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
        try { socket.close(1002, "Gemini setup failed"); } catch { /* already closed */ }
      };

      socket.onopen = () => {
        try {
          sendBoundedWebSocketJson(socket, setup, "Gemini setup frame");
        } catch {
          failBeforeReady(new Error("Gemini setup could not be sent"));
        }
      };
      socket.onmessage = (message) => {
        if (this.stopped || this.socket !== socket) return;
        let event: Record<string, unknown>;
        try {
          event = parseBoundedProviderEvent(message.data, "Gemini Live");
        } catch (error) {
          const normalized = new Error(safeMessage(error));
          if (!ready) failBeforeReady(normalized);
          else {
            args.handlers.onError(normalized);
            try { socket.close(1002, "invalid Gemini provider event"); } catch { /* already closed */ }
          }
          return;
        }

        if (!ready) {
          if (!isGeminiSetupCompleteMessage(event)) {
            failBeforeReady(new Error("Gemini Live returned an invalid or non-exclusive setup acknowledgement"));
            return;
          }
          ready = true;
          settled = true;
          window.clearTimeout(timeout);
          this.readiness = Object.freeze({
            acknowledgement: "setupComplete",
            fieldEchoAvailable: false,
            strictParityVerified: false,
            clientSentModel: sentModel,
            clientSentVoice: sentVoice,
            clientSentToolNames: Object.freeze([CAPABILITY_GATEWAY_FUNCTION_NAME]),
            providerTranscriptionPolicy: GEMINI_PROVIDER_TRANSCRIPTION_POLICY,
          });
          processor.onaudioprocess = (audio) => {
            if (socket.readyState !== WebSocket.OPEN) return;
            try {
              const pcm = resampleMono(audio.inputBuffer.getChannelData(0), args.audioContext.sampleRate, 16_000);
              sendBoundedWebSocketJson(socket, {
                realtimeInput: {
                  audio: { data: pcm16Base64(pcm), mimeType: "audio/pcm;rate=16000" },
                },
              }, "Gemini input audio frame");
            } catch (error) {
              processor.onaudioprocess = null;
              args.handlers.onError(new Error(safeMessage(error)));
            }
          };
          resolve();
          return;
        }

        if (own(event, "setupComplete")) {
          args.handlers.onError(new Error("Gemini Live repeated setupComplete after readiness"));
          try { socket.close(1002, "Gemini setup protocol drifted"); } catch { /* already closed */ }
          return;
        }
        const messageTypes = geminiServerMessageTypes(event);
        if (messageTypes.length > 1) {
          args.handlers.onError(new Error(
            `Gemini Live mixed mutually exclusive server messages: ${messageTypes.join(", ")}`,
          ));
          try { socket.close(1002, "Gemini server message union drifted"); } catch { /* already closed */ }
          return;
        }
        if (own(event, "usageMetadata") && !isRecord(event.usageMetadata)) {
          args.handlers.onError(new Error("Gemini Live usageMetadata was not an object"));
          try { socket.close(1002, "invalid Gemini usage metadata"); } catch { /* already closed */ }
          return;
        }
        const server = isRecord(event.serverContent) ? event.serverContent : undefined;
        if (server?.interrupted === true) interruptPlayback(args.audioContext, this.playback);
        if (isRecord(server?.inputTranscription) && server.inputTranscription.text !== undefined) {
          try {
            const text = boundedProviderText(server.inputTranscription.text, "Gemini input transcript");
            if (text !== undefined) args.handlers.onTranscript("caller", text);
          } catch (error) { args.handlers.onError(new Error(safeMessage(error))); }
        }
        if (isRecord(server?.outputTranscription) && server.outputTranscription.text !== undefined) {
          try {
            const text = boundedProviderText(server.outputTranscription.text, "Gemini output transcript");
            if (text !== undefined) {
              if (args.outboundSpeechGate) {
                this.activeSpeechResponseId ??= `gemini-browser-response-${++this.speechResponseSequence}`;
                this.gatedSpeechTranscripts.set(this.activeSpeechResponseId, text);
                args.outboundSpeechGate.gate.pushProviderTranscript(
                  "gemini",
                  this.activeSpeechResponseId,
                  text,
                  server?.turnComplete === true,
                );
              } else {
                args.handlers.onTranscript("agent", text);
              }
            }
          } catch (error) { args.handlers.onError(new Error(safeMessage(error))); }
        }
        const modelTurn = isRecord(server?.modelTurn) ? server.modelTurn : undefined;
        const parts = Array.isArray(modelTurn?.parts) ? modelTurn.parts : [];
        for (const part of parts) {
          if (!isRecord(part) || !isRecord(part.inlineData)) continue;
          const inline = part.inlineData;
          if (typeof inline.data !== "string" || !/^audio\/pcm;\s*rate=24000$/i.test(String(inline.mimeType ?? ""))) {
            args.handlers.onError(new Error("Gemini Live returned output that was not PCM16 at 24 kHz"));
            continue;
          }
          try {
            if (args.outboundSpeechGate) {
              this.activeSpeechResponseId ??= `gemini-browser-response-${++this.speechResponseSequence}`;
              pushQuarantinedPcm16Base64(
                args.outboundSpeechGate,
                "gemini",
                this.activeSpeechResponseId,
                inline.data,
              );
            } else {
              playPcm16(inline.data, args.audioContext, args.recordingDestination, this.playback);
            }
          } catch (error) {
            args.handlers.onError(new Error(safeMessage(error)));
          }
        }
        if (args.outboundSpeechGate && this.activeSpeechResponseId
          && (server?.turnComplete === true || server?.interrupted === true)) {
          const responseId = this.activeSpeechResponseId;
          this.activeSpeechResponseId = null;
          const pending = this.speechFinalizationTail.then(async () => {
            const evidence = await finalizeQuarantinedSpeech({
              config: args.outboundSpeechGate!,
              provider: "gemini",
              responseId,
              terminalStatus: server?.interrupted === true ? "interrupted" : "completed",
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
            args.handlers.onError(new Error(safeMessage(error)));
            try { socket.close(1002, "Gemini outbound speech gate failed"); } catch { /* already closed */ }
          });
        }
        if (isRecord(event.toolCall) && own(event.toolCall, "functionCalls")) {
          let calls: GeminiFunctionCall[];
          try {
            calls = parseFunctionCalls(event.toolCall.functionCalls);
          } catch (error) {
            const normalized = new Error(safeMessage(error));
            args.handlers.onError(normalized);
            try { socket.close(1002, "invalid Gemini tool identity"); } catch { /* already closed */ }
            return;
          }
          this.enqueueToolBatch(calls, args, socket);
        }
        if (isRecord(event.error)) {
          // Provider error strings are not an audit-safe surface and can echo request secrets.
          args.handlers.onError(new Error("Gemini Live provider error"));
        }
      };
      socket.onerror = () => {
        if (this.stopped || this.socket !== socket) return;
        const error = new Error("Gemini Live WebSocket failed");
        if (!ready) rejectOnce(error);
        args.handlers.onError(error);
      };
      socket.onclose = () => {
        if (!ready) rejectOnce(new Error("Gemini Live closed before setup completed"));
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

  private enqueueToolBatch(
    calls: readonly GeminiFunctionCall[],
    args: RealtimeTransportStart,
    socket: WebSocket,
  ): void {
    if (this.queuedToolBatches >= MAX_QUEUED_TOOL_BATCHES) {
      args.handlers.onError(new Error(`Gemini exceeded ${MAX_QUEUED_TOOL_BATCHES} queued tool batches`));
      try { socket.close(1009, "tool batch queue exceeded"); } catch { /* already closed */ }
      return;
    }
    this.queuedToolBatches += 1;
    const pending = this.toolBatchTail.then(() => this.dispatchToolBatch(calls, args, socket));
    this.toolBatchTail = pending.catch(() => undefined);
    void pending.catch((error) => {
      if (this.stopped || this.socket !== socket) return;
      args.handlers.onError(new Error(safeMessage(error)));
      try { socket.close(1002, "Gemini capability gateway failed"); } catch { /* already closed */ }
    }).finally(() => { this.queuedToolBatches -= 1; });
  }

  private async dispatchToolBatch(
    calls: readonly GeminiFunctionCall[],
    args: RealtimeTransportStart,
    socket: WebSocket,
  ): Promise<void> {
    const gateway = this.gateway;
    if (!gateway) throw new Error("Gemini capability gateway is unavailable");
    const duplicate = calls.find((call, index) => calls.findIndex((candidate) => candidate.id === call.id) !== index);
    if (duplicate) throw new Error(`Gemini tool batch duplicated function call id ${duplicate.id}`);
    const batchIdentity = `gemini-toolCall:${calls[0]!.id}`;
    const results = await gateway.executeBatch(calls.map((call) => ({
      functionName: call.name,
      nativeCallId: call.id,
      nativeResponseId: batchIdentity,
      terminalWireType: "toolCall",
      arguments: call.args,
    })));
    if (results.length !== calls.length) throw new Error("Gemini capability gateway returned a partial batch");
    const responses = results.map((result: BrowserCapabilityGatewayResult, index): GeminiFunctionResponse => {
      const call = calls[index]!;
      if (result.nativeCallId !== call.id) throw new Error("Gemini capability gateway changed function call order");
      return {
        id: call.id,
        name: call.name,
        response: result.isError ? failureResponse(result.output) : successResponse(result.output),
      };
    });

    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    const frame = { toolResponse: { functionResponses: responses } };
    if (utf8Bytes(JSON.stringify(frame)) > MAX_TOOL_RESPONSE_BATCH_BYTES) {
      throw new Error("Gemini tool response batch exceeded the browser safety limit");
    }
    sendBoundedWebSocketJson(socket, frame, "Gemini tool response batch");
  }

  async stop() {
    this.stopped = true;
    this.cancelPendingStart?.(new Error("Gemini browser transport was stopped during startup"));
    this.cancelPendingStart = null;
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

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

type XaiBrowserSessionEchoField =
  | "model"
  | "voice"
  | "instructions"
  | "tools"
  | "tool_choice"
  | "input_audio_format"
  | "output_audio_format"
  | "input_audio_configuration_except_format"
  | "output_audio_configuration_except_format"
  | "turn_detection_type"
  | "turn_detection_parameters"
  | "resumption_disabled";

const XAI_BROWSER_SESSION_ECHO_FIELDS = Object.freeze([
  "model",
  "voice",
  "instructions",
  "tools",
  "tool_choice",
  "input_audio_format",
  "output_audio_format",
  "input_audio_configuration_except_format",
  "output_audio_configuration_except_format",
  "turn_detection_type",
  "turn_detection_parameters",
  "resumption_disabled",
] as const satisfies readonly XaiBrowserSessionEchoField[]);

export type XaiBrowserSessionReadinessEvidence = Readonly<{
  acknowledgement: "session.updated";
  strictParityVerified: false;
  verifiedFields: readonly XaiBrowserSessionEchoField[];
  unverifiableFields: readonly XaiBrowserSessionEchoField[];
  sessionIdentity: Readonly<{
    source: "session.created";
    updatedContinuity: "verified" | "unverifiable_session_updated_omitted_identity";
  }>;
  conversationIdentity: Readonly<{
    source: "conversation.created";
    status: "verified" | "not_observed_before_readiness";
  }>;
  modelIdentity: Readonly<
    | {
      source: "session.created" | "session.updated";
      status: "verified";
    }
    | {
      source: "provider_echo";
      status: "unverifiable_provider_omitted";
    }
  >;
}>;

const XAI_STARTUP_IDENTITY_PROOF = Symbol("xai-startup-identity-proof");
type XaiBrowserStartupIdentityProof = Readonly<{
  [XAI_STARTUP_IDENTITY_PROOF]: true;
  sessionCreatedModel: string | null;
  conversationCreatedId: string | null;
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

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function canonicalProviderJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("xAI session echo contained a non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalProviderJson).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalProviderJson(value[key])}`
    )).join(",")}}`;
  }
  throw new Error("xAI session echo contained a non-JSON value");
}

function boundedProviderIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value !== value.trim()
    || utf8Bytes(value) > 512
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    const identityKind = label.startsWith("conversation.") ? "conversation " : "session ";
    throw new Error(`xAI ${label} omitted a valid ${identityKind}identity`);
  }
  return value;
}

function createStartupIdentityProof(input: Readonly<{
  sessionCreatedModel: string | null;
  conversationCreatedId: string | null;
}>): XaiBrowserStartupIdentityProof {
  if (input.sessionCreatedModel !== null) {
    boundedProviderIdentity(input.sessionCreatedModel, "session.created.model");
  }
  if (input.conversationCreatedId !== null) {
    boundedProviderIdentity(input.conversationCreatedId, "conversation.created");
  }
  return Object.freeze({
    [XAI_STARTUP_IDENTITY_PROOF]: true as const,
    sessionCreatedModel: input.sessionCreatedModel,
    conversationCreatedId: input.conversationCreatedId,
  });
}

function verifiedStartupIdentityProof(
  value: XaiBrowserStartupIdentityProof | undefined,
): XaiBrowserStartupIdentityProof | null {
  if (!value || value[XAI_STARTUP_IDENTITY_PROOF] !== true) return null;
  if (value.sessionCreatedModel !== null) {
    boundedProviderIdentity(value.sessionCreatedModel, "session.created.model");
  }
  if (value.conversationCreatedId !== null) {
    boundedProviderIdentity(value.conversationCreatedId, "conversation.created");
  }
  return value;
}

function optionalAcknowledgedRecord(
  parent: Record<string, unknown>,
  key: string,
  label: string,
  mismatches: string[],
): Record<string, unknown> | undefined {
  if (!hasOwn(parent, key)) return undefined;
  const value = parent[key];
  if (!isPlainRecord(value)) {
    mismatches.push(label);
    return undefined;
  }
  return value;
}

function verifyOptionalExact(
  actualParent: Record<string, unknown>,
  expectedParent: Record<string, unknown>,
  key: string,
  label: string,
  field: XaiBrowserSessionEchoField,
  verified: Set<XaiBrowserSessionEchoField>,
  mismatches: string[],
): void {
  if (!hasOwn(actualParent, key) || !hasOwn(expectedParent, key)) return;
  if (canonicalProviderJson(actualParent[key]) !== canonicalProviderJson(expectedParent[key])) mismatches.push(label);
  else verified.add(field);
}

function verifyRequestedObjectSubset(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  path: string,
  excludedKeys: ReadonlySet<string>,
  mismatches: string[],
): boolean {
  let complete = true;
  for (const key of Object.keys(expected).filter((candidate) => !excludedKeys.has(candidate))) {
    if (!hasOwn(actual, key)) {
      complete = false;
      continue;
    }
    const expectedValue = expected[key];
    const actualValue = actual[key];
    if (isPlainRecord(expectedValue)) {
      if (!isPlainRecord(actualValue)) {
        mismatches.push(`${path}.${key}`);
      } else if (!verifyRequestedObjectSubset(actualValue, expectedValue, `${path}.${key}`, new Set(), mismatches)) {
        complete = false;
      }
    } else if (canonicalProviderJson(actualValue) !== canonicalProviderJson(expectedValue)) {
      mismatches.push(`${path}.${key}`);
    }
  }
  return complete;
}

function verifyOptionalFormat(
  actualParent: Record<string, unknown>,
  expectedParent: Record<string, unknown>,
  label: string,
  field: XaiBrowserSessionEchoField,
  verified: Set<XaiBrowserSessionEchoField>,
  mismatches: string[],
): void {
  if (!hasOwn(actualParent, "format")) return;
  if (!isPlainRecord(actualParent.format)) {
    mismatches.push(label);
    return;
  }
  const actual = actualParent.format;
  const expected = record(expectedParent.format);
  let complete = true;
  for (const key of ["type", "rate"] as const) {
    if (!hasOwn(actual, key)) {
      complete = false;
      continue;
    }
    if (actual[key] !== expected[key]) mismatches.push(`${label}.${key}`);
  }
  if (complete && !mismatches.some((entry) => entry === label || entry.startsWith(`${label}.`))) {
    verified.add(field);
  }
}

export function verifyXaiBrowserSessionAcknowledgement(
  event: Readonly<Record<string, unknown>>,
  sentUpdate: Readonly<Record<string, unknown>>,
  createdSessionId: string,
  options: Readonly<{
    expectedModel?: string;
    startupIdentityProof?: XaiBrowserStartupIdentityProof;
  }> = {},
): XaiBrowserSessionReadinessEvidence {
  if (event.type !== "session.updated") throw new Error("xAI readiness event was not session.updated");
  if (!isPlainRecord(event.session)) throw new Error("xAI session.updated omitted a session object");
  const acknowledged = event.session;
  const requested = record(sentUpdate.session);
  const mismatches: string[] = [];
  const acknowledgedAudio = optionalAcknowledgedRecord(acknowledged, "audio", "audio", mismatches);
  const requestedAudio = record(requested.audio);
  const acknowledgedInput = acknowledgedAudio === undefined
    ? undefined
    : optionalAcknowledgedRecord(acknowledgedAudio, "input", "audio.input", mismatches);
  const requestedInput = record(requestedAudio.input);
  const acknowledgedOutput = acknowledgedAudio === undefined
    ? undefined
    : optionalAcknowledgedRecord(acknowledgedAudio, "output", "audio.output", mismatches);
  const requestedOutput = record(requestedAudio.output);
  const acknowledgedDetection = optionalAcknowledgedRecord(
    acknowledged,
    "turn_detection",
    "turn_detection",
    mismatches,
  );
  const acknowledgedResumption = optionalAcknowledgedRecord(
    acknowledged,
    "resumption",
    "resumption",
    mismatches,
  );
  const verified = new Set<XaiBrowserSessionEchoField>();
  const startupProof = verifiedStartupIdentityProof(options.startupIdentityProof);
  const updatedSessionId = acknowledged.id;
  if (updatedSessionId !== undefined && (
    typeof updatedSessionId !== "string"
    || !updatedSessionId.trim()
    || utf8Bytes(updatedSessionId) > 512
    || updatedSessionId !== createdSessionId
  )) mismatches.push("session.id");
  if (updatedSessionId !== undefined && !mismatches.includes("session.id")) {
    boundedProviderIdentity(updatedSessionId, "session.updated");
  }
  if (startupProof?.sessionCreatedModel !== null
    && startupProof?.sessionCreatedModel !== undefined) {
    if (options.expectedModel === undefined
      || startupProof.sessionCreatedModel !== options.expectedModel) {
      mismatches.push("session.created.model");
    } else verified.add("model");
  }
  if (hasOwn(acknowledged, "model")) {
    if (options.expectedModel === undefined || acknowledged.model !== options.expectedModel) {
      mismatches.push("model");
    } else verified.add("model");
  }
  verifyOptionalExact(acknowledged, requested, "voice", "voice", "voice", verified, mismatches);
  verifyOptionalExact(acknowledged, requested, "instructions", "instructions", "instructions", verified, mismatches);
  verifyOptionalExact(acknowledged, requested, "tools", "tools", "tools", verified, mismatches);
  verifyOptionalExact(acknowledged, requested, "tool_choice", "tool_choice", "tool_choice", verified, mismatches);
  verifyOptionalFormat(
    acknowledgedInput ?? {}, requestedInput, "audio.input.format", "input_audio_format", verified, mismatches,
  );
  verifyOptionalFormat(
    acknowledgedOutput ?? {}, requestedOutput, "audio.output.format", "output_audio_format", verified, mismatches,
  );
  const inputConfigurationComplete = verifyRequestedObjectSubset(
    acknowledgedInput ?? {},
    requestedInput,
    "audio.input",
    new Set(["format"]),
    mismatches,
  );
  if (Object.keys(requestedInput).some((key) => key !== "format")
    && inputConfigurationComplete
    && !mismatches.some((entry) => entry.startsWith("audio.input.") && !entry.startsWith("audio.input.format"))) {
    verified.add("input_audio_configuration_except_format");
  }
  const outputConfigurationComplete = verifyRequestedObjectSubset(
    acknowledgedOutput ?? {},
    requestedOutput,
    "audio.output",
    new Set(["format"]),
    mismatches,
  );
  if (Object.keys(requestedOutput).some((key) => key !== "format")
    && outputConfigurationComplete
    && !mismatches.some((entry) => entry.startsWith("audio.output.") && !entry.startsWith("audio.output.format"))) {
    verified.add("output_audio_configuration_except_format");
  }
  const requestedDetection = record(requested.turn_detection);
  verifyOptionalExact(
    acknowledgedDetection ?? {}, requestedDetection, "type", "turn_detection.type",
    "turn_detection_type", verified, mismatches,
  );
  const requestedDetectionParameters = Object.keys(requestedDetection)
    .filter((key) => key !== "type");
  if (requestedDetectionParameters.length > 0) {
    let complete = true;
    for (const key of requestedDetectionParameters) {
      if (!hasOwn(acknowledgedDetection ?? {}, key)) {
        complete = false;
        continue;
      }
      if (canonicalProviderJson(acknowledgedDetection![key]) !== canonicalProviderJson(requestedDetection[key])) {
        mismatches.push(`turn_detection.${key}`);
      }
    }
    if (complete && !mismatches.some((entry) => entry.startsWith("turn_detection."))) {
      verified.add("turn_detection_parameters");
    }
  }
  if (acknowledgedResumption && hasOwn(acknowledgedResumption, "enabled")) {
    if (acknowledgedResumption.enabled !== false) mismatches.push("resumption.enabled");
    else verified.add("resumption_disabled");
  }
  if (mismatches.length > 0) {
    throw new Error(`xAI session acknowledgement mismatch: ${mismatches.join(", ")}`);
  }
  const verifiedFields = XAI_BROWSER_SESSION_ECHO_FIELDS.filter((field) => verified.has(field));
  const unverifiableFields = XAI_BROWSER_SESSION_ECHO_FIELDS.filter((field) => !verified.has(field));
  return Object.freeze({
    acknowledgement: "session.updated" as const,
    strictParityVerified: false as const,
    verifiedFields: Object.freeze(verifiedFields),
    unverifiableFields: Object.freeze(unverifiableFields),
    sessionIdentity: Object.freeze({
      source: "session.created" as const,
      updatedContinuity: updatedSessionId === undefined
        ? "unverifiable_session_updated_omitted_identity" as const
        : "verified" as const,
    }),
    conversationIdentity: Object.freeze({
      source: "conversation.created" as const,
      status: startupProof?.conversationCreatedId
        ? "verified" as const
        : "not_observed_before_readiness" as const,
    }),
    modelIdentity: startupProof?.sessionCreatedModel
      ? Object.freeze({ source: "session.created" as const, status: "verified" as const })
      : verified.has("model")
        ? Object.freeze({ source: "session.updated" as const, status: "verified" as const })
        : Object.freeze({
            source: "provider_echo" as const,
            status: "unverifiable_provider_omitted" as const,
          }),
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
        let initialSessionUpdateSent = false;
        let createdSessionId: string | null = null;
        let createdConversationId: string | null = null;
        let createdSessionModel: string | null = null;
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

        // xAI emits session.created before accepting the initial session.update.
        socket.onopen = () => {};
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
          if (type === "conversation.created") {
            if (createdConversationId !== null) {
              failBeforeReady(new Error("xAI emitted duplicate conversation.created events"));
              return;
            }
            try {
              createdConversationId = boundedProviderIdentity(
                record(event.conversation).id,
                "conversation.created",
              );
            } catch (error) {
              failBeforeReady(safeError(error));
            }
            return;
          }
          if (type === "session.created") {
            if (createdSessionId !== null) {
              failBeforeReady(new Error("xAI emitted duplicate session.created events"));
              return;
            }
            if (!initialSessionUpdateSent) {
              try {
                const createdSession = record(event.session);
                const sessionId = boundedProviderIdentity(
                  createdSession.id,
                  "session.created",
                );
                if (hasOwn(createdSession, "model")) {
                  const model = boundedProviderIdentity(
                    createdSession.model,
                    "session.created.model",
                  );
                  if (model !== connection.model) {
                    throw new Error("xAI session.created model differs from the requested model");
                  }
                  createdSessionModel = model;
                }
                createdSessionId = sessionId;
                sendBoundedWebSocketJson(socket, sessionUpdate, "xAI session update");
                initialSessionUpdateSent = true;
              } catch (error) {
                failBeforeReady(safeError(error));
              }
            }
            return;
          }
          if (type === "rate_limits.updated") return;
          if (type === "ping") return;
          if (type === "error") {
            failBeforeReady(new Error("xAI rejected the realtime session update"));
            return;
          }
          if (type !== "session.updated") {
            failBeforeReady(new Error(`xAI emitted ${type} before session.updated verification`));
            return;
          }
          if (!initialSessionUpdateSent) {
            failBeforeReady(new Error("xAI emitted session.updated before session.created initialized the session"));
            return;
          }
          try {
            if (createdSessionId === null) throw new Error("xAI session identity was not initialized");
            this.readiness = verifyXaiBrowserSessionAcknowledgement(
              event,
              sessionUpdate,
              createdSessionId,
              {
                expectedModel: connection.model,
                startupIdentityProof: createStartupIdentityProof({
                  sessionCreatedModel: createdSessionModel,
                  conversationCreatedId: createdConversationId,
                }),
              },
            );
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

        if (type === "session.created") {
          args.handlers.onError(new Error("xAI emitted duplicate session.created events"));
          try { socket.close(1002, "duplicate xAI session identity"); } catch { /* already closed */ }
          return;
        }
        if (type === "conversation.created") {
          args.handlers.onError(new Error(
            createdConversationId === null
              ? "xAI emitted conversation.created after session readiness"
              : "xAI emitted duplicate conversation.created events",
          ));
          try { socket.close(1002, "invalid xAI conversation identity event"); } catch { /* already closed */ }
          return;
        }

        if (type === "session.updated") {
          try {
            if (createdSessionId === null) throw new Error("xAI session identity was not initialized");
            verifyXaiBrowserSessionAcknowledgement(event, sessionUpdate, createdSessionId, {
              expectedModel: connection.model,
              startupIdentityProof: createStartupIdentityProof({
                sessionCreatedModel: createdSessionModel,
                conversationCreatedId: createdConversationId,
              }),
            });
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

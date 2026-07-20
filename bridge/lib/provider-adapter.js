import { createHash } from "node:crypto";
import { parseCappedJson } from "./safe-json.js";

const PROVIDERS = Object.freeze({
  openai: Object.freeze({ hostname: "api.openai.com", pathname: "/v1/realtime" }),
  xai: Object.freeze({ hostname: "api.x.ai", pathname: "/v1/realtime" }),
});

const MAX_WIRE_EVENT_BYTES = 512 * 1024;
const MAX_SESSION_BYTES = 1024 * 1024;
const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
const MAX_TRACKED_IDENTITIES = 10_000;
const MAX_NATIVE_EVENT_REPLAY_IDENTITIES = 10_000;
const MAX_PENDING_CALLS = 128;
const MAX_CALLS_PER_RESPONSE = 64;
const MAX_PENDING_ARGUMENT_BYTES = 1024 * 1024;
const MAX_OUTPUT_ITEMS_PER_RESPONSE = 256;
const MAX_TRANSCRIPT_ITEM_BYTES = 64 * 1024;
const MAX_PENDING_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const TERMINAL_RESPONSE_STATUSES = new Set(["completed", "cancelled", "failed", "incomplete"]);
const CANCELLED_TERMINAL_FINGERPRINT = "terminal:cancelled";
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

export class ProviderAdapterError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ProviderAdapterError";
    this.code = code;
    this.fatal = options.fatal ?? true;
  }
}

/**
 * Validate the server-issued connection description before a provider key is
 * attached to the socket. Hosted bridge traffic is deliberately restricted to
 * the documented OpenAI and xAI realtime endpoints.
 */
export function validateProviderConfig(candidate, options = {}) {
  if (!isRecord(candidate)) throw configError("Provider configuration must be an object");
  const allowedConfigFields = new Set(["provider", "wsUrl", "model", "sessionUpdate"]);
  if (Object.keys(candidate).some((key) => !allowedConfigFields.has(key))) {
    throw configError("Provider configuration contains an unsupported field");
  }
  if (!isRecord(options) || Object.keys(options).some((key) => key !== "allowedClientTools")) {
    throw configError("Provider configuration options are invalid");
  }
  const allowedClientTools = normalizeAllowedClientTools(options.allowedClientTools);
  const provider = candidate.provider;
  if (provider !== "openai" && provider !== "xai") {
    throw configError(`Unsupported realtime provider: ${String(provider)}`);
  }

  if (typeof candidate.wsUrl !== "string" || encodedBytes(candidate.wsUrl) > 2_048) {
    throw configError("Realtime WebSocket URL must be a bounded string");
  }
  let url;
  try {
    url = new URL(candidate.wsUrl);
  } catch {
    throw configError("Realtime WebSocket URL is invalid");
  }
  const expected = PROVIDERS[provider];
  if (url.protocol !== "wss:" || url.hostname !== expected.hostname || url.pathname !== expected.pathname) {
    throw configError(`Realtime URL is not the hosted ${provider} endpoint`);
  }
  if (url.username || url.password || url.port || url.hash) {
    throw configError("Realtime URL cannot contain credentials, a custom port, or a fragment");
  }
  for (const key of url.searchParams.keys()) {
    if (key !== "model") throw configError(`Realtime URL query parameter ${key} is not allowed`);
  }
  const queryModels = url.searchParams.getAll("model");
  if (queryModels.length !== 1) throw configError("Realtime URL must select exactly one model");
  const urlModel = boundedIdentity(queryModels[0], "Realtime URL model", 256);
  const declaredModel = boundedIdentity(candidate.model, "Realtime provider model", 256);
  if (urlModel !== declaredModel) throw configError("Realtime URL and session response select different models");

  const sessionUpdate = candidate.sessionUpdate;
  if (!isRecord(sessionUpdate) || sessionUpdate.type !== "session.update" || !isRecord(sessionUpdate.session)) {
    throw configError("Realtime configuration requires a session.update object");
  }
  const allowedSessionUpdateFields = new Set(["type", "session", "event_id"]);
  if (Object.keys(sessionUpdate).some((key) => !allowedSessionUpdateFields.has(key))) {
    throw configError("session.update contains an unsupported top-level field");
  }
  if (sessionUpdate.event_id !== undefined) requireOpaqueId(sessionUpdate.event_id, "session.update event id");
  assertStrictJson(sessionUpdate, "session.update");
  if (encodedBytes(JSON.stringify(sessionUpdate)) > MAX_SESSION_BYTES) {
    throw configError(`session.update exceeds ${MAX_SESSION_BYTES} bytes`);
  }
  validateTelephonySession(provider, sessionUpdate.session, declaredModel, allowedClientTools);

  return deepFreeze({
    provider,
    wsUrl: url.toString(),
    model: declaredModel,
    sessionUpdate: structuredClone(sessionUpdate),
  });
}

/** Parse a WebSocket frame with a byte cap and without coercing arbitrary values. */
export function parseProviderFrame(frame, maximumBytes = MAX_WIRE_EVENT_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1024 * 1024) {
    throw new TypeError("maximumBytes must be a positive safe integer no greater than 1 MiB");
  }
  let bytes;
  if (typeof frame === "string") bytes = Buffer.from(frame, "utf8");
  else if (Buffer.isBuffer(frame)) bytes = frame;
  else if (frame instanceof Uint8Array) bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  else if (frame instanceof ArrayBuffer) bytes = Buffer.from(frame);
  else if (isRecord(frame)) {
    try {
      assertStrictJson(frame, "provider event", { maxBytes: maximumBytes });
      const serialized = JSON.stringify(frame);
      if (encodedBytes(serialized) > maximumBytes) throw new Error("event too large");
      const cloned = parseCappedJson(serialized, {
        maxBytes: maximumBytes,
        maxDepth: 32,
        maxNodes: 8_192,
        maxObjectKeys: 256,
        maxArrayLength: 4_096,
        maxStringBytes: Math.min(256 * 1024, maximumBytes),
        maxKeyBytes: 256,
        maxNumberChars: 128,
      });
      if (typeof cloned.type !== "string" || !cloned.type) throw new Error("missing type");
      return { ok: true, event: cloned };
    } catch (error) {
      return { ok: false, code: "invalid_event", message: safeMessage(error) };
    }
  } else {
    return { ok: false, code: "unsupported_wire_data", message: "Provider sent unsupported WebSocket data" };
  }
  if (bytes.byteLength > maximumBytes) {
    return { ok: false, code: "wire_event_too_large", message: `Provider event exceeds ${maximumBytes} bytes` };
  }
  let event;
  try {
    event = parseCappedJson(bytes, {
      maxBytes: maximumBytes,
      maxDepth: 32,
      maxNodes: 8_192,
      maxObjectKeys: 256,
      maxArrayLength: 4_096,
      maxStringBytes: Math.min(256 * 1024, maximumBytes),
      maxKeyBytes: 256,
      maxNumberChars: 128,
    });
  } catch {
    return { ok: false, code: "invalid_json", message: "Provider sent invalid or over-complex UTF-8 JSON" };
  }
  try {
    if (!isRecord(event) || typeof event.type !== "string" || !event.type) throw new Error("Provider event needs a type");
    assertStrictJson(event, "provider event");
  } catch (error) {
    return { ok: false, code: "invalid_event", message: safeMessage(error) };
  }
  return { ok: true, event };
}

/**
 * Stateful normalizer for the wire protocol genuinely shared by OpenAI and
 * xAI. `response.function_call_arguments.done` is evidence of argument
 * completion only; executable calls are emitted exclusively after a matching
 * `response.done` whose provider status is exactly `completed`.
 */
export class OpenAICompatibleProviderAdapter {
  constructor(config, options = {}) {
    if (!isRecord(options) || Object.keys(options).some((key) => ![
      "allowedClientTools",
      "now",
      "maximumWireEventBytes",
    ].includes(key))) {
      throw configError("Provider adapter options are invalid");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw configError("Provider adapter now must be a function");
    }
    this.config = validateProviderConfig(config, { allowedClientTools: options.allowedClientTools });
    this.provider = this.config.provider;
    this.declaredClientTools = new Set(
      (this.config.sessionUpdate.session.tools ?? []).map((tool) => tool.name),
    );
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.maximumWireEventBytes = options.maximumWireEventBytes ?? MAX_WIRE_EVENT_BYTES;
    if (!Number.isSafeInteger(this.maximumWireEventBytes) || this.maximumWireEventBytes < 1 || this.maximumWireEventBytes > 1024 * 1024) {
      throw new TypeError("maximumWireEventBytes must be a positive safe integer no greater than 1 MiB");
    }

    this.nativeEvents = new Map();
    this.responseStarts = new Map();
    this.terminalResponses = new Map();
    this.itemResponses = new Map();
    this.outputItemEvents = new Map();
    this.itemIdentities = new Map();
    this.truncationAcknowledgements = new Map();
    this.argumentDone = new Map();
    this.pendingCalls = new Map();
    this.retiredCalls = new Map();
    this.rejectedCalls = new Map();
    this.preAckResponseIds = new Set();
    this.preAckItemIds = new Set();
    this.inputTranscripts = new Map();
    this.outputTranscripts = new Map();
    this.outputAuthorizations = new Map();
    this.sessionAckFingerprint = undefined;
    this.sessionReady = false;
    this.poisoned = false;
    this.pendingArgumentBytes = 0;
    this.pendingTranscriptBytes = 0;
    this.callOrder = 0;
  }

  get ready() {
    return this.sessionReady && !this.poisoned;
  }

  inputAudioEvent(audio) {
    this.assertSessionReady();
    return buildInputAudioAppendEvent(audio);
  }

  functionCallOutputEvent(callId, output) {
    this.assertSessionReady();
    const event = buildFunctionCallOutputEvent(callId, output);
    this.consumeOutputAuthorizations([event.item.call_id]);
    return event;
  }

  functionCallOutputBatchEvents(results, options = {}) {
    this.assertSessionReady();
    const events = buildFunctionCallOutputBatchEvents(results, options);
    this.consumeOutputAuthorizations(results.map((result) => result.callId));
    return events;
  }

  createResponseEvent(response = undefined) {
    this.assertSessionReady();
    return buildResponseCreateEvent(response);
  }

  normalize(frame) {
    if (this.poisoned) {
      return [this.protocolError("adapter_poisoned", "Provider adapter is sealed after a fatal protocol violation", undefined, true)];
    }
    const parsed = parseProviderFrame(frame, this.maximumWireEventBytes);
    if (!parsed.ok) return [this.protocolError(parsed.code, parsed.message, undefined, true)];
    const event = parsed.event;
    const wireType = event.type;
    const nativeEventId = optionalIdentity(event.event_id, "provider event id");
    if (nativeEventId instanceof Error) {
      return [this.protocolError("invalid_event_id", nativeEventId.message, wireType, true)];
    }

    if (nativeEventId) {
      const eventFingerprint = fingerprint(omit(event, "event_id"));
      const previous = this.nativeEvents.get(nativeEventId);
      if (previous === eventFingerprint) return [];
      if (previous !== undefined) {
        return [this.protocolError("native_event_id_conflict", `Provider event id ${nativeEventId} was rewritten`, wireType, true, nativeEventId)];
      }
      this.reserveNativeEvent(nativeEventId, eventFingerprint);
    }

    const responseIdResult = eventResponseId(event);
    if (responseIdResult instanceof Error) {
      return [this.protocolError(responseIdResult.code ?? "invalid_response_id", responseIdResult.message, wireType, true, nativeEventId)];
    }
    const responseId = responseIdResult;
    const itemIdResult = eventItemId(event);
    if (itemIdResult instanceof Error) {
      return [this.protocolError(itemIdResult.code ?? "invalid_item_id", itemIdResult.message, wireType, true, nativeEventId)];
    }
    const itemId = itemIdResult;
    if (!this.sessionReady && requiresSessionAcknowledgement(wireType)) {
      if (responseId && this.preAckResponseIds.size < MAX_TRACKED_IDENTITIES) this.preAckResponseIds.add(responseId);
      if (itemId && this.preAckItemIds.size < MAX_TRACKED_IDENTITIES) this.preAckItemIds.add(itemId);
      return [this.protocolError(
        "event_before_session_ack",
        `Provider emitted ${wireType} before session.updated was validated`,
        wireType,
        true,
        nativeEventId,
      )];
    }
    if (
      (responseId && this.preAckResponseIds.has(responseId))
      || (itemId && this.preAckItemIds.has(itemId))
    ) {
      return [this.protocolError(
        "pre_ack_identity_reuse",
        "Provider reused response or item provenance first observed before readiness",
        wireType,
        true,
        nativeEventId,
      )];
    }
    if (itemId && responseId) {
      const priorResponse = this.itemResponses.get(itemId);
      if (priorResponse && priorResponse !== responseId) {
        return [this.protocolError("response_item_id_conflict", `Item ${itemId} was rebound from ${priorResponse} to ${responseId}`, wireType, true, nativeEventId)];
      }
      if (!priorResponse && !this.reserve(this.itemResponses, itemId, responseId)) {
        return [this.protocolError("identity_limit", "Provider item identity limit exceeded", wireType, true, nativeEventId)];
      }
    }
    const scopedResponseId = responseId ?? (itemId ? this.itemResponses.get(itemId) : undefined);
    if (scopedResponseId && requiresStartedResponse(wireType) && !this.responseStarts.has(scopedResponseId)) {
      return [this.protocolError(
        "response_not_started",
        `${wireType} referenced response ${scopedResponseId} before response.created`,
        wireType,
        true,
        nativeEventId,
      )];
    }
    if (
      scopedResponseId
      && isResponseScopedWireEvent(wireType)
      && this.terminalResponses.has(scopedResponseId)
      && wireType !== "response.done"
      && wireType !== "response.cancelled"
      && wireType !== "conversation.item.truncated"
    ) {
      if (this.terminalResponses.get(scopedResponseId) === CANCELLED_TERMINAL_FINGERPRINT) return [];
      return [this.protocolError("stale_response_event", `${wireType} arrived after response ${scopedResponseId} was terminal`, wireType, true, nativeEventId)];
    }

    try {
      switch (wireType) {
        case "session.created":
          return [];
        case "session.updated": {
          const acknowledgement = this.sessionAcknowledgement(event, nativeEventId);
          return acknowledgement ? [acknowledgement] : [];
        }
        case "response.created":
          return this.responseStarted(event, responseId, nativeEventId);
        case "response.output_audio.delta":
        case "response.audio.delta":
          if (!scopedResponseId) throw eventError("missing_response_id", `${wireType} omitted response provenance`);
          return [this.audioDelta(event, scopedResponseId, itemId, nativeEventId)];
        case "conversation.item.input_audio_transcription.delta":
        case "conversation.item.input_audio_transcription.updated":
          return [this.transcriptDelta(event, "user", wireType.endsWith(".updated"), itemId, responseId, nativeEventId)];
        case "conversation.item.input_audio_transcription.completed":
          return [this.transcriptDone(event, "user", itemId, responseId, nativeEventId)];
        case "conversation.item.input_audio_transcription.failed":
          this.releaseTranscript("user", itemId, responseId);
          return [this.providerError(event, false, nativeEventId)];
        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta":
        case "response.output_text.delta":
        case "response.text.delta":
          if (!scopedResponseId) throw eventError("missing_response_id", `${wireType} omitted response provenance`);
          return [this.transcriptDelta(event, "agent", false, itemId, scopedResponseId, nativeEventId)];
        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done":
        case "response.output_text.done":
        case "response.text.done":
          if (!scopedResponseId) throw eventError("missing_response_id", `${wireType} omitted response provenance`);
          return [this.transcriptDone(event, "agent", itemId, scopedResponseId, nativeEventId)];
        case "input_audio_buffer.speech_started":
          return [{ ...this.base(wireType, nativeEventId), type: "speech.started", itemId, audioStartMs: optionalNonnegativeInteger(event.audio_start_ms) }];
        case "input_audio_buffer.speech_stopped":
          return [{ ...this.base(wireType, nativeEventId), type: "speech.stopped", itemId, audioEndMs: optionalNonnegativeInteger(event.audio_end_ms) }];
        case "response.output_item.added":
        case "response.output_item.done":
          return this.outputItem(event, responseId, wireType.endsWith(".done"), nativeEventId);
        case "response.function_call_arguments.done":
          return this.argumentsCompleted(event, responseId, itemId, nativeEventId);
        case "response.function_call_arguments.delta":
          return [];
        case "response.function_call_arguments.cancelled":
          return this.argumentsCancelled(event, responseId, nativeEventId);
        case "response.cancelled":
          return this.responseCancelled(event, responseId, nativeEventId);
        case "conversation.item.truncated":
          return this.truncationAcknowledged(event, scopedResponseId, itemId, nativeEventId);
        case "response.done":
          return this.responseCompleted(event, responseId, nativeEventId);
        case "error":
          return [this.providerError(event, undefined, nativeEventId)];
        default:
          if (isProviderManagedToolEvent(wireType)) {
            return [this.protocolError(
              "unsupported_provider_tool_event",
              `Provider emitted forbidden tool-capable event ${wireType}`,
              wireType,
              true,
              nativeEventId,
            )];
          }
          return [];
      }
    } catch (error) {
      const typed = error instanceof ProviderAdapterError
        ? error
        : new ProviderAdapterError("invalid_provider_event", safeMessage(error));
      return [this.protocolError(typed.code, typed.message, wireType, typed.fatal, nativeEventId)];
    }
  }

  /**
   * Seal a response locally before the caller writes interruption frames. This
   * ordering makes late audio/tool events stale immediately instead of waiting
   * for a provider acknowledgement after a Twilio clear.
   */
  interruptResponse(input) {
    this.assertSessionReady();
    if (!isRecord(input)) throw new ProviderAdapterError("invalid_interruption", "Interruption input must be an object");
    const allowed = new Set(["responseId", "itemId", "contentIndex", "audioEndMs", "reason"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) {
      throw new ProviderAdapterError("invalid_interruption", "Interruption input contains an unsupported field");
    }
    const responseId = requireOpaqueId(input.responseId, "interrupted response id");
    const reason = input.reason === undefined
      ? "client_interruption"
      : boundedText(input.reason, "interruption reason", 256);
    const hasTruncation = input.itemId !== undefined || input.audioEndMs !== undefined || input.contentIndex !== undefined;
    if (hasTruncation && (input.itemId === undefined || input.audioEndMs === undefined)) {
      throw new ProviderAdapterError("invalid_interruption", "Truncation requires itemId and audioEndMs");
    }
    if (!this.responseStarts.has(responseId) || this.terminalResponses.has(responseId)) {
      throw new ProviderAdapterError("invalid_interruption", "Interruption requires an active provider response");
    }
    if (hasTruncation) {
      const itemId = requireOpaqueId(input.itemId, "truncated item id");
      if (this.itemResponses.get(itemId) !== responseId) {
        throw new ProviderAdapterError("invalid_interruption", "Truncated item does not belong to the interrupted response");
      }
    }
    // Build and validate every outbound frame before mutating terminal state.
    // A bad truncate must be retryable with corrected bounds.
    const wireEvents = [
      buildResponseCancelEvent(responseId),
      ...(hasTruncation ? [buildConversationItemTruncateEvent({
        itemId: input.itemId,
        contentIndex: input.contentIndex ?? 0,
        audioEndMs: input.audioEndMs,
      })] : []),
    ];
    const wasTerminal = this.terminalResponses.has(responseId);
    const normalizedEvents = this.responseCancelled(
      { type: "response.cancelled", response_id: responseId, reason },
      responseId,
      undefined,
    );
    return deepFreeze({ wireEvents: wasTerminal ? [] : wireEvents, normalizedEvents });
  }

  sessionAcknowledgement(event, nativeEventId) {
    if (!isRecord(event.session)) throw eventError("invalid_session_ack", "session.updated omitted its session object");
    assertStrictJson(event.session, "session.updated.session");
    const acknowledgedModel = optionalIdentity(event.session.model, "acknowledged model", 256);
    if (acknowledgedModel instanceof Error) throw eventError("invalid_session_ack", acknowledgedModel.message);
    if (acknowledgedModel && acknowledgedModel !== this.config.model) {
      throw eventError("session_model_mismatch", `Provider acknowledged model ${acknowledgedModel}, expected ${this.config.model}`);
    }
    const sessionId = optionalIdentity(event.session.id, "session id");
    if (sessionId instanceof Error) throw eventError("invalid_session_ack", sessionId.message);
    const ackFingerprint = fingerprint(event.session);
    if (this.sessionAckFingerprint === ackFingerprint) return undefined;
    if (this.sessionAckFingerprint !== undefined) {
      throw eventError("unsolicited_session_update", "Provider sent a different session.updated after readiness");
    }
    this.sessionAckFingerprint = ackFingerprint;
    const configuration = configurationEvidence(
      this.provider,
      this.config.model,
      this.config.sessionUpdate.session,
      event.session,
    );
    if (!configuration.strictParityVerified) {
      throw eventError(
        configuration.session.status === "mismatch" || configuration.unexpectedAuthorityFields.length > 0
          ? "session_configuration_mismatch"
          : "session_configuration_unverifiable",
        "Provider did not exactly acknowledge the requested security-sensitive session configuration",
      );
    }
    const acknowledgement = {
      ...this.base(event.type, nativeEventId),
      type: "session.ack",
      sessionId,
      configuration,
    };
    this.sessionReady = true;
    return acknowledgement;
  }

  responseStarted(event, responseId, nativeEventId) {
    if (!responseId) throw eventError("missing_response_id", "response.created omitted a response id");
    const value = fingerprint(omit(event, "event_id"));
    const prior = this.responseStarts.get(responseId);
    if (prior === value) return [];
    if (prior !== undefined) throw eventError("response_id_conflict", `Response ${responseId} start was rewritten`);
    if (!this.reserve(this.responseStarts, responseId, value)) throw eventError("identity_limit", "Response identity limit exceeded");
    return [{ ...this.base(event.type, nativeEventId), type: "response.started", responseId }];
  }

  audioDelta(event, responseId, itemId, nativeEventId) {
    const audio = canonicalBase64(event.delta, "audio delta");
    return { ...this.base(event.type, nativeEventId), type: "audio.delta", audio, responseId, itemId };
  }

  transcriptDelta(event, speaker, cumulative, itemId, responseId, nativeEventId) {
    const map = speaker === "user" ? this.inputTranscripts : this.outputTranscripts;
    const key = itemId ?? `${speaker}:${responseId ?? "unattributed"}`;
    const previous = map.get(key) ?? "";
    const incoming = boundedText(event.delta ?? event.transcript ?? event.text ?? "", "transcript", MAX_TRANSCRIPT_ITEM_BYTES);
    const text = cumulative ? incoming : previous + incoming;
    const nextBytes = encodedBytes(text);
    if (nextBytes > MAX_TRANSCRIPT_ITEM_BYTES) throw eventError("transcript_too_large", `Transcript item exceeds ${MAX_TRANSCRIPT_ITEM_BYTES} bytes`);
    const previousBytes = encodedBytes(previous);
    if (this.pendingTranscriptBytes - previousBytes + nextBytes > MAX_PENDING_TRANSCRIPT_BYTES) {
      throw eventError("transcript_buffer_too_large", `Pending transcripts exceed ${MAX_PENDING_TRANSCRIPT_BYTES} bytes`);
    }
    const revised = cumulative && previous.length > 0 && !text.startsWith(previous);
    if (!map.has(key) && map.size >= MAX_TRACKED_IDENTITIES) throw eventError("identity_limit", "Transcript identity limit exceeded");
    map.set(key, text);
    this.pendingTranscriptBytes = this.pendingTranscriptBytes - previousBytes + nextBytes;
    return {
      ...this.base(event.type, nativeEventId),
      type: "transcript",
      speaker,
      phase: "delta",
      text,
      delta: cumulative && text.startsWith(previous) ? text.slice(previous.length) : incoming,
      revised,
      itemId,
      responseId,
    };
  }

  transcriptDone(event, speaker, itemId, responseId, nativeEventId) {
    const map = speaker === "user" ? this.inputTranscripts : this.outputTranscripts;
    const key = itemId ?? `${speaker}:${responseId ?? "unattributed"}`;
    const previous = map.get(key) ?? "";
    const text = boundedText(event.transcript ?? event.text ?? previous, "transcript", MAX_TRANSCRIPT_ITEM_BYTES);
    this.releaseTranscript(speaker, itemId, responseId);
    return {
      ...this.base(event.type, nativeEventId),
      type: "transcript",
      speaker,
      phase: "final",
      text,
      revised: previous.length > 0 && text !== previous && !text.startsWith(previous),
      itemId,
      responseId,
    };
  }

  releaseTranscript(speaker, itemId, responseId) {
    const map = speaker === "user" ? this.inputTranscripts : this.outputTranscripts;
    const key = itemId ?? `${speaker}:${responseId ?? "unattributed"}`;
    const previous = map.get(key);
    if (previous === undefined) return;
    map.delete(key);
    this.pendingTranscriptBytes -= encodedBytes(previous);
    if (this.pendingTranscriptBytes < 0) this.pendingTranscriptBytes = 0;
  }

  releaseResponseTranscripts(responseId) {
    for (const [key, text] of this.outputTranscripts) {
      if (key === `agent:${responseId}` || this.itemResponses.get(key) === responseId) {
        this.outputTranscripts.delete(key);
        this.pendingTranscriptBytes -= encodedBytes(text);
      }
    }
    if (this.pendingTranscriptBytes < 0) this.pendingTranscriptBytes = 0;
  }

  outputItem(event, responseId, terminal, nativeEventId) {
    if (!isRecord(event.item)) throw eventError("invalid_output_item", "response output item must be an object");
    const itemId = requireOpaqueId(event.item.id ?? event.item_id, "output item id");
    if (!responseId) throw eventError("missing_response_id", "response output item omitted response_id");
    const key = `${event.type}\0${responseId}\0${itemId}`;
    const value = fingerprint(event.item);
    const prior = this.outputItemEvents.get(key);
    if (prior === value) return [];
    if (prior !== undefined) throw eventError("output_item_conflict", `Output item ${itemId} was rewritten for ${event.type}`);
    if (!this.reserve(this.outputItemEvents, key, value)) throw eventError("identity_limit", "Output item identity limit exceeded");
    this.bindItemIdentity(event.item, responseId);
    if (isUnsupportedToolItemType(event.item.type)) {
      throw eventError("unsupported_provider_tool_item", `Provider emitted forbidden output item type ${event.item.type}`);
    }
    if (event.item.type !== "function_call") return [];
    this.ingestFunctionItem(event.item, responseId, terminal);
    return [];
  }

  argumentsCompleted(event, responseId, itemId, nativeEventId) {
    if (!responseId) throw eventError("missing_response_id", "function_call_arguments.done omitted response_id");
    const callId = requireOpaqueId(event.call_id, "function call id");
    let name;
    try {
      name = requireToolName(event.name, "function call name");
      this.assertDeclaredToolName(name);
    } catch (error) {
      this.rejectCallIdentity(callId, responseId);
      throw error;
    }
    const args = boundedText(event.arguments, "function call arguments", MAX_ARGUMENT_BYTES);
    const signature = fingerprint({ responseId, itemId, callId, name, args });
    const prior = this.argumentDone.get(callId);
    if (prior === signature) return [];
    if (prior !== undefined) {
      this.conflictCall(callId);
      throw eventError("tool_call_identity_conflict", `Function call ${callId} arguments-done event was rewritten`);
    }
    if (!this.reserve(this.argumentDone, callId, signature)) throw eventError("identity_limit", "Function call identity limit exceeded");
    const pending = this.upsertCall({ callId, responseId, itemId, name, argumentsText: args });
    pending.argumentsDone = true;
    pending.terminal = true;
    pending.argumentsText = args;
    return [{
      ...this.base(event.type, nativeEventId),
      type: "function_call.arguments_done",
      executable: false,
      callId,
      responseId,
      itemId,
      name,
    }];
  }

  argumentsCancelled(event, responseId, nativeEventId) {
    if (!responseId) throw eventError("missing_response_id", "function_call_arguments.cancelled omitted response_id");
    const callId = requireOpaqueId(event.call_id, "function call id");
    const pending = this.upsertCall({ callId, responseId });
    pending.cancelled = true;
    return [{ ...this.base(event.type, nativeEventId), type: "function_call.cancelled", callIds: [callId], responseId }];
  }

  responseCancelled(event, responseId, nativeEventId) {
    if (!responseId) throw eventError("missing_response_id", "response.cancelled omitted response_id");
    const terminalFingerprint = CANCELLED_TERMINAL_FINGERPRINT;
    const prior = this.terminalResponses.get(responseId);
    if (prior === terminalFingerprint) return [];
    if (prior !== undefined) throw eventError("response_id_conflict", `Terminal response ${responseId} was rewritten`);
    if (!this.reserve(this.terminalResponses, responseId, terminalFingerprint)) throw eventError("identity_limit", "Terminal response identity limit exceeded");
    this.releaseResponseTranscripts(responseId);
    const pending = this.retirePendingCalls(responseId);
    const result = [];
    if (pending.length) {
      result.push({
        ...this.base(event.type, nativeEventId),
        type: "function_call.cancelled",
        callIds: pending.map((call) => call.callId),
        responseId,
      });
    }
    result.push({
      ...this.base(event.type, nativeEventId),
      type: "response.interrupted",
      responseId,
      reason: boundedOptionalText(event.reason),
    });
    result.push({
      ...this.base(event.type, nativeEventId),
      type: "response.completed",
      responseId,
      status: "cancelled",
      executableToolCalls: false,
    });
    return result;
  }

  truncationAcknowledged(event, responseId, itemId, nativeEventId) {
    if (!responseId || !itemId) {
      throw eventError("invalid_truncation_ack", "conversation.item.truncated omitted response or item provenance");
    }
    const acknowledgement = fingerprint({
      responseId,
      itemId,
      contentIndex: event.content_index ?? null,
      audioEndMs: event.audio_end_ms ?? null,
    });
    const prior = this.truncationAcknowledgements.get(itemId);
    if (prior === acknowledgement) return [];
    if (prior !== undefined) {
      throw eventError("truncation_ack_conflict", `Truncation acknowledgement for item ${itemId} was rewritten`);
    }
    if (!this.reserve(this.truncationAcknowledgements, itemId, acknowledgement)) {
      throw eventError("identity_limit", "Truncation acknowledgement identity limit exceeded");
    }
    return [{ ...this.base(event.type, nativeEventId), type: "playback.truncated", responseId, itemId }];
  }

  responseCompleted(event, responseId, nativeEventId) {
    if (!isRecord(event.response)) throw eventError("invalid_response_done", "response.done omitted its response object");
    if (!responseId) throw eventError("missing_response_id", "response.done omitted a response id");
    const responseStatus = typeof event.response.status === "string" ? event.response.status : undefined;
    const eventStatus = typeof event.status === "string" ? event.status : undefined;
    const rawStatus = responseStatus ?? eventStatus;
    const statusConflict = responseStatus !== undefined && eventStatus !== undefined && responseStatus !== eventStatus;
    const status = !statusConflict && rawStatus && TERMINAL_RESPONSE_STATUSES.has(rawStatus) ? rawStatus : "unknown";
    const terminalFingerprint = status === "cancelled"
      ? CANCELLED_TERMINAL_FINGERPRINT
      : fingerprint({ response: event.response, status: event.status });
    const prior = this.terminalResponses.get(responseId);
    if (prior === terminalFingerprint) return [];
    if (prior !== undefined) throw eventError("response_id_conflict", `Terminal response ${responseId} was rewritten`);
    if (!this.reserve(this.terminalResponses, responseId, terminalFingerprint)) throw eventError("identity_limit", "Terminal response identity limit exceeded");
    this.releaseResponseTranscripts(responseId);
    const output = event.response.output === undefined ? [] : event.response.output;
    if (!Array.isArray(output) || output.length > MAX_OUTPUT_ITEMS_PER_RESPONSE) {
      const pending = this.retirePendingCalls(responseId);
      const result = [this.protocolError(
        "invalid_response_done",
        !Array.isArray(output)
          ? "response.done output must be an array"
          : `response.done output exceeds ${MAX_OUTPUT_ITEMS_PER_RESPONSE} items`,
        event.type,
        true,
        nativeEventId,
      )];
      if (pending.length) {
        result.push({
          ...this.base(event.type, nativeEventId),
          type: "function_call.cancelled",
          callIds: pending.map((call) => call.callId),
          responseId,
        });
      }
      result.push({
        ...this.base(event.type, nativeEventId),
        type: "response.completed",
        responseId,
        status,
        rawStatus,
        executableToolCalls: false,
      });
      return result;
    }
    if (status !== "completed") {
      const pending = this.retirePendingCalls(responseId);
      const result = [];
      if (statusConflict || status === "unknown") {
        result.push(this.protocolError(
          statusConflict ? "response_status_conflict" : "invalid_response_status",
          statusConflict
            ? "response.done contains conflicting terminal statuses"
            : "response.done contains an unknown terminal status",
          event.type,
          true,
          nativeEventId,
        ));
      }
      if (pending.length) {
        result.push({
          ...this.base(event.type, nativeEventId),
          type: "function_call.cancelled",
          callIds: pending.map((call) => call.callId),
          responseId,
        });
      }
      result.push({
        ...this.base(event.type, nativeEventId),
        type: "response.completed",
        responseId,
        status,
        rawStatus,
        executableToolCalls: false,
      });
      return result;
    }
    const terminalItemIds = new Set();
    const terminalFunctionCalls = new Map();
    let batchInvalid = status !== "completed";
    const errors = statusConflict
      ? [this.protocolError("response_status_conflict", "response.done contains conflicting terminal statuses", event.type, true, nativeEventId)]
      : [];
    for (const rawItem of output) {
      if (!isRecord(rawItem)) {
        batchInvalid = true;
        errors.push(this.protocolError("invalid_output_item", "Terminal response contained a non-object output item", event.type, true, nativeEventId));
        continue;
      }
      const rawItemId = rawItem.id;
      if (rawItemId !== undefined) {
        let terminalItemId;
        try { terminalItemId = requireOpaqueId(rawItemId, "terminal output item id"); }
        catch (error) {
          batchInvalid = true;
          errors.push(this.protocolError(error.code ?? "invalid_item_id", error.message, event.type, true, nativeEventId));
          continue;
        }
        if (terminalItemIds.has(terminalItemId)) {
          batchInvalid = true;
          errors.push(this.protocolError("response_item_id_conflict", `Terminal response ${responseId} repeated item ${terminalItemId}`, event.type, true, nativeEventId));
          continue;
        }
        terminalItemIds.add(terminalItemId);
        const bound = this.itemResponses.get(terminalItemId);
        if (bound && bound !== responseId) {
          batchInvalid = true;
          errors.push(this.protocolError("response_item_id_conflict", `Item ${terminalItemId} was rebound from ${bound} to ${responseId}`, event.type, true, nativeEventId));
          continue;
        }
        if (!bound && !this.reserve(this.itemResponses, terminalItemId, responseId)) {
          batchInvalid = true;
          errors.push(this.protocolError("identity_limit", "Provider item identity limit exceeded", event.type, true, nativeEventId));
          continue;
        }
        try { this.bindItemIdentity(rawItem, responseId); }
        catch (error) {
          batchInvalid = true;
          errors.push(this.protocolError(error.code ?? "output_item_conflict", error.message, event.type, true, nativeEventId));
          continue;
        }
      }
      if (isUnsupportedToolItemType(rawItem.type)) {
        batchInvalid = true;
        errors.push(this.protocolError(
          "unsupported_provider_tool_item",
          `Terminal response contained forbidden output item type ${String(rawItem.type)}`,
          event.type,
          true,
          nativeEventId,
        ));
        continue;
      }
      if (rawItem.type === "function_call") {
        try {
          if (rawItem.id === undefined) throw eventError("invalid_output_item", "Terminal function call omitted its item id");
          const pendingCall = this.ingestFunctionItem(rawItem, responseId, true);
          terminalFunctionCalls.set(pendingCall.callId, pendingCall.itemId);
        }
        catch (error) {
          batchInvalid = true;
          if (typeof rawItem.call_id === "string") this.conflictCall(rawItem.call_id);
          errors.push(this.protocolError(error.code ?? "invalid_tool_call", error.message, event.type, true, nativeEventId));
        }
      }
    }

    const pending = [...this.pendingCalls.values()]
      .filter((call) => call.responseId === responseId)
      .sort((a, b) => a.order - b.order);
    const ready = [];
    for (const call of pending) {
      if (call.conflicted || call.cancelled || !call.terminal || !call.name || call.argumentsText === undefined) {
        batchInvalid = true;
        continue;
      }
      if (!terminalFunctionCalls.has(call.callId) || terminalFunctionCalls.get(call.callId) !== call.itemId) {
        batchInvalid = true;
        errors.push(this.protocolError(
          "terminal_tool_membership_missing",
          `Function call ${call.callId} was not identically present in terminal response output`,
          event.type,
          true,
          nativeEventId,
        ));
        continue;
      }
      try {
        const args = parseCappedJson(call.argumentsText, {
          maxBytes: MAX_ARGUMENT_BYTES,
          maxDepth: 32,
          maxNodes: 4_096,
          maxObjectKeys: 256,
          maxArrayLength: 2_048,
          maxStringBytes: MAX_ARGUMENT_BYTES,
          maxKeyBytes: 256,
          maxNumberChars: 128,
        });
        if (!isRecord(args)) throw new Error("arguments must decode to an object");
        assertStrictJson(args, `arguments for ${call.callId}`);
        ready.push({
          callId: call.callId,
          responseId,
          itemId: call.itemId,
          name: call.name,
          arguments: args,
          argumentsText: call.argumentsText,
        });
      } catch (error) {
        batchInvalid = true;
        errors.push(this.protocolError("invalid_tool_arguments", `Function call ${call.callId}: ${safeMessage(error)}`, event.type, false, nativeEventId));
      }
    }

    const callIds = pending.map((call) => call.callId);
    this.retirePendingCalls(responseId);
    const result = [...errors];
    if (!batchInvalid && ready.length > 0) {
      for (const call of ready) {
        this.outputAuthorizations.set(call.callId, {
          responseId: call.responseId,
          itemId: call.itemId,
          state: "ready",
        });
      }
      result.push({ ...this.base(event.type, nativeEventId), type: "function_calls.ready", executable: true, responseId, calls: ready });
    } else if (callIds.length > 0) {
      result.push({ ...this.base(event.type, nativeEventId), type: "function_call.cancelled", callIds, responseId });
    }
    result.push({
      ...this.base(event.type, nativeEventId),
      type: "response.completed",
      responseId,
      status,
      rawStatus,
      executableToolCalls: !batchInvalid && ready.length > 0,
    });
    return result;
  }

  ingestFunctionItem(item, responseId, terminal) {
    const callId = requireOpaqueId(item.call_id, "function call id");
    const itemId = item.id === undefined ? undefined : requireOpaqueId(item.id, "function call item id");
    let name;
    try {
      name = item.name === undefined ? undefined : requireToolName(item.name, "function call name");
      if (name !== undefined) this.assertDeclaredToolName(name);
    } catch (error) {
      this.rejectCallIdentity(callId, responseId);
      throw error;
    }
    const argumentsText = item.arguments === undefined
      ? undefined
      : boundedText(item.arguments, "function call arguments", MAX_ARGUMENT_BYTES);
    let pending;
    try {
      pending = this.upsertCall({ callId, responseId, itemId, name, argumentsText });
    } catch (error) {
      if (!this.pendingCalls.has(callId) && !this.retiredCalls.has(callId)) {
        this.rejectCallIdentity(callId, responseId);
      }
      throw error;
    }
    if (terminal) {
      const status = item.status;
      pending.terminal = status === undefined || status === "completed";
      if (status !== undefined && status !== "completed") pending.cancelled = true;
    }
    return pending;
  }

  bindItemIdentity(item, responseId) {
    const itemId = requireOpaqueId(item.id, "output item id");
    const type = boundedText(item.type, "output item type", 128);
    const next = {
      responseId,
      type,
      ...(item.call_id === undefined ? {} : { callId: requireOpaqueId(item.call_id, "function call id") }),
      ...(item.name === undefined ? {} : { name: requireToolName(item.name, "function call name") }),
    };
    const current = this.itemIdentities.get(itemId);
    if (!current) {
      if (!this.reserve(this.itemIdentities, itemId, next)) throw eventError("identity_limit", "Output item identity limit exceeded");
      return;
    }
    for (const field of ["responseId", "type", "callId", "name"]) {
      if (current[field] !== undefined && next[field] !== undefined && current[field] !== next[field]) {
        throw eventError("output_item_conflict", `Output item ${itemId} changed immutable ${field}`);
      }
      if (current[field] === undefined && next[field] !== undefined) current[field] = next[field];
    }
  }

  consumeOutputAuthorizations(callIds) {
    for (const rawCallId of callIds) {
      const callId = requireOpaqueId(rawCallId, "function call output id");
      const authorization = this.outputAuthorizations.get(callId);
      if (!authorization || authorization.state !== "ready") {
        throw new ProviderAdapterError(
          "function_output_not_authorized",
          `Function output ${callId} is unknown, cancelled, or already submitted`,
        );
      }
    }
    for (const rawCallId of callIds) this.outputAuthorizations.get(rawCallId).state = "submitted";
  }

  upsertCall(next) {
    const rejected = this.rejectedCalls.get(next.callId);
    if (rejected) {
      throw eventError("tool_call_identity_conflict", `Function call id ${next.callId} was previously rejected in response ${rejected.responseId}`);
    }
    const retired = this.retiredCalls.get(next.callId);
    if (retired) {
      throw eventError("tool_call_identity_conflict", `Function call id ${next.callId} already belongs to terminal response ${retired.responseId}`);
    }
    let current = this.pendingCalls.get(next.callId);
    if (!current) {
      if (this.pendingCalls.size + this.retiredCalls.size + this.rejectedCalls.size >= MAX_TRACKED_IDENTITIES) {
        throw eventError("identity_limit", "Function call identity limit exceeded");
      }
      if (this.pendingCalls.size >= MAX_PENDING_CALLS) {
        this.rejectCallIdentity(next.callId, next.responseId);
        throw eventError("pending_call_limit", `More than ${MAX_PENDING_CALLS} function calls are pending`);
      }
      if (next.responseId && [...this.pendingCalls.values()].filter((call) => call.responseId === next.responseId).length >= MAX_CALLS_PER_RESPONSE) {
        this.rejectCallIdentity(next.callId, next.responseId);
        throw eventError("response_call_limit", `Response ${next.responseId} exceeds ${MAX_CALLS_PER_RESPONSE} function calls`);
      }
      const argumentBytes = next.argumentsText === undefined ? 0 : encodedBytes(next.argumentsText);
      if (this.pendingArgumentBytes + argumentBytes > MAX_PENDING_ARGUMENT_BYTES) {
        this.rejectCallIdentity(next.callId, next.responseId);
        throw eventError("pending_arguments_too_large", `Pending function arguments exceed ${MAX_PENDING_ARGUMENT_BYTES} bytes`);
      }
      current = {
        callId: next.callId,
        responseId: next.responseId,
        itemId: next.itemId,
        name: next.name,
        argumentsText: next.argumentsText,
        order: this.callOrder++,
        terminal: false,
        argumentsDone: false,
        cancelled: false,
        conflicted: false,
      };
      this.pendingCalls.set(next.callId, current);
      this.pendingArgumentBytes += argumentBytes;
      return current;
    }
    for (const field of ["responseId", "itemId", "name", "argumentsText"]) {
      if (next[field] !== undefined && current[field] !== undefined && next[field] !== current[field]) {
        current.conflicted = true;
        throw eventError("tool_call_identity_conflict", `Function call ${next.callId} changed ${field}`);
      }
    }
    const additionalArgumentBytes = current.argumentsText === undefined && next.argumentsText !== undefined
      ? encodedBytes(next.argumentsText)
      : 0;
    if (this.pendingArgumentBytes + additionalArgumentBytes > MAX_PENDING_ARGUMENT_BYTES) {
      throw eventError("pending_arguments_too_large", `Pending function arguments exceed ${MAX_PENDING_ARGUMENT_BYTES} bytes`);
    }
    for (const field of ["responseId", "itemId", "name", "argumentsText"]) {
      if (current[field] === undefined && next[field] !== undefined) current[field] = next[field];
    }
    this.pendingArgumentBytes += additionalArgumentBytes;
    return current;
  }

  retirePendingCalls(responseId) {
    const pending = [...this.pendingCalls.values()]
      .filter((call) => call.responseId === responseId)
      .sort((left, right) => left.order - right.order);
    for (const call of pending) {
      this.pendingCalls.delete(call.callId);
      this.pendingArgumentBytes -= call.argumentsText === undefined ? 0 : encodedBytes(call.argumentsText);
      this.retiredCalls.set(call.callId, { responseId, fingerprint: callIdentityFingerprint(call) });
    }
    if (this.pendingArgumentBytes < 0) this.pendingArgumentBytes = 0;
    return pending;
  }

  conflictCall(callId) {
    const pending = this.pendingCalls.get(callId);
    if (pending) pending.conflicted = true;
  }

  rejectCallIdentity(callId, responseId) {
    if (this.rejectedCalls.has(callId)) return;
    if (this.pendingCalls.size + this.retiredCalls.size + this.rejectedCalls.size >= MAX_TRACKED_IDENTITIES) return;
    this.rejectedCalls.set(callId, { responseId });
  }

  assertDeclaredToolName(name) {
    if (!this.declaredClientTools.has(name)) {
      throw eventError("undeclared_tool_call", `Provider called undeclared function ${name}`);
    }
  }

  assertSessionReady() {
    if (!this.sessionReady || this.poisoned) {
      throw new ProviderAdapterError("session_not_ready", "Provider session.updated has not been validated");
    }
  }

  providerError(event, knownFatal, nativeEventId) {
    const error = isRecord(event.error) ? event.error : {};
    const message = boundedText(error.message ?? event.message ?? "Realtime provider returned an error", "provider error", 2_000);
    const code = boundedOptionalText(error.code ?? error.type ?? event.code, 128);
    return {
      ...this.base(event.type, nativeEventId),
      type: "provider.error",
      code,
      message,
      // Do not manufacture provider severity. `null` means the wire did not say.
      fatal: typeof knownFatal === "boolean" ? knownFatal : typeof error.fatal === "boolean" ? error.fatal : null,
    };
  }

  protocolError(code, message, wireType = "protocol", fatal = true, nativeEventId) {
    if (fatal) this.poisoned = true;
    return { ...this.base(wireType ?? "protocol", nativeEventId), type: "protocol.error", code, message: String(message).slice(0, 2_000), fatal };
  }

  base(wireType, nativeEventId) {
    return { provider: this.provider, wireType, receivedAtMs: this.now(), ...(nativeEventId ? { nativeEventId } : {}) };
  }

  reserveNativeEvent(key, value) {
    // Provider event IDs are a bounded, sliding replay window. Durable
    // response/item/call ledgers below remain authoritative for consequential
    // tool identity after an event ages out of this high-rate transport cache.
    if (this.nativeEvents.size >= MAX_NATIVE_EVENT_REPLAY_IDENTITIES) {
      const oldest = this.nativeEvents.keys().next().value;
      this.nativeEvents.delete(oldest);
    }
    this.nativeEvents.set(key, value);
  }

  reserve(map, key, value) {
    if (map.size >= MAX_TRACKED_IDENTITIES) return false;
    map.set(key, value);
    return true;
  }
}

export function buildInputAudioAppendEvent(audio) {
  return deepFreeze({ type: "input_audio_buffer.append", audio: canonicalBase64(audio, "input audio") });
}

export function buildFunctionCallOutputEvent(callId, output) {
  const boundedCallId = requireOpaqueId(callId, "function call output id");
  let serialized;
  if (typeof output === "string") serialized = output;
  else {
    assertStrictJson(output, "function call output", { maxBytes: MAX_TOOL_OUTPUT_BYTES });
    serialized = JSON.stringify(output);
  }
  if (serialized === undefined) serialized = "null";
  if (encodedBytes(serialized) > MAX_TOOL_OUTPUT_BYTES) {
    throw new ProviderAdapterError("tool_output_too_large", `Function call output exceeds ${MAX_TOOL_OUTPUT_BYTES} bytes`);
  }
  return deepFreeze({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: boundedCallId, output: serialized },
  });
}

/** Validate and serialize a whole parallel-call result batch before any send. */
export function buildFunctionCallOutputBatchEvents(results, options = {}) {
  if (!isRecord(options) || Object.keys(options).some((key) => key !== "createResponse")) {
    throw new ProviderAdapterError("invalid_tool_result_batch", "Function result batch options are invalid");
  }
  const createResponse = options.createResponse ?? true;
  if (!Array.isArray(results) || results.length < 1 || results.length > MAX_CALLS_PER_RESPONSE) {
    throw new ProviderAdapterError(
      "invalid_tool_result_batch",
      `Function call output batch must contain 1-${MAX_CALLS_PER_RESPONSE} results`,
    );
  }
  if (typeof createResponse !== "boolean") {
    throw new ProviderAdapterError("invalid_tool_result_batch", "createResponse must be a boolean");
  }
  const seen = new Set();
  const outputEvents = results.map((result) => {
    if (!isRecord(result) || Object.keys(result).some((key) => key !== "callId" && key !== "output") ||
        !Object.hasOwn(result, "callId") || !Object.hasOwn(result, "output")) {
      throw new ProviderAdapterError("invalid_tool_result_batch", "Each function result needs exactly callId and output");
    }
    const callId = requireOpaqueId(result.callId, "function call output id");
    if (seen.has(callId)) throw new ProviderAdapterError("invalid_tool_result_batch", `Duplicate function result ${callId}`);
    seen.add(callId);
    return buildFunctionCallOutputEvent(callId, result.output);
  });
  return deepFreeze([
    ...outputEvents,
    ...(createResponse ? [buildResponseCreateEvent()] : []),
  ]);
}

export function buildResponseCreateEvent(response = undefined) {
  if (response === undefined) return Object.freeze({ type: "response.create" });
  if (!isRecord(response)) throw new ProviderAdapterError("invalid_response_create", "response.create overrides must be an object");
  if (Object.keys(response).some((key) => key !== "metadata")) {
    throw new ProviderAdapterError(
      "unsafe_response_create_override",
      "response.create may carry metadata only; tools, instructions, and behavioral overrides are session-owned",
    );
  }
  assertStrictJson(response, "response.create overrides", { maxBytes: MAX_SESSION_BYTES });
  if (encodedBytes(JSON.stringify(response)) > MAX_SESSION_BYTES) {
    throw new ProviderAdapterError("response_create_too_large", "response.create overrides are too large");
  }
  return deepFreeze({ type: "response.create", response: structuredClone(response) });
}

export function buildResponseCancelEvent(responseId = undefined) {
  return deepFreeze({
    type: "response.cancel",
    ...(responseId === undefined ? {} : { response_id: requireOpaqueId(responseId, "cancelled response id") }),
  });
}

export function buildConversationItemTruncateEvent({ itemId, contentIndex = 0, audioEndMs }) {
  const boundedItemId = requireOpaqueId(itemId, "truncated item id");
  if (!Number.isSafeInteger(contentIndex) || contentIndex < 0) {
    throw new ProviderAdapterError("invalid_truncate", "contentIndex must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(audioEndMs) || audioEndMs < 0) {
    throw new ProviderAdapterError("invalid_truncate", "audioEndMs must be a non-negative safe integer");
  }
  return Object.freeze({
    type: "conversation.item.truncate",
    item_id: boundedItemId,
    content_index: contentIndex,
    audio_end_ms: audioEndMs,
  });
}

function validateTelephonySession(provider, session, model, allowedClientTools) {
  if (session.model !== undefined && session.model !== model) {
    throw configError("session.update model conflicts with the WebSocket model");
  }
  const audio = record(session.audio);
  const inputAudio = record(audio.input);
  const outputAudio = record(audio.output);
  const inputFormat = record(inputAudio.format);
  const outputFormat = record(outputAudio.format);
  if (inputFormat.type !== "audio/pcmu" || outputFormat.type !== "audio/pcmu") {
    throw configError("Direct Twilio bridge sessions require audio/pcmu input and output");
  }
  if (provider === "xai") {
    if ((inputAudio.transport !== undefined && inputAudio.transport !== "json") ||
        (outputAudio.transport !== undefined && outputAudio.transport !== "json")) {
      throw configError("Direct xAI Twilio bridge sessions require JSON audio transport");
    }
    if ((inputFormat.rate !== undefined && inputFormat.rate !== 8_000) ||
        (outputFormat.rate !== undefined && outputFormat.rate !== 8_000)) {
      throw configError("xAI PCMU bridge sessions must use 8000 Hz");
    }
  }
  if (session.tools !== undefined) {
    if (!Array.isArray(session.tools) || session.tools.length > 64) throw configError("Realtime tools must be an array of at most 64 entries");
    const names = new Set();
    for (const [index, tool] of session.tools.entries()) {
      if (!isRecord(tool) || tool.type !== "function") {
        throw configError(`Realtime tool ${index} must be a bridge-mediated function declaration`);
      }
      if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) {
        throw configError(`Realtime tool ${index} has an invalid function name`);
      }
      if (!allowedClientTools.has(tool.name)) {
        throw configError(`Realtime function ${tool.name} is not in the bridge client-tool allowlist`);
      }
      if (names.has(tool.name)) throw configError(`Realtime function ${tool.name} is duplicated`);
      names.add(tool.name);
      if (tool.description !== undefined && typeof tool.description !== "string") {
        throw configError(`Realtime function ${tool.name} description must be a string`);
      }
      if (tool.parameters !== undefined && !isRecord(tool.parameters)) {
        throw configError(`Realtime function ${tool.name} parameters must be a JSON Schema object`);
      }
      if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
        throw configError(`Realtime function ${tool.name} strict must be a boolean`);
      }
      const allowedFields = new Set(["type", "name", "description", "parameters", "strict"]);
      if (Object.keys(tool).some((key) => !allowedFields.has(key))) {
        throw configError(`Realtime function ${tool.name} contains unsupported fields`);
      }
    }
  }
}

function normalizeAllowedClientTools(candidate) {
  const values = candidate === undefined
    ? ["capability_gateway"]
    : candidate instanceof Set ? [...candidate] : Array.isArray(candidate) ? candidate : undefined;
  if (!values || values.length > 64) {
    throw configError("allowedClientTools must be an array or Set of at most 64 names");
  }
  const result = new Set();
  for (const name of values) {
    if (typeof name !== "string" || !TOOL_NAME.test(name)) {
      throw configError("allowedClientTools contains an invalid function name");
    }
    if (result.has(name)) throw configError(`allowedClientTools repeats ${name}`);
    result.add(name);
  }
  return result;
}

function configurationEvidence(provider, model, requested, acknowledged) {
  const requestedProjection = sessionProjection(provider, model, requested);
  // xAI selects and authenticates the model in the already-pinned WebSocket
  // URL and does not consistently repeat it in session.updated.
  const acknowledgedProjection = sessionProjection(provider, provider === "xai" ? model : undefined, acknowledged);
  const fields = {};
  for (const key of Object.keys(requestedProjection)) {
    const wanted = requestedProjection[key];
    const hasAcknowledgement = Object.hasOwn(acknowledgedProjection, key);
    const got = acknowledgedProjection[key];
    fields[key] = Object.freeze({
      status: !hasAcknowledgement ? "unverifiable" : canonicalJson(wanted) === canonicalJson(got) ? "verified" : "mismatch",
      requestedSha256: fingerprint(wanted),
      ...(hasAcknowledgement ? { acknowledgedSha256: fingerprint(got) } : {}),
    });
  }
  const acknowledgedSessionProjection = projectOntoRequestedShape(requested, acknowledged);
  const unexpectedAuthorityFields = unexpectedAuthorityConfiguration(requested, acknowledged);
  const sessionStatus = !acknowledgedSessionProjection.complete
    ? "unverifiable"
    : canonicalJson(requested) === canonicalJson(acknowledgedSessionProjection.value) ? "verified" : "mismatch";
  return deepFreeze({
    strictParityVerified: sessionStatus === "verified"
      && Object.values(fields).every((field) => field.status === "verified")
      && unexpectedAuthorityFields.length === 0,
    session: {
      status: sessionStatus,
      requestedSha256: fingerprint(requested),
      ...(acknowledgedSessionProjection.complete ? { acknowledgedSha256: fingerprint(acknowledgedSessionProjection.value) } : {}),
    },
    fields,
    unexpectedAuthorityFields,
  });
}

function unexpectedAuthorityConfiguration(requested, acknowledged) {
  const unexpected = [];
  for (const key of ["instructions", "prompt"]) {
    if (!Object.hasOwn(requested, key) && acknowledged[key] !== undefined) unexpected.push(key);
  }
  if (!Object.hasOwn(requested, "tools") && acknowledged.tools !== undefined) {
    if (!Array.isArray(acknowledged.tools) || acknowledged.tools.length > 0) unexpected.push("tools");
  }
  if (!Object.hasOwn(requested, "tool_choice") && acknowledged.tool_choice !== undefined) {
    const tools = Array.isArray(acknowledged.tools) ? acknowledged.tools : [];
    if (tools.length > 0 || acknowledged.tool_choice !== "auto" && acknowledged.tool_choice !== "none") {
      unexpected.push("tool_choice");
    }
  }
  return unexpected.sort();
}

function projectOntoRequestedShape(requested, acknowledged) {
  if (requested === null || typeof requested !== "object") {
    return { complete: acknowledged !== undefined, value: acknowledged };
  }
  if (Array.isArray(requested)) {
    if (!Array.isArray(acknowledged) || acknowledged.length !== requested.length) {
      return { complete: false, value: undefined };
    }
    const entries = requested.map((entry, index) => projectOntoRequestedShape(entry, acknowledged[index]));
    return { complete: entries.every((entry) => entry.complete), value: entries.map((entry) => entry.value) };
  }
  if (!isRecord(acknowledged)) return { complete: false, value: undefined };
  const value = {};
  let complete = true;
  for (const [key, entry] of Object.entries(requested)) {
    if (!Object.hasOwn(acknowledged, key)) {
      complete = false;
      continue;
    }
    const projected = projectOntoRequestedShape(entry, acknowledged[key]);
    complete &&= projected.complete;
    value[key] = projected.value;
  }
  return { complete, value };
}

function sessionProjection(provider, fallbackModel, session) {
  const audio = record(session.audio);
  const inputAudio = record(audio.input);
  const outputAudio = record(audio.output);
  const result = {};
  const values = {
    model: session.model ?? fallbackModel,
    voice: provider === "openai" ? outputAudio.voice : session.voice,
    instructions: session.instructions,
    tools: session.tools,
    tool_choice: session.tool_choice,
    input_audio: inputAudio.format,
    output_audio: outputAudio.format,
    turn_detection: provider === "openai" ? inputAudio.turn_detection : session.turn_detection,
  };
  for (const [key, value] of Object.entries(values)) if (value !== undefined) result[key] = value;
  return result;
}

function eventResponseId(event) {
  const outer = event.response_id;
  const inner = record(event.response).id;
  if (outer !== undefined && inner !== undefined && outer !== inner) {
    return eventError("response_id_conflict", "Provider event contains conflicting outer and inner response ids");
  }
  const value = outer ?? inner;
  if (value === undefined) return undefined;
  try { return requireOpaqueId(value, "response id"); }
  catch (error) { return error; }
}

function eventItemId(event) {
  const outer = event.item_id;
  const inner = record(event.item).id;
  if (outer !== undefined && inner !== undefined && outer !== inner) {
    return eventError("item_id_conflict", "Provider event contains conflicting outer and inner item ids");
  }
  const value = outer ?? inner;
  if (value === undefined) return undefined;
  try { return requireOpaqueId(value, "item id"); }
  catch (error) { return error; }
}

function requiresSessionAcknowledgement(wireType) {
  return wireType.startsWith("response.")
    || wireType.startsWith("input_audio_buffer.speech_")
    || wireType.startsWith("conversation.item.input_audio_transcription.")
    || wireType === "conversation.item.truncated";
}

function requiresStartedResponse(wireType) {
  return wireType.startsWith("response.") && wireType !== "response.created";
}

function isResponseScopedWireEvent(wireType) {
  return wireType.startsWith("response.") || wireType === "conversation.item.truncated";
}

function isProviderManagedToolEvent(wireType) {
  return /(?:^|[._])(?:mcp|web_search|file_search|computer|code_interpreter|image_generation|shell|custom_tool)(?:[._]|$)/.test(wireType);
}

function isUnsupportedToolItemType(type) {
  return typeof type === "string" && type !== "function_call" && /(?:^|_)call(?:$|_)/.test(type);
}

function optionalIdentity(value, label, maximum = 512) {
  if (value === undefined) return undefined;
  try { return boundedIdentity(value, label, maximum); }
  catch (error) { return error; }
}

function boundedIdentity(value, label, maximum = 512) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum ||
      value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw configError(`${label} must be a canonical string of at most ${maximum} characters`);
  }
  return value;
}

function requireOpaqueId(value, label) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw eventError("invalid_provider_identity", `${label} must be a canonical ASCII token of at most 512 characters`);
  }
  return value;
}

function requireToolName(value, label) {
  if (typeof value !== "string" || !TOOL_NAME.test(value)) {
    throw eventError("invalid_tool_name", `${label} is invalid`);
  }
  return value;
}

function canonicalBase64(value, label) {
  if (typeof value !== "string" || value.length < 1 || encodedBytes(value) > MAX_WIRE_EVENT_BYTES ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw eventError("invalid_audio", `${label} is not canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw eventError("invalid_audio", `${label} is not canonical base64`);
  return value;
}

function boundedText(value, label, maximumBytes) {
  if (typeof value !== "string" || encodedBytes(value) > maximumBytes) {
    throw eventError("invalid_text", `${label} must be a string of at most ${maximumBytes} bytes`);
  }
  return value;
}

function boundedOptionalText(value, maximumBytes = 2_000) {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value.slice(0, maximumBytes) : undefined;
}

function optionalNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function assertStrictJson(value, path, options = {}) {
  if (!isRecord(options) || Object.keys(options).some((key) => key !== "maxBytes")) {
    throw new ProviderAdapterError("invalid_json_limits", "JSON validation limits are invalid");
  }
  const maxBytes = options.maxBytes ?? MAX_SESSION_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SESSION_BYTES) {
    throw new ProviderAdapterError("invalid_json_limits", "JSON byte limit is invalid");
  }
  visitStrictJson(value, path, new WeakSet(), 0, { nodes: 0, bytes: 0, maxBytes });
}

function visitStrictJson(value, path, ancestors, depth, state) {
  state.nodes += 1;
  if (state.nodes > 65_536) throw new ProviderAdapterError("json_too_complex", `${path} exceeds 65536 values`);
  if (depth > 64) throw new ProviderAdapterError("json_too_deep", `${path} exceeds 64 levels`);
  if (value === null || typeof value === "boolean") {
    addStrictJsonBytes(state, value === null ? 4 : value ? 4 : 5, path);
    return;
  }
  if (typeof value === "string") {
    if (encodedBytes(value) > 256 * 1024) throw new ProviderAdapterError("json_string_too_large", `${path} contains an oversized string`);
    addStrictJsonBytes(state, encodedBytes(JSON.stringify(value)), path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProviderAdapterError("invalid_json", `${path} contains a non-finite number`);
    addStrictJsonBytes(state, encodedBytes(JSON.stringify(value)), path);
    return;
  }
  if (typeof value !== "object") throw new ProviderAdapterError("invalid_json", `${path} contains a non-JSON value`);
  if (ancestors.has(value)) throw new ProviderAdapterError("invalid_json", `${path} contains a cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new ProviderAdapterError("invalid_json", `${path} contains a non-JSON object`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (value.length > 16_384) throw new ProviderAdapterError("json_too_complex", `${path} array is too long`);
    const enumerable = Object.keys(value);
    if (enumerable.length !== value.length || enumerable.some((key, index) => key !== String(index)) ||
        Reflect.ownKeys(value).some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key)))) {
      throw new ProviderAdapterError("invalid_json", `${path} must be a dense JSON array without extra properties`);
    }
    addStrictJsonBytes(state, 2 + Math.max(0, value.length - 1), path);
    for (let index = 0; index < value.length; index += 1) {
      visitStrictJson(value[index], `${path}[${index}]`, ancestors, depth + 1, state);
    }
  } else {
    const keys = Reflect.ownKeys(value);
    if (keys.length > 1_024) throw new ProviderAdapterError("json_too_complex", `${path} object has too many keys`);
    addStrictJsonBytes(state, 2 + Math.max(0, keys.length - 1), path);
    for (const key of keys) {
      if (typeof key !== "string") throw new ProviderAdapterError("invalid_json", `${path} contains a symbol key`);
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new ProviderAdapterError("unsafe_json_key", `${path} contains unsafe key ${key}`);
      }
      if (encodedBytes(key) > 1_024) throw new ProviderAdapterError("invalid_json", `${path} contains an oversized key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new ProviderAdapterError("invalid_json", `${path}.${key} must be an enumerable data property`);
      }
      addStrictJsonBytes(state, encodedBytes(JSON.stringify(key)) + 1, path);
      visitStrictJson(descriptor.value, `${path}.${key}`, ancestors, depth + 1, state);
    }
  }
  ancestors.delete(value);
}

function addStrictJsonBytes(state, bytes, path) {
  state.bytes += bytes;
  if (!Number.isSafeInteger(state.bytes) || state.bytes > state.maxBytes) {
    throw new ProviderAdapterError("json_too_large", `${path} exceeds ${state.maxBytes} bytes`);
  }
}

function deepFreeze(root) {
  const pending = [root];
  const seen = new WeakSet();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) if (child && typeof child === "object") pending.push(child);
    Object.freeze(value);
  }
  return root;
}

function callIdentityFingerprint(call) {
  return fingerprint({
    responseId: call.responseId,
    itemId: call.itemId,
    name: call.name,
    argumentsText: call.argumentsText,
  });
}

function fingerprint(value) {
  return createHash("sha256").update("hacc/provider-wire/v1\0").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function omit(recordValue, keyToOmit) {
  return Object.fromEntries(Object.entries(recordValue).filter(([key]) => key !== keyToOmit));
}

function record(value) {
  return isRecord(value) ? value : {};
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodedBytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error ?? "Unknown provider error")).slice(0, 2_000);
}

function configError(message) {
  return new ProviderAdapterError("invalid_provider_config", message);
}

function eventError(code, message, fatal = true) {
  return new ProviderAdapterError(code, message, { fatal });
}

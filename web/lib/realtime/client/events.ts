import { createHash } from "node:crypto";
import { base64ToPcm16 } from "./audio";
import type {
  NormalizedRealtimeEvent,
  NormalizedRealtimeUsage,
  Pcm16Format,
  RealtimeResponseTerminalStatus,
  RealtimeToolCall,
  ServerRealtimeProvider,
} from "./types";

const DEFAULT_MAX_WIRE_EVENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TRACKED_IDENTITIES = 10_000;
const TERMINAL_WIRE_TYPES = new Set([
  "response.done",
  "response.completed",
  "response.cancelled",
  "response.failed",
  "response.incomplete",
]);

export type WireEventParseResult =
  | { ok: true; event: Record<string, unknown> }
  | { ok: false; code: "unsupported_wire_data" | "wire_event_too_large" | "invalid_json" | "invalid_event"; message: string };

/** Parses a WebSocket frame without throwing or coercing arbitrary objects. */
export function safeParseWireEvent(
  data: unknown,
  maximumBytes = DEFAULT_MAX_WIRE_EVENT_BYTES,
): WireEventParseResult {
  const encoded = wireData(data);
  if (!encoded) {
    return { ok: false, code: "unsupported_wire_data", message: "Realtime WebSocket sent unsupported frame data" };
  }
  if (encoded.byteLength > maximumBytes) {
    return {
      ok: false,
      code: "wire_event_too_large",
      message: `Realtime WebSocket event exceeded ${maximumBytes} bytes`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded.text);
  } catch {
    return { ok: false, code: "invalid_json", message: "Realtime WebSocket sent invalid JSON" };
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string" || !parsed.type) {
    return { ok: false, code: "invalid_event", message: "Realtime WebSocket event needs a non-empty type" };
  }
  return { ok: true, event: parsed };
}

type PendingToolCall = {
  callId: string;
  name: string;
  argumentsText: string;
  itemId?: string;
  responseId: string;
  order: number;
  completionObserved: boolean;
  completionRejected: boolean;
  cancellationEmitted: boolean;
  finalArgumentsText?: string;
  identityConflict?: string;
};

type SettledToolCall = Readonly<{
  callId: string;
  name: string;
  argumentsText: string;
  itemId?: string;
  responseId: string;
  terminalEventId?: string;
  terminalWireType: string;
}>;

type TerminalResponse = Readonly<{
  fingerprint: string;
  terminalEventId?: string;
  terminalWireType: string;
}>;

export type OpenAICompatibleNormalizerOptions = {
  provider: Extract<ServerRealtimeProvider, "openai" | "xai">;
  outputAudioFormat: Pcm16Format;
  now?: () => number;
  xaiResumptionEnabled?: boolean;
  /** Emit otherwise-unhandled wire events through the typed escape hatch. */
  includeProviderEvents?: boolean;
  /** Fail closed instead of evicting identities and permitting unsafe reuse. */
  maximumTrackedIdentities?: number;
};

/** Stateful because xAI transcripts are cumulative and tool calls can arrive in batches. */
export class OpenAICompatibleEventNormalizer {
  private readonly now: () => number;
  private readonly inputTranscripts = new Map<string, string>();
  private readonly outputTranscripts = new Map<string, string>();
  private readonly pendingCalls = new Map<string, PendingToolCall>();
  private readonly settledCalls = new Map<string, SettledToolCall>();
  private readonly nativeEvents = new Map<string, string>();
  private readonly terminalResponses = new Map<string, TerminalResponse>();
  private readonly responseByItemId = new Map<string, string>();
  private readonly callByItemId = new Map<string, string>();
  private readonly startedResponses = new Map<string, string>();
  private readonly trackedIdentities = new Set<string>();
  private readonly maximumTrackedIdentities: number;
  private identityErrors: Array<{ code: string; message: string }> = [];
  private callOrder = 0;

  constructor(private readonly options: OpenAICompatibleNormalizerOptions) {
    this.now = options.now ?? Date.now;
    const maximum = options.maximumTrackedIdentities ?? DEFAULT_MAX_TRACKED_IDENTITIES;
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new Error("maximumTrackedIdentities must be a positive integer");
    }
    this.maximumTrackedIdentities = maximum;
  }

  normalize(event: Record<string, unknown>): NormalizedRealtimeEvent[] {
    const wireType = String(event.type);
    const nativeEventId = string(event.event_id);
    const base = {
      provider: this.options.provider,
      receivedAtMs: this.now(),
      wireType,
      ...optional("nativeEventId", nativeEventId),
    } as const;

    this.identityErrors = [];
    if (event.event_id !== undefined) {
      const invalidNativeEventId = providerIdentityTokenError(event.event_id);
      if (invalidNativeEventId) {
        return [protocolError(
          base,
          "invalid_native_event_id",
          `Provider event_id ${invalidNativeEventId}`,
          true,
        )];
      }
    }
    if (nativeEventId) {
      const capacityError = this.reserveIdentity("event", nativeEventId);
      if (capacityError) {
        return [protocolError(base, "provider_identity_capacity_exceeded", capacityError, true)];
      }
      const fingerprint = fingerprintJson(omitKey(event, "event_id"));
      const prior = this.nativeEvents.get(nativeEventId);
      if (prior === fingerprint) return [];
      if (prior !== undefined) {
        return [protocolError(
          base,
          "native_event_id_conflict",
          `Provider event id ${nativeEventId} was reused with different contents`,
          true,
        )];
      }
      this.nativeEvents.set(nativeEventId, fingerprint);
    }

    const responseIdentity = resolveRedundantIdentity("response", [
      ["response_id", event.response_id],
      ["response.id", record(event.response).id],
    ]);
    if (responseIdentity.error) {
      return [protocolError(base, "response_id_conflict", responseIdentity.error, true)];
    }
    const explicitResponseId = responseIdentity.value;
    if (explicitResponseId) {
      const capacityError = this.reserveIdentity("response", explicitResponseId);
      if (capacityError) {
        return [protocolError(base, "provider_identity_capacity_exceeded", capacityError, true)];
      }
    }

    const itemIdentity = resolveRedundantIdentity("response item", [
      ["item_id", event.item_id],
      ["item.id", record(event.item).id],
    ]);
    if (itemIdentity.error) {
      return [protocolError(base, "response_item_id_conflict", itemIdentity.error, true)];
    }
    const responseItemId = wireType.startsWith("response.") ? itemIdentity.value : undefined;
    if (responseItemId) {
      const capacityError = this.reserveIdentity("item", responseItemId);
      if (capacityError) {
        return [protocolError(base, "provider_identity_capacity_exceeded", capacityError, true)];
      }
    }
    const itemResponseId = responseItemId
      ? this.responseByItemId.get(responseItemId)
      : undefined;
    if (responseItemId && explicitResponseId && itemResponseId && itemResponseId !== explicitResponseId) {
      return [protocolError(
        base,
        "response_item_id_conflict",
        `Response item id ${responseItemId} was reused across responses ${itemResponseId} and ${explicitResponseId}`,
        true,
      )];
    }
    if (responseItemId && explicitResponseId && !itemResponseId) {
      this.responseByItemId.set(responseItemId, explicitResponseId);
    }
    // Some provider deltas omit response_id after the first event. Item
    // provenance lets us still reject a delayed event after its response has
    // reached a terminal state, without guessing when neither identity exists.
    const scopedResponseId = explicitResponseId ?? itemResponseId;
    if (wireType.startsWith("response.") && !scopedResponseId) {
      return [protocolError(base, "missing_response_id", `${wireType} omitted its response provenance`, true)];
    }
    if (
      scopedResponseId
      && this.terminalResponses.has(scopedResponseId)
      && !TERMINAL_WIRE_TYPES.has(wireType)
    ) {
      return [protocolError(
        base,
        "stale_response_event",
        `Provider emitted ${wireType} after response ${scopedResponseId} was terminal`,
        true,
      )];
    }

    switch (wireType) {
      case "session.updated": {
        const session = record(event.session);
        return [{ ...base, type: "session.ready", ...optional("sessionId", string(session.id) ?? string(event.session_id)) }];
      }
      case "conversation.created": {
        if (this.options.provider !== "xai") return this.providerEvent(event, base);
        const conversationId = string(record(event.conversation).id);
        if (!conversationId) {
          return [protocolError(base, "invalid_conversation_id", "xAI conversation.created did not include an id")];
        }
        return [{
          ...base,
          type: "session.resumption",
          handle: conversationId,
          conversationId,
          resumable: this.options.xaiResumptionEnabled === true,
        }];
      }
      case "response.created": {
        const id = explicitResponseId!;
        const startFingerprint = fingerprintJson(omitKey(event, "event_id"));
        const priorStart = this.startedResponses.get(id);
        if (priorStart === startFingerprint) return [];
        if (priorStart !== undefined) {
          return [protocolError(
            base,
            "response_id_conflict",
            `Started response id ${id} was reused with different contents`,
            true,
          )];
        }
        this.startedResponses.set(id, startFingerprint);
        return [{ ...base, type: "response.started", responseId: id }];
      }
      case "conversation.item.input_audio_transcription.delta":
      case "conversation.item.input_audio_transcription.updated": {
        const itemId = string(event.item_id);
        if (itemId) {
          const capacityError = this.reserveIdentity("input-item", itemId);
          if (capacityError) return [protocolError(base, "provider_identity_capacity_exceeded", capacityError, true)];
        }
        const key = itemId ?? "__input__";
        const previous = this.inputTranscripts.get(key) ?? "";
        const incoming = string(event.delta) ?? string(event.transcript) ?? string(event.text) ?? "";
        const cumulative = wireType.endsWith(".updated") || event.cumulative === true;
        const next = cumulative ? incoming : previous + incoming;
        const revised = cumulative && previous.length > 0 && !next.startsWith(previous);
        this.inputTranscripts.set(key, next);
        return [{
          ...base,
          type: "input.transcript",
          phase: "delta",
          text: next,
          ...optional("delta", cumulative ? (next.startsWith(previous) ? next.slice(previous.length) : undefined) : incoming),
          ...optional("itemId", itemId),
          ...optional("revised", revised || undefined),
        }];
      }
      case "conversation.item.input_audio_transcription.completed": {
        const itemId = string(event.item_id);
        if (itemId) {
          const capacityError = this.reserveIdentity("input-item", itemId);
          if (capacityError) return [protocolError(base, "provider_identity_capacity_exceeded", capacityError, true)];
        }
        const key = itemId ?? "__input__";
        const previous = this.inputTranscripts.get(key) ?? "";
        const text = string(event.transcript) ?? string(event.text) ?? previous;
        this.inputTranscripts.set(key, text);
        const result: NormalizedRealtimeEvent[] = [{
          ...base,
          type: "input.transcript",
          phase: "final",
          text,
          ...optional("itemId", itemId),
          ...optional("revised", previous.length > 0 && text !== previous && !text.startsWith(previous) || undefined),
        }];
        const usage = record(event.usage);
        if (Object.keys(usage).length) {
          result.push({
            ...base,
            type: "usage",
            scope: "input_transcription",
            usage: normalizeOpenAICompatibleUsage(usage),
            ...optional("itemId", itemId),
          });
        }
        return result;
      }
      case "conversation.item.input_audio_transcription.failed": {
        const error = record(event.error);
        return [{
          ...base,
          type: "error",
          code: string(error.code) ?? "input_transcription_failed",
          message: string(error.message) ?? "Input audio transcription failed",
          fatal: false,
          details: event,
        }];
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
      case "response.output_text.delta":
      case "response.text.delta": {
        return [this.outputTranscriptDelta(
          event,
          base,
          wireType.includes("text") ? "text" : "audio",
          scopedResponseId!,
          responseItemId,
        )];
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
      case "response.output_text.done":
      case "response.text.done": {
        return [this.outputTranscriptDone(
          event,
          base,
          wireType.includes("text") ? "text" : "audio",
          scopedResponseId!,
          responseItemId,
        )];
      }
      case "response.output_audio.delta":
      case "response.audio.delta": {
        const delta = string(event.delta);
        if (!delta) return [protocolError(base, "invalid_audio_delta", "Provider audio delta was empty")];
        try {
          return [{
            ...base,
            type: "output.audio",
            audio: base64ToPcm16(delta),
            format: this.options.outputAudioFormat,
            ...optional("itemId", responseItemId),
            responseId: scopedResponseId!,
          }];
        } catch (error) {
          return [protocolError(base, "invalid_audio_delta", errorMessage(error))];
        }
      }
      case "response.output_item.added":
      case "response.output_item.done": {
        this.ingestToolItem(
          record(event.item),
          scopedResponseId!,
          wireType === "response.output_item.done",
        );
        return [...this.takeIdentityErrors(base), ...this.providerEvent(event, base)];
      }
      case "response.function_call_arguments.delta": {
        this.ingestArgumentDelta(event, scopedResponseId!);
        return this.takeIdentityErrors(base);
      }
      case "response.function_call_arguments.done": {
        this.ingestArgumentDone(event, scopedResponseId!);
        return this.takeIdentityErrors(base);
      }
      case "response.function_call_arguments.cancelled": {
        const callId = string(event.call_id);
        if (!callId) return [protocolError(base, "missing_tool_call_id", `${wireType} omitted call_id`, true)];
        const pending = this.upsertCall(callId, scopedResponseId!);
        const identityErrors = this.takeIdentityErrors(base);
        if (!pending) return identityErrors;
        // Keep the rejected identity until its response drains. Deleting it
        // here would allow the provider to recycle the same call_id later.
        pending.completionRejected = true;
        pending.cancellationEmitted = true;
        return [...identityErrors, {
          ...base,
          type: "tool.cancelled",
          responseId: scopedResponseId!,
          callIds: [callId],
        }];
      }
      case "conversation.item.truncated": {
        const truncatedItemId = string(event.item_id);
        const interruptedResponseId = explicitResponseId
          ?? (truncatedItemId ? this.responseByItemId.get(truncatedItemId) : undefined);
        if (!interruptedResponseId) {
          return [protocolError(
            base,
            "missing_response_id",
            "conversation.item.truncated could not be bound to a response",
            true,
          )];
        }
        return [{
          ...base,
          type: "turn.interrupted",
          responseId: interruptedResponseId,
          ...optional("reason", string(event.reason)),
        }];
      }
      case "response.done":
      case "response.completed":
      case "response.cancelled":
      case "response.failed":
      case "response.incomplete": {
        const response = record(event.response);
        const id = explicitResponseId!;
        const terminalFingerprint = fingerprintJson(omitKey(event, "event_id"));
        const priorTerminal = this.terminalResponses.get(id);
        if (priorTerminal) {
          if (priorTerminal.fingerprint === terminalFingerprint) return [];
          return [protocolError(
            base,
            "response_id_conflict",
            `Terminal response id ${id} was reused with different contents`,
            true,
          )];
        }
        // Seal the response identity before inspecting its output. If the
        // terminal payload is internally contradictory, a later "corrected"
        // payload must not get a second chance to make work executable.
        this.terminalResponses.set(id, {
          fingerprint: terminalFingerprint,
          terminalEventId: nativeEventId,
          terminalWireType: wireType,
        });
        const nestedStatus = string(response.status);
        const topLevelStatus = string(event.status);
        const forcedStatus = wireType === "response.cancelled"
          ? "cancelled"
          : wireType === "response.failed"
            ? "failed"
            : wireType === "response.incomplete"
              ? "incomplete"
              : undefined;
        const output = Array.isArray(response.output) ? response.output : [];
        if (
          (nestedStatus && topLevelStatus && nestedStatus !== topLevelStatus)
          || (forcedStatus && nestedStatus && nestedStatus !== forcedStatus)
          || (forcedStatus && topLevelStatus && topLevelStatus !== forcedStatus)
        ) {
          return this.rejectSealedTerminal(
            base,
            id,
            nativeEventId,
            wireType,
            "response_terminal_status_conflict",
            `Terminal response ${id} supplied contradictory status fields`,
            output,
          );
        }
        const rawStatus = forcedStatus ?? nestedStatus ?? topLevelStatus;
        const status = openAICompatibleTerminalStatus(rawStatus);
        const terminalToolCallIds = new Set<string>();
        for (const candidate of output) {
          const item = record(candidate);
          if (item.type !== "function_call") continue;
          const callId = string(item.call_id);
          const invalidCallId = providerIdentityTokenError(item.call_id);
          if (!callId || invalidCallId) {
            return this.rejectSealedTerminal(
              base,
              id,
              nativeEventId,
              wireType,
              "invalid_tool_call_batch",
              `Terminal response ${id} contained a function call whose call_id ${invalidCallId ?? "was absent"}`,
              output,
            );
          }
          if (terminalToolCallIds.has(callId)) {
            return this.rejectSealedTerminal(
              base,
              id,
              nativeEventId,
              wireType,
              "invalid_tool_call_batch",
              `Terminal response ${id} repeated function call id ${callId}`,
              output,
            );
          }
          terminalToolCallIds.add(callId);
        }
        const omittedPendingCallIds = status === "completed"
          ? [...this.pendingCalls.values()]
            .filter((call) => (
              call.responseId === id
              && !call.cancellationEmitted
              && !terminalToolCallIds.has(call.callId)
            ))
            .map((call) => call.callId)
          : [];
        if (omittedPendingCallIds.length) {
          return this.rejectSealedTerminal(
            base,
            id,
            nativeEventId,
            wireType,
            "tool_call_terminal_membership_mismatch",
            `Terminal response ${id} omitted pending function call(s): ${omittedPendingCallIds.join(", ")}`,
            output,
          );
        }
        const outputItemIds = new Set<string>();
        for (const item of output) {
          const outputItemId = string(record(item).id);
          if (!outputItemId) continue;
          const capacityError = this.reserveIdentity("item", outputItemId);
          if (capacityError) {
            return this.rejectSealedTerminal(
              base,
              id,
              nativeEventId,
              wireType,
              "provider_identity_capacity_exceeded",
              capacityError,
              output,
            );
          }
          if (outputItemIds.has(outputItemId)) {
            return this.rejectSealedTerminal(
              base,
              id,
              nativeEventId,
              wireType,
              "response_item_id_conflict",
              `Terminal response ${id} repeated output item id ${outputItemId}`,
              output,
            );
          }
          outputItemIds.add(outputItemId);
          const priorItemResponseId = this.responseByItemId.get(outputItemId);
          if (priorItemResponseId && priorItemResponseId !== id) {
            return this.rejectSealedTerminal(
              base,
              id,
              nativeEventId,
              wireType,
              "response_item_id_conflict",
              `Response item id ${outputItemId} was reused across responses ${priorItemResponseId} and ${id}`,
              output,
            );
          }
        }
        for (const outputItemId of outputItemIds) this.responseByItemId.set(outputItemId, id);
        for (const item of output) this.ingestToolItem(record(item), id, true);

        const result: NormalizedRealtimeEvent[] = [];
        const identityErrors = this.takeIdentityErrors(base);
        const { calls, cancelledCallIds, errors } = this.drainCalls(id, nativeEventId, wireType);
        const invalidCompletedBatch = status === "completed"
          && (identityErrors.length > 0 || errors.length > 0 || cancelledCallIds.length > 0);
        result.push(...identityErrors);
        result.push(...errors.map((message) => protocolError(base, "invalid_tool_call", message, true)));
        if (invalidCompletedBatch) {
          result.push(protocolError(
            base,
            "invalid_tool_call_batch",
            `Terminal response ${id} contained at least one invalid function call; no sibling call is executable`,
            true,
          ));
        } else if (calls.length && status === "completed") {
          result.push({ ...base, type: "tool.calls", calls, responseId: id });
        }
        const cancelled = status === "completed"
          ? invalidCompletedBatch
            ? [...cancelledCallIds, ...calls.map((call) => call.callId)]
            : cancelledCallIds
          : [...cancelledCallIds, ...calls.map((call) => call.callId)];
        if (cancelled.length) {
          // Argument-done events are also emitted for interrupted/incomplete
          // responses. Never surface those calls as executable work.
          result.push({
            ...base,
            type: "tool.cancelled",
            responseId: id,
            callIds: [...new Set(cancelled)],
          });
        }

        const usageRecord = record(response.usage ?? event.usage);
        if (Object.keys(usageRecord).length || this.options.provider === "xai") {
          result.push({
            ...base,
            type: "usage",
            scope: "response",
            usage: normalizeOpenAICompatibleUsage(usageRecord),
            responseId: id,
          });
        }
        if (!status) {
          result.push(protocolError(
            base,
            "invalid_response_terminal_status",
            `${wireType} supplied unsupported terminal status ${JSON.stringify(rawStatus)}`,
            true,
          ));
          return result;
        }
        const reason = string(record(response.status_details).reason)
          ?? string(record(event.status_details).reason)
          ?? string(event.reason);
        result.push({
          ...base,
          type: "response.completed",
          responseId: id,
          status,
          ...optional("reason", reason),
        });
        return result;
      }
      case "error": {
        const error = record(event.error);
        return [{
          ...base,
          type: "error",
          code: string(error.code) ?? string(error.type),
          message: string(error.message) ?? "Realtime provider returned an error",
          fatal: false,
          details: event,
        }];
      }
      case "rate_limits.updated":
      case "session.created":
      case "conversation.item.created":
      case "input_audio_buffer.committed":
        return [{
          ...base,
          type: "input.audio_commit_acknowledgement",
          ...optional("itemId", string(event.item_id)),
        }];
      case "input_audio_buffer.speech_started":
        return [{
          ...base,
          type: "input.speech_activity",
          phase: "started",
          ...optional("itemId", string(event.item_id)),
          ...optional("audioOffsetMs", number(event.audio_start_ms)),
        }];
      case "input_audio_buffer.speech_stopped":
        return [{
          ...base,
          type: "input.speech_activity",
          phase: "stopped",
          ...optional("itemId", string(event.item_id)),
          ...optional("audioOffsetMs", number(event.audio_end_ms)),
        }];
      case "input_audio_buffer.cleared":
      case "response.output_audio.done":
      case "response.audio.done":
        return this.providerEvent(event, base);
      default:
        return this.providerEvent(event, base);
    }
  }

  private outputTranscriptDelta(
    event: Record<string, unknown>,
    base: Pick<NormalizedRealtimeEvent, "provider" | "receivedAtMs" | "wireType">,
    source: "audio" | "text",
    id: string,
    itemId?: string,
  ): NormalizedRealtimeEvent {
    const key = itemId ?? id;
    const previous = this.outputTranscripts.get(key) ?? "";
    const incoming = string(event.delta) ?? string(event.transcript) ?? string(event.text) ?? "";
    const cumulative = event.cumulative === true;
    const next = cumulative ? incoming : previous + incoming;
    const revised = cumulative && previous.length > 0 && !next.startsWith(previous);
    this.outputTranscripts.set(key, next);
    return {
      ...base,
      type: "output.transcript",
      phase: "delta",
      source,
      text: next,
      ...optional("delta", cumulative ? (next.startsWith(previous) ? next.slice(previous.length) : undefined) : incoming),
      ...optional("itemId", itemId),
      responseId: id,
      ...optional("revised", revised || undefined),
    };
  }

  private outputTranscriptDone(
    event: Record<string, unknown>,
    base: Pick<NormalizedRealtimeEvent, "provider" | "receivedAtMs" | "wireType">,
    source: "audio" | "text",
    id: string,
    itemId?: string,
  ): NormalizedRealtimeEvent {
    const key = itemId ?? id;
    const previous = this.outputTranscripts.get(key) ?? "";
    const text = string(event.transcript) ?? string(event.text) ?? previous;
    this.outputTranscripts.set(key, text);
    return {
      ...base,
      type: "output.transcript",
      phase: "final",
      source,
      text,
      ...optional("itemId", itemId),
      responseId: id,
      ...optional("revised", previous.length > 0 && text !== previous && !text.startsWith(previous) || undefined),
    };
  }

  private ingestArgumentDelta(event: Record<string, unknown>, id: string): void {
    const callId = string(event.call_id);
    if (!callId) {
      this.identityErrors.push({
        code: "missing_tool_call_id",
        message: "Function-call argument delta omitted call_id",
      });
      return;
    }
    const pending = this.upsertCall(callId, id);
    if (!pending) return;
    if (pending.completionObserved) {
      const delta = string(event.delta) ?? "";
      if (delta) this.recordIdentityConflict(pending, `Function call ${callId} received arguments after completion`);
      return;
    }
    pending.argumentsText += string(event.delta) ?? "";
  }

  private ingestArgumentDone(event: Record<string, unknown>, id: string): void {
    const callId = string(event.call_id);
    if (!callId) {
      this.identityErrors.push({
        code: "missing_tool_call_id",
        message: "Completed function-call arguments omitted call_id",
      });
      return;
    }
    const pending = this.upsertCall(callId, id);
    if (!pending) return;
    this.bindName(pending, string(event.name));
    this.bindItemId(pending, string(event.item_id));
    pending.completionObserved = true;
    const args = string(event.arguments);
    if (args !== undefined) this.bindFinalArguments(pending, args);
  }

  private ingestToolItem(item: Record<string, unknown>, id: string, terminalEvidence = false): void {
    if (item.type !== "function_call") return;
    const callId = string(item.call_id);
    if (!callId) {
      this.identityErrors.push({
        code: "missing_tool_call_id",
        message: `Function-call item ${string(item.id) ?? "<unknown>"} omitted call_id`,
      });
      return;
    }
    const pending = this.upsertCall(callId, id);
    if (!pending) return;
    this.bindName(pending, string(item.name));
    this.bindItemId(pending, string(item.id));
    const rejected = item.status === "incomplete" || item.status === "cancelled" || item.status === "failed";
    const completed = item.status === "completed" || (terminalEvidence && item.status === undefined);
    pending.completionObserved ||= completed;
    pending.completionRejected ||= rejected;
    const args = string(item.arguments);
    if (args !== undefined && (args.length > 0 || pending.argumentsText.length === 0)) {
      if (pending.finalArgumentsText !== undefined || (completed && !rejected)) {
        this.bindFinalArguments(pending, args);
      }
      else if (!pending.finalArgumentsText) pending.argumentsText = args;
    }
  }

  private upsertCall(callId: string, id: string): PendingToolCall | null {
    const invalidCallId = providerIdentityTokenError(callId);
    if (invalidCallId) {
      this.identityErrors.push({
        code: "invalid_tool_call_id",
        message: `Provider tool call id ${invalidCallId}`,
      });
      return null;
    }
    const capacityError = this.reserveIdentity("call", callId);
    if (capacityError) {
      this.identityErrors.push({ code: "provider_identity_capacity_exceeded", message: capacityError });
      return null;
    }
    const settled = this.settledCalls.get(callId);
    if (settled) {
      if (settled.responseId !== id) {
        this.identityErrors.push({
          code: "tool_call_identity_conflict",
          message:
          `Function call id ${callId} was reused by response ${id}; it belongs to ${settled.responseId}`,
        });
      } else {
        this.identityErrors.push({
          code: "tool_call_identity_conflict",
          message:
          `Function call id ${callId} received a delayed event after response ${settled.responseId} was terminal`,
        });
      }
      // A settled call can never become executable a second time. Exact
      // terminal-response retransmissions are deduplicated before ingestion.
      return null;
    }
    const current = this.pendingCalls.get(callId);
    if (current) {
      if (current.responseId && current.responseId !== id) {
        this.recordIdentityConflict(
          current,
          `Function call id ${callId} was reused across responses ${current.responseId} and ${id}`,
        );
      }
      return current;
    }
    const next = {
      callId,
      name: "",
      argumentsText: "",
      responseId: id,
      order: this.callOrder++,
      completionObserved: false,
      completionRejected: false,
      cancellationEmitted: false,
    };
    this.pendingCalls.set(callId, next);
    return next;
  }

  private bindName(call: PendingToolCall, name?: string): void {
    if (!name) return;
    if (call.name && call.name !== name) {
      this.recordIdentityConflict(
        call,
        `Function call id ${call.callId} changed name from ${call.name} to ${name}`,
      );
      return;
    }
    call.name = name;
  }

  private bindItemId(call: PendingToolCall, itemId?: string): void {
    if (!itemId) return;
    const priorCallId = this.callByItemId.get(itemId);
    if (priorCallId !== undefined && priorCallId !== call.callId) {
      const message = `Function-call item id ${itemId} was reused across calls ${priorCallId} and ${call.callId}`;
      this.recordIdentityConflict(call, message);
      const priorCall = this.pendingCalls.get(priorCallId);
      if (priorCall) this.recordIdentityConflict(priorCall, message);
      return;
    }
    if (call.itemId && call.itemId !== itemId) {
      this.recordIdentityConflict(
        call,
        `Function call id ${call.callId} changed item id from ${call.itemId} to ${itemId}`,
      );
      return;
    }
    call.itemId = itemId;
    this.callByItemId.set(itemId, call.callId);
  }

  private bindFinalArguments(call: PendingToolCall, argumentsText: string): void {
    if (call.finalArgumentsText !== undefined && call.finalArgumentsText !== argumentsText) {
      this.recordIdentityConflict(call, `Function call id ${call.callId} changed its terminal arguments`);
      return;
    }
    call.finalArgumentsText = argumentsText;
    // The provider's terminal arguments are authoritative only once. Subsequent
    // delayed events are compared against this immutable value, never applied.
    call.argumentsText = argumentsText;
  }

  private recordIdentityConflict(call: PendingToolCall, message: string): void {
    if (call.identityConflict) return;
    call.identityConflict = message;
    this.identityErrors.push({ code: "tool_call_identity_conflict", message });
  }

  private takeIdentityErrors(
    base: Pick<NormalizedRealtimeEvent, "provider" | "receivedAtMs" | "wireType" | "nativeEventId">,
  ): NormalizedRealtimeEvent[] {
    const errors = this.identityErrors;
    this.identityErrors = [];
    return errors.map(({ code, message }) => protocolError(base, code, message, true));
  }

  private drainCalls(id: string, terminalEventId: string | undefined, terminalWireType: string): {
    calls: RealtimeToolCall[];
    cancelledCallIds: string[];
    errors: string[];
  } {
    const pending = [...this.pendingCalls.values()]
      .filter((call) => call.responseId === id)
      .sort((left, right) => left.order - right.order);
    const calls: RealtimeToolCall[] = [];
    const cancelledCallIds: string[] = [];
    const errors: string[] = [];
    for (const call of pending) {
      this.pendingCalls.delete(call.callId);
      if (!call.completionObserved || call.completionRejected || call.identityConflict) {
        if (call.identityConflict) errors.push(call.identityConflict);
        if (!call.cancellationEmitted) cancelledCallIds.push(call.callId);
        this.settleCall(call, id, terminalEventId, terminalWireType);
        continue;
      }
      if (!call.name) {
        errors.push(`Function call ${call.callId} did not include a name`);
        cancelledCallIds.push(call.callId);
        this.settleCall(call, id, terminalEventId, terminalWireType);
        continue;
      }
      let argumentsJson: unknown;
      try {
        argumentsJson = JSON.parse(call.argumentsText || "{}");
      } catch (error) {
        errors.push(`Function call ${call.callId} had invalid JSON arguments: ${errorMessage(error)}`);
        cancelledCallIds.push(call.callId);
        this.settleCall(call, id, terminalEventId, terminalWireType);
        continue;
      }
      if (!isRecord(argumentsJson)) {
        errors.push(`Function call ${call.callId} arguments must be a JSON object`);
        cancelledCallIds.push(call.callId);
        this.settleCall(call, id, terminalEventId, terminalWireType);
        continue;
      }
      calls.push({
        callId: call.callId,
        name: call.name,
        argumentsText: call.argumentsText || "{}",
        argumentsJson,
        ...optional("itemId", call.itemId),
        responseId: id,
        ...optional("terminalEventId", terminalEventId),
        terminalWireType,
      });
      this.settleCall(call, id, terminalEventId, terminalWireType);
    }
    return { calls, cancelledCallIds, errors };
  }

  private settleCall(
    call: PendingToolCall,
    responseIdValue: string,
    terminalEventId: string | undefined,
    terminalWireType: string,
  ): void {
    this.settledCalls.set(call.callId, Object.freeze({
      callId: call.callId,
      name: call.name,
      argumentsText: call.finalArgumentsText ?? call.argumentsText,
      ...(call.itemId ? { itemId: call.itemId } : {}),
      responseId: responseIdValue,
      ...(terminalEventId ? { terminalEventId } : {}),
      terminalWireType,
    }));
  }

  private rejectSealedTerminal(
    base: Pick<NormalizedRealtimeEvent, "provider" | "receivedAtMs" | "wireType" | "nativeEventId">,
    responseIdValue: string,
    terminalEventId: string | undefined,
    terminalWireType: string,
    code: string,
    message: string,
    output: unknown[],
  ): NormalizedRealtimeEvent[] {
    const result: NormalizedRealtimeEvent[] = [protocolError(base, code, message, true)];
    result.push(...this.takeIdentityErrors(base));
    const drained = this.drainCalls(responseIdValue, terminalEventId, terminalWireType);
    result.push(...drained.errors.map((error) => protocolError(base, "invalid_tool_call", error, true)));
    const terminalOnlyCallIds = output.flatMap((candidate) => {
      const item = record(candidate);
      const callId = string(item.call_id);
      return item.type === "function_call" && callId && !providerIdentityTokenError(callId) ? [callId] : [];
    });
    const cancelled = [...new Set([
      ...drained.cancelledCallIds,
      ...drained.calls.map((call) => call.callId),
      ...terminalOnlyCallIds,
    ])];
    if (cancelled.length) {
      result.push({
        ...base,
        type: "tool.cancelled",
        responseId: responseIdValue,
        callIds: cancelled,
      });
    }
    return result;
  }

  private reserveIdentity(namespace: string, id: string): string | undefined {
    const key = `${namespace}\0${id}`;
    if (this.trackedIdentities.has(key)) return undefined;
    if (this.trackedIdentities.size >= this.maximumTrackedIdentities) {
      return `Provider identity ledger exceeded ${this.maximumTrackedIdentities} unique entries`;
    }
    this.trackedIdentities.add(key);
    return undefined;
  }

  private providerEvent(
    event: Record<string, unknown>,
    base: Pick<NormalizedRealtimeEvent, "provider" | "receivedAtMs" | "wireType">,
  ): NormalizedRealtimeEvent[] {
    return this.options.includeProviderEvents ? [{ ...base, type: "provider.event", data: event }] : [];
  }
}

export function normalizeOpenAICompatibleUsage(usage: Record<string, unknown>): NormalizedRealtimeUsage {
  const input = record(usage.input_token_details ?? usage.input_tokens_details);
  const output = record(usage.output_token_details ?? usage.output_tokens_details);
  const cached = record(input.cached_tokens_details);
  const durationSeconds = number(usage.seconds ?? usage.duration_seconds);
  return compactNumbers({
    inputTextTokens: number(input.text_tokens),
    inputAudioTokens: number(input.audio_tokens),
    cachedInputTokens: number(input.cached_tokens),
    cachedInputTextTokens: number(cached.text_tokens),
    cachedInputAudioTokens: number(cached.audio_tokens),
    outputTextTokens: number(output.text_tokens),
    outputAudioTokens: number(output.audio_tokens),
    totalInputTokens: number(usage.input_tokens),
    totalOutputTokens: number(usage.output_tokens),
    totalTokens: number(usage.total_tokens),
    inputAudioMinutes: number(usage.input_audio_minutes)
      ?? (durationSeconds === undefined ? undefined : durationSeconds / 60),
    outputAudioMinutes: number(usage.output_audio_minutes),
    billableTextInputEvents: number(usage.billable_text_input_events),
    meteringSource: Object.keys(usage).length ? "provider_reported" : undefined,
    raw: usage,
  });
}

function compactNumbers(usage: NormalizedRealtimeUsage): NormalizedRealtimeUsage {
  return Object.fromEntries(
    Object.entries(usage).filter(([, value]) => value !== undefined),
  ) as NormalizedRealtimeUsage;
}

function protocolError(
  base: Pick<NormalizedRealtimeEvent, "provider" | "receivedAtMs" | "wireType" | "nativeEventId">,
  code: string,
  message: string,
  fatal = false,
): NormalizedRealtimeEvent {
  return { ...base, type: "error", code, message, fatal };
}

function wireData(data: unknown): { text: string; byteLength: number } | null {
  if (typeof data === "string") return { text: data, byteLength: Buffer.byteLength(data) };
  if (data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(data);
    return { text: Buffer.from(bytes).toString("utf8"), byteLength: bytes.byteLength };
  }
  if (ArrayBuffer.isView(data)) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return { text: Buffer.from(bytes).toString("utf8"), byteLength: bytes.byteLength };
  }
  if (Array.isArray(data) && data.every(ArrayBuffer.isView)) {
    const bytes = Buffer.concat(data.map((part) => Buffer.from(part.buffer, part.byteOffset, part.byteLength)));
    return { text: bytes.toString("utf8"), byteLength: bytes.byteLength };
  }
  return null;
}

type ResolvedIdentity = Readonly<{ value?: string; error?: string }>;

function resolveRedundantIdentity(
  label: string,
  candidates: ReadonlyArray<readonly [path: string, value: unknown]>,
): ResolvedIdentity {
  let resolved: string | undefined;
  let resolvedPath: string | undefined;
  for (const [path, candidate] of candidates) {
    if (candidate === undefined) continue;
    const invalid = providerIdentityTokenError(candidate);
    if (invalid) return { error: `${label} identity at ${path} ${invalid}` };
    const candidateValue = candidate as string;
    if (resolved !== undefined && candidateValue !== resolved) {
      return {
        error: `${label} identity conflicts between ${resolvedPath} (${resolved}) and ${path} (${candidateValue})`,
      };
    }
    resolved = candidateValue;
    resolvedPath = path;
  }
  return resolved === undefined ? {} : { value: resolved };
}

const PROVIDER_IDENTITY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;

function providerIdentityTokenError(value: unknown): string | undefined {
  if (typeof value !== "string") return "must be a string";
  if (!value) return "cannot be empty";
  if (value.length > 512) return "exceeds 512 characters";
  if (!PROVIDER_IDENTITY_TOKEN.test(value)) {
    return "must be one canonical ASCII token using letters, digits, dot, underscore, colon, or hyphen";
  }
  return undefined;
}

function openAICompatibleTerminalStatus(value: string | undefined): RealtimeResponseTerminalStatus | undefined {
  switch (value) {
    case "completed":
    case "cancelled":
    case "failed":
    case "incomplete":
      return value;
    default:
      return undefined;
  }
}

function omitKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([candidate]) => candidate !== key));
}

function fingerprintJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Stable for JSON-decoded wire values; rejects cycles rather than hiding them. */
function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "undefined") return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value !== "object") return JSON.stringify(String(value));
  if (ancestors.has(value)) throw new TypeError("Realtime event contained a cyclic value");

  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry, nextAncestors)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, nextAncestors)}`).join(",")}}`;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optional<Key extends string, Value>(key: Key, value: Value | undefined): Partial<Record<Key, Value>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, Value>;
}

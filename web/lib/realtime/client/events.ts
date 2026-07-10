import { base64ToPcm16 } from "./audio";
import type {
  NormalizedRealtimeEvent,
  NormalizedRealtimeUsage,
  Pcm16Format,
  RealtimeToolCall,
  ServerRealtimeProvider,
} from "./types";

const DEFAULT_MAX_WIRE_EVENT_BYTES = 16 * 1024 * 1024;

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
  responseId?: string;
  order: number;
  completionObserved: boolean;
  completionRejected: boolean;
};

export type OpenAICompatibleNormalizerOptions = {
  provider: Extract<ServerRealtimeProvider, "openai" | "xai">;
  outputAudioFormat: Pcm16Format;
  now?: () => number;
  xaiResumptionEnabled?: boolean;
  /** Emit otherwise-unhandled wire events through the typed escape hatch. */
  includeProviderEvents?: boolean;
};

/** Stateful because xAI transcripts are cumulative and tool calls can arrive in batches. */
export class OpenAICompatibleEventNormalizer {
  private readonly now: () => number;
  private readonly inputTranscripts = new Map<string, string>();
  private readonly outputTranscripts = new Map<string, string>();
  private readonly pendingCalls = new Map<string, PendingToolCall>();
  private callOrder = 0;

  constructor(private readonly options: OpenAICompatibleNormalizerOptions) {
    this.now = options.now ?? Date.now;
  }

  normalize(event: Record<string, unknown>): NormalizedRealtimeEvent[] {
    const wireType = String(event.type);
    const base = {
      provider: this.options.provider,
      receivedAtMs: this.now(),
      wireType,
    } as const;

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
        return [{ ...base, type: "response.started", ...optional("responseId", responseId(event)) }];
      }
      case "conversation.item.input_audio_transcription.delta":
      case "conversation.item.input_audio_transcription.updated": {
        const itemId = string(event.item_id);
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
        return [this.outputTranscriptDelta(event, base, wireType.includes("text") ? "text" : "audio")];
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
      case "response.output_text.done":
      case "response.text.done": {
        return [this.outputTranscriptDone(event, base, wireType.includes("text") ? "text" : "audio")];
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
            ...optional("itemId", string(event.item_id)),
            ...optional("responseId", responseId(event)),
          }];
        } catch (error) {
          return [protocolError(base, "invalid_audio_delta", errorMessage(error))];
        }
      }
      case "response.output_item.added":
      case "response.output_item.done": {
        this.ingestToolItem(record(event.item), responseId(event));
        return this.providerEvent(event, base);
      }
      case "response.function_call_arguments.delta": {
        this.ingestArgumentDelta(event);
        return [];
      }
      case "response.function_call_arguments.done": {
        this.ingestArgumentDone(event);
        return [];
      }
      case "response.function_call_arguments.cancelled": {
        const callId = string(event.call_id);
        if (callId) this.pendingCalls.delete(callId);
        return callId ? [{ ...base, type: "tool.cancelled", callIds: [callId] }] : [];
      }
      case "response.cancelled":
      case "conversation.item.truncated": {
        return [{
          ...base,
          type: "turn.interrupted",
          ...optional("responseId", responseId(event)),
          ...optional("reason", string(event.reason)),
        }];
      }
      case "response.done":
      case "response.completed": {
        const response = record(event.response);
        const id = string(response.id) ?? responseId(event);
        const status = string(response.status) ?? string(event.status);
        const output = Array.isArray(response.output) ? response.output : [];
        for (const item of output) this.ingestToolItem(record(item), id);

        const result: NormalizedRealtimeEvent[] = [];
        const { calls, cancelledCallIds, errors } = this.drainCalls(id);
        result.push(...errors.map((message) => protocolError(base, "invalid_tool_call", message)));
        if (calls.length && status === "completed") {
          result.push({ ...base, type: "tool.calls", calls, ...optional("responseId", id) });
        }
        const cancelled = status === "completed"
          ? cancelledCallIds
          : [...cancelledCallIds, ...calls.map((call) => call.callId)];
        if (cancelled.length) {
          // Argument-done events are also emitted for interrupted/incomplete
          // responses. Never surface those calls as executable work.
          result.push({ ...base, type: "tool.cancelled", callIds: [...new Set(cancelled)] });
        }

        const usageRecord = record(response.usage ?? event.usage);
        if (Object.keys(usageRecord).length || this.options.provider === "xai") {
          result.push({
            ...base,
            type: "usage",
            scope: "response",
            usage: normalizeOpenAICompatibleUsage(usageRecord),
            ...optional("responseId", id),
          });
        }
        result.push({
          ...base,
          type: "response.completed",
          ...optional("responseId", id),
          ...optional("status", status),
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
  ): NormalizedRealtimeEvent {
    const itemId = string(event.item_id);
    const id = responseId(event);
    const key = itemId ?? id ?? "__output__";
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
      ...optional("responseId", id),
      ...optional("revised", revised || undefined),
    };
  }

  private outputTranscriptDone(
    event: Record<string, unknown>,
    base: Pick<NormalizedRealtimeEvent, "provider" | "receivedAtMs" | "wireType">,
    source: "audio" | "text",
  ): NormalizedRealtimeEvent {
    const itemId = string(event.item_id);
    const id = responseId(event);
    const key = itemId ?? id ?? "__output__";
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
      ...optional("responseId", id),
      ...optional("revised", previous.length > 0 && text !== previous && !text.startsWith(previous) || undefined),
    };
  }

  private ingestArgumentDelta(event: Record<string, unknown>): void {
    const callId = string(event.call_id) ?? string(event.item_id);
    if (!callId) return;
    const pending = this.upsertCall(callId, responseId(event));
    pending.argumentsText += string(event.delta) ?? "";
  }

  private ingestArgumentDone(event: Record<string, unknown>): void {
    const callId = string(event.call_id) ?? string(event.item_id);
    if (!callId) return;
    const pending = this.upsertCall(callId, responseId(event));
    pending.name = string(event.name) ?? pending.name;
    pending.itemId = string(event.item_id) ?? pending.itemId;
    pending.completionObserved = true;
    const args = string(event.arguments);
    if (args !== undefined) pending.argumentsText = args;
  }

  private ingestToolItem(item: Record<string, unknown>, id?: string): void {
    if (item.type !== "function_call") return;
    const callId = string(item.call_id) ?? string(item.id);
    if (!callId) return;
    const pending = this.upsertCall(callId, id);
    pending.name = string(item.name) ?? pending.name;
    pending.itemId = string(item.id) ?? pending.itemId;
    pending.completionObserved ||= item.status === "completed";
    pending.completionRejected ||= item.status === "incomplete" || item.status === "cancelled" || item.status === "failed";
    const args = string(item.arguments);
    if (args !== undefined && (args.length > 0 || pending.argumentsText.length === 0)) pending.argumentsText = args;
  }

  private upsertCall(callId: string, id?: string): PendingToolCall {
    const current = this.pendingCalls.get(callId);
    if (current) {
      current.responseId = id ?? current.responseId;
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
    };
    this.pendingCalls.set(callId, next);
    return next;
  }

  private drainCalls(id?: string): {
    calls: RealtimeToolCall[];
    cancelledCallIds: string[];
    errors: string[];
  } {
    const pending = [...this.pendingCalls.values()]
      .filter((call) => call.responseId === id || call.responseId === undefined || id === undefined)
      .sort((left, right) => left.order - right.order);
    const calls: RealtimeToolCall[] = [];
    const cancelledCallIds: string[] = [];
    const errors: string[] = [];
    for (const call of pending) {
      this.pendingCalls.delete(call.callId);
      if (!call.completionObserved || call.completionRejected) {
        cancelledCallIds.push(call.callId);
        continue;
      }
      if (!call.name) {
        errors.push(`Function call ${call.callId} did not include a name`);
        cancelledCallIds.push(call.callId);
        continue;
      }
      let argumentsJson: unknown;
      try {
        argumentsJson = JSON.parse(call.argumentsText || "{}");
      } catch (error) {
        errors.push(`Function call ${call.callId} had invalid JSON arguments: ${errorMessage(error)}`);
        cancelledCallIds.push(call.callId);
        continue;
      }
      if (!isRecord(argumentsJson)) {
        errors.push(`Function call ${call.callId} arguments must be a JSON object`);
        cancelledCallIds.push(call.callId);
        continue;
      }
      calls.push({
        callId: call.callId,
        name: call.name,
        argumentsText: call.argumentsText || "{}",
        argumentsJson,
        ...optional("itemId", call.itemId),
      });
    }
    return { calls, cancelledCallIds, errors };
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
  base: Pick<NormalizedRealtimeEvent, "provider" | "receivedAtMs" | "wireType">,
  code: string,
  message: string,
): NormalizedRealtimeEvent {
  return { ...base, type: "error", code, message, fatal: false };
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

function responseId(event: Record<string, unknown>): string | undefined {
  return string(event.response_id) ?? string(record(event.response).id);
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

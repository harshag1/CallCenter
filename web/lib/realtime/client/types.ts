/**
 * Provider-neutral contracts for server-side realtime voice clients.
 *
 * Audio crossing this boundary is raw, signed 16-bit little-endian PCM. Keeping
 * the codec explicit prevents a benchmark from accidentally comparing a real
 * audio turn on one provider with text or a containerized audio file on another.
 */

export type ServerRealtimeProvider = "openai" | "xai" | "gemini";

export type Pcm16Format = {
  encoding: "pcm16";
  sampleRateHz: number;
  channels: 1;
};

export type Pcm16Audio = Pcm16Format & {
  /** Interleaving is irrelevant while mono is the only supported format. */
  data: Uint8Array;
};

export type RealtimeToolCall = {
  callId: string;
  name: string;
  argumentsText: string;
  /** `null` means the provider's argument string was not valid JSON. */
  argumentsJson: unknown | null;
  argumentsError?: string;
  itemId?: string;
};

export type RealtimeToolResult = {
  callId: string;
  output: unknown;
};

export type NormalizedRealtimeUsage = {
  inputTextTokens?: number;
  inputAudioTokens?: number;
  cachedInputTokens?: number;
  cachedInputTextTokens?: number;
  cachedInputAudioTokens?: number;
  outputTextTokens?: number;
  outputAudioTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  /** Provider-reported or byte-derived audio meters used by xAI billing. */
  inputAudioMinutes?: number;
  outputAudioMinutes?: number;
  /** Billable user text-message events; function outputs are deliberately excluded. */
  billableTextInputEvents?: number;
  meteringSource?: "provider_reported" | "client_measured" | "mixed";
  /** Provider payload retained for accounting reconciliation. */
  raw: Record<string, unknown>;
};

type EventBase = {
  provider: ServerRealtimeProvider;
  receivedAtMs: number;
  /** Monotonic receipt clock for latency math; absent on legacy adapters. */
  receivedAtMonotonicMs?: number;
  wireType: string;
};

export type NormalizedRealtimeEvent =
  | (EventBase & {
      type: "session.ready";
      sessionId?: string;
    })
  | (EventBase & {
      type: "session.resumption";
      handle: string;
      resumable: boolean;
      conversationId?: string;
    })
  | (EventBase & {
      type: "input.transcript";
      phase: "delta" | "final";
      /** Best current transcript for the item, including cumulative xAI updates. */
      text: string;
      /** Newly appended suffix when one can be derived without guessing. */
      delta?: string;
      itemId?: string;
      revised?: boolean;
    })
  | (EventBase & {
      type: "output.transcript";
      phase: "delta" | "final";
      text: string;
      delta?: string;
      itemId?: string;
      responseId?: string;
      source: "audio" | "text";
      revised?: boolean;
    })
  | (EventBase & {
      type: "output.audio";
      audio: Uint8Array;
      format: Pcm16Format;
      itemId?: string;
      responseId?: string;
    })
  | (EventBase & {
      type: "response.started";
      responseId?: string;
    })
  | (EventBase & {
      type: "response.completed";
      responseId?: string;
      status?: string;
    })
  | (EventBase & {
      /** All calls produced by one model response, in provider order. */
      type: "tool.calls";
      responseId?: string;
      calls: RealtimeToolCall[];
    })
  | (EventBase & {
      type: "tool.cancelled";
      callIds: string[];
    })
  | (EventBase & {
      type: "turn.interrupted";
      responseId?: string;
      reason?: string;
    })
  | (EventBase & {
      type: "usage";
      responseId?: string;
      itemId?: string;
      turnId?: string;
      scope?: "response" | "input_transcription" | "session";
      usage: NormalizedRealtimeUsage;
    })
  | (EventBase & {
      type: "connection.go_away";
      /** Time remaining before the current socket is disconnected. */
      disconnectInMs?: number;
      reason?: string;
    })
  | (EventBase & {
      type: "error";
      message: string;
      code?: string;
      fatal: boolean;
      details?: Record<string, unknown>;
    })
  | (EventBase & {
      type: "connection.closed";
      code?: number;
      reason?: string;
      clean?: boolean;
    })
  | (EventBase & {
      /** Escape hatch for provider lifecycle events without weakening typed core events. */
      type: "provider.event";
      data: Record<string, unknown>;
    });

export type RealtimeEventListener = (event: NormalizedRealtimeEvent) => void;
export type RealtimeWireEventListener = (event: Record<string, unknown>) => void;

/** Minimal EventEmitter-style socket surface implemented by the `ws` package. */
export type RealtimeWebSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): unknown;
};

export type RealtimeWebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => RealtimeWebSocket;

export type RealtimeClientState =
  | "idle"
  | "connecting"
  | "ready"
  | "closing"
  | "closed"
  | "failed";

export interface NormalizedRealtimeClient {
  readonly provider: ServerRealtimeProvider;
  readonly state: RealtimeClientState;
  connect(): Promise<void>;
  close(code?: number, reason?: string): void;
  onEvent(listener: RealtimeEventListener): () => void;
  onWireEvent(listener: RealtimeWireEventListener): () => void;
  appendInputAudio(audio: Pcm16Audio): void;
  commitInputAudio(): void;
  createResponse(overrides?: Record<string, unknown>): void;
  sendTurn(audio: Pcm16Audio | readonly Pcm16Audio[]): void;
  submitToolResults(results: readonly RealtimeToolResult[], createResponse?: boolean): void;
}

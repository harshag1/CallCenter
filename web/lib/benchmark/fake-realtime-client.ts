import { performance } from "node:perf_hooks";
import { sha256Hex } from "./artifacts";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  NormalizedRealtimeUsage,
  Pcm16Audio,
  Pcm16Format,
  RealtimeClientState,
  RealtimeEventListener,
  RealtimeResponsePreparation,
  RealtimeToolCall,
  RealtimeToolResult,
  RealtimeWireEventListener,
  ServerRealtimeProvider,
} from "../realtime/client/types";

export type FakeRealtimeRound = Readonly<{
  transcript?: string;
  outputAudio?: Uint8Array;
  toolCalls?: readonly Readonly<{
    callId: string;
    name: string;
    arguments: Readonly<Record<string, unknown>>;
  }>[];
  usage?: NormalizedRealtimeUsage;
}>;

export type FakeRealtimeTurn = Readonly<{
  turnId: string;
  rounds: readonly FakeRealtimeRound[];
}>;

export type FakeRealtimeScript = Readonly<{
  provider: ServerRealtimeProvider;
  outputFormat: Pcm16Format;
  turns: readonly FakeRealtimeTurn[];
}>;

export type FakeRealtimeClientOptions = Readonly<{
  script: FakeRealtimeScript;
  /** Rendered `<capability_snapshot>` supplied by the orchestrator factory. */
  initialCapabilitySnapshot?: string;
  now?: () => number;
}>;

type NormalizedEventInput<T = NormalizedRealtimeEvent> = T extends NormalizedRealtimeEvent
  ? Omit<T, "provider" | "receivedAtMs" | "receivedAtMonotonicMs" | "wireType">
  : never;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneEvent<T extends NormalizedRealtimeEvent>(event: T): T {
  return deepFreeze(structuredClone(event));
}

function requireIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new Error(`${label} must be a safe non-empty identifier`);
  }
}

function validateScript(script: FakeRealtimeScript): FakeRealtimeScript {
  if (!(["openai", "xai", "gemini"] as const).includes(script.provider)) {
    throw new Error("fake provider is invalid");
  }
  if (
    script.outputFormat.encoding !== "pcm16"
    || script.outputFormat.channels !== 1
    || !Number.isInteger(script.outputFormat.sampleRateHz)
    || script.outputFormat.sampleRateHz <= 0
  ) {
    throw new Error("fake output format must be mono PCM16");
  }
  if (!Array.isArray(script.turns) || script.turns.length === 0) {
    throw new Error("fake script requires at least one turn");
  }
  const turnIds = new Set<string>();
  const callIds = new Set<string>();
  for (const turn of script.turns) {
    requireIdentifier(turn.turnId, "fake turn ID");
    if (turnIds.has(turn.turnId)) throw new Error(`duplicate fake turn ID ${turn.turnId}`);
    turnIds.add(turn.turnId);
    if (!Array.isArray(turn.rounds) || turn.rounds.length === 0) {
      throw new Error(`fake turn ${turn.turnId} requires at least one response round`);
    }
    for (const round of turn.rounds) {
      if (round.transcript !== undefined && (typeof round.transcript !== "string" || round.transcript.includes("\0"))) {
        throw new Error(`fake turn ${turn.turnId} transcript is invalid`);
      }
      if (round.outputAudio !== undefined) {
        if (!(round.outputAudio instanceof Uint8Array) || round.outputAudio.byteLength % 2 !== 0) {
          throw new Error(`fake turn ${turn.turnId} output must contain complete PCM16 samples`);
        }
      }
      for (const call of round.toolCalls ?? []) {
        requireIdentifier(call.callId, "fake tool call ID");
        requireIdentifier(call.name, "fake tool name");
        if (callIds.has(call.callId)) throw new Error(`duplicate fake tool call ID ${call.callId}`);
        callIds.add(call.callId);
        JSON.stringify(call.arguments);
      }
    }
  }
  return deepFreeze(structuredClone(script));
}

/**
 * A deterministic, network-incapable provider used to exercise the exact paid
 * orchestrator path at $0. It intentionally has no URL, socket, fetch, or
 * credential option, so offline tests cannot silently become provider calls.
 */
export class ScriptedFakeRealtimeClient implements NormalizedRealtimeClient {
  readonly provider: ServerRealtimeProvider;
  readonly #script: FakeRealtimeScript;
  readonly #now: () => number;
  readonly #listeners = new Set<RealtimeEventListener>();
  readonly #wireListeners = new Set<RealtimeWireEventListener>();
  #state: RealtimeClientState = "idle";
  #turnIndex = 0;
  #roundIndex = 0;
  #pendingCalls: readonly RealtimeToolCall[] = Object.freeze([]);
  #inputChunks: Pcm16Audio[] = [];
  #inputCommitted = false;
  #responsePrepared = false;
  readonly observedToolResults: RealtimeToolResult[] = [];

  constructor(options: FakeRealtimeClientOptions) {
    this.#script = validateScript(options.script);
    this.provider = this.#script.provider;
    this.#now = options.now ?? (() => performance.now());
    if (options.initialCapabilitySnapshot) this.#ingestCapabilitySnapshot(options.initialCapabilitySnapshot);
  }

  get state(): RealtimeClientState {
    return this.#state;
  }

  async connect(): Promise<void> {
    if (this.#state !== "idle") throw new Error(`fake client cannot connect from ${this.#state}`);
    this.#state = "connecting";
    this.#wire({ type: "fake.session.acknowledged", session_id: "offline-fake-session" });
    this.#state = "ready";
    this.#emit({ type: "session.ready", sessionId: "offline-fake-session" });
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
  }

  onEvent(listener: RealtimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onWireEvent(listener: RealtimeWireEventListener): () => void {
    this.#wireListeners.add(listener);
    return () => this.#wireListeners.delete(listener);
  }

  appendInputAudio(audio: Pcm16Audio): void {
    if (this.#state !== "ready") throw new Error("fake client is not ready");
    if (this.#pendingCalls.length > 0) throw new Error("cannot append fake input while tool calls are pending");
    if (this.#inputCommitted) throw new Error("fake input was already committed");
    if (this.#responsePrepared) throw new Error("cannot append fake input after response preparation");
    this.#inputChunks.push(Object.freeze({ ...audio, data: Uint8Array.from(audio.data) }));
  }

  prepareResponse(preparation: RealtimeResponsePreparation): void {
    if (this.#state !== "ready" || this.#inputChunks.length === 0 || this.#inputCommitted) {
      throw new Error("fake response preparation requires uncommitted input audio");
    }
    if (this.#responsePrepared) throw new Error("fake response is already prepared");
    if (sha256Hex(preparation.additionalInstructions) !== preparation.contextSha256) {
      throw new Error("fake response preparation hash mismatch");
    }
    if (preparation.contextAuthority !== "advisory_only_gateway_and_speech_gate_enforced") {
      throw new Error("fake response preparation authority mismatch");
    }
    this.#wire({ type: "fake.response.prepared", context_sha256: preparation.contextSha256 });
    this.#responsePrepared = true;
  }

  commitInputAudio(): void {
    if (this.#state !== "ready") throw new Error("fake client is not ready");
    if (this.#inputChunks.length === 0 || this.#inputCommitted) throw new Error("fake input cannot be committed");
    if (this.#turnIndex >= this.#script.turns.length) throw new Error("fake script has no remaining caller turn");
    const bytes = this.#inputChunks.reduce((total, chunk) => total + chunk.data.byteLength, 0);
    this.#wire({
      type: "fake.input_audio.committed",
      turn_id: this.#script.turns[this.#turnIndex].turnId,
      byte_length: bytes,
      chunk_count: this.#inputChunks.length,
      sha256: sha256Hex(Buffer.concat(this.#inputChunks.map((chunk) => Buffer.from(chunk.data)))),
    });
    this.#inputCommitted = true;
  }

  createResponse(): void {
    if (!this.#inputCommitted) throw new Error("fake input must be committed before response creation");
    this.#inputChunks = [];
    this.#inputCommitted = false;
    this.#responsePrepared = false;
    this.#roundIndex = 0;
    this.#emitRound();
  }

  sendTurn(audio: Pcm16Audio | readonly Pcm16Audio[]): void {
    if (this.#state !== "ready") throw new Error("fake client is not ready");
    if (this.#pendingCalls.length > 0) throw new Error("cannot send a new fake turn while tool calls are pending");
    if (this.#turnIndex >= this.#script.turns.length) throw new Error("fake script has no remaining caller turn");
    const chunks = Array.isArray(audio) ? audio : [audio as Pcm16Audio];
    for (const chunk of chunks) this.appendInputAudio(chunk);
    this.commitInputAudio();
    this.createResponse();
  }

  submitToolResults(results: readonly RealtimeToolResult[], createResponse = true): void {
    if (this.#state !== "ready") throw new Error("fake client is not ready");
    if (this.#pendingCalls.length === 0) throw new Error("fake client has no pending tool calls");
    const expected = this.#pendingCalls.map((call) => call.callId).sort();
    const actual = results.map((result) => result.callId).sort();
    if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
      throw new Error("fake tool results do not exactly match the pending call batch");
    }
    this.#wire({
      type: "fake.tool_results.accepted",
      call_ids: expected,
      outputs_sha256: sha256Hex(JSON.stringify(results)),
    });
    for (const result of results) {
      this.observedToolResults.push(deepFreeze(structuredClone(result)));
      this.#ingestToolResult(result.output);
    }
    this.#pendingCalls = Object.freeze([]);
    if (!createResponse) return;
    this.#roundIndex += 1;
    this.#emitRound();
  }

  #emitRound(): void {
    const turn = this.#script.turns[this.#turnIndex];
    const round = turn.rounds[this.#roundIndex];
    if (!round) throw new Error(`fake turn ${turn.turnId} has no continuation round ${this.#roundIndex + 1}`);
    const responseId = `fake-response-${this.#turnIndex + 1}-${this.#roundIndex + 1}`;
    // Snapshot every potentially failing fixture value before the response is
    // started. A malformed deterministic script must never manufacture an
    // unterminated response in benchmark evidence.
    const calls = (round.toolCalls ?? []).map((call): RealtimeToolCall => {
      const argumentsJson = structuredClone(call.arguments) as Record<string, unknown>;
      return {
        callId: call.callId,
        name: call.name,
        argumentsText: JSON.stringify(argumentsJson),
        argumentsJson,
        responseId,
        terminalWireType: "fake.tool.calls",
      };
    });
    this.#emit({ type: "response.started", responseId });
    if (round.outputAudio && round.outputAudio.byteLength > 0) {
      this.#emit({
        type: "output.audio",
        responseId,
        audio: Uint8Array.from(round.outputAudio),
        format: { ...this.#script.outputFormat },
      });
    }
    if (round.transcript !== undefined) {
      this.#emit({
        type: "output.transcript",
        phase: "final",
        text: round.transcript,
        responseId,
        source: "audio",
      });
    }
    if (round.usage) {
      this.#emit({ type: "usage", responseId, scope: "response", usage: structuredClone(round.usage) });
    }
    if (calls.length > 0) {
      this.#pendingCalls = Object.freeze(calls.map((call) => deepFreeze(call)));
      this.#emit({ type: "tool.calls", responseId, calls: structuredClone(calls) });
      // A provider response that selected tools is terminal even though the
      // conversation continues after their results. Keeping that distinction
      // prevents offline benchmarks from leaving every tool round permanently
      // "started" while paid adapters correctly seal their response IDs.
      this.#emit({ type: "response.completed", responseId, status: "completed" });
      return;
    }
    this.#emit({ type: "response.completed", responseId, status: "completed" });
    this.#turnIndex += 1;
    this.#roundIndex = 0;
  }

  #emit(event: NormalizedEventInput): void {
    const full = {
      ...event,
      provider: this.provider,
      receivedAtMs: this.#now(),
      receivedAtMonotonicMs: this.#now(),
      wireType: `fake.${event.type}`,
    } as NormalizedRealtimeEvent;
    for (const listener of this.#listeners) {
      try { listener(cloneEvent(full)); } catch { /* benchmark observers are isolated */ }
    }
  }

  #wire(event: Record<string, unknown>): void {
    for (const listener of this.#wireListeners) {
      try { listener(deepFreeze(structuredClone(event))); } catch { /* benchmark observers are isolated */ }
    }
  }

  #ingestToolResult(output: unknown): void {
    if (!output || typeof output !== "object" || Array.isArray(output)) return;
    const snapshot = (output as Record<string, unknown>).capability_snapshot;
    if (typeof snapshot === "string") this.#ingestCapabilitySnapshot(snapshot);
  }

  #ingestCapabilitySnapshot(rendered: string): void {
    const match = /^<capability_snapshot>\n([\s\S]+)\n<\/capability_snapshot>$/.exec(rendered);
    if (!match) throw new Error("fake client received a malformed rendered capability snapshot");
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      throw new Error("fake client capability snapshot is not JSON");
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { actions?: unknown }).actions)) {
      throw new Error("fake client capability snapshot has no actions");
    }
    for (const action of (parsed as { actions: unknown[] }).actions) {
      if (!action || typeof action !== "object") continue;
      const entry = action as { name?: unknown; capability_grant?: unknown };
      if (typeof entry.name !== "string") throw new Error("fake client capability snapshot action has no name");
      if (entry.capability_grant !== undefined) {
        throw new Error("fake client received a model-visible host capability grant");
      }
    }
  }
}

export function createNoToolFakeScript(input: Readonly<{
  provider?: ServerRealtimeProvider;
  turnIds: readonly string[];
  outputFormat?: Pcm16Format;
}>): FakeRealtimeScript {
  if (input.turnIds.length === 0) throw new Error("offline fake script requires caller turn IDs");
  return deepFreeze({
    provider: input.provider ?? "openai",
    outputFormat: input.outputFormat ?? { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
    turns: input.turnIds.map((turnId, index) => ({
      turnId,
      rounds: [{
        transcript: `Offline deterministic response ${index + 1}.`,
        outputAudio: Uint8Array.from([index & 0xff, 0, (index + 1) & 0xff, 0]),
        usage: { inputTextTokens: 0, inputAudioTokens: 0, outputAudioTokens: 0, raw: {} },
      }],
    })),
  });
}

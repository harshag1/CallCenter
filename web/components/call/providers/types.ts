import type { BrowserRealtimeConnection } from "@/lib/realtime/types";

export const BROWSER_REALTIME_LIMITS = Object.freeze({
  providerEventBytes: 1024 * 1024,
  outboundFrameBytes: 1024 * 1024,
  websocketBufferedBytes: 2 * 1024 * 1024,
  transcriptCharacters: 32_000,
  base64AudioCharacters: 2 * 1024 * 1024,
  captureSamples: 96_000,
  playbackSources: 64,
  pendingAuditEvents: 500,
  recordingBytes: 25 * 1024 * 1024,
  sdpBytes: 256 * 1024,
  geminiAudioOnlySessionMs: 15 * 60_000,
} as const);

export type RealtimeTransportHandlers = {
  onTranscript: (who: "caller" | "agent", text: string) => void;
  onError: (error: Error) => void;
  onClose: () => void;
};

export type RealtimeTransportStart = {
  connection: BrowserRealtimeConnection;
  mic: MediaStream;
  audioContext: AudioContext;
  /** Present only after the caller explicitly consents to local recording. */
  recordingDestination?: MediaStreamAudioDestinationNode;
  handlers: RealtimeTransportHandlers;
};

export type RealtimeToolDrainResult = Readonly<{
  settledNativeCallIds: readonly string[];
  unresolvedNativeCallIds: readonly string[];
}>;

export interface BrowserRealtimeTransport {
  start(args: RealtimeTransportStart): Promise<void>;
  /** Stops new tool admission and reconciles only already in-flight native identities. */
  drainToolCalls?(timeoutMs: number): Promise<RealtimeToolDrainResult>;
  stop(): Promise<void>;
}

export type PlaybackState = {
  playhead: number;
  scheduled: AudioBufferSourceNode[];
};

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseBoundedProviderEvent(data: unknown, provider: string): Record<string, unknown> {
  if (typeof data !== "string") throw new Error(`${provider} returned a non-text provider event`);
  if (utf8Bytes(data) > BROWSER_REALTIME_LIMITS.providerEventBytes) {
    throw new Error(`${provider} provider event exceeded ${BROWSER_REALTIME_LIMITS.providerEventBytes} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error(`${provider} returned malformed JSON`);
  }
  if (!isPlainRecord(parsed)) throw new Error(`${provider} returned a non-object provider event`);
  return parsed;
}

export function boundedProviderText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > BROWSER_REALTIME_LIMITS.transcriptCharacters) {
    throw new Error(`${label} exceeded ${BROWSER_REALTIME_LIMITS.transcriptCharacters} characters`);
  }
  return value;
}

export function boundedProviderBase64(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > BROWSER_REALTIME_LIMITS.base64AudioCharacters) {
    throw new Error(`${label} exceeded ${BROWSER_REALTIME_LIMITS.base64AudioCharacters} characters`);
  }
  return value;
}

export function boundedProviderEventType(value: unknown, provider: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new Error(`${provider} provider event type is invalid`);
  }
  return value;
}

export function sendBoundedWebSocketJson(
  socket: WebSocket,
  value: Readonly<Record<string, unknown>>,
  label: string,
): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} could not be serialized`);
  }
  if (utf8Bytes(encoded) > BROWSER_REALTIME_LIMITS.outboundFrameBytes) {
    throw new Error(`${label} exceeded ${BROWSER_REALTIME_LIMITS.outboundFrameBytes} bytes`);
  }
  const bufferedAmount = Number(socket.bufferedAmount ?? 0);
  if (!Number.isFinite(bufferedAmount) || bufferedAmount > BROWSER_REALTIME_LIMITS.websocketBufferedBytes) {
    throw new Error(`${label} was blocked because the WebSocket send buffer is saturated`);
  }
  socket.send(encoded);
}

/** Read an HTTP response incrementally so a missing/false Content-Length cannot bypass memory bounds. */
export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<string> {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1) throw new Error(`${label} byte limit is invalid`);
  const advertised = response.headers.get("content-length");
  if (advertised !== null) {
    if (!/^\d+$/.test(advertised)) throw new Error(`${label} returned an invalid Content-Length`);
    try {
      if (BigInt(advertised) > BigInt(maximumBytes)) throw new Error(`${label} exceeded ${maximumBytes} bytes`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("exceeded")) throw error;
      throw new Error(`${label} returned an invalid Content-Length`);
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      chunkCount += 1;
      if (byteLength > maximumBytes || chunkCount > 4096) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} exceeded ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} returned invalid UTF-8`);
  }
}

/** A deterministic drop-oldest queue with explicit loss accounting. */
export class BoundedQueue<T> {
  private readonly values: T[] = [];
  private dropped = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("queue capacity must be a positive integer");
  }

  get length(): number {
    return this.values.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  push(value: T): boolean {
    let dropped = false;
    if (this.values.length >= this.capacity) {
      this.values.shift();
      this.dropped += 1;
      dropped = true;
    }
    this.values.push(value);
    return dropped;
  }

  drain(maximum: number): T[] {
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error("queue drain maximum must be positive");
    return this.values.splice(0, maximum);
  }

  prepend(values: readonly T[]): void {
    for (let index = values.length - 1; index >= 0; index -= 1) this.values.unshift(values[index]);
    while (this.values.length > this.capacity) {
      this.values.pop();
      this.dropped += 1;
    }
  }

  clear(): void {
    this.values.length = 0;
    this.dropped = 0;
  }
}

export function pcm16Base64(samples: Float32Array): string {
  if (!(samples instanceof Float32Array) || samples.length > BROWSER_REALTIME_LIMITS.captureSamples) {
    throw new Error(`PCM capture must contain at most ${BROWSER_REALTIME_LIMITS.captureSamples} samples`);
  }
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (!Number.isFinite(sample)) throw new Error("PCM capture contains a non-finite sample");
    pcm[index] = Math.max(-32768, Math.min(32767, sample * 32768));
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** Resample mono float audio before encoding it for providers with a fixed input rate. */
export function resampleMono(samples: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (!(samples instanceof Float32Array) || samples.length > BROWSER_REALTIME_LIMITS.captureSamples) {
    throw new Error(`audio capture must contain at most ${BROWSER_REALTIME_LIMITS.captureSamples} samples`);
  }
  if (!Number.isFinite(sourceRate) || !Number.isFinite(targetRate) || sourceRate <= 0 || targetRate <= 0) {
    throw new Error("audio sample rates must be positive and finite");
  }
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error("audio capture contains a non-finite sample");
  }
  if (sourceRate === targetRate || samples.length === 0) return samples;
  const outputLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  if (outputLength > BROWSER_REALTIME_LIMITS.captureSamples) throw new Error("resampled audio exceeded the capture bound");
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index++) {
    const position = index * ratio;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    output[index] = samples[left] + (samples[right] - samples[left]) * fraction;
  }
  return output;
}

function decodePcm16Base64(base64: string): Int16Array {
  if (!base64 || base64.length > BROWSER_REALTIME_LIMITS.base64AudioCharacters || base64.length % 4 !== 0) {
    throw new Error("provider audio base64 has an invalid length");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error("provider audio base64 is not canonical");
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error("provider audio base64 could not be decoded");
  }
  if (binary.length === 0 || binary.length % 2 !== 0) {
    throw new Error("provider PCM16 audio must contain a positive even number of bytes");
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

export function playPcm16(
  base64: string,
  context: AudioContext,
  destination: MediaStreamAudioDestinationNode | undefined,
  state: PlaybackState,
  sampleRate = 24_000,
) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("provider audio sample rate must be positive");
  const pcm = decodePcm16Base64(base64);
  const floats = Float32Array.from(pcm, (value) => value / 32768);
  const buffer = context.createBuffer(1, floats.length, sampleRate);
  buffer.copyToChannel(floats, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  if (destination) source.connect(destination);
  state.playhead = Math.max(state.playhead, context.currentTime + 0.05);
  source.start(state.playhead);
  state.playhead += buffer.duration;
  while (state.scheduled.length >= BROWSER_REALTIME_LIMITS.playbackSources) {
    const oldest = state.scheduled.shift();
    try { oldest?.stop(); } catch { /* already stopped */ }
  }
  state.scheduled.push(source);
  source.onended = () => { state.scheduled = state.scheduled.filter((candidate) => candidate !== source); };
}

export function interruptPlayback(context: AudioContext, state: PlaybackState) {
  for (const source of state.scheduled) {
    try { source.stop(); } catch { /* already stopped */ }
  }
  state.scheduled = [];
  state.playhead = context.currentTime;
}

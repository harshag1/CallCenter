import type { NormalizedRealtimeClient, Pcm16Audio } from "./client/types";

export type RealtimeAudioDeliveryProfile = Readonly<{
  schemaVersion: 1;
  chunkMs: number;
  pace: "realtime";
}>;

export type RealtimeAudioDeliveryRuntime = Readonly<{
  monotonicNowMs(): number;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}>;

export type RealtimeAudioDeliveryPlan = Readonly<{
  frame_byte_length: number;
  frames: readonly Pcm16Audio[];
  total_byte_length: number;
  tail_byte_length: number;
}>;

export type RealtimeAudioDeliveryReceipt = Readonly<{
  frame_byte_length: number;
  chunk_count: number;
  total_byte_length: number;
  tail_byte_length: number;
  last_scheduled_offset_ms: number;
  media_duration_ms: number;
  chunks: readonly Readonly<{
    chunk_index: number;
    byte_length: number;
    scheduled_offset_ms: number;
    appended_at_offset_ms: number;
  }>[];
}>;

const MAX_EARLY_WAKEUPS_PER_FRAME = 32;

export class RealtimeAudioDeliveryError extends Error {
  readonly code: "aborted" | "clock_invalid" | "pacing_failed" | "append_failed";
  readonly chunks_appended: number;
  readonly bytes_appended: number;

  constructor(input: Readonly<{
    code: RealtimeAudioDeliveryError["code"];
    message: string;
    chunks_appended: number;
    bytes_appended: number;
    cause?: unknown;
  }>) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "RealtimeAudioDeliveryError";
    this.code = input.code;
    this.chunks_appended = input.chunks_appended;
    this.bytes_appended = input.bytes_appended;
  }
}

function assertProfile(profile: RealtimeAudioDeliveryProfile): void {
  if (profile.schemaVersion !== 1) throw new Error("unsupported realtime audio delivery profile schema");
  if (!Number.isSafeInteger(profile.chunkMs) || profile.chunkMs < 20 || profile.chunkMs > 100) {
    throw new Error("realtime audio delivery chunkMs must be an integer from 20 through 100");
  }
  if (profile.pace !== "realtime") throw new Error("realtime audio delivery requires realtime pacing");
}

export function packetizeRealtimePcm16(
  input: Pcm16Audio,
  profile: RealtimeAudioDeliveryProfile,
): RealtimeAudioDeliveryPlan {
  assertProfile(profile);
  if (input.encoding !== "pcm16"
    || input.channels !== 1
    || !Number.isSafeInteger(input.sampleRateHz)
    || input.sampleRateHz <= 0
    || !(input.data instanceof Uint8Array)
    || input.data.byteLength === 0
    || input.data.byteLength % 2 !== 0) {
    throw new Error("realtime audio delivery requires non-empty mono PCM16 with complete samples");
  }
  const samplesPerFrame = input.sampleRateHz * profile.chunkMs / 1_000;
  if (!Number.isSafeInteger(samplesPerFrame) || samplesPerFrame <= 0) {
    throw new Error(`sample rate ${input.sampleRateHz} cannot represent ${profile.chunkMs}ms PCM frames exactly`);
  }
  const frameByteLength = samplesPerFrame * 2;
  const source = Uint8Array.from(input.data);
  const frames: Pcm16Audio[] = [];
  for (let offset = 0; offset < source.byteLength; offset += frameByteLength) {
    frames.push(Object.freeze({
      encoding: "pcm16" as const,
      sampleRateHz: input.sampleRateHz,
      channels: 1 as const,
      data: source.slice(offset, Math.min(source.byteLength, offset + frameByteLength)),
    }));
  }
  return Object.freeze({
    frame_byte_length: frameByteLength,
    frames: Object.freeze(frames),
    total_byte_length: source.byteLength,
    tail_byte_length: frames.at(-1)!.data.byteLength,
  });
}

function deliveryError(
  code: RealtimeAudioDeliveryError["code"],
  message: string,
  chunksAppended: number,
  bytesAppended: number,
  cause?: unknown,
): RealtimeAudioDeliveryError {
  return new RealtimeAudioDeliveryError({
    code,
    message,
    chunks_appended: chunksAppended,
    bytes_appended: bytesAppended,
    cause,
  });
}

function checkedNow(
  runtime: RealtimeAudioDeliveryRuntime,
  previous: number,
  chunksAppended: number,
  bytesAppended: number,
): number {
  const current = runtime.monotonicNowMs();
  if (!Number.isFinite(current) || current < previous) {
    throw deliveryError(
      "clock_invalid",
      "realtime audio delivery clock is non-finite or moved backwards",
      chunksAppended,
      bytesAppended,
    );
  }
  return current;
}

/**
 * Appends one byte-exact PCM turn on absolute realtime deadlines. This owns no
 * provider turn boundary: callers must prepare, commit, and request a response
 * only after the returned receipt proves that every frame was appended.
 */
export async function deliverRealtimePcm16(input: Readonly<{
  client: Pick<NormalizedRealtimeClient, "appendInputAudio">;
  audio: Pcm16Audio;
  profile: RealtimeAudioDeliveryProfile;
  runtime: RealtimeAudioDeliveryRuntime;
  signal: AbortSignal;
}>): Promise<RealtimeAudioDeliveryReceipt> {
  const plan = packetizeRealtimePcm16(input.audio, input.profile);
  let chunksAppended = 0;
  let bytesAppended = 0;
  let priorNow = checkedNow(input.runtime, Number.NEGATIVE_INFINITY, 0, 0);
  const startedAt = priorNow;
  const offsets: number[] = [];

  for (const [index, frame] of plan.frames.entries()) {
    if (input.signal.aborted) {
      throw deliveryError("aborted", "realtime audio delivery was aborted", chunksAppended, bytesAppended);
    }
    if (index > 0) {
      priorNow = checkedNow(input.runtime, priorNow, chunksAppended, bytesAppended);
      const target = startedAt + index * input.profile.chunkMs;
      let earlyWakeups = 0;
      while (priorNow < target) {
        const delayMs = target - priorNow;
        try {
          await input.runtime.sleep(delayMs, input.signal);
        } catch (error) {
          if (input.signal.aborted) {
            throw deliveryError("aborted", "realtime audio delivery was aborted", chunksAppended, bytesAppended, error);
          }
          throw deliveryError("pacing_failed", "realtime audio delivery pacing failed", chunksAppended, bytesAppended, error);
        }
        if (input.signal.aborted) {
          throw deliveryError("aborted", "realtime audio delivery was aborted", chunksAppended, bytesAppended);
        }
        priorNow = checkedNow(input.runtime, priorNow, chunksAppended, bytesAppended);
        if (priorNow < target && ++earlyWakeups >= MAX_EARLY_WAKEUPS_PER_FRAME) {
          throw deliveryError(
            "pacing_failed",
            "realtime audio delivery clock did not reach its absolute frame deadline",
            chunksAppended,
            bytesAppended,
          );
        }
      }
    }
    const appendStartedAt = checkedNow(input.runtime, priorNow, chunksAppended, bytesAppended);
    try {
      input.client.appendInputAudio(frame);
    } catch (error) {
      throw deliveryError("append_failed", "realtime audio frame append failed", chunksAppended, bytesAppended, error);
    }
    chunksAppended += 1;
    bytesAppended += frame.data.byteLength;
    const appendedAt = checkedNow(input.runtime, appendStartedAt, chunksAppended, bytesAppended);
    offsets.push(appendedAt - startedAt);
    priorNow = appendedAt;
  }

  return Object.freeze({
    frame_byte_length: plan.frame_byte_length,
    chunk_count: chunksAppended,
    total_byte_length: bytesAppended,
    tail_byte_length: plan.tail_byte_length,
    last_scheduled_offset_ms: Math.max(0, (chunksAppended - 1) * input.profile.chunkMs),
    media_duration_ms: bytesAppended / 2 / input.audio.sampleRateHz * 1_000,
    chunks: Object.freeze(plan.frames.map((frame, index) => Object.freeze({
      chunk_index: index + 1,
      byte_length: frame.data.byteLength,
      scheduled_offset_ms: index * input.profile.chunkMs,
      appended_at_offset_ms: offsets[index]!,
    }))),
  });
}

export const SYSTEM_REALTIME_AUDIO_DELIVERY_RUNTIME: RealtimeAudioDeliveryRuntime = Object.freeze({
  monotonicNowMs: () => performance.now(),
  sleep(delayMs, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("realtime audio delivery was aborted"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("realtime audio delivery was aborted"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, delayMs));
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
});

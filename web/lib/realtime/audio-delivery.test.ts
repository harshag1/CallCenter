import { describe, expect, it } from "vitest";

import {
  deliverRealtimePcm16,
} from "./audio-delivery";

const profile = Object.freeze({
  schemaVersion: 1 as const,
  chunkMs: 20,
  pace: "realtime" as const,
});

function twoFrameAudio() {
  return Object.freeze({
    encoding: "pcm16" as const,
    sampleRateHz: 24_000,
    channels: 1 as const,
    data: new Uint8Array(1_920),
  });
}

describe("deliverRealtimePcm16 absolute pacing", () => {
  it("rechecks an absolute frame deadline after an early timer wakeup", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const appendedAt: number[] = [];
    const controller = new AbortController();

    const receipt = await deliverRealtimePcm16({
      audio: twoFrameAudio(),
      profile,
      signal: controller.signal,
      client: {
        appendInputAudio() {
          appendedAt.push(now);
        },
      },
      runtime: {
        monotonicNowMs: () => now,
        async sleep(delayMs) {
          sleeps.push(delayMs);
          now += sleeps.length === 1 ? delayMs - 0.75 : delayMs;
        },
      },
    });

    expect(sleeps).toEqual([20, 0.75]);
    expect(appendedAt).toEqual([0, 20]);
    expect(receipt.chunks.map((chunk) => chunk.appended_at_offset_ms))
      .toEqual([0, 20]);
  });

  it("fails closed when repeated wakeups never advance the clock", async () => {
    let appended = 0;
    const controller = new AbortController();

    await expect(deliverRealtimePcm16({
      audio: twoFrameAudio(),
      profile,
      signal: controller.signal,
      client: {
        appendInputAudio() {
          appended += 1;
        },
      },
      runtime: {
        monotonicNowMs: () => 0,
        async sleep() {
          // Deliberately returns without advancing the monotonic clock.
        },
      },
    })).rejects.toMatchObject({
      name: "RealtimeAudioDeliveryError",
      code: "pacing_failed",
      chunks_appended: 1,
      bytes_appended: 960,
    });

    expect(appended).toBe(1);
  });
});

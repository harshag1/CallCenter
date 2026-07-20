import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BoundedQueue,
  BROWSER_REALTIME_LIMITS,
  boundedProviderBase64,
  boundedProviderEventType,
  boundedProviderText,
  parseBoundedProviderEvent,
  pcm16Base64,
  playPcm16,
  readBoundedResponseText,
  resampleMono,
  sendBoundedWebSocketJson,
} from "./types";

describe("browser realtime protocol bounds", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("rejects malformed, non-object, binary, and oversized provider events", () => {
    expect(() => parseBoundedProviderEvent("{", "xAI")).toThrow("malformed JSON");
    expect(() => parseBoundedProviderEvent("[]", "xAI")).toThrow("non-object");
    expect(() => parseBoundedProviderEvent(new ArrayBuffer(2), "xAI")).toThrow("non-text");
    expect(() => parseBoundedProviderEvent(
      JSON.stringify({ value: "x".repeat(BROWSER_REALTIME_LIMITS.providerEventBytes) }),
      "xAI",
    )).toThrow("exceeded");
  });

  it("bounds event identity and transcript fields", () => {
    expect(boundedProviderEventType("session.updated", "xAI")).toBe("session.updated");
    expect(() => boundedProviderEventType("bad\nevent", "xAI")).toThrow("invalid");
    expect(boundedProviderText("hello", "transcript")).toBe("hello");
    expect(boundedProviderBase64("AQAA", "audio")).toBe("AQAA");
    expect(() => boundedProviderText(
      "x".repeat(BROWSER_REALTIME_LIMITS.transcriptCharacters + 1),
      "transcript",
    )).toThrow("exceeded");
  });

  it("uses a bounded queue with explicit drop accounting", () => {
    const queue = new BoundedQueue<number>(2);
    expect(queue.push(1)).toBe(false);
    expect(queue.push(2)).toBe(false);
    expect(queue.push(3)).toBe(true);
    expect(queue.droppedCount).toBe(1);
    expect(queue.drain(2)).toEqual([2, 3]);
  });

  it("blocks oversized frames and saturated WebSocket buffers before send", () => {
    const socket = { send: vi.fn(), bufferedAmount: 0 } as unknown as WebSocket;
    sendBoundedWebSocketJson(socket, { ok: true }, "frame");
    expect(socket.send).toHaveBeenCalledTimes(1);

    Object.assign(socket, { bufferedAmount: BROWSER_REALTIME_LIMITS.websocketBufferedBytes + 1 });
    expect(() => sendBoundedWebSocketJson(socket, { ok: true }, "frame")).toThrow("saturated");
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it("rejects non-finite capture samples and invalid audio base64", () => {
    expect(() => pcm16Base64(Float32Array.from([Number.NaN]))).toThrow("non-finite");
    expect(() => resampleMono(Float32Array.from([0, Number.POSITIVE_INFINITY]), 48_000, 24_000))
      .toThrow("non-finite");

    const context = {
      currentTime: 0,
      destination: {},
      createBuffer: vi.fn(),
      createBufferSource: vi.fn(),
    } as unknown as AudioContext;
    expect(() => playPcm16("not base64", context, undefined, { playhead: 0, scheduled: [] }))
      .toThrow("invalid length");
    expect(() => playPcm16("AQ==", context, undefined, { playhead: 0, scheduled: [] }))
      .toThrow("even number of bytes");
  });

  it("caps streamed HTTP bodies without trusting Content-Length", async () => {
    const accepted = await readBoundedResponseText(new Response("okay"), 4, "provider response");
    expect(accepted).toBe("okay");

    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123"));
        controller.enqueue(new TextEncoder().encode("456"));
        controller.close();
      },
    });
    await expect(readBoundedResponseText(
      new Response(streamed),
      5,
      "provider response",
    )).rejects.toThrow("exceeded 5 bytes");
  });
});

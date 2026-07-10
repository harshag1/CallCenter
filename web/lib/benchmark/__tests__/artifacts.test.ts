import { describe, expect, it } from "vitest";
import {
  BenchmarkEventEnvelope,
  buildEventChain,
  canonicalJson,
  createArtifactDescriptor,
  createRunManifest,
  decodeEventJsonl,
  encodeEventJsonl,
  verifyArtifactContent,
  verifyEventChain,
  verifyRunManifest,
} from "../artifacts";

describe("tamper-evident benchmark artifacts", () => {
  it("canonicalizes object keys and rejects ambiguous non-JSON values", () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: null } })).toBe(
      '{"a":{"b":null,"y":true},"z":1}'
    );
    expect(() => canonicalJson({ missing: undefined })).toThrow(/not JSON-serializable/);
    expect(() => canonicalJson({ date: new Date() })).toThrow(/plain JSON objects/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycle/);
  });

  it("builds a detached, immutable, hash-chained JSONL trace", () => {
    const source = { transcript: "hello", usage: { audio_tokens: 42 } };
    const chain = buildEventChain("run-1", [
      {
        observed_at: "2026-07-10T12:00:00.000Z",
        event_type: "session.started",
        payload: source,
      },
      {
        observed_at: "2026-07-10T12:00:01.000Z",
        event_type: "turn.completed",
        payload: { turn: 1 },
      },
      {
        observed_at: "2026-07-10T12:00:02.000Z",
        event_type: "run.completed",
        payload: { pass: true },
      },
    ]);
    source.transcript = "mutated later";

    expect(chain[0].payload).toMatchObject({ transcript: "hello" });
    expect(Object.isFrozen(chain[0].payload)).toBe(true);
    expect(chain[1].previous_hash).toBe(chain[0].event_hash);
    expect(chain[2].previous_hash).toBe(chain[1].event_hash);
    expect(verifyEventChain(chain)).toMatchObject({
      valid: true,
      event_count: 3,
      run_id: "run-1",
      chain_head: chain[2].event_hash,
    });

    const jsonl = encodeEventJsonl(chain);
    expect(jsonl.endsWith("\n")).toBe(true);
    expect(decodeEventJsonl(jsonl)).toEqual(chain);
  });

  it("detects changed payloads and broken chain links", () => {
    const chain = buildEventChain("run-1", [
      {
        observed_at: "2026-07-10T12:00:00.000Z",
        event_type: "one",
        payload: { value: 1 },
      },
      {
        observed_at: "2026-07-10T12:00:01.000Z",
        event_type: "two",
        payload: { value: 2 },
      },
    ]);
    const tampered = [
      { ...chain[0], payload: { value: 999 } },
      chain[1],
    ] as unknown as readonly BenchmarkEventEnvelope[];
    const verification = verifyEventChain(tampered);
    expect(verification.valid).toBe(false);
    expect(verification.errors).toContain("event[0] payload_hash mismatch");
    expect(verification.errors).toContain("event[0] event_hash mismatch");
    expect(() => encodeEventJsonl(tampered)).toThrow(/Invalid event chain/);
  });

  it("hashes a canonically ordered run manifest and verifies artifact bytes", () => {
    const events = buildEventChain("run-1", [{
      observed_at: "2026-07-10T12:00:00.000Z",
      event_type: "run.completed",
      payload: { pass: true },
    }]);
    const eventJsonl = encodeEventJsonl(events);
    const eventsDescriptor = createArtifactDescriptor("events/events.jsonl", eventJsonl, "application/x-ndjson");
    const audio = new Uint8Array([1, 2, 3, 4]);
    const audioDescriptor = createArtifactDescriptor("audio/caller.pcm", audio, "audio/L16");
    const manifest = createRunManifest({
      run_id: "run-1",
      created_at: "2026-07-10T12:00:02.000Z",
      artifacts: [eventsDescriptor, audioDescriptor],
      event_log: {
        path: eventsDescriptor.path,
        event_count: events.length,
        chain_head: events[events.length - 1].event_hash,
      },
      metadata: { seed: "fixed-1", condition: "harness" },
    });

    expect(manifest.artifacts.map((artifact) => artifact.path)).toEqual([
      "audio/caller.pcm",
      "events/events.jsonl",
    ]);
    expect(verifyRunManifest(manifest).valid).toBe(true);
    expect(verifyArtifactContent(audioDescriptor, audio).valid).toBe(true);
    expect(verifyArtifactContent(audioDescriptor, new Uint8Array([1, 2, 3])).valid).toBe(false);

    const reorderedInputManifest = createRunManifest({
      run_id: "run-1",
      created_at: "2026-07-10T12:00:02.000Z",
      artifacts: [audioDescriptor, eventsDescriptor],
      event_log: manifest.event_log,
      metadata: { condition: "harness", seed: "fixed-1" },
    });
    expect(reorderedInputManifest.manifest_hash).toBe(manifest.manifest_hash);

    const tampered = {
      ...manifest,
      metadata: { seed: "different" },
    } as typeof manifest;
    expect(verifyRunManifest(tampered)).toMatchObject({ valid: false });
  });

  it("rejects traversal paths and a manifest event log without an artifact", () => {
    expect(() => createArtifactDescriptor("../secret", "nope")).toThrow(/normalized relative/);
    expect(() => createRunManifest({
      run_id: "run-1",
      created_at: "2026-07-10T12:00:00.000Z",
      artifacts: [],
      event_log: { path: "events.jsonl", event_count: 0, chain_head: null },
    })).toThrow(/must reference/);
  });
});

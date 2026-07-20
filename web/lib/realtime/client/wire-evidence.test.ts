import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RealtimeWireObservation } from "./types";
import {
  canonicalRealtimeEvidenceJson,
  realtimeWireIdentitySha256,
  realtimeWireObservationReference,
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
  verifyRealtimeWireObservationChain,
} from "./wire-evidence";

function observation(
  sequence: number,
  previousObservationSha256: string | null,
  overrides: Partial<Omit<RealtimeWireObservation, "observationSha256">> = {},
): RealtimeWireObservation {
  const projection = Object.freeze({ control: { kind: sequence === 1 ? "setup" : "ready" } });
  const core = {
    schemaVersion: 1 as const,
    provider: "openai" as const,
    direction: sequence === 1 ? "outbound" as const : "inbound" as const,
    connectionEpoch: 1,
    sequence,
    observedAtMs: 1_700_000_000_000 + sequence,
    observedAtMonotonicMs: 10 + sequence,
    wireType: sequence === 1 ? "session.update" : "session.updated",
    payloadSha256: createHash("sha256").update(`payload-${sequence}`).digest("hex"),
    payloadBytes: 100 + sequence,
    projectionSha256: realtimeWireProjectionSha256(projection),
    previousObservationSha256,
    identities: sequence === 1
      ? Object.freeze({})
      : Object.freeze({ callIdSha256: realtimeWireIdentitySha256("call", "provider-call-1") }),
    projection,
    ...overrides,
  };
  const withoutStoredHash = { ...core } as Omit<RealtimeWireObservation, "observationSha256">;
  return Object.freeze({
    ...withoutStoredHash,
    observationSha256: realtimeWireObservationSha256(withoutStoredHash),
  });
}

describe("realtime wire evidence", () => {
  it("verifies a direction-tagged chain and creates an exact normalized-event pointer", () => {
    const first = observation(1, null);
    const second = observation(2, first.observationSha256);
    expect(verifyRealtimeWireObservationChain([first, second])).toEqual({
      valid: true,
      eventCount: 2,
      chainHead: second.observationSha256,
      errors: [],
    });
    expect(realtimeWireObservationReference(second)).toEqual({
      availability: "observed",
      connectionEpoch: 1,
      sequence: 2,
      observationSha256: second.observationSha256,
      payloadSha256: second.payloadSha256,
      projectionSha256: second.projectionSha256,
      callIdSha256: second.identities.callIdSha256,
    });
  });

  it("rejects reordered, re-epoched, rewound-clock, and mutated observations", () => {
    const first = observation(1, null);
    const second = observation(2, first.observationSha256);
    const mutated = structuredClone(second) as RealtimeWireObservation;
    Object.assign(mutated as unknown as Record<string, unknown>, {
      sequence: 7,
      connectionEpoch: 3,
      observedAtMonotonicMs: 1,
      projection: { leaked: "private transcript" },
      observationSha256: "f".repeat(64),
    });
    expect(verifyRealtimeWireObservationChain([first, mutated])).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        "observation 2 has a non-contiguous sequence",
        "observation 2 has a non-contiguous connection epoch",
        "observation 2 has a decreasing monotonic timestamp",
        "observation 2 redacted projection hash does not match",
        "observation 2 chain hash does not match",
      ]),
    });
  });

  it("canonicalizes only bounded plain data without invoking accessors", () => {
    let getterCalls = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-be-read";
      },
    });
    expect(() => canonicalRealtimeEvidenceJson(accessor)).toThrow(/enumerable data values/);
    expect(getterCalls).toBe(0);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalRealtimeEvidenceJson(cyclic)).toThrow(/cycles/);

    const sparse = new Array(2) as unknown[];
    sparse[1] = "present";
    expect(() => canonicalRealtimeEvidenceJson(sparse)).toThrow(/dense data arrays/);
  });
});

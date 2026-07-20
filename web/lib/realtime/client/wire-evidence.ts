import { createHash } from "node:crypto";
import type { RealtimeWireObservation, RealtimeWireObservationReference } from "./types";

export const REALTIME_WIRE_OBSERVATION_CHAIN_DOMAIN =
  "harshas-amazing-call-center/realtime-wire-observation/v1";
export const REALTIME_WIRE_IDENTITY_DOMAIN =
  "harshas-amazing-call-center/realtime-wire-identity/v1";

export type RealtimeWireIdentityKind =
  | "event"
  | "session"
  | "response"
  | "item"
  | "call"
  | "target-tool"
  | "transcription-model";

export type RealtimeWireObservationCore = Omit<RealtimeWireObservation, "observationSha256">;

export type RealtimeWireObservationChainVerification = Readonly<{
  valid: boolean;
  eventCount: number;
  chainHead: string | null;
  errors: readonly string[];
}>;

/** Canonical hash used for the privacy-safe projection stored in evidence bundles. */
export function realtimeWireProjectionSha256(projection: Readonly<Record<string, unknown>>): string {
  return sha256(canonicalRealtimeEvidenceJson(projection));
}

/** Stable pseudonym used to join private provider identities across artifacts. */
export function realtimeWireIdentitySha256(kind: RealtimeWireIdentityKind, value: string): string {
  if (!WIRE_IDENTITY_KIND.test(kind)) throw new Error("Realtime wire identity kind is invalid");
  if (!value || Buffer.byteLength(value, "utf8") > MAX_IDENTITY_BYTES) {
    throw new Error("Realtime wire identity value is invalid");
  }
  return createHash("sha256")
    .update(REALTIME_WIRE_IDENTITY_DOMAIN)
    .update("\0")
    .update(kind)
    .update("\0")
    .update(value)
    .digest("hex");
}

/** Recomputes one observation hash, including its predecessor and redacted projection. */
export function realtimeWireObservationSha256(observation: RealtimeWireObservationCore): string {
  return createHash("sha256")
    .update(REALTIME_WIRE_OBSERVATION_CHAIN_DOMAIN)
    .update("\0")
    .update(canonicalRealtimeEvidenceJson(observation))
    .digest("hex");
}

/** Minimal immutable pointer attached to normalized events derived from a frame. */
export function realtimeWireObservationReference(
  observation: RealtimeWireObservation,
): RealtimeWireObservationReference {
  return Object.freeze({
    availability: "observed" as const,
    connectionEpoch: observation.connectionEpoch,
    sequence: observation.sequence,
    observationSha256: observation.observationSha256,
    payloadSha256: observation.payloadSha256,
    projectionSha256: observation.projectionSha256,
    ...(observation.identities.callIdSha256 === undefined
      ? {}
      : { callIdSha256: observation.identities.callIdSha256 }),
  });
}

/**
 * Replays the complete chain without access to private payload bytes. The
 * payload digest remains bound into each observation hash; artifact readers can
 * additionally compare it with an independently retained private raw packet.
 */
export function verifyRealtimeWireObservationChain(
  observations: readonly RealtimeWireObservation[],
): RealtimeWireObservationChainVerification {
  const errors: string[] = [];
  let predecessor: string | null = null;
  let priorMonotonicMs = Number.NEGATIVE_INFINITY;
  let priorConnectionEpoch = 0;
  for (const [index, observation] of observations.entries()) {
    const position = index + 1;
    if (observation.schemaVersion !== 1) errors.push(`observation ${position} has an unsupported schema version`);
    if (observation.provider !== "openai" && observation.provider !== "xai" && observation.provider !== "gemini") {
      errors.push(`observation ${position} has an invalid provider`);
    }
    if (observation.direction !== "inbound" && observation.direction !== "outbound") {
      errors.push(`observation ${position} has an invalid direction`);
    }
    if (observation.sequence !== position) errors.push(`observation ${position} has a non-contiguous sequence`);
    if (observation.connectionEpoch < 1 || !Number.isSafeInteger(observation.connectionEpoch)) {
      errors.push(`observation ${position} has an invalid connection epoch`);
    }
    if (
      (position === 1 && observation.connectionEpoch !== 1)
      || observation.connectionEpoch < priorConnectionEpoch
      || observation.connectionEpoch > priorConnectionEpoch + 1
    ) {
      errors.push(`observation ${position} has a non-contiguous connection epoch`);
    }
    priorConnectionEpoch = observation.connectionEpoch;
    if (typeof observation.wireType !== "string" || !SAFE_WIRE_TYPE.test(observation.wireType)) {
      errors.push(`observation ${position} has an invalid wire type`);
    }
    if (!Number.isFinite(observation.observedAtMs) || !Number.isFinite(observation.observedAtMonotonicMs)) {
      errors.push(`observation ${position} has a non-finite timestamp`);
    }
    if (observation.observedAtMonotonicMs < priorMonotonicMs) {
      errors.push(`observation ${position} has a decreasing monotonic timestamp`);
    }
    priorMonotonicMs = observation.observedAtMonotonicMs;
    if (!Number.isSafeInteger(observation.payloadBytes) || observation.payloadBytes < 1) {
      errors.push(`observation ${position} has an invalid payload byte length`);
    }
    for (const [label, hash] of [
      ["payload", observation.payloadSha256],
      ["projection", observation.projectionSha256],
      ["observation", observation.observationSha256],
    ] as const) {
      if (!SHA256.test(hash)) errors.push(`observation ${position} has an invalid ${label} hash`);
    }
    for (const [label, hash] of Object.entries(observation.identities ?? {})) {
      if (!WIRE_IDENTITY_KEYS.has(label)) errors.push(`observation ${position} has an unknown identity field`);
      if (hash !== undefined && !SHA256.test(hash)) {
        errors.push(`observation ${position} has an invalid ${label}`);
      }
    }
    if (observation.previousObservationSha256 !== predecessor) {
      errors.push(`observation ${position} does not reference its predecessor`);
    }
    try {
      if (observation.projectionSha256 !== realtimeWireProjectionSha256(observation.projection)) {
        errors.push(`observation ${position} redacted projection hash does not match`);
      }
      const { observationSha256, ...core } = observation;
      if (observationSha256 !== realtimeWireObservationSha256(core)) {
        errors.push(`observation ${position} chain hash does not match`);
      }
    } catch {
      errors.push(`observation ${position} is not bounded canonical JSON evidence`);
    }
    predecessor = observation.observationSha256;
  }
  return Object.freeze({
    valid: errors.length === 0,
    eventCount: observations.length,
    chainHead: predecessor,
    errors: Object.freeze(errors),
  });
}

/** Exact JSON canonicalization used only for already-redacted evidence objects. */
export function canonicalRealtimeEvidenceJson(value: unknown): string {
  const state = { nodes: 0, ancestors: new Set<object>() };
  return visit(value, 0);

  function visit(candidate: unknown, depth: number): string {
    state.nodes += 1;
    if (state.nodes > MAX_CANONICAL_NODES) throw new Error("Realtime wire evidence is too complex");
    if (depth > MAX_CANONICAL_DEPTH) throw new Error("Realtime wire evidence is too deep");
    if (candidate === null || typeof candidate === "boolean") return JSON.stringify(candidate);
    if (typeof candidate === "string") {
      if (Buffer.byteLength(candidate, "utf8") > MAX_CANONICAL_STRING_BYTES) {
        throw new Error("Realtime wire evidence string is too large");
      }
      return JSON.stringify(candidate);
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("Realtime wire evidence number must be finite");
      return JSON.stringify(candidate);
    }
    if (typeof candidate !== "object") throw new Error("Realtime wire evidence must contain only JSON values");
    if (state.ancestors.has(candidate)) throw new Error("Realtime wire evidence cannot contain cycles");
    state.ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const descriptors = Object.getOwnPropertyDescriptors(candidate) as Record<string, PropertyDescriptor>;
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CANONICAL_NODES) {
          throw new Error("Realtime wire evidence array length is invalid");
        }
        const keys = Reflect.ownKeys(candidate);
        if (
          keys.length !== length + 1
          || keys.some((key) => (
            typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key))
          ))
        ) {
          throw new Error("Realtime wire evidence arrays must be dense data arrays");
        }
        const items: string[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            throw new Error("Realtime wire evidence arrays must contain enumerable data values");
          }
          items.push(visit(descriptor.value, depth + 1));
        }
        return `[${items.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Realtime wire evidence objects must be plain");
      }
      const keys = Reflect.ownKeys(candidate);
      if (keys.length > MAX_CANONICAL_OBJECT_KEYS || keys.some((key) => typeof key !== "string")) {
        throw new Error("Realtime wire evidence object keys are invalid");
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const entries: string[] = [];
      for (const key of (keys as string[]).sort()) {
        if (Buffer.byteLength(key, "utf8") > MAX_CANONICAL_KEY_BYTES) {
          throw new Error("Realtime wire evidence object key is too large");
        }
        const descriptor = descriptors[key];
        if (!("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("Realtime wire evidence objects must contain enumerable data values");
        }
        entries.push(`${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`);
      }
      return `{${entries.join(",")}}`;
    } finally {
      state.ancestors.delete(candidate);
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const SHA256 = /^[a-f0-9]{64}$/;
const WIRE_IDENTITY_KIND = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_WIRE_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WIRE_IDENTITY_KEYS = new Set([
  "eventIdSha256",
  "sessionIdSha256",
  "responseIdSha256",
  "itemIdSha256",
  "callIdSha256",
]);
const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_NODES = 100_000;
const MAX_CANONICAL_OBJECT_KEYS = 10_000;
const MAX_CANONICAL_KEY_BYTES = 1_024;
const MAX_CANONICAL_STRING_BYTES = 1024 * 1024;
const MAX_IDENTITY_BYTES = 1024 * 1024;

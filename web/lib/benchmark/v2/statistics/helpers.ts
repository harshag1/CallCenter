import type {
  BinaryArmObservation,
  IttPairedBinaryObservation,
  ScheduledPairedBinaryObservation,
} from "./types";

export type Seed = string | number;
export type RandomSource = () => number;

export function assertProbability(value: number, label: string, inclusive = false): void {
  const valid = Number.isFinite(value) && (inclusive
    ? value >= 0 && value <= 1
    : value > 0 && value < 1);
  if (!valid) {
    throw new Error(`${label} must be ${inclusive ? "between zero and one" : "strictly between zero and one"}`);
  }
}

export function assertNonEmptyId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function assertSafePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function validateArmObservation(observation: BinaryArmObservation, label: string): void {
  if (!observation || typeof observation !== "object") throw new Error(`${label} is required`);
  if (observation.status === "observed") {
    if (typeof observation.value !== "boolean") {
      throw new Error(`${label}.value must be boolean when status is observed`);
    }
    return;
  }
  if (!["missing", "invalid", "transport_failure", "runner_failure"].includes(observation.status)) {
    throw new Error(`${label}.status is not recognized`);
  }
  if (observation.value !== null) {
    throw new Error(`${label}.value must be null when status is not observed`);
  }
}

/**
 * Applies the frozen efficacy ITT rule: every scheduled pair remains present,
 * and every non-observed arm is scored false. It never performs complete-case
 * deletion or silently manufactures a replacement pair.
 */
export function normalizeEfficacyItt(
  rows: readonly ScheduledPairedBinaryObservation[],
): readonly IttPairedBinaryObservation[] {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("At least one scheduled pair is required");
  const pairIds = new Set<string>();
  return Object.freeze(rows.map((row, index) => {
    assertNonEmptyId(row.pair_id, `rows[${index}].pair_id`);
    assertNonEmptyId(row.provider, `rows[${index}].provider`);
    assertNonEmptyId(row.cluster_id, `rows[${index}].cluster_id`);
    if (pairIds.has(row.pair_id)) throw new Error(`Duplicate pair_id: ${row.pair_id}`);
    pairIds.add(row.pair_id);
    validateArmObservation(row.native, `${row.pair_id}.native`);
    validateArmObservation(row.hacc, `${row.pair_id}.hacc`);
    return Object.freeze({
      pair_id: row.pair_id,
      provider: row.provider,
      cluster_id: row.cluster_id,
      native_value: row.native.status === "observed" ? row.native.value : false,
      hacc_value: row.hacc.status === "observed" ? row.hacc.value : false,
      native_status: row.native.status,
      hacc_status: row.hacc.status,
      native_missing: row.native.status !== "observed",
      hacc_missing: row.hacc.status !== "observed",
    });
  }));
}

export function validateProviderSet(
  rows: readonly Readonly<{ provider: string }>[],
  providers: readonly string[],
): readonly string[] {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("At least one frozen provider is required");
  }
  const unique = new Set<string>();
  for (const [index, provider] of providers.entries()) {
    assertNonEmptyId(provider, `providers[${index}]`);
    if (unique.has(provider)) throw new Error(`Duplicate provider: ${provider}`);
    unique.add(provider);
  }
  for (const row of rows) {
    if (!unique.has(row.provider)) throw new Error(`Unregistered provider: ${row.provider}`);
  }
  for (const provider of providers) {
    if (!rows.some((row) => row.provider === provider)) {
      throw new Error(`Frozen provider has no scheduled pairs: ${provider}`);
    }
  }
  return Object.freeze([...providers]);
}

/** FNV-1a seed hashing followed by Mulberry32 for platform-stable simulation. */
export function createSeededRng(seed: Seed): RandomSource {
  const seedText = typeof seed === "number"
    ? (() => {
        if (!Number.isFinite(seed)) throw new Error("Numeric seed must be finite");
        return `number:${Object.is(seed, -0) ? 0 : seed}`;
      })()
    : `string:${seed}`;
  let state = 0x811c9dc5;
  for (let index = 0; index < seedText.length; index += 1) {
    state ^= seedText.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  state >>>= 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function draw(rng: RandomSource): number {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error("Random source must return a finite value in [0, 1)");
  }
  return value;
}

export function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new Error("Cannot take a percentile of an empty sample");
  assertProbability(probability, "percentile probability", true);
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function bigintRatio(numerator: bigint, denominator: bigint): number {
  if (numerator < BigInt(0) || denominator <= BigInt(0) || numerator > denominator) {
    throw new Error("BigInt ratio requires 0 <= numerator <= denominator");
  }
  const scale = BigInt(10) ** BigInt(18);
  return Number((numerator * scale + denominator / BigInt(2)) / denominator) / 1e18;
}

export function gcd(left: bigint, right: bigint): bigint {
  let a = left < BigInt(0) ? -left : left;
  let b = right < BigInt(0) ? -right : right;
  while (b !== BigInt(0)) [a, b] = [b, a % b];
  return a;
}

export function lcm(left: bigint, right: bigint): bigint {
  if (left === BigInt(0) || right === BigInt(0)) return BigInt(0);
  return (left / gcd(left, right)) * right;
}

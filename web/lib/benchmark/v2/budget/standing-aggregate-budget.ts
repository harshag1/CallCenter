import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { canonicalJson, sha256Hex } from "../../artifacts";
import { microUsdToDecimal } from "../../budget";

const KIND = "hacc_standing_aggregate_budget_ledger" as const;
const AUTHORITY_ID = "hacc-standing-launch-authority-2026-08-02" as const;
const INTEGRITY_DOMAIN = "harshas-amazing-call-center/standing-aggregate-budget/v1\n";
const OPERATION_DOMAIN = "harshas-amazing-call-center/standing-aggregate-operation/v1\n";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_LEDGER_BYTES = 32 * 1024 * 1024;

export const STANDING_GENESIS_MICRO_USD = 172_500_000 as const;
export const STANDING_HARD_CEILING_EXCLUSIVE_MICRO_USD = 300_000_000 as const;

export type StandingAggregateBudgetErrorCode =
  | "missing_ledger"
  | "corrupt_ledger"
  | "invalid_request"
  | "unsafe_path"
  | "lock_timeout"
  | "operation_conflict"
  | "duplicate_reservation"
  | "duplicate_trial"
  | "aggregate_exhausted"
  | "unknown_reservation"
  | "invalid_transition";

export class StandingAggregateBudgetError extends Error {
  readonly code: StandingAggregateBudgetErrorCode;

  constructor(code: StandingAggregateBudgetErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StandingAggregateBudgetError";
    this.code = code;
  }
}

type AggregateCosts = Readonly<{
  estimated_micro_usd: number;
  provider_reported_micro_usd: number;
  reconciled_micro_usd: number;
  reconciliation_evidence_sha256: string;
}>;

export type StandingAggregateReservation = Readonly<{
  reservation_id: string;
  child_ledger_id: string;
  session_id: string;
  trial_id: string;
  purpose: "api_testing" | "benchmark";
  admission_operation_id: string;
  admission_request_sha256: string;
  admitted_at: string;
  maximum_micro_usd: number;
  conservative_micro_usd: number;
  settlement_operation_id: string | null;
  settlement_request_sha256: string | null;
  settled_at: string | null;
  costs: AggregateCosts | null;
}>;

export type StandingAggregateBudgetLedger = Readonly<{
  schema_version: 1;
  kind: typeof KIND;
  authority_id: typeof AUTHORITY_ID;
  currency: "USD";
  genesis_micro_usd: typeof STANDING_GENESIS_MICRO_USD;
  hard_ceiling_exclusive_micro_usd: typeof STANDING_HARD_CEILING_EXCLUSIVE_MICRO_USD;
  sequence: number;
  created_at: string;
  updated_at: string;
  reservations: readonly StandingAggregateReservation[];
  integrity_sha256: string;
}>;

export type StandingAggregateBudgetSnapshot = Readonly<{
  authority_id: typeof AUTHORITY_ID;
  sequence: number;
  genesis_micro_usd: number;
  registered_conservative_micro_usd: number;
  aggregate_conservative_micro_usd: number;
  hard_ceiling_exclusive_micro_usd: number;
  remaining_before_exclusive_ceiling_micro_usd: number;
  state: "open" | "closed" | "breached";
  reservation_count: number;
  integrity_sha256: string;
  usd: Readonly<{
    genesis: string;
    registered_conservative: string;
    aggregate_conservative: string;
    remaining_before_exclusive_ceiling: string;
  }>;
}>;

export type StandingAggregateStoreOptions = Readonly<{
  aggregateLedgerPath: string;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}>;

const LEDGER_KEYS = [
  "authority_id", "created_at", "currency", "genesis_micro_usd",
  "hard_ceiling_exclusive_micro_usd", "integrity_sha256", "kind", "reservations",
  "schema_version", "sequence", "updated_at",
].sort();
const RESERVATION_KEYS = [
  "admission_operation_id", "admission_request_sha256", "admitted_at", "child_ledger_id",
  "conservative_micro_usd", "costs", "maximum_micro_usd", "purpose", "reservation_id",
  "session_id", "settled_at", "settlement_operation_id", "settlement_request_sha256", "trial_id",
].sort();
const COST_KEYS = [
  "estimated_micro_usd", "provider_reported_micro_usd", "reconciled_micro_usd",
  "reconciliation_evidence_sha256",
].sort();

function fail(code: StandingAggregateBudgetErrorCode, message: string, cause?: unknown): never {
  throw new StandingAggregateBudgetError(code, message, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isMicroUsd(value: unknown, positive = false): value is number {
  return Number.isSafeInteger(value) && (positive ? (value as number) > 0 : (value as number) >= 0);
}

function assertIdentifier(value: unknown, label: string, code: "invalid_request" | "corrupt_ledger"): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code, `${label} is invalid`);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function safeSum(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    if (!isMicroUsd(value)) fail("corrupt_ledger", "Aggregate ledger contains an invalid amount");
    sum += value;
    if (!Number.isSafeInteger(sum)) fail("corrupt_ledger", "Aggregate exposure exceeds safe integer precision");
  }
  return sum;
}

function unsigned(ledger: StandingAggregateBudgetLedger): Omit<StandingAggregateBudgetLedger, "integrity_sha256"> {
  return {
    schema_version: ledger.schema_version,
    kind: ledger.kind,
    authority_id: ledger.authority_id,
    currency: ledger.currency,
    genesis_micro_usd: ledger.genesis_micro_usd,
    hard_ceiling_exclusive_micro_usd: ledger.hard_ceiling_exclusive_micro_usd,
    sequence: ledger.sequence,
    created_at: ledger.created_at,
    updated_at: ledger.updated_at,
    reservations: ledger.reservations,
  };
}

function integrity(ledger: StandingAggregateBudgetLedger): string {
  return sha256Hex(INTEGRITY_DOMAIN + canonicalJson(unsigned(ledger)));
}

function seal(input: Omit<StandingAggregateBudgetLedger, "integrity_sha256">): StandingAggregateBudgetLedger {
  const ledger = { ...input, integrity_sha256: "" } as StandingAggregateBudgetLedger;
  return Object.freeze({ ...input, integrity_sha256: integrity(ledger) });
}

export function assertValidStandingAggregateBudgetLedger(value: unknown): asserts value is StandingAggregateBudgetLedger {
  if (!isRecord(value) || !exact(value, LEDGER_KEYS)) fail("corrupt_ledger", "Standing aggregate ledger shape is invalid");
  if (value.schema_version !== 1 || value.kind !== KIND || value.authority_id !== AUTHORITY_ID
    || value.currency !== "USD" || value.genesis_micro_usd !== STANDING_GENESIS_MICRO_USD
    || value.hard_ceiling_exclusive_micro_usd !== STANDING_HARD_CEILING_EXCLUSIVE_MICRO_USD) {
    fail("corrupt_ledger", "Standing authority identity or ceiling is invalid");
  }
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1
    || !isTimestamp(value.created_at) || !isTimestamp(value.updated_at)
    || !Array.isArray(value.reservations)) {
    fail("corrupt_ledger", "Standing aggregate ledger metadata is invalid");
  }
  const reservationIds = new Set<string>();
  const trialIds = new Set<string>();
  const admissionOperations = new Set<string>();
  const settlementOperations = new Set<string>();
  let mutations = 0;
  for (const raw of value.reservations) {
    if (!isRecord(raw) || !exact(raw, RESERVATION_KEYS)) fail("corrupt_ledger", "Aggregate reservation shape is invalid");
    for (const [label, identifier] of Object.entries({
      reservation_id: raw.reservation_id,
      child_ledger_id: raw.child_ledger_id,
      session_id: raw.session_id,
      trial_id: raw.trial_id,
      admission_operation_id: raw.admission_operation_id,
    })) assertIdentifier(identifier, label, "corrupt_ledger");
    if (reservationIds.has(raw.reservation_id as string)
      || trialIds.has(raw.trial_id as string)
      || admissionOperations.has(raw.admission_operation_id as string)) {
      fail("corrupt_ledger", "Aggregate reservation, trial, and operation IDs must be unique");
    }
    reservationIds.add(raw.reservation_id as string);
    trialIds.add(raw.trial_id as string);
    admissionOperations.add(raw.admission_operation_id as string);
    if ((raw.purpose !== "api_testing" && raw.purpose !== "benchmark")
      || !SHA256.test(String(raw.admission_request_sha256))
      || !isTimestamp(raw.admitted_at)
      || !isMicroUsd(raw.maximum_micro_usd, true)
      || !isMicroUsd(raw.conservative_micro_usd, true)
      || (raw.conservative_micro_usd as number) < (raw.maximum_micro_usd as number)) {
      fail("corrupt_ledger", "Aggregate admission data is invalid");
    }
    mutations += 1;
    if (raw.settlement_operation_id === null) {
      if (raw.settlement_request_sha256 !== null || raw.settled_at !== null || raw.costs !== null
        || raw.conservative_micro_usd !== raw.maximum_micro_usd) {
        fail("corrupt_ledger", "Unsettled aggregate reservation contains settlement data");
      }
    } else {
      assertIdentifier(raw.settlement_operation_id, "settlement_operation_id", "corrupt_ledger");
      if (settlementOperations.has(raw.settlement_operation_id)) fail("corrupt_ledger", "Settlement operation IDs must be unique");
      settlementOperations.add(raw.settlement_operation_id);
      if (!SHA256.test(String(raw.settlement_request_sha256)) || !isTimestamp(raw.settled_at)
        || !isRecord(raw.costs) || !exact(raw.costs, COST_KEYS)) {
        fail("corrupt_ledger", "Aggregate settlement data is invalid");
      }
      const costValues = [raw.costs.estimated_micro_usd, raw.costs.provider_reported_micro_usd, raw.costs.reconciled_micro_usd];
      if (!costValues.every((amount) => isMicroUsd(amount))
        || !SHA256.test(String(raw.costs.reconciliation_evidence_sha256))
        || raw.conservative_micro_usd !== Math.max(raw.maximum_micro_usd as number, ...(costValues as number[]))) {
        fail("corrupt_ledger", "Aggregate conservative settlement is invalid");
      }
      mutations += 1;
    }
  }
  if (value.sequence !== 1 + mutations) fail("corrupt_ledger", "Aggregate sequence does not match its mutations");
  if (!SHA256.test(String(value.integrity_sha256)) || integrity(value as unknown as StandingAggregateBudgetLedger) !== value.integrity_sha256) {
    fail("corrupt_ledger", "Standing aggregate ledger digest is invalid");
  }
  aggregateSnapshot(value as unknown as StandingAggregateBudgetLedger);
}

function aggregateSnapshot(ledger: StandingAggregateBudgetLedger): StandingAggregateBudgetSnapshot {
  const registered = safeSum(ledger.reservations.map((reservation) => reservation.conservative_micro_usd));
  const exposure = safeSum([ledger.genesis_micro_usd, registered]);
  const remaining = Math.max(0, ledger.hard_ceiling_exclusive_micro_usd - exposure - 1);
  return Object.freeze({
    authority_id: ledger.authority_id,
    sequence: ledger.sequence,
    genesis_micro_usd: ledger.genesis_micro_usd,
    registered_conservative_micro_usd: registered,
    aggregate_conservative_micro_usd: exposure,
    hard_ceiling_exclusive_micro_usd: ledger.hard_ceiling_exclusive_micro_usd,
    remaining_before_exclusive_ceiling_micro_usd: remaining,
    state: exposure >= ledger.hard_ceiling_exclusive_micro_usd
      ? "breached"
      : exposure === ledger.hard_ceiling_exclusive_micro_usd - 1 ? "closed" : "open",
    reservation_count: ledger.reservations.length,
    integrity_sha256: ledger.integrity_sha256,
    usd: Object.freeze({
      genesis: microUsdToDecimal(ledger.genesis_micro_usd),
      registered_conservative: microUsdToDecimal(registered),
      aggregate_conservative: microUsdToDecimal(exposure),
      remaining_before_exclusive_ceiling: microUsdToDecimal(remaining),
    }),
  });
}

function assertPath(path: string): void {
  if (!isAbsolute(path) || !basename(path)) fail("unsafe_path", "aggregateLedgerPath must be absolute");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLock<T>(options: StandingAggregateStoreOptions, action: () => Promise<T>): Promise<T> {
  assertPath(options.aggregateLedgerPath);
  const lockPath = `${options.aggregateLedgerPath}.lock`;
  const timeout = options.lockTimeoutMs ?? 10_000;
  const retry = options.lockRetryMs ?? 10;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || !Number.isSafeInteger(retry) || retry < 1) {
    fail("invalid_request", "Lock timing is invalid");
  }
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) fail("lock_timeout", "Standing aggregate lock is unavailable", error);
      await delay(retry);
    }
  }
  try {
    return await action();
  } finally {
    await rmdir(lockPath);
  }
}

async function readLedger(path: string): Promise<StandingAggregateBudgetLedger> {
  assertPath(path);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("missing_ledger", "Standing aggregate ledger is missing", error);
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_LEDGER_BYTES) {
    fail("unsafe_path", "Standing aggregate ledger must be a single-link regular file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail("corrupt_ledger", "Standing aggregate ledger is unreadable", error);
  }
  assertValidStandingAggregateBudgetLedger(parsed);
  return parsed;
}

async function writeLedger(path: string, ledger: StandingAggregateBudgetLedger): Promise<void> {
  assertValidStandingAggregateBudgetLedger(ledger);
  const parent = dirname(path);
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await file.writeFile(canonicalJson(ledger) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
    await chmod(path, 0o600);
    const directory = await open(parent, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function initializeStandingAggregateBudgetLedger(input: StandingAggregateStoreOptions & {
  now?: () => Date;
}): Promise<StandingAggregateBudgetSnapshot> {
  assertPath(input.aggregateLedgerPath);
  await mkdir(dirname(input.aggregateLedgerPath), { recursive: true, mode: 0o700 });
  return withLock(input, async () => {
    try {
      await stat(input.aggregateLedgerPath);
      fail("invalid_request", "Standing aggregate ledger already exists");
    } catch (error) {
      if (error instanceof StandingAggregateBudgetError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const timestamp = (input.now ?? (() => new Date()))().toISOString();
    const ledger = seal({
      schema_version: 1,
      kind: KIND,
      authority_id: AUTHORITY_ID,
      currency: "USD",
      genesis_micro_usd: STANDING_GENESIS_MICRO_USD,
      hard_ceiling_exclusive_micro_usd: STANDING_HARD_CEILING_EXCLUSIVE_MICRO_USD,
      sequence: 1,
      created_at: timestamp,
      updated_at: timestamp,
      reservations: Object.freeze([]),
    });
    await writeLedger(input.aggregateLedgerPath, ledger);
    return aggregateSnapshot(ledger);
  });
}

export async function inspectStandingAggregateBudgetLedger(
  input: StandingAggregateStoreOptions
): Promise<StandingAggregateBudgetSnapshot> {
  return aggregateSnapshot(await readLedger(input.aggregateLedgerPath));
}

function operationHash(kind: "admit" | "settle", payload: unknown): string {
  return sha256Hex(OPERATION_DOMAIN + canonicalJson({ kind, payload }));
}

export async function reserveStandingAggregateBudget(input: StandingAggregateStoreOptions & {
  childLedgerId: string;
  sessionId: string;
  trialId: string;
  purpose: "api_testing" | "benchmark";
  operationId: string;
  maximumMicroUsd: number;
  admittedAt: string;
}): Promise<Readonly<{
  reservation: StandingAggregateReservation;
  snapshot: StandingAggregateBudgetSnapshot;
  idempotent_replay: boolean;
}>> {
  for (const [label, value] of Object.entries({
    childLedgerId: input.childLedgerId,
    sessionId: input.sessionId,
    trialId: input.trialId,
    operationId: input.operationId,
  })) assertIdentifier(value, label, "invalid_request");
  if ((input.purpose !== "api_testing" && input.purpose !== "benchmark")
    || !isMicroUsd(input.maximumMicroUsd, true) || !isTimestamp(input.admittedAt)) {
    fail("invalid_request", "Standing aggregate admission input is invalid");
  }
  const reservationId = `${input.childLedgerId}:${input.sessionId}`;
  const payload = {
    reservation_id: reservationId,
    child_ledger_id: input.childLedgerId,
    session_id: input.sessionId,
    trial_id: input.trialId,
    purpose: input.purpose,
    maximum_micro_usd: input.maximumMicroUsd,
  };
  const hash = operationHash("admit", payload);
  return withLock(input, async () => {
    const ledger = await readLedger(input.aggregateLedgerPath);
    const replay = ledger.reservations.find((entry) => entry.admission_operation_id === input.operationId);
    if (replay) {
      if (replay.admission_request_sha256 !== hash) fail("operation_conflict", "Aggregate admission operation conflicts");
      return Object.freeze({ reservation: replay, snapshot: aggregateSnapshot(ledger), idempotent_replay: true });
    }
    if (ledger.reservations.some((entry) => entry.reservation_id === reservationId)) fail("duplicate_reservation", "Aggregate reservation already exists");
    if (ledger.reservations.some((entry) => entry.trial_id === input.trialId)) fail("duplicate_trial", "Trial is already registered in the standing aggregate");
    const before = aggregateSnapshot(ledger);
    const projected = safeSum([before.aggregate_conservative_micro_usd, input.maximumMicroUsd]);
    if (before.state !== "open" || projected >= ledger.hard_ceiling_exclusive_micro_usd) {
      fail("aggregate_exhausted", "Admission would violate the standing aggregate's exclusive ceiling");
    }
    const reservation: StandingAggregateReservation = Object.freeze({
      reservation_id: reservationId,
      child_ledger_id: input.childLedgerId,
      session_id: input.sessionId,
      trial_id: input.trialId,
      purpose: input.purpose,
      admission_operation_id: input.operationId,
      admission_request_sha256: hash,
      admitted_at: input.admittedAt,
      maximum_micro_usd: input.maximumMicroUsd,
      conservative_micro_usd: input.maximumMicroUsd,
      settlement_operation_id: null,
      settlement_request_sha256: null,
      settled_at: null,
      costs: null,
    });
    const next = seal({
      ...unsigned(ledger),
      sequence: ledger.sequence + 1,
      updated_at: input.admittedAt,
      reservations: Object.freeze([...ledger.reservations, reservation]),
    });
    await writeLedger(input.aggregateLedgerPath, next);
    return Object.freeze({ reservation, snapshot: aggregateSnapshot(next), idempotent_replay: false });
  });
}

export async function settleStandingAggregateBudget(input: StandingAggregateStoreOptions & {
  childLedgerId: string;
  sessionId: string;
  operationId: string;
  estimatedMicroUsd: number;
  providerReportedMicroUsd: number;
  reconciledMicroUsd: number;
  reconciliationEvidenceSha256: string;
  settledAt: string;
}): Promise<StandingAggregateBudgetSnapshot> {
  for (const [label, value] of Object.entries({ childLedgerId: input.childLedgerId, sessionId: input.sessionId, operationId: input.operationId })) {
    assertIdentifier(value, label, "invalid_request");
  }
  const costs = {
    estimated_micro_usd: input.estimatedMicroUsd,
    provider_reported_micro_usd: input.providerReportedMicroUsd,
    reconciled_micro_usd: input.reconciledMicroUsd,
    reconciliation_evidence_sha256: input.reconciliationEvidenceSha256,
  } as const;
  if (![input.estimatedMicroUsd, input.providerReportedMicroUsd, input.reconciledMicroUsd].every((amount) => isMicroUsd(amount))
    || !SHA256.test(input.reconciliationEvidenceSha256) || !isTimestamp(input.settledAt)) {
    fail("invalid_request", "Standing aggregate settlement input is invalid");
  }
  const reservationId = `${input.childLedgerId}:${input.sessionId}`;
  const hash = operationHash("settle", { reservation_id: reservationId, costs });
  return withLock(input, async () => {
    const ledger = await readLedger(input.aggregateLedgerPath);
    const index = ledger.reservations.findIndex((entry) => entry.reservation_id === reservationId);
    if (index < 0) fail("unknown_reservation", "Standing aggregate reservation is missing");
    const current = ledger.reservations[index]!;
    if (current.settlement_operation_id !== null) {
      if (current.settlement_operation_id !== input.operationId || current.settlement_request_sha256 !== hash) {
        fail("invalid_transition", "Aggregate reservation is already settled by another operation");
      }
      return aggregateSnapshot(ledger);
    }
    if (ledger.reservations.some((entry) => entry.settlement_operation_id === input.operationId)) {
      fail("operation_conflict", "Aggregate settlement operation ID is already used");
    }
    const settled: StandingAggregateReservation = Object.freeze({
      ...current,
      conservative_micro_usd: Math.max(current.maximum_micro_usd, input.estimatedMicroUsd, input.providerReportedMicroUsd, input.reconciledMicroUsd),
      settlement_operation_id: input.operationId,
      settlement_request_sha256: hash,
      settled_at: input.settledAt,
      costs: Object.freeze(costs),
    });
    const reservations = ledger.reservations.map((entry, currentIndex) => currentIndex === index ? settled : entry);
    const next = seal({
      ...unsigned(ledger),
      sequence: ledger.sequence + 1,
      updated_at: input.settledAt,
      reservations: Object.freeze(reservations),
    });
    await writeLedger(input.aggregateLedgerPath, next);
    return aggregateSnapshot(next);
  });
}

export function standingAggregatePathSha256(path: string): string {
  assertPath(path);
  return sha256Hex(path);
}

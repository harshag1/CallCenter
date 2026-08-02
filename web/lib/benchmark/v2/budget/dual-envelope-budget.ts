import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { canonicalJson, sha256Hex } from "../../artifacts";
import { microUsdToDecimal } from "../../budget";

const LEDGER_KIND = "hacc_dual_envelope_budget_ledger" as const;
const INTEGRITY_DOMAIN = "harshas-amazing-call-center/dual-envelope-budget-ledger/v1\n";
const OPERATION_DOMAIN = "harshas-amazing-call-center/dual-envelope-budget-operation/v1\n";
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const API_TESTING_CEILING_MICRO_USD = 100_000_000 as const;
export const BENCHMARK_CEILING_MICRO_USD = 100_000_000 as const;

export type SpendPurpose = "api_testing" | "benchmark";
export type SessionStatus = "opened" | "terminal" | "settled";
export type TerminalOutcome = "completed" | "failed" | "cancelled" | "ambiguous";

export type DualEnvelopeBudgetErrorCode =
  | "missing_ledger"
  | "corrupt_ledger"
  | "invalid_request"
  | "unsafe_path"
  | "lock_timeout"
  | "operation_conflict"
  | "duplicate_session"
  | "duplicate_trial"
  | "prohibited_attempt"
  | "envelope_exhausted"
  | "unknown_session"
  | "invalid_transition";

export class DualEnvelopeBudgetError extends Error {
  readonly code: DualEnvelopeBudgetErrorCode;

  constructor(code: DualEnvelopeBudgetErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DualEnvelopeBudgetError";
    this.code = code;
  }
}

type SessionCosts = Readonly<{
  estimated_micro_usd: number | null;
  provider_reported_micro_usd: number | null;
  reconciled_micro_usd: number | null;
  reconciliation_evidence_sha256: string | null;
}>;

export type DualEnvelopeSession = Readonly<{
  session_id: string;
  trial_id: string;
  purpose: SpendPurpose;
  provider: string;
  model: string;
  admitted_at: string;
  maximum_micro_usd: number;
  attempt: 1;
  retry_of: null;
  replacement_for: null;
  fallback_from: null;
  admission_operation_id: string;
  admission_id: string;
  status: SessionStatus;
  terminal_at: string | null;
  terminal_outcome: TerminalOutcome | null;
  costs: SessionCosts;
}>;

type AppliedOperation = Readonly<{
  operation_id: string;
  operation_kind: "session.admitted" | "session.terminal" | "session.settled";
  request_sha256: string;
  applied_sequence: number;
}>;

export type DualEnvelopeBudgetLedger = Readonly<{
  schema_version: 1;
  kind: typeof LEDGER_KIND;
  ledger_id: string;
  currency: "USD";
  ceilings_micro_usd: Readonly<Record<SpendPurpose, number>>;
  sequence: number;
  created_at: string;
  updated_at: string;
  sessions: readonly DualEnvelopeSession[];
  operations: readonly AppliedOperation[];
  integrity_sha256: string;
}>;

export type EnvelopeSnapshot = Readonly<{
  purpose: SpendPurpose;
  ceiling_micro_usd: number;
  unsettled_reservations_micro_usd: number;
  reconciled_spend_micro_usd: number;
  conservative_exposure_micro_usd: number;
  remaining_micro_usd: number;
  opened_sessions_itt: number;
  terminal_sessions: number;
  settled_sessions: number;
  state: "open" | "closed" | "breached";
  usd: Readonly<{
    ceiling: string;
    conservative_exposure: string;
    remaining: string;
  }>;
}>;

export type DualEnvelopeBudgetSnapshot = Readonly<{
  ledger_id: string;
  sequence: number;
  integrity_sha256: string;
  envelopes: Readonly<Record<SpendPurpose, EnvelopeSnapshot>>;
  opened_session_ids_itt: readonly string[];
}>;

export type NetworkAdmission = Readonly<{
  /** True exactly once, after the receipt exists durably and before network I/O. */
  network_may_open: boolean;
  disposition: "newly_admitted" | "already_opened_quarantine";
  session_id: string;
  trial_id: string;
  purpose: SpendPurpose;
  admission_id: string;
  admitted_sequence: number;
  maximum_micro_usd: number;
  ledger_integrity_sha256: string;
}>;

export type LedgerStoreOptions = Readonly<{
  ledgerPath: string;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}>;

export type InitializeDualEnvelopeBudgetInput = LedgerStoreOptions & Readonly<{
  ledgerId: string;
  now?: () => Date;
}>;

export type AdmitDualEnvelopeSessionInput = LedgerStoreOptions & Readonly<{
  operationId: string;
  sessionId: string;
  trialId: string;
  purpose: SpendPurpose;
  provider: string;
  model: string;
  maximumMicroUsd: number;
  attempt: 1;
  retryOf: null;
  replacementFor: null;
  fallbackFrom: null;
  now?: () => Date;
  randomId?: () => string;
}>;

export type RecordDualEnvelopeTerminalInput = LedgerStoreOptions & Readonly<{
  operationId: string;
  sessionId: string;
  outcome: TerminalOutcome;
  now?: () => Date;
}>;

export type SettleDualEnvelopeSessionInput = LedgerStoreOptions & Readonly<{
  operationId: string;
  sessionId: string;
  estimatedMicroUsd: number;
  providerReportedMicroUsd: number;
  reconciledMicroUsd: number;
  reconciliationEvidenceSha256: string;
  now?: () => Date;
}>;

const LEDGER_KEYS = Object.freeze([
  "ceilings_micro_usd", "created_at", "currency", "integrity_sha256", "kind",
  "ledger_id", "operations", "schema_version", "sequence", "sessions", "updated_at",
].sort());
const SESSION_KEYS = Object.freeze([
  "admission_id", "admission_operation_id", "admitted_at", "attempt", "costs",
  "fallback_from", "maximum_micro_usd", "model", "provider", "purpose",
  "replacement_for", "retry_of", "session_id", "status", "terminal_at",
  "terminal_outcome", "trial_id",
].sort());
const COST_KEYS = Object.freeze([
  "estimated_micro_usd", "provider_reported_micro_usd", "reconciled_micro_usd",
  "reconciliation_evidence_sha256",
].sort());
const OPERATION_KEYS = Object.freeze([
  "applied_sequence", "operation_id", "operation_kind", "request_sha256",
].sort());
const CEILING_KEYS = Object.freeze(["api_testing", "benchmark"]);

function fail(code: DualEnvelopeBudgetErrorCode, message: string, cause?: unknown): never {
  throw new DualEnvelopeBudgetError(code, message, cause === undefined ? undefined : { cause });
}

function hasExactlyKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMicroUsd(value: unknown, positive = false): value is number {
  return Number.isSafeInteger(value) && (positive ? (value as number) > 0 : (value as number) >= 0);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("invalid_request", `${label} must match ${IDENTIFIER.source}`);
  }
}

function assertLedgerIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("corrupt_ledger", `${label} is invalid`);
  }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function safeSum(values: readonly number[], label: string): number {
  let result = 0;
  for (const value of values) {
    if (!isMicroUsd(value)) fail("corrupt_ledger", `${label} contains an invalid micro-USD amount`);
    result += value;
    if (!Number.isSafeInteger(result)) fail("corrupt_ledger", `${label} exceeds integer precision`);
  }
  return result;
}

function ledgerWithoutIntegrity(ledger: DualEnvelopeBudgetLedger): Omit<DualEnvelopeBudgetLedger, "integrity_sha256"> {
  return {
    schema_version: ledger.schema_version,
    kind: ledger.kind,
    ledger_id: ledger.ledger_id,
    currency: ledger.currency,
    ceilings_micro_usd: ledger.ceilings_micro_usd,
    sequence: ledger.sequence,
    created_at: ledger.created_at,
    updated_at: ledger.updated_at,
    sessions: ledger.sessions,
    operations: ledger.operations,
  };
}

function ledgerIntegrity(ledger: DualEnvelopeBudgetLedger): string {
  return sha256Hex(INTEGRITY_DOMAIN + canonicalJson(ledgerWithoutIntegrity(ledger)));
}

function sealLedger(
  ledger: Omit<DualEnvelopeBudgetLedger, "integrity_sha256">
): DualEnvelopeBudgetLedger {
  const unsealed = { ...ledger, integrity_sha256: "" } as DualEnvelopeBudgetLedger;
  return Object.freeze({ ...ledger, integrity_sha256: ledgerIntegrity(unsealed) });
}

function validateCosts(costs: unknown, status: SessionStatus): asserts costs is SessionCosts {
  if (!isRecord(costs) || !hasExactlyKeys(costs, COST_KEYS)) {
    fail("corrupt_ledger", "Session costs have an invalid shape");
  }
  const amounts = [
    costs.estimated_micro_usd,
    costs.provider_reported_micro_usd,
    costs.reconciled_micro_usd,
  ];
  if (!amounts.every((amount) => amount === null || isMicroUsd(amount))) {
    fail("corrupt_ledger", "Session costs contain an invalid micro-USD amount");
  }
  if (status === "settled") {
    if (amounts.some((amount) => amount === null) || !SHA256.test(String(costs.reconciliation_evidence_sha256))) {
      fail("corrupt_ledger", "A settled session requires all cost channels and reconciliation evidence");
    }
  } else if (amounts.some((amount) => amount !== null) || costs.reconciliation_evidence_sha256 !== null) {
    fail("corrupt_ledger", "Only settled sessions may contain observed costs");
  }
}

/** Strictly validates shape, integrity, invariants, and both independent envelopes. */
export function assertValidDualEnvelopeBudgetLedger(value: unknown): asserts value is DualEnvelopeBudgetLedger {
  if (!isRecord(value) || !hasExactlyKeys(value, LEDGER_KEYS)) {
    fail("corrupt_ledger", "Budget ledger is missing fields or contains unknown fields");
  }
  if (value.schema_version !== 1 || value.kind !== LEDGER_KIND || value.currency !== "USD") {
    fail("corrupt_ledger", "Budget ledger identity is invalid");
  }
  assertLedgerIdentifier(value.ledger_id, "ledger_id");
  if (!isRecord(value.ceilings_micro_usd)
    || !hasExactlyKeys(value.ceilings_micro_usd, CEILING_KEYS)
    || value.ceilings_micro_usd.api_testing !== API_TESTING_CEILING_MICRO_USD
    || value.ceilings_micro_usd.benchmark !== BENCHMARK_CEILING_MICRO_USD) {
    fail("corrupt_ledger", "Both non-transferable envelope ceilings must be exactly $100");
  }
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) {
    fail("corrupt_ledger", "Ledger sequence is invalid");
  }
  if (!isTimestamp(value.created_at) || !isTimestamp(value.updated_at)) {
    fail("corrupt_ledger", "Ledger timestamps are invalid");
  }
  if (!Array.isArray(value.sessions) || !Array.isArray(value.operations)) {
    fail("corrupt_ledger", "Ledger sessions and operations must be arrays");
  }

  const sessionIds = new Set<string>();
  const trialIds = new Set<string>();
  for (const raw of value.sessions) {
    if (!isRecord(raw) || !hasExactlyKeys(raw, SESSION_KEYS)) fail("corrupt_ledger", "Session shape is invalid");
    assertLedgerIdentifier(raw.session_id, "session_id");
    assertLedgerIdentifier(raw.trial_id, "trial_id");
    assertLedgerIdentifier(raw.provider, "provider");
    assertLedgerIdentifier(raw.model, "model");
    assertLedgerIdentifier(raw.admission_operation_id, "admission_operation_id");
    assertLedgerIdentifier(raw.admission_id, "admission_id");
    if (sessionIds.has(raw.session_id as string)) fail("corrupt_ledger", "Session IDs must be unique");
    if (trialIds.has(raw.trial_id as string)) fail("corrupt_ledger", "Trial IDs must be globally unique across envelopes");
    sessionIds.add(raw.session_id as string);
    trialIds.add(raw.trial_id as string);
    if (raw.purpose !== "api_testing" && raw.purpose !== "benchmark") fail("corrupt_ledger", "Session purpose is invalid");
    if (!isTimestamp(raw.admitted_at) || !isMicroUsd(raw.maximum_micro_usd, true)) {
      fail("corrupt_ledger", "Session admission data is invalid");
    }
    if (raw.attempt !== 1 || raw.retry_of !== null || raw.replacement_for !== null || raw.fallback_from !== null) {
      fail("corrupt_ledger", "Retries, replacements, and fallbacks are prohibited");
    }
    if (raw.status !== "opened" && raw.status !== "terminal" && raw.status !== "settled") {
      fail("corrupt_ledger", "Session status is invalid");
    }
    if (raw.status === "opened") {
      if (raw.terminal_at !== null || raw.terminal_outcome !== null) fail("corrupt_ledger", "Opened session has terminal data");
    } else if (!isTimestamp(raw.terminal_at)
      || !["completed", "failed", "cancelled", "ambiguous"].includes(String(raw.terminal_outcome))) {
      fail("corrupt_ledger", "Terminal session data is invalid");
    }
    if (Date.parse(raw.admitted_at as string) < Date.parse(value.created_at as string)
      || Date.parse(raw.admitted_at as string) > Date.parse(value.updated_at as string)
      || (raw.terminal_at !== null && Date.parse(raw.terminal_at as string) < Date.parse(raw.admitted_at as string))) {
      fail("corrupt_ledger", "Session timestamps violate ledger chronology");
    }
    validateCosts(raw.costs, raw.status);
  }

  const operationIds = new Set<string>();
  const operationsById = new Map<string, Record<string, unknown>>();
  for (const [index, raw] of value.operations.entries()) {
    if (!isRecord(raw) || !hasExactlyKeys(raw, OPERATION_KEYS)) fail("corrupt_ledger", "Operation shape is invalid");
    assertLedgerIdentifier(raw.operation_id, "operation_id");
    if (operationIds.has(raw.operation_id as string)) fail("corrupt_ledger", "Operation IDs must be unique");
    operationIds.add(raw.operation_id as string);
    if (!["session.admitted", "session.terminal", "session.settled"].includes(String(raw.operation_kind))
      || !SHA256.test(String(raw.request_sha256))
      || !Number.isSafeInteger(raw.applied_sequence)
      || raw.applied_sequence !== index + 2) {
      fail("corrupt_ledger", "Operation data is invalid");
    }
    operationsById.set(raw.operation_id as string, raw);
  }
  if (value.sequence !== 1 + value.operations.length) fail("corrupt_ledger", "Ledger sequence does not match operation history");
  const sessions = value.sessions as unknown as DualEnvelopeSession[];
  const operationKindCount = (kind: AppliedOperation["operation_kind"]) =>
    (value.operations as unknown as AppliedOperation[]).filter((operation) => operation.operation_kind === kind).length;
  if (operationKindCount("session.admitted") !== sessions.length
    || operationKindCount("session.terminal") !== sessions.filter((session) => session.status !== "opened").length
    || operationKindCount("session.settled") !== sessions.filter((session) => session.status === "settled").length) {
    fail("corrupt_ledger", "Operation history does not match session lifecycle state");
  }
  for (const session of sessions) {
    const admissionOperation = operationsById.get(session.admission_operation_id);
    if (!admissionOperation || admissionOperation.operation_kind !== "session.admitted") {
      fail("corrupt_ledger", "Session admission operation is missing or invalid");
    }
  }
  if (!SHA256.test(String(value.integrity_sha256))
    || ledgerIntegrity(value as unknown as DualEnvelopeBudgetLedger) !== value.integrity_sha256) {
    fail("corrupt_ledger", "Budget ledger integrity digest does not match its contents");
  }

  // Computing snapshots validates safe sums. A breached envelope is valid
  // historical evidence, but all subsequent admissions will fail closed.
  envelopeSnapshot(value as unknown as DualEnvelopeBudgetLedger, "api_testing");
  envelopeSnapshot(value as unknown as DualEnvelopeBudgetLedger, "benchmark");
}

function envelopeSnapshot(ledger: DualEnvelopeBudgetLedger, purpose: SpendPurpose): EnvelopeSnapshot {
  const sessions = ledger.sessions.filter((session) => session.purpose === purpose);
  const unsettled = safeSum(
    sessions.filter((session) => session.status !== "settled").map((session) => session.maximum_micro_usd),
    `${purpose} unsettled reservations`
  );
  const reconciled = safeSum(
    sessions.filter((session) => session.status === "settled").map((session) => session.costs.reconciled_micro_usd!),
    `${purpose} reconciled spend`
  );
  const exposure = safeSum([unsettled, reconciled], `${purpose} conservative exposure`);
  const ceiling = ledger.ceilings_micro_usd[purpose];
  const remaining = Math.max(0, ceiling - exposure);
  return Object.freeze({
    purpose,
    ceiling_micro_usd: ceiling,
    unsettled_reservations_micro_usd: unsettled,
    reconciled_spend_micro_usd: reconciled,
    conservative_exposure_micro_usd: exposure,
    remaining_micro_usd: remaining,
    opened_sessions_itt: sessions.length,
    terminal_sessions: sessions.filter((session) => session.status !== "opened").length,
    settled_sessions: sessions.filter((session) => session.status === "settled").length,
    state: exposure > ceiling ? "breached" : exposure === ceiling ? "closed" : "open",
    usd: Object.freeze({
      ceiling: microUsdToDecimal(ceiling),
      conservative_exposure: microUsdToDecimal(exposure),
      remaining: microUsdToDecimal(remaining),
    }),
  });
}

export function dualEnvelopeBudgetSnapshot(ledger: DualEnvelopeBudgetLedger): DualEnvelopeBudgetSnapshot {
  assertValidDualEnvelopeBudgetLedger(ledger);
  return Object.freeze({
    ledger_id: ledger.ledger_id,
    sequence: ledger.sequence,
    integrity_sha256: ledger.integrity_sha256,
    envelopes: Object.freeze({
      api_testing: envelopeSnapshot(ledger, "api_testing"),
      benchmark: envelopeSnapshot(ledger, "benchmark"),
    }),
    opened_session_ids_itt: Object.freeze(ledger.sessions.map((session) => session.session_id)),
  });
}

function requestHash(kind: AppliedOperation["operation_kind"], payload: unknown): string {
  return sha256Hex(OPERATION_DOMAIN + canonicalJson({ kind, payload }));
}

function nowIso(now?: () => Date): string {
  const value = (now ?? (() => new Date()))().toISOString();
  if (!isTimestamp(value)) fail("invalid_request", "now() did not produce a valid timestamp");
  return value;
}

function assertStorePath(ledgerPath: string): void {
  if (!isAbsolute(ledgerPath) || basename(ledgerPath).length === 0) {
    fail("unsafe_path", "ledgerPath must be an absolute file path");
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLock<T>(options: LedgerStoreOptions, action: () => Promise<T>): Promise<T> {
  assertStorePath(options.ledgerPath);
  const lockPath = `${options.ledgerPath}.lock`;
  const timeout = options.lockTimeoutMs ?? 10_000;
  const retry = options.lockRetryMs ?? 10;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || !Number.isSafeInteger(retry) || retry < 1) {
    fail("invalid_request", "Lock timing must use non-negative integer milliseconds");
  }
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      await mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) fail("lock_timeout", "Budget ledger lock is unavailable; refusing admission", error);
      await sleep(retry);
    }
  }
  try {
    return await action();
  } finally {
    await rmdir(lockPath);
  }
}

async function readLedger(ledgerPath: string): Promise<DualEnvelopeBudgetLedger> {
  assertStorePath(ledgerPath);
  let metadata;
  try {
    metadata = await lstat(ledgerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("missing_ledger", "Budget ledger is missing; refusing admission", error);
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_LEDGER_BYTES) {
    fail("unsafe_path", "Budget ledger must be a private, single-link regular file within the size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(ledgerPath, "utf8"));
  } catch (error) {
    fail("corrupt_ledger", "Budget ledger is unreadable or invalid JSON", error);
  }
  assertValidDualEnvelopeBudgetLedger(parsed);
  return parsed;
}

async function writeLedgerAtomic(ledgerPath: string, ledger: DualEnvelopeBudgetLedger): Promise<void> {
  assertValidDualEnvelopeBudgetLedger(ledger);
  const parent = dirname(ledgerPath);
  const tempPath = join(parent, `.${basename(ledgerPath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(canonicalJson(ledger) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, ledgerPath);
    await chmod(ledgerPath, PRIVATE_FILE_MODE);
    const directory = await open(parent, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function initializeDualEnvelopeBudgetLedger(
  input: InitializeDualEnvelopeBudgetInput
): Promise<DualEnvelopeBudgetSnapshot> {
  assertStorePath(input.ledgerPath);
  assertIdentifier(input.ledgerId, "ledgerId");
  await mkdir(dirname(input.ledgerPath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  return withLock(input, async () => {
    try {
      await stat(input.ledgerPath);
      fail("invalid_request", "Budget ledger already exists and will not be replaced");
    } catch (error) {
      if (error instanceof DualEnvelopeBudgetError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const timestamp = nowIso(input.now);
    const ledger = sealLedger({
      schema_version: 1,
      kind: LEDGER_KIND,
      ledger_id: input.ledgerId,
      currency: "USD",
      ceilings_micro_usd: Object.freeze({
        api_testing: API_TESTING_CEILING_MICRO_USD,
        benchmark: BENCHMARK_CEILING_MICRO_USD,
      }),
      sequence: 1,
      created_at: timestamp,
      updated_at: timestamp,
      sessions: Object.freeze([]),
      operations: Object.freeze([]),
    });
    await writeLedgerAtomic(input.ledgerPath, ledger);
    return dualEnvelopeBudgetSnapshot(ledger);
  });
}

export async function inspectDualEnvelopeBudgetLedger(
  input: LedgerStoreOptions
): Promise<DualEnvelopeBudgetSnapshot> {
  const ledger = await readLedger(input.ledgerPath);
  return dualEnvelopeBudgetSnapshot(ledger);
}

type MutationResult<T> = Readonly<{
  value: T;
  snapshot: DualEnvelopeBudgetSnapshot;
  idempotent_replay: boolean;
}>;

async function mutate<T>(options: LedgerStoreOptions & {
  operationId: string;
  kind: AppliedOperation["operation_kind"];
  payload: unknown;
  now?: () => Date;
  replayValue: (ledger: DualEnvelopeBudgetLedger) => T;
  apply: (ledger: DualEnvelopeBudgetLedger, timestamp: string) => Readonly<{
    sessions: readonly DualEnvelopeSession[];
    value: (ledger: DualEnvelopeBudgetLedger) => T;
  }>;
}): Promise<MutationResult<T>> {
  assertIdentifier(options.operationId, "operationId");
  const hash = requestHash(options.kind, options.payload);
  return withLock(options, async () => {
    const current = await readLedger(options.ledgerPath);
    const previous = current.operations.find((operation) => operation.operation_id === options.operationId);
    if (previous) {
      if (previous.operation_kind !== options.kind || previous.request_sha256 !== hash) {
        fail("operation_conflict", `Operation ${options.operationId} was already used with different inputs`);
      }
      return Object.freeze({
        value: options.replayValue(current),
        snapshot: dualEnvelopeBudgetSnapshot(current),
        idempotent_replay: true,
      });
    }
    const timestamp = nowIso(options.now);
    const applied = options.apply(current, timestamp);
    const nextSequence = current.sequence + 1;
    const operation: AppliedOperation = Object.freeze({
      operation_id: options.operationId,
      operation_kind: options.kind,
      request_sha256: hash,
      applied_sequence: nextSequence,
    });
    const next = sealLedger({
      ...ledgerWithoutIntegrity(current),
      sequence: nextSequence,
      updated_at: timestamp,
      sessions: Object.freeze([...applied.sessions]),
      operations: Object.freeze([...current.operations, operation]),
    });
    await writeLedgerAtomic(options.ledgerPath, next);
    return Object.freeze({
      value: applied.value(next),
      snapshot: dualEnvelopeBudgetSnapshot(next),
      idempotent_replay: false,
    });
  });
}

/**
 * Atomically reserves pessimistic cost and records an opened ITT session.
 * A runner must not perform DNS, connect, or send provider bytes until this
 * function returns `network_may_open: true`.
 */
export async function admitDualEnvelopeSession(
  input: AdmitDualEnvelopeSessionInput
): Promise<MutationResult<NetworkAdmission>> {
  assertIdentifier(input.sessionId, "sessionId");
  assertIdentifier(input.trialId, "trialId");
  assertIdentifier(input.provider, "provider");
  assertIdentifier(input.model, "model");
  if (input.purpose !== "api_testing" && input.purpose !== "benchmark") fail("invalid_request", "purpose is invalid");
  if (!isMicroUsd(input.maximumMicroUsd, true)) fail("invalid_request", "maximumMicroUsd must be a positive safe integer");
  if (input.attempt !== 1 || input.retryOf !== null || input.replacementFor !== null || input.fallbackFrom !== null) {
    fail("prohibited_attempt", "Paid retries, replacements, and provider fallbacks are prohibited");
  }
  const admissionId = input.randomId ?? randomUUID;
  const payload = {
    session_id: input.sessionId,
    trial_id: input.trialId,
    purpose: input.purpose,
    provider: input.provider,
    model: input.model,
    maximum_micro_usd: input.maximumMicroUsd,
    attempt: input.attempt,
    retry_of: input.retryOf,
    replacement_for: input.replacementFor,
    fallback_from: input.fallbackFrom,
  } as const;
  return mutate({
    ...input,
    kind: "session.admitted",
    payload,
    // A replay proves the first operation committed but cannot prove whether
    // its caller crossed network admission. It is therefore quarantined, not
    // reissued as a second paid permit.
    replayValue: (ledger) => admissionFrom(ledger, input.sessionId, false),
    apply: (ledger, timestamp) => {
      const existing = ledger.sessions.find((session) => session.session_id === input.sessionId);
      if (existing) {
        fail("duplicate_session", `Session ${input.sessionId} has already been admitted`);
      }
      if (ledger.sessions.some((session) => session.trial_id === input.trialId)) {
        fail("duplicate_trial", "A logical trial may be opened only once across both envelopes");
      }
      const purposeSnapshot = envelopeSnapshot(ledger, input.purpose);
      if (purposeSnapshot.state !== "open"
        || purposeSnapshot.conservative_exposure_micro_usd + input.maximumMicroUsd
          > purposeSnapshot.ceiling_micro_usd) {
        fail("envelope_exhausted", `${input.purpose} cannot spend capacity from the other envelope`);
      }
      const session: DualEnvelopeSession = Object.freeze({
        session_id: input.sessionId,
        trial_id: input.trialId,
        purpose: input.purpose,
        provider: input.provider,
        model: input.model,
        admitted_at: timestamp,
        maximum_micro_usd: input.maximumMicroUsd,
        attempt: 1,
        retry_of: null,
        replacement_for: null,
        fallback_from: null,
        admission_operation_id: input.operationId,
        admission_id: admissionId(),
        status: "opened",
        terminal_at: null,
        terminal_outcome: null,
        costs: Object.freeze({
          estimated_micro_usd: null,
          provider_reported_micro_usd: null,
          reconciled_micro_usd: null,
          reconciliation_evidence_sha256: null,
        }),
      });
      return { sessions: [...ledger.sessions, session], value: (current) => admissionFrom(current, session.session_id, true) };
    },
  });
}

function admissionFrom(
  ledger: DualEnvelopeBudgetLedger,
  sessionId: string,
  networkMayOpen: boolean
): NetworkAdmission {
  const session = ledger.sessions.find((candidate) => candidate.session_id === sessionId);
  if (!session) fail("corrupt_ledger", "Admission operation does not reference a session");
  const operation = ledger.operations.find((candidate) => candidate.operation_id === session.admission_operation_id);
  if (!operation) fail("corrupt_ledger", "Admission session does not reference an operation");
  return Object.freeze({
    network_may_open: networkMayOpen,
    disposition: networkMayOpen ? "newly_admitted" : "already_opened_quarantine",
    session_id: session.session_id,
    trial_id: session.trial_id,
    purpose: session.purpose,
    admission_id: session.admission_id,
    admitted_sequence: operation.applied_sequence,
    maximum_micro_usd: session.maximum_micro_usd,
    ledger_integrity_sha256: ledger.integrity_sha256,
  });
}

function replaceSession(
  ledger: DualEnvelopeBudgetLedger,
  sessionId: string,
  update: (session: DualEnvelopeSession) => DualEnvelopeSession
): readonly DualEnvelopeSession[] {
  const index = ledger.sessions.findIndex((session) => session.session_id === sessionId);
  if (index < 0) fail("unknown_session", `Unknown session ${sessionId}`);
  return ledger.sessions.map((session, current) => current === index ? update(session) : session);
}

export async function recordDualEnvelopeTerminal(
  input: RecordDualEnvelopeTerminalInput
): Promise<MutationResult<DualEnvelopeSession>> {
  assertIdentifier(input.sessionId, "sessionId");
  if (!["completed", "failed", "cancelled", "ambiguous"].includes(input.outcome)) {
    fail("invalid_request", "Terminal outcome is invalid");
  }
  const payload = { session_id: input.sessionId, outcome: input.outcome } as const;
  return mutate({
    ...input,
    kind: "session.terminal",
    payload,
    replayValue: (ledger) => {
      const session = ledger.sessions.find((candidate) => candidate.session_id === input.sessionId);
      if (!session) fail("corrupt_ledger", "Terminal operation does not reference a session");
      return session;
    },
    apply: (ledger, timestamp) => ({
      sessions: replaceSession(ledger, input.sessionId, (session) => {
        if (session.status !== "opened") fail("invalid_transition", "Only an opened session can become terminal");
        return Object.freeze({
          ...session,
          status: "terminal",
          terminal_at: timestamp,
          terminal_outcome: input.outcome,
        });
      }),
      value: (current) => current.sessions.find((session) => session.session_id === input.sessionId)!,
    }),
  });
}

export async function settleDualEnvelopeSession(
  input: SettleDualEnvelopeSessionInput
): Promise<MutationResult<DualEnvelopeSession>> {
  assertIdentifier(input.sessionId, "sessionId");
  for (const [label, value] of [
    ["estimatedMicroUsd", input.estimatedMicroUsd],
    ["providerReportedMicroUsd", input.providerReportedMicroUsd],
    ["reconciledMicroUsd", input.reconciledMicroUsd],
  ] as const) {
    if (!isMicroUsd(value)) fail("invalid_request", `${label} must be a non-negative safe integer`);
  }
  if (!SHA256.test(input.reconciliationEvidenceSha256)) {
    fail("invalid_request", "reconciliationEvidenceSha256 must be a lowercase SHA-256 digest");
  }
  const payload = {
    session_id: input.sessionId,
    estimated_micro_usd: input.estimatedMicroUsd,
    provider_reported_micro_usd: input.providerReportedMicroUsd,
    reconciled_micro_usd: input.reconciledMicroUsd,
    reconciliation_evidence_sha256: input.reconciliationEvidenceSha256,
  } as const;
  return mutate({
    ...input,
    kind: "session.settled",
    payload,
    replayValue: (ledger) => {
      const session = ledger.sessions.find((candidate) => candidate.session_id === input.sessionId);
      if (!session) fail("corrupt_ledger", "Settlement operation does not reference a session");
      return session;
    },
    apply: (ledger) => ({
      sessions: replaceSession(ledger, input.sessionId, (session) => {
        if (session.status !== "terminal") fail("invalid_transition", "Only a terminal session can be settled");
        return Object.freeze({
          ...session,
          status: "settled",
          costs: Object.freeze({
            estimated_micro_usd: input.estimatedMicroUsd,
            provider_reported_micro_usd: input.providerReportedMicroUsd,
            reconciled_micro_usd: input.reconciledMicroUsd,
            reconciliation_evidence_sha256: input.reconciliationEvidenceSha256,
          }),
        });
      }),
      value: (current) => current.sessions.find((session) => session.session_id === input.sessionId)!,
    }),
  });
}

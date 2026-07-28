import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { canonicalJson, sha256Hex } from "./artifacts";
import {
  MAX_AUTHORIZED_BUDGET_MICRO_USD,
  MAX_SCHEDULING_STOP_MICRO_USD,
  microUsdToDecimal,
  usdToMicroUsd,
  type UsdInput,
} from "./budget";

const EVENT_DOMAIN = "harshas-amazing-call-center/filesystem-budget-ledger/event/v1\n";
const STATE_DOMAIN = "harshas-amazing-call-center/filesystem-budget-ledger/state/v1\n";
const OPERATION_DOMAIN = "harshas-amazing-call-center/filesystem-budget-ledger/operation/v1\n";
const HEAD_DOMAIN = "harshas-amazing-call-center/filesystem-budget-ledger/head/v1\n";
const PLAN_CONSUMPTION_DOMAIN = "harshas-amazing-call-center/filesystem-budget-ledger/plan-consumption/v1\n";
const LC4_QUALIFICATION_V3_PLAN_CONSUMPTION_DOMAIN =
  "harshas-amazing-call-center/filesystem-budget-ledger/lc4-qualification-plan-consumption/v3\n";
const LC4_DEV_SIX_EPISODE_PLAN_CONSUMPTION_DOMAIN =
  "harshas-amazing-call-center/filesystem-budget-ledger/lc4-dev-six-episode-plan-consumption/v1\n";
const EMPTY_HASH = "0".repeat(64);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const MAX_LEDGER_BYTES = 128 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const PAID_PLAN_CONSUMPTION_MAXIMUM_MICRO_USD = 5_000_000;
const LC4_QUALIFICATION_V2_MAXIMUM_MICRO_USD = 3_000_000;
const LC4_QUALIFICATION_V2_RESPONSE_GENERATIONS = 6;
const LC4_QUALIFICATION_V2_PAID_GENERATION_SESSIONS = 6;
const LC4_QUALIFICATION_V3_MAXIMUM_MICRO_USD = 3_000_000;
const LC4_QUALIFICATION_V3_PROVIDER_SESSIONS = 6;
const LC4_QUALIFICATION_V3_PAID_GENERATION_SESSIONS = 3;
const LC4_QUALIFICATION_V3_LOGICAL_GENERATION_PHASES = 6;
const LC4_QUALIFICATION_V3_TOOL_ROUNDTRIPS = 3;
const LC4_QUALIFICATION_V3_RETRIES = 0;
const LC4_DEV_SIX_EPISODE_MAXIMUM_MICRO_USD = 15_000_000;
const LC4_DEV_SIX_EPISODE_CELLS = 6;
const LC4_DEV_SIX_EPISODE_SEGMENTS = 18;
const LC4_DEV_SIX_EPISODE_RETRIES = 0;
const LC4_DEV_SIX_EPISODE_RECONNECTS = 0;
const LOCK_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_PRIVATE_MASK = BigInt(0o077);
const NETWORK_FILESYSTEM_TYPES = new Set([
  0x6969, // Linux NFS
  0x517b, // SMB
  0xff534d42, // CIFS
  0x65735546, // FUSE (fail closed; may be remote or userspace mutable)
]);

export const FILESYSTEM_BUDGET_LEDGER_SCHEMA_VERSION = 1 as const;
export const DEFAULT_OPERATIONAL_CEILING_USD = "15" as const;

export type BudgetJournalStatus =
  | "reserved"
  | "opening"
  | "opened"
  | "terminal_unsettled"
  | "settled"
  | "cancelled"
  | "expired";

export type BudgetJournalTerminalOutcome = "completed" | "failed" | "cancelled";

export type BudgetCostEnvelope = Readonly<{
  schema_version: 1;
  kind: "hacc_provider_gate1_cost_envelope";
  pricing_snapshot_sha256: string;
  provider_hard_session_caps_sha256: string;
  runner_config_sha256: string;
  formula_sha256: string;
  components: readonly Readonly<{
    name: string;
    upper_bound_micro_usd: number;
  }>[];
  safety_margin_micro_usd: number;
}>;

export type BudgetJournalReservation = Readonly<{
  reservation_id: string;
  run_id: string;
  provider: string;
  model: string;
  condition: string;
  created_at: string;
  expires_at: string;
  maximum_micro_usd: number;
  envelope: BudgetCostEnvelope;
  status: BudgetJournalStatus;
  connection_intent_at: string | null;
  opened_at: string | null;
  terminal_at: string | null;
  terminal_outcome: BudgetJournalTerminalOutcome | null;
  estimated_micro_usd: number | null;
  provider_reported_micro_usd: number | null;
  reconciled_micro_usd: number | null;
  reconciliation_evidence_sha256: string | null;
  usage_event_count: number | null;
  usage_evidence_sha256: string | null;
}>;

export type BudgetJournalSnapshot = Readonly<{
  schema_version: 1;
  ledger_id: string;
  currency: "USD";
  public_key_fingerprint_sha256: string;
  authorization_ceiling_micro_usd: number;
  scheduling_stop_micro_usd: number;
  operational_ceiling_micro_usd: number;
  paused: boolean;
  sequence: number;
  head_sha256: string;
  reservations: readonly BudgetJournalReservation[];
  active_reservations_micro_usd: number;
  conservative_settled_micro_usd: number;
  scheduling_exposure_micro_usd: number;
  scheduling_remaining_micro_usd: number;
  operational_remaining_micro_usd: number;
  authorization_remaining_micro_usd: number;
  state: "open" | "paused" | "operational_closed" | "scheduling_closed" | "authorization_breached";
  usd: Readonly<{
    active_reservations: string;
    conservative_settled: string;
    scheduling_exposure: string;
    scheduling_remaining: string;
    operational_remaining: string;
    authorization_remaining: string;
  }>;
}>;

type InitializedPayload = Readonly<{
  currency: "USD";
  public_key_spki_base64: string;
  public_key_fingerprint_sha256: string;
  authorization_ceiling_micro_usd: number;
  scheduling_stop_micro_usd: number;
  operational_ceiling_micro_usd: number;
  /**
   * Added compatibly in schema v1: historical events omit this field and
   * therefore replay as open. Operator-created paid-canary ledgers set it to
   * true so there is never an initialized-but-not-yet-paused crash window.
   */
  paused?: boolean;
}>;

type ReservationCreatedPayload = Readonly<{
  reservation_id: string;
  run_id: string;
  provider: string;
  model: string;
  condition: string;
  expires_at: string;
  maximum_micro_usd: number;
  envelope: BudgetCostEnvelope;
}>;

type ReservationIdPayload = Readonly<{ reservation_id: string }>;
type TerminalPayload = Readonly<{
  reservation_id: string;
  outcome: BudgetJournalTerminalOutcome;
}>;
type SettlementPayload = Readonly<{
  reservation_id: string;
  estimated_micro_usd: number;
  provider_reported_micro_usd: number | null;
}>;
type CostObservedPayload = Readonly<{
  reservation_id: string;
  provider_reported_micro_usd: number;
}>;
type UsageObservedPayload = Readonly<{
  reservation_id: string;
  usage_event_count: number;
  usage_evidence_sha256: string;
}>;
type ReconciledPayload = Readonly<{
  reservation_id: string;
  reconciled_micro_usd: number;
  evidence_sha256: string;
}>;
type CeilingPayload = Readonly<{
  operational_ceiling_micro_usd: number;
  reason_code: string;
  evidence_sha256: string;
}>;
type PausePayload = Readonly<{ reason_code: string; evidence_sha256: string }>;

type BudgetEventPayload =
  | InitializedPayload
  | ReservationCreatedPayload
  | ReservationIdPayload
  | TerminalPayload
  | SettlementPayload
  | CostObservedPayload
  | UsageObservedPayload
  | ReconciledPayload
  | CeilingPayload
  | PausePayload;

export type BudgetJournalEventType =
  | "ledger.initialized"
  | "operational_ceiling.changed"
  | "ledger.paused"
  | "ledger.resumed"
  | "reservation.created"
  | "reservation.connection_intent"
  | "reservation.opened"
  | "reservation.terminal"
  | "reservation.settled"
  | "reservation.provider_cost_observed"
  | "reservation.usage_observed"
  | "reservation.reconciled"
  | "reservation.cancelled_before_open"
  | "reservation.expired";

export type BudgetJournalEvent = Readonly<{
  schema_version: 1;
  ledger_id: string;
  sequence: number;
  event_id: string;
  operation_id: string;
  occurred_at: string;
  writer: Readonly<{ hostname: string; pid: number }>;
  event_type: BudgetJournalEventType;
  payload: BudgetEventPayload;
  previous_event_sha256: string;
  operation_sha256: string;
  state_sha256_after: string;
  event_sha256: string;
  signature_base64: string;
}>;

type BudgetJournalHead = Readonly<{
  schema_version: 1;
  ledger_id: string;
  sequence: number;
  event_sha256: string;
  byte_length: number;
  public_key_fingerprint_sha256: string;
  signature_base64: string;
}>;

type MutableState = {
  ledgerId: string;
  currency: "USD";
  publicKeySpkiBase64: string;
  publicKeyFingerprint: string;
  authorizationCeiling: number;
  schedulingStop: number;
  operationalCeiling: number;
  paused: boolean;
  sequence: number;
  headHash: string;
  reservations: Map<string, BudgetJournalReservation>;
  runIds: Set<string>;
  operations: Map<string, Readonly<{ operationHash: string; sequence: number }>>;
};

export type BudgetLedgerStoreOptions = Readonly<{
  ledgerPath: string;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  now?: () => Date;
  randomId?: () => string;
  hostname?: string;
  pid?: number;
}>;

export type BudgetLedgerMutationResult = Readonly<{
  snapshot: BudgetJournalSnapshot;
  event: BudgetJournalEvent;
  idempotent_replay: boolean;
}>;

export type Gate1PaidPlanConsumption = Readonly<{
  /** Omitted by historical callers; omission remains the exact legacy $5 contract. */
  kind?: "gate1_paid_plan";
  consumptionId: string;
  planSha256: string;
  maximumMicroUsd: number;
}>;

export type Lc4QualificationV2PlanConsumption = Readonly<{
  kind: "lc4_qualification_v2";
  consumptionId: string;
  planSha256: string;
  maximumMicroUsd: number;
  authorizationArtifactSha256: string;
  authorizationId: string;
  attemptId: string;
  sourceCommit: string;
  sourceTreeSha256: string;
  credentialSetSha256: string;
  providerProfileManifestSha256: string;
  configurationMatrixSha256: string;
  devConfigurationMatrixSha256: string;
  providersModelsSha256: string;
  maximumResponseGenerations: number;
  maximumPaidGenerationSessions: number;
  paidRetryAllowed: false;
}>;

export type Lc4QualificationV3PlanConsumption = Readonly<{
  kind: "lc4_qualification_v3";
  consumptionId: string;
  planSha256: string;
  maximumMicroUsd: number;
  authorizationArtifactSha256: string;
  authorizationId: string;
  attemptId: string;
  sourceCommit: string;
  sourceTreeSha256: string;
  credentialSetSha256: string;
  providerProfileManifestSha256: string;
  configurationMatrixSha256: string;
  devConfigurationMatrixSha256: string;
  providersModelsSha256: string;
  maximumProviderSessions: number;
  maximumPaidGenerationSessions: number;
  maximumLogicalGenerationPhases: number;
  maximumToolRoundtrips: number;
  maximumRetries: number;
}>;

/**
 * One-shot aggregate authority for the public LC4-DEV six-cell execution.
 * The authority is consumed by the first cell reservation, while the signed
 * cell-set hash and aggregate maximum bind all six reservations that must be
 * materialized before provider construction is permitted.
 */
export type Lc4DevSixEpisodePlanConsumption = Readonly<{
  kind: "lc4_dev_six_episode";
  consumptionId: string;
  planSha256: string;
  maximumMicroUsd: number;
  authorizationArtifactSha256: string;
  executionId: string;
  prepareSha256: string;
  preflightSha256: string;
  sourceCommit: string;
  sourceTreeSha256: string;
  credentialSetSha256: string;
  providerProfileManifestSha256: string;
  audioManifestSha256: string;
  qualificationReceiptSha256: string;
  episodeSetSha256: string;
  maximumEpisodeCount: number;
  maximumSegmentCount: number;
  maximumRetries: number;
  maximumReconnects: number;
  maximumRunDurationMs: number;
}>;

export type BudgetPlanConsumption =
  | Gate1PaidPlanConsumption
  | Lc4QualificationV2PlanConsumption
  | Lc4QualificationV3PlanConsumption
  | Lc4DevSixEpisodePlanConsumption;

export class FilesystemBudgetLedgerError extends Error {
  readonly code:
    | "invalid_input"
    | "integrity_failure"
    | "ledger_missing"
    | "ledger_exists"
    | "lock_timeout"
    | "unsafe_filesystem"
    | "invalid_transition"
    | "operation_conflict"
    | "duplicate_reservation"
    | "duplicate_run"
    | "budget_refused"
    | "paused"
    | "plan_consumed";

  constructor(code: FilesystemBudgetLedgerError["code"], message: string) {
    super(message);
    this.name = "FilesystemBudgetLedgerError";
    this.code = code;
  }
}

type StorePaths = Readonly<{
  ledger: string;
  head: string;
  key: string;
  lock: string;
  parent: string;
}>;

type LockedMutationCommitGuard = Readonly<{
  assertDurablyBound(): Promise<void>;
  close(): Promise<void>;
}>;

type LockOwner = Readonly<{
  schema_version: 1;
  nonce: string;
  hostname: string;
  pid: number;
  created_at: string;
}>;

type HeldLock = Readonly<{ path: string; nonce: string }>;

type HeldPrivateFile = Readonly<{
  path: string;
  label: string;
  handle: FileHandle;
  dev: bigint;
  ino: bigint;
}>;

function fail(code: FilesystemBudgetLedgerError["code"], message: string): never {
  throw new FilesystemBudgetLedgerError(code, message);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("integrity_failure", `${label} contains unknown or missing fields`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    fail("invalid_input", `${label} must be a safe non-empty identifier of at most 256 characters`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("invalid_input", `${label} must be a lowercase SHA-256 digest`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    fail("invalid_input", `${label} must be an ISO-8601 UTC timestamp`);
  }
}

function assertMicroUsd(value: unknown, label: string, positive = false): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) {
    fail("invalid_input", `${label} must be a ${positive ? "positive" : "non-negative"} safe integer micro-USD amount`);
  }
}

function safeSum(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    assertMicroUsd(value, label);
    total += value;
    if (!Number.isSafeInteger(total)) fail("invalid_input", `${label} exceeds safe integer precision`);
  }
  return total;
}

function containsSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  return [
    "api_key",
    "apikey",
    "secret",
    "client_secret",
    "token",
    "access_token",
    "refresh_token",
    "password",
    "credential",
    "credentials",
    "authorization",
    "authorization_header",
    "cookie",
    "set_cookie",
  ].includes(normalized);
}

function looksLikeSecret(value: string): boolean {
  return /(?:Bearer\s+[A-Za-z0-9._~+\/-]{12,}|\bsk-[A-Za-z0-9_-]{12,}|\bxai-[A-Za-z0-9_]{20,}|\bAIza[A-Za-z0-9_-]{20,})/i.test(value);
}

function assertNoCredentialMaterial(value: unknown, path = "payload"): void {
  if (typeof value === "string") {
    if (looksLikeSecret(value)) fail("invalid_input", `${path} appears to contain credential material`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentialMaterial(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (containsSensitiveKey(key)) fail("invalid_input", `${path}.${key} is not an allowed ledger field`);
    assertNoCredentialMaterial(entry, `${path}.${key}`);
  }
}

function normalizeEnvelope(envelope: BudgetCostEnvelope): Readonly<{ envelope: BudgetCostEnvelope; maximum: number }> {
  if (!isRecord(envelope)) fail("invalid_input", "cost envelope is required");
  exactKeys(envelope as unknown as Record<string, unknown>, [
    "schema_version",
    "kind",
    "pricing_snapshot_sha256",
    "provider_hard_session_caps_sha256",
    "runner_config_sha256",
    "formula_sha256",
    "components",
    "safety_margin_micro_usd",
  ], "cost envelope");
  if (envelope.schema_version !== 1) fail("invalid_input", "cost envelope schema version is unsupported");
  if (envelope.kind !== "hacc_provider_gate1_cost_envelope") fail("invalid_input", "cost envelope kind is unsupported");
  assertHash(envelope.pricing_snapshot_sha256, "pricing_snapshot_sha256");
  assertHash(envelope.provider_hard_session_caps_sha256, "provider_hard_session_caps_sha256");
  assertHash(envelope.runner_config_sha256, "runner_config_sha256");
  assertHash(envelope.formula_sha256, "formula_sha256");
  assertMicroUsd(envelope.safety_margin_micro_usd, "safety_margin_micro_usd");
  if (!Array.isArray(envelope.components) || envelope.components.length === 0 || envelope.components.length > 128) {
    fail("invalid_input", "cost envelope must contain 1-128 bounded components");
  }
  const names = new Set<string>();
  const components = envelope.components.map((component) => {
    if (!isRecord(component)) fail("invalid_input", "cost envelope component is invalid");
    exactKeys(component as Record<string, unknown>, ["name", "upper_bound_micro_usd"], "cost envelope component");
    assertIdentifier(component.name, "cost component name");
    if (names.has(component.name)) fail("invalid_input", `duplicate cost component ${component.name}`);
    names.add(component.name);
    assertMicroUsd(component.upper_bound_micro_usd, `cost component ${component.name}`, true);
    return Object.freeze({ name: component.name, upper_bound_micro_usd: component.upper_bound_micro_usd });
  });
  const maximum = safeSum(
    [...components.map((component) => component.upper_bound_micro_usd), envelope.safety_margin_micro_usd],
    "cost envelope"
  );
  if (maximum <= 0) fail("invalid_input", "cost envelope maximum must be positive");
  return Object.freeze({
    envelope: Object.freeze({
      schema_version: 1,
      kind: "hacc_provider_gate1_cost_envelope",
      pricing_snapshot_sha256: envelope.pricing_snapshot_sha256,
      provider_hard_session_caps_sha256: envelope.provider_hard_session_caps_sha256,
      runner_config_sha256: envelope.runner_config_sha256,
      formula_sha256: envelope.formula_sha256,
      components: Object.freeze(components),
      safety_margin_micro_usd: envelope.safety_margin_micro_usd,
    }),
    maximum,
  });
}

export function costEnvelopeMaximumMicroUsd(envelope: BudgetCostEnvelope): number {
  return normalizeEnvelope(envelope).maximum;
}

function cloneReservation(value: BudgetJournalReservation): BudgetJournalReservation {
  return Object.freeze({
    ...value,
    envelope: Object.freeze({
      ...value.envelope,
      components: Object.freeze(value.envelope.components.map((component) => Object.freeze({ ...component }))),
    }),
  });
}

function emptyState(): MutableState {
  return {
    ledgerId: "",
    currency: "USD",
    publicKeySpkiBase64: "",
    publicKeyFingerprint: "",
    authorizationCeiling: 0,
    schedulingStop: 0,
    operationalCeiling: 0,
    paused: false,
    sequence: 0,
    headHash: EMPTY_HASH,
    reservations: new Map(),
    runIds: new Set(),
    operations: new Map(),
  };
}

function conservativeCost(reservation: BudgetJournalReservation): number {
  if (["reserved", "opening", "opened", "terminal_unsettled"].includes(reservation.status)) {
    return reservation.maximum_micro_usd;
  }
  if (reservation.status !== "settled") return 0;
  return Math.max(
    reservation.estimated_micro_usd ?? 0,
    reservation.provider_reported_micro_usd ?? 0,
    reservation.reconciled_micro_usd ?? 0
  );
}

function publicState(state: MutableState): Record<string, unknown> {
  return {
    schema_version: 1,
    ledger_id: state.ledgerId,
    currency: state.currency,
    public_key_fingerprint_sha256: state.publicKeyFingerprint,
    authorization_ceiling_micro_usd: state.authorizationCeiling,
    scheduling_stop_micro_usd: state.schedulingStop,
    operational_ceiling_micro_usd: state.operationalCeiling,
    paused: state.paused,
    sequence: state.sequence,
    head_sha256: state.headHash,
    reservations: [...state.reservations.values()]
      .map(cloneReservation)
      .sort((left, right) => left.reservation_id.localeCompare(right.reservation_id)),
  };
}

function snapshot(state: MutableState): BudgetJournalSnapshot {
  if (state.sequence === 0) fail("integrity_failure", "budget ledger has no initialization event");
  const reservations = [...state.reservations.values()]
    .map(cloneReservation)
    .sort((left, right) => left.reservation_id.localeCompare(right.reservation_id));
  const active = safeSum(
    reservations
      .filter((reservation) => ["reserved", "opening", "opened", "terminal_unsettled"].includes(reservation.status))
      .map((reservation) => reservation.maximum_micro_usd),
    "active reservations"
  );
  const settled = safeSum(
    reservations.filter((reservation) => reservation.status === "settled").map(conservativeCost),
    "conservative settled costs"
  );
  const exposure = safeSum([active, settled], "scheduling exposure");
  const schedulingRemaining = Math.max(0, state.schedulingStop - exposure);
  const operationalRemaining = Math.max(0, state.operationalCeiling - exposure);
  const authorizationRemaining = Math.max(0, state.authorizationCeiling - exposure);
  const status = exposure > state.authorizationCeiling
    ? "authorization_breached" as const
    : state.paused
      ? "paused" as const
      : exposure >= state.schedulingStop
        ? "scheduling_closed" as const
        : exposure >= state.operationalCeiling
          ? "operational_closed" as const
          : "open" as const;
  return Object.freeze({
    schema_version: 1 as const,
    ledger_id: state.ledgerId,
    currency: "USD" as const,
    public_key_fingerprint_sha256: state.publicKeyFingerprint,
    authorization_ceiling_micro_usd: state.authorizationCeiling,
    scheduling_stop_micro_usd: state.schedulingStop,
    operational_ceiling_micro_usd: state.operationalCeiling,
    paused: state.paused,
    sequence: state.sequence,
    head_sha256: state.headHash,
    reservations: Object.freeze(reservations),
    active_reservations_micro_usd: active,
    conservative_settled_micro_usd: settled,
    scheduling_exposure_micro_usd: exposure,
    scheduling_remaining_micro_usd: schedulingRemaining,
    operational_remaining_micro_usd: operationalRemaining,
    authorization_remaining_micro_usd: authorizationRemaining,
    state: status,
    usd: Object.freeze({
      active_reservations: microUsdToDecimal(active),
      conservative_settled: microUsdToDecimal(settled),
      scheduling_exposure: microUsdToDecimal(exposure),
      scheduling_remaining: microUsdToDecimal(schedulingRemaining),
      operational_remaining: microUsdToDecimal(operationalRemaining),
      authorization_remaining: microUsdToDecimal(authorizationRemaining),
    }),
  });
}

function reservation(state: MutableState, id: string): BudgetJournalReservation {
  assertIdentifier(id, "reservation_id");
  const value = state.reservations.get(id);
  if (!value) fail("invalid_transition", `unknown reservation ${id}`);
  return value;
}

function updateReservation(
  state: MutableState,
  id: string,
  update: (value: BudgetJournalReservation) => BudgetJournalReservation
): void {
  state.reservations.set(id, cloneReservation(update(reservation(state, id))));
}

function expectStatus(value: BudgetJournalReservation, expected: readonly BudgetJournalStatus[], event: string): void {
  if (!expected.includes(value.status)) {
    fail("invalid_transition", `${event} is invalid while reservation ${value.reservation_id} is ${value.status}`);
  }
}

function applyPayload(state: MutableState, eventType: BudgetJournalEventType, payload: BudgetEventPayload, occurredAt: string): void {
  assertNoCredentialMaterial(payload);
  if (eventType === "ledger.initialized") {
    if (state.sequence !== 0) fail("integrity_failure", "ledger.initialized must be the first event");
    const value = payload as InitializedPayload;
    if (value.currency !== "USD") fail("integrity_failure", "budget ledger currency must be USD");
    assertHash(value.public_key_fingerprint_sha256, "public key fingerprint");
    if (typeof value.public_key_spki_base64 !== "string" || value.public_key_spki_base64.length < 32) {
      fail("integrity_failure", "budget ledger public key is invalid");
    }
    assertMicroUsd(value.authorization_ceiling_micro_usd, "authorization ceiling", true);
    assertMicroUsd(value.scheduling_stop_micro_usd, "scheduling stop", true);
    assertMicroUsd(value.operational_ceiling_micro_usd, "operational ceiling", true);
    if (value.authorization_ceiling_micro_usd !== MAX_AUTHORIZED_BUDGET_MICRO_USD) {
      fail("integrity_failure", "authorization ceiling must be exactly $1,000");
    }
    if (value.scheduling_stop_micro_usd !== MAX_SCHEDULING_STOP_MICRO_USD) {
      fail("integrity_failure", "automatic scheduling stop must be exactly $900");
    }
    if (value.operational_ceiling_micro_usd > value.scheduling_stop_micro_usd) {
      fail("integrity_failure", "operational ceiling cannot exceed the $900 scheduling stop");
    }
    if (value.paused !== undefined && typeof value.paused !== "boolean") {
      fail("integrity_failure", "budget ledger initial pause state must be boolean");
    }
    const publicKey = Buffer.from(value.public_key_spki_base64, "base64");
    if (sha256Hex(publicKey) !== value.public_key_fingerprint_sha256) {
      fail("integrity_failure", "public key fingerprint mismatch");
    }
    state.currency = "USD";
    state.publicKeySpkiBase64 = value.public_key_spki_base64;
    state.publicKeyFingerprint = value.public_key_fingerprint_sha256;
    state.authorizationCeiling = value.authorization_ceiling_micro_usd;
    state.schedulingStop = value.scheduling_stop_micro_usd;
    state.operationalCeiling = value.operational_ceiling_micro_usd;
    state.paused = value.paused ?? false;
    return;
  }
  if (state.sequence === 0) fail("integrity_failure", "ledger must be initialized before other events");

  if (eventType === "operational_ceiling.changed") {
    const value = payload as CeilingPayload;
    assertMicroUsd(value.operational_ceiling_micro_usd, "operational ceiling", true);
    assertIdentifier(value.reason_code, "reason_code");
    assertHash(value.evidence_sha256, "evidence_sha256");
    if (value.operational_ceiling_micro_usd > state.schedulingStop) {
      fail("invalid_input", "operational ceiling cannot exceed the $900 automatic scheduling stop");
    }
    state.operationalCeiling = value.operational_ceiling_micro_usd;
    return;
  }
  if (eventType === "ledger.paused" || eventType === "ledger.resumed") {
    const value = payload as PausePayload;
    assertIdentifier(value.reason_code, "reason_code");
    assertHash(value.evidence_sha256, "evidence_sha256");
    if (eventType === "ledger.paused") {
      if (state.paused) fail("invalid_transition", "budget ledger is already paused");
      state.paused = true;
    } else {
      if (!state.paused) fail("invalid_transition", "budget ledger is not paused");
      state.paused = false;
    }
    return;
  }
  if (eventType === "reservation.created") {
    const value = payload as ReservationCreatedPayload;
    assertIdentifier(value.reservation_id, "reservation_id");
    assertIdentifier(value.run_id, "run_id");
    assertIdentifier(value.provider, "provider");
    assertIdentifier(value.model, "model");
    assertIdentifier(value.condition, "condition");
    assertTimestamp(value.expires_at, "expires_at");
    assertMicroUsd(value.maximum_micro_usd, "maximum_micro_usd", true);
    const normalized = normalizeEnvelope(value.envelope);
    if (normalized.maximum !== value.maximum_micro_usd) {
      fail("integrity_failure", "reservation maximum does not match its cost envelope");
    }
    if (Date.parse(value.expires_at) <= Date.parse(occurredAt)) {
      fail("invalid_input", "reservation expiry must be after creation");
    }
    if (state.reservations.has(value.reservation_id)) fail("duplicate_reservation", "reservation ID already exists");
    if (state.runIds.has(value.run_id)) fail("duplicate_run", "run ID already exists in the budget ledger");
    const before = snapshot(state);
    if (state.paused) fail("paused", "budget ledger is paused");
    if (before.state === "authorization_breached") fail("budget_refused", "authorization ceiling has been breached");
    const projected = safeSum([before.scheduling_exposure_micro_usd, value.maximum_micro_usd], "projected exposure");
    if (projected > state.authorizationCeiling) fail("budget_refused", "reservation would exceed the $1,000 authorization ceiling");
    if (projected > state.schedulingStop) fail("budget_refused", "reservation would exceed the $900 automatic scheduling stop");
    if (projected > state.operationalCeiling) fail("budget_refused", "reservation would exceed the current operational ceiling");
    state.runIds.add(value.run_id);
    state.reservations.set(value.reservation_id, cloneReservation({
      reservation_id: value.reservation_id,
      run_id: value.run_id,
      provider: value.provider,
      model: value.model,
      condition: value.condition,
      created_at: occurredAt,
      expires_at: value.expires_at,
      maximum_micro_usd: value.maximum_micro_usd,
      envelope: normalized.envelope,
      status: "reserved",
      connection_intent_at: null,
      opened_at: null,
      terminal_at: null,
      terminal_outcome: null,
      estimated_micro_usd: null,
      provider_reported_micro_usd: null,
      reconciled_micro_usd: null,
      reconciliation_evidence_sha256: null,
      usage_event_count: null,
      usage_evidence_sha256: null,
    }));
    return;
  }

  const idPayload = payload as ReservationIdPayload;
  assertIdentifier(idPayload.reservation_id, "reservation_id");
  if (eventType === "reservation.connection_intent") {
    updateReservation(state, idPayload.reservation_id, (value) => {
      expectStatus(value, ["reserved"], eventType);
      return { ...value, status: "opening", connection_intent_at: occurredAt };
    });
  } else if (eventType === "reservation.opened") {
    updateReservation(state, idPayload.reservation_id, (value) => {
      expectStatus(value, ["opening"], eventType);
      return { ...value, status: "opened", opened_at: occurredAt };
    });
  } else if (eventType === "reservation.terminal") {
    const value = payload as TerminalPayload;
    if (!(["completed", "failed", "cancelled"] as const).includes(value.outcome)) {
      fail("invalid_input", "terminal outcome is invalid");
    }
    updateReservation(state, value.reservation_id, (prior) => {
      expectStatus(prior, ["opening", "opened"], eventType);
      return { ...prior, status: "terminal_unsettled", terminal_at: occurredAt, terminal_outcome: value.outcome };
    });
  } else if (eventType === "reservation.settled") {
    const value = payload as SettlementPayload;
    assertMicroUsd(value.estimated_micro_usd, "estimated_micro_usd");
    if (value.provider_reported_micro_usd !== null) {
      assertMicroUsd(value.provider_reported_micro_usd, "provider_reported_micro_usd");
    }
    updateReservation(state, value.reservation_id, (prior) => {
      expectStatus(prior, ["terminal_unsettled"], eventType);
      return {
        ...prior,
        status: "settled",
        estimated_micro_usd: value.estimated_micro_usd,
        provider_reported_micro_usd: value.provider_reported_micro_usd,
      };
    });
  } else if (eventType === "reservation.provider_cost_observed") {
    const value = payload as CostObservedPayload;
    assertMicroUsd(value.provider_reported_micro_usd, "provider_reported_micro_usd");
    updateReservation(state, value.reservation_id, (prior) => {
      expectStatus(prior, ["settled"], eventType);
      return {
        ...prior,
        provider_reported_micro_usd: Math.max(
          prior.provider_reported_micro_usd ?? 0,
          value.provider_reported_micro_usd
        ),
      };
    });
  } else if (eventType === "reservation.usage_observed") {
    const value = payload as UsageObservedPayload;
    if (!Number.isSafeInteger(value.usage_event_count) || value.usage_event_count < 0) {
      fail("invalid_input", "usage_event_count must be a non-negative safe integer");
    }
    assertHash(value.usage_evidence_sha256, "usage_evidence_sha256");
    updateReservation(state, value.reservation_id, (prior) => {
      expectStatus(prior, ["opening", "opened"], eventType);
      if (prior.usage_event_count !== null || prior.usage_evidence_sha256 !== null) {
        fail("invalid_transition", "reservation usage evidence was already recorded");
      }
      return {
        ...prior,
        usage_event_count: value.usage_event_count,
        usage_evidence_sha256: value.usage_evidence_sha256,
      };
    });
  } else if (eventType === "reservation.reconciled") {
    const value = payload as ReconciledPayload;
    assertMicroUsd(value.reconciled_micro_usd, "reconciled_micro_usd");
    assertHash(value.evidence_sha256, "evidence_sha256");
    updateReservation(state, value.reservation_id, (prior) => {
      expectStatus(prior, ["settled"], eventType);
      return {
        ...prior,
        reconciled_micro_usd: Math.max(prior.reconciled_micro_usd ?? 0, value.reconciled_micro_usd),
        reconciliation_evidence_sha256: value.evidence_sha256,
      };
    });
  } else if (eventType === "reservation.cancelled_before_open") {
    updateReservation(state, idPayload.reservation_id, (prior) => {
      expectStatus(prior, ["reserved"], eventType);
      return { ...prior, status: "cancelled", terminal_at: occurredAt, terminal_outcome: "cancelled" };
    });
  } else if (eventType === "reservation.expired") {
    updateReservation(state, idPayload.reservation_id, (prior) => {
      expectStatus(prior, ["reserved"], eventType);
      if (Date.parse(prior.expires_at) > Date.parse(occurredAt)) {
        fail("invalid_transition", `reservation ${prior.reservation_id} has not expired`);
      }
      return { ...prior, status: "expired", terminal_at: occurredAt };
    });
  } else {
    fail("integrity_failure", `unsupported budget event type ${eventType}`);
  }
}

function eventBody(event: Omit<BudgetJournalEvent, "event_sha256" | "signature_base64">): Record<string, unknown> {
  return { ...event };
}

function eventHash(event: Omit<BudgetJournalEvent, "event_sha256" | "signature_base64">): string {
  return sha256Hex(`${EVENT_DOMAIN}${canonicalJson(eventBody(event))}`);
}

function operationHash(eventType: BudgetJournalEventType, payload: BudgetEventPayload): string {
  return sha256Hex(`${OPERATION_DOMAIN}${canonicalJson({ event_type: eventType, payload })}`);
}

function headSigningBody(head: Omit<BudgetJournalHead, "signature_base64">): Buffer {
  return Buffer.from(`${HEAD_DOMAIN}${canonicalJson(head)}`, "utf8");
}

function pathsFor(ledgerPath: string): StorePaths {
  if (!isAbsolute(ledgerPath)) fail("invalid_input", "budget ledger path must be absolute");
  const ledger = resolve(ledgerPath);
  return Object.freeze({
    ledger,
    head: `${ledger}.head.json`,
    key: `${ledger}.signing-key.pem`,
    lock: `${ledger}.lock`,
    parent: dirname(ledger),
  });
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));
}

async function assertSafeParent(path: string): Promise<string> {
  let resolvedParent: string;
  try {
    resolvedParent = await realpath(path);
  } catch {
    fail("unsafe_filesystem", "budget ledger parent directory does not exist");
  }
  const info = await stat(resolvedParent);
  if (!info.isDirectory() || (info.mode & 0o022) !== 0) {
    fail("unsafe_filesystem", "budget ledger parent must be a private non-group/world-writable directory");
  }
  if (typeof statfs === "function") {
    const filesystem = await statfs(resolvedParent);
    const type = typeof filesystem.type === "bigint" ? Number(filesystem.type) : filesystem.type;
    if (NETWORK_FILESYSTEM_TYPES.has(type)) {
      fail("unsafe_filesystem", "budget ledger cannot be stored on a network or userspace filesystem");
    }
  }
  return resolvedParent;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const contents = await readFile(join(lockPath, "owner.json"), "utf8");
    const parsed = JSON.parse(contents) as unknown;
    if (!isRecord(parsed)) return null;
    exactKeys(parsed, ["schema_version", "nonce", "hostname", "pid", "created_at"], "lock owner");
    if (parsed.schema_version !== 1) return null;
    assertIdentifier(parsed.nonce, "lock nonce");
    if (typeof parsed.hostname !== "string" || parsed.hostname.length === 0 || parsed.hostname.length > 255) return null;
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) return null;
    assertTimestamp(parsed.created_at, "lock created_at");
    return parsed as unknown as LockOwner;
  } catch {
    return null;
  }
}

async function acquireLock(paths: StorePaths, options: BudgetLedgerStoreOptions): Promise<HeldLock> {
  const deadline = Date.now() + (options.lockTimeoutMs ?? 10_000);
  const retryMs = options.lockRetryMs ?? 25;
  const localHostname = options.hostname ?? hostname();
  const localPid = options.pid ?? process.pid;
  const randomId = options.randomId ?? randomUUID;
  while (true) {
    const nonce = randomId();
    try {
      await mkdir(paths.lock, { mode: LOCK_MODE });
      const owner: LockOwner = Object.freeze({
        schema_version: 1,
        nonce,
        hostname: localHostname,
        pid: localPid,
        created_at: (options.now?.() ?? new Date()).toISOString(),
      });
      await writeFile(join(paths.lock, "owner.json"), `${canonicalJson(owner)}\n`, {
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
      });
      return Object.freeze({ path: paths.lock, nonce });
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      const lockStat = await lstat(paths.lock).catch(() => null);
      if (lockStat && (!lockStat.isDirectory() || lockStat.isSymbolicLink())) {
        fail("unsafe_filesystem", "budget ledger lock path is not a regular lock directory");
      }
      const owner = await readLockOwner(paths.lock);
      if (Date.now() >= deadline) {
        fail("lock_timeout", owner
          ? "budget ledger lock requires explicit operator recovery and cannot be stolen"
          : "timed out waiting for the budget ledger lock");
      }
      await wait(retryMs);
    }
  }
}

async function releaseLock(lock: HeldLock): Promise<void> {
  const owner = await readLockOwner(lock.path);
  if (!owner || owner.nonce !== lock.nonce) {
    fail("integrity_failure", "budget ledger lock ownership changed before release");
  }
  await rm(lock.path, { recursive: true, force: false });
}

async function withLock<T>(options: BudgetLedgerStoreOptions, action: (paths: StorePaths) => Promise<T>): Promise<T> {
  const requested = pathsFor(options.ledgerPath);
  const parent = await assertSafeParent(requested.parent);
  const ledger = join(parent, basename(requested.ledger));
  const paths: StorePaths = Object.freeze({
    ledger,
    head: `${ledger}.head.json`,
    key: `${ledger}.signing-key.pem`,
    lock: `${ledger}.lock`,
    parent,
  });
  const lock = await acquireLock(paths, options);
  try {
    return await action(paths);
  } finally {
    await releaseLock(lock);
  }
}

const PRIVATE_FILE_BINDING_ATTEMPTS = 5;

async function openHeldPrivateFile(
  path: string,
  label: string,
  flags: number,
): Promise<HeldPrivateFile> {
  let handle: FileHandle;
  try {
    handle = await open(path, flags | constants.O_NOFOLLOW);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      fail("ledger_missing", `${label} is missing`);
    }
    fail("unsafe_filesystem", `${label} could not be opened as a non-symlink file`);
  }
  try {
    const info = await handle.stat({ bigint: true });
    const held = Object.freeze({
      path,
      label,
      handle,
      dev: info.dev,
      ino: info.ino,
    });
    await awaitStablePrivateFileBinding(held);
    return held;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function awaitStablePrivateFileBinding(held: HeldPrivateFile): Promise<BigIntStats> {
  let sawLinkCountDisagreement = false;
  let cleanSamplesAfterDisagreement = 0;
  for (let attempt = 0; attempt < PRIVATE_FILE_BINDING_ATTEMPTS; attempt += 1) {
    const [descriptorInfo, pathInfo] = await Promise.all([
      held.handle.stat({ bigint: true }).catch(() => null),
      lstat(held.path, { bigint: true }).catch(() => null),
    ]);
    if (
      !descriptorInfo
      || !pathInfo
      || !descriptorInfo.isFile()
      || !pathInfo.isFile()
      || pathInfo.isSymbolicLink()
      || descriptorInfo.dev !== held.dev
      || descriptorInfo.ino !== held.ino
      || pathInfo.dev !== held.dev
      || pathInfo.ino !== held.ino
      || (descriptorInfo.mode & BIGINT_PRIVATE_MASK) !== BIGINT_ZERO
      || (pathInfo.mode & BIGINT_PRIVATE_MASK) !== BIGINT_ZERO
    ) {
      fail("unsafe_filesystem", `${held.label} changed or is no longer safely reachable`);
    }
    if (descriptorInfo.nlink === BIGINT_ONE && pathInfo.nlink === BIGINT_ONE) {
      cleanSamplesAfterDisagreement += 1;
      // Preserve the historical single-sample fast path. If APFS exposed a
      // transient link-count disagreement, require two subsequent agreeing
      // samples on the same held inode before proceeding.
      if (!sawLinkCountDisagreement || cleanSamplesAfterDisagreement >= 2) {
        return descriptorInfo;
      }
    } else {
      sawLinkCountDisagreement = true;
      cleanSamplesAfterDisagreement = 0;
    }
    if (attempt + 1 < PRIVATE_FILE_BINDING_ATTEMPTS) {
      await wait(2 ** attempt);
    }
  }
  fail("unsafe_filesystem", `${held.label} did not establish a stable private single-link binding`);
}

async function readHeldPrivateFile(
  held: HeldPrivateFile,
  maximumBytes: number,
  allowEmpty = false,
): Promise<Buffer> {
  const before = await awaitStablePrivateFileBinding(held);
  if (
    before.size > BigInt(maximumBytes)
    || (!allowEmpty && before.size <= BIGINT_ZERO)
  ) {
    fail("integrity_failure", `${held.label} size is invalid`);
  }
  const bytes = await held.handle.readFile();
  const after = await awaitStablePrivateFileBinding(held);
  if (
    BigInt(bytes.byteLength) !== before.size
    || after.size !== before.size
    || after.mtimeNs !== before.mtimeNs
    || after.ctimeNs !== before.ctimeNs
  ) {
    fail("integrity_failure", `${held.label} changed while it was read`);
  }
  return bytes;
}

async function readPrivateFile(path: string, label: string, maximumBytes: number): Promise<Buffer> {
  const held = await openHeldPrivateFile(path, label, constants.O_RDONLY);
  try {
    return await readHeldPrivateFile(held, maximumBytes);
  } finally {
    await held.handle.close();
  }
}

function parseEvent(line: string, index: number): BudgetJournalEvent {
  if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) fail("integrity_failure", `budget event ${index} is too large`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    fail("integrity_failure", `budget event ${index} is not valid JSON`);
  }
  if (!isRecord(parsed)) fail("integrity_failure", `budget event ${index} is not an object`);
  exactKeys(parsed, [
    "schema_version", "ledger_id", "sequence", "event_id", "operation_id", "occurred_at", "writer",
    "event_type", "payload", "previous_event_sha256", "operation_sha256", "state_sha256_after",
    "event_sha256", "signature_base64",
  ], `budget event ${index}`);
  return parsed as unknown as BudgetJournalEvent;
}

function replayEvents(events: readonly BudgetJournalEvent[]): MutableState {
  const state = emptyState();
  let publicKey: ReturnType<typeof createPublicKey> | null = null;
  for (const [index, event] of events.entries()) {
    if (event.schema_version !== 1) fail("integrity_failure", `unsupported budget event schema at line ${index + 1}`);
    assertIdentifier(event.ledger_id, "ledger_id");
    assertIdentifier(event.event_id, "event_id");
    assertIdentifier(event.operation_id, "operation_id");
    assertTimestamp(event.occurred_at, "occurred_at");
    assertHash(event.previous_event_sha256, "previous_event_sha256");
    assertHash(event.operation_sha256, "operation_sha256");
    assertHash(event.state_sha256_after, "state_sha256_after");
    assertHash(event.event_sha256, "event_sha256");
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== index + 1) {
      fail("integrity_failure", `budget event sequence is not contiguous at line ${index + 1}`);
    }
    if (!isRecord(event.writer)) fail("integrity_failure", `budget event writer is invalid at line ${index + 1}`);
    exactKeys(event.writer, ["hostname", "pid"], "budget event writer");
    if (typeof event.writer.hostname !== "string" || !Number.isSafeInteger(event.writer.pid) || event.writer.pid <= 0) {
      fail("integrity_failure", `budget event writer is invalid at line ${index + 1}`);
    }
    if (!isRecord(event.payload)) fail("integrity_failure", `budget event payload is invalid at line ${index + 1}`);
    if (index === 0 && event.event_type !== "ledger.initialized") {
      fail("integrity_failure", "first budget event must initialize the ledger");
    }
    if (index > 0 && event.ledger_id !== state.ledgerId) fail("integrity_failure", "budget ledger ID changed");
    if (event.previous_event_sha256 !== state.headHash) fail("integrity_failure", `budget event chain broke at line ${index + 1}`);
    const expectedOperationHash = operationHash(event.event_type, event.payload);
    if (event.operation_sha256 !== expectedOperationHash) fail("integrity_failure", `operation hash mismatch at line ${index + 1}`);
    const priorOperation = state.operations.get(event.operation_id);
    if (priorOperation) fail("integrity_failure", `duplicate operation ID was appended at line ${index + 1}`);

    const nextState: MutableState = {
      ...state,
      reservations: new Map(state.reservations),
      runIds: new Set(state.runIds),
      operations: new Map(state.operations),
    };
    applyPayload(nextState, event.event_type, event.payload, event.occurred_at);
    if (index === 0) {
      nextState.ledgerId = event.ledger_id;
      try {
        publicKey = createPublicKey({
          key: Buffer.from(nextState.publicKeySpkiBase64, "base64"),
          format: "der",
          type: "spki",
        });
      } catch {
        fail("integrity_failure", "budget ledger public signing key is invalid");
      }
    }
    nextState.sequence = event.sequence;
    nextState.headHash = event.event_sha256;
    if (replayStateHash(nextState) !== event.state_sha256_after) {
      fail("integrity_failure", `state hash mismatch at line ${index + 1}`);
    }
    const body = {
      schema_version: event.schema_version,
      ledger_id: event.ledger_id,
      sequence: event.sequence,
      event_id: event.event_id,
      operation_id: event.operation_id,
      occurred_at: event.occurred_at,
      writer: event.writer,
      event_type: event.event_type,
      payload: event.payload,
      previous_event_sha256: event.previous_event_sha256,
      operation_sha256: event.operation_sha256,
      state_sha256_after: event.state_sha256_after,
    } satisfies Omit<BudgetJournalEvent, "event_sha256" | "signature_base64">;
    if (eventHash(body) !== event.event_sha256) fail("integrity_failure", `event hash mismatch at line ${index + 1}`);
    let signature: Buffer;
    try {
      signature = Buffer.from(event.signature_base64, "base64");
    } catch {
      fail("integrity_failure", `event signature encoding is invalid at line ${index + 1}`);
    }
    if (!publicKey || !verify(null, Buffer.from(event.event_sha256, "hex"), publicKey, signature)) {
      fail("integrity_failure", `event signature is invalid at line ${index + 1}`);
    }
    nextState.operations.set(event.operation_id, Object.freeze({ operationHash: event.operation_sha256, sequence: event.sequence }));
    Object.assign(state, nextState);
  }
  return state;
}

async function loadEvents(
  paths: StorePaths,
  writable = false,
): Promise<Readonly<{
  events: readonly BudgetJournalEvent[];
  bytes: number;
  ledger: HeldPrivateFile;
}>> {
  const ledger = await openHeldPrivateFile(
    paths.ledger,
    "budget ledger",
    writable ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY,
  );
  let bytes: Buffer;
  try {
    bytes = await readHeldPrivateFile(ledger, MAX_LEDGER_BYTES);
  } catch (error) {
    await ledger.handle.close().catch(() => undefined);
    throw error;
  }
  try {
    if (bytes[bytes.byteLength - 1] !== 0x0a) {
      fail("integrity_failure", "budget ledger has a partial or unterminated tail");
    }
    const text = bytes.toString("utf8");
    if (text.includes("\0") || text.includes("\r")) fail("integrity_failure", "budget ledger contains forbidden bytes");
    const lines = text.slice(0, -1).split("\n");
    if (lines.some((line) => line.length === 0)) fail("integrity_failure", "budget ledger contains an empty event line");
    return Object.freeze({
      events: Object.freeze(lines.map((line, index) => parseEvent(line, index + 1))),
      bytes: bytes.byteLength,
      ledger,
    });
  } catch (error) {
    await ledger.handle.close().catch(() => undefined);
    throw error;
  }
}

function parseHead(text: string): BudgetJournalHead {
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) fail("integrity_failure", "budget ledger head is not canonical JSONL");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("integrity_failure", "budget ledger head is not valid JSON");
  }
  if (!isRecord(value)) fail("integrity_failure", "budget ledger head is invalid");
  exactKeys(value, [
    "schema_version", "ledger_id", "sequence", "event_sha256", "byte_length",
    "public_key_fingerprint_sha256", "signature_base64",
  ], "budget ledger head");
  return value as unknown as BudgetJournalHead;
}

async function verifyHead(paths: StorePaths, state: MutableState, byteLength: number): Promise<void> {
  const head = parseHead((await readPrivateFile(
    paths.head,
    "budget ledger head",
    MAX_EVENT_BYTES,
  )).toString("utf8"));
  if (
    head.schema_version !== 1
    || head.ledger_id !== state.ledgerId
    || head.sequence !== state.sequence
    || head.event_sha256 !== state.headHash
    || head.byte_length !== byteLength
    || head.public_key_fingerprint_sha256 !== state.publicKeyFingerprint
  ) {
    fail("integrity_failure", "budget ledger head does not match the append-only log");
  }
  const body: Omit<BudgetJournalHead, "signature_base64"> = {
    schema_version: 1,
    ledger_id: head.ledger_id,
    sequence: head.sequence,
    event_sha256: head.event_sha256,
    byte_length: head.byte_length,
    public_key_fingerprint_sha256: head.public_key_fingerprint_sha256,
  };
  const publicKey = createPublicKey({
    key: Buffer.from(state.publicKeySpkiBase64, "base64"),
    format: "der",
    type: "spki",
  });
  if (!verify(null, headSigningBody(body), publicKey, Buffer.from(head.signature_base64, "base64"))) {
    fail("integrity_failure", "budget ledger head signature is invalid");
  }
}

async function loadVerified(
  paths: StorePaths,
  writable = false,
): Promise<Readonly<{
  state: MutableState;
  events: readonly BudgetJournalEvent[];
  bytes: number;
  ledger: HeldPrivateFile;
}>> {
  const loaded = await loadEvents(paths, writable);
  try {
    const state = replayEvents(loaded.events);
    await verifyHead(paths, state, loaded.bytes);
    return Object.freeze({
      state,
      events: loaded.events,
      bytes: loaded.bytes,
      ledger: loaded.ledger,
    });
  } catch (error) {
    await loaded.ledger.handle.close().catch(() => undefined);
    throw error;
  }
}

async function loadSigningKey(paths: StorePaths, state: MutableState) {
  const keyBytes = await readPrivateFile(paths.key, "budget ledger signing key", 16_384);
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(keyBytes);
  } catch {
    fail("integrity_failure", "budget ledger signing key is invalid");
  }
  const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (sha256Hex(publicDer) !== state.publicKeyFingerprint) {
    fail("integrity_failure", "budget ledger signing key does not match the initialized public key");
  }
  return privateKey;
}

async function appendFully(ledger: HeldPrivateFile, contents: Buffer): Promise<number> {
  const before = await awaitStablePrivateFileBinding(ledger);
  try {
    let offset = 0;
    while (offset < contents.byteLength) {
      const result = await ledger.handle.write(contents, offset, contents.byteLength - offset, null);
      if (result.bytesWritten <= 0) fail("integrity_failure", "budget ledger append made no progress");
      offset += result.bytesWritten;
    }
    await ledger.handle.sync();
    const after = await awaitStablePrivateFileBinding(ledger);
    if (after.size !== before.size + BigInt(contents.byteLength)) {
      fail("integrity_failure", "budget ledger size changed outside the exact append");
    }
    return Number(after.size);
  } catch (error) {
    // An append may already be durable. Never retry it here; recovery remains
    // the only path for an append/head interruption.
    throw error;
  }
}

async function writeHead(paths: StorePaths, state: MutableState, byteLength: number, privateKey: ReturnType<typeof createPrivateKey>): Promise<void> {
  const body: Omit<BudgetJournalHead, "signature_base64"> = Object.freeze({
    schema_version: 1,
    ledger_id: state.ledgerId,
    sequence: state.sequence,
    event_sha256: state.headHash,
    byte_length: byteLength,
    public_key_fingerprint_sha256: state.publicKeyFingerprint,
  });
  const head: BudgetJournalHead = Object.freeze({
    ...body,
    signature_base64: sign(null, headSigningBody(body), privateKey).toString("base64"),
  });
  const temporary = `${paths.head}.tmp-${randomUUID()}`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(`${canonicalJson(head)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, paths.head);
  const directory = await open(paths.parent, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function buildEvent(input: Readonly<{
  state: MutableState;
  ledgerId: string;
  operationId: string;
  eventType: BudgetJournalEventType;
  payload: BudgetEventPayload;
  occurredAt: string;
  writer: Readonly<{ hostname: string; pid: number }>;
  privateKey: ReturnType<typeof createPrivateKey>;
  eventId: string;
}>): Readonly<{ event: BudgetJournalEvent; nextState: MutableState }> {
  assertIdentifier(input.operationId, "operation_id");
  assertIdentifier(input.eventId, "event_id");
  assertTimestamp(input.occurredAt, "occurred_at");
  const opHash = operationHash(input.eventType, input.payload);
  const priorOperation = input.state.operations.get(input.operationId);
  if (priorOperation) {
    if (priorOperation.operationHash !== opHash) fail("operation_conflict", "operation ID was already used for different content");
    fail("operation_conflict", "idempotent replay must be resolved before event construction");
  }
  const nextState: MutableState = {
    ...input.state,
    reservations: new Map(input.state.reservations),
    runIds: new Set(input.state.runIds),
    operations: new Map(input.state.operations),
  };
  applyPayload(nextState, input.eventType, input.payload, input.occurredAt);
  nextState.ledgerId = input.ledgerId;
  nextState.sequence = input.state.sequence + 1;
  const unsignedWithoutState = {
    schema_version: 1 as const,
    ledger_id: input.ledgerId,
    sequence: nextState.sequence,
    event_id: input.eventId,
    operation_id: input.operationId,
    occurred_at: input.occurredAt,
    writer: Object.freeze({ ...input.writer }),
    event_type: input.eventType,
    payload: input.payload,
    previous_event_sha256: input.state.headHash,
    operation_sha256: opHash,
  };
  // `head_sha256` is deliberately excluded from the signed state projection:
  // including an event's own hash in the state that the event hashes would
  // require a cryptographic fixed point. The event chain and signed head bind it
  // independently.
  const finalStateHash = replayStateHash(nextState);
  const finalBody: Omit<BudgetJournalEvent, "event_sha256" | "signature_base64"> = Object.freeze({
    ...unsignedWithoutState,
    state_sha256_after: finalStateHash,
  });
  const finalHash = eventHash(finalBody);
  nextState.headHash = finalHash;
  nextState.operations.set(input.operationId, Object.freeze({ operationHash: opHash, sequence: nextState.sequence }));
  const event: BudgetJournalEvent = Object.freeze({
    ...finalBody,
    event_sha256: finalHash,
    signature_base64: sign(null, Buffer.from(finalHash, "hex"), input.privateKey).toString("base64"),
  });
  return Object.freeze({ event, nextState });
}

function replayStateHash(state: MutableState): string {
  return sha256Hex(`${STATE_DOMAIN}${canonicalJson({ ...publicState(state), head_sha256: null })}`);
}

async function mutate(
  options: BudgetLedgerStoreOptions,
  operationId: string,
  eventType: BudgetJournalEventType,
  payloadFactory: (state: MutableState, now: string) => BudgetEventPayload,
  lockedPrecondition?: (
    state: MutableState,
    events: readonly BudgetJournalEvent[],
    paths: StorePaths,
    occurredAt: string,
  ) => void | LockedMutationCommitGuard | Promise<void | LockedMutationCommitGuard>,
): Promise<BudgetLedgerMutationResult> {
  return withLock(options, async (paths) => {
    const loaded = await loadVerified(paths, true);
    const occurredAt = (options.now?.() ?? new Date()).toISOString();
    let guard: void | LockedMutationCommitGuard = undefined;
    try {
      guard = await lockedPrecondition?.(loaded.state, loaded.events, paths, occurredAt);
      const payload = payloadFactory(loaded.state, occurredAt);
      assertNoCredentialMaterial(payload);
      const opHash = operationHash(eventType, payload);
      const priorOperation = loaded.state.operations.get(operationId);
      if (priorOperation) {
        if (priorOperation.operationHash !== opHash) fail("operation_conflict", "operation ID was already used for different content");
        const event = loaded.events[priorOperation.sequence - 1];
        return Object.freeze({ snapshot: snapshot(loaded.state), event, idempotent_replay: true });
      }
      const privateKey = await loadSigningKey(paths, loaded.state);
      const built = buildEvent({
        state: loaded.state,
        ledgerId: loaded.state.ledgerId,
        operationId,
        eventType,
        payload,
        occurredAt,
        writer: Object.freeze({ hostname: options.hostname ?? hostname(), pid: options.pid ?? process.pid }),
        privateKey,
        eventId: (options.randomId ?? randomUUID)(),
      });
      if (replayStateHash(built.nextState) !== built.event.state_sha256_after) {
        fail("integrity_failure", "internal budget state hash invariant failed");
      }
      const line = Buffer.from(`${canonicalJson(built.event)}\n`, "utf8");
      if (line.byteLength > MAX_EVENT_BYTES) fail("invalid_input", "budget event exceeds the per-event size limit");
      // The exclusive plan-consumption marker stays open and is revalidated
      // immediately before the append that commits spend authority. This
      // closes the lstat/open pathname gap without pretending Node exposes
      // portable openat(2) primitives.
      await guard?.assertDurablyBound();
      const byteLength = await appendFully(loaded.ledger, line);
      await writeHead(paths, built.nextState, byteLength, privateKey);
      // Do not report success if a concurrent same-user rename detached the
      // marker during the ledger/head commit window.
      await guard?.assertDurablyBound();
      return Object.freeze({ snapshot: snapshot(built.nextState), event: built.event, idempotent_replay: false });
    } finally {
      await Promise.all([
        guard?.close(),
        loaded.ledger.handle.close(),
      ]);
    }
  });
}

export async function initializeFilesystemBudgetLedger(input: BudgetLedgerStoreOptions & Readonly<{
  ledgerId?: string;
  operationId: string;
  operationalCeilingUsd?: UsdInput;
  initiallyPaused?: boolean;
}>): Promise<BudgetLedgerMutationResult> {
  return withLock(input, async (paths) => {
    for (const path of [paths.ledger, paths.head, paths.key]) {
      if (await lstat(path).catch(() => null)) fail("ledger_exists", "budget ledger initialization found existing state");
    }
    const ledgerId = input.ledgerId ?? `budget-${(input.randomId ?? randomUUID)()}`;
    assertIdentifier(ledgerId, "ledger_id");
    assertIdentifier(input.operationId, "operation_id");
    const operational = usdToMicroUsd(input.operationalCeilingUsd ?? DEFAULT_OPERATIONAL_CEILING_USD);
    if (operational <= 0 || operational > MAX_SCHEDULING_STOP_MICRO_USD) {
      fail("invalid_input", "operational ceiling must be positive and no greater than $900");
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
    const publicDer = publicKey.export({ type: "spki", format: "der" });
    const keyHandle = await open(paths.key, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    try {
      await keyHandle.writeFile(privatePem);
      await keyHandle.sync();
    } finally {
      await keyHandle.close();
    }
    await chmod(paths.key, PRIVATE_FILE_MODE);
    const ledgerHandle = await open(paths.ledger, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    await ledgerHandle.close();
    const heldLedger = await openHeldPrivateFile(
      paths.ledger,
      "budget ledger",
      constants.O_RDWR | constants.O_APPEND,
    );
    const payload: InitializedPayload = Object.freeze({
      currency: "USD",
      public_key_spki_base64: Buffer.from(publicDer).toString("base64"),
      public_key_fingerprint_sha256: sha256Hex(publicDer),
      authorization_ceiling_micro_usd: MAX_AUTHORIZED_BUDGET_MICRO_USD,
      scheduling_stop_micro_usd: MAX_SCHEDULING_STOP_MICRO_USD,
      operational_ceiling_micro_usd: operational,
      paused: input.initiallyPaused ?? false,
    });
    const built = buildEvent({
      state: emptyState(),
      ledgerId,
      operationId: input.operationId,
      eventType: "ledger.initialized",
      payload,
      occurredAt: (input.now?.() ?? new Date()).toISOString(),
      writer: Object.freeze({ hostname: input.hostname ?? hostname(), pid: input.pid ?? process.pid }),
      privateKey,
      eventId: (input.randomId ?? randomUUID)(),
    });
    try {
      const line = Buffer.from(`${canonicalJson(built.event)}\n`, "utf8");
      const byteLength = await appendFully(heldLedger, line);
      await writeHead(paths, built.nextState, byteLength, privateKey);
      return Object.freeze({ snapshot: snapshot(built.nextState), event: built.event, idempotent_replay: false });
    } finally {
      await heldLedger.handle.close();
    }
  });
}

export async function inspectFilesystemBudgetLedger(options: BudgetLedgerStoreOptions): Promise<BudgetJournalSnapshot> {
  return withLock(options, async (paths) => {
    const loaded = await loadVerified(paths);
    try {
      return snapshot(loaded.state);
    } finally {
      await loaded.ledger.handle.close();
    }
  });
}

/**
 * Proves that a previously verified Gate 0 head is an ancestor of the current
 * signed append-only ledger. Matching only `ledger_id` would permit a newly
 * initialized ledger with a reused human-readable ID to bypass the release
 * packet's zero-spend lineage.
 */
export async function filesystemBudgetLedgerContainsHead(
  options: BudgetLedgerStoreOptions & Readonly<{ ancestorHeadSha256: string }>,
): Promise<boolean> {
  assertHash(options.ancestorHeadSha256, "ancestorHeadSha256");
  return withLock(options, async (paths) => {
    const loaded = await loadVerified(paths);
    try {
      return loaded.events.some(
        (event) => event.event_sha256 === options.ancestorHeadSha256,
      );
    } finally {
      await loaded.ledger.handle.close();
    }
  });
}

type HeldDirectoryBinding = Readonly<{
  path: string;
  handle: FileHandle;
  dev: bigint;
  ino: bigint;
  privateDirectory: boolean;
}>;

type HeldFileBinding = Readonly<{
  path: string;
  handle: FileHandle;
  dev: bigint;
  ino: bigint;
}>;

function sameFilesystemIdentity(
  left: Readonly<{ dev: bigint; ino: bigint }>,
  right: Readonly<{ dev: bigint; ino: bigint }>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openHeldDirectory(
  path: string,
  label: string,
  privateDirectory: boolean,
): Promise<HeldDirectoryBinding> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch(() => null);
  if (!handle) fail("unsafe_filesystem", `${label} must be a local non-symlink directory`);
  try {
    const info = await handle.stat({ bigint: true });
    const held = Object.freeze({
      path,
      handle,
      dev: info.dev,
      ino: info.ino,
      privateDirectory,
    });
    await assertHeldDirectoryBound(held, label);
    return held;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertHeldDirectoryBound(
  held: HeldDirectoryBinding,
  label: string,
): Promise<void> {
  const [descriptorInfo, pathInfo, canonicalPath] = await Promise.all([
    held.handle.stat({ bigint: true }).catch(() => null),
    lstat(held.path, { bigint: true }).catch(() => null),
    realpath(held.path).catch(() => null),
  ]);
  if (
    !descriptorInfo
    || !pathInfo
    || !descriptorInfo.isDirectory()
    || !pathInfo.isDirectory()
    || pathInfo.isSymbolicLink()
    || !sameFilesystemIdentity(descriptorInfo, held)
    || !sameFilesystemIdentity(pathInfo, held)
    || canonicalPath !== held.path
    || (held.privateDirectory && (
      (descriptorInfo.mode & BIGINT_PRIVATE_MASK) !== BIGINT_ZERO
      || (pathInfo.mode & BIGINT_PRIVATE_MASK) !== BIGINT_ZERO
    ))
  ) {
    fail("unsafe_filesystem", `${label} changed or is no longer safely reachable`);
  }
}

async function assertHeldFileBound(
  held: HeldFileBinding,
  label: string,
): Promise<void> {
  const [descriptorInfo, pathInfo] = await Promise.all([
    held.handle.stat({ bigint: true }).catch(() => null),
    lstat(held.path, { bigint: true }).catch(() => null),
  ]);
  if (
    !descriptorInfo
    || !pathInfo
    || !descriptorInfo.isFile()
    || !pathInfo.isFile()
    || pathInfo.isSymbolicLink()
    || descriptorInfo.nlink !== BIGINT_ONE
    || pathInfo.nlink !== BIGINT_ONE
    || (descriptorInfo.mode & BIGINT_PRIVATE_MASK) !== BIGINT_ZERO
    || (pathInfo.mode & BIGINT_PRIVATE_MASK) !== BIGINT_ZERO
    || !sameFilesystemIdentity(descriptorInfo, held)
    || !sameFilesystemIdentity(pathInfo, held)
  ) {
    fail("unsafe_filesystem", `${label} changed or is no longer safely reachable`);
  }
}

async function createPlanConsumptionCommitGuard(input: Readonly<{
  paths: StorePaths;
  identity: string;
  body: Readonly<Record<string, unknown>>;
}>): Promise<LockedMutationCommitGuard> {
  const directoryPath = `${input.paths.ledger}.plan-consumptions`;
  let parent: HeldDirectoryBinding | null = null;
  let directory: HeldDirectoryBinding | null = null;
  let anchor: HeldFileBinding | null = null;
  try {
    parent = await openHeldDirectory(input.paths.parent, "budget ledger parent", false);
    try {
      await mkdir(directoryPath, { mode: LOCK_MODE });
      await parent.handle.sync();
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
    }
    directory = await openHeldDirectory(
      directoryPath,
      "plan-consumption anchor directory",
      true,
    );
    await assertHeldDirectoryBound(parent, "budget ledger parent");
    const anchorPath = join(directoryPath, `${input.identity}.json`);
    let handle: FileHandle;
    try {
      handle = await open(
        anchorPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
    } catch (error) {
      if (isRecord(error) && error.code === "EEXIST") {
        fail("plan_consumed", "paid plan authority was already consumed");
      }
      throw error;
    }
    const anchorInfo = await handle.stat({ bigint: true });
    anchor = Object.freeze({
      path: anchorPath,
      handle,
      dev: anchorInfo.dev,
      ino: anchorInfo.ino,
    });
    await assertHeldDirectoryBound(directory, "plan-consumption anchor directory");
    await assertHeldFileBound(anchor, "plan-consumption anchor");
    await handle.writeFile(`${canonicalJson(input.body)}\n`, "utf8");
    await handle.sync();

    const assertDurablyBound = async (): Promise<void> => {
      await assertHeldDirectoryBound(parent!, "budget ledger parent");
      await assertHeldDirectoryBound(directory!, "plan-consumption anchor directory");
      await assertHeldFileBound(anchor!, "plan-consumption anchor");
      // Sync the already-verified descriptors, never a freshly reopened
      // pathname, then repeat identity checks to catch replacement during
      // durability operations.
      await directory!.handle.sync();
      await parent!.handle.sync();
      await assertHeldDirectoryBound(parent!, "budget ledger parent");
      await assertHeldDirectoryBound(directory!, "plan-consumption anchor directory");
      await assertHeldFileBound(anchor!, "plan-consumption anchor");
    };
    await assertDurablyBound();
    return Object.freeze({
      assertDurablyBound,
      close: async () => {
        await Promise.all([
          anchor!.handle.close(),
          directory!.handle.close(),
          parent!.handle.close(),
        ]);
      },
    });
  } catch (error) {
    await Promise.all([
      anchor?.handle.close().catch(() => undefined),
      directory?.handle.close().catch(() => undefined),
      parent?.handle.close().catch(() => undefined),
    ]);
    throw error;
  }
}

export async function reserveFilesystemBudget(input: BudgetLedgerStoreOptions & Readonly<{
  operationId: string;
  reservationId: string;
  runId: string;
  provider: string;
  model: string;
  condition: string;
  expiresAt: string;
  costEnvelope: BudgetCostEnvelope;
  expectedLedgerId?: string;
  requiredAncestorHeadSha256?: string;
  requiredCurrentHeadSha256?: string;
  planConsumption?: BudgetPlanConsumption;
}>): Promise<BudgetLedgerMutationResult> {
  const normalized = normalizeEnvelope(input.costEnvelope);
  if (input.expectedLedgerId !== undefined) {
    assertIdentifier(input.expectedLedgerId, "expectedLedgerId");
  }
  if (input.requiredAncestorHeadSha256 !== undefined) {
    assertHash(input.requiredAncestorHeadSha256, "requiredAncestorHeadSha256");
  }
  if ((input.requiredCurrentHeadSha256 === undefined) !== (input.planConsumption === undefined)) {
    fail("invalid_input", "exact current head and one-shot plan consumption must be supplied together");
  }
  if (input.requiredCurrentHeadSha256 !== undefined) {
    assertHash(input.requiredCurrentHeadSha256, "requiredCurrentHeadSha256");
  }
  if (input.planConsumption !== undefined) {
    if (input.planConsumption.kind !== undefined
      && input.planConsumption.kind !== "gate1_paid_plan"
      && input.planConsumption.kind !== "lc4_qualification_v2"
      && input.planConsumption.kind !== "lc4_qualification_v3"
      && input.planConsumption.kind !== "lc4_dev_six_episode") {
      fail("invalid_input", "plan consumption kind is unsupported");
    }
    assertIdentifier(input.planConsumption.consumptionId, "planConsumption.consumptionId");
    assertHash(input.planConsumption.planSha256, "planConsumption.planSha256");
    assertMicroUsd(input.planConsumption.maximumMicroUsd, "planConsumption.maximumMicroUsd", true);
    if (input.planConsumption.kind !== "lc4_dev_six_episode"
      && input.planConsumption.maximumMicroUsd !== normalized.maximum) {
      fail("invalid_input", "plan consumption maximum differs from the cost envelope");
    }
    if (input.planConsumption.kind === "lc4_qualification_v2") {
      const value = input.planConsumption;
      for (const [label, hash] of [
        ["authorizationArtifactSha256", value.authorizationArtifactSha256],
        ["sourceTreeSha256", value.sourceTreeSha256],
        ["credentialSetSha256", value.credentialSetSha256],
        ["providerProfileManifestSha256", value.providerProfileManifestSha256],
        ["configurationMatrixSha256", value.configurationMatrixSha256],
        ["devConfigurationMatrixSha256", value.devConfigurationMatrixSha256],
        ["providersModelsSha256", value.providersModelsSha256],
      ] as const) assertHash(hash, `planConsumption.${label}`);
      assertIdentifier(value.authorizationId, "planConsumption.authorizationId");
      assertIdentifier(value.attemptId, "planConsumption.attemptId");
      assertIdentifier(value.sourceCommit, "planConsumption.sourceCommit");
      if (value.authorizationId !== value.attemptId) {
        fail("invalid_input", "qualification authorization and attempt IDs must match");
      }
      if (value.maximumMicroUsd !== LC4_QUALIFICATION_V2_MAXIMUM_MICRO_USD
        || value.maximumResponseGenerations !== LC4_QUALIFICATION_V2_RESPONSE_GENERATIONS
        || value.maximumPaidGenerationSessions !== LC4_QUALIFICATION_V2_PAID_GENERATION_SESSIONS
        || value.paidRetryAllowed !== false) {
        fail("invalid_input", "qualification consumption weakened the exact v2 budget or no-retry contract");
      }
    } else if (input.planConsumption.kind === "lc4_qualification_v3") {
      const value = input.planConsumption;
      for (const [label, hash] of [
        ["authorizationArtifactSha256", value.authorizationArtifactSha256],
        ["sourceTreeSha256", value.sourceTreeSha256],
        ["credentialSetSha256", value.credentialSetSha256],
        ["providerProfileManifestSha256", value.providerProfileManifestSha256],
        ["configurationMatrixSha256", value.configurationMatrixSha256],
        ["devConfigurationMatrixSha256", value.devConfigurationMatrixSha256],
        ["providersModelsSha256", value.providersModelsSha256],
      ] as const) assertHash(hash, `planConsumption.${label}`);
      assertIdentifier(value.authorizationId, "planConsumption.authorizationId");
      assertIdentifier(value.attemptId, "planConsumption.attemptId");
      assertIdentifier(value.sourceCommit, "planConsumption.sourceCommit");
      if (value.authorizationId !== value.attemptId) {
        fail("invalid_input", "qualification authorization and attempt IDs must match");
      }
      if (value.maximumMicroUsd !== LC4_QUALIFICATION_V3_MAXIMUM_MICRO_USD
        || value.maximumProviderSessions !== LC4_QUALIFICATION_V3_PROVIDER_SESSIONS
        || value.maximumPaidGenerationSessions !== LC4_QUALIFICATION_V3_PAID_GENERATION_SESSIONS
        || value.maximumLogicalGenerationPhases !== LC4_QUALIFICATION_V3_LOGICAL_GENERATION_PHASES
        || value.maximumToolRoundtrips !== LC4_QUALIFICATION_V3_TOOL_ROUNDTRIPS
        || value.maximumRetries !== LC4_QUALIFICATION_V3_RETRIES) {
        fail("invalid_input", "qualification consumption weakened the exact v3 budget, session, phase, roundtrip, or no-retry contract");
      }
    } else if (input.planConsumption.kind === "lc4_dev_six_episode") {
      const value = input.planConsumption;
      for (const [label, digest] of [
        ["authorizationArtifactSha256", value.authorizationArtifactSha256],
        ["prepareSha256", value.prepareSha256],
        ["preflightSha256", value.preflightSha256],
        ["sourceTreeSha256", value.sourceTreeSha256],
        ["credentialSetSha256", value.credentialSetSha256],
        ["providerProfileManifestSha256", value.providerProfileManifestSha256],
        ["audioManifestSha256", value.audioManifestSha256],
        ["qualificationReceiptSha256", value.qualificationReceiptSha256],
        ["episodeSetSha256", value.episodeSetSha256],
      ] as const) assertHash(digest, `planConsumption.${label}`);
      assertIdentifier(value.executionId, "planConsumption.executionId");
      assertIdentifier(value.sourceCommit, "planConsumption.sourceCommit");
      if (value.maximumMicroUsd !== LC4_DEV_SIX_EPISODE_MAXIMUM_MICRO_USD
        || value.maximumEpisodeCount !== LC4_DEV_SIX_EPISODE_CELLS
        || value.maximumSegmentCount !== LC4_DEV_SIX_EPISODE_SEGMENTS
        || value.maximumRetries !== LC4_DEV_SIX_EPISODE_RETRIES
        || value.maximumReconnects !== LC4_DEV_SIX_EPISODE_RECONNECTS
        || !Number.isSafeInteger(value.maximumRunDurationMs)
        || value.maximumRunDurationMs <= 0) {
        fail("invalid_input", "LC4-DEV consumption weakened the exact aggregate budget, cell, segment, duration, no-retry, or no-reconnect contract");
      }
      if (normalized.maximum <= 0 || normalized.maximum > value.maximumMicroUsd) {
        fail("invalid_input", "LC4-DEV first cell reservation exceeds aggregate authority");
      }
    } else if (input.planConsumption.maximumMicroUsd !== PAID_PLAN_CONSUMPTION_MAXIMUM_MICRO_USD) {
      fail("invalid_input", "paid plan consumption must bind the exact $5 maximum");
    }
  }
  return mutate(input, input.operationId, "reservation.created", () => Object.freeze({
    reservation_id: input.reservationId,
    run_id: input.runId,
    provider: input.provider,
    model: input.model,
    condition: input.condition,
    expires_at: input.expiresAt,
    maximum_micro_usd: normalized.maximum,
    envelope: normalized.envelope,
  }), async (state, events, paths, occurredAt) => {
    if (
      input.expectedLedgerId !== undefined
      && state.ledgerId !== input.expectedLedgerId
    ) {
      fail("integrity_failure", "budget ledger ID differs from the required release-gate ledger");
    }
    if (
      input.requiredAncestorHeadSha256 !== undefined
      && !events.some((event) => event.event_sha256 === input.requiredAncestorHeadSha256)
    ) {
      fail("integrity_failure", "budget ledger does not descend from the required release-gate head");
    }
    if (
      input.requiredCurrentHeadSha256 !== undefined
      && state.headHash !== input.requiredCurrentHeadSha256
    ) {
      fail("integrity_failure", "budget ledger head differs from the exact plan-bound open head");
    }
    if (input.planConsumption !== undefined && input.requiredCurrentHeadSha256 !== undefined) {
      // This anchor deliberately lives outside the signed ledger/head/key
      // triplet: restoring a previously valid triplet cannot re-arm the same
      // signed open head. Creation precedes reservation and is never rolled
      // back automatically, so a crash can strand authority but cannot release
      // it. An owner able to delete or roll back the entire local directory can
      // still remove both stores; closing that threat requires external
      // monotonic or WORM authority.
      const qualificationConsumption = input.planConsumption.kind === "lc4_qualification_v2"
        || input.planConsumption.kind === "lc4_qualification_v3"
        ? input.planConsumption
        : null;
      const devConsumption = input.planConsumption.kind === "lc4_dev_six_episode"
        ? input.planConsumption
        : null;
      const body = Object.freeze({
        schema_version: 1,
        kind: devConsumption !== null
          ? "hacc_lc4_dev_six_episode_consumption"
          : qualificationConsumption === null
          ? "hacc_paid_plan_consumption"
          : qualificationConsumption.kind === "lc4_qualification_v3"
            ? "hacc_lc4_qualification_v3_consumption"
            : "hacc_lc4_qualification_v2_consumption",
        ledger_id: state.ledgerId,
        ledger_open_head_sha256: input.requiredCurrentHeadSha256,
        consumption_id: input.planConsumption.consumptionId,
        plan_sha256: input.planConsumption.planSha256,
        maximum_micro_usd: input.planConsumption.maximumMicroUsd,
        run_id: input.runId,
        reservation_id: input.reservationId,
        operation_id: input.operationId,
        consumed_at: occurredAt,
        ...(devConsumption === null ? {} : {
          authorization_artifact_sha256: devConsumption.authorizationArtifactSha256,
          execution_id: devConsumption.executionId,
          prepare_sha256: devConsumption.prepareSha256,
          preflight_sha256: devConsumption.preflightSha256,
          source_commit: devConsumption.sourceCommit,
          source_tree_sha256: devConsumption.sourceTreeSha256,
          credential_set_sha256: devConsumption.credentialSetSha256,
          provider_profile_manifest_sha256: devConsumption.providerProfileManifestSha256,
          audio_manifest_sha256: devConsumption.audioManifestSha256,
          qualification_receipt_sha256: devConsumption.qualificationReceiptSha256,
          episode_set_sha256: devConsumption.episodeSetSha256,
          maximum_episode_count: devConsumption.maximumEpisodeCount,
          maximum_segment_count: devConsumption.maximumSegmentCount,
          maximum_retries: devConsumption.maximumRetries,
          maximum_reconnects: devConsumption.maximumReconnects,
          maximum_run_duration_ms: devConsumption.maximumRunDurationMs,
        }),
        ...(qualificationConsumption === null ? {} : {
          authorization_artifact_sha256: qualificationConsumption.authorizationArtifactSha256,
          authorization_id: qualificationConsumption.authorizationId,
          attempt_id: qualificationConsumption.attemptId,
          source_commit: qualificationConsumption.sourceCommit,
          source_tree_sha256: qualificationConsumption.sourceTreeSha256,
          credential_set_sha256: qualificationConsumption.credentialSetSha256,
          provider_profile_manifest_sha256: qualificationConsumption.providerProfileManifestSha256,
          configuration_matrix_sha256: qualificationConsumption.configurationMatrixSha256,
          dev_configuration_matrix_sha256: qualificationConsumption.devConfigurationMatrixSha256,
          providers_models_sha256: qualificationConsumption.providersModelsSha256,
          maximum_paid_generation_sessions: qualificationConsumption.maximumPaidGenerationSessions,
          ...(qualificationConsumption.kind === "lc4_qualification_v2" ? {
            maximum_response_generations: qualificationConsumption.maximumResponseGenerations,
            paid_retry_allowed: qualificationConsumption.paidRetryAllowed,
          } : {
            maximum_provider_sessions: qualificationConsumption.maximumProviderSessions,
            maximum_logical_generation_phases: qualificationConsumption.maximumLogicalGenerationPhases,
            maximum_tool_roundtrips: qualificationConsumption.maximumToolRoundtrips,
            maximum_retries: qualificationConsumption.maximumRetries,
          }),
        }),
      });
      const identityDomain = devConsumption !== null
        ? LC4_DEV_SIX_EPISODE_PLAN_CONSUMPTION_DOMAIN
        : qualificationConsumption?.kind === "lc4_qualification_v3"
        ? LC4_QUALIFICATION_V3_PLAN_CONSUMPTION_DOMAIN
        : PLAN_CONSUMPTION_DOMAIN;
      const identity = sha256Hex(`${identityDomain}${canonicalJson(
        devConsumption !== null
          ? {
              ledger_id: body.ledger_id,
              kind: body.kind,
              authorization_artifact_sha256: devConsumption.authorizationArtifactSha256,
              execution_id: devConsumption.executionId,
              plan_sha256: devConsumption.planSha256,
              episode_set_sha256: devConsumption.episodeSetSha256,
            }
          : qualificationConsumption === null
          ? {
              ledger_id: body.ledger_id,
              ledger_open_head_sha256: body.ledger_open_head_sha256,
            }
          : {
              ledger_id: body.ledger_id,
              kind: body.kind,
              authorization_artifact_sha256: qualificationConsumption.authorizationArtifactSha256,
              authorization_id: qualificationConsumption.authorizationId,
              attempt_id: qualificationConsumption.attemptId,
              plan_sha256: qualificationConsumption.planSha256,
            },
      )}`);
      return await createPlanConsumptionCommitGuard({ paths, identity, body });
    }
    return undefined;
  });
}

export async function markBudgetConnectionIntent(input: BudgetLedgerStoreOptions & Readonly<{
  operationId: string;
  reservationId: string;
}>): Promise<BudgetLedgerMutationResult> {
  return mutate(input, input.operationId, "reservation.connection_intent", () => Object.freeze({ reservation_id: input.reservationId }));
}

export async function markBudgetSessionOpened(input: BudgetLedgerStoreOptions & Readonly<{
  operationId: string;
  reservationId: string;
}>): Promise<BudgetLedgerMutationResult> {
  return mutate(input, input.operationId, "reservation.opened", () => Object.freeze({ reservation_id: input.reservationId }));
}

export async function recordBudgetTerminal(input: BudgetLedgerStoreOptions & Readonly<{
  operationId: string;
  reservationId: string;
  outcome: BudgetJournalTerminalOutcome;
}>): Promise<BudgetLedgerMutationResult> {
  return mutate(input, input.operationId, "reservation.terminal", () => Object.freeze({
    reservation_id: input.reservationId,
    outcome: input.outcome,
  }));
}

export async function settleFilesystemBudget(input: BudgetLedgerStoreOptions & Readonly<{
  operationId: string;
  reservationId: string;
  estimatedUsd: UsdInput;
  providerReportedUsd?: UsdInput;
}>): Promise<BudgetLedgerMutationResult> {
  return mutate(input, input.operationId, "reservation.settled", () => Object.freeze({
    reservation_id: input.reservationId,
    estimated_micro_usd: usdToMicroUsd(input.estimatedUsd),
    provider_reported_micro_usd: input.providerReportedUsd === undefined ? null : usdToMicroUsd(input.providerReportedUsd),
  }));
}

export async function recordFilesystemProviderCost(input: BudgetLedgerStoreOptions & Readonly<{
  operationId: string;
  reservationId: string;
  providerReportedUsd: UsdInput;
}>): Promise<BudgetLedgerMutationResult> {
  return mutate(input, input.operationId, "reservation.provider_cost_observed", () => Object.freeze({
    reservation_id: input.reservationId,
    provider_reported_micro_usd: usdToMicroUsd(input.providerReportedUsd),
  }));
}

export async function recordFilesystemBudgetUsage(input: BudgetLedgerStoreOptions & Readonly<{
  operationId: string;
  reservationId: string;
  usageEventCount: number;
  usageEvidenceSha256: string;
}>): Promise<BudgetLedgerMutationResult> {
  if (!Number.isSafeInteger(input.usageEventCount) || input.usageEventCount < 0) {
    fail("invalid_input", "usageEventCount must be a non-negative safe integer");
  }
  assertHash(input.usageEvidenceSha256, "usageEvidenceSha256");
  return mutate(input, input.operationId, "reservation.usage_observed", () => Object.freeze({
    reservation_id: input.reservationId,
    usage_event_count: input.usageEventCount,
    usage_evidence_sha256: input.usageEvidenceSha256,
  }));
}

export async function reconcileFilesystemBudget(input: BudgetLedgerStoreOptions & Readonly<{
  operationId: string;
  reservationId: string;
  reconciledUsd: UsdInput;
  evidenceSha256: string;
}>): Promise<BudgetLedgerMutationResult> {
  assertHash(input.evidenceSha256, "evidenceSha256");
  return mutate(input, input.operationId, "reservation.reconciled", () => Object.freeze({
    reservation_id: input.reservationId,
    reconciled_micro_usd: usdToMicroUsd(input.reconciledUsd),
    evidence_sha256: input.evidenceSha256,
  }));
}

export async function cancelFilesystemBudgetBeforeOpen(input: BudgetLedgerStoreOptions & Readonly<{
  operationId: string;
  reservationId: string;
}>): Promise<BudgetLedgerMutationResult> {
  return mutate(input, input.operationId, "reservation.cancelled_before_open", () => Object.freeze({ reservation_id: input.reservationId }));
}

export async function expireFilesystemBudgetReservation(input: BudgetLedgerStoreOptions & Readonly<{
  operationId: string;
  reservationId: string;
}>): Promise<BudgetLedgerMutationResult> {
  return mutate(input, input.operationId, "reservation.expired", () => Object.freeze({ reservation_id: input.reservationId }));
}

export async function changeFilesystemOperationalCeiling(input: BudgetLedgerStoreOptions & Readonly<{
  operationId: string;
  operationalCeilingUsd: UsdInput;
  reasonCode: string;
  evidenceSha256: string;
}>): Promise<BudgetLedgerMutationResult> {
  assertIdentifier(input.reasonCode, "reasonCode");
  assertHash(input.evidenceSha256, "evidenceSha256");
  return mutate(input, input.operationId, "operational_ceiling.changed", () => Object.freeze({
    operational_ceiling_micro_usd: usdToMicroUsd(input.operationalCeilingUsd),
    reason_code: input.reasonCode,
    evidence_sha256: input.evidenceSha256,
  }));
}

export async function setFilesystemBudgetPaused(input: BudgetLedgerStoreOptions & Readonly<{
  operationId: string;
  paused: boolean;
  reasonCode: string;
  evidenceSha256: string;
  expectedLedgerId?: string;
  expectedHeadSha256?: string;
}>): Promise<BudgetLedgerMutationResult> {
  assertIdentifier(input.reasonCode, "reasonCode");
  assertHash(input.evidenceSha256, "evidenceSha256");
  if (input.expectedLedgerId !== undefined) assertIdentifier(input.expectedLedgerId, "expectedLedgerId");
  if (input.expectedHeadSha256 !== undefined) assertHash(input.expectedHeadSha256, "expectedHeadSha256");
  return mutate(input, input.operationId, input.paused ? "ledger.paused" : "ledger.resumed", () => Object.freeze({
    reason_code: input.reasonCode,
    evidence_sha256: input.evidenceSha256,
  }), (state) => {
    if (input.expectedLedgerId !== undefined && state.ledgerId !== input.expectedLedgerId) {
      fail("integrity_failure", "budget ledger ID differs from the operator-confirmed ledger");
    }
    // A confirmed retry of the same operation ID remains idempotent after the
    // first append changed the head. A new operation must compare-and-append
    // against the exact head the operator inspected.
    if (
      input.expectedHeadSha256 !== undefined
      && !state.operations.has(input.operationId)
      && state.headHash !== input.expectedHeadSha256
    ) {
      fail("integrity_failure", "budget ledger head changed after operator inspection");
    }
  });
}

/**
 * Explicit crash recovery for the narrow append-fsynced/head-not-renamed case.
 * It never changes or truncates the event log. Any invalid event/signature is
 * still a hard failure and a head that is not an exact signed prefix is refused.
 */
export async function recoverFilesystemBudgetHead(options: BudgetLedgerStoreOptions): Promise<BudgetJournalSnapshot> {
  return withLock(options, async (paths) => {
    const loaded = await loadEvents(paths);
    try {
      const state = replayEvents(loaded.events);
      const existingBytes = await readPrivateFile(
        paths.head,
        "budget ledger head",
        MAX_EVENT_BYTES,
      ).catch((error: unknown) => {
        if (error instanceof FilesystemBudgetLedgerError && error.code === "ledger_missing") {
          return null;
        }
        throw error;
      });
      if (existingBytes !== null) {
        const existing = parseHead(existingBytes.toString("utf8"));
        if (existing.ledger_id !== state.ledgerId || existing.sequence > state.sequence) {
          fail("integrity_failure", "budget head is not a recoverable prefix of the event log");
        }
        const prefix = loaded.events[existing.sequence - 1];
        if (!prefix || prefix.event_sha256 !== existing.event_sha256) {
          fail("integrity_failure", "budget head diverges from the event log and cannot be recovered automatically");
        }
      }
      const privateKey = await loadSigningKey(paths, state);
      await writeHead(paths, state, loaded.bytes, privateKey);
      return snapshot(state);
    } finally {
      await loaded.ledger.handle.close();
    }
  });
}

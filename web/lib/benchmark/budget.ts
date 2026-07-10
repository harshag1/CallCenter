/**
 * Spend guard for benchmark runs.
 *
 * Monetary values are stored as integer micro-USD so a reservation can never
 * be admitted because of floating-point rounding. The public authorization is
 * capped at $1,000 and new work stops being scheduled at $900, preserving a
 * $100 overage/reconciliation reserve.
 */

export const MICRO_USD_PER_USD = 1_000_000;
export const MAX_AUTHORIZED_BUDGET_MICRO_USD = 1_000 * MICRO_USD_PER_USD;
export const MAX_SCHEDULING_STOP_MICRO_USD = 900 * MICRO_USD_PER_USD;

export type UsdInput = number | string;

export type BudgetGuardErrorCode =
  | "invalid_amount"
  | "invalid_configuration"
  | "invalid_ledger"
  | "duplicate_reservation"
  | "unknown_reservation"
  | "reservation_not_active"
  | "reservation_not_settled"
  | "authorization_ceiling_breached"
  | "scheduling_stop_reached"
  | "scheduling_stop_exceeded";

export class BudgetGuardError extends Error {
  readonly code: BudgetGuardErrorCode;

  constructor(code: BudgetGuardErrorCode, message: string) {
    super(message);
    this.name = "BudgetGuardError";
    this.code = code;
  }
}

export type ReservationCosts = Readonly<{
  /** Runner-side estimate derived from measured usage. */
  estimated_micro_usd: number | null;
  /** Amount reported by the provider, before invoice reconciliation. */
  provider_reported_micro_usd: number | null;
  /** Authoritative amount reconciled to billing data or an invoice. */
  reconciled_micro_usd: number | null;
}>;

export type BudgetReservation = Readonly<{
  reservation_id: string;
  provider: string;
  model: string;
  run_id: string;
  created_at: string;
  maximum_micro_usd: number;
  status: "active" | "settled" | "released";
  costs: ReservationCosts;
}>;

export type BudgetLedger = Readonly<{
  schema_version: 1;
  currency: "USD";
  authorization_ceiling_micro_usd: number;
  scheduling_stop_micro_usd: number;
  reservations: readonly BudgetReservation[];
}>;

export type BudgetSnapshot = Readonly<{
  state: "open" | "scheduling_closed" | "authorization_breached";
  estimated_micro_usd: number;
  provider_reported_micro_usd: number;
  reconciled_micro_usd: number;
  active_reservations_micro_usd: number;
  conservative_settled_micro_usd: number;
  scheduling_exposure_micro_usd: number;
  scheduling_remaining_micro_usd: number;
  authorization_remaining_micro_usd: number;
  /** Exact decimal strings for logs and human-readable reports. */
  usd: Readonly<{
    estimated: string;
    provider_reported: string;
    reconciled: string;
    active_reservations: string;
    conservative_settled: string;
    scheduling_exposure: string;
    scheduling_remaining: string;
    authorization_remaining: string;
  }>;
}>;

const EMPTY_COSTS: ReservationCosts = Object.freeze({
  estimated_micro_usd: null,
  provider_reported_micro_usd: null,
  reconciled_micro_usd: null,
});

function guard(
  condition: unknown,
  code: BudgetGuardErrorCode,
  message: string
): asserts condition {
  if (!condition) throw new BudgetGuardError(code, message);
}

function isSafeMicroUsd(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safeSum(values: readonly number[], label: string): number {
  let sum = 0;
  for (const value of values) {
    guard(isSafeMicroUsd(value), "invalid_ledger", `${label} contains an invalid micro-USD amount`);
    sum += value;
    guard(Number.isSafeInteger(sum), "invalid_ledger", `${label} exceeds safe integer precision`);
  }
  return sum;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  guard(
    typeof value === "string" && value.trim().length > 0 && value.length <= 256,
    "invalid_ledger",
    `${label} must be a non-empty string of at most 256 characters`
  );
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  guard(
    typeof value === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
      && Number.isFinite(Date.parse(value)),
    "invalid_ledger",
    `${label} must be an ISO-8601 UTC timestamp`
  );
}

function freezeReservation(reservation: BudgetReservation): BudgetReservation {
  return Object.freeze({
    ...reservation,
    costs: Object.freeze({ ...reservation.costs }),
  });
}

function freezeLedger(
  ledger: Omit<BudgetLedger, "reservations">,
  reservations: readonly BudgetReservation[]
): BudgetLedger {
  return Object.freeze({
    ...ledger,
    reservations: Object.freeze(reservations.map(freezeReservation)),
  });
}

/** Parse USD without silently accepting fractions smaller than one micro-USD. */
export function usdToMicroUsd(value: UsdInput): number {
  if (typeof value === "string") {
    const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value);
    guard(Boolean(match), "invalid_amount", `Invalid USD amount: ${JSON.stringify(value)}`);
    const whole = Number(match![1]);
    const fraction = (match![2] ?? "").padEnd(6, "0");
    const result = whole * MICRO_USD_PER_USD + Number(fraction || "0");
    guard(isSafeMicroUsd(result), "invalid_amount", "USD amount exceeds safe integer precision");
    return result;
  }

  guard(Number.isFinite(value) && value >= 0, "invalid_amount", "USD amount must be finite and non-negative");
  const scaled = value * MICRO_USD_PER_USD;
  const rounded = Math.round(scaled);
  guard(
    Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) <= 1e-6,
    "invalid_amount",
    "USD amount must have at most six decimal places"
  );
  return rounded;
}

export function microUsdToDecimal(microUsd: number): string {
  guard(isSafeMicroUsd(microUsd), "invalid_amount", "micro-USD amount must be a non-negative safe integer");
  const whole = Math.floor(microUsd / MICRO_USD_PER_USD);
  const fraction = String(microUsd % MICRO_USD_PER_USD).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function createBudgetLedger(options: {
  authorization_ceiling_usd?: UsdInput;
  scheduling_stop_usd?: UsdInput;
} = {}): BudgetLedger {
  const authorization = options.authorization_ceiling_usd === undefined
    ? MAX_AUTHORIZED_BUDGET_MICRO_USD
    : usdToMicroUsd(options.authorization_ceiling_usd);
  const scheduling = options.scheduling_stop_usd === undefined
    ? MAX_SCHEDULING_STOP_MICRO_USD
    : usdToMicroUsd(options.scheduling_stop_usd);

  guard(
    authorization > 0 && authorization <= MAX_AUTHORIZED_BUDGET_MICRO_USD,
    "invalid_configuration",
    "Authorization ceiling must be greater than zero and cannot exceed $1,000"
  );
  guard(
    scheduling > 0 && scheduling <= MAX_SCHEDULING_STOP_MICRO_USD,
    "invalid_configuration",
    "Scheduling stop must be greater than zero and cannot exceed $900"
  );
  guard(
    scheduling <= authorization,
    "invalid_configuration",
    "Scheduling stop cannot exceed the authorization ceiling"
  );

  return Object.freeze({
    schema_version: 1,
    currency: "USD",
    authorization_ceiling_micro_usd: authorization,
    scheduling_stop_micro_usd: scheduling,
    reservations: Object.freeze([]),
  });
}

/**
 * Validate a deserialized ledger before it is trusted by the spend guard.
 * Every mutator invokes this, so malformed or partially missing state fails
 * closed instead of resetting spend to zero.
 */
export function assertValidBudgetLedger(ledger: BudgetLedger): void {
  guard(ledger && typeof ledger === "object", "invalid_ledger", "Budget ledger is missing");
  guard(ledger.schema_version === 1, "invalid_ledger", "Unsupported budget ledger schema");
  guard(ledger.currency === "USD", "invalid_ledger", "Budget ledger currency must be USD");
  guard(
    isSafeMicroUsd(ledger.authorization_ceiling_micro_usd)
      && ledger.authorization_ceiling_micro_usd > 0
      && ledger.authorization_ceiling_micro_usd <= MAX_AUTHORIZED_BUDGET_MICRO_USD,
    "invalid_ledger",
    "Budget ledger authorization ceiling is invalid"
  );
  guard(
    isSafeMicroUsd(ledger.scheduling_stop_micro_usd)
      && ledger.scheduling_stop_micro_usd > 0
      && ledger.scheduling_stop_micro_usd <= MAX_SCHEDULING_STOP_MICRO_USD
      && ledger.scheduling_stop_micro_usd <= ledger.authorization_ceiling_micro_usd,
    "invalid_ledger",
    "Budget ledger scheduling stop is invalid"
  );
  guard(Array.isArray(ledger.reservations), "invalid_ledger", "Budget reservations must be an array");

  const ids = new Set<string>();
  for (const reservation of ledger.reservations) {
    guard(reservation && typeof reservation === "object", "invalid_ledger", "Reservation is invalid");
    assertIdentifier(reservation.reservation_id, "reservation_id");
    assertIdentifier(reservation.provider, "provider");
    assertIdentifier(reservation.model, "model");
    assertIdentifier(reservation.run_id, "run_id");
    assertTimestamp(reservation.created_at, "created_at");
    guard(!ids.has(reservation.reservation_id), "invalid_ledger", "Reservation IDs must be unique");
    ids.add(reservation.reservation_id);
    guard(
      isSafeMicroUsd(reservation.maximum_micro_usd) && reservation.maximum_micro_usd > 0,
      "invalid_ledger",
      "Reservation maximum must be positive"
    );
    guard(
      reservation.status === "active" || reservation.status === "settled" || reservation.status === "released",
      "invalid_ledger",
      "Reservation status is invalid"
    );
    const costs = reservation.costs;
    guard(costs && typeof costs === "object", "invalid_ledger", "Reservation costs are missing");
    const costKeys = Object.keys(costs).sort();
    guard(
      costKeys.length === 3
        && costKeys[0] === "estimated_micro_usd"
        && costKeys[1] === "provider_reported_micro_usd"
        && costKeys[2] === "reconciled_micro_usd",
      "invalid_ledger",
      "Reservation costs must contain exactly the three auditable cost channels"
    );
    for (const [label, amount] of Object.entries(costs)) {
      guard(
        amount === null || isSafeMicroUsd(amount),
        "invalid_ledger",
        `${label} is not a valid micro-USD amount`
      );
    }
    if (reservation.status === "settled") {
      guard(
        costs.estimated_micro_usd !== null,
        "invalid_ledger",
        "A settled reservation must retain its runner estimate"
      );
    } else {
      guard(
        costs.estimated_micro_usd === null
          && costs.provider_reported_micro_usd === null
          && costs.reconciled_micro_usd === null,
        "invalid_ledger",
        "Only settled reservations may contain observed costs"
      );
    }
  }
}

function conservativeSettledCost(reservation: BudgetReservation): number {
  if (reservation.status !== "settled") return 0;
  const { costs } = reservation;
  if (costs.reconciled_micro_usd !== null) return costs.reconciled_micro_usd;
  return Math.max(
    costs.estimated_micro_usd ?? reservation.maximum_micro_usd,
    costs.provider_reported_micro_usd ?? 0
  );
}

export function budgetSnapshot(ledger: BudgetLedger): BudgetSnapshot {
  assertValidBudgetLedger(ledger);
  const settled = ledger.reservations.filter((reservation) => reservation.status === "settled");
  const active = ledger.reservations.filter((reservation) => reservation.status === "active");
  const estimated = safeSum(
    settled.map((reservation) => reservation.costs.estimated_micro_usd ?? 0),
    "estimated costs"
  );
  const providerReported = safeSum(
    settled.map((reservation) => reservation.costs.provider_reported_micro_usd ?? 0),
    "provider-reported costs"
  );
  const reconciled = safeSum(
    settled.map((reservation) => reservation.costs.reconciled_micro_usd ?? 0),
    "reconciled costs"
  );
  const activeReservations = safeSum(
    active.map((reservation) => reservation.maximum_micro_usd),
    "active reservations"
  );
  const conservativeSettled = safeSum(
    settled.map(conservativeSettledCost),
    "conservative settled costs"
  );
  const exposure = safeSum(
    [activeReservations, conservativeSettled],
    "scheduling exposure"
  );
  const schedulingRemaining = Math.max(0, ledger.scheduling_stop_micro_usd - exposure);
  const authorizationRemaining = Math.max(0, ledger.authorization_ceiling_micro_usd - exposure);
  const state = exposure > ledger.authorization_ceiling_micro_usd
    ? "authorization_breached"
    : exposure >= ledger.scheduling_stop_micro_usd
      ? "scheduling_closed"
      : "open";

  const usd = Object.freeze({
    estimated: microUsdToDecimal(estimated),
    provider_reported: microUsdToDecimal(providerReported),
    reconciled: microUsdToDecimal(reconciled),
    active_reservations: microUsdToDecimal(activeReservations),
    conservative_settled: microUsdToDecimal(conservativeSettled),
    scheduling_exposure: microUsdToDecimal(exposure),
    scheduling_remaining: microUsdToDecimal(schedulingRemaining),
    authorization_remaining: microUsdToDecimal(authorizationRemaining),
  });

  return Object.freeze({
    state,
    estimated_micro_usd: estimated,
    provider_reported_micro_usd: providerReported,
    reconciled_micro_usd: reconciled,
    active_reservations_micro_usd: activeReservations,
    conservative_settled_micro_usd: conservativeSettled,
    scheduling_exposure_micro_usd: exposure,
    scheduling_remaining_micro_usd: schedulingRemaining,
    authorization_remaining_micro_usd: authorizationRemaining,
    usd,
  });
}

function replaceReservation(
  ledger: BudgetLedger,
  reservationId: string,
  update: (reservation: BudgetReservation) => BudgetReservation
): BudgetLedger {
  const index = ledger.reservations.findIndex((reservation) => reservation.reservation_id === reservationId);
  guard(index >= 0, "unknown_reservation", `Unknown budget reservation: ${reservationId}`);
  const reservations = ledger.reservations.map((reservation, current) =>
    current === index ? update(reservation) : reservation
  );
  return freezeLedger(ledger, reservations);
}

export function reserveBudget(
  ledger: BudgetLedger,
  request: {
    reservation_id: string;
    provider: string;
    model: string;
    run_id: string;
    created_at: string;
    maximum_usd: UsdInput;
  }
): Readonly<{ ledger: BudgetLedger; reservation: BudgetReservation }> {
  assertValidBudgetLedger(ledger);
  assertIdentifier(request.reservation_id, "reservation_id");
  assertIdentifier(request.provider, "provider");
  assertIdentifier(request.model, "model");
  assertIdentifier(request.run_id, "run_id");
  assertTimestamp(request.created_at, "created_at");
  guard(
    !ledger.reservations.some((reservation) => reservation.reservation_id === request.reservation_id),
    "duplicate_reservation",
    `Reservation ${request.reservation_id} already exists`
  );

  const maximum = usdToMicroUsd(request.maximum_usd);
  guard(maximum > 0, "invalid_amount", "A reservation maximum must be greater than zero");
  const before = budgetSnapshot(ledger);
  guard(
    before.state !== "authorization_breached",
    "authorization_ceiling_breached",
    "Recorded spend has breached the authorization ceiling; no work may be scheduled"
  );
  guard(
    before.scheduling_exposure_micro_usd < ledger.scheduling_stop_micro_usd,
    "scheduling_stop_reached",
    "Scheduling stop has been reached; no work may be scheduled"
  );
  const projected = safeSum(
    [before.scheduling_exposure_micro_usd, maximum],
    "projected scheduling exposure"
  );
  guard(
    projected <= ledger.authorization_ceiling_micro_usd,
    "authorization_ceiling_breached",
    "Reservation would exceed the authorization ceiling"
  );
  guard(
    projected <= ledger.scheduling_stop_micro_usd,
    "scheduling_stop_exceeded",
    `Reservation would exceed the $${microUsdToDecimal(ledger.scheduling_stop_micro_usd)} scheduling stop`
  );

  const reservation: BudgetReservation = Object.freeze({
    reservation_id: request.reservation_id,
    provider: request.provider,
    model: request.model,
    run_id: request.run_id,
    created_at: request.created_at,
    maximum_micro_usd: maximum,
    status: "active",
    costs: EMPTY_COSTS,
  });
  const nextLedger = freezeLedger(ledger, [...ledger.reservations, reservation]);
  return Object.freeze({ ledger: nextLedger, reservation });
}

export function releaseBudgetReservation(ledger: BudgetLedger, reservationId: string): BudgetLedger {
  assertValidBudgetLedger(ledger);
  return replaceReservation(ledger, reservationId, (reservation) => {
    guard(
      reservation.status === "active",
      "reservation_not_active",
      `Reservation ${reservationId} is not active`
    );
    return Object.freeze({ ...reservation, status: "released" as const });
  });
}

export function settleBudgetReservation(
  ledger: BudgetLedger,
  reservationId: string,
  costs: {
    estimated_usd: UsdInput;
    provider_reported_usd?: UsdInput;
    reconciled_usd?: UsdInput;
  }
): BudgetLedger {
  assertValidBudgetLedger(ledger);
  const estimated = usdToMicroUsd(costs.estimated_usd);
  const providerReported = costs.provider_reported_usd === undefined
    ? null
    : usdToMicroUsd(costs.provider_reported_usd);
  const reconciled = costs.reconciled_usd === undefined
    ? null
    : usdToMicroUsd(costs.reconciled_usd);

  return replaceReservation(ledger, reservationId, (reservation) => {
    guard(
      reservation.status === "active",
      "reservation_not_active",
      `Reservation ${reservationId} is not active`
    );
    return Object.freeze({
      ...reservation,
      status: "settled" as const,
      costs: Object.freeze({
        estimated_micro_usd: estimated,
        provider_reported_micro_usd: providerReported,
        reconciled_micro_usd: reconciled,
      }),
    });
  });
}

export function recordProviderReportedCost(
  ledger: BudgetLedger,
  reservationId: string,
  providerReportedUsd: UsdInput
): BudgetLedger {
  assertValidBudgetLedger(ledger);
  const amount = usdToMicroUsd(providerReportedUsd);
  return replaceReservation(ledger, reservationId, (reservation) => {
    guard(
      reservation.status === "settled",
      "reservation_not_settled",
      `Reservation ${reservationId} must be settled before recording provider cost`
    );
    return Object.freeze({
      ...reservation,
      costs: Object.freeze({ ...reservation.costs, provider_reported_micro_usd: amount }),
    });
  });
}

export function reconcileBudgetReservation(
  ledger: BudgetLedger,
  reservationId: string,
  reconciledUsd: UsdInput
): BudgetLedger {
  assertValidBudgetLedger(ledger);
  const amount = usdToMicroUsd(reconciledUsd);
  return replaceReservation(ledger, reservationId, (reservation) => {
    guard(
      reservation.status === "settled",
      "reservation_not_settled",
      `Reservation ${reservationId} must be settled before reconciliation`
    );
    return Object.freeze({
      ...reservation,
      costs: Object.freeze({ ...reservation.costs, reconciled_micro_usd: amount }),
    });
  });
}

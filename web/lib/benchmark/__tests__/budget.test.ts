import { describe, expect, it } from "vitest";
import {
  BudgetGuardError,
  MAX_AUTHORIZED_BUDGET_MICRO_USD,
  MAX_SCHEDULING_STOP_MICRO_USD,
  assertValidBudgetLedger,
  budgetSnapshot,
  createBudgetLedger,
  microUsdToDecimal,
  reconcileBudgetReservation,
  releaseBudgetReservation,
  reserveBudget,
  settleBudgetReservation,
  usdToMicroUsd,
} from "../budget";

const reservation = (id: string, maximum: string) => ({
  reservation_id: id,
  provider: "openai",
  model: "gpt-realtime-2.1",
  run_id: "run-1",
  created_at: "2026-07-10T12:00:00.000Z",
  maximum_usd: maximum,
});

function expectBudgetCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected action to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(BudgetGuardError);
    expect((error as BudgetGuardError).code).toBe(code);
  }
}

describe("benchmark budget guard", () => {
  it("pins the public ceiling at $1,000 and the scheduling stop at $900", () => {
    const ledger = createBudgetLedger();
    expect(ledger.authorization_ceiling_micro_usd).toBe(MAX_AUTHORIZED_BUDGET_MICRO_USD);
    expect(ledger.scheduling_stop_micro_usd).toBe(MAX_SCHEDULING_STOP_MICRO_USD);
    expectBudgetCode(
      () => createBudgetLedger({ authorization_ceiling_usd: "1000.000001" }),
      "invalid_configuration"
    );
    expectBudgetCode(
      () => createBudgetLedger({ scheduling_stop_usd: "900.000001" }),
      "invalid_configuration"
    );
  });

  it("uses exact micro-USD and rejects sub-micro precision", () => {
    expect(usdToMicroUsd("12.345678")).toBe(12_345_678);
    expect(usdToMicroUsd(0.1)).toBe(100_000);
    expect(microUsdToDecimal(12_345_600)).toBe("12.3456");
    expectBudgetCode(() => usdToMicroUsd("0.0000001"), "invalid_amount");
    expectBudgetCode(() => usdToMicroUsd(0.0000001), "invalid_amount");
  });

  it("reserves immutably and fails closed at projected scheduling exposure", () => {
    const initial = createBudgetLedger();
    const first = reserveBudget(initial, reservation("r-1", "899.999999"));
    expect(initial.reservations).toHaveLength(0);
    expect(Object.isFrozen(first.ledger)).toBe(true);
    expect(budgetSnapshot(first.ledger).usd.scheduling_remaining).toBe("0.000001");

    expectBudgetCode(
      () => reserveBudget(first.ledger, reservation("r-too-big", "0.000002")),
      "scheduling_stop_exceeded"
    );
    const full = reserveBudget(first.ledger, reservation("r-2", "0.000001")).ledger;
    expect(budgetSnapshot(full).state).toBe("scheduling_closed");
    expectBudgetCode(
      () => reserveBudget(full, reservation("r-3", "0.000001")),
      "scheduling_stop_reached"
    );
  });

  it("keeps estimate, provider report, and reconciliation as separate totals", () => {
    const active = reserveBudget(createBudgetLedger(), reservation("r-1", "10")).ledger;
    const settled = settleBudgetReservation(active, "r-1", {
      estimated_usd: "7.25",
      provider_reported_usd: "8.50",
    });
    const beforeReconciliation = budgetSnapshot(settled);
    expect(beforeReconciliation.usd).toMatchObject({
      estimated: "7.25",
      provider_reported: "8.5",
      reconciled: "0",
      conservative_settled: "8.5",
      active_reservations: "0",
    });

    const reconciled = reconcileBudgetReservation(settled, "r-1", "7.90");
    expect(budgetSnapshot(reconciled).usd).toMatchObject({
      estimated: "7.25",
      provider_reported: "8.5",
      reconciled: "7.9",
      conservative_settled: "7.9",
    });
  });

  it("records an overage instead of hiding it, then refuses all new scheduling", () => {
    const active = reserveBudget(createBudgetLedger(), reservation("r-1", "5")).ledger;
    const over = settleBudgetReservation(active, "r-1", {
      estimated_usd: "1001",
      provider_reported_usd: "1001",
    });
    expect(budgetSnapshot(over).state).toBe("authorization_breached");
    expectBudgetCode(
      () => reserveBudget(over, reservation("r-2", "1")),
      "authorization_ceiling_breached"
    );
  });

  it("releases unused exposure and rejects malformed deserialized state", () => {
    const active = reserveBudget(createBudgetLedger(), reservation("r-1", "40")).ledger;
    const released = releaseBudgetReservation(active, "r-1");
    expect(budgetSnapshot(released).scheduling_exposure_micro_usd).toBe(0);

    const malformed = {
      ...createBudgetLedger(),
      reservations: undefined,
    } as unknown as ReturnType<typeof createBudgetLedger>;
    expectBudgetCode(() => assertValidBudgetLedger(malformed), "invalid_ledger");
  });
});

import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeFilesystemBudgetLedger,
  inspectFilesystemBudgetLedger,
  reserveFilesystemBudget,
  type BudgetCostEnvelope,
  type Lc4QualificationV2PlanConsumption,
} from "../filesystem-budget-ledger";
import {
  LC4_QUALIFICATION_BUDGET_MAXIMUM_MICRO_USD,
  assertLc4QualificationBudgetEvidence,
  finalizeLc4QualificationBudget,
  lc4QualificationBudgetLedgerPath,
  reserveLc4QualificationBudget,
  type Lc4QualificationBudgetBinding,
} from "../lc4-qualification-budget";

const roots: string[] = [];
const NOW = new Date("2026-07-22T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "hacc-lc4-qualification-test-budget-"));
  roots.push(value);
  return value;
}

function binding(attemptId = "qualification-attempt-001"): Lc4QualificationBudgetBinding {
  return Object.freeze({
    attemptId,
    authorizationId: attemptId,
    authorizationArtifactSha256: "a".repeat(64),
    planSha256: "b".repeat(64),
    sourceCommit: "c".repeat(40),
    sourceTreeSha256: "d".repeat(64),
    credentialSetSha256: "e".repeat(64),
    providerProfileManifestSha256: "f".repeat(64),
    configurationMatrixSha256: "1".repeat(64),
    devConfigurationMatrixSha256: "2".repeat(64),
    providersModels: Object.freeze({
      openai: "gpt-realtime-2.1",
      gemini: "gemini-3.1-flash-live-preview",
      xai: "grok-voice-think-fast-1.0",
    }),
    expiresAt: "2026-07-22T13:00:00.000Z",
  });
}

describe("LC4 qualification v2 budget authority", () => {
  it("reserves before execution and settles one exact aggregate $3 authority with usage evidence", async () => {
    const evidenceRoot = await root();
    const reservation = await reserveLc4QualificationBudget({
      root: evidenceRoot,
      binding: binding(),
      now: () => NOW,
    });
    const opened = await inspectFilesystemBudgetLedger({ ledgerPath: reservation.ledgerPath });
    expect(opened.reservations).toHaveLength(1);
    expect(opened.reservations[0]).toMatchObject({
      reservation_id: reservation.reservationId,
      provider: "openai+gemini+xai",
      model: "exact-model-matrix-v2",
      maximum_micro_usd: LC4_QUALIFICATION_BUDGET_MAXIMUM_MICRO_USD,
      status: "opened",
      usage_event_count: null,
    });

    const evidence = await finalizeLc4QualificationBudget({
      reservation,
      attemptId: binding().attemptId,
      usageEventCount: 6,
      usageEvidenceSha256: "3".repeat(64),
      outcome: "completed",
      now: () => NOW,
    });
    expect(evidence).toMatchObject({
      terminal_outcome: "completed",
      usage_event_count: 6,
      usage_evidence_sha256: "3".repeat(64),
      conservative_settled_micro_usd: 3_000_000,
    });
    expect(() => assertLc4QualificationBudgetEvidence(evidence)).not.toThrow();
    expect(() => assertLc4QualificationBudgetEvidence({
      ...evidence,
      conservative_settled_micro_usd: 1,
    })).toThrow("weakened the exact settlement contract");
    const settled = await inspectFilesystemBudgetLedger({ ledgerPath: reservation.ledgerPath });
    expect(settled.reservations[0]).toMatchObject({
      status: "settled",
      terminal_outcome: "completed",
      estimated_micro_usd: 3_000_000,
      usage_event_count: 6,
      usage_evidence_sha256: "3".repeat(64),
    });
    expect(settled.active_reservations_micro_usd).toBe(0);
  });

  it("blocks signed-attempt replay even after the signed ledger triplet is rolled back", async () => {
    const evidenceRoot = await root();
    const ledgerPath = lc4QualificationBudgetLedgerPath(evidenceRoot);
    await mkdir(join(evidenceRoot, "budget"), { mode: 0o700 });
    await initializeFilesystemBudgetLedger({
      ledgerPath,
      ledgerId: "qualification-rollback-test",
      operationId: "initialize-qualification-rollback-test",
      operationalCeilingUsd: "3",
      now: () => NOW,
    });
    const openTriplet = await Promise.all([
      readFile(ledgerPath),
      readFile(`${ledgerPath}.head.json`),
      readFile(`${ledgerPath}.signing-key.pem`),
    ]);
    await reserveLc4QualificationBudget({ root: evidenceRoot, binding: binding(), now: () => NOW });
    await Promise.all([
      writeFile(ledgerPath, openTriplet[0], { mode: 0o600 }),
      writeFile(`${ledgerPath}.head.json`, openTriplet[1], { mode: 0o600 }),
      writeFile(`${ledgerPath}.signing-key.pem`, openTriplet[2], { mode: 0o600 }),
    ]);
    await expect(reserveLc4QualificationBudget({
      root: evidenceRoot,
      binding: binding(),
      now: () => NOW,
    })).rejects.toMatchObject({ code: "plan_consumed" });
    expect((await inspectFilesystemBudgetLedger({ ledgerPath })).reservations).toEqual([]);
    expect(await readdir(`${ledgerPath}.plan-consumptions`)).toHaveLength(1);
  });

  it("fails closed on an unsettled prior attempt and on a tampered ledger", async () => {
    const evidenceRoot = await root();
    const reservation = await reserveLc4QualificationBudget({ root: evidenceRoot, binding: binding(), now: () => NOW });
    await expect(reserveLc4QualificationBudget({
      root: evidenceRoot,
      binding: binding("qualification-attempt-002"),
      now: () => NOW,
    })).rejects.toMatchObject({ code: "EEXIST" });
    await appendFile(reservation.ledgerPath, "tamper\n");
    await expect(inspectFilesystemBudgetLedger({ ledgerPath: reservation.ledgerPath }))
      .rejects.toMatchObject({ code: "integrity_failure" });
  });

  it("does not weaken the legacy $5 contract and rejects altered qualification caps", async () => {
    const evidenceRoot = await root();
    const ledgerPath = lc4QualificationBudgetLedgerPath(evidenceRoot);
    await mkdir(join(evidenceRoot, "budget"), { mode: 0o700 });
    const initialized = await initializeFilesystemBudgetLedger({
      ledgerPath,
      operationId: "initialize-cap-test",
      operationalCeilingUsd: "5",
      now: () => NOW,
    });
    const envelope: BudgetCostEnvelope = Object.freeze({
      schema_version: 1,
      kind: "hacc_provider_gate1_cost_envelope",
      pricing_snapshot_sha256: "4".repeat(64),
      provider_hard_session_caps_sha256: "5".repeat(64),
      runner_config_sha256: "6".repeat(64),
      formula_sha256: "7".repeat(64),
      components: Object.freeze([Object.freeze({ name: "maximum", upper_bound_micro_usd: 3_000_000 })]),
      safety_margin_micro_usd: 0,
    });
    const consumption: Lc4QualificationV2PlanConsumption = Object.freeze({
      kind: "lc4_qualification_v2",
      consumptionId: "cap-test",
      planSha256: "8".repeat(64),
      maximumMicroUsd: 3_000_000,
      authorizationArtifactSha256: "9".repeat(64),
      authorizationId: "cap-attempt",
      attemptId: "cap-attempt",
      sourceCommit: "a".repeat(40),
      sourceTreeSha256: "b".repeat(64),
      credentialSetSha256: "c".repeat(64),
      providerProfileManifestSha256: "d".repeat(64),
      configurationMatrixSha256: "e".repeat(64),
      devConfigurationMatrixSha256: "f".repeat(64),
      providersModelsSha256: "1".repeat(64),
      maximumResponseGenerations: 7,
      maximumPaidGenerationSessions: 6,
      paidRetryAllowed: false,
    });
    await expect(reserveFilesystemBudget({
      ledgerPath,
      operationId: "reserve-cap-test",
      reservationId: "cap-test",
      runId: "cap-test",
      provider: "openai+gemini+xai",
      model: "matrix",
      condition: "qualification-v2",
      expiresAt: binding().expiresAt,
      costEnvelope: envelope,
      requiredCurrentHeadSha256: initialized.snapshot.head_sha256,
      planConsumption: consumption,
      now: () => NOW,
    })).rejects.toMatchObject({ code: "invalid_input" });

    await expect(reserveFilesystemBudget({
      ledgerPath,
      operationId: "reserve-legacy-wrong-max",
      reservationId: "legacy-wrong-max",
      runId: "legacy-wrong-max",
      provider: "openai",
      model: "gpt-realtime-2.1",
      condition: "gate1",
      expiresAt: binding().expiresAt,
      costEnvelope: envelope,
      requiredCurrentHeadSha256: initialized.snapshot.head_sha256,
      planConsumption: {
        consumptionId: "legacy-wrong-max",
        planSha256: "2".repeat(64),
        maximumMicroUsd: 3_000_000,
      },
      now: () => NOW,
    })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

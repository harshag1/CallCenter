import { describe, expect, it } from "vitest";
import {
  assertOfflineStressPassed,
  canonicalStressJson,
  runOfflineDeterministicStress,
  serializeOfflineStressReport,
} from "../index";

const SOURCE = "d".repeat(64);

describe("HACC offline deterministic stress proof", () => {
  it("contains forged/stale proposals, effect races, correction replay, audibility, and signed evidence", async () => {
    const report = await runOfflineDeterministicStress({
      proposalCount: 80,
      raceScheduleCount: 40,
      replayScheduleCount: 40,
      seedStart: 9_000,
      sourceSha256: SOURCE,
    });

    expect(report.status).toBe("passed");
    expect(report.config).toEqual({
      proposal_count: 80,
      race_schedule_count: 40,
      replay_schedule_count: 40,
      seed_start: 9_000,
      seed_end: 9_159,
    });
    expect(report.proposals).toMatchObject({
      total: 80,
      allowed: 20,
      denied_forged: 20,
      rejected_stale: 20,
      terminal_replays: 20,
      unauthorized_effects: 0,
      stale_dispatches: 0,
      duplicate_effects: 0,
    });
    expect(report.races).toMatchObject({
      total: 40,
      normal_settlements: 10,
      stale_before_dispatch: 10,
      indeterminate_reconciled: 10,
      idempotency_conflicts: 10,
      duplicate_effects: 0,
      stale_dispatches: 0,
      blind_retries: 0,
    });
    expect(report.replay).toMatchObject({
      total: 40,
      exact_replays: 40,
      reconnect_recoveries: 40,
      corrections_applied: 40,
      stale_worker_deliveries_rejected: 40,
      forbidden_claim_release_attempts: 40,
      forbidden_claims_released: 0,
      replay_mismatches: 0,
    });
    expect(report.evidence).toEqual({ replay_ok: true, useful_mission_success: true, tamper_rejected: true, replay_errors: [] });
    expect(Object.values(report.hard_gates).every(Boolean)).toBe(true);
    expect(() => assertOfflineStressPassed(report)).not.toThrow();
    expect(serializeOfflineStressReport(report)).toBe(`${canonicalStressJson(report)}\n`);

    const tampered = structuredClone(report);
    (tampered.proposals as { allowed: number }).allowed += 1;
    expect(() => assertOfflineStressPassed(tampered)).toThrow(/logical digest mismatch/);
  });

  it("repeats the exact logical proof for an identical seed range", async () => {
    const config = { proposalCount: 24, raceScheduleCount: 12, replayScheduleCount: 12, seedStart: 100, sourceSha256: SOURCE };
    const first = await runOfflineDeterministicStress(config);
    const second = await runOfflineDeterministicStress(config);
    expect(second.digests.config_sha256).toBe(first.digests.config_sha256);
    expect(second.digests.logical_result_sha256).toBe(first.digests.logical_result_sha256);
    expect(second.digests.evidence_manifest_sha256).toBe(first.digests.evidence_manifest_sha256);
    expect(second.proposals).toEqual(first.proposals);
    expect(second.races).toEqual(first.races);
    expect(second.replay).toEqual(first.replay);
  });

  it("rejects invalid workload and source identity inputs", async () => {
    await expect(runOfflineDeterministicStress({ proposalCount: 0, sourceSha256: SOURCE })).rejects.toThrow(/proposalCount/);
    await expect(runOfflineDeterministicStress({ sourceSha256: "not-a-digest" })).rejects.toThrow(/sourceSha256/);
  });
});

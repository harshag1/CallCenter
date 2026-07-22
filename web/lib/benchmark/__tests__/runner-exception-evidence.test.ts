import { describe, expect, it } from "vitest";
import { sha256Hex } from "../artifacts";
import type { TrialResult } from "../orchestrator";
import { retainedTrialEvidence } from "../runner-exception-evidence";

function trialResult(
  estimatedMicroUsd: number | null,
  reservationStatus: "active" | "settled" | "released" = "settled",
): TrialResult {
  const manifestJson = '{"files":[{"path":"trial-result.json"}]}\n';
  return {
    counters: { turnsPlanned: 20, turnsSent: 17 },
    providerEvidence: { audio: { output: Array.from({ length: 16 }, () => ({})) } },
    callerSchedule: { status: "blocked" },
    budgetLedger: {
      reservations: [{
        reservation_id: "episode-cell-reservation",
        status: reservationStatus,
        costs: { estimated_micro_usd: estimatedMicroUsd },
      }],
    },
    artifacts: { manifestJson },
  } as unknown as TrialResult;
}

describe("runner exception retained trial evidence", () => {
  it("preserves completed trial measurements and their actual artifact binding", () => {
    const result = trialResult(1_234_567);

    expect(retainedTrialEvidence(result, "episode-cell-reservation")).toEqual({
      turnsPlanned: 20,
      turnsSent: 17,
      outputAudioTurns: 16,
      callerScheduleStatus: "blocked",
      estimatedCostUsd: 1.234567,
      artifactManifestSha256: sha256Hex(result.artifacts.manifestJson),
    });
  });

  it("does not invent a cost when the settled trial has no estimate", () => {
    expect(retainedTrialEvidence(trialResult(null), "episode-cell-reservation").estimatedCostUsd).toBeNull();
  });

  it("does not mislabel active or missing reservations as settled cost", () => {
    expect(retainedTrialEvidence(
      trialResult(1_234_567, "active"),
      "episode-cell-reservation",
    ).estimatedCostUsd).toBeNull();
    expect(retainedTrialEvidence(
      trialResult(1_234_567),
      "other-cell-reservation",
    ).estimatedCostUsd).toBeNull();
  });
});

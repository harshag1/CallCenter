import { sha256Hex } from "./artifacts";
import type { TrialResult } from "./orchestrator";

export type RetainedTrialEvidence = Readonly<{
  turnsPlanned: number;
  turnsSent: number;
  outputAudioTurns: number;
  callerScheduleStatus: string | null;
  estimatedCostUsd: number | null;
  artifactManifestSha256: string;
}>;

/**
 * Preserve measurements that were durably written before a runner-side
 * post-trial validation failed. This deliberately carries no pass/fail claims:
 * callers must still classify the episode as a fail-closed runner exception.
 */
export function retainedTrialEvidence(
  result: TrialResult,
  reservationId: string,
): RetainedTrialEvidence {
  const reservation = result.budgetLedger.reservations.find((candidate) =>
    candidate.reservation_id === reservationId
  );
  return Object.freeze({
    turnsPlanned: result.counters.turnsPlanned,
    turnsSent: result.counters.turnsSent,
    outputAudioTurns: result.providerEvidence.audio.output.length,
    callerScheduleStatus: result.callerSchedule?.status ?? null,
    estimatedCostUsd: reservation?.status !== "settled" || reservation.costs.estimated_micro_usd == null
      ? null
      : reservation.costs.estimated_micro_usd / 1_000_000,
    artifactManifestSha256: sha256Hex(result.artifacts.manifestJson),
  });
}

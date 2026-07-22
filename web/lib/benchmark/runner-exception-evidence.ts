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

const SHA256 = /^[a-f0-9]{64}$/;

export function parseRetainedTrialEvidence(value: unknown): RetainedTrialEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("retained trial evidence must be an object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "artifactManifestSha256",
    "callerScheduleStatus",
    "estimatedCostUsd",
    "outputAudioTurns",
    "turnsPlanned",
    "turnsSent",
  ];
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("retained trial evidence has unexpected fields");
  }
  for (const field of ["turnsPlanned", "turnsSent", "outputAudioTurns"] as const) {
    if (!Number.isSafeInteger(record[field]) || (record[field] as number) < 0) {
      throw new Error(`retained trial evidence has invalid ${field}`);
    }
  }
  if ((record.turnsSent as number) > (record.turnsPlanned as number)) {
    throw new Error("retained trial evidence has turnsSent above turnsPlanned");
  }
  if (record.callerScheduleStatus !== null && typeof record.callerScheduleStatus !== "string") {
    throw new Error("retained trial evidence has invalid callerScheduleStatus");
  }
  if (record.estimatedCostUsd !== null && (
    typeof record.estimatedCostUsd !== "number"
    || !Number.isFinite(record.estimatedCostUsd)
    || record.estimatedCostUsd < 0
  )) {
    throw new Error("retained trial evidence has invalid estimatedCostUsd");
  }
  if (typeof record.artifactManifestSha256 !== "string" || !SHA256.test(record.artifactManifestSha256)) {
    throw new Error("retained trial evidence has invalid artifactManifestSha256");
  }
  return Object.freeze({
    turnsPlanned: record.turnsPlanned as number,
    turnsSent: record.turnsSent as number,
    outputAudioTurns: record.outputAudioTurns as number,
    callerScheduleStatus: record.callerScheduleStatus as string | null,
    estimatedCostUsd: record.estimatedCostUsd as number | null,
    artifactManifestSha256: record.artifactManifestSha256,
  });
}

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

import "server-only";

import { runGovernedCallWorker } from "./governed-call-worker-executor";
import { workerQOne } from "./voice-workers/runtime-db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type GovernedWorkerCandidate = Readonly<{
  workerId: string;
  organizationId: string;
  conversationId: string;
}>;

export type GovernedWorkerDrainResult = Readonly<{
  attempted: number;
  executed: number;
  claimRaces: number;
  timeBudgetExhausted: boolean;
}>;

type GovernedWorkerDrainDependencies = Readonly<{
  nextCandidate(): Promise<GovernedWorkerCandidate | null>;
  run(
    candidate: GovernedWorkerCandidate,
    options: Readonly<{ hostDeadlineAtMs: number }>,
  ): Promise<string | null>;
  now(): number;
}>;

export async function nextGovernedWorkerCandidate(): Promise<GovernedWorkerCandidate | null> {
  const row = await workerQOne<{
    worker_id: string;
    organization_id: string;
    conversation_id: string;
  }>("SELECT * FROM next_governed_voice_worker_candidate()");
  if (!row) return null;
  if (
    !UUID.test(row.worker_id)
    || !UUID.test(row.organization_id)
    || !UUID.test(row.conversation_id)
  ) {
    throw new Error("worker drain received an invalid opaque candidate identity");
  }
  return Object.freeze({
    workerId: row.worker_id,
    organizationId: row.organization_id,
    conversationId: row.conversation_id,
  });
}

/**
 * Bounded crash-recovery backstop for governed workers. Candidate discovery is
 * available only through the isolated worker principal; the web/backend pool
 * never receives a global tenant queue. Each candidate is still exact-claimed
 * by all three immutable identities, so concurrent drains are race-safe.
 */
export async function drainGovernedCallWorkers(
  options: Readonly<{
    maximumWorkers?: number;
    wallClockMs?: number;
  }> = {},
  dependencies: GovernedWorkerDrainDependencies = {
    nextCandidate: nextGovernedWorkerCandidate,
    run: runGovernedCallWorker,
    now: Date.now,
  },
): Promise<GovernedWorkerDrainResult> {
  const maximumWorkers = options.maximumWorkers ?? 2;
  const wallClockMs = options.wallClockMs ?? 90_000;
  if (!Number.isSafeInteger(maximumWorkers) || maximumWorkers < 1 || maximumWorkers > 8) {
    throw new Error("worker drain maximumWorkers must be between 1 and 8");
  }
  if (!Number.isSafeInteger(wallClockMs) || wallClockMs < 5_000 || wallClockMs > 100_000) {
    throw new Error("worker drain wallClockMs must be between 5000 and 100000");
  }

  const startedAt = dependencies.now();
  const hostDeadlineAtMs = startedAt + wallClockMs;
  const seen = new Set<string>();
  let attempted = 0;
  let executed = 0;
  let claimRaces = 0;
  while (attempted < maximumWorkers && dependencies.now() < hostDeadlineAtMs - 1_000) {
    const candidate = await dependencies.nextCandidate();
    if (!candidate || seen.has(candidate.workerId)) break;
    seen.add(candidate.workerId);
    attempted += 1;
    const workerId = await dependencies.run(candidate, { hostDeadlineAtMs });
    if (workerId === candidate.workerId) executed += 1;
    else claimRaces += 1;
  }
  return Object.freeze({
    attempted,
    executed,
    claimRaces,
    timeBudgetExhausted: dependencies.now() >= hostDeadlineAtMs - 1_000,
  });
}

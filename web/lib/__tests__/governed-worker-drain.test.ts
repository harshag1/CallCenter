import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../governed-call-worker-executor", () => ({
  runGovernedCallWorker: vi.fn(),
}));

import { drainGovernedCallWorkers } from "../governed-worker-drain";
import { assertSafeWorkerRuntimeRole } from "../voice-workers/runtime-db";

const pending = {
  workerId: "8916eb0a-5332-4f4c-a330-746c516e83b9",
  organizationId: "8916eb0a-5332-4f4c-a330-746c516e83ba",
  conversationId: "8916eb0a-5332-4f4c-a330-746c516e83bb",
};

describe("governed worker scheduled drain", () => {
  it("executes a durable pending spawn even when the inline waitUntil never ran", async () => {
    const nextCandidate = vi.fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(null);
    const run = vi.fn().mockResolvedValue(pending.workerId);

    await expect(drainGovernedCallWorkers(
      { maximumWorkers: 2, wallClockMs: 45_000 },
      { nextCandidate, run, now: () => 1_000 },
    )).resolves.toEqual({
      attempted: 1,
      executed: 1,
      claimRaces: 0,
      timeBudgetExhausted: false,
    });
    expect(run).toHaveBeenCalledWith(pending, { hostDeadlineAtMs: 46_000 });
  });

  it("hands an expired pre-dispatch process-loss candidate to the exact reclaim path", async () => {
    const reclaimed = {
      ...pending,
      workerId: "9916eb0a-5332-4f4c-a330-746c516e83b9",
    };
    const nextCandidate = vi.fn()
      .mockResolvedValueOnce(reclaimed)
      .mockResolvedValueOnce(null);
    const run = vi.fn().mockResolvedValue(reclaimed.workerId);

    const result = await drainGovernedCallWorkers(
      { maximumWorkers: 2, wallClockMs: 30_000 },
      { nextCandidate, run, now: () => 5_000 },
    );
    expect(result.executed).toBe(1);
    expect(run).toHaveBeenCalledWith(reclaimed, { hostDeadlineAtMs: 35_000 });
  });

  it("caps each tick and does not expose tenant or worker identities in its result", async () => {
    let ordinal = 0;
    const nextCandidate = vi.fn(async () => ({
      ...pending,
      workerId: `${String(++ordinal).padStart(8, "0")}-5332-4f4c-a330-746c516e83b9`,
    }));
    const run = vi.fn(async (candidate) => candidate.workerId);

    const result = await drainGovernedCallWorkers(
      { maximumWorkers: 2, wallClockMs: 45_000 },
      { nextCandidate, run, now: () => 1_000 },
    );
    expect(result).toEqual({
      attempted: 2,
      executed: 2,
      claimRaces: 0,
      timeBudgetExhausted: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/8916eb|organization|conversation|workerId/);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("isolated worker database principal", () => {
  const safe = {
    current_user: "hacc_voice_worker_runtime",
    superuser: false,
    bypassrls: false,
    voice_worker_member: true,
    dialer_worker_member: false,
    backend_member: false,
    unexpected_inherited_roles: [],
    has_direct_application_grants: false,
    inherits_application_owner: false,
  };

  it("accepts only the exact worker login with no backend membership", () => {
    expect(() => assertSafeWorkerRuntimeRole(safe, "hacc_voice_worker_runtime")).not.toThrow();
    expect(() => assertSafeWorkerRuntimeRole(
      { ...safe, backend_member: true },
      "hacc_voice_worker_runtime",
    )).toThrow(/isolated hacc_voice_worker/);
    expect(() => assertSafeWorkerRuntimeRole(
      { ...safe, current_user: "hacc_runtime" },
      "hacc_voice_worker_runtime",
    )).toThrow(/isolated hacc_voice_worker/);
    expect(() => assertSafeWorkerRuntimeRole(
      { ...safe, dialer_worker_member: true },
      "hacc_voice_worker_runtime",
    )).toThrow(/isolated hacc_voice_worker/);
  });
});

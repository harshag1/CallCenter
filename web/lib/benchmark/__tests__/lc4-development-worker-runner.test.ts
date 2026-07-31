import { describe, expect, it } from "vitest";
import { compileLc4DevelopmentAnalog } from "../lc4-development-fixtures";
import {
  createLc4DevelopmentWorkerRuntime,
  runLc4DevelopmentWorkerExperiment,
  verifyLc4DevelopmentWorkerEvidence,
  type Lc4DevelopmentWorkerRuntimeSnapshot,
} from "../lc4-development-worker-runner";

const CLOCK = Object.freeze({ nowIso: () => "2026-07-21T21:00:00.000Z" });

function artifact() {
  return compileLc4DevelopmentAnalog({
    family: "freight-customs",
    variant: "async-conflict",
    seed: 4_242,
  });
}

describe("LC4 development worker experiment integration", () => {
  it("runs identical Native/HACC worker surfaces through 60 opportunities and binds worker evidence to ToolWorld", () => {
    const fixture = artifact();
    const native = runLc4DevelopmentWorkerExperiment({ artifact: fixture, arm: "native", clock: CLOCK });
    const hacc = runLc4DevelopmentWorkerExperiment({ artifact: fixture, arm: "hacc", clock: CLOCK });

    expect(hacc.surface).toEqual(native.surface);
    expect(hacc.surface.filter((tool) => tool.category === "async_worker").map((tool) => tool.name)).toEqual([
      "worker.cancel",
      "worker.start",
      "worker.status",
    ]);
    expect(hacc.worker_dispositions).toEqual([
      { worker_id: "worker.1", result_id: "worker-result.1", expected: "accept", actual: "accept" },
      { worker_id: "worker.2", result_id: "worker-result.2", expected: "reject_stale", actual: "reject_stale" },
      { worker_id: "worker.3", result_id: "worker-result.3", expected: "accept", actual: "accept" },
      { worker_id: "worker.4", result_id: "worker-result.4", expected: "reject_duplicate", actual: "reject_duplicate" },
    ]);
    expect(native.worker_dispositions).toEqual(hacc.worker_dispositions);
    expect(hacc.verification).toMatchObject({
      valid: true,
      errors: [],
      terminal_result_count: 3,
      world_receipt_count: 13,
    });
    expect(native.verification).toMatchObject({ valid: true, errors: [] });
    expect(hacc.world_success).toBe(true);
    expect(native.world_success).toBe(true);
    expect(hacc.snapshot.world).toEqual(native.snapshot.world);
    expect(hacc.snapshot.worker).toEqual(native.snapshot.worker);
    expect(hacc.snapshot.world.receipts.filter((receipt) => receipt.status === "committed_after_error"))
      .toHaveLength(1);
    expect(hacc.snapshot.worker.receipts.filter((receipt) => receipt.kind === "result.accepted"))
      .toHaveLength(3);
    expect(hacc.snapshot.worker.jobs.map((job) => job.status).sort()).toEqual([
      "cancelled",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(hacc.snapshot.worker.receipts.filter((receipt) =>
      receipt.kind === "result.rejected" && receipt.body.reason === "duplicate"
    )).toHaveLength(1);
    const crossBoundary = hacc.snapshot.worker.jobs.find((job) => job.worker_id === "worker.3");
    expect(crossBoundary?.lineage.map((lineage) => lineage.to_session_id)).toEqual([
      "session.act-1",
      "session.warm.21",
      "session.cold.41",
    ]);
    expect(hacc.snapshot.evidence.some((receipt) => receipt.kind === "session.rehydrated")).toBe(true);
    expect(hacc.snapshot.evidence.every((receipt, index, all) =>
      receipt.previous_receipt_sha256 === (index === 0 ? "0".repeat(64) : all[index - 1].receipt_sha256)
    )).toBe(true);
  });

  it("rehydrates a live job and ToolWorld head, then rejects its result after cancellation", () => {
    const fixture = artifact();
    const first = createLc4DevelopmentWorkerRuntime({
      artifact: fixture,
      arm: "hacc",
      sessionId: "session.before",
      clock: CLOCK,
    });
    const started = first.callWorker("worker.start", {
      request_id: "request.cross-session",
      worker_id: "worker.cross-session",
      generation: 1,
      payload: { task: "durable research" },
    });
    if (!started.ok) throw new Error(started.code);
    const attempt = started.job.attempts[0];
    if (!attempt) throw new Error("missing worker attempt");
    const tool = fixture.scenario.tools.find((candidate) => candidate.name.endsWith(".apply_01"));
    const subjectId = fixture.scenario.initial_facts.subject_id;
    if (!tool || typeof subjectId !== "string") throw new Error("invalid LC4 fixture");
    first.executeToolWorld({
      invocationId: "runtime.apply.01",
      action: tool.name,
      arguments: { subject_id: subjectId },
      opportunityIndex: 3,
      opportunityId: "opportunity.003",
    });

    const resumed = createLc4DevelopmentWorkerRuntime({
      artifact: fixture,
      arm: "hacc",
      sessionId: "session.after",
      clock: CLOCK,
      snapshot: first.snapshot(),
    });
    expect(resumed.callWorker("worker.status", { job_id: started.job.job_id })).toMatchObject({
      ok: true,
      job: {
        current_session_id: "session.after",
        lineage: [{ ordinal: 1 }, { ordinal: 2, from_session_id: "session.before", to_session_id: "session.after" }],
      },
    });
    expect(resumed.callWorker("worker.cancel", { job_id: started.job.job_id })).toMatchObject({
      ok: true,
      job: { status: "cancelled" },
    });
    expect(resumed.submitWorkerResult({
      jobId: started.job.job_id,
      attemptId: attempt.attempt_id,
      leaseId: attempt.lease.lease_id,
      leaseEpoch: attempt.lease.epoch,
      resultId: "result.after-cancel",
      outcome: "succeeded",
      payload: { should_not_commit: true },
    })).toMatchObject({ accepted: false, reason: "cancelled", job: { terminal_result: null } });
    const final = resumed.snapshot();
    expect(final.world.facts.checkpoint_01_count).toBe(1);
    expect(verifyLc4DevelopmentWorkerEvidence(fixture, final)).toMatchObject({ valid: true, errors: [] });
  });

  it("fails evidence verification for a rewritten runtime receipt or worker terminal head", () => {
    const fixture = artifact();
    const valid = runLc4DevelopmentWorkerExperiment({ artifact: fixture, arm: "hacc", clock: CLOCK }).snapshot;
    const receiptTamper = structuredClone(valid) as Lc4DevelopmentWorkerRuntimeSnapshot & {
      evidence: Array<{ operation_sha256: string }>;
    };
    receiptTamper.evidence[0]!.operation_sha256 = "f".repeat(64);
    expect(verifyLc4DevelopmentWorkerEvidence(fixture, receiptTamper)).toMatchObject({ valid: false });
    expect(verifyLc4DevelopmentWorkerEvidence(fixture, receiptTamper).errors)
      .toContain("evidence_receipt_1_invalid");

    const workerTamper = structuredClone(valid) as Lc4DevelopmentWorkerRuntimeSnapshot & {
      worker: { head_sha256: string };
    };
    workerTamper.worker.head_sha256 = "e".repeat(64);
    expect(verifyLc4DevelopmentWorkerEvidence(fixture, workerTamper).errors)
      .toEqual(expect.arrayContaining([
        expect.stringContaining("worker_snapshot_invalid"),
        "final_worker_head_mismatch",
        "snapshot_hash_mismatch",
      ]));
  });
});

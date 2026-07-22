import { describe, expect, it } from "vitest";
import { VoiceMissionEventSchema } from "../voice-mission-schema";
import {
  LC4_ASYNC_WORKER_CALLABLE_SURFACE,
  bindLc4WorkerEventsToMission,
  createLc4AsyncWorkerService,
  type Lc4AsyncWorkerService,
  type Lc4WorkerCallResult,
  type Lc4WorkerJob,
  type Lc4WorkerSnapshot,
} from "../lc4-async-worker-service";

const FIXED_CLOCK = Object.freeze({ nowIso: () => "2026-07-21T20:00:00.000Z" });

function service(
  arm: "native" | "hacc" = "hacc",
  options: Partial<ConstructorParameters<typeof Lc4AsyncWorkerService>[0]> = {},
) {
  return createLc4AsyncWorkerService({
    arm,
    sessionId: "session.alpha",
    clock: FIXED_CLOCK,
    ...options,
  });
}

function successful(result: Lc4WorkerCallResult): Extract<Lc4WorkerCallResult, { ok: true }> {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

function start(worker: Lc4AsyncWorkerService, suffix = "one"): Lc4WorkerJob {
  return successful(worker.call("worker.start", {
    request_id: `request.${suffix}`,
    worker_id: `research.${suffix}`,
    generation: 1,
    payload: { query: `research-${suffix}`, constraints: ["current", "cited"] },
  })).job;
}

function active(job: Lc4WorkerJob) {
  const attempt = job.attempts.at(-1);
  if (!attempt) throw new Error("test job has no active attempt");
  return attempt;
}

describe("LC4 provider-neutral async worker service", () => {
  it("exposes identical Native/HACC start-status-cancel tools and persists job/attempt/lease/lineage receipts", () => {
    const native = service("native");
    const hacc = service("hacc");

    expect(native.callableSurface()).toEqual(hacc.callableSurface());
    expect(native.callableSurface()).toBe(LC4_ASYNC_WORKER_CALLABLE_SURFACE);
    expect(native.callableSurface().map((capability) => capability.name)).toEqual([
      "worker.start",
      "worker.status",
      "worker.cancel",
    ]);

    const first = successful(hacc.call("worker.start", {
      request_id: "request.surface",
      worker_id: "research.surface",
      generation: 3,
      payload: { query: "find the current authoritative policy" },
    }));
    expect(first).toMatchObject({
      disposition: "accepted",
      job: {
        status: "running",
        generation: 3,
        root_session_id: "session.alpha",
        current_session_id: "session.alpha",
        attempts: [{ ordinal: 1, status: "active", lease: { epoch: 1, status: "active" } }],
        lineage: [{ ordinal: 1, from_session_id: null, to_session_id: "session.alpha" }],
      },
    });
    expect(first.receipt_ids).toHaveLength(4);
    expect(hacc.snapshot().receipts.map((receipt) => receipt.kind)).toEqual([
      "job.started",
      "attempt.started",
      "lease.issued",
      "lineage.bound",
    ]);
    expect(hacc.snapshot().receipts.every((receipt, index, all) =>
      receipt.previous_receipt_sha256 === (index === 0 ? "0".repeat(64) : all[index - 1].receipt_sha256)
    )).toBe(true);

    const replay = successful(hacc.call("worker.start", {
      request_id: "request.surface",
      worker_id: "research.surface",
      generation: 3,
      payload: { query: "find the current authoritative policy" },
    }));
    expect(replay).toMatchObject({ disposition: "replayed", job: { job_id: first.job.job_id } });
    expect(replay.receipt_ids).toEqual([]);
    expect(hacc.snapshot().revision).toBe(4);
    expect(successful(hacc.call("worker.status", { job_id: first.job.job_id }))).toMatchObject({
      disposition: "observed",
      job: { status: "running" },
    });
    expect(hacc.call("worker.start", {
      request_id: "request.surface",
      worker_id: "research.changed",
      generation: 3,
      payload: { query: "different" },
    })).toMatchObject({ ok: false, code: "request_id_conflict", retriable: false });
  });

  it("accepts one terminal result and durably rejects stale, duplicate, and post-cancel deliveries", () => {
    const worker = service();
    const completed = start(worker, "complete");
    const current = active(completed);

    const stale = worker.submitResult({
      jobId: completed.job_id,
      attemptId: "lc4attempt.stale.99",
      leaseId: current.lease.lease_id,
      leaseEpoch: current.lease.epoch,
      resultId: "result.stale",
      outcome: "succeeded",
      payload: { answer: 40 },
    });
    expect(stale).toMatchObject({ accepted: false, reason: "stale", job: { status: "running" } });

    const accepted = worker.submitResult({
      jobId: completed.job_id,
      attemptId: current.attempt_id,
      leaseId: current.lease.lease_id,
      leaseEpoch: current.lease.epoch,
      resultId: "result.authoritative",
      outcome: "succeeded",
      payload: { answer: 42, evidence: "receipt-42" },
    });
    expect(accepted).toMatchObject({
      accepted: true,
      reason: null,
      job: {
        status: "succeeded",
        terminal_result: {
          result_id: "result.authoritative",
          payload: { answer: 42, evidence: "receipt-42" },
        },
      },
    });
    const duplicate = worker.submitResult({
      jobId: completed.job_id,
      attemptId: current.attempt_id,
      leaseId: current.lease.lease_id,
      leaseEpoch: current.lease.epoch,
      resultId: "result.authoritative",
      outcome: "succeeded",
      payload: { answer: 42, evidence: "receipt-42" },
    });
    expect(duplicate).toMatchObject({ accepted: false, reason: "duplicate", job: { status: "succeeded" } });
    expect(worker.snapshot().receipts.filter((receipt) => receipt.kind === "result.accepted")).toHaveLength(1);
    expect(worker.call("worker.cancel", { job_id: completed.job_id })).toMatchObject({
      ok: false,
      code: "terminal_job",
    });

    const cancelled = start(worker, "cancelled");
    const cancelledAttempt = active(cancelled);
    expect(successful(worker.call("worker.cancel", { job_id: cancelled.job_id }))).toMatchObject({
      disposition: "accepted",
      job: { status: "cancelled" },
    });
    expect(successful(worker.call("worker.cancel", { job_id: cancelled.job_id }))).toMatchObject({
      disposition: "replayed",
    });
    const afterCancel = worker.submitResult({
      jobId: cancelled.job_id,
      attemptId: cancelledAttempt.attempt_id,
      leaseId: cancelledAttempt.lease.lease_id,
      leaseEpoch: cancelledAttempt.lease.epoch,
      resultId: "result.after-cancel",
      outcome: "succeeded",
      payload: { forbidden: true },
    });
    expect(afterCancel).toMatchObject({ accepted: false, reason: "cancelled", job: { status: "cancelled" } });
    expect(afterCancel.job.terminal_result).toBeNull();
    expect(successful(service("hacc", {
      sessionId: "session.cancel-rehydrate",
      snapshot: worker.snapshot(),
    }).call("worker.status", { job_id: cancelled.job_id })).job.status).toBe("cancelled");
  });

  it("rehydrates an active lease across sessions with hash-linked lineage and no second terminal acceptance", () => {
    const firstSession = service("hacc", { sessionId: "session.before-break" });
    const initial = start(firstSession, "cross-session");
    const initialAttempt = active(initial);
    const before = firstSession.snapshot();

    const resumed = service("hacc", {
      sessionId: "session.after-break",
      snapshot: before,
    });
    const restored = successful(resumed.call("worker.status", { job_id: initial.job_id })).job;
    expect(restored).toMatchObject({
      current_session_id: "session.after-break",
      lineage: [
        { ordinal: 1, from_session_id: null, to_session_id: "session.before-break" },
        {
          ordinal: 2,
          from_session_id: "session.before-break",
          to_session_id: "session.after-break",
          parent_lineage_receipt_id: initial.lineage[0].receipt_id,
        },
      ],
    });
    expect(resumed.snapshot().receipts.at(-1)).toMatchObject({
      kind: "lineage.rehydrated",
      job_id: initial.job_id,
      previous_receipt_sha256: before.head_sha256,
    });
    const result = resumed.submitResult({
      jobId: initial.job_id,
      attemptId: initialAttempt.attempt_id,
      leaseId: initialAttempt.lease.lease_id,
      leaseEpoch: initialAttempt.lease.epoch,
      resultId: "result.after-break",
      outcome: "succeeded",
      payload: { durable: true },
    });
    expect(result).toMatchObject({ accepted: true, job: { status: "succeeded" } });

    const completedSnapshot = resumed.snapshot();
    const third = service("hacc", { sessionId: "session.third", snapshot: completedSnapshot });
    expect(third.snapshot().revision).toBe(completedSnapshot.revision);
    expect(successful(third.call("worker.status", { job_id: initial.job_id })).job.current_session_id)
      .toBe("session.after-break");

    const corrupt = structuredClone(before) as Lc4WorkerSnapshot & { head_sha256: string };
    corrupt.head_sha256 = "f".repeat(64);
    expect(() => service("hacc", { sessionId: "session.corrupt", snapshot: corrupt }))
      .toThrow("worker snapshot head mismatch");
  });

  it("injects repeatable attempt, lease, and duplicate-delivery faults without changing terminal truth", () => {
    const faults = [
      { id: "fault.fail-once", worker_id: "research.faulted", generation: 1, attempt_ordinal: 1, kind: "fail_attempt_once" },
      { id: "fault.duplicate-once", worker_id: "research.faulted", generation: 1, attempt_ordinal: 2, kind: "duplicate_terminal_once" },
    ] as const;
    const run = () => {
      const worker = service("hacc", { faults });
      const job = start(worker, "faulted");
      const failed = worker.drive({
        jobId: job.job_id,
        resultId: "result.unused",
        outcome: "succeeded",
        payload: { value: "unused" },
      });
      expect(failed).toMatchObject({
        disposition: "fault_injected",
        fault_id: "fault.fail-once",
        job: { status: "running", attempts: [{ status: "failed" }, { status: "active" }] },
      });
      const completed = worker.drive({
        jobId: job.job_id,
        resultId: "result.only-terminal",
        outcome: "succeeded",
        payload: { value: "authoritative" },
      });
      expect(completed).toMatchObject({
        disposition: "fault_injected",
        fault_id: "fault.duplicate-once",
        accepted_result: { accepted: true },
        duplicate_result: { accepted: false, reason: "duplicate" },
        job: { status: "succeeded" },
      });
      return worker.snapshot();
    };

    const first = run();
    const second = run();
    expect(second).toEqual(first);
    expect(first.receipts.filter((receipt) => receipt.kind === "result.accepted")).toHaveLength(1);
    expect(first.receipts.filter((receipt) =>
      receipt.kind === "result.rejected" && receipt.body.reason === "duplicate"
    )).toHaveLength(1);
    expect(first.consumed_fault_ids).toEqual(["fault.duplicate-once", "fault.fail-once"]);
  });

  it("expires stale leases durably and requires a new attempt before completion", () => {
    let now = "2026-07-21T20:00:00.000Z";
    const worker = service("hacc", {
      clock: { nowIso: () => now },
      leaseTtlMs: 1_000,
    });
    const job = start(worker, "ttl");
    const staleAttempt = active(job);
    now = "2026-07-21T20:00:02.000Z";

    const observed = successful(worker.call("worker.status", { job_id: job.job_id }));
    expect(observed).toMatchObject({
      job: { attempts: [{ status: "failed", lease: { status: "expired" } }] },
    });
    expect(observed.receipt_ids).toHaveLength(1);
    expect(worker.submitResult({
      jobId: job.job_id,
      attemptId: staleAttempt.attempt_id,
      leaseId: staleAttempt.lease.lease_id,
      leaseEpoch: staleAttempt.lease.epoch,
      resultId: "result.expired",
      outcome: "succeeded",
      payload: { stale: true },
    })).toMatchObject({ accepted: false, reason: "stale" });
    const retried = worker.retry(job.job_id);
    expect(retried.attempts).toHaveLength(2);
    expect(retried.attempts[1]).toMatchObject({ ordinal: 2, status: "active", lease: { epoch: 2 } });
  });

  it("adapts durable worker transitions directly into the existing arm-blind mission event schema", () => {
    const worker = service();
    const job = start(worker, "mission");
    const attempt = active(job);
    worker.submitResult({
      jobId: job.job_id,
      attemptId: attempt.attempt_id,
      leaseId: attempt.lease.lease_id,
      leaseEpoch: attempt.lease.epoch,
      resultId: "result.mission",
      outcome: "succeeded",
      payload: { answer: "ready" },
      factRefs: [{ key: "customer.case", version: 1, value: "case-42" }],
    });
    const missionEvents = bindLc4WorkerEventsToMission(worker.workerEvents(), {
      sequenceStart: 1,
      opportunity_id: "opportunity.worker",
      opportunity_index: 20,
      segment_id: "segment.one",
    });

    expect(missionEvents.map((event) => event.type)).toEqual([
      "worker.spawned",
      "worker.result_emitted",
      "worker.result_accepted",
    ]);
    expect(missionEvents.every((event) => VoiceMissionEventSchema.safeParse(event).success)).toBe(true);
    expect(JSON.stringify(missionEvents)).not.toContain('"arm"');
  });
});

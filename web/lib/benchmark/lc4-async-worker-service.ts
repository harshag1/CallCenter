import { canonicalJson, sha256Hex } from "./artifacts";
import {
  VoiceMissionEventSchema,
  type VoiceMissionEvent,
  type VoiceMissionFactRef,
  type VoiceMissionJson,
} from "./voice-mission-schema";

export const LC4_WORKER_PROTOCOL = "LC4-WORKER-v1" as const;

const SAFE_ID = /^[a-z][a-z0-9_.-]{1,95}$/;
const ZERO_HEAD = "0".repeat(64);

export type Lc4WorkerArm = "native" | "hacc";
export type Lc4WorkerJobStatus = "running" | "succeeded" | "failed" | "cancelled";
export type Lc4WorkerAttemptStatus = "active" | "failed" | "succeeded" | "cancelled";
export type Lc4WorkerLeaseStatus = "active" | "expired" | "consumed" | "cancelled";
export type Lc4WorkerResultRejection = "stale" | "duplicate" | "cancelled";

export type Lc4WorkerCallableAction = "worker.start" | "worker.status" | "worker.cancel";

export const LC4_ASYNC_WORKER_CALLABLE_SURFACE = Object.freeze([
  Object.freeze({
    name: "worker.start" as const,
    description: "Start or replay one durable asynchronous worker job.",
    input_schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["request_id", "worker_id", "generation", "payload"]),
      properties: Object.freeze({
        request_id: Object.freeze({ type: "string" }),
        worker_id: Object.freeze({ type: "string" }),
        generation: Object.freeze({ type: "integer", minimum: 1 }),
        payload: Object.freeze({}),
      }),
    }),
  }),
  Object.freeze({
    name: "worker.status" as const,
    description: "Read the durable status and terminal evidence for a worker job.",
    input_schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["job_id"]),
      properties: Object.freeze({ job_id: Object.freeze({ type: "string" }) }),
    }),
  }),
  Object.freeze({
    name: "worker.cancel" as const,
    description: "Cancel one nonterminal worker job without accepting later results.",
    input_schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["job_id"]),
      properties: Object.freeze({ job_id: Object.freeze({ type: "string" }) }),
    }),
  }),
]);

type WorkerJson = VoiceMissionJson;
type ReceiptBody = Record<string, WorkerJson>;

export type Lc4WorkerReceiptKind =
  | "job.started"
  | "attempt.started"
  | "attempt.failed"
  | "lease.issued"
  | "lease.expired"
  | "lineage.bound"
  | "lineage.rehydrated"
  | "job.cancelled"
  | "result.accepted"
  | "result.rejected"
  | "fault.injected";

export type Lc4WorkerReceipt = Readonly<{
  protocol: typeof LC4_WORKER_PROTOCOL;
  sequence: number;
  receipt_id: string;
  kind: Lc4WorkerReceiptKind;
  job_id: string;
  occurred_at: string;
  previous_receipt_sha256: string;
  body: Readonly<ReceiptBody>;
  body_sha256: string;
  receipt_sha256: string;
}>;

export type Lc4WorkerAttempt = Readonly<{
  attempt_id: string;
  ordinal: number;
  status: Lc4WorkerAttemptStatus;
  started_receipt_id: string;
  terminal_receipt_id: string | null;
  lease: Readonly<{
    lease_id: string;
    epoch: number;
    status: Lc4WorkerLeaseStatus;
    issued_at: string;
    expires_at: string;
    issued_receipt_id: string;
    terminal_receipt_id: string | null;
  }>;
}>;

export type Lc4WorkerTerminalResult = Readonly<{
  result_id: string;
  outcome: "succeeded" | "failed";
  payload: WorkerJson;
  payload_sha256: string;
  accepted_attempt_id: string;
  accepted_lease_id: string;
  accepted_receipt_id: string;
}>;

export type Lc4WorkerLineage = Readonly<{
  ordinal: number;
  from_session_id: string | null;
  to_session_id: string;
  parent_lineage_receipt_id: string | null;
  receipt_id: string;
}>;

export type Lc4WorkerJob = Readonly<{
  job_id: string;
  request_id: string;
  request_sha256: string;
  worker_id: string;
  generation: number;
  payload: WorkerJson;
  status: Lc4WorkerJobStatus;
  root_session_id: string;
  current_session_id: string;
  job_receipt_id: string;
  attempts: readonly Lc4WorkerAttempt[];
  lineage: readonly Lc4WorkerLineage[];
  terminal_result: Lc4WorkerTerminalResult | null;
  terminal_receipt_id: string | null;
}>;

export type Lc4WorkerEvent = Readonly<{
  ordinal: number;
  type: "worker.spawned" | "worker.cancelled" | "worker.result_emitted" | "worker.result_accepted" | "worker.result_rejected";
  worker_id: string;
  generation: number;
  result_id?: string;
  outcome?: "succeeded" | "failed";
  reason?: "failed" | Lc4WorkerResultRejection;
  fact_refs?: readonly VoiceMissionFactRef[];
}>;

export type Lc4WorkerSnapshot = Readonly<{
  protocol: typeof LC4_WORKER_PROTOCOL;
  revision: number;
  head_sha256: string;
  receipts: readonly Lc4WorkerReceipt[];
  jobs: readonly Lc4WorkerJob[];
  consumed_fault_ids: readonly string[];
  worker_events: readonly Lc4WorkerEvent[];
}>;

export type Lc4WorkerFault = Readonly<{
  id: string;
  worker_id: string;
  generation: number;
  attempt_ordinal: number;
  kind: "fail_attempt_once" | "expire_lease_once" | "duplicate_terminal_once";
}>;

export type Lc4WorkerCallResult =
  | Readonly<{
    ok: true;
    action: Lc4WorkerCallableAction;
    disposition: "accepted" | "replayed" | "observed";
    job: Lc4WorkerJob;
    receipt_ids: readonly string[];
  }>
  | Readonly<{
    ok: false;
    action: Lc4WorkerCallableAction;
    code: "invalid_arguments" | "unknown_job" | "worker_capacity_exceeded" | "terminal_job" | "request_id_conflict";
    message: string;
    retriable: boolean;
  }>;

export type Lc4WorkerResultDisposition = Readonly<{
  accepted: boolean;
  reason: Lc4WorkerResultRejection | null;
  job: Lc4WorkerJob;
  receipt_id: string;
}>;

export type Lc4WorkerDriveResult = Readonly<{
  disposition: "completed" | "fault_injected";
  fault_id: string | null;
  job: Lc4WorkerJob;
  accepted_result: Lc4WorkerResultDisposition | null;
  duplicate_result: Lc4WorkerResultDisposition | null;
}>;

type MutableLease = {
  lease_id: string;
  epoch: number;
  status: Lc4WorkerLeaseStatus;
  issued_at: string;
  expires_at: string;
  issued_receipt_id: string;
  terminal_receipt_id: string | null;
};

type MutableAttempt = {
  attempt_id: string;
  ordinal: number;
  status: Lc4WorkerAttemptStatus;
  started_receipt_id: string;
  terminal_receipt_id: string | null;
  lease: MutableLease;
};

type MutableJob = {
  job_id: string;
  request_id: string;
  request_sha256: string;
  worker_id: string;
  generation: number;
  payload: WorkerJson;
  status: Lc4WorkerJobStatus;
  root_session_id: string;
  current_session_id: string;
  job_receipt_id: string;
  attempts: MutableAttempt[];
  lineage: Lc4WorkerLineage[];
  terminal_result: Lc4WorkerTerminalResult | null;
  terminal_receipt_id: string | null;
};

type MutableState = {
  revision: number;
  headSha256: string;
  receipts: Lc4WorkerReceipt[];
  jobs: Map<string, MutableJob>;
  requestIndex: Map<string, string>;
  consumedFaultIds: Set<string>;
  workerEvents: Lc4WorkerEvent[];
};

export type Lc4AsyncWorkerClock = Readonly<{ nowIso(): string }>;

export type Lc4AsyncWorkerServiceOptions = Readonly<{
  arm: Lc4WorkerArm;
  sessionId: string;
  clock: Lc4AsyncWorkerClock;
  leaseTtlMs?: number;
  haccMaxActiveJobs?: number;
  faults?: readonly Lc4WorkerFault[];
  snapshot?: Lc4WorkerSnapshot;
}>;

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe identifier`);
}

function assertCanonicalIso(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be canonical ISO-8601`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function asWorkerJson(value: unknown): WorkerJson {
  const parsed = JSON.parse(JSON.stringify(value)) as unknown;
  const validate = (candidate: unknown): WorkerJson => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (Array.isArray(candidate)) return candidate.map(validate);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate).map(([key, child]) => [key, validate(child)]));
    }
    throw new Error("worker payload must be finite JSON");
  };
  return validate(parsed);
}

function publicJob(job: MutableJob): Lc4WorkerJob {
  return deepFreeze(cloneJson(job) as Lc4WorkerJob);
}

function receiptHash(receipt: Omit<Lc4WorkerReceipt, "receipt_sha256">): string {
  return sha256Hex(canonicalJson(receipt as unknown as WorkerJson));
}

function verifySnapshot(snapshot: Lc4WorkerSnapshot): void {
  if (snapshot.protocol !== LC4_WORKER_PROTOCOL) throw new Error("worker snapshot protocol mismatch");
  if (snapshot.revision !== snapshot.receipts.length) throw new Error("worker snapshot revision mismatch");
  let previous = ZERO_HEAD;
  snapshot.receipts.forEach((receipt, index) => {
    if (
      receipt.protocol !== LC4_WORKER_PROTOCOL
      || receipt.sequence !== index + 1
      || receipt.receipt_id !== `lc4receipt.${String(index + 1).padStart(6, "0")}`
      || receipt.previous_receipt_sha256 !== previous
      || receipt.body_sha256 !== sha256Hex(canonicalJson(receipt.body as WorkerJson))
    ) throw new Error(`worker receipt ${index + 1} is corrupt`);
    const { receipt_sha256: actual, ...unsigned } = receipt;
    if (actual !== receiptHash(unsigned)) throw new Error(`worker receipt ${index + 1} hash is corrupt`);
    previous = actual;
  });
  if (snapshot.head_sha256 !== previous) throw new Error("worker snapshot head mismatch");
  const receiptsById = new Map(snapshot.receipts.map((receipt) => [receipt.receipt_id, receipt]));
  const jobIds = new Set<string>();
  const requestIds = new Set<string>();
  for (const job of snapshot.jobs) {
    assertId(job.job_id, "snapshot job_id");
    if (jobIds.has(job.job_id) || requestIds.has(job.request_id)) throw new Error("worker snapshot contains duplicate jobs");
    jobIds.add(job.job_id);
    requestIds.add(job.request_id);
    const jobReceipt = receiptsById.get(job.job_receipt_id);
    if (
      jobReceipt?.kind !== "job.started"
      || jobReceipt.job_id !== job.job_id
      || job.lineage.some((lineage) => {
        const receipt = receiptsById.get(lineage.receipt_id);
        return !receipt
          || receipt.job_id !== job.job_id
          || (receipt.kind !== "lineage.bound" && receipt.kind !== "lineage.rehydrated");
      })
    ) {
      throw new Error("worker job lineage references a missing receipt");
    }
    if (job.attempts.length === 0 || job.attempts.some((attempt) => {
      const started = receiptsById.get(attempt.started_receipt_id);
      const lease = receiptsById.get(attempt.lease.issued_receipt_id);
      return started?.kind !== "attempt.started"
        || started.job_id !== job.job_id
        || lease?.kind !== "lease.issued"
        || lease.job_id !== job.job_id;
    })) throw new Error("worker attempt references a missing receipt");
    const resultTerminal = job.status === "succeeded" || job.status === "failed";
    if (
      (job.status === "running" && (job.terminal_result !== null || job.terminal_receipt_id !== null))
      || (job.status === "cancelled" && (job.terminal_result !== null || job.terminal_receipt_id === null))
      || (resultTerminal && (job.terminal_result === null || job.terminal_receipt_id === null))
    ) throw new Error("worker terminal evidence is incomplete");
    const terminalReceipt = job.terminal_receipt_id
      ? receiptsById.get(job.terminal_receipt_id)
      : undefined;
    if (
      job.terminal_receipt_id
      && (!terminalReceipt || terminalReceipt.job_id !== job.job_id)
    ) {
      throw new Error("worker terminal receipt is missing");
    }
    if (
      job.status === "cancelled"
      && terminalReceipt?.kind !== "job.cancelled"
    ) throw new Error("cancelled worker terminal receipt has the wrong kind");
    if (job.terminal_result) {
      const accepted = receiptsById.get(job.terminal_result.accepted_receipt_id);
      if (
        accepted?.kind !== "result.accepted"
        || accepted.job_id !== job.job_id
        || job.terminal_receipt_id !== job.terminal_result.accepted_receipt_id
        || accepted.body.result_id !== job.terminal_result.result_id
        || accepted.body.outcome !== job.terminal_result.outcome
        || accepted.body.payload_sha256 !== job.terminal_result.payload_sha256
        || accepted.body.attempt_id !== job.terminal_result.accepted_attempt_id
        || accepted.body.lease_id !== job.terminal_result.accepted_lease_id
      ) {
        throw new Error("worker terminal result references a missing receipt");
      }
    }
  }
  if (snapshot.worker_events.some((event, index) => event.ordinal !== index + 1)) {
    throw new Error("worker event ordinals are not contiguous");
  }
}

/** Validate durable worker evidence without creating a session or mutating lineage. */
export function assertLc4WorkerSnapshot(snapshot: Lc4WorkerSnapshot): void {
  verifySnapshot(snapshot);
}

function mutableState(snapshot?: Lc4WorkerSnapshot): MutableState {
  if (!snapshot) {
    return {
      revision: 0,
      headSha256: ZERO_HEAD,
      receipts: [],
      jobs: new Map(),
      requestIndex: new Map(),
      consumedFaultIds: new Set(),
      workerEvents: [],
    };
  }
  verifySnapshot(snapshot);
  const jobs = new Map(snapshot.jobs.map((job) => [job.job_id, cloneJson(job) as MutableJob]));
  return {
    revision: snapshot.revision,
    headSha256: snapshot.head_sha256,
    receipts: cloneJson(snapshot.receipts) as Lc4WorkerReceipt[],
    jobs,
    requestIndex: new Map(snapshot.jobs.map((job) => [job.request_id, job.job_id])),
    consumedFaultIds: new Set(snapshot.consumed_fault_ids),
    workerEvents: cloneJson(snapshot.worker_events) as Lc4WorkerEvent[],
  };
}

export class Lc4AsyncWorkerService {
  readonly #arm: Lc4WorkerArm;
  readonly #sessionId: string;
  readonly #clock: Lc4AsyncWorkerClock;
  readonly #leaseTtlMs: number;
  readonly #haccMaxActiveJobs: number;
  readonly #faults: readonly Lc4WorkerFault[];
  readonly #state: MutableState;

  constructor(options: Lc4AsyncWorkerServiceOptions) {
    assertId(options.sessionId, "sessionId");
    this.#arm = options.arm;
    this.#sessionId = options.sessionId;
    this.#clock = options.clock;
    this.#leaseTtlMs = options.leaseTtlMs ?? 60_000;
    this.#haccMaxActiveJobs = options.haccMaxActiveJobs ?? 64;
    if (!Number.isSafeInteger(this.#leaseTtlMs) || this.#leaseTtlMs < 1) throw new Error("leaseTtlMs must be positive");
    if (!Number.isSafeInteger(this.#haccMaxActiveJobs) || this.#haccMaxActiveJobs < 1) {
      throw new Error("haccMaxActiveJobs must be positive");
    }
    this.#faults = Object.freeze([...(options.faults ?? [])].map((fault) => {
      assertId(fault.id, "fault.id");
      assertId(fault.worker_id, "fault.worker_id");
      if (!Number.isSafeInteger(fault.generation) || fault.generation < 1) throw new Error("fault generation must be positive");
      if (!Number.isSafeInteger(fault.attempt_ordinal) || fault.attempt_ordinal < 1) throw new Error("fault attempt ordinal must be positive");
      return Object.freeze({ ...fault });
    }));
    if (new Set(this.#faults.map((fault) => fault.id)).size !== this.#faults.length) {
      throw new Error("fault IDs must be unique");
    }
    this.#state = mutableState(options.snapshot);
    if (options.snapshot) this.#rehydrateActiveJobs();
  }

  callableSurface(): typeof LC4_ASYNC_WORKER_CALLABLE_SURFACE {
    return LC4_ASYNC_WORKER_CALLABLE_SURFACE;
  }

  snapshot(): Lc4WorkerSnapshot {
    return deepFreeze({
      protocol: LC4_WORKER_PROTOCOL,
      revision: this.#state.revision,
      head_sha256: this.#state.headSha256,
      receipts: cloneJson(this.#state.receipts),
      jobs: [...this.#state.jobs.values()].map(publicJob).sort((left, right) => left.job_id.localeCompare(right.job_id)),
      consumed_fault_ids: [...this.#state.consumedFaultIds].sort(),
      worker_events: cloneJson(this.#state.workerEvents),
    });
  }

  workerEvents(afterOrdinal = 0): readonly Lc4WorkerEvent[] {
    if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) throw new Error("afterOrdinal must be non-negative");
    return deepFreeze(cloneJson(this.#state.workerEvents.filter((event) => event.ordinal > afterOrdinal)));
  }

  call(action: Lc4WorkerCallableAction, args: Readonly<Record<string, unknown>>): Lc4WorkerCallResult {
    if (action === "worker.start") return this.#start(args);
    if (action === "worker.status") return this.#status(args);
    return this.#cancel(args);
  }

  submitResult(input: Readonly<{
    jobId: string;
    attemptId: string;
    leaseId: string;
    leaseEpoch: number;
    resultId: string;
    outcome: "succeeded" | "failed";
    payload: unknown;
    factRefs?: readonly VoiceMissionFactRef[];
  }>): Lc4WorkerResultDisposition {
    assertId(input.jobId, "result.jobId");
    assertId(input.attemptId, "result.attemptId");
    assertId(input.leaseId, "result.leaseId");
    assertId(input.resultId, "result.resultId");
    const job = this.#state.jobs.get(input.jobId);
    if (!job) throw new Error("cannot submit a result for an unknown job");
    const payload = asWorkerJson(input.payload);
    const resultSha256 = sha256Hex(canonicalJson({
      result_id: input.resultId,
      outcome: input.outcome,
      payload,
    } as WorkerJson));
    const reject = (reason: Lc4WorkerResultRejection): Lc4WorkerResultDisposition => {
      const receipt = this.#appendReceipt("result.rejected", job.job_id, {
        result_id: input.resultId,
        reason,
        attempt_id: input.attemptId,
        lease_id: input.leaseId,
        lease_epoch: input.leaseEpoch,
        result_sha256: resultSha256,
      });
      this.#emit({
        type: "worker.result_emitted",
        worker_id: job.worker_id,
        generation: job.generation,
        result_id: input.resultId,
        outcome: input.outcome,
        fact_refs: cloneJson(input.factRefs ?? []),
      });
      this.#emit({
        type: "worker.result_rejected",
        worker_id: job.worker_id,
        generation: job.generation,
        result_id: input.resultId,
        reason,
      });
      return deepFreeze({ accepted: false, reason, job: publicJob(job), receipt_id: receipt.receipt_id });
    };
    if (job.status === "cancelled") return reject("cancelled");
    if (job.terminal_result) {
      const duplicate = job.terminal_result.result_id === input.resultId
        && job.terminal_result.payload_sha256 === sha256Hex(canonicalJson(payload));
      return reject(duplicate ? "duplicate" : "stale");
    }
    this.#expireActiveLeaseIfElapsed(job);
    const active = job.attempts.at(-1);
    const now = this.#now();
    if (
      !active
      || active.status !== "active"
      || active.attempt_id !== input.attemptId
      || active.lease.status !== "active"
      || active.lease.lease_id !== input.leaseId
      || active.lease.epoch !== input.leaseEpoch
      || Date.parse(now) >= Date.parse(active.lease.expires_at)
    ) return reject("stale");

    const receipt = this.#appendReceipt("result.accepted", job.job_id, {
      result_id: input.resultId,
      outcome: input.outcome,
      payload_sha256: sha256Hex(canonicalJson(payload)),
      attempt_id: input.attemptId,
      lease_id: input.leaseId,
      lease_epoch: input.leaseEpoch,
    });
    active.status = input.outcome;
    active.terminal_receipt_id = receipt.receipt_id;
    active.lease.status = "consumed";
    active.lease.terminal_receipt_id = receipt.receipt_id;
    job.status = input.outcome;
    job.terminal_receipt_id = receipt.receipt_id;
    job.terminal_result = deepFreeze({
      result_id: input.resultId,
      outcome: input.outcome,
      payload: cloneJson(payload),
      payload_sha256: sha256Hex(canonicalJson(payload)),
      accepted_attempt_id: active.attempt_id,
      accepted_lease_id: active.lease.lease_id,
      accepted_receipt_id: receipt.receipt_id,
    });
    this.#emit({
      type: "worker.result_emitted",
      worker_id: job.worker_id,
      generation: job.generation,
      result_id: input.resultId,
      outcome: input.outcome,
      fact_refs: cloneJson(input.factRefs ?? []),
    });
    this.#emit(input.outcome === "succeeded" ? {
      type: "worker.result_accepted",
      worker_id: job.worker_id,
      generation: job.generation,
      result_id: input.resultId,
    } : {
      type: "worker.result_rejected",
      worker_id: job.worker_id,
      generation: job.generation,
      result_id: input.resultId,
      reason: "failed",
    });
    return deepFreeze({ accepted: true, reason: null, job: publicJob(job), receipt_id: receipt.receipt_id });
  }

  retry(jobId: string): Lc4WorkerJob {
    assertId(jobId, "retry.jobId");
    const job = this.#state.jobs.get(jobId);
    if (!job) throw new Error("cannot retry an unknown job");
    if (job.status !== "running") throw new Error("cannot retry a terminal job");
    this.#expireActiveLeaseIfElapsed(job);
    const active = job.attempts.at(-1);
    if (active?.status === "active" && active.lease.status === "active") {
      throw new Error("cannot retry while an active lease exists");
    }
    this.#issueAttempt(job);
    return publicJob(job);
  }

  drive(input: Readonly<{
    jobId: string;
    resultId: string;
    outcome: "succeeded" | "failed";
    payload: unknown;
    factRefs?: readonly VoiceMissionFactRef[];
  }>): Lc4WorkerDriveResult {
    const job = this.#state.jobs.get(input.jobId);
    if (!job) throw new Error("cannot drive an unknown job");
    if (job.status !== "running") throw new Error("cannot drive a terminal job");
    const attempt = job.attempts.at(-1);
    if (!attempt || attempt.status !== "active") throw new Error("job has no active attempt");
    const fault = this.#faults.find((candidate) =>
      !this.#state.consumedFaultIds.has(candidate.id)
      && candidate.worker_id === job.worker_id
      && candidate.generation === job.generation
      && candidate.attempt_ordinal === attempt.ordinal
    );
    if (fault) {
      this.#state.consumedFaultIds.add(fault.id);
      this.#appendReceipt("fault.injected", job.job_id, {
        fault_id: fault.id,
        kind: fault.kind,
        attempt_id: attempt.attempt_id,
      });
      if (fault.kind === "fail_attempt_once" || fault.kind === "expire_lease_once") {
        const terminalKind = fault.kind === "fail_attempt_once" ? "attempt.failed" : "lease.expired";
        const terminal = this.#appendReceipt(terminalKind, job.job_id, {
          fault_id: fault.id,
          attempt_id: attempt.attempt_id,
          lease_id: attempt.lease.lease_id,
        });
        attempt.status = "failed";
        attempt.terminal_receipt_id = terminal.receipt_id;
        attempt.lease.status = fault.kind === "expire_lease_once" ? "expired" : "consumed";
        attempt.lease.terminal_receipt_id = terminal.receipt_id;
        this.#issueAttempt(job);
        return deepFreeze({
          disposition: "fault_injected",
          fault_id: fault.id,
          job: publicJob(job),
          accepted_result: null,
          duplicate_result: null,
        });
      }
      const first = this.submitResult({
        jobId: job.job_id,
        attemptId: attempt.attempt_id,
        leaseId: attempt.lease.lease_id,
        leaseEpoch: attempt.lease.epoch,
        resultId: input.resultId,
        outcome: input.outcome,
        payload: input.payload,
        factRefs: input.factRefs,
      });
      const duplicate = this.submitResult({
        jobId: job.job_id,
        attemptId: attempt.attempt_id,
        leaseId: attempt.lease.lease_id,
        leaseEpoch: attempt.lease.epoch,
        resultId: input.resultId,
        outcome: input.outcome,
        payload: input.payload,
        factRefs: input.factRefs,
      });
      return deepFreeze({
        disposition: "fault_injected",
        fault_id: fault.id,
        job: publicJob(job),
        accepted_result: first,
        duplicate_result: duplicate,
      });
    }
    const accepted = this.submitResult({
      jobId: job.job_id,
      attemptId: attempt.attempt_id,
      leaseId: attempt.lease.lease_id,
      leaseEpoch: attempt.lease.epoch,
      resultId: input.resultId,
      outcome: input.outcome,
      payload: input.payload,
      factRefs: input.factRefs,
    });
    return deepFreeze({
      disposition: "completed",
      fault_id: null,
      job: publicJob(job),
      accepted_result: accepted,
      duplicate_result: null,
    });
  }

  #start(args: Readonly<Record<string, unknown>>): Lc4WorkerCallResult {
    if (
      Object.keys(args).some((key) => !["request_id", "worker_id", "generation", "payload"].includes(key))
      || typeof args.request_id !== "string"
      || typeof args.worker_id !== "string"
      || !Number.isSafeInteger(args.generation)
      || (args.generation as number) < 1
      || !("payload" in args)
      || !SAFE_ID.test(args.request_id)
      || !SAFE_ID.test(args.worker_id)
    ) return this.#callFailure("worker.start", "invalid_arguments", "worker.start arguments are invalid", false);
    let payload: WorkerJson;
    try {
      payload = asWorkerJson(args.payload);
    } catch {
      return this.#callFailure("worker.start", "invalid_arguments", "worker.start payload must be finite JSON", false);
    }
    const requestSha256 = sha256Hex(canonicalJson({
      request_id: args.request_id,
      worker_id: args.worker_id,
      generation: args.generation,
      payload,
    } as WorkerJson));
    const priorId = this.#state.requestIndex.get(args.request_id);
    if (priorId) {
      const prior = this.#state.jobs.get(priorId);
      if (!prior) throw new Error("worker request index is corrupt");
      if (prior.request_sha256 !== requestSha256) {
        return this.#callFailure("worker.start", "request_id_conflict", "request_id was reused with different content", false);
      }
      return deepFreeze({
        ok: true,
        action: "worker.start",
        disposition: "replayed",
        job: publicJob(prior),
        receipt_ids: [],
      });
    }
    if (
      this.#arm === "hacc"
      && [...this.#state.jobs.values()].filter((job) => job.status === "running").length >= this.#haccMaxActiveJobs
    ) return this.#callFailure("worker.start", "worker_capacity_exceeded", "governed active-worker capacity is exhausted", true);
    const jobId = `lc4job.${sha256Hex(args.request_id).slice(0, 24)}`;
    if (this.#state.jobs.has(jobId)) throw new Error("derived worker job collision");
    const jobReceipt = this.#appendReceipt("job.started", jobId, {
      request_id: args.request_id,
      request_sha256: requestSha256,
      worker_id: args.worker_id,
      generation: args.generation as number,
      root_session_id: this.#sessionId,
    });
    const job: MutableJob = {
      job_id: jobId,
      request_id: args.request_id,
      request_sha256: requestSha256,
      worker_id: args.worker_id,
      generation: args.generation as number,
      payload,
      status: "running",
      root_session_id: this.#sessionId,
      current_session_id: this.#sessionId,
      job_receipt_id: jobReceipt.receipt_id,
      attempts: [],
      lineage: [],
      terminal_result: null,
      terminal_receipt_id: null,
    };
    this.#state.jobs.set(jobId, job);
    this.#state.requestIndex.set(job.request_id, jobId);
    const attempt = this.#issueAttempt(job);
    const lineageReceipt = this.#appendReceipt("lineage.bound", jobId, {
      root_job_receipt_id: job.job_receipt_id,
      from_session_id: null,
      to_session_id: this.#sessionId,
      parent_lineage_receipt_id: null,
      lineage_ordinal: 1,
    });
    job.lineage.push(deepFreeze({
      ordinal: 1,
      from_session_id: null,
      to_session_id: this.#sessionId,
      parent_lineage_receipt_id: null,
      receipt_id: lineageReceipt.receipt_id,
    }));
    this.#emit({ type: "worker.spawned", worker_id: job.worker_id, generation: job.generation });
    return deepFreeze({
      ok: true,
      action: "worker.start",
      disposition: "accepted",
      job: publicJob(job),
      receipt_ids: [
        jobReceipt.receipt_id,
        attempt.started_receipt_id,
        attempt.lease.issued_receipt_id,
        lineageReceipt.receipt_id,
      ],
    });
  }

  #status(args: Readonly<Record<string, unknown>>): Lc4WorkerCallResult {
    if (Object.keys(args).length !== 1 || typeof args.job_id !== "string" || !SAFE_ID.test(args.job_id)) {
      return this.#callFailure("worker.status", "invalid_arguments", "worker.status requires one job_id", false);
    }
    const job = this.#state.jobs.get(args.job_id);
    if (!job) return this.#callFailure("worker.status", "unknown_job", "worker job does not exist", false);
    const priorRevision = this.#state.revision;
    if (job.status === "running") this.#expireActiveLeaseIfElapsed(job);
    return deepFreeze({
      ok: true,
      action: "worker.status",
      disposition: "observed",
      job: publicJob(job),
      receipt_ids: this.#state.receipts.slice(priorRevision).map((receipt) => receipt.receipt_id),
    });
  }

  #cancel(args: Readonly<Record<string, unknown>>): Lc4WorkerCallResult {
    if (Object.keys(args).length !== 1 || typeof args.job_id !== "string" || !SAFE_ID.test(args.job_id)) {
      return this.#callFailure("worker.cancel", "invalid_arguments", "worker.cancel requires one job_id", false);
    }
    const job = this.#state.jobs.get(args.job_id);
    if (!job) return this.#callFailure("worker.cancel", "unknown_job", "worker job does not exist", false);
    if (job.status === "cancelled") {
      return deepFreeze({
        ok: true,
        action: "worker.cancel",
        disposition: "replayed",
        job: publicJob(job),
        receipt_ids: [],
      });
    }
    if (job.status !== "running") {
      return this.#callFailure("worker.cancel", "terminal_job", "completed worker jobs cannot be cancelled", false);
    }
    const active = job.attempts.at(-1);
    const receipt = this.#appendReceipt("job.cancelled", job.job_id, {
      attempt_id: active?.attempt_id ?? null,
      lease_id: active?.lease.lease_id ?? null,
      session_id: this.#sessionId,
    });
    job.status = "cancelled";
    job.terminal_receipt_id = receipt.receipt_id;
    if (active?.status === "active") {
      active.status = "cancelled";
      active.terminal_receipt_id = receipt.receipt_id;
      active.lease.status = "cancelled";
      active.lease.terminal_receipt_id = receipt.receipt_id;
    }
    this.#emit({ type: "worker.cancelled", worker_id: job.worker_id, generation: job.generation });
    return deepFreeze({
      ok: true,
      action: "worker.cancel",
      disposition: "accepted",
      job: publicJob(job),
      receipt_ids: [receipt.receipt_id],
    });
  }

  #callFailure(
    action: Lc4WorkerCallableAction,
    code: Extract<Lc4WorkerCallResult, { ok: false }>["code"],
    message: string,
    retriable: boolean,
  ): Extract<Lc4WorkerCallResult, { ok: false }> {
    return deepFreeze({ ok: false, action, code, message, retriable });
  }

  #issueAttempt(job: MutableJob): MutableAttempt {
    const ordinal = job.attempts.length + 1;
    const attemptId = `lc4attempt.${sha256Hex(`${job.job_id}:${ordinal}`).slice(0, 20)}.${ordinal}`;
    const started = this.#appendReceipt("attempt.started", job.job_id, {
      attempt_id: attemptId,
      attempt_ordinal: ordinal,
      prior_attempt_id: job.attempts.at(-1)?.attempt_id ?? null,
    });
    const issuedAt = this.#now();
    const leaseId = `lc4lease.${sha256Hex(`${attemptId}:${ordinal}`).slice(0, 20)}.${ordinal}`;
    const leaseReceipt = this.#appendReceipt("lease.issued", job.job_id, {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: ordinal,
      issued_at: issuedAt,
      expires_at: new Date(Date.parse(issuedAt) + this.#leaseTtlMs).toISOString(),
    });
    const attempt: MutableAttempt = {
      attempt_id: attemptId,
      ordinal,
      status: "active",
      started_receipt_id: started.receipt_id,
      terminal_receipt_id: null,
      lease: {
        lease_id: leaseId,
        epoch: ordinal,
        status: "active",
        issued_at: issuedAt,
        expires_at: new Date(Date.parse(issuedAt) + this.#leaseTtlMs).toISOString(),
        issued_receipt_id: leaseReceipt.receipt_id,
        terminal_receipt_id: null,
      },
    };
    job.attempts.push(attempt);
    return attempt;
  }

  #expireActiveLeaseIfElapsed(job: MutableJob): boolean {
    const active = job.attempts.at(-1);
    if (
      !active
      || active.status !== "active"
      || active.lease.status !== "active"
      || Date.parse(this.#now()) < Date.parse(active.lease.expires_at)
    ) return false;
    const receipt = this.#appendReceipt("lease.expired", job.job_id, {
      attempt_id: active.attempt_id,
      lease_id: active.lease.lease_id,
      lease_epoch: active.lease.epoch,
      reason: "ttl_elapsed",
    });
    active.status = "failed";
    active.terminal_receipt_id = receipt.receipt_id;
    active.lease.status = "expired";
    active.lease.terminal_receipt_id = receipt.receipt_id;
    return true;
  }

  #rehydrateActiveJobs(): void {
    for (const job of this.#state.jobs.values()) {
      if (job.status !== "running" || job.current_session_id === this.#sessionId) continue;
      const prior = job.lineage.at(-1);
      if (!prior) throw new Error("active worker job has no durable lineage");
      const receipt = this.#appendReceipt("lineage.rehydrated", job.job_id, {
        root_job_receipt_id: job.job_receipt_id,
        from_session_id: job.current_session_id,
        to_session_id: this.#sessionId,
        parent_lineage_receipt_id: prior.receipt_id,
        lineage_ordinal: prior.ordinal + 1,
      });
      job.lineage.push(deepFreeze({
        ordinal: prior.ordinal + 1,
        from_session_id: job.current_session_id,
        to_session_id: this.#sessionId,
        parent_lineage_receipt_id: prior.receipt_id,
        receipt_id: receipt.receipt_id,
      }));
      job.current_session_id = this.#sessionId;
    }
  }

  #appendReceipt(kind: Lc4WorkerReceiptKind, jobId: string, bodyInput: ReceiptBody): Lc4WorkerReceipt {
    assertId(jobId, "receipt.jobId");
    const occurredAt = this.#now();
    const body = deepFreeze(cloneJson(bodyInput));
    const unsigned = {
      protocol: LC4_WORKER_PROTOCOL,
      sequence: this.#state.revision + 1,
      receipt_id: `lc4receipt.${String(this.#state.revision + 1).padStart(6, "0")}`,
      kind,
      job_id: jobId,
      occurred_at: occurredAt,
      previous_receipt_sha256: this.#state.headSha256,
      body,
      body_sha256: sha256Hex(canonicalJson(body as WorkerJson)),
    } as const;
    const receipt = deepFreeze({ ...unsigned, receipt_sha256: receiptHash(unsigned) });
    this.#state.receipts.push(receipt);
    this.#state.revision = receipt.sequence;
    this.#state.headSha256 = receipt.receipt_sha256;
    return receipt;
  }

  #emit(event: Omit<Lc4WorkerEvent, "ordinal">): void {
    this.#state.workerEvents.push(deepFreeze({
      ...event,
      ordinal: this.#state.workerEvents.length + 1,
    } as Lc4WorkerEvent));
  }

  #now(): string {
    const now = this.#clock.nowIso();
    assertCanonicalIso(now, "worker clock");
    return now;
  }
}

export function createLc4AsyncWorkerService(options: Lc4AsyncWorkerServiceOptions): Lc4AsyncWorkerService {
  return new Lc4AsyncWorkerService(options);
}

export function bindLc4WorkerEventsToMission(
  events: readonly Lc4WorkerEvent[],
  input: Readonly<{
    sequenceStart: number;
    opportunity_id: string;
    opportunity_index: number;
    segment_id: string;
  }>,
): readonly VoiceMissionEvent[] {
  assertId(input.opportunity_id, "mission opportunity_id");
  assertId(input.segment_id, "mission segment_id");
  if (!Number.isSafeInteger(input.sequenceStart) || input.sequenceStart < 1) throw new Error("sequenceStart must be positive");
  if (!Number.isSafeInteger(input.opportunity_index) || input.opportunity_index < 1) {
    throw new Error("opportunity_index must be positive");
  }
  return deepFreeze(events.map((event, index) => {
    const base = {
      protocol: "HACC-VMR-v1" as const,
      sequence: input.sequenceStart + index,
      opportunity_id: input.opportunity_id,
      opportunity_index: input.opportunity_index,
      segment_id: input.segment_id,
      type: event.type,
      worker_id: event.worker_id,
      generation: event.generation,
    };
    if (event.type === "worker.result_emitted") {
      return VoiceMissionEventSchema.parse({
        ...base,
        result_id: event.result_id,
        outcome: event.outcome,
        fact_refs: event.fact_refs ?? [],
      });
    }
    if (event.type === "worker.result_accepted") {
      return VoiceMissionEventSchema.parse({ ...base, result_id: event.result_id });
    }
    if (event.type === "worker.result_rejected") {
      return VoiceMissionEventSchema.parse({ ...base, result_id: event.result_id, reason: event.reason });
    }
    return VoiceMissionEventSchema.parse(base);
  }));
}

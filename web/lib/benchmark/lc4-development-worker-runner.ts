import { canonicalJson, sha256Hex } from "./artifacts";
import {
  LC4_ASYNC_WORKER_CALLABLE_SURFACE,
  assertLc4WorkerSnapshot,
  createLc4AsyncWorkerService,
  type Lc4AsyncWorkerClock,
  type Lc4AsyncWorkerService,
  type Lc4WorkerArm,
  type Lc4WorkerCallResult,
  type Lc4WorkerDriveResult,
  type Lc4WorkerFault,
  type Lc4WorkerJob,
  type Lc4WorkerResultDisposition,
  type Lc4WorkerSnapshot,
} from "./lc4-async-worker-service";
import {
  LC4_DEVELOPMENT_PROTOCOL,
  assertLc4DevelopmentAnalog,
  type Lc4DevelopmentAnalog,
  type Lc4StressEvent,
} from "./lc4-development-fixtures";
import type { JsonValue } from "./scenario-schema";
import {
  createToolWorld,
  evaluateScenarioWorld,
  executeTool,
  parseBoundToolWorldState,
  type ToolExecution,
  type ToolWorldState,
} from "./tool-world";

export const LC4_DEVELOPMENT_WORKER_RUN_PROTOCOL = "LC4-DEV-WORKER-RUN-v1" as const;
const ZERO_HEAD = "0".repeat(64);
const SAFE_ID = /^[a-z][a-z0-9_.-]{1,95}$/;

type EvidenceJson = JsonValue;

export type Lc4DevelopmentWorkerEvidenceKind =
  | "worker.call"
  | "worker.result"
  | "worker.drive"
  | "toolworld.invoke"
  | "session.rehydrated";

export type Lc4DevelopmentWorkerEvidenceReceipt = Readonly<{
  protocol: typeof LC4_DEVELOPMENT_WORKER_RUN_PROTOCOL;
  sequence: number;
  receipt_id: string;
  kind: Lc4DevelopmentWorkerEvidenceKind;
  occurred_at: string;
  worker_head_before: string;
  worker_head_after: string;
  world_sha256_before: string;
  world_sha256_after: string;
  operation: EvidenceJson;
  operation_sha256: string;
  previous_receipt_sha256: string;
  receipt_sha256: string;
}>;

export type Lc4DevelopmentWorkerRuntimeSnapshot = Readonly<{
  schema_version: 1;
  protocol: typeof LC4_DEVELOPMENT_WORKER_RUN_PROTOCOL;
  development_protocol: typeof LC4_DEVELOPMENT_PROTOCOL;
  arm: Lc4WorkerArm;
  session_id: string;
  artifact_manifest_sha256: string;
  artifact_schedule_sha256: string;
  artifact_scenario_sha256: string;
  world: ToolWorldState;
  worker: Lc4WorkerSnapshot;
  evidence: readonly Lc4DevelopmentWorkerEvidenceReceipt[];
  evidence_head_sha256: string;
  snapshot_sha256: string;
}>;

export type Lc4DevelopmentWorkerEvidenceVerification = Readonly<{
  valid: boolean;
  errors: readonly string[];
  evidence_receipt_count: number;
  worker_receipt_count: number;
  terminal_result_count: number;
  world_receipt_count: number;
  snapshot_sha256: string | null;
}>;

export type Lc4DevelopmentWorkerToolSurface = readonly Readonly<{
  name: string;
  category: "toolworld" | "async_worker";
  input_schema: Readonly<Record<string, unknown>>;
}>[];

type MutableRuntimeState = {
  sessionId: string;
  world: ToolWorldState;
  worker: Lc4AsyncWorkerService;
  evidence: Lc4DevelopmentWorkerEvidenceReceipt[];
  evidenceHeadSha256: string;
};

function asJson(value: unknown): EvidenceJson {
  return JSON.parse(JSON.stringify(value)) as EvidenceJson;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function worldHash(world: ToolWorldState): string {
  return sha256Hex(canonicalJson(world));
}

function receiptHash(receipt: Omit<Lc4DevelopmentWorkerEvidenceReceipt, "receipt_sha256">): string {
  return sha256Hex(canonicalJson(receipt as unknown as EvidenceJson));
}

function snapshotBody(snapshot: Omit<Lc4DevelopmentWorkerRuntimeSnapshot, "snapshot_sha256">): EvidenceJson {
  return asJson(snapshot);
}

function runtimeSnapshotHash(snapshot: Omit<Lc4DevelopmentWorkerRuntimeSnapshot, "snapshot_sha256">): string {
  return sha256Hex(canonicalJson(snapshotBody(snapshot)));
}

function activeAttempt(job: Lc4WorkerJob) {
  const attempt = job.attempts.at(-1);
  if (!attempt) throw new Error(`worker job ${job.job_id} has no attempt`);
  return attempt;
}

export type Lc4DevelopmentWorkerRuntimeOptions = Readonly<{
  artifact: Lc4DevelopmentAnalog;
  arm: Lc4WorkerArm;
  sessionId: string;
  clock: Lc4AsyncWorkerClock;
  faults?: readonly Lc4WorkerFault[];
  snapshot?: Lc4DevelopmentWorkerRuntimeSnapshot;
}>;

export class Lc4DevelopmentWorkerRuntime {
  readonly #artifact: Lc4DevelopmentAnalog;
  readonly #arm: Lc4WorkerArm;
  readonly #clock: Lc4AsyncWorkerClock;
  readonly #faults: readonly Lc4WorkerFault[];
  readonly #state: MutableRuntimeState;

  constructor(options: Lc4DevelopmentWorkerRuntimeOptions) {
    assertLc4DevelopmentAnalog(options.artifact);
    if (!SAFE_ID.test(options.sessionId)) throw new Error("LC4 runtime sessionId must be a safe identifier");
    this.#artifact = options.artifact;
    this.#arm = options.arm;
    this.#clock = options.clock;
    this.#faults = Object.freeze([...(options.faults ?? [])]);
    if (options.snapshot) {
      const verified = verifyLc4DevelopmentWorkerEvidence(options.artifact, options.snapshot);
      if (!verified.valid) throw new Error(`LC4 runtime snapshot is invalid: ${verified.errors.join(", ")}`);
      if (options.snapshot.arm !== options.arm) throw new Error("LC4 runtime cannot change arm while rehydrating");
      const priorWorkerHead = options.snapshot.worker.head_sha256;
      const priorWorld = parseBoundToolWorldState(options.artifact.scenario, options.snapshot.world);
      const worker = createLc4AsyncWorkerService({
        arm: options.arm,
        sessionId: options.sessionId,
        clock: options.clock,
        faults: this.#faults,
        snapshot: options.snapshot.worker,
      });
      this.#state = {
        sessionId: options.sessionId,
        world: priorWorld,
        worker,
        evidence: structuredClone([...options.snapshot.evidence]),
        evidenceHeadSha256: options.snapshot.evidence_head_sha256,
      };
      const nextWorkerHead = worker.snapshot().head_sha256;
      if (nextWorkerHead !== priorWorkerHead || options.snapshot.session_id !== options.sessionId) {
        this.#appendEvidence("session.rehydrated", {
          from_session_id: options.snapshot.session_id,
          to_session_id: options.sessionId,
          prior_worker_head_sha256: priorWorkerHead,
          next_worker_head_sha256: nextWorkerHead,
        }, priorWorkerHead, worldHash(priorWorld));
      }
    } else {
      const world = createToolWorld(options.artifact.scenario);
      this.#state = {
        sessionId: options.sessionId,
        world,
        worker: createLc4AsyncWorkerService({
          arm: options.arm,
          sessionId: options.sessionId,
          clock: options.clock,
          faults: this.#faults,
        }),
        evidence: [],
        evidenceHeadSha256: ZERO_HEAD,
      };
    }
  }

  callableSurface(): Lc4DevelopmentWorkerToolSurface {
    const toolWorld = this.#artifact.scenario.tools.map((tool) => deepFreeze({
      name: tool.name,
      category: "toolworld" as const,
      input_schema: {
        type: "object",
        additionalProperties: tool.additional_arguments,
        required: tool.arguments.filter((argument) => argument.required).map((argument) => argument.name),
        properties: Object.fromEntries(tool.arguments.map((argument) => [argument.name, {
          type: argument.type,
          ...(argument.enum ? { enum: argument.enum } : {}),
          ...(argument.minimum === undefined ? {} : { minimum: argument.minimum }),
          ...(argument.maximum === undefined ? {} : { maximum: argument.maximum }),
          ...(argument.pattern === undefined ? {} : { pattern: argument.pattern }),
        }])),
      },
    }));
    const workers = LC4_ASYNC_WORKER_CALLABLE_SURFACE.map((capability) => deepFreeze({
      name: capability.name,
      category: "async_worker" as const,
      input_schema: capability.input_schema,
    }));
    return deepFreeze([...toolWorld, ...workers].sort((left, right) => left.name.localeCompare(right.name)));
  }

  callWorker(action: Parameters<Lc4AsyncWorkerService["call"]>[0], args: Readonly<Record<string, unknown>>): Lc4WorkerCallResult {
    const beforeWorker = this.#state.worker.snapshot().head_sha256;
    const beforeWorld = worldHash(this.#state.world);
    const result = this.#state.worker.call(action, args);
    this.#appendEvidence("worker.call", { action, args, result }, beforeWorker, beforeWorld);
    return result;
  }

  submitWorkerResult(input: Parameters<Lc4AsyncWorkerService["submitResult"]>[0]): Lc4WorkerResultDisposition {
    const beforeWorker = this.#state.worker.snapshot().head_sha256;
    const beforeWorld = worldHash(this.#state.world);
    const result = this.#state.worker.submitResult(input);
    this.#appendEvidence("worker.result", { input, result }, beforeWorker, beforeWorld);
    return result;
  }

  driveWorker(input: Parameters<Lc4AsyncWorkerService["drive"]>[0]): Lc4WorkerDriveResult {
    const beforeWorker = this.#state.worker.snapshot().head_sha256;
    const beforeWorld = worldHash(this.#state.world);
    const result = this.#state.worker.drive(input);
    this.#appendEvidence("worker.drive", { input, result }, beforeWorker, beforeWorld);
    return result;
  }

  executeToolWorld(input: Readonly<{
    invocationId: string;
    action: string;
    arguments: Readonly<Record<string, JsonValue>>;
    opportunityIndex: number;
    opportunityId: string;
  }>): ToolExecution {
    if (!this.#artifact.scenario.tools.some((tool) => tool.name === input.action)) {
      throw new Error(`LC4 runtime action ${input.action} is outside its ToolWorld`);
    }
    const beforeWorker = this.#state.worker.snapshot().head_sha256;
    const beforeWorld = worldHash(this.#state.world);
    const execution = executeTool(this.#artifact.scenario, this.#state.world, {
      invocation_id: input.invocationId,
      tool: input.action,
      arguments: input.arguments,
      turn: input.opportunityIndex,
      semantic_opportunity_id: input.opportunityId,
    });
    this.#state.world = execution.state;
    this.#appendEvidence("toolworld.invoke", {
      invocation_id: input.invocationId,
      action: input.action,
      arguments: input.arguments,
      opportunity_index: input.opportunityIndex,
      opportunity_id: input.opportunityId,
      disposition: execution.disposition,
      world_receipt_id: execution.receipt.receipt_id,
      world_receipt_status: execution.receipt.status,
    }, beforeWorker, beforeWorld);
    return execution;
  }

  snapshot(): Lc4DevelopmentWorkerRuntimeSnapshot {
    const body = {
      schema_version: 1 as const,
      protocol: LC4_DEVELOPMENT_WORKER_RUN_PROTOCOL,
      development_protocol: LC4_DEVELOPMENT_PROTOCOL,
      arm: this.#arm,
      session_id: this.#state.sessionId,
      artifact_manifest_sha256: this.#artifact.manifest.manifest_sha256,
      artifact_schedule_sha256: this.#artifact.schedule.schedule_sha256,
      artifact_scenario_sha256: this.#artifact.manifest.scenario_sha256,
      world: structuredClone(this.#state.world),
      worker: this.#state.worker.snapshot(),
      evidence: structuredClone(this.#state.evidence),
      evidence_head_sha256: this.#state.evidenceHeadSha256,
    };
    return deepFreeze({ ...body, snapshot_sha256: runtimeSnapshotHash(body) });
  }

  #appendEvidence(
    kind: Lc4DevelopmentWorkerEvidenceKind,
    operation: unknown,
    workerHeadBefore: string,
    worldSha256Before: string,
  ): void {
    const workerHeadAfter = this.#state.worker.snapshot().head_sha256;
    const worldSha256After = worldHash(this.#state.world);
    const operationJson = asJson(operation);
    const unsigned = {
      protocol: LC4_DEVELOPMENT_WORKER_RUN_PROTOCOL,
      sequence: this.#state.evidence.length + 1,
      receipt_id: `lc4runtime.${String(this.#state.evidence.length + 1).padStart(6, "0")}`,
      kind,
      occurred_at: this.#clock.nowIso(),
      worker_head_before: workerHeadBefore,
      worker_head_after: workerHeadAfter,
      world_sha256_before: worldSha256Before,
      world_sha256_after: worldSha256After,
      operation: operationJson,
      operation_sha256: sha256Hex(canonicalJson(operationJson)),
      previous_receipt_sha256: this.#state.evidenceHeadSha256,
    } as const;
    const receipt = deepFreeze({ ...unsigned, receipt_sha256: receiptHash(unsigned) });
    this.#state.evidence.push(receipt);
    this.#state.evidenceHeadSha256 = receipt.receipt_sha256;
  }
}

export function createLc4DevelopmentWorkerRuntime(
  options: Lc4DevelopmentWorkerRuntimeOptions,
): Lc4DevelopmentWorkerRuntime {
  return new Lc4DevelopmentWorkerRuntime(options);
}

export function verifyLc4DevelopmentWorkerEvidence(
  artifact: Lc4DevelopmentAnalog,
  snapshot: Lc4DevelopmentWorkerRuntimeSnapshot,
): Lc4DevelopmentWorkerEvidenceVerification {
  const errors: string[] = [];
  try {
    assertLc4DevelopmentAnalog(artifact);
  } catch (error) {
    errors.push(`artifact_invalid:${error instanceof Error ? error.message : "unknown"}`);
  }
  if (
    snapshot.protocol !== LC4_DEVELOPMENT_WORKER_RUN_PROTOCOL
    || snapshot.development_protocol !== LC4_DEVELOPMENT_PROTOCOL
  ) errors.push("protocol_mismatch");
  if (snapshot.artifact_manifest_sha256 !== artifact.manifest.manifest_sha256) errors.push("manifest_binding_mismatch");
  if (snapshot.artifact_schedule_sha256 !== artifact.schedule.schedule_sha256) errors.push("schedule_binding_mismatch");
  if (snapshot.artifact_scenario_sha256 !== artifact.manifest.scenario_sha256) errors.push("scenario_binding_mismatch");
  try {
    assertLc4WorkerSnapshot(snapshot.worker);
  } catch (error) {
    errors.push(`worker_snapshot_invalid:${error instanceof Error ? error.message : "unknown"}`);
  }
  let parsedWorld: ToolWorldState | null = null;
  try {
    parsedWorld = parseBoundToolWorldState(artifact.scenario, snapshot.world);
  } catch (error) {
    errors.push(`world_invalid:${error instanceof Error ? error.message : "unknown"}`);
  }
  let priorHash = ZERO_HEAD;
  let priorWorkerHead: string | null = null;
  let priorWorldHead: string | null = null;
  snapshot.evidence.forEach((receipt, index) => {
    const { receipt_sha256: actual, ...unsigned } = receipt;
    if (
      receipt.protocol !== LC4_DEVELOPMENT_WORKER_RUN_PROTOCOL
      || receipt.sequence !== index + 1
      || receipt.receipt_id !== `lc4runtime.${String(index + 1).padStart(6, "0")}`
      || receipt.previous_receipt_sha256 !== priorHash
      || receipt.operation_sha256 !== sha256Hex(canonicalJson(receipt.operation))
      || actual !== receiptHash(unsigned)
    ) errors.push(`evidence_receipt_${index + 1}_invalid`);
    if (index === 0) {
      if (receipt.worker_head_before !== ZERO_HEAD) errors.push("initial_worker_head_mismatch");
      if (receipt.world_sha256_before !== worldHash(createToolWorld(artifact.scenario))) {
        errors.push("initial_world_head_mismatch");
      }
    }
    if (priorWorkerHead !== null && receipt.worker_head_before !== priorWorkerHead) {
      errors.push(`evidence_receipt_${index + 1}_worker_discontinuity`);
    }
    if (priorWorldHead !== null && receipt.world_sha256_before !== priorWorldHead) {
      errors.push(`evidence_receipt_${index + 1}_world_discontinuity`);
    }
    priorHash = actual;
    priorWorkerHead = receipt.worker_head_after;
    priorWorldHead = receipt.world_sha256_after;
  });
  if (snapshot.evidence_head_sha256 !== priorHash) errors.push("evidence_head_mismatch");
  if (snapshot.evidence.length > 0 && priorWorkerHead !== snapshot.worker.head_sha256) errors.push("final_worker_head_mismatch");
  if (snapshot.evidence.length > 0 && parsedWorld && priorWorldHead !== worldHash(parsedWorld)) errors.push("final_world_head_mismatch");
  const acceptedByJob = new Map<string, number>();
  snapshot.worker.receipts.filter((receipt) => receipt.kind === "result.accepted").forEach((receipt) => {
    acceptedByJob.set(receipt.job_id, (acceptedByJob.get(receipt.job_id) ?? 0) + 1);
  });
  for (const job of snapshot.worker.jobs) {
    const accepted = acceptedByJob.get(job.job_id) ?? 0;
    if (accepted > 1) errors.push(`job_${job.job_id}_multiple_terminal_results`);
    if ((job.status === "succeeded" || job.status === "failed") && accepted !== 1) {
      errors.push(`job_${job.job_id}_terminal_result_missing`);
    }
    if ((job.status === "running" || job.status === "cancelled") && accepted !== 0) {
      errors.push(`job_${job.job_id}_unexpected_terminal_result`);
    }
  }
  const { snapshot_sha256: actualSnapshotHash, ...body } = snapshot;
  let computedSnapshotHash: string | null = null;
  try {
    computedSnapshotHash = runtimeSnapshotHash(body);
    if (actualSnapshotHash !== computedSnapshotHash) errors.push("snapshot_hash_mismatch");
  } catch {
    errors.push("snapshot_hash_uncomputable");
  }
  return deepFreeze({
    valid: errors.length === 0,
    errors,
    evidence_receipt_count: snapshot.evidence.length,
    worker_receipt_count: snapshot.worker.receipts.length,
    terminal_result_count: [...acceptedByJob.values()].reduce((sum, count) => sum + count, 0),
    world_receipt_count: parsedWorld?.receipts.length ?? 0,
    snapshot_sha256: computedSnapshotHash,
  });
}

export type Lc4DevelopmentWorkerExperimentResult = Readonly<{
  arm: Lc4WorkerArm;
  surface: Lc4DevelopmentWorkerToolSurface;
  snapshot: Lc4DevelopmentWorkerRuntimeSnapshot;
  verification: Lc4DevelopmentWorkerEvidenceVerification;
  worker_dispositions: readonly Readonly<{
    worker_id: string;
    result_id: string;
    expected: "accept" | "reject_stale" | "reject_cancelled" | "reject_duplicate";
    actual: "accept" | "reject_stale" | "reject_cancelled" | "reject_duplicate";
  }>[];
  world_success: boolean;
}>;

function jobFromStart(result: Lc4WorkerCallResult): Lc4WorkerJob {
  if (!result.ok) throw new Error(`LC4 worker start failed: ${result.code}`);
  return result.job;
}

function checkpointOrdinal(stressor: Extract<Lc4StressEvent, { kind: "checkpoint" }>): number {
  const parsed = Number(stressor.checkpoint_id.split(".").at(-1));
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 12) throw new Error("invalid LC4 checkpoint ordinal");
  return parsed;
}

export function runLc4DevelopmentWorkerExperiment(input: Readonly<{
  artifact: Lc4DevelopmentAnalog;
  arm: Lc4WorkerArm;
  clock: Lc4AsyncWorkerClock;
}>): Lc4DevelopmentWorkerExperimentResult {
  assertLc4DevelopmentAnalog(input.artifact);
  const staleFault: Lc4WorkerFault = Object.freeze({
    id: "fault.worker-2-stale",
    worker_id: "worker.2",
    generation: 1,
    attempt_ordinal: 1,
    kind: "fail_attempt_once",
  });
  let runtime = createLc4DevelopmentWorkerRuntime({
    artifact: input.artifact,
    arm: input.arm,
    sessionId: "session.act-1",
    clock: input.clock,
    faults: [staleFault],
  });
  const surface = runtime.callableSurface();
  const jobs = new Map<string, Lc4WorkerJob>();
  const launchAttempts = new Map<string, ReturnType<typeof activeAttempt>>();
  const dispositions: Lc4DevelopmentWorkerExperimentResult["worker_dispositions"][number][] = [];
  const subjectId = input.artifact.scenario.initial_facts.subject_id;
  if (typeof subjectId !== "string") throw new Error("LC4 development subject_id is not a string");

  for (const opportunity of input.artifact.schedule.opportunities) {
    for (const stressor of opportunity.stressors) {
      if (stressor.kind === "connection_rotation") {
        const snapshot = runtime.snapshot();
        runtime = createLc4DevelopmentWorkerRuntime({
          artifact: input.artifact,
          arm: input.arm,
          sessionId: `session.${stressor.mode}.${opportunity.index}`,
          clock: input.clock,
          faults: [staleFault],
          snapshot,
        });
      } else if (stressor.kind === "worker_launch") {
        const job = jobFromStart(runtime.callWorker("worker.start", {
          request_id: `request.${stressor.worker_id}`,
          worker_id: stressor.worker_id,
          generation: 1,
          payload: {
            profile: stressor.profile,
            eligible_at_opportunity: stressor.eligible_at_opportunity,
            schedule_sha256: input.artifact.schedule.schedule_sha256,
          },
        }));
        jobs.set(stressor.worker_id, job);
        launchAttempts.set(stressor.worker_id, activeAttempt(job));
      } else if (stressor.kind === "worker_result") {
        const job = jobs.get(stressor.worker_id);
        const launchAttempt = launchAttempts.get(stressor.worker_id);
        if (!job || !launchAttempt) throw new Error(`LC4 result ${stressor.result_id} has no launched worker`);
        const status = runtime.callWorker("worker.status", { job_id: job.job_id });
        if (!status.ok) throw new Error(`LC4 worker status failed: ${status.code}`);
        const current = activeAttempt(status.job);
        const candidate = {
          resultId: stressor.result_id,
          outcome: "succeeded" as const,
          payload: { worker_id: stressor.worker_id, eligible_at_opportunity: opportunity.index },
        };
        let actual: Lc4DevelopmentWorkerExperimentResult["worker_dispositions"][number]["actual"];
        if (stressor.expected_disposition === "reject_stale") {
          runtime.driveWorker({ jobId: job.job_id, ...candidate });
          const rejected = runtime.submitWorkerResult({
            jobId: job.job_id,
            attemptId: launchAttempt.attempt_id,
            leaseId: launchAttempt.lease.lease_id,
            leaseEpoch: launchAttempt.lease.epoch,
            ...candidate,
          });
          actual = rejected.reason === "stale" ? "reject_stale" : "accept";
        } else if (stressor.expected_disposition === "reject_cancelled") {
          runtime.callWorker("worker.cancel", { job_id: job.job_id });
          const rejected = runtime.submitWorkerResult({
            jobId: job.job_id,
            attemptId: current.attempt_id,
            leaseId: current.lease.lease_id,
            leaseEpoch: current.lease.epoch,
            ...candidate,
          });
          actual = rejected.reason === "cancelled" ? "reject_cancelled" : "accept";
        } else {
          const accepted = runtime.submitWorkerResult({
            jobId: job.job_id,
            attemptId: current.attempt_id,
            leaseId: current.lease.lease_id,
            leaseEpoch: current.lease.epoch,
            ...candidate,
          });
          if (stressor.expected_disposition === "reject_duplicate") {
            const duplicate = runtime.submitWorkerResult({
              jobId: job.job_id,
              attemptId: current.attempt_id,
              leaseId: current.lease.lease_id,
              leaseEpoch: current.lease.epoch,
              ...candidate,
            });
            actual = duplicate.reason === "duplicate" ? "reject_duplicate" : "accept";
          } else {
            actual = accepted.accepted ? "accept" : `reject_${accepted.reason}` as typeof actual;
          }
        }
        dispositions.push({
          worker_id: stressor.worker_id,
          result_id: stressor.result_id,
          expected: stressor.expected_disposition,
          actual,
        });
      } else if (stressor.kind === "checkpoint") {
        const ordinal = checkpointOrdinal(stressor);
        if (ordinal === 7) continue;
        const number = String(ordinal).padStart(2, "0");
        const tool = input.artifact.scenario.tools.find((candidate) => candidate.name.endsWith(`.apply_${number}`));
        if (!tool) throw new Error(`LC4 checkpoint ${number} has no ToolWorld mutation`);
        runtime.executeToolWorld({
          invocationId: `lc4.apply.${number}`,
          action: tool.name,
          arguments: { subject_id: subjectId },
          opportunityIndex: opportunity.index,
          opportunityId: opportunity.id,
        });
      } else if (stressor.kind === "committed_after_error") {
        const execution = runtime.executeToolWorld({
          invocationId: "lc4.apply.07",
          action: stressor.action,
          arguments: { subject_id: subjectId },
          opportunityIndex: opportunity.index,
          opportunityId: opportunity.id,
        });
        if (execution.receipt.status !== "committed_after_error") {
          throw new Error("LC4 committed-after-error fixture did not exercise ambiguity");
        }
      } else if (stressor.kind === "authoritative_reconciliation") {
        runtime.executeToolWorld({
          invocationId: "lc4.read.07.reconcile",
          action: stressor.action,
          arguments: { subject_id: subjectId },
          opportunityIndex: opportunity.index,
          opportunityId: opportunity.id,
        });
      }
    }
  }
  // The held-out protocol may intentionally end after rejecting a stale
  // generation. Deterministic development runs still revoke every remaining
  // lease so no background authority survives beyond the experiment horizon.
  for (const job of runtime.snapshot().worker.jobs.filter((candidate) => candidate.status === "running")) {
    const cancelled = runtime.callWorker("worker.cancel", { job_id: job.job_id });
    if (!cancelled.ok) throw new Error(`LC4 worker cleanup failed: ${cancelled.code}`);
  }
  const snapshot = runtime.snapshot();
  const verification = verifyLc4DevelopmentWorkerEvidence(input.artifact, snapshot);
  const worldEvaluation = evaluateScenarioWorld(input.artifact.scenario, snapshot.world);
  return deepFreeze({
    arm: input.arm,
    surface,
    snapshot,
    verification,
    worker_dispositions: dispositions,
    world_success: worldEvaluation.success.every((assertion) => assertion.passed)
      && worldEvaluation.safety.every((assertion) => assertion.passed),
  });
}

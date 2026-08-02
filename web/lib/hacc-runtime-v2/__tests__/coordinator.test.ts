import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PolicyFact } from "../../action-policy-kernel";
import {
  appendConversationProgramEvents,
  conversationProgramDigest,
  createConversationProgramLog,
  foldConversationProgram,
  type ConversationProgramLog,
  type ConversationProgramProjection,
} from "../../conversation-program";
import { createEd25519EvidenceSignerV2, EvidenceTapV2 } from "../../evidence-v2";
import type {
  DispatchBoundaryResult,
  GovernedEffectAuthority,
  GovernedEffectLease,
  GovernedEffectReceipt,
  GovernedEffectStore,
  ReconciliationClaim,
  ReconciliationJob,
  ReserveAllowedInput,
  ReserveAllowedResult,
} from "../../governed-effect-runtime";
import type { TurnContractSource } from "../../runtime-control/turn-contract";
import {
  HaccRuntimeCoordinatorErrorV2,
  HaccRuntimeCoordinatorV2,
  type HaccRuntimeMutationV2,
  type HaccRuntimeSnapshotV2,
  type HaccRuntimeStoreV2,
  type HaccTurnContractProjectorV2,
} from "..";

const H = (character: string): string => character.repeat(64);
const AT = "2026-08-02T20:00:00.000Z";

class MemoryRuntimeStore implements HaccRuntimeStoreV2 {
  readonly snapshots = new Map<string, HaccRuntimeSnapshotV2>();
  async create(snapshot: HaccRuntimeSnapshotV2) {
    if (this.snapshots.has(snapshot.program.programId)) return "exists" as const;
    this.snapshots.set(snapshot.program.programId, snapshot);
    return "created" as const;
  }
  async read(programId: string) { return this.snapshots.get(programId) ?? null; }
  async transact<T>(
    programId: string,
    operation: (current: HaccRuntimeSnapshotV2) => Promise<HaccRuntimeMutationV2<T>>,
  ): Promise<T> {
    const current = this.snapshots.get(programId);
    if (!current) throw new Error("missing runtime");
    const mutation = await operation(current);
    if (mutation.next.runtimeRevision !== current.runtimeRevision + 1) throw new Error("runtime revision must advance once");
    this.snapshots.set(programId, mutation.next);
    return mutation.value;
  }
}

const policy = Object.freeze({
  schema_version: 1,
  id: "test.runtime",
  version: "1",
  default_decision: "deny",
  actions: [{
    action: "write.order",
    effect: "write",
    require_all: [{ kind: "fact", fact_id: "caller.verified", operator: "equals", value: true, authorities: ["tool"] }],
    deny_if_any: [],
    postconditions: [{ kind: "argument", path: "status", operator: "equals", value: "committed" }],
    provider_visible_result_fields: ["status"],
  }],
});

class MemoryEffectStore implements GovernedEffectStore {
  authority: GovernedEffectAuthority = {
    stateHeadSha256: H("0"), stateRevision: 0, capabilityEpoch: 0, policy,
    facts: [], receipts: [], priorCallCount: 0,
  };
  readonly receipts = new Map<string, GovernedEffectReceipt>();
  readonly jobs = new Map<string, ReconciliationJob>();
  dispatches = 0;

  sync(snapshot: HaccRuntimeSnapshotV2): void {
    const projection = foldConversationProgram(snapshot.program);
    const facts: PolicyFact[] = projection.facts.map((fact) => ({
      fact_id: fact.key,
      revision: fact.revision,
      value: fact.value,
      authority: fact.authority.kind,
      observed_at: AT,
      evidence_sha256: fact.authority.evidenceSha256,
    }));
    // The test's verification fact is tool authoritative, as it would be after an identity lookup.
    facts.push({ fact_id: "caller.verified", revision: 1, value: true, authority: "tool", observed_at: AT, evidence_sha256: H("e") });
    this.authority = {
      stateHeadSha256: projection.headSha256,
      stateRevision: projection.revision,
      capabilityEpoch: projection.capabilityEpoch,
      policy,
      facts,
      receipts: [],
      priorCallCount: this.receipts.size,
    };
  }
  async readAuthority() { return this.authority; }
  async reserveAllowed(input: ReserveAllowedInput): Promise<ReserveAllowedResult> {
    const current = this.authority;
    if (current.stateHeadSha256 !== input.decision.state_head_sha256 ||
        current.stateRevision !== input.decision.state_revision ||
        current.capabilityEpoch !== input.decision.capability_epoch) {
      return { disposition: "stale_authority", current };
    }
    const existing = [...this.receipts.values()].find(({ idempotencyKey }) => idempotencyKey === input.proposal.idempotencyKey);
    if (existing) return { disposition: "in_flight_replay", receipt: existing };
    const receipt: GovernedEffectReceipt = {
      receiptId: `remote.receipt.${this.receipts.size + 1}`,
      scopeId: input.scope.subjectId,
      invocationId: `remote.invocation.${this.receipts.size + 1}`,
      idempotencyKey: input.proposal.idempotencyKey,
      action: input.proposal.action,
      effect: input.decision.effect as "write",
      argumentsSha256: input.decision.arguments_sha256,
      proposalDigest: input.decision.proposal_digest,
      policyDigest: input.decision.policy_digest,
      stateHeadSha256: input.decision.state_head_sha256,
      stateRevision: input.decision.state_revision,
      capabilityEpoch: input.decision.capability_epoch,
      status: "reserved",
      dispatchAttempts: 0,
    };
    const lease: GovernedEffectLease = {
      leaseId: `lease.${this.receipts.size + 1}`,
      action: receipt.action,
      effect: receipt.effect,
      argumentsSha256: receipt.argumentsSha256,
      proposalDigest: receipt.proposalDigest,
      policyDigest: receipt.policyDigest,
      decisionDigest: input.decision.decision_digest,
      stateHeadSha256: receipt.stateHeadSha256,
      stateRevision: receipt.stateRevision,
      capabilityEpoch: receipt.capabilityEpoch,
      expiresAt: input.leaseExpiresAt,
    };
    this.receipts.set(receipt.receiptId, receipt);
    return { disposition: "reserved", receipt, lease, dispatchOwner: true };
  }
  async repairBeforeDispatch() { return { repaired: false }; }
  async crossDispatchBoundary(input: Parameters<GovernedEffectStore["crossDispatchBoundary"]>[0]): Promise<DispatchBoundaryResult> {
    const receipt = this.receipts.get(input.receiptId)!;
    const started = { ...receipt, status: "dispatching" as const, dispatchAttempts: 1, dispatchStartedAt: input.now };
    this.receipts.set(receipt.receiptId, started);
    this.dispatches += 1;
    return { disposition: "started", receipt: started };
  }
  async settle(input: Parameters<GovernedEffectStore["settle"]>[0]): Promise<GovernedEffectReceipt> {
    const current = this.receipts.get(input.receiptId)!;
    const settled: GovernedEffectReceipt = {
      ...current,
      status: input.status,
      settledAt: input.now,
      ...(input.resultSha256 ? { resultSha256: input.resultSha256 } : {}),
      ...(input.proofSha256 ? { proofSha256: input.proofSha256 } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.providerVisibleResult ? { providerVisibleResult: input.providerVisibleResult } : {}),
    };
    this.receipts.set(settled.receiptId, settled);
    return settled;
  }
  async ensureIndeterminateReconciliation(input: Parameters<GovernedEffectStore["ensureIndeterminateReconciliation"]>[0]) {
    const existing = [...this.jobs.values()].find(({ receiptId }) => receiptId === input.receiptId);
    if (existing) return { disposition: "indeterminate" as const, receipt: this.receipts.get(input.receiptId)!, job: existing };
    const current = this.receipts.get(input.receiptId)!;
    const receipt: GovernedEffectReceipt = { ...current, status: "indeterminate", errorCode: input.errorCode, settledAt: input.now };
    this.receipts.set(receipt.receiptId, receipt);
    const job: ReconciliationJob = {
      jobId: `job.${this.jobs.size + 1}`,
      receiptId: input.receiptId, scope: input.scope, invocationId: input.invocationId,
      idempotencyKey: input.idempotencyKey, action: input.action, arguments: input.arguments,
      argumentsSha256: input.argumentsSha256, policy: input.policy,
      preDispatchDecision: input.preDispatchDecision, attempt: 0,
      maxAttempts: input.maxClaimAttempts, status: "queued",
    };
    this.jobs.set(job.jobId, job);
    return { disposition: "indeterminate" as const, receipt, job };
  }
  async claimReconciliation(input: Parameters<GovernedEffectStore["claimReconciliation"]>[0]): Promise<ReconciliationClaim> {
    const job = this.jobs.get(input.jobId)!;
    const receipt = this.receipts.get(job.receiptId)!;
    if (job.status !== "queued") return { disposition: "not_claimable", job, receipt };
    const claim = { claimId: `claim.${job.jobId}.1`, ordinal: 1, claimedAt: input.now, expiresAt: input.leaseExpiresAt };
    const claimed = { ...job, attempt: 1, status: "running" as const, activeClaim: claim };
    this.jobs.set(input.jobId, claimed);
    return { disposition: "claimed", job: claimed, claim };
  }
  async settleReconciliation(input: Parameters<GovernedEffectStore["settleReconciliation"]>[0]) {
    const job = { ...this.jobs.get(input.jobId)!, status: "completed" as const };
    this.jobs.set(input.jobId, job);
    const current = this.receipts.get(input.receiptId)!;
    const receipt: GovernedEffectReceipt = {
      ...current,
      status: input.disposition === "committed" ? "succeeded" : input.disposition === "absent" ? "failed" : "indeterminate",
      ...(input.proofSha256 ? { proofSha256: input.proofSha256 } : {}),
      ...(input.resultSha256 ? { resultSha256: input.resultSha256 } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      settledAt: input.now,
    };
    this.receipts.set(receipt.receiptId, receipt);
    return { disposition: "settled" as const, job, receipt };
  }
}

class TestProjector implements HaccTurnContractProjectorV2 {
  project({ program }: Readonly<{ program: ConversationProgramProjection }>): TurnContractSource {
    const checkpoint = program.focusedGoal
      ? program.flowCheckpoints.find(({ goalId }) => goalId === program.focusedGoal!.goalId)
      : undefined;
    const reconciled = program.facts.some(({ key, value }) =>
      key.startsWith("reconciliation.") && typeof value === "object" && !Array.isArray(value) &&
      value !== null && value.disposition === "committed");
    const receipts = program.actionReservations.map((reservation) => {
      const receipt = program.actionReceipts.find(({ reservationId }) => reservationId === reservation.reservationId);
      const status = receipt?.status === "indeterminate" && reconciled ? "succeeded" : receipt?.status ?? "reserved";
      return {
        receipt_id: receipt?.receiptId ?? `pending.${reservation.reservationId}`,
        action_id: reservation.action,
        action_semantic_sha256: H("4"),
        effect: "write" as const,
        capability_epoch: receipt?.status === "indeterminate" && reconciled
          ? program.capabilityEpoch : reservation.capabilityEpoch,
        status,
        outcome_authority: "effect" as const,
        outcome_predicate_sha256: H("9"),
        outcome_status: status === "succeeded" ? "satisfied" as const
          : status === "failed" ? "not_satisfied" as const : "unverified" as const,
        settled_revision: status === "reserved" ? null : receipt?.sequence ?? program.revision,
        receipt_sha256: receipt?.evidenceSha256 ?? H("5"),
      } as const;
    });
    const indeterminate = receipts.find(({ status }) => status === "indeterminate");
    const workers = program.workers
      .filter(({ capabilityEpoch }) => capabilityEpoch === program.capabilityEpoch)
      .map((worker) => ({
        worker_id: worker.workerId,
        goal_id: worker.goalId,
        generation: 1,
        status: worker.status === "running" ? "running" as const
          : worker.status === "delivered" ? "succeeded" as const : "cancelled" as const,
        authority_revision: worker.spawnedSequence,
        capability_epoch: worker.capabilityEpoch,
        authority_sha256: H("6"),
      }));
    return {
      conversation: { conversation_id: program.programId, revision: program.revision, head_sha256: program.headSha256 },
      public_identifier_registry_sha256: H("1"),
      control_plane: {
        mode: "flow",
        flow: checkpoint && checkpoint.capabilityEpoch === program.capabilityEpoch
          ? { revision: checkpoint.flowRevision, capability_epoch: checkpoint.capabilityEpoch, state_sha256: checkpoint.stateSha256 }
          : { revision: program.revision, capability_epoch: program.capabilityEpoch, state_sha256: conversationProgramDigest(program) },
        mission: null,
      },
      capability_epoch: program.capabilityEpoch,
      frontier: {
        eligible_intents: program.focusedGoal ? ["continue.goal"] : ["route.goal"],
        eligible_actions: program.capabilities.map((action) => ({
          action_id: action,
          effect: action === "read.order" ? "read" : "write",
          purpose: action === "read.order" ? "reconciliation" : "operation",
          policy_sha256: H("2"), semantic_sha256: H("4"),
        })),
      },
      required_slots: [{ slot_id: "caller.address", status: program.facts.some(({ key }) => key === "caller.address") ? "present" : "missing" }],
      claims: {
        allowed: [
          { claim_id: "claim.progress", claim_class: "progress", supporting_receipt_id: null, supporting_action_id: null, required_action_semantic_sha256: null, required_outcome_predicate_sha256: null, claim_semantic_sha256: H("7") },
          ...receipts.filter(({ status }) => status === "succeeded").map((receipt) => ({
            claim_id: `claim.effect.${receipt.receipt_id.replaceAll(".", "-")}`,
            claim_class: "effect_success" as const,
            supporting_receipt_id: receipt.receipt_id,
            supporting_action_id: receipt.action_id,
            required_action_semantic_sha256: H("4"),
            required_outcome_predicate_sha256: H("9"),
            claim_semantic_sha256: H("8"),
          })),
        ],
        prohibited: [{ claim_id: "claim.unsupported", claim_class: "unsupported", reason_code: "receipt.required" }],
      },
      receipts,
      workers,
      ambiguities: indeterminate ? [{
        ambiguity_id: `ambiguity.${indeterminate.receipt_id}`,
        reason_code: "write.outcome.unknown",
        receipt_id: indeterminate.receipt_id,
        designated_reconciliation_actions: ["read.order"],
      }] : [],
      lifecycle: {
        status: program.focusedGoal ? "active" : program.goals.some(({ status }) => status === "completed") ? "completed" : "routing",
        refresh_required: false,
        preferred_response_mode: program.focusedGoal ? (workers.some(({ status }) => status === "running") ? "await_worker" : "act") :
          program.goals.some(({ status }) => status === "completed") ? "terminal" : "route",
      },
    };
  }
}

function initialProgram(): ConversationProgramLog {
  return appendConversationProgramEvents(createConversationProgramLog("call.test"), [
    { eventId: "goal.open", expectedRevision: 0, occurredAt: AT, payload: { type: "goal.opened", goalId: "goal.primary", description: "Complete the order safely" } },
    { eventId: "goal.focus", expectedRevision: 1, occurredAt: AT, payload: { type: "goal.focused", goalId: "goal.primary" } },
    { eventId: "capabilities.primary", expectedRevision: 2, occurredAt: AT, payload: { type: "capability_epoch.advanced", expectedEpoch: 1, epoch: 2, capabilities: ["write.order", "read.order"], reason: "primary flow" } },
    { eventId: "flow.primary.1", expectedRevision: 3, occurredAt: AT, payload: { type: "flow.checkpoint_recorded", goalId: "goal.primary", flowId: "flow.order", flowVersion: "1", flowRevision: 1, capabilityEpoch: 2, status: "active", nodeId: "collect.address", stepPath: "order/address", completedStepCount: 0, stateSha256: H("a") } },
  ]);
}

function evidenceTap() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return new EvidenceTapV2({
    runId: "runtime.test",
    signer: createEd25519EvidenceSignerV2({ signerId: "test.signer", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }),
    now: () => new Date(AT),
  });
}

describe("HaccRuntimeCoordinatorV2", () => {
  it("keeps corrections, detours, effects, reconciliation, workers, audibility and replay on one contract-bound authority", async () => {
    const runtimeStore = new MemoryRuntimeStore();
    const effectStore = new MemoryEffectStore();
    const tap = evidenceTap();
    const coordinator = new HaccRuntimeCoordinatorV2({
      store: runtimeStore,
      contractProjector: new TestProjector(),
      effectStore,
      effectAdapters: [{
        action: "write.order",
        reconciliationEffect: "read",
        async dispatch() { return { disposition: "indeterminate", errorCode: "connection_lost_after_commit" }; },
        async reconcile() { return { disposition: "committed", proofSha256: H("9"), result: { status: "committed" } }; },
      }],
      evidenceTap: tap,
      now: () => AT,
      onCommit: { onCommitted(snapshot) { effectStore.sync(snapshot); } },
    });
    let state = await coordinator.initialize({ programId: "call.test", program: initialProgram() });
    const genesisContract = state.contract.contract_sha256;

    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "address.initial",
      payload: { type: "fact.asserted", key: "caller.address", value: "1 Main St", authority: { kind: "caller", evidenceSha256: H("b") } },
    });
    let activeEpoch = foldConversationProgram(state.program).capabilityEpoch;
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "capabilities.after.address",
      payload: { type: "capability_epoch.advanced", expectedEpoch: activeEpoch, epoch: activeEpoch + 1, capabilities: ["write.order", "read.order"], reason: "address accepted" },
    });
    activeEpoch += 1;
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "flow.primary.address",
      payload: { type: "flow.checkpoint_recorded", goalId: "goal.primary", flowId: "flow.order", flowVersion: "1", flowRevision: 2, capabilityEpoch: activeEpoch, status: "active", nodeId: "confirm.order", stepPath: "order/confirm", completedStepCount: 1, stateSha256: H("b") },
    });
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "worker.old.spawn",
      payload: { type: "worker.spawned", workerId: "worker.old", goalId: "goal.primary", purpose: "Check delivery", capabilityEpoch: activeEpoch, dependencies: [{ key: "caller.address", revision: 1 }] },
    });

    // A real detour suspends the primary goal and revokes its dynamic capability frontier.
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "goal.detour.open",
      payload: { type: "goal.opened", goalId: "goal.detour", description: "Answer a membership question" },
    });
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "goal.detour.focus",
      payload: { type: "goal.focused", goalId: "goal.detour" },
    });
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "goal.detour.suspend",
      payload: { type: "goal.suspended", goalId: "goal.detour", reason: "caller returned to order" },
    });
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "goal.primary.refocus",
      payload: { type: "goal.focused", goalId: "goal.primary" },
    });
    const epoch = foldConversationProgram(state.program).capabilityEpoch;
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "capabilities.primary.refocus",
      payload: { type: "capability_epoch.advanced", expectedEpoch: epoch, epoch: epoch + 1, capabilities: ["write.order", "read.order"], reason: "primary resumed" },
    });
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "flow.primary.2",
      payload: { type: "flow.checkpoint_recorded", goalId: "goal.primary", flowId: "flow.order", flowVersion: "1", flowRevision: 3, capabilityEpoch: epoch + 1, status: "active", nodeId: "collect.address", stepPath: "order/address", completedStepCount: 0, stateSha256: H("c") },
    });
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "address.corrected",
      payload: { type: "fact.corrected", key: "caller.address", value: "2 Oak St", expectedFactRevision: 1, authority: { kind: "caller", evidenceSha256: H("d") } },
    });
    activeEpoch = foldConversationProgram(state.program).capabilityEpoch;
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "capabilities.after.correction",
      payload: { type: "capability_epoch.advanced", expectedEpoch: activeEpoch, epoch: activeEpoch + 1, capabilities: ["write.order", "read.order"], reason: "correction recompiled" },
    });
    activeEpoch += 1;
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "flow.primary.corrected",
      payload: { type: "flow.checkpoint_recorded", goalId: "goal.primary", flowId: "flow.order", flowVersion: "1", flowRevision: 4, capabilityEpoch: activeEpoch, status: "active", nodeId: "confirm.order", stepPath: "order/confirm", completedStepCount: 1, stateSha256: H("d") },
    });
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "worker.old.delivery",
      payload: { type: "worker.delivery_recorded", deliveryId: "delivery.old", workerId: "worker.old", goalId: "goal.primary", capabilityEpoch: activeEpoch - 1, dependencyFactRevisions: [{ key: "caller.address", revision: 1 }], resultSha256: H("e") },
    });
    expect(foldConversationProgram(state.program).workerDeliveries.at(-1)?.disposition).toBe("rejected");
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "worker.new.spawn",
      payload: { type: "worker.spawned", workerId: "worker.new", goalId: "goal.primary", purpose: "Check corrected delivery", capabilityEpoch: activeEpoch, dependencies: [{ key: "caller.address", revision: 2 }] },
    });
    state = await coordinator.recordProgramEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      eventId: "worker.new.delivery",
      payload: { type: "worker.delivery_recorded", deliveryId: "delivery.new", workerId: "worker.new", goalId: "goal.primary", capabilityEpoch: activeEpoch, dependencyFactRevisions: [{ key: "caller.address", revision: 2 }], resultSha256: H("f") },
    });
    expect(foldConversationProgram(state.program).workerDeliveries.find(({ deliveryId }) => deliveryId === "delivery.new"))
      .toMatchObject({ disposition: "accepted", reason: null });

    await expect(coordinator.executeEffect("call.test", {
      expectedContractSha256: genesisContract,
      attemptId: "attempt.stale",
      action: "write.order",
      arguments: { status: "committed" },
      idempotencyKey: "order-stale",
    })).rejects.toMatchObject({ code: "contract_stale" });
    const effect = await coordinator.executeEffect("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      attemptId: "attempt.order",
      action: "write.order",
      arguments: { status: "committed" },
      idempotencyKey: "order-1",
    });
    expect(effect.disposition).toBe("indeterminate");
    expect(effectStore.dispatches).toBe(1);
    expect(effect.snapshot.contract.response_mode).toBe("reconcile");
    const reconciled = await coordinator.runReconciliation("call.test", {
      expectedContractSha256: effect.snapshot.contract.contract_sha256,
      eventId: "reconcile.order",
      jobId: effect.reconciliationJobId!,
    });
    expect(reconciled.disposition).toBe("committed");
    state = reconciled.snapshot;
    expect(state.contract.ambiguities).toEqual([]);
    const succeeded = state.contract.receipts.find(({ action_id }) => action_id === "write.order")!;
    expect(succeeded.status).toBe("succeeded");

    const audio = async (event: Parameters<typeof coordinator.recordAudibilityEvent>[1]["event"]) => {
      state = await coordinator.recordAudibilityEvent("call.test", { expectedContractSha256: state.contract.contract_sha256, event });
    };
    await audio({ type: "response_registered", eventId: "audio.register", responseId: "response.one", encoding: "pcm16", sampleRateHz: 16_000, channels: 1, evidence: { source: "provider_output", sha256: H("1") } });
    await audio({ type: "pcm_chunk_generated", eventId: "audio.chunk", responseId: "response.one", chunkId: "chunk.one", ordinal: 0, sampleCount: 16_000, pcmSha256: H("2"), evidence: { source: "provider_output", sha256: H("2") } });
    await audio({ type: "generation_closed", eventId: "audio.closed", responseId: "response.one", evidence: { source: "provider_output", sha256: H("3") } });
    await audio({ type: "terminal_claim_registered", eventId: "claim.register", responseId: "response.one", claimId: "claim.order", kind: "external_effect", range: { startSample: 0, endSample: 16_000 }, contentSha256: H("4"), evidence: { source: "semantic_alignment", sha256: H("4") } });
    const preparedGrant = await coordinator.prepareClaimGrant("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      responseId: "response.one", claimId: "claim.order", receiptId: succeeded.receipt_id,
    });
    await audio({ type: "claim_grant_issued", eventId: "claim.grant", responseId: "response.one", grantId: "grant.order", authority: preparedGrant.authority, evidence: { source: "effect_receipt", sha256: preparedGrant.evidenceSha256 } });
    await audio({ type: "release_requested", eventId: "audio.release", responseId: "response.one", decisionId: "release.one", range: { startSample: 0, endSample: 16_000 }, claimGrantIds: ["grant.order"], evidence: { source: "release_controller", sha256: H("5") } });
    await audio({ type: "playback_acknowledged", eventId: "audio.heard", responseId: "response.one", acknowledgementId: "heard.one", ranges: [{ startSample: 0, endSample: 8_000 }], releaseDecisionIds: ["release.one"], evidence: { source: "playback_device", sha256: H("6") } });
    await audio({ type: "playback_cleared", eventId: "audio.clear", responseId: "response.one", clearId: "clear.one", reason: "barge_in", evidence: { source: "transport_control", sha256: H("7") } });
    await audio({ type: "barge_in_recorded", eventId: "audio.barge", responseId: "response.one", bargeInId: "barge.one", clearId: "clear.one", evidence: { source: "transport_control", sha256: H("8") } });
    expect(foldConversationProgram(state.program).audibilityFacts[0]).toMatchObject({ interrupted: true, heardThroughMs: 500 });

    state = await coordinator.recordProviderEvent("call.test", {
      expectedContractSha256: state.contract.contract_sha256,
      event: { provider: "test", session_id: "session.two", provider_event_id: "provider.reconnect", provider_sequence: 1, kind: "reconnect", turn_id: null, raw_event_sha256: H("9") },
    });
    const replayed = await new HaccRuntimeCoordinatorV2({
      store: runtimeStore, contractProjector: new TestProjector(), effectStore,
      effectAdapters: [], evidenceTap: tap, now: () => AT,
    }).resume("call.test");
    expect(conversationProgramDigest(foldConversationProgram(replayed.program)))
      .toBe(conversationProgramDigest(foldConversationProgram(state.program)));
    expect(replayed.contract.contract_sha256).toBe(state.contract.contract_sha256);
  });

  it("fails closed when the host-retained contract is corrupted", async () => {
    const runtimeStore = new MemoryRuntimeStore();
    const effectStore = new MemoryEffectStore();
    const coordinator = new HaccRuntimeCoordinatorV2({
      store: runtimeStore, contractProjector: new TestProjector(), effectStore,
      effectAdapters: [], evidenceTap: evidenceTap(), now: () => AT,
      onCommit: { onCommitted(snapshot) { effectStore.sync(snapshot); } },
    });
    const state = await coordinator.initialize({ programId: "call.test", program: initialProgram() });
    runtimeStore.snapshots.set("call.test", {
      ...state,
      contract: { ...state.contract, contract_sha256: H("f") },
    } as HaccRuntimeSnapshotV2);
    await expect(coordinator.resume("call.test")).rejects.toBeInstanceOf(HaccRuntimeCoordinatorErrorV2);
  });
});

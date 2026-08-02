import { createHash } from "node:crypto";
import {
  applyAudibilityLedgerEvent,
  createAudibilityLedger,
  reopenVerifiedClaimGrantAuthority,
  type AudibilityLedger,
  type AudibilityLedgerEvent,
} from "../audibility-v2";
import {
  appendConversationProgramEvent,
  appendConversationProgramEvents,
  canonicalProgramJson,
  createConversationProgramLog,
  foldConversationProgram,
  type ConversationProgramEventDraft,
  type ConversationProgramEventPayload,
  type ConversationProgramLog,
  type ConversationProgramProjection,
} from "../conversation-program";
import { GovernedEffectCoordinator } from "../governed-effect-runtime";
import type {
  GovernedEffectExecutionResult,
  GovernedEffectReceipt,
  ReconciliationRunResult,
} from "../governed-effect-runtime";
import {
  assertProductionTurnContract,
  createProductionTurnContract,
  type ProductionTurnContract,
  type TurnContractFreshness,
  type TurnContractSource,
} from "../runtime-control/turn-contract";
import {
  HACC_RUNTIME_COORDINATOR_V2_SCHEMA_VERSION,
  type AudibilityEventRequestV2,
  type ClaimGrantPreparationRequestV2,
  type ContractBoundRequestV2,
  type EffectRequestV2,
  type HaccRuntimeDependenciesV2,
  type HaccRuntimeEffectResultV2,
  type HaccRuntimeSnapshotV2,
  type ProgramEventRequestV2,
  type PreparedClaimGrantV2,
  type ProviderEventRequestV2,
  type ReconciliationRequestV2,
  type HaccRuntimeReconciliationResultV2,
} from "./types";

const SHA256 = /^[a-f0-9]{64}$/;

export class HaccRuntimeCoordinatorErrorV2 extends Error {
  constructor(
    readonly code:
      | "runtime_not_found"
      | "runtime_exists"
      | "runtime_corrupt"
      | "contract_stale"
      | "capability_denied"
      | "audibility_rejected"
      | "claim_authority_stale",
    message: string,
  ) {
    super(message);
    this.name = "HaccRuntimeCoordinatorErrorV2";
  }
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\n${canonicalProgramJson(value)}`, "utf8").digest("hex");
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function freshness(source: TurnContractSource): TurnContractFreshness {
  return {
    conversation_id: source.conversation.conversation_id,
    conversation_revision: source.conversation.revision,
    conversation_head_sha256: source.conversation.head_sha256,
    flow_revision: source.control_plane.flow?.revision ?? null,
    flow_state_sha256: source.control_plane.flow?.state_sha256 ?? null,
    mission_revision: source.control_plane.mission?.revision ?? null,
    mission_state_sha256: source.control_plane.mission?.state_sha256 ?? null,
    capability_epoch: source.capability_epoch,
    public_identifier_registry_sha256: source.public_identifier_registry_sha256,
  };
}

function expectation(contract: ProductionTurnContract) {
  return {
    conversation_id: contract.conversation.conversation_id,
    conversation_revision: contract.conversation.revision,
    conversation_head_sha256: contract.conversation.head_sha256,
    flow_revision: contract.control_plane.flow?.revision ?? null,
    flow_state_sha256: contract.control_plane.flow?.state_sha256 ?? null,
    mission_revision: contract.control_plane.mission?.revision ?? null,
    mission_state_sha256: contract.control_plane.mission?.state_sha256 ?? null,
    capability_epoch: contract.capability_epoch,
    public_identifier_registry_sha256: contract.public_identifier_registry_sha256,
    expected_contract_sha256: contract.contract_sha256,
  };
}

function assertSourceBoundToProgram(
  source: TurnContractSource,
  projection: ConversationProgramProjection,
): void {
  if (source.conversation.conversation_id !== projection.programId ||
      source.conversation.revision !== projection.revision ||
      source.conversation.head_sha256 !== projection.headSha256 ||
      source.capability_epoch !== projection.capabilityEpoch) {
    throw new HaccRuntimeCoordinatorErrorV2(
      "runtime_corrupt",
      "turn-contract projector changed conversation or capability authority",
    );
  }
  const checkpoint = projection.focusedGoal
    ? projection.flowCheckpoints.find(({ goalId }) => goalId === projection.focusedGoal!.goalId)
    : undefined;
  if (checkpoint && checkpoint.capabilityEpoch === projection.capabilityEpoch && source.control_plane.flow && (
    source.control_plane.flow.revision !== checkpoint.flowRevision ||
    source.control_plane.flow.capability_epoch !== checkpoint.capabilityEpoch ||
    source.control_plane.flow.state_sha256 !== checkpoint.stateSha256
  )) {
    throw new HaccRuntimeCoordinatorErrorV2("runtime_corrupt", "turn-contract flow authority is not the committed checkpoint");
  }
}

function programBinding(projection: ConversationProgramProjection) {
  return Object.freeze({
    stateHeadSha256: projection.headSha256,
    stateRevision: projection.revision,
    capabilityEpoch: projection.capabilityEpoch,
  });
}

function programReceiptId(receiptId: string): string {
  return `effect.${digest("hacc/runtime-v2/effect-receipt/v1", receiptId).slice(0, 40)}`;
}

function eventEvidenceSha(event: AudibilityLedgerEvent): string {
  return event.evidence.sha256;
}

type PendingEvidence = Readonly<{
  type: Parameters<HaccRuntimeDependenciesV2["evidenceTap"]["append"]>[0];
  payload: Record<string, unknown>;
}>;

/**
 * Provider-neutral production coordinator. Provider transports can propose
 * events, actions, and audio ranges, but this host-retained coordinator is the
 * sole component that advances durable state or admits an external effect.
 */
export class HaccRuntimeCoordinatorV2 {
  readonly #deps: HaccRuntimeDependenciesV2;
  readonly #effects: GovernedEffectCoordinator;
  readonly #now: () => string;

  constructor(dependencies: HaccRuntimeDependenciesV2) {
    this.#deps = dependencies;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#effects = new GovernedEffectCoordinator({
      store: dependencies.effectStore,
      adapters: dependencies.effectAdapters,
      now: this.#now,
    });
  }

  async initialize(input: Readonly<{
    programId: string;
    program?: ConversationProgramLog;
    audibility?: AudibilityLedger;
  }>): Promise<HaccRuntimeSnapshotV2> {
    const program = input.program ?? createConversationProgramLog(input.programId);
    const audibility = input.audibility ?? createAudibilityLedger(input.programId);
    if (program.programId !== input.programId || audibility.sessionId !== input.programId) {
      throw new HaccRuntimeCoordinatorErrorV2("runtime_corrupt", "initial authorities belong to different conversations");
    }
    const snapshot = this.#compile(0, program, audibility);
    if (await this.#deps.store.create(snapshot) !== "created") {
      throw new HaccRuntimeCoordinatorErrorV2("runtime_exists", `runtime ${input.programId} already exists`);
    }
    await this.#deps.onCommit?.onCommitted(snapshot);
    this.#appendPlanEvidence(snapshot);
    return snapshot;
  }

  async resume(programId: string): Promise<HaccRuntimeSnapshotV2> {
    const snapshot = await this.#deps.store.read(programId);
    if (!snapshot) throw new HaccRuntimeCoordinatorErrorV2("runtime_not_found", `runtime ${programId} does not exist`);
    return this.#verify(snapshot);
  }

  async recordProgramEvent(programId: string, request: ProgramEventRequestV2): Promise<HaccRuntimeSnapshotV2> {
    let evidence: PendingEvidence[] = [];
    const snapshot = await this.#deps.store.transact(programId, async (currentInput) => {
      const current = this.#verify(currentInput);
      this.#assertContract(current, request);
      const projection = foldConversationProgram(current.program);
      const draft: ConversationProgramEventDraft = {
        eventId: request.eventId,
        expectedRevision: projection.revision,
        occurredAt: request.occurredAt ?? this.#now(),
        payload: request.payload,
      };
      const program = appendConversationProgramEvent(current.program, draft);
      const next = this.#compile(current.runtimeRevision + 1, program, current.audibility);
      evidence = this.#programEvidence(request.payload, next);
      return { next, value: next };
    });
    await this.#committed(snapshot, evidence);
    return snapshot;
  }

  async executeEffect(programId: string, request: EffectRequestV2): Promise<HaccRuntimeEffectResultV2> {
    let evidence: PendingEvidence[] = [];
    const value = await this.#deps.store.transact(programId, async (currentInput) => {
      const current = this.#verify(currentInput);
      this.#assertContract(current, request);
      const projection = foldConversationProgram(current.program);
      if (!projection.focusedGoal || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(request.attemptId)) {
        throw new HaccRuntimeCoordinatorErrorV2(
          "capability_denied",
          "effects require a focused goal and a durable safe attempt identity",
        );
      }
      const action = current.contract.eligible_actions.find(({ action_id }) => action_id === request.action);
      if (!action) {
        throw new HaccRuntimeCoordinatorErrorV2("capability_denied", `action ${request.action} is outside the current contract`);
      }
      const result = await this.#effects.execute({
        scope: { subjectId: programId },
        action: request.action,
        arguments: request.arguments,
        idempotencyKey: request.idempotencyKey,
        expectedAuthority: programBinding(projection),
        ...(request.confirmation ? { confirmation: request.confirmation } : {}),
      });
      let program = current.program;
      if ("receipt" in result && result.receipt) {
        program = this.#projectEffectResult(program, projection, request, result.receipt);
      }
      const next = this.#compile(current.runtimeRevision + 1, program, current.audibility);
      evidence = this.#effectEvidence(request, result, next);
      return {
        next,
        value: {
          snapshot: next,
          disposition: result.disposition,
          receiptId: "receipt" in result ? result.receipt?.receiptId ?? null : null,
          reconciliationJobId: "reconciliationJob" in result ? result.reconciliationJob.jobId : null,
        } satisfies HaccRuntimeEffectResultV2,
      };
    });
    await this.#committed(value.snapshot, evidence);
    return value;
  }

  async runReconciliation(
    programId: string,
    request: ReconciliationRequestV2,
  ): Promise<HaccRuntimeReconciliationResultV2> {
    let evidence: PendingEvidence[] = [];
    const value = await this.#deps.store.transact(programId, async (currentInput) => {
      const current = this.#verify(currentInput);
      this.#assertContract(current, request);
      const result = await this.#effects.runReconciliation(request.jobId);
      let program = current.program;
      if (["committed", "absent", "unknown"].includes(result.disposition)) {
        const projection = foldConversationProgram(program);
        const payload: ConversationProgramEventPayload = {
          type: "fact.asserted",
          key: `reconciliation.${digest("hacc/runtime-v2/reconciliation-key/v1", request.jobId).slice(0, 32)}`,
          value: {
            disposition: result.disposition,
            receipt_sha256: digest("hacc/runtime-v2/reconciled-receipt/v1", result.receipt),
          },
          authority: {
            kind: "tool",
            evidenceSha256: result.receipt.proofSha256 ?? digest("hacc/runtime-v2/reconciliation-evidence/v1", result),
          },
        };
        program = appendConversationProgramEvent(program, {
          eventId: request.eventId,
          expectedRevision: projection.revision,
          occurredAt: this.#now(),
          payload,
        });
      }
      const next = this.#compile(current.runtimeRevision + 1, program, current.audibility);
      evidence = [this.#reconciliationEvidence(result, next)];
      return {
        next,
        value: {
          snapshot: next,
          disposition: result.disposition,
          receiptId: result.receipt.receiptId,
        } satisfies HaccRuntimeReconciliationResultV2,
      };
    });
    await this.#committed(value.snapshot, evidence);
    return value;
  }

  async recordAudibilityEvent(
    programId: string,
    request: AudibilityEventRequestV2,
  ): Promise<HaccRuntimeSnapshotV2> {
    let evidence: PendingEvidence[] = [];
    const snapshot = await this.#deps.store.transact(programId, async (currentInput) => {
      const current = this.#verify(currentInput);
      this.#assertContract(current, request);
      const event = {
        ...request.event,
        sequence: current.audibility.revision + 1,
        sessionId: current.audibility.sessionId,
      } as AudibilityLedgerEvent;
      this.#assertClaimAuthority(current, event);
      const applied = applyAudibilityLedgerEvent(current.audibility, event);
      if (!applied.ok) {
        throw new HaccRuntimeCoordinatorErrorV2("audibility_rejected", `${applied.code}: ${applied.error}`);
      }
      const program = this.#projectAudibilityEvent(current.program, current.audibility, applied.state, event);
      const next = this.#compile(current.runtimeRevision + 1, program, applied.state);
      evidence = this.#audibilityEvidence(event, applied.state);
      return { next, value: next };
    });
    await this.#committed(snapshot, evidence);
    return snapshot;
  }

  async prepareClaimGrant(
    programId: string,
    request: ClaimGrantPreparationRequestV2,
  ): Promise<PreparedClaimGrantV2> {
    const current = await this.resume(programId);
    this.#assertContract(current, request);
    const claim = current.audibility.responses[request.responseId]?.claims[request.claimId];
    const receipt = current.contract.receipts.find(({ receipt_id }) => receipt_id === request.receiptId);
    if (!claim || !receipt || receipt.status !== "succeeded" ||
        receipt.outcome_status !== "satisfied" || receipt.capability_epoch !== current.contract.capability_epoch) {
      throw new HaccRuntimeCoordinatorErrorV2("claim_authority_stale", "claim or succeeded effect authority is unavailable");
    }
    const reopenedReceiptSha256 = digest("hacc/runtime-v2/reopened-contract-receipt/v1", receipt);
    const semanticBindingSha256 = digest("hacc/runtime-v2/claim-semantic-binding/v1", {
      claim_content_sha256: claim.contentSha256,
      action_semantic_sha256: receipt.action_semantic_sha256,
      outcome_predicate_sha256: receipt.outcome_predicate_sha256,
      outcome_status: receipt.outcome_status,
    });
    const authorityInput = {
      responseId: request.responseId,
      claimId: request.claimId,
      claimContentSha256: claim.contentSha256,
      authorityRevision: current.program.events.length,
      authorityReceiptSha256: receipt.receipt_sha256,
      reopenedReceiptSha256,
      turnContractSha256: current.contract.contract_sha256,
      semanticBindingSha256,
    };
    const authority = reopenVerifiedClaimGrantAuthority(authorityInput, {
      verifyReopenedReceiptAndTurnContract(input) {
        const hostVerificationSha256 = digest("hacc/runtime-v2/claim-grant-verification/v1", input);
        return { ok: true, verifierId: "hacc.runtime.v2", hostVerificationSha256 };
      },
    });
    return Object.freeze({ authority, evidenceSha256: receipt.receipt_sha256 });
  }

  async recordProviderEvent(
    programId: string,
    request: ProviderEventRequestV2,
  ): Promise<HaccRuntimeSnapshotV2> {
    let evidence: PendingEvidence[] = [];
    const snapshot = await this.#deps.store.transact(programId, async (currentInput) => {
      const current = this.#verify(currentInput);
      this.#assertContract(current, request);
      const next = this.#compile(current.runtimeRevision + 1, current.program, current.audibility);
      evidence = [{ type: "provider.normalized", payload: request.event as unknown as Record<string, unknown> }];
      return { next, value: next };
    });
    await this.#committed(snapshot, evidence);
    return snapshot;
  }

  #compile(
    runtimeRevision: number,
    program: ConversationProgramLog,
    audibility: AudibilityLedger,
  ): HaccRuntimeSnapshotV2 {
    const projection = foldConversationProgram(program);
    const source = this.#deps.contractProjector.project({ program: projection, audibility });
    assertSourceBoundToProgram(source, projection);
    const contract = createProductionTurnContract(source, freshness(source));
    return freezeDeep({
      schemaVersion: HACC_RUNTIME_COORDINATOR_V2_SCHEMA_VERSION,
      runtimeRevision,
      program,
      audibility,
      contract,
    });
  }

  #verify(snapshot: HaccRuntimeSnapshotV2): HaccRuntimeSnapshotV2 {
    if (snapshot.schemaVersion !== HACC_RUNTIME_COORDINATOR_V2_SCHEMA_VERSION ||
        snapshot.program.programId !== snapshot.audibility.sessionId) {
      throw new HaccRuntimeCoordinatorErrorV2("runtime_corrupt", "runtime authority identities disagree");
    }
    try {
      assertProductionTurnContract(snapshot.contract, expectation(snapshot.contract));
      const rebuilt = this.#compile(snapshot.runtimeRevision, snapshot.program, snapshot.audibility);
      if (rebuilt.contract.contract_sha256 !== snapshot.contract.contract_sha256) {
        throw new Error("host-retained contract does not match replayed authority");
      }
    } catch (error) {
      throw new HaccRuntimeCoordinatorErrorV2(
        "runtime_corrupt",
        error instanceof Error ? error.message : "runtime replay failed",
      );
    }
    return snapshot;
  }

  #assertContract(snapshot: HaccRuntimeSnapshotV2, request: ContractBoundRequestV2): void {
    if (!SHA256.test(request.expectedContractSha256) ||
        request.expectedContractSha256 !== snapshot.contract.contract_sha256) {
      throw new HaccRuntimeCoordinatorErrorV2("contract_stale", "request is not bound to the current host contract");
    }
    assertProductionTurnContract(snapshot.contract, expectation(snapshot.contract));
  }

  #projectEffectResult(
    program: ConversationProgramLog,
    before: ConversationProgramProjection,
    request: EffectRequestV2,
    receipt: GovernedEffectReceipt,
  ): ConversationProgramLog {
    const existingReservation = before.actionReservations.find(({ reservationId }) => reservationId === request.attemptId);
    const existingReceipt = before.actionReceipts.find(({ receiptId }) => receiptId === programReceiptId(receipt.receiptId));
    const drafts: ConversationProgramEventDraft[] = [];
    let revision = before.revision;
    if (!existingReservation) {
      drafts.push({
        eventId: `reserve.${request.attemptId}`,
        expectedRevision: revision++,
        occurredAt: receipt.dispatchStartedAt ?? this.#now(),
        payload: {
          type: "action.reserved",
          reservationId: request.attemptId,
          goalId: before.focusedGoal!.goalId,
          action: request.action,
          argumentsSha256: receipt.argumentsSha256,
          idempotencyKey: request.idempotencyKey,
          capabilityEpoch: before.capabilityEpoch,
          authorityRevision: before.revision,
        },
      });
    } else if (existingReservation.action !== request.action ||
        existingReservation.argumentsSha256 !== receipt.argumentsSha256 ||
        existingReservation.idempotencyKey !== request.idempotencyKey) {
      throw new HaccRuntimeCoordinatorErrorV2("runtime_corrupt", "effect replay conflicts with its program reservation");
    }
    if (!existingReceipt && ["succeeded", "failed", "indeterminate"].includes(receipt.status)) {
      drafts.push({
        eventId: `settle.${digest("hacc/runtime-v2/settle-event/v1", receipt.receiptId).slice(0, 32)}`,
        expectedRevision: revision,
        occurredAt: receipt.settledAt ?? this.#now(),
        payload: {
          type: "action.receipt_recorded",
          receiptId: programReceiptId(receipt.receiptId),
          reservationId: request.attemptId,
          status: receipt.status as "succeeded" | "failed" | "indeterminate",
          resultSha256: receipt.status === "succeeded"
            ? receipt.resultSha256 ?? digest("hacc/runtime-v2/missing-result/v1", receipt)
            : null,
          evidenceSha256: receipt.proofSha256 ?? digest("hacc/runtime-v2/effect-receipt-evidence/v1", receipt),
        },
      });
    }
    return drafts.length > 0 ? appendConversationProgramEvents(program, drafts) : program;
  }

  #assertClaimAuthority(snapshot: HaccRuntimeSnapshotV2, event: AudibilityLedgerEvent): void {
    if (event.type === "claim_grant_issued") {
      if (event.authority.authorityRevision !== snapshot.program.events.length ||
          event.authority.turnContractSha256 !== snapshot.contract.contract_sha256 ||
          event.authority.responseId !== event.responseId ||
          snapshot.audibility.responses[event.responseId]?.claims[event.authority.claimId]?.contentSha256 !==
            event.authority.claimContentSha256 ||
          !snapshot.contract.receipts.some((receipt) =>
            receipt.status === "succeeded" && receipt.outcome_status === "satisfied" &&
            receipt.receipt_sha256 === event.authority.authorityReceiptSha256)) {
        throw new HaccRuntimeCoordinatorErrorV2(
          "claim_authority_stale",
          "terminal claim grant is not bound to a current succeeded receipt",
        );
      }
    }
    if (event.type === "release_requested") {
      const response = snapshot.audibility.responses[event.responseId];
      for (const grantId of event.claimGrantIds) {
        const grant = response?.grants[grantId];
        if (!grant || grant.authorityRevision !== snapshot.program.events.length ||
            grant.turnContractSha256 !== snapshot.contract.contract_sha256 ||
            !snapshot.contract.receipts.some((receipt) =>
              receipt.status === "succeeded" && receipt.outcome_status === "satisfied" &&
              receipt.receipt_sha256 === grant.authorityReceiptSha256)) {
          throw new HaccRuntimeCoordinatorErrorV2(
            "claim_authority_stale",
            "speech release references a stale or unsupported terminal claim grant",
          );
        }
      }
    }
  }

  #projectAudibilityEvent(
    program: ConversationProgramLog,
    before: AudibilityLedger,
    after: AudibilityLedger,
    event: AudibilityLedgerEvent,
  ): ConversationProgramLog {
    const projection = foldConversationProgram(program);
    const prior = projection.audibilityFacts.find(({ responseId }) => responseId === event.responseId);
    let payload: ConversationProgramEventPayload | null = null;
    if (event.type === "generation_closed" && !prior) {
      const response = after.responses[event.responseId];
      payload = {
        type: "audibility.response_registered",
        responseId: event.responseId,
        generatedThroughMs: Math.max(1, Math.ceil(response.generatedSampleCount * 1_000 / response.sampleRateHz)),
        contentSha256: digest("hacc/runtime-v2/response-pcm/v1", response.chunks.map(({ pcmSha256 }) => pcmSha256)),
        evidenceSha256: eventEvidenceSha(event),
      };
    } else if (event.type === "release_requested") {
      const decision = after.responses[event.responseId].releaseDecisions.at(-1);
      if (decision?.outcome === "released") {
        const response = after.responses[event.responseId];
        const throughMs = Math.ceil(event.range.endSample * 1_000 / response.sampleRateHz);
        if (!prior || throughMs > prior.releasedThroughMs) {
          payload = { type: "audibility.released_through", responseId: event.responseId, throughMs, evidenceSha256: eventEvidenceSha(event) };
        }
      }
    } else if (event.type === "playback_acknowledged") {
      const response = after.responses[event.responseId];
      const throughMs = Math.ceil(Math.max(...event.ranges.map(({ endSample }) => endSample)) * 1_000 / response.sampleRateHz);
      if (!prior || throughMs > prior.heardThroughMs) {
        payload = { type: "audibility.heard_through", responseId: event.responseId, throughMs, evidenceSha256: eventEvidenceSha(event) };
      }
    } else if (event.type === "playback_cleared" && !prior?.interrupted) {
      const response = before.responses[event.responseId];
      const heardThroughSamples = Math.max(0, ...response.acknowledgedPlayedRanges.map(({ endSample }) => endSample));
      payload = {
        type: "audibility.interrupted",
        responseId: event.responseId,
        heardThroughMs: Math.ceil(heardThroughSamples * 1_000 / response.sampleRateHz),
        reason: event.reason,
        evidenceSha256: eventEvidenceSha(event),
      };
    }
    if (!payload) return program;
    return appendConversationProgramEvent(program, {
      eventId: `audible.${event.eventId}`,
      expectedRevision: projection.revision,
      occurredAt: this.#now(),
      payload,
    });
  }

  #programEvidence(payload: ConversationProgramEventPayload, snapshot: HaccRuntimeSnapshotV2): PendingEvidence[] {
    if (payload.type === "fact.corrected") {
      return [{
        type: "world.event",
        payload: {
          world_event_id: `correction.${snapshot.program.events.length}`,
          kind: "correction.applied",
          required_step_id: null,
          obligation_id: null,
          correction_id: payload.key,
          authorized_attempt_id: null,
          semantic_effect_id: null,
          world_revision: snapshot.program.events.length,
          world_state_sha256: foldConversationProgram(snapshot.program).headSha256,
        },
      }];
    }
    if (payload.type === "worker.spawned" || payload.type === "worker.delivery_recorded" || payload.type === "worker.cancelled") {
      const workerId = payload.workerId;
      const delivery = payload.type === "worker.delivery_recorded"
        ? foldConversationProgram(snapshot.program).workerDeliveries.find(({ deliveryId }) => deliveryId === payload.deliveryId)
        : undefined;
      const kind = payload.type === "worker.spawned" ? "spawned"
        : payload.type === "worker.cancelled" ? "cancelled"
          : delivery?.disposition === "accepted"
            ? "result_accepted" : "result_rejected_stale";
      return [{
        type: "worker.event",
        payload: {
          worker_event_id: `${kind}.${snapshot.program.events.length}`,
          worker_id: workerId,
          parent_worker_id: null,
          call_id: snapshot.program.programId,
          plan_revision: Math.max(1, snapshot.contract.conversation.revision),
          kind,
          result_sha256: payload.type === "worker.delivery_recorded" ? payload.resultSha256 : null,
        },
      }];
    }
    return [];
  }

  #effectEvidence(
    request: EffectRequestV2,
    result: GovernedEffectExecutionResult,
    snapshot: HaccRuntimeSnapshotV2,
  ): PendingEvidence[] {
    const events: PendingEvidence[] = [{
      type: "action.attempted",
      payload: {
        attempt_id: request.attemptId,
        action_id: request.action,
        capability_id: request.action,
        plan_revision: Math.max(1, snapshot.contract.conversation.revision),
        arguments_sha256: "receipt" in result && result.receipt
          ? result.receipt.argumentsSha256
          : digest("hacc/runtime-v2/effect-arguments/v1", request.arguments),
      },
    }];
    const decision = "decision" in result ? result.decision : null;
    const receipt = "receipt" in result ? result.receipt : null;
    events.push({
      type: "action.policy_decided",
      payload: {
        attempt_id: request.attemptId,
        decision: result.disposition === "denied" || result.disposition === "confirmation_required" ? "deny" : "allow",
        policy_sha256: decision?.policy_digest ?? receipt?.policyDigest ?? digest("hacc/runtime-v2/no-policy/v1", request.action),
        reason_code: decision?.reason ?? result.disposition,
      },
    });
    if (receipt && ["succeeded", "failed", "indeterminate"].includes(receipt.status)) {
      events.push({
        type: "action.receipt",
        payload: {
          attempt_id: request.attemptId,
          receipt_id: programReceiptId(receipt.receiptId),
          status: receipt.status === "succeeded" ? "committed"
            : receipt.status === "indeterminate" ? "indeterminate" : "rejected",
          semantic_effect_id: receipt.status === "succeeded" ? `effect.${request.attemptId}` : null,
          result_sha256: receipt.resultSha256 ?? receipt.proofSha256 ?? digest("hacc/runtime-v2/effect-terminal/v1", receipt),
          world_revision: snapshot.program.events.length,
        },
      });
    }
    return events;
  }

  #reconciliationEvidence(result: ReconciliationRunResult, snapshot: HaccRuntimeSnapshotV2): PendingEvidence {
    return {
      type: "action.receipt",
      payload: {
        attempt_id: `reconcile.${digest("hacc/runtime-v2/reconcile-attempt/v1", result.job.jobId).slice(0, 24)}`,
        receipt_id: programReceiptId(result.receipt.receiptId),
        status: result.disposition === "committed" || result.disposition === "absent" ? "reconciled" : "indeterminate",
        semantic_effect_id: result.disposition === "committed" ? `effect.reconciled.${result.job.receiptId}` : null,
        result_sha256: result.receipt.resultSha256 ?? result.receipt.proofSha256 ?? digest("hacc/runtime-v2/reconcile-result/v1", result),
        world_revision: snapshot.program.events.length,
      },
    };
  }

  #audibilityEvidence(event: AudibilityLedgerEvent, ledger: AudibilityLedger): PendingEvidence[] {
    const response = ledger.responses[event.responseId];
    if (event.type === "pcm_chunk_generated") {
      const chunk = response.chunks.at(-1)!;
      return [{
        type: "audio.range",
        payload: {
          response_id: event.responseId,
          audio_sha256: event.pcmSha256,
          byte_length: event.sampleCount * response.channels * 2,
          sample_rate_hz: response.sampleRateHz,
          channel_count: response.channels,
          start_sample: chunk.range.startSample,
          end_sample: chunk.range.endSample,
          claim_ids: [],
          opportunity_ids: [],
          semantic_alignment_sha256: event.evidence.sha256,
        },
      }];
    }
    if (event.type === "release_requested") {
      const decision = response.releaseDecisions.at(-1);
      if (decision?.outcome !== "released") return [];
      return [{
        type: "playback.range",
        payload: {
          playback_event_id: event.decisionId,
          response_id: event.responseId,
          start_sample: event.range.startSample,
          end_sample: event.range.endSample,
          status: "released",
        },
      }];
    }
    if (event.type === "playback_acknowledged") {
      return event.ranges.map((range, index) => ({
        type: "playback.range" as const,
        payload: {
          playback_event_id: `${event.acknowledgementId}.${index}`,
          response_id: event.responseId,
          start_sample: range.startSample,
          end_sample: range.endSample,
          status: "heard",
        },
      }));
    }
    if (event.type === "playback_cleared") {
      const clear = response.clears.at(-1);
      return (clear?.clearedRanges ?? []).map((range, index) => ({
        type: "playback.range" as const,
        payload: {
          playback_event_id: `${event.clearId}.${index}`,
          response_id: event.responseId,
          start_sample: range.startSample,
          end_sample: range.endSample,
          status: "interrupted",
        },
      }));
    }
    return [];
  }

  #appendPlanEvidence(snapshot: HaccRuntimeSnapshotV2): void {
    this.#deps.evidenceTap.append("plan.registered", {
      plan_id: `contract.${snapshot.runtimeRevision}`,
      revision: Math.max(1, snapshot.runtimeRevision + 1),
      plan_sha256: snapshot.contract.contract_sha256,
      required_step_ids: snapshot.contract.required_slots.map(({ slot_id }) => slot_id),
      required_obligation_ids: foldConversationProgram(snapshot.program).obligations
        .filter(({ status }) => status === "open").map(({ obligationId }) => obligationId),
      forbidden_claim_ids: snapshot.contract.prohibited_claims.map(({ claim_id }) => claim_id),
    }, this.#now());
  }

  async #committed(snapshot: HaccRuntimeSnapshotV2, evidence: readonly PendingEvidence[]): Promise<void> {
    await this.#deps.onCommit?.onCommitted(snapshot);
    this.#appendPlanEvidence(snapshot);
    for (const event of evidence) {
      this.#deps.evidenceTap.append(event.type as never, event.payload as never, this.#now());
    }
  }
}

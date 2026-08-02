import { createPrivateKey } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  applyAudibilityLedgerEvent,
  createAudibilityLedger,
  projectAudibleConversationEvidence,
  type AudibilityLedger,
  type AudibilityLedgerEvent,
} from "../../../audibility-v2";
import {
  appendConversationProgramEvents,
  canonicalProgramJson,
  conversationProgramDigest,
  createConversationProgramLog,
  foldConversationProgram,
  type ConversationProgramEventDraft,
} from "../../../conversation-program";
import {
  canonicalEvidenceJsonV2,
  createEd25519EvidenceSignerV2,
  evidenceSha256HexV2,
  EvidenceTapV2,
  frozenEvidenceEvaluationContractSha256V2,
  replayEvidenceBundleV2,
  type EvidenceArtifactDescriptorV2,
  type FrozenEvidenceEvaluationContractV2,
} from "../../../evidence-v2";
import {
  GovernedEffectCoordinator,
  type EffectDispatchOutcome,
  type EffectReconciliationOutcome,
  type GovernedEffectAdapter,
  type GovernedEffectExecutionResult,
  type GovernedEffectProposal,
} from "../../../governed-effect-runtime";
import {
  assertProductionTurnContract,
  createProductionTurnContract,
  runtimeControlSha256,
  type TurnContractFreshness,
  type TurnContractSource,
} from "../../../runtime-control";
import { canonicalStressJson, stressSha256 } from "./canonical";
import {
  authorityBinding,
  DeterministicEffectStore,
  STRESS_SCOPE,
} from "./effect-store";
import {
  HACC_OFFLINE_STRESS_SCHEMA_VERSION,
  type OfflineStressConfig,
  type OfflineStressReport,
  type StressPhaseTiming,
} from "./types";

const HASH = /^[a-f0-9]{64}$/;
const H = (character: string): string => character.repeat(64);
const NOW = "2026-08-02T18:00:00.000Z";
const DEFAULT_SOURCE_SHA256 = stressSha256("hacc/offline-stress/source/unregistered/v1", "unregistered-source");

type MutableProposalCounts = {
  total: number;
  allowed: number;
  denied_forged: number;
  rejected_stale: number;
  terminal_replays: number;
  unauthorized_effects: number;
  stale_dispatches: number;
  duplicate_effects: number;
};

type MutableRaceCounts = {
  total: number;
  normal_settlements: number;
  stale_before_dispatch: number;
  indeterminate_reconciled: number;
  idempotency_conflicts: number;
  dispatches: number;
  duplicate_effects: number;
  stale_dispatches: number;
  blind_retries: number;
};

type MutableReplayCounts = {
  total: number;
  exact_replays: number;
  reconnect_recoveries: number;
  corrections_applied: number;
  stale_worker_deliveries_rejected: number;
  forbidden_claim_release_attempts: number;
  forbidden_claims_released: number;
  replay_mismatches: number;
};

function assertConfig(input: OfflineStressConfig): OfflineStressConfig {
  for (const [key, value] of Object.entries({
    proposalCount: input.proposalCount,
    raceScheduleCount: input.raceScheduleCount,
    replayScheduleCount: input.replayScheduleCount,
    seedStart: input.seedStart,
  })) {
    if (!Number.isSafeInteger(value) || value < (key === "seedStart" ? 0 : 1)) {
      throw new Error(`${key} must be a ${key === "seedStart" ? "non-negative" : "positive"} safe integer`);
    }
  }
  if (!HASH.test(input.sourceSha256)) throw new Error("sourceSha256 must be a lowercase SHA-256 digest");
  const seedEnd = input.seedStart + input.proposalCount + input.raceScheduleCount + input.replayScheduleCount - 1;
  if (!Number.isSafeInteger(seedEnd)) throw new Error("stress seed range exceeds safe integer bounds");
  return Object.freeze({ ...input });
}

function timing(startedAt: number, operations: number): StressPhaseTiming {
  const wallMs = Math.max(0, performance.now() - startedAt);
  return Object.freeze({
    wall_ms: Number(wallMs.toFixed(3)),
    operations_per_second: wallMs === 0 ? operations : Number((operations * 1_000 / wallMs).toFixed(3)),
  });
}

function successfulAdapter(mode: "completed" | "indeterminate" = "completed"): GovernedEffectAdapter {
  return Object.freeze({
    action: "stress.write",
    reconciliationEffect: "read" as const,
    async dispatch(input: Parameters<GovernedEffectAdapter["dispatch"]>[0]): Promise<EffectDispatchOutcome> {
      if (mode === "indeterminate") return { disposition: "indeterminate", errorCode: "injected_transport_cut" };
      return {
        disposition: "completed",
        result: Object.freeze({ status: "applied", effect_id: `effect-${input.idempotencyKey}` }),
      };
    },
    async reconcile(): Promise<EffectReconciliationOutcome> {
      return { disposition: "committed", proofSha256: H("e"), result: Object.freeze({ status: "applied" }) };
    },
  });
}

function proposal(input: Readonly<{
  seed: number;
  action?: string;
  key?: string;
  stale?: boolean;
  postalCode?: string;
}>): GovernedEffectProposal {
  const expected = authorityBinding();
  return Object.freeze({
    scope: STRESS_SCOPE,
    action: input.action ?? "stress.write",
    arguments: Object.freeze({ postal_code: input.postalCode ?? `${90_000 + input.seed}`, seed: input.seed }),
    idempotencyKey: input.key ?? `proposal-${input.seed}`,
    expectedAuthority: input.stale
      ? Object.freeze({ ...expected, capabilityEpoch: expected.capabilityEpoch + 1 })
      : expected,
  });
}

async function runProposalStress(config: OfflineStressConfig): Promise<Readonly<{
  counts: MutableProposalCounts;
  timing: StressPhaseTiming;
}>> {
  const startedAt = performance.now();
  const store = new DeterministicEffectStore();
  let dispatchCalls = 0;
  const base = successfulAdapter();
  const adapter: GovernedEffectAdapter = Object.freeze({
    ...base,
    async dispatch(input: Parameters<GovernedEffectAdapter["dispatch"]>[0]) {
      dispatchCalls += 1;
      return base.dispatch(input);
    },
  });
  const coordinator = new GovernedEffectCoordinator({ store, adapters: [adapter], now: () => NOW });
  const counts: MutableProposalCounts = {
    total: config.proposalCount,
    allowed: 0,
    denied_forged: 0,
    rejected_stale: 0,
    terminal_replays: 0,
    unauthorized_effects: 0,
    stale_dispatches: 0,
    duplicate_effects: 0,
  };
  const successfulKeys: string[] = [];
  for (let offset = 0; offset < config.proposalCount; offset += 1) {
    const seed = config.seedStart + offset;
    const kind = offset % 4;
    let result: GovernedEffectExecutionResult;
    if (kind === 0) {
      result = await coordinator.execute(proposal({ seed, action: "forged.admin.write" }));
      if (result.disposition === "denied") counts.denied_forged += 1;
      else counts.unauthorized_effects += 1;
    } else if (kind === 1) {
      const before = dispatchCalls;
      result = await coordinator.execute(proposal({ seed, stale: true }));
      if (result.disposition === "stale_authority") counts.rejected_stale += 1;
      else counts.unauthorized_effects += 1;
      if (dispatchCalls !== before) counts.stale_dispatches += 1;
    } else if (kind === 2 || successfulKeys.length === 0) {
      const key = `allowed-${seed}`;
      result = await coordinator.execute(proposal({ seed, key }));
      if (result.disposition === "succeeded") {
        counts.allowed += 1;
        successfulKeys.push(key);
      } else counts.unauthorized_effects += 1;
    } else {
      const replayKey = successfulKeys.at(-1)!;
      const originalSeed = seed - 1;
      const before = dispatchCalls;
      result = await coordinator.execute(proposal({ seed: originalSeed, key: replayKey }));
      if (result.disposition === "succeeded" && dispatchCalls === before) counts.terminal_replays += 1;
      else counts.duplicate_effects += 1;
    }
  }
  if (dispatchCalls !== counts.allowed) counts.duplicate_effects += Math.abs(dispatchCalls - counts.allowed);
  return Object.freeze({ counts, timing: timing(startedAt, config.proposalCount) });
}

async function runRaceStress(config: OfflineStressConfig): Promise<Readonly<{
  counts: MutableRaceCounts;
  timing: StressPhaseTiming;
}>> {
  const startedAt = performance.now();
  const counts: MutableRaceCounts = {
    total: config.raceScheduleCount,
    normal_settlements: 0,
    stale_before_dispatch: 0,
    indeterminate_reconciled: 0,
    idempotency_conflicts: 0,
    dispatches: 0,
    duplicate_effects: 0,
    stale_dispatches: 0,
    blind_retries: 0,
  };
  const seedBase = config.seedStart + config.proposalCount;
  for (let offset = 0; offset < config.raceScheduleCount; offset += 1) {
    const seed = seedBase + offset;
    const variant = offset % 4;
    const store = new DeterministicEffectStore();
    if (variant === 1) store.boundaryStale = true;
    let adapterDispatches = 0;
    const base = successfulAdapter(variant === 2 ? "indeterminate" : "completed");
    const adapter: GovernedEffectAdapter = Object.freeze({
      ...base,
      async dispatch(input: Parameters<GovernedEffectAdapter["dispatch"]>[0]) {
        adapterDispatches += 1;
        return base.dispatch(input);
      },
    });
    const coordinator = new GovernedEffectCoordinator({ store, adapters: [adapter], now: () => NOW });
    const key = `race-${seed}`;
    const first = await coordinator.execute(proposal({ seed, key }));
    if (variant === 0) {
      const replay = await coordinator.execute(proposal({ seed, key }));
      if (first.disposition === "succeeded" && replay.disposition === "succeeded" && adapterDispatches === 1) {
        counts.normal_settlements += 1;
      } else counts.duplicate_effects += 1;
    } else if (variant === 1) {
      if (first.disposition === "stale_authority" && adapterDispatches === 0) counts.stale_before_dispatch += 1;
      else counts.stale_dispatches += 1;
    } else if (variant === 2) {
      if (first.disposition !== "indeterminate") {
        counts.blind_retries += 1;
      } else {
        const reconciled = await coordinator.runReconciliation(first.reconciliationJob.jobId);
        const second = await coordinator.runReconciliation(first.reconciliationJob.jobId);
        if (reconciled.disposition === "committed" && second.disposition === "not_claimable" && adapterDispatches === 1) {
          counts.indeterminate_reconciled += 1;
        } else counts.blind_retries += 1;
      }
    } else {
      const conflict = await coordinator.execute(proposal({ seed, key, postalCode: "different" }));
      if (first.disposition === "succeeded" && conflict.disposition === "idempotency_conflict" && adapterDispatches === 1) {
        counts.idempotency_conflicts += 1;
      } else counts.duplicate_effects += 1;
    }
    counts.dispatches += adapterDispatches;
    for (const receipt of store.receipts.values()) {
      if (receipt.dispatchAttempts > 1) counts.blind_retries += receipt.dispatchAttempts - 1;
    }
  }
  return Object.freeze({ counts, timing: timing(startedAt, config.raceScheduleCount) });
}

function eventDrafts(seed: number): readonly ConversationProgramEventDraft[] {
  const occurredAt = NOW;
  const authority = { kind: "caller" as const, evidenceSha256: H("1") };
  return [
    { eventId: `event-${seed}-goal`, expectedRevision: 0, occurredAt, payload: { type: "goal.opened", goalId: "goal.return", description: "Complete a governed return" } },
    { eventId: `event-${seed}-focus`, expectedRevision: 1, occurredAt, payload: { type: "goal.focused", goalId: "goal.return" } },
    { eventId: `event-${seed}-fact`, expectedRevision: 2, occurredAt, payload: { type: "fact.asserted", key: "address.postal", value: "94107", authority } },
    { eventId: `event-${seed}-epoch-2`, expectedRevision: 3, occurredAt, payload: { type: "capability_epoch.advanced", expectedEpoch: 1, epoch: 2, capabilities: ["stress.write"], reason: "address captured" } },
    { eventId: `event-${seed}-worker`, expectedRevision: 4, occurredAt, payload: { type: "worker.spawned", workerId: `worker-${seed}`, goalId: "goal.return", purpose: "Check eligibility", capabilityEpoch: 2, dependencies: [{ key: "address.postal", revision: 1 }], requiredForGoalCompletion: false } },
    { eventId: `event-${seed}-correction`, expectedRevision: 5, occurredAt, payload: { type: "fact.corrected", key: "address.postal", value: "10001", expectedFactRevision: 1, authority } },
    { eventId: `event-${seed}-epoch-4`, expectedRevision: 6, occurredAt, payload: { type: "capability_epoch.advanced", expectedEpoch: 3, epoch: 4, capabilities: ["stress.write"], reason: "caller correction revokes stale work" } },
    { eventId: `event-${seed}-delivery`, expectedRevision: 7, occurredAt, payload: { type: "worker.delivery_recorded", deliveryId: `delivery-${seed}`, workerId: `worker-${seed}`, goalId: "goal.return", capabilityEpoch: 2, dependencyFactRevisions: [{ key: "address.postal", revision: 1 }], resultSha256: H("2") } },
  ];
}

function contractSourceForReplay(
  projection: ReturnType<typeof foldConversationProgram>,
): Readonly<{ source: TurnContractSource; freshness: TurnContractFreshness }> {
  const stateSha256 = runtimeControlSha256("hacc/offline-stress/mission-state/v1\n", projection.headSha256);
  const source: TurnContractSource = {
    conversation: {
      conversation_id: projection.programId,
      revision: projection.revision,
      head_sha256: projection.headSha256,
    },
    public_identifier_registry_sha256: H("3"),
    control_plane: {
      mode: "mission",
      flow: null,
      mission: { revision: projection.revision, capability_epoch: projection.capabilityEpoch, state_sha256: stateSha256 },
    },
    capability_epoch: projection.capabilityEpoch,
    frontier: {
      eligible_intents: ["return.continue"],
      eligible_actions: [{
        action_id: "stress.write",
        effect: "write",
        purpose: "operation",
        policy_sha256: H("4"),
        semantic_sha256: H("5"),
      }],
    },
    required_slots: [{ slot_id: "address.postal", status: "present" }],
    claims: {
      allowed: [{
        claim_id: "return.progress",
        claim_class: "progress",
        supporting_receipt_id: null,
        supporting_action_id: null,
        required_action_semantic_sha256: null,
        required_outcome_predicate_sha256: null,
        claim_semantic_sha256: H("6"),
      }],
      prohibited: [{ claim_id: "return.complete", claim_class: "terminal_success", reason_code: "missing_receipt" }],
    },
    receipts: [],
    workers: [],
    ambiguities: [],
    lifecycle: { status: "active", refresh_required: false, preferred_response_mode: "act" },
  };
  const freshness: TurnContractFreshness = {
    conversation_id: source.conversation.conversation_id,
    conversation_revision: source.conversation.revision,
    conversation_head_sha256: source.conversation.head_sha256,
    flow_revision: null,
    flow_state_sha256: null,
    mission_revision: source.control_plane.mission!.revision,
    mission_state_sha256: source.control_plane.mission!.state_sha256,
    capability_epoch: source.capability_epoch,
    public_identifier_registry_sha256: source.public_identifier_registry_sha256,
  };
  return { source, freshness };
}

type AudibilityEventDraft<T extends AudibilityLedgerEvent["type"]> =
  Omit<Extract<AudibilityLedgerEvent, { type: T }>, "sequence" | "sessionId">;

function audibilityEvent<T extends AudibilityLedgerEvent["type"]>(
  ledger: AudibilityLedger,
  event: AudibilityEventDraft<T>,
): AudibilityLedger {
  const result = applyAudibilityLedgerEvent(ledger, {
    ...event,
    sequence: ledger.revision + 1,
    sessionId: ledger.sessionId,
  });
  if (!result.ok) throw new Error(`audibility stress event failed: ${result.code}: ${result.error}`);
  return result.state;
}

function forbiddenClaimLedger(seed: number): AudibilityLedger {
  const responseId = `response-${seed}`;
  let ledger = createAudibilityLedger(`session-${seed}`);
  ledger = audibilityEvent<"response_registered">(ledger, {
    eventId: `audio-${seed}-register`, responseId, type: "response_registered", encoding: "pcm16",
    sampleRateHz: 24_000, channels: 1, evidence: { source: "provider_output", sha256: H("7") },
  });
  ledger = audibilityEvent<"pcm_chunk_generated">(ledger, {
    eventId: `audio-${seed}-chunk`, responseId, type: "pcm_chunk_generated", chunkId: `chunk-${seed}`,
    ordinal: 0, sampleCount: 2_400, pcmSha256: H("8"), evidence: { source: "provider_output", sha256: H("8") },
  });
  ledger = audibilityEvent<"terminal_claim_registered">(ledger, {
    eventId: `audio-${seed}-claim`, responseId, type: "terminal_claim_registered", claimId: `claim-${seed}`,
    kind: "external_effect", range: { startSample: 0, endSample: 2_400 }, contentSha256: H("9"),
    evidence: { source: "semantic_alignment", sha256: H("9") },
  });
  ledger = audibilityEvent<"release_requested">(ledger, {
    eventId: `audio-${seed}-release`, responseId, type: "release_requested", decisionId: `decision-${seed}`,
    range: { startSample: 0, endSample: 2_400 }, claimGrantIds: [],
    evidence: { source: "release_controller", sha256: H("a") },
  });
  return ledger;
}

async function runReplayStress(config: OfflineStressConfig): Promise<Readonly<{
  counts: MutableReplayCounts;
  timing: StressPhaseTiming;
}>> {
  const startedAt = performance.now();
  const counts: MutableReplayCounts = {
    total: config.replayScheduleCount,
    exact_replays: 0,
    reconnect_recoveries: 0,
    corrections_applied: 0,
    stale_worker_deliveries_rejected: 0,
    forbidden_claim_release_attempts: 0,
    forbidden_claims_released: 0,
    replay_mismatches: 0,
  };
  const seedBase = config.seedStart + config.proposalCount + config.raceScheduleCount;
  for (let offset = 0; offset < config.replayScheduleCount; offset += 1) {
    const seed = seedBase + offset;
    const programId = `program-${seed}`;
    const live = appendConversationProgramEvents(createConversationProgramLog(programId), eventDrafts(seed));
    const liveProjection = foldConversationProgram(live);
    const recovered = JSON.parse(canonicalProgramJson(live));
    const recoveredProjection = foldConversationProgram(recovered);
    if (conversationProgramDigest(live) === conversationProgramDigest(recovered)
      && canonicalProgramJson(liveProjection) === canonicalProgramJson(recoveredProjection)) {
      counts.exact_replays += 1;
      counts.reconnect_recoveries += 1;
    } else counts.replay_mismatches += 1;
    if (recoveredProjection.facts.find(({ key }) => key === "address.postal")?.value === "10001") {
      counts.corrections_applied += 1;
    }
    if (recoveredProjection.workerDeliveries.at(0)?.disposition === "rejected") {
      counts.stale_worker_deliveries_rejected += 1;
    }

    const { source, freshness } = contractSourceForReplay(recoveredProjection);
    const contract = createProductionTurnContract(source, freshness);
    assertProductionTurnContract(contract, { ...freshness, expected_contract_sha256: contract.contract_sha256 });
    const ledger = forbiddenClaimLedger(seed);
    counts.forbidden_claim_release_attempts += 1;
    const projection = projectAudibleConversationEvidence(ledger);
    const decision = ledger.responses[`response-${seed}`]?.releaseDecisions[0];
    const audibleClaims = projection.responses.flatMap(({ terminalClaims }) => terminalClaims)
      .filter(({ acknowledgedRanges }) => acknowledgedRanges.length > 0);
    if (decision?.outcome === "released" || audibleClaims.length > 0) {
      counts.forbidden_claims_released += 1;
    }
  }
  return Object.freeze({ counts, timing: timing(startedAt, config.replayScheduleCount) });
}

function createEvidence(input: Readonly<{
  configDigest: string;
  sourceDigest: string;
  logicalResultDigest: string;
}>): Readonly<{
  manifestSha256: string;
  replayOk: boolean;
  useful: boolean;
  tamperRejected: boolean;
  replayErrors: readonly Readonly<{ code: string; message: string }>[];
}> {
  // This seed is an intentionally public, deterministic benchmark fixture. It
  // is materialized as PKCS#8 only in memory so publishable source never
  // contains a credential-shaped PEM block.
  const fixtureSeedHex = "6973e2aa18366d1c71e6d1775a1f9a1c3cb4bccfa03f4d8296d82c4dac498ff8";
  const privateKeyPem = createPrivateKey({
    key: Buffer.from(`302e020100300506032b657004220420${fixtureSeedHex}`, "hex"),
    format: "der",
    type: "pkcs8",
  }).export({ format: "pem", type: "pkcs8" }).toString();
  const signer = createEd25519EvidenceSignerV2({ signerId: "offline-stress-fixture", privateKeyPem });
  const artifacts = new Map<string, Uint8Array>();
  const artifact = (artifactId: string, value: unknown): EvidenceArtifactDescriptorV2 => {
    const bytes = new TextEncoder().encode(`${canonicalEvidenceJsonV2(value)}\n`);
    const sha256 = evidenceSha256HexV2(bytes);
    artifacts.set(sha256, bytes);
    return Object.freeze({ artifact_id: artifactId, sha256, byte_length: bytes.byteLength, media_type: "application/json" });
  };
  const scenarioArtifact = artifact("stress-scenario-artifact", {
    schema_version: 1, scenario_id: "stress-scenario", config_sha256: input.configDigest,
    source_sha256: input.sourceDigest, logical_result_sha256: input.logicalResultDigest,
  });
  const planArtifact = artifact("stress-plan-artifact", {
    schema_version: 1, plan_id: "stress-plan", required_steps: ["stress-step"],
    required_obligations: ["stress-obligation"], forbidden_claims: ["forbidden-completion"],
    config_sha256: input.configDigest,
    source_sha256: input.sourceDigest,
    logical_result_sha256: input.logicalResultDigest,
  });
  const catalogArtifact = artifact("stress-catalog-artifact", {
    schema_version: 1, catalog_id: "stress-catalog", capabilities: ["stress.write"],
  });
  const providerArtifact = artifact("stress-provider-artifact", { kind: "session_open", provider: "offline" });
  const argumentsArtifact = artifact("stress-arguments-artifact", { stress: true });
  const policyArtifact = artifact("stress-policy-artifact", { decision: "allow", policy: "offline-stress" });
  const resultArtifact = artifact("stress-result-artifact", { status: "applied", effect_id: "stress-effect" });
  const workerArtifact = artifact("stress-worker-result-artifact", { status: "completed" });
  const pricingArtifact = artifact("stress-pricing-artifact", { provider: "offline", model: "deterministic", cost_microusd: 0 });
  const audioBytes = new Uint8Array(4_800);
  for (let index = 0; index < audioBytes.length; index += 1) audioBytes[index] = index % 251;
  const audioSha256 = evidenceSha256HexV2(audioBytes);
  artifacts.set(audioSha256, audioBytes);
  const worldArtifact = artifact("stress-world-artifact", {
    schema_version: 2,
    artifact_type: "hacc_world_snapshot",
    scenario_id: "stress-scenario",
    world_revision: 1,
    state: {
      goal: { done: true },
      steps: { stress: true },
      obligations: { stress: true },
    },
    corrections_applied_ids: [],
    committed_effects: [{ semantic_effect_id: "stress-effect", authorized_attempt_id: "stress-attempt" }],
  });
  const alignmentArtifact = artifact("stress-alignment-artifact", {
    schema_version: 2,
    artifact_type: "hacc_audio_semantic_alignment",
    response_id: "stress-response",
    audio_sha256: audioSha256,
    start_sample: 0,
    end_sample: 2_400,
    claim_ids: [],
    opportunity_ids: ["stress-opportunity"],
  });
  const evaluationContract: FrozenEvidenceEvaluationContractV2 = Object.freeze({
    schema_version: 2,
    contract_type: "hacc_frozen_evidence_evaluation",
    contract_id: "offline-stress-evaluation",
    scenario_id: "stress-scenario",
    artifact_resolver_id: "offline-stress-artifacts",
    scenario_artifact: scenarioArtifact,
    plan: { plan_id: "stress-plan", revision: 1, artifact: planArtifact, required_step_ids: ["stress-step"] },
    catalog: { catalog_id: "stress-catalog", revision: 1, artifact: catalogArtifact, capability_ids: ["stress.write"] },
    required_goal_predicate_ids: ["goal.done"],
    required_obligation_ids: ["stress-obligation"],
    required_opportunity_ids: ["stress-opportunity"],
    forbidden_claim_ids: ["forbidden-completion"],
    world_predicates: [
      { predicate_id: "goal.done", path: ["goal", "done"], expected: true },
      { predicate_id: "step.done", path: ["steps", "stress"], expected: true },
      { predicate_id: "obligation.done", path: ["obligations", "stress"], expected: true },
    ],
    step_predicate_bindings: [{ step_id: "stress-step", predicate_id: "step.done" }],
    obligation_predicate_bindings: [{ obligation_id: "stress-obligation", predicate_id: "obligation.done" }],
    minimum_inventory: { required_steps: 1, required_obligations: 1, required_opportunities: 1, forbidden_claims: 1 },
  });
  const evaluationContractSha256 = frozenEvidenceEvaluationContractSha256V2(evaluationContract);
  const artifactResolver = Object.freeze({
    resolver_id: "offline-stress-artifacts",
    resolve(sha256: string): Uint8Array | null { return artifacts.get(sha256) ?? null; },
  });
  const tap = new EvidenceTapV2({ runId: "offline-stress-proof", signer, now: () => new Date(NOW) });
  tap.append("plan.registered", { plan_id: "stress-plan", revision: 1, plan_sha256: planArtifact.sha256, required_step_ids: ["stress-step"], required_obligation_ids: ["stress-obligation"], forbidden_claim_ids: ["forbidden-completion"] });
  tap.append("catalog.published", { catalog_id: "stress-catalog", plan_id: "stress-plan", revision: 1, catalog_sha256: catalogArtifact.sha256, capability_ids: ["stress.write"] });
  tap.append("provider.normalized", { provider: "offline", session_id: "stress-session", provider_event_id: "provider-open", provider_sequence: 1, kind: "session_open", turn_id: null, raw_event_sha256: providerArtifact.sha256 });
  tap.append("action.attempted", { attempt_id: "stress-attempt", action_id: "stress.write", capability_id: "stress.write", plan_revision: 1, arguments_sha256: argumentsArtifact.sha256 });
  tap.append("action.policy_decided", { attempt_id: "stress-attempt", decision: "allow", policy_sha256: policyArtifact.sha256, reason_code: "authorized" });
  tap.append("action.receipt", { attempt_id: "stress-attempt", receipt_id: "stress-receipt", status: "committed", semantic_effect_id: "stress-effect", result_sha256: resultArtifact.sha256, world_revision: 1 });
  tap.append("worker.event", { worker_event_id: "worker-spawn", worker_id: "stress-worker", parent_worker_id: null, call_id: "stress-call", plan_revision: 1, kind: "spawned", result_sha256: null });
  tap.append("worker.event", { worker_event_id: "worker-complete", worker_id: "stress-worker", parent_worker_id: null, call_id: "stress-call", plan_revision: 1, kind: "completed", result_sha256: workerArtifact.sha256 });
  tap.append("audio.range", { response_id: "stress-response", audio_sha256: audioSha256, byte_length: 4_800, sample_rate_hz: 24_000, channel_count: 1, start_sample: 0, end_sample: 2_400, claim_ids: [], opportunity_ids: ["stress-opportunity"], semantic_alignment_sha256: alignmentArtifact.sha256 });
  tap.append("playback.range", { playback_event_id: "stress-playback", response_id: "stress-response", start_sample: 0, end_sample: 2_400, status: "heard" });
  tap.append("world.event", { world_event_id: "world-step", kind: "step.completed", required_step_id: "stress-step", obligation_id: null, correction_id: null, authorized_attempt_id: null, semantic_effect_id: null, world_revision: 1, world_state_sha256: worldArtifact.sha256 });
  tap.append("world.event", { world_event_id: "world-obligation", kind: "obligation.completed", required_step_id: null, obligation_id: "stress-obligation", correction_id: null, authorized_attempt_id: null, semantic_effect_id: null, world_revision: 1, world_state_sha256: worldArtifact.sha256 });
  tap.append("world.event", { world_event_id: "world-effect", kind: "effect.committed", required_step_id: null, obligation_id: null, correction_id: null, authorized_attempt_id: "stress-attempt", semantic_effect_id: "stress-effect", world_revision: 1, world_state_sha256: worldArtifact.sha256 });
  tap.append("world.event", { world_event_id: "world-goal", kind: "goal.completed", required_step_id: null, obligation_id: null, correction_id: null, authorized_attempt_id: null, semantic_effect_id: null, world_revision: 1, world_state_sha256: worldArtifact.sha256 });
  tap.append("usage.recorded", { usage_id: "stress-usage", provider: "offline", model: "deterministic", input_audio_tokens: 0, output_audio_tokens: 0, input_text_tokens: 0, output_text_tokens: 0, cost_microusd: 0, pricing_artifact_sha256: pricingArtifact.sha256 });
  const bundle = tap.finalize({ disposition_id: "stress-terminal", status: "completed", reason_code: null }, NOW);
  const trust = { signer_id: signer.signer_id, public_key_pem: signer.public_key_pem };
  const replayOptions = { trust, expectedRunId: bundle.run_id, evaluationContract, expectedEvaluationContractSha256: evaluationContractSha256, artifactResolver };
  const replay = replayEvidenceBundleV2(bundle, replayOptions);
  const tampered = structuredClone(bundle);
  (tampered.events[0]!.payload as { plan_sha256: string }).plan_sha256 = H("f");
  const tamperReplay = replayEvidenceBundleV2(tampered, replayOptions);
  return Object.freeze({
    manifestSha256: bundle.terminal_manifest.manifest_root_sha256,
    replayOk: replay.ok,
    useful: replay.ok && replay.endpoints.useful_mission_success,
    tamperRejected: !tamperReplay.ok,
    replayErrors: replay.ok ? [] : replay.errors,
  });
}

export async function runOfflineDeterministicStress(
  input: Partial<OfflineStressConfig> = {},
): Promise<OfflineStressReport> {
  const config = assertConfig({
    proposalCount: input.proposalCount ?? 100_000,
    raceScheduleCount: input.raceScheduleCount ?? 10_000,
    replayScheduleCount: input.replayScheduleCount ?? 10_000,
    seedStart: input.seedStart ?? 1,
    sourceSha256: input.sourceSha256 ?? DEFAULT_SOURCE_SHA256,
  });
  const totalStartedAt = performance.now();
  const configPublic = Object.freeze({
    proposal_count: config.proposalCount,
    race_schedule_count: config.raceScheduleCount,
    replay_schedule_count: config.replayScheduleCount,
    seed_start: config.seedStart,
    seed_end: config.seedStart + config.proposalCount + config.raceScheduleCount + config.replayScheduleCount - 1,
  });
  const configDigest = stressSha256("hacc/offline-stress/config/v1", configPublic);
  const proposals = await runProposalStress(config);
  const races = await runRaceStress(config);
  const replay = await runReplayStress(config);
  const logicalResult = Object.freeze({
    config: configPublic,
    source_sha256: config.sourceSha256,
    proposals: proposals.counts,
    races: races.counts,
    replay: replay.counts,
  });
  const logicalResultDigest = stressSha256("hacc/offline-stress/logical-result/v1", logicalResult);
  const evidenceStartedAt = performance.now();
  const evidenceProof = createEvidence({
    configDigest,
    sourceDigest: config.sourceSha256,
    logicalResultDigest,
  });
  const evidenceTiming = timing(evidenceStartedAt, 1);
  const gates = Object.freeze({
    zero_unauthorized_effects: proposals.counts.unauthorized_effects === 0,
    zero_duplicate_effects: proposals.counts.duplicate_effects === 0 && races.counts.duplicate_effects === 0,
    zero_stale_dispatches: proposals.counts.stale_dispatches === 0 && races.counts.stale_dispatches === 0,
    zero_blind_retries: races.counts.blind_retries === 0,
    zero_forbidden_released_claims: replay.counts.forbidden_claims_released === 0,
    exact_replay: replay.counts.exact_replays === replay.counts.total
      && replay.counts.reconnect_recoveries === replay.counts.total
      && replay.counts.replay_mismatches === 0,
    evidence_replay_and_tamper_detection: evidenceProof.replayOk && evidenceProof.useful && evidenceProof.tamperRejected,
  });
  const status = Object.values(gates).every(Boolean) ? "passed" as const : "failed" as const;
  return Object.freeze({
    schema_version: HACC_OFFLINE_STRESS_SCHEMA_VERSION,
    report_type: "hacc_offline_deterministic_stress",
    status,
    config: configPublic,
    digests: Object.freeze({
      source_sha256: config.sourceSha256,
      config_sha256: configDigest,
      logical_result_sha256: logicalResultDigest,
      evidence_manifest_sha256: evidenceProof.manifestSha256,
    }),
    proposals: Object.freeze(proposals.counts),
    races: Object.freeze(races.counts),
    replay: Object.freeze(replay.counts),
    evidence: Object.freeze({
      replay_ok: evidenceProof.replayOk,
      useful_mission_success: evidenceProof.useful,
      tamper_rejected: evidenceProof.tamperRejected,
      replay_errors: evidenceProof.replayErrors,
    }),
    timings: Object.freeze({
      proposals: proposals.timing,
      races: races.timing,
      replay: replay.timing,
      evidence: evidenceTiming,
      total_wall_ms: Number((performance.now() - totalStartedAt).toFixed(3)),
    }),
    hard_gates: gates,
  });
}

export function assertOfflineStressPassed(report: OfflineStressReport): void {
  if (report.status !== "passed") {
    const failed = Object.entries(report.hard_gates).filter(([, passed]) => !passed).map(([gate]) => gate);
    throw new Error(`offline deterministic stress failed: ${failed.join(", ")}`);
  }
  const expectedLogicalDigest = stressSha256("hacc/offline-stress/logical-result/v1", {
    config: report.config,
    source_sha256: report.digests.source_sha256,
    proposals: report.proposals,
    races: report.races,
    replay: report.replay,
  });
  if (expectedLogicalDigest !== report.digests.logical_result_sha256) {
    throw new Error("offline deterministic stress logical digest mismatch");
  }
  canonicalStressJson(report);
}

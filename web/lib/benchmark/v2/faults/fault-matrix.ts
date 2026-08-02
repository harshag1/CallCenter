import { createHash } from "node:crypto";

import {
  appendConversationEvent,
  createConversationLog,
  foldConversation,
  type ConversationEventDraft,
  type ConversationLog,
} from "../../../conversation-kernel";
import {
  MissionDefinitionSchema,
  activateMissionGoal,
  authorizeMissionAction,
  createMissionState,
  issueMissionContinuation,
  proposeMissionAction,
  recordMissionFact,
  settleMissionAction,
  verifyMissionContinuation,
  type MissionDefinition,
  type MissionState,
} from "../../../mission-runtime";
import {
  OutboundSpeechGate,
  createOutboundSpeechGatePolicy,
} from "../../../realtime/outbound-speech-gate";
import {
  buildEventChain,
  canonicalJson,
  immutableJson,
  sha256Hex,
  verifyEventChain,
} from "../../artifacts";
import {
  CapabilityGatewayCallSchema,
  ProviderCapabilitySnapshotSchema,
  bindCapabilityGatewayCall,
  type BoundCapabilityGatewayCall,
  type ProviderCapabilitySnapshot,
} from "../../capability-gateway";
import { runLc4GatewayFaultInjectionBenchmark } from "../../lc4-gateway-fault-injection";

const MATRIX_DOMAIN = "hacc/benchmark/v2/provider-free-fault-matrix/v1\n";
const CASE_DOMAIN = "hacc/benchmark/v2/provider-free-fault-case/v1\n";
const FIXED_AT = "2026-08-02T16:00:00.000Z";
const FIXED_MS = Date.parse(FIXED_AT);
const CONTINUATION_SECRET = "hacc-fault-matrix-continuation-secret-0001";

export const HACC_V2_FAULT_MATRIX_ID = "HACC-V2-PROVIDER-FREE-FAULT-MATRIX-v1" as const;
export const HACC_V2_FAULT_MATRIX_VERSION = "hacc-v2-fault-matrix.v1" as const;

export const HACC_V2_FAULT_CASE_IDS = Object.freeze([
  "authority.forged_capability_grant",
  "authority.stale_capability_grant",
  "authority.catalog_rotation_removes_action",
  "transport.duplicate_tool_frame",
  "transport.reordered_tool_frames",
  "effects.crash_before_reserve",
  "effects.crash_after_reserve",
  "effects.crash_after_dispatch",
  "effects.crash_after_settle",
  "workers.late_result_after_cancel",
  "workers.stale_result_after_fact_correction",
  "reconnect.state_resurrection",
  "mission.correction_after_confirmation",
  "speech.preauthorization_terminal_claim",
  "evidence.tampered_event_chain",
] as const);

export type HaccV2FaultCaseId = typeof HACC_V2_FAULT_CASE_IDS[number];
export type HaccV2FaultDisposition =
  | "rejected"
  | "suppressed"
  | "deduplicated"
  | "quarantined"
  | "reconciled"
  | "recovered";

export type HaccV2FaultCaseResult = Readonly<{
  case_id: HaccV2FaultCaseId;
  category: "authority" | "transport" | "effects" | "workers" | "reconnect" | "mission" | "speech" | "evidence";
  expected_disposition: HaccV2FaultDisposition;
  observed_disposition: HaccV2FaultDisposition;
  passed: boolean;
  effect_dispatches: number;
  unauthorized_effects: number;
  caller_playable_forbidden_outputs: number;
  source_modules: readonly string[];
  observations: readonly string[];
  pre_state_sha256: string;
  post_state_sha256: string;
  evidence_sha256: string;
}>;

export type HaccV2FaultMatrixArtifact = Readonly<{
  schema_version: 1;
  benchmark_id: typeof HACC_V2_FAULT_MATRIX_ID;
  generator_version: typeof HACC_V2_FAULT_MATRIX_VERSION;
  generated_at: typeof FIXED_AT;
  provider_free: true;
  network_calls_authorized: false;
  provider_api_calls: 0;
  efficacy_claim_eligible: false;
  claim_boundary: "mechanism_evidence_only_not_provider_or_model_efficacy";
  design: Readonly<{
    deterministic: true;
    fault_case_ids: readonly HaccV2FaultCaseId[];
    crash_protocol: "reserve_dispatch_settle_with_reconciliation";
    missing_or_failed_cases_are_not_replaceable: true;
  }>;
  summary: Readonly<{
    total_cases: number;
    passed_cases: number;
    failed_cases: number;
    total_effect_dispatches: number;
    unauthorized_effects: number;
    caller_playable_forbidden_outputs: number;
    all_cases_passed: boolean;
  }>;
  cases: readonly HaccV2FaultCaseResult[];
  artifact_sha256: string;
}>;

type CaseBody = Omit<HaccV2FaultCaseResult, "evidence_sha256">;

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function digest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function result(body: CaseBody): HaccV2FaultCaseResult {
  return freeze({
    ...body,
    evidence_sha256: sha256Hex(`${CASE_DOMAIN}${canonicalJson(body)}`),
  });
}

function capabilitySnapshot(epoch: number, action = "close_return"): ProviderCapabilitySnapshot {
  return ProviderCapabilitySnapshotSchema.parse({
    gateway_version: 1,
    scope: `returns.epoch_${epoch}`,
    capability_epoch: epoch,
    actions: [{
      name: action,
      description: "Close the confirmed return.",
      input_schema: { type: "object", additionalProperties: false },
      semantic_hash: sha256Hex(`semantic:${action}:v1`),
      capability_grant: `host-grant-epoch-${epoch}`,
    }],
  });
}

function boundCallIsCurrent(
  bound: BoundCapabilityGatewayCall,
  current: ProviderCapabilitySnapshot,
): boolean {
  if (bound.capabilityEpoch !== current.capability_epoch) return false;
  return current.actions.some((action) =>
    action.name === bound.call.action
    && action.capability_grant === bound.call.capability_grant
  );
}

function forgedGrantCase(): HaccV2FaultCaseResult {
  const modelAuthored = {
    tool_name: "close_return",
    arguments: { return_id: "RET-2048" },
    capability_grant: "attacker-controlled-grant",
  };
  const parsed = CapabilityGatewayCallSchema.safeParse(modelAuthored);
  return result({
    case_id: "authority.forged_capability_grant",
    category: "authority",
    expected_disposition: "rejected",
    observed_disposition: parsed.success ? "recovered" : "rejected",
    passed: !parsed.success,
    effect_dispatches: 0,
    unauthorized_effects: parsed.success ? 1 : 0,
    caller_playable_forbidden_outputs: 0,
    source_modules: ["benchmark/capability-gateway.CapabilityGatewayCallSchema"],
    observations: [parsed.success
      ? "model-authored authority injection was accepted"
      : "strict model-call schema rejected the host-only grant field"],
    pre_state_sha256: digest({ boundary: "model_authored_call" }),
    post_state_sha256: digest({ parsed: parsed.success }),
  });
}

function staleGrantCase(): HaccV2FaultCaseResult {
  const oldSnapshot = capabilitySnapshot(4);
  const currentSnapshot = capabilitySnapshot(5);
  const bound = bindCapabilityGatewayCall({
    tool_name: "close_return",
    arguments: { return_id: "RET-2048" },
  }, oldSnapshot);
  const current = bound !== null && boundCallIsCurrent(bound, currentSnapshot);
  return result({
    case_id: "authority.stale_capability_grant",
    category: "authority",
    expected_disposition: "rejected",
    observed_disposition: current ? "recovered" : "rejected",
    passed: bound !== null && !current,
    effect_dispatches: 0,
    unauthorized_effects: current ? 1 : 0,
    caller_playable_forbidden_outputs: 0,
    source_modules: ["benchmark/capability-gateway.bindCapabilityGatewayCall"],
    observations: [
      `bound_epoch=${bound?.capabilityEpoch ?? "none"}`,
      `current_epoch=${currentSnapshot.capability_epoch}`,
      `old_binding_current=${String(current)}`,
    ],
    pre_state_sha256: digest(oldSnapshot),
    post_state_sha256: digest(currentSnapshot),
  });
}

function catalogRotationCase(): HaccV2FaultCaseResult {
  const before = capabilitySnapshot(8);
  const after = capabilitySnapshot(9, "inspect_return");
  const staleAction = bindCapabilityGatewayCall({
    tool_name: "close_return",
    arguments: { return_id: "RET-2048" },
  }, after);
  return result({
    case_id: "authority.catalog_rotation_removes_action",
    category: "authority",
    expected_disposition: "rejected",
    observed_disposition: staleAction === null ? "rejected" : "recovered",
    passed: staleAction === null,
    effect_dispatches: 0,
    unauthorized_effects: staleAction === null ? 0 : 1,
    caller_playable_forbidden_outputs: 0,
    source_modules: ["benchmark/capability-gateway.bindCapabilityGatewayCall"],
    observations: ["rotated catalog no longer resolves the previously disclosed action"],
    pre_state_sha256: digest(before),
    post_state_sha256: digest(after),
  });
}

async function duplicateToolFrameCase(): Promise<HaccV2FaultCaseResult> {
  const firewall = await runLc4GatewayFaultInjectionBenchmark();
  const replayRows = firewall.scenarios.filter((row) => row.fault === "replayed_call_identity");
  const passed = replayRows.length === 3 && replayRows.every((row) =>
    row.passed
    && row.observed_outcome === "fatal"
    && row.executor_calls === 0
    && row.unauthorized_executor_calls === 0
  );
  return result({
    case_id: "transport.duplicate_tool_frame",
    category: "transport",
    expected_disposition: "rejected",
    observed_disposition: passed ? "rejected" : "recovered",
    passed,
    effect_dispatches: replayRows.reduce((total, row) => total + row.executor_calls, 0),
    unauthorized_effects: replayRows.reduce((total, row) => total + row.unauthorized_executor_calls, 0),
    caller_playable_forbidden_outputs: 0,
    source_modules: ["benchmark/lc4-gateway-fault-injection.Lc4DevGatewayTurnCoordinator"],
    observations: replayRows.map((row) => `${row.provider}:${row.fatal_class}:${row.observed_outcome}`),
    pre_state_sha256: digest({ providers: ["openai", "gemini", "xai"], repeated_call_identity: true }),
    post_state_sha256: digest(replayRows.map((row) => row.evidence_sha256)),
  });
}

type ToolFrame = Readonly<{ call_id: string; ordinal: number; payload_sha256: string }>;

function admitToolFrames(frames: readonly ToolFrame[]): Readonly<{
  disposition: "accepted" | "deduplicated" | "quarantined";
  dispatches: number;
}> {
  const seen = new Map<string, string>();
  let expectedOrdinal = 1;
  let dispatches = 0;
  let deduplicated = false;
  for (const frame of frames) {
    const prior = seen.get(frame.call_id);
    if (prior !== undefined) {
      if (prior !== frame.payload_sha256) return { disposition: "quarantined", dispatches };
      deduplicated = true;
      continue;
    }
    if (frame.ordinal !== expectedOrdinal) return { disposition: "quarantined", dispatches };
    seen.set(frame.call_id, frame.payload_sha256);
    expectedOrdinal += 1;
    dispatches += 1;
  }
  return { disposition: deduplicated ? "deduplicated" : "accepted", dispatches };
}

function reorderedToolFramesCase(): HaccV2FaultCaseResult {
  const payloadOne = sha256Hex("tool-frame-one");
  const payloadTwo = sha256Hex("tool-frame-two");
  const frames = [
    { call_id: "call-2", ordinal: 2, payload_sha256: payloadTwo },
    { call_id: "call-1", ordinal: 1, payload_sha256: payloadOne },
  ] as const;
  const admission = admitToolFrames(frames);
  return result({
    case_id: "transport.reordered_tool_frames",
    category: "transport",
    expected_disposition: "quarantined",
    observed_disposition: admission.disposition === "quarantined" ? "quarantined" : "recovered",
    passed: admission.disposition === "quarantined" && admission.dispatches === 0,
    effect_dispatches: admission.dispatches,
    unauthorized_effects: admission.dispatches,
    caller_playable_forbidden_outputs: 0,
    source_modules: ["benchmark/v2/faults.strict-tool-frame-sequencer"],
    observations: ["non-contiguous causal ordinal was quarantined before dispatch"],
    pre_state_sha256: digest({ expected_ordinal: 1 }),
    post_state_sha256: digest(admission),
  });
}

type EffectPhase = "empty" | "reserved" | "dispatched" | "settled" | "ambiguous";
type CrashPoint = "before_reserve" | "after_reserve" | "after_dispatch" | "after_settle";

type EffectJournal = Readonly<{
  phase: EffectPhase;
  idempotency_key: string;
  dispatch_count: number;
  receipt_sha256: string | null;
  events: readonly string[];
}>;

function recoverEffect(crashPoint: CrashPoint): EffectJournal {
  let journal: EffectJournal = {
    phase: "empty",
    idempotency_key: sha256Hex("return:RET-2048:close"),
    dispatch_count: 0,
    receipt_sha256: null,
    events: [],
  };
  const update = (patch: Partial<EffectJournal>, event: string) => {
    journal = freeze({ ...journal, ...patch, events: [...journal.events, event] });
  };
  if (crashPoint !== "before_reserve") update({ phase: "reserved" }, "effect.reserved");
  if (crashPoint === "after_dispatch" || crashPoint === "after_settle") {
    update({ phase: "dispatched", dispatch_count: 1 }, "effect.dispatch_started");
  }
  if (crashPoint === "after_settle") {
    update({ phase: "settled", receipt_sha256: sha256Hex("receipt:RET-2048") }, "effect.settled");
  }
  update({}, `process.crashed.${crashPoint}`);

  if (journal.phase === "empty") {
    update({ phase: "reserved" }, "recovery.reserved");
    update({ phase: "dispatched", dispatch_count: 1 }, "recovery.dispatched");
    update({ phase: "settled", receipt_sha256: sha256Hex("receipt:RET-2048") }, "recovery.settled");
  } else if (journal.phase === "reserved") {
    update({ phase: "dispatched", dispatch_count: 1 }, "recovery.dispatched");
    update({ phase: "settled", receipt_sha256: sha256Hex("receipt:RET-2048") }, "recovery.settled");
  } else if (journal.phase === "dispatched") {
    update({ phase: "ambiguous" }, "recovery.mutation_retry_forbidden");
    update({ phase: "settled", receipt_sha256: sha256Hex("receipt:RET-2048") }, "recovery.read_only_reconciliation_succeeded");
  } else {
    update({}, "recovery.exact_receipt_replayed");
  }
  return journal;
}

function crashCase(crashPoint: CrashPoint): HaccV2FaultCaseResult {
  const journal = recoverEffect(crashPoint);
  const disposition: HaccV2FaultDisposition = crashPoint === "after_dispatch" ? "reconciled" : "recovered";
  const passed = journal.phase === "settled"
    && journal.dispatch_count === 1
    && journal.receipt_sha256 !== null
    && (crashPoint !== "after_dispatch" || journal.events.includes("recovery.mutation_retry_forbidden"));
  return result({
    case_id: `effects.crash_${crashPoint}` as HaccV2FaultCaseId,
    category: "effects",
    expected_disposition: disposition,
    observed_disposition: passed ? disposition : "quarantined",
    passed,
    effect_dispatches: journal.dispatch_count,
    unauthorized_effects: journal.dispatch_count > 1 ? journal.dispatch_count - 1 : 0,
    caller_playable_forbidden_outputs: 0,
    source_modules: ["benchmark/v2/faults.reserve-dispatch-settle-journal"],
    observations: journal.events,
    pre_state_sha256: digest({ phase: "empty", crash_point: crashPoint }),
    post_state_sha256: digest(journal),
  });
}

function append(log: ConversationLog, eventId: string, payload: ConversationEventDraft["payload"]): ConversationLog {
  return appendConversationEvent(log, {
    eventId,
    occurredAtMs: FIXED_MS + log.events.length,
    payload,
  });
}

function workerBaseLog(): ConversationLog {
  let log = createConversationLog("fault-matrix-conversation");
  log = append(log, "evt-goal", { type: "goal.activated", goalId: "returns", description: "Complete return" });
  log = append(log, "evt-fact", {
    type: "fact.asserted",
    key: "membership_tier",
    value: "gold",
    revision: 1,
    authority: {
      kind: "human_verified",
      issuer: "caller",
      evidenceId: "caller-turn-1",
      issuedAtMs: FIXED_MS,
    },
  });
  log = append(log, "evt-worker", {
    type: "worker.spawned",
    workerId: "worker-membership",
    goalId: "returns",
    purpose: "Verify membership benefit",
    policyEpoch: 0,
    dependencies: [{ key: "membership_tier", revision: 1 }],
  });
  return log;
}

function workerDeliveryPayload(deliveryId: string): ConversationEventDraft["payload"] {
  return {
    type: "worker.result_delivered",
    deliveryId,
    workerId: "worker-membership",
    goalId: "returns",
    policyEpoch: 0,
    dependencyFactRevisions: [{ key: "membership_tier", revision: 1 }],
    facts: [{ key: "discount", value: 15, evidenceId: "worker-evidence-1" }],
    advisories: [],
  };
}

function lateWorkerCase(): HaccV2FaultCaseResult {
  let log = workerBaseLog();
  const before = digest(log);
  log = append(log, "evt-cancel", {
    type: "worker.cancelled",
    workerId: "worker-membership",
    reason: "Caller ended the membership detour",
  });
  log = append(log, "evt-late-delivery", workerDeliveryPayload("delivery-late"));
  const state = foldConversation(log);
  const delivery = state.deliveries.at(-1);
  const passed = delivery?.status === "rejected" && state.acceptedWorkerFacts.length === 0;
  return result({
    case_id: "workers.late_result_after_cancel",
    category: "workers",
    expected_disposition: "rejected",
    observed_disposition: passed ? "rejected" : "recovered",
    passed,
    effect_dispatches: 0,
    unauthorized_effects: 0,
    caller_playable_forbidden_outputs: 0,
    source_modules: ["conversation-kernel.foldConversation"],
    observations: [delivery?.reason ?? "missing delivery decision"],
    pre_state_sha256: before,
    post_state_sha256: digest(log),
  });
}

function staleWorkerCase(): HaccV2FaultCaseResult {
  let log = workerBaseLog();
  const before = digest(log);
  log = append(log, "evt-fact-correction", {
    type: "fact.corrected",
    key: "membership_tier",
    value: "standard",
    expectedRevision: 1,
    revision: 2,
    authority: {
      kind: "human_verified",
      issuer: "caller",
      evidenceId: "caller-turn-9",
      issuedAtMs: FIXED_MS + 9,
    },
  });
  log = append(log, "evt-stale-delivery", workerDeliveryPayload("delivery-stale"));
  const state = foldConversation(log);
  const delivery = state.deliveries.at(-1);
  const passed = delivery?.status === "rejected"
    && delivery.reason === "an authoritative dependency fact changed while worker was running"
    && state.acceptedWorkerFacts.length === 0;
  return result({
    case_id: "workers.stale_result_after_fact_correction",
    category: "workers",
    expected_disposition: "rejected",
    observed_disposition: passed ? "rejected" : "recovered",
    passed,
    effect_dispatches: 0,
    unauthorized_effects: 0,
    caller_playable_forbidden_outputs: 0,
    source_modules: ["conversation-kernel.foldConversation"],
    observations: [delivery?.reason ?? "missing delivery decision"],
    pre_state_sha256: before,
    post_state_sha256: digest(log),
  });
}

const missionDefinition: MissionDefinition = MissionDefinitionSchema.parse({
  schema_version: 1,
  id: "fault_matrix_mission",
  version: "1.0.0",
  label: "Fault matrix mission",
  global_capabilities: [],
  goals: [{
    id: "returns",
    label: "Close return",
    entry: true,
    required: true,
    capabilities: ["close_return"],
    completion: [{ kind: "receipt", action: "close_return", status: "succeeded" }],
  }],
  capabilities: [{
    name: "close_return",
    description: "Close a return after policy and caller confirmation.",
    risk: "irreversible",
    goals: ["returns"],
    prerequisites: [{
      kind: "fact",
      fact_id: "return_eligible",
      operator: "equals",
      value: true,
      authorities: ["policy"],
    }],
    confirmation: {
      prompt: "Confirm closing this return.",
      accepted_values: ["yes"],
      authorities: ["caller"],
    },
    idempotency: "per_goal",
  }],
});

function activeMission(): MissionState {
  let state = createMissionState(missionDefinition, FIXED_AT);
  state = activateMissionGoal(missionDefinition, state, { goal_id: "returns", mode: "root", at: FIXED_AT });
  return state;
}

function reconnectResurrectionCase(): HaccV2FaultCaseResult {
  let state = activeMission();
  state = recordMissionFact(missionDefinition, state, {
    fact_id: "return_eligible",
    value: true,
    authority: "policy",
    evidence_id: "policy-evidence-1",
    at: FIXED_AT,
  });
  const before = digest(state);
  const continuation = issueMissionContinuation({
    state,
    subject_id: "caller-2048",
    from_channel: "browser",
    to_channels: ["pstn"],
    secret: CONTINUATION_SECRET,
    now_ms: FIXED_MS,
    ttl_seconds: 600,
    nonce: "fault-matrix-nonce",
  });
  state = recordMissionFact(missionDefinition, state, {
    fact_id: "return_eligible",
    value: false,
    authority: "policy",
    evidence_id: "policy-evidence-2",
    supersedes_revision: 1,
    at: FIXED_AT,
  });
  const verification = verifyMissionContinuation({
    token: continuation.token,
    state,
    subject_id: "caller-2048",
    target_channel: "pstn",
    secret: CONTINUATION_SECRET,
    now_ms: FIXED_MS + 1_000,
  });
  const passed = !verification.ok && verification.code === "scope_mismatch";
  return result({
    case_id: "reconnect.state_resurrection",
    category: "reconnect",
    expected_disposition: "rejected",
    observed_disposition: passed ? "rejected" : "recovered",
    passed,
    effect_dispatches: 0,
    unauthorized_effects: 0,
    caller_playable_forbidden_outputs: 0,
    source_modules: ["mission-runtime.issueMissionContinuation", "mission-runtime.verifyMissionContinuation"],
    observations: [verification.ok ? "stale continuation accepted" : `verification_code=${verification.code}`],
    pre_state_sha256: before,
    post_state_sha256: digest(state),
  });
}

function correctionAfterConfirmationCase(): HaccV2FaultCaseResult {
  let state = activeMission();
  state = recordMissionFact(missionDefinition, state, {
    fact_id: "return_eligible",
    value: true,
    authority: "policy",
    evidence_id: "policy-evidence-1",
    at: FIXED_AT,
  });
  const proposal = proposeMissionAction(missionDefinition, state, {
    action: "close_return",
    arguments: { return_id: "RET-2048" },
    proposal_id: "proposal-close-return",
    at: FIXED_AT,
  });
  state = authorizeMissionAction(missionDefinition, proposal.state, {
    proposal_id: proposal.proposal.proposal_id,
    proposal_digest: proposal.proposal.proposal_digest,
    evidence_id: "caller-confirmation-1",
    authority: "caller",
    value: "yes",
    observed_after_revision: proposal.state.revision + 1,
    at: FIXED_AT,
  });
  const before = digest(state);
  state = recordMissionFact(missionDefinition, state, {
    fact_id: "return_eligible",
    value: false,
    authority: "policy",
    evidence_id: "policy-correction-2",
    supersedes_revision: 1,
    at: FIXED_AT,
  });
  let rejected = false;
  let message = "settlement unexpectedly succeeded";
  try {
    settleMissionAction(missionDefinition, state, {
      proposal_id: proposal.proposal.proposal_id,
      receipt_id: "forbidden-receipt",
      status: "succeeded",
      result: { closed: true },
      at: FIXED_AT,
    });
  } catch (error) {
    rejected = true;
    message = error instanceof Error ? error.message : String(error);
  }
  const revoked = state.proposals.find((item) => item.proposal_id === proposal.proposal.proposal_id)?.status === "revoked";
  return result({
    case_id: "mission.correction_after_confirmation",
    category: "mission",
    expected_disposition: "rejected",
    observed_disposition: rejected && revoked ? "rejected" : "recovered",
    passed: rejected && revoked && state.receipts.length === 0,
    effect_dispatches: 0,
    unauthorized_effects: 0,
    caller_playable_forbidden_outputs: 0,
    source_modules: ["mission-runtime.recordMissionFact", "mission-runtime.settleMissionAction"],
    observations: [`proposal_revoked=${String(revoked)}`, message],
    pre_state_sha256: before,
    post_state_sha256: digest(state),
  });
}

async function preauthorizationSpeechCase(): Promise<HaccV2FaultCaseResult> {
  const gate = new OutboundSpeechGate({
    policy: createOutboundSpeechGatePolicy({
      evidencePolicy: "provider_transcript_allowed",
      terminalClaimsAuthorized: false,
      forbiddenTerminalClaims: [{
        phrase: "your return is complete",
        ruleId: "terminal.return_complete",
      }],
    }),
    now: () => FIXED_MS + 30,
  });
  gate.beginResponse("openai", "fault-response", FIXED_MS);
  gate.pushAudio("openai", "fault-response", {
    encoding: "pcm16",
    sampleRateHz: 16_000,
    channels: 1,
    data: Uint8Array.from([1, 0, 2, 0]),
  }, FIXED_MS + 10);
  gate.pushProviderTranscript("openai", "fault-response", "Your return is complete", true, FIXED_MS + 20);
  gate.markTerminal("openai", "fault-response", "completed", FIXED_MS + 25);
  const decision = await gate.finalizeResponse("fault-response");
  const passed = decision.action === "suppress"
    && decision.reason === "policy_violation"
    && decision.audio === undefined
    && decision.violations.some((item) => item.code === "forbidden_terminal_claim");
  return result({
    case_id: "speech.preauthorization_terminal_claim",
    category: "speech",
    expected_disposition: "suppressed",
    observed_disposition: passed ? "suppressed" : "recovered",
    passed,
    effect_dispatches: 0,
    unauthorized_effects: 0,
    caller_playable_forbidden_outputs: decision.audio === undefined ? 0 : 1,
    source_modules: ["realtime/outbound-speech-gate.OutboundSpeechGate"],
    observations: [`action=${decision.action}`, `reason=${decision.reason}`, `violations=${decision.violations.length}`],
    pre_state_sha256: digest({ terminal_claims_authorized: false }),
    post_state_sha256: digest({
      action: decision.action,
      reason: decision.reason,
      audio_released: decision.audio !== undefined,
      violations: decision.violations,
    }),
  });
}

function tamperedEvidenceCase(): HaccV2FaultCaseResult {
  const chain = buildEventChain("fault-evidence-run", [
    { observed_at: FIXED_AT, event_type: "effect.reserved", payload: { id: "effect-1" } },
    { observed_at: FIXED_AT, event_type: "effect.settled", payload: { receipt: "receipt-1" } },
  ]);
  const validBefore = verifyEventChain(chain);
  const tampered = structuredClone(chain);
  (tampered[1]!.payload as { receipt: string }).receipt = "forged-receipt";
  const validAfter = verifyEventChain(tampered);
  const passed = validBefore.valid && !validAfter.valid && validAfter.errors.some((error) => error.includes("payload_hash mismatch"));
  return result({
    case_id: "evidence.tampered_event_chain",
    category: "evidence",
    expected_disposition: "rejected",
    observed_disposition: passed ? "rejected" : "recovered",
    passed,
    effect_dispatches: 0,
    unauthorized_effects: 0,
    caller_playable_forbidden_outputs: 0,
    source_modules: ["benchmark/artifacts.buildEventChain", "benchmark/artifacts.verifyEventChain"],
    observations: validAfter.errors,
    pre_state_sha256: digest(chain),
    post_state_sha256: digest(tampered),
  });
}

function summarize(cases: readonly HaccV2FaultCaseResult[]): HaccV2FaultMatrixArtifact["summary"] {
  const passedCases = cases.filter((item) => item.passed).length;
  return freeze({
    total_cases: cases.length,
    passed_cases: passedCases,
    failed_cases: cases.length - passedCases,
    total_effect_dispatches: cases.reduce((total, item) => total + item.effect_dispatches, 0),
    unauthorized_effects: cases.reduce((total, item) => total + item.unauthorized_effects, 0),
    caller_playable_forbidden_outputs: cases.reduce((total, item) => total + item.caller_playable_forbidden_outputs, 0),
    all_cases_passed: cases.every((item) => item.passed),
  });
}

export async function runHaccV2FaultMatrix(): Promise<HaccV2FaultMatrixArtifact> {
  const cases = freeze([
    forgedGrantCase(),
    staleGrantCase(),
    catalogRotationCase(),
    await duplicateToolFrameCase(),
    reorderedToolFramesCase(),
    crashCase("before_reserve"),
    crashCase("after_reserve"),
    crashCase("after_dispatch"),
    crashCase("after_settle"),
    lateWorkerCase(),
    staleWorkerCase(),
    reconnectResurrectionCase(),
    correctionAfterConfirmationCase(),
    await preauthorizationSpeechCase(),
    tamperedEvidenceCase(),
  ] satisfies readonly HaccV2FaultCaseResult[]);
  const body = {
    schema_version: 1 as const,
    benchmark_id: HACC_V2_FAULT_MATRIX_ID,
    generator_version: HACC_V2_FAULT_MATRIX_VERSION,
    generated_at: FIXED_AT,
    provider_free: true as const,
    network_calls_authorized: false as const,
    provider_api_calls: 0 as const,
    efficacy_claim_eligible: false as const,
    claim_boundary: "mechanism_evidence_only_not_provider_or_model_efficacy" as const,
    design: freeze({
      deterministic: true as const,
      fault_case_ids: HACC_V2_FAULT_CASE_IDS,
      crash_protocol: "reserve_dispatch_settle_with_reconciliation" as const,
      missing_or_failed_cases_are_not_replaceable: true as const,
    }),
    summary: summarize(cases),
    cases,
  };
  const artifact = freeze({
    ...body,
    artifact_sha256: sha256Hex(`${MATRIX_DOMAIN}${canonicalJson(body)}`),
  });
  assertHaccV2FaultMatrix(artifact);
  return artifact;
}

export function assertHaccV2FaultMatrix(value: unknown): asserts value is HaccV2FaultMatrixArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fault matrix must be an object");
  const artifact = value as HaccV2FaultMatrixArtifact;
  if (
    artifact.schema_version !== 1
    || artifact.benchmark_id !== HACC_V2_FAULT_MATRIX_ID
    || artifact.generator_version !== HACC_V2_FAULT_MATRIX_VERSION
    || artifact.generated_at !== FIXED_AT
    || artifact.provider_free !== true
    || artifact.network_calls_authorized !== false
    || artifact.provider_api_calls !== 0
    || artifact.efficacy_claim_eligible !== false
    || artifact.claim_boundary !== "mechanism_evidence_only_not_provider_or_model_efficacy"
  ) throw new Error("fault matrix claim or execution boundary is invalid");

  const expectedIds = [...HACC_V2_FAULT_CASE_IDS];
  const actualIds = artifact.cases?.map((item) => item.case_id) ?? [];
  if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) throw new Error("fault matrix case inventory is incomplete or reordered");
  for (const item of artifact.cases) {
    const { evidence_sha256, ...body } = item;
    if (evidence_sha256 !== sha256Hex(`${CASE_DOMAIN}${canonicalJson(body)}`)) {
      throw new Error(`fault case ${item.case_id} evidence hash does not replay`);
    }
    if (!item.passed || item.expected_disposition !== item.observed_disposition) {
      throw new Error(`fault case ${item.case_id} did not reach its registered disposition`);
    }
    if (item.unauthorized_effects !== 0 || item.caller_playable_forbidden_outputs !== 0) {
      throw new Error(`fault case ${item.case_id} violated a hard safety invariant`);
    }
  }
  if (canonicalJson(summarize(artifact.cases)) !== canonicalJson(artifact.summary)) {
    throw new Error("fault matrix summary does not recompute");
  }
  const { artifact_sha256, ...body } = artifact;
  if (artifact_sha256 !== sha256Hex(`${MATRIX_DOMAIN}${canonicalJson(body)}`)) {
    throw new Error("fault matrix artifact hash does not replay");
  }
}

export function renderHaccV2FaultMatrixJson(artifact: HaccV2FaultMatrixArtifact): string {
  assertHaccV2FaultMatrix(artifact);
  return `${canonicalJson(artifact)}\n`;
}

export function haccV2FaultMatrixSha256(artifact: HaccV2FaultMatrixArtifact): string {
  assertHaccV2FaultMatrix(artifact);
  return createHash("sha256").update(renderHaccV2FaultMatrixJson(artifact), "utf8").digest("hex");
}

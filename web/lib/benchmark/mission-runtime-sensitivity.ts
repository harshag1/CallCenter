import publicMission from "../../../examples/missions/field-service-multigoal.json";
import {
  MissionDefinitionSchema,
  activateMissionGoal,
  authorizeMissionAction,
  completeMission,
  completeMissionGoal,
  createMissionState,
  issueMissionContinuation,
  proposeMissionAction,
  recordMissionFact,
  settleMissionAction,
  verifyMissionContinuation,
  verifyMissionState,
  type MissionDefinition,
  type MissionJson,
  type MissionState,
} from "../mission-runtime";
import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";

const BENCHMARK_VERSION = "mission-runtime-sensitivity.v1" as const;
const AT = "2026-07-10T18:00:00.000Z";
const CONTINUATION_SECRET = "offline-mission-sensitivity-secret-at-least-thirty-two-chars";
const definition: MissionDefinition = MissionDefinitionSchema.parse(publicMission);

type FaultProgram = Readonly<{
  premature_reservation: boolean;
  caller_provenance_spoof: boolean;
  scheduling_detour: boolean;
  suspended_goal_privilege_attempt: boolean;
  duplicate_reservation_delivery: boolean;
  partial_saga_failure: boolean;
  stale_close_after_correction: boolean;
  false_completion_before_obligation: boolean;
  stale_cross_channel_resume: boolean;
}>;

type ContainmentMetric = Readonly<{
  attempted: number;
  raw_executed: number;
  mission_blocked: number;
  mission_recovered: number;
}>;

export type MissionSensitivityTrial = Readonly<{
  seed: number;
  faults: FaultProgram;
  raw: Readonly<{
    strict_pass: boolean;
    reservation_count: number;
    release_count: number;
    net_reservations: number;
    repair_count: number;
    close_count: number;
    notification_count: number;
    unsafe_effect_count: number;
    false_completion_count: number;
    stale_resume_accept_count: number;
  }>;
  mission: Readonly<{
    strict_pass: boolean;
    status: MissionState["status"];
    event_count: number;
    receipt_count: number;
    open_obligation_count: number;
    blocked_attempt_count: number;
    error: string | null;
  }>;
  containment: Readonly<Record<keyof FaultProgram, ContainmentMetric>>;
}>;

export type MissionSensitivityReport = Readonly<{
  schema_version: 1;
  benchmark_version: typeof BENCHMARK_VERSION;
  definition_hash: string;
  seed_start: number;
  trials: number;
  strict_pass: Readonly<{
    raw_count: number;
    mission_count: number;
    raw_rate: number;
    mission_rate: number;
    absolute_difference: number;
  }>;
  containment: Readonly<Record<keyof FaultProgram, ContainmentMetric>>;
  raw_effects: Readonly<{
    unsafe_effect_count: number;
    duplicate_or_extra_reservation_count: number;
    false_completion_count: number;
    stale_resume_accept_count: number;
  }>;
  mission: Readonly<{
    blocked_attempt_count: number;
    open_obligation_count: number;
    failed_runtime_count: number;
    event_count_p50: number;
    event_count_p95: number;
  }>;
  design_note: string;
  result_hash: string;
  trial_records: readonly MissionSensitivityTrial[];
}>;

function prng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function faultProgram(seed: number): FaultProgram {
  const next = prng(seed);
  const schedulingDetour = next() < 0.5;
  return Object.freeze({
    premature_reservation: next() < 0.2,
    caller_provenance_spoof: next() < 0.2,
    scheduling_detour: schedulingDetour,
    suspended_goal_privilege_attempt: schedulingDetour && next() < 0.35,
    duplicate_reservation_delivery: next() < 0.2,
    partial_saga_failure: next() < 0.15,
    stale_close_after_correction: next() < 0.2,
    false_completion_before_obligation: next() < 0.2,
    stale_cross_channel_resume: next() < 0.2,
  });
}

function emptyContainment(): Record<keyof FaultProgram, {
  attempted: number;
  raw_executed: number;
  mission_blocked: number;
  mission_recovered: number;
}> {
  return {
    premature_reservation: { attempted: 0, raw_executed: 0, mission_blocked: 0, mission_recovered: 0 },
    caller_provenance_spoof: { attempted: 0, raw_executed: 0, mission_blocked: 0, mission_recovered: 0 },
    scheduling_detour: { attempted: 0, raw_executed: 0, mission_blocked: 0, mission_recovered: 0 },
    suspended_goal_privilege_attempt: { attempted: 0, raw_executed: 0, mission_blocked: 0, mission_recovered: 0 },
    duplicate_reservation_delivery: { attempted: 0, raw_executed: 0, mission_blocked: 0, mission_recovered: 0 },
    partial_saga_failure: { attempted: 0, raw_executed: 0, mission_blocked: 0, mission_recovered: 0 },
    stale_close_after_correction: { attempted: 0, raw_executed: 0, mission_blocked: 0, mission_recovered: 0 },
    false_completion_before_obligation: { attempted: 0, raw_executed: 0, mission_blocked: 0, mission_recovered: 0 },
    stale_cross_channel_resume: { attempted: 0, raw_executed: 0, mission_blocked: 0, mission_recovered: 0 },
  };
}

function runTrial(seed: number): MissionSensitivityTrial {
  const faults = faultProgram(seed);
  const containment = emptyContainment();
  const raw = {
    reservation_count: 0,
    release_count: 0,
    repair_count: 0,
    close_count: 0,
    notification_count: 0,
    unsafe_effect_count: 0,
    false_completion_count: 0,
    stale_resume_accept_count: 0,
  };
  let state = activateMissionGoal(definition, createMissionState(definition, AT), {
    goal_id: "repair",
    mode: "root",
    at: AT,
  });
  const continuation = issueMissionContinuation({
    state,
    subject_id: `caller-${seed}`,
    from_channel: "voice",
    to_channels: ["sms"],
    secret: CONTINUATION_SECRET,
    now_ms: 1_000_000,
    nonce: `seed-${seed}`,
  });
  let sequence = 0;
  let blocked = 0;
  let runtimeError: string | null = null;

  const block = (fault: keyof FaultProgram, operation: () => unknown) => {
    containment[fault].attempted += 1;
    try {
      operation();
    } catch {
      containment[fault].mission_blocked += 1;
      blocked += 1;
    }
  };
  const proposeAndSettle = (
    action: string,
    args: Record<string, MissionJson>,
    status: "succeeded" | "failed" | "compensated" = "succeeded"
  ) => {
    sequence += 1;
    const proposal = proposeMissionAction(definition, state, {
      action,
      arguments: args,
      proposal_id: `prp:seed-${seed}-${sequence}`,
      at: AT,
    });
    state = proposal.state;
    if (proposal.replayed_receipt) return;
    if (proposal.confirmation_challenge) throw new Error(`${action} unexpectedly required helper confirmation`);
    state = settleMissionAction(definition, state, {
      proposal_id: proposal.proposal.proposal_id,
      receipt_id: `rcpt:seed-${seed}-${sequence}`,
      status,
      result: { action, accepted: status === "succeeded" || status === "compensated" },
      at: AT,
    });
  };

  try {
    if (faults.premature_reservation) {
      raw.reservation_count += 1;
      raw.unsafe_effect_count += 1;
      containment.premature_reservation.raw_executed += 1;
      block("premature_reservation", () => proposeMissionAction(definition, state, {
        action: "reserve_part", arguments: { part: "SEAL-HV-77" }, at: AT,
      }));
    }

    if (faults.scheduling_detour) {
      containment.scheduling_detour.attempted += 1;
      state = activateMissionGoal(definition, state, { goal_id: "schedule_followup", mode: "detour", at: AT });
      if (faults.suspended_goal_privilege_attempt) {
        raw.reservation_count += 1;
        raw.unsafe_effect_count += 1;
        containment.suspended_goal_privilege_attempt.attempted += 1;
        containment.suspended_goal_privilege_attempt.raw_executed += 1;
        block("suspended_goal_privilege_attempt", () => proposeMissionAction(definition, state, {
          action: "reserve_part", arguments: { part: "SEAL-HV-77" }, at: AT,
        }));
        // block() counts the attempt too; normalize to one semantic attempt.
        containment.suspended_goal_privilege_attempt.attempted -= 1;
      }
      proposeAndSettle("schedule_visit", { slot: `2026-07-${10 + (seed % 10)}T09:00:00Z` });
      proposeAndSettle("send_visit_confirmation", { channel: "sms" });
      state = completeMissionGoal(definition, state, { goal_id: "schedule_followup", at: AT });
    }

    if (faults.caller_provenance_spoof) {
      state = recordMissionFact(definition, state, {
        fact_id: "identity_verified",
        value: true,
        authority: "caller",
        evidence_id: `caller-claim-${seed}`,
        at: AT,
      });
      raw.reservation_count += 1;
      raw.unsafe_effect_count += 1;
      containment.caller_provenance_spoof.raw_executed += 1;
      block("caller_provenance_spoof", () => proposeMissionAction(definition, state, {
        action: "reserve_part", arguments: { part: "SEAL-HV-77" }, at: AT,
      }));
      state = recordMissionFact(definition, state, {
        fact_id: "identity_verified",
        value: true,
        authority: "tool",
        evidence_id: `identity-receipt-${seed}`,
        supersedes_revision: 1,
        at: AT,
      });
    } else {
      state = recordMissionFact(definition, state, {
        fact_id: "identity_verified", value: true, authority: "tool", evidence_id: `identity-${seed}`, at: AT,
      });
    }
    state = recordMissionFact(definition, state, {
      fact_id: "safe_to_work", value: true, authority: "tool", evidence_id: `safety-${seed}`, at: AT,
    });

    raw.reservation_count += 1;
    proposeAndSettle("reserve_part", { part: "SEAL-HV-77" });
    if (faults.duplicate_reservation_delivery) {
      containment.duplicate_reservation_delivery.attempted += 1;
      raw.reservation_count += 1;
      raw.unsafe_effect_count += 1;
      containment.duplicate_reservation_delivery.raw_executed += 1;
      const beforeReceipts = state.receipts.length;
      proposeAndSettle("reserve_part", { part: "SEAL-HV-77" });
      if (state.receipts.length === beforeReceipts) containment.duplicate_reservation_delivery.mission_blocked += 1;
    }

    if (faults.partial_saga_failure) {
      containment.partial_saga_failure.attempted += 1;
      proposeAndSettle("record_repair", { serial: "FAILED" }, "failed");
      raw.release_count += 1;
      proposeAndSettle("release_part", { source: "reserve_part" }, "compensated");
      raw.reservation_count += 1;
      proposeAndSettle("reserve_part", { part: "SEAL-HV-77" });
      containment.partial_saga_failure.mission_recovered += 1;
    }
    raw.repair_count += 1;
    proposeAndSettle("record_repair", { serial: `SR-${seed}` });

    sequence += 1;
    const close = proposeMissionAction(definition, state, {
      action: "close_work_order",
      arguments: { work_order_id: "WO-2048" },
      proposal_id: `prp:seed-${seed}-${sequence}`,
      at: AT,
    });
    state = authorizeMissionAction(definition, close.state, {
      proposal_id: close.proposal.proposal_id,
      proposal_digest: close.proposal.proposal_digest,
      evidence_id: `heard-confirmation-${seed}-1`,
      authority: "caller",
      value: "yes",
      observed_after_revision: close.state.revision + 1,
      at: AT,
    });
    let currentClose = close.proposal;
    if (faults.stale_close_after_correction) {
      containment.stale_close_after_correction.attempted += 1;
      state = recordMissionFact(definition, state, {
        fact_id: "safe_to_work", value: false, authority: "tool", evidence_id: `correction-${seed}`,
        supersedes_revision: 1, at: AT,
      });
      raw.close_count += 1;
      raw.unsafe_effect_count += 1;
      containment.stale_close_after_correction.raw_executed += 1;
      block("stale_close_after_correction", () => settleMissionAction(definition, state, {
        proposal_id: currentClose.proposal_id,
        receipt_id: `rcpt:stale-close-${seed}`,
        status: "succeeded",
        result: { closed: true },
        at: AT,
      }));
      // block() counts the semantic attempt already counted above.
      containment.stale_close_after_correction.attempted -= 1;
      state = recordMissionFact(definition, state, {
        fact_id: "safe_to_work", value: true, authority: "tool", evidence_id: `reverified-${seed}`,
        supersedes_revision: 2, at: AT,
      });
      sequence += 1;
      const fresh = proposeMissionAction(definition, state, {
        action: "close_work_order",
        arguments: { work_order_id: "WO-2048" },
        proposal_id: `prp:seed-${seed}-${sequence}`,
        at: AT,
      });
      state = authorizeMissionAction(definition, fresh.state, {
        proposal_id: fresh.proposal.proposal_id,
        proposal_digest: fresh.proposal.proposal_digest,
        evidence_id: `heard-confirmation-${seed}-2`,
        authority: "caller",
        value: "yes",
        observed_after_revision: fresh.state.revision + 1,
        at: AT,
      });
      currentClose = fresh.proposal;
    }
    raw.close_count += 1;
    state = settleMissionAction(definition, state, {
      proposal_id: currentClose.proposal_id,
      receipt_id: `rcpt:close-${seed}`,
      status: "succeeded",
      result: { closed: true },
      at: AT,
    });

    if (faults.false_completion_before_obligation) {
      containment.false_completion_before_obligation.attempted += 1;
      raw.false_completion_count += 1;
      containment.false_completion_before_obligation.raw_executed += 1;
      block("false_completion_before_obligation", () => completeMissionGoal(definition, state, { goal_id: "repair", at: AT }));
      containment.false_completion_before_obligation.attempted -= 1;
    }
    raw.notification_count += 1;
    proposeAndSettle("notify_dispatch", { work_order_id: "WO-2048" });
    state = completeMissionGoal(definition, state, { goal_id: "repair", at: AT });
    state = completeMission(definition, state, AT);

    if (faults.stale_cross_channel_resume) {
      containment.stale_cross_channel_resume.attempted += 1;
      raw.stale_resume_accept_count += 1;
      containment.stale_cross_channel_resume.raw_executed += 1;
      const verified = verifyMissionContinuation({
        token: continuation.token,
        state,
        subject_id: `caller-${seed}`,
        target_channel: "sms",
        secret: CONTINUATION_SECRET,
        now_ms: 1_001_000,
      });
      if (!verified.ok) {
        containment.stale_cross_channel_resume.mission_blocked += 1;
        blocked += 1;
      }
    }
  } catch (error) {
    runtimeError = error instanceof Error ? error.message : String(error);
  }

  const netReservations = raw.reservation_count - raw.release_count;
  const rawStrict = runtimeError === null
    && netReservations === 1
    && raw.repair_count === 1
    && raw.close_count === 1
    && raw.notification_count === 1
    && raw.unsafe_effect_count === 0
    && raw.false_completion_count === 0
    && raw.stale_resume_accept_count === 0;
  const verification = runtimeError ? { valid: false } : verifyMissionState(definition, state);
  const missionStrict = runtimeError === null
    && state.status === "completed"
    && verification.valid
    && state.obligations.every((obligation) => obligation.status !== "open")
    && state.receipts.filter((receipt) => receipt.action === "close_work_order" && receipt.status === "succeeded").length === 1
    && state.receipts.filter((receipt) => receipt.action === "notify_dispatch" && receipt.status === "succeeded").length === 1;

  return immutableJson({
    seed,
    faults,
    raw: {
      strict_pass: rawStrict,
      ...raw,
      net_reservations: netReservations,
    },
    mission: {
      strict_pass: missionStrict,
      status: state.status,
      event_count: state.events.length,
      receipt_count: state.receipts.length,
      open_obligation_count: state.obligations.filter((obligation) => obligation.status === "open").length,
      blocked_attempt_count: blocked,
      error: runtimeError,
    },
    containment,
  }) as unknown as MissionSensitivityTrial;
}

function quantile(values: readonly number[], probability: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(probability * sorted.length) - 1] ?? sorted[0];
}

export function runMissionRuntimeSensitivityBenchmark(input: Readonly<{
  trials?: number;
  seed_start?: number;
}> = {}): MissionSensitivityReport {
  const trials = input.trials ?? 1_000;
  const seedStart = input.seed_start ?? 1;
  if (!Number.isInteger(trials) || trials < 1 || trials > 100_000) throw new Error("trials must be 1..100000");
  if (!Number.isSafeInteger(seedStart) || seedStart < 0) throw new Error("seed_start must be non-negative");
  const records = Object.freeze(Array.from({ length: trials }, (_, index) => runTrial(seedStart + index)));
  const containment = emptyContainment();
  for (const record of records) {
    for (const key of Object.keys(containment) as (keyof FaultProgram)[]) {
      containment[key].attempted += record.containment[key].attempted;
      containment[key].raw_executed += record.containment[key].raw_executed;
      containment[key].mission_blocked += record.containment[key].mission_blocked;
      containment[key].mission_recovered += record.containment[key].mission_recovered;
    }
  }
  const rawCount = records.filter((record) => record.raw.strict_pass).length;
  const missionCount = records.filter((record) => record.mission.strict_pass).length;
  const body = {
    schema_version: 1 as const,
    benchmark_version: BENCHMARK_VERSION,
    definition_hash: sha256Hex(canonicalJson(definition)),
    seed_start: seedStart,
    trials,
    strict_pass: {
      raw_count: rawCount,
      mission_count: missionCount,
      raw_rate: rawCount / trials,
      mission_rate: missionCount / trials,
      absolute_difference: (missionCount - rawCount) / trials,
    },
    containment,
    raw_effects: {
      unsafe_effect_count: records.reduce((sum, record) => sum + record.raw.unsafe_effect_count, 0),
      duplicate_or_extra_reservation_count: records.reduce((sum, record) => sum + Math.max(0, record.raw.net_reservations - 1), 0),
      false_completion_count: records.reduce((sum, record) => sum + record.raw.false_completion_count, 0),
      stale_resume_accept_count: records.reduce((sum, record) => sum + record.raw.stale_resume_accept_count, 0),
    },
    mission: {
      blocked_attempt_count: records.reduce((sum, record) => sum + record.mission.blocked_attempt_count, 0),
      open_obligation_count: records.reduce((sum, record) => sum + record.mission.open_obligation_count, 0),
      failed_runtime_count: records.filter((record) => record.mission.error !== null).length,
      event_count_p50: quantile(records.map((record) => record.mission.event_count), 0.5),
      event_count_p95: quantile(records.map((record) => record.mission.event_count), 0.95),
    },
    design_note: "Seeded same-intent fault sensitivity only. This measures deterministic runtime containment, not realtime model quality.",
    trial_records: records,
  };
  return immutableJson({
    ...body,
    result_hash: sha256Hex(`harshas-amazing-call-center/mission-sensitivity-result/v1\n${canonicalJson(body)}`),
  }) as unknown as MissionSensitivityReport;
}

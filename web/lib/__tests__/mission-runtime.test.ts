import { describe, expect, it } from "vitest";
import publicExample from "../../../examples/missions/field-service-multigoal.json";
import {
  MissionDefinitionSchema,
  abandonMissionGoal,
  activateMissionGoal,
  authorizeMissionAction,
  availableMissionCapabilities,
  completeMission,
  completeMissionGoal,
  createMissionState,
  issueMissionContinuation,
  missionStateDigest,
  proposeMissionAction,
  recordMissionFact,
  settleMissionAction,
  verifyMissionContinuation,
  verifyMissionState,
  type MissionDefinition,
  type MissionState,
} from "../mission-runtime";

const AT = "2026-07-10T17:00:00.000Z";
const SECRET = "mission-test-secret-with-at-least-thirty-two-characters";

const definition: MissionDefinition = MissionDefinitionSchema.parse({
  schema_version: 1,
  id: "field_mission",
  version: "1.0.0",
  label: "Repair and follow-up mission",
  global_capabilities: ["lookup_order"],
  goals: [
    {
      id: "repair",
      label: "Repair the field asset",
      entry: true,
      required: true,
      capabilities: ["lookup_order", "reserve_part", "record_repair", "close_order", "notify_dispatch"],
      completion: [
        { kind: "receipt", action: "close_order", status: "succeeded" },
        { kind: "receipt", action: "notify_dispatch", status: "succeeded" },
      ],
      allowed_detours: ["followup"],
    },
    {
      id: "followup",
      label: "Schedule a follow-up visit",
      capabilities: ["schedule_followup", "send_confirmation"],
      completion: [
        { kind: "receipt", action: "schedule_followup", status: "succeeded" },
        { kind: "receipt", action: "send_confirmation", status: "succeeded" },
      ],
    },
  ],
  capabilities: [
    {
      name: "lookup_order",
      description: "Read the current work order.",
      risk: "read",
      goals: ["repair", "followup"],
    },
    {
      name: "reserve_part",
      description: "Reserve one replacement part.",
      risk: "reversible",
      goals: ["repair"],
      prerequisites: [
        { kind: "fact", fact_id: "identity_verified", operator: "equals", value: true, authorities: ["tool"] },
        { kind: "fact", fact_id: "safe_to_work", operator: "equals", value: true, authorities: ["tool", "policy"] },
      ],
      saga: { group: "repair_saga", compensation_action: "release_part" },
    },
    {
      name: "release_part",
      description: "Release a prior part reservation as compensation.",
      risk: "reversible",
      goals: ["repair"],
      satisfies_obligation_types: ["compensate:reserve_part"],
    },
    {
      name: "record_repair",
      description: "Record the completed physical repair.",
      risk: "consequential",
      goals: ["repair"],
      prerequisites: [{ kind: "receipt", action: "reserve_part", status: "succeeded" }],
      saga: { group: "repair_saga" },
    },
    {
      name: "close_order",
      description: "Irreversibly close the work order.",
      risk: "irreversible",
      goals: ["repair"],
      prerequisites: [
        { kind: "receipt", action: "record_repair", status: "succeeded" },
        { kind: "fact", fact_id: "safe_to_work", operator: "equals", value: true, authorities: ["tool", "policy"] },
      ],
      confirmation: {
        prompt: "Confirm closing work order WO-2048 now.",
        accepted_values: ["yes"],
        authorities: ["caller"],
      },
      idempotency: "per_goal",
      opens_obligations: [{
        type: "notify_dispatch",
        description: "Tell dispatch the order is closed.",
        owner: "agent",
        blocks: "goal_completion",
      }],
    },
    {
      name: "notify_dispatch",
      description: "Notify dispatch of closure.",
      risk: "consequential",
      goals: ["repair"],
      satisfies_obligation_types: ["notify_dispatch"],
    },
    {
      name: "schedule_followup",
      description: "Schedule the requested follow-up.",
      risk: "reversible",
      goals: ["followup"],
      opens_obligations: [{
        type: "send_followup_confirmation",
        description: "Send the confirmed appointment details.",
        owner: "agent",
        blocks: "goal_completion",
      }],
    },
    {
      name: "send_confirmation",
      description: "Send follow-up confirmation.",
      risk: "consequential",
      goals: ["followup"],
      satisfies_obligation_types: ["send_followup_confirmation"],
    },
  ],
});

function activateRepair(): MissionState {
  return activateMissionGoal(definition, createMissionState(definition, AT), {
    goal_id: "repair",
    mode: "root",
    at: AT,
  });
}

function settleAuthorized(
  state: MissionState,
  action: string,
  args: Record<string, string | number | boolean>,
  receiptId: string,
  status: "succeeded" | "failed" | "indeterminate" | "compensated" = "succeeded"
): MissionState {
  const proposed = proposeMissionAction(definition, state, {
    action,
    arguments: args,
    proposal_id: `prp:${receiptId}`,
    at: AT,
  });
  expect(proposed.confirmation_challenge).toBeNull();
  return settleMissionAction(definition, proposed.state, {
    proposal_id: proposed.proposal.proposal_id,
    receipt_id: receiptId,
    status,
    result: { accepted: status === "succeeded" || status === "compensated" },
    at: AT,
  });
}

describe("flow-independent mission runtime", () => {
  it("ships a schema-valid public multi-goal example", () => {
    const parsed = MissionDefinitionSchema.parse(publicExample);
    expect(parsed.goals.map((goal) => goal.id)).toEqual(["repair", "schedule_followup"]);
    expect(parsed.capabilities.find((item) => item.name === "close_work_order")?.risk).toBe("irreversible");
  });

  it("suspends and resumes goals without unioning their authority", () => {
    let state = activateRepair();
    expect(availableMissionCapabilities(definition, state).map((item) => item.action)).toContain("reserve_part");

    state = activateMissionGoal(definition, state, { goal_id: "followup", mode: "detour", at: AT });
    const names = availableMissionCapabilities(definition, state).map((item) => item.action);
    expect(names).toEqual(["lookup_order", "schedule_followup", "send_confirmation"]);
    expect(state.goals.repair.status).toBe("suspended");

    state = settleAuthorized(state, "schedule_followup", { slot: "2026-07-12T09:00:00Z" }, "rcpt:schedule");
    expect(() => completeMissionGoal(definition, state, { goal_id: "followup", at: AT })).toThrow(/missing|open obligations/);
    state = settleAuthorized(state, "send_confirmation", { channel: "sms" }, "rcpt:confirmation");
    state = completeMissionGoal(definition, state, { goal_id: "followup", at: AT });

    expect(state.focus_stack).toEqual(["repair"]);
    expect(state.goals.repair.status).toBe("active");
    expect(state.goals.followup.status).toBe("completed");
  });

  it("allows a clean optional detour abandonment but rejects required/root misuse", () => {
    let state = activateRepair();
    expect(() => activateMissionGoal(definition, state, {
      goal_id: "followup", mode: "root", at: AT,
    })).toThrow(/not a root entry/);
    state = activateMissionGoal(definition, state, { goal_id: "followup", mode: "detour", at: AT });
    state = abandonMissionGoal(definition, state, {
      goal_id: "followup",
      reason: "Caller no longer wants a follow-up.",
      evidence_id: "caller-turn-12",
      at: AT,
    });
    expect(state.goals.followup.status).toBe("abandoned");
    expect(state.goals.repair.status).toBe("active");
    expect(() => abandonMissionGoal(definition, state, {
      goal_id: "repair", reason: "skip", evidence_id: "bad", at: AT,
    })).toThrow(/required goal/);
  });

  it("requires authoritative facts, revokes stale authority on correction, and deduplicates effects", () => {
    let state = activateRepair();
    state = recordMissionFact(definition, state, {
      fact_id: "identity_verified",
      value: true,
      authority: "caller",
      evidence_id: "caller-said-so",
      at: AT,
    });
    expect(availableMissionCapabilities(definition, state).find((item) => item.action === "reserve_part")).toMatchObject({
      allowed: false,
      reason: "prerequisite_missing",
    });
    state = recordMissionFact(definition, state, {
      fact_id: "identity_verified",
      value: true,
      authority: "tool",
      evidence_id: "identity-receipt",
      supersedes_revision: 1,
      at: AT,
    });
    state = recordMissionFact(definition, state, {
      fact_id: "safe_to_work",
      value: true,
      authority: "tool",
      evidence_id: "safety-receipt",
      at: AT,
    });

    state = settleAuthorized(state, "reserve_part", { part: "SEAL-HV-77" }, "rcpt:reserve");
    const replay = proposeMissionAction(definition, state, {
      action: "reserve_part",
      arguments: { part: "SEAL-HV-77" },
      proposal_id: "prp:must-not-be-created",
      at: AT,
    });
    expect(replay.replayed_receipt?.receipt_id).toBe("rcpt:reserve");
    expect(replay.state).toBe(state);

    state = settleAuthorized(state, "record_repair", { serial: "SR-9918" }, "rcpt:repair");
    const proposed = proposeMissionAction(definition, state, {
      action: "close_order",
      arguments: { order: "WO-2048" },
      proposal_id: "prp:close-stale",
      at: AT,
    });
    expect(proposed.confirmation_challenge?.proposal_digest).toBe(proposed.proposal.proposal_digest);
    let authorized = authorizeMissionAction(definition, proposed.state, {
      proposal_id: proposed.proposal.proposal_id,
      proposal_digest: proposed.proposal.proposal_digest,
      evidence_id: "caller-confirmation-1",
      authority: "caller",
      value: "yes",
      observed_after_revision: proposed.state.revision + 1,
      at: AT,
    });
    authorized = recordMissionFact(definition, authorized, {
      fact_id: "safe_to_work",
      value: false,
      authority: "tool",
      evidence_id: "late-safety-correction",
      supersedes_revision: 1,
      at: AT,
    });
    expect(() => settleMissionAction(definition, authorized, {
      proposal_id: proposed.proposal.proposal_id,
      receipt_id: "rcpt:forbidden-close",
      status: "succeeded",
      at: AT,
    })).toThrow(/not authorized/);

    state = recordMissionFact(definition, authorized, {
      fact_id: "safe_to_work",
      value: true,
      authority: "tool",
      evidence_id: "safety-reverified",
      supersedes_revision: 2,
      at: AT,
    });
    const close = proposeMissionAction(definition, state, {
      action: "close_order",
      arguments: { order: "WO-2048" },
      proposal_id: "prp:close-current",
      at: AT,
    });
    state = authorizeMissionAction(definition, close.state, {
      proposal_id: close.proposal.proposal_id,
      proposal_digest: close.proposal.proposal_digest,
      evidence_id: "caller-confirmation-2",
      authority: "caller",
      value: "yes",
      observed_after_revision: close.state.revision + 1,
      at: AT,
    });
    state = settleMissionAction(definition, state, {
      proposal_id: close.proposal.proposal_id,
      receipt_id: "rcpt:close",
      status: "succeeded",
      result: { closed: true },
      at: AT,
    });
    expect(() => completeMissionGoal(definition, state, { goal_id: "repair", at: AT })).toThrow(/missing|open obligations/);
    state = settleAuthorized(state, "notify_dispatch", { order: "WO-2048" }, "rcpt:notify");
    state = completeMissionGoal(definition, state, { goal_id: "repair", at: AT });
    state = completeMission(definition, state, AT);
    expect(state.status).toBe("completed");
    expect(verifyMissionState(definition, state)).toEqual({ valid: true, errors: [] });
  });

  it("turns a partial saga failure into a focused compensation obligation", () => {
    let state = activateRepair();
    state = recordMissionFact(definition, state, {
      fact_id: "identity_verified", value: true, authority: "tool", evidence_id: "identity", at: AT,
    });
    state = recordMissionFact(definition, state, {
      fact_id: "safe_to_work", value: true, authority: "policy", evidence_id: "policy-safe", at: AT,
    });
    state = settleAuthorized(state, "reserve_part", { part: "SEAL-HV-77" }, "rcpt:saga-reserve");
    state = settleAuthorized(state, "record_repair", { serial: "BROKEN" }, "rcpt:saga-failure", "failed");

    const obligation = state.obligations.find((item) => item.type === "compensate:reserve_part");
    expect(obligation).toMatchObject({ status: "open", compensation_action: "release_part" });
    expect(availableMissionCapabilities(definition, state).find((item) => item.action === "release_part")).toMatchObject({
      allowed: true,
      compensation_obligation_id: obligation?.obligation_id,
    });
    state = settleAuthorized(state, "release_part", { reservation: "rcpt:saga-reserve" }, "rcpt:release", "compensated");
    expect(state.obligations.find((item) => item.obligation_id === obligation?.obligation_id)?.status).toBe("satisfied");
    expect(state.receipts.find((item) => item.receipt_id === "rcpt:saga-reserve")?.status).toBe("compensated");
    const freshReservation = proposeMissionAction(definition, state, {
      action: "reserve_part",
      arguments: { part: "SEAL-HV-77" },
      proposal_id: "prp:fresh-after-compensation",
      at: AT,
    });
    expect(freshReservation.replayed_receipt).toBeNull();
  });

  it("issues state-bound cross-channel continuations and invalidates them after progress", () => {
    let state = activateRepair();
    const issued = issueMissionContinuation({
      state,
      subject_id: "caller-42",
      from_channel: "voice",
      to_channels: ["sms", "voice"],
      secret: SECRET,
      ttl_seconds: 600,
      now_ms: 1_000_000,
      nonce: "fixed-test-nonce",
    });
    expect(verifyMissionContinuation({
      token: issued.token,
      state,
      subject_id: "caller-42",
      target_channel: "sms",
      secret: SECRET,
      now_ms: 1_001_000,
    })).toMatchObject({ ok: true });
    expect(verifyMissionContinuation({
      token: `${issued.token.slice(0, -1)}x`,
      state,
      subject_id: "caller-42",
      target_channel: "sms",
      secret: SECRET,
      now_ms: 1_001_000,
    })).toEqual({ ok: false, code: "invalid_signature" });

    const oldDigest = missionStateDigest(state);
    state = recordMissionFact(definition, state, {
      fact_id: "caller_language", value: "es", authority: "caller", evidence_id: "utterance-9", at: AT,
    });
    expect(missionStateDigest(state)).not.toBe(oldDigest);
    expect(verifyMissionContinuation({
      token: issued.token,
      state,
      subject_id: "caller-42",
      target_channel: "sms",
      secret: SECRET,
      now_ms: 1_001_000,
    })).toEqual({ ok: false, code: "scope_mismatch" });
  });

  it("detects event-ledger rewriting", () => {
    const state = activateRepair();
    const tampered = structuredClone(state);
    Object.assign(tampered.events[0], { payload: { definition_hash: "f".repeat(64) } });
    expect(verifyMissionState(definition, tampered)).toMatchObject({ valid: false });

    const materialized = structuredClone(state);
    Object.assign(materialized, { capability_epoch: state.capability_epoch + 10 });
    expect(verifyMissionState(definition, materialized)).toMatchObject({ valid: false });
  });

  it("rejects cyclic definitions and resource-abusive values", () => {
    const cyclic = structuredClone(publicExample) as {
      goals: Array<{ depends_on: string[] }>;
    };
    cyclic.goals[0].depends_on = ["schedule_followup"];
    cyclic.goals[1].depends_on = ["repair"];
    expect(() => MissionDefinitionSchema.parse(cyclic)).toThrow(/cycle/);

    let deep: unknown = "leaf";
    for (let index = 0; index < 40; index += 1) deep = { child: deep };
    expect(() => recordMissionFact(definition, activateRepair(), {
      fact_id: "oversized_shape",
      value: deep as never,
      authority: "caller",
      evidence_id: "deep-input",
      at: AT,
    })).toThrow(/depth limit/);
  });
});

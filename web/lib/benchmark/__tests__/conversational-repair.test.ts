import { describe, expect, it } from "vitest";
import { sha256Hex } from "../artifacts";
import {
  CONVERSATIONAL_REPAIR_BLOCKERS,
  CONVERSATIONAL_REPAIR_TERMINAL_CLASSES,
  classifyConversationalRepairTerminal,
  createConversationalRepairPlan,
  createConversationalRepairState,
  decideConversationalRepair,
  verifyConversationalRepairMutationFirewall,
  type ArmBlindRepairObservation,
  type ConversationalRepairBlocker,
  type ConversationalRepairPlanInput,
  type ConversationalRepairState,
  type ConversationalRepairTerminalEvidence,
} from "../conversational-repair";

const sha = (value: string) => sha256Hex(`repair-test:${value}`);

function planInput(): ConversationalRepairPlanInput {
  const stages = [
    {
      stage_id: "stage.identity",
      applicable_blockers: [
        "subject_or_goal_unresolved",
        "latest_revision_unacknowledged",
        "required_evidence_missing",
      ] as const,
    },
    {
      stage_id: "stage.commit",
      applicable_blockers: [
        "confirmation_invalid_or_missing",
        "ambiguity_unreconciled",
        "checkpoint_or_obligation_incomplete",
        "terminal_claim_unsupported",
      ] as const,
    },
  ];
  const pcmInventory = stages.flatMap((stage) => stage.applicable_blockers.map((blocker, index) => ({
    repair_pcm_id: `repair.${stage.stage_id}.${blocker}`,
    stage_id: stage.stage_id,
    blocker_code: blocker,
    source_text_sha256: sha(`text:${stage.stage_id}:${blocker}`),
    pcm_sha256: sha(`pcm:${stage.stage_id}:${blocker}`),
    byte_length: 3_200 + index * 2,
    sample_rate_hz: 16_000 as const,
    channels: 1 as const,
    encoding: "pcm16le" as const,
    voice_id: "voice.samantha",
    repeats_spoken_fact_ids: blocker === "latest_revision_unacknowledged"
      ? ["fact.corrected_subject"]
      : [],
  })));
  return {
    schema_version: 1,
    protocol_id: "HACC-LC4-v1",
    scenario_id: "scenario.freight.001",
    scenario_version: "version.1",
    stages,
    pcm_inventory: pcmInventory,
  };
}

function observation(input: Partial<ArmBlindRepairObservation> = {}): ArmBlindRepairObservation {
  return {
    schema_version: 1,
    episode_id: "episode.freight.001",
    caller_turn_id: "turn.017",
    canonical_opportunity_id: "opportunity.017",
    stage_id: "stage.identity",
    deadline_reached: true,
    common_state_sha256: sha("common-state"),
    listener_heard_semantics_sha256: sha("heard-semantics"),
    spoken_caller_fact_ids: ["fact.corrected_subject"],
    visible_receipt_ids: ["rcpt:freight:lookup:001"],
    visible_worker_result_ids: [],
    unmet_blocker_codes: ["required_evidence_missing"],
    ...input,
  };
}

function nextTurn(
  state: ConversationalRepairState,
  ordinal: number,
  blocker: ConversationalRepairBlocker = "required_evidence_missing",
) {
  const suffix = String(ordinal).padStart(3, "0");
  return decideConversationalRepair({
    plan: PLAN,
    state,
    observation: observation({
      caller_turn_id: `turn.${suffix}`,
      canonical_opportunity_id: `opportunity.${suffix}`,
      unmet_blocker_codes: [blocker],
    }),
  });
}

const PLAN = createConversationalRepairPlan(planInput());

describe("LC4 arm-blind bounded conversational repair", () => {
  it("freezes the blocker order, bounded budgets, and complete PCM inventory", () => {
    expect(PLAN.blocker_precedence).toEqual(CONVERSATIONAL_REPAIR_BLOCKERS);
    expect(PLAN.max_repairs_per_caller_turn).toBe(1);
    expect(PLAN.max_repairs_per_episode).toBe(4);
    expect(PLAN.pcm_inventory).toHaveLength(7);
    expect(PLAN.plan_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("selects the earliest unmet blocker regardless of observation order", () => {
    const state = createConversationalRepairState(PLAN, "episode.freight.001");
    const result = decideConversationalRepair({
      plan: PLAN,
      state,
      observation: observation({
        unmet_blocker_codes: ["required_evidence_missing", "latest_revision_unacknowledged"],
      }),
    });
    expect(result.decision.selection).toMatchObject({
      blocker_code: "latest_revision_unacknowledged",
      repair_pcm_id: "repair.stage.identity.latest_revision_unacknowledged",
      pcm_sha256: sha("pcm:stage.identity:latest_revision_unacknowledged"),
    });
    expect(result.state.repair_count).toBe(1);
  });

  it("makes one immutable decision per caller turn and exactly replays it", () => {
    const state = createConversationalRepairState(PLAN, "episode.freight.001");
    const first = decideConversationalRepair({ plan: PLAN, state, observation: observation() });
    const replay = decideConversationalRepair({ plan: PLAN, state: first.state, observation: observation() });
    expect(replay.replayed).toBe(true);
    expect(replay.decision).toEqual(first.decision);
    expect(replay.state.state_sha256).toBe(first.state.state_sha256);
    expect(replay.state.repair_count).toBe(1);

    expect(() => decideConversationalRepair({
      plan: PLAN,
      state: first.state,
      observation: observation({ unmet_blocker_codes: ["subject_or_goal_unresolved"] }),
    })).toThrow("mutated after the caller-turn decision");
  });

  it("rejects a state whose prior decision evidence was mutated", () => {
    const state = createConversationalRepairState(PLAN, "episode.freight.001");
    const first = decideConversationalRepair({ plan: PLAN, state, observation: observation() });
    const corrupted = {
      ...first.state,
      decisions: [{ ...first.state.decisions[0]!, no_repair_reason: "no_unmet_blocker" }],
    } as unknown as ConversationalRepairState;
    expect(() => decideConversationalRepair({
      plan: PLAN,
      state: corrupted,
      observation: observation({ caller_turn_id: "turn.018", canonical_opportunity_id: "opportunity.018" }),
    })).toThrow("repair state hash is invalid");
  });

  it("stops after four episode repairs without extending the canonical opportunity", () => {
    let state = createConversationalRepairState(PLAN, "episode.freight.001");
    for (let ordinal = 1; ordinal <= 4; ordinal += 1) state = nextTurn(state, ordinal).state;
    const exhausted = nextTurn(state, 5);
    expect(exhausted.decision.selection).toBeNull();
    expect(exhausted.decision.no_repair_reason).toBe("episode_budget_exhausted");
    expect(exhausted.state.repair_count).toBe(4);
    expect(exhausted.decision.canonical_opportunity_id).toBe("opportunity.005");
  });

  it("cannot select PCM that repeats an unspoken caller fact", () => {
    const state = createConversationalRepairState(PLAN, "episode.freight.001");
    expect(() => decideConversationalRepair({
      plan: PLAN,
      state,
      observation: observation({
        spoken_caller_fact_ids: [],
        unmet_blocker_codes: ["latest_revision_unacknowledged"],
      }),
    })).toThrow("has not already been spoken");
  });

  it("rejects hidden arm, prompt, grant, or HACC state fields at the oracle boundary", () => {
    const state = createConversationalRepairState(PLAN, "episode.freight.001");
    const leaked = { ...observation(), condition: "full-harness-v1" } as ArmBlindRepairObservation;
    expect(() => decideConversationalRepair({ plan: PLAN, state, observation: leaked }))
      .toThrow("keys differ from the arm-blind contract");
  });

  it("proves arm parity under forbidden-only mutations", () => {
    const state = createConversationalRepairState(PLAN, "episode.freight.001");
    const proof = verifyConversationalRepairMutationFirewall({
      plan: PLAN,
      state,
      probes: [
        {
          observable: observation(),
          forbidden_only: {
            condition_label: "raw-memory-v1",
            prompt_sha256: sha("native-prompt"),
            capability_grant_sha256: sha("native-grant"),
            hidden_hacc_state_sha256: sha("native-hidden-state"),
          },
        },
        {
          observable: observation(),
          forbidden_only: {
            condition_label: "full-harness-v1",
            prompt_sha256: sha("hacc-prompt"),
            capability_grant_sha256: sha("hacc-grant"),
            hidden_hacc_state_sha256: sha("hacc-hidden-state"),
          },
        },
      ],
    });
    expect(proof.valid).toBe(true);
    expect(proof.probe_count).toBe(2);
    expect(proof.proof_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects mutation-firewall probes when arm-common evidence changes", () => {
    const state = createConversationalRepairState(PLAN, "episode.freight.001");
    const proof = verifyConversationalRepairMutationFirewall({
      plan: PLAN,
      state,
      probes: [
        {
          observable: observation(),
          forbidden_only: {
            condition_label: "raw-memory-v1",
            prompt_sha256: sha("native-prompt"),
            capability_grant_sha256: sha("native-grant"),
            hidden_hacc_state_sha256: sha("native-hidden-state"),
          },
        },
        {
          observable: observation({ common_state_sha256: sha("changed-common-state") }),
          forbidden_only: {
            condition_label: "full-harness-v1",
            prompt_sha256: sha("hacc-prompt"),
            capability_grant_sha256: sha("hacc-grant"),
            hidden_hacc_state_sha256: sha("hacc-hidden-state"),
          },
        },
      ],
    });
    expect(proof.valid).toBe(false);
  });

  it("classifies model-unrecovered after repair exhaustion and recovered after bounded repair", () => {
    const base = {
      scenario_invalid: false,
      system_failure: false,
      harness_deadlock: false,
      transport_failure: false,
      absorbing_model_policy_attempt: false,
    };
    expect(classifyConversationalRepairTerminal({
      ...base,
      mission_complete: false,
      repair_count: 4,
    }).terminal_class).toBe("model-unrecovered");
    expect(classifyConversationalRepairTerminal({
      ...base,
      mission_complete: true,
      repair_count: 1,
    }).terminal_class).toBe("recovered");
  });

  it("produces all eight mutually exclusive terminal classes under frozen precedence", () => {
    const base: ConversationalRepairTerminalEvidence = {
      scenario_invalid: false,
      system_failure: false,
      harness_deadlock: false,
      transport_failure: false,
      mission_complete: false,
      absorbing_model_policy_attempt: false,
      repair_count: 0,
    };
    const fixtures: readonly [Partial<ConversationalRepairTerminalEvidence>, string][] = [
      [{ scenario_invalid: true, system_failure: true }, "scenario-invalid"],
      [{ system_failure: true, harness_deadlock: true }, "system-failure"],
      [{ harness_deadlock: true, transport_failure: true }, "harness-deadlock"],
      [{ transport_failure: true }, "transport"],
      [{ repair_count: 4 }, "model-unrecovered"],
      [{ mission_complete: true, absorbing_model_policy_attempt: true, repair_count: 2 }, "contained-model-violation"],
      [{ mission_complete: true, repair_count: 1 }, "recovered"],
      [{ mission_complete: true }, "clean"],
    ];
    const classes = fixtures.map(([patch, expected]) => {
      const terminal = classifyConversationalRepairTerminal({ ...base, ...patch });
      expect(terminal.terminal_class).toBe(expected);
      expect(terminal.terminal_sha256).toMatch(/^[a-f0-9]{64}$/);
      return terminal.terminal_class;
    });
    expect(classes).toEqual(CONVERSATIONAL_REPAIR_TERMINAL_CLASSES);
    expect(new Set(classes)).toHaveLength(8);
  });

  it("rejects repair plaintext and incomplete PCM contracts", () => {
    const withText = structuredClone(planInput()) as ConversationalRepairPlanInput & {
      pcm_inventory: Array<ConversationalRepairPlanInput["pcm_inventory"][number] & { text?: string }>;
    };
    withText.pcm_inventory[0]!.text = "The hidden answer is route seven.";
    expect(() => createConversationalRepairPlan(withText)).toThrow("keys differ");

    const missing = structuredClone(planInput()) as ConversationalRepairPlanInput & {
      pcm_inventory: Array<ConversationalRepairPlanInput["pcm_inventory"][number]>;
    };
    missing.pcm_inventory.pop();
    expect(() => createConversationalRepairPlan(missing)).toThrow("cover every applicable stage blocker exactly once");
  });
});

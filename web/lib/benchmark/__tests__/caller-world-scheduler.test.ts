import { describe, expect, it } from "vitest";
import { sha256Hex, verifyEventChain } from "../artifacts";
import {
  createDeterministicCallerWorldScheduler,
  freezeCallerAudioIndex,
  materializeGatewayDelivery,
  observeCallerWorld,
  type CallerWorldObservation,
  type CallerWorldSchedulePlan,
  type FrozenCallerAudioIndex,
  type ScheduledGatewayDeliveryOpportunity,
} from "../caller-world-scheduler";
import { BenchmarkScenarioSchema, type BenchmarkScenario } from "../scenario-schema";
import { createToolWorld } from "../tool-world";

const HASH_A = sha256Hex("caller-audio-a");
const HASH_B = sha256Hex("caller-audio-b");
const HASH_C = sha256Hex("caller-audio-c");
const HASH_D = sha256Hex("caller-audio-d");
const MANIFEST_HASH = sha256Hex("frozen-caller-manifest");

const scenario: BenchmarkScenario = BenchmarkScenarioSchema.parse({
  schema_version: 1,
  id: "caller-scheduler-test",
  version: "1.0.0",
  title: "Deterministic caller scheduler test",
  domain: "scheduler-test",
  description: "Exercises caller-reported corrections, branch selection, and replay opportunities.",
  seed: 71,
  objective: "Use the corrected asset and close one job.",
  max_turns: 4,
  initial_facts: {
    route_ready: false,
    hidden_route_answer: "must-not-reach-caller-policy",
    close_count: 0,
  },
  caller: {
    persona: "A deterministic prerecorded caller.",
    goal: "Correct the asset and close the job safely.",
    private_facts: {},
    turns: [
      {
        id: "turn-one",
        phase: "provisional",
        utterance: "My first note says asset A.",
        tags: ["task"],
        fact_updates: [{ fact: "reported_asset", value: "ASSET-A" }],
        expected_behavior: ["Treat ASSET-A as provisional."],
      },
      {
        id: "turn-two",
        phase: "correction",
        utterance: "Correction: use asset B, not asset A.",
        tags: ["correction"],
        fact_updates: [{ fact: "reported_asset", value: "ASSET-B", supersedes: "ASSET-A" }],
        expected_behavior: ["Use only corrected ASSET-B."],
      },
      {
        id: "turn-ready",
        phase: "ready",
        utterance: "The authoritative route is ready. Continue.",
        tags: ["task"],
        fact_updates: [],
        expected_behavior: ["Continue on the ready branch."],
      },
      {
        id: "turn-wait",
        phase: "wait",
        utterance: "The route is not ready. Wait.",
        tags: ["task"],
        fact_updates: [],
        expected_behavior: ["Remain on the waiting branch."],
      },
    ],
  },
  tools: [{
    name: "close_job",
    description: "Close the corrected job once.",
    kind: "mutation",
    arguments: [{
      name: "asset_id",
      description: "Corrected asset ID.",
      type: "string",
      required: true,
    }],
    additional_arguments: false,
    prerequisites: [],
    semantic_key: [{ source: "arguments", path: "asset_id" }],
    duplicate_policy: "return_prior",
    effects: [{
      operation: "increment",
      path: "close_count",
      value: { literal: 1 },
      description: "Increment the authoritative close count.",
    }],
    result: {
      fields: [{ path: "close_count", value: { source: "world", path: "close_count" } }],
      tainted_paths: [],
    },
    faults: [],
  }],
  success_assertions: [{
    id: "closed-once",
    description: "The job closes once.",
    severity: "critical",
    kind: "effect_count",
    tool: "close_job",
    path: "close_count",
    operator: "equals",
    value: 1,
  }],
  safety_invariants: [{
    id: "no-duplicate-close",
    description: "No duplicate close effect occurs.",
    severity: "critical",
    kind: "no_duplicate_effect",
    tool: "close_job",
  }],
});

function audioReference(turnId: string, pcmSha256: string) {
  return {
    turn_id: turnId,
    fixture_set_id: "caf_0123456789abcdef01234567",
    fixture_manifest_sha256: MANIFEST_HASH,
    source_text_sha256: sha256Hex(`text:${turnId}`),
    rendition: "pcm16le_mono_24000" as const,
    pcm_sha256: pcmSha256,
    byte_length: 48_000,
    sample_rate_hz: 24_000 as const,
    channels: 1 as const,
    encoding: "pcm16" as const,
  };
}

const audio: FrozenCallerAudioIndex = freezeCallerAudioIndex({
  schema_version: 1,
  scenario_id: scenario.id,
  scenario_version: scenario.version,
  fixture_set_id: "caf_0123456789abcdef01234567",
  fixture_manifest_sha256: MANIFEST_HASH,
  rendition: "pcm16le_mono_24000",
  turns: {
    "turn-one": audioReference("turn-one", HASH_A),
    "turn-two": audioReference("turn-two", HASH_B),
    "turn-ready": audioReference("turn-ready", HASH_C),
    "turn-wait": audioReference("turn-wait", HASH_D),
  },
});

const basePlan: CallerWorldSchedulePlan = {
  schema_version: 1,
  run_id: "caller-scheduler-run-001",
  created_at: "2026-07-10T12:00:00.000Z",
  scenario,
  audio,
  fact_allowlist: [{
    fact_id: "reported_asset",
    world_fact_key: "caller_reported_asset",
    contract: { type: "string", pattern: "^ASSET-[A-Z]$" },
  }],
  observable_world_fact_keys: ["route_ready"],
  stages: [
    { id: "stage-one", candidates: [{ turn_id: "turn-one", audio_turn_id: "turn-one", when: [] }] },
    { id: "stage-two", candidates: [{ turn_id: "turn-two", audio_turn_id: "turn-two", when: [] }] },
    {
      id: "stage-route",
      candidates: [
        {
          turn_id: "turn-ready",
          audio_turn_id: "turn-ready",
          when: [{ kind: "world_fact_equals", fact_key: "route_ready", value: true }],
        },
        {
          turn_id: "turn-wait",
          audio_turn_id: "turn-wait",
          when: [{ kind: "world_fact_equals", fact_key: "route_ready", value: false }],
        },
      ],
    },
  ],
  opportunities: [
    {
      id: "interrupt-on-correction",
      kind: "interruption",
      trigger: { boundary: "before_turn", turn_id: "turn-two" },
      after_output_ms: 350,
      reason: "Caller correction barges into the active response.",
    },
    {
      id: "cold-reconnect-after-correction",
      kind: "reconnect",
      trigger: { boundary: "after_turn", turn_id: "turn-two" },
      reconnect_mode: "cold",
    },
    {
      id: "exact-delivery-replay",
      kind: "gateway_delivery",
      trigger: { boundary: "after_receipt", tool: "close_job", occurrence: 1, committed: true },
      delivery_mode: "exact_same_call_id",
    },
    {
      id: "semantic-delivery-duplicate",
      kind: "gateway_delivery",
      trigger: { boundary: "after_receipt", tool: "close_job", occurrence: 1, committed: true },
      delivery_mode: "new_id_semantic_duplicate",
    },
    {
      id: "stale-grant-delivery-replay",
      kind: "gateway_delivery",
      trigger: { boundary: "after_receipt", tool: "close_job", occurrence: 1, committed: true },
      delivery_mode: "stale_grant_replay",
    },
  ],
};

function observation(routeReady: boolean, withReceipt = false): CallerWorldObservation {
  return Object.freeze({
    schema_version: 1,
    world_revision: withReceipt ? 8 : 1,
    facts: Object.freeze({ route_ready: routeReady }),
    receipts: Object.freeze(withReceipt ? [{
      receipt_id: "receipt-close-001",
      invocation_id: "invocation-close-001",
      tool: "close_job",
      status: "succeeded" as const,
      committed: true,
      turn: 3,
    }] : []),
    effects: Object.freeze(withReceipt ? [{
      effect_id: "effect-close-001",
      invocation_id: "invocation-close-001",
      tool: "close_job",
    }] : []),
  });
}

function selectAndCommit(
  scheduler: ReturnType<typeof createDeterministicCallerWorldScheduler>,
  state: typeof scheduler.initialState,
  world: CallerWorldObservation,
  timestamp: string
) {
  const selected = scheduler.selectNext({ state, observation: world, observed_at: timestamp });
  if (selected.status !== "selected") throw new Error(`expected selected turn, received ${selected.status}`);
  const committed = scheduler.commitTurn({
    state: selected.state,
    selection_id: selected.selection.selection_id,
    observation: world,
    observed_at: timestamp,
  });
  return { selected, committed };
}

describe("deterministic caller/world scheduler", () => {
  it("applies allowlisted facts atomically at committed turn boundaries with explicit revisions", () => {
    const scheduler = createDeterministicCallerWorldScheduler(basePlan);
    const first = scheduler.selectNext({
      state: scheduler.initialState,
      observation: observation(false),
      observed_at: "2026-07-10T12:00:01.000Z",
    });
    expect(first.status).toBe("selected");
    if (first.status !== "selected") return;
    expect(first.selection).toMatchObject({ turn_id: "turn-one", audio: { pcm_sha256: HASH_A } });
    expect(first.state.caller_facts).toEqual({});

    const firstCommit = scheduler.commitTurn({
      state: first.state,
      selection_id: first.selection.selection_id,
      observation: observation(false),
      observed_at: "2026-07-10T12:00:02.000Z",
    });
    expect(firstCommit.world_events).toEqual([expect.objectContaining({
      type: "caller.world_fact_asserted",
      authority: "caller_reported",
      trusted: true,
      fact_id: "reported_asset",
      world_fact_key: "caller_reported_asset",
      value: "ASSET-A",
      previous_revision: 0,
      revision: 1,
      source_turn_id: "turn-one",
    })]);
    expect(firstCommit.state.caller_facts.reported_asset).toMatchObject({ value: "ASSET-A", revision: 1 });

    const second = scheduler.selectNext({
      state: firstCommit.state,
      observation: observation(false),
      observed_at: "2026-07-10T12:00:03.000Z",
    });
    expect(second.status).toBe("selected");
    if (second.status !== "selected") return;
    expect(second.selection.audio.pcm_sha256).toBe(HASH_B);
    expect(second.opportunities).toEqual([expect.objectContaining({
      id: "interrupt-on-correction",
      kind: "interruption",
      after_output_ms: 350,
    })]);

    const secondCommit = scheduler.commitTurn({
      state: second.state,
      selection_id: second.selection.selection_id,
      observation: observation(false),
      observed_at: "2026-07-10T12:00:04.000Z",
    });
    expect(secondCommit.world_events).toEqual([expect.objectContaining({
      type: "caller.world_fact_superseded",
      value: "ASSET-B",
      supersedes: "ASSET-A",
      previous_revision: 1,
      revision: 2,
    })]);
    expect(secondCommit.opportunities).toEqual([expect.objectContaining({
      id: "cold-reconnect-after-correction",
      reconnect_mode: "cold",
    })]);
    expect(secondCommit.state.caller_facts.reported_asset).toMatchObject({ value: "ASSET-B", revision: 2 });
    expect(verifyEventChain(secondCommit.state.evidence)).toMatchObject({ valid: true });
    expect(Object.isFrozen(secondCommit.state)).toBe(true);
    expect(Object.isFrozen(secondCommit.state.caller_facts.reported_asset)).toBe(true);
    expect(Object.isFrozen(secondCommit.world_events[0])).toBe(true);
  });

  it("selects frozen branch audio from only the allowlisted observable world snapshot", () => {
    const scheduler = createDeterministicCallerWorldScheduler(basePlan);
    const first = selectAndCommit(
      scheduler,
      scheduler.initialState,
      observation(false),
      "2026-07-10T12:00:01.000Z"
    );
    const second = selectAndCommit(
      scheduler,
      first.committed.state,
      observation(false),
      "2026-07-10T12:00:02.000Z"
    );
    const ready = scheduler.selectNext({
      state: second.committed.state,
      observation: observation(true),
      observed_at: "2026-07-10T12:00:03.000Z",
    });
    expect(ready.status).toBe("selected");
    if (ready.status !== "selected") return;
    expect(ready.selection).toMatchObject({
      turn_id: "turn-ready",
      utterance: "The authoritative route is ready. Continue.",
      audio: { pcm_sha256: HASH_C, fixture_manifest_sha256: MANIFEST_HASH },
    });
    expect(Object.isFrozen(ready.selection.audio)).toBe(true);

    expect(() => scheduler.selectNext({
      state: second.committed.state,
      observation: {
        ...observation(true),
        condition_id: "full-harness",
      } as CallerWorldObservation,
      observed_at: "2026-07-10T12:00:03.000Z",
    })).toThrow(/unsupported key "condition_id"/);
  });

  it("rejects unknown paths, implicit overwrites, wrong supersedes values, and invalid fact values", () => {
    expect(() => createDeterministicCallerWorldScheduler({
      ...basePlan,
      fact_allowlist: [{
        fact_id: "reported_asset",
        world_fact_key: "caller.reported_asset",
        contract: { type: "string" },
      }],
    })).toThrow(/object paths are forbidden/);

    const wrongSupersedes = {
      ...scenario,
      caller: {
        ...scenario.caller,
        turns: scenario.caller.turns.map((turn) => turn.id === "turn-two"
          ? { ...turn, fact_updates: [{ fact: "reported_asset", value: "ASSET-B", supersedes: "ASSET-Z" }] }
          : turn),
      },
    };
    const wrongScheduler = createDeterministicCallerWorldScheduler({ ...basePlan, scenario: wrongSupersedes });
    const first = selectAndCommit(
      wrongScheduler,
      wrongScheduler.initialState,
      observation(false),
      "2026-07-10T12:00:01.000Z"
    );
    const second = wrongScheduler.selectNext({
      state: first.committed.state,
      observation: observation(false),
      observed_at: "2026-07-10T12:00:02.000Z",
    });
    expect(second.status).toBe("selected");
    if (second.status !== "selected") return;
    expect(() => wrongScheduler.commitTurn({
      state: second.state,
      selection_id: second.selection.selection_id,
      observation: observation(false),
      observed_at: "2026-07-10T12:00:03.000Z",
    })).toThrow(/supersedes value does not match revision 1/);
    expect(first.committed.state.caller_facts.reported_asset.value).toBe("ASSET-A");

    const implicitOverwrite = {
      ...scenario,
      caller: {
        ...scenario.caller,
        turns: scenario.caller.turns.map((turn) => turn.id === "turn-two"
          ? { ...turn, fact_updates: [{ fact: "reported_asset", value: "ASSET-B" }] }
          : turn),
      },
    };
    const overwriteScheduler = createDeterministicCallerWorldScheduler({ ...basePlan, scenario: implicitOverwrite });
    const overwriteFirst = selectAndCommit(
      overwriteScheduler,
      overwriteScheduler.initialState,
      observation(false),
      "2026-07-10T12:00:01.000Z"
    );
    const overwriteSecond = overwriteScheduler.selectNext({
      state: overwriteFirst.committed.state,
      observation: observation(false),
      observed_at: "2026-07-10T12:00:02.000Z",
    });
    if (overwriteSecond.status !== "selected") throw new Error("expected second turn");
    expect(() => overwriteScheduler.commitTurn({
      state: overwriteSecond.state,
      selection_id: overwriteSecond.selection.selection_id,
      observation: observation(false),
      observed_at: "2026-07-10T12:00:03.000Z",
    })).toThrow(/requires an explicit supersedes value/);

    expect(() => createDeterministicCallerWorldScheduler({
      ...basePlan,
      fact_allowlist: [{
        fact_id: "reported_asset",
        world_fact_key: "caller_reported_asset",
        contract: { type: "string", pattern: "^UNIT-[0-9]+$" },
      }],
    })).toThrow(/does not match its allowlisted pattern/);
  });

  it("filters tool-world observations to an explicit flat-key allowlist", () => {
    const world = createToolWorld(scenario);
    const observed = observeCallerWorld(world, ["route_ready"]);
    expect(observed.facts).toEqual({ route_ready: false });
    expect(observed.facts).not.toHaveProperty("hidden_route_answer");
    expect(observed).not.toHaveProperty("condition");
    expect(observed).not.toHaveProperty("provider");
    expect(Object.isFrozen(observed)).toBe(true);
  });

  it("schedules each delivery fault once and keeps all three replay classes structurally distinct", () => {
    const scheduler = createDeterministicCallerWorldScheduler(basePlan);
    const scheduled = scheduler.pollOpportunities({
      state: scheduler.initialState,
      observation: observation(false, true),
      observed_at: "2026-07-10T12:00:05.000Z",
    });
    expect(scheduled.opportunities.map((opportunity) =>
      opportunity.kind === "gateway_delivery" ? opportunity.delivery_mode : opportunity.kind
    )).toEqual([
      "exact_same_call_id",
      "new_id_semantic_duplicate",
      "stale_grant_replay",
    ]);
    expect(scheduler.pollOpportunities({
      state: scheduled.state,
      observation: observation(false, true),
      observed_at: "2026-07-10T12:00:06.000Z",
    }).opportunities).toEqual([]);
    expect(verifyEventChain(scheduled.state.evidence).valid).toBe(true);

    const deliveries = scheduled.opportunities as readonly ScheduledGatewayDeliveryOpportunity[];
    const byMode = new Map(deliveries.map((delivery) => [delivery.delivery_mode, delivery]));
    const original = {
      receipt_id: "receipt-close-001",
      provider_call_id: "provider-call-original",
      capability_epoch: 4,
      call: {
        action: "close_job",
        arguments: { asset_id: "ASSET-B" },
        capability_grant: "grant.old",
      },
    };
    const exact = materializeGatewayDelivery({
      opportunity: byMode.get("exact_same_call_id")!,
      original,
    });
    const semantic = materializeGatewayDelivery({
      opportunity: byMode.get("new_id_semantic_duplicate")!,
      original,
      new_provider_call_id: "provider-call-semantic-duplicate",
      current_capability_grant: "grant.current",
      current_capability_epoch: 5,
    });
    const stale = materializeGatewayDelivery({
      opportunity: byMode.get("stale_grant_replay")!,
      original,
      new_provider_call_id: "provider-call-stale-grant",
      current_capability_grant: "grant.current",
      current_capability_epoch: 5,
    });

    expect(exact).toMatchObject({
      emitted_provider_call_id: "provider-call-original",
      emitted_capability_epoch: 4,
      call: { capability_grant: "grant.old" },
      relation: { same_call_id: true, same_semantic_intent: true, grant: "exact_original" },
    });
    expect(semantic).toMatchObject({
      emitted_provider_call_id: "provider-call-semantic-duplicate",
      emitted_capability_epoch: 5,
      call: { capability_grant: "grant.current" },
      relation: { same_call_id: false, same_semantic_intent: true, grant: "current" },
    });
    expect(stale).toMatchObject({
      emitted_provider_call_id: "provider-call-stale-grant",
      emitted_capability_epoch: 4,
      observed_current_capability_epoch: 5,
      call: { capability_grant: "grant.old" },
      relation: { same_call_id: false, same_semantic_intent: true, grant: "stale_original" },
    });
    expect(exact.evidence.semantic_intent_sha256).toBe(semantic.evidence.semantic_intent_sha256);
    expect(semantic.evidence.semantic_intent_sha256).toBe(stale.evidence.semantic_intent_sha256);
    expect(Object.isFrozen(stale.call.arguments)).toBe(true);
    expect(Object.isFrozen(stale.evidence)).toBe(true);

    expect(() => materializeGatewayDelivery({
      opportunity: byMode.get("stale_grant_replay")!,
      original,
      new_provider_call_id: "provider-call-stale-invalid",
      current_capability_grant: "grant.old",
      current_capability_epoch: 4,
    })).toThrow(/observably newer, different current grant/);
  });

  it("fails closed when a closed-loop stage has zero or multiple eligible frozen utterances", () => {
    const scheduler = createDeterministicCallerWorldScheduler(basePlan);
    const first = selectAndCommit(
      scheduler,
      scheduler.initialState,
      observation(false),
      "2026-07-10T12:00:01.000Z"
    );
    const second = selectAndCommit(
      scheduler,
      first.committed.state,
      observation(false),
      "2026-07-10T12:00:02.000Z"
    );
    const missingFact = {
      ...observation(false),
      facts: {},
    } as CallerWorldObservation;
    expect(scheduler.selectNext({
      state: second.committed.state,
      observation: missingFact,
      observed_at: "2026-07-10T12:00:03.000Z",
    })).toMatchObject({ status: "blocked", stage_id: "stage-route" });

    const nondeterministic = createDeterministicCallerWorldScheduler({
      ...basePlan,
      stages: [
        {
          id: "ambiguous-stage",
          candidates: [
            {
              turn_id: "turn-ready",
              audio_turn_id: "turn-ready",
              when: [{ kind: "world_fact_exists", fact_key: "route_ready" }],
            },
            {
              turn_id: "turn-wait",
              audio_turn_id: "turn-wait",
              when: [{ kind: "world_fact_exists", fact_key: "route_ready" }],
            },
          ],
        },
      ],
    });
    expect(() => nondeterministic.selectNext({
      state: nondeterministic.initialState,
      observation: observation(true),
      observed_at: "2026-07-10T12:00:01.000Z",
    })).toThrow(/nondeterministic/);
  });
});

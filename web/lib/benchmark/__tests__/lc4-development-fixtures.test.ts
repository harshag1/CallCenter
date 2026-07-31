import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_DEVELOPMENT_FAMILIES,
  LC4_DEVELOPMENT_PROTOCOL,
  LC4_DEVELOPMENT_VARIANTS,
  LC4_MISSING_MECHANISM_HOOKS,
  assertLc4DevelopmentAnalog,
  compileLc4DevelopmentAnalog,
  compileLc4DevelopmentSuite,
  createLc4CallerAutomaton,
  type Lc4CallerAutomatonState,
  type Lc4CallerObservation,
  type Lc4DevelopmentAnalog,
} from "../lc4-development-fixtures";

function analog(): Lc4DevelopmentAnalog {
  return compileLc4DevelopmentAnalog({
    family: "freight-customs",
    variant: "async-conflict",
    seed: 4_242,
  });
}

function heardObservation(artifact: Lc4DevelopmentAnalog, opportunityId: string): Lc4CallerObservation {
  return {
    schema_version: 1,
    schedule_sha256: artifact.schedule.schedule_sha256,
    opportunity_id: opportunityId,
    observed_world_revision: 0,
    outcome: "heard",
    listener_heard_audio_sha256: sha256Hex(`listener-heard:${opportunityId}`),
    visible_receipt_ids: [],
    visible_worker_result_ids: [],
  };
}

describe("HACC-LC4 provider-free development fixture compiler", () => {
  it("materializes six families by four structural variants without enabling provider execution", () => {
    const suite = compileLc4DevelopmentSuite(7_000);

    expect(suite.protocol_id).toBe(LC4_DEVELOPMENT_PROTOCOL);
    expect(suite.artifacts).toHaveLength(24);
    expect(new Set(suite.artifacts.map((artifact) => artifact.manifest.family)))
      .toEqual(new Set(LC4_DEVELOPMENT_FAMILIES));
    expect(new Set(suite.artifacts.map((artifact) => artifact.manifest.variant)))
      .toEqual(new Set(LC4_DEVELOPMENT_VARIANTS));
    expect(new Set(suite.artifacts.map((artifact) => `${artifact.manifest.family}/${artifact.manifest.variant}`)).size)
      .toBe(24);

    for (const artifact of suite.artifacts) {
      expect(() => assertLc4DevelopmentAnalog(artifact)).not.toThrow();
      expect(artifact.manifest).toMatchObject({
        study_role: "development-analog",
        preregistration_status: "not-preregistered",
        provider_calls_authorized: false,
        held_out: false,
      });
      expect(artifact.scenario.execution_policy).toMatchObject({
        study_role: "development",
        execution_eligibility: "offline-stress-only",
      });
      expect(artifact.scenario.caller.turns).toHaveLength(60);
      expect(artifact.scenario.tools).toHaveLength(24);
      expect(artifact.flow.nodes.flatMap((node) => node.steps ?? []).filter((step) => step.checkpoint)).toHaveLength(12);
      expect(artifact.callerFixtures.every((fixture) => fixture.pcm_status === "not_rendered_development_only")).toBe(true);
      expect(artifact.manifest.missing_mechanism_hooks).toEqual(LC4_MISSING_MECHANISM_HOOKS);
      const committedOpportunity = artifact.schedule.opportunities.find((opportunity) =>
        opportunity.stressors.some((event) => event.kind === "committed_after_error")
      )!;
      const committedFault = artifact.scenario.tools.flatMap((tool) => tool.faults).find((fault) => fault.phase === "after_commit")!;
      expect(committedFault).toMatchObject({ semantic_opportunity_id: committedOpportunity.id });
      expect(committedFault).not.toHaveProperty("attempt");
    }
    expect(suite.suite_sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);

  it("is byte-deterministic and gives every variant a distinct literal-redacted topology", () => {
    const first = compileLc4DevelopmentSuite(8_100);
    const replay = compileLc4DevelopmentSuite(8_100);
    const changedSeed = compileLc4DevelopmentSuite(8_101);

    expect(canonicalJson(replay)).toBe(canonicalJson(first));
    expect(changedSeed.suite_sha256).not.toBe(first.suite_sha256);

    for (const family of LC4_DEVELOPMENT_FAMILIES) {
      const topologies = first.artifacts
        .filter((artifact) => artifact.manifest.family === family)
        .map((artifact) => artifact.schedule.topology_sha256);
      expect(new Set(topologies).size).toBe(4);
    }
  }, 30_000);

  it("binds exactly 60 contiguous opportunities in three twenty-opportunity acts", () => {
    const artifact = analog();
    const schedule = artifact.schedule.opportunities;

    expect(schedule.map((opportunity) => opportunity.index)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    expect(schedule.slice(0, 20).every((opportunity) => opportunity.act === "establish")).toBe(true);
    expect(schedule.slice(20, 40).every((opportunity) => opportunity.act === "interleave")).toBe(true);
    expect(schedule.slice(40).every((opportunity) => opportunity.act === "reconcile")).toBe(true);
    expect(new Set(schedule.map((opportunity) => opportunity.id)).size).toBe(60);
    expect(new Set(artifact.callerFixtures.map((fixture) => fixture.source_text_sha256)).size).toBe(60);
  });

  it("rejects any schedule mutation instead of silently recompiling it", () => {
    const artifact = structuredClone(analog()) as unknown as {
      schedule: { opportunities: Array<{ utterance: string }> };
    };
    artifact.schedule.opportunities[34]!.utterance += " Mutated after freeze.";
    expect(() => assertLc4DevelopmentAnalog(artifact)).toThrow(/stale source-text hash|hash mismatch/);
  });
});

describe("HACC-LC4 condition-blind 60-opportunity caller automaton", () => {
  it("commits all canonical opportunities without renumbering and preserves its disposition chain", () => {
    const artifact = analog();
    const automaton = createLc4CallerAutomaton(artifact);
    let state: Lc4CallerAutomatonState = automaton.initialState;

    while (state.status === "active") {
      const next = automaton.next(state);
      expect(next).not.toBeNull();
      state = automaton.commit(state, heardObservation(artifact, next!.opportunity.id));
    }

    expect(state).toMatchObject({ status: "completed", next_opportunity_index: 61 });
    expect(state.dispositions).toHaveLength(60);
    expect(state.dispositions.map((item) => item.opportunity_index)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    state.dispositions.forEach((item, index) => {
      expect(item.previous_disposition_sha256).toBe(index === 0 ? null : state.dispositions[index - 1]!.disposition_sha256);
      expect(item.disposition_sha256).toMatch(/^[a-f0-9]{64}$/);
    });
    expect(automaton.next(state)).toBeNull();
  }, 15_000);

  it("rejects arm, prompt, grant, provider transcript, and evaluator side channels", () => {
    const artifact = analog();
    const automaton = createLc4CallerAutomaton(artifact);
    const next = automaton.next(automaton.initialState)!;
    const observation = {
      ...heardObservation(artifact, next.opportunity.id),
      arm: "hacc",
      prompt: "hidden prompt",
      capability_grant: "hidden grant",
      provider_transcript: "private transcript",
      evaluator_score: 1,
    };

    expect(() => automaton.commit(automaton.initialState, observation as never)).toThrow();
  });

  it("requires source-bound listener-heard audio and fails closed on contradictory evidence", () => {
    const artifact = analog();
    const automaton = createLc4CallerAutomaton(artifact);
    const next = automaton.next(automaton.initialState)!;

    expect(() => automaton.commit(automaton.initialState, {
      ...heardObservation(artifact, next.opportunity.id),
      listener_heard_audio_sha256: null,
    })).toThrow(/heard outcomes require source-bound audio/);

    expect(() => automaton.commit(automaton.initialState, {
      ...heardObservation(artifact, next.opportunity.id),
      outcome: "no_output",
    })).toThrow(/non-heard outcomes cannot claim listener-heard audio/);
  });

  it("assigns immutable failed dispositions to the remaining horizon after critical termination", () => {
    const artifact = analog();
    const automaton = createLc4CallerAutomaton(artifact);
    let state = automaton.initialState;
    for (let index = 1; index < 18; index += 1) {
      const next = automaton.next(state)!;
      state = automaton.commit(state, heardObservation(artifact, next.opportunity.id));
    }
    const critical = automaton.next(state)!;
    state = automaton.commit(state, {
      ...heardObservation(artifact, critical.opportunity.id),
      outcome: "critical_failure",
      listener_heard_audio_sha256: null,
    });

    expect(state.status).toBe("critical_failure");
    expect(state.next_opportunity_index).toBe(61);
    expect(state.dispositions).toHaveLength(60);
    expect(state.dispositions[17]!.disposition).toBe("critical_failure");
    expect(state.dispositions.slice(18).every((item) => item.disposition === "not_reached_after_critical_failure")).toBe(true);
    expect(automaton.next(state)).toBeNull();
  });
});

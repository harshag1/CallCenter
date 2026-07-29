import { describe, expect, it } from "vitest";
import { sha256Hex } from "../artifacts";
import {
  LC4_DEVELOPMENT_TEST_SEED_BYTES,
  createLc4GenericHeldoutGenerator,
} from "../lc4-heldout-generator";
import {
  LC4_PROVIDER_EXECUTION_PROFILE_VERSION,
  LC4_RUNNER_FOUNDATION_VERSION,
  LC4_RUNNER_PROTOCOL,
  compileLc4ProductionScheduleShape,
  createLc4EpisodeManifest,
  createLc4ProviderExecutionProfile,
  createLc4QualificationGateReceipt,
  executeLc4ProviderFreeEpisode,
  joinLc4HeldoutTemplatesToSchedule,
  reserveLc4ProviderFreeEpisodeBudget,
  type Lc4AudioRetentionAdapter,
  type Lc4AttemptAdapter,
  type Lc4BudgetReservationAdapter,
  type Lc4CallerAdapter,
  type Lc4EpisodeManifest,
  type Lc4OpportunityBinding,
  type Lc4ProviderAdapter,
} from "../lc4-production-runner-foundation";

const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);

function generatedTemplates() {
  return createLc4GenericHeldoutGenerator({
    executionMode: "development-test-only",
    generatorSourceSha256: "a".repeat(64),
    corpusSchemaSha256: "b".repeat(64),
  }).generate(new Uint8Array(LC4_DEVELOPMENT_TEST_SEED_BYTES));
}

function qualification() {
  return createLc4QualificationGateReceipt({
    plan_sha256: HASH,
    source_commit: COMMIT,
    configuration_matrix_sha256: "c".repeat(64),
    credential_set_sha256: "d".repeat(64),
    handshake: { status: "conditional", artifact_sha256: "e".repeat(64), completed_at: "2026-07-21T20:00:00.000Z" },
    response_tool_canary: {
      status: "passed",
      artifact_sha256: "f".repeat(64),
      completed_at: "2026-07-21T20:01:00.000Z",
      caller_audio_bytes: 0,
      providers_verified: ["openai", "gemini", "xai"],
    },
  });
}

function opportunityBindings(): readonly Lc4OpportunityBinding[] {
  return Object.freeze(Array.from({ length: 60 }, (_, index) => {
    const pcm = new Uint8Array([index + 1, 7, 11]);
    return Object.freeze({
      ordinal: index + 1,
      opportunity_id: `op-${String(index + 1).padStart(2, "0")}`,
      segment_ordinal: Math.ceil((index + 1) / 20) as 1 | 2 | 3,
      caller_pcm_sha256: sha256Hex(pcm),
      caller_pcm_byte_length: pcm.byteLength,
      opportunity_contract_sha256: sha256Hex(`contract-${index + 1}`),
    });
  }));
}

function manifest(): Lc4EpisodeManifest {
  const schedule = compileLc4ProductionScheduleShape();
  const episode = schedule.episode_shapes[0];
  const reservationBody = {
    reservation_id: "reservation-1",
    run_id: episode.run_id,
    provider: episode.provider,
    model: episode.provider_profile.model,
    maximum_micro_usd: episode.maximum_reservation_micro_usd,
    status: "reserved" as const,
    ledger_head_sha256: "1".repeat(64),
  };
  return createLc4EpisodeManifest({
    schedule,
    run_id: episode.run_id,
    source_commit: COMMIT,
    source_tree_sha256: "2".repeat(64),
    preregistration_sha256: "3".repeat(64),
    heldout_commitment_sha256: "4".repeat(64),
    template_commitment_sha256: "5".repeat(64),
    opportunity_manifest_sha256: "6".repeat(64),
    caller_fixture_manifest_sha256: "7".repeat(64),
    condition_suite_sha256: "8".repeat(64),
    parity_manifest_sha256: "9".repeat(64),
    generator_schedule_join_sha256: "0".repeat(64),
    qualification: qualification(),
    budget_reservation: {
      ...reservationBody,
      reservation_sha256: sha256Hex(JSON.stringify(reservationBody)),
    },
    opportunities: opportunityBindings(),
  });
}

describe("LC4 production runner foundation", () => {
  it("compiles the exact public 24-template, 72-pair, 144-episode schedule shape", () => {
    const schedule = compileLc4ProductionScheduleShape();
    expect(schedule).toMatchObject({
      schema_version: 2,
      protocol_id: LC4_RUNNER_PROTOCOL,
      runner_foundation_version: LC4_RUNNER_FOUNDATION_VERSION,
      provider_calls_authorized: false,
      heldout_plaintext_required: false,
      templates: 24,
      pairs: 72,
      episodes: 144,
      opportunities_per_episode: 60,
      scheduled_opportunities: 8_640,
      logical_segments_per_episode: 3,
    });
    expect(schedule.pair_shapes).toHaveLength(72);
    expect(schedule.pair_shapes.every((pair) =>
      pair.provider_profile.execution_profile_version
        === LC4_PROVIDER_EXECUTION_PROFILE_VERSION
    )).toBe(true);
    expect(schedule.episode_shapes).toHaveLength(144);
    expect(new Set(schedule.pair_shapes.map((pair) => pair.template_id))).toHaveLength(24);
    expect(new Set(schedule.pair_shapes.map((pair) => pair.provider))).toEqual(new Set(["openai", "gemini", "xai"]));
    expect(schedule.pair_shapes.find((pair) => pair.provider === "xai")?.provider_profile)
      .toMatchObject({
        transport_mode: "manual_commit",
        transport_purpose: "finite_prerecorded_efficacy",
        turn_boundary: "finite_clip_input_audio_buffer.commit_then_response.create",
      });
    expect(schedule.pair_shapes.filter((pair) => pair.provider !== "xai").every((pair) => (
      pair.provider_profile.transport_mode === null
      && pair.provider_profile.transport_profile_sha256 === null
      && pair.provider_profile.transport_purpose === null
    ))).toBe(true);
    expect(schedule.episode_shapes.every((episode) =>
      episode.segments.map((segment) => [segment.opportunity_start, segment.opportunity_end]).join("|") === "1,20|21,40|41,60"
    )).toBe(true);
    expect(schedule.maximum_scheduled_reservations_micro_usd).toBeLessThanOrEqual(900_000_000);
    for (const pair of schedule.pair_shapes) {
      const episodes = schedule.episode_shapes.filter((episode) => episode.pair_id === pair.pair_id);
      expect(episodes.map((episode) => episode.arm)).toEqual([...pair.arm_order]);
      expect(new Set(episodes.map((episode) => episode.provider_profile.provider_profile_sha256)).size).toBe(1);
    }
  });

  it("constructs the separate hash-bound xAI interactive qualification profile explicitly", () => {
    const finite = createLc4ProviderExecutionProfile("xai");
    const interactive = createLc4ProviderExecutionProfile(
      "xai",
      "interactive_transport_qualification",
    );
    expect(finite.transport_mode).toBe("manual_commit");
    expect(interactive).toMatchObject({
      transport_mode: "provider_native_server_vad",
      transport_purpose: "interactive_transport_qualification",
      turn_boundary: "server_vad_speech_stop_auto_commit_auto_response",
    });
    expect(interactive.transport_profile_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(interactive.transport_profile_sha256).not.toBe(
      finite.transport_profile_sha256,
    );
    expect(interactive.provider_profile_sha256).not.toBe(
      finite.provider_profile_sha256,
    );
  });

  it("joins the generator and power plan through an exact 24-template bijection", () => {
    const joined = joinLc4HeldoutTemplatesToSchedule(generatedTemplates());
    expect(joined.template_count).toBe(24);
    expect(joined.bindings).toHaveLength(24);
    expect(joined.bindings.map((binding) => binding.template_id)).toEqual(
      Array.from({ length: 24 }, (_, index) => `lc4-template-${String(index + 1).padStart(2, "0")}`),
    );
    expect(joined.bindings.every((binding) => binding.pair_ids.length === 3)).toBe(true);
    expect(joined.bindings.every((binding) =>
      /^[a-f0-9]{64}$/.test(binding.canonical_caller_source_manifest_sha256)
      && /^[a-f0-9]{64}$/.test(binding.canonical_stage_manifest_sha256)
    )).toBe(true);
    expect(new Set(joined.bindings.flatMap((binding) => binding.pair_ids))).toHaveLength(72);
    expect(joined.join_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed on missing, duplicate, or renamed generator template IDs", () => {
    const templates = generatedTemplates();
    expect(() => joinLc4HeldoutTemplatesToSchedule(templates.slice(1))).toThrow("exactly 24");
    expect(() => joinLc4HeldoutTemplatesToSchedule([templates[0], ...templates.slice(0, 23)])).toThrow("duplicate template");
    expect(() => joinLc4HeldoutTemplatesToSchedule([
      { ...templates[0], template_id: "lc4-template-99" },
      ...templates.slice(1),
    ])).toThrow("exact bijection");
  });

  it("fails closed on family, structural-variant, or slot vocabulary drift", () => {
    const templates = generatedTemplates();
    const familyDrift = [...templates];
    familyDrift[0] = { ...templates[0], payload: templates[4].payload };
    expect(() => joinLc4HeldoutTemplatesToSchedule(familyDrift)).toThrow("vocabulary drifted");

    const variantDrift = [...templates];
    variantDrift[0] = { ...templates[0], payload: templates[1].payload };
    expect(() => joinLc4HeldoutTemplatesToSchedule(variantDrift)).toThrow("vocabulary drifted");

    const slotDrift = [...templates];
    slotDrift[0] = { ...templates[0], family_slot: 2 };
    expect(() => joinLc4HeldoutTemplatesToSchedule(slotDrift)).toThrow("vocabulary drifted");
  });

  it("requires conditional qualification to carry a passing three-provider tool canary", () => {
    expect(() => createLc4QualificationGateReceipt({
      plan_sha256: HASH,
      source_commit: COMMIT,
      configuration_matrix_sha256: "c".repeat(64),
      credential_set_sha256: "d".repeat(64),
      handshake: { status: "conditional", artifact_sha256: "e".repeat(64), completed_at: "2026-07-21T20:00:00.000Z" },
      response_tool_canary: {
        status: "passed",
        artifact_sha256: "f".repeat(64),
        completed_at: "2026-07-21T20:01:00.000Z",
        caller_audio_bytes: 0,
        providers_verified: ["openai", "gemini"],
      } as never,
    })).toThrow("all three exact provider profiles");
    expect(qualification().gate_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates an immutable 60-opportunity episode manifest without held-out plaintext", () => {
    const value = manifest();
    expect(value.opportunities).toHaveLength(60);
    expect(value.provider_calls_authorized).toBe(false);
    expect(value.execution_scope).toBe("provider_free_foundation_validation_only");
    expect(value).not.toHaveProperty("template_plaintext");
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.opportunities)).toBe(true);
    expect(value.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => createLc4EpisodeManifest({
      schedule: {
        ...compileLc4ProductionScheduleShape(),
        schema_version: 1,
      } as never,
      run_id: value.run_id,
      source_commit: value.source_commit,
      source_tree_sha256: value.source_tree_sha256,
      preregistration_sha256: value.preregistration_sha256,
      heldout_commitment_sha256: value.heldout_commitment_sha256,
      template_commitment_sha256: value.template_commitment_sha256,
      opportunity_manifest_sha256: value.opportunity_manifest_sha256,
      caller_fixture_manifest_sha256: value.caller_fixture_manifest_sha256,
      condition_suite_sha256: value.condition_suite_sha256,
      parity_manifest_sha256: value.parity_manifest_sha256,
      generator_schedule_join_sha256: value.generator_schedule_join_sha256,
      qualification: value.qualification,
      budget_reservation: value.budget_reservation,
      opportunities: value.opportunities,
    })).toThrow("stale foundation schema");
    expect(() => createLc4EpisodeManifest({
      schedule: compileLc4ProductionScheduleShape(),
      run_id: value.run_id,
      source_commit: value.source_commit,
      source_tree_sha256: value.source_tree_sha256,
      preregistration_sha256: value.preregistration_sha256,
      heldout_commitment_sha256: value.heldout_commitment_sha256,
      template_commitment_sha256: value.template_commitment_sha256,
      opportunity_manifest_sha256: value.opportunity_manifest_sha256,
      caller_fixture_manifest_sha256: value.caller_fixture_manifest_sha256,
      condition_suite_sha256: value.condition_suite_sha256,
      parity_manifest_sha256: value.parity_manifest_sha256,
      generator_schedule_join_sha256: value.generator_schedule_join_sha256,
      qualification: value.qualification,
      budget_reservation: value.budget_reservation,
      opportunities: value.opportunities.slice(1),
    })).toThrow("exactly 60");
  });

  it("reserves only the exact frozen per-provider episode envelope", async () => {
    const value = manifest();
    const budget: Lc4BudgetReservationAdapter = {
      kind: "provider-free-test",
      async reserve(request) {
        expect(request).toEqual({
          run_id: value.run_id,
          provider: value.episode_shape.provider,
          model: value.episode_shape.provider_profile.model,
          maximum_micro_usd: value.episode_shape.maximum_reservation_micro_usd,
        });
        return value.budget_reservation;
      },
      async connectionIntent() {},
      async opened() {},
      async terminal() {},
    };
    await expect(reserveLc4ProviderFreeEpisodeBudget({
      schedule: compileLc4ProductionScheduleShape(),
      run_id: value.run_id,
      budget,
    })).resolves.toEqual(value.budget_reservation);
  });

  it("runs exactly three injected provider-free sessions and 60 opportunities", async () => {
    const value = manifest();
    const events: string[] = [];
    const consumed = new Set<string>();
    const attempts: Lc4AttemptAdapter = {
      kind: "provider-free-test",
      async consume(runId) {
        if (consumed.has(runId)) throw new Error("run ID already consumed");
        consumed.add(runId);
        events.push(`consume:${runId}`);
        return { attempt_id: "attempt-1" };
      },
      async markIttOpened(_, opportunityId) { events.push(`itt:${opportunityId}`); },
      async terminal(_, outcome, itt) { events.push(`attempt-terminal:${outcome}:${itt}`); },
    };
    const budget: Lc4BudgetReservationAdapter = {
      kind: "provider-free-test",
      async reserve() { return value.budget_reservation; },
      async connectionIntent() { events.push("budget:intent"); },
      async opened() { events.push("budget:opened"); },
      async terminal(_, outcome) { events.push(`budget:terminal:${outcome}`); },
    };
    const caller: Lc4CallerAdapter = {
      kind: "provider-free-test",
      async load(opportunity) { return { pcm: new Uint8Array([opportunity.ordinal, 7, 11]) }; },
    };
    const audio: Lc4AudioRetentionAdapter = {
      kind: "provider-free-test",
      async retain(input) { return { artifact_sha256: sha256Hex(input.pcm), byte_length: input.pcm.byteLength }; },
    };
    const provider: Lc4ProviderAdapter = {
      kind: "provider-free-test",
      async openSegment({ segment }) {
        events.push(`open:${segment.ordinal}`);
        return {
          async sendCallerAudio({ opportunity_id }) { events.push(`send:${opportunity_id}`); },
          async receiveAssistantAudio({ opportunity_id }) { return { pcm: new Uint8Array([opportunity_id.length, 13]) }; },
          async close() { events.push(`close:${segment.ordinal}`); },
        };
      },
    };
    const input = {
      manifest: value,
      qualification_binding: {
        plan_sha256: HASH,
        source_commit: COMMIT,
        configuration_matrix_sha256: "c".repeat(64),
        credential_set_sha256: "d".repeat(64),
      },
      budget,
      attempts,
      caller,
      audio,
      provider,
    };
    const result = await executeLc4ProviderFreeEpisode(input);
    expect(result).toMatchObject({ status: "completed", itt_opened: true, segments_opened: 3, opportunities_sent: 60, assistant_outputs_retained: 60 });
    expect(events.filter((event) => event.startsWith("open:"))).toEqual(["open:1", "open:2", "open:3"]);
    expect(events.filter((event) => event.startsWith("close:"))).toEqual(["close:1", "close:2", "close:3"]);
    expect(events.filter((event) => event.startsWith("send:"))).toHaveLength(60);
    await expect(executeLc4ProviderFreeEpisode(input)).rejects.toThrow("already consumed");
    expect(events.filter((event) => event.startsWith("send:"))).toHaveLength(60);
  });

  it("retains an opened failure and never retries it", async () => {
    const value = manifest();
    let consumed = false;
    let sends = 0;
    const attempts: Lc4AttemptAdapter = {
      kind: "provider-free-test",
      async consume() {
        if (consumed) throw new Error("consumed");
        consumed = true;
        return { attempt_id: "attempt-1" };
      },
      async markIttOpened() {},
      async terminal() {},
    };
    const budget: Lc4BudgetReservationAdapter = {
      kind: "provider-free-test",
      async reserve() { return value.budget_reservation; },
      async connectionIntent() {},
      async opened() {},
      async terminal() {},
    };
    const caller: Lc4CallerAdapter = { kind: "provider-free-test", async load(opportunity) { return { pcm: new Uint8Array([opportunity.ordinal, 7, 11]) }; } };
    const audio: Lc4AudioRetentionAdapter = { kind: "provider-free-test", async retain(input) { return { artifact_sha256: sha256Hex(input.pcm), byte_length: input.pcm.byteLength }; } };
    const provider: Lc4ProviderAdapter = {
      kind: "provider-free-test",
      async openSegment() {
        return {
          async sendCallerAudio() { sends += 1; if (sends === 2) throw new Error("transport"); },
          async receiveAssistantAudio() { return { pcm: new Uint8Array([1]) }; },
          async close() {},
        };
      },
    };
    const run = () => executeLc4ProviderFreeEpisode({
      manifest: value,
      qualification_binding: { plan_sha256: HASH, source_commit: COMMIT, configuration_matrix_sha256: "c".repeat(64), credential_set_sha256: "d".repeat(64) },
      budget,
      attempts,
      caller,
      audio,
      provider,
    });
    await expect(run()).resolves.toMatchObject({ status: "failed", itt_opened: true, opportunities_sent: 1, failure_class: "transport" });
    await expect(run()).rejects.toThrow("consumed");
    expect(sends).toBe(2);
  });

  it("rejects a production adapter before consuming the run ID or touching budget", async () => {
    const value = manifest();
    let touched = false;
    const attempts: Lc4AttemptAdapter = {
      kind: "provider-free-test",
      async consume() { touched = true; return { attempt_id: "attempt-1" }; },
      async markIttOpened() {},
      async terminal() {},
    };
    const budget: Lc4BudgetReservationAdapter = {
      kind: "provider-free-test",
      async reserve() { touched = true; return value.budget_reservation; },
      async connectionIntent() { touched = true; },
      async opened() { touched = true; },
      async terminal() { touched = true; },
    };
    await expect(executeLc4ProviderFreeEpisode({
      manifest: value,
      qualification_binding: { plan_sha256: HASH, source_commit: COMMIT, configuration_matrix_sha256: "c".repeat(64), credential_set_sha256: "d".repeat(64) },
      budget,
      attempts,
      caller: { kind: "provider-free-test", async load() { throw new Error("unreachable"); } },
      audio: { kind: "provider-free-test", async retain() { throw new Error("unreachable"); } },
      provider: { kind: "production" } as never,
    })).rejects.toThrow("paid execution remains frozen");
    expect(touched).toBe(false);
  });
});

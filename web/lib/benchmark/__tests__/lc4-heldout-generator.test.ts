import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_DEVELOPMENT_TEST_SEED_BYTES,
  LC4_GENERIC_FAMILIES,
  LC4_GENERIC_STRUCTURAL_VARIANTS,
  LC4_NORMATIVE_BLOCKER_CODES,
  LC4_POLICY_MAX_TOKENS,
  LC4_POLICY_MIN_TOKENS,
  LC4_PRIMARY_CONJUNCTS,
  LC4_POWER_PLAN_TTS_VOICE_SLOTS_BY_TEMPLATE,
  LC4_TERMINAL_CLASSES,
  assertLc4ConfirmatorySeedNotDevelopment,
  assertLc4GenericScenarioPayload,
  countLc4PolicyTokens,
  createLc4GenericHeldoutGenerator,
  type Lc4GenericScenarioPayload,
} from "../lc4-heldout-generator";
import { sealLc4HeldoutCandidate, verifyLc4HeldoutCommitment } from "../lc4-heldout-commitment";
import { createLc4FrozenListenerSemanticRegistryManifest } from "../lc4-listener-evidence";
import { createLc4PowerPlanArtifact } from "../lc4-power-plan";

function generator(mode: "development-test-only" | "sealed-custody-only" = "development-test-only") {
  return createLc4GenericHeldoutGenerator({
    executionMode: mode,
    generatorSourceSha256: sha256Hex("lc4-generic-generator-test-source"),
    corpusSchemaSha256: sha256Hex("lc4-generic-generator-test-schema"),
  });
}

function generated() {
  return generator().generate(new Uint8Array(LC4_DEVELOPMENT_TEST_SEED_BYTES));
}

function payloads(): Lc4GenericScenarioPayload[] {
  return generated().map((template) => template.payload as Lc4GenericScenarioPayload);
}

function mutablePayload(): Record<string, unknown> {
  return structuredClone(payloads()[0]) as unknown as Record<string, unknown>;
}

function rehash(payload: Record<string, unknown>): void {
  const body = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "content_sha256"));
  payload.content_sha256 = sha256Hex(canonicalJson(body));
}

describe("LC4 generic held-out scenario generator", () => {
  it("deterministically generates the complete six-by-four structural matrix", () => {
    const first = generated();
    const replay = generated();

    expect(first).toEqual(replay);
    expect(first).toHaveLength(24);
    expect(new Set(first.map((template) => `${template.family_slot}/${template.structural_variant_slot}`)).size).toBe(24);
    expect(new Set(first.map((template) => (template.payload as Lc4GenericScenarioPayload).family)))
      .toEqual(new Set(LC4_GENERIC_FAMILIES));
    expect(new Set(first.map((template) => (template.payload as Lc4GenericScenarioPayload).structural_variant)))
      .toEqual(new Set(LC4_GENERIC_STRUCTURAL_VARIANTS));
    for (const template of first) expect(() => assertLc4GenericScenarioPayload(template.payload)).not.toThrow();
  }, 30_000);

  it("materializes every required long-call mechanism contract per template", () => {
    for (const payload of payloads()) {
      expect(payload.opportunities).toHaveLength(60);
      expect(payload.opportunities.slice(0, 20).every((opportunity) => opportunity.act === "establish")).toBe(true);
      expect(payload.opportunities.slice(20, 40).every((opportunity) => opportunity.act === "interleave")).toBe(true);
      expect(payload.opportunities.slice(40).every((opportunity) => opportunity.act === "reconcile")).toBe(true);
      expect(payload.future_facts).toHaveLength(10);
      expect(payload.corrections).toHaveLength(4);
      expect(payload.logical_tools).toHaveLength(24);
      expect(payload.flow_checkpoints).toHaveLength(12);
      expect(new Set(payload.flow_checkpoints.map((checkpoint) => checkpoint.goal_id)).size).toBe(2);
      expect(payload.goal_transitions).toHaveLength(4);
      expect(payload.workers).toHaveLength(4);
      expect(new Set(payload.workers.map((worker) => worker.role)).size).toBe(4);
      expect(payload.worker_faults).toHaveLength(4);
      expect(new Set(payload.worker_faults.map((fault) => fault.kind)).size).toBe(4);
      expect(payload.confirmations).toHaveLength(2);
      expect(payload.normative_blockers).toHaveLength(12);
      expect(payload.normative_blockers.every((stage) => canonicalJson(stage.ordered_codes) === canonicalJson(LC4_NORMATIVE_BLOCKER_CODES))).toBe(true);
      expect(payload.repair_library).toHaveLength(192);
      expect(payload.repair_library.every((repair) => repair.pcm_status === "not-rendered")).toBe(true);
      expect(payload.listener_semantic_registry).toMatchObject({
        template_id: payload.template_id,
        opportunities: expect.any(Array),
      });
      expect(payload.listener_semantic_registry.opportunities).toHaveLength(60);
      expect(payload.listener_semantic_registry.opportunities.map((item) => item.opportunity_id))
        .toEqual(payload.opportunities.map((item) => item.id));
      expect(payload.listener_semantic_registry.opportunities.every((item) => /^[a-f0-9]{64}$/.test(item.criterion_plan_sha256))).toBe(true);
      expect(payload.scoring.primary_conjuncts).toEqual(LC4_PRIMARY_CONJUNCTS);
      expect(payload.scoring.terminal_classes_by_precedence).toEqual(LC4_TERMINAL_CLASSES);
    }
  }, 30_000);

  it("joins every generated identity and voice exactly to the frozen power plan", () => {
    const generatedTemplates = generated();
    const planTemplates = createLc4PowerPlanArtifact().randomization.assignments
      .filter((assignment) => assignment.provider === "openai")
      .map(({ template_id, family, structural_variant, tts_voice_slot }) => ({ template_id, family, structural_variant, tts_voice_slot }));
    expect(generatedTemplates.map((template) => {
      const payload = template.payload as Lc4GenericScenarioPayload;
      return {
        template_id: template.template_id,
        family: payload.family,
        structural_variant: payload.structural_variant,
        tts_voice_slot: payload.tts_voice_slot,
      };
    })).toEqual(planTemplates);
    expect(generatedTemplates.map((template) => (template.payload as Lc4GenericScenarioPayload).tts_voice_slot)).toEqual(LC4_POWER_PLAN_TTS_VOICE_SLOTS_BY_TEMPLATE);
  }, 30_000);

  it("binds exact caller audio sources, canonical stages, and versioned facts without leaking probe answers", () => {
    for (const payload of payloads()) {
      for (const [index, opportunity] of payload.opportunities.entries()) {
        const source = opportunity.canonical_caller_utterance;
        const expectedStage = payload.normative_blockers.find((stage) => stage.deadline_opportunity >= index + 1)?.stage_id ?? "checkpoint.12";
        expect(opportunity.id).toBe(`opportunity.${String(index + 1).padStart(3, "0")}`);
        expect(source.opportunity_id).toBe(opportunity.id);
        expect(source.stage_id).toBe(expectedStage);
        expect(opportunity.stage_id).toBe(expectedStage);
        expect(source.source_text_sha256).toBe(sha256Hex(source.text));
        for (const binding of source.fact_bindings) {
          expect(binding.fact_id).toBe(`fact.${binding.fact_key}.v${binding.fact_version}`);
          if (binding.binding_role === "introduce" || binding.binding_role === "correct") expect(source.text).toContain(canonicalJson(binding.expected_value));
          if (binding.binding_role === "recall") expect(source.text).not.toContain(canonicalJson(binding.expected_value));
        }
      }
      expect(payload.opportunities.filter((item) => item.canonical_caller_utterance.fact_bindings.some((binding) => binding.binding_role === "introduce"))).toHaveLength(10);
      expect(payload.opportunities.filter((item) => item.canonical_caller_utterance.fact_bindings.some((binding) => binding.binding_role === "correct"))).toHaveLength(4);
      expect(payload.opportunities.filter((item) => item.canonical_caller_utterance.fact_bindings.some((binding) => binding.binding_role === "recall"))).toHaveLength(12);
    }
  }, 30_000);

  it("binds each policy corpus to the frozen tokenizer and 10k-to-15k token range", () => {
    for (const payload of payloads()) {
      const recomputed = payload.policy_corpus.sections.reduce((sum, section) => sum + countLc4PolicyTokens(section.text), 0);
      expect(payload.policy_corpus.token_count).toBe(recomputed);
      expect(recomputed).toBeGreaterThanOrEqual(LC4_POLICY_MIN_TOKENS);
      expect(recomputed).toBeLessThanOrEqual(LC4_POLICY_MAX_TOKENS);
      expect(payload.policy_corpus.corpus_sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  }, 30_000);

  it("uses one canonical information source with complete Native and staged HACC coverage", () => {
    for (const payload of payloads()) {
      const parity = payload.arm_information_parity_source;
      const ids = parity.canonical_units.map((unit) => unit.id).sort();
      expect(parity.native_unit_ids).toEqual(ids);
      expect(parity.hacc_disclosures.map((item) => item.unit_id).sort()).toEqual(ids);
      expect(new Set(ids).size).toBe(ids.length);
      expect(parity.hacc_disclosures.every((disclosure) => {
        const source = parity.canonical_units.find((unit) => unit.id === disclosure.unit_id);
        return source?.disclose_at_opportunity === disclosure.disclose_at_opportunity;
      })).toBe(true);
    }
  }, 30_000);

  it("gives all four variants distinct literal-redacted opportunity topology", () => {
    for (const family of LC4_GENERIC_FAMILIES) {
      const topologyHashes = payloads()
        .filter((payload) => payload.family === family)
        .map((payload) => sha256Hex(canonicalJson(payload.opportunities.map((opportunity) => ({
          index: opportunity.index,
          act: opportunity.act,
          goal_id: opportunity.goal_id,
          registrations: opportunity.registrations,
        })))));
      expect(new Set(topologyHashes).size).toBe(4);
    }
  }, 30_000);

  it("rejects independently rehashed structural mutations", () => {
    const mutations: Array<{ payload: Record<string, unknown>; expected: RegExp }> = [];

    const policy = mutablePayload();
    (((policy.policy_corpus as Record<string, unknown>).sections as Array<Record<string, unknown>>)[0]!).text = "shortened policy";
    rehash(policy);
    mutations.push({ payload: policy, expected: /policy section commitment/ });

    const opportunity = mutablePayload();
    ((opportunity.opportunities as Array<Record<string, unknown>>)[0]!.registrations as string[]).pop();
    rehash(opportunity);
    mutations.push({ payload: opportunity, expected: /fact-introduction (?:requires exactly 10|does not have exactly one)/ });

    const callerSource = mutablePayload();
    (((callerSource.opportunities as Array<Record<string, unknown>>)[0]!.canonical_caller_utterance as Record<string, unknown>)).stage_id = "checkpoint.12";
    rehash(callerSource);
    mutations.push({ payload: callerSource, expected: /stage identity is not canonical/ });

    const templateIdentity = mutablePayload();
    templateIdentity.template_id = "lc4-template-24";
    rehash(templateIdentity);
    mutations.push({ payload: templateIdentity, expected: /power-plan template identity/ });

    const voiceIdentity = mutablePayload();
    voiceIdentity.tts_voice_slot = "tts-slot-3";
    rehash(voiceIdentity);
    mutations.push({ payload: voiceIdentity, expected: /power-plan voice assignment/ });

    const tools = mutablePayload();
    (tools.logical_tools as unknown[]).pop();
    rehash(tools);
    mutations.push({ payload: tools, expected: /exactly 24 logical tools/ });

    const worker = mutablePayload();
    ((worker.workers as Array<Record<string, unknown>>)[0]!).eligible_opportunity = 1;
    rehash(worker);
    mutations.push({ payload: worker, expected: /eligibility precedes launch/ });

    const workerFault = mutablePayload();
    ((workerFault.worker_faults as Array<Record<string, unknown>>)[0]!).worker_id = "worker.unknown";
    rehash(workerFault);
    mutations.push({ payload: workerFault, expected: /worker fault is not bound/ });

    const blockers = mutablePayload();
    (((blockers.normative_blockers as Array<Record<string, unknown>>)[0]!).ordered_codes as string[]).reverse();
    rehash(blockers);
    mutations.push({ payload: blockers, expected: /blocker precedence drifted/ });

    const repair = mutablePayload();
    ((repair.repair_library as Array<Record<string, unknown>>)[0]!).text = "leaked and mutated";
    rehash(repair);
    mutations.push({ payload: repair, expected: /repair entry is invalid/ });

    const parity = mutablePayload();
    (((parity.arm_information_parity_source as Record<string, unknown>).native_unit_ids as string[])).pop();
    rehash(parity);
    mutations.push({ payload: parity, expected: /parity coverage mismatch/ });

    const scoring = mutablePayload();
    (((scoring.scoring as Record<string, unknown>).primary_conjuncts as string[])).pop();
    rehash(scoring);
    mutations.push({ payload: scoring, expected: /scoring contract drifted/ });

    const semanticRegistry = mutablePayload();
    const registryOpportunities = ((semanticRegistry.listener_semantic_registry as Record<string, unknown>).opportunities as Array<Record<string, unknown>>);
    const firstCriteria = registryOpportunities.find((item) => (item.criteria as unknown[]).length > 0)!.criteria as Array<Record<string, unknown>>;
    (firstCriteria[0]!.phrases as string[])[0] = "post-hoc phrase selected after outcome inspection";
    rehash(semanticRegistry);
    mutations.push({ payload: semanticRegistry, expected: /listener semantic registry hash or criterion plan mismatch/ });

    for (const mutation of mutations) {
      expect(() => assertLc4GenericScenarioPayload(mutation.payload)).toThrow(mutation.expected);
    }
  }, 30_000);

  it("permanently denies the published development seed to sealed custody mode", () => {
    expect(() => assertLc4ConfirmatorySeedNotDevelopment(LC4_DEVELOPMENT_TEST_SEED_BYTES)).toThrow(/permanently forbidden/);
    expect(() => generator("sealed-custody-only").generate(LC4_DEVELOPMENT_TEST_SEED_BYTES)).toThrow(/permanently forbidden/);
    expect(() => generator().generate(Uint8Array.from({ length: 32 }, (_, index) => index + 1))).toThrow(/only the published LC4 test seed/);
  });

  it("passes the development corpus through the seal-only boundary without public plaintext", () => {
    const genericGenerator = generator();
    const sealed = sealLc4HeldoutCandidate({
      generator: genericGenerator,
      seed: new Uint8Array(LC4_DEVELOPMENT_TEST_SEED_BYTES),
      encryptionKey: Uint8Array.from({ length: 32 }, (_, index) => index + 51),
      nonce: Uint8Array.from({ length: 12 }, (_, index) => index + 151),
      custody: {
        seedCustodianId: "custodian.development-seed",
        keyCustodianId: "custodian.development-key",
        preparationOperatorId: "operator.development-seal",
        custodyProcedureSha256: sha256Hex("development-only-custody-procedure"),
      },
      createdAt: "2026-07-21T22:00:00.000Z",
    });
    const publicBytes = JSON.stringify(sealed);
    expect(publicBytes).not.toContain("freight-customs");
    expect(publicBytes).not.toContain("Rule 1.1");
    expect(publicBytes).not.toContain("synthetic bonded shipment");
    const expectedRegistryRoot = createLc4FrozenListenerSemanticRegistryManifest(
      payloads().map((payload) => payload.listener_semantic_registry),
    ).manifest_sha256;
    expect(sealed.manifest.corpus.listener_semantic_registry_manifest_sha256).toBe(expectedRegistryRoot);
    expect(publicBytes).not.toContain("post-hoc phrase");
    expect(verifyLc4HeldoutCommitment(sealed, sealed.manifest.manifest_sha256).valid).toBe(true);
  }, 30_000);
});

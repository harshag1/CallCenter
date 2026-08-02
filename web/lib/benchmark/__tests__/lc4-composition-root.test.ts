import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import { sealLc4HeldoutCandidate, type Lc4GeneratedHeldoutTemplate } from "../lc4-heldout-commitment";
import {
  compileLc4CompositionRoot,
  lc4AuthorizedGeneratedCorpusSha256,
  type Lc4AuthorizedUnsealedGeneratedCorpus,
} from "../lc4-composition-root";
import {
  LC4_DEVELOPMENT_TEST_SEED_BYTES,
  createLc4GenericHeldoutGenerator,
} from "../lc4-heldout-generator";
import { compileLc4ProductionScheduleShape } from "../lc4-production-runner-foundation";

const H = "a".repeat(64);

function sealedBundleFor(templates: readonly Lc4GeneratedHeldoutTemplate[]) {
  return sealLc4HeldoutCandidate({
    generator: {
      generatorId: "lc4.generic-heldout-generator",
      generatorVersion: "1.1.0",
      generatorSourceSha256: "1".repeat(64),
      corpusSchemaSha256: "2".repeat(64),
      generate: () => templates,
    },
    seed: new Uint8Array(32).fill(3),
    encryptionKey: new Uint8Array(32).fill(4),
    nonce: new Uint8Array(12).fill(5),
    custody: {
      seedCustodianId: "seed-custodian",
      keyCustodianId: "key-custodian",
      preparationOperatorId: "preparation-operator",
      custodyProcedureSha256: "3".repeat(64),
    },
    createdAt: "2026-07-21T00:00:00.000Z",
  });
}

function corpusWithTemplates(
  base: Lc4AuthorizedUnsealedGeneratedCorpus,
  templates: readonly Lc4GeneratedHeldoutTemplate[],
): Lc4AuthorizedUnsealedGeneratedCorpus {
  const sealedBundle = sealedBundleFor(templates);
  return {
    ...base,
    commitment: {
      sealed_bundle: sealedBundle,
      independently_published_manifest_sha256: sealedBundle.manifest.manifest_sha256,
    },
    templates,
    corpus_sha256: lc4AuthorizedGeneratedCorpusSha256(templates),
  };
}

function fixtures() {
  const templates = createLc4GenericHeldoutGenerator({
    executionMode: "development-test-only",
    generatorSourceSha256: "1".repeat(64),
    corpusSchemaSha256: "2".repeat(64),
  }).generate(LC4_DEVELOPMENT_TEST_SEED_BYTES);
  const sealedBundle = sealedBundleFor(templates);
  const corpus: Lc4AuthorizedUnsealedGeneratedCorpus = {
    schema_version: 1,
    protocol_id: "HACC-LC4-v1",
    authorization: {
      scope: "provider_free_composition_only",
      authorization_receipt_sha256: H,
      provider_calls_authorized: false,
      plaintext_logging_authorized: false,
    },
    commitment: {
      sealed_bundle: sealedBundle,
      independently_published_manifest_sha256: sealedBundle.manifest.manifest_sha256,
    },
    templates,
    corpus_sha256: lc4AuthorizedGeneratedCorpusSha256(templates),
  };
  const schedule = compileLc4ProductionScheduleShape();
  return { corpus, schedule, episode: schedule.episode_shapes[0]! };
}

function rehashPayload(payload: Record<string, unknown>): void {
  const body = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "content_sha256"));
  payload.content_sha256 = sha256Hex(canonicalJson(body));
}

describe("LC4 deterministic composition root", () => {
  it("compiles one authorized template into all arm-neutral and arm-specific inputs", () => {
    const input = fixtures();
    const first = compileLc4CompositionRoot(input);
    const second = compileLc4CompositionRoot(input);

    expect(second).toEqual(first);
    expect(first.provider_calls_authorized).toBe(false);
    expect(first.execution_scope).toBe("provider_free_composition_only");
    expect(first.generator_schedule_join.bindings).toHaveLength(24);
    expect(first.heldout_commitment_manifest_sha256).toBe(input.corpus.commitment.sealed_bundle.manifest.manifest_sha256);
    expect(first.caller_automaton.states).toHaveLength(60);
    expect(first.caller_automaton.states[0]?.state_id).toBe("caller-state.001");
    expect(first.caller_automaton.states[59]?.next_state_id).toBe("terminal");
    expect(first.hacc.flow.schema_version).toBe(2);
    expect(first.hacc.flow.tool_exposure).toBe("gateway");
    expect(first.hacc.response_plan_static_inputs).toHaveLength(60);
    expect(first.native_context.instructions).toContain("Facts are not included here");
    expect(first.information_parity.units.filter((unit) => unit.kind === "fact").every((unit) => (
      unit.native_delivery === "caller_audio" && unit.hacc_delivery === "caller_audio"
    ))).toBe(true);
    expect(first.semantic_registry_manifest.entries).toHaveLength(24);
    expect(first.semantic_plan.registry_manifest_sha256).toBe(first.semantic_registry_manifest.manifest_sha256);
    expect(first.repair.stages).toHaveLength(12);
    expect(first.repair.pcm_requirements).toHaveLength(192);
    expect(first.workers.jobs).toHaveLength(4);
    expect(first.workers.faults).toHaveLength(4);
    expect(first.scoring_oracle.primary_conjuncts).toHaveLength(10);
    expect(first.scoring_oracle.arm_blind).toBe(true);
    expect(first.scoring_oracle.provider_blind).toBe(true);
    expect(first.root_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails closed when the exact 24-template power-plan join is incomplete", () => {
    const input = fixtures();
    const templates = input.corpus.templates.slice(0, -1);
    expect(() => compileLc4CompositionRoot({
      ...input,
      corpus: { ...input.corpus, templates, corpus_sha256: lc4AuthorizedGeneratedCorpusSha256(templates) },
    })).toThrow(/plaintext differs|exactly 24 templates/u);
  });

  it("composes every structural variant, including final stages whose deadline precedes turn 60", () => {
    const input = fixtures();
    for (const templateId of ["lc4-template-01", "lc4-template-02", "lc4-template-03", "lc4-template-04"]) {
      const episode = input.schedule.episode_shapes.find((candidate) => candidate.template_id === templateId)!;
      const root = compileLc4CompositionRoot({ ...input, episode });
      expect(root.episode.template_id).toBe(templateId);
      expect(root.caller_automaton.states[59]?.stage_id).toBe("checkpoint.12");
    }
  }, 15_000);

  it("keeps every arm-common artifact byte-identical across a matched Native/HACC pair", () => {
    const input = fixtures();
    const pairEpisodes = input.schedule.episode_shapes.filter((candidate) => candidate.pair_id === input.episode.pair_id);
    expect(pairEpisodes.map((episode) => episode.arm).sort()).toEqual(["hacc", "native"]);
    const left = compileLc4CompositionRoot({ ...input, episode: pairEpisodes[0]! });
    const right = compileLc4CompositionRoot({ ...input, episode: pairEpisodes[1]! });
    for (const key of [
      "caller_automaton",
      "information_parity",
      "native_context",
      "hacc",
      "semantic_registry_manifest",
      "semantic_plan",
      "repair",
      "workers",
      "scoring_oracle",
    ] as const) {
      expect(canonicalJson(left[key])).toBe(canonicalJson(right[key]));
    }
  });

  it("fails closed on template taxonomy or selected episode drift", () => {
    const input = fixtures();
    const templates = structuredClone(input.corpus.templates);
    (templates[0] as { family_slot: number }).family_slot = 2;
    expect(() => compileLc4CompositionRoot({
      ...input,
      corpus: corpusWithTemplates(input.corpus, templates),
    })).toThrow(/duplicate structural slots|vocabulary drifted/u);

    expect(() => compileLc4CompositionRoot({
      ...input,
      episode: { ...input.episode, family: "not-the-frozen-family" },
    })).toThrow(/differs from the frozen schedule/u);
  });

  it("fails closed on stage and canonical fact-binding drift even after payload rehashing", () => {
    const stageInput = fixtures();
    const stageTemplates = structuredClone(stageInput.corpus.templates);
    const stagePayload = stageTemplates[0]!.payload as Record<string, unknown>;
    const stageOpportunities = stagePayload.opportunities as Array<Record<string, unknown>>;
    stageOpportunities[0]!.stage_id = "checkpoint.12";
    (stageOpportunities[0]!.canonical_caller_utterance as Record<string, unknown>).stage_id = "checkpoint.12";
    rehashPayload(stagePayload);
    expect(() => compileLc4CompositionRoot({
      ...stageInput,
      corpus: corpusWithTemplates(stageInput.corpus, stageTemplates),
    })).toThrow(/stage identity|opportunity-to-stage/u);

    const factInput = fixtures();
    const factTemplates = structuredClone(factInput.corpus.templates);
    const factPayload = factTemplates[0]!.payload as Record<string, unknown>;
    const opportunities = factPayload.opportunities as Array<Record<string, unknown>>;
    const utterance = opportunities[0]!.canonical_caller_utterance as Record<string, unknown>;
    utterance.fact_bindings = [];
    rehashPayload(factPayload);
    expect(() => compileLc4CompositionRoot({
      ...factInput,
      corpus: corpusWithTemplates(factInput.corpus, factTemplates),
    })).toThrow(/fact-introduction|fact introduction|omits a fact/u);
  }, 15_000);

  it("rejects semantic-registry substitution and authorization widening", () => {
    const semanticInput = fixtures();
    const semanticTemplates = structuredClone(semanticInput.corpus.templates);
    const payload = semanticTemplates[0]!.payload as Record<string, unknown>;
    const registry = payload.listener_semantic_registry as Record<string, unknown>;
    registry.registry_sha256 = "f".repeat(64);
    rehashPayload(payload);
    expect(() => compileLc4CompositionRoot({
      ...semanticInput,
      corpus: corpusWithTemplates(semanticInput.corpus, semanticTemplates),
    })).toThrow(/semantic registry/u);

    const authorizationInput = fixtures();
    expect(() => compileLc4CompositionRoot({
      ...authorizationInput,
      corpus: {
        ...authorizationInput.corpus,
        authorization: {
          ...authorizationInput.corpus.authorization,
          provider_calls_authorized: true,
        } as never,
      },
    })).toThrow(/exceeds provider-free scope/u);
  });
});

import { describe, expect, it } from "vitest";
import { canonicalJson } from "../artifacts";
import {
  LC4_CONFIRMATORY_FAMILY_SLUGS,
  LC4_PUBLIC_DEV_ARMS,
  LC4_PUBLIC_DEV_PROVIDERS,
  assertLc4PublicDevelopmentCorpus,
  createLc4PublicDevelopmentCorpus,
} from "../lc4-public-development-corpus";

describe("LC4 public mechanism-development corpus", () => {
  it("is byte-deterministic, immutable, and rejects independent mutation", () => {
    const first = createLc4PublicDevelopmentCorpus();
    const replay = createLc4PublicDevelopmentCorpus();
    expect(canonicalJson(replay)).toBe(canonicalJson(first));
    expect(first.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);

    const mutation = structuredClone(first) as unknown as {
      opportunities: Array<{ canonical_caller_text: string }>;
    };
    mutation.opportunities[11]!.canonical_caller_text = "Use the obsolete record.";
    expect(() => assertLc4PublicDevelopmentCorpus(mutation)).toThrow(/caller text commitment mismatch/);
  });

  it("contains one exact 60-opportunity, three-act scenario with complete bindings", () => {
    const corpus = createLc4PublicDevelopmentCorpus();
    expect(corpus.opportunities.map((item) => item.index)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    expect(corpus.opportunities.slice(0, 20).every((item) => item.act === "establish")).toBe(true);
    expect(corpus.opportunities.slice(20, 40).every((item) => item.act === "interleave")).toBe(true);
    expect(corpus.opportunities.slice(40).every((item) => item.act === "reconcile")).toBe(true);
    expect(new Set(corpus.opportunities.map((item) => item.canonical_caller_text)).size).toBe(60);
    expect(corpus.opportunities.every((item) => item.stage_id && item.goal_id && item.canonical_caller_text_sha256)).toBe(true);
    expect(corpus.shape).toMatchObject({
      future_relevant_facts: 10,
      corrections: 4,
      memory_probes: 12,
      checkpoints: 12,
      worker_launches: 4,
      provider_connection_rotations: 2,
      committed_after_error_mutations: 1,
      authoritative_reconciliations: 1,
    });
  });

  it("is visibly disjoint from confirmatory LC4 and permanently claim-ineligible", () => {
    const corpus = createLc4PublicDevelopmentCorpus();
    expect(LC4_CONFIRMATORY_FAMILY_SLUGS).not.toContain(corpus.domain.family_slug);
    expect(corpus).toMatchObject({
      study_role: "mechanism-evidence-only",
      efficacy_claim_eligible: false,
      confirmatory_reuse_permitted: false,
      provider_calls_authorized_by_artifact: false,
    });
    expect(corpus.provenance).toMatchObject({
      license: "CC0-1.0",
      generated_from_confirmatory_plaintext: false,
      provider_output_used: false,
    });
  });

  it("defines exactly one paired Registered Native comparator/HACC episode for every provider", () => {
    const corpus = createLc4PublicDevelopmentCorpus();
    expect(corpus.six_episode_canary_schedule).toHaveLength(6);
    expect(new Set(corpus.six_episode_canary_schedule.map((row) => row.template_id))).toEqual(new Set([corpus.template_id]));
    for (const provider of LC4_PUBLIC_DEV_PROVIDERS) {
      const pair = corpus.six_episode_canary_schedule.filter((row) => row.provider === provider);
      expect(new Set(pair.map((row) => row.arm))).toEqual(new Set(LC4_PUBLIC_DEV_ARMS));
      expect(new Set(pair.map((row) => row.source_corpus_sha256)).size).toBe(1);
      expect(new Set(pair.map((row) => row.caller_voice_slot)).size).toBe(1);
    }
  });

  it("precommits arm-blind repairs and an exact final-state oracle", () => {
    const corpus = createLc4PublicDevelopmentCorpus();
    expect(corpus.repair_policy.library).toHaveLength(24);
    for (const stage of new Set(corpus.repair_policy.library.map((repair) => repair.stage_id))) {
      const stageRepairs = corpus.repair_policy.library.filter((repair) => repair.stage_id === stage);
      expect(stageRepairs).toHaveLength(4);
      for (const blocker of new Set(stageRepairs.map((repair) => repair.blocker_code))) {
        expect(stageRepairs.filter((repair) => repair.blocker_code === blocker).map((repair) => repair.repair_ordinal)).toEqual([1, 2]);
      }
    }
    expect(new Set(corpus.repair_policy.library.map((row) => row.stage_id)).size).toBe(6);
    expect(corpus.repair_policy.maximum_repairs_per_episode).toBe(4);
    expect(corpus.repair_policy.repairs_do_not_extend_horizon).toBe(true);
    expect(corpus.expected_final_oracle.current_fact_versions).toEqual({
      guest_name: 2,
      patron_record: 2,
      transcript_format: 2,
      visit_date: 2,
    });
    expect(corpus.expected_final_oracle.effect_invariants).toHaveLength(4);
  });

  it("contains no provider client or network execution surface", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../lc4-public-development-corpus.ts", import.meta.url), "utf8"));
    expect(source).not.toMatch(/from ["'](?:ws|@google\/genai|openai)["']/);
    expect(source).not.toMatch(/\bfetch\s*\(|new WebSocket|generateContent|responses\.create/);
  });
});

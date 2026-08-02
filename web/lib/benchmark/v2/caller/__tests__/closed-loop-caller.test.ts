import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../../../artifacts";
import {
  COMMON_CALLER_OPPORTUNITY_IDS,
  HACC_V2_DEVELOPMENT_CORPUS_SHA256,
  advanceClosedLoopCaller,
  createClosedLoopCallerState,
  createDevelopmentCallerCorpus,
  createSignedArmBlindCallerObservation,
  finalizeSignedCallerLedgers,
  projectArmBlindCallerObservation,
  verifySignedCallerLedgers,
  type ClosedLoopCallerState,
  type DevelopmentCorpus,
} from "..";

const AUDIO_SHA256 = sha256Hex("caller-played-audio-fixture");
const OBSERVATION_KEYS = generateKeyPairSync("ed25519");
const SOURCE_LEDGER_HEADS = Object.freeze({
  audibility_ledger_head_sha256: sha256Hex("audibility-ledger-head"),
  world_ledger_head_sha256: sha256Hex("world-ledger-head"),
});

function observation(input: Readonly<{
  semantics?: readonly string[];
  async_status?: string;
  ambiguous_status?: string;
  arm?: "registered_native" | "full_hacc";
  private_nonce?: string;
}> = {}): unknown {
  return {
    schema_version: 1,
    arm: input.arm,
    prompt: input.arm === "full_hacc" ? "private HACC prompt" : "private Native prompt",
    grants: input.arm === "full_hacc" ? ["private-grant"] : [],
    score: input.arm === "full_hacc" ? 1 : 0,
    private_state: { nonce: input.private_nonce ?? "private-a", hidden_answer: "must-never-affect-caller" },
    listener: {
      provider_transcript: input.arm === "full_hacc" ? "private transcript A" : "private transcript B",
      played_audio_semantics: (input.semantics ?? []).map((semanticId, index) => ({
        semantic_id: semanticId,
        disposition: "heard",
        playback_range_id: `range-${String(index + 1).padStart(2, "0")}`,
        played_audio_sha256: AUDIO_SHA256,
        confidence: input.arm === "full_hacc" ? 0.99 : 0.51,
      })),
    },
    world: {
      revision: 7,
      facts: {
        ambiguous_effect_status: input.ambiguous_status ?? "unknown",
        async_result_status: input.async_status ?? "pending",
        private_arm_state: input.arm,
        private_score: input.arm === "full_hacc" ? 100 : -100,
      },
      private_receipts: input.arm === "full_hacc" ? ["receipt-a"] : ["receipt-b"],
    },
  };
}

function advance(
  corpus: DevelopmentCorpus,
  state: ClosedLoopCallerState,
  rawObservation: unknown,
  selectedAt: string,
) {
  const observationReceipt = createSignedArmBlindCallerObservation({
    corpus,
    state,
    untrusted_observation: rawObservation,
    source_ledger_heads: SOURCE_LEDGER_HEADS,
    signing_authority: { key_id: "caller-observation-key-001", private_key: OBSERVATION_KEYS.privateKey },
    prior_observation_verification_authority: {
      key_id: "caller-observation-key-001",
      public_key: OBSERVATION_KEYS.publicKey,
    },
  });
  return advanceClosedLoopCaller({
    corpus,
    state,
    observation_receipt: observationReceipt,
    observation_verification_authority: {
      key_id: "caller-observation-key-001",
      public_key: OBSERVATION_KEYS.publicKey,
    },
    selected_at: selectedAt,
  });
}

function runEight(input: Readonly<{
  corpus: DevelopmentCorpus;
  arm: "registered_native" | "full_hacc";
  template_id?: string;
  run_id?: string;
}>): ClosedLoopCallerState {
  let state = createClosedLoopCallerState({
    corpus: input.corpus,
    template_id: input.template_id ?? input.corpus.templates[0]!.template_id,
    run_id: input.run_id ?? "caller-pair-development-001",
  });
  const semantics = [
    [],
    ["opp-01.primary-goal-acknowledged"],
    ["opp-01.primary-goal-acknowledged", "opp-02-both-goals-retained"],
    ["opp-01.primary-goal-acknowledged", "opp-02-both-goals-retained", "opp-03-correction-acknowledged"],
    ["opp-04-worker-and-prohibition-acknowledged"],
    ["opp-05-state-resumed"],
    ["opp-06-ambiguity-handled-safely"],
    ["opp-07-async-result-treated-authoritatively"],
  ] as const;
  for (let index = 0; index < 8; index += 1) {
    state = advance(
      input.corpus,
      state,
      observation({
        arm: input.arm,
        private_nonce: `${input.arm}-${index}`,
        semantics: semantics[index],
        ambiguous_status: "committed",
        async_status: "completed",
      }),
      `2026-08-02T00:00:${String(index).padStart(2, "0")}.000Z`,
    ).state;
  }
  return state;
}

describe("HACC-Proof-v1 development caller corpus", () => {
  it("freezes 24 independent, provider-neutral templates allocated 8 per stratum", () => {
    const corpus = createDevelopmentCallerCorpus();
    expect(corpus.corpus_sha256).toBe(HACC_V2_DEVELOPMENT_CORPUS_SHA256);
    expect(corpus.templates).toHaveLength(24);
    expect(new Set(corpus.templates.map((item) => item.template_id))).toHaveLength(24);
    expect(new Set(corpus.templates.map((item) => item.seed))).toHaveLength(24);
    expect(new Set(corpus.templates.map((item) => item.domain))).toHaveLength(24);
    expect(new Set(corpus.templates.map((item) => item.lineage.independence_unit_id))).toHaveLength(24);
    expect(corpus).toMatchObject({
      study_role: "development",
      confirmatory_eligible: false,
      license: "CC0-1.0",
    });
    for (const provider of ["openai", "gemini", "xai"] as const) {
      expect(corpus.templates.filter((item) => item.allocation.provider_stratum === provider)).toHaveLength(8);
    }
    for (const template of corpus.templates) {
      expect(template.lineage).toEqual({
        independence_unit_id: template.template_id,
        parent_template_id: null,
        confirmatory_ancestor: false,
        shared_structure_cluster_id: "hacc-proof-v1-dev-eight-opportunity-v2",
      });
      expect(template.opportunities.map((item) => item.opportunity_id)).toEqual(COMMON_CALLER_OPPORTUNITY_IDS);
      const eventKinds = new Set(template.opportunities.flatMap((item) => item.event_kinds));
      expect(eventKinds).toEqual(new Set([
        "delayed_obligation", "detour", "correction", "barge_in", "forbidden_action",
        "async_worker_launch", "reconnect", "ambiguous_effect", "async_result", "closeout",
      ]));
      const content = Object.fromEntries(Object.entries(template).filter(([key]) => key !== "allocation"));
      expect(canonicalJson(content)).not.toMatch(/\b(?:openai|gemini|xai)\b/i);
    }
    expect(Object.isFrozen(corpus)).toBe(true);
    expect(canonicalJson(createDevelopmentCallerCorpus())).toBe(canonicalJson(corpus));
  });

  it("projects only played-audio semantics and allowlisted world facts", () => {
    const corpus = createDevelopmentCallerCorpus();
    const template = corpus.templates[0]!;
    const native = projectArmBlindCallerObservation(template, observation({
      arm: "registered_native",
      private_nonce: "native-private",
      semantics: ["opp-01.primary-goal-acknowledged"],
    }));
    const hacc = projectArmBlindCallerObservation(template, observation({
      arm: "full_hacc",
      private_nonce: "hacc-private",
      semantics: ["opp-01.primary-goal-acknowledged"],
    }));
    expect(canonicalJson(native)).toBe(canonicalJson(hacc));
    expect(canonicalJson(native)).not.toMatch(/arm|prompt|grant|score|private|transcript|receipt/i);
    expect(Object.keys(native.world.facts).sort()).toEqual(["ambiguous_effect_status", "async_result_status"]);
  });

  it("is closed-loop: audible semantics and permitted world status change only registered branches", () => {
    const corpus = createDevelopmentCallerCorpus();
    const initial = createClosedLoopCallerState({
      corpus,
      template_id: corpus.templates[0]!.template_id,
      run_id: "caller-closed-loop-test-001",
    });
    const first = advance(corpus, initial, observation(), "2026-08-02T00:00:00.000Z");
    const repaired = advance(corpus, first.state, observation({ semantics: [] }), "2026-08-02T00:00:01.000Z");
    const advanced = advance(
      corpus,
      first.state,
      observation({ semantics: ["opp-01.primary-goal-acknowledged"] }),
      "2026-08-02T00:00:01.000Z",
    );
    expect(repaired.selection.path).toBe("repair");
    expect(repaired.state.next_opportunity_index).toBe(1);
    expect(advanced.selection.path).toBe("advance");
    expect(advanced.state.next_opportunity_index).toBe(2);

    let state = first.state;
    const required = [
      ["opp-01.primary-goal-acknowledged"],
      ["opp-02-both-goals-retained"],
      ["opp-03-correction-acknowledged"],
      ["opp-04-worker-and-prohibition-acknowledged"],
      ["opp-05-state-resumed"],
    ];
    for (let index = 0; index < required.length; index += 1) {
      state = advance(
        corpus,
        state,
        observation({ semantics: required[index], ambiguous_status: "committed" }),
        `2026-08-02T00:01:0${index}.000Z`,
      ).state;
    }
    const pending = advance(
      corpus,
      state,
      observation({ semantics: ["opp-06-ambiguity-handled-safely"], async_status: "pending" }),
      "2026-08-02T00:02:00.000Z",
    );
    const completed = advance(
      corpus,
      state,
      observation({ semantics: ["opp-06-ambiguity-handled-safely"], async_status: "completed" }),
      "2026-08-02T00:02:00.000Z",
    );
    expect(pending.selection.path).toBe("pending");
    expect(completed.selection.path).toBe("settled");

    let repeatedlyPending = pending.state;
    for (let index = 1; index < 4; index += 1) {
      repeatedlyPending = advance(
        corpus,
        repeatedlyPending,
        observation({ semantics: ["opp-06-ambiguity-handled-safely"], async_status: "pending" }),
        `2026-08-02T00:02:0${index}.000Z`,
      ).state;
    }
    expect(() => advance(
      corpus,
      repeatedlyPending,
      observation({ semantics: ["opp-06-ambiguity-handled-safely"], async_status: "pending" }),
      "2026-08-02T00:02:05.000Z",
    )).toThrow(/repair-selection budget exhausted/);
  });

  it("recovers from a missed acknowledgement without skipping or double-applying the correction", () => {
    const corpus = createDevelopmentCallerCorpus();
    let state = createClosedLoopCallerState({
      corpus,
      template_id: corpus.templates[0]!.template_id,
      run_id: "caller-repair-recovery-001",
    });
    state = advance(corpus, state, observation(), "2026-08-02T00:10:00.000Z").state;
    state = advance(corpus, state, observation(), "2026-08-02T00:10:01.000Z").state;
    expect(state.next_opportunity_index).toBe(1);
    state = advance(
      corpus,
      state,
      observation({ semantics: ["opp-01.primary-goal-acknowledged"] }),
      "2026-08-02T00:10:02.000Z",
    ).state;
    expect(state.next_opportunity_index).toBe(2);
    state = advance(corpus, state, observation(), "2026-08-02T00:10:03.000Z").state;
    expect(state.next_opportunity_index).toBe(2);
    expect(state.fact_entries.map((entry) => entry.revision)).toEqual([1]);
    state = advance(
      corpus,
      state,
      observation({ semantics: ["opp-02-both-goals-retained"] }),
      "2026-08-02T00:10:04.000Z",
    ).state;
    expect(state.next_opportunity_index).toBe(3);
    expect(state.fact_entries.map((entry) => [entry.revision, entry.value])).toEqual([
      [1, "patron record MPL-1042"],
      [2, "patron record MPL-1402"],
    ]);
  });

  it("proves arm-label, prompt, grant, score, and private-state mutation cannot change caller choices", () => {
    const corpus = createDevelopmentCallerCorpus();
    const native = runEight({ corpus, arm: "registered_native" });
    const hacc = runEight({ corpus, arm: "full_hacc" });
    expect(canonicalJson(hacc)).toBe(canonicalJson(native));
    expect(native.selection_entries.map((entry) => [entry.opportunity_id, entry.candidate_id, entry.input_projection_sha256]))
      .toEqual(hacc.selection_entries.map((entry) => [entry.opportunity_id, entry.candidate_id, entry.input_projection_sha256]));
    expect(native.fact_entries.map((entry) => [entry.fact_id, entry.revision, entry.value])).toEqual([
      ["primary_reference", 1, "patron record MPL-1042"],
      ["primary_reference", 2, "patron record MPL-1402"],
    ]);
  });

  it("executes every frozen template through the complete common opportunity horizon", () => {
    const corpus = createDevelopmentCallerCorpus();
    for (const [index, template] of corpus.templates.entries()) {
      const state = runEight({
        corpus,
        arm: "registered_native",
        template_id: template.template_id,
        run_id: `caller-template-replay-${String(index + 1).padStart(2, "0")}`,
      });
      expect(state.next_opportunity_index).toBe(COMMON_CALLER_OPPORTUNITY_IDS.length);
      expect(state.selection_entries.map((entry) => entry.opportunity_id)).toEqual(COMMON_CALLER_OPPORTUNITY_IDS);
      expect(state.fact_entries.map((entry) => [entry.revision, entry.value])).toEqual([
        [1, template.reference_v1],
        [2, template.reference_v2],
      ]);
    }
  });

  it("emits deterministic, cross-linked, Ed25519-signed selection and fact ledgers", () => {
    const corpus = createDevelopmentCallerCorpus();
    const state = runEight({ corpus, arm: "registered_native" });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const first = finalizeSignedCallerLedgers({
      corpus,
      state,
      signing_authority: { key_id: "caller-dev-key-001", private_key: privateKey },
      observation_verification_authority: {
        key_id: "caller-observation-key-001",
        public_key: OBSERVATION_KEYS.publicKey,
      },
      require_complete: true,
    });
    const replay = finalizeSignedCallerLedgers({
      corpus,
      state,
      signing_authority: { key_id: "caller-dev-key-001", private_key: privateKey },
      observation_verification_authority: {
        key_id: "caller-observation-key-001",
        public_key: OBSERVATION_KEYS.publicKey,
      },
      require_complete: true,
    });
    expect(canonicalJson(replay)).toBe(canonicalJson(first));
    expect(first.caller_selections.entry_count).toBe(8);
    expect(first.caller_fact_ledger.entry_count).toBe(2);
    expect(verifySignedCallerLedgers({
      corpus,
      ledgers: first,
      verification_authority: { key_id: "caller-dev-key-001", public_key: publicKey },
      observation_verification_authority: {
        key_id: "caller-observation-key-001",
        public_key: OBSERVATION_KEYS.publicKey,
      },
    })).toEqual({ valid: true, schedule_complete: true, errors: [] });

    const tampered = structuredClone(first) as unknown as {
      caller_selections: { entries: Array<{ candidate_id: string }> };
    };
    tampered.caller_selections.entries[3]!.candidate_id = "tampered.candidate";
    const invalid = verifySignedCallerLedgers({
      corpus,
      ledgers: tampered as never,
      verification_authority: { key_id: "caller-dev-key-001", public_key: publicKey },
      observation_verification_authority: {
        key_id: "caller-observation-key-001",
        public_key: OBSERVATION_KEYS.publicKey,
      },
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.join("\n")).toMatch(/hash mismatch|payload hash mismatch|signature verification failed/);

    const forgedState = structuredClone(state) as unknown as {
      selection_entries: Array<{ candidate_id: string }>;
    };
    forgedState.selection_entries[2]!.candidate_id = "invented.caller.branch";
    expect(() => finalizeSignedCallerLedgers({
      corpus,
      state: forgedState as never,
      signing_authority: { key_id: "caller-dev-key-001", private_key: privateKey },
      observation_verification_authority: {
        key_id: "caller-observation-key-001",
        public_key: OBSERVATION_KEYS.publicKey,
      },
      require_complete: true,
    })).toThrow(/caller state integrity failed/);

    const wrongKeys = generateKeyPairSync("ed25519");
    expect(verifySignedCallerLedgers({
      corpus,
      ledgers: first,
      verification_authority: { key_id: "caller-dev-key-001", public_key: wrongKeys.publicKey },
      observation_verification_authority: {
        key_id: "caller-observation-key-001",
        public_key: OBSERVATION_KEYS.publicKey,
      },
    }).valid).toBe(false);

    expect(verifySignedCallerLedgers({
      corpus,
      ledgers: {} as never,
      verification_authority: { key_id: "caller-dev-key-001", public_key: publicKey },
      observation_verification_authority: {
        key_id: "caller-observation-key-001",
        public_key: OBSERVATION_KEYS.publicKey,
      },
    })).toMatchObject({ valid: false, schedule_complete: false });
  });

  it("distinguishes cryptographically valid partial evidence from a complete caller schedule", () => {
    const corpus = createDevelopmentCallerCorpus();
    const state = createClosedLoopCallerState({
      corpus,
      template_id: corpus.templates[0]!.template_id,
      run_id: "caller-partial-evidence-001",
    });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const common = {
      corpus,
      state,
      signing_authority: { key_id: "caller-partial-key-001", private_key: privateKey },
      observation_verification_authority: {
        key_id: "caller-observation-key-001",
        public_key: OBSERVATION_KEYS.publicKey,
      },
    } as const;
    expect(() => finalizeSignedCallerLedgers({ ...common, require_complete: true })).toThrow(/before every common opportunity/);
    const partial = finalizeSignedCallerLedgers({ ...common, require_complete: false });
    expect(verifySignedCallerLedgers({
      corpus,
      ledgers: partial,
      verification_authority: { key_id: "caller-partial-key-001", public_key: publicKey },
      observation_verification_authority: {
        key_id: "caller-observation-key-001",
        public_key: OBSERVATION_KEYS.publicKey,
      },
    })).toEqual({ valid: true, schedule_complete: false, errors: [] });
  });

  it("fails closed on altered observable-source bindings and treats non-heard semantics as absent", () => {
    const corpus = createDevelopmentCallerCorpus();
    const initial = createClosedLoopCallerState({
      corpus,
      template_id: corpus.templates[0]!.template_id,
      run_id: "caller-source-binding-001",
    });
    const first = advance(corpus, initial, observation(), "2026-08-02T00:20:00.000Z");
    const receipt = createSignedArmBlindCallerObservation({
      corpus,
      state: first.state,
      untrusted_observation: {
        schema_version: 1,
        listener: {
          played_audio_semantics: [{
            semantic_id: "opp-01.primary-goal-acknowledged",
            disposition: "not_heard",
            playback_range_id: "range-not-heard-01",
            played_audio_sha256: AUDIO_SHA256,
          }],
        },
        world: { facts: { ambiguous_effect_status: "unknown", async_result_status: "pending" } },
      },
      source_ledger_heads: SOURCE_LEDGER_HEADS,
      signing_authority: { key_id: "caller-observation-key-001", private_key: OBSERVATION_KEYS.privateKey },
      prior_observation_verification_authority: {
        key_id: "caller-observation-key-001",
        public_key: OBSERVATION_KEYS.publicKey,
      },
    });
    const nonHeard = advanceClosedLoopCaller({
      corpus,
      state: first.state,
      observation_receipt: receipt,
      observation_verification_authority: {
        key_id: "caller-observation-key-001",
        public_key: OBSERVATION_KEYS.publicKey,
      },
      selected_at: "2026-08-02T00:20:01.000Z",
    });
    expect(nonHeard.selection.path).toBe("repair");

    const altered = structuredClone(receipt) as unknown as {
      source_evidence: { audibility_projection_sha256: string };
    };
    altered.source_evidence.audibility_projection_sha256 = sha256Hex("invented-audibility-projection");
    expect(() => advanceClosedLoopCaller({
      corpus,
      state: first.state,
      observation_receipt: altered as never,
      observation_verification_authority: {
        key_id: "caller-observation-key-001",
        public_key: OBSERVATION_KEYS.publicKey,
      },
      selected_at: "2026-08-02T00:20:01.000Z",
    })).toThrow(/audibility projection|signature/);
  });

  it("contains no provider client, credential, network, or scoring dependency", async () => {
    const sources = await Promise.all([
      new URL("../closed-loop-caller.ts", import.meta.url),
      new URL("../corpus.ts", import.meta.url),
    ].map((url) => readFile(url, "utf8")));
    for (const source of sources) {
      expect(source).not.toMatch(/from ["'](?:ws|openai|@google\/genai)["']/);
      expect(source).not.toMatch(/\bfetch\s*\(|new WebSocket|API_KEY|process\.env|score_v2/i);
    }
  });
});

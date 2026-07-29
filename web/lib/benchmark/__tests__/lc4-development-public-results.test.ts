import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  assertLc4DevPublicResultArtifact,
  createLc4DevPublicResultArtifact,
  publishLc4DevPublicResult,
  renderLc4DevPublicResultMarkdown,
  unsafeVerifyLc4DevEvidenceRootForTestsOnly,
} from "../lc4-development-public-results";
import { runLc4DevPublicResultCli } from "../lc4-development-public-results-cli";
import {
  createLc4PublicationTransportProvenance,
  deriveLc4PublicationModelIdentityVerification,
  verifyLc4PublicationTransportProvenance,
} from "../lc4-publication-transport-provenance";
import {
  LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
} from "../lc4-development-qualification-v3";
import {
  LC4_PROVIDER_PROFILE_MANIFEST,
  LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE,
} from "../lc4-provider-profiles";
import {
  createLc4PublicationTransportReplay,
} from "../lc4-publication-transport-replay";
import {
  createLc4ProviderExecutionProfile,
} from "../lc4-production-runner-foundation";

const H = (value: string) => sha256Hex(value);

function transportReplay(runSha256 = H("run")) {
  return createLc4PublicationTransportReplay({
    run_sha256: runSha256,
    provider_profile_manifest_sha256:
      LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    audio_delivery_profile_sha256: H("audio-delivery"),
    listener_authority_trust_root_sha256: H("listener-authority-root"),
    canonical_provider_exchange_count: 360,
    repair_provider_exchange_count: 4,
    total_response_generation_count: 364,
    episodes: (["openai", "gemini", "xai"] as const).flatMap((provider) => {
      const profile = createLc4ProviderExecutionProfile(provider);
      return (["native", "hacc"] as const).map((arm) => ({
        ...(() => {
          const repairCount = arm === "hacc"
            ? provider === "xai" ? 2 : 1
            : 0;
          return {
            repair_provider_exchange_count: repairCount,
            total_response_generation_count: 60 + repairCount,
          };
        })(),
        episode_id: `${provider}-${arm}`,
        provider,
        arm,
        model: profile.model,
        transport_purpose: provider === "xai"
          ? "finite_prerecorded_efficacy" as const
          : null,
        transport_mode: "manual_commit" as const,
        transport_profile_sha256:
          profile.transport_profile_sha256 ?? profile.provider_profile_sha256,
        output_audio_lineage_scope: provider === "gemini"
          ? "client_observed_interval_wire_projection_capture_cas_evaluator_exact_complete_frame_attribution_provider_response_id_unavailable" as const
          : "client_observed_identity_scoped_wire_pcm_capture_cas_evaluator_exact" as const,
        canonical_provider_exchange_count: 60 as const,
        canonical_exchange_replay_set_sha256:
          H(`${provider}-${arm}-canonical-exchange-replay-set`),
        response_generation_replay_set_sha256:
          H(`${provider}-${arm}-response-generation-replay-set`),
        listener_authority_replay_set_sha256:
          H(`${provider}-${arm}-listener-authority-replay-set`),
        listener_invocation_replay_set_sha256:
          H(`${provider}-${arm}-listener-invocation-replay-set`),
      }));
    }),
  });
}

function verifiedEvidence(): Parameters<typeof createLc4DevPublicResultArtifact>[0] {
  const episodes = (["openai", "gemini", "xai"] as const).flatMap((provider) => (["native", "hacc"] as const).map((arm, armIndex) => ({
    episode_id: `${provider}-${arm}`,
    pair_id: provider,
    pair_position: armIndex,
    provider,
    arm,
    model: LC4_PROVIDER_PROFILE_MANIFEST.providers[provider].model,
    voice: "excluded-from-public-artifact",
    maximum_micro_usd: 2_500_000,
    opportunity_binding_set_sha256: H(`${provider}-${arm}-bindings`),
  })));
  return {
    prepare: {
      source_commit: "a".repeat(40),
      source_tree_sha256: H("source-tree"),
      prepare_sha256: H("prepare"),
      episodes,
    },
    preflight: { preflight_sha256: H("preflight") },
    run: {
      execution_id: "lc4-dev-public-fixture",
      started_at: "2026-07-22T06:00:00.000Z",
      completed_at: "2026-07-22T07:00:00.000Z",
      status: "completed",
      episodes_started: 6,
      episodes_completed: 6,
      opportunities_submitted: 360,
      opportunities_completed: 360,
      response_generations_completed: 364,
      repair_playbacks: 4,
      paid_retry_count: 0,
      run_sha256: H("run"),
    },
    lease: {},
    budget: {
      maximum_total_micro_usd: 15_000_000,
      conservative_settled_micro_usd: 12_345_678,
      active_reservations_micro_usd: 0,
      evidence_sha256: H("budget-evidence"),
      terminal_ledger_head_sha256: H("terminal-ledger"),
      reservations: episodes.map((episode) => ({ episode_id: episode.episode_id, provider: episode.provider, status: "settled" })),
    },
    package: { package_sha256: H("run-package") },
    report: {
      completed: true,
      exact_six_episode_horizon: true,
      exact_opportunity_horizon: true,
      exact_playback_accounting: true,
      authority_scoreability: "scorable",
      authority_passed: 5,
      authority_evaluated: 6,
      authority_evidence_invalid: 0,
      authority_replay_set_sha256: H("authority-replay-set"),
      evidence_complete: true,
      execution_evidence_complete: true,
      task_results_available: true,
      budget_replay_verified: true,
      report_sha256: H("report"),
    },
    authority: {
      status: "scorable",
      passed: 5,
      evaluated: 6,
      evidence_invalid: 0,
      episode_replay_sha256s: Array.from({ length: 6 }, (_, index) => H(`authority-replay-${index}`)),
      errors: [],
    },
    transport_replay: transportReplay(),
  } as unknown as Parameters<typeof createLc4DevPublicResultArtifact>[0];
}

function transportProvenance() {
  return createLc4PublicationTransportProvenance({
    retained_gate_b_receipt_sha256: H("gate-b-receipt"),
    xai_finite_manual_gate_d_receipt_sha256: H("gate-d-receipt"),
    transport_replay: transportReplay(),
    qualification_replay_sha256: {
      openai: H("openai-gate-b-replay"),
      gemini: H("gemini-gate-b-replay"),
      xai: H("xai-gate-d-replay"),
    },
    model_identity_verification: {
      openai: "provider_verified",
      gemini: "request_only",
      xai: "provider_verified",
    },
  });
}

describe("LC4-DEV public results", () => {
  it("builds one deterministic C3 mechanism artifact without private evidence fields", () => {
    const first = createLc4DevPublicResultArtifact(verifiedEvidence(), transportProvenance());
    const second = createLc4DevPublicResultArtifact(verifiedEvidence(), transportProvenance());
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first).toMatchObject({
      schema_version: 4,
      evidence_class: "C3",
      study_role: "development_mechanism_evidence_only",
      efficacy_claim_eligible: false,
      confirmatory_reuse_permitted: false,
      execution: { episodes_completed: 6, opportunities_completed: 360, paid_retry_count: 0 },
      qualification: {
        xai_finite_manual_transport_qualification: "verified",
        xai_finite_manual_claim_boundary:
          "transport_qualification_only_not_efficacy_evidence",
      },
      evaluation: { authority_passed: 5, authority_evaluated: 6, task_results_available: true },
      privacy: {
        contains_transcripts: false,
        contains_pcm_or_audio: false,
        contains_wire_payloads: false,
        contains_local_paths: false,
        contains_private_credential_or_signing_key_material: false,
        contains_public_authority_trust_root: true,
        contains_provider_session_ids: false,
        contains_gate_d_receipt_path_or_trust_root: false,
      },
    });
    expect(canonicalJson(first)).not.toMatch(/excluded-from-public-artifact|credential_identity_set_sha256|fingerprint_sha256|signature_base64|ledger_path|pcm_sha256/u);
    expect(first.design.cells).toHaveLength(6);
    expect(first.design.cells.find((cell) =>
      cell.provider === "xai" && cell.arm === "native")).toMatchObject({
        turn_boundary_control: "client_explicit",
        wire_turn_boundary:
          "finite_clip_input_audio_buffer.commit_then_response.create",
        transport_purpose: "finite_prerecorded_efficacy",
        model_identity_verification: "provider_verified",
        qualification_scope: "xai_finite_manual_gate_d_exact_transport",
        qualification_receipt_sha256: H("gate-d-receipt"),
      });
    expect(() => assertLc4DevPublicResultArtifact(first)).not.toThrow();
  });

  it("renders a minimal deterministic receipt with explicit claim limits", () => {
    const result = createLc4DevPublicResultArtifact(verifiedEvidence(), transportProvenance());
    const markdown = renderLc4DevPublicResultMarkdown(result);
    expect(markdown).toContain("C3 mechanism evidence only");
    expect(markdown).toContain("| Authority passed | 5 |");
    expect(markdown).toContain("| Conservative ledger liability | $12.345678 |");
    expect(markdown).not.toContain("settled cost");
    expect(markdown).toContain(`| openai | ${LC4_PROVIDER_PROFILE_MANIFEST.providers.openai.model} | Registered Native comparator + HACC | 60 each |`);
    expect(markdown).toContain("Registered Native comparator means Native realtime API + common benchmark continuity");
    expect(markdown).toContain("does not authorize a HACC superiority claim");
    expect(markdown).toContain("360 opportunities are repeated within six calls, not 360 independent trials");
    expect(markdown).toContain("| xai | grok-voice-think-fast-1.0 | Registered Native comparator | finite_prerecorded_efficacy | client_explicit | finite_clip_input_audio_buffer.commit_then_response.create | client_observed_identity_scoped_wire_pcm_capture_cas_evaluator_exact | provider_verified | xai_finite_manual_gate_d_exact_transport |");
    expect(markdown).toContain("transport qualification only");
    expect(markdown).toContain(
      `Listener authority trust root: \`${H("listener-authority-root")}\``,
    );
    expect(markdown).not.toContain("excluded-from-public-artifact");
  });

  it("fails closed on hash, pair, unsafe model, and CLI surface drift", async () => {
    const valid = createLc4DevPublicResultArtifact(verifiedEvidence(), transportProvenance());
    expect(() => assertLc4DevPublicResultArtifact({ ...valid, evidence_class: "C4" } as never)).toThrow(/hash mismatch/);
    const extraClaim = structuredClone(valid) as unknown as Record<string, unknown>;
    extraClaim.superiority_claim = "HACC wins";
    const { public_result_sha256: _oldHash, ...extraBody } = extraClaim;
    void _oldHash;
    extraClaim.public_result_sha256 = sha256Hex(
      `harshas-amazing-call-center/lc4-dev-public-result/v4\n${canonicalJson(extraBody)}`,
    );
    expect(() => assertLc4DevPublicResultArtifact(extraClaim as never))
      .toThrow(/claim boundary or frozen design drifted/u);
    const summaryModelDrift = structuredClone(valid);
    (summaryModelDrift.design.providers[0] as { model: string }).model =
      "safe-but-different-model";
    const {
      public_result_sha256: oldSummaryHash,
      ...summaryDriftBody
    } = summaryModelDrift;
    void oldSummaryHash;
    (summaryModelDrift as { public_result_sha256: string })
      .public_result_sha256 = sha256Hex(
        `harshas-amazing-call-center/lc4-dev-public-result/v4\n${canonicalJson(summaryDriftBody)}`,
      );
    expect(() => assertLc4DevPublicResultArtifact(summaryModelDrift))
      .toThrow(/claim boundary or frozen design drifted/u);

    const missingPair = structuredClone(verifiedEvidence());
    (missingPair.prepare.episodes as unknown[]).pop();
    expect(() => createLc4DevPublicResultArtifact(missingPair, transportProvenance())).toThrow(/public pair is incomplete/);

    const unsafe = structuredClone(verifiedEvidence());
    (unsafe.prepare.episodes[0] as { model: string }).model = "/private/tmp/model";
    (unsafe.prepare.episodes[1] as { model: string }).model = "/private/tmp/model";
    expect(() => createLc4DevPublicResultArtifact(unsafe, transportProvenance())).toThrow(/model identifier is unsafe/);

    const stdout: string[] = [];
    const stderr: string[] = [];
    await expect(runLc4DevPublicResultCli(
      ["publish", "--evidence-root", "/tmp/evidence"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    )).resolves.toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "LC4-DEV public result CLI requires exactly: --authority-trust-root-sha256, --evidence-root, --gate-d-invocation-marker, --gate-d-receipt, --gate-d-trust-root-sha256, --output-root",
    ]);
  });

  it("rejects caller-built public artifacts and a missing evidence root on the release publisher", async () => {
    const synthetic = createLc4DevPublicResultArtifact(
      verifiedEvidence(),
      transportProvenance(),
    );
    const gateD = {
      receipt_path: "/definitely/missing/hacc-gate-d-receipt.json",
      invocation_marker_path:
        "/definitely/missing/hacc-gate-d-invocation.json",
      plan_trust_root_sha256: H("gate-d-trust"),
    };
    await expect(publishLc4DevPublicResult({
      artifact: synthetic,
      output_root: "/tmp/hacc-lc4-publication-bypass",
      authority_trust_root_sha256: H("listener-authority-root"),
      xai_finite_manual_gate_d: gateD,
    } as never)).rejects.toThrow(/evidence root/u);
    await expect(publishLc4DevPublicResult({
      evidence_root: "/definitely/missing/hacc-lc4-evidence-root",
      output_root: "/tmp/hacc-lc4-publication-missing-evidence",
      authority_trust_root_sha256: H("listener-authority-root"),
      xai_finite_manual_gate_d: gateD,
    })).rejects.toThrow();
  });

  it("keeps replay dependency injection unavailable outside the test runtime", async () => {
    const mutableEnv = process.env as Record<string, string | undefined>;
    const previous = mutableEnv.NODE_ENV;
    mutableEnv.NODE_ENV = "production";
    try {
      await expect(unsafeVerifyLc4DevEvidenceRootForTestsOnly(
        "/definitely/missing/hacc-lc4-evidence-root",
        H("listener-authority-root"),
        {},
      )).rejects.toThrow(/test-only/u);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(mutableEnv, "NODE_ENV");
      else mutableEnv.NODE_ENV = previous;
    }
  });

  it.each([
    ["failed run", (fixture: ReturnType<typeof verifiedEvidence>) => { (fixture.run as { status: string }).status = "failed"; }],
    ["incomplete horizon", (fixture: ReturnType<typeof verifiedEvidence>) => { (fixture.run as { opportunities_completed: number }).opportunities_completed = 359; }],
    ["unavailable task results", (fixture: ReturnType<typeof verifiedEvidence>) => { (fixture.report as { task_results_available: boolean }).task_results_available = false; }],
    ["invalid authority replay", (fixture: ReturnType<typeof verifiedEvidence>) => { (fixture.authority as { evidence_invalid: number }).evidence_invalid = 1; }],
    ["nonterminal budget", (fixture: ReturnType<typeof verifiedEvidence>) => { (fixture.budget.reservations[0] as { status: string }).status = "reserved"; }],
  ])("refuses publication for %s", (_label, mutate) => {
    const fixture = structuredClone(verifiedEvidence());
    mutate(fixture);
    expect(() => createLc4DevPublicResultArtifact(fixture, transportProvenance())).toThrow(/refuses to publish a C3 headline result/);
  });

  it("rejects missing or substituted per-cell transport qualification provenance", () => {
    const provenance = structuredClone(transportProvenance());
    const xai = provenance.cells.find((cell) =>
      cell.provider === "xai" && cell.arm === "native")!;
    (xai as { qualification_scope: string }).qualification_scope =
      "retained_gate_b_exact_transport";
    expect(() =>
      createLc4DevPublicResultArtifact(verifiedEvidence(), provenance))
      .toThrow(/transport provenance is incomplete/u);

    const mismatchedIdentity = structuredClone(transportProvenance());
    const geminiHacc = mismatchedIdentity.cells.find((cell) =>
      cell.provider === "gemini" && cell.arm === "hacc")!;
    (geminiHacc as { model_identity_verification: string })
      .model_identity_verification = "provider_verified";
    expect(() =>
      createLc4DevPublicResultArtifact(verifiedEvidence(), mismatchedIdentity))
      .toThrow(/transport provenance is incomplete/u);

    const substitutedGateB = structuredClone(transportProvenance());
    substitutedGateB.cells
      .filter((cell) => cell.provider === "openai")
      .forEach((cell) => {
        (cell as { qualification_receipt_sha256: string })
          .qualification_receipt_sha256 = H("substitute-openai-gate-b");
      });
    substitutedGateB.cells
      .filter((cell) => cell.provider === "gemini")
      .forEach((cell) => {
        (cell as { qualification_receipt_sha256: string })
          .qualification_receipt_sha256 = H("substitute-gemini-gate-b");
      });
    expect(() =>
      createLc4DevPublicResultArtifact(verifiedEvidence(), substitutedGateB))
      .toThrow(/transport provenance is incomplete/u);
  });

  it("refuses publication provenance before scoring when the exact Gate D receipt is absent", async () => {
    const gateDReceipt = H("bound-gate-d-receipt");
    await expect(verifyLc4PublicationTransportProvenance({
      prepare: {
        source_commit: "a".repeat(40),
        source_tree_sha256: H("source-tree"),
        provider_profile_manifest_sha256:
          LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
        qualification_transport_scope_sha256:
          LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
        qualification_claim_boundary:
          "retained_gate_b_transports_only_xai_finite_manual_not_qualified",
        xai_finite_manual_transport_qualification:
          "receipt_bound_pending_preflight_replay",
        xai_finite_manual_gate_d: {
          receipt_sha256: gateDReceipt,
          plan_authority_trust_root_sha256: H("gate-d-trust"),
          transport_profile_sha256:
            LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256,
        },
        audio_delivery_profile_sha256: H("audio-delivery"),
      } as never,
      preflight: {
        authority_trust_root_sha256: H("listener-authority-root"),
        provider_profile_manifest_sha256:
          LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
        qualification_transport_scope_sha256:
          LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
        qualification_claim_boundary:
          "retained_gate_b_transports_only_xai_finite_manual_not_qualified",
        qualification_scope_verified: true,
        all_episode_transports_qualified: true,
        xai_finite_manual_transport_qualification: "verified",
        xai_finite_manual_gate_d_receipt_sha256: gateDReceipt,
        xai_finite_manual_gate_d_transport_profile_sha256:
          LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256,
        xai_finite_manual_gate_d_claim_boundary:
          "transport_qualification_only_not_efficacy_evidence",
      } as never,
      run_sha256: H("run"),
      authority_trust_root_sha256: H("listener-authority-root"),
      transport_replay: transportReplay(),
      gate_d: {
        receipt_path: "/definitely/missing/hacc-gate-d-receipt.json",
        invocation_marker_path:
          "/definitely/missing/hacc-gate-d-invocation.json",
        plan_trust_root_sha256: H("gate-d-trust"),
      },
    })).rejects.toThrow(/Gate D receipt must be one bounded regular, non-linked file/u);
  });

  it("derives bounded model identity status from retained provider acknowledgement evidence", () => {
    const modelProof = (status: "verified" | "unverifiable") => ({
      fields: { model: { status } },
    });
    const result = deriveLc4PublicationModelIdentityVerification([
      {
        provider: "openai",
        model: LC4_PROVIDER_PROFILE_MANIFEST.providers.openai.model,
        status: "passed",
        code: "configuration_echo_verified",
      },
      {
        provider: "gemini",
        model: LC4_PROVIDER_PROFILE_MANIFEST.providers.gemini.model,
        status: "passed",
        code: "setup_accepted_without_field_echo",
        configurationEvidence: modelProof("unverifiable"),
      },
      {
        provider: "xai",
        model: LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.model,
        status: "passed",
        code: "configuration_accepted_partial_echo",
        configurationEvidence: modelProof("verified"),
      },
    ] as never);
    expect(result).toEqual({
      openai: "provider_verified",
      gemini: "request_only",
      xai: "provider_verified",
    });
    expect(() => deriveLc4PublicationModelIdentityVerification([
      {
        provider: "openai",
        model: "different-model",
        status: "passed",
        code: "configuration_echo_verified",
      },
      {
        provider: "gemini",
        model: LC4_PROVIDER_PROFILE_MANIFEST.providers.gemini.model,
        status: "passed",
        code: "setup_accepted_without_field_echo",
      },
      {
        provider: "xai",
        model: LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.model,
        status: "passed",
        code: "configuration_accepted_partial_echo",
        configurationEvidence: modelProof("verified"),
      },
    ] as never)).toThrow(/openai model identity differs/u);
  });
});

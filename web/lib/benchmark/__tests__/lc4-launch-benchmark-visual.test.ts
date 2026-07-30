import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import type { Lc4AuthorityObligationResult } from "../lc4-authoritative-obligation-evidence";
import {
  createLc4LaunchBenchmarkVisualBuffers,
  LC4_LAUNCH_BENCHMARK_VISUAL_FILENAMES,
  publishLc4LaunchBenchmarkVisual,
  renderLc4LaunchBenchmarkSvg,
  unsafePublishLc4LaunchBenchmarkVisualForTestsOnly,
} from "../lc4-launch-benchmark-visual";
import { runLc4LaunchBenchmarkVisualCli } from "../lc4-launch-benchmark-visual-cli";
import {
  scoreLc4LaunchBenchmark,
  type Lc4LaunchBenchmarkEpisodeInput,
  type Lc4LaunchBenchmarkScoringInput,
} from "../lc4-launch-benchmark";
import { LC4_DEV_LISTENER_SEMANTIC_BUNDLE } from "../lc4-development-listener-semantics";
import { lc4DevCallerBranchSemanticSubjectId } from "../lc4-development-caller-branch";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";
import { LC4_PROVIDER_PROFILE_MANIFEST } from "../lc4-provider-profiles";
import {
  createLc4PublicationTransportProvenance,
} from "../lc4-publication-transport-provenance";
import {
  createLc4PublicationTransportReplay,
} from "../lc4-publication-transport-replay";
import {
  createLc4ProviderExecutionProfile,
} from "../lc4-production-runner-foundation";

const roots: string[] = [];
const H = (value: string) => sha256Hex(value);
const corpus = createLc4PublicDevelopmentCorpus();

function transportReplay() {
  return createLc4PublicationTransportReplay({
    run_sha256: H("run"),
    provider_profile_manifest_sha256:
      LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    audio_delivery_profile_sha256: H("audio-delivery"),
    listener_authority_trust_root_sha256:
      H("listener-authority-trust-root"),
    canonical_provider_exchange_count: 360,
    repair_provider_exchange_count: 0,
    total_response_generation_count: 360,
    episodes: (["openai", "gemini", "xai"] as const).flatMap((provider) => {
      const profile = createLc4ProviderExecutionProfile(provider);
      return (["native", "hacc"] as const).map((arm) => ({
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
        provider_session_count: 6 as const,
        provider_session_replay_set_sha256:
          H(`${provider}-${arm}-provider-session-replay-set`),
        repair_provider_exchange_count: 0,
        total_response_generation_count: 60,
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function authorityResults(): readonly Lc4AuthorityObligationResult[] {
  return Object.freeze(Array.from({ length: 42 }, (_, index) => Object.freeze({
    obligation_id: `authority.tool_outcome_exact.visual-${String(index).padStart(2, "0")}`,
    pass: true,
    observed_count: 1,
    reason: null,
  })));
}

function episode(
  provider: "openai" | "gemini" | "xai",
  arm: "native" | "hacc",
): Lc4LaunchBenchmarkEpisodeInput {
  return Object.freeze({
    episode_id: `${provider}-${arm}`,
    pair_id: provider,
    provider,
    arm,
    model: LC4_PROVIDER_PROFILE_MANIFEST.providers[provider].model,
    opened: true,
    completed: true,
    repair_playbacks: 0,
    total_response_generations: 60,
    observations: Object.freeze(corpus.opportunities.map((opportunity) => {
      const branchOutcome = opportunity.id === "lc4-dev-op-42"
        ? "no_call" as const
        : null;
      const semanticSubjectId = branchOutcome === null
        ? opportunity.id
        : lc4DevCallerBranchSemanticSubjectId(branchOutcome);
      const plan = LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities.find(
        (candidate) => candidate.opportunity_id === semanticSubjectId,
      )!;
      const applicable = plan.applicability.status === "applicable";
      const semantic = Object.freeze({
        semantic_subject_id: semanticSubjectId,
        branch_outcome: branchOutcome,
        response_lineage: Object.freeze({
          provider_exchange_sha256:
            H(`${provider}:${arm}:${opportunity.id}:exchange`),
          listener_evidence_sha256:
            H(`${provider}:${arm}:${opportunity.id}:listener`),
          assistant_pcm_sha256:
            H(`${provider}:${arm}:${opportunity.id}:assistant-pcm`),
        }),
        transcript: "Retained model-visible speech.",
        semantic_applicability:
          applicable ? "applicable" as const : "not_applicable" as const,
        final_required_criteria_pass: applicable ? arm === "hacc" : null,
        semantic_replay_sha256:
          H(`${provider}:${arm}:${opportunity.id}:semantic`),
      });
      return Object.freeze({
        opportunity_id: opportunity.id,
        repair_played: false,
        first_response: semantic,
        repair_assisted: semantic,
      });
    })),
    authority: Object.freeze({
      scoreability: "scorable" as const,
      verdict: "pass" as const,
      obligation_results: authorityResults(),
      critical_external_effect_breach: false,
      replay_sha256: H(`${provider}:${arm}:authority`),
    }),
  });
}

function artifact() {
  const input: Lc4LaunchBenchmarkScoringInput = Object.freeze({
    execution_id: "visual-test",
    source_commit: "a".repeat(40),
    source_tree_sha256: H("tree"),
    run_sha256: H("run"),
    report_sha256: H("report"),
    evidence: Object.freeze({
      prepare_sha256: H("prepare"),
      preflight_sha256: H("preflight"),
      run_ledger_head_sha256: H("run-ledger-head"),
      run_package_sha256: H("run-package"),
      budget_lease_sha256: H("budget-lease"),
      budget_evidence_sha256: H("budget-evidence"),
      budget_terminal_ledger_head_sha256: H("budget-terminal-head"),
      budget_ledger_public_key_fingerprint_sha256: H("budget-public-key"),
      authority_replay_set_sha256: H("authority-replay-set"),
    }),
    budget: Object.freeze({
      maximum_total_micro_usd: 15_000_000,
      conservative_settled_micro_usd: 12_000_000,
      active_reservations_micro_usd: 0 as const,
      reservations_terminal: true as const,
      reservation_count: 6 as const,
      budget_replay_verified: true as const,
    }),
    transport_provenance: createLc4PublicationTransportProvenance({
      retained_gate_b_receipt_sha256: H("visual-gate-b"),
      xai_finite_manual_gate_d_receipt_sha256: H("visual-gate-d"),
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
    }),
    episodes: Object.freeze((["openai", "gemini", "xai"] as const).flatMap((provider) =>
      (["native", "hacc"] as const).map((arm) => episode(provider, arm)))),
  });
  return scoreLc4LaunchBenchmark(input);
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "hacc-lc4-visual-"));
  roots.push(root);
  return root;
}

describe("LC4 launch benchmark visual", () => {
  it("renders only exact recall counts and strict outcomes from the complete launch artifact", () => {
    const svg = renderLc4LaunchBenchmarkSvg(artifact());
    expect(svg).toContain("Long-call recall");
    expect(svg).toContain("Long-call recall: Registered Native comparator versus HACC");
    expect(svg).toContain("Registered recall probes · 1 call per arm");
    expect(svg).toContain("360 repeated opportunities within 6 calls · not 360 independent trials");
    expect(svg).toContain("Native realtime API + common benchmark continuity");
    expect(svg).toContain("one development pair per provider");
    expect(svg).toContain(">Registered Native</text>");
    expect(svg).toContain("Registered Native 0/1");
    expect(svg).toContain("HACC 0/1");
    expect(svg).not.toMatch(/>Native(?: API)?<\/text>/u);
    expect(svg).not.toContain("ChatGPT Voice");
    expect(svg.match(/class="value"/gu)).toHaveLength(6);
    expect(svg).not.toMatch(/Verified results|1000 (?:voice|registered|interactions)|guardrail|authoritative actions/iu);
  });

  it("produces deterministic 1600×1000 SVG, PNG, and WebP buffers", async () => {
    const result = await createLc4LaunchBenchmarkVisualBuffers(artifact());
    const repeated = await createLc4LaunchBenchmarkVisualBuffers(artifact());
    expect(result).toEqual(repeated);
    const [png, webp] = await Promise.all([
      sharp(result.png).metadata(),
      sharp(result.webp).metadata(),
    ]);
    expect(png).toMatchObject({ format: "png", width: 1600, height: 1000 });
    expect(webp).toMatchObject({ format: "webp", width: 1600, height: 1000 });
  });

  it("publishes an immutable three-file asset set and refuses overwrite", async () => {
    const root = await tempRoot();
    const json = resolve(root, "HACC_LC4_LAUNCH_BENCHMARK.json");
    const output = resolve(root, "visual");
    const source = artifact();
    await writeFile(json, `${canonicalJson(source)}\n`, { mode: 0o444 });
    const published = await unsafePublishLc4LaunchBenchmarkVisualForTestsOnly({
      artifact: source,
      output_root: output,
    });
    expect(published.benchmark_sha256).toBe(source.benchmark_sha256);
    for (const filename of Object.values(LC4_LAUNCH_BENCHMARK_VISUAL_FILENAMES)) {
      const metadata = await stat(resolve(output, filename));
      expect(metadata.isFile()).toBe(true);
      expect(metadata.mode & 0o777).toBe(0o444);
    }
    expect(await readFile(resolve(output, LC4_LAUNCH_BENCHMARK_VISUAL_FILENAMES.svg), "utf8"))
      .toContain(source.benchmark_sha256);
    await expect(unsafePublishLc4LaunchBenchmarkVisualForTestsOnly({
      artifact: source,
      output_root: output,
    })).rejects.toThrow(/overwrite is forbidden/u);
  });

  it("leaves one complete asset set when concurrent publishers race", async () => {
    const root = await tempRoot();
    const json = resolve(root, "HACC_LC4_LAUNCH_BENCHMARK.json");
    const output = resolve(root, "visual");
    const source = artifact();
    await writeFile(json, `${canonicalJson(source)}\n`, { mode: 0o444 });
    const attempts = await Promise.allSettled([
      unsafePublishLc4LaunchBenchmarkVisualForTestsOnly({ artifact: source, output_root: output }),
      unsafePublishLc4LaunchBenchmarkVisualForTestsOnly({ artifact: source, output_root: output }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect((await readdir(output)).sort()).toEqual(
      Object.values(LC4_LAUNCH_BENCHMARK_VISUAL_FILENAMES).sort(),
    );
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects a direct caller-built visual JSON bypass before rendering", async () => {
    const root = await tempRoot();
    const publicJson = resolve(root, "synthetic.json");
    const publicMarkdown = resolve(root, "synthetic.md");
    const output = resolve(root, "visual");
    const synthetic = artifact();
    await writeFile(publicJson, `${canonicalJson(synthetic)}\n`, { mode: 0o444 });
    await writeFile(publicMarkdown, "synthetic\n", { mode: 0o444 });

    // The old JSON-only surface is intentionally unusable even when the
    // caller has constructed an internally self-consistent six-cell artifact.
    await expect(publishLc4LaunchBenchmarkVisual({
      public_json: publicJson,
      output_root: output,
    } as never)).rejects.toThrow(/evidence root/u);
    await expect(publishLc4LaunchBenchmarkVisual({
      evidence_root: resolve(root, "missing-evidence-root"),
      public_json: publicJson,
      public_markdown: publicMarkdown,
      output_root: output,
      authority_trust_root_sha256: H("listener-authority-trust-root"),
      xai_finite_manual_gate_d: {
        receipt_path: resolve(root, "missing-gate-d-receipt.json"),
        invocation_marker_path: resolve(root, "missing-gate-d-marker.json"),
        plan_trust_root_sha256: H("gate-d-trust-root"),
      },
    })).rejects.toThrow();
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed before writing when the renderer test artifact is incomplete or tampered", async () => {
    const root = await tempRoot();
    const output = resolve(root, "visual");
    const tampered = structuredClone(artifact());
    (tampered.cells as Array<(typeof tampered.cells)[number]>).pop();
    await expect(unsafePublishLc4LaunchBenchmarkVisualForTestsOnly({
      artifact: tampered,
      output_root: output,
    })).rejects.toThrow(/hash mismatch|complete six-episode/u);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a renderer test artifact whose xAI cell is not bound to Gate D", async () => {
    const root = await tempRoot();
    const output = resolve(root, "visual");
    const tampered = structuredClone(artifact());
    const xai = tampered.cells.find((cell) =>
      cell.provider === "xai" && cell.arm === "hacc")!;
    (xai as { qualification_scope: string }).qualification_scope =
      "retained_gate_b_exact_transport";
    await expect(unsafePublishLc4LaunchBenchmarkVisualForTestsOnly({
      artifact: tampered,
      output_root: output,
    })).rejects.toThrow(/hash mismatch|transport provenance/u);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the visual CLI provider-free and rejects broad or malformed inputs", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    await expect(runLc4LaunchBenchmarkVisualCli(
      ["publish", "--public-json", "/tmp/result.json"],
      { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
    )).resolves.toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "LC4 launch benchmark visual CLI requires exactly: --authority-trust-root-sha256, --evidence-root, --gate-d-invocation-marker, --gate-d-receipt, --gate-d-trust-root-sha256, --output-root, --public-json, --public-markdown",
    ]);
  });

  it("keeps the artifact-only visual writer unavailable outside tests", async () => {
    const mutableEnv = process.env as Record<string, string | undefined>;
    const previous = mutableEnv.NODE_ENV;
    mutableEnv.NODE_ENV = "production";
    try {
      await expect(unsafePublishLc4LaunchBenchmarkVisualForTestsOnly({
        artifact: {} as never,
        output_root: "/tmp/hacc-lc4-unsafe-visual",
      })).rejects.toThrow(/test-only/u);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(mutableEnv, "NODE_ENV");
      else mutableEnv.NODE_ENV = previous;
    }
  });
});

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  assertLc4DevPublicResultArtifact,
  createLc4DevPublicResultArtifact,
  renderLc4DevPublicResultMarkdown,
} from "../lc4-development-public-results";
import { runLc4DevPublicResultCli } from "../lc4-development-public-results-cli";

const H = (value: string) => sha256Hex(value);

function verifiedEvidence(): Parameters<typeof createLc4DevPublicResultArtifact>[0] {
  const episodes = (["openai", "gemini", "xai"] as const).flatMap((provider, providerIndex) => (["native", "hacc"] as const).map((arm, armIndex) => ({
    episode_id: `${provider}-${arm}`,
    pair_id: provider,
    pair_position: armIndex,
    provider,
    arm,
    model: [`gpt-realtime`, `gemini-live`, `grok-voice`][providerIndex]!,
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
  } as unknown as Parameters<typeof createLc4DevPublicResultArtifact>[0];
}

describe("LC4-DEV public results", () => {
  it("builds one deterministic C3 mechanism artifact without private evidence fields", () => {
    const first = createLc4DevPublicResultArtifact(verifiedEvidence());
    const second = createLc4DevPublicResultArtifact(verifiedEvidence());
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first).toMatchObject({
      evidence_class: "C3",
      study_role: "development_mechanism_evidence_only",
      efficacy_claim_eligible: false,
      confirmatory_reuse_permitted: false,
      execution: { episodes_completed: 6, opportunities_completed: 360, paid_retry_count: 0 },
      evaluation: { authority_passed: 5, authority_evaluated: 6, task_results_available: true },
      privacy: {
        contains_transcripts: false,
        contains_pcm_or_audio: false,
        contains_wire_payloads: false,
        contains_local_paths: false,
        contains_credential_or_key_identities: false,
      },
    });
    expect(canonicalJson(first)).not.toMatch(/excluded-from-public-artifact|credential_identity_set_sha256|fingerprint_sha256|signature_base64|ledger_path|pcm_sha256/u);
    expect(() => assertLc4DevPublicResultArtifact(first)).not.toThrow();
  });

  it("renders a minimal deterministic receipt with explicit claim limits", () => {
    const result = createLc4DevPublicResultArtifact(verifiedEvidence());
    const markdown = renderLc4DevPublicResultMarkdown(result);
    expect(markdown).toContain("C3 mechanism evidence only");
    expect(markdown).toContain("| Authority passed | 5 |");
    expect(markdown).toContain("| Conservative ledger liability | $12.345678 |");
    expect(markdown).not.toContain("settled cost");
    expect(markdown).toContain("| openai | gpt-realtime | Native + HACC | 60 each |");
    expect(markdown).toContain("does not authorize a Native-versus-HACC superiority claim");
    expect(markdown).not.toContain("excluded-from-public-artifact");
  });

  it("fails closed on hash, pair, unsafe model, and CLI surface drift", async () => {
    const valid = createLc4DevPublicResultArtifact(verifiedEvidence());
    expect(() => assertLc4DevPublicResultArtifact({ ...valid, evidence_class: "C4" } as never)).toThrow(/hash mismatch/);

    const missingPair = structuredClone(verifiedEvidence());
    (missingPair.prepare.episodes as unknown[]).pop();
    expect(() => createLc4DevPublicResultArtifact(missingPair)).toThrow(/public pair is incomplete/);

    const unsafe = structuredClone(verifiedEvidence());
    (unsafe.prepare.episodes[0] as { model: string }).model = "/private/tmp/model";
    (unsafe.prepare.episodes[1] as { model: string }).model = "/private/tmp/model";
    expect(() => createLc4DevPublicResultArtifact(unsafe)).toThrow(/model identifier is unsafe/);

    const stdout: string[] = [];
    const stderr: string[] = [];
    await expect(runLc4DevPublicResultCli(
      ["publish", "--evidence-root", "/tmp/evidence"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    )).resolves.toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["LC4-DEV public result CLI requires exactly: --evidence-root, --output-root"]);
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
    expect(() => createLc4DevPublicResultArtifact(fixture)).toThrow(/refuses to publish a C3 headline result/);
  });
});

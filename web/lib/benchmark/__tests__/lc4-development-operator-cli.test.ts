import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  assertLc4DevOperatorAuthorizationDag,
  createLc4DevOperatorAuthorizationDag,
  lc4DevOperatorAuthorizationBindingSha256,
  loadLc4DevExplicitCredentials,
  runLc4DevelopmentOperatorCli,
  type Lc4DevOperatorSigner,
} from "../lc4-development-operator-cli";
import type {
  Lc4DevLivePreflightArtifact,
  Lc4DevLivePrepareArtifact,
  Lc4DevLiveRunArtifact,
  Lc4DevRetainedQualificationReceipt,
} from "../lc4-development-live-runner";

const roots: string[] = [];
const HASH = "a".repeat(64);
const RUN_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-run/v1\n";

function reportRun(completed = true): Lc4DevLiveRunArtifact {
  const body = {
    schema_version: 1 as const,
    execution_id: "lc4-dev-operator-test",
    prepare_sha256: "1".repeat(64),
    preflight_sha256: "2".repeat(64),
    started_at: "2026-07-22T06:00:00.000Z",
    completed_at: "2026-07-22T06:10:00.000Z",
    status: completed ? "completed" as const : "failed" as const,
    episodes_started: completed ? 6 : 3,
    episodes_completed: completed ? 6 : 2,
    opportunities_submitted: completed ? 360 : 120,
    opportunities_completed: completed ? 360 : 119,
    provider_calls_made: completed ? 360 : 120,
    repair_playbacks: 0,
    total_response_generations: completed ? 360 : 120,
    paid_retry_count: 0 as const,
    maximum_total_micro_usd: 15_000_000,
    retained_caller_audio: completed ? 360 : 120,
    retained_assistant_audio: completed ? 360 : 119,
    listener_evidence_count: completed ? 360 : 119,
    mechanism_receipt_count: completed ? 360 : 120,
    episode_finalization_count: completed ? 6 : 2,
    replay_evidence_reference_count: completed ? 1_000 : 300,
    failure_class: completed ? null : "evidence" as const,
    failure_message_sha256: completed ? null : sha256Hex("incomplete"),
    ledger: Object.freeze([]),
    ledger_head_sha256: null,
  };
  return Object.freeze({ ...body, run_sha256: sha256Hex(`${RUN_DOMAIN}${canonicalJson(body)}`) });
}

type AuthorityReport = Readonly<{
  status: "scorable" | "unscorable_missing_authority_evidence" | "unscorable_invalid_authority_evidence";
  passed: number | null;
  evaluated: number | null;
  evidence_invalid: number;
  episode_replay_sha256s: readonly string[];
  errors: readonly string[];
}>;

async function runReportCase(run: Lc4DevLiveRunArtifact, authority: AuthorityReport) {
  const root = await mkdtemp(join(tmpdir(), "lc4-dev-report-cli-"));
  roots.push(root);
  const custody = fixtures();
  const dag = createLc4DevOperatorAuthorizationDag(custody.input);
  const preflight = {
    execution_id: custody.prepare.execution_id,
    prepare_sha256: custody.prepare.prepare_sha256,
    preflight_sha256: "2".repeat(64),
    immutable_ledger_genesis_sha256: dag.immutable_ledger_genesis_sha256,
    authority_trust_root_sha256: custody.authority.public_key_fingerprint_sha256,
    authorization: dag.authorization,
  } as Lc4DevLivePreflightArtifact;
  await Promise.all([
    writeFile(join(root, "prepare.json"), `${canonicalJson(custody.prepare)}\n`, { mode: 0o400 }),
    writeFile(join(root, "run.json"), `${canonicalJson(run)}\n`, { mode: 0o400 }),
    writeFile(join(root, "preflight.json"), `${canonicalJson(preflight)}\n`, { mode: 0o400 }),
  ]);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: unknown[] = [];
  const code = await runLc4DevelopmentOperatorCli(
    ["report", "--evidence-root", root],
    { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value), now: () => new Date("2026-07-22T06:20:00.000Z") },
    {
      async inspect_source() { throw new Error("report must not inspect source or call providers"); },
      async replay_authority_report(value) { calls.push(value); return authority; },
    },
  );
  return {
    code,
    stdout,
    stderr,
    calls,
    report: JSON.parse(await readFile(join(root, "report.json"), "utf8")) as Record<string, unknown>,
  };
}

function signer(): Lc4DevOperatorSigner {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  return Object.freeze({
    private_key: pair.privateKey,
    public_key_spki_der: der,
    public_key_spki_pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    private_key_pkcs8_pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    public_key_fingerprint_sha256: sha256Hex(der),
  });
}

function fixtures() {
  const prepare = {
    execution_id: "lc4-dev-operator-test",
    prepare_sha256: "1".repeat(64),
    maximum_total_micro_usd: 15_000_000,
    audio_manifest_sha256: "2".repeat(64),
  } as Lc4DevLivePrepareArtifact;
  const qualification = {
    terminal_root_sha256: "3".repeat(64),
    retained_artifact_sha256: "4".repeat(64),
  } as Lc4DevRetainedQualificationReceipt;
  const authority = signer();
  const runtimeRoots = {
    control_plane_manifest_sha256: "5".repeat(64),
    listener_evidence_manifest_sha256: "6".repeat(64),
  };
  const input = {
    prepare,
    qualification,
    credential_identity_set_sha256: "7".repeat(64),
    roots: runtimeRoots,
    signer: authority,
    authorization_nonce_sha256: "8".repeat(64),
    not_before: "2026-07-22T06:00:00.000Z",
    expires_at: "2026-07-22T06:30:00.000Z",
  };
  return { prepare, qualification, authority, runtimeRoots, input };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("LC4-DEV operator custody", () => {
  it("builds an acyclic authorization -> ledger genesis -> signed authorization DAG", () => {
    const { input, authority } = fixtures();
    const dag = createLc4DevOperatorAuthorizationDag(input);
    const { immutable_ledger_genesis_sha256: _excluded, ...unsignedWithoutGenesis } = dag.authorization.body;
    void _excluded;
    expect(dag.authorization_binding_sha256).toBe(lc4DevOperatorAuthorizationBindingSha256(unsignedWithoutGenesis));
    expect(dag.immutable_ledger_genesis_sha256).toBe(dag.authorization.body.immutable_ledger_genesis_sha256);
    expect(dag.authorization.artifact_sha256).toMatch(/^[a-f0-9]{64}$/u);

    const preflight = {
      execution_id: input.prepare.execution_id,
      prepare_sha256: input.prepare.prepare_sha256,
      immutable_ledger_genesis_sha256: dag.immutable_ledger_genesis_sha256,
      authority_trust_root_sha256: authority.public_key_fingerprint_sha256,
      authorization: dag.authorization,
    } as Lc4DevLivePreflightArtifact;
    expect(assertLc4DevOperatorAuthorizationDag({
      preflight,
      expected_authority_public_key_fingerprint_sha256: authority.public_key_fingerprint_sha256,
    })).toBe(dag.authorization_binding_sha256);
  });

  it("binds every custody edge and rejects a caller-supplied genesis or substituted preflight before execution", () => {
    const { input, authority } = fixtures();
    const baseline = createLc4DevOperatorAuthorizationDag(input);
    const mutations = [
      { ...input, credential_identity_set_sha256: "9".repeat(64) },
      { ...input, roots: { ...input.roots, control_plane_manifest_sha256: "b".repeat(64) } },
      { ...input, roots: { ...input.roots, listener_evidence_manifest_sha256: "c".repeat(64) } },
      { ...input, authorization_nonce_sha256: "d".repeat(64) },
      { ...input, expires_at: "2026-07-22T06:31:00.000Z" },
    ];
    for (const mutation of mutations) {
      const changed = createLc4DevOperatorAuthorizationDag(mutation);
      expect(changed.authorization_binding_sha256).not.toBe(baseline.authorization_binding_sha256);
      expect(changed.immutable_ledger_genesis_sha256).not.toBe(baseline.immutable_ledger_genesis_sha256);
    }

    const substituted = {
      execution_id: input.prepare.execution_id,
      prepare_sha256: input.prepare.prepare_sha256,
      immutable_ledger_genesis_sha256: HASH,
      authority_trust_root_sha256: authority.public_key_fingerprint_sha256,
      authorization: {
        ...baseline.authorization,
        body: { ...baseline.authorization.body, immutable_ledger_genesis_sha256: HASH },
      },
    } as Lc4DevLivePreflightArtifact;
    expect(() => assertLc4DevOperatorAuthorizationDag({
      preflight: substituted,
      expected_authority_public_key_fingerprint_sha256: authority.public_key_fingerprint_sha256,
    })).toThrow("authorization binding DAG or ledger genesis is invalid");
  });

  it("loads credentials only from two explicit files with deterministic repository-file precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-operator-env-"));
    roots.push(root);
    const provider = join(root, "provider.env");
    const repository = join(root, "repo.env");
    await writeFile(provider, "OPENAI_API_KEY=openai-test-secret\nGEMINI_API_KEY=gemini-test-secret\n", { mode: 0o600 });
    await writeFile(repository, "XAI_API_KEY=xai-test-secret-value\n", { mode: 0o600 });
    const credentials = await loadLc4DevExplicitCredentials({ provider_env_file: provider, repository_env_file: repository });
    expect(Object.keys(credentials)).toEqual(["openai", "gemini", "xai"]);
    expect(JSON.stringify(Object.keys(credentials))).not.toContain("secret");

    await chmod(repository, 0o600);
    await writeFile(repository, "OPENAI_API_KEY=different-openai-secret\nXAI_API_KEY=xai-test-secret-value\n");
    const overridden = await loadLc4DevExplicitCredentials({ provider_env_file: provider, repository_env_file: repository });
    expect(overridden.openai).toBe("different-openai-secret");
  });

  it("publishes a complete six-episode authority replay separately from execution counters", async () => {
    const replayHashes = Object.freeze(Array.from({ length: 6 }, (_, index) => sha256Hex(`cli-authority-${index}`)));
    const result = await runReportCase(reportRun(), {
      status: "scorable",
      passed: 6,
      evaluated: 6,
      evidence_invalid: 0,
      episode_replay_sha256s: replayHashes,
      errors: Object.freeze([]),
    });
    expect(result).toMatchObject({ code: 0, stderr: [], calls: [expect.any(Object)] });
    expect(result.report).toMatchObject({
      completed: true,
      execution_evidence_complete: true,
      authority_scoreability: "scorable",
      authority_passed: 6,
      authority_evaluated: 6,
      task_results_available: true,
      evidence_complete: true,
      efficacy_claim_eligible: false,
    });
    expect(JSON.parse(result.stdout[0]!)).toEqual(result.report);
  });

  it("writes a null-denominator report and returns 2 when an authority CAS object is missing", async () => {
    const result = await runReportCase(reportRun(), {
      status: "unscorable_missing_authority_evidence",
      passed: null,
      evaluated: null,
      evidence_invalid: 1,
      episode_replay_sha256s: Object.freeze([]),
      errors: Object.freeze(["ENOENT: authority artifact missing"]),
    });
    expect(result.code).toBe(2);
    expect(result.report).toMatchObject({
      completed: true,
      execution_evidence_complete: true,
      authority_scoreability: "unscorable_missing_authority_evidence",
      authority_passed: null,
      authority_evaluated: null,
      task_results_available: false,
      evidence_complete: false,
    });
  });

  it("writes a null-denominator report and returns 2 when an authority CAS object is tampered", async () => {
    const result = await runReportCase(reportRun(), {
      status: "unscorable_invalid_authority_evidence",
      passed: null,
      evaluated: null,
      evidence_invalid: 1,
      episode_replay_sha256s: Object.freeze([]),
      errors: Object.freeze(["authority artifact hash mismatch"]),
    });
    expect(result.code).toBe(2);
    expect(result.report).toMatchObject({
      execution_evidence_complete: true,
      authority_scoreability: "unscorable_invalid_authority_evidence",
      authority_passed: null,
      authority_evaluated: null,
      task_results_available: false,
      efficacy_claim_eligible: false,
    });
  });

  it("never publishes a denominator for an incomplete execution, even with six replay objects", async () => {
    const result = await runReportCase(reportRun(false), {
      status: "scorable",
      passed: 5,
      evaluated: 6,
      evidence_invalid: 0,
      episode_replay_sha256s: Object.freeze(Array.from({ length: 6 }, (_, index) => sha256Hex(`incomplete-authority-${index}`))),
      errors: Object.freeze([]),
    });
    expect(result.code).toBe(2);
    expect(result.report).toMatchObject({
      completed: false,
      exact_six_episode_horizon: false,
      execution_evidence_complete: false,
      authority_scoreability: "scorable",
      authority_passed: null,
      authority_evaluated: null,
      task_results_available: false,
      evidence_complete: false,
    });
    expect(result.report).not.toMatchObject({ authority_passed: 0, authority_evaluated: 5 });
  });
});

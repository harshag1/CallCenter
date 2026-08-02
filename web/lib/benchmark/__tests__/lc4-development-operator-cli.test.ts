import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  assertLc4DevOperatorAuthorizationDag,
  closeLc4DevTerminalRunCustody,
  createLc4DevOperatorAuthorizationDag,
  lc4DevOperatorAuthorizationBindingSha256,
  loadLc4DevRetainedQualification,
  loadLc4DevExplicitCredentials,
  runLc4DevelopmentOperatorCli,
  writeImmutableJsonPair,
  type Lc4DevOperatorSigner,
} from "../lc4-development-operator-cli";
import type {
  Lc4DevLivePreflightArtifact,
  Lc4DevLivePrepareArtifact,
  Lc4DevLiveRunArtifact,
  Lc4DevRetainedQualificationReceipt,
} from "../lc4-development-live-runner";
import {
  createLc4DevRunPackage,
  type Lc4DevBudgetEvidence,
  type Lc4DevRunLease,
} from "../lc4-development-budget";
import {
  LC4_TEST_ASR_CONTRACT,
  LC4_TEST_ASR_CONTRACT_SHA256,
  createLc4TestAsrRunnerTrust,
} from "./lc4-test-asr-authority";

const roots: string[] = [];
const HASH = "a".repeat(64);
const RUN_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-run/v3\n";

function reportRun(completed = true): Lc4DevLiveRunArtifact {
  const providerSegmentLedger = completed
    ? Object.freeze(Array.from({ length: 36 }, (_, index) => {
        const segmentOrdinal = index % 6 + 1;
        const episodeOrdinal = Math.floor(index / 6) + 1;
        const common = {
          episode_id: `lc4-dev-episode-${episodeOrdinal}`,
          opportunity_id: null,
          payload_sha256: sha256Hex(`segment-payload-${index + 1}`),
          payload_evidence: {
            schema_version: 1 as const,
            retention_version: "lc4-dev-replay-evidence-v1" as const,
            kind: "ledger_payload" as const,
            evidence_sha256: sha256Hex(`segment-payload-${index + 1}`),
            byte_length: 1,
            content_encoding: "domain-prefixed-canonical-json" as const,
            domain_prefix:
              "harshas-amazing-call-center/lc4-dev-live-ledger-payload/v1\n",
          },
          evidence_references: Object.freeze([]),
        };
        return [
          Object.freeze({
            sequence: index * 2 + 1,
            observed_at: "2026-07-22T06:00:00.000Z",
            event_type: "segment_open_intent" as const,
            ...common,
            previous_event_sha256: index === 0
              ? null
              : sha256Hex(`segment-event-${index * 2}`),
            event_sha256: sha256Hex(`segment-event-${index * 2 + 1}`),
            segment_ordinal: segmentOrdinal,
          }),
          Object.freeze({
            sequence: index * 2 + 2,
            observed_at: "2026-07-22T06:00:00.001Z",
            event_type: "segment_opened" as const,
            ...common,
            previous_event_sha256: sha256Hex(`segment-event-${index * 2 + 1}`),
            event_sha256: sha256Hex(`segment-event-${index * 2 + 2}`),
            segment_ordinal: segmentOrdinal,
          }),
        ];
      }).flat())
    : Object.freeze([]);
  const body = {
    schema_version: 3 as const,
    execution_id: "lc4-dev-operator-test",
    prepare_sha256: "1".repeat(64),
    preflight_sha256: "2".repeat(64),
    started_at: "2026-07-22T06:00:00.000Z",
    completed_at: "2026-07-22T06:10:00.000Z",
    status: completed ? "completed" as const : "failed" as const,
    episodes_started: completed ? 6 : 3,
    episodes_completed: completed ? 6 : 2,
    provider_segment_intent_count: completed ? 36 : 0,
    provider_segment_opened_count: completed ? 36 : 0,
    opportunities_submitted: completed ? 360 : 120,
    opportunities_completed: completed ? 360 : 119,
    response_generations_requested: completed ? 360 : 120,
    provider_calls_started: completed ? 360 : 120,
    response_generations_completed: completed ? 360 : 119,
    provider_calls_made: completed ? 360 : 120,
    repair_playbacks: 0,
    total_response_generations: completed ? 360 : 119,
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
    ledger: providerSegmentLedger,
    ledger_head_sha256: completed ? providerSegmentLedger.at(-1)!.event_sha256 : null,
  };
  return Object.freeze({ ...body, run_sha256: sha256Hex(`${RUN_DOMAIN}${canonicalJson(body)}`) });
}

function terminalBudgetEvidence(run: Lc4DevLiveRunArtifact): Lc4DevBudgetEvidence {
  return {
    schema_version: 1,
    budget_version: "HACC-LC4-DEV-BUDGET-v3",
    execution_id: run.execution_id,
    lease_sha256: sha256Hex("operator-test-budget-lease"),
    ledger_id: "operator-test-ledger",
    ledger_public_key_fingerprint_sha256: sha256Hex("operator-test-budget-key"),
    terminal_ledger_head_sha256: sha256Hex("operator-test-budget-head"),
    run_sha256: run.run_sha256,
    run_status: run.status,
    reservations: [],
    active_reservations_micro_usd: 0,
    conservative_settled_micro_usd: 0,
    maximum_total_micro_usd: 15_000_000,
    evidence_sha256: sha256Hex("operator-test-budget-evidence"),
  } as unknown as Lc4DevBudgetEvidence;
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
  const budgetLease = {
    execution_id: run.execution_id,
    prepare_sha256: run.prepare_sha256,
    preflight_sha256: run.preflight_sha256,
    lease_sha256: sha256Hex("operator-test-budget-lease"),
  } as Lc4DevRunLease;
  const budgetEvidence = {
    execution_id: run.execution_id,
    lease_sha256: budgetLease.lease_sha256,
    run_sha256: run.run_sha256,
    evidence_sha256: sha256Hex("operator-test-budget-evidence"),
    terminal_ledger_head_sha256: sha256Hex("operator-test-budget-head"),
    ledger_public_key_fingerprint_sha256: sha256Hex("operator-test-budget-key"),
  } as Lc4DevBudgetEvidence;
  const runPackage = createLc4DevRunPackage({
    lease: budgetLease,
    evidence: budgetEvidence,
    run,
    cell_custody: {
      cell_resume_plan_sha256: "1".repeat(64),
      cell_resume_terminal_head_sha256: "2".repeat(64),
      completed_cell_artifact_set_sha256: "3".repeat(64),
      completed_cell_count: run.status === "completed" ? 6 : 0,
      all_cells_completed: run.status === "completed",
      quarantine_present: false,
    },
  });
  await Promise.all([
    writeFile(join(root, "prepare.json"), `${canonicalJson(custody.prepare)}\n`, { mode: 0o400 }),
    writeFile(join(root, "run.json"), `${canonicalJson(run)}\n`, { mode: 0o400 }),
    writeFile(join(root, "preflight.json"), `${canonicalJson(preflight)}\n`, { mode: 0o400 }),
    writeFile(join(root, "budget-run-lease.json"), `${canonicalJson(budgetLease)}\n`, { mode: 0o400 }),
    writeFile(join(root, "budget-terminal-evidence.json"), `${canonicalJson(budgetEvidence)}\n`, { mode: 0o400 }),
    writeFile(join(root, "run-package.json"), `${canonicalJson(runPackage)}\n`, { mode: 0o400 }),
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
      async replay_budget_evidence() {},
      async inspect_cell_custody() { return runPackage.cell_custody; },
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
    provider_profile_manifest_sha256: "a".repeat(64),
    qualification_transport_scope_sha256: "9".repeat(64),
    qualification_claim_boundary: "retained_gate_b_transports_only_xai_finite_manual_not_qualified",
    xai_finite_manual_gate_d: {
      receipt_sha256: sha256Hex("synthetic-gate-d-receipt"),
      plan_authority_trust_root_sha256:
        sha256Hex("synthetic-gate-d-plan-authority"),
      transport_profile_sha256: sha256Hex("synthetic-gate-d-profile"),
    },
    audio_delivery_profile_sha256: "b".repeat(64),
    audio_packetizer_contract_sha256: "c".repeat(64),
    audio_execution_contract_sha256: "d".repeat(64),
  } as Lc4DevLivePrepareArtifact;
  const qualification = {
    terminal_root_sha256: "3".repeat(64),
    retained_artifact_sha256: "4".repeat(64),
  } as Lc4DevRetainedQualificationReceipt;
  const authority = signer();
  const runtimeRoots = {
    control_plane_manifest_sha256: "5".repeat(64),
    listener_evidence_manifest_sha256: "6".repeat(64),
    runtime_config_sha256: "e".repeat(64),
    asr_evaluator_build_sha256: "f".repeat(64),
    asr_evaluator_toolchain_sha256: "0".repeat(64),
    asr_contract: LC4_TEST_ASR_CONTRACT,
    asr_contract_sha256: LC4_TEST_ASR_CONTRACT_SHA256,
    asr_runner_trust: createLc4TestAsrRunnerTrust(
      authority.private_key,
      "lc4-dev-operator-test-asr",
    ),
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
  it("publishes the terminal budget evidence and run package as one private immutable pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-terminal-pair-"));
    roots.push(root);
    const budgetEvidencePath = join(root, "budget-terminal-evidence.json");
    const runPackagePath = join(root, "run-package.json");
    const budgetEvidence = { kind: "budget", digest: sha256Hex("budget") };
    const runPackage = { kind: "package", digest: sha256Hex("package") };

    await writeImmutableJsonPair({
      first_path: budgetEvidencePath,
      first_value: budgetEvidence,
      second_path: runPackagePath,
      second_value: runPackage,
    });

    expect(JSON.parse(await readFile(budgetEvidencePath, "utf8"))).toEqual(budgetEvidence);
    expect(JSON.parse(await readFile(runPackagePath, "utf8"))).toEqual(runPackage);
    for (const path of [budgetEvidencePath, runPackagePath]) {
      const metadata = await stat(path);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.nlink).toBe(1);
      expect(metadata.mode & 0o777).toBe(0o400);
    }
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not create the package or replace the first destination when first-pair publication fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-terminal-pair-first-failure-"));
    roots.push(root);
    const budgetEvidencePath = join(root, "budget-terminal-evidence.json");
    const runPackagePath = join(root, "run-package.json");
    await writeFile(budgetEvidencePath, "pre-existing-budget\n", { mode: 0o400 });

    await expect(writeImmutableJsonPair({
      first_path: budgetEvidencePath,
      first_value: { kind: "new-budget" },
      second_path: runPackagePath,
      second_value: { kind: "new-package" },
    })).rejects.toMatchObject({ code: "EEXIST" });

    expect(await readFile(budgetEvidencePath, "utf8")).toBe("pre-existing-budget\n");
    await expect(readFile(runPackagePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rolls back its provisional budget link and preserves an occupied package destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-terminal-pair-second-failure-"));
    roots.push(root);
    const budgetEvidencePath = join(root, "budget-terminal-evidence.json");
    const runPackagePath = join(root, "run-package.json");
    await writeFile(runPackagePath, "pre-existing-package\n", { mode: 0o400 });

    await expect(writeImmutableJsonPair({
      first_path: budgetEvidencePath,
      first_value: { kind: "new-budget" },
      second_path: runPackagePath,
      second_value: { kind: "new-package" },
    })).rejects.toMatchObject({ code: "EEXIST" });

    await expect(readFile(budgetEvidencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(runPackagePath, "utf8")).toBe("pre-existing-package\n");
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("lets only one concurrent terminal-pair publisher commit a matching pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-terminal-pair-race-"));
    roots.push(root);
    const budgetEvidencePath = join(root, "budget-terminal-evidence.json");
    const runPackagePath = join(root, "run-package.json");
    const pairs = [
      [{ pair: "a", kind: "budget" }, { pair: "a", kind: "package" }],
      [{ pair: "b", kind: "budget" }, { pair: "b", kind: "package" }],
    ] as const;

    const attempts = await Promise.allSettled(pairs.map(([budget, runPackage]) =>
      writeImmutableJsonPair({
        first_path: budgetEvidencePath,
        first_value: budget,
        second_path: runPackagePath,
        second_value: runPackage,
      })));

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const budget = JSON.parse(await readFile(budgetEvidencePath, "utf8")) as { pair: string };
    const runPackage = JSON.parse(await readFile(runPackagePath, "utf8")) as { pair: string };
    expect(runPackage.pair).toBe(budget.pair);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("durably retains a failed terminal run when runtime ledger inspection fails afterward", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-terminal-custody-"));
    roots.push(root);
    const run = reportRun(false);
    const runPath = join(root, "run.json");
    const budgetEvidencePath = join(root, "budget-terminal-evidence.json");
    const runPackagePath = join(root, "run-package.json");
    const calls: string[] = [];

    await expect(closeLc4DevTerminalRunCustody({
      async execute_run() {
        calls.push("execute");
        return run;
      },
      async write_terminal_run(value) {
        calls.push("write-run");
        await writeFile(runPath, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o400 });
      },
      async finalize_runtime() {
        calls.push("inspect-runtime-ledger");
        throw new Error("runtime ledger inspection failed");
      },
      async finalize_budget() {
        calls.push("finalize-budget");
        return terminalBudgetEvidence(run);
      },
      async replay_budget() {
        calls.push("replay-budget");
      },
      create_run_package() {
        calls.push("create-package");
        throw new Error("must not create a package");
      },
      async write_terminal_pair(evidence, runPackage) {
        await Promise.all([
          writeFile(budgetEvidencePath, canonicalJson(evidence), { flag: "wx" }),
          writeFile(runPackagePath, canonicalJson(runPackage), { flag: "wx" }),
        ]);
      },
    })).rejects.toThrow("runtime ledger inspection failed");

    expect(calls).toEqual(["execute", "write-run", "inspect-runtime-ledger"]);
    expect(JSON.parse(await readFile(runPath, "utf8"))).toEqual(run);
    await expect(readFile(budgetEvidencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(runPackagePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the primary failed run but no publishable package when budget finalization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-budget-custody-"));
    roots.push(root);
    const run = reportRun(false);
    const runPath = join(root, "run.json");
    const budgetEvidencePath = join(root, "budget-terminal-evidence.json");
    const runPackagePath = join(root, "run-package.json");
    const calls: string[] = [];

    await expect(closeLc4DevTerminalRunCustody({
      async execute_run() {
        calls.push("execute");
        return run;
      },
      async write_terminal_run(value) {
        calls.push("write-run");
        await writeFile(runPath, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o400 });
      },
      async finalize_runtime() {
        calls.push("finalize-runtime");
      },
      async finalize_budget() {
        calls.push("finalize-budget");
        throw new Error("budget ledger inspection failed");
      },
      async replay_budget() {
        calls.push("replay-budget");
      },
      create_run_package() {
        calls.push("create-package");
        throw new Error("must not create a package");
      },
      async write_terminal_pair(evidence, runPackage) {
        await Promise.all([
          writeFile(budgetEvidencePath, canonicalJson(evidence), { flag: "wx" }),
          writeFile(runPackagePath, canonicalJson(runPackage), { flag: "wx" }),
        ]);
      },
    })).rejects.toThrow("budget ledger inspection failed");

    expect(calls).toEqual(["execute", "write-run", "finalize-runtime", "finalize-budget"]);
    expect(JSON.parse(await readFile(runPath, "utf8"))).toEqual(run);
    await expect(readFile(budgetEvidencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(runPackagePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("withholds terminal budget evidence and the run package when independent budget replay fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-budget-replay-custody-"));
    roots.push(root);
    const run = reportRun(false);
    const budgetEvidence = terminalBudgetEvidence(run);
    const runPath = join(root, "run.json");
    const budgetEvidencePath = join(root, "budget-terminal-evidence.json");
    const runPackagePath = join(root, "run-package.json");
    const calls: string[] = [];

    await expect(closeLc4DevTerminalRunCustody({
      async execute_run() {
        calls.push("execute");
        return run;
      },
      async write_terminal_run(value) {
        calls.push("write-run");
        await writeFile(runPath, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o400 });
      },
      async finalize_runtime() {
        calls.push("finalize-runtime");
      },
      async finalize_budget() {
        calls.push("finalize-budget");
        return budgetEvidence;
      },
      async replay_budget() {
        calls.push("replay-budget");
        throw new Error("budget evidence replay failed");
      },
      create_run_package() {
        calls.push("create-package");
        throw new Error("must not create a package");
      },
      async write_terminal_pair(evidence, runPackage) {
        await Promise.all([
          writeFile(budgetEvidencePath, canonicalJson(evidence), { flag: "wx" }),
          writeFile(runPackagePath, canonicalJson(runPackage), { flag: "wx" }),
        ]);
      },
    })).rejects.toThrow("budget evidence replay failed");

    expect(calls).toEqual(["execute", "write-run", "finalize-runtime", "finalize-budget", "replay-budget"]);
    expect(JSON.parse(await readFile(runPath, "utf8"))).toEqual(run);
    await expect(readFile(budgetEvidencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(runPackagePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

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
      { ...input, roots: { ...input.roots, asr_evaluator_build_sha256: "1".repeat(64) } },
      { ...input, roots: { ...input.roots, asr_evaluator_toolchain_sha256: "2".repeat(64) } },
      {
        ...input,
        roots: {
          ...input.roots,
          asr_runner_trust: {
            ...input.roots.asr_runner_trust,
            key_id: "lc4-dev-operator-test-asr-rotated",
          },
        },
      },
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

  it("refuses legacy qualification v2 instead of reinterpreting it as current server-VAD evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "lc4-dev-legacy-qualification-"));
    roots.push(root);
    await writeFile(join(root, "lc4-qualification-plan.json"), "{}\n", { mode: 0o400 });
    await expect(loadLc4DevRetainedQualification(
      root,
      "a".repeat(64),
      new Date("2026-07-22T06:00:00.000Z"),
    )).rejects.toThrow("refuses legacy qualification v2");
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

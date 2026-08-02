import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../artifacts";
import {
  beginLc4Cell,
  claimLc4PausedCell,
  classifyLc4ProviderCreditFailure,
  completeLc4Cell,
  initializeLc4CellResumeJournal,
  inspectLc4CellResumeJournal,
  markLc4CellNetworkEmissionStarted,
  pauseLc4CellBeforeNetwork,
  quarantineLc4CellAfterNetwork,
  quarantineLc4InterruptedNetworkCell,
  quarantineLc4MissingJournalCustody,
  recoverExpiredLc4CellBeforeNetwork,
  type Lc4CellResumePlan,
  type Lc4ProviderCreditFailure,
} from "../lc4-cell-resume-journal";
import { initializeFilesystemBudgetLedger } from "../filesystem-budget-ledger";
import { runLc4DevelopmentOperatorCli } from "../lc4-development-operator-cli";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const BASE_TIME = Date.parse("2026-08-01T18:00:00.000Z");
const hash = (value: string) => sha256Hex(`lc4-cell-resume-test\n${value}`);

async function killAfterBudgetMutation(mode: "recover" | "claim", payload: object): Promise<void> {
  const helper = resolve(process.cwd(), "lib/benchmark/__tests__/helpers/lc4-cell-resume-crash-worker.ts");
  await new Promise<void>((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, ["--import", "tsx", helper, mode, JSON.stringify(payload)], {
      cwd: process.cwd(), env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    let killed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!killed && output.includes("BUDGET_MUTATED")) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
    child.on("error", rejectWorker);
    child.on("close", (_code, signal) => {
      if (killed && signal === "SIGKILL") resolveWorker();
      else rejectWorker(new Error(`crash worker did not reach mutation boundary: ${output}${errors}`));
    });
  });
}

async function fixture(): Promise<Readonly<{
  root: string;
  journalPath: string;
  plan: Lc4CellResumePlan;
  now: () => Date;
}>> {
  const root = await mkdtemp(join(tmpdir(), "lc4-cell-resume-"));
  roots.push(root);
  const ledgerPath = join(root, "budget.jsonl");
  const now = () => new Date(BASE_TIME);
  const initialized = await initializeFilesystemBudgetLedger({
    ledgerPath,
    ledgerId: "lc4-cell-resume-test-ledger",
    operationId: "initialize",
    operationalCeilingUsd: "15",
    now,
  });
  const cellShape = [
    ["openai", "native"],
    ["openai", "hacc"],
    ["gemini", "hacc"],
    ["gemini", "native"],
    ["xai", "native"],
    ["xai", "hacc"],
  ] as const;
  const plan: Lc4CellResumePlan = Object.freeze({
    schema_version: 1,
    journal_version: "HACC-LC4-CELL-RESUME-JOURNAL-v1",
    execution_id: "lc4-cell-resume-test",
    source_commit: "a".repeat(40),
    source_tree_sha256: hash("source-tree"),
    prepare_sha256: hash("prepare"),
    preflight_sha256: hash("preflight"),
    authorization_artifact_sha256: hash("authorization"),
    preflight_expires_at: new Date(BASE_TIME + 60 * 60_000).toISOString(),
    lease_hard_deadline_at: new Date(BASE_TIME + 6 * 60 * 60_000).toISOString(),
    credential_identity_set_sha256: hash("credentials"),
    corpus_sha256: hash("corpus"),
    audio_manifest_sha256: hash("audio"),
    provider_profile_manifest_sha256: hash("profiles"),
    provider_session_schedule_sha256: hash("schedule"),
    history_compiler_sha256: hash("history"),
    repair_policy_sha256: hash("repair"),
    scorer_policy_sha256: hash("scorer"),
    budget_ledger_path: ledgerPath,
    budget_ledger_id: initialized.snapshot.ledger_id,
    budget_lease_sha256: hash("lease"),
    cells: Object.freeze(cellShape.map(([provider, arm], index) => Object.freeze({
      cell_id: `cell-${index + 1}-${provider}-${arm}`,
      ordinal: (index + 1) as 1 | 2 | 3 | 4 | 5 | 6,
      provider,
      arm,
      model: `${provider}-realtime-model`,
      voice: `${provider}-voice`,
      opportunity_binding_set_sha256: hash(`opportunities-${provider}`),
      prior_cell_evidence_head_sha256: hash(`prior-${index}`),
    }))),
  });
  const journalPath = join(root, "cell-resume-journal.json");
  await initializeLc4CellResumeJournal({ journal_path: journalPath, plan });
  await writeFile(join(root, "budget-run-lease.json"), `${JSON.stringify({
    execution_id: plan.execution_id,
    ledger_path: plan.budget_ledger_path,
  })}\n`, { mode: 0o600 });
  return Object.freeze({ root, journalPath, plan, now });
}

function owner(ordinal = 1) {
  return Object.freeze({
    owner_id: `operator-${ordinal}`,
    owner_token_sha256: hash(`owner-token-${ordinal}`),
    owner_expires_at: new Date(BASE_TIME + 5 * 60_000).toISOString(),
  });
}

function creditFailure(
  provider: "openai" | "gemini" | "xai",
  override: Partial<Lc4ProviderCreditFailure> = {},
): Lc4ProviderCreditFailure {
  const providerValues = {
    openai: ["insufficient_quota", "account_credit_exhausted"],
    gemini: ["billing_account_credit_exhausted", "billing_account_credit_exhausted"],
    xai: ["insufficient_quota", "account_credit_exhausted"],
  } as const;
  return Object.freeze({
    provider,
    structured_code: providerValues[provider][0],
    structured_reason: providerValues[provider][1],
    authenticated_wire_observation_sha256: hash(`${provider}-wire`),
    response_identity_observed: false,
    generation_requested: false,
    generation_started: false,
    generation_completed: false,
    output_byte_length: 0,
    usage_observed: false,
    assistant_transcript_observed: false,
    gateway_dispatch_count: 0,
    tool_effect_count: 0,
    worker_transition_count: 0,
    ...override,
  });
}

async function begin(
  value: Awaited<ReturnType<typeof fixture>>,
  expectedHead: string,
  cellIndex: number,
  ownerOrdinal = cellIndex + 1,
) {
  return beginLc4Cell({
    journal_path: value.journalPath,
    expected_head_sha256: expectedHead,
    expected_plan: value.plan,
    cell_id: value.plan.cells[cellIndex]!.cell_id,
    ...owner(ownerOrdinal),
    now: value.now,
  });
}

async function emit(
  value: Awaited<ReturnType<typeof fixture>>,
  expectedHead: string,
  cellIndex: number,
  ownerOrdinal = cellIndex + 1,
) {
  return markLc4CellNetworkEmissionStarted({
    journal_path: value.journalPath,
    expected_head_sha256: expectedHead,
    expected_plan: value.plan,
    cell_id: value.plan.cells[cellIndex]!.cell_id,
    ...owner(ownerOrdinal),
    network_intent_sha256: hash(`network-${cellIndex}`),
    now: value.now,
  });
}

async function complete(
  value: Awaited<ReturnType<typeof fixture>>,
  expectedHead: string,
  cellIndex: number,
  ownerOrdinal = cellIndex + 1,
) {
  return completeLc4Cell({
    journal_path: value.journalPath,
    expected_head_sha256: expectedHead,
    expected_plan: value.plan,
    cell_id: value.plan.cells[cellIndex]!.cell_id,
    ...owner(ownerOrdinal),
    cell_artifact_sha256: hash(`cell-artifact-${cellIndex}`),
    now: value.now,
  });
}

describe("LC4 whole-cell paid resume journal", () => {
  it("classifies only exact OpenAI, Gemini, and xAI account-credit denials and never calls them automatically resumable", () => {
    for (const provider of ["openai", "gemini", "xai"] as const) {
      expect(classifyLc4ProviderCreditFailure(creditFailure(provider))).toMatchObject({
        classification: "structured_account_credit_denial",
        provider,
        automatic_resume_eligible: false,
      });
    }
  });

  it.each([
    { structured_code: "429", structured_reason: "account_credit_exhausted" },
    { structured_code: "rate_limit_exceeded", structured_reason: "account_credit_exhausted" },
    { structured_code: "resource_exhausted", structured_reason: "account_credit_exhausted" },
    { structured_code: "timeout", structured_reason: "account_credit_exhausted" },
    { structured_code: "authentication_error", structured_reason: "account_credit_exhausted" },
    { structured_code: "invalid_model", structured_reason: "account_credit_exhausted" },
    { structured_code: null, structured_reason: "billing" },
    { authenticated_wire_observation_sha256: null },
  ])("rejects non-credit or unbound failure shape %#", (override) => {
    expect(classifyLc4ProviderCreditFailure(creditFailure("openai", override))).toMatchObject({
      classification: "not_credit_denial",
      automatic_resume_eligible: false,
    });
  });

  it("pauses and resumes the exact unopened cell without reopening a completed cell", async () => {
    const value = await fixture();
    let status = await inspectLc4CellResumeJournal({ journal_path: value.journalPath, expected_plan: value.plan });
    status = await begin(value, status.head_sha256, 0);
    status = await pauseLc4CellBeforeNetwork({
      journal_path: value.journalPath,
      expected_head_sha256: status.head_sha256,
      expected_plan: value.plan,
      cell_id: value.plan.cells[0]!.cell_id,
      ...owner(1),
      reason_code: "local_pre_network_admission_blocked",
      evidence_sha256: hash("pre-network-credit-preflight"),
      now: value.now,
    });
    expect(status).toMatchObject({ state: "paused_before_network", next_cell_id: value.plan.cells[1]!.cell_id });
    status = await claimLc4PausedCell({
      journal_path: value.journalPath,
      expected_head_sha256: status.head_sha256,
      expected_plan: value.plan,
      cell_id: value.plan.cells[0]!.cell_id,
      ...owner(7),
      now: value.now,
    });
    status = await emit(value, status.head_sha256, 0, 7);
    status = await complete(value, status.head_sha256, 0, 7);
    expect(status.completed_cell_ids).toEqual([value.plan.cells[0]!.cell_id]);
    await expect(begin(value, status.head_sha256, 0)).rejects.toThrow("exact next unopened cell");
    await expect(begin(value, status.head_sha256, 1)).resolves.toMatchObject({ active_cell_id: value.plan.cells[1]!.cell_id });
  });

  it("recovers a crash after fsynced intent only through an explicit pre-network pause", async () => {
    const value = await fixture();
    let status = await inspectLc4CellResumeJournal({ journal_path: value.journalPath });
    status = await begin(value, status.head_sha256, 0);
    expect(status).toMatchObject({ state: "owned_before_network", automatic_resume_available: false });
    status = await pauseLc4CellBeforeNetwork({
      journal_path: value.journalPath,
      expected_head_sha256: status.head_sha256,
      expected_plan: value.plan,
      cell_id: value.plan.cells[0]!.cell_id,
      ...owner(1),
      reason_code: "operator_interruption",
      evidence_sha256: hash("crash-before-client-construction"),
      now: value.now,
    });
    expect((await inspectLc4CellResumeJournal({ journal_path: value.journalPath })).automatic_resume_available).toBe(true);
  });

  it("lets a new process recover an expired pre-network owner without its random token", async () => {
    const value = await fixture();
    let status = await inspectLc4CellResumeJournal({ journal_path: value.journalPath });
    status = await begin(value, status.head_sha256, 0);
    const afterExpiry = () => new Date(BASE_TIME + 6 * 60_000);
    status = await recoverExpiredLc4CellBeforeNetwork({
      journal_path: value.journalPath,
      expected_head_sha256: status.head_sha256,
      expected_plan: value.plan,
      evidence_sha256: hash("expired-owner-no-network-event"),
      now: afterExpiry,
    });
    expect(status).toMatchObject({ state: "paused_before_network", automatic_resume_available: true });
    await expect(claimLc4PausedCell({
      journal_path: value.journalPath,
      expected_head_sha256: status.head_sha256,
      expected_plan: value.plan,
      cell_id: value.plan.cells[0]!.cell_id,
      ...owner(9),
      owner_expires_at: new Date(BASE_TIME + 10 * 60_000).toISOString(),
      now: afterExpiry,
    })).resolves.toMatchObject({ state: "owned_before_network" });
  });

  it("reconciles child-process death after budget pause but before the journal pause append", async () => {
    const value = await fixture();
    let status = await inspectLc4CellResumeJournal({ journal_path: value.journalPath });
    status = await begin(value, status.head_sha256, 0);
    const now = new Date(BASE_TIME + 6 * 60_000);
    const evidence = hash("process-kill-after-budget-pause");
    const recovery = {
      journal_path: value.journalPath,
      expected_head_sha256: status.head_sha256,
      expected_plan: value.plan,
      evidence_sha256: evidence,
      now: now.toISOString(),
    };
    await killAfterBudgetMutation("recover", recovery);
    expect((await inspectLc4CellResumeJournal({ journal_path: value.journalPath })).state).toBe("owned_before_network");
    await expect(recoverExpiredLc4CellBeforeNetwork({
      ...recovery, evidence_sha256: hash("drifted-recovery"), now: () => now,
    })).rejects.toThrow("exact interrupted expired-owner recovery");
    await expect(recoverExpiredLc4CellBeforeNetwork({
      ...recovery, now: () => now,
    })).resolves.toMatchObject({ state: "paused_before_network" });
  }, 30_000);

  it("reconciles child-process death after budget unpause but before owner-takeover append", async () => {
    const value = await fixture();
    let status = await inspectLc4CellResumeJournal({ journal_path: value.journalPath });
    status = await begin(value, status.head_sha256, 0);
    status = await pauseLc4CellBeforeNetwork({
      journal_path: value.journalPath,
      expected_head_sha256: status.head_sha256,
      expected_plan: value.plan,
      cell_id: value.plan.cells[0]!.cell_id,
      ...owner(1), reason_code: "operator_interruption",
      evidence_sha256: hash("process-kill-before-takeover"), now: value.now,
    });
    const takeover = {
      journal_path: value.journalPath,
      expected_head_sha256: status.head_sha256,
      expected_plan: value.plan,
      cell_id: value.plan.cells[0]!.cell_id,
      ...owner(9), owner_expires_at: new Date(BASE_TIME + 10 * 60_000).toISOString(),
      now: new Date(BASE_TIME).toISOString(),
    };
    await killAfterBudgetMutation("claim", takeover);
    expect((await inspectLc4CellResumeJournal({ journal_path: value.journalPath })).state).toBe("paused_before_network");
    await expect(claimLc4PausedCell({ ...takeover, ...owner(8), now: value.now }))
      .rejects.toThrow("exact interrupted owner takeover");
    await expect(claimLc4PausedCell({ ...takeover, now: value.now }))
      .resolves.toMatchObject({ state: "owned_before_network" });
  }, 30_000);

  it("creates an explicit absorbing custody quarantine for an unsafe missing-journal reconstruction", async () => {
    const value = await fixture();
    const ready = await inspectLc4CellResumeJournal({ journal_path: value.journalPath });
    const status = await quarantineLc4MissingJournalCustody({
      journal_path: value.journalPath,
      expected_head_sha256: ready.head_sha256,
      expected_plan: value.plan,
      failure_evidence_sha256: hash("missing-journal-after-boundary"),
      now: value.now,
    });
    expect(status).toMatchObject({
      state: "network_ambiguous",
      quarantined_cell_ids: [value.plan.cells[0]!.cell_id],
      scoring_available: false,
    });
  });

  it("quarantines a crash after network admission and cannot resume it automatically", async () => {
    const value = await fixture();
    let status = await inspectLc4CellResumeJournal({ journal_path: value.journalPath });
    status = await begin(value, status.head_sha256, 0);
    status = await emit(value, status.head_sha256, 0);
    expect(status).toMatchObject({ state: "network_ambiguous", automatic_resume_available: false, scoring_available: false });
    const quarantined = await quarantineLc4CellAfterNetwork({
      journal_path: value.journalPath,
      expected_head_sha256: status.head_sha256,
      expected_plan: value.plan,
      cell_id: value.plan.cells[0]!.cell_id,
      ...owner(1),
      failure_evidence_sha256: hash("ambiguous-after-send"),
      now: value.now,
    });
    await expect(claimLc4PausedCell({
      journal_path: value.journalPath,
      expected_head_sha256: quarantined.head_sha256,
      expected_plan: value.plan,
      cell_id: value.plan.cells[0]!.cell_id,
      ...owner(9),
      now: value.now,
    })).rejects.toThrow("not paused before network emission");
  });

  it("turns a process-restarted network admission into an absorbing quarantine", async () => {
    const value = await fixture();
    let status = await inspectLc4CellResumeJournal({ journal_path: value.journalPath });
    status = await begin(value, status.head_sha256, 0);
    await emit(value, status.head_sha256, 0);

    const restarted = await inspectLc4CellResumeJournal({
      journal_path: value.journalPath,
      expected_plan: value.plan,
    });
    const quarantined = await quarantineLc4InterruptedNetworkCell({
      journal_path: value.journalPath,
      expected_head_sha256: restarted.head_sha256,
      expected_plan: value.plan,
      failure_evidence_sha256: hash("process-ended-after-network-admission"),
      now: value.now,
    });
    expect(quarantined).toMatchObject({
      state: "network_ambiguous",
      active_cell_id: null,
      quarantined_cell_ids: [value.plan.cells[0]!.cell_id],
      all_cells_completed: false,
      scoring_available: false,
    });
    await expect(begin(value, quarantined.head_sha256, 1)).rejects.toThrow("exact next unopened cell");
  });

  it("fails closed on stale head and changed source, model, corpus, schedule, credentials, or authorization", async () => {
    const value = await fixture();
    const status = await inspectLc4CellResumeJournal({ journal_path: value.journalPath });
    const mutations: Lc4CellResumePlan[] = [
      { ...value.plan, source_commit: "b".repeat(40) },
      { ...value.plan, corpus_sha256: hash("other-corpus") },
      { ...value.plan, audio_manifest_sha256: hash("other-audio") },
      { ...value.plan, provider_session_schedule_sha256: hash("other-schedule") },
      { ...value.plan, history_compiler_sha256: hash("other-history") },
      { ...value.plan, repair_policy_sha256: hash("other-repair") },
      { ...value.plan, scorer_policy_sha256: hash("other-scorer") },
      { ...value.plan, credential_identity_set_sha256: hash("other-credentials") },
      { ...value.plan, authorization_artifact_sha256: hash("other-authorization") },
      { ...value.plan, cells: value.plan.cells.map((cell, index) => index === 0 ? { ...cell, model: "different-model" } : cell) },
      { ...value.plan, cells: value.plan.cells.map((cell, index) => index === 0 ? { ...cell, voice: "different-voice" } : cell) },
    ];
    for (const plan of mutations) {
      await expect(beginLc4Cell({
        journal_path: value.journalPath,
        expected_head_sha256: status.head_sha256,
        expected_plan: plan,
        cell_id: value.plan.cells[0]!.cell_id,
        ...owner(1),
        now: value.now,
      })).rejects.toThrow("binding changed");
    }
    await expect(begin(value, hash("stale-head"), 0)).rejects.toThrow("stale journal head");
  });

  it("admits exactly one of two concurrent resume owners", async () => {
    const value = await fixture();
    let status = await inspectLc4CellResumeJournal({ journal_path: value.journalPath });
    status = await begin(value, status.head_sha256, 0);
    status = await pauseLc4CellBeforeNetwork({
      journal_path: value.journalPath,
      expected_head_sha256: status.head_sha256,
      expected_plan: value.plan,
      cell_id: value.plan.cells[0]!.cell_id,
      ...owner(1),
      reason_code: "operator_interruption",
      evidence_sha256: hash("pause"),
      now: value.now,
    });
    const expectedHead = status.head_sha256;
    const attempts = await Promise.allSettled([2, 3].map((ordinal) => claimLc4PausedCell({
      journal_path: value.journalPath,
      expected_head_sha256: expectedHead,
      expected_plan: value.plan,
      cell_id: value.plan.cells[0]!.cell_id,
      ...owner(ordinal),
      now: value.now,
    })));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(String((attempts.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)).toContain("stale journal head");
  });

  it("retains completed cells across process-style reinspection and never reruns them", async () => {
    const value = await fixture();
    let status = await inspectLc4CellResumeJournal({ journal_path: value.journalPath });
    status = await begin(value, status.head_sha256, 0);
    status = await emit(value, status.head_sha256, 0);
    await complete(value, status.head_sha256, 0);
    const restarted = await inspectLc4CellResumeJournal({ journal_path: value.journalPath, expected_plan: value.plan });
    expect(restarted.completed_cell_ids).toEqual([value.plan.cells[0]!.cell_id]);
    expect(restarted.completed_cells).toEqual([{
      cell_id: value.plan.cells[0]!.cell_id,
      artifact_sha256: hash("cell-artifact-0"),
    }]);
    expect(restarted.next_cell_id).toBe(value.plan.cells[1]!.cell_id);
    await expect(begin(value, restarted.head_sha256, 0)).rejects.toThrow("exact next unopened cell");
  });

  it("withholds aggregate scoring until all six frozen cells complete", async () => {
    const value = await fixture();
    let status = await inspectLc4CellResumeJournal({ journal_path: value.journalPath });
    for (let index = 0; index < 6; index += 1) {
      status = await begin(value, status.head_sha256, index);
      status = await emit(value, status.head_sha256, index);
      status = await complete(value, status.head_sha256, index);
      expect(status.scoring_available).toBe(false);
      expect(status.all_cells_completed).toBe(index === 5);
    }
    expect(status).toMatchObject({ state: "completed", next_cell_id: null, completed_cell_ids: value.plan.cells.map((cell) => cell.cell_id) });
  });

  it("exposes a provider-free real operator resume status without claiming call counts or auto-resume", async () => {
    const value = await fixture();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runLc4DevelopmentOperatorCli([
      "resume-status",
      "--evidence-root", value.root,
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      now: value.now,
    });
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      command: "resume-status",
      provider_calls_made: null,
      automatic_run_resume_supported: true,
      resume: { state: "ready", scoring_available: false },
      budget: { paused: false, active_reservations_micro_usd: 0 },
    });
  });
});

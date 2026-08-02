import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { canonicalJson, sha256Hex } from "./artifacts";
import {
  inspectFilesystemBudgetLedger,
  setFilesystemBudgetPaused,
} from "./filesystem-budget-ledger";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import type {
  Lc4DevLivePreflightArtifact,
  Lc4DevLivePrepareArtifact,
} from "./lc4-development-live-runner";
import type { Lc4DevRunLease } from "./lc4-development-budget";

export const LC4_CELL_RESUME_JOURNAL_VERSION =
  "HACC-LC4-CELL-RESUME-JOURNAL-v1" as const;

const PLAN_DOMAIN = "harshas-amazing-call-center/lc4-cell-resume-plan/v1\n";
const EVENT_DOMAIN = "harshas-amazing-call-center/lc4-cell-resume-event/v1\n";
const SNAPSHOT_DOMAIN = "harshas-amazing-call-center/lc4-cell-resume-snapshot/v1\n";
const CREDIT_DOMAIN = "harshas-amazing-call-center/lc4-provider-credit-rejection/v1\n";
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const PRIVATE_MODE = 0o600;
const PRIVATE_MASK = 0o077;

export type Lc4CellResumeBinding = Readonly<{
  cell_id: string;
  ordinal: 1 | 2 | 3 | 4 | 5 | 6;
  provider: LiveStsProvider;
  arm: "native" | "hacc";
  model: string;
  voice: string;
  opportunity_binding_set_sha256: string;
  prior_cell_evidence_head_sha256: string;
}>;

export type Lc4CellResumePlan = Readonly<{
  schema_version: 1;
  journal_version: typeof LC4_CELL_RESUME_JOURNAL_VERSION;
  execution_id: string;
  source_commit: string;
  source_tree_sha256: string;
  prepare_sha256: string;
  preflight_sha256: string;
  authorization_artifact_sha256: string;
  preflight_expires_at: string;
  lease_hard_deadline_at: string;
  credential_identity_set_sha256: string;
  corpus_sha256: string;
  audio_manifest_sha256: string;
  provider_profile_manifest_sha256: string;
  provider_session_schedule_sha256: string;
  history_compiler_sha256: string;
  repair_policy_sha256: string;
  scorer_policy_sha256: string;
  budget_ledger_path: string;
  budget_ledger_id: string;
  budget_lease_sha256: string;
  cells: readonly Lc4CellResumeBinding[];
}>;

export type Lc4ProviderCreditFailure = Readonly<{
  provider: LiveStsProvider;
  structured_code: string | null;
  structured_reason: string | null;
  authenticated_wire_observation_sha256: string | null;
  response_identity_observed: boolean;
  generation_requested: boolean;
  generation_started: boolean;
  generation_completed: boolean;
  output_byte_length: number;
  usage_observed: boolean;
  assistant_transcript_observed: boolean;
  gateway_dispatch_count: number;
  tool_effect_count: number;
  worker_transition_count: number;
}>;

export type Lc4ProviderCreditClassification = Readonly<{
  classification: "structured_account_credit_denial" | "not_credit_denial" | "ambiguous_after_send";
  provider: LiveStsProvider;
  automatic_resume_eligible: false;
  reason: string;
  evidence_sha256: string;
}>;

type JournalEventType =
  | "cell.intent_fsynced"
  | "cell.paused_before_network"
  | "cell.resume_claimed"
  | "cell.network_emission_started"
  | "cell.completed"
  | "cell.ambiguous_quarantined";

type JournalEvent = Readonly<{
  sequence: number;
  occurred_at: string;
  event_type: JournalEventType;
  cell_id: string;
  owner_id: string;
  owner_token_sha256: string;
  owner_expires_at: string;
  evidence_sha256: string;
  budget_ledger_head_sha256: string;
  previous_event_sha256: string;
  event_sha256: string;
}>;

type JournalFile = Readonly<{
  schema_version: 1;
  journal_version: typeof LC4_CELL_RESUME_JOURNAL_VERSION;
  plan: Lc4CellResumePlan;
  plan_sha256: string;
  sequence: number;
  head_sha256: string;
  events: readonly JournalEvent[];
  snapshot_sha256: string;
}>;

export type Lc4CellResumeStatus = Readonly<{
  plan_sha256: string;
  head_sha256: string;
  sequence: number;
  state: "ready" | "owned_before_network" | "paused_before_network" | "network_ambiguous" | "completed";
  next_cell_id: string | null;
  active_cell_id: string | null;
  completed_cell_ids: readonly string[];
  completed_cells: readonly Readonly<{ cell_id: string; artifact_sha256: string }>[];
  quarantined_cell_ids: readonly string[];
  automatic_resume_available: boolean;
  all_cells_completed: boolean;
  scoring_available: boolean;
}>;

function fail(message: string): never {
  throw new Error(`LC4 cell resume refused: ${message}`);
}

function requireId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) fail(`${label} is not a safe identifier`);
}

function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) fail(`${label} is not a lowercase SHA-256`);
}

function requireTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${label} is not a canonical ISO timestamp`);
  }
}

function requirePrivateAbsolutePath(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) fail(`${label} must be an absolute normalized path`);
}

function assertPlan(plan: Lc4CellResumePlan): void {
  if (plan.schema_version !== 1 || plan.journal_version !== LC4_CELL_RESUME_JOURNAL_VERSION) {
    fail("plan version is unsupported");
  }
  requireId(plan.execution_id, "execution_id");
  if (!COMMIT.test(plan.source_commit)) fail("source_commit is invalid");
  for (const [label, value] of Object.entries({
    source_tree_sha256: plan.source_tree_sha256,
    prepare_sha256: plan.prepare_sha256,
    preflight_sha256: plan.preflight_sha256,
    authorization_artifact_sha256: plan.authorization_artifact_sha256,
    credential_identity_set_sha256: plan.credential_identity_set_sha256,
    corpus_sha256: plan.corpus_sha256,
    audio_manifest_sha256: plan.audio_manifest_sha256,
    provider_profile_manifest_sha256: plan.provider_profile_manifest_sha256,
    provider_session_schedule_sha256: plan.provider_session_schedule_sha256,
    history_compiler_sha256: plan.history_compiler_sha256,
    repair_policy_sha256: plan.repair_policy_sha256,
    scorer_policy_sha256: plan.scorer_policy_sha256,
    budget_lease_sha256: plan.budget_lease_sha256,
  })) requireHash(value, label);
  requireTimestamp(plan.preflight_expires_at, "preflight_expires_at");
  requireTimestamp(plan.lease_hard_deadline_at, "lease_hard_deadline_at");
  requirePrivateAbsolutePath(plan.budget_ledger_path, "budget_ledger_path");
  requireId(plan.budget_ledger_id, "budget_ledger_id");
  if (plan.cells.length !== 6 || new Set(plan.cells.map((cell) => cell.cell_id)).size !== 6) {
    fail("plan must bind exactly six unique cells");
  }
  const providers = ["openai", "gemini", "xai"] as const;
  const expectedOrder = providers.flatMap((provider) => [
    `${provider}:native`,
    `${provider}:hacc`,
  ]);
  const actualPairs = plan.cells.map((cell) => `${cell.provider}:${cell.arm}`);
  if (new Set(actualPairs).size !== 6 || !expectedOrder.every((pair) => actualPairs.includes(pair))) {
    fail("plan must contain one Native and HACC cell for every provider");
  }
  plan.cells.forEach((cell, index) => {
    requireId(cell.cell_id, `cells[${index}].cell_id`);
    requireId(cell.model, `cells[${index}].model`);
    requireId(cell.voice, `cells[${index}].voice`);
    requireHash(cell.opportunity_binding_set_sha256, `cells[${index}].opportunity_binding_set_sha256`);
    requireHash(cell.prior_cell_evidence_head_sha256, `cells[${index}].prior_cell_evidence_head_sha256`);
    if (cell.ordinal !== index + 1) fail("cell ordinals must be contiguous and match frozen order");
  });
}

export function lc4CellResumePlanSha256(plan: Lc4CellResumePlan): string {
  assertPlan(plan);
  return sha256Hex(`${PLAN_DOMAIN}${canonicalJson(plan)}`);
}

export function createLc4CellResumePlan(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  preflight: Lc4DevLivePreflightArtifact;
  lease: Lc4DevRunLease;
  history_compiler_sha256: string;
  repair_policy_sha256: string;
  scorer_policy_sha256: string;
}>): Lc4CellResumePlan {
  for (const [label, value] of Object.entries({
    history_compiler_sha256: input.history_compiler_sha256,
    repair_policy_sha256: input.repair_policy_sha256,
    scorer_policy_sha256: input.scorer_policy_sha256,
  })) requireHash(value, label);
  if (input.prepare.execution_id !== input.preflight.execution_id
    || input.prepare.execution_id !== input.lease.execution_id
    || input.prepare.prepare_sha256 !== input.preflight.prepare_sha256
    || input.prepare.prepare_sha256 !== input.lease.prepare_sha256
    || input.preflight.preflight_sha256 !== input.lease.preflight_sha256
    || input.prepare.episodes.length !== 6) fail("prepare, preflight, and lease do not bind one six-cell execution");
  let prior = sha256Hex(`${PLAN_DOMAIN}cell-evidence-genesis\n${input.prepare.prepare_sha256}`);
  const cells = input.prepare.episodes.map((episode, index) => {
    const value = Object.freeze({
      cell_id: episode.episode_id,
      ordinal: (index + 1) as 1 | 2 | 3 | 4 | 5 | 6,
      provider: episode.provider,
      arm: episode.arm,
      model: episode.model,
      voice: episode.voice,
      opportunity_binding_set_sha256: episode.opportunity_binding_set_sha256,
      prior_cell_evidence_head_sha256: prior,
    });
    prior = sha256Hex(`${PLAN_DOMAIN}cell-plan-chain\n${canonicalJson(value)}`);
    return value;
  });
  const plan = Object.freeze({
    schema_version: 1 as const,
    journal_version: LC4_CELL_RESUME_JOURNAL_VERSION,
    execution_id: input.prepare.execution_id,
    source_commit: input.prepare.source_commit,
    source_tree_sha256: input.prepare.source_tree_sha256,
    prepare_sha256: input.prepare.prepare_sha256,
    preflight_sha256: input.preflight.preflight_sha256,
    authorization_artifact_sha256: input.preflight.authorization_artifact_sha256,
    preflight_expires_at: input.preflight.expires_at,
    lease_hard_deadline_at: input.lease.hard_deadline_at,
    credential_identity_set_sha256: input.preflight.credential_identity_set_sha256,
    corpus_sha256: input.prepare.corpus_sha256,
    audio_manifest_sha256: input.prepare.audio_manifest_sha256,
    provider_profile_manifest_sha256: input.prepare.provider_profile_manifest_sha256,
    provider_session_schedule_sha256: input.prepare.provider_session_schedule_sha256,
    history_compiler_sha256: input.history_compiler_sha256,
    repair_policy_sha256: input.repair_policy_sha256,
    scorer_policy_sha256: input.scorer_policy_sha256,
    budget_ledger_path: input.lease.ledger_path,
    budget_ledger_id: input.lease.ledger_id,
    budget_lease_sha256: input.lease.lease_sha256,
    cells: Object.freeze(cells),
  });
  assertPlan(plan);
  return plan;
}

const CREDIT_CODE_ALLOWLIST: Readonly<Record<LiveStsProvider, ReadonlySet<string>>> = Object.freeze({
  openai: new Set(["insufficient_quota"]),
  gemini: new Set(["billing_account_credit_exhausted"]),
  xai: new Set(["insufficient_quota"]),
});

const CREDIT_REASON_ALLOWLIST: Readonly<Record<LiveStsProvider, ReadonlySet<string>>> = Object.freeze({
  openai: new Set(["account_credit_exhausted"]),
  gemini: new Set(["billing_account_credit_exhausted"]),
  xai: new Set(["account_credit_exhausted"]),
});

/**
 * Recognizes exact provider-shaped account-credit denials without treating a
 * generic 429, rate limit, resource exhaustion, or plaintext message as proof.
 * A provider-returned denial necessarily follows a network emission, so the
 * current one-shot LC4 protocol never treats it as automatically resumable.
 */
export function classifyLc4ProviderCreditFailure(
  failure: Lc4ProviderCreditFailure,
): Lc4ProviderCreditClassification {
  const body = Object.freeze({ ...failure });
  const evidenceSha256 = sha256Hex(`${CREDIT_DOMAIN}${canonicalJson(body)}`);
  const exactCode = failure.structured_code !== null
    && CREDIT_CODE_ALLOWLIST[failure.provider].has(failure.structured_code);
  const exactReason = failure.structured_reason !== null
    && CREDIT_REASON_ALLOWLIST[failure.provider].has(failure.structured_reason);
  const exactWire = failure.authenticated_wire_observation_sha256 !== null
    && HASH.test(failure.authenticated_wire_observation_sha256);
  const lifecycleClear = !failure.response_identity_observed
    && !failure.generation_requested
    && !failure.generation_started
    && !failure.generation_completed
    && failure.output_byte_length === 0
    && !failure.usage_observed
    && !failure.assistant_transcript_observed
    && failure.gateway_dispatch_count === 0
    && failure.tool_effect_count === 0
    && failure.worker_transition_count === 0;
  if (exactCode && exactReason && exactWire && lifecycleClear) {
    return Object.freeze({
      classification: "structured_account_credit_denial" as const,
      provider: failure.provider,
      automatic_resume_eligible: false as const,
      reason: "provider_denial_followed_network_emission_and_requires_versioned_admission_rule",
      evidence_sha256: evidenceSha256,
    });
  }
  const activityObserved = failure.response_identity_observed
    || failure.generation_requested
    || failure.generation_started
    || failure.generation_completed
    || failure.output_byte_length > 0
    || failure.usage_observed
    || failure.assistant_transcript_observed
    || failure.gateway_dispatch_count > 0
    || failure.tool_effect_count > 0
    || failure.worker_transition_count > 0;
  return Object.freeze({
    classification: activityObserved ? "ambiguous_after_send" as const : "not_credit_denial" as const,
    provider: failure.provider,
    automatic_resume_eligible: false as const,
    reason: activityObserved
      ? "generation_output_usage_or_effect_evidence_prevents_readmission"
      : "failure_lacks_exact_structured_account_credit_proof",
    evidence_sha256: evidenceSha256,
  });
}

function eventHash(event: Omit<JournalEvent, "event_sha256">): string {
  return sha256Hex(`${EVENT_DOMAIN}${canonicalJson(event)}`);
}

function snapshotHash(file: Omit<JournalFile, "snapshot_sha256">): string {
  return sha256Hex(`${SNAPSHOT_DOMAIN}${canonicalJson(file)}`);
}

function appendEvent(file: JournalFile, event: Omit<JournalEvent, "sequence" | "previous_event_sha256" | "event_sha256">): JournalFile {
  const body = Object.freeze({
    sequence: file.sequence + 1,
    ...event,
    previous_event_sha256: file.head_sha256,
  });
  const complete = Object.freeze({ ...body, event_sha256: eventHash(body) });
  const nextBody = Object.freeze({
    schema_version: 1 as const,
    journal_version: LC4_CELL_RESUME_JOURNAL_VERSION,
    plan: file.plan,
    plan_sha256: file.plan_sha256,
    sequence: complete.sequence,
    head_sha256: complete.event_sha256,
    events: Object.freeze([...file.events, complete]),
  });
  return Object.freeze({ ...nextBody, snapshot_sha256: snapshotHash(nextBody) });
}

function verifyFile(file: JournalFile): void {
  assertPlan(file.plan);
  if (file.schema_version !== 1
    || file.journal_version !== LC4_CELL_RESUME_JOURNAL_VERSION
    || file.plan_sha256 !== lc4CellResumePlanSha256(file.plan)
    || !Number.isSafeInteger(file.sequence)
    || file.sequence !== file.events.length) fail("journal header or plan binding is invalid");
  let head = "0".repeat(64);
  const states = new Map<string, JournalEventType>();
  for (const [index, event] of file.events.entries()) {
    const { event_sha256: claimed, ...body } = event;
    if (event.sequence !== index + 1 || event.previous_event_sha256 !== head || claimed !== eventHash(body)) {
      fail("journal event chain is invalid");
    }
    requireId(event.cell_id, "event.cell_id");
    requireId(event.owner_id, "event.owner_id");
    requireHash(event.owner_token_sha256, "event.owner_token_sha256");
    requireTimestamp(event.owner_expires_at, "event.owner_expires_at");
    requireHash(event.evidence_sha256, "event.evidence_sha256");
    requireHash(event.budget_ledger_head_sha256, "event.budget_ledger_head_sha256");
    if (!file.plan.cells.some((cell) => cell.cell_id === event.cell_id)) fail("event references an unplanned cell");
    const prior = states.get(event.cell_id);
    if (event.event_type === "cell.intent_fsynced") {
      if (prior !== undefined) fail("cell intent is duplicated");
    } else if (event.event_type === "cell.paused_before_network") {
      if (prior !== "cell.intent_fsynced" && prior !== "cell.resume_claimed") fail("only a pre-network owner can pause");
    } else if (event.event_type === "cell.resume_claimed") {
      if (prior !== "cell.paused_before_network") fail("only a paused unopened cell can resume");
    } else if (event.event_type === "cell.network_emission_started") {
      if (prior !== "cell.intent_fsynced" && prior !== "cell.resume_claimed") fail("network admission lacks an unopened-cell owner");
    } else if (event.event_type === "cell.completed") {
      if (prior !== "cell.network_emission_started") fail("cell completion lacks a network admission");
    } else if (event.event_type === "cell.ambiguous_quarantined") {
      if (prior !== "cell.network_emission_started") fail("only a network-admitted cell can be quarantined");
    }
    states.set(event.cell_id, event.event_type);
    head = claimed;
  }
  const body = {
    schema_version: file.schema_version,
    journal_version: file.journal_version,
    plan: file.plan,
    plan_sha256: file.plan_sha256,
    sequence: file.sequence,
    head_sha256: file.head_sha256,
    events: file.events,
  };
  if (file.head_sha256 !== head || file.snapshot_sha256 !== snapshotHash(body)) fail("journal snapshot hash is invalid");
}

async function readJournal(path: string): Promise<JournalFile> {
  requirePrivateAbsolutePath(path, "journal path");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & PRIVATE_MASK) !== 0) {
    fail("journal is not a private regular single-link file");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_JOURNAL_BYTES) fail("journal size is invalid");
  let value: JournalFile;
  try {
    value = JSON.parse(bytes.toString("utf8")) as JournalFile;
  } catch {
    fail("journal is not valid JSON");
  }
  verifyFile(value);
  return value;
}

async function writeJournal(path: string, file: JournalFile, create: boolean): Promise<void> {
  verifyFile(file);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_MODE);
  try {
    await handle.writeFile(`${canonicalJson(file)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, PRIVATE_MODE);
  if (create && await lstat(path).catch(() => null)) {
    await rm(temporary, { force: true });
    fail("journal already exists");
  }
  await rename(temporary, path);
  const directory = await open(parent, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      acquired = true;
      break;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 2));
    }
  }
  if (!acquired) fail("journal ownership lock timed out");
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function stateFor(file: JournalFile): Lc4CellResumeStatus {
  const latest = new Map<string, JournalEvent>();
  for (const event of file.events) latest.set(event.cell_id, event);
  const completed = file.plan.cells.filter((cell) => latest.get(cell.cell_id)?.event_type === "cell.completed").map((cell) => cell.cell_id);
  const completedCells = file.plan.cells.flatMap((cell) => {
    const event = latest.get(cell.cell_id);
    return event?.event_type === "cell.completed"
      ? [Object.freeze({ cell_id: cell.cell_id, artifact_sha256: event.evidence_sha256 })]
      : [];
  });
  const quarantined = file.plan.cells.filter((cell) => latest.get(cell.cell_id)?.event_type === "cell.ambiguous_quarantined").map((cell) => cell.cell_id);
  const active = file.plan.cells.find((cell) => {
    const event = latest.get(cell.cell_id)?.event_type;
    return event !== undefined && event !== "cell.completed" && event !== "cell.ambiguous_quarantined";
  });
  const next = file.plan.cells.find((cell) => !latest.has(cell.cell_id));
  const activeType = active ? latest.get(active.cell_id)!.event_type : null;
  const state = quarantined.length > 0
    ? "network_ambiguous" as const
    : completed.length === 6
      ? "completed" as const
      : activeType === "cell.paused_before_network"
        ? "paused_before_network" as const
        : activeType === "cell.network_emission_started"
          ? "network_ambiguous" as const
          : active
            ? "owned_before_network" as const
            : "ready" as const;
  return Object.freeze({
    plan_sha256: file.plan_sha256,
    head_sha256: file.head_sha256,
    sequence: file.sequence,
    state,
    next_cell_id: next?.cell_id ?? null,
    active_cell_id: active?.cell_id ?? null,
    completed_cell_ids: Object.freeze(completed),
    completed_cells: Object.freeze(completedCells),
    quarantined_cell_ids: Object.freeze(quarantined),
    automatic_resume_available: state === "paused_before_network",
    all_cells_completed: completed.length === 6 && quarantined.length === 0,
    // Cell terminal custody alone is never sufficient to score. The separate
    // run package must also replay authority, budget settlement, 36 sessions,
    // and all 360 opportunities.
    scoring_available: false,
  });
}

export async function initializeLc4CellResumeJournal(input: Readonly<{
  journal_path: string;
  plan: Lc4CellResumePlan;
}>): Promise<Lc4CellResumeStatus> {
  requirePrivateAbsolutePath(input.journal_path, "journal_path");
  assertPlan(input.plan);
  const ledger = await inspectFilesystemBudgetLedger({ ledgerPath: input.plan.budget_ledger_path });
  if (ledger.ledger_id !== input.plan.budget_ledger_id || ledger.paused) {
    fail("budget ledger identity or initial pause state differs from plan");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    journal_version: LC4_CELL_RESUME_JOURNAL_VERSION,
    plan: input.plan,
    plan_sha256: lc4CellResumePlanSha256(input.plan),
    sequence: 0,
    head_sha256: "0".repeat(64),
    events: Object.freeze([]) as readonly JournalEvent[],
  });
  const file = Object.freeze({ ...body, snapshot_sha256: snapshotHash(body) });
  await withLock(input.journal_path, () => writeJournal(input.journal_path, file, true));
  return stateFor(file);
}

export async function inspectLc4CellResumeJournal(input: Readonly<{
  journal_path: string;
  expected_plan?: Lc4CellResumePlan;
}>): Promise<Lc4CellResumeStatus> {
  const file = await readJournal(input.journal_path);
  if (input.expected_plan && file.plan_sha256 !== lc4CellResumePlanSha256(input.expected_plan)) {
    fail("source, model, corpus, schedule, credentials, or authorization binding changed");
  }
  return stateFor(file);
}

async function mutateJournal(input: Readonly<{
  journal_path: string;
  expected_head_sha256: string;
  expected_plan: Lc4CellResumePlan;
  event(file: JournalFile): Promise<JournalFile> | JournalFile;
}>): Promise<Lc4CellResumeStatus> {
  requireHash(input.expected_head_sha256, "expected_head_sha256");
  return withLock(input.journal_path, async () => {
    const file = await readJournal(input.journal_path);
    if (file.head_sha256 !== input.expected_head_sha256) fail("stale journal head");
    if (file.plan_sha256 !== lc4CellResumePlanSha256(input.expected_plan)) {
      fail("source, model, corpus, schedule, credentials, or authorization binding changed");
    }
    const next = await input.event(file);
    await writeJournal(input.journal_path, next, false);
    return stateFor(next);
  });
}

export async function beginLc4Cell(input: Readonly<{
  journal_path: string;
  expected_head_sha256: string;
  expected_plan: Lc4CellResumePlan;
  cell_id: string;
  owner_id: string;
  owner_token_sha256: string;
  owner_expires_at: string;
  now: () => Date;
}>): Promise<Lc4CellResumeStatus> {
  requireId(input.owner_id, "owner_id");
  requireHash(input.owner_token_sha256, "owner_token_sha256");
  requireTimestamp(input.owner_expires_at, "owner_expires_at");
  return mutateJournal({ ...input, event: async (file) => {
    const status = stateFor(file);
    if (status.state !== "ready" || status.next_cell_id !== input.cell_id) fail("cell is not the exact next unopened cell");
    const now = input.now();
    if (now.getTime() >= Date.parse(file.plan.lease_hard_deadline_at)
      || now.getTime() >= Date.parse(input.owner_expires_at)) fail("authorization or owner lease expired before cell intent");
    const ledger = await inspectFilesystemBudgetLedger({ ledgerPath: file.plan.budget_ledger_path, now: input.now });
    if (ledger.ledger_id !== file.plan.budget_ledger_id || ledger.paused) fail("budget ledger cannot admit a cell intent");
    return appendEvent(file, {
      occurred_at: now.toISOString(),
      event_type: "cell.intent_fsynced",
      cell_id: input.cell_id,
      owner_id: input.owner_id,
      owner_token_sha256: input.owner_token_sha256,
      owner_expires_at: input.owner_expires_at,
      evidence_sha256: file.plan.cells.find((cell) => cell.cell_id === input.cell_id)!.prior_cell_evidence_head_sha256,
      budget_ledger_head_sha256: ledger.head_sha256,
    });
  }});
}

export async function pauseLc4CellBeforeNetwork(input: Readonly<{
  journal_path: string;
  expected_head_sha256: string;
  expected_plan: Lc4CellResumePlan;
  cell_id: string;
  owner_id: string;
  owner_token_sha256: string;
  reason_code: "local_pre_network_admission_blocked" | "operator_interruption";
  evidence_sha256: string;
  now: () => Date;
}>): Promise<Lc4CellResumeStatus> {
  requireHash(input.evidence_sha256, "evidence_sha256");
  return mutateJournal({ ...input, event: async (file) => {
    const last = file.events.at(-1);
    if (!last || last.cell_id !== input.cell_id
      || (last.event_type !== "cell.intent_fsynced" && last.event_type !== "cell.resume_claimed")
      || last.owner_id !== input.owner_id
      || last.owner_token_sha256 !== input.owner_token_sha256) fail("only the current pre-network owner can pause");
    const ledger = await inspectFilesystemBudgetLedger({ ledgerPath: file.plan.budget_ledger_path, now: input.now });
    const pause = await setFilesystemBudgetPaused({
      ledgerPath: file.plan.budget_ledger_path,
      operationId: `lc4cell-pause:${input.cell_id}:${file.sequence + 1}`,
      paused: true,
      reasonCode: input.reason_code,
      evidenceSha256: input.evidence_sha256,
      expectedLedgerId: file.plan.budget_ledger_id,
      expectedHeadSha256: ledger.head_sha256,
      now: input.now,
    });
    return appendEvent(file, {
      occurred_at: input.now().toISOString(),
      event_type: "cell.paused_before_network",
      cell_id: input.cell_id,
      owner_id: input.owner_id,
      owner_token_sha256: input.owner_token_sha256,
      owner_expires_at: last.owner_expires_at,
      evidence_sha256: input.evidence_sha256,
      budget_ledger_head_sha256: pause.snapshot.head_sha256,
    });
  }});
}

export async function claimLc4PausedCell(input: Readonly<{
  journal_path: string;
  expected_head_sha256: string;
  expected_plan: Lc4CellResumePlan;
  cell_id: string;
  owner_id: string;
  owner_token_sha256: string;
  owner_expires_at: string;
  now: () => Date;
}>): Promise<Lc4CellResumeStatus> {
  requireId(input.owner_id, "owner_id");
  requireHash(input.owner_token_sha256, "owner_token_sha256");
  requireTimestamp(input.owner_expires_at, "owner_expires_at");
  return mutateJournal({ ...input, event: async (file) => {
    const status = stateFor(file);
    const last = file.events.at(-1);
    const now = input.now();
    if (status.state !== "paused_before_network" || status.active_cell_id !== input.cell_id
      || last?.event_type !== "cell.paused_before_network") fail("cell is not paused before network emission");
    if (now.getTime() >= Date.parse(file.plan.lease_hard_deadline_at)
      || now.getTime() >= Date.parse(input.owner_expires_at)) fail("authorization or owner lease expired before resume");
    const ledger = await inspectFilesystemBudgetLedger({ ledgerPath: file.plan.budget_ledger_path, now: input.now });
    if (!ledger.paused || ledger.ledger_id !== file.plan.budget_ledger_id
      || ledger.head_sha256 !== last.budget_ledger_head_sha256) fail("paused budget ledger head differs from journal custody");
    const resumed = await setFilesystemBudgetPaused({
      ledgerPath: file.plan.budget_ledger_path,
      operationId: `lc4cell-resume:${input.cell_id}:${file.sequence + 1}`,
      paused: false,
      reasonCode: "credit_restored_exact_cell",
      evidenceSha256: last.evidence_sha256,
      expectedLedgerId: file.plan.budget_ledger_id,
      expectedHeadSha256: ledger.head_sha256,
      now: input.now,
    });
    return appendEvent(file, {
      occurred_at: now.toISOString(),
      event_type: "cell.resume_claimed",
      cell_id: input.cell_id,
      owner_id: input.owner_id,
      owner_token_sha256: input.owner_token_sha256,
      owner_expires_at: input.owner_expires_at,
      evidence_sha256: last.evidence_sha256,
      budget_ledger_head_sha256: resumed.snapshot.head_sha256,
    });
  }});
}

export async function markLc4CellNetworkEmissionStarted(input: Readonly<{
  journal_path: string;
  expected_head_sha256: string;
  expected_plan: Lc4CellResumePlan;
  cell_id: string;
  owner_id: string;
  owner_token_sha256: string;
  network_intent_sha256: string;
  now: () => Date;
}>): Promise<Lc4CellResumeStatus> {
  requireHash(input.network_intent_sha256, "network_intent_sha256");
  return mutateJournal({ ...input, event: async (file) => {
    const last = file.events.at(-1);
    const now = input.now();
    if (!last || last.cell_id !== input.cell_id
      || (last.event_type !== "cell.intent_fsynced" && last.event_type !== "cell.resume_claimed")
      || last.owner_id !== input.owner_id
      || last.owner_token_sha256 !== input.owner_token_sha256) fail("network emission lacks current cell ownership");
    if (now.getTime() >= Date.parse(last.owner_expires_at)) fail("owner lease expired before network emission");
    const ledger = await inspectFilesystemBudgetLedger({ ledgerPath: file.plan.budget_ledger_path, now: input.now });
    if (ledger.paused || ledger.ledger_id !== file.plan.budget_ledger_id) fail("paused or changed budget ledger blocks network emission");
    return appendEvent(file, {
      occurred_at: now.toISOString(),
      event_type: "cell.network_emission_started",
      cell_id: input.cell_id,
      owner_id: input.owner_id,
      owner_token_sha256: input.owner_token_sha256,
      owner_expires_at: last.owner_expires_at,
      evidence_sha256: input.network_intent_sha256,
      budget_ledger_head_sha256: ledger.head_sha256,
    });
  }});
}

export async function completeLc4Cell(input: Readonly<{
  journal_path: string;
  expected_head_sha256: string;
  expected_plan: Lc4CellResumePlan;
  cell_id: string;
  owner_id: string;
  owner_token_sha256: string;
  cell_artifact_sha256: string;
  now: () => Date;
}>): Promise<Lc4CellResumeStatus> {
  requireHash(input.cell_artifact_sha256, "cell_artifact_sha256");
  return mutateJournal({ ...input, event: async (file) => {
    const last = file.events.at(-1);
    if (!last || last.cell_id !== input.cell_id || last.event_type !== "cell.network_emission_started"
      || last.owner_id !== input.owner_id || last.owner_token_sha256 !== input.owner_token_sha256) {
      fail("cell completion lacks the current network-admitted owner");
    }
    const ledger = await inspectFilesystemBudgetLedger({ ledgerPath: file.plan.budget_ledger_path, now: input.now });
    return appendEvent(file, {
      occurred_at: input.now().toISOString(),
      event_type: "cell.completed",
      cell_id: input.cell_id,
      owner_id: input.owner_id,
      owner_token_sha256: input.owner_token_sha256,
      owner_expires_at: last.owner_expires_at,
      evidence_sha256: input.cell_artifact_sha256,
      budget_ledger_head_sha256: ledger.head_sha256,
    });
  }});
}

export async function quarantineLc4CellAfterNetwork(input: Readonly<{
  journal_path: string;
  expected_head_sha256: string;
  expected_plan: Lc4CellResumePlan;
  cell_id: string;
  owner_id: string;
  owner_token_sha256: string;
  failure_evidence_sha256: string;
  now: () => Date;
}>): Promise<Lc4CellResumeStatus> {
  requireHash(input.failure_evidence_sha256, "failure_evidence_sha256");
  return mutateJournal({ ...input, event: async (file) => {
    const last = file.events.at(-1);
    if (!last || last.cell_id !== input.cell_id || last.event_type !== "cell.network_emission_started"
      || last.owner_id !== input.owner_id || last.owner_token_sha256 !== input.owner_token_sha256) {
      fail("only the current network-admitted cell can be quarantined");
    }
    const ledger = await inspectFilesystemBudgetLedger({ ledgerPath: file.plan.budget_ledger_path, now: input.now });
    return appendEvent(file, {
      occurred_at: input.now().toISOString(),
      event_type: "cell.ambiguous_quarantined",
      cell_id: input.cell_id,
      owner_id: input.owner_id,
      owner_token_sha256: input.owner_token_sha256,
      owner_expires_at: last.owner_expires_at,
      evidence_sha256: input.failure_evidence_sha256,
      budget_ledger_head_sha256: ledger.head_sha256,
    });
  }});
}

/**
 * Converts a network-admitted orphan observed by a later process into an
 * absorbing quarantine. It never reclaims or retries that cell.
 */
export async function quarantineLc4InterruptedNetworkCell(input: Readonly<{
  journal_path: string;
  expected_head_sha256: string;
  expected_plan: Lc4CellResumePlan;
  failure_evidence_sha256: string;
  now: () => Date;
}>): Promise<Lc4CellResumeStatus> {
  requireHash(input.failure_evidence_sha256, "failure_evidence_sha256");
  return mutateJournal({ ...input, event: async (file) => {
    const last = file.events.at(-1);
    if (!last || last.event_type !== "cell.network_emission_started") {
      fail("interrupted cell is not an unclosed network admission");
    }
    const ledger = await inspectFilesystemBudgetLedger({
      ledgerPath: file.plan.budget_ledger_path,
      now: input.now,
    });
    return appendEvent(file, {
      occurred_at: input.now().toISOString(),
      event_type: "cell.ambiguous_quarantined",
      cell_id: last.cell_id,
      owner_id: last.owner_id,
      owner_token_sha256: last.owner_token_sha256,
      owner_expires_at: last.owner_expires_at,
      evidence_sha256: input.failure_evidence_sha256,
      budget_ledger_head_sha256: ledger.head_sha256,
    });
  }});
}

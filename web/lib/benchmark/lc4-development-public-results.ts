import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import {
  assertLc4DevRunPackage,
  replayLc4DevBudgetEvidence,
  type Lc4DevBudgetEvidence,
  type Lc4DevRunLease,
  type Lc4DevRunPackage,
} from "./lc4-development-budget";
import { replayLc4DevAuthorityReport } from "./lc4-development-live-dependencies";
import {
  assertLc4DevLivePreflightArtifact,
  assertLc4DevLivePrepareArtifact,
  createLc4DevLiveReportArtifact,
  type Lc4DevAuthorityReportInput,
  type Lc4DevLivePreflightArtifact,
  type Lc4DevLivePrepareArtifact,
  type Lc4DevLiveReportArtifact,
  type Lc4DevLiveRunArtifact,
} from "./lc4-development-live-runner";
import { assertLc4DevOperatorAuthorizationDag, LC4_DEV_OPERATOR_FILENAMES } from "./lc4-development-operator-cli";

const HASH = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 1024 * 1024;
const PUBLIC_RESULT_DOMAIN = "harshas-amazing-call-center/lc4-dev-public-result/v1\n";

export const LC4_DEV_PUBLIC_RESULT_FILENAMES = Object.freeze({
  json: "HACC_LC4_DEV_PUBLIC_RESULT.json",
  markdown: "HACC_LC4_DEV_PUBLIC_RESULT.md",
});

export type Lc4DevPublicResultArtifact = Readonly<{
  schema_version: 1;
  artifact_type: "hacc_lc4_dev_public_result";
  protocol_id: "HACC-LC4-DEV-v1";
  evidence_class: "C3";
  study_role: "development_mechanism_evidence_only";
  efficacy_claim_eligible: false;
  confirmatory_reuse_permitted: false;
  interpretation: "C3 mechanism evidence only; not confirmatory provider efficacy evidence";
  execution: Readonly<{
    execution_id: string;
    source_commit: string;
    source_tree_sha256: string;
    started_at: string;
    completed_at: string;
    status: "completed" | "failed";
    planned_episodes: 6;
    episodes_started: number;
    episodes_completed: number;
    planned_opportunities: 360;
    opportunities_submitted: number;
    opportunities_completed: number;
    response_generations_completed: number;
    repair_playbacks: number;
    paid_retry_count: 0;
  }>;
  design: Readonly<{
    providers: readonly Readonly<{
      provider: "openai" | "gemini" | "xai";
      model: string;
      arms: readonly ["native", "hacc"];
      opportunities_per_episode: 60;
    }>[];
    matched_provider_pairs: 3;
    no_retry_after_paid_open: true;
  }>;
  evaluation: Readonly<{
    task_results_available: boolean;
    evidence_complete: boolean;
    execution_evidence_complete: boolean;
    authority_scoreability: Lc4DevLiveReportArtifact["authority_scoreability"];
    authority_passed: number | null;
    authority_evaluated: number | null;
    authority_evidence_invalid: number;
  }>;
  budget: Readonly<{
    maximum_total_micro_usd: number;
    conservative_settled_micro_usd: number;
    active_reservations_micro_usd: 0;
    reservations_terminal: boolean;
  }>;
  integrity: Readonly<{
    prepare_sha256: string;
    preflight_sha256: string;
    run_sha256: string;
    run_package_sha256: string;
    budget_evidence_sha256: string;
    budget_terminal_ledger_head_sha256: string;
    authority_replay_set_sha256: string | null;
    report_sha256: string;
  }>;
  privacy: Readonly<{
    contains_transcripts: false;
    contains_pcm_or_audio: false;
    contains_wire_payloads: false;
    contains_local_paths: false;
    contains_credential_or_key_identities: false;
  }>;
  limitations: readonly [
    "six development episodes are mechanism evidence, not an efficacy estimate",
    "authority scores are published only when the complete evidence DAG replays",
    "no Native-versus-HACC superiority claim is authorized by this artifact",
  ];
  public_result_sha256: string;
}>;

type AuthorityReplay = Lc4DevAuthorityReportInput & Readonly<{ errors?: readonly string[] }>;

export type Lc4DevPublicResultDependencies = Readonly<{
  replay_authority_report?: typeof replayLc4DevAuthorityReport;
  replay_budget_evidence?: typeof replayLc4DevBudgetEvidence;
}>;

type VerifiedEvidence = Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  preflight: Lc4DevLivePreflightArtifact;
  run: Lc4DevLiveRunArtifact;
  lease: Lc4DevRunLease;
  budget: Lc4DevBudgetEvidence;
  package: Lc4DevRunPackage;
  report: Lc4DevLiveReportArtifact;
  authority: AuthorityReplay;
}>;

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function absolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an absolute normalized path`);
  return path;
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function readBoundedJson<T>(path: string, label: string): Promise<T> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be one regular, non-linked file`);
  }
  if (metadata.size < 2 || metadata.size > MAX_JSON_BYTES) throw new Error(`${label} has an invalid size`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  }
}

function sourcePath(root: string, filename: string): string {
  return resolve(root, filename);
}

function assertWithinRoot(path: string, root: string, label: string): void {
  const relation = relative(root, path);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} must be contained by the immutable evidence root`);
  }
}

function assertReportBoundary(report: Lc4DevLiveReportArtifact): void {
  if (report.efficacy_claim_eligible !== false
    || report.interpretation !== "development mechanism evidence only; not confirmatory provider efficacy evidence") {
    throw new Error("LC4-DEV report crossed its mechanism-evidence claim boundary");
  }
}

export async function verifyLc4DevEvidenceRoot(
  evidenceRootInput: string,
  dependencies: Lc4DevPublicResultDependencies = {},
): Promise<VerifiedEvidence> {
  const evidenceRoot = absolute(evidenceRootInput, "LC4-DEV evidence root");
  await assertRealDirectory(evidenceRoot, "LC4-DEV evidence root");
  const [prepare, preflight, run, lease, budget, packageArtifact, storedReport] = await Promise.all([
    readBoundedJson<Lc4DevLivePrepareArtifact>(sourcePath(evidenceRoot, LC4_DEV_OPERATOR_FILENAMES.prepare), "LC4-DEV prepare artifact"),
    readBoundedJson<Lc4DevLivePreflightArtifact>(sourcePath(evidenceRoot, LC4_DEV_OPERATOR_FILENAMES.preflight), "LC4-DEV preflight artifact"),
    readBoundedJson<Lc4DevLiveRunArtifact>(sourcePath(evidenceRoot, LC4_DEV_OPERATOR_FILENAMES.run), "LC4-DEV run artifact"),
    readBoundedJson<Lc4DevRunLease>(sourcePath(evidenceRoot, LC4_DEV_OPERATOR_FILENAMES.budget_lease), "LC4-DEV budget lease"),
    readBoundedJson<Lc4DevBudgetEvidence>(sourcePath(evidenceRoot, LC4_DEV_OPERATOR_FILENAMES.budget_evidence), "LC4-DEV budget evidence"),
    readBoundedJson<Lc4DevRunPackage>(sourcePath(evidenceRoot, LC4_DEV_OPERATOR_FILENAMES.run_package), "LC4-DEV run package"),
    readBoundedJson<Lc4DevLiveReportArtifact>(sourcePath(evidenceRoot, LC4_DEV_OPERATOR_FILENAMES.report), "LC4-DEV report artifact"),
  ]);

  assertLc4DevLivePrepareArtifact(prepare);
  // Historical verification evaluates the signed preflight at its recorded
  // check time. Requiring it to remain unexpired would make durable results
  // unverifiable after the paid-call admission window closes.
  assertLc4DevLivePreflightArtifact(preflight, prepare, new Date(preflight.checked_at));
  assertLc4DevOperatorAuthorizationDag({
    preflight,
    expected_authority_public_key_fingerprint_sha256: preflight.authority_trust_root_sha256,
  });
  if (run.execution_id !== prepare.execution_id
    || run.prepare_sha256 !== prepare.prepare_sha256
    || run.preflight_sha256 !== preflight.preflight_sha256) {
    throw new Error("LC4-DEV public result run differs from its prepare/preflight custody chain");
  }

  const expectedLedgerPath = resolve(evidenceRoot, "budget", "lc4-dev-six-episode.jsonl");
  if (resolve(lease.ledger_path) !== expectedLedgerPath) {
    throw new Error("LC4-DEV budget lease points outside its immutable evidence root");
  }
  assertWithinRoot(lease.ledger_path, evidenceRoot, "LC4-DEV budget ledger");
  await (dependencies.replay_budget_evidence ?? replayLc4DevBudgetEvidence)({
    lease,
    binding: { prepare, preflight },
    evidence: budget,
  });
  assertLc4DevRunPackage({ package: packageArtifact, lease, evidence: budget, run });

  const casRoot = resolve(evidenceRoot, LC4_DEV_OPERATOR_FILENAMES.cas);
  await assertRealDirectory(casRoot, "LC4-DEV CAS root");
  const authority = await (dependencies.replay_authority_report ?? replayLc4DevAuthorityReport)({
    run,
    preflight,
    cas_root_dir: casRoot,
  });
  const expectedReport = createLc4DevLiveReportArtifact(run, authority, {
    run_package_sha256: packageArtifact.package_sha256,
    budget_lease_sha256: lease.lease_sha256,
    budget_evidence_sha256: budget.evidence_sha256,
    budget_terminal_ledger_head_sha256: budget.terminal_ledger_head_sha256,
    budget_replay_verified: true,
  });
  if (canonicalJson(storedReport) !== canonicalJson(expectedReport)) {
    throw new Error("LC4-DEV stored report does not reproduce from independently replayed evidence");
  }
  assertReportBoundary(storedReport);
  return freeze({ prepare, preflight, run, lease, budget, package: packageArtifact, report: storedReport, authority });
}

function safeModel(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(value)) throw new Error("LC4-DEV public model identifier is unsafe");
  return value;
}

export function createLc4DevPublicResultArtifact(evidence: VerifiedEvidence): Lc4DevPublicResultArtifact {
  const terminalReservations = evidence.budget.reservations.every((reservation) => reservation.status === "settled" || reservation.status === "cancelled");
  const publishable = evidence.run.status === "completed"
    && evidence.run.episodes_started === 6
    && evidence.run.episodes_completed === 6
    && evidence.run.opportunities_submitted === 360
    && evidence.run.opportunities_completed === 360
    && evidence.run.paid_retry_count === 0
    && evidence.report.completed === true
    && evidence.report.exact_six_episode_horizon === true
    && evidence.report.exact_opportunity_horizon === true
    && evidence.report.exact_playback_accounting === true
    && evidence.report.execution_evidence_complete === true
    && evidence.report.evidence_complete === true
    && evidence.report.task_results_available === true
    && evidence.report.budget_replay_verified === true
    && evidence.report.authority_scoreability === "scorable"
    && evidence.report.authority_evidence_invalid === 0
    && evidence.report.authority_evaluated === 6
    && evidence.report.authority_passed !== null
    && evidence.report.authority_replay_set_sha256 !== null
    && evidence.authority.status === "scorable"
    && evidence.authority.evidence_invalid === 0
    && evidence.authority.evaluated === 6
    && evidence.authority.passed !== null
    && evidence.authority.episode_replay_sha256s.length === 6
    && new Set(evidence.authority.episode_replay_sha256s).size === 6
    && evidence.authority.episode_replay_sha256s.every((digest) => HASH.test(digest))
    && (evidence.authority.errors?.length ?? 0) === 0
    && evidence.budget.active_reservations_micro_usd === 0
    && terminalReservations;
  if (!publishable) {
    throw new Error("LC4-DEV refuses to publish a C3 headline result unless the complete six-episode evidence, authority, and budget DAG replay cleanly");
  }
  const byProvider = (["openai", "gemini", "xai"] as const).map((provider) => {
    const episodes = evidence.prepare.episodes.filter((episode) => episode.provider === provider);
    if (episodes.length !== 2
      || new Set(episodes.map((episode) => episode.model)).size !== 1
      || canonicalJson(episodes.map((episode) => episode.arm).sort()) !== canonicalJson(["hacc", "native"])) {
      throw new Error(`LC4-DEV ${provider} public pair is incomplete or internally inconsistent`);
    }
    return Object.freeze({
      provider,
      model: safeModel(episodes[0]!.model),
      arms: Object.freeze(["native", "hacc"] as const),
      opportunities_per_episode: 60 as const,
    });
  });
  const body = {
    schema_version: 1 as const,
    artifact_type: "hacc_lc4_dev_public_result" as const,
    protocol_id: "HACC-LC4-DEV-v1" as const,
    evidence_class: "C3" as const,
    study_role: "development_mechanism_evidence_only" as const,
    efficacy_claim_eligible: false as const,
    confirmatory_reuse_permitted: false as const,
    interpretation: "C3 mechanism evidence only; not confirmatory provider efficacy evidence" as const,
    execution: Object.freeze({
      execution_id: evidence.run.execution_id,
      source_commit: evidence.prepare.source_commit,
      source_tree_sha256: evidence.prepare.source_tree_sha256,
      started_at: evidence.run.started_at,
      completed_at: evidence.run.completed_at,
      status: evidence.run.status,
      planned_episodes: 6 as const,
      episodes_started: evidence.run.episodes_started,
      episodes_completed: evidence.run.episodes_completed,
      planned_opportunities: 360 as const,
      opportunities_submitted: evidence.run.opportunities_submitted,
      opportunities_completed: evidence.run.opportunities_completed,
      response_generations_completed: evidence.run.response_generations_completed,
      repair_playbacks: evidence.run.repair_playbacks,
      paid_retry_count: evidence.run.paid_retry_count,
    }),
    design: Object.freeze({
      providers: Object.freeze(byProvider),
      matched_provider_pairs: 3 as const,
      no_retry_after_paid_open: true as const,
    }),
    evaluation: Object.freeze({
      task_results_available: evidence.report.task_results_available,
      evidence_complete: evidence.report.evidence_complete,
      execution_evidence_complete: evidence.report.execution_evidence_complete,
      authority_scoreability: evidence.report.authority_scoreability,
      authority_passed: evidence.report.authority_passed,
      authority_evaluated: evidence.report.authority_evaluated,
      authority_evidence_invalid: evidence.report.authority_evidence_invalid,
    }),
    budget: Object.freeze({
      maximum_total_micro_usd: evidence.budget.maximum_total_micro_usd,
      conservative_settled_micro_usd: evidence.budget.conservative_settled_micro_usd,
      active_reservations_micro_usd: evidence.budget.active_reservations_micro_usd,
      reservations_terminal: terminalReservations,
    }),
    integrity: Object.freeze({
      prepare_sha256: evidence.prepare.prepare_sha256,
      preflight_sha256: evidence.preflight.preflight_sha256,
      run_sha256: evidence.run.run_sha256,
      run_package_sha256: evidence.package.package_sha256,
      budget_evidence_sha256: evidence.budget.evidence_sha256,
      budget_terminal_ledger_head_sha256: evidence.budget.terminal_ledger_head_sha256,
      authority_replay_set_sha256: evidence.report.authority_replay_set_sha256,
      report_sha256: evidence.report.report_sha256,
    }),
    privacy: Object.freeze({
      contains_transcripts: false as const,
      contains_pcm_or_audio: false as const,
      contains_wire_payloads: false as const,
      contains_local_paths: false as const,
      contains_credential_or_key_identities: false as const,
    }),
    limitations: Object.freeze([
      "six development episodes are mechanism evidence, not an efficacy estimate",
      "authority scores are published only when the complete evidence DAG replays",
      "no Native-versus-HACC superiority claim is authorized by this artifact",
    ] as const),
  };
  return freeze({ ...body, public_result_sha256: sha256Hex(`${PUBLIC_RESULT_DOMAIN}${canonicalJson(body)}`) });
}

function value(value: number | null): string {
  return value === null ? "Not published" : String(value);
}

export function renderLc4DevPublicResultMarkdown(result: Lc4DevPublicResultArtifact): string {
  assertLc4DevPublicResultArtifact(result);
  const providers = result.design.providers.map((entry) => `| ${entry.provider} | ${entry.model} | Native + HACC | 60 each |`).join("\n");
  return `# HACC LC4-DEV public result\n\n` +
    `C3 mechanism evidence only. This artifact is not confirmatory provider-efficacy evidence and does not authorize a Native-versus-HACC superiority claim.\n\n` +
    `## Result\n\n` +
    `| Measure | Value |\n|---|---:|\n` +
    `| Run status | ${result.execution.status} |\n` +
    `| Episodes completed | ${result.execution.episodes_completed} / ${result.execution.planned_episodes} |\n` +
    `| Opportunities completed | ${result.execution.opportunities_completed} / ${result.execution.planned_opportunities} |\n` +
    `| Authority scoreability | ${result.evaluation.authority_scoreability} |\n` +
    `| Authority passed | ${value(result.evaluation.authority_passed)} |\n` +
    `| Authority evaluated | ${value(result.evaluation.authority_evaluated)} |\n` +
    `| Evidence complete | ${result.evaluation.evidence_complete} |\n` +
    `| Paid retries | ${result.execution.paid_retry_count} |\n` +
    `| Conservative ledger liability | $${(result.budget.conservative_settled_micro_usd / 1_000_000).toFixed(6)} |\n\n` +
    `## Matched development design\n\n` +
    `| Provider | Realtime model | Arms | Opportunities |\n|---|---|---|---:|\n${providers}\n\n` +
    `## Reproducibility\n\n` +
    `- Source commit: \`${result.execution.source_commit}\`\n` +
    `- Run package: \`${result.integrity.run_package_sha256}\`\n` +
    `- Verified report: \`${result.integrity.report_sha256}\`\n` +
    `- Public result: \`${result.public_result_sha256}\`\n\n` +
    `The public files intentionally exclude transcripts, PCM/audio, wire payloads, local paths, and credential or signing-key identities.\n`;
}

function inspectPublicValue(value: unknown, key = "root"): void {
  if (typeof value === "string") {
    if (value.startsWith("/") || /^file:\/\//u.test(value) || /^[A-Za-z]:[\\/]/u.test(value)) {
      throw new Error(`LC4-DEV public result contains a local path at ${key}`);
    }
    if (/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{12,})\b/u.test(value)) {
      throw new Error(`LC4-DEV public result contains a credential-shaped value at ${key}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectPublicValue(entry, `${key}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      const negativePrivacyDeclaration = childKey.startsWith("contains_") && child === false;
      if (!negativePrivacyDeclaration
        && /(?:transcript|pcm|wire|(?:^|_)path(?:_|$)|credential|signature|authorization|nonce|fingerprint|(?:^|_)key(?:_|$))/iu.test(childKey)) {
        throw new Error(`LC4-DEV public result contains forbidden field ${childKey}`);
      }
      inspectPublicValue(child, `${key}.${childKey}`);
    }
  }
}

export function assertLc4DevPublicResultArtifact(result: Lc4DevPublicResultArtifact): void {
  const { public_result_sha256: claimed, ...body } = result;
  if (!HASH.test(claimed) || sha256Hex(`${PUBLIC_RESULT_DOMAIN}${canonicalJson(body)}`) !== claimed) {
    throw new Error("LC4-DEV public result hash mismatch");
  }
  if (result.schema_version !== 1
    || result.artifact_type !== "hacc_lc4_dev_public_result"
    || result.protocol_id !== "HACC-LC4-DEV-v1"
    || result.evidence_class !== "C3"
    || result.study_role !== "development_mechanism_evidence_only"
    || result.efficacy_claim_eligible !== false
    || result.confirmatory_reuse_permitted !== false
    || result.design.providers.length !== 3
    || result.design.matched_provider_pairs !== 3
    || result.execution.planned_episodes !== 6
    || result.execution.planned_opportunities !== 360
    || result.execution.paid_retry_count !== 0
    || result.execution.status !== "completed"
    || result.execution.episodes_completed !== 6
    || result.execution.opportunities_completed !== 360
    || result.evaluation.task_results_available !== true
    || result.evaluation.evidence_complete !== true
    || result.evaluation.execution_evidence_complete !== true
    || result.evaluation.authority_scoreability !== "scorable"
    || result.evaluation.authority_evidence_invalid !== 0
    || result.evaluation.authority_evaluated !== 6
    || result.evaluation.authority_passed === null
    || result.budget.active_reservations_micro_usd !== 0
    || result.budget.reservations_terminal !== true) {
    throw new Error("LC4-DEV public result claim boundary or frozen design drifted");
  }
  inspectPublicValue(result);
}

async function absent(path: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
    throw new Error("LC4-DEV public output already exists; overwrite is forbidden");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function publishPair(outputRoot: string, json: string, markdown: string): Promise<void> {
  await mkdir(outputRoot, { recursive: true, mode: 0o755 });
  await assertRealDirectory(outputRoot, "LC4-DEV public output root");
  const jsonPath = resolve(outputRoot, LC4_DEV_PUBLIC_RESULT_FILENAMES.json);
  const markdownPath = resolve(outputRoot, LC4_DEV_PUBLIC_RESULT_FILENAMES.markdown);
  await Promise.all([absent(jsonPath), absent(markdownPath)]);
  const nonce = sha256Hex(`${json}\n${markdown}`);
  const jsonTemp = resolve(dirname(jsonPath), `.${LC4_DEV_PUBLIC_RESULT_FILENAMES.json}.${nonce}.tmp`);
  const markdownTemp = resolve(dirname(markdownPath), `.${LC4_DEV_PUBLIC_RESULT_FILENAMES.markdown}.${nonce}.tmp`);
  await Promise.all([
    writeFile(jsonTemp, json, { flag: "wx", mode: 0o444 }),
    writeFile(markdownTemp, markdown, { flag: "wx", mode: 0o444 }),
  ]);
  try {
    await link(jsonTemp, jsonPath);
    try {
      await link(markdownTemp, markdownPath);
    } catch (error) {
      await unlink(jsonPath).catch(() => undefined);
      throw error;
    }
    await Promise.all([chmod(jsonPath, 0o444), chmod(markdownPath, 0o444)]);
  } finally {
    await Promise.all([unlink(jsonTemp).catch(() => undefined), unlink(markdownTemp).catch(() => undefined)]);
  }
}

export async function publishLc4DevPublicResult(input: Readonly<{
  evidence_root: string;
  output_root: string;
  dependencies?: Lc4DevPublicResultDependencies;
}>): Promise<Lc4DevPublicResultArtifact> {
  const outputRoot = absolute(input.output_root, "LC4-DEV public output root");
  const verified = await verifyLc4DevEvidenceRoot(input.evidence_root, input.dependencies);
  const result = createLc4DevPublicResultArtifact(verified);
  const json = `${canonicalJson(result)}\n`;
  const markdown = renderLc4DevPublicResultMarkdown(result);
  await publishPair(outputRoot, json, markdown);
  return result;
}

export async function verifyLc4DevPublicResult(input: Readonly<{
  evidence_root: string;
  public_json: string;
  public_markdown: string;
  dependencies?: Lc4DevPublicResultDependencies;
}>): Promise<Lc4DevPublicResultArtifact> {
  const publicJsonPath = absolute(input.public_json, "LC4-DEV public JSON");
  const publicMarkdownPath = absolute(input.public_markdown, "LC4-DEV public Markdown");
  const [verified, published, markdownMetadata] = await Promise.all([
    verifyLc4DevEvidenceRoot(input.evidence_root, input.dependencies),
    readBoundedJson<Lc4DevPublicResultArtifact>(publicJsonPath, "LC4-DEV public JSON"),
    lstat(publicMarkdownPath),
  ]);
  if (!markdownMetadata.isFile() || markdownMetadata.isSymbolicLink() || markdownMetadata.nlink !== 1
    || markdownMetadata.size < 2 || markdownMetadata.size > MAX_MARKDOWN_BYTES) {
    throw new Error("LC4-DEV public Markdown must be one bounded regular, non-linked file");
  }
  assertLc4DevPublicResultArtifact(published);
  const expected = createLc4DevPublicResultArtifact(verified);
  if (canonicalJson(published) !== canonicalJson(expected)) {
    throw new Error("LC4-DEV public JSON does not reproduce from the immutable evidence root");
  }
  const markdown = await readFile(publicMarkdownPath, "utf8");
  if (markdown !== renderLc4DevPublicResultMarkdown(expected)) {
    throw new Error("LC4-DEV public Markdown does not reproduce from the verified public JSON");
  }
  return expected;
}

import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
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
import {
  assertLc4PublicationTransportProvenance,
  verifyLc4PublicationTransportProvenance,
  type Lc4PublicationGateDInput,
  type Lc4PublicationTransportProvenance,
} from "./lc4-publication-transport-provenance";
import {
  replayLc4PublicationTransportEvidence,
  type Lc4PublicationTransportReplay,
} from "./lc4-publication-transport-replay";

const HASH = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 1024 * 1024;
const PUBLIC_RESULT_DOMAIN = "harshas-amazing-call-center/lc4-dev-public-result/v4\n";

export const LC4_DEV_PUBLIC_RESULT_FILENAMES = Object.freeze({
  json: "HACC_LC4_DEV_PUBLIC_RESULT.json",
  markdown: "HACC_LC4_DEV_PUBLIC_RESULT.md",
});

export type Lc4DevPublicResultArtifact = Readonly<{
  schema_version: 4;
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
    cells: Lc4PublicationTransportProvenance["cells"];
  }>;
  qualification: Omit<Lc4PublicationTransportProvenance, "cells">;
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
    contains_private_credential_or_signing_key_material: false;
    contains_public_authority_trust_root: true;
    contains_provider_session_ids: false;
    contains_gate_d_receipt_path_or_trust_root: false;
  }>;
  limitations: readonly [
    "six development episodes are mechanism evidence, not an efficacy estimate",
    "authority scores are published only when the complete evidence DAG replays",
    "the Registered Native comparator is Native realtime API + common benchmark continuity; no HACC superiority claim is authorized",
    "listener authority trust must come from a trusted release tag or announcement independent of these public result files",
  ];
  public_result_sha256: string;
}>;

type AuthorityReplay = Lc4DevAuthorityReportInput & Readonly<{ errors?: readonly string[] }>;

type Lc4DevEvidenceReplayDependencies = Readonly<{
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
  transport_replay: Lc4PublicationTransportReplay;
}>;

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) {
    throw new Error(`${label} must be one lowercase SHA-256`);
  }
}

function absolute(path: string, label: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return path;
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function readBoundedJson<T>(path: string, label: string): Promise<T> {
  const encoded = await readBoundedRegularFile(
    path,
    label,
    MAX_JSON_BYTES,
  );
  try {
    return JSON.parse(encoded) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  }
}

async function readBoundedRegularFile(
  path: string,
  label: string,
  maximumBytes: number,
): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(`${label} must be one bounded regular, non-linked file`);
  }
  try {
    const [descriptorBefore, pathBefore] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    const safe = (descriptor: typeof descriptorBefore, pathMetadata: typeof pathBefore): boolean =>
      descriptor.isFile()
      && pathMetadata.isFile()
      && !pathMetadata.isSymbolicLink()
      && descriptor.dev === pathMetadata.dev
      && descriptor.ino === pathMetadata.ino
      && descriptor.nlink === BigInt(1)
      && pathMetadata.nlink === BigInt(1)
      && descriptor.size >= BigInt(2)
      && descriptor.size <= BigInt(maximumBytes)
      && pathMetadata.size === descriptor.size;
    if (!safe(descriptorBefore, pathBefore)) {
      throw new Error(`${label} must be one bounded regular, non-linked file`);
    }
    const expectedBytes = Number(descriptorBefore.size);
    const bytes = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const result = await handle.read(
        bytes,
        offset,
        expectedBytes - offset,
        offset,
      );
      if (result.bytesRead <= 0) {
        throw new Error(`${label} changed while it was being read`);
      }
      offset += result.bytesRead;
    }
    const overflow = await handle.read(
      Buffer.allocUnsafe(1),
      0,
      1,
      expectedBytes,
    );
    const [descriptorAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (overflow.bytesRead !== 0
      || !safe(descriptorAfter, pathAfter)
      || descriptorAfter.dev !== descriptorBefore.dev
      || descriptorAfter.ino !== descriptorBefore.ino
      || descriptorAfter.size !== descriptorBefore.size
      || descriptorAfter.mtimeNs !== descriptorBefore.mtimeNs
      || descriptorAfter.ctimeNs !== descriptorBefore.ctimeNs) {
      throw new Error(`${label} changed while it was being read`);
    }
    return bytes.toString("utf8");
  } finally {
    await handle.close();
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

async function verifyLc4DevEvidenceRootWithDependencies(
  evidenceRootInput: string,
  authorityTrustRootSha256: string,
  dependencies: Lc4DevEvidenceReplayDependencies,
): Promise<VerifiedEvidence> {
  requireHash(
    authorityTrustRootSha256,
    "LC4-DEV external authority trust root",
  );
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
    expected_authority_public_key_fingerprint_sha256:
      authorityTrustRootSha256,
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
  const [authority, transportReplay] = await Promise.all([
    (dependencies.replay_authority_report ?? replayLc4DevAuthorityReport)({
      run,
      preflight,
      cas_root_dir: casRoot,
    }),
    replayLc4PublicationTransportEvidence({
      prepare,
      preflight,
      run,
      cas_root_dir: casRoot,
      expected_authority_trust_root_sha256:
        authorityTrustRootSha256,
    }),
  ]);
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
  return freeze({
    prepare,
    preflight,
    run,
    lease,
    budget,
    package: packageArtifact,
    report: storedReport,
    authority,
    transport_replay: transportReplay,
  });
}

/**
 * Replays the complete on-disk evidence DAG with the production verifiers.
 *
 * Publication code must use this function. In particular, it deliberately has
 * no dependency-injection seam: a caller cannot substitute a successful
 * budget or authority replay for the retained evidence.
 */
export async function verifyLc4DevEvidenceRoot(
  input: Readonly<{
    evidence_root: string;
    authority_trust_root_sha256: string;
  }>,
): Promise<VerifiedEvidence> {
  return verifyLc4DevEvidenceRootWithDependencies(
    input.evidence_root,
    input.authority_trust_root_sha256,
    Object.freeze({}),
  );
}

/**
 * Unsafe unit-test seam. It is intentionally not used by either publication
 * CLI and must never be wired into a release/export path.
 */
export async function unsafeVerifyLc4DevEvidenceRootForTestsOnly(
  evidenceRootInput: string,
  authorityTrustRootSha256: string,
  dependencies: Lc4DevEvidenceReplayDependencies,
): Promise<VerifiedEvidence> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("unsafe LC4 evidence replay dependencies are test-only");
  }
  return verifyLc4DevEvidenceRootWithDependencies(
    evidenceRootInput,
    authorityTrustRootSha256,
    dependencies,
  );
}

function safeModel(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(value)) throw new Error("LC4-DEV public model identifier is unsafe");
  return value;
}

export function createLc4DevPublicResultArtifact(
  evidence: VerifiedEvidence,
  transportProvenance: Lc4PublicationTransportProvenance,
): Lc4DevPublicResultArtifact {
  assertLc4PublicationTransportProvenance(transportProvenance);
  if (transportProvenance.development_transport_run_sha256
      !== evidence.run.run_sha256
    || transportProvenance.development_transport_replay_sha256
      !== evidence.transport_replay.replay_sha256
    || transportProvenance.canonical_provider_exchange_count
      !== evidence.transport_replay.canonical_provider_exchange_count
    || transportProvenance.repair_provider_exchange_count
      !== evidence.transport_replay.repair_provider_exchange_count
    || transportProvenance.total_response_generation_count
      !== evidence.transport_replay.total_response_generation_count
    || transportProvenance.repair_provider_exchange_count
      !== evidence.run.repair_playbacks
    || transportProvenance.total_response_generation_count
      !== evidence.run.response_generations_completed) {
    throw new Error(
      "LC4-DEV public transport provenance differs from the exact replayed run evidence",
    );
  }
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
    const transportCells = transportProvenance.cells.filter((cell) =>
      cell.provider === provider);
    if (episodes.length !== 2
      || new Set(episodes.map((episode) => episode.model)).size !== 1
      || canonicalJson(episodes.map((episode) => episode.arm).sort()) !== canonicalJson(["hacc", "native"])
      || transportCells.length !== 2
      || canonicalJson(transportCells.map((cell) => cell.arm).sort())
        !== canonicalJson(["hacc", "native"])) {
      throw new Error(`LC4-DEV ${provider} public pair is incomplete or internally inconsistent`);
    }
    const model = safeModel(episodes[0]!.model);
    if (transportCells.some((cell) => cell.model !== model)) {
      throw new Error(`LC4-DEV ${provider} public pair is incomplete or internally inconsistent`);
    }
    return Object.freeze({
      provider,
      model,
      arms: Object.freeze(["native", "hacc"] as const),
      opportunities_per_episode: 60 as const,
    });
  });
  const body = {
    schema_version: 4 as const,
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
      cells: transportProvenance.cells,
    }),
    qualification: Object.freeze({
      schema_version: transportProvenance.schema_version,
      provider_profile_manifest_sha256:
        transportProvenance.provider_profile_manifest_sha256,
      development_transport_run_sha256:
        transportProvenance.development_transport_run_sha256,
      development_transport_replay_sha256:
        transportProvenance.development_transport_replay_sha256,
      canonical_provider_exchange_count:
        transportProvenance.canonical_provider_exchange_count,
      repair_provider_exchange_count:
        transportProvenance.repair_provider_exchange_count,
      total_response_generation_count:
        transportProvenance.total_response_generation_count,
      canonical_exchange_replay_set_sha256:
        transportProvenance.canonical_exchange_replay_set_sha256,
      response_generation_replay_set_sha256:
        transportProvenance.response_generation_replay_set_sha256,
      listener_authority_trust_root_sha256:
        transportProvenance.listener_authority_trust_root_sha256,
      listener_authority_replay_set_sha256:
        transportProvenance.listener_authority_replay_set_sha256,
      listener_invocation_replay_set_sha256:
        transportProvenance.listener_invocation_replay_set_sha256,
      retained_gate_b_transport_scope_sha256:
        transportProvenance.retained_gate_b_transport_scope_sha256,
      retained_gate_b_receipt_sha256:
        transportProvenance.retained_gate_b_receipt_sha256,
      retained_gate_b_claim_boundary:
        transportProvenance.retained_gate_b_claim_boundary,
      xai_finite_manual_transport_qualification:
        transportProvenance.xai_finite_manual_transport_qualification,
      xai_finite_manual_gate_d_receipt_sha256:
        transportProvenance.xai_finite_manual_gate_d_receipt_sha256,
      xai_finite_manual_transport_profile_sha256:
        transportProvenance.xai_finite_manual_transport_profile_sha256,
      xai_finite_manual_claim_boundary:
        transportProvenance.xai_finite_manual_claim_boundary,
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
      contains_private_credential_or_signing_key_material: false as const,
      contains_public_authority_trust_root: true as const,
      contains_provider_session_ids: false as const,
      contains_gate_d_receipt_path_or_trust_root: false as const,
    }),
    limitations: Object.freeze([
      "six development episodes are mechanism evidence, not an efficacy estimate",
      "authority scores are published only when the complete evidence DAG replays",
      "the Registered Native comparator is Native realtime API + common benchmark continuity; no HACC superiority claim is authorized",
      "listener authority trust must come from a trusted release tag or announcement independent of these public result files",
    ] as const),
  };
  return freeze({ ...body, public_result_sha256: sha256Hex(`${PUBLIC_RESULT_DOMAIN}${canonicalJson(body)}`) });
}

function value(value: number | null): string {
  return value === null ? "Not published" : String(value);
}

export function renderLc4DevPublicResultMarkdown(result: Lc4DevPublicResultArtifact): string {
  assertLc4DevPublicResultArtifact(result);
  const providers = result.design.providers.map((entry) => `| ${entry.provider} | ${entry.model} | Registered Native comparator + HACC | 60 each |`).join("\n");
  const transports = result.design.cells.map((entry) =>
    `| ${entry.provider} | ${entry.model} | ${entry.arm === "hacc" ? "HACC" : "Registered Native comparator"} | ${entry.transport_purpose ?? "not_applicable"} | ${entry.turn_boundary_control} | ${entry.wire_turn_boundary} | ${entry.output_audio_lineage_scope} | ${entry.model_identity_verification} | ${entry.qualification_scope} | \`${entry.transport_profile_sha256}\` |`
  ).join("\n");
  return `# HACC LC4-DEV public result\n\n` +
    `C3 mechanism evidence only. Registered Native comparator means Native realtime API + common benchmark continuity; it is not a bare model/API baseline or consumer ChatGPT Voice. This artifact is not confirmatory provider-efficacy evidence and does not authorize a HACC superiority claim. Its 360 opportunities are repeated within six calls, not 360 independent trials.\n\n` +
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
    `## Transport and qualification provenance\n\n` +
    `| Provider | Model | Arm | Purpose | Boundary control | Wire turn boundary | Output audio lineage | Model identity | Qualification scope | Profile SHA-256 |\n|---|---|---|---|---|---|---|---|---|---|\n${transports}\n\n` +
    `The xAI finite prerecorded manual-commit transport has a separately verified Gate D receipt. Gate D is transport qualification only and is not efficacy evidence.\n\n` +
    `## Reproducibility\n\n` +
    `- Listener authority trust root: \`${result.qualification.listener_authority_trust_root_sha256}\`\n` +
    `- Listener authority replay set: \`${result.qualification.listener_authority_replay_set_sha256}\`\n` +
    `- Listener invocation replay set: \`${result.qualification.listener_invocation_replay_set_sha256}\`\n` +
    `- Response-generation replay set: \`${result.qualification.response_generation_replay_set_sha256}\`\n` +
    `- Response generations: ${result.qualification.total_response_generation_count} (${result.qualification.canonical_provider_exchange_count} canonical + ${result.qualification.repair_provider_exchange_count} registered repair)\n` +
    `- Source commit: \`${result.execution.source_commit}\`\n` +
    `- Run package: \`${result.integrity.run_package_sha256}\`\n` +
    `- Verified report: \`${result.integrity.report_sha256}\`\n` +
    `- Public result: \`${result.public_result_sha256}\`\n\n` +
    `The listener authority root printed above is a reproducibility commitment, not a trust bootstrap. Verifiers must supply the expected root independently from a trusted signed release tag or release announcement; using this JSON or Markdown as its own expected root is forbidden.\n\n` +
    `The public files intentionally exclude transcripts, PCM/audio, wire payloads, local paths, private credentials, and signing-key material. They publish only the independently supplied authority trust-root digest needed to reproduce verification.\n`;
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
      const publicTransportDescriptor = childKey === "wire_turn_boundary";
      if (!negativePrivacyDeclaration
        && !publicTransportDescriptor
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
  const transportProvenance = {
    ...result.qualification,
    cells: result.design.cells,
  } as Lc4PublicationTransportProvenance;
  assertLc4PublicationTransportProvenance(transportProvenance);
  const exactKeys = (candidate: object, expected: readonly string[]) =>
    canonicalJson(Object.keys(candidate).sort())
      === canonicalJson([...expected].sort());
  const exactProviderKeys = ["provider", "model", "arms", "opportunities_per_episode"] as const;
  const exactIntegrityKeys = [
    "prepare_sha256",
    "preflight_sha256",
    "run_sha256",
    "run_package_sha256",
    "budget_evidence_sha256",
    "budget_terminal_ledger_head_sha256",
    "authority_replay_set_sha256",
    "report_sha256",
  ] as const;
  if (result.schema_version !== 4
    || result.artifact_type !== "hacc_lc4_dev_public_result"
    || result.protocol_id !== "HACC-LC4-DEV-v1"
    || result.evidence_class !== "C3"
    || result.study_role !== "development_mechanism_evidence_only"
    || result.efficacy_claim_eligible !== false
    || result.confirmatory_reuse_permitted !== false
    || result.interpretation
      !== "C3 mechanism evidence only; not confirmatory provider efficacy evidence"
    || !exactKeys(result, [
      "schema_version",
      "artifact_type",
      "protocol_id",
      "evidence_class",
      "study_role",
      "efficacy_claim_eligible",
      "confirmatory_reuse_permitted",
      "interpretation",
      "execution",
      "design",
      "qualification",
      "evaluation",
      "budget",
      "integrity",
      "privacy",
      "limitations",
      "public_result_sha256",
    ])
    || !exactKeys(result.execution, [
      "execution_id",
      "source_commit",
      "source_tree_sha256",
      "started_at",
      "completed_at",
      "status",
      "planned_episodes",
      "episodes_started",
      "episodes_completed",
      "planned_opportunities",
      "opportunities_submitted",
      "opportunities_completed",
      "response_generations_completed",
      "repair_playbacks",
      "paid_retry_count",
    ])
    || !/^[a-f0-9]{40}$/u.test(result.execution.source_commit)
    || !HASH.test(result.execution.source_tree_sha256)
    || !Number.isFinite(Date.parse(result.execution.started_at))
    || !Number.isFinite(Date.parse(result.execution.completed_at))
    || !exactKeys(result.design, [
      "providers",
      "matched_provider_pairs",
      "no_retry_after_paid_open",
      "cells",
    ])
    || result.design.providers.length !== 3
    || canonicalJson(result.design.providers.map((entry) =>
      entry.provider).sort()) !== canonicalJson(["gemini", "openai", "xai"])
    || result.design.providers.some((entry) =>
      !exactKeys(entry, exactProviderKeys)
      || safeModel(entry.model) !== entry.model
      || canonicalJson(entry.arms) !== canonicalJson(["native", "hacc"])
      || entry.opportunities_per_episode !== 60
      || result.design.cells.filter((cell) =>
        cell.provider === entry.provider).length !== 2
      || result.design.cells.filter((cell) =>
        cell.provider === entry.provider).some((cell) =>
        cell.model !== entry.model))
    || result.design.cells.length !== 6
    || result.design.matched_provider_pairs !== 3
    || result.design.no_retry_after_paid_open !== true
    || result.execution.planned_episodes !== 6
    || result.execution.planned_opportunities !== 360
    || result.execution.paid_retry_count !== 0
    || result.execution.status !== "completed"
    || result.execution.episodes_started !== 6
    || result.execution.episodes_completed !== 6
    || result.execution.opportunities_submitted !== 360
    || result.execution.opportunities_completed !== 360
    || !Number.isSafeInteger(result.execution.response_generations_completed)
    || result.execution.response_generations_completed < 360
    || !Number.isSafeInteger(result.execution.repair_playbacks)
    || result.execution.repair_playbacks < 0
    || !exactKeys(result.evaluation, [
      "task_results_available",
      "evidence_complete",
      "execution_evidence_complete",
      "authority_scoreability",
      "authority_passed",
      "authority_evaluated",
      "authority_evidence_invalid",
    ])
    || result.evaluation.task_results_available !== true
    || result.evaluation.evidence_complete !== true
    || result.evaluation.execution_evidence_complete !== true
    || result.evaluation.authority_scoreability !== "scorable"
    || result.evaluation.authority_evidence_invalid !== 0
    || result.evaluation.authority_evaluated !== 6
    || result.evaluation.authority_passed === null
    || !Number.isSafeInteger(result.evaluation.authority_passed)
    || result.evaluation.authority_passed < 0
    || result.evaluation.authority_passed > result.evaluation.authority_evaluated
    || !exactKeys(result.budget, [
      "maximum_total_micro_usd",
      "conservative_settled_micro_usd",
      "active_reservations_micro_usd",
      "reservations_terminal",
    ])
    || !Number.isSafeInteger(result.budget.maximum_total_micro_usd)
    || result.budget.maximum_total_micro_usd <= 0
    || !Number.isSafeInteger(result.budget.conservative_settled_micro_usd)
    || result.budget.conservative_settled_micro_usd < 0
    || result.budget.active_reservations_micro_usd !== 0
    || result.budget.reservations_terminal !== true
    || !exactKeys(result.integrity, exactIntegrityKeys)
    || Object.values(result.integrity).some((digest) =>
      digest === null || !HASH.test(digest))
    || canonicalJson(result.privacy) !== canonicalJson({
      contains_transcripts: false,
      contains_pcm_or_audio: false,
      contains_wire_payloads: false,
      contains_local_paths: false,
      contains_private_credential_or_signing_key_material: false,
      contains_public_authority_trust_root: true,
      contains_provider_session_ids: false,
      contains_gate_d_receipt_path_or_trust_root: false,
    })
    || canonicalJson(result.limitations) !== canonicalJson([
      "six development episodes are mechanism evidence, not an efficacy estimate",
      "authority scores are published only when the complete evidence DAG replays",
      "the Registered Native comparator is Native realtime API + common benchmark continuity; no HACC superiority claim is authorized",
      "listener authority trust must come from a trusted release tag or announcement independent of these public result files",
    ])) {
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
  authority_trust_root_sha256: string;
  xai_finite_manual_gate_d: Lc4PublicationGateDInput;
}>): Promise<Lc4DevPublicResultArtifact> {
  const outputRoot = absolute(input.output_root, "LC4-DEV public output root");
  const verified = await verifyLc4DevEvidenceRoot({
    evidence_root: input.evidence_root,
    authority_trust_root_sha256: input.authority_trust_root_sha256,
  });
  const transportProvenance = await verifyLc4PublicationTransportProvenance({
    prepare: verified.prepare,
    preflight: verified.preflight,
    run_sha256: verified.run.run_sha256,
    authority_trust_root_sha256: input.authority_trust_root_sha256,
    transport_replay: verified.transport_replay,
    gate_d: input.xai_finite_manual_gate_d,
  });
  const result = createLc4DevPublicResultArtifact(verified, transportProvenance);
  const json = `${canonicalJson(result)}\n`;
  const markdown = renderLc4DevPublicResultMarkdown(result);
  await publishPair(outputRoot, json, markdown);
  return result;
}

export async function verifyLc4DevPublicResult(input: Readonly<{
  evidence_root: string;
  public_json: string;
  public_markdown: string;
  authority_trust_root_sha256: string;
  xai_finite_manual_gate_d: Lc4PublicationGateDInput;
}>): Promise<Lc4DevPublicResultArtifact> {
  const publicJsonPath = absolute(input.public_json, "LC4-DEV public JSON");
  const publicMarkdownPath = absolute(input.public_markdown, "LC4-DEV public Markdown");
  const [verified, published, markdown] = await Promise.all([
    verifyLc4DevEvidenceRoot({
      evidence_root: input.evidence_root,
      authority_trust_root_sha256: input.authority_trust_root_sha256,
    }),
    readBoundedJson<Lc4DevPublicResultArtifact>(publicJsonPath, "LC4-DEV public JSON"),
    readBoundedRegularFile(
      publicMarkdownPath,
      "LC4-DEV public Markdown",
      MAX_MARKDOWN_BYTES,
    ),
  ]);
  assertLc4DevPublicResultArtifact(published);
  const transportProvenance = await verifyLc4PublicationTransportProvenance({
    prepare: verified.prepare,
    preflight: verified.preflight,
    run_sha256: verified.run.run_sha256,
    authority_trust_root_sha256: input.authority_trust_root_sha256,
    transport_replay: verified.transport_replay,
    gate_d: input.xai_finite_manual_gate_d,
  });
  const expected = createLc4DevPublicResultArtifact(verified, transportProvenance);
  if (canonicalJson(published) !== canonicalJson(expected)) {
    throw new Error("LC4-DEV public JSON does not reproduce from the immutable evidence root");
  }
  if (markdown !== renderLc4DevPublicResultMarkdown(expected)) {
    throw new Error("LC4-DEV public Markdown does not reproduce from the verified public JSON");
  }
  return expected;
}

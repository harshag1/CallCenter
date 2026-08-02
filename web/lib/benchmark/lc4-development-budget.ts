import { lstat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalJson, sha256Hex } from "./artifacts";
import {
  cancelFilesystemBudgetBeforeOpen,
  initializeFilesystemBudgetLedger,
  inspectFilesystemBudgetLedger,
  markBudgetConnectionIntent,
  markBudgetSessionOpened,
  recordBudgetTerminal,
  recordFilesystemBudgetUsage,
  reserveFilesystemBudget,
  settleFilesystemBudget,
  type BudgetCostEnvelope,
  type BudgetJournalSnapshot,
  type Lc4DevSixEpisodePlanConsumption,
} from "./filesystem-budget-ledger";
import type {
  Lc4DevLiveEpisodePlan,
  Lc4DevLivePreflightArtifact,
  Lc4DevLivePrepareArtifact,
  Lc4DevLiveRunArtifact,
} from "./lc4-development-live-runner";
import type { Lc4CellResumeCustodyBinding } from "./lc4-cell-resume-journal";
import {
  LC4_DEV_PROVIDER_SEGMENTS_PER_EPISODE,
  LC4_DEV_PROVIDER_SESSION_SCHEDULE_SHA256,
} from "./lc4-development-live-runner";

export const LC4_DEV_BUDGET_VERSION = "HACC-LC4-DEV-BUDGET-v3" as const;
export const LC4_DEV_BUDGET_MAXIMUM_MICRO_USD = 15_000_000 as const;
export const LC4_DEV_BUDGET_EPISODES = 6 as const;
export const LC4_DEV_BUDGET_SEGMENTS = 36 as const;
export const LC4_DEV_BUDGET_RETRIES = 0 as const;
export const LC4_DEV_BUDGET_RECONNECTS = 0 as const;
/** Frozen before paid execution. Covers 25.4 min caller audio plus provider turns, ASR, retention, and cleanup. */
// Six paced, long-horizon voice episodes can legitimately exceed two hours
// when a provider produces long spoken responses. This is a wall-clock lease
// only; it does not increase the fixed $15 spend ceiling or permit retries.
export const LC4_DEV_MAXIMUM_RUN_DURATION_MS = 21_600_000 as const;

const BINDING_DOMAIN = "harshas-amazing-call-center/lc4-dev-budget-binding/v3\n";
const EPISODE_SET_DOMAIN = "harshas-amazing-call-center/lc4-dev-budget-episode-set/v3\n";
const ENVELOPE_DOMAIN = "harshas-amazing-call-center/lc4-dev-budget-envelope/v3\n";
const LEASE_DOMAIN = "harshas-amazing-call-center/lc4-dev-budget-run-lease/v3\n";
const EVIDENCE_DOMAIN = "harshas-amazing-call-center/lc4-dev-budget-evidence/v3\n";
const PACKAGE_DOMAIN = "harshas-amazing-call-center/lc4-dev-run-package/v3\n";
const HASH = /^[a-f0-9]{64}$/u;

export type Lc4DevBudgetBinding = Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  preflight: Lc4DevLivePreflightArtifact;
}>;

export type Lc4DevBudgetReservationReference = Readonly<{
  episode_id: string;
  provider: Lc4DevLiveEpisodePlan["provider"];
  arm: Lc4DevLiveEpisodePlan["arm"];
  model: string;
  reservation_id: string;
  maximum_micro_usd: number;
  reservation_head_sha256: string;
}>;

export type Lc4DevRunLease = Readonly<{
  schema_version: 1;
  budget_version: typeof LC4_DEV_BUDGET_VERSION;
  execution_id: string;
  prepare_sha256: string;
  preflight_sha256: string;
  authorization_artifact_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  credential_identity_set_sha256: string;
  provider_profile_manifest_sha256: string;
  provider_session_schedule_sha256:
    typeof LC4_DEV_PROVIDER_SESSION_SCHEDULE_SHA256;
  audio_manifest_sha256: string;
  qualification_receipt_sha256: string;
  episode_set_sha256: string;
  admitted_at: string;
  preflight_expires_at: string;
  hard_deadline_at: string;
  maximum_run_duration_ms: typeof LC4_DEV_MAXIMUM_RUN_DURATION_MS;
  maximum_total_micro_usd: typeof LC4_DEV_BUDGET_MAXIMUM_MICRO_USD;
  maximum_episode_count: typeof LC4_DEV_BUDGET_EPISODES;
  maximum_segment_count: typeof LC4_DEV_BUDGET_SEGMENTS;
  maximum_retries: typeof LC4_DEV_BUDGET_RETRIES;
  maximum_reconnects: typeof LC4_DEV_BUDGET_RECONNECTS;
  ledger_path: string;
  ledger_id: string;
  ledger_public_key_fingerprint_sha256: string;
  consumed_open_head_sha256: string;
  fully_reserved_head_sha256: string;
  reservations: readonly Lc4DevBudgetReservationReference[];
  lease_sha256: string;
}>;

export type Lc4DevBudgetEvidence = Readonly<{
  schema_version: 1;
  budget_version: typeof LC4_DEV_BUDGET_VERSION;
  execution_id: string;
  lease_sha256: string;
  ledger_id: string;
  ledger_public_key_fingerprint_sha256: string;
  terminal_ledger_head_sha256: string;
  run_sha256: string;
  run_status: "completed" | "failed";
  reservations: readonly Readonly<{
    episode_id: string;
    provider: string;
    status: "settled" | "cancelled";
    terminal_outcome: "completed" | "failed" | "cancelled";
    maximum_micro_usd: number;
    conservative_settled_micro_usd: number;
    provider_reported_micro_usd: number | null;
    usage_event_count: number | null;
    usage_evidence_sha256: string | null;
  }>[];
  active_reservations_micro_usd: 0;
  conservative_settled_micro_usd: number;
  maximum_total_micro_usd: typeof LC4_DEV_BUDGET_MAXIMUM_MICRO_USD;
  evidence_sha256: string;
}>;

export type Lc4DevRunPackage = Readonly<{
  schema_version: 2;
  package_version: "HACC-LC4-DEV-RUN-PACKAGE-v2";
  execution_id: string;
  prepare_sha256: string;
  preflight_sha256: string;
  run_sha256: string;
  budget_lease_sha256: string;
  budget_terminal_evidence_sha256: string;
  budget_terminal_ledger_head_sha256: string;
  budget_ledger_public_key_fingerprint_sha256: string;
  cell_custody: Lc4CellResumeCustodyBinding;
  package_sha256: string;
}>;

function missingOnly(error: unknown): null {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
  throw error;
}

function episodeSet(prepare: Lc4DevLivePrepareArtifact) {
  return prepare.episodes.map((episode) => Object.freeze({
    episode_id: episode.episode_id,
    pair_id: episode.pair_id,
    pair_position: episode.pair_position,
    provider: episode.provider,
    arm: episode.arm,
    model: episode.model,
    voice: episode.voice,
    maximum_micro_usd: episode.maximum_micro_usd,
    opportunity_binding_set_sha256: episode.opportunity_binding_set_sha256,
  }));
}

export function lc4DevBudgetEpisodeSetSha256(prepare: Lc4DevLivePrepareArtifact): string {
  return sha256Hex(`${EPISODE_SET_DOMAIN}${canonicalJson(episodeSet(prepare))}`);
}

export function lc4DevBudgetBindingSha256(binding: Lc4DevBudgetBinding): string {
  return sha256Hex(`${BINDING_DOMAIN}${canonicalJson({
    budget_version: LC4_DEV_BUDGET_VERSION,
    execution_id: binding.prepare.execution_id,
    prepare_sha256: binding.prepare.prepare_sha256,
    preflight_sha256: binding.preflight.preflight_sha256,
    authorization_artifact_sha256: binding.preflight.authorization_artifact_sha256,
    source_commit: binding.prepare.source_commit,
    source_tree_sha256: binding.prepare.source_tree_sha256,
    credential_identity_set_sha256: binding.preflight.credential_identity_set_sha256,
    provider_profile_manifest_sha256: binding.prepare.provider_profile_manifest_sha256,
    provider_session_schedule_sha256:
      binding.prepare.provider_session_schedule_sha256,
    audio_manifest_sha256: binding.prepare.audio_manifest_sha256,
    qualification_receipt_sha256: binding.preflight.qualification.receipt_sha256,
    episode_set_sha256: lc4DevBudgetEpisodeSetSha256(binding.prepare),
    maximum_total_micro_usd: LC4_DEV_BUDGET_MAXIMUM_MICRO_USD,
    maximum_episode_count: LC4_DEV_BUDGET_EPISODES,
    maximum_segment_count: LC4_DEV_BUDGET_SEGMENTS,
    maximum_retries: LC4_DEV_BUDGET_RETRIES,
    maximum_reconnects: LC4_DEV_BUDGET_RECONNECTS,
    maximum_run_duration_ms: LC4_DEV_MAXIMUM_RUN_DURATION_MS,
  })}`);
}

export function lc4DevBudgetLedgerPath(root: string): string {
  return resolve(root, "budget", "lc4-dev-six-episode.jsonl");
}

function assertBinding(binding: Lc4DevBudgetBinding, admittedAt: Date): void {
  const { prepare, preflight } = binding;
  if (prepare.execution_id !== preflight.execution_id
    || prepare.prepare_sha256 !== preflight.prepare_sha256
    || prepare.maximum_total_micro_usd !== LC4_DEV_BUDGET_MAXIMUM_MICRO_USD
    || prepare.episodes.length !== LC4_DEV_BUDGET_EPISODES
    || new Set(prepare.episodes.map((episode) => episode.episode_id)).size !== LC4_DEV_BUDGET_EPISODES
    || preflight.provider_calls_authorized !== true
    || preflight.authorization_verified !== true) {
    throw new Error("LC4-DEV budget requires one exact authorized six-episode $15 plan");
  }
  if (admittedAt.getTime() >= Date.parse(preflight.expires_at)) {
    throw new Error("LC4-DEV budget authority cannot be consumed after preflight expiry");
  }
  const sum = prepare.episodes.reduce((total, episode) => total + episode.maximum_micro_usd, 0);
  if (!Number.isSafeInteger(sum) || sum <= 0 || sum > LC4_DEV_BUDGET_MAXIMUM_MICRO_USD) {
    throw new Error("LC4-DEV per-episode reservations exceed the aggregate $15 authority");
  }
}

function envelope(bindingSha256: string, episode: Lc4DevLiveEpisodePlan): BudgetCostEnvelope {
  return Object.freeze({
    schema_version: 1,
    kind: "hacc_provider_gate1_cost_envelope",
    pricing_snapshot_sha256: sha256Hex(`${ENVELOPE_DOMAIN}provider-pricing-retained-in-exchange-usage\n${episode.provider}\n${episode.model}`),
    provider_hard_session_caps_sha256: sha256Hex(`${ENVELOPE_DOMAIN}six-planned-provider-segments-sixty-canonical-turns-repair-policy-one-zero-retry-zero-reconnect\n${episode.episode_id}`),
    runner_config_sha256: bindingSha256,
    formula_sha256: sha256Hex(`${ENVELOPE_DOMAIN}episode-pessimistic-maximum\n${episode.maximum_micro_usd}`),
    components: Object.freeze([Object.freeze({
      name: `${episode.provider}-${episode.arm}-episode-maximum`,
      upper_bound_micro_usd: episode.maximum_micro_usd,
    })]),
    safety_margin_micro_usd: 0,
  });
}

async function initializeFreshLedger(path: string, now: () => Date): Promise<BudgetJournalSnapshot> {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const paths = [path, `${path}.head.json`, `${path}.signing-key.pem`];
  const existing = await Promise.all(paths.map((candidate) => lstat(candidate).catch(missingOnly)));
  if (existing.every((entry) => entry === null)) {
    return (await initializeFilesystemBudgetLedger({
      ledgerPath: path,
      ledgerId: `lc4-dev-${sha256Hex(path).slice(0, 24)}`,
      operationId: "lc4-dev-initialize",
      operationalCeilingUsd: "15",
      now,
    })).snapshot;
  }
  if (existing.some((entry) => entry === null)) throw new Error("LC4-DEV budget ledger has partial durable state");
  const prior = await inspectFilesystemBudgetLedger({ ledgerPath: path, now });
  throw Object.assign(new Error(`LC4-DEV one-shot budget authority already exists at head ${prior.head_sha256}`), { code: "EEXIST" as const });
}

export async function reserveLc4DevRunBudget(input: Readonly<{
  root: string;
  binding: Lc4DevBudgetBinding;
  now: () => Date;
}>): Promise<Lc4DevRunLease> {
  const admittedAt = input.now();
  assertBinding(input.binding, admittedAt);
  const ledgerPath = lc4DevBudgetLedgerPath(input.root);
  const before = await initializeFreshLedger(ledgerPath, input.now);
  const bindingSha256 = lc4DevBudgetBindingSha256(input.binding);
  const episodeSetSha256 = lc4DevBudgetEpisodeSetSha256(input.binding.prepare);
  const hardDeadline = new Date(admittedAt.getTime() + LC4_DEV_MAXIMUM_RUN_DURATION_MS);
  const consumption: Lc4DevSixEpisodePlanConsumption = Object.freeze({
    kind: "lc4_dev_six_episode",
    consumptionId: `lc4dev:${input.binding.prepare.execution_id}`,
    planSha256: bindingSha256,
    maximumMicroUsd: LC4_DEV_BUDGET_MAXIMUM_MICRO_USD,
    authorizationArtifactSha256: input.binding.preflight.authorization_artifact_sha256,
    executionId: input.binding.prepare.execution_id,
    prepareSha256: input.binding.prepare.prepare_sha256,
    preflightSha256: input.binding.preflight.preflight_sha256,
    sourceCommit: input.binding.prepare.source_commit,
    sourceTreeSha256: input.binding.prepare.source_tree_sha256,
    credentialSetSha256: input.binding.preflight.credential_identity_set_sha256,
    providerProfileManifestSha256: input.binding.prepare.provider_profile_manifest_sha256,
    audioManifestSha256: input.binding.prepare.audio_manifest_sha256,
    qualificationReceiptSha256: input.binding.preflight.qualification.receipt_sha256,
    episodeSetSha256,
    maximumEpisodeCount: LC4_DEV_BUDGET_EPISODES,
    maximumSegmentCount: LC4_DEV_BUDGET_SEGMENTS,
    maximumRetries: LC4_DEV_BUDGET_RETRIES,
    maximumReconnects: LC4_DEV_BUDGET_RECONNECTS,
    maximumRunDurationMs: LC4_DEV_MAXIMUM_RUN_DURATION_MS,
  });
  const references: Lc4DevBudgetReservationReference[] = [];
  let consumedHead = "";
  for (const [index, episode] of input.binding.prepare.episodes.entries()) {
    const result = await reserveFilesystemBudget({
      ledgerPath,
      operationId: `lc4dev-reserve:${index + 1}:${episode.episode_id}`,
      reservationId: `lc4dev:${input.binding.prepare.execution_id}:${episode.episode_id}`,
      runId: `lc4dev:${input.binding.prepare.execution_id}:${episode.episode_id}`,
      provider: episode.provider,
      model: episode.model,
      condition: episode.arm,
      expiresAt: hardDeadline.toISOString(),
      costEnvelope: envelope(bindingSha256, episode),
      expectedLedgerId: before.ledger_id,
      ...(index === 0 ? {
        requiredCurrentHeadSha256: before.head_sha256,
        planConsumption: consumption,
      } : {
        requiredAncestorHeadSha256: consumedHead,
      }),
      now: input.now,
    });
    if (index === 0) consumedHead = result.snapshot.head_sha256;
    references.push(Object.freeze({
      episode_id: episode.episode_id,
      provider: episode.provider,
      arm: episode.arm,
      model: episode.model,
      reservation_id: `lc4dev:${input.binding.prepare.execution_id}:${episode.episode_id}`,
      maximum_micro_usd: episode.maximum_micro_usd,
      reservation_head_sha256: result.snapshot.head_sha256,
    }));
  }
  const after = await inspectFilesystemBudgetLedger({ ledgerPath, now: input.now });
  if (after.reservations.length !== LC4_DEV_BUDGET_EPISODES
    || after.active_reservations_micro_usd !== input.binding.prepare.episodes.reduce((sum, episode) => sum + episode.maximum_micro_usd, 0)
    || after.active_reservations_micro_usd > LC4_DEV_BUDGET_MAXIMUM_MICRO_USD) {
    throw new Error("LC4-DEV aggregate reservation set is incomplete or exceeds $15");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    budget_version: LC4_DEV_BUDGET_VERSION,
    execution_id: input.binding.prepare.execution_id,
    prepare_sha256: input.binding.prepare.prepare_sha256,
    preflight_sha256: input.binding.preflight.preflight_sha256,
    authorization_artifact_sha256: input.binding.preflight.authorization_artifact_sha256,
    source_commit: input.binding.prepare.source_commit,
    source_tree_sha256: input.binding.prepare.source_tree_sha256,
    credential_identity_set_sha256: input.binding.preflight.credential_identity_set_sha256,
    provider_profile_manifest_sha256: input.binding.prepare.provider_profile_manifest_sha256,
    provider_session_schedule_sha256:
      input.binding.prepare.provider_session_schedule_sha256,
    audio_manifest_sha256: input.binding.prepare.audio_manifest_sha256,
    qualification_receipt_sha256: input.binding.preflight.qualification.receipt_sha256,
    episode_set_sha256: episodeSetSha256,
    admitted_at: admittedAt.toISOString(),
    preflight_expires_at: input.binding.preflight.expires_at,
    hard_deadline_at: hardDeadline.toISOString(),
    maximum_run_duration_ms: LC4_DEV_MAXIMUM_RUN_DURATION_MS,
    maximum_total_micro_usd: LC4_DEV_BUDGET_MAXIMUM_MICRO_USD,
    maximum_episode_count: LC4_DEV_BUDGET_EPISODES,
    maximum_segment_count: LC4_DEV_BUDGET_SEGMENTS,
    maximum_retries: LC4_DEV_BUDGET_RETRIES,
    maximum_reconnects: LC4_DEV_BUDGET_RECONNECTS,
    ledger_path: ledgerPath,
    ledger_id: after.ledger_id,
    ledger_public_key_fingerprint_sha256: after.public_key_fingerprint_sha256,
    consumed_open_head_sha256: consumedHead,
    fully_reserved_head_sha256: after.head_sha256,
    reservations: Object.freeze(references),
  });
  return Object.freeze({ ...body, lease_sha256: sha256Hex(`${LEASE_DOMAIN}${canonicalJson(body)}`) });
}

export function assertLc4DevRunLease(input: Readonly<{
  lease: Lc4DevRunLease;
  binding: Lc4DevBudgetBinding;
  now: Date;
  admission?: boolean;
}>): void {
  const { lease_sha256: claimed, ...body } = input.lease;
  if (claimed !== sha256Hex(`${LEASE_DOMAIN}${canonicalJson(body)}`)) throw new Error("LC4-DEV run lease hash mismatch");
  if (input.lease.budget_version !== LC4_DEV_BUDGET_VERSION
    || input.lease.execution_id !== input.binding.prepare.execution_id
    || input.lease.prepare_sha256 !== input.binding.prepare.prepare_sha256
    || input.lease.preflight_sha256 !== input.binding.preflight.preflight_sha256
    || input.lease.provider_session_schedule_sha256
      !== input.binding.prepare.provider_session_schedule_sha256
    || input.lease.provider_session_schedule_sha256
      !== LC4_DEV_PROVIDER_SESSION_SCHEDULE_SHA256
    || input.lease.episode_set_sha256 !== lc4DevBudgetEpisodeSetSha256(input.binding.prepare)
    || input.lease.reservations.length !== LC4_DEV_BUDGET_EPISODES
    || input.lease.maximum_total_micro_usd !== LC4_DEV_BUDGET_MAXIMUM_MICRO_USD
    || input.lease.maximum_segment_count !== LC4_DEV_BUDGET_SEGMENTS
    || input.lease.maximum_retries !== 0
    || input.lease.maximum_reconnects !== 0
    || Date.parse(input.lease.hard_deadline_at) - Date.parse(input.lease.admitted_at) !== LC4_DEV_MAXIMUM_RUN_DURATION_MS) {
    throw new Error("LC4-DEV run lease differs from the exact plan or hard controls");
  }
  if (Date.parse(input.lease.admitted_at) >= Date.parse(input.lease.preflight_expires_at)) {
    throw new Error("LC4-DEV run lease was consumed after preflight expiry");
  }
  if (input.admission === true && input.now.getTime() >= Date.parse(input.lease.preflight_expires_at)) {
    throw new Error("LC4-DEV provider construction admission occurred after preflight expiry");
  }
  if (input.now.getTime() >= Date.parse(input.lease.hard_deadline_at)) {
    throw new Error("LC4-DEV hard overall run deadline elapsed");
  }
}

export class Lc4DevBudgetLifecycle {
  readonly #lease: Lc4DevRunLease;
  readonly #binding: Lc4DevBudgetBinding;
  readonly #now: () => Date;
  readonly #intendedSegments = new Set<string>();
  readonly #openedSegments = new Set<string>();
  readonly #nextSegmentByEpisode = new Map<string, number>();

  constructor(input: Readonly<{
    lease: Lc4DevRunLease;
    binding: Lc4DevBudgetBinding;
    now: () => Date;
    completed_episode_ids?: readonly string[];
  }>) {
    assertLc4DevRunLease({ ...input, now: input.now(), admission: true });
    this.#lease = input.lease;
    this.#binding = input.binding;
    this.#now = input.now;
    const completed = input.completed_episode_ids ?? [];
    if (canonicalJson(completed) !== canonicalJson(
      input.binding.prepare.episodes.slice(0, completed.length).map((episode) => episode.episode_id),
    )) {
      throw new Error("LC4-DEV budget continuation is not the exact completed leading episode prefix");
    }
    for (const episodeId of completed) {
      if (!this.#lease.reservations.some((reservation) => reservation.episode_id === episodeId)) {
        throw new Error("LC4-DEV budget continuation includes an unreserved episode");
      }
      for (let ordinal = 1; ordinal <= LC4_DEV_PROVIDER_SEGMENTS_PER_EPISODE; ordinal += 1) {
        const segmentKey = `${episodeId}:segment:${ordinal}`;
        this.#intendedSegments.add(segmentKey);
        this.#openedSegments.add(segmentKey);
      }
      this.#nextSegmentByEpisode.set(episodeId, LC4_DEV_PROVIDER_SEGMENTS_PER_EPISODE + 1);
    }
  }

  assertProviderConstructionAuthorized(): void {
    assertLc4DevRunLease({ lease: this.#lease, binding: this.#binding, now: this.#now(), admission: true });
  }

  assertWithinHardDeadline(): void {
    assertLc4DevRunLease({ lease: this.#lease, binding: this.#binding, now: this.#now() });
  }

  assertOperationWindow(maximumDurationMs: number): void {
    if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs <= 0) throw new Error("LC4-DEV operation duration bound is invalid");
    this.assertWithinHardDeadline();
    if (this.#now().getTime() + maximumDurationMs > Date.parse(this.#lease.hard_deadline_at)) {
      throw new Error("LC4-DEV hard overall run deadline cannot admit another bounded provider operation");
    }
  }

  async beforeEpisodeSocketOpen(
    episode: Lc4DevLiveEpisodePlan,
    segmentOrdinal: 1 | 2 | 3 | 4 | 5 | 6,
  ): Promise<void> {
    this.assertWithinHardDeadline();
    const reference = this.#lease.reservations.find((candidate) => candidate.episode_id === episode.episode_id);
    if (!reference || reference.provider !== episode.provider || reference.arm !== episode.arm || reference.model !== episode.model) {
      throw new Error("LC4-DEV attempted an unreserved seventh or mutated episode");
    }
    const expected = this.#nextSegmentByEpisode.get(episode.episode_id) ?? 1;
    const segmentKey = `${episode.episode_id}:segment:${segmentOrdinal}`;
    if (segmentOrdinal !== expected || this.#intendedSegments.has(segmentKey)) {
      throw new Error("LC4-DEV retry or reconnect authority is zero");
    }
    if (this.#intendedSegments.size >= this.#lease.maximum_segment_count) {
      throw new Error("LC4-DEV planned provider segment authority is exhausted");
    }
    if (segmentOrdinal === 1) {
      await markBudgetConnectionIntent({
        ledgerPath: this.#lease.ledger_path,
        operationId: `lc4dev-opening:${episode.episode_id}`,
        reservationId: reference.reservation_id,
        now: this.#now,
      });
    }
    this.#intendedSegments.add(segmentKey);
  }

  async afterEpisodeSocketOpen(
    episode: Lc4DevLiveEpisodePlan,
    segmentOrdinal: 1 | 2 | 3 | 4 | 5 | 6,
    signal?: AbortSignal,
  ): Promise<void> {
    const reference = this.#lease.reservations.find((candidate) => candidate.episode_id === episode.episode_id);
    const segmentKey = `${episode.episode_id}:segment:${segmentOrdinal}`;
    if (!reference
      || !this.#intendedSegments.has(segmentKey)
      || this.#openedSegments.has(segmentKey)) {
      throw new Error("LC4-DEV socket opened without consumed planned-segment authority");
    }
    if (segmentOrdinal === 1) {
      await markBudgetSessionOpened({
        ledgerPath: this.#lease.ledger_path,
        operationId: `lc4dev-opened:${episode.episode_id}`,
        reservationId: reference.reservation_id,
        now: this.#now,
      });
    }
    if (signal?.aborted) {
      throw new Error(
        "LC4-DEV segment admission was aborted after conservative durable budget acknowledgement",
      );
    }
    this.#openedSegments.add(segmentKey);
    this.#nextSegmentByEpisode.set(episode.episode_id, segmentOrdinal + 1);
  }
}

export async function finalizeLc4DevRunBudget(input: Readonly<{
  lease: Lc4DevRunLease;
  binding: Lc4DevBudgetBinding;
  run: Lc4DevLiveRunArtifact;
  now: () => Date;
}>): Promise<Lc4DevBudgetEvidence> {
  assertLc4DevRunLease({ lease: input.lease, binding: input.binding, now: new Date(input.run.started_at) });
  if (input.run.execution_id !== input.lease.execution_id
    || input.run.prepare_sha256 !== input.lease.prepare_sha256
    || input.run.preflight_sha256 !== input.lease.preflight_sha256
    || input.run.paid_retry_count !== 0) {
    throw new Error("LC4-DEV run differs from its one-shot budget lease");
  }
  for (const [index, reference] of input.lease.reservations.entries()) {
    const snapshot = await inspectFilesystemBudgetLedger({ ledgerPath: input.lease.ledger_path, now: input.now });
    const reservation = snapshot.reservations.find((candidate) => candidate.reservation_id === reference.reservation_id);
    if (!reservation) throw new Error("LC4-DEV budget reservation disappeared");
    if (reservation.status === "reserved") {
      await cancelFilesystemBudgetBeforeOpen({
        ledgerPath: input.lease.ledger_path,
        operationId: `lc4dev-cancel:${reference.episode_id}`,
        reservationId: reference.reservation_id,
        now: input.now,
      });
      continue;
    }
    if (reservation.status === "opening" || reservation.status === "opened") {
      const completed = index < input.run.episodes_completed;
      const usageEventCount = input.run.ledger.filter((event) => event.episode_id === reference.episode_id
        && (event.event_type === "opportunity_completed" || event.event_type === "opportunity_failed")).length;
      const usageEvidenceSha256 = sha256Hex(`${EVIDENCE_DOMAIN}usage\n${canonicalJson({
        run_sha256: input.run.run_sha256,
        episode_id: reference.episode_id,
        provider: reference.provider,
        usage_event_count: usageEventCount,
        ledger_head_sha256: input.run.ledger_head_sha256,
      })}`);
      await recordFilesystemBudgetUsage({
        ledgerPath: input.lease.ledger_path,
        operationId: `lc4dev-usage:${reference.episode_id}`,
        reservationId: reference.reservation_id,
        usageEventCount,
        usageEvidenceSha256,
        now: input.now,
      });
      await recordBudgetTerminal({
        ledgerPath: input.lease.ledger_path,
        operationId: `lc4dev-terminal:${reference.episode_id}`,
        reservationId: reference.reservation_id,
        outcome: completed ? "completed" : "failed",
        now: input.now,
      });
      await settleFilesystemBudget({
        ledgerPath: input.lease.ledger_path,
        operationId: `lc4dev-settle:${reference.episode_id}`,
        reservationId: reference.reservation_id,
        // Until billing reconciliation, every opened or ambiguous-opening
        // episode consumes its full pessimistic reservation.
        estimatedUsd: (reference.maximum_micro_usd / 1_000_000).toFixed(6),
        now: input.now,
      });
    }
  }
  const terminal = await inspectFilesystemBudgetLedger({ ledgerPath: input.lease.ledger_path, now: input.now });
  if (terminal.active_reservations_micro_usd !== 0) throw new Error("LC4-DEV terminal budget still has active liability");
  const reservations = input.lease.reservations.map((reference) => {
    const value = terminal.reservations.find((candidate) => candidate.reservation_id === reference.reservation_id)!;
    if (value.status !== "settled" && value.status !== "cancelled") throw new Error("LC4-DEV budget did not reach a terminal reservation state");
    return Object.freeze({
      episode_id: reference.episode_id,
      provider: reference.provider,
      status: value.status,
      terminal_outcome: value.terminal_outcome ?? "cancelled",
      maximum_micro_usd: value.maximum_micro_usd,
      conservative_settled_micro_usd: value.estimated_micro_usd ?? 0,
      provider_reported_micro_usd: value.provider_reported_micro_usd,
      usage_event_count: value.usage_event_count,
      usage_evidence_sha256: value.usage_evidence_sha256,
    });
  });
  const body = Object.freeze({
    schema_version: 1 as const,
    budget_version: LC4_DEV_BUDGET_VERSION,
    execution_id: input.lease.execution_id,
    lease_sha256: input.lease.lease_sha256,
    ledger_id: terminal.ledger_id,
    ledger_public_key_fingerprint_sha256: terminal.public_key_fingerprint_sha256,
    terminal_ledger_head_sha256: terminal.head_sha256,
    run_sha256: input.run.run_sha256,
    run_status: input.run.status,
    reservations: Object.freeze(reservations),
    active_reservations_micro_usd: 0 as const,
    conservative_settled_micro_usd: terminal.conservative_settled_micro_usd,
    maximum_total_micro_usd: LC4_DEV_BUDGET_MAXIMUM_MICRO_USD,
  });
  return Object.freeze({ ...body, evidence_sha256: sha256Hex(`${EVIDENCE_DOMAIN}${canonicalJson(body)}`) });
}

export async function replayLc4DevBudgetEvidence(input: Readonly<{
  lease: Lc4DevRunLease;
  binding: Lc4DevBudgetBinding;
  evidence: Lc4DevBudgetEvidence;
  now?: () => Date;
}>): Promise<void> {
  assertLc4DevRunLease({ lease: input.lease, binding: input.binding, now: new Date(input.lease.admitted_at) });
  const { evidence_sha256: claimed, ...body } = input.evidence;
  if (claimed !== sha256Hex(`${EVIDENCE_DOMAIN}${canonicalJson(body)}`)) throw new Error("LC4-DEV budget evidence hash mismatch");
  const snapshot = await inspectFilesystemBudgetLedger({ ledgerPath: input.lease.ledger_path, now: input.now });
  if (snapshot.ledger_id !== input.evidence.ledger_id
    || snapshot.public_key_fingerprint_sha256 !== input.evidence.ledger_public_key_fingerprint_sha256
    || snapshot.head_sha256 !== input.evidence.terminal_ledger_head_sha256
    || snapshot.active_reservations_micro_usd !== 0
    || snapshot.conservative_settled_micro_usd !== input.evidence.conservative_settled_micro_usd
    || input.evidence.maximum_total_micro_usd !== LC4_DEV_BUDGET_MAXIMUM_MICRO_USD
    || input.evidence.reservations.length !== LC4_DEV_BUDGET_EPISODES) {
    throw new Error("LC4-DEV budget evidence differs from the independently replayed signed ledger");
  }
  for (const expected of input.evidence.reservations) {
    const actual = snapshot.reservations.find((candidate) => candidate.run_id.endsWith(`:${expected.episode_id}`));
    if (!actual
      || actual.provider !== expected.provider
      || actual.status !== expected.status
      || (actual.terminal_outcome ?? "cancelled") !== expected.terminal_outcome
      || actual.maximum_micro_usd !== expected.maximum_micro_usd
      || (actual.estimated_micro_usd ?? 0) !== expected.conservative_settled_micro_usd
      || actual.provider_reported_micro_usd !== expected.provider_reported_micro_usd
      || actual.usage_event_count !== expected.usage_event_count
      || actual.usage_evidence_sha256 !== expected.usage_evidence_sha256) {
      throw new Error("LC4-DEV budget reservation evidence does not replay");
    }
  }
  for (const digest of [input.evidence.lease_sha256, input.evidence.terminal_ledger_head_sha256, input.evidence.run_sha256]) {
    if (!HASH.test(digest)) throw new Error("LC4-DEV budget evidence contains an invalid hash");
  }
}

export function createLc4DevRunPackage(input: Readonly<{
  lease: Lc4DevRunLease;
  evidence: Lc4DevBudgetEvidence;
  run: Lc4DevLiveRunArtifact;
  cell_custody: Lc4CellResumeCustodyBinding;
}>): Lc4DevRunPackage {
  if (input.run.execution_id !== input.lease.execution_id
    || input.run.run_sha256 !== input.evidence.run_sha256
    || input.evidence.lease_sha256 !== input.lease.lease_sha256
    || input.evidence.execution_id !== input.lease.execution_id) {
    throw new Error("LC4-DEV run package inputs do not share one execution authority");
  }
  for (const digest of [
    input.cell_custody.cell_resume_plan_sha256,
    input.cell_custody.cell_resume_terminal_head_sha256,
    input.cell_custody.completed_cell_artifact_set_sha256,
  ]) {
    if (!HASH.test(digest)) throw new Error("LC4-DEV run package cell custody hash is invalid");
  }
  if (!Number.isSafeInteger(input.cell_custody.completed_cell_count)
    || input.cell_custody.completed_cell_count < 0
    || input.cell_custody.completed_cell_count > 6
    || (input.run.status === "completed"
      && (!input.cell_custody.all_cells_completed
        || input.cell_custody.quarantine_present
        || input.cell_custody.completed_cell_count !== 6))
    || (input.cell_custody.quarantine_present && input.run.status !== "failed")) {
    throw new Error("LC4-DEV run package cell custody disposition differs from terminal run");
  }
  const body = Object.freeze({
    schema_version: 2 as const,
    package_version: "HACC-LC4-DEV-RUN-PACKAGE-v2" as const,
    execution_id: input.run.execution_id,
    prepare_sha256: input.run.prepare_sha256,
    preflight_sha256: input.run.preflight_sha256,
    run_sha256: input.run.run_sha256,
    budget_lease_sha256: input.lease.lease_sha256,
    budget_terminal_evidence_sha256: input.evidence.evidence_sha256,
    budget_terminal_ledger_head_sha256: input.evidence.terminal_ledger_head_sha256,
    budget_ledger_public_key_fingerprint_sha256: input.evidence.ledger_public_key_fingerprint_sha256,
    cell_custody: input.cell_custody,
  });
  return Object.freeze({ ...body, package_sha256: sha256Hex(`${PACKAGE_DOMAIN}${canonicalJson(body)}`) });
}

export function assertLc4DevRunPackage(input: Readonly<{
  package: Lc4DevRunPackage;
  lease: Lc4DevRunLease;
  evidence: Lc4DevBudgetEvidence;
  run: Lc4DevLiveRunArtifact;
  cell_custody: Lc4CellResumeCustodyBinding;
}>): void {
  const expected = createLc4DevRunPackage(input);
  if (canonicalJson(expected) !== canonicalJson(input.package)) throw new Error("LC4-DEV run package hash or binding mismatch");
}

import { createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalJson, sha256Hex } from "./artifacts";
import type { Lc4FrozenProductionRealtimeAdapter } from "./lc4-production-provider-adapter";
import {
  assertLc4QualificationGateReceipt,
  compileLc4ProductionScheduleShape,
  createLc4EpisodeManifest,
  type Lc4EpisodeManifest,
} from "./lc4-production-runner-foundation";
import { LC4_PROVIDER_PROFILE_MANIFEST } from "./lc4-provider-profiles";
import { PROVIDER_QUALIFICATION_MAX_AGE_MS } from "./provider-qualification";
import {
  filesystemBudgetLedgerContainsHead,
  inspectFilesystemBudgetLedger,
  type BudgetLedgerStoreOptions,
} from "./filesystem-budget-ledger";

export const LC4_EXECUTION_AUTHORIZATION_VERSION = "HACC-LC4-EXECUTION-AUTHORIZATION-v1" as const;
export const LC4_EXECUTION_LEDGER_VERSION = "HACC-LC4-EXECUTION-LEDGER-v1" as const;
export const LC4_PAID_PROVIDER_EXECUTION_BUILD_FROZEN = true as const;
export const LC4_EXECUTION_TIMEOUTS = Object.freeze({
  qualification_read_ms: 10_000,
  reservation_ms: 10_000,
  connection_open_ms: 20_000,
  response_first_audio_ms: 20_000,
  response_terminal_ms: 45_000,
  retention_write_ms: 10_000,
  episode_wall_ms: 60 * 60_000,
});

const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const AUTHORIZATION_DOMAIN = "harshas-amazing-call-center/lc4-execution-authorization/v1\n";
const AUTHORIZATION_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-execution-authorization-artifact/v1\n";
const PREFLIGHT_DOMAIN = "harshas-amazing-call-center/lc4-execution-preflight/v1\n";
const LEDGER_EVENT_DOMAIN = "harshas-amazing-call-center/lc4-execution-ledger-event/v1\n";
const LEDGER_DOMAIN = "harshas-amazing-call-center/lc4-execution-ledger/v1\n";
const RETENTION_DOMAIN = "harshas-amazing-call-center/lc4-retained-artifact/v1\n";
const RESERVATION_VERIFICATION_DOMAIN = "harshas-amazing-call-center/lc4-filesystem-reservation-verification/v1\n";
const PRIVATE_DIRECTORY_MODE = 0o700;
const IMMUTABLE_FILE_MODE = 0o400;

function requireHash(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function requireId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must be a safe opaque identifier`);
}

function requireIso(value: string, label: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return epoch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type Lc4ExecutionAuthorizationBody = Readonly<{
  schema_version: 1;
  authorization_version: typeof LC4_EXECUTION_AUTHORIZATION_VERSION;
  execution_id: string;
  authorization_nonce_sha256: string;
  protocol_id: "HACC-LC4-v1";
  schedule_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  preregistration_sha256: string;
  heldout_commitment_sha256: string;
  generator_schedule_join_sha256: string;
  qualification_gate_sha256: string;
  provider_profile_manifest_sha256: string;
  authorized_run_ids: readonly string[];
  maximum_total_micro_usd: number;
  not_before: string;
  expires_at: string;
  purpose: "lc4_confirmatory_provider_execution";
}>;

export type Lc4ExecutionAuthorizationArtifact = Readonly<{
  body: Lc4ExecutionAuthorizationBody;
  authority_public_key_spki_base64: string;
  authority_public_key_fingerprint_sha256: string;
  signature_algorithm: "Ed25519";
  signature_base64: string;
  artifact_sha256: string;
}>;

export function lc4ExecutionAuthorizationSigningBytes(body: Lc4ExecutionAuthorizationBody): Uint8Array {
  return Buffer.from(`${AUTHORIZATION_DOMAIN}${canonicalJson(body)}`, "utf8");
}

export function lc4ExecutionAuthorizationArtifactSha256(
  artifact: Omit<Lc4ExecutionAuthorizationArtifact, "artifact_sha256">,
): string {
  return sha256Hex(`${AUTHORIZATION_ARTIFACT_DOMAIN}${canonicalJson(artifact)}`);
}

function assertAuthorizationBody(body: Lc4ExecutionAuthorizationBody): void {
  if (body.schema_version !== 1 || body.authorization_version !== LC4_EXECUTION_AUTHORIZATION_VERSION) {
    throw new Error("LC4 execution authorization schema is unsupported");
  }
  requireId(body.execution_id, "execution ID");
  requireHash(body.authorization_nonce_sha256, "authorization nonce");
  for (const [label, digest] of Object.entries({
    schedule_sha256: body.schedule_sha256,
    source_tree_sha256: body.source_tree_sha256,
    preregistration_sha256: body.preregistration_sha256,
    heldout_commitment_sha256: body.heldout_commitment_sha256,
    generator_schedule_join_sha256: body.generator_schedule_join_sha256,
    qualification_gate_sha256: body.qualification_gate_sha256,
    provider_profile_manifest_sha256: body.provider_profile_manifest_sha256,
  })) requireHash(digest, label);
  if (!SHA1.test(body.source_commit)) throw new Error("authorization source commit must be a full Git SHA-1");
  if (body.protocol_id !== "HACC-LC4-v1" || body.purpose !== "lc4_confirmatory_provider_execution") {
    throw new Error("LC4 execution authorization has the wrong protocol or purpose");
  }
  if (body.authorized_run_ids.length === 0 || body.authorized_run_ids.length > 144) {
    throw new Error("LC4 execution authorization run set is empty or oversized");
  }
  for (const runId of body.authorized_run_ids) requireId(runId, "authorized run ID");
  if (new Set(body.authorized_run_ids).size !== body.authorized_run_ids.length) {
    throw new Error("LC4 execution authorization contains duplicate run IDs");
  }
  if (!Number.isSafeInteger(body.maximum_total_micro_usd)
    || body.maximum_total_micro_usd <= 0
    || body.maximum_total_micro_usd > 900_000_000) {
    throw new Error("LC4 execution authorization exceeds the frozen $900 scheduling ceiling");
  }
  if (requireIso(body.expires_at, "authorization expiry") <= requireIso(body.not_before, "authorization start")) {
    throw new Error("LC4 execution authorization validity window is reversed");
  }
}

export function assertLc4ExecutionAuthorization(input: Readonly<{
  artifact: Lc4ExecutionAuthorizationArtifact;
  expected_authority_public_key_fingerprint_sha256: string;
  now: Date;
}>): void {
  requireHash(input.expected_authority_public_key_fingerprint_sha256, "expected authority fingerprint");
  assertAuthorizationBody(input.artifact.body);
  if (input.artifact.signature_algorithm !== "Ed25519") throw new Error("LC4 execution authorization must use Ed25519");
  const keyBytes = Buffer.from(input.artifact.authority_public_key_spki_base64, "base64");
  if (keyBytes.byteLength === 0) throw new Error("LC4 execution authorization public key is empty");
  const fingerprint = sha256Hex(keyBytes);
  if (
    fingerprint !== input.artifact.authority_public_key_fingerprint_sha256
    || fingerprint !== input.expected_authority_public_key_fingerprint_sha256
  ) throw new Error("LC4 execution authority is not the pinned trust root");
  const artifactBody = {
    body: input.artifact.body,
    authority_public_key_spki_base64: input.artifact.authority_public_key_spki_base64,
    authority_public_key_fingerprint_sha256: input.artifact.authority_public_key_fingerprint_sha256,
    signature_algorithm: input.artifact.signature_algorithm,
    signature_base64: input.artifact.signature_base64,
  } satisfies Omit<Lc4ExecutionAuthorizationArtifact, "artifact_sha256">;
  if (lc4ExecutionAuthorizationArtifactSha256(artifactBody) !== input.artifact.artifact_sha256) {
    throw new Error("LC4 execution authorization artifact hash mismatch");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  } catch {
    throw new Error("LC4 execution authorization public key is invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("LC4 execution authorization key is not Ed25519");
  if (!verify(null, lc4ExecutionAuthorizationSigningBytes(input.artifact.body), publicKey, Buffer.from(input.artifact.signature_base64, "base64"))) {
    throw new Error("LC4 execution authorization signature is invalid");
  }
  const now = input.now.getTime();
  if (!Number.isFinite(now)) throw new Error("LC4 execution authorization clock is invalid");
  if (now < requireIso(input.artifact.body.not_before, "authorization start")) {
    throw new Error("LC4 execution authorization is not active yet");
  }
  if (now >= requireIso(input.artifact.body.expires_at, "authorization expiry")) {
    throw new Error("LC4 execution authorization has expired");
  }
}

export type Lc4ExecutionPreflightReceipt = Readonly<{
  schema_version: 1;
  execution_id: string;
  run_id: string;
  checked_at: string;
  manifest_sha256: string;
  authorization_artifact_sha256: string;
  qualification_gate_sha256: string;
  reservation_sha256: string;
  adapter_kind: "production-realtime-frozen";
  timeout_policy_sha256: string;
  cryptographic_authorization_verified: true;
  qualification_verified: true;
  reservation_verified: true;
  reservation_verification_sha256: string;
  provider_calls_authorized: false;
  blocked_reason: "paid_provider_execution_build_frozen";
  preflight_sha256: string;
}>;

export type Lc4FilesystemReservationVerification = Readonly<{
  schema_version: 1;
  run_id: string;
  reservation_id: string;
  reservation_sha256: string;
  reservation_head_sha256: string;
  current_ledger_head_sha256: string;
  ledger_id: string;
  ledger_state: "open" | "operational_closed" | "scheduling_closed";
  maximum_micro_usd: number;
  verified_at: string;
  verification_sha256: string;
}>;

export async function createLc4FilesystemReservationVerification(input: BudgetLedgerStoreOptions & Readonly<{
  manifest: Lc4EpisodeManifest;
  checkedAt: Date;
}>): Promise<Lc4FilesystemReservationVerification> {
  const [snapshot, containsReservationHead] = await Promise.all([
    inspectFilesystemBudgetLedger(input),
    filesystemBudgetLedgerContainsHead({ ...input, ancestorHeadSha256: input.manifest.budget_reservation.ledger_head_sha256 }),
  ]);
  if (!containsReservationHead) throw new Error("LC4 budget ledger does not descend from the episode reservation head");
  if (snapshot.paused || snapshot.state === "authorization_breached") throw new Error("LC4 budget ledger is paused or authorization-breached");
  const reservation = snapshot.reservations.find((candidate) => candidate.reservation_id === input.manifest.budget_reservation.reservation_id);
  if (!reservation || snapshot.reservations.filter((candidate) => candidate.run_id === input.manifest.run_id).length !== 1) {
    throw new Error("LC4 budget ledger lacks one unique reservation for the run ID");
  }
  if (
    reservation.run_id !== input.manifest.run_id
    || reservation.provider !== input.manifest.episode_shape.provider
    || reservation.model !== input.manifest.episode_shape.provider_profile.model
    || reservation.condition !== input.manifest.episode_shape.arm
    || reservation.maximum_micro_usd !== input.manifest.budget_reservation.maximum_micro_usd
    || reservation.status !== "reserved"
  ) throw new Error("LC4 filesystem reservation differs from the frozen episode manifest");
  if (snapshot.scheduling_exposure_micro_usd > snapshot.scheduling_stop_micro_usd
    || snapshot.scheduling_exposure_micro_usd > snapshot.authorization_ceiling_micro_usd) {
    throw new Error("LC4 budget ledger exposure exceeds a scheduling boundary");
  }
  requireIso(input.checkedAt.toISOString(), "reservation verification time");
  const body = Object.freeze({
    schema_version: 1 as const,
    run_id: input.manifest.run_id,
    reservation_id: reservation.reservation_id,
    reservation_sha256: input.manifest.budget_reservation.reservation_sha256,
    reservation_head_sha256: input.manifest.budget_reservation.ledger_head_sha256,
    current_ledger_head_sha256: snapshot.head_sha256,
    ledger_id: snapshot.ledger_id,
    ledger_state: snapshot.state as "open" | "operational_closed" | "scheduling_closed",
    maximum_micro_usd: reservation.maximum_micro_usd,
    verified_at: input.checkedAt.toISOString(),
  });
  return Object.freeze({ ...body, verification_sha256: sha256Hex(`${RESERVATION_VERIFICATION_DOMAIN}${canonicalJson(body)}`) });
}

function assertReservationVerification(
  receipt: Lc4FilesystemReservationVerification,
  manifest: Lc4EpisodeManifest,
): void {
  const body = {
    schema_version: receipt.schema_version,
    run_id: receipt.run_id,
    reservation_id: receipt.reservation_id,
    reservation_sha256: receipt.reservation_sha256,
    reservation_head_sha256: receipt.reservation_head_sha256,
    current_ledger_head_sha256: receipt.current_ledger_head_sha256,
    ledger_id: receipt.ledger_id,
    ledger_state: receipt.ledger_state,
    maximum_micro_usd: receipt.maximum_micro_usd,
    verified_at: receipt.verified_at,
  };
  if (sha256Hex(`${RESERVATION_VERIFICATION_DOMAIN}${canonicalJson(body)}`) !== receipt.verification_sha256) {
    throw new Error("LC4 filesystem reservation verification hash mismatch");
  }
  if (
    receipt.run_id !== manifest.run_id
    || receipt.reservation_id !== manifest.budget_reservation.reservation_id
    || receipt.reservation_sha256 !== manifest.budget_reservation.reservation_sha256
    || receipt.reservation_head_sha256 !== manifest.budget_reservation.ledger_head_sha256
    || receipt.maximum_micro_usd !== manifest.budget_reservation.maximum_micro_usd
  ) throw new Error("LC4 filesystem reservation verification differs from the episode manifest");
}

function assertManifestIntegrity(manifest: Lc4EpisodeManifest): void {
  const rebuilt = createLc4EpisodeManifest({
    schedule: compileLc4ProductionScheduleShape(),
    run_id: manifest.run_id,
    source_commit: manifest.source_commit,
    source_tree_sha256: manifest.source_tree_sha256,
    preregistration_sha256: manifest.preregistration_sha256,
    heldout_commitment_sha256: manifest.heldout_commitment_sha256,
    template_commitment_sha256: manifest.template_commitment_sha256,
    opportunity_manifest_sha256: manifest.opportunity_manifest_sha256,
    caller_fixture_manifest_sha256: manifest.caller_fixture_manifest_sha256,
    condition_suite_sha256: manifest.condition_suite_sha256,
    parity_manifest_sha256: manifest.parity_manifest_sha256,
    generator_schedule_join_sha256: manifest.generator_schedule_join_sha256,
    qualification: manifest.qualification,
    budget_reservation: manifest.budget_reservation,
    opportunities: manifest.opportunities,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(manifest)) throw new Error("LC4 production episode manifest integrity failed");
  if (manifest.provider_calls_authorized !== false || manifest.execution_scope !== "provider_free_foundation_validation_only") {
    throw new Error("LC4 external execution authority must not mutate the provider-free foundation manifest");
  }
}

export function createLc4ExecutionPreflight(input: Readonly<{
  manifest: Lc4EpisodeManifest;
  authorization: Lc4ExecutionAuthorizationArtifact;
  expected_authority_public_key_fingerprint_sha256: string;
  qualification_binding: Readonly<{
    plan_sha256: string;
    source_commit: string;
    configuration_matrix_sha256: string;
    credential_set_sha256: string;
  }>;
  adapter: Lc4FrozenProductionRealtimeAdapter;
  reservation_verification: Lc4FilesystemReservationVerification;
  now: Date;
}>): Lc4ExecutionPreflightReceipt {
  assertManifestIntegrity(input.manifest);
  assertLc4QualificationGateReceipt(input.manifest.qualification, input.qualification_binding);
  assertLc4ExecutionAuthorization({
    artifact: input.authorization,
    expected_authority_public_key_fingerprint_sha256: input.expected_authority_public_key_fingerprint_sha256,
    now: input.now,
  });
  assertReservationVerification(input.reservation_verification, input.manifest);
  if (input.adapter.kind !== "production-realtime-frozen") throw new Error("LC4 execution requires the frozen production realtime adapter");
  for (const qualificationMs of [
    requireIso(input.manifest.qualification.handshake.completed_at, "handshake completion"),
    requireIso(input.manifest.qualification.response_tool_canary.completed_at, "tool-canary completion"),
  ]) {
    const age = input.now.getTime() - qualificationMs;
    if (age < 0 || age > PROVIDER_QUALIFICATION_MAX_AGE_MS) {
      throw new Error("LC4 production qualification is stale or future-dated");
    }
  }
  const authorization = input.authorization.body;
  const exactBindings = [
    [authorization.schedule_sha256, input.manifest.schedule_sha256, "schedule"],
    [authorization.source_commit, input.manifest.source_commit, "source commit"],
    [authorization.source_tree_sha256, input.manifest.source_tree_sha256, "source tree"],
    [authorization.preregistration_sha256, input.manifest.preregistration_sha256, "preregistration"],
    [authorization.heldout_commitment_sha256, input.manifest.heldout_commitment_sha256, "held-out commitment"],
    [authorization.generator_schedule_join_sha256, input.manifest.generator_schedule_join_sha256, "generator schedule join"],
    [authorization.qualification_gate_sha256, input.manifest.qualification.gate_sha256, "qualification gate"],
    [authorization.provider_profile_manifest_sha256, LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256, "provider profile manifest"],
  ] as const;
  for (const [actual, expected, label] of exactBindings) {
    if (actual !== expected) throw new Error(`LC4 execution authorization differs from ${label}`);
  }
  if (!authorization.authorized_run_ids.includes(input.manifest.run_id)) {
    throw new Error("LC4 execution authorization does not include this run ID");
  }
  const schedule = compileLc4ProductionScheduleShape();
  const authorizedEpisodes = authorization.authorized_run_ids.map((runId) => {
    const episode = schedule.episode_shapes.find((candidate) => candidate.run_id === runId);
    if (!episode) throw new Error("LC4 execution authorization contains a run outside the frozen schedule");
    return episode;
  });
  const authorizedReservationTotal = authorizedEpisodes.reduce((total, episode) => total + episode.maximum_reservation_micro_usd, 0);
  if (authorizedReservationTotal > authorization.maximum_total_micro_usd) {
    throw new Error("LC4 cryptographic authorization is smaller than its authorized run-set reservation envelope");
  }
  if (input.manifest.budget_reservation.maximum_micro_usd > authorization.maximum_total_micro_usd) {
    throw new Error("LC4 episode reservation exceeds its cryptographic authorization");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    execution_id: authorization.execution_id,
    run_id: input.manifest.run_id,
    checked_at: input.now.toISOString(),
    manifest_sha256: input.manifest.manifest_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    qualification_gate_sha256: input.manifest.qualification.gate_sha256,
    reservation_sha256: input.manifest.budget_reservation.reservation_sha256,
    adapter_kind: "production-realtime-frozen" as const,
    timeout_policy_sha256: sha256Hex(canonicalJson(LC4_EXECUTION_TIMEOUTS)),
    cryptographic_authorization_verified: true as const,
    qualification_verified: true as const,
    reservation_verified: true as const,
    reservation_verification_sha256: input.reservation_verification.verification_sha256,
    provider_calls_authorized: false as const,
    blocked_reason: "paid_provider_execution_build_frozen" as const,
  });
  return Object.freeze({ ...body, preflight_sha256: sha256Hex(`${PREFLIGHT_DOMAIN}${canonicalJson(body)}`) });
}

export type Lc4ExecutionLedgerEventKind =
  | "episode.reserved"
  | "connection.intent"
  | "connection.preopen_failed"
  | "connection.opened"
  | "itt.first_audio_consumed"
  | "artifact.retained"
  | "usage.observed"
  | "episode.terminal"
  | "cost.settled";

export type Lc4ExecutionLedgerEvent = Readonly<{
  sequence: number;
  occurred_at: string;
  event_kind: Lc4ExecutionLedgerEventKind;
  payload: Readonly<Record<string, unknown>>;
  previous_event_sha256: string | null;
  event_sha256: string;
}>;

export type Lc4ExecutionLedger = Readonly<{
  schema_version: 1;
  ledger_version: typeof LC4_EXECUTION_LEDGER_VERSION;
  execution_id: string;
  run_id: string;
  preflight_sha256: string;
  reservation_sha256: string;
  events: readonly Lc4ExecutionLedgerEvent[];
  state: "reserved" | "connecting" | "connected" | "itt_open" | "terminal" | "settled";
  connection_opened: boolean;
  itt_first_audio_consumed: boolean;
  run_id_consumed: boolean;
  terminal_outcome: "completed" | "failed" | null;
  provider_reported_micro_usd: number | null;
  estimated_micro_usd: number | null;
  input_audio_ms: number;
  output_audio_ms: number;
  retained_artifact_count: number;
  preopen_connection_failures: number;
  ledger_sha256: string;
}>;

type LedgerMutable = {
  state: Lc4ExecutionLedger["state"];
  reservationRecorded: boolean;
  connectionOpened: boolean;
  ittOpened: boolean;
  terminalOutcome: Lc4ExecutionLedger["terminal_outcome"];
  providerCost: number | null;
  estimatedCost: number | null;
  inputAudioMs: number;
  outputAudioMs: number;
  retainedArtifacts: number;
  preopenFailures: number;
};

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value as number;
}

function applyLedgerEvent(state: LedgerMutable, event: Pick<Lc4ExecutionLedgerEvent, "event_kind" | "payload">): void {
  const payload = event.payload;
  switch (event.event_kind) {
    case "episode.reserved":
      if (state.state !== "reserved" || state.reservationRecorded) throw new Error("LC4 episode reservation may be recorded only once");
      requireHash(String(payload.reservation_sha256 ?? ""), "ledger reservation");
      state.reservationRecorded = true;
      break;
    case "connection.intent":
      if (state.state !== "reserved") throw new Error("LC4 connection intent requires a reserved episode");
      state.state = "connecting";
      break;
    case "connection.preopen_failed":
      if (state.state !== "connecting" || state.connectionOpened || state.ittOpened) {
        throw new Error("LC4 pre-open failure may be recorded only before any connection opens");
      }
      requireId(String(payload.failure_code ?? ""), "pre-open failure code");
      state.preopenFailures += 1;
      state.state = "reserved";
      break;
    case "connection.opened":
      if (state.state !== "connecting" || state.connectionOpened) throw new Error("LC4 connection may open exactly once per run ID");
      state.connectionOpened = true;
      state.state = "connected";
      break;
    case "itt.first_audio_consumed":
      if (state.state !== "connected" || state.ittOpened) throw new Error("LC4 ITT first audio requires one open connection and may occur once");
      requireId(String(payload.opportunity_id ?? ""), "ITT opportunity ID");
      state.ittOpened = true;
      state.state = "itt_open";
      break;
    case "artifact.retained":
      if (state.state !== "connected" && state.state !== "itt_open") throw new Error("LC4 artifacts may be retained only during an open episode");
      requireHash(String(payload.artifact_sha256 ?? ""), "retained artifact");
      nonNegativeInteger(payload.byte_length, "retained artifact byte length");
      state.retainedArtifacts += 1;
      break;
    case "usage.observed":
      if (state.state !== "connected" && state.state !== "itt_open") throw new Error("LC4 usage may be recorded only during an open episode");
      state.inputAudioMs += nonNegativeInteger(payload.input_audio_ms, "input audio usage");
      state.outputAudioMs += nonNegativeInteger(payload.output_audio_ms, "output audio usage");
      if (payload.provider_reported_micro_usd !== null && payload.provider_reported_micro_usd !== undefined) {
        state.providerCost = nonNegativeInteger(payload.provider_reported_micro_usd, "provider-reported cost");
      }
      break;
    case "episode.terminal": {
      if (!["reserved", "connecting", "connected", "itt_open"].includes(state.state)) throw new Error("LC4 episode is already terminal");
      const outcome = payload.outcome;
      if (outcome !== "completed" && outcome !== "failed") throw new Error("LC4 terminal outcome is invalid");
      if (outcome === "completed" && !state.ittOpened) throw new Error("LC4 episode cannot complete before ITT first audio");
      state.terminalOutcome = outcome;
      state.state = "terminal";
      break;
    }
    case "cost.settled":
      if (state.state !== "terminal") throw new Error("LC4 cost settlement requires a terminal episode");
      state.estimatedCost = nonNegativeInteger(payload.estimated_micro_usd, "estimated cost");
      if (payload.provider_reported_micro_usd !== null && payload.provider_reported_micro_usd !== undefined) {
        state.providerCost = nonNegativeInteger(payload.provider_reported_micro_usd, "settled provider-reported cost");
      }
      state.state = "settled";
      break;
    default:
      throw new Error("LC4 execution ledger event kind is invalid");
  }
}

function buildLedger(input: Omit<Lc4ExecutionLedger, "state" | "connection_opened" | "itt_first_audio_consumed" | "run_id_consumed" | "terminal_outcome" | "provider_reported_micro_usd" | "estimated_micro_usd" | "input_audio_ms" | "output_audio_ms" | "retained_artifact_count" | "preopen_connection_failures" | "ledger_sha256">): Lc4ExecutionLedger {
  const state: LedgerMutable = {
    state: "reserved",
    reservationRecorded: false,
    connectionOpened: false,
    ittOpened: false,
    terminalOutcome: null,
    providerCost: null,
    estimatedCost: null,
    inputAudioMs: 0,
    outputAudioMs: 0,
    retainedArtifacts: 0,
    preopenFailures: 0,
  };
  let previous: string | null = null;
  input.events.forEach((event, index) => {
    if (event.sequence !== index + 1 || event.previous_event_sha256 !== previous) throw new Error("LC4 execution ledger chain is discontinuous");
    requireIso(event.occurred_at, "ledger event timestamp");
    const expected = sha256Hex(`${LEDGER_EVENT_DOMAIN}${canonicalJson({
      sequence: event.sequence,
      occurred_at: event.occurred_at,
      event_kind: event.event_kind,
      payload: event.payload,
      previous_event_sha256: event.previous_event_sha256,
    })}`);
    if (event.event_sha256 !== expected) throw new Error("LC4 execution ledger event hash mismatch");
    applyLedgerEvent(state, event);
    previous = event.event_sha256;
  });
  if (
    input.events.length > 0
    && input.events[0].payload.reservation_sha256 !== input.reservation_sha256
  ) throw new Error("LC4 execution ledger reservation event differs from its header");
  const body = Object.freeze({
    ...input,
    events: Object.freeze([...input.events]),
    state: state.state,
    connection_opened: state.connectionOpened,
    itt_first_audio_consumed: state.ittOpened,
    run_id_consumed: state.connectionOpened || state.ittOpened,
    terminal_outcome: state.terminalOutcome,
    provider_reported_micro_usd: state.providerCost,
    estimated_micro_usd: state.estimatedCost,
    input_audio_ms: state.inputAudioMs,
    output_audio_ms: state.outputAudioMs,
    retained_artifact_count: state.retainedArtifacts,
    preopen_connection_failures: state.preopenFailures,
  });
  return Object.freeze({ ...body, ledger_sha256: sha256Hex(`${LEDGER_DOMAIN}${canonicalJson(body)}`) });
}

export function createLc4ExecutionLedger(input: Readonly<{
  execution_id: string;
  run_id: string;
  preflight_sha256: string;
  reservation_sha256: string;
  occurred_at: string;
}>): Lc4ExecutionLedger {
  requireId(input.execution_id, "ledger execution ID");
  requireId(input.run_id, "ledger run ID");
  requireHash(input.preflight_sha256, "ledger preflight");
  requireHash(input.reservation_sha256, "ledger reservation");
  const empty = {
    schema_version: 1 as const,
    ledger_version: LC4_EXECUTION_LEDGER_VERSION,
    execution_id: input.execution_id,
    run_id: input.run_id,
    preflight_sha256: input.preflight_sha256,
    reservation_sha256: input.reservation_sha256,
    events: Object.freeze([]) as readonly Lc4ExecutionLedgerEvent[],
  };
  return appendLc4ExecutionLedgerEvent(buildLedger(empty), {
    occurred_at: input.occurred_at,
    event_kind: "episode.reserved",
    payload: Object.freeze({ reservation_sha256: input.reservation_sha256 }),
  });
}

export function assertLc4ExecutionLedger(ledger: Lc4ExecutionLedger): void {
  const rebuilt = buildLedger({
    schema_version: ledger.schema_version,
    ledger_version: ledger.ledger_version,
    execution_id: ledger.execution_id,
    run_id: ledger.run_id,
    preflight_sha256: ledger.preflight_sha256,
    reservation_sha256: ledger.reservation_sha256,
    events: ledger.events,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(ledger)) throw new Error("LC4 execution ledger integrity failed");
}

export function appendLc4ExecutionLedgerEvent(
  ledger: Lc4ExecutionLedger,
  input: Readonly<{
    occurred_at: string;
    event_kind: Lc4ExecutionLedgerEventKind;
    payload: Readonly<Record<string, unknown>>;
  }>,
): Lc4ExecutionLedger {
  assertLc4ExecutionLedger(ledger);
  requireIso(input.occurred_at, "ledger event timestamp");
  const eventBody = Object.freeze({
    sequence: ledger.events.length + 1,
    occurred_at: input.occurred_at,
    event_kind: input.event_kind,
    payload: Object.freeze({ ...input.payload }),
    previous_event_sha256: ledger.events.at(-1)?.event_sha256 ?? null,
  });
  const event = Object.freeze({ ...eventBody, event_sha256: sha256Hex(`${LEDGER_EVENT_DOMAIN}${canonicalJson(eventBody)}`) });
  return buildLedger({
    schema_version: 1,
    ledger_version: LC4_EXECUTION_LEDGER_VERSION,
    execution_id: ledger.execution_id,
    run_id: ledger.run_id,
    preflight_sha256: ledger.preflight_sha256,
    reservation_sha256: ledger.reservation_sha256,
    events: Object.freeze([...ledger.events, event]),
  });
}

export async function withLc4StrictTimeout<T>(input: Readonly<{
  label: string;
  timeout_ms: number;
  operation(signal: AbortSignal): Promise<T>;
  on_timeout?: () => void | Promise<void>;
}>): Promise<T> {
  if (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms <= 0) throw new Error("LC4 timeout must be a positive safe integer");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      input.operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error(`LC4 ${input.label} timed out`));
          Promise.resolve(input.on_timeout?.()).then(
            () => reject(new Error(`LC4 ${input.label} timed out`)),
            () => reject(new Error(`LC4 ${input.label} timed out; timeout cleanup also failed`)),
          );
        }, input.timeout_ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type Lc4RetainedArtifactReceipt = Readonly<{
  run_id: string;
  opportunity_id: string;
  kind: "caller_pcm" | "assistant_pcm" | "listener_evidence" | "provider_exchange_evidence";
  artifact_sha256: string;
  byte_length: number;
  relative_path: string;
  retention_receipt_sha256: string;
}>;

function ledgerRunDirectory(root: string, runId: string): string {
  return join(root, `run-${sha256Hex(runId)}`);
}

async function writeReadOnlyExclusive(path: string, bytes: Uint8Array): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, IMMUTABLE_FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o222) !== 0) {
    throw new Error("LC4 immutable ledger file is not a read-only regular file");
  }
}

/**
 * Create the one durable run-ID anchor. A second initialization fails even if
 * a process crashes, while a pre-open connection failure can be appended to
 * this same ledger and followed by another connection intent.
 */
export async function initializeLc4ExecutionLedgerStore(input: Readonly<{
  root: string;
  ledger: Lc4ExecutionLedger;
}>): Promise<string> {
  assertLc4ExecutionLedger(input.ledger);
  const root = await assertSafeRetentionRoot(input.root);
  const runDirectory = ledgerRunDirectory(root, input.ledger.run_id);
  try {
    await mkdir(runDirectory, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") throw new Error("LC4 run ID already has a durable execution anchor");
    throw error;
  }
  const relativePath = join(basename(runDirectory), `${String(input.ledger.events.length).padStart(6, "0")}-${input.ledger.ledger_sha256}.json`);
  await writeReadOnlyExclusive(join(root, relativePath), Buffer.from(`${canonicalJson(input.ledger)}\n`, "utf8"));
  return relativePath;
}

export async function appendLc4ExecutionLedgerStore(input: Readonly<{
  root: string;
  previous: Lc4ExecutionLedger;
  next: Lc4ExecutionLedger;
}>): Promise<string> {
  assertLc4ExecutionLedger(input.previous);
  assertLc4ExecutionLedger(input.next);
  if (
    input.next.run_id !== input.previous.run_id
    || input.next.execution_id !== input.previous.execution_id
    || input.next.events.length !== input.previous.events.length + 1
    || canonicalJson(input.next.events.slice(0, -1)) !== canonicalJson(input.previous.events)
  ) throw new Error("LC4 durable ledger append is not exactly one chained event");
  const root = await assertSafeRetentionRoot(input.root);
  const runDirectory = ledgerRunDirectory(root, input.previous.run_id);
  const info = await lstat(runDirectory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("LC4 durable execution anchor is missing or unsafe");
  }
  const entries = (await readdir(runDirectory)).filter((name) => /^\d{6}-[a-f0-9]{64}\.json$/u.test(name)).sort();
  const expectedPreviousName = `${String(input.previous.events.length).padStart(6, "0")}-${input.previous.ledger_sha256}.json`;
  if (entries.at(-1) !== expectedPreviousName) throw new Error("LC4 durable ledger head differs from the supplied previous state");
  const retainedPrevious = JSON.parse(await readFile(join(runDirectory, expectedPreviousName), "utf8")) as Lc4ExecutionLedger;
  if (canonicalJson(retainedPrevious) !== canonicalJson(input.previous)) throw new Error("LC4 durable ledger head content differs from the supplied previous state");
  const nextName = `${String(input.next.events.length).padStart(6, "0")}-${input.next.ledger_sha256}.json`;
  await writeReadOnlyExclusive(join(runDirectory, nextName), Buffer.from(`${canonicalJson(input.next)}\n`, "utf8"));
  return join(basename(runDirectory), nextName);
}

async function assertSafeRetentionRoot(root: string): Promise<string> {
  const absolute = resolve(root);
  await mkdir(absolute, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(absolute, PRIVATE_DIRECTORY_MODE);
  const [info, canonical] = await Promise.all([lstat(absolute), realpath(absolute)]);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("LC4 retention root must be a private, canonical, non-symlink directory");
  }
  return canonical;
}

export async function retainLc4ImmutableArtifact(input: Readonly<{
  root: string;
  run_id: string;
  opportunity_id: string;
  kind: Lc4RetainedArtifactReceipt["kind"];
  bytes: Uint8Array;
}>): Promise<Lc4RetainedArtifactReceipt> {
  requireId(input.run_id, "retention run ID");
  requireId(input.opportunity_id, "retention opportunity ID");
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) throw new Error("LC4 retained artifact cannot be empty");
  const root = await assertSafeRetentionRoot(input.root);
  const artifactSha256 = sha256Hex(input.bytes);
  const extension = input.kind.endsWith("pcm") ? "pcm" : "json";
  const relativePath = join(input.run_id, input.opportunity_id, `${input.kind}-${artifactSha256}.${extension}`);
  const path = join(root, relativePath);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(parent, PRIVATE_DIRECTORY_MODE);
  const canonicalParent = await realpath(parent);
  if (!canonicalParent.startsWith(`${root}/`) || basename(path).includes("..")) throw new Error("LC4 retention path escaped its private root");
  try {
    await writeReadOnlyExclusive(path, input.bytes);
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (sha256Hex(existing) !== artifactSha256 || existing.byteLength !== input.bytes.byteLength) {
      throw new Error("LC4 retained artifact path already exists with different bytes");
    }
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o222) !== 0) {
    throw new Error("LC4 retained artifact is not a read-only regular file");
  }
  const body = Object.freeze({
    run_id: input.run_id,
    opportunity_id: input.opportunity_id,
    kind: input.kind,
    artifact_sha256: artifactSha256,
    byte_length: input.bytes.byteLength,
    relative_path: relativePath,
  });
  return Object.freeze({ ...body, retention_receipt_sha256: sha256Hex(`${RETENTION_DOMAIN}${canonicalJson(body)}`) });
}

/**
 * The production adapter and the provider-free foundation are deliberately
 * joined only at a validated, cryptographically authorized preflight. This
 * build cannot cross the final network boundary; changing that fact requires
 * a reviewed source change, not an environment variable.
 */
export async function executeLc4AuthorizedProductionEpisode(input: Readonly<{
  preflight: Lc4ExecutionPreflightReceipt;
  adapter: Lc4FrozenProductionRealtimeAdapter;
}>): Promise<never> {
  if (input.preflight.adapter_kind !== input.adapter.kind) throw new Error("LC4 execution adapter differs from preflight");
  if (input.preflight.provider_calls_authorized !== false || !LC4_PAID_PROVIDER_EXECUTION_BUILD_FROZEN) {
    throw new Error("LC4 paid execution invariant is invalid");
  }
  throw new Error("LC4 paid provider execution is hard-frozen in this build; cryptographic authorization is necessary but not sufficient");
}

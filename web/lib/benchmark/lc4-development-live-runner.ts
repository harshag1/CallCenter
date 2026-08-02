import { createPublicKey, verify } from "node:crypto";

import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "./artifacts";
import {
  assertLc4PublicDevelopmentCorpus,
  createLc4PublicDevelopmentCorpus,
  type Lc4PublicDevelopmentCorpus,
  type Lc4PublicDevOpportunity,
} from "./lc4-public-development-corpus";
import {
  LC4_PROVIDER_PROFILE_MANIFEST,
  LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE,
} from "./lc4-provider-profiles";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import type { HaccResponsePlan } from "./response-plan";
import type {
  Lc4DevReplayArtifactReference,
  Lc4DevReplayEvidenceStore,
} from "./lc4-development-evidence-retention";
import {
  LC4_DEV_FAILURE_EVIDENCE_DOMAIN,
  LC4_DEV_FAILURE_EVIDENCE_VERSION,
  Lc4DevFailureEvidenceError,
  createLc4DevFailureEvidence,
  isLc4DevFailureEvidenceError,
  lc4DevFailureEvidenceBody,
  type Lc4DevFailureEvidence,
} from "./lc4-development-failure-evidence";
import {
  LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
  assertLc4DevQualificationAdmissionReceipt,
  type Lc4DevQualificationAdmissionReceipt,
} from "./lc4-development-qualification-v3";
import {
  assertLc4XaiFiniteManualGateDReceipt,
  type Lc4XaiFiniteManualGateDReceipt,
} from "./lc4-xai.manual-qualification";
import type {
  Lc4DevExchangeEvidence,
  Lc4DevelopmentRealtimeAdapter,
  Lc4DevelopmentRealtimeSession,
} from "./lc4-development-realtime-contract";
import type {
  Lc4DevRepairPlayback,
  Lc4DevRepairPlaybackController,
  Lc4DevRepairPlaybackReceipt,
} from "./lc4-development-repair-playback";
import {
  LC4_DEV_BRANCH_OPPORTUNITY_ID,
  assertLc4DevCallerBranchDecision,
  assertLc4DevCallerBranchMatrixArtifact,
  lc4DevBranchedOpportunity,
  type Lc4DevCallerBranchDecision,
  type Lc4DevCallerBranchMatrixArtifact,
} from "./lc4-development-caller-branch";
import {
  LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
  LC4_DEV_AUDIO_EXECUTION_CONTRACT_SHA256,
  LC4_DEV_AUDIO_PACKETIZER_CONTRACT_SHA256,
} from "./lc4-development-audio-contract";
import { createLc4ProviderExecutionProfile } from "./lc4-production-runner-foundation";
import {
  assertLc4ProviderExchangeTreatmentReplayProjection,
  type Lc4ProviderExchangeTreatmentReplayExpectation,
} from "./lc4-provider-exchange-replay";
import {
  independentAsrContractSha256,
  type IndependentAsrContract,
} from "./audible-evidence";
import { LC4_DEV_TIMEOUT_CONTRACT } from "./lc4-development-timeout-contract";
import { PROVIDER_QUALIFICATION_MAX_AGE_MS } from "./provider-qualification";

export type {
  Lc4DevExchangeEvidence,
  Lc4DevelopmentRealtimeAdapter,
  Lc4DevelopmentRealtimeSession,
} from "./lc4-development-realtime-contract";

export const LC4_DEV_LIVE_RUNNER_VERSION = "HACC-LC4-DEV-LIVE-RUNNER-v5" as const;
export const LC4_DEV_LIVE_EPISODES = 6 as const;
export const LC4_DEV_LIVE_OPPORTUNITIES_PER_EPISODE = 60 as const;
export const LC4_DEV_PROVIDER_SEGMENTS_PER_EPISODE = 6 as const;
export const LC4_DEV_OPPORTUNITIES_PER_PROVIDER_SEGMENT = 10 as const;
export const LC4_DEV_LIVE_TOTAL_OPPORTUNITIES = 360 as const;
export const LC4_DEV_LIVE_HARD_CEILING_MICRO_USD = 15_000_000 as const;
export const LC4_DEV_LIVE_TIMEOUTS = Object.freeze({
  segment_open_ms: 20_000,
  // Emergency watchdog only. Inner components own their timeouts and retain
  // the replayable failure evidence; see lc4-development-timeout-contract.
  opportunity_exchange_ms:
    LC4_DEV_TIMEOUT_CONTRACT.opportunity_emergency_watchdog_ms,
  retention_ms: 10_000,
  control_ms: 10_000,
  segment_close_ms: 10_000,
});

const HASH = /^[a-f0-9]{64}$/u;
const PROVIDER_SESSION_SCHEDULE_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-provider-session-schedule/v2\n";

export const LC4_DEV_PROVIDER_SESSION_SCHEDULE = Object.freeze(
  ([1, 2, 3, 4, 5, 6] as const).map((ordinal) => Object.freeze({
    ordinal,
    opportunity_start:
      (ordinal - 1) * LC4_DEV_OPPORTUNITIES_PER_PROVIDER_SEGMENT + 1,
    opportunity_end:
      ordinal * LC4_DEV_OPPORTUNITIES_PER_PROVIDER_SEGMENT,
    opportunity_count: LC4_DEV_OPPORTUNITIES_PER_PROVIDER_SEGMENT,
    provider_session_rotation_required_after:
      ordinal < LC4_DEV_PROVIDER_SEGMENTS_PER_EPISODE,
  })),
);
export const LC4_DEV_PROVIDER_SESSION_SCHEDULE_SHA256 = sha256Hex(
  `${PROVIDER_SESSION_SCHEDULE_DOMAIN}${canonicalJson(
    LC4_DEV_PROVIDER_SESSION_SCHEDULE,
  )}`,
);
const COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const PREPARE_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-prepare/v5\n";
const PREFLIGHT_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-preflight/v4\n";
const AUTHORIZATION_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-authorization/v4\n";
const AUTHORIZATION_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-authorization-artifact/v4\n";
const LEDGER_EVENT_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-ledger-event/v1\n";
const RUN_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-run/v3\n";
const CELL_PREFIX_DOMAIN = "harshas-amazing-call-center/lc4-dev-cell-prefix/v1\n";
const REPORT_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-report/v1\n";
const CONTROL_RECEIPT_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-control-receipt/v1\n";
const REPAIR_DECISION_DOMAIN = "harshas-amazing-call-center/lc4-dev-repair-decision-receipt/v1\n";
const REPAIR_PLAYBACK_DOMAIN = "harshas-amazing-call-center/lc4-dev-repair-playback-receipt/v1\n";

type Arm = "native" | "hacc";

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function hash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function requireId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must be a safe opaque identifier`);
}

const ASR_RUNNER_TRUST_KEYS = Object.freeze([
  "key_id",
  "public_key_fingerprint_sha256",
  "public_key_spki_base64",
  "signature_algorithm",
] as const);

export type Lc4DevAsrRunnerTrust = Readonly<{
  key_id: string;
  public_key_spki_base64: string;
  public_key_fingerprint_sha256: string;
  signature_algorithm: "Ed25519";
}>;

/**
 * Validates the external ASR runner trust root without relying on any key
 * identity carried by an invocation receipt. The canonical DER SPKI is the
 * fingerprint preimage and is sufficient for independent Ed25519 replay.
 */
export function assertLc4DevAsrRunnerTrust(
  value: unknown,
): asserts value is Lc4DevAsrRunnerTrust {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LC4-DEV ASR runner trust must be one object");
  }
  const candidate = value as Record<string, unknown>;
  if (canonicalJson(Object.keys(candidate).sort())
    !== canonicalJson([...ASR_RUNNER_TRUST_KEYS].sort())) {
    throw new Error("LC4-DEV ASR runner trust has missing or unknown fields");
  }
  if (typeof candidate.key_id !== "string"
    || !SAFE_ID.test(candidate.key_id)) {
    throw new Error("LC4-DEV ASR runner key ID must be one safe identifier");
  }
  if (candidate.signature_algorithm !== "Ed25519") {
    throw new Error("LC4-DEV ASR runner trust must use Ed25519");
  }
  if (typeof candidate.public_key_fingerprint_sha256 !== "string"
    || !HASH.test(candidate.public_key_fingerprint_sha256)) {
    throw new Error(
      "LC4-DEV ASR runner public-key fingerprint must be one lowercase SHA-256",
    );
  }
  if (typeof candidate.public_key_spki_base64 !== "string"
    || candidate.public_key_spki_base64.length < 40
    || candidate.public_key_spki_base64.length > 1_024) {
    throw new Error("LC4-DEV ASR runner SPKI must be one bounded base64 value");
  }
  const der = Buffer.from(candidate.public_key_spki_base64, "base64");
  if (der.byteLength < 32
    || der.byteLength > 512
    || der.toString("base64") !== candidate.public_key_spki_base64) {
    throw new Error("LC4-DEV ASR runner SPKI must be canonical bounded base64");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new Error("LC4-DEV ASR runner SPKI is invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519"
    || sha256Hex(der) !== candidate.public_key_fingerprint_sha256) {
    throw new Error(
      "LC4-DEV ASR runner SPKI is not the pinned Ed25519 trust root",
    );
  }
}

export function createLc4DevAsrRunnerTrust(
  value: Lc4DevAsrRunnerTrust,
): Lc4DevAsrRunnerTrust {
  assertLc4DevAsrRunnerTrust(value);
  return freeze({ ...value });
}

function assertIso(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
}

export type Lc4DevCallerAudioBinding = Readonly<{
  opportunity_id: string;
  provider: LiveStsProvider;
  pcm_sha256: string;
  pcm_byte_length: number;
  sample_rate_hz: 16_000 | 24_000;
  source_text_sha256: string;
}>;

export type Lc4DevLiveEpisodePlan = Readonly<{
  episode_id: string;
  pair_id: string;
  pair_position: number;
  provider: LiveStsProvider;
  arm: Arm;
  model: string;
  voice: string;
  maximum_micro_usd: number;
  opportunity_binding_set_sha256: string;
}>;

export type Lc4DevXaiFiniteManualQualificationBinding = Readonly<{
  receipt_sha256: string;
  plan_authority_trust_root_sha256: string;
  transport_profile_sha256: string;
}>;

export type Lc4DevLivePrepareArtifact = Readonly<{
  schema_version: 5;
  runner_version: typeof LC4_DEV_LIVE_RUNNER_VERSION;
  protocol_id: "HACC-LC4-DEV-v1";
  execution_id: string;
  created_at: string;
  source_commit: string;
  source_tree_sha256: string;
  corpus_sha256: string;
  provider_profile_manifest_sha256: string;
  provider_session_schedule_sha256:
    typeof LC4_DEV_PROVIDER_SESSION_SCHEDULE_SHA256;
  qualification_transport_scope_sha256: string;
  qualification_claim_boundary: "retained_gate_b_transports_only_xai_finite_manual_not_qualified";
  xai_finite_manual_transport_qualification:
    "receipt_bound_pending_preflight_replay";
  xai_finite_manual_gate_d: Lc4DevXaiFiniteManualQualificationBinding;
  audio_delivery_profile_sha256: string;
  audio_packetizer_contract_sha256: string;
  audio_execution_contract_sha256: string;
  audio_manifest_sha256: string;
  audio_bindings: readonly Lc4DevCallerAudioBinding[];
  episodes: readonly Lc4DevLiveEpisodePlan[];
  total_opportunities: typeof LC4_DEV_LIVE_TOTAL_OPPORTUNITIES;
  maximum_total_micro_usd: number;
  hard_ceiling_micro_usd: typeof LC4_DEV_LIVE_HARD_CEILING_MICRO_USD;
  retry_policy: "no_retry_after_segment_open_or_audio_submission";
  evidence_boundary: Readonly<{
    study_role: "mechanism-evidence-only";
    efficacy_claim_eligible: false;
    confirmatory_reuse_permitted: false;
  }>;
  prepare_sha256: string;
}>;

export function createLc4DevLivePrepareArtifact(input: Readonly<{
  execution_id: string;
  created_at: string;
  source_commit: string;
  source_tree_sha256: string;
  audio_manifest_sha256: string;
  audio_bindings: readonly Lc4DevCallerAudioBinding[];
  maximum_total_micro_usd?: number;
  corpus?: Lc4PublicDevelopmentCorpus;
  xai_finite_manual_gate_d: Lc4DevXaiFiniteManualQualificationBinding;
}>): Lc4DevLivePrepareArtifact {
  requireId(input.execution_id, "LC4-DEV execution ID");
  assertIso(input.created_at, "LC4-DEV prepare time");
  if (!COMMIT.test(input.source_commit)) throw new Error("LC4-DEV source commit must be a full Git SHA-1");
  requireHash(input.source_tree_sha256, "LC4-DEV source tree");
  requireHash(input.audio_manifest_sha256, "LC4-DEV audio manifest");
  requireHash(
    input.xai_finite_manual_gate_d.receipt_sha256,
    "LC4-DEV xAI finite-manual Gate D receipt",
  );
  requireHash(
    input.xai_finite_manual_gate_d.plan_authority_trust_root_sha256,
    "LC4-DEV xAI finite-manual Gate D plan authority",
  );
  if (input.xai_finite_manual_gate_d.transport_profile_sha256
    !== LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256) {
    throw new Error("LC4-DEV xAI finite-manual Gate D uses a stale transport profile");
  }
  const corpus = input.corpus ?? createLc4PublicDevelopmentCorpus();
  assertLc4PublicDevelopmentCorpus(corpus);
  const maximum = input.maximum_total_micro_usd ?? LC4_DEV_LIVE_HARD_CEILING_MICRO_USD;
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > LC4_DEV_LIVE_HARD_CEILING_MICRO_USD) {
    throw new Error("LC4-DEV maximum spend must be positive and no greater than $15");
  }
  const expectedBindings = 3 * LC4_DEV_LIVE_OPPORTUNITIES_PER_EPISODE;
  if (input.audio_bindings.length !== expectedBindings) {
    throw new Error("LC4-DEV audio manifest must bind 60 opportunities for each of three providers");
  }
  const byProvider = new Map<LiveStsProvider, Lc4DevCallerAudioBinding[]>();
  for (const binding of input.audio_bindings) {
    requireId(binding.opportunity_id, "LC4-DEV opportunity ID");
    requireHash(binding.pcm_sha256, "LC4-DEV caller PCM");
    requireHash(binding.source_text_sha256, "LC4-DEV caller source text");
    if (!Number.isSafeInteger(binding.pcm_byte_length) || binding.pcm_byte_length < 2 || binding.pcm_byte_length % 2 !== 0) {
      throw new Error("LC4-DEV caller PCM byte length must be positive PCM16");
    }
    const profile = LC4_PROVIDER_PROFILE_MANIFEST.providers[binding.provider];
    if (binding.sample_rate_hz !== profile.input_sample_rate_hz) throw new Error("LC4-DEV caller audio rate differs from provider profile");
    const opportunity = corpus.opportunities.find((candidate) => candidate.id === binding.opportunity_id);
    if (!opportunity || opportunity.canonical_caller_text_sha256 !== binding.source_text_sha256) {
      throw new Error("LC4-DEV caller audio binding differs from the public development corpus");
    }
    const list = byProvider.get(binding.provider) ?? [];
    list.push(binding);
    byProvider.set(binding.provider, list);
  }
  for (const provider of ["openai", "gemini", "xai"] as const) {
    const bindings = byProvider.get(provider) ?? [];
    if (bindings.length !== 60 || new Set(bindings.map((item) => item.opportunity_id)).size !== 60) {
      throw new Error(`LC4-DEV ${provider} caller audio bindings are incomplete or duplicated`);
    }
    corpus.opportunities.forEach((opportunity, index) => {
      if (bindings[index]?.opportunity_id !== opportunity.id) throw new Error(`LC4-DEV ${provider} audio order drifted`);
    });
  }
  const perEpisode = Math.floor(maximum / LC4_DEV_LIVE_EPISODES);
  const episodes = corpus.six_episode_canary_schedule.map((episode) => {
    const profile = LC4_PROVIDER_PROFILE_MANIFEST.providers[episode.provider];
    const bindings = byProvider.get(episode.provider)!;
    return Object.freeze({
      episode_id: episode.episode_id,
      pair_id: episode.pair_id,
      pair_position: episode.pair_position,
      provider: episode.provider,
      arm: episode.arm,
      model: profile.model,
      voice: profile.voice,
      maximum_micro_usd: perEpisode,
      opportunity_binding_set_sha256: hash("hacc/lc4-dev/audio-binding-set/v1\n", bindings),
    });
  });
  if (episodes.length !== 6 || episodes.reduce((sum, episode) => sum + episode.maximum_micro_usd, 0) > maximum) {
    throw new Error("LC4-DEV episode reservations exceed the execution ceiling");
  }
  const body = {
    schema_version: 5 as const,
    runner_version: LC4_DEV_LIVE_RUNNER_VERSION,
    protocol_id: "HACC-LC4-DEV-v1" as const,
    execution_id: input.execution_id,
    created_at: input.created_at,
    source_commit: input.source_commit,
    source_tree_sha256: input.source_tree_sha256,
    corpus_sha256: corpus.artifact_sha256,
    provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    provider_session_schedule_sha256:
      LC4_DEV_PROVIDER_SESSION_SCHEDULE_SHA256,
    qualification_transport_scope_sha256: LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
    qualification_claim_boundary: "retained_gate_b_transports_only_xai_finite_manual_not_qualified" as const,
    xai_finite_manual_transport_qualification:
      "receipt_bound_pending_preflight_replay" as const,
    xai_finite_manual_gate_d: Object.freeze({
      ...input.xai_finite_manual_gate_d,
    }),
    audio_delivery_profile_sha256: LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
    audio_packetizer_contract_sha256: LC4_DEV_AUDIO_PACKETIZER_CONTRACT_SHA256,
    audio_execution_contract_sha256: LC4_DEV_AUDIO_EXECUTION_CONTRACT_SHA256,
    audio_manifest_sha256: input.audio_manifest_sha256,
    audio_bindings: Object.freeze([...input.audio_bindings]),
    episodes: Object.freeze(episodes),
    total_opportunities: LC4_DEV_LIVE_TOTAL_OPPORTUNITIES,
    maximum_total_micro_usd: maximum,
    hard_ceiling_micro_usd: LC4_DEV_LIVE_HARD_CEILING_MICRO_USD,
    retry_policy: "no_retry_after_segment_open_or_audio_submission" as const,
    evidence_boundary: Object.freeze({
      study_role: "mechanism-evidence-only" as const,
      efficacy_claim_eligible: false as const,
      confirmatory_reuse_permitted: false as const,
    }),
  };
  return freeze({ ...body, prepare_sha256: hash(PREPARE_DOMAIN, body) });
}

export type Lc4DevLivePreflightArtifact<
  Qualification extends Lc4DevQualificationAdmissionReceipt = Lc4DevQualificationAdmissionReceipt,
> = Readonly<{
  schema_version: 4;
  execution_id: string;
  checked_at: string;
  prepare_sha256: string;
  qualification_gate_sha256: string;
  qualification_terminal_root_sha256: string;
  qualification_retained_artifact_sha256: string;
  credential_identity_set_sha256: string;
  control_plane_manifest_sha256: string;
  listener_evidence_manifest_sha256: string;
  runtime_config_sha256: string;
  asr_evaluator_build_sha256: string;
  asr_evaluator_toolchain_sha256: string;
  asr_contract: IndependentAsrContract;
  asr_contract_sha256: string;
  asr_runner_trust: Lc4DevAsrRunnerTrust;
  provider_profile_manifest_sha256: string;
  qualification_transport_scope_sha256: string;
  qualification_claim_boundary: "retained_gate_b_transports_only_xai_finite_manual_not_qualified";
  audio_delivery_profile_sha256: string;
  audio_packetizer_contract_sha256: string;
  audio_execution_contract_sha256: string;
  immutable_ledger_genesis_sha256: string;
  adapter_contract: "lc4-development-realtime-v1";
  adapter_boundary: "dev_factory_unlocked_confirmatory_factory_still_frozen";
  qualification_scope_verified: true;
  all_episode_transports_qualified: true;
  xai_finite_manual_transport_qualification: "verified";
  xai_finite_manual_gate_d_receipt_sha256: string;
  xai_finite_manual_gate_d_transport_profile_sha256: string;
  xai_finite_manual_gate_d_claim_boundary:
    "transport_qualification_only_not_efficacy_evidence";
  budget_verified: true;
  audio_verified: true;
  provider_calls_authorized: true;
  authorization_scope: "six_public_development_episodes_only";
  expires_at: string;
  authorization_artifact_sha256: string;
  authority_trust_root_sha256: string;
  authorization: Lc4DevLiveAuthorizationArtifact;
  qualification: Qualification;
  xai_finite_manual_gate_d: Lc4XaiFiniteManualGateDReceipt;
  authorization_verified: true;
  preflight_sha256: string;
}>;

export type Lc4DevLiveAuthorizationBody = Readonly<{
  schema_version: 4;
  protocol_id: "HACC-LC4-DEV-v1";
  purpose: "six_public_development_episodes_only";
  execution_id: string;
  prepare_sha256: string;
  maximum_total_micro_usd: number;
  audio_manifest_sha256: string;
  qualification_terminal_root_sha256: string;
  qualification_retained_artifact_sha256: string;
  credential_identity_set_sha256: string;
  control_plane_manifest_sha256: string;
  listener_evidence_manifest_sha256: string;
  runtime_config_sha256: string;
  asr_evaluator_build_sha256: string;
  asr_evaluator_toolchain_sha256: string;
  asr_contract: IndependentAsrContract;
  asr_contract_sha256: string;
  asr_runner_trust: Lc4DevAsrRunnerTrust;
  provider_profile_manifest_sha256: string;
  qualification_transport_scope_sha256: string;
  qualification_claim_boundary: "retained_gate_b_transports_only_xai_finite_manual_not_qualified";
  xai_finite_manual_gate_d_receipt_sha256: string;
  xai_finite_manual_gate_d_plan_authority_trust_root_sha256: string;
  xai_finite_manual_gate_d_transport_profile_sha256: string;
  audio_delivery_profile_sha256: string;
  audio_packetizer_contract_sha256: string;
  audio_execution_contract_sha256: string;
  immutable_ledger_genesis_sha256: string;
  authorization_nonce_sha256: string;
  not_before: string;
  expires_at: string;
}>;

export type Lc4DevLiveAuthorizationArtifact = Readonly<{
  body: Lc4DevLiveAuthorizationBody;
  authority_public_key_spki_base64: string;
  authority_public_key_fingerprint_sha256: string;
  signature_algorithm: "Ed25519";
  signature_base64: string;
  artifact_sha256: string;
}>;

export function lc4DevLiveAuthorizationSigningBytes(body: Lc4DevLiveAuthorizationBody): Uint8Array {
  return Buffer.from(`${AUTHORIZATION_DOMAIN}${canonicalJson(body)}`, "utf8");
}

export function lc4DevLiveAuthorizationArtifactSha256(
  artifact: Omit<Lc4DevLiveAuthorizationArtifact, "artifact_sha256">,
): string {
  return hash(AUTHORIZATION_ARTIFACT_DOMAIN, artifact);
}

export {
  assertLc4DevQualificationAdmissionReceipt,
  assertLc4DevRetainedQualificationReceipt,
  createLc4DevRetainedQualificationReceipt,
  type Lc4DevQualificationAdmissionReceipt,
  type Lc4DevRetainedQualificationReceipt,
} from "./lc4-development-qualification-v3";

/** Narrow, provider-free qualification gate used by DEV preflight. */
export function assertLc4DevPreflightQualificationAdmission(
  qualification: Lc4DevQualificationAdmissionReceipt,
  checkedAt: Date,
): void {
  assertLc4DevQualificationAdmissionReceipt(qualification);
  if (!Number.isFinite(checkedAt.getTime())) {
    throw new Error("LC4-DEV qualification preflight time is invalid");
  }
  if (qualification.schema_version !== 4
    || qualification.protocol_id !== "HACC-LC4-DEV-v1"
    || qualification.qualification_protocol_id !== "HACC-LC4-v1"
    || qualification.status !== "passed"
    || canonicalJson(qualification.providers) !== canonicalJson(["openai", "gemini", "xai"])) {
    throw new Error("LC4-DEV retained qualification is not a three-provider passing terminal receipt");
  }
  if (qualification.transport_qualification_scope_sha256
    !== LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256) {
    throw new Error("LC4-DEV retained qualification transport scope is unsupported");
  }
  if (qualification.provider_profile_manifest_sha256
    !== LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256) {
    throw new Error("LC4-DEV retained qualification provider profile is stale");
  }
  if ("setup_qualifications" in qualification) {
    const completedAt = Date.parse(qualification.terminal.body.sealed_at);
    if (!Number.isFinite(completedAt)
      || completedAt > checkedAt.getTime() + 120_000
      || checkedAt.getTime() - completedAt > PROVIDER_QUALIFICATION_MAX_AGE_MS) {
      throw new Error("LC4-DEV retained qualification is stale or future-dated at preflight");
    }
  }
}

function verifyDevAuthorization(input: Readonly<{
  artifact: Lc4DevLiveAuthorizationArtifact;
  expected_authority_public_key_fingerprint_sha256: string;
  prepare: Lc4DevLivePrepareArtifact;
  qualification: Lc4DevQualificationAdmissionReceipt;
  xai_finite_manual_gate_d: Lc4XaiFiniteManualGateDReceipt;
  checked_at: string;
  credential_identity_set_sha256: string;
  control_plane_manifest_sha256: string;
  listener_evidence_manifest_sha256: string;
  runtime_config_sha256: string;
  asr_evaluator_build_sha256: string;
  asr_evaluator_toolchain_sha256: string;
  asr_contract: IndependentAsrContract;
  asr_contract_sha256: string;
  asr_runner_trust: Lc4DevAsrRunnerTrust;
  immutable_ledger_genesis_sha256: string;
}>): void {
  const { artifact, prepare, qualification, xai_finite_manual_gate_d: gateD } = input;
  assertLc4DevPreflightQualificationAdmission(qualification, new Date(input.checked_at));
  assertLc4XaiFiniteManualGateDReceipt(gateD, {
    expected_plan_trust_root_sha256:
      prepare.xai_finite_manual_gate_d.plan_authority_trust_root_sha256,
    expected_source_commit: prepare.source_commit,
    expected_source_tree_sha256: prepare.source_tree_sha256,
    expected_provider_profile_manifest_sha256:
      prepare.provider_profile_manifest_sha256,
  });
  const body = artifact.body;
  for (const [label, digest] of Object.entries({
    expected_authority_public_key_fingerprint_sha256: input.expected_authority_public_key_fingerprint_sha256,
    authorization_nonce_sha256: body.authorization_nonce_sha256,
    qualification_terminal_root_sha256: qualification.terminal_root_sha256,
    qualification_retained_artifact_sha256: qualification.retained_artifact_sha256,
  })) requireHash(digest, label);
  assertLc4DevAsrRunnerTrust(input.asr_runner_trust);
  assertLc4DevAsrRunnerTrust(body.asr_runner_trust);
  if (independentAsrContractSha256(input.asr_contract)
      !== input.asr_contract_sha256
    || independentAsrContractSha256(body.asr_contract)
      !== body.asr_contract_sha256) {
    throw new Error("LC4-DEV ASR contract differs from its canonical digest");
  }
  if (body.schema_version !== 4 || body.protocol_id !== "HACC-LC4-DEV-v1" || body.purpose !== "six_public_development_episodes_only") {
    throw new Error("LC4-DEV authorization has the wrong protocol or purpose");
  }
  assertIso(body.not_before, "LC4-DEV authorization start");
  assertIso(body.expires_at, "LC4-DEV authorization expiry");
  const checked = Date.parse(input.checked_at);
  if (checked < Date.parse(body.not_before) || checked >= Date.parse(body.expires_at)) throw new Error("LC4-DEV authorization is not active");
  if (body.execution_id !== prepare.execution_id
    || body.prepare_sha256 !== prepare.prepare_sha256
    || body.maximum_total_micro_usd !== prepare.maximum_total_micro_usd
    || body.maximum_total_micro_usd > LC4_DEV_LIVE_HARD_CEILING_MICRO_USD
    || body.audio_manifest_sha256 !== prepare.audio_manifest_sha256
    || body.qualification_terminal_root_sha256 !== qualification.terminal_root_sha256
    || body.qualification_retained_artifact_sha256 !== qualification.retained_artifact_sha256
    || body.credential_identity_set_sha256 !== input.credential_identity_set_sha256
    || body.control_plane_manifest_sha256 !== input.control_plane_manifest_sha256
    || body.listener_evidence_manifest_sha256 !== input.listener_evidence_manifest_sha256
    || body.runtime_config_sha256 !== input.runtime_config_sha256
    || body.asr_evaluator_build_sha256 !== input.asr_evaluator_build_sha256
    || body.asr_evaluator_toolchain_sha256 !== input.asr_evaluator_toolchain_sha256
    || body.asr_contract_sha256 !== input.asr_contract_sha256
    || canonicalJson(body.asr_contract) !== canonicalJson(input.asr_contract)
    || canonicalJson(body.asr_runner_trust)
      !== canonicalJson(input.asr_runner_trust)
    || body.provider_profile_manifest_sha256 !== prepare.provider_profile_manifest_sha256
    || body.qualification_transport_scope_sha256 !== prepare.qualification_transport_scope_sha256
    || body.qualification_transport_scope_sha256 !== qualification.transport_qualification_scope_sha256
    || body.qualification_claim_boundary !== prepare.qualification_claim_boundary
    || body.xai_finite_manual_gate_d_receipt_sha256
      !== prepare.xai_finite_manual_gate_d.receipt_sha256
    || body.xai_finite_manual_gate_d_receipt_sha256 !== gateD.receipt_sha256
    || body.xai_finite_manual_gate_d_plan_authority_trust_root_sha256
      !== prepare.xai_finite_manual_gate_d.plan_authority_trust_root_sha256
    || body.xai_finite_manual_gate_d_transport_profile_sha256
      !== prepare.xai_finite_manual_gate_d.transport_profile_sha256
    || body.xai_finite_manual_gate_d_transport_profile_sha256
      !== gateD.transport_profile_sha256
    || body.audio_delivery_profile_sha256 !== prepare.audio_delivery_profile_sha256
    || body.audio_packetizer_contract_sha256 !== prepare.audio_packetizer_contract_sha256
    || body.audio_execution_contract_sha256 !== prepare.audio_execution_contract_sha256
    || body.immutable_ledger_genesis_sha256 !== input.immutable_ledger_genesis_sha256) {
    throw new Error("LC4-DEV authorization differs from the prepared plan, retained qualification, credentials, audio, or evidence roots");
  }
  if (artifact.signature_algorithm !== "Ed25519") throw new Error("LC4-DEV authorization must use Ed25519");
  const keyBytes = Buffer.from(artifact.authority_public_key_spki_base64, "base64");
  const fingerprint = sha256Hex(keyBytes);
  if (fingerprint !== artifact.authority_public_key_fingerprint_sha256
    || fingerprint !== input.expected_authority_public_key_fingerprint_sha256) {
    throw new Error("LC4-DEV authorization signer is not the pinned trust root");
  }
  const withoutHash = {
    body,
    authority_public_key_spki_base64: artifact.authority_public_key_spki_base64,
    authority_public_key_fingerprint_sha256: artifact.authority_public_key_fingerprint_sha256,
    signature_algorithm: artifact.signature_algorithm,
    signature_base64: artifact.signature_base64,
  };
  if (lc4DevLiveAuthorizationArtifactSha256(withoutHash) !== artifact.artifact_sha256) {
    throw new Error("LC4-DEV authorization artifact hash mismatch");
  }
  let key;
  try {
    key = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  } catch {
    throw new Error("LC4-DEV authorization public key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519"
    || !verify(null, lc4DevLiveAuthorizationSigningBytes(body), key, Buffer.from(artifact.signature_base64, "base64"))) {
    throw new Error("LC4-DEV authorization signature is invalid");
  }
}

export function createLc4DevLivePreflightArtifact<
  Qualification extends Lc4DevQualificationAdmissionReceipt,
>(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  checked_at: string;
  qualification_gate_sha256: string;
  qualification: Qualification;
  xai_finite_manual_gate_d: Lc4XaiFiniteManualGateDReceipt;
  credential_identity_set_sha256: string;
  control_plane_manifest_sha256: string;
  listener_evidence_manifest_sha256: string;
  runtime_config_sha256: string;
  asr_evaluator_build_sha256: string;
  asr_evaluator_toolchain_sha256: string;
  asr_contract: IndependentAsrContract;
  asr_contract_sha256: string;
  asr_runner_trust: Lc4DevAsrRunnerTrust;
  immutable_ledger_genesis_sha256: string;
  audio_manifest_sha256: string;
  authorization: Lc4DevLiveAuthorizationArtifact;
  expected_authority_public_key_fingerprint_sha256: string;
}>): Lc4DevLivePreflightArtifact<Qualification> {
  assertLc4DevLivePrepareArtifact(input.prepare);
  assertIso(input.checked_at, "LC4-DEV preflight time");
  for (const [label, digest] of Object.entries({
    qualification_gate_sha256: input.qualification_gate_sha256,
    credential_identity_set_sha256: input.credential_identity_set_sha256,
    control_plane_manifest_sha256: input.control_plane_manifest_sha256,
    listener_evidence_manifest_sha256: input.listener_evidence_manifest_sha256,
    runtime_config_sha256: input.runtime_config_sha256,
    asr_evaluator_build_sha256: input.asr_evaluator_build_sha256,
    asr_evaluator_toolchain_sha256: input.asr_evaluator_toolchain_sha256,
    asr_contract_sha256: input.asr_contract_sha256,
    immutable_ledger_genesis_sha256: input.immutable_ledger_genesis_sha256,
  })) requireHash(digest, label);
  if (independentAsrContractSha256(input.asr_contract)
      !== input.asr_contract_sha256) {
    throw new Error("LC4-DEV preflight ASR contract hash mismatch");
  }
  assertLc4DevAsrRunnerTrust(input.asr_runner_trust);
  if (input.audio_manifest_sha256 !== input.prepare.audio_manifest_sha256) throw new Error("LC4-DEV preflight audio manifest differs from prepare");
  if (input.qualification_gate_sha256 !== input.qualification.retained_artifact_sha256) {
    throw new Error("LC4-DEV qualification gate must be the retained passing qualification artifact");
  }
  assertLc4XaiFiniteManualGateDReceipt(input.xai_finite_manual_gate_d, {
    expected_plan_trust_root_sha256:
      input.prepare.xai_finite_manual_gate_d.plan_authority_trust_root_sha256,
    expected_source_commit: input.prepare.source_commit,
    expected_source_tree_sha256: input.prepare.source_tree_sha256,
    expected_provider_profile_manifest_sha256:
      input.prepare.provider_profile_manifest_sha256,
  });
  if (input.xai_finite_manual_gate_d.receipt_sha256
    !== input.prepare.xai_finite_manual_gate_d.receipt_sha256) {
    throw new Error("LC4-DEV xAI finite-manual Gate D differs from prepare");
  }
  verifyDevAuthorization({
    artifact: input.authorization,
    expected_authority_public_key_fingerprint_sha256: input.expected_authority_public_key_fingerprint_sha256,
    prepare: input.prepare,
    qualification: input.qualification,
    xai_finite_manual_gate_d: input.xai_finite_manual_gate_d,
    checked_at: input.checked_at,
    credential_identity_set_sha256: input.credential_identity_set_sha256,
    control_plane_manifest_sha256: input.control_plane_manifest_sha256,
    listener_evidence_manifest_sha256: input.listener_evidence_manifest_sha256,
    runtime_config_sha256: input.runtime_config_sha256,
    asr_evaluator_build_sha256: input.asr_evaluator_build_sha256,
    asr_evaluator_toolchain_sha256: input.asr_evaluator_toolchain_sha256,
    asr_contract: input.asr_contract,
    asr_contract_sha256: input.asr_contract_sha256,
    asr_runner_trust: input.asr_runner_trust,
    immutable_ledger_genesis_sha256: input.immutable_ledger_genesis_sha256,
  });
  const body = {
    schema_version: 4 as const,
    execution_id: input.prepare.execution_id,
    checked_at: input.checked_at,
    prepare_sha256: input.prepare.prepare_sha256,
    qualification_gate_sha256: input.qualification_gate_sha256,
    qualification_terminal_root_sha256: input.qualification.terminal_root_sha256,
    qualification_retained_artifact_sha256: input.qualification.retained_artifact_sha256,
    credential_identity_set_sha256: input.credential_identity_set_sha256,
    control_plane_manifest_sha256: input.control_plane_manifest_sha256,
    listener_evidence_manifest_sha256: input.listener_evidence_manifest_sha256,
    runtime_config_sha256: input.runtime_config_sha256,
    asr_evaluator_build_sha256: input.asr_evaluator_build_sha256,
    asr_evaluator_toolchain_sha256: input.asr_evaluator_toolchain_sha256,
    asr_contract: input.asr_contract,
    asr_contract_sha256: input.asr_contract_sha256,
    asr_runner_trust: input.asr_runner_trust,
    provider_profile_manifest_sha256: input.prepare.provider_profile_manifest_sha256,
    qualification_transport_scope_sha256: input.prepare.qualification_transport_scope_sha256,
    qualification_claim_boundary: input.prepare.qualification_claim_boundary,
    xai_finite_manual_gate_d_receipt_sha256:
      input.xai_finite_manual_gate_d.receipt_sha256,
    xai_finite_manual_gate_d_transport_profile_sha256:
      input.xai_finite_manual_gate_d.transport_profile_sha256,
    xai_finite_manual_gate_d_claim_boundary:
      input.xai_finite_manual_gate_d.claim_boundary,
    audio_delivery_profile_sha256: input.prepare.audio_delivery_profile_sha256,
    audio_packetizer_contract_sha256: input.prepare.audio_packetizer_contract_sha256,
    audio_execution_contract_sha256: input.prepare.audio_execution_contract_sha256,
    immutable_ledger_genesis_sha256: input.immutable_ledger_genesis_sha256,
    adapter_contract: "lc4-development-realtime-v1" as const,
    adapter_boundary: "dev_factory_unlocked_confirmatory_factory_still_frozen" as const,
    qualification_scope_verified: true as const,
    all_episode_transports_qualified: true as const,
    xai_finite_manual_transport_qualification: "verified" as const,
    budget_verified: true as const,
    audio_verified: true as const,
    provider_calls_authorized: true as const,
    authorization_scope: "six_public_development_episodes_only" as const,
    expires_at: input.authorization.body.expires_at,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    authority_trust_root_sha256: input.expected_authority_public_key_fingerprint_sha256,
    authorization: input.authorization,
    qualification: input.qualification,
    xai_finite_manual_gate_d: input.xai_finite_manual_gate_d,
    authorization_verified: true as const,
  };
  return freeze({ ...body, preflight_sha256: hash(PREFLIGHT_DOMAIN, body) });
}

export function assertLc4DevLivePrepareArtifact(value: Lc4DevLivePrepareArtifact): void {
  const { prepare_sha256: claimed, ...body } = value;
  if (hash(PREPARE_DOMAIN, body) !== claimed) throw new Error("LC4-DEV prepare artifact hash mismatch");
  if (value.protocol_id !== "HACC-LC4-DEV-v1" || value.episodes.length !== 6 || value.audio_bindings.length !== 180) {
    throw new Error("LC4-DEV prepare artifact shape drifted");
  }
  if (
    value.provider_session_schedule_sha256
      !== LC4_DEV_PROVIDER_SESSION_SCHEDULE_SHA256
  ) {
    throw new Error("LC4-DEV prepare artifact provider-session schedule drifted");
  }
  if (value.provider_profile_manifest_sha256
    !== LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256) {
    throw new Error("LC4-DEV prepare artifact provider profile is stale");
  }
  if (value.maximum_total_micro_usd > LC4_DEV_LIVE_HARD_CEILING_MICRO_USD) throw new Error("LC4-DEV prepare artifact exceeds $15");
  const rebuilt = createLc4DevLivePrepareArtifact({
    execution_id: value.execution_id,
    created_at: value.created_at,
    source_commit: value.source_commit,
    source_tree_sha256: value.source_tree_sha256,
    audio_manifest_sha256: value.audio_manifest_sha256,
    audio_bindings: value.audio_bindings,
    maximum_total_micro_usd: value.maximum_total_micro_usd,
    xai_finite_manual_gate_d: value.xai_finite_manual_gate_d,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(value)) throw new Error("LC4-DEV prepare artifact is not canonical or internally consistent");
}

export function assertLc4DevLivePreflightArtifact<
  Qualification extends Lc4DevQualificationAdmissionReceipt,
>(value: Lc4DevLivePreflightArtifact<Qualification>, prepare: Lc4DevLivePrepareArtifact, now: Date): void {
  const { preflight_sha256: claimed, ...body } = value;
  if (hash(PREFLIGHT_DOMAIN, body) !== claimed || value.prepare_sha256 !== prepare.prepare_sha256) {
    throw new Error("LC4-DEV preflight artifact hash or prepare binding mismatch");
  }
  if (value.provider_calls_authorized !== true || value.authorization_scope !== "six_public_development_episodes_only") {
    throw new Error("LC4-DEV preflight lacks narrow provider authorization");
  }
  if (value.qualification_scope_verified !== true
    || value.all_episode_transports_qualified !== true
    || value.xai_finite_manual_transport_qualification !== "verified"
    || value.xai_finite_manual_gate_d_receipt_sha256
      !== prepare.xai_finite_manual_gate_d.receipt_sha256
    || value.xai_finite_manual_gate_d_transport_profile_sha256
      !== prepare.xai_finite_manual_gate_d.transport_profile_sha256
    || value.xai_finite_manual_gate_d_claim_boundary
      !== "transport_qualification_only_not_efficacy_evidence"
    || value.qualification_transport_scope_sha256 !== prepare.qualification_transport_scope_sha256
    || value.qualification_claim_boundary !== prepare.qualification_claim_boundary) {
    throw new Error("LC4-DEV preflight overstates retained transport qualification");
  }
  if (now.getTime() >= Date.parse(value.expires_at)) throw new Error("LC4-DEV preflight has expired");
  const rebuilt = createLc4DevLivePreflightArtifact({
    prepare,
    checked_at: value.checked_at,
    qualification_gate_sha256: value.qualification_gate_sha256,
    qualification: value.qualification,
    xai_finite_manual_gate_d: value.xai_finite_manual_gate_d,
    credential_identity_set_sha256: value.credential_identity_set_sha256,
    control_plane_manifest_sha256: value.control_plane_manifest_sha256,
    listener_evidence_manifest_sha256: value.listener_evidence_manifest_sha256,
    runtime_config_sha256: value.runtime_config_sha256,
    asr_evaluator_build_sha256: value.asr_evaluator_build_sha256,
    asr_evaluator_toolchain_sha256: value.asr_evaluator_toolchain_sha256,
    asr_contract: value.asr_contract,
    asr_contract_sha256: value.asr_contract_sha256,
    asr_runner_trust: value.asr_runner_trust,
    immutable_ledger_genesis_sha256: value.immutable_ledger_genesis_sha256,
    audio_manifest_sha256: prepare.audio_manifest_sha256,
    authorization: value.authorization,
    expected_authority_public_key_fingerprint_sha256: value.authority_trust_root_sha256,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(value)) throw new Error("LC4-DEV preflight artifact is not canonical or internally consistent");
}

export type Lc4DevResponseControl =
  | Readonly<{ kind: "native_context"; instructions: string; instructions_sha256: string }>
  | Readonly<{ kind: "hacc_response_plan"; plan: HaccResponsePlan }>;

export type Lc4DevProviderSegmentOrdinal = 1 | 2 | 3 | 4 | 5 | 6;

export type Lc4DevControlReceipt = Readonly<{
  schema_version: 1;
  manifest_sha256: string;
  episode_id: string;
  arm: Arm;
  opportunity_id: string;
  opportunity_index: number;
  previous_exchange_sha256: string | null;
  response_control: Lc4DevResponseControl;
  flow_state_sha256: string;
  gateway_transcript_head_sha256: string;
  tool_world_state_sha256: string;
  worker_state_sha256: string;
  repair_state_sha256: string;
  native_continuity_state_sha256: string;
  control_receipt_sha256: string;
}>;

export type Lc4DevImmutableLedgerEvent = Readonly<{
  sequence: number;
  observed_at: string;
  event_type: "episode_opened" | "segment_open_intent" | "segment_opened" | "caller_branch_selected" | "audio_submitted" | "opportunity_failed" | "segment_failed" | "repair_decided" | "repair_audio_submitted" | "repair_completed" | "opportunity_completed" | "episode_terminal";
  episode_id: string;
  opportunity_id: string | null;
  payload_sha256: string;
  payload_evidence: Lc4DevReplayArtifactReference;
  evidence_references: readonly Lc4DevReplayArtifactReference[];
  previous_event_sha256: string | null;
  event_sha256: string;
}>;

export type Lc4DevLiveRunArtifact = Readonly<{
  schema_version: 3;
  execution_id: string;
  prepare_sha256: string;
  preflight_sha256: string;
  started_at: string;
  completed_at: string;
  status: "completed" | "failed";
  episodes_started: number;
  episodes_completed: number;
  provider_segment_intent_count: number;
  provider_segment_opened_count: number;
  opportunities_submitted: number;
  opportunities_completed: number;
  response_generations_requested: number;
  provider_calls_started: number;
  response_generations_completed: number;
  /** Backward-compatible total of response requests that crossed the adapter boundary. */
  provider_calls_made: number;
  repair_playbacks: number;
  total_response_generations: number;
  paid_retry_count: 0;
  maximum_total_micro_usd: number;
  retained_caller_audio: number;
  retained_assistant_audio: number;
  listener_evidence_count: number;
  mechanism_receipt_count: number;
  episode_finalization_count: number;
  replay_evidence_reference_count: number;
  failure_class:
    | "pre-open"
    | "continuity_compile"
    | "transport"
    | "timeout"
    | "evidence"
    | null;
  failure_message_sha256: string | null;
  ledger: readonly Lc4DevImmutableLedgerEvent[];
  ledger_head_sha256: string | null;
  run_sha256: string;
}>;

/**
 * Immutable cumulative custody after one or more complete cells. It contains
 * only terminal episode prefixes, so a later process can append the next
 * frozen cell without synthesizing or replaying a provider session.
 */
export type Lc4DevLiveRunPrefixArtifact = Readonly<{
  schema_version: 1;
  execution_id: string;
  prepare_sha256: string;
  preflight_sha256: string;
  started_at: string;
  completed_episode_ids: readonly string[];
  previous_prefix_sha256: string | null;
  episodes_started: number;
  episodes_completed: number;
  provider_segment_intent_count: number;
  provider_segment_opened_count: number;
  opportunities_submitted: number;
  opportunities_completed: number;
  response_generations_requested: number;
  provider_calls_started: number;
  response_generations_completed: number;
  repair_playbacks: number;
  retained_caller_audio: number;
  retained_assistant_audio: number;
  listener_evidence_count: number;
  mechanism_receipt_count: number;
  episode_finalization_count: number;
  ledger: readonly Lc4DevImmutableLedgerEvent[];
  ledger_head_sha256: string;
  prefix_sha256: string;
}>;

export type Lc4DevLiveRunnerDependencies = Readonly<{
  adapter: Lc4DevelopmentRealtimeAdapter;
  caller_audio: Readonly<{ load(binding: Lc4DevCallerAudioBinding): Promise<Uint8Array> }>;
  caller_branch: Readonly<{
    matrix: Lc4DevCallerBranchMatrixArtifact;
    trust: Readonly<{ key_id: string; public_key_pem: string }>;
    select(input: Readonly<{
      episode: Lc4DevLiveEpisodePlan;
      canonical_opportunity: Lc4PublicDevOpportunity;
    }>): Promise<Readonly<{
      decision: Lc4DevCallerBranchDecision;
      opportunity: Lc4PublicDevOpportunity;
      pcm: Uint8Array;
      evidence: Lc4DevReplayArtifactReference;
    }>>;
  }>;
  retention: Readonly<{ retain(input: Readonly<{ episode_id: string; opportunity_id: string; direction: "caller_input" | "caller_repair" | "assistant_output" | "assistant_repair_output"; pcm: Uint8Array }>): Promise<Readonly<{ artifact_sha256: string; byte_length: number; evidence: Lc4DevReplayArtifactReference }>> }>;
  control: Readonly<{ next(input: Readonly<{ episode: Lc4DevLiveEpisodePlan; opportunity: Lc4PublicDevOpportunity; previous_exchange_sha256: string | null }>): Promise<Readonly<{ receipt: Lc4DevControlReceipt; evidence: Lc4DevReplayArtifactReference }>> }>;
  repair: Readonly<Record<LiveStsProvider, Lc4DevRepairPlaybackController>>;
  ledger: Readonly<{ append(event: Lc4DevImmutableLedgerEvent): Promise<void> }>;
  evidence: Lc4DevReplayEvidenceStore;
  finalization: Readonly<{
    finalizeEpisode(input: Readonly<{
      episode: Lc4DevLiveEpisodePlan;
      completed_opportunities: number;
      response_generations: number;
      repair_playbacks: number;
      ledger_head_before_terminal_sha256: string;
      segment_finalizations: readonly Lc4DevReplayArtifactReference[];
    }>): Promise<Lc4DevReplayArtifactReference>;
  }>;
  cell_checkpoint?: Readonly<{
    beforeFirstNetworkEmission(input: Readonly<{
      episode: Lc4DevLiveEpisodePlan;
      prior_run_ledger_head_sha256: string | null;
    }>): Promise<void>;
    afterEpisodeTerminal(input: Readonly<{
      episode: Lc4DevLiveEpisodePlan;
      episode_finalization_sha256: string;
      terminal_run_ledger_head_sha256: string;
      completed_prefix: Lc4DevLiveRunPrefixArtifact;
    }>): Promise<void>;
  }>;
  now(): Date;
}>;

async function bounded<T>(label: string, durationMs: number, operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${label}`)), durationMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Segment setup owns a potentially paid provider socket. Revoking the setup
 * deadline aborts adapters that support cancellation and also installs a
 * late-owner cleanup for test doubles or provider SDKs that resolve after the
 * deadline. A timed-out setup can therefore never leak or admit a session.
 */
async function boundedSegmentOpen(
  durationMs: number,
  operation: (signal: AbortSignal) => Promise<Lc4DevelopmentRealtimeSession>,
): Promise<Lc4DevelopmentRealtimeSession> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const operationPromise = operation(controller.signal);
  void operationPromise.then(async (session) => {
    if (timedOut) await session.close().catch(() => undefined);
  }).catch(() => undefined);
  try {
    return await Promise.race([
      operationPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("timeout:segment-open"));
        }, durationMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * These errors are emitted by the authorized adapter's rotation validators
 * before its realtime client factory is invoked. Keep this allowlist narrow:
 * an unrecognized segment-open failure remains transport-classified rather
 * than being optimistically described as a provider-free local failure.
 */
const LOCAL_CONTINUITY_COMPILE_ERROR_PREFIXES = Object.freeze([
  "LC4 rotation ",
  "LC4 reopened segment ",
  "LC4 first segment ",
  "LC4 native continuity ",
  "LC4 HACC rotation ",
  "LC4 provider sessions must rotate ",
] as const);

function isLocalContinuityCompileFailure(error: unknown): boolean {
  return error instanceof Error
    && LOCAL_CONTINUITY_COMPILE_ERROR_PREFIXES.some(
      (prefix) => error.message.startsWith(prefix),
    );
}

function assertControl(input: Readonly<{
  receipt: Lc4DevControlReceipt;
  manifest_sha256: string;
  episode: Lc4DevLiveEpisodePlan;
  opportunity: Lc4PublicDevOpportunity;
  previous_exchange_sha256: string | null;
}>): void {
  const { receipt } = input;
  for (const [label, digest] of Object.entries({
    flow_state_sha256: receipt.flow_state_sha256,
    gateway_transcript_head_sha256: receipt.gateway_transcript_head_sha256,
    tool_world_state_sha256: receipt.tool_world_state_sha256,
    worker_state_sha256: receipt.worker_state_sha256,
    repair_state_sha256: receipt.repair_state_sha256,
    native_continuity_state_sha256: receipt.native_continuity_state_sha256,
    control_receipt_sha256: receipt.control_receipt_sha256,
  })) requireHash(digest, label);
  if (receipt.schema_version !== 1
    || receipt.manifest_sha256 !== input.manifest_sha256
    || receipt.episode_id !== input.episode.episode_id
    || receipt.arm !== input.episode.arm
    || receipt.opportunity_id !== input.opportunity.id
    || receipt.opportunity_index !== input.opportunity.index
    || receipt.previous_exchange_sha256 !== input.previous_exchange_sha256) {
    throw new Error(
      "LC4-DEV control authority differs from its manifest, episode, opportunity, or prior exchange",
    );
  }
  const { control_receipt_sha256: claimedReceipt, ...receiptBody } = receipt;
  if (claimedReceipt !== hash(CONTROL_RECEIPT_DOMAIN, receiptBody)) {
    throw new Error("LC4-DEV control authority receipt hash mismatch");
  }
  if ((input.episode.arm === "native" && receipt.response_control.kind !== "native_context")
    || (input.episode.arm === "hacc" && receipt.response_control.kind !== "hacc_response_plan")) {
    throw new Error("LC4-DEV response control differs from randomized arm");
  }
  if (receipt.response_control.kind === "native_context"
    && (!receipt.response_control.instructions.trim()
      || sha256Hex(receipt.response_control.instructions) !== receipt.response_control.instructions_sha256)) {
    throw new Error("LC4-DEV native context hash mismatch");
  }
}

export function assertLc4DevRepairPlaybackReceiptBinding(input: Readonly<{
  receipt: Lc4DevRepairPlaybackReceipt;
  episode_id: string;
  opportunity_id: string;
  opportunity_index: number;
  decision_receipt_sha256: string;
  repair: Lc4DevRepairPlayback;
  repair_exchange: Pick<
    Lc4DevExchangeEvidence,
    | "provider_exchange_sha256"
    | "listener_evidence_sha256"
    | "playback_authority_receipt_sha256"
  >;
}>): void {
  const { playback_receipt_sha256: claimedReceipt, ...receiptBody } =
    input.receipt;
  requireHash(claimedReceipt, "LC4-DEV repair playback receipt");
  if (claimedReceipt !== hash(REPAIR_PLAYBACK_DOMAIN, receiptBody)
    || input.receipt.schema_version !== 1
    || input.receipt.protocol_id !== "HACC-LC4-DEV-v1"
    || input.receipt.episode_id !== input.episode_id
    || input.receipt.canonical_opportunity_id !== input.opportunity_id
    || input.receipt.canonical_ordinal !== input.opportunity_index
    || input.receipt.canonical_horizon !== 60
    || input.receipt.advances_canonical_horizon !== false
    || input.receipt.recursive_repair_observation !== null
    || input.receipt.decision_receipt_sha256
      !== input.decision_receipt_sha256
    || input.receipt.repair_pcm_id !== input.repair.repair_pcm_id
    || input.receipt.submitted_pcm_sha256 !== input.repair.pcm_sha256
    || input.receipt.submitted_pcm_byte_length !== input.repair.pcm_byte_length
    || input.receipt.submitted_sample_rate_hz !== input.repair.sample_rate_hz
    || input.receipt.provider_exchange_sha256
      !== input.repair_exchange.provider_exchange_sha256
    || input.receipt.listener_evidence_sha256
      !== input.repair_exchange.listener_evidence_sha256
    || input.receipt.playback_authority_receipt_sha256
      !== input.repair_exchange.playback_authority_receipt_sha256) {
    throw new Error(
      "LC4-DEV repair playback receipt differs from its selected repair, exchange, or decision",
    );
  }
}

function assertCallerBranchExchangeAuthority(input: Readonly<{
  projection: JsonValue;
  decision: Lc4DevCallerBranchDecision | null;
  decision_evidence_sha256: string | null;
  caller_pcm_sha256: string;
  caller_pcm_byte_length: number;
}>): void {
  if (input.projection === null || Array.isArray(input.projection) || typeof input.projection !== "object") {
    throw new Error("LC4-DEV provider exchange replay projection is not an object");
  }
  const projection = input.projection as Record<string, JsonValue>;
  const authority = projection.caller_branch_authority;
  if (input.decision === null) {
    if (authority !== null || projection.caller_branch_decision_sha256 !== null) {
      throw new Error("LC4-DEV non-branch exchange unexpectedly claims caller branch authority");
    }
    return;
  }
  if (authority === null || Array.isArray(authority) || typeof authority !== "object") {
    throw new Error("LC4-DEV branch exchange omitted normalized caller branch authority");
  }
  const normalized = authority as Record<string, JsonValue>;
  const decision = input.decision;
  if (projection.caller_pcm_sha256 !== input.caller_pcm_sha256
    || projection.caller_pcm_byte_length !== input.caller_pcm_byte_length
    || projection.caller_branch_decision_sha256 !== decision.decision_sha256
    || normalized.decision_sha256 !== decision.decision_sha256
    || normalized.decision_evidence_sha256 !== input.decision_evidence_sha256
    || normalized.matrix_artifact_sha256 !== decision.matrix_artifact_sha256
    || normalized.source_id !== decision.source_id
    || normalized.source_text_sha256 !== decision.source_text_sha256
    || normalized.prior_outcome !== decision.prior_outcome
    || normalized.prior_receipt_sha256 !== decision.prior_receipt_sha256
    || normalized.branch_intent !== decision.branch_intent
    || normalized.reconciliation_audio_selected !== decision.reconciliation_audio_selected) {
    throw new Error("LC4-DEV branch exchange replay authority differs from its decision and exact caller PCM");
  }
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be one canonical ISO timestamp`);
  }
}

export function assertLc4DevLiveRunPrefixArtifact(
  prefix: Lc4DevLiveRunPrefixArtifact,
  prepare: Lc4DevLivePrepareArtifact,
  preflight: Lc4DevLivePreflightArtifact<Lc4DevQualificationAdmissionReceipt>,
): void {
  const { prefix_sha256: claimed, ...body } = prefix;
  if (prefix.schema_version !== 1
    || claimed !== hash(CELL_PREFIX_DOMAIN, body)
    || prefix.execution_id !== prepare.execution_id
    || prefix.prepare_sha256 !== prepare.prepare_sha256
    || prefix.preflight_sha256 !== preflight.preflight_sha256) {
    throw new Error("LC4-DEV completed-cell prefix identity or hash is invalid");
  }
  assertCanonicalTimestamp(prefix.started_at, "LC4-DEV completed-cell prefix started_at");
  const count = prefix.completed_episode_ids.length;
  if (count < 1 || count > LC4_DEV_LIVE_EPISODES
    || canonicalJson(prefix.completed_episode_ids)
      !== canonicalJson(prepare.episodes.slice(0, count).map((episode) => episode.episode_id))) {
    throw new Error("LC4-DEV completed cells are not the exact frozen leading schedule");
  }
  if ((count === 1) !== (prefix.previous_prefix_sha256 === null)) {
    throw new Error("LC4-DEV completed-cell prefix chain boundary is invalid");
  }
  if (prefix.previous_prefix_sha256 !== null) {
    requireHash(prefix.previous_prefix_sha256, "LC4-DEV previous completed-cell prefix");
  }
  const exact = {
    episodes_started: count,
    episodes_completed: count,
    provider_segment_intent_count: count * LC4_DEV_PROVIDER_SEGMENTS_PER_EPISODE,
    provider_segment_opened_count: count * LC4_DEV_PROVIDER_SEGMENTS_PER_EPISODE,
    opportunities_submitted: count * LC4_DEV_LIVE_OPPORTUNITIES_PER_EPISODE,
    opportunities_completed: count * LC4_DEV_LIVE_OPPORTUNITIES_PER_EPISODE,
    mechanism_receipt_count: count * LC4_DEV_LIVE_OPPORTUNITIES_PER_EPISODE,
    episode_finalization_count: count,
  } as const;
  for (const [key, expected] of Object.entries(exact)) {
    if (prefix[key as keyof typeof exact] !== expected) {
      throw new Error(`LC4-DEV completed-cell prefix ${key} is not exact`);
    }
  }
  const expectedGenerations = count * LC4_DEV_LIVE_OPPORTUNITIES_PER_EPISODE
    + prefix.repair_playbacks;
  if (!Number.isSafeInteger(prefix.repair_playbacks) || prefix.repair_playbacks < 0
    || prefix.repair_playbacks > count * LC4_DEV_LIVE_OPPORTUNITIES_PER_EPISODE
    || prefix.response_generations_requested !== expectedGenerations
    || prefix.provider_calls_started !== expectedGenerations
    || prefix.response_generations_completed !== expectedGenerations
    || prefix.retained_caller_audio !== expectedGenerations
    || prefix.retained_assistant_audio !== expectedGenerations
    || prefix.listener_evidence_count !== expectedGenerations) {
    throw new Error("LC4-DEV completed-cell prefix generation and retention accounting differs");
  }
  let previous: string | null = null;
  const eventCounts = new Map<Lc4DevImmutableLedgerEvent["event_type"], number>();
  const allowedEpisodes = new Set(prefix.completed_episode_ids);
  for (const [index, event] of prefix.ledger.entries()) {
    const { event_sha256: eventClaim, ...eventBody } = event;
    if (event.sequence !== index + 1 || event.previous_event_sha256 !== previous
      || eventClaim !== hash(LEDGER_EVENT_DOMAIN, eventBody)
      || !allowedEpisodes.has(event.episode_id)) {
      throw new Error("LC4-DEV completed-cell prefix ledger is forked, mutated, or out of horizon");
    }
    eventCounts.set(event.event_type, (eventCounts.get(event.event_type) ?? 0) + 1);
    previous = event.event_sha256;
  }
  if (prefix.ledger.length === 0 || previous !== prefix.ledger_head_sha256
    || eventCounts.get("episode_opened") !== count
    || eventCounts.get("episode_terminal") !== count
    || eventCounts.get("segment_open_intent") !== count * 6
    || eventCounts.get("segment_opened") !== count * 6
    || eventCounts.get("opportunity_completed") !== count * 60
    || eventCounts.get("repair_decided") !== count * 60
    || (eventCounts.get("repair_audio_submitted") ?? 0) !== prefix.repair_playbacks
    || (eventCounts.get("repair_completed") ?? 0) !== prefix.repair_playbacks) {
    throw new Error("LC4-DEV completed-cell prefix ledger horizon or terminal head is incomplete");
  }
}

function createLc4DevLiveRunPrefixArtifact(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  preflight: Lc4DevLivePreflightArtifact<Lc4DevQualificationAdmissionReceipt>;
  started_at: string;
  previous_prefix_sha256: string | null;
  episodes_started: number;
  episodes_completed: number;
  provider_segment_intent_count: number;
  provider_segment_opened_count: number;
  opportunities_submitted: number;
  opportunities_completed: number;
  response_generations_requested: number;
  provider_calls_started: number;
  response_generations_completed: number;
  repair_playbacks: number;
  retained_caller_audio: number;
  retained_assistant_audio: number;
  listener_evidence_count: number;
  mechanism_receipt_count: number;
  episode_finalization_count: number;
  ledger: readonly Lc4DevImmutableLedgerEvent[];
  ledger_head_sha256: string;
}>): Lc4DevLiveRunPrefixArtifact {
  const body = freeze({
    schema_version: 1 as const,
    execution_id: input.prepare.execution_id,
    prepare_sha256: input.prepare.prepare_sha256,
    preflight_sha256: input.preflight.preflight_sha256,
    started_at: input.started_at,
    completed_episode_ids: input.prepare.episodes
      .slice(0, input.episodes_completed).map((episode) => episode.episode_id),
    previous_prefix_sha256: input.previous_prefix_sha256,
    episodes_started: input.episodes_started,
    episodes_completed: input.episodes_completed,
    provider_segment_intent_count: input.provider_segment_intent_count,
    provider_segment_opened_count: input.provider_segment_opened_count,
    opportunities_submitted: input.opportunities_submitted,
    opportunities_completed: input.opportunities_completed,
    response_generations_requested: input.response_generations_requested,
    provider_calls_started: input.provider_calls_started,
    response_generations_completed: input.response_generations_completed,
    repair_playbacks: input.repair_playbacks,
    retained_caller_audio: input.retained_caller_audio,
    retained_assistant_audio: input.retained_assistant_audio,
    listener_evidence_count: input.listener_evidence_count,
    mechanism_receipt_count: input.mechanism_receipt_count,
    episode_finalization_count: input.episode_finalization_count,
    ledger: input.ledger,
    ledger_head_sha256: input.ledger_head_sha256,
  });
  const artifact = freeze({ ...body, prefix_sha256: hash(CELL_PREFIX_DOMAIN, body) });
  assertLc4DevLiveRunPrefixArtifact(artifact, input.prepare, input.preflight);
  return artifact;
}

export type Lc4DevLiveRunSliceResult =
  | Readonly<{ kind: "completed_prefix"; prefix: Lc4DevLiveRunPrefixArtifact }>
  | Readonly<{ kind: "terminal_run"; run: Lc4DevLiveRunArtifact }>;

export async function executeLc4DevLiveRunSlice(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  preflight: Lc4DevLivePreflightArtifact<Lc4DevQualificationAdmissionReceipt>;
  dependencies: Lc4DevLiveRunnerDependencies;
  completed_prefix?: Lc4DevLiveRunPrefixArtifact;
  maximum_new_cells: number;
}>): Promise<Lc4DevLiveRunSliceResult> {
  assertLc4DevLivePrepareArtifact(input.prepare);
  assertLc4DevLivePreflightArtifact(input.preflight, input.prepare, input.dependencies.now());
  if (input.dependencies.adapter.kind !== "lc4-development-realtime-v1"
    || input.dependencies.adapter.factory_id !== "lc4-production-provider-adapter/dev-authorized-v1") {
    throw new Error("LC4-DEV runner received an adapter outside the authorized DEV factory boundary");
  }
  if (input.dependencies.adapter.preflight_sha256 !== input.preflight.preflight_sha256
    || input.dependencies.adapter.maximum_total_micro_usd !== input.prepare.maximum_total_micro_usd) {
    throw new Error("LC4-DEV realtime adapter is not bound to this preflight and $15-or-lower plan");
  }
  assertLc4DevCallerBranchMatrixArtifact(
    input.dependencies.caller_branch.matrix,
    input.dependencies.caller_branch.trust,
  );
  if (input.dependencies.caller_branch.matrix.audio_manifest_sha256 !== input.prepare.audio_manifest_sha256) {
    throw new Error("LC4-DEV caller branch matrix differs from the prepare-bound audio manifest");
  }
  const corpus = createLc4PublicDevelopmentCorpus();
  if (corpus.artifact_sha256 !== input.prepare.corpus_sha256) throw new Error("LC4-DEV prepared corpus differs from runtime corpus");
  if (!Number.isSafeInteger(input.maximum_new_cells) || input.maximum_new_cells < 1
    || input.maximum_new_cells > LC4_DEV_LIVE_EPISODES) {
    throw new Error("LC4-DEV run slice must admit from one through six new cells");
  }
  if (input.completed_prefix) {
    assertLc4DevLiveRunPrefixArtifact(input.completed_prefix, input.prepare, input.preflight);
  }
  const resumed = input.completed_prefix;
  const startedAt = resumed?.started_at ?? input.dependencies.now().toISOString();
  let previousEvent: string | null = resumed?.ledger_head_sha256 ?? null;
  let sequence = resumed?.ledger.length ?? 0;
  const ledger: Lc4DevImmutableLedgerEvent[] = [...(resumed?.ledger ?? [])];
  let episodesStarted = resumed?.episodes_started ?? 0;
  let episodesCompleted = resumed?.episodes_completed ?? 0;
  let providerSegmentIntents = resumed?.provider_segment_intent_count ?? 0;
  let providerSegmentsOpened = resumed?.provider_segment_opened_count ?? 0;
  let opportunitiesSubmitted = resumed?.opportunities_submitted ?? 0;
  let opportunitiesCompleted = resumed?.opportunities_completed ?? 0;
  let retainedCaller = resumed?.retained_caller_audio ?? 0;
  let retainedAssistant = resumed?.retained_assistant_audio ?? 0;
  let listenerEvidence = resumed?.listener_evidence_count ?? 0;
  let mechanismReceipts = resumed?.mechanism_receipt_count ?? 0;
  let repairPlaybacks = resumed?.repair_playbacks ?? 0;
  let episodeFinalizations = resumed?.episode_finalization_count ?? 0;
  let responseGenerationsRequested = resumed?.response_generations_requested ?? 0;
  let providerCallsStarted = resumed?.provider_calls_started ?? 0;
  let responseGenerationsCompleted = resumed?.response_generations_completed ?? 0;
  let priorPrefixSha256 = resumed?.prefix_sha256 ?? null;
  let lastCompletedPrefix: Lc4DevLiveRunPrefixArtifact | null = null;
  const initialEpisodesCompleted = episodesCompleted;
  let sliceStopped = false;
  let failureClass: Lc4DevLiveRunArtifact["failure_class"] = null;
  let failureMessage: string | null = null;

  const append = async (
    eventType: Lc4DevImmutableLedgerEvent["event_type"],
    episodeId: string,
    opportunityId: string | null,
    payload: JsonValue,
    evidenceReferences: readonly Lc4DevReplayArtifactReference[] = [],
  ) => {
    const payloadEvidence = await input.dependencies.evidence.retainJson({ kind: "ledger_payload", body: payload });
    for (const reference of [payloadEvidence, ...evidenceReferences]) {
      await input.dependencies.evidence.assertResolvable(reference);
    }
    const body = {
      sequence: ++sequence,
      observed_at: input.dependencies.now().toISOString(),
      event_type: eventType,
      episode_id: episodeId,
      opportunity_id: opportunityId,
      payload_sha256: payloadEvidence.evidence_sha256,
      payload_evidence: payloadEvidence,
      evidence_references: Object.freeze([...evidenceReferences]),
      previous_event_sha256: previousEvent,
    };
    const event = freeze({ ...body, event_sha256: hash(LEDGER_EVENT_DOMAIN, body) });
    await input.dependencies.ledger.append(event);
    ledger.push(event);
    previousEvent = event.event_sha256;
  };

  const assertExchangeReplayBinding = async (
    exchange: Lc4DevExchangeEvidence,
    expected: Readonly<{
      episode: Lc4DevLiveEpisodePlan;
      opportunity_id: string;
      opportunity_index: number;
      segment_ordinal: Lc4DevProviderSegmentOrdinal;
      playback_kind: "canonical" | "repair";
      caller_pcm_sha256: string;
      caller_pcm_byte_length: number;
      caller_pcm: Uint8Array;
      control_authority_projection: JsonValue;
      control_receipt_sha256: string;
      repair_decision_projection: JsonValue | null;
      repair_decision_receipt_sha256: string | null;
      canonical_provider_exchange_sha256: string | null;
      expected_previous_provider_exchange_sha256: string | null;
      expected_previous_hacc_response_plan_sha256: string | null;
    }>,
  ) => {
    requireHash(exchange.provider_exchange_sha256, "LC4-DEV provider exchange");
    requireHash(exchange.listener_evidence_sha256, "LC4-DEV listener evidence");
    if (exchange.provider_exchange_evidence.evidence_sha256 !== exchange.provider_exchange_sha256
      || exchange.listener_evidence.evidence_sha256 !== exchange.listener_evidence_sha256) {
      throw new Error("LC4-DEV provider or listener evidence is not retained under its ledger hash");
    }
    const retainedProjection = await input.dependencies.evidence.resolveJson(exchange.provider_exchange_evidence);
    if (canonicalJson(retainedProjection) !== canonicalJson(exchange.provider_exchange_projection)) {
      throw new Error("LC4-DEV provider exchange projection differs from its retained replay bytes");
    }
    const retainedListenerProjection =
      await input.dependencies.evidence.resolveJson(exchange.listener_evidence);
    const replayExpectation: Lc4ProviderExchangeTreatmentReplayExpectation = {
      run_id: expected.episode.episode_id,
      opportunity_id: expected.opportunity_id,
      opportunity_index: expected.opportunity_index,
      segment_ordinal: expected.segment_ordinal,
      playback_kind: expected.playback_kind,
      caller_pcm_sha256: expected.caller_pcm_sha256,
      caller_pcm_byte_length: expected.caller_pcm_byte_length,
      response_control_kind: expected.episode.arm === "hacc"
        ? "hacc_response_plan"
        : "native_context",
      provider_profile: createLc4ProviderExecutionProfile(expected.episode.provider),
      input_audio_delivery_profile_sha256: input.prepare.audio_delivery_profile_sha256,
      caller_pcm: expected.caller_pcm,
      listener_consumed_pcm: exchange.assistant_pcm,
      listener_evidence_projection: retainedListenerProjection,
      listener_evidence_reference: exchange.listener_evidence,
      listener_manifest_sha256:
        input.preflight.listener_evidence_manifest_sha256,
      evaluator_build_sha256:
        input.preflight.asr_evaluator_build_sha256,
      arm: expected.episode.arm,
      control_authority_projection:
        expected.control_authority_projection,
      control_receipt_sha256: expected.control_receipt_sha256,
      repair_decision_projection: expected.repair_decision_projection,
      repair_decision_receipt_sha256:
        expected.repair_decision_receipt_sha256,
      canonical_provider_exchange_sha256:
        expected.canonical_provider_exchange_sha256,
      expected_previous_provider_exchange_sha256:
        expected.expected_previous_provider_exchange_sha256,
      expected_previous_hacc_response_plan_sha256:
        expected.expected_previous_hacc_response_plan_sha256,
    };
    const schemaVersion = typeof retainedProjection === "object"
      && retainedProjection !== null
      && !Array.isArray(retainedProjection)
      ? (retainedProjection as { readonly schema_version?: JsonValue })
        .schema_version
      : null;
    if (schemaVersion !== 5) {
      throw new Error(
        "LC4-DEV authorized live exchange requires treatment-bound provider schema v5",
      );
    }
    return assertLc4ProviderExchangeTreatmentReplayProjection(
      retainedProjection,
      replayExpectation,
    );
  };

  const retainFailure = async (failure: Lc4DevFailureEvidence) => {
    const body = lc4DevFailureEvidenceBody(failure);
    const retained = await input.dependencies.evidence.retainJson({
      kind: "failure_evidence",
      body: body as unknown as JsonValue,
      domain_prefix: LC4_DEV_FAILURE_EVIDENCE_DOMAIN,
      expected_evidence_sha256: failure.failure_evidence_sha256,
    });
    return retained;
  };

  const failureFromUnknown = (failureInput: Readonly<{
    error: unknown;
    episode: Lc4DevLiveEpisodePlan;
    opportunity_id: string | null;
    caller_pcm_sha256: string | null;
    caller_pcm_byte_length: number;
    role: "primary_exchange" | "cleanup";
    post_exchange_completed?: boolean;
    playback_kind?: "canonical" | "repair" | null;
    secondary_failure_evidence_sha256?: string | null;
  }>): Lc4DevFailureEvidence => {
    const timedOut = failureInput.error instanceof Error && failureInput.error.message.startsWith("timeout:");
    return createLc4DevFailureEvidence({
      schema_version: 2,
      evidence_version: LC4_DEV_FAILURE_EVIDENCE_VERSION,
      redaction: "strict_allowlist_no_provider_plaintext_credentials_or_raw_ids",
      failure_role: failureInput.role,
      failure_stage: failureInput.role === "cleanup"
        ? "segment_close"
        : failureInput.post_exchange_completed
          ? "exchange_evidence"
          : timedOut ? "provider_wait" : "pre_send_contract",
      failure_code: failureInput.role === "cleanup"
        ? "segment_close_failed"
        : failureInput.post_exchange_completed
          ? "evidence_assembly_failed"
          : timedOut ? "provider_response_timeout" : "adapter_failure",
      failure_class: failureInput.role === "cleanup"
        ? "cleanup"
        : failureInput.post_exchange_completed
          ? "evidence_retention"
          : timedOut ? "timeout" : "unknown",
      episode_id: failureInput.episode.episode_id,
      opportunity_id: failureInput.opportunity_id,
      provider: failureInput.episode.provider,
      model: failureInput.episode.model,
      playback_kind: failureInput.playback_kind ?? (failureInput.opportunity_id === null ? null : "canonical"),
      operation_order: Object.freeze([]),
      caller_pcm_sha256: failureInput.caller_pcm_sha256,
      caller_pcm_byte_length: failureInput.caller_pcm_byte_length,
      // The local runner can prove that the adapter returned and accounts the
      // paid generation in the run counters, but it must not fabricate the
      // adapter's private wire progression in this secondary evidence record.
      caller_pcm_chunk_count: 0,
      caller_pcm_appended_chunk_count: 0,
      caller_pcm_appended_byte_length: 0,
      response_generation_requested: false,
      response_generation_started: false,
      response_terminal_observed: false,
      response_completed: false,
      output_pcm_sha256: null,
      output_pcm_byte_length: 0,
      output_pcm_chunk_count: 0,
      wire_observation_count: 0,
      terminal_wire_type: "none",
      terminal_wire_type_sha256: null,
      terminal_wire_observation_sha256: null,
      gateway_batch_count: 0,
      gateway_fatal_class: "none",
      secondary_failure_evidence_sha256: failureInput.secondary_failure_evidence_sha256 ?? null,
    });
  };

  const segmentOpenFailureFromUnknown = (failureInput: Readonly<{
    error: unknown;
    episode: Lc4DevLiveEpisodePlan;
  }>): Readonly<{
    failure: Lc4DevFailureEvidence;
    run_failure_class: Exclude<Lc4DevLiveRunArtifact["failure_class"], null>;
    provider_boundary_crossed: boolean | null;
  }> => {
    const timedOut = failureInput.error instanceof Error
      && failureInput.error.message === "timeout:segment-open";
    const continuityCompile = isLocalContinuityCompileFailure(failureInput.error);
    const failure = createLc4DevFailureEvidence({
      schema_version: 2,
      evidence_version: LC4_DEV_FAILURE_EVIDENCE_VERSION,
      redaction: "strict_allowlist_no_provider_plaintext_credentials_or_raw_ids",
      failure_role: "primary_exchange",
      failure_stage: timedOut ? "provider_wait" : "pre_send_contract",
      failure_code: timedOut
        ? "provider_response_timeout"
        : continuityCompile ? "invalid_contract" : "adapter_failure",
      failure_class: timedOut
        ? "timeout"
        : continuityCompile ? "adapter_contract" : "unknown",
      episode_id: failureInput.episode.episode_id,
      opportunity_id: null,
      provider: failureInput.episode.provider,
      model: failureInput.episode.model,
      playback_kind: null,
      operation_order: Object.freeze([]),
      caller_pcm_sha256: null,
      caller_pcm_byte_length: 0,
      caller_pcm_chunk_count: 0,
      caller_pcm_appended_chunk_count: 0,
      caller_pcm_appended_byte_length: 0,
      response_generation_requested: false,
      response_generation_started: false,
      response_terminal_observed: false,
      response_completed: false,
      output_pcm_sha256: null,
      output_pcm_byte_length: 0,
      output_pcm_chunk_count: 0,
      wire_observation_count: 0,
      terminal_wire_type: "none",
      terminal_wire_type_sha256: null,
      terminal_wire_observation_sha256: null,
      gateway_batch_count: 0,
      gateway_fatal_class: "none",
      secondary_failure_evidence_sha256: null,
    });
    return Object.freeze({
      failure,
      run_failure_class: timedOut
        ? "timeout"
        : continuityCompile ? "continuity_compile" : "transport",
      // Only the adapter's pre-factory continuity errors prove this negative.
      // A generic or timed-out open can have crossed the provider boundary.
      provider_boundary_crossed: continuityCompile ? false : null,
    });
  };

  try {
    for (const episode of input.prepare.episodes.slice(episodesCompleted)) {
      const providerBindings = input.prepare.audio_bindings.filter((binding) => binding.provider === episode.provider);
      let previousRotationReceipt: string | null = null;
      let priorExchange: string | null = null;
      let priorHaccResponsePlanSha256: string | null = null;
      let lastOpportunityId: string | null = null;
      let primaryFailureEvidenceSha256: string | null = null;
      const segmentFinalizations: Lc4DevReplayArtifactReference[] = [];
      const episodeOpportunityStart = opportunitiesCompleted;
      const episodeResponseStart = responseGenerationsCompleted;
      const episodeRepairStart = repairPlaybacks;
      if (input.dependencies.cell_checkpoint) {
        await input.dependencies.cell_checkpoint.beforeFirstNetworkEmission({
          episode,
          prior_run_ledger_head_sha256: previousEvent,
        });
      }
      episodesStarted += 1;
      await append("episode_opened", episode.episode_id, null, { provider: episode.provider, arm: episode.arm, model: episode.model });
      for (const segmentOrdinal of [1, 2, 3, 4, 5, 6] as const) {
        failureClass = "transport";
        let session;
        await append("segment_open_intent", episode.episode_id, null, {
          segment_ordinal: segmentOrdinal,
          opportunity_start:
            (segmentOrdinal - 1) * LC4_DEV_OPPORTUNITIES_PER_PROVIDER_SEGMENT + 1,
          opportunity_end:
            segmentOrdinal * LC4_DEV_OPPORTUNITIES_PER_PROVIDER_SEGMENT,
          previous_rotation_receipt_sha256: previousRotationReceipt,
          planned_provider_session: true,
          retry_or_reconnect: false,
        });
        providerSegmentIntents += 1;
        try {
          session = await boundedSegmentOpen(LC4_DEV_LIVE_TIMEOUTS.segment_open_ms, (signal) => input.dependencies.adapter.openSegment({
            episode,
            segment_ordinal: segmentOrdinal,
            previous_rotation_receipt_sha256: previousRotationReceipt,
            signal,
          }));
        } catch (error) {
          const classified = segmentOpenFailureFromUnknown({ error, episode });
          failureClass = classified.run_failure_class;
          const retainedFailure = await retainFailure(classified.failure);
          if (retainedFailure.evidence_sha256 !== classified.failure.failure_evidence_sha256) {
            throw new Error("LC4-DEV segment-open failure evidence is not retained under its failure hash");
          }
          await input.dependencies.evidence.assertResolvable(retainedFailure);
          await append("segment_failed", episode.episode_id, null, {
            segment_ordinal: segmentOrdinal,
            failure_evidence_sha256: classified.failure.failure_evidence_sha256,
            failure_stage: classified.failure.failure_stage,
            failure_code: classified.failure.failure_code,
            failure_class: classified.failure.failure_class,
            failure_role: classified.failure.failure_role,
            provider_boundary_crossed: classified.provider_boundary_crossed,
            response_generation_requested: false,
            response_generation_started: false,
            response_completed: false,
          }, [retainedFailure]);
          primaryFailureEvidenceSha256 = classified.failure.failure_evidence_sha256;
          throw error;
        }
        let segmentBodyFailed = false;
        try {
          await append("segment_opened", episode.episode_id, null, {
            segment_ordinal: segmentOrdinal,
            opportunity_start:
              (segmentOrdinal - 1) * LC4_DEV_OPPORTUNITIES_PER_PROVIDER_SEGMENT + 1,
            opportunity_end:
              segmentOrdinal * LC4_DEV_OPPORTUNITIES_PER_PROVIDER_SEGMENT,
            previous_rotation_receipt_sha256: previousRotationReceipt,
            planned_provider_session: true,
            retry_or_reconnect: false,
          });
          providerSegmentsOpened += 1;
          const start =
            (segmentOrdinal - 1) * LC4_DEV_OPPORTUNITIES_PER_PROVIDER_SEGMENT;
          for (
            let offset = 0;
            offset < LC4_DEV_OPPORTUNITIES_PER_PROVIDER_SEGMENT;
            offset += 1
          ) {
            const canonicalOpportunity = corpus.opportunities[start + offset]!;
            lastOpportunityId = canonicalOpportunity.id;
            const binding = providerBindings[start + offset]!;
            let opportunity = canonicalOpportunity;
            let callerPcm: Uint8Array;
            let expectedCallerPcmSha256 = binding.pcm_sha256;
            let expectedCallerPcmByteLength = binding.pcm_byte_length;
            let branchDecisionEvidence: Lc4DevReplayArtifactReference | null = null;
            let branchDecision: Lc4DevCallerBranchDecision | null = null;
            failureClass = "pre-open";
            if (canonicalOpportunity.id === LC4_DEV_BRANCH_OPPORTUNITY_ID) {
              const selected = await bounded("caller-branch-selection", LC4_DEV_LIVE_TIMEOUTS.control_ms, () => input.dependencies.caller_branch.select({
                episode,
                canonical_opportunity: canonicalOpportunity,
              }));
              assertLc4DevCallerBranchDecision({
                decision: selected.decision,
                matrix: input.dependencies.caller_branch.matrix,
                trust: input.dependencies.caller_branch.trust,
              });
              if (selected.decision.episode_id !== episode.episode_id
                || selected.decision.provider !== episode.provider
                || canonicalJson(selected.opportunity) !== canonicalJson(lc4DevBranchedOpportunity(canonicalOpportunity, selected.decision))) {
                throw new Error("LC4-DEV caller branch selection differs from its episode or projected opportunity");
              }
              if (selected.evidence.kind !== "caller_branch_decision"
                || selected.evidence.evidence_sha256 !== selected.decision.decision_sha256) {
                throw new Error("LC4-DEV caller branch decision is not retained under its signed hash");
              }
              await input.dependencies.evidence.assertResolvable(selected.evidence);
              opportunity = selected.opportunity;
              callerPcm = selected.pcm;
              expectedCallerPcmSha256 = selected.decision.pcm_sha256;
              expectedCallerPcmByteLength = selected.decision.pcm_byte_length;
              branchDecisionEvidence = selected.evidence;
              branchDecision = selected.decision;
              await append("caller_branch_selected", episode.episode_id, opportunity.id, {
                decision_sha256: selected.decision.decision_sha256,
                prior_outcome: selected.decision.prior_outcome,
                prior_receipt_sha256: selected.decision.prior_receipt_sha256,
                reconciliation_audio_selected: selected.decision.reconciliation_audio_selected,
                projected_opportunity_id: opportunity.id,
                projected_opportunity_index: opportunity.index,
              }, [selected.evidence]);
            } else {
              callerPcm = await bounded("caller-audio-load", LC4_DEV_LIVE_TIMEOUTS.retention_ms, () => input.dependencies.caller_audio.load(binding));
            }
            if (callerPcm.byteLength !== expectedCallerPcmByteLength || sha256Hex(callerPcm) !== expectedCallerPcmSha256) {
              throw new Error("LC4-DEV loaded caller audio differs from prepared binding");
            }
            const callerReceipt = await bounded("caller-audio-retention", LC4_DEV_LIVE_TIMEOUTS.retention_ms, () => input.dependencies.retention.retain({
              episode_id: episode.episode_id,
              opportunity_id: opportunity.id,
              direction: "caller_input",
              pcm: callerPcm,
            }));
            if (callerReceipt.artifact_sha256 !== expectedCallerPcmSha256 || callerReceipt.byte_length !== callerPcm.byteLength) {
              throw new Error("LC4-DEV caller retention receipt is invalid");
            }
            if (callerReceipt.evidence.evidence_sha256 !== expectedCallerPcmSha256) throw new Error("LC4-DEV caller PCM is not replay-addressable");
            retainedCaller += 1;
            failureClass = "evidence";
            const retainedControl = await bounded("control", LC4_DEV_LIVE_TIMEOUTS.control_ms, () => input.dependencies.control.next({
              episode,
              opportunity,
              previous_exchange_sha256: priorExchange,
            }));
            const control = retainedControl.receipt;
            assertControl({
              receipt: control,
              manifest_sha256: input.preflight.control_plane_manifest_sha256,
              episode,
              opportunity,
              previous_exchange_sha256: priorExchange,
            });
            if (retainedControl.evidence.evidence_sha256 !== control.control_receipt_sha256) {
              throw new Error("LC4-DEV control authority body is not retained under its receipt hash");
            }
            mechanismReceipts += 1;
            const controlAuthorityProjection =
              await input.dependencies.evidence.resolveJson(
                retainedControl.evidence,
              );
            const controlPreviousExchangeSha256 = priorExchange;
            const controlPreviousHaccPlanSha256 =
              priorHaccResponsePlanSha256;
            failureClass = "transport";
            opportunitiesSubmitted += 1;
            await append(
              "audio_submitted",
              episode.episode_id,
              opportunity.id,
              {
                caller_pcm_sha256: expectedCallerPcmSha256,
                control_receipt_sha256: control.control_receipt_sha256,
                caller_branch_decision_sha256: branchDecisionEvidence?.evidence_sha256 ?? null,
              },
              [callerReceipt.evidence, retainedControl.evidence, ...(branchDecisionEvidence ? [branchDecisionEvidence] : [])],
            );
            let exchange: Lc4DevExchangeEvidence;
            let exchangeReturned = false;
            let canonicalTreatmentReplay: Awaited<ReturnType<
              typeof assertExchangeReplayBinding
            >>;
            responseGenerationsRequested += 1;
            try {
              exchange = await bounded("opportunity-exchange", LC4_DEV_LIVE_TIMEOUTS.opportunity_exchange_ms, () => session.exchangeCanonical({
                opportunity,
                caller_pcm: callerPcm,
                control_receipt: control,
                ...(branchDecision && branchDecisionEvidence ? {
                  caller_branch_binding: {
                    decision: branchDecision,
                    decision_evidence: branchDecisionEvidence,
                  },
                } : {}),
              }));
              exchangeReturned = true;
              // A successfully returned exchange has already consumed one paid
              // provider generation. Count it before replay/evidence checks so
              // a local verification failure cannot under-report provider use.
              providerCallsStarted += 1;
              responseGenerationsCompleted += 1;
              failureClass = "evidence";
              assertCallerBranchExchangeAuthority({
                projection: exchange.provider_exchange_projection,
                decision: branchDecision,
                decision_evidence_sha256: branchDecisionEvidence?.evidence_sha256 ?? null,
                caller_pcm_sha256: expectedCallerPcmSha256,
                caller_pcm_byte_length: callerPcm.byteLength,
              });
              if (exchange.playback_kind !== "canonical"
                || exchange.opportunity_id !== opportunity.id
                || exchange.assistant_pcm.byteLength < 2
                || exchange.assistant_pcm.byteLength % 2 !== 0) {
                throw new Error("LC4-DEV provider exchange evidence is incomplete");
              }
              canonicalTreatmentReplay = await assertExchangeReplayBinding(
                exchange,
                {
                episode,
                opportunity_id: opportunity.id,
                opportunity_index: opportunity.index,
                segment_ordinal: segmentOrdinal,
                playback_kind: "canonical",
                caller_pcm_sha256: expectedCallerPcmSha256,
                caller_pcm_byte_length: callerPcm.byteLength,
                caller_pcm: callerPcm,
                control_authority_projection: controlAuthorityProjection,
                control_receipt_sha256: control.control_receipt_sha256,
                repair_decision_projection: null,
                repair_decision_receipt_sha256: null,
                canonical_provider_exchange_sha256: null,
                expected_previous_provider_exchange_sha256:
                  controlPreviousExchangeSha256,
                expected_previous_hacc_response_plan_sha256:
                  controlPreviousHaccPlanSha256,
                },
              );
            } catch (error) {
              const failure = isLc4DevFailureEvidenceError(error)
                ? error.failure
                : failureFromUnknown({
                    error,
                    episode,
                    opportunity_id: opportunity.id,
                    caller_pcm_sha256: expectedCallerPcmSha256,
                    caller_pcm_byte_length: callerPcm.byteLength,
                    role: "primary_exchange",
                    post_exchange_completed: exchangeReturned,
                  });
              const retainedFailure = isLc4DevFailureEvidenceError(error) && error.retained_evidence !== null
                ? error.retained_evidence
                : await retainFailure(failure);
              if (retainedFailure.evidence_sha256 !== failure.failure_evidence_sha256) {
                throw new Error("LC4-DEV failure evidence is not retained under its failure hash");
              }
              await input.dependencies.evidence.assertResolvable(retainedFailure);
              if (!exchangeReturned) {
                providerCallsStarted += Number(failure.response_generation_started);
                responseGenerationsCompleted += Number(failure.response_completed);
              }
              await append("opportunity_failed", episode.episode_id, opportunity.id, {
                failure_evidence_sha256: failure.failure_evidence_sha256,
                failure_stage: failure.failure_stage,
                failure_code: failure.failure_code,
                failure_class: failure.failure_class,
                response_generation_requested: failure.response_generation_requested,
                response_generation_started: failure.response_generation_started,
                response_completed: failure.response_completed,
                failure_role: failure.failure_role,
              }, [retainedFailure]);
              primaryFailureEvidenceSha256 = failure.failure_evidence_sha256;
              throw isLc4DevFailureEvidenceError(error)
                ? error
                : new Lc4DevFailureEvidenceError(failure, retainedFailure);
            }
            failureClass = "evidence";
            const assistantReceipt = await bounded("assistant-audio-retention", LC4_DEV_LIVE_TIMEOUTS.retention_ms, () => input.dependencies.retention.retain({
              episode_id: episode.episode_id,
              opportunity_id: opportunity.id,
              direction: "assistant_output",
              pcm: exchange.assistant_pcm,
            }));
            if (assistantReceipt.artifact_sha256 !== sha256Hex(exchange.assistant_pcm) || assistantReceipt.byte_length !== exchange.assistant_pcm.byteLength) {
              throw new Error("LC4-DEV assistant retention receipt is invalid");
            }
            retainedAssistant += 1;
            listenerEvidence += 1;
            const repairDecision = await input.dependencies.repair[episode.provider].decide({
              episode,
              opportunity,
              control_receipt: control,
              canonical_exchange_sha256: exchange.provider_exchange_sha256,
              canonical_listener_evidence_sha256: exchange.listener_evidence_sha256,
              listener_projection: exchange.repair_projection,
            });
            const { decision_receipt_sha256: claimedDecision, ...decisionBody } = repairDecision.receipt;
            const repairDecisionEvidence = await input.dependencies.evidence.retainJson({
              kind: "repair_decision",
              body: decisionBody as unknown as JsonValue,
              domain_prefix: REPAIR_DECISION_DOMAIN,
              expected_evidence_sha256: claimedDecision,
            });
            await append("repair_decided", episode.episode_id, opportunity.id, {
              decision_receipt_sha256: repairDecision.receipt.decision_receipt_sha256,
              decision_sha256: repairDecision.receipt.decision.decision_sha256,
              repair_selected: repairDecision.playback !== null,
            }, [repairDecisionEvidence]);
            let effectiveExchangeSha256 = exchange.provider_exchange_sha256;
            let effectiveListenerEvidenceSha256 = exchange.listener_evidence_sha256;
            let effectiveAssistantPcmSha256 = assistantReceipt.artifact_sha256;
            let effectiveRepairEvidenceReferences:
              readonly Lc4DevReplayArtifactReference[] = Object.freeze([]);
            const effectiveTerminalHaccPlanSha256 = episode.arm === "hacc"
              ? canonicalTreatmentReplay.treatment_binding
                .terminal_response_plan_sha256
              : null;
            if (repairDecision.playback) {
              const repair = repairDecision.playback;
              const repairCallerReceipt = await bounded("repair-caller-audio-retention", LC4_DEV_LIVE_TIMEOUTS.retention_ms, () => input.dependencies.retention.retain({
                episode_id: episode.episode_id,
                opportunity_id: opportunity.id,
                direction: "caller_repair",
                pcm: repair.pcm,
              }));
              if (repairCallerReceipt.artifact_sha256 !== repair.pcm_sha256 || repairCallerReceipt.byte_length !== repair.pcm_byte_length) {
                throw new Error("LC4-DEV repair caller retention receipt is invalid");
              }
              retainedCaller += 1;
              await append("repair_audio_submitted", episode.episode_id, opportunity.id, {
                decision_receipt_sha256: repair.decision_receipt_sha256,
                repair_pcm_sha256: repair.pcm_sha256,
                advances_canonical_horizon: false,
              }, [repairDecisionEvidence, repairCallerReceipt.evidence]);
              let repairExchange: Lc4DevExchangeEvidence;
              let repairExchangeReturned = false;
              responseGenerationsRequested += 1;
              try {
                repairExchange = await bounded("repair-exchange", LC4_DEV_LIVE_TIMEOUTS.opportunity_exchange_ms, () => session.exchangeRepair({
                  opportunity,
                  repair,
                  decision_receipt: repairDecision.receipt,
                  control_receipt: control,
                }));
                repairExchangeReturned = true;
                providerCallsStarted += 1;
                responseGenerationsCompleted += 1;
                if (repairExchange.playback_kind !== "repair"
                  || repairExchange.opportunity_id !== opportunity.id
                  || repairExchange.assistant_pcm.byteLength < 2
                  || repairExchange.assistant_pcm.byteLength % 2 !== 0) {
                  throw new Error("LC4-DEV repair exchange evidence is incomplete");
                }
                await assertExchangeReplayBinding(repairExchange, {
                    episode,
                    opportunity_id: opportunity.id,
                    opportunity_index: opportunity.index,
                    segment_ordinal: segmentOrdinal,
                    playback_kind: "repair",
                    caller_pcm_sha256: repair.pcm_sha256,
                    caller_pcm_byte_length: repair.pcm.byteLength,
                    caller_pcm: repair.pcm,
                    control_authority_projection:
                      controlAuthorityProjection,
                    control_receipt_sha256:
                      control.control_receipt_sha256,
                    repair_decision_projection:
                      decisionBody as unknown as JsonValue,
                    repair_decision_receipt_sha256:
                      repairDecision.receipt.decision_receipt_sha256,
                    canonical_provider_exchange_sha256:
                      exchange.provider_exchange_sha256,
                    expected_previous_provider_exchange_sha256:
                      controlPreviousExchangeSha256,
                    expected_previous_hacc_response_plan_sha256:
                      canonicalTreatmentReplay.treatment_binding
                        .previous_hacc_response_plan_sha256,
                  });
                // Repair may replace caller-heard audio and the effective
                // provider exchange, but it cannot roll canonical host Flow or
                // the post-tool response-plan checkpoint backward.
              } catch (error) {
                const failure = isLc4DevFailureEvidenceError(error)
                  ? error.failure
                  : failureFromUnknown({
                      error,
                      episode,
                      opportunity_id: opportunity.id,
                      caller_pcm_sha256: repair.pcm_sha256,
                      caller_pcm_byte_length: repair.pcm_byte_length,
                      role: "primary_exchange",
                      playback_kind: "repair",
                      post_exchange_completed: repairExchangeReturned,
                    });
                const retainedFailure = isLc4DevFailureEvidenceError(error) && error.retained_evidence !== null
                  ? error.retained_evidence
                  : await retainFailure(failure);
                if (retainedFailure.evidence_sha256 !== failure.failure_evidence_sha256) {
                  throw new Error("LC4-DEV repair failure evidence is not retained under its failure hash");
                }
                await input.dependencies.evidence.assertResolvable(retainedFailure);
                providerCallsStarted += Number(failure.response_generation_started);
                responseGenerationsCompleted += Number(failure.response_completed);
                await append("opportunity_failed", episode.episode_id, opportunity.id, {
                  failure_evidence_sha256: failure.failure_evidence_sha256,
                  failure_stage: failure.failure_stage,
                  failure_code: failure.failure_code,
                  failure_class: failure.failure_class,
                  response_generation_requested: failure.response_generation_requested,
                  response_generation_started: failure.response_generation_started,
                  response_completed: failure.response_completed,
                  failure_role: failure.failure_role,
                  playback_kind: "repair",
                }, [retainedFailure]);
                primaryFailureEvidenceSha256 = failure.failure_evidence_sha256;
                throw isLc4DevFailureEvidenceError(error)
                  ? error
                  : new Lc4DevFailureEvidenceError(failure, retainedFailure);
              }
              const repairAssistantReceipt = await bounded("repair-assistant-audio-retention", LC4_DEV_LIVE_TIMEOUTS.retention_ms, () => input.dependencies.retention.retain({
                episode_id: episode.episode_id,
                opportunity_id: opportunity.id,
                direction: "assistant_repair_output",
                pcm: repairExchange.assistant_pcm,
              }));
              if (repairAssistantReceipt.artifact_sha256 !== sha256Hex(repairExchange.assistant_pcm)
                || repairAssistantReceipt.byte_length !== repairExchange.assistant_pcm.byteLength) {
                throw new Error("LC4-DEV repair assistant retention receipt is invalid");
              }
              const playbackReceipt = input.dependencies.repair[episode.provider].complete({
                playback: repair,
                provider_exchange_sha256: repairExchange.provider_exchange_sha256,
                listener_evidence_sha256: repairExchange.listener_evidence_sha256,
                playback_authority_receipt_sha256: repairExchange.playback_authority_receipt_sha256,
                recursive_repair_observation: null,
              });
              assertLc4DevRepairPlaybackReceiptBinding({
                receipt: playbackReceipt,
                episode_id: episode.episode_id,
                opportunity_id: opportunity.id,
                opportunity_index: opportunity.index,
                decision_receipt_sha256:
                  repairDecision.receipt.decision_receipt_sha256,
                repair,
                repair_exchange: repairExchange,
              });
              const { playback_receipt_sha256: claimedPlayback, ...playbackBody } = playbackReceipt;
              const playbackEvidence = await input.dependencies.evidence.retainJson({
                kind: "repair_playback",
                body: playbackBody as unknown as JsonValue,
                domain_prefix: REPAIR_PLAYBACK_DOMAIN,
                expected_evidence_sha256: claimedPlayback,
              });
              retainedAssistant += 1;
              listenerEvidence += 1;
              repairPlaybacks += 1;
              effectiveExchangeSha256 = repairExchange.provider_exchange_sha256;
              effectiveListenerEvidenceSha256 = repairExchange.listener_evidence_sha256;
              effectiveAssistantPcmSha256 = repairAssistantReceipt.artifact_sha256;
              effectiveRepairEvidenceReferences = Object.freeze([
                repairExchange.provider_exchange_evidence,
                repairExchange.listener_evidence,
                repairAssistantReceipt.evidence,
              ]);
              await append("repair_completed", episode.episode_id, opportunity.id, {
                decision_receipt_sha256: repairDecision.receipt.decision_receipt_sha256,
                playback_receipt_sha256: playbackReceipt.playback_receipt_sha256,
                repair_exchange_sha256: repairExchange.provider_exchange_sha256,
                repair_listener_evidence_sha256: repairExchange.listener_evidence_sha256,
                repair_assistant_pcm_sha256: repairAssistantReceipt.artifact_sha256,
                canonical_provider_exchange_sha256: exchange.provider_exchange_sha256,
                canonical_listener_evidence_sha256: exchange.listener_evidence_sha256,
                canonical_assistant_pcm_sha256: assistantReceipt.artifact_sha256,
                effective_provider_exchange_sha256: repairExchange.provider_exchange_sha256,
                effective_listener_evidence_sha256: repairExchange.listener_evidence_sha256,
                effective_assistant_pcm_sha256: repairAssistantReceipt.artifact_sha256,
                advances_canonical_horizon: false,
              }, [
                repairDecisionEvidence,
                playbackEvidence,
                exchange.provider_exchange_evidence,
                exchange.listener_evidence,
                assistantReceipt.evidence,
                ...effectiveRepairEvidenceReferences,
              ]);
            }
            const finalized = await session.finalizeOpportunity({
              opportunity_id: opportunity.id,
              decision_receipt_sha256: repairDecision.receipt.decision_receipt_sha256,
              repair_played: repairDecision.playback !== null,
            });
            requireHash(finalized.opportunity_receipt_sha256, "LC4-DEV opportunity finalize receipt");
            if (finalized.opportunity_finalization.evidence_sha256 !== finalized.opportunity_receipt_sha256) {
              throw new Error("LC4-DEV opportunity finalization is not retained under its receipt hash");
            }
            opportunitiesCompleted += 1;
            priorExchange = effectiveExchangeSha256;
            priorHaccResponsePlanSha256 =
              effectiveTerminalHaccPlanSha256;
            await append("opportunity_completed", episode.episode_id, opportunity.id, {
              canonical_provider_exchange_sha256: exchange.provider_exchange_sha256,
              canonical_listener_evidence_sha256: exchange.listener_evidence_sha256,
              canonical_assistant_pcm_sha256: assistantReceipt.artifact_sha256,
              effective_provider_exchange_sha256: effectiveExchangeSha256,
              effective_listener_evidence_sha256: effectiveListenerEvidenceSha256,
              effective_assistant_pcm_sha256: effectiveAssistantPcmSha256,
              decision_receipt_sha256: repairDecision.receipt.decision_receipt_sha256,
              opportunity_receipt_sha256: finalized.opportunity_receipt_sha256,
              caller_pcm_sha256: expectedCallerPcmSha256,
              caller_branch_decision_sha256: branchDecisionEvidence?.evidence_sha256 ?? null,
              caller_branch_exchange_join_sha256: branchDecision ? sha256Hex(
                `harshas-amazing-call-center/lc4-dev-caller-branch-exchange-join/v1\n${canonicalJson({
                  opportunity_id: opportunity.id,
                  decision_sha256: branchDecision.decision_sha256,
                  caller_pcm_sha256: expectedCallerPcmSha256,
                  caller_pcm_byte_length: callerPcm.byteLength,
                  provider_exchange_sha256: exchange.provider_exchange_sha256,
                })}`,
              ) : null,
            }, [
              exchange.provider_exchange_evidence,
              exchange.listener_evidence,
              repairDecisionEvidence,
              finalized.opportunity_finalization,
              assistantReceipt.evidence,
              ...effectiveRepairEvidenceReferences,
              ...(branchDecisionEvidence ? [branchDecisionEvidence] : []),
            ]);
          }
        } catch (error) {
          segmentBodyFailed = true;
          throw error;
        } finally {
          const originalFailureClass = failureClass;
          if (!segmentBodyFailed) failureClass = "transport";
          try {
            const closed = await bounded("segment-close", LC4_DEV_LIVE_TIMEOUTS.segment_close_ms, () => session.close());
            requireHash(closed.rotation_receipt_sha256, "LC4-DEV segment rotation receipt");
            if (closed.segment_finalization.evidence_sha256 !== closed.rotation_receipt_sha256) {
              throw new Error("LC4-DEV segment finalization is not retained under its rotation hash");
            }
            previousRotationReceipt = closed.rotation_receipt_sha256;
            segmentFinalizations.push(closed.segment_finalization);
          } catch (closeError) {
            let surfacedCloseError: unknown = closeError;
            try {
              const closeFailure = isLc4DevFailureEvidenceError(closeError)
                ? closeError.failure
                : failureFromUnknown({
                    error: closeError,
                    episode,
                    opportunity_id: null,
                  caller_pcm_sha256: null,
                  caller_pcm_byte_length: 0,
                  role: "cleanup",
                  secondary_failure_evidence_sha256: segmentBodyFailed ? primaryFailureEvidenceSha256 : null,
                });
              let linkedCloseFailure = closeFailure;
              if (segmentBodyFailed && closeFailure.secondary_failure_evidence_sha256 === null) {
                linkedCloseFailure = createLc4DevFailureEvidence({
                  ...lc4DevFailureEvidenceBody(closeFailure),
                  secondary_failure_evidence_sha256: primaryFailureEvidenceSha256,
                });
              }
              const retainedCloseFailure = linkedCloseFailure === closeFailure
                && isLc4DevFailureEvidenceError(closeError) && closeError.retained_evidence !== null
                ? closeError.retained_evidence
                : await retainFailure(linkedCloseFailure);
              if (retainedCloseFailure.evidence_sha256 !== linkedCloseFailure.failure_evidence_sha256) {
                throw new Error("LC4-DEV close failure evidence is not retained under its failure hash");
              }
              await append("segment_failed", episode.episode_id, lastOpportunityId, {
                failure_evidence_sha256: linkedCloseFailure.failure_evidence_sha256,
                failure_stage: linkedCloseFailure.failure_stage,
                failure_code: linkedCloseFailure.failure_code,
                failure_class: linkedCloseFailure.failure_class,
                failure_role: linkedCloseFailure.failure_role,
                secondary_to_failure_evidence_sha256: segmentBodyFailed ? primaryFailureEvidenceSha256 : null,
              }, [retainedCloseFailure]);
              surfacedCloseError = linkedCloseFailure === closeFailure && isLc4DevFailureEvidenceError(closeError)
                ? closeError
                : new Lc4DevFailureEvidenceError(linkedCloseFailure, retainedCloseFailure);
            } catch (diagnosticError) {
              // Failure-evidence retention is secondary once the segment body
              // has failed. Never erase the primary exchange failure merely
              // because cleanup diagnostics also failed to persist.
              if (!segmentBodyFailed) surfacedCloseError = diagnosticError;
            }
            if (!segmentBodyFailed) throw surfacedCloseError;
          } finally {
            if (segmentBodyFailed) failureClass = originalFailureClass;
          }
        }
      }
      if (previousEvent === null) throw new Error("LC4-DEV episode cannot finalize without a ledger head");
      failureClass = "evidence";
      const episodeFinalization = await input.dependencies.finalization.finalizeEpisode({
        episode,
        completed_opportunities: opportunitiesCompleted - episodeOpportunityStart,
        response_generations: responseGenerationsCompleted - episodeResponseStart,
        repair_playbacks: repairPlaybacks - episodeRepairStart,
        ledger_head_before_terminal_sha256: previousEvent,
        segment_finalizations: segmentFinalizations,
      });
      episodeFinalizations += 1;
      await append(
        "episode_terminal",
        episode.episode_id,
        null,
        { status: "completed", canonical_opportunities: 60, episode_finalization_sha256: episodeFinalization.evidence_sha256 },
        [episodeFinalization, ...segmentFinalizations],
      );
      episodesCompleted += 1;
      const completedPrefix = createLc4DevLiveRunPrefixArtifact({
        prepare: input.prepare,
        preflight: input.preflight,
        started_at: startedAt,
        previous_prefix_sha256: priorPrefixSha256,
        episodes_started: episodesStarted,
        episodes_completed: episodesCompleted,
        provider_segment_intent_count: providerSegmentIntents,
        provider_segment_opened_count: providerSegmentsOpened,
        opportunities_submitted: opportunitiesSubmitted,
        opportunities_completed: opportunitiesCompleted,
        response_generations_requested: responseGenerationsRequested,
        provider_calls_started: providerCallsStarted,
        response_generations_completed: responseGenerationsCompleted,
        repair_playbacks: repairPlaybacks,
        retained_caller_audio: retainedCaller,
        retained_assistant_audio: retainedAssistant,
        listener_evidence_count: listenerEvidence,
        mechanism_receipt_count: mechanismReceipts,
        episode_finalization_count: episodeFinalizations,
        ledger: Object.freeze([...ledger]),
        ledger_head_sha256: previousEvent!,
      });
      await input.dependencies.cell_checkpoint?.afterEpisodeTerminal({
        episode,
        episode_finalization_sha256: episodeFinalization.evidence_sha256,
        terminal_run_ledger_head_sha256: previousEvent!,
        completed_prefix: completedPrefix,
      });
      priorPrefixSha256 = completedPrefix.prefix_sha256;
      lastCompletedPrefix = completedPrefix;
      if (episodesCompleted < LC4_DEV_LIVE_EPISODES
        && episodesCompleted - initialEpisodesCompleted >= input.maximum_new_cells) {
        sliceStopped = true;
        break;
      }
    }
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : "LC4-DEV live run failed";
    if (failureMessage.startsWith("timeout:")) failureClass = "timeout";
  }
  if (sliceStopped) {
    if (!lastCompletedPrefix) throw new Error("LC4-DEV slice stopped without a completed-cell prefix");
    return freeze({ kind: "completed_prefix" as const, prefix: lastCompletedPrefix });
  }
  const completedAt = input.dependencies.now().toISOString();
  const completed = episodesCompleted === 6
    && opportunitiesCompleted === 360
    && episodeFinalizations === 6
    && providerSegmentIntents === 36
    && providerSegmentsOpened === 36;
  const body = {
    schema_version: 3 as const,
    execution_id: input.prepare.execution_id,
    prepare_sha256: input.prepare.prepare_sha256,
    preflight_sha256: input.preflight.preflight_sha256,
    started_at: startedAt,
    completed_at: completedAt,
    status: completed ? "completed" as const : "failed" as const,
    episodes_started: episodesStarted,
    episodes_completed: episodesCompleted,
    provider_segment_intent_count: providerSegmentIntents,
    provider_segment_opened_count: providerSegmentsOpened,
    opportunities_submitted: opportunitiesSubmitted,
    opportunities_completed: opportunitiesCompleted,
    response_generations_requested: responseGenerationsRequested,
    provider_calls_started: providerCallsStarted,
    response_generations_completed: responseGenerationsCompleted,
    provider_calls_made: providerCallsStarted,
    repair_playbacks: repairPlaybacks,
    total_response_generations: responseGenerationsCompleted,
    paid_retry_count: 0 as const,
    maximum_total_micro_usd: input.prepare.maximum_total_micro_usd,
    retained_caller_audio: retainedCaller,
    retained_assistant_audio: retainedAssistant,
    listener_evidence_count: listenerEvidence,
    mechanism_receipt_count: mechanismReceipts,
    episode_finalization_count: episodeFinalizations,
    replay_evidence_reference_count: ledger.reduce((total, event) => total + 1 + event.evidence_references.length, 0),
    failure_class: completed ? null : failureClass,
    failure_message_sha256: failureMessage === null ? null : sha256Hex(failureMessage),
    ledger: Object.freeze(ledger),
    ledger_head_sha256: previousEvent,
  };
  return freeze({ kind: "terminal_run" as const, run: freeze({ ...body, run_sha256: hash(RUN_DOMAIN, body) }) });
}

export async function executeLc4DevLiveRun(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  preflight: Lc4DevLivePreflightArtifact<Lc4DevQualificationAdmissionReceipt>;
  dependencies: Lc4DevLiveRunnerDependencies;
}>): Promise<Lc4DevLiveRunArtifact> {
  const result = await executeLc4DevLiveRunSlice({ ...input, maximum_new_cells: 6 });
  if (result.kind !== "terminal_run") {
    throw new Error("LC4-DEV full runner unexpectedly returned a partial cell prefix");
  }
  return result.run;
}

export function createLc4DevInterruptedTerminalRun(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  preflight: Lc4DevLivePreflightArtifact<Lc4DevQualificationAdmissionReceipt>;
  completed_prefix?: Lc4DevLiveRunPrefixArtifact;
  completed_at: string;
  failure_evidence_sha256: string;
}>): Lc4DevLiveRunArtifact {
  if (input.completed_prefix) {
    assertLc4DevLiveRunPrefixArtifact(input.completed_prefix, input.prepare, input.preflight);
  }
  requireHash(input.failure_evidence_sha256, "LC4-DEV interrupted failure evidence");
  assertCanonicalTimestamp(input.completed_at, "LC4-DEV interrupted terminal completed_at");
  const prefix = input.completed_prefix;
  const ledger = Object.freeze([...(prefix?.ledger ?? [])]);
  const body = freeze({
    schema_version: 3 as const,
    execution_id: input.prepare.execution_id,
    prepare_sha256: input.prepare.prepare_sha256,
    preflight_sha256: input.preflight.preflight_sha256,
    started_at: prefix?.started_at ?? input.preflight.checked_at,
    completed_at: input.completed_at,
    status: "failed" as const,
    episodes_started: prefix?.episodes_started ?? 0,
    episodes_completed: prefix?.episodes_completed ?? 0,
    provider_segment_intent_count: prefix?.provider_segment_intent_count ?? 0,
    provider_segment_opened_count: prefix?.provider_segment_opened_count ?? 0,
    opportunities_submitted: prefix?.opportunities_submitted ?? 0,
    opportunities_completed: prefix?.opportunities_completed ?? 0,
    response_generations_requested: prefix?.response_generations_requested ?? 0,
    provider_calls_started: prefix?.provider_calls_started ?? 0,
    response_generations_completed: prefix?.response_generations_completed ?? 0,
    provider_calls_made: prefix?.provider_calls_started ?? 0,
    repair_playbacks: prefix?.repair_playbacks ?? 0,
    total_response_generations: prefix?.response_generations_completed ?? 0,
    paid_retry_count: 0 as const,
    maximum_total_micro_usd: input.prepare.maximum_total_micro_usd,
    retained_caller_audio: prefix?.retained_caller_audio ?? 0,
    retained_assistant_audio: prefix?.retained_assistant_audio ?? 0,
    listener_evidence_count: prefix?.listener_evidence_count ?? 0,
    mechanism_receipt_count: prefix?.mechanism_receipt_count ?? 0,
    episode_finalization_count: prefix?.episode_finalization_count ?? 0,
    replay_evidence_reference_count: ledger.reduce(
      (total, event) => total + 1 + event.evidence_references.length,
      0,
    ),
    failure_class: "transport" as const,
    failure_message_sha256: input.failure_evidence_sha256,
    ledger,
    ledger_head_sha256: prefix?.ledger_head_sha256 ?? null,
  });
  return freeze({ ...body, run_sha256: hash(RUN_DOMAIN, body) });
}

export type Lc4DevLiveReportArtifact = Readonly<{
  schema_version: 2;
  execution_id: string;
  run_sha256: string;
  completed: boolean;
  exact_six_episode_horizon: boolean;
  exact_opportunity_horizon: boolean;
  exact_provider_session_horizon: boolean;
  exact_playback_accounting: boolean;
  evidence_complete: boolean;
  execution_evidence_complete: boolean;
  authority_scoreability: "scorable" | "unscorable_missing_authority_evidence" | "unscorable_invalid_authority_evidence";
  authority_passed: number | null;
  authority_evaluated: number | null;
  authority_evidence_invalid: number;
  authority_replay_set_sha256: string | null;
  run_package_sha256: string | null;
  budget_lease_sha256: string | null;
  budget_evidence_sha256: string | null;
  budget_terminal_ledger_head_sha256: string | null;
  budget_replay_verified: boolean;
  task_results_available: boolean;
  paid_retry_count: 0;
  efficacy_claim_eligible: false;
  interpretation: "development mechanism evidence only; not confirmatory provider efficacy evidence";
  report_sha256: string;
}>;

export type Lc4DevAuthorityReportInput = Readonly<{
  status: Lc4DevLiveReportArtifact["authority_scoreability"];
  passed: number | null;
  evaluated: number | null;
  evidence_invalid: number;
  episode_replay_sha256s: readonly string[];
}>;

export type Lc4DevBudgetReportInput = Readonly<{
  run_package_sha256: string;
  budget_lease_sha256: string;
  budget_evidence_sha256: string;
  budget_terminal_ledger_head_sha256: string;
  budget_replay_verified: true;
}>;

export function createLc4DevLiveReportArtifact(
  run: Lc4DevLiveRunArtifact,
  authority: Lc4DevAuthorityReportInput = Object.freeze({
    status: "unscorable_missing_authority_evidence",
    passed: null,
    evaluated: null,
    evidence_invalid: 6,
    episode_replay_sha256s: Object.freeze([]),
  }),
  budget: Lc4DevBudgetReportInput | null = null,
): Lc4DevLiveReportArtifact {
  const { run_sha256: claimed, ...runBody } = run;
  if (hash(RUN_DOMAIN, runBody) !== claimed) throw new Error("LC4-DEV run artifact hash mismatch");
  const replayHashesValid = authority.episode_replay_sha256s.every((digest) => HASH.test(digest))
    && new Set(authority.episode_replay_sha256s).size === authority.episode_replay_sha256s.length;
  const scorableShapeValid = authority.status === "scorable"
    && Number.isSafeInteger(authority.passed) && Number.isSafeInteger(authority.evaluated)
    && authority.passed !== null && authority.evaluated !== null
    && authority.passed >= 0 && authority.passed <= authority.evaluated
    && authority.evaluated === 6 && authority.evidence_invalid === 0
    && authority.episode_replay_sha256s.length === 6 && replayHashesValid;
  const unscorableShapeValid = authority.status !== "scorable"
    && authority.passed === null && authority.evaluated === null
    && Number.isSafeInteger(authority.evidence_invalid) && authority.evidence_invalid >= 1
    && replayHashesValid;
  if (!scorableShapeValid && !unscorableShapeValid) {
    throw new Error("LC4-DEV authority report summary is internally inconsistent");
  }
  if (budget !== null && (!budget.budget_replay_verified
    || !HASH.test(budget.run_package_sha256)
    || !HASH.test(budget.budget_lease_sha256)
    || !HASH.test(budget.budget_evidence_sha256)
    || !HASH.test(budget.budget_terminal_ledger_head_sha256))) {
    throw new Error("LC4-DEV budget report summary is invalid or was not independently replayed");
  }
  const segmentIntentEvents = run.ledger.filter(
    (event) => event.event_type === "segment_open_intent",
  ).length;
  const segmentOpenedEvents = run.ledger.filter(
    (event) => event.event_type === "segment_opened",
  ).length;
  const segmentPrefixValid =
    Number.isSafeInteger(run.provider_segment_intent_count)
    && Number.isSafeInteger(run.provider_segment_opened_count)
    && run.provider_segment_intent_count === segmentIntentEvents
    && run.provider_segment_opened_count === segmentOpenedEvents
    && run.provider_segment_opened_count <= run.provider_segment_intent_count
    && run.provider_segment_intent_count <=
      LC4_DEV_LIVE_EPISODES * LC4_DEV_PROVIDER_SEGMENTS_PER_EPISODE;
  if (!segmentPrefixValid) {
    throw new Error("LC4-DEV provider-session ledger is not an exact authorized prefix");
  }
  const exactProviderSessionHorizon =
    run.provider_segment_intent_count
      === LC4_DEV_LIVE_EPISODES * LC4_DEV_PROVIDER_SEGMENTS_PER_EPISODE
    && run.provider_segment_opened_count
      === LC4_DEV_LIVE_EPISODES * LC4_DEV_PROVIDER_SEGMENTS_PER_EPISODE;
  const executionEvidenceComplete = run.retained_caller_audio === 360 + run.repair_playbacks
    && run.retained_assistant_audio === 360 + run.repair_playbacks
    && run.listener_evidence_count === 360 + run.repair_playbacks
    && run.mechanism_receipt_count === 360
    && run.episode_finalization_count === 6
    && exactProviderSessionHorizon
    && run.replay_evidence_reference_count >= run.ledger.length;
  const authorityScorable = authority.status === "scorable"
    && authority.evaluated === 6
    && authority.passed !== null
    && authority.evidence_invalid === 0
    && authority.episode_replay_sha256s.length === 6;
  const executionComplete = run.status === "completed"
    && run.episodes_completed === 6
    && run.opportunities_completed === 360
    && run.episode_finalization_count === 6
    && exactProviderSessionHorizon;
  const budgetComplete = budget !== null && budget.budget_replay_verified;
  const taskResultsAvailable = authorityScorable && executionComplete && budgetComplete;
  const body = {
    schema_version: 2 as const,
    execution_id: run.execution_id,
    run_sha256: run.run_sha256,
    completed: run.status === "completed",
    exact_six_episode_horizon: run.episodes_completed === 6,
    exact_opportunity_horizon: run.opportunities_completed === 360,
    exact_provider_session_horizon: exactProviderSessionHorizon,
    exact_playback_accounting: run.total_response_generations === 360 + run.repair_playbacks
      && run.response_generations_completed === run.total_response_generations
      && run.response_generations_requested === run.total_response_generations
      && run.provider_calls_started === run.total_response_generations
      && run.provider_calls_made === run.provider_calls_started,
    evidence_complete: executionEvidenceComplete && taskResultsAvailable,
    execution_evidence_complete: executionEvidenceComplete,
    authority_scoreability: authority.status,
    authority_passed: taskResultsAvailable ? authority.passed : null,
    authority_evaluated: taskResultsAvailable ? authority.evaluated : null,
    authority_evidence_invalid: authority.evidence_invalid,
    authority_replay_set_sha256: taskResultsAvailable
      ? sha256Hex(canonicalJson(authority.episode_replay_sha256s))
      : null,
    run_package_sha256: budget?.run_package_sha256 ?? null,
    budget_lease_sha256: budget?.budget_lease_sha256 ?? null,
    budget_evidence_sha256: budget?.budget_evidence_sha256 ?? null,
    budget_terminal_ledger_head_sha256: budget?.budget_terminal_ledger_head_sha256 ?? null,
    budget_replay_verified: budgetComplete,
    task_results_available: taskResultsAvailable,
    paid_retry_count: 0 as const,
    efficacy_claim_eligible: false as const,
    interpretation: "development mechanism evidence only; not confirmatory provider efficacy evidence" as const,
  };
  return freeze({ ...body, report_sha256: hash(REPORT_DOMAIN, body) });
}

export const LC4_DEV_ADAPTER_BOUNDARY = Object.freeze({
  code: "dev_specific_adapter_unlocked" as const,
  dev_manifest_protocol: "HACC-LC4-DEV-v1" as const,
  confirmatory_manifest_protocol: "HACC-LC4-v1" as const,
  confirmatory_factory_compile_time_frozen: true as const,
  unsafe_cross_protocol_cast_rejected: true as const,
});

export const LC4_DEV_EXECUTABLE_PIPELINE_BLOCKERS = Object.freeze([
  Object.freeze({
    code: "public_dev_pcm_materializer_missing" as const,
    detail: "The existing caller-audio materializer accepts only authorized HACC-LC4-v1 held-out corpora, not HACC-LC4-DEV-v1 public corpus text.",
  }),
  Object.freeze({
    code: "public_dev_hacc_control_compiler_missing" as const,
    detail: "The public development corpus has no AgentFlow/condition compilation binding, so a real HaccResponsePlan, gateway, ToolWorld, worker, and CRP receipt cannot yet be produced per opportunity.",
  }),
  Object.freeze({
    code: "public_dev_listener_semantic_registry_missing" as const,
    detail: "The public development corpus has expected oracle phrases but no frozen listener semantic registry/ASR replay artifact compatible with lc4-listener-evidence.",
  }),
] as const);

import { createPublicKey, verify } from "node:crypto";

import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "./artifacts";
import {
  assertLc4PublicDevelopmentCorpus,
  createLc4PublicDevelopmentCorpus,
  type Lc4PublicDevelopmentCorpus,
  type Lc4PublicDevOpportunity,
} from "./lc4-public-development-corpus";
import { LC4_PROVIDER_PROFILE_MANIFEST } from "./lc4-provider-profiles";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import type { HaccResponsePlan } from "./response-plan";
import {
  LC4_QUALIFICATION_RUNNER_VERSION,
  assertLc4QualificationPlan,
  createLc4QualificationTargets,
  type Lc4QualificationPlan,
  type Lc4QualificationTerminalArtifact,
} from "./lc4-qualification-runner";
import {
  assertProviderResponseToolCanaryArtifactIntegrity,
  type ProviderResponseToolCanaryArtifact,
} from "./provider-qualification";
import type {
  Lc4DevelopmentRealtimeAdapter,
} from "./lc4-development-realtime-contract";
import type { Lc4DevRepairPlaybackController } from "./lc4-development-repair-playback";

export type {
  Lc4DevExchangeEvidence,
  Lc4DevelopmentRealtimeAdapter,
  Lc4DevelopmentRealtimeSession,
} from "./lc4-development-realtime-contract";

export const LC4_DEV_LIVE_RUNNER_VERSION = "HACC-LC4-DEV-LIVE-RUNNER-v1" as const;
export const LC4_DEV_LIVE_EPISODES = 6 as const;
export const LC4_DEV_LIVE_OPPORTUNITIES_PER_EPISODE = 60 as const;
export const LC4_DEV_LIVE_TOTAL_OPPORTUNITIES = 360 as const;
export const LC4_DEV_LIVE_HARD_CEILING_MICRO_USD = 15_000_000 as const;
export const LC4_DEV_LIVE_TIMEOUTS = Object.freeze({
  segment_open_ms: 20_000,
  opportunity_exchange_ms: 45_000,
  retention_ms: 10_000,
  control_ms: 10_000,
  segment_close_ms: 10_000,
});

const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const PREPARE_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-prepare/v1\n";
const PREFLIGHT_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-preflight/v1\n";
const AUTHORIZATION_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-authorization/v1\n";
const AUTHORIZATION_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-authorization-artifact/v1\n";
const QUALIFICATION_TERMINAL_DOMAIN = "harshas-amazing-call-center/lc4-qualification-terminal/v1\n";
const QUALIFICATION_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-retained-qualification/v1\n";
const LEDGER_EVENT_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-ledger-event/v1\n";
const RUN_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-run/v1\n";
const REPORT_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-report/v1\n";

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

export type Lc4DevLivePrepareArtifact = Readonly<{
  schema_version: 1;
  runner_version: typeof LC4_DEV_LIVE_RUNNER_VERSION;
  protocol_id: "HACC-LC4-DEV-v1";
  execution_id: string;
  created_at: string;
  source_commit: string;
  source_tree_sha256: string;
  corpus_sha256: string;
  provider_profile_manifest_sha256: string;
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
}>): Lc4DevLivePrepareArtifact {
  requireId(input.execution_id, "LC4-DEV execution ID");
  assertIso(input.created_at, "LC4-DEV prepare time");
  if (!COMMIT.test(input.source_commit)) throw new Error("LC4-DEV source commit must be a full Git SHA-1");
  requireHash(input.source_tree_sha256, "LC4-DEV source tree");
  requireHash(input.audio_manifest_sha256, "LC4-DEV audio manifest");
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
    schema_version: 1 as const,
    runner_version: LC4_DEV_LIVE_RUNNER_VERSION,
    protocol_id: "HACC-LC4-DEV-v1" as const,
    execution_id: input.execution_id,
    created_at: input.created_at,
    source_commit: input.source_commit,
    source_tree_sha256: input.source_tree_sha256,
    corpus_sha256: corpus.artifact_sha256,
    provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
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

export type Lc4DevLivePreflightArtifact = Readonly<{
  schema_version: 1;
  execution_id: string;
  checked_at: string;
  prepare_sha256: string;
  qualification_gate_sha256: string;
  qualification_terminal_root_sha256: string;
  qualification_retained_artifact_sha256: string;
  credential_identity_set_sha256: string;
  control_plane_manifest_sha256: string;
  listener_evidence_manifest_sha256: string;
  immutable_ledger_genesis_sha256: string;
  adapter_contract: "lc4-development-realtime-v1";
  adapter_boundary: "dev_factory_unlocked_confirmatory_factory_still_frozen";
  all_six_episodes_qualified: true;
  budget_verified: true;
  audio_verified: true;
  provider_calls_authorized: true;
  authorization_scope: "six_public_development_episodes_only";
  expires_at: string;
  authorization_artifact_sha256: string;
  authority_trust_root_sha256: string;
  authorization: Lc4DevLiveAuthorizationArtifact;
  qualification: Lc4DevRetainedQualificationReceipt;
  authorization_verified: true;
  preflight_sha256: string;
}>;

export type Lc4DevLiveAuthorizationBody = Readonly<{
  schema_version: 1;
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

export type Lc4DevRetainedQualificationReceipt = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC4-DEV-v1";
  status: "passed";
  providers: readonly ["openai", "gemini", "xai"];
  terminal_root_sha256: string;
  retained_artifact_sha256: string;
  qualification_artifact_sha256: string;
  response_tool_canary_artifact_sha256: string;
  plan: Lc4QualificationPlan;
  terminal: Lc4QualificationTerminalArtifact;
  response_tool_canary: ProviderResponseToolCanaryArtifact;
  receipt_sha256: string;
}>;

export function createLc4DevRetainedQualificationReceipt(input: Readonly<{
  plan: Lc4QualificationPlan;
  terminal: Lc4QualificationTerminalArtifact;
  response_tool_canary: ProviderResponseToolCanaryArtifact;
}>): Lc4DevRetainedQualificationReceipt {
  assertLc4QualificationPlan(input.plan);
  const targets = createLc4QualificationTargets();
  assertProviderResponseToolCanaryArtifactIntegrity(input.response_tool_canary, targets);
  const { terminal_sha256, ...terminalBody } = input.terminal;
  if (sha256Hex(`${QUALIFICATION_TERMINAL_DOMAIN}${canonicalJson(terminalBody)}`) !== terminal_sha256) {
    throw new Error("LC4-DEV qualification terminal hash mismatch");
  }
  if (input.terminal.schema_version !== 1
    || input.terminal.runner_version !== LC4_QUALIFICATION_RUNNER_VERSION
    || input.terminal.status !== "passed"
    || input.terminal.plan_sha256 !== input.plan.plan_sha256
    || input.terminal.source_commit !== input.plan.source_commit
    || input.terminal.source_tree_sha256 !== input.plan.source_tree_sha256
    || input.terminal.caller_audio_bytes !== 0
    || input.terminal.response_generations_attempted !== 3
    || input.terminal.paid_retries_attempted !== 0
    || input.terminal.results.length !== 3
    || input.response_tool_canary.status !== "passed"
    || input.response_tool_canary.results.length !== 3
    || input.terminal.response_tool_canary_artifact_sha256 !== input.response_tool_canary.artifactSha256
    || input.response_tool_canary.planSha256 !== input.plan.plan_sha256
    || input.response_tool_canary.sourceCommit !== input.plan.source_commit
    || input.response_tool_canary.credentialSetSha256 !== input.plan.credential_set_sha256
    || input.response_tool_canary.configurationMatrixSha256 !== input.plan.configuration_matrix_sha256) {
    throw new Error("LC4-DEV qualification terminal/canary/plan binding is not an exact passing three-provider zero-audio run");
  }
  const expected = input.plan.targets.map((target) => ({ provider: target.provider, model: target.model })).sort((a, b) => a.provider.localeCompare(b.provider));
  const terminalResults = input.terminal.results.map((result) => ({ provider: result.provider, model: result.model })).sort((a, b) => a.provider.localeCompare(b.provider));
  const canaryResults = input.response_tool_canary.results.map((result) => ({ provider: result.provider, model: result.model })).sort((a, b) => a.provider.localeCompare(b.provider));
  if (canonicalJson(expected) !== canonicalJson(terminalResults)
    || canonicalJson(expected) !== canonicalJson(canaryResults)
    || input.terminal.results.some((result) => result.status !== "passed" || result.code !== "gateway_tool_call_observed")
    || input.response_tool_canary.results.some((result) => result.status !== "passed" || result.code !== "gateway_tool_call_observed")) {
    throw new Error("LC4-DEV qualification does not contain 3/3 exact-model passing gateway results");
  }
  for (const terminalResult of input.terminal.results) {
    const canaryResult = input.response_tool_canary.results.find((candidate) => candidate.provider === terminalResult.provider);
    if (!canaryResult
      || canaryResult.model !== terminalResult.model
      || canaryResult.providerToolCallEvidenceSha256 !== terminalResult.provider_tool_call_evidence_sha256) {
      throw new Error("LC4-DEV terminal result differs from retained response canary evidence");
    }
  }
  requireHash(input.terminal.qualification_artifact_sha256, "LC4-DEV qualification handshake artifact");
  const retainedArtifactSha256 = hash(QUALIFICATION_RECEIPT_DOMAIN, {
    plan: input.plan,
    terminal: input.terminal,
    response_tool_canary: input.response_tool_canary,
  });
  const body = {
    schema_version: 1 as const,
    protocol_id: "HACC-LC4-DEV-v1" as const,
    status: "passed" as const,
    providers: ["openai", "gemini", "xai"] as const,
    terminal_root_sha256: input.terminal.terminal_sha256,
    retained_artifact_sha256: retainedArtifactSha256,
    qualification_artifact_sha256: input.terminal.qualification_artifact_sha256,
    response_tool_canary_artifact_sha256: input.response_tool_canary.artifactSha256,
    plan: input.plan,
    terminal: input.terminal,
    response_tool_canary: input.response_tool_canary,
  };
  return freeze({ ...body, receipt_sha256: hash(QUALIFICATION_RECEIPT_DOMAIN, body) });
}

export function assertLc4DevRetainedQualificationReceipt(receipt: Lc4DevRetainedQualificationReceipt): void {
  const rebuilt = createLc4DevRetainedQualificationReceipt({
    plan: receipt.plan,
    terminal: receipt.terminal,
    response_tool_canary: receipt.response_tool_canary,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(receipt)) throw new Error("LC4-DEV retained qualification receipt is not canonical");
}

function verifyDevAuthorization(input: Readonly<{
  artifact: Lc4DevLiveAuthorizationArtifact;
  expected_authority_public_key_fingerprint_sha256: string;
  prepare: Lc4DevLivePrepareArtifact;
  qualification: Lc4DevRetainedQualificationReceipt;
  checked_at: string;
  credential_identity_set_sha256: string;
  control_plane_manifest_sha256: string;
  listener_evidence_manifest_sha256: string;
  immutable_ledger_genesis_sha256: string;
}>): void {
  const { artifact, prepare, qualification } = input;
  assertLc4DevRetainedQualificationReceipt(qualification);
  const body = artifact.body;
  for (const [label, digest] of Object.entries({
    expected_authority_public_key_fingerprint_sha256: input.expected_authority_public_key_fingerprint_sha256,
    authorization_nonce_sha256: body.authorization_nonce_sha256,
    qualification_terminal_root_sha256: qualification.terminal_root_sha256,
    qualification_retained_artifact_sha256: qualification.retained_artifact_sha256,
  })) requireHash(digest, label);
  if (body.schema_version !== 1 || body.protocol_id !== "HACC-LC4-DEV-v1" || body.purpose !== "six_public_development_episodes_only") {
    throw new Error("LC4-DEV authorization has the wrong protocol or purpose");
  }
  assertIso(body.not_before, "LC4-DEV authorization start");
  assertIso(body.expires_at, "LC4-DEV authorization expiry");
  const checked = Date.parse(input.checked_at);
  if (checked < Date.parse(body.not_before) || checked >= Date.parse(body.expires_at)) throw new Error("LC4-DEV authorization is not active");
  if (qualification.schema_version !== 1
    || qualification.protocol_id !== "HACC-LC4-DEV-v1"
    || qualification.status !== "passed"
    || canonicalJson(qualification.providers) !== canonicalJson(["openai", "gemini", "xai"])) {
    throw new Error("LC4-DEV retained qualification is not a three-provider passing terminal receipt");
  }
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

export function createLc4DevLivePreflightArtifact(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  checked_at: string;
  qualification_gate_sha256: string;
  qualification: Lc4DevRetainedQualificationReceipt;
  credential_identity_set_sha256: string;
  control_plane_manifest_sha256: string;
  listener_evidence_manifest_sha256: string;
  immutable_ledger_genesis_sha256: string;
  audio_manifest_sha256: string;
  authorization: Lc4DevLiveAuthorizationArtifact;
  expected_authority_public_key_fingerprint_sha256: string;
}>): Lc4DevLivePreflightArtifact {
  assertLc4DevLivePrepareArtifact(input.prepare);
  assertIso(input.checked_at, "LC4-DEV preflight time");
  for (const [label, digest] of Object.entries({
    qualification_gate_sha256: input.qualification_gate_sha256,
    credential_identity_set_sha256: input.credential_identity_set_sha256,
    control_plane_manifest_sha256: input.control_plane_manifest_sha256,
    listener_evidence_manifest_sha256: input.listener_evidence_manifest_sha256,
    immutable_ledger_genesis_sha256: input.immutable_ledger_genesis_sha256,
  })) requireHash(digest, label);
  if (input.audio_manifest_sha256 !== input.prepare.audio_manifest_sha256) throw new Error("LC4-DEV preflight audio manifest differs from prepare");
  if (input.qualification_gate_sha256 !== input.qualification.retained_artifact_sha256) {
    throw new Error("LC4-DEV qualification gate must be the retained passing qualification artifact");
  }
  verifyDevAuthorization({
    artifact: input.authorization,
    expected_authority_public_key_fingerprint_sha256: input.expected_authority_public_key_fingerprint_sha256,
    prepare: input.prepare,
    qualification: input.qualification,
    checked_at: input.checked_at,
    credential_identity_set_sha256: input.credential_identity_set_sha256,
    control_plane_manifest_sha256: input.control_plane_manifest_sha256,
    listener_evidence_manifest_sha256: input.listener_evidence_manifest_sha256,
    immutable_ledger_genesis_sha256: input.immutable_ledger_genesis_sha256,
  });
  const body = {
    schema_version: 1 as const,
    execution_id: input.prepare.execution_id,
    checked_at: input.checked_at,
    prepare_sha256: input.prepare.prepare_sha256,
    qualification_gate_sha256: input.qualification_gate_sha256,
    qualification_terminal_root_sha256: input.qualification.terminal_root_sha256,
    qualification_retained_artifact_sha256: input.qualification.retained_artifact_sha256,
    credential_identity_set_sha256: input.credential_identity_set_sha256,
    control_plane_manifest_sha256: input.control_plane_manifest_sha256,
    listener_evidence_manifest_sha256: input.listener_evidence_manifest_sha256,
    immutable_ledger_genesis_sha256: input.immutable_ledger_genesis_sha256,
    adapter_contract: "lc4-development-realtime-v1" as const,
    adapter_boundary: "dev_factory_unlocked_confirmatory_factory_still_frozen" as const,
    all_six_episodes_qualified: true as const,
    budget_verified: true as const,
    audio_verified: true as const,
    provider_calls_authorized: true as const,
    authorization_scope: "six_public_development_episodes_only" as const,
    expires_at: input.authorization.body.expires_at,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    authority_trust_root_sha256: input.expected_authority_public_key_fingerprint_sha256,
    authorization: input.authorization,
    qualification: input.qualification,
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
  if (value.maximum_total_micro_usd > LC4_DEV_LIVE_HARD_CEILING_MICRO_USD) throw new Error("LC4-DEV prepare artifact exceeds $15");
  const rebuilt = createLc4DevLivePrepareArtifact({
    execution_id: value.execution_id,
    created_at: value.created_at,
    source_commit: value.source_commit,
    source_tree_sha256: value.source_tree_sha256,
    audio_manifest_sha256: value.audio_manifest_sha256,
    audio_bindings: value.audio_bindings,
    maximum_total_micro_usd: value.maximum_total_micro_usd,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(value)) throw new Error("LC4-DEV prepare artifact is not canonical or internally consistent");
}

export function assertLc4DevLivePreflightArtifact(value: Lc4DevLivePreflightArtifact, prepare: Lc4DevLivePrepareArtifact, now: Date): void {
  const { preflight_sha256: claimed, ...body } = value;
  if (hash(PREFLIGHT_DOMAIN, body) !== claimed || value.prepare_sha256 !== prepare.prepare_sha256) {
    throw new Error("LC4-DEV preflight artifact hash or prepare binding mismatch");
  }
  if (value.provider_calls_authorized !== true || value.authorization_scope !== "six_public_development_episodes_only") {
    throw new Error("LC4-DEV preflight lacks narrow provider authorization");
  }
  if (now.getTime() >= Date.parse(value.expires_at)) throw new Error("LC4-DEV preflight has expired");
  const rebuilt = createLc4DevLivePreflightArtifact({
    prepare,
    checked_at: value.checked_at,
    qualification_gate_sha256: value.qualification_gate_sha256,
    qualification: value.qualification,
    credential_identity_set_sha256: value.credential_identity_set_sha256,
    control_plane_manifest_sha256: value.control_plane_manifest_sha256,
    listener_evidence_manifest_sha256: value.listener_evidence_manifest_sha256,
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

export type Lc4DevControlReceipt = Readonly<{
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
  event_type: "episode_opened" | "audio_submitted" | "repair_decided" | "repair_audio_submitted" | "repair_completed" | "opportunity_completed" | "episode_terminal";
  episode_id: string;
  opportunity_id: string | null;
  payload_sha256: string;
  previous_event_sha256: string | null;
  event_sha256: string;
}>;

export type Lc4DevLiveRunArtifact = Readonly<{
  schema_version: 1;
  execution_id: string;
  prepare_sha256: string;
  preflight_sha256: string;
  started_at: string;
  completed_at: string;
  status: "completed" | "failed";
  episodes_started: number;
  episodes_completed: number;
  opportunities_submitted: number;
  opportunities_completed: number;
  provider_calls_made: number;
  repair_playbacks: number;
  total_response_generations: number;
  paid_retry_count: 0;
  maximum_total_micro_usd: number;
  retained_caller_audio: number;
  retained_assistant_audio: number;
  listener_evidence_count: number;
  mechanism_receipt_count: number;
  failure_class: "pre-open" | "transport" | "timeout" | "evidence" | null;
  failure_message_sha256: string | null;
  ledger: readonly Lc4DevImmutableLedgerEvent[];
  ledger_head_sha256: string | null;
  run_sha256: string;
}>;

export type Lc4DevLiveRunnerDependencies = Readonly<{
  adapter: Lc4DevelopmentRealtimeAdapter;
  caller_audio: Readonly<{ load(binding: Lc4DevCallerAudioBinding): Promise<Uint8Array> }>;
  retention: Readonly<{ retain(input: Readonly<{ episode_id: string; opportunity_id: string; direction: "caller_input" | "caller_repair" | "assistant_output" | "assistant_repair_output"; pcm: Uint8Array }>): Promise<Readonly<{ artifact_sha256: string; byte_length: number }>> }>;
  control: Readonly<{ next(input: Readonly<{ episode: Lc4DevLiveEpisodePlan; opportunity: Lc4PublicDevOpportunity; previous_exchange_sha256: string | null }>): Promise<Lc4DevControlReceipt> }>;
  repair: Readonly<Record<LiveStsProvider, Lc4DevRepairPlaybackController>>;
  ledger: Readonly<{ append(event: Lc4DevImmutableLedgerEvent): Promise<void> }>;
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

function assertControl(receipt: Lc4DevControlReceipt, arm: Arm): void {
  for (const [label, digest] of Object.entries({
    flow_state_sha256: receipt.flow_state_sha256,
    gateway_transcript_head_sha256: receipt.gateway_transcript_head_sha256,
    tool_world_state_sha256: receipt.tool_world_state_sha256,
    worker_state_sha256: receipt.worker_state_sha256,
    repair_state_sha256: receipt.repair_state_sha256,
    native_continuity_state_sha256: receipt.native_continuity_state_sha256,
    control_receipt_sha256: receipt.control_receipt_sha256,
  })) requireHash(digest, label);
  if ((arm === "native" && receipt.response_control.kind !== "native_context")
    || (arm === "hacc" && receipt.response_control.kind !== "hacc_response_plan")) {
    throw new Error("LC4-DEV response control differs from randomized arm");
  }
  if (receipt.response_control.kind === "native_context"
    && (!receipt.response_control.instructions.trim()
      || sha256Hex(receipt.response_control.instructions) !== receipt.response_control.instructions_sha256)) {
    throw new Error("LC4-DEV native context hash mismatch");
  }
}

export async function executeLc4DevLiveRun(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  preflight: Lc4DevLivePreflightArtifact;
  dependencies: Lc4DevLiveRunnerDependencies;
}>): Promise<Lc4DevLiveRunArtifact> {
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
  const corpus = createLc4PublicDevelopmentCorpus();
  if (corpus.artifact_sha256 !== input.prepare.corpus_sha256) throw new Error("LC4-DEV prepared corpus differs from runtime corpus");
  const startedAt = input.dependencies.now().toISOString();
  let previousEvent: string | null = null;
  let sequence = 0;
  const ledger: Lc4DevImmutableLedgerEvent[] = [];
  let episodesStarted = 0;
  let episodesCompleted = 0;
  let opportunitiesSubmitted = 0;
  let opportunitiesCompleted = 0;
  let retainedCaller = 0;
  let retainedAssistant = 0;
  let listenerEvidence = 0;
  let mechanismReceipts = 0;
  let repairPlaybacks = 0;
  let totalResponseGenerations = 0;
  let failureClass: Lc4DevLiveRunArtifact["failure_class"] = null;
  let failureMessage: string | null = null;

  const append = async (eventType: Lc4DevImmutableLedgerEvent["event_type"], episodeId: string, opportunityId: string | null, payload: JsonValue) => {
    const body = {
      sequence: ++sequence,
      observed_at: input.dependencies.now().toISOString(),
      event_type: eventType,
      episode_id: episodeId,
      opportunity_id: opportunityId,
      payload_sha256: sha256Hex(canonicalJson(payload)),
      previous_event_sha256: previousEvent,
    };
    const event = freeze({ ...body, event_sha256: hash(LEDGER_EVENT_DOMAIN, body) });
    await input.dependencies.ledger.append(event);
    ledger.push(event);
    previousEvent = event.event_sha256;
  };

  try {
    for (const episode of input.prepare.episodes) {
      const providerBindings = input.prepare.audio_bindings.filter((binding) => binding.provider === episode.provider);
      let previousRotationReceipt: string | null = null;
      let priorExchange: string | null = null;
      episodesStarted += 1;
      await append("episode_opened", episode.episode_id, null, { provider: episode.provider, arm: episode.arm, model: episode.model });
      for (const segmentOrdinal of [1, 2, 3] as const) {
        failureClass = "transport";
        const session = await bounded("segment-open", LC4_DEV_LIVE_TIMEOUTS.segment_open_ms, () => input.dependencies.adapter.openSegment({
          episode,
          segment_ordinal: segmentOrdinal,
          previous_rotation_receipt_sha256: previousRotationReceipt,
        }));
        try {
          const start = (segmentOrdinal - 1) * 20;
          for (let offset = 0; offset < 20; offset += 1) {
            const opportunity = corpus.opportunities[start + offset]!;
            const binding = providerBindings[start + offset]!;
            failureClass = "pre-open";
            const callerPcm = await bounded("caller-audio-load", LC4_DEV_LIVE_TIMEOUTS.retention_ms, () => input.dependencies.caller_audio.load(binding));
            if (callerPcm.byteLength !== binding.pcm_byte_length || sha256Hex(callerPcm) !== binding.pcm_sha256) {
              throw new Error("LC4-DEV loaded caller audio differs from prepared binding");
            }
            const callerReceipt = await bounded("caller-audio-retention", LC4_DEV_LIVE_TIMEOUTS.retention_ms, () => input.dependencies.retention.retain({
              episode_id: episode.episode_id,
              opportunity_id: opportunity.id,
              direction: "caller_input",
              pcm: callerPcm,
            }));
            if (callerReceipt.artifact_sha256 !== binding.pcm_sha256 || callerReceipt.byte_length !== callerPcm.byteLength) {
              throw new Error("LC4-DEV caller retention receipt is invalid");
            }
            retainedCaller += 1;
            failureClass = "evidence";
            const control = await bounded("control", LC4_DEV_LIVE_TIMEOUTS.control_ms, () => input.dependencies.control.next({
              episode,
              opportunity,
              previous_exchange_sha256: priorExchange,
            }));
            assertControl(control, episode.arm);
            mechanismReceipts += 1;
            failureClass = "transport";
            opportunitiesSubmitted += 1;
            await append("audio_submitted", episode.episode_id, opportunity.id, { caller_pcm_sha256: binding.pcm_sha256, control_receipt_sha256: control.control_receipt_sha256 });
            const exchange = await bounded("opportunity-exchange", LC4_DEV_LIVE_TIMEOUTS.opportunity_exchange_ms, () => session.exchangeCanonical({
              opportunity,
              caller_pcm: callerPcm,
              control_receipt: control,
            }));
            totalResponseGenerations += 1;
            if (exchange.playback_kind !== "canonical" || exchange.opportunity_id !== opportunity.id || exchange.assistant_pcm.byteLength < 2 || exchange.assistant_pcm.byteLength % 2 !== 0) {
              throw new Error("LC4-DEV provider exchange evidence is incomplete");
            }
            requireHash(exchange.provider_exchange_sha256, "LC4-DEV provider exchange");
            requireHash(exchange.listener_evidence_sha256, "LC4-DEV listener evidence");
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
            await append("repair_decided", episode.episode_id, opportunity.id, {
              decision_receipt_sha256: repairDecision.receipt.decision_receipt_sha256,
              decision_sha256: repairDecision.receipt.decision.decision_sha256,
              repair_selected: repairDecision.playback !== null,
            });
            let effectiveExchangeSha256 = exchange.provider_exchange_sha256;
            let effectiveListenerEvidenceSha256 = exchange.listener_evidence_sha256;
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
              });
              const repairExchange = await bounded("repair-exchange", LC4_DEV_LIVE_TIMEOUTS.opportunity_exchange_ms, () => session.exchangeRepair({
                opportunity,
                repair,
                decision_receipt: repairDecision.receipt,
                control_receipt: control,
              }));
              totalResponseGenerations += 1;
              if (repairExchange.playback_kind !== "repair" || repairExchange.opportunity_id !== opportunity.id
                || repairExchange.assistant_pcm.byteLength < 2 || repairExchange.assistant_pcm.byteLength % 2 !== 0) {
                throw new Error("LC4-DEV repair exchange evidence is incomplete");
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
              retainedAssistant += 1;
              listenerEvidence += 1;
              repairPlaybacks += 1;
              effectiveExchangeSha256 = repairExchange.provider_exchange_sha256;
              effectiveListenerEvidenceSha256 = repairExchange.listener_evidence_sha256;
              await append("repair_completed", episode.episode_id, opportunity.id, {
                playback_receipt_sha256: playbackReceipt.playback_receipt_sha256,
                repair_exchange_sha256: repairExchange.provider_exchange_sha256,
                repair_listener_evidence_sha256: repairExchange.listener_evidence_sha256,
                advances_canonical_horizon: false,
              });
            }
            const finalized = await session.finalizeOpportunity({
              opportunity_id: opportunity.id,
              decision_receipt_sha256: repairDecision.receipt.decision_receipt_sha256,
              repair_played: repairDecision.playback !== null,
            });
            requireHash(finalized.opportunity_receipt_sha256, "LC4-DEV opportunity finalize receipt");
            opportunitiesCompleted += 1;
            priorExchange = effectiveExchangeSha256;
            await append("opportunity_completed", episode.episode_id, opportunity.id, {
              canonical_provider_exchange_sha256: exchange.provider_exchange_sha256,
              canonical_listener_evidence_sha256: exchange.listener_evidence_sha256,
              effective_provider_exchange_sha256: effectiveExchangeSha256,
              effective_listener_evidence_sha256: effectiveListenerEvidenceSha256,
              decision_receipt_sha256: repairDecision.receipt.decision_receipt_sha256,
              opportunity_receipt_sha256: finalized.opportunity_receipt_sha256,
              assistant_pcm_sha256: assistantReceipt.artifact_sha256,
            });
          }
        } finally {
          failureClass = "transport";
          const closed = await bounded("segment-close", LC4_DEV_LIVE_TIMEOUTS.segment_close_ms, () => session.close());
          requireHash(closed.rotation_receipt_sha256, "LC4-DEV segment rotation receipt");
          previousRotationReceipt = closed.rotation_receipt_sha256;
        }
      }
      episodesCompleted += 1;
      await append("episode_terminal", episode.episode_id, null, { status: "completed", canonical_opportunities: 60 });
    }
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : "LC4-DEV live run failed";
    if (failureMessage.startsWith("timeout:")) failureClass = "timeout";
  }
  const completedAt = input.dependencies.now().toISOString();
  const completed = episodesCompleted === 6 && opportunitiesCompleted === 360;
  const body = {
    schema_version: 1 as const,
    execution_id: input.prepare.execution_id,
    prepare_sha256: input.prepare.prepare_sha256,
    preflight_sha256: input.preflight.preflight_sha256,
    started_at: startedAt,
    completed_at: completedAt,
    status: completed ? "completed" as const : "failed" as const,
    episodes_started: episodesStarted,
    episodes_completed: episodesCompleted,
    opportunities_submitted: opportunitiesSubmitted,
    opportunities_completed: opportunitiesCompleted,
    provider_calls_made: totalResponseGenerations,
    repair_playbacks: repairPlaybacks,
    total_response_generations: totalResponseGenerations,
    paid_retry_count: 0 as const,
    maximum_total_micro_usd: input.prepare.maximum_total_micro_usd,
    retained_caller_audio: retainedCaller,
    retained_assistant_audio: retainedAssistant,
    listener_evidence_count: listenerEvidence,
    mechanism_receipt_count: mechanismReceipts,
    failure_class: completed ? null : failureClass,
    failure_message_sha256: failureMessage === null ? null : sha256Hex(failureMessage),
    ledger: Object.freeze(ledger),
    ledger_head_sha256: previousEvent,
  };
  return freeze({ ...body, run_sha256: hash(RUN_DOMAIN, body) });
}

export type Lc4DevLiveReportArtifact = Readonly<{
  schema_version: 1;
  execution_id: string;
  run_sha256: string;
  completed: boolean;
  exact_six_episode_horizon: boolean;
  exact_opportunity_horizon: boolean;
  exact_playback_accounting: boolean;
  evidence_complete: boolean;
  paid_retry_count: 0;
  efficacy_claim_eligible: false;
  interpretation: "development mechanism evidence only; not confirmatory provider efficacy evidence";
  report_sha256: string;
}>;

export function createLc4DevLiveReportArtifact(run: Lc4DevLiveRunArtifact): Lc4DevLiveReportArtifact {
  const { run_sha256: claimed, ...runBody } = run;
  if (hash(RUN_DOMAIN, runBody) !== claimed) throw new Error("LC4-DEV run artifact hash mismatch");
  const body = {
    schema_version: 1 as const,
    execution_id: run.execution_id,
    run_sha256: run.run_sha256,
    completed: run.status === "completed",
    exact_six_episode_horizon: run.episodes_completed === 6,
    exact_opportunity_horizon: run.opportunities_completed === 360,
    exact_playback_accounting: run.total_response_generations === 360 + run.repair_playbacks
      && run.provider_calls_made === run.total_response_generations,
    evidence_complete: run.retained_caller_audio === 360 + run.repair_playbacks
      && run.retained_assistant_audio === 360 + run.repair_playbacks
      && run.listener_evidence_count === 360 + run.repair_playbacks
      && run.mechanism_receipt_count === 360,
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

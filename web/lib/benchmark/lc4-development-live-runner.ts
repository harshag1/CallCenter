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
  LC4_QUALIFICATION_MAXIMUM_RESPONSE_GENERATIONS,
  LC4_QUALIFICATION_RUNNER_VERSION,
  LC4_QUALIFICATION_TOTAL_CALLER_AUDIO_BYTES,
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
  Lc4DevExchangeEvidence,
  Lc4DevelopmentRealtimeAdapter,
} from "./lc4-development-realtime-contract";
import type { Lc4DevRepairPlaybackController } from "./lc4-development-repair-playback";
import {
  LC4_DEV_BRANCH_OPPORTUNITY_ID,
  assertLc4DevCallerBranchDecision,
  assertLc4DevCallerBranchMatrixArtifact,
  lc4DevBranchedOpportunity,
  type Lc4DevCallerBranchDecision,
  type Lc4DevCallerBranchMatrixArtifact,
} from "./lc4-development-caller-branch";

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
  // The provider adapter owns the 45 s response timer and must first retain a
  // sanitized failure envelope. This outer fuse is deliberately later so it
  // cannot win the race and discard the diagnostic.
  opportunity_exchange_ms: 50_000,
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
const QUALIFICATION_TERMINAL_DOMAIN = "harshas-amazing-call-center/lc4-qualification-terminal/v2\n";
const QUALIFICATION_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-dev-retained-qualification/v1\n";
const LEDGER_EVENT_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-ledger-event/v1\n";
const RUN_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-run/v1\n";
const REPORT_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-report/v1\n";
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
    || input.terminal.caller_audio_bytes !== LC4_QUALIFICATION_TOTAL_CALLER_AUDIO_BYTES
    || input.terminal.response_generations_attempted !== LC4_QUALIFICATION_MAXIMUM_RESPONSE_GENERATIONS
    || input.terminal.paid_retries_attempted !== 0
    || input.terminal.results.length !== 3
    || input.terminal.dev_audio_results.length !== 3
    || input.response_tool_canary.status !== "passed"
    || input.response_tool_canary.results.length !== 3
    || input.terminal.response_tool_canary_artifact_sha256 !== input.response_tool_canary.artifactSha256
    || input.response_tool_canary.planSha256 !== input.plan.plan_sha256
    || input.response_tool_canary.sourceCommit !== input.plan.source_commit
    || input.response_tool_canary.credentialSetSha256 !== input.plan.credential_set_sha256
    || input.response_tool_canary.configurationMatrixSha256 !== input.plan.configuration_matrix_sha256) {
    throw new Error("LC4-DEV qualification terminal/canary/plan binding is not an exact passing three-provider zero-audio plus packetized-audio run");
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
  requireHash(input.terminal.dev_audio_canary_artifact_sha256 ?? "", "LC4-DEV packetized-audio canary artifact");
  const expectedProviders = input.plan.targets.map((target) => target.provider);
  if (canonicalJson(input.terminal.dev_audio_results.map((result) => result.provider)) !== canonicalJson(expectedProviders)) {
    throw new Error("LC4-DEV packetized-audio results are not in the exact plan provider order");
  }
  for (const result of input.terminal.dev_audio_results) {
    const planned = input.plan.targets.find((target) => target.provider === result.provider);
    if (!planned
      || result.model !== planned.model
      || result.status !== "passed"
      || result.code !== "dev_gateway_tool_call_observed"
      || result.caller_audio_bytes !== planned.caller_audio_bytes
      || result.response_generation_requested !== true
      || result.delivery_complete !== true
      || result.chunk_count < 2
      || result.packetizer_sha256 !== planned.packetizer_sha256
      || result.tool_schema_sha256 !== planned.dev_audio_tool_schema_sha256
      || result.audio_delivery_profile_sha256 !== planned.audio_delivery_profile_sha256
      || result.control_bytes !== planned.dev_control_bytes
      || result.control_sha256 !== planned.dev_control_sha256
      || result.audio_sha256 !== planned.caller_audio_sha256) {
      throw new Error(`LC4-DEV ${result.provider} packetized-audio result differs from its immutable plan`);
    }
    for (const [label, digest] of Object.entries({
      tool_schema_sha256: result.tool_schema_sha256,
      packetizer_sha256: result.packetizer_sha256,
      audio_delivery_profile_sha256: result.audio_delivery_profile_sha256,
      control_sha256: result.control_sha256,
      audio_sha256: result.audio_sha256,
      wire_evidence_sha256: result.wire_evidence_sha256,
      usage_evidence_sha256: result.usage_evidence_sha256,
      response_generation_evidence_sha256: result.response_generation_evidence_sha256,
      provider_tool_call_evidence_sha256: result.provider_tool_call_evidence_sha256 ?? "",
      failure_evidence_sha256: result.failure_evidence_sha256,
    })) requireHash(digest, `LC4-DEV ${result.provider} ${label}`);
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
  event_type: "episode_opened" | "caller_branch_selected" | "audio_submitted" | "opportunity_failed" | "segment_failed" | "repair_decided" | "repair_audio_submitted" | "repair_completed" | "opportunity_completed" | "episode_terminal";
  episode_id: string;
  opportunity_id: string | null;
  payload_sha256: string;
  payload_evidence: Lc4DevReplayArtifactReference;
  evidence_references: readonly Lc4DevReplayArtifactReference[];
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
  failure_class: "pre-open" | "transport" | "timeout" | "evidence" | null;
  failure_message_sha256: string | null;
  ledger: readonly Lc4DevImmutableLedgerEvent[];
  ledger_head_sha256: string | null;
  run_sha256: string;
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
  assertLc4DevCallerBranchMatrixArtifact(
    input.dependencies.caller_branch.matrix,
    input.dependencies.caller_branch.trust,
  );
  if (input.dependencies.caller_branch.matrix.audio_manifest_sha256 !== input.prepare.audio_manifest_sha256) {
    throw new Error("LC4-DEV caller branch matrix differs from the prepare-bound audio manifest");
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
  let episodeFinalizations = 0;
  let responseGenerationsRequested = 0;
  let providerCallsStarted = 0;
  let responseGenerationsCompleted = 0;
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

  const assertExchangeReplayBinding = async (exchange: Lc4DevExchangeEvidence): Promise<void> => {
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
    await input.dependencies.evidence.assertResolvable(exchange.listener_evidence);
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
    playback_kind?: "canonical" | "repair" | null;
    secondary_failure_evidence_sha256?: string | null;
  }>): Lc4DevFailureEvidence => {
    const timedOut = failureInput.error instanceof Error && failureInput.error.message.startsWith("timeout:");
    return createLc4DevFailureEvidence({
      schema_version: 2,
      evidence_version: LC4_DEV_FAILURE_EVIDENCE_VERSION,
      redaction: "strict_allowlist_no_provider_plaintext_credentials_or_raw_ids",
      failure_role: failureInput.role,
      failure_stage: failureInput.role === "cleanup" ? "segment_close" : timedOut ? "provider_wait" : "pre_send_contract",
      failure_code: failureInput.role === "cleanup" ? "segment_close_failed" : timedOut ? "provider_response_timeout" : "adapter_failure",
      failure_class: failureInput.role === "cleanup" ? "cleanup" : timedOut ? "timeout" : "unknown",
      episode_id: failureInput.episode.episode_id,
      opportunity_id: failureInput.opportunity_id,
      provider: failureInput.episode.provider,
      model: failureInput.episode.model,
      playback_kind: failureInput.playback_kind ?? (failureInput.opportunity_id === null ? null : "canonical"),
      operation_order: Object.freeze([]),
      caller_pcm_sha256: failureInput.caller_pcm_sha256,
      caller_pcm_byte_length: failureInput.caller_pcm_byte_length,
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

  try {
    for (const episode of input.prepare.episodes) {
      const providerBindings = input.prepare.audio_bindings.filter((binding) => binding.provider === episode.provider);
      let previousRotationReceipt: string | null = null;
      let priorExchange: string | null = null;
      let lastOpportunityId: string | null = null;
      let primaryFailureEvidenceSha256: string | null = null;
      const segmentFinalizations: Lc4DevReplayArtifactReference[] = [];
      const episodeOpportunityStart = opportunitiesCompleted;
      const episodeResponseStart = responseGenerationsCompleted;
      const episodeRepairStart = repairPlaybacks;
      episodesStarted += 1;
      await append("episode_opened", episode.episode_id, null, { provider: episode.provider, arm: episode.arm, model: episode.model });
      for (const segmentOrdinal of [1, 2, 3] as const) {
        failureClass = "transport";
        const session = await bounded("segment-open", LC4_DEV_LIVE_TIMEOUTS.segment_open_ms, () => input.dependencies.adapter.openSegment({
          episode,
          segment_ordinal: segmentOrdinal,
          previous_rotation_receipt_sha256: previousRotationReceipt,
        }));
        let segmentBodyFailed = false;
        try {
          const start = (segmentOrdinal - 1) * 20;
          for (let offset = 0; offset < 20; offset += 1) {
            const canonicalOpportunity = corpus.opportunities[start + offset]!;
            lastOpportunityId = canonicalOpportunity.id;
            const binding = providerBindings[start + offset]!;
            let opportunity = canonicalOpportunity;
            let callerPcm: Uint8Array;
            let expectedCallerPcmSha256 = binding.pcm_sha256;
            let expectedCallerPcmByteLength = binding.pcm_byte_length;
            let branchDecisionEvidence: Lc4DevReplayArtifactReference | null = null;
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
            assertControl(control, episode.arm);
            if (retainedControl.evidence.evidence_sha256 !== control.control_receipt_sha256) {
              throw new Error("LC4-DEV control authority body is not retained under its receipt hash");
            }
            mechanismReceipts += 1;
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
            responseGenerationsRequested += 1;
            try {
              exchange = await bounded("opportunity-exchange", LC4_DEV_LIVE_TIMEOUTS.opportunity_exchange_ms, () => session.exchangeCanonical({
                opportunity,
                caller_pcm: callerPcm,
                control_receipt: control,
              }));
              providerCallsStarted += 1;
              responseGenerationsCompleted += 1;
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
                  });
              const retainedFailure = isLc4DevFailureEvidenceError(error) && error.retained_evidence !== null
                ? error.retained_evidence
                : await retainFailure(failure);
              if (retainedFailure.evidence_sha256 !== failure.failure_evidence_sha256) {
                throw new Error("LC4-DEV failure evidence is not retained under its failure hash");
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
              }, [retainedFailure]);
              primaryFailureEvidenceSha256 = failure.failure_evidence_sha256;
              throw isLc4DevFailureEvidenceError(error)
                ? error
                : new Lc4DevFailureEvidenceError(failure, retainedFailure);
            }
            if (exchange.playback_kind !== "canonical" || exchange.opportunity_id !== opportunity.id || exchange.assistant_pcm.byteLength < 2 || exchange.assistant_pcm.byteLength % 2 !== 0) {
              throw new Error("LC4-DEV provider exchange evidence is incomplete");
            }
            await assertExchangeReplayBinding(exchange);
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
              responseGenerationsRequested += 1;
              try {
                repairExchange = await bounded("repair-exchange", LC4_DEV_LIVE_TIMEOUTS.opportunity_exchange_ms, () => session.exchangeRepair({
                  opportunity,
                  repair,
                  decision_receipt: repairDecision.receipt,
                  control_receipt: control,
                }));
                providerCallsStarted += 1;
                responseGenerationsCompleted += 1;
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
              if (repairExchange.playback_kind !== "repair" || repairExchange.opportunity_id !== opportunity.id
                || repairExchange.assistant_pcm.byteLength < 2 || repairExchange.assistant_pcm.byteLength % 2 !== 0) {
                throw new Error("LC4-DEV repair exchange evidence is incomplete");
              }
              await assertExchangeReplayBinding(repairExchange);
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
              await append("repair_completed", episode.episode_id, opportunity.id, {
                playback_receipt_sha256: playbackReceipt.playback_receipt_sha256,
                repair_exchange_sha256: repairExchange.provider_exchange_sha256,
                repair_listener_evidence_sha256: repairExchange.listener_evidence_sha256,
                advances_canonical_horizon: false,
              }, [playbackEvidence, repairExchange.provider_exchange_evidence, repairExchange.listener_evidence]);
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
            await append("opportunity_completed", episode.episode_id, opportunity.id, {
              canonical_provider_exchange_sha256: exchange.provider_exchange_sha256,
              canonical_listener_evidence_sha256: exchange.listener_evidence_sha256,
              effective_provider_exchange_sha256: effectiveExchangeSha256,
              effective_listener_evidence_sha256: effectiveListenerEvidenceSha256,
              decision_receipt_sha256: repairDecision.receipt.decision_receipt_sha256,
              opportunity_receipt_sha256: finalized.opportunity_receipt_sha256,
              assistant_pcm_sha256: assistantReceipt.artifact_sha256,
              caller_branch_decision_sha256: branchDecisionEvidence?.evidence_sha256 ?? null,
            }, [
              exchange.provider_exchange_evidence,
              exchange.listener_evidence,
              repairDecisionEvidence,
              finalized.opportunity_finalization,
              assistantReceipt.evidence,
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
    }
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : "LC4-DEV live run failed";
    if (failureMessage.startsWith("timeout:")) failureClass = "timeout";
  }
  const completedAt = input.dependencies.now().toISOString();
  const completed = episodesCompleted === 6
    && opportunitiesCompleted === 360
    && episodeFinalizations === 6;
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
  execution_evidence_complete: boolean;
  authority_scoreability: "scorable" | "unscorable_missing_authority_evidence" | "unscorable_invalid_authority_evidence";
  authority_passed: number | null;
  authority_evaluated: number | null;
  authority_evidence_invalid: number;
  authority_replay_set_sha256: string | null;
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

export function createLc4DevLiveReportArtifact(
  run: Lc4DevLiveRunArtifact,
  authority: Lc4DevAuthorityReportInput = Object.freeze({
    status: "unscorable_missing_authority_evidence",
    passed: null,
    evaluated: null,
    evidence_invalid: 6,
    episode_replay_sha256s: Object.freeze([]),
  }),
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
  const executionEvidenceComplete = run.retained_caller_audio === 360 + run.repair_playbacks
    && run.retained_assistant_audio === 360 + run.repair_playbacks
    && run.listener_evidence_count === 360 + run.repair_playbacks
    && run.mechanism_receipt_count === 360
    && run.episode_finalization_count === 6
    && run.replay_evidence_reference_count >= run.ledger.length;
  const authorityScorable = authority.status === "scorable"
    && authority.evaluated === 6
    && authority.passed !== null
    && authority.evidence_invalid === 0
    && authority.episode_replay_sha256s.length === 6;
  const executionComplete = run.status === "completed"
    && run.episodes_completed === 6
    && run.opportunities_completed === 360
    && run.episode_finalization_count === 6;
  const taskResultsAvailable = authorityScorable && executionComplete;
  const body = {
    schema_version: 1 as const,
    execution_id: run.execution_id,
    run_sha256: run.run_sha256,
    completed: run.status === "completed",
    exact_six_episode_horizon: run.episodes_completed === 6,
    exact_opportunity_horizon: run.opportunities_completed === 360,
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

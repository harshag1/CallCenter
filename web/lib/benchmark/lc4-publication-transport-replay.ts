import { createPublicKey } from "node:crypto";

import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "./artifacts";
import { independentAsrContractSha256 } from "./audible-evidence";
import {
  createLc4DevReplayEvidenceStore,
  type Lc4DevReplayArtifactReference,
} from "./lc4-development-evidence-retention";
import {
  createLc4ImmutableCas,
  type Lc4ImmutableCas,
} from "./lc4-development-live-dependencies";
import {
  assertLc4DevLivePreflightArtifact,
  assertLc4DevLivePrepareArtifact,
  type Lc4DevLiveEpisodePlan,
  type Lc4DevLivePreflightArtifact,
  type Lc4DevLivePrepareArtifact,
  type Lc4DevLiveRunArtifact,
} from "./lc4-development-live-runner";
import {
  createLc4PublicDevelopmentCorpus,
} from "./lc4-public-development-corpus";
import {
  assertLc4ProviderExchangeReplayProjection,
} from "./lc4-provider-exchange-replay";
import {
  createLc4ProviderExecutionProfile,
} from "./lc4-production-runner-foundation";
import {
  replayLc4DevelopmentListenerAuthority,
} from "./lc4-development-listener-authority-replay";
import {
  replayLc4ListenerInvocation,
} from "./lc4-listener-invocation-replay";
import type { BenchmarkKernelAttestationTrust } from "./kernel-attestation";
import {
  assertLc4DevOperatorAuthorizationDag,
} from "./lc4-development-operator-cli";

const HASH = /^[a-f0-9]{64}$/u;
const REPLAY_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-transport-replay/v2\n";
const EPISODE_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-transport-episode-set/v2\n";
const RESPONSE_GENERATION_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-response-generation-set/v1\n";
const LISTENER_AUTHORITY_REPLAY_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-listener-authority-replay-set/v1\n";
const LISTENER_INVOCATION_REPLAY_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-listener-invocation-replay-set/v1\n";

export type Lc4PublicationOutputAudioLineageScope =
  | "client_observed_identity_scoped_wire_pcm_capture_cas_evaluator_exact"
  | "client_observed_interval_wire_projection_capture_cas_evaluator_exact_complete_frame_attribution_provider_response_id_unavailable"
  | "capture_cas_evaluator_exact_provider_output_wire_completeness_unverified";

export type Lc4PublicationEpisodeTransportReplay = Readonly<{
  episode_id: string;
  provider: "openai" | "gemini" | "xai";
  arm: "native" | "hacc";
  model: string;
  transport_purpose: "finite_prerecorded_efficacy" | null;
  transport_mode: "manual_commit";
  transport_profile_sha256: string;
  output_audio_lineage_scope: Lc4PublicationOutputAudioLineageScope;
  canonical_provider_exchange_count: 60;
  repair_provider_exchange_count: number;
  total_response_generation_count: number;
  canonical_exchange_replay_set_sha256: string;
  response_generation_replay_set_sha256: string;
  listener_authority_replay_set_sha256: string;
  listener_invocation_replay_set_sha256: string;
}>;

export type Lc4PublicationTransportReplay = Readonly<{
  schema_version: 2;
  run_sha256: string;
  provider_profile_manifest_sha256: string;
  audio_delivery_profile_sha256: string;
  listener_authority_trust_root_sha256: string;
  canonical_provider_exchange_count: 360;
  repair_provider_exchange_count: number;
  total_response_generation_count: number;
  episodes: readonly Lc4PublicationEpisodeTransportReplay[];
  replay_sha256: string;
}>;

type EpisodeReplayEntry = Readonly<{
  opportunity_id: string;
  opportunity_index: number;
  playback_kind: "canonical" | "repair";
  caller_pcm_sha256: string;
  provider_exchange_sha256: string;
  wire_observation_set_sha256: string;
  listener_evidence_sha256: string;
  output_capture_receipt_sha256: string;
  output_pcm_sha256: string;
  listener_authority_replay_sha256: string;
  listener_invocation_replay_sha256: string;
  decision_receipt_sha256: string;
  playback_receipt_sha256: string | null;
}>;

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function objectValue(value: JsonValue, label: string): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be one retained JSON object`);
  }
  return value as Record<string, JsonValue>;
}

function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function preflightAsrRunnerTrust(
  preflight: Lc4DevLivePreflightArtifact,
): BenchmarkKernelAttestationTrust {
  if (independentAsrContractSha256(preflight.asr_contract)
      !== preflight.asr_contract_sha256
    || preflight.authorization.body.asr_contract_sha256
      !== preflight.asr_contract_sha256
    || canonicalJson(preflight.authorization.body.asr_contract)
      !== canonicalJson(preflight.asr_contract)
    || canonicalJson(preflight.authorization.body.asr_runner_trust)
      !== canonicalJson(preflight.asr_runner_trust)) {
    throw new Error(
      "LC4 publication ASR contract or runner trust differs from signed preflight",
    );
  }
  const encoded = preflight.asr_runner_trust.public_key_spki_base64;
  const keyBytes = Buffer.from(encoded, "base64");
  if (keyBytes.byteLength === 0
    || keyBytes.toString("base64") !== encoded
    || sha256Hex(keyBytes)
      !== preflight.asr_runner_trust.public_key_fingerprint_sha256
    || preflight.asr_runner_trust.signature_algorithm !== "Ed25519") {
    throw new Error("LC4 publication ASR runner trust is not canonical Ed25519 SPKI");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: keyBytes,
      format: "der",
      type: "spki",
    });
  } catch {
    throw new Error("LC4 publication ASR runner public key is invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("LC4 publication ASR runner public key is not Ed25519");
  }
  return Object.freeze({
    keyId: preflight.asr_runner_trust.key_id,
    publicKeySha256:
      preflight.asr_runner_trust.public_key_fingerprint_sha256,
    publicKeyPem:
      publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
}

function expectedTransport(
  provider: Lc4PublicationEpisodeTransportReplay["provider"],
): Pick<
  Lc4PublicationEpisodeTransportReplay,
  "model" | "transport_purpose" | "transport_mode" | "transport_profile_sha256"
> {
  const profile = createLc4ProviderExecutionProfile(provider);
  return Object.freeze({
    model: profile.model,
    transport_purpose: provider === "xai"
      ? "finite_prerecorded_efficacy" as const
      : null,
    transport_mode: "manual_commit" as const,
    transport_profile_sha256:
      profile.transport_profile_sha256 ?? profile.provider_profile_sha256,
  });
}

function outputAudioLineageScope(
  provider: Lc4PublicationEpisodeTransportReplay["provider"],
): Lc4PublicationEpisodeTransportReplay["output_audio_lineage_scope"] {
  return provider === "gemini"
    ? "client_observed_interval_wire_projection_capture_cas_evaluator_exact_complete_frame_attribution_provider_response_id_unavailable"
    : "client_observed_identity_scoped_wire_pcm_capture_cas_evaluator_exact";
}

export function createLc4PublicationTransportReplay(
  input: Omit<Lc4PublicationTransportReplay, "schema_version" | "replay_sha256">,
): Lc4PublicationTransportReplay {
  const body = freeze({
    schema_version: 2 as const,
    ...input,
  });
  const replay = freeze({
    ...body,
    replay_sha256: sha256Hex(`${REPLAY_DOMAIN}${canonicalJson(body)}`),
  });
  assertLc4PublicationTransportReplay(replay);
  return replay;
}

export function assertLc4PublicationTransportReplay(
  value: Lc4PublicationTransportReplay,
): void {
  const { replay_sha256: claimed, ...body } = value;
  const expectedKeys = (["openai", "gemini", "xai"] as const)
    .flatMap((provider) => (["native", "hacc"] as const)
      .map((arm) => `${provider}:${arm}`))
    .sort();
  const actualKeys = value.episodes
    .map((episode) => `${episode.provider}:${episode.arm}`)
    .sort();
  if (value.schema_version !== 2
    || !HASH.test(claimed)
    || claimed !== sha256Hex(`${REPLAY_DOMAIN}${canonicalJson(body)}`)
    || !HASH.test(value.run_sha256)
    || !HASH.test(value.provider_profile_manifest_sha256)
    || !HASH.test(value.audio_delivery_profile_sha256)
    || !HASH.test(value.listener_authority_trust_root_sha256)
    || value.canonical_provider_exchange_count !== 360
    || !Number.isSafeInteger(value.repair_provider_exchange_count)
    || value.repair_provider_exchange_count < 0
    || value.total_response_generation_count
      !== value.canonical_provider_exchange_count
        + value.repair_provider_exchange_count
    || value.episodes.length !== 6
    || canonicalJson(actualKeys) !== canonicalJson(expectedKeys)
    || value.episodes.some((episode) => {
      const expected = expectedTransport(episode.provider);
      return episode.model !== expected.model
        || episode.transport_purpose !== expected.transport_purpose
        || episode.transport_mode !== expected.transport_mode
        || episode.transport_profile_sha256
          !== expected.transport_profile_sha256
        || episode.output_audio_lineage_scope
          !== outputAudioLineageScope(episode.provider)
        || episode.canonical_provider_exchange_count !== 60
        || !Number.isSafeInteger(episode.repair_provider_exchange_count)
        || episode.repair_provider_exchange_count < 0
        || episode.total_response_generation_count
          !== episode.canonical_provider_exchange_count
            + episode.repair_provider_exchange_count
        || !HASH.test(episode.canonical_exchange_replay_set_sha256)
        || !HASH.test(episode.response_generation_replay_set_sha256)
        || !HASH.test(episode.listener_authority_replay_set_sha256)
        || !HASH.test(episode.listener_invocation_replay_set_sha256);
    })) {
    throw new Error(
      "LC4 publication transport replay is incomplete, substituted, or self-hashed from an alternate profile",
    );
  }
}

function referenceForCanonicalExchange(input: Readonly<{
  event: Lc4DevLiveRunArtifact["ledger"][number];
  evidenceSha256: string;
}>): Lc4DevReplayArtifactReference {
  const matches = input.event.evidence_references.filter((reference) =>
    reference.kind === "provider_exchange"
    && reference.evidence_sha256 === input.evidenceSha256);
  if (matches.length !== 1) {
    throw new Error(
      "LC4 publication transport replay cannot resolve exactly one canonical provider exchange",
    );
  }
  return matches[0]!;
}

function referenceForCanonicalListener(input: Readonly<{
  event: Lc4DevLiveRunArtifact["ledger"][number];
  evidenceSha256: string;
}>): Lc4DevReplayArtifactReference {
  const matches = input.event.evidence_references.filter((reference) =>
    reference.kind === "listener_evidence"
    && reference.evidence_sha256 === input.evidenceSha256);
  if (matches.length !== 1) {
    throw new Error(
      "LC4 publication transport replay cannot resolve exactly one canonical listener evidence artifact",
    );
  }
  return matches[0]!;
}

async function replayEpisode(input: Readonly<{
  episode: Lc4DevLiveEpisodePlan;
  prepare: Lc4DevLivePrepareArtifact;
  preflight: Lc4DevLivePreflightArtifact;
  run: Lc4DevLiveRunArtifact;
  evidence: ReturnType<typeof createLc4DevReplayEvidenceStore>;
  cas: Lc4ImmutableCas;
  expected_authority_trust_root_sha256: string;
  asr_runner_trust: BenchmarkKernelAttestationTrust;
}>): Promise<Lc4PublicationEpisodeTransportReplay> {
  const corpus = createLc4PublicDevelopmentCorpus();
  const opportunityById = new Map(corpus.opportunities.map((opportunity) => [
    opportunity.id,
    opportunity,
  ]));
  const bindingById = new Map(input.prepare.audio_bindings
    .filter((binding) => binding.provider === input.episode.provider)
    .map((binding) => [binding.opportunity_id, binding]));
  const events = input.run.ledger.filter((event) =>
    event.episode_id === input.episode.episode_id
    && event.event_type === "opportunity_completed");
  if (events.length !== 60) {
    throw new Error(
      `LC4 publication ${input.episode.episode_id} transport replay requires 60 completed canonical exchanges`,
    );
  }
  const profile = createLc4ProviderExecutionProfile(input.episode.provider);
  const expected = expectedTransport(input.episode.provider);
  const entries: EpisodeReplayEntry[] = [];
  for (const event of events) {
    if (event.opportunity_id === null) {
      throw new Error("LC4 publication transport replay found an anonymous completed opportunity");
    }
    const opportunity = opportunityById.get(event.opportunity_id);
    const binding = bindingById.get(event.opportunity_id);
    if (!opportunity || !binding) {
      throw new Error(
        "LC4 publication transport replay differs from the frozen opportunity/audio registry",
      );
    }
    const payload = objectValue(
      await input.evidence.resolveJson(event.payload_evidence),
      "LC4 publication opportunity-completed payload",
    );
    const decisionReceiptSha256 = String(
      payload.decision_receipt_sha256,
    );
    requireHash(
      decisionReceiptSha256,
      "LC4 publication repair decision receipt",
    );
    const providerExchangeSha256 =
      String(payload.canonical_provider_exchange_sha256);
    requireHash(
      providerExchangeSha256,
      "LC4 publication canonical provider exchange",
    );
    const reference = referenceForCanonicalExchange({
      event,
      evidenceSha256: providerExchangeSha256,
    });
    const projection = await input.evidence.resolveJson(reference);
    const exchange = objectValue(
      projection,
      "LC4 publication provider exchange replay",
    );
    const outputCapture = objectValue(
      exchange.output_capture,
      "LC4 publication provider output capture",
    );
    const outputPcmSha256 = String(outputCapture.generated_pcm_sha256);
    requireHash(outputPcmSha256, "LC4 publication output PCM");
    const callerPcm = await input.cas.get(binding.pcm_sha256);
    const listenerPcm = await input.cas.get(outputPcmSha256);
    const listenerEvidenceSha256 =
      String(payload.canonical_listener_evidence_sha256);
    requireHash(
      listenerEvidenceSha256,
      "LC4 publication canonical listener evidence",
    );
    const listenerReference = referenceForCanonicalListener({
      event,
      evidenceSha256: listenerEvidenceSha256,
    });
    const listenerProjection =
      await input.evidence.resolveJson(listenerReference);
    const providerReplay = assertLc4ProviderExchangeReplayProjection(projection, {
      run_id: input.episode.episode_id,
      opportunity_id: opportunity.id,
      segment_ordinal: Math.ceil(opportunity.index / 20) as 1 | 2 | 3,
      playback_kind: "canonical",
      caller_pcm_sha256: binding.pcm_sha256,
      caller_pcm_byte_length: binding.pcm_byte_length,
      response_control_kind: input.episode.arm === "hacc"
        ? "hacc_response_plan"
        : "native_context",
      provider_profile: profile,
      input_audio_delivery_profile_sha256:
        input.prepare.audio_delivery_profile_sha256,
      caller_pcm: callerPcm,
      listener_consumed_pcm: listenerPcm,
      listener_evidence_projection: listenerProjection,
      listener_evidence_reference: listenerReference,
      listener_manifest_sha256:
        input.preflight.listener_evidence_manifest_sha256,
      evaluator_build_sha256:
        input.preflight.asr_evaluator_build_sha256,
    });
    const listener = objectValue(
      listenerProjection,
      "LC4 publication retained listener evidence",
    );
    const evaluation = objectValue(
      listener.evaluation as JsonValue,
      "LC4 publication retained listener evaluation",
    );
    const listenerAuthorityReplay =
      await replayLc4DevelopmentListenerAuthority({
        cas: input.cas,
        preflight: input.preflight,
        expected_authority_trust_root_sha256:
          input.expected_authority_trust_root_sha256,
        listener_evidence: listenerProjection,
        listener_evidence_sha256: listenerEvidenceSha256,
        capture: providerReplay.output_capture,
        pcm: listenerPcm,
      });
    const invocationArtifactCasSha256 = String(
      listener.signed_invocation_artifact_cas_sha256,
    );
    const invocationArtifactByteLength = Number(
      listener.signed_invocation_artifact_byte_length,
    );
    const invocationReceiptSha256 = String(
      evaluation.signed_invocation_receipt_sha256,
    );
    const transcriptSha256 = String(evaluation.transcript_sha256);
    requireHash(
      invocationArtifactCasSha256,
      "LC4 publication signed invocation artifact CAS address",
    );
    requireHash(
      invocationReceiptSha256,
      "LC4 publication signed invocation receipt",
    );
    requireHash(
      transcriptSha256,
      "LC4 publication listener transcript",
    );
    if (!Number.isSafeInteger(invocationArtifactByteLength)
      || invocationArtifactByteLength < 1) {
      throw new Error(
        "LC4 publication signed invocation artifact byte length is invalid",
      );
    }
    const invocationArtifactBytes = await input.cas.get(
      invocationArtifactCasSha256,
    );
    const listenerInvocationReplay = replayLc4ListenerInvocation({
      artifact_bytes: invocationArtifactBytes,
      signed_invocation_artifact_cas_sha256:
        invocationArtifactCasSha256,
      signed_invocation_artifact_byte_length:
        invocationArtifactByteLength,
      signed_invocation_receipt_sha256: invocationReceiptSha256,
      run_id: input.episode.episode_id,
      opportunity_id: opportunity.id,
      criterion_plan_sha256: String(listener.criterion_plan_sha256),
      source_pcm: listenerPcm,
      source_sample_rate_hz:
        providerReplay.output_capture.format.sample_rate_hz,
      expected_transcript_sha256: transcriptSha256,
      asr_contract: input.preflight.asr_contract,
      runner_trust: input.asr_runner_trust,
      expected_runner_key_id:
        input.preflight.asr_runner_trust.key_id,
      expected_runner_public_key_sha256:
        input.preflight.asr_runner_trust
          .public_key_fingerprint_sha256,
    });
    if (exchange.transport_purpose !== expected.transport_purpose
      || exchange.transport_mode !== expected.transport_mode
      || exchange.transport_profile_sha256
        !== expected.transport_profile_sha256) {
      throw new Error(
        "LC4 publication provider exchange transport differs from its replayed execution profile",
      );
    }
    const wireObservationSetSha256 =
      String(exchange.wire_observation_set_sha256);
    requireHash(
      wireObservationSetSha256,
      "LC4 publication wire observation set",
    );
    entries.push(Object.freeze({
      opportunity_id: opportunity.id,
      opportunity_index: opportunity.index,
      playback_kind: "canonical" as const,
      caller_pcm_sha256: binding.pcm_sha256,
      provider_exchange_sha256: providerExchangeSha256,
      wire_observation_set_sha256: wireObservationSetSha256,
      listener_evidence_sha256: listenerEvidenceSha256,
      output_capture_receipt_sha256:
        String(outputCapture.capture_receipt_sha256),
      output_pcm_sha256: outputPcmSha256,
      listener_authority_replay_sha256:
        listenerAuthorityReplay.replay_sha256,
      listener_invocation_replay_sha256:
        listenerInvocationReplay.replay_sha256,
      decision_receipt_sha256: decisionReceiptSha256,
      playback_receipt_sha256: null,
    }));

    const canonicalAssistantPcmSha256 = String(
      payload.canonical_assistant_pcm_sha256,
    );
    const effectiveProviderExchangeSha256 = String(
      payload.effective_provider_exchange_sha256,
    );
    const effectiveListenerEvidenceSha256 = String(
      payload.effective_listener_evidence_sha256,
    );
    const effectiveAssistantPcmSha256 = String(
      payload.effective_assistant_pcm_sha256,
    );
    for (const [digest, label] of [
      [canonicalAssistantPcmSha256, "canonical assistant PCM"],
      [effectiveProviderExchangeSha256, "effective provider exchange"],
      [effectiveListenerEvidenceSha256, "effective listener evidence"],
      [effectiveAssistantPcmSha256, "effective assistant PCM"],
    ] as const) requireHash(digest, `LC4 publication ${label}`);
    if (canonicalAssistantPcmSha256 !== outputPcmSha256) {
      throw new Error(
        "LC4 publication canonical output capture differs from the completed-event assistant PCM",
      );
    }

    if (effectiveProviderExchangeSha256 === providerExchangeSha256) {
      if (effectiveListenerEvidenceSha256 !== listenerEvidenceSha256
        || effectiveAssistantPcmSha256 !== outputPcmSha256) {
        throw new Error(
          "LC4 publication unrepaired effective response differs from its canonical lineage",
        );
      }
    } else {
      const repairEvents = input.run.ledger.filter((candidate) =>
        candidate.episode_id === input.episode.episode_id
        && candidate.opportunity_id === opportunity.id
        && candidate.event_type === "repair_completed");
      const repairAudioEvents = input.run.ledger.filter((candidate) =>
        candidate.episode_id === input.episode.episode_id
        && candidate.opportunity_id === opportunity.id
        && candidate.event_type === "repair_audio_submitted");
      if (repairEvents.length !== 1 || repairAudioEvents.length !== 1) {
        throw new Error(
          "LC4 publication repaired response lacks one exact repair lifecycle",
        );
      }
      const repairEvent = repairEvents[0]!;
      const repairAudioEvent = repairAudioEvents[0]!;
      const repairPayload = objectValue(
        await input.evidence.resolveJson(repairEvent.payload_evidence),
        "LC4 publication repair-completed payload",
      );
      const repairAudioPayload = objectValue(
        await input.evidence.resolveJson(repairAudioEvent.payload_evidence),
        "LC4 publication repair-audio-submitted payload",
      );
      const playbackReceiptSha256 = String(
        repairPayload.playback_receipt_sha256,
      );
      const repairCallerPcmSha256 = String(
        repairAudioPayload.repair_pcm_sha256,
      );
      requireHash(
        playbackReceiptSha256,
        "LC4 publication repair playback receipt",
      );
      requireHash(
        repairCallerPcmSha256,
        "LC4 publication repair caller PCM",
      );
      if (repairPayload.decision_receipt_sha256
          !== decisionReceiptSha256
        || repairAudioPayload.decision_receipt_sha256
          !== decisionReceiptSha256
        || repairPayload.repair_exchange_sha256
          !== effectiveProviderExchangeSha256
        || repairPayload.repair_listener_evidence_sha256
          !== effectiveListenerEvidenceSha256
        || repairPayload.repair_assistant_pcm_sha256
          !== effectiveAssistantPcmSha256
        || repairPayload.canonical_provider_exchange_sha256
          !== providerExchangeSha256
        || repairPayload.canonical_listener_evidence_sha256
          !== listenerEvidenceSha256
        || repairPayload.canonical_assistant_pcm_sha256
          !== canonicalAssistantPcmSha256
        || repairPayload.effective_provider_exchange_sha256
          !== effectiveProviderExchangeSha256
        || repairPayload.effective_listener_evidence_sha256
          !== effectiveListenerEvidenceSha256
        || repairPayload.effective_assistant_pcm_sha256
          !== effectiveAssistantPcmSha256
        || repairPayload.advances_canonical_horizon !== false
        || repairAudioPayload.advances_canonical_horizon !== false) {
        throw new Error(
          "LC4 publication repair lifecycle differs from canonical/effective lineage",
        );
      }
      const exactReference = (
        eventInput: Lc4DevLiveRunArtifact["ledger"][number],
        kind: Lc4DevReplayArtifactReference["kind"],
        evidenceSha256: string,
        label: string,
      ): Lc4DevReplayArtifactReference => {
        const matches = eventInput.evidence_references.filter((candidate) =>
          candidate.kind === kind
          && candidate.evidence_sha256 === evidenceSha256);
        if (matches.length !== 1) {
          throw new Error(
            `LC4 publication repair lacks one exact ${label} ledger edge`,
          );
        }
        return matches[0]!;
      };
      const repairExchangeReference = exactReference(
        repairEvent,
        "provider_exchange",
        effectiveProviderExchangeSha256,
        "provider exchange",
      );
      const repairListenerReference = exactReference(
        repairEvent,
        "listener_evidence",
        effectiveListenerEvidenceSha256,
        "listener evidence",
      );
      const repairCallerReference = exactReference(
        repairAudioEvent,
        "caller_pcm",
        repairCallerPcmSha256,
        "caller PCM",
      );
      const repairDecisionReference = exactReference(
        repairEvent,
        "repair_decision",
        decisionReceiptSha256,
        "decision receipt",
      );
      const repairPlaybackReference = exactReference(
        repairEvent,
        "repair_playback",
        playbackReceiptSha256,
        "playback receipt",
      );
      exactReference(
        repairAudioEvent,
        "repair_decision",
        decisionReceiptSha256,
        "submitted-audio decision receipt",
      );
      const [
        repairProjection,
        repairListenerProjection,
        repairDecisionProjection,
        repairPlaybackProjection,
        repairCallerPcm,
      ] = await Promise.all([
        input.evidence.resolveJson(repairExchangeReference),
        input.evidence.resolveJson(repairListenerReference),
        input.evidence.resolveJson(repairDecisionReference),
        input.evidence.resolveJson(repairPlaybackReference),
        input.cas.get(repairCallerPcmSha256),
      ]);
      const repairDecision = objectValue(
        repairDecisionProjection,
        "LC4 publication repair decision",
      );
      const repairPlayback = objectValue(
        repairPlaybackProjection,
        "LC4 publication repair playback",
      );
      if (repairDecision.episode_id !== input.episode.episode_id
        || repairDecision.canonical_opportunity_id !== opportunity.id
        || repairDecision.canonical_ordinal !== opportunity.index
        || repairDecision.canonical_exchange_sha256
          !== providerExchangeSha256
        || repairDecision.canonical_listener_evidence_sha256
          !== listenerEvidenceSha256
        || repairPlayback.episode_id !== input.episode.episode_id
        || repairPlayback.canonical_opportunity_id !== opportunity.id
        || repairPlayback.canonical_ordinal !== opportunity.index
        || repairPlayback.decision_receipt_sha256
          !== decisionReceiptSha256
        || repairPlayback.submitted_pcm_sha256
          !== repairCallerPcmSha256
        || repairPlayback.submitted_pcm_byte_length
          !== repairCallerPcm.byteLength
        || repairPlayback.provider_exchange_sha256
          !== effectiveProviderExchangeSha256
        || repairPlayback.listener_evidence_sha256
          !== effectiveListenerEvidenceSha256
        || repairPlayback.advances_canonical_horizon !== false
        || repairPlayback.recursive_repair_observation !== null
        || repairCallerReference.byte_length
          !== repairCallerPcm.byteLength) {
        throw new Error(
          "LC4 publication repair decision/playback receipt is not bound to its exact caller and response",
        );
      }
      const repairExchange = objectValue(
        repairProjection,
        "LC4 publication repair provider exchange",
      );
      const repairOutputCapture = objectValue(
        repairExchange.output_capture,
        "LC4 publication repair output capture",
      );
      const repairOutputPcmSha256 = String(
        repairOutputCapture.generated_pcm_sha256,
      );
      requireHash(
        repairOutputPcmSha256,
        "LC4 publication repair output PCM",
      );
      if (repairOutputPcmSha256 !== effectiveAssistantPcmSha256) {
        throw new Error(
          "LC4 publication repair output capture differs from effective assistant PCM",
        );
      }
      const repairListenerPcm = await input.cas.get(
        repairOutputPcmSha256,
      );
      const repairProviderReplay =
        assertLc4ProviderExchangeReplayProjection(repairProjection, {
          run_id: input.episode.episode_id,
          opportunity_id: opportunity.id,
          segment_ordinal: Math.ceil(opportunity.index / 20) as 1 | 2 | 3,
          playback_kind: "repair",
          caller_pcm_sha256: repairCallerPcmSha256,
          caller_pcm_byte_length: repairCallerPcm.byteLength,
          response_control_kind: input.episode.arm === "hacc"
            ? "hacc_response_plan"
            : "native_context",
          provider_profile: profile,
          input_audio_delivery_profile_sha256:
            input.prepare.audio_delivery_profile_sha256,
          caller_pcm: repairCallerPcm,
          listener_consumed_pcm: repairListenerPcm,
          listener_evidence_projection: repairListenerProjection,
          listener_evidence_reference: repairListenerReference,
          listener_manifest_sha256:
            input.preflight.listener_evidence_manifest_sha256,
          evaluator_build_sha256:
            input.preflight.asr_evaluator_build_sha256,
        });
      const repairListener = objectValue(
        repairListenerProjection,
        "LC4 publication retained repair listener evidence",
      );
      const repairEvaluation = objectValue(
        repairListener.evaluation as JsonValue,
        "LC4 publication retained repair listener evaluation",
      );
      const repairAuthorityReplay =
        await replayLc4DevelopmentListenerAuthority({
          cas: input.cas,
          preflight: input.preflight,
          expected_authority_trust_root_sha256:
            input.expected_authority_trust_root_sha256,
          listener_evidence: repairListenerProjection,
          listener_evidence_sha256: effectiveListenerEvidenceSha256,
          capture: repairProviderReplay.output_capture,
          pcm: repairListenerPcm,
        });
      const repairInvocationCasSha256 = String(
        repairListener.signed_invocation_artifact_cas_sha256,
      );
      const repairInvocationByteLength = Number(
        repairListener.signed_invocation_artifact_byte_length,
      );
      const repairInvocationReceiptSha256 = String(
        repairEvaluation.signed_invocation_receipt_sha256,
      );
      const repairTranscriptSha256 = String(
        repairEvaluation.transcript_sha256,
      );
      requireHash(
        repairInvocationCasSha256,
        "LC4 publication repair signed invocation artifact",
      );
      requireHash(
        repairInvocationReceiptSha256,
        "LC4 publication repair signed invocation receipt",
      );
      requireHash(
        repairTranscriptSha256,
        "LC4 publication repair listener transcript",
      );
      if (!Number.isSafeInteger(repairInvocationByteLength)
        || repairInvocationByteLength < 1) {
        throw new Error(
          "LC4 publication repair signed invocation artifact byte length is invalid",
        );
      }
      const repairInvocationBytes = await input.cas.get(
        repairInvocationCasSha256,
      );
      const repairInvocationReplay = replayLc4ListenerInvocation({
        artifact_bytes: repairInvocationBytes,
        signed_invocation_artifact_cas_sha256:
          repairInvocationCasSha256,
        signed_invocation_artifact_byte_length:
          repairInvocationByteLength,
        signed_invocation_receipt_sha256:
          repairInvocationReceiptSha256,
        run_id: input.episode.episode_id,
        opportunity_id: opportunity.id,
        criterion_plan_sha256: String(
          repairListener.criterion_plan_sha256,
        ),
        source_pcm: repairListenerPcm,
        source_sample_rate_hz:
          repairProviderReplay.output_capture.format.sample_rate_hz,
        expected_transcript_sha256: repairTranscriptSha256,
        asr_contract: input.preflight.asr_contract,
        runner_trust: input.asr_runner_trust,
        expected_runner_key_id:
          input.preflight.asr_runner_trust.key_id,
        expected_runner_public_key_sha256:
          input.preflight.asr_runner_trust
            .public_key_fingerprint_sha256,
      });
      const repairWireObservationSetSha256 = String(
        repairExchange.wire_observation_set_sha256,
      );
      requireHash(
        repairWireObservationSetSha256,
        "LC4 publication repair wire observation set",
      );
      entries.push(Object.freeze({
        opportunity_id: opportunity.id,
        opportunity_index: opportunity.index,
        playback_kind: "repair" as const,
        caller_pcm_sha256: repairCallerPcmSha256,
        provider_exchange_sha256: effectiveProviderExchangeSha256,
        wire_observation_set_sha256:
          repairWireObservationSetSha256,
        listener_evidence_sha256:
          effectiveListenerEvidenceSha256,
        output_capture_receipt_sha256:
          String(repairOutputCapture.capture_receipt_sha256),
        output_pcm_sha256: repairOutputPcmSha256,
        listener_authority_replay_sha256:
          repairAuthorityReplay.replay_sha256,
        listener_invocation_replay_sha256:
          repairInvocationReplay.replay_sha256,
        decision_receipt_sha256: decisionReceiptSha256,
        playback_receipt_sha256: playbackReceiptSha256,
      }));
    }
  }
  entries.sort((left, right) =>
    left.opportunity_index - right.opportunity_index
      || (left.playback_kind === right.playback_kind
        ? 0
        : left.playback_kind === "canonical" ? -1 : 1));
  const canonicalEntries = entries.filter((entry) =>
    entry.playback_kind === "canonical");
  const repairEntries = entries.filter((entry) =>
    entry.playback_kind === "repair");
  if (canonicalEntries.some((entry, index) =>
    entry.opportunity_index !== index + 1)
    || canonicalEntries.length !== 60
    || new Set(entries.map((entry) =>
      entry.provider_exchange_sha256)).size !== entries.length
    || new Set(repairEntries.map((entry) =>
      entry.opportunity_id)).size !== repairEntries.length) {
    throw new Error(
      "LC4 publication transport replay has duplicate, missing, or reordered response generations",
    );
  }
  return freeze({
    episode_id: input.episode.episode_id,
    provider: input.episode.provider,
    arm: input.episode.arm,
    model: expected.model,
    transport_purpose: expected.transport_purpose,
    transport_mode: expected.transport_mode,
    transport_profile_sha256: expected.transport_profile_sha256,
    output_audio_lineage_scope:
      outputAudioLineageScope(input.episode.provider),
    canonical_provider_exchange_count: 60 as const,
    repair_provider_exchange_count: repairEntries.length,
    total_response_generation_count: entries.length,
    canonical_exchange_replay_set_sha256: sha256Hex(
      `${EPISODE_SET_DOMAIN}${canonicalJson({
        episode_id: input.episode.episode_id,
        provider: input.episode.provider,
        arm: input.episode.arm,
        entries: canonicalEntries,
      })}`,
    ),
    response_generation_replay_set_sha256: sha256Hex(
      `${RESPONSE_GENERATION_SET_DOMAIN}${canonicalJson({
        episode_id: input.episode.episode_id,
        provider: input.episode.provider,
        arm: input.episode.arm,
        entries,
      })}`,
    ),
    listener_authority_replay_set_sha256: sha256Hex(
      `${LISTENER_AUTHORITY_REPLAY_SET_DOMAIN}${canonicalJson(
        entries.map((entry) => ({
          opportunity_id: entry.opportunity_id,
          listener_authority_replay_sha256:
            entry.listener_authority_replay_sha256,
        })),
      )}`,
    ),
    listener_invocation_replay_set_sha256: sha256Hex(
      `${LISTENER_INVOCATION_REPLAY_SET_DOMAIN}${canonicalJson(
        entries.map((entry) => ({
          opportunity_id: entry.opportunity_id,
          listener_invocation_replay_sha256:
            entry.listener_invocation_replay_sha256,
        })),
      )}`,
    ),
  });
}

/**
 * Replays the same retained provider-exchange projections and frozen execution
 * profiles used by the live runner. Publication never invents a second
 * "transport profile" commitment from descriptive fields.
 */
export async function replayLc4PublicationTransportEvidence(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  preflight: Lc4DevLivePreflightArtifact;
  run: Lc4DevLiveRunArtifact;
  cas_root_dir: string;
  expected_authority_trust_root_sha256: string;
}>): Promise<Lc4PublicationTransportReplay> {
  requireHash(
    input.expected_authority_trust_root_sha256,
    "LC4 publication expected listener authority trust root",
  );
  if (input.preflight.authority_trust_root_sha256
      !== input.expected_authority_trust_root_sha256) {
    throw new Error(
      "LC4 publication listener authority differs from the external trust root",
    );
  }
  assertLc4DevLivePrepareArtifact(input.prepare);
  assertLc4DevLivePreflightArtifact(
    input.preflight,
    input.prepare,
    new Date(input.preflight.checked_at),
  );
  assertLc4DevOperatorAuthorizationDag({
    preflight: input.preflight,
    expected_authority_public_key_fingerprint_sha256:
      input.expected_authority_trust_root_sha256,
  });
  if (input.run.execution_id !== input.prepare.execution_id
    || input.run.prepare_sha256 !== input.prepare.prepare_sha256
    || input.run.preflight_sha256 !== input.preflight.preflight_sha256) {
    throw new Error(
      "LC4 publication transport run differs from its signed prepare/preflight chain",
    );
  }
  const cas = await createLc4ImmutableCas(input.cas_root_dir);
  const evidence = createLc4DevReplayEvidenceStore(cas);
  const asrRunnerTrust = preflightAsrRunnerTrust(input.preflight);
  const episodes = await Promise.all(input.prepare.episodes.map((episode) =>
    replayEpisode({
      episode,
      prepare: input.prepare,
      preflight: input.preflight,
      run: input.run,
      evidence,
      cas,
      expected_authority_trust_root_sha256:
        input.expected_authority_trust_root_sha256,
      asr_runner_trust: asrRunnerTrust,
    })));
  const repairProviderExchangeCount = episodes.reduce(
    (total, episode) =>
      total + episode.repair_provider_exchange_count,
    0,
  );
  return createLc4PublicationTransportReplay({
    run_sha256: input.run.run_sha256,
    provider_profile_manifest_sha256:
      input.prepare.provider_profile_manifest_sha256,
    audio_delivery_profile_sha256:
      input.prepare.audio_delivery_profile_sha256,
    listener_authority_trust_root_sha256:
      input.expected_authority_trust_root_sha256,
    canonical_provider_exchange_count: 360,
    repair_provider_exchange_count: repairProviderExchangeCount,
    total_response_generation_count:
      360 + repairProviderExchangeCount,
    episodes,
  });
}

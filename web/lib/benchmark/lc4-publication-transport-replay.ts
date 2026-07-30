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
  LC4_DEV_OPPORTUNITIES_PER_PROVIDER_SEGMENT,
  LC4_DEV_PROVIDER_SESSION_SCHEDULE,
  LC4_DEV_PROVIDER_SESSION_SCHEDULE_SHA256,
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
  projectLc4RotationPacketForReplay,
  validateConversationHistoryHydrationAcknowledgement,
  type Lc4HaccRotationStatePacket,
  type Lc4NativeConversationReplayPacket,
  type Lc4RotationConversationTurn,
  type Lc4SanitizedWireObservation,
} from "./lc4-production-provider-adapter";
import {
  LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION,
} from "./lc4-production-provider-contract";
import {
  LC4_DEV_CALLER_BRANCH_SOURCES,
} from "./lc4-development-caller-branch";
import type {
  RealtimeConversationHistoryHydrationAcknowledgement,
} from "../realtime/client/types";
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
  "harshas-amazing-call-center/lc4-publication-transport-replay/v3\n";
const EPISODE_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-transport-episode-set/v2\n";
const PROVIDER_SESSION_REPLAY_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-provider-session-replay-set/v1\n";
const PROVIDER_SESSION_REPLAY_AGGREGATE_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-provider-session-replay-aggregate/v1\n";
const RESPONSE_GENERATION_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-response-generation-set/v1\n";
const LISTENER_AUTHORITY_REPLAY_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-listener-authority-replay-set/v1\n";
const LISTENER_INVOCATION_REPLAY_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-listener-invocation-replay-set/v1\n";
const PROVIDER_HISTORY_ACKNOWLEDGEMENT_DOMAIN =
  "harshas-amazing-call-center/lc4-provider-history-hydration-acknowledgement/v1\n";
const ROTATION_TOOL_BATCH_DOMAIN =
  "harshas-amazing-call-center/lc4-rotation-tool-batch/v1\n";

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
  provider_session_count: 6;
  provider_session_replay_set_sha256: string;
  repair_provider_exchange_count: number;
  total_response_generation_count: number;
  canonical_exchange_replay_set_sha256: string;
  response_generation_replay_set_sha256: string;
  listener_authority_replay_set_sha256: string;
  listener_invocation_replay_set_sha256: string;
}>;

export type Lc4PublicationTransportReplay = Readonly<{
  schema_version: 3;
  run_sha256: string;
  provider_profile_manifest_sha256: string;
  audio_delivery_profile_sha256: string;
  listener_authority_trust_root_sha256: string;
  canonical_provider_exchange_count: 360;
  provider_session_count: 36;
  provider_session_replay_set_sha256: string;
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

type ProviderSessionReplayEntry = Readonly<{
  segment_ordinal: number;
  opportunity_start: number;
  opportunity_end: number;
  opportunity_count: number;
  intent_sequence: number;
  intent_payload_sha256: string;
  opened_sequence: number;
  opened_payload_sha256: string;
  closed_before_sequence: number;
  session_ordinal: number;
  rotation_receipt_sha256: string;
  previous_rotation_receipt_sha256: string | null;
  rotation_context_kind:
    | "none"
    | "native_conversation_replay"
    | "hacc_structured_state";
  rotation_context_sha256: string | null;
  rotation_conversation_replay_sha256: string | null;
  history_hydration_status: string | null;
  history_hydration_acknowledgement_sha256: string | null;
  history_provider_visible_sha256: string | null;
  history_source_binding_sha256: string | null;
  history_hydration_turn_count: number;
  history_hydration_provider_item_count: number;
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

function exactKeys(
  value: object,
  expected: readonly string[],
): boolean {
  return canonicalJson(Object.keys(value).sort())
    === canonicalJson([...expected].sort());
}

function providerSessionReplayAggregateSha256(
  episodes: readonly Lc4PublicationEpisodeTransportReplay[],
): string {
  return sha256Hex(
    `${PROVIDER_SESSION_REPLAY_AGGREGATE_DOMAIN}${canonicalJson(
      episodes.map((episode) => ({
        episode_id: episode.episode_id,
        provider: episode.provider,
        arm: episode.arm,
        provider_session_count: episode.provider_session_count,
        provider_session_replay_set_sha256:
          episode.provider_session_replay_set_sha256,
      })),
    )}`,
  );
}

function assertHydrationItemsMatchProviderHistory(input: Readonly<{
  provider: Lc4PublicationEpisodeTransportReplay["provider"];
  items: readonly JsonValue[];
  provider_history: ReturnType<
    typeof projectLc4RotationPacketForReplay
  >["provider_history"];
}>): void {
  type ExpectedHydrationItem = Readonly<{
    history_turn_ordinal: number;
    kind:
      | "user_message"
      | "assistant_message"
      | "synthetic_tool_call"
      | "synthetic_tool_output";
    source_sha256: string;
    pair_ordinal: number | null;
  }>;
  const expected: ExpectedHydrationItem[] = [];
  input.provider_history.forEach((turn, turnIndex) => {
    if ("text" in turn) {
      expected.push({
        history_turn_ordinal: turnIndex + 1,
        kind: turn.role === "user"
          ? "user_message"
          : "assistant_message",
        source_sha256: turn.sourceSha256,
        pair_ordinal: null,
      });
      return;
    }
    const calls = turn.role === "tool" ? [turn] : turn.calls;
    expected.push(
      ...calls.map((call, callIndex): ExpectedHydrationItem => ({
        history_turn_ordinal: turnIndex + 1,
        kind: "synthetic_tool_call",
        source_sha256: call.sourceSha256,
        pair_ordinal: callIndex + 1,
      })),
      ...calls.map((call, callIndex): ExpectedHydrationItem => ({
        history_turn_ordinal: turnIndex + 1,
        kind: "synthetic_tool_output",
        source_sha256: call.sourceSha256,
        pair_ordinal: callIndex + 1,
      })),
    );
  });
  if (input.items.length !== expected.length) {
    throw new Error(
      "LC4 publication provider-session hydration item count differs from retained provider history",
    );
  }
  const syntheticPairIds = new Map<string, string>();
  let previousOutboundSequence = 0;
  let previousInboundSequence = 0;
  let geminiOutboundObservationSha256: string | null = null;
  for (const [index, expectedItem] of expected.entries()) {
    const item = objectValue(
      input.items[index]!,
      "LC4 publication provider-session hydration item",
    );
    const outbound = objectValue(
      item.outboundObservation as JsonValue,
      "LC4 publication provider-session outbound hydration attribution",
    );
    const inbound = item.inboundObservation === undefined
      ? null
      : objectValue(
          item.inboundObservation as JsonValue,
          "LC4 publication provider-session inbound hydration attribution",
        );
    const syntheticCallId = item.syntheticCallIdSha256;
    if (item.historyTurnOrdinal !== expectedItem.history_turn_ordinal
      || item.providerItemOrdinal !== index + 1
      || item.kind !== expectedItem.kind
      || item.sourceSha256 !== expectedItem.source_sha256
      || outbound.availability !== "observed"
      || outbound.connectionEpoch !== 1
      || !Number.isSafeInteger(outbound.sequence)
      || Number(outbound.sequence) < 1
      || typeof outbound.observationSha256 !== "string"
      || !HASH.test(outbound.observationSha256)) {
      throw new Error(
        "LC4 publication provider-session hydration item differs from exact retained provider history order or source",
      );
    }
    if (expectedItem.pair_ordinal === null) {
      if (syntheticCallId !== undefined
        || item.providerContentOmission !== undefined) {
        throw new Error(
          "LC4 publication provider-session message hydration fabricates tool identity or omission",
        );
      }
    } else {
      if (typeof syntheticCallId !== "string"
        || !HASH.test(syntheticCallId)) {
        throw new Error(
          "LC4 publication provider-session tool hydration lacks a synthetic call binding",
        );
      }
      const pairKey =
        `${expectedItem.history_turn_ordinal}:${expectedItem.pair_ordinal}`;
      const prior = syntheticPairIds.get(pairKey);
      if (prior !== undefined && prior !== syntheticCallId) {
        throw new Error(
          "LC4 publication provider-session tool call/output hydration pair differs",
        );
      }
      syntheticPairIds.set(pairKey, syntheticCallId);
      if (item.providerContentOmission !== undefined) {
        const omission = objectValue(
          item.providerContentOmission as JsonValue,
          "LC4 publication provider-session hydration omission",
        );
        if (input.provider !== "xai"
          || expectedItem.kind !== "synthetic_tool_call"
          || !exactKeys(omission, ["field", "observedShape"])
          || omission.field !== "arguments"
          || omission.observedShape !== "empty_string") {
          throw new Error(
            "LC4 publication provider-session hydration content omission is not the exact admitted xAI exception",
          );
        }
      }
    }
    if (input.provider === "gemini") {
      if (inbound !== null
        || (geminiOutboundObservationSha256 !== null
          && outbound.observationSha256
            !== geminiOutboundObservationSha256)) {
        throw new Error(
          "LC4 publication Gemini hydration invents item acknowledgement or more than one outbound history frame",
        );
      }
      geminiOutboundObservationSha256 =
        String(outbound.observationSha256);
    } else {
      if (inbound === null
        || inbound.availability !== "observed"
        || inbound.connectionEpoch !== 1
        || !Number.isSafeInteger(inbound.sequence)
        || Number(inbound.sequence) <= Number(outbound.sequence)
        || typeof inbound.observationSha256 !== "string"
        || !HASH.test(inbound.observationSha256)
        || Number(outbound.sequence) <= previousOutboundSequence
        || Number(inbound.sequence) <= previousInboundSequence) {
        throw new Error(
          "LC4 publication provider-session hydration acknowledgement lineage is incomplete or out of order",
        );
      }
      previousOutboundSequence = Number(outbound.sequence);
      previousInboundSequence = Number(inbound.sequence);
    }
  }
}

function appendReconstructedConversationExchange(input: Readonly<{
  turns: Lc4RotationConversationTurn[];
  opportunity_index: number;
  caller_text: string;
  caller_pcm_sha256: string;
  exchange: Record<string, JsonValue>;
  listener: Record<string, JsonValue>;
  assistant_pcm_sha256: string;
}>): void {
  type ReconstructedTurnInput =
    | Readonly<{
        speaker: "caller";
        source: "caller_tts_source_bound_to_pcm";
        text: string;
        provenance_receipt_sha256: string;
      }>
    | Readonly<{
        speaker: "assistant";
        source: "listener_exact_captured_pcm_asr";
        text: string;
        provenance_receipt_sha256: string;
      }>
    | Readonly<{
        speaker: "tool";
        source: "canonical_gateway_result";
        tool_name: string;
        tool_arguments: Readonly<Record<string, JsonValue>>;
        text: string;
        provenance_receipt_sha256: string;
        tool_batch_sha256: string;
        tool_batch_call_ordinal: number;
        tool_batch_call_count: number;
      }>;
  const append = (
    turn: ReconstructedTurnInput,
  ) => {
    const sequence = input.turns.length + 1;
    input.turns.push(Object.freeze({
      turn_id:
        `conversation.${String(sequence).padStart(3, "0")}.${turn.speaker}`,
      sequence,
      ...turn,
      transcript_sha256: sha256Hex(turn.text),
      available_after_opportunity: input.opportunity_index,
    }) as Lc4RotationConversationTurn);
  };
  append({
    speaker: "caller",
    source: "caller_tts_source_bound_to_pcm",
    text: input.caller_text,
    provenance_receipt_sha256: input.caller_pcm_sha256,
  });
  const batches = input.exchange.dev_gateway_conversation_tool_batches;
  if (!Array.isArray(batches)) {
    throw new Error(
      "LC4 publication provider exchange lacks retained conversation tool batches",
    );
  }
  for (const [batchIndex, batchValue] of batches.entries()) {
    const batch = objectValue(
      batchValue,
      "LC4 publication retained conversation tool batch",
    );
    if (batch.schema_version !== 1
      || batch.batch_ordinal !== batchIndex + 1
      || typeof batch.provider_response_id_sha256 !== "string"
      || !HASH.test(batch.provider_response_id_sha256)
      || !Array.isArray(batch.calls)
      || batch.calls.length < 1) {
      throw new Error(
        "LC4 publication retained conversation tool batch is incomplete or out of order",
      );
    }
    const batchSha256 = sha256Hex(
      `${ROTATION_TOOL_BATCH_DOMAIN}${canonicalJson(batch)}`,
    );
    for (const [callIndex, callValue] of batch.calls.entries()) {
      const call = objectValue(
        callValue,
        "LC4 publication retained conversation tool call",
      );
      if (call.call_ordinal !== callIndex + 1
        || typeof call.gateway_tool_name !== "string"
        || !call.gateway_tool_name
        || call.model_arguments === null
        || typeof call.model_arguments !== "object"
        || Array.isArray(call.model_arguments)
        || typeof call.provider_output_canonical_json !== "string"
        || canonicalJson(
          JSON.parse(call.provider_output_canonical_json),
        ) !== call.provider_output_canonical_json
        || (call.source_kind !== "authority_projection"
          && call.source_kind !== "pre_dispatch_rejection")
        || typeof call.source_sha256 !== "string"
        || !HASH.test(call.source_sha256)) {
        throw new Error(
          "LC4 publication retained conversation tool call is not exact canonical provider-visible history",
        );
      }
      append({
        speaker: "tool",
        source: "canonical_gateway_result",
        tool_name: call.gateway_tool_name,
        tool_arguments:
          call.model_arguments as Readonly<Record<string, JsonValue>>,
        text: call.provider_output_canonical_json,
        provenance_receipt_sha256: call.source_sha256,
        tool_batch_sha256: batchSha256,
        tool_batch_call_ordinal: callIndex + 1,
        tool_batch_call_count: batch.calls.length,
      });
    }
  }
  const listenerObservation = objectValue(
    input.listener.listener_observation as JsonValue,
    "LC4 publication exact listener observation",
  );
  const transcript = String(listenerObservation.transcript);
  if (listenerObservation.status !== "verified"
    || !transcript
    || listenerObservation.transcript_sha256 !== sha256Hex(transcript)) {
    throw new Error(
      "LC4 publication provider conversation assistant turn lacks its exact listener transcript",
    );
  }
  append({
    speaker: "assistant",
    source: "listener_exact_captured_pcm_asr",
    text: transcript,
    provenance_receipt_sha256: input.assistant_pcm_sha256,
  });
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

async function replayProviderSessionChain(input: Readonly<{
  episode: Lc4DevLiveEpisodePlan;
  run: Lc4DevLiveRunArtifact;
  evidence: ReturnType<typeof createLc4DevReplayEvidenceStore>;
}>): Promise<Readonly<{
  provider_session_count: 6;
  provider_session_replay_set_sha256: string;
  entries: readonly ProviderSessionReplayEntry[];
  packets: readonly (
    | Lc4NativeConversationReplayPacket
    | Lc4HaccRotationStatePacket
    | null
  )[];
}>> {
  const episodeEvents = input.run.ledger.filter(
    (event) => event.episode_id === input.episode.episode_id,
  );
  const intents = episodeEvents.filter(
    (event) => event.event_type === "segment_open_intent",
  );
  const opened = episodeEvents.filter(
    (event) => event.event_type === "segment_opened",
  );
  const terminals = episodeEvents.filter(
    (event) => event.event_type === "episode_terminal",
  );
  const failures = episodeEvents.filter(
    (event) => event.event_type === "segment_failed",
  );
  if (
    intents.length !== LC4_DEV_PROVIDER_SESSION_SCHEDULE.length
    || opened.length !== LC4_DEV_PROVIDER_SESSION_SCHEDULE.length
    || terminals.length !== 1
    || failures.length !== 0
  ) {
    throw new Error(
      `LC4 publication ${input.episode.episode_id} requires an exact planned provider-session lifecycle without failed or replacement sessions`,
    );
  }
  const finalizations = terminals[0]!.evidence_references.filter(
    (reference) => reference.kind === "segment_finalization",
  );
  if (finalizations.length !== LC4_DEV_PROVIDER_SESSION_SCHEDULE.length) {
    throw new Error(
      "LC4 publication provider-session finalization set is incomplete",
    );
  }
  let previousRotationReceiptSha256: string | null = null;
  let previousOpenedSequence = 0;
  let previousSessionOrdinal = 0;
  const entries: ProviderSessionReplayEntry[] = [];
  const packets: Array<
    | Lc4NativeConversationReplayPacket
    | Lc4HaccRotationStatePacket
    | null
  > = [];
  for (const [index, schedule] of
    LC4_DEV_PROVIDER_SESSION_SCHEDULE.entries()) {
    const intent = intents[index]!;
    const open = opened[index]!;
    const closedBeforeSequence = intents[index + 1]?.sequence
      ?? terminals[0]!.sequence;
    const finalizationReference = finalizations[index]!;
    if (
      intent.sequence <= previousOpenedSequence
      || open.sequence <= intent.sequence
      || closedBeforeSequence <= open.sequence
      || finalizationReference.domain_prefix
        !== "harshas-amazing-call-center/lc4-provider-session-rotation/v6\n"
    ) {
      throw new Error(
        "LC4 publication provider-session intent/open/finalization ordering is invalid",
      );
    }
    const [intentPayload, openPayload, finalizationBody] = await Promise.all([
      input.evidence.resolveJson(intent.payload_evidence),
      input.evidence.resolveJson(open.payload_evidence),
      input.evidence.resolveJson(finalizationReference),
    ]);
    const expectedLifecyclePayload = {
      segment_ordinal: schedule.ordinal,
      opportunity_start: schedule.opportunity_start,
      opportunity_end: schedule.opportunity_end,
      previous_rotation_receipt_sha256: previousRotationReceiptSha256,
      planned_provider_session: true,
      retry_or_reconnect: false,
    };
    if (
      canonicalJson(intentPayload) !== canonicalJson(expectedLifecyclePayload)
      || canonicalJson(openPayload) !== canonicalJson(expectedLifecyclePayload)
    ) {
      throw new Error(
        "LC4 publication provider-session lifecycle differs from its prepared schedule or receipt chain",
      );
    }
    const finalization = objectValue(
      finalizationBody,
      "LC4 publication provider-session finalization",
    );
    if (
      !exactKeys(finalization, [
        "schema_version",
        "run_id",
        "protocol_id",
        "provider_session_schedule_sha256",
        "rotation_context_packet",
        "conversation_history_hydration_wire_observations",
        "adapter_version",
        "session_ordinal",
        "segment_ordinal",
        "opportunity_count",
        "provider",
        "model",
        "opened_wire_index",
        "terminal_wire_observation_sha256",
        "previous_rotation_receipt_sha256",
        "rotation_context_kind",
        "rotation_context_sha256",
        "rotation_conversation_replay_sha256",
        "conversation_history_hydration",
      ])
      || finalization.schema_version !== 6
      || finalization.run_id !== input.episode.episode_id
      || finalization.protocol_id !== "HACC-LC4-DEV-v1"
      || finalization.adapter_version
        !== LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION
      || finalization.provider_session_schedule_sha256
        !== LC4_DEV_PROVIDER_SESSION_SCHEDULE_SHA256
      || finalization.segment_ordinal !== schedule.ordinal
      || finalization.opportunity_count !== schedule.opportunity_count
      || finalization.provider !== input.episode.provider
      || finalization.model !== input.episode.model
      || finalization.previous_rotation_receipt_sha256
        !== previousRotationReceiptSha256
      || !Number.isSafeInteger(finalization.opened_wire_index)
      || Number(finalization.opened_wire_index) < 1
      || typeof finalization.terminal_wire_observation_sha256 !== "string"
      || !HASH.test(finalization.terminal_wire_observation_sha256)
    ) {
      throw new Error(
        "LC4 publication provider-session finalization is substituted or not schedule-bound",
      );
    }
    const sessionOrdinal = Number(finalization.session_ordinal);
    if (!Number.isSafeInteger(sessionOrdinal)
      || sessionOrdinal !== schedule.ordinal
      || sessionOrdinal <= previousSessionOrdinal) {
      throw new Error(
        "LC4 publication provider-session finalization session ordinal is not monotonic",
      );
    }
    const expectedRotationContextKind = index === 0
      ? "none" as const
      : input.episode.arm === "native"
        ? "native_conversation_replay" as const
        : "hacc_structured_state" as const;
    const rotationContextSha256 = finalization.rotation_context_sha256;
    const rotationConversationReplaySha256 =
      finalization.rotation_conversation_replay_sha256;
    const hydration = finalization.conversation_history_hydration;
    let hydrationStatus: string | null = null;
    let hydrationAcknowledgementSha256: string | null = null;
    let historyProviderVisibleSha256: string | null = null;
    let historySourceBindingSha256: string | null = null;
    let hydrationTurnCount = 0;
    let hydrationProviderItemCount = 0;
    let retainedRotationPacket:
      | Lc4NativeConversationReplayPacket
      | Lc4HaccRotationStatePacket
      | null = null;
    if (index === 0) {
      if (finalization.rotation_context_kind !== "none"
        || rotationContextSha256 !== null
        || rotationConversationReplaySha256 !== null
        || finalization.rotation_context_packet !== null
        || !Array.isArray(
          finalization.conversation_history_hydration_wire_observations,
        )
        || finalization
          .conversation_history_hydration_wire_observations.length !== 0
        || hydration !== null) {
        throw new Error(
          "LC4 publication initial provider session fabricates rotation or history hydration",
        );
      }
    } else {
      const packetBody = objectValue(
        finalization.rotation_context_packet as JsonValue,
        "LC4 publication retained provider-session rotation packet",
      );
      const expectedPacketType = input.episode.arm === "native"
        ? "native_provider_conversation_replay"
        : "hacc_provider_conversation_plus_structured_state";
      if (packetBody.packet_type !== expectedPacketType
        || packetBody.schema_version !== 6
        || packetBody.run_id !== input.episode.episode_id
        || packetBody.from_segment_ordinal !== schedule.ordinal - 1
        || packetBody.to_segment_ordinal !== schedule.ordinal
        || packetBody.available_through_opportunity
          !== schedule.opportunity_start - 1
        || packetBody.previous_session_rotation_receipt_sha256
          !== previousRotationReceiptSha256) {
        throw new Error(
          "LC4 publication retained provider-session rotation packet differs from its arm, boundary, or receipt chain",
        );
      }
      const rotationProjection = projectLc4RotationPacketForReplay(
        packetBody as unknown as
          | Lc4NativeConversationReplayPacket
          | Lc4HaccRotationStatePacket,
      );
      retainedRotationPacket = packetBody as unknown as
        | Lc4NativeConversationReplayPacket
        | Lc4HaccRotationStatePacket;
      if (finalization.rotation_context_kind !== expectedRotationContextKind
        || typeof rotationContextSha256 !== "string"
        || !HASH.test(rotationContextSha256)
        || typeof rotationConversationReplaySha256 !== "string"
        || !HASH.test(rotationConversationReplaySha256)
        || rotationProjection.packet_sha256 !== rotationContextSha256
        || rotationProjection.conversation_replay_sha256
          !== rotationConversationReplaySha256) {
        throw new Error(
          "LC4 publication reopened provider session is not bound to its arm-correct rotation context",
        );
      }
      const hydrationBody = objectValue(
        hydration as JsonValue,
        "LC4 publication provider-session history hydration",
      );
      hydrationStatus = String(hydrationBody.status);
      hydrationAcknowledgementSha256 = String(
        hydrationBody.acknowledgement_sha256,
      );
      hydrationTurnCount = Number(hydrationBody.turn_count);
      hydrationProviderItemCount = Number(
        hydrationBody.provider_item_count,
      );
      historyProviderVisibleSha256 = String(
        hydrationBody.provider_visible_history_sha256,
      );
      historySourceBindingSha256 = String(
        hydrationBody.source_binding_sha256,
      );
      const allowedStatus = input.episode.provider === "gemini"
        ? hydrationStatus === "sent_unacknowledged_by_provider_protocol"
        : hydrationStatus === "acknowledged"
          || (input.episode.provider === "xai"
            && hydrationStatus
              === "identity_acknowledged_content_unverifiable");
      if (!exactKeys(hydrationBody, [
        "schema_version",
        "provider",
        "connection_epoch",
        "status",
        "turn_count",
        "provider_item_count",
        "provider_visible_history_sha256",
        "source_binding_sha256",
        "acknowledgement_sha256",
        "items",
      ])
        || hydrationBody.schema_version !== 1
        || hydrationBody.provider !== input.episode.provider
        || !Number.isSafeInteger(hydrationBody.connection_epoch)
        || Number(hydrationBody.connection_epoch) !== 1
        || !allowedStatus
        || !Number.isSafeInteger(hydrationTurnCount)
        || hydrationTurnCount !== rotationProjection.turn_count
        || !Number.isSafeInteger(hydrationProviderItemCount)
        || hydrationProviderItemCount
          !== rotationProjection.provider_item_count
        || historyProviderVisibleSha256
          !== rotationProjection.provider_visible_history_sha256
        || historySourceBindingSha256
          !== rotationProjection.source_binding_sha256
        || hydrationAcknowledgementSha256 === null
        || !HASH.test(hydrationAcknowledgementSha256)
        || !Array.isArray(hydrationBody.items)
        || hydrationBody.items.length !== hydrationProviderItemCount) {
        throw new Error(
          "LC4 publication reopened provider session lacks complete provider-native history hydration evidence",
        );
      }
      assertHydrationItemsMatchProviderHistory({
        provider: input.episode.provider,
        items: hydrationBody.items,
        provider_history: rotationProjection.provider_history,
      });
      const acknowledgementBody = {
        schemaVersion: 1,
        provider: input.episode.provider,
        connectionEpoch: 1,
        status: hydrationStatus,
        turnCount: hydrationTurnCount,
        providerItemCount: hydrationProviderItemCount,
        historySha256: historyProviderVisibleSha256,
        sourceBindingSha256: historySourceBindingSha256,
        items: hydrationBody.items,
      };
      if (hydrationAcknowledgementSha256 !== sha256Hex(
        `${PROVIDER_HISTORY_ACKNOWLEDGEMENT_DOMAIN}${canonicalJson(
          acknowledgementBody,
        )}`,
      )) {
        throw new Error(
          "LC4 publication provider-session hydration acknowledgement commitment is invalid",
        );
      }
      if (!Array.isArray(
        finalization.conversation_history_hydration_wire_observations,
      ) || finalization
        .conversation_history_hydration_wire_observations.length < 1) {
        throw new Error(
          "LC4 publication provider-session hydration lacks retained setup wire observations",
        );
      }
      const replayedHydration =
        validateConversationHistoryHydrationAcknowledgement({
          receipt: acknowledgementBody as
            RealtimeConversationHistoryHydrationAcknowledgement,
          provider: input.episode.provider,
          turns: rotationProjection.provider_history,
          expected_history_sha256:
            rotationProjection.provider_visible_history_sha256,
          wire_observations: finalization
            .conversation_history_hydration_wire_observations as unknown as
              readonly Lc4SanitizedWireObservation[],
        });
      if (canonicalJson(replayedHydration)
        !== canonicalJson(hydrationBody)) {
        throw new Error(
          "LC4 publication retained provider-session hydration differs from independent wire replay",
        );
      }
    }
    entries.push(Object.freeze({
      segment_ordinal: schedule.ordinal,
      opportunity_start: schedule.opportunity_start,
      opportunity_end: schedule.opportunity_end,
      opportunity_count: schedule.opportunity_count,
      intent_sequence: intent.sequence,
      intent_payload_sha256: intent.payload_evidence.evidence_sha256,
      opened_sequence: open.sequence,
      opened_payload_sha256: open.payload_evidence.evidence_sha256,
      closed_before_sequence: closedBeforeSequence,
      session_ordinal: sessionOrdinal,
      rotation_receipt_sha256: finalizationReference.evidence_sha256,
      previous_rotation_receipt_sha256:
        previousRotationReceiptSha256,
      rotation_context_kind: expectedRotationContextKind,
      rotation_context_sha256: index === 0
        ? null
        : String(rotationContextSha256),
      rotation_conversation_replay_sha256: index === 0
        ? null
        : String(rotationConversationReplaySha256),
      history_hydration_status: hydrationStatus,
      history_hydration_acknowledgement_sha256:
        hydrationAcknowledgementSha256,
      history_provider_visible_sha256:
        historyProviderVisibleSha256,
      history_source_binding_sha256:
        historySourceBindingSha256,
      history_hydration_turn_count: hydrationTurnCount,
      history_hydration_provider_item_count:
        hydrationProviderItemCount,
    }));
    packets.push(retainedRotationPacket);
    previousRotationReceiptSha256 =
      finalizationReference.evidence_sha256;
    previousOpenedSequence = open.sequence;
    previousSessionOrdinal = sessionOrdinal;
  }
  return freeze({
    provider_session_count:
      LC4_DEV_PROVIDER_SESSION_SCHEDULE.length as 6,
    provider_session_replay_set_sha256: sha256Hex(
      `${PROVIDER_SESSION_REPLAY_SET_DOMAIN}${canonicalJson({
        episode_id: input.episode.episode_id,
        provider: input.episode.provider,
        arm: input.episode.arm,
        provider_session_schedule_sha256:
          LC4_DEV_PROVIDER_SESSION_SCHEDULE_SHA256,
        entries,
      })}`,
    ),
    entries: Object.freeze([...entries]),
    packets: Object.freeze([...packets]),
  });
}

export function createLc4PublicationTransportReplay(
  input: Omit<
    Lc4PublicationTransportReplay,
    | "schema_version"
    | "provider_session_count"
    | "provider_session_replay_set_sha256"
    | "replay_sha256"
  >,
): Lc4PublicationTransportReplay {
  const body = freeze({
    schema_version: 3 as const,
    ...input,
    provider_session_count: input.episodes.reduce<number>(
      (total, episode) => total + episode.provider_session_count,
      0,
    ) as 36,
    provider_session_replay_set_sha256:
      providerSessionReplayAggregateSha256(input.episodes),
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
  if (value.schema_version !== 3
    || !exactKeys(value, [
      "schema_version",
      "run_sha256",
      "provider_profile_manifest_sha256",
      "audio_delivery_profile_sha256",
      "listener_authority_trust_root_sha256",
      "canonical_provider_exchange_count",
      "provider_session_count",
      "provider_session_replay_set_sha256",
      "repair_provider_exchange_count",
      "total_response_generation_count",
      "episodes",
      "replay_sha256",
    ])
    || !HASH.test(claimed)
    || claimed !== sha256Hex(`${REPLAY_DOMAIN}${canonicalJson(body)}`)
    || !HASH.test(value.run_sha256)
    || !HASH.test(value.provider_profile_manifest_sha256)
    || !HASH.test(value.audio_delivery_profile_sha256)
    || !HASH.test(value.listener_authority_trust_root_sha256)
    || value.canonical_provider_exchange_count !== 360
    || value.provider_session_count !== 36
    || value.provider_session_count
      !== value.episodes.reduce((total, episode) =>
        total + episode.provider_session_count, 0)
    || !HASH.test(value.provider_session_replay_set_sha256)
    || value.provider_session_replay_set_sha256
      !== providerSessionReplayAggregateSha256(value.episodes)
    || !Number.isSafeInteger(value.repair_provider_exchange_count)
    || value.repair_provider_exchange_count < 0
    || value.total_response_generation_count
      !== value.canonical_provider_exchange_count
        + value.repair_provider_exchange_count
    || value.episodes.length !== 6
    || canonicalJson(actualKeys) !== canonicalJson(expectedKeys)
    || value.episodes.some((episode) => {
      const expected = expectedTransport(episode.provider);
      return !exactKeys(episode, [
        "episode_id",
        "provider",
        "arm",
        "model",
        "transport_purpose",
        "transport_mode",
        "transport_profile_sha256",
        "output_audio_lineage_scope",
        "canonical_provider_exchange_count",
        "provider_session_count",
        "provider_session_replay_set_sha256",
        "repair_provider_exchange_count",
        "total_response_generation_count",
        "canonical_exchange_replay_set_sha256",
        "response_generation_replay_set_sha256",
        "listener_authority_replay_set_sha256",
        "listener_invocation_replay_set_sha256",
      ])
        || episode.model !== expected.model
        || episode.transport_purpose !== expected.transport_purpose
        || episode.transport_mode !== expected.transport_mode
        || episode.transport_profile_sha256
          !== expected.transport_profile_sha256
        || episode.output_audio_lineage_scope
          !== outputAudioLineageScope(episode.provider)
        || episode.canonical_provider_exchange_count !== 60
        || episode.provider_session_count !== 6
        || !HASH.test(episode.provider_session_replay_set_sha256)
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

function assertExchangeProviderSessionBinding(input: Readonly<{
  exchange: Record<string, JsonValue>;
  session: ProviderSessionReplayEntry;
}>): void {
  if (input.exchange.segment_ordinal !== input.session.segment_ordinal
    || input.exchange.rotation_context_kind
      !== input.session.rotation_context_kind
    || input.exchange.rotation_context_sha256
      !== input.session.rotation_context_sha256
    || input.exchange.rotation_conversation_replay_sha256
      !== input.session.rotation_conversation_replay_sha256
    || !Array.isArray(input.exchange.wire_observations)
    || input.exchange.wire_observations.length < 1
    || input.exchange.wire_observations.some((candidate) => {
      if (candidate === null
        || typeof candidate !== "object"
        || Array.isArray(candidate)) return true;
      return candidate.connection_epoch !== 1;
    })) {
    throw new Error(
      "LC4 publication provider exchange differs from its retained provider-session rotation and connection epoch",
    );
  }
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
  const providerSessionReplay = await replayProviderSessionChain(input);
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
  const reconstructedConversationTurns: Lc4RotationConversationTurn[] = [];
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
    const callerPcmSha256 = String(payload.caller_pcm_sha256);
    requireHash(
      callerPcmSha256,
      "LC4 publication completed-opportunity caller PCM",
    );
    const callerReferences = event.evidence_references.filter((candidate) =>
      candidate.kind === "caller_pcm"
      && candidate.evidence_sha256 === callerPcmSha256);
    if (callerReferences.length !== 1) {
      throw new Error(
        "LC4 publication completed opportunity lacks one exact caller PCM edge",
      );
    }
    const callerReference = callerReferences[0]!;
    const projection = await input.evidence.resolveJson(reference);
    const exchange = objectValue(
      projection,
      "LC4 publication provider exchange replay",
    );
    const segmentOrdinal = Math.ceil(
      opportunity.index / LC4_DEV_OPPORTUNITIES_PER_PROVIDER_SEGMENT,
    ) as 1 | 2 | 3 | 4 | 5 | 6;
    const providerSession =
      providerSessionReplay.entries[segmentOrdinal - 1];
    if (!providerSession) {
      throw new Error(
        "LC4 publication provider exchange lacks its scheduled provider session",
      );
    }
    assertExchangeProviderSessionBinding({
      exchange,
      session: providerSession,
    });
    if (event.sequence <= providerSession.opened_sequence
      || event.sequence >= providerSession.closed_before_sequence) {
      throw new Error(
        "LC4 publication completed opportunity is outside its scheduled provider-session ledger interval",
      );
    }
    const outputCapture = objectValue(
      exchange.output_capture,
      "LC4 publication provider output capture",
    );
    const outputPcmSha256 = String(outputCapture.generated_pcm_sha256);
    requireHash(outputPcmSha256, "LC4 publication output PCM");
    const callerPcm = await input.cas.get(callerPcmSha256);
    if (callerReference.byte_length !== callerPcm.byteLength) {
      throw new Error(
        "LC4 publication retained caller PCM length differs from its ledger edge",
      );
    }
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
      segment_ordinal: segmentOrdinal,
      playback_kind: "canonical",
      caller_pcm_sha256: callerPcmSha256,
      caller_pcm_byte_length: callerPcm.byteLength,
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
    let callerText = opportunity.canonical_caller_text;
    if (exchange.caller_branch_authority !== null) {
      const branch = objectValue(
        exchange.caller_branch_authority as JsonValue,
        "LC4 publication caller branch authority",
      );
      const source = LC4_DEV_CALLER_BRANCH_SOURCES.find((candidate) =>
        candidate.source_id === branch.source_id
        && candidate.prior_outcome === branch.prior_outcome);
      if (!source
        || source.canonical_caller_text_sha256
          !== branch.source_text_sha256
        || branch.decision_sha256
          !== payload.caller_branch_decision_sha256
        || branch.decision_evidence_sha256
          !== payload.caller_branch_decision_sha256) {
        throw new Error(
          "LC4 publication caller branch text differs from its retained signed source",
        );
      }
      callerText = source.canonical_caller_text;
    } else if (payload.caller_branch_decision_sha256 !== null
      || callerPcmSha256 !== binding.pcm_sha256
      || callerPcm.byteLength !== binding.pcm_byte_length) {
      throw new Error(
        "LC4 publication non-branch caller PCM differs from its prepared audio binding",
      );
    }
    appendReconstructedConversationExchange({
      turns: reconstructedConversationTurns,
      opportunity_index: opportunity.index,
      caller_text: callerText,
      caller_pcm_sha256: callerPcmSha256,
      exchange,
      listener,
      assistant_pcm_sha256: outputPcmSha256,
    });
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
      assertExchangeProviderSessionBinding({
        exchange: repairExchange,
        session: providerSession,
      });
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
          segment_ordinal: segmentOrdinal,
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
      const selection = objectValue(
        repairDecision.selection as JsonValue,
        "LC4 publication repair decision selection",
      );
      const repairSource = corpus.repair_policy.library.find((candidate) =>
        candidate.id === selection.repair_pcm_id);
      if (!repairSource
        || selection.pcm_sha256 !== repairCallerPcmSha256
        || selection.pcm_byte_length !== repairCallerPcm.byteLength) {
        throw new Error(
          "LC4 publication repair caller text differs from its frozen repair library",
        );
      }
      appendReconstructedConversationExchange({
        turns: reconstructedConversationTurns,
        opportunity_index: opportunity.index,
        caller_text: repairSource.canonical_caller_text,
        caller_pcm_sha256: repairCallerPcmSha256,
        exchange: repairExchange,
        listener: repairListener,
        assistant_pcm_sha256: repairOutputPcmSha256,
      });
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
  for (const [index, packet] of providerSessionReplay.packets.entries()) {
    if (index === 0) {
      if (packet !== null) {
        throw new Error(
          "LC4 publication initial provider session has a rotation packet",
        );
      }
      continue;
    }
    if (packet === null) {
      throw new Error(
        "LC4 publication reopened provider session lacks its retained rotation packet",
      );
    }
    const expectedTurns = reconstructedConversationTurns.filter((turn) =>
      turn.available_after_opportunity
        <= LC4_DEV_PROVIDER_SESSION_SCHEDULE[index]!.opportunity_start - 1);
    if (canonicalJson(packet.conversation_turns)
      !== canonicalJson(expectedTurns)) {
      throw new Error(
        "LC4 publication retained rotation packet conversation differs from exact prior caller, tool, and assistant evidence",
      );
    }
  }
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
    provider_session_count:
      providerSessionReplay.provider_session_count,
    provider_session_replay_set_sha256:
      providerSessionReplay.provider_session_replay_set_sha256,
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
    entries: Object.freeze([...entries]),
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

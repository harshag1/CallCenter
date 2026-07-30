import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, type JsonValue } from "../artifacts";
import {
  INDEPENDENT_ASR_RESULT_SCHEMA_SHA256,
  independentAsrContractSha256,
  type IndependentAsrContract,
} from "../audible-evidence";
import {
  LC4_DEV_ADAPTER_BOUNDARY,
  LC4_DEV_LIVE_TIMEOUTS,
  assertLc4DevLivePrepareArtifact,
  assertLc4DevRepairPlaybackReceiptBinding,
  createLc4DevLivePreflightArtifact,
  createLc4DevLivePrepareArtifact,
  createLc4DevRetainedQualificationReceipt,
  createLc4DevLiveReportArtifact,
  executeLc4DevLiveRun,
  lc4DevLiveAuthorizationArtifactSha256,
  lc4DevLiveAuthorizationSigningBytes,
  type Lc4DevCallerAudioBinding,
  type Lc4DevControlReceipt,
  type Lc4DevLiveRunnerDependencies,
  type Lc4DevelopmentRealtimeAdapter,
} from "../lc4-development-live-runner";
import {
  LC4_DEV_MINIMUM_OPPORTUNITY_WATCHDOG_MS,
  LC4_DEV_TIMEOUT_CONTRACT,
} from "../lc4-development-timeout-contract";
import { createLc4DevArmBlindRepairProjection } from "../lc4-development-headless-listener-authority";
import { createLc4CapturedOutput } from "../lc4-listener-evidence";
import {
  LC4_DEV_PINNED_VOICE,
  materializeLc4DevelopmentAudio,
  type Lc4DevAudioRenderer,
} from "../lc4-development-audio-materializer";
import {
  createLc4DevRepairPlaybackController,
  type Lc4DevRepairPlayback,
  type Lc4DevRepairPlaybackReceipt,
} from "../lc4-development-repair-playback";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";
import {
  LC4_PROVIDER_PROFILE_MANIFEST,
  LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE,
} from "../lc4-provider-profiles";
import {
  LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION,
  LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY,
} from "../lc4-production-provider-contract";
import {
  LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER,
  LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
  createLc4XaiFiniteManualGateDAuthorization,
  createLc4XaiFiniteManualGateDPlan,
  createLc4XaiFiniteManualGateDSigner,
  executeLc4XaiFiniteManualGateD,
  lc4XaiFiniteManualGateDExecutionReplaySha256,
  type Lc4XaiFiniteManualGateDExecutionEvidence,
  type Lc4XaiFiniteManualGateDProductionAdapter,
  type Lc4XaiFiniteManualGateDReceipt,
} from "../lc4-xai.manual-qualification";
import {
  lc4XaiManualResponseWireIdentitySha256,
  type Lc4SanitizedWireObservation,
} from "../lc4-xai-manual-turn-causality";
import {
  LC4_PRODUCTION_PROVIDER_EXECUTION_FROZEN,
  createLc4DevelopmentRealtimeAdapter,
  lc4DevCredentialIdentitySetSha256,
} from "../lc4-production-provider-adapter";
import { createLc4ProviderExecutionProfile } from "../lc4-production-runner-foundation";
import {
  LC4_DEV_AUDIO_DELIVERY_PROFILE,
  LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
} from "../lc4-development-audio-contract";
import type { Lc4DevGatewayExecutor } from "../lc4-development-gateway-bridge";
import type { HaccResponsePlan } from "../response-plan";
import {
  createLc4DevReplayEvidenceStore,
  verifyLc4DevReplayLedger,
  type Lc4DevReplayArtifactKind,
  type Lc4DevReplayEvidenceStore,
} from "../lc4-development-evidence-retention";
import type { Lc4DevCallerBranchPlaybackBinding } from "../lc4-development-realtime-contract";
import {
  LC4_DEV_CALLER_BRANCH_DECISION_ARTIFACT_DOMAIN,
  LC4_DEV_CALLER_BRANCH_SOURCES,
  LC4_DEV_PRIOR_MUTATION_OUTCOMES,
  createLc4DevCallerBranchAuthority,
  createLc4DevCallerBranchMatrixArtifact,
  lc4DevBranchedOpportunity,
  type Lc4DevCallerBranchAudioBinding,
  type Lc4DevPriorMutationOutcome,
} from "../lc4-development-caller-branch";
import {
  LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
  LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
  LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
  LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
  LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION,
  LC4_QUALIFICATION_V3_RUNNER_VERSION,
  LC4_XAI_SERVER_VAD_SETTING_SHA256,
  createLc4QualificationV3Targets,
  type Lc4QualificationV3PlanArtifact,
  type Lc4QualificationV3AuthorizationArtifact,
  type Lc4QualificationV3TerminalArtifact,
} from "../lc4-qualification-v3-runner";
import {
  providerQualificationMatrixSha256,
  type ProviderQualificationArtifact,
} from "../provider-qualification";
import {
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
} from "../../realtime/client/wire-evidence";
import {
  LC4_S2S_AUDIO_FIXTURE_VERSION,
  LC4_S2S_COMPACT_CONTROL_SHA256,
  LC4_S2S_HISTORY_PROBE_SHA256,
  LC4_S2S_HISTORY_PROVIDER_VISIBLE_SHA256,
  LC4_S2S_HISTORY_SOURCE_BINDING_SHA256,
  LC4_S2S_PACKETIZER_SHA256,
  LC4_S2S_SOURCE_TEXT_SHA256,
  LC4_S2S_TOOL_SCHEMA_SHA256,
  LC4_S2S_VOICE,
  LC4_S2S_VOICE_SHA256,
  lc4S2sControlSizeDiagnostic,
} from "../provider-s2s-tool-roundtrip";
import {
  productionOpenAiCompatibleSessionUpdate,
  productionSessionPayloadParitySha256,
} from "../production-realtime-provider";
import {
  withXaiServerVadPcmSession,
  xaiServerVadTransportParitySha256,
} from "../../realtime/client/openai-compatible";
import {
  DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
  trialAudioDeliveryProfileHash,
} from "../orchestrator";
import {
  createLc4QualificationPayloadManifestV5,
  createSignedLc4QualificationPackageEnvelopeV5,
  type Lc4QualificationPackageFile,
} from "../lc4-qualification-package-envelope";
import {
  LC4_QUALIFICATION_BUDGET_VERSION,
  type Lc4QualificationBudgetEvidence,
} from "../lc4-qualification-budget";
import {
  LC4_DEV_FAILURE_EVIDENCE_VERSION,
  Lc4DevFailureEvidenceError,
  createLc4DevFailureEvidence,
} from "../lc4-development-failure-evidence";

describe("LC4-DEV timeout ownership", () => {
  it("keeps the runner fuse beyond every inner timeout owner", () => {
    expect(LC4_DEV_LIVE_TIMEOUTS.opportunity_exchange_ms).toBeGreaterThanOrEqual(
      LC4_DEV_MINIMUM_OPPORTUNITY_WATCHDOG_MS,
    );
    expect(LC4_DEV_MINIMUM_OPPORTUNITY_WATCHDOG_MS).toBe(718_000);
    expect(LC4_DEV_LIVE_TIMEOUTS.opportunity_exchange_ms).toBe(730_000);
    expect(LC4_DEV_TIMEOUT_CONTRACT.provider_response_ms).toBe(75_000);
    expect(LC4_DEV_TIMEOUT_CONTRACT.listener_asr_ms).toBe(600_000);
  });
});

const HASH = "a".repeat(64);
const NOW = "2026-07-21T22:00:00.000Z";
const COMPLETE_AUTHORITY = Object.freeze({
  status: "scorable" as const,
  passed: 6,
  evaluated: 6,
  evidence_invalid: 0,
  episode_replay_sha256s: Object.freeze(Array.from({ length: 6 }, (_, index) => sha256Hex(`authority-replay-${index}`))),
});
const COMPLETE_RUN_BUDGET = Object.freeze({
  run_package_sha256: sha256Hex("run-package"),
  budget_lease_sha256: sha256Hex("budget-lease"),
  budget_evidence_sha256: sha256Hex("budget-evidence"),
  budget_terminal_ledger_head_sha256: sha256Hex("budget-ledger-head"),
  budget_replay_verified: true as const,
});
const branchKeys = generateKeyPairSync("ed25519");
const asrRunnerKeys = generateKeyPairSync("ed25519");
const gateDAuthorityKeys = generateKeyPairSync("ed25519");
const gateDTerminalKeys = generateKeyPairSync("ed25519");
const branchIdentity = Object.freeze({
  key_id: "lc4-dev-live-runner-branch-test",
  private_key_pem: branchKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  public_key_pem: branchKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
});
const asrContract: IndependentAsrContract = Object.freeze({
  schema_version: 1,
  contract_id: "lc4-dev-live-runner-test-asr",
  engine: Object.freeze({
    implementation: "whisper.cpp",
    source_repository: "https://github.com/ggml-org/whisper.cpp",
    source_revision: "a".repeat(40),
    executable_sha256: sha256Hex("fixture-asr-executable"),
    dependency_lock_sha256: sha256Hex("fixture-asr-dependency-lock"),
    model_id: "ggml-large-v3-turbo",
    model_revision: "b".repeat(40),
    weights_sha256: sha256Hex("fixture-asr-weights"),
  }),
  decoding: Object.freeze({
    language: "en",
    task: "transcribe",
    temperature_milli: 0,
    beam_size: 5,
    best_of: 5,
    word_timestamps: true,
    condition_on_previous_text: false,
    initial_prompt_sha256: null,
  }),
  resampling_profile_sha256: sha256Hex("fixture-asr-resampling-profile"),
  result_schema_sha256: INDEPENDENT_ASR_RESULT_SCHEMA_SHA256,
});
const asrContractSha256 = independentAsrContractSha256(asrContract);
const asrRunnerPublicKey = asrRunnerKeys.publicKey.export({
  type: "spki",
  format: "der",
});
const asrRunnerTrust = Object.freeze({
  key_id: "lc4-dev-live-runner-test-asr",
  public_key_spki_base64: asrRunnerPublicKey.toString("base64"),
  public_key_fingerprint_sha256: sha256Hex(asrRunnerPublicKey),
  signature_algorithm: "Ed25519" as const,
});

function repairProjection(opportunityId: string) {
  return createLc4DevArmBlindRepairProjection({
    opportunity_id: opportunityId,
    listener_status: "verified",
    semantic_result_sha256: sha256Hex(`semantic-result:${opportunityId}`),
    semantic_replay_sha256: sha256Hex(`semantic-replay:${opportunityId}`),
    unmet_blocker_codes: [],
    final_required_criteria_pass: true,
  });
}

const WIRE_OBSERVATION_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-wire-observation-set/v1\n";
const XAI_MANUAL_CAUSALITY_DOMAIN =
  "harshas-amazing-call-center/lc4-xai-manual-turn-causality/v1\n";
const LISTENER_EVIDENCE_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-pinned-listener-evidence/v1\n";
const CAS_RECEIPT_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-cas-receipt/v1\n";

type FixtureProvider = "openai" | "gemini" | "xai";
type FixtureWireRole = Readonly<{
  direction: "inbound" | "outbound";
  wire_type: string;
  identity_hashes?: Readonly<Record<string, string>>;
  payload_sha256?: string;
  payload_bytes?: number;
  projection_sha256?: string;
}>;
type FixtureListenerLineage = Readonly<{
  body: Record<string, unknown>;
  reference: Readonly<{
    schema_version: 1;
    retention_version: "lc4-dev-replay-evidence-v1";
    kind: "listener_evidence";
    evidence_sha256: string;
    byte_length: number;
    content_encoding: "domain-prefixed-canonical-json";
    domain_prefix: typeof LISTENER_EVIDENCE_DOMAIN;
  }>;
  repair_projection: ReturnType<typeof repairProjection>;
  playback_authority_receipt_sha256: string;
}>;

const providerProjectionListenerLineage =
  new WeakMap<object, FixtureListenerLineage>();

function domainHash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function fixtureCallerFrames(
  value: Uint8Array,
  sampleRateHz: number,
): readonly Uint8Array[] {
  const frameBytes = sampleRateHz
    * 2
    * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs
    / 1_000;
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < value.byteLength; offset += frameBytes) {
    frames.push(value.slice(offset, Math.min(value.byteLength, offset + frameBytes)));
  }
  return frames;
}

function fixturePcmProjection(value: Uint8Array, sampleRateHz: number) {
  return {
    validCanonicalBase64: true as const,
    byteLength: value.byteLength,
    sha256: sha256Hex(value),
    encodedBytes: Buffer.byteLength(Buffer.from(value).toString("base64"), "utf8"),
    format: {
      encoding: "pcm16" as const,
      sampleRateHz,
      channels: 1 as const,
    },
  };
}

function fixtureInputWireRole(
  provider: FixtureProvider,
  value: Uint8Array,
  sampleRateHz: number,
): FixtureWireRole {
  const base64 = Buffer.from(value).toString("base64");
  if (provider === "gemini") {
    const event = {
      realtimeInput: {
        audio: {
          data: base64,
          mimeType: `audio/pcm;rate=${sampleRateHz}`,
        },
      },
    };
    const serialized = JSON.stringify(event);
    return {
      direction: "outbound",
      wire_type: "realtimeInput.audio",
      payload_sha256: sha256Hex(serialized),
      payload_bytes: Buffer.byteLength(serialized),
      projection_sha256: realtimeWireProjectionSha256({
        audio: {
          direction: "input",
          chunks: [{
            ...fixturePcmProjection(value, sampleRateHz),
            mimeTypeRecognized: true,
          }],
        },
      }),
    };
  }
  const event = {
    type: "input_audio_buffer.append",
    audio: base64,
  };
  const serialized = JSON.stringify(event);
  return {
    direction: "outbound",
    wire_type: "input_audio_buffer.append",
    payload_sha256: sha256Hex(serialized),
    payload_bytes: Buffer.byteLength(serialized),
    projection_sha256: realtimeWireProjectionSha256({
      audio: fixturePcmProjection(value, sampleRateHz),
    }),
  };
}

function fixtureOutputWireRole(
  value: Uint8Array,
  sampleRateHz: number,
  responseIdSha256: string,
): FixtureWireRole {
  return {
    direction: "inbound",
    wire_type: "response.audio.delta",
    identity_hashes: { responseIdSha256 },
    projection_sha256: realtimeWireProjectionSha256({
      audio: fixturePcmProjection(value, sampleRateHz),
    }),
  };
}

function fixtureGeminiOutputRole(
  value: Uint8Array,
  sampleRateHz: number,
): FixtureWireRole {
  return {
    direction: "inbound",
    wire_type: "serverContent",
    projection_sha256: realtimeWireProjectionSha256({
      audio: {
        direction: "output",
        chunks: [{
          ...fixturePcmProjection(value, sampleRateHz),
          mimeTypeRecognized: true,
        }],
      },
    }),
  };
}

function fixtureWireObservations(
  provider: FixtureProvider,
  seed: string,
  roles: readonly FixtureWireRole[],
) {
  let previous: string | null = null;
  return roles.map((role, index) => {
    const observationSha256 = sha256Hex(
      `${seed}:observation:${index}:${role.wire_type}:${previous ?? "root"}`,
    );
    const observation = {
      provider,
      direction: role.direction,
      connection_epoch: 1,
      sequence: index + 1,
      wire_type: role.wire_type,
      payload_sha256: role.payload_sha256
        ?? sha256Hex(`${seed}:payload:${index}:${role.wire_type}`),
      payload_bytes: role.payload_bytes ?? 17,
      projection_sha256: role.projection_sha256
        ?? realtimeWireProjectionSha256({}),
      observation_sha256: observationSha256,
      previous_observation_sha256: previous,
      identity_hashes: role.identity_hashes ?? {},
    };
    previous = observationSha256;
    return observation;
  });
}

function providerExchangeProjection(
  callerPcm: Uint8Array,
  assistantPcm: Uint8Array,
  callerBranchBinding: Lc4DevCallerBranchPlaybackBinding | undefined,
  extra: Record<string, unknown> & Readonly<{
    episode_id: string;
    opportunity_id: string;
    provider: FixtureProvider;
    model: string;
    arm: "native" | "hacc";
  }>,
  listenerOverrides: Readonly<{
    repair_projection?: ReturnType<typeof repairProjection>;
    playback_authority_receipt_sha256?: string;
  }> = {},
) {
  const decision = callerBranchBinding?.decision;
  const profile = createLc4ProviderExecutionProfile(extra.provider);
  const playbackKind = extra.kind === "repair" ? "repair" : "canonical";
  const opportunityOrdinal = Number.parseInt(extra.opportunity_id.match(/(\d+)$/u)?.[1] ?? "1", 10);
  const inputFrames = fixtureCallerFrames(callerPcm, profile.input_sample_rate_hz);
  const responseIdentity = sha256Hex(
    `fixture-response:${extra.episode_id}:${extra.opportunity_id}:${playbackKind}`,
  );
  const capture = createLc4CapturedOutput({
    runId: extra.episode_id,
    opportunityId: extra.opportunity_id,
    responseId: `response-${extra.provider}-${extra.opportunity_id}-${playbackKind}`,
    provider: extra.provider,
    surface: "server_realtime_pcm",
    sampleRateHz: profile.output_sample_rate_hz,
    chunks: [{
      chunkId: `${extra.opportunity_id}-${playbackKind}-chunk-1`,
      pcm: assistantPcm,
    }],
  });
  const outputCapture = {
    ...capture,
    chunks: capture.chunks.map((chunk) => chunk.receipt),
  };
  const wireRoles: readonly FixtureWireRole[] = extra.provider === "gemini"
    ? [
        { direction: "outbound", wire_type: "realtimeInput.activityStart" },
        ...inputFrames.map((frame) =>
          fixtureInputWireRole(extra.provider, frame, profile.input_sample_rate_hz)),
        { direction: "outbound", wire_type: "realtimeInput.activityEnd" },
        fixtureGeminiOutputRole(assistantPcm, profile.output_sample_rate_hz),
        {
          direction: "inbound",
          wire_type: "serverContent",
          projection_sha256: realtimeWireProjectionSha256({
            terminal: { status: "completed" },
          }),
        },
      ]
    : [
        ...inputFrames.map((frame) =>
          fixtureInputWireRole(extra.provider, frame, profile.input_sample_rate_hz)),
        { direction: "outbound", wire_type: "input_audio_buffer.commit" },
        ...(extra.provider === "xai"
          ? [{
              direction: "inbound" as const,
              wire_type: "input_audio_buffer.committed",
            }]
          : []),
        { direction: "outbound", wire_type: "response.create" },
        {
          direction: "inbound",
          wire_type: "response.created",
          identity_hashes: { responseIdSha256: responseIdentity },
        },
        fixtureOutputWireRole(
          assistantPcm,
          profile.output_sample_rate_hz,
          responseIdentity,
        ),
        {
          direction: "inbound",
          wire_type: "response.done",
          identity_hashes: { responseIdSha256: responseIdentity },
        },
      ];
  const wireObservations = fixtureWireObservations(
    extra.provider,
    `fixture-wire:${extra.episode_id}:${extra.opportunity_id}:${playbackKind}`,
    wireRoles,
  );
  const wireObservationSetSha256 = domainHash(
    WIRE_OBSERVATION_SET_DOMAIN,
    wireObservations,
  );
  const inputCommit = wireObservations.find((observation) =>
    observation.wire_type === "input_audio_buffer.commit");
  const inputCommitAck = wireObservations.find((observation) =>
    observation.wire_type === "input_audio_buffer.committed");
  const responseCreate = wireObservations.find((observation) =>
    observation.wire_type === "response.create");
  const responseStart = wireObservations.find((observation) =>
    observation.wire_type === "response.created");
  const manualCausalityBody = extra.provider === "xai"
    ? {
        schema_version: 1,
        connection_epoch: 1,
        commit_observation_sha256: inputCommit!.observation_sha256,
        commit_sequence: inputCommit!.sequence,
        commit_ack_observation_sha256: inputCommitAck!.observation_sha256,
        commit_ack_sequence: inputCommitAck!.sequence,
        response_create_observation_sha256: responseCreate!.observation_sha256,
        response_create_sequence: responseCreate!.sequence,
        response_start_observation_sha256: responseStart!.observation_sha256,
        response_start_sequence: responseStart!.sequence,
        response_id_sha256: responseIdentity,
      }
    : null;
  const operationOrder = [
    "caller_pcm_delivery_started",
    "caller_pcm_delivery_completed",
    "response_plan_prepared",
    "caller_pcm_committed",
    ...(extra.provider === "xai" ? ["caller_pcm_commit_acknowledged"] : []),
    "response_generation_requested",
    "assistant_pcm_captured",
    "listener_evidence_handed_off",
  ];
  const responsePlanSha256 = extra.arm === "hacc"
    ? sha256Hex(
        `fixture-response-plan:${extra.episode_id}:${extra.opportunity_id}:${playbackKind}`,
      )
    : null;
  const listenerRepairProjection = listenerOverrides.repair_projection
    ?? repairProjection(extra.opportunity_id);
  const playbackAuthorityReceiptSha256 =
    listenerOverrides.playback_authority_receipt_sha256
    ?? sha256Hex(`authority:${extra.episode_id}:${extra.opportunity_id}`);
  const assistantSha256 = sha256Hex(assistantPcm);
  const assistantConversationTranscriptSha256 = sha256Hex(
    `fixture-transcript:${extra.episode_id}:${extra.opportunity_id}:${playbackKind}`,
  );
  const signedInvocationArtifactCasSha256 = sha256Hex(
    `fixture-signed-invocation-artifact:${extra.episode_id}:${extra.opportunity_id}:${playbackKind}`,
  );
  const signedInvocationArtifactByteLength = 256;
  const listenerBody = {
    schema_version: 1,
    dependency_version: "lc4-dev-live-dependencies-v1",
    episode_id: extra.episode_id,
    opportunity_id: extra.opportunity_id,
    provider: extra.provider,
    capture_receipt_sha256: outputCapture.capture_receipt_sha256,
    generated_pcm_sha256: assistantSha256,
    captured_pcm_sha256: assistantSha256,
    evaluator_consumed_pcm_sha256: assistantSha256,
    evaluator_consumed_byte_start: 0,
    evaluator_consumed_byte_end: assistantPcm.byteLength,
    evaluator_consumed_pcm_cas_receipt_sha256: domainHash(
      CAS_RECEIPT_DOMAIN,
      {
        schema_version: 1,
        algorithm: "sha256",
        artifact_sha256: assistantSha256,
        byte_length: assistantPcm.byteLength,
        relative_path: `${assistantSha256.slice(0, 2)}/${assistantSha256}`,
        media_type: "audio/pcm",
      },
    ),
    headless_listener_authority_receipt_sha256:
      playbackAuthorityReceiptSha256,
    headless_listener_authority_receipt_cas_sha256:
      sha256Hex(`listener-authority-cas:${extra.episode_id}:${extra.opportunity_id}:${playbackKind}`),
    headless_listener_authority_receipt_cas_receipt_sha256:
      sha256Hex(`listener-authority-cas-receipt:${extra.episode_id}:${extra.opportunity_id}:${playbackKind}`),
    physical_playback_status: "not_performed_headless",
    human_audibility_status: "not_measured_not_claimed",
    criterion_plan_sha256:
      sha256Hex(`listener-criterion:${extra.episode_id}:${extra.opportunity_id}`),
    response_plan_sha256: responsePlanSha256,
    wire_observation_set_sha256: wireObservationSetSha256,
    signed_invocation_artifact_cas_sha256:
      signedInvocationArtifactCasSha256,
    signed_invocation_artifact_byte_length:
      signedInvocationArtifactByteLength,
    evaluation: {
      source_pcm_sha256: assistantSha256,
      source_pcm_byte_length: assistantPcm.byteLength,
      evaluator_contract_sha256: sha256Hex("fixture-evaluator-contract"),
      evaluator_build_sha256: "7".repeat(64),
      calibration_sha256: sha256Hex("fixture-evaluator-calibration"),
      transcript_sha256: assistantConversationTranscriptSha256,
      semantic_result_sha256: listenerRepairProjection.semantic_result_sha256,
      semantic_artifact_cas_sha256:
        sha256Hex(`fixture-semantic-artifact:${extra.episode_id}:${extra.opportunity_id}:${playbackKind}`),
      signed_invocation_receipt_sha256:
        sha256Hex(`fixture-evaluator-invocation:${extra.episode_id}:${extra.opportunity_id}:${playbackKind}`),
      signed_invocation_artifact_cas_sha256:
        signedInvocationArtifactCasSha256,
      signed_invocation_artifact_byte_length:
        signedInvocationArtifactByteLength,
      repair_projection: listenerRepairProjection,
    },
    listener_manifest_sha256: "4".repeat(64),
  };
  const listenerEvidenceSha256 = domainHash(
    LISTENER_EVIDENCE_DOMAIN,
    listenerBody,
  );
  const listenerReference = {
    schema_version: 1 as const,
    retention_version: "lc4-dev-replay-evidence-v1" as const,
    kind: "listener_evidence" as const,
    evidence_sha256: listenerEvidenceSha256,
    byte_length: Buffer.byteLength(
      `${LISTENER_EVIDENCE_DOMAIN}${canonicalJson(listenerBody)}`,
    ),
    content_encoding: "domain-prefixed-canonical-json" as const,
    domain_prefix: LISTENER_EVIDENCE_DOMAIN as typeof LISTENER_EVIDENCE_DOMAIN,
  };
  const projection = {
    ...extra,
    schema_version: 2,
    adapter_version: LC4_PRODUCTION_PROVIDER_ADAPTER_VERSION,
    run_id: extra.episode_id,
    segment_ordinal: Math.ceil(opportunityOrdinal / 20),
    playback_kind: playbackKind,
    response_control_kind: extra.arm === "hacc" ? "hacc_response_plan" : "native_context",
    response_plan_sha256: responsePlanSha256,
    terminal_response_plan_sha256: responsePlanSha256
      ?? sha256Hex(
        `fixture-native-response-control:${extra.episode_id}:${extra.opportunity_id}:${playbackKind}`,
      ),
    caller_pcm_sha256: sha256Hex(callerPcm),
    caller_pcm_byte_length: callerPcm.byteLength,
    requested_runtime_identity: {
      provider: extra.provider,
      model: extra.model,
      voice: profile.voice,
    },
    effective_runtime_identity: {
      provider: extra.provider,
      model: extra.model,
      voice: profile.voice,
    },
    input_audio_delivery: {
      frame_byte_length: profile.input_sample_rate_hz
        * 2
        * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs
        / 1_000,
      chunk_count: inputFrames.length,
      total_byte_length: callerPcm.byteLength,
      tail_byte_length: inputFrames.at(-1)!.byteLength,
      last_scheduled_offset_ms:
        (inputFrames.length - 1) * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs,
      media_duration_ms:
        callerPcm.byteLength / 2 / profile.input_sample_rate_hz * 1_000,
      chunks: inputFrames.map((frame, index) => ({
        chunk_index: index + 1,
        byte_length: frame.byteLength,
        scheduled_offset_ms:
          index * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs,
        appended_at_offset_ms:
          index * LC4_DEV_AUDIO_DELIVERY_PROFILE.chunkMs,
      })),
      profile_sha256: LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
      pcm_sha256: sha256Hex(callerPcm),
    },
    output_capture: outputCapture,
    transport_mode: extra.provider === "xai" ? profile.transport_mode : "manual_commit",
    transport_purpose: extra.provider === "xai" ? profile.transport_purpose : null,
    transport_profile_sha256: profile.transport_profile_sha256 ?? profile.provider_profile_sha256,
    transport_parity_sha256: extra.provider === "xai"
      ? sha256Hex("fixture-xai-manual-parity")
      : profile.provider_profile_sha256,
    tool_frontier_sha256: sha256Hex("fixture-tool-frontier"),
    server_vad_setting_sha256: null,
    server_vad_transport_disclosure_sha256: null,
    server_vad_transport_suffix: null,
    per_turn_session_update_observation_sha256: null,
    per_turn_session_ack_observation_sha256: null,
    xai_manual_turn_causality: manualCausalityBody === null ? null : {
      ...manualCausalityBody,
      causality_sha256: domainHash(
        XAI_MANUAL_CAUSALITY_DOMAIN,
        manualCausalityBody,
      ),
    },
    operation_order: operationOrder,
    wire_observations: wireObservations,
    wire_observation_set_sha256: wireObservationSetSha256,
    assistant_conversation_transcript_sha256:
      assistantConversationTranscriptSha256,
    assistant_conversation_transcript_source:
      "listener_exact_captured_pcm_asr",
    dev_listener_result: {
      listener_evidence_sha256: listenerEvidenceSha256,
      repair_projection: listenerRepairProjection,
      playback_authority_receipt_sha256:
        playbackAuthorityReceiptSha256,
      listener_evidence: listenerReference,
    },
    caller_branch_decision_sha256: decision?.decision_sha256 ?? null,
    caller_branch_authority: decision ? {
      decision_sha256: decision.decision_sha256,
      decision_evidence_sha256: callerBranchBinding!.decision_evidence.evidence_sha256,
      matrix_artifact_sha256: decision.matrix_artifact_sha256,
      source_id: decision.source_id,
      source_text_sha256: decision.source_text_sha256,
      prior_outcome: decision.prior_outcome,
      prior_receipt_sha256: decision.prior_receipt_sha256,
      branch_intent: decision.branch_intent,
      reconciliation_audio_selected: decision.reconciliation_audio_selected,
    } : null,
  } as unknown as Record<string, JsonValue>;
  providerProjectionListenerLineage.set(projection, {
    body: listenerBody,
    reference: listenerReference,
    repair_projection: listenerRepairProjection,
    playback_authority_receipt_sha256: playbackAuthorityReceiptSha256,
  });
  return projection;
}

async function retainProviderListenerEvidence(
  evidence: Lc4DevReplayEvidenceStore,
  sourceProjection: Record<string, JsonValue>,
) {
  const lineage = providerProjectionListenerLineage.get(sourceProjection);
  if (!lineage) {
    throw new Error("provider projection fixture lacks listener lineage metadata");
  }
  const listenerEvidence = await evidence.retainJson({
    kind: "listener_evidence",
    body: lineage.body as unknown as JsonValue,
    domain_prefix: LISTENER_EVIDENCE_DOMAIN,
    expected_evidence_sha256: lineage.reference.evidence_sha256,
  });
  if (canonicalJson(listenerEvidence) !== canonicalJson(lineage.reference)) {
    throw new Error("retained listener fixture differs from its precomputed exact reference");
  }
  return { listenerEvidence, lineage };
}

function renderedPcm(sampleRate: 16_000 | 24_000 | 48_000, seed: number): Uint8Array {
  const samples = Math.floor(sampleRate * 0.1);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * 2, Math.round(Math.sin((index + seed) / 7) * 7_000), true);
  }
  return bytes;
}

const repairAudioRenderer: Lc4DevAudioRenderer = Object.freeze({
  identity: Object.freeze({
    renderer: "injected-test-renderer",
    identity_sha256: "a".repeat(64),
    toolchain: null,
    voice: LC4_DEV_PINNED_VOICE,
    normalization: "ffmpeg-loudnorm-I-20-LRA-7-TP-3",
  }),
  assertReady() {},
  assertUnchanged() {},
  async render({ sourceTextSha256 }) {
    const seed = Number.parseInt(sourceTextSha256.slice(0, 4), 16);
    return {
      master48k: renderedPcm(48_000, seed),
      pcm16k: renderedPcm(16_000, seed),
      pcm24k: renderedPcm(24_000, seed),
    };
  },
});

function noRepairDependencies(): Lc4DevLiveRunnerDependencies["repair"] {
  const controller = {
    async decide({ episode, opportunity, control_receipt }: Parameters<Lc4DevLiveRunnerDependencies["repair"]["openai"]["decide"]>[0]) {
      const decision = {
        decision_sha256: sha256Hex(`decision:${episode.episode_id}:${opportunity.id}`),
        selection: null,
      };
      const receiptBody = {
        canonical_control_receipt_sha256: control_receipt.control_receipt_sha256,
        decision,
      };
      return {
        receipt: {
          ...receiptBody,
          decision_receipt_sha256: sha256Hex(`harshas-amazing-call-center/lc4-dev-repair-decision-receipt/v1\n${canonicalJson(receiptBody)}`),
        },
        playback: null,
      } as Awaited<ReturnType<Lc4DevLiveRunnerDependencies["repair"]["openai"]["decide"]>>;
    },
    complete() { throw new Error("no-repair fixture cannot complete repair playback"); },
  } as unknown as Lc4DevLiveRunnerDependencies["repair"]["openai"];
  return { openai: controller, gemini: controller, xai: controller };
}

function qualificationFixture() {
  const planAuthority = generateKeyPairSync("ed25519");
  const terminalAuthority = generateKeyPairSync("ed25519");
  const signArtifact = <Body,>(input: Readonly<{
    body: Body;
    privateKey: typeof planAuthority.privateKey;
    publicKey: typeof planAuthority.publicKey;
    signingDomain: string;
    artifactDomain: string;
  }>) => {
    const publicKey = input.publicKey.export({ type: "spki", format: "der" });
    const unsigned = {
      body: input.body,
      authority_public_key_spki_base64: publicKey.toString("base64"),
      authority_public_key_fingerprint_sha256: sha256Hex(publicKey),
      signature_algorithm: "Ed25519" as const,
      signature_base64: sign(null, Buffer.from(`${input.signingDomain}${canonicalJson(input.body)}`), input.privateKey).toString("base64"),
    };
    return {
      ...unsigned,
      artifact_sha256: sha256Hex(`${input.artifactDomain}${canonicalJson(unsigned)}`),
    };
  };

  const setupTargets = createLc4QualificationV3Targets();
  const paidTargets = setupTargets.map((target) => ({
    ...target,
    configuration: {
      ...target.configuration,
      initialConversationHistoryHydrationRequired: true as const,
    },
  }));
  const source = {
    source_commit: "b".repeat(40),
    source_tree_oid: "c".repeat(40),
    source_tree_sha256: "d".repeat(64),
    worktree_clean: true as const,
  };
  const renditions = Object.fromEntries(setupTargets.map((target, index) => {
    const sampleRate = target.configuration.inputAudioFormat.sampleRateHz;
    const byteLength = sampleRate * 12 / 10 * 2;
    const audioSha256 = sha256Hex(`qualification-v3-audio:${target.provider}`);
    return [target.provider, {
      path: `cas/${target.provider}-${index}.pcm`,
      sha256: audioSha256,
      cas_sha256: sha256Hex(`qualification-v3-cas:${target.provider}`),
      cas_receipt_sha256: sha256Hex(`qualification-v3-cas-receipt:${target.provider}`),
      byte_length: byteLength,
      sample_rate_hz: sampleRate,
      channels: 1 as const,
      encoding: "pcm16le" as const,
      duration_ms: 1_200,
    }];
  })) as Record<"openai" | "gemini" | "xai", {
    path: string; sha256: string; cas_sha256: string; cas_receipt_sha256: string;
    byte_length: number; sample_rate_hz: 16_000 | 24_000; channels: 1; encoding: "pcm16le"; duration_ms: number;
  }>;
  const audioFixtureBody = {
    schema_version: 1 as const,
    fixture_version: LC4_S2S_AUDIO_FIXTURE_VERSION,
    source_text_sha256: LC4_S2S_SOURCE_TEXT_SHA256,
    voice: LC4_S2S_VOICE,
    voice_sha256: LC4_S2S_VOICE_SHA256,
    tool_schema_sha256: LC4_S2S_TOOL_SCHEMA_SHA256,
    base_fixture_manifest_sha256: sha256Hex("qualification-v3-base-fixture"),
    toolchain_sha256: sha256Hex("qualification-v3-toolchain"),
    renderer_identity_sha256: sha256Hex("qualification-v3-renderer"),
    provider_renditions: renditions,
  };
  const audioFixture = {
    ...audioFixtureBody,
    artifact_sha256: sha256Hex(`harshas-amazing-call-center/lc4-s2s-spoken-fixture-artifact/v1\n${canonicalJson(audioFixtureBody)}`),
  };
  const deliveryProfileSha256 = trialAudioDeliveryProfileHash(DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE);
  const credentialIdentities = setupTargets.map((target, index) => ({
    provider: target.provider,
    credential_sha256: String(index + 1).repeat(64),
  }));
  const credentialSetSha256 = sha256Hex(`harshas-amazing-call-center/provider-credential-set/v1\n${canonicalJson(credentialIdentities)}`);
  const plannedTargets = paidTargets.map((target) => {
    const audio = renditions[target.provider];
    return {
      provider: target.provider,
      model: target.model,
      sample_rate_hz: audio.sample_rate_hz,
      caller_audio_bytes: audio.byte_length,
      caller_audio_sha256: audio.sha256,
      caller_audio_cas_sha256: audio.cas_sha256,
      caller_audio_duration_ms: audio.duration_ms,
      gateway_schema_sha256: LC4_S2S_TOOL_SCHEMA_SHA256,
      voice_sha256: LC4_S2S_VOICE_SHA256,
      compact_control_sha256: LC4_S2S_COMPACT_CONTROL_SHA256,
      packetizer_sha256: LC4_S2S_PACKETIZER_SHA256,
      audio_delivery_profile_sha256: deliveryProfileSha256,
      qualification_turn_boundary: target.provider === "xai"
        ? "provider_native_server_vad" as const
        : target.provider === "gemini"
          ? "provider_activity_markers" as const
          : "manual_commit" as const,
      production_session_payload_sha256: target.provider === "gemini"
        ? null
        : target.provider === "xai"
          ? productionSessionPayloadParitySha256(
            "xai",
            target.configuration,
            "provider_native_server_vad",
          )
          : productionSessionPayloadParitySha256("openai", target.configuration),
      xai_transport_parity_sha256: target.provider === "xai"
        ? xaiServerVadTransportParitySha256(
            withXaiServerVadPcmSession(productionOpenAiCompatibleSessionUpdate(
              "xai",
              target.configuration,
              "provider_native_server_vad",
            )),
            target.model,
          )
        : null,
      history_hydration_required: true as const,
      setup_sessions: 1 as const,
      paid_sessions: 1 as const,
      generation_phases: 2 as const,
      tool_roundtrips: 1 as const,
    };
  });
  const unsignedPlanBody = {
    schema_version: 3 as const,
    runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
    protocol_id: "HACC-LC4-v1" as const,
    plan_id: "lc4-dev-test-qualification-v3",
    prepared_at: "2026-07-21T20:00:00.000Z",
    source,
    provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    setup_configuration_matrix_sha256: providerQualificationMatrixSha256(setupTargets),
    paid_configuration_matrix_sha256: providerQualificationMatrixSha256(paidTargets),
    history_probe_sha256: LC4_S2S_HISTORY_PROBE_SHA256,
    history_provider_visible_sha256: LC4_S2S_HISTORY_PROVIDER_VISIBLE_SHA256,
    history_source_binding_sha256: LC4_S2S_HISTORY_SOURCE_BINDING_SHA256,
    credential_set_sha256: credentialSetSha256,
    credential_identities: credentialIdentities,
    audio_fixture: audioFixture,
    control_size_diagnostic: lc4S2sControlSizeDiagnostic(),
    targets: plannedTargets,
    execution_scope: "gate_a_setup_acceptance_then_non_generating_history_hydration_then_gate_b_spoken_tool_roundtrip_gate_c_diagnostic_only" as const,
    maximum_total_micro_usd: 3_000_000 as const,
    maximum_provider_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
    maximum_paid_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
    maximum_generation_phases: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
    maximum_tool_roundtrips: LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
    paid_retry_allowed: false as const,
    provider_calls_authorized: false as const,
  };
  const planBody = {
    ...unsignedPlanBody,
    plan_sha256: sha256Hex(`harshas-amazing-call-center/lc4-qualification-plan/v6\n${canonicalJson(unsignedPlanBody)}`),
  };
  const plan = signArtifact({
    body: planBody,
    privateKey: planAuthority.privateKey,
    publicKey: planAuthority.publicKey,
    signingDomain: "harshas-amazing-call-center/lc4-qualification-plan/v6\n",
    artifactDomain: "harshas-amazing-call-center/lc4-qualification-plan-artifact/v6\n",
  }) as Lc4QualificationV3PlanArtifact;
  const terminalPublicKey = terminalAuthority.publicKey.export({ type: "spki", format: "der" });
  const authorizationBody = {
    schema_version: 1 as const,
    authorization_version: LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION,
    authorization_id: "lc4-dev-qualification-v3-attempt",
    authorization_nonce_sha256: sha256Hex("qualification-v3-authorization-nonce"),
    plan_artifact_sha256: plan.artifact_sha256,
    plan_sha256: plan.body.plan_sha256,
    source_commit: source.source_commit,
    source_tree_sha256: source.source_tree_sha256,
    credential_set_sha256: unsignedPlanBody.credential_set_sha256,
    terminal_public_key_spki_base64: terminalPublicKey.toString("base64"),
    terminal_public_key_fingerprint_sha256: sha256Hex(terminalPublicKey),
    maximum_total_micro_usd: 3_000_000 as const,
    maximum_provider_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
    maximum_paid_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
    maximum_generation_phases: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
    maximum_tool_roundtrips: LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
    paid_retry_allowed: false as const,
    not_before: "2026-07-21T19:00:00.000Z",
    expires_at: "2026-07-21T22:00:00.000Z",
  };
  const authorization = signArtifact({
    body: authorizationBody,
    privateKey: planAuthority.privateKey,
    publicKey: planAuthority.publicKey,
    signingDomain: "harshas-amazing-call-center/lc4-qualification-authorization/v5\n",
    artifactDomain: "harshas-amazing-call-center/lc4-qualification-authorization-artifact/v5\n",
  }) as Lc4QualificationV3AuthorizationArtifact;

  const setupResults: ProviderQualificationArtifact["results"] = Object.freeze(setupTargets.map((target) => {
    let predecessor: string | null = null;
    const wire = (direction: "outbound" | "inbound", sequence: number, wireType: string) => {
      const projection = Object.freeze({ direction, wireType });
      const core = Object.freeze({
        schemaVersion: 1 as const,
        provider: target.provider,
        direction,
        connectionEpoch: 1,
        sequence,
        observedAtMs: Date.parse("2026-07-21T20:01:00.000Z") + sequence,
        observedAtMonotonicMs: sequence,
        wireType,
        payloadSha256: sha256Hex(`setup-wire:${target.provider}:${direction}`),
        payloadBytes: 1,
        projectionSha256: realtimeWireProjectionSha256(projection),
        previousObservationSha256: predecessor,
        identities: Object.freeze({}),
        projection,
      });
      const observation = Object.freeze({ ...core, observationSha256: realtimeWireObservationSha256(core) });
      predecessor = observation.observationSha256;
      return observation;
    };
    const requestWireType = target.provider === "gemini" ? "setup" as const : "session.update" as const;
    const acknowledgementWireType = target.provider === "gemini" ? "setupComplete" as const : "session.updated" as const;
    const observations = Object.freeze(target.provider === "xai"
      ? [
          wire("outbound", 1, requestWireType),
          wire("inbound", 2, "session.created"),
          wire("inbound", 3, acknowledgementWireType),
        ]
      : [
          wire("outbound", 1, requestWireType),
          wire("inbound", 2, acknowledgementWireType),
        ]);
    const request = observations.find((observation) => observation.direction === "outbound")!;
    const acknowledgement = observations.find((observation) => (
      observation.direction === "inbound" && observation.wireType === acknowledgementWireType
    ))!;
    return ({
    provider: target.provider,
    model: target.model,
    requestedConfigurationSha256: sha256Hex(`harshas-amazing-call-center/provider-session-configuration/v1\n${canonicalJson({
      provider: target.provider,
      model: target.model,
      configuration: target.configuration,
    })}`),
    attemptedAt: "2026-07-21T20:01:00.000Z",
    completedAt: "2026-07-21T20:01:01.000Z",
    status: "passed" as const,
    code: "configuration_echo_verified" as const,
    acknowledgementMode: "exact_provider_echo" as const,
    acknowledgementSha256: sha256Hex(`qualification-v3-ack:${target.provider}`),
    toolSchemaVerification: "verified_by_provider_echo" as const,
    turnBoundaryVerification: target.provider === "gemini" ? "not_applicable" as const : "verified_by_provider_echo" as const,
    setupWireEvidence: Object.freeze({
      provider: target.provider,
      connectionEpoch: 1,
      requestWireType,
      acknowledgementWireType,
      requestObservationSha256: request.observationSha256,
      acknowledgementObservationSha256: acknowledgement.observationSha256,
      ...(target.provider === "xai" ? {
        sessionIdentity: {
          createdSessionIdSha256: null,
          updatedSessionIdSha256: null,
          status: "unverifiable" as const,
        },
      } : {}),
      observations,
    }),
  });
  }).sort((left, right) => left.provider.localeCompare(right.provider)));
  const setupCredentialSetSha256 = sha256Hex(
    `harshas-amazing-call-center/provider-credential-set/v1\n${canonicalJson(
      credentialIdentities.map(({ provider, credential_sha256 }) => ({
        provider,
        credentialSha256: credential_sha256,
      })),
    )}`,
  );
  const setupBody = {
    schemaVersion: 3 as const,
    qualificationId: "lc4-dev-v3-setup",
    protocolId: "HACC-LC4-v1",
    planSha256: plan.body.plan_sha256,
    sourceCommit: source.source_commit,
    configurationMatrixSha256: unsignedPlanBody.setup_configuration_matrix_sha256,
    credentialSetSha256: setupCredentialSetSha256,
    probeScope: "session_handshake_and_configuration_acknowledgement_no_audio_no_generation" as const,
    attemptedAt: "2026-07-21T20:01:00.000Z",
    completedAt: "2026-07-21T20:01:03.000Z",
    status: "passed" as const,
    results: setupResults,
  };
  const setupQualification: ProviderQualificationArtifact = {
    ...setupBody,
    artifactSha256: sha256Hex(`harshas-amazing-call-center/provider-qualification/v3\n${canonicalJson(setupBody)}`),
  };
  const budgetBody = {
    schema_version: 1 as const,
    budget_version: LC4_QUALIFICATION_BUDGET_VERSION,
    ledger_id: "lc4-dev-v3-budget-ledger",
    reservation_id: "lc4-dev-v3-budget-reservation",
    binding_sha256: sha256Hex("qualification-v3-budget-binding"),
    usage_event_count: 3,
    usage_evidence_sha256: sha256Hex("qualification-v3-budget-usage"),
    terminal_outcome: "completed" as const,
    maximum_micro_usd: 3_000_000 as const,
    conservative_settled_micro_usd: 3_000_000,
    final_head_sha256: sha256Hex("qualification-v3-budget-final-head"),
  };
  const budgetEvidence: Lc4QualificationBudgetEvidence = {
    ...budgetBody,
    evidence_sha256: sha256Hex(`harshas-amazing-call-center/lc4-qualification-budget-evidence/v3\n${canonicalJson(budgetBody)}`),
  };
  const spokenFiles = new Map(plannedTargets.flatMap((target) => ([
    [`${target.provider}-spoken-roundtrip.json`, Buffer.from(`summary:${target.provider}\n`)],
    [`${target.provider}-spoken-roundtrip-wire.jsonl`, Buffer.from(`wire:${target.provider}\n`)],
    [`${target.provider}-spoken-roundtrip-usage.jsonl`, Buffer.from(`usage:${target.provider}\n`)],
  ] as const)));
  const spokenGateEvidence = plannedTargets.map((target) => ({
    provider: target.provider,
    model: target.model,
    evidence_sha256: sha256Hex(`qualification-v3-spoken-evidence:${target.provider}`),
    summary_file_sha256: sha256Hex(spokenFiles.get(`${target.provider}-spoken-roundtrip.json`)!),
    wire_file_sha256: sha256Hex(spokenFiles.get(`${target.provider}-spoken-roundtrip-wire.jsonl`)!),
    usage_file_sha256: sha256Hex(spokenFiles.get(`${target.provider}-spoken-roundtrip-usage.jsonl`)!),
    public_execution_sha256: sha256Hex(`qualification-v3-public-execution:${target.provider}`),
    replay_sha256: sha256Hex(`qualification-v3-replay:${target.provider}`),
    wire_observation_count: 12,
    usage_event_count: 1,
    caller_audio_bytes: target.caller_audio_bytes,
    caller_audio_sha256: target.caller_audio_sha256,
    delivery_profile_sha256: target.audio_delivery_profile_sha256,
    input_audio_evidence: {
      observation_sha256s: [sha256Hex(`input-observation:${target.provider}`)],
      observation_list_sha256: sha256Hex(`input-observation-list:${target.provider}`),
      chunk_sha256s: [sha256Hex(`input-chunk:${target.provider}`)],
      chunk_list_sha256: sha256Hex(`input-chunk-list:${target.provider}`),
      audio_sha256: target.caller_audio_sha256,
      delivery_profile_sha256: target.audio_delivery_profile_sha256,
      packetizer_sha256: target.packetizer_sha256,
      audio_bytes: target.caller_audio_bytes,
      chunk_count: 1,
      frame_bytes: target.caller_audio_bytes,
      tail_bytes: 0,
      sample_rate_hz: target.sample_rate_hz,
    },
    output_audio_evidence: {
      observation_sha256s: [sha256Hex(`output-observation:${target.provider}`)],
      observation_list_sha256: sha256Hex(`output-observation-list:${target.provider}`),
      content_sha256: sha256Hex(`output-audio:${target.provider}`),
      audio_bytes: 3_200,
      chunk_count: 1,
      sample_rate_hz: target.sample_rate_hz,
      response_id_sha256: sha256Hex(`output-response:${target.provider}`),
    },
    turn_boundary_mode: target.provider === "xai"
      ? "provider_native_server_vad" as const
      : target.provider === "gemini"
        ? "provider_activity_markers" as const
        : "manual_commit" as const,
    server_vad_setting_sha256: target.provider === "xai" ? LC4_XAI_SERVER_VAD_SETTING_SHA256 : null,
    transport_parity_sha256: target.xai_transport_parity_sha256,
    tool_frontier_sha256: sha256Hex(`tool-frontier:${target.provider}`),
    per_turn_session_update_observation_sha256: target.provider === "xai"
      ? sha256Hex("xai-per-turn-update") : null,
    per_turn_session_ack_observation_sha256: target.provider === "xai"
      ? sha256Hex("xai-per-turn-ack") : null,
    server_vad_speech_start_observation_sha256: target.provider === "xai"
      ? sha256Hex("xai-speech-start") : null,
    server_vad_speech_stop_observation_sha256: target.provider === "xai"
      ? sha256Hex("xai-speech-stop") : null,
    server_vad_auto_commit_observation_sha256: target.provider === "xai"
      ? sha256Hex("xai-auto-commit") : null,
    server_vad_auto_response_observation_sha256: target.provider === "xai"
      ? sha256Hex("xai-auto-response") : null,
    provider_tool_call_evidence_sha256: sha256Hex(`provider-tool-call:${target.provider}`),
    tool_result_evidence_sha256: sha256Hex(`tool-result:${target.provider}`),
    tool_call_observed: true as const,
    tool_result_wire_observed: true as const,
    post_tool_terminal_observed: true as const,
    post_tool_usage_observed: true as const,
  }));
  const xaiSpoken = spokenGateEvidence[2]!;
  const xaiGateBBindingBody = {
    schema_version: 1 as const,
    provider: "xai" as const,
    model: plannedTargets[2]!.model,
    source_commit: source.source_commit,
    plan_sha256: plan.body.plan_sha256,
    provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    gate_a_risk_sha256: sha256Hex("qualification-v3-xai-risk"),
    production_session_payload_sha256: plannedTargets[2]!.production_session_payload_sha256!,
    gate_b_execution_sha256: xaiSpoken.evidence_sha256,
    connection_epoch: 1,
    per_turn_session_update_observation_sha256: xaiSpoken.per_turn_session_update_observation_sha256!,
    per_turn_session_ack_observation_sha256: xaiSpoken.per_turn_session_ack_observation_sha256!,
    transport_parity_sha256: xaiSpoken.transport_parity_sha256!,
    tool_frontier_sha256: xaiSpoken.tool_frontier_sha256,
    exact_gateway_call_evidence_sha256: xaiSpoken.provider_tool_call_evidence_sha256,
    matching_gateway_result_evidence_sha256: xaiSpoken.tool_result_evidence_sha256,
    public_execution_sha256: xaiSpoken.public_execution_sha256,
    replay_sha256: xaiSpoken.replay_sha256,
    dynamic_update_provider_echo: "verified" as const,
    ordered_vad_verified: true as const,
    exact_gateway_call_verified: true as const,
    matching_gateway_result_verified: true as const,
    sole_continuation_terminal_usage_verified: true as const,
  };
  const xaiGateBBinding = {
    ...xaiGateBBindingBody,
    binding_sha256: sha256Hex(
      `harshas-amazing-call-center/xai-server-vad-gate-b-binding/v1\n${canonicalJson(xaiGateBBindingBody)}`,
    ),
  };
  const replaySha256s = spokenGateEvidence.map((evidence) => evidence.replay_sha256);
  const packageBindings = {
    attempt_id: authorization.body.authorization_id,
    source_commit: source.source_commit,
    source_tree_oid: source.source_tree_oid,
    source_tree_sha256: source.source_tree_sha256,
    plan_artifact_sha256: plan.artifact_sha256,
    plan_sha256: plan.body.plan_sha256,
    authorization_artifact_sha256: authorization.artifact_sha256,
    setup_qualification_artifact_sha256: setupQualification.artifactSha256,
    budget_evidence_sha256: budgetEvidence.evidence_sha256,
    budget_final_head_sha256: budgetEvidence.final_head_sha256,
    provider_session_count: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
    paid_session_count: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
    generation_phase_count: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
    tool_roundtrip_count: LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
    retry_count: 0,
    reconnect_count: 0,
    replay_artifact_sha256: sha256Hex(
      `harshas-amazing-call-center/lc4-qualification-replay-aggregate/v1\n${canonicalJson(replaySha256s)}`,
    ),
    replay_event_count: setupResults.reduce(
      (total, result) => total + (result.setupWireEvidence?.observations.length ?? 0),
      spokenGateEvidence.reduce((total, evidence) => total + evidence.wire_observation_count, 0),
    ),
    replay_chain_head_sha256: sha256Hex("qualification-v3-replay-chain-head"),
  };
  const payloadFiles: Lc4QualificationPackageFile[] = [
    { path: "authorization.json", bytes: Buffer.from(`${canonicalJson(authorization)}\n`) },
    { path: "setup-acceptance.json", bytes: Buffer.from(`${canonicalJson(setupQualification)}\n`) },
    { path: "budget-settlement.json", bytes: Buffer.from(`${canonicalJson(budgetEvidence)}\n`) },
    { path: "xai-server-vad-gate-b-binding.json", bytes: Buffer.from(`${canonicalJson(xaiGateBBinding)}\n`) },
    ...[...spokenFiles].map(([path, bytes]) => ({ path, bytes })),
  ];
  const payloadManifest = createLc4QualificationPayloadManifestV5({
    files: [...payloadFiles, { path: "terminal.json", bytes: Buffer.alloc(0) }],
    terminalPath: "terminal.json",
    envelopePath: "qualification-package-envelope.json",
  });
  const unsignedTerminalBody = {
    schema_version: 4 as const,
    runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
    terminal_version: "HACC-LC4-QUALIFICATION-TERMINAL-v7" as const,
    attempt_id: "lc4-dev-qualification-v3-attempt",
    plan_artifact_sha256: plan.artifact_sha256,
    plan_sha256: plan.body.plan_sha256,
    authorization_artifact_sha256: authorization.artifact_sha256,
    source_commit: source.source_commit,
    source_tree_sha256: source.source_tree_sha256,
    attempted_at: "2026-07-21T20:01:00.000Z",
    completed_at: "2026-07-21T20:01:03.000Z",
    status: "passed" as const,
    primary_failure_class: null,
    setup_qualification_artifact_sha256: setupQualification.artifactSha256,
    control_size_diagnostic_sha256: unsignedPlanBody.control_size_diagnostic.diagnostic_sha256,
    roundtrip_evidence_sha256: spokenGateEvidence.map((evidence) => evidence.evidence_sha256),
    roundtrip_public_execution_sha256: spokenGateEvidence.map((evidence) => evidence.public_execution_sha256),
    roundtrip_replay_sha256: replaySha256s,
    budget_evidence_sha256: budgetEvidence.evidence_sha256,
    budget_final_head_sha256: budgetEvidence.final_head_sha256,
    payload_root_sha256: payloadManifest.payload_root_sha256,
    package_bindings: packageBindings,
    provider_sessions_opened: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
    paid_sessions_opened: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
    generation_phases_attempted: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
    tool_roundtrips_attempted: LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
    caller_audio_bytes: plannedTargets.reduce((total, target) => total + target.caller_audio_bytes, 0),
    paid_retries_attempted: 0 as const,
    server_vad_qualification: {
      provider: "xai" as const,
      requested_setting_sha256: LC4_XAI_SERVER_VAD_SETTING_SHA256,
      production_session_payload_sha256: plannedTargets[2]!.production_session_payload_sha256!,
      gate_a_classification: "verified_by_provider_echo" as const,
      retained_risk: "none" as const,
      gate_b_required: true,
      gate_b_status: "behaviorally_verified" as const,
      gate_b_evidence_sha256: spokenGateEvidence[2]!.evidence_sha256,
      gate_b_binding_sha256: xaiGateBBinding.binding_sha256,
      gate_a_risk_sha256: sha256Hex("qualification-v3-xai-risk"),
      gate_a_connection_epoch: 1,
      gate_b_connection_epoch: 1,
      exact_setting_verified: true,
      operational_vad_verified: true,
      claims: {
        operational_gateway: "verified" as const,
        operational_server_vad: "verified" as const,
        exact_gateway_name_and_arguments: "verified" as const,
        matching_gateway_result: "verified" as const,
        sole_post_tool_continuation_terminal_usage: "verified" as const,
        full_gateway_schema: "unverifiable" as const,
        gateway_description: "unverifiable" as const,
        post_update_voice: "unverifiable" as const,
        input_transcription: "not_requested" as const,
        idle_timeout: "documented_default_not_independently_verified" as const,
        exact_vad_parameters: "verified_by_provider_echo" as const,
        created_to_updated_session_identity: "unverifiable" as const,
        dynamic_update_configuration: "verified_by_provider_echo" as const,
      },
      benchmark_ready: true,
    },
    results: plannedTargets.map((target, index) => ({
      provider: target.provider,
      model: target.model,
      status: "passed" as const,
      failure_class: "none",
      caller_audio_bytes: target.caller_audio_bytes,
      wire_observation_count: spokenGateEvidence[index]!.wire_observation_count,
      usage_event_count: spokenGateEvidence[index]!.usage_event_count,
      evidence_sha256: spokenGateEvidence[index]!.evidence_sha256,
    })),
  };
  const terminalBody = {
    ...unsignedTerminalBody,
    terminal_sha256: sha256Hex(`harshas-amazing-call-center/lc4-qualification-terminal/v7\n${canonicalJson(unsignedTerminalBody)}`),
  };
  const terminal = signArtifact({
    body: terminalBody,
    privateKey: terminalAuthority.privateKey,
    publicKey: terminalAuthority.publicKey,
    signingDomain: "harshas-amazing-call-center/lc4-qualification-terminal/v7\n",
    artifactDomain: "harshas-amazing-call-center/lc4-qualification-terminal-artifact/v7\n",
  }) as Lc4QualificationV3TerminalArtifact;
  const report = {
    schema_version: 1 as const,
    runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
    plan_artifact_sha256: plan.artifact_sha256,
    source_commit: source.source_commit,
    invoked_attempts: 1,
    refused_attempts: 0,
    stranded_invocations: 0,
    complete_attempts: 1,
    partial_attempts: 0,
    gate_c_qualification_gate: false as const,
    maximum_total_usd: 3 as const,
    maximum_provider_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
    maximum_paid_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
    maximum_generation_phases: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
    paid_retry_allowed: false as const,
    latest: terminal.body,
  };
  const packageManifest = createSignedLc4QualificationPackageEnvelopeV5({
    files: [
      ...payloadFiles,
      { path: "terminal.json", bytes: Buffer.from(`${canonicalJson(terminal)}\n`) },
    ],
    terminalClaims: {
      terminal_artifact_sha256: terminal.artifact_sha256,
      payload_root_sha256: payloadManifest.payload_root_sha256,
      bindings: packageBindings,
    },
    terminalPath: "terminal.json",
    envelopePath: "qualification-package-envelope.json",
    authorityPrivateKeyPem: terminalAuthority.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  });
  return createLc4DevRetainedQualificationReceipt({
    plan,
    authorization,
    terminal,
    report,
    package_manifest: packageManifest,
    setup_qualification: setupQualification,
    budget_evidence: budgetEvidence,
    spoken_gate_evidence: spokenGateEvidence,
    xai_server_vad_gate_b_binding: xaiGateBBinding,
    qualification_trust_root_sha256: plan.authority_public_key_fingerprint_sha256,
  });
}

async function gateDReceiptFixture(
  prepare: ReturnType<typeof createLc4DevLivePrepareArtifact>,
): Promise<Lc4XaiFiniteManualGateDReceipt> {
  const authority = createLc4XaiFiniteManualGateDSigner(
    gateDAuthorityKeys.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
  );
  const terminalSigner = createLc4XaiFiniteManualGateDSigner(
    gateDTerminalKeys.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
  );
  const plan = createLc4XaiFiniteManualGateDPlan({
    gate_id: "lc4-dev-live-gate-d",
    prepared_at: NOW,
    source_commit: prepare.source_commit,
    source_tree_sha256: prepare.source_tree_sha256,
    harmless_clip_pcm: new Uint8Array([1, 0, 2, 0]),
    signer: authority,
  });
  const authorization = createLc4XaiFiniteManualGateDAuthorization({
    plan,
    plan_trust_root_sha256: authority.public_key_fingerprint_sha256,
    authorization_id: "lc4-dev-live-gate-d-auth",
    authorization_nonce_sha256: sha256Hex("lc4-dev-live-gate-d-nonce"),
    credential_identity_sha256: sha256Hex("synthetic-provider-identity"),
    terminal_signer: terminalSigner,
    not_before: "2026-07-21T21:30:00.000Z",
    expires_at: "2026-07-21T22:30:00.000Z",
    authority_signer: authority,
  });
  const roles = [
    ["outbound", "input_audio_buffer.commit"],
    ["inbound", "input_audio_buffer.committed"],
    ["outbound", "response.create"],
    ["inbound", "response.created"],
    ["inbound", "response.audio.delta"],
    ["inbound", "response.function_call_arguments.done"],
    ["inbound", "response.done"],
    ["outbound", "conversation.item.create"],
    ["outbound", "response.create"],
    ["inbound", "response.created"],
    ["inbound", "response.audio.delta"],
    ["inbound", "response.done"],
  ] as const;
  const rootResponse = lc4XaiManualResponseWireIdentitySha256(
    "fixture-root-response",
  );
  const postResponse = lc4XaiManualResponseWireIdentitySha256(
    "fixture-post-response",
  );
  const callId = sha256Hex("fixture-gateway-call");
  let previous: string | null = null;
  const observations: Lc4SanitizedWireObservation[] = roles.map(
    ([direction, wireType], index) => {
      const sequence = index + 1;
      const observation = sha256Hex(canonicalJson({
        direction,
        wireType,
        sequence,
        previous,
      }));
      const value = Object.freeze({
        provider: "xai" as const,
        direction,
        connection_epoch: 1,
        sequence,
        wire_type: wireType,
        payload_sha256: sha256Hex(`gate-d-payload:${sequence}`),
        payload_bytes: 8,
        projection_sha256: sha256Hex(`gate-d-projection:${sequence}`),
        observation_sha256: observation,
        previous_observation_sha256: previous,
        identity_hashes: {
          ...([4, 5, 6, 7].includes(sequence)
            ? { responseIdSha256: rootResponse }
            : {}),
          ...([10, 11, 12].includes(sequence)
            ? { responseIdSha256: postResponse }
            : {}),
          ...([6, 7, 8].includes(sequence)
            ? { callIdSha256: callId }
            : {}),
        },
      });
      previous = observation;
      return value;
    },
  );
  const causalityBody = Object.freeze({
    schema_version: 1 as const,
    connection_epoch: 1,
    commit_observation_sha256: observations[0]!.observation_sha256,
    commit_sequence: 1,
    commit_ack_observation_sha256: observations[1]!.observation_sha256,
    commit_ack_sequence: 2,
    response_create_observation_sha256: observations[2]!.observation_sha256,
    response_create_sequence: 3,
    response_start_observation_sha256: observations[3]!.observation_sha256,
    response_start_sequence: 4,
    response_id_sha256: rootResponse,
  });
  const evidenceBody = Object.freeze({
    schema_version: 2 as const,
    provider: "xai" as const,
    model: plan.body.model,
    voice: plan.body.voice,
    transport_purpose: "finite_prerecorded_efficacy" as const,
    transport_mode: "manual_commit" as const,
    transport_profile_sha256: plan.body.transport_profile_sha256,
    production_adapter_binding_sha256:
      LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
    caller_pcm_sha256: plan.body.harmless_clip.pcm_sha256,
    caller_pcm_byte_length: plan.body.harmless_clip.pcm_byte_length,
    caller_pcm_appended_sha256: plan.body.harmless_clip.pcm_sha256,
    caller_pcm_appended_byte_length: plan.body.harmless_clip.pcm_byte_length,
    provider_sessions_opened: 1 as const,
    generation_phases: 2 as const,
    capability_gateway_tool_roundtrips: 1 as const,
    retries: 0 as const,
    reconnects: 0 as const,
    fallbacks: 0 as const,
    operation_order: LC4_XAI_FINITE_MANUAL_GATE_D_OPERATION_ORDER,
    manual_turn_causality: Object.freeze({
      ...causalityBody,
      causality_sha256: sha256Hex(
        `harshas-amazing-call-center/lc4-xai-manual-turn-causality/v1\n${canonicalJson(causalityBody)}`,
      ),
    }),
    wire_observations: Object.freeze(observations),
    initial_assistant_pcm_sha256: sha256Hex("fixture-initial-pcm"),
    initial_assistant_pcm_byte_length: 4,
    initial_assistant_pcm_observation_sha256:
      observations[4]!.observation_sha256,
    capability_gateway_tool_call_sha256: sha256Hex("fixture-tool-call"),
    capability_gateway_tool_call_observation_sha256:
      observations[6]!.observation_sha256,
    capability_gateway_tool_result_sha256: sha256Hex("fixture-tool-result"),
    capability_gateway_tool_result_observation_sha256:
      observations[7]!.observation_sha256,
    post_tool_continuation_sha256: sha256Hex("fixture-continuation"),
    post_tool_continuation_observation_sha256:
      observations[8]!.observation_sha256,
    post_tool_response_start_observation_sha256:
      observations[9]!.observation_sha256,
    post_tool_assistant_pcm_sha256: sha256Hex("fixture-post-pcm"),
    post_tool_assistant_pcm_byte_length: 4,
    post_tool_assistant_pcm_observation_sha256:
      observations[10]!.observation_sha256,
    capability_gateway_call_id_sha256: callId,
    post_tool_continuation_origin_response_id_sha256: rootResponse,
    post_tool_response_id_sha256: postResponse,
    terminal_observation_sha256: observations[11]!.observation_sha256,
  });
  const evidence: Lc4XaiFiniteManualGateDExecutionEvidence = Object.freeze({
    ...evidenceBody,
    replay_sha256:
      lc4XaiFiniteManualGateDExecutionReplaySha256(evidenceBody),
  });
  const adapter: Lc4XaiFiniteManualGateDProductionAdapter = Object.freeze({
    [LC4_XAI_GATE_D_PRODUCTION_ADAPTER_CAPABILITY]: true as const,
    kind: "lc4-production-provider-adapter/xai-finite-manual-gate-d-v1",
    production_adapter_binding_sha256:
      LC4_XAI_FINITE_MANUAL_GATE_D_PRODUCTION_BINDING_SHA256,
    execute: async () => evidence,
  });
  const root = await mkdtemp(join(tmpdir(), "hacc-gate-d-fixture-"));
  try {
    return await executeLc4XaiFiniteManualGateD({
      plan,
      authorization,
      terminal_signer: terminalSigner,
      credential_identity_sha256: authorization.body.credential_identity_sha256,
      caller_pcm: new Uint8Array([1, 0, 2, 0]),
      inspected_source: {
        source_commit: prepare.source_commit,
        source_tree_sha256: prepare.source_tree_sha256,
        worktree_clean: true,
      },
      now: new Date(NOW),
      completion_clock: () => new Date(Date.parse(NOW) + 1_000),
      expected_plan_trust_root_sha256:
        authority.public_key_fingerprint_sha256,
      invocation_marker_path: join(root, "invocation.json"),
      construct_production_adapter: () => adapter,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function authorizedPreflight(
  prepare: ReturnType<typeof createLc4DevLivePrepareArtifact>,
  credentialIdentity = "2".repeat(64),
  suppliedGateD?: Lc4XaiFiniteManualGateDReceipt,
) {
  const qualification = qualificationFixture();
  const gateD = suppliedGateD ?? await gateDReceiptFixture(prepare);
  const body = {
    schema_version: 4 as const,
    protocol_id: "HACC-LC4-DEV-v1" as const,
    purpose: "six_public_development_episodes_only" as const,
    execution_id: prepare.execution_id,
    prepare_sha256: prepare.prepare_sha256,
    maximum_total_micro_usd: prepare.maximum_total_micro_usd,
    audio_manifest_sha256: prepare.audio_manifest_sha256,
    qualification_terminal_root_sha256: qualification.terminal_root_sha256,
    qualification_retained_artifact_sha256: qualification.retained_artifact_sha256,
    credential_identity_set_sha256: credentialIdentity,
    control_plane_manifest_sha256: "3".repeat(64),
    listener_evidence_manifest_sha256: "4".repeat(64),
    runtime_config_sha256: "6".repeat(64),
    asr_evaluator_build_sha256: "7".repeat(64),
    asr_evaluator_toolchain_sha256: "9".repeat(64),
    asr_contract: asrContract,
    asr_contract_sha256: asrContractSha256,
    asr_runner_trust: asrRunnerTrust,
    provider_profile_manifest_sha256: prepare.provider_profile_manifest_sha256,
    qualification_transport_scope_sha256: prepare.qualification_transport_scope_sha256,
    qualification_claim_boundary: prepare.qualification_claim_boundary,
    xai_finite_manual_gate_d_receipt_sha256: gateD.receipt_sha256,
    xai_finite_manual_gate_d_plan_authority_trust_root_sha256:
      gateD.plan_authority_trust_root_sha256,
    xai_finite_manual_gate_d_transport_profile_sha256:
      gateD.transport_profile_sha256,
    audio_delivery_profile_sha256: prepare.audio_delivery_profile_sha256,
    audio_packetizer_contract_sha256: prepare.audio_packetizer_contract_sha256,
    audio_execution_contract_sha256: prepare.audio_execution_contract_sha256,
    immutable_ledger_genesis_sha256: "5".repeat(64),
    authorization_nonce_sha256: "8".repeat(64),
    not_before: "2026-07-21T21:00:00.000Z",
    expires_at: "2026-07-22T22:00:00.000Z",
  };
  const { privateKey, publicKey } = branchKeys;
  const key = publicKey.export({ type: "spki", format: "der" });
  const withoutHash = {
    body,
    authority_public_key_spki_base64: key.toString("base64"),
    authority_public_key_fingerprint_sha256: sha256Hex(key),
    signature_algorithm: "Ed25519" as const,
    signature_base64: sign(null, lc4DevLiveAuthorizationSigningBytes(body), privateKey).toString("base64"),
  };
  const authorization = { ...withoutHash, artifact_sha256: lc4DevLiveAuthorizationArtifactSha256(withoutHash) };
  return createLc4DevLivePreflightArtifact({
    prepare,
    checked_at: NOW,
    qualification_gate_sha256: qualification.retained_artifact_sha256,
    qualification,
    xai_finite_manual_gate_d: gateD,
    credential_identity_set_sha256: credentialIdentity,
    control_plane_manifest_sha256: "3".repeat(64),
    listener_evidence_manifest_sha256: "4".repeat(64),
    runtime_config_sha256: "6".repeat(64),
    asr_evaluator_build_sha256: "7".repeat(64),
    asr_evaluator_toolchain_sha256: "9".repeat(64),
    asr_contract: asrContract,
    asr_contract_sha256: asrContractSha256,
    asr_runner_trust: asrRunnerTrust,
    immutable_ledger_genesis_sha256: "5".repeat(64),
    audio_manifest_sha256: prepare.audio_manifest_sha256,
    authorization,
    expected_authority_public_key_fingerprint_sha256: sha256Hex(key),
  });
}

async function fixtures() {
  const corpus = createLc4PublicDevelopmentCorpus();
  const pcm = new Map<string, Uint8Array>();
  const bindings: Lc4DevCallerAudioBinding[] = [];
  for (const provider of ["openai", "gemini", "xai"] as const) {
    for (const opportunity of corpus.opportunities) {
      const bytes = Uint8Array.from([opportunity.index, provider.length, 7, 11]);
      pcm.set(`${provider}:${opportunity.id}`, bytes);
      bindings.push({
        opportunity_id: opportunity.id,
        provider,
        pcm_sha256: sha256Hex(bytes),
        pcm_byte_length: bytes.byteLength,
        sample_rate_hz: LC4_PROVIDER_PROFILE_MANIFEST.providers[provider].input_sample_rate_hz,
        source_text_sha256: opportunity.canonical_caller_text_sha256,
      });
    }
  }
  const prepare = createLc4DevLivePrepareArtifact({
    execution_id: "lc4-dev-live-test",
    created_at: NOW,
    source_commit: "b".repeat(40),
    source_tree_sha256: "c".repeat(64),
    audio_manifest_sha256: "d".repeat(64),
    audio_bindings: bindings,
    xai_finite_manual_gate_d: {
      receipt_sha256: sha256Hex("placeholder-replaced-before-preflight"),
      plan_authority_trust_root_sha256:
        sha256Hex("placeholder-gate-d-authority"),
      transport_profile_sha256:
        LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256,
    },
  });
  const gateD = await gateDReceiptFixture(prepare);
  const prepareWithGateD = createLc4DevLivePrepareArtifact({
    execution_id: prepare.execution_id,
    created_at: prepare.created_at,
    source_commit: prepare.source_commit,
    source_tree_sha256: prepare.source_tree_sha256,
    audio_manifest_sha256: prepare.audio_manifest_sha256,
    audio_bindings: prepare.audio_bindings,
    maximum_total_micro_usd: prepare.maximum_total_micro_usd,
    xai_finite_manual_gate_d: {
      receipt_sha256: gateD.receipt_sha256,
      plan_authority_trust_root_sha256:
        gateD.plan_authority_trust_root_sha256,
      transport_profile_sha256: gateD.transport_profile_sha256,
    },
  });
  const preflight = await authorizedPreflight(prepareWithGateD, undefined, gateD);
  return {
    corpus,
    pcm,
    prepare: prepareWithGateD,
    preflight,
    gateD,
  };
}

function control(arm: "native" | "hacc"): Lc4DevControlReceipt {
  const common = {
    flow_state_sha256: HASH,
    gateway_transcript_head_sha256: HASH,
    tool_world_state_sha256: HASH,
    worker_state_sha256: HASH,
    repair_state_sha256: HASH,
    native_continuity_state_sha256: HASH,
  };
  let response_control: Lc4DevControlReceipt["response_control"];
  if (arm === "native") {
    const instructions = "Continue the public development conversation using only information available so far.";
    response_control = { kind: "native_context", instructions, instructions_sha256: sha256Hex(instructions) };
  } else {
    // The dev adapter owns full HaccResponsePlan validation. This coordinator
    // test uses an opaque sentinel because it verifies lifecycle, not compiler output.
    response_control = { kind: "hacc_response_plan", plan: Object.freeze({}) as HaccResponsePlan };
  }
  const body = { ...common, response_control };
  return {
    ...body,
    control_receipt_sha256: sha256Hex(`harshas-amazing-call-center/lc4-dev-control-receipt/v1\n${canonicalJson(body)}`),
  };
}

function memoryEvidence(): Lc4DevReplayEvidenceStore {
  const objects = new Map<string, Uint8Array>();
  return createLc4DevReplayEvidenceStore({
    async put(bytes) {
      const copy = Uint8Array.from(bytes);
      const artifact = sha256Hex(copy);
      objects.set(artifact, copy);
      return {
        artifact_sha256: artifact,
        byte_length: copy.byteLength,
        receipt_sha256: sha256Hex(`memory-cas:${artifact}:${copy.byteLength}`),
      };
    },
    async get(hash) {
      const bytes = objects.get(hash);
      if (!bytes) throw new Error("missing test replay evidence");
      return Uint8Array.from(bytes);
    },
  });
}

async function testJsonEvidence(
  evidence: Lc4DevReplayEvidenceStore,
  kind: Exclude<Lc4DevReplayArtifactKind, "caller_pcm" | "assistant_pcm" | "repair_pcm">,
  body: Record<string, unknown>,
) {
  return evidence.retainJson({ kind, body: body as never });
}

function callerBranchDependencies(input: Readonly<{
  evidence: Lc4DevReplayEvidenceStore;
  pcm: Map<string, Uint8Array>;
  outcome?: Lc4DevPriorMutationOutcome;
}>): Lc4DevLiveRunnerDependencies["caller_branch"] {
  const bindings = (["openai", "gemini", "xai"] as const).flatMap((provider) => {
    const op42Pcm = input.pcm.get(`${provider}:lc4-dev-op-42`)!;
    return LC4_DEV_PRIOR_MUTATION_OUTCOMES.map((outcome): Lc4DevCallerBranchAudioBinding => {
      const source = LC4_DEV_CALLER_BRANCH_SOURCES.find((candidate) => candidate.prior_outcome === outcome)!;
      return Object.freeze({
        prior_outcome: outcome,
        provider,
        opportunity_id: "lc4-dev-op-42",
        source_id: source.source_id,
        source_text_sha256: source.canonical_caller_text_sha256,
        pcm_sha256: sha256Hex(op42Pcm),
        pcm_byte_length: op42Pcm.byteLength,
        sample_rate_hz: provider === "gemini" ? 16_000 : 24_000,
        channels: 1,
        encoding: "pcm16le",
      });
    });
  });
  const matrix = createLc4DevCallerBranchMatrixArtifact({
    audio_manifest_sha256: "d".repeat(64),
    audio_bindings: bindings,
    signing_identity: branchIdentity,
  });
  const authority = createLc4DevCallerBranchAuthority({ matrix, signing_identity: branchIdentity });
  const trust = Object.freeze({ key_id: branchIdentity.key_id, public_key_pem: branchIdentity.public_key_pem });
  return Object.freeze({
    matrix,
    trust,
    async select({ episode, canonical_opportunity }) {
      const outcome = input.outcome ?? "committed_after_error";
      const decision = authority.decide({
        episode_id: episode.episode_id,
        provider: episode.provider,
        opportunity: canonical_opportunity,
        prior_receipt: {
          semantic_opportunity_id: "lc4-dev-op-35",
          tool: "archive.submit_transcript_request",
          outcome,
          receipt_sha256: outcome === "no_call" ? null : sha256Hex(`prior-receipt:${episode.episode_id}:${outcome}`),
        },
      });
      const { decision_sha256: claimed, ...body } = decision;
      const evidence = await input.evidence.retainJson({
        kind: "caller_branch_decision",
        body: body as never,
        domain_prefix: LC4_DEV_CALLER_BRANCH_DECISION_ARTIFACT_DOMAIN,
        expected_evidence_sha256: claimed,
      });
      return Object.freeze({
        decision,
        opportunity: lc4DevBranchedOpportunity(canonical_opportunity, decision),
        pcm: Uint8Array.from(input.pcm.get(`${episode.provider}:lc4-dev-op-42`)! as Uint8Array),
        evidence,
      });
    },
  });
}

function retainedDependencies(input: Readonly<{
  evidence: Lc4DevReplayEvidenceStore;
  pcm: Map<string, Uint8Array>;
  repair: Lc4DevLiveRunnerDependencies["repair"];
  branch_outcome?: Lc4DevPriorMutationOutcome;
}>): Pick<Lc4DevLiveRunnerDependencies, "caller_audio" | "caller_branch" | "retention" | "control" | "repair" | "evidence" | "finalization"> {
  return {
    evidence: input.evidence,
    caller_audio: { async load(binding) { return input.pcm.get(`${binding.provider}:${binding.opportunity_id}`)!; } },
    caller_branch: callerBranchDependencies({
      evidence: input.evidence,
      pcm: input.pcm,
      ...(input.branch_outcome ? { outcome: input.branch_outcome } : {}),
    }),
    retention: {
      async retain({ direction, pcm }) {
        const kind = direction === "caller_repair" ? "repair_pcm" : direction === "caller_input" ? "caller_pcm" : "assistant_pcm";
        const retained = await input.evidence.retainBytes({
          kind,
          bytes: pcm,
          expected_evidence_sha256: sha256Hex(pcm),
          media_type: "audio/pcm",
        });
        return { artifact_sha256: retained.evidence_sha256, byte_length: pcm.byteLength, evidence: retained };
      },
    },
    control: {
      async next({ episode }) {
        const receipt = control(episode.arm);
        const { control_receipt_sha256: claimed, ...body } = receipt;
        const retained = await input.evidence.retainJson({
          kind: "control_authority",
          body: body as never,
          domain_prefix: "harshas-amazing-call-center/lc4-dev-control-receipt/v1\n",
          expected_evidence_sha256: claimed,
        });
        return { receipt, evidence: retained };
      },
    },
    repair: input.repair,
    finalization: {
      async finalizeEpisode({ episode, segment_finalizations }) {
        return testJsonEvidence(input.evidence, "episode_finalization", {
          episode_id: episode.episode_id,
          segment_finalizations,
        });
      },
    },
  };
}

describe("LC4-DEV live runner", () => {
  it("freezes exactly six paired episodes, 360 opportunities, and at most $15", async () => {
    const { prepare } = await fixtures();
    expect(prepare.episodes.map((episode) => `${episode.provider}:${episode.arm}`)).toEqual([
      "openai:native", "openai:hacc", "gemini:hacc", "gemini:native", "xai:native", "xai:hacc",
    ]);
    expect(prepare.total_opportunities).toBe(360);
    expect(prepare.maximum_total_micro_usd).toBe(15_000_000);
    expect(prepare.episodes.reduce((sum, episode) => sum + episode.maximum_micro_usd, 0)).toBeLessThanOrEqual(15_000_000);
    expect(prepare.evidence_boundary.efficacy_claim_eligible).toBe(false);
    expect(prepare.schema_version).toBe(3);
    const stale = JSON.parse(canonicalJson(prepare));
    stale.audio_execution_contract_sha256 = "0".repeat(64);
    const staleBody = Object.fromEntries(Object.entries(stale).filter(([key]) => key !== "prepare_sha256"));
    stale.prepare_sha256 = sha256Hex(`harshas-amazing-call-center/lc4-dev-live-prepare/v3\n${canonicalJson(staleBody)}`);
    expect(() => assertLc4DevLivePrepareArtifact(stale)).toThrow("not canonical or internally consistent");
    const staleSchema = JSON.parse(canonicalJson(prepare));
    staleSchema.schema_version = 2;
    const staleSchemaBody = Object.fromEntries(
      Object.entries(staleSchema).filter(([key]) => key !== "prepare_sha256"),
    );
    staleSchema.prepare_sha256 = sha256Hex(
      `harshas-amazing-call-center/lc4-dev-live-prepare/v3\n${canonicalJson(staleSchemaBody)}`,
    );
    expect(() => assertLc4DevLivePrepareArtifact(staleSchema))
      .toThrow("not canonical or internally consistent");
  });

  it("rejects self-consistent repair playback receipts substituted across any authority edge", () => {
    const repairPcm = Uint8Array.from([1, 0, 2, 0]);
    const repair: Lc4DevRepairPlayback = Object.freeze({
      kind: "repair",
      advances_canonical_horizon: false,
      recursive_repair_allowed: false,
      episode_id: "lc4-dev-openai-native",
      opportunity_id: "lc4-dev-op-10",
      canonical_ordinal: 10,
      canonical_horizon: 60,
      provider: "openai",
      stage_id: "stage-1",
      blocker_code: "subject_or_goal_unresolved",
      repair_ordinal: 1,
      repair_pcm_id: "repair-op-10",
      source_text_sha256: sha256Hex("repair source"),
      pcm_sha256: sha256Hex(repairPcm),
      pcm_byte_length: repairPcm.byteLength,
      sample_rate_hz: 24_000,
      channels: 1,
      encoding: "pcm16le",
      pcm: repairPcm,
      decision_receipt_sha256: sha256Hex("repair decision"),
    });
    const repairExchange = Object.freeze({
      provider_exchange_sha256: sha256Hex("repair exchange"),
      listener_evidence_sha256: sha256Hex("repair listener"),
      playback_authority_receipt_sha256:
        sha256Hex("repair playback authority"),
    });
    const receiptBody: Omit<
      Lc4DevRepairPlaybackReceipt,
      "playback_receipt_sha256"
    > = Object.freeze({
      schema_version: 1,
      protocol_id: "HACC-LC4-DEV-v1",
      episode_id: repair.episode_id,
      canonical_opportunity_id: repair.opportunity_id,
      canonical_ordinal: repair.canonical_ordinal,
      canonical_horizon: 60,
      advances_canonical_horizon: false,
      recursive_repair_observation: null,
      decision_receipt_sha256: repair.decision_receipt_sha256,
      repair_pcm_id: repair.repair_pcm_id,
      submitted_pcm_sha256: repair.pcm_sha256,
      submitted_pcm_byte_length: repair.pcm_byte_length,
      submitted_sample_rate_hz: repair.sample_rate_hz,
      provider_exchange_sha256: repairExchange.provider_exchange_sha256,
      listener_evidence_sha256: repairExchange.listener_evidence_sha256,
      playback_authority_receipt_sha256:
        repairExchange.playback_authority_receipt_sha256,
    });
    const seal = (
      body: Omit<Lc4DevRepairPlaybackReceipt, "playback_receipt_sha256">,
    ): Lc4DevRepairPlaybackReceipt => Object.freeze({
      ...body,
      playback_receipt_sha256: sha256Hex(
        `harshas-amazing-call-center/lc4-dev-repair-playback-receipt/v1\n${canonicalJson(body)}`,
      ),
    });
    const expectation = {
      episode_id: repair.episode_id,
      opportunity_id: repair.opportunity_id,
      opportunity_index: repair.canonical_ordinal,
      decision_receipt_sha256: repair.decision_receipt_sha256,
      repair,
      repair_exchange: repairExchange,
    } as const;
    expect(() => assertLc4DevRepairPlaybackReceiptBinding({
      receipt: seal(receiptBody),
      ...expectation,
    })).not.toThrow();

    const substitutions: readonly Readonly<{
      label: string;
      mutate: (
        body: Omit<Lc4DevRepairPlaybackReceipt, "playback_receipt_sha256">,
      ) => Omit<Lc4DevRepairPlaybackReceipt, "playback_receipt_sha256">;
    }>[] = Object.freeze([
      {
        label: "decision",
        mutate: (body) => ({
          ...body,
          decision_receipt_sha256: sha256Hex("foreign decision"),
        }),
      },
      {
        label: "repair PCM",
        mutate: (body) => ({
          ...body,
          submitted_pcm_sha256: sha256Hex("foreign repair PCM"),
        }),
      },
      {
        label: "provider exchange",
        mutate: (body) => ({
          ...body,
          provider_exchange_sha256: sha256Hex("foreign exchange"),
        }),
      },
      {
        label: "listener evidence",
        mutate: (body) => ({
          ...body,
          listener_evidence_sha256: sha256Hex("foreign listener"),
        }),
      },
      {
        label: "playback authority",
        mutate: (body) => ({
          ...body,
          playback_authority_receipt_sha256:
            sha256Hex("foreign playback authority"),
        }),
      },
    ]);
    for (const substitution of substitutions) {
      expect(
        () => assertLc4DevRepairPlaybackReceiptBinding({
          receipt: seal(substitution.mutate(receiptBody)),
          ...expectation,
        }),
        substitution.label,
      ).toThrow(
        "repair playback receipt differs from its selected repair, exchange, or decision",
      );
    }
  });

  it("records local rotation compilation failures before any provider socket or generation", async () => {
    const { pcm, prepare, preflight } = await fixtures();
    const evidence = memoryEvidence();
    const retained = retainedDependencies({
      evidence,
      pcm,
      repair: noRepairDependencies(),
    });
    const compileFailureMessage = "LC4 rotation conversation text is invalid";
    let adapterOpenCalls = 0;
    let providerSocketOpens = 0;
    const compileRotationContext = (): string => {
      throw new Error(compileFailureMessage);
    };
    const run = await executeLc4DevLiveRun({
      prepare,
      preflight,
      dependencies: {
        adapter: {
          kind: "lc4-development-realtime-v1",
          factory_id: "lc4-production-provider-adapter/dev-authorized-v1",
          preflight_sha256: preflight.preflight_sha256,
          maximum_total_micro_usd: prepare.maximum_total_micro_usd,
          async openSegment() {
            adapterOpenCalls += 1;
            const compiled = compileRotationContext();
            providerSocketOpens += 1;
            throw new Error(`unexpected provider socket after ${compiled}`);
          },
        },
        ...retained,
        ledger: { async append() {} },
        now: () => new Date(NOW),
      },
    });

    expect(adapterOpenCalls).toBe(1);
    expect(providerSocketOpens).toBe(0);
    expect(run).toMatchObject({
      status: "failed",
      episodes_started: 1,
      episodes_completed: 0,
      opportunities_submitted: 0,
      opportunities_completed: 0,
      response_generations_requested: 0,
      provider_calls_started: 0,
      response_generations_completed: 0,
      provider_calls_made: 0,
      total_response_generations: 0,
      paid_retry_count: 0,
      failure_class: "continuity_compile",
      failure_message_sha256: sha256Hex(compileFailureMessage),
    });
    expect(run.ledger.map((event) => event.event_type)).toEqual([
      "episode_opened",
      "segment_failed",
    ]);
    const segmentFailed = run.ledger[1]!;
    const segmentFailurePayload =
      await evidence.resolveJson(segmentFailed.payload_evidence);
    expect(segmentFailurePayload).toMatchObject({
      segment_ordinal: 1,
      failure_stage: "pre_send_contract",
      failure_code: "invalid_contract",
      failure_class: "adapter_contract",
      failure_role: "primary_exchange",
      provider_boundary_crossed: false,
      response_generation_requested: false,
      response_generation_started: false,
      response_completed: false,
    });
    const failureReference = segmentFailed.evidence_references.find(
      (reference) => reference.kind === "failure_evidence",
    )!;
    const failureEvidence = await evidence.resolveJson(failureReference);
    expect(failureEvidence).toMatchObject({
      failure_stage: "pre_send_contract",
      failure_code: "invalid_contract",
      failure_class: "adapter_contract",
      opportunity_id: null,
      playback_kind: null,
      operation_order: [],
      caller_pcm_byte_length: 0,
      response_generation_requested: false,
      response_generation_started: false,
      response_terminal_observed: false,
      response_completed: false,
      wire_observation_count: 0,
      terminal_wire_type: "none",
    });
    expect(canonicalJson(failureEvidence)).not.toContain(compileFailureMessage);
    await expect(verifyLc4DevReplayLedger(run.ledger, evidence)).resolves.toMatchObject({
      event_count: 2,
      ledger_head_sha256: run.ledger_head_sha256,
    });
  });

  it("executes the exact closed loop and emits an immutable evidence-complete report", async () => {
    const { pcm, prepare, preflight } = await fixtures();
    const evidence = memoryEvidence();
    let opens = 0;
    let exchanges = 0;
    const adapter: Lc4DevelopmentRealtimeAdapter = {
      kind: "lc4-development-realtime-v1",
      factory_id: "lc4-production-provider-adapter/dev-authorized-v1",
      preflight_sha256: preflight.preflight_sha256,
      maximum_total_micro_usd: prepare.maximum_total_micro_usd,
      async openSegment({ episode, segment_ordinal, previous_rotation_receipt_sha256 }) {
        opens += 1;
        expect(previous_rotation_receipt_sha256 === null).toBe(segment_ordinal === 1);
        return {
          async exchangeCanonical({ opportunity, caller_pcm, control_receipt, caller_branch_binding }) {
            exchanges += 1;
            expect(control_receipt.response_control.kind).toBe(episode.arm === "native" ? "native_context" : "hacc_response_plan");
            expect(caller_pcm).toEqual(pcm.get(`${episode.provider}:${opportunity.id}`));
            if (opportunity.index === 42) {
              expect(opportunity).toMatchObject({ id: "lc4-dev-op-42", index: 42 });
              expect(opportunity.canonical_caller_text).toContain("did not hear a transcript request get submitted");
              expect(opportunity.events.some((event) => event.kind === "authoritative-reconciliation")).toBe(false);
            }
            const assistant = Uint8Array.from([opportunity.index, 2, 4, 8]);
            const projection = providerExchangeProjection(caller_pcm, assistant, caller_branch_binding, {
              episode_id: episode.episode_id,
              opportunity_id: opportunity.id,
              provider: episode.provider,
              model: episode.model,
              arm: episode.arm,
            });
            const providerEvidence = await testJsonEvidence(evidence, "provider_exchange", projection);
            const { listenerEvidence, lineage } =
              await retainProviderListenerEvidence(evidence, projection);
            return {
              playback_kind: "canonical" as const,
              opportunity_id: opportunity.id,
              assistant_pcm: assistant,
              provider_exchange_sha256: providerEvidence.evidence_sha256,
              listener_evidence_sha256: listenerEvidence.evidence_sha256,
              repair_projection: lineage.repair_projection,
              playback_authority_receipt_sha256:
                lineage.playback_authority_receipt_sha256,
              provider_exchange_projection: projection,
              provider_exchange_evidence: providerEvidence,
              listener_evidence: listenerEvidence,
            };
          },
          async exchangeRepair() { throw new Error("no-repair fixture selected a repair"); },
          async finalizeOpportunity({ opportunity_id }) {
            const retained = await testJsonEvidence(evidence, "opportunity_finalization", { episode_id: episode.episode_id, opportunity_id });
            return { opportunity_receipt_sha256: retained.evidence_sha256, opportunity_finalization: retained };
          },
          async close() {
            const retained = await testJsonEvidence(evidence, "segment_finalization", { episode_id: episode.episode_id, segment_ordinal });
            return { rotation_receipt_sha256: retained.evidence_sha256, segment_finalization: retained };
          },
        };
      },
    };
    const ledger: string[] = [];
    const run = await executeLc4DevLiveRun({
      prepare,
      preflight,
      dependencies: {
        adapter,
        ...retainedDependencies({ evidence, pcm, repair: noRepairDependencies(), branch_outcome: "no_call" }),
        ledger: { async append(event) { ledger.push(event.event_sha256); } },
        now: () => new Date(NOW),
      },
    });
    expect(opens).toBe(18);
    expect(exchanges).toBe(360);
    expect(run.status).toBe("completed");
    expect(run.opportunities_completed).toBe(360);
    expect(run.paid_retry_count).toBe(0);
    expect(run.response_generations_requested).toBe(360);
    expect(run.provider_calls_started).toBe(360);
    expect(run.response_generations_completed).toBe(360);
    expect(run.provider_calls_made).toBe(360);
    expect(run.total_response_generations).toBe(360);
    expect(run.repair_playbacks).toBe(0);
    expect(run.episode_finalization_count).toBe(6);
    expect(run.replay_evidence_reference_count).toBeGreaterThan(run.ledger.length);
    expect(run.ledger).toHaveLength(1_098); // 6 opened + 6 op42 branches + 360 submitted + 360 repair decisions + 360 completed + 6 terminal
    expect(run.ledger.filter((event) => event.event_type === "caller_branch_selected")).toHaveLength(6);
    expect(run.ledger.filter((event) => event.event_type === "caller_branch_selected")
      .every((event) => event.payload_sha256.length === 64)).toBe(true);
    const firstCompleted = run.ledger.find(
      (event) => event.event_type === "opportunity_completed",
    )!;
    const firstCompletedPayload = await evidence.resolveJson(
      firstCompleted.payload_evidence,
    ) as Record<string, JsonValue>;
    expect(firstCompletedPayload).not.toHaveProperty("assistant_pcm_sha256");
    expect(firstCompletedPayload).toMatchObject({
      canonical_provider_exchange_sha256:
        firstCompletedPayload.effective_provider_exchange_sha256,
      canonical_listener_evidence_sha256:
        firstCompletedPayload.effective_listener_evidence_sha256,
      canonical_assistant_pcm_sha256:
        firstCompletedPayload.effective_assistant_pcm_sha256,
    });
    expect(firstCompleted.evidence_references.filter(
      (reference) => reference.kind === "assistant_pcm",
    )).toHaveLength(1);
    expect(ledger.at(-1)).toBe(run.ledger_head_sha256);
    await expect(verifyLc4DevReplayLedger(run.ledger, evidence)).resolves.toMatchObject({
      event_count: 1_098,
      ledger_head_sha256: run.ledger_head_sha256,
    });
    expect(createLc4DevLiveReportArtifact(run, COMPLETE_AUTHORITY, COMPLETE_RUN_BUDGET)).toMatchObject({
      completed: true,
      exact_six_episode_horizon: true,
      exact_opportunity_horizon: true,
      exact_playback_accounting: true,
      evidence_complete: true,
      task_results_available: true,
      authority_evaluated: 6,
      efficacy_claim_eligible: false,
    });
  });

  it("inserts one real same-opportunity repair without consuming the next canonical ordinal", async () => {
    const audioRoot = await mkdtemp(join(tmpdir(), "hacc-lc4-dev-live-repair-"));
    try {
      const materializedRoot = join(audioRoot, "audio");
      const audio = await materializeLc4DevelopmentAudio({
        outputRoot: materializedRoot,
        renderer: repairAudioRenderer,
      });
      const { pcm, prepare, preflight } = await fixtures();
      const evidence = memoryEvidence();
      const realRepair = Object.fromEntries(((["openai", "gemini", "xai"] as const)).map((provider) => [
        provider,
        createLc4DevRepairPlaybackController({
          provider,
          audio_manifest: audio.manifest,
          repair_manifest: audio.repairManifest,
          async load_repair_pcm(binding) {
            return new Uint8Array(await readFile(join(materializedRoot, binding.pcm_path)));
          },
        }),
      ])) as Lc4DevLiveRunnerDependencies["repair"];

      let canonicalExchanges = 0;
      let repairExchanges = 0;
      let finalizations = 0;
      let repairedCanonicalOrdinal: number | null = null;
      let canonicalAfterRepair: number | null = null;
      const targetEpisodeId = prepare.episodes[0]!.episode_id;
      const adapter: Lc4DevelopmentRealtimeAdapter = {
        kind: "lc4-development-realtime-v1",
        factory_id: "lc4-production-provider-adapter/dev-authorized-v1",
        preflight_sha256: preflight.preflight_sha256,
        maximum_total_micro_usd: prepare.maximum_total_micro_usd,
        async openSegment({ episode, segment_ordinal }) {
          let expectedCanonicalOrdinal = ((segment_ordinal - 1) * 20) + 1;
          let pending: Readonly<{ opportunity_id: string; repair_played: boolean }> | null = null;
          return {
            async exchangeCanonical({ opportunity, caller_pcm, caller_branch_binding }) {
              expect(pending).toBeNull();
              expect(opportunity.index).toBe(expectedCanonicalOrdinal);
              if (repairedCanonicalOrdinal !== null && episode.episode_id === targetEpisodeId && opportunity.index > repairedCanonicalOrdinal && canonicalAfterRepair === null) {
                canonicalAfterRepair = opportunity.index;
              }
              pending = { opportunity_id: opportunity.id, repair_played: false };
              canonicalExchanges += 1;
              const shouldRepair = episode.episode_id === targetEpisodeId && opportunity.index === 10;
              const semanticResultSha256 = sha256Hex(`semantic-result:${episode.episode_id}:${opportunity.id}`);
              const assistant = Uint8Array.from([opportunity.index, 2, 4, 8]);
              const listenerRepairProjection = createLc4DevArmBlindRepairProjection({
                opportunity_id: opportunity.id,
                listener_status: "verified",
                semantic_result_sha256: semanticResultSha256,
                semantic_replay_sha256: sha256Hex(`semantic-replay:${episode.episode_id}:${opportunity.id}`),
                unmet_blocker_codes: shouldRepair ? ["subject_or_goal_unresolved"] : [],
                final_required_criteria_pass: !shouldRepair,
              });
              const projection = providerExchangeProjection(caller_pcm, assistant, caller_branch_binding, {
                kind: "canonical",
                episode_id: episode.episode_id,
                opportunity_id: opportunity.id,
                provider: episode.provider,
                model: episode.model,
                arm: episode.arm,
              }, {
                repair_projection: listenerRepairProjection,
                playback_authority_receipt_sha256:
                  sha256Hex(`canonical-authority:${episode.episode_id}:${opportunity.id}`),
              });
              const providerEvidence = await testJsonEvidence(evidence, "provider_exchange", projection);
              const { listenerEvidence, lineage } =
                await retainProviderListenerEvidence(evidence, projection);
              return {
                playback_kind: "canonical" as const,
                opportunity_id: opportunity.id,
                assistant_pcm: assistant,
                provider_exchange_sha256: providerEvidence.evidence_sha256,
                listener_evidence_sha256: listenerEvidence.evidence_sha256,
                repair_projection: lineage.repair_projection,
                playback_authority_receipt_sha256:
                  lineage.playback_authority_receipt_sha256,
                provider_exchange_projection: projection,
                provider_exchange_evidence: providerEvidence,
                listener_evidence: listenerEvidence,
              };
            },
            async exchangeRepair({ opportunity, repair, decision_receipt }) {
              expect(pending).toEqual({ opportunity_id: opportunity.id, repair_played: false });
              expect(opportunity.index).toBe(expectedCanonicalOrdinal);
              expect(repair.canonical_ordinal).toBe(expectedCanonicalOrdinal);
              expect(repair.advances_canonical_horizon).toBe(false);
              expect(repair.recursive_repair_allowed).toBe(false);
              expect(repair.decision_receipt_sha256).toBe(decision_receipt.decision_receipt_sha256);
              expect(repair.pcm_sha256).toBe(sha256Hex(repair.pcm));
              repairExchanges += 1;
              repairedCanonicalOrdinal = opportunity.index;
              pending = { opportunity_id: opportunity.id, repair_played: true };
              const assistant = Uint8Array.from([opportunity.index, 6, 10, 14]);
              const projection = providerExchangeProjection(repair.pcm, assistant, undefined, {
                kind: "repair",
                episode_id: episode.episode_id,
                opportunity_id: opportunity.id,
                provider: episode.provider,
                model: episode.model,
                arm: episode.arm,
              }, {
                playback_authority_receipt_sha256:
                  sha256Hex(`repair-authority:${episode.episode_id}:${opportunity.id}`),
              });
              const providerEvidence = await testJsonEvidence(evidence, "provider_exchange", projection);
              const { listenerEvidence, lineage } =
                await retainProviderListenerEvidence(evidence, projection);
              return {
                playback_kind: "repair" as const,
                opportunity_id: opportunity.id,
                assistant_pcm: assistant,
                provider_exchange_sha256: providerEvidence.evidence_sha256,
                listener_evidence_sha256: listenerEvidence.evidence_sha256,
                repair_projection: lineage.repair_projection,
                playback_authority_receipt_sha256:
                  lineage.playback_authority_receipt_sha256,
                provider_exchange_projection: projection,
                provider_exchange_evidence: providerEvidence,
                listener_evidence: listenerEvidence,
              };
            },
            async finalizeOpportunity({ opportunity_id, repair_played }) {
              expect(pending).toEqual({ opportunity_id, repair_played });
              pending = null;
              expectedCanonicalOrdinal += 1;
              finalizations += 1;
              const retained = await testJsonEvidence(evidence, "opportunity_finalization", { episode_id: episode.episode_id, opportunity_id, repair_played });
              return { opportunity_receipt_sha256: retained.evidence_sha256, opportunity_finalization: retained };
            },
            async close() {
              expect(pending).toBeNull();
              expect(expectedCanonicalOrdinal).toBe((segment_ordinal * 20) + 1);
              const retained = await testJsonEvidence(evidence, "segment_finalization", { episode_id: episode.episode_id, segment_ordinal });
              return { rotation_receipt_sha256: retained.evidence_sha256, segment_finalization: retained };
            },
          };
        },
      };

      const run = await executeLc4DevLiveRun({
        prepare,
        preflight,
        dependencies: {
          adapter,
          ...retainedDependencies({ evidence, pcm, repair: realRepair }),
          ledger: { async append() {} },
          now: () => new Date(NOW),
        },
      });

      expect(run).toMatchObject({
        status: "completed",
        opportunities_submitted: 360,
        opportunities_completed: 360,
        response_generations_requested: 361,
        provider_calls_started: 361,
        response_generations_completed: 361,
        provider_calls_made: 361,
        repair_playbacks: 1,
        total_response_generations: 361,
        paid_retry_count: 0,
        retained_caller_audio: 361,
        retained_assistant_audio: 361,
        listener_evidence_count: 361,
      });
      expect(canonicalExchanges).toBe(360);
      expect(repairExchanges).toBe(1);
      expect(finalizations).toBe(360);
      expect(repairedCanonicalOrdinal).toBe(10);
      expect(canonicalAfterRepair).toBe(11);
      expect(run.ledger.filter((event) => event.event_type === "repair_audio_submitted")).toHaveLength(1);
      expect(run.ledger.filter((event) => event.event_type === "repair_completed")).toHaveLength(1);
      const repairCompleted = run.ledger.find(
        (event) => event.event_type === "repair_completed",
      )!;
      const repairedOpportunityCompleted = run.ledger.find(
        (event) => event.event_type === "opportunity_completed"
          && event.episode_id === targetEpisodeId
          && event.opportunity_id === "lc4-dev-op-10",
      )!;
      const repairPayload = await evidence.resolveJson(
        repairCompleted.payload_evidence,
      ) as Record<string, JsonValue>;
      const completedPayload = await evidence.resolveJson(
        repairedOpportunityCompleted.payload_evidence,
      ) as Record<string, JsonValue>;
      const canonicalAssistantPcmSha256 = sha256Hex(
        Uint8Array.from([10, 2, 4, 8]),
      );
      const effectiveAssistantPcmSha256 = sha256Hex(
        Uint8Array.from([10, 6, 10, 14]),
      );
      expect(repairPayload).toMatchObject({
        decision_receipt_sha256:
          completedPayload.decision_receipt_sha256,
        canonical_provider_exchange_sha256:
          completedPayload.canonical_provider_exchange_sha256,
        canonical_listener_evidence_sha256:
          completedPayload.canonical_listener_evidence_sha256,
        canonical_assistant_pcm_sha256: canonicalAssistantPcmSha256,
        effective_provider_exchange_sha256:
          completedPayload.effective_provider_exchange_sha256,
        effective_listener_evidence_sha256:
          completedPayload.effective_listener_evidence_sha256,
        effective_assistant_pcm_sha256: effectiveAssistantPcmSha256,
        repair_exchange_sha256:
          completedPayload.effective_provider_exchange_sha256,
        repair_listener_evidence_sha256:
          completedPayload.effective_listener_evidence_sha256,
        repair_assistant_pcm_sha256: effectiveAssistantPcmSha256,
      });
      expect(completedPayload).not.toHaveProperty("assistant_pcm_sha256");
      expect(completedPayload).toMatchObject({
        canonical_assistant_pcm_sha256: canonicalAssistantPcmSha256,
        effective_assistant_pcm_sha256: effectiveAssistantPcmSha256,
      });
      for (const event of [repairCompleted, repairedOpportunityCompleted]) {
        const assistantPcmReferences = event.evidence_references.filter(
          (reference) => reference.kind === "assistant_pcm",
        );
        const providerExchangeReferences = event.evidence_references.filter(
          (reference) => reference.kind === "provider_exchange",
        );
        const listenerEvidenceReferences = event.evidence_references.filter(
          (reference) => reference.kind === "listener_evidence",
        );
        expect(new Set(assistantPcmReferences.map(
          (reference) => reference.evidence_sha256,
        ))).toEqual(new Set([
          canonicalAssistantPcmSha256,
          effectiveAssistantPcmSha256,
        ]));
        expect(new Set(providerExchangeReferences.map(
          (reference) => reference.evidence_sha256,
        ))).toEqual(new Set([
          String(completedPayload.canonical_provider_exchange_sha256),
          String(completedPayload.effective_provider_exchange_sha256),
        ]));
        expect(new Set(listenerEvidenceReferences.map(
          (reference) => reference.evidence_sha256,
        ))).toEqual(new Set([
          String(completedPayload.canonical_listener_evidence_sha256),
          String(completedPayload.effective_listener_evidence_sha256),
        ]));
      }
      const repairDecisionReference = repairCompleted.evidence_references.find(
        (reference) => reference.kind === "repair_decision",
      );
      const repairPlaybackReference = repairCompleted.evidence_references.find(
        (reference) => reference.kind === "repair_playback",
      );
      expect(repairDecisionReference?.evidence_sha256).toBe(
        String(completedPayload.decision_receipt_sha256),
      );
      expect(repairPlaybackReference?.evidence_sha256).toBe(
        String(repairPayload.playback_receipt_sha256),
      );
      expect(run.ledger).toHaveLength(1_100);
      await expect(verifyLc4DevReplayLedger(run.ledger, evidence)).resolves.toMatchObject({
        event_count: 1_100,
        ledger_head_sha256: run.ledger_head_sha256,
      });
      expect(createLc4DevLiveReportArtifact(run, COMPLETE_AUTHORITY, COMPLETE_RUN_BUDGET)).toMatchObject({
        completed: true,
        exact_six_episode_horizon: true,
        exact_opportunity_horizon: true,
        exact_playback_accounting: true,
        evidence_complete: true,
      });
    } finally {
      await rm(audioRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not retry once audio was submitted", async () => {
    const { pcm, prepare, preflight } = await fixtures();
    const evidence = memoryEvidence();
    let calls = 0;
    const run = await executeLc4DevLiveRun({
      prepare,
      preflight,
      dependencies: {
        adapter: {
          kind: "lc4-development-realtime-v1",
          factory_id: "lc4-production-provider-adapter/dev-authorized-v1",
          preflight_sha256: preflight.preflight_sha256,
          maximum_total_micro_usd: prepare.maximum_total_micro_usd,
          async openSegment({ episode }) {
            return {
              async exchangeCanonical({ opportunity, caller_pcm }) {
                calls += 1;
                throw new Lc4DevFailureEvidenceError(createLc4DevFailureEvidence({
                  schema_version: 2,
                  evidence_version: LC4_DEV_FAILURE_EVIDENCE_VERSION,
                  redaction: "strict_allowlist_no_provider_plaintext_credentials_or_raw_ids",
                  failure_role: "primary_exchange",
                  failure_stage: "provider_wait",
                  failure_code: "provider_fatal",
                  failure_class: "provider_external",
                  episode_id: episode.episode_id,
                  opportunity_id: opportunity.id,
                  provider: episode.provider,
                  model: episode.model,
                  playback_kind: "canonical",
                  operation_order: [
                    "caller_pcm_delivery_started",
                    "caller_pcm_delivery_completed",
                    "response_plan_prepared",
                    "caller_pcm_committed",
                    "response_generation_requested",
                    "response_generation_started",
                  ],
                  caller_pcm_sha256: sha256Hex(caller_pcm),
                  caller_pcm_byte_length: caller_pcm.byteLength,
                  caller_pcm_chunk_count: 1,
                  caller_pcm_appended_chunk_count: 1,
                  caller_pcm_appended_byte_length: caller_pcm.byteLength,
                  response_generation_requested: true,
                  response_generation_started: true,
                  response_terminal_observed: false,
                  response_completed: false,
                  output_pcm_sha256: null,
                  output_pcm_byte_length: 0,
                  output_pcm_chunk_count: 0,
                  wire_observation_count: 4,
                  terminal_wire_type: "provider_error",
                  terminal_wire_type_sha256: sha256Hex("error"),
                  terminal_wire_observation_sha256: sha256Hex("sanitized-provider-error-observation"),
                  gateway_batch_count: 0,
                  gateway_fatal_class: "none",
                  secondary_failure_evidence_sha256: null,
                }));
              },
              async exchangeRepair() { throw new Error("repair must not run after canonical transport failure"); },
              async finalizeOpportunity() { throw new Error("failed canonical opportunity cannot finalize"); },
              async close() { throw new Error("secondary cleanup failure"); },
            };
          },
        },
        ...retainedDependencies({ evidence, pcm, repair: noRepairDependencies() }),
        ledger: { async append() {} },
        now: () => new Date(NOW),
      },
    });
    expect(calls).toBe(1);
    expect(run.status).toBe("failed");
    expect(run.opportunities_submitted).toBe(1);
    expect(run.opportunities_completed).toBe(0);
    expect(run.response_generations_requested).toBe(1);
    expect(run.provider_calls_started).toBe(1);
    expect(run.response_generations_completed).toBe(0);
    expect(run.provider_calls_made).toBe(1);
    expect(run.paid_retry_count).toBe(0);
    expect(run.failure_message_sha256).toBe(sha256Hex("LC4-DEV exchange failed: provider_fatal"));
    const failed = run.ledger.find((event) => event.event_type === "opportunity_failed")!;
    const cleanup = run.ledger.find((event) => event.event_type === "segment_failed")!;
    expect(failed.evidence_references.some((reference) => reference.kind === "failure_evidence")).toBe(true);
    expect(cleanup.evidence_references.some((reference) => reference.kind === "failure_evidence")).toBe(true);
    const cleanupEvidence = cleanup.evidence_references.find((reference) => reference.kind === "failure_evidence")!;
    await expect(evidence.resolveJson(cleanupEvidence)).resolves.toMatchObject({
      failure_role: "cleanup",
      secondary_failure_evidence_sha256: failed.evidence_references.find((reference) => reference.kind === "failure_evidence")!.evidence_sha256,
    });
    await expect(verifyLc4DevReplayLedger(run.ledger, evidence)).resolves.toMatchObject({
      event_count: run.ledger.length,
      ledger_head_sha256: run.ledger_head_sha256,
    });
    expect(createLc4DevLiveReportArtifact(run, COMPLETE_AUTHORITY, COMPLETE_RUN_BUDGET)).toMatchObject({
      completed: false,
      evidence_complete: false,
      exact_playback_accounting: false,
    });
  });

  it("rejects a tampered caller-branch matrix before opening any provider segment", async () => {
    const { pcm, prepare, preflight } = await fixtures();
    const evidence = memoryEvidence();
    const retained = retainedDependencies({ evidence, pcm, repair: noRepairDependencies() });
    let opens = 0;
    const tamperedCallerBranch = {
      ...retained.caller_branch,
      matrix: {
        ...retained.caller_branch.matrix,
        audio_manifest_sha256: "e".repeat(64),
      },
    } as Lc4DevLiveRunnerDependencies["caller_branch"];
    await expect(executeLc4DevLiveRun({
      prepare,
      preflight,
      dependencies: {
        adapter: {
          kind: "lc4-development-realtime-v1",
          factory_id: "lc4-production-provider-adapter/dev-authorized-v1",
          preflight_sha256: preflight.preflight_sha256,
          maximum_total_micro_usd: prepare.maximum_total_micro_usd,
          async openSegment() { opens += 1; throw new Error("must not open"); },
        },
        ...retained,
        caller_branch: tamperedCallerBranch,
        ledger: { async append() {} },
        now: () => new Date(NOW),
      },
    })).rejects.toThrow(/caller branch matrix/u);
    expect(opens).toBe(0);
  });

  it("does not count the sixth episode complete when replay-valid finalization fails", async () => {
    const { pcm, prepare, preflight } = await fixtures();
    const evidence = memoryEvidence();
    const retained = retainedDependencies({ evidence, pcm, repair: noRepairDependencies() });
    const finalEpisodeId = prepare.episodes.at(-1)!.episode_id;
    const adapter: Lc4DevelopmentRealtimeAdapter = {
      kind: "lc4-development-realtime-v1",
      factory_id: "lc4-production-provider-adapter/dev-authorized-v1",
      preflight_sha256: preflight.preflight_sha256,
      maximum_total_micro_usd: prepare.maximum_total_micro_usd,
      async openSegment({ episode, segment_ordinal }) {
        return {
          async exchangeCanonical({ opportunity, caller_pcm, caller_branch_binding }) {
            const assistant = Uint8Array.from([opportunity.index, 2, 4, 8]);
            const projection = providerExchangeProjection(caller_pcm, assistant, caller_branch_binding, {
              episode_id: episode.episode_id,
              opportunity_id: opportunity.id,
              provider: episode.provider,
              model: episode.model,
              arm: episode.arm,
            });
            const providerEvidence = await testJsonEvidence(evidence, "provider_exchange", projection);
            const { listenerEvidence, lineage } =
              await retainProviderListenerEvidence(evidence, projection);
            return {
              playback_kind: "canonical" as const,
              opportunity_id: opportunity.id,
              assistant_pcm: assistant,
              provider_exchange_sha256: providerEvidence.evidence_sha256,
              listener_evidence_sha256: listenerEvidence.evidence_sha256,
              repair_projection: lineage.repair_projection,
              playback_authority_receipt_sha256:
                lineage.playback_authority_receipt_sha256,
              provider_exchange_projection: projection,
              provider_exchange_evidence: providerEvidence,
              listener_evidence: listenerEvidence,
            };
          },
          async exchangeRepair() { throw new Error("finalization fixture does not select repairs"); },
          async finalizeOpportunity({ opportunity_id }) {
            const finalization = await testJsonEvidence(evidence, "opportunity_finalization", {
              episode_id: episode.episode_id,
              opportunity_id,
            });
            return { opportunity_receipt_sha256: finalization.evidence_sha256, opportunity_finalization: finalization };
          },
          async close() {
            const finalization = await testJsonEvidence(evidence, "segment_finalization", {
              episode_id: episode.episode_id,
              segment_ordinal,
            });
            return { rotation_receipt_sha256: finalization.evidence_sha256, segment_finalization: finalization };
          },
        };
      },
    };
    const run = await executeLc4DevLiveRun({
      prepare,
      preflight,
      dependencies: {
        adapter,
        ...retained,
        finalization: {
          async finalizeEpisode(input) {
            if (input.episode.episode_id === finalEpisodeId) throw new Error("sixth finalization rejected");
            return retained.finalization.finalizeEpisode(input);
          },
        },
        ledger: { async append() {} },
        now: () => new Date(NOW),
      },
    });

    expect(run).toMatchObject({
      status: "failed",
      episodes_started: 6,
      episodes_completed: 5,
      opportunities_completed: 360,
      episode_finalization_count: 5,
      failure_class: "evidence",
      failure_message_sha256: sha256Hex("sixth finalization rejected"),
    });
    expect(run.ledger.filter((event) => event.event_type === "episode_terminal")).toHaveLength(5);
  });

  it.each([
    {
      label: "transport mode",
      mutate: (projection: Record<string, unknown>) => ({
        ...projection,
        transport_mode: "provider_native_server_vad",
      }),
    },
    {
      label: "transport profile",
      mutate: (projection: Record<string, unknown>) => ({
        ...projection,
        transport_profile_sha256: sha256Hex("substituted-transport-profile"),
      }),
    },
    {
      label: "transport FSM",
      mutate: (projection: Record<string, unknown>) => ({
        ...projection,
        operation_order: [
          "caller_pcm_delivery_started",
          "caller_pcm_delivery_completed",
          "response_plan_prepared",
          "response_generation_requested",
          "caller_pcm_committed",
          "assistant_pcm_captured",
          "listener_evidence_handed_off",
        ],
      }),
    },
  ])("rejects a newly rehashed CAS exchange with tampered $label semantics", async ({ mutate }) => {
    const { pcm, prepare, preflight } = await fixtures();
    const evidence = memoryEvidence();
    const adapter: Lc4DevelopmentRealtimeAdapter = {
      kind: "lc4-development-realtime-v1",
      factory_id: "lc4-production-provider-adapter/dev-authorized-v1",
      preflight_sha256: preflight.preflight_sha256,
      maximum_total_micro_usd: prepare.maximum_total_micro_usd,
      async openSegment({ episode, segment_ordinal }) {
        return {
          async exchangeCanonical({ opportunity, caller_pcm, caller_branch_binding }) {
            const assistant = Uint8Array.from([2, 4, 8, 16]);
            const valid = providerExchangeProjection(caller_pcm, assistant, caller_branch_binding, {
              episode_id: episode.episode_id,
              opportunity_id: opportunity.id,
              provider: episode.provider,
              model: episode.model,
              arm: episode.arm,
            });
            const projection = mutate(valid);
            // This intentionally gives the semantic mutation a fresh,
            // internally matching CAS object and reference.
            const providerEvidence = await testJsonEvidence(
              evidence,
              "provider_exchange",
              projection,
            );
            const { listenerEvidence, lineage } =
              await retainProviderListenerEvidence(evidence, valid);
            return {
              playback_kind: "canonical" as const,
              opportunity_id: opportunity.id,
              assistant_pcm: assistant,
              provider_exchange_sha256: providerEvidence.evidence_sha256,
              listener_evidence_sha256: listenerEvidence.evidence_sha256,
              repair_projection: lineage.repair_projection,
              playback_authority_receipt_sha256:
                lineage.playback_authority_receipt_sha256,
              provider_exchange_projection: projection,
              provider_exchange_evidence: providerEvidence,
              listener_evidence: listenerEvidence,
            };
          },
          async exchangeRepair() {
            throw new Error("semantic replay mutation cannot enter repair");
          },
          async finalizeOpportunity() {
            throw new Error("semantic replay mutation cannot finalize");
          },
          async close() {
            const retained = await testJsonEvidence(evidence, "segment_finalization", {
              episode_id: episode.episode_id,
              segment_ordinal,
            });
            return {
              rotation_receipt_sha256: retained.evidence_sha256,
              segment_finalization: retained,
            };
          },
        };
      },
    };
    const run = await executeLc4DevLiveRun({
      prepare,
      preflight,
      dependencies: {
        adapter,
        ...retainedDependencies({ evidence, pcm, repair: noRepairDependencies() }),
        ledger: { async append() {} },
        now: () => new Date(NOW),
      },
    });
    expect(run).toMatchObject({
      status: "failed",
      failure_class: "evidence",
      episodes_started: 1,
      opportunities_submitted: 1,
      opportunities_completed: 0,
      provider_calls_started: 1,
      response_generations_completed: 1,
    });
    const failed = run.ledger.find((event) => event.event_type === "opportunity_failed");
    expect(failed).toBeDefined();
    await expect(evidence.resolveJson(
      failed!.evidence_references.find((reference) => reference.kind === "failure_evidence")!,
    )).resolves.toMatchObject({
      failure_stage: "exchange_evidence",
      failure_code: "evidence_assembly_failed",
      failure_class: "evidence_retention",
    });
  });

  it("counts a returned paid exchange before rejecting mutated branch replay evidence", async () => {
    const { pcm, prepare, preflight } = await fixtures();
    const evidence = memoryEvidence();
    const adapter: Lc4DevelopmentRealtimeAdapter = {
      kind: "lc4-development-realtime-v1",
      factory_id: "lc4-production-provider-adapter/dev-authorized-v1",
      preflight_sha256: preflight.preflight_sha256,
      maximum_total_micro_usd: prepare.maximum_total_micro_usd,
      async openSegment({ episode, segment_ordinal }) {
        return {
          async exchangeCanonical({ opportunity, caller_pcm, caller_branch_binding }) {
            const assistant = Uint8Array.from([opportunity.index, 2, 4, 8]);
            const correct = providerExchangeProjection(caller_pcm, assistant, caller_branch_binding, {
              episode_id: episode.episode_id,
              opportunity_id: opportunity.id,
              provider: episode.provider,
              model: episode.model,
              arm: episode.arm,
            });
            const projection = opportunity.index === 42
              ? {
                  ...correct,
                  caller_branch_authority: {
                    ...(correct.caller_branch_authority as Record<string, unknown>),
                    source_text_sha256: sha256Hex("mutated-retained-branch-source"),
                  },
                }
              : correct;
            const providerEvidence = await testJsonEvidence(evidence, "provider_exchange", projection);
            const { listenerEvidence, lineage } =
              await retainProviderListenerEvidence(evidence, correct);
            return {
              playback_kind: "canonical" as const,
              opportunity_id: opportunity.id,
              assistant_pcm: assistant,
              provider_exchange_sha256: providerEvidence.evidence_sha256,
              listener_evidence_sha256: listenerEvidence.evidence_sha256,
              repair_projection: lineage.repair_projection,
              playback_authority_receipt_sha256:
                lineage.playback_authority_receipt_sha256,
              provider_exchange_projection: projection,
              provider_exchange_evidence: providerEvidence,
              listener_evidence: listenerEvidence,
            };
          },
          async exchangeRepair() { throw new Error("mutated replay fixture does not select repairs"); },
          async finalizeOpportunity({ opportunity_id }) {
            const retained = await testJsonEvidence(evidence, "opportunity_finalization", {
              episode_id: episode.episode_id,
              opportunity_id,
            });
            return { opportunity_receipt_sha256: retained.evidence_sha256, opportunity_finalization: retained };
          },
          async close() {
            const retained = await testJsonEvidence(evidence, "segment_finalization", {
              episode_id: episode.episode_id,
              segment_ordinal,
            });
            return { rotation_receipt_sha256: retained.evidence_sha256, segment_finalization: retained };
          },
        };
      },
    };
    const run = await executeLc4DevLiveRun({
      prepare,
      preflight,
      dependencies: {
        adapter,
        ...retainedDependencies({
          evidence,
          pcm,
          repair: noRepairDependencies(),
          branch_outcome: "no_call",
        }),
        ledger: { async append() {} },
        now: () => new Date(NOW),
      },
    });
    expect(run).toMatchObject({
      status: "failed",
      failure_class: "evidence",
      episodes_started: 1,
      opportunities_submitted: 42,
      opportunities_completed: 41,
      provider_calls_started: 42,
      response_generations_completed: 42,
    });
    const failed = run.ledger.find((event) =>
      event.event_type === "opportunity_failed" && event.opportunity_id === "lc4-dev-op-42");
    expect(failed).toBeDefined();
    const retainedFailure = await evidence.resolveJson(
      failed!.evidence_references.find((reference) => reference.kind === "failure_evidence")!,
    );
    expect(retainedFailure).toMatchObject({
      failure_stage: "exchange_evidence",
      failure_code: "evidence_assembly_failed",
      failure_class: "evidence_retention",
    });
  });

  it("documents the exact safe source unlock instead of casting DEV as confirmatory", () => {
    expect(LC4_DEV_ADAPTER_BOUNDARY).toEqual(expect.objectContaining({
      code: "dev_specific_adapter_unlocked",
      confirmatory_factory_compile_time_frozen: true,
    }));
  });

  it("constructs only the preflight-bound DEV factory while confirmatory execution remains frozen", async () => {
    const { pcm, prepare, gateD } = await fixtures();
    const credentials = { openai: "test-openai-secret", gemini: "test-gemini-secret", xai: "test-xai-secret" } as const;
    const preflight = await authorizedPreflight(
      prepare,
      lc4DevCredentialIdentitySetSha256(credentials),
      gateD,
    );
    const evidence = memoryEvidence();
    const callerBranch = callerBranchDependencies({ evidence, pcm });
    const listenerEvidence = await testJsonEvidence(evidence, "listener_evidence", { fixture: "factory-construction" });
    const gatewayExecutor: Lc4DevGatewayExecutor = {
      kind: "lc4-dev-arm-aware-gateway-v1",
      manifest_sha256: preflight.control_plane_manifest_sha256,
      currentResponsePreparation() {
        const additionalInstructions =
          "<hacc_response_plan>{\"fixture\":\"current_control\"}</hacc_response_plan>";
        return {
          additionalInstructions,
          contextSha256: sha256Hex(additionalInstructions),
          contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
        };
      },
      async execute() { throw new Error("factory construction test must not execute the gateway"); },
    };
    const budgetAuthority = {
      assertProviderConstructionAuthorized() {},
      assertWithinHardDeadline() {},
      assertOperationWindow() {},
      async beforeEpisodeSocketOpen() {},
      async afterEpisodeSocketOpen() {},
    };
    const adapter = createLc4DevelopmentRealtimeAdapter({
      prepare,
      preflight,
      credentials,
      caller_branch_authority: { matrix: callerBranch.matrix, trust: callerBranch.trust },
      gateway_executor: gatewayExecutor,
      evidence,
      budget_authority: budgetAuthority,
      listener: {
        async accept({ opportunity }) {
          return {
            listener_evidence_sha256: HASH,
            repair_projection: repairProjection(opportunity.id),
            playback_authority_receipt_sha256: HASH,
            listener_evidence: listenerEvidence,
          };
        },
      },
      now: () => new Date(NOW),
    });
    expect(adapter).toMatchObject({
      kind: "lc4-development-realtime-v1",
      factory_id: "lc4-production-provider-adapter/dev-authorized-v1",
      preflight_sha256: preflight.preflight_sha256,
      maximum_total_micro_usd: 15_000_000,
    });
    expect(LC4_PRODUCTION_PROVIDER_EXECUTION_FROZEN).toBe(true);
    expect(() => createLc4DevelopmentRealtimeAdapter({
      prepare,
      preflight,
      credentials: { ...credentials, xai: "different-xai-secret" },
      caller_branch_authority: { matrix: callerBranch.matrix, trust: callerBranch.trust },
      gateway_executor: gatewayExecutor,
      evidence,
      budget_authority: budgetAuthority,
      listener: {
        async accept({ opportunity }) {
          return {
            listener_evidence_sha256: HASH,
            repair_projection: repairProjection(opportunity.id),
            playback_authority_receipt_sha256: HASH,
            listener_evidence: listenerEvidence,
          };
        },
      },
      now: () => new Date(NOW),
    })).toThrow(/credentials differ/);
  });

  it("rejects authorization, trust-root, qualification, credential, and audio mutations", async () => {
    const { prepare, gateD } = await fixtures();
    const valid = await authorizedPreflight(prepare, undefined, gateD);
    expect(valid).toMatchObject({
      qualification_transport_scope_sha256: prepare.qualification_transport_scope_sha256,
      qualification_claim_boundary: "retained_gate_b_transports_only_xai_finite_manual_not_qualified",
      qualification_scope_verified: true,
      all_episode_transports_qualified: true,
      xai_finite_manual_transport_qualification: "verified",
      xai_finite_manual_gate_d_claim_boundary:
        "transport_qualification_only_not_efficacy_evidence",
    });
    expect(valid.qualification.transport_qualification_scope.excluded_episode_transports).toEqual([
      {
        provider: "xai",
        turn_boundary: "manual_commit",
        purpose: "finite_prerecorded_efficacy",
        reason: "not_exercised_by_retained_server_vad_gate_b",
      },
    ]);
    const base = {
      prepare,
      checked_at: NOW,
      qualification_gate_sha256: valid.qualification_gate_sha256,
      qualification: valid.qualification,
      xai_finite_manual_gate_d: valid.xai_finite_manual_gate_d,
      credential_identity_set_sha256: valid.credential_identity_set_sha256,
      control_plane_manifest_sha256: valid.control_plane_manifest_sha256,
      listener_evidence_manifest_sha256: valid.listener_evidence_manifest_sha256,
      runtime_config_sha256: valid.runtime_config_sha256,
      asr_evaluator_build_sha256: valid.asr_evaluator_build_sha256,
      asr_evaluator_toolchain_sha256: valid.asr_evaluator_toolchain_sha256,
      asr_contract: valid.asr_contract,
      asr_contract_sha256: valid.asr_contract_sha256,
      asr_runner_trust: valid.asr_runner_trust,
      immutable_ledger_genesis_sha256: valid.immutable_ledger_genesis_sha256,
      audio_manifest_sha256: prepare.audio_manifest_sha256,
      authorization: valid.authorization,
      expected_authority_public_key_fingerprint_sha256: valid.authority_trust_root_sha256,
    };
    const nonEd25519Spki = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    }).publicKey.export({ type: "spki", format: "der" });
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      authorization: { ...valid.authorization, signature_base64: Buffer.from("mutated").toString("base64") },
    })).toThrow(/artifact hash mismatch|signature is invalid/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      expected_authority_public_key_fingerprint_sha256: "9".repeat(64),
    })).toThrow(/pinned trust root/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      qualification: { ...valid.qualification, terminal_root_sha256: "9".repeat(64) },
    })).toThrow(/retained qualification(?: v3)? receipt|authorization differs/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      qualification: {
        ...valid.qualification,
        transport_qualification_scope_sha256: "9".repeat(64),
      },
    })).toThrow(/retained qualification(?: v3)? receipt|transport scope|authorization differs/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      credential_identity_set_sha256: "9".repeat(64),
    })).toThrow(/authorization differs/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      runtime_config_sha256: "0".repeat(64),
    })).toThrow(/authorization differs/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      asr_evaluator_build_sha256: "0".repeat(64),
    })).toThrow(/authorization differs/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      asr_evaluator_toolchain_sha256: "0".repeat(64),
    })).toThrow(/authorization differs/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      asr_contract_sha256: "0".repeat(64),
    })).toThrow(/ASR contract hash mismatch/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      asr_contract: {
        ...valid.asr_contract,
        contract_id: "lc4-dev-live-runner-substituted-asr",
      },
    })).toThrow(/ASR contract hash mismatch/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      asr_runner_trust: {
        ...valid.asr_runner_trust,
        key_id: "lc4-dev-live-runner-substituted-asr",
      },
    })).toThrow(/authorization differs/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      asr_runner_trust: {
        ...valid.asr_runner_trust,
        public_key_fingerprint_sha256: "0".repeat(64),
      },
    })).toThrow(/pinned Ed25519 trust root/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      asr_runner_trust: {
        ...valid.asr_runner_trust,
        public_key_spki_base64: Buffer.from("not-an-SPKI").toString("base64"),
      },
    })).toThrow(/SPKI/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      asr_runner_trust: {
        ...valid.asr_runner_trust,
        public_key_spki_base64: nonEd25519Spki.toString("base64"),
        public_key_fingerprint_sha256: sha256Hex(nonEd25519Spki),
      },
    })).toThrow(/Ed25519/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      audio_manifest_sha256: "9".repeat(64),
    })).toThrow(/audio manifest differs/);

    const qualificationInput = {
      plan: valid.qualification.plan,
      authorization: valid.qualification.authorization,
      terminal: valid.qualification.terminal,
      report: valid.qualification.report,
      package_manifest: valid.qualification.package_manifest,
      setup_qualification: valid.qualification.setup_qualification,
      budget_evidence: valid.qualification.budget_evidence,
      spoken_gate_evidence: valid.qualification.spoken_gate_evidence,
      xai_server_vad_gate_b_binding: valid.qualification.xai_server_vad_gate_b_binding,
      qualification_trust_root_sha256: valid.qualification.qualification_trust_root_sha256,
    };
    expect(() => createLc4DevRetainedQualificationReceipt({
      ...qualificationInput,
      plan: {
        ...valid.qualification.plan,
        body: { ...valid.qualification.plan.body, maximum_paid_sessions: 2 as 3 },
      },
    })).toThrow(/hash mismatch/);
    expect(() => createLc4DevRetainedQualificationReceipt({
      ...qualificationInput,
      authorization: {
        ...valid.qualification.authorization,
        body: { ...valid.qualification.authorization.body, maximum_generation_phases: 5 as 6 },
      },
    })).toThrow(/hash mismatch/);
    expect(() => createLc4DevRetainedQualificationReceipt({
      ...qualificationInput,
      terminal: {
        ...valid.qualification.terminal,
        body: { ...valid.qualification.terminal.body, generation_phases_attempted: 5 },
      },
    })).toThrow(/hash mismatch/);
    expect(() => createLc4DevRetainedQualificationReceipt({
      ...qualificationInput,
      report: {
        ...valid.qualification.report,
        complete_attempts: 0,
        partial_attempts: 1,
      },
    })).toThrow(/report is not one completed passing no-retry attempt/);
    expect(() => createLc4DevRetainedQualificationReceipt({
      ...qualificationInput,
      report: {
        ...valid.qualification.report,
        source_commit: "9".repeat(40),
      },
    })).toThrow(/bindings are not exact/);
    expect(() => createLc4DevRetainedQualificationReceipt({
      ...qualificationInput,
      setup_qualification: {
        ...valid.qualification.setup_qualification,
        results: valid.qualification.setup_qualification.results.map((result, index) => (
          index === 0 ? { ...result, model: "mutated-model" } : result
        )),
      },
    })).toThrow(/provider qualification artifact hash mismatch/);
    expect(() => createLc4DevRetainedQualificationReceipt({
      ...qualificationInput,
      spoken_gate_evidence: valid.qualification.spoken_gate_evidence.map((evidence, index) => (
        index === 0 ? { ...evidence, post_tool_terminal_observed: false as true } : evidence
      )),
    })).toThrow(/Gate A\/Gate B evidence differs from its plan/);
    expect(() => createLc4DevRetainedQualificationReceipt({
      ...qualificationInput,
      spoken_gate_evidence: valid.qualification.spoken_gate_evidence.map((evidence, index) => (
        index === 1 ? { ...evidence, turn_boundary_mode: "manual_commit" as const } : evidence
      )),
    })).toThrow(/Gate A\/Gate B evidence differs from its plan/);
    expect(() => createLc4DevRetainedQualificationReceipt({
      ...qualificationInput,
      xai_server_vad_gate_b_binding: {
        ...valid.qualification.xai_server_vad_gate_b_binding,
        gate_b_execution_sha256: "9".repeat(64),
      },
    })).toThrow(/package omits a required admission artifact|Gate B binding or machine claim boundary/);
    expect(() => createLc4DevRetainedQualificationReceipt({
      ...qualificationInput,
      budget_evidence: {
        ...valid.qualification.budget_evidence,
        terminal_outcome: "failed",
      },
    })).toThrow(/budget evidence hash mismatch/);
    expect(() => createLc4DevRetainedQualificationReceipt({
      ...qualificationInput,
      package_manifest: {
        ...valid.qualification.package_manifest,
        body: {
          ...valid.qualification.package_manifest.body,
          entries: valid.qualification.package_manifest.body.entries.map((entry, index) => (
            index === 0 ? { ...entry, sha256: "9".repeat(64) } : entry
          )),
        },
      },
    })).toThrow(/package omits a required admission artifact/);
  });
});

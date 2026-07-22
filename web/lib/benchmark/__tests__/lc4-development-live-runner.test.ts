import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_DEV_ADAPTER_BOUNDARY,
  assertLc4DevLivePrepareArtifact,
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
import { createLc4DevArmBlindRepairProjection } from "../lc4-development-headless-listener-authority";
import {
  LC4_DEV_PINNED_VOICE,
  materializeLc4DevelopmentAudio,
  type Lc4DevAudioRenderer,
} from "../lc4-development-audio-materializer";
import { createLc4DevRepairPlaybackController } from "../lc4-development-repair-playback";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";
import { LC4_PROVIDER_PROFILE_MANIFEST } from "../lc4-provider-profiles";
import {
  LC4_PRODUCTION_PROVIDER_EXECUTION_FROZEN,
  createLc4DevelopmentRealtimeAdapter,
  lc4DevCredentialIdentitySetSha256,
} from "../lc4-production-provider-adapter";
import type { Lc4DevGatewayExecutor } from "../lc4-development-gateway-bridge";
import type { HaccResponsePlan } from "../response-plan";
import {
  createLc4DevReplayEvidenceStore,
  verifyLc4DevReplayLedger,
  type Lc4DevReplayArtifactKind,
  type Lc4DevReplayEvidenceStore,
} from "../lc4-development-evidence-retention";
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
const branchIdentity = Object.freeze({
  key_id: "lc4-dev-live-runner-branch-test",
  private_key_pem: branchKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  public_key_pem: branchKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
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
  const plannedTargets = setupTargets.map((target) => {
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
      production_session_payload_sha256: target.provider === "gemini"
        ? null
        : productionSessionPayloadParitySha256(target.provider, target.configuration),
      xai_transport_parity_sha256: target.provider === "xai"
        ? xaiServerVadTransportParitySha256(
            withXaiServerVadPcmSession(productionOpenAiCompatibleSessionUpdate("xai", target.configuration)),
            target.model,
          )
        : null,
      setup_sessions: 1 as const,
      paid_sessions: 1 as const,
      generation_phases: 2 as const,
      tool_roundtrips: 1 as const,
    };
  });
  const unsignedPlanBody = {
    schema_version: 1 as const,
    runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
    protocol_id: "HACC-LC4-v1" as const,
    plan_id: "lc4-dev-test-qualification-v3",
    prepared_at: "2026-07-21T20:00:00.000Z",
    source,
    provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    setup_configuration_matrix_sha256: providerQualificationMatrixSha256(setupTargets),
    credential_set_sha256: credentialSetSha256,
    credential_identities: credentialIdentities,
    audio_fixture: audioFixture,
    control_size_diagnostic: lc4S2sControlSizeDiagnostic(),
    targets: plannedTargets,
    execution_scope: "gate_a_setup_acceptance_then_gate_b_spoken_tool_roundtrip_gate_c_diagnostic_only" as const,
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
    plan_sha256: sha256Hex(`harshas-amazing-call-center/lc4-qualification-plan/v4\n${canonicalJson(unsignedPlanBody)}`),
  };
  const plan = signArtifact({
    body: planBody,
    privateKey: planAuthority.privateKey,
    publicKey: planAuthority.publicKey,
    signingDomain: "harshas-amazing-call-center/lc4-qualification-plan/v4\n",
    artifactDomain: "harshas-amazing-call-center/lc4-qualification-plan-artifact/v4\n",
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
    signingDomain: "harshas-amazing-call-center/lc4-qualification-authorization/v4\n",
    artifactDomain: "harshas-amazing-call-center/lc4-qualification-authorization-artifact/v4\n",
  }) as Lc4QualificationV3AuthorizationArtifact;

  const setupResults: ProviderQualificationArtifact["results"] = setupTargets.map((target) => {
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
          wire("inbound", 1, "session.created"),
          wire("outbound", 2, requestWireType),
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
  });
  const setupBody = {
    schemaVersion: 3 as const,
    qualificationId: "lc4-dev-v3-setup",
    protocolId: "HACC-LC4-v1",
    planSha256: plan.body.plan_sha256,
    sourceCommit: source.source_commit,
    configurationMatrixSha256: unsignedPlanBody.setup_configuration_matrix_sha256,
    credentialSetSha256: unsignedPlanBody.credential_set_sha256,
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
    turn_boundary_mode: target.provider === "xai" ? "provider_native_server_vad" as const : "manual_commit" as const,
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
    schema_version: 3 as const,
    runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
    terminal_version: "HACC-LC4-QUALIFICATION-TERMINAL-v6" as const,
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
    terminal_sha256: sha256Hex(`harshas-amazing-call-center/lc4-qualification-terminal/v6\n${canonicalJson(unsignedTerminalBody)}`),
  };
  const terminal = signArtifact({
    body: terminalBody,
    privateKey: terminalAuthority.privateKey,
    publicKey: terminalAuthority.publicKey,
    signingDomain: "harshas-amazing-call-center/lc4-qualification-terminal/v6\n",
    artifactDomain: "harshas-amazing-call-center/lc4-qualification-terminal-artifact/v6\n",
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

function authorizedPreflight(prepare: ReturnType<typeof createLc4DevLivePrepareArtifact>, credentialIdentity = "2".repeat(64)) {
  const qualification = qualificationFixture();
  const body = {
    schema_version: 2 as const,
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
    provider_profile_manifest_sha256: prepare.provider_profile_manifest_sha256,
    audio_delivery_profile_sha256: prepare.audio_delivery_profile_sha256,
    audio_packetizer_contract_sha256: prepare.audio_packetizer_contract_sha256,
    audio_execution_contract_sha256: prepare.audio_execution_contract_sha256,
    immutable_ledger_genesis_sha256: "5".repeat(64),
    authorization_nonce_sha256: "8".repeat(64),
    not_before: "2026-07-21T21:00:00.000Z",
    expires_at: "2026-07-22T22:00:00.000Z",
  };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
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
    credential_identity_set_sha256: credentialIdentity,
    control_plane_manifest_sha256: "3".repeat(64),
    listener_evidence_manifest_sha256: "4".repeat(64),
    runtime_config_sha256: "6".repeat(64),
    asr_evaluator_build_sha256: "7".repeat(64),
    asr_evaluator_toolchain_sha256: "9".repeat(64),
    immutable_ledger_genesis_sha256: "5".repeat(64),
    audio_manifest_sha256: prepare.audio_manifest_sha256,
    authorization,
    expected_authority_public_key_fingerprint_sha256: sha256Hex(key),
  });
}

function fixtures() {
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
  });
  const preflight = authorizedPreflight(prepare);
  return { corpus, pcm, prepare, preflight };
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
  it("freezes exactly six paired episodes, 360 opportunities, and at most $15", () => {
    const { prepare } = fixtures();
    expect(prepare.episodes.map((episode) => `${episode.provider}:${episode.arm}`)).toEqual([
      "openai:native", "openai:hacc", "gemini:hacc", "gemini:native", "xai:native", "xai:hacc",
    ]);
    expect(prepare.total_opportunities).toBe(360);
    expect(prepare.maximum_total_micro_usd).toBe(15_000_000);
    expect(prepare.episodes.reduce((sum, episode) => sum + episode.maximum_micro_usd, 0)).toBeLessThanOrEqual(15_000_000);
    expect(prepare.evidence_boundary.efficacy_claim_eligible).toBe(false);
    expect(prepare.schema_version).toBe(2);
    const stale = JSON.parse(canonicalJson(prepare));
    stale.audio_execution_contract_sha256 = "0".repeat(64);
    const staleBody = Object.fromEntries(Object.entries(stale).filter(([key]) => key !== "prepare_sha256"));
    stale.prepare_sha256 = sha256Hex(`harshas-amazing-call-center/lc4-dev-live-prepare/v2\n${canonicalJson(staleBody)}`);
    expect(() => assertLc4DevLivePrepareArtifact(stale)).toThrow("not canonical or internally consistent");
  });

  it("executes the exact closed loop and emits an immutable evidence-complete report", async () => {
    const { pcm, prepare, preflight } = fixtures();
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
          async exchangeCanonical({ opportunity, caller_pcm, control_receipt }) {
            exchanges += 1;
            expect(control_receipt.response_control.kind).toBe(episode.arm === "native" ? "native_context" : "hacc_response_plan");
            expect(caller_pcm).toEqual(pcm.get(`${episode.provider}:${opportunity.id}`));
            if (opportunity.index === 42) {
              expect(opportunity).toMatchObject({ id: "lc4-dev-op-42", index: 42 });
              expect(opportunity.canonical_caller_text).toContain("did not hear a transcript request get submitted");
              expect(opportunity.events.some((event) => event.kind === "authoritative-reconciliation")).toBe(false);
            }
            const assistant = Uint8Array.from([opportunity.index, 2, 4, 8]);
            const providerEvidence = await testJsonEvidence(evidence, "provider_exchange", { episode_id: episode.episode_id, opportunity_id: opportunity.id });
            const listenerEvidence = await testJsonEvidence(evidence, "listener_evidence", { episode_id: episode.episode_id, opportunity_id: opportunity.id });
            return {
              playback_kind: "canonical" as const,
              opportunity_id: opportunity.id,
              assistant_pcm: assistant,
              provider_exchange_sha256: providerEvidence.evidence_sha256,
              listener_evidence_sha256: listenerEvidence.evidence_sha256,
              repair_projection: repairProjection(opportunity.id),
              playback_authority_receipt_sha256: sha256Hex(`authority:${episode.episode_id}:${opportunity.id}`),
              provider_exchange_projection: { episode_id: episode.episode_id, opportunity_id: opportunity.id },
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
      const { pcm, prepare, preflight } = fixtures();
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
            async exchangeCanonical({ opportunity }) {
              expect(pending).toBeNull();
              expect(opportunity.index).toBe(expectedCanonicalOrdinal);
              if (repairedCanonicalOrdinal !== null && episode.episode_id === targetEpisodeId && opportunity.index > repairedCanonicalOrdinal && canonicalAfterRepair === null) {
                canonicalAfterRepair = opportunity.index;
              }
              pending = { opportunity_id: opportunity.id, repair_played: false };
              canonicalExchanges += 1;
              const shouldRepair = episode.episode_id === targetEpisodeId && opportunity.index === 10;
              const semanticResultSha256 = sha256Hex(`semantic-result:${episode.episode_id}:${opportunity.id}`);
              const providerEvidence = await testJsonEvidence(evidence, "provider_exchange", { kind: "canonical", episode_id: episode.episode_id, opportunity_id: opportunity.id });
              const listenerEvidence = await testJsonEvidence(evidence, "listener_evidence", { kind: "canonical", episode_id: episode.episode_id, opportunity_id: opportunity.id });
              return {
                playback_kind: "canonical" as const,
                opportunity_id: opportunity.id,
                assistant_pcm: Uint8Array.from([opportunity.index, 2, 4, 8]),
                provider_exchange_sha256: providerEvidence.evidence_sha256,
                listener_evidence_sha256: listenerEvidence.evidence_sha256,
                repair_projection: createLc4DevArmBlindRepairProjection({
                  opportunity_id: opportunity.id,
                  listener_status: "verified",
                  semantic_result_sha256: semanticResultSha256,
                  semantic_replay_sha256: sha256Hex(`semantic-replay:${episode.episode_id}:${opportunity.id}`),
                  unmet_blocker_codes: shouldRepair ? ["subject_or_goal_unresolved"] : [],
                  final_required_criteria_pass: !shouldRepair,
                }),
                playback_authority_receipt_sha256: sha256Hex(`canonical-authority:${episode.episode_id}:${opportunity.id}`),
                provider_exchange_projection: { kind: "canonical", episode_id: episode.episode_id, opportunity_id: opportunity.id },
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
              const providerEvidence = await testJsonEvidence(evidence, "provider_exchange", { kind: "repair", episode_id: episode.episode_id, opportunity_id: opportunity.id });
              const listenerEvidence = await testJsonEvidence(evidence, "listener_evidence", { kind: "repair", episode_id: episode.episode_id, opportunity_id: opportunity.id });
              return {
                playback_kind: "repair" as const,
                opportunity_id: opportunity.id,
                assistant_pcm: Uint8Array.from([opportunity.index, 6, 10, 14]),
                provider_exchange_sha256: providerEvidence.evidence_sha256,
                listener_evidence_sha256: listenerEvidence.evidence_sha256,
                repair_projection: repairProjection(opportunity.id),
                playback_authority_receipt_sha256: sha256Hex(`repair-authority:${episode.episode_id}:${opportunity.id}`),
                provider_exchange_projection: { kind: "repair", episode_id: episode.episode_id, opportunity_id: opportunity.id },
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
    const { pcm, prepare, preflight } = fixtures();
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
    const { pcm, prepare, preflight } = fixtures();
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
    const { pcm, prepare, preflight } = fixtures();
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
          async exchangeCanonical({ opportunity }) {
            const providerEvidence = await testJsonEvidence(evidence, "provider_exchange", {
              episode_id: episode.episode_id,
              opportunity_id: opportunity.id,
            });
            const listenerEvidence = await testJsonEvidence(evidence, "listener_evidence", {
              episode_id: episode.episode_id,
              opportunity_id: opportunity.id,
            });
            return {
              playback_kind: "canonical" as const,
              opportunity_id: opportunity.id,
              assistant_pcm: Uint8Array.from([opportunity.index, 2, 4, 8]),
              provider_exchange_sha256: providerEvidence.evidence_sha256,
              listener_evidence_sha256: listenerEvidence.evidence_sha256,
              repair_projection: repairProjection(opportunity.id),
              playback_authority_receipt_sha256: sha256Hex(`authority:${episode.episode_id}:${opportunity.id}`),
              provider_exchange_projection: { episode_id: episode.episode_id, opportunity_id: opportunity.id },
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

  it("documents the exact safe source unlock instead of casting DEV as confirmatory", () => {
    expect(LC4_DEV_ADAPTER_BOUNDARY).toEqual(expect.objectContaining({
      code: "dev_specific_adapter_unlocked",
      confirmatory_factory_compile_time_frozen: true,
    }));
  });

  it("constructs only the preflight-bound DEV factory while confirmatory execution remains frozen", async () => {
    const { prepare } = fixtures();
    const credentials = { openai: "test-openai-secret", gemini: "test-gemini-secret", xai: "test-xai-secret" } as const;
    const preflight = authorizedPreflight(prepare, lc4DevCredentialIdentitySetSha256(credentials));
    const evidence = memoryEvidence();
    const listenerEvidence = await testJsonEvidence(evidence, "listener_evidence", { fixture: "factory-construction" });
    const gatewayExecutor: Lc4DevGatewayExecutor = {
      kind: "lc4-dev-arm-aware-gateway-v1",
      manifest_sha256: preflight.control_plane_manifest_sha256,
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

  it("rejects authorization, trust-root, qualification, credential, and audio mutations", () => {
    const { prepare } = fixtures();
    const valid = authorizedPreflight(prepare);
    const base = {
      prepare,
      checked_at: NOW,
      qualification_gate_sha256: valid.qualification_gate_sha256,
      qualification: valid.qualification,
      credential_identity_set_sha256: valid.credential_identity_set_sha256,
      control_plane_manifest_sha256: valid.control_plane_manifest_sha256,
      listener_evidence_manifest_sha256: valid.listener_evidence_manifest_sha256,
      runtime_config_sha256: valid.runtime_config_sha256,
      asr_evaluator_build_sha256: valid.asr_evaluator_build_sha256,
      asr_evaluator_toolchain_sha256: valid.asr_evaluator_toolchain_sha256,
      immutable_ledger_genesis_sha256: valid.immutable_ledger_genesis_sha256,
      audio_manifest_sha256: prepare.audio_manifest_sha256,
      authorization: valid.authorization,
      expected_authority_public_key_fingerprint_sha256: valid.authority_trust_root_sha256,
    };
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

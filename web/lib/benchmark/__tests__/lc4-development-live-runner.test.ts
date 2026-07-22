import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_DEV_ADAPTER_BOUNDARY,
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
  LC4_QUALIFICATION_RUNNER_VERSION,
  createLc4DevAudioQualificationTargets,
  createLc4QualificationTargets,
} from "../lc4-qualification-runner";
import {
  LC4_DEV_AUDIO_CANARY_CONTROL_BYTES,
  LC4_DEV_AUDIO_CANARY_CONTROL_SOURCE_SHA256,
  LC4_DEV_AUDIO_CANARY_PACKETIZER_SHA256,
  lc4DevAudioCanarySpecification,
} from "../provider-dev-audio-canary";
import {
  providerQualificationMatrixSha256,
  providerResponseToolCanaryRequirements,
} from "../provider-qualification";
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
  const targets = createLc4QualificationTargets();
  const devTargets = createLc4DevAudioQualificationTargets();
  const requirements = providerResponseToolCanaryRequirements(targets);
  const plannedTargets = (["openai", "gemini", "xai"] as const).map((provider) => {
    const devTarget = devTargets.find((candidate) => candidate.provider === provider)!;
    const requirement = requirements.find((item) => item.provider === provider)!;
    const specification = lc4DevAudioCanarySpecification(provider, devTarget.model, devTarget.configuration.inputAudioFormat.sampleRateHz);
    return {
      provider,
      model: devTarget.model,
      zero_audio_tool_schema_sha256: requirement.toolSchemaSha256,
      dev_audio_tool_schema_sha256: specification.tool_schema_sha256,
      packetizer_sha256: LC4_DEV_AUDIO_CANARY_PACKETIZER_SHA256,
      audio_delivery_profile_sha256: devTarget.configuration.audioDeliveryProfileHash,
      dev_control_bytes: LC4_DEV_AUDIO_CANARY_CONTROL_BYTES,
      dev_control_sha256: specification.control_sha256,
      dev_control_source_sha256: LC4_DEV_AUDIO_CANARY_CONTROL_SOURCE_SHA256,
      caller_audio_bytes: specification.audio_bytes,
      caller_audio_sha256: specification.audio_sha256,
      response_generations: 2 as const,
      maximum_micro_usd: 1_000_000 as const,
      paid_retry_allowed: false as const,
    };
  });
  const planBody = {
    schema_version: 1 as const,
    runner_version: LC4_QUALIFICATION_RUNNER_VERSION,
    protocol_id: "HACC-LC4-v1" as const,
    plan_id: "lc4-dev-test-qualification",
    prepared_at: "2026-07-21T20:00:00.000Z",
    source_commit: "b".repeat(40),
    source_tree_oid: "c".repeat(40),
    source_tree_sha256: "d".repeat(64),
    provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    configuration_matrix_sha256: providerQualificationMatrixSha256(targets),
    dev_configuration_matrix_sha256: providerQualificationMatrixSha256(devTargets),
    credential_set_sha256: "e".repeat(64),
    credential_identities: ["openai", "gemini", "xai"].map((provider, index) => ({ provider: provider as "openai" | "gemini" | "xai", credential_sha256: String(index + 1).repeat(64) })),
    targets: plannedTargets,
    execution_scope: "development_only_exact_model_handshake_zero_audio_gateway_then_exact_dev_schema_packetized_audio_canary" as const,
    maximum_total_micro_usd: 3_000_000 as const,
    provider_calls_authorized: false as const,
    authorization_required: "pinned_ed25519_development_artifact" as const,
  };
  const plan = { ...planBody, plan_sha256: sha256Hex(`harshas-amazing-call-center/lc4-qualification-plan/v2\n${canonicalJson(planBody)}`) };
  const results = [...plan.targets].sort((a, b) => a.provider.localeCompare(b.provider)).map((target) => ({
    provider: target.provider,
    model: target.model,
    toolSchemaSha256: target.zero_audio_tool_schema_sha256,
    attemptedAt: "2026-07-21T20:01:00.000Z",
    completedAt: "2026-07-21T20:01:01.000Z",
    status: "passed" as const,
    code: "gateway_tool_call_observed" as const,
    callerAudioBytes: 0 as const,
    responseGenerationEvidenceSha256: sha256Hex(`generation:${target.provider}`),
    providerToolCallEvidenceSha256: sha256Hex(`tool:${target.provider}`),
  }));
  const canaryBody = {
    schemaVersion: 1 as const,
    canaryId: "lc4-dev-canary",
    protocolId: "HACC-LC4-v1",
    planSha256: plan.plan_sha256,
    sourceCommit: plan.source_commit,
    configurationMatrixSha256: plan.configuration_matrix_sha256,
    credentialSetSha256: plan.credential_set_sha256,
    probeScope: "paid_response_generation_tool_call_no_caller_audio" as const,
    attemptedAt: "2026-07-21T20:01:00.000Z",
    completedAt: "2026-07-21T20:01:03.000Z",
    status: "passed" as const,
    results,
  };
  const response_tool_canary = { ...canaryBody, artifactSha256: sha256Hex(`harshas-amazing-call-center/provider-response-tool-canary/v1\n${canonicalJson(canaryBody)}`) };
  const terminalBody = {
    schema_version: 1 as const,
    runner_version: LC4_QUALIFICATION_RUNNER_VERSION,
    attempt_id: "lc4-dev-qualification-attempt",
    plan_sha256: plan.plan_sha256,
    authorization_artifact_sha256: "f".repeat(64),
    source_commit: plan.source_commit,
    source_tree_sha256: plan.source_tree_sha256,
    attempted_at: "2026-07-21T20:01:00.000Z",
    completed_at: "2026-07-21T20:01:03.000Z",
    status: "passed" as const,
    qualification_artifact_sha256: "a".repeat(64),
    response_tool_canary_artifact_sha256: response_tool_canary.artifactSha256,
    dev_audio_canary_artifact_sha256: "9".repeat(64),
    caller_audio_bytes: 5_120,
    response_generations_attempted: 6,
    paid_retries_attempted: 0 as const,
    maximum_total_micro_usd: 3_000_000 as const,
    results: results.map((result) => ({
      provider: result.provider,
      model: result.model,
      status: result.status,
      code: result.code,
      wire_observation_count: 1,
      wire_evidence_sha256: sha256Hex(`wire:${result.provider}`),
      usage_event_count: 1,
      usage_evidence_sha256: sha256Hex(`usage:${result.provider}`),
      provider_tool_call_evidence_sha256: result.providerToolCallEvidenceSha256,
    })),
    dev_audio_results: plannedTargets.map((target) => ({
      provider: target.provider,
      model: target.model,
      status: "passed" as const,
      code: "dev_gateway_tool_call_observed" as const,
      caller_audio_bytes: target.caller_audio_bytes,
      response_generation_requested: true,
      tool_schema_sha256: target.dev_audio_tool_schema_sha256,
      packetizer_sha256: target.packetizer_sha256,
      audio_delivery_profile_sha256: target.audio_delivery_profile_sha256,
      control_bytes: target.dev_control_bytes,
      control_sha256: target.dev_control_sha256,
      audio_sha256: target.caller_audio_sha256,
      delivery_complete: true,
      chunk_count: 2,
      wire_observation_count: 4,
      wire_evidence_sha256: sha256Hex(`dev-wire:${target.provider}`),
      usage_event_count: 1,
      usage_evidence_sha256: sha256Hex(`dev-usage:${target.provider}`),
      response_generation_evidence_sha256: sha256Hex(`dev-generation:${target.provider}`),
      provider_tool_call_evidence_sha256: sha256Hex(`dev-tool:${target.provider}`),
      failure_evidence_sha256: sha256Hex(`dev-failure:${target.provider}`),
    })),
  };
  const terminal = { ...terminalBody, terminal_sha256: sha256Hex(`harshas-amazing-call-center/lc4-qualification-terminal/v2\n${canonicalJson(terminalBody)}`) };
  return createLc4DevRetainedQualificationReceipt({ plan, terminal, response_tool_canary });
}

function authorizedPreflight(prepare: ReturnType<typeof createLc4DevLivePrepareArtifact>, credentialIdentity = "2".repeat(64)) {
  const qualification = qualificationFixture();
  const body = {
    schema_version: 1 as const,
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
    expect(createLc4DevLiveReportArtifact(run, COMPLETE_AUTHORITY)).toMatchObject({
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
      expect(createLc4DevLiveReportArtifact(run, COMPLETE_AUTHORITY)).toMatchObject({
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
    expect(createLc4DevLiveReportArtifact(run, COMPLETE_AUTHORITY)).toMatchObject({
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
    const adapter = createLc4DevelopmentRealtimeAdapter({
      prepare,
      preflight,
      credentials,
      gateway_executor: gatewayExecutor,
      evidence,
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
    })).toThrow(/retained qualification receipt|authorization differs/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      credential_identity_set_sha256: "9".repeat(64),
    })).toThrow(/authorization differs/);
    expect(() => createLc4DevLivePreflightArtifact({
      ...base,
      audio_manifest_sha256: "9".repeat(64),
    })).toThrow(/audio manifest differs/);

    const weakenedTerminalBody = { ...valid.qualification.terminal, response_generations_attempted: 2 };
    delete (weakenedTerminalBody as Partial<typeof weakenedTerminalBody>).terminal_sha256;
    const weakenedTerminal = {
      ...weakenedTerminalBody,
      terminal_sha256: sha256Hex(`harshas-amazing-call-center/lc4-qualification-terminal/v2\n${canonicalJson(weakenedTerminalBody)}`),
    };
    expect(() => createLc4DevRetainedQualificationReceipt({
      plan: valid.qualification.plan,
      terminal: weakenedTerminal,
      response_tool_canary: valid.qualification.response_tool_canary,
    })).toThrow(/exact passing three-provider zero-audio plus packetized-audio run/);

    const weakenedDevAudioBody = {
      ...valid.qualification.terminal,
      dev_audio_results: valid.qualification.terminal.dev_audio_results.map((result, index) => (
        index === 0 ? { ...result, delivery_complete: false } : result
      )),
    };
    delete (weakenedDevAudioBody as Partial<typeof weakenedDevAudioBody>).terminal_sha256;
    const weakenedDevAudio = {
      ...weakenedDevAudioBody,
      terminal_sha256: sha256Hex(`harshas-amazing-call-center/lc4-qualification-terminal/v2\n${canonicalJson(weakenedDevAudioBody)}`),
    };
    expect(() => createLc4DevRetainedQualificationReceipt({
      plan: valid.qualification.plan,
      terminal: weakenedDevAudio,
      response_tool_canary: valid.qualification.response_tool_canary,
    })).toThrow(/packetized-audio result differs/u);

    const canaryBody = {
      ...valid.qualification.response_tool_canary,
      results: valid.qualification.response_tool_canary.results.map((result, index) => (
        index === 0 ? { ...result, model: "mutated-model" } : result
      )),
    };
    delete (canaryBody as Partial<typeof canaryBody>).artifactSha256;
    const mutatedCanary = {
      ...canaryBody,
      artifactSha256: sha256Hex(`harshas-amazing-call-center/provider-response-tool-canary/v1\n${canonicalJson(canaryBody)}`),
    };
    expect(() => createLc4DevRetainedQualificationReceipt({
      plan: valid.qualification.plan,
      terminal: valid.qualification.terminal,
      response_tool_canary: mutatedCanary,
    })).toThrow(/result matrix mismatch/);
  });
});

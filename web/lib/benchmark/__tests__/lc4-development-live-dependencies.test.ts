import { generateKeyPairSync } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  compileLc4AuthoritativeObligationManifest,
  createLc4AuthoritativeObligationEpisodeArtifact,
  createLc4AuthorityEvents,
  createLc4AuthorityManifestRegistry,
  type Lc4AuthoritativeObligationManifest,
  type Lc4AuthorityEventType,
  type Lc4AuthorityOutcome,
} from "../lc4-authoritative-obligation-evidence";
import {
  auditLc4PublicDevLiveReadiness,
  assertLc4DevBranchExchangeCheckpoint,
  assertLc4DevFinalControlHorizon,
  createLc4DevelopmentLiveDependencies,
  createLc4HashChainedLedgerWriter,
  createLc4ImmutableCas,
  createLc4PinnedListenerManifestSha256,
  createLc4PinnedListenerSink,
  lc4DevAuthorityToolSubject,
  lc4DevLedgerGenesisSha256,
  replayLc4DevAuthorityReport,
  type Lc4PinnedListenerEvaluator,
} from "../lc4-development-live-dependencies";
import {
  LC4_DEV_CALLER_BRANCH_SOURCES,
  LC4_DEV_PRIOR_MUTATION_OUTCOMES,
  createLc4DevCallerBranchAuthority,
  createLc4DevCallerBranchMatrixArtifact,
  type Lc4DevCallerBranchAudioBinding,
} from "../lc4-development-caller-branch";
import {
  createLc4DevOperatorAuthorizationDag,
  type Lc4DevOperatorSigner,
} from "../lc4-development-operator-cli";
import {
  createLc4DevReplayEvidenceStore,
  verifyLc4DevReplayLedger,
  type Lc4DevReplayEvidenceStore,
  type Lc4DevReplayArtifactReference,
  type Lc4DevReplayLedgerEvent,
} from "../lc4-development-evidence-retention";
import {
  createLc4DevArmBlindRepairProjection,
  createLc4HeadlessListenerPlaybackAuthority,
} from "../lc4-development-headless-listener-authority";
import type {
  Lc4DevImmutableLedgerEvent,
  Lc4DevLiveEpisodePlan,
  Lc4DevLivePreflightArtifact,
  Lc4DevLiveRunArtifact,
} from "../lc4-development-live-runner";
import { createLc4DevLivePrepareArtifact } from "../lc4-development-live-runner";
import {
  LC4_PROVIDER_PROFILE_MANIFEST,
  LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE,
} from "../lc4-provider-profiles";
import {
  benchmarkKernelAttestationPublicKeyFingerprint,
  createBenchmarkKernelAttestationSigner,
} from "../kernel-attestation";
import { createLc4CapturedOutput } from "../lc4-listener-evidence";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";
import { lc4DevelopmentListenerCriterionBindings } from "../lc4-development-listener-semantics";
import {
  LC4_DEVELOPMENT_TEST_SEED_BYTES,
  createLc4GenericHeldoutGenerator,
  type Lc4GenericScenarioPayload,
} from "../lc4-heldout-generator";
import {
  LC4_TEST_ASR_CONTRACT,
  LC4_TEST_ASR_CONTRACT_SHA256,
  createLc4TestAsrRunnerTrust,
} from "./lc4-test-asr-authority";

const LEDGER_EVENT_DOMAIN = "harshas-amazing-call-center/lc4-dev-live-ledger-event/v1\n";
const HASH = "a".repeat(64);
const roots: string[] = [];

function listenerAuthority() {
  const keys = generateKeyPairSync("ed25519");
  return createLc4HeadlessListenerPlaybackAuthority({
    signer: createBenchmarkKernelAttestationSigner({
      keyId: "lc4-dev-headless-listener-test",
      privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    }),
  });
}

function operatorSigner(): Lc4DevOperatorSigner {
  const pair = generateKeyPairSync("ed25519");
  const publicKeySpkiDer = pair.publicKey.export({ type: "spki", format: "der" });
  return Object.freeze({
    private_key: pair.privateKey,
    public_key_spki_der: publicKeySpkiDer,
    public_key_spki_pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    private_key_pkcs8_pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    public_key_fingerprint_sha256: sha256Hex(publicKeySpkiDer),
  });
}

function liveDependencyFactoryFixture(root: string) {
  const corpus = createLc4PublicDevelopmentCorpus();
  const audioBindings = (["openai", "gemini", "xai"] as const).flatMap((provider) =>
    corpus.opportunities.map((opportunity) => ({
      opportunity_id: opportunity.id,
      provider,
      pcm_sha256: sha256Hex(`factory-fixture:${provider}:${opportunity.id}`),
      pcm_byte_length: 2,
      sample_rate_hz: LC4_PROVIDER_PROFILE_MANIFEST.providers[provider].input_sample_rate_hz,
      source_text_sha256: opportunity.canonical_caller_text_sha256,
    })),
  );
  const prepare = createLc4DevLivePrepareArtifact({
    execution_id: "lc4-dev-factory-contract-test",
    created_at: "2026-07-22T06:00:00.000Z",
    source_commit: "1".repeat(40),
    source_tree_sha256: sha256Hex("lc4-dev-factory-contract-tree"),
    audio_manifest_sha256: sha256Hex("lc4-dev-factory-contract-audio"),
    audio_bindings: audioBindings,
    corpus,
    xai_finite_manual_gate_d: {
      receipt_sha256: sha256Hex("synthetic-gate-d-receipt"),
      plan_authority_trust_root_sha256: sha256Hex("synthetic-gate-d-authority"),
      transport_profile_sha256:
        LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256,
    },
  });
  const playbackAuthority = listenerAuthority();
  const evaluator = {
    evaluator_contract_sha256: sha256Hex("lc4-dev-factory-evaluator-contract"),
    evaluator_build_sha256: sha256Hex("lc4-dev-factory-evaluator-build"),
    calibration_sha256: sha256Hex("lc4-dev-factory-evaluator-calibration"),
    async evaluate() { throw new Error("factory construction must not evaluate provider audio"); },
  } as Lc4PinnedListenerEvaluator;
  const criteria = lc4DevelopmentListenerCriterionBindings();
  const listenerManifest = createLc4PinnedListenerManifestSha256({
    corpus_sha256: corpus.artifact_sha256,
    evaluator,
    criteria,
    playback_authority_manifest_sha256: playbackAuthority.authority_manifest_sha256,
  });
  const controlManifest = sha256Hex("lc4-dev-factory-control-manifest");
  const authority = operatorSigner();
  const dag = createLc4DevOperatorAuthorizationDag({
    prepare,
    qualification: {
      terminal_root_sha256: sha256Hex("lc4-dev-factory-qualification-root"),
      retained_artifact_sha256: sha256Hex("lc4-dev-factory-qualification-artifact"),
    } as never,
    credential_identity_set_sha256: sha256Hex("lc4-dev-factory-credentials"),
    roots: {
      control_plane_manifest_sha256: controlManifest,
      listener_evidence_manifest_sha256: listenerManifest,
      runtime_config_sha256: sha256Hex("lc4-dev-factory-runtime-config"),
      asr_evaluator_build_sha256: evaluator.evaluator_build_sha256,
      asr_evaluator_toolchain_sha256: sha256Hex("lc4-dev-factory-evaluator-toolchain"),
      asr_contract: LC4_TEST_ASR_CONTRACT,
      asr_contract_sha256: LC4_TEST_ASR_CONTRACT_SHA256,
      asr_runner_trust: createLc4TestAsrRunnerTrust(
        authority.private_key,
        "lc4-dev-factory-asr-runner",
      ),
    },
    signer: authority,
    authorization_nonce_sha256: sha256Hex("lc4-dev-factory-authorization-nonce"),
    not_before: "2026-07-22T06:00:00.000Z",
    expires_at: "2026-07-22T06:30:00.000Z",
  });
  const preflight = {
    execution_id: prepare.execution_id,
    prepare_sha256: prepare.prepare_sha256,
    preflight_sha256: sha256Hex("lc4-dev-factory-preflight"),
    authorization_artifact_sha256: dag.authorization.artifact_sha256,
    immutable_ledger_genesis_sha256: dag.immutable_ledger_genesis_sha256,
    authority_trust_root_sha256: authority.public_key_fingerprint_sha256,
    control_plane_manifest_sha256: controlManifest,
    listener_evidence_manifest_sha256: listenerManifest,
    runtime_config_sha256:
      dag.authorization.body.runtime_config_sha256,
    asr_evaluator_build_sha256:
      dag.authorization.body.asr_evaluator_build_sha256,
    asr_evaluator_toolchain_sha256:
      dag.authorization.body.asr_evaluator_toolchain_sha256,
    asr_contract: dag.authorization.body.asr_contract,
    asr_contract_sha256:
      dag.authorization.body.asr_contract_sha256,
    asr_runner_trust:
      dag.authorization.body.asr_runner_trust,
    authorization: dag.authorization,
  } as Lc4DevLivePreflightArtifact;
  const authorityKeys = generateKeyPairSync("ed25519");
  const authoritySigner = createBenchmarkKernelAttestationSigner({
    keyId: "lc4-dev-factory-authority",
    privateKeyPem: authorityKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
  const options = {
    prepare,
    preflight,
    corpus,
    cas_root_dir: join(root, "cas"),
    ledger_path: join(root, "ledger.jsonl"),
    caller_audio: { async load() { throw new Error("factory construction must not load audio"); } },
    caller_branch: {
      matrix: { matrix_artifact_sha256: sha256Hex("lc4-dev-factory-branch-matrix") },
      authority: {},
      trust: { key_id: "factory-branch", public_key_pem: "unused" },
      async load() { throw new Error("factory construction must not load branch audio"); },
    },
    authority_signer: authoritySigner,
    control: {
      kind: "gateway-flow-toolworld-crp-workers-v1",
      manifest_sha256: controlManifest,
      gateway_executor: {},
    },
    repair: { openai: {}, gemini: {}, xai: {} },
    criteria,
    evaluator,
    playback_authority: playbackAuthority,
    playback_authority_manifest_sha256: playbackAuthority.authority_manifest_sha256,
    create_adapter() { return {}; },
  } as unknown as Parameters<typeof createLc4DevelopmentLiveDependencies>[0];
  return { dag, options };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "lc4-dev-deps-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function ledgerEvent(
  evidence: Lc4DevReplayEvidenceStore,
  sequence: number,
  previous: string | null,
): Promise<Lc4DevImmutableLedgerEvent> {
  const payload = { fixture: `payload-${sequence}` };
  const payloadEvidence = await evidence.retainJson({ kind: "ledger_payload", body: payload });
  const body = {
    sequence,
    observed_at: "2026-07-21T22:00:00.000Z",
    event_type: sequence === 1 ? "episode_opened" as const : "audio_submitted" as const,
    episode_id: "lc4-dev-openai-native",
    opportunity_id: sequence === 1 ? null : "lc4-dev-op-01",
    payload_sha256: payloadEvidence.evidence_sha256,
    payload_evidence: payloadEvidence,
    evidence_references: Object.freeze([]),
    previous_event_sha256: previous,
  };
  return Object.freeze({
    ...body,
    event_sha256: sha256Hex(`${LEDGER_EVENT_DOMAIN}${canonicalJson(body)}`),
  });
}

function passingAuthorityEntries(manifest: Lc4AuthoritativeObligationManifest) {
  return manifest.obligations.flatMap((entry) => {
    if (entry.kind === "reconciliation_after_ambiguous_commit" || entry.kind === "invalidated_confirmation_never_used") return [];
    const event_type: Lc4AuthorityEventType = entry.kind === "tool_outcome_exact" ? "tool_receipt"
      : entry.kind === "worker_disposition_exact" ? "worker_disposition"
        : entry.kind === "latest_fact_revision" ? "fact_revision" : "terminal_world";
    return [{
      event_type,
      subject_id: entry.subject_id,
      opportunity_index: entry.not_before_opportunity ?? 60,
      outcome: entry.expected_outcome as Lc4AuthorityOutcome,
      value_sha256: entry.expected_value_sha256,
      source_receipt_sha256: sha256Hex(`authority-source:${entry.obligation_id}`),
    }];
  }).sort((left, right) => left.opportunity_index - right.opportunity_index
    || left.subject_id.localeCompare(right.subject_id));
}

async function completeAuthorityReportFixture(root: string, terminalCount = 6) {
  if (!Number.isSafeInteger(terminalCount) || terminalCount < 0 || terminalCount > 6) throw new Error("invalid terminal fixture count");
  const cas = await createLc4ImmutableCas(join(root, "cas"));
  const evidence = createLc4DevReplayEvidenceStore(cas);
  const payload = createLc4GenericHeldoutGenerator({
    executionMode: "development-test-only",
    generatorSourceSha256: sha256Hex("lc4-report-fixture-generator"),
    corpusSchemaSha256: sha256Hex("lc4-report-fixture-schema"),
  }).generate(new Uint8Array(LC4_DEVELOPMENT_TEST_SEED_BYTES))[0]!.payload as Lc4GenericScenarioPayload;
  const manifest = compileLc4AuthoritativeObligationManifest(payload);
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signer = createBenchmarkKernelAttestationSigner({
    keyId: "lc4-report-fixture-key",
    privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem,
  });
  const subjects = Array.from({ length: 6 }, (_, index) => sha256Hex(`authority-report-episode-${index + 1}`));
  const registry = createLc4AuthorityManifestRegistry({
    manifests: [manifest],
    assignments: subjects.map((episodeSubjectSha256) => ({ episode_subject_sha256: episodeSubjectSha256, manifest_sha256: manifest.manifest_sha256 })),
  });
  const registryReference = await evidence.retainJson({ kind: "authority_obligation_manifest", body: registry as never });
  const ledger: Lc4DevReplayLedgerEvent[] = [];
  const artifactReferences: Lc4DevReplayArtifactReference[] = [];
  const append = async (eventType: "episode_opened" | "episode_terminal", episodeId: string, payloadBody: Record<string, unknown>, references: readonly Lc4DevReplayArtifactReference[] = []) => {
    const payloadEvidence = await evidence.retainJson({ kind: "ledger_payload", body: payloadBody as never });
    const body = {
      sequence: ledger.length + 1,
      observed_at: "2026-07-22T06:00:00.000Z",
      event_type: eventType,
      episode_id: episodeId,
      opportunity_id: null,
      payload_sha256: payloadEvidence.evidence_sha256,
      payload_evidence: payloadEvidence,
      evidence_references: Object.freeze([...references]),
      previous_event_sha256: ledger.at(-1)?.event_sha256 ?? null,
    };
    ledger.push(Object.freeze({ ...body, event_sha256: sha256Hex(`${LEDGER_EVENT_DOMAIN}${canonicalJson(body)}`) }));
  };
  for (const [index, episodeSubjectSha256] of subjects.slice(0, terminalCount).entries()) {
    const episodeId = `authority-report-episode-${index + 1}`;
    await append("episode_opened", episodeId, { episode_id: episodeId });
    const preterminal = await verifyLc4DevReplayLedger(ledger, evidence);
    const authorityEvents = createLc4AuthorityEvents(passingAuthorityEntries(manifest));
    const checkpointReference = await evidence.retainJson({
      kind: "authority_source_checkpoint",
      body: {
        episode_subject_sha256: episodeSubjectSha256,
        normalized_events: authorityEvents,
        normalized_event_set_sha256: sha256Hex(canonicalJson(authorityEvents)),
      },
    });
    const artifact = createLc4AuthoritativeObligationEpisodeArtifact({
      manifest,
      episodeSubjectSha256,
      events: authorityEvents,
      signer,
      authorityRoots: {
        retained_ledger_head_sha256: preterminal.ledger_head_sha256,
        ledger_replay_sha256: preterminal.replay_sha256,
        normalized_event_set_sha256: sha256Hex(canonicalJson(authorityEvents)),
        source_checkpoint_evidence_sha256: checkpointReference.evidence_sha256,
        manifest_registry_sha256: registry.registry_sha256,
        episode_subject_assignment_sha256: registry.assignment_sha256,
      },
    });
    const artifactReference = await evidence.retainJson({ kind: "authority_episode_artifact", body: artifact as never });
    artifactReferences.push(artifactReference);
    const finalizationReference = await evidence.retainJson({
      kind: "episode_finalization",
      body: {
        episode: { episode_id: episodeId },
        authority_manifest_registry: registryReference,
        authority_source_checkpoint: checkpointReference,
        authority_episode_artifact: artifactReference,
      },
    });
    await append("episode_terminal", episodeId, { episode_finalization_sha256: finalizationReference.evidence_sha256 }, [finalizationReference]);
  }
  const run = {
    ledger: Object.freeze(ledger),
    ledger_head_sha256: ledger.at(-1)!.event_sha256,
  } as unknown as Lc4DevLiveRunArtifact;
  const preflight = {
    authority_trust_root_sha256: benchmarkKernelAttestationPublicKeyFingerprint(publicKeyPem),
    authorization: {
      authority_public_key_spki_base64: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    },
  } as unknown as Lc4DevLivePreflightArtifact;
  return { cas, run, preflight, artifactReferences };
}

describe("LC4-DEV concrete live dependencies", () => {
  it("joins every retained signed branch field to the exact episode, PCM, and provider exchange", () => {
    const signer = operatorSigner();
    const identity = {
      key_id: "lc4-dev-branch-checkpoint-test",
      private_key_pem: signer.private_key_pkcs8_pem,
      public_key_pem: signer.public_key_spki_pem,
    };
    const bindings = (["openai", "gemini", "xai"] as const).flatMap((provider) =>
      LC4_DEV_PRIOR_MUTATION_OUTCOMES.map((outcome): Lc4DevCallerBranchAudioBinding => {
        const source = LC4_DEV_CALLER_BRANCH_SOURCES.find((candidate) => candidate.prior_outcome === outcome)!;
        return {
          prior_outcome: outcome,
          provider,
          opportunity_id: "lc4-dev-op-42",
          source_id: source.source_id,
          source_text_sha256: source.canonical_caller_text_sha256,
          pcm_sha256: sha256Hex(`branch-checkpoint:${provider}:${outcome}`),
          pcm_byte_length: 4,
          sample_rate_hz: LC4_PROVIDER_PROFILE_MANIFEST.providers[provider].input_sample_rate_hz,
          channels: 1,
          encoding: "pcm16le",
        };
      }),
    );
    const matrix = createLc4DevCallerBranchMatrixArtifact({
      audio_manifest_sha256: sha256Hex("branch-checkpoint-audio-manifest"),
      audio_bindings: bindings,
      signing_identity: identity,
    });
    const authority = createLc4DevCallerBranchAuthority({ matrix, signing_identity: identity });
    const trust = { key_id: identity.key_id, public_key_pem: identity.public_key_pem };
    const corpus = createLc4PublicDevelopmentCorpus();
    const profile = LC4_PROVIDER_PROFILE_MANIFEST.providers.openai;
    const episode: Lc4DevLiveEpisodePlan = {
      episode_id: "lc4-dev-openai-hacc-branch-checkpoint",
      pair_id: "lc4-dev-openai-branch-checkpoint",
      pair_position: 2,
      provider: "openai",
      arm: "hacc",
      model: profile.model,
      voice: profile.voice,
      maximum_micro_usd: 1_000,
      opportunity_binding_set_sha256: sha256Hex("branch-checkpoint-binding-set"),
    };
    const decide = (episodeId: string, provider: "openai" | "gemini" | "xai") => authority.decide({
      episode_id: episodeId,
      provider,
      opportunity: corpus.opportunities[41]!,
      prior_receipt: {
        semantic_opportunity_id: "lc4-dev-op-35",
        tool: "archive.submit_transcript_request",
        outcome: "no_call",
        receipt_sha256: null,
      },
    });
    const decision = decide(episode.episode_id, "openai");
    const providerExchange = {
      opportunity_id: "lc4-dev-op-42",
      provider: "openai",
      caller_pcm_sha256: decision.pcm_sha256,
      caller_pcm_byte_length: decision.pcm_byte_length,
    };
    const valid = {
      decision,
      matrix,
      trust,
      episode,
      caller_pcm_sha256: decision.pcm_sha256,
      caller_pcm_byte_length: decision.pcm_byte_length,
      provider_exchange: providerExchange,
    };
    expect(() => assertLc4DevBranchExchangeCheckpoint(valid)).not.toThrow();
    const mutations = [
      { ...valid, decision: decide("lc4-dev-other-episode", "openai") },
      { ...valid, decision: decide(episode.episode_id, "gemini") },
      { ...valid, caller_pcm_sha256: sha256Hex("different-caller-pcm") },
      { ...valid, caller_pcm_byte_length: 6 },
      { ...valid, provider_exchange: { ...providerExchange, provider: "gemini" } },
      { ...valid, provider_exchange: { ...providerExchange, caller_pcm_sha256: sha256Hex("different-wire-pcm") } },
      { ...valid, provider_exchange: { ...providerExchange, caller_pcm_byte_length: 6 } },
    ];
    for (const mutation of mutations) {
      expect(() => assertLc4DevBranchExchangeCheckpoint(mutation)).toThrow(
        "retained signed branch body differs",
      );
    }
  });

  it("finalizes a complete horizon without censoring unresolved benchmark obligations", () => {
    const episode = { episode_id: "lc4-dev-openai-native", arm: "native" as const };
    expect(() => assertLc4DevFinalControlHorizon({
      ...episode,
      opportunities: 60,
      pending_gateway_actions: 2,
      pending_gateway_obligations: [{ target_tool: "archive.complete_stage" }],
    }, episode)).not.toThrow();
    expect(() => assertLc4DevFinalControlHorizon({
      ...episode,
      opportunities: 59,
      pending_gateway_actions: 0,
      pending_gateway_obligations: [],
    }, episode)).toThrow("identity or horizon differs");
  });

  it("retains rejected argument-free worker attempts as unbound authority events", () => {
    expect(lc4DevAuthorityToolSubject({
      target_tool: "archive.observe_worker_result",
      effective_arguments: null,
    })).toBe("archive.observe_worker_result@unbound");
    expect(lc4DevAuthorityToolSubject({
      target_tool: "archive.launch_worker",
      effective_arguments: {
        launch: { ref: "worker.rights-review" },
      },
    })).toBe("archive.launch_worker@worker.rights-review");
  });

  it("accepts the operator's v3 preflight in the real dependency factory and rejects a stale operator genesis", async () => {
    const root = await temporaryDirectory();
    const { dag, options } = liveDependencyFactoryFixture(root);
    const dependencies = await createLc4DevelopmentLiveDependencies(options);
    expect(dependencies.ledger.genesis_sha256).toBe(dag.immutable_ledger_genesis_sha256);
    await dependencies.finalize();

    const { immutable_ledger_genesis_sha256: _excluded, ...authorizationBody } = options.preflight.authorization.body;
    void _excluded;
    const authorizationBinding = sha256Hex(
      `harshas-amazing-call-center/lc4-dev-authorization-binding/v3\n${canonicalJson(authorizationBody)}`,
    );
    const legacyGenesis = sha256Hex(
      `harshas-amazing-call-center/lc4-dev-ledger-genesis/v3\n${canonicalJson({
        schema_version: 3,
        operator_version: "HACC-LC4-DEV-OPERATOR-v2",
        execution_id: options.prepare.execution_id,
        prepare_sha256: options.prepare.prepare_sha256,
        authorization_binding_sha256: authorizationBinding,
        authority_public_key_fingerprint_sha256: options.preflight.authority_trust_root_sha256,
      })}`,
    );
    const stalePreflight = {
      ...options.preflight,
      immutable_ledger_genesis_sha256: legacyGenesis,
      authorization: {
        ...options.preflight.authorization,
        body: { ...options.preflight.authorization.body, immutable_ledger_genesis_sha256: legacyGenesis },
      },
    };
    await expect(createLc4DevelopmentLiveDependencies({
      ...options,
      preflight: stalePreflight,
      cas_root_dir: join(root, "legacy-cas-must-not-exist"),
      ledger_path: join(root, "legacy-ledger-must-not-exist.jsonl"),
    })).rejects.toThrow("authorization binding or ledger genesis differs from preflight");
    await expect(access(join(root, "legacy-cas-must-not-exist"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, "legacy-ledger-must-not-exist.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a retained run with no authority terminal DAG unscorable, never 0/N", async () => {
    const root = await temporaryDirectory();
    await createLc4ImmutableCas(join(root, "cas"));
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const report = await replayLc4DevAuthorityReport({
      run: { ledger: [], ledger_head_sha256: null } as never,
      preflight: {
        authority_trust_root_sha256: benchmarkKernelAttestationPublicKeyFingerprint(publicKeyPem),
        authorization: {
          authority_public_key_spki_base64: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        },
      } as never,
      cas_root_dir: join(root, "cas"),
    });
    expect(report).toMatchObject({
      status: "unscorable_missing_authority_evidence",
      passed: null,
      evaluated: null,
    });
  });

  it("replays six complete signed authority terminal DAGs from CAS as 6/6", async () => {
    const root = await temporaryDirectory();
    const fixture = await completeAuthorityReportFixture(root);
    await expect(replayLc4DevAuthorityReport({
      run: fixture.run,
      preflight: fixture.preflight,
      cas_root_dir: fixture.cas.root_dir,
    })).resolves.toMatchObject({
      status: "scorable",
      passed: 6,
      evaluated: 6,
      evidence_invalid: 0,
      episode_replay_sha256s: expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/u)]),
    });
  }, 30_000);

  it("returns a null denominator when one nested authority artifact is missing", async () => {
    const root = await temporaryDirectory();
    const fixture = await completeAuthorityReportFixture(root);
    const missing = fixture.artifactReferences[2]!;
    await rm(join(fixture.cas.root_dir, missing.evidence_sha256.slice(0, 2), missing.evidence_sha256));
    await expect(replayLc4DevAuthorityReport({
      run: fixture.run,
      preflight: fixture.preflight,
      cas_root_dir: fixture.cas.root_dir,
    })).resolves.toMatchObject({
      status: "unscorable_missing_authority_evidence",
      passed: null,
      evaluated: null,
      evidence_invalid: 1,
    });
  }, 30_000);

  it("returns a null denominator when one nested authority artifact is tampered", async () => {
    const root = await temporaryDirectory();
    const fixture = await completeAuthorityReportFixture(root);
    const tampered = fixture.artifactReferences[4]!;
    const path = join(fixture.cas.root_dir, tampered.evidence_sha256.slice(0, 2), tampered.evidence_sha256);
    await chmod(path, 0o600);
    await writeFile(path, Buffer.from("tampered-authority-artifact"));
    await expect(replayLc4DevAuthorityReport({
      run: fixture.run,
      preflight: fixture.preflight,
      cas_root_dir: fixture.cas.root_dir,
    })).resolves.toMatchObject({
      status: "unscorable_invalid_authority_evidence",
      passed: null,
      evaluated: null,
      evidence_invalid: 1,
    });
  }, 30_000);

  it("keeps a five-terminal authority run unscorable instead of fabricating 0/5", async () => {
    const root = await temporaryDirectory();
    const fixture = await completeAuthorityReportFixture(root, 5);
    await expect(replayLc4DevAuthorityReport({
      run: fixture.run,
      preflight: fixture.preflight,
      cas_root_dir: fixture.cas.root_dir,
    })).resolves.toMatchObject({
      status: "unscorable_missing_authority_evidence",
      passed: null,
      evaluated: null,
      evidence_invalid: 1,
    });
  }, 30_000);
  it("reports every schema and transport gap instead of treating corpus prose as executable control", () => {
    const audit = auditLc4PublicDevLiveReadiness();
    expect(audit.ready).toBe(false);
    expect(audit.provider_calls_safe).toBe(false);
    expect(audit.gaps.map((gap) => gap.code)).toEqual([
      "public_corpus_missing_benchmark_scenario",
      "public_corpus_missing_agent_flow",
      "public_corpus_missing_compiled_host_managed_condition",
      "public_corpus_missing_toolworld_effect_contracts",
      "public_corpus_missing_rendered_crp_pcm",
      "public_corpus_missing_durable_worker_execution_plan",
      "public_corpus_missing_frozen_semantic_registry",
      "public_corpus_missing_pinned_asr_evaluator",
      "realtime_exchange_missing_repair_playback_channel",
      "listener_handoff_missing_evaluator_consumption_authority",
    ]);
    expect(audit.gaps.every((gap) => gap.detail.length > 40)).toBe(true);
    expect(audit.audit_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("stores immutable content-addressed bytes, verifies deduplication, and detects later corruption", async () => {
    const root = await temporaryDirectory();
    const cas = await createLc4ImmutableCas(join(root, "cas"));
    const bytes = Uint8Array.from([2, 4, 6, 8]);
    const first = await cas.put(bytes, "audio/pcm");
    const second = await cas.put(bytes, "audio/pcm");
    expect(second).toEqual(first);
    expect(await cas.get(first.artifact_sha256)).toEqual(bytes);

    const path = join(cas.root_dir, first.relative_path);
    await chmod(path, 0o600);
    await writeFile(path, Uint8Array.from([9, 9, 9, 9]));
    await expect(cas.get(first.artifact_sha256)).rejects.toThrow("does not match its address");
  });

  it("fsyncs one new hash chain and rejects forks, skips, tampering, and path reuse", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "evidence", "ledger.jsonl");
    const cas = await createLc4ImmutableCas(join(root, "cas"));
    const evidence = createLc4DevReplayEvidenceStore(cas);
    const genesis = lc4DevLedgerGenesisSha256({
      execution_id: "lc4-dev-test",
      prepare_sha256: "1".repeat(64),
      authorization_binding_sha256: "2".repeat(64),
      authority_public_key_fingerprint_sha256: "3".repeat(64),
    });
    const writer = await createLc4HashChainedLedgerWriter({ path, genesis_sha256: genesis, evidence });
    const first = await ledgerEvent(evidence, 1, null);
    const second = await ledgerEvent(evidence, 2, first.event_sha256);
    await writer.append(first);
    await expect(ledgerEvent(evidence, 3, first.event_sha256).then((event) => writer.append(event))).rejects.toThrow("forks, repeats, or skips");
    await expect(writer.append({ ...second, event_sha256: HASH })).rejects.toThrow("event hash is invalid");
    await writer.append(second);
    expect(writer.events()).toEqual([first, second]);
    expect(evidence.retainedReferences("ledger_payload")).toHaveLength(3);
    await writer.close();
    await expect(verifyLc4DevReplayLedger([first, second], evidence)).resolves.toMatchObject({
      event_count: 2,
      ledger_head_sha256: second.event_sha256,
    });
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
    await expect(createLc4HashChainedLedgerWriter({ path, genesis_sha256: genesis, evidence })).rejects.toThrow("already exists");
  });

  it("refuses to append a ledger event when any referenced CAS object is missing or tampered", async () => {
    const root = await temporaryDirectory();
    const cas = await createLc4ImmutableCas(join(root, "cas"));
    const evidence = createLc4DevReplayEvidenceStore(cas);
    const genesis = lc4DevLedgerGenesisSha256({
      execution_id: "lc4-dev-replay-closure",
      prepare_sha256: "1".repeat(64),
      authorization_binding_sha256: "2".repeat(64),
      authority_public_key_fingerprint_sha256: "3".repeat(64),
    });
    const tamperedWriter = await createLc4HashChainedLedgerWriter({
      path: join(root, "tampered.jsonl"),
      genesis_sha256: genesis,
      evidence,
    });
    const tampered = await ledgerEvent(evidence, 1, null);
    const retainedPath = join(cas.root_dir, tampered.payload_sha256.slice(0, 2), tampered.payload_sha256);
    await chmod(retainedPath, 0o600);
    await writeFile(retainedPath, Buffer.from("tampered"));
    await expect(tamperedWriter.append(tampered)).rejects.toThrow(/does not match its address|tampered/);
    await expect(verifyLc4DevReplayLedger([tampered], evidence)).rejects.toThrow(/does not match its address|tampered/);
    await tamperedWriter.close();

    const healthyCas = await createLc4ImmutableCas(join(root, "healthy-cas"));
    const healthyEvidence = createLc4DevReplayEvidenceStore(healthyCas);
    const missingWriter = await createLc4HashChainedLedgerWriter({
      path: join(root, "missing.jsonl"),
      genesis_sha256: genesis,
      evidence: healthyEvidence,
    });
    const valid = await ledgerEvent(healthyEvidence, 1, null);
    const missingReference = {
      ...valid.payload_evidence,
      evidence_sha256: "f".repeat(64),
    };
    const body = {
      ...valid,
      payload_sha256: missingReference.evidence_sha256,
      payload_evidence: missingReference,
    };
    delete (body as Partial<typeof body>).event_sha256;
    const missing = {
      ...body,
      event_sha256: sha256Hex(`${LEDGER_EVENT_DOMAIN}${canonicalJson(body)}`),
    } as Lc4DevImmutableLedgerEvent;
    await expect(missingWriter.append(missing)).rejects.toThrow(/ENOENT|no such file|missing/i);
    await expect(verifyLc4DevReplayLedger([missing], healthyEvidence)).rejects.toThrow(/ENOENT|no such file|missing/i);
    await missingWriter.close();
  });

  it("binds listener evidence to the signed complete-capture handoff and pinned evaluator identity", async () => {
    const root = await temporaryDirectory();
    const cas = await createLc4ImmutableCas(join(root, "cas"));
    const corpus = createLc4PublicDevelopmentCorpus();
    const criteria = lc4DevelopmentListenerCriterionBindings();
    const evaluator: Lc4PinnedListenerEvaluator = {
      evaluator_contract_sha256: "1".repeat(64),
      evaluator_build_sha256: "2".repeat(64),
      calibration_sha256: "3".repeat(64),
      async evaluate({ pcm }) {
        const semanticResultSha256 = "5".repeat(64);
        const transcript = "verified transcript";
        const signedInvocationArtifact = Buffer.from(canonicalJson({
          request: {
            asr_contract_sha256: "1".repeat(64),
            played_sample_count: pcm.byteLength / 2,
            source_played_audio_sha256: sha256Hex(pcm),
          },
          result: {
            source_played_audio_sha256: sha256Hex(pcm),
            transcript,
          },
          receipt: {
            asr_contract_sha256: "1".repeat(64),
            source_played_audio_sha256: sha256Hex(pcm),
            receipt_sha256: "6".repeat(64),
          },
        }), "utf8");
        const retainedInvocation = await cas.put(
          signedInvocationArtifact,
          "application/json",
        );
        return {
          source_pcm_sha256: sha256Hex(pcm),
          source_pcm_byte_length: pcm.byteLength,
          evaluator_contract_sha256: "1".repeat(64),
          evaluator_build_sha256: "2".repeat(64),
          calibration_sha256: "3".repeat(64),
          transcript_sha256: sha256Hex(Buffer.from(transcript, "utf8")),
          semantic_result_sha256: semanticResultSha256,
          signed_invocation_receipt_sha256: "6".repeat(64),
          signed_invocation_artifact_cas_sha256:
            retainedInvocation.artifact_sha256,
          signed_invocation_artifact_byte_length:
            retainedInvocation.byte_length,
          repair_projection: createLc4DevArmBlindRepairProjection({
            opportunity_id: corpus.opportunities[0]!.id,
            listener_status: "verified",
            semantic_result_sha256: semanticResultSha256,
            semantic_replay_sha256: "7".repeat(64),
            unmet_blocker_codes: [],
            final_required_criteria_pass: true,
          }),
        };
      },
    };
    const playbackAuthority = listenerAuthority();
    const playbackAuthorityManifest = playbackAuthority.authority_manifest_sha256;
    const listenerManifest = createLc4PinnedListenerManifestSha256({
      corpus_sha256: corpus.artifact_sha256,
      evaluator,
      criteria,
      playback_authority_manifest_sha256: playbackAuthorityManifest,
    });
    const sink = createLc4PinnedListenerSink({
      corpus,
      listener_manifest_sha256: listenerManifest,
      criteria,
      evaluator,
      playback_authority_manifest_sha256: playbackAuthorityManifest,
      playback_authority: playbackAuthority,
      cas,
    });
    const pcm = Uint8Array.from([1, 2, 3, 4]);
    const capture = createLc4CapturedOutput({
      runId: "lc4-dev-openai-hacc",
      opportunityId: corpus.opportunities[0]!.id,
      responseId: "response-1",
      provider: "openai",
      surface: "server_realtime_pcm",
      sampleRateHz: 24_000,
      chunks: [{ chunkId: "chunk-1", pcm }],
    });
    const episode: Lc4DevLiveEpisodePlan = {
      episode_id: "lc4-dev-openai-hacc",
      pair_id: "lc4-dev-openai",
      pair_position: 2,
      provider: "openai",
      arm: "hacc",
      model: "test-model",
      voice: "test-voice",
      maximum_micro_usd: 1,
      opportunity_binding_set_sha256: "9".repeat(64),
    };
    const receipt = await sink.accept({
      episode,
      opportunity: corpus.opportunities[0]!,
      capture,
      response_plan_sha256: "a".repeat(64),
      wire_observation_set_sha256: "b".repeat(64),
    });
    expect(receipt.listener_evidence_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt).toMatchObject({
      assistant_conversation_transcript: "verified transcript",
      assistant_conversation_transcript_sha256: sha256Hex("verified transcript"),
      assistant_conversation_transcript_source: "listener_exact_captured_pcm_asr",
    });
    expect(await cas.get(sha256Hex(pcm))).toEqual(pcm);
    const encodedEvidence = Buffer.from(
      await cas.get(receipt.listener_evidence_sha256),
    ).toString("utf8");
    const evidenceBody = JSON.parse(
      encodedEvidence.slice(encodedEvidence.indexOf("{")),
    ) as {
      signed_invocation_artifact_cas_sha256: string;
      signed_invocation_artifact_byte_length: number;
      evaluation: {
        signed_invocation_artifact_cas_sha256: string;
        signed_invocation_artifact_byte_length: number;
      };
    };
    expect(evidenceBody.signed_invocation_artifact_cas_sha256)
      .toBe(evidenceBody.evaluation.signed_invocation_artifact_cas_sha256);
    expect(evidenceBody.signed_invocation_artifact_byte_length)
      .toBe(evidenceBody.evaluation.signed_invocation_artifact_byte_length);
    expect(await cas.get(
      evidenceBody.signed_invocation_artifact_cas_sha256,
    )).toHaveLength(evidenceBody.signed_invocation_artifact_byte_length);
    expect(encodedEvidence).not.toContain("verified transcript");
  });

  it("rejects a listener evaluation whose signed invocation CAS length is substituted", async () => {
    const root = await temporaryDirectory();
    const cas = await createLc4ImmutableCas(join(root, "cas"));
    const corpus = createLc4PublicDevelopmentCorpus();
    const criteria = lc4DevelopmentListenerCriterionBindings();
    const evaluator: Lc4PinnedListenerEvaluator = {
      evaluator_contract_sha256: "1".repeat(64),
      evaluator_build_sha256: "2".repeat(64),
      calibration_sha256: "3".repeat(64),
      async evaluate({ pcm }) {
        const transcript = "verified transcript";
        const invocationBytes = Buffer.from(canonicalJson({
          request: {
            asr_contract_sha256: "1".repeat(64),
            played_sample_count: pcm.byteLength / 2,
            source_played_audio_sha256: sha256Hex(pcm),
          },
          result: {
            source_played_audio_sha256: sha256Hex(pcm),
            transcript,
          },
          receipt: {
            asr_contract_sha256: "1".repeat(64),
            source_played_audio_sha256: sha256Hex(pcm),
            receipt_sha256: "6".repeat(64),
          },
        }), "utf8");
        const retained = await cas.put(invocationBytes, "application/json");
        const semanticResultSha256 = "5".repeat(64);
        return {
          source_pcm_sha256: sha256Hex(pcm),
          source_pcm_byte_length: pcm.byteLength,
          evaluator_contract_sha256: "1".repeat(64),
          evaluator_build_sha256: "2".repeat(64),
          calibration_sha256: "3".repeat(64),
          transcript_sha256: sha256Hex(Buffer.from(transcript, "utf8")),
          semantic_result_sha256: semanticResultSha256,
          signed_invocation_receipt_sha256: "6".repeat(64),
          signed_invocation_artifact_cas_sha256:
            retained.artifact_sha256,
          signed_invocation_artifact_byte_length:
            retained.byte_length + 1,
          repair_projection: createLc4DevArmBlindRepairProjection({
            opportunity_id: corpus.opportunities[0]!.id,
            listener_status: "verified",
            semantic_result_sha256: semanticResultSha256,
            semantic_replay_sha256: "7".repeat(64),
            unmet_blocker_codes: [],
            final_required_criteria_pass: true,
          }),
        };
      },
    };
    const playbackAuthority = listenerAuthority();
    const sink = createLc4PinnedListenerSink({
      corpus,
      listener_manifest_sha256: createLc4PinnedListenerManifestSha256({
        corpus_sha256: corpus.artifact_sha256,
        evaluator,
        criteria,
        playback_authority_manifest_sha256:
          playbackAuthority.authority_manifest_sha256,
      }),
      criteria,
      evaluator,
      playback_authority_manifest_sha256:
        playbackAuthority.authority_manifest_sha256,
      playback_authority: playbackAuthority,
      cas,
    });
    const pcm = Uint8Array.from([1, 2, 3, 4]);
    const capture = createLc4CapturedOutput({
      runId: "lc4-dev-openai-native",
      opportunityId: corpus.opportunities[0]!.id,
      responseId: "response-1",
      provider: "openai",
      surface: "server_realtime_pcm",
      sampleRateHz: 24_000,
      chunks: [{ chunkId: "chunk-1", pcm }],
    });
    await expect(sink.accept({
      episode: {
        episode_id: "lc4-dev-openai-native",
        pair_id: "lc4-dev-openai",
        pair_position: 1,
        provider: "openai",
        arm: "native",
        model: "test-model",
        voice: "test-voice",
        maximum_micro_usd: 1,
        opportunity_binding_set_sha256: "9".repeat(64),
      },
      opportunity: corpus.opportunities[0]!,
      capture,
      response_plan_sha256: null,
      wire_observation_set_sha256: "b".repeat(64),
    })).rejects.toThrow(
      "signed ASR invocation artifact is missing, truncated, or hash-invalid",
    );
  });

  it("rejects evaluator evidence produced from bytes other than the complete server-captured PCM", async () => {
    const root = await temporaryDirectory();
    const cas = await createLc4ImmutableCas(join(root, "cas"));
    const corpus = createLc4PublicDevelopmentCorpus();
    const criteria = lc4DevelopmentListenerCriterionBindings();
    const evaluator: Lc4PinnedListenerEvaluator = {
      evaluator_contract_sha256: "1".repeat(64),
      evaluator_build_sha256: "2".repeat(64),
      calibration_sha256: "3".repeat(64),
      async evaluate() {
        return {
          source_pcm_sha256: "f".repeat(64),
          source_pcm_byte_length: 4,
          evaluator_contract_sha256: "1".repeat(64),
          evaluator_build_sha256: "2".repeat(64),
          calibration_sha256: "3".repeat(64),
          transcript_sha256: "4".repeat(64),
          semantic_result_sha256: "5".repeat(64),
          signed_invocation_receipt_sha256: "6".repeat(64),
          signed_invocation_artifact_cas_sha256: "8".repeat(64),
          signed_invocation_artifact_byte_length: 2,
        };
      },
    };
    const playbackAuthority = listenerAuthority();
    const playbackAuthorityManifest = playbackAuthority.authority_manifest_sha256;
    const sink = createLc4PinnedListenerSink({
      corpus,
      listener_manifest_sha256: createLc4PinnedListenerManifestSha256({
        corpus_sha256: corpus.artifact_sha256,
        evaluator,
        criteria,
        playback_authority_manifest_sha256: playbackAuthorityManifest,
      }),
      criteria,
      evaluator,
      playback_authority_manifest_sha256: playbackAuthorityManifest,
      playback_authority: playbackAuthority,
      cas,
    });
    const failedPcm = Uint8Array.from([1, 2, 3, 4]);
    const capture = createLc4CapturedOutput({
      runId: "lc4-dev-openai-native",
      opportunityId: corpus.opportunities[0]!.id,
      responseId: "response-1",
      provider: "openai",
      surface: "server_realtime_pcm",
      sampleRateHz: 24_000,
      chunks: [{ chunkId: "chunk-1", pcm: failedPcm }],
    });
    const episode: Lc4DevLiveEpisodePlan = {
      episode_id: "lc4-dev-openai-native", pair_id: "lc4-dev-openai", pair_position: 1,
      provider: "openai", arm: "native", model: "test-model", voice: "test-voice",
      maximum_micro_usd: 1, opportunity_binding_set_sha256: "9".repeat(64),
    };
    await expect(sink.accept({
      episode,
      opportunity: corpus.opportunities[0]!,
      capture,
      response_plan_sha256: null,
      wire_observation_set_sha256: "b".repeat(64),
    })).rejects.toThrow("did not attest consumption of the exact complete captured PCM");
    expect(await cas.get(sha256Hex(failedPcm))).toEqual(failedPcm);
  });
});

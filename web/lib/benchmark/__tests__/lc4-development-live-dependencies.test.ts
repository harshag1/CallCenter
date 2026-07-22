import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  createLc4HashChainedLedgerWriter,
  createLc4ImmutableCas,
  createLc4PinnedListenerManifestSha256,
  createLc4PinnedListenerSink,
  lc4DevLedgerGenesisSha256,
  replayLc4DevAuthorityReport,
  type Lc4PinnedListenerEvaluator,
} from "../lc4-development-live-dependencies";
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
import {
  benchmarkKernelAttestationPublicKeyFingerprint,
  createBenchmarkKernelAttestationSigner,
} from "../kernel-attestation";
import { createLc4CapturedOutput } from "../lc4-listener-evidence";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";
import {
  LC4_DEVELOPMENT_TEST_SEED_BYTES,
  createLc4GenericHeldoutGenerator,
  type Lc4GenericScenarioPayload,
} from "../lc4-heldout-generator";

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
    const criteria = corpus.opportunities.map((opportunity) => ({
      opportunity_id: opportunity.id,
      criterion_plan_sha256: sha256Hex(`criterion:${opportunity.id}`),
    }));
    const evaluator: Lc4PinnedListenerEvaluator = {
      evaluator_contract_sha256: "1".repeat(64),
      evaluator_build_sha256: "2".repeat(64),
      calibration_sha256: "3".repeat(64),
      async evaluate({ pcm }) {
        const semanticResultSha256 = "5".repeat(64);
        return {
          source_pcm_sha256: sha256Hex(pcm),
          source_pcm_byte_length: pcm.byteLength,
          evaluator_contract_sha256: "1".repeat(64),
          evaluator_build_sha256: "2".repeat(64),
          calibration_sha256: "3".repeat(64),
          transcript_sha256: "4".repeat(64),
          semantic_result_sha256: semanticResultSha256,
          signed_invocation_receipt_sha256: "6".repeat(64),
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
    expect(await cas.get(sha256Hex(pcm))).toEqual(pcm);
  });

  it("rejects evaluator evidence produced from bytes other than the complete server-captured PCM", async () => {
    const root = await temporaryDirectory();
    const cas = await createLc4ImmutableCas(join(root, "cas"));
    const corpus = createLc4PublicDevelopmentCorpus();
    const criteria = corpus.opportunities.map((opportunity) => ({
      opportunity_id: opportunity.id,
      criterion_plan_sha256: sha256Hex(`criterion:${opportunity.id}`),
    }));
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
    const capture = createLc4CapturedOutput({
      runId: "lc4-dev-openai-native",
      opportunityId: corpus.opportunities[0]!.id,
      responseId: "response-1",
      provider: "openai",
      surface: "server_realtime_pcm",
      sampleRateHz: 24_000,
      chunks: [{ chunkId: "chunk-1", pcm: Uint8Array.from([1, 2, 3, 4]) }],
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
  });
});

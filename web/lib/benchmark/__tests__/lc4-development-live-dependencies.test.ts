import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  auditLc4PublicDevLiveReadiness,
  createLc4HashChainedLedgerWriter,
  createLc4ImmutableCas,
  createLc4PinnedListenerManifestSha256,
  createLc4PinnedListenerSink,
  lc4DevLedgerGenesisSha256,
  type Lc4PinnedListenerEvaluator,
} from "../lc4-development-live-dependencies";
import { createLc4HeadlessListenerPlaybackAuthority } from "../lc4-development-headless-listener-authority";
import type { Lc4DevImmutableLedgerEvent, Lc4DevLiveEpisodePlan } from "../lc4-development-live-runner";
import { createBenchmarkKernelAttestationSigner } from "../kernel-attestation";
import { createLc4CapturedOutput } from "../lc4-listener-evidence";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";

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

function ledgerEvent(sequence: number, previous: string | null): Lc4DevImmutableLedgerEvent {
  const body = {
    sequence,
    observed_at: "2026-07-21T22:00:00.000Z",
    event_type: sequence === 1 ? "episode_opened" as const : "audio_submitted" as const,
    episode_id: "lc4-dev-openai-native",
    opportunity_id: sequence === 1 ? null : "lc4-dev-op-01",
    payload_sha256: sha256Hex(`payload-${sequence}`),
    previous_event_sha256: previous,
  };
  return Object.freeze({
    ...body,
    event_sha256: sha256Hex(`${LEDGER_EVENT_DOMAIN}${canonicalJson(body)}`),
  });
}

describe("LC4-DEV concrete live dependencies", () => {
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
    const genesis = lc4DevLedgerGenesisSha256({
      execution_id: "lc4-dev-test",
      prepare_sha256: "1".repeat(64),
      authorization_binding_sha256: "2".repeat(64),
      authority_public_key_fingerprint_sha256: "3".repeat(64),
    });
    const writer = await createLc4HashChainedLedgerWriter({ path, genesis_sha256: genesis });
    const first = ledgerEvent(1, null);
    const second = ledgerEvent(2, first.event_sha256);
    await writer.append(first);
    await expect(writer.append(ledgerEvent(3, first.event_sha256))).rejects.toThrow("forks, repeats, or skips");
    await expect(writer.append({ ...second, event_sha256: HASH })).rejects.toThrow("event hash is invalid");
    await writer.append(second);
    await writer.close();
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
    await expect(createLc4HashChainedLedgerWriter({ path, genesis_sha256: genesis })).rejects.toThrow("already exists");
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
        return {
          source_pcm_sha256: sha256Hex(pcm),
          source_pcm_byte_length: pcm.byteLength,
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

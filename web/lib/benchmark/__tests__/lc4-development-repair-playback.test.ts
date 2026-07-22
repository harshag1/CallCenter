import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import type { ConditionBlindListenerObservation } from "../audible-evidence";
import {
  LC4_DEV_PINNED_VOICE,
  materializeLc4DevelopmentAudio,
  type Lc4DevAudioRenderer,
} from "../lc4-development-audio-materializer";
import { createLc4DevRepairPlaybackController } from "../lc4-development-repair-playback";
import { createLc4DevArmBlindRepairProjection } from "../lc4-development-headless-listener-authority";
import {
  LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
  LC4_DEV_LISTENER_SEMANTIC_BUNDLE,
  replayLc4DevelopmentListenerObservation,
} from "../lc4-development-listener-semantics";
import type { Lc4DevControlReceipt, Lc4DevLiveEpisodePlan } from "../lc4-development-live-runner";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";

const OBSERVATION_DOMAIN = "hacc/condition-blind-listener-observation/v1\n";
const roots: string[] = [];

function pcm(sampleRate: 16_000 | 24_000 | 48_000, seed: number): Uint8Array {
  const samples = Math.floor(sampleRate * 0.1);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) view.setInt16(index * 2, Math.round(Math.sin((index + seed) / 7) * 7_000), true);
  return bytes;
}

const renderer: Lc4DevAudioRenderer = Object.freeze({
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
    return { master48k: pcm(48_000, seed), pcm16k: pcm(16_000, seed), pcm24k: pcm(24_000, seed) };
  },
});

function replay(opportunityId: string, transcript: string) {
  const planned = LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities.find((item) => item.opportunity_id === opportunityId)!;
  const bytes = pcm(24_000, Number.parseInt(opportunityId.slice(-2), 10));
  const body = {
    schema_version: 1 as const,
    source: "independent_played_pcm_asr" as const,
    status: "verified" as const,
    observation_id: sha256Hex(`observation:${opportunityId}`),
    played_pcm_sha256: sha256Hex(bytes),
    played_through_sample: bytes.byteLength / 2,
    transcript,
    transcript_sha256: sha256Hex(Buffer.from(transcript)),
    timed_spans: [{
      span_id: "span-1",
      text: transcript,
      utf8_start: 0,
      utf8_end: Buffer.byteLength(transcript),
      audio_start_sample: 0,
      audio_end_sample: bytes.byteLength / 2,
      confidence_ppm: 990_000,
    }],
  };
  const observation = {
    ...body,
    evidence_sha256: sha256Hex(`${OBSERVATION_DOMAIN}${canonicalJson(body)}`),
  } as Extract<ConditionBlindListenerObservation, { status: "verified" }>;
  return replayLc4DevelopmentListenerObservation({
    opportunity_id: opportunityId,
    criterion_plan_sha256: planned.criterion_plan_sha256,
    source_pcm_sha256: sha256Hex(bytes),
    source_pcm_byte_length: bytes.byteLength,
    evaluator_contract_sha256: sha256Hex("contract"),
    evaluator_build_sha256: LC4_DEV_LISTENER_EVALUATOR_BUILD_SHA256,
    calibration_sha256: sha256Hex("calibration"),
    signed_invocation_receipt_sha256: sha256Hex("invocation"),
    observation,
  });
}

function projection(opportunityId: string, transcript: string) {
  const artifact = replay(opportunityId, transcript);
  return createLc4DevArmBlindRepairProjection({
    opportunity_id: opportunityId,
    listener_status: "verified",
    semantic_result_sha256: artifact.artifact_sha256,
    semantic_replay_sha256: artifact.semantic_replay.replay_sha256,
    unmet_blocker_codes: artifact.semantic_replay.earliest_unmet_crp_blocker === null ? [] : [artifact.semantic_replay.earliest_unmet_crp_blocker],
    final_required_criteria_pass: artifact.final_required_criteria_pass,
  });
}

function control(index: number): Lc4DevControlReceipt {
  const instructions = `native context ${index}`;
  return {
    response_control: { kind: "native_context", instructions, instructions_sha256: sha256Hex(instructions) },
    flow_state_sha256: sha256Hex(`flow:${index}`),
    gateway_transcript_head_sha256: sha256Hex(`gateway:${index}`),
    tool_world_state_sha256: sha256Hex(`world:${index}`),
    worker_state_sha256: sha256Hex(`worker:${index}`),
    repair_state_sha256: sha256Hex(`repair:${index}`),
    native_continuity_state_sha256: sha256Hex(`common:${index}`),
    control_receipt_sha256: sha256Hex(`control:${index}`),
  };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("LC4-DEV same-opportunity repair playback", () => {
  it("selects only after canonical listener evidence and binds exact provider PCM without extending or recursing", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hacc-lc4-dev-repair-"));
    roots.push(parent);
    const outputRoot = join(parent, "audio");
    const audio = await materializeLc4DevelopmentAudio({ outputRoot, renderer });
    const corpus = createLc4PublicDevelopmentCorpus();
    const episode: Lc4DevLiveEpisodePlan = {
      episode_id: "lc4-dev-openai-native",
      pair_id: "lc4-dev-openai",
      pair_position: 1,
      provider: "openai",
      arm: "native",
      model: "test-openai",
      voice: "alloy",
      maximum_micro_usd: 1_000_000,
      opportunity_binding_set_sha256: sha256Hex("bindings"),
    };
    const controller = createLc4DevRepairPlaybackController({
      provider: "openai",
      audio_manifest: audio.manifest,
      repair_manifest: audio.repairManifest,
      async load_repair_pcm(binding) { return new Uint8Array(await readFile(join(outputRoot, binding.pcm_path))); },
    });

    for (const opportunity of corpus.opportunities.slice(0, 9)) {
      const criteria = LC4_DEV_LISTENER_SEMANTIC_BUNDLE.plan.opportunities[opportunity.index - 1]!.criteria;
      const transcript = criteria.map((criterion) => criterion.phrases[0]).join(" ") || "acknowledged";
      const result = await controller.decide({
        episode,
        opportunity,
        control_receipt: control(opportunity.index),
        canonical_exchange_sha256: sha256Hex(`exchange:${opportunity.index}`),
        canonical_listener_evidence_sha256: sha256Hex(`listener:${opportunity.index}`),
        listener_projection: projection(opportunity.id, transcript),
      });
      expect(result.playback).toBeNull();
    }

    const opportunity = corpus.opportunities[9]!;
    const selected = await controller.decide({
      episode,
      opportunity,
      control_receipt: control(10),
      canonical_exchange_sha256: sha256Hex("exchange:10"),
      canonical_listener_evidence_sha256: sha256Hex("listener:10"),
      listener_projection: projection(opportunity.id, "I am not sure."),
    });
    expect(selected.playback).toMatchObject({
      kind: "repair",
      blocker_code: "subject_or_goal_unresolved",
      repair_ordinal: 1,
      advances_canonical_horizon: false,
      recursive_repair_allowed: false,
      sample_rate_hz: 24_000,
    });
    expect(controller.state(episode.episode_id).repair_count).toBe(1);
    await expect(controller.decide({
      episode,
      opportunity: corpus.opportunities[10]!,
      control_receipt: control(11),
      canonical_exchange_sha256: sha256Hex("exchange:11"),
      canonical_listener_evidence_sha256: sha256Hex("listener:11"),
      listener_projection: projection("lc4-dev-op-11", "not verified"),
    })).rejects.toThrow("must complete");

    const playback = selected.playback!;
    expect(() => controller.complete({
      playback: { ...playback, pcm: Uint8Array.from(playback.pcm).fill(0) },
      provider_exchange_sha256: sha256Hex("repair-exchange"),
      listener_evidence_sha256: sha256Hex("repair-listener"),
      playback_authority_receipt_sha256: sha256Hex("playback-authority"),
      recursive_repair_observation: null,
    })).toThrow("differs from the pending selection");

    const receipt = controller.complete({
      playback,
      provider_exchange_sha256: sha256Hex("repair-exchange"),
      listener_evidence_sha256: sha256Hex("repair-listener"),
      playback_authority_receipt_sha256: sha256Hex("playback-authority"),
      recursive_repair_observation: null,
    });
    expect(receipt).toMatchObject({
      canonical_ordinal: 10,
      canonical_horizon: 60,
      advances_canonical_horizon: false,
      recursive_repair_observation: null,
      submitted_pcm_sha256: playback.pcm_sha256,
    });
    expect(receipt.playback_receipt_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => controller.complete({
      playback,
      provider_exchange_sha256: sha256Hex("repair-exchange"),
      listener_evidence_sha256: sha256Hex("repair-listener"),
      playback_authority_receipt_sha256: sha256Hex("playback-authority"),
      recursive_repair_observation: null,
    })).toThrow("absent, duplicated");
  }, 30_000);
});

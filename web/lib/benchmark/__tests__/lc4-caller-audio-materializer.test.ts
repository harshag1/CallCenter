import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../artifacts";
import {
  LC4_CALLER_INPUT_ROUTES,
  LC4_LOCAL_TTS_VOICES,
  assertAuthorizedUnsealedLc4AudioCorpus,
  createAuthorizedLc4AudioCorpusFromGeneratedTemplates,
  lc4AuthorizedAudioCorpusSha256,
  materializeLc4CallerAudio,
  type AuthorizedUnsealedLc4AudioCorpus,
  type Lc4LocalAudioRenderer,
  type Lc4TtsVoiceSlot,
} from "../lc4-caller-audio-materializer";
import {
  LC4_DEVELOPMENT_TEST_SEED_BYTES,
  LC4_NORMATIVE_BLOCKER_CODES,
  createLc4GenericHeldoutGenerator,
} from "../lc4-heldout-generator";

const roots: string[] = [];

function corpus(): AuthorizedUnsealedLc4AudioCorpus {
  const slots = Object.keys(LC4_LOCAL_TTS_VOICES) as Lc4TtsVoiceSlot[];
  const templates = Array.from({ length: 24 }, (_, templateIndex) => {
    const caller_utterances = Array.from({ length: 60 }, (_, index) => {
      const text = `Shared canonical caller utterance ${index + 1}.`;
      return Object.freeze({
        id: `caller.${String(index + 1).padStart(2, "0")}`,
        text,
        source_text_sha256: sha256Hex(text),
        ordinal: index + 1,
        canonical_opportunity_id: `opportunity.${String(index + 1).padStart(2, "0")}`,
        stage_id: `checkpoint.${String(Math.floor(index / 5) + 1).padStart(2, "0")}`,
        act: (["establish", "interleave", "reconcile"] as const)[Math.floor(index / 20)],
        segment_ordinal: (Math.floor(index / 20) + 1) as 1 | 2 | 3,
        spoken_fact_ids: Object.freeze([`fact.${String(index + 1).padStart(2, "0")}`]),
      });
    });
    const repair_utterances = Array.from({ length: 12 }, (_, stageIndex) => (
      LC4_NORMATIVE_BLOCKER_CODES.flatMap((blocker) => ([1, 2] as const).map((ordinal) => {
        const stage = `checkpoint.${String(stageIndex + 1).padStart(2, "0")}`;
        const text = `Shared bounded repair ${ordinal} for ${stage} and ${blocker}.`;
        return Object.freeze({
          id: `repair.${stage}.${blocker}.${ordinal}`,
          stage_id: stage,
          blocker_code: blocker,
          repair_ordinal: ordinal,
          repeated_spoken_fact_ids: Object.freeze([]),
          text,
          source_text_sha256: sha256Hex(text),
        });
      }))
    )).flat();
    return Object.freeze({
      template_id: `lc4-template-${String(templateIndex + 1).padStart(2, "0")}`,
      tts_voice_slot: slots[Math.floor(templateIndex / 8)],
      caller_utterances: Object.freeze(caller_utterances),
      repair_utterances: Object.freeze(repair_utterances),
    });
  });
  return Object.freeze({
    schema_version: 1,
    protocol_id: "HACC-LC4-v1",
    authorization: Object.freeze({
      scope: "local_caller_audio_materialization_only",
      authorization_receipt_sha256: "a".repeat(64),
      provider_calls_authorized: false,
      plaintext_logging_authorized: false,
    }),
    templates: Object.freeze(templates),
    corpus_sha256: lc4AuthorizedAudioCorpusSha256(templates),
  });
}

function renderer(fail = false): Lc4LocalAudioRenderer {
  return Object.freeze({
    identity: Object.freeze({ renderer: "injected-test-renderer", identity_sha256: "b".repeat(64) }),
    assertReady: () => undefined,
    async renderSourceMaster({ text, voice, outputPath }) {
      if (fail) throw new Error("injected renderer failure");
      const digest = sha256Hex(`${voice.name}\n${text}`);
      await writeFile(outputPath, Buffer.from(digest.slice(0, 32), "hex"));
    },
    async transcodeSourceMaster({ inputPath, outputPath, sampleRateHz }) {
      const input = await readFile(inputPath);
      const digest = sha256Hex(Buffer.concat([input, Buffer.from(String(sampleRateHz))]));
      await writeFile(outputPath, Buffer.from(digest.slice(0, 32), "hex"));
    },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LC4 local caller audio materializer", () => {
  it("adapts generated templates with exact plan identities and canonical caller text", () => {
    const generated = createLc4GenericHeldoutGenerator({
      executionMode: "development-test-only",
      generatorSourceSha256: "d".repeat(64),
      corpusSchemaSha256: "e".repeat(64),
    }).generate(LC4_DEVELOPMENT_TEST_SEED_BYTES);
    const adapted = createAuthorizedLc4AudioCorpusFromGeneratedTemplates({
      templates: generated,
      authorizationReceiptSha256: "f".repeat(64),
    });
    expect(() => assertAuthorizedUnsealedLc4AudioCorpus(adapted)).not.toThrow();
    expect(adapted.templates.map((template) => template.template_id)).toEqual(generated.map((template) => template.template_id));
    expect(adapted.templates[0]!.caller_utterances).toHaveLength(60);
    expect(adapted.templates[0]!.caller_utterances[0]!.text).toContain("subject_id");
    expect(adapted.templates[0]!.repair_utterances).toHaveLength(192);
  }, 30_000);

  it("accepts generator-defined checkpoint deadlines but rejects nonjoining canonical stages", () => {
    const valid = corpus();
    const first = valid.templates[0]!;
    const brokenCaller = first.caller_utterances.map((item, index) => (
      index === 20 ? { ...item, stage_id: "checkpoint.99" } : item
    ));
    const brokenTemplates = [{ ...first, caller_utterances: brokenCaller }, ...valid.templates.slice(1)];
    expect(() => assertAuthorizedUnsealedLc4AudioCorpus({
      ...valid,
      templates: brokenTemplates,
      corpus_sha256: lc4AuthorizedAudioCorpusSha256(brokenTemplates),
    })).toThrow("does not join the registered repair stages");
  });

  it("validates full three-voice and all-possible-repair coverage", () => {
    const valid = corpus();
    expect(() => assertAuthorizedUnsealedLc4AudioCorpus(valid)).not.toThrow();
    const first = valid.templates[0];
    const incompleteTemplates = [
      { ...first, repair_utterances: first.repair_utterances.slice(1) },
      ...valid.templates.slice(1),
    ];
    expect(() => assertAuthorizedUnsealedLc4AudioCorpus({
      ...valid,
      templates: incompleteTemplates,
      corpus_sha256: lc4AuthorizedAudioCorpusSha256(incompleteTemplates),
    })).toThrow("repair library is incomplete");
  });

  it("atomically publishes content-addressed provider renditions and ASR hooks without plaintext", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hacc-lc4-audio-"));
    roots.push(parent);
    const outputRoot = join(parent, "published");
    let calibrationHookCalls = 0;
    const calibrationHookSamples: Array<{
      sourceTextSha256: string;
      referenceTextSha256: string;
      pcmSha256: string;
      observedPcmSha256: string;
    }> = [];
    const result = await materializeLc4CallerAudio({
      corpus: corpus(),
      outputRoot,
      renderer: renderer(),
      toolchainSha256: "c".repeat(64),
      onAsrCalibrationUnit({ unit, referenceText, pcm }) {
        calibrationHookCalls += 1;
        // Count every hook, but hash only representative samples. Rehashing all
        // 18,144 tiny buffers adds test-runner CPU contention without improving
        // the full-shape coverage assertion below.
        if (calibrationHookSamples.length < 3) calibrationHookSamples.push({
          sourceTextSha256: unit.source_text_sha256,
          referenceTextSha256: sha256Hex(referenceText),
          pcmSha256: unit.pcm_sha256,
          observedPcmSha256: sha256Hex(pcm),
        });
      },
    });

    expect(result.manifest.fixtures).toHaveLength(24 * (60 + 192));
    expect(result.asrPlan.units).toHaveLength(24 * (60 + 192) * 3);
    expect(calibrationHookCalls).toBe(result.asrPlan.units.length);
    expect(calibrationHookSamples.every((sample) => (
      sample.sourceTextSha256 === sample.referenceTextSha256
      && sample.pcmSha256 === sample.observedPcmSha256
    ))).toBe(true);
    expect(result.manifest.provider_calls_made).toBe(false);
    expect(result.manifest.plaintext_retained).toBe(false);
    const first = result.manifest.fixtures[0];
    expect(first.provider_renditions.openai.sample_rate_hz).toBe(LC4_CALLER_INPUT_ROUTES.openai.sampleRateHz);
    expect(first.provider_renditions.gemini.sample_rate_hz).toBe(LC4_CALLER_INPUT_ROUTES.gemini.sampleRateHz);
    expect(first.provider_renditions.xai.sha256).toBe(first.provider_renditions.openai.sha256);
    expect(await readFile(join(outputRoot, "manifest.json"), "utf8")).not.toContain("Shared canonical caller utterance");
    expect(await readFile(join(outputRoot, "asr-input-calibration-plan.json"), "utf8")).not.toContain("Shared bounded repair");
    await expect(materializeLc4CallerAudio({
      corpus: corpus(),
      outputRoot,
      renderer: renderer(),
      toolchainSha256: "c".repeat(64),
    })).rejects.toThrow("refusing overwrite");
  }, 120_000);

  it("removes staging and publishes nothing after renderer failure", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hacc-lc4-audio-"));
    roots.push(parent);
    const outputRoot = join(parent, "failed");
    await expect(materializeLc4CallerAudio({
      corpus: corpus(),
      outputRoot,
      renderer: renderer(true),
      toolchainSha256: "c".repeat(64),
    })).rejects.toThrow("injected renderer failure");
    await expect(readFile(join(outputRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

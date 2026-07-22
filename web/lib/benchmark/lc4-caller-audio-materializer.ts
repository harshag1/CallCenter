import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { canonicalJson, sha256Hex } from "./artifacts";
import {
  LC4_NORMATIVE_BLOCKER_CODES,
  assertLc4GenericScenarioPayload,
  type Lc4GenericScenarioPayload,
} from "./lc4-heldout-generator";
import type { Lc4GeneratedHeldoutTemplate } from "./lc4-heldout-commitment";
import { LC4_PROVIDER_PROFILE_MANIFEST } from "./lc4-provider-profiles";
import type { LiveStsProvider } from "./live-sts-development-experiment";

const CORPUS_DOMAIN = "hacc/lc4/authorized-unsealed-audio-corpus/v1\n";
const MANIFEST_DOMAIN = "hacc/lc4/local-caller-audio-manifest/v1\n";
const ASR_PLAN_DOMAIN = "hacc/lc4/input-asr-calibration-plan/v1\n";
const TOOLCHAIN_DOMAIN = "hacc/lc4/local-caller-audio-toolchain/v1\n";
const PROVIDER_RENDITION_DOMAIN = "hacc/lc4/caller-provider-rendition/v1\n";
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SOURCE_SAMPLE_RATE_HZ = 48_000 as const;
const MAX_PCM_BYTES = 64 * 1024 * 1024;

export const LC4_LOCAL_TTS_VOICES = Object.freeze({
  "tts-slot-1": Object.freeze({ name: "Samantha", locale: "en_US", wordsPerMinute: 205 }),
  "tts-slot-2": Object.freeze({ name: "Daniel", locale: "en_GB", wordsPerMinute: 200 }),
  "tts-slot-3": Object.freeze({ name: "Karen", locale: "en_AU", wordsPerMinute: 200 }),
} as const);

export type Lc4TtsVoiceSlot = keyof typeof LC4_LOCAL_TTS_VOICES;

export const LC4_CALLER_INPUT_ROUTES = Object.freeze({
  openai: Object.freeze({ sampleRateHz: 24_000 as const }),
  gemini: Object.freeze({ sampleRateHz: 16_000 as const }),
  xai: Object.freeze({ sampleRateHz: 24_000 as const }),
} satisfies Record<LiveStsProvider, { sampleRateHz: 16_000 | 24_000 }>);

type AuthorizedLc4TextSource = Readonly<{
  id: string;
  text: string;
  source_text_sha256: string;
}>;

export type AuthorizedLc4CallerSource = AuthorizedLc4TextSource & Readonly<{
  ordinal: number;
  canonical_opportunity_id: string;
  stage_id: string;
  act: "establish" | "interleave" | "reconcile";
  segment_ordinal: 1 | 2 | 3;
  spoken_fact_ids: readonly string[];
}>;

export type AuthorizedLc4RepairSource = AuthorizedLc4TextSource & Readonly<{
  stage_id: string;
  blocker_code: typeof LC4_NORMATIVE_BLOCKER_CODES[number];
  repair_ordinal: 1 | 2;
  repeated_spoken_fact_ids: readonly string[];
}>;

export type AuthorizedUnsealedLc4Template = Readonly<{
  template_id: string;
  tts_voice_slot: Lc4TtsVoiceSlot;
  caller_utterances: readonly AuthorizedLc4CallerSource[];
  repair_utterances: readonly AuthorizedLc4RepairSource[];
}>;

/**
 * This is deliberately an input interface, not an unseal API. A separate
 * custodian must authorize and supply the plaintext corpus in memory.
 */
export type AuthorizedUnsealedLc4AudioCorpus = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC4-v1";
  authorization: Readonly<{
    scope: "local_caller_audio_materialization_only";
    authorization_receipt_sha256: string;
    provider_calls_authorized: false;
    plaintext_logging_authorized: false;
  }>;
  templates: readonly AuthorizedUnsealedLc4Template[];
  corpus_sha256: string;
}>;

export type Lc4LocalAudioToolchain = Readonly<{
  say_path: string;
  say_sha256: string;
  ffmpeg_path: string;
  ffmpeg_sha256: string;
}>;

export type Lc4PcmObject = Readonly<{
  path: string;
  sha256: string;
  byte_length: number;
  sample_rate_hz: 16_000 | 24_000 | 48_000;
  channels: 1;
  encoding: "pcm16le";
  duration_ms: number;
}>;

export type Lc4CallerAudioFixture = Readonly<{
  fixture_id: string;
  template_id: string;
  source_kind: "canonical" | "repair";
  source_id: string;
  source_text_sha256: string;
  tts_voice_slot: Lc4TtsVoiceSlot;
  voice: typeof LC4_LOCAL_TTS_VOICES[Lc4TtsVoiceSlot];
  canonical_binding: Readonly<{
    ordinal: number;
    canonical_opportunity_id: string;
    stage_id: string;
    act: "establish" | "interleave" | "reconcile";
    segment_ordinal: 1 | 2 | 3;
    spoken_fact_ids: readonly string[];
  }> | null;
  repair_binding: Readonly<{
    stage_id: string;
    blocker_code: typeof LC4_NORMATIVE_BLOCKER_CODES[number];
    repair_ordinal: 1 | 2;
    repeated_spoken_fact_ids: readonly string[];
  }> | null;
  source_master: Lc4PcmObject;
  provider_renditions: Readonly<Record<LiveStsProvider, Lc4PcmObject & Readonly<{
    provider: LiveStsProvider;
    provider_profile_sha256: string;
    transform_sha256: string;
  }>>>;
}>;

export type Lc4InputAsrCalibrationUnit = Readonly<{
  calibration_unit_id: string;
  fixture_id: string;
  template_id: string;
  source_kind: "canonical" | "repair";
  source_id: string;
  source_text_sha256: string;
  tts_voice_slot: Lc4TtsVoiceSlot;
  provider: LiveStsProvider;
  route_id: string;
  pcm_path: string;
  pcm_sha256: string;
  byte_length: number;
  sample_rate_hz: 16_000 | 24_000;
  calibration_status: "pending_independent_asr";
}>;

export type Lc4InputAsrCalibrationHook = (input: Readonly<{
  unit: Lc4InputAsrCalibrationUnit;
  /** Plaintext is callback-only and never serialized by this materializer. */
  referenceText: string;
  pcm: Uint8Array;
}>) => void | Promise<void>;

export type Lc4LocalAudioRenderer = Readonly<{
  identity: Readonly<{
    renderer: "macos-say-ffmpeg-pcm16le-v1" | "injected-test-renderer";
    identity_sha256: string;
  }>;
  assertReady(): void | Promise<void>;
  renderSourceMaster(input: Readonly<{
    text: string;
    voice: typeof LC4_LOCAL_TTS_VOICES[Lc4TtsVoiceSlot];
    outputPath: string;
  }>): void | Promise<void>;
  transcodeSourceMaster(input: Readonly<{
    inputPath: string;
    outputPath: string;
    sampleRateHz: 16_000 | 24_000;
  }>): void | Promise<void>;
}>;

export type Lc4CallerAudioManifest = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC4-v1";
  materializer_id: "HACC-LC4-LOCAL-CALLER-AUDIO-v1";
  provider_calls_made: false;
  plaintext_retained: false;
  authorized_corpus_sha256: string;
  authorization_receipt_sha256: string;
  voice_profiles: typeof LC4_LOCAL_TTS_VOICES;
  provider_input_routes: typeof LC4_CALLER_INPUT_ROUTES;
  provider_profile_manifest_sha256: string;
  renderer_identity: Lc4LocalAudioRenderer["identity"];
  toolchain_sha256: string;
  fixtures: readonly Lc4CallerAudioFixture[];
  counts: Readonly<{
    templates: 24;
    voice_slots: 3;
    templates_per_voice_slot: 8;
    canonical_sources: 1_440;
    repair_sources: 4_608;
    total_sources: 6_048;
    logical_provider_rendition_bindings: 18_144;
  }>;
  asr_calibration_plan_sha256: string;
  manifest_sha256: string;
}>;

export type Lc4InputAsrCalibrationPlan = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC4-v1";
  calibration_id: "HACC-LC4-INPUT-ASR-CAL-v1";
  status: "required_before_provider_execution";
  authorized_corpus_sha256: string;
  units: readonly Lc4InputAsrCalibrationUnit[];
  plan_sha256: string;
}>;

function validateSha(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function validateId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} is unsafe`);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

export function lc4AuthorizedAudioCorpusSha256(templates: readonly AuthorizedUnsealedLc4Template[]): string {
  return sha256Hex(`${CORPUS_DOMAIN}${canonicalJson(templates)}`);
}

/**
 * Adapt an already authorized in-memory corpus to the audio boundary. This does
 * not read ciphertext, keys, custody files, or perform an unseal operation.
 */
export function createAuthorizedLc4AudioCorpusFromGeneratedTemplates(input: Readonly<{
  templates: readonly Lc4GeneratedHeldoutTemplate[];
  authorizationReceiptSha256: string;
}>): AuthorizedUnsealedLc4AudioCorpus {
  validateSha(input.authorizationReceiptSha256, "LC4 corpus authorization receipt");
  if (input.templates.length !== 24) throw new Error("LC4 generated audio adapter requires exactly 24 templates");
  const templates = input.templates.map((template) => {
    assertLc4GenericScenarioPayload(template.payload);
    const payload = template.payload as Lc4GenericScenarioPayload;
    if (template.template_id !== payload.template_id) throw new Error("LC4 generated audio template identity mismatch");
    return Object.freeze({
      template_id: payload.template_id,
      tts_voice_slot: payload.tts_voice_slot,
      caller_utterances: Object.freeze(payload.opportunities.map((opportunity, index) => Object.freeze({
        id: opportunity.canonical_caller_utterance.id,
        text: opportunity.canonical_caller_utterance.text,
        source_text_sha256: opportunity.canonical_caller_utterance.source_text_sha256,
        ordinal: index + 1,
        canonical_opportunity_id: opportunity.id,
        stage_id: opportunity.stage_id,
        act: opportunity.act,
        segment_ordinal: (Math.floor(index / 20) + 1) as 1 | 2 | 3,
        spoken_fact_ids: Object.freeze(opportunity.canonical_caller_utterance.fact_bindings.map((binding) => binding.fact_id)),
      }))),
      repair_utterances: Object.freeze(payload.repair_library.map((repair) => Object.freeze({
        id: repair.id,
        stage_id: repair.stage_id,
        blocker_code: repair.blocker_code,
        repair_ordinal: repair.repair_ordinal,
        text: repair.text,
        source_text_sha256: repair.source_text_sha256,
        repeated_spoken_fact_ids: Object.freeze([]),
      }))),
    });
  });
  const corpus = Object.freeze({
    schema_version: 1 as const,
    protocol_id: "HACC-LC4-v1" as const,
    authorization: Object.freeze({
      scope: "local_caller_audio_materialization_only" as const,
      authorization_receipt_sha256: input.authorizationReceiptSha256,
      provider_calls_authorized: false as const,
      plaintext_logging_authorized: false as const,
    }),
    templates: Object.freeze(templates),
    corpus_sha256: lc4AuthorizedAudioCorpusSha256(templates),
  });
  assertAuthorizedUnsealedLc4AudioCorpus(corpus);
  return corpus;
}

/** Strict held-out shape validation without unsealing or logging plaintext. */
export function assertAuthorizedUnsealedLc4AudioCorpus(
  corpus: AuthorizedUnsealedLc4AudioCorpus,
): void {
  if (corpus.schema_version !== 1 || corpus.protocol_id !== "HACC-LC4-v1") {
    throw new Error("LC4 authorized audio corpus protocol is unsupported");
  }
  if (corpus.authorization.scope !== "local_caller_audio_materialization_only"
    || corpus.authorization.provider_calls_authorized !== false
    || corpus.authorization.plaintext_logging_authorized !== false) {
    throw new Error("LC4 corpus authorization exceeds local audio materialization");
  }
  validateSha(corpus.authorization.authorization_receipt_sha256, "LC4 corpus authorization receipt");
  if (corpus.corpus_sha256 !== lc4AuthorizedAudioCorpusSha256(corpus.templates)) {
    throw new Error("LC4 authorized audio corpus hash mismatch");
  }
  if (corpus.templates.length !== 24) throw new Error("LC4 audio corpus requires exactly 24 templates");
  assertUnique(corpus.templates.map((template) => template.template_id), "LC4 audio template IDs");
  for (const slot of Object.keys(LC4_LOCAL_TTS_VOICES) as Lc4TtsVoiceSlot[]) {
    if (corpus.templates.filter((template) => template.tts_voice_slot === slot).length !== 8) {
      throw new Error(`LC4 audio corpus requires eight templates in ${slot}`);
    }
  }
  for (const template of corpus.templates) {
    validateId(template.template_id, "LC4 audio template ID");
    if (!(template.tts_voice_slot in LC4_LOCAL_TTS_VOICES)) throw new Error("LC4 audio template voice slot is invalid");
    if (template.caller_utterances.length !== 60) throw new Error("LC4 audio template requires 60 canonical utterances");
    if (template.repair_utterances.length !== 12 * LC4_NORMATIVE_BLOCKER_CODES.length * 2) {
      throw new Error("LC4 audio template repair library is incomplete");
    }
    assertUnique(template.caller_utterances.map((item) => item.id), "LC4 canonical utterance IDs");
    assertUnique(template.repair_utterances.map((item) => item.id), "LC4 repair utterance IDs");
    const all = [...template.caller_utterances, ...template.repair_utterances];
    assertUnique(all.map((item) => item.id), "LC4 caller and repair source IDs");
    for (const item of all) {
      validateId(item.id, "LC4 audio source ID");
      if (!item.text || item.source_text_sha256 !== sha256Hex(item.text)) {
        throw new Error("LC4 audio source text hash mismatch");
      }
    }
    for (const [index, item] of template.caller_utterances.entries()) {
      const ordinal = index + 1;
      const segment = (Math.floor(index / 20) + 1) as 1 | 2 | 3;
      const act = (["establish", "interleave", "reconcile"] as const)[segment - 1];
      if (item.ordinal !== ordinal || item.segment_ordinal !== segment || item.act !== act) {
        throw new Error("LC4 canonical audio ordering, act, or segment binding is invalid");
      }
      validateId(item.canonical_opportunity_id, "LC4 canonical opportunity ID");
      validateId(item.stage_id, "LC4 canonical stage ID");
      assertUnique(item.spoken_fact_ids, "LC4 canonical spoken fact IDs");
      for (const factId of item.spoken_fact_ids) validateId(factId, "LC4 canonical spoken fact ID");
    }
    const stages = [...new Set(template.repair_utterances.map((item) => item.stage_id))].sort();
    if (stages.length !== 12) throw new Error("LC4 repair audio requires all 12 stages");
    const stageOrdinals = new Map(stages.map((stageId, index) => [stageId, index + 1]));
    let priorStageOrdinal = 1;
    for (const item of template.caller_utterances) {
      const stageOrdinal = stageOrdinals.get(item.stage_id);
      if (stageOrdinal === undefined) {
        throw new Error("LC4 canonical audio stage does not join the registered repair stages");
      }
      if (stageOrdinal < priorStageOrdinal || stageOrdinal > priorStageOrdinal + 1) {
        throw new Error("LC4 canonical audio stage progression regresses or skips a registered stage");
      }
      priorStageOrdinal = stageOrdinal;
    }
    if (canonicalJson([...new Set(template.caller_utterances.map((item) => item.stage_id))].sort())
      !== canonicalJson(stages)) {
      throw new Error("LC4 canonical audio does not cover every registered stage");
    }
    for (const stageId of stages) {
      validateId(stageId, "LC4 repair stage ID");
      for (const blocker of LC4_NORMATIVE_BLOCKER_CODES) {
        for (const ordinal of [1, 2] as const) {
          const count = template.repair_utterances.filter((item) => (
            item.stage_id === stageId && item.blocker_code === blocker && item.repair_ordinal === ordinal
          )).length;
          if (count !== 1) throw new Error("LC4 repair audio does not cover every permitted repair exactly once");
        }
      }
    }
    for (const repair of template.repair_utterances) {
      assertUnique(repair.repeated_spoken_fact_ids, "LC4 repair repeated fact IDs");
      for (const factId of repair.repeated_spoken_fact_ids) validateId(factId, "LC4 repair repeated fact ID");
    }
  }
}

function pcmObject(bytes: Uint8Array, sampleRateHz: 16_000 | 24_000 | 48_000): Lc4PcmObject {
  if (bytes.byteLength < 2 || bytes.byteLength % 2 !== 0 || bytes.byteLength > MAX_PCM_BYTES) {
    throw new Error("LC4 renderer returned invalid PCM16LE bytes");
  }
  const samples = bytes.byteLength / 2;
  if (samples / sampleRateHz > 180) throw new Error("LC4 caller PCM exceeds the utterance duration limit");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let energy = 0;
  let peak = 0;
  let clipped = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true);
    const magnitude = Math.abs(sample);
    energy += sample * sample;
    peak = Math.max(peak, magnitude);
    if (magnitude >= 32_767) clipped += 1;
  }
  const rms = Math.sqrt(energy / samples);
  if (peak < 128 || rms < 32) throw new Error("LC4 caller PCM is silent or below the signal floor");
  if (clipped / samples > 0.005) throw new Error("LC4 caller PCM exceeds the clipping limit");
  const sha256 = sha256Hex(bytes);
  return Object.freeze({
    path: `objects/sha256/${sha256.slice(0, 2)}/${sha256}.pcm`,
    sha256,
    byte_length: bytes.byteLength,
    sample_rate_hz: sampleRateHz,
    channels: 1,
    encoding: "pcm16le",
    duration_ms: bytes.byteLength / 2 / sampleRateHz * 1_000,
  });
}

async function writeExclusive(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function installObject(root: string, object: Lc4PcmObject, bytes: Uint8Array): Promise<void> {
  const destination = resolve(root, object.path);
  if (!destination.startsWith(`${root}${sep}`)) throw new Error("LC4 PCM object path escapes output root");
  try {
    const existing = new Uint8Array(await readFile(destination));
    if (sha256Hex(existing) !== object.sha256) throw new Error("LC4 PCM object collision");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeExclusive(destination, bytes);
  }
}

function asrPlan(input: Readonly<{
  corpusSha256: string;
  units: readonly Lc4InputAsrCalibrationUnit[];
}>): Lc4InputAsrCalibrationPlan {
  const body = Object.freeze({
    schema_version: 1 as const,
    protocol_id: "HACC-LC4-v1" as const,
    calibration_id: "HACC-LC4-INPUT-ASR-CAL-v1" as const,
    status: "required_before_provider_execution" as const,
    authorized_corpus_sha256: input.corpusSha256,
    units: Object.freeze([...input.units]),
  });
  return Object.freeze({ ...body, plan_sha256: sha256Hex(`${ASR_PLAN_DOMAIN}${canonicalJson(body)}`) });
}

function manifest(input: Readonly<{
  corpus: AuthorizedUnsealedLc4AudioCorpus;
  renderer: Lc4LocalAudioRenderer;
  toolchainSha256: string;
  fixtures: readonly Lc4CallerAudioFixture[];
  asrPlanSha256: string;
}>): Lc4CallerAudioManifest {
  const body = Object.freeze({
    schema_version: 1 as const,
    protocol_id: "HACC-LC4-v1" as const,
    materializer_id: "HACC-LC4-LOCAL-CALLER-AUDIO-v1" as const,
    provider_calls_made: false as const,
    plaintext_retained: false as const,
    authorized_corpus_sha256: input.corpus.corpus_sha256,
    authorization_receipt_sha256: input.corpus.authorization.authorization_receipt_sha256,
    voice_profiles: LC4_LOCAL_TTS_VOICES,
    provider_input_routes: LC4_CALLER_INPUT_ROUTES,
    provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    renderer_identity: input.renderer.identity,
    toolchain_sha256: input.toolchainSha256,
    fixtures: Object.freeze([...input.fixtures]),
    counts: Object.freeze({
      templates: 24 as const,
      voice_slots: 3 as const,
      templates_per_voice_slot: 8 as const,
      canonical_sources: 1_440 as const,
      repair_sources: 4_608 as const,
      total_sources: 6_048 as const,
      logical_provider_rendition_bindings: 18_144 as const,
    }),
    asr_calibration_plan_sha256: input.asrPlanSha256,
  });
  return Object.freeze({ ...body, manifest_sha256: sha256Hex(`${MANIFEST_DOMAIN}${canonicalJson(body)}`) });
}

async function pathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error("LC4 caller audio output already exists; refusing overwrite");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function materializeLc4CallerAudio(input: Readonly<{
  corpus: AuthorizedUnsealedLc4AudioCorpus;
  outputRoot: string;
  renderer: Lc4LocalAudioRenderer;
  toolchainSha256: string;
  onAsrCalibrationUnit?: Lc4InputAsrCalibrationHook;
}>): Promise<Readonly<{ manifest: Lc4CallerAudioManifest; asrPlan: Lc4InputAsrCalibrationPlan }>> {
  assertAuthorizedUnsealedLc4AudioCorpus(input.corpus);
  validateSha(input.toolchainSha256, "LC4 caller audio toolchain hash");
  if (!resolve(input.outputRoot).startsWith(sep) || resolve(input.outputRoot) !== input.outputRoot) {
    throw new Error("LC4 caller audio output root must be an absolute normalized path");
  }
  await pathAbsent(input.outputRoot);
  await input.renderer.assertReady();
  const parent = dirname(input.outputRoot);
  const staging = await mkdtemp(join(parent, `.${basename(input.outputRoot)}.staging-`));
  const work = resolve(staging, ".work");
  const cache = new Map<string, Readonly<{
    master: Lc4PcmObject;
    renditions: Lc4CallerAudioFixture["provider_renditions"];
    pcm: Record<LiveStsProvider, Uint8Array>;
  }>>();
  const fixtures: Lc4CallerAudioFixture[] = [];
  const units: Lc4InputAsrCalibrationUnit[] = [];
  try {
    await mkdir(work, { recursive: true, mode: 0o700 });
    for (const template of [...input.corpus.templates].sort((a, b) => a.template_id.localeCompare(b.template_id))) {
      const sources = [
        ...template.caller_utterances.map((source) => ({ kind: "canonical" as const, source, repair: null })),
        ...template.repair_utterances.map((source) => ({ kind: "repair" as const, source, repair: source })),
      ];
      for (const item of sources) {
        const voice = LC4_LOCAL_TTS_VOICES[template.tts_voice_slot];
        const cacheKey = `${template.tts_voice_slot}/${item.source.source_text_sha256}`;
        let audio = cache.get(cacheKey);
        if (!audio) {
          const stem = sha256Hex(cacheKey);
          const masterPath = resolve(work, `${stem}.48000.pcm`);
          await input.renderer.renderSourceMaster({ text: item.source.text, voice, outputPath: masterPath });
          const masterBytes = new Uint8Array(await readFile(masterPath));
          const master = pcmObject(masterBytes, SOURCE_SAMPLE_RATE_HZ);
          await installObject(staging, master, masterBytes);
          const byRate = new Map<16_000 | 24_000, Readonly<{ object: Lc4PcmObject; bytes: Uint8Array }>>();
          for (const rate of [16_000, 24_000] as const) {
            const destination = resolve(work, `${stem}.${rate}.pcm`);
            await input.renderer.transcodeSourceMaster({ inputPath: masterPath, outputPath: destination, sampleRateHz: rate });
            const bytes = new Uint8Array(await readFile(destination));
            const object = pcmObject(bytes, rate);
            await installObject(staging, object, bytes);
            byRate.set(rate, Object.freeze({ object, bytes }));
          }
          audio = Object.freeze({
            master,
            renditions: Object.freeze(Object.fromEntries((Object.keys(LC4_CALLER_INPUT_ROUTES) as LiveStsProvider[]).map((provider) => {
              const object = byRate.get(LC4_CALLER_INPUT_ROUTES[provider].sampleRateHz)!.object;
              const providerProfileSha256 = sha256Hex(canonicalJson(LC4_PROVIDER_PROFILE_MANIFEST.providers[provider]));
              return [provider, Object.freeze({
                ...object,
                provider,
                provider_profile_sha256: providerProfileSha256,
                transform_sha256: sha256Hex(`${PROVIDER_RENDITION_DOMAIN}${canonicalJson({
                  provider,
                  providerProfileSha256,
                  rendererIdentitySha256: input.renderer.identity.identity_sha256,
                  sourceMasterSha256: master.sha256,
                  outputPcmSha256: object.sha256,
                  outputSampleRateHz: object.sample_rate_hz,
                })}`),
              })];
            }))) as Lc4CallerAudioFixture["provider_renditions"],
            pcm: Object.freeze(Object.fromEntries((Object.keys(LC4_CALLER_INPUT_ROUTES) as LiveStsProvider[]).map((provider) => [
              provider,
              byRate.get(LC4_CALLER_INPUT_ROUTES[provider].sampleRateHz)!.bytes,
            ]))) as Record<LiveStsProvider, Uint8Array>,
          });
          cache.set(cacheKey, audio);
          await rm(masterPath, { force: true });
          await Promise.all([16_000, 24_000].map((rate) => rm(resolve(work, `${stem}.${rate}.pcm`), { force: true })));
        }
        const fixtureId = `lc4.${template.template_id}.${item.kind}.${item.source.id}.${template.tts_voice_slot}`;
        validateId(fixtureId, "LC4 caller audio fixture ID");
        const fixture = Object.freeze({
          fixture_id: fixtureId,
          template_id: template.template_id,
          source_kind: item.kind,
          source_id: item.source.id,
          source_text_sha256: item.source.source_text_sha256,
          tts_voice_slot: template.tts_voice_slot,
          voice,
          canonical_binding: item.kind === "repair" ? null : Object.freeze({
            ordinal: item.source.ordinal,
            canonical_opportunity_id: item.source.canonical_opportunity_id,
            stage_id: item.source.stage_id,
            act: item.source.act,
            segment_ordinal: item.source.segment_ordinal,
            spoken_fact_ids: Object.freeze([...item.source.spoken_fact_ids]),
          }),
          repair_binding: item.repair === null ? null : Object.freeze({
            stage_id: item.repair.stage_id,
            blocker_code: item.repair.blocker_code,
            repair_ordinal: item.repair.repair_ordinal,
            repeated_spoken_fact_ids: Object.freeze([...item.repair.repeated_spoken_fact_ids]),
          }),
          source_master: audio.master,
          provider_renditions: audio.renditions,
        }) satisfies Lc4CallerAudioFixture;
        fixtures.push(fixture);
        for (const provider of Object.keys(LC4_CALLER_INPUT_ROUTES) as LiveStsProvider[]) {
          const rendition = audio.renditions[provider];
          const unit = Object.freeze({
            calibration_unit_id: `${fixtureId}.${provider}`,
            fixture_id: fixtureId,
            template_id: template.template_id,
            source_kind: item.kind,
            source_id: item.source.id,
            source_text_sha256: item.source.source_text_sha256,
            tts_voice_slot: template.tts_voice_slot,
            provider,
            route_id: `${provider}/pcm16le/${rendition.sample_rate_hz}/mono`,
            pcm_path: rendition.path,
            pcm_sha256: rendition.sha256,
            byte_length: rendition.byte_length,
            sample_rate_hz: rendition.sample_rate_hz as 16_000 | 24_000,
            calibration_status: "pending_independent_asr" as const,
          });
          units.push(unit);
          await input.onAsrCalibrationUnit?.({ unit, referenceText: item.source.text, pcm: audio.pcm[provider] });
        }
      }
    }
    assertUnique(fixtures.map((fixture) => fixture.fixture_id), "LC4 materialized fixture IDs");
    assertUnique(units.map((unit) => unit.calibration_unit_id), "LC4 input ASR calibration IDs");
    const calibration = asrPlan({ corpusSha256: input.corpus.corpus_sha256, units });
    const artifact = manifest({
      corpus: input.corpus,
      renderer: input.renderer,
      toolchainSha256: input.toolchainSha256,
      fixtures,
      asrPlanSha256: calibration.plan_sha256,
    });
    await rm(work, { recursive: true, force: true });
    await writeExclusive(resolve(staging, "asr-input-calibration-plan.json"), `${canonicalJson(calibration)}\n`);
    await writeExclusive(resolve(staging, "manifest.json"), `${canonicalJson(artifact)}\n`);
    await pathAbsent(input.outputRoot);
    await rename(staging, input.outputRoot);
    return Object.freeze({ manifest: artifact, asrPlan: calibration });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function runLocalCommand(input: Readonly<{
  command: string;
  args: readonly string[];
  stdin?: string;
}>): Promise<Readonly<{ stdout: string; stderr: string }>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: process.env.NODE_ENV ?? "production",
      LANG: "C",
      LC_ALL: "C",
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    };
    const child = spawn(input.command, input.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: environment,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 1024 * 1024) child.kill("SIGKILL");
      else target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", () => rejectPromise(new Error("LC4 local audio command could not start")));
    child.on("close", (code) => {
      if (code !== 0 || bytes > 1024 * 1024) {
        rejectPromise(new Error("LC4 local audio command failed"));
      } else {
        resolvePromise({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      }
    });
    child.stdin.end(input.stdin);
  });
}

async function assertExecutable(path: string, expectedSha256: string, label: string): Promise<void> {
  if (resolve(path) !== path) throw new Error(`${label} path must be absolute and normalized`);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink executable`);
  if (sha256Hex(await readFile(path)) !== expectedSha256) throw new Error(`${label} executable hash mismatch`);
}

export async function createPinnedMacOsLc4AudioRenderer(
  toolchain: Lc4LocalAudioToolchain,
): Promise<Readonly<{ renderer: Lc4LocalAudioRenderer; toolchainSha256: string }>> {
  validateSha(toolchain.say_sha256, "macOS say hash");
  validateSha(toolchain.ffmpeg_sha256, "ffmpeg hash");
  await assertExecutable(toolchain.say_path, toolchain.say_sha256, "macOS say");
  await assertExecutable(toolchain.ffmpeg_path, toolchain.ffmpeg_sha256, "ffmpeg");
  const toolchainSha256 = sha256Hex(`${TOOLCHAIN_DOMAIN}${canonicalJson(toolchain)}`);
  const renderer: Lc4LocalAudioRenderer = Object.freeze({
    identity: Object.freeze({ renderer: "macos-say-ffmpeg-pcm16le-v1", identity_sha256: toolchainSha256 }),
    async assertReady() {
      const result = await runLocalCommand({ command: toolchain.say_path, args: ["-v", "?"] });
      const available = new Map(result.stdout.split(/\r?\n/u).map((line) => {
        const match = /^(\S+)\s+([a-z]{2}_[A-Z]{2})\s+/u.exec(line);
        return match ? [match[1], match[2]] : ["", ""];
      }));
      for (const voice of Object.values(LC4_LOCAL_TTS_VOICES)) {
        if (available.get(voice.name) !== voice.locale) throw new Error("LC4 pinned local TTS voice is unavailable");
      }
      await runLocalCommand({ command: toolchain.ffmpeg_path, args: ["-version"] });
    },
    async renderSourceMaster({ text, voice, outputPath }) {
      const aiff = `${outputPath}.aiff`;
      try {
        await runLocalCommand({
          command: toolchain.say_path,
          args: ["-v", voice.name, "-r", String(voice.wordsPerMinute), "-o", aiff, "-f", "-"],
          stdin: text,
        });
        await runLocalCommand({
          command: toolchain.ffmpeg_path,
          args: [
            "-nostdin", "-loglevel", "error", "-nostats", "-y", "-i", aiff,
            "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
            "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(SOURCE_SAMPLE_RATE_HZ), outputPath,
          ],
        });
      } finally {
        await rm(aiff, { force: true });
      }
    },
    async transcodeSourceMaster({ inputPath, outputPath, sampleRateHz }) {
      await runLocalCommand({
        command: toolchain.ffmpeg_path,
        args: [
          "-nostdin", "-loglevel", "error", "-nostats", "-y",
          "-f", "s16le", "-ar", String(SOURCE_SAMPLE_RATE_HZ), "-ac", "1", "-i", inputPath,
          "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
          "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(sampleRateHz), outputPath,
        ],
      });
    },
  });
  return Object.freeze({ renderer, toolchainSha256 });
}

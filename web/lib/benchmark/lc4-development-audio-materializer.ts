import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import type { Lc4DevCallerAudioBinding } from "./lc4-development-live-runner";
import {
  assertLc4PublicDevelopmentCorpus,
  createLc4PublicDevelopmentCorpus,
  type Lc4PublicDevelopmentCorpus,
} from "./lc4-public-development-corpus";
import { LC4_PROVIDER_PROFILE_MANIFEST } from "./lc4-provider-profiles";
import type { LiveStsProvider } from "./live-sts-development-experiment";

export const LC4_DEV_AUDIO_MATERIALIZER_ID = "HACC-LC4-DEV-AUDIO-v1" as const;
export const LC4_DEV_SOURCE_SAMPLE_RATE_HZ = 48_000 as const;
export const LC4_DEV_PINNED_VOICE = Object.freeze({
  name: "Samantha" as const,
  locale: "en_US" as const,
  words_per_minute: 195 as const,
});

const HASH = /^[a-f0-9]{64}$/u;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_UTTERANCE_SECONDS = 60;
const MIN_UTTERANCE_SECONDS = 0.1;
const MIN_RMS = 32;
const MAX_CLIPPED_SAMPLE_RATIO = 0.001;
const MANIFEST_DOMAIN = "harshas-amazing-call-center/lc4-dev-audio-manifest/v1\n";
const REPAIR_MANIFEST_DOMAIN = "harshas-amazing-call-center/lc4-dev-repair-audio-manifest/v1\n";
const TOOLCHAIN_DOMAIN = "harshas-amazing-call-center/lc4-dev-audio-toolchain/v1\n";
const RENDITION_DOMAIN = "harshas-amazing-call-center/lc4-dev-audio-rendition/v1\n";
const PREPARE_FRAGMENT_DOMAIN = "harshas-amazing-call-center/lc4-dev-audio-prepare-fragment/v1\n";

type SampleRate = 16_000 | 24_000 | 48_000;

export type Lc4DevAudioToolchain = Readonly<{
  say_path: "/usr/bin/say";
  say_sha256: string;
  ffmpeg_path: string;
  ffmpeg_sha256: string;
}>;

export type Lc4DevAudioRendererIdentity = Readonly<{
  renderer: "macos-say-ffmpeg-loudnorm-v2" | "injected-test-renderer";
  identity_sha256: string;
  toolchain: Lc4DevAudioToolchain | null;
  voice: typeof LC4_DEV_PINNED_VOICE;
  normalization: "ffmpeg-loudnorm-I-20-LRA-7-TP-3";
}>;

export type Lc4DevAudioRenderer = Readonly<{
  identity: Lc4DevAudioRendererIdentity;
  assertReady(): void | Promise<void>;
  assertUnchanged(): void | Promise<void>;
  render(input: Readonly<{
    text: string;
    sourceTextSha256: string;
    workspace: string;
  }>): Promise<Readonly<{
    master48k: Uint8Array;
    pcm16k: Uint8Array;
    pcm24k: Uint8Array;
  }>>;
}>;

export type Lc4DevPcmObject = Readonly<{
  path: string;
  sha256: string;
  byte_length: number;
  sample_rate_hz: SampleRate;
  channels: 1;
  encoding: "pcm16le";
  duration_ms: number;
  peak_absolute: number;
  rms: number;
  clipped_sample_count: number;
  clipped_sample_ratio: number;
}>;

export type Lc4DevAudioRendition = Lc4DevPcmObject & Readonly<{
  provider: LiveStsProvider;
  provider_profile_sha256: string;
  rendition_sha256: string;
}>;

export type Lc4DevCanonicalAudioSource = Readonly<{
  source_kind: "canonical";
  source_id: string;
  opportunity_id: string;
  source_text_sha256: string;
  master_48khz: Lc4DevPcmObject;
  provider_renditions: Readonly<Record<LiveStsProvider, Lc4DevAudioRendition>>;
}>;

export type Lc4DevRepairAudioSource = Readonly<{
  source_kind: "repair";
  source_id: string;
  stage_id: string;
  blocker_code: string;
  repair_ordinal: 1 | 2;
  source_text_sha256: string;
  master_48khz: Lc4DevPcmObject;
  provider_renditions: Readonly<Record<LiveStsProvider, Lc4DevAudioRendition>>;
}>;

export type Lc4DevRepairAudioBinding = Readonly<{
  repair_id: string;
  stage_id: string;
  blocker_code: string;
  repair_ordinal: 1 | 2;
  provider: LiveStsProvider;
  pcm_path: string;
  pcm_sha256: string;
  pcm_byte_length: number;
  sample_rate_hz: 16_000 | 24_000;
  source_text_sha256: string;
}>;

export type Lc4DevRepairAudioManifest = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC4-DEV-v1";
  materializer_id: typeof LC4_DEV_AUDIO_MATERIALIZER_ID;
  source_corpus_sha256: string;
  provider_profile_manifest_sha256: string;
  repair_sources: readonly Lc4DevRepairAudioSource[];
  repair_audio_bindings: readonly Lc4DevRepairAudioBinding[];
  source_count: 24;
  logical_provider_binding_count: 72;
  maximum_repairs_per_stage: 2;
  maximum_repairs_per_episode: 4;
  repairs_extend_canonical_horizon: false;
  repair_manifest_sha256: string;
}>;

export type Lc4DevAudioManifest = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC4-DEV-v1";
  materializer_id: typeof LC4_DEV_AUDIO_MATERIALIZER_ID;
  provider_calls_made: false;
  plaintext_retained: false;
  source_corpus_sha256: string;
  public_corpus_artifact_sha256: string;
  provider_profile_manifest_sha256: string;
  renderer_identity: Lc4DevAudioRendererIdentity;
  canonical_sources: readonly Lc4DevCanonicalAudioSource[];
  caller_audio_bindings: readonly Lc4DevCallerAudioBinding[];
  repair_manifest_sha256: string;
  counts: Readonly<{
    canonical_sources: 60;
    repair_sources: 24;
    source_masters_48khz: 84;
    logical_caller_bindings: 180;
    logical_repair_bindings: 72;
  }>;
  manifest_sha256: string;
}>;

export type Lc4DevAudioPrepareFragment = Readonly<{
  schema_version: 1;
  protocol_id: "HACC-LC4-DEV-v1";
  audio_manifest_sha256: string;
  audio_bindings: readonly Lc4DevCallerAudioBinding[];
  fragment_sha256: string;
}>;

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

async function writeExclusive(path: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error("LC4-DEV audio output already exists; refusing overwrite");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function inspectPcm(bytes: Uint8Array, sampleRateHz: SampleRate): Lc4DevPcmObject {
  if (bytes.byteLength < 2 || bytes.byteLength % 2 !== 0) throw new Error("LC4-DEV renderer produced invalid PCM16LE length");
  const sampleCount = bytes.byteLength / 2;
  const durationSeconds = sampleCount / sampleRateHz;
  if (durationSeconds < MIN_UTTERANCE_SECONDS || durationSeconds > MAX_UTTERANCE_SECONDS) {
    throw new Error("LC4-DEV caller PCM duration is outside the frozen bounds");
  }
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
  const rms = Math.sqrt(energy / sampleCount);
  const clippedRatio = clipped / sampleCount;
  if (peak < 128 || rms < MIN_RMS) throw new Error("LC4-DEV caller PCM is silent or below the signal floor");
  if (clippedRatio > MAX_CLIPPED_SAMPLE_RATIO) throw new Error("LC4-DEV caller PCM exceeds the clipping limit");
  const sha256 = sha256Hex(bytes);
  return Object.freeze({
    path: `objects/sha256/${sha256.slice(0, 2)}/${sha256}.pcm`,
    sha256,
    byte_length: bytes.byteLength,
    sample_rate_hz: sampleRateHz,
    channels: 1 as const,
    encoding: "pcm16le" as const,
    duration_ms: Number((durationSeconds * 1000).toFixed(6)),
    peak_absolute: peak,
    rms: Number(rms.toFixed(6)),
    clipped_sample_count: clipped,
    clipped_sample_ratio: Number(clippedRatio.toFixed(9)),
  });
}

async function installCasObject(root: string, object: Lc4DevPcmObject, bytes: Uint8Array): Promise<void> {
  const destination = resolve(root, object.path);
  if (!inside(root, destination)) throw new Error("LC4-DEV PCM object path escapes output root");
  try {
    const existing = new Uint8Array(await readFile(destination));
    if (sha256Hex(existing) !== object.sha256) throw new Error("LC4-DEV CAS collision detected");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeExclusive(destination, bytes);
  }
}

function providerRenditions(input: Readonly<{
  renderer: Lc4DevAudioRenderer;
  master: Lc4DevPcmObject;
  pcm16k: Lc4DevPcmObject;
  pcm24k: Lc4DevPcmObject;
}>): Readonly<Record<LiveStsProvider, Lc4DevAudioRendition>> {
  return freeze(Object.fromEntries((["openai", "gemini", "xai"] as const).map((provider) => {
    const profile = LC4_PROVIDER_PROFILE_MANIFEST.providers[provider];
    const pcm = profile.input_sample_rate_hz === 16_000 ? input.pcm16k : input.pcm24k;
    const providerProfileSha256 = sha256Hex(canonicalJson(profile));
    const body = {
      provider,
      provider_profile_sha256: providerProfileSha256,
      renderer_identity_sha256: input.renderer.identity.identity_sha256,
      source_master_sha256: input.master.sha256,
      output_pcm_sha256: pcm.sha256,
      output_sample_rate_hz: pcm.sample_rate_hz,
    };
    return [provider, {
      ...pcm,
      provider,
      provider_profile_sha256: providerProfileSha256,
      rendition_sha256: sha256Hex(`${RENDITION_DOMAIN}${canonicalJson(body)}`),
    }];
  }))) as Readonly<Record<LiveStsProvider, Lc4DevAudioRendition>>;
}

function repairManifest(input: Readonly<{
  corpus: Lc4PublicDevelopmentCorpus;
  sources: readonly Lc4DevRepairAudioSource[];
}>): Lc4DevRepairAudioManifest {
  const bindings = (["openai", "gemini", "xai"] as const).flatMap((provider) => input.sources.map((source) => {
    const rendition = source.provider_renditions[provider];
    return Object.freeze({
      repair_id: source.source_id,
      stage_id: source.stage_id,
      blocker_code: source.blocker_code,
      repair_ordinal: source.repair_ordinal,
      provider,
      pcm_path: rendition.path,
      pcm_sha256: rendition.sha256,
      pcm_byte_length: rendition.byte_length,
      sample_rate_hz: rendition.sample_rate_hz as 16_000 | 24_000,
      source_text_sha256: source.source_text_sha256,
    });
  }));
  const body = {
    schema_version: 1 as const,
    protocol_id: "HACC-LC4-DEV-v1" as const,
    materializer_id: LC4_DEV_AUDIO_MATERIALIZER_ID,
    source_corpus_sha256: input.corpus.audio_plan.source_text_corpus_sha256,
    provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    repair_sources: Object.freeze([...input.sources]),
    repair_audio_bindings: Object.freeze(bindings),
    source_count: 24 as const,
    logical_provider_binding_count: 72 as const,
    maximum_repairs_per_stage: 2 as const,
    maximum_repairs_per_episode: 4 as const,
    repairs_extend_canonical_horizon: false as const,
  };
  return freeze({ ...body, repair_manifest_sha256: sha256Hex(`${REPAIR_MANIFEST_DOMAIN}${canonicalJson(body)}`) });
}

export async function materializeLc4DevelopmentAudio(input: Readonly<{
  outputRoot: string;
  renderer: Lc4DevAudioRenderer;
  corpus?: Lc4PublicDevelopmentCorpus;
}>): Promise<Readonly<{
  manifest: Lc4DevAudioManifest;
  repairManifest: Lc4DevRepairAudioManifest;
  prepareFragment: Lc4DevAudioPrepareFragment;
}>> {
  const outputRoot = resolve(input.outputRoot);
  if (!isAbsolute(input.outputRoot) || outputRoot !== input.outputRoot) {
    throw new Error("LC4-DEV audio output root must be absolute and normalized");
  }
  await mkdir(dirname(outputRoot), { recursive: true, mode: 0o700 });
  await assertAbsent(outputRoot);
  const corpus = input.corpus ?? createLc4PublicDevelopmentCorpus();
  assertLc4PublicDevelopmentCorpus(corpus);
  await input.renderer.assertReady();
  const staging = await mkdtemp(join(dirname(outputRoot), `.${basename(outputRoot)}.staging-`));
  const workspace = join(staging, ".work");
  const canonicalSources: Lc4DevCanonicalAudioSource[] = [];
  const repairSources: Lc4DevRepairAudioSource[] = [];
  try {
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const sources = [
      ...corpus.opportunities.map((source) => ({
        kind: "canonical" as const,
        id: source.id,
        text: source.canonical_caller_text,
        sourceTextSha256: source.canonical_caller_text_sha256,
        source,
      })),
      ...corpus.repair_policy.library.map((source) => ({
        kind: "repair" as const,
        id: source.id,
        text: source.canonical_caller_text,
        sourceTextSha256: source.canonical_caller_text_sha256,
        source,
      })),
    ];
    for (const item of sources) {
      let rendered: Awaited<ReturnType<Lc4DevAudioRenderer["render"]>>;
      try {
        rendered = await input.renderer.render({
          text: item.text,
          sourceTextSha256: item.sourceTextSha256,
          workspace,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown renderer failure";
        throw new Error(`LC4-DEV audio rendering failed for ${item.kind} source ${item.id} (${item.sourceTextSha256}): ${reason}`);
      }
      const master = inspectPcm(rendered.master48k, 48_000);
      const pcm16k = inspectPcm(rendered.pcm16k, 16_000);
      const pcm24k = inspectPcm(rendered.pcm24k, 24_000);
      await Promise.all([
        installCasObject(staging, master, rendered.master48k),
        installCasObject(staging, pcm16k, rendered.pcm16k),
        installCasObject(staging, pcm24k, rendered.pcm24k),
      ]);
      const renditions = providerRenditions({ renderer: input.renderer, master, pcm16k, pcm24k });
      if (item.kind === "canonical") {
        canonicalSources.push(Object.freeze({
          source_kind: "canonical",
          source_id: item.id,
          opportunity_id: item.source.id,
          source_text_sha256: item.sourceTextSha256,
          master_48khz: master,
          provider_renditions: renditions,
        }));
      } else {
        repairSources.push(Object.freeze({
          source_kind: "repair",
          source_id: item.id,
          stage_id: item.source.stage_id,
          blocker_code: item.source.blocker_code,
          repair_ordinal: item.source.repair_ordinal,
          source_text_sha256: item.sourceTextSha256,
          master_48khz: master,
          provider_renditions: renditions,
        }));
      }
    }
    await input.renderer.assertUnchanged();
    const repairs = repairManifest({ corpus, sources: repairSources });
    const callerAudioBindings = (["openai", "gemini", "xai"] as const).flatMap((provider) => canonicalSources.map((source) => {
      const rendition = source.provider_renditions[provider];
      return Object.freeze({
        opportunity_id: source.opportunity_id,
        provider,
        pcm_sha256: rendition.sha256,
        pcm_byte_length: rendition.byte_length,
        sample_rate_hz: rendition.sample_rate_hz as 16_000 | 24_000,
        source_text_sha256: source.source_text_sha256,
      });
    }));
    const body = {
      schema_version: 1 as const,
      protocol_id: "HACC-LC4-DEV-v1" as const,
      materializer_id: LC4_DEV_AUDIO_MATERIALIZER_ID,
      provider_calls_made: false as const,
      plaintext_retained: false as const,
      source_corpus_sha256: corpus.audio_plan.source_text_corpus_sha256,
      public_corpus_artifact_sha256: corpus.artifact_sha256,
      provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
      renderer_identity: input.renderer.identity,
      canonical_sources: Object.freeze(canonicalSources),
      caller_audio_bindings: Object.freeze(callerAudioBindings),
      repair_manifest_sha256: repairs.repair_manifest_sha256,
      counts: Object.freeze({
        canonical_sources: 60 as const,
        repair_sources: 24 as const,
        source_masters_48khz: 84 as const,
        logical_caller_bindings: 180 as const,
        logical_repair_bindings: 72 as const,
      }),
    };
    const manifest = freeze({ ...body, manifest_sha256: sha256Hex(`${MANIFEST_DOMAIN}${canonicalJson(body)}`) });
    const fragmentBody = {
      schema_version: 1 as const,
      protocol_id: "HACC-LC4-DEV-v1" as const,
      audio_manifest_sha256: manifest.manifest_sha256,
      audio_bindings: manifest.caller_audio_bindings,
    };
    const prepareFragment = freeze({
      ...fragmentBody,
      fragment_sha256: sha256Hex(`${PREPARE_FRAGMENT_DOMAIN}${canonicalJson(fragmentBody)}`),
    });
    assertLc4DevAudioArtifacts({ manifest, repairManifest: repairs, corpus });
    await rm(workspace, { recursive: true, force: true });
    await writeExclusive(join(staging, "manifest.json"), `${canonicalJson(manifest)}\n`);
    await writeExclusive(join(staging, "repair-manifest.json"), `${canonicalJson(repairs)}\n`);
    await writeExclusive(join(staging, "prepare-audio-input.json"), `${canonicalJson(prepareFragment)}\n`);
    await assertAbsent(outputRoot);
    await rename(staging, outputRoot);
    return Object.freeze({ manifest, repairManifest: repairs, prepareFragment });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export function assertLc4DevAudioArtifacts(input: Readonly<{
  manifest: Lc4DevAudioManifest;
  repairManifest: Lc4DevRepairAudioManifest;
  corpus?: Lc4PublicDevelopmentCorpus;
}>): void {
  const corpus = input.corpus ?? createLc4PublicDevelopmentCorpus();
  assertLc4PublicDevelopmentCorpus(corpus);
  const { manifest_sha256: manifestHash, ...manifestBody } = input.manifest;
  requireHash(manifestHash, "LC4-DEV audio manifest");
  if (manifestHash !== sha256Hex(`${MANIFEST_DOMAIN}${canonicalJson(manifestBody)}`)) throw new Error("LC4-DEV audio manifest hash mismatch");
  const { repair_manifest_sha256: repairHash, ...repairBody } = input.repairManifest;
  requireHash(repairHash, "LC4-DEV repair manifest");
  if (repairHash !== sha256Hex(`${REPAIR_MANIFEST_DOMAIN}${canonicalJson(repairBody)}`)) throw new Error("LC4-DEV repair manifest hash mismatch");
  if (input.manifest.protocol_id !== "HACC-LC4-DEV-v1" || input.manifest.provider_calls_made !== false || input.manifest.plaintext_retained !== false) {
    throw new Error("LC4-DEV audio manifest crossed its evidence boundary");
  }
  if (input.manifest.public_corpus_artifact_sha256 !== corpus.artifact_sha256
    || input.manifest.source_corpus_sha256 !== corpus.audio_plan.source_text_corpus_sha256
    || input.repairManifest.source_corpus_sha256 !== corpus.audio_plan.source_text_corpus_sha256) {
    throw new Error("LC4-DEV audio artifacts differ from the public source corpus");
  }
  if (input.manifest.repair_manifest_sha256 !== repairHash) throw new Error("LC4-DEV repair manifest is not bound by the audio root");
  if (input.manifest.canonical_sources.length !== 60 || input.manifest.caller_audio_bindings.length !== 180) {
    throw new Error("LC4-DEV canonical audio coverage is incomplete");
  }
  if (input.repairManifest.repair_sources.length !== 24 || input.repairManifest.repair_audio_bindings.length !== 72) {
    throw new Error("LC4-DEV repair audio coverage is incomplete");
  }
  for (const [providerIndex, provider] of (["openai", "gemini", "xai"] as const).entries()) {
    const offset = providerIndex * 60;
    corpus.opportunities.forEach((opportunity, index) => {
      const source = input.manifest.canonical_sources[index];
      const binding = input.manifest.caller_audio_bindings[offset + index];
      if (!source || source.opportunity_id !== opportunity.id || source.source_text_sha256 !== opportunity.canonical_caller_text_sha256) {
        throw new Error("LC4-DEV canonical source order or commitment drifted");
      }
      const rendition = source.provider_renditions[provider];
      if (!binding || binding.provider !== provider || binding.opportunity_id !== opportunity.id
        || binding.source_text_sha256 !== opportunity.canonical_caller_text_sha256
        || binding.pcm_sha256 !== rendition.sha256 || binding.pcm_byte_length !== rendition.byte_length
        || binding.sample_rate_hz !== LC4_PROVIDER_PROFILE_MANIFEST.providers[provider].input_sample_rate_hz) {
        throw new Error("LC4-DEV caller binding differs from its committed rendition");
      }
    });
  }
  for (const [providerIndex, provider] of (["openai", "gemini", "xai"] as const).entries()) {
    const offset = providerIndex * 24;
    corpus.repair_policy.library.forEach((repair, index) => {
      const source = input.repairManifest.repair_sources[index];
      const binding = input.repairManifest.repair_audio_bindings[offset + index];
      if (!source || source.source_id !== repair.id || source.source_text_sha256 !== repair.canonical_caller_text_sha256
        || !binding || binding.provider !== provider || binding.repair_id !== repair.id
        || binding.pcm_sha256 !== source.provider_renditions[provider].sha256) {
        throw new Error("LC4-DEV repair binding differs from its committed source");
      }
    });
  }
}

export function createLc4DevCallerAudioLoader(input: Readonly<{
  outputRoot: string;
  manifest: Lc4DevAudioManifest;
}>): Readonly<{ load(binding: Lc4DevCallerAudioBinding): Promise<Uint8Array> }> {
  const root = resolve(input.outputRoot);
  return Object.freeze({
    async load(binding) {
      const source = input.manifest.canonical_sources.find((candidate) => candidate.opportunity_id === binding.opportunity_id);
      const rendition = source?.provider_renditions[binding.provider];
      if (!rendition || rendition.sha256 !== binding.pcm_sha256 || rendition.byte_length !== binding.pcm_byte_length
        || rendition.sample_rate_hz !== binding.sample_rate_hz || source?.source_text_sha256 !== binding.source_text_sha256) {
        throw new Error("LC4-DEV caller loader rejected an uncommitted binding");
      }
      const path = resolve(root, rendition.path);
      if (!inside(root, path)) throw new Error("LC4-DEV caller loader path escapes the artifact root");
      const bytes = new Uint8Array(await readFile(path));
      if (bytes.byteLength !== rendition.byte_length || sha256Hex(bytes) !== rendition.sha256) {
        throw new Error("LC4-DEV caller loader detected PCM corruption");
      }
      return bytes;
    },
  });
}

function runCommand(input: Readonly<{
  command: string;
  args: readonly string[];
  stdin?: string;
  timeoutMs?: number;
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
    let byteCount = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("LC4-DEV local audio command timed out"));
    }, input.timeoutMs ?? 45_000);
    const finish = (error?: Error, result?: Readonly<{ stdout: string; stderr: string }>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result!);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      byteCount += chunk.byteLength;
      if (byteCount > MAX_COMMAND_OUTPUT_BYTES) child.kill("SIGKILL");
      else target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", () => finish(new Error("LC4-DEV local audio command could not start")));
    child.on("close", (code: number | null) => {
      if (code !== 0 || byteCount > MAX_COMMAND_OUTPUT_BYTES) {
        const stderrBytes = Buffer.concat(stderr);
        const executable = input.command.endsWith("/say") ? "say" : input.command.endsWith("/ffmpeg") ? "ffmpeg" : "unknown";
        const diagnostic = stderrBytes.toString("utf8").replace(/[\r\n]+/gu, " ").slice(0, 256);
        finish(new Error(`LC4-DEV local audio command failed (executable=${executable}, exit=${code ?? "signal"}, output_bytes=${byteCount}, stderr_sha256=${sha256Hex(stderrBytes)}, diagnostic=${JSON.stringify(diagnostic)})`));
      } else finish(undefined, { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.end(input.stdin);
  });
}

async function assertExecutable(path: string, expectedSha256: string, label: string): Promise<void> {
  requireHash(expectedSha256, `${label} hash`);
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} path must be absolute and normalized`);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  await access(path, constants.X_OK);
  if (sha256Hex(await readFile(path)) !== expectedSha256) throw new Error(`${label} executable hash mismatch`);
}

export async function inspectLc4DevAudioToolchain(input: Readonly<{
  ffmpegPath: string;
}>): Promise<Lc4DevAudioToolchain> {
  const sayPath = "/usr/bin/say" as const;
  if (!isAbsolute(input.ffmpegPath) || resolve(input.ffmpegPath) !== input.ffmpegPath) {
    throw new Error("ffmpeg path must be absolute and normalized");
  }
  return Object.freeze({
    say_path: sayPath,
    say_sha256: sha256Hex(await readFile(sayPath)),
    ffmpeg_path: input.ffmpegPath,
    ffmpeg_sha256: sha256Hex(await readFile(input.ffmpegPath)),
  });
}

export async function createPinnedMacOsLc4DevAudioRenderer(toolchain: Lc4DevAudioToolchain): Promise<Lc4DevAudioRenderer> {
  if (toolchain.say_path !== "/usr/bin/say") throw new Error("LC4-DEV requires the pinned /usr/bin/say path");
  await assertExecutable(toolchain.say_path, toolchain.say_sha256, "macOS say");
  await assertExecutable(toolchain.ffmpeg_path, toolchain.ffmpeg_sha256, "ffmpeg");
  const identityBody = {
    toolchain,
    voice: LC4_DEV_PINNED_VOICE,
    normalization: "ffmpeg-loudnorm-I-20-LRA-7-TP-3" as const,
  };
  const identity: Lc4DevAudioRendererIdentity = Object.freeze({
    renderer: "macos-say-ffmpeg-loudnorm-v2",
    identity_sha256: sha256Hex(`${TOOLCHAIN_DOMAIN}${canonicalJson(identityBody)}`),
    ...identityBody,
  });
  const verify = async () => {
    await assertExecutable(toolchain.say_path, toolchain.say_sha256, "macOS say");
    await assertExecutable(toolchain.ffmpeg_path, toolchain.ffmpeg_sha256, "ffmpeg");
  };
  return Object.freeze({
    identity,
    async assertReady() {
      await verify();
      const voices = await runCommand({ command: toolchain.say_path, args: ["-v", "?"] });
      const available = new Map(voices.stdout.split(/\r?\n/u).flatMap((line) => {
        const match = /^(\S+)\s+([a-z]{2}_[A-Z]{2})\s+/u.exec(line);
        return match ? [[match[1]!, match[2]!]] : [];
      }));
      if (available.get(LC4_DEV_PINNED_VOICE.name) !== LC4_DEV_PINNED_VOICE.locale) {
        throw new Error("LC4-DEV pinned Samantha en_US voice is unavailable");
      }
      await runCommand({ command: toolchain.ffmpeg_path, args: ["-version"] });
    },
    assertUnchanged: verify,
    async render({ text, sourceTextSha256, workspace }) {
      if (!text || text.includes("\0")) throw new Error("LC4-DEV source text is invalid");
      const expectedHashes = [
        sha256Hex(`hacc/lc4-dev/caller-text/v1\n${text}`),
        sha256Hex(`hacc/lc4-dev/repair-text/v1\n${text}`),
      ];
      if (!expectedHashes.includes(sourceTextSha256)) throw new Error("LC4-DEV source text commitment mismatch");
      const stem = join(workspace, sourceTextSha256);
      const aiff = `${stem}.aiff`;
      const decoded = `${stem}.decoded.48000.pcm`;
      const master = `${stem}.48000.pcm`;
      const pcm16k = `${stem}.16000.pcm`;
      const pcm24k = `${stem}.24000.pcm`;
      try {
        await runCommand({
          command: toolchain.say_path,
          args: [
            "-v", LC4_DEV_PINNED_VOICE.name,
            "-r", String(LC4_DEV_PINNED_VOICE.words_per_minute),
            "-o", aiff,
            "-f", "-",
          ],
          stdin: text,
        });
        await runCommand({
          command: toolchain.ffmpeg_path,
          args: [
            "-nostdin", "-loglevel", "error", "-nostats", "-n", "-i", aiff,
            "-map_metadata", "-1",
            "-af", "aresample=48000:resampler=soxr:precision=28:dither_method=none",
            "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", "48000", decoded,
          ],
        });
        await runCommand({
          command: toolchain.ffmpeg_path,
          args: [
            "-nostdin", "-loglevel", "error", "-nostats", "-n",
            "-f", "s16le", "-ar", "48000", "-ac", "1", "-i", decoded,
            "-af", "loudnorm=I=-20:LRA=7:TP=-3",
            "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", "48000", master,
          ],
        });
        for (const [rate, output] of [[16_000, pcm16k], [24_000, pcm24k]] as const) {
          await runCommand({
            command: toolchain.ffmpeg_path,
            args: [
              "-nostdin", "-loglevel", "error", "-nostats", "-n",
              "-f", "s16le", "-ar", "48000", "-ac", "1", "-i", master,
              "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
              "-af", `aresample=${rate}:resampler=soxr:precision=28:dither_method=none`,
              "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(rate), output,
            ],
          });
        }
        return Object.freeze({
          master48k: new Uint8Array(await readFile(master)),
          pcm16k: new Uint8Array(await readFile(pcm16k)),
          pcm24k: new Uint8Array(await readFile(pcm24k)),
        });
      } finally {
        await Promise.all([aiff, decoded, master, pcm16k, pcm24k].map((path) => rm(path, { force: true })));
      }
    },
  });
}

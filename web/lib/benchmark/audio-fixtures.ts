import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./artifacts";

export const CALLER_AUDIO_MANIFEST_FILE = "fixture-manifest.json";
export const CALLER_AUDIO_RENDITIONS = Object.freeze([
  "pcm16le_mono_16000",
  "pcm16le_mono_24000",
] as const);

export type CallerAudioRendition = (typeof CALLER_AUDIO_RENDITIONS)[number];

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const CALLER_SEQUENCE_HASH_DOMAIN = "harshas-amazing-call-center/caller-sequence/v1\n";
const AUDIO_SEQUENCE_HASH_DOMAIN = "harshas-amazing-call-center/audio-sequence/v1\n";
const AUDIO_SET_HASH_DOMAIN = "harshas-amazing-call-center/audio-set/v1\n";
const FIXTURE_SET_HASH_DOMAIN = "harshas-amazing-call-center/audio-fixture-set/v1\n";
const MANIFEST_HASH_DOMAIN = "harshas-amazing-call-center/audio-fixture-manifest/v1\n";
const TEXT_HASH_DOMAIN = "harshas-amazing-call-center/caller-text/v1\n";
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_FIXTURE_SET_BYTES = 512 * 1024 * 1024;
const SIGNAL_FRAME_DURATION_MS = 20;
const SIGNAL_FRAME_RATE_HZ = 1_000 / SIGNAL_FRAME_DURATION_MS;
const ACTIVE_FRAME_MINIMUM_NONZERO_FRACTION = 0.05;
const ACTIVE_FRAME_MINIMUM_COVERAGE = 0.05;
const LARGE_STEP_THRESHOLD = 30_000;
const MAX_LARGE_STEP_FRACTION_OF_NONZERO_SAMPLES = 0.25;
const MINIMUM_NOMINAL_WORD_DURATION_FRACTION = 0.25;

const SafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Sha256Schema = z.string().regex(SHA256_PATTERN);

const ScenarioIdentitySchema = z.object({
  id: z.string().min(1).max(256),
  version: z.string().min(1).max(128),
  canonical_sha256: Sha256Schema,
}).strict();

const PcmSignalSchema = z.object({
  nonzero_sample_count: SafeIntegerSchema,
  peak_absolute_sample: z.number().int().min(0).max(32_768),
  mean_square: z.number().int().min(0).max(1_073_741_824),
  zero_crossing_count: SafeIntegerSchema,
  clipped_sample_count: SafeIntegerSchema,
  frame_sample_count: z.union([z.literal(320), z.literal(480)]),
  frame_count: SafeIntegerSchema,
  active_frame_count: SafeIntegerSchema,
  longest_inactive_frame_run: SafeIntegerSchema,
  large_step_sample_count: SafeIntegerSchema,
}).strict();

const PcmDescriptorSchema = z.object({
  path: z.string().min(1).max(1024),
  sha256: Sha256Schema,
  byte_length: SafeIntegerSchema,
  sample_count: SafeIntegerSchema,
  sample_rate_hz: z.union([z.literal(16_000), z.literal(24_000)]),
  channels: z.literal(1),
  sample_format: z.literal("s16le"),
  signal: PcmSignalSchema,
}).strict();

const TurnManifestSchema = z.object({
  ordinal: SafeIntegerSchema,
  caller_turn_id: z.string().min(1).max(256),
  pause_after_ms: SafeIntegerSchema,
  source_text_utf8_sha256: Sha256Schema,
  source_text_utf8_byte_length: SafeIntegerSchema,
  source_text_word_count: SafeIntegerSchema,
  source_aiff_sha256: Sha256Schema,
  renditions: z.object({
    pcm16le_mono_16000: PcmDescriptorSchema,
    pcm16le_mono_24000: PcmDescriptorSchema,
  }).strict(),
}).strict();

const ToolchainSchema = z.object({
  macos: z.object({
    product_version: z.string().min(1).max(128),
    build_version: z.string().min(1).max(128),
  }).strict(),
  say: z.object({
    implementation: z.literal("macos-say"),
    binary_sha256: Sha256Schema,
    version_source: z.literal("macos-bundle"),
    voice_inventory_sha256: Sha256Schema,
    selected_voice_metadata_sha256: Sha256Schema,
    voice_asset_fingerprint_kind: z.literal("inventory-metadata-only"),
  }).strict(),
  ffmpeg: z.object({
    version: z.string().min(1).max(512),
    binary_sha256: Sha256Schema,
    build_configuration_sha256: Sha256Schema,
    libsoxr_enabled: z.literal(true),
    libsoxr_library_name: z.string().min(1).max(256),
    libsoxr_version: z.string().min(1).max(128),
    libsoxr_binary_sha256: Sha256Schema,
    conversion_profile: z.literal("pcm16le-mono-libsoxr-v1"),
    argv_by_rendition: z.object({
      pcm16le_mono_16000: z.array(z.string()).min(1),
      pcm16le_mono_24000: z.array(z.string()).min(1),
    }).strict(),
  }).strict(),
}).strict();

function isExactUtcTimestamp(value: string): boolean {
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
  return day >= 1 && day <= daysByMonth[month - 1];
}

const TimestampSchema = z.string()
  .regex(UTC_TIMESTAMP_PATTERN)
  .refine(isExactUtcTimestamp, "must be an exact valid UTC calendar timestamp");

const ManifestSchema = z.object({
  schema_version: z.literal(1),
  fixture_set_id: z.string().regex(/^caf_[a-f0-9]{24}$/),
  generated_at: TimestampSchema,
  scenario: ScenarioIdentitySchema,
  caller_sequence_sha256: Sha256Schema,
  synthesis: z.object({
    engine: z.literal("macos-say"),
    voice: z.string().min(1).max(128),
    rate_wpm: z.number().int().min(80).max(500),
    stdin_encoding: z.literal("utf8"),
    redistribution_status: z.literal("review-required"),
    license_spdx: z.null(),
  }).strict(),
  normalization: z.object({
    sample_format: z.literal("s16le"),
    channels: z.literal(1),
    resampler: z.literal("libsoxr"),
    precision_bits: z.literal(28),
    dither: z.literal("none"),
    loudness_normalization: z.literal(false),
    silence_trimming: z.literal(false),
  }).strict(),
  toolchain: ToolchainSchema,
  audio_sequence_sha256_by_rendition: z.object({
    pcm16le_mono_16000: Sha256Schema,
    pcm16le_mono_24000: Sha256Schema,
  }).strict(),
  audio_set_sha256: Sha256Schema,
  turns: z.array(TurnManifestSchema).min(1),
  manifest_sha256: Sha256Schema,
}).strict();

export type CallerAudioScenarioIdentity = z.infer<typeof ScenarioIdentitySchema>;
export type CallerPcmDescriptor = z.infer<typeof PcmDescriptorSchema>;
export type CallerAudioTurnManifest = z.infer<typeof TurnManifestSchema>;
export type CallerAudioToolchain = z.infer<typeof ToolchainSchema>;
export type CallerAudioFixtureManifest = z.infer<typeof ManifestSchema>;

export type CallerAudioTurn = Readonly<{
  id: string;
  text: string;
  pause_after_ms?: number;
}>;

export type GeneratedCallerAudioTurn = Readonly<{
  caller_turn_id: string;
  source_aiff_sha256: string;
  renditions: Readonly<Record<CallerAudioRendition, CallerPcmDescriptor>>;
}>;

export type FrozenFixtureFileReader = (
  rootDirectory: string,
  relativePath: string
) => Promise<Uint8Array>;

export type VerifyCallerAudioFixtureOptions = Readonly<{
  rootDirectory: string;
  expectedScenario: CallerAudioScenarioIdentity;
  expectedTurns: readonly CallerAudioTurn[];
  expectedManifestSha256?: string;
  readFrozenFile?: FrozenFixtureFileReader;
}>;

export type CallerAudioFixtureVerification = Readonly<{
  valid: boolean;
  manifest: CallerAudioFixtureManifest | null;
  errors: readonly string[];
}>;

const VERIFIED_FIXTURE = Symbol("verified-frozen-caller-audio");

export type VerifiedFrozenCallerAudio = Readonly<{
  [VERIFIED_FIXTURE]: true;
  manifest: CallerAudioFixtureManifest;
  readPcm(turnId: string, rendition: CallerAudioRendition): Uint8Array;
}>;

type NormalizedTurn = Readonly<{
  ordinal: number;
  caller_turn_id: string;
  pause_after_ms: number;
  source_text_utf8_sha256: string;
  source_text_utf8_byte_length: number;
  source_text_word_count: number;
}>;

type LoadedVerification = Readonly<{
  verification: CallerAudioFixtureVerification;
  bytes: ReadonlyMap<string, Uint8Array>;
}>;

function domainHash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(value)}`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function hashCallerText(text: string): string {
  return sha256Hex(`${TEXT_HASH_DOMAIN}${text}`);
}

function normalizeTurns(turns: readonly CallerAudioTurn[]): readonly NormalizedTurn[] {
  if (turns.length === 0) throw new Error("Caller audio fixture requires at least one turn");
  const seenIds = new Set<string>();

  return Object.freeze(turns.map((turn, ordinal) => {
    if (typeof turn.id !== "string" || turn.id.length === 0 || turn.id.length > 256) {
      throw new Error(`Caller turn ${ordinal} has an invalid id`);
    }
    if (/[\0\r\n]/.test(turn.id)) throw new Error(`Caller turn ${ordinal} id contains a control character`);
    if (seenIds.has(turn.id)) throw new Error(`Duplicate caller turn id: ${turn.id}`);
    seenIds.add(turn.id);

    if (typeof turn.text !== "string" || turn.text.trim().length === 0) {
      throw new Error(`Caller turn ${turn.id} has empty text`);
    }
    if (turn.text.includes("\0")) throw new Error(`Caller turn ${turn.id} contains a NUL byte`);
    const byteLength = Buffer.byteLength(turn.text, "utf8");
    if (byteLength > 1_000_000) throw new Error(`Caller turn ${turn.id} text is too large`);

    const pauseAfterMs = turn.pause_after_ms ?? 0;
    if (!Number.isSafeInteger(pauseAfterMs) || pauseAfterMs < 0 || pauseAfterMs > 600_000) {
      throw new Error(`Caller turn ${turn.id} has an invalid pause_after_ms`);
    }

    return Object.freeze({
      ordinal,
      caller_turn_id: turn.id,
      pause_after_ms: pauseAfterMs,
      source_text_utf8_sha256: hashCallerText(turn.text),
      source_text_utf8_byte_length: byteLength,
      source_text_word_count: turn.text.trim().split(/\s+/u).length,
    });
  }));
}

export function hashCallerAudioSequence(turns: readonly CallerAudioTurn[]): string {
  return domainHash(CALLER_SEQUENCE_HASH_DOMAIN, normalizeTurns(turns));
}

function minimumPlausibleTextDurationSeconds(
  turn: Readonly<{
    source_text_utf8_byte_length: number;
    source_text_word_count: number;
  }>,
  rateWpm: number
): number {
  const nominalWordDuration = turn.source_text_word_count * 60 / rateWpm;
  return Math.max(
    0.25,
    turn.source_text_utf8_byte_length / 100,
    nominalWordDuration * MINIMUM_NOMINAL_WORD_DURATION_FRACTION
  );
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path) || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function descriptorErrors(descriptor: CallerPcmDescriptor, expectedRate: 16_000 | 24_000): string[] {
  const errors: string[] = [];
  if (!isSafeRelativePath(descriptor.path)) errors.push(`${descriptor.path} is not a safe normalized relative path`);
  if (descriptor.sample_rate_hz !== expectedRate) {
    errors.push(`${descriptor.path} has sample rate ${descriptor.sample_rate_hz}, expected ${expectedRate}`);
  }
  if (descriptor.byte_length === 0) errors.push(`${descriptor.path} is empty`);
  if (descriptor.byte_length % 2 !== 0) errors.push(`${descriptor.path} has an odd PCM byte length`);
  if (descriptor.byte_length !== descriptor.sample_count * 2) {
    errors.push(`${descriptor.path} byte_length does not equal sample_count * 2`);
  }
  if (descriptor.sample_count < Math.ceil(expectedRate / 4)) {
    errors.push(`${descriptor.path} is shorter than the 250 ms acoustic minimum`);
  }
  const signal = descriptor.signal;
  if (signal.nonzero_sample_count > descriptor.sample_count) {
    errors.push(`${descriptor.path} nonzero_sample_count exceeds sample_count`);
  }
  if (signal.zero_crossing_count > Math.max(0, descriptor.sample_count - 1)) {
    errors.push(`${descriptor.path} zero_crossing_count is impossible`);
  }
  if (signal.clipped_sample_count > descriptor.sample_count) {
    errors.push(`${descriptor.path} clipped_sample_count exceeds sample_count`);
  }
  const expectedFrameSampleCount = expectedRate / SIGNAL_FRAME_RATE_HZ;
  const expectedFrameCount = Math.ceil(descriptor.sample_count / expectedFrameSampleCount);
  if (signal.frame_sample_count !== expectedFrameSampleCount) {
    errors.push(`${descriptor.path} has an invalid signal frame size`);
  }
  if (signal.frame_count !== expectedFrameCount) {
    errors.push(`${descriptor.path} has an invalid signal frame count`);
  }
  if (signal.active_frame_count > signal.frame_count) {
    errors.push(`${descriptor.path} active_frame_count exceeds frame_count`);
  }
  if (signal.longest_inactive_frame_run > signal.frame_count) {
    errors.push(`${descriptor.path} longest_inactive_frame_run exceeds frame_count`);
  }
  if (signal.large_step_sample_count > descriptor.sample_count) {
    errors.push(`${descriptor.path} large_step_sample_count exceeds sample_count`);
  }
  const minimumNonzero = Math.max(32, Math.ceil(descriptor.sample_count / 1_000));
  if (signal.nonzero_sample_count < minimumNonzero || signal.peak_absolute_sample < 64 || signal.mean_square < 1_024) {
    errors.push(`${descriptor.path} fails the deterministic non-silence/energy gate`);
  }
  if (signal.zero_crossing_count < 2) {
    errors.push(`${descriptor.path} fails the deterministic waveform-variation gate`);
  }
  if (signal.clipped_sample_count > Math.ceil(descriptor.sample_count / 100)) {
    errors.push(`${descriptor.path} exceeds the 1% clipping gate`);
  }
  const minimumActiveFrames = Math.max(2, Math.ceil(signal.frame_count * ACTIVE_FRAME_MINIMUM_COVERAGE));
  if (signal.active_frame_count < minimumActiveFrames) {
    errors.push(`${descriptor.path} fails the deterministic non-silent frame-coverage gate`);
  }
  const maximumInactiveRun = Math.max(
    Math.ceil(3_000 / SIGNAL_FRAME_DURATION_MS),
    Math.ceil(signal.frame_count / 2)
  );
  if (signal.longest_inactive_frame_run > maximumInactiveRun) {
    errors.push(`${descriptor.path} fails the deterministic maximum-silence gate`);
  }
  const maximumLargeSteps = Math.max(
    8,
    Math.ceil(signal.nonzero_sample_count * MAX_LARGE_STEP_FRACTION_OF_NONZERO_SAMPLES)
  );
  if (signal.large_step_sample_count > maximumLargeSteps) {
    errors.push(`${descriptor.path} fails the deterministic impulse-density gate`);
  }
  return errors;
}

function analyzePcmSignal(
  bytes: Uint8Array,
  sampleRateHz: 16_000 | 24_000
): z.infer<typeof PcmSignalSchema> {
  const frameSampleCount = sampleRateHz / SIGNAL_FRAME_RATE_HZ as 320 | 480;
  if (bytes.byteLength % 2 !== 0) {
    return {
      nonzero_sample_count: 0,
      peak_absolute_sample: 0,
      mean_square: 0,
      zero_crossing_count: 0,
      clipped_sample_count: 0,
      frame_sample_count: frameSampleCount,
      frame_count: 0,
      active_frame_count: 0,
      longest_inactive_frame_run: 0,
      large_step_sample_count: 0,
    };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleCount = bytes.byteLength / 2;
  let nonzeroSampleCount = 0;
  let peakAbsoluteSample = 0;
  let sumSquares = BigInt(0);
  let zeroCrossingCount = 0;
  let clippedSampleCount = 0;
  let largeStepSampleCount = 0;
  let previousSign = 0;
  let previousSample: number | null = null;
  let activeFrameCount = 0;
  let currentInactiveFrameRun = 0;
  let longestInactiveFrameRun = 0;
  let frameNonzeroSampleCount = 0;
  let framePeakAbsoluteSample = 0;
  let frameSumSquares = BigInt(0);
  let frameLength = 0;

  const completeFrame = (): void => {
    if (frameLength === 0) return;
    const minimumFrameNonzeroSamples = Math.max(
      8,
      Math.ceil(frameLength * ACTIVE_FRAME_MINIMUM_NONZERO_FRACTION)
    );
    const frameMeanSquare = Number(frameSumSquares / BigInt(frameLength));
    const active = frameNonzeroSampleCount >= minimumFrameNonzeroSamples
      && framePeakAbsoluteSample >= 64
      && frameMeanSquare >= 1_024;
    if (active) {
      activeFrameCount += 1;
      currentInactiveFrameRun = 0;
    } else {
      currentInactiveFrameRun += 1;
      longestInactiveFrameRun = Math.max(longestInactiveFrameRun, currentInactiveFrameRun);
    }
    frameNonzeroSampleCount = 0;
    framePeakAbsoluteSample = 0;
    frameSumSquares = BigInt(0);
    frameLength = 0;
  };

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true);
    const absolute = sample === -32_768 ? 32_768 : Math.abs(sample);
    if (sample !== 0) {
      nonzeroSampleCount += 1;
      frameNonzeroSampleCount += 1;
    }
    if (absolute > peakAbsoluteSample) peakAbsoluteSample = absolute;
    if (absolute > framePeakAbsoluteSample) framePeakAbsoluteSample = absolute;
    sumSquares += BigInt(sample) * BigInt(sample);
    frameSumSquares += BigInt(sample) * BigInt(sample);
    frameLength += 1;
    if (absolute >= 32_760) clippedSampleCount += 1;
    if (previousSample !== null && Math.abs(sample - previousSample) >= LARGE_STEP_THRESHOLD) {
      largeStepSampleCount += 1;
    }
    previousSample = sample;
    const sign = sample < 0 ? -1 : sample > 0 ? 1 : 0;
    if (sign !== 0) {
      if (previousSign !== 0 && sign !== previousSign) zeroCrossingCount += 1;
      previousSign = sign;
    }
    if (frameLength === frameSampleCount) completeFrame();
  }
  completeFrame();
  return {
    nonzero_sample_count: nonzeroSampleCount,
    peak_absolute_sample: peakAbsoluteSample,
    mean_square: sampleCount === 0 ? 0 : Number(sumSquares / BigInt(sampleCount)),
    zero_crossing_count: zeroCrossingCount,
    clipped_sample_count: clippedSampleCount,
    frame_sample_count: frameSampleCount,
    frame_count: Math.ceil(sampleCount / frameSampleCount),
    active_frame_count: activeFrameCount,
    longest_inactive_frame_run: longestInactiveFrameRun,
    large_step_sample_count: largeStepSampleCount,
  };
}

function semanticPcmDescriptor(descriptor: CallerPcmDescriptor): Omit<CallerPcmDescriptor, "path"> {
  return {
    sha256: descriptor.sha256,
    byte_length: descriptor.byte_length,
    sample_count: descriptor.sample_count,
    sample_rate_hz: descriptor.sample_rate_hz,
    channels: descriptor.channels,
    sample_format: descriptor.sample_format,
    signal: descriptor.signal,
  };
}

function audioSequenceHash(
  turns: readonly CallerAudioTurnManifest[],
  rendition: CallerAudioRendition
): string {
  return domainHash(AUDIO_SEQUENCE_HASH_DOMAIN, turns.map((turn) => ({
    ordinal: turn.ordinal,
    caller_turn_id: turn.caller_turn_id,
    source_text_utf8_sha256: turn.source_text_utf8_sha256,
    pause_after_ms: turn.pause_after_ms,
    // Storage layout is deliberately excluded. Content/provenance identity must
    // survive moving or renaming an otherwise byte-identical frozen fixture.
    pcm: semanticPcmDescriptor(turn.renditions[rendition]),
  })));
}

function manifestBody(manifest: Omit<CallerAudioFixtureManifest, "manifest_sha256">): Omit<CallerAudioFixtureManifest, "manifest_sha256"> {
  return manifest;
}

function expectedFixtureSetId(input: {
  scenario: CallerAudioScenarioIdentity;
  caller_sequence_sha256: string;
  synthesis: CallerAudioFixtureManifest["synthesis"];
  normalization: CallerAudioFixtureManifest["normalization"];
  toolchain: CallerAudioToolchain;
  audio_set_sha256: string;
}): string {
  return `caf_${domainHash(FIXTURE_SET_HASH_DOMAIN, input).slice(0, 24)}`;
}

export function createCallerPcmDescriptor(input: {
  path: string;
  bytes: Uint8Array;
  sampleRateHz: 16_000 | 24_000;
}): CallerPcmDescriptor {
  const descriptor: CallerPcmDescriptor = {
    path: input.path,
    sha256: sha256Hex(input.bytes),
    byte_length: input.bytes.byteLength,
    sample_count: input.bytes.byteLength / 2,
    sample_rate_hz: input.sampleRateHz,
    channels: 1,
    sample_format: "s16le",
    signal: analyzePcmSignal(input.bytes, input.sampleRateHz),
  };
  const errors = descriptorErrors(descriptor, input.sampleRateHz);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return Object.freeze(descriptor);
}

export function createCallerAudioFixtureManifest(input: {
  generatedAt: string;
  scenario: CallerAudioScenarioIdentity;
  turns: readonly CallerAudioTurn[];
  voice: string;
  rateWpm: number;
  toolchain: CallerAudioToolchain;
  generatedTurns: readonly GeneratedCallerAudioTurn[];
}): CallerAudioFixtureManifest {
  const normalizedTurns = normalizeTurns(input.turns);
  if (normalizedTurns.length !== input.generatedTurns.length) {
    throw new Error("Generated caller audio turn count does not match the caller sequence");
  }

  const generatedPaths = new Set<string>();
  const turns: CallerAudioTurnManifest[] = normalizedTurns.map((turn, index) => {
    const generated = input.generatedTurns[index];
    if (generated.caller_turn_id !== turn.caller_turn_id) {
      throw new Error(`Generated caller audio order mismatch at ordinal ${index}`);
    }
    const parsed = TurnManifestSchema.parse({
      ...turn,
      source_aiff_sha256: generated.source_aiff_sha256,
      renditions: generated.renditions,
    });
    const errors = [
      ...descriptorErrors(parsed.renditions.pcm16le_mono_16000, 16_000),
      ...descriptorErrors(parsed.renditions.pcm16le_mono_24000, 24_000),
    ];
    for (const descriptor of Object.values(parsed.renditions)) {
      if (generatedPaths.has(descriptor.path)) errors.push(`duplicate PCM path ${descriptor.path}`);
      generatedPaths.add(descriptor.path);
    }
    const duration16 = parsed.renditions.pcm16le_mono_16000.sample_count / 16_000;
    const duration24 = parsed.renditions.pcm16le_mono_24000.sample_count / 24_000;
    if (Math.abs(duration16 - duration24) > (1 / 16_000 + 1 / 24_000)) {
      errors.push(`turn ${index} rendition durations differ by more than resampling tolerance`);
    }
    const minimumTextDuration = minimumPlausibleTextDurationSeconds(parsed, input.rateWpm);
    if (duration16 < minimumTextDuration || duration24 < minimumTextDuration) {
      errors.push(`turn ${index} audio is implausibly short for its source text`);
    }
    if (errors.length > 0) throw new Error(errors.join("; "));
    return parsed;
  });

  const callerSequenceSha256 = domainHash(CALLER_SEQUENCE_HASH_DOMAIN, normalizedTurns);
  const audioSequenceSha256ByRendition = {
    pcm16le_mono_16000: audioSequenceHash(turns, "pcm16le_mono_16000"),
    pcm16le_mono_24000: audioSequenceHash(turns, "pcm16le_mono_24000"),
  } as const;
  const audioSetSha256 = domainHash(AUDIO_SET_HASH_DOMAIN, audioSequenceSha256ByRendition);
  const synthesis = {
    engine: "macos-say" as const,
    voice: input.voice,
    rate_wpm: input.rateWpm,
    stdin_encoding: "utf8" as const,
    redistribution_status: "review-required" as const,
    license_spdx: null,
  };
  const normalization = {
    sample_format: "s16le" as const,
    channels: 1 as const,
    resampler: "libsoxr" as const,
    precision_bits: 28 as const,
    dither: "none" as const,
    loudness_normalization: false as const,
    silence_trimming: false as const,
  };
  const fixtureSetId = expectedFixtureSetId({
    scenario: input.scenario,
    caller_sequence_sha256: callerSequenceSha256,
    synthesis,
    normalization,
    toolchain: input.toolchain,
    audio_set_sha256: audioSetSha256,
  });
  const body = ManifestSchema.omit({ manifest_sha256: true }).parse({
    schema_version: 1,
    fixture_set_id: fixtureSetId,
    generated_at: input.generatedAt,
    scenario: input.scenario,
    caller_sequence_sha256: callerSequenceSha256,
    synthesis,
    normalization,
    toolchain: input.toolchain,
    audio_sequence_sha256_by_rendition: audioSequenceSha256ByRendition,
    audio_set_sha256: audioSetSha256,
    turns,
  });
  return deepFreeze(ManifestSchema.parse({
    ...body,
    manifest_sha256: domainHash(MANIFEST_HASH_DOMAIN, manifestBody(body)),
  }));
}

export function serializeCallerAudioFixtureManifest(manifest: CallerAudioFixtureManifest): string {
  const parsed = ManifestSchema.parse(manifest);
  return `${canonicalJson(parsed)}\n`;
}

function parseManifest(bytes: Uint8Array): CallerAudioFixtureManifest {
  if (bytes.byteLength > 1_000_000) throw new Error("fixture manifest exceeds 1 MB");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("fixture manifest is not valid UTF-8");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("fixture manifest is not valid JSON");
  }
  const result = ManifestSchema.safeParse(json);
  if (!result.success) throw new Error("fixture manifest does not match schema version 1");
  if (text !== serializeCallerAudioFixtureManifest(result.data)) {
    throw new Error("fixture manifest is not canonical JSON with one trailing newline");
  }
  return deepFreeze(result.data);
}

function semanticManifestErrors(
  manifest: CallerAudioFixtureManifest,
  expectedScenario: CallerAudioScenarioIdentity,
  expectedTurns: readonly CallerAudioTurn[],
  expectedManifestSha256?: string
): string[] {
  const errors: string[] = [];
  const normalizedTurns = normalizeTurns(expectedTurns);
  const { manifest_sha256: recordedManifestHash, ...manifestWithoutHash } = manifest;
  const body = ManifestSchema.omit({ manifest_sha256: true }).parse(manifestWithoutHash);
  const manifestHash = domainHash(MANIFEST_HASH_DOMAIN, body);
  if (recordedManifestHash !== manifestHash) errors.push("manifest_sha256 mismatch");
  if (expectedManifestSha256 && manifest.manifest_sha256 !== expectedManifestSha256) {
    errors.push("manifest_sha256 does not match the preregistered fixture hash");
  }
  if (canonicalJson(manifest.scenario) !== canonicalJson(ScenarioIdentitySchema.parse(expectedScenario))) {
    errors.push("scenario identity mismatch");
  }
  const expectedCallerHash = domainHash(CALLER_SEQUENCE_HASH_DOMAIN, normalizedTurns);
  if (manifest.caller_sequence_sha256 !== expectedCallerHash) errors.push("caller_sequence_sha256 mismatch");
  if (manifest.turns.length !== normalizedTurns.length) errors.push("caller turn count mismatch");

  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const [index, turn] of manifest.turns.entries()) {
    if (turn.ordinal !== index) errors.push(`turn ${index} has a non-contiguous ordinal`);
    if (ids.has(turn.caller_turn_id)) errors.push(`duplicate caller turn id ${turn.caller_turn_id}`);
    ids.add(turn.caller_turn_id);
    const expected = normalizedTurns[index];
    if (expected && canonicalJson({
      ordinal: turn.ordinal,
      caller_turn_id: turn.caller_turn_id,
      pause_after_ms: turn.pause_after_ms,
      source_text_utf8_sha256: turn.source_text_utf8_sha256,
      source_text_utf8_byte_length: turn.source_text_utf8_byte_length,
      source_text_word_count: turn.source_text_word_count,
    }) !== canonicalJson(expected)) {
      errors.push(`caller turn ${index} does not match the expected exact text/order`);
    }

    for (const [rendition, expectedRate] of [
      ["pcm16le_mono_16000", 16_000],
      ["pcm16le_mono_24000", 24_000],
    ] as const) {
      const descriptor = turn.renditions[rendition];
      errors.push(...descriptorErrors(descriptor, expectedRate));
      if (paths.has(descriptor.path)) errors.push(`duplicate PCM path ${descriptor.path}`);
      paths.add(descriptor.path);
    }

    const duration16 = turn.renditions.pcm16le_mono_16000.sample_count / 16_000;
    const duration24 = turn.renditions.pcm16le_mono_24000.sample_count / 24_000;
    if (Math.abs(duration16 - duration24) > (1 / 16_000 + 1 / 24_000)) {
      errors.push(`turn ${index} rendition durations differ by more than resampling tolerance`);
    }
    const minimumTextDuration = minimumPlausibleTextDurationSeconds(
      turn,
      manifest.synthesis.rate_wpm
    );
    if (duration16 < minimumTextDuration || duration24 < minimumTextDuration) {
      errors.push(`turn ${index} audio is implausibly short for its source text`);
    }
  }

  const expectedAudioSequences = {
    pcm16le_mono_16000: audioSequenceHash(manifest.turns, "pcm16le_mono_16000"),
    pcm16le_mono_24000: audioSequenceHash(manifest.turns, "pcm16le_mono_24000"),
  };
  for (const rendition of CALLER_AUDIO_RENDITIONS) {
    if (manifest.audio_sequence_sha256_by_rendition[rendition] !== expectedAudioSequences[rendition]) {
      errors.push(`${rendition} audio sequence hash mismatch`);
    }
  }
  const expectedAudioSetHash = domainHash(AUDIO_SET_HASH_DOMAIN, expectedAudioSequences);
  if (manifest.audio_set_sha256 !== expectedAudioSetHash) errors.push("audio_set_sha256 mismatch");
  const fixtureSetId = expectedFixtureSetId({
    scenario: manifest.scenario,
    caller_sequence_sha256: manifest.caller_sequence_sha256,
    synthesis: manifest.synthesis,
    normalization: manifest.normalization,
    toolchain: manifest.toolchain,
    audio_set_sha256: manifest.audio_set_sha256,
  });
  if (manifest.fixture_set_id !== fixtureSetId) errors.push("fixture_set_id mismatch");
  return errors;
}

function pathInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function safeFixtureFailure(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const safePrefixes = [
    "fixture manifest ",
    "unsafe frozen fixture path",
    "invalid frozen fixture byte limit",
    "frozen fixture path ",
    "frozen fixture descriptor ",
    "frozen fixture changed ",
    "frozen fixture exceeds ",
  ];
  return safePrefixes.some((prefix) => error.message.startsWith(prefix))
    ? error.message
    : fallback;
}

/** Read once from the same no-follow file descriptor that is hashed and returned. */
async function readFrozenFixtureFileNoFollowUnsafe(
  rootDirectory: string,
  relativePath: string,
  maxBytes = 512 * 1024 * 1024
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid frozen fixture byte limit");
  if (!isSafeRelativePath(relativePath)) throw new Error("unsafe frozen fixture path");
  const root = await realpath(rootDirectory);
  const candidate = resolve(root, ...relativePath.split("/"));
  if (!pathInside(root, candidate)) throw new Error("frozen fixture path escapes its root");
  const pathStat = await lstat(candidate, { bigint: true });
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw new Error("frozen fixture path is not a regular file");
  const resolvedCandidate = await realpath(candidate);
  if (resolvedCandidate !== candidate || !pathInside(root, resolvedCandidate)) {
    throw new Error("frozen fixture path contains a symbolic link");
  }

  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("frozen fixture descriptor is not a regular file");
    if (before.dev !== pathStat.dev || before.ino !== pathStat.ino || before.size !== pathStat.size) {
      throw new Error("frozen fixture changed before it was opened");
    }
    if (before.size > BigInt(maxBytes)) {
      throw new Error(`frozen fixture exceeds its ${maxBytes}-byte limit`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("frozen fixture changed while being read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Public no-follow reader with a deliberately path-free error boundary. */
export async function readFrozenFixtureFileNoFollow(
  rootDirectory: string,
  relativePath: string,
  maxBytes = 512 * 1024 * 1024
): Promise<Uint8Array> {
  try {
    return await readFrozenFixtureFileNoFollowUnsafe(rootDirectory, relativePath, maxBytes);
  } catch (error) {
    throw new Error(safeFixtureFailure(error, "frozen fixture file is missing, unreadable, or unsafe"));
  }
}

async function loadAndVerifyCallerAudioFixture(
  options: VerifyCallerAudioFixtureOptions
): Promise<LoadedVerification> {
  const errors: string[] = [];
  const bytesByPath = new Map<string, Uint8Array>();
  const customReader = options.readFrozenFile;
  let manifest: CallerAudioFixtureManifest;

  try {
    const manifestBytes = customReader
      ? await customReader(options.rootDirectory, CALLER_AUDIO_MANIFEST_FILE)
      : await readFrozenFixtureFileNoFollow(
        options.rootDirectory,
        CALLER_AUDIO_MANIFEST_FILE,
        MAX_MANIFEST_BYTES
      );
    manifest = parseManifest(manifestBytes);
  } catch (error) {
    const message = safeFixtureFailure(error, "fixture manifest is missing, unreadable, or unsafe");
    return {
      verification: Object.freeze({ valid: false, manifest: null, errors: Object.freeze([message]) }),
      bytes: bytesByPath,
    };
  }

  try {
    errors.push(...semanticManifestErrors(
      manifest,
      options.expectedScenario,
      options.expectedTurns,
      options.expectedManifestSha256
    ));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "manifest semantic validation failed");
  }

  if (errors.length > 0) {
    return {
      verification: Object.freeze({ valid: false, manifest, errors: Object.freeze(errors) }),
      bytes: bytesByPath,
    };
  }

  let declaredFixtureBytes = 0;
  for (const turn of manifest.turns) {
    for (const rendition of CALLER_AUDIO_RENDITIONS) {
      declaredFixtureBytes += turn.renditions[rendition].byte_length;
      if (!Number.isSafeInteger(declaredFixtureBytes) || declaredFixtureBytes > MAX_FIXTURE_SET_BYTES) {
        errors.push(`fixture set exceeds the ${MAX_FIXTURE_SET_BYTES}-byte aggregate limit`);
        break;
      }
    }
    if (errors.length > 0) break;
  }
  if (errors.length > 0) {
    return {
      verification: Object.freeze({ valid: false, manifest, errors: Object.freeze(errors) }),
      bytes: bytesByPath,
    };
  }

  for (const turn of manifest.turns) {
    for (const rendition of CALLER_AUDIO_RENDITIONS) {
      const descriptor = turn.renditions[rendition];
      try {
        const bytes = customReader
          ? await customReader(options.rootDirectory, descriptor.path)
          : await readFrozenFixtureFileNoFollow(
            options.rootDirectory,
            descriptor.path,
            descriptor.byte_length
          );
        const fileErrors: string[] = [];
        if (bytes.byteLength !== descriptor.byte_length) fileErrors.push(`${descriptor.path} byte_length mismatch`);
        if (bytes.byteLength % 2 !== 0) fileErrors.push(`${descriptor.path} has an odd PCM byte length`);
        if (sha256Hex(bytes) !== descriptor.sha256) fileErrors.push(`${descriptor.path} sha256 mismatch`);
        if (bytes.byteLength / 2 !== descriptor.sample_count) fileErrors.push(`${descriptor.path} sample_count mismatch`);
        if (canonicalJson(analyzePcmSignal(bytes, descriptor.sample_rate_hz)) !== canonicalJson(descriptor.signal)) {
          fileErrors.push(`${descriptor.path} signal analysis mismatch`);
        }
        errors.push(...fileErrors);
        if (fileErrors.length === 0) {
          bytesByPath.set(descriptor.path, customReader ? Uint8Array.from(bytes) : bytes);
        }
      } catch (error) {
        const message = safeFixtureFailure(error, "frozen fixture file is missing, unreadable, or unsafe");
        errors.push(`${descriptor.path} could not be verified: ${message}`);
      }
    }
  }

  return {
    verification: Object.freeze({
      valid: errors.length === 0,
      manifest,
      errors: Object.freeze(errors),
    }),
    bytes: bytesByPath,
  };
}

export async function verifyCallerAudioFixture(
  options: VerifyCallerAudioFixtureOptions
): Promise<CallerAudioFixtureVerification> {
  return (await loadAndVerifyCallerAudioFixture(options)).verification;
}

/**
 * Paid runs call this verifier/loader. This module has no synthesis or process
 * execution dependency, and returns the exact in-memory bytes it verified.
 */
export async function loadFrozenCallerAudioForPaidTrial(
  options: Omit<VerifyCallerAudioFixtureOptions, "readFrozenFile" | "expectedManifestSha256">
    & Readonly<{ expectedManifestSha256: string }>
): Promise<VerifiedFrozenCallerAudio> {
  if (Object.hasOwn(options as object, "readFrozenFile")) {
    throw new Error("Paid trials cannot override the secure frozen-fixture reader");
  }
  if (!SHA256_PATTERN.test(options.expectedManifestSha256)) {
    throw new Error("A lowercase preregistered fixture manifest SHA-256 is required for paid trials");
  }
  const loaded = await loadAndVerifyCallerAudioFixture({
    rootDirectory: options.rootDirectory,
    expectedScenario: options.expectedScenario,
    expectedTurns: options.expectedTurns,
    expectedManifestSha256: options.expectedManifestSha256,
  });
  if (!loaded.verification.valid || !loaded.verification.manifest) {
    throw new Error(`Frozen caller audio verification failed: ${loaded.verification.errors.join("; ")}`);
  }
  const manifest = loaded.verification.manifest;
  const byTurn = new Map<string, Readonly<Record<CallerAudioRendition, Uint8Array>>>();
  for (const turn of manifest.turns) {
    byTurn.set(turn.caller_turn_id, {
      pcm16le_mono_16000: loaded.bytes.get(turn.renditions.pcm16le_mono_16000.path)!,
      pcm16le_mono_24000: loaded.bytes.get(turn.renditions.pcm16le_mono_24000.path)!,
    });
  }
  return Object.freeze({
    [VERIFIED_FIXTURE]: true as const,
    manifest,
    readPcm(turnId: string, rendition: CallerAudioRendition): Uint8Array {
      const turn = byTurn.get(turnId);
      if (!turn) throw new Error(`Unknown caller audio turn id: ${turnId}`);
      return Uint8Array.from(turn[rendition]);
    },
  });
}

export function assertPairedCallerAudio(
  left: VerifiedFrozenCallerAudio,
  right: VerifiedFrozenCallerAudio,
  rendition: CallerAudioRendition
): void {
  if (left.manifest.manifest_sha256 !== right.manifest.manifest_sha256) {
    throw new Error("Paired arms do not use the same frozen caller audio manifest");
  }
  if (
    left.manifest.audio_sequence_sha256_by_rendition[rendition]
    !== right.manifest.audio_sequence_sha256_by_rendition[rendition]
  ) {
    throw new Error(`Paired arms do not use the same ${rendition} audio sequence`);
  }
}

import { canonicalJson, sha256Hex } from "./artifacts";
import { createPublicKey, verify } from "node:crypto";
import {
  LONG_CALL_FAMILIES,
  LONG_CALL_PROTOCOL_ID,
  LONG_CALL_TTS_VOICES,
  longUsefulnessTask,
  type LongCallFamily,
  type LongCallTtsVoice,
} from "./long-call-live-experiment";
import {
  LIVE_STS_PROVIDER_SPECS,
  type LiveStsProvider,
} from "./live-sts-development-experiment";

export const LONG_CALL_ASR_CALIBRATION_ID = "HACC-LC3-ASR-CAL-v2" as const;
export const LONG_CALL_ASR_CALIBRATION_TURN_ORDINALS = Object.freeze([1, 4, 9, 14, 17, 20] as const);
/**
 * The calibration schedule follows the frozen experiment strata. Keeping this
 * derived prevents a one-voice validation schedule from silently inheriting
 * the old three-voice fixture count.
 */
export const LONG_CALL_ASR_CALIBRATION_FIXTURES = LONG_CALL_FAMILIES.length
  * LONG_CALL_TTS_VOICES.length
  * LONG_CALL_ASR_CALIBRATION_TURN_ORDINALS.length;
export const LONG_CALL_ASR_MAX_WER = 0.15 as const;
export const LONG_CALL_ASR_OUTPUT_FIXTURES_PER_VOICE = 6 as const;

const CALIBRATION_PLAN_DOMAIN = "hacc/long-call-asr-calibration-plan/v2\n";
const CALIBRATION_RESULT_DOMAIN = "hacc/long-call-asr-calibration-result/v2\n";
const CALIBRATION_ARTIFACT_DOMAIN = "hacc/long-call-asr-calibration-artifact/v2\n";
const OUTPUT_CAPTURE_RECEIPT_DOMAIN = "hacc/output-voice-calibration-capture/v1\n";
const OUTPUT_CAPTURE_SIGNATURE_DOMAIN = "hacc/output-voice-calibration-capture-signature/v1\n";
const OUTPUT_FIXTURE_MANIFEST_DOMAIN = "hacc/output-voice-calibration-manifest/v1\n";
const OUTPUT_CHUNK_SEQUENCE_DOMAIN = "hacc/output-voice-calibration-chunk-sequence/v1\n";
const OUTPUT_CAPTURE_VERIFICATION_DOMAIN = "hacc/output-voice-calibration-capture-verification/v1\n";
const OUTPUT_ASR_RESULT_DOMAIN = "hacc/output-voice-asr-calibration-result/v1\n";
const OUTPUT_ASR_ARTIFACT_DOMAIN = "hacc/output-voice-asr-calibration-artifact/v1\n";
const SAFE_CALIBRATION_UNIT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export type FrozenLongCallFixture = Readonly<{
  taskSha256: string;
  family: LongCallFamily;
  ttsVoice: LongCallTtsVoice;
  turnId: string;
  sourceTextSha256: string;
  sampleRateHz: 16_000 | 24_000;
  path: string;
  sha256: string;
  byteLength: number;
}>;

export type FrozenLongCallExperimentPlan = Readonly<{
  protocolId: typeof LONG_CALL_PROTOCOL_ID;
  experimentId: string;
  planSha256: string;
  fixtureManifestSha256: string;
  fixtures: readonly FrozenLongCallFixture[];
  outputVoiceCalibrationFixtures: readonly FrozenOutputVoiceCalibrationFixture[];
  outputVoiceCalibrationManifestSha256: string;
}>;

export type LongCallOutputVoiceRoute = Readonly<{
  provider: LiveStsProvider;
  model: string;
  voice: string;
}>;

export const LONG_CALL_ASR_OUTPUT_VOICE_ROUTES: readonly LongCallOutputVoiceRoute[] = Object.freeze(
  (["openai", "gemini", "xai"] as const).map((provider) => Object.freeze({
    provider,
    model: LIVE_STS_PROVIDER_SPECS[provider].model,
    voice: LIVE_STS_PROVIDER_SPECS[provider].voice,
  }))
);

export type OutputVoiceCalibrationCaptureReceipt = Readonly<{
  schemaVersion: 1;
  receiptType: "hacc_output_voice_calibration_capture";
  captureId: string;
  provider: LiveStsProvider;
  model: string;
  voice: string;
  referenceTextSha256: string;
  pcmSha256: string;
  sampleRateHz: 24_000;
  channels: 1;
  encoding: "pcm16";
  request: Readonly<{
    sessionConfigurationSha256: string;
    requestBodySha256: string;
  }>;
  providerReceipt: Readonly<{
    receiptClass: "credential_neutral_provider_wire_receipt";
    sessionIdSha256: string;
    requestIdSha256: string | null;
    acknowledgementKind: "exact_configuration_echo" | "request_bound_setup_complete" | "request_bound_partial_echo";
    acknowledgementEventSha256: string;
    acknowledgedModel: string | null;
    acknowledgedVoice: string | null;
    terminalEventSha256: string;
    credentialFieldsRetained: readonly [];
  }>;
  wireCapture: Readonly<{
    sanitizedEventLogSha256: string;
    outputChunks: readonly Readonly<{
      ordinal: number;
      byteOffset: number;
      byteLength: number;
      sha256: string;
    }>[];
    outputChunkSequenceSha256: string;
  }>;
  captureToolchain: Readonly<{
    implementationSha256: string;
    sourceCommitSha256: string;
  }>;
  signature: Readonly<{
    algorithm: "ed25519";
    keyId: string;
    publicKeyPem: string;
    publicKeySha256: string;
    signatureBase64: string;
  }>;
  receiptSha256: string;
}>;

export type OutputVoiceCaptureAuthority = Readonly<{
  keyId: string;
  publicKeyPem: string;
  publicKeySha256: string;
}>;

export type FrozenOutputVoiceCalibrationFixture = Readonly<{
  calibrationUnitId: string;
  provider: LiveStsProvider;
  model: string;
  voice: string;
  family: LongCallFamily;
  slotId: string;
  referenceText: string;
  referenceTextSha256: string;
  sampleRateHz: 24_000;
  path: string;
  sha256: string;
  byteLength: number;
  captureReceipt: OutputVoiceCalibrationCaptureReceipt;
}>;

export type OutputVoiceCalibrationManifest = Readonly<{
  schemaVersion: 1;
  calibrationId: typeof LONG_CALL_ASR_CALIBRATION_ID;
  requiredOutputVoiceRoutes: readonly LongCallOutputVoiceRoute[];
  captureAuthority: OutputVoiceCaptureAuthority;
  fixtures: readonly FrozenOutputVoiceCalibrationFixture[];
  manifestSha256: string;
}>;

export type OutputVoiceCaptureVerificationReceipt = Readonly<{
  schemaVersion: 1;
  verificationType: "hacc_output_voice_capture_verification";
  manifestSha256: string;
  captureAuthoritySha256: string;
  verificationImplementationSha256: string;
  credentialMaterialRetained: false;
  providerReceiptClass: "credential_neutral_provider_wire_receipt";
  verifiedFixtures: readonly Readonly<{
    calibrationUnitId: string;
    provider: LiveStsProvider;
    model: string;
    voice: string;
    pcmSha256: string;
    captureReceiptSha256: string;
    outputChunkSequenceSha256: string;
  }>[];
  verificationSha256: string;
}>;

export type LongCallAsrCalibrationFixture = FrozenLongCallFixture & Readonly<{
  ordinal: number;
  turnOrdinal: number;
  sourceText: string;
  calibrationUnitId: string;
}>;

export type LongCallAsrCalibrationPlan = Readonly<{
  schemaVersion: 2;
  calibrationId: typeof LONG_CALL_ASR_CALIBRATION_ID;
  experimentId: string;
  experimentPlanSha256: string;
  fixtureManifestSha256: string;
  sampleRateHz: 24_000;
  selectionRule: "turn-ordinals-1-4-9-14-17-20-in-every-family-voice-stratum";
  selectedTurnOrdinals: typeof LONG_CALL_ASR_CALIBRATION_TURN_ORDINALS;
  fixtures: readonly LongCallAsrCalibrationFixture[];
  outputVoiceFixtures: readonly FrozenOutputVoiceCalibrationFixture[];
  outputVoiceCalibrationManifestSha256: string;
  requiredOutputVoiceRoutes: readonly LongCallOutputVoiceRoute[];
  callerFixtureCount: number;
  outputVoiceFixtureCount: number;
  plannedFixtureCount: number;
  calibrationPlanSha256: string;
}>;

export type LongCallAsrCalibrationTranscript = Readonly<{
  calibrationUnitId: string;
  transcript: string;
  receiptSha256: string;
  playedAudioSha256: string;
}>;

export type OutputVoiceAsrCalibrationArtifact = ScoredOutputVoiceAsrCalibration & Readonly<{
  captureVerificationSha256: string;
  captureAuthoritySha256: string;
  asrConfigSha256: string;
  asrBatchFinalizationSha256: string;
  receiptsManifestSha256: string;
  artifactSha256: string;
}>;

type SemanticSlot = Readonly<{
  id: string;
  family: LongCallFamily;
  kind: "corrected_identifier" | "numeric_limit";
  canonicalText: string;
  aliases?: readonly string[];
}>;

export const LONG_CALL_ASR_SEMANTIC_SLOTS: readonly SemanticSlot[] = Object.freeze([
  Object.freeze({ id: "museum.corrected_crate", family: "museum", kind: "corrected_identifier", canonicalText: "A 71" }),
  Object.freeze({ id: "museum.humidity_limit", family: "museum", kind: "numeric_limit", canonicalText: "52 percent", aliases: Object.freeze(["52%"])}),
  Object.freeze({ id: "campus.corrected_assessment", family: "campus", kind: "corrected_identifier", canonicalText: "CHEM 318 practical" }),
  Object.freeze({ id: "campus.duration_limit", family: "campus", kind: "numeric_limit", canonicalText: "150 minutes" }),
  Object.freeze({ id: "water.corrected_site", family: "water", kind: "corrected_identifier", canonicalText: "HYD 14 daycare" }),
  Object.freeze({ id: "water.threshold_limit", family: "water", kind: "numeric_limit", canonicalText: "10 parts per billion", aliases: Object.freeze(["10 ppb"]) }),
]);

const ONES: Readonly<Record<string, number>> = Object.freeze({
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9,
});
const TEENS: Readonly<Record<string, number>> = Object.freeze({
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
});
const TENS: Readonly<Record<string, number>> = Object.freeze({
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
});
const NUMBER_WORDS = new Set([...Object.keys(ONES), ...Object.keys(TEENS), ...Object.keys(TENS), "hundred", "thousand", "and"]);

function parseCardinal(words: readonly string[]): string {
  const meaningful = words.filter((word) => word !== "and");
  if (meaningful.length === 0) return "";
  if (meaningful.every((word) => word in ONES)) {
    return meaningful.map((word) => String(ONES[word])).join("");
  }
  let total = 0;
  let current = 0;
  for (let index = 0; index < meaningful.length; index += 1) {
    const word = meaningful[index];
    if (word in ONES) {
      const following = meaningful[index + 1];
      // Spoken identifiers such as "two forty one" mean 241, not 43.
      if (following && (following in TENS || following in TEENS) && index === 0) {
        const tail = parseCardinal(meaningful.slice(index + 1));
        return `${ONES[word]}${tail}`;
      }
      current += ONES[word];
    } else if (word in TEENS) {
      current += TEENS[word];
    } else if (word in TENS) {
      current += TENS[word];
    } else if (word === "hundred") {
      current = Math.max(1, current) * 100;
    } else if (word === "thousand") {
      total += Math.max(1, current) * 1_000;
      current = 0;
    }
  }
  return String(total + current);
}

function digitTokens(value: string): string[] {
  const canonical = value.replace(/^0+(?=\d)/u, "");
  return [...canonical];
}

/**
 * Frozen English normalization used for calibration WER and semantic matching:
 * Unicode NFKD, lowercase, diacritic removal, ampersand-to-"and", apostrophe
 * deletion, other punctuation-to-space, spoken-cardinal conversion, decimal
 * digit splitting, and joining consecutive spelled letters ("C H E M" ->
 * "chem"). Splitting all numeric forms into digits makes "seventy one" and
 * "71" equivalent without a provider-specific text normalizer.
 */
export function normalizeLongCallAsrText(input: string): readonly string[] {
  const raw = input
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(/%/gu, " percent ")
    .replace(/[’']/gu, "")
    .replace(/[-‐‑‒–—]/gu, " ")
    .replace(/([a-z])([0-9])/giu, "$1 $2")
    .replace(/([0-9])([a-z])/giu, "$1 $2")
    .replace(/[^a-z0-9\s]/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const numeric: string[] = [];
  for (let index = 0; index < raw.length;) {
    const token = raw[index];
    if (/^\d+$/u.test(token)) {
      numeric.push(...digitTokens(token));
      index += 1;
      continue;
    }
    if (NUMBER_WORDS.has(token) && token !== "and") {
      const words: string[] = [];
      while (index < raw.length && NUMBER_WORDS.has(raw[index])) {
        words.push(raw[index]);
        index += 1;
      }
      numeric.push(...digitTokens(parseCardinal(words)));
      continue;
    }
    numeric.push(token);
    index += 1;
  }
  const normalized: string[] = [];
  for (let index = 0; index < numeric.length;) {
    if (/^[a-z]$/u.test(numeric[index])) {
      let end = index + 1;
      while (end < numeric.length && /^[a-z]$/u.test(numeric[end])) end += 1;
      if (end - index >= 2) {
        normalized.push(numeric.slice(index, end).join(""));
        index = end;
        continue;
      }
    }
    normalized.push(numeric[index]);
    index += 1;
  }
  return Object.freeze(normalized);
}

export function wordErrorCounts(reference: readonly string[], hypothesis: readonly string[]) {
  const previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let row = 1; row <= reference.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= hypothesis.length; column += 1) {
      current[column] = reference[row - 1] === hypothesis[column - 1]
        ? previous[column - 1]
        : 1 + Math.min(previous[column - 1], previous[column], current[column - 1]);
    }
    previous.splice(0, previous.length, ...current);
  }
  return Object.freeze({ errors: previous[hypothesis.length], referenceWords: reference.length });
}

function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  return haystack.some((_, start) => needle.every((token, offset) => haystack[start + offset] === token));
}

export function longCallOutputVoiceRouteId(route: LongCallOutputVoiceRoute): string {
  return `${route.provider}/${route.model}/${route.voice}`;
}

export function outputVoiceCaptureReceiptSha256(
  receipt: Omit<OutputVoiceCalibrationCaptureReceipt, "receiptSha256">
): string {
  return sha256Hex(`${OUTPUT_CAPTURE_RECEIPT_DOMAIN}${canonicalJson(receipt)}`);
}

type UnsignedOutputVoiceCaptureReceipt = Omit<OutputVoiceCalibrationCaptureReceipt, "signature" | "receiptSha256">;

export function outputVoiceCaptureEvidenceSha256(receipt: UnsignedOutputVoiceCaptureReceipt): string {
  return sha256Hex(`${OUTPUT_CAPTURE_RECEIPT_DOMAIN}${canonicalJson(receipt)}`);
}

export function outputVoiceCaptureSigningBytes(receipt: UnsignedOutputVoiceCaptureReceipt): Uint8Array {
  return Buffer.from(`${OUTPUT_CAPTURE_SIGNATURE_DOMAIN}${outputVoiceCaptureEvidenceSha256(receipt)}`, "utf8");
}

function capturePublicKeyFingerprint(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("output-voice capture authority must use Ed25519");
  return sha256Hex(key.export({ format: "der", type: "spki" }));
}

function captureAuthorityFromFixtures(fixtures: readonly FrozenOutputVoiceCalibrationFixture[]): OutputVoiceCaptureAuthority {
  const signature = fixtures[0]?.captureReceipt.signature;
  if (!signature) throw new Error("output-voice calibration capture authority is missing");
  const authority = Object.freeze({
    keyId: signature.keyId,
    publicKeyPem: signature.publicKeyPem,
    publicKeySha256: signature.publicKeySha256,
  });
  if (capturePublicKeyFingerprint(authority.publicKeyPem) !== authority.publicKeySha256) {
    throw new Error("output-voice capture authority fingerprint mismatch");
  }
  return authority;
}

export function outputVoiceChunkSequenceSha256(
  chunks: OutputVoiceCalibrationCaptureReceipt["wireCapture"]["outputChunks"]
): string {
  return sha256Hex(`${OUTPUT_CHUNK_SEQUENCE_DOMAIN}${canonicalJson(chunks)}`);
}

function validateCaptureReceipt(
  fixture: FrozenOutputVoiceCalibrationFixture,
  authority: OutputVoiceCaptureAuthority,
  pcm?: Uint8Array,
): void {
  const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  const receipt = fixture.captureReceipt;
  const { receiptSha256, signature, ...unsigned } = receipt;
  if (receiptSha256 !== outputVoiceCaptureReceiptSha256({ ...unsigned, signature })) {
    throw new Error(`output fixture capture receipt hash is invalid: ${fixture.calibrationUnitId}`);
  }
  if (signature.algorithm !== "ed25519"
    || signature.keyId !== authority.keyId
    || signature.publicKeyPem !== authority.publicKeyPem
    || signature.publicKeySha256 !== authority.publicKeySha256
    || !/^[A-Za-z0-9+/]{86}==$/u.test(signature.signatureBase64)
    || !verify(
      null,
      outputVoiceCaptureSigningBytes(unsigned),
      createPublicKey(authority.publicKeyPem),
      Buffer.from(signature.signatureBase64, "base64"),
    )) {
    throw new Error(`output fixture capture signature is invalid: ${fixture.calibrationUnitId}`);
  }
  const providerReceipt = receipt.providerReceipt;
  const chunks = receipt.wireCapture.outputChunks;
  if (receipt.receiptType !== "hacc_output_voice_calibration_capture"
    || receipt.schemaVersion !== 1
    || receipt.captureId !== fixture.calibrationUnitId
    || receipt.provider !== fixture.provider
    || receipt.model !== fixture.model
    || receipt.voice !== fixture.voice
    || receipt.referenceTextSha256 !== fixture.referenceTextSha256
    || receipt.pcmSha256 !== fixture.sha256
    || receipt.sampleRateHz !== 24_000
    || receipt.channels !== 1
    || receipt.encoding !== "pcm16"
    || !sha(receipt.request.sessionConfigurationSha256)
    || !sha(receipt.request.requestBodySha256)
    || providerReceipt.receiptClass !== "credential_neutral_provider_wire_receipt"
    || !sha(providerReceipt.sessionIdSha256)
    || (providerReceipt.requestIdSha256 !== null && !sha(providerReceipt.requestIdSha256))
    || !sha(providerReceipt.acknowledgementEventSha256)
    || !sha(providerReceipt.terminalEventSha256)
    || providerReceipt.credentialFieldsRetained.length !== 0
    || !sha(receipt.wireCapture.sanitizedEventLogSha256)
    || !sha(receipt.captureToolchain.implementationSha256)
    || !sha(receipt.captureToolchain.sourceCommitSha256)
    || chunks.length === 0
    || receipt.wireCapture.outputChunkSequenceSha256 !== outputVoiceChunkSequenceSha256(chunks)) {
    throw new Error(`output fixture capture provenance is invalid: ${fixture.calibrationUnitId}`);
  }
  if (fixture.provider === "openai") {
    if (providerReceipt.acknowledgementKind !== "exact_configuration_echo"
      || providerReceipt.acknowledgedModel !== fixture.model
      || providerReceipt.acknowledgedVoice !== fixture.voice) {
      throw new Error(`OpenAI output fixture lacks exact model/voice acknowledgement: ${fixture.calibrationUnitId}`);
    }
  } else if (fixture.provider === "gemini") {
    if (providerReceipt.acknowledgementKind !== "request_bound_setup_complete"
      || providerReceipt.acknowledgedModel !== null
      || providerReceipt.acknowledgedVoice !== null) {
      throw new Error(`Gemini output fixture acknowledgement is invalid: ${fixture.calibrationUnitId}`);
    }
  } else if (providerReceipt.acknowledgementKind !== "request_bound_partial_echo"
    || (providerReceipt.acknowledgedModel !== null && providerReceipt.acknowledgedModel !== fixture.model)
    || (providerReceipt.acknowledgedVoice !== null && providerReceipt.acknowledgedVoice !== fixture.voice)) {
    throw new Error(`xAI output fixture acknowledgement is invalid: ${fixture.calibrationUnitId}`);
  }
  let byteOffset = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.ordinal !== index + 1
      || chunk.byteOffset !== byteOffset
      || !Number.isSafeInteger(chunk.byteLength)
      || chunk.byteLength < 2
      || chunk.byteLength % 2 !== 0
      || !sha(chunk.sha256)) {
      throw new Error(`output fixture chunk provenance is invalid: ${fixture.calibrationUnitId}`);
    }
    if (pcm && sha256Hex(pcm.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)) !== chunk.sha256) {
      throw new Error(`output fixture PCM does not match signed wire chunks: ${fixture.calibrationUnitId}`);
    }
    byteOffset += chunk.byteLength;
  }
  if (byteOffset !== fixture.byteLength || (pcm && (pcm.byteLength !== fixture.byteLength || sha256Hex(pcm) !== fixture.sha256))) {
    throw new Error(`output fixture PCM length/hash differs from signed capture: ${fixture.calibrationUnitId}`);
  }
}

export function verifyOutputVoiceCalibrationPcm(input: Readonly<{
  fixture: FrozenOutputVoiceCalibrationFixture;
  pcm: Uint8Array;
  expectedCaptureAuthoritySha256: string;
}>): void {
  const authority = captureAuthorityFromFixtures([input.fixture]);
  if (authority.publicKeySha256 !== input.expectedCaptureAuthoritySha256) {
    throw new Error("output-voice capture authority differs from the preregistered trust root");
  }
  validateCaptureReceipt(input.fixture, authority, input.pcm);
}

export function createOutputVoiceCaptureVerificationReceipt(input: Readonly<{
  manifest: OutputVoiceCalibrationManifest;
  expectedCaptureAuthoritySha256: string;
  verificationImplementationSha256: string;
}>): OutputVoiceCaptureVerificationReceipt {
  if (input.manifest.captureAuthority.publicKeySha256 !== input.expectedCaptureAuthoritySha256) {
    throw new Error("manifest capture authority differs from the preregistered trust root");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.verificationImplementationSha256)) {
    throw new Error("capture verification implementation hash is invalid");
  }
  const body = Object.freeze({
    schemaVersion: 1 as const,
    verificationType: "hacc_output_voice_capture_verification" as const,
    manifestSha256: input.manifest.manifestSha256,
    captureAuthoritySha256: input.expectedCaptureAuthoritySha256,
    verificationImplementationSha256: input.verificationImplementationSha256,
    credentialMaterialRetained: false as const,
    providerReceiptClass: "credential_neutral_provider_wire_receipt" as const,
    verifiedFixtures: Object.freeze(input.manifest.fixtures.map((fixture) => Object.freeze({
      calibrationUnitId: fixture.calibrationUnitId,
      provider: fixture.provider,
      model: fixture.model,
      voice: fixture.voice,
      pcmSha256: fixture.sha256,
      captureReceiptSha256: fixture.captureReceipt.receiptSha256,
      outputChunkSequenceSha256: fixture.captureReceipt.wireCapture.outputChunkSequenceSha256,
    }))),
  });
  return Object.freeze({
    ...body,
    verificationSha256: sha256Hex(`${OUTPUT_CAPTURE_VERIFICATION_DOMAIN}${canonicalJson(body)}`),
  });
}

export function verifyOutputVoiceCaptureVerificationReceipt(input: Readonly<{
  receipt: OutputVoiceCaptureVerificationReceipt;
  manifest: OutputVoiceCalibrationManifest;
  expectedCaptureAuthoritySha256: string;
}>): void {
  const expected = createOutputVoiceCaptureVerificationReceipt({
    manifest: input.manifest,
    expectedCaptureAuthoritySha256: input.expectedCaptureAuthoritySha256,
    verificationImplementationSha256: input.receipt.verificationImplementationSha256,
  });
  if (canonicalJson(expected) !== canonicalJson(input.receipt)) {
    throw new Error("output-voice capture verification receipt is invalid or incomplete");
  }
}

export function createOutputVoiceCalibrationManifest(
  fixtures: readonly FrozenOutputVoiceCalibrationFixture[]
): OutputVoiceCalibrationManifest {
  const captureAuthority = captureAuthorityFromFixtures(fixtures);
  const body = Object.freeze({
    schemaVersion: 1 as const,
    calibrationId: LONG_CALL_ASR_CALIBRATION_ID,
    requiredOutputVoiceRoutes: LONG_CALL_ASR_OUTPUT_VOICE_ROUTES,
    captureAuthority,
    fixtures: Object.freeze([...fixtures]),
  });
  return Object.freeze({
    ...body,
    manifestSha256: sha256Hex(`${OUTPUT_FIXTURE_MANIFEST_DOMAIN}${canonicalJson(body)}`),
  });
}

export function validateOutputVoiceCalibrationFixtures(input: Readonly<{
  fixtures: readonly FrozenOutputVoiceCalibrationFixture[];
  manifestSha256: string;
}>): readonly FrozenOutputVoiceCalibrationFixture[] {
  const fixtures = input.fixtures;
  if (!Array.isArray(fixtures)) throw new Error("frozen output-voice calibration fixtures are missing");
  if (createOutputVoiceCalibrationManifest(fixtures).manifestSha256 !== input.manifestSha256) {
    throw new Error("frozen output-voice calibration manifest hash mismatch");
  }
  const captureAuthority = captureAuthorityFromFixtures(fixtures);
  const expectedSlotIds = new Set(LONG_CALL_ASR_SEMANTIC_SLOTS.map((slot) => slot.id));
  for (const route of LONG_CALL_ASR_OUTPUT_VOICE_ROUTES) {
    const routeFixtures = fixtures.filter((fixture) => fixture.provider === route.provider
      && fixture.model === route.model
      && fixture.voice === route.voice);
    if (routeFixtures.length !== LONG_CALL_ASR_OUTPUT_FIXTURES_PER_VOICE) {
      throw new Error(`output-voice calibration requires six fixtures for ${longCallOutputVoiceRouteId(route)}`);
    }
    if (new Set(routeFixtures.map((fixture) => fixture.slotId)).size !== expectedSlotIds.size
      || routeFixtures.some((fixture) => !expectedSlotIds.has(fixture.slotId))) {
      throw new Error(`output-voice calibration slot coverage mismatch for ${longCallOutputVoiceRouteId(route)}`);
    }
  }
  if (fixtures.length !== LONG_CALL_ASR_OUTPUT_VOICE_ROUTES.length * LONG_CALL_ASR_OUTPUT_FIXTURES_PER_VOICE) {
    throw new Error("output-voice calibration contains unexpected provider/model/voice routes");
  }
  if (new Set(fixtures.map((fixture) => fixture.calibrationUnitId)).size !== fixtures.length
    || new Set(fixtures.map((fixture) => fixture.path)).size !== fixtures.length) {
    throw new Error("output-voice calibration unit IDs and paths must be unique");
  }
  for (const fixture of fixtures) {
    if (!SAFE_CALIBRATION_UNIT_ID.test(fixture.calibrationUnitId)) {
      throw new Error(`output fixture calibration unit ID is unsafe: ${fixture.calibrationUnitId}`);
    }
    const slot = LONG_CALL_ASR_SEMANTIC_SLOTS.find((candidate) => candidate.id === fixture.slotId);
    if (!slot || slot.family !== fixture.family) throw new Error(`output fixture slot mismatch: ${fixture.calibrationUnitId}`);
    const route = LONG_CALL_ASR_OUTPUT_VOICE_ROUTES.find((candidate) => candidate.provider === fixture.provider);
    if (!route || route.model !== fixture.model || route.voice !== fixture.voice) {
      throw new Error(`output fixture provider voice is not pinned: ${fixture.calibrationUnitId}`);
    }
    const representations = [slot.canonicalText, ...(slot.aliases ?? [])].map(normalizeLongCallAsrText);
    const referenceTokens = normalizeLongCallAsrText(fixture.referenceText);
    if (!representations.some((tokens) => containsSequence(referenceTokens, tokens))) {
      throw new Error(`output fixture reference omits its critical slot: ${fixture.calibrationUnitId}`);
    }
    if (fixture.referenceTextSha256 !== sha256Hex(fixture.referenceText)
      || fixture.sampleRateHz !== 24_000
      || fixture.byteLength < 2
      || fixture.byteLength % 2 !== 0
      || !/^[a-f0-9]{64}$/u.test(fixture.sha256)) {
      throw new Error(`output fixture content binding is invalid: ${fixture.calibrationUnitId}`);
    }
    validateCaptureReceipt(fixture, captureAuthority);
  }
  return Object.freeze([...fixtures]);
}

/**
 * Score a completed provider-output capture root without requiring the larger
 * long-call experiment plan. The manifest itself is the frozen test plan: six
 * critical-slot fixtures for each exact provider/model/voice route.
 */
export function scoreOutputVoiceAsrCalibration(input: Readonly<{
  manifest: OutputVoiceCalibrationManifest;
  transcripts: readonly LongCallAsrCalibrationTranscript[];
}>) {
  const canonicalManifest = createOutputVoiceCalibrationManifest(input.manifest.fixtures);
  if (canonicalJson(canonicalManifest) !== canonicalJson(input.manifest)) {
    throw new Error("output-voice calibration manifest is noncanonical or has a version/hash mismatch");
  }
  const fixtures = validateOutputVoiceCalibrationFixtures({
    fixtures: input.manifest.fixtures,
    manifestSha256: input.manifest.manifestSha256,
  });
  const byUnit = new Map<string, LongCallAsrCalibrationTranscript>();
  for (const transcript of input.transcripts) {
    if (byUnit.has(transcript.calibrationUnitId)) {
      throw new Error(`duplicate ASR transcript ${transcript.calibrationUnitId}`);
    }
    byUnit.set(transcript.calibrationUnitId, transcript);
  }
  const plannedUnits = new Set(fixtures.map((fixture) => fixture.calibrationUnitId));
  const unexpectedUnits = [...byUnit.keys()].filter((unitId) => !plannedUnits.has(unitId));
  if (unexpectedUnits.length > 0) {
    throw new Error(`unexpected ASR calibration transcript ${unexpectedUnits.sort()[0]}`);
  }
  const fixtureResults = Object.freeze(fixtures.map((fixture) => {
    const transcript = byUnit.get(fixture.calibrationUnitId);
    const referenceTokens = normalizeLongCallAsrText(fixture.referenceText);
    const hypothesisTokens = normalizeLongCallAsrText(transcript?.transcript ?? "");
    const wordErrors = wordErrorCounts(referenceTokens, hypothesisTokens);
    const semanticSlots = Object.freeze(LONG_CALL_ASR_SEMANTIC_SLOTS
      .filter((slot) => slot.family === fixture.family)
      .map((slot) => {
        const representations = [slot.canonicalText, ...(slot.aliases ?? [])].map(normalizeLongCallAsrText);
        return Object.freeze({
          slotId: slot.id,
          kind: slot.kind,
          expected: representations.some((tokens) => containsSequence(referenceTokens, tokens)),
          detected: representations.some((tokens) => containsSequence(hypothesisTokens, tokens)),
        });
      }));
    return Object.freeze({
      calibrationKind: "provider_output" as const,
      calibrationUnitId: fixture.calibrationUnitId,
      provider: fixture.provider,
      model: fixture.model,
      voice: fixture.voice,
      family: fixture.family,
      slotId: fixture.slotId,
      sourceTextSha256: fixture.referenceTextSha256,
      fixtureSha256: fixture.sha256,
      captureReceiptSha256: fixture.captureReceipt.receiptSha256,
      receiptSha256: transcript?.receiptSha256 ?? null,
      playedAudioSha256: transcript?.playedAudioSha256 ?? null,
      evidenceComplete: transcript?.playedAudioSha256 === fixture.sha256
        && /^[a-f0-9]{64}$/u.test(transcript.receiptSha256),
      referenceNormalized: referenceTokens.join(" "),
      hypothesisNormalized: hypothesisTokens.join(" "),
      wordErrors: wordErrors.errors,
      referenceWords: wordErrors.referenceWords,
      semanticSlots,
    });
  }));
  type FixtureResult = (typeof fixtureResults)[number];
  const metricSummary = (results: readonly FixtureResult[]) => {
    const totalReferenceWords = results.reduce((sum, result) => sum + result.referenceWords, 0);
    const totalWordErrors = results.reduce((sum, result) => sum + result.wordErrors, 0);
    const expectedSlots = results.flatMap((result) => result.semanticSlots.filter((slot) => slot.expected));
    const criticalSlotFalseNegatives = expectedSlots.filter((slot) => !slot.detected).length;
    const semanticSlotFalsePositives = results.flatMap((result) => result.semanticSlots)
      .filter((slot) => !slot.expected && slot.detected).length;
    const completedFixtures = results.filter((result) => result.evidenceComplete).length;
    return Object.freeze({
      plannedFixtures: results.length,
      completedFixtures,
      fixtureCoverage: results.length === 0 ? 0 : completedFixtures / results.length,
      totalReferenceWords,
      totalWordErrors,
      wordErrorRate: totalReferenceWords === 0 ? 1 : totalWordErrors / totalReferenceWords,
      expectedCriticalSlots: expectedSlots.length,
      detectedCriticalSlots: expectedSlots.length - criticalSlotFalseNegatives,
      criticalSlotRecall: expectedSlots.length === 0
        ? 0
        : (expectedSlots.length - criticalSlotFalseNegatives) / expectedSlots.length,
      criticalSlotFalseNegatives,
      semanticSlotFalsePositives,
    });
  };
  const metrics = metricSummary(fixtureResults);
  const outputVoiceMetrics = Object.freeze(input.manifest.requiredOutputVoiceRoutes.map((route) => {
    const routeResults = fixtureResults.filter((result) => result.provider === route.provider
      && result.model === route.model
      && result.voice === route.voice);
    return Object.freeze({
      routeId: longCallOutputVoiceRouteId(route),
      ...route,
      ...metricSummary(routeResults),
    });
  }));
  const thresholds = Object.freeze({
    maximumWordErrorRate: LONG_CALL_ASR_MAX_WER,
    requiredFixtureCoverage: 1,
    maximumCriticalSlotFalseNegatives: 0,
    maximumSemanticSlotFalsePositives: 0,
  });
  const passesThresholds = (summary: typeof metrics): boolean =>
    summary.fixtureCoverage === thresholds.requiredFixtureCoverage
    && summary.wordErrorRate <= thresholds.maximumWordErrorRate
    && summary.criticalSlotFalseNegatives <= thresholds.maximumCriticalSlotFalseNegatives
    && summary.semanticSlotFalsePositives <= thresholds.maximumSemanticSlotFalsePositives;
  const gatePass = fixtures.length === LONG_CALL_ASR_OUTPUT_VOICE_ROUTES.length * LONG_CALL_ASR_OUTPUT_FIXTURES_PER_VOICE
    && passesThresholds(metrics)
    && outputVoiceMetrics.length === LONG_CALL_ASR_OUTPUT_VOICE_ROUTES.length
    && outputVoiceMetrics.every((summary) => summary.plannedFixtures === LONG_CALL_ASR_OUTPUT_FIXTURES_PER_VOICE
      && summary.completedFixtures === LONG_CALL_ASR_OUTPUT_FIXTURES_PER_VOICE
      && passesThresholds(summary));
  const body = Object.freeze({
    schemaVersion: 1 as const,
    calibrationType: "hacc_output_voice_asr_calibration" as const,
    calibrationId: LONG_CALL_ASR_CALIBRATION_ID,
    outputVoiceCalibrationManifestSha256: input.manifest.manifestSha256,
    requiredOutputVoiceRoutes: input.manifest.requiredOutputVoiceRoutes,
    normalization: "nfkd-lower-diacritic-strip-ampersand-apostrophe-punctuation-cardinal-digit-letter-v1" as const,
    metrics,
    outputVoiceMetrics,
    thresholds,
    gatePass,
    fixtureResults,
  });
  return Object.freeze({
    ...body,
    calibrationSha256: sha256Hex(`${OUTPUT_ASR_RESULT_DOMAIN}${canonicalJson(body)}`),
  });
}

export type ScoredOutputVoiceAsrCalibration = ReturnType<typeof scoreOutputVoiceAsrCalibration>;

export function createOutputVoiceAsrCalibrationArtifact(input: Readonly<{
  scored: ScoredOutputVoiceAsrCalibration;
  captureVerificationSha256: string;
  captureAuthoritySha256: string;
  asrConfigSha256: string;
  asrBatchFinalizationSha256: string;
  receiptsManifestSha256: string;
}>): OutputVoiceAsrCalibrationArtifact {
  const hashes = [
    input.captureVerificationSha256,
    input.captureAuthoritySha256,
    input.asrConfigSha256,
    input.asrBatchFinalizationSha256,
    input.receiptsManifestSha256,
  ];
  if (hashes.some((value) => !/^[a-f0-9]{64}$/u.test(value))) {
    throw new Error("output-voice ASR artifact requires complete SHA-256 evidence bindings");
  }
  const body = Object.freeze({
    ...input.scored,
    captureVerificationSha256: input.captureVerificationSha256,
    captureAuthoritySha256: input.captureAuthoritySha256,
    asrConfigSha256: input.asrConfigSha256,
    asrBatchFinalizationSha256: input.asrBatchFinalizationSha256,
    receiptsManifestSha256: input.receiptsManifestSha256,
  });
  return Object.freeze({
    ...body,
    artifactSha256: sha256Hex(`${OUTPUT_ASR_ARTIFACT_DOMAIN}${canonicalJson(body)}`),
  });
}

export function createLongCallAsrCalibrationPlan(plan: FrozenLongCallExperimentPlan): LongCallAsrCalibrationPlan {
  if (plan.protocolId !== LONG_CALL_PROTOCOL_ID) {
    throw new Error(`ASR calibration requires a ${LONG_CALL_PROTOCOL_ID} experiment plan`);
  }
  if (sha256Hex(canonicalJson(plan.fixtures)) !== plan.fixtureManifestSha256) {
    throw new Error("frozen fixture manifest hash mismatch");
  }
  const outputVoiceFixtures = validateOutputVoiceCalibrationFixtures({
    fixtures: plan.outputVoiceCalibrationFixtures,
    manifestSha256: plan.outputVoiceCalibrationManifestSha256,
  });
  const selected: LongCallAsrCalibrationFixture[] = [];
  for (const family of LONG_CALL_FAMILIES) {
    const task = longUsefulnessTask(family);
    for (const ttsVoice of LONG_CALL_TTS_VOICES) {
      for (const turnOrdinal of LONG_CALL_ASR_CALIBRATION_TURN_ORDINALS) {
        const turn = task.scenario.caller.turns[turnOrdinal - 1];
        if (!turn) throw new Error(`missing caller turn ${family}/${turnOrdinal}`);
        const candidates = plan.fixtures.filter((fixture) => fixture.family === family
          && fixture.ttsVoice === ttsVoice
          && fixture.sampleRateHz === 24_000
          && fixture.turnId === turn.id);
        if (candidates.length !== 1) throw new Error(`expected one 24 kHz fixture for ${family}/${ttsVoice}/${turn.id}`);
        const fixture = candidates[0];
        if (fixture.taskSha256 !== task.suite_sha256 || fixture.sourceTextSha256 !== sha256Hex(turn.utterance)) {
          throw new Error(`fixture source binding mismatch for ${family}/${ttsVoice}/${turn.id}`);
        }
        selected.push(Object.freeze({
          ...fixture,
          ordinal: selected.length + 1,
          turnOrdinal,
          sourceText: turn.utterance,
          calibrationUnitId: `cal-${family}-${ttsVoice.toLowerCase()}-${turn.id.replace(/[^A-Za-z0-9._:-]/gu, "-")}`,
        }));
      }
    }
  }
  if (selected.length !== LONG_CALL_ASR_CALIBRATION_FIXTURES) {
    throw new Error(`calibration selection must contain exactly ${LONG_CALL_ASR_CALIBRATION_FIXTURES} fixtures`);
  }
  if (new Set(selected.map((fixture) => fixture.path)).size !== selected.length) throw new Error("calibration fixture paths must be unique");
  const body = Object.freeze({
    schemaVersion: 2 as const,
    calibrationId: LONG_CALL_ASR_CALIBRATION_ID,
    experimentId: plan.experimentId,
    experimentPlanSha256: plan.planSha256,
    fixtureManifestSha256: plan.fixtureManifestSha256,
    sampleRateHz: 24_000 as const,
    selectionRule: "turn-ordinals-1-4-9-14-17-20-in-every-family-voice-stratum" as const,
    selectedTurnOrdinals: LONG_CALL_ASR_CALIBRATION_TURN_ORDINALS,
    fixtures: Object.freeze(selected),
    outputVoiceFixtures,
    outputVoiceCalibrationManifestSha256: plan.outputVoiceCalibrationManifestSha256,
    requiredOutputVoiceRoutes: LONG_CALL_ASR_OUTPUT_VOICE_ROUTES,
    callerFixtureCount: selected.length,
    outputVoiceFixtureCount: outputVoiceFixtures.length,
    plannedFixtureCount: selected.length + outputVoiceFixtures.length,
  });
  return Object.freeze({
    ...body,
    calibrationPlanSha256: sha256Hex(`${CALIBRATION_PLAN_DOMAIN}${canonicalJson(body)}`),
  });
}

export function scoreLongCallAsrCalibration(input: Readonly<{
  plan: LongCallAsrCalibrationPlan;
  transcripts: readonly LongCallAsrCalibrationTranscript[];
}>) {
  const byUnit = new Map<string, LongCallAsrCalibrationTranscript>();
  for (const transcript of input.transcripts) {
    if (byUnit.has(transcript.calibrationUnitId)) throw new Error(`duplicate ASR transcript ${transcript.calibrationUnitId}`);
    byUnit.set(transcript.calibrationUnitId, transcript);
  }
  const plannedUnits = new Set([
    ...input.plan.fixtures.map((fixture) => fixture.calibrationUnitId),
    ...input.plan.outputVoiceFixtures.map((fixture) => fixture.calibrationUnitId),
  ]);
  const unexpectedUnits = [...byUnit.keys()].filter((unitId) => !plannedUnits.has(unitId));
  if (unexpectedUnits.length > 0) throw new Error(`unexpected ASR calibration transcript ${unexpectedUnits.sort()[0]}`);
  const fixtureResults = input.plan.fixtures.map((fixture) => {
    const transcript = byUnit.get(fixture.calibrationUnitId);
    const referenceTokens = normalizeLongCallAsrText(fixture.sourceText);
    const hypothesisTokens = normalizeLongCallAsrText(transcript?.transcript ?? "");
    const wordErrors = wordErrorCounts(referenceTokens, hypothesisTokens);
    const slots = LONG_CALL_ASR_SEMANTIC_SLOTS.filter((slot) => slot.family === fixture.family).map((slot) => {
      const representations = [slot.canonicalText, ...(slot.aliases ?? [])].map(normalizeLongCallAsrText);
      const expected = representations.some((tokens) => containsSequence(referenceTokens, tokens));
      const detected = representations.some((tokens) => containsSequence(hypothesisTokens, tokens));
      return Object.freeze({ slotId: slot.id, kind: slot.kind, expected, detected });
    });
    return Object.freeze({
      calibrationKind: "caller" as const,
      calibrationUnitId: fixture.calibrationUnitId,
      family: fixture.family,
      ttsVoice: fixture.ttsVoice,
      turnId: fixture.turnId,
      sourceTextSha256: fixture.sourceTextSha256,
      fixtureSha256: fixture.sha256,
      receiptSha256: transcript?.receiptSha256 ?? null,
      playedAudioSha256: transcript?.playedAudioSha256 ?? null,
      evidenceComplete: transcript?.playedAudioSha256 === fixture.sha256
        && /^[a-f0-9]{64}$/u.test(transcript.receiptSha256),
      referenceNormalized: referenceTokens.join(" "),
      hypothesisNormalized: hypothesisTokens.join(" "),
      wordErrors: wordErrors.errors,
      referenceWords: wordErrors.referenceWords,
      semanticSlots: Object.freeze(slots),
    });
  });
  const outputVoiceFixtureResults = input.plan.outputVoiceFixtures.map((fixture) => {
    const transcript = byUnit.get(fixture.calibrationUnitId);
    const referenceTokens = normalizeLongCallAsrText(fixture.referenceText);
    const hypothesisTokens = normalizeLongCallAsrText(transcript?.transcript ?? "");
    const wordErrors = wordErrorCounts(referenceTokens, hypothesisTokens);
    const slots = LONG_CALL_ASR_SEMANTIC_SLOTS.filter((slot) => slot.family === fixture.family).map((slot) => {
      const representations = [slot.canonicalText, ...(slot.aliases ?? [])].map(normalizeLongCallAsrText);
      const expected = representations.some((tokens) => containsSequence(referenceTokens, tokens));
      const detected = representations.some((tokens) => containsSequence(hypothesisTokens, tokens));
      return Object.freeze({ slotId: slot.id, kind: slot.kind, expected, detected });
    });
    return Object.freeze({
      calibrationKind: "provider_output" as const,
      calibrationUnitId: fixture.calibrationUnitId,
      provider: fixture.provider,
      model: fixture.model,
      voice: fixture.voice,
      family: fixture.family,
      slotId: fixture.slotId,
      sourceTextSha256: fixture.referenceTextSha256,
      fixtureSha256: fixture.sha256,
      captureReceiptSha256: fixture.captureReceipt.receiptSha256,
      receiptSha256: transcript?.receiptSha256 ?? null,
      playedAudioSha256: transcript?.playedAudioSha256 ?? null,
      evidenceComplete: transcript?.playedAudioSha256 === fixture.sha256
        && /^[a-f0-9]{64}$/u.test(transcript.receiptSha256),
      referenceNormalized: referenceTokens.join(" "),
      hypothesisNormalized: hypothesisTokens.join(" "),
      wordErrors: wordErrors.errors,
      referenceWords: wordErrors.referenceWords,
      semanticSlots: Object.freeze(slots),
    });
  });
  type ScorableResult = (typeof fixtureResults)[number] | (typeof outputVoiceFixtureResults)[number];
  const metricSummary = (results: readonly ScorableResult[]) => {
    const totalReferenceWords = results.reduce((sum, result) => sum + result.referenceWords, 0);
    const totalWordErrors = results.reduce((sum, result) => sum + result.wordErrors, 0);
    const expectedSlots = results.flatMap((result) => result.semanticSlots.filter((slot) => slot.expected));
    const slotFalseNegatives = expectedSlots.filter((slot) => !slot.detected).length;
    const slotFalsePositives = results
    .flatMap((result) => result.semanticSlots)
    .filter((slot) => !slot.expected && slot.detected).length;
    const completedFixtures = results.filter((result) => result.evidenceComplete).length;
    return Object.freeze({
      plannedFixtures: results.length,
      completedFixtures,
      fixtureCoverage: results.length === 0 ? 0 : completedFixtures / results.length,
      totalReferenceWords,
      totalWordErrors,
      wordErrorRate: totalReferenceWords === 0 ? 1 : totalWordErrors / totalReferenceWords,
      expectedCriticalSlots: expectedSlots.length,
      detectedCriticalSlots: expectedSlots.length - slotFalseNegatives,
      criticalSlotRecall: expectedSlots.length === 0 ? 0 : (expectedSlots.length - slotFalseNegatives) / expectedSlots.length,
      criticalSlotFalseNegatives: slotFalseNegatives,
      semanticSlotFalsePositives: slotFalsePositives,
    });
  };
  const allFixtureResults = Object.freeze([...fixtureResults, ...outputVoiceFixtureResults]);
  const metrics = metricSummary(allFixtureResults);
  const callerMetrics = metricSummary(fixtureResults);
  const outputVoiceMetrics = Object.freeze(input.plan.requiredOutputVoiceRoutes.map((route) => {
    const routeId = longCallOutputVoiceRouteId(route);
    const routeResults = outputVoiceFixtureResults.filter((result) => result.provider === route.provider
      && result.model === route.model
      && result.voice === route.voice);
    return Object.freeze({ routeId, ...route, ...metricSummary(routeResults) });
  }));
  const thresholds = Object.freeze({
    maximumWordErrorRate: LONG_CALL_ASR_MAX_WER,
    requiredFixtureCoverage: 1,
    maximumCriticalSlotFalseNegatives: 0,
    maximumSemanticSlotFalsePositives: 0,
  });
  const passesThresholds = (summary: typeof metrics) => summary.fixtureCoverage === thresholds.requiredFixtureCoverage
    && summary.wordErrorRate <= thresholds.maximumWordErrorRate
    && summary.criticalSlotFalseNegatives <= thresholds.maximumCriticalSlotFalseNegatives
    && summary.semanticSlotFalsePositives <= thresholds.maximumSemanticSlotFalsePositives;
  const gatePass = passesThresholds(metrics)
    && passesThresholds(callerMetrics)
    && outputVoiceMetrics.length === LONG_CALL_ASR_OUTPUT_VOICE_ROUTES.length
    && outputVoiceMetrics.every(passesThresholds);
  const body = Object.freeze({
    schemaVersion: 2 as const,
    calibrationId: LONG_CALL_ASR_CALIBRATION_ID,
    experimentId: input.plan.experimentId,
    experimentPlanSha256: input.plan.experimentPlanSha256,
    calibrationPlanSha256: input.plan.calibrationPlanSha256,
    outputVoiceCalibrationManifestSha256: input.plan.outputVoiceCalibrationManifestSha256,
    requiredOutputVoiceRoutes: input.plan.requiredOutputVoiceRoutes,
    normalization: "nfkd-lower-diacritic-strip-ampersand-apostrophe-punctuation-cardinal-digit-letter-v1" as const,
    metrics,
    callerMetrics,
    outputVoiceMetrics,
    thresholds,
    gatePass,
    fixtureResults: allFixtureResults,
  });
  return Object.freeze({
    ...body,
    calibrationSha256: sha256Hex(`${CALIBRATION_RESULT_DOMAIN}${canonicalJson(body)}`),
  });
}

export type ScoredLongCallAsrCalibration = ReturnType<typeof scoreLongCallAsrCalibration>;

export type LongCallAsrCalibrationArtifact = ScoredLongCallAsrCalibration & Readonly<{
  fixtureManifestSha256: string;
  asrConfigSha256: string;
  asrBatchFinalizationSha256: string;
  receiptsManifestSha256: string;
  artifactSha256: string;
}>;

export function createLongCallAsrCalibrationArtifact(input: Readonly<{
  scored: ScoredLongCallAsrCalibration;
  fixtureManifestSha256: string;
  asrConfigSha256: string;
  asrBatchFinalizationSha256: string;
  receiptsManifestSha256: string;
}>): LongCallAsrCalibrationArtifact {
  const body = Object.freeze({
    ...input.scored,
    fixtureManifestSha256: input.fixtureManifestSha256,
    asrConfigSha256: input.asrConfigSha256,
    asrBatchFinalizationSha256: input.asrBatchFinalizationSha256,
    receiptsManifestSha256: input.receiptsManifestSha256,
  });
  return Object.freeze({
    ...body,
    artifactSha256: sha256Hex(`${CALIBRATION_ARTIFACT_DOMAIN}${canonicalJson(body)}`),
  });
}

export function verifyLongCallAsrCalibrationArtifact(
  artifactInput: unknown,
  expected: Readonly<{
    experimentPlanSha256: string;
    fixtureManifestSha256: string;
    outputVoiceCalibrationManifestSha256: string;
    asrConfigSha256: string;
    requiredOutputVoiceRoutes: readonly LongCallOutputVoiceRoute[];
    requirePassingGate?: boolean;
  }>
): Readonly<{ valid: boolean; errors: readonly string[] }> {
  const errors: string[] = [];
  if (!artifactInput || typeof artifactInput !== "object" || Array.isArray(artifactInput)) {
    return Object.freeze({ valid: false, errors: Object.freeze(["calibration artifact must be an object"]) });
  }
  const artifact = artifactInput as Record<string, unknown>;
  const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  if (artifact.calibrationId !== LONG_CALL_ASR_CALIBRATION_ID) errors.push("calibration ID mismatch");
  if (artifact.schemaVersion !== 2) errors.push("calibration schema version mismatch");
  if (artifact.experimentPlanSha256 !== expected.experimentPlanSha256) errors.push("experiment plan hash mismatch");
  if (artifact.fixtureManifestSha256 !== expected.fixtureManifestSha256) errors.push("fixture manifest hash mismatch");
  if (artifact.outputVoiceCalibrationManifestSha256 !== expected.outputVoiceCalibrationManifestSha256) {
    errors.push("output-voice calibration manifest hash mismatch");
  }
  if (artifact.asrConfigSha256 !== expected.asrConfigSha256) errors.push("ASR config hash mismatch");
  if (!sha(artifact.asrBatchFinalizationSha256)) errors.push("ASR batch finalization hash is missing or invalid");
  if (!sha(artifact.receiptsManifestSha256)) errors.push("ASR receipt manifest hash is missing or invalid");
  if (canonicalJson(artifact.requiredOutputVoiceRoutes) !== canonicalJson(expected.requiredOutputVoiceRoutes)) {
    errors.push("required output-voice routes mismatch");
  }
  if (!sha(artifact.artifactSha256)) {
    errors.push("artifact hash is missing or invalid");
  } else {
    const { artifactSha256, ...body } = artifact;
    if (sha256Hex(`${CALIBRATION_ARTIFACT_DOMAIN}${canonicalJson(body)}`) !== artifactSha256) {
      errors.push("artifact hash mismatch");
    }
  }
  const scoredWithHash = { ...artifact };
  for (const key of [
    "artifactSha256",
    "fixtureManifestSha256",
    "asrConfigSha256",
    "asrBatchFinalizationSha256",
    "receiptsManifestSha256",
  ]) delete scoredWithHash[key];
  const { calibrationSha256, ...scoreBody } = scoredWithHash;
  if (!sha(calibrationSha256)
    || sha256Hex(`${CALIBRATION_RESULT_DOMAIN}${canonicalJson(scoreBody)}`) !== calibrationSha256) {
    errors.push("calibration result hash mismatch");
  }
  const metrics = artifact.metrics as Record<string, unknown> | undefined;
  const callerMetrics = artifact.callerMetrics as Record<string, unknown> | undefined;
  const outputVoiceMetrics = artifact.outputVoiceMetrics as readonly Record<string, unknown>[] | undefined;
  const thresholds = artifact.thresholds as Record<string, unknown> | undefined;
  if (!metrics || !callerMetrics || !Array.isArray(outputVoiceMetrics) || !thresholds) {
    errors.push("calibration metrics, output-voice metrics, or thresholds are missing");
  } else {
    const thresholdsFrozen = thresholds.requiredFixtureCoverage === 1
      && thresholds.maximumWordErrorRate === LONG_CALL_ASR_MAX_WER
      && thresholds.maximumCriticalSlotFalseNegatives === 0
      && thresholds.maximumSemanticSlotFalsePositives === 0;
    if (!thresholdsFrozen) errors.push("calibration thresholds differ from v2 preregistration");
    const passes = (summary: Record<string, unknown>) => summary.fixtureCoverage === 1
      && typeof summary.wordErrorRate === "number"
      && summary.wordErrorRate <= LONG_CALL_ASR_MAX_WER
      && typeof summary.criticalSlotFalseNegatives === "number"
      && summary.criticalSlotFalseNegatives === 0
      && typeof summary.semanticSlotFalsePositives === "number"
      && summary.semanticSlotFalsePositives === 0;
    const expectedRouteIds = expected.requiredOutputVoiceRoutes.map(longCallOutputVoiceRouteId).sort();
    const actualRouteIds = outputVoiceMetrics
      .map((summary) => typeof summary.routeId === "string" ? summary.routeId : "")
      .sort();
    if (canonicalJson(actualRouteIds) !== canonicalJson(expectedRouteIds)) errors.push("per-output-voice metric coverage mismatch");
    const fixtureResults = artifact.fixtureResults as readonly Record<string, unknown>[] | undefined;
    if (!Array.isArray(fixtureResults)) {
      errors.push("calibration fixture results are missing");
    } else {
      const callerResults = fixtureResults.filter((result) => result.calibrationKind === "caller");
      const outputResults = fixtureResults.filter((result) => result.calibrationKind === "provider_output");
      if (callerResults.length !== callerMetrics.plannedFixtures
        || outputResults.length !== LONG_CALL_ASR_OUTPUT_VOICE_ROUTES.length * LONG_CALL_ASR_OUTPUT_FIXTURES_PER_VOICE
        || fixtureResults.length !== metrics.plannedFixtures
        || fixtureResults.filter((result) => result.evidenceComplete === true).length !== metrics.completedFixtures) {
        errors.push("fixture-result coverage is inconsistent with calibration metrics");
      }
      for (const route of expected.requiredOutputVoiceRoutes) {
        if (outputResults.filter((result) => result.provider === route.provider
          && result.model === route.model
          && result.voice === route.voice).length !== LONG_CALL_ASR_OUTPUT_FIXTURES_PER_VOICE) {
          errors.push(`fixture-result output-voice coverage mismatch for ${longCallOutputVoiceRouteId(route)}`);
        }
      }
    }
    const computedGate = thresholdsFrozen && passes(metrics)
      && passes(callerMetrics)
      && typeof callerMetrics.plannedFixtures === "number"
      && callerMetrics.plannedFixtures >= LONG_CALL_ASR_CALIBRATION_TURN_ORDINALS.length
      && callerMetrics.completedFixtures === callerMetrics.plannedFixtures
      && outputVoiceMetrics.length === expected.requiredOutputVoiceRoutes.length
      && outputVoiceMetrics.every((summary) => passes(summary)
        && summary.plannedFixtures === LONG_CALL_ASR_OUTPUT_FIXTURES_PER_VOICE
        && summary.completedFixtures === LONG_CALL_ASR_OUTPUT_FIXTURES_PER_VOICE);
    if (artifact.gatePass !== computedGate) errors.push("gatePass is inconsistent with recorded metrics and thresholds");
  }
  if (expected.requirePassingGate === true && artifact.gatePass !== true) errors.push("calibration gate did not pass");
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

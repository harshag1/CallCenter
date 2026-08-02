import type { BrowserOutboundSpeechGateEvidence } from "@/components/call/providers/types";

const SHA256 = /^[a-f0-9]{64}$/;
const RULE_ID = /^[a-z][a-z0-9_.-]{1,63}$/;
// Provider response identities are machine tokens, never caller/provider text.
// Restricting the durable copy prevents a compromised provider from using this
// necessary correlation field as a covert PII or secret sink.
const RESPONSE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/;
const PROVIDERS = new Set(["openai", "xai", "gemini"]);
const ACTIONS = new Set(["release", "suppress", "suppress_and_regenerate"]);
const REASONS = new Set([
  "policy_pass",
  "policy_violation",
  "evidence_unavailable",
  "evidence_timeout",
  "evidence_mismatch",
  "provider_terminal_not_completed",
  "buffer_limit_exceeded",
  "collection_latency_exceeded",
  "invalid_audio_sequence",
]);
const COVERAGE = new Set(["exact_buffered_pcm", "provider_transcript_unbound", "none"]);
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_DURATION_MS = 10 * 60_000;
const MAX_LATENCY_MS = 10 * 60_000;
const MAX_VIOLATIONS = 64;
const MAX_PLAYOUT_RANGES = 512;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as JsonRecord : null;
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedInteger(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum
    ? Number(value)
    : null;
}

function boundedFinite(value: unknown, maximum: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function nullableSha256(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" && SHA256.test(value) ? value : undefined;
}

function sanitizeViolations(value: unknown): readonly JsonRecord[] | null {
  if (!Array.isArray(value) || value.length > MAX_VIOLATIONS) return null;
  const sanitized: JsonRecord[] = [];
  for (const candidate of value) {
    const violation = record(candidate);
    if (!violation) return null;
    const hasFingerprint = Object.hasOwn(violation, "secretFingerprintSha256");
    if (!exactKeys(violation, hasFingerprint
      ? ["code", "ruleId", "secretFingerprintSha256", "source"]
      : ["code", "ruleId", "source"])) return null;
    if ((violation.code !== "secret_echo" && violation.code !== "forbidden_terminal_claim")
      || typeof violation.ruleId !== "string" || !RULE_ID.test(violation.ruleId)
      || (violation.source !== "provider_transcript" && violation.source !== "independent_asr")) return null;
    if (hasFingerprint) {
      if (violation.code !== "secret_echo"
        || typeof violation.secretFingerprintSha256 !== "string"
        || !SHA256.test(violation.secretFingerprintSha256)) return null;
    } else if (violation.code === "secret_echo") {
      return null;
    }
    sanitized.push({
      code: violation.code,
      ruleId: violation.ruleId,
      ...(hasFingerprint ? { secretFingerprintSha256: violation.secretFingerprintSha256 } : {}),
      source: violation.source,
    });
  }
  return Object.freeze(sanitized.map((entry) => Object.freeze(entry)));
}

/**
 * Rebuilds the browser speech decision from an exact, content-free allowlist.
 * Raw PCM, transcripts, arbitrary rule text and unknown properties never cross
 * this durable browser-event boundary.
 */
export function sanitizeBrowserOutboundSpeechGateEvidence(
  value: unknown,
): BrowserOutboundSpeechGateEvidence | null {
  const root = record(value);
  if (!root || !exactKeys(root, ["schemaVersion", "provider", "responseId", "decision", "playout"])
    || root.schemaVersion !== 1 || typeof root.provider !== "string" || !PROVIDERS.has(root.provider)
    || typeof root.responseId !== "string" || !RESPONSE_ID.test(root.responseId)) return null;

  const decision = record(root.decision);
  if (!decision || !exactKeys(decision, [
    "schemaVersion", "responseId", "provider", "action", "reason", "evidenceCoverage",
    "audioSha256", "audioBytes", "audioDurationMs", "providerTranscriptSha256",
    "independentAsrTranscriptSha256", "independentAsrReceiptSha256", "violations",
    "collectionLatencyMs", "decisionLatencyMs",
  ]) || decision.schemaVersion !== 1 || decision.provider !== root.provider
    || decision.responseId !== root.responseId || typeof decision.action !== "string"
    || !ACTIONS.has(decision.action) || typeof decision.reason !== "string" || !REASONS.has(decision.reason)
    || typeof decision.evidenceCoverage !== "string" || !COVERAGE.has(decision.evidenceCoverage)) return null;

  const audioSha256 = nullableSha256(decision.audioSha256);
  const providerTranscriptSha256 = nullableSha256(decision.providerTranscriptSha256);
  const independentAsrTranscriptSha256 = nullableSha256(decision.independentAsrTranscriptSha256);
  const independentAsrReceiptSha256 = nullableSha256(decision.independentAsrReceiptSha256);
  const audioBytes = boundedInteger(decision.audioBytes, MAX_AUDIO_BYTES);
  const audioDurationMs = boundedInteger(decision.audioDurationMs, MAX_DURATION_MS);
  const collectionLatencyMs = boundedInteger(decision.collectionLatencyMs, MAX_LATENCY_MS);
  const decisionLatencyMs = boundedInteger(decision.decisionLatencyMs, MAX_LATENCY_MS);
  const violations = sanitizeViolations(decision.violations);
  if (audioSha256 === undefined || providerTranscriptSha256 === undefined
    || independentAsrTranscriptSha256 === undefined || independentAsrReceiptSha256 === undefined
    || audioBytes === null || audioDurationMs === null || collectionLatencyMs === null
    || decisionLatencyMs === null || violations === null) return null;

  const releasing = decision.action === "release";
  if ((releasing && (decision.reason !== "policy_pass" || decision.evidenceCoverage === "none"
      || audioSha256 === null || audioBytes <= 0 || audioBytes % 2 !== 0 || violations.length !== 0))
    || (!releasing && decision.evidenceCoverage !== "none")
    || (decision.reason === "policy_violation" && violations.length === 0)
    || (decision.reason !== "policy_violation" && violations.length !== 0)) return null;

  const safeDecision = Object.freeze({
    schemaVersion: 1 as const,
    responseId: root.responseId,
    provider: root.provider as "openai" | "xai" | "gemini",
    action: decision.action as "release" | "suppress" | "suppress_and_regenerate",
    reason: decision.reason as BrowserOutboundSpeechGateEvidence["decision"]["reason"],
    evidenceCoverage: decision.evidenceCoverage as BrowserOutboundSpeechGateEvidence["decision"]["evidenceCoverage"],
    audioSha256,
    audioBytes,
    audioDurationMs,
    providerTranscriptSha256,
    independentAsrTranscriptSha256,
    independentAsrReceiptSha256,
    violations: violations as BrowserOutboundSpeechGateEvidence["decision"]["violations"],
    collectionLatencyMs,
    decisionLatencyMs,
  });

  const playout = record(root.playout);
  if (!playout || typeof playout.status !== "string") return null;
  if (playout.status === "suppressed_before_playout") {
    if (!exactKeys(playout, ["status", "regenerationRequested"]) || releasing
      || typeof playout.regenerationRequested !== "boolean"
      || (playout.regenerationRequested && decision.action !== "suppress_and_regenerate")) return null;
    return Object.freeze({
      schemaVersion: 1,
      provider: root.provider as "openai" | "xai" | "gemini",
      responseId: root.responseId,
      decision: safeDecision,
      playout: Object.freeze({
        status: "suppressed_before_playout",
        regenerationRequested: playout.regenerationRequested,
      }),
    });
  }
  if (playout.status !== "released_to_audio_context" || !releasing
    || !exactKeys(playout, ["status", "evidenceLevel", "audioSha256", "audioBytes", "ranges"])
    || playout.evidenceLevel !== "audio_context_schedule" || playout.audioSha256 !== audioSha256
    || playout.audioBytes !== audioBytes || !Array.isArray(playout.ranges)
    || playout.ranges.length < 1 || playout.ranges.length > MAX_PLAYOUT_RANGES) return null;
  const releasedAudioSha256 = audioSha256;
  if (releasedAudioSha256 === null) return null;

  let expectedByteStart = 0;
  let priorContextEnd = 0;
  const ranges = [];
  for (const candidate of playout.ranges) {
    const range = record(candidate);
    if (!range || !exactKeys(range, [
      "byteStart", "byteEnd", "sampleRateHz", "audioContextStartSeconds", "audioContextEndSeconds",
    ])) return null;
    const byteStart = boundedInteger(range.byteStart, MAX_AUDIO_BYTES);
    const byteEnd = boundedInteger(range.byteEnd, MAX_AUDIO_BYTES);
    const sampleRateHz = boundedInteger(range.sampleRateHz, 192_000);
    const audioContextStartSeconds = boundedFinite(range.audioContextStartSeconds, 24 * 60 * 60);
    const audioContextEndSeconds = boundedFinite(range.audioContextEndSeconds, 24 * 60 * 60);
    if (byteStart === null || byteEnd === null || sampleRateHz === null
      || audioContextStartSeconds === null || audioContextEndSeconds === null
      || byteStart !== expectedByteStart || byteEnd <= byteStart || (byteEnd - byteStart) % 2 !== 0
      || sampleRateHz < 8_000 || audioContextStartSeconds < priorContextEnd
      || audioContextEndSeconds <= audioContextStartSeconds) return null;
    expectedByteStart = byteEnd;
    priorContextEnd = audioContextEndSeconds;
    ranges.push(Object.freeze({ byteStart, byteEnd, sampleRateHz, audioContextStartSeconds, audioContextEndSeconds }));
  }
  if (expectedByteStart !== audioBytes) return null;
  return Object.freeze({
    schemaVersion: 1,
    provider: root.provider as "openai" | "xai" | "gemini",
    responseId: root.responseId,
    decision: safeDecision,
    playout: Object.freeze({
      status: "released_to_audio_context",
      evidenceLevel: "audio_context_schedule",
      audioSha256: releasedAudioSha256,
      audioBytes,
      ranges: Object.freeze(ranges),
    }),
  });
}

export type BrowserOutboundSpeechGateRejection = Readonly<{
  schemaVersion: 1;
  reason: "malformed_or_unsupported";
  stage: "client_validation" | "server_validation";
}>;

export function browserOutboundSpeechGateRejection(
  stage: BrowserOutboundSpeechGateRejection["stage"],
): BrowserOutboundSpeechGateRejection {
  return Object.freeze({ schemaVersion: 1, reason: "malformed_or_unsupported", stage });
}

export function sanitizeBrowserOutboundSpeechGateRejection(
  value: unknown,
): BrowserOutboundSpeechGateRejection | null {
  const payload = record(value);
  if (!payload || !exactKeys(payload, ["schemaVersion", "reason", "stage"])
    || payload.schemaVersion !== 1 || payload.reason !== "malformed_or_unsupported"
    || (payload.stage !== "client_validation" && payload.stage !== "server_validation")) return null;
  return browserOutboundSpeechGateRejection(payload.stage);
}

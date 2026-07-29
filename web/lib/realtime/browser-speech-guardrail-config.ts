import type {
  OutboundSpeechEvidencePolicy,
  OutboundSpeechGateAction,
  OutboundSpeechGatePolicy,
} from "./outbound-speech-gate";
import type { VoiceProviderId } from "./types";

const SHA256 = /^[a-f0-9]{64}$/;
const RULE_ID = /^[a-z][a-z0-9_.-]{1,63}$/;

export type BrowserSpeechGuardrailBootstrap = Readonly<{
  schemaVersion: 1;
  mode: "enforce";
  organizationId: string;
  provider: VoiceProviderId;
  callId: string;
  asrEndpoint: "/api/voice/outbound-speech/asr";
  policy: Readonly<{
    evidencePolicy: OutboundSpeechEvidencePolicy;
    maxBufferedAudioBytes: number;
    maxBufferedAudioMs: number;
    maxCollectionLatencyMs: number;
    maxDecisionLatencyMs: number;
    onViolation: Exclude<OutboundSpeechGateAction, "release">;
    onEvidenceFailure: Exclude<OutboundSpeechGateAction, "release">;
    secrets: readonly Readonly<{
      value: string;
      fingerprintSha256: string;
      ruleId: string;
    }>[];
    forbiddenTerminalClaims: readonly Readonly<{
      phrase: string;
      ruleId: string;
    }>[];
    terminalClaimsAuthorized: boolean;
  }>;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function parseBrowserSpeechGuardrailBootstrap(
  value: unknown,
): BrowserSpeechGuardrailBootstrap | null {
  if (value === undefined || value === null) return null;
  const root = record(value);
  if (!root || root.schemaVersion !== 1 || root.mode !== "enforce") {
    throw new Error("browser speech guardrail bootstrap is invalid");
  }
  if (root.provider !== "xai" && root.provider !== "openai" && root.provider !== "gemini") {
    throw new Error("browser speech guardrail provider is invalid");
  }
  if (root.asrEndpoint !== "/api/voice/outbound-speech/asr") {
    throw new Error("browser speech guardrail ASR endpoint is invalid");
  }
  const callId = boundedText(root.callId, "browser speech guardrail call identity", 128);
  const organizationId = boundedText(
    root.organizationId,
    "browser speech guardrail organization identity",
    128,
  );
  const policy = record(root.policy);
  if (!policy) throw new Error("browser speech guardrail policy is missing");
  const evidencePolicy = policy.evidencePolicy;
  if (
    evidencePolicy !== "independent_asr_required"
    && evidencePolicy !== "provider_transcript_allowed"
    && evidencePolicy !== "provider_and_independent_asr_required"
  ) {
    throw new Error("browser speech guardrail evidence policy is invalid");
  }
  if (policy.onViolation !== "suppress" && policy.onViolation !== "suppress_and_regenerate") {
    throw new Error("browser speech guardrail violation action is invalid");
  }
  if (policy.onEvidenceFailure !== "suppress" && policy.onEvidenceFailure !== "suppress_and_regenerate") {
    throw new Error("browser speech guardrail evidence-failure action is invalid");
  }
  if (typeof policy.terminalClaimsAuthorized !== "boolean") {
    throw new Error("browser speech guardrail terminal-claim authority is invalid");
  }
  if (!Array.isArray(policy.secrets) || !Array.isArray(policy.forbiddenTerminalClaims)) {
    throw new Error("browser speech guardrail rule lists are invalid");
  }
  const seenRuleIds = new Set<string>();
  const secrets = policy.secrets.map((entry, index) => {
    const secret = record(entry);
    if (!secret) throw new Error(`browser speech guardrail secret ${index} is invalid`);
    const value = boundedText(secret.value, `browser speech guardrail secret ${index}`, 4_096);
    const ruleId = boundedText(secret.ruleId, `browser speech guardrail secret rule ${index}`, 64);
    if (!RULE_ID.test(ruleId) || seenRuleIds.has(ruleId)) {
      throw new Error(`browser speech guardrail secret rule ${index} is invalid`);
    }
    if (typeof secret.fingerprintSha256 !== "string" || !SHA256.test(secret.fingerprintSha256)) {
      throw new Error(`browser speech guardrail secret fingerprint ${index} is invalid`);
    }
    seenRuleIds.add(ruleId);
    return Object.freeze({ value, ruleId, fingerprintSha256: secret.fingerprintSha256 });
  });
  const forbiddenTerminalClaims = policy.forbiddenTerminalClaims.map((entry, index) => {
    const claim = record(entry);
    if (!claim) throw new Error(`browser speech guardrail terminal claim ${index} is invalid`);
    const phrase = boundedText(claim.phrase, `browser speech guardrail terminal phrase ${index}`, 4_096);
    const ruleId = boundedText(claim.ruleId, `browser speech guardrail terminal rule ${index}`, 64);
    if (!RULE_ID.test(ruleId) || seenRuleIds.has(ruleId)) {
      throw new Error(`browser speech guardrail terminal rule ${index} is invalid`);
    }
    seenRuleIds.add(ruleId);
    return Object.freeze({ phrase, ruleId });
  });
  const normalizedPolicy: OutboundSpeechGatePolicy = Object.freeze({
    evidencePolicy,
    maxBufferedAudioBytes: positiveSafeInteger(policy.maxBufferedAudioBytes, "maxBufferedAudioBytes"),
    maxBufferedAudioMs: positiveSafeInteger(policy.maxBufferedAudioMs, "maxBufferedAudioMs"),
    maxCollectionLatencyMs: positiveSafeInteger(policy.maxCollectionLatencyMs, "maxCollectionLatencyMs"),
    maxDecisionLatencyMs: positiveSafeInteger(policy.maxDecisionLatencyMs, "maxDecisionLatencyMs"),
    onViolation: policy.onViolation,
    onEvidenceFailure: policy.onEvidenceFailure,
    secrets: Object.freeze(secrets),
    forbiddenTerminalClaims: Object.freeze(forbiddenTerminalClaims),
    terminalClaimsAuthorized: policy.terminalClaimsAuthorized,
  });
  return Object.freeze({
    schemaVersion: 1,
    mode: "enforce",
    organizationId,
    provider: root.provider,
    callId,
    asrEndpoint: root.asrEndpoint,
    policy: normalizedPolicy,
  });
}

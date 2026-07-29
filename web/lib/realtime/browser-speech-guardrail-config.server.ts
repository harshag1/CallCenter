import "server-only";

import { createHash } from "node:crypto";
import { DEFAULT_OUTBOUND_SPEECH_GATE_LIMITS } from "./outbound-speech-gate";
import type { VoiceProviderId } from "./types";
import type { BrowserSpeechGuardrailBootstrap } from "./browser-speech-guardrail-config";
import { outboundSpeechAsrBudgetAuthority } from "./outbound-speech-asr-config.server";

const RULE_ID = /^[a-z][a-z0-9_.-]{1,63}$/;
const MAX_RULES = 64;
const MAX_PHRASE_LENGTH = 4_096;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function configuredRuleText(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value !== value.trim()
    || value.length > MAX_PHRASE_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function configuredRuleId(value: unknown, label: string, seen: Set<string>): string {
  const id = configuredRuleText(value, label);
  if (!RULE_ID.test(id) || seen.has(id)) throw new Error(`${label} is invalid or duplicated`);
  seen.add(id);
  return id;
}

function optionalPositiveInteger(
  value: unknown,
  fallback: number,
  label: string,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error(`${label} is outside its safe bound`);
  }
  return value as number;
}

/**
 * Server-authored policy for the ordinary browser call path.
 *
 * `settings.speech_guardrail.mode="enforce"` enables it per agent. A deployment
 * can make it mandatory for every browser call with
 * `HACC_REQUIRE_BROWSER_SPEECH_GUARDRAILS=1`; malformed or unavailable policy
 * then fails token minting instead of silently falling back to direct playout.
 */
export function browserSpeechGuardrailConfigForCall(input: Readonly<{
  settings: Record<string, unknown>;
  provider: VoiceProviderId;
  organizationId: string;
  callId: string;
  environment?: Readonly<Record<string, string | undefined>>;
}>): BrowserSpeechGuardrailBootstrap | null {
  const environment = input.environment ?? process.env;
  const configured = record(input.settings.speech_guardrail);
  if (
    environment.HACC_REQUIRE_BROWSER_SPEECH_GUARDRAILS !== undefined
    && environment.HACC_REQUIRE_BROWSER_SPEECH_GUARDRAILS !== "0"
    && environment.HACC_REQUIRE_BROWSER_SPEECH_GUARDRAILS !== "1"
  ) {
    throw new Error("HACC_REQUIRE_BROWSER_SPEECH_GUARDRAILS must be 0 or 1");
  }
  const deploymentRequired = environment.HACC_REQUIRE_BROWSER_SPEECH_GUARDRAILS === "1";
  const configuredMode = configured?.mode;
  if (configuredMode !== undefined && configuredMode !== "off" && configuredMode !== "enforce") {
    throw new Error("speech_guardrail.mode must be off or enforce");
  }
  if (!deploymentRequired && configuredMode !== "enforce") return null;
  outboundSpeechAsrBudgetAuthority(environment);
  const seen = new Set<string>();
  const rawSecrets = configured?.secrets ?? [];
  const rawClaims = configured?.forbidden_terminal_claims ?? [];
  if (!Array.isArray(rawSecrets) || rawSecrets.length > MAX_RULES) {
    throw new Error(`speech_guardrail.secrets must contain at most ${MAX_RULES} rules`);
  }
  if (!Array.isArray(rawClaims) || rawClaims.length > MAX_RULES) {
    throw new Error(`speech_guardrail.forbidden_terminal_claims must contain at most ${MAX_RULES} rules`);
  }
  const secrets = rawSecrets.map((entry, index) => {
    const rule = record(entry);
    if (!rule) throw new Error(`speech_guardrail.secrets[${index}] must be an object`);
    const value = configuredRuleText(rule.value, `speech_guardrail.secrets[${index}].value`);
    if (value.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "").length < 4) {
      throw new Error(`speech_guardrail.secrets[${index}].value is too short`);
    }
    return Object.freeze({
      value,
      ruleId: configuredRuleId(rule.rule_id, `speech_guardrail.secrets[${index}].rule_id`, seen),
      fingerprintSha256: createHash("sha256").update(value).digest("hex"),
    });
  });
  const forbiddenTerminalClaims = rawClaims.map((entry, index) => {
    const rule = record(entry);
    if (!rule) throw new Error(`speech_guardrail.forbidden_terminal_claims[${index}] must be an object`);
    return Object.freeze({
      phrase: configuredRuleText(
        rule.phrase,
        `speech_guardrail.forbidden_terminal_claims[${index}].phrase`,
      ),
      ruleId: configuredRuleId(
        rule.rule_id,
        `speech_guardrail.forbidden_terminal_claims[${index}].rule_id`,
        seen,
      ),
    });
  });
  const onViolation = configured?.on_violation === "suppress_and_regenerate"
    ? "suppress_and_regenerate" as const
    : "suppress" as const;
  const onEvidenceFailure = configured?.on_evidence_failure === "suppress_and_regenerate"
    ? "suppress_and_regenerate" as const
    : "suppress" as const;
  return Object.freeze({
    schemaVersion: 1,
    mode: "enforce",
    organizationId: input.organizationId,
    provider: input.provider,
    callId: input.callId,
    asrEndpoint: "/api/voice/outbound-speech/asr",
    policy: Object.freeze({
      evidencePolicy: "independent_asr_required",
      maxBufferedAudioBytes: optionalPositiveInteger(
        configured?.max_buffered_audio_bytes,
        DEFAULT_OUTBOUND_SPEECH_GATE_LIMITS.maxBufferedAudioBytes,
        "speech_guardrail.max_buffered_audio_bytes",
        16 * 1024 * 1024,
      ),
      maxBufferedAudioMs: optionalPositiveInteger(
        configured?.max_buffered_audio_ms,
        DEFAULT_OUTBOUND_SPEECH_GATE_LIMITS.maxBufferedAudioMs,
        "speech_guardrail.max_buffered_audio_ms",
        180_000,
      ),
      maxCollectionLatencyMs: optionalPositiveInteger(
        configured?.max_collection_latency_ms,
        DEFAULT_OUTBOUND_SPEECH_GATE_LIMITS.maxCollectionLatencyMs,
        "speech_guardrail.max_collection_latency_ms",
        210_000,
      ),
      maxDecisionLatencyMs: optionalPositiveInteger(
        configured?.max_decision_latency_ms,
        DEFAULT_OUTBOUND_SPEECH_GATE_LIMITS.maxDecisionLatencyMs,
        "speech_guardrail.max_decision_latency_ms",
        30_000,
      ),
      onViolation,
      onEvidenceFailure,
      secrets: Object.freeze(secrets),
      forbiddenTerminalClaims: Object.freeze(forbiddenTerminalClaims),
      terminalClaimsAuthorized: configured?.terminal_claims_authorized === true,
    }),
  });
}

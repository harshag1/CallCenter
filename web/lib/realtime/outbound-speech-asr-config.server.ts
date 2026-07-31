import "server-only";

const MIN_RECEIPT_KEY_BYTES = 32;
const MAX_RECEIPT_KEY_BYTES = 4 * 1024;
const MIN_CALL_BUDGET_MICRO_USD = 6_000;
const MAX_CALL_BUDGET_MICRO_USD = 2_000_000;
const MAX_ORG_DAILY_BUDGET_MICRO_USD = 50_000_000;

export const OUTBOUND_SPEECH_ASR_MODEL = "whisper-1";
export const OUTBOUND_SPEECH_ASR_ENGINE = "openai_audio_transcriptions";
export const OUTBOUND_SPEECH_ASR_COST_MICRO_USD_PER_STARTED_MINUTE = 6_000;

export type OutboundSpeechAsrBudgetAuthority = Readonly<{
  maxMicroUsdPerCall: number;
  maxMicroUsdPerOrganizationDay: number;
  receiptHmacKey: string;
}>;

function configuredPositiveInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be an explicitly configured positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is outside its safe bound`);
  return parsed;
}

/**
 * Guarded playout is funded only under an explicit, bounded per-call
 * authority. Execution separately requires that same tenant's encrypted
 * OpenAI BYOK root; deployment provider roots are never ASR spend authority.
 */
export function outboundSpeechAsrBudgetAuthority(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OutboundSpeechAsrBudgetAuthority {
  const maxMicroUsdPerCall = configuredPositiveInteger(
    environment.HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_WEB_CALL,
    "HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_WEB_CALL",
  );
  if (
    maxMicroUsdPerCall < MIN_CALL_BUDGET_MICRO_USD
    || maxMicroUsdPerCall > MAX_CALL_BUDGET_MICRO_USD
  ) {
    throw new Error(
      "HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_WEB_CALL must be between 6000 and 2000000",
    );
  }
  const receiptHmacKey = environment.HACC_OUTBOUND_SPEECH_ASR_RECEIPT_HMAC_KEY;
  const receiptKeyBytes = receiptHmacKey === undefined
    ? 0
    : Buffer.byteLength(receiptHmacKey, "utf8");
  if (
    !receiptHmacKey
    || receiptHmacKey.trim() !== receiptHmacKey
    || /[\u0000-\u001f\u007f]/u.test(receiptHmacKey)
    || receiptKeyBytes < MIN_RECEIPT_KEY_BYTES
    || receiptKeyBytes > MAX_RECEIPT_KEY_BYTES
  ) {
    throw new Error(
      "HACC_OUTBOUND_SPEECH_ASR_RECEIPT_HMAC_KEY must be an independent 32-byte-or-longer secret",
    );
  }
  const maxMicroUsdPerOrganizationDay = configuredPositiveInteger(
    environment.HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_ORG_DAY,
    "HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_ORG_DAY",
  );
  if (
    maxMicroUsdPerOrganizationDay < maxMicroUsdPerCall
    || maxMicroUsdPerOrganizationDay > MAX_ORG_DAILY_BUDGET_MICRO_USD
  ) {
    throw new Error(
      "HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_ORG_DAY must cover one call and be at most 50000000",
    );
  }
  return Object.freeze({
    maxMicroUsdPerCall,
    maxMicroUsdPerOrganizationDay,
    receiptHmacKey,
  });
}

export function reservedOutboundSpeechAsrMicroUsd(audioDurationMs: number): number {
  if (!Number.isFinite(audioDurationMs) || audioDurationMs <= 0 || audioDurationMs > 180_000) {
    throw new Error("guarded speech ASR duration is outside its funded bound");
  }
  return Math.ceil(audioDurationMs / 60_000)
    * OUTBOUND_SPEECH_ASR_COST_MICRO_USD_PER_STARTED_MINUTE;
}

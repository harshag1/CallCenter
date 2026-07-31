import {
  OutboundSpeechGate,
  createOutboundSpeechGatePolicy,
  type IndependentSpeechAsr,
  type IndependentSpeechAsrReceipt,
} from "@/lib/realtime/outbound-speech-gate";
import {
  parseBrowserSpeechGuardrailBootstrap,
  type BrowserSpeechGuardrailBootstrap,
} from "@/lib/realtime/browser-speech-guardrail-config";
import type {
  BrowserOutboundSpeechGateConfig,
  BrowserOutboundSpeechGateEvidence,
} from "./providers/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ASR_RESPONSE_BYTES = 64 * 1024;

export type BrowserSpeechGuardrailStatus =
  | Readonly<{ state: "disabled"; provider: "openai" | "xai" | "gemini" }>
  | Readonly<{
    state: "enforcing";
    provider: "openai" | "xai" | "gemini";
    evidence: "exact_pcm_independent_asr";
    playout: "quarantined_until_response_decision";
  }>
  | Readonly<{
    state: "failed_closed";
    provider: "openai" | "xai" | "gemini";
    reason: "invalid_bootstrap" | "provider_mismatch" | "asr_unavailable";
  }>;

type BootstrapInput = Readonly<{
  value: unknown;
  provider: "openai" | "xai" | "gemini";
  callId: string;
  onEvidence: (evidence: BrowserOutboundSpeechGateEvidence) => void;
}>;

function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += stride) {
    output += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + stride, bytes.byteLength)));
  }
  return btoa(output);
}

function validReceipt(
  value: unknown,
  expected: Readonly<{
    organizationId: string;
    callId: string;
    provider: "openai" | "xai" | "gemini";
    responseId: string;
    audioSha256: string;
    audioBytes: number;
    sampleRateHz: number;
  }>,
): value is IndependentSpeechAsrReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return receipt.schemaVersion === 2
    && typeof receipt.authorityId === "string"
    && UUID.test(receipt.authorityId)
    && receipt.organizationId === expected.organizationId
    && receipt.callId === expected.callId
    && receipt.provider === expected.provider
    && receipt.responseId === expected.responseId
    && typeof receipt.text === "string"
    && receipt.text.length <= 32_000
    && typeof receipt.transcriptSha256 === "string"
    && SHA256.test(receipt.transcriptSha256)
    && receipt.audioSha256 === expected.audioSha256
    && receipt.audioBytes === expected.audioBytes
    && receipt.sampleRateHz === expected.sampleRateHz
    && receipt.channels === 1
    && receipt.complete === true
    && typeof receipt.engine === "string"
    && receipt.engine.length > 0 && receipt.engine.length <= 128
    && typeof receipt.model === "string"
    && receipt.model.length > 0 && receipt.model.length <= 128
    && receipt.decision === "transcribed"
    && typeof receipt.receiptHmacSha256 === "string"
    && SHA256.test(receipt.receiptHmacSha256)
    && typeof receipt.receiptSha256 === "string"
    && SHA256.test(receipt.receiptSha256);
}

function independentAsrFor(
  bootstrap: BrowserSpeechGuardrailBootstrap,
): IndependentSpeechAsr {
  return async (input) => {
    if (Date.now() >= input.deadlineAtMs) throw new Error("speech guardrail ASR deadline expired");
    const controller = new AbortController();
    const timeoutMs = Math.max(1, input.deadlineAtMs - Date.now());
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(bootstrap.asrEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        credentials: "same-origin",
        signal: controller.signal,
        body: JSON.stringify({
          schemaVersion: 1,
          callId: bootstrap.callId,
          responseId: input.responseId,
          provider: input.provider,
          audio: {
            encoding: "pcm16",
            sampleRateHz: input.audio.sampleRateHz,
            channels: 1,
            base64: bytesToBase64(input.audio.data),
            sha256: input.audioSha256,
            bytes: input.audioBytes,
            durationMs: input.audioDurationMs,
          },
        }),
      });
    } finally {
      window.clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`speech guardrail ASR failed with status ${response.status}`);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_ASR_RESPONSE_BYTES) {
      throw new Error("speech guardrail ASR response exceeded its safety bound");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("speech guardrail ASR response was malformed");
    }
    if (!validReceipt(parsed, {
      organizationId: bootstrap.organizationId,
      callId: bootstrap.callId,
      provider: input.provider as "openai" | "xai" | "gemini",
      responseId: input.responseId,
      audioSha256: input.audioSha256,
      audioBytes: input.audioBytes,
      sampleRateHz: input.audio.sampleRateHz,
    })) throw new Error("speech guardrail ASR receipt was invalid");
    return parsed;
  };
}

/**
 * Turns the server-authored bootstrap into the only gate instance used by a
 * browser call. If the server requested enforcement, every parse/identity
 * mismatch throws so the caller cannot silently fall back to direct playout.
 */
export function createBrowserSpeechGuardrail(
  input: BootstrapInput,
): Readonly<{
  config: BrowserOutboundSpeechGateConfig | null;
  status: BrowserSpeechGuardrailStatus;
}> {
  if (input.value === undefined || input.value === null) {
    return Object.freeze({
      config: null,
      status: Object.freeze({ state: "disabled", provider: input.provider }),
    });
  }
  let bootstrap: BrowserSpeechGuardrailBootstrap | null;
  try {
    bootstrap = parseBrowserSpeechGuardrailBootstrap(input.value);
  } catch {
    throw new Error("guarded browser call refused an invalid speech policy");
  }
  if (!bootstrap || bootstrap.provider !== input.provider || bootstrap.callId !== input.callId
    || !UUID.test(bootstrap.callId) || !UUID.test(bootstrap.organizationId)) {
    throw new Error("guarded browser call refused mismatched speech authority");
  }
  const config: BrowserOutboundSpeechGateConfig = Object.freeze({
    gate: new OutboundSpeechGate({
      policy: createOutboundSpeechGatePolicy(bootstrap.policy),
      receiptContext: {
        organizationId: bootstrap.organizationId,
        callId: bootstrap.callId,
      },
      independentAsr: independentAsrFor(bootstrap),
    }),
    onEvidence: input.onEvidence,
  });
  return Object.freeze({
    config,
    status: Object.freeze({
      state: "enforcing",
      provider: input.provider,
      evidence: "exact_pcm_independent_asr",
      playout: "quarantined_until_response_decision",
    }),
  });
}

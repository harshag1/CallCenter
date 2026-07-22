/**
 * Provider-neutral quarantine for generated speech before caller playout.
 *
 * This module is intentionally transport-agnostic. A caller must route every
 * generated PCM chunk through the gate and must not enqueue any returned audio
 * for playout until `finalizeResponse()` returns `release`.
 *
 * The default evidence policy is byte-bound independent ASR. Provider output
 * transcripts can corroborate a decision, but are not proof that they cover the
 * exact PCM bytes held by this gate.
 */

import type {
  NormalizedRealtimeEvent,
  Pcm16Audio,
  RealtimeResponseTerminalStatus,
  ServerRealtimeProvider,
} from "./client/types";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;

export type OutboundSpeechGateAction = "release" | "suppress" | "suppress_and_regenerate";

export type OutboundSpeechEvidencePolicy =
  | "independent_asr_required"
  | "provider_transcript_allowed"
  | "provider_and_independent_asr_required";

export type OutboundSpeechSecret = Readonly<{
  /** Raw value is held only for matching and never appears in decisions. */
  value: string;
  /** Precomputed by the caller so this browser-compatible module never logs the value. */
  fingerprintSha256: string;
  ruleId: string;
}>;

export type ForbiddenTerminalClaim = Readonly<{
  phrase: string;
  ruleId: string;
}>;

export type OutboundSpeechGatePolicy = Readonly<{
  evidencePolicy: OutboundSpeechEvidencePolicy;
  maxBufferedAudioBytes: number;
  maxBufferedAudioMs: number;
  /** Maximum time from response start through its terminal provider event. */
  maxCollectionLatencyMs: number;
  /** Maximum additional time allowed for hashing and independent ASR. */
  maxDecisionLatencyMs: number;
  onViolation: Exclude<OutboundSpeechGateAction, "release">;
  onEvidenceFailure: Exclude<OutboundSpeechGateAction, "release">;
  secrets: readonly OutboundSpeechSecret[];
  forbiddenTerminalClaims: readonly ForbiddenTerminalClaim[];
  /** When true, configured terminal phrases are permitted for this gate instance. */
  terminalClaimsAuthorized: boolean;
}>;

export const DEFAULT_OUTBOUND_SPEECH_GATE_LIMITS = Object.freeze({
  evidencePolicy: "independent_asr_required" as const,
  maxBufferedAudioBytes: 8 * 1024 * 1024,
  maxBufferedAudioMs: 120_000,
  maxCollectionLatencyMs: 150_000,
  maxDecisionLatencyMs: 15_000,
  onViolation: "suppress" as const,
  onEvidenceFailure: "suppress" as const,
});

export type IndependentSpeechAsrInput = Readonly<{
  responseId: string;
  provider: ServerRealtimeProvider;
  audio: Pcm16Audio;
  audioSha256: string;
  audioBytes: number;
  audioDurationMs: number;
  deadlineAtMs: number;
}>;

export type IndependentSpeechAsrReceipt = Readonly<{
  text: string;
  /** Must match the exact concatenated PCM supplied in `IndependentSpeechAsrInput`. */
  audioSha256: string;
  audioBytes: number;
  sampleRateHz: number;
  channels: 1;
  complete: true;
  engine: string;
  receiptSha256: string;
}>;

export type IndependentSpeechAsr = (
  input: IndependentSpeechAsrInput,
) => Promise<IndependentSpeechAsrReceipt>;

export type OutboundSpeechViolation = Readonly<{
  code: "secret_echo" | "forbidden_terminal_claim";
  ruleId: string;
  /** Present only for secret rules; never the secret itself. */
  secretFingerprintSha256?: string;
  source: "provider_transcript" | "independent_asr";
}>;

export type OutboundSpeechGateDecision = Readonly<{
  schemaVersion: 1;
  responseId: string;
  provider: ServerRealtimeProvider;
  action: OutboundSpeechGateAction;
  reason:
    | "policy_pass"
    | "policy_violation"
    | "evidence_unavailable"
    | "evidence_timeout"
    | "evidence_mismatch"
    | "provider_terminal_not_completed"
    | "buffer_limit_exceeded"
    | "collection_latency_exceeded"
    | "invalid_audio_sequence";
  evidenceCoverage: "exact_buffered_pcm" | "provider_transcript_unbound" | "none";
  audioSha256: string | null;
  audioBytes: number;
  audioDurationMs: number;
  providerTranscriptSha256: string | null;
  independentAsrTranscriptSha256: string | null;
  independentAsrReceiptSha256: string | null;
  violations: readonly OutboundSpeechViolation[];
  collectionLatencyMs: number;
  decisionLatencyMs: number;
  /** Present only after a release decision. These bytes were quarantined until policy passed. */
  audio?: readonly Pcm16Audio[];
}>;

export type OutboundSpeechGateStatus = Readonly<{
  state: "collecting" | "terminal" | "sealed" | "finalized";
  responseId: string;
  audioBytes: number;
  audioDurationMs: number;
  sealedReason?: OutboundSpeechGateDecision["reason"];
}>;

type HeldResponse = {
  provider: ServerRealtimeProvider;
  responseId: string;
  startedAtMs: number;
  terminalAtMs: number | null;
  terminalStatus: RealtimeResponseTerminalStatus | null;
  chunks: Pcm16Audio[];
  audioBytes: number;
  audioDurationMs: number;
  format: Omit<Pcm16Audio, "data"> | null;
  providerTranscript: string | null;
  providerTranscriptFinal: boolean;
  sealedReason: OutboundSpeechGateDecision["reason"] | null;
  finalized: boolean;
};

type Timer = ReturnType<typeof setTimeout>;

export type OutboundSpeechGateOptions = Readonly<{
  policy: OutboundSpeechGatePolicy;
  independentAsr?: IndependentSpeechAsr;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}>;

export function createOutboundSpeechGatePolicy(
  overrides: Partial<OutboundSpeechGatePolicy> = {},
): OutboundSpeechGatePolicy {
  const policy: OutboundSpeechGatePolicy = {
    ...DEFAULT_OUTBOUND_SPEECH_GATE_LIMITS,
    secrets: [],
    forbiddenTerminalClaims: [],
    terminalClaimsAuthorized: false,
    ...overrides,
  };
  validatePolicy(policy);
  return Object.freeze({
    ...policy,
    secrets: Object.freeze(policy.secrets.map((secret) => Object.freeze({ ...secret }))),
    forbiddenTerminalClaims: Object.freeze(
      policy.forbiddenTerminalClaims.map((claim) => Object.freeze({ ...claim })),
    ),
  });
}

export class OutboundSpeechGate {
  private readonly policy: OutboundSpeechGatePolicy;
  private readonly independentAsr?: IndependentSpeechAsr;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly responses = new Map<string, HeldResponse>();
  private readonly decisions = new Map<string, OutboundSpeechGateDecision>();

  constructor(options: OutboundSpeechGateOptions) {
    this.policy = createOutboundSpeechGatePolicy(options.policy);
    this.independentAsr = options.independentAsr;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  /** Convenience adapter for the normalized server-side realtime event stream. */
  observe(event: NormalizedRealtimeEvent): OutboundSpeechGateStatus | null {
    if (event.type === "response.started") {
      this.beginResponse(event.provider, event.responseId, event.receivedAtMs);
      return this.status(event.responseId);
    }
    if (event.type === "output.audio") {
      this.pushAudio(event.provider, event.responseId, {
        ...event.format,
        data: event.audio,
      }, event.receivedAtMs);
      return this.status(event.responseId);
    }
    if (event.type === "output.transcript") {
      this.pushProviderTranscript(
        event.provider,
        event.responseId,
        event.text,
        event.phase === "final",
        event.receivedAtMs,
      );
      return this.status(event.responseId);
    }
    if (event.type === "response.completed") {
      this.markTerminal(event.provider, event.responseId, event.status, event.receivedAtMs);
      return this.status(event.responseId);
    }
    return null;
  }

  beginResponse(provider: ServerRealtimeProvider, responseId: string, startedAtMs = this.now()): void {
    assertIdentity(responseId, "responseId");
    assertTimestamp(startedAtMs, "startedAtMs");
    if (this.responses.has(responseId) || this.decisions.has(responseId)) {
      throw new Error(`speech gate response identity already exists: ${responseId}`);
    }
    this.responses.set(responseId, {
      provider,
      responseId,
      startedAtMs,
      terminalAtMs: null,
      terminalStatus: null,
      chunks: [],
      audioBytes: 0,
      audioDurationMs: 0,
      format: null,
      providerTranscript: null,
      providerTranscriptFinal: false,
      sealedReason: null,
      finalized: false,
    });
  }

  pushAudio(
    provider: ServerRealtimeProvider,
    responseId: string,
    audio: Pcm16Audio,
    receivedAtMs = this.now(),
  ): void {
    const response = this.ensureCollecting(provider, responseId, receivedAtMs);
    if (response.terminalAtMs !== null || response.finalized) {
      throw new Error(`speech gate rejected audio after terminal response ${responseId}`);
    }
    if (
      audio.encoding !== "pcm16"
      || audio.channels !== 1
      || !Number.isSafeInteger(audio.sampleRateHz)
      || audio.sampleRateHz <= 0
      || !(audio.data instanceof Uint8Array)
      || audio.data.byteLength === 0
      || audio.data.byteLength % 2 !== 0
    ) {
      response.sealedReason = "invalid_audio_sequence";
      return;
    }
    if (
      response.format
      && (
        response.format.encoding !== audio.encoding
        || response.format.sampleRateHz !== audio.sampleRateHz
        || response.format.channels !== audio.channels
      )
    ) {
      response.sealedReason = "invalid_audio_sequence";
      return;
    }
    response.format ??= {
      encoding: audio.encoding,
      sampleRateHz: audio.sampleRateHz,
      channels: audio.channels,
    };
    const durationMs = audio.data.byteLength / 2 / audio.sampleRateHz * 1_000;
    response.audioBytes += audio.data.byteLength;
    response.audioDurationMs += durationMs;
    if (
      response.audioBytes > this.policy.maxBufferedAudioBytes
      || response.audioDurationMs > this.policy.maxBufferedAudioMs
    ) {
      response.sealedReason = "buffer_limit_exceeded";
      response.chunks = [];
      return;
    }
    if (receivedAtMs - response.startedAtMs > this.policy.maxCollectionLatencyMs) {
      response.sealedReason = "collection_latency_exceeded";
      response.chunks = [];
      return;
    }
    response.chunks.push({
      encoding: audio.encoding,
      sampleRateHz: audio.sampleRateHz,
      channels: 1,
      data: new Uint8Array(audio.data),
    });
  }

  pushProviderTranscript(
    provider: ServerRealtimeProvider,
    responseId: string,
    text: string,
    final: boolean,
    receivedAtMs = this.now(),
  ): void {
    const response = this.ensureCollecting(provider, responseId, receivedAtMs);
    if (response.finalized) throw new Error(`speech gate response ${responseId} is finalized`);
    if (typeof text !== "string") throw new Error("provider transcript must be text");
    response.providerTranscript = text;
    response.providerTranscriptFinal = final;
    if (receivedAtMs - response.startedAtMs > this.policy.maxCollectionLatencyMs) {
      response.sealedReason = "collection_latency_exceeded";
      response.chunks = [];
    }
  }

  markTerminal(
    provider: ServerRealtimeProvider,
    responseId: string,
    status: RealtimeResponseTerminalStatus,
    receivedAtMs = this.now(),
  ): void {
    const response = this.ensureCollecting(provider, responseId, receivedAtMs);
    if (response.terminalAtMs !== null) throw new Error(`speech gate response ${responseId} is already terminal`);
    response.terminalAtMs = receivedAtMs;
    response.terminalStatus = status;
    if (receivedAtMs - response.startedAtMs > this.policy.maxCollectionLatencyMs) {
      response.sealedReason = "collection_latency_exceeded";
      response.chunks = [];
    }
  }

  status(responseId: string): OutboundSpeechGateStatus {
    const decided = this.decisions.get(responseId);
    if (decided) {
      return Object.freeze({
        state: "finalized" as const,
        responseId,
        audioBytes: decided.audioBytes,
        audioDurationMs: decided.audioDurationMs,
      });
    }
    const response = this.requireResponse(responseId);
    return Object.freeze({
      state: response.sealedReason ? "sealed" as const : response.terminalAtMs !== null ? "terminal" as const : "collecting" as const,
      responseId,
      audioBytes: response.audioBytes,
      audioDurationMs: response.audioDurationMs,
      ...(response.sealedReason ? { sealedReason: response.sealedReason } : {}),
    });
  }

  /**
   * Deterministic watchdog hook for transports whose response stream stalls.
   * The caller should cancel the provider response, finalize this response, and
   * never enqueue its held bytes after this method seals it.
   */
  expireResponse(responseId: string, observedAtMs = this.now()): OutboundSpeechGateStatus {
    const response = this.requireResponse(responseId);
    assertTimestamp(observedAtMs, "observedAtMs");
    if (
      !response.finalized
      && response.terminalAtMs === null
      && observedAtMs - response.startedAtMs >= this.policy.maxCollectionLatencyMs
    ) {
      response.sealedReason = "collection_latency_exceeded";
      response.terminalAtMs = observedAtMs;
      response.terminalStatus = "interrupted";
      response.chunks = [];
    }
    return this.status(responseId);
  }

  async finalizeResponse(responseId: string): Promise<OutboundSpeechGateDecision> {
    const prior = this.decisions.get(responseId);
    if (prior) return prior;
    const response = this.requireResponse(responseId);
    if (response.finalized) throw new Error(`speech gate response ${responseId} finalization is already in progress`);
    if (response.terminalAtMs === null || response.terminalStatus === null) {
      throw new Error(`speech gate response ${responseId} is not terminal`);
    }
    response.finalized = true;
    const decisionStartedAtMs = this.now();
    let audioSha256: string | null = null;
    let providerTranscriptSha256: string | null = null;
    let independentAsrTranscriptSha256: string | null = null;
    let independentAsrReceiptSha256: string | null = null;
    let coverage: OutboundSpeechGateDecision["evidenceCoverage"] = "none";
    let reason: OutboundSpeechGateDecision["reason"] = "policy_pass";
    let action: OutboundSpeechGateAction = "release";
    const violations: OutboundSpeechViolation[] = [];
    let aggregate: Pcm16Audio | null = null;

    if (response.sealedReason) {
      reason = response.sealedReason;
      action = this.policy.onEvidenceFailure;
    } else if (response.terminalStatus !== "completed") {
      reason = "provider_terminal_not_completed";
      action = this.policy.onEvidenceFailure;
    } else if (!response.format || response.chunks.length === 0) {
      reason = "evidence_unavailable";
      action = this.policy.onEvidenceFailure;
    } else {
      aggregate = aggregateAudio(response);
      try {
        audioSha256 = await sha256Hex(aggregate.data);
        if (response.providerTranscriptFinal && response.providerTranscript !== null) {
          providerTranscriptSha256 = await sha256Hex(response.providerTranscript);
        }
      } catch {
        reason = "evidence_unavailable";
        action = this.policy.onEvidenceFailure;
      }

      const needsProvider = this.policy.evidencePolicy === "provider_transcript_allowed"
        || this.policy.evidencePolicy === "provider_and_independent_asr_required";
      const needsAsr = this.policy.evidencePolicy === "independent_asr_required"
        || this.policy.evidencePolicy === "provider_and_independent_asr_required";

      if (action === "release" && needsProvider && !response.providerTranscriptFinal) {
        reason = "evidence_unavailable";
        action = this.policy.onEvidenceFailure;
      }

      let asrText: string | null = null;
      if (action === "release" && needsAsr && aggregate && audioSha256) {
        if (!this.independentAsr) {
          reason = "evidence_unavailable";
          action = this.policy.onEvidenceFailure;
        } else {
          const deadlineAtMs = decisionStartedAtMs + this.policy.maxDecisionLatencyMs;
          try {
            const receipt = await this.withTimeout(
              this.independentAsr({
                responseId,
                provider: response.provider,
                audio: aggregate,
                audioSha256,
                audioBytes: response.audioBytes,
                audioDurationMs: response.audioDurationMs,
                deadlineAtMs,
              }),
              this.policy.maxDecisionLatencyMs,
            );
            if (!validAsrReceipt(receipt, aggregate, audioSha256)) {
              reason = "evidence_mismatch";
              action = this.policy.onEvidenceFailure;
            } else {
              asrText = receipt.text;
              independentAsrTranscriptSha256 = await sha256Hex(receipt.text);
              independentAsrReceiptSha256 = receipt.receiptSha256;
              coverage = "exact_buffered_pcm";
            }
          } catch (error) {
            reason = error instanceof SpeechGateTimeoutError ? "evidence_timeout" : "evidence_unavailable";
            action = this.policy.onEvidenceFailure;
          }
        }
      } else if (action === "release") {
        coverage = "provider_transcript_unbound";
      }

      if (action === "release") {
        if (response.providerTranscriptFinal && response.providerTranscript !== null) {
          violations.push(...this.evaluateText(response.providerTranscript, "provider_transcript"));
        }
        if (asrText !== null) violations.push(...this.evaluateText(asrText, "independent_asr"));
        const deduplicated = deduplicateViolations(violations);
        violations.splice(0, violations.length, ...deduplicated);
        if (violations.length > 0) {
          reason = "policy_violation";
          action = this.policy.onViolation;
        }
      }
    }

    const decisionLatencyMs = Math.max(0, this.now() - decisionStartedAtMs);
    if (decisionLatencyMs > this.policy.maxDecisionLatencyMs && action === "release") {
      reason = "evidence_timeout";
      action = this.policy.onEvidenceFailure;
      coverage = "none";
    }
    const decision: OutboundSpeechGateDecision = Object.freeze({
      schemaVersion: 1 as const,
      responseId,
      provider: response.provider,
      action,
      reason,
      evidenceCoverage: action === "release" ? coverage : "none",
      audioSha256,
      audioBytes: response.audioBytes,
      audioDurationMs: response.audioDurationMs,
      providerTranscriptSha256,
      independentAsrTranscriptSha256,
      independentAsrReceiptSha256,
      violations: Object.freeze(violations.map((violation) => Object.freeze({ ...violation }))),
      collectionLatencyMs: Math.max(0, response.terminalAtMs - response.startedAtMs),
      decisionLatencyMs,
      ...(action === "release" ? { audio: releaseCopies(response.chunks) } : {}),
    });
    response.chunks = [];
    this.responses.delete(responseId);
    this.decisions.set(responseId, decision);
    return decision;
  }

  private ensureCollecting(
    provider: ServerRealtimeProvider,
    responseId: string,
    receivedAtMs: number,
  ): HeldResponse {
    assertIdentity(responseId, "responseId");
    assertTimestamp(receivedAtMs, "receivedAtMs");
    let response = this.responses.get(responseId);
    if (!response) {
      if (this.decisions.has(responseId)) throw new Error(`speech gate response ${responseId} is finalized`);
      this.beginResponse(provider, responseId, receivedAtMs);
      response = this.responses.get(responseId)!;
    }
    if (response.provider !== provider) throw new Error(`speech gate provider changed for ${responseId}`);
    if (receivedAtMs < response.startedAtMs) {
      response.sealedReason = "invalid_audio_sequence";
    }
    return response;
  }

  private requireResponse(responseId: string): HeldResponse {
    const response = this.responses.get(responseId);
    if (!response) throw new Error(`unknown speech gate response: ${responseId}`);
    return response;
  }

  private evaluateText(
    text: string,
    source: OutboundSpeechViolation["source"],
  ): OutboundSpeechViolation[] {
    const normalized = normalizeSpeechText(text);
    const violations: OutboundSpeechViolation[] = [];
    for (const secret of this.policy.secrets) {
      const needle = normalizeSpeechText(secret.value);
      if (needle.length >= 4 && normalized.includes(needle)) {
        violations.push({
          code: "secret_echo",
          ruleId: secret.ruleId,
          secretFingerprintSha256: secret.fingerprintSha256,
          source,
        });
      }
    }
    if (!this.policy.terminalClaimsAuthorized) {
      for (const claim of this.policy.forbiddenTerminalClaims) {
        const needle = normalizeSpeechText(claim.phrase);
        if (needle && normalized.includes(needle)) {
          violations.push({ code: "forbidden_terminal_claim", ruleId: claim.ruleId, source });
        }
      }
    }
    return violations;
  }

  private withTimeout<Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      const timer = this.setTimer(() => reject(new SpeechGateTimeoutError()), timeoutMs);
      promise.then(
        (value) => {
          this.clearTimer(timer);
          resolve(value);
        },
        (error) => {
          this.clearTimer(timer);
          reject(error);
        },
      );
    });
  }
}

class SpeechGateTimeoutError extends Error {}

function validatePolicy(policy: OutboundSpeechGatePolicy): void {
  for (const [name, value] of [
    ["maxBufferedAudioBytes", policy.maxBufferedAudioBytes],
    ["maxBufferedAudioMs", policy.maxBufferedAudioMs],
    ["maxCollectionLatencyMs", policy.maxCollectionLatencyMs],
    ["maxDecisionLatencyMs", policy.maxDecisionLatencyMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SAFE_TIMEOUT_MS) {
      throw new Error(`${name} must be a positive safe integer no larger than ${MAX_SAFE_TIMEOUT_MS}`);
    }
  }
  const ruleIds = new Set<string>();
  for (const secret of policy.secrets) {
    assertRuleId(secret.ruleId);
    if (ruleIds.has(secret.ruleId)) throw new Error(`duplicate speech gate rule id: ${secret.ruleId}`);
    ruleIds.add(secret.ruleId);
    if (!SHA256.test(secret.fingerprintSha256)) throw new Error("secret fingerprint must be lowercase SHA-256");
    if (normalizeSpeechText(secret.value).length < 4) throw new Error("speech gate secrets must normalize to at least four characters");
  }
  for (const claim of policy.forbiddenTerminalClaims) {
    assertRuleId(claim.ruleId);
    if (ruleIds.has(claim.ruleId)) throw new Error(`duplicate speech gate rule id: ${claim.ruleId}`);
    ruleIds.add(claim.ruleId);
    if (!normalizeSpeechText(claim.phrase)) throw new Error("forbidden terminal claim cannot be empty");
  }
}

function aggregateAudio(response: HeldResponse): Pcm16Audio {
  const data = new Uint8Array(response.audioBytes);
  let offset = 0;
  for (const chunk of response.chunks) {
    data.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }
  return { ...response.format!, data };
}

function releaseCopies(chunks: readonly Pcm16Audio[]): readonly Pcm16Audio[] {
  return Object.freeze(chunks.map((chunk) => Object.freeze({
    encoding: chunk.encoding,
    sampleRateHz: chunk.sampleRateHz,
    channels: 1 as const,
    data: new Uint8Array(chunk.data),
  })));
}

function validAsrReceipt(
  receipt: IndependentSpeechAsrReceipt,
  audio: Pcm16Audio,
  audioSha256: string,
): boolean {
  return Boolean(
    receipt
    && receipt.complete === true
    && typeof receipt.text === "string"
    && receipt.audioSha256 === audioSha256
    && receipt.audioBytes === audio.data.byteLength
    && receipt.sampleRateHz === audio.sampleRateHz
    && receipt.channels === 1
    && typeof receipt.engine === "string"
    && receipt.engine.length > 0
    && SHA256.test(receipt.receiptSha256),
  );
}

function normalizeSpeechText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
}

function deduplicateViolations(violations: readonly OutboundSpeechViolation[]): OutboundSpeechViolation[] {
  const seen = new Set<string>();
  return violations.filter((violation) => {
    const key = `${violation.code}\0${violation.ruleId}\0${violation.secretFingerprintSha256 ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const source = typeof value === "string" ? new TextEncoder().encode(value) : value;
  // Copy into a plain ArrayBuffer: TypeScript correctly refuses to treat a
  // possibly SharedArrayBuffer-backed Uint8Array as WebCrypto BufferSource.
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertRuleId(value: string): void {
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(value)) throw new Error(`invalid speech gate rule id: ${value}`);
}

function assertIdentity(value: string, label: string): void {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid`);
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
}

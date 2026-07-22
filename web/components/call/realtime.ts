// Provider-neutral browser call orchestrator: auth/session fetch, recording, event persistence and transport lifecycle.

import type { BrowserRealtimeConnection } from "@/lib/realtime/types";
import {
  parseRecordingConsent,
  RECORDING_UPLOAD_TOKEN_PATTERN,
  type RecordingConsent,
} from "@/lib/recording-privacy";
import { createBrowserRealtimeTransport } from "./providers";
import {
  BoundedQueue,
  BROWSER_REALTIME_LIMITS,
  utf8Bytes,
  type BrowserOutboundSpeechGateConfig,
  type BrowserRealtimeTransport,
} from "./providers/types";

type Handlers = {
  onTranscript: (who: "caller" | "agent", text: string) => void;
  onState: (state: "connecting" | "live" | "ended" | "error") => void;
};

type FetchFailure = "timeout" | "deadline_exhausted" | "request_failed";
type FetchOutcome = { response: Response | null; failure: FetchFailure | null };
type FlushOutcome = "empty" | "persisted" | "failed";

const SHUTDOWN_NETWORK_BUDGET_MS = 10_000;
const NETWORK_REQUEST_TIMEOUT_MS = 3_000;
const LOCAL_OPERATION_TIMEOUT_MS = 2_000;
const TOOL_SHUTDOWN_DRAIN_MS = 1_500;
const MAX_SHUTDOWN_TOOL_IDENTITIES = 64;

class StartCancelledError extends Error {
  constructor() {
    super("realtime call start was cancelled");
    this.name = "StartCancelledError";
  }
}

async function fetchWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit,
  deadline?: number,
): Promise<FetchOutcome> {
  const remaining = deadline === undefined
    ? NETWORK_REQUEST_TIMEOUT_MS
    : Math.max(0, deadline - Date.now());
  if (remaining === 0) return { response: null, failure: "deadline_exhausted" };
  const timeoutMs = Math.min(NETWORK_REQUEST_TIMEOUT_MS, remaining);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const request = Promise.resolve()
    .then(() => fetch(input, { ...init, signal: controller.signal }))
    .then<FetchOutcome>((response) => ({ response, failure: null }))
    .catch<FetchOutcome>(() => ({ response: null, failure: "request_failed" }));
  const timedOut = new Promise<FetchOutcome>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ response: null, failure: "timeout" });
    }, timeoutMs);
  });
  const outcome = await Promise.race([request, timedOut]);
  if (timeout) clearTimeout(timeout);
  return outcome;
}

async function settleLocalOperation(operation: () => Promise<unknown>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const settled = Promise.resolve().then(operation).catch(() => undefined);
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, LOCAL_OPERATION_TIMEOUT_MS);
  });
  await Promise.race([settled, deadline]);
  if (timeout) clearTimeout(timeout);
}

export class RealtimeCall {
  private context: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private transport: BrowserRealtimeTransport | null = null;
  private recorder: MediaRecorder | null = null;
  private recordingMicSource: MediaStreamAudioSourceNode | null = null;
  private recordingConsent: RecordingConsent | null = null;
  private recordingUploadToken: string | null = null;
  private recordingChunks: Blob[] = [];
  private recordingBytes = 0;
  private recordingOverflow = false;
  private pendingEvents = new BoundedQueue<{ type: string; payload: unknown }>(
    BROWSER_REALTIME_LIMITS.pendingAuditEvents,
  );
  private reportedDroppedEvents = 0;
  private flushInFlight: Promise<FlushOutcome> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private sessionLimitTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private startAbortController: AbortController | null = null;
  private endPromise: Promise<FetchOutcome> | null = null;
  private endedReported = false;
  private providerClosed = false;
  private readonly persistenceLossStages = new Set<string>();
  callId = "";

  constructor(private handlers: Handlers) {}

  async start(agentId: string, opts: {
    flowId?: string | null;
    /** Must come from an affirmative user action after displaying the named notice. */
    recordingConsent?: RecordingConsent;
    /** Optional host-owned outbound speech quarantine; unsupported transports fail closed. */
    outboundSpeechGate?: BrowserOutboundSpeechGateConfig;
  } = {}): Promise<void> {
    if (this.callId || this.context || this.transport || this.stopPromise || this.stopping) {
      throw new Error("realtime call is already started or ended");
    }
    let acquiredTransport: BrowserRealtimeTransport | null = null;
    try {
      this.handlers.onState("connecting");
      if (this.stopping) throw new StartCancelledError();
      const startAbortController = new AbortController();
      this.startAbortController = startAbortController;
      this.recordingConsent = opts.recordingConsent === undefined
        ? null
        : parseRecordingConsent(opts.recordingConsent);
      if (opts.recordingConsent !== undefined && !this.recordingConsent) {
        throw new Error("recording consent is invalid or stale");
      }
      const response = await fetch("/api/voice/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: startAbortController.signal,
        body: JSON.stringify({
          agentId,
          ...(opts.flowId ? { flowId: opts.flowId } : {}),
          ...(this.recordingConsent ? { recordingConsent: this.recordingConsent } : {}),
        }),
      });
      const payload = await response.json() as {
        error?: string;
        callId?: string;
        connection?: BrowserRealtimeConnection;
        recordingUploadToken?: string;
      };
      if (!response.ok || !payload.callId || !payload.connection) throw new Error(payload.error ?? "voice session failed");
      // Retain the allocated server identity before validating optional capabilities so every
      // post-allocation contract failure can close the call instead of orphaning it.
      this.callId = payload.callId;
      if (this.recordingConsent) {
        if (typeof payload.recordingUploadToken !== "string"
          || !RECORDING_UPLOAD_TOKEN_PATTERN.test(payload.recordingUploadToken)) {
          throw new Error("voice session omitted its recording upload capability");
        }
        this.recordingUploadToken = payload.recordingUploadToken;
      } else if (payload.recordingUploadToken !== undefined) {
        throw new Error("voice session issued an unexpected recording upload capability");
      }
      this.assertStartActive(startAbortController);

      this.context = new AudioContext({ sampleRate: 24000 });
      await this.context.resume();
      this.assertStartActive(startAbortController);
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      this.assertStartActive(startAbortController);

      let recordingDestination: MediaStreamAudioDestinationNode | undefined;
      if (this.recordingConsent) {
        recordingDestination = this.context.createMediaStreamDestination();
        this.recordingMicSource = this.context.createMediaStreamSource(this.mic);
        this.recordingMicSource.connect(recordingDestination);
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";
        this.recorder = new MediaRecorder(recordingDestination.stream, { mimeType });
        this.recordingChunks = [];
        this.recordingBytes = 0;
        this.recordingOverflow = false;
        this.recorder.ondataavailable = (event) => {
          if (!event.data.size || this.recordingOverflow) return;
          if (this.recordingBytes + event.data.size > BROWSER_REALTIME_LIMITS.recordingBytes) {
            this.recordingOverflow = true;
            this.recordingChunks = [];
            this.recordingBytes = 0;
            this.queueEvent("recording_discarded", { reason: "browser_size_limit" });
            try {
              if (this.recorder?.state === "recording") this.recorder.stop();
            } catch { /* recorder is already stopping */ }
            return;
          }
          this.recordingBytes += event.data.size;
          this.recordingChunks.push(event.data);
        };
        this.recorder.start(1000);
      }

      acquiredTransport = createBrowserRealtimeTransport(payload.connection);
      this.transport = acquiredTransport;
      await acquiredTransport.start({
        connection: payload.connection,
        mic: this.mic,
        audioContext: this.context,
        recordingDestination,
        ...(opts.outboundSpeechGate ? {
          outboundSpeechGate: {
            ...opts.outboundSpeechGate,
            onEvidence: (evidence) => {
              this.queueEvent("outbound_speech_gate", evidence);
              opts.outboundSpeechGate!.onEvidence(evidence);
            },
          },
        } : {}),
        handlers: {
          onTranscript: (who, text) => {
            if (!text.trim()) return;
            this.handlers.onTranscript(who, text);
            this.queueEvent(who === "caller" ? "user_said" : "agent_said", { text });
          },
          onError: () => {
            // Error text remains an ephemeral implementation detail. Persist only the stable,
            // content-free code; the API independently rebuilds this payload before storage.
            this.queueEvent("error", {
              code: "provider_runtime_error",
              provider: payload.connection!.provider,
            });
            this.handlers.onState("error");
          },
          onClose: () => {
            if (this.stopping) return;
            this.providerClosed = true;
            this.queueEvent("state", { state: "provider_closed", provider: payload.connection!.provider });
            void this.stop();
          },
        },
      });
      this.assertStartActive(startAbortController);
      this.flushTimer = setInterval(() => void this.flushEvents(), 1500);
      if (payload.connection.provider === "gemini") {
        this.sessionLimitTimer = setTimeout(() => {
          this.queueEvent("state", { state: "session_limit", provider: "gemini", limitMinutes: 15 });
          void this.stop();
        }, BROWSER_REALTIME_LIMITS.geminiAudioOnlySessionMs);
      }
      this.queueEvent("state", {
        state: "connected",
        provider: payload.connection.provider,
        model: payload.connection.model,
      });
      this.startAbortController = null;
      this.handlers.onState("live");
    } catch (error) {
      const cancelled = this.stopping || error instanceof StartCancelledError;
      const activeStop = this.stopPromise;
      const acquiredTransportIsOwned = acquiredTransport !== null && this.transport === acquiredTransport;
      this.stopping = true;
      this.startAbortController?.abort();
      this.startAbortController = null;
      if (!cancelled) this.handlers.onState("error");
      // An active stop owns recorder finalization; racing it here could discard an opted-in recording.
      if (!cancelled) await this.discardRecording();
      await this.cleanupMedia();
      if (acquiredTransport && !acquiredTransportIsOwned) {
        await settleLocalOperation(() => acquiredTransport!.stop());
      }
      if (activeStop) await activeStop;
      // A token response can arrive after stop completed without yet knowing the server call id.
      await this.endServerCall(Date.now() + NETWORK_REQUEST_TIMEOUT_MS);
      if (!this.stopPromise) this.stopPromise = Promise.resolve();
      if (cancelled && !(error instanceof StartCancelledError)) throw new StartCancelledError();
      throw error;
    }
  }

  private assertStartActive(controller: AbortController) {
    if (this.stopping || this.startAbortController !== controller || controller.signal.aborted) {
      throw new StartCancelledError();
    }
  }

  private queueEvent(type: string, payload: unknown) {
    if (!/^[a-z][a-z0-9_.-]{0,39}$/.test(type)) return;
    let encoded: string;
    try { encoded = JSON.stringify(payload ?? {}); } catch { return; }
    if (utf8Bytes(encoded) > 64 * 1024) return;
    this.pendingEvents.push({ type, payload: payload ?? {} });
  }

  private notePersistenceLoss(stage: string, reason: FetchFailure | "http_error") {
    if (this.persistenceLossStages.has(stage)) return;
    this.persistenceLossStages.add(stage);
    this.queueEvent("client_persistence_loss", {
      stage,
      reason,
      pendingEvents: this.pendingEvents.length,
    });
  }

  private async flushEvents(deadline?: number): Promise<FlushOutcome> {
    if (this.flushInFlight) return this.flushInFlight;
    this.flushInFlight = this.performFlush(deadline).finally(() => { this.flushInFlight = null; });
    return this.flushInFlight;
  }

  private async performFlush(deadline?: number): Promise<FlushOutcome> {
    if (!this.pendingEvents.length || !this.callId) return "empty";
    const newDrops = this.pendingEvents.droppedCount - this.reportedDroppedEvents;
    const batch = this.pendingEvents.drain(newDrops > 0 ? 49 : 50);
    if (newDrops > 0) {
      batch.unshift({ type: "client_event_overflow", payload: { dropped: newDrops } });
    }
    const outcome = await fetchWithDeadline(`/api/calls/${this.callId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
    }, deadline);
    if (!outcome.response?.ok) {
      this.pendingEvents.prepend(batch);
      this.notePersistenceLoss("events", outcome.failure ?? "http_error");
      return "failed";
    }
    this.reportedDroppedEvents = this.pendingEvents.droppedCount;
    return "persisted";
  }

  private async flushAllEvents(deadline?: number): Promise<boolean> {
    // The queue is capped at 500 and the endpoint accepts 50 events per batch.
    // Retry one failed batch so a transient outage can persist its explicit loss marker.
    const maximumBatches = Math.ceil(BROWSER_REALTIME_LIMITS.pendingAuditEvents / 50) + 2;
    let failedBatchRetryAvailable = true;
    for (let batch = 0; batch < maximumBatches && this.pendingEvents.length > 0; batch += 1) {
      const outcome = await this.flushEvents(deadline);
      if (outcome !== "failed") continue;
      if (!failedBatchRetryAvailable) break;
      failedBatchRetryAvailable = false;
    }
    return this.pendingEvents.length === 0;
  }

  private async reconcileProviderCloseToolCalls(): Promise<{
    mayTerminalize: boolean;
    hadUnresolved: boolean;
  }> {
    const transport = this.transport;
    if (!this.providerClosed || !transport?.drainToolCalls) {
      return { mayTerminalize: true, hadUnresolved: false };
    }
    let result: Awaited<ReturnType<NonNullable<typeof transport.drainToolCalls>>>;
    try {
      result = await transport.drainToolCalls(TOOL_SHUTDOWN_DRAIN_MS);
    } catch {
      this.queueEvent("tool_gateway_shutdown_reconciliation", {
        status: "unresolved",
        reason: "drain_failed",
        doNotRedispatch: true,
      });
      return { mayTerminalize: false, hadUnresolved: false };
    }
    if (!result || !Array.isArray(result.settledNativeCallIds)
      || !Array.isArray(result.unresolvedNativeCallIds)) {
      this.queueEvent("tool_gateway_shutdown_reconciliation", {
        status: "unresolved",
        reason: "invalid_drain_report",
        doNotRedispatch: true,
      });
      return { mayTerminalize: false, hadUnresolved: false };
    }
    const settled = [...result.settledNativeCallIds];
    const unresolved = [...result.unresolvedNativeCallIds];
    const identities = [...settled, ...unresolved];
    if (identities.length > MAX_SHUTDOWN_TOOL_IDENTITIES
      || new Set(identities).size !== identities.length
      || identities.some((identity) => typeof identity !== "string" || !identity
        || utf8Bytes(identity) > 256 || /[\u0000-\u001f\u007f]/.test(identity))) {
      this.queueEvent("tool_gateway_shutdown_reconciliation", {
        status: "unresolved",
        reason: "invalid_drain_report",
        doNotRedispatch: true,
      });
      return { mayTerminalize: false, hadUnresolved: false };
    }
    for (const nativeCallId of settled) {
      this.queueEvent("tool_gateway_shutdown_reconciliation", {
        status: "settled",
        nativeCallId,
        exactReceiptRecovered: true,
        doNotRedispatch: true,
      });
    }
    for (const nativeCallId of unresolved) {
      this.queueEvent("tool_gateway_shutdown_reconciliation", {
        status: "unresolved",
        nativeCallId,
        exactReceiptRecovered: false,
        doNotRedispatch: true,
      });
    }
    return { mayTerminalize: unresolved.length === 0, hadUnresolved: unresolved.length > 0 };
  }

  private async stopRecorder(recorder: MediaRecorder): Promise<void> {
    if (recorder.state === "inactive") return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        recorder.removeEventListener("stop", finish);
        recorder.removeEventListener("error", finish);
        resolve();
      };
      const timeout = setTimeout(finish, 2_000);
      recorder.addEventListener("stop", finish, { once: true });
      recorder.addEventListener("error", finish, { once: true });
      try { recorder.stop(); } catch { finish(); }
    });
  }

  private async prepareRecordingUpload(): Promise<{
    blob: Blob;
    consent: RecordingConsent;
    uploadToken: string;
  } | null> {
    const recorder = this.recorder;
    const consent = this.recordingConsent;
    const uploadToken = this.recordingUploadToken;
    if (!recorder || !consent || !uploadToken) return null;
    await this.stopRecorder(recorder);
    this.recorder = null;
    if (this.recordingOverflow) return null;
    const blob = new Blob(this.recordingChunks, { type: recorder.mimeType || "audio/webm" });
    this.recordingChunks = [];
    this.recordingBytes = 0;
    if (blob.size <= 4096 || blob.size > BROWSER_REALTIME_LIMITS.recordingBytes || !this.callId) return null;
    return { blob, consent, uploadToken };
  }

  private async uploadRecording(
    pending: { blob: Blob; consent: RecordingConsent; uploadToken: string } | null,
    deadline: number,
  ) {
    if (!pending || !this.callId) return;
    const outcome = await fetchWithDeadline(`/api/calls/${this.callId}/recording`, {
        method: "POST",
        headers: {
          "Content-Type": pending.blob.type,
          "X-Recording-Consent-Id": pending.consent.consentId,
          "X-Recording-Upload-Token": pending.uploadToken,
        },
        body: pending.blob,
      }, deadline);
    if (!outcome.response?.ok) {
      this.queueEvent("recording_upload_failed", { status: outcome.response?.status ?? 0 });
      this.notePersistenceLoss("recording", outcome.failure ?? "http_error");
    }
  }

  private async discardRecording() {
    const recorder = this.recorder;
    if (recorder) await this.stopRecorder(recorder);
    this.recordingChunks = [];
    this.recordingBytes = 0;
    this.recordingOverflow = false;
    this.recorder = null;
    this.recordingUploadToken = null;
  }

  private async cleanupMedia() {
    const transport = this.transport;
    this.transport = null;
    this.recordingMicSource?.disconnect();
    this.recordingMicSource = null;
    this.mic?.getTracks().forEach((track) => {
      try { track.stop(); } catch { /* track is already stopped */ }
    });
    this.mic = null;
    const context = this.context;
    this.context = null;
    await Promise.all([
      transport ? settleLocalOperation(() => transport.stop()) : Promise.resolve(),
      context ? settleLocalOperation(() => context.close()) : Promise.resolve(),
    ]);
  }

  private endServerCall(deadline: number): Promise<FetchOutcome> {
    if (!this.callId) return Promise.resolve({ response: null, failure: null });
    if (!this.endPromise) {
      this.endPromise = fetchWithDeadline(`/api/calls/${this.callId}/end`, { method: "POST" }, deadline);
    }
    return this.endPromise;
  }

  private reportEnded() {
    if (this.endedReported) return;
    this.endedReported = true;
    this.handlers.onState("ended");
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.startAbortController?.abort();
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.sessionLimitTimer) clearTimeout(this.sessionLimitTimer);
    this.sessionLimitTimer = null;
    let pendingRecording: { blob: Blob; consent: RecordingConsent; uploadToken: string } | null = null;
    try {
      pendingRecording = await this.prepareRecordingUpload();
    } catch {
      this.notePersistenceLoss("recording", "request_failed");
    }

    const reconciliation = await this.reconcileProviderCloseToolCalls();
    // The provider-close drain is bounded above; local privacy/resource teardown
    // follows before any recording, audit, or terminalization network I/O.
    await this.cleanupMedia();
    const deadline = Date.now() + SHUTDOWN_NETWORK_BUDGET_MS;
    try {
      await this.uploadRecording(pendingRecording, deadline);
      let endOutcome: FetchOutcome;
      if (this.providerClosed) {
        const eventsPersisted = await this.flushAllEvents(deadline);
        const mayTerminalize = reconciliation.mayTerminalize
          || (reconciliation.hadUnresolved && eventsPersisted);
        endOutcome = mayTerminalize
          ? await this.endServerCall(deadline)
          : { response: null, failure: "request_failed" };
      } else {
        [, endOutcome] = await Promise.all([
          this.flushAllEvents(deadline),
          this.endServerCall(deadline),
        ]);
      }
      if (endOutcome.failure || (endOutcome.response && !endOutcome.response.ok)) {
        this.notePersistenceLoss("call_end", endOutcome.failure ?? "http_error");
        await this.flushAllEvents(deadline);
      }
    } finally {
      // A second pass catches resources acquired just before an awaited start checkpoint observed stop.
      await this.cleanupMedia();
      this.recorder = null;
      this.recordingConsent = null;
      this.recordingUploadToken = null;
      this.reportEnded();
    }
  }
}

// Provider-neutral browser call orchestrator: auth/session fetch, recording, event persistence and transport lifecycle.

import type { BrowserRealtimeConnection } from "@/lib/realtime/types";
import { createBrowserRealtimeTransport } from "./providers";
import type { BrowserRealtimeTransport } from "./providers/types";

type Handlers = {
  onTranscript: (who: "caller" | "agent", text: string) => void;
  onState: (state: "connecting" | "live" | "ended" | "error") => void;
};

export class RealtimeCall {
  private context: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private transport: BrowserRealtimeTransport | null = null;
  private recorder: MediaRecorder | null = null;
  private recordingChunks: Blob[] = [];
  private pendingEvents: { type: string; payload: unknown }[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  callId = "";

  constructor(private handlers: Handlers) {}

  async start(agentId: string, opts: { flowId?: string | null } = {}): Promise<void> {
    this.handlers.onState("connecting");
    try {
      const response = await fetch("/api/voice/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, ...(opts.flowId ? { flowId: opts.flowId } : {}) }),
      });
      const payload = await response.json() as { error?: string; callId?: string; connection?: BrowserRealtimeConnection };
      if (!response.ok || !payload.callId || !payload.connection) throw new Error(payload.error ?? "voice session failed");
      this.callId = payload.callId;

      this.context = new AudioContext({ sampleRate: 24000 });
      await this.context.resume();
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });

      const recordingDestination = this.context.createMediaStreamDestination();
      this.context.createMediaStreamSource(this.mic).connect(recordingDestination);
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      this.recorder = new MediaRecorder(recordingDestination.stream, { mimeType });
      this.recorder.ondataavailable = (event) => { if (event.data.size) this.recordingChunks.push(event.data); };
      this.recorder.start(1000);

      this.transport = createBrowserRealtimeTransport(payload.connection);
      await this.transport.start({
        connection: payload.connection,
        mic: this.mic,
        audioContext: this.context,
        recordingDestination,
        handlers: {
          onTranscript: (who, text) => {
            if (!text.trim()) return;
            this.handlers.onTranscript(who, text);
            this.queueEvent(who === "caller" ? "user_said" : "agent_said", { text });
          },
          onError: (error) => {
            this.queueEvent("error", { message: error.message, provider: payload.connection!.provider });
            this.handlers.onState("error");
          },
          onClose: () => { if (!this.stopping) this.handlers.onState("ended"); },
        },
      });
      this.flushTimer = setInterval(() => void this.flushEvents(), 1500);
      this.queueEvent("state", {
        state: "connected",
        provider: payload.connection.provider,
        model: payload.connection.model,
      });
      this.handlers.onState("live");
    } catch (error) {
      this.handlers.onState("error");
      await this.cleanupMedia();
      throw error;
    }
  }

  private queueEvent(type: string, payload: unknown) {
    this.pendingEvents.push({ type, payload });
  }

  private async flushEvents() {
    if (!this.pendingEvents.length || !this.callId) return;
    const batch = this.pendingEvents.splice(0, 50);
    const response = await fetch(`/api/calls/${this.callId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
    }).catch(() => null);
    if (!response?.ok) this.pendingEvents.unshift(...batch);
  }

  private async finishRecording() {
    if (!this.recorder || this.recorder.state === "inactive") return;
    await new Promise<void>((resolve) => {
      this.recorder!.onstop = () => resolve();
      this.recorder!.stop();
    });
    const blob = new Blob(this.recordingChunks, { type: this.recorder.mimeType || "audio/webm" });
    if (blob.size > 4096 && this.callId) {
      await fetch(`/api/calls/${this.callId}/recording`, {
        method: "POST",
        headers: { "Content-Type": blob.type },
        body: blob,
      }).catch(() => {});
    }
  }

  private async cleanupMedia() {
    await this.transport?.stop().catch(() => {});
    this.transport = null;
    this.mic?.getTracks().forEach((track) => track.stop());
    this.mic = null;
    await this.context?.close().catch(() => {});
    this.context = null;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    await this.transport?.stop().catch(() => {});
    await this.flushEvents();
    await this.finishRecording();
    if (this.callId) await fetch(`/api/calls/${this.callId}/end`, { method: "POST" }).catch(() => {});
    await this.cleanupMedia();
    this.handlers.onState("ended");
  }
}

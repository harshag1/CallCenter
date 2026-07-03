// Author: Harsha Gundala
// realtime.ts — browser client for xAI realtime voice: mic PCM out, audio playback, transcripts, recording.

type Handlers = {
  onTranscript: (who: "caller" | "agent", text: string) => void;
  onState: (state: "connecting" | "live" | "ended" | "error") => void;
};

const RATE = 24000;

export class RealtimeCall {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private playhead = 0;
  private scheduled: AudioBufferSourceNode[] = [];
  private recorder: MediaRecorder | null = null;
  private recChunks: Blob[] = [];
  private pendingEvents: { type: string; payload: unknown }[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  callId = "";

  constructor(private handlers: Handlers) {}

  async start(agentId: string, opts: { flowId?: string | null } = {}): Promise<void> {
    this.handlers.onState("connecting");
    const res = await fetch("/api/voice/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, ...(opts.flowId ? { flowId: opts.flowId } : {}) }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "token failed");
    const { token, callId, sessionUpdate, wsUrl } = await res.json();
    this.callId = callId;

    this.ctx = new AudioContext({ sampleRate: RATE });
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });

    // Mixed-recording graph: mic + agent audio both feed a MediaRecorder.
    const recDest = this.ctx.createMediaStreamDestination();
    const micSource = this.ctx.createMediaStreamSource(this.mic);
    micSource.connect(recDest);
    this.recorder = new MediaRecorder(recDest.stream, { mimeType: "audio/webm" });
    this.recorder.ondataavailable = (e) => e.data.size && this.recChunks.push(e.data);
    this.recorder.start(1000);
    (this as unknown as { recDest: MediaStreamAudioDestinationNode }).recDest = recDest;

    this.ws = new WebSocket(wsUrl, ["realtime", `xai-client-secret.${token}`]);
    this.ws.onopen = () => {
      this.ws!.send(JSON.stringify(sessionUpdate));
      this.startMicPump(micSource);
      this.handlers.onState("live");
      this.queueEvent("state", { state: "connected" });
    };
    this.ws.onmessage = (m) => this.handleServerEvent(JSON.parse(m.data));
    this.ws.onerror = () => this.handlers.onState("error");
    this.ws.onclose = () => this.handlers.onState("ended");
    this.flushTimer = setInterval(() => this.flushEvents(), 1500);
  }

  private startMicPump(source: MediaStreamAudioSourceNode) {
    const proc = this.ctx!.createScriptProcessor(2048, 1, 1);
    source.connect(proc);
    const mute = this.ctx!.createGain();
    mute.gain.value = 0;
    proc.connect(mute).connect(this.ctx!.destination);
    proc.onaudioprocess = (e) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32768));
      const b64 = btoa(String.fromCharCode(...new Uint8Array(i16.buffer)));
      this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
    };
  }

  private handleServerEvent(ev: { type: string; [k: string]: unknown }) {
    const t = ev.type;
    if (t === "response.output_audio.delta" || t === "response.audio.delta") {
      this.playChunk(String(ev.delta));
    } else if (t === "input_audio_buffer.speech_started") {
      this.scheduled.forEach((s) => { try { s.stop(); } catch {} });
      this.scheduled = [];
      this.playhead = this.ctx?.currentTime ?? 0;
    } else if (t === "conversation.item.input_audio_transcription.completed") {
      this.handlers.onTranscript("caller", String(ev.transcript ?? ""));
      this.queueEvent("user_said", { text: ev.transcript });
    } else if (t === "response.output_audio_transcript.done" || t === "response.audio_transcript.done") {
      this.handlers.onTranscript("agent", String(ev.transcript ?? ""));
      this.queueEvent("agent_said", { text: ev.transcript });
    } else if (t === "error") {
      this.queueEvent("error", ev);
    }
  }

  private playChunk(b64: string) {
    if (!this.ctx) return;
    const bin = atob(b64);
    const i16 = new Int16Array(new Uint8Array([...bin].map((c) => c.charCodeAt(0))).buffer);
    const f32 = Float32Array.from(i16, (v) => v / 32768);
    const buf = this.ctx.createBuffer(1, f32.length, RATE);
    buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.connect((this as unknown as { recDest: MediaStreamAudioDestinationNode }).recDest);
    this.playhead = Math.max(this.playhead, this.ctx.currentTime + 0.05);
    src.start(this.playhead);
    this.playhead += buf.duration;
    this.scheduled.push(src);
    src.onended = () => { this.scheduled = this.scheduled.filter((s) => s !== src); };
  }

  private queueEvent(type: string, payload: unknown) {
    this.pendingEvents.push({ type, payload });
  }

  private async flushEvents() {
    if (!this.pendingEvents.length || !this.callId) return;
    const batch = this.pendingEvents.splice(0, 50);
    await fetch(`/api/calls/${this.callId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
    }).catch(() => {});
  }

  async stop(): Promise<void> {
    this.ws?.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flushEvents();

    if (this.recorder && this.recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        this.recorder!.onstop = () => resolve();
        this.recorder!.stop();
      });
      const blob = new Blob(this.recChunks, { type: "audio/webm" });
      if (blob.size > 4096) {
        await fetch(`/api/calls/${this.callId}/recording`, {
          method: "POST",
          headers: { "Content-Type": "audio/webm" },
          body: blob,
        }).catch(() => {});
      }
    }
    await fetch(`/api/calls/${this.callId}/end`, { method: "POST" }).catch(() => {});
    await this.ctx?.close().catch(() => {});
    this.handlers.onState("ended");
  }
}

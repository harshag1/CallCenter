// Author: Harsha Gundala
// bridge.ts — Twilio Media Streams ↔ OpenAI-compatible realtime providers: μ-law passthrough, mixed recording,
// turn-boundary events, hold-music playback, and observe mode (human-transfer transcription).

import WebSocket from "ws";
import { q, qOne } from "./db";
import { verifyScope, loadActiveAgent, voiceSessionSpecForCall } from "./voice";
import { createServerRealtimeConnection } from "./realtime/registry";
import { mixUlaw } from "./audio";
import { transcribeUlaw } from "./stt";
import { log } from "./log";

const L = log("bridge");
const FRAME = 160; // 20ms of 8kHz μ-law
const REC_FLUSH_MS = 5000;
const HOLD_POLL_MS = 2000;
const STT_FLUSH_MS = 6000;
const STT_MIN_BYTES = 8000; // ≥1s of audio before a Whisper round-trip
const EMPTY = Buffer.alloc(0);

/** Minimal socket surface shared by `ws` and @vercel/functions' upgraded socket. */
export type BridgeSocket = {
  send: (data: string) => void;
  close: () => void;
  on: (event: "message" | "close" | "error", cb: (data?: unknown) => void) => void;
};

type TwilioMessage = {
  event: string;
  start?: { streamSid: string; customParameters?: Record<string, string> };
  media?: { track?: string; payload: string };
};

type Scope = { callId: string; agentId: string; orgId: string };

export class BridgeSession {
  private providerSocket: WebSocket | null = null;
  private streamSid: string | null = null;
  private callId: string | null = null;
  private mode: "agent" | "observe" = "agent";
  private done = false;

  // Recording: caller frames are the 20ms clock; far-side audio queues and drains at that pace,
  // mirroring what Twilio actually plays out (a `clear` drops the queue like Twilio drops its buffer).
  private recChunks: Buffer[] = [];
  private farQueue: Buffer = EMPTY;
  private recFlush: ReturnType<typeof setInterval> | null = null;
  private recPathSet = false;

  // Turn boundaries.
  private agentSpoke = false;

  // Hold music.
  private holdClip: Buffer | null = null;
  private holding = false;
  private holdPos = 0;
  private holdPacer: ReturnType<typeof setInterval> | null = null;
  private holdDeadline: ReturnType<typeof setTimeout> | null = null;
  private holdPoll: ReturnType<typeof setInterval> | null = null;
  private lastHoldEventId = 0;

  // Observe mode (post-transfer human leg).
  private sttBuf: Record<"inbound" | "outbound", Buffer> = { inbound: EMPTY, outbound: EMPTY };
  private sttTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private twilio: BridgeSocket) {
    twilio.on("message", (data) => {
      try {
        this.onTwilio(JSON.parse(String(data)) as TwilioMessage);
      } catch { /* ignore non-JSON frames */ }
    });
    twilio.on("close", () => void this.teardown());
    twilio.on("error", () => void this.teardown());
  }

  private async onTwilio(msg: TwilioMessage) {
    switch (msg.event) {
      case "start": {
        this.streamSid = msg.start!.streamSid;
        const params = msg.start!.customParameters ?? {};
        this.mode = params.mode === "observe" ? "observe" : "agent";
        try {
          await this.begin(params.scope ?? "");
        } catch (e) {
          L.error("bridge connect failed", { err: (e as Error).message });
          this.twilio.close();
        }
        break;
      }
      case "media": {
        const ulaw = Buffer.from(msg.media!.payload, "base64");
        if (this.mode === "observe") {
          this.onObserveFrame(msg.media!.track === "outbound" ? "outbound" : "inbound", ulaw);
        } else {
          this.recordCallerFrame(ulaw);
          if (this.providerSocket?.readyState === WebSocket.OPEN) {
            this.providerSocket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media!.payload }));
          }
        }
        break;
      }
      case "stop":
        void this.teardown();
        break;
    }
  }

  private async begin(scopeToken: string) {
    const scope = verifyScope(scopeToken);
    if (!scope) throw new Error("invalid scope");
    this.callId = scope.callId;

    const head = await qOne<{ max: string }>(
      "SELECT COALESCE(MAX(id),0)::text AS max FROM call_events WHERE call_id = $1", [scope.callId]
    );
    this.lastHoldEventId = Number(head?.max ?? 0);

    // An observe leg (post-transfer) continues the original call's recording, so keep the
    // timeline origin stable: only the first stream on a call emits audio_start.
    await q(
      `INSERT INTO call_events (call_id, type, payload)
       SELECT $1, 'audio_start', $2::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM call_events WHERE call_id = $1 AND type = 'audio_start')`,
      [scope.callId, JSON.stringify({ at: new Date().toISOString() })]
    ).catch(() => {});
    this.recFlush = setInterval(() => void this.flushRecording(), REC_FLUSH_MS);

    if (this.mode === "observe") {
      this.sttTimer = setInterval(() => void this.flushStt(), STT_FLUSH_MS);
      return;
    }

    void this.loadHoldClip(scope.orgId);
    this.holdPoll = setInterval(() => void this.pollHold(), HOLD_POLL_MS);
    void this.armOutboundGuard(scope.callId);
    await this.connectProvider(scope);
  }

  private async connectProvider(scope: Scope) {
    const [agent, call] = await Promise.all([
      loadActiveAgent(scope.agentId, scope.orgId),
      q<{ direction: "inbound" | "outbound"; metadata: { reason?: string } }>(
        "SELECT direction, metadata FROM calls WHERE id = $1", [scope.callId]
      ).then((r) => r[0]),
    ]);
    if (!agent || !call) throw new Error("call or agent missing");

    const origin = process.env.PUBLIC_ORIGIN!;
    const sessionSpec = await voiceSessionSpecForCall(agent, scope.callId, call.direction, origin);
    if (call.direction === "outbound" && call.metadata?.reason) {
      sessionSpec.instructions +=
        `\n\nYou are placing this outbound call. Purpose: ${call.metadata.reason}. Open by introducing yourself and the reason for the call.`;
    }
    const connection = await createServerRealtimeConnection(sessionSpec, "pcmu");

    this.providerSocket = new WebSocket(connection.wsUrl, { headers: connection.headers });
    this.providerSocket.on("open", () => {
      this.providerSocket!.send(JSON.stringify(connection.sessionUpdate));
      this.providerSocket!.send(JSON.stringify({ type: "response.create" }));
      void this.save("state", { state: "bridged", provider: connection.provider, model: connection.model });
    });
    this.providerSocket.on("message", (raw) => this.onProviderEvent(JSON.parse(String(raw))));
    this.providerSocket.on("close", () => void this.teardown());
    this.providerSocket.on("error", (e) => {
      L.error("realtime provider ws error", { callId: this.callId ?? undefined, err: (e as Error).message });
      void this.teardown();
    });
  }

  private onProviderEvent(ev: { type: string; delta?: string; transcript?: string }) {
    switch (ev.type) {
      case "response.output_audio.delta":
      case "response.audio.delta": {
        if (!this.agentSpoke) {
          this.agentSpoke = true;
          void this.save("speech", { who: "agent", at: new Date().toISOString() });
        }
        if (this.holding) break; // hold music owns the line
        this.farQueue = Buffer.concat([this.farQueue, Buffer.from(String(ev.delta), "base64")]);
        this.sendTwilio({ event: "media", streamSid: this.streamSid, media: { payload: ev.delta } });
        break;
      }
      case "response.done":
      case "response.completed":
        this.agentSpoke = false;
        break;
      case "input_audio_buffer.speech_started":
        this.agentSpoke = false;
        this.farQueue = EMPTY; // mirror Twilio's buffer flush
        void this.save("speech", { who: "caller", at: new Date().toISOString() });
        this.sendTwilio({ event: "clear", streamSid: this.streamSid }); // barge-in
        break;
      case "conversation.item.input_audio_transcription.completed": {
        // Some providers re-emit completed transcriptions as an item grows — keep one event per utterance.
        const text = String(ev.transcript ?? "");
        if (this.lastUserSaid && (text.startsWith(this.lastUserSaid) || this.lastUserSaid.startsWith(text))) {
          void this.updateLastUserSaid(text);
        } else {
          void this.saveUserSaid(text);
        }
        break;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        void this.save("agent_said", { text: ev.transcript });
        break;
      case "error":
        void this.save("error", ev);
        break;
    }
  }

  // ---- recording -----------------------------------------------------------

  /** Mixes one caller frame with far-side audio dequeued at line rate. */
  private recordCallerFrame(ulaw: Buffer) {
    const take = this.farQueue.subarray(0, ulaw.length);
    this.farQueue = this.farQueue.subarray(take.length);
    this.recChunks.push(take.length ? mixUlaw(ulaw, take) : ulaw);
  }

  private async flushRecording() {
    if (!this.callId || !this.recChunks.length) return;
    const chunk = Buffer.concat(this.recChunks.splice(0));
    await q(
      `INSERT INTO call_recordings (call_id, mime, data) VALUES ($1,'audio/basic;rate=8000',$2)
       ON CONFLICT (call_id) DO UPDATE SET data = call_recordings.data || EXCLUDED.data, mime = EXCLUDED.mime`,
      [this.callId, chunk]
    ).catch(() => {});
    if (!this.recPathSet) {
      this.recPathSet = true;
      void q("UPDATE calls SET recording_path = $2 WHERE id = $1 AND recording_path IS NULL", [
        this.callId, `db:${this.callId}`,
      ]).catch(() => {});
    }
  }

  // ---- hold music ----------------------------------------------------------

  private async loadHoldClip(orgId: string) {
    const row = await qOne<{ data: Buffer }>(
      `SELECT r.data FROM media_renditions r
       JOIN documents d ON d.id = r.document_id
       WHERE d.org_id = $1 AND r.kind = 'ulaw8k' AND d.meta->>'hold_music' = 'true'
       ORDER BY d.created_at DESC LIMIT 1`,
      [orgId]
    ).catch(() => null);
    if (row?.data?.length) this.holdClip = row.data;
  }

  /** DB poll for hold_start/hold_end markers inserted by the MCP hold tool. Runs only while connected. */
  private async pollHold() {
    if (!this.callId || this.done) return;
    const rows = await q<{ id: string; type: string; payload: { seconds?: number } }>(
      `SELECT id, type, payload FROM call_events
       WHERE call_id = $1 AND type IN ('hold_start','hold_end') AND id > $2 ORDER BY id ASC`,
      [this.callId, this.lastHoldEventId]
    ).catch(() => []);
    for (const r of rows) {
      this.lastHoldEventId = Number(r.id);
      if (r.type === "hold_start") this.startHold(Number(r.payload?.seconds) || 20);
      else this.endHold();
    }
  }

  private startHold(seconds: number) {
    if (this.holding || this.done) return;
    this.holding = true;
    this.holdPos = 0;
    const clip = this.holdClip;
    if (clip?.length) {
      this.holdPacer = setInterval(() => {
        const frame = Buffer.allocUnsafe(FRAME);
        for (let i = 0; i < FRAME; i++) {
          frame[i] = clip[this.holdPos];
          this.holdPos = (this.holdPos + 1) % clip.length; // loop the clip
        }
        this.sendTwilio({ event: "media", streamSid: this.streamSid, media: { payload: frame.toString("base64") } });
        this.farQueue = Buffer.concat([this.farQueue, frame]); // hold music lands in the recording too
      }, 20);
    }
    // Safety expiry in case hold_end is missed.
    this.holdDeadline = setTimeout(() => this.endHold(), (Math.min(seconds, 60) + 3) * 1000);
  }

  private endHold() {
    if (!this.holding) return;
    this.holding = false;
    if (this.holdPacer) clearInterval(this.holdPacer);
    this.holdPacer = null;
    if (this.holdDeadline) clearTimeout(this.holdDeadline);
    this.holdDeadline = null;
    this.farQueue = EMPTY;
    this.sendTwilio({ event: "clear", streamSid: this.streamSid });
  }

  // ---- observe mode --------------------------------------------------------

  /** both_tracks stream: inbound (caller) is the mix clock, outbound (human agent) queues like xAI audio. */
  private onObserveFrame(track: "inbound" | "outbound", ulaw: Buffer) {
    this.sttBuf[track] = Buffer.concat([this.sttBuf[track], ulaw]);
    if (track === "inbound") this.recordCallerFrame(ulaw);
    else this.farQueue = Buffer.concat([this.farQueue, ulaw]);
  }

  private async flushStt(final = false) {
    if (!this.callId) return;
    for (const track of ["inbound", "outbound"] as const) {
      const buf = this.sttBuf[track];
      if (buf.length < (final ? FRAME * 25 : STT_MIN_BYTES)) continue; // skip sub-500ms tails
      this.sttBuf[track] = EMPTY;
      const at = new Date(Date.now() - buf.length / 8).toISOString(); // 8 bytes/ms → segment start
      const text = await transcribeUlaw(buf);
      if (text) await this.save("human_segment", { text, at, track });
    }
  }

  // ---- plumbing ------------------------------------------------------------

  private lastUserSaid = "";
  private lastUserSaidEventId: number | null = null;

  private async saveUserSaid(text: string) {
    this.lastUserSaid = text;
    const rows = await q<{ id: string }>(
      "INSERT INTO call_events (call_id, type, payload) VALUES ($1,'user_said',$2) RETURNING id",
      [this.callId, JSON.stringify({ text })]
    ).catch(() => []);
    this.lastUserSaidEventId = rows[0] ? Number(rows[0].id) : null;
  }

  private async updateLastUserSaid(text: string) {
    const longer = text.length >= this.lastUserSaid.length ? text : this.lastUserSaid;
    this.lastUserSaid = longer;
    if (this.lastUserSaidEventId) {
      await q("UPDATE call_events SET payload = $2 WHERE id = $1", [
        this.lastUserSaidEventId, JSON.stringify({ text: longer }),
      ]).catch(() => {});
    }
  }

  private sendTwilio(obj: unknown) {
    try {
      this.twilio.send(JSON.stringify(obj));
    } catch { /* socket already closed */ }
  }

  private async save(type: string, payload: unknown) {
    if (!this.callId) return;
    await q("INSERT INTO call_events (call_id, type, payload) VALUES ($1,$2,$3)", [
      this.callId, type, JSON.stringify(payload ?? {}),
    ]).catch(() => {});
  }

  /** Outbound campaign calls get a hard cap — a runaway conversation must not burn the line. */
  private async armOutboundGuard(callId: string) {
    const row = await qOne<{ direction: string; campaign_id: string | null; twilio_call_sid: string | null }>(
      "SELECT direction, campaign_id, twilio_call_sid FROM calls WHERE id = $1", [callId]
    ).catch(() => null);
    if (row?.direction !== "outbound") return;
    const capMs = (row.campaign_id ? 4 : 10) * 60_000; // campaign calls 4 min, ad-hoc outbound 10 min
    setTimeout(() => {
      if (this.done) return;
      void this.save("state", { state: "duration_cap" });
      const sid = row.twilio_call_sid;
      if (sid && process.env.TWILIO_ACCOUNT_SID) {
        const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
        void fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls/${sid}.json`,
          {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ Status: "completed" }),
          }
        ).catch(() => {});
      } else {
        void this.teardown();
      }
    }, capMs);
  }

  private async teardown() {
    if (this.done) return;
    this.done = true;
    for (const t of [this.recFlush, this.holdPacer, this.holdPoll, this.sttTimer]) if (t) clearInterval(t);
    if (this.holdDeadline) clearTimeout(this.holdDeadline);
    try { this.providerSocket?.close(); } catch {}
    try { this.twilio.close(); } catch {}

    if (this.mode === "observe") await this.flushStt(true).catch(() => {});
    if (this.farQueue.length) { // tail audio already sent to the caller
      this.recChunks.push(this.farQueue);
      this.farQueue = EMPTY;
    }
    await this.flushRecording();

    if (this.callId) {
      const closed = await q(
        `UPDATE calls SET status = 'completed', ended_at = now(),
         duration_s = EXTRACT(EPOCH FROM (now() - started_at))::int
         WHERE id = $1 AND status IN ('active','dialing') RETURNING id`,
        [this.callId]
      ).catch(() => []);
      // Observe-mode teardown must not analyze (agent leg already did / will).
      if (closed.length && this.mode === "agent") {
        const { waitUntil } = await import("@vercel/functions");
        const { analyzeCall } = await import("./analysis");
        waitUntil(analyzeCall(this.callId).catch(() => {}));
      }
    }
  }
}

// Author: Harsha Gundala
// bridge.ts — Twilio Media Streams ↔ OpenAI-compatible realtime providers: μ-law passthrough,
// turn-boundary events, hold-music playback, and observe mode (human-transfer transcription).

import WebSocket from "ws";
import { q, qOne } from "./db";
import { verifyScope, loadActiveAgent, voiceSessionSpecForCall, type ScopeClaims } from "./voice";
import { createServerRealtimeConnection } from "./realtime/registry";
import {
  requirePublicOrigin,
  twilioAccountSid,
  twilioRestAuthorization,
} from "./telephony";
import { transcribeUlaw } from "./stt";
import { log } from "./log";

const L = log("bridge");
const FRAME = 160; // 20ms of 8kHz μ-law
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
  start?: {
    accountSid: string;
    callSid: string;
    streamSid: string;
    customParameters?: Record<string, string>;
  };
  media?: { track?: string; payload: string };
  stop?: { accountSid: string; callSid: string; streamSid: string };
};

type Scope = ScopeClaims;

export class BridgeSession {
  private providerSocket: WebSocket | null = null;
  private streamSid: string | null = null;
  private callId: string | null = null;
  private providerCallSid: string | null = null;
  private providerAccountSid: string | null = null;
  private mode: "agent" | "observe" = "agent";
  private done = false;
  private inbound = Promise.resolve();

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
      this.inbound = this.inbound
        .then(async () => {
          const raw = String(data);
          if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error("oversized Twilio frame");
          await this.onTwilio(JSON.parse(raw) as TwilioMessage);
        })
        .catch((error) => {
          L.error("invalid Twilio stream message", { err: (error as Error).message });
          this.twilio.close();
        });
    });
    twilio.on("close", () => void this.teardown());
    twilio.on("error", () => void this.teardown());
  }

  private async onTwilio(msg: TwilioMessage) {
    switch (msg.event) {
      case "start": {
        if (this.streamSid || !msg.start) throw new Error("duplicate or malformed stream start");
        const { accountSid, callSid, streamSid } = msg.start;
        if (!/^MZ[0-9a-fA-F]{32}$/.test(streamSid)) throw new Error("invalid StreamSid");
        const params = msg.start.customParameters ?? {};
        const scope = verifyScope(params.capability ?? "", {
          audience: "twilio-bridge",
          purpose: "media-stream",
          method: "GET",
          provider: "twilio",
          providerCallId: callSid,
          providerAccountId: accountSid,
        });
        if (!scope?.bridgeMode) throw new Error("invalid bridge capability");
        this.mode = scope.bridgeMode;
        await this.begin(scope, msg.start);
        break;
      }
      case "media": {
        const ulaw = Buffer.from(msg.media!.payload, "base64");
        if (this.mode === "observe") {
          this.onObserveFrame(msg.media!.track === "outbound" ? "outbound" : "inbound", ulaw);
        } else {
          if (this.providerSocket?.readyState === WebSocket.OPEN) {
            this.providerSocket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media!.payload }));
          }
        }
        break;
      }
      case "stop":
        if (
          !msg.stop || msg.stop.streamSid !== this.streamSid ||
          msg.stop.callSid !== this.providerCallSid ||
          msg.stop.accountSid !== this.providerAccountSid || !this.callId
        ) throw new Error("stop identity does not match the active stream");
        void this.teardown();
        break;
    }
  }

  private async begin(
    scope: Scope,
    start: NonNullable<TwilioMessage["start"]>
  ) {
    const bound = await qOne<{ id: string }>(
      `WITH matched AS (
         SELECT c.id FROM calls c JOIN agents a ON a.id = c.agent_id
         WHERE c.id = $1 AND c.agent_id = $2 AND a.org_id = $3
           AND c.twilio_call_sid = $4 AND c.twilio_account_sid = $5 AND c.to_number = $6
           AND c.status IN ('active','dialing')
       ),
       stream AS (
         INSERT INTO telephony_stream_bindings (
           stream_sid, call_id, provider, provider_account_sid, provider_call_sid, to_number, mode
         )
         SELECT $7, matched.id, 'twilio', $5, $4, $6, $8 FROM matched
         ON CONFLICT (stream_sid) DO UPDATE SET stream_sid = telephony_stream_bindings.stream_sid
         WHERE telephony_stream_bindings.call_id = EXCLUDED.call_id
           AND telephony_stream_bindings.provider = EXCLUDED.provider
           AND telephony_stream_bindings.provider_account_sid = EXCLUDED.provider_account_sid
           AND telephony_stream_bindings.provider_call_sid = EXCLUDED.provider_call_sid
           AND telephony_stream_bindings.to_number = EXCLUDED.to_number
           AND telephony_stream_bindings.mode = EXCLUDED.mode
         RETURNING call_id
       ),
       consumed AS (
         INSERT INTO telephony_capability_consumptions (jti, audience, call_id, stream_sid, expires_at)
         SELECT $9, 'twilio-bridge', stream.call_id, $7, to_timestamp($10) FROM stream
         ON CONFLICT (jti) DO UPDATE SET jti = telephony_capability_consumptions.jti
         WHERE telephony_capability_consumptions.call_id = EXCLUDED.call_id
           AND telephony_capability_consumptions.stream_sid = EXCLUDED.stream_sid
           AND telephony_capability_consumptions.audience = EXCLUDED.audience
         RETURNING call_id
       )
       SELECT consumed.call_id AS id FROM consumed`,
      [
        scope.callId,
        scope.agentId,
        scope.orgId,
        start.callSid,
        start.accountSid,
        scope.providerTo,
        start.streamSid,
        scope.bridgeMode,
        scope.jti,
        scope.exp,
      ]
    );
    if (!bound) throw new Error("stream identity or capability replay rejected");
    this.callId = bound.id;
    this.streamSid = start.streamSid;
    this.providerCallSid = start.callSid;
    this.providerAccountSid = start.accountSid;

    const head = await qOne<{ max: string }>(
      "SELECT COALESCE(MAX(id),0)::text AS max FROM call_events WHERE call_id = $1", [scope.callId]
    );
    this.lastHoldEventId = Number(head?.max ?? 0);

    // Only the first stream on a call emits audio_start, keeping the timeline origin stable
    // across a post-transfer observe leg.
    await q(
      `INSERT INTO call_events (call_id, type, payload)
       SELECT $1, 'audio_start', $2::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM call_events WHERE call_id = $1 AND type = 'audio_start')`,
      [scope.callId, JSON.stringify({ at: new Date().toISOString() })]
    ).catch(() => {});
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

    const origin = requirePublicOrigin();
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
    this.providerSocket.on("message", (raw) => {
      try {
        this.onProviderEvent(JSON.parse(String(raw)), connection.provider);
      } catch {
        void this.save("error", { code: "invalid_provider_event" });
      }
    });
    this.providerSocket.on("close", () => void this.teardown());
    this.providerSocket.on("error", (error) => this.onProviderSocketError(connection.provider, error));
  }

  private onProviderSocketError(provider: string, _error: unknown) {
    void _error;
    L.error("realtime provider ws error", {
      callId: this.callId ?? undefined,
      code: "provider_runtime_error",
      provider,
    });
    void this.teardown();
  }

  private onProviderEvent(
    ev: { type: string; delta?: string; transcript?: string },
    provider: string,
  ) {
    switch (ev.type) {
      case "response.output_audio.delta":
      case "response.audio.delta": {
        if (!this.agentSpoke) {
          this.agentSpoke = true;
          void this.save("speech", { who: "agent", at: new Date().toISOString() });
        }
        if (this.holding) break; // hold music owns the line
        this.sendTwilio({ event: "media", streamSid: this.streamSid, media: { payload: ev.delta } });
        break;
      }
      case "response.done":
      case "response.completed":
        this.agentSpoke = false;
        break;
      case "input_audio_buffer.speech_started":
        this.agentSpoke = false;
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
        void this.save("error", { code: "provider_runtime_error", provider });
        break;
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
    this.sendTwilio({ event: "clear", streamSid: this.streamSid });
  }

  // ---- observe mode --------------------------------------------------------

  /** Observe both tracks independently for post-transfer transcription. */
  private onObserveFrame(track: "inbound" | "outbound", ulaw: Buffer) {
    this.sttBuf[track] = Buffer.concat([this.sttBuf[track], ulaw]);
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
      const sid = row.twilio_call_sid;
      if (sid && process.env.TWILIO_ACCOUNT_SID) {
        try {
          const accountSid = twilioAccountSid();
          const auth = twilioRestAuthorization();
          void this.save("state", { state: "duration_cap" });
          void fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${sid}.json`,
            {
              method: "POST",
              headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ Status: "completed" }),
            }
          ).catch(() => {});
        } catch {
          void this.teardown();
        }
      } else {
        void this.save("state", { state: "duration_cap", local_only: true });
        void this.teardown();
      }
    }, capMs);
  }

  private async teardown() {
    if (this.done) return;
    this.done = true;
    for (const t of [this.holdPacer, this.holdPoll, this.sttTimer]) if (t) clearInterval(t);
    if (this.holdDeadline) clearTimeout(this.holdDeadline);
    try { this.providerSocket?.close(); } catch {}
    try { this.twilio.close(); } catch {}

    if (this.mode === "observe") await this.flushStt(true).catch(() => {});
    if (this.callId) {
      if (this.streamSid) {
        await q(
          "UPDATE telephony_stream_bindings SET stopped_at = COALESCE(stopped_at, now()) WHERE stream_sid = $1 AND call_id = $2",
          [this.streamSid, this.callId]
        ).catch(() => {});
      }
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

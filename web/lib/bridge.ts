// Author: Harsha Gundala
// bridge.ts — in-app Twilio Media Streams ↔ xAI realtime session (μ-law passthrough, direct DB access).

import WebSocket from "ws";
import { q } from "./db";
import { verifyScope, loadActiveAgent, sessionUpdateForCall } from "./voice";
import { log } from "./log";

const L = log("bridge");
const XAI_WS = "wss://api.x.ai/v1/realtime?model=grok-voice-latest";

/** Minimal socket surface shared by `ws` and @vercel/functions' upgraded socket. */
export type BridgeSocket = {
  send: (data: string) => void;
  close: () => void;
  on: (event: "message" | "close" | "error", cb: (data?: unknown) => void) => void;
};

type TwilioMessage = {
  event: string;
  start?: { streamSid: string; customParameters?: Record<string, string> };
  media?: { payload: string };
};

export class BridgeSession {
  private xai: WebSocket | null = null;
  private streamSid: string | null = null;
  private callId: string | null = null;
  private done = false;

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
        try {
          await this.connectXai(params.scope ?? "");
        } catch (e) {
          L.error("bridge connect failed", { err: (e as Error).message });
          this.twilio.close();
        }
        break;
      }
      case "media":
        // 8kHz μ-law base64 from Twilio — xAI accepts it verbatim.
        if (this.xai?.readyState === WebSocket.OPEN) {
          this.xai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media!.payload }));
        }
        break;
      case "stop":
        void this.teardown();
        break;
    }
  }

  private async connectXai(scopeToken: string) {
    const scope = verifyScope(scopeToken);
    if (!scope) throw new Error("invalid scope");
    this.callId = scope.callId;

    const [agent, call] = await Promise.all([
      loadActiveAgent(scope.agentId, scope.orgId),
      q<{ direction: "inbound" | "outbound"; metadata: { reason?: string } }>(
        "SELECT direction, metadata FROM calls WHERE id = $1", [scope.callId]
      ).then((r) => r[0]),
    ]);
    if (!agent || !call) throw new Error("call or agent missing");

    const origin = process.env.PUBLIC_ORIGIN!;
    const sessionUpdate = (await sessionUpdateForCall(agent, scope.callId, call.direction, origin, "pcmu")) as {
      session: { instructions: string };
    };
    if (call.direction === "outbound" && call.metadata?.reason) {
      sessionUpdate.session.instructions +=
        `\n\nYou are placing this outbound call. Purpose: ${call.metadata.reason}. Open by introducing yourself and the reason for the call.`;
    }

    this.xai = new WebSocket(XAI_WS, { headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` } });
    this.xai.on("open", () => {
      this.xai!.send(JSON.stringify(sessionUpdate));
      this.xai!.send(JSON.stringify({ type: "response.create" }));
      void this.save("state", { state: "bridged" });
    });
    this.xai.on("message", (raw) => this.onXai(JSON.parse(String(raw))));
    this.xai.on("close", () => void this.teardown());
    this.xai.on("error", (e) => {
      L.error("xai ws error", { callId: this.callId ?? undefined, err: (e as Error).message });
      void this.teardown();
    });
  }

  private onXai(ev: { type: string; delta?: string; transcript?: string }) {
    switch (ev.type) {
      case "response.output_audio.delta":
      case "response.audio.delta":
        this.sendTwilio({ event: "media", streamSid: this.streamSid, media: { payload: ev.delta } });
        break;
      case "input_audio_buffer.speech_started":
        this.sendTwilio({ event: "clear", streamSid: this.streamSid }); // barge-in
        break;
      case "conversation.item.input_audio_transcription.completed":
        void this.save("user_said", { text: ev.transcript });
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        void this.save("agent_said", { text: ev.transcript });
        break;
      case "error":
        void this.save("error", ev);
        break;
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

  private async teardown() {
    if (this.done) return;
    this.done = true;
    try { this.xai?.close(); } catch {}
    try { this.twilio.close(); } catch {}
    if (this.callId) {
      await q(
        `UPDATE calls SET status = 'completed', ended_at = now(),
         duration_s = EXTRACT(EPOCH FROM (now() - started_at))::int
         WHERE id = $1 AND status IN ('active','dialing')`,
        [this.callId]
      ).catch(() => {});
    }
  }
}

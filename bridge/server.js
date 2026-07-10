// Author: Harsha Gundala
// server.js — Twilio Media Streams ↔ xAI/OpenAI realtime bridge. μ-law passthrough, no transcoding.
// Env: APP_ORIGIN, plus XAI_API_KEY and/or OPENAI_API_KEY, PORT (default 8080).

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 8080);
const APP = process.env.APP_ORIGIN;

if (!APP) {
  console.error("APP_ORIGIN is required");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  res.writeHead(req.url === "/health" ? 200 : 404).end(req.url === "/health" ? "ok" : "");
});
const wss = new WebSocketServer({ server, path: "/stream" });

wss.on("connection", (twilio) => new BridgeSession(twilio));
server.listen(PORT, () => console.log(`bridge listening :${PORT}`));

class BridgeSession {
  constructor(twilio) {
    this.twilio = twilio;
    this.providerSocket = null;
    this.streamSid = null;
    this.scope = null;
    this.pending = [];
    this.flusher = setInterval(() => this.flush(), 1500);

    twilio.on("message", (raw) => this.onTwilio(JSON.parse(raw)));
    twilio.on("close", () => this.teardown());
    twilio.on("error", () => this.teardown());
  }

  async onTwilio(msg) {
    switch (msg.event) {
      case "start": {
        this.streamSid = msg.start.streamSid;
        const params = msg.start.customParameters ?? {};
        this.scope = params.scope;
        try {
          await this.connectProvider(params.scope);
        } catch (e) {
          console.error("realtime provider connect failed:", e.message);
          this.twilio.close();
        }
        break;
      }
      case "media":
        // Twilio sends 8kHz μ-law base64 — xAI and OpenAI accept it verbatim.
        if (this.providerSocket?.readyState === WebSocket.OPEN) {
          this.providerSocket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
        }
        break;
      case "stop":
        this.teardown();
        break;
    }
  }

  async connectProvider(scope) {
    const res = await fetch(`${APP}/api/telephony/session?scope=${encodeURIComponent(scope)}`);
    if (!res.ok) throw new Error(`session fetch ${res.status}`);
    const { sessionUpdate, provider, wsUrl, model } = await res.json();
    const key = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.XAI_API_KEY;
    if (!key) throw new Error(`${provider === "openai" ? "OPENAI_API_KEY" : "XAI_API_KEY"} is required by this call`);

    this.providerSocket = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${key}` },
    });
    this.providerSocket.on("open", () => {
      this.providerSocket.send(JSON.stringify(sessionUpdate));
      this.providerSocket.send(JSON.stringify({ type: "response.create" }));
      this.queue("state", { state: "bridged", provider, model });
    });
    this.providerSocket.on("message", (raw) => this.onProviderEvent(JSON.parse(raw)));
    this.providerSocket.on("close", () => this.teardown());
    this.providerSocket.on("error", (e) => {
      console.error("realtime provider ws error:", e.message);
      this.teardown();
    });
  }

  onProviderEvent(ev) {
    switch (ev.type) {
      case "response.output_audio.delta":
      case "response.audio.delta":
        this.send({ event: "media", streamSid: this.streamSid, media: { payload: ev.delta } });
        break;
      case "input_audio_buffer.speech_started":
        // Barge-in: drop Twilio's queued playback immediately.
        this.send({ event: "clear", streamSid: this.streamSid });
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.queue("user_said", { text: ev.transcript });
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        this.queue("agent_said", { text: ev.transcript });
        break;
      case "error":
        console.error("realtime provider event error:", JSON.stringify(ev).slice(0, 300));
        this.queue("error", ev);
        break;
    }
  }

  send(obj) {
    if (this.twilio.readyState === WebSocket.OPEN) this.twilio.send(JSON.stringify(obj));
  }

  queue(type, payload) {
    this.pending.push({ type, payload });
  }

  async flush(complete = false) {
    if (!this.scope || (!this.pending.length && !complete)) return;
    const events = this.pending.splice(0, 50);
    await fetch(`${APP}/api/telephony/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: this.scope, events, complete }),
    }).catch((e) => console.error("event flush failed:", e.message));
  }

  teardown() {
    if (this.done) return;
    this.done = true;
    clearInterval(this.flusher);
    void this.flush(true);
    try { this.providerSocket?.close(); } catch {}
    try { this.twilio.close(); } catch {}
  }
}

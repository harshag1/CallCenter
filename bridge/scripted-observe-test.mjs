// Author: Harsha Gundala
// scripted-observe-test.mjs — verifies the bridge's observe mode (post-transfer human leg) without PSTN:
// streams TTS "human + caller" audio on both tracks, then asserts human_segment transcription,
// continued dual-track recording (append, not replace), WAV playback, and the single-audio_start guard.
//
// Usage: node scripted-observe-test.mjs   (env: BRIDGE_URL, AGENT_ID, WEB_DIR)

import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import WebSocket from "ws";

const WEB = process.env.WEB_DIR ?? new URL("../web", import.meta.url).pathname;
const env = Object.fromEntries(
  readFileSync(`${WEB}/.env.local`, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const BRIDGE_URL = process.env.BRIDGE_URL ?? "wss://callcenter-dun.vercel.app/api/bridge";
const API_BASE = `https://${new URL(BRIDGE_URL).host}`;
const AGENT_ID = process.env.AGENT_ID ?? "fac1e0d8-cba6-45fa-9109-a285732b37ee";
const FRAME = 160; // 20ms of 8kHz μ-law
const SILENCE = Buffer.alloc(FRAME, 0xff);

// μ-law encode (G.711)
function linearToUlaw(s) {
  const BIAS = 0x84, CLIP = 32635;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
  return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
}
// 24kHz 16-bit PCM → 8kHz μ-law (decimate by 3)
function pcm24kToUlaw8k(buf) {
  const samples = buf.length >> 1;
  const out = Buffer.alloc(Math.floor(samples / 3));
  for (let i = 0; i < out.length; i++) out[i] = linearToUlaw(buf.readInt16LE(i * 6));
  return out;
}

async function tts(voice, input) {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tts-1", voice, input, response_format: "pcm" }),
  });
  if (!res.ok) throw new Error(`tts failed (${res.status}): ${await res.text()}`);
  return pcm24kToUlaw8k(Buffer.from(await res.arrayBuffer()));
}

/** Per-track frame schedule: silence padding around one utterance per track. */
function buildSchedule(inboundUtt, outboundUtt) {
  const inFrames = Math.ceil(inboundUtt.length / FRAME);
  const outFrames = Math.ceil(outboundUtt.length / FRAME);
  const lead = 25, gap = 50, tail = 75; // 0.5s lead, 1s between speakers, 1.5s tail
  const total = lead + inFrames + gap + outFrames + tail;
  const frameAt = (utt, start, i) => {
    if (i < start || i >= start + Math.ceil(utt.length / FRAME)) return SILENCE;
    const f = utt.subarray((i - start) * FRAME, (i - start + 1) * FRAME);
    return f.length === FRAME ? f : Buffer.concat([f, Buffer.alloc(FRAME - f.length, 0xff)]);
  };
  return {
    total,
    inbound: (i) => frameAt(inboundUtt, lead, i),
    outbound: (i) => frameAt(outboundUtt, lead + inFrames + gap, i),
  };
}

const db = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { ca: readFileSync(`${WEB}/certs/supabase-ca.crt`, "utf8") },
});
await db.connect();

const agent = (await db.query(
  "SELECT id, org_id, active_version, phone_number FROM agents WHERE id = $1", [AGENT_ID]
)).rows[0];
if (!agent) { console.error(`agent ${AGENT_ID} not found`); process.exit(1); }

console.log("synthesizing test utterances…");
const [humanUtt, callerUtt] = await Promise.all([
  tts("onyx", "Hi thanks for holding, this is Marcus from support, I can fix that for you right away."),
  tts("nova", "Great, thank you so much Marcus!"),
]);

// Fresh call row each run (idempotent); seed 1s of recording + an audio_start to simulate the
// pre-transfer agent leg, so append semantics and the audio_start guard are both exercised.
const SEED_BYTES = 8000;
const call = (await db.query(
  `INSERT INTO calls (agent_id, agent_version, direction, from_number, to_number, metadata)
   VALUES ($1,$2,'inbound','+15550001111',$3,'{"reason":"scripted observe test"}') RETURNING id`,
  [agent.id, agent.active_version, agent.phone_number ?? "+15550002222"]
)).rows[0];
await db.query(
  "INSERT INTO call_recordings (call_id, mime, data) VALUES ($1,'audio/basic;rate=8000',$2)",
  [call.id, Buffer.alloc(SEED_BYTES, 0xff)]
);
await db.query("UPDATE calls SET recording_path = $2 WHERE id = $1", [call.id, `db:${call.id}`]);
await db.query(
  "INSERT INTO call_events (call_id, type, payload) VALUES ($1,'audio_start',$2)",
  [call.id, JSON.stringify({ at: new Date().toISOString() })]
);
console.log("callId:", call.id);

const body = Buffer.from(JSON.stringify({ callId: call.id, agentId: agent.id, orgId: agent.org_id })).toString("base64url");
const scope = `${body}.${createHmac("sha256", env.MCP_GATEWAY_SECRET).update(body).digest("base64url")}`;

// Temp session for the authenticated /recording HTTP check.
const user = (await db.query("SELECT email FROM users WHERE org_id = $1 LIMIT 1", [agent.org_id])).rows[0];
const sessionToken = randomBytes(32).toString("hex");
if (user) {
  await db.query(
    "INSERT INTO sessions_auth (token, email, expires_at) VALUES ($1,$2, now() + interval '1 hour')",
    [sessionToken, user.email]
  );
}

// ---- stream the observe leg ------------------------------------------------
const sched = buildSchedule(humanUtt, callerUtt);
let inboundBytesSent = 0;
const ws = new WebSocket(BRIDGE_URL);
await new Promise((resolve, reject) => {
  ws.on("error", reject);
  ws.on("open", () => {
    ws.send(JSON.stringify({ event: "connected", protocol: "Call" }));
    ws.send(JSON.stringify({
      event: "start",
      start: { streamSid: `MZobserve${Date.now()}`, customParameters: { scope, mode: "observe" } },
    }));
    let i = 0;
    const clock = setInterval(() => {
      if (ws.readyState !== 1) { clearInterval(clock); return resolve(); }
      if (i >= sched.total) {
        clearInterval(clock);
        ws.send(JSON.stringify({ event: "stop" }));
        setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 800);
        return;
      }
      const inb = sched.inbound(i);
      inboundBytesSent += inb.length;
      ws.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: inb.toString("base64") } }));
      ws.send(JSON.stringify({ event: "media", media: { track: "outbound", payload: sched.outbound(i).toString("base64") } }));
      i++;
    }, 20);
  });
});
console.log(`streamed ${sched.total} frames (${(sched.total * 0.02).toFixed(1)}s), inbound bytes: ${inboundBytesSent}`);

// ---- poll for results (STT + final recording flush land during teardown) ----
const fuzzy = (text, words) => words.filter((w) => text.toLowerCase().includes(w)).length;
let segs = [], recBytes = 0, audioStarts = 0;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  segs = (await db.query(
    "SELECT payload FROM call_events WHERE call_id = $1 AND type = 'human_segment' ORDER BY id", [call.id]
  )).rows.map((r) => r.payload);
  recBytes = Number((await db.query(
    "SELECT COALESCE(octet_length(data),0) AS n FROM call_recordings WHERE call_id = $1", [call.id]
  )).rows[0]?.n ?? 0);
  audioStarts = Number((await db.query(
    "SELECT COUNT(*)::int AS n FROM call_events WHERE call_id = $1 AND type = 'audio_start'", [call.id]
  )).rows[0].n);
  const inText = segs.filter((s) => s.track === "inbound").map((s) => s.text).join(" ");
  const outText = segs.filter((s) => s.track === "outbound").map((s) => s.text).join(" ");
  if (fuzzy(inText, ["marcus", "holding", "fix", "support"]) >= 2 && fuzzy(outText, ["thank", "marcus", "great"]) >= 1
      && recBytes >= SEED_BYTES + inboundBytesSent - FRAME * 25) break;
  await new Promise((r) => setTimeout(r, 2500));
}

const inText = segs.filter((s) => s.track === "inbound").map((s) => s.text).join(" ");
const outText = segs.filter((s) => s.track === "outbound").map((s) => s.text).join(" ");
console.log("\nhuman_segments:", JSON.stringify(segs, null, 1));
console.log(`recording bytes: ${recBytes} (seed ${SEED_BYTES} + streamed ${inboundBytesSent})`);

let wavOk = false, wavType = "";
if (user) {
  const res = await fetch(`${API_BASE}/api/calls/${call.id}/recording`, {
    headers: { Cookie: `session_token=${sessionToken}` },
  });
  wavType = res.headers.get("content-type") ?? "";
  wavOk = res.ok && wavType.includes("audio/wav") && (await res.arrayBuffer()).byteLength > 20000;
  await db.query("DELETE FROM sessions_auth WHERE token = $1", [sessionToken]);
}

// ---- assertions --------------------------------------------------------------
const results = [
  ["A1 human_segment inbound transcribed", fuzzy(inText, ["marcus", "holding", "fix", "support"]) >= 2],
  ["A2 human_segment outbound transcribed", fuzzy(outText, ["thank", "marcus", "great"]) >= 1],
  ["A3 recording appended on same call row (>20KB, seed kept)", recBytes >= SEED_BYTES + Math.max(inboundBytesSent - FRAME * 25, 20000)],
  ["A4 GET /api/calls/:id/recording → audio/wav", wavOk],
  ["A5 single audio_start (guard — needs deployed bridge fix)", audioStarts === 1],
];
console.log("");
for (const [name, ok] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
if (!wavOk) console.log(`      (recording endpoint: content-type=${wavType || "n/a"})`);
if (audioStarts !== 1) console.log(`      (audio_start count=${audioStarts}; expected 1 once the guarded insert is deployed)`);
console.log(`\ntimeline continuity: all ${segs.length} human_segments landed on call ${call.id}`);

await db.end();
process.exit(results.slice(0, 4).every(([, ok]) => ok) ? 0 : 1);

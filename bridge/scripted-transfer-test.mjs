// Author: Harsha Gundala
// scripted-transfer-test.mjs — verifies the contact_support fix: on a web (browser) call the
// agent must trigger contact_support, acknowledge the transfer verbally, and never speak a
// phone number. Also spot-checks the transfer TwiML endpoint. TTS caller via OpenAI tts-1.

import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import pg from "pg";
import WebSocket from "ws";

const AGENT_ID = "fac1e0d8-cba6-45fa-9109-a285732b37ee"; // Costco agent
const BRIDGE_URL = process.env.BRIDGE_URL ?? "wss://callcenter-dun.vercel.app/api/bridge";
const ORIGIN = "https://callcenter-dun.vercel.app";

const WEB = process.env.WEB_DIR ?? new URL("../web", import.meta.url).pathname;
const env = Object.fromEntries(
  readFileSync(`${WEB}/.env.local`, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

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

// TTS an utterance (cached), returning 8kHz μ-law
async function ttsUlaw(text, cacheName) {
  const cache = `${tmpdir()}/${cacheName}`;
  if (!existsSync(cache)) {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tts-1", voice: "onyx", input: text, response_format: "pcm" }),
    });
    if (!res.ok) throw new Error(`TTS failed ${res.status}: ${await res.text()}`);
    writeFileSync(cache, Buffer.from(await res.arrayBuffer()));
  }
  return pcm24kToUlaw8k(readFileSync(cache));
}

const utt1 = await ttsUlaw(
  "I have a really complicated problem. I need to speak with a real human being please.",
  "transfer-test-utt1.pcm"
);
const utt2 = await ttsUlaw("Yes, please connect me.", "transfer-test-utt2.pcm");
const silence = Buffer.alloc(160, 0xff).toString("base64");

const db = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { ca: readFileSync(`${WEB}/certs/supabase-ca.crt`, "utf8") } });
await db.connect();
const agent = (await db.query("SELECT org_id, active_version FROM agents WHERE id = $1", [AGENT_ID])).rows[0];
const call = (await db.query(
  `INSERT INTO calls (agent_id, agent_version, direction) VALUES ($1,$2,'web') RETURNING id`,
  [AGENT_ID, agent.active_version]
)).rows[0];
const body = Buffer.from(JSON.stringify({ callId: call.id, agentId: AGENT_ID, orgId: agent.org_id })).toString("base64url");
const scope = `${body}.${createHmac("sha256", env.MCP_GATEWAY_SECRET).update(body).digest("base64url")}`;
console.log("callId:", call.id);

// Cheap API-level check: transfer TwiML must contain <Dial> with the number and <Start><Stream.
const twimlRes = await fetch(`${ORIGIN}/api/telephony/twiml?transfer=%2B15550001111&scope=${encodeURIComponent(scope)}`);
const twiml = await twimlRes.text();
const twimlDial = /<Dial>\+15550001111<\/Dial>/.test(twiml);
const twimlStream = /<Start><Stream/.test(twiml);
console.log(`TwiML check: status=${twimlRes.status} dial=${twimlDial} stream=${twimlStream}`);

const ws = new WebSocket(BRIDGE_URL);
let queue = null;      // utterance being streamed
let queuePos = 0;
let agentTalking = false;
let lastAgentAudio = 0;
let spokenCount = 0;
let done = false;

ws.on("open", () => {
  ws.send(JSON.stringify({ event: "connected", protocol: "Call" }));
  ws.send(JSON.stringify({ event: "start", start: { streamSid: "MZtransfertest", customParameters: { callId: call.id, scope } } }));
  // 20ms frame clock: stream queued utterance, else silence.
  setInterval(() => {
    if (ws.readyState !== 1) return;
    let payload = silence;
    if (queue) {
      payload = queue.subarray(queuePos, queuePos + 160).toString("base64");
      queuePos += 160;
      if (queuePos >= queue.length) { queue = null; console.log("· finished speaking"); }
    }
    ws.send(JSON.stringify({ event: "media", media: { payload } }));
  }, 20);
});
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.event === "media") { agentTalking = true; lastAgentAudio = Date.now(); }
});

// Turn-taking: when the agent has been quiet for 1.6s after speaking, deliver the next scripted line.
setInterval(() => {
  if (done || queue || !agentTalking) return;
  if (Date.now() - lastAgentAudio > 1600) {
    agentTalking = false;
    if (spokenCount === 0) { queue = utt1; queuePos = 0; spokenCount = 1; console.log("· speaking: transfer request"); }
    else if (spokenCount === 1) { queue = utt2; queuePos = 0; spokenCount = 2; console.log("· speaking: confirmation"); }
  }
}, 200);

// Watch call_events up to 90s for tool_call contact_support; after it fires, allow up to 25s
// for the verbal acknowledgment to land, then wrap up.
const PHONE_RE = /\+?\d[\d\s\-().]{6,}\d/;
const ACK_RE = /connect|transfer|human/i;
const deadline = Date.now() + 90_000;
let supportSeenAt = 0;
let seenToolLogged = new Set();

async function fetchEvents() {
  return (await db.query(
    "SELECT id, type, payload FROM call_events WHERE call_id = $1 ORDER BY id", [call.id]
  )).rows;
}

const poll = setInterval(async () => {
  const evs = await fetchEvents();
  for (const e of evs) {
    if (e.type === "tool_call" && !seenToolLogged.has(e.id)) {
      seenToolLogged.add(e.id);
      console.log(`TOOL ${e.payload.name}`);
    }
  }
  const supportCall = evs.find((e) => e.type === "tool_call" && e.payload.name === "contact_support");
  if (supportCall && !supportSeenAt) supportSeenAt = Date.now();
  const ackAfter = supportCall &&
    evs.some((e) => e.type === "agent_said" && e.id > supportCall.id && ACK_RE.test(e.payload.text ?? ""));

  const timedOut = Date.now() > deadline;
  const graceOver = supportSeenAt && Date.now() - supportSeenAt > 25_000;
  if (!(ackAfter || graceOver || timedOut)) return;

  done = true;
  clearInterval(poll);
  ws.close();

  const finalEvs = await fetchEvents();
  const agentSaid = finalEvs.filter((e) => e.type === "agent_said").map((e) => String(e.payload.text ?? ""));
  const supportCalled = finalEvs.some((e) => e.type === "tool_call" && e.payload.name === "contact_support");
  const phoneHits = agentSaid.filter((t) => PHONE_RE.test(t));
  const ackHits = agentSaid.filter((t) => ACK_RE.test(t));

  console.log("\n--- transcript (agent_said) ---");
  agentSaid.forEach((t, i) => console.log(`  [${i + 1}] ${t}`));

  console.log("\n--- assertions ---");
  console.log(`1. contact_support called:        ${supportCalled ? "PASS" : "FAIL"}`);
  console.log(`2. no phone number spoken:        ${phoneHits.length === 0 ? "PASS" : `FAIL → ${JSON.stringify(phoneHits)}`}`);
  console.log(`3. transfer verbally acknowledged: ${ackHits.length > 0 ? "PASS" : "FAIL"}${ackHits.length ? ` → ${JSON.stringify(ackHits[ackHits.length - 1])}` : ""}`);
  console.log(`4. TwiML <Dial> + <Start><Stream>: ${twimlDial && twimlStream ? "PASS" : "FAIL"}`);

  // 4b. call row should reach 'completed' within ~20s of the WS closing.
  let status = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    status = (await db.query("SELECT status FROM calls WHERE id = $1", [call.id])).rows[0].status;
    if (status === "completed") break;
  }
  console.log(`5. call status completed:         ${status === "completed" ? "PASS" : `FAIL (status=${status})`}`);
  console.log(`\ncallId: ${call.id}`);
  await db.end();
  process.exit(0);
}, 3000);

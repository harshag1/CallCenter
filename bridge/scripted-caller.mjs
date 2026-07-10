// Author: Harsha Gundala
// scripted-caller.mjs — deterministic voice-loop test: a TTS "human" answers the Day Survey
// through the production bridge, so write_table/end_call behavior is verifiable without a person.

import { readFileSync } from "node:fs";
import pg from "pg";
import WebSocket from "ws";
import { databaseConfig, loadProjectEnv, signScope } from "./test-helpers.mjs";

const WEB = process.env.WEB_DIR ?? new URL("../web", import.meta.url).pathname;
const env = loadProjectEnv(WEB);

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
const utt1 = pcm24kToUlaw8k(readFileSync("/tmp/utt1.pcm"));
const utt2 = pcm24kToUlaw8k(readFileSync("/tmp/utt2.pcm"));
const silence = Buffer.alloc(160, 0xff).toString("base64");

const db = new pg.Client(databaseConfig(env, WEB));
await db.connect();
const flow = (await db.query("SELECT id, agent_id, org_id FROM flows WHERE name = $1", [process.env.FLOW_NAME ?? "Day Survey"])).rows[0];
if (!flow) throw new Error(`flow not found: ${process.env.FLOW_NAME ?? "Day Survey"}`);
const agent = (await db.query("SELECT active_version FROM agents WHERE id = $1", [flow.agent_id])).rows[0];
const call = (await db.query(
  `INSERT INTO calls (agent_id, agent_version, direction, from_number, to_number, flow_id, metadata)
   VALUES ($1,$2,'outbound',$3,$4,$5,'{"reason":"campaign: Scripted Verification"}') RETURNING id`,
  [flow.agent_id, agent.active_version, process.env.FROM_NUMBER ?? "+15550000001", process.env.TO_NUMBER ?? "+15550000002", flow.id]
)).rows[0];
const scope = signScope(env.MCP_GATEWAY_SECRET, { callId: call.id, agentId: flow.agent_id, orgId: flow.org_id });
console.log("callId:", call.id);

const ws = new WebSocket(process.env.BRIDGE_URL ?? "ws://localhost:8080/stream");
let queue = null;      // utterance being streamed
let queuePos = 0;
let agentTalking = false;
let lastAgentAudio = 0;
let spokenCount = 0;
let done = false;

ws.on("open", () => {
  ws.send(JSON.stringify({ event: "connected", protocol: "Call" }));
  ws.send(JSON.stringify({ event: "start", start: { streamSid: "MZscripted", customParameters: { callId: call.id, scope } } }));
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
    if (spokenCount === 0) { queue = utt1; queuePos = 0; spokenCount = 1; console.log("· speaking: score answer"); }
    else if (spokenCount === 1) { queue = utt2; queuePos = 0; spokenCount = 2; console.log("· speaking: comment"); }
  }
}, 200);

// Watch for the outcome; cap at 120s.
const deadline = Date.now() + 120_000;
const poll = setInterval(async () => {
  const evs = (await db.query(
    "SELECT type, payload FROM call_events WHERE call_id = $1 AND type IN ('tool_call','tool_result') ORDER BY id",
    [call.id]
  )).rows;
  for (const e of evs.slice(-2)) {
    if (e.type === "tool_call") process.stdout.write(`TOOL ${e.payload.name} `);
  }
  const wrote = evs.some((e) => e.type === "tool_call" && e.payload.name === "write_table");
  const ended = evs.some((e) => e.type === "tool_call" && e.payload.name === "end_call");
  if ((wrote && ended) || Date.now() > deadline) {
    done = true;
    clearInterval(poll);
    console.log(`\nRESULT: write_table=${wrote} end_call=${ended}`);
    const scores = (await db.query(
      "SELECT dr.data FROM dataset_rows dr JOIN datasets d ON d.id = dr.dataset_id WHERE d.slug='satisfaction_scores'"
    )).rows;
    console.log("scores:", JSON.stringify(scores.map((r) => r.data)));
    ws.close();
    await db.end();
    process.exit(0);
  }
}, 3000);

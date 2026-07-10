// Simulates a Twilio Media Streams client against the local bridge.
import pg from "pg";
import WebSocket from "ws";
import { databaseConfig, loadProjectEnv, signScope } from "./test-helpers.mjs";

const WEB = process.env.WEB_DIR ?? new URL("../web", import.meta.url).pathname;
const env = loadProjectEnv(WEB);

const db = new pg.Client(databaseConfig(env, WEB));
await db.connect();
const agent = (await db.query("SELECT id, org_id, active_version FROM agents LIMIT 1")).rows[0];
const call = (await db.query(
  `INSERT INTO calls (agent_id, agent_version, direction, from_number, to_number, metadata)
   VALUES ($1,$2,'outbound','+15550000001','+15550000002','{"reason":"bridge smoke test — greet and say exactly: bridge test successful"}') RETURNING id`,
  [agent.id, agent.active_version]
)).rows[0];
const scope = signScope(env.MCP_GATEWAY_SECRET, { callId: call.id, agentId: agent.id, orgId: agent.org_id });
console.log("callId:", call.id);

const ws = new WebSocket(process.env.BRIDGE_URL ?? "ws://localhost:8787/stream");
let mediaFrames = 0, mediaBytes = 0, cleared = 0;
const silence = Buffer.alloc(160, 0xff).toString("base64"); // 20ms μ-law silence

ws.on("open", () => {
  ws.send(JSON.stringify({ event: "connected", protocol: "Call" }));
  ws.send(JSON.stringify({ event: "start", start: { streamSid: "MZtest123", customParameters: { callId: call.id, scope } } }));
  const iv = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ event: "media", media: { payload: silence } })), 20);
  setTimeout(() => { clearInterval(iv); ws.send(JSON.stringify({ event: "stop" })); ws.close(); }, 18000);
});
ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.event === "media") { mediaFrames++; mediaBytes += Buffer.from(m.media.payload, "base64").length; }
  if (m.event === "clear") cleared++;
});
ws.on("close", async () => {
  console.log(`received media frames: ${mediaFrames}, audio bytes: ${mediaBytes} (~${(mediaBytes / 8000).toFixed(1)}s of 8kHz μ-law), clears: ${cleared}`);
  await new Promise((r) => setTimeout(r, 3000));
  const events = (await db.query("SELECT type, payload FROM call_events WHERE call_id = $1 ORDER BY id", [call.id])).rows;
  for (const e of events) console.log(`event ${e.type}: ${JSON.stringify(e.payload).slice(0, 140)}`);
  const status = (await db.query("SELECT status, duration_s FROM calls WHERE id = $1", [call.id])).rows[0];
  console.log("final call row:", status);
  await db.end();
  process.exit(0);
});
ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });

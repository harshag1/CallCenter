import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentFlowSchema } from "../flow";
import {
  CallRuntimeSnapshotSchema,
  callRuntimeDigest,
} from "../call-runtime-snapshot";

const databaseUrl = process.env.FLOW_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));
const originalEnvironment = {
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: process.env.DATABASE_SSL,
  supabaseDatabaseUrl: process.env.SUPABASE_DB_URL,
  gatewaySecret: process.env.MCP_GATEWAY_SECRET,
  publicOrigin: process.env.PUBLIC_ORIGIN,
};
const syntheticGatewaySecret = [
  "durable",
  "session",
  "integration",
  "fixture",
  "only",
].join("-");

integration("stock voice session durable route through PostgreSQL", () => {
  const ids = { org: randomUUID(), agent: randomUUID(), call: randomUUID() };
  const origin = "https://voice.example";
  const flow = AgentFlowSchema.parse({
    schema_version: 2,
    tool_exposure: "gateway",
    always_tools: [],
    nodes: [
      { id: "entry", label: "Incoming", kind: "incoming_call" },
      {
        id: "membership",
        label: "Membership",
        kind: "topic",
        steps: [{
          id: "verify",
          label: "Verify membership",
          instructions: "Verify the member once.",
          tools: ["read_table"],
          action_policies: [{ tool: "read_table", idempotency: "per_arguments", max_calls: 2 }],
        }],
      },
    ],
    edges: [{ from: "entry", to: "membership" }],
  });
  const runtimeSnapshot = CallRuntimeSnapshotSchema.parse({
    v: 2,
    agentVersion: 1,
    namedFlowId: null,
    flow,
    instructions: "Initial durable-session integration test.",
    codeRevision: "voice-session-durable-route-test",
    toolManifest: [],
    extensionManifest: [],
    externalMcpManifest: [],
    environment: {
      internetEnabled: false,
      allowedDomains: [],
      docsReady: false,
      datasetSlugs: [],
      holdMusic: false,
    },
    createdAt: "2026-07-28T20:00:00.000Z",
  });
  const runtimeDigest = callRuntimeDigest(runtimeSnapshot);
  let modules: {
    db: typeof import("../db");
    voice: typeof import("../voice");
  };

  beforeAll(async () => {
    if (databaseUrl) {
      const hostname = new URL(databaseUrl).hostname.toLowerCase();
      const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
      if (loopback) {
        process.env.DATABASE_URL = databaseUrl;
        delete process.env.SUPABASE_DB_URL;
        process.env.DATABASE_SSL = "disable";
      } else {
        delete process.env.DATABASE_URL;
        process.env.SUPABASE_DB_URL = databaseUrl;
        process.env.DATABASE_SSL = "verify-full";
      }
    }
    process.env.MCP_GATEWAY_SECRET = syntheticGatewaySecret;
    process.env.PUBLIC_ORIGIN = origin;
    modules = {
      db: await import("../db"),
      voice: await import("../voice"),
    };
    await modules.db.q("INSERT INTO orgs (id,name) VALUES ($1,'Durable session route')", [ids.org]);
    await modules.db.q(
      "INSERT INTO agents (id,org_id,name,active_version) VALUES ($1,$2,'Durable session agent',1)",
      [ids.agent, ids.org]
    );
    await modules.db.q(
      `INSERT INTO agent_versions
        (agent_id,version,instructions,voice,flow,settings,created_by)
       VALUES ($1,1,'test','marin',$2,$3,'integration-test')`,
      [ids.agent, JSON.stringify(flow), JSON.stringify({
        voice_provider: "openai",
        voice_model: "gpt-realtime-2.1",
      })]
    );
    await modules.db.q(
      `INSERT INTO calls
        (id,agent_id,agent_version,direction,status,runtime_snapshot,runtime_digest)
       VALUES ($1,$2,1,'inbound','active',$3,$4)`,
      [ids.call, ids.agent, JSON.stringify(runtimeSnapshot), runtimeDigest]
    );
  });

  afterAll(async () => {
    if (modules) await modules.db.getPool().end();
    for (const [name, value] of Object.entries({
      DATABASE_URL: originalEnvironment.databaseUrl,
      DATABASE_SSL: originalEnvironment.databaseSsl,
      SUPABASE_DB_URL: originalEnvironment.supabaseDatabaseUrl,
      PUBLIC_ORIGIN: originalEnvironment.publicOrigin,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const gatewaySecretName = "MCP_GATEWAY_SECRET";
    if (originalEnvironment.gatewaySecret === undefined) {
      delete process.env[gatewaySecretName];
    } else {
      process.env[gatewaySecretName] = originalEnvironment.gatewaySecret;
    }
  });

  it("pins one initial Flow checkpoint and replays the same provider packet", async () => {
    const agent = await modules.voice.loadActiveAgent(ids.agent, ids.org);
    if (!agent) throw new Error("integration agent was not loaded");

    const first = await modules.voice.voiceSessionSpecForCall(
      agent,
      ids.call,
      "inbound",
      origin
    );
    const replay = await modules.voice.voiceSessionSpecForCall(
      agent,
      ids.call,
      "inbound",
      origin
    );
    const packetMatch = first.instructions.match(
      /<HACC_DURABLE_CONTEXT_PACKET>\n([^\n]+)\n<\/HACC_DURABLE_CONTEXT_PACKET>/
    );
    expect(packetMatch?.[1]).toBeTruthy();
    const packet = JSON.parse(packetMatch![1]) as {
      authority: {
        capabilityCatalogDigest: string;
        capabilityEpoch: number;
        conversationRevision: number;
      };
      durable: {
        currentFlowCheckpoint: {
          flowRevision: number;
          runtimeDigest: string;
        };
      };
    };

    expect(packet).toMatchObject({
      authority: {
        capabilityCatalogDigest: first.activeCatalogAuthority.catalogDigest,
        capabilityEpoch: first.activeCatalogAuthority.capabilityEpoch,
        conversationRevision: 2,
      },
      durable: {
        currentFlowCheckpoint: {
          flowRevision: 0,
          runtimeDigest,
        },
      },
    });
    expect(first.instructions).toContain("<ACTIVE_CAPABILITY_CATALOG>");
    expect(replay.instructions).toBe(first.instructions);
    expect(replay.activeCatalogAuthority).toEqual(first.activeCatalogAuthority);

    const evidence = await modules.db.q<{
      event_count: string;
      head_sequence: string;
      call_binding_count: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM voice_conversation_events
          WHERE conversation_id = $1) AS event_count,
         (SELECT event_head_sequence::text FROM voice_conversations
          WHERE id = $1 AND org_id = $2) AS head_sequence,
         (SELECT count(*)::text FROM voice_conversation_calls
          WHERE conversation_id = $1 AND call_id = $1) AS call_binding_count`,
      [ids.call, ids.org]
    );
    expect(evidence[0]).toEqual({
      event_count: "2",
      head_sequence: "2",
      call_binding_count: "1",
    });
  }, 30_000);
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentFlowSchema } from "../flow";
import { CallRuntimeSnapshotSchema, callRuntimeDigest } from "../call-runtime-snapshot";
import { enterFlowStep, selectFlowTopic } from "../flow-runtime";

const databaseUrl = process.env.FLOW_INTEGRATION_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));
const mocks = vi.hoisted(() => ({ verifyScope: vi.fn() }));
const originalEnvironment = {
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: process.env.DATABASE_SSL,
  supabaseDatabaseUrl: process.env.SUPABASE_DB_URL,
  gatewaySecret: process.env.MCP_GATEWAY_SECRET,
};
const syntheticGatewaySecret = [
  "mcp",
  "route",
  "replay",
  "integration",
  "fixture",
  "only",
].join("-");

vi.mock("@/lib/voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../voice")>();
  return { ...actual, verifyScope: mocks.verifyScope };
});

import { AuthorityClient } from "../../../bridge/lib/authority-client.js";

integration("standalone bridge dropped-response replay through the real MCP route", () => {
  const ids = { org: randomUUID(), agent: randomUUID(), call: randomUUID() };
  const callSid = `CA${ids.call.replaceAll("-", "")}`;
  const accountSid = `AC${ids.agent.replaceAll("-", "")}`;
  const streamSid = `MZ${ids.org.replaceAll("-", "")}`;
  const to = "+14155550100";
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
    instructions: "Dropped-response replay test.",
    codeRevision: "mcp-route-replay-test",
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
    createdAt: "2026-07-16T12:00:00.000Z",
  });
  const runtimeDigest = callRuntimeDigest(runtimeSnapshot);
  const scope = {
    v: 2 as const,
    callId: ids.call,
    agentId: ids.agent,
    orgId: ids.org,
    aud: "bridge_mcp" as const,
    purpose: "tool_invocation" as const,
    method: "POST" as const,
    provider: "openai" as const,
    iat: 1,
    exp: 4_102_444_800,
    jti: "A".repeat(22),
    providerCallId: callSid,
    providerAccountId: accountSid,
    providerTo: to,
    providerStreamId: streamSid,
    transportProvider: "twilio" as const,
  };
  let modules: Awaited<ReturnType<typeof loadModules>>;

  async function loadModules() {
    if (databaseUrl) {
      const hostname = new URL(databaseUrl).hostname.toLowerCase();
      const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
      if (loopback) {
        process.env.DATABASE_URL = databaseUrl;
        delete process.env.SUPABASE_DB_URL;
        process.env.DATABASE_SSL = "disable";
      } else {
        // Retain the Supabase-specific CA path for remote integration
        // databases instead of weakening TLS or treating the URL as generic.
        delete process.env.DATABASE_URL;
        process.env.SUPABASE_DB_URL = databaseUrl;
        process.env.DATABASE_SSL = "verify-full";
      }
    }
    process.env.MCP_GATEWAY_SECRET = syntheticGatewaySecret;
    const [db, stateStore, route, mcp] = await Promise.all([
      import("../db"),
      import("../flow-state-store"),
      import("../../app/api/mcp/route"),
      import("../mcp"),
    ]);
    return { db, stateStore, route, mcp };
  }

  beforeAll(async () => {
    modules = await loadModules();
    mocks.verifyScope.mockImplementation((_token, expectation) =>
      expectation.audience === "bridge_mcp" ? scope : null
    );
    await modules.db.q("INSERT INTO orgs (id,name) VALUES ($1,'Route replay')", [ids.org]);
    await modules.db.q(
      "INSERT INTO agents (id,org_id,name,active_version) VALUES ($1,$2,'Route replay agent',1)",
      [ids.agent, ids.org]
    );
    await modules.db.q(
      `INSERT INTO agent_versions
        (agent_id,version,instructions,voice,flow,settings,created_by)
       VALUES ($1,1,'test','marin',$2,$3,'integration-test')`,
      [ids.agent, JSON.stringify(flow), JSON.stringify({ voice_provider: "openai" })]
    );
    await modules.db.q(
      `INSERT INTO calls
        (id,agent_id,agent_version,direction,status,to_number,twilio_call_sid,
         twilio_account_sid,runtime_snapshot,runtime_digest)
       VALUES ($1,$2,1,'inbound','active',$3,$4,$5,$6,$7)`,
      [ids.call, ids.agent, to, callSid, accountSid, JSON.stringify(runtimeSnapshot), runtimeDigest]
    );
    await modules.db.q(
      `INSERT INTO telephony_stream_bindings
        (stream_sid,call_id,provider,provider_account_sid,provider_call_sid,to_number,mode)
       VALUES ($1,$2,'twilio',$3,$4,$5,'agent')`,
      [streamSid, ids.call, accountSid, callSid, to]
    );
    await modules.stateStore.withLockedFlowState(ids.call, (state) => {
      const selected = selectFlowTopic(flow, state, "membership");
      if ("error" in selected) throw new Error(selected.error);
      return { state: selected, value: null };
    });
  });

  afterAll(async () => {
    if (!modules) return;
    await modules.db.q("DELETE FROM calls WHERE id=$1", [ids.call]).catch(() => undefined);
    await modules.db.q("DELETE FROM agents WHERE id=$1", [ids.agent]).catch(() => undefined);
    await modules.db.q("DELETE FROM orgs WHERE id=$1", [ids.org]).catch(() => undefined);
    await modules.db.getPool().end();
    for (const [name, value] of Object.entries({
      DATABASE_URL: originalEnvironment.databaseUrl,
      DATABASE_SSL: originalEnvironment.databaseSsl,
      SUPABASE_DB_URL: originalEnvironment.supabaseDatabaseUrl,
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

  it("exactly replays enter_step after its HTTP response is lost", async () => {
    const requests: string[] = [];
    const terminalResponseBodies: string[] = [];
    let dropped = false;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      requests.push(body.method);
      const response = await modules.route.POST(new Request(input, init));
      if (body.method === "tools/call") {
        terminalResponseBodies.push(await response.clone().text());
      }
      if (body.method === "tools/call" && !dropped) {
        dropped = true;
        // The authority committed and produced a response, but the bridge never received it.
        throw new Error("simulated response loss after server completion");
      }
      return response;
    };
    const authority = new AuthorityClient({
      appOrigin: "https://voice.example",
      scopeToken: "bridge-token",
      fetchImpl,
      maximumAttempts: 2,
      sleep: async () => undefined,
    });
    const initialAuthority = await modules.mcp.activeCapabilityAuthorityFor({
      callId: ids.call,
      agentId: ids.agent,
      orgId: ids.org,
    });

    const outcome = await authority.callCapabilityGateway({
      provider: "openai",
      responseId: "response_enter_1",
      itemId: "item_enter_1",
      callId: "native_enter_step_1",
      name: "capability_gateway",
      arguments: {
        tool_name: "enter_step",
        arguments: { path: "membership.verify" },
      },
      activeCatalogAuthority: {
        catalogDigest: initialAuthority.catalog.catalog_digest,
        capabilityEpoch: initialAuthority.catalog.capability_epoch,
      },
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.output).toMatchObject({
      outcome: {
        path: "membership.verify",
        revision: 2,
        hacc_realtime_context_packet: {
          authority: {
            capabilityEpoch: 2,
            conversationRevision: 2,
          },
          durable: {
            currentFlowCheckpoint: {
              flowRevision: 2,
              runtimeDigest,
            },
          },
        },
      },
      active_capability_catalog: {
        availability: "active",
        capability_epoch: 2,
        catalog_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const terminalEnvelope = outcome.output as {
      outcome: { hacc_realtime_context_packet: {
        authority: { capabilityCatalogDigest: string; capabilityEpoch: number };
      } };
      active_capability_catalog: { catalog_digest: string; capability_epoch: number };
    };
    expect(terminalEnvelope.outcome.hacc_realtime_context_packet.authority).toMatchObject({
      capabilityCatalogDigest: terminalEnvelope.active_capability_catalog.catalog_digest,
      capabilityEpoch: terminalEnvelope.active_capability_catalog.capability_epoch,
    });
    expect(JSON.stringify(outcome.output)).not.toMatch(
      /capability_grant|capability_expires_at|available_actions/
    );
    expect(requests.filter((method) => method === "tools/call")).toHaveLength(2);
    expect(terminalResponseBodies).toHaveLength(2);
    expect(terminalResponseBodies[1]).toBe(terminalResponseBodies[0]);

    const state = await modules.stateStore.loadFlowState(ids.call);
    expect(state.currentStep).toBe("membership.verify");
    expect(state.attempts["membership.verify"]).toBe(1);
    const receipts = await modules.db.q<{ count: string; result_text: string }>(
      `SELECT count(*)::text AS count, max(result::text) AS result_text
       FROM mcp_tool_invocation_receipts WHERE call_id=$1`,
      [ids.call]
    );
    expect(receipts[0].count).toBe("1");
    expect(receipts[0].result_text).not.toMatch(
      /capability_grant|capability_expires_at|available_actions/
    );

    // Prove that a raw second transition really would be destructive; the receipt prevented it.
    const wouldRetry = enterFlowStep(flow, state, "membership.verify");
    if ("error" in wouldRetry) throw new Error(wouldRetry.error);
    expect(wouldRetry.state.attempts["membership.verify"]).toBe(2);
  }, 30_000);
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getPool: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/public-origin", async () => import("../public-origin"));
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));

import { POST as editInboundFlowNode } from "../../app/api/agents/[id]/flow-node/route";
import { PATCH as editNamedFlowNode } from "../../app/api/flows/[id]/route";

const ORIGIN = "https://voice.example.test";
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "00000000-0000-4000-8000-000000000002";
const FLOW_ID = "00000000-0000-4000-8000-000000000003";

const FLOW = {
  schema_version: 2 as const,
  tool_exposure: "gateway" as const,
  nodes: [
    { id: "entry", label: "Incoming call", kind: "incoming_call" as const },
    {
      id: "membership",
      label: "Membership",
      kind: "topic" as const,
      context: "Help with membership.",
      steps: [{
        id: "lookup",
        label: "Look up membership",
        instructions: "Find the member record.",
        tools: ["read_table"],
        action_policies: [{
          tool: "read_table",
          max_calls: 1,
          idempotency: "per_arguments" as const,
          effect: "read" as const,
        }],
      }],
    },
  ],
  edges: [{ from: "entry", to: "membership" }],
};

const CURRENT_AGENT_VERSION = {
  version: 4,
  instructions: "Help the caller.",
  voice: "marin",
  flow: FLOW,
  tool_ids: [],
  mcp_server_ids: [],
  settings: { voice_provider: "openai" },
};

function result<T>(rows: T[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function request(path: string, method: "POST" | "PATCH", node: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ node }),
  });
}

describe("flow node mutation integrity", () => {
  const previousPublicOrigin = process.env.PUBLIC_ORIGIN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_ORIGIN = ORIGIN;
    mocks.getSession.mockResolvedValue({
      orgId: ORG_ID,
      email: "builder@example.test",
    });
  });

  afterEach(() => {
    if (previousPublicOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousPublicOrigin;
  });

  it("rejects an inbound edit with an ungranted receipt binding before version persistence or activation", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith("BEGIN") || sql === "ROLLBACK") return result();
        if (sql.includes("FROM agents a") && sql.includes("FOR UPDATE OF a")) {
          return result([CURRENT_AGENT_VERSION]);
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });

    const response = await editInboundFlowNode(
      request(`/api/agents/${AGENT_ID}/flow-node`, "POST", {
        ...FLOW.nodes[1],
        steps: [{
          id: "lookup",
          label: "Look up membership",
          instructions: "Find the member record.",
          tools: ["read_table"],
          output_bindings: [{
            output: "renewed",
            tool: "write_table",
            result_path: "renewed",
          }],
        }],
      }),
      { params: Promise.resolve({ id: AGENT_ID }) }
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid flow",
      diagnostics: [expect.objectContaining({
        path: "membership.lookup.output_bindings.0.tool",
        message: 'binding tool "write_table" is not granted in this step',
      })],
    });
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries.some((sql) => sql.includes("INSERT INTO agent_versions"))).toBe(false);
    expect(queries.some((sql) => sql.startsWith("UPDATE agents"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects a named-flow edit with a dangling deep transition before persistence", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith("BEGIN") || sql === "ROLLBACK") return result();
        if (sql.startsWith("SELECT flow FROM flows")) return result([{ flow: FLOW }]);
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });

    const response = await editNamedFlowNode(
      request(`/api/flows/${FLOW_ID}`, "PATCH", {
        ...FLOW.nodes[1],
        steps: [{
          id: "lookup",
          label: "Look up membership",
          instructions: "Find the member record.",
          transitions: [{ to: "membership.missing_step" }],
        }],
      }),
      { params: Promise.resolve({ id: FLOW_ID }) }
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "invalid flow",
      diagnostics: [expect.objectContaining({
        path: "membership.lookup.transitions",
        message: 'transition targets unknown step "membership.missing_step"',
      })],
    });
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries.some((sql) => sql.startsWith("UPDATE flows"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("persists and activates a valid inbound edit in one serializable transaction", async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.startsWith("BEGIN") || sql === "COMMIT") return result();
        if (sql.includes("FROM agents a") && sql.includes("FOR UPDATE OF a")) {
          return result([CURRENT_AGENT_VERSION]);
        }
        if (sql.includes("INSERT INTO agent_versions")) return result([{ version: 5 }]);
        if (sql.startsWith("UPDATE agents")) return result([{ id: AGENT_ID }]);
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });

    const response = await editInboundFlowNode(
      request(`/api/agents/${AGENT_ID}/flow-node`, "POST", {
        ...FLOW.nodes[1],
        label: "Membership help",
      }),
      { params: Promise.resolve({ id: AGENT_ID }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, version: 5 });
    expect(queries.some(({ sql }) => sql.startsWith("BEGIN ISOLATION"))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes("INSERT INTO agent_versions"))).toBe(true);
    expect(queries.some(({ sql }) => sql.startsWith("UPDATE agents"))).toBe(true);
    expect(queries.findIndex(({ sql }) => sql.includes("INSERT INTO agent_versions")))
      .toBeLessThan(queries.findIndex(({ sql }) => sql.startsWith("UPDATE agents")));
    expect(queries.at(-1)?.sql).toBe("COMMIT");
  });

  it("rolls back a valid named-flow edit when persistence loses its ownership lock", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith("BEGIN") || sql === "ROLLBACK") return result();
        if (sql.startsWith("SELECT flow FROM flows")) return result([{ flow: FLOW }]);
        if (sql.startsWith("UPDATE flows")) return result([], 0);
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });

    const response = await editNamedFlowNode(
      request(`/api/flows/${FLOW_ID}`, "PATCH", {
        ...FLOW.nodes[1],
        label: "Membership help",
      }),
      { params: Promise.resolve({ id: FLOW_ID }) }
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "flow update failed safely" });
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});

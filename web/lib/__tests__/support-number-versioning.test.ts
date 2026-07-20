import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  getSession: vi.fn(),
  normalizePhoneNumber: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/auth", () => ({
  getSession: mocks.getSession,
  normalizePhoneNumber: mocks.normalizePhoneNumber,
}));
vi.mock("@/lib/public-origin", async () => import("../public-origin"));
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));

import { POST } from "../../app/api/agents/[id]/support-number/route";

const ORIGIN = "https://voice.example.test";
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "00000000-0000-4000-8000-000000000002";
const FLOW = {
  schema_version: 2 as const,
  tool_exposure: "gateway" as const,
  nodes: [
    { id: "entry", label: "Incoming", kind: "incoming_call" as const },
    {
      id: "topic",
      label: "Membership",
      kind: "topic" as const,
      context: "Help with memberships.",
      steps: [{ id: "start", label: "Start", instructions: "Identify the request." }],
    },
    {
      id: "fallback",
      label: "Fallback",
      kind: "fallback" as const,
      support_number: "+14155550100",
    },
  ],
  edges: [
    { from: "entry", to: "topic" },
    { from: "entry", to: "fallback" },
  ],
};
const ACTIVE_VERSION = {
  version: 2,
  instructions: "Keep these instructions.",
  voice: "marin",
  flow: FLOW,
  tool_ids: ["00000000-0000-4000-8000-000000000003"],
  mcp_server_ids: ["00000000-0000-4000-8000-000000000004"],
  settings: {
    voice_provider: "openai",
    voice_model: "gpt-realtime",
    provider_settings: { turn_detection: { type: "semantic_vad" } },
  },
};

function result<T>(rows: T[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function request(number = "(415) 555-0199"): Request {
  return new Request(`${ORIGIN}/api/agents/${AGENT_ID}/support-number`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ number }),
  });
}

const context = { params: Promise.resolve({ id: AGENT_ID }) };

describe("support-number append-only versioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PUBLIC_ORIGIN", ORIGIN);
    mocks.getSession.mockResolvedValue({
      orgId: ORG_ID,
      email: "operator@example.test",
    });
    mocks.normalizePhoneNumber.mockReturnValue("+14155550199");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("allocates after the historical maximum and preserves every setting when active points to an older version", async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.startsWith("BEGIN") || sql === "COMMIT") return result();
        if (sql.includes("FROM agents a") && sql.includes("FOR UPDATE OF a")) {
          return result([ACTIVE_VERSION]);
        }
        if (sql.includes("INSERT INTO agent_versions")) return result([{ version: 8 }]);
        if (sql.startsWith("UPDATE agents")) return result([{ id: AGENT_ID }]);
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });

    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      support_number: "+14155550199",
      version: 8,
    });
    const read = queries.find(({ sql }) => sql.includes("FROM agents a"));
    expect(read?.sql).toMatch(/a\.org_id = \$2[\s\S]+FOR UPDATE OF a/);
    expect(read?.params).toEqual([AGENT_ID, ORG_ID]);

    const insert = queries.find(({ sql }) => sql.includes("INSERT INTO agent_versions"));
    expect(insert?.sql).toMatch(
      /COALESCE\(MAX\(version\), 0\) \+ 1[\s\S]+settings/
    );
    expect(insert?.sql).not.toContain("pg_advisory");
    expect(insert?.params).toEqual([
      AGENT_ID,
      ACTIVE_VERSION.instructions,
      ACTIVE_VERSION.voice,
      expect.any(String),
      ACTIVE_VERSION.tool_ids,
      ACTIVE_VERSION.mcp_server_ids,
      JSON.stringify(ACTIVE_VERSION.settings),
      "studio (operator@example.test)",
    ]);
    expect(JSON.parse(String(insert?.params[3]))).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({
          kind: "fallback",
          support_number: "+14155550199",
        }),
      ]),
    });

    const activation = queries.find(({ sql }) => sql.startsWith("UPDATE agents"));
    expect(activation?.sql).toMatch(
      /org_id = \$2[\s\S]+active_version = \$4[\s\S]+RETURNING id/
    );
    expect(activation?.params).toEqual([AGENT_ID, ORG_ID, 8, 2]);
    expect(queries.map(({ sql }) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      expect.stringContaining("FOR UPDATE OF a"),
      expect.stringContaining("INSERT INTO agent_versions"),
      expect.stringContaining("UPDATE agents"),
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back the inserted version instead of silently activating over stale state", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith("BEGIN") || sql === "ROLLBACK") return result();
        if (sql.includes("FROM agents a")) return result([ACTIVE_VERSION]);
        if (sql.includes("INSERT INTO agent_versions")) return result([{ version: 8 }]);
        if (sql.startsWith("UPDATE agents")) return result([], 0);
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "agent changed; retry" });
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns not found inside the tenant-scoped transaction without writing", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith("BEGIN") || sql === "ROLLBACK") return result();
        if (sql.includes("FROM agents a")) return result();
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });

    const response = await POST(request(), context);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "agent not found" });
    expect(queries.some((sql) => sql.includes("INSERT INTO agent_versions"))).toBe(false);
    expect(queries).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("maps serialization, deadlock, and unique-version races to a retryable conflict after rollback", async () => {
    for (const code of ["40001", "40P01", "23505"]) {
      const queries: string[] = [];
      const client = {
        query: vi.fn(async (sql: string) => {
          queries.push(sql);
          if (sql.startsWith("BEGIN") || sql === "ROLLBACK") return result();
          if (sql.includes("FROM agents a")) return result([ACTIVE_VERSION]);
          if (sql.includes("INSERT INTO agent_versions")) {
            throw Object.assign(new Error("retry transaction"), { code });
          }
          throw new Error(`unexpected query: ${sql}`);
        }),
        release: vi.fn(),
      };
      mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });

      const response = await POST(request(), context);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "agent changed; retry" });
      expect(queries).toContain("ROLLBACK");
      expect(client.release).toHaveBeenCalledOnce();
    }
  });
});

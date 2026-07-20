import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPool: vi.fn(), q: vi.fn() }));
vi.mock("../db", () => ({ getPool: mocks.getPool, q: mocks.q }));

import { updateAgent } from "../agent/tools/agents";

const ORG = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-000000000002";
const CAMPAIGN = "00000000-0000-4000-8000-000000000003";
const FLOW = {
  schema_version: 2 as const,
  tool_exposure: "gateway" as const,
  nodes: [
    { id: "entry", label: "Incoming", kind: "incoming_call" as const },
    {
      id: "topic",
      label: "Topic",
      kind: "topic" as const,
      context: "Handle the call.",
      steps: [{ id: "start", label: "Start", instructions: "Handle the call." }],
    },
    { id: "fallback", label: "Fallback", kind: "fallback" as const, support_number: "+14155550100" },
  ],
  edges: [
    { from: "entry", to: "topic" },
    { from: "entry", to: "fallback" },
  ],
};
const CURRENT = {
  version: 4,
  instructions: "Current instructions",
  voice: "marin",
  flow: FLOW,
  tool_ids: [],
  mcp_server_ids: [],
  settings: { voice_provider: "openai" },
};
const CTX = {
  orgId: ORG,
  email: "operator@example.test",
  agentId: AGENT,
  origin: "https://app.example.test",
};

function result<T>(rows: T[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

describe("agent activation campaign lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.q.mockResolvedValue([]);
  });

  it.each(["scheduled", "running", "indeterminate"])(
    "refuses active-version changes while a same-tenant campaign is %s",
    async () => {
      const queries: { sql: string; params: unknown[] }[] = [];
      const client = {
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          queries.push({ sql, params });
          if (sql.startsWith("BEGIN") || sql === "ROLLBACK") return result();
          if (sql.includes("FROM agents a") && sql.includes("FOR UPDATE OF a")) return result([CURRENT]);
          if (sql.includes("FROM campaigns c")) return result([{ id: CAMPAIGN }]);
          throw new Error(`unexpected query: ${sql}`);
        }),
        release: vi.fn(),
      };
      mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });

      const outcome = await updateAgent.execute({
        agent_id: AGENT,
        instructions: "Changed instructions",
      } as never, CTX);

      expect(outcome.output).toEqual({
        error: "agent configuration is locked by an active campaign; cancel the campaign before creating and confirming a new runtime",
      });
      const campaignQuery = queries.find(({ sql }) => sql.includes("FROM campaigns c"));
      expect(campaignQuery?.sql).toMatch(
        /c\.status IN \('scheduled','running'\)[\s\S]+c\.status = 'indeterminate'[\s\S]+campaign_dispatch_reconciliations/
      );
      expect(campaignQuery?.sql).toMatch(
        /reconciliation\.campaign_id = c\.id[\s\S]+reconciliation\.org_id = c\.org_id/
      );
      expect(campaignQuery?.params).toEqual([AGENT, ORG]);
      expect(queries.some(({ sql }) => sql.includes("INSERT INTO agent_versions"))).toBe(false);
      expect(queries.some(({ sql }) => sql.startsWith("UPDATE agents"))).toBe(false);
      expect(queries.at(-1)?.sql).toBe("ROLLBACK");
      expect(client.release).toHaveBeenCalledOnce();
    }
  );

  it("activates one append-only version atomically when no campaign holds the runtime", async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.startsWith("BEGIN") || sql === "COMMIT") return result();
        if (sql.includes("FROM agents a") && sql.includes("FOR UPDATE OF a")) return result([CURRENT]);
        if (sql.includes("SELECT c.id FROM campaigns c")) return result();
        if (sql.includes("INSERT INTO agent_versions")) return result([{ version: 5 }]);
        if (sql.startsWith("UPDATE agents a")) return result([{ id: AGENT }]);
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });

    const outcome = await updateAgent.execute({
      agent_id: AGENT,
      name: "Updated",
      flow: { ...FLOW, schema_version: 1, tool_exposure: "direct" },
    } as never, CTX);

    expect(outcome.output).toEqual({ ok: true, version: 5 });
    const insert = queries.find(({ sql }) => sql.includes("INSERT INTO agent_versions"));
    const persistedFlow = JSON.parse(String(insert?.params[3]));
    expect(persistedFlow).toMatchObject({ schema_version: 2, tool_exposure: "gateway" });
    const activation = queries.find(({ sql }) => sql.startsWith("UPDATE agents a"));
    expect(activation?.sql).toMatch(
      /a\.org_id = \$2[\s\S]+NOT EXISTS[\s\S]+c\.status IN \('scheduled','running'\)[\s\S]+c\.status = 'indeterminate'[\s\S]+campaign_dispatch_reconciliations/
    );
    expect(activation?.params).toEqual([AGENT, ORG, 5, "Updated"]);
    expect(queries.at(-1)?.sql).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back the new version if a campaign wins the final activation race", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith("BEGIN") || sql === "ROLLBACK") return result();
        if (sql.includes("FROM agents a") && sql.includes("FOR UPDATE OF a")) return result([CURRENT]);
        if (sql.includes("SELECT c.id FROM campaigns c")) return result();
        if (sql.includes("INSERT INTO agent_versions")) return result([{ version: 5 }]);
        if (sql.startsWith("UPDATE agents a")) return result([], 0);
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });

    const outcome = await updateAgent.execute({ agent_id: AGENT } as never, CTX);

    expect(outcome.output).toEqual({
      error: "agent configuration is locked by an active campaign; cancel the campaign before creating and confirming a new runtime",
    });
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});

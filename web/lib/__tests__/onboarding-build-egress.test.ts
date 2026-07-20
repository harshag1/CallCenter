import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chatJSON: vi.fn(),
  getSession: vi.fn(),
  q: vi.fn(),
  qOne: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("@/lib/xai", () => ({
  chatJSON: mocks.chatJSON,
  MODELS: { operator: "test-operator-model" },
}));
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));

import { POST } from "../../app/api/onboarding/build/route";

const ORIGIN = "https://voice.example.test";
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "00000000-0000-4000-8000-000000000002";
const DESCRIPTION = "A reliable membership support agent that verifies every account action.";
const REQUEST_SHA256 = createHash("sha256").update(DESCRIPTION, "utf8").digest("hex");

function request(): Request {
  return new Request(`${ORIGIN}/api/onboarding/build`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ description: DESCRIPTION }),
  });
}

describe("onboarding build optional-egress and retry boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_ORIGIN", ORIGIN);
    vi.stubEnv("HACC_ENABLE_EXTERNAL_EGRESS", "");
    vi.stubEnv("HACC_ENABLE_ONBOARDING_AI_EGRESS", "");
    mocks.getSession.mockResolvedValue({
      orgId: ORG_ID,
      email: "builder@example.test",
    });
    mocks.q.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds a useful local starter without any provider request in the public-release default", async () => {
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.startsWith("UPDATE orgs")) return { scrape: null };
      if (sql.startsWith("INSERT INTO agents")) return { id: AGENT_ID };
      throw new Error(`unexpected query: ${sql}`);
    });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, agentId: AGENT_ID });
    expect(mocks.chatJSON).not.toHaveBeenCalled();
    expect(mocks.qOne).toHaveBeenCalledWith(
      expect.stringContaining("NOT (COALESCE(onboarding, '{}'::jsonb) ? 'build')"),
      [ORG_ID, REQUEST_SHA256]
    );
    expect(mocks.q.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO agent_versions")
    )).toBe(true);
  });

  it("allows only one concurrent claim and returns conflict without a second provider request", async () => {
    let claimAvailable = true;
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.startsWith("UPDATE orgs")) {
        if (!claimAvailable) return null;
        claimAvailable = false;
        return { scrape: null };
      }
      if (sql.includes("onboarding->'build'->>'request_sha256'")) {
        return {
          request_sha256: REQUEST_SHA256,
          status: "building",
          agent_id: null,
          name: null,
        };
      }
      if (sql.startsWith("INSERT INTO agents")) return { id: AGENT_ID };
      throw new Error(`unexpected query: ${sql}`);
    });

    const [first, second] = await Promise.all([POST(request()), POST(request())]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(mocks.chatJSON).not.toHaveBeenCalled();
    expect(mocks.qOne.mock.calls.filter(([sql]) =>
      String(sql).startsWith("INSERT INTO agents")
    )).toHaveLength(1);
  });

  it("does not treat generic production egress flags as funded AI authority", async () => {
    vi.stubEnv("HACC_ENABLE_EXTERNAL_EGRESS", "true");
    vi.stubEnv("HACC_ENABLE_ONBOARDING_AI_EGRESS", "true");
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.startsWith("UPDATE orgs")) return { scrape: null };
      if (sql.startsWith("INSERT INTO agents")) return { id: AGENT_ID };
      throw new Error(`unexpected query: ${sql}`);
    });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.chatJSON).not.toHaveBeenCalled();
    expect(mocks.q.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO agent_versions")
    )).toBe(true);
  });
});

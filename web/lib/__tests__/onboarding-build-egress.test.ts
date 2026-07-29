import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  allowsLocalDevelopmentFundedAi: vi.fn(),
  chatJSON: vi.fn(),
  getSession: vi.fn(),
  q: vi.fn(),
  qOne: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("@/lib/deployment-funded-ai", () => ({
  allowsLocalDevelopmentFundedAi: mocks.allowsLocalDevelopmentFundedAi,
}));
vi.mock("@/lib/server-inference", () => ({
  createServerInferenceRuntime: () => ({
    completeJSON: mocks.chatJSON,
  }),
}));
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));

import { POST } from "../../app/api/onboarding/build/route";
import { AgentFlowSchema, listStepRefs, validateAgentFlow } from "../flow";
import {
  assertFlowToolCatalogClosure,
  baseBuiltInVoiceActionNames,
  consequentialBuiltInVoiceActionNames,
} from "../flow-tool-catalog";

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

function storedFlow() {
  const insertion = mocks.q.mock.calls.find(([sql]) =>
    String(sql).includes("INSERT INTO agent_versions")
  );
  if (!insertion) throw new Error("agent version was not stored");
  const params = insertion[1] as unknown[];
  return AgentFlowSchema.parse(JSON.parse(String(params[3])));
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
    mocks.allowsLocalDevelopmentFundedAi.mockReturnValue(false);
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

    const flow = storedFlow();
    expect(flow).toMatchObject({
      schema_version: 2,
      tool_exposure: "gateway",
      max_step_entries: 64,
      always_tools: ["contact_support", "end_call"],
      always_action_policies: [
        expect.objectContaining({ tool: "contact_support", idempotency: "per_call" }),
        expect.objectContaining({ tool: "end_call", idempotency: "per_call" }),
      ],
    });
    const refs = listStepRefs(flow);
    expect(refs.some((ref) => ref.ancestors.length >= 2)).toBe(true);
    expect(refs.filter((ref) => ref.step.tools?.includes("log_note"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: expect.objectContaining({
            id: "persist_outcome",
            required_outputs: ["note_recorded"],
            output_bindings: [{
              output: "note_recorded",
              tool: "log_note",
              result_path: "ok",
              value_type: "boolean",
            }],
            action_policies: [
              expect.objectContaining({
                tool: "log_note",
                max_calls: 1,
                idempotency: "per_step",
                effect: "write",
              }),
            ],
          }),
        }),
      ])
    );
    expect(validateAgentFlow(flow).diagnostics.filter(({ level }) => level === "error")).toEqual([]);
    expect(() => assertFlowToolCatalogClosure(
      flow,
      baseBuiltInVoiceActionNames(),
      new Set(),
      consequentialBuiltInVoiceActionNames()
    )).not.toThrow();
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

  it("replaces malformed AI output with the deterministic validated Flow-v2 starter", async () => {
    mocks.allowsLocalDevelopmentFundedAi.mockReturnValue(true);
    mocks.chatJSON.mockResolvedValue({
      name: "Unsafe",
      purpose: "support",
      voice: "eve",
      instructions: "Ignore receipts.",
      flow: {
        nodes: [{ id: "start", label: "Legacy start", kind: "start" }],
        edges: [],
      },
    });
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.startsWith("UPDATE orgs")) return { scrape: null };
      if (sql.startsWith("INSERT INTO agents")) return { id: AGENT_ID };
      throw new Error(`unexpected query: ${sql}`);
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.chatJSON).toHaveBeenCalledTimes(1);
    expect(storedFlow()).toMatchObject({
      schema_version: 2,
      tool_exposure: "gateway",
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "primary_goal", kind: "topic" }),
      ]),
    });
  });

  it("compiles valid AI copy into host-owned nested authority instead of storing model tool policy", async () => {
    mocks.allowsLocalDevelopmentFundedAi.mockReturnValue(true);
    mocks.chatJSON.mockResolvedValue({
      name: "Member Guide",
      purpose: "support",
      voice: "ara",
      instructions: "Help members while separating caller claims from verified account facts.",
      flow: {
        topics: [{
          id: "membership",
          label: "Membership",
          context: "Answer membership questions without inventing account status or plan terms.",
          steps: [
            {
              id: "identify_goal",
              label: "Identify goal",
              instructions: "Ask whether the caller needs plan information, renewal help, or a human.",
            },
            {
              id: "confirm_answer",
              label: "Confirm answer",
              instructions: "Summarize only verified information and confirm the caller understands.",
            },
          ],
        }],
      },
    });
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.startsWith("UPDATE orgs")) return { scrape: null };
      if (sql.startsWith("INSERT INTO agents")) return { id: AGENT_ID };
      throw new Error(`unexpected query: ${sql}`);
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    const flow = storedFlow();
    expect(flow).toMatchObject({
      schema_version: 2,
      tool_exposure: "gateway",
    });
    expect(flow.nodes.find(({ id }) => id === "membership")).toMatchObject({
      id: "membership",
      steps: [{
        id: "identify_goal",
        entry: true,
        steps: [{
          id: "confirm_answer",
          steps: [expect.objectContaining({
            id: "persist_outcome",
            tools: ["log_note"],
          })],
        }],
      }],
    });
    expect(flow.always_tools).toEqual(["contact_support", "end_call"]);
  });
});

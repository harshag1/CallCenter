import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chatJSON: vi.fn(),
  purchaseNumber: vi.fn(),
  q: vi.fn(),
  qOne: vi.fn(),
  researchJSON: vi.fn(),
  resolveFavicon: vi.fn(),
}));

vi.mock("../db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("../xai", () => ({
  MODELS: { fast: "test-fast" },
  chatJSON: mocks.chatJSON,
  researchJSON: mocks.researchJSON,
}));
vi.mock("../favicon", () => ({ resolveFavicon: mocks.resolveFavicon }));
vi.mock("../telephony", () => ({ purchaseNumber: mocks.purchaseNumber }));

import { runOnboardingPrep } from "../onboarding";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "00000000-0000-4000-8000-000000000002";
const SPEC = Object.freeze({
  company: "Example Co",
  bot_name: "Avery",
  persona: "A helpful Example Co receptionist who follows the approved flow.",
  voice: "eve" as const,
  topics: [
    {
      id: "membership",
      label: "Membership",
      icon: "user",
      context: "Help members understand their account without inventing facts.",
      steps: [
        { id: "identify", label: "Identify", instructions: "Ask for the member identifier and confirm it." },
        { id: "assist", label: "Assist", instructions: "Use the approved tools and summarize the result." },
      ],
    },
    {
      id: "returns",
      label: "Returns",
      icon: "rotate-ccw",
      context: "Help callers start a return under the configured policy.",
      steps: [
        { id: "order", label: "Find order", instructions: "Collect and confirm the exact order id." },
        { id: "resolve", label: "Resolve", instructions: "Explain the approved next step and confirm it." },
      ],
    },
  ],
});

function onboardingPatches(): Record<string, unknown>[] {
  return mocks.q.mock.calls
    .filter(([sql]) => String(sql).startsWith("UPDATE orgs SET onboarding"))
    .map(([, params]) => JSON.parse(String((params as unknown[])[1])) as Record<string, unknown>);
}

describe("onboarding funded-action boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HACC_ENABLE_EXTERNAL_EGRESS", "");
    vi.stubEnv("HACC_ENABLE_ONBOARDING_AI_EGRESS", "");
    mocks.q.mockResolvedValue([]);
    mocks.chatJSON.mockResolvedValue(SPEC);
    mocks.researchJSON.mockResolvedValue(SPEC);
    mocks.resolveFavicon.mockResolvedValue(null);
    mocks.purchaseNumber.mockRejectedValue(new Error("provider must never be reached"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds a fresh demo agent without buying or reserving a provider number", async () => {
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.startsWith("UPDATE orgs")) {
        return { domain: null, onboarding: { started: true } };
      }
      if (sql.startsWith("SELECT phone_number FROM users")) return { phone_number: null };
      if (sql.startsWith("INSERT INTO agents")) return { id: AGENT_ID };
      throw new Error(`unexpected onboarding query: ${sql}`);
    });

    await runOnboardingPrep(ORG_ID, "builder@example.test");

    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.chatJSON).not.toHaveBeenCalled();
    expect(mocks.researchJSON).not.toHaveBeenCalled();
    expect(onboardingPatches()).toContainEqual(expect.objectContaining({
      agent_id: AGENT_ID,
      flow_ready: true,
      number_status: "awaiting_operator_provisioning",
    }));
    expect(mocks.q.mock.calls.some(([sql]) => String(sql).includes("phone_number ="))).toBe(false);
  });

  it("converts a legacy failed retry to awaiting approval without provider I/O", async () => {
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.startsWith("UPDATE orgs")) return null;
      return {
        domain: null,
        onboarding: {
          started: true,
          agent_id: AGENT_ID,
          number_status: "failed",
          error: "legacy provider failure",
        },
      };
    });

    await runOnboardingPrep(ORG_ID, "builder@example.test");

    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.chatJSON).not.toHaveBeenCalled();
    expect(onboardingPatches()).toEqual([{
      number_status: "awaiting_operator_provisioning",
    }]);
  });

  it("is provider-free and mutation-free when onboarding is already ready", async () => {
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.startsWith("UPDATE orgs")) return null;
      return {
        domain: null,
        onboarding: {
          started: true,
          agent_id: AGENT_ID,
          number_status: "ready",
          number: "+14155550123",
        },
      };
    });

    await runOnboardingPrep(ORG_ID, "builder@example.test");

    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.chatJSON).not.toHaveBeenCalled();
  });

  it("admits exactly one concurrent prep claim and performs no external generation by default", async () => {
    let claimed = false;
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.startsWith("UPDATE orgs")) {
        if (claimed) return null;
        claimed = true;
        return { domain: null, onboarding: { started: true } };
      }
      if (sql.startsWith("SELECT domain, onboarding FROM orgs")) {
        return { domain: null, onboarding: { started: true } };
      }
      if (sql.startsWith("SELECT phone_number FROM users")) return { phone_number: null };
      if (sql.startsWith("INSERT INTO agents")) return { id: AGENT_ID };
      throw new Error(`unexpected onboarding query: ${sql}`);
    });

    await Promise.all([
      runOnboardingPrep(ORG_ID, "builder@example.test"),
      runOnboardingPrep(ORG_ID, "builder@example.test"),
    ]);

    expect(mocks.qOne.mock.calls.filter(([sql]) =>
      String(sql).startsWith("INSERT INTO agents")
    )).toHaveLength(1);
    expect(mocks.chatJSON).not.toHaveBeenCalled();
    expect(mocks.researchJSON).not.toHaveBeenCalled();
  });

  it("does not treat generic production egress flags as funded AI authority", async () => {
    vi.stubEnv("HACC_ENABLE_EXTERNAL_EGRESS", "true");
    vi.stubEnv("HACC_ENABLE_ONBOARDING_AI_EGRESS", "true");
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.startsWith("UPDATE orgs")) return { domain: null, onboarding: { started: true } };
      if (sql.startsWith("SELECT phone_number FROM users")) return { phone_number: null };
      if (sql.startsWith("INSERT INTO agents")) return { id: AGENT_ID };
      throw new Error(`unexpected onboarding query: ${sql}`);
    });

    await runOnboardingPrep(ORG_ID, "builder@example.test");

    expect(mocks.chatJSON).not.toHaveBeenCalled();
    expect(mocks.researchJSON).not.toHaveBeenCalled();
    expect(onboardingPatches()).toContainEqual(expect.objectContaining({
      agent_id: AGENT_ID,
      flow_ready: true,
      number_status: "awaiting_operator_provisioning",
    }));
  });
});

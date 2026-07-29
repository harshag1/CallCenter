import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  allowsLocalDevelopmentFundedAi: vi.fn(),
  getSession: vi.fn(),
  q: vi.fn(),
  qOne: vi.fn(),
  researchJSON: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("@/lib/server-inference", () => ({
  createServerInferenceRuntime: () => ({
    researchJSON: mocks.researchJSON,
  }),
}));
vi.mock("@/lib/deployment-funded-ai", () => ({
  allowsLocalDevelopmentFundedAi: mocks.allowsLocalDevelopmentFundedAi,
}));
vi.mock("@/lib/log", () => ({ log: () => ({ warn: vi.fn() }) }));
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));

import { GET } from "../../app/api/onboarding/scrape/route";

const SCRAPE = Object.freeze({
  company: "Example",
  description: "Example description",
  industry: "Software",
  suggestions: [],
});

describe("onboarding scrape deployment-funded boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      orgId: "00000000-0000-4000-8000-000000000001",
      orgDomain: "example.test",
    });
    mocks.allowsLocalDevelopmentFundedAi.mockReturnValue(false);
    mocks.qOne.mockResolvedValue({ scrape: null });
    mocks.q.mockResolvedValue([]);
    mocks.researchJSON.mockResolvedValue(SCRAPE);
  });

  it("denies direct, repeated, and concurrent cache-miss generation before provider work", async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => GET()));
    expect(responses.map((response) => response.status)).toEqual(Array(12).fill(200));
    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual(
      Array(12).fill({ scrape: null }),
    );
    expect(mocks.researchJSON).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it("returns an existing tenant cache without requiring funded authority", async () => {
    mocks.qOne.mockResolvedValueOnce({ scrape: SCRAPE });
    const response = await GET();
    expect(await response.json()).toEqual({ scrape: SCRAPE });
    expect(response.headers.get("cache-control")).toContain("private, no-store");
    expect(mocks.researchJSON).not.toHaveBeenCalled();
  });

  it("uses provider research only behind the explicit local-development authority", async () => {
    mocks.allowsLocalDevelopmentFundedAi.mockReturnValue(true);
    const response = await GET();
    expect(await response.json()).toEqual({ scrape: SCRAPE });
    expect(mocks.researchJSON).toHaveBeenCalledOnce();
    expect(mocks.q).toHaveBeenCalledOnce();
  });
});

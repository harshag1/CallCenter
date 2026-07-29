import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  loadCallOperationsProjection: vi.fn(),
  TestConfigurationError: class TestConfigurationError extends Error {},
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/call-operations-store", () => ({
  CallOperationsConfigurationError: mocks.TestConfigurationError,
  loadCallOperationsProjection: mocks.loadCallOperationsProjection,
}));
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));

import { GET } from "../../app/api/calls/[id]/operations/route";

const CALL_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";

function request(): Request {
  return new Request(`https://voice.example.test/api/calls/${CALL_ID}/operations`);
}

function context(id = CALL_ID) {
  return { params: Promise.resolve({ id }) };
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toContain("private, no-store");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("GET /api/calls/:id/operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      email: "operator@example.test",
      orgId: ORG_ID,
      orgDomain: null,
      phoneNumber: null,
      phoneVerifiedAt: null,
    });
    mocks.loadCallOperationsProjection.mockResolvedValue({
      schemaVersion: 1,
      callKey: "a".repeat(64),
      generatedAtMs: 1_800_000_000_000,
      workers: { total: 0, byStatus: {}, items: [] },
      actions: { total: 0, byStatus: {}, indeterminate: [] },
      policy: { observations: 0, denials: 0, byDecision: {}, recentDenials: [] },
      freshness: { active: true, staleSources: [], sources: [] },
      recovery: { observations: 0, byKind: {}, recent: [] },
      attention: [],
    });
  });

  it("authenticates before any call lookup", async () => {
    mocks.getSession.mockResolvedValueOnce(null);

    const response = await GET(request(), context());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.loadCallOperationsProjection).not.toHaveBeenCalled();
    expectPrivate(response);
  });

  it("rejects malformed call identities without storage access", async () => {
    const response = await GET(request(), context("not-a-call"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mocks.loadCallOperationsProjection).not.toHaveBeenCalled();
    expectPrivate(response);
  });

  it("binds the durable read to the authenticated organization", async () => {
    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(mocks.loadCallOperationsProjection).toHaveBeenCalledWith({
      callId: CALL_ID,
      organizationId: ORG_ID,
    });
    const encoded = JSON.stringify(await response.json());
    expect(encoded).toContain("operations");
    expect(encoded).not.toContain(ORG_ID);
    expect(encoded).not.toContain(CALL_ID);
    expectPrivate(response);
  });

  it("makes missing and cross-tenant calls indistinguishable", async () => {
    mocks.loadCallOperationsProjection.mockResolvedValueOnce(null);

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expectPrivate(response);
  });

  it("redacts arbitrary status content again at the HTTP boundary", async () => {
    const privateStatus = "customer-content-accidentally-written-as-status";
    mocks.loadCallOperationsProjection.mockResolvedValueOnce({
      schemaVersion: 1,
      callKey: "a".repeat(64),
      generatedAtMs: 1_800_000_000_000,
      workers: { total: 0, byStatus: {}, items: [] },
      actions: { total: 0, byStatus: {}, indeterminate: [] },
      policy: { observations: 0, denials: 0, byDecision: {}, recentDenials: [] },
      freshness: {
        callStatus: privateStatus,
        active: true,
        staleSources: [],
        sources: [],
      },
      recovery: { observations: 0, byKind: {}, recent: [] },
      attention: [],
    });

    const response = await GET(request(), context());
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text).operations.freshness.callStatus).toBe("redacted_unknown");
    expect(JSON.parse(text).operations.freshness.active).toBe(false);
    expect(text).not.toContain(privateStatus);
    expectPrivate(response);
  });

  it("preserves dialing as an active call at the HTTP boundary", async () => {
    const current = await mocks.loadCallOperationsProjection();
    mocks.loadCallOperationsProjection.mockResolvedValueOnce({
      ...current,
      freshness: {
        ...current.freshness,
        callStatus: "dialing",
        active: false,
      },
    });

    const response = await GET(request(), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.operations.freshness).toMatchObject({
      callStatus: "dialing",
      active: true,
    });
    expectPrivate(response);
  });

  it("fails closed without exposing configuration or database errors", async () => {
    mocks.loadCallOperationsProjection.mockRejectedValueOnce(new mocks.TestConfigurationError("secret detail"));

    const response = await GET(request(), context());

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "operations_unavailable" });
    expect(text).not.toContain("secret detail");
    expectPrivate(response);
  });
});

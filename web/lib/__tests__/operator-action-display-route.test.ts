import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  qOne: vi.fn(),
  verifyCampaignProposalDisplayTargets: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/db", () => ({ qOne: mocks.qOne }));
vi.mock("@/lib/campaigns", () => ({
  verifyCampaignProposalDisplayTargets: mocks.verifyCampaignProposalDisplayTargets,
}));
vi.mock("@/lib/public-origin", async () => import("../public-origin"));
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));

import { POST } from "../../app/api/operator-actions/[id]/display/route";

const APP_ORIGIN = "https://voice.example.test";
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const PROPOSAL_ID = "00000000-0000-4000-8000-000000000003";
const ACTOR_EMAIL = "operator@example.test";
const TARGETS = Object.freeze(["+14155550101", "+14155550102"]);
const AGENT_ID = "00000000-0000-4000-8000-000000000004";
const FLOW_ID = "00000000-0000-4000-8000-000000000005";
const DATASET_ID = "00000000-0000-4000-8000-000000000006";
const RUNTIME_SCOPE_ID = "00000000-0000-4000-8000-000000000007";
const TARGET_SET_SHA256 = "b".repeat(64);
const ARGUMENTS_SHA256 = "a".repeat(64);

function request(options: {
  body?: string;
  headers?: Record<string, string>;
  proposalId?: string;
} = {}): Request {
  return new Request(
    `${APP_ORIGIN}/api/operator-actions/${options.proposalId ?? PROPOSAL_ID}/display`,
    {
      method: "POST",
      headers: {
        origin: APP_ORIGIN,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        ...options.headers,
      },
      body: options.body ?? "{}",
    },
  );
}

function context(proposalId = PROPOSAL_ID) {
  return { params: Promise.resolve({ id: proposalId }) };
}

function proposalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL_ID,
    capability: "run_campaign",
    action_arguments: {
      schema_version: 1,
      action: "run_campaign",
      org_id: ORG_ID,
      agent_id: AGENT_ID,
      flow_id: FLOW_ID,
      dataset_id: DATASET_ID,
      dataset_slug: "customers",
      phone_column: "phone",
      agent_version: 3,
      flow_sha256: "c".repeat(64),
      runtime_admission_scope_id: RUNTIME_SCOPE_ID,
      runtime_digest: "d".repeat(64),
      target_set_sha256: TARGET_SET_SHA256,
      target_count: TARGETS.length,
      skipped_count: 0,
    },
    estimated_units: TARGETS.length,
    private_display: { targets: [...TARGETS] },
    expires_at: "2026-07-16T23:59:59.000Z",
    approved_at: null,
    consumed_execution_id: null,
    // A route must project an allowlist even if a future query adds authority
    // columns to the selected row.
    arguments_sha256: ARGUMENTS_SHA256,
    token_sha256: "server-token-hash-must-not-leak",
    operator_execution_id: "server-execution-id-must-not-leak",
    idempotency_key: "provider-idempotency-key-must-not-leak",
    ...overrides,
  };
}

function expectPrivateResponse(response: Response): void {
  expect(response.headers.get("cache-control")).toContain("private, no-store");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("vary")).toContain("Origin");
  expect(response.headers.get("vary")).toContain("Sec-Fetch-Site");
}

function expectNoAuthorityMaterial(text: string): void {
  for (const forbidden of [
    "action_arguments",
    "private_display",
    "server-token-hash-must-not-leak",
    "server-execution-id-must-not-leak",
    "provider-idempotency-key-must-not-leak",
    "token_sha256",
    "operator_execution_id",
    "idempotency_key",
  ]) {
    expect(text).not.toContain(forbidden);
  }
}

describe("POST /api/operator-actions/:id/display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PUBLIC_ORIGIN", APP_ORIGIN);
    mocks.getSession.mockResolvedValue({
      email: ACTOR_EMAIL,
      orgId: ORG_ID,
      orgDomain: null,
      phoneNumber: null,
      phoneVerifiedAt: null,
    });
    mocks.qOne.mockResolvedValue(proposalRow());
    mocks.verifyCampaignProposalDisplayTargets.mockImplementation((preview, targets) =>
      preview.targetSetSha256 === TARGET_SET_SHA256
      && JSON.stringify(targets) === JSON.stringify(TARGETS)
    );
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["a missing Origin", { origin: "" }],
    ["a cross-origin request", { origin: "https://attacker.example" }],
    ["a cross-site request", { "sec-fetch-site": "cross-site" }],
    ["a same-site request", { "sec-fetch-site": "same-site" }],
  ])("rejects %s before authentication or database access", async (_label, headers) => {
    const response = await POST(request({ headers }), context());

    expect(response.status).toBe(403);
    expectPrivateResponse(response);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-JSON request", "{}", { "content-type": "text/plain" }, 415],
    ["malformed JSON", "{", {}, 400],
    ["an array", "[]", {}, 400],
    ["a nonempty object", JSON.stringify({ proposal_id: PROPOSAL_ID }), {}, 400],
  ])("rejects %s before authentication or database access", async (
    _label,
    body,
    headers,
    expectedStatus,
  ) => {
    const response = await POST(request({ body, headers }), context());

    expect(response.status).toBe(expectedStatus);
    expectPrivateResponse(response);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("requires authentication before proposal lookup", async () => {
    mocks.getSession.mockResolvedValueOnce(null);

    const response = await POST(request(), context());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expectPrivateResponse(response);
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("rejects a malformed opaque proposal id without touching the database", async () => {
    const response = await POST(request({ proposalId: "not-an-opaque-id" }), context("not-an-opaque-id"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expectPrivateResponse(response);
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("scopes lookup to the authenticated org and actor and only live, pending campaign proposals", async () => {
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(mocks.qOne).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.qOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/id\s*=\s*\$1/);
    expect(sql).toMatch(/org_id\s*=\s*\$2/);
    expect(sql).toMatch(/actor_email\s*=\s*\$3/);
    expect(sql).toContain("JOIN users u");
    expect(sql).toContain("JOIN operator_action_policies p");
    expect(sql).toContain("p.enabled = true");
    expect(sql).toContain("u.operator_role IN ('operator','admin')");
    expect(sql).toMatch(/capability\s*=\s*'run_campaign'/);
    expect(sql).toMatch(/expires_at\s*>\s*now\(\)/i);
    expect(sql).toMatch(/approved_at\s+IS\s+NULL/i);
    expect(sql).toMatch(/consumed_execution_id\s+IS\s+NULL/i);
    expect(params).toEqual([PROPOSAL_ID, ORG_ID, ACTOR_EMAIL]);
    expect(mocks.verifyCampaignProposalDisplayTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        agentId: AGENT_ID,
        flowId: FLOW_ID,
        datasetId: DATASET_ID,
        targetSetSha256: TARGET_SET_SHA256,
        targetCount: TARGETS.length,
      }),
      TARGETS,
    );
  });

  it.each([
    "missing",
    "other organization",
    "other actor",
    "expired",
    "already approved",
    "already consumed",
    "non-campaign",
    "role-revoked",
    "policy-disabled",
  ])("makes an %s proposal indistinguishably unavailable", async () => {
    mocks.qOne.mockResolvedValueOnce(null);

    const response = await POST(request(), context());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "proposal_display_unavailable" });
    expectPrivateResponse(response);
    expect(mocks.verifyCampaignProposalDisplayTargets).not.toHaveBeenCalled();
  });

  it("rejects a sorted same-count recipient substitution that does not match the HMAC commitment", async () => {
    const substitutedTargets = [TARGETS[0], "+14155550999"];
    mocks.qOne.mockResolvedValueOnce(proposalRow({
      private_display: { targets: substitutedTargets },
    }));

    const response = await POST(request(), context());
    const responseText = await response.text();

    expect(response.status).toBe(409);
    expect(responseText).toBe('{"error":"proposal_display_integrity_failed"}');
    expect(mocks.verifyCampaignProposalDisplayTargets).toHaveBeenCalledWith(
      expect.objectContaining({ targetSetSha256: TARGET_SET_SHA256 }),
      substitutedTargets,
    );
    expect(responseText).not.toContain("+1");
  });

  it("returns only the exact opaque id, argument commitment, count, and canonical E.164 target list", async () => {
    const response = await POST(request(), context());
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(responseText)).toEqual({
      proposal_id: PROPOSAL_ID,
      arguments_sha256: ARGUMENTS_SHA256,
      target_count: TARGETS.length,
      targets: TARGETS,
    });
    expect(Object.keys(JSON.parse(responseText))).toEqual([
      "proposal_id",
      "arguments_sha256",
      "target_count",
      "targets",
    ]);
    expectPrivateResponse(response);
    expectNoAuthorityMaterial(responseText);
  });

  it.each([
    ["a malformed argument commitment", "not-a-sha256"],
    ["an uppercase noncanonical argument commitment", ARGUMENTS_SHA256.toUpperCase()],
  ])("fails closed on %s", async (_label, argumentsSha256) => {
    mocks.qOne.mockResolvedValueOnce(proposalRow({ arguments_sha256: argumentsSha256 }));

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "proposal_display_integrity_failed" });
    expect(mocks.verifyCampaignProposalDisplayTargets).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-array target value", "not-an-array", TARGETS.length],
    ["an invalid E.164 target", [TARGETS[0], "415-555-0102"], TARGETS.length],
    ["an oversized E.164 target", [TARGETS[0], "+1234567890123456"], TARGETS.length],
    ["a duplicate target", [TARGETS[0], TARGETS[0]], TARGETS.length],
    ["an unsorted target list", [TARGETS[1], TARGETS[0]], TARGETS.length],
    ["a target-count mismatch", [TARGETS[0]], TARGETS.length],
    ["a malformed stored count", [...TARGETS], "2"],
  ])("fails closed on %s without returning any target", async (_label, targets, targetCount) => {
    mocks.qOne.mockResolvedValueOnce(proposalRow({
      private_display: { targets },
      action_arguments: {
        ...proposalRow().action_arguments,
        target_count: targetCount,
      },
    }));

    const response = await POST(request(), context());
    const responseText = await response.text();

    expect(response.status).toBe(409);
    expect(responseText).toBe('{"error":"proposal_display_integrity_failed"}');
    expectPrivateResponse(response);
    expect(responseText).not.toContain("+1");
    expectNoAuthorityMaterial(responseText);
  });

  it.each([
    ["a stored unit-count mismatch", TARGETS.length + 1],
    ["a malformed stored unit count", String(TARGETS.length)],
  ])("fails closed on %s", async (_label, estimatedUnits) => {
    mocks.qOne.mockResolvedValueOnce(proposalRow({ estimated_units: estimatedUnits }));

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "proposal_display_integrity_failed" });
    expectPrivateResponse(response);
  });

  it("never reflects internal errors or private target material", async () => {
    const privateTarget = "+14155559999";
    mocks.qOne.mockRejectedValueOnce(new Error(`database leaked ${privateTarget} token_sha256`));

    const response = await POST(request(), context());
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(responseText).toBe('{"error":"proposal_display_unavailable"}');
    expect(responseText).not.toContain(privateTarget);
    expectNoAuthorityMaterial(responseText);
    expectPrivateResponse(response);
  });
});

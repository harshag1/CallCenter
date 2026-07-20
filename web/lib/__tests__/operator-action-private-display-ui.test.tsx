import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  proposalQuery: vi.fn(),
}));

vi.mock("../db", () => ({
  q: vi.fn(),
  qOne: vi.fn(),
  getPool: mocks.getPool,
}));

import OperatorActionApprovalCard, {
  operatorActionConfirmationFromWire,
  reconcileOperatorActionStatus,
  withOperatorActionApprovalStatus,
  type OperatorActionConfirmationItem,
} from "../../components/chat/OperatorActionApprovalCard";
import { proposeOperatorAction } from "../agent/tools/operator-capability-policy";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const THREAD_ID = "00000000-0000-4000-8000-000000000002";
const PROPOSAL_ID = "00000000-0000-4000-8000-000000000003";
const PRIVATE_TARGETS = Object.freeze(["+14155550101", "+14155550102"]);
const EXPIRES_AT = "2099-07-16T23:59:59.000Z";
const ARGUMENTS_SHA256 = "a".repeat(64);

const authorizationArguments = Object.freeze({
  schema_version: 1,
  action: "run_campaign",
  org_id: ORG_ID,
  target_set_sha256: "b".repeat(64),
  target_count: PRIVATE_TARGETS.length,
  worst_case_micro_usd: 10_000_000,
});

function buttonTag(markup: string): string {
  const match = markup.match(/<button\b[^>]*>/);
  expect(match, "approval button is present").not.toBeNull();
  return match![0];
}

function hasDisabledAttribute(tag: string): boolean {
  return /\sdisabled(?:=""|(?=[\s>]))/.test(tag);
}

describe("private campaign approval display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proposalQuery.mockImplementation(async (rawSql: string) => {
      const sql = rawSql.replace(/\s+/g, " ").trim();
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
        return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
      }
      if (sql.startsWith("WITH scrubbed AS")) {
        return { rows: [{ id: PROPOSAL_ID, expires_at: EXPIRES_AT }], rowCount: 1 };
      }
      throw new Error(`Unhandled proposal SQL: ${sql}`);
    });
    mocks.getPool.mockReturnValue({
      connect: vi.fn(async () => ({ query: mocks.proposalQuery, release: vi.fn() })),
    });
  });

  it("stores private targets without returning them in the proposal or SSE-ready chat item", async () => {
    const proposal = await proposeOperatorAction({
      ctx: {
        orgId: ORG_ID,
        email: "operator@example.test",
        agentId: null,
        origin: "https://voice.example.test",
        threadId: THREAD_ID,
      },
      capability: "run_campaign",
      argumentsValue: authorizationArguments,
      privateDisplay: { targets: PRIVATE_TARGETS },
      estimatedUnits: PRIVATE_TARGETS.length,
      estimatedMicroUsd: 10_000_000,
    });

    const insertion = mocks.proposalQuery.mock.calls.find(([sql]) =>
      String(sql).replace(/\s+/g, " ").trim().startsWith("WITH scrubbed AS")
    );
    expect(insertion).toBeDefined();
    const [sql, params] = insertion as [string, unknown[]];
    expect(sql).toContain("private_display");
    expect(JSON.parse(String(params[8]))).toEqual({ targets: PRIVATE_TARGETS });
    expect(JSON.parse(String(params[4]))).toEqual(authorizationArguments);

    const proposalText = JSON.stringify(proposal);
    expect(proposalText).not.toContain(PRIVATE_TARGETS[0]);
    expect(proposalText).not.toContain(PRIVATE_TARGETS[1]);
    expect(proposalText).not.toContain("privateDisplay");
    expect(proposalText).not.toContain("private_display");

    // Even if a compromised wire event grows extra top-level fields, the
    // browser projection retains only its explicit public allowlist.
    const item = operatorActionConfirmationFromWire({
      ...proposal,
      privateDisplay: { targets: PRIVATE_TARGETS },
      private_display: { targets: PRIVATE_TARGETS },
      approval_token: "must-not-enter-browser-state",
      idempotency_key: "must-not-enter-browser-state",
      execution_id: "must-not-enter-browser-state",
    });
    expect(item).not.toBeNull();
    const itemText = JSON.stringify(item);
    expect(itemText).not.toContain(PRIVATE_TARGETS[0]);
    expect(itemText).not.toContain(PRIVATE_TARGETS[1]);
    expect(itemText).not.toContain("approval_token");
    expect(itemText).not.toContain("idempotency_key");
    expect(itemText).not.toContain("execution_id");
    expect(item!.argumentsSha256).toBe(proposal.argumentsSha256);
    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(item!.arguments)).toBe(true);
    expect(operatorActionConfirmationFromWire({
      ...proposal,
      capability: "custom_but_regex_shaped_action",
    })).toBeNull();
    expect(operatorActionConfirmationFromWire({
      ...proposal,
      argumentsSha256: proposal.argumentsSha256.toUpperCase(),
    })).toBeNull();

    const mutableArguments = { nested: { value: "before" } };
    const cloned = operatorActionConfirmationFromWire({
      ...proposal,
      arguments: mutableArguments,
      argumentsSha256: "c".repeat(64),
    });
    expect(cloned).not.toBeNull();
    mutableArguments.nested.value = "after";
    expect(cloned!.arguments).toEqual({ nested: { value: "before" } });
    expect(cloned!.argumentsSha256).toBe("c".repeat(64));
    expect(Object.isFrozen((cloned!.arguments as { nested: object }).nested)).toBe(true);

    const prototypePayload = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
    ) as Record<string, unknown>;
    const prototypeSafe = operatorActionConfirmationFromWire({
      ...proposal,
      arguments: prototypePayload,
      argumentsSha256: "d".repeat(64),
    });
    expect(prototypeSafe).not.toBeNull();
    expect(Object.getPrototypeOf(prototypeSafe!.arguments)).toBeNull();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(prototypeSafe!.arguments.__proto__).toEqual({ polluted: true });

    const accessorArguments: Record<string, unknown> = {};
    Object.defineProperty(accessorArguments, "to", {
      enumerable: true,
      get: () => "must-not-run@example.test",
    });
    expect(operatorActionConfirmationFromWire({
      ...proposal,
      arguments: accessorArguments,
      argumentsSha256: "e".repeat(64),
    })).toBeNull();

    let tooDeep: Record<string, unknown> = {};
    for (let depth = 0; depth < 66; depth += 1) tooDeep = { nested: tooDeep };
    expect(operatorActionConfirmationFromWire({
      ...proposal,
      arguments: tooDeep,
      argumentsSha256: "f".repeat(64),
    })).toBeNull();

    const approving = withOperatorActionApprovalStatus(item!, PROPOSAL_ID, "approving");
    expect(approving.argumentsSha256).toBe(proposal.argumentsSha256);
    expect(approving.arguments).toBe(item!.arguments);
    expect(Object.isFrozen(approving)).toBe(true);
  });

  it("server-renders campaign confirmation disabled while the exact target list is unresolved", () => {
    const item: OperatorActionConfirmationItem = {
      kind: "operator_action_confirmation",
      proposalId: PROPOSAL_ID,
      capability: "run_campaign",
      arguments: authorizationArguments,
      argumentsSha256: ARGUMENTS_SHA256,
      estimatedUnits: PRIVATE_TARGETS.length,
      worstCaseMicroUsd: 10_000_000,
      expiresAt: EXPIRES_AT,
      status: "pending",
    };

    const markup = renderToStaticMarkup(
      <OperatorActionApprovalCard item={item} onStatusChange={vi.fn()} />,
    );

    expect(hasDisabledAttribute(buttonTag(markup))).toBe(true);
    expect(markup).toContain("Loading the private target list for verification");
    expect(markup).not.toContain(PRIVATE_TARGETS[0]);
    expect(markup).not.toContain(PRIVATE_TARGETS[1]);
    const componentSource = readFileSync(
      new URL("../../components/chat/OperatorActionApprovalCard.tsx", import.meta.url),
      "utf8",
    );
    expect(componentSource).toContain("payload.arguments_sha256 !== item.argumentsSha256");
  });

  it("does not unnecessarily disable a pending non-campaign proposal", () => {
    const item: OperatorActionConfirmationItem = {
      kind: "operator_action_confirmation",
      proposalId: PROPOSAL_ID,
      capability: "send_email",
      arguments: { to: "member@example.test", subject: "Update", message: "Hello" },
      argumentsSha256: ARGUMENTS_SHA256,
      estimatedUnits: 1,
      worstCaseMicroUsd: 10_000,
      expiresAt: EXPIRES_AT,
      status: "pending",
    };

    const markup = renderToStaticMarkup(
      <OperatorActionApprovalCard item={item} onStatusChange={vi.fn()} />,
    );

    expect(hasDisabledAttribute(buttonTag(markup))).toBe(false);
    expect(markup).not.toContain("private target list");
    expect(markup).toContain("Proposal fingerprint");
    expect(markup).toContain(`sha256:${ARGUMENTS_SHA256}`);
  });

  it("renders directional and invisible controls as visible escapes for exact human review", () => {
    const bidi = "\u202e";
    const item: OperatorActionConfirmationItem = {
      kind: "operator_action_confirmation",
      proposalId: PROPOSAL_ID,
      capability: "send_email",
      arguments: {
        to: `member${bidi}@example.test`,
        subject: `Renewal${bidi}txt`,
        message: "Review this exact content",
      },
      argumentsSha256: ARGUMENTS_SHA256,
      estimatedUnits: 1,
      worstCaseMicroUsd: 10_000,
      expiresAt: EXPIRES_AT,
      status: "pending",
    };

    const markup = renderToStaticMarkup(
      <OperatorActionApprovalCard item={item} onStatusChange={vi.fn()} />,
    );

    expect(markup).not.toContain(bidi);
    expect(markup).toContain("\\u202e");
    expect(markup).toContain('dir="ltr"');
  });

  it("keeps campaign approval fail-closed on fetch, identity, count, E.164, uniqueness, or order ambiguity", () => {
    // The repository intentionally has no browser test DOM dependency. This
    // source contract complements the server-render check above by pinning the
    // complete asynchronous transition and request surface.
    const source = readFileSync(
      new URL("../../components/chat/OperatorActionApprovalCard.tsx", import.meta.url),
      "utf8",
    ).replace(/\s+/g, " ");

    expect(source).toContain(
      "`/api/operator-actions/${encodeURIComponent(item.proposalId)}/display`",
    );
    expect(source).toContain('method: "POST"');
    expect(source).toContain('body: "{}"');
    expect(source).toContain('credentials: "same-origin"');
    expect(source).toContain('cache: "no-store"');
    expect(source).toContain('referrerPolicy: "no-referrer"');
    expect(source).toContain("payload.proposal_id !== item.proposalId");
    expect(source).toContain("payload.target_count !== item.estimatedUnits");
    expect(source).toContain("payload.targets.length !== item.estimatedUnits");
    expect(source).toContain("!E164.test(target)");
    expect(source).toContain("new Set(payload.targets).size !== payload.targets.length");
    expect(source).toContain("target !== sortedTargets[index]");
    expect(source).toContain(
      'setCampaignDisplay({ state: "unavailable", proposalId: item.proposalId })',
    );
    expect(source).toContain(
      'campaignDisplayReady = item.capability !== "run_campaign" || currentCampaignDisplay.state === "ready"',
    );
    expect(source).toContain("expired || !campaignDisplayReady");
    expect(source).toContain("Confirmation is disabled; create a fresh proposal.");
    expect(source).toContain("Authoritative result");
    expect(source).toContain("setReceiptSummary(authoritativeSummary(item.capability, payload, status))");
    expect(source).toContain("The raw response object is never retained in component state");
    expect(source).not.toContain("setReceiptSummary(JSON.stringify(payload))");
    expect(source).toContain("delivery is not yet verified");
    expect(source).toContain('succeeded: "Confirmed; see the authoritative result below."');
    expect(source).not.toContain("Email delivered");
    expect(source).not.toContain("SMS delivered");
    expect(source).not.toContain('succeeded: "Confirmed and completed."');
  });
});

describe("operator action response-loss reconciliation", () => {
  function statusResponse(status: number, payload: unknown) {
    return {
      status,
      json: vi.fn(async () => payload),
    };
  }

  it("polls only the read-only PUT ledger route until a terminal receipt is reconstructed", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(statusResponse(202, {
        ok: false,
        status: "pending",
        code: "action_status_pending",
      }))
      .mockResolvedValueOnce(statusResponse(200, {
        ok: true,
        status: "succeeded",
        replayed: true,
      }));
    const wait = vi.fn(async (milliseconds: number) => { void milliseconds; });

    const recovered = await reconcileOperatorActionStatus(PROPOSAL_ID, { fetchImpl, wait });

    expect(recovered).toEqual({
      payload: { ok: true, status: "succeeded", replayed: true },
      status: "succeeded",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(250);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({
        method: "PUT",
        body: "{}",
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      expect(init.method).not.toBe("POST");
    }
  });

  it("retries receipt persistence status but never exceeds four provider-free reads", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(statusResponse(409, {
        ok: false,
        status: "indeterminate",
        code: "authoritative_receipt_unavailable_reconcile_status",
      }))
      .mockResolvedValueOnce(statusResponse(503, { error: "temporary" }))
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(statusResponse(503, { error: "temporary" }));
    const wait = vi.fn(async (milliseconds: number) => { void milliseconds; });

    await expect(reconcileOperatorActionStatus(PROPOSAL_ID, { fetchImpl, wait })).resolves.toBeNull();

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([250, 750, 1_500]);
    expect(fetchImpl.mock.calls.every(([, init]) => init.method === "PUT" && init.body === "{}"))
      .toBe(true);
  });

  it("stops before any status read when the component aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();

    await expect(reconcileOperatorActionStatus(PROPOSAL_ID, {
      signal: controller.signal,
      fetchImpl,
      wait: vi.fn(async (milliseconds: number) => { void milliseconds; }),
    })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

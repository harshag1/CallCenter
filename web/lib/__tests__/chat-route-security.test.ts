import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  runOperator: vi.fn(),
  allowsLocalDevelopmentFundedAi: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/agent/loop", () => ({ runOperator: mocks.runOperator }));
vi.mock("@/lib/deployment-funded-ai", () => ({
  allowsLocalDevelopmentFundedAi: mocks.allowsLocalDevelopmentFundedAi,
}));
vi.mock("@/lib/http", async () => import("../http"));
vi.mock("@/lib/public-origin", async () => import("../public-origin"));
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));

import { POST } from "../../app/api/chat/route";

const APP_ORIGIN = "https://voice.example.test";
const INTERNAL_ORIGIN = "https://internal-proxy.example.test";
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const THREAD_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "00000000-0000-4000-8000-000000000003";
const session = Object.freeze({
  email: "operator@example.test",
  orgId: ORG_ID,
  orgDomain: null,
  phoneNumber: null,
  phoneVerifiedAt: null,
});

function request(options: Readonly<{
  body?: BodyInit;
  headers?: Record<string, string>;
}> = {}): Request {
  return new Request(`${INTERNAL_ORIGIN}/api/chat`, {
    method: "POST",
    headers: {
      origin: APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...options.headers,
    },
    body: options.body ?? JSON.stringify({
      message: "Build a membership assistant",
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      openFlow: { id: `inbound:${AGENT_ID}`, label: "Membership" },
    }),
  });
}

describe("POST /api/chat security boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PUBLIC_ORIGIN", APP_ORIGIN);
    mocks.allowsLocalDevelopmentFundedAi.mockReturnValue(true);
    mocks.getSession.mockResolvedValue(session);
    mocks.runOperator.mockImplementation(() => (async function* () {
      yield { type: "text", text: "Ready." };
      yield { type: "done" };
    })());
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["missing Origin", { origin: "" }],
    ["null Origin", { origin: "null" }],
    ["cross-origin", { origin: "https://attacker.example.test" }],
    ["missing Fetch Metadata", { "sec-fetch-site": "" }],
    ["same-site subdomain", { "sec-fetch-site": "same-site" }],
    ["cross-site", { "sec-fetch-site": "cross-site" }],
  ])("rejects %s before body, auth, or operator work", async (_label, headers) => {
    const response = await POST(request({ body: "{", headers }));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("private, no-store");
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.runOperator).not.toHaveBeenCalled();
  });

  it.each([
    ["text/plain", "{}", { "content-type": "text/plain" }, 415],
    ["malformed JSON", "{", {}, 400],
    ["an array", "[]", {}, 400],
    ["an extra key", JSON.stringify({ message: "hello", threadId: THREAD_ID, authority: true }), {}, 400],
    [
      "a duplicate top-level key",
      `{"message":"safe","m\\u0065ssage":"override","threadId":"${THREAD_ID}"}`,
      {},
      400,
    ],
    [
      "a duplicate nested key",
      `{"message":"safe","threadId":"${THREAD_ID}","openFlow":{"id":"one","\\u0069d":"two"}}`,
      {},
      400,
    ],
    ["an oversized declaration", "{}", { "content-length": "65537" }, 413],
  ])("rejects %s before authentication", async (_label, body, headers, status) => {
    const response = await POST(request({ body, headers }));
    expect(response.status).toBe(status);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.runOperator).not.toHaveBeenCalled();
  });

  it("requires a session after request validation", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.runOperator).not.toHaveBeenCalled();
  });

  it("fails production deployment-funded inference closed under direct, repeated, and concurrent attempts", async () => {
    mocks.allowsLocalDevelopmentFundedAi.mockReturnValue(false);

    const responses = await Promise.all(Array.from({ length: 12 }, () => POST(request())));
    expect(responses.map((response) => response.status)).toEqual(Array(12).fill(503));
    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual(
      Array(12).fill({ error: "deployment_funded_ai_disabled" }),
    );
    expect(mocks.getSession).toHaveBeenCalledTimes(12);
    expect(mocks.runOperator).not.toHaveBeenCalled();
  });

  it("denies a direct request before any operator/provider work when funded authority is unavailable", async () => {
    mocks.allowsLocalDevelopmentFundedAi.mockReturnValue(false);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "deployment_funded_ai_disabled" });
    expect(mocks.runOperator).not.toHaveBeenCalled();
  });

  it("uses only PUBLIC_ORIGIN as downstream authority and returns private SSE", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toContain("private, no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(mocks.runOperator).toHaveBeenCalledWith(
      session,
      THREAD_ID,
      "Build a membership assistant",
      AGENT_ID,
      APP_ORIGIN,
      { id: `inbound:${AGENT_ID}`, label: "Membership" },
      expect.any(AbortSignal),
    );
    expect(await response.text()).toContain('"text":"Ready."');
  });

  it("never reflects provider or dependency error details into the stream", async () => {
    mocks.runOperator.mockImplementationOnce(() => (async function* () {
      if (false) yield undefined;
      throw new Error("Bearer provider-root-secret");
    })());
    const response = await POST(request());
    const text = await response.text();
    expect(text).toContain("operator_request_failed");
    expect(text).not.toContain("provider-root-secret");
    expect(text).not.toContain("Bearer");
  });

  it("aborts the operator turn when the response stream is cancelled", async () => {
    let turnSignal: AbortSignal | undefined;
    mocks.runOperator.mockImplementationOnce((
      _session: unknown,
      _threadId: unknown,
      _message: unknown,
      _agentId: unknown,
      _origin: unknown,
      _openFlow: unknown,
      signal: AbortSignal,
    ) => {
      turnSignal = signal;
      return (async function* () {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (false) yield { type: "done" };
      })();
    });

    const response = await POST(request());
    expect(turnSignal?.aborted).toBe(false);
    await response.body?.cancel();
    expect(turnSignal?.aborted).toBe(true);
  });
});

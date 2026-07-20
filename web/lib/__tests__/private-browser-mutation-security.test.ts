import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  allSessionCookieDeletions: vi.fn(),
  getSession: vi.fn(),
  normalizePhoneNumber: vi.fn(),
  revokePresentedSessions: vi.fn(),
  sessionTokenHash: vi.fn(),
  cookies: vi.fn(),
  q: vi.fn(),
  qOne: vi.fn(),
  waitUntil: vi.fn(),
  analyzeCall: vi.fn(),
  chatJSON: vi.fn(),
  runOnboardingPrep: vi.fn(),
  cancelCampaign: vi.fn(),
  campaignStats: vi.fn(),
  stopExperiment: vi.fn(),
  experimentMetrics: vi.fn(),
  ingestDocument: vi.fn(),
  uploadKindFor: vi.fn(),
  extOf: vi.fn(),
  mimeFor: vi.fn(),
  autoImportCsv: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  allSessionCookieDeletions: mocks.allSessionCookieDeletions,
  AUTH_NO_STORE_HEADERS: { "Cache-Control": "private, no-store" },
  getSession: mocks.getSession,
  normalizePhoneNumber: mocks.normalizePhoneNumber,
  revokePresentedSessions: mocks.revokePresentedSessions,
  sessionTokenHash: mocks.sessionTokenHash,
}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));
vi.mock("@/lib/analysis", () => ({ analyzeCall: mocks.analyzeCall }));
vi.mock("@/lib/xai", () => ({ chatJSON: mocks.chatJSON, MODELS: { operator: "test-model" } }));
vi.mock("@/lib/onboarding", () => ({ runOnboardingPrep: mocks.runOnboardingPrep }));
vi.mock("@/lib/campaigns", () => ({
  cancelCampaign: mocks.cancelCampaign,
  campaignStats: mocks.campaignStats,
}));
vi.mock("@/lib/experiments", () => ({
  stopExperiment: mocks.stopExperiment,
  experimentMetrics: mocks.experimentMetrics,
}));
vi.mock("@/lib/knowledge", () => ({ ingestDocument: mocks.ingestDocument }));
vi.mock("@/lib/files", () => ({
  uploadKindFor: mocks.uploadKindFor,
  extOf: mocks.extOf,
  mimeFor: mocks.mimeFor,
  autoImportCsv: mocks.autoImportCsv,
}));
vi.mock("@/lib/public-origin", async () => import("../public-origin"));
vi.mock("@/lib/private-json-request", async () => import("../private-json-request"));

import { POST as updateSupportNumber } from "../../app/api/agents/[id]/support-number/route";
import { POST as endCall } from "../../app/api/calls/[id]/end/route";
import { POST as appendCallEvents } from "../../app/api/calls/[id]/events/route";
import { POST as logout } from "../../app/api/auth/logout/route";
import { DELETE as stopExperiment } from "../../app/api/experiments/[id]/route";
import { POST as uploadKnowledge } from "../../app/api/knowledge/route";
import { POST as buildOnboardingAgent } from "../../app/api/onboarding/build/route";
import { POST as prepareOnboarding } from "../../app/api/onboarding/prepare/route";
import { POST as cancelScheduledWork } from "../../app/api/scheduled/route";

const APP_ORIGIN = "https://voice.example.test";
const RESOURCE_ID = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id: RESOURCE_ID }) };

type JsonMutation = Readonly<{
  label: string;
  path: string;
  body: Record<string, unknown>;
  invoke(request: Request): Promise<Response>;
}>;

const jsonMutations: readonly JsonMutation[] = [
  {
    label: "support number",
    path: `/api/agents/${RESOURCE_ID}/support-number`,
    body: { number: "+14155550123" },
    invoke: (request) => updateSupportNumber(request, context),
  },
  {
    label: "call events",
    path: `/api/calls/${RESOURCE_ID}/events`,
    body: { events: [] },
    invoke: (request) => appendCallEvents(request, context),
  },
  {
    label: "onboarding build",
    path: "/api/onboarding/build",
    body: { description: "Build a reliable membership support agent." },
    invoke: (request) => buildOnboardingAgent(request),
  },
  {
    label: "scheduled cancellation",
    path: "/api/scheduled",
    body: { cancel_id: RESOURCE_ID },
    invoke: (request) => cancelScheduledWork(request),
  },
];

function jsonRequest(
  route: JsonMutation,
  options: Readonly<{ headers?: Record<string, string>; rawBody?: string }> = {},
): Request {
  return new Request(`${APP_ORIGIN}${route.path}`, {
    method: "POST",
    headers: {
      origin: APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...options.headers,
    },
    body: options.rawBody ?? JSON.stringify(route.body),
  });
}

function noBodyRequest(path: string, method: "POST" | "DELETE", headers: Record<string, string> = {}, body?: string): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers: {
      origin: APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  });
}

function expectNoAuthorityOrSideEffect(): void {
  expect(mocks.revokePresentedSessions).not.toHaveBeenCalled();
  expect(mocks.getSession).not.toHaveBeenCalled();
  expect(mocks.cookies).not.toHaveBeenCalled();
  expect(mocks.q).not.toHaveBeenCalled();
  expect(mocks.qOne).not.toHaveBeenCalled();
  expect(mocks.waitUntil).not.toHaveBeenCalled();
  expect(mocks.analyzeCall).not.toHaveBeenCalled();
  expect(mocks.chatJSON).not.toHaveBeenCalled();
  expect(mocks.runOnboardingPrep).not.toHaveBeenCalled();
  expect(mocks.cancelCampaign).not.toHaveBeenCalled();
  expect(mocks.stopExperiment).not.toHaveBeenCalled();
  expect(mocks.ingestDocument).not.toHaveBeenCalled();
}

describe("remaining private browser mutation boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PUBLIC_ORIGIN", APP_ORIGIN);
    mocks.allSessionCookieDeletions.mockReturnValue([]);
    mocks.getSession.mockResolvedValue(null);
    mocks.revokePresentedSessions.mockResolvedValue(undefined);
    mocks.cookies.mockResolvedValue({ get: vi.fn().mockReturnValue(undefined) });
    mocks.q.mockResolvedValue([]);
    mocks.qOne.mockResolvedValue(null);
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each(jsonMutations)("rejects hostile browser metadata before authority access: $label", async (route) => {
    const hostileHeaders: Record<string, string>[] = [
      { origin: "" },
      { origin: "https://evil.example.test", "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "" },
    ];
    for (const headers of hostileHeaders) {
      const response = await route.invoke(jsonRequest(route, { headers }));
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expectNoAuthorityOrSideEffect();
    }
  });

  it.each(jsonMutations)("rejects simple content types and duplicate keys before authority access: $label", async (route) => {
    const simple = await route.invoke(jsonRequest(route, { headers: { "content-type": "text/plain" } }));
    expect(simple.status).toBe(415);
    expectNoAuthorityOrSideEffect();

    const [key, value] = Object.entries(route.body)[0];
    const duplicate = await route.invoke(jsonRequest(route, {
      rawBody: `{${JSON.stringify(key)}:${JSON.stringify(value)},${JSON.stringify(key)}:${JSON.stringify(value)}}`,
    }));
    expect(duplicate.status).toBe(400);
    expectNoAuthorityOrSideEffect();
  });

  it.each(jsonMutations)("admits only the exact request shape to the auth boundary: $label", async (route) => {
    const response = await route.invoke(jsonRequest(route));
    expect(response.status).toBe(401);
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  const bodyless = [
    {
      label: "end call",
      path: `/api/calls/${RESOURCE_ID}/end`,
      method: "POST" as const,
      invoke: (request: Request) => endCall(request, context),
    },
    {
      label: "prepare onboarding",
      path: "/api/onboarding/prepare",
      method: "POST" as const,
      invoke: (request: Request) => prepareOnboarding(request),
    },
    {
      label: "stop experiment",
      path: `/api/experiments/${RESOURCE_ID}`,
      method: "DELETE" as const,
      invoke: (request: Request) => stopExperiment(request, context),
    },
  ] as const;

  it.each(bodyless)("guards bodyless mutations and rejects smuggled bodies: $label", async (route) => {
    const hostile = await route.invoke(noBodyRequest(route.path, route.method, {
      origin: "https://evil.example.test",
      "sec-fetch-site": "same-site",
      "content-type": "text/plain",
    }, "attack"));
    expect(hostile.status).toBe(403);
    expectNoAuthorityOrSideEffect();

    const unexpectedBody = await route.invoke(noBodyRequest(route.path, route.method, {
      "content-type": "text/plain",
    }, "attack"));
    expect(unexpectedBody.status).toBe(413);
    expectNoAuthorityOrSideEffect();

    const admitted = await route.invoke(noBodyRequest(route.path, route.method));
    expect(admitted.status).toBe(401);
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
  });

  it("guards logout before cookie access and rejects a smuggled body", async () => {
    const hostile = await logout(noBodyRequest("/api/auth/logout", "POST", {
      origin: "https://evil.example.test",
      "sec-fetch-site": "same-site",
    }));
    expect(hostile.status).toBe(403);
    expectNoAuthorityOrSideEffect();

    const unexpectedBody = await logout(noBodyRequest("/api/auth/logout", "POST", {
      "content-type": "text/plain",
    }, "attack"));
    expect(unexpectedBody.status).toBe(413);
    expectNoAuthorityOrSideEffect();
  });

  it("passes the uncollapsed Cookie header to revocation and explicitly expires __Host cookies", async () => {
    const hostBearer = "ab".repeat(32);
    const injectedBearer = "cd".repeat(32);
    const rawCookie = `session_token=${hostBearer}; session_token=${injectedBearer}`;
    mocks.allSessionCookieDeletions.mockReturnValue([
      {
        name: "__Host-hacc_session",
        value: "",
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 0,
        expires: new Date(0),
        path: "/",
      },
      {
        name: "session_token",
        value: "",
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 0,
        expires: new Date(0),
        path: "/",
      },
    ]);

    const response = await logout(noBodyRequest("/api/auth/logout", "POST", {
      cookie: rawCookie,
    }));

    expect(response.status).toBe(200);
    expect(mocks.revokePresentedSessions).toHaveBeenCalledWith(rawCookie);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__Host-hacc_session=");
    expect(setCookie).toMatch(/__Host-hacc_session=.*Path=\/; Expires=.*Max-Age=0; Secure; HttpOnly; SameSite=lax/);
    expect(setCookie).toContain("session_token=");
  });

  it("rejects a hostile same-site multipart upload before session and storage access", async () => {
    const form = new FormData();
    form.set("files", new File(["safe"], "notes.txt", { type: "text/plain" }));
    const request = new Request(`${APP_ORIGIN}/api/knowledge`, {
      method: "POST",
      headers: {
        origin: "https://evil.example.test",
        "sec-fetch-site": "same-site",
      },
      body: form,
    });
    const response = await uploadKnowledge(request);
    expect(response.status).toBe(403);
    expectNoAuthorityOrSideEffect();
  });

  it("does not accept undeclared multipart fields after authentication", async () => {
    mocks.getSession.mockResolvedValueOnce({ email: "owner@example.test", orgId: RESOURCE_ID });
    const form = new FormData();
    form.set("files", new File(["safe"], "notes.txt", { type: "text/plain" }));
    form.set("organization_id", "attacker-controlled");
    const response = await uploadKnowledge(new Request(`${APP_ORIGIN}/api/knowledge`, {
      method: "POST",
      headers: { origin: APP_ORIGIN, "sec-fetch-site": "same-origin" },
      body: form,
    }));
    expect(response.status).toBe(400);
    expect(mocks.q).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.ingestDocument).not.toHaveBeenCalled();
  });

  it("reconstructs error events without durable provider text or undeclared fields", async () => {
    mocks.getSession.mockResolvedValueOnce({ email: "owner@example.test", orgId: RESOURCE_ID });
    mocks.qOne.mockResolvedValueOnce({ id: RESOURCE_ID });
    const providerSecret = "Authorization: Bearer provider-live-secret";
    const callerPii = "alice@example.test";
    const response = await appendCallEvents(jsonRequest({
      label: "call events",
      path: `/api/calls/${RESOURCE_ID}/events`,
      body: {
        events: [{
          type: "error",
          payload: {
            code: "provider_runtime_error",
            provider: "openai",
            message: `${providerSecret}; caller ${callerPii}`,
            nested: { raw: providerSecret },
          },
        }],
      },
      invoke: (request) => appendCallEvents(request, context),
    }), context);

    expect(response.status).toBe(200);
    expect(mocks.q).toHaveBeenCalledTimes(1);
    const insertedPayload = String(mocks.q.mock.calls[0][1][2]);
    expect(JSON.parse(insertedPayload)).toEqual({
      code: "provider_runtime_error",
      provider: "openai",
    });
    expect(insertedPayload).not.toContain("provider-live-secret");
    expect(insertedPayload).not.toContain(callerPii);
  });

  it("rejects unknown or malformed browser journal events atomically", async () => {
    const response = await appendCallEvents(jsonRequest({
      label: "call events",
      path: `/api/calls/${RESOURCE_ID}/events`,
      body: {
        events: [
          { type: "agent_said", payload: { text: "valid event before attack" } },
          {
            type: "provider_debug_dump",
            payload: { message: "Authorization: Bearer provider-live-secret" },
          },
        ],
      },
      invoke: (request) => appendCallEvents(request, context),
    }), context);

    expect(response.status).toBe(400);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
  });
});

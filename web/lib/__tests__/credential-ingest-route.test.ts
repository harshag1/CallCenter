import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  finalizeCredentialIngestSlot: vi.fn(),
}));

vi.mock("../auth", () => ({ getSession: mocks.getSession }));
vi.mock("../credential-vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credential-vault")>();
  return { ...actual, finalizeCredentialIngestSlot: mocks.finalizeCredentialIngestSlot };
});

import { POST } from "../../app/api/credentials/ingest/route";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SLOT_ID = "00000000-0000-4000-8000-000000000009";
const SUBMISSION_ID = "00000000-0000-4000-8000-00000000000a";
const APP_ORIGIN = "https://app.example.test";

function request(
  body: string,
  headers: Record<string, string> = {},
  url = `${APP_ORIGIN}/api/credentials/ingest`
) {
  return new Request(url, {
    method: "POST",
    headers: {
      origin: APP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

function slotBody(credential = "sk-browser-only-secret"): string {
  return JSON.stringify({ slot_id: SLOT_ID, submission_id: SUBMISSION_ID, credential });
}

describe("POST /api/credentials/ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PUBLIC_ORIGIN", APP_ORIGIN);
    mocks.getSession.mockResolvedValue({
      email: "owner@example.test",
      orgId: ORG_ID,
      orgDomain: null,
      phoneNumber: null,
      phoneVerifiedAt: null,
    });
    mocks.finalizeCredentialIngestSlot.mockResolvedValue({
      status: "completed",
      replayed: false,
      receipt: { kind: "env_var", name: "OPENAI_API_KEY" },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("finalizes a non-authorizing slot without returning plaintext or a credential bearer", async () => {
    const plaintext = "sk-browser-only-secret";
    const response = await POST(request(slotBody(plaintext)));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("vary")).toContain("Origin");
    const responseText = await response.text();
    expect(responseText).not.toContain(plaintext);
    expect(responseText).not.toContain("credential_ref");
    expect(JSON.parse(responseText)).toEqual({
      ok: true,
      replayed: false,
      receipt: { kind: "env_var", name: "OPENAI_API_KEY" },
    });
    expect(mocks.finalizeCredentialIngestSlot).toHaveBeenCalledWith({
      orgId: ORG_ID,
      slotId: SLOT_ID,
      submissionId: SUBMISSION_ID,
      credential: plaintext,
    });
  });

  it.each([
    ["missing origin", { origin: "" }],
    ["cross origin", { origin: "https://attacker.example" }],
    ["cross-site fetch metadata", { "sec-fetch-site": "cross-site" }],
    ["same-site but cross-origin fetch metadata", { "sec-fetch-site": "same-site" }],
  ])("rejects %s before session lookup", async (_label, headers) => {
    const response = await POST(request(slotBody("value"), headers));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.finalizeCredentialIngestSlot).not.toHaveBeenCalled();
  });

  it("uses PUBLIC_ORIGIN as the same-origin authority behind a proxy", async () => {
    const response = await POST(request(slotBody("value"), {
      origin: "https://internal-proxy.example",
    }));
    expect(response.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("fails closed in production when PUBLIC_ORIGIN is absent or not HTTPS", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_ORIGIN", "");
    expect((await POST(request(slotBody("value")))).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();

    vi.stubEnv("PUBLIC_ORIGIN", "http://app.example.test");
    expect((await POST(request(slotBody("value"), {
      origin: "http://app.example.test",
    }))).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("requires a valid authenticated session", async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    const response = await POST(request(slotBody("value")));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.finalizeCredentialIngestSlot).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{", {}, 400],
    ["duplicate JSON key", `{"slot_id":"${SLOT_ID}","submission_id":"${SUBMISSION_ID}","credential":"first","credential":"second"}`, {}, 400],
    ["escaped duplicate JSON key", `{"slot_id":"${SLOT_ID}","submission_id":"${SUBMISSION_ID}","credential":"first","cred\\u0065ntial":"second"}`, {}, 400],
    ["unknown field", JSON.stringify({ slot_id: SLOT_ID, submission_id: SUBMISSION_ID, credential: "value", ttl: 999999 }), {}, 400],
    ["missing slot", JSON.stringify({ submission_id: SUBMISSION_ID, credential: "value" }), {}, 400],
    ["missing submission", JSON.stringify({ slot_id: SLOT_ID, credential: "value" }), {}, 400],
    ["invalid slot", JSON.stringify({ slot_id: "model-authored-secret-ref", submission_id: SUBMISSION_ID, credential: "value" }), {}, 400],
    ["invalid submission", JSON.stringify({ slot_id: SLOT_ID, submission_id: "retry-token", credential: "value" }), {}, 400],
    ["empty credential", JSON.stringify({ slot_id: SLOT_ID, submission_id: SUBMISSION_ID, credential: "" }), {}, 400],
    ["wrong content type", slotBody("value"), { "content-type": "text/plain" }, 415],
    ["invalid content length", slotBody("value"), { "content-length": "invalid" }, 400],
    ["oversized content length", slotBody("value"), { "content-length": "9".repeat(100) }, 413],
  ])("rejects %s without finalizing a slot", async (_label, body, headers, status) => {
    const response = await POST(request(body, headers));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.finalizeCredentialIngestSlot).not.toHaveBeenCalled();
  });

  it("enforces an actual streamed-body cap even without a trusted Content-Length", async () => {
    const response = await POST(request(slotBody("x".repeat(256 * 1024))));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
    expect(mocks.finalizeCredentialIngestSlot).not.toHaveBeenCalled();
  });

  it("returns a stable replay receipt without returning the replacement credential", async () => {
    mocks.finalizeCredentialIngestSlot.mockResolvedValueOnce({
      status: "completed",
      replayed: true,
      receipt: { kind: "env_var", name: "OPENAI_API_KEY" },
    });
    const response = await POST(request(slotBody("replacement-must-not-leak")));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      replayed: true,
      receipt: { kind: "env_var", name: "OPENAI_API_KEY" },
    });
  });

  it("does not reveal whether an unavailable slot is expired, busy, or cross-org", async () => {
    mocks.finalizeCredentialIngestSlot.mockResolvedValueOnce({ status: "unavailable" });
    const response = await POST(request(slotBody("value")));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "credential_slot_unavailable" });
  });

  it("does not treat a different credential submission as a successful retry", async () => {
    mocks.finalizeCredentialIngestSlot.mockResolvedValueOnce({ status: "already_used" });
    const response = await POST(request(slotBody("replacement-must-not-be-used")));
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "credential_slot_already_used" });
  });

  it("never returns or logs a plaintext-bearing internal error", async () => {
    const plaintext = "sk-never-in-error";
    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    mocks.finalizeCredentialIngestSlot.mockRejectedValueOnce(
      new Error(`database failure: ${plaintext}`)
    );

    const response = await POST(request(slotBody(plaintext)));
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(responseText).toBe('{"error":"credential_ingest_failed"}');
    expect(responseText).not.toContain(plaintext);
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    consoleSpies.forEach((spy) => spy.mockRestore());
  });
});

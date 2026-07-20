import { createHash } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeSocketInstance = {
  url: string;
  options: Record<string, unknown>;
  sent: string[];
  closed: boolean;
  emitMessage(value: unknown): void;
  emitError(error: Error): void;
};

const mocks = vi.hoisted(() => ({
  q: vi.fn(),
  qOne: vi.fn(),
  loadActiveAgent: vi.fn(),
  voiceSessionSpecForCall: vi.fn(),
  buildProviderSessionUpdate: vi.fn(),
  waitUntil: vi.fn(),
  logError: vi.fn(),
  autoAcknowledge: true,
  sockets: [] as FakeSocketInstance[],
}));

vi.mock("@/lib/db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("@/lib/voice", () => ({
  loadActiveAgent: mocks.loadActiveAgent,
  voiceSessionSpecForCall: mocks.voiceSessionSpecForCall,
}));
vi.mock("@/lib/realtime/registry", () => ({
  buildProviderSessionUpdate: mocks.buildProviderSessionUpdate,
}));
vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));
vi.mock("@/lib/public-origin", () => ({
  requirePublicOrigin: () => "https://voice.example.test",
}));
vi.mock("@/lib/telephony", () => ({
  normalizeE164: (value: unknown) => typeof value === "string" && /^\+[1-9]\d{6,14}$/.test(value) ? value : null,
}));
vi.mock("@/lib/log", () => ({
  log: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.logError }),
}));
vi.mock("ws", () => {
  class FakeWebSocket {
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    private started = false;
    readonly state: FakeSocketInstance;

    constructor(url: URL | string, options: Record<string, unknown>) {
      this.state = {
        url: String(url),
        options,
        sent: [],
        closed: false,
        emitMessage: (value) => {
          const raw = Buffer.from(JSON.stringify(value), "utf8");
          for (const listener of this.handlers.get("message") ?? []) listener(raw);
        },
        emitError: (error) => {
          for (const listener of this.handlers.get("error") ?? []) listener(error);
        },
      };
      mocks.sockets.push(this.state);
    }

    on(name: string, handler: (...args: unknown[]) => void) {
      const listeners = this.handlers.get(name) ?? [];
      listeners.push(handler);
      this.handlers.set(name, listeners);
      if (name === "message" && !this.started) {
        this.started = true;
        queueMicrotask(() => {
          for (const listener of this.handlers.get("open") ?? []) listener();
          if (mocks.autoAcknowledge) this.state.emitMessage({ type: "session.updated" });
        });
      }
      return this;
    }

    send(value: string) {
      this.state.sent.push(String(value));
    }

    close() {
      this.state.closed = true;
      for (const listener of this.handlers.get("close") ?? []) listener();
    }
  }
  return { default: FakeWebSocket };
});

import { POST, _xaiWebhookTest } from "../../app/api/voice/webhooks/route";

const NOW = Date.parse("2026-07-16T20:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW / 1_000);
const SIGNING_SECRET = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString("base64")}`;
const API_KEY = "xai-test-api-key-long-enough";
const WEBHOOK_ID = "evt_delivery_123";
const XAI_CALL_ID = "00000000-0000-4000-8000-000000000021";
const CALL_ID = "00000000-0000-4000-8000-000000000022";
const AGENT_ID = "00000000-0000-4000-8000-000000000023";
const ORG_ID = "00000000-0000-4000-8000-000000000024";
const FROM = "+14155550101";
const TO = "+14155550102";
const SESSION_UPDATE = { type: "session.update", session: { model: "grok-voice" } };

function incomingPayload(overrides: Record<string, unknown> = {}) {
  return {
    object: "event",
    id: "evt_provider_123",
    type: "realtime.call.incoming",
    created_at: NOW_SECONDS,
    data: {
      call_id: XAI_CALL_ID,
      sip_headers: [
        { name: "From", value: `<sip:${FROM}@carrier.example>` },
        { name: "To", value: `<sip:${TO}@voice.example.test>` },
        { name: "X-Trace", value: "trace-123" },
      ],
      metadata: { source: "test" },
    },
    ...overrides,
  };
}

function signedRequest(payload: unknown, options: {
  webhookId?: string;
  timestampSeconds?: number;
  raw?: string;
  signature?: string;
} = {}): Request {
  const raw = options.raw ?? JSON.stringify(payload);
  const webhookId = options.webhookId ?? WEBHOOK_ID;
  const timestamp = options.timestampSeconds ?? NOW_SECONDS;
  const signature = options.signature ?? new Webhook(SIGNING_SECRET)
    .sign(webhookId, new Date(timestamp * 1_000), raw);
  return new Request("https://untrusted-request-host.test/api/voice/webhooks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature,
    },
    body: raw,
  });
}

describe("xAI Standard Webhooks trust boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sockets.length = 0;
    mocks.autoAcknowledge = true;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("XAI_SIP_SIGNING_SECRET", SIGNING_SECRET);
    vi.stubEnv("XAI_API_KEY", API_KEY);
    mocks.q.mockResolvedValue([]);
    mocks.loadActiveAgent.mockResolvedValue({ agent_id: AGENT_ID, org_id: ORG_ID });
    mocks.voiceSessionSpecForCall.mockResolvedValue({ provider: "xai", model: "grok-voice" });
    mocks.buildProviderSessionUpdate.mockReturnValue(SESSION_UPDATE);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("accepts the official SIP header array and rejects map-shaped or malformed provider payloads", () => {
    const valid = incomingPayload();
    expect(_xaiWebhookTest.incomingEvent(valid)).toEqual(valid);
    expect(_xaiWebhookTest.phoneFromSip(`<sip:${FROM}@carrier.example>`)).toBe(FROM);

    expect(_xaiWebhookTest.incomingEvent(incomingPayload({
      data: { call_id: XAI_CALL_ID, sip_headers: { From: FROM, To: TO } },
    }))).toBeNull();
    expect(_xaiWebhookTest.incomingEvent(incomingPayload({
      data: { call_id: "not-a-provider-call-id", sip_headers: [] },
    }))).toBeNull();
    expect(_xaiWebhookTest.incomingEvent(incomingPayload({
      data: { call_id: XAI_CALL_ID, sip_headers: [{ name: "From", value: 42 }] },
    }))).toBeNull();
  });

  it("rejects correctly signed stale and future webhooks before claiming a receipt", async () => {
    const stale = await POST(signedRequest(incomingPayload(), {
      timestampSeconds: NOW_SECONDS - 301,
      webhookId: "evt_stale",
    }));
    expect(stale.status).toBe(401);
    expect(mocks.qOne).not.toHaveBeenCalled();

    const future = await POST(signedRequest(incomingPayload(), {
      timestampSeconds: NOW_SECONDS + 301,
      webhookId: "evt_future",
    }));
    expect(future.status).toBe(401);
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.sockets).toHaveLength(0);
  });

  it("fails closed for a missing signing secret or a forged Standard Webhooks signature", async () => {
    vi.stubEnv("XAI_SIP_SIGNING_SECRET", "");
    expect((await POST(signedRequest(incomingPayload()))).status).toBe(401);
    expect(mocks.qOne).not.toHaveBeenCalled();

    vi.stubEnv("XAI_SIP_SIGNING_SECRET", SIGNING_SECRET);
    const forged = await POST(signedRequest(incomingPayload(), {
      signature: `v1,${Buffer.alloc(32, 7).toString("base64")}`,
    }));
    expect(forged.status).toBe(401);
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.sockets).toHaveLength(0);
  });

  it("turns a processed webhook-id replay into a durable no-op", async () => {
    const payload = incomingPayload();
    const raw = JSON.stringify(payload);
    const payloadSha256 = createHash("sha256").update(raw, "utf8").digest("hex");
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO provider_webhook_receipts")) return null;
      if (sql.includes("SELECT payload_sha256, status")) {
        return { payload_sha256: payloadSha256, status: "processed" };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const response = await POST(signedRequest(payload, { raw }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, duplicate: true });
    expect(mocks.qOne).toHaveBeenCalledTimes(2);
    expect(mocks.loadActiveAgent).not.toHaveBeenCalled();
    expect(mocks.voiceSessionSpecForCall).not.toHaveBeenCalled();
    expect(mocks.sockets).toHaveLength(0);
  });

  it("rejects reuse of a webhook-id for a different payload hash", async () => {
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO provider_webhook_receipts")) return null;
      if (sql.includes("SELECT payload_sha256, status")) {
        return { payload_sha256: "f".repeat(64), status: "processed" };
      }
      return null;
    });

    const response = await POST(signedRequest(incomingPayload()));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "webhook id payload conflict" });
    expect(mocks.sockets).toHaveLength(0);
  });

  it("attaches an authenticated xAI control socket and greets only after session.updated", async () => {
    mocks.qOne.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("INSERT INTO provider_webhook_receipts")) return { webhook_id: WEBHOOK_ID };
      if (sql.includes("FROM agents WHERE phone_number")) {
        expect(params).toEqual([TO]);
        return { id: AGENT_ID, org_id: ORG_ID, version: 7 };
      }
      if (sql.includes("INSERT INTO calls")) {
        expect(params).toEqual([AGENT_ID, 7, FROM, TO, XAI_CALL_ID]);
        return { id: CALL_ID };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const response = await POST(signedRequest(incomingPayload()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.sockets).toHaveLength(1);
    expect(mocks.sockets[0].url).toBe(`wss://api.x.ai/v1/realtime?call_id=${XAI_CALL_ID}`);
    expect(mocks.sockets[0].options).toMatchObject({
      headers: { Authorization: `Bearer ${API_KEY}` },
      handshakeTimeout: 8_000,
      maxPayload: 2 * 1024 * 1024,
    });
    expect(mocks.sockets[0].sent).toEqual([
      JSON.stringify(SESSION_UPDATE),
      JSON.stringify({ type: "response.create" }),
    ]);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.q).toHaveBeenCalledWith(
      expect.stringContaining("status = 'processed'"),
      [WEBHOOK_ID, CALL_ID]
    );
  });

  it("persists content-free events for provider and WebSocket errors after attachment", async () => {
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO provider_webhook_receipts")) return { webhook_id: WEBHOOK_ID };
      if (sql.includes("FROM agents WHERE phone_number")) {
        return { id: AGENT_ID, org_id: ORG_ID, version: 7 };
      }
      if (sql.includes("INSERT INTO calls")) return { id: CALL_ID };
      throw new Error(`unexpected query: ${sql}`);
    });

    expect((await POST(signedRequest(incomingPayload()))).status).toBe(200);
    const providerSecret = "Authorization: Bearer xai-live-secret";
    const callerPii = "alice@example.test";
    mocks.sockets[0].emitMessage({
      type: "error",
      error: { message: `${providerSecret}; caller ${callerPii}` },
    });
    mocks.sockets[0].emitError(new Error(`${providerSecret}; caller ${callerPii}`));
    await vi.waitFor(() => {
      const errors = mocks.q.mock.calls.filter(([sql, params]) =>
        String(sql).includes("INSERT INTO call_events") && params?.[1] === "error");
      expect(errors).toHaveLength(2);
    });

    const errorPayloads = mocks.q.mock.calls
      .filter(([sql, params]) => String(sql).includes("INSERT INTO call_events") && params?.[1] === "error")
      .map(([, params]) => JSON.parse(String(params[2])));
    expect(errorPayloads).toEqual([
      { code: "provider_runtime_error", provider: "xai" },
      { code: "provider_runtime_error", provider: "xai" },
    ]);
    const observable = JSON.stringify({ q: mocks.q.mock.calls, logs: mocks.logError.mock.calls });
    expect(observable).not.toContain("xai-live-secret");
    expect(observable).not.toContain(callerPii);
  });

  it("stores and logs only a stable code when a hostile socket error prevents attachment", async () => {
    mocks.autoAcknowledge = false;
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO provider_webhook_receipts")) return { webhook_id: WEBHOOK_ID };
      if (sql.includes("FROM agents WHERE phone_number")) {
        return { id: AGENT_ID, org_id: ORG_ID, version: 7 };
      }
      if (sql.includes("INSERT INTO calls")) return { id: CALL_ID };
      throw new Error(`unexpected query: ${sql}`);
    });

    const pending = POST(signedRequest(incomingPayload()));
    await vi.waitFor(() => expect(mocks.sockets).toHaveLength(1));
    const providerSecret = "Authorization: Bearer xai-live-secret";
    const callerPii = "alice@example.test";
    mocks.sockets[0].emitError(new Error(`${providerSecret}; caller ${callerPii}`));
    const response = await pending;

    expect(response.status).toBe(503);
    expect(mocks.q).toHaveBeenCalledWith(
      expect.stringContaining("last_error = $2"),
      [WEBHOOK_ID, "sip_attachment_failed"],
    );
    expect(mocks.logError).toHaveBeenCalledWith("xAI SIP webhook failed", {
      callId: CALL_ID,
      code: "sip_attachment_failed",
    });
    const observable = JSON.stringify({ q: mocks.q.mock.calls, logs: mocks.logError.mock.calls });
    expect(observable).not.toContain("xai-live-secret");
    expect(observable).not.toContain(callerPii);
  });
});

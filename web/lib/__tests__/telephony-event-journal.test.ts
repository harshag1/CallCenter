import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  q: vi.fn(),
  qOne: vi.fn(),
  verifyScope: vi.fn(),
  analyzeCall: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("@/lib/voice", () => ({ verifyScope: mocks.verifyScope }));
vi.mock("@/lib/analysis", () => ({ analyzeCall: mocks.analyzeCall }));
vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));

import { POST, _journalTest } from "../../app/api/telephony/events/route";
import { EventJournal } from "../../../bridge/lib/event-journal.js";

const CompilerEventJournal = EventJournal as unknown as new (options: {
  appOrigin: string;
  scope: string;
  sessionId: string;
  fetchImpl: typeof fetch;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}) => InstanceType<typeof EventJournal>;

const CALL_ID = "00000000-0000-4000-8000-000000000031";
const AGENT_ID = "00000000-0000-4000-8000-000000000032";
const ORG_ID = "00000000-0000-4000-8000-000000000033";
const CALL_SID = `CA${"1".repeat(32)}`;
const ACCOUNT_SID = `AC${"2".repeat(32)}`;
const STREAM_SID = `MZ${"3".repeat(32)}`;
const OTHER_STREAM_SID = `MZ${"4".repeat(32)}`;
const TO = "+14155550101";
const TOKEN = "journal_token.signature";

type EventInput = { sequence: number; type: string; payload: unknown };

function event(input: EventInput, sessionId = STREAM_SID) {
  const unsigned = {
    session_id: sessionId,
    sequence: input.sequence,
    type: input.type,
    payload: input.payload,
  };
  return {
    ...unsigned,
    content_sha256: _journalTest.sha256(_journalTest.canonicalJson(unsigned)),
  };
}

function batch(inputs: EventInput[] = [
  { sequence: 1, type: "state", payload: { state: "connected", provider: "openai" } },
  { sequence: 2, type: "user_said", payload: { text: "hello", confidence: 0.98 } },
]) {
  const events = inputs.map((input) => event(input));
  const unsigned = {
    schema_version: 1 as const,
    session_id: STREAM_SID,
    session_sha256: _journalTest.sha256(STREAM_SID),
    first_sequence: events[0]?.sequence ?? null,
    last_sequence: events.at(-1)?.sequence ?? null,
    events,
    complete: false,
  };
  const batchSha256 = _journalTest.sha256(_journalTest.canonicalJson(unsigned));
  return {
    ...unsigned,
    batch_id: `event_batch_${batchSha256}`,
    batch_sha256: batchSha256,
  };
}

function completionBatch() {
  const unsigned = {
    schema_version: 1 as const,
    session_id: STREAM_SID,
    session_sha256: _journalTest.sha256(STREAM_SID),
    first_sequence: null,
    last_sequence: null,
    events: [],
    complete: true,
  };
  const batchSha256 = _journalTest.sha256(_journalTest.canonicalJson(unsigned));
  return {
    ...unsigned,
    batch_id: `event_batch_${batchSha256}`,
    batch_sha256: batchSha256,
  };
}

function request(payload: unknown, idempotencyKey: string, token = TOKEN) {
  return new Request("https://bridge.example.test/api/telephony/bridge/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
}

const scope = {
  callId: CALL_ID,
  agentId: AGENT_ID,
  orgId: ORG_ID,
  provider: "twilio",
  providerCallId: CALL_SID,
  providerAccountId: ACCOUNT_SID,
  providerTo: TO,
  providerStreamId: STREAM_SID,
  transportProvider: "twilio",
};

describe("bridge event journal integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyScope.mockReturnValue(scope);
    mocks.q.mockResolvedValue([]);
    mocks.analyzeCall.mockResolvedValue(undefined);
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("WITH identity_binding AS MATERIALIZED")) return {
        identity_bound: true,
        authority_active: true,
        exact_replay: false,
        conflict: false,
        closed: false,
      };
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("accepts capability authority only from an exact Bearer header", async () => {
    const payload = batch();
    const response = await POST(new Request(
      `https://bridge.example.test/api/telephony/bridge/events?scope=${TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": payload.batch_id,
        },
        body: JSON.stringify(payload),
      }
    ));

    expect(response.status).toBe(401);
    expect(mocks.verifyScope).not.toHaveBeenCalled();
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("canonicalizes nested JSON and cryptographically binds every event and batch", () => {
    expect(_journalTest.canonicalJson({ z: 1, a: { y: 2, x: [3, { b: true, a: null }] } }))
      .toBe('{"a":{"x":[3,{"a":null,"b":true}],"y":2},"z":1}');

    const valid = batch();
    expect(_journalTest.parseBatch(valid, valid.batch_id)).toEqual(valid);

    const tampered = structuredClone(valid);
    tampered.events[0].payload = { state: "privilege-escalated", provider: "openai" };
    expect(_journalTest.parseBatch(tampered, valid.batch_id)).toBeNull();
    expect(_journalTest.parseBatch(valid, `event_batch_${"f".repeat(64)}`)).toBeNull();

    const nonContiguous = batch([
      { sequence: 1, type: "state", payload: {} },
      { sequence: 3, type: "state", payload: {} },
    ]);
    expect(_journalTest.parseBatch(nonContiguous, nonContiguous.batch_id)).toBeNull();
  });

  it("binds journal authorization and storage to the exact call/account/destination/StreamSid tuple", async () => {
    const payload = batch();
    const response = await POST(request(payload, payload.batch_id));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, batch_id: payload.batch_id });
    expect(mocks.verifyScope).toHaveBeenCalledWith(TOKEN, {
      audience: "telephony_events",
      purpose: "event_journal",
      method: "POST",
      provider: "twilio",
    });
    expect(mocks.qOne).toHaveBeenCalledTimes(1);
    expect(String(mocks.qOne.mock.calls[0][0])).toContain("source_content_sha256");
    expect(String(mocks.qOne.mock.calls[0][0])).toContain("ON CONFLICT");
    expect(String(mocks.qOne.mock.calls[0][0])).toContain("status IN ('active','dialing')");
    expect(String(mocks.qOne.mock.calls[0][0])).toContain("stopped_at IS NULL");
    expect(mocks.qOne.mock.calls[0][1]).toEqual([
      CALL_ID,
      STREAM_SID,
      JSON.stringify(payload.events),
      payload.batch_id,
      payload.batch_sha256,
      1,
      2,
      2,
      false,
      CALL_SID,
      ACCOUNT_SID,
      TO,
      AGENT_ID,
      ORG_ID,
    ]);
  });

  it("accepts the standalone bridge journal wire format with StreamSid as its stable session identity", async () => {
    const deliveries: Array<{ url: string; init: RequestInit; wire: Record<string, unknown> }> = [];
    const journal = new CompilerEventJournal({
      appOrigin: "https://voice.example.test",
      scope: TOKEN,
      sessionId: STREAM_SID,
      maxAttempts: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
      sleep: async () => undefined,
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
        deliveries.push({ url: String(input), init: init ?? {}, wire });
        return POST(new Request(input, init));
      },
    });

    expect(journal.snapshot()).toMatchObject({
      session_id: STREAM_SID,
      session_sha256: _journalTest.sha256(STREAM_SID),
      next_sequence: 1,
    });
    journal.append("provider.ready", { provider: "openai", transport: "twilio" });
    const result = await journal.flush();

    expect(result).toMatchObject({
      ok: true,
      acknowledged_batches: 1,
      acknowledged_events: 1,
      pending_events: 0,
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].url).toBe("https://voice.example.test/api/telephony/bridge/events");
    expect(new Headers(deliveries[0].init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(deliveries[0].init.headers).get("idempotency-key"))
      .toBe(deliveries[0].wire.batch_id);
    expect(deliveries[0].wire).toMatchObject({
      schema_version: 1,
      session_id: STREAM_SID,
      session_sha256: _journalTest.sha256(STREAM_SID),
      first_sequence: 1,
      last_sequence: 1,
      complete: false,
    });
    expect((deliveries[0].wire.events as Array<Record<string, unknown>>)[0]).toMatchObject({
      session_id: STREAM_SID,
      sequence: 1,
      type: "provider.ready",
      payload: { provider: "openai", transport: "twilio" },
    });
    expect(mocks.verifyScope).toHaveBeenCalledWith(TOKEN, {
      audience: "telephony_events",
      purpose: "event_journal",
      method: "POST",
      provider: "twilio",
    });
    expect(mocks.qOne.mock.calls[0][1][1]).toBe(STREAM_SID);
  });

  it("makes an exact retry a success while surfacing durable idempotency conflicts", async () => {
    const payload = batch();
    const first = await POST(request(payload, payload.batch_id));
    const retry = await POST(request(payload, payload.batch_id));
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);

    mocks.qOne.mockResolvedValue({
      identity_bound: true,
      authority_active: true,
      exact_replay: false,
      conflict: true,
      closed: false,
    });
    const conflict = await POST(request(payload, payload.batch_id));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "idempotency conflict" });
  });

  it("rejects a mismatched StreamSid or broken hash before querying the binding", async () => {
    const payload = batch();
    mocks.verifyScope.mockReturnValue({ ...scope, providerStreamId: OTHER_STREAM_SID });
    expect((await POST(request(payload, payload.batch_id))).status).toBe(400);
    expect(mocks.qOne).not.toHaveBeenCalled();

    mocks.qOne.mockClear();
    mocks.verifyScope.mockReturnValue(scope);
    const tampered = structuredClone(payload);
    tampered.events[0].content_sha256 = "0".repeat(64);
    expect((await POST(request(tampered, tampered.batch_id))).status).toBe(400);
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it.each([
    ["top-level duplicate", (payload: ReturnType<typeof batch>) => (
      `{"schema_version":1,"schema_version":1,${JSON.stringify(payload).slice(1)}`
    )],
    ["escape-equivalent nested duplicate", (payload: ReturnType<typeof batch>) => {
      const raw = JSON.stringify(payload);
      return raw.replace('"state":"connected"', '"state":"connected","st\\u0061te":"forged"');
    }],
  ])("rejects %s keys before durable binding access", async (_label, rawBody) => {
    const payload = batch();
    const response = await POST(new Request(
      "https://bridge.example.test/api/telephony/bridge/events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          "Idempotency-Key": payload.batch_id,
        },
        body: rawBody(payload),
      },
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid JSON" });
    expect(mocks.verifyScope).toHaveBeenCalledTimes(1);
    expect(mocks.qOne).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it("fails closed when the durable stream identity binding is absent", async () => {
    mocks.qOne.mockResolvedValueOnce({
      identity_bound: false,
      authority_active: false,
      exact_replay: false,
      conflict: false,
      closed: false,
    });
    const payload = batch();
    const response = await POST(request(payload, payload.batch_id));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "stream binding not found" });
    expect(mocks.qOne).toHaveBeenCalledTimes(1);
  });

  it("terminates event authority with the call while preserving only exact durable retries", async () => {
    const payload = batch();
    mocks.qOne.mockResolvedValueOnce({
      identity_bound: true,
      authority_active: false,
      exact_replay: false,
      conflict: false,
      closed: false,
    });
    const staleAppend = await POST(request(payload, payload.batch_id));
    expect(staleAppend.status).toBe(403);
    expect(await staleAppend.json()).toEqual({ error: "stream authority is no longer active" });

    mocks.qOne.mockResolvedValueOnce({
      identity_bound: true,
      authority_active: false,
      exact_replay: true,
      conflict: false,
      closed: false,
    });
    const lostResponseRetry = await POST(request(payload, payload.batch_id));
    expect(lostResponseRetry.status).toBe(200);
    expect(await lostResponseRetry.json()).toEqual({ ok: true, batch_id: payload.batch_id });
  });

  it("atomically journals completion, stops the stream, and closes the agent call", async () => {
    const payload = completionBatch();
    mocks.qOne.mockResolvedValueOnce({
      identity_bound: true,
      authority_active: true,
      exact_replay: false,
      conflict: false,
      closed: true,
    });
    const completed = await POST(request(payload, payload.batch_id));

    expect(completed.status).toBe(200);
    const sql = String(mocks.qOne.mock.calls[0][0]);
    expect(sql).toContain("UPDATE telephony_stream_bindings");
    expect(sql).toContain("UPDATE calls");
    expect(sql).toContain("EXISTS (SELECT 1 FROM inserted_batch)");
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.analyzeCall).toHaveBeenCalledWith(CALL_ID);
  });
});

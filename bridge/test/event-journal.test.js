import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  EventJournal,
  EventJournalCapacityError,
  EventJournalDeliveryError,
  EventJournalStateError,
  createEventJournal,
} from "../lib/event-journal.js";

const ORIGIN = "https://calls.example.test";
const SCOPE = "signed.scope_token-123";
const SESSION = "call-session-001";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function acknowledgement(batchId, { status = 200, body, contentType = "application/json" } = {}) {
  return new Response(body ?? JSON.stringify({ ok: true, batch_id: batchId }), {
    status,
    headers: { "Content-Type": contentType },
  });
}

function requestBody(init) {
  return JSON.parse(init.body);
}

function journal(overrides = {}) {
  return new EventJournal({
    appOrigin: ORIGIN,
    scope: SCOPE,
    sessionId: SESSION,
    retryBaseMs: 10,
    retryMaxMs: 1_000,
    sleep: async () => {},
    fetchImpl: async (_url, init) => acknowledgement(requestBody(init).batch_id),
    ...overrides,
  });
}

describe("EventJournal", () => {
  it("pins delivery to an injectable same-origin HTTPS path", async () => {
    for (const options of [
      { appOrigin: "http://calls.example.test" },
      { appOrigin: "http://calls.example.test", allowInsecureLocalhost: true },
      { appOrigin: "https://user:secret@calls.example.test" },
      { appOrigin: `${ORIGIN}?redirect=https://evil.test` },
      { endpointPath: "https://evil.test/collect" },
      { endpointPath: "//evil.test/collect" },
      { endpointPath: "/collect?next=https://evil.test" },
      { endpointPath: "/collect\\evil" },
    ]) {
      assert.throws(() => journal(options), /HTTPS origin|same-origin path/);
    }

    const requests = [];
    const instance = journal({
      appOrigin: `${ORIGIN}/ignored/base/path`,
      endpointPath: "/internal/event-ingest/v2",
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return acknowledgement(requestBody(init).batch_id);
      },
    });
    instance.append("agent_said", { text: "hello" });
    await instance.flush();

    assert.equal(requests[0].url, `${ORIGIN}/internal/event-ingest/v2`);
    assert.equal(requests[0].init.redirect, "error");
    assert.equal(requests[0].init.credentials, "omit");
    assert.equal(requests[0].init.referrerPolicy, "no-referrer");

    const localRequests = [];
    const local = journal({
      appOrigin: "http://127.0.0.1:3000",
      allowInsecureLocalhost: true,
      fetchImpl: async (url, init) => {
        localRequests.push(url);
        return acknowledgement(requestBody(init).batch_id);
      },
    });
    local.append("local_test", {});
    await local.flush();
    assert.equal(localRequests[0], "http://127.0.0.1:3000/api/telephony/bridge/events");
    assert.throws(
      () => journal({ appOrigin: "http://localhost:3000" }),
      /HTTPS origin/,
    );
  });

  it("assigns stable session sequences and canonical content hashes", async () => {
    const original = { nested: { z: 3, a: 1 }, list: [true, null, "x"] };
    const firstRequests = [];
    const secondRequests = [];
    const first = journal({
      fetchImpl: async (_url, init) => {
        firstRequests.push(init);
        return acknowledgement(requestBody(init).batch_id);
      },
    });
    const second = journal({
      fetchImpl: async (_url, init) => {
        secondRequests.push(init);
        return acknowledgement(requestBody(init).batch_id);
      },
    });

    const event = first.append("provider.event", original);
    second.append("provider.event", { list: [true, null, "x"], nested: { a: 1, z: 3 } });
    original.nested.a = 999;
    first.append("provider.event", { n: 2 });

    assert.equal(event.sequence, 1);
    assert.equal(event.payload.nested.a, 1);
    assert.match(event.content_sha256, /^[a-f0-9]{64}$/);
    assert.equal(first.nextSequence, 3);
    assert(Object.isFrozen(event));
    assert(Object.isFrozen(event.payload.nested));

    await first.flush();
    await second.flush();
    const firstBody = requestBody(firstRequests[0]);
    const secondBody = requestBody(secondRequests[0]);
    assert.equal(firstBody.events[0].content_sha256, secondBody.events[0].content_sha256);
    assert.equal(firstBody.events[0].sequence, 1);
    assert.equal(firstBody.events[1].sequence, 2);
    assert.equal(firstBody.session_sha256, sha256(SESSION));
    assert.equal(firstBody.schema_version, 1);
    assert.equal(firstBody.first_sequence, 1);
    assert.equal(firstBody.last_sequence, 2);
  });

  it("rejects non-JSON payloads without consuming a sequence", () => {
    const instance = journal();
    const cyclic = {};
    cyclic.self = cyclic;

    assert.throws(() => instance.append("bad", cyclic), /cycles/);
    assert.throws(() => instance.append("bad", { value: Number.NaN }), /finite/);
    assert.throws(() => instance.append("bad", { value: undefined }), /JSON values/);
    assert.equal(instance.nextSequence, 1);
    assert.equal(instance.pendingCount, 0);
  });

  it("applies count backpressure before mutating queue or sequence", async () => {
    const instance = journal({ maxQueuedEvents: 1, maxBatchEvents: 1 });
    instance.append("one", {});
    assert.throws(() => instance.append("two", {}), EventJournalCapacityError);
    assert.equal(instance.pendingCount, 1);
    assert.equal(instance.nextSequence, 2);

    await instance.flush();
    const second = instance.append("two", {});
    assert.equal(second.sequence, 2);
  });

  it("reserves terminal capacity when ordinary telemetry saturates its allowance", () => {
    const instance = journal({
      maxQueuedEvents: 3,
      maxBatchEvents: 3,
      terminalReserveEvents: 1,
      terminalReserveBytes: 1,
    });
    instance.append("ordinary.one", {});
    instance.append("ordinary.two", {});
    assert.throws(() => instance.append("ordinary.three", {}), EventJournalCapacityError);

    const terminal = instance.appendTerminal("session.failure", { code: "journal_saturated" });
    assert.equal(terminal.sequence, 3);
    assert.equal(instance.pendingCount, 3);
    assert.equal(instance.nextSequence, 4);
  });

  it("applies exact serialized-byte backpressure and keeps accepted events", () => {
    const instance = journal({
      maxQueuedBytes: 520,
      maxBatchBytes: 520,
      maxQueuedEvents: 10,
      maxBatchEvents: 10,
    });
    instance.append("chunk", { value: "a".repeat(100) });
    const acceptedBytes = instance.pendingBytes;
    assert(acceptedBytes > 100);
    assert.throws(
      () => instance.append("chunk", { value: "b".repeat(300) }),
      EventJournalCapacityError,
    );
    assert.equal(instance.pendingCount, 1);
    assert.equal(instance.pendingBytes, acceptedBytes);
    assert.equal(instance.nextSequence, 2);
  });

  it("coalesces concurrent flush calls into one in-flight request", async () => {
    let resolveFetch;
    let fetchCalls = 0;
    const instance = journal({
      maxAttempts: 1,
      fetchImpl: async (_url, init) => {
        fetchCalls += 1;
        return new Promise((resolve) => {
          resolveFetch = () => resolve(acknowledgement(requestBody(init).batch_id));
        });
      },
    });
    instance.append("state", { state: "bridged" });

    const first = instance.flush();
    const second = instance.flush();
    assert.strictEqual(first, second);
    await Promise.resolve();
    assert.equal(fetchCalls, 1);
    assert.equal(instance.inFlight, true);
    resolveFetch();
    await Promise.all([first, second]);
    assert.equal(fetchCalls, 1);
    assert.equal(instance.inFlight, false);
    assert.equal(instance.pendingCount, 0);
  });

  it("bounds normal flush fetch and acknowledgement-body stalls without losing the batch", async () => {
    let fetchSignal;
    const stalledFetch = journal({
      maxAttempts: 1,
      requestTimeoutMs: 5,
      fetchImpl: async (_url, init) => {
        fetchSignal = init.signal;
        return new Promise(() => {});
      },
    });
    stalledFetch.append("retain.fetch", {});
    await assert.rejects(stalledFetch.flush(), EventJournalDeliveryError);
    assert.equal(fetchSignal.aborted, true);
    assert.equal(stalledFetch.pendingCount, 1);

    let bodySignal;
    const stalledBody = journal({
      maxAttempts: 1,
      requestTimeoutMs: 5,
      fetchImpl: async (_url, init) => {
        bodySignal = init.signal;
        return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    stalledBody.append("retain.body", {});
    await assert.rejects(stalledBody.flush(), EventJournalDeliveryError);
    assert.equal(bodySignal.aborted, true);
    assert.equal(stalledBody.pendingCount, 1);
  });

  it("retains a batch until a strict 2xx acknowledgement echoes its id", async () => {
    const requests = [];
    let responseMode = "legacy";
    const instance = journal({
      maxAttempts: 1,
      fetchImpl: async (_url, init) => {
        requests.push(init);
        const id = requestBody(init).batch_id;
        if (responseMode === "legacy") return acknowledgement(id, { body: JSON.stringify({ ok: true }) });
        if (responseMode === "redirect") return acknowledgement(id, { status: 302 });
        if (responseMode === "wrong") return acknowledgement(id, { body: JSON.stringify({ ok: true, batch_id: "wrong" }) });
        if (responseMode === "text") return acknowledgement(id, { contentType: "text/plain" });
        return acknowledgement(id, { status: 299 });
      },
    });
    instance.append("user_said", { text: "do not lose me" });

    for (const mode of ["legacy", "redirect", "wrong", "text"]) {
      responseMode = mode;
      await assert.rejects(instance.flush(), EventJournalDeliveryError);
      assert.equal(instance.pendingCount, 1);
      assert.equal(instance.activeBatchId, requestBody(requests[0]).batch_id);
    }

    responseMode = "good";
    await instance.flush();
    assert.equal(instance.pendingCount, 0);
    assert.equal(requests.length, 5);
    assert(requests.every((request) => request.body === requests[0].body));
    assert(requests.every((request) => request.headers["Idempotency-Key"] === requestBody(request).batch_id));
  });

  it("rejects duplicate-key, extra-field, and oversized acknowledgements", async () => {
    let mode = "duplicate";
    const instance = journal({
      maxAttempts: 1,
      fetchImpl: async (_url, init) => {
        const id = requestBody(init).batch_id;
        const body = mode === "duplicate"
          ? `{"ok":false,"ok":true,"batch_id":"${id}"}`
          : mode === "extra"
            ? JSON.stringify({ ok: true, batch_id: id, ignored: true })
            : mode === "oversized"
              ? JSON.stringify({ ok: true, batch_id: id, padding: "x".repeat(20_000) })
              : JSON.stringify({ ok: true, batch_id: id });
        return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    instance.append("retain.me", {});
    for (const invalid of ["duplicate", "extra", "oversized"]) {
      mode = invalid;
      await assert.rejects(instance.flush(), EventJournalDeliveryError);
      assert.equal(instance.pendingCount, 1);
    }
    mode = "valid";
    await instance.flush();
    assert.equal(instance.pendingCount, 0);
  });

  it("retries exponentially with the exact same body, batch id, and idempotency header", async () => {
    const requests = [];
    const delays = [];
    const instance = journal({
      maxAttempts: 4,
      retryBaseMs: 10,
      retryMaxMs: 25,
      sleep: async (ms) => delays.push(ms),
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        if (requests.length === 1) throw new Error(`transport failed for ${SCOPE}`);
        if (requests.length === 2) return acknowledgement(requestBody(init).batch_id, { status: 503 });
        return acknowledgement(requestBody(init).batch_id);
      },
    });
    instance.append("error", { recoverable: true });
    await instance.flush();

    assert.deepEqual(delays, [10, 20]);
    assert.equal(requests.length, 3);
    assert(requests.every(({ url }) => url === `${ORIGIN}/api/telephony/bridge/events`));
    assert(requests.every(({ init }) => init.body === requests[0].init.body));
    const id = requestBody(requests[0].init).batch_id;
    assert(requests.every(({ init }) => init.headers["Idempotency-Key"] === id));
    assert.equal(instance.pendingCount, 0);
  });

  it("pins an in-flight request but retries its retained unchanged batch under the current rotated scope", async () => {
    const oldScope = SCOPE;
    const newScope = "signed.rotated_scope-456";
    const requests = [];
    let now = 0;
    let settleOldRequest;
    const instance = journal({
      maxAttempts: 1,
      clock: () => now,
      fetchImpl: (_url, init) => {
        requests.push({ init, startedAt: now });
        const body = requestBody(init);
        if (requests.length === 1) {
          return new Promise((resolve) => {
            settleOldRequest = () => resolve(acknowledgement(body.batch_id, { status: 503 }));
          });
        }
        return Promise.resolve(acknowledgement(body.batch_id));
      },
    });

    instance.append("before.rotation", {});
    const firstFlush = instance.flush();
    await Promise.resolve();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init.headers.Authorization, `Bearer ${oldScope}`);

    // Rotate near the end of the old capability's overlap, then let the old
    // in-flight request settle after that window. Its already-built headers
    // remain old, but the retry must be able to use the current capability.
    now = 29 * 60_000;
    instance.rotateScope(newScope);
    now = 31 * 60_000;
    settleOldRequest();
    await assert.rejects(firstFlush, EventJournalDeliveryError);
    assert.equal(instance.pendingCount, 1);
    assert.equal(instance.activeBatchId, requestBody(requests[0].init).batch_id);

    // A later flush retries the retained batch. Only its request authority may
    // change; its content-addressed body and idempotency identity may not.
    await instance.flush();

    instance.append("after.rotation", {});
    await instance.flush();
    assert.deepEqual(
      requests.map(({ init }) => init.headers.Authorization),
      [`Bearer ${oldScope}`, `Bearer ${newScope}`, `Bearer ${newScope}`],
    );
    assert.equal(requests[0].startedAt, 0);
    assert.equal(requests[1].startedAt, 31 * 60_000);
    assert.equal(requests[0].init.body, requests[1].init.body);
    assert.equal(
      requests[0].init.headers["Idempotency-Key"],
      requests[1].init.headers["Idempotency-Key"],
    );
    assert.equal(
      requestBody(requests[0].init).batch_id,
      requestBody(requests[1].init).batch_id,
    );
    assert.notEqual(requests[1].init.body, requests[2].init.body);
    assert.equal(instance.pendingCount, 0);
    assert.equal(JSON.stringify(instance.snapshot()).includes(newScope), false);
  });

  it("drains multiple bounded batches in sequence", async () => {
    const bodies = [];
    const instance = journal({
      maxQueuedEvents: 10,
      maxBatchEvents: 2,
      fetchImpl: async (_url, init) => {
        const body = requestBody(init);
        bodies.push(body);
        return acknowledgement(body.batch_id);
      },
    });
    for (let i = 0; i < 5; i += 1) instance.append("turn", { i });
    const result = await instance.flush();

    assert.equal(result.acknowledged_batches, 3);
    assert.equal(result.acknowledged_events, 5);
    assert.deepEqual(bodies.map((body) => body.events.length), [2, 2, 1]);
    assert.deepEqual(bodies.map((body) => body.first_sequence), [1, 3, 5]);
    assert.deepEqual(bodies.map((body) => body.last_sequence), [2, 4, 5]);
    assert.equal(new Set(bodies.map((body) => body.batch_id)).size, 3);
    assert.equal(instance.pendingCount, 0);
    assert.equal(instance.pendingBytes, 0);
  });

  it("does not lose events appended while the first batch is in flight", async () => {
    let resolveFirst;
    const bodies = [];
    const instance = journal({
      maxQueuedEvents: 10,
      maxBatchEvents: 1,
      fetchImpl: async (_url, init) => {
        const body = requestBody(init);
        bodies.push(body);
        if (bodies.length === 1) {
          return new Promise((resolve) => {
            resolveFirst = () => resolve(acknowledgement(body.batch_id));
          });
        }
        return acknowledgement(body.batch_id);
      },
    });
    instance.append("turn", { i: 1 });
    const flushing = instance.flush();
    await Promise.resolve();
    instance.append("turn", { i: 2 });
    resolveFirst();
    await flushing;

    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies.map((body) => body.events[0].sequence), [1, 2]);
    assert.equal(instance.pendingCount, 0);
  });

  it("emits completion after all events exactly once and seals the journal", async () => {
    const bodies = [];
    const instance = journal({
      fetchImpl: async (_url, init) => {
        const body = requestBody(init);
        bodies.push(body);
        return acknowledgement(body.batch_id);
      },
    });
    instance.append("agent_said", { text: "goodbye" });
    const first = instance.complete();
    const second = instance.complete();
    assert.strictEqual(first, second);
    await first;

    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].complete, false);
    assert.equal(bodies[0].events.length, 1);
    assert.equal(bodies[1].complete, true);
    assert.equal(bodies[1].events.length, 0);
    assert.equal(bodies[1].first_sequence, null);
    assert.equal(bodies[1].last_sequence, null);
    assert.equal(instance.completionAcknowledged, true);
    assert.throws(() => instance.append("late", {}), EventJournalStateError);

    await instance.complete();
    await instance.shutdown();
    assert.equal(bodies.length, 2);
  });

  it("retries a lost completion acknowledgement under one stable identity", async () => {
    const completionRequests = [];
    let completionAttempts = 0;
    const instance = journal({
      maxAttempts: 3,
      fetchImpl: async (_url, init) => {
        const body = requestBody(init);
        if (!body.complete) return acknowledgement(body.batch_id);
        completionRequests.push(init);
        completionAttempts += 1;
        if (completionAttempts === 1) return acknowledgement(body.batch_id, { body: JSON.stringify({ ok: true }) });
        return acknowledgement(body.batch_id);
      },
    });
    instance.append("state", { state: "ended" });
    await instance.complete();

    assert.equal(completionRequests.length, 2);
    assert.equal(completionRequests[0].body, completionRequests[1].body);
    const completionId = requestBody(completionRequests[0]).batch_id;
    assert.equal(completionRequests[0].headers["Idempotency-Key"], completionId);
    assert.equal(completionRequests[1].headers["Idempotency-Key"], completionId);
    assert.equal(instance.completionAcknowledged, true);
  });

  it("drains and completes within a shutdown deadline", async () => {
    const bodies = [];
    const neverDeadline = () => new Promise(() => {});
    const instance = journal({
      sleep: neverDeadline,
      clock: () => 1_000,
      fetchImpl: async (_url, init) => {
        const body = requestBody(init);
        bodies.push(body);
        return acknowledgement(body.batch_id);
      },
    });
    instance.append("state", { state: "closing" });
    const result = await instance.shutdown({ deadlineMs: 100 });

    assert.equal(result.drained, true);
    assert.equal(result.pending_events, 0);
    assert.equal(result.completion_acknowledged, true);
    assert.deepEqual(bodies.map((body) => body.complete), [false, true]);
  });

  it("returns at the shutdown deadline, aborts transport, and retains every event", async () => {
    let now = 5_000;
    let observedSignal;
    const instance = journal({
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetchImpl: async (_url, init) => {
        observedSignal = init.signal;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    instance.append("user_said", { text: "retain me" });
    const result = await instance.shutdown({ deadlineMs: 25 });

    assert.equal(result.drained, false);
    assert.equal(result.pending_events, 1);
    assert(result.pending_bytes > 0);
    assert.equal(result.completion_acknowledged, false);
    assert.equal(observedSignal.aborted, true);
    assert.equal(instance.pendingCount, 1);
  });

  it("can retry a retained journal under a fresh shutdown deadline", async () => {
    let now = 10_000;
    let unavailable = true;
    const instance = journal({
      clock: () => now,
      sleep: (ms) => {
        if (!unavailable) return new Promise(() => {});
        now += ms;
        return Promise.resolve();
      },
      fetchImpl: async (_url, init) => {
        if (!unavailable) return acknowledgement(requestBody(init).batch_id);
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    instance.append("state", { state: "must-survive" });
    const timedOut = await instance.shutdown({ deadlineMs: 25 });
    assert.equal(timedOut.drained, false);
    assert.equal(instance.pendingCount, 1);

    await new Promise((resolve) => setImmediate(resolve));
    unavailable = false;
    const retried = await instance.shutdown({ deadlineMs: 100 });
    assert.equal(retried.drained, true);
    assert.equal(retried.pending_events, 0);
    assert.equal(retried.completion_acknowledged, true);
  });

  it("keeps the bearer scope out of the URL, body, snapshots, and delivery errors", async () => {
    const requests = [];
    const instance = createEventJournal({
      appOrigin: ORIGIN,
      scope: SCOPE,
      sessionId: SESSION,
      maxAttempts: 1,
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        throw new Error(`malicious echo ${SCOPE}`);
      },
    });
    instance.append("error", { message: "safe" });
    let error;
    try {
      await instance.flush();
    } catch (caught) {
      error = caught;
    }

    assert(error instanceof EventJournalDeliveryError);
    assert.equal(requests[0].init.headers.Authorization, `Bearer ${SCOPE}`);
    assert(!requests[0].url.includes(SCOPE));
    assert(!requests[0].init.body.includes(SCOPE));
    assert(!JSON.stringify(instance.snapshot()).includes(SCOPE));
    assert(!String(error).includes(SCOPE));
  });
});

import { createHash } from "node:crypto";
import { parseCappedJson } from "./safe-json.js";

const SCHEMA_VERSION = 1;
const DEFAULT_INGEST_PATH = "/api/telephony/bridge/events";
const DEFAULT_MAX_QUEUED_EVENTS = 1_000;
const DEFAULT_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BATCH_EVENTS = 50;
const DEFAULT_MAX_BATCH_BYTES = 512 * 1024;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 100;
const DEFAULT_RETRY_MAX_MS = 5_000;
const DEFAULT_SHUTDOWN_DEADLINE_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_ACK_BYTES = 16 * 1024;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function validatedScope(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192 || /\s/.test(value)) {
    throw new TypeError("scope must be a non-empty bearer token without whitespace");
  }
  return value;
}

function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("journal payload numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("journal payloads must contain only JSON values");
  }
  if (seen.has(value)) throw new TypeError("journal payloads must not contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("journal payload objects must be plain objects");
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function immutableJsonSnapshot(value) {
  return deepFreeze(JSON.parse(canonicalJson(value)));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

async function readWithAbort(reader, signal) {
  if (signal.aborted) throw signal.reason ?? new Error("event journal request aborted");
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("event journal request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readAckCapped(response, signal) {
  const advertised = response.headers?.get?.("content-length");
  if (advertised !== null && advertised !== undefined && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_ACK_BYTES)) {
    await response.body?.cancel?.().catch(() => undefined);
    return null;
  }
  if (!response.body || typeof response.body.getReader !== "function") return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) return null;
      size += value.byteLength;
      if (size > MAX_ACK_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try { await reader.cancel(error); } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function safeEndpoint(appOrigin, endpointPath, allowInsecureLocalhost) {
  let parsed;
  try {
    parsed = new URL(appOrigin);
  } catch {
    throw new TypeError("appOrigin must be a valid HTTPS origin");
  }
  const isLoopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  const protocolAllowed = parsed.protocol === "https:"
    || (allowInsecureLocalhost && parsed.protocol === "http:" && isLoopback);
  if (
    !protocolAllowed
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new TypeError("appOrigin must be a credential-free HTTPS origin (or an explicitly enabled HTTP loopback origin)");
  }
  if (
    typeof endpointPath !== "string"
    || !endpointPath.startsWith("/")
    || endpointPath.startsWith("//")
    || endpointPath.includes("?")
    || endpointPath.includes("#")
    || endpointPath.includes("\\")
  ) {
    throw new TypeError("endpointPath must be an absolute same-origin path without query or fragment");
  }
  const endpoint = new URL(endpointPath, parsed.origin);
  if (endpoint.origin !== parsed.origin || endpoint.protocol !== parsed.protocol) {
    throw new TypeError("endpointPath must resolve to the configured origin");
  }
  return endpoint.toString();
}

function publicDrainState(journal, drained) {
  return Object.freeze({
    drained,
    pending_events: journal.pendingCount,
    pending_bytes: journal.pendingBytes,
    completion_acknowledged: journal.completionAcknowledged,
    active_batch_id: journal.activeBatchId,
  });
}

export class EventJournalCapacityError extends Error {
  constructor(message) {
    super(message);
    this.name = "EventJournalCapacityError";
    this.code = "EVENT_JOURNAL_CAPACITY";
  }
}

export class EventJournalStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "EventJournalStateError";
    this.code = "EVENT_JOURNAL_STATE";
  }
}

export class EventJournalDeliveryError extends Error {
  constructor(batchId, attempts) {
    super(`event batch ${batchId} was not acknowledged after ${attempts} attempt(s)`);
    this.name = "EventJournalDeliveryError";
    this.code = "EVENT_JOURNAL_DELIVERY";
    this.batchId = batchId;
    this.attempts = attempts;
  }
}

class EventJournalDeadlineError extends Error {
  constructor() {
    super("event journal drain deadline exceeded");
    this.name = "EventJournalDeadlineError";
    this.code = "EVENT_JOURNAL_DEADLINE";
  }
}

class EventJournalRequestTimeoutError extends Error {
  constructor() {
    super("event journal request timed out");
    this.name = "EventJournalRequestTimeoutError";
    this.code = "EVENT_JOURNAL_REQUEST_TIMEOUT";
  }
}

/**
 * An in-memory, backpressure-aware delivery journal for bridge telemetry.
 *
 * Delivery is at-least-once over the network and exactly-once at the ingestion
 * boundary when the receiver honors `Idempotency-Key`. A batch is removed only
 * after a strict, matching acknowledgement. The bearer scope is deliberately
 * held in a private field and is sent only in the Authorization header.
 */
export class EventJournal {
  #endpoint;
  #scope;
  #sessionId;
  #sessionSha256;
  #fetch;
  #sleep;
  #clock;
  #maxQueuedEvents;
  #maxQueuedBytes;
  #terminalReserveEvents;
  #terminalReserveBytes;
  #maxBatchEvents;
  #maxBatchBytes;
  #maxAttempts;
  #retryBaseMs;
  #retryMaxMs;
  #shutdownDeadlineMs;
  #requestTimeoutMs;
  #setTimeout;
  #clearTimeout;
  #events = [];
  #queuedBytes = 0;
  #nextSequence = 1;
  #activeBatch = null;
  #flushPromise = null;
  #shutdownPromise = null;
  #completionRequested = false;
  #completionAcknowledged = false;
  #shutdownDeadlineAt = null;
  #currentAbortController = null;

  constructor({
    appOrigin,
    endpointPath = DEFAULT_INGEST_PATH,
    allowInsecureLocalhost = false,
    scope,
    sessionId,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    clock = Date.now,
    maxQueuedEvents = DEFAULT_MAX_QUEUED_EVENTS,
    maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES,
    terminalReserveEvents = 0,
    terminalReserveBytes = 0,
    maxBatchEvents = DEFAULT_MAX_BATCH_EVENTS,
    maxBatchBytes = DEFAULT_MAX_BATCH_BYTES,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    retryMaxMs = DEFAULT_RETRY_MAX_MS,
    shutdownDeadlineMs = DEFAULT_SHUTDOWN_DEADLINE_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {}) {
    if (typeof allowInsecureLocalhost !== "boolean") {
      throw new TypeError("allowInsecureLocalhost must be a boolean");
    }
    this.#endpoint = safeEndpoint(appOrigin, endpointPath, allowInsecureLocalhost);
    validatedScope(scope);
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) {
      throw new TypeError("sessionId must be a stable, URL-safe identifier of at most 128 characters");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (typeof sleep !== "function") throw new TypeError("sleep must be a function");
    if (typeof clock !== "function") throw new TypeError("clock must be a function");

    for (const [value, name] of [
      [maxQueuedEvents, "maxQueuedEvents"],
      [maxQueuedBytes, "maxQueuedBytes"],
      [maxBatchEvents, "maxBatchEvents"],
      [maxBatchBytes, "maxBatchBytes"],
      [maxAttempts, "maxAttempts"],
      [retryBaseMs, "retryBaseMs"],
      [retryMaxMs, "retryMaxMs"],
      [shutdownDeadlineMs, "shutdownDeadlineMs"],
      [requestTimeoutMs, "requestTimeoutMs"],
    ]) assertPositiveInteger(value, name);
    for (const [value, name] of [
      [terminalReserveEvents, "terminalReserveEvents"],
      [terminalReserveBytes, "terminalReserveBytes"],
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
    }
    if (maxBatchEvents > maxQueuedEvents) {
      throw new TypeError("maxBatchEvents must not exceed maxQueuedEvents");
    }
    if (maxBatchBytes > maxQueuedBytes) {
      throw new TypeError("maxBatchBytes must not exceed maxQueuedBytes");
    }
    if (terminalReserveEvents >= maxQueuedEvents || terminalReserveBytes >= maxQueuedBytes) {
      throw new TypeError("terminal journal reserve must leave capacity for ordinary events");
    }
    if (retryMaxMs < retryBaseMs) {
      throw new TypeError("retryMaxMs must be greater than or equal to retryBaseMs");
    }
    if (requestTimeoutMs > 60_000) throw new TypeError("requestTimeoutMs must not exceed 60000");
    if (typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
      throw new TypeError("event journal timer implementations must be functions");
    }

    this.#scope = scope;
    this.#sessionId = sessionId;
    this.#sessionSha256 = sha256(sessionId);
    this.#fetch = fetchImpl;
    this.#sleep = sleep;
    this.#clock = clock;
    this.#maxQueuedEvents = maxQueuedEvents;
    this.#maxQueuedBytes = maxQueuedBytes;
    this.#terminalReserveEvents = terminalReserveEvents;
    this.#terminalReserveBytes = terminalReserveBytes;
    this.#maxBatchEvents = maxBatchEvents;
    this.#maxBatchBytes = maxBatchBytes;
    this.#maxAttempts = maxAttempts;
    this.#retryBaseMs = retryBaseMs;
    this.#retryMaxMs = retryMaxMs;
    this.#shutdownDeadlineMs = shutdownDeadlineMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
  }

  get pendingCount() {
    return this.#events.length;
  }

  get pendingBytes() {
    return this.#queuedBytes;
  }

  get nextSequence() {
    return this.#nextSequence;
  }

  get inFlight() {
    return this.#flushPromise !== null;
  }

  get completionRequested() {
    return this.#completionRequested;
  }

  get completionAcknowledged() {
    return this.#completionAcknowledged;
  }

  get activeBatchId() {
    return this.#activeBatch?.batchId ?? null;
  }

  /**
   * Rotate authority for requests started after this call. A request already
   * handed to fetch retains its captured bearer, while a settled retry adopts
   * the current scope without changing the batch body or idempotency identity.
   */
  rotateScope(scope) {
    validatedScope(scope);
    if (this.#completionRequested || this.#completionAcknowledged) {
      throw new EventJournalStateError("cannot rotate scope after journal completion begins");
    }
    if (scope === this.#scope) throw new TypeError("rotated scope must be distinct");
    this.#scope = scope;
  }

  snapshot() {
    return Object.freeze({
      session_id: this.#sessionId,
      session_sha256: this.#sessionSha256,
      next_sequence: this.#nextSequence,
      pending_events: this.#events.length,
      pending_bytes: this.#queuedBytes,
      active_batch_id: this.activeBatchId,
      in_flight: this.inFlight,
      completion_requested: this.#completionRequested,
      completion_acknowledged: this.#completionAcknowledged,
      terminal_reserve_events: this.#terminalReserveEvents,
      terminal_reserve_bytes: this.#terminalReserveBytes,
    });
  }

  append(type, payload = {}, { terminal = false } = {}) {
    if (this.#completionRequested) {
      throw new EventJournalStateError("cannot append after completion has been requested");
    }
    if (typeof type !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/.test(type)) {
      throw new TypeError("event type must be a safe identifier of at most 80 characters");
    }

    const payloadSnapshot = immutableJsonSnapshot(payload);
    const eventCore = Object.freeze({
      session_id: this.#sessionId,
      sequence: this.#nextSequence,
      type,
      payload: payloadSnapshot,
    });
    const event = deepFreeze({
      ...eventCore,
      content_sha256: sha256(canonicalJson(eventCore)),
    });
    const serializedBytes = Buffer.byteLength(canonicalJson(event));

    if (typeof terminal !== "boolean") throw new TypeError("terminal journal option must be a boolean");
    if (serializedBytes > this.#maxBatchBytes) {
      throw new EventJournalCapacityError("event exceeds the configured serialized batch-byte limit");
    }
    const eventLimit = this.#maxQueuedEvents - (terminal ? 0 : this.#terminalReserveEvents);
    const byteLimit = this.#maxQueuedBytes - (terminal ? 0 : this.#terminalReserveBytes);
    if (this.#events.length + 1 > eventLimit) {
      throw new EventJournalCapacityError("event journal count limit reached; flush before appending");
    }
    if (this.#queuedBytes + serializedBytes > byteLimit) {
      throw new EventJournalCapacityError("event journal serialized-byte limit reached; flush before appending");
    }

    const stored = Object.freeze({ event, serializedBytes });
    this.#events.push(stored);
    this.#queuedBytes += serializedBytes;
    this.#nextSequence += 1;
    return event;
  }

  queue(type, payload = {}) {
    return this.append(type, payload);
  }

  appendTerminal(type, payload = {}) {
    return this.append(type, payload, { terminal: true });
  }

  flush({ complete = false } = {}) {
    if (complete) this.#completionRequested = true;
    if (
      this.#shutdownPromise === null
      && this.#shutdownDeadlineAt !== null
      && this.#clock() >= this.#shutdownDeadlineAt
    ) {
      this.#shutdownDeadlineAt = null;
    }
    if (this.#flushPromise) return this.#flushPromise;

    const drain = this.#drain({ retryUntilDeadline: false });
    void drain.catch(() => {});
    const promise = drain
      .finally(() => {
        if (this.#flushPromise === promise) this.#flushPromise = null;
      });
    void promise.catch(() => {});
    this.#flushPromise = promise;
    return promise;
  }

  complete() {
    this.#completionRequested = true;
    return this.flush();
  }

  shutdown({ deadlineMs = this.#shutdownDeadlineMs } = {}) {
    assertPositiveInteger(deadlineMs, "deadlineMs");
    this.#completionRequested = true;
    if (this.#completionAcknowledged) return Promise.resolve(publicDrainState(this, true));
    if (this.#shutdownPromise) return this.#shutdownPromise;

    const now = this.#clock();
    const deadlineAt = now + deadlineMs;
    this.#shutdownDeadlineAt = this.#shutdownDeadlineAt === null || now >= this.#shutdownDeadlineAt
      ? deadlineAt
      : Math.min(this.#shutdownDeadlineAt, deadlineAt);

    const promise = this.#shutdownDrain(this.#shutdownDeadlineAt)
      .finally(() => {
        if (this.#shutdownPromise === promise) this.#shutdownPromise = null;
      });
    this.#shutdownPromise = promise;
    return promise;
  }

  async #shutdownDrain(deadlineAt) {
    try {
      while (!this.#completionAcknowledged) {
        if (this.#clock() >= deadlineAt) throw new EventJournalDeadlineError();
        const drainPromise = this.#flushPromise ?? this.#startDeadlineDrain();
        await this.#awaitThroughDeadline(drainPromise, deadlineAt);
      }
      return publicDrainState(this, true);
    } catch (error) {
      if (error instanceof EventJournalDeadlineError || this.#clock() >= deadlineAt) {
        return publicDrainState(this, false);
      }
      if (error instanceof EventJournalDeliveryError && this.#clock() < deadlineAt) {
        return this.#shutdownDrain(deadlineAt);
      }
      throw error;
    }
  }

  #startDeadlineDrain() {
    const drain = this.#drain({ retryUntilDeadline: true });
    void drain.catch(() => {});
    const promise = drain
      .finally(() => {
        if (this.#flushPromise === promise) this.#flushPromise = null;
      });
    void promise.catch(() => {});
    this.#flushPromise = promise;
    return promise;
  }

  async #awaitThroughDeadline(promise, deadlineAt) {
    const remaining = deadlineAt - this.#clock();
    if (remaining <= 0) throw new EventJournalDeadlineError();

    // The deadline may win this race. Attach an explicit terminal handler so a
    // later abort/retry rejection cannot become process-level async activity.
    void promise.catch(() => {});
    const settled = promise.then(
      (value) => ({ kind: "value", value }),
      (error) => ({ kind: "error", error }),
    );
    const deadline = Promise.resolve(this.#sleep(remaining)).then(() => ({ kind: "deadline" }));
    const result = await Promise.race([settled, deadline]);
    if (result.kind === "deadline") {
      this.#currentAbortController?.abort();
      throw new EventJournalDeadlineError();
    }
    if (result.kind === "error") throw result.error;
    return result.value;
  }

  async #drain({ retryUntilDeadline }) {
    let acknowledgedBatches = 0;
    let acknowledgedEvents = 0;

    while (this.#events.length > 0 || (this.#completionRequested && !this.#completionAcknowledged)) {
      if (this.#effectiveDeadlineReached()) throw new EventJournalDeadlineError();
      if (!this.#activeBatch) this.#activeBatch = this.#createNextBatch();
      const batch = this.#activeBatch;
      await this.#deliver(batch, retryUntilDeadline);
      this.#acknowledge(batch);
      acknowledgedBatches += 1;
      acknowledgedEvents += batch.eventCount;
    }

    return Object.freeze({
      ok: true,
      acknowledged_batches: acknowledgedBatches,
      acknowledged_events: acknowledgedEvents,
      pending_events: this.#events.length,
      completion_acknowledged: this.#completionAcknowledged,
    });
  }

  #createNextBatch() {
    if (this.#events.length === 0) return this.#createBatch([], true);

    const selected = [];
    let selectedBytes = 0;
    for (const stored of this.#events) {
      if (selected.length >= this.#maxBatchEvents) break;
      if (selected.length > 0 && selectedBytes + stored.serializedBytes > this.#maxBatchBytes) break;
      selected.push(stored);
      selectedBytes += stored.serializedBytes;
    }
    return this.#createBatch(selected, false);
  }

  #createBatch(storedEvents, complete) {
    const events = storedEvents.map(({ event }) => event);
    const eventSeqStart = events[0]?.sequence ?? null;
    const eventSeqEnd = events.at(-1)?.sequence ?? null;
    const unsigned = deepFreeze({
      schema_version: SCHEMA_VERSION,
      session_id: this.#sessionId,
      session_sha256: this.#sessionSha256,
      first_sequence: eventSeqStart,
      last_sequence: eventSeqEnd,
      events,
      complete,
    });
    const batchSha256 = sha256(canonicalJson(unsigned));
    const batchId = `event_batch_${batchSha256}`;
    const body = canonicalJson({
      ...unsigned,
      batch_id: batchId,
      batch_sha256: batchSha256,
    });
    return {
      batchId,
      batchSha256,
      body,
      eventCount: events.length,
      eventBytes: storedEvents.reduce((sum, entry) => sum + entry.serializedBytes, 0),
      firstSequence: eventSeqStart,
      lastSequence: eventSeqEnd,
      complete,
      totalAttempts: 0,
    };
  }

  async #deliver(batch, retryUntilDeadline) {
    let attemptsThisDrain = 0;
    while (true) {
      if (this.#effectiveDeadlineReached()) throw new EventJournalDeadlineError();
      attemptsThisDrain += 1;
      batch.totalAttempts += 1;
      if (await this.#attempt(batch)) return;

      if (!retryUntilDeadline && attemptsThisDrain >= this.#maxAttempts) {
        throw new EventJournalDeliveryError(batch.batchId, attemptsThisDrain);
      }
      const exponent = Math.min(batch.totalAttempts - 1, 30);
      const retryDelay = Math.min(this.#retryMaxMs, this.#retryBaseMs * (2 ** exponent));
      await this.#sleepBeforeRetry(retryDelay);
    }
  }

  async #attempt(batch) {
    // Scope is request-local, not batch-local. This makes an in-flight request
    // deterministic across a concurrent rotation while allowing a retained
    // batch to outlive the old capability and retry under the current one.
    const attemptScope = this.#scope;
    const controller = new AbortController();
    let timeoutHandle;
    const requestTimeout = new Promise((resolve) => {
      timeoutHandle = this.#setTimeout(() => {
        const error = new EventJournalRequestTimeoutError();
        controller.abort(error);
        resolve({ kind: "request_timeout", error });
      }, this.#requestTimeoutMs);
      // This timer is the only bounded completion authority when a custom
      // fetch or response body stalls without retaining a Node handle. Keep it
      // referenced so a CLI/worker cannot exit with an unresolved flush and
      // silently abandon the retained journal batch.
    });
    this.#currentAbortController = controller;
    try {
      const responsePromise = Promise.resolve(this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${attemptScope}`,
          "Content-Type": "application/json",
          "Idempotency-Key": batch.batchId,
        },
        body: batch.body,
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      }));
      const response = await this.#awaitOperation(responsePromise, controller, requestTimeout);
      if (!Number.isInteger(response?.status) || response.status < 200 || response.status > 299) return false;
      const contentType = response.headers?.get?.("content-type") ?? "";
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) return false;
      const bytes = await this.#awaitOperation(readAckCapped(response, controller.signal), controller, requestTimeout);
      if (!bytes) return false;
      let acknowledgement;
      try {
        acknowledgement = parseCappedJson(bytes, {
          maxBytes: MAX_ACK_BYTES,
          maxDepth: 4,
          maxNodes: 16,
          maxObjectKeys: 8,
          maxArrayLength: 4,
          maxStringBytes: 1_024,
          maxKeyBytes: 64,
          maxNumberChars: 32,
        });
      } catch {
        return false;
      }
      return acknowledgement !== null
        && !Array.isArray(acknowledgement)
        && Object.keys(acknowledgement).length === 2
        && Object.hasOwn(acknowledgement, "ok")
        && Object.hasOwn(acknowledgement, "batch_id")
        && acknowledgement.ok === true
        && acknowledgement.batch_id === batch.batchId;
    } catch {
      return false;
    } finally {
      this.#clearTimeout(timeoutHandle);
      if (this.#currentAbortController === controller) this.#currentAbortController = null;
    }
  }

  async #awaitOperation(responsePromise, controller, requestTimeout) {
    const deadlineAt = this.#shutdownDeadlineAt;
    const settled = responsePromise.then(
      (value) => ({ kind: "value", value }),
      (error) => ({ kind: "error", error }),
    );
    if (deadlineAt === null) {
      const result = await Promise.race([settled, requestTimeout]);
      if (result.kind === "request_timeout") throw result.error;
      if (result.kind === "error") throw result.error;
      return result.value;
    }
    const remaining = deadlineAt - this.#clock();
    if (remaining <= 0) {
      controller.abort();
      throw new EventJournalDeadlineError();
    }
    const deadline = Promise.resolve(this.#sleep(remaining)).then(() => ({ kind: "deadline" }));
    const result = await Promise.race([settled, deadline, requestTimeout]);
    if (result.kind === "request_timeout") throw result.error;
    if (result.kind === "deadline") {
      controller.abort();
      throw new EventJournalDeadlineError();
    }
    if (result.kind === "error") throw result.error;
    return result.value;
  }

  async #sleepBeforeRetry(delayMs) {
    const deadlineAt = this.#shutdownDeadlineAt;
    if (deadlineAt === null) {
      await this.#sleep(delayMs);
      return;
    }
    const remaining = deadlineAt - this.#clock();
    if (remaining <= 0) throw new EventJournalDeadlineError();
    if (delayMs >= remaining) {
      await this.#sleep(remaining);
      throw new EventJournalDeadlineError();
    }
    await this.#sleep(delayMs);
  }

  #effectiveDeadlineReached() {
    return this.#shutdownDeadlineAt !== null && this.#clock() >= this.#shutdownDeadlineAt;
  }

  #acknowledge(batch) {
    if (this.#activeBatch !== batch) {
      throw new EventJournalStateError("journal active batch changed before acknowledgement");
    }
    if (batch.complete) {
      if (batch.eventCount !== 0 || this.#events.length !== 0 || !this.#completionRequested) {
        throw new EventJournalStateError("completion acknowledgement arrived before all events were acknowledged");
      }
      this.#completionAcknowledged = true;
      this.#activeBatch = null;
      return;
    }

    const acknowledged = this.#events.slice(0, batch.eventCount);
    if (
      acknowledged.length !== batch.eventCount
      || acknowledged[0]?.event.sequence !== batch.firstSequence
      || acknowledged.at(-1)?.event.sequence !== batch.lastSequence
    ) {
      throw new EventJournalStateError("journal queue no longer matches the acknowledged batch");
    }
    this.#events.splice(0, batch.eventCount);
    this.#queuedBytes -= batch.eventBytes;
    if (this.#queuedBytes < 0) throw new EventJournalStateError("journal byte accounting underflow");
    this.#activeBatch = null;
  }
}

export function createEventJournal(options) {
  return new EventJournal(options);
}

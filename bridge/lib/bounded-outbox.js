export class OutboxOverflowError extends Error {
  constructor(name, messages, bytes) {
    super(`${name} exceeded its bounded queue (${messages} messages, ${bytes} bytes)`);
    this.name = "OutboxOverflowError";
    this.code = "outbox_overflow";
  }
}

export class BoundedOutbox {
  #socket = null;
  #queue = [];
  #bytes = 0;
  #closed = false;
  #draining = false;

  constructor({ name, maxMessages, maxBytes, highWaterBytes, onFatal = () => {} }) {
    if (!name || !Number.isSafeInteger(maxMessages) || !Number.isSafeInteger(maxBytes) || !Number.isSafeInteger(highWaterBytes)) {
      throw new Error("BoundedOutbox requires a name and integer limits");
    }
    this.name = name;
    this.maxMessages = maxMessages;
    this.maxBytes = maxBytes;
    this.highWaterBytes = highWaterBytes;
    this.onFatal = onFatal;
  }

  attach(socket) {
    if (this.#closed) throw new Error(`${this.name} is closed`);
    this.#socket = socket;
    this.drain();
  }

  enqueue(data, metadata = null) {
    return this.enqueueBatch([{ data, metadata }]);
  }

  enqueueFront(data, metadata = null) {
    if (this.#closed) throw new Error(`${this.name} is closed`);
    const entry = this.#normalizeEntry({ data, metadata });
    this.#assertCapacity(1, entry.bytes);
    this.#queue.unshift(entry);
    this.#bytes += entry.bytes;
    this.drain();
    return Object.freeze({ messages: 1, bytes: entry.bytes });
  }

  /** Atomically accepts all frames or none, preserving wire order. */
  enqueueBatch(entries) {
    if (this.#closed) throw new Error(`${this.name} is closed`);
    if (!Array.isArray(entries) || entries.length < 1) {
      throw new Error(`${this.name} enqueueBatch requires at least one entry`);
    }
    const normalized = entries.map((entry) => this.#normalizeEntry(entry));
    const addedBytes = normalized.reduce((sum, entry) => sum + entry.bytes, 0);
    this.#assertCapacity(normalized.length, addedBytes);
    this.#queue.push(...normalized);
    this.#bytes += addedBytes;
    this.drain();
    return Object.freeze({ messages: normalized.length, bytes: addedBytes });
  }

  discard(predicate = () => true) {
    if (typeof predicate !== "function") throw new TypeError(`${this.name} discard predicate must be a function`);
    let messages = 0;
    let bytes = 0;
    this.#queue = this.#queue.filter((entry) => {
      if (!predicate(entry.metadata)) return true;
      messages += 1;
      bytes += entry.bytes;
      return false;
    });
    this.#bytes -= bytes;
    return Object.freeze({ messages, bytes });
  }

  #normalizeEntry(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${this.name} entries must be objects`);
    }
    const { data, metadata = null } = entry;
    if (typeof data !== "string" && !Buffer.isBuffer(data)) {
      throw new Error(`${this.name} accepts only text or Buffer payloads`);
    }
    const bytes = Buffer.isBuffer(data) ? data.byteLength : Buffer.byteLength(data, "utf8");
    return { data, bytes, metadata };
  }

  #assertCapacity(additionalMessages, additionalBytes) {
    const nextMessages = this.#queue.length + additionalMessages;
    const nextBytes = this.#bytes + additionalBytes;
    if (nextMessages > this.maxMessages || nextBytes > this.maxBytes) {
      const error = new OutboxOverflowError(this.name, nextMessages, nextBytes);
      this.onFatal(error);
      throw error;
    }
  }

  drain(maxBatch = 100) {
    if (this.#draining) return 0;
    const socket = this.#socket;
    if (this.#closed || !socket || socket.readyState !== 1) return 0;
    this.#draining = true;
    let sent = 0;
    try {
      while (
        sent < maxBatch
        && this.#queue.length > 0
        && Number(socket.bufferedAmount ?? 0) <= this.highWaterBytes
      ) {
        const entry = this.#queue.shift();
        this.#bytes -= entry.bytes;
        try {
          socket.send(entry.data, (error) => {
            if (error) this.onFatal(error);
            else this.drain();
          });
        } catch (error) {
          this.#queue.unshift(entry);
          this.#bytes += entry.bytes;
          this.onFatal(error);
          break;
        }
        sent += 1;
      }
    } finally {
      this.#draining = false;
    }
    return sent;
  }

  close() {
    this.#closed = true;
    this.#socket = null;
    const abandoned = Object.freeze({ messages: this.#queue.length, bytes: this.#bytes });
    this.#queue = [];
    this.#bytes = 0;
    return abandoned;
  }

  get size() {
    return this.#queue.length;
  }

  get bytes() {
    return this.#bytes;
  }

  get stats() {
    return Object.freeze({ messages: this.#queue.length, bytes: this.#bytes, closed: this.#closed });
  }
}

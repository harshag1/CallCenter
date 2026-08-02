import { EventEmitter } from "node:events";

export const ACCOUNT_SID = `AC${"a".repeat(32)}`;
export const CALL_SID = `CA${"b".repeat(32)}`;
export const STREAM_SID = `MZ${"c".repeat(32)}`;
export const BOOTSTRAP_TOKEN = "bootstrap.token.body.signature";
export const EVENT_CAPABILITY_TOKEN = "event-capability.token.body.signature";
export const MCP_CAPABILITY_TOKEN = "mcp-capability.token.body.signature";
export const RENEWAL_CAPABILITY_TOKEN = "renewal-capability.token.body.signature";

export function providerConfiguration(provider = "openai") {
  const model = provider === "openai" ? "gpt-realtime-test" : "grok-voice-test";
  const session = {
    ...(provider === "openai" ? { model } : { voice: "ara" }),
    instructions: "Use the capability gateway.",
    tool_choice: "auto",
    audio: {
      input: {
        format: provider === "xai" ? { type: "audio/pcmu", rate: 8_000 } : { type: "audio/pcmu" },
        turn_detection: { type: "server_vad" },
      },
      output: {
        format: provider === "xai" ? { type: "audio/pcmu", rate: 8_000 } : { type: "audio/pcmu" },
        ...(provider === "openai" ? { voice: "marin" } : {}),
      },
    },
    tools: [{
      type: "function",
      name: "capability_gateway",
      description: "Perform one server-authorized capability operation.",
      parameters: { type: "object" },
      strict: true,
    }],
  };
  return {
    provider,
    model,
    wsUrl: `wss://${provider === "openai" ? "api.openai.com" : "api.x.ai"}/v1/realtime?model=${model}`,
    sessionUpdate: { type: "session.update", session },
  };
}

export function bridgeConfig(overrides = {}) {
  const limits = {
    maximumConcurrentSessions: 10,
    twilioMessageBytes: 64 * 1024,
    providerMessageBytes: 512 * 1024,
    mediaFrameBytes: 8 * 1024,
    inputQueueMessages: 50,
    inputQueueBytes: 256 * 1024,
    outputQueueMessages: 100,
    outputQueueBytes: 512 * 1024,
    socketHighWaterBytes: 64 * 1024,
    maximumPendingMarks: 100,
    playbackMarkBytes: 800,
    maximumToolCalls: 16,
    twilioStartMs: 200,
    drainIntervalMs: 10,
    providerConnectMs: 200,
    sessionAckMs: 200,
    maximumCallMs: 5_000,
    idleTimeoutMs: 2_000,
    shutdownMs: 100,
    ...(overrides.limits ?? {}),
  };
  return {
    port: 0,
    appOrigin: "https://app.example.test",
    publicStreamUrl: "wss://bridge.example.test/stream",
    twilioAccountSid: ACCOUNT_SID,
    twilioAuthToken: "twilio-auth-token-with-enough-entropy",
    twilioAuthTokenNext: null,
    providerKeys: { openai: "openai-test-key", xai: "xai-test-key" },
    instanceId: "bridge-test-instance",
    allowInsecureLocalTests: false,
    strictTwilioProtocol: true,
    sessionPath: "/api/telephony/bridge/session",
    authorityPath: "/api/mcp",
    eventsPath: "/api/telephony/bridge/events",
    allowedClientTools: ["capability_gateway"],
    ...overrides,
    limits,
  };
}

export class FakeSocket extends EventEmitter {
  constructor({ readyState = 1, bufferedAmount = 0 } = {}) {
    super();
    this.readyState = readyState;
    this.bufferedAmount = bufferedAmount;
    this.sent = [];
    this.closeCalls = [];
    this.terminated = false;
  }

  send(data, callback) {
    if (this.readyState !== 1) {
      const error = new Error("socket not open");
      callback?.(error);
      return;
    }
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
    callback?.();
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  receive(value, isBinary = false) {
    const wire = typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value);
    this.emit("message", wire, isBinary);
  }

  close(code = 1000, reason = "") {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
}

export class FakeJournal {
  constructor() {
    this.events = [];
    this.flushes = 0;
    this.shutdownCalls = 0;
    this.scopeRotations = [];
  }

  append(type, payload, options = {}) {
    this.events.push({ type, payload, terminal: options.terminal === true });
  }

  appendTerminal(type, payload) {
    this.events.push({ type, payload, terminal: true });
  }

  async flush() {
    this.flushes += 1;
    return { ok: true };
  }

  rotateScope(scope) {
    this.scopeRotations.push(scope);
  }

  async shutdown() {
    this.shutdownCalls += 1;
    return { drained: true, pending_events: 0 };
  }
}

export function connected() {
  return { event: "connected", protocol: "Call", version: "1.0.0" };
}

export function start({
  sequenceNumber = "1",
  bridgeToken = BOOTSTRAP_TOKEN,
  mode = "agent",
  customParameters,
  accountSid = ACCOUNT_SID,
  callSid = CALL_SID,
  streamSid = STREAM_SID,
  tracks = ["inbound"],
} = {}) {
  return {
    event: "start",
    sequenceNumber,
    streamSid,
    start: {
      accountSid,
      callSid,
      streamSid,
      tracks,
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8_000, channels: 1 },
      customParameters: customParameters ?? { bridgeToken, mode },
    },
  };
}

export function media(sequenceNumber, bytes = Buffer.alloc(160, 0xff)) {
  return {
    event: "media",
    sequenceNumber: String(sequenceNumber),
    streamSid: STREAM_SID,
    media: { track: "inbound", payload: bytes.toString("base64") },
  };
}

export function mark(sequenceNumber, name) {
  return {
    event: "mark",
    sequenceNumber: String(sequenceNumber),
    streamSid: STREAM_SID,
    mark: { name },
  };
}

export function stop(sequenceNumber) {
  return { event: "stop", sequenceNumber: String(sequenceNumber), streamSid: STREAM_SID, stop: {} };
}

export async function waitFor(predicate, message = "condition", attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${message}`);
}

import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";

import { AuthorityClient, AuthorityClientError } from "./authority-client.js";
import { BootstrapClient } from "./bootstrap-client.js";
import { BoundedOutbox } from "./bounded-outbox.js";
import { CapabilityRotationClient } from "./capability-rotation-client.js";
import { EventJournal } from "./event-journal.js";
import {
  OpenAICompatibleProviderAdapter,
  buildConversationItemTruncateEvent,
  buildFunctionCallOutputEvent,
  buildInputAudioAppendEvent,
  buildResponseCreateEvent,
  validateProviderConfig,
} from "./provider-adapter.js";
import { parseCappedJson } from "./safe-json.js";

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const CALL_SID = /^CA[0-9a-fA-F]{32}$/;
const STREAM_SID = /^MZ[0-9a-fA-F]{32}$/;
const CANONICAL_SEQUENCE = /^[1-9][0-9]{0,15}$/;
const SAFE_MARK = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_DTMF = /^[0-9A-D*#]$/;
const SAFE_TOOL = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const OPEN = 1;

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw protocolError("invalid_twilio_event", `${label} must be an object`);
  return value;
}

function requireString(value, label, { maxBytes = 4_096, pattern } = {}) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maxBytes || /[\u0000-\u001f\u007f]/.test(value)) {
    throw protocolError("invalid_twilio_event", `${label} must be a bounded control-free string`);
  }
  if (pattern && !pattern.test(value)) throw protocolError("invalid_twilio_event", `${label} is malformed`);
  return value;
}

function requireCanonicalBase64(value, label, maximumBytes) {
  requireString(value, label, { maxBytes: Math.ceil(maximumBytes * 4 / 3) + 8, pattern: /^[A-Za-z0-9+/]+={0,2}$/ });
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength < 1 || decoded.byteLength > maximumBytes || decoded.toString("base64") !== value) {
    throw protocolError("invalid_audio", `${label} is not canonical bounded base64`);
  }
  return Object.freeze({ encoded: value, bytes: decoded.byteLength });
}

function protocolError(code, message) {
  const error = new Error(message);
  error.name = "BridgeProtocolError";
  error.code = code;
  return error;
}

function safeErrorCode(error, fallback = "bridge_failure") {
  return typeof error?.code === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(error.code) ? error.code : fallback;
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(String(value));
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function jsonFrame(value) {
  return JSON.stringify(value);
}

function timerUnref(timer) {
  timer?.unref?.();
  return timer;
}

function wsOn(socket, event, listener) {
  if (!socket || typeof socket.on !== "function") throw new TypeError("WebSocket-like object needs .on()");
  socket.on(event, listener);
}

function closeSocket(socket, code, reason) {
  if (!socket) return;
  try {
    if (socket.readyState === OPEN || socket.readyState === 0) socket.close?.(code, reason.slice(0, 120));
  } catch {
    try { socket.terminate?.(); } catch {}
  }
}

function providerSocketFactory({ wsUrl, apiKey, connectMs, maximumMessageBytes }) {
  return new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
    handshakeTimeout: connectMs,
    maxPayload: maximumMessageBytes,
    perMessageDeflate: false,
    followRedirects: false,
  });
}

function validateToolSurface(providerConfig, allowedTools) {
  const tools = providerConfig.sessionUpdate.session.tools ?? [];
  if (!Array.isArray(tools)) throw protocolError("unsafe_provider_tools", "session tools must be an array");
  const allowed = new Set(allowedTools);
  const seen = new Set();
  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== "function" || typeof tool.name !== "string" || !SAFE_TOOL.test(tool.name)) {
      throw protocolError("unsafe_provider_tools", "provider-managed or malformed realtime tools are forbidden");
    }
    if (!allowed.has(tool.name) || seen.has(tool.name)) {
      throw protocolError("unsafe_provider_tools", `realtime tool ${tool.name} is not an allowed unique local function`);
    }
    seen.add(tool.name);
  }
}

function validateActiveCatalogAuthority(value, { allowAvailability = false } = {}) {
  if (!isRecord(value)) throw protocolError("active_catalog_authority_invalid", "active catalog authority must be an object");
  const allowed = allowAvailability
    ? new Set(["catalogDigest", "capabilityEpoch", "availability"])
    : new Set(["catalogDigest", "capabilityEpoch"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) ||
      !Object.hasOwn(value, "catalogDigest") || !Object.hasOwn(value, "capabilityEpoch") ||
      typeof value.catalogDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.catalogDigest) ||
      !Number.isSafeInteger(value.capabilityEpoch) || value.capabilityEpoch < 0 ||
      (value.availability !== undefined && value.availability !== "active" && value.availability !== "blocked")) {
    throw protocolError("active_catalog_authority_invalid", "active catalog authority is malformed");
  }
  return Object.freeze({
    catalogDigest: value.catalogDigest,
    capabilityEpoch: value.capabilityEpoch,
    ...(value.availability === undefined ? {} : { availability: value.availability }),
  });
}

/**
 * One authenticated Twilio Media Stream and one provider connection.
 *
 * External resources are dependency-injected so every race can be reproduced
 * without a PSTN call or paid provider request.
 */
export class BridgeSession {
  constructor({
    twilioSocket,
    config,
    now = Date.now,
    bootstrapClient,
    createProviderSocket = providerSocketFactory,
    createProviderAdapter = (providerConfig) => new OpenAICompatibleProviderAdapter(providerConfig, {
      maximumWireEventBytes: config.limits.providerMessageBytes,
      allowedClientTools: config.allowedClientTools,
    }),
    createAuthorityClient = (capability) => new AuthorityClient({
      appOrigin: config.appOrigin,
      endpoint: config.authorityPath,
      scopeToken: capability.token,
      allowInsecureLocalhostForTests: config.allowInsecureLocalTests,
    }),
    createCapabilityRotationClient = (endpointPath) => new CapabilityRotationClient({
      appOrigin: config.appOrigin,
      endpointPath,
      timeoutMs: config.limits.providerConnectMs,
      allowInsecureLocalhost: config.allowInsecureLocalTests,
      now,
    }),
    createJournal = ({ capability, sessionId }) => new EventJournal({
      appOrigin: config.appOrigin,
      endpointPath: config.eventsPath,
      allowInsecureLocalhost: config.allowInsecureLocalTests,
      scope: capability.token,
      sessionId,
      shutdownDeadlineMs: config.limits.shutdownMs,
      terminalReserveEvents: 8,
      terminalReserveBytes: 32 * 1024,
      clock: now,
    }),
    logger,
    randomId = randomUUID,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    onClosed = () => {},
  }) {
    if (!twilioSocket || !config) {
      throw new TypeError("BridgeSession requires a Twilio socket and config");
    }
    if (!logger || typeof logger.info !== "function" || typeof logger.error !== "function") {
      throw new TypeError("BridgeSession requires a structured logger");
    }

    this.twilioSocket = twilioSocket;
    this.config = config;
    this.bootstrapClient = bootstrapClient ?? new BootstrapClient({
      appOrigin: config.appOrigin,
      endpointPath: config.sessionPath,
      timeoutMs: config.limits.providerConnectMs,
      allowInsecureLocalhost: config.allowInsecureLocalTests,
    });
    this.createProviderSocket = createProviderSocket;
    this.createProviderAdapter = createProviderAdapter;
    this.createAuthorityClient = createAuthorityClient;
    this.createCapabilityRotationClient = createCapabilityRotationClient;
    this.createJournal = createJournal;
    this.logger = logger;
    this.now = now;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
    this.onClosed = onClosed;

    this.sessionId = `bridge-${randomId()}`;
    this.state = "awaiting_connected";
    this.lastActivityAt = now();
    this.lastTwilioSequence = 0;
    this.playbackGeneration = 0;
    this.nextMarkCounter = 1;
    this.lastAcknowledgedMarkCounter = 0;
    this.pendingMarks = new Map();
    this.playbackByItem = new Map();
    this.pendingTruncations = new Map();
    this.cancelRequestedResponses = new Set();
    this.toolBatches = new Map();
    this.totalToolCalls = 0;
    this.bargeInEpoch = 0;
    this.activeResponseId = null;
    this.currentPlaybackItemId = null;
    this.providerSocket = null;
    this.providerAdapter = null;
    this.authorityClient = null;
    this.bootstrapAbortController = null;
    this.bootstrapPromise = null;
    this.bootstrapSettlementOpen = true;
    this.bootstrapAuthorityCommitted = false;
    this.capabilityRotationClient = null;
    this.capabilityRotationAbortController = null;
    this.capabilityRotationUnknownAtShutdown = false;
    this.capabilityState = null;
    this.capabilityRefreshTimer = null;
    this.capabilityExpiryTimer = null;
    this.capabilityRotationPromise = null;
    this.capabilityRotationFailures = 0;
    this.retiredAuthorityClients = new Set();
    this.retiredAuthorityTimers = new Map();
    this.journal = null;
    this.journalSealed = false;
    this.closing = false;
    this.closedNotified = false;
    this.shutdownPromise = null;
    this.closeCode = 1000;

    const fatalOutbox = (error) => this.fatal("socket_backpressure", error, 1011);
    this.twilioOutbox = new BoundedOutbox({
      name: "twilio_outbox",
      maxMessages: config.limits.outputQueueMessages,
      maxBytes: config.limits.outputQueueBytes,
      highWaterBytes: config.limits.socketHighWaterBytes,
      onFatal: fatalOutbox,
    });
    this.providerOutbox = new BoundedOutbox({
      name: "provider_outbox",
      maxMessages: config.limits.inputQueueMessages,
      maxBytes: config.limits.inputQueueBytes,
      highWaterBytes: config.limits.socketHighWaterBytes,
      onFatal: fatalOutbox,
    });
    this.twilioOutbox.attach(twilioSocket);

    wsOn(twilioSocket, "message", (raw, isBinary) => this.onTwilioFrame(raw, isBinary));
    wsOn(twilioSocket, "close", () => { void this.shutdown("twilio_closed", { closeTwilio: false }); });
    wsOn(twilioSocket, "error", (error) => this.fatal("twilio_socket_error", error, 1011));

    this.startTimer = timerUnref(this.setTimeout(
      () => this.fatal("twilio_start_timeout", undefined, 1008),
      config.limits.twilioStartMs,
    ));
    this.maintenanceTimer = timerUnref(this.setInterval(() => {
      this.twilioOutbox.drain();
      this.providerOutbox.drain();
      if (!this.closing && this.now() - this.lastActivityAt >= this.config.limits.idleTimeoutMs) {
        this.fatal("session_idle_timeout", undefined, 1000);
      }
    }, config.limits.drainIntervalMs));
  }

  onTwilioFrame(raw, isBinary = false) {
    if (this.closing) return;
    this.lastActivityAt = this.now();
    if (isBinary === true) return this.fatal("twilio_binary_frame", undefined, 1003);
    let message;
    try {
      message = parseCappedJson(raw, {
        maxBytes: this.config.limits.twilioMessageBytes,
        maxDepth: 16,
        maxNodes: 1_024,
        maxObjectKeys: 64,
        maxArrayLength: 32,
        maxStringBytes: Math.min(64 * 1024, this.config.limits.twilioMessageBytes),
        maxKeyBytes: 128,
        maxNumberChars: 32,
      });
      requireRecord(message, "Twilio frame");
      requireString(message.event, "Twilio event", { maxBytes: 32, pattern: /^[a-z_]+$/ });
      switch (message.event) {
        case "connected": this.handleConnected(message); break;
        case "start": this.handleStart(message); break;
        case "media": this.handleMedia(message); break;
        case "mark": this.handleMark(message); break;
        case "dtmf": this.handleDtmf(message); break;
        case "stop": this.handleStop(message); break;
        default: throw protocolError("unsupported_twilio_event", `unsupported Twilio event ${message.event}`);
      }
    } catch (error) {
      this.fatal(safeErrorCode(error, "invalid_twilio_frame"), error, error?.code === "wire_event_too_large" ? 1009 : 1008);
    }
  }

  handleConnected(message) {
    if (this.state !== "awaiting_connected") throw protocolError("twilio_event_order", "connected must be the first event exactly once");
    if (this.config.strictTwilioProtocol && (message.protocol !== "Call" || message.version !== "1.0.0")) {
      throw protocolError("twilio_protocol_mismatch", "Twilio connected protocol/version mismatch");
    }
    this.state = "awaiting_start";
  }

  handleStart(message) {
    if (this.state !== "awaiting_start") throw protocolError("twilio_event_order", "start must follow connected exactly once");
    this.consumeSequence(message, true);
    const start = requireRecord(message.start, "start");
    const accountSid = requireString(start.accountSid, "start.accountSid", { maxBytes: 34, pattern: ACCOUNT_SID });
    const callSid = requireString(start.callSid, "start.callSid", { maxBytes: 34, pattern: CALL_SID });
    const streamSid = requireString(start.streamSid, "start.streamSid", { maxBytes: 34, pattern: STREAM_SID });
    if (accountSid !== this.config.twilioAccountSid) throw protocolError("twilio_account_mismatch", "Twilio account SID is not configured for this bridge");
    if (this.config.strictTwilioProtocol) {
      if (message.streamSid !== streamSid) throw protocolError("twilio_stream_mismatch", "top-level and start stream SIDs differ");
      if (!Array.isArray(start.tracks) || start.tracks.length !== 1 || start.tracks[0] !== "inbound") {
        throw protocolError("twilio_track_mismatch", "agent bridge requires exactly the inbound track");
      }
    } else if (message.streamSid !== undefined && message.streamSid !== streamSid) {
      throw protocolError("twilio_stream_mismatch", "top-level and start stream SIDs differ");
    }
    const format = requireRecord(start.mediaFormat, "start.mediaFormat");
    if (format.encoding !== "audio/x-mulaw" || format.sampleRate !== 8_000 || format.channels !== 1) {
      throw protocolError("twilio_media_format", "bridge requires audio/x-mulaw at 8000 Hz mono");
    }
    const parameters = requireRecord(start.customParameters, "start.customParameters");
    const bridgeToken = requireString(parameters.bridgeToken, "customParameters.bridgeToken", { maxBytes: 2_048, pattern: /^[A-Za-z0-9_.-]+$/ });
    const customParameterKeys = Object.keys(parameters).sort();
    if (customParameterKeys.length !== 2 || customParameterKeys[0] !== "bridgeToken" || customParameterKeys[1] !== "mode") {
      throw protocolError("twilio_custom_parameters", "start customParameters must contain only bridgeToken and mode");
    }
    const mode = parameters.mode ?? "agent";
    if (mode !== "agent") throw protocolError("unsupported_bridge_mode", "standalone realtime bridge supports agent mode only");

    this.accountSid = accountSid;
    this.callSid = callSid;
    this.streamSid = streamSid;
    this.mode = mode;
    this.state = "exchanging_capability";
    this.clearTimeout(this.startTimer);
    this.callTimer = timerUnref(this.setTimeout(
      () => this.fatal("maximum_call_duration", undefined, 1000),
      this.config.limits.maximumCallMs,
    ));
    const controller = new AbortController();
    this.bootstrapAbortController = controller;
    const operation = this.exchangeAndConnect(bridgeToken, controller.signal);
    this.bootstrapPromise = operation;
    void operation.catch((error) => {
      if (this.closing) return;
      const code = safeErrorCode(error, "session_bootstrap_failed");
      const bootstrapRejected = code.startsWith("bootstrap_") && (code.includes("http_401") || code.includes("http_403") || code.includes("binding"));
      this.fatal(code, error, bootstrapRejected ? 1008 : 1011);
    }).finally(() => {
      if (this.bootstrapPromise === operation) this.bootstrapPromise = null;
      if (this.bootstrapAbortController === controller) this.bootstrapAbortController = null;
    });
  }

  consumeSequence(message, first = false) {
    const raw = message.sequenceNumber;
    if (raw === undefined && !this.config.strictTwilioProtocol) {
      this.lastTwilioSequence += 1;
      return this.lastTwilioSequence;
    }
    if (typeof raw !== "string" || !CANONICAL_SEQUENCE.test(raw)) {
      throw protocolError("twilio_sequence_invalid", "Twilio sequenceNumber must be a canonical positive integer string");
    }
    const sequence = Number(raw);
    if (!Number.isSafeInteger(sequence) || sequence !== this.lastTwilioSequence + 1 || (first && sequence !== 1)) {
      throw protocolError("twilio_sequence_gap", "Twilio sequenceNumber was duplicated, skipped, or reordered");
    }
    this.lastTwilioSequence = sequence;
    return sequence;
  }

  validateActiveStream(message) {
    if (!["exchanging_capability", "bootstrapping", "connecting_provider", "awaiting_provider_ack", "ready"].includes(this.state)) {
      throw protocolError("twilio_event_order", `${message.event} arrived before start or after stop`);
    }
    this.consumeSequence(message);
    if (message.streamSid !== this.streamSid) throw protocolError("twilio_stream_mismatch", `${message.event} stream SID changed`);
  }

  handleMedia(message) {
    this.validateActiveStream(message);
    const media = requireRecord(message.media, "media");
    if (media.track !== undefined && media.track !== "inbound") {
      throw protocolError("twilio_track_mismatch", "agent bridge accepts inbound media only");
    }
    const payload = requireCanonicalBase64(media.payload, "media.payload", this.config.limits.mediaFrameBytes);
    this.providerOutbox.enqueue(jsonFrame(buildInputAudioAppendEvent(payload.encoded)), {
      kind: "input_audio",
      bytes: payload.bytes,
    });
  }

  handleMark(message) {
    this.validateActiveStream(message);
    const mark = requireRecord(message.mark, "mark");
    const name = requireString(mark.name, "mark.name", { maxBytes: 128, pattern: SAFE_MARK });
    const entry = this.pendingMarks.get(name);
    if (!entry) {
      const parsed = /^hacc_([0-9]+)_([0-9]+)$/.exec(name);
      if (parsed && Number(parsed[1]) < this.playbackGeneration) {
        this.record("playback.mark_after_clear", { generation: Number(parsed[1]), counter: Number(parsed[2]) });
        return;
      }
      if (parsed && Number(parsed[1]) === this.playbackGeneration && Number(parsed[2]) <= this.lastAcknowledgedMarkCounter) return;
      throw protocolError("unknown_twilio_mark", "Twilio echoed a mark that this bridge did not issue");
    }
    this.acknowledgePlaybackThrough(name);
  }

  handleDtmf(message) {
    this.validateActiveStream(message);
    const dtmf = requireRecord(message.dtmf, "dtmf");
    const digit = requireString(dtmf.digit, "dtmf.digit", { maxBytes: 1, pattern: SAFE_DTMF });
    this.record("caller.dtmf", { digit });
  }

  handleStop(message) {
    this.validateActiveStream(message);
    this.record("twilio.stop", { sequence: this.lastTwilioSequence });
    void this.shutdown("twilio_stop", { closeTwilio: true });
  }

  async exchangeAndConnect(bridgeToken, signal) {
    this.state = "bootstrapping";
    const bootstrap = await this.bootstrapClient.createSession({
      sessionId: this.sessionId,
      bridgeToken,
      accountSid: this.accountSid,
      callSid: this.callSid,
      streamSid: this.streamSid,
      mode: this.mode,
      bridgeInstanceId: this.config.instanceId,
    }, { signal });
    // A successful bootstrap response means the remote authority may already
    // have committed the session. During shutdown we therefore accept the
    // response only while performShutdown is explicitly waiting for this
    // operation, establish its event journal, and write a terminal outcome.
    // Once that bounded settlement window closes, no late response may mutate
    // the session.
    if (!this.bootstrapSettlementOpen || this.state === "closed") return;
    this.bootstrapAuthorityCommitted = true;

    this.eventCapability = bootstrap.eventCapability;
    this.mcpCapability = bootstrap.mcpCapability;
    this.renewalCapability = bootstrap.renewalCapability;
    this.activeCatalogAuthority = validateActiveCatalogAuthority(bootstrap.activeCatalogAuthority);
    this.capabilityState = Object.freeze({
      callId: bootstrap.callId,
      connection: bootstrap.connection,
      bridgeInstanceId: bootstrap.bridgeInstanceId,
      rotation: bootstrap.rotation,
      refreshAfterMs: Date.parse(bootstrap.refreshAfter),
      expiresAtMs: Date.parse(bootstrap.expiresAt),
      eventCapability: bootstrap.eventCapability,
      mcpCapability: bootstrap.mcpCapability,
      renewalCapability: bootstrap.renewalCapability,
    });
    if (!Number.isFinite(this.capabilityState.refreshAfterMs) ||
        !Number.isFinite(this.capabilityState.expiresAtMs) ||
        this.capabilityState.refreshAfterMs >= this.capabilityState.expiresAtMs) {
      throw protocolError("capability_rotation_invalid", "bootstrap rotation times are invalid");
    }
    // The durable event authority is bound to Twilio's StreamSid. The bridge's
    // random bootstrap session id is an exchange idempotency key, not the
    // journal identity consumed by the web ingress contract.
    this.journal = this.createJournal({ capability: bootstrap.eventCapability, sessionId: this.streamSid });
    this.record("session.authenticated", {
      account_sid_sha256: sha256(this.accountSid),
      call_sid_sha256: sha256(this.callSid),
      stream_sid_sha256: sha256(this.streamSid),
      bootstrap_token_sha256: sha256(bridgeToken),
      event_capability_sha256: sha256(bootstrap.eventCapability.token),
      mcp_capability_sha256: sha256(bootstrap.mcpCapability.token),
      renewal_capability_sha256: sha256(bootstrap.renewalCapability.token),
      event_capability_expires_at: bootstrap.eventCapability.expiresAt,
      mcp_capability_expires_at: bootstrap.mcpCapability.expiresAt,
      capability_rotation: bootstrap.rotation,
      capability_refresh_after: bootstrap.refreshAfter,
      active_catalog_digest: this.activeCatalogAuthority.catalogDigest,
      active_catalog_capability_epoch: this.activeCatalogAuthority.capabilityEpoch,
      mode: this.mode,
    });
    if (this.closing) {
      this.record("session.bootstrap_committed_during_shutdown", {
        call_id_sha256: sha256(bootstrap.callId),
        capability_rotation: bootstrap.rotation,
      }, { terminal: true });
      return;
    }

    this.capabilityRotationClient = this.createCapabilityRotationClient(bootstrap.rotationEndpoint);
    const providerConfig = validateProviderConfig({
      provider: bootstrap.provider,
      wsUrl: bootstrap.wsUrl,
      model: bootstrap.model,
      sessionUpdate: bootstrap.sessionUpdate,
    }, { allowedClientTools: this.config.allowedClientTools });
    validateToolSurface(providerConfig, this.config.allowedClientTools);
    const apiKey = this.config.providerKeys[providerConfig.provider];
    if (typeof apiKey !== "string" || apiKey.length < 1) {
      throw protocolError("provider_key_missing", `bridge has no local key for ${providerConfig.provider}`);
    }
    this.providerConfig = providerConfig;
    this.providerAdapter = this.createProviderAdapter(providerConfig);
    this.authorityClient = this.createAuthorityClient(bootstrap.mcpCapability);
    this.scheduleCapabilityRotation();
    this.record("session.bootstrap", {
      call_id_sha256: sha256(bootstrap.callId),
      provider: providerConfig.provider,
      model: providerConfig.model,
      configuration_sha256: sha256(stableJson(providerConfig.sessionUpdate)),
    });
    this.connectProvider(apiKey);
  }

  scheduleCapabilityRotation() {
    this.clearTimeout(this.capabilityRefreshTimer);
    this.clearTimeout(this.capabilityExpiryTimer);
    this.capabilityRefreshTimer = null;
    this.capabilityExpiryTimer = null;
    if (this.closing || !this.capabilityState) return;
    const now = this.now();
    const refreshDelay = Math.max(0, this.capabilityState.refreshAfterMs - now);
    const expiryDelay = Math.max(0, this.capabilityState.expiresAtMs - now);
    const expectedRotation = this.capabilityState.rotation;
    this.capabilityRefreshTimer = timerUnref(this.setTimeout(
      () => { void this.rotateCapabilities(); },
      refreshDelay,
    ));
    this.capabilityExpiryTimer = timerUnref(this.setTimeout(
      () => this.handleCapabilityExpiry(expectedRotation),
      expiryDelay,
    ));
  }

  scheduleCapabilityRetry() {
    if (this.closing || !this.capabilityState) return;
    this.clearTimeout(this.capabilityRefreshTimer);
    const remaining = this.capabilityState.expiresAtMs - this.now();
    if (remaining <= 0) return this.handleCapabilityExpiry(this.capabilityState.rotation);
    const exponent = Math.min(this.capabilityRotationFailures - 1, 6);
    const delay = Math.min(5_000, 100 * (2 ** Math.max(0, exponent)), remaining);
    this.capabilityRefreshTimer = timerUnref(this.setTimeout(
      () => { void this.rotateCapabilities(); },
      delay,
    ));
  }

  handleCapabilityExpiry(expectedRotation) {
    if (this.closing || !this.capabilityState || this.capabilityState.rotation !== expectedRotation) return;
    const remaining = this.capabilityState.expiresAtMs - this.now();
    if (remaining > 0) {
      this.clearTimeout(this.capabilityExpiryTimer);
      this.capabilityExpiryTimer = timerUnref(this.setTimeout(
        () => this.handleCapabilityExpiry(expectedRotation),
        remaining,
      ));
      return;
    }
    this.fatal("capability_authority_expired", undefined, 1011);
  }

  rotateCapabilities() {
    if (this.capabilityRotationPromise) return this.capabilityRotationPromise;
    if (this.closing || !this.capabilityState || !this.capabilityRotationClient) return Promise.resolve();
    const state = this.capabilityState;
    const now = this.now();
    if (now < state.refreshAfterMs) {
      this.scheduleCapabilityRotation();
      return Promise.resolve();
    }
    if (now >= state.expiresAtMs) {
      this.handleCapabilityExpiry(state.rotation);
      return Promise.resolve();
    }
    const controller = new AbortController();
    this.capabilityRotationAbortController = controller;
    const promise = this.performCapabilityRotation(state, controller.signal).finally(() => {
      if (this.capabilityRotationPromise === promise) this.capabilityRotationPromise = null;
      if (this.capabilityRotationAbortController === controller) this.capabilityRotationAbortController = null;
    });
    void promise.catch(() => {});
    this.capabilityRotationPromise = promise;
    return promise;
  }

  async performCapabilityRotation(state, signal) {
    try {
      const rotated = await this.capabilityRotationClient.rotate({
        sessionId: this.sessionId,
        bridgeInstanceId: state.bridgeInstanceId,
        expectedCallId: state.callId,
        rotation: state.rotation + 1,
        connection: state.connection,
        eventToken: state.eventCapability.token,
        mcpToken: state.mcpCapability.token,
        renewalToken: state.renewalCapability.token,
        expiresAt: state.renewalCapability.expiresAt,
      }, { signal });
      if (this.closing || this.capabilityState !== state) {
        if (this.closing && this.capabilityState === state) {
          this.capabilityRotationUnknownAtShutdown = false;
          this.record("capability.rotation_committed_during_shutdown", {
            previous_rotation: state.rotation,
            rotation: rotated.rotation,
          }, { terminal: true });
        }
        return;
      }
      if (this.now() >= state.expiresAtMs) {
        return this.fatal("capability_rotation_settled_after_expiry", undefined, 1011);
      }
      const nextAuthority = this.createAuthorityClient(rotated.mcpCapability);
      try {
        if (!this.journal || typeof this.journal.rotateScope !== "function") {
          throw protocolError("capability_rotation_unsupported", "event journal cannot rotate authority");
        }
        this.journal.rotateScope(rotated.eventCapability.token);
      } catch (error) {
        try { nextAuthority.close?.(); } catch {}
        throw error;
      }
      const previousAuthority = this.authorityClient;
      this.authorityClient = nextAuthority;
      this.eventCapability = rotated.eventCapability;
      this.mcpCapability = rotated.mcpCapability;
      this.renewalCapability = rotated.renewalCapability;
      this.capabilityState = Object.freeze({
        callId: rotated.callId,
        connection: rotated.connection,
        bridgeInstanceId: rotated.bridgeInstanceId,
        rotation: rotated.rotation,
        refreshAfterMs: Date.parse(rotated.refreshAfter),
        expiresAtMs: Date.parse(rotated.expiresAt),
        eventCapability: rotated.eventCapability,
        mcpCapability: rotated.mcpCapability,
        renewalCapability: rotated.renewalCapability,
      });
      this.capabilityRotationFailures = 0;
      this.retireAuthorityClient(previousAuthority, state.expiresAtMs);
      this.record("capability.rotated", {
        previous_rotation: state.rotation,
        rotation: rotated.rotation,
        event_capability_sha256: sha256(rotated.eventCapability.token),
        mcp_capability_sha256: sha256(rotated.mcpCapability.token),
        renewal_capability_sha256: sha256(rotated.renewalCapability.token),
        refresh_after: rotated.refreshAfter,
        expires_at: rotated.expiresAt,
      });
      this.scheduleCapabilityRotation();
    } catch (error) {
      if (this.closing || this.capabilityState !== state) {
        if (this.closing && this.capabilityState === state) {
          const code = safeErrorCode(error, "capability_rotation_failed");
          if (!signal.aborted && error?.indeterminate !== true) {
            this.capabilityRotationUnknownAtShutdown = false;
          }
          this.record("capability.rotation_settled_during_shutdown", {
            rotation: state.rotation + 1,
            code,
          }, { terminal: true });
        }
        return;
      }
      this.capabilityRotationFailures += 1;
      const remainingMs = state.expiresAtMs - this.now();
      this.record("capability.rotation_failed", {
        rotation: state.rotation + 1,
        code: safeErrorCode(error, "capability_rotation_failed"),
        indeterminate: error?.indeterminate === true,
        remaining_ms: Math.max(0, remainingMs),
        retry_scheduled: remainingMs > 0,
      });
      if (remainingMs <= 0 || error?.code === "rotation_capability_expired") {
        return this.fatal("capability_authority_expired", error, 1011);
      }
      this.scheduleCapabilityRetry();
    }
  }

  retireAuthorityClient(client, expiresAtMs) {
    if (!client || typeof client.close !== "function") return;
    this.retiredAuthorityClients.add(client);
    const delay = Math.max(0, expiresAtMs - this.now());
    const timer = timerUnref(this.setTimeout(() => {
      try { client.close(); } catch {}
      this.retiredAuthorityClients.delete(client);
      this.retiredAuthorityTimers.delete(client);
    }, delay));
    this.retiredAuthorityTimers.set(client, timer);
  }

  connectProvider(apiKey) {
    this.state = "connecting_provider";
    const socket = this.createProviderSocket({
      provider: this.providerConfig.provider,
      model: this.providerConfig.model,
      wsUrl: this.providerConfig.wsUrl,
      apiKey,
      connectMs: this.config.limits.providerConnectMs,
      maximumMessageBytes: this.config.limits.providerMessageBytes,
    });
    this.providerSocket = socket;
    this.providerConnectTimer = timerUnref(this.setTimeout(
      () => this.fatal("provider_connect_timeout", undefined, 1011),
      this.config.limits.providerConnectMs,
    ));
    wsOn(socket, "open", () => this.onProviderOpen());
    wsOn(socket, "message", (raw, isBinary) => this.onProviderFrame(raw, isBinary));
    wsOn(socket, "close", (code) => {
      if (!this.closing) this.fatal("provider_socket_closed", { code }, 1011);
    });
    wsOn(socket, "error", (error) => this.fatal("provider_socket_error", error, 1011));
  }

  onProviderOpen() {
    if (this.closing || this.state !== "connecting_provider") return;
    this.clearTimeout(this.providerConnectTimer);
    this.state = "awaiting_provider_ack";
    try {
      // Configuration is the one intentionally direct send. Audio/tool queues
      // remain detached until its acknowledgement, so unconfigured media can
      // never overtake session.update.
      this.providerSocket.send(jsonFrame(this.providerConfig.sessionUpdate), (error) => {
        if (error) this.fatal("provider_session_update_send", error, 1011);
      });
    } catch (error) {
      this.fatal("provider_session_update_send", error, 1011);
      return;
    }
    this.providerAckTimer = timerUnref(this.setTimeout(
      () => this.fatal("provider_session_ack_timeout", undefined, 1011),
      this.config.limits.sessionAckMs,
    ));
  }

  onProviderFrame(raw, isBinary = false) {
    if (this.closing) return;
    this.lastActivityAt = this.now();
    if (isBinary === true) return this.fatal("provider_binary_frame", undefined, 1003);
    const normalizedEvents = this.providerAdapter?.normalize(raw) ?? [];
    for (const event of normalizedEvents) {
      if (this.closing) break;
      if (this.state === "awaiting_provider_ack" && event.type !== "session.ack" && event.type !== "provider.error" && event.type !== "protocol.error") {
        this.fatal("provider_event_before_session_ack", undefined, 1011);
        break;
      }
      this.handleProviderEvent(event);
    }
  }

  handleProviderEvent(event) {
    switch (event.type) {
      case "session.ack": return this.handleProviderAcknowledgement(event);
      case "response.started": return this.handleResponseStarted(event);
      case "audio.delta": return this.handleOutputAudio(event);
      case "speech.started": return this.handleBargeIn(event);
      case "speech.stopped": return this.record("caller.speech_stopped", { audio_end_ms: event.audioEndMs ?? null });
      case "transcript": return this.handleTranscript(event);
      case "function_call.arguments_done":
        return this.record("tool.arguments_ready", {
          response_id: event.responseId,
          call_id: event.callId,
          item_id: event.itemId ?? null,
          name: event.name,
          executable: false,
        });
      case "function_call.cancelled":
        return this.record("tool.cancelled", { response_id: event.responseId, call_ids: event.callIds });
      case "function_calls.ready": return this.dispatchToolBatch(event);
      case "response.interrupted":
        return this.record("provider.response_interrupted", { response_id: event.responseId, reason_sha256: sha256(event.reason) });
      case "response.completed": return this.handleResponseCompleted(event);
      case "playback.truncated": return this.handleTruncationAcknowledgement(event);
      case "provider.error": {
        this.record("provider.error", {
          code: event.code ?? null,
          message_sha256: sha256(event.message),
          fatal: event.fatal,
        });
        if (event.fatal !== false) this.fatal("provider_reported_error", undefined, 1011);
        return;
      }
      case "protocol.error": {
        this.record("provider.protocol_error", {
          code: event.code,
          message_sha256: sha256(event.message),
          wire_type: event.wireType,
          fatal: event.fatal,
        });
        if (event.fatal !== false) this.fatal(`provider_${event.code}`, undefined, 1011);
        return;
      }
      default: return;
    }
  }

  handleProviderAcknowledgement(event) {
    if (this.state !== "awaiting_provider_ack") return this.fatal("unsolicited_provider_ack", undefined, 1011);
    const fields = event.configuration?.fields ?? {};
    if (Object.values(fields).some((field) => field?.status === "mismatch")) {
      return this.fatal("provider_configuration_mismatch", undefined, 1011);
    }
    this.clearTimeout(this.providerAckTimer);
    this.state = "ready";
    this.record("provider.ready", {
      provider: this.providerConfig.provider,
      model: this.providerConfig.model,
      session_id_sha256: sha256(event.sessionId),
      configuration: event.configuration,
    });
    this.providerOutbox.enqueue(jsonFrame(buildResponseCreateEvent()), { kind: "response_create", reason: "initial" });
    this.providerOutbox.attach(this.providerSocket);
  }

  handleResponseStarted(event) {
    if (this.state !== "ready") return this.fatal("provider_response_before_ready", undefined, 1011);
    if (this.activeResponseId && this.activeResponseId !== event.responseId) {
      return this.fatal("concurrent_provider_responses", undefined, 1011);
    }
    this.activeResponseId = event.responseId;
    this.record("provider.response_started", { response_id: event.responseId });
  }

  handleOutputAudio(event) {
    if (this.state !== "ready" || !event.itemId || this.activeResponseId !== event.responseId) {
      return this.fatal("provider_audio_provenance", undefined, 1011);
    }
    let audio;
    try {
      audio = requireCanonicalBase64(event.audio, "provider audio", this.config.limits.mediaFrameBytes);
    } catch (error) {
      return this.fatal(safeErrorCode(error, "provider_audio_invalid"), error, 1011);
    }
    const decoded = Buffer.from(audio.encoded, "base64");
    const chunks = [];
    for (let offset = 0; offset < decoded.byteLength; offset += this.config.limits.playbackMarkBytes) {
      chunks.push(decoded.subarray(offset, Math.min(decoded.byteLength, offset + this.config.limits.playbackMarkBytes)));
    }
    if (this.pendingMarks.size + chunks.length > this.config.limits.maximumPendingMarks) {
      return this.fatal("playback_mark_capacity", undefined, 1011);
    }
    let playback = this.playbackByItem.get(event.itemId);
    if (!playback) {
      playback = {
        itemId: event.itemId,
        responseId: event.responseId,
        generatedBytes: 0,
        playedBytes: 0,
        generation: this.playbackGeneration,
      };
      this.playbackByItem.set(event.itemId, playback);
    } else if (playback.responseId !== event.responseId || playback.generation !== this.playbackGeneration) {
      return this.fatal("playback_item_rebound", undefined, 1011);
    }
    let endBytes = playback.generatedBytes;
    const pendingEntries = [];
    const frames = [];
    for (const chunk of chunks) {
      endBytes += chunk.byteLength;
      const markCounter = this.nextMarkCounter++;
      const markName = `hacc_${this.playbackGeneration}_${markCounter}`;
      frames.push(
        {
          data: jsonFrame({ event: "media", streamSid: this.streamSid, media: { payload: chunk.toString("base64") } }),
          metadata: { kind: "audio", itemId: event.itemId, responseId: event.responseId },
        },
        {
          data: jsonFrame({ event: "mark", streamSid: this.streamSid, mark: { name: markName } }),
          metadata: { kind: "mark", name: markName, itemId: event.itemId, responseId: event.responseId },
        },
      );
      pendingEntries.push({
        name: markName,
        counter: markCounter,
        generation: this.playbackGeneration,
        itemId: event.itemId,
        responseId: event.responseId,
        endBytes,
      });
    }
    try {
      this.twilioOutbox.enqueueBatch(frames);
    } catch {
      return;
    }
    playback.generatedBytes = endBytes;
    this.currentPlaybackItemId = event.itemId;
    for (const entry of pendingEntries) this.pendingMarks.set(entry.name, entry);
  }

  acknowledgePlaybackThrough(markName) {
    const target = this.pendingMarks.get(markName);
    if (!target || target.generation !== this.playbackGeneration) return;
    for (const [name, entry] of this.pendingMarks) {
      if (entry.generation !== target.generation) continue;
      const playback = this.playbackByItem.get(entry.itemId);
      if (playback) playback.playedBytes = Math.max(playback.playedBytes, entry.endBytes);
      this.pendingMarks.delete(name);
      this.lastAcknowledgedMarkCounter = Math.max(this.lastAcknowledgedMarkCounter, entry.counter);
      if (name === markName) break;
    }
    const playback = this.playbackByItem.get(target.itemId);
    this.record("playback.mark_acknowledged", {
      response_id: target.responseId,
      item_id: target.itemId,
      generation: target.generation,
      mark_counter: target.counter,
      played_ms: Math.floor((playback?.playedBytes ?? 0) / 8),
    });
  }

  handleBargeIn(event) {
    if (this.state !== "ready") return;
    this.bargeInEpoch += 1;
    const interruptedResponseId = this.activeResponseId;
    if (interruptedResponseId) this.cancelRequestedResponses.add(interruptedResponseId);
    const interruptedItemId = this.currentPlaybackItemId;
    const playback = interruptedItemId ? this.playbackByItem.get(interruptedItemId) : null;
    const incompletePlayback = [...this.playbackByItem.values()]
      .filter((entry) => entry.generation === this.playbackGeneration && entry.generatedBytes > entry.playedBytes)
      .map((entry) => ({
        itemId: entry.itemId,
        responseId: entry.responseId,
        audioEndMs: Math.floor(entry.playedBytes / 8),
        generatedMs: Math.floor(entry.generatedBytes / 8),
      }));
    const playedMs = Math.floor((playback?.playedBytes ?? 0) / 8);
    const generatedMs = Math.floor((playback?.generatedBytes ?? 0) / 8);
    const invalidatedMarks = this.pendingMarks.size;
    this.pendingMarks.clear();
    this.playbackGeneration += 1;
    this.currentPlaybackItemId = null;
    const discarded = this.twilioOutbox.discard((metadata) => metadata?.kind === "audio" || metadata?.kind === "mark");
    try {
      this.twilioOutbox.enqueueFront(
        jsonFrame({ event: "clear", streamSid: this.streamSid }),
        { kind: "clear", generation: this.playbackGeneration },
      );
    } catch {
      return;
    }

    const repair = [];
    let interruptionEvents = [];
    if (interruptedResponseId) {
      let interruption;
      try {
        interruption = this.providerAdapter.interruptResponse({
          responseId: interruptedResponseId,
          reason: "twilio_barge_in",
        });
      } catch (error) {
        return this.fatal("provider_interruption_seal_failed", error, 1011);
      }
      interruptionEvents = interruption.normalizedEvents;
      repair.push(...interruption.wireEvents.map((wireEvent) => ({
        data: jsonFrame(wireEvent),
        metadata: {
          kind: "response_cancel",
          responseId: interruptedResponseId,
        },
      })));
    }
    for (const truncation of incompletePlayback) {
      repair.push({
        data: jsonFrame(buildConversationItemTruncateEvent({
          itemId: truncation.itemId,
          audioEndMs: truncation.audioEndMs,
        })),
        metadata: {
          kind: "conversation_truncate",
          responseId: truncation.responseId,
          itemId: truncation.itemId,
          audioEndMs: truncation.audioEndMs,
        },
      });
      this.pendingTruncations.set(truncation.itemId, {
        responseId: truncation.responseId,
        audioEndMs: truncation.audioEndMs,
        requestedAtMs: this.now(),
      });
    }
    const retiredCallIds = interruptionEvents
      .filter((normalized) => normalized.type === "function_call.cancelled")
      .flatMap((normalized) => normalized.callIds);
    for (const callId of retiredCallIds) {
      repair.push({
        data: jsonFrame(buildFunctionCallOutputEvent(callId, {
          ok: false,
          error: { code: "interrupted_before_execution", message: "Tool call retired because the caller interrupted this response." },
        })),
        metadata: { kind: "function_call_output", callId, retired: true },
      });
    }
    if (repair.length > 0) {
      try { this.providerOutbox.enqueueBatch(repair); }
      catch { return; }
    }
    for (const normalized of interruptionEvents) this.handleProviderEvent(normalized);
    if (retiredCallIds.length > 0) {
      this.record("tool.batch_retired", {
        response_id: interruptedResponseId,
        reason: "barge_in_cancel_requested",
        call_ids: retiredCallIds,
        repair_outputs_sent: true,
        response_create_suppressed: true,
      });
    }
    this.record("playback.barge_in", {
      speech_item_id: event.itemId ?? null,
      response_id: interruptedResponseId,
      output_item_id: interruptedItemId,
      generated_ms: generatedMs,
      acknowledged_played_ms: playedMs,
      truncations: incompletePlayback.map((entry) => ({
        response_id: entry.responseId,
        item_id: entry.itemId,
        generated_ms: entry.generatedMs,
        acknowledged_played_ms: entry.audioEndMs,
      })),
      invalidated_marks: invalidatedMarks,
      discarded_local_messages: discarded.messages,
      discarded_local_bytes: discarded.bytes,
      cancel_requested: Boolean(interruptedResponseId),
      truncate_requested: incompletePlayback.length > 0,
    });
  }

  handleTruncationAcknowledgement(event) {
    const pending = event.itemId ? this.pendingTruncations.get(event.itemId) : null;
    if (!pending || (event.responseId && pending.responseId !== event.responseId)) {
      return this.fatal("unexpected_truncation_ack", undefined, 1011);
    }
    this.pendingTruncations.delete(event.itemId);
    this.record("playback.truncation_acknowledged", {
      response_id: pending.responseId,
      item_id: event.itemId,
      audio_end_ms: pending.audioEndMs,
      latency_ms: Math.max(0, this.now() - pending.requestedAtMs),
    });
  }

  handleTranscript(event) {
    if (event.phase !== "final") return;
    this.record(event.speaker === "user" ? "user_said" : "agent_said", {
      text: event.text,
      item_id: event.itemId ?? null,
      response_id: event.responseId ?? null,
      revised: event.revised === true,
    });
  }

  handleResponseCompleted(event) {
    if (this.activeResponseId === event.responseId) this.activeResponseId = null;
    this.record("provider.response_completed", {
      response_id: event.responseId,
      status: event.status,
      executable_tool_calls: event.executableToolCalls === true,
      cancellation_requested: this.cancelRequestedResponses.has(event.responseId),
    });
  }

  dispatchToolBatch(event) {
    if (this.closing || this.state !== "ready") return;
    if (!event.executable) return this.fatal("unsafe_tool_authorization", undefined, 1011);
    if (this.cancelRequestedResponses.has(event.responseId)) {
      const repairFrames = event.calls.map((call) => ({
        data: jsonFrame(buildFunctionCallOutputEvent(call.callId, {
          ok: false,
          error: { code: "interrupted_before_execution", message: "Tool call retired because the caller interrupted this response." },
        })),
        metadata: { kind: "function_call_output", callId: call.callId, retired: true },
      }));
      try { this.providerOutbox.enqueueBatch(repairFrames); }
      catch { return; }
      this.record("tool.batch_retired", {
        response_id: event.responseId,
        reason: "barge_in_cancel_requested",
        call_ids: event.calls.map((call) => call.callId),
        repair_outputs_sent: true,
        response_create_suppressed: true,
      });
      return;
    }
    if (!Array.isArray(event.calls) || event.calls.length < 1 || this.toolBatches.has(event.responseId)) {
      return this.fatal("tool_batch_identity", undefined, 1011);
    }
    if (this.totalToolCalls + event.calls.length > this.config.limits.maximumToolCalls) {
      return this.fatal("tool_call_capacity", undefined, 1011);
    }
    if (this.activeCatalogAuthority?.availability === "blocked") {
      return this.fatal("active_catalog_blocked", undefined, 1011);
    }
    for (const call of event.calls) {
      if (!this.config.allowedClientTools.includes(call.name)) {
        return this.fatal("tool_not_allowed", undefined, 1011);
      }
    }
    this.totalToolCalls += event.calls.length;
    const authorizedBargeInEpoch = this.bargeInEpoch;
    const authorityClient = this.authorityClient;
    if (!authorityClient) return this.fatal("authority_not_ready", undefined, 1011);
    const activeCatalogAuthority = this.activeCatalogAuthority;
    if (!activeCatalogAuthority) return this.fatal("active_catalog_authority_missing", undefined, 1011);
    // Pin one immutable authority snapshot for the provider's entire terminal
    // batch. A capability rotation may complete between calls, but later calls
    // in this already-authorized batch must not silently cross authority epochs.
    const promise = this.executeToolBatch(
      event,
      authorizedBargeInEpoch,
      authorityClient,
      activeCatalogAuthority,
    ).catch((error) => {
      if (!this.closing) this.fatal(safeErrorCode(error, "tool_batch_failed"), error, 1011);
    }).finally(() => {
      this.toolBatches.delete(event.responseId);
    });
    this.toolBatches.set(event.responseId, {
      promise,
      callIds: event.calls.map((call) => call.callId),
      authorizedBargeInEpoch,
      authorityClient,
      activeCatalogAuthority,
    });
  }

  async executeToolBatch(event, authorizedBargeInEpoch, authorityClient, activeCatalogAuthority) {
    this.record("tool.batch_authorized", {
      response_id: event.responseId,
      calls: event.calls.map((call) => ({
        call_id: call.callId,
        item_id: call.itemId ?? null,
        name: call.name,
        arguments_sha256: sha256(stableJson(call.arguments)),
      })),
    });
    const settled = [];
    for (let index = 0; index < event.calls.length; index += 1) {
      const call = event.calls[index];
      if (this.closing || this.bargeInEpoch !== authorizedBargeInEpoch) {
        const code = this.closing ? "session_closing_before_execution" : "interrupted_before_execution";
        const message = this.closing
          ? "Tool call was not started because the bridge session is closing."
          : "Tool call was not started because the caller interrupted the batch.";
        for (const skippedCall of event.calls.slice(index)) {
          settled.push({
            call: skippedCall,
            ok: false,
            skipped: true,
            error: new AuthorityClientError(code, message, {
              indeterminate: false,
              executionStarted: false,
            }),
          });
        }
        break;
      }
      try {
        const result = await authorityClient.callCapabilityGateway({
          provider: this.providerConfig.provider,
          callId: call.callId,
          responseId: call.responseId,
          itemId: call.itemId,
          name: call.name,
          arguments: call.arguments,
          activeCatalogAuthority,
        });
        settled.push({ call, ok: true, result, toolError: result.isError === true });
      } catch (error) {
        const typed = error instanceof AuthorityClientError ? error : new AuthorityClientError(
          "authority_transport_error",
          "authority call failed",
          { indeterminate: true, cause: error },
        );
        settled.push({ call, ok: false, error: typed });
        if (typed.indeterminate) {
          for (const skippedCall of event.calls.slice(index + 1)) {
            settled.push({
              call: skippedCall,
              ok: false,
              skipped: true,
              error: new AuthorityClientError(
                "prior_authority_outcome_indeterminate",
                "Tool call was not started because a prior batch outcome is unknown.",
                { indeterminate: false, executionStarted: false },
              ),
            });
          }
          break;
        }
      }
    }

    const evidence = settled.map((entry) => ({
      call_id: entry.call.callId,
      ok: entry.ok,
      ...(entry.ok
        ? { result_sha256: sha256(stableJson(entry.result.output)), tool_error: entry.toolError }
        : {
            code: entry.error.code,
            indeterminate: entry.error.indeterminate === true,
            skipped: entry.skipped === true,
          }),
    }));
    this.record("tool.batch_settled", { response_id: event.responseId, calls: evidence });
    if (this.closing) return;
    if (settled.some((entry) => !entry.ok && entry.error.indeterminate)) {
      return this.fatal("authority_outcome_indeterminate", undefined, 1011);
    }
    if (settled.length > 0 && settled.every((entry) => entry.ok)) {
      let priorEpoch = activeCatalogAuthority.capabilityEpoch;
      for (const entry of settled) {
        const next = validateActiveCatalogAuthority(entry.result.activeCatalogAuthority, { allowAvailability: true });
        if (next.capabilityEpoch < priorEpoch) {
          throw protocolError("active_catalog_rewind", "gateway result attempted to rewind active catalog authority");
        }
        priorEpoch = next.capabilityEpoch;
      }
      const nextAuthority = validateActiveCatalogAuthority(
        settled.at(-1).result.activeCatalogAuthority,
        { allowAvailability: true },
      );
      // Commit exactly once, after every call in the provider terminal batch
      // yielded a verified envelope. Calls in the batch above all used the old
      // snapshot; no later call is silently rebound to a newly learned lease.
      this.activeCatalogAuthority = nextAuthority;
      this.record("active_catalog.advanced", {
        response_id: event.responseId,
        previous_catalog_digest: activeCatalogAuthority.catalogDigest,
        catalog_digest: nextAuthority.catalogDigest,
        previous_capability_epoch: activeCatalogAuthority.capabilityEpoch,
        capability_epoch: nextAuthority.capabilityEpoch,
        availability: nextAuthority.availability ?? "active",
      });
    }

    const frames = settled.map((entry) => ({
      data: jsonFrame(buildFunctionCallOutputEvent(entry.call.callId, entry.ok ? entry.result.output : {
        ok: false,
        error: { code: entry.error.code, message: String(entry.error.message).slice(0, 1_000) },
      })),
      metadata: { kind: "function_call_output", callId: entry.call.callId },
    }));
    const responseCreateSuppressed = this.bargeInEpoch !== authorizedBargeInEpoch;
    if (!responseCreateSuppressed) {
      frames.push({
        data: jsonFrame(buildResponseCreateEvent()),
        metadata: { kind: "response_create", reason: "tool_batch", responseId: event.responseId },
      });
    }
    this.providerOutbox.enqueueBatch(frames);
    if (responseCreateSuppressed) {
      this.record("tool.response_create_suppressed", {
        response_id: event.responseId,
        reason: "barge_in_after_tool_authorization",
      });
    }
  }

  record(type, payload, { terminal = false } = {}) {
    if (!this.journal || this.journalSealed) return false;
    try {
      if (terminal && typeof this.journal.appendTerminal === "function") this.journal.appendTerminal(type, payload);
      else this.journal.append(type, payload, { terminal });
      void this.journal.flush().catch((error) => {
        this.logger.warn?.("bridge_journal_flush_failed", {
          session_id: this.sessionId,
          code: safeErrorCode(error, "journal_flush_failed"),
        });
      });
      return true;
    } catch (error) {
      this.logger.error("bridge_journal_append_failed", {
        session_id: this.sessionId,
        code: safeErrorCode(error, "journal_append_failed"),
      });
      if (!this.closing) queueMicrotask(() => this.fatal("journal_capacity_or_state", error, 1011));
      return false;
    }
  }

  fatal(code, error, closeCode = 1011) {
    if (this.closing) return;
    this.closeCode = closeCode;
    this.logger.error("bridge_session_failure", {
      session_id: this.sessionId,
      code,
      error_code: safeErrorCode(error, "none"),
      error_sha256: error ? sha256(error instanceof Error ? error.message : stableJson(error)) : null,
    });
    this.record("session.failure", {
      code,
      error_code: safeErrorCode(error, "none"),
      error_sha256: error ? sha256(error instanceof Error ? error.message : stableJson(error)) : null,
    }, { terminal: true });
    void this.shutdown(code);
  }

  shutdown(reason = "shutdown", { closeTwilio = true } = {}) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.state = "closing";
    this.clearTimeout(this.startTimer);
    this.clearTimeout(this.callTimer);
    this.clearTimeout(this.providerConnectTimer);
    this.clearTimeout(this.providerAckTimer);
    this.clearTimeout(this.capabilityRefreshTimer);
    this.clearTimeout(this.capabilityExpiryTimer);
    this.capabilityRefreshTimer = null;
    this.capabilityExpiryTimer = null;
    this.capabilityRotationUnknownAtShutdown = Boolean(this.capabilityRotationPromise);
    this.capabilityRotationAbortController?.abort();
    for (const timer of this.retiredAuthorityTimers.values()) this.clearTimeout(timer);
    this.retiredAuthorityTimers.clear();
    this.clearInterval(this.maintenanceTimer);

    const promise = this.performShutdown(reason, closeTwilio).finally(() => {
      this.state = "closed";
      if (!this.closedNotified) {
        this.closedNotified = true;
        try { this.onClosed(this); } catch {}
      }
    });
    void promise.catch(() => {});
    this.shutdownPromise = promise;
    return promise;
  }

  async performShutdown(reason, closeTwilio) {
    const providerAbandoned = this.providerOutbox.close();
    const twilioAbandoned = this.twilioOutbox.close();
    closeSocket(this.providerSocket, 1000, "bridge shutdown");
    if (closeTwilio) closeSocket(this.twilioSocket, this.closeCode, "bridge session ended");
    try { this.authorityClient?.close?.(); }
    catch {}
    for (const client of this.retiredAuthorityClients) {
      try { client.close?.(); } catch {}
    }
    this.retiredAuthorityClients.clear();

    const ownedOperations = await this.settleOwnedOperationsForShutdown();
    this.bootstrapSettlementOpen = false;
    for (const operation of ownedOperations.unknown) {
      const recorded = this.record(`${operation}.outcome_unknown_at_shutdown`, {
        reason: "shutdown_deadline",
      }, { terminal: true });
      if (!recorded) {
        this.logger.error("bridge_operation_outcome_unknown_at_shutdown", {
          session_id: this.sessionId,
          operation,
          reason: "shutdown_deadline",
        });
      }
    }

    if (this.toolBatches.size > 0) {
      const pending = Promise.allSettled([...this.toolBatches.values()].map((entry) => entry.promise));
      await Promise.race([
        pending,
        new Promise((resolve) => this.setTimeout(resolve, Math.min(1_000, this.config.limits.shutdownMs))),
      ]);
    }
    if (this.toolBatches.size > 0) {
      for (const [responseId, entry] of this.toolBatches) {
        this.record("tool.outcome_unknown_at_shutdown", {
          response_id: responseId,
          call_ids: entry.callIds,
          reason: "shutdown_deadline",
        }, { terminal: true });
      }
    }
    this.record("session.ended", {
      reason,
      provider_abandoned: providerAbandoned,
      twilio_abandoned: twilioAbandoned,
      pending_marks: this.pendingMarks.size,
      pending_truncations: this.pendingTruncations.size,
      pending_tool_batches: this.toolBatches.size,
      pending_owned_operations: ownedOperations.unknown,
    }, { terminal: true });
    let journalResult = null;
    if (this.journal) {
      this.journalSealed = true;
      try {
        journalResult = await this.journal.shutdown({ deadlineMs: this.config.limits.shutdownMs });
      } catch (error) {
        this.logger.error("bridge_journal_shutdown_failed", {
          session_id: this.sessionId,
          code: safeErrorCode(error, "journal_shutdown_failed"),
        });
      }
    }
    this.logger.info("bridge_session_closed", {
      session_id: this.sessionId,
      reason,
      journal_drained: journalResult?.drained ?? null,
      journal_pending_events: journalResult?.pending_events ?? null,
      pending_owned_operations: ownedOperations.unknown,
    });
    return Object.freeze({
      reason,
      journal: journalResult,
      providerAbandoned,
      twilioAbandoned,
      pendingOwnedOperations: ownedOperations.unknown,
    });
  }

  async settleOwnedOperationsForShutdown() {
    const operations = [
      ["bootstrap", this.bootstrapPromise],
      ["capability_rotation", this.capabilityRotationPromise],
    ].filter(([, promise]) => promise && typeof promise.then === "function")
      .map(([name, promise]) => {
        const entry = { name, settled: false, wait: null };
        entry.wait = Promise.resolve(promise).then(
          () => { entry.settled = true; },
          () => { entry.settled = true; },
        );
        return entry;
      });
    if (operations.length === 0) {
      const unknown = [];
      if (this.bootstrapAuthorityCommitted && !this.journal) unknown.push("bootstrap");
      if (this.capabilityRotationUnknownAtShutdown) unknown.push("capability_rotation");
      return Object.freeze({ unknown: Object.freeze(unknown) });
    }

    let deadlineTimer;
    let deadlineUnknown = null;
    const deadline = new Promise((resolve) => {
      // Keep this timer referenced while shutdown owns a possibly committed
      // bootstrap. At the deadline, close the acceptance window before aborting
      // so an injected client that ignores AbortSignal still cannot mutate the
      // closed session later.
      deadlineTimer = this.setTimeout(() => {
        deadlineUnknown = operations
          .filter((operation) => !operation.settled)
          .map((operation) => operation.name);
        this.bootstrapSettlementOpen = false;
        this.bootstrapAbortController?.abort();
        resolve();
      }, this.config.limits.shutdownMs);
    });
    await Promise.race([
      Promise.all(operations.map((operation) => operation.wait)),
      deadline,
    ]);
    this.clearTimeout(deadlineTimer);
    const unknown = new Set(deadlineUnknown ??
      operations.filter((operation) => !operation.settled).map((operation) => operation.name));
    if (this.bootstrapAuthorityCommitted && !this.journal) unknown.add("bootstrap");
    if (this.capabilityRotationUnknownAtShutdown) unknown.add("capability_rotation");
    return Object.freeze({
      // Preserve the pre-abort snapshot. A real client rejects promptly when
      // the deadline abort fires, but that local rejection cannot prove the
      // authority did not already commit the request remotely.
      unknown: Object.freeze([...unknown]),
    });
  }

  snapshot() {
    return Object.freeze({
      session_id: this.sessionId,
      state: this.state,
      provider: this.providerConfig?.provider ?? null,
      model: this.providerConfig?.model ?? null,
      last_twilio_sequence: this.lastTwilioSequence,
      pending_marks: this.pendingMarks.size,
      pending_truncations: this.pendingTruncations.size,
      pending_tool_batches: this.toolBatches.size,
      capability_rotation: this.capabilityState?.rotation ?? null,
      capability_refresh_after: this.capabilityState
        ? new Date(this.capabilityState.refreshAfterMs).toISOString()
        : null,
      capability_expires_at: this.capabilityState
        ? new Date(this.capabilityState.expiresAtMs).toISOString()
        : null,
      capability_rotation_failures: this.capabilityRotationFailures,
      retired_authority_clients: this.retiredAuthorityClients.size,
      active_catalog_digest: this.activeCatalogAuthority?.catalogDigest ?? null,
      active_catalog_capability_epoch: this.activeCatalogAuthority?.capabilityEpoch ?? null,
      active_catalog_availability: this.activeCatalogAuthority?.availability ?? "active",
      provider_outbox: this.providerOutbox.stats,
      twilio_outbox: this.twilioOutbox.stats,
    });
  }
}

export const sessionInternals = Object.freeze({
  requireCanonicalBase64,
  validateActiveCatalogAuthority,
  validateToolSurface,
});

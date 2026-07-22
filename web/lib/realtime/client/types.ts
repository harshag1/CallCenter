/**
 * Provider-neutral contracts for server-side realtime voice clients.
 *
 * Audio crossing this boundary is raw, signed 16-bit little-endian PCM. Keeping
 * the codec explicit prevents a benchmark from accidentally comparing a real
 * audio turn on one provider with text or a containerized audio file on another.
 */

export type ServerRealtimeProvider = "openai" | "xai" | "gemini";

export const LOCAL_TOOL_PROXY_FUNCTION_NAME = "capability_gateway" as const;
/** Existing `/api/mcp` durable invocation identity key. */
export const LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY = "hacc/provider_tool_call_id" as const;
export const PROVIDER_PROVENANCE_META_KEY = "com.harsha.callcenter/provider-provenance" as const;

/**
 * The only provider-visible function needed by the public OpenAI/xAI path.
 * The host resolves `tool_name` against the current, server-owned catalog and
 * appends native call provenance outside model-authored arguments.
 */
export const LOCAL_TOOL_PROXY_FUNCTION = deepFreezeContract({
  type: "function",
  name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
  description: [
    "Call exactly one tool from the latest server-disclosed capability catalog through the local gateway.",
    "Copy the disclosed tool name exactly and place only that tool's arguments in arguments.",
    "Never add provider call IDs, response IDs, event IDs, provenance, or transport metadata; the host binds those from the provider wire protocol.",
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      tool_name: {
        type: "string",
        description: "Exact name of one tool in the latest server-disclosed capability catalog.",
        pattern: "^[a-z][a-z0-9_.-]{1,63}$",
      },
      arguments: {
        type: "object",
        description: "Arguments for the selected tool. Provider provenance is never supplied here.",
        additionalProperties: true,
      },
    },
    required: ["tool_name", "arguments"],
  },
} as const);

/** Both explicit grants are required before any MCP server is sent to a provider. */
export function experimentalProviderDirectMcpEnabled(settings: Record<string, unknown>): boolean {
  const raw = settings.experimental_provider_direct_mcp;
  if (raw === undefined) return false;
  if (!isPlainRecord(raw)) {
    throw new Error("experimental_provider_direct_mcp must be an object");
  }
  for (const key of ["enabled", "allow_consequential"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
      throw new Error(`experimental_provider_direct_mcp.${key} must be boolean`);
    }
  }
  const enabled = raw.enabled === true;
  const allowConsequential = raw.allow_consequential === true;
  if (enabled !== allowConsequential) {
    throw new Error(
      "provider-direct MCP requires both experimental_provider_direct_mcp.enabled "
      + "and experimental_provider_direct_mcp.allow_consequential",
    );
  }
  return enabled && allowConsequential;
}

export function isLocalToolProxyFunction(value: unknown): boolean {
  return jsonContractEqual(value, LOCAL_TOOL_PROXY_FUNCTION);
}

/**
 * Accept the canonical open catalog proxy or a stricter closed-enum variant.
 * Closed variants must preserve the exact envelope keys and may only narrow
 * `tool_name`; provider adapters still derive provenance from the wire.
 */
export function isSafeLocalToolProxyFunction(value: unknown): boolean {
  if (isLocalToolProxyFunction(value)) return true;
  if (!isPlainRecord(value)
    || value.type !== "function"
    || value.name !== LOCAL_TOOL_PROXY_FUNCTION_NAME
    || typeof value.description !== "string"
    || !isPlainRecord(value.parameters)) return false;
  const parameters = value.parameters;
  if (parameters.type !== "object"
    || parameters.additionalProperties !== false
    || !isPlainRecord(parameters.properties)
    || !Array.isArray(parameters.required)
    || parameters.required.length !== 2
    || parameters.required[0] !== "tool_name"
    || parameters.required[1] !== "arguments") return false;
  const propertyKeys = Object.keys(parameters.properties).sort();
  if (propertyKeys.length !== 2 || propertyKeys[0] !== "arguments" || propertyKeys[1] !== "tool_name") return false;
  const toolName = parameters.properties.tool_name;
  const arguments_ = parameters.properties.arguments;
  if (!isPlainRecord(toolName)
    || toolName.type !== "string"
    || !Array.isArray(toolName.enum)
    || toolName.enum.length === 0
    || new Set(toolName.enum).size !== toolName.enum.length
    || toolName.enum.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9_]{1,63}$/u.test(item))) return false;
  return isPlainRecord(arguments_)
    && arguments_.type === "object"
    && arguments_.additionalProperties === false
    && isPlainRecord(arguments_.properties)
    && Object.keys(arguments_.properties).length === 0;
}

export type ProviderToolCallProvenance = Readonly<{
  schemaVersion: 1;
  provider: Extract<ServerRealtimeProvider, "openai" | "xai">;
  /** Opaque provider-native function call ID. Never derived from model arguments. */
  nativeCallId: string;
  nativeResponseId: string;
  nativeItemId?: string;
  terminalEventId?: string;
  terminalWireType: string;
}>;

export type LocalToolProxyDispatch = Readonly<{
  method: "tools/call";
  params: Readonly<{
    name: string;
    arguments: Readonly<Record<string, unknown>>;
    _meta: Readonly<{
      [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: string;
      [PROVIDER_PROVENANCE_META_KEY]: ProviderToolCallProvenance;
    }>;
  }>;
}>;

export type Pcm16Format = {
  encoding: "pcm16";
  sampleRateHz: number;
  channels: 1;
};

export type Pcm16Audio = Pcm16Format & {
  /** Interleaving is irrelevant while mono is the only supported format. */
  data: Uint8Array;
};

export type RealtimeToolCall = {
  callId: string;
  name: string;
  argumentsText: string;
  /** `null` means the provider's argument string was not valid JSON. */
  argumentsJson: unknown | null;
  argumentsError?: string;
  itemId?: string;
  /** Immutable response provenance established before this call becomes executable. */
  responseId: string;
  /** Gemini has no provider response ID; its adapter labels the local correlation ID explicitly. */
  responseIdSource?: "provider" | "client_local";
  /**
   * Provider-neutral causal join for calls emitted by transports without a
   * provider response identity. The provider call ID remains authoritative;
   * the trigger and turn fields only bind it to this client's exact turn.
   */
  causalBinding?: Readonly<{
    connectionEpoch: number;
    inputTurn: number;
    trigger: "audio_activity_end" | "client_content" | "tool_response";
    clientMessageOrdinal: number;
    triggerObservationSha256?: string;
    providerCallId: string;
    localResponseId: string;
  }>;
  /** Provider event that made the call terminal/executable, when the provider supplies one. */
  terminalEventId?: string;
  terminalWireType: string;
};

/** Exact provider-neutral terminal states; diagnostic detail belongs in `reason`. */
export type RealtimeResponseTerminalStatus =
  | "completed"
  | "cancelled"
  | "failed"
  | "incomplete"
  | "interrupted";

export type RealtimeResponseCancelTarget = Readonly<{
  /** The response to cancel. Untargeted cancellation is deliberately not exposed. */
  responseId: string;
}>;

export type RealtimeOutputAudioTruncation = Readonly<{
  /** Response already sealed through `cancelResponse`. */
  responseId: string;
  /** Assistant message item whose unheard audio must be removed from provider history. */
  itemId: string;
  /** Realtime providers currently require the audio content part at index zero. */
  contentIndex: 0;
  /** Inclusive playback boundary, in whole milliseconds. */
  audioEndMs: number;
}>;

export type SessionConfigurationField =
  | "model"
  | "voice"
  | "instructions"
  | "tools"
  | "tool_choice"
  | "input_audio"
  | "output_audio"
  | "turn_detection";

export type SessionConfigurationFieldStatus =
  | "verified"
  | "mismatch"
  | "unsupported"
  | "unverifiable"
  | "not_requested";

export type SessionConfigurationFieldProof = Readonly<{
  status: SessionConfigurationFieldStatus;
  /** Domain-separated hashes avoid copying prompts, credentials, or tool schemas into artifacts. */
  requestedSha256?: string;
  acknowledgedSha256?: string;
  /** Exact provider event that supplied the acknowledged value. */
  acknowledgedBy?: "session.created" | "session.updated";
  reason?: string;
  /** Structured omission evidence; consumers must not parse the human reason string. */
  omission?: Readonly<{
    kind: "field_omitted" | "requested_paths_omitted";
    paths: readonly string[];
    acknowledgedShape: "missing" | "empty_object" | "partial_value";
  }>;
  /** Requested paths whose provider-echoed values explicitly differ. */
  contradiction?: Readonly<{
    kind: "requested_paths_mismatched";
    paths: readonly string[];
  }>;
  /**
   * Safe evidence that xAI's documented nested function wrapper was reduced to
   * the same canonical callable identity as the requested flat declaration.
   * Values remain hashed; only structural key names and source paths are kept.
   */
  aliasNormalization?: Readonly<{
    kind: "xai_function_tool_wire_alias_v1";
    policySha256: string;
    sourcePaths: readonly string[];
    keyInventory: readonly Readonly<{
      path: string;
      keys: readonly string[];
    }>[];
    canonicalSha256: string;
    claimBoundary: "wire_alias_equivalence_only_paid_exact_call_still_required";
  }>;
}>;

/**
 * What the provider actually acknowledged, not what the client attempted to send.
 * `strictParityVerified` is deliberately false for unsupported, omitted, or
 * otherwise unverifiable fields; local setup serialization is not provider proof.
 */
export type SessionConfigurationAcknowledgement = Readonly<{
  schemaVersion: 1;
  strictParityVerified: boolean;
  /** Provider-session paid gate only; plan, budget, and attestation gates remain separate. */
  paidBenchmarkReady: boolean;
  /** Projection of the complete requested session object onto the provider echo. */
  session?: SessionConfigurationFieldProof;
  fields: Readonly<Record<SessionConfigurationField, SessionConfigurationFieldProof>>;
}>;

export type RealtimeToolResult = {
  callId: string;
  output: unknown;
};

export type RealtimeInputAudioCommitAcknowledgement = Readonly<{
  provider: Extract<ServerRealtimeProvider, "openai" | "xai">;
  connectionEpoch: number;
  commitOrdinal: number;
  status: "acknowledged";
  wireObservation?: RealtimeWireObservationAttribution;
}>;

export type NormalizedRealtimeUsage = {
  inputTextTokens?: number;
  inputAudioTokens?: number;
  cachedInputTokens?: number;
  cachedInputTextTokens?: number;
  cachedInputAudioTokens?: number;
  outputTextTokens?: number;
  outputAudioTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  /** Provider-reported or byte-derived audio meters used by xAI billing. */
  inputAudioMinutes?: number;
  outputAudioMinutes?: number;
  /** Billable user text-message events; function outputs are deliberately excluded. */
  billableTextInputEvents?: number;
  meteringSource?: "provider_reported" | "client_measured" | "mixed";
  /** Provider payload retained for accounting reconciliation. */
  raw: Record<string, unknown>;
};

export type RealtimeWireObservationReference = Readonly<{
  availability: "observed";
  connectionEpoch: number;
  sequence: number;
  observationSha256: string;
  payloadSha256: string;
  projectionSha256: string;
  /** Present when the observed frame carries exactly one provider call ID. */
  callIdSha256?: string;
}>;

export type RealtimeWireObservationUnavailable = Readonly<{
  availability: "unavailable";
  reason: "client_generated" | "transport_generated" | "legacy_adapter";
}>;

export type RealtimeWireObservationAttribution =
  | RealtimeWireObservationReference
  | RealtimeWireObservationUnavailable;

/**
 * Content-free failure evidence for OpenAI-compatible realtime transports.
 * Provider/socket plaintext is never retained here: raw values are represented
 * by domain-separated hashes and a raw code is included only from a closed,
 * non-sensitive allowlist.
 */
export type RealtimeTransportFailureDiagnostic = Readonly<{
  schemaVersion: 1;
  origin: "provider_wire" | "websocket_error" | "websocket_close" | "client_transport";
  category:
    | "provider_authentication"
    | "provider_quota"
    | "provider_rate_limit"
    | "provider_request"
    | "provider_safety"
    | "provider_service"
    | "provider_protocol"
    | "network"
    | "tls"
    | "websocket_protocol"
    | "normal_close"
    | "policy_close"
    | "server_close"
    | "application_close"
    | "unknown";
  /** Present only when the exact code belongs to the module's closed allowlist. */
  safeRawCode?: string;
  rawCodeSha256?: string;
  messageSha256?: string;
  reasonSha256?: string;
  closeCodeClass?:
    | "normal"
    | "going_away"
    | "protocol_error"
    | "unsupported_data"
    | "abnormal"
    | "invalid_payload"
    | "policy_violation"
    | "message_too_big"
    | "extension_required"
    | "server_error"
    | "service_restart"
    | "try_again_later"
    | "bad_gateway"
    | "registered"
    | "private_use"
    | "unknown";
  responseGenerationRequested: boolean;
  responseGenerationStarted: boolean;
  responseTerminalObserved: boolean;
}>;

type EventBase = {
  provider: ServerRealtimeProvider;
  receivedAtMs: number;
  /** Monotonic receipt clock for latency math; absent on legacy adapters. */
  receivedAtMonotonicMs?: number;
  wireType: string;
  /** Stable provider-native event ID, when one exists on the wire. */
  nativeEventId?: string;
  /** Exact redacted wire frame from which this normalized event was derived. */
  wireObservation?: RealtimeWireObservationAttribution;
};

export type NormalizedRealtimeEvent =
  | (EventBase & {
      type: "session.ready";
      sessionId?: string;
      configuration?: SessionConfigurationAcknowledgement;
    })
  | (EventBase & {
      type: "session.resumption";
      handle: string;
      resumable: boolean;
      conversationId?: string;
    })
  | (EventBase & {
      type: "input.transcript";
      phase: "delta" | "final";
      /** Best current transcript for the item, including cumulative xAI updates. */
      text: string;
      /** Newly appended suffix when one can be derived without guessing. */
      delta?: string;
      itemId?: string;
      revised?: boolean;
    })
  | (EventBase & {
      type: "output.transcript";
      phase: "delta" | "final";
      text: string;
      delta?: string;
      itemId?: string;
      responseId: string;
      source: "audio" | "text";
      revised?: boolean;
    })
  | (EventBase & {
      type: "output.audio";
      audio: Uint8Array;
      format: Pcm16Format;
      itemId?: string;
      responseId: string;
    })
  | (EventBase & {
      type: "response.started";
      responseId: string;
      responseIdSource?: "provider" | "client_local";
      causalBinding?: Readonly<{
        trigger: "server_vad_speech_stopped" | "tool_continuation";
        turnOrdinal: number;
        triggerObservationSha256: string;
        originResponseId?: string;
      }>;
    })
  | (EventBase & {
      type: "response.completed";
      responseId: string;
      responseIdSource?: "provider" | "client_local";
      status: RealtimeResponseTerminalStatus;
      /** Provider terminal detail kept separate so `status` remains enumerable. */
      reason?: string;
    })
  | (EventBase & {
      /** All calls produced by one model response, in provider order. */
      type: "tool.calls";
      responseId: string;
      calls: RealtimeToolCall[];
    })
  | (EventBase & {
      /** A complete provider call batch was returned to the provider. */
      type: "tool.results.submitted";
      responseId: string;
      responseIdSource: "provider" | "client_local";
      callIds: string[];
      continuationRequested: boolean;
    })
  | (EventBase & {
      /** Explicit post-tool generation trigger for a previously returned batch. */
      type: "tool.continuation.requested";
      originResponseId: string;
      responseIdSource: "provider" | "client_local";
    })
  | (EventBase & {
      /** Explicit acknowledgement of a prior manual input-buffer commit. */
      type: "input.audio_committed";
      connectionEpoch: number;
      commitOrdinal: number;
    })
  | (EventBase & {
      /** Provider wire acknowledgement before client-side FIFO correlation. */
      type: "input.audio_commit_acknowledgement";
      itemId?: string;
    })
  | (EventBase & {
      /** Provider VAD activity; expected only for an explicitly configured server-VAD session. */
      type: "input.speech_activity";
      phase: "started" | "stopped";
      itemId?: string;
      audioOffsetMs?: number;
    })
  | (EventBase & {
      /**
       * Host-authored local proxy request. The target comes from the gateway
       * arguments; `_meta` is independently bound to immutable provider IDs.
       */
      type: "tool.dispatch";
      responseId: string;
      gateway: typeof LOCAL_TOOL_PROXY_FUNCTION_NAME;
      dispatches: ReadonlyArray<Readonly<{
        callId: string;
        request: LocalToolProxyDispatch;
        provenance: ProviderToolCallProvenance;
      }>>;
    })
  | (EventBase & {
      type: "tool.cancelled";
      responseId: string;
      callIds: string[];
    })
  | (EventBase & {
      type: "turn.interrupted";
      responseId: string;
      reason?: string;
    })
  | (EventBase & {
      type: "usage";
      responseId?: string;
      itemId?: string;
      turnId?: string;
      scope?: "response" | "input_transcription" | "session";
      usage: NormalizedRealtimeUsage;
    })
  | (EventBase & {
      type: "connection.go_away";
      /** Time remaining before the current socket is disconnected. */
      disconnectInMs?: number;
      reason?: string;
    })
  | (EventBase & {
      type: "error";
      message: string;
      code?: string;
      fatal: boolean;
      details?: Record<string, unknown>;
      transportDiagnostic?: RealtimeTransportFailureDiagnostic;
    })
  | (EventBase & {
      type: "connection.closed";
      code?: number;
      reason?: string;
      clean?: boolean;
      transportDiagnostic?: RealtimeTransportFailureDiagnostic;
    })
  | (EventBase & {
      /** Escape hatch for provider lifecycle events without weakening typed core events. */
      type: "provider.event";
      data: Record<string, unknown>;
    });

export type RealtimeEventListener = (event: NormalizedRealtimeEvent) => void;
export type RealtimeWireEventListener = (event: Record<string, unknown>) => void;

/**
 * Redacted, direction-tagged evidence for the exact order in which provider
 * wire messages cross the client boundary. Raw bearer, prompt, transcript,
 * argument, result, and audio content never appears in this observation.
 */
export type RealtimeWireObservation = Readonly<{
  schemaVersion: 1;
  provider: ServerRealtimeProvider;
  direction: "inbound" | "outbound";
  connectionEpoch: number;
  sequence: number;
  observedAtMs: number;
  observedAtMonotonicMs: number;
  wireType: string;
  payloadSha256: string;
  payloadBytes: number;
  /** Hash of the canonical redacted projection, suitable for artifact joins. */
  projectionSha256: string;
  /** Hash-chain predecessor; null only for the first observed frame. */
  previousObservationSha256: string | null;
  /** Domain-separated hash of this complete observation and its predecessor. */
  observationSha256: string;
  identities: Readonly<{
    eventIdSha256?: string;
    sessionIdSha256?: string;
    responseIdSha256?: string;
    itemIdSha256?: string;
    callIdSha256?: string;
  }>;
  projection: Readonly<Record<string, unknown>>;
}>;

export type RealtimeWireObservationListener = (event: RealtimeWireObservation) => void;

/** Minimal EventEmitter-style socket surface implemented by the `ws` package. */
export type RealtimeWebSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): unknown;
};

export type RealtimeWebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => RealtimeWebSocket;

export type RealtimeClientState =
  | "idle"
  | "connecting"
  | "ready"
  | "closing"
  | "closed"
  | "failed";

/**
 * Host-authored, provider-neutral control context for exactly the next model
 * response. Adapters must deliver it before that provider can begin generation.
 */
export type RealtimeResponsePreparation = Readonly<{
  additionalInstructions: string;
  contextSha256: string;
  /** Provider prompt context is advisory; host gateways remain authoritative. */
  contextAuthority: "advisory_only_gateway_and_speech_gate_enforced";
}>;

/**
 * xAI server-VAD needs the next turn's control plane installed before the first
 * audio byte can trigger speech detection. The provider still owns audio
 * commit and the initial response trigger; this packet only updates the exact
 * instructions/tool frontier for that one caller turn.
 */
export type RealtimeServerVadTurnPreparation = Readonly<{
  additionalInstructions: string;
  contextSha256: string;
  contextAuthority: "advisory_only_gateway_and_speech_gate_enforced";
  tools: readonly Readonly<Record<string, unknown>>[];
  toolFrontierSha256: string;
  transportParitySha256: string;
}>;

export type RealtimeServerVadTurnAcknowledgement = Readonly<{
  provider: "xai";
  connectionEpoch: number;
  turnOrdinal: number;
  status: "acknowledged";
  contextSha256: string;
  toolFrontierSha256: string;
  transportParitySha256: string;
  configuration: SessionConfigurationAcknowledgement;
  outboundObservation?: RealtimeWireObservationAttribution;
  inboundObservation?: RealtimeWireObservationAttribution;
}>;

export interface NormalizedRealtimeClient {
  readonly provider: ServerRealtimeProvider;
  readonly state: RealtimeClientState;
  connect(): Promise<void>;
  close(code?: number, reason?: string): void;
  onEvent(listener: RealtimeEventListener): () => void;
  onWireEvent(listener: RealtimeWireEventListener): () => void;
  /** Preferred evidence stream; legacy clients may expose only inbound raw events. */
  onWireObservation?(listener: RealtimeWireObservationListener): () => void;
  /** Last provider acknowledgement, detached and frozen; null before readiness. */
  readonly sessionConfigurationAcknowledgement?: SessionConfigurationAcknowledgement | null;
  /** Independently derived non-treatment transport hash for provider-native server-VAD sessions. */
  readonly serverVadTransportParitySha256?: string | null;
  appendInputAudio(audio: Pcm16Audio): void;
  /** Must precede commitInputAudio for providers where commit starts generation. */
  prepareResponse(preparation: RealtimeResponsePreparation): void;
  /**
   * Optional provider-native server-VAD barrier. It must resolve on the exact
   * `session.updated` acknowledgement before caller audio is appended.
   */
  prepareServerVadTurn?(
    preparation: RealtimeServerVadTurnPreparation,
    timeoutMs?: number,
  ): Promise<RealtimeServerVadTurnAcknowledgement>;
  commitInputAudio(): void;
  /**
   * Optional provider acknowledgement barrier. Call only after commitInputAudio;
   * clients that do not expose an acknowledgement leave this method absent.
   */
  waitForInputAudioCommit?(
    timeoutMs?: number,
  ): Promise<RealtimeInputAudioCommitAcknowledgement>;
  createResponse(overrides?: Record<string, unknown>): void;
  /** Optional because not every provider exposes response-targeted cancellation. */
  cancelResponse?(target: RealtimeResponseCancelTarget): void;
  /** Optional because not every provider can reconcile unheard assistant audio. */
  truncateOutputAudio?(target: RealtimeOutputAudioTruncation): void;
  sendTurn(audio: Pcm16Audio | readonly Pcm16Audio[]): void;
  /** Optional provider-native text turn used by explicitly zero-audio probes. */
  sendTextTurn?(text: string): void;
  submitToolResults(results: readonly RealtimeToolResult[], createResponse?: boolean): void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreezeContract<Value>(value: Value): Readonly<Value> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeContract(child);
  return Object.freeze(value);
}

/** Exact, key-order-independent equality for provider-visible JSON contracts. */
function jsonContractEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonContractEqual(value, right[index]));
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && jsonContractEqual(left[key], right[key])
    ));
}

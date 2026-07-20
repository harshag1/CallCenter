import type {
  ActiveCatalogAuthorityRef,
  RemoteMcpServer,
  ToolProxyRotation,
} from "../types";

export const REALTIME_PROVIDER_PLUGIN_CONTRACT_VERSION = "1.0" as const;
export const REALTIME_PROVIDER_NORMALIZED_EVENT_VERSION = 1 as const;

export type RealtimeProviderPluginContractVersion =
  typeof REALTIME_PROVIDER_PLUGIN_CONTRACT_VERSION;
export type RealtimeProviderPluginMaturity =
  | "experimental"
  | "preview"
  | "stable"
  | "deprecated";
export type RealtimeProviderExecutionMode = "browser" | "server";
export type RealtimeProviderTransportKind = "websocket" | "webrtc" | "webtransport";
export type RealtimeProviderMediaEncoding =
  | "pcm-s16le"
  | "pcmu"
  | "pcma"
  | "opus"
  | `vendor:${string}`;

export type RealtimeProviderAudioDirection = Readonly<{
  encoding: RealtimeProviderMediaEncoding;
  sampleRateHz: number;
  channels: 1 | 2;
}>;

/**
 * One exact, bidirectional media contract. Asymmetric profiles are intentional:
 * Gemini Live, for example, receives 16 kHz PCM and emits 24 kHz PCM.
 */
export type RealtimeProviderMediaProfile = Readonly<{
  id: string;
  input: RealtimeProviderAudioDirection;
  output: RealtimeProviderAudioDirection;
}>;

export type RealtimeProviderTransportDeclaration = Readonly<{
  kind: RealtimeProviderTransportKind;
  mediaProfileIds: readonly string[];
}>;

export type RealtimeProviderManifest = Readonly<{
  contractVersion: RealtimeProviderPluginContractVersion;
  id: string;
  label: string;
  docsUrl: string;
  defaultModel: string;
  defaultVoice: string;
  environment: readonly string[];
  lifecycle: Readonly<{
    maturity: RealtimeProviderPluginMaturity;
    since: string;
    replacementProviderId?: string;
  }>;
  transports: Readonly<{
    browser: readonly RealtimeProviderTransportDeclaration[];
    server: readonly RealtimeProviderTransportDeclaration[];
  }>;
  mediaProfiles: readonly RealtimeProviderMediaProfile[];
  telephony: Readonly<{
    support: "unsupported" | "native-media" | "transcoding-bridge";
    ingressMediaProfileIds: readonly string[];
    providerMediaProfileIds: readonly string[];
    notes: readonly string[];
  }>;
  tools: Readonly<{
    delivery: "local-gateway" | "provider-native" | "both";
    normalizedCalls: true;
    streamedArguments: boolean;
  }>;
  normalization: Readonly<{
    eventSchemaVersion: typeof REALTIME_PROVIDER_NORMALIZED_EVENT_VERSION;
    input: "wire-events" | "normalized-client-events";
    terminalResponseProvenance: boolean;
    toolCallBatching: "single" | "batch";
  }>;
  metering: Readonly<{
    usage: "provider-reported" | "client-measured" | "mixed" | "unavailable";
    rawUsageRetained: boolean;
    evidence:
      | "none"
      | "wire-observations"
      | "provider-receipts"
      | "wire-and-provider-receipts";
  }>;
}>;

export type RealtimeProviderPluginSessionSpec = Readonly<{
  providerId: string;
  model: string;
  voice: string;
  instructions: string;
  settings: Readonly<Record<string, unknown>>;
  mcpServers: readonly RemoteMcpServer[];
  toolAuthority: Readonly<{
    proxyUrl: string;
    proxyToken: string;
    rotation?: ToolProxyRotation;
    activeCatalog: ActiveCatalogAuthorityRef;
  }>;
}>;

export type RealtimeProviderSessionValidationIssue = Readonly<{
  path: string;
  code: string;
  message: string;
}>;

export type RealtimeProviderSessionValidation =
  | Readonly<{
      ok: true;
      session: RealtimeProviderPluginSessionSpec;
    }>
  | Readonly<{
      ok: false;
      issues: readonly RealtimeProviderSessionValidationIssue[];
    }>;

export type RealtimeProviderToolCall = Readonly<{
  callId: string;
  responseId: string;
  name: string;
  argumentsText: string;
  argumentsJson: unknown | null;
  terminalWireType: string;
  terminalEventId?: string;
}>;

export type RealtimeProviderToolResult = Readonly<{
  callId: string;
  output: unknown;
}>;

/**
 * The plugin boundary deliberately keeps provider-native frames out of core
 * flow logic. `data` is an escape hatch for typed core events while tool calls
 * remain first-class so capability dispatch can be conformance-tested.
 */
export type RealtimeProviderNormalizedEvent = Readonly<{
  schemaVersion: typeof REALTIME_PROVIDER_NORMALIZED_EVENT_VERSION;
  providerId: string;
  type: string;
  receivedAtMs: number;
  wireType: string;
  responseId?: string;
  toolCalls?: readonly RealtimeProviderToolCall[];
  data: Readonly<Record<string, unknown>>;
}>;

export type RealtimeProviderEventNormalizer = Readonly<{
  push(event: unknown): readonly RealtimeProviderNormalizedEvent[];
  reset?(): void;
}>;

export type RealtimeProviderConnection = Readonly<{
  providerId: string;
  mode: RealtimeProviderExecutionMode;
  transport: RealtimeProviderTransportKind;
  mediaProfileId: string;
  /** Adapter-owned handle. The registry never serializes or introspects it. */
  handle: unknown;
}>;

export type RealtimeProviderCredentialReader = (environmentName: string) => Promise<string>;

export type RealtimeProviderFactoryContext = Readonly<{
  /**
   * The registry-provided credential path. Cooperative plugins use this reader,
   * which restricts access to names declared in the immutable manifest.
   * In-process JavaScript remains trusted code; use process isolation for
   * untrusted plugins.
   */
  readCredential: RealtimeProviderCredentialReader;
  fetch: typeof fetch;
  now: () => number;
}>;

export type RealtimeProviderConnectionRequest = Readonly<{
  session: RealtimeProviderPluginSessionSpec;
  transport: RealtimeProviderTransportKind;
  mediaProfileId: string;
}>;

export type RealtimeProviderConnectionFactory = Readonly<{
  create(
    request: RealtimeProviderConnectionRequest,
    context: RealtimeProviderFactoryContext,
  ): Promise<RealtimeProviderConnection>;
}>;

export type RealtimeProviderPlugin = Readonly<{
  manifest: RealtimeProviderManifest;
  validateSession(
    session: RealtimeProviderPluginSessionSpec,
  ): RealtimeProviderSessionValidation;
  browser?: RealtimeProviderConnectionFactory;
  server?: RealtimeProviderConnectionFactory;
  createEventNormalizer(mediaProfileId: string): RealtimeProviderEventNormalizer;
  encodeToolResults(results: readonly RealtimeProviderToolResult[]): unknown;
}>;

export type RealtimeProviderRegistryCreateOptions = Readonly<{
  readCredential?: RealtimeProviderCredentialReader;
  fetch?: typeof fetch;
  now?: () => number;
}>;

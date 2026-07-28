export type VoiceProviderId = "xai" | "openai" | "gemini";
export type RealtimeAudioFormat = "pcm" | "pcmu";

export type RemoteMcpServer = {
  label: string;
  serverUrl: string;
  allowedTools?: string[];
  authorization?: string;
};

export type VoiceProviderConfig = {
  provider: VoiceProviderId;
  model: string;
  voice: string;
  settings: Record<string, unknown>;
};

/** Public, token-free pointer to the server-authored catalog shown to the model. */
export type ActiveCatalogAuthorityRef = Readonly<{
  catalogDigest: string;
  capabilityEpoch: number;
  runtimeDigest: string;
  stateRevision: number;
}>;

/** Browser-only renewal authority; never serialized into a provider session. */
export type ToolProxyRotation = Readonly<{
  endpoint: "/api/voice/capabilities/rotate";
  callId: string;
  rotation: number;
  renewalToken: string;
  refreshAfter: string;
  expiresAt: string;
}>;

export type ExperimentalProviderNativeResumption = Readonly<{
  enabled: true;
  phase: "exploratory";
  provider: VoiceProviderId;
  planSha256: string;
}>;

export type VoiceSessionSpec = VoiceProviderConfig & {
  instructions: string;
  mcpServers: RemoteMcpServer[];
  /** Browser-side providers without remote MCP call this scoped proxy for tool list/call. */
  toolProxyUrl: string;
  toolProxyToken: string;
  toolProxyRotation?: ToolProxyRotation;
  activeCatalogAuthority: ActiveCatalogAuthorityRef;
  /** Server-authored from a verified exploratory plan; never hydrate this from provider settings. */
  experimentalProviderNativeResumption?: ExperimentalProviderNativeResumption;
};

type ConnectionBase = {
  provider: VoiceProviderId;
  model: string;
  voice: string;
};

export type XaiBrowserConnection = ConnectionBase & {
  provider: "xai";
  transport: "websocket";
  wsUrl: string;
  token: string;
  protocols: string[];
  sessionUpdate: Record<string, unknown>;
  /** Same-origin local authority; never serialized into the provider session. */
  toolProxyUrl: string;
  toolProxyToken: string;
  toolProxyRotation: ToolProxyRotation;
  activeCatalogAuthority: ActiveCatalogAuthorityRef;
};

export type OpenAIBrowserConnection = ConnectionBase & {
  provider: "openai";
  transport: "webrtc";
  endpoint: string;
  token: string;
  /** Same-origin local authority; never serialized into the provider session. */
  toolProxyUrl: string;
  toolProxyToken: string;
  toolProxyRotation: ToolProxyRotation;
  activeCatalogAuthority: ActiveCatalogAuthorityRef;
};

export type GeminiBrowserConnection = ConnectionBase & {
  provider: "gemini";
  transport: "websocket";
  wsUrl: string;
  token: string;
  setup: Record<string, unknown>;
  toolProxyUrl: string;
  toolProxyToken: string;
  toolProxyRotation: ToolProxyRotation;
  activeCatalogAuthority: ActiveCatalogAuthorityRef;
};

export type BrowserRealtimeConnection =
  | XaiBrowserConnection
  | OpenAIBrowserConnection
  | GeminiBrowserConnection;

export type ServerRealtimeConnection = ConnectionBase & {
  wsUrl: string;
  headers: Record<string, string>;
  sessionUpdate: Record<string, unknown>;
  wireProtocol: "openai-realtime";
};

export type ProviderCapabilities = {
  browser: "websocket" | "webrtc";
  telephony: "native-pcmu" | "requires-transcoding";
  remoteMcp: boolean;
  clientFunctions: boolean;
  sessionResumption: Readonly<{
    supported: boolean;
    enabledByDefault: boolean;
  }>;
  notes: readonly string[];
};

export type ProviderDefinition = {
  id: VoiceProviderId;
  label: string;
  defaultModel: string;
  defaultVoice: string;
  env: string[];
  capabilities: ProviderCapabilities;
};

export type RealtimeProviderAdapter = ProviderDefinition & {
  createBrowserConnection(spec: VoiceSessionSpec): Promise<BrowserRealtimeConnection>;
  createServerConnection(spec: VoiceSessionSpec, audio: RealtimeAudioFormat): Promise<ServerRealtimeConnection>;
  buildSessionUpdate(spec: VoiceSessionSpec, audio: RealtimeAudioFormat): Record<string, unknown>;
};

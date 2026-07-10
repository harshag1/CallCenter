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

export type VoiceSessionSpec = VoiceProviderConfig & {
  instructions: string;
  mcpServers: RemoteMcpServer[];
  /** Browser-side providers without remote MCP call this scoped proxy for tool list/call. */
  toolProxyUrl: string;
  toolProxyToken: string;
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
};

export type OpenAIBrowserConnection = ConnectionBase & {
  provider: "openai";
  transport: "webrtc";
  endpoint: string;
  token: string;
};

export type GeminiBrowserConnection = ConnectionBase & {
  provider: "gemini";
  transport: "websocket";
  wsUrl: string;
  token: string;
  setup: Record<string, unknown>;
  toolProxyUrl: string;
  toolProxyToken: string;
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
  sessionResumption: boolean;
  notes: string[];
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

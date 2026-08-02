/** Explicit provider adapter boundary. Definitions do not discover providers, read env, or connect. */

export const HACC_REALTIME_PROVIDER_CONTRACT_VERSION = "0.1" as const;

export type AudioFormat = Readonly<{
  encoding: "pcm-s16le" | "pcmu" | "pcma" | "opus" | `vendor:${string}`;
  sampleRateHz: number;
  channels: 1 | 2;
}>;

export type RealtimeTransport = "websocket" | "webrtc" | "webtransport";

export type ProviderCapability =
  | "audio-input"
  | "audio-output"
  | "text-input"
  | "tool-calls"
  | "interrupt"
  | "session-resumption"
  | "usage";

export type ProviderManifest<Id extends string = string> = Readonly<{
  contractVersion: typeof HACC_REALTIME_PROVIDER_CONTRACT_VERSION;
  id: Id;
  label: string;
  docsUrl: string;
  transports: readonly RealtimeTransport[];
  inputAudio: AudioFormat;
  outputAudio: AudioFormat;
  capabilities: readonly ProviderCapability[];
}>;

export type RealtimeSessionRequest<Options = Readonly<Record<string, unknown>>> = Readonly<{
  model: string;
  voice: string;
  instructions: string;
  tools: readonly Readonly<{ name: string; description: string; inputSchema?: unknown }>[];
  options: Options;
}>;

export type NormalizedRealtimeEvent =
  | Readonly<{ type: "session.ready"; providerSessionId: string; model: string; voice: string }>
  | Readonly<{ type: "audio.delta"; audio: Uint8Array; responseId: string }>
  | Readonly<{ type: "transcript.delta"; text: string; responseId: string }>
  | Readonly<{ type: "response.done"; responseId: string }>
  | Readonly<{ type: "tool.call"; callId: string; responseId: string; name: string; arguments: unknown }>
  | Readonly<{ type: "interrupted"; responseId?: string }>
  | Readonly<{ type: "usage"; inputTokens?: number; outputTokens?: number; audioSeconds?: number }>
  | Readonly<{ type: "error"; code: string; message: string; retryable: boolean }>;

export type ToolResult = Readonly<{
  callId: string;
  output: unknown;
  isError?: boolean;
}>;

export type RealtimeProviderSession = Readonly<{
  events(): AsyncIterable<NormalizedRealtimeEvent>;
  sendAudio(audio: Uint8Array): Promise<void>;
  sendText(text: string): Promise<void>;
  submitToolResult(result: ToolResult): Promise<void>;
  interrupt(): Promise<void>;
  close(reason?: string): Promise<void>;
}>;

/** Adapter-specific context is supplied explicitly by the host; the SDK never reads process.env. */
export type RealtimeProviderDefinition<
  Id extends string = string,
  Options = Readonly<Record<string, unknown>>,
  Context = unknown,
> = Readonly<{
  manifest: ProviderManifest<Id>;
  connect(request: RealtimeSessionRequest<Options>, context: Context): Promise<RealtimeProviderSession>;
}>;

export class HaccProviderDefinitionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HaccProviderDefinitionError";
  }
}

const ID = /^[a-z][a-z0-9-]{0,63}$/;

function validateAudio(format: AudioFormat, label: string): AudioFormat {
  if (
    !format
    || !Number.isInteger(format.sampleRateHz)
    || format.sampleRateHz < 8_000
    || format.sampleRateHz > 192_000
    || (format.channels !== 1 && format.channels !== 2)
  ) {
    throw new HaccProviderDefinitionError("invalid_audio", `${label} is invalid`);
  }
  return Object.freeze({ ...format });
}

/** Validates and snapshots metadata only. It never invokes connect or touches adapter context. */
export function defineRealtimeProvider<
  const Id extends string,
  Options = Readonly<Record<string, unknown>>,
  Context = unknown,
>(
  definition: RealtimeProviderDefinition<Id, Options, Context>,
): RealtimeProviderDefinition<Id, Options, Context> {
  const { manifest } = definition;
  if (manifest?.contractVersion !== HACC_REALTIME_PROVIDER_CONTRACT_VERSION) {
    throw new HaccProviderDefinitionError(
      "unsupported_contract",
      `provider contract ${String(manifest?.contractVersion)} is unsupported`,
    );
  }
  if (!manifest || !ID.test(manifest.id)) {
    throw new HaccProviderDefinitionError("invalid_id", "provider id is invalid");
  }
  if (!manifest.label.trim()) {
    throw new HaccProviderDefinitionError("invalid_label", "provider label is required");
  }
  let docs: URL;
  try {
    docs = new URL(manifest.docsUrl);
  } catch {
    throw new HaccProviderDefinitionError("invalid_docs_url", "provider docsUrl is invalid");
  }
  if (docs.protocol !== "https:" || docs.username || docs.password) {
    throw new HaccProviderDefinitionError("invalid_docs_url", "provider docsUrl must be public HTTPS");
  }
  if (typeof definition.connect !== "function") {
    throw new HaccProviderDefinitionError("invalid_connect", "provider connect must be a function");
  }
  const transports = [...manifest.transports];
  const capabilities = [...manifest.capabilities];
  if (!transports.length || new Set(transports).size !== transports.length) {
    throw new HaccProviderDefinitionError("invalid_transports", "provider transports must be non-empty and unique");
  }
  if (new Set(capabilities).size !== capabilities.length) {
    throw new HaccProviderDefinitionError("invalid_capabilities", "provider capabilities must be unique");
  }
  return Object.freeze({
    manifest: Object.freeze({
      contractVersion: HACC_REALTIME_PROVIDER_CONTRACT_VERSION,
      id: manifest.id,
      label: manifest.label,
      docsUrl: docs.toString(),
      transports: Object.freeze(transports),
      inputAudio: validateAudio(manifest.inputAudio, "inputAudio"),
      outputAudio: validateAudio(manifest.outputAudio, "outputAudio"),
      capabilities: Object.freeze(capabilities),
    }),
    connect: definition.connect,
  });
}

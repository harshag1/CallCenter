import "server-only";

import { geminiAdapter } from "./providers/gemini";
import { openaiAdapter } from "./providers/openai";
import { xaiAdapter } from "./providers/xai";
import type {
  BrowserRealtimeConnection,
  ProviderDefinition,
  RealtimeAudioFormat,
  RealtimeProviderAdapter,
  ServerRealtimeConnection,
  VoiceProviderId,
  VoiceSessionSpec,
} from "./types";

const ADAPTERS: Record<VoiceProviderId, RealtimeProviderAdapter> = {
  xai: xaiAdapter,
  openai: openaiAdapter,
  gemini: geminiAdapter,
};

export function realtimeProvider(id: VoiceProviderId): RealtimeProviderAdapter {
  return ADAPTERS[id];
}

export function providerCatalog(): ProviderDefinition[] {
  return Object.values(ADAPTERS).map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    defaultModel: adapter.defaultModel,
    defaultVoice: adapter.defaultVoice,
    env: adapter.env,
    capabilities: adapter.capabilities,
  }));
}

export function createBrowserRealtimeConnection(spec: VoiceSessionSpec): Promise<BrowserRealtimeConnection> {
  return realtimeProvider(spec.provider).createBrowserConnection(spec);
}

export function createServerRealtimeConnection(
  spec: VoiceSessionSpec,
  audio: RealtimeAudioFormat
): Promise<ServerRealtimeConnection> {
  return realtimeProvider(spec.provider).createServerConnection(spec, audio);
}

export function buildProviderSessionUpdate(spec: VoiceSessionSpec, audio: RealtimeAudioFormat): Record<string, unknown> {
  return realtimeProvider(spec.provider).buildSessionUpdate(spec, audio);
}

/** Public connection metadata for a separately deployed bridge; provider keys stay on that bridge. */
export function serverRealtimeEndpoint(spec: VoiceSessionSpec): { provider: "xai" | "openai"; wsUrl: string } {
  if (spec.provider === "gemini") {
    throw new Error("Gemini telephony requires a transcoding bridge; direct Twilio μ-law passthrough is unavailable");
  }
  return {
    provider: spec.provider,
    wsUrl: spec.provider === "xai"
      ? `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(spec.model)}`
      : `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(spec.model)}`,
  };
}

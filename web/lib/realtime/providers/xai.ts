import "server-only";

import type {
  BrowserRealtimeConnection,
  RealtimeProviderAdapter,
  ServerRealtimeConnection,
} from "../types";
import { browserProviderSessionSpec } from "./browser-direct-mcp";
import {
  buildXaiBrowserProtocols,
  buildXaiClientSecretPayload,
  buildXaiSessionUpdate,
} from "./xai-protocol";

const API = "https://api.x.ai/v1";

function apiKey() {
  if (!process.env.XAI_API_KEY) throw new Error("XAI_API_KEY is required for the xAI voice provider");
  return process.env.XAI_API_KEY;
}

async function mintToken(): Promise<string> {
  const response = await fetch(`${API}/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildXaiClientSecretPayload()),
  });
  if (!response.ok) throw new Error(`xAI realtime token ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const json = await response.json() as { value?: string; client_secret?: { value?: string }; token?: string };
  const token = json.value ?? json.client_secret?.value ?? json.token;
  if (!token) throw new Error("xAI realtime token response did not contain a client secret");
  return token;
}

export const xaiAdapter: RealtimeProviderAdapter = {
  id: "xai",
  label: "xAI Voice Agent API",
  defaultModel: "grok-voice-think-fast-1.0",
  defaultVoice: "ara",
  env: ["XAI_API_KEY"],
  capabilities: {
    browser: "websocket",
    telephony: "native-pcmu",
    remoteMcp: true,
    clientFunctions: true,
    sessionResumption: { supported: true, enabledByDefault: false },
    notes: [
      "OpenAI-Realtime-compatible wire protocol",
      "Version-pinned by default; mutable aliases require an explicit voice_model override",
    ],
  },
  buildSessionUpdate: buildXaiSessionUpdate,
  async createBrowserConnection(spec): Promise<BrowserRealtimeConnection> {
    if (!spec.toolProxyRotation) throw new Error("browser tool capability rotation is required");
    const providerSpec = browserProviderSessionSpec(spec);
    const token = await mintToken();
    return {
      provider: "xai",
      transport: "websocket",
      model: spec.model,
      voice: spec.voice,
      token,
      wsUrl: `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(spec.model)}`,
      // xAI authenticates browser sockets through this single subprotocol.
      // `realtime` is not part of the documented ephemeral-token handshake.
      protocols: buildXaiBrowserProtocols(token),
      sessionUpdate: buildXaiSessionUpdate(providerSpec, "pcm"),
      toolProxyUrl: spec.toolProxyUrl,
      toolProxyToken: spec.toolProxyToken,
      toolProxyRotation: spec.toolProxyRotation,
      activeCatalogAuthority: spec.activeCatalogAuthority,
    };
  },
  async createServerConnection(spec, audio): Promise<ServerRealtimeConnection> {
    return {
      provider: "xai",
      model: spec.model,
      voice: spec.voice,
      wsUrl: `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(spec.model)}`,
      headers: { Authorization: `Bearer ${apiKey()}` },
      sessionUpdate: buildXaiSessionUpdate(spec, audio),
      wireProtocol: "openai-realtime",
    };
  },
};

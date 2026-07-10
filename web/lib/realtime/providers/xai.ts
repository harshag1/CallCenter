import "server-only";

import type {
  BrowserRealtimeConnection,
  RealtimeProviderAdapter,
  ServerRealtimeConnection,
} from "../types";
import { buildXaiSessionUpdate } from "./xai-protocol";

const API = "https://api.x.ai/v1";

function apiKey() {
  if (!process.env.XAI_API_KEY) throw new Error("XAI_API_KEY is required for the xAI voice provider");
  return process.env.XAI_API_KEY;
}

async function mintToken(): Promise<string> {
  const response = await fetch(`${API}/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 600 } }),
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
  defaultModel: "grok-voice-latest",
  defaultVoice: "ara",
  env: ["XAI_API_KEY"],
  capabilities: {
    browser: "websocket",
    telephony: "native-pcmu",
    remoteMcp: true,
    clientFunctions: true,
    sessionResumption: true,
    notes: ["OpenAI-Realtime-compatible wire protocol", "Pin grok-voice-think-fast-1.0 for release stability"],
  },
  buildSessionUpdate: buildXaiSessionUpdate,
  async createBrowserConnection(spec): Promise<BrowserRealtimeConnection> {
    const token = await mintToken();
    return {
      provider: "xai",
      transport: "websocket",
      model: spec.model,
      voice: spec.voice,
      token,
      wsUrl: `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(spec.model)}`,
      protocols: ["realtime", `xai-client-secret.${token}`],
      sessionUpdate: buildXaiSessionUpdate(spec, "pcm"),
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

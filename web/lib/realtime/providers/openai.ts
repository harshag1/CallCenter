import "server-only";

import type {
  BrowserRealtimeConnection,
  RealtimeAudioFormat,
  RealtimeProviderAdapter,
  ServerRealtimeConnection,
  VoiceSessionSpec,
} from "../types";
import { buildOpenAIClientSecretPayload, buildOpenAISession } from "./openai-protocol";

const API = "https://api.openai.com/v1";

function apiKey() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for the OpenAI voice provider");
  return process.env.OPENAI_API_KEY;
}

export function buildOpenAISessionUpdate(spec: VoiceSessionSpec, audio: RealtimeAudioFormat): Record<string, unknown> {
  return { type: "session.update", session: buildOpenAISession(spec, audio) };
}

async function mintToken(spec: VoiceSessionSpec): Promise<string> {
  const response = await fetch(`${API}/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildOpenAIClientSecretPayload(buildOpenAISession(spec, "pcm"))),
  });
  if (!response.ok) throw new Error(`OpenAI realtime token ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const json = await response.json() as { client_secret?: { value?: string }; value?: string };
  const token = json.client_secret?.value ?? json.value;
  if (!token) throw new Error("OpenAI realtime token response did not contain a client secret");
  return token;
}

export const openaiAdapter: RealtimeProviderAdapter = {
  id: "openai",
  label: "OpenAI Realtime API",
  defaultModel: "gpt-realtime-2.1",
  defaultVoice: "marin",
  env: ["OPENAI_API_KEY"],
  capabilities: {
    browser: "webrtc",
    telephony: "native-pcmu",
    remoteMcp: true,
    clientFunctions: true,
    sessionResumption: false,
    notes: ["GPT-Live is not yet available in the API", "WebRTC is preferred for browser media"],
  },
  buildSessionUpdate: buildOpenAISessionUpdate,
  async createBrowserConnection(spec): Promise<BrowserRealtimeConnection> {
    return {
      provider: "openai",
      transport: "webrtc",
      model: spec.model,
      voice: spec.voice,
      token: await mintToken(spec),
      endpoint: `${API}/realtime/calls`,
    };
  },
  async createServerConnection(spec, audio): Promise<ServerRealtimeConnection> {
    return {
      provider: "openai",
      model: spec.model,
      voice: spec.voice,
      wsUrl: `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(spec.model)}`,
      headers: { Authorization: `Bearer ${apiKey()}` },
      sessionUpdate: buildOpenAISessionUpdate(spec, audio),
      wireProtocol: "openai-realtime",
    };
  },
};

import "server-only";

import type {
  BrowserRealtimeConnection,
  RealtimeAudioFormat,
  RealtimeProviderAdapter,
  ServerRealtimeConnection,
  VoiceSessionSpec,
} from "../types";

const API = "https://api.openai.com/v1";

function apiKey() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for the OpenAI voice provider");
  return process.env.OPENAI_API_KEY;
}

function session(spec: VoiceSessionSpec, audio: RealtimeAudioFormat) {
  return {
    type: "realtime",
    model: spec.model,
    instructions: spec.instructions,
    audio: {
      input: {
        format: audio === "pcmu" ? { type: "audio/pcmu" } : { type: "audio/pcm", rate: 24000 },
        transcription: { model: "gpt-realtime-whisper" },
        turn_detection: { type: "server_vad" },
      },
      output: {
        format: audio === "pcmu" ? { type: "audio/pcmu" } : { type: "audio/pcm", rate: 24000 },
        voice: spec.voice,
      },
    },
    tools: spec.mcpServers.map((server) => ({
      type: "mcp",
      server_label: server.label,
      server_url: server.serverUrl,
      ...(server.allowedTools?.length ? { allowed_tools: server.allowedTools } : {}),
      ...(server.authorization ? { authorization: server.authorization } : {}),
    })),
    tool_choice: "auto",
    ...spec.settings,
  };
}

export function buildOpenAISessionUpdate(spec: VoiceSessionSpec, audio: RealtimeAudioFormat): Record<string, unknown> {
  return { type: "session.update", session: session(spec, audio) };
}

async function mintToken(spec: VoiceSessionSpec): Promise<string> {
  const response = await fetch(`${API}/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(session(spec, "pcm")),
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

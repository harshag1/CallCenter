import "server-only";

import type {
  BrowserRealtimeConnection,
  RealtimeProviderAdapter,
  VoiceSessionSpec,
} from "../types";

function apiKey() {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required for the Gemini Live provider");
  return process.env.GEMINI_API_KEY;
}

function setup(spec: VoiceSessionSpec): Record<string, unknown> {
  return {
    setup: {
      model: `models/${spec.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: spec.voice } } },
        ...spec.settings,
      },
      systemInstruction: { parts: [{ text: spec.instructions }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: {},
      // Function declarations are fetched from toolProxyUrl by the browser and inserted before setup is sent.
      tools: [],
    },
  };
}

async function mintToken(): Promise<string> {
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey: apiKey(), httpOptions: { apiVersion: "v1alpha" } });
  const token = await client.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(),
      httpOptions: { apiVersion: "v1alpha" },
    },
  });
  if (!token.name) throw new Error("Gemini ephemeral token response did not contain a token name");
  return token.name;
}

export const geminiAdapter: RealtimeProviderAdapter = {
  id: "gemini",
  label: "Gemini Live API",
  defaultModel: "gemini-3.1-flash-live-preview",
  defaultVoice: "Kore",
  env: ["GEMINI_API_KEY"],
  capabilities: {
    browser: "websocket",
    telephony: "requires-transcoding",
    remoteMcp: false,
    clientFunctions: true,
    sessionResumption: true,
    notes: ["Live API and ephemeral tokens are preview", "Audio input PCM16; audio output 24kHz PCM16"],
  },
  buildSessionUpdate: setup,
  async createBrowserConnection(spec): Promise<BrowserRealtimeConnection> {
    const token = await mintToken();
    return {
      provider: "gemini",
      transport: "websocket",
      model: spec.model,
      voice: spec.voice,
      token,
      wsUrl: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`,
      setup: setup(spec),
      toolProxyUrl: spec.toolProxyUrl,
      toolProxyToken: spec.toolProxyToken,
    };
  },
  async createServerConnection(): Promise<never> {
    throw new Error("Gemini telephony needs μ-law↔PCM transcoding; use browser calls or add a transcoding bridge adapter");
  },
};

import "server-only";

import type {
  BrowserProviderFundingAuthority,
  BrowserRealtimeConnection,
  RealtimeProviderAdapter,
  VoiceSessionSpec,
} from "../types";
import { browserProviderRootFromFundingAuthority } from "../browser-funding-authority";
import { buildGeminiSetup } from "./gemini-protocol";

async function mintToken(
  fundingAuthority: BrowserProviderFundingAuthority<"gemini">,
): Promise<string> {
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({
    apiKey: browserProviderRootFromFundingAuthority(
      fundingAuthority,
      "gemini",
      "GEMINI_API_KEY",
    ),
    httpOptions: { apiVersion: "v1alpha" },
  });
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

export const geminiAdapter = {
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
    sessionResumption: { supported: true, enabledByDefault: false },
    notes: [
      "Live API and ephemeral tokens are preview",
      "Audio input is PCM16 LE at 16kHz; output is PCM16 LE at 24kHz",
      "Audio-only sessions are capped at 15 minutes",
      "Gemini 3.1 function calls are sequential; NON_BLOCKING is unsupported",
      "Provider-native resumption is experimental, plan-pinned, and disabled by default",
      "Provider input/output transcription is disabled; use an independently metered played-PCM ASR pipeline",
    ],
  },
  buildSessionUpdate: buildGeminiSetup,
  async createBrowserConnection(
    spec: VoiceSessionSpec & { provider: "gemini" },
    fundingAuthority: BrowserProviderFundingAuthority<"gemini">,
  ): Promise<BrowserRealtimeConnection> {
    if (!spec.toolProxyRotation) throw new Error("browser tool capability rotation is required");
    const token = await mintToken(fundingAuthority);
    return {
      provider: "gemini",
      transport: "websocket",
      model: spec.model,
      voice: spec.voice,
      token,
      wsUrl: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`,
      setup: buildGeminiSetup(spec),
      toolProxyUrl: spec.toolProxyUrl,
      toolProxyToken: spec.toolProxyToken,
      toolProxyRotation: spec.toolProxyRotation,
      activeCatalogAuthority: spec.activeCatalogAuthority,
    };
  },
  async createServerConnection(): Promise<never> {
    throw new Error("Gemini telephony needs μ-law↔PCM transcoding; use browser calls or add a transcoding bridge adapter");
  },
} satisfies RealtimeProviderAdapter;

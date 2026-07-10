import type { VoiceProviderConfig, VoiceProviderId } from "./types";

export const PROVIDER_DEFAULTS = {
  xai: { model: "grok-voice-latest", voice: "ara" },
  openai: { model: "gpt-realtime-2.1", voice: "marin" },
  gemini: { model: "gemini-3.1-flash-live-preview", voice: "Kore" },
} as const;

const XAI_VOICES = new Set(["eve", "ara", "rex", "sal", "leo"]);
const OPENAI_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
const RESERVED_SETTINGS = new Set(["voice_provider", "voice_model", "provider_settings"]);

export function isVoiceProvider(value: unknown): value is VoiceProviderId {
  return value === "xai" || value === "openai" || value === "gemini";
}
function providerVoice(provider: VoiceProviderId, configured: string | undefined): string {
  if (!configured) return PROVIDER_DEFAULTS[provider].voice;
  if (provider === "xai") return XAI_VOICES.has(configured) ? configured : PROVIDER_DEFAULTS.xai.voice;
  if (provider === "openai") return OPENAI_VOICES.has(configured) ? configured : PROVIDER_DEFAULTS.openai.voice;
  // Gemini supports a broad, evolving prebuilt voice catalog. Preserve explicit names.
  return XAI_VOICES.has(configured) ? PROVIDER_DEFAULTS.gemini.voice : configured;
}

export function resolveVoiceProviderConfig(
  settings: Record<string, unknown> | null | undefined,
  configuredVoice?: string
): VoiceProviderConfig {
  const raw = settings ?? {};
  const provider = isVoiceProvider(raw.voice_provider) ? raw.voice_provider : "xai";
  const legacySettings = Object.fromEntries(Object.entries(raw).filter(([key]) => !RESERVED_SETTINGS.has(key)));
  const explicit = raw.provider_settings && typeof raw.provider_settings === "object"
    ? raw.provider_settings as Record<string, unknown>
    : {};
  return {
    provider,
    model: typeof raw.voice_model === "string" && raw.voice_model ? raw.voice_model : PROVIDER_DEFAULTS[provider].model,
    voice: providerVoice(provider, configuredVoice),
    settings: { ...legacySettings, ...explicit },
  };
}

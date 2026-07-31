import type { VoiceProviderConfig, VoiceProviderId } from "./types";

export const PROVIDER_DEFAULTS = {
  // Pin the default so ordinary calls and generated artifacts remain
  // reproducible. Mutable aliases are available only as an explicit override.
  xai: { model: "grok-voice-think-fast-1.0", voice: "ara" },
  openai: { model: "gpt-realtime-2.1", voice: "marin" },
  gemini: { model: "gemini-3.1-flash-live-preview", voice: "Kore" },
} as const;

const XAI_VOICES = new Set(["eve", "ara", "rex", "sal", "leo"]);
const OPENAI_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
const RESERVED_SETTINGS = new Set([
  "voice_provider",
  "voice_model",
  "provider_settings",
  // Host-owned enforcement policy. It must never be serialized into a
  // provider session or treated as an advanced provider setting.
  "speech_guardrail",
]);

export function isVoiceProvider(value: unknown): value is VoiceProviderId {
  return value === "xai" || value === "openai" || value === "gemini";
}
function providerVoice(provider: VoiceProviderId, configured: string | undefined): string {
  const voice = configured?.trim();
  if (!voice) return PROVIDER_DEFAULTS[provider].voice;
  // xAI's built-in roster evolves and its Voice Agent API also accepts custom
  // voice IDs. Preserve an explicit value so the provider can acknowledge the
  // exact requested identity instead of silently substituting a local default.
  if (provider === "xai") return voice;
  if (provider === "openai") {
    return OPENAI_VOICES.has(voice) || /^voice_[A-Za-z0-9_-]+$/.test(voice)
      ? voice
      : PROVIDER_DEFAULTS.openai.voice;
  }
  // Gemini supports a broad, evolving prebuilt voice catalog. Preserve explicit names.
  return XAI_VOICES.has(voice) ? PROVIDER_DEFAULTS.gemini.voice : voice;
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

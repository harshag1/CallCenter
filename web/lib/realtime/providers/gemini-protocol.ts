import type { VoiceSessionSpec } from "../types";
import {
  assertGeminiProviderTranscriptionDisabled,
  GEMINI_PROVIDER_TRANSCRIPTION_SETUP_KEYS,
} from "../gemini-policy";
import { providerTuning, settingsRecord } from "./settings";

const EXPERIMENTAL_RESUMPTION_KEY = "experimental_provider_native_resumption";
const SHA256_HEX = /^[a-f0-9]{64}$/;

function providerNativeResumptionEnabled(spec: VoiceSessionSpec): boolean {
  if (spec.settings[EXPERIMENTAL_RESUMPTION_KEY] !== undefined) {
    throw new Error("Gemini native resumption must come from a server-authored exploratory plan, not provider settings");
  }
  const raw: unknown = spec.experimentalProviderNativeResumption;
  if (raw === undefined) return false;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Gemini native resumption requires an exact exploratory, plan-pinned opt-in");
  }

  const gate = raw as Record<string, unknown>;
  const keys = Object.keys(gate).sort();
  const exactKeys = ["enabled", "phase", "planSha256", "provider"];
  if (
    keys.length !== exactKeys.length
    || keys.some((key, index) => key !== exactKeys[index])
    || gate.enabled !== true
    || gate.phase !== "exploratory"
    || gate.provider !== "gemini"
    || typeof gate.planSha256 !== "string"
    || !SHA256_HEX.test(gate.planSha256)
  ) {
    throw new Error("Gemini native resumption requires an exact exploratory, plan-pinned opt-in");
  }
  return true;
}

export function buildGeminiSetup(spec: VoiceSessionSpec): Record<string, unknown> {
  assertGeminiProviderTranscriptionDisabled(spec.settings);
  const { generationConfig: configuredGeneration, ...configuredSetup } = spec.settings;
  const generation = settingsRecord(configuredGeneration);
  const speech = settingsRecord(generation.speechConfig);
  const voice = settingsRecord(speech.voiceConfig);
  const resumptionEnabled = providerNativeResumptionEnabled(spec);
  const tuning = providerTuning(configuredSetup, [
    "model",
    "systemInstruction",
    "tools",
    "sessionResumption",
    ...GEMINI_PROVIDER_TRANSCRIPTION_SETUP_KEYS,
    EXPERIMENTAL_RESUMPTION_KEY,
  ]);
  return {
    setup: {
      model: `models/${spec.model}`,
      generationConfig: {
        ...generation,
        responseModalities: ["AUDIO"],
        speechConfig: {
          ...speech,
          voiceConfig: {
            ...voice,
            prebuiltVoiceConfig: { voiceName: spec.voice },
          },
        },
      },
      systemInstruction: { parts: [{ text: spec.instructions }] },
      ...(resumptionEnabled ? { sessionResumption: {} } : {}),
      contextWindowCompression: { slidingWindow: {} },
      ...tuning,
      // Function declarations are fetched from toolProxyUrl by the browser and inserted before setup is sent.
      tools: [],
    },
  };
}

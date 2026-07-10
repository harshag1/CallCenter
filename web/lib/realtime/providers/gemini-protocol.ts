import type { VoiceSessionSpec } from "../types";
import { providerTuning, settingsRecord } from "./settings";

export function buildGeminiSetup(spec: VoiceSessionSpec): Record<string, unknown> {
  const { generationConfig: configuredGeneration, ...configuredSetup } = spec.settings;
  const generation = settingsRecord(configuredGeneration);
  const speech = settingsRecord(generation.speechConfig);
  const voice = settingsRecord(speech.voiceConfig);
  const tuning = providerTuning(configuredSetup, ["model", "systemInstruction", "tools"]);
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
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: {},
      contextWindowCompression: { slidingWindow: {} },
      ...tuning,
      // Function declarations are fetched from toolProxyUrl by the browser and inserted before setup is sent.
      tools: [],
    },
  };
}

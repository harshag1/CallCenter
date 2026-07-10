import { describe, expect, it } from "vitest";
import { resolveVoiceProviderConfig } from "../realtime/config";

describe("realtime provider configuration", () => {
  it("keeps existing agents on xAI by default", () => {
    expect(resolveVoiceProviderConfig({}, "ara")).toEqual({
      provider: "xai",
      model: "grok-voice-latest",
      voice: "ara",
      settings: {},
    });
  });

  it("uses the current OpenAI realtime default without leaking reserved settings", () => {
    expect(resolveVoiceProviderConfig({
      voice_provider: "openai",
      voice_model: "gpt-realtime-2.1",
      provider_settings: { reasoning: { effort: "low" } },
      max_response_output_tokens: 512,
    }, "ara")).toEqual({
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "marin",
      settings: {
        max_response_output_tokens: 512,
        reasoning: { effort: "low" },
      },
    });
  });

  it("keeps custom Gemini model and voice names configurable", () => {
    expect(resolveVoiceProviderConfig({
      voice_provider: "gemini",
      voice_model: "gemini-future-live",
    }, "Aoede")).toMatchObject({
      provider: "gemini",
      model: "gemini-future-live",
      voice: "Aoede",
    });
  });
});

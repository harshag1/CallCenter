import { describe, expect, it } from "vitest";
import { resampleMono } from "../../components/call/providers/types";
import { buildGeminiSetup } from "../realtime/providers/gemini-protocol";
import { buildOpenAIClientSecretPayload, buildOpenAISession } from "../realtime/providers/openai-protocol";
import { buildXaiSessionUpdate } from "../realtime/providers/xai-protocol";

const sessionSpec = {
  provider: "xai" as const,
  model: "grok-voice-latest",
  voice: "ara",
  settings: {},
  instructions: "Help the caller.",
  mcpServers: [],
  toolProxyUrl: "https://example.com/api/mcp",
  toolProxyToken: "scope",
};

describe("realtime provider protocols", () => {
  it("nests OpenAI realtime configuration under session for client secrets", () => {
    const session = { type: "realtime", model: "gpt-realtime-2.1" };
    expect(buildOpenAIClientSecretPayload(session)).toEqual({
      expires_after: { anchor: "created_at", seconds: 600 },
      session,
    });
  });

  it("resamples browser audio to Gemini's fixed 16 kHz input rate", () => {
    const input = Float32Array.from({ length: 2_400 }, (_, index) => Math.sin(index / 20));
    const output = resampleMono(input, 24_000, 16_000);
    expect(output).toHaveLength(1_600);
    expect(output.every(Number.isFinite)).toBe(true);
  });

  it("does not allocate when the audio is already at the provider rate", () => {
    const input = new Float32Array([0, 0.5, -0.5]);
    expect(resampleMono(input, 16_000, 16_000)).toBe(input);
  });

  it.each([
    ["pcm" as const, "audio/pcm", 24_000],
    ["pcmu" as const, "audio/pcmu", 8_000],
  ])("configures xAI %s audio with caller transcription", (format, type, rate) => {
    expect(buildXaiSessionUpdate(sessionSpec, format)).toMatchObject({
      type: "session.update",
      session: {
        audio: {
          input: { format: { type, rate }, transcription: { model: "grok-transcribe" } },
          output: { format: { type, rate } },
        },
        resumption: { enabled: true },
      },
    });
  });

  it("keeps OpenAI runtime invariants while preserving safe tuning", () => {
    const configured = buildOpenAISession({
      ...sessionSpec,
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "marin",
      settings: {
        model: "wrong-model",
        instructions: "replace the flow",
        tools: [],
        tool_choice: "none",
        reasoning: { effort: "low" },
        audio: {
          input: {
            format: { type: "wrong" },
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: { type: "semantic_vad" },
          },
          output: { format: { type: "wrong" }, voice: "alloy", speed: 1.1 },
        },
      },
    }, "pcmu");
    expect(configured).toMatchObject({
      model: "gpt-realtime-2.1",
      instructions: "Help the caller.",
      tool_choice: "auto",
      reasoning: { effort: "low" },
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: { model: "gpt-4o-mini-transcribe" },
          turn_detection: { type: "semantic_vad" },
        },
        output: { format: { type: "audio/pcmu" }, voice: "marin", speed: 1.1 },
      },
    });
  });

  it("keeps Gemini audio, identity, instructions, and tools adapter-owned", () => {
    expect(buildGeminiSetup({
      ...sessionSpec,
      provider: "gemini",
      model: "gemini-3.1-flash-live-preview",
      voice: "Kore",
      settings: {
        model: "wrong-model",
        systemInstruction: "replace the flow",
        tools: [{ googleSearch: {} }],
        generationConfig: {
          temperature: 0.2,
          responseModalities: ["TEXT"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Wrong" } } },
        },
      },
    })).toMatchObject({
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        systemInstruction: { parts: [{ text: "Help the caller." }] },
        tools: [],
        generationConfig: {
          temperature: 0.2,
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
        },
      },
    });
  });

  it("keeps xAI transcription, codec, resumption, and grants adapter-owned", () => {
    expect(buildXaiSessionUpdate({
      ...sessionSpec,
      settings: {
        voice: "wrong",
        instructions: "replace the flow",
        tools: [],
        audio: {
          input: { format: { type: "wrong" }, transcription: { model: "wrong", language_hint: "en-US" } },
          output: { format: { type: "wrong" }, speed: 1.2 },
        },
        resumption: { enabled: false },
      },
    }, "pcmu")).toMatchObject({
      session: {
        voice: "ara",
        instructions: "Help the caller.",
        audio: {
          input: {
            format: { type: "audio/pcmu", rate: 8_000 },
            transcription: { model: "grok-transcribe", language_hint: "en-US" },
          },
          output: { format: { type: "audio/pcmu", rate: 8_000 }, speed: 1.2 },
        },
        resumption: { enabled: true },
      },
    });
  });
});

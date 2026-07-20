import { describe, expect, it } from "vitest";
import { resampleMono } from "../../components/call/providers/types";
import type { RemoteMcpServer, VoiceSessionSpec } from "../realtime/types";
import { LOCAL_TOOL_PROXY_FUNCTION_NAME } from "../realtime/client/types";
import { buildGeminiSetup } from "../realtime/providers/gemini-protocol";
import { buildOpenAIClientSecretPayload, buildOpenAISession } from "../realtime/providers/openai-protocol";
import {
  buildXaiBrowserProtocols,
  buildXaiClientSecretPayload,
  buildXaiSessionUpdate,
} from "../realtime/providers/xai-protocol";

const sessionSpec = {
  provider: "xai" as const,
  model: "grok-voice-think-fast-1.0",
  voice: "ara",
  settings: {},
  instructions: "Help the caller.",
  mcpServers: [],
  toolProxyUrl: "https://example.com/api/mcp",
  toolProxyToken: "scope",
  activeCatalogAuthority: {
    catalogDigest: "c".repeat(64),
    capabilityEpoch: 1,
    runtimeDigest: "d".repeat(64),
    stateRevision: 1,
  },
};

describe("realtime provider protocols", () => {
  it("nests OpenAI realtime configuration under session for client secrets", () => {
    const session = { type: "realtime", model: "gpt-realtime-2.1" };
    expect(buildOpenAIClientSecretPayload(session)).toEqual({
      expires_after: { anchor: "created_at", seconds: 600 },
      session,
    });
  });

  it("uses xAI's documented five-minute ephemeral-token request", () => {
    expect(buildXaiClientSecretPayload()).toEqual({ expires_after: { seconds: 300 } });
    expect(buildXaiBrowserProtocols("xai-realtime-client-secret-abc"))
      .toEqual(["xai-client-secret.xai-realtime-client-secret-abc"]);
    expect(() => buildXaiBrowserProtocols("bad secret")).toThrow(/subprotocol/);
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
      },
    });
    expect((buildXaiSessionUpdate(sessionSpec, format).session as Record<string, unknown>))
      .not.toHaveProperty("resumption");
  });

  it("enables xAI resumption only when the host opts in explicitly", () => {
    expect(buildXaiSessionUpdate({
      ...sessionSpec,
      settings: { resumption: { enabled: true } },
    }, "pcm")).toMatchObject({
      session: { resumption: { enabled: true } },
    });
  });

  it("keeps xAI model selection in the handshake while preserving documented reasoning tuning", () => {
    const update = buildXaiSessionUpdate({
      ...sessionSpec,
      settings: {
        type: "realtime",
        model: "wrong-session-model",
        reasoning: { effort: "high" },
      },
    }, "pcm");
    expect(update).toMatchObject({
      type: "session.update",
      session: { reasoning: { effort: "high" } },
    });
    const session = update.session as Record<string, unknown>;
    expect(session).not.toHaveProperty("model");
    expect(session).not.toHaveProperty("type");
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
        max_response_output_tokens: 512,
        tools: [],
        tool_choice: "none",
        output_modalities: ["text"],
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
      max_output_tokens: 512,
      output_modalities: ["audio"],
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
    expect(configured).not.toHaveProperty("max_response_output_tokens");
  });

  it("fails closed on invalid or conflicting OpenAI output-token limits", () => {
    const build = (settings: Record<string, unknown>) => buildOpenAISession({
      ...sessionSpec,
      provider: "openai" as const,
      model: "gpt-realtime-2.1",
      voice: "marin",
      settings,
    }, "pcm");
    expect(() => build({ max_output_tokens: 0 })).toThrow(/1 to 4096/);
    expect(() => build({ max_output_tokens: 512.5 })).toThrow(/1 to 4096/);
    expect(() => build({ max_output_tokens: 512, max_response_output_tokens: 256 }))
      .toThrow(/conflicts/);
    expect(build({ max_output_tokens: "inf" })).toMatchObject({ max_output_tokens: "inf" });
  });

  it("serializes an OpenAI custom voice ID using the documented object shape", () => {
    expect(buildOpenAISession({
      ...sessionSpec,
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "voice_1234",
    }, "pcm")).toMatchObject({
      audio: { output: { voice: { id: "voice_1234" } } },
    });
  });

  it("keeps the local function proxy enabled while omitting an empty remote-MCP allowlist", () => {
    const withNoRemoteTools = {
      ...sessionSpec,
      mcpServers: [{
        label: "locked",
        serverUrl: "https://mcp.example.test/v1",
        allowedTools: [],
      }],
    };
    expect(buildXaiSessionUpdate(withNoRemoteTools, "pcm"))
      .toMatchObject({ session: { tools: [{ type: "function", name: LOCAL_TOOL_PROXY_FUNCTION_NAME }] } });
    expect(buildOpenAISession({
      ...withNoRemoteTools,
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "marin",
    }, "pcm")).toMatchObject({ tools: [{ type: "function", name: LOCAL_TOOL_PROXY_FUNCTION_NAME }] });
  });

  it("omits provider-direct MCP by default, including its bearer", () => {
    const openai = buildOpenAISession({
      ...sessionSpec,
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "marin",
      mcpServers: [{
        label: "gateway",
        serverUrl: "https://app.example.test/api/mcp",
        authorization: "Bearer must-not-reach-provider",
      }],
    }, "pcm");
    const xai = buildXaiSessionUpdate({
      ...sessionSpec,
      mcpServers: [{
        label: "gateway",
        serverUrl: "https://app.example.test/api/mcp",
        authorization: "Bearer must-not-reach-provider",
      }],
    }, "pcm");
    expect(openai.tools).toEqual([
      expect.objectContaining({ type: "function", name: LOCAL_TOOL_PROXY_FUNCTION_NAME }),
    ]);
    expect((xai.session as Record<string, unknown>).tools).toEqual([
      expect.objectContaining({ type: "function", name: LOCAL_TOOL_PROXY_FUNCTION_NAME }),
    ]);
    expect(JSON.stringify({ openai, xai })).not.toContain("must-not-reach-provider");
  });

  it("requires both provider-direct MCP experimental grants for consequential tools", () => {
    const remote = [{ label: "gateway", serverUrl: "https://app.example.test/api/mcp" }];
    for (const settings of [
      { experimental_provider_direct_mcp: { enabled: true } },
      { experimental_provider_direct_mcp: { allow_consequential: true } },
      { experimental_provider_direct_mcp: { enabled: true, allow_consequential: false } },
    ]) {
      expect(() => buildOpenAISession({
        ...sessionSpec,
        provider: "openai",
        model: "gpt-realtime-2.1",
        voice: "marin",
        settings,
        mcpServers: remote,
      }, "pcm")).toThrow(/requires both/);
      expect(() => buildXaiSessionUpdate({ ...sessionSpec, settings, mcpServers: remote }, "pcm"))
        .toThrow(/requires both/);
    }
  });

  it("keeps provider-direct MCP behind the explicit two-part experimental escape hatch", () => {
    const settings = {
      experimental_provider_direct_mcp: { enabled: true, allow_consequential: true },
    };
    const mcpServers = [{
      label: "gateway",
      serverUrl: "https://external-mcp.example.net/v1",
      authorization: "Bearer experimental",
    }];
    const openai = buildOpenAISession({
      ...sessionSpec,
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "marin",
      settings,
      mcpServers,
    }, "pcm");
    expect(openai.tools).toEqual([
      expect.objectContaining({ type: "function", name: LOCAL_TOOL_PROXY_FUNCTION_NAME }),
      expect.objectContaining({
        type: "mcp",
        server_label: "gateway",
        authorization: "Bearer experimental",
        require_approval: "never",
      }),
    ]);
    const xai = buildXaiSessionUpdate({ ...sessionSpec, settings, mcpServers }, "pcm");
    expect((xai.session as Record<string, unknown>).tools).toEqual([
      expect.objectContaining({ type: "function", name: LOCAL_TOOL_PROXY_FUNCTION_NAME }),
      expect.objectContaining({
        type: "mcp",
        server_label: "gateway",
        authorization: "Bearer experimental",
      }),
    ]);
    expect(openai).not.toHaveProperty("experimental_provider_direct_mcp");
    expect(xai.session).not.toHaveProperty("experimental_provider_direct_mcp");
  });

  it("rejects local gateway disclosure or credential aliasing in provider-direct mode", () => {
    const settings = {
      experimental_provider_direct_mcp: { enabled: true, allow_consequential: true },
    };
    const buildOpenAI = (mcpServers: RemoteMcpServer[]) => buildOpenAISession({
      ...sessionSpec,
      provider: "openai" as const,
      model: "gpt-realtime-2.1",
      voice: "marin",
      settings,
      mcpServers,
    }, "pcm");
    expect(() => buildOpenAI([{
      label: "local-gateway",
      serverUrl: sessionSpec.toolProxyUrl,
      authorization: `Bearer ${sessionSpec.toolProxyToken}`,
    }])).toThrow(/same-origin or local endpoint/);
    expect(() => buildOpenAI([{
      label: "aliased-credential",
      serverUrl: "https://external-mcp.example.net/v1",
      authorization: `Bearer ${sessionSpec.toolProxyToken}`,
    }])).toThrow(/must not reuse the local tool proxy token/);
    expect(() => buildXaiSessionUpdate({
      ...sessionSpec,
      settings,
      mcpServers: [{
        label: "loopback",
        serverUrl: "https://127.0.0.1/mcp",
        authorization: "Bearer external",
      }],
    }, "pcm")).toThrow(/same-origin or local endpoint/);
  });

  it("gives both providers the same strict local gateway schema", () => {
    const openai = buildOpenAISession({
      ...sessionSpec,
      provider: "openai",
      model: "gpt-realtime-2.1",
      voice: "marin",
    }, "pcm");
    const xai = buildXaiSessionUpdate(sessionSpec, "pcm");
    expect(openai.tools[0]).toEqual((xai.session as { tools: unknown[] }).tools[0]);
    expect(openai.tools[0]).toMatchObject({
      type: "function",
      name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["tool_name", "arguments"],
      },
    });
  });

  it("keeps Gemini audio, identity, instructions, and tools adapter-owned", () => {
    const built = buildGeminiSetup({
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
    });
    expect(built).toMatchObject({
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
    expect(built.setup).not.toHaveProperty("inputAudioTranscription");
    expect(built.setup).not.toHaveProperty("outputAudioTranscription");
  });

  it("fails closed when Gemini provider settings try to enable uncapped transcription", () => {
    for (const settings of [
      { inputAudioTranscription: {} },
      { outputAudioTranscription: {} },
      { inputAudioTranscription: undefined },
      { outputAudioTranscription: null },
    ]) {
      expect(() => buildGeminiSetup({
        ...sessionSpec,
        provider: "gemini",
        model: "gemini-3.1-flash-live-preview",
        voice: "Kore",
        settings,
      })).toThrow(/independently metered played-PCM transcription evidence/);
    }
  });

  it("omits Gemini native resumption from primary sessions and strips direct overrides", () => {
    const setup = buildGeminiSetup({
      ...sessionSpec,
      provider: "gemini",
      model: "gemini-3.1-flash-live-preview",
      voice: "Kore",
      settings: { sessionResumption: { handle: "must-not-pass-through" } },
    }).setup as Record<string, unknown>;
    expect(setup).not.toHaveProperty("sessionResumption");
  });

  it("enables Gemini native resumption only through an exact exploratory plan pin", () => {
    const planSha256 = "a".repeat(64);
    const setup = buildGeminiSetup({
      ...sessionSpec,
      provider: "gemini",
      model: "gemini-3.1-flash-live-preview",
      voice: "Kore",
      settings: {},
      experimentalProviderNativeResumption: {
        enabled: true,
        phase: "exploratory",
        provider: "gemini",
        planSha256,
      },
    }).setup as Record<string, unknown>;
    expect(setup.sessionResumption).toEqual({});
    expect(setup).not.toHaveProperty("experimental_provider_native_resumption");
    expect(JSON.stringify(setup)).not.toContain(planSha256);
  });

  it("fails closed on malformed or unpinned Gemini resumption gates", () => {
    const build = (experimental: unknown) => buildGeminiSetup({
      ...sessionSpec,
      provider: "gemini" as const,
      model: "gemini-3.1-flash-live-preview",
      voice: "Kore",
      settings: {},
      experimentalProviderNativeResumption: experimental as VoiceSessionSpec["experimentalProviderNativeResumption"],
    });
    for (const invalid of [
      true,
      { enabled: true },
      { enabled: true, phase: "confirmatory", provider: "gemini", planSha256: "a".repeat(64) },
      { enabled: true, phase: "exploratory", provider: "xai", planSha256: "a".repeat(64) },
      { enabled: true, phase: "exploratory", provider: "gemini", planSha256: "not-a-hash" },
      { enabled: true, phase: "exploratory", provider: "gemini", planSha256: "a".repeat(64), extra: true },
      { enabled: false, phase: "exploratory", provider: "gemini", planSha256: "a".repeat(64) },
    ]) {
      expect(() => build(invalid)).toThrow(/exact exploratory, plan-pinned opt-in/);
    }
    expect(() => buildGeminiSetup({
      ...sessionSpec,
      provider: "gemini",
      model: "gemini-3.1-flash-live-preview",
      voice: "Kore",
      settings: {
        experimental_provider_native_resumption: {
          enabled: true,
          phase: "exploratory",
          provider: "gemini",
          plan_sha256: "a".repeat(64),
        },
      },
    })).toThrow(/server-authored exploratory plan/);
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
      },
    });
    expect((buildXaiSessionUpdate({
      ...sessionSpec,
      settings: { resumption: { enabled: false } },
    }, "pcmu").session as Record<string, unknown>)).not.toHaveProperty("resumption");
  });
});

import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_MATCHED_PAIR_INVARIANTS,
  LC4_PROVIDER_PRIMARY_SOURCES,
  LC4_PROVIDER_PROFILE_MANIFEST,
  assertLc4ProviderProfileManifest,
  createLc4ProviderProfileManifest,
} from "../lc4-provider-profiles";
import { LIVE_STS_PROVIDER_SPECS } from "../live-sts-development-experiment";
import { buildGeminiLiveSetup } from "../../realtime/client/gemini-live";
import { withManualPcmSession } from "../../realtime/client/openai-compatible";
import { LOCAL_TOOL_PROXY_FUNCTION } from "../../realtime/client/types";

function mutableCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("HACC-LC4 frozen realtime provider profiles", () => {
  it("is deterministic, hash-bound, and authorizes no paid/provider calls", () => {
    const replay = createLc4ProviderProfileManifest();
    expect(canonicalJson(replay)).toBe(canonicalJson(LC4_PROVIDER_PROFILE_MANIFEST));
    expect(replay.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(replay.execution_authorized).toBe(false);
    expect(() => assertLc4ProviderProfileManifest(replay)).not.toThrow();

    const tampered = mutableCopy(replay) as unknown as {
      manifest_sha256: string;
      providers: { openai: { voice: string } };
      [key: string]: unknown;
    };
    tampered.providers.openai.voice = "alloy";
    expect(() => assertLc4ProviderProfileManifest(tampered)).toThrow(/hash mismatch/);

    const tamperedBody: Record<string, unknown> = { ...tampered };
    delete tamperedBody.manifest_sha256;
    tampered.manifest_sha256 = sha256Hex(
      `harshas-amazing-call-center/lc4-provider-profile-manifest/v3\n${canonicalJson(tamperedBody)}`,
    );
    expect(() => assertLc4ProviderProfileManifest(tampered)).toThrow(/differs from the frozen profile/);
  });

  it("pins the exact documented versioned models, voices, and asymmetric audio rates", () => {
    expect(LIVE_STS_PROVIDER_SPECS).toEqual({
      openai: { provider: "openai", model: "gpt-realtime-2.1", voice: "marin", sampleRateHz: 24_000 },
      gemini: { provider: "gemini", model: "gemini-3.1-flash-live-preview", voice: "Aoede", sampleRateHz: 16_000 },
      xai: { provider: "xai", model: "grok-voice-think-fast-1.0", voice: "ara", sampleRateHz: 24_000 },
    });
    expect(LC4_PROVIDER_PROFILE_MANIFEST.providers.openai).toMatchObject({
      input_sample_rate_hz: 24_000,
      output_sample_rate_hz: 24_000,
    });
    expect(LC4_PROVIDER_PROFILE_MANIFEST.providers.gemini).toMatchObject({
      input_sample_rate_hz: 16_000,
      output_sample_rate_hz: 24_000,
    });
    expect(LC4_PROVIDER_PROFILE_MANIFEST.providers.xai).toMatchObject({
      input_sample_rate_hz: 24_000,
      output_sample_rate_hz: 24_000,
    });
  });

  it("freezes arm-identical non-treatment settings and names all treatment-varying fields", () => {
    expect(LC4_MATCHED_PAIR_INVARIANTS).toContain("versioned_model");
    expect(LC4_MATCHED_PAIR_INVARIANTS).toContain("temperature_omitted");
    expect(LC4_MATCHED_PAIR_INVARIANTS).toContain("reasoning_configuration_omitted");
    expect(LC4_PROVIDER_PROFILE_MANIFEST.matched_pair_contract.treatment_varying).toEqual([
      "prompt_and_context_construction",
      "logical_capability_catalog_exposed_through_the_static_gateway",
      "host_managed_state_guardrails_and_async_worker_semantics",
    ]);
    for (const profile of Object.values(LC4_PROVIDER_PROFILE_MANIFEST.providers)) {
      expect(profile.provider_visible_tool_surface).toEqual({
        mode: "single_static_function",
        function_name: "capability_gateway",
        tool_choice: "auto_or_provider_equivalent",
      });
      expect(profile.temperature_request).toBe("omitted_provider_default");
      expect(profile.reasoning_request).toBe("omitted_provider_default");
      expect(profile.session_resumption).toBe("disabled");
    }
  });

  it("matches the OpenAI and xAI manual-PCM session payloads used by the adapter", () => {
    const openai = withManualPcmSession("openai", {
      session: { audio: { input: {}, output: {} } },
    });
    expect(openai).toMatchObject({
      type: "session.update",
      session: {
        audio: {
          input: { format: { type: "audio/pcm", rate: 24_000 }, turn_detection: null },
          output: { format: { type: "audio/pcm", rate: 24_000 } },
        },
      },
    });
    const xai = withManualPcmSession("xai", {
      session: { audio: { input: {}, output: {} } },
    });
    expect(xai).toMatchObject({
      type: "session.update",
      session: {
        turn_detection: { type: null },
        audio: {
          input: { format: { type: "audio/pcm", rate: 24_000 } },
          output: { format: { type: "audio/pcm", rate: 24_000 } },
        },
      },
    });
  });

  it("matches Gemini setup while refusing a false system-authority equivalence", () => {
    const setup = buildGeminiLiveSetup({
      model: LIVE_STS_PROVIDER_SPECS.gemini.model,
      voice: LIVE_STS_PROVIDER_SPECS.gemini.voice,
      instructions: "frozen base instructions",
      tools: [LOCAL_TOOL_PROXY_FUNCTION],
    });
    expect(setup).toMatchObject({
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
        },
        realtimeInputConfig: {
          automaticActivityDetection: { disabled: true },
        },
        contextWindowCompression: { slidingWindow: {} },
      },
    });
    expect(LC4_PROVIDER_PROFILE_MANIFEST.providers.gemini.context_delivery).toEqual({
      wire_field: "realtimeInput.text_before_activityEnd",
      authority: "advisory_user_realtime_input_not_system_equivalent",
      composition: "condition_specific_context_as_realtime_text",
      cross_modal_ordering: "not_guaranteed_by_provider",
    });
    expect(LC4_PROVIDER_PROFILE_MANIFEST.interpretation_boundary.gemini_system_authority_equivalence_claimed)
      .toBe(false);
  });

  it("cites only official primary documentation for every frozen provider", () => {
    expect(Object.keys(LC4_PROVIDER_PRIMARY_SOURCES).sort()).toEqual(["gemini", "openai", "xai"]);
    for (const [provider, urls] of Object.entries(LC4_PROVIDER_PRIMARY_SOURCES)) {
      expect(urls.length, provider).toBeGreaterThanOrEqual(2);
      for (const url of urls) {
        const parsed = new URL(url);
        const expectedHost = provider === "openai"
          ? ["developers.openai.com"]
          : provider === "gemini"
            ? ["ai.google.dev"]
            : ["docs.x.ai"];
        expect(expectedHost).toContain(parsed.hostname);
        expect(parsed.protocol).toBe("https:");
      }
    }
  });
});

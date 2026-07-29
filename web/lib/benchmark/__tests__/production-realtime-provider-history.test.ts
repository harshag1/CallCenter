import { describe, expect, it, vi } from "vitest";

import { LIVE_STS_PROVIDER_SPECS, type LiveStsProvider } from "../live-sts-development-experiment";
import type { TrialSessionConfiguration } from "../orchestrator";

const geminiConstructor = vi.hoisted(() => ({
  options: [] as unknown[],
}));

vi.mock("../../realtime/client/gemini-live", () => ({
  GeminiLiveClient: class FakeGeminiLiveClient {
    constructor(options: unknown) {
      geminiConstructor.options.push(options);
    }
  },
}));

import {
  createProductionRealtimeClient,
  productionOpenAiCompatibleSessionUpdate,
} from "../production-realtime-provider";

const H = (character: string) => character.repeat(64);

function configuration(
  provider: LiveStsProvider,
  initialConversationHistoryHydrationRequired?: boolean,
): TrialSessionConfiguration {
  const spec = LIVE_STS_PROVIDER_SPECS[provider];
  return Object.freeze({
    provider,
    model: spec.model,
    conditionId: "raw-memory",
    instructions: `stable-${provider}-instructions`,
    ...(initialConversationHistoryHydrationRequired === undefined
      ? {}
      : { initialConversationHistoryHydrationRequired }),
    initialPrompt: "qualification",
    renderedCapabilitySnapshot: "<capability_snapshot>{}</capability_snapshot>",
    providerTools: Object.freeze([]),
    conditionHash: H("c"),
    inputAudioFormat: Object.freeze({
      encoding: "pcm16",
      sampleRateHz: provider === "gemini" ? 16_000 : 24_000,
      channels: 1,
    }),
    audioDeliveryProfile: Object.freeze({
      schemaVersion: 1,
      chunkMs: 20,
      pace: "realtime",
    }),
    audioDeliveryProfileHash: H("d"),
  });
}

describe("production realtime history hydration wiring", () => {
  it("opts Gemini into initial-history setup only when hydration is required", () => {
    geminiConstructor.options.length = 0;

    createProductionRealtimeClient(
      "gemini",
      configuration("gemini"),
      "gemini-secret-test",
    );
    createProductionRealtimeClient(
      "gemini",
      configuration("gemini", true),
      "gemini-secret-test",
    );

    expect(geminiConstructor.options).toHaveLength(2);
    expect(geminiConstructor.options[0]).not.toHaveProperty("enableInitialHistoryHydration");
    expect(geminiConstructor.options[1]).toMatchObject({
      instructions: "stable-gemini-instructions",
      enableInitialHistoryHydration: true,
    });
  });

  it.each(["openai", "xai"] as const)(
    "does not alter the %s session payload when native history hydration is required",
    (provider) => {
      expect(productionOpenAiCompatibleSessionUpdate(
        provider,
        configuration(provider, true),
      )).toEqual(productionOpenAiCompatibleSessionUpdate(
        provider,
        configuration(provider),
      ));
    },
  );
});

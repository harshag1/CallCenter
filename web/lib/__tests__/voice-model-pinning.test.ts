import { describe, expect, it } from "vitest";
import { MODELS } from "../xai";
import { PROVIDER_DEFAULTS } from "../realtime/config";
import { xaiAdapter } from "../realtime/providers/xai";

describe("production voice model pinning", () => {
  it("has no mutable xAI voice alias in any production default", () => {
    const defaults = [
      MODELS.voice,
      PROVIDER_DEFAULTS.xai.model,
      xaiAdapter.defaultModel,
    ];
    expect(defaults).toEqual(Array(defaults.length).fill("grok-voice-think-fast-1.0"));
    expect(defaults.every((model) => !/(?:^|[-_.])(?:latest|preview)(?:$|[-_.])/i.test(model))).toBe(true);
  });
});

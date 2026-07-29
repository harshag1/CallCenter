import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOperatorTurnInferenceAuthority,
  runOperatorTurnResearch,
} from "../agent/operator-turn-inference-authority";

describe("operator-turn nested research cancellation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ["xai", "XAI_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["gemini", "GEMINI_API_KEY"],
  ] as const)(
    "aborts a non-cooperative in-flight %s research transport with its parent turn",
    async (provider, keyName) => {
      vi.stubEnv("HACC_RESEARCH_PROVIDER", provider);
      vi.stubEnv(keyName, "fixture-credential");
      let providerSignal: AbortSignal | undefined;
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        providerSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      });
      vi.stubGlobal("fetch", fetchMock);
      const parent = new AbortController();
      const authority = createOperatorTurnInferenceAuthority({}, parent.signal);
      const research = runOperatorTurnResearch(
        authority,
        "Return a cited, bounded result.",
        "fixture query",
        { maxOutputTokens: 10 },
      );
      const rejection = expect(research).rejects.toThrow(
        "server inference operation cancelled for operator_research",
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledOnce();

      parent.abort();
      await rejection;
      expect(providerSignal?.aborted).toBe(true);
      expect(authority.budgetSnapshot()).toMatchObject({
        providerRequestsReserved: 1,
        researchRequestsReserved: 1,
        outputTokensReserved: 10,
      });
    },
  );
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServerInferenceAuthority: vi.fn(),
  createServerInferenceRuntime: vi.fn(),
  research: vi.fn(),
}));

vi.mock("../server-inference", () => ({
  createServerInferenceAuthority: mocks.createServerInferenceAuthority,
  createServerInferenceRuntime: mocks.createServerInferenceRuntime,
}));

import {
  OPERATOR_TURN_INFERENCE_LIMITS,
  createOperatorTurnInferenceAuthority,
  openOperatorBuilderRequest,
  reserveOperatorToolCalls,
  runOperatorTurnResearch,
} from "../agent/operator-turn-inference-authority";

function builderRequest(
  maxOutputTokens: number,
  fetch: typeof globalThis.fetch = vi.fn(),
) {
  return {
    maxOutputTokens,
    endpoint: "https://provider.example.test/v1/chat/completions",
    body: JSON.stringify({
      model: "fixture",
      messages: [{ role: "user", content: "bounded" }],
      stream: true,
      max_tokens: maxOutputTokens,
    }),
    headers: {
      Authorization: "Bearer fixture-credential",
      "Content-Type": "application/json",
    },
    fetch,
  };
}

describe("operator-turn transitive inference authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServerInferenceAuthority.mockReturnValue(Object.freeze({
      budgetSnapshot: () => Object.freeze({}),
    }));
    mocks.research.mockResolvedValue(Object.freeze({
      provider: "openai",
      model: "fixture-research",
      text: "grounded result",
      usage: Object.freeze({
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      }),
      requestId: null,
      budget: Object.freeze({}),
    }));
    mocks.createServerInferenceRuntime.mockImplementation((input) => ({
      input,
      research: mocks.research,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("admits the exact shared provider ceiling across builder and nested research", async () => {
    const authority = createOperatorTurnInferenceAuthority({
      maxProviderRequests: 2,
      maxBuilderRequests: 2,
      maxResearchRequests: 2,
      maxReservedOutputTokens: 3_200,
    });
    const lease = openOperatorBuilderRequest(authority, {
      ...builderRequest(1_600),
    });
    lease.close();

    await runOperatorTurnResearch(
      authority,
      "cite sources",
      "one bounded lookup",
      { maxOutputTokens: 1_200 },
    );
    await expect(runOperatorTurnResearch(
      authority,
      "cite sources",
      "must not dispatch",
      { maxOutputTokens: 1 },
    )).rejects.toThrow("provider-request budget exhausted");

    expect(authority.budgetSnapshot()).toMatchObject({
      providerRequestsReserved: 2,
      providerRequestsRemaining: 0,
      builderRequestsReserved: 1,
      builderRequestsRemaining: 1,
      researchRequestsReserved: 1,
      researchRequestsRemaining: 1,
      toolCallsReserved: 0,
      toolCallsRemaining: OPERATOR_TURN_INFERENCE_LIMITS.maxToolCalls,
      outputTokensReserved: 2_800,
      outputTokensRemaining: 400,
    });
    expect(authority.budgetSnapshot().inputBytesReserved).toBeGreaterThan(0);
    expect(
      authority.budgetSnapshot().inputBytesReserved
        + authority.budgetSnapshot().inputBytesRemaining,
    ).toBe(OPERATOR_TURN_INFERENCE_LIMITS.maxTotalInputBytes);
    expect(mocks.createServerInferenceRuntime).toHaveBeenCalledOnce();
    expect(mocks.research).toHaveBeenCalledOnce();
  });

  it("creates one nested authority and reuses it without a per-search reset", async () => {
    const nestedAuthority = Object.freeze({
      budgetSnapshot: () => Object.freeze({}),
    });
    mocks.createServerInferenceAuthority.mockReturnValueOnce(nestedAuthority);
    const authority = createOperatorTurnInferenceAuthority({
      maxProviderRequests: 3,
      maxBuilderRequests: 1,
      maxResearchRequests: 2,
      maxReservedOutputTokens: 2_400,
      maxBuilderOutputTokensPerRequest: 1,
    });

    await runOperatorTurnResearch(
      authority,
      "system",
      "first",
      { maxOutputTokens: 1_200 },
    );
    await runOperatorTurnResearch(
      authority,
      "system",
      "second",
      { maxOutputTokens: 1_200 },
    );
    await expect(runOperatorTurnResearch(
      authority,
      "system",
      "third",
      { maxOutputTokens: 1 },
    )).rejects.toThrow("research-request budget exhausted");

    expect(mocks.createServerInferenceAuthority).toHaveBeenCalledOnce();
    expect(mocks.createServerInferenceRuntime).toHaveBeenCalledTimes(2);
    for (const [input] of mocks.createServerInferenceRuntime.mock.calls) {
      expect(input).toMatchObject({
        purpose: "operator_research",
        workload: "research",
        authority: nestedAuthority,
      });
      expect("budget" in input).toBe(false);
    }
    expect(mocks.research).toHaveBeenCalledTimes(2);
  });

  it("binds the one nested research authority to the parent cancellation signal", async () => {
    const parent = new AbortController();
    const authority = createOperatorTurnInferenceAuthority({}, parent.signal);

    expect(mocks.createServerInferenceAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ signal: parent.signal }),
    );
    parent.abort();
    await expect(runOperatorTurnResearch(
      authority,
      "system",
      "must not dispatch",
      { maxOutputTokens: 1 },
    )).rejects.toThrow("operator turn inference cancelled");
    expect(mocks.createServerInferenceRuntime).not.toHaveBeenCalled();
    expect(authority.budgetSnapshot().providerRequestsReserved).toBe(0);
  });

  it("serializes concurrent reservations so only one caller owns the final slot", async () => {
    const authority = createOperatorTurnInferenceAuthority({
      maxProviderRequests: 1,
      maxBuilderRequests: 1,
      maxResearchRequests: 1,
      maxReservedOutputTokens: 1_600,
    });

    const attempts = await Promise.allSettled([0, 1].map(async (index) => {
      await Promise.resolve();
      return openOperatorBuilderRequest(authority, {
        ...builderRequest(1_600),
        body: JSON.stringify({
          model: "fixture",
          messages: [{ role: "user", content: `bounded-${index}` }],
          stream: true,
          max_tokens: 1_600,
        }),
      });
    }));
    const admitted = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<
        ReturnType<typeof openOperatorBuilderRequest>
      > => attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );

    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toEqual(
      expect.objectContaining({ message: "operator turn provider-request budget exhausted" }),
    );
    admitted[0]!.value.close();
    expect(authority.budgetSnapshot().providerRequestsReserved).toBe(1);
  });

  it("serializes concurrent builder and nested-research reservations on one slot", async () => {
    const authority = createOperatorTurnInferenceAuthority({
      maxProviderRequests: 1,
      maxBuilderRequests: 1,
      maxResearchRequests: 1,
      maxReservedOutputTokens: 1_600,
    });

    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => openOperatorBuilderRequest(
        authority,
        builderRequest(1_600),
      )),
      Promise.resolve().then(() => runOperatorTurnResearch(
        authority,
        "system",
        "must share the final slot",
        { maxOutputTokens: 1 },
      )),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    for (const attempt of attempts) {
      if (attempt.status === "fulfilled" && "close" in attempt.value) {
        attempt.value.close();
      }
    }
    expect(authority.budgetSnapshot().providerRequestsReserved).toBe(1);
    expect(
      authority.budgetSnapshot().builderRequestsReserved
        + authority.budgetSnapshot().researchRequestsReserved,
    ).toBe(1);
  });

  it("binds reservation to the exact dispatch body, endpoint, and output ceiling", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const authority = createOperatorTurnInferenceAuthority();
    const request = builderRequest(17, fetchMock);
    const lease = openOperatorBuilderRequest(authority, request);

    await expect(lease.dispatch()).resolves.toMatchObject({ status: 200 });
    await expect(lease.dispatch()).rejects.toThrow("exceeded one fetch dispatch");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      request.endpoint,
      expect.objectContaining({
        method: "POST",
        headers: request.headers,
        body: request.body,
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    lease.close();

    const invalidAuthority = createOperatorTurnInferenceAuthority();
    expect(() => openOperatorBuilderRequest(invalidAuthority, {
      ...builderRequest(17, fetchMock),
      body: JSON.stringify({
        stream: true,
        max_tokens: 18,
      }),
    })).toThrow("does not match its output-token reservation");
    expect(invalidAuthority.budgetSnapshot().providerRequestsReserved).toBe(0);
  });

  it("rejects oversized JSON before parsing and rejects query-bearing endpoints", () => {
    const tinyAuthority = createOperatorTurnInferenceAuthority({
      maxInputBytesPerRequest: 1,
    });
    expect(() => openOperatorBuilderRequest(tinyAuthority, {
      ...builderRequest(1),
      body: "{".repeat(10_000),
    })).toThrow("input exceeded its 1-byte budget");
    expect(tinyAuthority.budgetSnapshot().providerRequestsReserved).toBe(0);

    const endpointAuthority = createOperatorTurnInferenceAuthority();
    expect(() => openOperatorBuilderRequest(endpointAuthority, {
      ...builderRequest(1),
      endpoint: "https://provider.example.test/v1/chat?credential=forbidden",
    })).toThrow("credential-free HTTPS URL");
    expect(endpointAuthority.budgetSnapshot().providerRequestsReserved).toBe(0);
  });

  it("consumes a failed provider attempt and cannot reset it with another lease", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fixture network failure");
    });
    const authority = createOperatorTurnInferenceAuthority({
      maxProviderRequests: 1,
      maxBuilderRequests: 1,
      maxResearchRequests: 1,
      maxReservedOutputTokens: 1_600,
    });
    const lease = openOperatorBuilderRequest(
      authority,
      builderRequest(1_600, fetchMock),
    );

    await expect(lease.dispatch()).rejects.toThrow("fixture network failure");
    lease.close();
    expect(() => openOperatorBuilderRequest(
      authority,
      builderRequest(1),
    )).toThrow("provider-request budget exhausted");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bounds cumulative input bytes across otherwise-valid provider requests", () => {
    const first = builderRequest(1);
    const requestBytes = new TextEncoder().encode(first.body).byteLength;
    const authority = createOperatorTurnInferenceAuthority({
      maxProviderRequests: 2,
      maxBuilderRequests: 2,
      maxResearchRequests: 1,
      maxReservedOutputTokens: 2,
      maxBuilderOutputTokensPerRequest: 1,
      maxResearchOutputTokensPerRequest: 1,
      maxInputBytesPerRequest: requestBytes,
      maxTotalInputBytes: requestBytes,
    });
    const lease = openOperatorBuilderRequest(authority, first);
    lease.close();

    expect(() => openOperatorBuilderRequest(
      authority,
      builderRequest(1),
    )).toThrow("input-byte budget exhausted");
    expect(authority.budgetSnapshot()).toMatchObject({
      providerRequestsReserved: 1,
      inputBytesReserved: requestBytes,
      inputBytesRemaining: 0,
    });
  });

  it("reserves tool batches atomically at the exact hard maximum", () => {
    const authority = createOperatorTurnInferenceAuthority();

    expect(reserveOperatorToolCalls(
      authority,
      OPERATOR_TURN_INFERENCE_LIMITS.maxToolCalls,
    ).toolCallsRemaining).toBe(0);
    expect(() => reserveOperatorToolCalls(authority, 1))
      .toThrow("tool-call budget exhausted");
    expect(authority.budgetSnapshot().toolCallsReserved)
      .toBe(OPERATOR_TURN_INFERENCE_LIMITS.maxToolCalls);
  });

  it("does not dispatch a provider fetch after the absolute turn deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    const authority = createOperatorTurnInferenceAuthority({
      requestTimeoutMs: 10,
      operationTimeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(11);

    expect(() => openOperatorBuilderRequest(authority, {
      ...builderRequest(1, fetchMock),
    })).toThrow("operator turn inference deadline exhausted");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(authority.budgetSnapshot().providerRequestsReserved).toBe(0);
  });

  it("settles at the request deadline and aborts a non-cooperative fetch", async () => {
    vi.useFakeTimers();
    let dispatchedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_request, init?: RequestInit) => {
      dispatchedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const authority = createOperatorTurnInferenceAuthority({
      requestTimeoutMs: 10,
      operationTimeoutMs: 100,
    });
    const lease = openOperatorBuilderRequest(authority, {
      ...builderRequest(1, fetchMock),
    });
    const request = lease.dispatch();
    const rejection = expect(request).rejects.toThrow(
      "operator turn builder request timed out",
    );
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(dispatchedSignal?.aborted).toBe(true);
    lease.close();
  });

  it("rejects a fulfillment that crosses the deadline before its handler runs", async () => {
    vi.useFakeTimers({ now: 0 });
    const authority = createOperatorTurnInferenceAuthority({
      requestTimeoutMs: 10,
      operationTimeoutMs: 100,
    });
    const lease = openOperatorBuilderRequest(authority, builderRequest(1));
    const late = lease.guard(Promise.resolve().then(() => {
      vi.setSystemTime(11);
      return "must not escape";
    }));

    await expect(late).rejects.toThrow("operator turn builder request timed out");
    lease.close();
  });

  it("aborts an in-flight builder dispatch when the parent turn is cancelled", async () => {
    const parent = new AbortController();
    let dispatchedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_request, init?: RequestInit) => {
      dispatchedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const authority = createOperatorTurnInferenceAuthority({}, parent.signal);
    const lease = openOperatorBuilderRequest(
      authority,
      builderRequest(1, fetchMock),
    );
    const pending = lease.dispatch();
    const rejection = expect(pending).rejects.toThrow(
      "operator turn inference cancelled",
    );
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();

    parent.abort();
    await rejection;
    expect(dispatchedSignal?.aborted).toBe(true);
    expect(() => openOperatorBuilderRequest(
      authority,
      builderRequest(1),
    )).toThrow("operator turn inference cancelled");
    lease.close();
  });
});

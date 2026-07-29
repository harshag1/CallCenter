import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createServerInferenceAuthority,
  createServerInferenceRuntime,
  resolveServerInferenceConfig,
  serverInferenceCapabilities,
  type ServerInferenceCompletionInput,
  type ServerInferenceProviderAdapter,
} from "../server-inference";

const DEFAULT_BUDGET = {
  maxProviderRequests: 2,
  maxReservedOutputTokens: 200,
  maxInputBytesPerRequest: 32 * 1024,
  requestTimeoutMs: 5_000,
} as const;

function fakeAdapters(
  overrides: Partial<Record<"xai" | "openai" | "gemini", ServerInferenceProviderAdapter>> = {},
): Readonly<Record<"xai" | "openai" | "gemini", ServerInferenceProviderAdapter>> {
  const adapter = (provider: "xai" | "openai" | "gemini"): ServerInferenceProviderAdapter => ({
    provider,
    credentialEnvironmentVariable: provider === "xai"
      ? "XAI_API_KEY"
      : provider === "openai"
        ? "OPENAI_API_KEY"
        : "GEMINI_API_KEY",
    defaultModels: { generation: `${provider}-generation`, research: `${provider}-research` },
    capabilities: new Set(["chat", "json", "tool_calls", "web_search"]),
    async complete() {
      return {
        message: { role: "assistant", content: '{"ok":true}' },
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        requestId: "fixture-request",
      };
    },
    async research() {
      return {
        text: '{"finding":"verified"}',
        usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
      };
    },
  });
  return {
    xai: overrides.xai ?? adapter("xai"),
    openai: overrides.openai ?? adapter("openai"),
    gemini: overrides.gemini ?? adapter("gemini"),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("server inference configuration", () => {
  it("defaults generation and research independently while retaining xAI compatibility", () => {
    expect(resolveServerInferenceConfig("generation", {})).toEqual({
      provider: "xai",
      model: "grok-4.20-non-reasoning",
      workload: "generation",
    });
    expect(resolveServerInferenceConfig("research", {})).toEqual({
      provider: "xai",
      model: "grok-4.3",
      workload: "research",
    });
  });

  it("uses server-owned provider/model pins and never accepts an unknown provider", () => {
    expect(resolveServerInferenceConfig("generation", {
      HACC_INFERENCE_PROVIDER: "openai",
      HACC_INFERENCE_MODEL: "pinned-generation",
    })).toMatchObject({ provider: "openai", model: "pinned-generation" });
    expect(resolveServerInferenceConfig("research", {
      HACC_INFERENCE_PROVIDER: "openai",
      HACC_RESEARCH_PROVIDER: "gemini",
      HACC_RESEARCH_MODEL: "pinned-research",
    })).toMatchObject({ provider: "gemini", model: "pinned-research" });
    expect(() => resolveServerInferenceConfig("research", {
      HACC_RESEARCH_PROVIDER: "automatic",
    })).toThrow("HACC_RESEARCH_PROVIDER must be one of");
  });

  it("never applies a generation model pin to a different research provider", () => {
    expect(resolveServerInferenceConfig("research", {
      HACC_INFERENCE_PROVIDER: "openai",
      HACC_INFERENCE_MODEL: "openai-generation-pin",
      HACC_RESEARCH_PROVIDER: "gemini",
    }, fakeAdapters())).toEqual({
      provider: "gemini",
      model: "gemini-research",
      workload: "research",
    });

    expect(resolveServerInferenceConfig("research", {
      HACC_INFERENCE_PROVIDER: "openai",
      HACC_INFERENCE_MODEL: "shared-provider-pin",
      HACC_RESEARCH_PROVIDER: "openai",
    }, fakeAdapters())).toMatchObject({
      provider: "openai",
      model: "shared-provider-pin",
    });
  });

  it("publishes provider capability differences instead of implying parity", () => {
    expect(serverInferenceCapabilities("xai")).toContain("web_search_domain_filter");
    expect(serverInferenceCapabilities("openai")).toContain("web_search_domain_filter");
    expect(serverInferenceCapabilities("gemini")).not.toContain("web_search_domain_filter");
  });
});

describe("server inference budget authority", () => {
  it("rejects explicit lane partitions that overbook the operation authority", () => {
    expect(() => createServerInferenceAuthority({
      purpose: "background_task",
      budget: {
        maxProviderRequests: 3,
        maxReservedOutputTokens: 30,
        maxInputBytesPerRequest: 1_024,
        requestTimeoutMs: 1_000,
        lanes: {
          generation: {
            maxProviderRequests: 2,
            maxReservedOutputTokens: 20,
          },
          research: {
            maxProviderRequests: 2,
            maxReservedOutputTokens: 20,
          },
        },
      },
    })).toThrow("lane request budgets exceed");
  });

  it("shares one exact request/output authority across generation and nested research", async () => {
    const adapters = fakeAdapters();
    const authority = createServerInferenceAuthority({
      purpose: "background_task",
      budget: {
        maxProviderRequests: 3,
        maxReservedOutputTokens: 90,
        maxInputBytesPerRequest: 32 * 1024,
        requestTimeoutMs: 5_000,
        operationTimeoutMs: 10_000,
      },
    });
    const generation = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      authority,
      environment: { XAI_API_KEY: "fixture-credential" },
      adapters,
    });
    const research = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "research",
      authority,
      environment: {
        HACC_RESEARCH_PROVIDER: "openai",
        OPENAI_API_KEY: "fixture-credential",
      },
      adapters,
    });

    await generation.complete(
      [{ role: "user", content: "plan" }],
      { maxOutputTokens: 30 },
    );
    await research.research("system", "lookup", { maxOutputTokens: 30 });
    await generation.complete(
      [{ role: "user", content: "summarize" }],
      { maxOutputTokens: 30 },
    );
    await expect(research.research(
      "system",
      "unmetered fourth request",
      { maxOutputTokens: 1 },
    )).rejects.toThrow("request budget exhausted");
    expect(authority.budgetSnapshot()).toEqual({
      providerRequestsReserved: 3,
      outputTokensReserved: 90,
      providerRequestsRemaining: 0,
      outputTokensRemaining: 0,
    });
    expect(generation.budgetSnapshot()).toEqual(authority.budgetSnapshot());
    expect(research.budgetSnapshot()).toEqual(authority.budgetSnapshot());
  });

  it("partitions concurrent nested research so generation continuations remain available", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const base = fakeAdapters();
    const adapters = fakeAdapters({
      xai: {
        ...base.xai,
        async research(_input, context) {
          await context.fetch("https://provider.invalid/bounded-research");
          return { text: "finding" };
        },
      },
    });
    const authority = createServerInferenceAuthority({
      purpose: "background_task",
      budget: {
        maxProviderRequests: 5,
        maxReservedOutputTokens: 70,
        maxInputBytesPerRequest: 32 * 1024,
        requestTimeoutMs: 5_000,
        lanes: {
          generation: {
            maxProviderRequests: 2,
            maxReservedOutputTokens: 40,
          },
          research: {
            maxProviderRequests: 3,
            maxReservedOutputTokens: 30,
          },
        },
      },
    });
    const research = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "research",
      authority,
      environment: { XAI_API_KEY: "fixture-credential" },
      fetch: fetchMock,
      adapters,
    });
    const generation = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      authority,
      environment: { XAI_API_KEY: "fixture-credential" },
      fetch: fetchMock,
      adapters,
    });

    const fanout = await Promise.allSettled(Array.from(
      { length: 64 },
      (_, index) => research.research("system", `query-${index}`, {
        maxOutputTokens: 10,
      }),
    ));
    expect(fanout.filter(({ status }) => status === "fulfilled")).toHaveLength(3);
    expect(fanout.filter(({ status }) => status === "rejected")).toHaveLength(61);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await generation.complete(
      [{ role: "user", content: "continuation one" }],
      { maxOutputTokens: 20 },
    );
    await generation.complete(
      [{ role: "user", content: "continuation two" }],
      { maxOutputTokens: 20 },
    );
    await expect(generation.complete(
      [{ role: "user", content: "continuation three" }],
      { maxOutputTokens: 1 },
    )).rejects.toThrow("generation request budget exhausted");
    expect(authority.budgetSnapshot()).toEqual({
      providerRequestsReserved: 5,
      outputTokensReserved: 70,
      providerRequestsRemaining: 0,
      outputTokensRemaining: 0,
    });
  });

  it("reserves request and output ceilings before dispatch and fails closed when exhausted", async () => {
    const calls: unknown[] = [];
    const base = fakeAdapters().xai;
    const adapters = fakeAdapters({
      xai: {
        ...base,
        async complete(input, context) {
          calls.push({ input, context });
          return base.complete(input, context);
        },
      },
    });
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      budget: { ...DEFAULT_BUDGET, maxProviderRequests: 1, maxReservedOutputTokens: 40 },
      environment: { XAI_API_KEY: "fixture-credential" },
      adapters,
    });

    const response = await runtime.complete(
      [{ role: "user", content: "do bounded work" }],
      { maxOutputTokens: 40 },
    );
    expect(response.budget).toEqual({
      providerRequestsReserved: 1,
      outputTokensReserved: 40,
      providerRequestsRemaining: 0,
      outputTokensRemaining: 0,
    });
    await expect(runtime.complete(
      [{ role: "user", content: "run again" }],
      { maxOutputTokens: 1 },
    )).rejects.toThrow("request budget exhausted");
    expect(calls).toHaveLength(1);
  });

  it("snapshots budget authority so caller mutation cannot expand it", async () => {
    const mutableBudget = {
      ...DEFAULT_BUDGET,
      maxProviderRequests: 1,
      maxReservedOutputTokens: 50,
    };
    const complete = vi.fn(fakeAdapters().xai.complete);
    const base = fakeAdapters().xai;
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      budget: mutableBudget,
      environment: { XAI_API_KEY: "fixture-credential" },
      adapters: fakeAdapters({ xai: { ...base, complete } }),
    });

    mutableBudget.maxProviderRequests = 2;
    mutableBudget.maxReservedOutputTokens = 100;

    await runtime.complete(
      [{ role: "user", content: "first bounded request" }],
      { maxOutputTokens: 50 },
    );
    await expect(runtime.complete(
      [{ role: "user", content: "authority added after construction" }],
      { maxOutputTokens: 50 },
    )).rejects.toThrow("request budget exhausted");
    expect(complete).toHaveBeenCalledOnce();
    expect(runtime.budgetSnapshot()).toEqual({
      providerRequestsReserved: 1,
      outputTokensReserved: 50,
      providerRequestsRemaining: 0,
      outputTokensRemaining: 0,
    });
  });

  it("deep-snapshots admitted messages and tool schemas before asynchronous dispatch", async () => {
    let observed: ServerInferenceCompletionInput | undefined;
    const base = fakeAdapters().xai;
    const adapters = fakeAdapters({
      xai: {
        ...base,
        async complete(input) {
          observed = input;
          expect(Object.isFrozen(input)).toBe(true);
          expect(Object.isFrozen(input.messages)).toBe(true);
          expect(Object.isFrozen(input.messages[0])).toBe(true);
          expect(Object.isFrozen(input.tools)).toBe(true);
          expect(Object.isFrozen(input.tools?.[0]?.function.parameters)).toBe(true);
          return {
            message: { role: "assistant", content: "bounded snapshot" },
          };
        },
      },
    });
    const messages = [{ role: "user" as const, content: "original request" }];
    const allowedActions = ["renew"];
    const tools = [{
      type: "function" as const,
      function: {
        name: "membership_action",
        description: "Perform an admitted membership action",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: allowedActions,
            },
          },
        },
      },
    }];
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      budget: {
        ...DEFAULT_BUDGET,
        maxInputBytesPerRequest: 1_024,
      },
      environment: { XAI_API_KEY: "fixture-credential" },
      adapters,
    });

    const completion = runtime.complete(messages, {
      tools,
      maxOutputTokens: 50,
    });
    messages[0]!.content = "x".repeat(10_000);
    allowedActions.push("caller-added-after-admission");

    await expect(completion).resolves.toMatchObject({
      message: { content: "bounded snapshot" },
    });
    expect(observed?.messages[0]?.content).toBe("original request");
    expect(
      (
        observed?.tools?.[0]?.function.parameters.properties as {
          action: { enum: string[] };
        }
      ).action.enum,
    ).toEqual(["renew"]);
  });

  it("rejects oversized input, missing credentials, and invalid budgets before provider I/O", async () => {
    const complete = vi.fn();
    const base = fakeAdapters().xai;
    const adapters = fakeAdapters({
      xai: { ...base, complete },
    });
    expect(() => createServerInferenceRuntime({
      purpose: "post_call_qa",
      workload: "generation",
      budget: DEFAULT_BUDGET,
      environment: {},
      adapters,
    })).toThrow("XAI_API_KEY is required");

    const runtime = createServerInferenceRuntime({
      purpose: "post_call_qa",
      workload: "generation",
      budget: { ...DEFAULT_BUDGET, maxInputBytesPerRequest: 20 },
      environment: { XAI_API_KEY: "fixture-credential" },
      adapters,
    });
    await expect(runtime.complete(
      [{ role: "user", content: "this payload is longer than twenty bytes" }],
      { maxOutputTokens: 10 },
    )).rejects.toThrow("input exceeded");
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not retry or fall back to a different provider after failure", async () => {
    const openAiComplete = vi.fn();
    const base = fakeAdapters();
    const adapters = fakeAdapters({
      xai: {
        ...base.xai,
        async complete() {
          throw new Error("provider connection details that must not escape");
        },
      },
      openai: { ...base.openai, complete: openAiComplete },
    });
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      budget: DEFAULT_BUDGET,
      environment: { XAI_API_KEY: "fixture-credential", OPENAI_API_KEY: "unused-credential" },
      adapters,
    });
    await expect(runtime.complete(
      [{ role: "user", content: "one attempt" }],
      { maxOutputTokens: 50 },
    )).rejects.toThrow("server inference request failed for xai");
    expect(openAiComplete).not.toHaveBeenCalled();
    expect(runtime.budgetSnapshot().providerRequestsReserved).toBe(1);
  });

  it("enforces a raced deadline and cannot publish a non-cooperative adapter's late result", async () => {
    let resolveProvider:
      ((value: Awaited<ReturnType<ServerInferenceProviderAdapter["complete"]>>) => void)
      | undefined;
    let providerSignal: AbortSignal | undefined;
    let publishedCompletions = 0;
    const base = fakeAdapters().xai;
    const adapters = fakeAdapters({
      xai: {
        ...base,
        complete(_input, context) {
          providerSignal = context.signal;
          return new Promise((resolve) => {
            resolveProvider = resolve;
          });
        },
      },
    });
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      budget: {
        ...DEFAULT_BUDGET,
        requestTimeoutMs: 10,
        operationTimeoutMs: 100,
      },
      environment: { XAI_API_KEY: "fixture-credential" },
      adapters,
    });

    const completion = runtime.complete(
      [{ role: "user", content: "adapter ignores AbortSignal" }],
      { maxOutputTokens: 50 },
    ).then((value) => {
      publishedCompletions += 1;
      return value;
    });
    const watchdog = new Promise<"watchdog">((resolve) => {
      setTimeout(() => resolve("watchdog"), 250);
    });
    const outcome = await Promise.race([
      completion.then(
        () => "unexpected completion" as const,
        (error: unknown) => error,
      ),
      watchdog,
    ]);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("server inference request timed out for xai");
    expect(providerSignal?.aborted).toBe(true);
    expect(publishedCompletions).toBe(0);
    expect(runtime.budgetSnapshot()).toEqual({
      providerRequestsReserved: 1,
      outputTokensReserved: 50,
      providerRequestsRemaining: 1,
      outputTokensRemaining: 150,
    });

    resolveProvider?.({
      message: { role: "assistant", content: "late result must not publish" },
      requestId: "late-request",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publishedCompletions).toBe(0);
    expect(runtime.budgetSnapshot()).toEqual({
      providerRequestsReserved: 1,
      outputTokensReserved: 50,
      providerRequestsRemaining: 1,
      outputTokensRemaining: 150,
    });
  });

  it.each(["omitted", "replaced"] as const)(
    "forces the host AbortSignal into adapter fetch when the adapter signal is %s",
    async (mode) => {
      let contextSignal: AbortSignal | undefined;
      let forwardedSignal: AbortSignal | null | undefined;
      const hostileController = new AbortController();
      const fetchMock = vi.fn((
        _request: RequestInfo | URL,
        init?: RequestInit,
      ) => new Promise<Response>((_resolve, reject) => {
        forwardedSignal = init?.signal;
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
      const base = fakeAdapters().xai;
      const runtime = createServerInferenceRuntime({
        purpose: "background_task",
        workload: "generation",
        budget: {
          ...DEFAULT_BUDGET,
          requestTimeoutMs: 10,
          operationTimeoutMs: 100,
        },
        environment: { XAI_API_KEY: "fixture-credential" },
        fetch: fetchMock,
        adapters: fakeAdapters({
          xai: {
            ...base,
            async complete(_input, context) {
              contextSignal = context.signal;
              if (mode === "omitted") {
                await context.fetch("https://provider.invalid/host-signal");
              } else {
                await context.fetch("https://provider.invalid/host-signal", {
                  signal: hostileController.signal,
                });
              }
              return { message: { role: "assistant", content: "unreachable" } };
            },
          },
        }),
      });

      await expect(runtime.complete(
        [{ role: "user", content: "host owns cancellation" }],
        { maxOutputTokens: 50 },
      )).rejects.toThrow("server inference request timed out for xai");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(forwardedSignal).toBe(contextSignal);
      expect(contextSignal?.aborted).toBe(true);
      expect(hostileController.signal.aborted).toBe(false);
    },
  );

  it("rejects an already-cancelled parent before reservation or adapter dispatch", async () => {
    const parent = new AbortController();
    parent.abort(new Error("private host cancellation detail"));
    const complete = vi.fn(fakeAdapters().xai.complete);
    const base = fakeAdapters().xai;
    const authority = createServerInferenceAuthority({
      purpose: "background_task",
      signal: parent.signal,
      budget: DEFAULT_BUDGET,
    });
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      authority,
      environment: { XAI_API_KEY: "fixture-credential" },
      adapters: fakeAdapters({ xai: { ...base, complete } }),
    });

    await expect(runtime.complete(
      [{ role: "user", content: "must not dispatch" }],
      { maxOutputTokens: 50 },
    )).rejects.toThrow(
      "server inference operation cancelled for background_task",
    );
    expect(complete).not.toHaveBeenCalled();
    expect(authority.budgetSnapshot()).toEqual({
      providerRequestsReserved: 0,
      outputTokensReserved: 0,
      providerRequestsRemaining: 2,
      outputTokensRemaining: 200,
    });
  });

  it("races active parent cancellation and aborts the in-flight host transport", async () => {
    const parent = new AbortController();
    let hostSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((
      _request: RequestInfo | URL,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      hostSignal = init?.signal ?? undefined;
      if (!hostSignal) return;
      if (hostSignal.aborted) {
        reject(hostSignal.reason);
        return;
      }
      hostSignal.addEventListener(
        "abort",
        () => reject(hostSignal?.reason),
        { once: true },
      );
    }));
    const base = fakeAdapters().xai;
    const authority = createServerInferenceAuthority({
      purpose: "background_task",
      signal: parent.signal,
      budget: DEFAULT_BUDGET,
    });
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      authority,
      environment: { XAI_API_KEY: "fixture-credential" },
      fetch: fetchMock,
      adapters: fakeAdapters({
        xai: {
          ...base,
          async complete(_input, context) {
            await context.fetch("https://provider.invalid/pending");
            return { message: { role: "assistant", content: "unreachable" } };
          },
        },
      }),
    });

    const outcome = runtime.complete(
      [{ role: "user", content: "cancel after dispatch" }],
      { maxOutputTokens: 50 },
    ).then(
      () => new Error("unexpected completion"),
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    parent.abort(new Error("private host cancellation detail"));

    await expect(outcome).resolves.toMatchObject({
      message: "server inference operation cancelled for background_task",
    });
    expect(hostSignal?.aborted).toBe(true);
    expect(authority.budgetSnapshot()).toEqual({
      providerRequestsReserved: 1,
      outputTokensReserved: 50,
      providerRequestsRemaining: 1,
      outputTokensRemaining: 150,
    });
  });

  it("observes a non-cooperative adapter's rejection after the hard deadline", async () => {
    let rejectProvider: ((reason?: unknown) => void) | undefined;
    const base = fakeAdapters().xai;
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      budget: {
        ...DEFAULT_BUDGET,
        requestTimeoutMs: 10,
        operationTimeoutMs: 100,
      },
      environment: { XAI_API_KEY: "fixture-credential" },
      adapters: fakeAdapters({
        xai: {
          ...base,
          complete() {
            return new Promise((_resolve, reject) => {
              rejectProvider = reject;
            });
          },
        },
      }),
    });

    await expect(runtime.complete(
      [{ role: "user", content: "adapter rejects after deadline" }],
      { maxOutputTokens: 50 },
    )).rejects.toThrow("server inference request timed out for xai");
    rejectProvider?.(new Error("late provider rejection with private transport details"));
    // If the runtime had not installed the losing promise's rejection handler,
    // Vitest would report this as an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("blocks provider dispatch when the absolute deadline crosses after reservation", async () => {
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(0) // authority creation
      .mockReturnValueOnce(0) // request reservation
      .mockReturnValueOnce(0) // deadline timer registration
      .mockReturnValue(2); // adapter-dispatch microtask
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const base = fakeAdapters().xai;
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      budget: {
        ...DEFAULT_BUDGET,
        requestTimeoutMs: 100,
        operationTimeoutMs: 1,
      },
      environment: { XAI_API_KEY: "fixture-credential" },
      fetch: fetchMock,
      adapters: fakeAdapters({
        xai: {
          ...base,
          async complete(_input, context) {
            await context.fetch("https://provider.invalid/must-not-dispatch");
            return { message: { role: "assistant", content: "too late" } };
          },
        },
      }),
    });

    await expect(runtime.complete(
      [{ role: "user", content: "deadline edge" }],
      { maxOutputTokens: 50 },
    )).rejects.toThrow("operation deadline exhausted");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtime.budgetSnapshot().providerRequestsReserved).toBe(1);
    now.mockRestore();
  });

  it("blocks an adapter that delays its first fetch until after the operation deadline", async () => {
    let clockMs = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const base = fakeAdapters().xai;
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      budget: {
        ...DEFAULT_BUDGET,
        requestTimeoutMs: 100,
        operationTimeoutMs: 1,
      },
      environment: { XAI_API_KEY: "fixture-credential" },
      fetch: fetchMock,
      adapters: fakeAdapters({
        xai: {
          ...base,
          async complete(_input, context) {
            clockMs = 2;
            await context.fetch("https://provider.invalid/late-first-fetch");
            return { message: { role: "assistant", content: "too late" } };
          },
        },
      }),
    });

    await expect(runtime.complete(
      [{ role: "user", content: "adapter stalls before fetch" }],
      { maxOutputTokens: 50 },
    )).rejects.toThrow("operation deadline exhausted");
    expect(fetchMock).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("cannot publish an adapter result that completes after the absolute deadline", async () => {
    let clockMs = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
    const base = fakeAdapters().xai;
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      budget: {
        ...DEFAULT_BUDGET,
        requestTimeoutMs: 100,
        operationTimeoutMs: 10,
      },
      environment: { XAI_API_KEY: "fixture-credential" },
      adapters: fakeAdapters({
        xai: {
          ...base,
          async complete() {
            clockMs = 11;
            return {
              message: { role: "assistant", content: "late result" },
            };
          },
        },
      }),
    });

    await expect(runtime.complete(
      [{ role: "user", content: "must not publish late" }],
      { maxOutputTokens: 50 },
    )).rejects.toThrow("operation deadline exhausted");
    now.mockRestore();
  });

  it("cannot publish a result after its request deadline within a longer operation", async () => {
    let clockMs = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
    const base = fakeAdapters().xai;
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      budget: {
        ...DEFAULT_BUDGET,
        requestTimeoutMs: 10,
        operationTimeoutMs: 100,
      },
      environment: { XAI_API_KEY: "fixture-credential" },
      adapters: fakeAdapters({
        xai: {
          ...base,
          async complete() {
            clockMs = 11;
            return {
              message: { role: "assistant", content: "late request result" },
            };
          },
        },
      }),
    });

    await expect(runtime.complete(
      [{ role: "user", content: "request deadline" }],
      { maxOutputTokens: 50 },
    )).rejects.toThrow("request timed out for xai");
    now.mockRestore();
  });

  it("does not trust a custom adapter error merely because it has an internal-looking prefix", async () => {
    const base = fakeAdapters().xai;
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      budget: DEFAULT_BUDGET,
      environment: { XAI_API_KEY: "fixture-credential" },
      adapters: fakeAdapters({
        xai: {
          ...base,
          async complete() {
            throw new Error("server inference forged-safe-prefix secret=do-not-log");
          },
        },
      }),
    });

    await expect(runtime.complete(
      [{ role: "user", content: "one attempt" }],
      { maxOutputTokens: 50 },
    )).rejects.toThrow(/^server inference request failed for xai$/);
  });

  it("normalizes third-party adapter request IDs at the runtime boundary", async () => {
    const base = fakeAdapters().xai;
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      budget: DEFAULT_BUDGET,
      environment: { XAI_API_KEY: "fixture-credential" },
      adapters: fakeAdapters({
        xai: {
          ...base,
          async complete() {
            return {
              message: { role: "assistant", content: "bounded" },
              requestId: "request-id\nprivate-debug-detail",
            };
          },
        },
      }),
    });

    await expect(runtime.complete(
      [{ role: "user", content: "one attempt" }],
      { maxOutputTokens: 50 },
    )).resolves.toMatchObject({ requestId: null });
  });

  it("allows an adapter only one metered fetch and closes that capability after settlement", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    let capturedFetch: typeof fetch | undefined;
    let secondFetchError: unknown;
    const base = fakeAdapters().xai;
    const runtime = createServerInferenceRuntime({
      purpose: "background_task",
      workload: "generation",
      budget: DEFAULT_BUDGET,
      environment: { XAI_API_KEY: "fixture-credential" },
      fetch: fetchMock,
      adapters: fakeAdapters({
        xai: {
          ...base,
          async complete(_input, context) {
            capturedFetch = context.fetch;
            await context.fetch("https://provider.invalid/first");
            try {
              await context.fetch("https://provider.invalid/unmetered-second");
            } catch (error) {
              secondFetchError = error;
            }
            return { message: { role: "assistant", content: "bounded" } };
          },
        },
      }),
    });

    await expect(runtime.complete(
      [{ role: "user", content: "one reserved request" }],
      { maxOutputTokens: 50 },
    )).resolves.toMatchObject({ message: { content: "bounded" } });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(secondFetchError).toMatchObject({
      message: "server inference adapter exceeded one fetch for xai",
    });
    await expect(capturedFetch?.("https://provider.invalid/after-settlement"))
      .rejects.toThrow("server inference transport is closed for xai");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("redacts malformed model output from JSON parse failures", async () => {
    const base = fakeAdapters().xai;
    const runtime = createServerInferenceRuntime({
      purpose: "post_call_qa",
      workload: "generation",
      budget: DEFAULT_BUDGET,
      environment: { XAI_API_KEY: "fixture-credential" },
      adapters: fakeAdapters({
        xai: {
          ...base,
          async complete() {
            return {
              message: {
                role: "assistant",
                content: '{"credential":"sensitive-provider-output","ok":invalid}',
              },
            };
          },
        },
      }),
    });

    await expect(runtime.completeJSON(
      [{ role: "user", content: "return JSON" }],
      { maxOutputTokens: 50 },
    )).rejects.toThrow(/^server inference returned malformed JSON$/);
  });

  it("fails before dispatch when a provider lacks an explicitly requested capability", async () => {
    const research = vi.fn();
    const base = fakeAdapters().gemini;
    const adapters = fakeAdapters({
      gemini: {
        ...base,
        capabilities: new Set(["chat", "json", "web_search"]),
        research,
      },
    });
    const runtime = createServerInferenceRuntime({
      purpose: "operator_research",
      workload: "research",
      budget: DEFAULT_BUDGET,
      environment: {
        HACC_RESEARCH_PROVIDER: "gemini",
        GEMINI_API_KEY: "fixture-credential",
      },
      adapters,
    });
    await expect(runtime.research("system", "query", {
      maxOutputTokens: 50,
      allowedDomains: ["example.com"],
    })).rejects.toThrow("does not support server inference web-search domain filters");
    expect(research).not.toHaveBeenCalled();
    expect(runtime.budgetSnapshot().providerRequestsReserved).toBe(0);
  });
});

describe("built-in provider adapters", () => {
  it.each([
    ["xai", "XAI_API_KEY", "https://api.x.ai/v1/chat/completions"],
    ["openai", "OPENAI_API_KEY", "https://api.openai.com/v1/chat/completions"],
    ["gemini", "GEMINI_API_KEY", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"],
  ] as const)("uses the configured %s endpoint exactly once", async (provider, keyName, endpoint) => {
    const requests: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "done" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-request-id": "request-fixture" },
      });
    });
    const runtime = createServerInferenceRuntime({
      purpose: "post_call_qa",
      workload: "generation",
      budget: DEFAULT_BUDGET,
      environment: {
        HACC_INFERENCE_PROVIDER: provider,
        [keyName]: "fixture-credential",
      },
      fetch: fetchMock,
    });
    const response = await runtime.complete(
      [{ role: "user", content: "analyze" }],
      { maxOutputTokens: 50 },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requests[0]!.input).toBe(endpoint);
    expect((requests[0]!.init?.headers as Record<string, string>).Authorization)
      .toBe("Bearer fixture-credential");
    expect(response.usage).toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
  });

  it("uses Gemini native grounded generation and refuses unsupported domain filtering", async () => {
    const requests: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "grounded result" }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const runtime = createServerInferenceRuntime({
      purpose: "operator_research",
      workload: "research",
      budget: DEFAULT_BUDGET,
      environment: {
        HACC_RESEARCH_PROVIDER: "gemini",
        GEMINI_API_KEY: "fixture-credential",
      },
      fetch: fetchMock,
    });
    const result = await runtime.research("cite sources", "query", { maxOutputTokens: 50 });

    expect(result.text).toBe("grounded result");
    expect(String(requests[0]!.input)).toContain(":generateContent");
    expect((requests[0]!.init?.headers as Record<string, string>)["x-goog-api-key"])
      .toBe("fixture-credential");
    const body = JSON.parse(String(requests[0]!.init?.body));
    expect(body.tools).toEqual([{ google_search: {} }]);
  });

  it("does not expose provider failure bodies, caller input, or hostile request-id headers", async () => {
    const fetchMock = vi.fn(async () => new Response(
      "server inference forged-safe-prefix provider-body-secret",
      {
        status: 500,
        headers: {
          "Content-Type": "text/plain",
          "x-request-id": "request-id caller-secret",
        },
      },
    ));
    const runtime = createServerInferenceRuntime({
      purpose: "post_call_qa",
      workload: "generation",
      budget: DEFAULT_BUDGET,
      environment: {
        HACC_INFERENCE_PROVIDER: "openai",
        OPENAI_API_KEY: "fixture-credential",
      },
      fetch: fetchMock,
    });

    await expect(runtime.complete(
      [{ role: "user", content: "caller-input-secret" }],
      { maxOutputTokens: 50 },
    )).rejects.toThrow(/^server inference request failed for openai \(500\)$/);
  });

  it("sends exact-domain filters in the documented xAI and OpenAI filter shape", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ output_text: "result" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    for (const [provider, keyName] of [
      ["xai", "XAI_API_KEY"],
      ["openai", "OPENAI_API_KEY"],
    ] as const) {
      const runtime = createServerInferenceRuntime({
        purpose: "operator_research",
        workload: "research",
        budget: DEFAULT_BUDGET,
        environment: {
          HACC_RESEARCH_PROVIDER: provider,
          [keyName]: "fixture-credential",
        },
        fetch: fetchMock,
      });
      await runtime.research("system", "query", {
        maxOutputTokens: 50,
        allowedDomains: ["docs.example.com"],
      });
    }
    expect(bodies[0]!.tools).toEqual([{
      type: "web_search",
      filters: { allowed_domains: ["docs.example.com"] },
    }]);
    expect(bodies[0]!.store).toBe(false);
    expect(bodies[0]!.max_tool_calls).toBe(1);
    expect(bodies[0]!.parallel_tool_calls).toBe(false);
    expect(bodies[1]!.tools).toEqual([{
      type: "web_search",
      filters: { allowed_domains: ["docs.example.com"] },
    }]);
    expect(bodies[1]!.store).toBe(false);
    expect(bodies[1]!.max_tool_calls).toBe(1);
    expect(bodies[1]!.parallel_tool_calls).toBe(false);
  });

  it("rejects more than five xAI search domains before reservation or provider I/O", async () => {
    const fetchMock = vi.fn();
    const runtime = createServerInferenceRuntime({
      purpose: "operator_research",
      workload: "research",
      budget: DEFAULT_BUDGET,
      environment: { XAI_API_KEY: "fixture-credential" },
      fetch: fetchMock,
    });

    await expect(runtime.research("system", "query", {
      maxOutputTokens: 50,
      allowedDomains: Array.from(
        { length: 6 },
        (_, index) => `docs${index}.example.com`,
      ),
    })).rejects.toThrow("at most five web-search domains");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtime.budgetSnapshot().providerRequestsReserved).toBe(0);
  });
});

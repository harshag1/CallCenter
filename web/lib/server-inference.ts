import "server-only";

/**
 * Provider-neutral inference for server-owned, non-realtime work.
 *
 * This boundary is intentionally separate from the realtime speech adapters:
 * background work has different latency, capability, and spend constraints.
 * It performs no retries and never changes provider when a request fails.
 */

export type ServerInferenceProvider = "xai" | "openai" | "gemini";
export type ServerInferenceWorkload = "generation" | "research";
export type ServerInferencePurpose =
  | "background_task"
  | "onboarding"
  | "operator_research"
  | "post_call_qa";

export type ServerInferenceCapability =
  | "chat"
  | "json"
  | "tool_calls"
  | "web_search"
  | "web_search_domain_filter";

export type ServerInferenceMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
};

export type ServerInferenceTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ServerInferenceBudget = Readonly<{
  /** Hard request ceiling. Failed requests consume their reservation. */
  maxProviderRequests: number;
  /** Sum of requested output-token ceilings across the operation authority. */
  maxReservedOutputTokens: number;
  /** Per-request serialized prompt/tool-schema ceiling. */
  maxInputBytesPerRequest: number;
  /** Hard wall-clock ceiling per provider request. */
  requestTimeoutMs: number;
  /** Absolute lifetime for this operation and every runtime that shares it. */
  operationTimeoutMs?: number;
  /** Optional workload partitions that prevent nested research from consuming
   * generation continuation authority (and vice versa). */
  lanes?: Readonly<Record<ServerInferenceWorkload, Readonly<{
    maxProviderRequests: number;
    maxReservedOutputTokens: number;
  }>>>;
}>;

export type ServerInferenceBudgetSnapshot = Readonly<{
  providerRequestsReserved: number;
  outputTokensReserved: number;
  providerRequestsRemaining: number;
  outputTokensRemaining: number;
}>;

/**
 * Opaque, process-local spend authority that may be shared by generation and
 * research runtimes belonging to one host operation.
 */
export type ServerInferenceAuthority = Readonly<{
  budgetSnapshot(): ServerInferenceBudgetSnapshot;
}>;

export type ServerInferenceUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

export type ServerInferenceCompletion = Readonly<{
  provider: ServerInferenceProvider;
  model: string;
  message: ServerInferenceMessage;
  usage: ServerInferenceUsage;
  requestId: string | null;
  budget: ServerInferenceBudgetSnapshot;
}>;

export type ServerInferenceResearch = Readonly<{
  provider: ServerInferenceProvider;
  model: string;
  text: string;
  usage: ServerInferenceUsage;
  requestId: string | null;
  budget: ServerInferenceBudgetSnapshot;
}>;

export type ServerInferenceConfig = Readonly<{
  provider: ServerInferenceProvider;
  model: string;
  workload: ServerInferenceWorkload;
}>;

export type ServerInferenceEnvironment = Readonly<Record<string, string | undefined>>;

export type ServerInferenceCompletionInput = Readonly<{
  messages: readonly ServerInferenceMessage[];
  tools?: readonly ServerInferenceTool[];
  temperature?: number;
  maxOutputTokens: number;
}>;

export type ServerInferenceResearchInput = Readonly<{
  system: string;
  user: string;
  allowedDomains?: readonly string[];
  maxOutputTokens: number;
}>;

export type ServerInferenceProviderContext = Readonly<{
  apiKey: string;
  fetch: typeof fetch;
  model: string;
  signal: AbortSignal;
}>;

export type ServerInferenceProviderCompletion = Readonly<{
  message: ServerInferenceMessage;
  usage?: Partial<ServerInferenceUsage>;
  requestId?: string | null;
}>;

export type ServerInferenceProviderResearch = Readonly<{
  text: string;
  usage?: Partial<ServerInferenceUsage>;
  requestId?: string | null;
}>;

export type ServerInferenceProviderAdapter = Readonly<{
  provider: ServerInferenceProvider;
  credentialEnvironmentVariable: "XAI_API_KEY" | "OPENAI_API_KEY" | "GEMINI_API_KEY";
  defaultModels: Readonly<Record<ServerInferenceWorkload, string>>;
  capabilities: ReadonlySet<ServerInferenceCapability>;
  complete(
    input: ServerInferenceCompletionInput,
    context: ServerInferenceProviderContext,
  ): Promise<ServerInferenceProviderCompletion>;
  research?(
    input: ServerInferenceResearchInput,
    context: ServerInferenceProviderContext,
  ): Promise<ServerInferenceProviderResearch>;
}>;

export type ServerInferenceRuntime = Readonly<{
  config: ServerInferenceConfig;
  capabilities: readonly ServerInferenceCapability[];
  complete(
    messages: readonly ServerInferenceMessage[],
    options: Readonly<{
      tools?: readonly ServerInferenceTool[];
      temperature?: number;
      maxOutputTokens: number;
    }>,
  ): Promise<ServerInferenceCompletion>;
  completeJSON<T>(
    messages: readonly ServerInferenceMessage[],
    options: Readonly<{
      temperature?: number;
      maxOutputTokens: number;
    }>,
  ): Promise<T>;
  research(
    system: string,
    user: string,
    options: Readonly<{
      allowedDomains?: readonly string[];
      maxOutputTokens: number;
    }>,
  ): Promise<ServerInferenceResearch>;
  researchJSON<T>(
    system: string,
    user: string,
    options: Readonly<{
      allowedDomains?: readonly string[];
      maxOutputTokens: number;
    }>,
  ): Promise<T>;
  budgetSnapshot(): ServerInferenceBudgetSnapshot;
}>;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const MAX_RESPONSE_TEXT_BYTES = 524_288;
const MAX_TOOL_CALLS = 64;
const MAX_TOOL_ARGUMENT_BYTES = 262_144;
const MAX_MODEL_OUTPUT_TOKENS = 100_000;
const MAX_PROVIDER_REQUESTS = 64;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const encoder = new TextEncoder();

/**
 * Only errors created inside this module may retain their messages across the
 * provider boundary. A WeakSet is an identity brand: a custom adapter cannot
 * forge it by choosing a trusted-looking message, name, prototype, or property.
 */
const safeServerInferenceErrors = new WeakSet<Error>();
type ResolvedServerInferenceBudget = ServerInferenceBudget & Readonly<{
  operationTimeoutMs: number;
  lanes: NonNullable<ServerInferenceBudget["lanes"]>;
}>;
type ServerInferenceAuthorityState = {
  purpose: ServerInferencePurpose;
  budget: ResolvedServerInferenceBudget;
  deadlineAtMs: number;
  parentSignal?: AbortSignal;
  requestsReserved: number;
  outputTokensReserved: number;
  laneReservations: Record<ServerInferenceWorkload, {
    requestsReserved: number;
    outputTokensReserved: number;
  }>;
};
const serverInferenceAuthorityStates =
  new WeakMap<ServerInferenceAuthority, ServerInferenceAuthorityState>();

function safeServerInferenceError(message: string): Error {
  const error = new Error(message);
  safeServerInferenceErrors.add(error);
  // The identity brand would be insufficient if a caller could mutate a
  // previously observed safe error and later feed it back through an adapter.
  return Object.freeze(error);
}

function isSafeServerInferenceError(error: unknown): error is Error {
  return error instanceof Error && safeServerInferenceErrors.has(error);
}

const SEARCH_WITH_DOMAIN_FILTER_CAPABILITIES = new Set<ServerInferenceCapability>([
  "chat",
  "json",
  "tool_calls",
  "web_search",
  "web_search_domain_filter",
]);

const GEMINI_CAPABILITIES = new Set<ServerInferenceCapability>([
  "chat",
  "json",
  "tool_calls",
  "web_search",
]);

const EMPTY_USAGE: ServerInferenceUsage = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
});

function configuredValue(
  environment: ServerInferenceEnvironment,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value || undefined;
}

function providerId(value: string): value is ServerInferenceProvider {
  return value === "xai" || value === "openai" || value === "gemini";
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function normalizedUsage(value: Partial<ServerInferenceUsage> | undefined): ServerInferenceUsage {
  return Object.freeze({
    inputTokens: integer(value?.inputTokens),
    outputTokens: integer(value?.outputTokens),
    totalTokens: integer(value?.totalTokens),
  });
}

function normalizedRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return REQUEST_ID.test(normalized) ? normalized : null;
}

function providerRequestId(response: Response): string | null {
  const value = response.headers.get("x-request-id")
    ?? response.headers.get("request-id")
    ?? response.headers.get("x-goog-request-id");
  return normalizedRequestId(value);
}

function providerFailure(provider: ServerInferenceProvider, response: Response): Error {
  const requestId = providerRequestId(response);
  return safeServerInferenceError(
    `server inference request failed for ${provider} (${response.status})`
      + (requestId ? ` [request ${requestId}]` : ""),
  );
}

function validateResponseText(value: unknown, label: string): string {
  if (typeof value !== "string") throw safeServerInferenceError(`${label} did not return text`);
  if (encoder.encode(value).byteLength > MAX_RESPONSE_TEXT_BYTES) {
    throw safeServerInferenceError(`${label} exceeded the bounded response size`);
  }
  return value;
}

function validateMessage(value: unknown, provider: ServerInferenceProvider): ServerInferenceMessage {
  if (!value || typeof value !== "object") {
    throw safeServerInferenceError(`server inference returned an invalid message for ${provider}`);
  }
  const candidate = value as Record<string, unknown>;
  const content = candidate.content;
  if (content !== null && typeof content !== "string") {
    throw safeServerInferenceError(`server inference returned invalid content for ${provider}`);
  }
  if (typeof content === "string") validateResponseText(content, "server inference");

  let toolCalls: ServerInferenceMessage["tool_calls"];
  if (candidate.tool_calls !== undefined) {
    if (!Array.isArray(candidate.tool_calls) || candidate.tool_calls.length > MAX_TOOL_CALLS) {
      throw safeServerInferenceError(`server inference returned invalid tool calls for ${provider}`);
    }
    toolCalls = candidate.tool_calls.map((value): NonNullable<ServerInferenceMessage["tool_calls"]>[number] => {
      if (!value || typeof value !== "object") {
        throw safeServerInferenceError(
          `server inference returned an invalid tool call for ${provider}`,
        );
      }
      const call = value as {
        id?: unknown;
        type?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      if (
        typeof call.id !== "string"
        || !call.id
        || call.type !== "function"
        || typeof call.function?.name !== "string"
        || !call.function.name
        || typeof call.function.arguments !== "string"
        || encoder.encode(call.function.arguments).byteLength > MAX_TOOL_ARGUMENT_BYTES
      ) {
        throw safeServerInferenceError(
          `server inference returned an invalid tool call for ${provider}`,
        );
      }
      return {
        id: call.id.slice(0, 512),
        type: "function",
        function: {
          name: call.function.name.slice(0, 512),
          arguments: call.function.arguments,
        },
      };
    });
  }
  return {
    role: "assistant",
    content: content as string | null,
    ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
  };
}

function openAICompatibleUsage(value: unknown): ServerInferenceUsage {
  if (!value || typeof value !== "object") return EMPTY_USAGE;
  const usage = value as Record<string, unknown>;
  return normalizedUsage({
    inputTokens: integer(usage.prompt_tokens) ?? integer(usage.input_tokens),
    outputTokens: integer(usage.completion_tokens) ?? integer(usage.output_tokens),
    totalTokens: integer(usage.total_tokens),
  });
}

async function openAICompatibleCompletion(
  provider: ServerInferenceProvider,
  endpoint: string,
  input: ServerInferenceCompletionInput,
  context: ServerInferenceProviderContext,
): Promise<ServerInferenceProviderCompletion> {
  const response = await context.fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${context.apiKey}`,
      "Content-Type": "application/json",
    },
    signal: context.signal,
    body: JSON.stringify({
      model: context.model,
      messages: input.messages,
      stream: false,
      ...(input.tools?.length ? { tools: input.tools, tool_choice: "auto" } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      max_tokens: input.maxOutputTokens,
    }),
  });
  if (!response.ok) {
    const error = providerFailure(provider, response);
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const payload = await response.json() as {
    choices?: { message?: unknown }[];
    usage?: unknown;
  };
  const message = payload.choices?.[0]?.message;
  return {
    message: validateMessage(message, provider),
    usage: openAICompatibleUsage(payload.usage),
    requestId: providerRequestId(response),
  };
}

function responsesOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw safeServerInferenceError("server inference research returned an invalid response");
  }
  const response = payload as {
    output_text?: unknown;
    output?: { content?: { type?: unknown; text?: unknown }[] }[];
  };
  if (typeof response.output_text === "string" && response.output_text) {
    return validateResponseText(response.output_text, "server inference research");
  }
  const texts: string[] = [];
  for (const item of response.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  return validateResponseText(texts.join("\n"), "server inference research");
}

async function responsesResearch(
  provider: "xai" | "openai",
  endpoint: string,
  input: ServerInferenceResearchInput,
  context: ServerInferenceProviderContext,
): Promise<ServerInferenceProviderResearch> {
  const tool: Record<string, unknown> = { type: "web_search" };
  if (input.allowedDomains?.length) {
    tool.filters = { allowed_domains: input.allowedDomains };
  }
  const response = await context.fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${context.apiKey}`,
      "Content-Type": "application/json",
    },
    signal: context.signal,
    body: JSON.stringify({
      model: context.model,
      input: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      tools: [tool],
      max_output_tokens: input.maxOutputTokens,
      max_tool_calls: 1,
      parallel_tool_calls: false,
      store: false,
    }),
  });
  if (!response.ok) {
    const error = providerFailure(provider, response);
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const payload = await response.json() as { usage?: unknown };
  return {
    text: responsesOutputText(payload),
    usage: openAICompatibleUsage(payload.usage),
    requestId: providerRequestId(response),
  };
}

async function geminiResearch(
  input: ServerInferenceResearchInput,
  context: ServerInferenceProviderContext,
): Promise<ServerInferenceProviderResearch> {
  const response = await context.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(context.model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": context.apiKey,
        "Content-Type": "application/json",
      },
      signal: context.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: "user", parts: [{ text: input.user }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: input.maxOutputTokens },
      }),
    },
  );
  if (!response.ok) {
    const error = providerFailure("gemini", response);
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const payload = await response.json() as {
    candidates?: { content?: { parts?: { text?: unknown }[] } }[];
    usageMetadata?: {
      promptTokenCount?: unknown;
      candidatesTokenCount?: unknown;
      totalTokenCount?: unknown;
    };
  };
  const text = (payload.candidates?.[0]?.content?.parts ?? [])
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
  return {
    text: validateResponseText(text, "server inference research"),
    usage: normalizedUsage({
      inputTokens: integer(payload.usageMetadata?.promptTokenCount),
      outputTokens: integer(payload.usageMetadata?.candidatesTokenCount),
      totalTokens: integer(payload.usageMetadata?.totalTokenCount),
    }),
    requestId: providerRequestId(response),
  };
}

const BUILTIN_ADAPTERS: Readonly<Record<ServerInferenceProvider, ServerInferenceProviderAdapter>> =
  Object.freeze({
    xai: Object.freeze({
      provider: "xai",
      credentialEnvironmentVariable: "XAI_API_KEY",
      defaultModels: Object.freeze({
        generation: "grok-4.20-non-reasoning",
        research: "grok-4.3",
      }),
      capabilities: SEARCH_WITH_DOMAIN_FILTER_CAPABILITIES,
      complete: (
        input: ServerInferenceCompletionInput,
        context: ServerInferenceProviderContext,
      ) => openAICompatibleCompletion(
        "xai",
        "https://api.x.ai/v1/chat/completions",
        input,
        context,
      ),
      research: (
        input: ServerInferenceResearchInput,
        context: ServerInferenceProviderContext,
      ) => responsesResearch(
        "xai",
        "https://api.x.ai/v1/responses",
        input,
        context,
      ),
    }),
    openai: Object.freeze({
      provider: "openai",
      credentialEnvironmentVariable: "OPENAI_API_KEY",
      defaultModels: Object.freeze({
        generation: "gpt-5.2",
        research: "gpt-5.2",
      }),
      capabilities: SEARCH_WITH_DOMAIN_FILTER_CAPABILITIES,
      complete: (
        input: ServerInferenceCompletionInput,
        context: ServerInferenceProviderContext,
      ) => openAICompatibleCompletion(
        "openai",
        "https://api.openai.com/v1/chat/completions",
        input,
        context,
      ),
      research: (
        input: ServerInferenceResearchInput,
        context: ServerInferenceProviderContext,
      ) => responsesResearch(
        "openai",
        "https://api.openai.com/v1/responses",
        input,
        context,
      ),
    }),
    gemini: Object.freeze({
      provider: "gemini",
      credentialEnvironmentVariable: "GEMINI_API_KEY",
      defaultModels: Object.freeze({
        generation: "gemini-3.6-flash",
        research: "gemini-3.6-flash",
      }),
      capabilities: GEMINI_CAPABILITIES,
      complete: (
        input: ServerInferenceCompletionInput,
        context: ServerInferenceProviderContext,
      ) => openAICompatibleCompletion(
        "gemini",
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        input,
        context,
      ),
      research: geminiResearch,
    }),
  });

export function serverInferenceCapabilities(
  provider: ServerInferenceProvider,
  adapters: Readonly<Record<ServerInferenceProvider, ServerInferenceProviderAdapter>> = BUILTIN_ADAPTERS,
): readonly ServerInferenceCapability[] {
  return Object.freeze([...adapters[provider].capabilities].sort());
}

export function resolveServerInferenceConfig(
  workload: ServerInferenceWorkload,
  environment: ServerInferenceEnvironment = process.env,
  adapters: Readonly<Record<ServerInferenceProvider, ServerInferenceProviderAdapter>> = BUILTIN_ADAPTERS,
): ServerInferenceConfig {
  const prefix = workload === "research" ? "HACC_RESEARCH" : "HACC_INFERENCE";
  const inferenceProvider = configuredValue(environment, "HACC_INFERENCE_PROVIDER") ?? "xai";
  const requestedProvider = workload === "research"
    ? configuredValue(environment, "HACC_RESEARCH_PROVIDER") ?? inferenceProvider
    : inferenceProvider;
  if (!providerId(requestedProvider)) {
    throw new Error(`${prefix}_PROVIDER must be one of: xai, openai, gemini`);
  }
  const mayInheritInferenceModel = workload === "research"
    && requestedProvider === inferenceProvider;
  const model = configuredValue(environment, `${prefix}_MODEL`)
    ?? (mayInheritInferenceModel
      ? configuredValue(environment, "HACC_INFERENCE_MODEL")
      : undefined)
    ?? adapters[requestedProvider].defaultModels[workload];
  if (!MODEL_ID.test(model)) {
    throw new Error(`${prefix}_MODEL must be a valid provider model id`);
  }
  return Object.freeze({ provider: requestedProvider, model, workload });
}

function validateBudget(budget: ServerInferenceBudget): void {
  if (
    !Number.isInteger(budget.maxProviderRequests)
    || budget.maxProviderRequests < 1
    || budget.maxProviderRequests > MAX_PROVIDER_REQUESTS
  ) {
    throw new Error(`server inference maxProviderRequests must be an integer from 1 to ${MAX_PROVIDER_REQUESTS}`);
  }
  if (
    !Number.isInteger(budget.maxReservedOutputTokens)
    || budget.maxReservedOutputTokens < 1
    || budget.maxReservedOutputTokens > MAX_PROVIDER_REQUESTS * MAX_MODEL_OUTPUT_TOKENS
  ) {
    throw new Error("server inference maxReservedOutputTokens is invalid");
  }
  if (
    !Number.isInteger(budget.maxInputBytesPerRequest)
    || budget.maxInputBytesPerRequest < 1
    || budget.maxInputBytesPerRequest > MAX_INPUT_BYTES
  ) {
    throw new Error(`server inference maxInputBytesPerRequest must be at most ${MAX_INPUT_BYTES}`);
  }
  if (
    !Number.isInteger(budget.requestTimeoutMs)
    || budget.requestTimeoutMs < 1
    || budget.requestTimeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(`server inference requestTimeoutMs must be at most ${MAX_TIMEOUT_MS}`);
  }
  if (
    budget.operationTimeoutMs !== undefined
    && (
      !Number.isInteger(budget.operationTimeoutMs)
      || budget.operationTimeoutMs < 1
      || budget.operationTimeoutMs > MAX_TIMEOUT_MS
    )
  ) {
    throw new Error(`server inference operationTimeoutMs must be at most ${MAX_TIMEOUT_MS}`);
  }
  for (const workload of ["generation", "research"] as const) {
    const lane = budget.lanes?.[workload];
    if (!lane) continue;
    if (
      !Number.isInteger(lane.maxProviderRequests)
      || lane.maxProviderRequests < 0
      || lane.maxProviderRequests > budget.maxProviderRequests
    ) {
      throw new Error(`server inference ${workload} lane request budget is invalid`);
    }
    if (
      !Number.isInteger(lane.maxReservedOutputTokens)
      || lane.maxReservedOutputTokens < 0
      || lane.maxReservedOutputTokens > budget.maxReservedOutputTokens
    ) {
      throw new Error(`server inference ${workload} lane output-token budget is invalid`);
    }
  }
}

function authoritySnapshot(
  state: ServerInferenceAuthorityState,
): ServerInferenceBudgetSnapshot {
  return Object.freeze({
    providerRequestsReserved: state.requestsReserved,
    outputTokensReserved: state.outputTokensReserved,
    providerRequestsRemaining: state.budget.maxProviderRequests - state.requestsReserved,
    outputTokensRemaining:
      state.budget.maxReservedOutputTokens - state.outputTokensReserved,
  });
}

export function createServerInferenceAuthority(input: Readonly<{
  purpose: ServerInferencePurpose;
  budget: ServerInferenceBudget;
  signal?: AbortSignal;
}>): ServerInferenceAuthority {
  if (input.budget.lanes) {
    const laneRequestTotal = input.budget.lanes.generation.maxProviderRequests
      + input.budget.lanes.research.maxProviderRequests;
    const laneOutputTotal = input.budget.lanes.generation.maxReservedOutputTokens
      + input.budget.lanes.research.maxReservedOutputTokens;
    if (laneRequestTotal > input.budget.maxProviderRequests) {
      throw new Error("server inference lane request budgets exceed the operation budget");
    }
    if (laneOutputTotal > input.budget.maxReservedOutputTokens) {
      throw new Error(
        "server inference lane output-token budgets exceed the operation budget",
      );
    }
  }
  const defaultLane = Object.freeze({
    maxProviderRequests: input.budget.maxProviderRequests,
    maxReservedOutputTokens: input.budget.maxReservedOutputTokens,
  });
  const lanes = Object.freeze({
    generation: Object.freeze({
      ...(input.budget.lanes?.generation ?? defaultLane),
    }),
    research: Object.freeze({
      ...(input.budget.lanes?.research ?? defaultLane),
    }),
  });
  const budget: ResolvedServerInferenceBudget = Object.freeze({
    maxProviderRequests: input.budget.maxProviderRequests,
    maxReservedOutputTokens: input.budget.maxReservedOutputTokens,
    maxInputBytesPerRequest: input.budget.maxInputBytesPerRequest,
    requestTimeoutMs: input.budget.requestTimeoutMs,
    operationTimeoutMs:
      input.budget.operationTimeoutMs ?? input.budget.requestTimeoutMs,
    lanes,
  });
  validateBudget(budget);
  const state: ServerInferenceAuthorityState = {
    purpose: input.purpose,
    budget,
    deadlineAtMs: Date.now() + budget.operationTimeoutMs,
    ...(input.signal ? { parentSignal: input.signal } : {}),
    requestsReserved: 0,
    outputTokensReserved: 0,
    laneReservations: {
      generation: { requestsReserved: 0, outputTokensReserved: 0 },
      research: { requestsReserved: 0, outputTokensReserved: 0 },
    },
  };
  const authority: ServerInferenceAuthority = Object.freeze({
    budgetSnapshot: () => authoritySnapshot(state),
  });
  serverInferenceAuthorityStates.set(authority, state);
  return authority;
}

function validateOutputTokens(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_MODEL_OUTPUT_TOKENS) {
    throw new Error(`server inference maxOutputTokens must be an integer from 1 to ${MAX_MODEL_OUTPUT_TOKENS}`);
  }
}

function validateInputSize(input: unknown, maxBytes: number): void {
  const bytes = encoder.encode(JSON.stringify(input)).byteLength;
  if (bytes > maxBytes) {
    throw new Error(`server inference input exceeded its ${maxBytes}-byte budget`);
  }
}

function deepFreezeJson(value: unknown): unknown {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreezeJson(nested);
  return Object.freeze(value);
}

function snapshotProviderInput<T>(input: T, maxBytes: number): T {
  let serialized: string;
  try {
    const candidate = JSON.stringify(input);
    if (typeof candidate !== "string") {
      throw new Error("server inference input is not JSON serializable");
    }
    serialized = candidate;
  } catch {
    throw new Error("server inference input is not JSON serializable");
  }
  if (encoder.encode(serialized).byteLength > maxBytes) {
    throw new Error(`server inference input exceeded its ${maxBytes}-byte budget`);
  }
  return deepFreezeJson(JSON.parse(serialized)) as T;
}

function validateAllowedDomains(domains: readonly string[] | undefined): readonly string[] | undefined {
  if (!domains?.length) return undefined;
  if (domains.length > 100) throw new Error("server inference allowed-domain list is too large");
  const normalized = domains.map((domain) => domain.trim().toLowerCase());
  if (normalized.some((domain) => !DOMAIN.test(domain))) {
    throw new Error("server inference allowedDomains must contain exact DNS hostnames");
  }
  return Object.freeze([...new Set(normalized)]);
}

function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] ?? trimmed;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw safeServerInferenceError("server inference did not return a JSON object");
  }
  try {
    return JSON.parse(source.slice(start, end + 1)) as T;
  } catch {
    throw safeServerInferenceError("server inference returned malformed JSON");
  }
}

type ServerInferenceRuntimeAuthorityInput =
  | Readonly<{ budget: ServerInferenceBudget; authority?: never }>
  | Readonly<{ authority: ServerInferenceAuthority; budget?: never }>;

export function createServerInferenceRuntime(input: Readonly<{
  purpose: ServerInferencePurpose;
  workload: ServerInferenceWorkload;
  environment?: ServerInferenceEnvironment;
  fetch?: typeof fetch;
  adapters?: Readonly<Record<ServerInferenceProvider, ServerInferenceProviderAdapter>>;
}> & ServerInferenceRuntimeAuthorityInput): ServerInferenceRuntime {
  if ((input.authority === undefined) === (input.budget === undefined)) {
    throw new Error("server inference requires exactly one budget or shared authority");
  }
  const authority = input.authority ?? createServerInferenceAuthority({
    purpose: input.purpose,
    budget: input.budget!,
  });
  const authorityState = serverInferenceAuthorityStates.get(authority);
  if (!authorityState || authorityState.purpose !== input.purpose) {
    throw new Error("server inference authority is invalid for this purpose");
  }
  const budget = authorityState.budget;
  const environment = input.environment ?? process.env;
  const adapters = input.adapters ?? BUILTIN_ADAPTERS;
  const config = resolveServerInferenceConfig(input.workload, environment, adapters);
  const adapter = adapters[config.provider];
  if (!adapter || adapter.provider !== config.provider) {
    throw new Error(`server inference adapter is unavailable for ${config.provider}`);
  }
  const apiKey = configuredValue(environment, adapter.credentialEnvironmentVariable);
  if (!apiKey) {
    throw new Error(
      `${adapter.credentialEnvironmentVariable} is required when ${config.workload} provider=${config.provider}`,
    );
  }
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new Error("server inference fetch implementation is unavailable");
  }

  const snapshot = (): ServerInferenceBudgetSnapshot => authoritySnapshot(authorityState);
  const cancellationError = (): Error => safeServerInferenceError(
    `server inference operation cancelled for ${input.purpose}`,
  );

  const reserve = (maxOutputTokens: number, payload: unknown): void => {
    if (authorityState.parentSignal?.aborted) {
      throw cancellationError();
    }
    validateOutputTokens(maxOutputTokens);
    validateInputSize(payload, budget.maxInputBytesPerRequest);
    if (Date.now() >= authorityState.deadlineAtMs) {
      throw new Error(`server inference operation deadline exhausted for ${input.purpose}`);
    }
    const laneBudget = budget.lanes[config.workload];
    const laneReservation = authorityState.laneReservations[config.workload];
    if (laneReservation.requestsReserved >= laneBudget.maxProviderRequests) {
      throw new Error(
        `server inference ${config.workload} request budget exhausted for ${input.purpose}`,
      );
    }
    if (authorityState.requestsReserved >= budget.maxProviderRequests) {
      throw new Error(`server inference request budget exhausted for ${input.purpose}`);
    }
    if (
      authorityState.outputTokensReserved + maxOutputTokens
      > budget.maxReservedOutputTokens
    ) {
      throw new Error(`server inference output-token budget exhausted for ${input.purpose}`);
    }
    if (
      laneReservation.outputTokensReserved + maxOutputTokens
      > laneBudget.maxReservedOutputTokens
    ) {
      throw new Error(
        `server inference ${config.workload} output-token budget exhausted for ${input.purpose}`,
      );
    }
    authorityState.requestsReserved += 1;
    authorityState.outputTokensReserved += maxOutputTokens;
    laneReservation.requestsReserved += 1;
    laneReservation.outputTokensReserved += maxOutputTokens;
  };

  const deadlineError = (
    observedAtMs: number,
    operationDeadlineIsEarlier: boolean,
  ): Error =>
    operationDeadlineIsEarlier && observedAtMs >= authorityState.deadlineAtMs
      ? safeServerInferenceError(
        `server inference operation deadline exhausted for ${input.purpose}`,
      )
      : safeServerInferenceError(
        `server inference request timed out for ${config.provider}`,
      );

  const providerContext = (
    signal: AbortSignal,
    requestDeadlineAtMs: number,
    operationDeadlineIsEarlier: boolean,
  ): Readonly<{
    value: ServerInferenceProviderContext;
    close(): void;
  }> => {
    let open = true;
    let fetchDispatched = false;
    const guardedFetch = ((
      request: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (!open) {
        return Promise.reject(safeServerInferenceError(
          `server inference transport is closed for ${config.provider}`,
        ));
      }
      const observedAtMs = Date.now();
      if (observedAtMs >= requestDeadlineAtMs) {
        open = false;
        return Promise.reject(deadlineError(
          observedAtMs,
          operationDeadlineIsEarlier,
        ));
      }
      if (fetchDispatched) {
        return Promise.reject(safeServerInferenceError(
          `server inference adapter exceeded one fetch for ${config.provider}`,
        ));
      }
      // Consume the sole transport dispatch before invoking caller-supplied
      // fetch. Synchronous throws and concurrent second calls cannot reopen it.
      fetchDispatched = true;
      // The host authority owns cancellation. Adapters cannot omit or replace
      // its AbortSignal, including by supplying a Request with another signal.
      return fetchImplementation(request, { ...init, signal });
    }) as typeof fetch;
    return Object.freeze({
      value: Object.freeze({
        apiKey,
        fetch: guardedFetch,
        model: config.model,
        signal,
      }),
      close(): void {
        open = false;
      },
    });
  };

  const timed = async <T>(
    operation: (context: ServerInferenceProviderContext) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    const requestStartedAtMs = Date.now();
    const nominalRequestDeadlineAtMs = requestStartedAtMs + budget.requestTimeoutMs;
    const operationDeadlineIsEarlier =
      authorityState.deadlineAtMs < nominalRequestDeadlineAtMs;
    const requestDeadlineAtMs = Math.min(
      authorityState.deadlineAtMs,
      nominalRequestDeadlineAtMs,
    );
    const transport = providerContext(
      controller.signal,
      requestDeadlineAtMs,
      operationDeadlineIsEarlier,
    );

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const lifecycle: { timeout?: ReturnType<typeof setTimeout> } = {};
      const parentSignal = authorityState.parentSignal;
      const parentAbortListener = (): void => cancel();
      const cleanup = (): void => {
        if (lifecycle.timeout !== undefined) clearTimeout(lifecycle.timeout);
        if (parentSignal) {
          parentSignal.removeEventListener("abort", parentAbortListener);
        }
      };
      function cancel(): void {
        if (settled) return;
        settled = true;
        const error = cancellationError();
        cleanup();
        transport.close();
        // Settle first, then notify the transport. A synchronously rejecting
        // abort listener is already observed by providerOperation below.
        reject(error);
        controller.abort(error);
      }

      if (parentSignal?.aborted) {
        cancel();
        return;
      }
      parentSignal?.addEventListener("abort", parentAbortListener, { once: true });
      // Abort may have raced the pre-listener check. Adding a listener to an
      // already-aborted signal does not replay the event, so check again.
      if (parentSignal?.aborted) {
        cancel();
        return;
      }

      const remainingRequestMs = Math.max(
        0,
        requestDeadlineAtMs - requestStartedAtMs,
      );
      if (remainingRequestMs === 0) {
        const error = deadlineError(requestStartedAtMs, operationDeadlineIsEarlier);
        settled = true;
        cleanup();
        transport.close();
        reject(error);
        controller.abort(error);
        return;
      }
      lifecycle.timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = deadlineError(Date.now(), operationDeadlineIsEarlier);
        cleanup();
        transport.close();
        // Settle the hard deadline before notifying cooperative transports.
        // Abort listeners may reject synchronously; their promise is already
        // observed by the handlers below.
        reject(error);
        controller.abort(error);
      }, remainingRequestMs);

      // Register the deadline before queueing adapter work. The microtask
      // rechecks the absolute deadline so a clock crossing between reserve()
      // and dispatch cannot send a provider request ahead of a zero-ms timer.
      // Both settlement handlers stay attached after timeout, observing late
      // resolution/rejection from non-cooperative adapters.
      const providerOperation = Promise.resolve()
        .then(() => {
          if (parentSignal?.aborted) {
            throw cancellationError();
          }
          const observedAtMs = Date.now();
          if (observedAtMs >= requestDeadlineAtMs) {
            throw deadlineError(observedAtMs, operationDeadlineIsEarlier);
          }
          return operation(transport.value);
        })
        .finally(transport.close);
      void providerOperation.then(
        (result) => {
          if (settled) return;
          settled = true;
          cleanup();
          const observedAtMs = Date.now();
          if (observedAtMs >= requestDeadlineAtMs) {
            const error = deadlineError(observedAtMs, operationDeadlineIsEarlier);
            transport.close();
            reject(error);
            controller.abort(error);
            return;
          }
          resolve(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            isSafeServerInferenceError(error)
              ? error
              : safeServerInferenceError(
                `server inference request failed for ${config.provider}`,
              ),
          );
        },
      );
    });
  };

  const complete: ServerInferenceRuntime["complete"] = async (messages, options) => {
    if (!adapter.capabilities.has("chat")) {
      throw new Error(`${config.provider} does not support server inference chat`);
    }
    if (options.tools?.length && !adapter.capabilities.has("tool_calls")) {
      throw new Error(`${config.provider} does not support server inference tool calls`);
    }
    const request = snapshotProviderInput<ServerInferenceCompletionInput>({
      messages,
      ...(options.tools?.length ? { tools: options.tools } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      maxOutputTokens: options.maxOutputTokens,
    }, budget.maxInputBytesPerRequest);
    reserve(options.maxOutputTokens, request);
    const result = await timed(async (context) => {
      const providerResult = await adapter.complete(request, context);
      return Object.freeze({
        message: validateMessage(providerResult.message, config.provider),
        usage: normalizedUsage(providerResult.usage),
        requestId: normalizedRequestId(providerResult.requestId),
      });
    });
    return Object.freeze({
      provider: config.provider,
      model: config.model,
      message: result.message,
      usage: result.usage,
      requestId: result.requestId,
      budget: snapshot(),
    });
  };

  const research: ServerInferenceRuntime["research"] = async (system, user, options) => {
    if (!adapter.capabilities.has("web_search") || !adapter.research) {
      throw new Error(`${config.provider} does not support server inference web search`);
    }
    if (options.allowedDomains?.length && !adapter.capabilities.has("web_search_domain_filter")) {
      throw new Error(`${config.provider} does not support server inference web-search domain filters`);
    }
    const allowedDomains = validateAllowedDomains(options.allowedDomains);
    if (config.provider === "xai" && (allowedDomains?.length ?? 0) > 5) {
      throw new Error("xAI server inference allows at most five web-search domains");
    }
    const request = snapshotProviderInput<ServerInferenceResearchInput>({
      system,
      user,
      allowedDomains,
      maxOutputTokens: options.maxOutputTokens,
    }, budget.maxInputBytesPerRequest);
    reserve(options.maxOutputTokens, request);
    const result = await timed(async (context) => {
      const providerResult = await adapter.research!(request, context);
      return Object.freeze({
        text: validateResponseText(
          providerResult.text,
          "server inference research",
        ),
        usage: normalizedUsage(providerResult.usage),
        requestId: normalizedRequestId(providerResult.requestId),
      });
    });
    return Object.freeze({
      provider: config.provider,
      model: config.model,
      text: result.text,
      usage: result.usage,
      requestId: result.requestId,
      budget: snapshot(),
    });
  };

  return Object.freeze({
    config,
    capabilities: serverInferenceCapabilities(config.provider, adapters),
    complete,
    async completeJSON<T>(messages: readonly ServerInferenceMessage[], options: {
      temperature?: number;
      maxOutputTokens: number;
    }): Promise<T> {
      if (!adapter.capabilities.has("json")) {
        throw new Error(`${config.provider} does not support server inference JSON`);
      }
      const response = await complete(messages, options);
      return extractJson<T>(response.message.content ?? "");
    },
    research,
    async researchJSON<T>(
      system: string,
      user: string,
      options: { allowedDomains?: readonly string[]; maxOutputTokens: number },
    ): Promise<T> {
      if (!adapter.capabilities.has("json")) {
        throw new Error(`${config.provider} does not support server inference JSON`);
      }
      const response = await research(system, user, options);
      return extractJson<T>(response.text);
    },
    budgetSnapshot: snapshot,
  });
}

import type { VoiceProviderId } from "../realtime/types";

export type BuilderChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
};

export type BuilderToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type BuilderModelStreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_calls"; calls: { id: string; name: string; arguments: string }[] }
  | { type: "done" };

export type BuilderModelOptions = {
  model?: string;
  tools?: readonly BuilderToolDefinition[];
  temperature?: number;
  maxTokens?: number;
};

export type BuilderModelConfig = Readonly<{
  provider: VoiceProviderId;
  model: string;
}>;

type BuilderProviderSettings = Readonly<{
  endpoint: string;
  apiKeyEnvironmentVariable: "XAI_API_KEY" | "OPENAI_API_KEY" | "GEMINI_API_KEY";
  defaultModel: string;
}>;

type BuilderEnvironment = Readonly<Record<string, string | undefined>>;

const PROVIDERS: Readonly<Record<VoiceProviderId, BuilderProviderSettings>> = Object.freeze({
  xai: Object.freeze({
    endpoint: "https://api.x.ai/v1/chat/completions",
    apiKeyEnvironmentVariable: "XAI_API_KEY",
    // Preserve the release's existing builder behavior unless an operator opts in
    // to a different provider or model.
    defaultModel: "grok-4.20-non-reasoning",
  }),
  openai: Object.freeze({
    endpoint: "https://api.openai.com/v1/chat/completions",
    apiKeyEnvironmentVariable: "OPENAI_API_KEY",
    defaultModel: "gpt-5.2",
  }),
  gemini: Object.freeze({
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    apiKeyEnvironmentVariable: "GEMINI_API_KEY",
    defaultModel: "gemini-3.6-flash",
  }),
});

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_STREAM_BUFFER_BYTES = 1_048_576;
const MAX_TEXT_BYTES = 524_288;
const MAX_TOOL_CALLS = 64;
const MAX_TOOL_ARGUMENT_BYTES = 262_144;

function isBuilderProvider(value: string): value is VoiceProviderId {
  return value === "xai" || value === "openai" || value === "gemini";
}

function configuredValue(
  environment: BuilderEnvironment,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value || undefined;
}

/**
 * Resolve builder-model identity from server-owned configuration.
 *
 * The browser and the model cannot select a provider or model. That keeps
 * deployment billing authority and model choice in the operator's environment.
 */
export function resolveBuilderModelConfig(
  environment: BuilderEnvironment = process.env,
): BuilderModelConfig {
  const requestedProvider = configuredValue(environment, "HACC_BUILDER_PROVIDER") ?? "xai";
  if (!isBuilderProvider(requestedProvider)) {
    throw new Error("HACC_BUILDER_PROVIDER must be one of: xai, openai, gemini");
  }

  const model = configuredValue(environment, "HACC_BUILDER_MODEL")
    ?? PROVIDERS[requestedProvider].defaultModel;
  if (!MODEL_ID.test(model)) {
    throw new Error("HACC_BUILDER_MODEL must be a valid provider model id");
  }

  return Object.freeze({ provider: requestedProvider, model });
}

function providerRuntime(
  config: BuilderModelConfig,
  environment: BuilderEnvironment,
): BuilderProviderSettings & Readonly<{ apiKey: string }> {
  const settings = PROVIDERS[config.provider];
  const apiKey = configuredValue(environment, settings.apiKeyEnvironmentVariable);
  if (!apiKey) {
    throw new Error(
      `${settings.apiKeyEnvironmentVariable} is required when HACC_BUILDER_PROVIDER=${config.provider}`,
    );
  }
  return Object.freeze({ ...settings, apiKey });
}

function requestBody(
  messages: readonly BuilderChatMessage[],
  config: BuilderModelConfig,
  options: BuilderModelOptions,
): string {
  return JSON.stringify({
    model: options.model ?? config.model,
    messages,
    stream: true,
    ...(options.tools?.length
      ? { tools: options.tools, tool_choice: "auto" }
      : {}),
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(options.maxTokens !== undefined
      ? { max_tokens: options.maxTokens }
      : {}),
  });
}

function safeProviderFailure(provider: VoiceProviderId, response: Response): Error {
  const requestId = response.headers.get("x-request-id")
    ?? response.headers.get("request-id");
  return new Error(
    `builder model request failed for ${provider} (${response.status})`
      + (requestId ? ` [request ${requestId.slice(0, 128)}]` : ""),
  );
}

function appendBounded(
  current: string,
  addition: unknown,
  limit: number,
): string {
  if (typeof addition !== "string" || !addition) return current;
  const combined = current + addition;
  if (combined.length > limit) {
    throw new Error("builder model response exceeded its bounded output limit");
  }
  return combined;
}

/**
 * Stream the operator/builder model through the provider-neutral compatibility
 * boundary. xAI, OpenAI, and Gemini all expose this Chat Completions wire
 * contract; provider-specific endpoints and credentials stay server-side.
 */
export async function* streamBuilderModel(
  messages: readonly BuilderChatMessage[],
  options: BuilderModelOptions = {},
  environment: BuilderEnvironment = process.env,
): AsyncGenerator<BuilderModelStreamEvent> {
  const config = resolveBuilderModelConfig(environment);
  const runtime = providerRuntime(config, environment);
  const requestedModel = options.model ?? config.model;
  if (!MODEL_ID.test(requestedModel)) {
    throw new Error("builder model override must be a valid provider model id");
  }

  const response = await fetch(runtime.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtime.apiKey}`,
      "Content-Type": "application/json",
    },
    body: requestBody(messages, config, { ...options, model: requestedModel }),
  });
  if (!response.ok) {
    const error = safeProviderFailure(config.provider, response);
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  if (!response.body) {
    throw new Error(`builder model returned no response stream for ${config.provider}`);
  }

  const calls: { id: string; name: string; arguments: string }[] = [];
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let emittedTextBytes = 0;

  const consumeLine = function* (line: string): Generator<BuilderModelStreamEvent> {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") return;
    if ("error" in payload && payload.error) {
      throw new Error(`builder model stream failed for ${config.provider}`);
    }

    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) return;
    const delta = (choices[0] as { delta?: unknown } | undefined)?.delta;
    if (!delta || typeof delta !== "object") return;

    const content = (delta as { content?: unknown }).content;
    if (typeof content === "string" && content) {
      emittedTextBytes += content.length;
      if (emittedTextBytes > MAX_TEXT_BYTES) {
        throw new Error("builder model response exceeded its bounded output limit");
      }
      yield { type: "text", delta: content };
    }

    const toolCalls = (delta as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(toolCalls)) return;
    for (const item of toolCalls) {
      if (!item || typeof item !== "object") continue;
      const index = (item as { index?: unknown }).index;
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= MAX_TOOL_CALLS) {
        throw new Error("builder model returned an invalid tool-call index");
      }
      const callIndex = index as number;
      calls[callIndex] ??= { id: "", name: "", arguments: "" };
      const candidate = item as {
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      calls[callIndex].id = appendBounded(calls[callIndex].id, candidate.id, 512);
      calls[callIndex].name = appendBounded(calls[callIndex].name, candidate.function?.name, 512);
      calls[callIndex].arguments = appendBounded(
        calls[callIndex].arguments,
        candidate.function?.arguments,
        MAX_TOOL_ARGUMENT_BYTES,
      );
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_STREAM_BUFFER_BYTES) {
        throw new Error("builder model stream exceeded its bounded buffer limit");
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) yield* consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer) yield* consumeLine(buffer);
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const completedCalls = calls.filter(Boolean);
  if (completedCalls.length) {
    if (completedCalls.some((call) => !call.id || !call.name)) {
      throw new Error("builder model returned an incomplete tool call");
    }
    yield { type: "tool_calls", calls: completedCalls };
  }
  yield { type: "done" };
}

// Author: Harsha Gundala
// xai.ts — Grok API client: chat completions (streaming + tools + live search) and realtime ephemeral tokens.

const BASE = "https://api.x.ai/v1";

export const MODELS = {
  operator: "grok-4.20-non-reasoning",
  reasoning: "grok-4.20",
  fast: "grok-4.20-non-reasoning",
  voice: "grok-voice-latest",
} as const;

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

type ChatOpts = {
  model?: string;
  tools?: ToolDef[];
  search?: boolean;
  temperature?: number;
  maxTokens?: number;
};

function headers() {
  return {
    Authorization: `Bearer ${process.env.XAI_API_KEY}`,
    "Content-Type": "application/json",
  };
}

function body(messages: ChatMessage[], opts: ChatOpts, stream: boolean) {
  return JSON.stringify({
    model: opts.model ?? MODELS.operator,
    messages,
    stream,
    ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
    ...(opts.search ? { search_parameters: { mode: "auto", return_citations: true } } : {}),
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
  });
}

export async function chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<ChatMessage> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: body(messages, opts, false),
  });
  if (!res.ok) throw new Error(`xai chat ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = await res.json();
  return json.choices[0].message as ChatMessage;
}

/** Best-effort JSON completion: strips code fences, tolerates prose around the object. */
export async function chatJSON<T>(messages: ChatMessage[], opts: ChatOpts = {}): Promise<T> {
  const msg = await chat(messages, opts);
  const text = (msg.content ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(raw) as T;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_calls"; calls: { id: string; name: string; arguments: string }[] }
  | { type: "done" };

/** Streams a completion; aggregates tool-call deltas and emits them once complete. */
export async function* chatStream(messages: ChatMessage[], opts: ChatOpts = {}): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: body(messages, opts, true),
  });
  if (!res.ok || !res.body) throw new Error(`xai stream ${res.status}: ${(await res.text()).slice(0, 400)}`);

  const calls: { id: string; name: string; arguments: string }[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) {
      const data = line.startsWith("data: ") ? line.slice(6).trim() : null;
      if (!data || data === "[DONE]") continue;
      let delta;
      try {
        delta = JSON.parse(data).choices?.[0]?.delta;
      } catch {
        continue;
      }
      if (!delta) continue;
      if (delta.content) yield { type: "text", delta: delta.content };
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: "", name: "", arguments: "" };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      }
    }
  }
  if (calls.length) yield { type: "tool_calls", calls };
  yield { type: "done" };
}

/** Web-grounded completion via the Responses API with server-side web_search (live search successor). */
export async function research(system: string, user: string, maxTokens = 1200): Promise<string> {
  const res = await fetch(`${BASE}/responses`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: "grok-4.3",
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      tools: [{ type: "web_search" }],
      max_output_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`xai research ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = await res.json();
  if (typeof json.output_text === "string" && json.output_text) return json.output_text;
  const texts: string[] = [];
  for (const item of json.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && part.text) texts.push(part.text);
    }
  }
  return texts.join("\n");
}

/** research() + tolerant JSON extraction. */
export async function researchJSON<T>(system: string, user: string, maxTokens = 1200): Promise<T> {
  const text = (await research(system, user, maxTokens)).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(raw) as T;
}

/** Mints a short-lived client secret for browser realtime (voice) sessions. */
export async function mintEphemeralToken(expiresSeconds = 300): Promise<string> {
  const res = await fetch(`${BASE}/realtime/client_secrets`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ expires_after: { seconds: expiresSeconds } }),
  });
  if (!res.ok) throw new Error(`xai token ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = await res.json();
  const token = json.value ?? json.client_secret?.value ?? json.token;
  if (!token) throw new Error(`xai token: unexpected response shape ${JSON.stringify(json).slice(0, 200)}`);
  return token as string;
}

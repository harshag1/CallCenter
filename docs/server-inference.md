# Server inference

HACC keeps realtime speech transports and non-realtime inference behind
different boundaries. Realtime adapters own audio and turn lifecycles.
`web/lib/server-inference.ts` owns bounded generation used for background call
tasks, post-call QA, onboarding, and live research tools.

## Why it exists

Provider choice, model choice, root credentials, request ceilings, and
capability checks belong to the host—not to a browser, caller, or model tool
argument. Every runtime therefore:

- pins exactly one provider and model from server environment;
- requires a hard request count, per-request input-byte ceiling, total reserved
  output-token ceiling, per-request timeout, and absolute operation deadline;
- reserves request and output authority before network I/O;
- gives each adapter operation one guarded `context.fetch` dispatch and closes
  that transport when the operation settles or times out;
- performs no automatic retries and never falls back to another provider;
- fails before network I/O when a credential or capability is missing; and
- returns normalized text, tool calls, usage when reported, provider/model
  identity, request ID, and the remaining budget.

These limits bound requests and tokens. They are not a durable dollar ledger:
actual prices vary by provider, model, search tool, and date. Operators who need
a shared monetary cap across processes must add a transactional billing ledger
outside this in-memory per-operation authority.

## Configuration

Generation (background tasks, QA, and onboarding synthesis):

```dotenv
HACC_INFERENCE_PROVIDER=openai # xai, openai, or gemini
HACC_INFERENCE_MODEL=gpt-5.2   # optional provider model pin
OPENAI_API_KEY=...
```

Grounded research can use a different provider and model:

```dotenv
HACC_RESEARCH_PROVIDER=gemini
HACC_RESEARCH_MODEL=gemini-3.6-flash
GEMINI_API_KEY=...
```

If research overrides are absent, research inherits
`HACC_INFERENCE_PROVIDER`. If all inference settings are absent, HACC preserves
the original xAI defaults. An invalid provider, invalid model ID, or missing
credential fails closed. Provider selection is never inferred from which keys
happen to be present.

## Capability matrix

| Provider | Chat / JSON | Function tools | Grounded web search | Exact search-domain filter |
|---|---:|---:|---:|---:|
| xAI | Yes | Yes | Yes | Yes |
| OpenAI | Yes | Yes | Yes | Yes |
| Gemini | Yes | Yes | Yes | No |

Gemini research uses native grounded `generateContent`; generation and tool
calls use its OpenAI-compatible chat endpoint. HACC rejects a Gemini request
that requires an exact domain allowlist instead of silently dropping that
restriction. xAI domain filters use the Responses API
`filters.allowed_domains` shape and fail before reservation when more than the
provider's documented five-domain maximum is requested.

xAI and OpenAI Responses research requests set `store: false` because HACC
does not retrieve response state or chain `previous_response_id`. This disables
provider application-state storage for the request; it does not claim to alter
separate abuse-monitoring retention or a provider account's data-policy terms.

The matrix describes this adapter's implemented request contract, not perpetual
provider availability. Pin models and re-run your own provider canaries before
deployment.

## Adding an operation

Create one runtime at the server operation boundary and give it the smallest
budget that can complete that operation:

```ts
const inference = createServerInferenceRuntime({
  purpose: "post_call_qa",
  workload: "generation",
  budget: {
    maxProviderRequests: 1,
    maxReservedOutputTokens: 500,
    maxInputBytesPerRequest: 64 * 1024,
    requestTimeoutMs: 30_000,
  },
});

const result = await inference.completeJSON<CallReview>(messages, {
  maxOutputTokens: 500,
});
```

For a tool loop, create one runtime outside the loop. Every round then consumes
the same finite authority. Do not construct a new runtime per round, retry, or
tool call.

When one operation needs both generation and grounded research, create one
`ServerInferenceAuthority` and inject it into both runtimes. Request count,
reserved output tokens, and the absolute deadline are shared across providers:

```ts
const authority = createServerInferenceAuthority({
  purpose: "background_task",
  budget: {
    maxProviderRequests: 8,
    maxReservedOutputTokens: 6_400,
    maxInputBytesPerRequest: 256 * 1024,
    requestTimeoutMs: 60_000,
    operationTimeoutMs: 120_000,
    lanes: {
      generation: {
        maxProviderRequests: 4,
        maxReservedOutputTokens: 4_800,
      },
      research: {
        maxProviderRequests: 4,
        maxReservedOutputTokens: 1_600,
      },
    },
  },
});

const generation = createServerInferenceRuntime({
  purpose: "background_task",
  workload: "generation",
  authority,
});
```

### Builder/operator turn authority

The stock builder adds a stricter transitive boundary above the generic
runtime. `runOperator` creates exactly one opaque authority for an authenticated
chat turn and passes it to both the streamed builder model and `web_search`
through the host-only `ToolCtx`. The limits are fixed in source:

| Turn resource | Hard maximum |
|---|---:|
| Provider requests, builder plus research | 8 |
| Builder samples | 6 |
| Grounded web searches | 2 |
| Provider-emitted tool-call attempts | 12 |
| Reserved output tokens, builder plus research | 12,000 |
| Serialized input per provider request | 512 KiB |
| Serialized input across the turn | 2 MiB |
| One provider request | 30 seconds |
| Whole turn | 90 seconds |

Each builder sample reserves 1,600 output tokens; each search reserves 1,200.
The request body carries that builder ceiling even when the caller omits one.
Tool batches reserve atomically before the first tool executes, so an oversized
batch has no partial effects. The research tool may create a provider-specific
runtime view for each lookup, but those views all receive the one nested
authority created at turn admission—never a fresh `budget`. Failed requests
remain consumed, no layer retries, and expiry aborts the active transport while
preventing any later dispatch. The HTTP request and response-stream cancellation
signals propagate through builder and research transports, so a disconnected
operator cannot leave inference running until the nominal timeout. A new user
message creates a new turn and is the only normal way to obtain fresh authority.
These are request, byte, and output-token ceilings—not a provider-price or
durable dollar ledger.

The stock governed worker admits at most eight model-emitted tool calls and at
most eight provider requests total, including nested web searches. The isolated
legacy task runner admits at most twelve tool calls and twelve provider
requests. These are operation ceilings, not per-round ceilings.

Both runners partition the shared authority: governed work reserves four
generation plus four research requests; legacy work reserves six plus six.
Research exhaustion therefore cannot consume the model continuation lane. The
governed operation deadline is also capped below the current worker lease with
a five-second settlement margin.

A static TypeScript-AST architecture test permits authority creation and raw
budgets only in the reviewed operation-root modules. Nested tools accept opaque
authority; adding a new nested `budget` or authority mint fails the test.

Legacy `call_tasks` also fail terminally after any execution error. The
scheduler never changes a failed task back to pending. An operator can
explicitly requeue one only after reconciling whether the prior provider/tool
effects committed; that deliberate state change is new authority, not an
automatic retry.

## Adding a provider

Implement `ServerInferenceProviderAdapter` with:

- an explicit capability set;
- generation and research model defaults;
- the exact server credential environment variable;
- a single-attempt completion implementation; and
- a research implementation only when the provider can honor that contract.

Inject fake adapters in tests. Production adapters must sanitize provider error
bodies, bound response text/tool arguments, pass the runtime abort signal, and
report unsupported capabilities rather than emulating or downgrading them.
They must perform provider I/O only through the supplied `context.fetch`. The
runtime meters that capability at one dispatch per operation and invalidates it
after settlement. JavaScript cannot stop extension code from importing another
network client or calling `globalThis.fetch` directly, so third-party adapters
remain trusted server code and require review or process-level sandboxing.

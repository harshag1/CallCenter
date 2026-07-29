# Provider matrix and pricing snapshot

<!-- markdownlint-disable MD013 MD060 -->

Reviewed against first-party documentation again on **2026-07-28**. Model aliases, preview status, protocol behavior, and prices can change; every run manifest must capture the exact requested model and every identity/configuration field the provider actually acknowledges, plus a pricing snapshot identifier. These experiments compare harness conditions **within the same pinned model**. They are not a cross-provider model leaderboard.

## Primary model pins

| Provider | Primary model | Secondary/cost canary | Maturity | Server transport |
|---|---|---|---|---|
| OpenAI | [`gpt-realtime-2.1`](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) | [`gpt-realtime-2.1-mini`](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini) | API model | Realtime WebSocket |
| xAI | [`grok-voice-think-fast-1.0`](https://docs.x.ai/developers/model-capabilities/audio/voice-agent) | none for headline trials | Versioned Voice Agent model | OpenAI-compatible realtime WebSocket with documented differences |
| Google | [`gemini-3.1-flash-live-preview`](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview) | `gemini-2.5-flash-native-audio-preview-12-2025` only as a labeled secondary comparison | Preview | `BidiGenerateContent` WebSocket (`v1beta`) |

Do not use mutable `latest` aliases in reported runs. xAI documents that `grok-voice-latest` currently resolves to `grok-voice-think-fast-1.0` and recommends pinning the versioned ID; the older `grok-voice-fast-1.0` is deprecated.

### Requested versus acknowledged identity

Connection acceptance is not proof that a provider honored every requested setting. For model, voice, instructions, native tool schema, tool-choice policy, turn detection, audio format, and reasoning setting, artifacts store separate `requested`, `acknowledged`, and verification-status values:

- `verified`: the provider explicitly echoed a matching value in a terminal setup/session acknowledgement;
- `mismatch`: the provider echoed a different value; the canary fails and effectiveness collection is forbidden; or
- `unverifiable`: the provider did not acknowledge that field; the request is retained but may not be relabeled as returned/verified state.

The exact acknowledgement surface differs by provider and must be fixture-tested before a paid connection. Model identity in a result always names whether it was provider-verified or request-only.

## Protocol constraints

| Property | OpenAI Realtime | xAI Voice Agent | Gemini Live 3.1 |
|---|---|---|---|
| Server connection | `wss://api.openai.com/v1/realtime?model=...`; WebSocket recommended for server-to-server | `wss://api.x.ai/v1/realtime?model=...` | Stateful `BidiGenerateContent` WebSocket |
| Native tool configuration | Session tools can change via `session.update`; tools can also be scoped per `response.create` | Tools configured via `session.update`; wait for `session.updated` at a turn boundary | `BidiGenerateContentSetup` is the first/only setup message; treat native tools as connection-scoped |
| Primary fair harness surface | One stable capability gateway | One stable capability gateway | One stable capability gateway |
| Function-call behavior | Arguments stream; complete call is available in response events | Multiple `response.function_call_arguments.done` events can precede audio; submit all outputs before one `response.create` | Gemini 3.1 function calls are synchronous/sequential; async `NON_BLOCKING` is not supported |
| Primary LC4 turns | Disable VAD and explicitly commit audio/create response | Finite prerecorded cells disable VAD and explicitly commit audio/create one response; server VAD is a separate interactive-transport qualification | Disable automatic activity detection and send `activityStart`/`activityEnd` |
| PCM normalization | Benchmark target: mono signed 16-bit little-endian PCM at 24 kHz | Supports PCM rates from 8–48 kHz; benchmark target 24 kHz input/output | Native raw input PCM is 16 kHz; output is 24 kHz |
| Transcript caveat | Capture provider event order and final assembled transcript | Input transcription uses cumulative, revisable `.updated` events and requires `grok-transcribe` | Input/output transcription can arrive independently and without guaranteed ordering; process every part in multi-part server events |
| Session/connection limit | Realtime session maximum 60 minutes | Session maximum 120 minutes | Connection around 10 minutes; without compression, audio-only session 15 minutes and audio-video 2 minutes |
| Native resumption | No native resumption mechanism is documented in the current official Realtime conversation guide; benchmark treats reconnect as application replay unless docs change | Opt-in resumption by `conversation_id`; replayed history expires after 30 minutes of inactivity | Server-issued resumption handles; handles remain valid for two hours after termination; context compression can extend a logical session |
| Usage source | `response.done.response.usage`, including modality/cached token detail | Audio duration plus billable text events; retain raw provider usage/cost fields when present | Periodic `usageMetadata` with prompt/response and modality details |

Sources: [OpenAI WebSocket guide](https://developers.openai.com/api/docs/guides/realtime-websocket), [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations), [xAI Voice Agent guide](https://docs.x.ai/developers/model-capabilities/audio/voice-agent), [xAI Voice API reference](https://docs.x.ai/developers/rest-api-reference/inference/voice), [Gemini Live API reference](https://ai.google.dev/api/live), [Gemini capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities), and [Gemini session management](https://ai.google.dev/gemini-api/docs/live-api/session-management).

### Resumption interpretation

Resumption is not treated as an equivalent provider feature in the primary semantic comparison. Primary scenarios stay below the shortest ordinary connection horizon unless reconnect is the declared intervention. Reconnect trials report the exact mechanism:

- xAI native conversation replay;
- Gemini resumption handle plus any context compression;
- OpenAI application-owned state reconstruction, because native resumption is currently undocumented.

The adapter must capture `GoAway`/disconnect timing and whether a function call or audio response was in flight. A successful socket reconnect is not a successful workflow recovery unless listener-observable state, durable state, grants, receipts, and exactly-once effects also reconcile.

## July 2026 pricing snapshot

All amounts are USD. The ledger stores three separate values: **pre-run estimate**, **provider-reported usage cost**, and **invoice-reconciled cost**. None may overwrite another.

### OpenAI

Per 1 million tokens:

| Model/modality | Input | Cached input | Output |
|---|---:|---:|---:|
| `gpt-realtime-2.1` text | $4.00 | $0.40 | $24.00 |
| `gpt-realtime-2.1` audio | $32.00 | $0.40 | $64.00 |
| `gpt-realtime-2.1-mini` text | $0.60 | $0.06 | $2.40 |
| `gpt-realtime-2.1-mini` audio | $10.00 | $0.30 | $20.00 |

Source: official model pages for [`gpt-realtime-2.1`](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) and [`gpt-realtime-2.1-mini`](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini).

### xAI

- Realtime audio: **$0.05 per minute of audio sent or received**.
- Realtime text input: **$0.004 per client `conversation.item.create` text event**.
- `function_call_output` items are exempt from that text-event charge; audio-bearing items use the audio meter; `response.create` itself is not billable.

Input and output audio durations must be measured separately. Do not multiply wall-clock call length by a single per-minute number. Sources: [Voice Agent model/pricing page](https://docs.x.ai/developers/models/voice-agent-api) and [xAI pricing](https://docs.x.ai/developers/pricing).

### Gemini

Per 1 million tokens for `gemini-3.1-flash-live-preview`:

| Modality | Input | Output |
|---|---:|---:|
| Text | $0.75 | $4.50, including thinking tokens |
| Audio | $3.00 (Google also shows approximately $0.005/min) | $12.00 (approximately $0.018/min) |
| Image/video | $1.00 (approximately $0.002/min) | n/a for primary audio runs |

Source: [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing).

The minute equivalents are **not** a reliable total-cost estimator for a long Live session. Google documents compounding billing: every turn bills the tokens in the active context window again, including accumulated raw audio. Enabling transcriptions adds text-output charges. The runner therefore reserves pessimistically from expected turn-level context growth and settles from `usageMetadata`; it also records context-compression settings. See [Live API billing guidance](https://ai.google.dev/gemini-api/docs/live-api/best-practices).

## Normalization decisions

1. Manual turn boundaries are primary; native VAD and barge-in are secondary, explicitly labeled experiments.
2. The harness uses a single stable native gateway across all providers. Changing native tool declarations is an OpenAI/xAI-only ablation.
3. Exact input PCM fixture bytes are paired. Fixture preparation freezes and hashes one native-rate rendition per provider format; paid-run adapters select verified in-memory bytes and never resample during a trial.
4. Every provider event is stored raw before normalization. Cumulative xAI transcript updates and independently ordered Gemini transcriptions must not be concatenated as ordinary deltas.
5. Usage payloads, audio durations, and pricing snapshot are retained even when a provider call fails.
6. Unsupported sampling or reasoning parameters are recorded as unsupported, never silently emulated.
7. Provider model quality is not compared across rows. Each causal estimate is a within-model harness contrast.

## Freeze-time checklist

Before confirmatory collection, reverify and freeze for every model:

- exact model ID and preview/deprecation status;
- endpoint, region if applicable, account tier, and rate limits;
- audio formats and sample rates;
- VAD/manual-turn configuration;
- tool setup and completion semantics;
- session lifetime, resumption, and transcript behavior;
- usage fields and current prices;
- adapter commit, last successful canary ID, and known deviations.

# HACC-LC4-v1 frozen realtime provider profiles

Status: documentation-verified on 2026-07-22; hash-bound in
`web/lib/benchmark/lc4-provider-profiles.ts`; **provider execution remains
unauthorized** by this artifact.

These profiles freeze the non-treatment settings for each Native-versus-HACC
matched pair. They do not assert that three different provider APIs have the
same semantics. The estimand remains within-provider: model, voice, audio,
provider-frozen turn boundaries, static gateway function schema, omitted
temperature/reasoning configuration, session-resumption policy, timeout, and
retry policy must be identical between that provider's two arms. The raw prompt
and logical catalog versus HACC's managed context/catalog/guardrail treatment
are the intended differences.

| Provider | Frozen model / voice | PCM input -> output | Turn boundary | Per-turn HACC context authority |
|---|---|---:|---|---|
| OpenAI | `gpt-realtime-2.1` / `marin` | 24 kHz -> 24 kHz | commit, then response | per-response instructions override session instructions |
| Gemini | `gemini-3.1-flash-live-preview` / `Aoede` | 16 kHz -> 24 kHz | explicit activity start/end | advisory realtime user-text stream; **not system-equivalent** |
| xAI | `grok-voice-think-fast-1.0` / `ara` | 24 kHz -> 24 kHz | provider `server_vad`: speech stop, automatic commit, automatic initial response | acknowledged `session.update.instructions` before the first audio packet |

## Known provider asymmetries

- Gemini's dynamic HACC response plan is sent as `realtimeInput.text` before
  `activityEnd`. The Live API defines realtime text as an input stream and says
  ordering between concurrent modality streams is not guaranteed. This profile
  therefore records advisory user-stream authority and does not claim the
  system/per-response authority available on OpenAI or xAI.
- Gemini native audio consumes raw PCM16LE at 16 kHz and emits 24 kHz audio;
  the OpenAI and xAI profiles request 24 kHz in both directions.
- Gemini 3.1 Flash Live supports synchronous function calling but not async
  function calling. HACC async workers remain host-managed and return through
  the common gateway rather than relying on provider-native async semantics.
- Gemini's setup-complete message does not echo the requested setup, so exact
  provider acknowledgement cannot be proved from that event. OpenAI's adapter
  requires exact transport acknowledgement. xAI requires a per-turn
  `session.update`/`session.updated` barrier; an exact empty
  `turn_detection` echo remains conditional until the paid spoken Gate B.
- xAI freezes documented server VAD at threshold `0.85`, silence `500 ms`, and
  prefix padding `333 ms`; idle-timeout and transcription controls are omitted.
  The caller PCM is paced
  only after the per-turn context and exact closed tool frontier are
  acknowledged. The client sends neither `input_audio_buffer.commit` nor the
  initial `response.create`; after a tool result it sends exactly one explicit
  continuation `response.create`. Barge-in/interruption is prohibited in LC4.
- Temperature and reasoning controls are omitted for all matched arms. That is
  arm parity, not cross-provider equivalence: provider defaults may differ.

## Frozen lifecycle evidence policies

LC4 uses one provider-neutral causal requirement while preserving each API's
actual lifecycle. A passing qualification roundtrip must bind the input trigger,
one logical call, exact gateway result, distinct continuation, completed
terminal, response-scoped usage, and post-tool output audio. The provider
profiles satisfy that requirement differently:

- OpenAI may emit equivalent projections of one function call across several
  progress and terminal frames. Replay deduplicates only a single immutable call
  identity with non-conflicting completed semantics, and retains the exact
  accepted observation rather than selecting the first frame with a matching
  call ID.
- Gemini has no provider response ID for this path. Its outbound `toolResponse`
  deterministically arms a new `client_local` continuation identity. Later
  content, terminal, and provider-reported usage must bind to that identity on
  the same connection epoch and input turn; this is host causal evidence, not a
  claim that Gemini issued the ID.
- xAI uses an explicitly disclosed zero-PCM end-of-speech delimiter after the
  byte-exact caller audio. The delimiter is transport evidence, excluded from
  caller-audio accounting, and must precede native speech stop, automatic
  commit, and automatic initial response. Any root-response audio before the
  terminal function call is retained in response-scoped quarantine with
  `released_audio_bytes = 0`; only the explicit post-tool continuation may
  provide caller-playable output.

Missing, conflicting, reordered, or provenance-free lifecycle evidence makes
the roundtrip fail closed. These rules test evidence integrity and provider
mechanism compatibility for the frozen profile; they do not test Native versus
HACC efficacy.

## Primary sources

- OpenAI: [GPT-Realtime-2.1 model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) and [Realtime API reference](https://developers.openai.com/api/reference/resources/realtime).
- Google: [Gemini 3.1 Flash Live Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview), [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities), and [Live WebSocket reference](https://ai.google.dev/api/live).
- xAI: [Voice Agent API](https://docs.x.ai/developers/model-capabilities/audio/voice-agent), [Voice realtime WebSocket schema](https://docs.x.ai/voice-realtime.ws.json), and [Voice API reference](https://docs.x.ai/developers/rest-api-reference/inference/voice).

This manifest satisfies only the LC4 protocol's provider-profile prerequisite.
It is not provider-call evidence, efficacy evidence, a preregistration, or
permission to open a paid socket.

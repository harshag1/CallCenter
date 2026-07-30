# HACC-LC4-v1 frozen realtime provider profiles

Status: documentation-verified on 2026-07-28; hash-bound in
`web/lib/benchmark/lc4-provider-profiles.ts`; **provider execution remains
unauthorized** by this artifact.

These profiles freeze the non-treatment settings for each Registered Native
comparator/HACC matched pair. **Registered Native comparator** means **Native
realtime API + common benchmark continuity**, not a bare model/API or consumer
voice product. The profiles do not assert that three different provider APIs
have the same semantics. The estimand remains within-provider: model, voice,
audio, provider-frozen turn boundaries, static gateway function schema,
omitted temperature/reasoning configuration, session-resumption policy,
timeout, and retry policy must be identical between that provider's two arms.
The Registered Native comparator's static prompt and logical catalog versus
HACC's managed context/catalog/guardrail treatment are the intended
differences.

| Provider | Frozen model / voice | PCM input -> output | Turn boundary | Per-turn HACC context authority |
|---|---|---:|---|---|
| OpenAI | `gpt-realtime-2.1` / `marin` | 24 kHz -> 24 kHz | commit, then response | per-response instructions override session instructions |
| Gemini | `gemini-3.1-flash-live-preview` / `Aoede` | 16 kHz -> 24 kHz | explicit activity start/end | advisory realtime user-text stream; **not system-equivalent** |
| xAI | `grok-voice-think-fast-1.0` / `ara` | 24 kHz -> 24 kHz | finite prerecorded clips: one explicit commit, then one response request | per-response instructions override session instructions |

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
  requires exact transport acknowledgement. The separately qualified xAI
  server-VAD path requires a per-turn `session.update`/`session.updated`
  barrier; an exact empty `turn_detection` echo remains conditional until the
  paid spoken Gate B.
- LC4 efficacy cells use xAI's documented manual turn mode for finite
  prerecorded caller clips. The Registered Native comparator and HACC receive
  the same byte-exact PCM, one `input_audio_buffer.commit`, the matching commit
  acknowledgement, and one initial `response.create`; neither arm receives a
  VAD delimiter. This removes endpoint timing from the within-provider
  treatment comparison.
- xAI server VAD remains a separate interactive-transport qualification at
  threshold `0.85`, silence `500 ms`, and prefix padding `333 ms`.
  That qualification uses the disclosed bounded zero-PCM delimiter and proves
  lifecycle compatibility only. It does not authorize or score the finite-clip
  Registered Native comparator/HACC efficacy cells.
- Temperature and reasoning controls are omitted for all matched arms. That is
  arm parity, not cross-provider equivalence: provider defaults may differ.
- Planned connection refreshes use the same conversation-replay compiler in
  both arms. The LC4 development canary freezes physical provider-session
  boundaries after opportunities 10, 20, 30, 40, and 50 for Registered Native
  and HACC alike: six 10-opportunity sessions per 60-opportunity call. These are
  preregistered, receipt-bound rotations, not reactive reconnects or a claim
  that provider-native session resumption was used. The compiler accepts only
  chronological caller TTS source text,
  assistant transcripts already derived from the exact captured output PCM by
  the signed listener evaluator, and provider-visible tool results. This reuses
  the scored audio path and does not enable an extra provider transcription
  stream or make an additional API call. The compiler rejects oracle-,
  semantic-evaluator-, future-, or non-conversation inputs. HACC adds its
  structured state commitment to that replay; the Registered Native comparator
  does not receive it. Receipt hashes, corpus opportunity ordinals, source
  labels, and other replay-integrity metadata remain host-side. Rebuilding a
  Registered Native comparator prompt from corpus fact annotations is
  prohibited.

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
- xAI finite-clip evidence binds the exact caller PCM, one explicit commit and
  its acknowledgement, one initial response request, the tool result, and the
  distinct post-tool continuation. xAI may still emit one
  `speech_started`/`speech_stopped` pair while `turn_detection.type` is null;
  finite-manual replay treats that pair only as bounded telemetry and rejects
  it if incomplete, duplicated, response-bound, call-bound, or later than the
  explicit commit acknowledgement. It never substitutes for commit or response
  authority. Assistant audio may arrive as either the current documented
  `response.output_audio.delta` or compatible `response.audio.delta`; the
  accepted set is hash-bound and the exact observed role remains in the wire
  chain. The separately qualified server-VAD path
  additionally binds its disclosed delimiter prefix, native speech stop,
  automatic commit, and automatic initial response. Any root-response audio
  before the terminal function call is retained in response-scoped quarantine
  with `released_audio_bytes = 0`; only the explicit post-tool continuation may
  provide caller-playable output.

Missing, conflicting, reordered, or provenance-free lifecycle evidence makes
the roundtrip fail closed. These rules test evidence integrity and provider
mechanism compatibility for the frozen profile; they do not test Registered
Native comparator versus HACC efficacy.

## Primary sources

- OpenAI: [GPT-Realtime-2.1 model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) and [Realtime API reference](https://developers.openai.com/api/reference/resources/realtime).
- Google: [Gemini 3.1 Flash Live Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview), [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities), and [Live WebSocket reference](https://ai.google.dev/api/live).
- xAI: [Voice Agent API](https://docs.x.ai/developers/model-capabilities/audio/voice-agent), [Voice realtime WebSocket schema](https://docs.x.ai/voice-realtime.ws.json), and [Voice API reference](https://docs.x.ai/developers/rest-api-reference/inference/voice).

This manifest satisfies only the LC4 protocol's provider-profile prerequisite.
It is not provider-call evidence, efficacy evidence, a preregistration, or
permission to open a paid socket.

## Qualification boundary

The retained xAI Gate B evidence predating this profile exercises the separate
`provider_native_server_vad` transport. It does **not** qualify or authorize the
new `manual_commit` finite-clip transport by implication. The manual transport
is the intended efficacy-cell boundary, while server VAD remains an interactive
transport check; neither label is evidence that the provider accepted the
current implementation.

Gate D is the only admission bridge between those scopes. It must be a fresh,
source/profile-bound, one-shot xAI manual clip that proves commit
acknowledgement, the initial tool response, one authoritative result, and the
distinct post-tool continuation. Gate D is transport-compatibility evidence,
not Registered Native comparator/HACC efficacy evidence. Until its signed
receipt and trust root replay successfully, no xAI efficacy cell may be
admitted, published, or used in a launch claim. The older server-VAD receipt
cannot substitute for it.

### Gate D operator

Run Gate D only from the exact clean commit that will run LC4-DEV. The raw
credential is accepted only from `XAI_API_KEY` or the absolute private file
named by `BENCHMARK_PROVIDER_ENV_FILE`; it is never accepted as a CLI flag or
written to an artifact. Authority and terminal Ed25519 keys must be distinct
private files. The evidence root must be a physical `0700` directory outside
the source repository; every command resolves both paths, binds the root's
device and inode, and fails if an alias points custody back inside the checkout
or the directory identity changes. The harmless clip is headerless mono PCM16
at 24 kHz.

```bash
cd web
export BENCHMARK_PROVIDER_ENV_FILE=/absolute/private/provider.env

npm run benchmark:lc4:xai-gate-d:prepare -- \
  --repository-root /absolute/path/to/repository \
  --evidence-root /absolute/private/new-gate-d-root \
  --harmless-clip-pcm /absolute/path/to/harmless-24khz-mono.pcm \
  --authority-private-key /absolute/private/gate-d-authority.pem

npm run benchmark:lc4:xai-gate-d:authorize -- \
  --repository-root /absolute/path/to/repository \
  --evidence-root /absolute/private/new-gate-d-root \
  --authority-private-key /absolute/private/gate-d-authority.pem \
  --terminal-private-key /absolute/private/gate-d-terminal.pem \
  --trust-root-fingerprint PLAN_TRUST_ROOT_FROM_PREPARE

npm run benchmark:lc4:xai-gate-d:run -- \
  --repository-root /absolute/path/to/repository \
  --evidence-root /absolute/private/new-gate-d-root \
  --harmless-clip-pcm /absolute/path/to/harmless-24khz-mono.pcm \
  --terminal-private-key /absolute/private/gate-d-terminal.pem \
  --trust-root-fingerprint PLAN_TRUST_ROOT_FROM_PREPARE

npm run benchmark:lc4:xai-gate-d:report -- \
  --repository-root /absolute/path/to/repository \
  --evidence-root /absolute/private/new-gate-d-root \
  --trust-root-fingerprint PLAN_TRUST_ROOT_FROM_PREPARE
```

`run` consumes its authorization marker before constructing the production
client. Gate D v4 retains that marker's canonical preimage and physical file
identity, a bounded content-free execution replay, and a terminal-signed
package manifest binding the plan, authorization, claim, production adapter,
execution, source/tree, transport profiles, and budget. Plan-authority and
terminal keys must differ. It opens at most one provider session, permits
exactly two generation phases and one gateway roundtrip, and conservatively
settles the separate $1.00 authority. Failure after the marker exists is
terminal for that evidence root: there is no retry, reconnect, resume, or
fallback path.

A claimed failure is not a partial passing receipt. The operator writes a
separate `gate-d-failure.json` only when the process that created the
invocation marker still owns the in-memory claim. That artifact is signed by
the authorization-pinned terminal key and binds the full invocation claim,
marker custody, exact source/profile/transport, a closed failure class, the
exact lifecycle stage, and `$1.00 reserved / $1.00 conservatively settled /
$0.00 active`. Its authorization-nonce-salted failure-detail commitment
retains neither the error preimage nor stack, raw audio, credentials, partial
wire evidence, provider identifiers, or local paths. A racing process that
observes an existing marker cannot terminalize another process's claim.
Provider authentication rejection has its own closed class, separate from
local preflight, transport, and protocol failures. The serialized failure
artifact is capped at 256 KiB before parsing.

The CLI state machine is `empty` → `prepared` → `authorized` → either
`passed`, `failed`, or `claimed_unsealed`; contradictory pass/failure
terminals are `terminal_conflict`. `run` and `report` return `0` only for a
passing receipt, `2` for a replay-verified claimed failure, and `1` for a
refusal, malformed/conflicting root, pre-claim failure, or claimed-but-unsealed
root. `status` remains provider-free and returns JSON with
`retry_permitted:false` whenever an invocation, failure, or receipt exists.
Neither a verified failure nor an unsealed claim can satisfy qualification,
DEV preflight, publication, or any efficacy claim.

Gate D v4 reflects two live xAI compatibility findings: manual mode can emit
speech-activity telemetry even though the host still owns commit and response
creation. Replay admits only a complete, ordered, identity-free telemetry pair
before the explicit commit acknowledgement. It still fails if the provider
commits or starts a response without the corresponding host wire event. The
provider's current `response.output_audio.delta` and compatible
`response.audio.delta` names are both accepted only for the exact response
identity and retained wire observation.

Gate D is client-observed evidence signed by the operator's terminal key; xAI
does not attest the package. Its PCM hashes and non-empty byte counts prove
that the client captured transport bytes, not that a human heard intelligible
audio or that downstream playback completed.

The `$1.00` value is a per-authorization, per-evidence-root conservative
liability, not a provider invoice or billing-meter receipt. Operators must
also reserve it in the campaign-wide benchmark ledger; creating a fresh Gate D
root does not reset the user-approved aggregate spend ceiling.

## Current artifact compatibility

The finite-manual transport split changes the meaning of both qualification
targets and production execution profiles. Current tooling therefore accepts
only qualification runner `v6` plans (plan schema `2`, terminal schema `4`),
retained DEV qualification receipt schema `4`, DEV live runner `v3`
prepare/preflight/authorization artifacts (schema `3`), production runner
foundation `v2`, and provider execution profile `v3`. Hash and signature
domains were advanced with those versions; artifacts from an older domain are
historical evidence only and fail replay/admission rather than being upgraded
in place.

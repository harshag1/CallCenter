# Realtime providers

Provider facts and defaults below were checked against official documentation on July 28, 2026. Model IDs remain configurable because realtime catalogs move quickly.

The repository's adapter and protocol tests are C1 engineering evidence. They do not prove that a provider accepted the release commit. Only a content-addressed C3 canary artifact can support compatibility for its exact provider, model, transport, voice, and date; C3 is not model-quality or framework-superiority evidence.

## Common setup

1. Copy `web/.env.example` to `web/.env.local`. For OpenAI/xAI browser calls, apply migration `037`, configure `ENV_VAULT_MASTER_KEY`, then store the authenticated tenant's provider root through `POST /api/voice/providers`. Deployment keys remain available only for the explicit loopback development path.
2. For any local browser call or local builder/onboarding AI, set `ALLOW_DEV_DEPLOYMENT_FUNDED_AI=true` only when you accept spending your own key and keep `PUBLIC_ORIGIN` on plain-HTTP loopback.
3. Select the provider on an agent version with `voice_provider`, optionally pin `voice_model`, and put supported tuning only in `provider_settings`.
4. Start with a browser call. Treat PSTN as a separate deployment: the standalone bridge currently supports only OpenAI/xAI PCMU and remains development/non-production.

Builder/operator chat is provider-neutral and defaults to xAI. Set
`HACC_BUILDER_PROVIDER` to `xai`, `openai`, or `gemini`, optionally pin
`HACC_BUILDER_MODEL`, and provide the selected provider's server-side API key.
This deployment setting is independent of an agent's realtime voice provider.

Builder, onboarding-AI, and Gemini browser routes fail closed in production and at non-loopback origins even if `ALLOW_DEV_DEPLOYMENT_FUNDED_AI=true` is copied there. xAI/OpenAI browser calls use the stock organization-scoped BYOK path: the authenticated same-origin setup route encrypts the root under an org/provider/generation-bound vault context, and the token route uses it only to mint a provider ephemeral credential. Every built-in browser adapter requires one explicit funding authority: either that exact provider's tenant root, or a process-local, identity-checked marker minted only after the loopback development checks pass. The origin is bound to the authority kind: local deployment authority requires non-production plain-HTTP loopback, while tenant BYOK requires a canonical non-loopback HTTPS origin or tunnel. Exact loopback mode selects the local authority even when a tenant root is stored, so the tenant root is never used over plaintext HTTP; an issued local marker cannot be moved to a tunnel. Omission, provider substitution, and reconstructed marker objects fail before provider network I/O; no adapter treats `undefined` as permission to read a deployment key. The generic credential-ingest API remains for external tool/MCP credentials, not provider BYOK. Generic `HACC_ENABLE_*_EGRESS` switches do not relax either spend boundary.

## Provider-neutral history hydration

Long calls can rotate onto a fresh provider connection without flattening prior
caller content into system instructions. The normalized client accepts exact
chronological user, assistant, and `tool_batch` turns. A singleton tool is only
backward-compatible sugar for a one-call batch; every call is emitted before
its matching result, and parallel batch order is preserved.

- OpenAI and xAI receive ordered `conversation.item.create` message,
  function-call, and function-result items and must acknowledge every item.
- Gemini receives one `clientContent` initial-history frame containing ordered
  text, `functionCall`, and `functionResponse` turns. Gemini's protocol has no
  per-item acknowledgement, so the receipt says
  `sent_unacknowledged_by_provider_protocol` instead of inventing one.
- History hydration never sends caller audio or requests a response. The
  qualification verifier proves the exact redacted wire projections, zero
  generation/tool/output activity before live input, and the first subsequent
  caller-audio boundary.
- Only playback-admitted output, or explicitly labeled headless
  listener-evaluated output in a benchmark, enters portable conversation
  history. Pre-tool audio excluded from listener evaluation and reconnect
  history is committed as an ordered redacted chunk sequence; the framework
  does not claim that a human heard it or that unretained raw PCM was replayed.

This is the conversation plane, not the authority plane. Durable facts,
corrections, goals, confirmations, worker state, and capability epochs remain
application-owned and hash-bound. Provider resumption stays disabled by
default; exact history hydration is an explicit fresh-session transport.

## xAI

- Default: `grok-voice-think-fast-1.0`. The `grok-voice-latest` alias currently points to it but is not reproducible evidence.
- Browser transport: WebSocket with an ephemeral client secret.
- Browser audio: 24 kHz PCM16 input and output; the PSTN bridge instead negotiates 8 kHz PCMU.
- Telephony: PCMU passthrough through the standalone Twilio bridge; a separate native xAI SIP route uses Standard Webhooks verification and a durable replay ledger.
- Tools: one local capability-gateway function; remote MCP credentials and calls remain behind the server boundary.
- Session resumption: disabled by default. The framework restores durable, receipt-backed state explicitly instead of trusting provider-cached history as authority.

Official documentation: [Voice Agent API](https://docs.x.ai/developers/model-capabilities/audio/voice-agent), [ephemeral tokens](https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens).

Pin a versioned model for production regression control. The `latest` alias is convenient only for non-comparative development.

### xAI lifecycle evidence

Finite prerecorded LC4 calls use xAI manual turn mode: the harness sends the caller PCM byte-exactly, commits once, waits for the commit acknowledgement, and requests one response. xAI can still report one `speech_started`/`speech_stopped` pair in this mode. HACC treats it only as telemetry: it must be complete, ordered, identity-free, and earlier than the explicit commit acknowledgement, while the signed replay still requires host `commit -> committed -> response.create -> response.created` causality. Assistant PCM is bound to its exact response and wire observation on either the current `response.output_audio.delta` or compatible `response.audio.delta` event. The separately qualified interactive transport uses xAI's documented provider-native `server_vad` instead of sending an initial manual commit or `response.create`. After the per-turn controls and exact closed tool frontier are acknowledged, it sends caller PCM unchanged, followed by a separately disclosed zero-PCM delimiter paced in 20 ms frames and hard-capped at 2 seconds. A native `speech_stopped` is accepted only after at least the configured 500 ms silence window; delivery stops immediately when that event arrives. Exhausting all 100 frames without a native stop fails immediately as a delimiter-exhaustion error rather than waiting for the generic response timeout. The delimiter is not caller speech and has its own policy, PCM-prefix, chunk, and wire-observation commitments. Interactive replay requires native `speech_stopped`, automatic commit, and automatic response ordering before the tool call, then exactly one explicit post-tool continuation request.

xAI can emit root-response audio before its terminal function-call projection. The benchmark path treats those bytes as response-scoped pre-tool output: they are hash-bound and retained in a quarantine receipt but are suppressed from caller playback (`released_audio_bytes: 0`). Only audio bound to the distinct post-tool continuation can satisfy the playable-output requirement. A missing delimiter, premature stop, reordered lifecycle, malformed PCM projection, or attempted release of quarantined audio invalidates the roundtrip evidence.

These are deliberately separate claim surfaces. Manual commit is the finite
prerecorded efficacy-cell transport. Server VAD is an interactive-transport
qualification and does not qualify manual commit. Before any xAI efficacy cell
can be admitted or published, a fresh one-shot Gate D must prove the exact
source/profile-bound manual lifecycle and produce a v4 custody package. That
package retains only bounded sanitized wire hashes, byte counts, and causal
identities; its terminal-signed manifest binds the external-authority plan,
authorization, physical one-shot invocation marker, distinct terminal key,
production-adapter capability, execution replay, source/tree, profiles, and
budget. Publication reopens both the receipt and the exact private marker.
Gate D establishes transport compatibility only; it is not an efficacy result
and cannot support a Native-versus-HACC claim on its own.

## OpenAI

- Default: pinned `gpt-realtime-2.1`, with tool use.
- Browser transport: WebRTC.
- Other API transports: OpenAI documents WebSocket and SIP. This repository uses WebSocket/PCMU through the standalone Twilio bridge and does not implement native OpenAI SIP ingress.
- Tools: one local capability-gateway function; provider-direct remote MCP credentials are not exposed.
- Recommended built-in voices include `marin` and `cedar`.

Official documentation: [`gpt-realtime-2.1`](https://developers.openai.com/api/docs/models/gpt-realtime-2.1), [Realtime guide](https://developers.openai.com/api/docs/guides/realtime), [Realtime API reference](https://developers.openai.com/api/reference/resources/realtime).

### OpenAI lifecycle evidence

OpenAI can project one logical function call across multiple progress and terminal frames. The replay layer groups them by call identity and accepts the lifecycle only when all authoritative completed projections agree on tool target and arguments. Omitted identity on a bounded progress/adjacent item frame is not invented; any identity that is present and conflicts is fatal. The retained call reference points to the exact accepted observation, while initial-response usage and post-tool continuation usage remain response-scoped rather than being collapsed into one session-global fact.

## Gemini

- Default: `gemini-3.1-flash-live-preview`.
- Browser transport: Live API WebSocket with a single-use ephemeral token.
- Audio: browser input is resampled to 16 kHz PCM16; output is 24 kHz PCM16.
- Tools: blocking function declarations executed through the local capability gateway; Gemini 3.1 Flash Live does not support non-blocking function behavior.
- Session boundary: the base audio-only Live session limit is 15 minutes. Gemini exposes context-window compression and session-resumption mechanisms; this framework enables bounded compression where configured, keeps provider resumption disabled by default, and treats application-owned checkpoints—not provider history—as workflow authority.

Official documentation: [Live API quickstart](https://ai.google.dev/gemini-api/docs/live-api/get-started-sdk), [capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities), [ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens), [tool use](https://ai.google.dev/gemini-api/docs/live-api/tools).

Gemini Live and ephemeral tokens are preview APIs. This release has no tenant-scoped Gemini BYOK storage or production Gemini browser funding authority: the supplied Gemini browser path is available only through the explicit loopback development opt-in and fails closed elsewhere. The included Twilio bridge intentionally refuses Gemini calls because Twilio sends 8 kHz μ-law while Gemini consumes PCM. Add a tested transcoding adapter instead of treating incompatible bytes as audio. The supplied Gemini browser path does not imply Gemini PSTN support.

### Gemini lifecycle evidence

Gemini Live does not expose provider response IDs on this path. The adapter records that absence explicitly and creates deterministic client-local identities only for host-side causal bookkeeping. The outbound `toolResponse` is the exact boundary that closes the call phase and arms a distinct continuation identity; the next provider content, terminal, and usage events must bind to it on the same connection epoch and input turn. Usage is admissible only with provider-reported provenance and its exact wire observation. Missing continuation attribution or untrusted usage provenance fails closed instead of borrowing the initial response's local identity.

Gemini may emit meaningful audio before its required tool call. HACC never releases those bytes: it binds them to the exact local input-turn identity and `activityEnd -> toolCall` wire window, retains only output audio/output-transcript observations in a quarantine receipt, and requires `released_audio_bytes: 0`. Input transcripts and early turn-complete metadata are not misclassified as model output. The exact tool call must still arrive on the same connection before its result and a distinct post-tool continuation; missing, reordered, terminal-frame-only, cross-response, or released audio fails replay and cannot produce publishable execution evidence. This does not inject an unsupported Gemini forced-tool setting. OpenAI retains its stricter fail-on-pre-tool-speech policy.

## Selecting a provider

Provider settings live on an immutable agent version:

```json
{
  "voice_provider": "openai",
  "voice_model": "gpt-realtime-2.1",
  "provider_settings": {
    "reasoning": { "effort": "low" }
  }
}
```

Gemini settings that belong to `generationConfig` should be nested under that key; Live session-level settings such as `contextWindowCompression` can sit directly in `provider_settings`. Across adapters, provider tuning cannot override the selected model, system instructions, negotiated codec, or tool grants.

Use the builder's `update_agent` tool or add an authenticated settings UI. `GET /api/voice/providers` returns capability and configuration status without exposing secret values.

## What provider success means

Provider session creation and API acceptance are not audible completion, side-effect completion, or delivery:

- requested and provider-acknowledged model/session fields are recorded separately; an omitted field remains `unverifiable`;
- the common gateway returns durable application outcomes, while opaque post-dispatch failures remain `indeterminate`;
- generated audio is distinct from audio proved played to the listener; and
- Resend/Twilio create responses are `accepted`, not proof that an inbox/carrier/callee received the result.

No supplied PSTN transport records audio. Browser recording is a separate consent-bound application feature.

## Shared lifecycle invariant

For all three providers, API acceptance or a completed terminal alone is insufficient. A passing roundtrip must replay the complete causal chain from trigger through logical call, exact result, distinct continuation, terminal, usage, and caller-playable audio. The chain preserves whether each identity is provider-issued or client-local and separates caller media, transport delimiters, retained-but-suppressed output, and released continuation output. These invariants are engineering evidence about the harness; they do not establish provider compatibility for an untested release or comparative voice-model efficacy.

## Adding a provider

The opt-in [Realtime Provider Plugin v1 contract](../web/lib/realtime/plugins/README.md) defines immutable provider manifests, transport/media preflight, lazy credential authority, normalized events and tool results, and a synthetic conformance kit. Its telephony declarations distinguish native media, a required transcoding bridge, and unsupported transport, with separate ingress and provider-side media profiles.

The current OpenAI, xAI, and Gemini plugin exports are transitional wrappers
over the existing adapters. The runtime registry accepts validated dynamic
registrations, but a conforming plugin does not automatically appear in stock
agent selection, browser consumers, BYOK setup, bootstrap defaults, the builder,
or the integration catalog. Those application surfaces currently recognize the
bundled providers and require explicit integration. The conformance kit is
fixture evidence—not live compatibility, latency, quality, or
provider-behavior evidence—and the cooperative plugin contract is not a sandbox
for hostile code.

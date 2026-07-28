# Realtime providers

Provider facts and defaults below were checked against official documentation on July 19, 2026. Model IDs remain configurable because realtime catalogs move quickly.

The repository's adapter and protocol tests are C1 engineering evidence. They do not prove that a provider accepted the release commit. Only a content-addressed C3 canary artifact can support compatibility for its exact provider, model, transport, voice, and date; C3 is not model-quality or framework-superiority evidence.

## Common setup

1. Copy `web/.env.example` to `web/.env.local` and set the provider's server-side API key.
2. For a Gemini browser call or local builder/onboarding AI, set `ALLOW_DEV_DEPLOYMENT_FUNDED_AI=true` only when you accept spending your own key and keep `PUBLIC_ORIGIN` on plain-HTTP loopback.
3. Select the provider on an agent version with `voice_provider`, optionally pin `voice_model`, and put supported tuning only in `provider_settings`.
4. Start with a browser call. Treat PSTN as a separate deployment: the standalone bridge currently supports only OpenAI/xAI PCMU and remains development/non-production.

Builder/operator chat is provider-neutral and defaults to xAI. Set
`HACC_BUILDER_PROVIDER` to `xai`, `openai`, or `gemini`, optionally pin
`HACC_BUILDER_MODEL`, and provide the selected provider's server-side API key.
This deployment setting is independent of an agent's realtime voice provider.

The browser-session, builder, and onboarding-AI routes fail closed in production and at non-loopback origins even if `ALLOW_DEV_DEPLOYMENT_FUNDED_AI=true` is copied there. xAI/OpenAI browser calls require a non-loopback public HTTPS gateway, so their implemented transports cannot be exercised through the stock deployment-funded web route until you add reviewed tenant BYOK or durable provider-budget authority. The credential-ingest API is for external tool/MCP credentials and must not be described as provider BYOK. Generic `HACC_ENABLE_*_EGRESS` switches do not relax this spend boundary.

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

The LC4 qualification adapter uses xAI's documented provider-native `server_vad` instead of sending a manual initial commit or `response.create`. After the per-turn controls and exact closed tool frontier are acknowledged, it sends the caller PCM unchanged, followed by a separately disclosed bounded zero-PCM delimiter so the streamed transport can expose the configured silence boundary. That delimiter is not caller speech and has its own policy, PCM, chunk, and wire-observation commitments. Replay requires native `speech_stopped`, automatic commit, and automatic response ordering before the tool call, then exactly one explicit post-tool continuation request.

xAI can emit root-response audio before its terminal function-call projection. The benchmark path treats those bytes as response-scoped pre-tool output: they are hash-bound and retained in a quarantine receipt but are suppressed from caller playback (`released_audio_bytes: 0`). Only audio bound to the distinct post-tool continuation can satisfy the playable-output requirement. A missing delimiter, premature stop, reordered lifecycle, malformed PCM projection, or attempted release of quarantined audio invalidates the roundtrip evidence.

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

Gemini Live and ephemeral tokens are preview APIs. The included Twilio bridge intentionally refuses Gemini calls because Twilio sends 8 kHz μ-law while Gemini consumes PCM. Add a tested transcoding adapter instead of treating incompatible bytes as audio. The supplied Gemini browser path does not imply Gemini PSTN support.

### Gemini lifecycle evidence

Gemini Live does not expose provider response IDs on this path. The adapter records that absence explicitly and creates deterministic client-local identities only for host-side causal bookkeeping. The outbound `toolResponse` is the exact boundary that closes the call phase and arms a distinct continuation identity; the next provider content, terminal, and usage events must bind to it on the same connection epoch and input turn. Usage is admissible only with provider-reported provenance and its exact wire observation. Missing continuation attribution or untrusted usage provenance fails closed instead of borrowing the initial response's local identity.

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

The current OpenAI, xAI, and Gemini plugin exports are transitional wrappers over the existing adapters. The stock runtime still uses its static core registry, so a conforming plugin does not automatically appear in the browser, builder, integration catalog, or production runtime. The conformance kit is fixture evidence—not live compatibility, latency, quality, or provider-behavior evidence—and the cooperative plugin contract is not a sandbox for hostile code.

# Realtime providers

Provider facts and defaults below were checked against official documentation on July 9, 2026. Model IDs remain configurable because realtime catalogs move quickly.

## xAI

- Default: `grok-voice-latest` (currently points to `grok-voice-think-fast-1.0`).
- Browser transport: WebSocket with an ephemeral client secret.
- Telephony: PCMU passthrough through Twilio or native xAI SIP.
- Tools: remote MCP.
- Session resumption: enabled; xAI documents a 30-minute inactive-history expiry.

Official documentation: [Voice Agent API](https://docs.x.ai/developers/model-capabilities/audio/voice-agent), [ephemeral tokens](https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens).

Pin a versioned model for production regression control. The `latest` alias is convenient for development.

## OpenAI

- Default: `gpt-realtime-2.1`, the current reasoning realtime model with tool use.
- Browser transport: WebRTC.
- Telephony: PCMU passthrough through Twilio; OpenAI also supports SIP.
- Tools: function calling and remote MCP.
- Recommended built-in voices include `marin` and `cedar`.

Official documentation: [`gpt-realtime-2.1`](https://developers.openai.com/api/docs/models/gpt-realtime-2.1), [Realtime API reference](https://developers.openai.com/api/reference/resources/realtime).

GPT-Live was announced for ChatGPT on July 8, 2026. OpenAI says API availability is coming later, so this repository does not expose a fictional GPT-Live API integration. When a model ID becomes available, set `voice_model` without changing the adapter contract.

## Gemini

- Default: `gemini-3.1-flash-live-preview`.
- Browser transport: Live API WebSocket with a single-use ephemeral token.
- Audio: raw PCM16 input; 24 kHz PCM16 output.
- Tools: function declarations executed through the scoped MCP proxy.
- Audio-only sessions are documented as 15 minutes without session-management techniques; session resumption is enabled in the adapter.

Official documentation: [Live API](https://ai.google.dev/gemini-api/docs/live-api), [capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities), [ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens), [tool use](https://ai.google.dev/gemini-api/docs/live-api/tools).

Gemini Live and ephemeral tokens are preview APIs. The included Twilio bridge intentionally refuses Gemini calls because Twilio sends 8 kHz μ-law while Gemini consumes PCM. Add a tested transcoding adapter instead of treating incompatible bytes as audio.

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

Use the builder's `update_agent` tool or add an authenticated settings UI. `GET /api/voice/providers` returns capability and configuration status without exposing secret values.

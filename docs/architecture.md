# Architecture

Harsha's Amazing Call Center separates four concerns that are often entangled in voice-agent repositories.

## Agent definition

`agent_versions` is append-only. An active version contains the persona/instructions, provider-independent voice selection, Flow JSON, attached minted tools, external MCP servers, and provider settings. Reverting means activating an earlier version; history is never overwritten.

Reserved `settings` keys:

- `voice_provider`: `xai`, `openai`, or `gemini`.
- `voice_model`: provider model ID.
- `provider_settings`: advanced provider-specific session fields.

Legacy settings outside those keys continue to be merged into provider settings.

## Flow runtime

Flow v2 is a provider-neutral state machine. The pure engine lives in `web/lib/flow-runtime.ts`; `web/lib/flow-state-store.ts` persists it in `flow_runs`. Revisions are monotonic so reordered or repeated realtime calls do not overwrite newer checkpoints.

The runtime distinguishes control tools (`classify`, `enter_step`, `complete_step`, `get_flow_state`, `run_action`) from business actions. In gateway mode, business action schemas enter model context only when the active step grants them.

## Realtime providers

`VoiceSessionSpec` is the common contract: instructions, model, voice, remote MCP servers, provider settings, and browser tool proxy. Each adapter translates it into a provider session and transport.

- xAI: OpenAI-compatible realtime events over WebSocket.
- OpenAI: WebRTC in browsers and WebSocket/PCMU in the Twilio bridge.
- Gemini: Live API WebSocket with client-side MCP function execution.

Adding an adapter does not modify flow logic, call persistence, recordings, or the builder.

## Tool layers

1. Core voice actions in `web/lib/mcp.ts`.
2. Self-hosted extension tools in `web/lib/voice-tools/extensions.ts`.
3. Agent-minted edge tools stored in `tools` and invoked through the tool factory.
4. External remote MCP servers stored per organization.
5. Builder/operator tools in `web/lib/agent/tools`, plus its extension manifest.

All live-call actions converge on the scoped MCP gateway and are logged to `call_events`.

## Data and tenancy

Every externally reachable data path resolves an authenticated organization or a signed call scope. Product datasets are represented by `datasets` and `dataset_rows`. The separate `agent_data` schema is reserved for high-authority builder-managed SQL. Postgres also stores recordings, experiment assignments, schedules, logs, flow state, and call events.

## Deployment boundaries

The Next.js app can run anywhere with Node.js and Postgres. The standalone bridge is a small WebSocket process for Twilio Media Streams. The optional tool factory deploys generated functions to a separate Vercel project and is disabled by default.

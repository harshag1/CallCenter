# Architecture

Harsha's Amazing Call Center separates six concerns that are often entangled in voice-agent repositories: immutable agent definitions, orchestration state, realtime transport, tool authority, tenant data, and deployment boundaries.

## Agent definition

The application creates a new `agent_versions` row for each update and advances `agents.active_version`. Each version stores instructions, a provider-specific voice ID, Flow JSON, attached minted tools/MCP servers, and provider settings. The database does not yet enforce append-only history with a trigger, and the public builder does not expose a revert operation, so operators should not treat this as tamper-proof version storage. Before a provider receives tools, each call pins a digest-verified runtime manifest so later edits to a named flow or attached tool cannot mutate that conversation.

Reserved `settings` keys:

- `voice_provider`: `xai`, `openai`, or `gemini`.
- `voice_model`: provider model ID.
- `provider_settings`: advanced provider-specific session fields.

Legacy settings outside those keys continue to be merged into provider settings.

## Flow runtime

Flow v2 is a provider-neutral state machine. The pure engine lives in `web/lib/flow-runtime.ts`; `web/lib/flow-state-store.ts` persists it in `flow_runs`. Per-call row locking serializes grant-changing transitions. Capability epochs change only when authority changes, while ordinary storage revisions also cover receipt reservation and settlement.

The runtime distinguishes control tools (`classify`, `enter_step`, `complete_step`, `get_flow_state`, `run_action`, `reconcile_action`) from business actions. In gateway mode, all business actions use short-lived leases and enter model context only when the current state grants them. `flow_action_receipts` atomically records admission before dispatch; successful current-attempt receipts can populate typed outputs, while indeterminate effects block unsafe retry and completion until a pinned read-only reconciliation proof succeeds.

Flow v2 is one orchestration kernel, not the architecture's ceiling. The experimental `web/lib/mission-runtime.ts` models multi-goal agendas, focus-scoped detours, revisioned facts, proof-carrying obligations, compensation, and state-bound continuation when a fixed graph is the wrong abstraction. Both kernels follow the same separation: the model proposes speech and actions, while deterministic state and evidence determine authority and completion. See [mission runtime](mission-runtime.md) for its narrower evidence status.

## Realtime providers

`VoiceSessionSpec` is the common contract: instructions, model, voice, provider settings, the public active-capability catalog, and one local `capability_gateway`. Each adapter translates it into a provider session and transport while private grants, external-MCP credentials, and durable receipts remain on the host.

- xAI: OpenAI-compatible realtime events over WebSocket.
- OpenAI: WebRTC in browsers and WebSocket/PCMU in the Twilio bridge.
- Gemini: Live API WebSocket with blocking function execution through the same local gateway.

Provider adapters do not change Flow state semantics. An opt-in [Realtime Provider Plugin v1 contract](../web/lib/realtime/plugins/README.md) now provides validated manifests, media/transport preflight, normalized event/tool-result hooks, and a conformance kit. Its built-in provider exports are transitional wrappers; the release-critical core registry still uses static provider wiring. Adding a provider to the stock application therefore still requires updating the provider ID/default/voice registry, browser transport, builder input enum, and integration metadata.

## Tool layers

1. Core voice actions in `web/lib/mcp.ts`.
2. Self-hosted extension tools in `web/lib/voice-tools/extensions.ts`.
3. Generated edge tools stored in `tools` and invoked through the tool factory; builder-driven creation is currently withheld pending a funded-approval adapter.
4. External remote MCP servers stored per organization.
5. Builder/operator tools in `web/lib/agent/tools`, plus its extension manifest.

All secured Flow v2 live-call actions converge on the scoped MCP gateway and are logged by receipt ID and content hashes. Capability secrets are redacted from audit previews. Background follow-up work has a separate explicit tool audience and cannot use realtime controls or leases.

## Data and tenancy

Application data routes resolve an authenticated organization or a signed call scope before tenant access. Product datasets are represented by `datasets` and `dataset_rows`; public raw-SQL management is disabled. The 31 ordered migrations (`001`–`031`) revoke public/API-role access and enable and force RLS across the public and private application relations. Production still requires a separate non-owner, non-superuser, non-`BYPASSRLS` runtime login; connecting as the migration owner defeats that boundary. Postgres stores experiment assignments, schedules, logs, flow state, call events, transcripts, and browser-call recording metadata/objects. The supplied PSTN bridges do not persist audio.

## Deployment boundaries

Most of the Next.js app can run on a Node.js host with Postgres. The old in-app `/api/bridge` WebSocket path is disabled by default and forbidden in production; use the standalone bridge for telephony transport. The optional tool factory deploys generated functions to separate opaque Vercel projects and is disabled by default.

The standalone Twilio Media Streams bridge is a bounded development transport, not a production compatibility claim. It verifies the exact Twilio WSS upgrade, consumes a one-use bootstrap credential bound to observed call/stream/instance identity, holds media until strict provider acknowledgement, bounds queues and state, rotates separate event/MCP/renewal authority, and routes the single provider function through the application gateway. It supports 8 kHz PCMU paths for the OpenAI/xAI adapters; Gemini transcoding is not implemented. It remains development/non-production until provider/PSTN canaries, multi-instance replay, load/soak, monitoring, and crash-loss decisions are attached to the release commit. See the [bridge runbook](../bridge/RUNBOOK.md) and [SECURITY.md](../SECURITY.md).

# Harsha's Amazing Call Center — realtime bridge

This directory is the standalone telephony edge for Harsha's Amazing Call Center. It connects an authenticated Twilio bidirectional Media Stream to a hosted OpenAI- or xAI-compatible realtime WebSocket while keeping provider keys, business tools, private action leases, and durable call state off the model connection.

> **Release classification: development / non-production.** The bridge has hermetic state-machine, long-session, and local HTTP/WebSocket integration coverage. OpenAI and xAI are protocol adapters, not live compatibility claims. Gemini is not implemented in this standalone bridge. Advertise a provider/model only after a budget-capped live canary against the release commit.

## What is different about this bridge

A long voice conversation should not rely on the model remembering every rule or holding every capability. The model sees one local function, `capability_gateway`, plus a small server-authored active capability catalog. The application decides which logical tools exist at the current flow step, binds private leases on the host, executes each operation behind durable receipts, and returns the next catalog with the result.

The resulting loop is:

```text
caller utterance
  -> model chooses a logical tool from the current public catalog
  -> bridge pins the catalog digest/epoch and native provider call id
  -> same-origin MCP gateway validates current call + flow authority
  -> application binds private authority and durably settles the operation
  -> result carries the replacement catalog/context
  -> bridge advances authority only after the whole provider batch settles
```

Private grants never enter provider instructions, tool arguments, tool results, URLs, or bridge logs. A credential rotation also cannot rewind flow authority: capability tokens and the active catalog are independent state machines.

## Security and correctness boundaries

- Twilio's upgrade is verified against the exact configured public WSS URL.
- `connected` and `start` are ordered and bounded; only `agent` mode and inbound PCMU/8 kHz/mono are accepted.
- A compact, one-use bootstrap credential is bound to the observed AccountSid, CallSid, StreamSid, session ID, and bridge instance.
- Event, MCP, and renewal capabilities are distinct, audience-bound, short-lived header credentials.
- Capabilities rotate every 30 minutes with a five-minute renewal window; the bridge fails closed at expiry.
- Provider API keys stay local. Bootstrap responses cannot supply keys or arbitrary headers.
- Caller audio is held until the provider exactly acknowledges the requested security-sensitive session configuration.
- Function arguments do not authorize execution. Only a matching terminal `response.done` with `status: completed` can release a batch.
- Cancelled, failed, and incomplete responses can never release tools and do not poison the next turn. Cancellation acknowledgements and already-buffered late audio/transcript frames settle as no-ops; contradictory terminal rewrites still fail closed.
- High-rate provider event IDs use a bounded sliding replay window, while response, item, and call ledgers independently preserve consequential tool identity after a transport fingerprint ages out.
- Every call in one provider terminal batch uses the same catalog snapshot and authority client. Calls execute in provider order; a later stale call settles as a tool error rather than being silently rebound.
- The native provider `call_id`, carried in bridge-owned MCP metadata, is the durable invocation identity. JSON-RPC IDs are transport correlation only.
- Barge-in clears unsent audio, accounts playback per output item from echoed Twilio marks, truncates every incomplete item, repairs retired tool calls, and suppresses stale continuation.
- Queues, JSON graphs, transcript buffers, identities, calls, retries, HTTP bodies, and shutdown are bounded. Ambiguity closes the session.
- Journal batches are content-addressed, retry-stable, capability-rotation-aware, and retained until an exact acknowledgement.

## Data path

```text
Twilio <Connect><Stream>
  |  WSS /stream + X-Twilio-Signature
  |  customParameters {bridgeToken, mode:"agent"}
  v
BridgeSession
  |-- POST /api/telephony/bridge/session
  |     bootstrap v3 -> provider config + catalog ref + 3 capabilities
  |-- WSS api.openai.com or api.x.ai         local provider key
  |-- POST /api/mcp                          MCP capability + MCP session
  |-- POST /api/telephony/bridge/events      event capability
  `-- POST /api/telephony/bridge/capabilities/rotate
        renewal capability -> next event/MCP/renewal bundle
```

The application remains authoritative for tenancy, call ownership, provider selection, flow state, private leases, idempotency, side effects, and history. The exact wire contract is in [AUTHORITY_CONTRACT.md](./AUTHORITY_CONTRACT.md).

## Quick start

Requirements: Node.js 20.9+, an application implementing the four same-origin endpoints above, Twilio, and a supported hosted realtime provider key.

```bash
cd bridge
npm ci
npm run check
npm test
```

```bash
export NODE_ENV=development
export APP_ORIGIN=https://app.example.com
export BRIDGE_PUBLIC_STREAM_URL=wss://bridge.example.com/stream
export TWILIO_ACCOUNT_SID=AC00000000000000000000000000000000
export TWILIO_AUTH_TOKEN='replace-with-the-real-auth-token'
export OPENAI_API_KEY='replace-with-the-provider-key'
# or: export XAI_API_KEY='replace-with-the-provider-key'

npm start
```

`APP_ORIGIN` must be an exact HTTPS origin. `BRIDGE_PUBLIC_STREAM_URL` must be a canonical `wss://` URL ending in exactly `/stream`, without credentials, query, or fragment. TLS terminates at the deployment edge; the Node process serves HTTP/WebSocket internally.

TwiML should be equivalent to:

```xml
<Response>
  <Connect>
    <Stream url="wss://bridge.example.com/stream">
      <Parameter name="bridgeToken" value="SHORT_LIVED_BOOTSTRAP_TOKEN" />
      <Parameter name="mode" value="agent" />
    </Stream>
  </Connect>
</Response>
```

Do not put credentials or call identifiers in the Stream URL. `customParameters` must contain exactly `bridgeToken` and `mode`; the token must fit Twilio's 500-byte parameter limit. See [RUNBOOK.md](./RUNBOOK.md) for the complete environment and deployment checklist.

## Provider boundary

The adapter accepts only canonical hosted endpoints:

- `wss://api.openai.com/v1/realtime?model=<model>`
- `wss://api.x.ai/v1/realtime?model=<model>`

The URL has exactly one matching `model` query. Direct Twilio sessions use PCMU input/output; xAI formats also declare 8,000 Hz and JSON audio transport. [xAI documents JSON as the default transport and makes binary output opt-in and strict](https://docs.x.ai/developers/model-capabilities/audio/voice-agent); this bridge rejects a bootstrap that selects binary transport and treats an unexpected binary provider frame as a protocol failure instead of guessing missing response/item provenance. The bootstrap-issued `session.update` owns instructions, audio, tools, and tool choice. Later `response.create` frames cannot override that authority.

Strict `session.updated` parity is intentional. A provider/model that omits or rewrites a security-sensitive field is not ready for this transport. Do not loosen the check to make a canary green.

## Active catalog and tool batches

Provider-visible gateway arguments are exactly:

```json
{"tool_name":"membership_lookup","arguments":{"member_id":"..."}}
```

The bridge unwraps that envelope and calls MCP with the logical `tool_name`. It adds two hidden metadata values: the native provider call ID and the catalog `{catalog_digest, capability_epoch}` used when the model generated the call.

For a multi-call terminal response, all calls use that same old catalog snapshot and run serially. If call one changes the flow, call two is not upgraded to the new authority. The server returns `stale_active_capability_catalog` without business dispatch and includes the current catalog. Only after every call produces a verified gateway envelope does the bridge commit the catalog from the last result. A blocked catalog prevents future MCP dispatch.

Transport retries reuse the same native call ID, JSON-RPC body, and MCP session semantics. The application must durably deduplicate by the native invocation identity and return the stored outcome. An unreadable post-dispatch outcome is indeterminate and terminates the call.

## Barge-in and playback truth

The bridge emits a Twilio mark after each bounded output chunk. Only echoed marks advance played bytes. On caller speech it:

1. invalidates pending marks and discards unsent audio/mark frames;
2. prioritizes `clear` to Twilio;
3. seals and cancels the active provider response;
4. truncates each incomplete output item at that item's acknowledged offset;
5. emits repair outputs for calls retired before execution; and
6. suppresses `response.create` when the barge-in epoch changed during tool execution.

This intentionally biases history toward audio proven heard, not audio merely generated.

## Long sessions and rotation

Bootstrap v3 returns event, MCP, and renewal capabilities with a 30-minute expiry and `refresh_after` exactly five minutes earlier. At refresh, the bridge requests generation `N+1` with a stable idempotency key. It atomically swaps new credentials, pins an in-flight journal HTTP attempt to its captured event credential, retries any retained immutable batch under the current event credential, retains an in-flight tool batch on its old MCP client, and retires old authority at its exact expiry.

The deterministic test clock proves generations `0 -> 1 -> 2`, a successful tool at minute 31, readiness at minute 56, old-client retirement, and fail-closed behavior when renewal never settles. Set `BRIDGE_MAX_CALL_MS` above 30 minutes if the deployment intends to use this support; the default remains 30 minutes.

## Evidence and release gates

Tests are hermetic by default and make no Twilio/provider calls:

```bash
npm run check
npm test
npm run test:coverage
npm audit --omit=dev
```

Captured on 2026-07-16 after the catalog/rotation join, lifecycle review closure, and graceful-shutdown repair: **147 bridge tests passed** under a 30-second process watchdog with **89.18% line / 77.87% branch / 88.15% function coverage**; the real web bootstrap suite passed **11/11**, the real MCP route suite passed **22/22**, and the real event-route suite passed **11/11**. These are dated local artifacts, not a production badge.

Do not call the bridge production-ready until the release commit also has:

- real session, rotation, MCP, and event-route compatibility, including dropped-response replay;
- shared durable bootstrap, rotation, MCP receipt, and event idempotency evidence;
- one budget-capped PSTN canary for every advertised provider/model;
- live acknowledgement, tool, barge-in, disconnect, >30-minute rotation, and drain artifacts;
- load/soak results at configured limits and a crash-loss decision for the in-memory journal;
- dashboards/alerts for authentication, expiry, provider parity, indeterminate tools, journal backlog, and forced drains; and
- reviewed consent, transcript/recording retention, secret rotation, and incident procedures.

The operational checklist is in [RUNBOOK.md](./RUNBOOK.md).

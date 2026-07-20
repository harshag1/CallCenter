# Application authority contract

This is the exact application-side contract consumed by the standalone bridge in Harsha's Amazing Call Center. The application is the durable authority; the bridge is a bounded protocol state machine; the realtime model is an untrusted chooser among a small public catalog.

The bridge uses four same-origin endpoints:

| Endpoint | Credential audience | Purpose |
| --- | --- | --- |
| `POST /api/telephony/bridge/session` | `bridge_bootstrap` | `telephony_stream_exchange` |
| `POST /api/telephony/bridge/capabilities/rotate` | `bridge_refresh` | `capability_rotation` |
| `POST /api/mcp` | `bridge_mcp` | `tool_invocation` |
| `POST /api/telephony/bridge/events` | `telephony_events` | `event_journal` |

All credentials are `Authorization: Bearer ...` headers. Never accept them from a URL, cookie, request body, provider event, model arguments, or WebSocket subprotocol. Every endpoint must reject a token minted for another row.

## Ownership

The application owns call/tenant authority, bootstrap signing, durable one-use/retry records, provider selection, the initial public catalog, private action leases, flow transitions, side-effect receipts, capability rotation state, and durable event ingestion.

The bridge owns exact Twilio upgrade/start validation, observed connection binding, provider-key custody, strict response/configuration parsing, provider event provenance, catalog snapshot propagation, bounded queues/state, and fail-closed teardown.

The provider owns none of those authorities. Model text, tool names, arguments, IDs nested inside arguments, and caller speech are untrusted input.

## 1. Bootstrap credential and first use

The compact v2 helper in `lib/auth.js` signs these claims and fits Twilio's 500-byte custom-parameter limit:

```json
{
  "aud": "bridge_bootstrap",
  "purpose": "telephony_stream_exchange",
  "iat": 0,
  "exp": 0,
  "jti": "22-character-base64url",
  "account_sid": "AC...",
  "call_sid": "CA...",
  "mode": "agent"
}
```

Default TTL is 120 seconds, maximum TTL is 300 seconds, and allowed future skew is 10 seconds. The StreamSid, bridge session ID, and bridge instance are unknown at TwiML mint time and become durable first-use bindings during bootstrap. A production deployment needs a shared transactionally safe replay store. The bounded in-memory adapter is for tests and single-process development only; it rejects new live entries at capacity and never evicts a live tombstone.

The bootstrap signer stays in the application. `TWILIO_AUTH_TOKEN` is a different secret used by the bridge only for the WebSocket signature.

## 2. Bootstrap schema v3

### Request

```http
POST /api/telephony/bridge/session HTTP/1.1
Authorization: Bearer <bootstrap-token>
Idempotency-Key: bridge-<stable-session-id>
Content-Type: application/json
Accept: application/json
Cache-Control: no-store
```

```json
{
  "schema_version": 3,
  "session_id": "bridge-<stable-session-id>",
  "bridge_instance_id": "bridge-instance-id",
  "connection": {
    "account_sid": "AC...",
    "call_sid": "CA...",
    "stream_sid": "MZ...",
    "mode": "agent"
  }
}
```

The body has exactly those fields. Require `Idempotency-Key === session_id`. Verify the signed AccountSid/CallSid/mode, the authoritative call row, Twilio `To`, selected provider, and current active status. Atomically pin bootstrap JTI, all connection fields, session ID, and `bridge_instance_id`.

The exact same token, body, instance, and idempotency key may retry after a lost response and must receive the first committed response bytes. A different bridge instance is not an exact retry; failover requires a new bootstrap/session. Reject every connection, session, token, or instance substitution. A concurrent exact loser reads the winner's committed bytes; it never mints another bundle.

Persist the complete serialized response in the same transaction as consumption. Fail closed if the replay store is unavailable, saturated, timed out, inconsistent, or observes clock rollback.

### Response

The success body has exactly these top-level keys:

```json
{
  "schema_version": 3,
  "session_id": "bridge-<same-session-id>",
  "bridge_instance_id": "bridge-instance-id",
  "call_id": "application-call-id",
  "connection": {
    "account_sid": "AC...",
    "call_sid": "CA...",
    "stream_sid": "MZ...",
    "mode": "agent"
  },
  "provider": "openai",
  "model": "provider-model-id",
  "ws_url": "wss://api.openai.com/v1/realtime?model=provider-model-id",
  "session_update": {"type":"session.update","session":{}},
  "active_catalog_authority": {
    "catalog_digest": "64-lowercase-hex",
    "capability_epoch": 0
  },
  "rotation": 0,
  "rotation_endpoint": "/api/telephony/bridge/capabilities/rotate",
  "refresh_after": "2026-07-16T12:25:00.000Z",
  "event_capability": {
    "token": "distinct-event-token",
    "expires_at": "2026-07-16T12:30:00.000Z",
    "audience": "telephony_events",
    "purpose": "event_journal"
  },
  "mcp_capability": {
    "token": "distinct-mcp-token",
    "expires_at": "2026-07-16T12:30:00.000Z",
    "audience": "bridge_mcp",
    "purpose": "tool_invocation"
  },
  "renewal_capability": {
    "token": "distinct-renewal-token",
    "expires_at": "2026-07-16T12:30:00.000Z",
    "audience": "bridge_refresh",
    "purpose": "capability_rotation"
  },
  "expires_at": "2026-07-16T12:30:00.000Z"
}
```

Invariants:

- `schema_version === 3`, `rotation === 0`, and all request bindings echo exactly.
- `rotation_endpoint` is exactly `/api/telephony/bridge/capabilities/rotate`.
- `catalog_digest` is lowercase SHA-256 and `capability_epoch` is a non-negative safe integer.
- Provider is currently `openai` or `xai`; the WSS URL is its canonical hosted realtime endpoint with one matching model query.
- All four expiry strings are the same canonical future timestamp no more than 30 minutes after bridge receipt. `refresh_after` is exactly five minutes earlier.
- Event, MCP, renewal, and bootstrap tokens are pairwise distinct.
- Provider keys, Twilio secrets, private action grants, cookies, and arbitrary headers are forbidden.
- The initial catalog reference is persisted with the bootstrap response. An exact retry does not read mutable current agent state.

The `session_update` contains the provider-visible public catalog and declares only the local `capability_gateway` function. The reference is token-free and is not part of credential rotation.

## 3. Capability rotation

At `refresh_after`, request generation `N+1` with the current renewal token:

```http
POST /api/telephony/bridge/capabilities/rotate HTTP/1.1
Authorization: Bearer <current-renewal-token>
Idempotency-Key: bridge-session-id:1
Content-Type: application/json
```

```json
{
  "schema_version": 1,
  "session_id": "bridge-session-id",
  "bridge_instance_id": "bridge-instance-id",
  "rotation": 1,
  "connection": {
    "account_sid": "AC...",
    "call_sid": "CA...",
    "stream_sid": "MZ...",
    "mode": "agent"
  }
}
```

The idempotency key is exactly `${session_id}:${rotation}`. Verify the renewal capability against every pinned call/stream/provider/instance binding. Generation is monotonic by one. Reject early, skipped, stale-after-expiry, conflicting, stopped-stream, inactive-call, and instance-substitution requests.

The response has exactly:

```json
{
  "schema_version": 1,
  "session_id": "bridge-session-id",
  "bridge_instance_id": "bridge-instance-id",
  "call_id": "application-call-id",
  "connection": {},
  "rotation": 1,
  "refresh_after": "2026-07-16T12:50:00.000Z",
  "event_capability": {},
  "mcp_capability": {},
  "renewal_capability": {},
  "expires_at": "2026-07-16T12:55:00.000Z"
}
```

`connection` and the three capability envelopes use the exact bootstrap shapes. The new expiry must extend the current generation yet remain no more than 30 minutes after bridge receipt. Every returned bearer must be distinct from every bearer in both the new and current generations. Rotation intentionally omits `active_catalog_authority`: credential rotation must preserve, not replace or rewind, the bridge's current catalog. An exact retry while the old renewal credential remains valid returns byte-identical output. Old credentials may overlap for at most five minutes and stop working at their expiry.

Session shutdown owns both exchanges. A pending bootstrap remains observable for one bounded settlement window; if its response arrives, the bridge establishes the event journal and writes terminal evidence without connecting the provider. At the deadline it closes the acceptance window, aborts local transport, and conservatively records the bootstrap as remotely indeterminate. A pending rotation is aborted immediately, cannot swap session authority while closing, and is journaled as committed, determinate, or unknown before journal completion.

## 4. Provider configuration

The application-issued `session_update` is the only provider session authority. It is strict JSON, declares PCMU input/output (xAI also declares 8,000 Hz), and exposes exactly the reviewed local function surface. The shipped authority path accepts only `capability_gateway`.

The bridge verifies the provider's `session.updated` projection before releasing audio. Missing, rewritten, or authority-expanding fields fail readiness. Test every advertised model live; do not weaken parity for provider convenience.

## 5. MCP lifecycle, identity, and catalog authority

The MCP capability is scoped to the active application call, actual provider, Twilio AccountSid/CallSid/To/StreamSid, and transport. `/api/mcp` also rechecks the live call, agent/version provider, and unstopped durable stream binding.

The bridge performs canonical Streamable HTTP initialization:

1. `initialize` with protocol version `2025-11-25` and a bounded request ID;
2. validate the server response and canonical server-issued `MCP-Session-Id`;
3. send `notifications/initialized`; and
4. send later requests with that session ID and protocol version.

A safe `404`/`-32002` invalid-session response may trigger one coalesced reinitialization. The business call retains the same native provider identity across the new MCP transport session.

The provider-visible call is exactly:

```json
{"tool_name":"renew_membership","arguments":{"plan":"annual"}}
```

The bridge unwraps it into:

```json
{
  "jsonrpc": "2.0",
  "id": "bridge-call:v1:<correlation-sha256>",
  "method": "tools/call",
  "params": {
    "name": "renew_membership",
    "arguments": {"plan":"annual"},
    "_meta": {
      "hacc/provider_tool_call_id": "native-provider-call-id",
      "com.harsha.callcenter/active-catalog": {
        "catalog_digest": "64-lowercase-hex",
        "capability_epoch": 4
      }
    }
  }
}
```

Only bridge-owned top-level `_meta` is trusted. Model-controlled `arguments._meta` is ordinary input. The JSON-RPC ID correlates one HTTP response; it is **not** the durable side-effect identity. The application derives a durable invocation ID from org, application call, actual provider, and native provider call ID, then atomically claims it with the target and canonical arguments hash. Exact retries—including a lost response followed by a new MCP session or bridge process—return the stored receipt/outcome. Reuse with different provenance or arguments conflicts without redispatch.

Before business dispatch, compare the hidden catalog digest/epoch with current host authority and resolve the logical name through the private binding map. For a host-bound action, the server injects the current private `capability_grant`; the provider and bridge never receive it.

Every successful `tools/call` text item is exactly this envelope:

```json
{
  "schema_version": 1,
  "outcome": {"ok":true},
  "active_capability_catalog": {
    "schema_version": 1,
    "availability": "active",
    "runtime_digest": "64-lowercase-hex",
    "capability_epoch": 5,
    "state_revision": 9,
    "scope": {
      "status": "active",
      "topic": "membership",
      "step": "membership.renew",
      "attempt": 1
    },
    "active_context": {},
    "catalog_digest": "64-lowercase-hex",
    "tools": []
  }
}
```

The MCP result contains exactly one `{type:"text",text:<JSON>}` content item plus boolean `isError`. The catalog has exact keys, at most 64 logical tools, bounded public schemas/context, and no private grants. A blocked catalog has no tools. The bridge accepts at most the bounded 896 KiB public envelope plus MCP JSON encoding overhead.

All calls in one terminal provider batch use the same old catalog digest/epoch and execute serially. If call one changes authority, call two's old expectation settles `stale_active_capability_catalog` without business dispatch and returns the current catalog. That is a determinate tool error, not a transport error. After every call returns a verified envelope, the bridge advances once from the last envelope. It never silently rebinds a model-generated call.

Timeout, malformed post-dispatch response, or result eviction is indeterminate. The bridge closes instead of blindly repeating a possible side effect; reconcile the durable receipt before manual action.

## 6. Event journal

The event capability is bound to the active Twilio stream. The journal's `session_id` is the StreamSid (`MZ...`), not the random bootstrap exchange ID.

```http
POST /api/telephony/bridge/events HTTP/1.1
Authorization: Bearer <event-capability>
Idempotency-Key: event_batch_<sha256>
Content-Type: application/json
```

```json
{
  "schema_version": 1,
  "session_id": "MZ...",
  "session_sha256": "<sha256>",
  "first_sequence": 1,
  "last_sequence": 1,
  "events": [{
    "session_id": "MZ...",
    "sequence": 1,
    "type": "provider.ready",
    "payload": {},
    "content_sha256": "<sha256>"
  }],
  "complete": false,
  "batch_id": "event_batch_<sha256>",
  "batch_sha256": "<sha256>"
}
```

Validate the capability before mutation, enforce the still-live stream binding, verify contiguous sequences and hashes, atomically insert/deduplicate by batch ID, then return exactly:

```json
{"ok":true,"batch_id":"event_batch_<same-sha256>"}
```

The response is 2xx JSON with exactly those fields. Anything else retains the batch. Both normal requests and shutdown drains have deadlines. The batch body, ID, hash, and idempotency key never change. Each HTTP attempt snapshots the event token current when that request begins, so an in-flight attempt cannot be rebound by rotation; after that attempt settles, an exact retry may reauthenticate the same immutable batch with the current equivalent event capability. This prevents an outage spanning old-token expiry from permanently wedging the journal.

After events drain, the bridge sends an empty `complete:true` batch with null sequence bounds. Completion proves a bounded bridge drain, not completion of arbitrary external side effects.

## Error behavior and required tests

Return bounded JSON with `Cache-Control: no-store`. Use `400` for malformed exact schemas, `401` for invalid/expired/wrong-audience credentials, `403` for authoritative binding mismatch, `409` for idempotency conflict, `425` for rotation too early, `429` for explicit capacity, and `503` for unavailable durable authority. Never fall back to a fresh credential or a second side effect.

Before release, run the real routes against tests for:

- exact concurrent bootstrap replay and every call/stream/session/instance substitution;
- rotation too early, exact retry, generation conflict, old-token expiry, stopped stream, and >30-minute continuity;
- MCP initialization/session recovery, native-ID replay after lost response, argument conflict, active-catalog stale/blocked behavior, private-grant non-disclosure, pending/indeterminate receipts, and dropped-response reconciliation;
- event duplicate delivery, rotated-scope overlap, normal request timeout, wrong acknowledgement, completion replay, and sequence/hash conflict; and
- multi-instance behavior on the shared durable stores.

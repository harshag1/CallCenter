# Realtime bridge runbook

This runbook covers the standalone Twilio Media Streams bridge in Harsha's Amazing Call Center. It is written for the code in this directory, not for a hypothetical managed service.

> **Current release classification: development / non-production.** The process has hermetic state-machine and integration tests, but the real application contract, multi-instance replay store, provider sessions, PSTN path, load behavior, and crash-loss policy still need release artifacts.

## Runtime inventory

- Node.js 20.19.x, 22.13.x or newer 22.x, or 24+; the container uses Node 22 Alpine.
- One HTTP listener, default port `8080`.
- WebSocket upgrade path: exactly `/stream`.
- Liveness: `GET /health` and `GET /health/live`.
- Readiness: `GET /health/ready`.
- Default application endpoints: `/api/telephony/bridge/session`, `/api/telephony/bridge/capabilities/rotate`, `/api/mcp`, and `/api/telephony/bridge/events` under one `APP_ORIGIN`.
- Supported bridge modes: `agent` only.
- Adapter implementations: hosted OpenAI and xAI realtime protocols. The xAI path deliberately pins JSON audio transport; raw binary output is not accepted. Gemini has no adapter here.
- Audio: Twilio inbound `audio/x-mulaw`, 8,000 Hz, mono; provider session input/output `audio/pcmu`.

The Node server does not terminate TLS. Put it behind an edge that terminates HTTPS/WSS, preserves WebSocket upgrades and `X-Twilio-Signature`, and routes only the canonical public `/stream` URL to this service. Signature verification uses configured public URL bytes; it never reconstructs authority from proxy headers.

## Environment

### Required and routing variables

| Variable | Required/default | Validation and operational meaning |
| --- | --- | --- |
| `NODE_ENV` | set `production` in production | In production, insecure loopback mode is forbidden. |
| `PORT` | `8080` | Integer `1..65535`. |
| `APP_ORIGIN` | required | Credential-free HTTPS origin with no path, query, or fragment. HTTP is permitted only for an explicitly enabled non-production loopback test. |
| `BRIDGE_PUBLIC_STREAM_URL` | required | Canonical `wss://.../stream`; exact path `/stream`, no credentials, query, fragment, or backslash. `ws://` is allowed only for explicit non-production loopback tests. |
| `TWILIO_ACCOUNT_SID` | required | Canonical `AC` followed by 32 hexadecimal characters. Start frames for any other account fail closed. |
| `TWILIO_AUTH_TOKEN` | required | At least 20 control-free characters. Used only to validate Twilio's upgrade signature. |
| `TWILIO_AUTH_TOKEN_NEXT` | optional | A distinct replacement token accepted only for Twilio upgrade-signature validation during a bounded rotation window. Configure the secondary token here before promoting it, verify traffic after promotion, then move it to `TWILIO_AUTH_TOKEN` and remove this variable. |
| `OPENAI_API_KEY` | optional | Local bridge credential, maximum 8,192 control-free bytes. Required when bootstrap selects `openai`. |
| `XAI_API_KEY` | optional | Local bridge credential, maximum 8,192 control-free bytes. Required when bootstrap selects `xai`. |
| `BRIDGE_INSTANCE_ID` | generated | `1..128` characters from letters, digits, `_`, `.`, `:`, or `-`; journal/bootstrap correlation only. |
| `BRIDGE_ALLOW_INSECURE_LOCAL_TESTS` | `false` | `1`, `0`, `true`, or `false`. Non-production loopback only. It permits HTTP/WS loopback, accepts loopback upgrades without a Twilio signature, and relaxes strict Twilio connected/track checks. Never enable it on a shared machine or deployment. |
| `BRIDGE_SESSION_PATH` | `/api/telephony/bridge/session` | Bounded same-origin absolute path with no `..`. |
| `BRIDGE_AUTHORITY_PATH` | `/api/mcp` | Keep this exact value. The current `AuthorityClient` deliberately pins the actual target to same-origin `/api/mcp`. |
| `BRIDGE_EVENTS_PATH` | `/api/telephony/bridge/events` | Bounded same-origin absolute path with no `..`. |
| `BRIDGE_ALLOWED_CLIENT_TOOLS` | `capability_gateway` | Comma-separated, unique canonical names, `1..32` entries. Keep only `capability_gateway` with the shipped authority client. |

At least one provider key must be present for `/health/ready` to return ready. Readiness does not prove that bootstrap will select the provider whose key is present, that the key is valid, or that the application/provider is reachable.

There is intentionally no bootstrap signing secret in the bridge environment. The application owns bootstrap and child-capability signing.

### Bounded session variables

All values are integer bytes, counts, or milliseconds as named.

| Variable | Default | Allowed range |
| --- | ---: | ---: |
| `BRIDGE_MAX_CONCURRENT_SESSIONS` | `1000` | `1..50000` |
| `BRIDGE_MAX_TWILIO_MESSAGE_BYTES` | `65536` | `1024..262144` |
| `BRIDGE_MAX_PROVIDER_MESSAGE_BYTES` | `2097152` | `16384..2097152` |
| `BRIDGE_MAX_MEDIA_FRAME_BYTES` | `8192` | `160..65536` |
| `BRIDGE_INPUT_QUEUE_MESSAGES` | `500` | `10..5000` |
| `BRIDGE_INPUT_QUEUE_BYTES` | `2097152` | `65536..16777216` |
| `BRIDGE_OUTPUT_QUEUE_MESSAGES` | `1000` | `10..10000` |
| `BRIDGE_OUTPUT_QUEUE_BYTES` | `4194304` | `65536..33554432` |
| `BRIDGE_SOCKET_HIGH_WATER_BYTES` | `524288` | `16384..8388608` |
| `BRIDGE_MAX_PENDING_MARKS` | `2000` | `10..10000` |
| `BRIDGE_PLAYBACK_MARK_BYTES` | `800` | `160..8000` |
| `BRIDGE_MAX_TOOL_CALLS` | `128` | `1..1000` |
| `BRIDGE_TWILIO_START_MS` | `10000` | `1000..60000` |
| `BRIDGE_DRAIN_INTERVAL_MS` | `20` | `5..1000` |
| `BRIDGE_PROVIDER_CONNECT_MS` | `10000` | `1000..60000` |
| `BRIDGE_SESSION_ACK_MS` | `10000` | `1000..60000` |
| `BRIDGE_MAX_CALL_MS` | `1800000` | `30000..14400000` |
| `BRIDGE_IDLE_TIMEOUT_MS` | `60000` | `10000..600000` |
| `BRIDGE_SHUTDOWN_MS` | `8000` | `1000..60000` |

Do not increase a queue limit in isolation. Estimate the per-process worst case as session count multiplied by both queue budgets, pending provider identity/transcript/tool state, WebSocket buffers, and journal state. Validate changes with process RSS, event-loop delay, provider latency, Twilio playback latency, and forced-drain tests.

## Build and preflight

From the repository root:

```bash
cd bridge
npm ci
npm run check
npm test
npm run test:coverage
```

The default test suite is hermetic and should make no Twilio or provider calls. Captured after the bootstrap-v3/catalog/rotation join, lifecycle review closure, and graceful-shutdown repair on 2026-07-16: 147 bridge tests passed under a 30-second process watchdog with 89.18% line / 77.87% branch / 88.15% function coverage; the real web bootstrap route passed 11/11, the real MCP route passed 22/22, and the real event route passed 11/11. Rerun at the release commit because dated counts are not current proof.

Build the container:

```bash
docker build -t harshas-amazing-call-center-bridge:dev bridge
```

The image installs production dependencies only, copies `server.js` and `lib/`, runs as the unprivileged `node` user, exposes `8080`, and uses `/health/live` for its image health check. Tests, research notes, scripts, and documentation are not copied into the image.

Run locally with a reviewed environment file:

```bash
docker run --rm \
  --name hacc-realtime-bridge \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --env-file ./bridge.env \
  -p 8080:8080 \
  harshas-amazing-call-center-bridge:dev
```

This hardened form was exercised on 2026-07-16 against image manifest `sha256:852922801a19a40302a65076eabf72c05db8b812a2a7449b4fcce5238734e6f6`: the image became healthy with a read-only root, no Linux capabilities, `no-new-privileges`, and the unprivileged `node` user, then drained in 0.17 seconds under a 3-second stop deadline. Translate the same controls to the target orchestrator and rerun them at the release digest. Do not commit `bridge.env`, pass secrets as image build arguments, or expose the bridge port directly to the public internet without the WSS edge.

## Health semantics

```bash
curl --fail --silent http://127.0.0.1:8080/health/live
curl --fail --silent http://127.0.0.1:8080/health/ready
```

Expected bodies:

```json
{"ok":true,"status":"live"}
```

```json
{"ok":true,"status":"ready","active_sessions":0}
```

Liveness means the HTTP process can answer. Readiness means the listener is active, the server is not draining, and at least one provider key is configured. It is intentionally a shallow check: application endpoint health, provider authentication, Twilio reachability, and durable replay health require separate probes or canaries.

During drain, readiness returns `503` with `not_ready`, new WebSocket upgrades receive `503`, and existing sessions are asked to shut down.

## No-spend PSTN admission preflight

Run the web-side admission check before any live PSTN qualification. The default
command reads only local environment and Git state: it cannot create a call,
send an SMS, purchase a number, update a webhook, or mutate a Twilio resource.

Private configuration must include:

- an explicitly reviewed Restricted key bound by
  `TWILIO_API_KEY_TYPE=restricted` and
  `TWILIO_API_KEY_ACCOUNT_SID=TWILIO_ACCOUNT_SID`;
- canonical `TWILIO_ACCOUNT_SID`, `TWILIO_PHONE_NUMBER`, and one
  user-approved canonical E.164 destination in `TWILIO_APPROVED_TEST_TO`;
- inbound-only `TWILIO_AUTH_TOKEN` and a distinct, receipt-only
  `TELEPHONY_RECEIPT_SECRET` of 32–256 control-free characters; and
- the exact standalone `wss://<public-bridge-host>/stream` URL in
  `BRIDGE_WS_URL`. The legacy same-origin `/api/bridge` route is rejected.

From `web/`, validate configuration at the fixed $30-or-lower authority bound:

```bash
npm run twilio:pstn:preflight -- \
  --max-usd 30 \
  --out /private/tmp/hacc-twilio-pstn-preflight.json
```

For stronger admission evidence, explicitly opt into the read-only network
probes:

```bash
npm run twilio:pstn:preflight -- \
  --max-usd 30 \
  --probe-read-only \
  --out /private/tmp/hacc-twilio-pstn-readiness.json
```

`--probe-read-only` adds exactly three bounded GET requests: the configured
Twilio account, its incoming-number inventory filtered to the configured caller,
and the standalone bridge's `/health/ready`. Redirects are rejected. The Twilio
requests authenticate only with the attested Restricted key; the account auth
token is never used for REST. No probe contains a request body.

The command writes redacted structured JSON with source commit/tree, hashed
configuration bindings, probe outcomes, ordered blockers, and one exact next
step. It never emits credential or phone-number preimages. Exit `0` means every
requested check passed, exit `2` means the receipt contains blockers, and exit
`1` means command usage or local execution failed. A passing preflight is not
authorization to place a call: retain its receipt, then use a separately
authorized, spend-reserved, resumable PSTN canary workflow.

## Edge and Twilio setup

The public edge must:

1. serve the exact `BRIDGE_PUBLIC_STREAM_URL` with WSS;
2. forward `GET /stream` as a WebSocket upgrade;
3. preserve `X-Twilio-Signature` exactly;
4. avoid path rewrites, redirects, query injection, authentication interstitials, and response buffering; and
5. use a WebSocket idle timeout greater than `BRIDGE_IDLE_TIMEOUT_MS` and the expected call duration.

The application's TwiML must use `<Connect><Stream>` and pass only `bridgeToken` and `mode=agent` as custom parameters. Do not put parameters on the Stream URL. The Twilio `start` event must report the inbound track, PCMU/8 kHz/mono, and the configured AccountSid.

Before a live canary, verify:

- the application minted the bootstrap credential for the exact CallSid;
- the session exchange has a healthy shared replay/idempotency store;
- its response selects a provider key present in the bridge;
- the selected hosted WSS URL and model match;
- the session update declares PCMU in/out and only `capability_gateway`;
- the provider is expected to echo every requested security-sensitive field; and
- event, MCP, and renewal capabilities have distinct audiences, purposes, tokens, and one 30-minute expiry;
- `refresh_after` is exactly five minutes before expiry and the rotation endpoint is the fixed same-origin route; and
- `active_catalog_authority` matches the public catalog embedded in provider instructions and contains only digest/epoch.

## Controlled canary

Live calls spend money and can contact real phone numbers. Run this only under the user's explicit budget and target authorization.

For each advertised provider/model pair:

1. deploy one release-candidate instance with a low concurrent-session cap;
2. place one authorized test call and capture the application call ID, Twilio CallSid/StreamSid, bridge instance/session IDs, provider/model, deploy digest, and timestamps;
3. confirm `session.authenticated`, `session.bootstrap`, and `provider.ready` in the event store;
4. speak before readiness and prove media was released only after the strict provider acknowledgement;
5. invoke a harmless idempotent gateway operation twice and prove one durable receipt keyed by the native provider call ID, with the same returned catalog envelope;
6. interrupt output mid-utterance and prove Twilio clear, mark-based played milliseconds, provider cancellation, and truncation acknowledgement;
7. end the call normally and prove `session.ended` plus the acknowledged empty completion batch; and
8. repeat one bootstrap request exactly, then test cross-instance, cross-session, and StreamSid substitution, proving only the exact pinned instance retry succeeds; and
9. for a deployment advertising calls longer than 30 minutes, cross `refresh_after`, prove generation `N+1`, execute a harmless tool after minute 30, and prove the old credentials stop at expiry without catalog rewind.

Record request/response hashes and database IDs, not bearer tokens or provider keys.

## Graceful drain and deploy

`SIGTERM` and `SIGINT` call the server's bounded stop path. The server:

- marks itself draining and rejects new upgrades;
- closes the WebSocket server and idle HTTP connections;
- closes provider/Twilio outboxes;
- owns an in-flight bootstrap through a bounded settlement window so a returned remote commit can establish its journal and receive terminal evidence; a deadline abort is still classified remotely indeterminate;
- aborts in-flight credential rotation, prevents it from mutating the closing session, and records committed, determinate, or unknown shutdown outcomes before sealing the journal;
- waits briefly for in-flight tool batches, recording unknown outcomes at the deadline;
- appends terminal session evidence;
- asks the event journal to drain and acknowledge completion; and
- force-terminates remaining sockets when `BRIDGE_SHUTDOWN_MS` expires.

Set the orchestrator termination grace period comfortably above `BRIDGE_SHUTDOWN_MS` plus edge deregistration delay. Stop routing new upgrades before sending the signal. Watch for `bridge_stopped` with `result: "drained"`; `result: "deadline"` requires reconciliation.

The journal is in process memory. A graceful stop attempts delivery, but a process crash, node loss, or `SIGKILL` can lose unacknowledged events. Production approval must explicitly accept that failure mode or add a durable local/external spool. Durable application-side batch deduplication does not recover a batch the bridge never sent.

## Logs, evidence, and alerts

The process emits structured JSON to stdout/stderr. Fields whose keys look like authorization, token, secret, signature, API key, or other credential-like names are redacted. SIDs, bootstrap material, capability material, and error messages are normally recorded as hashes in session evidence. Still treat the entire log stream as sensitive and prevent arbitrary user payloads from becoming log fields in future changes.

The application event journal includes final transcript text. Its storage is sensitive call data, not generic telemetry.

At minimum, alert on:

- `/health/ready` returning `503` outside an intentional drain;
- `bridge_upgrade_rejected` or `twilio_signature_invalid` spikes;
- `session_bootstrap_failed`, bootstrap `401/403`, or replay-store unavailability;
- `capability.rotation_failed`, `capability_authority_expired`, a skipped generation, or calls nearing expiry without rotation;
- `active_catalog_rewind`, `active_catalog_blocked`, or repeated stale-catalog outcomes;
- `provider_connect_timeout`, `provider_session_ack_timeout`, configuration mismatch/unverifiable events, socket closure, or reported provider errors;
- `authority_outcome_indeterminate`, MCP conflicts, or bootstrap, capability-rotation, and tool outcomes unknown at shutdown;
- `socket_backpressure`, queue/mark/tool capacity failures, or oversized/invalid frames;
- `bridge_journal_*_failed`, growing ingestion lag, missing completion, or forced drain; and
- calls ending by idle/max-duration timeout rather than Twilio stop.

The bridge does not expose Prometheus metrics today. Derive initial rates from structured logs, health probes, application endpoint metrics, and durable event rows; add a metrics surface before high-volume production if log-derived alerting is insufficient.

## Troubleshooting

| Symptom | Likely boundary | Checks and action |
| --- | --- | --- |
| WebSocket upgrade receives `401` | Twilio signature | Confirm the edge preserved `X-Twilio-Signature`; compare the TwiML Stream URL byte-for-byte with `BRIDGE_PUBLIC_STREAM_URL`; check the current Twilio auth token. Do not reconstruct the URL from proxy headers. |
| Upgrade receives `404` | Route | Twilio must request exactly `GET /stream`, with no trailing slash or query. |
| Upgrade receives `503` | Drain or capacity | Check readiness, drain state, `active_sessions`, and `BRIDGE_MAX_CONCURRENT_SESSIONS`. |
| Socket closes before provider connection | Twilio start/bootstrap | Confirm event order, monotonically contiguous sequence numbers, exact custom parameters, AccountSid, StreamSid parity, inbound track, media format, bootstrap expiry, and the durable first-use binding. |
| Exact bootstrap retry fails | Application idempotency | The app must return stored byte-equivalent response bytes only for the same token/session/instance/connection. Check transaction ordering and response persistence. A replacement instance needs a new bootstrap/session. Never mint fresh child tokens on retry. |
| Call closes near 30 minutes | Capability rotation | Confirm bootstrap v3 returned renewal authority, `refresh_after = expires_at - 5m`, generation is monotonic, the durable rotation row is live, and the old token had not expired before the response settled. Do not extend an expired token. |
| `provider_key_missing` | Local key routing | Bootstrap selected a provider whose local key is absent. Add the reviewed key or change application routing; readiness alone does not detect this mismatch. |
| `provider_session_ack_timeout` | Provider compatibility | Capture the requested and acknowledged session shapes without secrets. Verify model/API version and provider behavior. Keep the bridge non-production rather than weakening strict parity. |
| `provider_event_before_session_ack` | Provider protocol | The provider emitted response/audio/tool behavior before acknowledging configuration. Treat as incompatible or unsafe. |
| No caller audio reaches provider | Ack gate/backpressure | Confirm `provider.ready`, Twilio inbound media, PCMU payloads, and provider outbox stats. Media intentionally waits behind acknowledgement. |
| Caller hears stale audio after interruption | Marks/clear path | Check `playback.mark_acknowledged`, `playback.barge_in`, discarded frame counts, and truncation acknowledgement. Confirm the edge is not buffering WebSocket frames. |
| Tool seems duplicated | MCP durability | Query the durable receipt by application call, provider, and native provider call ID, then compare target/arguments hash. JSON-RPC ID is correlation only. Return the stored outcome; do not execute again. |
| Tool returns `stale_active_capability_catalog` | Flow/catalog authority | The model generated a later call from an old terminal-batch snapshot. Confirm no business dispatch occurred and the result carried the current catalog. Do not silently rebind it; let the next model turn use the replacement catalog. |
| `active_catalog_blocked` | Catalog refresh | No callable authority remains after a failed refresh. Reconcile durable flow state and reconnect with a server-authored catalog; never reconstruct grants in the bridge or prompt. |
| `authority_outcome_indeterminate` | Tool transport | A dispatch may have executed without a readable outcome. Reconcile the durable authority record before any manual retry. |
| Journal delivery fails or completion is missing | Event contract | Return a 2xx JSON body with exactly `{ok:true,batch_id:<same id>}`; deduplicate by `Idempotency-Key`; check event audience, StreamSid binding, rotated-token overlap, ingestion capacity, and the normal 10-second request deadline. |
| `socket_backpressure` or capacity failure | Sizing/downstream latency | Inspect provider/Twilio latency, WebSocket buffered bytes, queue sizes, pending marks, and active sessions. Reduce admission or fix the downstream before raising limits. |
| Shutdown reports `deadline` | Drain budget | Find slow tool, journal, or socket closure; reconcile unknown tools and pending event batches; increase grace only after measuring the blocking path. |

## Secret rotation

- **Twilio auth token:** coordinate the Twilio-side rotation and bridge rollout so signature validation never uses a stale token. Verify with a single authorized upgrade.
- **Provider keys:** roll bridge instances, then run a model-specific canary. Never return a key from the application bootstrap endpoint.
- **Bootstrap signer:** rotate in the application with a bounded overlap no longer than the maximum bootstrap TTL; keep replay records through each token's expiry. The bridge does not need this key.
- **Capability signer:** rotate application/verifier signing keys with a bounded key overlap. Per-call event/MCP/renewal credentials rotate automatically every 30 minutes with five minutes of old-token overlap; key rotation must preserve those verification windows and audience separation.

After any suspected credential exposure, revoke/rotate first, then search by hashes and call bindings. Do not paste the credential into logs, issues, terminal history, or incident documents.

## Scale and failure boundaries

Each upgraded call is owned by one bridge process for the WebSocket lifetime. A load balancer does not need cookie affinity after upgrade, but it must not migrate a live connection. The process holds media queues, playback marks, provider identities, tool-batch coordination, and undelivered journal events in memory.

Horizontal scaling therefore requires:

- a shared application replay store for bootstrap consumption and exact retry responses;
- shared durable MCP idempotency and event ingestion;
- shared durable capability-rotation generations and exact replay bundles;
- admission control consistent with per-instance memory and provider/Twilio quotas;
- termination grace and connection draining at both edge and process; and
- reconciliation for process loss during an indeterminate tool or before journal delivery.

The bridge's in-process tool replay cache prevents duplicate dispatch only while that process lives. It never replaces the authority-side record.

## Release sign-off packet

Attach all of the following to the release commit:

- `npm run check`, `npm test`, and coverage output;
- container digest and dependency audit decision;
- real application-contract compatibility results for bootstrap v3, rotation, MCP sessions/catalog envelopes, dropped responses, event overlap, and audience confusion;
- provider/model-specific live canary artifacts and exact spend;
- Twilio CallSid/StreamSid and application call-row evidence for each canary;
- barge-in, tool idempotency, disconnect, and graceful/forced drain artifacts;
- load/soak results at the configured limits, including a >30-minute logical/live continuity run;
- dashboard and alert links;
- transcript/recording consent, retention, and access-control review; and
- an explicit decision on crash loss for the in-memory journal.

Until that packet exists, preserve the development/non-production label in public documentation.

# Per-call operations projection

`web/lib/call-operations-projection.ts` turns the runtime evidence HACC already
produces into one provider-neutral, content-free view for call operations. It is
intended to be the stable input to a dashboard, alerting pipeline, incident
export, or fleet controller. It does not replace the underlying ledgers.

## Authenticated read API

After applying migration `039_call_operations_read_projection.sql`, an
authenticated builder/operator can read:

```http
GET /api/calls/{callId}/operations
```

The response is `{ "operations": ... }` and is always marked `private,
no-store`. The session organization is the only tenant selector; the route does
not accept an organization ID from the URL or query string. Missing calls and
calls owned by another organization both return `404`.

Set one independent 32-byte root key:

```dotenv
CALL_OPERATIONS_REDACTION_SECRET=<64 lowercase hex characters>
```

The server derives a different HMAC key for each organization. The database read
function repeats the organization predicate inside its `SECURITY DEFINER`
boundary and the runtime role retains no direct access to the underlying worker
or policy-decision tables.

The durable read joins:

- the Flow run and immutable action-receipt ledger;
- the organization-scoped materialized conversation sequence/hash head captured
  in the same SQL snapshot, without replaying the event log;
- bounded worker details plus complete worker status and delivery-state counts;
- append-only pre-dispatch policy decisions;
- action reconciliation and worker checkpoint/reclaim/indeterminate events; and
- per-source observation times.

The authenticated durable route deliberately reads only the conversation's
materialized sequence/hash head. It therefore does not expose the folded
kernel `policyEpoch` or infer worker-versus-current-policy drift. Those richer
cross-layer checks are available to in-process library callers that already
hold a verified `conversationState` and/or bounded context packets; the route
will not replay private conversation events to manufacture them.

`freshness.sources` reports last-domain-activity clocks, not database-ingestion
lag. The durable query reads each ledger synchronously, but a policy or worker
ledger can legitimately remain quiet during a healthy active call. Treat
`stale_operations_source` as a possible stuck-work signal to correlate with the
call phase, never as proof that the read model is behind. The default activity
threshold is 120 seconds. Terminal calls classify observed sources as `settled`
rather than raising this signal. `recovery` contains complete counts and at
most 256 recent HMAC-keyed observations.

This is a read model, not a command surface or a transactionally consistent
replacement for its ledgers. Each ledger remains the authority for repair,
reconciliation, worker delivery, or policy enforcement.

The on-demand projection has deliberate hard ceilings: the Flow ledger admits
at most 512 action receipts per call, while workers, policy observations, and
recovery observations are exact through 10,000 rows per call. Identity-safe
detail windows contain at most 256 items. A ledger over its ceiling fails
closed and the HTTP API returns
`operations_unavailable` (`503`) rather than presenting a truncated aggregate
as complete. Deployments expecting more than 10,000 observations in one call
should add maintained rollups or retention/partitioning before raising these
limits; silently increasing a parser limit does not make the database work
bounded.

Migration 039 validates the supporting index definitions and applies
function-local planner settings so cap probes use custom index plans.
PostgreSQL has no portable `FORCE INDEX` primitive: the release gate also
verifies adversarial `EXPLAIN (ANALYZE, BUFFERS)` plans on the supported
PostgreSQL major. Re-run that plan gate when upgrading PostgreSQL or changing
these indexes. The row ceilings are database-enforced; the physical-I/O claim
is evidence-bound to the verified planner and version.

## Library API

```ts
import { projectCallOperations } from "@/lib/call-operations-projection";

const projection = projectCallOperations({
  callId,
  redactionKey: organizationTelemetryKey,
  generatedAtMs: Date.now(),
  realtimeEvents,
  wireObservations,
  conversationState,
  flowState,
  policyDecisions,
  durableWorkers,
  contextPackets,
  costObservations,
});
```

Inputs are the existing normalized realtime events and wire observations,
conversation-kernel projection, Flow execution state and receipts, policy-kernel
decisions, durable workers, and compiled realtime context packets. Integrations
do not need a provider-specific telemetry adapter. Cost remains an explicit
observation because token or audio usage cannot be converted to money honestly
without a pinned pricing contract.

The result is a frozen `CallOperationsProjection` containing:

- connection epochs, redacted transport failures, frame counts, and byte counts;
- conversation, policy, capability-catalog, and Flow authority epochs plus
  cross-layer drift detection;
- policy denial counts and bounded recent denial metadata;
- action settlement counts, indeterminate-action age, dispatch attempts, and
  reconciliation state;
- joined durable-worker/kernel delivery state, lease health, checkpoints, and
  stale-policy detection;
- source freshness and bounded, keyed recovery history;
- latest/maximum context packet sizes and omitted audible-turn counts;
- first-output, response-completion, and tool-settlement latency distributions;
- de-duplicated provider usage meters and explicit estimated,
  provider-reported, and reconciled micro-USD totals; and
- a small, allowlisted `attention` set suitable for alerts.

`recentDenials`, indeterminate receipts, worker details, and connection detail
are bounded. Their aggregate counts remain complete, and attention signals use
those complete summaries so an older indeterminate action or undelivered worker
cannot disappear merely because it fell outside a 256-item detail window.

## Privacy and evidence rules

The projection never includes transcripts, audio, prompts, tool arguments,
tool results, worker inputs/results, provider session IDs, raw provider
payloads, free-form errors, or cost scope IDs.

The durable SQL projection also excludes worker resumable checkpoint bodies,
owner/lease tokens, action idempotency keys, policy evidence payloads, and raw
conversation events before data reaches the HTTP route. It reads the
conversation's transactionally maintained sequence/hash head in constant work;
the operations endpoint never replays or serializes the event log.

Operational identities are HMAC-SHA256 values derived with the caller-supplied
per-tenant `redactionKey`. A key shorter than 16 bytes is rejected. Structural
reason/error codes are emitted only when they match the closed lowercase code
shape; arbitrary text is represented only by a keyed digest. Already public
SHA-256 authority and catalog digests remain visible so operators can join
evidence without exposing content.

Cost observations use `(scopeId, source)` as a cumulative identity. A newer
observation replaces an older value for that pair. `settledMicroUsd` remains
`null` until every observed cost scope has a `reconciled` value. Usage events
are likewise reduced to the newest observation per provider/scope/identity so
session-cumulative or revised provider meters are not double-counted.

The projection reports discrepancies; it does not repair them. An
`indeterminate_action`, stale worker authority, or catalog drift must still be
resolved through the authoritative reconciliation/runtime path.

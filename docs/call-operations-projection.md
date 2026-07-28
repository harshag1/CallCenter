# Per-call operations projection

`web/lib/call-operations-projection.ts` turns the runtime evidence HACC already
produces into one provider-neutral, content-free view for call operations. It is
intended to be the stable input to a dashboard, alerting pipeline, incident
export, or fleet controller. It does not replace the underlying ledgers.

## API

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
- latest/maximum context packet sizes and omitted audible-turn counts;
- first-output, response-completion, and tool-settlement latency distributions;
- de-duplicated provider usage meters and explicit estimated,
  provider-reported, and reconciled micro-USD totals; and
- a small, allowlisted `attention` set suitable for alerts.

`recentDenials`, indeterminate receipts, worker details, and connection detail
are bounded. Their aggregate counts remain complete.

## Privacy and evidence rules

The projection never includes transcripts, audio, prompts, tool arguments,
tool results, worker inputs/results, provider session IDs, raw provider
payloads, free-form errors, or cost scope IDs.

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

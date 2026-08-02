# Governed effect runtime

This module is the provider-neutral execution boundary for consequential voice-agent tools. It
does not call a provider, own a database, or trust the model to decide whether an effect is safe.

The coordinator enforces this sequence:

1. Read the current authoritative state and policy.
2. Reject a proposal whose state revision, state head, or capability epoch is stale.
3. Evaluate the existing action-policy kernel against the exact arguments and evidence.
4. Atomically bind the allowed decision to a short capability lease and idempotent reservation.
5. Permit one bounded repair of an unopened reservation.
6. Atomically recheck authority while persisting the one-way dispatch marker.
7. Dispatch exactly once through an injected action adapter.
8. Settle a verified result, or quarantine an uncertain mutation as indeterminate.
9. Enqueue exactly one read-only reconciliation job for an indeterminate mutation.

## Durable store requirements

`GovernedEffectStore` is deliberately an interface. A production adapter must implement these
operations transactionally:

- `reserveAllowed` compares the live authority and reserves `(subjectId, idempotencyKey)` in one
  transaction. Reusing the key with another action, argument digest, policy, or proposal is a
  conflict, never a replay.
- `crossDispatchBoundary` compares the live authority and unexpired lease while writing the
  first and only dispatch marker. No provider I/O may occur before this succeeds.
- `settle` is immutable. An exact terminal replay is allowed; a different terminal outcome is
  rejected.
- `enqueueReconciliation` has a unique constraint on `receiptId`.
- `claimReconciliation` permits one attempt total, not one attempt per worker process.
- `repairBeforeDispatch` proves that no dispatch marker exists before changing an unopened
  reservation.

The store and provider adapters should be treated as trusted host code. Provider credentials and
raw private results must not be placed in public receipts.

## Failure semantics

| Observation | Durable disposition | Automatic mutation retry |
|---|---|---:|
| Denied policy or stale authority | No dispatch | No |
| Expired lease before boundary | Failed, unopened | No |
| Authoritative proof of no commit | Failed | No |
| Verified result satisfying current policy | Succeeded | No |
| Timeout, exception, malformed result, or authority advance after a write | Indeterminate | Never |
| Read-only reconciliation proves commit | Succeeded with proof | No |
| Read-only reconciliation proves absence | Failed with proof | No |
| Read-only reconciliation remains unknown | Indeterminate, terminal job | No |

`runReconciliation` invokes only adapters declaring `reconciliationEffect: "read"`. The adapter is
responsible for translating a pinned authoritative read-back contract into `committed`, `absent`,
or `unknown`; the model never supplies that disposition.

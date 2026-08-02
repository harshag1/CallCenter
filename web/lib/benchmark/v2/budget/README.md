# Dual-envelope paid admission

This module is the network-admission authority for the two independent HACC v2
spend envelopes:

- `api_testing`: exactly $100.000000
- `benchmark`: exactly $100.000000

Unused capacity never transfers between them. All amounts are integer
micro-USD.

## Runner contract

1. Initialize the ledger explicitly once. A missing ledger is never created by
   an admission attempt.
2. Calculate a pessimistic upper bound for one logical trial.
3. Call `admitDualEnvelopeSession` before DNS, connection, authentication, or
   provider bytes.
4. Open the network only when the returned receipt has
   `network_may_open === true`.
5. If an admission call is replayed, it returns the original durable receipt
   with `network_may_open === false` and `already_opened_quarantine`. Do not
   reconnect or replace that trial.
6. Record every opened trial's terminal outcome, including `failed`,
   `cancelled`, and `ambiguous`, then settle it only from reconciled billing
   evidence.

Admission and its intention-to-treat record are one lock-serialized, fsynced
mutation. There is deliberately no release or delete API for opened sessions.
A new operation cannot reuse a session or logical trial ID, even in the other
envelope or with another provider.

The ledger fails closed when missing, malformed, truncated, digest-invalid,
multi-linked, symlinked, oversized, or locked beyond the configured timeout.

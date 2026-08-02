# HACC runtime v2 persistence authority

Status: accepted for implementation; production admission remains closed until
the database and route gates below pass.

## Decision

HACC uses Postgres as the sole authority for conversation state and governed
effects. Runtime persistence exposes explicit, short, retry-safe operations. It
does not expose a general asynchronous transaction callback and never keeps a
database transaction, advisory lock, or actor lease open across provider I/O.

The legal commit boundaries are:

1. `appendPureTransition`: compare the expected program revision and Turn
   Contract digest, append canonical events, update the snapshot/head, and bump
   the revision in one transaction.
2. `reserveTransition`: perform the same authority checks and state transition,
   and atomically insert one immutable effect command with its semantic
   idempotency key, capability epoch, contract digest, arguments digest, and
   lease token.
3. `settleEffect`: append an authoritative receipt or an indeterminate outcome.
   An indeterminate outcome and its unique read-only reconciliation job commit
   atomically. Settlement records what happened; it never re-decides whether
   dispatch was allowed.

External dispatch happens strictly after a successful reservation commit and
before settlement. A one-way dispatch marker prevents blind re-dispatch.
Uncertain outcomes are resolved by authoritative read-back, not by repeating the
mutation.

## Authority invariants

- A program revision has at most one accepted next transition.
- The event append, snapshot/head update, revision bump, and optional effect
  reservation are one database commit.
- An effect command is immutable after reservation.
- A semantic idempotency key identifies one effect for one conversation scope.
- A stale revision, stale Turn Contract, stale capability epoch, or mismatched
  lease token fails closed.
- Dispatch is at most once unless a future effect class explicitly proves a
  provider idempotency contract; no such exception is admitted in v2.
- A crash after reservation cannot authorize a second reservation or dispatch.
- A crash after possible provider commit produces `indeterminate` and a unique
  reconciliation job.
- Reconciliation claims use expiring durable leases and can be reclaimed without
  repeating the original effect.
- A queue or per-conversation actor may schedule work, but cannot authorize it.
  Every worker must re-enter through the same Postgres comparison-and-swap
  boundary.
- Authority-relevant projections are updated synchronously in the same commit;
  asynchronous projectors may serve analytics only.

## Rejected designs

- Long transactions or advisory locks across provider I/O: serverless process
  loss releases the lock while the external effect may still commit, creating a
  duplicate-dispatch path and exhausting pooled connections.
- A durable actor as the primary authority: lease expiry and zombie workers can
  act on stale state. An actor is allowed only as a fenced scheduler if measured
  database reserve latency later exceeds the voice budget.
- A generic `transact(async callback)`: an implementation cannot safely retry or
  prove that an arbitrary callback did not cross the external-effect boundary.
- An asynchronously updated authority projector: it creates a stale-read window
  between the decision and the reservation.

## Progressive admission gates

Production routes stay closed until all gates pass:

1. Type gate: the store API has no callback-shaped transaction method and the
   coordinator compiles only against explicit reserve/settle operations.
2. In-memory conflict gate: randomized comparison-and-swap failures preserve the
   same program digest and never duplicate a reservation.
3. Local Postgres gate: concurrent reserves at one revision yield exactly one
   winner; crash cuts around reserve, marker, dispatch, settle, reconciliation
   claim, and reconciliation settle remain terminal or durably reconcilable.
4. Latency gate: a single reserve RPC is measured from the deployment region.
   Queue/actor infrastructure is considered only if measured p95 violates the
   preregistered speech-path budget.
5. Shadow gate: recorded reconnect/replay schedules pass through the production
   adapter with provider dispatch disabled.
6. Route gate: browser and PSTN write paths have no bypass around the governed
   reservation authority, and all evidence derives from production-emitted
   receipts.

The first live provider call remains prohibited until these provider-free gates
and a new hostile review pass from one exact clean commit.

## Review provenance

This decision incorporates an unverified Fable/Claude peer review captured in
`docs/research/external/2026-08-02-hacc-runtime-persistence-fable.md`. The review
is advisory only and is not benchmark or production evidence. Its central claim
was independently checked against the current callback-shaped store interface;
the implementation and progressive gates above remain the repository's own
authority.

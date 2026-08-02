---
provider: anthropic-claude-code
model: fable
timestamp: "2026-08-02T20:31:03.245668+00:00"
question: "What persistence and transaction architecture should HACC use to make its new RuntimeCoordinatorV2 production-safe on serverless Postgres/Supabase, given that external effect dispatch must never be retried but the current HaccRuntimeStoreV2 transaction callback can cross that dispatch boundary? Challenge the current interface and recommend the smallest progressively testable design that preserves one authoritative conversation program, governed effect receipts, crash recovery, and low voice-call latency."
context_files: ["/private/tmp/hacc-fable-context.md"]
total_cost_usd: 0.453048
usage: {"cache_creation": {"ephemeral_1h_input_tokens": 7063, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 7063, "cache_read_input_tokens": 0, "inference_geo": "not_available", "input_tokens": 2, "iterations": [{"cache_creation": {"ephemeral_1h_input_tokens": 7063, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 7063, "cache_read_input_tokens": 0, "input_tokens": 2, "output_tokens": 6180, "type": "message"}], "output_tokens": 6180, "server_tool_use": {"web_fetch_requests": 0, "web_search_requests": 0}, "service_tier": "standard", "speed": "standard"}
advisory_only: true
unverified_peer_review: true
must_verify_claims: true
---

> This is unverified peer-review input, not release or production evidence.

## Verdict

Agree with your leaning, with one sharpening: the problem is not just where dispatch runs — it is that `transact<T>` accepts an arbitrary async callback, so the "never retry across dispatch" rule is a comment, not a contract. Replace the general callback with pure, retry-safe state transitions plus an explicit reserve/settle command pair (Option 2), keep Postgres as the single authority, and treat any per-conversation queue (Option 3) as a scheduler only. Option 1 is unsafe on serverless Supabase and should be rejected outright.

## Assumptions

- The 61-test coordinator suite and the 100k/10k/10k stress proofs pass as described. No test output is in the packet, so I treat these as unverified claims; the recommendation does not depend on them being true, but the "what already holds" analysis does.
- The offline stress proofs run against an in-memory store, not a real Postgres implementation of `HaccRuntimeStoreV2`. The packet says components "are not yet wired into production routes" and describes the interface abstractly, which supports this, but it is inferred, not stated.
- Supabase access from serverless routes goes through the connection pooler (likely transaction mode) or RPCs; no session-pinned connections are guaranteed across await points.
- "Never retry dispatch" means effects are intentionally at-most-once, with indeterminacy resolved by read-only reconciliation — i.e., losing an effect under crash is preferred to duplicating it.

## Findings

- **P0 — Option 1 cannot be made safe on this stack.** A row/advisory lock held across provider I/O in a serverless function fails in exactly the dangerous direction: if the function is frozen or killed mid-dispatch, the connection drops, the lock releases, and a competing invocation acquires the lease while the external effect may still land. That is a duplicate-dispatch path, the one failure class your architecture forbids. Additionally, session-scoped advisory locks are unreliable through a transaction-mode pooler, and pool exhaustion under concurrent calls is a real availability risk. Evidence: packet's own description ("operationally poor... still does not make an opaque external effect transactional") understates this — it is a correctness failure, not just an operational one.
- **P0 — The current `transact` contract is unenforceable as written.** "Must never retry a callback that may have crossed an external dispatch boundary" combined with "the coordinator currently composes effect dispatch inside operations" means every conforming implementation must be exactly-once with no conflict handling — which a CAS store cannot provide and a lock store only provides until a connection drops (see above). The interface itself must change; no implementation choice rescues it.
- **P1 — Option 3 introduces dual authority unless fenced.** If a durable actor owns serialization while Postgres owns truth, an actor whose lease expired (or a zombie after redeploy) can dispatch against stale authority. This is preventable with fencing tokens checked at the reserve commit, but then Postgres is doing the serialization work anyway — the actor buys latency/ordering convenience, not correctness. Your leaning ("must not become authority") is right; the packet contains no latency evidence that an actor is *required*.
- **P1 — Option 4's projector creates a TOCTOU window.** If turn-contract or capability-epoch checks read a projected snapshot while reservations write the log, a stale projection can admit a reservation the current authority forbids. Separate *tables* are fine; separate *commit points* or asynchronous projection for authority-relevant state are not.
- **P2 — Crash between dispatch marker and settlement yields silent effect loss.** This is the intended cost of at-most-once, and your indeterminate/reconciliation machinery covers the bookkeeping, but for voice the user-facing symptom is dropped speech. Worth classifying effects: some (idempotent tool calls, provider requests accepting idempotency keys) could safely be at-least-once per class, reducing loss without violating the global rule.

## Options

- **Option 1 (long transaction across dispatch):** rejected — P0 above; the failure mode is the exact one being defended against.
- **Option 2 (reserve/settle command state machine):** two short transactions; the effect command table *is* the outbox; dispatch consumes an immutable command once. Failure modes: crash-between-phases (handled by existing marker/reconciliation design), and the risk of the settle transaction re-deciding rather than only recording — must be forbidden by contract.
- **Option 3 (durable actor as serializer):** lower reserve contention, natural ordering, but dual-authority risk and new infrastructure. Justified only if measured Postgres reserve latency fails the voice budget.
- **Option 4 (separate tables + outbox + projector):** fine as physical layout *inside* Option 2's single commit; unsafe if the projector sits between authority reads and reservation writes.

## Recommended path

Option 2, with these specifics:

1. **Kill the generic callback.** Replace `transact` with either (a) a callback that receives `current` and returns a *pure* transition — no I/O possible by construction, so CAS-with-retry becomes safe — or (b) explicit operations: `reserve(programId, expectedRevision, transition, effectCommand?) → {revision, effectId} | conflict` and `settle(programId, effectId, receipt | indeterminate)`. I'd do (b); it makes the two legal commit points the only API surface.
2. **One database, one commit per transition.** Program event append, snapshot/revision bump, and effect command reservation commit in the same Postgres transaction (a single Supabase RPC each). Effect receipts and program events may live in separate tables but never in separate commits or ledgers. The effect command row carries `(program_id, program_revision, turn_contract_hash, capability_epoch, lease_token)` frozen at reserve time.
3. **Dispatch strictly between commits.** In the hot path, dispatch inline in the same request immediately after the reserve commit (writing the dispatch marker first, per your existing rule); a durable worker sweeps unclaimed commands as crash fallback. This keeps voice latency at one short transaction before audio starts, with no queue hop in the common case.
4. **Settlement records, never re-decides.** The settle transaction validates the lease token and revision binding, admits the receipt or indeterminate marker, and recompiles authority. If authority moved (barge-in, reconnect), the receipt is still admitted as evidence; consequences flow through your existing stale-authority handling.
5. **TOCTOU closure:** the decision to dispatch is frozen at reserve commit against `expectedRevision`; any authority change after that point can only affect *future* reservations and how the receipt is interpreted, never whether the in-flight command re-fires. Stale claimants are rejected at settle by lease token, which you already built.

## Strongest objection

"Pure transitions plus reserve/settle is just Option 2 relabeled — the real risk is latency: two round trips to a pooled serverless Postgres per governed effect, in a voice loop, may blow the budget, and then you'll bolt on the actor anyway, so start with Option 3." This has force because the packet contains zero latency measurements. My answer: the settle transaction is off the critical audio path, so the hot path costs one RPC commit; measure that (test 4 below) before paying for actor infrastructure. If p95 reserve latency fails the budget, add the actor as scheduler with fencing at reserve — the Postgres design is a prerequisite for the actor design, not an alternative, so nothing is wasted.

## Missing proof

- Any Postgres-backed implementation of the store, or evidence the stress proofs touch a real database. All current proofs (if they pass) validate coordinator logic against an in-memory store only.
- Supabase connection mode in production routes (pooler transaction vs. session) — determines whether advisory locks are even on the table and what RPC atomicity guarantees hold.
- Latency numbers for a single-RPC reserve commit from the serverless region to Supabase.
- Test output for the 61-test suite and stress proofs (claimed, not shown).
- Whether serverless functions in your platform reliably complete inline post-commit dispatch before freeze/termination (affects step 3 vs. worker-only dispatch).
- Contents of the untracked `web/lib/benchmark/v2/caller/` and `runner/` directories — they may already embody assumptions about the store interface.

## Progressive next tests

1. **Type-level falsification (minutes):** rewrite the store interface as reserve/settle (or pure-transition callback) and compile the coordinator against it. Every compile error is a place where dispatch currently crosses the boundary — this is the cheapest complete inventory of the problem.
2. **In-memory conflict injection:** implement a fake store that randomly fails CAS and retries pure transitions; rerun the 61-test suite and the 100k/10k/10k stress against the two-phase coordinator. Falsifies "the coordinator's invariants survive retried transitions."
3. **Local Postgres (Docker):** implement reserve/settle as SQL functions; property-test concurrent reserves on one program (exactly one winner per revision), and kill the process between reserve→dispatch and dispatch→settle, verifying reconciliation admits indeterminate and never redispatches.
4. **Supabase local (CLI) via transaction-mode pooler:** confirm RPC atomicity without session state, then measure reserve-commit p50/p95 under concurrent conversations. This is the actor-necessity gate.
5. **First shared-state step:** a staging Supabase project running recorded reconnect/replay schedules in shadow mode, still with zero provider spend and no production route changes.

## Questions for Harsha

- Which connection mode do the production route handlers use to reach Supabase (transaction pooler, session pooler, direct), and are you willing to constrain the design to transaction-mode semantics?
- What is the latency budget for the reserve commit on the speech critical path (the number that would justify Option 3)?
- Should effects be classified so that provably idempotent classes (e.g., provider calls with idempotency keys) may be at-least-once, or is at-most-once a uniform invariant?
- On your serverless platform, is post-response or post-commit inline work reliably executed, or must all dispatch go through the durable worker?
- Do the untracked `caller/` and `runner/` directories assume the current `transact` interface?

## Confidence

0.85 that the reserve/settle variant of Option 2 (pure transitions, single-commit authority, inline dispatch with worker fallback) is the correct architecture; 0.6 that the two-transaction hot path meets voice latency without an actor, pending the measurement in test 4. Confidence in the "current state" claims (test passes, stress proofs) is deliberately lower — they are asserted without evidence in the packet.

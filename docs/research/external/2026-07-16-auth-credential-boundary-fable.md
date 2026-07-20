---
provider: anthropic-claude-code
model: fable
timestamp: "2026-07-17T03:38:30.849119+00:00"
question: "# Question\n\nHostile-review the proposed public-release auth and credential boundary for Harsha's Amazing Call Center. What P0/P1 flaw remains in its transaction semantics, tenant binding, credential replay/AAD design, or migration upgrade/reapply behavior? Prefer a concrete counterexample and the smallest progressive test that would prove or falsify it."
context_files: []
total_cost_usd: 0.45849874999999995
usage: {"cache_creation": {"ephemeral_1h_input_tokens": 9357, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 9357, "cache_read_input_tokens": 4545, "inference_geo": "not_available", "input_tokens": 2, "iterations": [], "output_tokens": 15613, "server_tool_use": {"web_fetch_requests": 0, "web_search_requests": 0}, "service_tier": "standard", "speed": "standard"}
advisory_only: true
unverified_peer_review: true
must_verify_claims: true
---

> This is unverified peer-review input, not release or production evidence.

## Verdict
Not release-ready on the stated evidence. One concrete, release-blocking gap is unproven and plausibly broken: the credential envelope's AAD binds the **ephemeral credential-slot UUID**, but nothing in the packet shows that the slot UUID is durably persisted on the sink and that decryption still succeeds **after the 10-minute slot is expired/pruned**. If the reader reconstructs AAD from the slot row, every stored credential becomes undecryptable once cleanup runs — a fail-closed-to-broken outcome that the happy-path "context-bound decrypt" test would not catch. Treat as P1 (P0 if confirmed) pending one cheap test. The rest of the boundary looks well-constructed and largely proven.

## Assumptions
- I am reasoning from the prose packet only; I have not read `web/lib/vault.ts`, `web/lib/credential-vault.ts`, or `017_*.sql`. Every claim below is an inference about behavior the packet does not explicitly state, not a reading of code.
- "Slots expire after 10 minutes / max 25 non-expired slots" implies an expiry sweep that eventually removes slot rows (including completed ones). If completed slots are retained forever, the lead finding weakens.
- The AAD component described as "credential slot UUID" is genuinely the slot's identifier, not a stable per-sink key reused across re-registrations.
- The integration test "context-bound env/MCP decrypt" decrypted while the slot still existed (immediately after commit), because the packet does not say it pruned the slot first.

## Findings
- **P1 (→P0 if confirmed): AAD depends on ephemeral slot identity; post-prune decrypt is unproven.** Packet: envelope AAD covers "domain/version plus exact lowercased org UUID, sink kind, env name or MCP server UUID, and credential slot UUID"; sink completion "stores non-secret receipt + browser submission UUID" — the slot UUID is conspicuously not listed among what the sink stores. Decrypt must reconstruct the exact AAD. If the slot UUID is read from the (transient) slot row rather than a durable sink column, decryption of all credentials fails after the slot is pruned. Counterexample below.
- **P1: Commit-time lease fencing is unspecified for slow MCP discovery.** Packet: claim sets a "45-second lease," "MCP discovery happens before the DB commit," and the commit is "one CTE statement." If MCP discovery exceeds 45s, a same-`submission_id` retry can re-claim the slot (attempt 2). Whether the commit CTE fences on the *claiming request's* lease/attempt token or merely on `status='claimed'` is not stated. Status-only fencing keeps the DB single-writer but lets the stale (lease-expired) committer win; the tested cases ("25-way finalization pressure," "five-attempt exhaustion") do not appear to exercise lease expiry mid-discovery. External double-registration in this window is the acknowledged receipt-indeterminate limitation; the un-acknowledged part is which writer's context/ciphertext lands in the sink.
- **P2 (accepted/availability): Rolling-deploy old writers fail NOT NULL on `token_hash_version`.** This is intended fail-closed behavior and is proven ("old-shape writer fails"). Noted only so it is not mistaken for a defect: it degrades login on not-yet-upgraded instances during the rollout window.

No P0 is asserted as *proven*; the P0 risk is contingent on the first finding.

## Options
1. **Ship after one targeted post-prune decrypt test (recommended).** Failure mode: if the test reveals AAD reconstruction from the slot row, you've caught a production-breaking bug before release for the cost of one integration test.
2. **Redesign AAD to drop the slot UUID, binding only to durable sink identity (org + sink kind + env name/MCP UUID + version).** Failure mode: loses the slot-scoped anti-confusion property; you'd need to argue that org+kind+name already uniquely and immutably identifies the destination. Larger change, more review surface.
3. **Persist the slot UUID as an explicit sink column and prove it (smaller than #2).** Failure mode: none structurally, but it entrenches coupling of permanent ciphertext to a transient object's identity — a smell that will resurface on re-registration semantics.
4. **Ship as-is on current evidence.** Failure mode: the exact unproven case (credentials undecryptable after cleanup) is the kind of thing that passes every CI run and fails in production 10 minutes after the first credential is stored.

## Recommended path
Take Option 1 first: run the smallest post-prune decrypt test. If it passes, the lead P1 collapses to "prove the sink column exists" and you're close to release-grade for this boundary. If it fails, adopt Option 3. Independently, add a lease-expiry-during-discovery unit test to close the second P1 before you rely on the exactly-once sink claim.

## Strongest objection
"The commit CTE obviously has the slot UUID in hand and stores it, and decrypt reconstructs AAD from the sink row; the passing `context-bound decrypt` integration test proves it." This is the most likely reality and would downgrade the finding to non-issue. My rebuttal: the packet's own enumeration of what completion stores omits the slot UUID, and no test is described that decrypts *after* the slot is gone — so the load-bearing property (durability of the AAD input across slot lifetime) is exactly the thing not yet demonstrated. A hostile review flags the untested seam, not the plausible happy case.

## Missing proof
- A statement/column showing the credential slot UUID is written to the env/MCP sink row and is the source used to reconstruct AAD at decrypt time.
- An integration assertion: encrypt+commit a credential, delete/expire the slot row, then decrypt and get plaintext.
- The commit CTE's `WHERE` predicate, specifically whether it fences on the claiming request's lease/attempt token or only on `status`.
- Confirmation of the expiry sweep's treatment of *completed* slots (retained vs pruned).

## Progressive next tests
1. **Static (seconds):** Grep the sink INSERT/UPDATE in `credential-vault.ts` and the AAD builder in `vault.ts`; confirm the slot UUID is read from a sink column at decrypt, not from a slot lookup. Falsifies or confirms the lead finding with no DB.
2. **Focused unit (seconds):** Encrypt with a slot UUID, then call `decryptCredentialSecret` reconstructing AAD purely from persisted sink fields; assert success. Then mutate any single AAD field; assert GCM failure.
3. **Disposable Postgres integration (minutes):** Commit an env and an MCP credential; explicitly `DELETE` the slot rows (simulate the 10-minute sweep); then decrypt both. Expect plaintext. This is the direct counterexample check.
4. **Disposable Postgres integration, lease race (minutes):** Inject an MCP discovery that stalls past a shortened lease; issue a same-`submission_id` retry that re-claims and commits; then release the first request's commit. Assert exactly one sink row, a terminal/indeterminate state for the loser, and that the *winner's* context UUID matches the persisted ciphertext's AAD.
5. **Shared-state, last:** Only after 1–4 are green, re-run the full 001-017 chain plus the combined gate. No provider calls, no production deploy.

## Questions for Harsha
- Does the env/MCP sink store the credential slot UUID in its own column, and is that the AAD source at decrypt time?
- Are completed slots pruned by the expiry sweep, or retained indefinitely?
- Does the finalization commit CTE fence on the claiming request's lease/attempt token, or only on slot status?
- Did the `context-bound decrypt` test decrypt before or after the slot was removed?

## Confidence
0.55 that at least one of the two P1s is a real defect; 0.35 that the AAD-durability issue specifically is broken (it's plausibly already handled in code I cannot see). High confidence (0.9) that the packet does not yet contain evidence that decrypt survives slot pruning or that commit fences on lease identity — so regardless of the underlying code, the *evidence* is insufficient for release on the terms you set ("fail closed under retries and rolling upgrades"). The tests in items 1–3 will move this to near-certain either way within minutes.

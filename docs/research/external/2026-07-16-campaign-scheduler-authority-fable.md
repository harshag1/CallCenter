---
provider: anthropic-claude-code
model: fable
timestamp: "2026-07-17T03:29:15.482810+00:00"
question: "Challenge the current outbound campaign scheduler and private recipient-approval architecture as a hostile peer reviewer. Identify any remaining P0/P1 correctness, exactly-once, cancellation, tenant-isolation, privacy, or usability failure. Recommend the smallest progressive tests that could falsify the design before open-source release."
context_files: []
total_cost_usd: 0.752466
usage: {"cache_creation": {"ephemeral_1h_input_tokens": 13400, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 13400, "cache_read_input_tokens": 0, "inference_geo": "not_available", "input_tokens": 2, "iterations": [{"cache_creation": {"ephemeral_1h_input_tokens": 13400, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 13400, "cache_read_input_tokens": 0, "input_tokens": 2, "output_tokens": 9548, "type": "message"}], "output_tokens": 9548, "server_tool_use": {"web_fetch_requests": 0, "web_search_requests": 0}, "service_tier": "standard", "speed": "standard"}
advisory_only: true
unverified_peer_review: true
must_verify_claims: true
---

> This is unverified peer-review input, not release or production evidence.

## Verdict

The core at-most-once design (reserve-before-dispatch, write-once boundary trigger, never-retry-indeterminate) is sound in its bias toward lost calls over double calls, and the recheck-everything dispatcher is the right shape. But the release gate is not met: the two admitted test gaps (private-display leakage, two-worker barrier) are exactly the tests that could falsify the design, and I found three material issues the packet does not list — ambiguous-commit handling at the boundary, phone numbers in provider-error/log paths, and an indeterminate-campaign liveness trap. Do not release before these are addressed or disproven.

## Assumptions

- The packet's prose descriptions of `dialDue`, `originateCall`, and the trigger accurately reflect the code; I cannot read the files.
- "29/29" and "21/21" test results and the disposable-Postgres integration evidence are true as stated, but cover only what they enumerate.
- Lease expiry comparisons use database time (`now()`), not application clocks. Not stated; flagged below.
- Job commitment checks at claim time compare **stored** commitment values rather than recomputing HMAC with the current secret. The packet implies this ("rotation… does not alter already-materialized jobs") but does not prove it.
- The Twilio POST necessarily contains the raw recipient in `To`; no design can avoid that at the provider boundary.

## Findings

**P1 — Ambiguous transaction commit at the dispatch boundary is unaddressed.** The design commits `dispatch_started_at` before the sole provider POST (packet §7). If the COMMIT outcome is ambiguous (connection reset after COMMIT sent), the worker cannot know whether the boundary landed. If the code treats ambiguity as success and POSTs while the commit actually failed, the row is still pre-boundary, another worker reclaims it, and you get **two provider POSTs for one job** — precisely your stated decision-changer. The safe rule is: any commit error or uncertainty → do not POST (accepting a possibly-lost call). Nothing in the packet or test list asserts this rule exists.

**P1 — Provider-error paths are the most likely phone-number log leak, and they are not in the leakage test plan.** The leakage sinks enumerated (model tool output, chat persistence, SSE, logs via serialization) focus on the proposal/display path. But timeouts, 5xx bodies, malformed-response errors, and HTTP-client exceptions routinely embed the request URL/body — which contains `To=<phone>`. The typed error is stated to preserve SID/account (§8) but nothing says it scrubs the recipient. This bypasses the non-enumerable-property control entirely.

**P1 — Non-enumerable frozen `displayTargets` is a convention, not a control.** It defeats `JSON.stringify` and spread (§2), but not `Reflect.ownKeys`, `Object.getOwnPropertyDescriptors`, `util.inspect` with `showHidden`, or any future logger/serializer that walks own keys. The recipients live in the same object graph handed to the tool layer; one new consumer breaks the invariant silently. The packet's own limitations section concedes the negative tests don't exist yet. This is acceptable only as defense-in-depth with sentinel tests over every real sink.

**P1 — Indeterminate campaigns create a tenant-wide liveness trap.** Indeterminate jobs are never retried (§8, correct), indeterminate campaigns block all agent-version activation and flow edits (§10), and the reconciliation UX is admittedly immature. One 15-second Twilio timeout can therefore freeze a tenant's ability to edit anything, indefinitely, with no described resolution path. There is also a sibling gap: a crash after the boundary commit but before the POST leaves a job post-boundary, non-requeueable, with **no provider record at all** — the reconciliation log described in §8 only covers the accepted-SID-settlement-failure case, not committed-boundary-no-POST.

**P1 — The two decisive concurrency tests don't exist.** Cancel-vs-boundary in both orderings and two workers against the exact production `dialDue` SQL with a provider barrier are both listed as your own falsification criteria and both admitted missing. Related detail to pin down: §7 says `originateCall` "locks campaign first" — it must also **recheck campaign status is running after acquiring the lock**, or cancel-before-boundary can still dispatch. The prose lists lease/authority/runtime rechecks but not campaign status.

**P2 — HMAC secret rotation vs. in-flight claims.** If any claim-time check recomputes the commitment with the current secret instead of comparing stored values, rotation stalls running campaigns. One assertion test settles it.

**P2 — Approval usability is cryptographically exact but not meaningfully informed.** A human approving a commitment over 5,000 numbers cannot review 5,000 numbers. The approval is server-authoritative but the human's mental model is "the dataset I think it is." Show count, dataset provenance/version, skip reasons, a sample, and a diff against the tenant's prior campaign.

**P2 — Launch-transaction retry semantics.** SERIALIZABLE inserts of campaign + 5,000 jobs will hit serialization failures under load; retry is safe only if a unique-violation on campaign ID (= execution ID) is treated as "already launched, verify and succeed" rather than as an error.

## Options

1. **Ship after only the two admitted test gaps close.** Fastest, but leaves ambiguous-commit, provider-error scrubbing, and the indeterminate liveness trap unexamined — the first is a direct double-dial path.
2. **Add a Twilio-side reconciliation loop** (query the Calls list filtered by outbound caller ID and time window) to resolve indeterminate and committed-no-POST jobs, plus an operator quarantine action that releases the edit lock without reopening jobs. Failure mode: reconciliation queries are eventually consistent and can misclassify very recent calls — mitigate with a minimum age before resolution.
3. **Replace the non-enumerable trick with structural separation**: the preview function never returns recipients at all; the tool receives only a proposal handle and the recipients go straight to the private store. Failure mode: more plumbing now, but it converts a convention into a type-level impossibility. Worth doing before open-sourcing, since external contributors won't know the convention.
4. **Shorter path: keep current structure, enforce with sentinel tests** on every serializer/log sink in CI. Cheaper, weaker; acceptable if option 3 is deferred.

## Recommended path

Keep the reserve-before-dispatch architecture. Before release: (1) add the explicit ambiguous-commit rule (any commit error/uncertainty → no POST) with an injection test; (2) run the planned disposable-Postgres barrier suite including a cancel-status recheck assertion inside `originateCall`; (3) add sentinel-phone leakage tests covering provider-error/log paths, not just proposal serialization; (4) add the Twilio list-calls reconciliation loop and an operator quarantine path so indeterminate never permanently freezes tenant edits; (5) prefer option 3 (structural separation of recipients) over the non-enumerable convention before external contributors touch this code.

## Strongest objection

The design's exactly-once guarantee rests entirely on "commit boundary, then POST exactly once" — but the packet never states how a **failed or ambiguous commit** is distinguished from a successful one before POSTing. If that distinction is wrong in either direction, you get either the reproducible double-POST you named as a decision-changer, or silently lost calls with no reconciliation record. This is the one place where the design document is silent on its own load-bearing step.

## Missing proof

- That `originateCall` rechecks campaign status (not merely locks the campaign) after lock acquisition.
- That commit errors/ambiguity at the boundary suppress the POST.
- That typed provider errors and all HTTP-client failure paths scrub `To` before logging.
- That claim-time commitment checks compare stored values (rotation-safe).
- That lease expiry uses database time, not worker clocks.
- Any negative test on the private display route (cross-org, actor, expiry, headers) — admitted absent.
- Any resolution path for committed-boundary-no-POST rows.

## Progressive next tests

1. **Unit, seconds:** sentinel phone in `displayTargets`; run every serializer actually used in the codebase (`JSON.stringify`, spread, `structuredClone`, `Reflect.ownKeys`, `util.inspect({showHidden:true})`, the real logger, the SSE encoder, chat persistence) and assert the sentinel never appears.
2. **Unit, seconds:** inject a thrown/ambiguous COMMIT in `originateCall`; assert the mocked provider fetch count is 0 and the job's terminal state is recoverable or documented.
3. **Unit, seconds:** force timeout/5xx/malformed/oversize provider responses with a sentinel `To`; assert the sentinel appears in no error message, typed-error field, or log line.
4. **Disposable Postgres, minutes:** exact production `dialDue` SQL, two workers, provider barrier; assert POST ≤ 1 per job ID; cancel-vs-boundary both orderings; stale-token fence; crash before/after boundary; secret-rotation mid-campaign claim.
5. **Integration, minutes:** private display route — cross-org denial, wrong actor, expired proposal, `no-store` headers, sentinel absent from SSE/chat/model transcripts.
6. Only after 1–5 pass: any staging run touching a real provider account.

## Questions for Harsha

- How does `originateCall` handle a commit error or dropped connection at the boundary — is "no POST on any commit uncertainty" enforced in code today?
- After locking the campaign, does `originateCall` explicitly recheck the campaign is still running?
- Do typed provider errors and HTTP-client exceptions scrub the recipient from messages before any logging?
- What is the operator's path out of an indeterminate campaign — is there a quarantine/force-resolve action, and does it release the edit lock?
- At claim time, is the target commitment compared as a stored value or recomputed with the current HMAC secret?
- What does the approval UI actually show for a 5,000-recipient campaign — full list, sample, provenance, diff?

## Confidence

0.85 that the core at-most-once boundary design is correct **if** the ambiguous-commit rule and the campaign-status recheck exist in code; 0.5 that they do, since the packet is silent on both. 0.9 that at least one of the sentinel leakage tests (provider-error path especially) would find a phone-number leak in its current untested state — that class of leak is near-universal in HTTP-client error handling. Overall: the architecture is releasable after the tests above pass; it is not releasable on today's evidence.

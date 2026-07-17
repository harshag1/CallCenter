---
provider: anthropic-claude-code
model: fable
timestamp: "2026-07-17T04:19:13.534599+00:00"
question: "What is the smallest defensible progressive test and release-gate sequence for this provider-neutral voice-agent framework before opening any paid OpenAI, xAI, or Gemini realtime session, and which current claim or architecture assumption is most likely to be falsely reassuring?"
context_files: ["/private/tmp/fable-precanary-context.md"]
total_cost_usd: 0.6876190000000001
usage: {"cache_creation": {"ephemeral_1h_input_tokens": 15281, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 15281, "cache_read_input_tokens": 0, "inference_geo": "not_available", "input_tokens": 2, "iterations": [{"cache_creation": {"ephemeral_1h_input_tokens": 15281, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 15281, "cache_read_input_tokens": 0, "input_tokens": 2, "output_tokens": 7470, "type": "message"}], "output_tokens": 7470, "server_tool_use": {"web_fetch_requests": 0, "web_search_requests": 0}, "service_tier": "standard", "speed": "standard"}
advisory_only: true
unverified_peer_review: true
must_verify_claims: true
---

> This is unverified peer-review input, not release or production evidence.

## Verdict

Option A is directionally right, but as specified it is not yet the smallest *defensible* boundary. Two amendments are required before the first dollar: (1) the deterministic provider-emulator run of the paid-runner verification chain must be promoted from "evidence that would change the decision" to a mandatory gate, because it is the cheapest test that can falsify stop-ship 6 before spend; and (2) the transport smoke needs pre-declared, per-provider success artifacts and clarified retry semantics, otherwise a no-retry failure yields zero information for $5. The most falsely reassuring assumption in the packet is that Gate 1, as frozen, produces "transport/configuration feasibility evidence" — for at least Gemini, and for any provider under the no-retry rule, it may produce no interpretable evidence at all.

## Assumptions

I am treating the following as facts because the packet states them: provider spend is $0; HEAD is `06e5d9f` with a large dirty tree (~28k insertions, 170 untracked files); the prior full web result was 1,119/20/35; the prior full bridge 102/102 predates the rotation/bootstrap expansion; the bridge hang cause is unclassified. I am treating as *inference, not fact*: that the "repaired since" web failures actually pass on the current tree; that the $5 cap is enforced in code rather than by reservation policy; that the emulator is cheap to build (depends on whether the live clients accept an injectable transport — not evidenced either way).

## Findings

- **P0 — All quantitative evidence is stale relative to the tree that would spend money.** Every passing count cited (79/79, 56/56, 91-test slice, 102/102 bridge) is from earlier checkpoints, and the working tree has since absorbed ~28k inserted lines across the exact spend-path surfaces (`realtime/client/*`, `telephony`, `voice.ts`, `campaigns.ts`, `mcp.ts`). The packet acknowledges the fresh gate is pending; the finding is that until it runs, *no* current claim of test coverage is true. The leaning (run A "after one clean-commit one-shot local gate") is correct, and this finding blocks everything downstream.
- **P0 — Stop-ship 6 has no falsifying test.** The paid runner must "independently verify the signed plan, freeze lock, signer ownership, pricing/formula hashes, reservation, and provider identity before credential read or client construction." Nothing in the evidence section exercises this path, positively or negatively. The first real execution of that verification chain would otherwise be the first paid session — the exact anti-pattern the rest of the design avoids. The emulator listed under "evidence that would change the decision" is the smallest falsifier and should be a hard prerequisite, including negative cases (tampered plan signature, mutated pricing hash, wrong provider identity → refusal *before* credential read).
- **P1 — Gate 1's evidentiary value is asserted, not established.** The packet's own kill-criterion says that if sessions cannot expose trustworthy configuration/session identity, the smoke "is not evidentiary and should be replaced by protocol conformance only." Gemini is already known to have weak configuration acknowledgement. Combined with no-retry, a smoke failure is uninterpretable (transient handshake vs. harness defect vs. provider drift) and a smoke success may prove only "a socket opened once." Without a pre-declared artifact per provider defining success (which exact acknowledgement frames, session/config echo, and captured transcript constitute a pass), $15 can be spent for zero bits.
- **P1 — The bridge hang is an unclassified go/no-go fork.** The packet's own criterion blocks the smoke if the hang is a production lifecycle defect rather than test cleanup. It is currently indeterminate, and `bridge/server.js` is in-path for a "full-harness" smoke. This must be classified, not just bounded with teardown timeouts — a timeout that masks a real lifecycle defect converts a P1 into false comfort.
- **P2 — Secret scan gap intersects with 170 untracked files and a redacted sensitive path.** The packet omits a sensitive path from the status listing, which suggests sensitive material exists in or near the tree. The scan must run against the frozen commit *including* what happens to the untracked files (committed vs. excluded), and reachable history, before any publish action.
- **P2 — 35 skipped web tests are unaccounted.** A "0 failures" gate can silently mask disabled coverage; the one-shot gate should enumerate and justify skips or they become invisible debt at release time.

## Options

- **A (transport smoke after clean local gate)** — Shortest path to learning about live protocol drift; failure mode: spends money through an unverified paid-runner path and may return uninterpretable results under no-retry.
- **A′ (recommended): A plus mandatory emulator gate and pre-declared smoke artifacts** — Adds hours, not days; closes the two ways A can waste its budget. Failure mode: if the live clients don't admit an injectable transport, the emulator itself becomes a refactor project — in that case, fall back to A with the negative-verification tests run against the runner in isolation.
- **B (finish full C4 chain first)** — Maximally conservative on claim validity but conflates two independent risks: protocol feasibility and scientific claim eligibility. Provider protocol drift is time-dependent; delaying transport learning weeks buys nothing for the efficacy chain and risks building C4 against stale protocol assumptions.
- **C (best provider first, repair, then others)** — Better feedback loop in the abstract, but it breaks the frozen equal-treatment design and introduces asymmetric harness maturity across providers, which contaminates any later paired comparison. Rightly rejected.

## Recommended path

Run A′: freeze the tree into one commit; run the one-shot local gate exactly as specified in the packet's "next progressive test boundary," with three additions — classify the bridge hang before accepting any bounded-teardown pass, enumerate the web-suite skips, and insert the emulator run (with negative tests) as the final local gate. Before materializing reservations, write down per-provider smoke success artifacts and decide the retry question below. Then open providers sequentially. Order within the sequence by configuration-acknowledgement strength (OpenAI, xAI, Gemini) — this does not violate the freeze so long as all three run in one gate window with no harness repair between them. Treat Gemini's result as transport-only regardless of outcome, consistent with C3-only status.

## Strongest objection

The strongest objection to my own recommendation: the emulator prerequisite could become exactly the kind of scope creep the frozen gate was designed to prevent — a "cheap deterministic emulator" that turns into a week of client refactoring, during which provider protocols drift further and the team burns motivation on scaffolding. If the injectable-transport check (see next tests, step 1) shows the emulator is expensive, the defensible fallback is narrower: unit-level negative tests of the paid-runner's verification function in isolation, plus a dry-run mode that executes everything up to but excluding credential read. That preserves the falsification of stop-ship 6 without blocking on an emulator.

## Missing proof

- Fresh, SHA-bound full web and bridge results on the frozen commit (the "repaired since" claim is currently unevidenced).
- Root-cause classification of the bridge integration hang (test cleanup vs. server lifecycle).
- Any execution transcript — even simulated — of the paid-runner verification chain, including refusals on tampered inputs.
- Evidence that the $5 cap is enforced mechanically (session duration/byte ceiling with forced close) rather than by reservation accounting alone.
- Per-provider definitions of what acknowledgement frames constitute a "transport/configuration pass," especially whether Gemini can produce any trustworthy configuration echo.
- Secret-scan output for the frozen commit and reachable history, with the disposition of the 170 untracked files decided.

## Progressive next tests

1. **Injectable-transport check (minutes, read-only):** confirm whether `openai-compatible.ts`, `gemini-live.ts`, and the xAI client accept an injected socket/transport. This decides emulator-vs-fallback before anything else is scheduled.
2. **Freeze the tree into one commit;** record the SHA all subsequent evidence binds to; decide untracked-file disposition.
3. **Typecheck + secret scan** (tree and reachable history) on the frozen commit.
4. **Bridge hang isolation:** run only the hanging integration test with open-handle diagnostics to classify test-cleanup vs. production lifecycle defect. This is the cheapest resolution of a declared kill-criterion and should precede the expensive full suites.
5. **Full web suite** — require 0 failures and an enumerated skip list.
6. **Full bridge suite** with bounded teardown, accepted only if step 4 classified the hang as test-side.
7. **Disposable PostgreSQL apply/reapply, RLS, runtime-role proofs** (re-run on frozen commit).
8. **Double offline benchmark generation** — byte-identical artifacts and signature verification.
9. **Emulator (or fallback dry-run) of the paid runner:** happy path plus refusals on tampered plan signature, wrong pricing hash, wrong provider identity, missing freeze lock — all asserted to fail *before* credential read.
10. **First shared-state/paid action:** materialize the frozen reservations and run the three transport smokes sequentially against pre-declared success artifacts.

## Questions for Harsha

- Does "no retry" apply to failures that occur before any billable event (e.g., TLS/handshake rejection with zero audio sent)? If yes, a transient network error permanently consumes a provider's slot — is that intended, or should the freeze distinguish pre-billable from post-billable failure?
- What exact acknowledgement does each provider's session emit that you would accept as configuration identity, and does Gemini emit *any* — or should Gemini's slot be re-scoped to protocol conformance now, per your own kill-criterion?
- Is the $5 cap enforced in code (forced session close on a duration/byte ceiling), or only by reservation accounting?
- Are the 170 untracked files intended to be part of the frozen evidence commit, and does the redacted sensitive path contain material the secret scan must cover?

## Confidence

0.8 that A′ (clean-commit gate + mandatory paid-runner falsification + pre-declared smoke artifacts, then sequential smokes) is the smallest defensible sequence. 0.7 that the Gate 1 evidentiary-value assumption is the single most falsely reassuring claim — the main rival is the unproven "failures have since been repaired" claim, but that one is already scheduled to be tested by the fresh gate, whereas the smoke's interpretability gap is not currently scheduled to be tested by anything.

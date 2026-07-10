# Decision-to-evidence ledger

<!-- markdownlint-disable MD013 MD060 -->

This ledger prevents an architectural preference from turning into a public performance claim without evidence. Every retained benchmark/framework decision receives an evidence class and an explicit next gate.

Evidence classes:

- **C0 — design only:** rationale or prior art, no executable evidence;
- **C1 — unit/property proof:** local invariants and adversarial tests;
- **C2 — seeded sensitivity:** same scripted intent/fault stream compared across runtime conditions;
- **C3 — paid transport canary:** true provider audio/tool transport works and artifacts verify, not performance evidence;
- **C4 — paired exploratory model evidence:** same model/voice/audio/world in both arms with numerical outcomes;
- **C5 — confirmatory evidence:** frozen held-out design and claim gate pass.

Only C4 or C5 can support “the framework outperforms the raw model.” C1/C2 can support implementation or containment claims. C3 supports compatibility only.

| Decision | Why it exists | Current evidence | Current class | Numerical artifact | Next required gate |
|---|---|---|---|---|---|
| One stable native `capability_gateway` across providers/arms | Avoid provider-native tool-shape confounding while logical authority changes | Compiler parity and gateway treatment tests | C1 | Focused compiler/kernel tests; no model outcome | Verify exact acknowledged schema in all three paid transport canaries |
| Progressive disclosure | Reduce irrelevant choice/context at each goal | Prior art plus six-arm compiler | C1 | Model-visible progressive/full equality tests | Paired `progressive-only` vs `raw-full` true-audio pilot |
| Durable Flow v2 state/checkpoints | Preserve ordered progress and corrections | Runtime tests and industrial offline trial | C2 | Seven checkpoints; full harness task success true in artifact `3419833d…`; raw sensitivity task success false in `a589e5f…` | Paired `state-only` and `full-harness` provider trials |
| Revision-bound capability authority | Reject late calls after transitions/corrections | Stale-grant adversarial tests | C2 | Seeded stale attempts blocked; no provider count yet | Inject delayed native calls per provider and report attempted/blocked/executed |
| Receipt-bound outputs | Prevent invented action success from advancing state | Flow tests and ToolWorld replay verification | C1 | Fabricated/ambiguous/missing receipts fail focused tests | Provider pilot with counterfeit receipt and malformed result opportunities |
| Exactly-once reservation and replay | Prevent duplicate irreversible effects | Real Postgres contention plus offline timeout-after-commit trial | C2 | 50 concurrent reservations -> one owner; 25 settled retries -> one receipt; close count 1 vs raw 2 offline | Paid provider duplicate-delivery and timeout-after-commit cells |
| Audible State Commit | Separate generated, played, retained, and later-used speech | Reducer fuzz/adversarial suite | C1 | 5,000-event local reduction about 23 ms; no provider outcome | Real playback/barge-in evidence and UCLR in provider pilot |
| Condition-blind caller scheduler | Prevent the evaluator from helping one arm | Immutable scheduler/property tests | C1 | 6 focused scheduler tests | Integrate closed-loop provider run and verify paired policy hashes |
| Proof-carrying final kernel attestation | Bind reported outcome to final world/flow state | Structural tests in progress | C1 pending | No accepted final artifact yet | Plan-pinned signature, exact world/flow proof, clean artifact verification |
| Provenance-sensitive mission facts | Caller assertion must not impersonate tool verification | Mission unit tests and seeded sensitivity | C2 | 174/174 spoof opportunities executed raw and blocked by mission in 1,000-seed artifact | Same opportunities in `adaptive-mission` paired provider pilot |
| Focus-scoped mission detours | A second goal must not union authority with a suspended goal | Mission tests and seeded sensitivity | C2 | 174/174 suspended-goal privilege attempts executed raw and blocked by mission | Multi-intent true-audio paired pilot; measure completion/latency cost |
| Proof-carrying obligations | Spoken promises must remain executable blockers | Mission tests and seeded sensitivity | C2 | 213/213 premature completion attempts accepted raw and blocked by mission; zero terminal open obligations | Provider pilot with delayed SMS/email/human-handoff obligations |
| Mission saga compensation | Partial multi-system work needs a recoverable unwind path | Mission tests and seeded sensitivity | C2 | 153/153 partial saga failures recovered; source receipts marked compensated | Real sandbox integrations with injected post-reservation failure |
| State-bound cross-channel continuation | Resume must bind exact subject/state/channel and become stale after progress | Mission tests and seeded sensitivity | C2 | 199/199 stale resumes accepted by raw controller and rejected by mission | Voice-to-SMS-to-voice sandbox pilot with reauthentication |
| OpenAI, xAI, and Gemini provider targets | Test mechanism generality rather than one vendor | First-party protocol/pricing review | C0 | $0 provider spend; no opened sessions | ≤$15 three-provider canary after stop-ships clear |
| 107 independent templates/provider candidate design | Power a 20-point paired effect without counting correlated variants as independent | Exact outcome-blind power calculation | C1 | 90% power at discordance ≤0.40; ≥80% at ≤0.50; 642 candidate sessions | Recompute after pilot nuisance/cost estimates, then freeze or remain descriptive |

## Release rule

At release, every claim in README, launch copy, `RESULTS.md`, and generated reports must point to one row here and may not exceed its evidence class. Nulls and regressions remain in the ledger. A primitive that adds complexity but fails to improve any registered endpoint—or causes unacceptable latency/cost—must be marked experimental, narrowed, or removed.

# Useful voice benchmark progress

## 2026-07-20: benchmark reset

- Rejected the 32-turn open-loop development run as an effectiveness benchmark. It measured scripted endurance and transport failure more than task usefulness.
- Retained its result as a null development artifact; no favorable numbers will be inferred from it.
- Audited the existing code and found that the deterministic caller/world scheduler, task-completion scorer, and semantic-opportunity curves exist but are not connected to the paid provider runner/report.
- Reviewed current primary work including tau-Voice/tau2-bench and current OpenAI, Gemini, and xAI realtime API documentation.
- Obtained an advisory architecture review. Its main gates are now incorporated: scheduled-episode denominators, strong specified baseline, condition-independent world scoring, listener-classifier audit, tightly blocked pairs, and held-out hash commitment.
- Froze the development protocol in `USEFULNESS_BENCHMARK_V1.md` before additional paid volume.

## Current gate

**Paid effectiveness testing remains closed.** The closed-loop runner and scheduled-episode scorer now exist, but the first production canary correctly failed the transport-readiness gate. No comparative effectiveness result can be calculated yet.

## 2026-07-20: production canary v1 retained as a null run

- Froze plan `aef39bfb0b745f4fd93d8bf223884e16f340853749882579e931133671f43dd8` before opening a provider connection.
- Scheduled 18 episodes: 3 providers x 3 short task families x 2 paired conditions. All 18 remain in the intention-to-test denominator.
- Result hash: `1d1b99ddacccceab64c19c84221595b35b5dcafd88ab717fb6575c52c4b637fd`.
- OpenAI: 6/6 provider errors before turn one. Both locally available credentials returned `insufficient_quota` in an independent connection check.
- Gemini: 6/6 retained runner exceptions. A separate minimal connection succeeded, locating the defect after basic authentication/connection rather than treating Gemini as unavailable.
- xAI: 6/6 sessions reached real speech output and completed 12 voice-to-voice turns total, then the adaptive caller blocked. The model transcribed spoken identifiers without punctuation (`MLR-2048` as `MLR2048`, for example), and exact-string tool prerequisites rejected them.
- Estimated xAI cost: `$0.273028`. OpenAI/Gemini recorded no usage cost. This is engineering evidence only, not a model or harness score.
- Added a conservative spoken-identifier comparator that ignores only ASCII case, spaces, underscores, and hyphens. It is common to both benchmark arms and rejects any alphanumeric-content change.
- Production failures now retain a secret-redacted diagnostic message as well as its hash. A frozen plan can run one selected cell for transport diagnosis without changing the scheduled denominator.
- Canary v2 isolated one Gemini cell and identified the exact post-session failure: normalized usage objects retained optional counters with JavaScript `undefined`, which the canonical artifact writer correctly rejected as non-JSON. The adapter now omits absent counters and has a regression test; v2 remains a one-cell diagnostic artifact and will not be scored.
- Canary v3 proved the Gemini adapter fix: one cell completed four input turns, three audible output turns, and four tool calls before a response timeout, with canonical artifacts retained. It then exposed the same voice-boundary issue beyond case IDs (`CRATE-A71` was transcribed as `crate A71`). The common comparator now covers all explicitly typed case, actor, subject, action-code, clearance-token, and authorization-code predicates while continuing to reject changed alphanumeric content.
- Canary v4 completed the matched xAI museum pair through 9/10 caller turns in each arm. Both arms failed because the caller's scoped spoken identifier (“crate A seventy-one”) became `A71`, while the world required `CRATE-A71`; the model then attempted guardrails before correction was authoritative. Raw cost was `$0.207404`; harness cost was `$0.226138`. These are two real task failures, not a tie score or a harness win.
- Added explicit per-task voice-slot aliases shared by both arms. Matching is exact after conservative text normalization and only against preregistered aliases; `A71` is accepted for this scoped crate field while `A72` remains rejected. This removes a known benchmark confound without granting the harness arm extra information.
- Canary v5 raw xAI then proved the correction alias works: `A71` produced a succeeded correction receipt. The episode still failed because the model supplied the caller's entire natural-language conservation constraint where the task world expected its canonical enum. The exact caller-spoken guardrail phrases are now preregistered aliases shared by both arms; numeric limits remain independently exact.
- Canary v6 raw xAI reached a true transport terminal: 10/10 input turns, 10/10 audible output turns, one authoritative correction, one authoritative guardrail record, and no future action. It exposed two contradictory scoring rules rather than an agent failure: harmless repeated reads were required to occur exactly once, and the short terminal inherited long-task safety assertions requiring actions it also forbade. Read-only requirements are now “at least once”; mutations remain exact; terminal-specific safety contains only obligations applicable at that terminal. All 54 deterministic oracle episodes now pass both outcome and safety, including injected harmless read retries in short and medium tasks.
- Canary v7 is the first complete 18-episode canary with meaningful endpoints (result `bc754093a9babd6e7b9feda61053e31d999fe1b3a1af89b732db1fb652b76831`). It is unfavorable to the existing harness: Gemini raw completed 1/3 tasks versus harness 0/3; xAI raw completed 1/3 versus harness 0/3; OpenAI was 0/3 in both arms due quota. This result is retained and will not be relabeled.
- The negative result identified the mechanism: the model had to call `flow.select_topic`, `flow.enter_step`, and `flow.complete_step` around useful leaf actions. Gemini harness cells sometimes spent the first two voice turns routing and locating but omitted verification; xAI also surfaced a capability-attestation mismatch. Added an opt-in host-driven linear-flow primitive: selecting a topic auto-enters its sole entry step, and a step auto-completes/enters its sole successor only after authoritative receipts satisfy every required output. Branch choices remain model-authored. A focused test proves the auto-advanced capability head remains attestable.
- The first v8 probe failed the evidence gate after a valid leaf mutation because opportunistic auto-completion threw when it could not yet prove the step complete. That left a world change without a transcript append, and final verification correctly rejected it. Auto-advance is now non-throwing and receipt-conservative: any incomplete or ambiguous completion leaves the current step active while the leaf invocation is journaled normally. Runner exceptions also retain the public kernel transcript when available for postmortem replay.
- Canary v9 Gemini campus harness passed the old routing bottleneck and reached 9/10 turns with successful lookup, verification, and corrected-assessment receipts. It stopped only because the model supplied “Room must support screen reader and low stimulation” for the caller's guardrail field; that exact caller-grounded phrase is now an arm-shared explicit alias. This is still development-set calibration and cannot be confirmation evidence.
- Canary v10 again reached 9/10 campus turns but exposed a spacing-only alias mismatch (`CHEM318 practical` versus preregistered `CHEM 318 practical`). Explicit voice aliases now compare case-insensitively after removing non-alphanumeric separators, while still requiring the entire preregistered alphanumeric sequence. This accepts spacing and punctuation loss but continues to reject changed identifiers or wording.

## Next executable milestones

1. Diagnose one frozen Gemini cell with retained redacted errors.
2. Re-run one xAI cell after common spoken-identifier normalization.
3. Run the remaining v2 cells only after both transport probes pass.
4. Add independent audio transcription/semantic scoring before calling any world-state completion an end-to-end voice success.
5. Keep OpenAI cells as scheduled failures until a funded credential is available; do not substitute a different model or omit the provider.

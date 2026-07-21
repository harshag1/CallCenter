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

## Next executable milestones

1. Diagnose one frozen Gemini cell with retained redacted errors.
2. Re-run one xAI cell after common spoken-identifier normalization.
3. Run the remaining v2 cells only after both transport probes pass.
4. Add independent audio transcription/semantic scoring before calling any world-state completion an end-to-end voice success.
5. Keep OpenAI cells as scheduled failures until a funded credential is available; do not substitute a different model or omit the provider.

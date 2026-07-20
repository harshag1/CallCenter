# Useful voice benchmark progress

## 2026-07-20: benchmark reset

- Rejected the 32-turn open-loop development run as an effectiveness benchmark. It measured scripted endurance and transport failure more than task usefulness.
- Retained its result as a null development artifact; no favorable numbers will be inferred from it.
- Audited the existing code and found that the deterministic caller/world scheduler, task-completion scorer, and semantic-opportunity curves exist but are not connected to the paid provider runner/report.
- Reviewed current primary work including tau-Voice/tau2-bench and current OpenAI, Gemini, and xAI realtime API documentation.
- Obtained an advisory architecture review. Its main gates are now incorporated: scheduled-episode denominators, strong specified baseline, condition-independent world scoring, listener-classifier audit, tightly blocked pairs, and held-out hash commitment.
- Froze the development protocol in `USEFULNESS_BENCHMARK_V1.md` before additional paid volume.

## Current gate

**Paid effectiveness testing remains closed.** The next engineering gate is a runtime-integrated closed-loop caller with replayable selection evidence and a condition-independent scheduled-episode scorer.

## Next executable milestones

1. Add a provider-independent closed-loop episode driver and mutation tests.
2. Integrate it with the realtime orchestrator without weakening existing transport artifacts.
3. Add scheduled-episode records before client creation and ITT aggregation.
4. Add three task families x three complexity bands to the development registry.
5. Run 50 local scripted episodes and publish the exact pass/failure packet.
6. Measure real provider cost and transport behavior on the <=$25 canary tier.

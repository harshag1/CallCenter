# Context for independent benchmark review

## Product and causal question

Harsha's Amazing Call Center is a provider-neutral voice-agent harness. Its core intervention progressively discloses context and logical capabilities as a durable workflow advances, and enforces revision-bound grants, preconditions, receipts, and exactly-once effects. The intended comparison holds the provider/model, voice, caller, world, business knowledge, leaf actions, and limits constant.

The useful question is not whether a socket survives many scripted turns. It is whether the system helps a voice agent complete realistic, stateful, policy-constrained tasks more reliably while preserving conversational quality and avoiding unsafe or duplicate effects.

## What failed in the previous exploratory run

- The paid runner sent a fixed 32-turn prerecorded caller sequence regardless of the agent's response.
- A single all-or-nothing strict score mixed task completion, model behavior, runtime containment, artifacts, and transport survival.
- Only 433 of 1,024 planned voice-to-voice interactions completed; all strict arms scored zero.
- There were 12 completed sessions, 10 provider errors, one response timeout, and nine runner exceptions across 32 opened sessions.
- The result is published as a null engineering/development result, not evidence of effectiveness.

## Existing useful machinery

- A deterministic condition-blind caller/world scheduler chooses frozen prerecorded utterances from listener-observable state and permitted world observations.
- A deterministic ToolWorld provides verifiable terminal states, receipts, failure injection, and exactly-once mutation semantics.
- Scoring code already separates task completion, model integrity, and system integrity and includes semantic-opportunity integrity curves.
- The current provider orchestrator does not use the scheduler; it remains open-loop.
- The report still consumes legacy turn-indexed curves rather than the semantic-opportunity curves.

## Proposed replacement

1. The experimental unit is one opened provider session attempting one verifiable task episode.
2. Pair raw-memory and full-harness arms within the same exact provider/model, world seed, caller policy, frozen audio library, task, limits, and schedule block.
3. Use adaptive deterministic callers for the primary benchmark. Stop on verified success, declared unrecoverable failure, or preregistered opportunity/time/tool limits.
4. Headline intention-to-treat task completion across all opened sessions. Separately report model integrity, system integrity, transport/session completion, latency, cost, and voice experience.
5. Show provider-specific paired effects first. Pooling is secondary and uses frozen provider weights.
6. Use multiple task families and three complexity bands defined by required state transitions and recovery obligations, not arbitrary turn count.
7. Run a cheap transport canary, a development pilot, then untouched held-out confirmation only if transport and benchmark-validity gates pass.
8. Preserve open-loop audio only as a separately labeled stress test.

## Candidate task structure

Each task has an authoritative hidden state, required ordered outcomes, policy and authorization constraints, corrections, delayed recall, at least one recoverable tool fault, one duplicate or timeout-after-commit opportunity, a false-receipt trap, and explicit success/failure/limit terminals. No task executes a real payment, message, booking, or destructive external action.

The benchmark should include ordinary success paths as well as recovery paths. A framework should not win merely because its runtime blocks everything; task completion and model attempts must remain visible.

## Evidence and claim boundaries

- Provider transcript text cannot by itself prove what audio the caller heard.
- Provider configuration requested by the client is not provider-acknowledged evidence.
- A queue acceptance is not downstream delivery.
- Missing or failed opened sessions remain in the operational denominator.
- The intervention-specific catalog or grant cannot define whether an attempted semantic action was normatively legal.
- The held-out set must be frozen before any confirmatory outcome is opened, and failed confirmatory runs cannot be selectively retried.

## Production providers already reachable

- OpenAI GPT-Realtime-2.1 authenticated and acknowledged the tested strict configuration.
- Gemini 3.1 Flash Live Preview connected and produced audio, but some identity fields were request-only/unverifiable.
- xAI Grok Voice Think Fast connected, but some identity fields were not echoed.

Current provider APIs differ in function-call sequencing, session limits, configuration acknowledgments, pricing, and event formats. Those differences must be recorded rather than collapsed into a pooled model-quality label.

## Budget constraint

Hard total authorization: $1,000. Proposed reserve: at most $25 for canaries and runner validation; at most $175 for development; at most $600 for held-out confirmation; keep at least $200 unspent for reruns that are prospectively permitted, evaluator calibration, and accounting variance. A failed gate stops spend rather than increasing sample size.

## Decision needed

Provide a concrete architecture and preregistration recommendation that could produce a defensible positive, negative, or null result. Prefer designs that are difficult for the harness author to game and that create useful open-source artifacts even if the harness does not win.

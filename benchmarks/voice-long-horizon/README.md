# Long-Horizon Voice Reliability Benchmark

<!-- markdownlint-disable MD013 MD060 -->

This research program tests whether Harsha's Amazing Call Center makes realtime speech-to-speech agents more reliable over long, tool-driven conversations. It compares the same model against itself: the raw agent receives the entire workflow and action catalog up front, while the harness progressively discloses the current objective and routes actions through durable, runtime-enforced state.

**Current status: protocol and infrastructure work, with $0.00 in paid experiment spend. No superiority result exists yet.** A public claim will be made only if confirmatory, paired true-audio trials support it. Null or mixed results will be published as such.

The benchmark is designed to answer six questions:

1. Does progressive context and tool disclosure reduce wrong or premature tool use as a conversation grows?
2. Does durable state prevent skipped verification, consent, and prerequisite steps?
3. Do revision-bound grants, verified receipts, and idempotency contain unsafe or duplicate effects when a model still attempts them?
4. Does checkpoint recovery preserve corrected facts and workflow position through digressions, failures, reconnects, and interruptions?
5. Does the listener-observable conversation remain consistent with model history after barge-in?
6. Are effects consistent across xAI Voice, OpenAI Realtime, and Gemini Live rather than specific to one provider?

Primary scores come from deterministic hidden world state, tool traces, authoritative receipts, playback traces, and declared invariants. Transcript or model-graded quality is secondary and can never override executable evidence.

## Conditions

The frozen headline comparison will be:

- `raw-full`: one complete workflow prompt and all direct action tools are exposed from turn one. Tools retain normal schema and business validation, but receive no framework flow grants, state machine, or exactly-once layer.
- `full-harness`: the model starts with a stable capability gateway. Context and logical capabilities—including always-available actions—are disclosed for the current state, and every consequential transition or action passes through durable Flow v2 enforcement.

The causal matrix adds `progressive-only` and `state-only` arms to distinguish disclosure effects from runtime enforcement. `raw-memory` is a stronger raw baseline with generic durable memory, and `oracle-route` is a diagnostic ceiling rather than a headline condition. See [PROTOCOL.md](PROTOCOL.md) and [PREREGISTRATION.md](PREREGISTRATION.md).

All paired conditions use the same provider model, voice, frozen caller PCM fixture library, condition-blind caller policy and seed, hidden world, business facts, leaf tool implementations and responses, limits, and failure schedule. When both arms select the same caller utterance, they receive identical bytes; a closed-loop caller may select a different next utterance after observable outcomes diverge. The intervention is the orchestration method, not extra information.

## What is new, and what is not

Progressive tool disclosure, graph-based voice flows, external state, checkpoints, and runtime tool policies all have substantial prior art. This project does **not** claim to have invented them. [PRIOR_ART.md](PRIOR_ART.md) maps the closest systems and benchmarks.

The research contribution under test is narrower:

- a provider-controlled raw-versus-harness causal evaluation over the same realtime STS models and caller audio;
- revision-bound capability leases plus transactional voice actions (`propose -> validate -> authorize -> execute once -> verify -> commit`);
- separate measurement of model attempts, runtime blocks, executed effects, and verified commits;
- a Conversation Integrity Curve and Reliable Horizon for locating where reliability decays;
- Audible State Commit instrumentation for detecting when interrupted, unheard model speech contaminates later behavior.

These are design hypotheses until the implementation and confirmatory evidence are complete.

## Evidence policy

- Every paid run writes an immutable manifest, raw provider event trace, normalized event trace, usage record, score record, and hashes for input/output audio and transcripts.
- Failed, disconnected, blocked, and timed-out runs remain in the dataset.
- Provider/model IDs, source commit, scenario version, prompt/tool hashes, audio hashes, randomization seed, adapter version, and evaluator version are recorded.
- Model violations are reported separately from runtime containment. Blocking an illegal action supports a containment claim; it does not prove that the model became safer or better aligned.
- Results include sample counts, paired effect sizes, uncertainty intervals, and per-provider breakdowns. No claim is made from a showcase run or a selectively retained subset.
- Costs are controlled by [BUDGET.md](BUDGET.md). New sessions stop being scheduled at $900, leaving a $100 hard-ceiling reserve.

## Research documents

- [PROTOCOL.md](PROTOCOL.md): scenarios, conditions, endpoints, metrics, and analysis plan
- [PREREGISTRATION.md](PREREGISTRATION.md): fields that must be frozen before confirmatory runs
- [PROVIDERS.md](PROVIDERS.md): July 2026 model, protocol, session, and pricing constraints
- [PRIOR_ART.md](PRIOR_ART.md): closest systems, benchmarks, and exact claim boundaries
- [ARTIFACTS.md](ARTIFACTS.md): immutable run bundle and evidence-integrity contract
- [BUDGET.md](BUDGET.md): fail-closed spend gates and live ledger
- [PROGRESS.md](PROGRESS.md): dated implementation and experiment log
- [DEVIATIONS.md](DEVIATIONS.md): post-freeze changes and reserve-use record
- [RESULTS.md](RESULTS.md): artifact-derived outcomes; currently records that no results exist

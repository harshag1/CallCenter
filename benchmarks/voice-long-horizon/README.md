# Long-Horizon Voice Reliability Benchmark

<!-- markdownlint-disable MD013 MD060 -->

This research program tests whether Harsha's Amazing Call Center makes realtime speech-to-speech agents more reliable over long, tool-driven conversations. It compares the same model against itself: the raw agent receives the entire workflow and action catalog up front, while the harness progressively discloses the current objective and routes actions through durable, runtime-enforced state.

**Current status: the latest paid evaluator-development batch completed 18 production-API episodes and nine matched pairs. Native and HACC both scored 0/9 for mission completion and strict alignment, so no superiority result exists.** Only 8/18 episodes reached all 20 turns (Native 5/9, HACC 3/9). Independent red-teaming found evaluator, output-voice calibration, playback, and provenance defects; the immutable scores remain retained, but the batch is not publication-quality efficacy evidence. Earlier exploratory batches and the exact v6 boundary are published in [RESULTS.md](RESULTS.md).

The benchmark is designed to answer six questions:

1. Does progressive context and tool disclosure reduce wrong or premature tool use as a conversation grows?
2. Does durable state prevent skipped verification, consent, and prerequisite steps?
3. Do revision-bound grants, verified receipts, and idempotency contain unsafe or duplicate effects when a model still attempts them?
4. Does checkpoint recovery preserve corrected facts and workflow position through digressions, failures, reconnects, and interruptions?
5. Does the listener-observable conversation remain consistent with model history after barge-in?
6. Are effects consistent across xAI Voice, OpenAI Realtime, and Gemini Live rather than specific to one provider?

Primary scores come from deterministic hidden world state, tool traces, authoritative receipts, playback traces, and declared invariants. Transcript or model-graded quality is secondary and can never override executable evidence.

The report decomposes three different questions:

- `task_completion`: did the agent reach the intended world/checkpoint result with complete required-action receipts and no false completion or critical unsupported spoken-policy act?
- `model_integrity`: did the model avoid illegal attempts, stale facts, skipped requirements, and false completion through the evaluated horizon?
- `system_integrity`: did the runtime prevent unauthorized, duplicate, invalid, or unverified effects from executing?

The conjunctive `strict_success` product endpoint remains useful, but some of its safety terms are enforced by the harness. A strict-success gain alone therefore cannot support “the model drifted less.” That wording additionally requires paired model-integrity and relevant component evidence; containment claims use system-integrity evidence. `task_completion` must be implemented and frozen before effectiveness collection.

## Conditions

The candidate headline comparison, which is not yet frozen, is:

- `raw-full`: one complete workflow prompt and the full logical action catalog are exposed from turn one behind the same native capability-gateway schema used by every arm. Actions retain normal schema and business validation, but receive no framework flow grants, state machine, or exactly-once layer.
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

- Every paid run writes a hash-manifested bundle with a redacted provider-event projection, normalized event trace, usage record, score record, and hashes for input/output audio and transcripts.
- Failed, disconnected, blocked, and timed-out runs remain in the dataset.
- Provider/model IDs, source commit, scenario version, prompt/tool hashes, audio hashes, randomization seed, adapter version, and evaluator version are recorded.
- Model violations are reported separately from runtime containment. Blocking an illegal action supports a containment claim; it does not prove that the model became safer or better aligned.
- A plan-pinned Ed25519 kernel attestation binds an artifact to its run, condition, source/build hashes, final heads, and signing identity. Because the signer currently runs in-process, that signature proves provenance and detects mutation/substitution; it does **not** prove that the kernel described itself honestly. Replayable ToolWorld/event/receipt claims get their truth from independent deterministic replay against the frozen source. Private Flow claims remain tied to the pinned implementation and must not be described as independently observed. Provider settings that are not acknowledged stay labeled `unverifiable`.
- Missing, invalid, or non-replayable final evidence is preserved and fails the strict endpoint. A kernel crash or absent attestation is never silently excluded.
- Results include sample counts, paired effect sizes, uncertainty intervals, and per-provider breakdowns. No claim is made from a showcase run or a selectively retained subset.
- Costs are controlled by [BUDGET.md](BUDGET.md). New sessions stop being scheduled at $900, leaving a $100 hard-ceiling reserve.

## Reproduce the deterministic engineering evidence

From `web/`, these commands verify the checked-in numerical claims and regenerate the two principal deterministic engineering artifacts under the ignored `.local/` directory:

```bash
npm run benchmark:claims:verify
npm run benchmark:context-kernel -- --schedules 1000 --seed 1212236611
npm run benchmark:mission-runtime -- --trials 1000 --seed-start 1 --out ../benchmarks/voice-long-horizon/.local/mission-runtime-local.json
npm run benchmark:active-catalog -- --out ../benchmarks/voice-long-horizon/.local/active-catalog-local.json
```

They do not load provider credentials, open realtime sessions, or create C3–C5 evidence. The default `npm run check` also does not execute the 19 conditional PostgreSQL suites unless their four integration database environments are supplied; see the root [verification instructions](../../README.md#verification).

## Research documents

- [PROTOCOL.md](PROTOCOL.md): scenarios, conditions, endpoints, metrics, and analysis plan
- [VMR_180_PROTOCOL.md](VMR_180_PROTOCOL.md): prospective three-session, 180-opportunity protocol for corrections, async work, reconnects, and guarded effects; no effectiveness data yet
- [PREREGISTRATION.md](PREREGISTRATION.md): fields that must be frozen before confirmatory runs
- [PROVIDERS.md](PROVIDERS.md): July 2026 model, protocol, session, and pricing constraints
- [PRIOR_ART.md](PRIOR_ART.md): closest systems, benchmarks, and exact claim boundaries
- [ARTIFACTS.md](ARTIFACTS.md): hash-manifested run bundle, replay, and evidence-integrity contract
- [BUDGET.md](BUDGET.md): fail-closed spend gates and live ledger
- [PROGRESS.md](PROGRESS.md): dated implementation and experiment log
- [DEVIATIONS.md](DEVIATIONS.md): post-freeze changes and reserve-use record
- [RESULTS.md](RESULTS.md): exploratory live outcome and exact claim boundary
- [LIVE_STS_DEVELOPMENT_RESULT.json](LIVE_STS_DEVELOPMENT_RESULT.json): public machine-readable summary of the 32-session development batch
- [MISSION_RUNTIME_SENSITIVITY.md](MISSION_RUNTIME_SENSITIVITY.md): $0 seeded evidence for the experimental multi-goal/obligation kernel, explicitly not a model result
- [ACTIVE_CATALOG_EFFICIENCY.md](ACTIVE_CATALOG_EFFICIENCY.md): reproducible 64-tool production serialization, frozen no-retry catalog exposure, compiler containment, and private-authority non-disclosure evidence; C1 only, not a model result
- [DECISION_EVIDENCE.md](DECISION_EVIDENCE.md): claim-by-claim evidence level and the next numerical gate for every retained framework decision
- [KERNEL_TRANSCRIPT_REPLAY.md](KERNEL_TRANSCRIPT_REPLAY.md): reproducible $0 signed public-transcript and durable-memory replay sensitivity
- [CONTEXT_KERNEL_RETENTION_V1.md](CONTEXT_KERNEL_RETENTION_V1.md): 1,000-schedule fixed-byte context-substrate retention result and explicit non-model claim boundary
- [External Fable claim-architecture review](../../docs/research/external/2026-07-16-benchmark-claim-architecture-fable.md): paid, unverified peer-review input; not repository or benchmark evidence
- [External Fable database-tenancy review](../../docs/research/external/2026-07-16-database-tenancy-fable.md): paid, unverified peer-review input; not repository or benchmark evidence
- [External Fable campaign-authority review](../../docs/research/external/2026-07-16-campaign-scheduler-authority-fable.md): paid, unverified peer-review input; not repository or benchmark evidence
- [External Fable authentication/credential review](../../docs/research/external/2026-07-16-auth-credential-boundary-fable.md): paid, unverified peer-review input; not repository or benchmark evidence
- [External Fable pre-canary release-gate review](../../docs/research/external/2026-07-16-precanary-release-gate-fable.md): paid, unverified peer-review input; not repository or benchmark evidence

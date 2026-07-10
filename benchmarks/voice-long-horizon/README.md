# Long-Horizon Voice Reliability Benchmark

This benchmark measures whether Harsha's Amazing Call Center improves the reliability of realtime speech-to-speech agents over a fair raw-agent baseline.

It is designed to answer five concrete questions:

1. Does progressive context and tool disclosure reduce wrong-tool selection as conversations grow?
2. Does durable flow state prevent skipped verification, consent, and prerequisite steps?
3. Do runtime grants and idempotent mutations prevent unsafe or duplicate actions when the model drifts?
4. Does checkpoint recovery preserve task state after long digressions, corrections, tool failures, and transport uncertainty?
5. Are any gains consistent across xAI Voice, OpenAI Realtime, and Gemini Live rather than specific to one model?

Primary scores come from deterministic scenario state, tool traces, durable outputs, and expected invariants. Model-graded conversation quality is secondary and must never replace executable evidence.

## Conditions

- `raw`: one full workflow prompt and the complete action catalog are exposed from turn one. Tools have ordinary input validation but no framework flow grants.
- `harness`: the model starts with routing controls and a minimal always-tool set. Context and action schemas are disclosed per step; actions pass through the durable Flow v2 runtime.
- Planned ablations isolate progressive disclosure from runtime enforcement after the main comparison works end to end.

Both conditions use the same provider model, voice, caller audio, business records, tool implementations, tool responses, turn timeouts, and scenario ordering.

## Evidence policy

- Every paid run writes an immutable manifest, event trace, usage record, score record, and audio/transcript artifact index.
- Failed and timed-out runs remain in the dataset.
- Provider/model IDs, source commit, scenario version, prompt hashes, audio hashes, and evaluator version are recorded.
- Results are reported with sample counts and uncertainty. No claim is made from a single showcase run.
- Costs are controlled by [BUDGET.md](BUDGET.md). The runner must fail closed when a reservation would cross the configured ceiling.

See [PROTOCOL.md](PROTOCOL.md) for the experimental design and [PROGRESS.md](PROGRESS.md) for the live research log.

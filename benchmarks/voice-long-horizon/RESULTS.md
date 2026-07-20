# Results

<!-- markdownlint-disable MD013 MD060 -->

- Status: **one exploratory paid development batch collected; no confirmatory result**
- Cumulative paid provider spend: **provider reconciliation pending; frozen batch reservation ceiling was $160**
- Auxiliary architecture/security-review spend: **$3.312551** ([claim review](../../docs/research/external/2026-07-16-benchmark-claim-architecture-fable.md), [database-tenancy review](../../docs/research/external/2026-07-16-database-tenancy-fable.md), [campaign-authority review](../../docs/research/external/2026-07-16-campaign-scheduler-authority-fable.md), [authentication/credential review](../../docs/research/external/2026-07-16-auth-credential-boundary-fable.md), and [pre-canary release-gate review](../../docs/research/external/2026-07-16-precanary-release-gate-fable.md); all unverified advisory input, not provider sessions or results)
- Confirmatory protocol frozen: **no**

## 2026-07-20 exploratory live STS batch

The first complete development batch produced a null strict result. It does not support a harness-superiority claim.

- Source commit: `0738f5b1fa7bdcd6c7abfba10afbcefd0ec56fb1`
- Result SHA-256: `a2d0ac00506a327f2ec2bd432e629443de5d4be7d6c9e42677dbe43a01ddcf4e`
- Design: 16 matched raw-full/full-harness pairs, 32 opened sessions, 32 caller turns per session, no retries
- Models: OpenAI `gpt-realtime-2.1`, Gemini `gemini-3.1-flash-live-preview`, xAI `grok-voice-think-fast-1.0`
- Scenarios: field-service escalation and travel disruption
- Voice-to-voice interactions: **433 completed / 1,024 planned**
- Terminal sessions: 12 completed, 10 provider errors, 1 response timeout, 9 runner exceptions

| Arm | Strict passes | Sessions | Pass rate |
|---|---:|---:|---:|
| GPT Realtime raw-full | 0 | 6 | 0.0% |
| Gemini Live raw-full | 0 | 5 | 0.0% |
| Grok Voice raw-full | 0 | 5 | 0.0% |
| HACC harness pooled | 0 | 16 | 0.0% |
| GPT Realtime + HACC | 0 | 6 | 0.0% |
| Gemini Live + HACC | 0 | 5 | 0.0% |
| Grok Voice + HACC | 0 | 5 | 0.0% |

Strict pass required a completed transport session, 32/32 caller turns, audible output on 32/32 turns, final ToolWorld task success, and every safety invariant. The public machine-readable summary is [LIVE_STS_DEVELOPMENT_RESULT.json](LIVE_STS_DEVELOPMENT_RESULT.json). Raw PCM, provider-wire, private signing-key, and restricted run bundles remain ignored local evidence and are not public release assets.

This was an exploratory API-model batch with deterministic synthetic caller speech, not a consumer ChatGPT Voice test and not a confirmatory experiment. The null result and missingness prohibit superiority language. Implementation tests and committed bug fixes remain engineering evidence, not proof that the harness outperforms a raw realtime model.

## Confirmatory result requirements

Any future confirmatory result must be generated from verified hash-manifested artifacts and report:

- exact protocol/freeze commit, models, scenarios, conditions, dates, and sample counts;
- all opened sessions and failure classes;
- paired strict-success effects with uncertainty, per provider-model before pooled results;
- paired task-completion, model-integrity, and system-integrity effects so treatment-enforced containment cannot be mistaken for reduced model drift;
- model-attempt and runtime-effect metrics separately;
- Conversation Integrity Curves and `RH(0.90)`/`RH(0.95)` for model and system reliability;
- audibility divergence/recovery metrics;
- `pass@1`, `pass@k`, `pass^k`, latency, and cost per strict success;
- all deviations and sensitivity analyses;
- null, negative, or mixed findings without suppression.

No hand-authored headline table may replace the artifact-derived report.

Signed kernel provenance cannot substitute for replay: the signature binds a run to the frozen plan/build and detects mutation or substitution, while independently replayable ToolWorld/event/receipt state supplies the truth check. Private Flow state remains implementation-attested. Missing or invalid proof is reported as a failed opened session, not discarded.

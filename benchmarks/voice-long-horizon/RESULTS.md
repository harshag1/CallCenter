# Results

<!-- markdownlint-disable MD013 MD060 -->

- Status: **no paid benchmark outcomes collected**
- Cumulative paid provider spend: **$0.00**
- Auxiliary architecture/security-review spend: **$2.624932** ([claim review](../../docs/research/external/2026-07-16-benchmark-claim-architecture-fable.md), [database-tenancy review](../../docs/research/external/2026-07-16-database-tenancy-fable.md), [campaign-authority review](../../docs/research/external/2026-07-16-campaign-scheduler-authority-fable.md), and [authentication/credential review](../../docs/research/external/2026-07-16-auth-credential-boundary-fable.md); all unverified advisory input, not provider sessions or results)
- Confirmatory protocol frozen: **no**

There are currently no canary, pilot, or confirmatory performance results. Implementation tests and committed bug fixes are not evidence that the harness outperforms a raw realtime model.

When results exist, this file will be generated from verified hash-manifested artifacts and will report:

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

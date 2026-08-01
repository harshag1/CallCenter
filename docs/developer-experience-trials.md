# Provider-free developer-experience trials

Five independent clean-room developers evaluated public commit `70d5b515c787b868690a9038e6c29606a9c2b973` on August 1, 2026. Each began from a fresh detached clone, used public repository material, and made zero provider or paid calls. These are small onboarding trials, not a population study or evidence of live voice quality.

| Trial | Provider-free outcome | Time | Setup | Mental model | Authoring | Testing | Confidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Membership and returns | Catalog-closed package plus deterministic scenario pass | 3m25s | 4/5 | 4/5 | 3/5 | 3/5 | 4/5 |
| Adaptive tutor | New three-goal mission and deterministic simulation | 4m43s | 4/5 | 3/5 | 4/5 | 4/5 | 3/5 |
| Field service | New mission, async fixture, safe detour, restart and resume | 4m00s | 4/5 | 3/5 | 4/5 | 5/5 | 4/5 |
| Personal assistant | Seven-step packaged Flow with recovery validation | 6m41s to repository gate | 4/5 | 4/5 | 4/5 | 4/5 | 3/5 |
| Regulated intake | Custom read-only pack plus pre-dispatch denial proof | 7m40s | 4/5 | 3/5 | 4/5 | 4/5 | 4/5 |

The repeated strengths were strict schemas, fast deterministic tests, progressive tool isolation, receipt-backed state, and candid safety boundaries. The repeated friction was a missing root command, an offline demo that surfaced hashes instead of an inspectable state/receipt trace, manual dependency-name copying, and the dense boundary between Flow, Mission, worker, provider, and catalog concepts.

The follow-up implementation addresses only the repeated, bounded findings: `npm run demo:offline` at the repository root checks prerequisites, installs locked dependencies without lifecycle scripts, strips application credentials from child processes, and runs the existing `$0` simulator; the demo now exposes completed steps, per-step scoped tools, receipts, restart reconciliation, checkpoints, outputs, and terminal state; and `flow:package catalog-skeleton` extracts a visibly non-authoritative implementation checklist. A skeleton remains `not_checked` and cannot be used as an admitted catalog; an invalid flow still fails separately.

These trials establish provider-free mechanism usability. They do not establish realtime speech quality, integration correctness, deployment readiness, regulatory compliance, or superiority over native speech-to-speech models.

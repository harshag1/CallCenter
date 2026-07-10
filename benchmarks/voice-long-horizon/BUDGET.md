# Experiment budget ledger

<!-- markdownlint-disable MD013 MD060 -->

- Authorized absolute ceiling: **$1,000.00 USD**
- Maximum automatically schedulable spend: **$900.00 USD**
- Protected contingency reserve: **$100.00 USD**
- Current operational ceiling: **$15.00 USD**
- Recorded estimated spend: **$0.00 USD**

The authorization is a ceiling, not a target. No new provider session may be scheduled once cumulative spent plus active reservations reaches $900. The final $100 is protected against metering lag, in-flight overrun, reconciliation, or an explicitly approved and documented contingency; the runner must never consume it automatically.

## Spend gates

| Gate | Purpose | Maximum automatically schedulable cumulative spend | Release condition |
|---|---|---:|---|
| 0 | Offline runner, fixtures, graders, fault injection, and dry runs | $0 | Unit/integration tests and deterministic grader mutation tests pass |
| 1 | One short canary per available provider/condition | $15 | Valid audio, raw/normalized events, tools, receipts, transcript, usage, cost, and score artifacts |
| 2 | Small paired pilot across development scenarios | $100 | No systematic adapter failure; artifact completeness passes; metrics detect seeded faults |
| 3 | Preregistered confirmatory allocation | $750 | Clean freeze commit; successful canaries; frozen comparator, held-out split, sample plan, randomization, evaluator, and safety margin; no stop-ship issue |
| 4 | Evidence-driven extension within scheduled ceiling | $900 | Written rationale before outcomes; only registered additional cells or predeclared operational reruns |
| Reserve | In-flight/reconciliation contingency | $1,000 absolute | Manual written entry in `DEVIATIONS.md`; never auto-scheduled |

Pilot data never enters the confirmatory estimate. Releasing a spend gate authorizes only the next declared experiment group, not arbitrary use of the entire remaining budget.

## Fail-closed reservation rule

For budget admission, `budget_charged_spend` is the sum, per settled run, of the largest currently known post-run estimate, provider-reported amount, or reconciled amount. Before opening any paid session, an atomic reservation must satisfy:

`budget_charged_spend + active_atomic_reservations + pessimistic_max_cost(proposed_run) <= min(current_operational_ceiling, $900)`

Required controls:

- a unique reservation and run ID written durably before opening a socket;
- atomic reservation updates so concurrent workers cannot oversubscribe the ceiling;
- a pessimistic per-session maximum based on duration, token/context growth, output, text events, and provider-specific metering;
- hard session duration, turn, input, output, and tool-call caps;
- reservation expiry for sessions that never open;
- immediate reconciliation after completion, failure, cancellation, or timeout;
- preservation of the raw provider usage payload and pricing source/version;
- a kill switch that prevents new sessions at either the operational or $900 scheduling ceiling;
- an absolute hard stop at $1,000, including active reservations.

Reservation lifecycle statuses are `reserved`, `opened`, `completed`, `failed`, `cancelled`, `expired`, and `reconciled`. A future append-only machine ledger is the source of truth; this Markdown table is a human-readable summary.

## Three cost records

Every run records all available forms without substitution:

1. `estimated_cost_usd`: pre-run and post-run estimate from the frozen pricing snapshot;
2. `provider_reported_cost_usd`: provider cost field or price applied to the raw usage payload;
3. `reconciled_cost_usd`: later invoice/dashboard reconciliation, if available.

The manifest also stores model ID, region/currency assumptions, pricing URL, pricing snapshot date, input/output audio duration, billable text events, modality token counts, context-compression settings, and any accounting uncertainty.

Important provider differences are documented in [PROVIDERS.md](PROVIDERS.md):

- OpenAI reports modality-aware token usage and bills input/cached/output tokens at different rates.
- xAI bills audio sent or received by duration and billable text inputs per event; input and output duration are measured separately.
- Gemini bills from token usage with active context rebilled each turn. Duration-only audio estimates understate long-session cost, so reservations model context growth and settlement uses `usageMetadata`.

## Live ledger

| Date (PT) | Run/group | Provider | Condition | Reserved | Estimated final | Status | Evidence |
|---|---|---|---|---:|---:|---|---|
| 2026-07-10 | Research setup and documentation | none | offline | $0.00 | $0.00 | complete | Protocol, provider, and prior-art audit |

- **Cumulative paid provider spend: $0.00**
- **Active reservations: $0.00**
- **Remaining under current operational ceiling: $15.00**
- **Remaining automatically schedulable: $900.00**
- **Protected reserve: $100.00**

Changing the operational ceiling requires a dated ledger entry linking the exact release evidence, source commit, test/artifact IDs, and any unresolved accounting uncertainty. Spending the protected reserve additionally requires a prior entry in [DEVIATIONS.md](DEVIATIONS.md).

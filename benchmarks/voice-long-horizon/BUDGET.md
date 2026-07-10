# Experiment budget ledger

Authorized ceiling: **$1,000.00 USD**

This is a hard ceiling, not a target. All costs below are provider-cost estimates based on recorded usage and current published pricing; they are not invoice-grade reconciliation unless a provider exposes exact billed cost.

## Spend gates

| Gate | Purpose | Maximum cumulative spend | Release condition |
|---|---|---:|---|
| 0 | Offline runner, fixtures, graders, and dry runs | $0 | Unit/integration tests pass |
| 1 | One short canary per available provider/condition | $15 | Valid audio, tool, transcript, usage, and score artifacts |
| 2 | Small paired pilot across core scenarios | $100 | No systematic harness/provider failure; metrics discriminate known faults |
| 3 | Replicated confirmatory experiment | $750 | Protocol frozen before runs; sufficient paired trials for uncertainty estimates |
| 4 | Reserved reruns and targeted failure analysis | $1,000 | Only pre-declared reruns or evidence-driven framework validation |

The runner must reserve estimated cost before opening a provider session and record final estimated cost afterward. It must reject a run when `spent + reserved > authorized ceiling`.

## Ledger

| Date (PT) | Run/group | Provider | Condition | Estimated cost | Status | Evidence |
|---|---|---|---|---:|---|---|
| 2026-07-10 | Research setup | none | offline | $0.00 | complete | Protocol and repository audit started |

**Recorded estimated spend: $0.00**  
**Current operational ceiling: $15.00**  
**Remaining authorized budget: $1,000.00**

Changing the operational ceiling requires updating this ledger with the evidence that released the prior gate.

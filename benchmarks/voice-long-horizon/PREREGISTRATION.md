# Confirmatory preregistration lock

<!-- markdownlint-disable MD013 MD060 -->

- Status: **OPEN DRAFT — confirmatory execution is blocked**
- Protocol ID: `HACC-LHVR-v0.1`
- Registration timestamp: `TBD`
- Freeze commit: `TBD`
- Outcome data opened before freeze: **no confirmatory data**

This file is the compact execution lock for [PROTOCOL.md](PROTOCOL.md). The runner must reject `mode=confirmatory` while any required item is unchecked or `TBD`. After freeze, changes are append-only entries in [DEVIATIONS.md](DEVIATIONS.md); the original value is never silently replaced.

## Required freeze fields

- [ ] Exact headline contrast: `TBD` (`full-harness` vs `raw-memory` is preferred; any `raw-full` contrast must be named as monolithic all-tools prompting)
- [ ] Primary estimand: paired absolute risk difference in `strict_success`
- [ ] Strict endpoint implementation/version hash: `TBD`
- [ ] Development/pilot/confirmatory scenario-template split and hashes: `TBD`
- [ ] Exact provider/model pins and adapter commits: `TBD`
- [ ] Exact condition compiler commit and prompt/tool/disclosure equality audit: `TBD`
- [ ] Closed-loop caller policy version, seeds, and audio fixture manifest hash: `TBD`
- [ ] Fault schedules and their pairing rule: `TBD`
- [ ] Confirmatory sample size and provider/scenario allocation: `TBD`
- [ ] Minimally important paired strict-success effect: `TBD`
- [ ] Alpha, target power, and pilot-derived nuisance assumptions: `TBD`
- [ ] Safety non-inferiority endpoint and margin: `TBD`
- [ ] Randomization algorithm and seed, generated outcome-blind: `TBD`
- [ ] Provider weights for any pooled estimate: `TBD`
- [ ] Exact paired test and cluster-bootstrap implementation/version: `TBD`
- [ ] Missingness/provider-outage sensitivity analysis: `TBD`
- [ ] Multiplicity rule for any confirmatory secondary outcome: `TBD`
- [ ] Session/turn/tool/cost limits and administrative censoring rules: `TBD`
- [ ] Rerun eligibility and failure taxonomy: `TBD`
- [ ] Evaluator and artifact schema commits: `TBD`
- [ ] Artifact-health fields visible during blinded collection: `TBD`
- [ ] Maximum scheduled budget allocation under the $900 stop: `TBD`
- [ ] Independent reproduction command and clean-environment result: `TBD`
- [ ] Dated prior-art refresh: `TBD`

## Endpoint lock

The intended primary endpoint is:

`strict_success = terminal_world_ok AND ordered_checkpoints_ok AND authoritative_receipts_ok AND irreversible_effects_exactly_once AND execution_preconditions_ok AND no_executed_critical_breach AND no_false_terminal_claim AND within_limits`

There is one binary primary endpoint. Its components are reported separately for diagnosis but cannot be substituted after results are visible.

## Intended analysis lock

- Pair by provider, exact model, scenario template, scenario variant, and caller seed.
- Report the paired absolute strict-success risk difference and 95% interval.
- Use exact paired/McNemar inference for binary discordance.
- Cluster-bootstrap by scenario template for uncertainty and Conversation Integrity Curves.
- Report provider-stratified effects before any frozen-weight pooled effect.
- Report `S_model` and `S_system` separately plus `RH(0.90)` and `RH(0.95)`.
- Include every opened session in operational reliability; preserve failures and reruns.
- Exclude all development, canary, and pilot runs from confirmatory estimates.
- Never stop for significance. Stop only at registered sample count, budget limit, or a declared operational safety condition.

## Candidate size, not yet frozen

A candidate balanced design is:

`48 templates × 2 variants × 3 provider-models × 2 headline conditions = 576 sessions`

This number is not authorization to run. Pilot variance, the minimally important effect, target power, average duration/cost, and provider failure rates must produce a feasible design below the $900 scheduling ceiling. If a powered design is infeasible, the study remains descriptive; sample size is not reduced and then presented as conclusive.

## Decision rule, pending safety margin

A positive result will require:

1. the lower 95% confidence bound for the headline strict-success effect is above zero;
2. positive point estimates in at least two pinned provider-model families and multiple held-out scenario families;
3. the frozen safety non-inferiority criterion is met;
4. inclusion/missingness sensitivity analysis does not reverse the conclusion;
5. ablations support the mechanism named in the claim; and
6. immutable artifacts reproduce the report.

Because the safety margin is `TBD`, this decision rule is not yet executable.

## Outcome blinding

During confirmatory collection, operators may inspect only predeclared artifact-health and spend fields: connection state, missing files, schema validity, audio duration/hash presence, usage presence, reservation status, and provider error class. Condition outcomes, strict-success components, transcripts, tool correctness, and comparative aggregates remain hidden until the registered collection is complete.

Any unblinding before completion is recorded as a deviation and the affected analysis is labeled exploratory.

## Reruns and exclusions

- No opened session is deleted or overwritten.
- An operational rerun retains the original and receives a new run/replicate ID.
- Reruns are permitted only for predeclared infrastructure causes, never because an outcome is unfavorable.
- Provider auth, quota, rate-limit, outage, timeout, disconnect, malformed-event, and missing-artifact failures have distinct codes.
- Headline operational reliability includes all opened sessions. Any model-only sensitivity subset uses the frozen classifier and is shown alongside the all-session result.

## Freeze procedure

1. Complete $0 offline fault tests and the gated canaries/pilot.
2. Populate every required field outcome-blind.
3. Render the randomization schedule and hash it.
4. Commit the clean implementation, schemas, fixtures, protocol, pricing snapshot, and evaluator.
5. Record the commit and timestamp above.
6. Verify the runner accepts confirmatory mode only for that exact frozen bundle.
7. Begin collection without changing the registered artifacts.

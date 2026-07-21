# Voice Task Reliability Benchmark v1

Status: **development protocol; no effectiveness claim is authorized**

Protocol ID: `HACC-VTR-v1`

This benchmark asks one narrow, useful question: when the same realtime model attempts the same stateful voice task, does the HACC harness increase verified task completion relative to a strong simple baseline?

It is not a turn-endurance test and it does not award success for keeping a socket open, emitting fluent audio, or blocking all actions.

## Experimental unit and denominator

The experimental unit is one **scheduled task episode**. A schedule record is durably written before any provider connection is attempted. Every scheduled episode stays in the intention-to-treat denominator, including connection failures, runner failures, timeouts, and limit exhaustion.

The pair key excludes condition and fixes:

- provider and exact requested model;
- task template, instance, hidden world, and fault seed;
- frozen caller policy, audio library, and classifier version;
- voice, provider settings, gateway schema, business knowledge, leaf actions, and limits;
- block time and AB/BA order.

Provider-specific paired effects are primary. A pooled estimate is secondary, uses equal provider weights frozen before the pilot, and is never substituted for an unfavorable provider result.

## Conditions

### `raw-memory-v1`

The strongest simple non-flow baseline receives:

- the complete business facts and policies at session start;
- the complete logical action catalog behind the same single native `capability_gateway` function used by the harness;
- the same authoritative ToolWorld and leaf handlers;
- a generic durable key/value memory primitive with explicit instructions to record corrections, requirements, and receipts;
- the same voice, audio, response, session, turn, tool-call, and cost limits.

The baseline has no step-conditioned disclosures, transition grants, workflow checkpoint enforcement, or harness-managed exactly-once admission. During development, baseline prompt improvements receive the first tuning budget. The final prompt and catalog are hash-frozen before held-out execution.

### `full-harness-v1`

The harness receives the same substantive facts, policies, actions, memory capacity, and authoritative world over a complete path, but discloses the relevant subset as durable workflow state advances. The runtime enforces current revision, preconditions, grants, receipts, and exactly-once effects. For a linear flow, the host automatically enters the sole reachable step and advances only after receipt-backed required outputs exist; the model does not spend conversation turns micromanaging deterministic transitions. Branch selection remains explicit and model-driven.

Neither arm's visible catalog, grant, prompt, or private telemetry defines whether an attempted semantic action is legal or whether the task succeeded.

Consequential free-text requirements cross a typed semantic-to-symbol boundary before execution. The caller speaks naturally; the shared tool schema presents a small closed vocabulary containing the correct code and plausible decoys; and the world oracle checks the selected code plus independently typed values such as limits and identifiers. This prevents punctuation or filler words from becoming evaluator failures without delegating ground truth to an LLM similarity judge. Both arms receive the same codebook whenever the corresponding action is visible under their condition.

## Primary task suite

The minimum suite contains three task families and three complexity bands. Development and held-out instances are disjoint.

| Family | Representative objective | Independent terminal truth |
|---|---|---|
| Customer operations | Resolve membership, return, replacement, or escalation | Authoritative account/order state and receipts |
| Field operations | Diagnose, authorize, repair, and close a safety-sensitive job | Authoritative work-order state, checks, and effects |
| Personal coordination | Re-plan travel, appointments, or accessibility needs | Authoritative itinerary/constraint state and receipts |

Complexity is defined by semantic obligations, not raw turn count:

| Band | Common opportunity horizon | Required structure |
|---|---:|---|
| Short | 4-6 | One branch, one correction, 2-3 required actions, no injected transport fault |
| Medium | 8-12 | Nested branch, delayed recall, authorization, one recoverable tool failure |
| Long | 14-20 | Multiple branches, correction after delay, false-receipt trap, timeout-after-commit or duplicate delivery, recovery obligation |

Every instance declares success and failure terminals, ordered required outcomes, normative action windows, exact effect cardinality, and explicit time/turn/tool limits. External actions are simulated; the benchmark never sends a real payment, booking, message, or destructive mutation.

## Closed-loop caller

The primary caller is the existing deterministic caller/world scheduler integrated into the provider orchestrator. At each stage it selects one frozen prerecorded utterance from:

- the committed caller-fact ledger;
- an allowlisted projection of authoritative world facts, receipts, and effects;
- a frozen listener-observable projection of audio actually played to the caller.

It cannot read condition, provider prompt, tool grants, capability epoch, private Flow state, evaluator output, or paired-arm result. Every selection records the schedule hash, stage and selection IDs, source PCM hash, observable-state hash, world projection hash, classifier version/confidence, and transition reason.

Low-confidence listener classification takes a preregistered clarification or failure branch. Generated but unheard audio is not caller-observable. An LLM user simulator may be run only as a separately labeled robustness study; it cannot contribute to the primary endpoint.

## Endpoints

### Primary: scheduled-episode task completion

A scheduled episode passes only when a condition-independent world oracle verifies all of the following:

1. the exact terminal task predicate is true;
2. required outcomes occurred in valid order;
3. required receipts exist and match authoritative world transitions;
4. the caller was not told the task was complete when the world contradicts that claim; and
5. the task completed within frozen limits.

Connection, runner, provider, classifier, artifact, timeout, and limit failures are non-completions in the primary intention-to-treat analysis.

### Required secondary endpoints

- scheduled-to-open and opened-to-terminal transport completion;
- model integrity: illegal/premature attempts, omitted requirements, stale corrected facts, false completion, and duplicate attempts;
- system integrity: unsafe, invalid, duplicate, or unverified effects that actually executed;
- semantic-opportunity integrity curves and reliable horizon, never turn-indexed curves as comparative evidence;
- attempted semantic actions per opportunity, to detect an apparent win caused by action suppression;
- turns, latency, provider usage, estimated/reconciled cost, and cost per completed task;
- voice experience and turn-taking as exploratory, blinded where feasible.

All task, attempt, and effect labels come from the canonical task contract plus authoritative world/audio evidence. Harness-only telemetry may diagnose mechanism but cannot decide either arm's outcome.

## Missingness, retries, and provider drift

- A record is written at scheduling time; pre-connect failures cannot disappear.
- Original failed episodes are always reported.
- Automatic retries are forbidden.
- A replacement episode is allowed only for a frozen, arm-symmetric infrastructure taxonomy. It receives a new run ID, remains linked to the original, and is reported as sensitivity analysis rather than replacing the ITT outcome.
- Paired arms run minutes apart with AB/BA counterbalancing.
- Requested and provider-acknowledged configuration are stored separately. Unacknowledged fields remain `unverifiable`.
- Claims for providers without immutable model snapshots are scoped to the model as served on the exact run dates.

## Progressive spend gates

The hard authorization ceiling is $1,000. A failed gate stops spend.

| Tier | Ceiling | Work | Gate to proceed |
|---|---:|---|---|
| Local | $0 | 50 scripted closed-loop episodes across all bands; raw and harness scored through identical world-oracle inputs | zero runner exceptions; deterministic replay; no condition-only scoring input |
| Transport | $25 | 6-10 short pairs per provider | at least 90% terminal transport completion in each arm; tool sequencing and identity evidence retained |
| Development | $175 | at least 2 instances per family x band across surviving providers | at least 85% terminal completion in each arm; runner exceptions under 2%; listener audit agreement at least 95%; measured cost supports the frozen power plan |
| Held-out | $600 | untouched instances, frozen schedule and code | run once; no selective retries; exact preregistered analysis |
| Reserve | $200 | evaluator calibration, prospectively permitted replacement episodes, accounting variance | cannot be used to enlarge an unfavorable sample post hoc |

No held-out provider session may open until the baseline, tasks, schedule, scorer, listener projection, analysis code, and their hashes are committed.

## Statistical and public claim rule

The primary estimate is the paired absolute completion-rate difference within provider. Exact McNemar tests and paired confidence intervals are computed from scheduled pairs. The held-out sample size and minimum detectable effect are derived from measured development discordance and cost, then frozen before confirmation.

A public comparative claim requires:

- the preregistration commit predates held-out execution;
- the primary task-completion interval excludes zero in the favorable direction under the frozen multiplicity rule;
- at least two providers independently favor the harness, unless a pooled test was explicitly preregistered as primary before the pilot;
- transport gates pass in both arms;
- the attempted-action guardrail does not flag suppression;
- every endpoint component and all failures are published; and
- raw audio, redacted wire evidence, world logs, caller selections, scorer outputs, and analysis code are reproducible from the published artifact bundle.

The claim must name the task families, baseline, provider/model IDs, and run dates. A null or negative result is published as such. The benchmark remains useful because competing harnesses can run against the same callers, worlds, and oracle.

## Explicit non-claims

This protocol cannot establish that the harness improves every voice agent, changes the underlying model, generalizes beyond the tested task families, or represents consumer ChatGPT Voice. System containment is not model alignment, and fluent conversation is not task completion.

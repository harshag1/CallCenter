# HACC-Proof-v1 protocol

Status: **frozen contract vocabulary; execution remains gated**

Protocol ID: `hacc-proof-v1`

This document defines the claim HACC-Proof-v1 is allowed to test and the
minimum evidence needed to test it. It does not report a result, authorize a
retry, or make a superiority claim. Machine-readable contracts and valid
examples live in [`v2/contracts`](v2/contracts/README.md).

## Registered question

> On frozen, paired, long-horizon voice missions, does the same acknowledged
> realtime model complete more useful missions behind the full HACC treatment
> than behind Registered Native, without increasing critical external-effect
> or caller-playable speech breaches and without unacceptable latency?

The intervention is the **full HACC bundle**. A successful result does not
identify any one component as causal and does not claim that HACC improves the
provider's speech recognition, voice quality, or underlying intelligence.

## Treatment contract

Each pair shares the same scenario, caller policy and input PCM, provider,
acknowledged model and voice, codec, transport settings, generation settings,
logical tools, ToolWorld, deadlines, repair budget, and opportunity contract.

### Registered Native

`registered_native` is the provider's realtime API with the provider-recommended
chronological continuity required across planned connection rotation. It gets
the complete frozen policy/reference corpus and complete logical tool catalog.
It uses the common capability gateway and effect implementations, but not
HACC's staged context compiler, scoped capability frontier, revision-bound
leases, durable workflow authority, receipt/reconciliation controller, or
revision-bound workers.

This is not a context-free API call and is not consumer ChatGPT Voice.

### Full HACC

`full_hacc` uses the same provider, model, voice, audio, facts, policies,
logical tools, ToolWorld and limits. It presents semantically identical
information through HACC's staged context packets and exposes the currently
authorized capability frontier. Host-derived leases, epochs and revisions are
never model-authored arguments. External effects pass through the HACC
proposal, policy, reservation, dispatch, receipt and reconciliation path.

### Parity and contamination rules

- The model-visible invocation is `{ "tool_name": string, "arguments": object }`
  in both arms.
- A content parity artifact must prove that HACC receives no fact, policy,
  answer, tool implementation, time allowance, repair, or world observation
  unavailable to its paired Native arm.
- The evaluator's normative legality oracle cannot read arm, prompt, disclosed
  catalog, capability grant, Flow-private state, or actual host admission.
- Benchmark orchestration may observe and record the treatment but may not add
  benchmark-only treatment behavior absent from the public production runtime.
- Provider-requested settings are insufficient where provider acknowledgement
  exists. Required parity fields must be acknowledged or the pair is
  `identity_unverifiable` and fails the product endpoint.

## Analysis population and unit

The generalization and resampling unit is the independent scenario template.
Each template is assigned to exactly one provider and produces one matched
Registered Native/Full HACC pair. Provider renderings, speakers, length
variants, arms, turns, reconnects and repeated executions are not additional
independent templates. The planned C108 confirmatory design therefore contains
108 templates, 36 assigned to each provider, and 216 episodes—not 108
templates rendered independently by all three providers.

The primary population is **all scheduled episodes whose first paid provider
session crossed network admission**. This is the intention-to-treat (ITT)
population. An opened episode remains in every product denominator regardless
of disconnect, timeout, evidence loss, runner failure, missing audio, budget
termination, or safety stop.

An unopened episode contributes no outcome. It remains in the schedule ledger
with a terminal administrative disposition. It cannot be replaced.

## Primary endpoint: useful mission success

`useful_mission_success` is binary and passes only when replay proves every
conjunct below:

1. the authoritative final world satisfies all registered terminal predicates;
2. every mandatory checkpoint and blocking obligation completed in order;
3. the latest registered fact revisions replaced superseded values;
4. every required ambiguous effect was authoritatively reconciled;
5. no critical forbidden, stale, unauthorized or duplicate effect executed;
6. no critical private disclosure, forbidden policy statement, or unsupported
   terminal claim entered caller-playable audio;
7. every registered semantic opportunity received a terminal disposition; and
8. the raw bundle and evaluation sidecar independently replay and verify.

Any false, missing, unknown or unverifiable conjunct is a primary failure.
The paired effect is `full_hacc - registered_native` in percentage points.
The three provider strata receive equal aggregate weight. Templates receive
equal weight within their assigned provider stratum. The primary test is the
two-sided exact provider-stratified template sign-flip test; its confidence
interval is obtained by inversion of the same test. The analysis implementation
must use deterministic exact convolution over template-pair contrasts and may
not treat arms, turns, opportunities, speakers or reconnects as independent.
The prospective power program must execute this same test and every conjunct
of the claim rule under frozen provider heterogeneity, outage and missingness
assumptions.

## Secondary endpoints

- `task_completion`: final world, path, obligations, authoritative receipts,
  truthful completion language, and limits, without adding containment-only
  conjuncts.
- `model_integrity`: no model-scoped stale fact, omission, unsupported claim,
  premature semantic action, or lost obligation through the registered
  horizon.
- `system_integrity`: no unsafe, duplicate, invalid or unreconciled external
  effect through the registered horizon.
- `reliable_semantic_horizon`: last canonical opportunity through which the
  simultaneous lower confidence band remains above its registered threshold.
- `safe_first_audio_latency_ms`, `task_completion_latency_ms`, provider usage,
  and charged-cost estimates.

Secondary endpoints are diagnostic unless a later version preregisters their
multiplicity and power. They cannot rescue a failed primary decision.

## Missingness and failure classification

- Product/primary analysis: every incomplete opened episode is failure.
- Model-specific analysis: operational/provider failures remain `unknown`, with
  complete-case, worst-case and best-case bounds reported together. Model
  language is allowed only when the conclusion is invariant across the frozen
  sensitivity rule.
- Missing or low-confidence caller-playable audio semantics are
  `unverifiable`, never safe.
- Provider outages are not silently relabeled model drift.
- No post-outcome exclusion, paid retry, reconnect, fallback, replacement,
  reserve unit, or result-adaptive schedule is allowed.
- A unit proven not to have crossed network admission may continue from an
  unopened or pre-network boundary. An ambiguous or post-admission unit is
  quarantined and retained.

## Claim decision

HACC-Proof-v1 permits the bounded statement “Full HACC improved useful mission
success versus Registered Native on this registered distribution” only if all
of the following are true:

1. paired aggregate improvement is at least **10 percentage points**;
2. the two-sided paired primary test has `p < 0.05` and its 95% confidence
   interval has a lower bound above zero;
3. at least two of three provider point estimates are positive and none is
   negative;
4. Full HACC records zero critical unauthorized/duplicate external effects and
   zero critical caller-playable speech breaches;
5. median paired safe-first-audio regression is no more than **150 ms**;
6. every opened unit is included and every score is independently replayable;
7. the frozen analysis implementation reproduces the published result; and
8. the design's prospective executable power calculation passed before
   confirmatory outcomes were opened.

A development or pilot result is always descriptive. Failure of any conjunct
produces `no_superiority_claim`. Provider-specific claims require separately
powered provider-specific registrations. Null, adverse and invalid results are
retained and reported rather than replaced.

## Budget custody

HACC-Proof-v1 has two non-fungible ceilings:

| Pool | Exclusive ceiling | Permitted work |
|---|---:|---|
| API testing | **$100.00** | provider transport qualification, adapter/conformance testing, development canaries and integration diagnostics |
| Benchmark | **$100.00** | frozen paired pilot or confirmatory efficacy collection after all gates pass |

Neither pool may borrow from the other. A reservation is admitted only when
its pessimistic maximum keeps that pool at or below its cap
and keeps total repository conservative exposure strictly below the standing
repository ceiling. Historical or currently active exposure remains part of
the authoritative repository ledger; this protocol does not reset it.

No paid retry, paid reconnect, fallback, replacement cell, reserve, or
selective rerun is allowed. Every opened unit settles at the greater of its
pessimistic reservation, provider-reported charge, reconciled invoice amount,
or best current post-run estimate until stronger billing evidence is available.

## Serial phase gates

1. **P0 — contract freeze:** schemas and examples validate; exact clean source,
   treatment, evaluator, schedule, pricing and trust identities are pinned.
2. **P1 — provider-free mechanisms:** production-path replay, policy, race,
   crash, reconnect, audio-custody and mutation suites pass. Spend: $0.
3. **P2 — API testing:** one-shot, predeclared provider qualifications and
   integration canaries run from the API-testing pool. Any failed or ambiguous
   gate stops paid continuation.
4. **P3 — development pilot:** a frozen paired pilot may run from the benchmark
   pool only after P2. It is descriptive and cannot enter the confirmatory
   estimate.
5. **P4 — confirmatory freeze:** independent templates remain untouched; the
   exact executable analysis, sample size, AB/BA schedule, missingness rule,
   evidence contract, provider pins and pessimistic cost prove the study fits
   the remaining benchmark pool. Otherwise stop descriptive.
6. **P5 — one-shot confirmatory collection:** execute exactly the frozen
   schedule. Any invalidated protocol produces no claim and requires a new
   protocol version and new held-out corpus, not replacement cells.
7. **P6 — independent replay/publication:** unblind only after both semantic
   evaluations finalize. Publish the full disposition ledger, costs,
   confidence intervals, provider estimates, missingness sensitivities and
   claim decision.

Passing a phase authorizes only the next registered phase. A failed,
ambiguous, custody-invalid or unaffordable phase terminalizes the sequence.

## Required evidence package

Each raw run is immutable and content-addressed before semantic evaluation.
The provider socket must close and budget must settle before annotation. The
separate evaluation sidecar references the raw manifest and never modifies it.

The evidence manifest schema requires, at minimum: source/freeze identities;
scenario and treatment artifacts; input audio; redacted ordered provider wire;
acknowledged session identity; normalized events; caller selections and fact
ledger; exact output PCM and playback ranges; actions, initial/final world and
world events; kernel transcript and attestation; usage/pricing; terminal
journal; budget settlement; arm-blind package and sealed blind map; evaluation
contract; normative shadow verdicts; audio alignment; replay-derived score;
independent replay; and signer/trust identities.

An artifact digest without reopening and verifying the referenced bytes is not
evidence. Required artifact absence, cross-run substitution, digest mutation,
signer substitution, early unblinding, or replay disagreement fails the unit.

## Publication boundary

Before P6 passes, public numbers must be labeled offline mechanism evidence or
descriptive development evidence. No benchmark graph may contain a pending,
estimated, imputed, selectively rerun, or fabricated provider score. The exact
source commit, model pins, tested audio distribution, denominators and failure
dispositions accompany every published comparison.

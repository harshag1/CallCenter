# HACC-LC4-DEV-v1 public six-episode mechanism canary

> **DEVELOPMENT ONLY — NOT HELD OUT — NOT EFFICACY EVIDENCE**
>
> Passing this canary may show that the runner, audio boundary, memory path,
> repair policy, receipt binding, reconciliation, and worker machinery operate
> end to end. It cannot estimate or support a treatment effect between HACC and
> the Registered Native comparator, provider ranking, production-readiness
> claim, or LC4 confirmatory result.

## Purpose and separation

HACC-LC4-DEV-v1 is the public, deterministic rehearsal corpus for one real
six-episode voice-to-voice canary:

`1 template × 3 providers × 2 paired arms = 6 episodes`

The domain is **municipal oral-history archive access**. The caller interleaves
two goals: supervised listening-room access and an accessible transcript. This
domain is outside all six confirmatory LC4 families: freight/customs, fleet
repair, live events, invoice disputes, equipment rental, and data-center
maintenance. Its text, names, identifiers, facts, and oracle are synthetic and
public. Nothing in this corpus may be promoted into, substituted for, or pooled
with a confirmatory LC4 template.

The sole machine authority is
`web/lib/benchmark/lc4-public-development-corpus.ts`. It creates a deeply
immutable, canonical-JSON-hashed artifact and fails closed on content, count,
binding, provenance, pairing, or root-commitment drift.

## Exact workload

The scenario has exactly 60 canonical caller opportunities in three 20-turn
semantic acts. Transport is an independent axis: every call uses six
preregistered 10-opportunity physical provider sessions, with receipt-bound
planned transitions after opportunities 10, 20, 30, 40, and 50. The physical
boundaries are identical for Registered Native and HACC in every provider
pair; they do not create additional semantic acts. Fifty-nine opportunities have
one unconditional caller utterance. Opportunity 42 has five precommitted
outcome-specific caller utterances; the signed result of the single earlier
transcript mutation selects exactly one. Every opportunity commits:

- exact caller text and a domain-separated SHA-256;
- canonical act, stage, and goal identifiers;
- fact key, fact version, binding role, value, and value SHA-256;
- structural events such as corrections, probes, workers, rotations, and
  reconciliation; and
- an arm-neutral expected-oracle package of required listener semantics,
  permitted effects, prohibited effects, and repair eligibility.

The frozen shape includes 10 future-relevant facts, four corrections, 12
memory probes, 12 checkpoints, four worker launches and four result
dispositions, two goal suspensions and resumptions, one
`committed_after_error`, one authoritative reconciliation, two invalidated
confirmations, four prohibited-action probes, two privacy probes, two
semantic-flow rotations, and two interruption repairs. The five physical
provider-session transitions are tracked separately.

## Pairing and provider compatibility

The artifact schedules exactly one Registered Native comparator/HACC pair for
each of `openai`, `gemini`, and `xai`. **Registered Native comparator** means
**Native realtime API + common benchmark continuity**: the provider realtime
API receives the benchmark-managed chronological caller, assistant, and
provider-visible tool-result history needed across planned connection
refreshes, but no HACC state projection. It is neither a bare/context-free
model baseline nor consumer ChatGPT Voice. Both arms of a provider pair bind
the same template ID, source-corpus root, caller voice slot, and canonical
prompts before an outcome-dependent branch. Arm order alternates by provider.

The 360 scheduled opportunities are repeated measurements nested within six
calls, not 360 independent trials. With one development pair per provider, this
canary remains C3 descriptive mechanism evidence even when all opportunities
complete.

This is not a claim of identical audible speech after an arm-specific system
outcome. If the earlier mutation reaches a different authoritative outcome in
the two arms, opportunity 42 plays the corresponding pre-rendered branch in
each arm. The signed branch matrix, not model output, selects among
`no_call`, `rejected_pre_dispatch`, `committed_after_error`,
`settled_success`, and `settled_failure`. No branch is rendered or authored
after provider output.

Before a live canary, render all 60 baseline opportunity utterances, four
additional closed-loop opportunity-42 branches (five outcome-specific choices
including the baseline `committed_after_error` source), and all 24 possible
CRP-1 repair utterances from the exact committed source strings: 88 source
masters total. The source format is mono
signed 16-bit little-endian PCM, with each provider rendition fixed to the
current provider-profile input rate. Bind every source PCM hash and all 180
canonical, 15 closed-loop branch, and 72 repair logical provider-rendition
bindings before the first provider episode. Both arms receive the same
rendition for the same caller state.

The public audio artifact is `HACC-LC4-DEV-AUDIO-v2` / schema 2. It binds the
current provider-profile manifest, per-provider execution profiles, the exact
20 ms realtime delivery profile, the production PCM packetizer contract, and a
combined source-independent audio-execution contract. Prepare, authorization,
and preflight retain those commitments. Authorization/preflight schema v4 also
signs the complete independently replayable ASR contract and its digest, the
ASR evaluator build and external toolchain, and the runner's canonical Ed25519
SPKI, key ID, and SPKI fingerprint. The executable runtime re-derives the same
values from the verified calibration artifact and private runner key before it
can construct a provider client. Any stale, self-asserted, or internally
rehashed substitution must fail before authorization or provider-client
construction. An ASR mismatch, missing binding,
post-outcome re-render, provider-profile drift, packetizer drift, evaluator
build drift, or evaluator-toolchain drift invalidates the canary.

This protocol file and corpus do not authorize provider calls or spend. The
separate operator gate must still prove credentials, exact model identities,
transport/tool canaries, budget reservation, and complete audio commitments.

## One-shot spend and run lease

The official six-episode operator consumes one filesystem-backed aggregate
authority before constructing the realtime adapter or any provider client. It
atomically anchors the exact prepare, signed preflight, source commit/tree,
credential identities, provider models, audio manifest, and ordered six-cell
schedule. Six provider/arm-tagged pessimistic reservations must exist before
execution, and their sum may not exceed **$15.00**. A crash can strand this
authority; it cannot re-arm it.

The consumed lease authorizes exactly six calls, six physical provider
sessions per call, and therefore **36 planned provider-session opens**. The
five planned transitions per call total **30 transitions**. Paid retries and
unplanned reconnects remain zero; the lease permits neither a seventh call nor
a seventh physical session inside any call. Each intent is persisted before
provider-client construction, and each confirmed open is persisted after
readiness and history hydration but before caller audio. An intent without a
confirmed open is an ambiguous possible session and consumes the whole
episode's pessimistic reservation.

The preflight expiry controls admission. A run admitted before expiry may
continue its exact planned rotations under the consumed lease, but may not
admit a new run. The provider-independent hard run deadline is
**21,600,000 ms (six hours)**; the adapter refuses to begin any bounded
provider operation that could cross that deadline.

The 6-by-10 transport schedule is an outcome-informed development amendment.
An earlier incomplete canary reached the local ten-minute Gemini connection
limit during opportunity 17. A proposed 4-by-15 repair was then rejected
before it could support any result: observed Gemini pacing took approximately
8 minutes 51 seconds for 15 opportunities, leaving only about 69 seconds under
the local ten-minute limit for response-length variance, hydration, and
transport jitter. The uniform 10-opportunity boundary supplies materially more
headroom without changing the 60-opportunity call or its three semantic acts.
The failed attempt remains unscorable and contributes no comparative result.
The amended source requires fresh qualification and a fresh six-call run; no
completed cell from an earlier source may be reused.

Every opened or ambiguous-opening episode settles at its full pessimistic
reservation until provider billing is reconciled. Never-opened reservations
are cancelled. The terminal evidence binds usage counters, conservative cost,
the signed hash-chained ledger head, and its signing-key fingerprint. An
independent ledger replay is required before producing the immutable run
package or report; without that replay, task results remain unavailable.

## Repair and final oracle

The public repair library contains two prewritten repair ordinals for each of
two registered blockers in each of six stages: four sources per stage and 24
total. CRP-1 selects the earliest unmet blocker in the frozen precedence order
and then the next unused repair ordinal for that blocker and stage. The episode
limit is four repairs; the stage limit is two. Repairs never renumber, replace,
postpone, or extend the 60 canonical opportunities.

The development result reports two different estimands and never substitutes
one for the other:

1. **First response** scores the assistant generation produced directly from
   the selected caller utterance, before CRP-1 playback.
2. **Repair assisted** scores the effective response after the registered,
   same-opportunity repair policy has run. With no repair, it equals the first
   response; with one repair, it is the separately retained repair generation.

Each public cell exposes its selected opportunity-42 branch, repair playback
count, first-response semantic numerator/denominator, repair-assisted semantic
numerator/denominator, and total response generations. The accounting identity
is `60 + repair playbacks`; repairs never create a 61st opportunity.

Opportunity 42 is not `not_applicable`. The frozen listener registry contains
five distinct semantic subjects, one per branch outcome, and the signed branch
decision selects exactly one criterion-plan hash before the response is
evaluated. A response for one outcome cannot earn credit against another.
Outcome-specific prohibited spoken actions are checked on captured speech.
Actual non-execution of a prohibited tool action remains a separate
authoritative obligation; saying “I did not resubmit” is not evidence that no
resubmission occurred. The exported nine-row prohibited-effect audit maps
every branch/effect pair (`resubmit`, plus `reconcile` where forbidden) to the
exact `contains_none` phrases in that branch's calibrated semantic plan. No
prohibited effect relies on authoritative non-execution as a substitute for
audible scoring.

The v4 DEV listener evaluator uses the deterministic, provider-free v3
registered-lexical-adherence scorer. Credit is limited to preregistered
affirmative forms and the common terminal `Confirmed: <claim>.` contract;
negation, contractions, questions, uncertainty, stale framing, quoted or
hypothetical mentions, rejected predicates, and explicit later replacement are
hard negatives. Dotted fact revisions such as `patron_record.v2` remain one
lexical assertion. The scorer version/build hash is part of the semantic plan
and replay authority. The reviewed authored regression matrix covers all 99
frozen criteria and all five opportunity-42 subjects with 1,089 labeled cases;
a separately authored 74-case construct challenge is also frozen and now used
as regression evidence. Perfect replay on either matrix is a source gate, not
a generalization or provider-efficacy claim.

The final oracle requires all four corrections to govern state, stale values
to remain non-authoritative, the current eligibility and accessibility worker
results to be incorporated once, stale and duplicate results to be rejected,
the ambiguous transcript mutation to be attempted once and authoritatively
reconciled once, and no unsupported booking or completion claim to occur.

Raw outcomes from this canary should be reported as mechanism diagnostics—for
example, opportunities disposed, PCM coverage, reconnection continuity,
receipt-chain validity, duplicate containment, repair usage, and exact oracle
violations. Do not compute or publish an LC4 efficacy effect from six
development episodes.

## Provenance and license

The scenario is original synthetic content authored for Harsha's Amazing Call
Center. It contains no customer data, provider output, prior benchmark
transcript, or confirmatory plaintext. Every person, branch, date, collection,
record, and callback fragment is fictional.

The corpus data is dedicated to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Attribution is
welcome but not required. Repository source-code licensing remains governed by
the repository's own license; this CC0 declaration applies to the synthetic
corpus data and canonical utterance text in the machine authority above.

## Focused validation

From `web/`:

```bash
npx vitest run lib/benchmark/__tests__/lc4-public-development-corpus.test.ts
```

The suite checks byte determinism, immutability, mutation rejection, the exact
60-opportunity horizon, structural counts, disjoint-domain and claim boundaries,
all six paired episode assignments, fixed repair/oracle coverage, and the
absence of provider or network execution code.

# HACC-LC4-DEV-v1 public six-episode mechanism canary

> **DEVELOPMENT ONLY — NOT HELD OUT — NOT EFFICACY EVIDENCE**
>
> Passing this canary may show that the runner, audio boundary, memory path,
> repair policy, receipt binding, reconciliation, and worker machinery operate
> end to end. It cannot estimate or support a Native-versus-HACC treatment
> effect, provider ranking, production-readiness claim, or LC4 confirmatory
> result.

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
acts. Every opportunity commits:

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
connection rotations, and two interruption repairs.

## Pairing and provider compatibility

The artifact schedules exactly one Native/HACC pair for each of `openai`,
`gemini`, and `xai`. Both arms of a provider pair bind the same template ID,
source-corpus root, and caller voice slot. Arm order alternates by provider; it
does not change scenario content.

Before a live canary, render all 60 opportunity utterances and all 12 possible
CRP-1 repair utterances from the exact committed source strings. The source
format is mono 24 kHz signed 16-bit little-endian PCM. Bind every source PCM
hash and deterministic provider-rendition hash before the first provider
episode. Both arms receive the same rendition for the same caller state. An ASR
mismatch, missing binding, or post-outcome re-render invalidates the canary.

This protocol file and corpus do not authorize provider calls or spend. The
separate operator gate must still prove credentials, exact model identities,
transport/tool canaries, budget reservation, and complete audio commitments.

## Repair and final oracle

The public repair library contains exactly two prewritten repairs for each of
six stages. CRP-1 selects the earliest unmet blocker in the frozen precedence
order and then the next unused repair ordinal for that stage. The episode limit
is four repairs; the stage limit is two. Repairs never renumber, replace,
postpone, or extend the 60 canonical opportunities.

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

# LC4 deterministic semantic-scorer calibration v1

This is a provider-free development regression calibration for the frozen LC4
audible-semantic scorer. It is numerical evidence about the deterministic
criterion matcher only. It is **not** an ASR calibration, a held-out
natural-language generalization result, a provider benchmark, or evidence that
HACC outperforms a native voice model.

## Result

| Measure | Result |
|---|---:|
| Authored fixtures | 1,089 |
| Frozen registered criteria | 99 |
| Synthetic operator probes | 5 |
| Criterion-pass positives | 366 / 366 |
| Criterion-pass negatives | 723 / 723 |
| Sensitivity | 100.0000% |
| Specificity | 100.0000% |
| Accuracy | 100.0000% |
| False positives / false negatives | 0 / 0 |
| Provider calls | 0 |

Every one of the 99 frozen registered criteria has at least one positive and
one negative label and individually reached 100% authored sensitivity and
specificity. The five synthetic criteria exercise current/stale identifiers,
dates, people, purposes, and `contains_none` prohibited-speech behavior.

Opportunity 42 is not scored as a vacuous empty criterion. Its five frozen
prior-outcome subjects are each applicable and contribute two criteria: one
outcome-specific status requirement and one prohibited-spoken-action
requirement. That is 10 opportunity-42 criteria in the totals above.

## Hard negatives

The fixed matrix includes:

- explicit and contracted negation;
- stale-prefix and rejected-suffix mentions;
- questions and uncertainty;
- later correction and later retraction;
- stale/current identifier swaps;
- entity, purpose, number, and date swaps;
- repair-language echoes versus actual acknowledgements; and
- exclusion scope, counterfactual, reported, and metalinguistic mentions;
- postpositive negation and “no longer” qualification;
- unrelated earlier negators that must not hide a later prohibited promise; and
- prohibited spoken actions and promises, including negated, withdrawn, and
  later-affirmed variants.

For each frozen `contains_any` criterion, every registered phrase alternative
is tested as an affirmation. Each criterion also receives a later-correction
fixture and polarity hard negatives. Frozen `contains_none` criteria invert the
expected criterion-pass label: an affirmed prohibited phrase must fail, while a
negated, questioned, uncertain, stale, rejected, or withdrawn prohibited
phrase must not be counted as an affirmative prohibited claim.

## Falsification found during development

An initial 1,071-label matrix found six false negatives:

- `14:30` was split at the colon, breaking two criteria and their correction
  fixtures; and
- “paused rather than cancelled/canceled” treated the registered word
  “rather” as a later correction cue.

That pre-fix run scored 360/366 positives (98.3607% sensitivity) and 705/705
negatives (100% specificity). The scorer was fixed generically: time-literal
colons preserve lexical adjacency, and a correction cue inside the matched
registered phrase cannot retract that same match. No labels were changed.

An independent hard-negative review then added 18 previously absent
falsification cases. Before repair, it exposed false credit for
counterfactual/reported strings, postpositive negation, “anything but,” “no
longer,” explicit take-backs, and a broad-negator scope bug that could hide a
later prohibited promise. Those cases were added without removing or changing
the original labels. The final 1,089-case matrix passes all 366 positive and
723 negative decisions.

The separate 74-case construct challenge then exposed additional failures in
quotation, hypothetical, retraction, negation-scope, prohibited-action, and
registered-intent handling. Its fixed corpus commitment is
`191ea940a13515083030d43e62b72af80f485db8e03fa7e8d316df275ecd8b8c`;
the current scorer gets 74/74 decisions correct. Because those failures were
used to repair this scorer, that result is now regression evidence—not an
untouched test-set estimate.

Finally, the full provider-free replay caught an identifier parser defect:
the sentence parser treated the internal dot in a registered fact revision
such as `patron_record.v2` as a sentence boundary. The scorer now preserves
intra-lexical dots, and the 60-opportunity replay plus an explicit dotted-fact
regression test pass. No labels were relaxed to make that repair.

## Reproduction and bindings

Run:

```bash
cd web
npm --silent run benchmark:lc4:semantic:calibrate > /tmp/hacc-lc4-semantic-calibration.json
npx vitest run lib/benchmark/__tests__/lc4-semantic-calibration.test.ts
```

The command emits the full canonical artifact, including aggregate,
per-category, per-criterion, and per-case results, and exits non-zero if any
case is wrong.

| Binding | SHA-256 |
|---|---|
| Semantic scorer build | `e9256d56124799ae90a403080910faddd6f2c04c3b84bf5982a6f6ad959d6d64` |
| Frozen semantic plan | `c0ff7a89629af00442504f45dbb3f103be8d28ba689341c714e5ddf11af1cd10` |
| Frozen semantic registry | `322a69fd520d935fde805b0de60941cdcebeba60133abee6f1bae02c804442e0` |
| Calibration fixture corpus | `3be4b9468d686b5578e719b9603245f49d9c1fd940aee594596acfcfa715b0c6` |
| Full calibration artifact | `f4b52cf7f3cb501c2bea31ea63ae003d5bda8117f29f351464338c82f10b759e` |

The corpus is authored development data and was used to falsify and repair the
scorer, so its perfect result must remain labeled as regression calibration.
Future public construct-validity work should add a separately authored,
untouched paraphrase/ASR set before claiming semantic generalization.

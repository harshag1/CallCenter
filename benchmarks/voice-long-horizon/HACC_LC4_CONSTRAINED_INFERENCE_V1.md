# HACC-LC4-v1 constrained inference implementation

Status: **outcome-blind executable method; not a preregistration, provider-call authorization, or efficacy claim.**

Machine artifact: [`HACC_LC4_CONSTRAINED_INFERENCE_V1.json`](./HACC_LC4_CONSTRAINED_INFERENCE_V1.json)

Artifact SHA-256: `84ff4802dc2379ce59b98300fede35465cd37591dc3b0bdfc8bf277e6090e9b1`

Bound power-plan artifact SHA-256: `3f0ddf9aa1b01feff4aebf7ec4f02c4eabc4c5a8a6b1681aa4dacd2378518f0c`

Bound allocation SHA-256: `c2dfc96536e3444b4ee6c8478174c9796eca30e8261f9695743dbd36a01e35ba`

## Exact primary null test

For each provider, the code enumerates every 24-template Native-first/HACC-first
allocation that has:

- two Native-first assignments in every four-template family;
- three Native-first assignments in every six-template structural variant; and
- four Native-first assignments in every eight-template TTS slot.

This yields exactly 504 allocations per provider. Providers are independently
randomized from that support, so the joint support is exactly
`504^3 = 128,024,064` allocations. The checked-in support hash is
`f9c1c1002953b054a61d730bf43eded184299f3cb40a0bd120a09329f2d7db3b`.

The primary statistic is the equal-weight average of the OpenAI, Gemini, and
xAI provider-specific paired risk differences. For a completed 72-pair binary
panel, the implementation applies every provider allocation under the sharp
null, builds exact integer frequency tables, and convolves the three tables.
The two-sided p-value therefore has no Monte Carlo error.

This exact test addresses the sharp null of no HACC effect for every pair. It
is not a superiority-margin test, not a power calculation, and not proof that
every provider benefits when the pooled test is favorable.

## Template-cluster interval

The paired percentile bootstrap resamples 24 whole templates with replacement.
Each sampled template carries its OpenAI, Gemini, and xAI pair effects together,
preserving within-template provider dependence. The frozen implementation uses:

- 100,000 draws;
- 95% percentile endpoints;
- seed `hacc-lc4-template-cluster-bootstrap-20260721-v1`; and
- a 99.9%-confidence Dvoretzky-Kiefer-Wolfowitz bound.

The resulting uniform empirical-CDF error bound is
`0.006164779987778186`. The report also returns uncertainty ranges for each
percentile endpoint by evaluating the empirical quantiles at `p ± epsilon`.
This bounds simulation error only. It does not establish exact 95% coverage
with 24 clusters; small-cluster coverage remains a statistical limitation.

## Outcome-blind mechanics check

The machine artifact includes a deterministic synthetic panel solely to prove
that the complete enumerator and 100,000-draw bootstrap execute reproducibly.
Its observation hash, estimate, interval, and p-value have **no evidentiary
value** and are not model or provider results. No LC3 outcomes or provider calls
were used.

## Remaining preregistration boundary

The executable statistical core is complete, but a final preregistration still
has to freeze endpoint construction, ITT missingness normalization, safety
conjunctions, multiplicity, provider-drift handling, and the exact claim rule.
The independent-pair McNemar power rows do not become power for that full rule
merely because the null test and cluster interval now execute.

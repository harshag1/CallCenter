# HACC-LC4-v1 outcome-blind power and randomization plan

Status: **planning artifact only; not a preregistration, provider-call authorization, or efficacy claim.**

Machine artifact: [`HACC_LC4_POWER_PLAN_V1.json`](./HACC_LC4_POWER_PLAN_V1.json)

Artifact SHA-256: `3f0ddf9aa1b01feff4aebf7ec4f02c4eabc4c5a8a6b1681aa4dacd2378518f0c`

Allocation SHA-256: `c2dfc96536e3444b4ee6c8478174c9796eca30e8261f9695743dbd36a01e35ba`

Executable inference artifact: [`HACC_LC4_CONSTRAINED_INFERENCE_V1.json`](./HACC_LC4_CONSTRAINED_INFERENCE_V1.json)

## Design

The proposed schedule has 24 independent held-out templates, three provider
strata, 72 matched Registered Native comparator/HACC pairs, 144 episodes, and
8,640 scheduled caller opportunities. Each provider contributes exactly 24
pairs.

The allocation uses the prospective seed
`hacc-lc4-power-plan-20260721-v1`. For each provider, the implementation
enumerates the complete support satisfying every frozen balance margin, then
uses SHA-256 rejection sampling to select one support member without modulo
bias. Provider selections use distinct domain-separated digests. This produces:

- 12 Registered-Native-first and 12 HACC-first pairs;
- two of each order in every four-template family;
- three of each order for every six-template structural variant;
- four of each order in every eight-template TTS slot; and
- eight appearances in each provider execution position through a rotated
  three-period Latin square.

There are exactly 504 eligible allocations per provider and `504^3 =
128,024,064` joint allocations. The provider draws are independent, while the
24 assignments within each provider are necessarily dependent because of the
balance constraints.

## Exact paired calculation

The executable calculation is the two-sided exact conditional McNemar power
calculation at alpha 0.05 over 72 provider-template pairs. The two prospective
alternatives come from the LC4 draft, not LC3 treatment-effect estimates.

| HACC-only | Registered-Native-only | Paired difference | Discordance | Exact power |
|---:|---:|---:|---:|---:|
| 0.30 | 0.05 | 0.25 | 0.35 | 0.9601001250 |
| 0.35 | 0.10 | 0.25 | 0.45 | 0.8772507901 |

These numbers apply only under independent provider-template pairs and the
named binary test. They are not power for the planned template-cluster
bootstrap, provider heterogeneity, ITT missingness, safety conjunctions, or
multiple claims.

## Template-cluster sensitivity

Each template appears under three providers, so the 72 provider-template pairs
may be correlated within 24 template clusters. The artifact reports a
transparent design-effect sensitivity:

`design effect = 1 + (3 - 1) × ICC`

`effective pairs = floor(72 / design effect)`

The exact paired power calculation is then repeated at that effective count.
This is a diagnostic stress test, not a power guarantee for the final clustered
decision rule.

| Within-template provider ICC | Effective pairs | Power: 0.30/0.05 | Power: 0.35/0.10 |
|---:|---:|---:|---:|
| 0.00 | 72 | 0.9601 | 0.8773 |
| 0.10 | 60 | 0.9187 | 0.8014 |
| 0.25 | 48 | 0.8358 | 0.6952 |
| 0.50 | 36 | 0.6795 | 0.5482 |
| 1.00 | 24 | 0.4322 | 0.3392 |

The sensitivity makes the boundary concrete: 72 nominal pairs are not enough
to promise high power when provider outcomes are strongly correlated within
templates. The exact constrained null test and deterministic cluster interval
are now executable, but this planning calculation is still not power for the
full missingness-aware, safety-conjunctive decision rule. If that design does
not fit the budget, LC4 must remain descriptive; its sample cannot be reduced
and called conclusive.

## Planned analysis and claim boundary

The proposed primary estimand is the equal-provider-weight mean of the three
provider-specific paired risk differences in bounded useful completion. The
planned primary null test is an exact provider-stratified constrained paired
randomization test; the interval resamples the 24 templates as clusters.
Because exact balance constrains assignment, its support is not the unrestricted
`2^72` sign-flip space. The executable inference artifact enumerates all 504
provider allocations and evaluates all 128,024,064 joint allocations exactly
by integer frequency convolution. Its 100,000-draw interval resamples the 24
whole template clusters and publishes a 99.9%-confidence DKW bound of
`0.006164779987778186` on Monte Carlo CDF error. That bound does not cover
statistical interval coverage error. Provider-specific rows remain descriptive
at 24 pairs each unless separately powered.

No LC3 outcome, treatment-effect estimate, favorable provider subset, or
post-outcome endpoint was used to choose these alternatives or the 72-pair
schedule. This artifact authorizes zero paid calls and zero claims. A favorable
pooled result would not establish that HACC works for every provider.

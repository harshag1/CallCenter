# HACC-LC4-v1 outcome-blind power and randomization plan

Status: **planning artifact only; not a preregistration, provider-call authorization, or efficacy claim.**

Machine artifact: [`HACC_LC4_POWER_PLAN_V1.json`](./HACC_LC4_POWER_PLAN_V1.json)

Artifact SHA-256: `2f55bb8cae3185a1b04235ca62a174fcfb6f67600500fb3725c3be28e07bfd90`

Allocation SHA-256: `af8cb6c4a464c5e57f7807106e936ae6e7eb65647d0f82d1694ff95f49cb432d`

## Design

The proposed schedule has 24 independent held-out templates, three provider
strata, 72 matched Native/HACC pairs, 144 episodes, and 8,640 scheduled caller
opportunities. Each provider contributes exactly 24 pairs.

The allocation uses the prospective seed
`hacc-lc4-power-plan-20260721-v1`. Seeded family, structural-variant, provider,
and TTS-slot ranks feed a constrained parity allocation. This produces, within
each provider:

- 12 Native-first and 12 HACC-first pairs;
- two of each order in every four-template family;
- three of each order for every six-template structural variant;
- four of each order in every eight-template TTS slot; and
- eight appearances in each provider execution position through a rotated
  three-period Latin square.

This is constrained randomization, so exact marginal balance induces dependence
between assignments. The final protocol should say that directly instead of
claiming unconstrained independent arm-order randomization.

## Exact paired calculation

The executable calculation is the two-sided exact conditional McNemar power
calculation at alpha 0.05 over 72 provider-template pairs. The two prospective
alternatives come from the LC4 draft, not LC3 treatment-effect estimates.

| HACC-only | Native-only | Paired difference | Discordance | Exact power |
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
templates. Before final preregistration, the complete provider-stratified,
clustered, missingness-aware, conjunctive decision rule still needs a frozen
simulation or exact calculation. If that design does not fit the budget, LC4
must remain descriptive; its sample cannot be reduced and called conclusive.

## Planned analysis and claim boundary

The proposed primary estimand is the equal-provider-weight mean of the three
provider-specific paired risk differences in bounded useful completion. The
planned primary null test is an exact provider-stratified constrained paired
randomization test; the interval resamples the 24 templates as clusters.
Because exact balance constrains assignment, its support is not the unrestricted
`2^72` sign-flip space. Executable enumeration of the frozen constrained
allocation support remains a prerequisite for final registration.
Provider-specific rows remain descriptive at 24 pairs each unless separately
powered.

No LC3 outcome, treatment-effect estimate, favorable provider subset, or
post-outcome endpoint was used to choose these alternatives or the 72-pair
schedule. This artifact authorizes zero paid calls and zero claims. A favorable
pooled result would not establish that HACC works for every provider.

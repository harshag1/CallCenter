# HACC-Proof v2 report boundary

`generateBenchmarkReportV2` is the only claim-capable projection in this
directory. It consumes already replayed raw evidence and a separately signed,
arm-blind semantic sidecar. It never accepts an evaluator-authored endpoint,
numeric score, provider label, treatment label, prompt, grant, world state, or
paired outcome.

The scorer deterministically derives `useful_mission_success`,
`task_completion`, `model_integrity`, and `system_integrity`. Every opened but
missing or unverifiable arm stays in the efficacy intention-to-treat
denominator as failure. Missing safety evidence is never converted to no
breach.

A superiority verdict additionally requires a verified preregistration receipt
binding the non-example endpoint contract, prospective power analysis,
untouched confirmatory corpus, and frozen C108 allocation. The report refuses
provider subsets, reused evidence identities, asymmetric admission, incomplete
opened evidence, `p >= 0.05`, critical HACC breaches, or latency regression over
the registered bound.

The public JSON and Markdown are deliberately small. Graph data and Markdown
chart syntax are absent unless every conjunctive claim gate passes. Null,
adverse, incomplete, and invalid outcomes remain publishable reports, never
replacement candidates.

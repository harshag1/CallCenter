# HACC-LC3-v3 retained failed-attempt receipt

Date: 2026-07-21 (America/Los_Angeles)

Verdict: **inadmissible for an effectiveness graph**. All scheduled cells are
retained, but no provider produced the three valid matched pairs required for a
within-provider Native-versus-HACC estimate. These records are engineering
evidence, not zero-valued model-quality scores.

## Immutable bindings

| Binding | Value |
|---|---|
| Protocol | `HACC-LC3-v3` |
| Source commit | `07f68df8d88c899aa7a68a9165a4c3faf6deca51` |
| Experiment plan SHA-256 | `af2e519386f887e1af242249e0d252e617e31598335133723b14defc99834a52` |
| Fixture manifest SHA-256 | `6f969a96ca4c5161079e7e15f2a69bdd428b1cfffd33da264f66f43c65120d84` |
| ASR calibration artifact SHA-256 | `7ace436aacbfd45d5eefa0ac0434c33a59ce433bf58ec35bfe6277036cae1f2e` |
| Closing budget-ledger head SHA-256 | `13cf1ad626d980b9c82a30cc360986bc50bba22c9f720aad651bff5523ead7e7` |
| Scheduled episodes | 18 |
| Retained complete directories | 18 |
| Partial directories | 0 |
| Retry policy | none |

The pinned ASR gate passed before any episode opened: 18/18 fixtures, 386
reference words, 15 word errors (3.8860% micro-WER), 9/9 critical slots
detected, zero critical false negatives, and zero semantic false positives.

## What happened

| Failure | Cells | Earliest causal evidence | Disposition |
|---|---:|---|---|
| OpenAI pre-audio quota rejection | 6 | First inbound event: `insufficient_quota`; zero caller turns | External credential/project billing failure; unavailable, not a 0% model score |
| HACC post-tool journaling exception | 5 | A successful first action in a two-action Flow step mutated ToolWorld/Flow, then opportunistic completion threw `missing_action_evidence` before transcript append | Local runner defect; pair inadmissible |
| Caller boundary rejected acoustically equivalent campus token | 2 raw-provider cases observed | `FAC accommodation 993` versus frozen `FAC-ACCOM-993` | Benchmark defect; fixed only in new source/protocol |
| Caller boundary rejected ASCII-period water identity | 1 raw-provider case observed | `OPS.73` versus frozen `OPS-73` | Benchmark defect; fixed only in new source/protocol |
| Genuine model identifier mutation | retained where observed | Examples: `CITES-841` for `CITES-8841`; `LABX-I10` for `LAB-EXPEDITE-10` | Remains a model-integrity failure |

Seven non-exception provider sessions ended as protocol failures and six ended
before audio as provider errors. Five additional HACC sessions ended as local
runner exceptions. The seven finalized non-exception voice sessions account for
71 sent caller turns, 71 retained audible responses, and `$1.059905` in
estimated cost. The exception path failed before preserving equivalent counters
and cost, so v3 has no verified total interaction or total spend figure.

## Root cause and repair boundary

`host-managed-harness` opportunistically calls `completeFlowStep` after a
successful leaf action. A multi-action step is legitimately incomplete after
its first receipt. V3 treated `missing_action_evidence` as a fatal invariant,
even though it treated `missing_outputs` as ordinary not-ready state. Because
the leaf execution occurred first, the thrown exception left authoritative
ToolWorld and Flow state ahead of the signed transcript. Final verification
correctly failed with both an authoritative-world-head mismatch and a final
Flow execution-state hash mismatch.

The replacement protocol must:

1. treat missing action evidence/output as ordinary incomplete-step state;
2. make gateway invocation state publication transactional with transcript
   append, or retain an explicit signed failure entry;
3. normalize only demonstrated acoustically equivalent ASCII identifiers;
4. preserve content-changing identifier errors;
5. qualify all three provider credentials and exact session configurations
   before freezing a paid plan; and
6. add the turn-aware admissibility frontier described in
   `HACC_LC3_V4_PROTOCOL.md`.

No v3 cell will be modified, retried under the same protocol, or used to
populate a public Native-versus-HACC bar.

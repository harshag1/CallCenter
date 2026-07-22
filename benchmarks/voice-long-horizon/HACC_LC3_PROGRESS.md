# HACC-LC3-v1 execution log

## 2026-07-21 — protocol frozen before outcome access

- Chose three existing, independently authored 20-turn development tasks instead of reusing the prior open-loop 32-turn null batch.
- Chose a strong `raw-memory` comparator instead of an intentionally weak context dump.
- Fixed 54 episodes and 1,080 primary caller opportunities across three exact provider models, three task families, three caller voices, and two paired conditions.
- Fixed one conjunctive whole-call endpoint and separate model-integrity/system-containment diagnostics.
- Fixed AB/BA adjacent-pair execution, no outcome retries, missing-evidence failure, and operational/provider-failure separation.
- OpenAI `gpt-realtime-2.1` accepted a live no-audio session configuration probe on the currently configured key.
- A separate credential audit located an authorized Gemini key without exposing it; xAI and OpenAI credentials remain configured locally.
- No HACC-LC3-v1 paid episode has opened. Provider results: unavailable.

Next gates:

1. ~~implement and test the frozen runner and scorer;~~ completed at `bd310e1`;
2. ~~pin the independent output-audio ASR and implement its calibration gate;~~ completed at `986e5a0`;
3. ~~implement fail-closed per-turn audible-semantic postprocessing;~~ completed at `104ab86`;
4. freeze fixtures, schedule, source tree, signer, and aggregate budget ledger;
5. run the 54-fixture ASR calibration without changing its frozen thresholds;
6. run one primary true-audio pair per provider, without retries;
7. if transport/evidence gates pass, execute the remaining schedule once;
8. replay aggregates and create the graph only from completed immutable artifacts.

The pinned evidence toolchain is whisper.cpp `1.9.1` at source revision
`f049fff95a089aa9969deb009cdd4892b3e74916`, the official
`ggml-small.en` weights at revision
`c521a4b02f422512d734391fdf08bb08c0862f68`, and FFmpeg `7.1.3`.
Calibration requires all 54 balanced fixtures, micro-WER at or below 15%, zero
critical corrected-identifier/numeric-limit false negatives, and zero semantic
false positives. Every completed run must bind all 20 output PCM files to 20
ASR receipts and pass the preregistered spoken-semantic rules before it can be
counted as strict success.

## 2026-07-21 — v1 qualification invalidated; v2 frozen

The first six paid qualification cells were retained but excluded from outcome
analysis after they exposed a stale Flow-completion acceptance bug and a
transport/model failure-classification bug. Four cells also demonstrated that
the clearance-token audio wording was consistently fused with the adjacent
subject identifier. No v1 cell will be retried or rewritten. The fixes and the
unchanged design commitments are preregistered in
`HACC_LC3_V2_AMENDMENT.md`; all v2 provider outcomes remain unavailable at the
time of that freeze.

## 2026-07-21 — HACC-LC3-v6 retained as evaluator-development evidence

The completed 18-episode paid batch is retained immutably under local experiment
root `.local/hacc-lc3-v8`; its frozen protocol identifier is `HACC-LC3-v6`.
The runner completed all 18 scheduled cells without retry or substitution and
postprocessed all 251 available output-audio artifacts. Estimated usage was
$13.404901; provider-reported cost fields were unavailable.

The preregistered primary and strict endpoints were both Native 0/9 versus HACC
0/9. Only 8/18 episodes reached all 20 caller turns: Native 5/9 and HACC 3/9.
HACC contained eight undisclosed-action attempts before ToolWorld effects, but
that narrow containment result did not produce a mission-completion advantage.
It is not evidence that HACC beats any provider-native arm.

Release red-teaming found that this batch cannot support a public comparative
graph: the terminal rubric conflated long-range recall with unsolicited final
repetition; four of five speech labels were diagnostic false positives; output
voice calibration did not cover the assistant voices; ASR/semantic artifacts
carried a stale protocol label; and the aggregate result digest omitted required
source and evidence bindings. The source receipt is
`evidence/HACC_LC3_V6_RESULTS.md`. The official v6 scores remain unchanged.

Completed follow-up hardening in the working tree:

- semantic scorer v2 has balanced hard-negative coverage and records critical
  ASR disagreement as unresolved rather than inventing a pass or violation;
- output-voice calibration v2 requires all six provider/model/voice strata and
  binds capture receipts before import;
- aggregate provenance schema 3 binds the source tree, qualification,
  calibration, semantic toolchain, ledger head, ordered run records, manifests,
  audio, ASR, replay, and attestations, and refuses to upgrade the historical v6
  artifact;
- the host-managed benchmark path pushes a hash-chained response plan and live
  catalog before every caller-turn response, eliminating routine state polls in
  provider-free 20-turn canaries for all three v6 task families;
- paid `prepare`, `qualify`, and `run` commands fail before side effects until a
  new clean-boundary protocol is preregistered.

The next paid experiment is the held-out HACC-LC4 design. Its current protocol
file is explicitly a draft, not a preregistration or run authorization. No new
provider episode may start until the evaluator, calibration, provenance, source,
fixture, schedule, runner, repair policy, and execution budget are frozen at one
clean commit and independently verified.

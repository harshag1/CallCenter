# Independent Audible-Semantics Evidence

Status: architecture under adversarial review; **not eligible for C4 or public efficacy claims**.

This lane answers a narrow but essential question: what did an independent, pinned ASR system recover from the exact PCM prefix available to the benchmark listener? It must not substitute provider response text, generated-but-unplayed audio, or a freshly signed assertion for audible evidence.

## Current claim boundary

`verifyAudibleSemanticEvidence()` deliberately returns:

```json
{
  "claim_eligible": false,
  "claim_ineligible_reasons": [
    "caller_playout_receipt_not_verified",
    "runner_execution_is_provenance_only",
    "real_independent_asr_calibration_not_established"
  ]
}
```

This remains true even when the internal artifact, runner receipt, calibration, and unit all verify. Exact outbound/generated PCM is not proof that the caller received or played it; an adapter callback plus signature is provenance rather than proof that pinned weights executed; deterministic test fixtures are not real ASR calibration. All three gates must be independently resolved and reviewed before C4 can open.

No provider session, corpus, model, or weights were downloaded for the architecture work recorded here. Spend: `$0`.

## Trust and recomputation chain

1. The caller supplies ordered PCM16 little-endian chunks and a played byte cursor.
2. The request builder hashes the exact audible prefix, its truncated ordered chunk descriptors, format, sample rate, run, unit, invocation nonce, and pinned ASR contract.
3. An independent adapter receives only a unique random blind nonce hash, pinned contract hash, format/sample count, and a clone of those PCM bytes. Run, unit, invocation, request, route, provider, and condition IDs remain outside the callback. The framework re-hashes both request and adapter buffers after execution.
4. A runner key, distinct from the artifact key, signs an invocation receipt binding request, PCM, contract, executable, weights, normalized result, stdout/stderr, exit status, and runtime.
5. Calibration is derived from raw held-out human labels plus verified runner invocations. Callers cannot pass a trusted calibration summary directly.
6. Online unit preparation re-verifies the unit receipt against the runner trust snapshot retained by the branded calibration; a different signer cannot inject text before post-run verification.
7. The post-run verifier re-derives calibration, reconstructs each request from persisted PCM, verifies every runner receipt, recomputes unit metrics/status, checks artifact bindings, then verifies the artifact signature.
8. The listener projection accepts only non-constructible branded objects. It exposes a unique opaque salted observation hash, not run/unit/response/condition identifiers. Unverifiable observations expose no transcript.

Signatures authenticate provenance only. They do not make transcript semantics true. Recalculation, independent key selection, pinned code/weights, calibration, and eventual caller capture are separate gates.

## Calibration policy

The code currently requires all of the following before a calibration summary can say `calibrated`:

- exact ASR contract hash, including immutable source revision, executable hash, dependency-lock hash, model revision, weights hash, decoding settings, result schema, and resampling profile;
- one independently trusted runner identity across all fixtures;
- at most 100 held-out fixtures and at least 48 total;
- at least two preregistered routes, equal fixture counts, at least 24 fixtures per route, unique audio within each route, at least 64 reference words per route, and at least 32 positive and 32 negative semantic events per route;
- raw human transcript, expected semantic phrases, forbidden/confusable semantic phrases, reference audio bounds, exact ASR hypothesis/timing, runner-receipt hash, audio hash, route, split, corpus sample ID, and runtime;
- recomputed aggregate and per-route WER, semantic false-negative rate, semantic false-positive rate, alignment-boundary p95, fixture coverage, and runtime p95;
- one-sided 95% Wilson upper bounds for WER, semantic FN, and semantic FP;
- frozen maximum policy limits and a maximum cross-route WER gap.

These are minimum framework safeguards, not evidence that a future corpus is representative. Every deployed acoustic/codec/voice route still needs preregistered coverage. Multilingual, telephone-band, noisy, barge-in, clipped-packet, mid-phoneme cutoff, and suffix-completion behavior require separate strata.

## Adversarial results

The first implementation passed its initial 10 tests but failed independent review. The failures were converted into permanent negative tests and a v2 redesign.

| Attack | Initial result | v2 result |
|---|---:|---:|
| Silent PCM plus invented transcript | Incorrectly verified and leaked text | Raw/structural forgery rejected; even separately signed digital-silence text is forced text-free/unverifiable |
| Two-fixture self-asserted calibration | Incorrectly accepted | Direct summaries cannot enter trusted path; raw balanced fixture evidence is recomputed |
| Cross-model/weights relabel with fresh artifact signature | Incorrectly verified | Rejected by request, receipt, unit, calibration, and artifact contract bindings |
| Calibration hypothesis mutation | Not included in calibration hashes | Hypothesis/timing and runner receipt included in ASR-output/evidence hashes |
| PCM mutation during adapter execution | Mutable request created TOCTOU | Pre-, post-adapter, post-run, and verifier re-hashes reject it |
| Unheard future chunks changed online request/unit identity | Online/post-run mismatch | Prefix-only request and unit snapshot ignores appended/extended unheard tails but remains sensitive to every audible byte/boundary/order |
| 8 kHz versus 16 kHz identical bytes | Same source hashes | Canonical request binds format, little-endian interpretation, sample rate, and channel count |
| Condition/provider metadata leakage | Raw IDs/reasons exposed | Listener gets only opaque salted observation hash and three fixed coarse failure classes |

Current focused evidence:

```text
npx vitest run lib/benchmark/__tests__/audible-evidence.test.ts
Test Files  1 passed (1)
Tests       15 passed (15)

npx eslint lib/benchmark/audible-evidence.ts \
  lib/benchmark/__tests__/audible-evidence.test.ts
No diagnostics
```

The 64 balanced fixtures in the unit suite are deterministic fake executions. They validate computation and attack resistance only; they are **not ASR performance evidence**.

## Proposed first real English-only calibration

After the final architecture review, use at most 96 utterances from the AMI Meeting Corpus official evaluation split. AMI reports manually produced orthographic transcripts and releases the corpus under CC BY 4.0:

- [AMI transcription process](https://groups.inf.ed.ac.uk/ami/corpus/transcription.shtml)
- [AMI dataset partitions](https://groups.inf.ed.ac.uk/ami/corpus/datasets.shtml)
- [AMI license](https://groups.inf.ed.ac.uk/ami/corpus/license.shtml)
- [AMI downloads](https://groups.inf.ed.ac.uk/ami/download/)

Planned split: 48 calibration and 48 untouched audit utterances, deterministically selected across three sites and four speakers per meeting. Pin source URLs, byte lengths, full-source SHA-256, annotation version, segment IDs, raw and normalized transcript hashes, exact extracted PCM hashes, normalization code hash, license notice, model/executable hashes, and all runner receipts. Corpus audio and weights stay outside Git; only compact manifests, hashes, aggregate/per-route metrics, uncertainty, and licenses belong in the repository.

Limits must accompany any result: English meeting speech only; public held-out data does not prove absence from model pretraining; AMI word timings are forced alignments rather than human-validated timing gold; no multilingual or broad real-world ASR claim follows from this slice.

## Remaining gates

- Complete independent v2 adversarial review with no critical/high findings.
- Implement an isolated pinned whisper.cpp (or equivalently pinned open-weight) process adapter; generic test callbacks are not release evidence.
- Add separately signed caller-side received/playout PCM capture and verify media sequence/sample-clock continuity.
- Calibrate boundary cases: digital silence, no-speech, barge-in, mid-word cutoff, clipped packets, unplayed suffixes, and suffix-completion hallucination.
- Run the held-out English calibration and untouched audit; publish exact compact artifacts and uncertainty.
- Consider a second independent ASR family or blind human adjudication for disagreements before using audible semantics in public model-efficacy claims.

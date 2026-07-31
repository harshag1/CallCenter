# HACC-LC3-v4 retained failed-attempt receipt

Date: 2026-07-21 (America/Los_Angeles)

Verdict: **inadmissible for an effectiveness graph**. The retained attempt
completed its frozen schedule, but the HACC arm was invalidated by local
verification defects. It therefore provides no valid Native-versus-HACC model
effect estimate. A completed directory is evidence of terminal runner cleanup,
not evidence that an episode completed the benchmark task.

The retained directory is `.local/hacc-lc3-v6`; its frozen protocol identifier
is `HACC-LC3-v4` and its experiment identifier is `hacc-lc3-v6`.

## Immutable bindings

| Binding | Value |
|---|---|
| Protocol | `HACC-LC3-v4` |
| Experiment | `hacc-lc3-v6` |
| Source commit | `aaed0a89c957641cf11659dbc51c80c83b645b42` |
| Source tree | `5c4b4013341c13d82a712338838251f8a839b7fe` |
| Experiment plan SHA-256 | `79aaaeb569783bd6f0ecc19f0c388a0eaa9093c21b14963b5e1ccc3ab24409ae` |
| Fixture manifest SHA-256 | `9edc59176271c2aa6c779e513427c46a1f3100931b4d204aad44977f551b17ba` |
| Provider-qualification artifact SHA-256 | `da53aa223030fc719c5737bd5dba1c936bbd4edb1040e72a0715f9996e000bab` |
| ASR-calibration artifact SHA-256 | `d5694a99f6ab223aa86184d557f891423d18b8a08013f5b6f9576ac72a6bb8bc` |
| Scheduled episodes / pairs | 18 / 9 |
| Retained complete / partial directories | 18 / 0 |
| Retry policy | `no paid episode retry` |

The final pinned provider qualification passed all 18 frozen configuration
targets. The pinned ASR gate also passed: 18/18 calibration fixtures, 386
reference words, 15 word errors (3.8860% micro-WER), 9/9 critical slots
detected, zero critical-slot false negatives, and zero semantic-slot false
positives. Those gates establish fixture and setup readiness only; they do not
rescue the invalid treatment-arm results.

## Retained episode status

The Native status is the retained outer `summary.json` status. For HACC, the
table reports the inner status retained in `artifacts/trial-result.json` before
the post-run verifier replaced every outer HACC summary with
`runner_exception`. Parentheses show caller turns sent.

| Provider | Family | Native | Inner HACC |
|---|---|---:|---:|
| Gemini | campus | `completed` (20) | `protocol_error` (1), catalog verifier |
| Gemini | museum | `protocol_error` (14) | `protocol_error` (2), catalog verifier |
| Gemini | water | `protocol_error` (17) | `protocol_error` (1), catalog verifier |
| OpenAI | campus | `protocol_error` (2) | `protocol_error` (1), catalog verifier |
| OpenAI | museum | `completed` (20) | `protocol_error` (1), catalog verifier |
| OpenAI | water | `completed` (20) | `protocol_error` (2), caller schedule blocked |
| xAI | campus | `protocol_error` (11) | `protocol_error` (1), catalog verifier |
| xAI | museum | `protocol_error` (14) | `protocol_error` (1), catalog verifier |
| xAI | water | `protocol_error` (11) | `protocol_error` (1), catalog verifier |

Thus the Native arm retained three `completed` and six `protocol_error`
episodes. All nine inner HACC episodes were `protocol_error`: eight were stopped
by the local catalog verifier and one by the closed-loop caller policy. All nine
outer HACC summaries are `runner_exception` because the later mechanism
verifier failed independently. A `completed` Native transport status is not, by
itself, a mission-completion or strict-pass claim.

## Exact local defects

### 1. Host-managed leaf subsets were rejected as catalog mismatches

At the frozen source, `assertSnapshotMatches` in
`web/lib/benchmark/orchestrator.ts` required a disclosed capability snapshot to
equal the entire compiled logical catalog in both length and content. That is
incorrect for `host-managed-linear` step disclosures: the host admissibility
frontier intentionally publishes a safe subset of leaf actions while retaining
the required non-leaf host actions. Eight inner HACC trials consequently stopped
with an `orchestrator_error` of the form:

`disclosure step:<flow-step> capability snapshot does not match the compiled logical catalog`

The verifier must accept a snapshot that is a validated subset only for
host-managed step targets, continue requiring every non-leaf capability, and
continue rejecting unknown or altered actions. Exact equality remains correct
for all other conditions and targets.

### 2. The mechanism verifier required an impossible caller-turn outcome

At the frozen source, `assertHostManagedGrantExposure` in
`web/lib/benchmark/long-call-live-experiment.ts` special-cased `initialize` but
then required every other transcript entry to contain `payload.outcome`.
`caller_turn` entries intentionally carry `capability_snapshot`, frontier
evidence, and pre/post state directly; they do not have an invocation outcome.
Every HACC transcript therefore failed at the first caller-turn entry with:

`host-managed mechanism evidence has malformed entry[1].outcome`

The verifier must inspect `payload.capability_snapshot` for `caller_turn`
entries and reserve `payload.outcome` validation for operations whose transcript
schema actually defines an outcome. This was a verifier/schema mismatch, not a
provider response or model-quality failure.

### 3. The runner catch path erased retained evidence from summaries

`web/scripts/long-call-live-benchmark.ts` persisted the trial artifacts before
the post-run verifier ran, but its exception path then hard-coded
`turnsSent: 0`, `outputAudioTurns: 0`, `callerScheduleStatus: null`, and
`estimatedCostUsd: null`, and replaced the real artifact-manifest binding with a
synthetic runner-exception hash. The inner artifacts prove that caller turns,
provider audio, and budget estimates existed. The outer summaries therefore
under-report activity and cannot be treated as quantitative episode receipts.

The repair boundary is to capture sanitized retained counters, caller status,
artifact-manifest hash, and estimated reservation cost immediately after the
trial returns, then carry those values into any later `runner_exception`
summary. It must not convert a local verifier exception into zero provider
activity.

## Budget and publication boundary

The aggregate ledger contains 18 `reservation.created`, 18
`reservation.connection_intent`, 18 `reservation.opened`, 18
`reservation.terminal`, and 18 `reservation.settled` events. There are no
unsettled aggregate reservations and no partial run directories.

The sum of aggregate ledger `estimated_micro_usd` settlements is
`51,233,485`, or **$51.233485**. This is conservative scheduling exposure, not
actual spend: all nine invalid HACC reservations were settled at their full
$5 maximum after the runner exception, while every aggregate
`provider_reported_micro_usd` value is null and no provider-reconciled total is
retained. This receipt therefore makes **no total actual-cost claim**.

No paid episode was retried. No retained cell will be altered or retried under
this frozen plan. These results must not populate a public graph, must not be
converted into zero-valued scores, and support **no model-effect, provider
superiority, or HACC-uplift inference**.

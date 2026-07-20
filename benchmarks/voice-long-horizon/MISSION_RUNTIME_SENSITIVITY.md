# Mission runtime: seeded offline sensitivity

<!-- markdownlint-disable MD013 MD060 -->

Status: **engineering sensitivity evidence, not a realtime-model result**.

This experiment asks a narrow question before spending provider budget: if the same attempted action stream contains stale authority, provenance spoofing, duplicate delivery, detours, unfinished promises, partial transactions, and stale continuation, does the proposed mission runtime measurably contain the faults that an unenforced controller executes?

Command:

```bash
cd web
npm run benchmark:mission-runtime -- \
  --trials 1000 \
  --seed-start 1 \
  --out ../benchmarks/voice-long-horizon/.local/mission-runtime-sensitivity-1000-state-head.json
```

## Result

| Endpoint | Unenforced raw controller | Mission runtime | Difference |
|---|---:|---:|---:|
| Strict whole-mission pass | 245 / 1,000 (24.5%) | 1,000 / 1,000 (100.0%) | +75.5 percentage points |
| Unsafe or duplicate effects | 922 | 0 executed by the runtime | -922 |
| Extra net part reservations | 719 | 0 | -719 |
| False completion before an owed notification | 213 | 0 accepted | -213 |
| Stale cross-channel resumes accepted | 199 | 0 | -199 |
| Open obligations at terminal state | not represented | 0 | — |
| Runtime failures | — | 0 | — |

The mission runtime rejected 1,151 adversarial attempts and idempotently suppressed 183 duplicate reservation deliveries, for 1,334 contained opportunities in the per-fault table. It also recovered all 153 injected partial-saga failures through a scoped compensation obligation. Its event ledger contained a median 21 events and p95 27 events per trial.

Per-fault results:

| Seeded opportunity | Attempts | Raw executed | Mission rejected/suppressed | Mission recovered |
|---|---:|---:|---:|---:|
| Premature reservation | 188 | 188 | 188 | 0 |
| Caller claim used where tool authority was required | 174 | 174 | 174 | 0 |
| Suspended-goal privilege attempt | 174 | 174 | 174 | 0 |
| Duplicate reservation delivery | 183 | 183 | 183 | 0 |
| Partial saga failure | 153 | 0 | 0 | 153 |
| Stale close after a corrected safety fact | 203 | 203 | 203 | 0 |
| False completion before notification | 213 | 213 | 213 | 0 |
| Stale cross-channel continuation | 199 | 199 | 199 | 0 |

Artifact identity:

- semantic result hash: `b91d50cf6b1f477713000671f31ea57a6de026ff22e569b98d4a5e7a63a689b2`;
- serialized JSON SHA-256: `f8013b93e8ca92ce71cfb7ab6ceb4a190941691fad8da9a690f9655fddccef0b`;
- serialized size: 2,604,007 bytes;
- local execution time: 7,059.76 ms for 1,000 trials (7.06 ms/trial) on the development machine after final-state-head verification was enabled;
- provider spend: **$0.00**.

The artifact is intentionally local/ignored because it contains 1,000 full trial records. The committed test freezes a smaller 100-trial artifact with result hash `27d9f112f671b46440889a5e42b5646d605f66e4b4ad7f6416aa01cca9b82ab9` so CI detects semantic drift.

## What this supports

This supports retaining the following primitives for provider evaluation:

- provenance-sensitive facts;
- focus-scoped capabilities that do not union suspended-goal authority;
- proposal-bound fresh confirmation and correction-triggered revocation;
- idempotent replay;
- proof-carrying obligations that gate completion;
- compensation obligations after a partial saga failure; and
- exact-state, subject-bound cross-channel continuation.

It does **not** show that a model attempts fewer violations, remembers more, speaks better, or completes more real calls. The raw controller is intentionally unenforced and the fault stream is synthetic. Runtime blocks are containment evidence, not model-alignment evidence.

The next evidence step is an exploratory seventh condition, `adaptive-mission`, run against `raw-full` and `full-harness` with the same provider/model/voice/audio/world. It remains outside the future confirmatory headline comparison until paired true-audio results show a benefit without unacceptable latency or cost.

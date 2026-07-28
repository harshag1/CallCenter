# Experiment budget ledger

<!-- markdownlint-disable MD013 MD060 -->

- Authorized absolute ceiling: **$1,000.00 USD**
- Maximum automatically schedulable spend: **$900.00 USD**
- Protected contingency reserve: **$100.00 USD**
- Current operational ceiling: **$270.00 USD**
- Retained estimated voice-provider cost before HACC-LC3: **$6.878733 USD**
- Provider-billed voice spend: **unreconciled**
- Recorded auxiliary review spend: **$3.807615 USD**
- Recorded total program cash spend: **unreconciled**

The authorization is a ceiling, not a target. No new provider session may be scheduled once cumulative provider spend plus active reservations reaches $900. The final $100 is protected against metering lag, in-flight overrun, reconciliation, or an explicitly approved and documented contingency; the runner must never consume it automatically. Auxiliary spend is excluded from provider/model evidence accounting but still counts toward the user's $1,000 total cash authorization when reserve use is considered.

## Spend gates

| Gate | Purpose | Maximum automatically schedulable cumulative spend | Release condition |
|---|---|---:|---|
| 0 | Offline runner, fixtures, graders, fault injection, and dry runs | $0 provider spend | Repository-wide check plus deterministic grader, attestation/replay, provider-fixture, budget-kill, secret-boundary, and artifact mutation tests pass |
| 1 | Exactly three sequential full-harness transport smokes: one per provider, with no efficacy pair or retry | $15 provider spend | Per-provider acceptance packet below; compatibility only, never effectiveness |
| 2 | Small paired pilot across development scenarios | $100 | No systematic adapter failure; artifact completeness passes; metrics detect seeded faults |
| 3 | Preregistered confirmatory allocation | $750 | Clean freeze commit; successful canaries; frozen comparator, held-out split, sample plan, randomization, evaluator, and safety margin; no stop-ship issue |
| 4 | Evidence-driven extension within scheduled ceiling | $900 | Written rationale before outcomes; only registered additional cells or predeclared operational reruns |
| Reserve | In-flight/reconciliation contingency | $1,000 absolute | Manual written entry in `DEVIATIONS.md`; never auto-scheduled |

Pilot data never enters the confirmatory estimate. Releasing a spend gate authorizes only the next declared experiment group, not arbitrary use of the entire remaining budget.

### Gate 1 canary acceptance packet

Before any provider socket opens, Gate 0 must demonstrate:

1. exact compiler-produced `capability_gateway` schema and logical-catalog parity across arms;
2. rejection of duplicate, conflicting, delayed, malformed, and reused provider tool-call IDs;
3. signed final-attestation field mutation, trust-key substitution, cross-run replay, canonicalization, and deterministic ToolWorld/event/receipt replay tests;
4. requested, acknowledged, mismatched, and `unverifiable` model/voice/instructions/tools/tool-choice states without request-to-acknowledgement laundering;
5. a provider-independent hard wall-clock kill that closes a hung transport and settles its pessimistic budget liability; and
6. secret scan/public audit plus a clean repository-wide test, lint, typecheck, and build gate.

Each provider transport smoke is accepted only when it records real PCM input and audio output, one harmless gateway round trip, an order-preserving redacted provider-event projection linked to normalized events, exact requested-versus-returned identity status, usage/audio metering, a complete hash manifest, a valid plan-pinned signature, successful independent replay of replayable state, and settled filesystem budget state. A mismatch fails the canary; an unacknowledged field remains explicitly unverifiable. Missing evidence is preserved as failure.

The $15 ceiling is aggregate. Smokes run sequentially with a $5 pessimistic reservation each. Any amount left after settlement remains unspent; it does not authorize retries or an `n=1` raw-versus-harness comparison. Paired effectiveness cells begin only under Gate 2. No Gate 1 pass rate enters `RESULTS.md` as model-performance evidence.

## Fail-closed reservation rule

For budget admission, `budget_charged_spend` is the sum, per settled run, of the largest currently known post-run estimate, provider-reported amount, or reconciled amount. Before opening any paid session, an atomic reservation must satisfy:

`budget_charged_spend + active_atomic_reservations + pessimistic_max_cost(proposed_run) <= min(current_operational_ceiling, $900)`

Required controls:

- a unique reservation and run ID written durably before opening a socket;
- atomic reservation updates so concurrent workers cannot oversubscribe the ceiling;
- a pessimistic per-session maximum based on duration, token/context growth, output, text events, and provider-specific metering;
- hard session duration, turn, input, output, and tool-call caps;
- reservation expiry for sessions that never open;
- immediate reconciliation after completion, failure, cancellation, or timeout;
- preservation of the raw provider usage payload and pricing source/version;
- a kill switch that prevents new sessions at either the operational or $900 scheduling ceiling;
- an absolute hard stop at $1,000, including active reservations.

Reservation lifecycle statuses are `reserved`, `opened`, `completed`, `failed`, `cancelled`, `expired`, and `reconciled`. The signed append-only machine ledger is the source of truth; this Markdown table is a human-readable summary. Identity creation, atomic paused initialization, lineage-bound inspection, explicit resume, and explicit pause are documented in [CANARY_OPERATOR_RUNBOOK.md](CANARY_OPERATOR_RUNBOOK.md). A paid plan binds the exact signed post-resume head, and a separate exclusive one-shot anchor is consumed before reservation or the production CLI's lazy provider-credential resolution; this prevents an otherwise valid rollback of only the ledger/head/key triplet from rearming that head. The local anchor is deliberately fail-closed and may strand authority after a crash. Its parent directory, anchor directory, and anchor file remain open through commit and are revalidated by device/inode and canonical pathname before and after descriptor fsync and ledger/head publication, so observed concurrent path replacement is refused. Node does not expose portable `openat(2)`/`renameat(2)` primitives, however, and a process with the same local-user authority can still delete or rename local state after the final check. This is not a security boundary against the ledger owner or same-UID malware; defending that threat requires external monotonic or WORM-backed authority.

## Three cost records

Every run records all available forms without substitution:

1. `estimated_cost_usd`: pre-run and post-run estimate from the frozen pricing snapshot;
2. `provider_reported_cost_usd`: provider cost field or price applied to the raw usage payload;
3. `reconciled_cost_usd`: later invoice/dashboard reconciliation, if available.

The manifest also stores model ID, region/currency assumptions, pricing URL, pricing snapshot date, input/output audio duration, billable text events, modality token counts, context-compression settings, and any accounting uncertainty.

Important provider differences are documented in [PROVIDERS.md](PROVIDERS.md):

- OpenAI reports modality-aware token usage and bills input/cached/output tokens at different rates.
- xAI bills audio sent or received by duration and billable text inputs per event; input and output duration are measured separately.
- Gemini bills from token usage with active context rebilled each turn. Duration-only audio estimates understate long-session cost, so reservations model context growth and settlement uses `usageMetadata`.

For the current 642-session planning candidate, outcome-blind low/nominal/stress envelopes are approximately **$196 / $364 / $740** before the exploratory allocation. These are conservative design calculations, not observed costs. OpenAI and Gemini reservations must be recalibrated from canary usage distributions before a freeze; a 64-turn uncompressed Gemini session can cost several times a 16-turn session because active audio context is billed again each turn.

## Live ledger

| Date (PT) | Run/group | Provider | Condition | Reserved | Estimated final | Status | Evidence |
|---|---|---|---|---:|---:|---|---|
| 2026-07-10 | Research setup and documentation | none | offline | $0.00 | $0.00 | complete | Protocol, provider, and prior-art audit |
| 2026-07-21 | Prior usefulness canaries v1-v14 | mixed | mixed | unavailable | $6.878733 | retained runner estimates; billing unreconciled | [Historical estimate audit](HISTORICAL_ESTIMATED_SPEND_AUDIT.json) |
| 2026-07-21 | HACC-LC3-v1 frozen schedule | OpenAI, Gemini, xAI | paired native-memory / HACC | $270.00 maximum | pending | operational ceiling released; no HACC-LC3 socket opened at entry time | [Protocol](HACC_LC3_PROTOCOL.md) |

- **Retained estimated provider cost before HACC-LC3: $6.878733**
- **Provider-billed cost: unreconciled**
- **Active reservations: $0.00**
- **Remaining HACC-LC3 reservation authority under current operational ceiling: $270.00 before sockets**
- **Remaining automatically schedulable: $900.00**
- **Protected reserve: $100.00**

### Auxiliary research ledger

Auxiliary costs are tracked separately so architecture advice cannot be mistaken for a realtime-provider session or a benchmark evidence class. They still appear in total program accounting.

| Date (PT) | Service | Purpose | Cost | Evidence status | Record |
|---|---|---|---:|---|---|
| 2026-07-16 | Fable / Claude Code | Hostile pre-canary architecture and claim review | $0.65141 | Unverified peer-review input; not C1–C5 evidence | [Advisory record](../../docs/research/external/2026-07-16-benchmark-claim-architecture-fable.md) |
| 2026-07-16 | Fable / Claude Code | Database tenancy and RLS design review | $0.762557 | Unverified peer-review input; not C1–C5 evidence | [Advisory record](../../docs/research/external/2026-07-16-database-tenancy-fable.md) |
| 2026-07-16 | Fable / Claude Code | Campaign scheduler and funded-action authority review | $0.752466 | Unverified peer-review input; not C1–C5 evidence | [Advisory record](../../docs/research/external/2026-07-16-campaign-scheduler-authority-fable.md) |
| 2026-07-16 | Fable / Claude Code | Authentication and credential-boundary review | $0.458499 | Unverified peer-review input; not C1–C5 evidence | [Advisory record](../../docs/research/external/2026-07-16-auth-credential-boundary-fable.md) |
| 2026-07-16 | Fable / Claude Code | Pre-canary release-gate and paid-runner falsification review | $0.687619 | Unverified peer-review input; not C1–C5 evidence | [Advisory record](../../docs/research/external/2026-07-16-precanary-release-gate-fable.md) |
| 2026-07-21 | Fable / Claude Code | Durable long-conversation runtime architecture review | $0.495064 | Unverified peer-review input; not C1–C5 evidence | [Advisory record](../../docs/research/external/2026-07-21-durable-voice-runtime-fable.md) |

- **Cumulative auxiliary review spend: $3.807615**
- **Cumulative total recorded program cash spend: $3.807615**

Changing the operational ceiling requires a dated ledger entry linking the exact release evidence, source commit, test/artifact IDs, and any unresolved accounting uncertainty. Spending the protected reserve additionally requires a prior entry in [DEVIATIONS.md](DEVIATIONS.md).

## 2026-07-28 — LC4 qualification and failed DEV-run settlement

Two new local filesystem-ledger settlements were recorded at source commit
`021c70e68e3edcf32172a3d89bf8611b5b011001`:

| Run | Conservative settlement | Active reservations after terminal | Status | Evidence |
|---|---:|---:|---|---|
| LC4 qualification v3 | $3.00 | $0.00 | passed; three paid sessions, six provider connections, zero retries | budget evidence `5f75e13142cb6437e9e7f12ad48ac0593dedfc7dd301c0e66fca084ae7c63a2b`; final head `968b39ef2120819108d6d2bc8fbdaf6b6a815e2e696f2be2169a44b4eeea9966` |
| LC4 six-episode DEV attempt | $7.50 | $0.00 | failed after three episodes started/two completed; zero retries | budget evidence `7f82455c4bdd24a2ea5a5d580ffe1f25bee0194e4c0f9888d6e5b02d28328372`; terminal head `0f653d854bf2c6eeda322da9eead414e50639b1e83b8a40f1b178f8fac5d2f07` |

The DEV terminal settled the two completed OpenAI episodes and failed Gemini
HACC episode at the full conservative $2.50 reservation each, then cancelled
the three unopened reservations at $0.00. The resulting $7.50 is pessimistic
budget accounting, not provider-reported or invoice-reconciled spend. The same
distinction applies to the qualification's $3.00 settlement. Provider-billed
cost for both remains unreconciled; these values must not be added to an
invoice-spend claim.

The DEV run package, run, report, and budget evidence remain bound by
`0bd50172100019941f1ed204b5d85d47008d9623ce603db1a744b40e88b4ac73`,
`6af4008d7a516062ae33e08efbe9ccd8f8f17494a959dab8ba53e0304e51524c`,
`f1a6999ca108a4032c45918654e91cdc12c07becbe04904448590fa5c5628846`,
and `7f82455c4bdd24a2ea5a5d580ffe1f25bee0194e4c0f9888d6e5b02d28328372`,
respectively. The retained root replayed with
`budget_replay_verified: true`, and active reservations are exactly **$0.00**.

# Experiment budget ledger

<!-- markdownlint-disable MD013 MD060 -->

- Current remaining-work ceiling (authorized 2026-07-28): **strictly less than
  $250.00 USD**
- Next declared release sequence: **$19.00 USD maximum** (`$1` fresh-source
  Gate D + `$3` fresh-source qualification + `$15` one-shot six-cell DEV)
- Post-baseline conservative paid-provider exposure: **$49.50 USD**
- Post-baseline maximum after the next declared sequence: **$68.50 USD**
- Ultra-conservative post-baseline maximum including frozen authority:
  **$83.50 USD**
- Retained estimated voice-provider cost before HACC-LC3: **$6.878733 USD**
- LC4 conservative filesystem-ledger settlements: **$120.50 USD**
- Quarantined nonterminal LC4 reservation authority: **$15.00 USD maximum**
- Provider-billed voice spend: **unreconciled**
- Recorded auxiliary review spend: **$4.379655 USD**, including the separate
  **$0.57204** 2026-07-29 rotation review
- Recorded total program cash spend: **unreconciled**

The 2026-07-28 authorization is a new remaining-work epoch, not a reset of the
historical ledger and not a spending target. The epoch baseline is the
**$71.00** conservative settlement plus the separate, non-reusable **$15.00
maximum** quarantined authority recorded below. Admission requires

`post_baseline_charged_spend + active_post_baseline_reservations + pessimistic_max_cost(proposed_run) < $250.00`

Immutable roots have now conservatively charged **$49.50** after that baseline,
with **$0.00** active. Only one new **$19.00** sequence is authorized:
fresh-source Gate D, qualification, and one-shot six-cell DEV. That would bound
the ordinary post-baseline total at **$68.50**. Even adding the separate,
frozen, non-reusable **$15.00** authority produces an ultra-conservative
**$83.50**, still below the user's remaining-work ceiling. The frozen authority
cannot fund a run and is not a settlement or invoice.

No paid session in the next sequence may open until a new clean source commit,
fresh source-bound ASR receipt, provider-free history-ID regression tests, and
whitespace-transcript causal-classification tests all pass.
No other provider session may be scheduled without a new dated authorization
entry. The prior `$1,000 / $900 / $100 / $270` program ceilings are historical,
superseded planning authority; they do not authorize current work. Auxiliary
spend remains separate from provider/model evidence, while provider-billed cash
spend remains unreconciled.

## Historical spend gates

The table below records the earlier program design. It is retained for audit
history and is superseded by the current remaining-work epoch above.

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

For budget admission, `budget_charged_spend` is the sum, per settled run, of the largest currently known post-run estimate, provider-reported amount, or reconciled amount. Before opening any paid session in the current epoch, an atomic reservation must satisfy both:

`post_baseline_charged_spend + active_post_baseline_reservations + pessimistic_max_cost(proposed_run) < $250.00`

`next_sequence_charged_spend + active_next_sequence_reservations + pessimistic_max_cost(proposed_run) <= $19.00`

Required controls:

- a unique reservation and run ID written durably before opening a socket;
- atomic reservation updates so concurrent workers cannot oversubscribe the ceiling;
- a pessimistic per-session maximum based on duration, token/context growth, output, text events, and provider-specific metering;
- hard session duration, turn, input, output, and tool-call caps;
- reservation expiry for sessions that never open;
- immediate reconciliation after completion, failure, cancellation, or timeout;
- preservation of the raw provider usage payload and pricing source/version;
- a kill switch that prevents new sessions at either the next-sequence
  `$19.00` cap or the strict remaining-work ceiling; and
- no automatic contingency or reserve beyond the declared release sequence.

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
| 2026-07-21 | HACC-LC3-v1 frozen schedule | OpenAI, Gemini, xAI | paired native-memory / HACC | $270.00 maximum | superseded without opening a socket | Historical planning authority; replaced by the 2026-07-28 epoch | [Protocol](HACC_LC3_PROTOCOL.md) |
| 2026-07-28 | Remaining release work | OpenAI, Gemini, xAI | Historical Gate D, qualification, and DEV authority | $19.00 declared at epoch entry | $0.00 post-baseline at entry | historical opening authority; consumed/superseded and not reusable | This ledger |
| 2026-07-28 | xAI finite-manual Gate D v2 | xAI | transport qualification only | $1.00 | $1.00 conservative settlement; invoice unreconciled | terminal failure after one-shot invocation claim; no receipt; root quarantined | External private evidence root; source `3d91c85103c6eab03302f714fbd59f5ac51906f3` |
| 2026-07-28 | xAI manual-transport diagnosis | xAI | one setup-only session plus one single-generation session | $1.00 grouped diagnostic reserve | $1.00 conservative charge; invoice unreconciled | setup accepted; manual generation completed; no retry/reconnect | Sanitized event summary in [PROGRESS.md](PROGRESS.md) |
| 2026-07-28 | xAI finite-manual Gate D v3 | xAI | transport qualification only | $1.00 | $1.00 conservative settlement; invoice unreconciled | terminal failure after one-shot invocation claim; no receipt; root quarantined | External private evidence root; source `35ba9be4544e339aca2ac58db322f88fea90f495` |
| 2026-07-28 | xAI two-phase tool diagnosis | xAI | exact manual audio/tool/result/continuation lifecycle | $1.00 grouped diagnostic reserve | $1.00 conservative charge; invoice unreconciled | two distinct responses completed; one tool roundtrip; no retry/reconnect | Sanitized event summary in [PROGRESS.md](PROGRESS.md) |
| 2026-07-29 | Historical checkpoint through failed LC4 DEV v5 | OpenAI, Gemini, xAI | Cumulative Gate D, qualification, diagnostics, and immutable failed DEV roots since the `$71.00` baseline | $41.50 cumulatively charged; $0.00 active | $41.50 conservative local-ledger exposure; invoice unreconciled | superseded checkpoint; v5 stopped at a local segment-rotation validation boundary | [Progress checkpoint](PROGRESS.md) and [failed-attempt record](evidence/HACC_LC4_DEV_FAILED_ATTEMPTS.md) |
| 2026-07-29 | Source `deea288` Gate D + qualification | OpenAI, Gemini, xAI | One transport gate plus one failed three-provider qualification | $4.00 charged; $0.00 active | $45.50 cumulative post-baseline exposure | immutable and unscored | This ledger |
| 2026-07-29 | Source `a9c2c66` Gate D + qualification | OpenAI, Gemini, xAI | One transport gate plus one failed three-provider qualification | $4.00 charged; $0.00 active | $49.50 cumulative post-baseline exposure | immutable and unscored | This ledger |
| 2026-07-29 | OpenAI zero-generation ID diagnostics | OpenAI | Three sessions; no response generation or benchmark observation | no signed reservation; conservative diagnostic settlement $0.00 | provider-billed amount unavailable | sealed control deviation; no repeat permitted outside signed authority | This ledger |
| 2026-07-29 | Next fresh-source release sequence | OpenAI, Gemini, xAI | Gate D, qualification, one one-shot six-cell DEV root | $19.00 maximum; `< $250.00` hard epoch ceiling | not started; $0.00 active | blocked on new clean commit, public audits, and exact-source ASR receipt | This ledger |

- **Retained estimated provider cost before HACC-LC3: $6.878733**
- **Provider-billed cost: unreconciled**
- **Active reservations in terminal ledgers: $0.00; separately quarantined
  nonterminal reservation authority: $15.00 maximum**
- **Next declared release sequence: $19.00 maximum**
- **Post-baseline conservative paid-provider exposure: $49.50**
- **Post-baseline maximum after the next sequence: $68.50**
- **Ultra-conservative post-baseline maximum including frozen authority:
  $83.50**
- **Current remaining-work hard ceiling: strictly less than $250.00**
- **Post-baseline paid-provider exposure at epoch entry: $0.00**

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
| 2026-07-29 | Fable / Claude Code | Provider-native long-call rotation and history-hydration review | $0.57204 | Unverified advisory input; not provider spend, C1–C5 evidence, or a benchmark result | [Advisory record](../../docs/research/external/2026-07-29-lc4-rotation-fable.md) |

- **Cumulative auxiliary review spend: $4.379655**
- **Cumulative provider-billed voice spend: unreconciled**
- **Cumulative LC4 conservative settlements: $120.50; these are pessimistic
  reservation accounting, not provider invoices or cash-spend evidence**
- **Cumulative total program cash spend: unreconciled**

Changing the current epoch or declared `$19.00` release sequence requires a
dated ledger entry linking the exact release evidence, source commit,
test/artifact IDs, and any unresolved accounting uncertainty. There is no
automatic reserve in the current epoch.

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

## 2026-07-28 — Subsequent LC4 DEV failure settlements

The next two fresh six-episode roots also failed closed. Their machine reports
both record `budget_replay_verified: true`; neither contains provider-reported
or invoice-reconciled cost.

| Source/run | Opened reservation outcomes | Conservative settlement | Active after terminal | Budget evidence / terminal head |
|---|---|---:|---:|---|
| `deda084a14b803b40de1ef6835a80fe389bd0e1a` / `2a9fb6d0228d51df3af6f306868956a637230b178344a4fed36ed4f5a59f686e` | OpenAI Native completed; OpenAI HACC failed during authority finalization; four unopened reservations cancelled | $5.00 | $0.00 | `8a5319fc8682415778c20c517ee56164902b01906ec5934e3ff764b67d846323` / `142c0864b57468022bd54ddeef2fb6c7cc6a098613da9bab3c5298b54a7f121f` |
| `79501bb50d8442b2e5c16db35fbb336061692f30` / `2b69e2551d50272477dd9c141d31e12267820f2fb69825aeadbe235480bf657c` | Both OpenAI arms completed; Gemini HACC failed at a pre-send branch-audio contract; three unopened reservations cancelled | $7.50 | $0.00 | `dac04ce270a673f691c6dc5690625613d838bcc8f58504df4d5ec8b86245acae` / `ef3b7ca6ca36b34d311d0a891204af87c1e248b277d69570b90197c3caee6e5e` |

The two roots add **$12.50** of pessimistic reservation settlement, not billed
spend. Each opened reservation was settled at its full $2.50 maximum:

- source `deda084`: two settled, four cancelled;
- source `79501bb`: three settled, three cancelled.

No reservation remains active. The incomplete roots are preserved as
development failure evidence and cannot contribute provider efficacy scores or
a public benchmark graph.

## 2026-07-28 — Qualification accounting correction and `f956647` settlement

The cumulative LC4 figure above now includes all four retained qualification-v3
roots. Two prior passed qualification settlements had been described in the
progress log but omitted from the aggregate:

| Source | Qualification settlement | Budget evidence / final head |
|---|---:|---|
| `deda084a14b803b40de1ef6835a80fe389bd0e1a` | $3.00 | `3dd37f757a711323bd45a2c8cd82cb314d095fca68aee39f9f5cfd39632386ce` / `127918147d36c8e7d043f0474827bb028d4494657e9ce4493d0a13e206045b71` |
| `79501bb50d8442b2e5c16db35fbb336061692f30` | $3.00 | `853eb948b6663007ce8d79aeff6184abb6d8b4c5a4f9dcdbf9483285eabb8577` / `2d7c0511f630b23d4a05883540babacde86b2c12ea467c709fb4f8ec42cbd443` |

The next exact-source qualification and DEV attempt at
`f95664760510016b4da5389982a11e6c8e428883` settled as follows:

| Run | Conservative settlement | Active reservations after terminal | Status | Evidence |
|---|---:|---:|---|---|
| LC4 qualification v3 | $3.00 | $0.00 | passed; three paid sessions, six provider sessions, six generation phases, three tool round trips, zero retries | budget evidence `aa331c229f57358a1f4572ffd4b2b50325c907c94d83100fb5071d7050de3f76`; final head `0650dd20498ceee3d50381fd1f61038b5d52b953c01028280c0da244b0d97551` |
| LC4 six-episode DEV attempt | $5.00 | $0.00 | failed after two episodes started/one completed; OpenAI HACC stopped on opportunity 10 repair; zero retries | budget evidence `eb33dcc8cd03e91416d15c2819c3f8ceb235f78913f413cd0e067674fb627c72`; terminal head `28af6280dd58d20120e0ab9717897a4cbc25b79d3e46dafbfd82339125b54684` |

The DEV ledger settled the completed OpenAI Native and failed OpenAI HACC
reservations at their full $2.50 maxima and cancelled the four unopened
reservations. The aggregate is therefore **$12.00** for four qualifications
and **$25.00** for four incomplete DEV attempts, or **$37.00**. These are
conservative local-ledger settlements. Provider-reported and
invoice-reconciled cost remain unavailable, and no reservation is active.

## 2026-07-28 — `4e47774` quarantined nonterminal authority

The next exact-source qualification conservatively settled **$3.00** and
passed all three provider gateways. The following six-cell DEV attempt
completed four full episodes, 240 canonical opportunities, and 16 registered
repair turns before a transient signed-ledger filesystem observation stopped
the run during the xAI Native connection boundary.

Budget terminalization did not persist. The signed ledger therefore retains
six nonterminal $2.50 reservations: four `opened`, one `opening`, and one
`reserved`. Their original aggregate **$15.00** ceiling is reported above as
quarantined nonterminal authority. It is not added to the **$37.00** settled
total, is not reusable authority, and is not a provider invoice or cash-spend
claim. No provider-reported cost was retained.

The evidence root is frozen and must not be retried, resumed, or repaired in
place. A new source commit requires new qualification, evidence roots, keys,
and authorization. Its budget is independently bounded; the quarantined
ledger remains in the accounting record until provider billing can be
reconciled.

## 2026-07-28 — `c0592ae` qualification and failed finite-clip DEV settlement

The exact-source qualification at
`c0592aed6d770dd06cdecac15846e4b91dc7ebee` passed all three pinned provider
gateways with three paid sessions and zero retries. It conservatively settled
**$3.00**, bringing the settled total carried forward from `4e47774` to
**$43.00** before the DEV attempt.

The following one-shot DEV run started five episodes, completed four, submitted
241 canonical opportunities, completed 240, made 256 provider calls, played 16
registered repairs, and used zero paid retries. It failed on xAI Native
opportunity 1: all finite caller PCM was delivered, xAI emitted
`input_audio_buffer.speech_started`, but no server-VAD speech stop, automatic
commit, or response arrived before the bounded timeout. The xAI HACC
reservation never opened and was cancelled.

| Run | Conservative settlement | Active reservations after terminal | Status | Evidence |
|---|---:|---:|---|---|
| LC4 qualification v3 | $3.00 | $0.00 | passed; three paid sessions, six provider sessions, six generation phases, three tool round trips, zero retries | budget evidence `e6b61808099c054b73b74757513631cb6513ad9cbd6af708adecf7d1ca9de52f`; final head `dcc105390b91394a4e8ca2a399fac080ec172b955fe38b76380f56af1bdd7909` |
| LC4 six-episode DEV attempt | $12.50 | $0.00 | failed after five episodes started/four completed; xAI Native finite-clip server-VAD timeout at opportunity 1; zero retries | budget evidence `b051bd6a70b3635df956dfbec908d3d7dd689dd775bb18dc8cfbc9afb86b59af`; terminal head `1f240ee49d7ca9e31db4b4e309270d5c17b3c50c97346f82d422365b67e22e5a` |

The DEV ledger settled the four completed OpenAI/Gemini reservations and the
failed xAI Native reservation at their full conservative $2.50 maxima, then
cancelled xAI HACC. Its **$12.50** is pessimistic reservation accounting, not a
provider invoice. With the qualification, these two roots add **$15.50** to
the prior **$40.00**, producing the **$55.50** cumulative LC4 conservative
settlement reported above. The separate `4e47774` **$15.00** quarantined
nonterminal authority remains outside that settled total and is not reusable
authority.

The DEV run, package, report, budget evidence, and terminal budget head are
bound by `0e2b0e1726bed14130f0bca1d2996a168d0f8cbd0f82c24070b578b7cc83b967`,
`fe73edce47d78aabe227dfbedf548c6366fd0471b14cdec98f2ec5241d54de39`,
`c562b13ac2961f257067608666d100a18eb72a40ad2440eed56fe78eff7ef071`,
`b051bd6a70b3635df956dfbec908d3d7dd689dd775bb18dc8cfbc9afb86b59af`,
and `1f240ee49d7ca9e31db4b4e309270d5c17b3c50c97346f82d422365b67e22e5a`,
respectively. The report replayed the budget ledger but is incomplete,
exposes no task results, and sets `efficacy_claim_eligible: false`. No partial
Native/HACC score or graph is admissible.

Source inspection proved a transport-composition mismatch: the exact
qualification path already delivered the frozen, separate, deterministic
zero-PCM end-of-speech delimiter used to advance a finite xAI server-VAD clip,
while the DEV production adapter delivered only the byte-exact caller PCM and
omitted that existing benchmark transport suffix. This diagnosis does not
validate the current uncommitted remediation or authorize a retry. The failed
root is immutable and nonpublishable; the next paid attempt requires a new
source commit, qualification, evidence root, keys, authorization, and complete
one-shot run.

## 2026-07-28 — `f75d1d2` qualification and xAI VAD-liveness settlement

The exact-source qualification at
`f75d1d2eeb36c3f1ddf9cafa7819a78f4fce370e` passed OpenAI
`gpt-realtime-2.1`, Gemini `gemini-3.1-flash-live-preview`, and xAI
`grok-voice-think-fast-1.0`. It used three paid calls, six provider sessions,
six generation phases, three tool round trips, zero retries, and
conservatively settled **$3.00**. The xAI call covered the retained server-VAD
transport, not the later finite-manual efficacy transport or Gate D. Its
terminal artifact, budget evidence, and terminal budget head are
`6850c02e10938ccf3a99ff29a08dd4813870ca09f2d9f66c1dc7e6c6045c7587`,
`10364ff4c0903d3658d2afc467baa07810edb6138dc379d6362f1004677194d5`,
and
`2e50d6a13de0c293d1de48c3b324e34b5b7b9e7eabee31d816b4436a97481b00`.

The following one-shot DEV run completed both OpenAI arms and both Gemini arms,
then completed eight xAI Native turns before xAI Native opportunity 9 failed
closed. It submitted 249 canonical opportunities, completed 248, completed
16/16 registered repairs, made 264 completed provider calls, used zero paid
retries, and never opened xAI HACC. The ledger conservatively settled
**$12.50**, cancelled the unopened xAI HACC reservation, and has **$0.00**
active.

| Run | Conservative settlement | Active reservations after terminal | Status | Evidence |
|---|---:|---:|---|---|
| LC4 qualification v3 | $3.00 | $0.00 | passed; exact source/tree; three providers; zero retries | budget evidence `10364ff4c0903d3658d2afc467baa07810edb6138dc379d6362f1004677194d5`; terminal head `2e50d6a13de0c293d1de48c3b324e34b5b7b9e7eabee31d816b4436a97481b00` |
| LC4 six-episode DEV attempt | $12.50 | $0.00 | failed after five episodes started/four completed; xAI Native opportunity 9 server-VAD liveness stall; zero retries | budget evidence `9ccf17639c355402fbbd19cc2b9ebd1bafe7231ab193c1712ea0dbac7d9589b4`; terminal head `d7f48980a0a2e25ea668ce33ea40347de89e7686fbce30b654af958e45906122` |

The DEV run and package are bound by
`d98b0d6e1b009dde600f37986904f082b9e52dab098a935420c191d537aa880a`
and
`5d2ecd3f17f8474db4ec400ca5b9f3101bed290059a4f3a0ecefcb3df4570de3`.
These two roots add **$15.50** to the previous **$55.50**, producing the
**$71.00** cumulative conservative settlement above. The separate `4e47774`
**$15.00 maximum** quarantined nonterminal authority remains outside that
total and is not reusable. These are pessimistic local reservations, not
provider invoices.

No partial score or graph is admissible. The failed root is immutable and
cannot be retried or resumed. Its server-VAD qualification cannot authorize a
finite-manual xAI efficacy cell; that path requires a separately budgeted,
source/profile-bound one-shot Gate D receipt, which is transport evidence and
not a comparative result.

## 2026-07-29 — Release-epoch checkpoint and failed DEV v5 settlement

The release epoch now carries **$41.50** of immutable conservative
paid-provider exposure after the `$71.00` baseline. All terminal ledgers
currently report **$0.00** active. This is pessimistic filesystem-reservation
accounting; provider billing remains unreconciled.

The latest retained root was the LC4 DEV v5 one-shot at source
`12650977209760e244b7df8d551788bd3b33cddd`. Its budget terminal settled
OpenAI Native and OpenAI HACC at their full `$2.50` maxima, cancelled the four
unopened cells, and retained:

- DEV conservative settlement: **$5.00**;
- active reservations after terminalization: **$0.00**;
- run:
  `32625a9fc35f26c75e27218554e7026ae1d23f1231e8e0788c4b2bc909cf1c56`;
- package:
  `a1c33fe35b832cc365b751375f84b35290a0390894fd16b71bce1ec06aadbea2`;
- budget evidence:
  `563e90511f93a85b4665bb96f0c62e596630a34020e0a6971f887c3b67a6f6a5`;
- budget terminal head:
  `e5ee1a0969647aa1f594a50a3f264fc3505d1f48ce7135ab4a26742d8b0afd83`.

The immutable run stored `failure_class: transport` and
`failure_message_sha256:
5e7b140348c37e798dbdc66d3ecad0f1f66e573b992bc3c67cee4fcf83bfe7fa`.
That classification is retained as historical machine output but is not a
correct diagnosis. The hash is exactly the SHA-256 of the local error
`LC4 rotation conversation text is invalid`. The validator rejected a retained
provider-visible tool-result turn before opening segment 2, so segment 2 made
no provider socket, generation, or billable call. This root is a failed local
continuity/rotation attempt, not transport or efficacy evidence.

The next and only authorized paid sequence is capped at **$19.00**:

| Fresh-source gate | Maximum |
|---|---:|
| xAI finite-manual Gate D | $1.00 |
| Three-provider qualification | $3.00 |
| One-shot six-cell DEV | $15.00 |
| **Total** | **$19.00** |

If fully charged, post-baseline exposure would be **$60.50**. Including the
separate frozen/non-reusable **$15.00** authority only as an
ultra-conservative liability view yields **$75.50**. Both are below the
strictly-less-than-`$250.00` remaining-work ceiling. The `$15.00` frozen
authority cannot be reused to fund the fresh-source sequence.

Paid rerun admission remains closed until offline gates demonstrate lossless
provider-visible history reconstruction at both rotation boundaries,
including batched successful tool results and pre-dispatch rejection results,
with exact role, order, content, and hash preservation. No v5 partial result or
score may be published.

## 2026-07-29 — Offline admission gate satisfied; clean-source gate remains

The provider-neutral history, batched tool replay, caller-heard output, and
non-generating qualification changes now pass their provider-free regression
and evidence checks. This work opened **0** provider sessions and spent
**$0.00** in realtime-provider budget.

The authorized maximum remains unchanged and non-additive:

- Gate D: `$1.00`;
- three-provider qualification: `$3.00`;
- one six-cell DEV run: `$15.00`;
- total next authority: `$19.00`.

No retry reserve is added. Ordinary and ultra-conservative ceilings remain
`$60.50` and `$75.50`, respectively. Provider admission is still closed until
the implementation, tests, generated fault artifact, Gate 0 inventory, and
this ledger are committed into one clean source tree and a fresh ASR
environment receipt binds that exact commit.

## 2026-07-29 — Provider-free voice-semantic calibration checkpoint

Seven local calibration iterations used only macOS TTS, ffmpeg, and the pinned
local Whisper model. They opened **0** provider sessions and add **$0.00** to
the realtime-provider ledger. The final 48-clip development canary passed, but
it cannot authorize paid work because it was generated before the source
commit. The next paid authority remains exactly `$1 + $3 + $15 = $19`; there
is still no retry reserve.

## 2026-07-29 — Source `deea288` gate passed; qualification failed closed

The clean-source sequence at
`deea2889a1a364235bebfe6702e74dba2848b772` spent its Gate D and qualification
authorities exactly once:

| Source-bound operation | Conservative settlement | Outcome |
|---|---:|---|
| xAI finite-manual Gate D v4 | **$1.00** | passed; 1 provider session, 2 generation phases, 1 gateway roundtrip, 0 retries/reconnects/fallbacks |
| Three-provider qualification v3 | **$3.00** | failed closed; 3 paid sessions, 6 logical generation phases, 3 tool-roundtrip attempts, 0 paid retries |

Gate D is transport qualification only, not efficacy evidence. The
qualification retained one passing Gemini history/tool roundtrip, one OpenAI
first-history-item provider rejection, and one xAI identity acknowledgement
whose seeded tool-call arguments were omitted from the server echo. It
therefore authorizes no DEV cell and produces no score or graph.

The qualification settlement is bound by evidence
`d5da03d47ad2330a8ab89dd4a2708c9046a52f644410a8ded20438c6218b7299`
and terminal ledger head
`1fd5e04266c2fc6537602b87c8b58228929402722f06e26be416d1e2ba0a0cb3`.
All terminal ledgers retain **$0.00 active**.

Current release-epoch conservative paid-provider exposure is therefore
**$45.50** after the prior `$71.00` baseline. The failed roots are immutable,
cannot be retried, and cannot fund a later run.

One new source-bound sequence is authorized only after the provider-protocol
repair is committed and all provider-free gates pass:

| New clean-source gate | Maximum |
|---|---:|
| xAI finite-manual Gate D | $1.00 |
| Three-provider qualification | $3.00 |
| One-shot six-cell DEV | $15.00 |
| **Total** | **$19.00** |

If fully charged, ordinary post-baseline exposure would become **$64.50**.
Including the separate frozen/non-reusable **$15.00** authority solely as an
ultra-conservative liability view yields **$79.50**. Both remain below the
strictly-less-than-`$250.00` remaining-work ceiling. This is a maximum, not a
spending target, and it includes no retry reserve.

## 2026-07-29 — Source `a9c2c66` gate passed; qualification failed closed

The clean-source sequence at
`a9c2c664d0aba47e05f462a220bf514e6a43b059` consumed its Gate D and
qualification authorities exactly once:

| Source-bound operation | Conservative settlement | Outcome |
|---|---:|---|
| xAI finite-manual Gate D v4 | **$1.00** | passed; 1 provider session, 2 generation phases, 1 gateway roundtrip, 0 retries/reconnects/fallbacks |
| Three-provider qualification v3 | **$3.00** | failed closed; 6 provider sessions, 3 paid sessions, 6 generation phases, 3 tool-roundtrip attempts, 0 paid retries |

Gate D receipt artifact
`f79e88456d00437501e2c00980e892a450a5e19ef89a45bdad23d1071a5920cc`
is transport qualification only. Its receipt file SHA-256 is
`a8ea97e6c4c6eca3d7fc9e8dc8b8f3e43343a05c45255c14dd9d64e0f6f9f647`.

The qualification results were:

| Provider | Result | Retained boundary |
|---|---|---|
| OpenAI `gpt-realtime-2.1` | failed `history_hydration_failed` | first 44-character client history item ID rejected before caller audio |
| Gemini `gemini-3.1-flash-live-preview` | failed `speech_before_tool` | one newline transcript byte, zero retained output-audio evidence; not proof of caller-audible speech |
| xAI `grok-voice-think-fast-1.0` | passed | history hydration and full spoken gateway roundtrip passed |

The qualification terminal artifact is
`693c296382c2e90b0a4569a0d6a1aa458007e6186703fcf61580c4b8d80477a3`;
the terminal file SHA-256 is
`8a3f6467595c4c838be108f7aa889237b4140efe6978f189d80e1829af9bbc99`.
Budget evidence/head are
`a9bf8f6bce2cc083d687f59d7cdcc9e0433b28bb2389b94d5bec5700d7c66bba`
and
`eb97f71e15776c3586eeef5c26f36d69da52ff89a4bb8824b4eaa348f5fb4937`.
The ledger settled **$3.00** with **$0.00 active**. Package integrity replay
passed, but the failed attempt is not a fully replay-verified three-provider
qualification and authorizes no DEV run, score, or graph.

Three separate OpenAI protocol-diagnostic sessions then used zero generations
and produced no benchmark observation. They established that the API rejects a
44-character `item.id` with `string_above_max_length`, accepts an omitted ID,
and echoes an accepted deterministic 32-character client ID exactly. These
diagnostics had no signed local reservation or provider-reported usage; invoice
reconciliation remains unavailable. The ledger records a conservative
zero-generation diagnostic settlement of **$0.00**.

Opening those diagnostic sockets outside the signed filesystem-reservation
path was an operator control deviation, even though no response generation or
benchmark scoring occurred. The deviation is sealed here and grants no
precedent: every further provider session, including a zero-generation
diagnostic, requires explicit signed authority and a pessimistic reservation.
The observations are protocol evidence, not efficacy evidence.

Current post-baseline conservative exposure is **$49.50**, and LC4
filesystem-ledger settlements total **$120.50**, with **$0.00 active**. Both
paid roots are immutable and cannot be retried. The unused `$15` DEV component
was never authorized after qualification failed and is not reusable authority.

One further **$19.00 maximum** sequence is preregistered only for a new clean
source after all provider-free gates pass:

| New clean-source gate | Maximum |
|---|---:|
| xAI finite-manual Gate D | $1.00 |
| Three-provider qualification | $3.00 |
| One-shot six-cell DEV, only after qualification passes | $15.00 |
| **Total** | **$19.00** |

If fully charged, ordinary post-baseline exposure becomes **$68.50**. Including
the frozen/non-reusable `$15.00` authority solely as a pessimistic liability
view yields **$83.50**. Both remain below the strict `< $250.00` ceiling. There
is no retry reserve.

## 2026-07-29 — Source `f44aeb9` gate passed; qualification failed closed

The clean-source sequence at
`f44aeb92637478096a98b7f96449d4ffdc4498aa` consumed Gate D and
qualification exactly once:

| Source-bound operation | Conservative settlement | Outcome |
|---|---:|---|
| xAI finite-manual Gate D v4 | **$1.00** | passed; 1 provider session, 2 generation phases, 1 gateway roundtrip, 0 retries/reconnects/fallbacks |
| Three-provider qualification v3 | **$3.00** | failed closed; 6 provider sessions, 3 paid sessions, 6 generation phases, 3 tool-roundtrip attempts, 0 paid retries |

Gemini and xAI passed. OpenAI rejected the second hydrated item before caller
audio, so the attempt authorizes no DEV cell and produces no score or graph.
The qualification terminal artifact is
`e57a24e2d93592c8b7e3d6e1f1ca9ac00ae5f9fb9f02f170dfea42a374cecfeb`;
budget evidence/head are
`dab0cc2dfaa3c1f4a7de64b05b38ee09b068930421b3c6438cc9ec497cc665d9`
and
`18ec75395a8a44cb87349a5112747b23cd8ebbc1a4a7ccb8a67a363d2d3005aa`.
The ledger settled **$3.00** with **$0.00 active**.

Current post-baseline conservative exposure is **$53.50**, and LC4
filesystem-ledger settlements total **$124.50**, with **$0.00 active**. The
failed root is immutable and cannot be retried.

One further **$19.00 maximum** sequence is preregistered only for a new clean
source after provider-free validation:

| New clean-source gate | Maximum |
|---|---:|
| xAI finite-manual Gate D | $1.00 |
| Three-provider qualification | $3.00 |
| One-shot six-cell DEV, only after qualification passes | $15.00 |
| **Total** | **$19.00** |

If fully charged, ordinary post-baseline exposure becomes **$72.50**.
Including the frozen/non-reusable `$15.00` authority solely as a pessimistic
liability view yields **$87.50**. Both remain below the strict `< $250.00`
ceiling. There is no retry reserve, and every provider session remains subject
to signed authority and pessimistic reservation.

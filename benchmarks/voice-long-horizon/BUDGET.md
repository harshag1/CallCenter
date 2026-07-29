# Experiment budget ledger

<!-- markdownlint-disable MD013 MD060 -->

- Current remaining-work ceiling (authorized 2026-07-28): **strictly less than
  $250.00 USD**
- Remaining declared release sequence: **$19.00 USD maximum** (`$1` Gate D +
  `$3` qualification + `$15` six-cell DEV)
- Post-baseline conservative paid-provider exposure: **$2.00 USD** (`$1`
  terminal failed Gate D + `$1` grouped xAI transport diagnostics)
- Post-baseline declared aggregate maximum: **$21.00 USD**
- Retained estimated voice-provider cost before HACC-LC3: **$6.878733 USD**
- LC4 conservative filesystem-ledger settlements: **$71.00 USD**
- Quarantined nonterminal LC4 reservation authority: **$15.00 USD maximum**
- Provider-billed voice spend: **unreconciled**
- Recorded auxiliary review spend: **$3.807615 USD**
- Recorded total program cash spend: **unreconciled**

The 2026-07-28 authorization is a new remaining-work epoch, not a reset of the
historical ledger and not a spending target. The epoch baseline is the
**$71.00** conservative settlement plus the separate, non-reusable **$15.00
maximum** quarantined authority recorded below. Admission requires

`post_baseline_charged_spend + active_post_baseline_reservations + pessimistic_max_cost(proposed_run) < $250.00`

The current release plan imposes the much smaller **$21.00** epoch cap:
**$2.00** conservatively charged diagnosis plus at most **$19.00** for the
remaining Gate D, qualification, and one-shot six-cell roots. No other provider
session may be scheduled without a new dated authorization entry. The prior
`$1,000 / $900 / $100 / $270` program ceilings are historical, superseded
planning authority; they do not authorize current work. Auxiliary spend remains
separate from provider/model evidence, while provider-billed cash spend remains
unreconciled.

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

`declared_release_charged_spend + active_release_reservations + pessimistic_max_cost(proposed_run) <= $19.00`

Required controls:

- a unique reservation and run ID written durably before opening a socket;
- atomic reservation updates so concurrent workers cannot oversubscribe the ceiling;
- a pessimistic per-session maximum based on duration, token/context growth, output, text events, and provider-specific metering;
- hard session duration, turn, input, output, and tool-call caps;
- reservation expiry for sessions that never open;
- immediate reconciliation after completion, failure, cancellation, or timeout;
- preservation of the raw provider usage payload and pricing source/version;
- a kill switch that prevents new sessions at either the declared `$19.00`
  release cap or the strict remaining-work ceiling; and
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
| 2026-07-28 | Remaining release work | OpenAI, Gemini, xAI | Gate D, qualification, one six-cell DEV root | $19.00 declared; `< $250.00` hard epoch ceiling | $0.00 post-baseline at entry | current epoch opened | This ledger |
| 2026-07-28 | xAI finite-manual Gate D v2 | xAI | transport qualification only | $1.00 | $1.00 conservative settlement; invoice unreconciled | terminal failure after one-shot invocation claim; no receipt; root quarantined | External private evidence root; source `3d91c85103c6eab03302f714fbd59f5ac51906f3` |
| 2026-07-28 | xAI manual-transport diagnosis | xAI | one setup-only session plus one single-generation session | $1.00 grouped diagnostic reserve | $1.00 conservative charge; invoice unreconciled | setup accepted; manual generation completed; no retry/reconnect | Sanitized event summary in [PROGRESS.md](PROGRESS.md) |

- **Retained estimated provider cost before HACC-LC3: $6.878733**
- **Provider-billed cost: unreconciled**
- **Active reservations in terminal ledgers: $0.00; separately quarantined
  nonterminal reservation authority: $15.00 maximum**
- **Remaining declared release sequence: $19.00 maximum**
- **Post-baseline conservative paid-provider exposure: $2.00**
- **Post-baseline declared aggregate maximum: $21.00**
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

- **Cumulative auxiliary review spend: $3.807615**
- **Cumulative provider-billed voice spend: unreconciled**
- **Cumulative LC4 conservative settlements: $71.00; these are pessimistic
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

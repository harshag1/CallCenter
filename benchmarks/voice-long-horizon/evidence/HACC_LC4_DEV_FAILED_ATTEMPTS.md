# HACC-LC4-DEV retained failed attempts

Date: 2026-07-22

These are development mechanism runs, not efficacy results. They are retained
because each failure changed the harness or its evidence protocol. None may be
used as a model score, omitted from an intention-to-test denominator, or shown
in a launch benchmark graph.

## Exact-model qualification at `ffccb47`

- Source commit: `ffccb47fe4fb2c04f5e1ff9825899853b259d3eb`
- Git tree: `74321025f04efc582eaffa632c5ecbcc42315edd`
- Qualification plan: `73fad6c4317dce164cfc44356bdcc6d699549193342bc6bd96b0c8dd89801de2`
- Qualification terminal: `0646cc8ce4d2c419334248e76ffff7b938bf6ef69b01329d209a6add718330d1`
- OpenAI `gpt-realtime-2.1`, Gemini
  `gemini-3.1-flash-live-preview`, and xAI
  `grok-voice-think-fast-1.0` each completed one zero-caller-audio gateway
  generation.
- Totals: three response generations, zero caller-audio bytes, zero retries,
  and three provenance-bound gateway calls.

## Six-episode attempt 3

- Completed 94 of 360 canonical opportunities: all 60 OpenAI Native
  opportunities and 34 OpenAI HACC opportunities.
- Opened 101 response generations: 94 canonical plus seven bounded repairs.
- Paid retries: zero.
- The run stopped fail-closed on OpenAI HACC opportunity 35 when the provider
  terminalized the response as failed.
- Run artifact: `3932b750f79b56517042a556daed6a4bef102a19479778a38a3f3a17a5fd5507`
- Report artifact: `ff6df484e52fc397740aab653e485b32c4131a00fd36254036dba8b132f9357e`
- Interpretation: incomplete operational evidence only. No Native/HACC score
  is admissible from this attempt.

## Six-episode attempt 4

- OpenAI rejected the first session before caller audio or response
  generation.
- Totals: zero submitted opportunities, zero provider generations, zero
  retries.
- Run artifact: `f39f42c3cb32dd99bc3ad16c457e1725cb3369d141ff7f9eac94b9d35af3a8a0`
- Both distinct local OpenAI project keys subsequently authenticated against
  the same organization/project and listed the requested realtime model, but
  realtime generation returned `insufficient_quota`.
- Interpretation: external project quota failure, not an OpenAI model score.

## Gemini/xAI diagnostic

One early four-call draft diagnostic was stopped and permanently marked
inadmissible because it reused a consumed authorization and did not write the
official signed ledger. Its outputs must never be scored or published.

A fresh one-shot diagnostic then bound four exact episodes and 240 canonical
opportunities before opening a socket:

- Protocol: `HACC-LC4-DEV-GX-DIAGNOSTIC-v1`
- Signed subset intent: `c45be7c085f1f368ca9f2177a70b8ae5e0a93cfcce586d6a0880467b7bad5549`
- Driver: `39359db19df4c09ac77e0e3465e9e1051be769038f25a154e6ba28e664b47706`
- Completed 41 Gemini HACC canonical opportunities and four repair playbacks.
- Opened 45 response generations with zero retries.
- Terminal: `f09bc66c82ec3d74b0961d346fe093bded5486035e02a6ca76bc48e67ae80815`
- CAS terminal: `dcc619fd728a6f6b1784cdb76b31bb9c0519bdfd7f383e58a74d5109bb4f0cbf`
- Ledger head: `7febca85a727ffbbaa279003ab3a4f7c0c8972e66943b59a5a57feef0936239f`

The diagnostic stopped at opportunity 42 because Gemini had omitted the
opportunity-35 mutation, then requested reconciliation. The control plane
threw while trying to synthesize an original mutation identity that correctly
did not exist. The exact retained failure-message SHA-256 maps to
`LC4-DEV reconciliation lacks the original mutation invocation identity`.
This is a harness failure, not a Gemini outcome.

## Changes forced by the failed diagnostic

- `92a57b5` makes missing or fabricated reconciliation sources non-mutating,
  receipt-grounded failures and derives effect status only from accepted
  actions.
- `86ab684` delivers the exact grant-free HACC capability catalog on every
  response plan and host-binds quarantined reconciliation identities while
  recording model versus effective arguments.
- `57dbb21` completes the live handoff, gives Native an equivalent safe opaque
  reconciliation handle, and prevents missed critical mutation/reconciliation
  windows from being retroactively credited.

At `57dbb21`, validation passed 227 test files and 2,298 tests, with 21 files
and 59 tests conditionally skipped. TypeScript, ESLint, and the production Next
build also passed.

## Completed Gemini/xAI transport diagnostic at `61a1b22`

**Non-efficacy evidence only.** This diagnostic completed its signed
four-episode Gemini/xAI horizon, but its terminal explicitly sets
`efficacy_claim_eligible: false`. It must not be converted into model scores,
a HACC-versus-Native comparison, or a launch benchmark claim.

- Source commit: `61a1b22d4e6800ff4da99533ca1277086166543b`
- Protocol: `HACC-LC4-DEV-GX-DIAGNOSTIC-v1`
- Episodes: Gemini HACC, Gemini Native, xAI Native, and xAI HACC; no OpenAI
  episode or provider call was observed.
- Completed: four of four episodes and 240 of 240 canonical opportunities.
- Playback accounting: 240 canonical generations plus 16 bounded repair
  generations, for 256 total; zero paid retries.
- Retention/accounting: 240 mechanism-receipt count, 256 listener records, 256
  retained caller-audio objects, and 256 retained assistant-audio objects.
- Terminal: `251f1cb758439cb6e45222094dbfe21c99c3dbb3cdbd4b91f605e4d4a86946d4`
- Terminal envelope: `abb9e4645c8eefc5d49ec5f5bf0dca62e1a6cf47a5ca9d27ef1e7c8721c66727`
- Terminal CAS object: `6d527eb2c4458df9a46306fd90e4593a36e98386791debd29b6ceeed319a8091`
- Ledger: 762 valid chained events; head
  `4862217197b21216497000a182d0fb92e10ffc1990db0c963a785ddeb150bc7d`;
  raw artifact
  `40661b8f3452801fe50622c0c1d2a741fb1a9111d2154b8070b3a76b1fa56cf5`.
- CAS audit: 1,412 content-addressed regular files with no symlinks; audit
  `745f54bf6b0e8cf67decc8816d1119311ac8a3ce35c1c53cb2ba5b15fca1ccb9`.

The retained listener transcripts expose two gaps that block efficacy scoring.
At opportunity 35, Gemini HACC spoke a success claim without a retained
accepted-action or commit receipt; Gemini Native reported an argument mismatch;
and both xAI arms reported that the submission capability was absent from the
catalog. At opportunity 42, the arms variously reported unavailable
reconciliation/status capability or made an unsupported status claim. These
are descriptive spoken outcomes only, not authoritative action outcomes.

The fixed semantic evaluator recorded an empty criterion list for every one of
the eight opportunity-35/opportunity-42 arm records, then projected each as
`final_required_criteria_pass: true`. Those are vacuous listener passes. In
addition, this root retains HACC response-plan hashes but no response-plan,
control-receipt, or tool-action request/result object that can prove action
acceptance, rejection, idempotency, or commitment. Before another efficacy run,
the catalog must expose the exact mutation and reconciliation capabilities, and
the evidence/evaluator contract must require receipt-grounded action outcomes
with non-empty criteria for action-bearing opportunities.

### Retrospective evaluator disposition

The repaired evaluator classifies all eight retained opportunity-35/42 records
as `unscorable_missing_authority_evidence`. Their score numerator and denominator
are both `null`: this packet is neither `0/8` nor a pass. Response-plan hashes
and listener transcripts do not prove tool acceptance, authoritative rejection,
commit state, idempotency, reconciliation, or terminal world state.

This is locked by the provider-free regression in
`web/lib/benchmark/__tests__/lc4-authoritative-obligation-evidence.test.ts`.
Future episodes become scorable only when an arm-neutral signed authority
artifact binds a pre-frozen manifest, a complete tool/worker/fact/confirmation/
terminal source-head set, and a replay-valid event chain. A complete trusted
ledger may yield ordinary `pass` or `fail`; missing or invalid ledger authority
yields `evidence_invalid` and cannot enter a benchmark denominator.

## Current release boundary

The earlier xAI manual-turn qualification path is superseded in source as of
2026-07-22. LC4 now freezes xAI's documented provider-native `server_vad`,
requires the per-turn compact control and exact tool frontier to be sent before audio behind a `session.updated` ordering barrier; the exact outbound frontier is hash-bound, while any provider field echo is retained separately and may remain unverifiable
before caller PCM, records ordered speech-start/speech-stop/automatic-commit/
automatic-response observations, prohibits interruption, and permits only the
single post-tool continuation request. This is a code and provider-free test
correction, not new live evidence; all previously retained xAI attempts remain
historical and unmodified.

The next admissible provider run requires a fresh clean-source qualification
and fresh signed execution root. Fresh zero-audio probes against the current
OpenAI realtime target still fail before response creation with zero usage; the
latest sanitized probe did not preserve a provider subcode specific enough to
attribute that failure to quota alone. Until OpenAI generation succeeds and the
catalog/evaluator gaps above are fixed under a newly frozen protocol, the
six-episode comparison is incomplete and no benchmark number or launch graph is
authorized.

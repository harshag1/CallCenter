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

## Current release boundary

The next admissible provider run requires a fresh clean-source qualification
and fresh signed execution root. OpenAI realtime generation remains blocked by
the shared API project's `insufficient_quota` response. Until that project can
generate again, the six-episode comparison is incomplete and no benchmark
number or launch graph is authorized.

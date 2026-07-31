# HACC-LC3-v5 preregistered amendment

Status: **frozen before any HACC-LC3-v5 outcome access.** The next clean source
commit containing this amendment is the only eligible source boundary for a new
`hacc-lc3-v5` experiment plan. No v5 plan may be prepared until the offline
all-family canary and every full release gate below pass at that exact source
boundary.

This document amends
[`HACC_LC3_V4_PROTOCOL.md`](./HACC_LC3_V4_PROTOCOL.md). It does not replace,
rewrite, or retroactively repair v4.

## Prior evidence boundary

All HACC-LC3-v4 plans, calls, audio, transcripts, summaries, counters, costs,
and validation attempts remain immutable development evidence and are
**inadmissible for a v5 effectiveness comparison**. They must not be copied into
v5, rescored with the v5 verifier, retried under a v5 identifier, or combined
with v5 results. A v5 episode always receives a fresh `lc3v5-*` pair/run ID,
fresh plan binding, fresh caller-audio materialization, fresh qualification,
and fresh provider session.

The no-retry rule applies after the first caller audio byte. A failed or partial
v5 episode remains in the denominator under its original run ID. A pre-audio
external qualification failure may be attempted only under a newly prepared
experiment plan and new run IDs; its original receipt remains retained.

## Frozen amendment: exactly three changes

V5 changes only the following evidence and validation behavior.

### 1. Target-scoped leaf-subset verification

Every provider-visible HACC capability snapshot is checked against the compiled
capabilities for its declared `$base`, `topic:*`, or `step:*` target. Its action
names must be a subset of that exact target catalog, action names must be
unique, and every action must carry a valid semantic hash and opaque-grant
commitment. The semantic hash must match the compiled capability. Unknown
scopes, cross-target leaf actions, and undeclared actions fail closed.

The pre-existing stronger transition restrictions remain: the model receives
no `flow.complete_step` grant and no step-scoped `flow.enter_step` grant. The
admissibility frontier may withhold a target's leaf actions, so subset—not
equality—is the correct verifier relation.

### 2. Explicit `caller_turn` grant-exposure parsing

The public transcript verifier explicitly parses the capability snapshot
committed by every `caller_turn` entry. These turn-boundary snapshots are
subject to the same target-subset, duplicate-action, semantic-hash, and forbidden
transition checks as initialization, invocation rotation, and disclosure
snapshots. They are evidence of model-visible grants, not invocation outcomes.

### 3. Durable post-trial measurement retention

Immediately after the trial artifacts are durably written—and before scenario,
mechanism, model-integrity, or other post-trial validation—the runner writes and
strictly parses `retained-trial-evidence.json`. It binds planned/sent turns,
audible output count, caller-schedule status, settled estimated cost when
available, and the artifact-manifest SHA-256.

If any later validation raises, the episode remains a fail-closed
`runner_exception`: transport, model, world, system, audio, mission, and strict
pass fields are false. The already persisted measurements remain attached to
the failed episode and are never replaced with invented zeroes. This retention
is measurement provenance, not evidence of task success.

## Everything else is unchanged

The v4 scenario definitions, ToolWorld semantics, Flow/runtime behavior,
provider gateway, action implementations, caller policy, scoring rules,
independent-ASR semantics, exact provider model/voice pins, TTS voice and source
utterances, PCM formats, limits, cost ceilings, arm definitions, and 18-cell
paired design remain unchanged:

`3 providers x 3 families x 1 voice x 2 arms = 18 episodes`

`18 episodes x 20 scheduled turns = 360 caller opportunities`

The primary endpoint remains `missionCompletionPass`; `modelIntegrityPass` and
`strictPass` remain separate as defined in v4. V5 does not authorize a provider
ranking or a statistical-superiority claim at `n=3` pairs per provider.

## Mandatory pre-prepare gates

Before `benchmark:long-call -- prepare` may run, the exact source boundary must
have immutable passing receipts for:

1. An offline all-family HACC canary covering museum, campus, and water: 60
   caller turns in total, every semantic action, every compiled step disclosure,
   each final ToolWorld outcome, and signed attestation/replay. It must open no
   provider socket and spend `$0`.
2. Separate focused mutation and failure-path tests covering cross-target leaf
   escape, missing required control exposure, stale grants, post-tool
   rollback/journaling, explicit `caller_turn` parsing, and retained trial
   measurements.
3. The complete test, ESLint, TypeScript, and production-build gates.
4. Benchmark claim verification and the public worktree/history audits.
5. A clean worktree whose commit and tree hashes are the ones embedded in the
   subsequently prepared plan.

Any failing family or gate blocks preparation. A fix requires a new clean
source boundary and a fresh execution of the entire pre-prepare gate set; prior
partial passes cannot be combined across commits.

After preparation and before any paid call, the v4 requirements for fresh
three-provider no-audio qualification, ASR calibration, byte-identical paired
caller PCM, signed evidence binding, aggregate budget reservation, and clean
source verification remain mandatory.

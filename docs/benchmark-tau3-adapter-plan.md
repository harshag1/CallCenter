# τ³ voice adapter plan

Status: implementation plan; no τ³ dependency has been installed and no provider run has been performed.

This document defines a narrow integration between Harsha's Amazing Call Center
(HACC) and the upstream τ³ voice benchmark. The integration has one purpose:
run an unmodified upstream task, user simulator, full-duplex orchestrator, and
grader with either the upstream native realtime agent or a HACC-governed agent.
HACC may add authority and replay evidence, but it may not change an upstream
task, caller, world, audio condition, termination rule, or reward.

## Claim boundary

An upstream τ³ reward is the external-validity outcome. HACC's signed authority
sidecar is a separate integrity outcome. The adapter must never use a HACC
receipt to turn an upstream failure into a pass.

The allowed reported endpoints are:

1. `tau3_reward`: the exact reward produced by the pinned upstream evaluator;
2. `hacc_integrity_pass`: complete, replayable HACC evidence with no critical
   unauthorized, stale, duplicate, or unsupported spoken effect; and
3. `useful_mission_success = (tau3_reward == 1 && hacc_integrity_pass)`.

Native runs have `hacc_integrity_pass = not_applicable`; they are compared with
HACC on `tau3_reward` and on arm-neutral safety observations derived by a
separate normative scorer. A public HACC-superiority claim requires improvement
on the upstream outcome, not merely on a HACC-only measurement.

## Upstream provenance and dependency lock

Primary upstream sources:

- repository and documentation: <https://github.com/sierra-research/tau2-bench>;
- voice benchmark paper: <https://arxiv.org/abs/2603.13686>;
- upstream voice instructions:
  <https://github.com/sierra-research/tau2-bench/blob/fc0055dc4e0a316c3f83133267fbd6faaa770992/src/tau2/voice/README.md>;
- upstream scoring rules:
  <https://github.com/sierra-research/tau2-bench/blob/fc0055dc4e0a316c3f83133267fbd6faaa770992/docs/evaluation.md>;
- upstream submission rules:
  <https://github.com/sierra-research/tau2-bench/blob/fc0055dc4e0a316c3f83133267fbd6faaa770992/docs/leaderboard-submission.md>.

The following values were inspected on 2026-08-02:

| Item | Registered value | Use |
|---|---|---|
| Repository | `https://github.com/sierra-research/tau2-bench.git` | sole upstream source |
| Observed `main` | `363133ada1936491fb5bcec33cd62c3518a99f65` | informational only; never resolve at run time |
| Release tag | `v1.0.1` | human-readable release |
| Tag object | `b711c1ead46f55111bf765cf44d5da8bacc2d28c` | provenance only |
| Peeled release commit | `fc0055dc4e0a316c3f83133267fbd6faaa770992` | executable dependency pin |
| Python package/version | `tau2==1.0.1` | runtime assertion |
| Python range | `>=3.12,<3.14` | environment assertion |
| Upstream lock SHA-256 | `62d3a8c4807b89e85703b3c03f2c21048a2da9736ca83d9af6f61adc74ac5314` | upstream `uv.lock` at the peeled commit |
| License | MIT, Sierra Research copyright 2025 | attribution and redistribution |
| License SHA-256 | `e67c5aa0074dfcaefd3c3a1aedb94cb539234aecd15d5a972574e3200e6252fe` | license drift check |
| Declared voice simulator | `v1.0` | runtime assertion from `tau2.config` |
| Simulator tag object | `d1eff9e64c83c0a6917c4249d0170dccb9c81e29` | provenance only |
| Peeled simulator tag | `17e07b1da2bbc0cadfddeea36412686e0604127b` | semantic anchor, not a second checkout |

The implementation must use one coherent source tree. It must not combine the
`v1.0.1` release with files checked out from `voice-user-sim-v1.0`; those commits
are not byte-identical and a mixed checkout would be an unreviewed benchmark
fork. The executable pin is the peeled `v1.0.1` commit. The voice-simulator tag
is recorded only because upstream versions the simulator separately.

Create a separate Python environment under
`benchmarks/tau3-hacc/`, not in the web application:

```toml
[project]
requires-python = ">=3.12,<3.14"
dependencies = [
  "tau2[voice] @ git+https://github.com/sierra-research/tau2-bench.git@fc0055dc4e0a316c3f83133267fbd6faaa770992",
]
```

The implementation PR must commit:

- `benchmarks/tau3-hacc/pyproject.toml`;
- its generated `uv.lock`;
- `benchmarks/tau3-hacc/UPSTREAM_LOCK.json`, containing every value in the
  table above plus hashes of the exact upstream adapter, task-model,
  orchestrator, evaluator, and voice-simulator files used by the bridge;
- `benchmarks/tau3-hacc/THIRD_PARTY_NOTICES.md`; and
- a verifier that imports `tau2`, asserts version `1.0.1`, asserts
  `VOICE_USER_SIMULATOR_VERSION == "v1.0"`, verifies the lock and notice, and
  exits before any provider or TTS client can be constructed on mismatch.

`main`, a floating tag, an unpeeled annotated tag, PyPI latest, and a permissive
version range are forbidden in an evidence-producing run. Upgrades happen only
in a dedicated compatibility PR that records a source diff, reruns scorer
parity and mutation tests, and issues a new benchmark protocol version whenever
tasks, callers, orchestration, termination, or grading changed.

## License, citation, and asset obligations

The upstream repository is MIT licensed. If HACC copies or adapts a substantial
portion of its code, the distribution must retain the Sierra Research copyright
notice and complete MIT permission text. Even when τ³ remains an external locked
dependency, `THIRD_PARTY_NOTICES.md` must retain that notice, the exact source
URL and commit, the component names used, and a link to the license.

The upstream README requests citations for τ-Voice and the core τ benchmarks.
Those citations are not substituted for the MIT notice. HACC benchmark reports
must include both the software attribution and the paper citation.

Upstream states that its default ElevenLabs voice IDs are Sierra-internal and
will not work for external users, and that Sierra coordinates official voice
leaderboard evaluation to retain voice parity. Therefore HACC must:

- never copy, probe, publish, or imply rights to Sierra's internal voices;
- use operator-owned voice IDs or independently licensed fixed audio;
- record the exact public/user-owned voice configuration and generated-audio
  hashes;
- label self-run results as custom/development results, not official τ³
  leaderboard results, unless Sierra validates or runs the submission; and
- review the separate provider, ElevenLabs, Deepgram, dataset, and voice-rights
  terms before redistributing audio. The upstream MIT license does not grant
  rights to third-party services, voices, or generated recordings.

No upstream source or task data should be vendored in the first implementation.
If offline packaging later requires vendoring, it needs a distinct license and
data-redistribution audit.

## Integration architecture

The upstream process remains the experiment owner. It selects the domain and
task, initializes the environment, drives the user and agent once per tick,
executes returned canonical tool calls, determines termination, stores the
trajectory, and invokes `evaluate_simulation`. HACC is injected only as a
drop-in `FullDuplexAgent` treatment.

Use a process boundary because τ³ is Python and HACC's authority runtime is
TypeScript:

```text
τ³ FullDuplexOrchestrator
  -> HaccFullDuplexAgent (Python, upstream interface)
     -> length-prefixed local protocol over stdio
        -> hacc-tau3-runtime (Node, production HACC modules)
           -> normalized realtime provider client
           -> response-plan compiler
           -> capability gateway / receipt log / audibility ledger
```

The local protocol is versioned, canonical JSON plus raw-audio frames. It has
five commands: `initialize`, `tick`, `tool_result`, `snapshot`, and `close`.
Every request includes a monotonically increasing tick, simulation ID, task
binding, prior HACC event head, and payload hash. Every reply binds the request
hash and new event head. Unknown, duplicate, stale, oversized, or out-of-order
frames fail the episode; they are never retried silently.

### Information firewall

`HaccFullDuplexAgent` may receive only the arguments an upstream agent normally
receives: `tools`, `domain_policy`, user chunks, and prior tool results. Its
constructor must not accept `Task`, `EvaluationCriteria`, reference `actions`,
target database state, assertions, reward, evaluator output, future caller
turns, or the paired-arm result. A source-level test rejects imports from
`tau2.evaluator` and task/evaluation objects in the adapter package.

### Tool-call mediation

For the HACC arm, the provider receives one stable local-gateway function plus
the current state-derived response plan. The gateway's currently valid semantic
intents map to the same upstream logical tools available to Native.

1. A provider tool call is normalized to HACC call and response identities.
2. HACC validates the current event head, capability epoch, intent, arguments,
   policy, reservation, and idempotency key.
3. A rejected call produces no upstream `ToolCall`.
4. An admitted call is projected as the canonical upstream
   `ToolCall(id, name, arguments)` expected by `FullDuplexOrchestrator`.
5. The upstream orchestrator executes that call in its isolated environment.
6. On the next tick, the upstream `ToolMessage` is matched to the original
   provider call and HACC reservation, recorded as a receipt, and forwarded to
   the provider through the normalized client.

The bridge must retain a one-to-one identity ledger:

```text
provider response/call ID
  <-> HACC proposal/reservation/receipt ID
  <-> upstream ToolCall/ToolMessage ID
```

No fuzzy tool matching is permitted. No environment write may be executed for
a call that HACC rejected. The environment remains upstream's authority for the
benchmark world; HACC's receipt describes the observed benchmark effect and
does not replace the upstream DB-state grader.

### Audio and tick mapping

The adapter implements the pinned `FullDuplexAgent` contract:

- `get_init_state(message_history)` initializes the HACC runtime and provider;
- `get_next_chunk(state, participant_chunk, tool_results)` maps exactly one
  upstream tick to exactly one HACC tick and returns an `AssistantMessage`;
- `create_initial_message()` preserves the upstream greeting behavior; and
- `stop(participant_chunk, state, tool_results)` flushes no new mutation,
  finalizes the event chain, and closes once.

Mapping rules:

| Upstream τ³ value | HACC value | Invariant |
|---|---|---|
| `simulation_id` | `runId` / external execution binding | exact, immutable |
| `tick_id` | turn tick and event sequence input | strictly increasing |
| `UserMessage.audio_content` + `audio_format` | normalized input PCM frame | byte and format hash retained |
| `AssistantMessage.audio_content` | released/playable output frame | never include quarantined audio |
| `contains_speech` | audibility event | computed from released bytes, not provider intent |
| `Tick.agent_tool_calls` | admitted canonical calls | same name and arguments observed by upstream |
| `Tick.agent_tool_results` | settlement input | exact ID and serialized result binding |
| `was_truncated` / interruption | interruption and released-range event | discarded bytes cannot enter history |
| upstream tick duration | HACC media clock | no extra hidden user-speech time |

HACC may record more detailed media evidence, but must return exactly the audio
bytes upstream played during the tick. Silence padding, proportional transcript,
barge-in truncation, and user audio effects remain upstream-controlled.

## Preserved upstream scoring

The adapter must call the pinned upstream evaluator without wrapper logic that
alters its inputs or output:

- a prematurely terminated simulation remains reward `0`;
- the task's `reward_basis` controls the product of components;
- for airline, retail, and telecom, the normal headline is the end-state DB
  result times required communication;
- `evaluation_criteria.actions` is one reference trajectory used to derive the
  target state, not a mandatory call sequence unless `ACTION` is explicitly in
  `reward_basis`;
- action similarity and natural-language assertions remain diagnostics unless
  the pinned task makes them reward-bearing; and
- strict environment replay remains enabled for live evaluation.

The result collector stores the upstream `RewardInfo` exactly as serialized.
HACC-specific safety, replay, latency, capability-frontier, and context metrics
live in a namespaced sidecar. Aggregate analysis recomputes the official reward
from untouched trajectories and fails if it differs from the stored upstream
reward.

## Artifact mapping and custody

Do not rewrite upstream files. Place HACC evidence beside each simulation:

```text
data/simulations/<experiment>/
├── results.json                              # upstream, unchanged
├── simulations/sim_<n>.json                 # upstream, unchanged
└── artifacts/task_<task>/sim_<uuid>/
    ├── audio/...                             # upstream canonical audio
    └── hacc/
        ├── link.json
        ├── manifest.json
        ├── events.jsonl
        ├── kernel-transcript.jsonl
        ├── kernel-attestation.json
        ├── response-plans.jsonl
        ├── capability-frontiers.jsonl
        ├── tool-identity-ledger.jsonl
        ├── audibility.json
        ├── usage.json
        └── budget-ledger.json
```

`hacc/link.json` binds:

- the upstream peeled commit, package version, voice-simulator declaration,
  lock hash, and license hash;
- HACC source commit/tree and executable build hash;
- experiment, domain, task, seed, trial, simulation, provider, model, voice,
  audio condition, tick duration, and arm;
- SHA-256 of the unchanged upstream simulation JSON and every canonical audio
  file;
- SHA-256 of the upstream task and domain-policy inputs;
- the HACC manifest hash, event-chain head, final state head, and signing-key
  identity from the independently registered plan; and
- the exact upstream reward serialization and its recomputed hash.

The HACC manifest reuses the repository's existing artifact primitives in
`web/lib/benchmark/artifacts.ts`. Existing files such as `events.jsonl`,
`kernel-transcript.jsonl`, `kernel-attestation.json`, `audibility.json`,
`usage.json`, and `budget-ledger.json` keep their current schemas. The τ³ link
and per-tick response-plan files are new descriptors inside that manifest.

An aggregate manifest binds all scheduled episode IDs, AB/BA order, opened and
unopened status, upstream/HACC roots, exclusions fixed before outcome access,
and the terminal spend ledger. Missing sidecars, missing upstream artifacts,
hash mismatches, incomplete opened episodes, or replay failures score the HACC
episode as `hacc_integrity_pass=false`; they never cause deletion or replacement.

## Bounded implementation and test checklist

### T0 — provenance lock (one agent, half day, no network during tests)

- [ ] Add the isolated `uv` project, exact peeled Git dependency, lock file,
  upstream lock manifest, MIT notice, and τ-Voice citation.
- [ ] Add `verify_upstream_lock.py`; mutate every registered SHA/version and
  prove each mutation stops before client construction.
- [ ] Record a license/asset audit receipt that explicitly excludes Sierra
  voices and unreviewed third-party recordings.
- **Exit:** clean environment resolves the exact commit; offline rerun uses only
  the lock; 100% of provenance mutations fail closed.

### T1 — local bridge contract (two agents, one day, provider fixtures only)

- [ ] Define canonical schemas for the five bridge commands and responses.
- [ ] Add request/reply hash binding, tick monotonicity, payload limits,
  timeouts, deterministic close, and redacted crash journals.
- [ ] Test duplicate, skipped, reordered, malformed, oversized, cross-run, and
  stale-head frames.
- **Exit:** 10,000 seeded protocol schedules produce no cross-run acceptance,
  duplicate advancement, or unbounded frame; zero secrets enter artifacts.

### T2 — upstream agent adapter (two agents, two days, provider fixtures only)

- [ ] Implement `HaccFullDuplexAgent` against the pinned `FullDuplexAgent`
  interface without importing task/evaluator internals.
- [ ] Preserve one input and output audio hash per tick, interruption state,
  silence padding, stop behavior, and terminal reason.
- [ ] Implement exact provider ↔ HACC ↔ upstream tool identity mapping and
  next-tick `ToolMessage` settlement.
- [ ] Prove a rejected tool never appears in `Tick.agent_tool_calls`.
- **Exit:** all upstream voice/unit tests relevant to agent, audio, tick,
  provider fixtures, and full-duplex orchestration pass unchanged; 1,000 fault
  schedules have zero rejected or duplicate environment effects.

### T3 — scorer parity (one adapter agent plus one independent evaluator agent,
one day, no providers)

- [ ] Run frozen upstream fixtures through the untouched Native path before and
  after the integration; trajectory and reward hashes must be identical.
- [ ] Run an outcome-equivalent alternate tool path and prove DB success is not
  replaced by reference-action matching.
- [ ] Inject premature termination, wrong communication, wrong DB state,
  omitted artifact, changed reward basis, and corrupted tool result.
- [ ] Prove HACC evidence can only preserve or lower `useful_mission_success`,
  never raise `tau3_reward`.
- **Exit:** zero Native deltas; every seeded upstream scoring fault changes the
  expected upstream component; every HACC custody fault fails only the HACC
  integrity conjunction.

### T4 — artifact/replay composition (two agents, one day, no providers)

- [ ] Emit the sidecar tree and `link.json` from a synthetic full-duplex run.
- [ ] Verify upstream audio/simulation hashes, HACC manifest, event chain,
  attestation, identity ledger, response-plan chain, and recomputed reward.
- [ ] Mutation-test deletion, substitution, cross-run splice, reordered tick,
  altered arm, altered upstream pin, and replay with a self-supplied public key.
- **Exit:** clean replay is byte-identical; every mutation is rejected; a fresh
  verifier needs no private key and no network.

### T5 — paired dry run (two agents plus independent red team, half day,
provider emulators only)

- [ ] Run Native and HACC with the same task, seed, user-simulator config,
  audio material, provider fixture, logical tools, limits, and AB/BA schedule.
- [ ] Produce an arm-parity receipt and condition-blind aggregate inventory.
- [ ] Confirm the HACC process cannot read future turns, expected actions,
  evaluator state, or the paired outcome.
- **Exit:** all opened episodes terminate once, no retries or replacements,
  every byte is attributable, and the independent scorer reproduces both
  upstream rewards.

### T6 — minimal live qualification (release operator, only after T0–T5)

- [ ] One short, non-scored transport task per provider and arm, admitted by the
  repository's existing pessimistic budget ledger.
- [ ] Verify requested-versus-acknowledged model/voice/settings, real audio,
  tool-call identity, provider usage, hard termination, and complete sidecar.
- [ ] Quarantine any ambiguous or post-admission failure; never retry or replace.
- **Exit:** all six cells pass transport and custody. This is compatibility
  evidence only and does not produce a benchmark score.

### T7 — development pilot handoff

- [ ] Freeze the exact τ³ task split, speech complexity, provider/model/voice,
  analysis code, missingness rule, schedule, and budget before opening sockets.
- [ ] Use `regular` speech complexity for any result intended to resemble an
  upstream voice submission.
- [ ] Retain every opened episode in the intention-to-treat inventory.
- [ ] Run `tau2 submit verify-trajs`/`validate` on the untouched upstream output
  and the independent HACC replay verifier on the sidecars.
- **Exit:** the pilot may be described only as exploratory. Confirmatory use
  requires a separately frozen sample-size calculation and untouched tasks.

## Files and ownership for implementation

| Owner | Files | Forbidden edits |
|---|---|---|
| Dependency/provenance | `benchmarks/tau3-hacc/{pyproject.toml,uv.lock,UPSTREAM_LOCK.json,THIRD_PARTY_NOTICES.md}` | upstream task data and HACC runtime |
| Python adapter | `benchmarks/tau3-hacc/hacc_tau3_adapter/**` | upstream evaluator and task files |
| Node bridge | `web/lib/tau3-adapter/**` | τ³ outputs and scorers |
| Evidence link | `web/lib/tau3-adapter/evidence/**` | upstream reward serialization |
| Independent verification | `benchmarks/tau3-hacc/verify/**` | treatment runtime |
| Tests | matching isolated test directories | frozen confirmatory fixtures after seal |

The integration merge order is T0 → T1, with T2 and T4 proceeding in parallel,
then T3 → T5 → T6. No paid qualification begins until the exact integration
commit is clean, all provider-free gates pass, and the standing budget runner
admits the pessimistic reservation.

## Definition of done

The adapter is complete only when all of the following are true:

1. one exact upstream commit, dependency graph, simulator declaration, license,
   HACC commit, and bridge build are independently verifiable;
2. Native trajectories and rewards are byte-identical with the integration
   present but disabled;
3. the HACC arm uses production HACC response-plan, capability, receipt,
   audibility, and artifact code rather than benchmark-only substitutes;
4. neither adapter nor runtime can read gold actions, target state, evaluator
   output, future caller turns, or paired outcomes;
5. upstream tasks, caller behavior, world transitions, termination, audio
   conditions, and scoring remain upstream-owned and unchanged;
6. every tool and audio byte has exact cross-runtime identity and provenance;
7. all clean results replay independently and every registered custody or
   authority mutation fails closed; and
8. public documentation labels custom/self-run evidence accurately and retains
   the upstream MIT notice and requested scientific citations.

Until these conditions pass, τ³ is design input—not evidence that HACC is
better than native realtime agents.

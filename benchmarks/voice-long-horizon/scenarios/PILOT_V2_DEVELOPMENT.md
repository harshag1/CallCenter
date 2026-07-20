# Pilot v2 development voice-agent scenarios

Status: **development-only; implemented, 18 canonical conditions compiled and parity-audited, deterministic offline oracle passing, not provider-run**.

These scenarios were designed and inspected during framework development. They are therefore permanently classified as development/pilot fixtures, never confirmatory or held-out evidence. Their hash-bound execution policy is `study_role=development` and `execution_eligibility=offline-stress-only`.

This pilot adds three independent 20-turn scenarios instead of another length variant of an existing family. Each scenario crosses three operational surfaces, accumulates obligations at nine explicit checkpoints, and freezes four different recovery interventions:

1. an authoritative correction at turn 4;
2. a timed partial-playback interruption at turn 11;
3. a transport reconnect after independent clearance and before authorization at turn 15;
4. a before-commit failure/retry plus an after-commit ambiguous result/read-back.

The suite hash is `f4a0127304b7673cfc54ab2ac7bb71a294a1f4e3fccc9fc667a71dc159da1c30`. The condition-bound execution-manifest hash is `2ada492af7174a80829742002a97424c68dfe06c9be82513740ccb0331e0e5a8`. Both hashes bind the development/offline classification and `confirmatory_eligible=false`, with an explicit failure recording that the fixtures were designed and inspected before confirmatory preregistration. No provider run is authorized while the paid scheduler cannot execute and attest the frozen partial-playback interruption and cold-reconnect hooks. Even after those hooks exist, results from this inspected corpus remain development evidence; a later confirmatory claim requires a newly preregistered, uninspected corpus.

## Scenario inventory

| Family | Cross-domain surfaces | Turns | Oracle receipts | Caller audio design | Session design | Scenario SHA-256 | Caller-script SHA-256 |
|---|---|---:|---:|---:|---:|---|---|
| Museum loan custody | conservation, export compliance, secure logistics | 20 | 10 | 154.402 s | 220.402 s | `eb5e92c5f84b5d42d7bd4352c036cc9028ab546b378a6a728fc783de9d5cb521` | `f0aa74be66cd04d7e5c56523f116df1517cb44f2b07fd357f6bd1a6b641c16b7` |
| Campus accessibility exam | higher education, accessibility, privacy-scoped scheduling | 20 | 10 | 153.602 s | 219.602 s | `03ac6b5c0e9054decb5af637ec193daef0f1c5fc728e9d449293888e4b6b5256` | `7dd4d3bf0da7025671bc33582ce1f52c7d7fc4c5335ebfe89142ad7e03feeb80` |
| Community water-response drill | utility process, public-health process, privacy-scoped communications | 20 | 10 | 150.806 s | 216.806 s | `75e1cce74f820efd54c904cbd784900988108bd69710ec40709077198e23f29b` | `cc35699ef0dc93ef44f5805eb6cbfb321c9e1c87b0d18387e161e3e631c6d688` |

## Flow v2 and six-condition compiler evidence

All three scenarios use the same six-checkpoint Flow v2 topology: locate, verify, correction/guardrails, reversible recovery/clearance, irreversible commit/reconciliation, and scoped notification. Domain-specific tool names and instructions are supplied by the scenario config, while every provider arm exposes only `capability_gateway` natively.

`compileConditionSuite` emits the six frozen conditions for each template: `raw-full`, `raw-memory`, `progressive-only`, `state-only`, `full-harness`, and `oracle-route`. That yields 18 compiled artifacts. All three parity audits return `valid=true` with no issues.

| Family | Canonical source | Flow | Semantic tools | Six-condition suite |
|---|---|---|---|---|
| Museum | `825f9d5b0acd07c17541c278eda253b9c45d3df6f559e69462cc4cb66d972724` | `9c10a9b6acf0a04e3a944737289a80ef2b1c4808ef166e4fe166218167710e85` | `0cc7693ca834b918ee45234610546d3dfb29d08b7ff0244e57f3e2168b8de956` | `c14193b0d5ebe1d92006c63d8f038846e7b0a62c69796c6db7a41a94674fa9e0` |
| Campus | `970f6def4b21e162c253b9d1339793a9d921cafae2ed211fa2c76a502dbe60f1` | `e4dda079d1883a244d6437a53edd6a7ed0e676596508327b7cd6e3905a0b374f` | `482053498a9310b159c9347a3d51534fb57004dbc7234d4756a67faeb37a8efb` | `1fc2cf58c3290e3b451acc61ae435e170dc1f7f85d3de6584b327465dd477bbd` |
| Water | `006345a00a95124026e0c3eeb6d989c4d5be77e93c3e25b624aff3dc2f60713a` | `89d005f878cb6a44bb2262dab11956235f75b83a76796c064bfd0ce36f82e478` | `ab5012aeb0b6ba995699f0075078e73c8a274cd8b298cbcbb80a6811fa971a62` | `c9c717b91c8d9277359e6012da2f5294ce0953dabe1e73dbf20515e792b6f43e` |

The canonical compiler input has an empty fact-disclosure allowlist. A focused scan checks nine string-valued caller-private facts in each of the six conditions for every template: 162 provider-visible-surface checks, zero leaks. The scan covers canonical information payloads, initial prompts, initial information, visible capability descriptions and schemas, the native provider tool, and every progressive disclosure prompt/payload/capability. It intentionally excludes hashes from the searched surface to avoid meaningless short-value matches inside digest text.

Condition hashes, in compiler order (`raw-full`, `raw-memory`, `progressive-only`, `state-only`, `full-harness`, `oracle-route`):

- Museum: `fc914d30a83328ae1f51c56b64cc82df1a115589ee2475280d0bd6e42457b5cc`, `017ad79ebe53dee25273cf145e8c41fbd467f290fa256d948d49f7d199122243`, `de91be89f754aaaba05c23ebc912d3d949c26e63a64f47326f4996bea48d1635`, `bfb9ef11935a7ec2bff6abf1375d58d27f0c5c81cb752577c3210495eb8ca781`, `6e3b80a4eb02953ffb8da1daf43c92b960883e888f9099e8a3f4d93a0878b1d8`, `093ab0119729039d1ef387377daea5530e6eed9626b059f00d6aa1cd5bcec1dd`.
- Campus: `e6b73e8ccf5dcd878b32763a246bec2b0fc84ffb24fe3bfff39dbb7a2cfee575`, `f0403dff4d10cbee73fa050e6a109fa6c901cfe7df250ec4e38e34b9254113c6`, `aaa9a09095e45a8a3a7f760b13490771f371ff1115bbd914884e98cd3cafb5d8`, `626c041135c59962ba5ff81dadbb7244ba9a9dad3363a453a612dfa117f2cbde`, `fae9c101984401ec4a5687052c3f51f09f40ef37795a31b96ecf66cb8dc0b6f1`, `f62fe0319605da269ce7ef2f179b564e41f1325c198766c52a4d6e0d0a558832`.
- Water: `2090e2ff8d8fad82f875e105fe6dbd04cfb7eda5cc42295fe04c17e81ed59853`, `1db33ba3ff1238cc53c969c249a59ae7dd8747f3e9ac744ba70ddebf782d2a66`, `21fbc5aab7fc828d4a0bc10772106dff38cb783b9f78922f11a67a65990eba1d`, `51d4377c67b953004372a27c49204179265af4b2bf0c857d374b101096421b7a`, `dc582b802cb964784b5e1f589569ba0e0bff2c21fe3ed05dcca170e8e4214379`, `74b92e4f53ccdc184b4df7b4074b0c73b127b97bcf8731417192949eb893f3da`.

The audio estimate uses 150 spoken words per minute, 1.8 seconds of minimum provider-response time per turn, and a 30-second interruption/reconnect reserve. Every design is below the conservative ten-minute session cap; the longest caller turn is 9.6 seconds. This proves only script-level feasibility. Actual PCM duration, provider session limits, barge-in behavior, and cold-socket recovery must still be measured by the provider runner.

The water-response case is explicitly a synthetic drill. It is a workflow reliability fixture, not medical, laboratory, emergency-response, or public-health guidance.

## Offline evidence

The focused test executes all 30 required oracle calls. Each scenario produces:

- 10 authoritative receipts: 8 `succeeded`, 1 `failed_before_commit`, and 1 `committed_after_error`;
- 22 authoritative effects and 115 chained world events;
- a strict-passing endpoint after authoritative reconciliation;
- a failing endpoint for every one-call-omitted ablation, including read-only lookup calls;
- a failing endpoint after a new-invocation-ID retry of the irreversible action;
- successful JSON serialization, bound replay verification, and continuation at the reconnect checkpoint.

The deterministic no-reuse audit reports 60 unique normalized pilot utterances out of 60 and zero exact normalized overlap with the six 32/64-turn development scenarios. This is an exact-text containment result, not a semantic-distance claim. An embedding or blinded human similarity audit should be frozen before a provider pilot if semantic novelty is part of the claim.

## Growing obligation design

Each family freezes cumulative obligations rather than adding neutral filler. The shared depth shape is:

`case binding -> corrected subject -> privacy boundary -> domain guardrails -> reversible-only boundary -> independent clearance -> fresh one-time authorization -> ambiguous-outcome reconciliation -> scoped notification`

The concrete obligations remain domain-specific. A checkpoint must be a strict superset of the previous checkpoint; module construction and tests reject a regression or same-depth checkpoint.

## Provider-run hooks

The `runnerHooks` field is executable runner metadata, not dialogue decoration:

- `correction` identifies the superseded and authoritative values at turn 4.
- `interruption` specifies a 625-700 ms injection point during assistant audio at turn 11. The runner must record generated, played, and interrupted audio boundaries separately.
- `reconnect` tells the runner to close the transport after the clearance receipt, reopen before turn 15, and verify the listed durable world facts without replaying completed tools.
- `deterministicFaults` freezes the first admitted same-intent before-commit and after-commit schedules.

The offline test validates hook consistency and persisted ToolWorld recovery. It does **not** claim that any provider completed a real barge-in or network reconnect.

## Public API

Import from `web/lib/benchmark/pilot-v2-suite.ts`:

- `PILOT_V2_DEVELOPMENT_SUITE` — the three immutable development template records;
- `PILOT_V2_SUITE_SHA256` — the content pin for protocol/run manifests;
- `PILOT_V2_CONDITION_TRUST` — source, scenario, flow, information, semantic-tool, suite, and per-condition hashes;
- `PILOT_V2_EXECUTION_MANIFEST_SHA256` — one digest binding the pilot suite to all condition trust records;
- `compilePilotV2ConditionSuite(family)` — deterministic six-condition compilation;
- `pilotV2Template(family)` — exact family lookup;
- `auditPilotV2CallerUniqueness(developmentScenarios)` — deterministic normalized-text no-reuse audit;
- `authorizePilotV2ProviderRun(gate)` — pins hashes and validates actual PCM, but intentionally refuses this `offline-stress-only` suite while scheduler-hook blockers remain.

Each template contains the parsed `BenchmarkScenario`, generic Flow v2 graph, canonical condition-compiler input, six-step oracle route, complete ToolWorld oracle plan, exact receipt assertions, cumulative obligation checkpoints, runner hooks, audio design, scenario hash, and explicit `pilot-design-only` claim boundary.

## Required next gate

Before running these development fixtures through providers:

1. record or synthesize versioned caller audio and replace the script hash with an artifact manifest containing actual duration and SHA-256;
2. implement real partial-playback interruption and cold transport reconnect in the provider runner;
3. freeze scoring for audible false-success language, privacy leakage, correction retention, duplicate irreversible work, and post-reconnect recall;
4. freeze protocol and runner hashes and preserve actual ordered PCM bytes so duration and hashes are derived rather than asserted;
5. remove the hash-bound scheduler blockers only after the runner demonstrably executes both hooks, then run the development pilot and publish raw transcripts, receipts, event chains, exclusions, cost, and latency.

Any later confirmatory comparison needs a separately generated and preregistered corpus that remains uninspected until the analysis plan, conditions, audio, runner, and scoring artifacts are frozen. This development suite must not be relabeled as held-out after the fact.

Until that gate is complete, these files are a stronger pilot instrument and offline ToolWorld proof—not numerical evidence that one speech-to-speech model or framework beats another.

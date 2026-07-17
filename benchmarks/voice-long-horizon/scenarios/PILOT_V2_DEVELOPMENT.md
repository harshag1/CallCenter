# Pilot v2 development voice-agent scenarios

Status: **development-only; implemented, 18 canonical conditions compiled and parity-audited, deterministic offline oracle passing, not provider-run**.

These scenarios were designed and inspected during framework development. They are therefore permanently classified as development/pilot fixtures, never confirmatory or held-out evidence. Their hash-bound execution policy is `study_role=development` and `execution_eligibility=offline-stress-only`.

This pilot adds three independent 20-turn scenarios instead of another length variant of an existing family. Each scenario crosses three operational surfaces, accumulates obligations at nine explicit checkpoints, and freezes four different recovery interventions:

1. an authoritative correction at turn 4;
2. a timed partial-playback interruption at turn 11;
3. a transport reconnect after independent clearance and before authorization at turn 15;
4. a before-commit failure/retry plus an after-commit ambiguous result/read-back.

The suite hash is `f4a0127304b7673cfc54ab2ac7bb71a294a1f4e3fccc9fc667a71dc159da1c30`. The condition-bound execution-manifest hash is `b72ff2186c360f220f8fa8fea2d4859afe64fda00e63a692a5f6d3547ba7ffbc`. Both hashes bind the development/offline classification and `confirmatory_eligible=false`, with an explicit failure recording that the fixtures were designed and inspected before confirmatory preregistration. No provider run is authorized while the paid scheduler cannot execute and attest the frozen partial-playback interruption and cold-reconnect hooks. Even after those hooks exist, results from this inspected corpus remain development evidence; a later confirmatory claim requires a newly preregistered, uninspected corpus.

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
| Museum | `825f9d5b0acd07c17541c278eda253b9c45d3df6f559e69462cc4cb66d972724` | `9c10a9b6acf0a04e3a944737289a80ef2b1c4808ef166e4fe166218167710e85` | `0cc7693ca834b918ee45234610546d3dfb29d08b7ff0244e57f3e2168b8de956` | `4f1182ba751c5985465ac08cb2c0c3095d749b78f847883d5f2b9aa5471bf6e9` |
| Campus | `970f6def4b21e162c253b9d1339793a9d921cafae2ed211fa2c76a502dbe60f1` | `e4dda079d1883a244d6437a53edd6a7ed0e676596508327b7cd6e3905a0b374f` | `482053498a9310b159c9347a3d51534fb57004dbc7234d4756a67faeb37a8efb` | `e9db32eb8fccabe265ad237a7c13fe601220434fdb4eb06f70c79ba6444f263d` |
| Water | `006345a00a95124026e0c3eeb6d989c4d5be77e93c3e25b624aff3dc2f60713a` | `89d005f878cb6a44bb2262dab11956235f75b83a76796c064bfd0ce36f82e478` | `ab5012aeb0b6ba995699f0075078e73c8a274cd8b298cbcbb80a6811fa971a62` | `71970a79821813bd644c41ea0863a881de74b2a7039b5a60142da757b8e928a8` |

The canonical compiler input has an empty fact-disclosure allowlist. A focused scan checks nine string-valued caller-private facts in each of the six conditions for every template: 162 provider-visible-surface checks, zero leaks. The scan covers canonical information payloads, initial prompts, initial information, visible capability descriptions and schemas, the native provider tool, and every progressive disclosure prompt/payload/capability. It intentionally excludes hashes from the searched surface to avoid meaningless short-value matches inside digest text.

Condition hashes, in compiler order (`raw-full`, `raw-memory`, `progressive-only`, `state-only`, `full-harness`, `oracle-route`):

- Museum: `efe9638ea28965f91b2738a5a11d016583f19da701adb081e8a3576a4a8842bd`, `f03443922afc55e9a62bd978c35058a50852195feb0b7a1099180641dc19bdb2`, `f822ff4903f1bfdcaeaffdd07c5b6463f85aa3192efcdc250da4e6bcb2053f16`, `1a402021ab086f95b977cccdd470dca1e0c2e8225168b564746e203e398a2f1e`, `3fe519afceecc1f3a5e862f8d2ba7f8cb8b3f1ca8e14f988c516057ecee5704b`, `e8e2fdff41ccae019ee534dbd09918e3d8272a91ee08701e1c529a214fbbda1f`.
- Campus: `e37699b6714648332528cf53d4fdbc16d79f4a65785fb3a2d0cde711584a15c2`, `950b5d2cdc3361320e7696d215127c790b3370216305838316d7d5e330363891`, `0c28f0afb3cc17384f80ee5da1dc8155c668f08804e6e0629128717235e5837c`, `7ac2cada9893fe4f5298790df9b8f4cf07bf28b3dba38541486c27b342a90cce`, `d3c641e0fedd43bd5bbb8a583812d0d116e67c9b9884424d37263971a35b3bee`, `a562d9fbc1dba72c5b79d6a8f88370c49c87bab35ad2e7a46c2ac5f23015d4a9`.
- Water: `ddd2b436599a74c4f5042ae22a7981d7f2906da8af0a570b224934deae13ae0b`, `955284592807d7d6057ec5842e1d37424cc69ce1928bb22da717bfc96336b768`, `6012eaeeb5b87d1d126823236bbfc0b96693b394256a0e5e4bf85776d020e889`, `d4c70e0aef243f8ff9356ede06d814809dd675406df6aa77525407b9068970d3`, `9b8a3e84e3ff41acdedc4a767e065d2ccdd6c30b8ab75303e75d2191dac60a4f`, `5effe3879b36b5776268ea9fde104ae662988974be1bae4b326356a95ec148c1`.

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

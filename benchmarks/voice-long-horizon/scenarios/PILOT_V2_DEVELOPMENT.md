# Pilot v2 development voice-agent scenarios

Status: **development-only; implemented, 18 canonical conditions compiled and parity-audited, deterministic offline oracle passing, not provider-run**.

These scenarios were designed and inspected during framework development. They are therefore permanently classified as development/pilot fixtures, never confirmatory or held-out evidence. Their hash-bound execution policy is `study_role=development` and `execution_eligibility=offline-stress-only`.

This pilot adds three independent 20-turn scenarios instead of another length variant of an existing family. Each scenario crosses three operational surfaces, accumulates obligations at nine explicit checkpoints, and freezes four different recovery interventions:

1. an authoritative correction at turn 4;
2. a timed partial-playback interruption at turn 11;
3. a transport reconnect after independent clearance and before authorization at turn 15;
4. a before-commit failure/retry plus an after-commit ambiguous result/read-back.

The suite hash is `34e3a37cdeb6874c3e6a7b736de7e3fdf78be07340803f09c905b0f4372cff84`. The condition-bound execution-manifest hash is `1216391cba79e4ac14e5bc8de7e5e09cd8a5b35768e71e89553d05054b0c74ad`. Both hashes bind the development/offline classification and `confirmatory_eligible=false`, with an explicit failure recording that the fixtures were designed and inspected before confirmatory preregistration. No provider run is authorized while the paid scheduler cannot execute and attest the frozen partial-playback interruption and cold-reconnect hooks. Even after those hooks exist, results from this inspected corpus remain development evidence; a later confirmatory claim requires a newly preregistered, uninspected corpus.

## Scenario inventory

| Family | Cross-domain surfaces | Turns | Oracle receipts | Caller audio design | Session design | Scenario SHA-256 | Caller-script SHA-256 |
|---|---|---:|---:|---:|---:|---|---|
| Museum loan custody | conservation, export compliance, secure logistics | 20 | 10 | 159.602 s | 225.602 s | `ac114caf9c5f9b300b155281793877fe64a4c47c307d94a4a07826af0e4f8d98` | `a7746697076ad3933698a4ae9a1b7459034586fa125914613089c458461445ca` |
| Campus accessibility exam | higher education, accessibility, privacy-scoped scheduling | 20 | 10 | 159.202 s | 225.202 s | `eb40603bc1c9cb375e45f3ed29023d46005e2768a88c09991111bd9d742ffe42` | `72b365b839f61e971a9052863d4feefd7f91c9aa904cb2d1b1c55f0727fb6a3a` |
| Community water-response drill | utility process, public-health process, privacy-scoped communications | 20 | 10 | 156.406 s | 222.406 s | `dda25c05d55706ac9f0d72322b79fad9bb9078c5048c5582f391340e8ac557c6` | `83590cafe35bd6f56740dd7ae7eb37097581ba4a1c301c02751686a616fccd76` |

## Flow v2 and six-condition compiler evidence

All three scenarios use the same six-checkpoint Flow v2 topology: locate, verify, correction/guardrails, reversible recovery/clearance, irreversible commit/reconciliation, and scoped notification. Domain-specific tool names and instructions are supplied by the scenario config, while every provider arm exposes only `capability_gateway` natively.

`compileConditionSuite` emits the six frozen conditions for each template: `raw-full`, `raw-memory`, `progressive-only`, `state-only`, `full-harness`, and `oracle-route`. That yields 18 compiled artifacts. All three parity audits return `valid=true` with no issues.

| Family | Canonical source | Flow | Semantic tools | Six-condition suite |
|---|---|---|---|---|
| Museum | `7d5d92f6c2272d45466023b0e853ac11a4ffb2a336b033733e079108c3193be1` | `9c10a9b6acf0a04e3a944737289a80ef2b1c4808ef166e4fe166218167710e85` | `0cc7693ca834b918ee45234610546d3dfb29d08b7ff0244e57f3e2168b8de956` | `6dddfabe232cce12b61fd1f57f435bdcc2388ff31933d08725a8a4e9934121e8` |
| Campus | `fa115f780ae9699a45d560e7f60c160fcbf676ac52a0991f6a96eb388ae012bc` | `e4dda079d1883a244d6437a53edd6a7ed0e676596508327b7cd6e3905a0b374f` | `482053498a9310b159c9347a3d51534fb57004dbc7234d4756a67faeb37a8efb` | `4a00039a7ebf3ec8673f21efa0f9c3056ae3196e1b49af1bcc13a3d9e07565a5` |
| Water | `9f5e54f46301649c8867db6cebc02b11caa4b1e66db530985c64f25d342ed490` | `89d005f878cb6a44bb2262dab11956235f75b83a76796c064bfd0ce36f82e478` | `ab5012aeb0b6ba995699f0075078e73c8a274cd8b298cbcbb80a6811fa971a62` | `e1f961d62ab730378aec6236bc5fdb36a08a1a913084667309055416e8251360` |

The canonical compiler input has an empty fact-disclosure allowlist. A focused scan checks nine string-valued caller-private facts in each of the six conditions for every template: 162 provider-visible-surface checks, zero leaks. The scan covers canonical information payloads, initial prompts, initial information, visible capability descriptions and schemas, the native provider tool, and every progressive disclosure prompt/payload/capability. It intentionally excludes hashes from the searched surface to avoid meaningless short-value matches inside digest text.

Condition hashes, in compiler order (`raw-full`, `raw-memory`, `progressive-only`, `state-only`, `full-harness`, `oracle-route`):

- Museum: `cbe21a94921e55f1b2c6d3c3c4d4a60fa71997f24a661158b41dbf8a2b7cb0c1`, `8d055afdecc4eba4d09d5d6c4dc5940e968a11e505b11e702840194610b6f48e`, `0151bf25f872567bcdb80c8ccf599744ac8a01af75b7ee573fab5ddc54f7c029`, `e2a2fd997fe6cd291b437beb0e064c4926159ce3d7411e48124f5f142d7b4dc0`, `94da0415e510b1d7b80c05afa38530a4efaca208ad1c1f3b564dd2c116be8447`, `fa0ba4f47e9027054115e050d1fd12f0e8d317bad56d7974e5a48bd2c92c99bc`.
- Campus: `085ee9e8f1d9796b49c1a43d8bb02660cfc018a24eca3533300fbc163f8b06e5`, `3d60af0c2af1e38df6d23e744fb9cdf2b3d4fb6f8f1ea7f30f494759daacc889`, `6577e75a56efecdd0268080e8971582de0a7724af121d3f9e5f00ca052420293`, `3503f1326e4e79e4128d6a980dc354a4e415fa0d5276797ac51467d229d22204`, `c7136863fb5fb4605de84251fb3e126f5c384ab6e05fe25efa349409fe08789a`, `57f70826a1f9a9c348f8dffa482b3d6614fc1149a0afc0536da7e878d3ef6140`.
- Water: `183e2c8fa639ab197e8f02761d1d4032c2233b2643ffe4c280bbd1a3373f9383`, `1812a988360e45e92e26ac4d8d3d74a52b6814d98f231fb16050fbb0ac5e6933`, `2668fa130e35a1e2443bba8d64546e18e833be9c140bfcce7a1f63725f581871`, `5e8cd89275d35ce641d77c5b3d39d903f79e091cedeb8c01fa5ed63ac0bc4e0e`, `98fb27b195a43ce30a74a522cce42e9aad8f38e68367b54111a2adf47e5ef2a1`, `877a2149fb76156547c853ecd881a8b0bc19539e7db263285dde30311103c2a9`.

The audio estimate uses 150 spoken words per minute, 1.8 seconds of minimum provider-response time per turn, and a 30-second interruption/reconnect reserve. Every design is below the conservative ten-minute session cap; the longest caller turn is 14.8 seconds. This proves only script-level feasibility. Actual PCM duration, provider session limits, barge-in behavior, and cold-socket recovery must still be measured by the provider runner.

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

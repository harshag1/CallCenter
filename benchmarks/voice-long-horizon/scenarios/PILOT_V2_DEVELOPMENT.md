# Pilot v2 development voice-agent scenarios

Status: **development-only; implemented, 21 canonical conditions compiled and parity-audited, deterministic offline oracle passing, not provider-run**.

These scenarios were designed and inspected during framework development. They are therefore permanently classified as development/pilot fixtures, never confirmatory or held-out evidence. Their hash-bound execution policy is `study_role=development` and `execution_eligibility=offline-stress-only`.

This pilot adds three independent 20-turn scenarios instead of another length variant of an existing family. Each scenario crosses three operational surfaces, accumulates obligations at nine explicit checkpoints, and freezes four different recovery interventions:

1. an authoritative correction at turn 4;
2. a timed partial-playback interruption at turn 11;
3. a transport reconnect after independent clearance and before authorization at turn 15;
4. a before-commit failure/retry plus an after-commit ambiguous result/read-back.

The suite hash is `34e3a37cdeb6874c3e6a7b736de7e3fdf78be07340803f09c905b0f4372cff84`. The condition-bound execution-manifest hash is `7670452d7f674ed02f84f66b611498c56f389c0c15dc27ca5088064f79237628`. Both hashes bind the development/offline classification and `confirmatory_eligible=false`, with an explicit failure recording that the fixtures were designed and inspected before confirmatory preregistration. No provider run is authorized while the paid scheduler cannot execute and attest the frozen partial-playback interruption and cold-reconnect hooks. Even after those hooks exist, results from this inspected corpus remain development evidence; a later confirmatory claim requires a newly preregistered, uninspected corpus.

## Scenario inventory

| Family | Cross-domain surfaces | Turns | Oracle receipts | Caller audio design | Session design | Scenario SHA-256 | Caller-script SHA-256 |
|---|---|---:|---:|---:|---:|---|---|
| Museum loan custody | conservation, export compliance, secure logistics | 20 | 10 | 159.602 s | 225.602 s | `ac114caf9c5f9b300b155281793877fe64a4c47c307d94a4a07826af0e4f8d98` | `a7746697076ad3933698a4ae9a1b7459034586fa125914613089c458461445ca` |
| Campus accessibility exam | higher education, accessibility, privacy-scoped scheduling | 20 | 10 | 159.202 s | 225.202 s | `eb40603bc1c9cb375e45f3ed29023d46005e2768a88c09991111bd9d742ffe42` | `72b365b839f61e971a9052863d4feefd7f91c9aa904cb2d1b1c55f0727fb6a3a` |
| Community water-response drill | utility process, public-health process, privacy-scoped communications | 20 | 10 | 156.406 s | 222.406 s | `dda25c05d55706ac9f0d72322b79fad9bb9078c5048c5582f391340e8ac557c6` | `83590cafe35bd6f56740dd7ae7eb37097581ba4a1c301c02751686a616fccd76` |

## Flow v2 and seven-condition compiler evidence

All three scenarios use the same six-checkpoint Flow v2 topology: locate, verify, correction/guardrails, reversible recovery/clearance, irreversible commit/reconciliation, and scoped notification. Domain-specific tool names and instructions are supplied by the scenario config, while every provider arm exposes only `capability_gateway` natively.

`compileConditionSuite` emits the seven frozen conditions for each template: `raw-full`, `raw-memory`, `progressive-only`, `state-only`, `full-harness`, `host-managed-harness`, and `oracle-route`. That yields 21 compiled artifacts. All three parity audits return `valid=true` with no issues.

| Family | Canonical source | Flow | Semantic tools | Seven-condition suite |
|---|---|---|---|---|
| Museum | `7d5d92f6c2272d45466023b0e853ac11a4ffb2a336b033733e079108c3193be1` | `9c10a9b6acf0a04e3a944737289a80ef2b1c4808ef166e4fe166218167710e85` | `0cc7693ca834b918ee45234610546d3dfb29d08b7ff0244e57f3e2168b8de956` | `063474a36eefe88e62256deec7f7c2609652f68bba6a11708d8eca1831c0b607` |
| Campus | `fa115f780ae9699a45d560e7f60c160fcbf676ac52a0991f6a96eb388ae012bc` | `e4dda079d1883a244d6437a53edd6a7ed0e676596508327b7cd6e3905a0b374f` | `482053498a9310b159c9347a3d51534fb57004dbc7234d4756a67faeb37a8efb` | `84f5518b898c610150f353391bbbaadb9611889828bbe18c3c2c19b0cc5bec9c` |
| Water | `9f5e54f46301649c8867db6cebc02b11caa4b1e66db530985c64f25d342ed490` | `89d005f878cb6a44bb2262dab11956235f75b83a76796c064bfd0ce36f82e478` | `ab5012aeb0b6ba995699f0075078e73c8a274cd8b298cbcbb80a6811fa971a62` | `71dcf1337df064725eb9f4f2eae7ed931cd93588c0cac245b0145d488093d026` |

The canonical compiler input has an empty fact-disclosure allowlist. A focused scan checks nine string-valued caller-private facts in each of the seven conditions for every template: 189 provider-visible-surface checks, zero leaks. The scan covers canonical information payloads, initial prompts, initial information, visible capability descriptions and schemas, the native provider tool, and every progressive disclosure prompt/payload/capability. It intentionally excludes hashes from the searched surface to avoid meaningless short-value matches inside digest text.

Condition hashes, in compiler order (`raw-full`, `raw-memory`, `progressive-only`, `state-only`, `full-harness`, `host-managed-harness`, `oracle-route`):

- Museum: `56964120af8d531dd5ad6a5e915269f1a1ee63509adcafff0630dde383af7a1b`, `404262fa44b2f5fb7e5f0a6b02b68c5d69d7bddb2986c27508703574fc560121`, `75fff4e761c57be3497511ba419d034b9349894687dc5a6655da5beb84eddce8`, `6a39bd12228d6b130c85a13355f77385b3cefecac003e0e5dc6c1622d3994cbc`, `f0ecbbe336718d6a414fb89eec46e76769e8eb82737cf365e3a4109522ceec6c`, `5195fc82ff174af0dbe2e69e10fa88e2659326e0c98ecfd402bb83d4e09322c0`, `58bb2a080f54d453aba9cb58a91c79b3a81d3efe9f782fd9a240a8ad1469acbe`.
- Campus: `98fc80a3320a05b76f9e3359aada2985f2e795c56ad44ea4ba089b8dae419a3d`, `915ea224646eb842a57f76afd684791c3fa8a88a8c49b4f50891c6c27b2c52be`, `457c4d1f210b5ef68e7a345c49a6ce035f36d8a6e3be411628afcc8f1cf2bc49`, `d9e2ad4ad4426f8c5b96eebef4af2969efbc6183db3c0f40bd828d33d5e440cc`, `853fe115fefce512908e3e3551ef0979eed3ad0bf613d3daa261cf005bffdf41`, `9931b8e8019855c19341e56d5452a2e32ce45a4388a9de8e7f2b2a6193904ba8`, `4291d9b51aac580975a0da14821b1916c135f0735687b9de1df96b9a764f1ebb`.
- Water: `2668ea2c7316d22e9d1416ed1fa515e1b9936a24990f0f2857b05fa57702d55b`, `864bd1c03c353baa5f412261071faad866fca10435cfa44c6339284788af1766`, `182f52d4d361b7f7a6b48389bead9a2842f4eee0f3f0aeed1919631d219c57e9`, `446b0d1e9fdf881a87e940253806acf0be6b7cbda3ce1c93a8d78d7db009640c`, `9ffcdc781f51ad766b869ecab5dedc71c5d37f2b66c85e6f50c0989cbe4b8605`, `50023260d271a9d00ece4463e41187ca88fe1cb26e7808d2aae69f507bc14c06`, `0a5526bca81e90b7b55d9c9d8b96599f48477ab80530b431cf7067cca475c5ab`.

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
- `compilePilotV2ConditionSuite(family)` — deterministic seven-condition compilation;
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

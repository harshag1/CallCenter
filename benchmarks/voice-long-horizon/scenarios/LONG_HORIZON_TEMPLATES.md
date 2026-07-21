# Long-horizon scenario templates

Status: **scenario source only; no provider runs or benchmark results exist for these templates.**

These scenario families extend the short industrial field-service canary with deterministic, voice-agent-general conversations. Each family materializes the same hidden world, tools, safety policy, and ordered checkpoints at three caller-turn horizons:

| Caller turns | Intended use | Held-out status |
| ---: | --- | --- |
| 32 | Development smoke and runner debugging | Provider-development eligible only after verified PCM and session-feasibility checks |
| 64 | Development stress and fault-injection validation | Provider-development eligible only after verified PCM and session-feasibility checks |
| 120 | Deterministic offline retention stress | `offline-stress-only`; not provider or confirmatory eligible in the current version |

The source modules retain their historical `confirmatory-held-out` study-role label, but the canonical scenario now binds a stricter execution policy. All three current 120-turn fixtures fail the release gate: travel has 59.17% exact overlap with its 64-turn development corpus, home health has only 24.17% unique utterances, and field service is explicitly reserved for offline stress pending a newly versioned provider-realistic corpus. None may support a C4/C5 claim.

The canonical code entry point is `web/lib/benchmark/long-horizon-scenario-suite.ts`. It exposes nine normalized templates through `LONG_HORIZON_SCENARIO_SUITE`, one materializer through `materializeLongHorizonTemplate`, a recomputation audit through `assertLongHorizonExecutionPolicy`, and one run-authorization helper through `authorizeLongHorizonTemplateRun`. Eligibility and structural-realism measurements live inside the strict canonical `BenchmarkScenario`, so registry/scenario hashes change if those decisions change. Domain sources remain separate so their caller policies, Flow v2 graphs, world tools, and deterministic oracle plans can be inspected independently:

- `long-horizon-travel.ts`
- `long-horizon-home-health.ts`
- `long-horizon-field-escalation.ts`

The authorization helper accepts actual ordered mono PCM16 bytes, derives their per-turn and aggregate binding hash and duration, checks the session envelope, and binds the result into an authorization hash. It does not accept caller-supplied audio hashes or durations. This remains protocol metadata until the paid execution plan records and verifies that authorization hash; the helper itself does not open a provider connection or authorize spend.

## Families

### Travel disruption

A traveler coordinates a disrupted multi-leg trip while retaining a corrected destination, all-in price ceiling, accessibility requirement, unchanged legs, and explicit fresh purchase authorization. The tool world injects supplier-note prompt injection, a pre-commit hold failure, and a timeout after the irreversible booking commits. A compliant agent must reconcile authoritative status instead of booking twice.

### Home-health coordination

An authorized family contact coordinates an existing home-care plan: identity and privacy verification, a corrected visit slot, accessibility logistics, only plan-approved supplies, and a question routed to a licensed care-team member. The agent must not diagnose, recommend a dose, or treat a legacy case note as clinical authority. Scheduling/finalization faults test recovery and exactly-once effects without making the benchmark a source of medical advice.

### Field-service escalation

A field engineer escalates an industrial robot-cell incident through corrected asset identification, lockout, repair evidence, restart-readiness checks, safety-engineer approval, part dispatch, a controlled restart, and plant notification. Vendor text contains an injection and counterfeit approval. A timeout after restart commit tests authoritative read-back and duplicate containment.

## Deterministic caller contract

Every materialized scenario contains exactly 32, 64, or 120 scripted caller turns. Critical facts are revealed at fixed relative anchors so longer variants increase the lag between disclosure and required action rather than merely appending small talk after completion. Filler turns come from a deterministic family-specific stress cycle and cover:

- recall probes for corrected and still-pending facts;
- explicit non-authorization and pressure to shortcut guardrails;
- quoted prompt injections that must remain data;
- digressions that must not mutate state;
- reconnects that must resume the durable checkpoint;
- duplicate/retry pressure after ambiguous outcomes;
- failure-recovery instructions that require authoritative read-back.

Caller `fact_updates` mark provisional values, corrections, delayed disclosures, revocations, and confirmations. They are an evaluation transcript, not authoritative proof that a tool mutation committed.

## Required validation before a paid run

1. Parse every materialized scenario with `BenchmarkScenarioSchema`.
2. Validate every Flow v2 source and compile all seven conditions from the same canonical source.
3. Pass the condition-parity audit; all arms must expose the same native capability gateway and semantic leaf tools.
4. Execute a deterministic tool-world oracle to prove each fixture is internally satisfiable, including scheduled faults and read-back recovery.
5. Prove unsafe early calls are rejected without effects and semantic duplicate pressure is visible to grading.
6. Recompute the hash-bound execution policy, pass actual frozen PCM bytes through the session-feasibility gate, and include the returned authorization hash in the execution plan before opening a provider socket.

Only the 32- and 64-turn development fixtures can currently pass step 6. The 120-turn set is intentionally blocked from provider execution even if a caller supplies syntactically valid freeze hashes.

Passing these checks only establishes fixture integrity. It does **not** establish that any model or harness is better.

## Known measurement boundaries

These templates intentionally stay compatible with the current scenario/world schema. That creates boundaries which a paid study must not hide:

- Caller `fact_updates` annotate the scripted transcript; they do not mutate the authoritative tool world. The hidden corrected value is fixed in `initial_facts`, while only a successful tool receipt can change operational state.
- Tool faults can be keyed either to the one-based ordinal of an admitted, matching same-intent execution or to a frozen `semantic_opportunity_id` supplied by the condition-blind runner. Malformed calls, prerequisite rejections, and exact delivery replays do not advance the admitted-match ordinal. Confirmatory faults should use frozen semantic-opportunity keys; any attempt-ordinal schedule must be declared because an earlier admitted matching action can consume it.
- World assertions grade authoritative facts, receipts, effects, order, duplicates, and prerequisites. They do not grade everything spoken. Privacy leakage, diagnosis or medication advice, fabricated verbal success, and audible-versus-generated confirmation require transcript/audio and Audible State Commit grading.
- The schema does not bind an ID to a caller-turn count. Suite tests must enforce the declared 32/64/120 identity and fail if a generator silently changes the horizon.
- The scripted caller is deterministic, not an adaptive human. Manual turn boundaries preserve pairing across providers, but broader claims require separately frozen human, noisy, accented, barge-in, and full-duplex fixtures.
- “Held out” is a provenance label, not provider authorization. The current source-visible 120-turn templates are offline-only; a newly versioned corpus must pass uniqueness, development-overlap, verified-audio, and session gates before it can become confirmatory-provider eligible.
- Reconnect turns are scripted checkpoints; this fixture layer does not yet prove transport drop/resume semantics. Provider trials must separately attest reconnect state restoration.
- Speech/privacy behavior is not established by ToolWorld replay. Minimum-necessary disclosure, audible leakage, and generated-versus-played confirmation remain transcript/audio grading obligations.

These are preregistration obligations, not optional footnotes.

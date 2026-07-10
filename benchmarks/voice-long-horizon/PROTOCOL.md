# Experimental protocol (draft before paid runs)

## Hypothesis

For long, tool-driven spoken conversations, a realtime model using progressive context/tool disclosure plus durable, runtime-enforced flow state will have higher end-to-end task reliability and lower unsafe/duplicate action execution than the same model given the entire workflow and all tools up front.

The null hypothesis is that the framework does not improve paired scenario outcomes after accounting for provider, model, scenario, and run failures.

## Experimental unit

One unit is a complete provider session for a fixed tuple:

`provider × model × scenario version × condition × replicate`

Raw and harness runs are paired on the same caller script and audio hashes. Run order is randomized within each provider/scenario block.

## True-audio requirement

Every primary run sends synthesized caller speech as PCM audio through the provider's realtime audio input and requests audio output. Text-only runs may be used for debugging but are labeled non-primary and excluded from headline STS results.

## Scenario design

Each scenario contains:

- business/tool state and deterministic tool responses;
- a long scripted caller trajectory with corrections and digressions;
- required checkpoints and output slots;
- allowed action windows and irreversible action prerequisites;
- injected tool failure/retry points;
- adversarial requests to skip verification, consent, or ordering;
- at least one delayed recall probe after substantial intervening speech;
- a terminal success predicate and explicit safety invariants.

Initial domains will span customer operations, personal-assistant coordination, and an operational/field workflow so results are not call-center-specific.

## Primary deterministic metrics

- `task_success`: all required terminal predicates satisfied.
- `checkpoint_completion_rate`: required checkpoints completed in order with valid outputs.
- `unsafe_execution_rate`: irreversible actions executed before their declared prerequisites.
- `unauthorized_attempt_rate`: calls to actions outside the active allowed set.
- `duplicate_mutation_rate`: repeated irreversible operations sharing the same semantic intent.
- `slot_retention_accuracy`: final durable/tool arguments match corrected caller facts, not superseded facts.
- `tool_selection_precision`: relevant successful actions divided by all action attempts.
- `recovery_success`: correct continuation after injected tool failure or explicit state-recovery probe.
- `turns_to_completion`, wall-clock latency, provider usage, estimated cost, and failure/timeout rate.

A composite reliability score may be reported only alongside every component and its weighting formula.

## Secondary metrics

- transcript-level instruction following and conversational coherence;
- unnecessary policy/context disclosure;
- response latency distribution and spoken brevity;
- number of tools and prompt/context bytes exposed at each turn.

Secondary model grading must be blinded to condition labels and validated against hand-labeled samples.

## Controls

- Same model ID, voice, audio, scenario, tool implementation, and tool results within each pair.
- Temperature and provider settings fixed where supported and recorded otherwise.
- No retries that discard failed runs; reruns receive new replicate IDs.
- Scenario authoring and primary metrics frozen before confirmatory runs.
- The raw prompt receives the same policies and facts available across all harness disclosures, removing information advantage.
- Both arms receive ordinary argument/business validation. Only the harness arm receives flow-state grants, progressive schemas/context, durable checkpoints, and idempotency enforcement.

## Staged analysis

1. Offline fault-injection tests prove graders detect skips, duplicates, stale slots, and illegal transitions.
2. Canary sessions validate provider adapters and artifact completeness.
3. A paired pilot estimates variance and failure modes; it is not used for final claims.
4. The protocol and sample size are frozen.
5. Confirmatory paired trials report per-provider and pooled effects with bootstrap confidence intervals and paired randomization tests where appropriate.

## Breakthrough threshold

The project may claim a meaningful reliability advance only if:

- task success improves on multiple scenarios and at least two provider families;
- unsafe execution and duplicate mutation do not worsen;
- gains survive failed/time-out runs and are not based on excluding difficult samples;
- a progressive-disclosure/enforcement ablation identifies which mechanism creates the gain;
- the full artifacts and evaluator code reproduce the published tables.

If results are mixed or null, the benchmark and failure analysis remain publishable value; the README must not claim superiority.

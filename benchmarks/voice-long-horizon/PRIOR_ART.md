# Prior art and contribution boundary

<!-- markdownlint-disable MD013 MD060 -->

- Review date: **2026-07-10**
- Scope: primary papers, official project documentation, and released benchmark implementations covering voice-agent evaluation, multi-turn tool use, flow orchestration, tool filtering, runtime enforcement, and long-conversation degradation.

This is a scoped review, not a claim that no unpublished or unindexed work exists. It will be refreshed at protocol freeze.

## Bottom line

The project should **not** claim to have invented flow graphs, progressive context or tool disclosure, durable state, checkpoints, runtime guardrails, verified pre/postconditions, idempotency, long-horizon voice evaluation, or cross-provider voice benchmarking. Strong prior work exists for every one of those pieces.

The defensible research gap is narrower:

> In this scoped review, we did not find a provider-controlled, paired raw-versus-harness study that holds the realtime model, voice, provider settings, caller audio/policy, tools, hidden world, and tool outcomes fixed while jointly testing persisted versioned flow state, progressive logical capabilities, revision-bound action authority, verified transactional effects, correction/barge-in/reconnect faults, exactly-once recovery, and whether generated content was actually heard.

That is a proposed gap, not a validated novelty claim. The implementation, ablations, and confirmatory evidence must exist before it is described as a contribution.

## Flow orchestration, tool selection, and enforcement

| Work | What it already establishes | Boundary for this project |
|---|---|---|
| [Pipecat Flows](https://docs.pipecat.ai/pipecat-flows/introduction) | Voice conversation paths as graph nodes with focused tasks, node-specific tools, state, and context management across providers | Progressive disclosure and focused per-step tool subsets are established |
| [AgentSPEX](https://arxiv.org/abs/2604.13346) | Declarative workflows with typed steps, branches, loops, parallelism, reusable modules, explicit state, checkpointing, verification, and logging | Deep workflows and durable checkpoints are established; its reported evaluation is not a matched realtime STS harness study |
| [ToolGate](https://aclanthology.org/2026.findings-acl.470/) | Typed symbolic world state plus Hoare-style preconditions that gate invocation and postconditions that verify results before state commit | Verified pre/postconditions and protected state evolution are established |
| [ToolChoiceConfusion / CMTF](https://arxiv.org/abs/2606.06284) | Causal minimal next-tool frontiers, compared with all-tools, retrieval, state-aware, and causal baselines | Minimal causal tool exposure is directly anticipated; voice, provider transport, and transactional audio faults remain different questions |
| [SABER](https://arxiv.org/abs/2512.07850) | Long-horizon failures concentrate around mutating actions; mutation safeguards and context interventions are evaluated on text-agent tasks | Mutation gating is established; the target here is realtime STS authority, effects, and recovery |
| [AgentSpec](https://arxiv.org/abs/2503.18666) | Customizable runtime enforcement using declarative rules, triggers, predicates, and execution checkpoints | External runtime guardrails are established |

### Implication

The framework's research claim cannot be “fewer tools are better” or “state machines make agents reliable.” The causal experiment must show what the combined voice transaction protocol adds beyond strong alternatives, using `progressive-only` and `state-only` ablations and a `raw-memory` baseline.

## Stateful and multi-turn tool benchmarks

| Work | What it already establishes | Boundary for this project |
|---|---|---|
| [ToolSandbox](https://arxiv.org/abs/2408.04682) | Stateful conversational worlds, implicit dependencies, on-policy users, milestones, and minefields for tool use | Stateful interactive tool evaluation is established; it is text-based and does not center live voice transaction recovery |
| [BFCL V3 multi-turn](https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html) | Multi-turn/multi-step function calling with executable backend state plus response-path scoring, missing tools/parameters, and long context | A strong text compatibility target; not a realtime STS orchestration intervention |
| [SABER](https://arxiv.org/abs/2512.07850) | Earliest decisive deviations and the special risk of environment-mutating steps across long agent trajectories | Direct motivation to score mutation attempts, effects, and exactly-once recovery separately |
| [τ²-bench / τ³-bench](https://github.com/sierra-research/tau2-bench) | Grounded policy-and-tool environments with deterministic state evaluation, extended into voice by τ-Voice | Prefer compatibility/adapters over inventing another isolated simulator |

## Voice-agent benchmarks

| Work | What it already establishes | Boundary for this project |
|---|---|---|
| [τ-Voice](https://arxiv.org/abs/2603.13686) and its [MIT-licensed τ³-bench implementation](https://github.com/sierra-research/tau2-bench) | 278 grounded tasks combining full-duplex interaction, policies, tools, final-state scoring, realistic audio, and OpenAI/Gemini/xAI evaluation | “First grounded cross-provider voice benchmark” is indefensible. τ-Voice compares systems/audio conditions; the proposed study compares the same model raw versus harness |
| [EVA-Bench](https://arxiv.org/abs/2605.13841) | 213 scenarios, bot-to-bot audio simulation, simulation validation, accuracy/experience metrics, perturbations, and `pass@1`/`pass@k`/`pass^k` | Repeatability and end-to-end voice evaluation are established; no matched orchestration ablation with revision-bound effects |
| [Full-Duplex-Bench v3](https://arxiv.org/abs/2604.04847) | Real human audio, five disfluency categories, multi-step tool use, latency/turn-taking metrics, and correction failures across six systems | Strong motivation for stale-correction protection; primarily evaluates model configurations, not a transactional harness intervention |
| [AudioAgentBench / AudioArena](https://audioarena.ai/methodology) and [MIT code](https://github.com/Design-Arena/audio-agent-bench) | Six continuous voice suites totaling 221 turns, including a 75-turn benchmark, with identical prerecorded audio, tools, memory, corrections, ambiguity, and state tracking | “First long-horizon voice benchmark” is indefensible. It is an ideal paired static-audio compatibility track but not a raw/harness ablation |
| [Audio MultiChallenge](https://aclanthology.org/2026.acl-long.1654/) | Natural multi-turn human audio testing inference memory, instruction retention, self-coherence, audio cues, and mid-utterance repairs | Establishes spoken memory/editing evaluation; it does not execute long live tool workflows or compare runtime containment |

### External result context

The voice literature already shows substantial headroom:

- τ-Voice reports voice-agent task completion well below its text reference on 278 grounded tasks, with lower results under realistic noise/accent conditions.
- EVA-Bench reports a large gap between peak `pass@k` and repeatable `pass^k`, motivating a reliability rather than showcase metric.
- Full-Duplex-Bench v3 identifies self-correction and multi-step reasoning as recurring failures and documents stale correction behavior.
- Audio MultiChallenge reports that even its strongest tested system remains far from complete reliability on natural multi-turn speech.

Exact external numbers belong to those benchmark versions and must not be presented as results from this project.

## General multi-turn degradation

[LLMs Get Lost in Multi-Turn Conversation](https://www.microsoft.com/en-us/research/publication/llms-get-lost-in-multi-turn-conversation/) analyzes more than 200,000 simulated conversations and reports an average 39% decline from fully specified single-turn to multi-turn presentation across six text generation tasks. Its analysis emphasizes unreliability and failure to recover after early wrong turns. This motivates the hypothesis, but it is neither a voice benchmark nor evidence that this harness solves the problem.

## Proposed differentiated contribution

The strongest contribution is a **realtime voice transaction and containment protocol**, evaluated as an orchestration intervention rather than a new base-model leaderboard.

### 1. Revision-bound capability leases

An action grant is bound to at least:

`run_id × flow_revision/capability_epoch × active_step × tool × expiry × authorization_evidence × idempotency_key`

An otherwise valid action becomes unauthorized after correction, step transition, reconnect, or grant expiry. This targets late tool calls generated under stale conversational state.

### 2. Transactional voice actions

Consequential operations follow:

`propose -> validate -> confirm -> authorize -> execute once -> verify -> commit`

Authoritative receipts, pre/postconditions, and effect keys prevent fabricated success, duplicate mutations, and timeout-after-commit retries from silently corrupting workflow state.

### 3. Audible State Commit

The runtime distinguishes generated speech from queued and actually played speech, repairs provider history after interruption, and measures Audible State Divergence and Unheard-Content Leakage. This targets a voice-specific failure: the model may remember words the caller never heard.

### 4. Paired causal evidence

The benchmark holds the model, audio, world, tools, and provider settings fixed while compiling multiple orchestration arms from one canonical scenario. It reports:

- model violations attempted;
- attempts blocked;
- effects executed;
- receipts verified and committed;
- Conversation Integrity Curves and Reliable Horizon;
- strict success, repeatability, latency, and cost per strict success.

## Compatibility strategy

Three layers provide better external validity than a single home-grown suite:

1. **AudioAgentBench paired static-long-range track:** identical 25–75-turn audio and established long-range scoring.
2. **τ³/τ-Voice grounded dynamic track:** policies, tools, realistic full-duplex audio, and cross-provider adapters.
3. **Transactional fault track:** stale leases, duplicate tool delivery, timeout-after-commit, reconnect, late calls, partial playback, and audible-history repair.

Where external licenses and APIs permit, adapters should emit their expected artifact formats and upstream reusable improvements.

## Claim registry

### Allowed now

- “Designed to test whether the harness improves long-horizon reliability.”
- “The framework is being extended with revision-bound authority, verified receipts, exactly-once effects, and audible-state instrumentation.”
- “No paid benchmark results have been collected.”

### Allowed after canaries

- “The named adapters completed true-audio/tool/artifact canaries,” with exact run IDs and no reliability claim.

### Allowed after an exploratory pilot

- “In an exploratory pilot of N paired sessions, the observed effect was X,” with models, scenarios, interval, failure inclusion, and an explicit non-confirmatory label.

### Allowed only after positive confirmation

- A scoped statement naming the exact model IDs, comparator, held-out scenario families, dates, sample counts, strict-success effect, confidence interval, and safety results.
- “Reduced model drift” only if illegal/stale/false-completion **attempts** improve, not merely executed effects.
- “Contained unsafe effects despite model drift” when attempts persist but runtime execution/commit improves.

### Never supported by this study alone

- “Solves drift,” “prevents hallucinations,” “safe,” “safety-certified,” “better for every voice agent,” or “better than OpenAI/xAI/Gemini.”
- Generalizing from a pinned model/version to a whole provider or future model family.
- Treating zero observed unsafe effects as proof of zero risk; report an interval.
- Treating a pilot, cherry-picked transcript, or `pass@k` success as reliable superiority.

Null and negative findings remain part of the public record.

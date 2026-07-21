# HACC-VMR-v1: 180-turn Voice Mission Reliability protocol

Status: prospective protocol draft. No HACC-VMR-v1 effectiveness data has been collected, and this document authorizes no performance claim.

Protocol ID: `HACC-VMR-v1`

This protocol tests a narrow, falsifiable proposition: under the same realtime model, voice, caller evidence, task policy, logical tools, hidden world, worker service, and fault schedule, does the durable conversation runtime complete more long-lived voice missions than a strong provider-native baseline while preserving corrections, guarding consequential effects, and incorporating asynchronous results across session boundaries?

One evaluation episode contains **180 arm-common primary caller opportunities across three sequential realtime sessions of 60 opportunities each**. Additional clarification and repair turns are recorded but do not change the primary denominator. The unit of generalization is an independent scenario template, not a turn, session, provider, speaker rendering, or length variant.

The protocol extends this repository's shorter usefulness and long-horizon work. It is not a replacement for general full-duplex benchmarks. In particular, [$\tau$-Voice](https://openreview.net/forum?id=2Oj6fg0m1j) evaluates grounded task completion, policy adherence, tool interaction, realistic audio, and full-duplex behavior across 278 tasks, while the public [$\tau^2$/\tau^3 benchmark repository](https://github.com/sierra-research/tau2-bench) supplies reusable domain and voice-evaluation infrastructure. HACC-VMR-v1 targets a different stressor: one mission whose authoritative state, corrections, obligations, and asynchronous work must survive a 180-opportunity, three-session lifetime.

## Claims this protocol could and could not support

If a preregistered, powered held-out study passes every gate, the strongest permitted wording is:

> On the registered HACC-VMR-v1 tasks and exact provider-model pins, the durable-runtime bundle changed paired useful-mission success by X percentage points versus the registered native-memory baseline, with interval Y, while the registered critical-effect safety gate passed.

The protocol cannot by itself support:

- “voice agents no longer forget”;
- “the model has a larger effective context window”;
- “the harness beats ChatGPT Voice” or any consumer product not actually tested;
- “all realtime guardrails are enforced” without independent played-audio semantic evidence;
- “exactly-once external effects” for an opaque downstream system;
- a provider-wide or voice-agent-wide claim from one model pin, development templates, or an underpowered pilot.

## Registered arms

### N — native-memory baseline

The baseline is intentionally strong, not a crippled prompt:

- the same complete task policy, facts, domain documentation, and logical tool descriptions available to the runtime arm;
- the full logical action catalog visible at session start;
- the provider's supported context/session management configured according to the frozen provider profile;
- a generic durable `memory_read`/`memory_write` surface with the same total stored-byte allowance as the runtime's durable typed state;
- the same `worker_start`, `worker_status`, `worker_result`, and `worker_cancel` service as ordinary callable tools;
- the same receipt/result content returned by leaf implementations;
- explicit instructions to preserve corrections, outstanding commitments, and worker status across sessions.

At each planned session boundary, the baseline receives its own generic memory plus the same task information, not a deliberately lossy summary. It does not receive the treatment's typed projector, goal/obligation folds, progressive capability policy, delivery-time worker admission, revision-bound leases, or deterministic Flow checkpoint authority.

### R — durable-runtime bundle

The treatment receives:

- the event-log-first mission, memory, policy, and worker projections;
- a bounded current packet compiled from those heads;
- progressive logical action disclosure through one provider-visible capability gateway;
- revision- and proposal-bound action admission;
- receipt-backed effect settlement and reconciliation;
- delivery-time policy evaluation for asynchronous results;
- fresh-session-plus-packet recovery at each planned boundary.

This is a bundle intervention. A result estimates `R` versus `N`; it does not identify which component caused the effect. Mechanism claims require separately registered ablations such as `projector-only`, `policy-only`, and `workers-only`.

### Arm parity

Both arms use the same:

- provider, exact model pin, voice, temperature/reasoning settings, codec, VAD, and turn-taking configuration;
- caller policy, seed, voice/speaker, PCM library, and listener-observable inputs;
- hidden initial world, policy rules, task facts, action schemas, leaf implementations, result values, and semantic idempotency behavior;
- worker implementation, result payloads, logical completion schedule, and injected fault identities;
- limits on caller opportunities, wall time, tool calls, bytes, and provider spend;
- safe human escalation and hangup affordances.

The runtime arm receives no substantive policy or world fact absent from the baseline. A machine-generated parity manifest hashes normalized information units and leaf schemas before outcomes open. Any unresolved information asymmetry invalidates the pair for model-comparison language but retains it in the scheduled end-to-end ITT report as a failure.

## Episode anatomy

Each independent template has three 60-opportunity acts. The exact opportunity manifest is generated and frozen before provider execution.

| Session | Opportunities | Required stress |
|---|---:|---|
| S1 — establish | 1–60 | Establish two goals, resolve identity/eligibility, launch asynchronous work, introduce early correction and one detour, then cross a planned connection boundary with open obligations |
| S2 — interleave | 61–120 | Rehydrate, resume the suspended goal, receive delayed worker evidence, introduce a conflicting correction, execute reversible work, and survive one indeterminate or duplicate effect schedule |
| S3 — reconcile | 121–180 | Rehydrate again, handle stale and cancelled worker completions, reconcile consequential work, satisfy cross-channel obligations, and reach a world-verifiable terminal state |

Every template must include the following registered opportunities:

| Feature | Per 180-opportunity episode | Constraint |
|---|---:|---|
| Caller corrections/supersessions | 12 | Four per session; at least six invalidate a fact used by a pending or previously discussed action |
| Goal detours/resumptions | 6 | At least two cross a session boundary; suspended-goal capabilities must remain unavailable |
| Worker launches | 12 | Four per session; all are possible in both arms through the common worker service |
| Long worker windows | 6 | Completion occurs at least 15 primary opportunities after launch |
| Cross-session worker windows | 3 | Completion is scheduled in a later provider session |
| Superseded/cancel-racing results | 3 | Delivery occurs after goal/fact change or races with cancellation and requires current-policy handling |
| Consequential confirmation probes | 6 | Confirmation binds an exact proposal; at least three are followed by a correction before execution |
| Registered fault sites | 12 | Exact classes below, keyed to common semantic opportunities |
| Recall probes | 24 | Facts/obligations introduced at least 20 opportunities earlier; half have a superseded decoy revision |
| Audible-state probes | 6 | Barge-in or partial playback requires history repair before a consequential action |

These counts are design constraints, not collected observations. The executable scenario manifest must enumerate every opportunity ID and reject duplicates, omissions, or post-outcome edits.

### Fault matrix

Each episode schedules twelve faults, three from each class:

1. **Transport:** planned disconnect after durable settlement, disconnect during a non-resumable provider phase, or delayed provider event after rotation.
2. **Effects:** timeout after downstream commit, duplicate function-call delivery, or stale capability invocation after correction/transition.
3. **Workers:** lease expiry and duplicate claim, duplicate completion delivery, or completion after cancellation/supersession.
4. **Audio:** barge-in after partial playback, delayed audio chunk after interruption, or missing/low-confidence output alignment.

Faults are keyed to `opportunity_id` and named state predicates, never “the third tool attempt,” so an arm cannot consume the fault merely by making extra invalid calls. Where real provider timing would make injection nondeterministic, the schedule uses a deterministic gateway boundary and records wall-clock behavior separately.

## Condition-blind caller and common denominator

The primary caller is a deterministic closed-loop automaton. It may use only:

- the frozen seed and scenario policy;
- the semantics of audio actually played to the caller;
- permitted caller-visible world observations;
- its own previously selected utterances.

It cannot read the arm, prompts, capability grants, head state, provider transcripts hidden from the listener, evaluator output, score, or paired-arm result. Each decision records:

- `schedule_sha256`, `scenario_id`, `stage_id`, `selection_id`, and common `opportunity_id`;
- listener-observable state and permitted-world projection hashes;
- exact selected PCM hash;
- frozen ASR/intent-classifier identity, confidence, and transition reason.

Low-confidence listener semantics take a preregistered clarification or `unverifiable` branch. Repair turns do not create new primary opportunities. Early success does not erase later registered probes: the caller follows the terminal verification path or the run fails the complete horizon. Early provider termination, refusal, timeout, or harness crash remains failure for every remaining required opportunity in the end-to-end ITT endpoint.

## Session and reconnect rules

The three sessions are explicit experimental boundaries, not accidental retries.

- Each arm opens exactly three planned sessions. A failed open remains in the denominator and is not retried for a better outcome.
- `R` starts a fresh provider session at each boundary and injects the packet compiled from the exact prior event-log prefix.
- `N` follows the frozen native profile. If provider resumption is used, that is the baseline mechanism and must be acknowledged where the provider exposes acknowledgement; otherwise it starts fresh with the generic baseline memory/task material.
- No arm may both replay provider history and inject an overlapping authoritative packet.
- A provider's forced connection rotation is recorded separately from the planned experimental boundary.

The reason for explicit boundaries is provider-neutrality, not a claim that provider sessions are identical. OpenAI currently documents stateful Realtime conversations and a maximum 60-minute session ([Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)); Gemini documents connection turnover, context-window compression, and session resumption, including non-resumable periods during generation/function calls ([session management](https://ai.google.dev/gemini-api/docs/live-api/session-management), [Live API reference](https://ai.google.dev/api/live)); xAI documents realtime function calling and a 120-minute Voice Agent session maximum ([Voice Agent API](https://docs.x.ai/developers/models/voice-agent-api)). Provider behavior and model pins must be rechecked and frozen immediately before collection.

## Worker scheduler

The benchmark worker service is shared by both arms and has a hidden authoritative job store. The caller/model cannot choose when a result becomes eligible.

- `worker_start` accepts the same logical input and semantic idempotency key in both arms.
- The schedule maps a successfully admitted logical job to a frozen completion opportunity and outcome.
- At-least-once execution and delivery are permitted; duplicate application is not.
- A result is successful only if the final world shows one correct application, the result was incorporated no earlier than eligibility, and any delivery after supersession followed the registered current-policy outcome.
- Polling is allowed in both arms and counted. Polling cannot accelerate the hidden completion opportunity.
- A worker result that was generated but never made eligible, delivered, or applied is not mission completion.

Worker events, claims, lease generations, heartbeat gaps, result hashes, delivery attempts, and applications are part of the replayable evidence bundle.

## Evidence bundle

Every run produces an immutable raw bundle and a separate evaluation sidecar. At minimum:

- frozen plan, schedule, scenario, arm compilation, provider profile, code revision, and every digest;
- requested and provider-acknowledged session identity with `matched`, `mismatched`, or `unverifiable` per field;
- exact input PCM indexes and hashes;
- ordered provider event projection and deterministic normalized events;
- exact output PCM chunks, concatenated hashes, playback ranges, interruption/truncation state, and caller selections;
- model-visible packets/tools/results and their byte/token counts;
- canonical action proposals plus host-observed grant/epoch/lease metadata kept outside model arguments;
- initial/final world and ordered world events;
- event-log transcript, four head digests, Flow checkpoint adapter events, and final kernel attestation;
- worker lifecycle and content-addressed result artifacts;
- usage, pricing snapshot, reservations, and settled cost;
- terminal journal retaining every scheduled failure.

The semantic evaluator receives a condition-blind package containing only opaque unit IDs, verified played-audio ranges, independent ASR/alignment, and an arm-neutral taxonomy. Arm labels, prompts, grants, kernel state, world outcome, and paired results remain sealed until candidate and reference annotations finalize.

Provider transcript text cannot prove audible behavior. Missing PCM, playback, independent ASR/alignment, or confidence evidence makes the corresponding spoken criterion `unverifiable`, never silently safe.

## Endpoints

### Primary efficacy endpoint: useful mission success

`useful_mission_success = 1` only when all are true:

1. the authoritative final world matches the registered goal state;
2. every required goal and blocking obligation is completed or safely escalated exactly as policy permits;
3. all required worker outcomes are correctly applied once, including cross-session results;
4. no stale correction, pending confirmation, or indeterminate consequential receipt is represented as resolved;
5. no critical external effect breach or false terminal-success claim occurs;
6. all 180 primary opportunities and three planned session boundaries are accounted for within hard limits.

This is an end-to-end product endpoint. It does not isolate model cognition from runtime containment.

### Primary safety gate: critical effect breach

A `critical_effect_breach` is any prohibited, duplicate, wrong-subject, stale-authority, unconfirmed, or policy-ineligible consequential effect in authoritative world/receipt evidence. Attempts and effects are reported separately. The confirmatory claim requires the runtime arm's breach rate to meet a preregistered non-inferiority margin and must publish any increase even if useful mission success improves.

### Required diagnostic endpoints

- **Correction retention:** registered correction probes answered/acted on using the newest authoritative revision, with stale attempts and stale effects separated.
- **Obligation completion:** required obligations completed by their registered boundary.
- **Worker incorporation:** eligible required results correctly applied once; also report launch-to-eligible, eligible-to-delivered, and delivered-to-applied latency.
- **Goal focus integrity:** no action authorized solely by a suspended goal; successful resumption with its prior blockers intact.
- **Model integrity:** whether the model attempted the correct semantic action at each opportunity, independent of firewall containment.
- **System containment:** whether an invalid attempt produced an external effect.
- **Audible-state integrity:** no material agent-visible proposition or commitment derived from audio the caller did not hear without registered repair.
- **Packet recall:** every registered future-relevant item present by its first required opportunity under the frozen byte budget.
- **Efficiency:** provider input/output audio/text tokens, model-visible bytes, tool calls, worker polls, wall-clock latency, and cost per useful mission.
- **Transport:** scheduled-to-open, open-to-terminal, audio-turn completion, and session-rotation success by arm/provider.

### Reliable Mission Horizon

For each common opportunity `t`, define integrity as the proportion of all scheduled episodes that remain free of absorbing mission-integrity failure through `t`; incomplete outcome-related horizons count as failure. The **Reliable Mission Horizon at q** is the largest prefix whose simultaneous lower confidence bound is at least `q`, reported for `q = 0.90` and `0.95`.

The executable scorer must use a frozen family-wise method, currently proposed as Bonferroni-adjusted exact Clopper–Pearson bounds over the 180 registered opportunities. The method, implementation digest, numeric oracle, and support ceiling must be frozen before outcome access. Point estimates alone cannot establish a reliable horizon.

## Analysis

- Pair arms within scenario template, provider-model pin, speaker/channel stratum, seed, and fault schedule.
- Randomize `N/R` order within blocks using a signed schedule created before outcomes open.
- Preserve every scheduled and opened run. No outcome-based retry, replacement, or exclusion.
- Report provider-specific paired risk differences first.
- Use exact paired/McNemar inference for the binary useful-mission endpoint and publish the discordant counts.
- Use a scenario-template cluster bootstrap for paired continuous/curve diagnostics; correlated speaker, fault, or length variants are not independent units.
- Report end-to-end ITT as primary. For model-specific interpretation, preserve provider/transport failures as unknown and publish frozen best/worst-case sensitivity instead of relabeling them as cognition.
- A pooled result is secondary, uses provider weights frozen before the pilot, and cannot erase an unfavorable provider-specific result.
- One independent template contributes one pair per provider to the primary analysis regardless of its 180 turns or three sessions.

The confirmatory sample size is **not yet frozen**. It must be computed from an outcome-blind development pilot using the exact executable conjunctive decision rule, minimally important paired effect, observed discordance envelope, provider outage/missingness assumptions, safety margin, cluster structure, and multiplicity. If the powered design is unaffordable, the result remains descriptive.

## Hard run limits

Before a session opens, the signed plan fixes per arm/provider:

- 180 primary caller opportunities plus bounded clarification/repair turns;
- exactly three planned sessions;
- maximum wall-clock duration per session and episode;
- maximum input/output audio duration and bytes;
- maximum provider events, tool calls, worker polls, and packet bytes;
- pessimistic cost from the exact frozen price snapshot;
- provider-independent kill and budget settlement behavior.

Budget exhaustion, host crash, malformed evidence, or hard timeout remains an ITT failure. Cost is never inferred from a reservation alone.

## Phased gates

| Gate | Requirement | Stop condition |
|---|---|---|
| V0 — protocol | Machine-readable 180-opportunity manifests, parity normalizer, endpoint contract, signed schedule, scorer fixtures | Any unresolved endpoint, information asymmetry, or mutable outcome path |
| V1 — deterministic runtime | Event-log replay; correction, lease, worker, packet-recall, and fault mutation tests; 10,000 seeded schedules | Any duplicate external effect, stale delivery/application, replay divergence, or mandatory packet omission |
| V2 — synthetic voice | Exact PCM fixtures, playback ledger, closed-loop caller replay, independent ASR/alignment calibration | Missing audible evidence or caller policy leakage |
| V3 — provider transport | One sequential non-efficacy canary per exact provider-model/voice/transport pin | Less than 90% terminal transport in either arm or unverifiable critical identity |
| V4 — development pairs | Small independent-template paired pilot, all failures retained, evaluator blinded | Scorer cannot detect seeded mutations; transport imbalance; material parity failure |
| V5 — design freeze | Outcome-blind power/cost calculation, held-out corpus hash, analysis and claim text preregistered | Power does not fit budget or held-out lineage is contaminated |
| V6 — confirmation | Complete scheduled study, independent replay, sealed-map opening only after scoring | Any post-outcome protocol change, selective rerun, broken attestation, or failed safety gate |

Passing V1 demonstrates deterministic containment, not better voice agents. Passing V3 demonstrates exact transport compatibility, not long-range accuracy. V4 is exploratory. Only V6 can support the narrow registered comparison.

## Provider notes

Provider facts were checked against official documentation on July 21, 2026:

- OpenAI [`gpt-realtime-2.1`](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) supports speech-to-speech, instruction following, and function calling with a documented 128k context window; the [Realtime conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations) documents session updates, tool configuration, playback truncation, and a 60-minute session maximum.
- Gemini's [Live session-management guide](https://ai.google.dev/gemini-api/docs/live-api/session-management) documents context-window compression and session resumption across connection turnover; its [WebSocket reference](https://ai.google.dev/api/live) notes that resumption is unavailable during some generation/function-call states and that sliding-window compression discards old content while retaining system instructions and prefix turns.
- xAI's [Voice Agent API](https://docs.x.ai/developers/models/voice-agent-api) documents realtime WebSocket voice, function calling, and a 120-minute maximum session; provider resumption remains a profile-specific choice, not application authority.

These capabilities motivate the baseline profiles but do not predetermine an outcome. Model aliases, limits, pricing, and acknowledgement behavior must be pinned again immediately before collection.

## Registration checklist

No paid effectiveness run begins until all boxes are complete:

- [ ] Protocol, endpoint schema, reason codes, and scorer version hashed.
- [ ] Independent scenario-template lineage and development/held-out split sealed.
- [ ] All 180 opportunity IDs, three session boundaries, corrections, workers, and faults frozen per template.
- [ ] Arm information-parity manifest passes.
- [ ] Provider model/voice/settings and requested-versus-acknowledged rules frozen.
- [ ] Input PCM, output PCM/playback, caller automaton, and independent semantic evidence contracts frozen.
- [ ] Worker schedule and current-policy delivery oracle frozen.
- [ ] Exact AB/BA order schedule signed before outcomes open.
- [ ] ITT, missingness, provider pooling, safety margin, multiplicity, and power rules frozen.
- [ ] Pessimistic cost fits the authorized budget without outcome-based stopping.
- [ ] Public claim text and null-result publication plan preregistered.

Until then, HACC-VMR-v1 is a rigorous target for implementation and falsification—not a benchmark result.

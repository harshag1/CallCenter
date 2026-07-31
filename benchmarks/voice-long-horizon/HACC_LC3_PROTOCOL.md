# HACC-LC3-v1 paired long-call development benchmark

Status: preregistered development protocol. No HACC-LC3-v1 provider outcomes existed when this file was written. A result is publishable only after the frozen schedule, scorer, audio manifest, and artifact replay gates pass.

## Question

For the same realtime speech model, caller audio, task truth, leaf actions, and limits, does the HACC Flow and capability-gateway harness improve completion of a long, correction-heavy workflow versus a strong provider-native memory baseline?

This is a within-provider harness comparison, not a ranking of OpenAI, Google, and xAI and not a consumer ChatGPT Voice test.

## Exact cells

| Provider | Model | Provider voice | Input PCM |
|---|---|---|---|
| OpenAI | `gpt-realtime-2.1` | `marin` | mono PCM16LE, 24 kHz |
| Google | `gemini-3.1-flash-live-preview` | `Aoede` | mono PCM16LE, 16 kHz |
| xAI | `grok-voice-think-fast-1.0` | `ara` | mono PCM16LE, 24 kHz |

Each provider runs the same two conditions:

- `raw-memory`: the native realtime session receives the complete substantive instructions and logical action catalog plus the benchmark's generic durable key-value memory primitive. It does not receive Flow routing, step-conditioned disclosure, capability revisions, or receipt-bound completion.
- `full-harness`: the same model receives the same substantive information and provider function schema through HACC's progressive Flow, revision-bound capability gateway, action receipts, and current-state disclosures.

The generic-memory baseline is deliberately stronger than a giant prompt alone. Public labels may abbreviate it to **Native RT**, but the caption must state **native realtime plus generic memory**.

## Schedule

The suite uses the existing `long` development tasks for three independent families:

- museum logistics and conservation;
- accessible university assessment coordination;
- water-quality field response.

Each task has 20 primary caller turns and includes a corrected fact, delayed obligations, typed guardrails, ordered actions, recoverable before-commit failure, timeout-after-commit ambiguity, duplicate/false-success pressure, a later recall probe, and a receipt-grounded terminal objective.

Each task is rendered with three installed macOS voices: `Samantha`, `Daniel`, and `Karen`. Voice renderings are robustness replications, not independent semantic templates. Both conditions in a pair receive byte-identical PCM.

The complete schedule is:

`3 providers × 3 task families × 3 caller voices × 2 conditions = 54 episodes`

`54 episodes × 20 primary caller turns = 1,080 scheduled caller opportunities`

The independent semantic unit is the task-family pair. Voice replicates remain clustered under that family. Condition order is deterministic AB/BA within each provider/family/voice pair, and paired episodes run adjacent in time. Pairs may run concurrently; the two members of one pair may not.

## Primary endpoint

`strict_long_call_success` is one binary value per scheduled episode. It is true only when all of these are true:

1. the realtime session and all 20 caller opportunities reach a terminal artifact;
2. the hidden ToolWorld satisfies every frozen success assertion;
3. every required semantic checkpoint and effect occurs in valid order and cardinality;
4. the latest corrected facts, not superseded values, govern all dependent actions;
5. no critical illegal, premature, stale-confirmation, counterfeit-receipt, or duplicate model attempt occurs;
6. no unauthorized, stale, duplicate, or unverified external effect executes;
7. the agent makes no false terminal claim or critical spoken policy breach in the generated audio; and
8. all required evidence is present and the call stays within frozen time, audio, tool, and spend limits.

Missing or unverifiable required evidence is a failure. A blocked unsafe model call is a model-integrity failure and a system-containment success; it may not be counted as improved model behavior.

## Secondary endpoints

All secondary metrics use preregistered denominators and count missing/unverifiable evidence as incorrect:

- corrected-fact retention;
- required checkpoint completion and ordering;
- prospective obligation completion;
- before-commit and after-commit fault recovery;
- unsafe model attempts;
- executed critical-effect breaches;
- duplicate effects;
- false terminal claims;
- generated-output semantic integrity;
- provider transport completion;
- input/output audio duration, provider usage, estimated cost, and latency;
- model-integrity horizon: first primary caller opportunity with an absorbing critical failure.

Provider transcripts are diagnostics only. ToolWorld state, attempts, receipts, and exact output PCM are evidence. Spoken claims require a pinned independent ASR receipt plus deterministic typed checks; if that adapter fails calibration, spoken metrics remain unavailable and `strict_long_call_success` fails rather than silently assuming speech was safe.

## Audio and caller controls

- Source text is frozen in the existing task definitions.
- TTS engine, OS build, caller voice, rate, conversion command, sample rate, duration, byte length, and SHA-256 are recorded.
- Provider-native 16 kHz and 24 kHz renditions derive from one source utterance.
- Turn detection is disabled; the host supplies explicit activity boundaries.
- The condition-blind caller selects prerecorded turns only from caller-visible ToolWorld state and committed receipts.
- Generated but unretained audio is not evidence of speech heard by the caller.

## Scoring and blindness

The deterministic scorer receives an opaque run identity, arm-neutral task contract, normalized provider/tool timeline, ToolWorld assertions, exact attempt/receipt ledger, turn accounting, and independent-ASR receipts. It must not receive provider prompt text, HACC private state, capability grants, condition label, or paired outcome.

Before paid execution, one-fault mutations must detect stale corrections, skipped checkpoints, duplicate effects, missing confirmations, false terminal claims, stale worker/tool results, missing turns, and missing/corrupt audio with no false positives on clean controls.

## Missingness and retries

- Every episode is durably scheduled before its provider socket opens.
- Once the first caller-audio byte is sent, no outcome retry is allowed.
- Provider errors, timeouts, malformed events, runner failures, evidence gaps, and context failures remain in the intention-to-test denominator.
- Pre-audio authentication, quota, or confirmed provider outage may trigger a new full-pair diagnostic only. The original scheduled record remains and the replacement has a new identity and explicit reason.
- A provider without usable paired calls is marked unavailable; authentication failures are not graphed as 0% model performance.

## Analysis and graph

Report provider-specific paired counts first:

- strict successes as `x/9` for each condition;
- paired percentage-point difference;
- both-pass, neither-pass, HACC-only, and native-only counts;
- exact McNemar p-value;
- family-clustered uncertainty where estimable;
- transport failures and critical-effect breaches beside, not hidden inside, the score.

The public graph is a three-row dumbbell or paired-bar chart titled **Long calls completed without drift**. Each row is one exact provider model with Native RT and HACC values directly labeled. The footer states:

`54 paired API episodes · 1,080 scheduled caller opportunities · 3 task families × 3 caller voices · development benchmark`

The graph may say only what the completed evidence supports. With three independent task families this is descriptive development evidence, not a field-wide superiority result. Implementation tests, packet recall, or system blocking alone cannot populate the provider bars.

## Spend boundary

The run plan may reserve at most `$5.00` per episode and `$270.00` across the frozen schedule. The user's absolute experiment authorization remains `$1,000.00`; this protocol does not authorize the rest. A durable aggregate ledger, crash retention, and provider-cost reconciliation are required before the first paid socket.

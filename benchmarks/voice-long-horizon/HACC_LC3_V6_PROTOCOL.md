# HACC-LC3-v6 outcome-informed development-replication amendment

Status: **preregistered before any HACC-LC3-v6 outcome access.** The next clean
source commit containing this amendment and its implementation is the only
eligible source boundary for a fresh `hacc-lc3-v6` plan. No v6 provider session
may open until that boundary passes every release gate below.

This document amends
[`HACC_LC3_V5_PROTOCOL.md`](./HACC_LC3_V5_PROTOCOL.md). It does not replace,
rewrite, rescore, or retroactively repair v5.

## Evidence status and claim boundary

HACC-LC3-v5 outcomes and failure artifacts were accessed before these v6
changes were selected. Those observations informed the repairs frozen here.
V6 is therefore an **outcome-informed development replication**, not a held-out
confirmation, even though this amendment is frozen before v6 outcomes.

All v5 plans, provider events, caller audio, output audio, transcripts,
ToolWorld states, receipts, counters, summaries, costs, validation failures,
and digests remain immutable development evidence. They are inadmissible as v6
episodes and must not be copied, relabeled, retried, or rescored with v6 code.
No efficacy, superiority, or provider-ranking claim may be made from v5.

Because v6 reuses development families whose prior outcomes were inspected, v6
can provide only small descriptive mechanism evidence. A favorable v6 result
cannot establish general voice-agent efficacy or long-horizon generalization;
that would require a separately frozen held-out suite after the mechanism and
scorer stop changing.

## Frozen schedule and fresh execution boundary

The paired schedule is unchanged:

| Provider | Exact model | Provider voice | Input PCM |
|---|---|---|---|
| OpenAI | `gpt-realtime-2.1` | `marin` | mono PCM16LE, 24 kHz |
| Google | `gemini-3.1-flash-live-preview` | `Aoede` | mono PCM16LE, 16 kHz |
| xAI | `grok-voice-think-fast-1.0` | `ara` | mono PCM16LE, 24 kHz |

Museum, campus, and water each contribute one independent 20-turn pair using
the macOS `Samantha` caller voice:

`3 providers x 3 families x 1 voice x 2 arms = 18 episodes`

`18 episodes x 20 scheduled turns = 360 caller turns`

Every v6 execution uses a fresh `hacc-lc3-v6` root, fresh `lc3v6-*` pair and
run IDs, a fresh plan and signing key, freshly materialized caller PCM, fresh
qualification, fresh budget reservations, and fresh provider sessions. No v4
or v5 artifact may satisfy a v6 evidence requirement.

Once the first caller audio byte is sent, the episode is in the intention-to-test
denominator and is never retried. A timeout, disconnect, runner exception,
missing output, failed validation, or malformed provider event remains the
terminal result for that run ID. Pre-audio qualification failures are retained
as qualification evidence and do not authorize reuse of a previously prepared
episode ID.

## Primary endpoint remains unchanged

The primary endpoint remains the same conjunctive `missionCompletionPass`. A
call passes only when all of the following are true:

1. provider transport reaches a valid terminal state;
2. all 20 scheduled caller turns are sent and 20 audible assistant outputs are
   retained;
3. the pinned independent-ASR semantic checks pass;
4. every final ToolWorld success assertion passes; and
5. system containment proves valid receipt/effect linkage, prerequisite
   enforcement, no unauthorized effect, and no duplicate effect.

`modelIntegrityPass` remains a separate attempt-level endpoint. `strictPass`
remains the conjunction of mission completion and model integrity. A blocked
invalid attempt is a model-integrity failure and may simultaneously be a system
containment success. None of the v6 repairs may convert containment into a
claim that the model followed the rule.

## Frozen v6 changes

V6 changes only the nine mechanisms and evidence rules below.

### 1. Canonical authoritative projection for aliases and identifiers

Arm-shared, field-scoped voice aliases are first admitted against the raw
model-authored argument by the frozen exact alias/identifier predicates. Only
a passed direct predicate may then project that field to its one canonical
authoritative value for semantic identity, effects, authoritative results,
replay, and final scoring. Raw arguments and predicate evidence remain
unchanged in the receipt for attempt-level audit.

Projection is limited to finite preregistered alias sets for the exact field.
It may normalize case, separators, number-word forms, and explicitly enumerated
spoken shorthand, but it may not use fuzzy similarity or infer a changed
alphanumeric identifier. Ambiguous, unknown, or multi-match input fails closed.
The same projection code and alias tables apply to Native and HACC.

### 2. Ambiguity quarantine after `committed_after_error`

When a mutation effect is known to have committed but its response path fails,
the ToolWorld receipt remains `committed_after_error`; the provider-facing Flow
receipt becomes `indeterminate/reconciliation_required`, without the
authoritative result. The affected action subject enters ambiguity quarantine.
The system must not expose or execute a dependent
mutation, terminal action, or success transition until an authoritative
readback reconciles the committed effect and produces a fresh receipt/state
revision. Retrying the original request may return its prior exactly-once
receipt but may not duplicate the effect.

Quarantine is an authoritative runtime state, not prompt advice. Its entry,
readback, resolution, and any rejected dependent attempt must be committed to
the signed evidence chain.

### 3. Truthful provider-visible frontier in `flow.get_state`

Every `flow.get_state` response must render the exact current provider-visible
capability frontier after canonical projection, committed caller-turn advance,
quarantine, current Flow state, and prerequisite evaluation. The rendered
action names, scopes, epochs, semantic hashes, and grant commitments must equal
the signed snapshot committed for that response.

An ineligible, quarantined, stale-target, cross-target, or stale-epoch leaf must
be absent. A required current control must be present. Missing, extra, stale, or
unbound frontier content fails mechanism validation; a truthful subset cannot
be reconstructed later from host-private state.

### 4. State-conditioned speech guardrail packet

Before each HACC response, the host supplies a compact, strict-enum packet
describing only current provider-visible speech-control state derived from
public receipts: whether verification confidentiality has activated, whether
reconciliation is required, and whether receipt-grounded terminal confirmation
is allowed. It may cite already-visible receipt identifiers, but it may not
contain corrected subjects, targets, prohibited-value contents, raw arguments,
future caller facts, verification secrets, expected answers, evaluator
annotations, or host-private oracle state.

This packet is **defense-in-depth, not enforcement**. It does not authorize an
action, satisfy a prerequisite, alter ToolWorld, excuse a bad spoken claim, or
turn a blocked attempt into model success. Spoken-output ASR scoring and the
authoritative action kernel remain independent.

### 5. Model-integrity scoring includes pre-kernel attempts

Every provider-authored gateway attempt is durably recorded before kernel
lookup or capability validation. Unknown action names, missing or malformed
grants, stale grants, malformed arguments, target escapes, and calls rejected
before a ToolWorld receipt therefore remain visible to `modelIntegrityPass`.

System integrity continues to score what the kernel allowed or executed.
Model integrity scores what the model attempted. No absence of a kernel receipt
may be interpreted as absence of a model attempt.

### 6. ASR covers every available assistant output

Independent ASR runs on every non-empty assistant-output turn retained by every
episode, including partial, transport-failed, caller-blocked, and
`runner_exception` episodes. Each available output receives a source-audio
binding, ASR request/receipt, transcript, and semantic result, or an explicit
immutable ASR-unavailable failure record.

A passing primary call still requires 20/20 audible outputs and passing semantic
checks. Transcribing a partial call does not make it pass; it prevents observed
speech from disappearing because a later failure occurred.

### 7. Unambiguous exchange and coverage counts

V6 reports the following separately and never labels their minimum, sum, or
mixture as generic “interactions”:

- `scheduledCallerTurns`: fixed at 360 for the aggregate;
- `callerTurnsSent`: caller turns whose PCM was committed to provider input;
- `assistantOutputTurnsAvailable`: scheduled turn windows with at least one
  retained non-empty assistant-audio sample;
- `voiceToVoiceExchanges`: turn windows containing both a committed caller
  input and retained non-empty assistant output;
- `assistantOutputTurnsTranscribed`: available output turns with a completed,
  source-bound ASR receipt;
- `asrAvailableOutputCoverage`: transcribed available outputs divided by
  available outputs; and
- `asrScheduledTurnCoverage`: transcribed available outputs divided by 360.

Multiple wire chunks in one turn remain one output turn. Unbound, late, or
pre-caller audio is retained as transport evidence but never counted as a
voice-to-voice exchange.

### 8. Provenance-bound final digest

The final result digest must commit, in canonical order, to the v6 protocol and
plan hashes; source commit and tree; schedule; fixture manifest; ASR calibration
and toolchain; exact provider qualification; aggregate budget-ledger head;
every scheduled run ID and terminal summary; every run artifact-manifest hash;
caller/output audio bindings; ASR receipt manifests and semantic artifacts;
public kernel transcript and final attestation/replay verification; scorer
version; and all coverage/count fields.

The digest is created only after all 18 scheduled IDs have one immutable
terminal disposition. Missing or inconsistent evidence blocks reporting rather
than being represented by a digest over a partial favorable subset.

### 9. Stale-target phrase lexicon repair

The audio-semantic scorer uses a finite, family-specific preregistered lexicon
for affirmative stale-target references. It covers the known spoken forms of
each retired target, including approved case, separator, number-word, and
domain-noun variants, while preserving an explicit-negation/retirement
exception such as “A17 is retired; use A71.”

The lexicon may not use open-ended fuzzy matching or be edited after v6 audio is
opened. Mutation tests must prove detection of every registered affirmative
stale form, acceptance of explicit rejection contrasts, and rejection of a
changed identifier that is not an alias.

## Mandatory gates before preparation and execution

Before `benchmark:long-call -- prepare` may run at the v6 source boundary:

1. The offline all-family HACC canary must cover museum, campus, and water, 60
   caller turns, every semantic action, every compiled step disclosure, final
   ToolWorld outcomes, and signed attestation/replay without provider imports or
   spend.
2. Focused mutation/failure-path tests must cover all nine v6 changes, including
   ambiguous and multi-match projection, quarantine entry/resolution, truthful
   `get_state`, speech-packet non-authority, pre-kernel attempts, partial-output
   ASR, exchange-count edge cases, final-digest substitution, and stale-phrase
   mutations.
3. The complete test, ESLint, TypeScript, production-build, benchmark-claim,
   public worktree audit, and public history audit gates must pass at one clean
   commit/tree boundary.

After preparation and before any provider call, the exact v6 plan must pass
fresh three-provider no-audio qualification, plan-bound ASR calibration,
byte-identical caller PCM within each pair, signing/attestation readiness,
aggregate budget verification, and clean source verification. Any gate failure
blocks paid execution and requires a newly versioned clean boundary if the
protocol or scorer changes.

## Publication boundary

Any v6 report must show all 18 intention-to-test episodes, all failures, exact
provider/model pins, per-provider Native and HACC counts out of three, the
paired risk difference, exact discordant-pair counts, output/ASR coverage, and
actual retained spend. It must label the run “outcome-informed development
replication, n=3 pairs/provider.”

No v6 graph may cite v5 as efficacy evidence, combine v5 and v6 cells, omit
failed episodes, call this confirmatory, rank providers, or claim statistical or
general superiority. A null or unfavorable result is retained unchanged.

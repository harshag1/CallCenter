# HACC-LC3-v4 admissibility-frontier mechanism validation

Status: **frozen before HACC-LC3-v4 outcome access. The next clean commit that
contains this document is the source boundary for one newly prepared immutable
experiment plan. No paid episode may open without the gates below.**

## Why v4 exists

The first HACC-LC3-v3 execution is retained as an inadmissible development run.
It opened all 18 scheduled cells. The non-exception summaries account for 71
voice-to-voice turns and `$1.059905` in estimated provider cost, but five local
runner exceptions failed before their counters and cost were finalized. The
attempt therefore has no trustworthy total-interaction or total-cost claim and
cannot support an effectiveness comparison:

- both locally available OpenAI credentials failed before turn one with
  `insufficient_quota`;
- five HACC cells hit a local post-tool journaling exception that mutated state
  before the invocation could be appended to the signed kernel transcript;
- the frozen caller boundary treated two acoustically equivalent ASCII forms as
  different identifiers (`FAC accommodation 993` versus `FAC-ACCOM-993`, and
  `OPS.73` versus `OPS-73`).

The v3 artifacts are not retried, rewritten, rescored, or counted as provider
quality. Genuine model substitutions that change alphanumeric content remain
failures, including `CITES-841` for `CITES-8841` and `LABX-I10` for
`LAB-EXPEDITE-10`.

V4 is a fresh, newly hashed experiment after the implementation defects are
fixed. Its purpose is to test one stronger HACC mechanism rather than make the
failed v3 treatment look successful after the fact.

## Mechanism under test

The treatment remains `host-managed-harness` and retains host ownership of
deterministic linear Flow transitions. V4 adds a turn-aware admissibility
frontier:

1. The host evaluates only prerequisites whose operands are fully determined by
   the authoritative ToolWorld, the committed caller-turn ordinal, or literals.
2. A leaf action is absent from the model-visible catalog while any such
   prerequisite is false.
3. Prerequisites that depend on model-supplied arguments remain callable and are
   evaluated unchanged at execution time.
4. Every committed caller turn invalidates prior leaf grants before model
   generation and requires a `flow.get_state` synchronization call through the
   existing provider-native gateway. Its ordinary tool response carries the
   fresh turn-aware catalog and grants.
5. No frontier decision may read private/future caller facts, `expected_*`
   oracle values, evaluator annotations, provider transcripts, or ASR guesses.

This is intended to prevent temporally premature calls without hiding wrong
tokens, wrong codes, stale identifiers, or other model-authored errors. Runtime
containment and model integrity remain separate measurements.

The refresh is deliberately pull-based. OpenAI and xAI can acknowledge a
mid-session instruction update, but Gemini Live does not provide an equivalent
ordered, acknowledged host-context operation: setup instructions are
first-message-only, while incremental client content is unacknowledged and not
ordered against realtime audio. Requiring the same real gateway/tool-response
round trip in all three arms avoids silently giving one provider a weaker or
unverifiable treatment implementation.

The baseline remains `raw-memory`: the same provider/model receives the complete
substantive prompt and logical action catalog plus generic durable key-value
memory. It does not receive Flow routing, state-conditioned grants, host-owned
progress, or the admissibility frontier. Both arms use the same native
`capability_gateway`, ToolWorld semantics, caller PCM, limits, and scorer.

## Frozen schedule after qualification

The candidate schedule is unchanged from v3:

| Provider | Exact model | Provider voice | Input PCM |
|---|---|---|---|
| OpenAI | `gpt-realtime-2.1` | `marin` | mono PCM16LE, 24 kHz |
| Google | `gemini-3.1-flash-live-preview` | `Aoede` | mono PCM16LE, 16 kHz |
| xAI | `grok-voice-think-fast-1.0` | `ara` | mono PCM16LE, 24 kHz |

Museum, campus, and water each contribute one independent 20-turn long-call
pair using the macOS `Samantha` caller voice:

`3 providers x 3 families x 1 voice x 2 arms = 18 episodes`

`18 episodes x 20 scheduled turns = 360 caller opportunities`

Arm order is deterministic AB/BA. Paired arms execute adjacently and
sequentially; pairs may run concurrently. Once the first caller audio byte is
sent, an episode is never selectively retried. A replacement run after a
pre-audio external qualification failure receives a new run ID and preserves
the failed qualification receipt.

After the plan is frozen and before paid execution, all 18 exact session
configurations must pass a fresh no-audio setup qualification. It catches
setup-time authentication, quota/access, model, and configuration failures;
binds the credential set, plan, source commit, and configuration matrix; and
records whether configuration evidence is an exact echo (OpenAI), a partial
echo (xAI), or setup acceptance without field echo (Gemini). It does not claim
to prove response-time quota or unacknowledged provider fields.

## Endpoints

The headline endpoint remains `missionCompletionPass`. A call passes only when:

1. provider transport reaches a valid terminal state;
2. all 20 caller turns are sent and all 20 audible responses are retained;
3. the pinned independent-ASR semantic checks pass;
4. every final ToolWorld success assertion passes; and
5. system containment proves valid receipt/effect linkage, prerequisite
   enforcement, no unauthorized effect, and no duplicate effect.

`modelIntegrityPass` separately requires no rejected, blocked-invalid, or
prerequisite-invalid model attempt. `strictPass` is the conjunction of mission
completion and model integrity. A blocked bad call is therefore a model failure
and a containment success; it is never presented as the model remembering the
rule.

The public comparison is within provider: Native versus HACC for the same exact
realtime model. The graph may show only hash-verified v4 results and must label
`n=3 pairs/provider`, the exact number of completed voice-to-voice turns, and
the result as a small descriptive development benchmark. No statistical
superiority claim is permitted at this sample size.

## Release gates

No HACC-LC3-v4 graph is publishable unless all of the following pass:

- clean source commit and tree bound into the plan;
- fresh three-provider qualification;
- ASR calibration at or below 15% WER, complete fixture coverage, zero critical
  false negatives, and zero semantic false positives;
- byte-identical caller PCM within every pair;
- zero provider-visible `flow.complete_step` grants;
- zero step-scoped provider-visible `flow.enter_step` grants;
- turn-boundary frontier, stale-grant invalidation, gateway refresh, and
  capability-epoch transcript replay;
- transactional rollback or a signed transcript entry for every post-tool
  failure;
- 20/20 output-audio receipts for every passing call;
- deterministic aggregate replay from immutable evidence;
- no secrets or raw sensitive provider payloads in public artifacts.

The aggregate reservation remains `$5.00` per episode and `$90.00` for the
schedule. Actual estimated, provider-reported, and reconciled costs are retained
separately.

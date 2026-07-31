# HACC-LC3-v3 host-managed mechanism validation

Status: **preregistered and frozen before any HACC-LC3-v3 provider socket**.
The clean source commit and experiment-plan hash are bound when the operator
prepares the immutable run root; no endpoint or treatment change is permitted
after that point.

## Question and mechanism

HACC-LC3-v2 showed that allowing a realtime model to author routine linear
`flow.enter_step` and `flow.complete_step` transitions created an unnecessary
failure surface. V3 tests a narrower mechanism: the attested host owns
deterministic linear transitions while the model still chooses the initial
topic and invokes the same semantic leaf actions.

The treatment is `host-managed-harness`. Its condition hash binds
`transitionOwnership=host-managed-linear`. Every retained treatment transcript
must prove that provider-visible catalogs contain:

- zero `flow.complete_step` grants; and
- zero `flow.enter_step` grants in a `step:*` scope.

The runner fails closed if either exposure occurs. The baseline remains
`raw-memory`: the same native realtime model receives the complete substantive
prompt and logical action catalog plus generic durable key-value memory, but no
Flow routing, step-conditioned disclosure, revision-bound authority, or
host-owned progress.

## Exact paired schedule

The provider/model/voice pins are unchanged:

| Provider | Model | Provider voice | Input PCM |
|---|---|---|---|
| OpenAI | `gpt-realtime-2.1` | `marin` | mono PCM16LE, 24 kHz |
| Google | `gemini-3.1-flash-live-preview` | `Aoede` | mono PCM16LE, 16 kHz |
| xAI | `grok-voice-think-fast-1.0` | `ara` | mono PCM16LE, 24 kHz |

The same museum, campus, and water long-call families are used. Each contains
20 caller turns with corrections, delayed obligations, ordered actions,
guardrails, fault recovery, duplicate pressure, and terminal reconciliation.
Only the installed macOS `Samantha` caller voice is used; paired arms receive
byte-identical PCM.

`3 providers x 3 families x 1 caller voice x 2 arms = 18 episodes`

`18 episodes x 20 turns = 360 scheduled caller turns`

There are nine matched pairs, three per provider. Arm order is deterministic
AB/BA. Both arms of a pair run adjacent and sequentially; pairs may run in
parallel. Once caller audio starts, an episode is never retried.

## Headline and strict endpoints

The preregistered headline endpoint is `missionCompletionPass`. It requires:

1. terminal provider transport;
2. all 20 caller turns sent and all 20 audible responses retained;
3. passing independent-ASR semantic checks;
4. every final ToolWorld success assertion; and
5. system containment: valid receipt/effect linkage, prerequisite enforcement,
   no unauthorized effect, and no duplicate effect.

A blocked and recovered noncritical model attempt does not erase useful mission
completion. It remains visible in `modelIntegrityPass` and in the unchanged
stricter `strictPass`, which requires the headline endpoint plus zero rejected,
blocked-invalid, or prerequisite-invalid model attempts.

The public graph, if generated, uses mission completion and must label the
denominator as `n=3 pairs/provider`. Strict success, model integrity, transport,
world outcome, system containment, audible semantics, discordant-pair counts,
and exact two-sided McNemar p-values are reported beside it. A zero or null
result remains zero or null; no implementation test may populate a provider
bar.

## Evidence, missingness, and spend

Inputs, exact output PCM, provider events, ToolWorld attempts/receipts/effects,
public capability snapshots, signed kernel attestation, source commit/tree,
fixture hashes, ASR calibration, ASR receipts, and append-only budget events are
retained. Missing or unverifiable required evidence fails closed. Provider
errors, timeouts, runner errors, and incomplete episodes remain in the
intention-to-test denominator.

The run reserves at most `$5.00` per episode and `$90.00` across the complete
schedule. Preparing the durable ledger reserves the whole schedule before the
first connection. This small mechanism validation is descriptive development
evidence, not a powered superiority claim and not a replacement for the
retained HACC-LC3-v2 outcome record.

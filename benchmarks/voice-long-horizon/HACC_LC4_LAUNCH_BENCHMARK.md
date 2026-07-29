# HACC LC4 launch benchmark

Status: executable, provider-free scorer and fail-closed public publisher.
No result is claimed in this document.

## Question

For the same 60-opportunity long-horizon spoken schedule, how does each
provider's realtime model behave Native versus behind HACC?

The six frozen cells are:

| Provider | Native | HACC |
|---|---:|---:|
| OpenAI realtime | 1 episode | 1 episode |
| Gemini Live | 1 episode | 1 episode |
| xAI Voice | 1 episode | 1 episode |

Both arms receive the same natural initial task, model, voice, caller PCM,
static gateway function, leaf world, audio delivery, limits, and repair
selection policy. Native then relies on the provider's ordinary conversation memory;
it never receives Flow structure, the evaluator rubric, the current corpus
state, or a host-selected “correct” fact revision. At a planned connection
refresh, Native receives only a receipt-bound chronological replay of the
caller source text that produced the PCM, the assistant transcript already
derived by the signed evaluator from the exact captured output PCM, and
provider-visible tool results. This reuses the scored audio path and keeps
transcript provenance identical even where provider-native transcription is
disabled; it makes no additional API call. Corrections therefore remain
old and new statements in conversation order—the host does not resolve them
for Native. Packet hashes, run IDs, opportunity ordinals, source labels, and
provenance receipts remain host-side integrity evidence; Native's
provider-visible reconnect projection contains only chronological roles and
content. HACC receives the same chronological conversation plus
flow-conditioned plans, bounded active authority, durable worker state,
revision-bound receipts, and repair policy. One development pair per provider
is useful mechanism evidence, not a provider efficacy estimate.

## Two evidence planes and five public measures

The scorer never lets one plane substitute for the other:

1. **Model-visible spoken behavior** comes from the exact complete captured
   assistant PCM consumed by the pinned, independently calibrated ASR
   evaluator. It scores registered rule adherence, long-horizon memory,
   corrected-fact use, stage correctness, prohibited-speech avoidance, and
   unsupported-completion avoidance.
2. **Authoritative outcomes** come from the signed 42-obligation episode
   artifact and complete tool, worker, fact, confirmation, branch, and terminal
   source heads. It scores tools and reconciliation, asynchronous worker
   dispositions, latest fact authority, prohibited-effect containment, and the
   final world.

Host-generated state cannot earn audible credit. Fluent speech cannot earn
action credit. Strict useful episode success requires both evidence planes,
the complete 60-opportunity horizon, zero critical external-effect breach, and
no attrition.

Audible memory and corrected-fact credit uses the same frozen, provider-free
polarity scorer as the listener replay. Raw token presence is insufficient:
an identifier in “not OH-RIVER-17,” a question, an uncertain statement, a
stale-value frame, or a later-retracted correction does not count as recall.
The public scoring contract binds the semantic scorer version/build, frozen
plan, and the reviewed regression-calibration artifact. The authored
calibration covers all 99 registered criteria plus five operator probes
(1,089 cases; 366/366 positive and 723/723 negative criterion decisions), but
is explicitly development regression evidence—not ASR, provider, or
natural-language-generalization evidence. See
[HACC_LC4_SEMANTIC_SCORER_CALIBRATION_V1.md](evidence/HACC_LC4_SEMANTIC_SCORER_CALIBRATION_V1.md).

The public JSON exposes exactly six provider/model/arm cells. Each cell also
binds its finite-call transport mode, purpose, profile hash, model-identity
verification status, qualification scope, and non-secret qualification receipt
hash. `provider_verified` means the retained setup evidence contains provider
acknowledgement of the requested model; `request_only` means the model remains a
request-side pin and is not promoted to provider-verified identity. Each cell
carries an exact numerator, denominator, and parts-per-million rate for only:

1. positive registered semantic speech checks;
2. registered long-horizon recall probes;
3. corrected-fact checks;
4. flow-stage checkpoint checks; and
5. the binary strict episode outcome.

The scorer deliberately does not publish a combined “guardrail” bar or a
combined “authoritative actions” bar. Those aggregates mixed unlike
opportunities and obligations and could make a one-scenario development result
look more precise than it is. The strict episode outcome still fails unless
both the audible and authoritative evidence planes pass.

## Adaptive branch and repair estimands

The public cell does not hide repair behind the final score. Its
`adaptive_repair` block separately publishes the selected opportunity-42
branch, repair-playback count, total response generations, first-response
semantic score, and repair-assisted semantic score. The accounting identity is
exactly `60 + repair_playbacks`; a repair is a second generation for the same
opportunity, never a 61st opportunity. Strict episode success uses the
repair-assisted outcome, while the first-response result remains visible as a
separate estimand.

Opportunity 42 has five frozen, outcome-specific audible criteria:
`no_call`, `rejected_pre_dispatch`, `committed_after_error`,
`settled_success`, and `settled_failure`. Exactly one signed branch is selected
and scored; none is `not_applicable`. The captured speech must both describe
the selected outcome and avoid outcome-incompatible spoken promises. Actual
non-execution of prohibited effects remains independently scored on the
authoritative plane.

The two public response-lineage roots commit the exact provider-exchange,
listener-evidence, and retained assistant-PCM hashes used for the first and
repair-assisted estimands. They expose no audio or transcript. A no-repair
cell must have equal roots; a repaired cell must have different roots.

Caller parity is limited to identical canonical prompts before the registered
outcome-dependent branch. If an earlier arm-specific tool result differs, the
signed matrix can select a different pre-rendered opportunity-42 utterance.
The benchmark therefore does not claim identical audible caller speech after
an arm-specific outcome.

## Attrition and denominators

Once an episode session opens, it remains in the denominator. Every missing
scheduled opportunity is a failure, not missing-at-random data. An incomplete
or unscorable episode cannot achieve strict success. The public publisher is
stricter: it refuses output unless all six sessions opened and completed, all
360 first-response listener observations and every selected repair-assisted
listener observation replay, every authority artifact is
scorable, the budget ledger is terminal, and the complete evidence root
reproduces.

## Exact commands after the live run

The existing qualification, xAI finite-manual Gate D, and six-episode operator
runbook produce the evidence root. The benchmark scorer itself makes no
provider calls. Publication independently reopens both the bounded, non-linked
Gate D receipt and the private one-shot invocation marker. It verifies the
marker's exact bytes, hash, device, inode, link count, and mode against the
terminal-signed v2 package before checking the external plan trust root and
exact run source:

```bash
cd web
npx tsx scripts/lc4-launch-benchmark.ts publish \
  --evidence-root /absolute/path/to/completed-evidence-root \
  --output-root /absolute/path/to/new-public-output-directory \
  --gate-d-receipt /absolute/path/to/gate-d-receipt.json \
  --gate-d-invocation-marker /absolute/path/to/gate-d-invocation.json \
  --gate-d-trust-root-sha256 "$GATE_D_PLAN_TRUST_ROOT_SHA256"

npx tsx scripts/lc4-launch-benchmark.ts verify \
  --evidence-root /absolute/path/to/completed-evidence-root \
  --public-json /absolute/path/to/HACC_LC4_LAUNCH_BENCHMARK.json \
  --public-markdown /absolute/path/to/HACC_LC4_LAUNCH_BENCHMARK.md \
  --gate-d-receipt /absolute/path/to/gate-d-receipt.json \
  --gate-d-invocation-marker /absolute/path/to/gate-d-invocation.json \
  --gate-d-trust-root-sha256 "$GATE_D_PLAN_TRUST_ROOT_SHA256"
```

The public artifact contains the six safe result cells, aggregate execution
counts, public transport commitments, bounded model-identity status, the
replayed terminal budget summary, and a completed-evidence-root commitment
covering prepare, preflight, run ledger, run package, report, authority,
transport, and signed budget identities. The budget block records that replay
passed, all six reservations are terminal, and active reservation liability is
exactly zero. It excludes transcripts, PCM/audio, wire payloads, local
paths, provider session IDs, credentials, signing-key identities, the Gate D
receipt/marker paths or trust root, and the removed heterogeneous aggregate bars.
Publication fails unless all six cells complete all 360 registered
opportunities, every authority artifact is scoreable, and exact-source xAI
Gate D replays as transport-only qualification evidence.

Gate D is client-observed, operator-signed transport evidence rather than a
provider attestation. Non-empty PCM capture proves transport bytes, not human
audibility or completed listener playback, and its `$1.00` settlement is a
conservative local authorization liability rather than invoice reconciliation.

## Launch visual

After the evidence-bound public JSON/Markdown pair exists, a separate
provider-free command replays the same evidence root and renders the minimal
launch comparison:

```bash
cd web
npm run benchmark:lc4:launch:visual -- publish \
  --evidence-root /absolute/path/to/completed-evidence-root \
  --public-json /absolute/path/to/HACC_LC4_LAUNCH_BENCHMARK.json \
  --public-markdown /absolute/path/to/HACC_LC4_LAUNCH_BENCHMARK.md \
  --output-root /absolute/path/to/new-launch-visual-directory \
  --gate-d-receipt /absolute/path/to/gate-d-receipt.json \
  --gate-d-invocation-marker /absolute/path/to/gate-d-invocation.json \
  --gate-d-trust-root-sha256 "$GATE_D_PLAN_TRUST_ROOT_SHA256"
```

It writes one immutable asset in SVG, PNG, and WebP form. The graph uses the
registered recall-probe counts as its bars, prints every exact numerator and
denominator, and includes the binary strict episode outcome without turning it
into a pooled rate. Its footer is fixed to `360 registered opportunities across
6 calls`.

The renderer independently reproduces the public pair from the retained
evidence root and Gate D authority before it creates its output directory. A
caller-built JSON artifact—even one with internally consistent public
hashes—cannot reach the release visual writer. It refuses partial runs, schema
drift, tampered metrics or budget heads, active reservations, missing
denominators, symlinked inputs, and overwrites. No placeholder or fabricated
launch asset is produced before a completed evidence root exists.

## Claim boundary

The six-episode artifact is C3 descriptive development evidence. It may support
a precise statement such as “on this registered 60-opportunity development
scenario, HACC changed X/Y scored opportunities versus Native for model Z.”
It cannot support a broad “HACC improves voice agents” claim or a statistically
reliable provider comparison. That requires independent held-out templates and
the confirmatory LC4 protocol.

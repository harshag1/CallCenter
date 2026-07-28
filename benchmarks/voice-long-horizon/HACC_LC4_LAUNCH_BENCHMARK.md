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

Both arms receive provider-paired caller PCM and the same scenario information.
The Native arm retains normal provider memory and receives the full safe
context. HACC receives flow-conditioned plans, a bounded active tool frontier,
durable worker state, revision-bound authority, and repair policy. One
development pair per provider is useful mechanism evidence, not a provider
efficacy estimate.

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

The public JSON exposes exactly six provider/model/arm cells. Each cell carries
an exact numerator, denominator, and parts-per-million rate for only:

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

## Attrition and denominators

Once an episode session opens, it remains in the denominator. Every missing
scheduled opportunity is a failure, not missing-at-random data. An incomplete
or unscorable episode cannot achieve strict success. The public publisher is
stricter: it refuses output unless all six sessions opened and completed, all
360 effective listener observations replay, every authority artifact is
scorable, the budget ledger is terminal, and the complete evidence root
reproduces.

## Exact commands after the live run

The existing qualification and six-episode operator runbook produces the
evidence root. The benchmark scorer itself makes no provider calls:

```bash
cd web
npx tsx scripts/lc4-launch-benchmark.ts publish \
  --evidence-root /absolute/path/to/completed-evidence-root \
  --output-root /absolute/path/to/new-public-output-directory

npx tsx scripts/lc4-launch-benchmark.ts verify \
  --evidence-root /absolute/path/to/completed-evidence-root \
  --public-json /absolute/path/to/HACC_LC4_LAUNCH_BENCHMARK.json \
  --public-markdown /absolute/path/to/HACC_LC4_LAUNCH_BENCHMARK.md
```

The public artifact contains the six safe result cells, aggregate execution
counts, and immutable roots only. It excludes transcripts, PCM/audio, wire
payloads, local paths, credentials, signing-key identities, and the removed
heterogeneous aggregate bars. Publication fails unless all six cells complete
all 360 registered opportunities and every authority artifact is scoreable.

## Claim boundary

The six-episode artifact is C3 descriptive development evidence. It may support
a precise statement such as “on this registered 60-opportunity development
scenario, HACC changed X/Y scored opportunities versus Native for model Z.”
It cannot support a broad “HACC improves voice agents” claim or a statistically
reliable provider comparison. That requires independent held-out templates and
the confirmatory LC4 protocol.

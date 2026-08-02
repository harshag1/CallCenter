# Development caller corpus v2

This directory freezes the public, synthetic, CC0 development corpus used to
exercise HACC-Proof-v1's closed-loop caller. It is permanently
`confirmatory_eligible=false`; inspecting, changing, or running it cannot
produce evidence for a public superiority claim.

`manifest.json` contains 24 distinct development scenario units with unique
domains, seeds, facts, and explicit no-parent lineage. Eight are allocated to
each provider stratum, but that allocation is metadata only. All 24 openly
share the same eight-opportunity structural cluster, so any later analysis must
retain that dependency rather than pretending the common skeleton is 24
independent mechanisms. The scenario generator receives no provider, model,
arm, prompt, grant, private state, evaluator score, or outcome information.

Every template compiles to the same eight common opportunity IDs and contains:

- a delayed obligation;
- an interleaved goal detour;
- a correction delivered by barge-in;
- a forbidden action and asynchronous worker launch;
- a cold reconnect;
- an ambiguous effect requiring reconciliation;
- an asynchronous result check; and
- a terminal recall and obligation probe.

The runtime projects its selection input down to caller-played semantic
observations and the two declared world keys `ambiguous_effect_status` and
`async_result_status`. Unknown fields are discarded. Each projection is bound
to separate audibility and world-ledger heads, its listener and world
projections are locally re-hashed, and the resulting observation receipt is
signed by a distinct Ed25519 authority before selection. Independent evidence
replay must still reopen and verify those referenced ledger heads; their signed
digests are provenance and substitution controls, not proof that an in-process
signer reported external reality honestly.

Selection and caller-fact entries are independently hash-chained and their
terminal ledgers are signed with a caller-run Ed25519 authority. The private
signing keys are supplied at runtime and are never stored in this corpus.

The source manifest and compiled corpus have separate domain-separated SHA-256
commitments. Any intentional corpus change requires a new version and updated
commitment; it must not silently replace this inspected development fixture.

---
provider: anthropic-claude-code
model: fable
timestamp: "2026-07-17T01:54:31.107934+00:00"
question: "Hostile pre-canary review of the signed kernel-attestation trust boundary and the causal raw-versus-harness benchmark design."
context_files: []
total_cost_usd: 0.6514099999999999
advisory_only: true
unverified_peer_review: true
must_verify_claims: true
public_summary: true
---

# External benchmark claim-architecture review

> This is a public summary of paid, unverified peer-review input. It is not repository, release, or benchmark evidence. Every retained finding must be verified against source and executable artifacts.

## Verdict

The review supported a tightly capped transport canary only after the artifact, identity, tool-call, replay, and wall-clock termination boundaries passed adversarial local tests. It rejected using a transport smoke as model-performance evidence.

The strongest scientific objection was that a conjunctive endpoint containing runtime-enforced safety properties can favor the harness by construction. The resulting benchmark therefore separates:

- task completion;
- model integrity, including illegal attempts and stale or skipped requirements; and
- system integrity, including containment of unauthorized, duplicate, or unverified effects.

A containment gain cannot be described as reduced model drift. Model or framework superiority requires paired provider evidence on the model-dependent endpoints.

## Findings that governed the canary gate

The review required the release to prove or fail closed on:

1. complete signing, parsing, and verification of every declared attestation field;
2. conflicting, reused, and malformed provider tool-call identities;
3. the exact compiler-produced common gateway schema on every provider;
4. a structural distinction between requested, provider-acknowledged, mismatched, and unverifiable session settings;
5. a verifier-chosen per-trial binding that prevents cross-run attestation replay;
6. deterministic replay of public event, receipt, world, and transcript evidence;
7. a provider-independent wall-clock kill and a retained failed-run artifact; and
8. a hard spend reservation before credential access or provider construction.

These were falsification requirements, not evidence that the implementation had already met them at the time of review.

## Trust-boundary conclusion

An in-process Ed25519 signature proves provenance and detects later mutation or substitution relative to the pinned key and expectation. It does not prove that the in-process kernel described private state honestly. Public claims must therefore distinguish:

- signed provenance and binding;
- independently replayable public truth; and
- private implementation facts that remain tied to the frozen source and tests.

Anything neither replayable nor provider-acknowledged remains labeled `unverifiable`.

## Causal-design requirements

Before any confirmatory effectiveness study, the review required:

- endpoint decomposition so treatment-enforced containment is not mislabeled model improvement;
- a preregistered rule that retains and scores disconnects, timeouts, crashes, and missing attestations;
- an explicit caller policy and the confound it accepts;
- arm-neutral turn and wall-clock limits;
- frozen provider/model/voice/audio/world/tool/prompt hashes; and
- paired, true-audio trials with null and adverse outcomes retained.

## Progressive tests recommended by the review

1. Mutate every attestation field and require verification failure.
2. Re-present an authentic artifact under another run expectation and require failure.
3. Fuzz canonicalization and strict parsing.
4. Inject duplicate, conflicting, delayed, and malformed call identities.
5. Replay one seeded offline trial from its recorded public evidence and compare digests.
6. Fixture missing and mismatched provider acknowledgements.
7. Exercise a provider that never responds and prove bounded termination plus retained evidence.
8. Seal a no-spend proof packet before any provider socket opens.
9. Run only per-provider capped compatibility canaries.
10. Run paired exploratory model trials only after the endpoint and attrition rules are frozen.

## Public claim boundary

A successful canary can establish that a pinned provider transport accepted input audio, returned output audio, completed the common gateway round trip, and produced a verifiable artifact under the recorded conditions. It cannot establish that the framework makes a model more reliable, safer, less forgetful, or less prone to drift.

# ToolWorld causal-containment fixed development experiment

Status: **fixed deterministic development design; outcomes observed; not a prospective preregistration or provider run**.

This experiment asks one bounded question: when an at-least-once tool transport produces replay, post-commit retry, reconnect redelivery, stale-state grafting, or ledger reordering, does ToolWorld contain the causal failure that a schema-only naive kernel accepts or executes?

It makes no provider calls and makes no claim about model intelligence, instruction following, speech quality, latency, or production incident frequency.

## Frozen design

- Benchmark version: `tool-world-causal-containment.v1`.
- Seeds: 7,301 through 7,332 inclusive.
- Schedule families: five.
- Trials: 32 per family, 160 total.
- Exclusions: none. Any thrown trial aborts artifact generation instead of being dropped.
- Naive-comparator endpoint: schema-only persisted-state acceptance plus at-least-once mutation execution. It is intentionally naive and is **not** a raw provider voice agent.
- Harness endpoint: ToolWorld v2 scenario-bound replay verification and idempotent execution.
- Interval: two-sided 95% Wilson score interval, reported descriptively across the fixed deterministic schedules.

The seeded values vary credit amounts, retry turn gaps, semantic operation ids, and the adjacent event pair selected for reordering. They do not vary the pass criterion.
The canonical range is marked `fixed-development-design`. Runs with any other seed range are marked `exploratory-variant` and are not part of the checked artifact.

## Fixed invariants

Every full-harness trial must satisfy all applicable invariants:

1. One semantic mutation produces exactly one authoritative effect.
2. Exact invocation replay produces no second authoritative effect.
3. A distinct-invocation retry after a post-commit timeout reconciles to the prior committed receipt.
4. Reconnect serialization preserves exact replay identity.
5. A stale fact snapshot grafted onto a newer ledger is rejected before execution.
6. A reordered event ledger is rejected before execution.
7. After corrupted persisted state is rejected, continuing from the last canonical state reaches the oracle total.

The fixed success rule is 160/160 contained full-harness trials, while the schema-only naive endpoint accepts or executes the unsafe schedule in 160/160 trials. This threshold is deliberately exact because each schedule is a deterministic contract test, not a noisy provider observation. It was not prospectively registered before outcomes were observed, so it is development evidence only.

## Reproduction

```bash
cd web
npx tsx scripts/tool-world-causal-containment.ts \
  --seed-start 7301 \
  --seeds-per-case 32

npx tsx scripts/tool-world-causal-containment.ts --check
npx vitest run lib/benchmark/__tests__/tool-world-causal-containment.test.ts
```

The checked JSON artifact is `tool-world-causal-containment.v1.json` (file SHA-256 `d17b59e6bbbbba1645da56ff4068cea689e4d5063e1df5ba2c93f89aae50bac4`). Its result hash is `f1969525a34e2144aa7487ba6e639aaab9e38f1149733d05817dfe42657fceab`; its trial-set hash is `d1ac1e90e5701109e0eece6a98256baa7068c642d5b718293f3ac9ff5be0e09d`. These bind the aggregate counts to the exact generated schedule outcomes. The test regenerates the report twice and requires semantic equality with the checked artifact, while `--check` requires byte-for-byte equality.

## Source and Git provenance

`tool-world-causal-containment.v1.provenance.json` (file SHA-256 `a01027b9ec8c51ad0d1775adfa0f9444d8f037bb4d0707e6a0095738a24480a1`) binds the checked artifact to the exact bytes of the experiment, ToolWorld, world-event, and scenario-schema sources. Its binding SHA-256 is `bc9e9a78fed8e4ebe02629bc00f5cd7518d902a1c65f510673d763ca6f7b450f`.

The provenance capture started from clean commit `22f3f5c9e4eb1712b65fd8046d24c42e1a2c31cd` and tree `40f8575f61dbb62767e4a2a7db456cecf9c3a03e`. All four bound source files match their base blobs exactly; current per-file SHA-256 values and byte lengths bind the tested implementation.

The verifier recomputes the artifact identity, manifest binding, source byte hashes, base commit/tree, base blob identities, and each file's relation to the base. The focused test substitutes bytes into every bound source path in turn and requires all four substitutions to fail verification.

## Interpretation boundary

A contained schedule means the deterministic execution boundary suppressed a duplicate effect or rejected a causally inconsistent resume and then safely continued from canonical state. It does not mean a realtime model will choose the right tool, notice a conversational correction, or behave reliably over a long call. Those questions require paired provider runs with fixed audio, model, voice, and world conditions.

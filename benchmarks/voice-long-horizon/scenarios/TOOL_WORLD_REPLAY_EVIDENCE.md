# ToolWorld strict-replay evidence

Status: **deterministic local engineering evidence, not a provider run or model-performance result.**

Snapshot date: 2026-07-16 (America/Los_Angeles)

## Evidence target

The benchmark replayed the declared oracle for `field-service-escalation.long-horizon.confirmatory120.v1`, then verified the fully populated state through `parseBoundToolWorldState`. This fixture is classified `offline-stress-only`; the measurement demonstrates local replay integrity and cost, not confirmatory eligibility.

The endpoint contained:

| Artifact | Value |
| --- | ---: |
| Caller turns | 120 |
| Tool receipts | 16 |
| Authoritative effects | 37 |
| Bound events | 200 |
| Serialized state | 204,489 bytes |
| Serialized state SHA-256 | `3dd561a557c62dcb3e96e3dd180f65f45b727248c18b2185a319055df2f5ecaf` |

The oracle reached `task_success=true`; all 16 observed receipt statuses matched the declared oracle route, and zero declared success or safety assertions failed.

## Replay timing

Environment: MacBook Pro `Mac16,5`, Apple M4 Max (16 cores), 48 GB RAM, macOS arm64, Node.js v24.8.0. Each path received 30 warm-up iterations followed by 500 sequential measurements using `performance.now()`. No filesystem or provider I/O occurred inside a timed sample.

| Path | p50 | p95 | p99 | max | mean |
| --- | ---: | ---: | ---: | ---: | ---: |
| Verify already-parsed state | 4.351 ms | 5.147 ms | 5.931 ms | 6.405 ms | 4.434 ms |
| JSON parse plus strict recovery | 4.712 ms | 5.406 ms | 5.963 ms | 6.956 ms | 4.781 ms |

The strict verifier checks scenario/state binding, event and receipt lineage, effect provenance, fault/admission ordering, duplicate lineage, canonical identifiers, and mirror-array order. The JSON-recovery path includes `JSON.parse` before the same checks.

## Reproducibility bindings

| Source/artifact | SHA-256 |
| --- | --- |
| `web/lib/benchmark/tool-world.ts` | `470514ea4566b33277bb0d31c493327a9cc042d71556b93f6508a3c9d1081c0b` |
| `web/lib/benchmark/world-events.ts` | `2d05fd2295e91f70ca6c95824daa7030c256a4f0a21d118917309d2b60ab82f4` |
| `web/lib/benchmark/scenario-schema.ts` | `e632b2a865ffc6668da11c6f1973fae80592b69916d1bbd1db77c7ac0708d913` |
| `web/lib/benchmark/long-horizon-field-escalation.ts` | `5ebe26a62b21fd85cdee5f2bdb71a9188c226e443e3838342337b36f8b82415d` |
| `web/lib/benchmark/long-horizon-scenario-suite.ts` | `2aff3bbb18d1cf4ac0a91724c31a46a5b401790b215dd448711a317ec3df7cb4` |
| Canonical field-service 120 scenario artifact | `86736a39e5146dfd41a4eb477a937b81c0fc35c4e2fe399aa6b72d4b412c122d` |
| Generated long-horizon manifest (5,153 bytes) | `73a848acac6dacf2bff2700a49594a13deb01c6f941bcadcc72187dca33baf72` |

The manifest rendered to the same SHA-256 twice in the measurement process and once in a fresh Node process. `generate-long-horizon-manifest.ts --check` also passed.

## Deterministic causal-containment sensitivity

A separate bounded development experiment exercised five seeded at-least-once/persistence failure families over 32 seeds each: exact replay, retry after an ambiguous post-commit timeout, reconnect redelivery, a stale-fact snapshot grafted onto a newer ledger, and reordered ledger events. The deliberately naive comparator was a schema-only persisted-state check plus at-least-once mutation application; it was not a raw model or provider agent.

Across the fixed 160 schedules, the naive comparator accepted or executed the unsafe schedule in 160/160 trials. ToolWorld contained 160/160: 96 duplicate/replay suppressions and 64 corrupt-state rejections followed by continuation from canonical state. The descriptive two-sided Wilson 95% interval for 160/160 is [0.976554, 1.000000], and each 32/32 family interval is [0.892821, 1.000000]. These are deterministic contract schedules, not population samples.

Bindings:

| Causal artifact | SHA-256 |
| --- | --- |
| Checked JSON file | `d17b59e6bbbbba1645da56ff4068cea689e4d5063e1df5ba2c93f89aae50bac4` |
| Trial set | `d1ac1e90e5701109e0eece6a98256baa7068c642d5b718293f3ac9ff5be0e09d` |
| Result | `f1969525a34e2144aa7487ba6e639aaab9e38f1149733d05817dfe42657fceab` |
| Experiment implementation | `8564f3708014fd5b87170b03b575b597dc569c8dd2eff4cbda312c8031242ee3` |
| Source/Git provenance manifest | `5a54c8534eb1bb74440ee6085d1a19393db22a6c3539a31bf3dd1b6237d8b37d` |
| Provenance binding | `8bdcfdf9b54bc6b8a2b7523b9e457c081c2fef14daa10398fd083985d0f090b9` |

The focused test regenerates the report twice and requires semantic equality with the checked artifact. An independent 25-run reproducibility check produced one byte-identical JSON SHA-256 across all 25 generations. It also verifies the clean provenance envelope against base commit `c965fb7d04fd580db8034d745bbd4bb34aebfa6f` and tree `8a560886d2d044b35b706e048585fdfbc1dd7576`, then demonstrates that byte substitution in each of the four bound source paths fails verification. The full protocol and interpretation boundary are in `TOOL_WORLD_CAUSAL_CONTAINMENT_PROTOCOL.md`.

## Interpretation limits

- These timings are machine-specific local microbenchmarks. They do not include realtime transport, provider latency, speech synthesis/recognition, tool-network I/O, or cold process startup.
- Deterministic oracle satisfiability does not establish that a model can follow the scenario, that the harness improves a model, or that a generated response was audibly played.
- Scripted reconnect turns do not exercise an actual socket disconnect/resume path. Reconnect evidence remains a provider-run requirement.
- ToolWorld cannot grade spoken privacy leakage, diagnosis, medication advice, or fabricated audible confirmation; transcript/audio graders must do that separately.
- Direct ToolWorld parsing now enforces explicit depth, node, array, object-key, per-string, and aggregate-string limits before recursive schema work. The bounded causal experiment covers five targeted replay/persistence schedule families; broad generative fuzzing, arbitrary event permutations, concurrency interleavings, and provider behavior remain separate hardening tracks.

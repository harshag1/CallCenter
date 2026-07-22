# Long-horizon template manifest

Status: **fixture validation only; no provider runs and no model-performance results.** This file is rendered deterministically from the current parsed sources by `web/scripts/generate-long-horizon-manifest.ts`. Run it with `--check` after any scenario, schema, compiler, Flow, or ToolWorld change and before freezing a paid execution plan.

Artifact hashes below are lowercase SHA-256 of canonical JSON (`sha256Hex(canonicalJson(value))`). They are artifact inventory hashes, distinct from each object’s domain-separated internal binding hash.

| Family | Turns | Tools | Oracle calls | Receipts / effects / events | Scenario artifact SHA-256 | Compiled-suite artifact SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Travel disruption | 32 | 13 | 15 | 15 / 34 / 184 | `8414b7dae384be786c8e898077dd3e6c53ada08f1003e04aa1ae87527f393481` | `807ae8b1f72cfe414691b7454f9e051943f1858995f29ee4a9c9690eaee96636` |
| Travel disruption | 64 | 13 | 15 | 15 / 34 / 184 | `3ffadfae67fb54e3c4c53f4871db2204572451ba4b1c670d87d82e9a53e01ddf` | `5f8745d5be10e1a0d76c06a04413ce5e343de67669a1ef07887f8b51744d5174` |
| Travel disruption | 120 | 13 | 15 | 15 / 34 / 184 | `c4b893e39f431a4fc6438fec392eeca5c98ce82941f82c8a7fabc969aea932dd` | `ade158fb0e793f45bf2a5bbb9c4dbee566fe6a6045c3289f65642a5419d7cea3` |
| Home-health coordination | 32 | 17 | 18 | 18 / 33 / 200 | `ae1cfab74806def68f2ceb86fd83230c9bf07af9429eceed54376a90379d1e3c` | `7055ed006a6f5740c641d054905b1fb6eb53468715d6afd67afd2579a2d9d7cf` |
| Home-health coordination | 64 | 17 | 18 | 18 / 33 / 200 | `2ca3ac087464b6cde0d2b9dd91ce8538faa7e683b9d4ebf4a579f7033386ff94` | `c3301f99f6ef21b10b0a9c525034dd23104141db57692048af9eff585a7f0165` |
| Home-health coordination | 120 | 17 | 18 | 18 / 33 / 200 | `066c6d6d9c003afeca447a81839a179ddb1076b0a0b37961e175d3ebc9a08b54` | `936b97df410dd378d0ba5f68922a53d1fbb4e0e74af59f6754ccda5d63febc9f` |
| Field-service escalation | 32 | 15 | 16 | 16 / 37 / 200 | `ab8ca22b99ca362139465bb780feb4a8e65f8b083ae58211a74f99b6fe36b2ce` | `410d0ec334a5de4059da2d7d47ca76dca5dfb9055a30c6a262ef57c3f85317ca` |
| Field-service escalation | 64 | 15 | 16 | 16 / 37 / 200 | `90ad4ccef3423540b40f0629b951f932c386d46509108891f114f907ebdd0710` | `a86c87240c67821f6130d762577e78ba0b56c9688d0dec809d64807026303090` |
| Field-service escalation | 120 | 15 | 16 | 16 / 37 / 200 | `86736a39e5146dfd41a4eb477a937b81c0fc35c4e2fe399aa6b72d4b412c122d` | `78afe6e1b60ec641dfa18b296f3501c6c5e29d43b65cac6e1b8de57f6e276a42` |

Semantic leaf-tool hashes are intentionally stable across 32/64/120 within each family:

- Travel disruption: `a2faeabb11186244ee258db9f06a91ba7aa8dd66070dbc99c4b8cbcd6233500e`
- Home-health coordination: `f97efd852c952962cf64ce66a6d490ba6d4bb741185f2a9c9085382befab7a89`
- Field-service escalation: `2a3a03644f1988acab90c663a07d23a56a68ecc9946191a79e09f338cefbcc7b`

Confirmatory realism gates require unique-utterance ratio ≥ 0.80 and 64-turn development-overlap ratio ≤ 0.25. These metrics are structural release gates, not model results:

| Family | Turns | Unique utterances | Unique ratio | 64-turn overlap turns | Overlap ratio | Execution eligibility | Confirmatory realism gate |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Travel disruption | 32 | 32 | 1.0000 | 32 | 1.0000 | development-provider-eligible | fail |
| Travel disruption | 64 | 64 | 1.0000 | 64 | 1.0000 | development-provider-eligible | fail |
| Travel disruption | 120 | 113 | 0.9417 | 71 | 0.5917 | offline-stress-only | fail |
| Home-health coordination | 32 | 26 | 0.8125 | 32 | 1.0000 | development-provider-eligible | fail |
| Home-health coordination | 64 | 28 | 0.4375 | 64 | 1.0000 | development-provider-eligible | fail |
| Home-health coordination | 120 | 29 | 0.2417 | 24 | 0.2000 | offline-stress-only | fail |
| Field-service escalation | 32 | 32 | 1.0000 | 32 | 1.0000 | development-provider-eligible | fail |
| Field-service escalation | 64 | 64 | 1.0000 | 64 | 1.0000 | development-provider-eligible | fail |
| Field-service escalation | 120 | 120 | 1.0000 | 24 | 0.2000 | offline-stress-only | fail |

The generator replayed 147 oracle calls into 147 receipts, 312 authoritative effects, and 1752 bound events across all nine fixtures. Every expected receipt status matched; every oracle reached `task_success=true` with zero failed declared assertions; and every seven-arm parity audit passed. This proves only that the synthetic fixtures have coherent safe paths. It says nothing about model or harness performance.

The 32- and 64-turn variants are development fixtures and still require actual ordered frozen PCM bytes plus a session-feasibility envelope before provider execution; the authorization helper derives the audio binding and duration instead of accepting claims. The current 120-turn variants are classified `offline-stress-only`: they remain useful for deterministic local retention testing, but their uniqueness/overlap realism gate is red and `authorizeLongHorizonTemplateRun` refuses provider or confirmatory scheduling. A newly versioned, frozen scenario set is required before any C4/C5 claim.

# Long-horizon template manifest

Status: **fixture validation only; no provider runs and no model-performance results.** This file is rendered deterministically from the current parsed sources by `web/scripts/generate-long-horizon-manifest.ts`. Run it with `--check` after any scenario, schema, compiler, Flow, or ToolWorld change and before freezing a paid execution plan.

Artifact hashes below are lowercase SHA-256 of canonical JSON (`sha256Hex(canonicalJson(value))`). They are artifact inventory hashes, distinct from each object’s domain-separated internal binding hash.

| Family | Turns | Tools | Oracle calls | Receipts / effects / events | Scenario artifact SHA-256 | Compiled-suite artifact SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Travel disruption | 32 | 13 | 15 | 15 / 34 / 184 | `8414b7dae384be786c8e898077dd3e6c53ada08f1003e04aa1ae87527f393481` | `e8542c7b2633fc0a4b13eb5116f5bee9c184f71a32bd0511adbbdf7895a80130` |
| Travel disruption | 64 | 13 | 15 | 15 / 34 / 184 | `3ffadfae67fb54e3c4c53f4871db2204572451ba4b1c670d87d82e9a53e01ddf` | `4f157bb811c7615d3b06a22a6c5e64e044c83f43af655c3c26bc83d6b9d8adae` |
| Travel disruption | 120 | 13 | 15 | 15 / 34 / 184 | `c4b893e39f431a4fc6438fec392eeca5c98ce82941f82c8a7fabc969aea932dd` | `899d6ae4b4487df22057725f42c8bbcc599f9d4d84a6f964402a1fb359dd972c` |
| Home-health coordination | 32 | 17 | 18 | 18 / 33 / 200 | `ae1cfab74806def68f2ceb86fd83230c9bf07af9429eceed54376a90379d1e3c` | `20d4707c0afd524743888de6bbd4a88deadba524d15fd1c42d52afa37f24c000` |
| Home-health coordination | 64 | 17 | 18 | 18 / 33 / 200 | `2ca3ac087464b6cde0d2b9dd91ce8538faa7e683b9d4ebf4a579f7033386ff94` | `c12cd8e1388e62c1dc1eb73a896ea883d494985e9a7a1e7388a7d3e36f42de48` |
| Home-health coordination | 120 | 17 | 18 | 18 / 33 / 200 | `066c6d6d9c003afeca447a81839a179ddb1076b0a0b37961e175d3ebc9a08b54` | `321bb24bd583313118b14c875585f67c949e997b6d107d8a2a8218bb8d734b31` |
| Field-service escalation | 32 | 15 | 16 | 16 / 37 / 200 | `ab8ca22b99ca362139465bb780feb4a8e65f8b083ae58211a74f99b6fe36b2ce` | `c0dd173a0278459675bfcfaec6978e8669d3171fe0141e9af30369c5c4d1d1df` |
| Field-service escalation | 64 | 15 | 16 | 16 / 37 / 200 | `90ad4ccef3423540b40f0629b951f932c386d46509108891f114f907ebdd0710` | `d081d5ceaa33b19698ed14e9536a445023dbd95f5fcbc391768492aaaeecc888` |
| Field-service escalation | 120 | 15 | 16 | 16 / 37 / 200 | `86736a39e5146dfd41a4eb477a937b81c0fc35c4e2fe399aa6b72d4b412c122d` | `563219a998167c611eff34e122b3f6f6eb40094e428bab57f68f1cf1a34cbe87` |

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

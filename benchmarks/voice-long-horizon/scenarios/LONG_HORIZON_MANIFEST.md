# Long-horizon template manifest

Status: **fixture validation only; no provider runs and no model-performance results.** This file is rendered deterministically from the current parsed sources by `web/scripts/generate-long-horizon-manifest.ts`. Run it with `--check` after any scenario, schema, compiler, Flow, or ToolWorld change and before freezing a paid execution plan.

Artifact hashes below are lowercase SHA-256 of canonical JSON (`sha256Hex(canonicalJson(value))`). They are artifact inventory hashes, distinct from each object’s domain-separated internal binding hash.

| Family | Turns | Tools | Oracle calls | Receipts / effects / events | Scenario artifact SHA-256 | Compiled-suite artifact SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Travel disruption | 32 | 13 | 15 | 15 / 34 / 184 | `8414b7dae384be786c8e898077dd3e6c53ada08f1003e04aa1ae87527f393481` | `9ef026914f23f566481c62ea6515f96c564245211fd81b84f16fb379cc8ec8ec` |
| Travel disruption | 64 | 13 | 15 | 15 / 34 / 184 | `3ffadfae67fb54e3c4c53f4871db2204572451ba4b1c670d87d82e9a53e01ddf` | `c56e2bb39707ec94c095b1ca0babb8eb682938cf700ee012ed6d60fabc1aa6a7` |
| Travel disruption | 120 | 13 | 15 | 15 / 34 / 184 | `c4b893e39f431a4fc6438fec392eeca5c98ce82941f82c8a7fabc969aea932dd` | `a7184958efafd8656373eeda7072b81fec8bbc7094c9ec94a26798dd2a26571f` |
| Home-health coordination | 32 | 17 | 18 | 18 / 33 / 200 | `ae1cfab74806def68f2ceb86fd83230c9bf07af9429eceed54376a90379d1e3c` | `2f7007708b5a35a3a94efed7eb751d0a95f493155e336c2b51579b83fae6fb57` |
| Home-health coordination | 64 | 17 | 18 | 18 / 33 / 200 | `2ca3ac087464b6cde0d2b9dd91ce8538faa7e683b9d4ebf4a579f7033386ff94` | `d348e447d0c77145a6891c74cfb1b613ac48f588147c61aabc40f321dbc15bed` |
| Home-health coordination | 120 | 17 | 18 | 18 / 33 / 200 | `066c6d6d9c003afeca447a81839a179ddb1076b0a0b37961e175d3ebc9a08b54` | `8d5736ee19594dcfca3682a0736da248a7e03b91fa2647c2bdc99bf4c13423e3` |
| Field-service escalation | 32 | 15 | 16 | 16 / 37 / 200 | `ab8ca22b99ca362139465bb780feb4a8e65f8b083ae58211a74f99b6fe36b2ce` | `b059ce4cd16eaf18517e93034a2f4fce5ecf73d1b4d4d7bf2d727bb123701c1a` |
| Field-service escalation | 64 | 15 | 16 | 16 / 37 / 200 | `90ad4ccef3423540b40f0629b951f932c386d46509108891f114f907ebdd0710` | `6fa46b856c25fa27e98b3da06b84a429fb76fbdae83f9844ff24edf3c0ebd812` |
| Field-service escalation | 120 | 15 | 16 | 16 / 37 / 200 | `86736a39e5146dfd41a4eb477a937b81c0fc35c4e2fe399aa6b72d4b412c122d` | `e5eff9f7873261c640ee064bf6ef62ff6b09a3e9ff156ce7097705ac548b8f52` |

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

The generator replayed 147 oracle calls into 147 receipts, 312 authoritative effects, and 1752 bound events across all nine fixtures. Every expected receipt status matched; every oracle reached `task_success=true` with zero failed declared assertions; and every six-arm parity audit passed. This proves only that the synthetic fixtures have coherent safe paths. It says nothing about model or harness performance.

The 32- and 64-turn variants are development fixtures and still require actual ordered frozen PCM bytes plus a session-feasibility envelope before provider execution; the authorization helper derives the audio binding and duration instead of accepting claims. The current 120-turn variants are classified `offline-stress-only`: they remain useful for deterministic local retention testing, but their uniqueness/overlap realism gate is red and `authorizeLongHorizonTemplateRun` refuses provider or confirmatory scheduling. A newly versioned, frozen scenario set is required before any C4/C5 claim.

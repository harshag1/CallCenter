# Long-horizon template manifest

Status: **fixture validation only; no provider runs and no model-performance results.** This file is rendered deterministically from the current parsed sources by `web/scripts/generate-long-horizon-manifest.ts`. Run it with `--check` after any scenario, schema, compiler, Flow, or ToolWorld change and before freezing a paid execution plan.

Artifact hashes below are lowercase SHA-256 of canonical JSON (`sha256Hex(canonicalJson(value))`). They are artifact inventory hashes, distinct from each object’s domain-separated internal binding hash.

| Family | Turns | Tools | Oracle calls | Receipts / effects / events | Scenario artifact SHA-256 | Compiled-suite artifact SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Travel disruption | 32 | 13 | 15 | 15 / 34 / 184 | `8414b7dae384be786c8e898077dd3e6c53ada08f1003e04aa1ae87527f393481` | `5faee7cbc1be6f01bb5608cfc13210e54a19dfd8b5ea3f43982df4da5b914707` |
| Travel disruption | 64 | 13 | 15 | 15 / 34 / 184 | `3ffadfae67fb54e3c4c53f4871db2204572451ba4b1c670d87d82e9a53e01ddf` | `3a67f0878d582b296d409429cf89da0947f8d8bd02c7632c45ccee841f04f673` |
| Travel disruption | 120 | 13 | 15 | 15 / 34 / 184 | `c4b893e39f431a4fc6438fec392eeca5c98ce82941f82c8a7fabc969aea932dd` | `e80e6cd8ddaa53b17c3b58106939a28fcef7cd1679598b1802704460fe7475a0` |
| Home-health coordination | 32 | 17 | 18 | 18 / 33 / 200 | `ae1cfab74806def68f2ceb86fd83230c9bf07af9429eceed54376a90379d1e3c` | `abdc28ecb767f2fca3f2c4fc528a03b7c83c86c7d8263e48ff3eaae6b09d020c` |
| Home-health coordination | 64 | 17 | 18 | 18 / 33 / 200 | `2ca3ac087464b6cde0d2b9dd91ce8538faa7e683b9d4ebf4a579f7033386ff94` | `05604c61b9e0faa96bbe0d8ef931ea5987c2a57267b9b5fda66102c03c887135` |
| Home-health coordination | 120 | 17 | 18 | 18 / 33 / 200 | `066c6d6d9c003afeca447a81839a179ddb1076b0a0b37961e175d3ebc9a08b54` | `a56920462c50c8b623eaf0555941776231240fbea6bb99d2571f0c07299e24a9` |
| Field-service escalation | 32 | 15 | 16 | 16 / 37 / 200 | `ab8ca22b99ca362139465bb780feb4a8e65f8b083ae58211a74f99b6fe36b2ce` | `824f24b30ca0c1510481ec2a020bf43435f5360490378fe5f501c7a493459e6e` |
| Field-service escalation | 64 | 15 | 16 | 16 / 37 / 200 | `90ad4ccef3423540b40f0629b951f932c386d46509108891f114f907ebdd0710` | `e5daeb51a82b7fc8b35fa32f5cc469786707eade839344ab4a92104bea20fd38` |
| Field-service escalation | 120 | 15 | 16 | 16 / 37 / 200 | `86736a39e5146dfd41a4eb477a937b81c0fc35c4e2fe399aa6b72d4b412c122d` | `3f5871e5ffea52ade97819d809ec9beb80889f3bcbe41f08ddc036d0896a5989` |

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

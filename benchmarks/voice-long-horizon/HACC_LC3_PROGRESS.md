# HACC-LC3-v1 execution log

## 2026-07-21 — protocol frozen before outcome access

- Chose three existing, independently authored 20-turn development tasks instead of reusing the prior open-loop 32-turn null batch.
- Chose a strong `raw-memory` comparator instead of an intentionally weak context dump.
- Fixed 54 episodes and 1,080 primary caller opportunities across three exact provider models, three task families, three caller voices, and two paired conditions.
- Fixed one conjunctive whole-call endpoint and separate model-integrity/system-containment diagnostics.
- Fixed AB/BA adjacent-pair execution, no outcome retries, missing-evidence failure, and operational/provider-failure separation.
- OpenAI `gpt-realtime-2.1` accepted a live no-audio session configuration probe on the currently configured key.
- A separate credential audit located an authorized Gemini key without exposing it; xAI and OpenAI credentials remain configured locally.
- No HACC-LC3-v1 paid episode has opened. Provider results: unavailable.

Next gates:

1. implement and test the frozen runner and scorer;
2. pin and calibrate independent output-audio ASR;
3. freeze fixtures, schedule, source tree, signer, and aggregate budget ledger;
4. run one true-audio diagnostic pair per provider;
5. if transport/evidence gates pass, execute the remaining schedule once;
6. replay aggregates and create the graph only from completed immutable artifacts.

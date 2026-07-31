# OpenAI gateway tool-choice diagnostic — 2026-07-22

Status: **diagnostic only**. This is not a qualification result, efficacy result, benchmark score, or launch claim.

## Question

Does OpenAI `gpt-realtime-2.1` produce the required HACC capability-gateway call when the initial `response.create.tool_choice` is either:

1. `"required"`; or
2. `{ "type": "function", "name": "capability_gateway" }`?

Everything else was frozen: source tree, session, instructions, tool schema, compact control, 20 ms real-time packetizer, 1.672083 s Samantha PCM, commit acknowledgement requirement, expected target tool, and expected arguments.

## Preregistered execution boundary

- Source commit: `ff80d51bbebd82d0f89940e083908794df4acfdf`
- Source tree: `67126f27fa2282bac18a5b8337e6b1017238e7f8`
- Model: `gpt-realtime-2.1`
- Sessions: exactly 2
- Paid retries: 0
- Maximum authorization: $1.00
- Observed estimated cost: $0.006416
- PCM SHA-256: `74bd4462f453aac22ee0433efe98a7b1f6a25e80ab55d7c3dd39f41e9b7e2953`
- Tool schema SHA-256: `93ae58d10081b5182075dd815c5e5ff027c67c8910df8ac2103973c4f279fad1`

## Provider-observed result

| Initial tool choice | Opened | Provider terminal | Gateway call | Target | Arguments | Usage | Estimated cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `required` | yes | `completed` | exactly 1 | `complete_current_stage` | `{}` | 560 tokens | $0.003208 |
| forced function | yes | `completed` | exactly 1 | `complete_current_stage` | `{}` | 560 tokens | $0.003208 |

Both sessions reported 16 input-audio, 518 input-text, 26 output-text, and 0 output-audio tokens. Both closed normally. No provider error or transport-failure diagnostic was observed.

The semantic target and arguments matched in both sessions:

- target tool hash: `14e31325ff517dea7bbfc070ecf011c9c56418866ee0b788b91a6f7960f0b4f3`
- target arguments hash: `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`

## Evidence identities

| Artifact | `required` | forced function |
| --- | --- | --- |
| Initial payload SHA-256 | `12116d3773fba4760683b4ccb0ddaece45b07b713f5996f65ffbebaebd18523a` | `94817fdc74c2e9e64c307173cca91e7b9dbc4936e691b84438537c02e110efda` |
| Wire observations | 111 | 111 |
| Wire-chain head | `ad7353f2a47d0ef144476a9348d4d0dc694892b515f5ecbfbafea1433ff61168` | `0baf1b694e9f058b474bef807156bd09d7e2b4f8f400566a92f4f79dc47ed0c0` |
| Execution evidence | `7e8c9afa076e589adcf35262de1a46351c0e88a0c7d5127d62c87c9d00eb3ab4` | `99fb9a620169bd7f6799e81c52accb38771ed9d2f00d926e0a54726610eab68f` |
| Signed-run result file | `3c2ddce7cb9f4cae8d76bb8bd40cf36713cc397033d2d91ccbb99117ebf1d3da` | `27217f6196f90a356eeeb8dee7b3b5d07956cfb314c18e36fa75b671eafcd17d` |

Signed root identities:

- authorization file: `71953daf44bce3836b7411c8f72ae2669191edd1a42d80989a49e60ec5518d7b`
- invocation file: `1663972b92129676c8869eda7f2c850a8f236c1ff966d8611d079793786f0470`
- terminal body: `ba73e0b63606cd24e1587eeab273f41ac6da012b6c9f90d0323a2d3a37849beb`
- terminal file: `3d185ac2b11f7613e28b91518780179c75cdd35cb3327fe07e9990cb2751feea`
- manifest file: `572bc898769f54ff7f6430cda0a3d6fff1ede506567f0a0ba1104ba1866c8b6c`
- budget ledger head: `2dc05f1cef9c9751e45b9bb44964a29895ecb4327944fa64d1acb592f7d9aad0`
- public-key fingerprint: `f8835eb526679d6d2193afc6d9e4f9151bc8b37895287e4ce9c2e803d6a23ada`

Independent offline verification passed for all four Ed25519 signatures, all eight CAS objects and receipts, the eight-entry budget hash chain, and both wire-observation chains.

## Harness finding

The signed v4 execution artifacts record `failed / wrong_tool`. That classification is a harness-evaluator failure, not a provider failure.

The OpenAI-compatible client correctly normalized each terminal provider call, admitted its provider-native IDs, and converted it to the single authoritative local `tool.dispatch` surface. The v4 S2S evaluator listened only for `tool.calls`, ignored the valid `tool.dispatch`, then classified the following `response.completed` event as call-free. It therefore never submitted the result or requested continuation.

The v5 fix:

- admits the production `tool.dispatch` representation while rechecking provider call/response provenance;
- preserves the single-dispatch boundary instead of re-emitting raw `tool.calls`;
- defers a call-free terminal decision for one normalization turn so same-frame siblings can be admitted;
- keeps malformed provenance, competing calls, and genuinely call-free completion fail-closed; and
- changes the roundtrip evidence and failure domains from v4 to v5.

No provider call was made to validate the fix. Regression coverage replays the terminal lifecycle offline, including both tool-choice variants, incremental-plus-terminal duplicates, completion-first ordering, malformed provenance, competing calls, and no-call completion.

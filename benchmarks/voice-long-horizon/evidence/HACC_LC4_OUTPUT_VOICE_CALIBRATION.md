# HACC-LC4 output-voice calibration development record

Date: 2026-07-21

Status: **evaluator calibration evidence; not HACC efficacy evidence**

This record retains the complete development trail used to make audible-semantic
scoring admissible for the exact provider/model/voice routes planned for the
next long-call benchmark. It does not compare Native with HACC and must not be
used in a public efficacy graph.

## Exact routes

| Provider | Model | Voice |
| --- | --- | --- |
| OpenAI | `gpt-realtime-2.1` | `marin` |
| Google | `gemini-3.1-flash-live-preview` | `Aoede` |
| xAI | `grok-voice-think-fast-1.0` | `ara` |

Every batch contained the same six corrected-identifier and numeric-limit
constructs per route: 18 real speech-to-speech outputs total. PCM, sanitized
wire observations, ordered chunk hashes, request/session evidence, and Ed25519
capture receipts were retained. Three prospective-development batches were
run, for 54 production output utterances total. There were no substitutions or
post-hoc transcript edits.

## Development failures retained

### Batch 1: isolated fragments

Manifest: `f2cbc1f8816c2bca1d39e3f3b6c5ae51712b0c8608387080007484d83deec132`\
Capture verification: `94ee7f89bf384864a895b526331f0d3a0af737383c68511af94b0554f71deb63`

The pinned `small.en` ASR produced 3/18 critical-slot false negatives at 4.17%
WER. A larger `medium.en-q5_0` model reduced this to 2/18; a pinned
`large-v3-turbo-q5_0` model reduced it to 1/18. The remaining error was OpenAI
`parts` transcribed as `karts`. This batch failed.

### Batch 2: natural sentence context

Manifest: `fab810de291f46826a96489b90931fe5cd75bca3574ca8889dfd6cc217c49fb7`\
Capture verification: `213459e00aadbe2c3e4abf8b2845a3baed1397fa682afbbdf009bf94cd0e978b`

One provider-neutral sentence wrapper was applied by slot kind: `The exact
limit is ...` or `The corrected identifier is ...`. Both `small.en` and
`large-v3-turbo-q5_0` then produced 1/18 false negatives at 1/144 word errors
for xAI: `CHEM` was transcribed as `keem`. This batch failed.

### Batch 3: contextual speech with spelled identifier prefixes

All multi-letter uppercase identifier prefixes were spelled as letters for
every provider (for example, `C H E M` and `H Y D`). This is a single
provider-neutral rule for machine-critical identifiers, not a provider-specific
exception.

Manifest: `63310807b42ee1ab7fdf11e4bffa084f040677f1e3d4bbefb623fade7d926d0e`\
Capture verification: `3d6f1b6490aeb30bbd621a7bdb7f4e041a9cc873899ea44c3224c59c9ddaf9ac`

The preregistered small ASR still produced one OpenAI `parts`/`carts` false
negative. The separately pinned larger local ASR passed all gates:

| Route | Fixtures | WER | Critical-slot FN | Semantic-slot FP |
| --- | ---: | ---: | ---: | ---: |
| OpenAI / `gpt-realtime-2.1` / `marin` | 6/6 | 0.00% | 0 | 0 |
| Gemini / `gemini-3.1-flash-live-preview` / `Aoede` | 6/6 | 0.00% | 0 | 0 |
| xAI / `grok-voice-think-fast-1.0` / `ara` | 6/6 | 0.00% | 0 | 0 |
| **Total** | **18/18** | **0/144 words (0.00%)** | **0/18** | **0** |

## Passing evidence pins

- Capture authority SHA-256: `4113980739a3869b2ffe59d9d1e68980e1feae36740b4fb83d9706ed1b17e120`
- Capture manifest SHA-256: `63310807b42ee1ab7fdf11e4bffa084f040677f1e3d4bbefb623fade7d926d0e`
- Capture verification SHA-256: `3d6f1b6490aeb30bbd621a7bdb7f4e041a9cc873899ea44c3224c59c9ddaf9ac`
- Whisper CLI SHA-256: `1fbabb51a45906bd36684695de9025eab63618a6eedc26971c47fa5affc5fe49`
- ASR model: `ggml-large-v3-turbo-q5_0`
- ASR model SHA-256: `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`
- Prepared ASR config SHA-256: `350dd7ba017a00adecb413a46eac986b8da4b9c8d5e889fbff5ff3a40acfc974`
- ASR batch finalization SHA-256: `ee6f50106eb0655c98b6f9699ecc07804aaa4070138e1dccbf9860fe5357dd8f`
- Receipt manifest SHA-256: `1820afa3b73209a86f85467e5a52ff39c9e81cc1cd96d25bdc5c97574d741c7e`
- Calibration artifact SHA-256: `5a40c0a29ed4719876a6613a9679e55bc94f8d6b50fe2862e1cbfb1f3477cda2`

The larger ASR model was selected during evaluator development after the
smaller pinned model exposed critical false negatives. This choice is therefore
not confirmatory. The exact passing toolchain and spoken-form rules must be
frozen before any held-out Native-versus-HACC call is opened.

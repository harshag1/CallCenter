# Pinned local whisper.cpp evidence adapter

HACC uses this adapter only to transcribe the audio that a benchmark condition actually generated. It is deliberately separate from every provider under test: it performs no network request, calls no provider API, discovers no executable from `PATH`, and downloads no model.

## Reproducibility contract

The caller supplies exact, absolute paths and expected SHA-256 hashes for `ffmpeg`, `whisper-cli`, and the model, plus the operator-observed whisper.cpp version and source revision. The adapter rejects symlinks, missing files, non-executable tools, hash mismatches, odd or empty PCM, process failures, timeouts, missing transcripts, invalid UTF-8, and artifacts that change during execution. The version is evidence, not an allowlist: a newer local build such as Homebrew 1.9.1 remains valid when its exact executable hash and source revision are preregistered.

Input is PCM16 little-endian, mono, 24 kHz—the realtime benchmark capture format. A pinned ffmpeg executable converts it to mono PCM16 16 kHz WAV with the fixed `bitexact-v1` argument profile. whisper.cpp receives the WAV through a direct `spawn` call with `shell: false`, temperature zero, prior-text conditioning disabled with `--max-context 0`, and explicit decoding parameters.

The canonical JSON receipt binds:

- the original source request, played-audio, and chunk-sequence hashes used by `audible-evidence.ts`;
- input PCM bytes and sample count;
- ffmpeg binary, conversion argv, and converted WAV;
- whisper.cpp source revision, executable, model revision, and model weights;
- inference argv, stdout, stderr, runtime, raw transcript, and normalized result.

The normalized `result` deliberately follows the completed independent-ASR result shape. This lane supplies provenance; it does not by itself make a benchmark claim. A held-out ASR calibration and the signed audible-evidence verifier remain required before transcript-derived scores become claim-eligible.

## Recommended pin for the first English benchmark

- whisper.cpp release `v1.8.6`, commit `23ee03506a91ac3d3f0071b40e66a430eebdfa1d`.
- Official `ggerganov/whisper.cpp` model `ggml-small.en.bin`, SHA-256 `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d` (487,614,201 bytes).

`small.en` is the recommended evaluator model because the benchmark is English and evaluation accuracy matters more than minimum download size. The executable itself is build-dependent, so its SHA-256 must be computed from the exact release build used by the runner and preregistered alongside the ffmpeg binary hash.

## Invocation

Run with `tsx scripts/long-call-asr.ts` from `web/`. All paths must be absolute. The command requires pins for the three binaries/artifacts, source request and chunk-sequence hashes, run/unit/invocation IDs, language, and an unused output path. It prints only the completed receipt hash; the canonical JSON receipt is written with exclusive creation so prior evidence cannot be overwritten.

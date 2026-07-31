# Real-ASR environment qualification

The two real-ASR integration suites are intentionally not ordinary hosted-CI
tests. They require a pinned `whisper.cpp` executable, the 488 MB model
weights, ffmpeg, retained caller/output PCM, a signed calibration artifact, and
its local signing key. Those assets are not checked into the public repository,
and their locations are never assumed.

This is an environment-qualified release gate, not a silent skip:

- normal CI inventories both suites and fails if their source, condition,
  disposition, or count drifts;
- the public database job runs every separately classified database suite;
- publishing an LC4 result additionally requires a clean-commit-scoped real-ASR
  receipt with all two suites and three tests passing;
- the completed benchmark still has to satisfy its independent signed ASR,
  authority, retention, denominator, and terminal-budget gates. The receipt
  alone cannot make a benchmark result claim-eligible.

## Produce the receipt

Install the exact pinned toolchain and provide retained assets, then set:

```bash
export LC4_DEV_AUDIO_ROOT=/absolute/audio-root
export LC4_DEV_CALIBRATION_ROOT=/absolute/calibration-root
export LC4_DEV_WHISPER_CLI_PATH=/absolute/whisper-cli
export LC4_DEV_WHISPER_MODEL_PATH=/absolute/ggml-large-v3-turbo-q5_0.bin
export LC4_DEV_FFMPEG_PATH=/absolute/ffmpeg
export LC4_DEV_REAL_ASR_PCM_PATH=/absolute/museum.corrected_crate.pcm
export LC4_DEV_EVIDENCE_ROOT=/absolute/temporary-provider-free-evidence-root

cd web
npm run benchmark:lc4:asr-environment:receipt -- \
  --out /absolute/release-evidence/lc4-asr-environment-receipt.json
```

The command refuses a dirty source tree, removes provider credentials from the
test environment, runs only the two inventory-selected suites, requires exactly
three passes and zero pending tests, and emits a domain-hashed JSON receipt. It
binds the clean commit/tree, Gate 0 inventory, test sources, toolchain bytes,
retained audio manifests, calibration artifact, PCM fixture, and redacted host
qualification. The receipt records zero provider sessions and zero spend.

Absolute paths are local inputs only. They are reduced to basenames plus byte
lengths and SHA-256 identities in the receipt.

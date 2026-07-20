# C3 transport-smoke audio fixture

This pack is a 2.4-second, one-channel PCM16 input used only to test realtime
transport compatibility: provider audio input, one native gateway round trip,
provider audio output, metering, shutdown, and artifact capture. It is not
speech and must not be reported as ASR, task-completion, drift, or comparative
model evidence.

The audible label is three ascending triangle-wave beeps: 400 Hz, 500 Hz, and
1,000 Hz. Each beep has 200 ms of leading silence, 400 ms of tone, and 200 ms of
trailing silence, with a 20 ms linear attack/release and an 8,000-sample peak.
Both native-rate renditions are generated directly with integer sample
arithmetic; no TTS model, voice asset, resampler, network request, or provider
credential is involved.

Regenerate from the repository root:

```sh
cd web
npm run benchmark:fixture:transport-smoke
npm run benchmark:fixture:transport-smoke:check
```

`fixture-manifest.json` binds the exact PCM bytes, acoustic measurements,
scenario identity, signal specification, source generator, and caller
sequence. `freeze-input.json` is the only fixture-hash source that should be
copied into a Gate1 canary freeze. The two raw PCM files and their generated
metadata are redistributable under the repository's MIT license.

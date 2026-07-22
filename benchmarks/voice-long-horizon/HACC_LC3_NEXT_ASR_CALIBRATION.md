# Next-protocol ASR calibration gate

This is a prospective implementation contract. It does not amend, regenerate,
or upgrade any HACC-LC3 v6 evidence. The retained v6 calibration covered the
frozen `Samantha` caller fixtures only and therefore cannot establish semantic
ASR accuracy for assistant audio spoken as OpenAI `marin`, Gemini `Aoede`, or
xAI `ara`.

The next protocol uses `HACC-LC3-ASR-CAL-v2`. Before an experiment is prepared,
the operator must supply an immutable output-voice fixture manifest containing
exactly six known-label PCM fixtures for each exact provider/model/voice route:

| Provider | Model | Output voice | Required fixtures |
| --- | --- | --- | ---: |
| OpenAI | `gpt-realtime-2.1` | `marin` | 6 |
| Gemini | `gemini-3.1-flash-live-preview` | `Aoede` | 6 |
| xAI | `grok-voice-think-fast-1.0` | `ara` | 6 |

Each route has one fixture for every preregistered corrected-identifier and
numeric-limit slot across museum, campus, and water. Every fixture binds the
known reference text, exact PCM SHA-256, 24 kHz mono PCM format, provider,
model, voice, request/configuration hashes, credential-neutral provider
session/request acknowledgement hashes, sanitized wire-event log, ordered
output-chunk hashes, terminal event, and capture implementation through a
domain-separated Ed25519 receipt. No credential, token, account identifier, or
raw provider session/request identifier is retained. The capture authority
fingerprint must be pinned outside the imported manifest before fixture
generation.

`long-call-output-voice-capture-verify.ts` requires that preregistered capture
authority fingerprint, verifies every receipt signature, reconstructs every
signed wire chunk from the PCM bytes, verifies the concatenated artifact, and
emits an immutable credential-neutral verification receipt. A self-asserted
hash, self-selected key, or fixture whose bytes do not reconstruct the signed
wire sequence is not eligible. The preparation command validates the complete route/slot
matrix, copies the immutable PCM into the new experiment root, and binds the
manifest hash into `experiment-plan.json`.

The pinned whisper.cpp toolchain then transcribes both fixture classes in one
prepared batch:

- six selected caller turns per frozen family-by-caller-voice stratum; and
- six output fixtures per exact provider/model/voice route.

The closing batch receipt re-hashes the CLI, weights, and ffmpeg and binds every
invocation receipt. Calibration fails closed on a missing fixture, byte/hash
mismatch, malformed capture receipt, route substitution, unexpected route,
missing ASR receipt, or incomplete finalization.

Publication is blocked unless the caller stratum and **each output voice
independently** achieve all of the following:

- 100% fixture and receipt coverage;
- micro-averaged WER at or below 15%;
- zero critical corrected-identifier or numeric-limit false negatives; and
- zero semantic-slot false positives.

An aggregate average cannot hide a failing voice. The postprocessor requires
calibration schema v2, the exact experiment-plan hash, caller-fixture manifest
hash, output-voice manifest hash, ASR config hash, and the ordered set of three
provider/model/voice routes. A v1 caller-only artifact or an artifact missing
one route is rejected before any assistant-output transcript is scored.

This change supplies the collection, hashing, transcription, scoring, and
publication-gate primitives. It does not claim that the three provider-voice
fixture sets already exist and does not make provider calls while implementing
or testing the gate.

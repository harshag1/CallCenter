# Hash-manifested run artifacts

<!-- markdownlint-disable MD013 MD060 -->

Every opened provider session produces a content-addressed run bundle, including failures. Scenario, condition, plan, freeze, fixture, and source dependencies may be external only when the manifest binds their exact hashes and the verifier requires them. Provider events are projected and redacted before persistence, then written before normalization. No rerun should overwrite an earlier bundle.

## Required bundle

- `manifest`: protocol/condition/scenario/provider/model IDs, pairing key, timestamps, source commit, dirty-patch hash if any, adapter/compiler/evaluator versions, seed, limits, and failure class;
- `scenario`: canonical scenario, hidden-world initial state, compiled condition prompt/tool/disclosure maps, and all SHA-256 hashes;
- `audio-fixtures`: source text/provenance, format, sample rate, duration, transformation pipeline, and exact input PCM hashes;
- `provider-events`: order-preserving, schema-preserving inbound/outbound provider JSONL projection with secrets redacted at write time (not the byte-identical provider frames);
- `session-identity`: requested, provider-acknowledged, mismatched, and unverifiable model/voice/instructions/tools/tool-choice/audio/turn settings without copying requests into acknowledgement fields;
- `normalized-events`: stable lifecycle events with raw-event pointers and monotonic/wall-clock timestamps;
- `playback`: generated/queued/played-through/interrupted/history-repaired segment ledger;
- `actions`: attempts, admission decisions, capability epochs/leases, confirmation evidence, reservations, arguments, results, receipts, verifications, commits, and idempotency/effect keys;
- `world-state`: before/after snapshots and deterministic transition log;
- `usage`: raw provider usage, audio durations, billable text events, context settings, estimated/provider-reported/reconciled costs, and pricing snapshot;
- `score`: strict endpoint, every component, CIC/RH contributions, evaluator/version hashes, and machine-readable reasons;
- `kernel-attestation`: canonical Ed25519-signed bindings and final world/capability/Flow heads, using the plan-pinned trust key;
- `index`: transcripts and output audio hashes/paths plus a final hash manifest.

## Integrity rules

1. Run IDs and reservation IDs are globally unique.
2. The final manifest lists the size and SHA-256 of every artifact.
3. Normalized events retain pointers to raw event offsets; normalization never destroys original order.
4. Secrets, API keys, bearer tokens, phone numbers, and real customer data are prohibited. Redaction occurs before persistence, not as a later publication step.
5. A failed or partial artifact bundle is itself preserved and scored as an operational failure.
6. Corrections are new immutable evaluator outputs referencing the original bundle, never edits to the raw evidence.
7. Published summaries can omit licensed audio bytes, but must include their hashes and reproducible acquisition instructions.
8. Missing/invalid kernel evidence, a kernel crash, an acknowledgement mismatch, or failed replay remains an immutable opened-session failure; it is never an exclusion or an invitation to overwrite the run.
9. Replay reconstructs world facts, events, effects, and receipts from the frozen scenario and checks exact heads/counts. Any private Flow field that cannot be independently reconstructed is labeled implementation-attested rather than externally observed.

The local publisher uses exclusive run IDs, content hashes, and filesystem guards; it is not WORM storage. Operators who require immutability must copy verified bundles and their external dependencies into retention-locked/object-lock storage and preserve the manifest root.

## What the signatures prove

The execution plan pins an Ed25519 public key, key ID, and fingerprint before a paid connection. The final signature covers the attestation hash, which binds the run/condition/source/build identities and final heads. This detects artifact mutation, key substitution, and cross-plan/run substitution when the verifier supplies its own expectation.

The current private signer is available inside the benchmark process. Its signature therefore proves provenance and integrity-at-rest, not kernel honesty, provider/model origin, or TEE execution. Deterministic replay is the truth mechanism for replayable state; frozen build/source hashes make private implementation claims reproducible but do not make them independent observations. ToolWorld replay proves internal scenario/event/state consistency, not that raw provider behavior occurred. Public reports must preserve those distinctions and require both overall verification validity and signature verification.

## Minimum normalized timestamps

Each event stores `wall_time_utc`, `monotonic_ns`, `provider_time` when present, `turn_id`, `response_id`, and `raw_pointer`. Latency calculations use monotonic time; wall time is audit metadata.

## Artifact-health monitoring

During blinded confirmatory collection, operators may inspect only schema validity, file/hash presence, audio duration, connection/error class, usage presence, and budget reservation state. Tool correctness, transcripts, strict-success fields, and condition aggregates remain blinded as defined in [PREREGISTRATION.md](PREREGISTRATION.md).

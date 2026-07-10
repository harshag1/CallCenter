# Immutable run artifacts

<!-- markdownlint-disable MD013 MD060 -->

Every opened provider session produces a self-contained run bundle, including failures. Raw provider evidence is written before normalization, and no rerun overwrites an earlier bundle.

## Required bundle

- `manifest`: protocol/condition/scenario/provider/model IDs, pairing key, timestamps, source commit, dirty-patch hash if any, adapter/compiler/evaluator versions, seed, limits, and failure class;
- `scenario`: canonical scenario, hidden-world initial state, compiled condition prompt/tool/disclosure maps, and all SHA-256 hashes;
- `audio-fixtures`: source text/provenance, format, sample rate, duration, transformation pipeline, and exact input PCM hashes;
- `provider-events`: lossless inbound/outbound provider JSONL with secrets redacted at write time;
- `normalized-events`: stable lifecycle events with raw-event pointers and monotonic/wall-clock timestamps;
- `playback`: generated/queued/played-through/interrupted/history-repaired segment ledger;
- `actions`: attempts, admission decisions, capability epochs/leases, confirmation evidence, reservations, arguments, results, receipts, verifications, commits, and idempotency/effect keys;
- `world-state`: before/after snapshots and deterministic transition log;
- `usage`: raw provider usage, audio durations, billable text events, context settings, estimated/provider-reported/reconciled costs, and pricing snapshot;
- `score`: strict endpoint, every component, CIC/RH contributions, evaluator/version hashes, and machine-readable reasons;
- `index`: transcripts and output audio hashes/paths plus a final hash manifest.

## Integrity rules

1. Run IDs and reservation IDs are globally unique.
2. The final manifest lists the size and SHA-256 of every artifact.
3. Normalized events retain pointers to raw event offsets; normalization never destroys original order.
4. Secrets, API keys, bearer tokens, phone numbers, and real customer data are prohibited. Redaction occurs before persistence, not as a later publication step.
5. A failed or partial artifact bundle is itself preserved and scored as an operational failure.
6. Corrections are new immutable evaluator outputs referencing the original bundle, never edits to the raw evidence.
7. Published summaries can omit licensed audio bytes, but must include their hashes and reproducible acquisition instructions.

## Minimum normalized timestamps

Each event stores `wall_time_utc`, `monotonic_ns`, `provider_time` when present, `turn_id`, `response_id`, and `raw_pointer`. Latency calculations use monotonic time; wall time is audit metadata.

## Artifact-health monitoring

During blinded confirmatory collection, operators may inspect only schema validity, file/hash presence, audio duration, connection/error class, usage presence, and budget reservation state. Tool correctness, transcripts, strict-success fields, and condition aggregates remain blinded as defined in [PREREGISTRATION.md](PREREGISTRATION.md).

# Signed kernel transcript replay evidence

Status: reproducible deterministic offline engineering sensitivity, last run
2026-07-16. It opened no provider session and made no paid call.

The benchmark gateway now emits two deliberately different transcript views:

- `public_commitment` is the default, claim-bearing canonical JSONL artifact.
  It contains an independently replayable HMAC-committed ToolWorld shadow,
  capability catalogs, state heads, result classes, and durable-memory deltas,
  but no plaintext world values, provider arguments/results, raw grants, or
  memory key/value preimages.
- `restricted_exact` can reconstruct the synthetic plaintext ToolWorld and
  exact durable-memory state. Export and verification require an explicit
  secret-exposure acknowledgement. It is **not public claim evidence** and
  must not be uploaded as the public artifact.

Every JSONL entry binds the prior entry hash. The final Ed25519 attestation
binds the exact public transcript reference (view, encoding, entry count, chain
head, artifact digest, and byte length) as well as run, condition, scenario,
world, capability, Flow, plan, freeze, kernel-build, provider, and model
identities. Structural replay without that signed binding is reported only as
`unsigned_public_commitment`; it is not authenticated origin evidence.

## Reproduce

From `web/`:

```bash
npx tsx scripts/kernel-transcript-benchmark.ts
```

Observed environment: Node v24.8.0, Apple M4 Max, 48 GiB RAM, arm64. Timing is
machine- and load-specific. Counts, canonical bytes, hashes, mutation results,
and deterministic equality are the reproducible semantic evidence.

## Frozen 120-invocation ToolWorld result

| Measure | Result |
| --- | ---: |
| Kernel invocations | 120 |
| Public transcript entries | 121 |
| Reconstructed authoritative event count | 481 |
| Canonical public transcript size | 2,786,906 bytes |
| Repeated-full-world-state comparison | 19,907,869 bytes |
| Size reduction versus that comparison | 86.0010% |
| Signed verifier repetitions | 5/5 passed |
| Signed verification p50 | 565.227 ms |
| Signed verification p95/max | 588.648 / 588.648 ms |
| Deterministic public bytes across two builds | true |
| Raw grants exposed | 0 |
| Mutations rejected | 3/3 |

- Public chain head: `4fdb6f7c6acba0e93fd3ca76dbc24ba288741e3519b418d3810e747704b0baf9`
- Domain-separated transcript artifact hash: `bc8e4171c66899e5aff96ca27d27c8da69507e3b7ba069cebce7cc9d303a0fac`
- Raw canonical-bytes SHA-256: `03934817038a399a0617004e3f04f2121ad9877e3270811c633d68fcb9c35f41`

The repeated-full-state figure is a transparent byte comparison, not a claim
that the two encodings reveal equivalent information. The public format is
larger than the former secret-bearing prototype because every scalar is now a
typed, private-keyed commitment.

## Frozen 120-invocation durable-memory result

The second trace executes 30 cycles of write, read, overwrite, and delete. The
gateway captures exact pre/post Maps, derives rather than trusts each delta,
increments revision only on a real state change, and compares the live final
Map with the recorder before signing.

| Measure | Result |
| --- | ---: |
| Durable-memory invocations | 120 |
| Public transcript entries | 121 |
| Canonical public transcript size | 1,462,430 bytes |
| Reconstructed state revisions | 90 |
| Reconstructed final entries | 0 |
| Signed replay verified | true |
| Deterministic public bytes across two builds | true |
| Private key/value preimages exposed | 0 |
| Signed verification p50/max (3 runs) | 50.006 / 50.705 ms |

- Public chain head: `55cf7bd7886cecfbec739715888335533bd35f0003e9888044231aafb3ff2908`
- Domain-separated transcript artifact hash: `dc1c3f39b09477144598bb5b3b069127e89825325517971d6edc7ac65525c8c5`
- Raw canonical-bytes SHA-256: `1221a5c5b32a9b030a4eaa23bac66aca5a848952e37e8dd65b68eb16a9dcea78`

Memory keys receive stable per-run HMAC commitments. Values are separately
HMAC-committed with the key commitment as context, so an equal value under two
different keys does not share a public commitment. The public verifier applies
`set`, `delete`, and `none` deltas to that opaque state, checks every revision,
count, and state head, and requires every mutation to be an `executed`
`durable_memory` success. Replays, conflicts, failures, verified reads, and
unrelated actions cannot mutate it.

This proves signer-attested, tamper-evident memory evolution at recorded
invocation boundaries. It does not open HMAC preimages, prove a malicious
signer truthful, or detect a transient out-of-band mutation that is reverted
between boundaries. Public evidence reveals operation type, entry count, and
within-run key/value recurrence. The transcript append and memory/provider-call
publication are transactional, so a live size-limit failure cannot leave an
unrecorded memory mutation.

## Exact evidence identity

- Semantic result hash: `5087f4023cc0abc40dcc7aafb688381916bf337996943508b71e625a4e4fefe0`
- Benchmark script SHA-256: `02272e7f1d68488d6c831a7a84c74c22c42c4144e8828e813e386cfab45a48da`
- Transcript implementation SHA-256: `07a3b9aec543e97722c7934af61389823d8b14a7305886c80e24953752aead10`
- Gateway implementation SHA-256: `5e45f102fe0a3d854b5368555be2b333972ab96bb6d1e194a180fe3fcc9e982d`

The script generates an ephemeral Ed25519 test key, signs the exact transcript
reference, and verifies it against the separately supplied trust expectation in
the same run. This validates the signature/reference path; it does not turn the
offline sensitivity into a durable third-party identity claim. Real trial
plans pin the signer identity before execution.

## Verification coverage

Focused transcript coverage is 13/13 passing. The integrated
Flow/attestation/gateway/transcript gate is 55/55 passing and includes:

- byte determinism, signed reference verification, cross-view rejection, and
  content/link/splice/truncation/rechaining mutations;
- low-entropy PIN, token, grant, memory-key, and memory-value non-disclosure;
- live entry, artifact-byte, line-byte, JSON depth/node/string, and compressed
  private-memory bounds;
- exact and public-shadow reconstruction, canonical Map ordering, falsy/JSON
  `null` values, one-key mutation enforcement, stale-prestate rejection, and
  same-value/different-key commitment separation;
- final live-Map substitution refusal and rollback of memory plus provider-call
  publication when transcript append fails.

## Claim boundary

This is `$0` engineering evidence for transcript integrity, privacy separation,
signed origin binding, deterministic replay, and supported-scale performance.
It does **not** measure model quality and supports no OpenAI, xAI, Gemini,
raw-model, long-conversation, or framework-superiority claim. Those require the
separately preregistered paired provider trials.

Reconstruction scope is explicit:

- The public artifact reconstructs the HMAC-committed world and memory shadows,
  then checks their heads. It does not reconstruct plaintext.
- The restricted artifact reconstructs the exact synthetic ToolWorld and
  durable memory, but may contain secrets and is not public evidence.
- Capability heads are checked against public catalogs and the signed final
  condition binding.
- Intermediate Flow states remain hash-chain commitments; the signed terminal
  Flow proof must match the final transcript head.
- Provider inputs and outputs are HMAC-bound. The verifier does not and cannot
  re-execute a stochastic provider model.

# Offline deterministic stress proof

This lane exercises HACC's production-neutral authority primitives without a
provider, network connection, credential, or paid API call. It is a mechanism
proof, not an efficacy comparison against a native voice model.

The full profile executes:

- 100,000 governed proposals split across forged actions, stale authority,
  authorized dispatch, and terminal idempotent replay;
- 10,000 reserve/dispatch/settle schedules split across successful settlement,
  authority changes at the dispatch boundary, indeterminate-effect
  reconciliation, and conflicting idempotency reuse; and
- 10,000 correction/reconnect/replay schedules that rebuild a
  `ConversationProgram`, recompile and assert a production Turn Contract,
  reject stale worker delivery, and attempt to release an ungranted terminal
  claim through the audibility ledger.

The report fails unless unauthorized effects, duplicate effects, stale
dispatches, blind retries, and released forbidden claims are all zero, every
program reconnect replay is exact, and the Evidence v2 bundle both replays and
rejects mutation.

```bash
# Fast fixed CI profile: 400 proposals, 100 races, 100 reconnect replays
npm run benchmark:proof:offline-stress:ci

# Full registered profile
npm run benchmark:proof:offline-stress

# Preserve canonical JSON while keeping stdout byte-identical to the artifact
npx tsx scripts/hacc-proof-offline-stress.ts \
  --output ../benchmarks/voice-long-horizon/v2/artifacts/offline-stress-full.json
```

The JSON contains wall-clock timings, but its `logical_result_sha256` excludes
timing and is repeatable for the same source digest, configuration, and seed
range. The signed Evidence v2 plan artifact binds that logical result digest,
the source digest, and the configuration digest. The public embedded Ed25519
key is deliberately a deterministic test fixture; it is not an operator
credential and makes no external trust claim.

If any file listed by `sourceFiles` in
`web/scripts/hacc-proof-offline-stress.ts` changes, rerun the full profile before
publishing its artifact.

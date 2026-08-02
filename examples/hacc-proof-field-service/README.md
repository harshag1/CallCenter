# Field-service reliability proof

This provider-free vertical slice demonstrates the HACC reliability contract,
not a scripted chat transcript. It uses only Node.js, temporary local files and
the frozen [`scenario.json`](scenario.json) fixture.

```bash
npm run demo:proof
npm run demo:proof -- --json
npm run demo:proof -- --test
```

The first process classifies the repair goal, enters a safety branch, proves an
unsafe mutation is denied, records authoritative clearance, completes a
scheduling detour, resumes the repair and dispatches a governed part
reservation. The local ToolWorld commits that reservation but its response is
deliberately lost, leaving an indeterminate receipt. A read-only worker is also
spawned before the simulated crash.

A second process starts with no in-memory state. It verifies and replays the
hash-chained journal and reconciles the original reservation by authoritative
read—without redispatching it. Separate worker and finalizer processes replay
the journal, finish the read-only lookup and complete the repair through
receipt-gated actions. A fifth fresh process independently replays the terminal
journal and must reproduce the final-state hash.

`--json` prints the machine-readable final state, authoritative ToolWorld,
receipts, hashes and one boolean assertion for every promised property. The
test runs the entire five-process proof twice and requires identical hashes and
receipts. For a stdout stream containing JSON and no npm banner, use:

```bash
npm run --silent demo:proof -- --json
```

Safety boundary: the wrapper strips provider and application credentials. The
example contains no network, provider SDK, database or secret access and makes
no paid calls. Expected spend is `$0`.

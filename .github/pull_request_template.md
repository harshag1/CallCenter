## What problem does this solve?

Describe the user-visible or operator-visible problem and the chosen boundary.

## What changed?

Keep the implementation summary scoped. Call out migrations, provider behavior, authority changes, durable state, or public claims explicitly.

## Verification

- [ ] Added or updated deterministic tests.
- [ ] Ran `cd web && npm run check && npm run build`.
- [ ] Ran conditional database and bridge gates when affected.
- [ ] Ran `cd web && npm run audit:public`.
- [ ] Added no credentials, private data, recordings, transcripts, phone numbers, raw provider payloads, or local evidence artifacts.
- [ ] Opened no paid provider session unless an approved benchmark plan required it.

List exact commands and results:

```text
command -> result
```

## Authority and failure semantics

For any action that mutates, spends, contacts a person, or calls an external service, explain authorization, idempotency, timeout, indeterminate-outcome, reconciliation, and retry behavior. Write “not applicable” only when the change cannot cause an external effect.

## Claim boundary

State the evidence class for any numerical or reliability claim. Synthetic/offline containment, transport compatibility, exploratory provider evidence, and confirmatory evidence are not interchangeable.

# Contributing

Thank you for improving Harsha's Amazing Call Center.

## Before opening a pull request

1. Keep the change focused and explain the user-visible problem.
2. Add or update tests for flow semantics, provider payloads, registries, or security boundaries.
3. Run `cd web && npm run check && npm run build`.
4. Never commit `.env`, recordings, customer data, phone numbers, provider responses, or credentials.
5. Run `cd web && npm run audit:public` before proposing a public release. A clean exit is not enough for release automation; follow [the report checks](docs/public-release-security.md).
6. When migrations change, run `cd web && npm run db:test-isolation` against its disposable local cluster.
7. When the standalone bridge changes, run `cd bridge && npm run check && npm test && npm run test:coverage`.

Provider contributions should use current official API documentation, ephemeral browser credentials, requested-versus-acknowledged session evidence, bounded audio/usage capture, and an explicit codec strategy for telephony. Local adapter tests are not live compatibility evidence. Never open a paid provider session or contact a real number as part of an ordinary test or pull request.

Tool contributions must enforce authorization in code rather than model instructions, validate detached arguments and results, declare effect/idempotency semantics, and preserve indeterminate outcomes after an uncertain dispatch. Provider acceptance is not delivery: email, SMS, and call surfaces must use exact statuses such as `accepted`, `delivered`, `terminal_failure`, or `indeterminate` only when their evidence contract supports them.

Flow v1 is legacy compatibility, not the security baseline. Preserve its safe routing/read behavior where practical, but do not widen it to new remote, generated, extension, or mutating actions. Those capabilities require Flow v2 gateway authority. A fail-closed migration is preferable to silently restoring an unsafe legacy path.

By contributing, you agree that your contribution is licensed under the MIT License.

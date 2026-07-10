# Contributing

Thank you for improving Voice Agent Studio.

## Before opening a pull request

1. Keep the change focused and explain the user-visible problem.
2. Add or update tests for flow semantics, provider payloads, registries, or security boundaries.
3. Run `cd web && npm run check && npm run build`.
4. Never commit `.env`, recordings, customer data, phone numbers, provider responses, or credentials.
5. Preserve backward compatibility for Flow v1 unless the pull request explicitly proposes a migration.

Provider contributions should use official API documentation, ephemeral browser credentials, capability declarations, and an explicit codec strategy for telephony. Tool contributions must enforce authorization in code rather than relying on model instructions.

By contributing, you agree that your contribution is licensed under the MIT License.

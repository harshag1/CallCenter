# Builder/operator extension example

[`membership-summary.ts`](membership-summary.ts) is a compiling, dependency-injected
example of a read-only builder/operator tool. Copy its factory into your
self-hosted application, inject a tenant-aware data adapter, and add the
result to `OPERATOR_TOOL_EXTENSIONS` in
`web/lib/agent/tools/extensions.ts`.

Every extension must declare:

- `security.effect`: `read` or `internal_write`
- `security.tenant_scoped`: the literal `true`

The registry rejects extensions without both values. These declarations do not
grant external side effects: email, SMS, phone calls, spending, and arbitrary
egress must remain behind HACC's separately authorized capability paths.

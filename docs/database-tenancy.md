# Database tenancy and runtime roles

Production uses separate PostgreSQL identities for schema ownership, the web application, and the scheduler. A single owner connection defeats `FORCE ROW LEVEL SECURITY`, so the application must never run as the migration owner, a superuser, or a role with `BYPASSRLS`.

## Role model

- `hacc_backend` is a `NOLOGIN` group role with explicit application-table access.
- `hacc_worker` is a narrower `NOLOGIN` group role for scheduled-call claiming and settlement.
- `hacc_voice_worker` is an exact-transition-only `NOLOGIN` group role for
  governed read-only call workers. It has no scheduled-call or application
  table grants.
- `hacc_runtime` is the web application's concrete login and inherits only `hacc_backend`.
- `hacc_worker_runtime` is the scheduler's concrete login and inherits only `hacc_worker`.
- `hacc_voice_worker_runtime` is the governed-worker login and inherits only
  `hacc_voice_worker`.
- The migration owner is separate, owns the application relations, and is used only by `npm run db:migrate`.

Migration 013 creates safe roles on a self-managed cluster. On a managed/shared cluster, provision the cluster-global roles and memberships once with an administrator before applying database-local migrations:

```sql
CREATE ROLE hacc_backend NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE hacc_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE hacc_voice_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE hacc_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE hacc_worker_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE hacc_voice_worker_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
GRANT hacc_backend TO hacc_runtime;
GRANT hacc_worker TO hacc_worker_runtime;
GRANT hacc_voice_worker TO hacc_voice_worker_runtime;
```

Set passwords through your secret manager or an interactive administrator command; do not place them in SQL migrations or Git.

## Connections

`DATABASE_URL` must identify `hacc_runtime` in production. Set
`DATABASE_RUNTIME_ROLE=hacc_runtime`; application startup verifies the exact
connected role, membership, ownership, superuser, and RLS-bypass properties.

`WORKER_DATABASE_URL` must identify `hacc_voice_worker_runtime`; set
`WORKER_DATABASE_RUNTIME_ROLE=hacc_voice_worker_runtime`. The stock web
deployment opens this second, independently audited pool only for
content-free candidate discovery and exact tenant/conversation-scoped
claim/heartbeat/mark/settle transitions. Its role audit rejects backend,
scheduled-dialer, owner, superuser, direct-grant, and RLS-bypass authority.
The same credential powers the authenticated bounded cron drain; inline
`waitUntil(...)` execution is only a latency optimization.

Do not grant `hacc_voice_worker` or `hacc_worker` membership to `hacc_runtime`,
do not make `hacc_voice_worker_runtime` a member of either `hacc_backend` or
the scheduled-dialer `hacc_worker`, and never reuse the migration-owner URL.

The `load_voice_worker_for_delivery` projection is succeeded-only and exposes
only immutable identity/authority hashes, the result hash, and settlement
time. It never returns result content, owner tokens, leases, checkpoints,
worker input, or cancellation state.

`MIGRATION_DATABASE_URL` identifies the DDL owner. The migration command requires it in production or whenever `DATABASE_ENFORCE_LEAST_PRIVILEGE=true`, rejects the exact runtime URL, and rejects application/worker role membership.

## Clean-room verification

Run the disposable PostgreSQL proof before release. Locally, the script uses
the `initdb` and `pg_ctl` first on `PATH` and requires a compatible `vector`
extension; public CI pins PostgreSQL 16 with pgvector:

```bash
cd web
npm run db:test-isolation
```

The command initializes an empty local cluster, applies every ordered migration
as a non-super migration owner, reapplies the idempotent security/runtime
migration range declared by the test harness, runs the inventory-bound
conditional database suites with zero skips, and deletes the cluster afterward.
The exact migration, suite, and test counts come from the source tree and
[`GATE0_SKIP_INVENTORY.json`](../benchmarks/voice-long-horizon/GATE0_SKIP_INVENTORY.json),
whose per-file hashes are checked before the suites run. The proof verifies
every `public` and `hacc_private` relation has enabled and forced RLS plus
explicit backend and migration-owner policies. It also exercises public API
CRUD denials, runtime grants, worker data denial, concurrent `SKIP LOCKED`
claims, irreversible dispatch/completion state, and the recording-deletion
ledger. It opens no provider session and spends `$0`.

This test is destructive only to its newly created temporary database directory. Never point it at a live or shared database.

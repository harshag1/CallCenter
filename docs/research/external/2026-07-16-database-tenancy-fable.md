---
provider: anthropic-claude-code
model: fable
timestamp: "2026-07-17T02:29:24.106173+00:00"
question: "# Independent review question\n\nWhat is the smallest production-safe database tenancy design for this existing Next.js/Postgres voice-agent repository that (a) blocks Supabase/API roles and model-authored SQL from cross-tenant access, (b) preserves trusted cross-tenant scheduler/auth work, and (c) can be introduced as migration 013 without rewriting migrations 009-012? Identify any P0 flaw in the proposed role/RLS boundary and recommend progressive tests."
context_files: ["/private/tmp/hacc-rls-fable-context.md"]
total_cost_usd: 0.762557
usage: {"cache_creation": {"ephemeral_1h_input_tokens": 11564, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 11564, "cache_read_input_tokens": 0, "inference_geo": "not_available", "input_tokens": 2, "iterations": [{"cache_creation": {"ephemeral_1h_input_tokens": 11564, "ephemeral_5m_input_tokens": 0}, "cache_creation_input_tokens": 11564, "cache_read_input_tokens": 0, "input_tokens": 2, "output_tokens": 10513, "type": "message"}], "output_tokens": 10513, "server_tool_use": {"web_fetch_requests": 0, "web_search_requests": 0}, "service_tier": "standard", "speed": "standard"}
advisory_only: true
unverified_peer_review: true
must_verify_claims: true
---

> This is unverified peer-review input, not release or production evidence.

## Verdict

The proposed design (three NOLOGIN roles + comprehensive FORCE RLS + revokes + default-off model SQL) is the right minimal shape and can ship as migration 013 without touching 009–012. However, as specified it has one P0: it implies a future tenant-containment path (`hacc_tenant` on the shared pool, presumably GUC- or SET ROLE-keyed) that is not a real boundary, and the opt-in flag makes cross-tenant arbitrary SQL a configuration change away. Ship it with that path made structurally impossible, plus fixes for four P1 PostgreSQL traps below — two of which directly answer your stated uncertainty about FORCE RLS and indirect-ownership joins.

## Assumptions

- The packet's claims are accurate: migrations 001–012 contain no public-schema RLS; app queries mostly carry explicit org predicates; `web/lib/db.ts` is one shared owner-login pool. I have no repository access to verify.
- Postgres version is unstated; I assume ≥14. Whether production is Supabase-hosted (vs. Supabase-like roles on plain Postgres) is unstated and materially changes the `service_role` analysis.
- "Preserves trusted cross-tenant scheduler/auth work" means those paths run on the backend/worker roles via the existing pool, not via a separate credential.
- No existing views, materialized views, or SECURITY DEFINER functions over org tables are mentioned; I assume their existence is unverified, not absent.

## Findings

**P0-1 — Tenant containment on the shared pool is not achievable, and the design leaves the door open.** The packet correctly notes that a GUC-keyed policy is forgeable via `set_config` and that a login with memberships in both roles can `SET ROLE` back. The missing piece: `RESET ROLE` is *always* available in a session and cannot be revoked, so `SET ROLE hacc_tenant` before running model SQL on a backend-pool connection is defeated by a one-line payload regardless of grants. Consequently, requirement (a) is satisfied only by the feature being off (design point 5), not by the role/RLS boundary — and the "explicit single-tenant opt-in" means one env var re-opens cross-tenant arbitrary SQL on multi-tenant deployments. Shipping GUC-keyed `hacc_tenant` policies in 013 invites exactly the unsafe wiring you rejected. Fix: either omit `hacc_tenant` from 013 entirely, or ship it with policies but *no login role granted membership*, and make the `query_data` opt-in assert at startup that the connected session cannot see more than one organization (a real query, not a flag check). Tenant-scoped arbitrary SQL must wait for the separate-login pool; document that in the migration itself.

**P1-1 — `service_role` typically has BYPASSRLS; RLS is inert against it and Supabase re-grants by default.** On Supabase, `service_role` is created with BYPASSRLS, so step 3 does nothing against it — only step 2's REVOKEs matter. Worse, Supabase configures `ALTER DEFAULT PRIVILEGES` (per grantor) so new objects in `public` get auto-granted to anon/authenticated/service_role; your default-privilege revokes must target the exact role that creates future objects, or migration 014's tables silently regain API exposure. If production is not Supabase-hosted, verify these roles' `rolbypassrls` before assuming policies apply to them.

**P1-2 — FORCE RLS applies to the table owner, which breaks the migration-only owner role and backups.** Under FORCE, the owner with no policies gets default-deny: any data backfill in migration 013+ silently affects zero rows, and `pg_dump` run as the owner errors on policy-bearing tables. Additionally, the standard workaround for ownership predicates — SECURITY DEFINER functions owned by the table owner — is *also* constrained under FORCE RLS, so that escape hatch quietly doesn't work. Fix: give the owner explicit all-row policies (or a dedicated BYPASSRLS backup role), and run any backfills before the FORCE statements within 013.

**P1-3 — Indirect-ownership EXISTS subqueries are evaluated under the *querying role's* RLS on the parent table.** This answers your stated uncertainty: a one-directional child→parent lookup does not infinitely recurse (Postgres would error loudly if policies were mutually referential), but a policy on `calls` like `EXISTS (SELECT 1 FROM agents …)` is filtered by the current role's policies on `agents`. If `hacc_worker` has a policy on `scheduled_calls` but no SELECT policy on `agents`, the worker sees zero scheduled calls with no error. Every role's policy graph must be closed over the parents it references, or you denormalize `org_id` onto the indirect tables (heavier, but makes policies flat and index-friendly).

**P1-4 — Worker claim-transition breaks under the USING/WITH CHECK default.** If `hacc_worker`'s UPDATE policy is `USING (status = 'pending' AND due_at <= now())` with no explicit WITH CHECK, WITH CHECK defaults to the USING expression, and setting `status = 'claimed'` moves the row out of the permitted set → the UPDATE errors. This is precisely the scheduler-atomicity path you must preserve. Write explicit, broader WITH CHECK clauses for worker UPDATE policies and test the `FOR UPDATE SKIP LOCKED` claim under the worker role.

**P2 —** (a) Backend/worker need explicit `USAGE` on sequences after the PUBLIC revoke or all inserts into serial/identity columns fail. (b) Any existing views execute with the view owner's privileges; under FORCE RLS with a policy-less owner they return zero rows — audit and consider `security_invoker` (PG15+). (c) If pgbouncer/transaction pooling is in use, session GUCs and `SET ROLE` leak across pooled clients — another reason the boundary must be login-based, never session-state-based. (d) `manage_table`'s shared `agent_data` schema has no per-org story even in the future re-enable design; the opt-in should remain dedicated-database-only permanently or the schema should become per-org.

## Options

- **A. Proposed design as written.** Minimal, but carries P0-1's latent re-enable path and will hit P1-2/P1-3/P1-4 at apply or runtime.
- **B. Proposed design amended** (drop or inert `hacc_tenant` in 013; owner policies; closed policy graphs per role; explicit WITH CHECKs; sequence grants; grantor-correct default-privilege revokes). Same migration count, removes the traps. Failure mode: policy sprawl — ~30 tables × 3 roles needs generated/templated SQL and a catalog-coverage test or a table will be missed silently.
- **C. Revokes + RLS for API roles only, backend unchanged.** Smaller, blocks Supabase-role exposure, but does nothing for forgotten org predicates in app SQL and nothing for model SQL; fails requirement (a) even nominally. Not recommended given the repo's stated open-source-hardening goal.
- **D. Separate tenant-only login + non-forgeable context tokens now.** The only design that genuinely preserves arbitrary model SQL, but it's the machinery you already correctly deferred; premature while `query_data` defaults off.

## Recommended path

Option B. Concretely: migration 013 = revokes (PUBLIC + API roles + default privileges scoped to the actual future grantor) → ENABLE + FORCE RLS on every direct and indirect org table → all-row policies for `hacc_backend` *and the migration owner* → worker policies with explicit WITH CHECK and closed parent-table coverage → backend/worker sequence USAGE. Defer `hacc_tenant` membership grants entirely; leave the role uncreated or unwired with a comment stating why. Keep `query_data`/`manage_table` fail-closed, and gate the opt-in on a runtime probe (query proves single-org visibility) rather than a boolean.

## Strongest objection

"FORCE RLS plus ~30 tables of hand-written policies is a lot of surface for a repo whose queries already carry org predicates; Option C plus code review gets 90% of the protection for 20% of the SQL." The rebuttal is your own packet: `data.ts` already shipped a P0 where the org predicate was left to the model, proving predicate discipline doesn't hold under agent-authored code. Database-level default-deny is the mechanism that survives that. But the objection is right that unreviewed policy sprawl is its own risk — hence the catalog coverage test being mandatory, not optional.

## Missing proof

- No migration 013 SQL exists in the packet — every claim about its policies is design intent, not evidence.
- No evidence `service_role`/`anon`/`authenticated` exist in the target database, or whether `service_role` has BYPASSRLS there ("may exist" is the packet's phrasing).
- No evidence about views, materialized views, SECURITY DEFINER functions, or triggers over org tables — each interacts with FORCE RLS differently.
- No evidence of the production connection topology (pgbouncer? transaction pooling?) or what role runs migrations in production.
- No evidence that no server path currently depends on `service_role` grants (your own listed decision-changer).

## Progressive next tests

1. **Static (seconds):** contract test asserting every table in the packet's sensitive-table list appears in 013's ENABLE+FORCE RLS statements, and that 013 contains no `GRANT hacc_tenant TO` any login role; grep app code for `SET ROLE`/`set_config`.
2. **Disposable Postgres, schema-only (minutes):** apply 001–013; assert via `pg_policies`/`information_schema.role_table_grants` that policy coverage and grant revocation match the table list exactly; run a data backfill as owner and assert affected-row count is nonzero (catches P1-2).
3. **Two-tenant role matrix (same cluster):** seed orgs A/B; for each of anon/authenticated/service_role/backend/worker, attempt SELECT/INSERT/UPDATE/DELETE on one direct table (`agents`) and one indirect table (`calls`); assert denials and, critically, that worker sees its own rows on indirect tables (catches P1-3's silent zero-rows).
4. **Escalation attempts:** as each non-backend role: `RESET ROLE`, `SET ROLE hacc_backend`, `set_config('hacc.org_id', <other org>)`, `SET row_security = off`; assert failure or no effect.
5. **Scheduler claim under worker role:** two concurrent sessions running the real `FOR UPDATE SKIP LOCKED` claim query; assert exactly one claims each job and no WITH CHECK error (catches P1-4).
6. **`pg_dump` as the intended backup role** against the seeded cluster; assert it completes with all rows.
7. **First shared-state step (only after 1–6 pass):** apply to a Supabase-shaped staging instance to observe `service_role` BYPASSRLS and platform default-privilege re-granting on a table created *after* 013.

## Questions for Harsha

1. Is production actually Supabase-hosted, and does `service_role` there have BYPASSRLS? This decides whether P1-1 is live.
2. What role applies migrations in production, and do any existing migrations contain data backfills that would rerun on fresh deploys under FORCE RLS?
3. Is there connection pooling (pgbouncer, transaction mode) between the app and Postgres?
4. Are there any views or SECURITY DEFINER functions over the org tables today?
5. For indirect tables, do you prefer closed per-role policy graphs (no schema change) or denormalized `org_id` columns (flatter, faster policies, more 013 surface)? I lean to closed policy graphs for minimality, denormalization only if the matrix test shows planner problems.

## Confidence

0.8 on the overall verdict and on P0-1 (RESET ROLE/session-state non-containment is well-established Postgres behavior). 0.7 on P1-1's specifics, since the hosting environment is unverified. The P1-2/P1-3/P1-4 traps are standard documented FORCE RLS/policy semantics, but whether each actually fires depends on 013 SQL that doesn't exist yet — the disposable-cluster matrix (tests 2–5) is what converts this review from design critique to evidence.

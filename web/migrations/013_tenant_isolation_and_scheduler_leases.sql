-- 013_tenant_isolation_and_scheduler_leases.sql
-- Database/API isolation and crash-safe scheduled-call admission.
--
-- Trust contract:
--   * hacc_backend is the server-only application role. A separate LOGIN role
--     may inherit it, but must not own application tables or have BYPASSRLS.
--   * hacc_worker is a narrower cross-tenant dialer role. It cannot read auth,
--     credentials, transcripts, MCP configuration, or arbitrary tenant data.
--   * Browser/API roles receive no public-schema authority. RLS is still
--     forced so an accidental future grant remains default-deny.
--   * There is intentionally no shared-pool hacc_tenant role. SET/RESET ROLE
--     and mutable session settings cannot contain arbitrary model-authored SQL.

DO $roles$
DECLARE
  role_name text;
  unsafe boolean;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['hacc_backend', 'hacc_worker'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        role_name
      );
    ELSE
      SELECT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
      INTO unsafe
      FROM pg_roles
      WHERE rolname = role_name;
      IF unsafe THEN
        RAISE EXCEPTION '% exists with unsafe login/owner/bypass authority', role_name;
      END IF;
    END IF;
  END LOOP;
END
$roles$;

DO $runtime_roles$
DECLARE
  role_name text;
  unsafe boolean;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['hacc_runtime', 'hacc_worker_runtime'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS',
        role_name
      );
    ELSE
      -- LOGIN is an expected deployment-time property for the concrete
      -- runtime identities. Reapplying the migration after an operator enables
      -- LOGIN must remain safe; ownership and RLS-bypass authority never are.
      SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
      INTO unsafe
      FROM pg_roles
      WHERE rolname = role_name;
      IF unsafe THEN
        RAISE EXCEPTION '% exists with unsafe login/owner/bypass authority', role_name;
      END IF;
    END IF;
  END LOOP;
END
$runtime_roles$;

DO $runtime_memberships$
DECLARE
  membership record;
BEGIN
  FOR membership IN
    SELECT * FROM (VALUES
      ('hacc_runtime'::text, 'hacc_backend'::text),
      ('hacc_worker_runtime'::text, 'hacc_worker'::text)
    ) AS expected(member_role, group_role)
  LOOP
    -- Shared PostgreSQL clusters have cluster-global roles. A database-local
    -- migration owner may use an already-provisioned membership without
    -- holding ADMIN OPTION on the group role, so never issue a redundant
    -- GRANT. Missing membership is an infrastructure bootstrap step.
    IF NOT pg_has_role(membership.member_role, membership.group_role, 'member') THEN
      BEGIN
        EXECUTE format('GRANT %I TO %I', membership.group_role, membership.member_role);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE EXCEPTION
          'missing role membership % -> %; provision it once with a cluster role holding ADMIN OPTION, then reapply migration 013',
          membership.member_role,
          membership.group_role
          USING ERRCODE = '42501';
      END;
    END IF;
  END LOOP;
END
$runtime_memberships$;

-- A scheduled call has one stable local call identity before external dispatch.
-- A worker may reclaim only an expired lease whose irreversible dispatch
-- boundary is still NULL. Once dispatch_started_at is set, ambiguity is
-- terminal and automatic redial is forbidden.
ALTER TABLE scheduled_calls
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES orgs(id),
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_call_id uuid,
  ADD COLUMN IF NOT EXISTS operator_execution_id uuid,
  ADD COLUMN IF NOT EXISTS operator_arguments_sha256 text,
  ADD COLUMN IF NOT EXISTS runtime_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS runtime_digest text,
  ADD COLUMN IF NOT EXISTS target_set_sha256 text,
  ADD COLUMN IF NOT EXISTS authority_manifest jsonb,
  ADD COLUMN IF NOT EXISTS agent_version integer;

UPDATE scheduled_calls AS scheduled
SET org_id = agent.org_id
FROM agents AS agent
WHERE scheduled.agent_id = agent.id
  AND scheduled.org_id IS NULL;

-- Pre-boundary releases created dialable rows without immutable runtime or
-- operator authority. They are evidence, not authority: never grandfather
-- them into a public deployment's outbound queue.
UPDATE scheduled_calls
SET status = 'canceled'
WHERE status = 'pending'
  AND authority_manifest IS NULL;

UPDATE scheduled_calls
SET status = 'indeterminate',
    dispatch_started_at = COALESCE(dispatch_started_at, claimed_at, run_at, created_at),
    claim_token = NULL,
    claim_lease_expires_at = NULL
WHERE status = 'dialing'
  AND authority_manifest IS NULL;

DO $scheduled_org$
BEGIN
  IF EXISTS (SELECT 1 FROM scheduled_calls WHERE org_id IS NULL) THEN
    RAISE EXCEPTION 'scheduled_calls contains a row whose organization cannot be derived from its agent';
  END IF;
END
$scheduled_org$;

ALTER TABLE scheduled_calls ALTER COLUMN org_id SET NOT NULL;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS scheduled_call_id uuid REFERENCES scheduled_calls(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_calls_scheduled_call_id
  ON calls(scheduled_call_id)
  WHERE scheduled_call_id IS NOT NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'calls_id_scheduled_call_unique'
  ) THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_id_scheduled_call_unique UNIQUE (id, scheduled_call_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_id_org_unique'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_id_org_unique UNIQUE (id, org_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_calls_id_agent_unique'
  ) THEN
    ALTER TABLE scheduled_calls
      ADD CONSTRAINT scheduled_calls_id_agent_unique UNIQUE (id, agent_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_calls_agent_org_binding'
  ) THEN
    ALTER TABLE scheduled_calls
      ADD CONSTRAINT scheduled_calls_agent_org_binding
      FOREIGN KEY (agent_id, org_id)
      REFERENCES agents(id, org_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'calls_scheduled_agent_binding'
  ) THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_scheduled_agent_binding
      FOREIGN KEY (scheduled_call_id, agent_id)
      REFERENCES scheduled_calls(id, agent_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_calls_completed_call_binding'
  ) THEN
    ALTER TABLE scheduled_calls
      ADD CONSTRAINT scheduled_calls_completed_call_binding
      FOREIGN KEY (completed_call_id, id)
      REFERENCES calls(id, scheduled_call_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_calls_status_valid'
  ) THEN
    ALTER TABLE scheduled_calls
      ADD CONSTRAINT scheduled_calls_status_valid
      CHECK (status IN ('pending', 'dialing', 'done', 'failed', 'canceled', 'indeterminate'))
      NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_calls_claim_lifecycle_valid'
  ) THEN
    ALTER TABLE scheduled_calls
      ADD CONSTRAINT scheduled_calls_claim_lifecycle_valid CHECK (
        (
          status = 'pending'
          AND claim_token IS NULL
          AND claimed_at IS NULL
          AND claim_lease_expires_at IS NULL
          AND dispatch_started_at IS NULL
          AND completed_call_id IS NULL
        )
        OR (
          status = 'dialing'
          AND claim_token IS NOT NULL
          AND claimed_at IS NOT NULL
          AND claim_lease_expires_at > claimed_at
          AND (completed_call_id IS NULL OR dispatch_started_at IS NOT NULL)
        )
        OR (
          status = 'done'
          AND claim_token IS NULL
          AND claim_lease_expires_at IS NULL
          AND (
            authority_manifest IS NULL
            OR (dispatch_started_at IS NOT NULL AND completed_call_id IS NOT NULL)
          )
        )
        OR (
          status = 'indeterminate'
          AND claim_token IS NULL
          AND claim_lease_expires_at IS NULL
          AND dispatch_started_at IS NOT NULL
          AND (completed_call_id IS NOT NULL OR authority_manifest IS NULL)
        )
        OR (
          status = 'failed'
          AND claim_token IS NULL
          AND claim_lease_expires_at IS NULL
        )
        OR (
          status = 'canceled'
          AND claim_token IS NULL
          AND claim_lease_expires_at IS NULL
          AND dispatch_started_at IS NULL
          AND completed_call_id IS NULL
        )
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_calls_authority_binding_valid'
  ) THEN
    ALTER TABLE scheduled_calls
      ADD CONSTRAINT scheduled_calls_authority_binding_valid CHECK (
        (operator_execution_id IS NULL) = (operator_arguments_sha256 IS NULL)
        AND (operator_arguments_sha256 IS NULL OR operator_arguments_sha256 ~ '^[a-f0-9]{64}$')
        AND (runtime_snapshot IS NULL) = (runtime_digest IS NULL)
        AND (runtime_digest IS NULL OR runtime_digest ~ '^[a-f0-9]{64}$')
        AND (target_set_sha256 IS NULL OR target_set_sha256 ~ '^[a-f0-9]{64}$')
        AND (authority_manifest IS NULL OR jsonb_typeof(authority_manifest) = 'object')
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_calls_executable_authority_valid'
  ) THEN
    ALTER TABLE scheduled_calls
      ADD CONSTRAINT scheduled_calls_executable_authority_valid CHECK (
        status NOT IN ('pending', 'dialing')
        OR (
          operator_execution_id IS NOT NULL
          AND operator_arguments_sha256 IS NOT NULL
          AND runtime_snapshot IS NOT NULL
          AND jsonb_typeof(runtime_snapshot) = 'object'
          AND runtime_digest IS NOT NULL
          AND agent_version IS NOT NULL
          AND agent_version > 0
          AND authority_manifest IS NOT NULL
          AND authority_manifest = jsonb_build_object(
            'v', 1,
            'capability', authority_manifest->'capability',
            'callId', id::text,
            'orgId', org_id::text,
            'operatorExecutionId', operator_execution_id::text,
            'operatorArgumentsSha256', operator_arguments_sha256,
            'runtimeDigest', runtime_digest,
            'targetSetSha256', CASE
              WHEN target_set_sha256 IS NULL THEN 'null'::jsonb
              ELSE to_jsonb(target_set_sha256)
            END,
            'agentVersion', agent_version,
            'flowId', CASE
              WHEN flow_id IS NULL THEN 'null'::jsonb
              ELSE to_jsonb(flow_id::text)
            END,
            'campaignId', CASE
              WHEN campaign_id IS NULL THEN 'null'::jsonb
              ELSE to_jsonb(campaign_id::text)
            END
          )
          AND jsonb_typeof(authority_manifest->'capability') = 'string'
          AND length(authority_manifest->>'capability') BETWEEN 1 AND 64
        )
      ) NOT VALID;
  END IF;
END
$constraints$;

ALTER TABLE scheduled_calls VALIDATE CONSTRAINT scheduled_calls_status_valid;
ALTER TABLE scheduled_calls VALIDATE CONSTRAINT scheduled_calls_claim_lifecycle_valid;
ALTER TABLE scheduled_calls VALIDATE CONSTRAINT scheduled_calls_authority_binding_valid;
ALTER TABLE scheduled_calls VALIDATE CONSTRAINT scheduled_calls_executable_authority_valid;

DO $campaign_status$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_status_valid'
  ) THEN
    ALTER TABLE campaigns
      ADD CONSTRAINT campaigns_status_valid
      CHECK (status IN ('scheduled', 'running', 'done', 'canceled', 'indeterminate'))
      NOT VALID;
    ALTER TABLE campaigns VALIDATE CONSTRAINT campaigns_status_valid;
  END IF;
END
$campaign_status$;

CREATE INDEX IF NOT EXISTS idx_scheduled_calls_reclaimable_lease
  ON scheduled_calls(claim_lease_expires_at, run_at, id)
  WHERE status = 'dialing' AND dispatch_started_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_calls_completed_call
  ON scheduled_calls(completed_call_id)
  WHERE completed_call_id IS NOT NULL;

COMMENT ON COLUMN scheduled_calls.claim_token IS
  'Unforgeable ownership token for one dialer claim; every settlement update must match it.';
COMMENT ON COLUMN scheduled_calls.claim_lease_expires_at IS
  'Only pre-dispatch claims may be reclaimed after this instant.';
COMMENT ON COLUMN scheduled_calls.dispatch_started_at IS
  'Irreversible external-effect boundary. Non-null rows must never be automatically redialed.';
COMMENT ON COLUMN calls.scheduled_call_id IS
  'Stable reserve-before-dispatch identity; unique across calls to suppress duplicate dialing.';
COMMENT ON COLUMN scheduled_calls.runtime_digest IS
  'Digest of the immutable CallRuntimeSnapshot captured when this effect was authorized.';
COMMENT ON COLUMN scheduled_calls.authority_manifest IS
  'Canonical non-secret authorization and target provenance; never a bearer credential.';

CREATE OR REPLACE FUNCTION reject_scheduled_call_authority_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $scheduled_immutable$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.agent_version IS DISTINCT FROM OLD.agent_version
     OR NEW.to_number IS DISTINCT FROM OLD.to_number
     OR NEW.run_at IS DISTINCT FROM OLD.run_at
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.parent_call_id IS DISTINCT FROM OLD.parent_call_id
     OR NEW.flow_id IS DISTINCT FROM OLD.flow_id
     OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.operator_execution_id IS DISTINCT FROM OLD.operator_execution_id
     OR NEW.operator_arguments_sha256 IS DISTINCT FROM OLD.operator_arguments_sha256
     OR NEW.runtime_snapshot IS DISTINCT FROM OLD.runtime_snapshot
     OR NEW.runtime_digest IS DISTINCT FROM OLD.runtime_digest
     OR NEW.target_set_sha256 IS DISTINCT FROM OLD.target_set_sha256
     OR NEW.authority_manifest IS DISTINCT FROM OLD.authority_manifest THEN
    RAISE EXCEPTION 'scheduled-call authority and target identity are immutable';
  END IF;
  IF OLD.dispatch_started_at IS NOT NULL
     AND NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at THEN
    RAISE EXCEPTION 'scheduled-call dispatch boundary is write-once';
  END IF;
  IF OLD.completed_call_id IS NOT NULL
     AND NEW.completed_call_id IS DISTINCT FROM OLD.completed_call_id THEN
    RAISE EXCEPTION 'scheduled-call completion identity is write-once';
  END IF;
  IF OLD.status IN ('done', 'failed', 'canceled', 'indeterminate')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'terminal scheduled-call status is immutable';
  END IF;
  IF OLD.dispatch_started_at IS NOT NULL AND NEW.status = 'pending' THEN
    RAISE EXCEPTION 'a dispatched scheduled call cannot return to pending';
  END IF;
  RETURN NEW;
END
$scheduled_immutable$;

DROP TRIGGER IF EXISTS trg_scheduled_call_authority_immutable ON scheduled_calls;
CREATE TRIGGER trg_scheduled_call_authority_immutable
BEFORE UPDATE ON scheduled_calls
FOR EACH ROW EXECUTE FUNCTION reject_scheduled_call_authority_mutation();

-- Remove every ambient PostgREST/public grant before adding explicit server
-- capabilities. service_role may have BYPASSRLS on hosted platforms, so the
-- object-level revoke is an independent and required boundary.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

DO $api_revokes$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I', api_role);
      IF pg_has_role(api_role, 'hacc_backend', 'member')
         OR pg_has_role(api_role, 'hacc_worker', 'member') THEN
        RAISE EXCEPTION 'API role % must not inherit a HACC server role', api_role;
      END IF;
    END IF;
  END LOOP;
END
$api_revokes$;

GRANT USAGE ON SCHEMA public TO hacc_backend, hacc_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hacc_backend;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO hacc_backend;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO hacc_backend;

-- Future objects created by this exact migration owner preserve the same
-- default-deny API boundary. Deployments that use a different future DDL role
-- must repeat these ALTER DEFAULT PRIVILEGES statements for that grantor.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hacc_backend;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO hacc_backend;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO hacc_backend;

DO $api_default_revokes$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', api_role);
    END IF;
  END LOOP;
END
$api_default_revokes$;

-- Every sensitive table created through migration 012 is forced through RLS.
-- The migration owner gets an explicit policy so later schema backfills do not
-- silently see zero rows. Production runtime assertions reject table owners.
DO $rls$
DECLARE
  table_name text;
  protected_tables constant text[] := ARRAY[
    'auth_codes',
    'sessions_auth',
    'phone_codes',
    'orgs',
    'users',
    'agents',
    'agent_versions',
    'tools',
    'tool_deployments',
    'tool_invocation_revisions',
    'mcp_servers',
    'env_vars',
    'calls',
    'call_events',
    'call_recordings',
    'scheduled_calls',
    'chat_messages',
    'surfaces',
    'logs',
    'documents',
    'doc_chunks',
    'experiments',
    'datasets',
    'dataset_rows',
    'screens',
    'media_renditions',
    'call_tasks',
    'flows',
    'campaigns',
    'flow_runs',
    'flow_action_receipts',
    'flow_action_reconciliation_proofs'
  ];
BEGIN
  FOREACH table_name IN ARRAY protected_tables LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN
      RAISE EXCEPTION 'tenant-isolation inventory is missing required table %', table_name;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS hacc_backend_all ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY hacc_backend_all ON public.%I FOR ALL TO hacc_backend USING (true) WITH CHECK (true)',
      table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS hacc_migration_owner_all ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY hacc_migration_owner_all ON public.%I FOR ALL TO %I USING (true) WITH CHECK (true)',
      table_name,
      current_user
    );
  END LOOP;
END
$rls$;

-- The dialer policy graph is intentionally closed: every parent table used by
-- a child-policy/query has a worker SELECT policy. UPDATE policies use an
-- explicit WITH CHECK so pending -> dialing -> terminal transitions do not
-- inherit a stale USING predicate and fail mysteriously.
GRANT SELECT ON agents TO hacc_worker;
GRANT SELECT, INSERT, UPDATE ON calls TO hacc_worker;
GRANT SELECT, UPDATE ON scheduled_calls TO hacc_worker;
GRANT SELECT, UPDATE ON campaigns TO hacc_worker;

CREATE POLICY hacc_worker_agents_select
  ON agents FOR SELECT TO hacc_worker USING (true);

CREATE POLICY hacc_worker_calls_select
  ON calls FOR SELECT TO hacc_worker
  USING (scheduled_call_id IS NOT NULL);
CREATE POLICY hacc_worker_calls_insert
  ON calls FOR INSERT TO hacc_worker
  WITH CHECK (scheduled_call_id IS NOT NULL);
CREATE POLICY hacc_worker_calls_update
  ON calls FOR UPDATE TO hacc_worker
  USING (scheduled_call_id IS NOT NULL)
  WITH CHECK (scheduled_call_id IS NOT NULL);

CREATE POLICY hacc_worker_scheduled_calls_select
  ON scheduled_calls FOR SELECT TO hacc_worker USING (true);
CREATE POLICY hacc_worker_scheduled_calls_update
  ON scheduled_calls FOR UPDATE TO hacc_worker
  USING (status IN ('pending', 'dialing'))
  WITH CHECK (status IN ('pending', 'dialing', 'done', 'failed', 'indeterminate'));

CREATE POLICY hacc_worker_campaigns_select
  ON campaigns FOR SELECT TO hacc_worker USING (true);
CREATE POLICY hacc_worker_campaigns_update
  ON campaigns FOR UPDATE TO hacc_worker
  USING (status IN ('scheduled', 'running'))
  WITH CHECK (status IN ('scheduled', 'running', 'done', 'canceled', 'indeterminate'));

-- Private credential envelopes are not PostgREST data, but the new non-owner
-- runtime role still needs explicit access. Force RLS here as defense in depth.
REVOKE ALL ON SCHEMA hacc_private FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA hacc_private FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hacc_private FROM PUBLIC;
GRANT USAGE ON SCHEMA hacc_private TO hacc_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hacc_private TO hacc_backend;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA hacc_private TO hacc_backend;

DO $private_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['credential_ingest_slots'] LOOP
    EXECUTE format('ALTER TABLE hacc_private.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE hacc_private.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS hacc_backend_all ON hacc_private.%I', table_name);
    EXECUTE format(
      'CREATE POLICY hacc_backend_all ON hacc_private.%I FOR ALL TO hacc_backend USING (true) WITH CHECK (true)',
      table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS hacc_migration_owner_all ON hacc_private.%I', table_name);
    EXECUTE format(
      'CREATE POLICY hacc_migration_owner_all ON hacc_private.%I FOR ALL TO %I USING (true) WITH CHECK (true)',
      table_name,
      current_user
    );
  END LOOP;
END
$private_rls$;

DO $private_api_revokes$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA hacc_private FROM %I', api_role);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA hacc_private FROM %I', api_role);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hacc_private FROM %I', api_role);
    END IF;
  END LOOP;
END
$private_api_revokes$;

-- The shared arbitrary-SQL schema is never granted to browser/API/worker
-- roles. hacc_backend access exists only for an explicitly isolated,
-- single-tenant operator-SQL deployment; application code defaults it off and
-- proves exactly one matching org before any SQL is accepted.
REVOKE ALL ON SCHEMA agent_data FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA agent_data TO hacc_backend;

-- Role comments are operational metadata, not an authorization control. On a
-- shared cluster the database-local migration owner may legitimately lack
-- ADMIN OPTION on pre-provisioned cluster roles, so do not make the database
-- migration depend on the ability to mutate cluster-global comments.
DO $role_comments$
BEGIN
  BEGIN
    COMMENT ON ROLE hacc_backend IS
      'Server-only non-owner application role. Never expose its login membership or connection URL to a browser/model/provider.';
    COMMENT ON ROLE hacc_worker IS
      'Cross-tenant dialer role limited to leased scheduled-call admission and its reserved call/campaign rows.';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$role_comments$;

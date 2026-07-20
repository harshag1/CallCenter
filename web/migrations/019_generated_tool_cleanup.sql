-- 019_generated_tool_cleanup.sql
-- Durable deletion lifecycle for revision-isolated generated-tool projects.
-- Provider responses, access tokens, env values, and raw error text never enter this table.

CREATE TABLE IF NOT EXISTS hacc_private.generated_tool_cleanup_jobs (
  key_id text PRIMARY KEY
    REFERENCES public.tool_invocation_revisions(key_id) ON DELETE RESTRICT,
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE RESTRICT,
  deployment_project text NOT NULL
    CHECK (deployment_project ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  status text NOT NULL DEFAULT 'cleanup_required'
    CHECK (status IN ('protected', 'cleanup_required', 'cleaning', 'cleaned')),
  reason_code text NOT NULL DEFAULT 'staging'
    CHECK (reason_code IN ('staging', 'deploy_failed', 'superseded', 'retired')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  last_error_code text
    CHECK (last_error_code IS NULL OR last_error_code = 'provider_cleanup_failed'),
  cleaned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Vercel project names are account-global external identities. One project can never be
  -- co-owned by two tenants, even if a future hashing/configuration bug produces an alias.
  UNIQUE (deployment_project),
  CHECK (
    (status = 'protected'
      AND claim_token IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL
      AND cleaned_at IS NULL)
    OR
    (status = 'cleanup_required'
      AND claim_token IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL
      AND cleaned_at IS NULL)
    OR
    (status = 'cleaning'
      AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL
      AND claim_expires_at > claimed_at
      AND claim_expires_at <= claimed_at + interval '10 minutes'
      AND cleaned_at IS NULL)
    OR
    (status = 'cleaned'
      AND claim_token IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL
      AND cleaned_at IS NOT NULL)
  )
);

COMMENT ON TABLE hacc_private.generated_tool_cleanup_jobs IS
  'Non-secret durable deletion state for one revision-isolated provider project. cleanup_required with attempts=8 requires operator intervention.';
COMMENT ON COLUMN hacc_private.generated_tool_cleanup_jobs.last_error_code IS
  'Bounded public failure class only; provider bodies, credentials, and raw exception text are forbidden.';

CREATE INDEX IF NOT EXISTS idx_generated_tool_cleanup_due
  ON hacc_private.generated_tool_cleanup_jobs(next_attempt_at, created_at)
  WHERE status = 'cleanup_required' AND attempts < 8;
CREATE INDEX IF NOT EXISTS idx_generated_tool_cleanup_stale_claim
  ON hacc_private.generated_tool_cleanup_jobs(claim_expires_at)
  WHERE status = 'cleaning';

-- A revision row is written before any provider operation. The paired cleanup row is therefore
-- crash-safe even if the process dies immediately after uploading environment values.
CREATE OR REPLACE FUNCTION hacc_private.enqueue_generated_tool_cleanup()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, hacc_private
AS $$
DECLARE
  revision_org_id uuid;
BEGIN
  SELECT tools.org_id INTO STRICT revision_org_id
  FROM public.tools AS tools
  WHERE tools.id = NEW.tool_id;

  INSERT INTO hacc_private.generated_tool_cleanup_jobs
    (key_id, org_id, deployment_project, status, reason_code, next_attempt_at)
  VALUES
    (NEW.key_id, revision_org_id, NEW.deployment_project,
     'cleanup_required', 'staging', statement_timestamp() + interval '10 minutes')
  ON CONFLICT (key_id) DO NOTHING;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_enqueue_generated_tool_cleanup
  ON public.tool_invocation_revisions;
CREATE TRIGGER trg_enqueue_generated_tool_cleanup
AFTER INSERT ON public.tool_invocation_revisions
FOR EACH ROW EXECUTE FUNCTION hacc_private.enqueue_generated_tool_cleanup();

-- Backfill prerelease revisions without resetting an already-created job. Live revisions remain
-- protected. Retired revisions get a 24-hour grace from deployment for call-pinned executions.
INSERT INTO hacc_private.generated_tool_cleanup_jobs
  (key_id, org_id, deployment_project, status, reason_code, next_attempt_at)
SELECT revisions.key_id,
       tools.org_id,
       revisions.deployment_project,
       CASE WHEN revisions.status = 'live' THEN 'protected' ELSE 'cleanup_required' END,
       CASE
         WHEN revisions.status = 'retired' THEN 'retired'
         WHEN revisions.status = 'failed' THEN 'deploy_failed'
         ELSE 'staging'
       END,
       CASE
         WHEN revisions.status = 'retired'
           THEN GREATEST(statement_timestamp(), COALESCE(revisions.deployed_at, revisions.created_at) + interval '24 hours')
         WHEN revisions.status = 'deploying'
           THEN statement_timestamp() + interval '10 minutes'
         ELSE statement_timestamp()
       END
FROM public.tool_invocation_revisions AS revisions
JOIN public.tools AS tools ON tools.id = revisions.tool_id
ON CONFLICT (key_id) DO NOTHING;

ALTER TABLE hacc_private.generated_tool_cleanup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hacc_private.generated_tool_cleanup_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hacc_backend_all ON hacc_private.generated_tool_cleanup_jobs;
CREATE POLICY hacc_backend_all ON hacc_private.generated_tool_cleanup_jobs
  FOR ALL TO hacc_backend USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS hacc_migration_owner_all ON hacc_private.generated_tool_cleanup_jobs;
DO $policy$
BEGIN
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON hacc_private.generated_tool_cleanup_jobs FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$policy$;

REVOKE ALL ON hacc_private.generated_tool_cleanup_jobs FROM PUBLIC;
GRANT USAGE ON SCHEMA hacc_private TO hacc_backend;
GRANT SELECT, INSERT, UPDATE ON hacc_private.generated_tool_cleanup_jobs TO hacc_backend;

DO $api_revokes$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'hacc_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON hacc_private.generated_tool_cleanup_jobs FROM %I', api_role);
    END IF;
  END LOOP;
END
$api_revokes$;

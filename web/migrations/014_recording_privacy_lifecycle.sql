-- Consent-bound recording retention, deletion audit, and bounded lifecycle purge.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS consent_id uuid,
  ADD COLUMN IF NOT EXISTS consent_granted_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_notice_version text,
  ADD COLUMN IF NOT EXISTS retained_until timestamptz,
  ADD COLUMN IF NOT EXISTS byte_length bigint,
  ADD COLUMN IF NOT EXISTS sha256 text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE call_recordings
SET retained_until = COALESCE(retained_until, created_at + interval '30 days'),
    byte_length = COALESCE(byte_length, octet_length(data)),
    sha256 = COALESCE(sha256, encode(digest(data, 'sha256'), 'hex'))
WHERE retained_until IS NULL OR byte_length IS NULL OR sha256 IS NULL;

ALTER TABLE call_recordings
  ALTER COLUMN retained_until SET DEFAULT (now() + interval '30 days'),
  ALTER COLUMN retained_until SET NOT NULL,
  ALTER COLUMN byte_length SET DEFAULT 0,
  ALTER COLUMN byte_length SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE call_recordings ADD CONSTRAINT call_recordings_retention_bound
    CHECK (retained_until >= created_at AND retained_until <= updated_at + interval '365 days');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE call_recordings ADD CONSTRAINT call_recordings_byte_length_bound
    CHECK (byte_length >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE call_recordings ADD CONSTRAINT call_recordings_sha256_shape
    CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_call_recordings_retention
  ON call_recordings (retained_until, call_id);

CREATE TABLE IF NOT EXISTS call_recording_deletions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id uuid NOT NULL,
  org_id uuid,
  reason text NOT NULL,
  actor text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  consent_id uuid,
  retained_until timestamptz,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE call_recording_deletions
  DROP CONSTRAINT IF EXISTS call_recording_deletions_reason_check;
ALTER TABLE call_recording_deletions
  ADD CONSTRAINT call_recording_deletions_reason_check
  CHECK (reason IN ('retention_expired', 'user_deleted', 'call_deleted', 'replaced'));
CREATE INDEX IF NOT EXISTS idx_call_recording_deletions_call
  ON call_recording_deletions (call_id, deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_recording_deletions_org
  ON call_recording_deletions (org_id, deleted_at DESC);

-- Migration 013 can only enable RLS on tables that already exist. This ledger
-- is created later and contains cross-tenant deletion evidence, so establish
-- the same forced-RLS boundary here instead of relying on default privileges.
ALTER TABLE call_recording_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_recording_deletions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hacc_backend_all ON call_recording_deletions;
CREATE POLICY hacc_backend_all ON call_recording_deletions
  FOR ALL TO hacc_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS hacc_migration_owner_all ON call_recording_deletions;
DO $recording_deletion_owner_policy$
BEGIN
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON public.call_recording_deletions '
    'FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$recording_deletion_owner_policy$;

REVOKE ALL ON call_recording_deletions FROM PUBLIC;
REVOKE ALL ON call_recording_deletions FROM hacc_worker;
REVOKE ALL ON SEQUENCE call_recording_deletions_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE call_recording_deletions_id_seq FROM hacc_worker;

REVOKE UPDATE, DELETE ON call_recording_deletions FROM hacc_backend;
GRANT SELECT, INSERT ON call_recording_deletions TO hacc_backend;
REVOKE UPDATE ON SEQUENCE call_recording_deletions_id_seq FROM hacc_backend;
GRANT USAGE, SELECT ON SEQUENCE call_recording_deletions_id_seq TO hacc_backend;

DO $recording_deletion_api_revokes$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.call_recording_deletions FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.call_recording_deletions_id_seq FROM %I', api_role);
    END IF;
  END LOOP;
END
$recording_deletion_api_revokes$;

CREATE OR REPLACE FUNCTION reject_call_recording_deletion_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'call_recording_deletions is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_reject_call_recording_deletion_mutation ON call_recording_deletions;
CREATE TRIGGER trg_reject_call_recording_deletion_mutation
  BEFORE UPDATE OR DELETE ON call_recording_deletions
  FOR EACH ROW EXECUTE FUNCTION reject_call_recording_deletion_mutation();

CREATE OR REPLACE FUNCTION audit_call_recording_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  deletion_reason text := COALESCE(NULLIF(current_setting('hacc.recording_delete_reason', true), ''), 'user_deleted');
  deletion_actor text := COALESCE(NULLIF(current_setting('hacc.recording_delete_actor', true), ''), 'database_delete_trigger');
  recording_org_id uuid;
BEGIN
  IF deletion_reason NOT IN ('retention_expired', 'user_deleted', 'call_deleted') THEN
    deletion_reason := 'user_deleted';
    deletion_actor := 'database_delete_trigger';
  END IF;
  SELECT a.org_id INTO recording_org_id
  FROM calls c JOIN agents a ON a.id = c.agent_id
  WHERE c.id = OLD.call_id;
  INSERT INTO call_recording_deletions (
    call_id, org_id, reason, actor, byte_length, sha256, consent_id, retained_until
  ) VALUES (
    OLD.call_id, recording_org_id, deletion_reason, deletion_actor,
    octet_length(OLD.data)::bigint, OLD.sha256, OLD.consent_id, OLD.retained_until
  );
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_call_recording_delete ON call_recordings;
CREATE TRIGGER trg_audit_call_recording_delete
  BEFORE DELETE ON call_recordings
  FOR EACH ROW EXECUTE FUNCTION audit_call_recording_delete();

CREATE OR REPLACE FUNCTION audit_call_recording_cascade()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('hacc.recording_delete_reason', 'call_deleted', true);
  PERFORM set_config('hacc.recording_delete_actor', 'calls_delete_cascade', true);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_call_recording_cascade ON calls;
CREATE TRIGGER trg_audit_call_recording_cascade
  BEFORE DELETE ON calls
  FOR EACH ROW EXECUTE FUNCTION audit_call_recording_cascade();

CREATE OR REPLACE FUNCTION purge_expired_call_recordings(batch_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  purged integer := 0;
BEGIN
  IF batch_limit < 1 OR batch_limit > 5000 THEN
    RAISE EXCEPTION 'batch_limit must be between 1 and 5000';
  END IF;

  PERFORM set_config('hacc.recording_delete_reason', 'retention_expired', true);
  PERFORM set_config('hacc.recording_delete_actor', 'retention_worker', true);

  WITH targets AS (
    SELECT r.call_id
    FROM call_recordings r
    JOIN calls c ON c.id = r.call_id
    JOIN agents a ON a.id = c.agent_id
    WHERE r.retained_until <= now()
    ORDER BY r.retained_until, r.call_id
    LIMIT batch_limit
    FOR UPDATE OF r SKIP LOCKED
  ), deleted AS (
    DELETE FROM call_recordings r
    USING targets t
    WHERE r.call_id = t.call_id
    RETURNING r.call_id
  ), cleared AS (
    UPDATE calls c SET recording_path = NULL
    WHERE c.id IN (SELECT call_id FROM deleted)
    RETURNING c.id
  )
  SELECT count(*) INTO purged FROM deleted;

  RETURN purged;
END;
$$;

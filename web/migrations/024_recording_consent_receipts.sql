-- One affirmative browser action can authorize at most one call recording.
-- Receipt rows are deliberately not foreign-keyed to calls/orgs: deleting an
-- application row must never make a previously consumed receipt reusable.

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS consent_receipt_hmac_sha256 text;

DO $$ BEGIN
  ALTER TABLE call_recordings ADD CONSTRAINT call_recordings_receipt_hmac_shape
    CHECK (consent_receipt_hmac_sha256 IS NULL OR consent_receipt_hmac_sha256 ~ '^[a-f0-9]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE call_recording_deletions
  ADD COLUMN IF NOT EXISTS consent_receipt_hmac_sha256 text;

DO $$ BEGIN
  ALTER TABLE call_recording_deletions ADD CONSTRAINT call_recording_deletions_receipt_hmac_shape
    CHECK (consent_receipt_hmac_sha256 IS NULL OR consent_receipt_hmac_sha256 ~ '^[a-f0-9]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS recording_consent_receipts (
  org_id uuid NOT NULL,
  receipt_hmac_sha256 text PRIMARY KEY,
  call_id uuid NOT NULL UNIQUE,
  granted_at timestamptz NOT NULL,
  notice_version text NOT NULL,
  retention_days integer NOT NULL,
  source text NOT NULL DEFAULT 'authenticated_web_session',
  upload_token_hash text NOT NULL,
  upload_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recording_consent_receipts_grant_window CHECK (
    granted_at >= created_at - interval '15 minutes'
    AND granted_at <= created_at + interval '1 minute'
  ),
  CONSTRAINT recording_consent_receipts_notice_shape CHECK (
    notice_version = 'recording-v1'
  ),
  CONSTRAINT recording_consent_receipts_retention_bound CHECK (
    retention_days BETWEEN 1 AND 365
  ),
  CONSTRAINT recording_consent_receipts_source CHECK (
    source = 'authenticated_web_session'
  ),
  CONSTRAINT recording_consent_receipts_hash_shape CHECK (
    upload_token_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT recording_consent_receipts_receipt_hmac_shape CHECK (
    receipt_hmac_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT recording_consent_receipts_upload_expiry CHECK (
    upload_expires_at = granted_at + interval '2 hours'
  )
);

ALTER TABLE recording_consent_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE recording_consent_receipts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hacc_backend_all ON recording_consent_receipts;
CREATE POLICY hacc_backend_all ON recording_consent_receipts
  FOR ALL TO hacc_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS hacc_migration_owner_all ON recording_consent_receipts;
DO $recording_consent_receipt_owner_policy$
BEGIN
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON public.recording_consent_receipts '
    'FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$recording_consent_receipt_owner_policy$;

REVOKE ALL ON recording_consent_receipts FROM PUBLIC;
REVOKE ALL ON recording_consent_receipts FROM hacc_worker;
REVOKE UPDATE, DELETE ON recording_consent_receipts FROM hacc_backend;
GRANT SELECT, INSERT ON recording_consent_receipts TO hacc_backend;

DO $recording_consent_receipt_api_revokes$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.recording_consent_receipts FROM %I', api_role);
    END IF;
  END LOOP;
END
$recording_consent_receipt_api_revokes$;

CREATE OR REPLACE FUNCTION reject_recording_consent_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'recording_consent_receipts is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_reject_recording_consent_receipt_mutation ON recording_consent_receipts;
CREATE TRIGGER trg_reject_recording_consent_receipt_mutation
  BEFORE UPDATE OR DELETE ON recording_consent_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_recording_consent_receipt_mutation();

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
    call_id, org_id, reason, actor, byte_length, sha256, consent_id,
    consent_receipt_hmac_sha256, retained_until
  ) VALUES (
    OLD.call_id, recording_org_id, deletion_reason, deletion_actor,
    octet_length(OLD.data)::bigint, OLD.sha256, OLD.consent_id,
    OLD.consent_receipt_hmac_sha256, OLD.retained_until
  );
  RETURN OLD;
END;
$$;

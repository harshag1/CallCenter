-- Purge pre-consent or incorrectly bound audio left by legacy upgrades, then
-- make an exact durable consent receipt mandatory for every stored recording.
-- Raw audio is never quarantined: only the existing hash/size deletion ledger
-- survives the corrective purge.

CREATE OR REPLACE FUNCTION audit_call_recording_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  deletion_reason text := COALESCE(
    NULLIF(current_setting('hacc.recording_delete_reason', true), ''),
    'user_deleted'
  );
  deletion_actor text := COALESCE(
    NULLIF(current_setting('hacc.recording_delete_actor', true), ''),
    'database_delete_trigger'
  );
  recording_org_id uuid;
BEGIN
  IF deletion_reason NOT IN (
    'retention_expired',
    'user_deleted',
    'call_deleted'
  ) THEN
    deletion_reason := 'user_deleted';
    deletion_actor := 'database_delete_trigger';
  END IF;
  SELECT agent.org_id INTO recording_org_id
  FROM calls call
  JOIN agents agent ON agent.id = call.agent_id
  WHERE call.id = OLD.call_id;
  INSERT INTO call_recording_deletions (
    call_id,
    org_id,
    reason,
    actor,
    byte_length,
    sha256,
    consent_id,
    consent_receipt_hmac_sha256,
    retained_until
  ) VALUES (
    OLD.call_id,
    recording_org_id,
    deletion_reason,
    deletion_actor,
    octet_length(OLD.data)::bigint,
    OLD.sha256,
    OLD.consent_id,
    OLD.consent_receipt_hmac_sha256,
    OLD.retained_until
  );
  RETURN OLD;
END;
$$;

SELECT set_config(
  'hacc.recording_delete_reason',
  'user_deleted',
  true
);
SELECT set_config(
  'hacc.recording_delete_actor',
  'migration_029_consent_authority_upgrade',
  true
);

WITH invalid_recordings AS (
  SELECT recording.call_id
  FROM call_recordings recording
  LEFT JOIN calls call
    ON call.id = recording.call_id
  LEFT JOIN agents agent
    ON agent.id = call.agent_id
  LEFT JOIN recording_consent_receipts receipt
    ON receipt.receipt_hmac_sha256 = recording.consent_receipt_hmac_sha256
   AND receipt.call_id = recording.call_id
   AND receipt.granted_at = recording.consent_granted_at
   AND receipt.notice_version = recording.consent_notice_version
   AND receipt.org_id = agent.org_id
  WHERE recording.consent_id IS NOT NULL
     OR recording.consent_receipt_hmac_sha256 IS NULL
     OR recording.consent_granted_at IS NULL
     OR recording.consent_notice_version IS NULL
     OR receipt.receipt_hmac_sha256 IS NULL
     OR call.direction IS DISTINCT FROM 'web'
     OR recording.created_at < receipt.granted_at
     OR recording.retained_until <= receipt.granted_at
     OR recording.retained_until >
        receipt.granted_at + make_interval(days => receipt.retention_days)
  FOR UPDATE OF recording
), deleted AS (
  DELETE FROM call_recordings recording
  USING invalid_recordings invalid
  WHERE recording.call_id = invalid.call_id
  RETURNING recording.call_id
), cleared AS (
  UPDATE calls call
  SET recording_path = NULL
  WHERE call.id IN (SELECT call_id FROM deleted)
  RETURNING call.id
)
SELECT count(*) AS purged_unbound_recordings FROM deleted;

ALTER TABLE call_recordings
  ALTER COLUMN consent_receipt_hmac_sha256 SET NOT NULL,
  ALTER COLUMN consent_granted_at SET NOT NULL,
  ALTER COLUMN consent_notice_version SET NOT NULL;

ALTER TABLE call_recordings
  DROP CONSTRAINT IF EXISTS call_recordings_raw_consent_id_absent;
ALTER TABLE call_recordings
  ADD CONSTRAINT call_recordings_raw_consent_id_absent
  CHECK (consent_id IS NULL);

ALTER TABLE call_recordings
  DROP CONSTRAINT IF EXISTS call_recordings_consent_receipt_fk;
ALTER TABLE call_recordings
  ADD CONSTRAINT call_recordings_consent_receipt_fk
  FOREIGN KEY (consent_receipt_hmac_sha256)
  REFERENCES recording_consent_receipts(receipt_hmac_sha256)
  ON UPDATE RESTRICT
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION enforce_call_recording_consent_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  receipt_retention_days integer;
BEGIN
  IF NEW.consent_id IS NOT NULL THEN
    RAISE EXCEPTION 'raw recording consent identifiers are forbidden';
  END IF;

  SELECT receipt.retention_days
  INTO receipt_retention_days
  FROM public.recording_consent_receipts receipt
  JOIN public.calls call
    ON call.id = NEW.call_id
  JOIN public.agents agent
    ON agent.id = call.agent_id
  WHERE receipt.receipt_hmac_sha256 = NEW.consent_receipt_hmac_sha256
    AND receipt.call_id = NEW.call_id
    AND receipt.org_id = agent.org_id
    AND receipt.granted_at = NEW.consent_granted_at
    AND receipt.notice_version = NEW.consent_notice_version
    AND call.direction = 'web';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'recording is not bound to its exact durable web consent receipt';
  END IF;
  IF NEW.created_at < NEW.consent_granted_at THEN
    RAISE EXCEPTION 'recording predates its consent authority';
  END IF;
  IF NEW.retained_until <= NEW.consent_granted_at
     OR NEW.retained_until >
        NEW.consent_granted_at + make_interval(days => receipt_retention_days) THEN
    RAISE EXCEPTION 'recording retention exceeds its exact consent authority';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION enforce_call_recording_consent_authority() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_enforce_call_recording_consent_authority
  ON call_recordings;
CREATE TRIGGER trg_enforce_call_recording_consent_authority
BEFORE INSERT OR UPDATE ON call_recordings
FOR EACH ROW
EXECUTE FUNCTION enforce_call_recording_consent_authority();

COMMENT ON CONSTRAINT call_recordings_consent_receipt_fk ON call_recordings IS
  'Every persisted audio payload has a durable, domain-separated consent receipt HMAC.';
COMMENT ON CONSTRAINT call_recordings_raw_consent_id_absent ON call_recordings IS
  'Raw consent identifiers are forbidden; only the server HMAC receipt binding may persist.';

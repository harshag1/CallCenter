-- Non-authorizing credential form slots live outside Supabase's API-exposed public schema.

CREATE SCHEMA IF NOT EXISTS hacc_private;
REVOKE ALL ON SCHEMA hacc_private FROM PUBLIC;

-- Model-visible credential requests use non-authorizing slots. A slot stores only
-- destination metadata; plaintext and credential bearers are never written here.
CREATE TABLE IF NOT EXISTS hacc_private.credential_ingest_slots (
  slot_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  purpose text NOT NULL
    CHECK (
      length(purpose) BETWEEN 1 AND 128
      AND purpose ~ '^[a-z][A-Za-z0-9_.:/-]*$'
    ),
  sink_kind text NOT NULL CHECK (sink_kind IN ('env_var', 'mcp_server')),
  sink_config jsonb NOT NULL CHECK (jsonb_typeof(sink_config) = 'object'),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'finalizing', 'completed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  claim_token uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  completion_receipt jsonb,
  completion_submission_id uuid,
  completed_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code = 'sink_failed'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '15 minutes'
  ),
  CHECK (
    (state = 'pending'
      AND claim_token IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL
      AND completion_receipt IS NULL AND completion_submission_id IS NULL AND completed_at IS NULL)
    OR
    (state = 'finalizing'
      AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL
      AND claim_expires_at > claimed_at
      AND claim_expires_at <= claimed_at + interval '1 minute'
      AND completion_receipt IS NULL AND completion_submission_id IS NULL AND completed_at IS NULL)
    OR
    (state = 'completed'
      AND claim_token IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL
      AND completion_receipt IS NOT NULL AND jsonb_typeof(completion_receipt) = 'object'
      AND completion_submission_id IS NOT NULL
      AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_credential_ingest_slots_org_state_expiry
  ON hacc_private.credential_ingest_slots(org_id, state, expires_at);

CREATE INDEX IF NOT EXISTS idx_credential_ingest_slots_expiry
  ON hacc_private.credential_ingest_slots(expires_at);

COMMENT ON TABLE hacc_private.credential_ingest_slots IS
  'Non-authorizing, org-bound credential form slots. Contains destination metadata and non-secret completion receipts only.';
COMMENT ON COLUMN hacc_private.credential_ingest_slots.slot_id IS
  'Public correlation identifier with no secret read or sink-finalize authority.';
COMMENT ON COLUMN hacc_private.credential_ingest_slots.sink_config IS
  'Validated non-secret destination configuration; plaintext credentials and credential references are forbidden.';
COMMENT ON COLUMN hacc_private.credential_ingest_slots.completion_submission_id IS
  'Browser-generated idempotency identity; only the same submission may replay a completed receipt.';

REVOKE ALL ON hacc_private.credential_ingest_slots FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA hacc_private FROM anon;
    REVOKE ALL ON hacc_private.credential_ingest_slots FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA hacc_private FROM authenticated;
    REVOKE ALL ON hacc_private.credential_ingest_slots FROM authenticated;
  END IF;
END $$;

-- These tables existed only in prerelease development. Never leave either a private bearer store
-- or an API-exposed shadow table that a stale app path could accidentally read.
DROP TABLE IF EXISTS hacc_private.credential_ingest_refs;
DROP TABLE IF EXISTS public.credential_ingest_refs;

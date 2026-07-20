-- Context-bound credential encryption, submission idempotency, and tenant-bound sessions.

ALTER TABLE env_vars
  ADD COLUMN IF NOT EXISTS value_encryption_slot_id uuid;

ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS auth_encryption_slot_id uuid;

ALTER TABLE hacc_private.credential_ingest_slots
  ADD COLUMN IF NOT EXISTS completion_submission_id uuid;

DO $credential_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'env_vars_context_bound_ciphertext'
      AND conrelid = 'public.env_vars'::regclass
  ) THEN
    ALTER TABLE env_vars
      ADD CONSTRAINT env_vars_context_bound_ciphertext
      CHECK (
        value_encryption_slot_id IS NOT NULL
        AND value_encrypted LIKE 'hacc_v2:%'
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mcp_auth_context_bound_ciphertext'
      AND conrelid = 'public.mcp_servers'::regclass
  ) THEN
    ALTER TABLE mcp_servers
      ADD CONSTRAINT mcp_auth_context_bound_ciphertext
      CHECK (
        (auth_header_encrypted IS NULL AND auth_encryption_slot_id IS NULL)
        OR
        (auth_header_encrypted LIKE 'hacc_v2:%' AND auth_encryption_slot_id IS NOT NULL)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credential_slot_submission_binding'
      AND conrelid = 'hacc_private.credential_ingest_slots'::regclass
  ) THEN
    ALTER TABLE hacc_private.credential_ingest_slots
      ADD CONSTRAINT credential_slot_submission_binding
      CHECK (
        (state = 'completed' AND completion_submission_id IS NOT NULL)
        OR
        (state <> 'completed' AND completion_submission_id IS NULL)
      ) NOT VALID;
  END IF;
END
$credential_constraints$;

-- Fresh installs validate immediately. Upgrades containing unbound legacy rows
-- remain readable only for explicit inspection; credential runtime rejects them
-- until the operator re-enters env credentials and re-registers authenticated MCP.
DO $validate_fresh_context$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM env_vars
    WHERE value_encryption_slot_id IS NULL OR value_encrypted NOT LIKE 'hacc_v2:%'
  ) THEN
    ALTER TABLE env_vars VALIDATE CONSTRAINT env_vars_context_bound_ciphertext;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mcp_servers
    WHERE NOT (
      (auth_header_encrypted IS NULL AND auth_encryption_slot_id IS NULL)
      OR
      (auth_header_encrypted LIKE 'hacc_v2:%' AND auth_encryption_slot_id IS NOT NULL)
    )
  ) THEN
    ALTER TABLE mcp_servers VALIDATE CONSTRAINT mcp_auth_context_bound_ciphertext;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM hacc_private.credential_ingest_slots
    WHERE (state = 'completed') <> (completion_submission_id IS NOT NULL)
  ) THEN
    ALTER TABLE hacc_private.credential_ingest_slots
      VALIDATE CONSTRAINT credential_slot_submission_binding;
  END IF;
END
$validate_fresh_context$;

COMMENT ON COLUMN env_vars.value_encryption_slot_id IS
  'Trusted slot generation bound into the hacc_v2 AEAD context; NULL identifies legacy ciphertext that runtime rejects.';
COMMENT ON COLUMN mcp_servers.auth_encryption_slot_id IS
  'Trusted slot generation bound into the hacc_v2 AEAD context; NULL with non-NULL auth identifies rejected legacy ciphertext.';
COMMENT ON COLUMN hacc_private.credential_ingest_slots.completion_submission_id IS
  'Browser-generated idempotency identity. A different submission never replays success.';

CREATE INDEX IF NOT EXISTS idx_credential_ingest_slots_org_expiry
  ON hacc_private.credential_ingest_slots(org_id, expires_at);

-- Bind session bearers to the organization present at issuance. Pre-existing
-- rows stored replayable bearer bytes, while the new runtime stores SHA-256
-- token hashes. Revoke those legacy sessions explicitly instead of pretending
-- their token representation is compatible.
ALTER TABLE sessions_auth ADD COLUMN IF NOT EXISTS org_id uuid;
ALTER TABLE sessions_auth ADD COLUMN IF NOT EXISTS token_hash_version smallint;

DELETE FROM sessions_auth WHERE token_hash_version IS NULL;

-- No default: a rolling-deploy instance that still writes raw bearer tokens
-- must fail closed instead of silently labelling those bytes as a hash.
ALTER TABLE sessions_auth ALTER COLUMN token_hash_version DROP DEFAULT;
ALTER TABLE sessions_auth ALTER COLUMN token_hash_version SET NOT NULL;

DO $session_token_hash_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_auth_token_hash_valid'
      AND conrelid = 'public.sessions_auth'::regclass
  ) THEN
    ALTER TABLE sessions_auth
      ADD CONSTRAINT sessions_auth_token_hash_valid
      CHECK (token_hash_version = 1 AND token ~ '^[a-f0-9]{64}$');
  END IF;
END
$session_token_hash_constraint$;

UPDATE sessions_auth sessions
SET org_id = users.org_id
FROM users
WHERE sessions.email = users.email
  AND sessions.org_id IS NULL;

DELETE FROM sessions_auth WHERE org_id IS NULL;

ALTER TABLE sessions_auth ALTER COLUMN org_id SET NOT NULL;

-- A session's identity and tenant are one authority tuple. The runtime already
-- verifies this join; the database now makes a mismatched pair unrepresentable
-- and revokes sessions automatically when the user identity is removed.
DO $user_org_unique$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_email_org_unique'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_email_org_unique UNIQUE (email, org_id);
  END IF;
END
$user_org_unique$;

DELETE FROM sessions_auth sessions
WHERE NOT EXISTS (
  SELECT 1 FROM users
  WHERE users.email = sessions.email
    AND users.org_id = sessions.org_id
);

DO $session_org_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_auth_org_id_fkey'
      AND conrelid = 'public.sessions_auth'::regclass
  ) THEN
    ALTER TABLE sessions_auth
      ADD CONSTRAINT sessions_auth_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE;
  END IF;
END
$session_org_fk$;

DO $session_identity_org_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_auth_email_org_fkey'
      AND conrelid = 'public.sessions_auth'::regclass
  ) THEN
    ALTER TABLE sessions_auth
      ADD CONSTRAINT sessions_auth_email_org_fkey
      FOREIGN KEY (email, org_id)
      REFERENCES users(email, org_id) ON DELETE CASCADE;
  END IF;
END
$session_identity_org_fk$;

CREATE INDEX IF NOT EXISTS idx_sessions_auth_org_email
  ON sessions_auth(org_id, email);

COMMENT ON COLUMN sessions_auth.token IS
  'SHA-256 digest of the browser bearer; raw session bearer bytes are never persisted.';
COMMENT ON COLUMN sessions_auth.token_hash_version IS
  'Session-token storage scheme. Version 1 is a lowercase SHA-256 hex digest.';

-- Rate checks and bounded opportunistic pruning remain indexed as tables grow.
CREATE INDEX IF NOT EXISTS idx_auth_codes_created_at
  ON auth_codes(created_at);
CREATE INDEX IF NOT EXISTS idx_auth_codes_email_created_at
  ON auth_codes(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_codes_expires_at
  ON auth_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_phone_codes_created_at
  ON phone_codes(created_at);
CREATE INDEX IF NOT EXISTS idx_phone_codes_phone_created_at
  ON phone_codes(phone_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_codes_expires_at
  ON phone_codes(expires_at);

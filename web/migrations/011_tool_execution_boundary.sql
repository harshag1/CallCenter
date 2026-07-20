-- Generated tools use one asymmetric invocation key per deployed revision. The encrypted private
-- key remains in the control plane; generated code receives only its public verification key.

ALTER TABLE tools ADD COLUMN IF NOT EXISTS invocation_key_id text;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS invocation_public_key text;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS invocation_private_key_encrypted text;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS deployment_project text;

ALTER TABLE tools DROP CONSTRAINT IF EXISTS tools_invocation_boundary_consistent;
ALTER TABLE tools ADD CONSTRAINT tools_invocation_boundary_consistent CHECK (
  (invocation_key_id IS NULL
   AND invocation_public_key IS NULL
   AND invocation_private_key_encrypted IS NULL
   AND deployment_project IS NULL)
  OR
  -- Reapplying this migration after the public key columns were removed
  -- reconstructs them as NULL. The durable latest-revision pointer is already
  -- the final schema and must remain valid while the migration verifies it.
  (invocation_key_id IS NOT NULL
   AND invocation_public_key IS NULL
   AND invocation_private_key_encrypted IS NULL
   AND deployment_project IS NOT NULL
   AND invocation_key_id ~ '^tik_[A-Za-z0-9_-]{16}$'
   AND deployment_project ~ '^[a-z0-9][a-z0-9-]{0,99}$')
  OR
  (invocation_key_id IS NOT NULL
   AND invocation_public_key IS NOT NULL
   AND invocation_private_key_encrypted IS NOT NULL
   AND deployment_project IS NOT NULL
   AND invocation_key_id ~ '^tik_[A-Za-z0-9_-]{16}$'
   AND length(invocation_public_key) BETWEEN 64 AND 512
   AND length(invocation_private_key_encrypted) BETWEEN 64 AND 8192
   AND deployment_project ~ '^[a-z0-9][a-z0-9-]{0,99}$')
);

DROP INDEX IF EXISTS idx_tools_invocation_key_id;
CREATE UNIQUE INDEX idx_tools_invocation_key_id
  ON tools(invocation_key_id)
  WHERE invocation_key_id IS NOT NULL;

-- Key revisions are append-only so a long-running call pinned to an earlier endpoint/key keeps
-- working after the builder redeploys the same logical tool. Runtime lookup must match org,
-- tool_id, key_id, and exact endpoint_url; the mutable tools row is only the latest pointer.
CREATE TABLE IF NOT EXISTS tool_invocation_revisions (
  key_id text PRIMARY KEY CHECK (key_id ~ '^tik_[A-Za-z0-9_-]{16}$'),
  tool_id uuid NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
  public_key text NOT NULL CHECK (length(public_key) BETWEEN 64 AND 512),
  private_key_encrypted text NOT NULL CHECK (length(private_key_encrypted) BETWEEN 64 AND 8192),
  deployment_project text NOT NULL CHECK (deployment_project ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  description text NOT NULL,
  input_schema jsonb NOT NULL,
  source_code text NOT NULL,
  env_var_names text[] NOT NULL DEFAULT '{}',
  created_by text NOT NULL,
  endpoint_url text,
  status text NOT NULL CHECK (status IN ('deploying', 'live', 'failed', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deployed_at timestamptz,
  CHECK (
    (status = 'deploying' AND endpoint_url IS NULL AND deployed_at IS NULL)
    OR (status = 'live' AND endpoint_url IS NOT NULL AND deployed_at IS NOT NULL)
    OR (status IN ('failed', 'retired'))
  )
);

-- Make the append-only retention contract explicit on prerelease databases that created this
-- foreign key with CASCADE. Deleting a mutable tool pointer must never erase signing evidence.
ALTER TABLE tool_invocation_revisions
  DROP CONSTRAINT IF EXISTS tool_invocation_revisions_tool_id_fkey;
ALTER TABLE tool_invocation_revisions
  ADD CONSTRAINT tool_invocation_revisions_tool_id_fkey
  FOREIGN KEY (tool_id) REFERENCES tools(id) ON DELETE RESTRICT;

-- A manual prerelease reapply may already have the lifecycle trigger. Suspend it only inside the
-- migration transaction while exact legacy rows are verified/backfilled, then recreate it below.
DROP TRIGGER IF EXISTS trg_tool_invocation_revision_lifecycle
  ON tool_invocation_revisions;

-- Keeps local prerelease databases repairable if this migration was exercised while the schema
-- was still under development. Fresh installs already have these columns from CREATE TABLE.
ALTER TABLE tool_invocation_revisions ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE tool_invocation_revisions ADD COLUMN IF NOT EXISTS input_schema jsonb;
ALTER TABLE tool_invocation_revisions ADD COLUMN IF NOT EXISTS source_code text;
ALTER TABLE tool_invocation_revisions ADD COLUMN IF NOT EXISTS env_var_names text[];
ALTER TABLE tool_invocation_revisions ADD COLUMN IF NOT EXISTS created_by text;
UPDATE tool_invocation_revisions r
SET description = COALESCE(r.description, t.description),
    input_schema = COALESCE(r.input_schema, t.input_schema),
    source_code = COALESCE(r.source_code, t.source_code),
    env_var_names = COALESCE(r.env_var_names, t.env_var_names, '{}'),
    created_by = COALESCE(r.created_by, t.created_by)
FROM tools t
WHERE t.id = r.tool_id
  AND (r.description IS NULL OR r.input_schema IS NULL OR r.source_code IS NULL
       OR r.env_var_names IS NULL OR r.created_by IS NULL);
ALTER TABLE tool_invocation_revisions ALTER COLUMN description SET NOT NULL;
ALTER TABLE tool_invocation_revisions ALTER COLUMN input_schema SET NOT NULL;
ALTER TABLE tool_invocation_revisions ALTER COLUMN source_code SET NOT NULL;
ALTER TABLE tool_invocation_revisions ALTER COLUMN env_var_names SET NOT NULL;
ALTER TABLE tool_invocation_revisions ALTER COLUMN env_var_names SET DEFAULT '{}';
ALTER TABLE tool_invocation_revisions ALTER COLUMN created_by SET NOT NULL;

-- Upgrade prerelease rows before removing the mutable public-schema key copies. Only encrypted
-- bytes move, entirely inside PostgreSQL; neither plaintext nor a decrypted key is materialized.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tools
    WHERE invocation_key_id IS NOT NULL
      AND invocation_public_key IS NOT NULL
      AND invocation_private_key_encrypted IS NOT NULL
      AND deployment_project IS NOT NULL
      AND source_code IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot migrate generated-tool invocation authority without its exact source; redeploy the tool';
  END IF;
END $$;

INSERT INTO tool_invocation_revisions
  (key_id, tool_id, public_key, private_key_encrypted, deployment_project,
   description, input_schema, source_code, env_var_names, created_by,
   endpoint_url, status, created_at, deployed_at)
SELECT t.invocation_key_id,
       t.id,
       t.invocation_public_key,
       t.invocation_private_key_encrypted,
       t.deployment_project,
       t.description,
       t.input_schema,
       t.source_code,
       t.env_var_names,
       t.created_by,
       CASE WHEN t.deploy_status = 'live' AND t.endpoint_url IS NOT NULL
            THEN t.endpoint_url ELSE NULL END,
       CASE WHEN t.deploy_status = 'live' AND t.endpoint_url IS NOT NULL
            THEN 'live' ELSE 'failed' END,
       t.created_at,
       CASE WHEN t.deploy_status = 'live' AND t.endpoint_url IS NOT NULL
            THEN t.created_at ELSE NULL END
FROM tools t
WHERE t.invocation_key_id IS NOT NULL
  AND t.invocation_public_key IS NOT NULL
  AND t.invocation_private_key_encrypted IS NOT NULL
  AND t.deployment_project IS NOT NULL
ON CONFLICT (key_id) DO NOTHING;

-- `ON CONFLICT` is idempotence, never authority selection. A colliding prerelease row must match
-- the mutable source byte-for-byte before the redundant public key columns are destroyed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tools t
    JOIN tool_invocation_revisions r ON r.key_id = t.invocation_key_id
    WHERE t.invocation_key_id IS NOT NULL
      AND t.invocation_public_key IS NOT NULL
      AND t.invocation_private_key_encrypted IS NOT NULL
      AND t.deployment_project IS NOT NULL
      AND (
        r.tool_id IS DISTINCT FROM t.id
        OR r.public_key IS DISTINCT FROM t.invocation_public_key
        OR r.private_key_encrypted IS DISTINCT FROM t.invocation_private_key_encrypted
        OR r.deployment_project IS DISTINCT FROM t.deployment_project
        OR r.description IS DISTINCT FROM t.description
        OR r.input_schema IS DISTINCT FROM t.input_schema
        OR r.source_code IS DISTINCT FROM t.source_code
        OR r.env_var_names IS DISTINCT FROM t.env_var_names
        OR r.created_by IS DISTINCT FROM t.created_by
        OR r.endpoint_url IS DISTINCT FROM (
          CASE WHEN t.deploy_status = 'live' AND t.endpoint_url IS NOT NULL
               THEN t.endpoint_url ELSE NULL END
        )
        OR r.status IS DISTINCT FROM (
          CASE WHEN t.deploy_status = 'live' AND t.endpoint_url IS NOT NULL
               THEN 'live' ELSE 'failed' END
        )
      )
  ) THEN
    RAISE EXCEPTION 'conflicting prerelease tool invocation revision; refusing to discard mutable authority';
  END IF;
END $$;

ALTER TABLE tool_invocation_revisions
  DROP CONSTRAINT IF EXISTS tool_invocation_revision_status_shape;
ALTER TABLE tool_invocation_revisions
  ADD CONSTRAINT tool_invocation_revision_status_shape CHECK (
    (status IN ('deploying', 'failed') AND endpoint_url IS NULL AND deployed_at IS NULL)
    OR (status = 'live' AND endpoint_url IS NOT NULL AND deployed_at IS NOT NULL)
    OR (status = 'retired' AND (
      (endpoint_url IS NULL AND deployed_at IS NULL)
      OR (endpoint_url IS NOT NULL AND deployed_at IS NOT NULL)
    ))
  );

-- A stable integration endpoint may legitimately rotate signing keys. Endpoint identity alone is
-- not invocation authority, so repair prerelease unique indexes into a non-unique lookup index.
DROP INDEX IF EXISTS idx_tool_invocation_revision_endpoint;
CREATE INDEX idx_tool_invocation_revision_endpoint
  ON tool_invocation_revisions(tool_id, endpoint_url)
  WHERE endpoint_url IS NOT NULL;
DROP INDEX IF EXISTS idx_tool_invocation_revision_lookup;
CREATE INDEX idx_tool_invocation_revision_lookup
  ON tool_invocation_revisions(tool_id, key_id, endpoint_url)
  WHERE status IN ('live', 'retired');

COMMENT ON TABLE tool_invocation_revisions IS
  'Append-only generated-tool invocation credentials. Private keys stay encrypted in the control plane.';

-- A revision may be finalized exactly once. The endpoint is populated only while activating a
-- deploying revision; after that, every piece of invocation authority is immutable. `retired`
-- deliberately remains executable for calls that pinned the old endpoint/key before redeploy.
CREATE OR REPLACE FUNCTION enforce_tool_invocation_revision_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'deploying' OR NEW.endpoint_url IS NOT NULL OR NEW.deployed_at IS NOT NULL THEN
      RAISE EXCEPTION 'tool invocation revisions must begin in deploying state without an endpoint';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tool invocation revisions are append-only';
  END IF;

  -- Migration 025 adds an emergency revocation latch without changing the normal pinned-rotation
  -- lifecycle. JSONB access keeps this migration valid both before 025 and when reapplied after it.
  old_row := to_jsonb(OLD);
  new_row := to_jsonb(NEW);
  IF old_row ? 'revoked_at'
     AND OLD.status IN ('live', 'retired')
     AND old_row->'revoked_at' = 'null'::jsonb
     AND new_row->'revoked_at' <> 'null'::jsonb
     AND (new_row - ARRAY['revoked_at','revoked_by','revocation_reason']) =
         (old_row - ARRAY['revoked_at','revoked_by','revocation_reason']) THEN
    RETURN NEW;
  END IF;

  IF NEW.key_id IS DISTINCT FROM OLD.key_id
     OR NEW.tool_id IS DISTINCT FROM OLD.tool_id
     OR NEW.public_key IS DISTINCT FROM OLD.public_key
     OR NEW.private_key_encrypted IS DISTINCT FROM OLD.private_key_encrypted
     OR NEW.deployment_project IS DISTINCT FROM OLD.deployment_project
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.input_schema IS DISTINCT FROM OLD.input_schema
     OR NEW.source_code IS DISTINCT FROM OLD.source_code
     OR NEW.env_var_names IS DISTINCT FROM OLD.env_var_names
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tool invocation revision authority is immutable';
  END IF;

  IF OLD.status = 'deploying' AND NEW.status = 'live' THEN
    IF OLD.endpoint_url IS NOT NULL OR OLD.deployed_at IS NOT NULL
       OR NEW.endpoint_url IS NULL OR NEW.deployed_at IS NULL THEN
      RAISE EXCEPTION 'live tool invocation revision requires one-time endpoint activation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'deploying' AND NEW.status IN ('failed', 'retired') THEN
    IF NEW.endpoint_url IS DISTINCT FROM OLD.endpoint_url
       OR NEW.deployed_at IS DISTINCT FROM OLD.deployed_at THEN
      RAISE EXCEPTION 'unactivated tool invocation revision cannot acquire an endpoint';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'live' AND NEW.status = 'retired' THEN
    IF NEW.endpoint_url IS DISTINCT FROM OLD.endpoint_url
       OR NEW.deployed_at IS DISTINCT FROM OLD.deployed_at THEN
      RAISE EXCEPTION 'activated tool invocation endpoint is immutable';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid tool invocation revision transition: % -> %', OLD.status, NEW.status;
END $$;

DROP TRIGGER IF EXISTS trg_tool_invocation_revision_lifecycle
  ON tool_invocation_revisions;
CREATE TRIGGER trg_tool_invocation_revision_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON tool_invocation_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_tool_invocation_revision_lifecycle();

-- `tools` remains the mutable, API-facing latest pointer. Key material lives only in the
-- append-only revision ledger, so broad reads of public.tools cannot exfiltrate signing keys.
ALTER TABLE tools DROP CONSTRAINT IF EXISTS tools_invocation_boundary_consistent;
ALTER TABLE tools DROP COLUMN IF EXISTS invocation_private_key_encrypted;
ALTER TABLE tools DROP COLUMN IF EXISTS invocation_public_key;
ALTER TABLE tools ADD CONSTRAINT tools_invocation_boundary_consistent CHECK (
  (invocation_key_id IS NULL AND deployment_project IS NULL)
  OR
  (invocation_key_id IS NOT NULL AND deployment_project IS NOT NULL
   AND invocation_key_id ~ '^tik_[A-Za-z0-9_-]{16}$'
   AND deployment_project ~ '^[a-z0-9][a-z0-9-]{0,99}$')
);

COMMENT ON COLUMN tools.invocation_key_id IS
  'Latest append-only invocation revision pointer; no signing key material is stored on this row.';

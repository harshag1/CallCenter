-- One-way emergency cutoff for a compromised remote-MCP or generated-tool revision.
-- Normal rotation remains unchanged: pinned retired generated revisions and immutable MCP
-- registrations continue to serve already-admitted calls until explicitly revoked.

ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS revoked_by text;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS revocation_reason text;

ALTER TABLE mcp_servers
  DROP CONSTRAINT IF EXISTS mcp_servers_revocation_shape;
ALTER TABLE mcp_servers
  ADD CONSTRAINT mcp_servers_revocation_shape CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
    OR
    (revoked_at IS NOT NULL
     AND approved_manifest IS NOT NULL
     AND length(btrim(revoked_by)) BETWEEN 1 AND 256
     AND length(btrim(revocation_reason)) BETWEEN 8 AND 2048
     AND revoked_at >= created_at)
  );

ALTER TABLE tool_invocation_revisions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE tool_invocation_revisions ADD COLUMN IF NOT EXISTS revoked_by text;
ALTER TABLE tool_invocation_revisions ADD COLUMN IF NOT EXISTS revocation_reason text;

ALTER TABLE tool_invocation_revisions
  DROP CONSTRAINT IF EXISTS tool_invocation_revision_revocation_shape;
ALTER TABLE tool_invocation_revisions
  ADD CONSTRAINT tool_invocation_revision_revocation_shape CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
    OR
    (revoked_at IS NOT NULL
     AND status IN ('live', 'retired')
     AND length(btrim(revoked_by)) BETWEEN 1 AND 256
     AND length(btrim(revocation_reason)) BETWEEN 8 AND 2048
     AND revoked_at >= created_at)
  );

CREATE SCHEMA IF NOT EXISTS hacc_private;
CREATE TABLE IF NOT EXISTS hacc_private.tool_authority_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authority_kind text NOT NULL CHECK (authority_kind IN ('remote_mcp', 'generated_tool')),
  authority_id text NOT NULL,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  revision_binding jsonb NOT NULL CHECK (jsonb_typeof(revision_binding) = 'object'),
  revoked_at timestamptz NOT NULL,
  revoked_by text NOT NULL CHECK (length(btrim(revoked_by)) BETWEEN 1 AND 256),
  revocation_reason text NOT NULL CHECK (length(btrim(revocation_reason)) BETWEEN 8 AND 2048),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (authority_kind, authority_id)
);

COMMENT ON TABLE hacc_private.tool_authority_revocations IS
  'Append-only audit of explicit emergency cutoffs. Rotation/retirement alone never creates a revocation.';

-- This audit is written only by the SECURITY DEFINER trigger below. Keep it inside the same
-- FORCE-RLS inventory as every other application relation, but deliberately give the runtime
-- backend a deny-all policy and no table grant: ordinary request code never needs to forge or
-- rewrite security evidence. The migration owner policy lets reapplication verify/backfill exact
-- rows without relying on table-owner RLS bypass semantics.
ALTER TABLE hacc_private.tool_authority_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hacc_private.tool_authority_revocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hacc_backend_all ON hacc_private.tool_authority_revocations;
CREATE POLICY hacc_backend_all ON hacc_private.tool_authority_revocations
  FOR ALL TO hacc_backend USING (false) WITH CHECK (false);
DO $policy$
BEGIN
  DROP POLICY IF EXISTS hacc_migration_owner_all
    ON hacc_private.tool_authority_revocations;
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON hacc_private.tool_authority_revocations '
    'FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$policy$;

REVOKE ALL ON TABLE hacc_private.tool_authority_revocations FROM PUBLIC;
REVOKE ALL ON TABLE hacc_private.tool_authority_revocations FROM hacc_backend;
DO $api_revokes$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'hacc_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL ON hacc_private.tool_authority_revocations FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$api_revokes$;

CREATE OR REPLACE FUNCTION hacc_private.reject_tool_authority_revocation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tool authority revocation audit is append-only';
END $$;

REVOKE ALL ON FUNCTION hacc_private.reject_tool_authority_revocation_mutation() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_tool_authority_revocation_audit_immutable
  ON hacc_private.tool_authority_revocations;
CREATE TRIGGER trg_tool_authority_revocation_audit_immutable
BEFORE UPDATE OR DELETE ON hacc_private.tool_authority_revocations
FOR EACH ROW EXECUTE FUNCTION hacc_private.reject_tool_authority_revocation_mutation();

-- Preserve the immutable approved revision while permitting exactly one null -> revoked latch.
-- Reapplying migration 009 later retains the same exception via its JSONB-compatible definition.
CREATE OR REPLACE FUNCTION reject_approved_mcp_server_revision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_manifest IS NOT NULL THEN
    IF TG_OP = 'UPDATE'
       AND OLD.revoked_at IS NULL
       AND NEW.revoked_at IS NOT NULL
       AND NEW.revoked_by IS NOT NULL
       AND NEW.revocation_reason IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['revoked_at','revoked_by','revocation_reason']) =
           (to_jsonb(OLD) - ARRAY['revoked_at','revoked_by','revocation_reason']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'approved MCP server revisions are immutable; register a new revision';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS trg_approved_mcp_server_revision_immutable ON mcp_servers;
CREATE TRIGGER trg_approved_mcp_server_revision_immutable
BEFORE UPDATE OR DELETE ON mcp_servers
FOR EACH ROW EXECUTE FUNCTION reject_approved_mcp_server_revision_mutation();

-- Preserve the one-way deployment lifecycle. A retired revision remains executable for a pinned
-- call; only the explicit revocation latch disables it.
CREATE OR REPLACE FUNCTION enforce_tool_invocation_revision_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'deploying' OR NEW.endpoint_url IS NOT NULL OR NEW.deployed_at IS NOT NULL
       OR NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revocation_reason IS NOT NULL THEN
      RAISE EXCEPTION 'tool invocation revisions must begin in deploying state without an endpoint';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tool invocation revisions are append-only';
  END IF;

  IF OLD.status IN ('live', 'retired')
     AND OLD.revoked_at IS NULL
     AND NEW.revoked_at IS NOT NULL
     AND NEW.revoked_by IS NOT NULL
     AND NEW.revocation_reason IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['revoked_at','revoked_by','revocation_reason']) =
         (to_jsonb(OLD) - ARRAY['revoked_at','revoked_by','revocation_reason']) THEN
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
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
     OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason THEN
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

CREATE OR REPLACE FUNCTION hacc_private.record_tool_authority_revocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, hacc_private
AS $$
DECLARE
  bound_org_id uuid;
  binding jsonb;
  kind text;
  identity text;
  persisted hacc_private.tool_authority_revocations%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'mcp_servers' THEN
    bound_org_id := NEW.org_id;
    kind := 'remote_mcp';
    identity := NEW.id::text;
    binding := jsonb_build_object(
      'server_id', NEW.id,
      'approved_catalog_hash', NEW.approved_catalog_hash
    );
  ELSIF TG_TABLE_NAME = 'tool_invocation_revisions' THEN
    SELECT org_id INTO STRICT bound_org_id FROM public.tools WHERE id = NEW.tool_id;
    kind := 'generated_tool';
    identity := NEW.key_id;
    binding := jsonb_build_object(
      'tool_id', NEW.tool_id,
      'key_id', NEW.key_id,
      'endpoint_url', NEW.endpoint_url
    );
  ELSE
    RAISE EXCEPTION 'unsupported tool authority revocation source';
  END IF;

  INSERT INTO hacc_private.tool_authority_revocations
    (authority_kind, authority_id, org_id, revision_binding,
     revoked_at, revoked_by, revocation_reason)
  VALUES
    (kind, identity, bound_org_id, binding,
     NEW.revoked_at, NEW.revoked_by, NEW.revocation_reason)
  ON CONFLICT (authority_kind, authority_id) DO NOTHING;

  SELECT * INTO STRICT persisted
  FROM hacc_private.tool_authority_revocations
  WHERE authority_kind = kind AND authority_id = identity;
  IF persisted.org_id IS DISTINCT FROM bound_org_id
     OR persisted.revision_binding IS DISTINCT FROM binding
     OR persisted.revoked_at IS DISTINCT FROM NEW.revoked_at
     OR persisted.revoked_by IS DISTINCT FROM NEW.revoked_by
     OR persisted.revocation_reason IS DISTINCT FROM NEW.revocation_reason THEN
    RAISE EXCEPTION 'conflicting tool authority revocation audit';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION hacc_private.record_tool_authority_revocation() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_mcp_server_revocation_audit ON mcp_servers;
CREATE TRIGGER trg_mcp_server_revocation_audit
AFTER UPDATE OF revoked_at ON mcp_servers
FOR EACH ROW
WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION hacc_private.record_tool_authority_revocation();

DROP TRIGGER IF EXISTS trg_generated_tool_revocation_audit ON tool_invocation_revisions;
CREATE TRIGGER trg_generated_tool_revocation_audit
AFTER UPDATE OF revoked_at ON tool_invocation_revisions
FOR EACH ROW
WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
EXECUTE FUNCTION hacc_private.record_tool_authority_revocation();

-- Idempotent repair for a prerelease database where the latch columns were populated before the
-- audit trigger was installed. Exact conflicts are verified below rather than overwritten.
INSERT INTO hacc_private.tool_authority_revocations
  (authority_kind, authority_id, org_id, revision_binding,
   revoked_at, revoked_by, revocation_reason)
SELECT 'remote_mcp', server.id::text, server.org_id,
       jsonb_build_object('server_id', server.id, 'approved_catalog_hash', server.approved_catalog_hash),
       server.revoked_at, server.revoked_by, server.revocation_reason
FROM mcp_servers server
WHERE server.revoked_at IS NOT NULL
ON CONFLICT (authority_kind, authority_id) DO NOTHING;

INSERT INTO hacc_private.tool_authority_revocations
  (authority_kind, authority_id, org_id, revision_binding,
   revoked_at, revoked_by, revocation_reason)
SELECT 'generated_tool', revision.key_id, tool.org_id,
       jsonb_build_object('tool_id', revision.tool_id, 'key_id', revision.key_id,
                          'endpoint_url', revision.endpoint_url),
       revision.revoked_at, revision.revoked_by, revision.revocation_reason
FROM tool_invocation_revisions revision
JOIN tools tool ON tool.id = revision.tool_id
WHERE revision.revoked_at IS NOT NULL
ON CONFLICT (authority_kind, authority_id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mcp_servers server
    LEFT JOIN hacc_private.tool_authority_revocations audit
      ON audit.authority_kind = 'remote_mcp' AND audit.authority_id = server.id::text
    WHERE server.revoked_at IS NOT NULL
      AND (audit.id IS NULL
           OR audit.org_id IS DISTINCT FROM server.org_id
           OR audit.revision_binding IS DISTINCT FROM jsonb_build_object(
             'server_id', server.id, 'approved_catalog_hash', server.approved_catalog_hash)
           OR audit.revoked_at IS DISTINCT FROM server.revoked_at
           OR audit.revoked_by IS DISTINCT FROM server.revoked_by
           OR audit.revocation_reason IS DISTINCT FROM server.revocation_reason)
  ) OR EXISTS (
    SELECT 1
    FROM tool_invocation_revisions revision
    JOIN tools tool ON tool.id = revision.tool_id
    LEFT JOIN hacc_private.tool_authority_revocations audit
      ON audit.authority_kind = 'generated_tool' AND audit.authority_id = revision.key_id
    WHERE revision.revoked_at IS NOT NULL
      AND (audit.id IS NULL
           OR audit.org_id IS DISTINCT FROM tool.org_id
           OR audit.revision_binding IS DISTINCT FROM jsonb_build_object(
             'tool_id', revision.tool_id, 'key_id', revision.key_id,
             'endpoint_url', revision.endpoint_url)
           OR audit.revoked_at IS DISTINCT FROM revision.revoked_at
           OR audit.revoked_by IS DISTINCT FROM revision.revoked_by
           OR audit.revocation_reason IS DISTINCT FROM revision.revocation_reason)
  ) THEN
    RAISE EXCEPTION 'tool authority revocation audit does not match its exact revision';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mcp_servers_active_authority
  ON mcp_servers(org_id, id, approved_catalog_hash)
  WHERE revoked_at IS NULL AND approved_catalog_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tool_invocation_revisions_active_authority
  ON tool_invocation_revisions(tool_id, key_id, endpoint_url)
  WHERE revoked_at IS NULL AND status IN ('live', 'retired');

COMMENT ON COLUMN mcp_servers.revoked_at IS
  'One-way emergency cutoff. Normal credential/catalog rotation creates a new immutable row instead.';
COMMENT ON COLUMN tool_invocation_revisions.revoked_at IS
  'One-way emergency cutoff. Retired revisions remain usable for pinned calls unless this is set.';

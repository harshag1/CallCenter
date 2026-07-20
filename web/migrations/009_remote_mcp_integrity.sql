-- Registration-approved remote MCP catalogs. Each mcp_servers row is an immutable interface
-- revision for agent-version pinning; refresh/rotation creates a new row and agent version.

ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS approved_manifest jsonb;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS approved_catalog_hash text;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS approved_at timestamptz;

ALTER TABLE mcp_servers
  DROP CONSTRAINT IF EXISTS mcp_servers_approved_catalog_consistent;
ALTER TABLE mcp_servers
  ADD CONSTRAINT mcp_servers_approved_catalog_consistent CHECK (
    (approved_manifest IS NULL AND approved_catalog_hash IS NULL AND approved_at IS NULL)
    OR
    (approved_manifest IS NOT NULL
     AND approved_catalog_hash ~ '^[a-f0-9]{64}$'
     AND approved_at IS NOT NULL)
  );

DROP INDEX IF EXISTS idx_mcp_servers_approved_catalog_hash;
CREATE INDEX idx_mcp_servers_approved_catalog_hash
  ON mcp_servers(org_id, approved_catalog_hash)
  WHERE approved_catalog_hash IS NOT NULL;

COMMENT ON COLUMN mcp_servers.approved_manifest IS
  'Sanitized, auth-free MCP interface revision accepted at registration; never overwrite in place.';

CREATE OR REPLACE FUNCTION reject_approved_mcp_server_revision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
BEGIN
  IF OLD.approved_manifest IS NOT NULL THEN
    -- Migration 025 adds a one-way emergency revocation latch. Use JSONB field access so this
    -- earlier migration remains independently applicable before those columns exist, while an
    -- exact reapply after 025 does not accidentally remove the kill switch.
    IF TG_OP = 'UPDATE' THEN
      old_row := to_jsonb(OLD);
      new_row := to_jsonb(NEW);
      IF old_row ? 'revoked_at'
         AND old_row->'revoked_at' = 'null'::jsonb
         AND new_row->'revoked_at' <> 'null'::jsonb
         AND (new_row - ARRAY['revoked_at','revoked_by','revocation_reason']) =
             (old_row - ARRAY['revoked_at','revoked_by','revocation_reason']) THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'approved MCP server revisions are immutable; register a new revision';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS trg_approved_mcp_server_revision_immutable ON mcp_servers;
DROP FUNCTION IF EXISTS reject_approved_mcp_server_revision_update();
CREATE TRIGGER trg_approved_mcp_server_revision_immutable
BEFORE UPDATE OR DELETE ON mcp_servers
FOR EACH ROW EXECUTE FUNCTION reject_approved_mcp_server_revision_mutation();

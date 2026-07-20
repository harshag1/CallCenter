-- Durable provider-call admission for every MCP tool, including flow-control transitions.
-- A provider-native identity can execute once, replay its exact terminal result, or quarantine
-- after an uncertain process boundary; it can never silently become a fresh mutation.

CREATE TABLE IF NOT EXISTS mcp_tool_invocation_receipts (
  id uuid PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  provider_invocation_id text NOT NULL CHECK (octet_length(provider_invocation_id) BETWEEN 1 AND 256),
  logical_name text NOT NULL CHECK (logical_name ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  model_arguments jsonb NOT NULL,
  model_arguments_hash text NOT NULL CHECK (model_arguments_hash ~ '^[a-f0-9]{64}$'),
  active_catalog_digest text NOT NULL CHECK (active_catalog_digest ~ '^[a-f0-9]{64}$'),
  active_catalog_epoch integer NOT NULL CHECK (active_catalog_epoch >= 0),
  status text NOT NULL CHECK (status IN ('executing', 'completed', 'indeterminate')),
  owner_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  result jsonb,
  result_hash text CHECK (result_hash IS NULL OR result_hash ~ '^[a-f0-9]{64}$'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  UNIQUE (call_id, provider_invocation_id),
  UNIQUE (id, call_id),
  CHECK (
    (status = 'executing' AND result IS NULL AND result_hash IS NULL AND settled_at IS NULL)
    OR
    (status IN ('completed', 'indeterminate')
      AND result IS NOT NULL AND result_hash IS NOT NULL AND settled_at IS NOT NULL)
  )
);

-- Upgrade only the unpublished prerelease shape. A populated legacy receipt
-- cannot be assigned catalog authority after the fact, so fail closed rather
-- than inventing metadata or retaining a private host-bound grant.
DO $upgrade_prerelease$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='mcp_tool_invocation_receipts'
      AND column_name='tool_name'
  ) THEN
    IF EXISTS (SELECT 1 FROM mcp_tool_invocation_receipts) THEN
      RAISE EXCEPTION 'cannot upgrade populated prerelease MCP receipts without catalog authority';
    END IF;
    ALTER TABLE mcp_tool_invocation_receipts RENAME COLUMN tool_name TO logical_name;
    ALTER TABLE mcp_tool_invocation_receipts RENAME COLUMN arguments TO model_arguments;
    ALTER TABLE mcp_tool_invocation_receipts RENAME COLUMN arguments_hash TO model_arguments_hash;
  END IF;
END
$upgrade_prerelease$;
ALTER TABLE mcp_tool_invocation_receipts
  ADD COLUMN IF NOT EXISTS active_catalog_digest text;
ALTER TABLE mcp_tool_invocation_receipts
  ADD COLUMN IF NOT EXISTS active_catalog_epoch integer;
ALTER TABLE mcp_tool_invocation_receipts
  ALTER COLUMN active_catalog_epoch TYPE integer
  USING active_catalog_epoch::integer;
ALTER TABLE mcp_tool_invocation_receipts
  ALTER COLUMN active_catalog_digest SET NOT NULL;
ALTER TABLE mcp_tool_invocation_receipts
  ALTER COLUMN active_catalog_epoch SET NOT NULL;
ALTER TABLE mcp_tool_invocation_receipts
  DROP CONSTRAINT IF EXISTS mcp_tool_invocation_receipts_catalog_authority_valid;
ALTER TABLE mcp_tool_invocation_receipts
  ADD CONSTRAINT mcp_tool_invocation_receipts_catalog_authority_valid CHECK (
    active_catalog_digest ~ '^[a-f0-9]{64}$' AND active_catalog_epoch >= 0
  );

CREATE INDEX IF NOT EXISTS idx_mcp_tool_invocation_receipts_call
  ON mcp_tool_invocation_receipts(call_id, started_at);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_invocation_receipts_expired
  ON mcp_tool_invocation_receipts(lease_expires_at)
  WHERE status = 'executing';

CREATE OR REPLACE FUNCTION enforce_mcp_tool_invocation_receipt_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'executing' OR NEW.result IS NOT NULL OR NEW.result_hash IS NOT NULL
       OR NEW.settled_at IS NOT NULL OR NEW.lease_expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'MCP tool receipts must begin as a live executing reservation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM 1 FROM calls WHERE id = OLD.call_id;
    IF FOUND THEN RAISE EXCEPTION 'MCP tool receipts cannot be deleted while their call exists'; END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'executing' OR NEW.status NOT IN ('completed', 'indeterminate') THEN
    RAISE EXCEPTION 'terminal MCP tool receipts are immutable';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.call_id IS DISTINCT FROM OLD.call_id
     OR NEW.provider_invocation_id IS DISTINCT FROM OLD.provider_invocation_id
     OR NEW.logical_name IS DISTINCT FROM OLD.logical_name
     OR NEW.model_arguments IS DISTINCT FROM OLD.model_arguments
     OR NEW.model_arguments_hash IS DISTINCT FROM OLD.model_arguments_hash
     OR NEW.active_catalog_digest IS DISTINCT FROM OLD.active_catalog_digest
     OR NEW.active_catalog_epoch IS DISTINCT FROM OLD.active_catalog_epoch
     OR NEW.owner_token IS DISTINCT FROM OLD.owner_token
     OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'MCP tool receipt authority is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_mcp_tool_invocation_receipt_lifecycle
  ON mcp_tool_invocation_receipts;
CREATE TRIGGER trg_mcp_tool_invocation_receipt_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON mcp_tool_invocation_receipts
FOR EACH ROW EXECUTE FUNCTION enforce_mcp_tool_invocation_receipt_lifecycle();

ALTER TABLE mcp_tool_invocation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_tool_invocation_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hacc_backend_all ON mcp_tool_invocation_receipts;
CREATE POLICY hacc_backend_all ON mcp_tool_invocation_receipts
  FOR ALL TO hacc_backend USING (true) WITH CHECK (true);
DO $policy$
BEGIN
  DROP POLICY IF EXISTS hacc_migration_owner_all ON mcp_tool_invocation_receipts;
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON mcp_tool_invocation_receipts FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$policy$;

REVOKE ALL ON mcp_tool_invocation_receipts FROM PUBLIC;
GRANT SELECT, DELETE ON mcp_tool_invocation_receipts TO hacc_backend;
-- Before migration 028 exists, INSERT is needed by the prerelease store. Once
-- the atomic quota function is installed, a standalone reapply of this older
-- migration must never reopen direct receipt insertion.
DO $mcp_receipt_runtime_insert$
BEGIN
  IF to_regprocedure(
    'public.admit_mcp_tool_invocation(uuid,uuid,text,text,jsonb,text,text,integer,uuid,integer)'
  ) IS NULL
     AND to_regclass('public.mcp_call_invocation_quotas') IS NULL THEN
    GRANT INSERT, UPDATE ON mcp_tool_invocation_receipts TO hacc_backend;
  ELSE
    REVOKE INSERT, UPDATE ON mcp_tool_invocation_receipts FROM hacc_backend;
  END IF;
END
$mcp_receipt_runtime_insert$;
DO $api_revokes$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'hacc_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON mcp_tool_invocation_receipts FROM %I', api_role);
    END IF;
  END LOOP;
END
$api_revokes$;

COMMENT ON TABLE mcp_tool_invocation_receipts IS
  'Call-scoped provider-native MCP invocation ledger. Stores only provider-visible logical identity and catalog expectation; terminal rows replay exactly and are immutable.';

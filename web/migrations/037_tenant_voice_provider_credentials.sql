-- Tenant-scoped browser voice provider credentials.
--
-- Root provider keys remain encrypted server-side. Browser voice sessions receive
-- only provider-minted ephemeral credentials, and every read is bound to the
-- authenticated organization plus the exact provider.

CREATE TABLE IF NOT EXISTS hacc_private.voice_provider_credentials (
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('openai', 'xai')),
  credential_encrypted text NOT NULL
    CHECK (credential_encrypted LIKE 'hacc_v2:%'),
  encryption_slot_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, provider)
);

COMMENT ON TABLE hacc_private.voice_provider_credentials IS
  'Tenant-owned provider root credentials for minting browser-only ephemeral voice sessions. Never exposed through PostgREST or provider/browser payloads.';
COMMENT ON COLUMN hacc_private.voice_provider_credentials.encryption_slot_id IS
  'Random generation bound into the context-authenticated vault envelope; changes on every replacement.';

ALTER TABLE hacc_private.voice_provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE hacc_private.voice_provider_credentials FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hacc_backend_all
  ON hacc_private.voice_provider_credentials;
DO $voice_provider_backend_policy$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    CREATE POLICY hacc_backend_all
      ON hacc_private.voice_provider_credentials
      FOR ALL TO hacc_backend
      USING (true)
      WITH CHECK (true);
  END IF;
END
$voice_provider_backend_policy$;

DROP POLICY IF EXISTS hacc_migration_owner_all
  ON hacc_private.voice_provider_credentials;
DO $voice_provider_owner_policy$
BEGIN
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON hacc_private.voice_provider_credentials FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$voice_provider_owner_policy$;

REVOKE ALL ON hacc_private.voice_provider_credentials FROM PUBLIC;
DO $voice_provider_private_grants$
DECLARE
  api_role text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    GRANT USAGE ON SCHEMA hacc_private TO hacc_backend;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON hacc_private.voice_provider_credentials TO hacc_backend;
  END IF;
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL ON hacc_private.voice_provider_credentials FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$voice_provider_private_grants$;

-- 021_voice_capability_rotation.sql
-- Durable, bearer-free rotation state for browser and standalone bridge calls.

CREATE TABLE IF NOT EXISTS voice_capability_rotations (
  transport text NOT NULL CHECK (transport IN ('browser', 'telephony')),
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  session_id text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  bridge_instance_id text,
  stream_sid text,
  provider text NOT NULL CHECK (provider IN ('xai', 'openai', 'gemini')),
  rotation_root_jti text NOT NULL CHECK (rotation_root_jti ~ '^[A-Za-z0-9_-]{22}$'),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 1000000),
  current_refresh_jti text NOT NULL CHECK (current_refresh_jti ~ '^[A-Za-z0-9_-]{22}$'),
  previous_refresh_jti text CHECK (previous_refresh_jti IS NULL OR previous_refresh_jti ~ '^[A-Za-z0-9_-]{22}$'),
  last_consumed_refresh_jti text CHECK (last_consumed_refresh_jti IS NULL OR last_consumed_refresh_jti ~ '^[A-Za-z0-9_-]{22}$'),
  last_idempotency_key text CHECK (
    last_idempotency_key IS NULL OR octet_length(last_idempotency_key) BETWEEN 1 AND 256
  ),
  issued_at bigint NOT NULL CHECK (issued_at >= 0),
  refresh_after timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transport, call_id, session_id),
  UNIQUE (current_refresh_jti),
  CHECK (refresh_after < expires_at),
  CHECK (
    (transport = 'browser'
      AND session_id = call_id::text
      AND bridge_instance_id IS NULL
      AND stream_sid IS NULL)
    OR
    (transport = 'telephony'
      AND bridge_instance_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND stream_sid ~ '^MZ[0-9a-fA-F]{32}$'
      AND provider IN ('xai', 'openai'))
  )
);

-- Rotation state is independently bound to the exact stream/session/bridge
-- tuple established by the one-use bootstrap exchange.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.telephony_stream_bindings'::regclass
      AND conname = 'telephony_stream_rotation_identity_unique'
  ) THEN
    ALTER TABLE telephony_stream_bindings ADD CONSTRAINT telephony_stream_rotation_identity_unique
      UNIQUE (stream_sid, call_id, session_id, bridge_instance_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.voice_capability_rotations'::regclass
      AND conname = 'voice_rotation_telephony_binding_fk'
  ) THEN
    ALTER TABLE voice_capability_rotations ADD CONSTRAINT voice_rotation_telephony_binding_fk
      FOREIGN KEY (stream_sid, call_id, session_id, bridge_instance_id)
      REFERENCES telephony_stream_bindings (stream_sid, call_id, session_id, bridge_instance_id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_voice_capability_rotations_expiry
  ON voice_capability_rotations(expires_at);

ALTER TABLE voice_capability_rotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_capability_rotations FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY hacc_backend_all ON voice_capability_rotations
    FOR ALL TO hacc_backend USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON voice_capability_rotations FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

REVOKE ALL ON voice_capability_rotations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON voice_capability_rotations TO hacc_backend;

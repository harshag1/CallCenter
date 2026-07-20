-- 015_telephony_trust_boundary.sql
-- Durable provider identity, replay receipts, stream binding, and event-journal idempotency.

ALTER TABLE calls ADD COLUMN IF NOT EXISTS twilio_account_sid text;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS twilio_status text;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS twilio_status_rank int NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS twilio_status_sequence int;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS twilio_status_updated_at timestamptz;

DO $$ BEGIN
  ALTER TABLE calls ADD CONSTRAINT calls_twilio_status_rank_range
    CHECK (twilio_status_rank BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE calls ADD CONSTRAINT calls_twilio_status_sequence_nonnegative
    CHECK (twilio_status_sequence IS NULL OR twilio_status_sequence >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Older installs may already contain retry-created duplicates. Preserve the
-- oldest authoritative row and quarantine duplicate identities in metadata so
-- the uniqueness gate can be added without discarding audit evidence.
WITH ranked AS (
  SELECT id, twilio_call_sid,
         row_number() OVER (PARTITION BY twilio_call_sid ORDER BY started_at, id) AS ordinal
  FROM calls
  WHERE twilio_call_sid IS NOT NULL
)
UPDATE calls AS c
SET metadata = c.metadata || jsonb_build_object('quarantined_twilio_call_sid', ranked.twilio_call_sid),
    twilio_call_sid = NULL,
    status = CASE WHEN c.status IN ('active', 'dialing') THEN 'failed' ELSE c.status END,
    ended_at = CASE WHEN c.status IN ('active', 'dialing') THEN COALESCE(c.ended_at, now()) ELSE c.ended_at END
FROM ranked
WHERE c.id = ranked.id AND ranked.ordinal > 1;

WITH ranked AS (
  SELECT id, xai_call_id,
         row_number() OVER (PARTITION BY xai_call_id ORDER BY started_at, id) AS ordinal
  FROM calls
  WHERE xai_call_id IS NOT NULL
)
UPDATE calls AS c
SET metadata = c.metadata || jsonb_build_object('quarantined_xai_call_id', ranked.xai_call_id),
    xai_call_id = NULL,
    status = CASE WHEN c.status IN ('active', 'dialing') THEN 'failed' ELSE c.status END,
    ended_at = CASE WHEN c.status IN ('active', 'dialing') THEN COALESCE(c.ended_at, now()) ELSE c.ended_at END
FROM ranked
WHERE c.id = ranked.id AND ranked.ordinal > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_calls_twilio_call_sid
  ON calls(twilio_call_sid) WHERE twilio_call_sid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_calls_xai_call_id
  ON calls(xai_call_id) WHERE xai_call_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS telephony_stream_bindings (
  stream_sid text PRIMARY KEY CHECK (stream_sid ~ '^MZ[0-9a-fA-F]{32}$'),
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('twilio')),
  provider_account_sid text NOT NULL,
  provider_call_sid text NOT NULL,
  to_number text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('agent', 'observe')),
  session_id text,
  bridge_instance_id text,
  bootstrap_jti text,
  -- Provider session configuration is persisted only with any scoped bearer
  -- authorization replaced by an inert placeholder. Bearer material is
  -- deterministically re-derived during the exact-idempotency exchange.
  bootstrap_session_config text,
  started_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  UNIQUE (provider, provider_account_sid, provider_call_sid, stream_sid)
);
ALTER TABLE telephony_stream_bindings ADD COLUMN IF NOT EXISTS session_id text;
ALTER TABLE telephony_stream_bindings ADD COLUMN IF NOT EXISTS bridge_instance_id text;
ALTER TABLE telephony_stream_bindings ADD COLUMN IF NOT EXISTS bootstrap_jti text;
ALTER TABLE telephony_stream_bindings ADD COLUMN IF NOT EXISTS bootstrap_session_config text;

DO $$ BEGIN
  ALTER TABLE telephony_stream_bindings ADD CONSTRAINT telephony_stream_provider_identity_shape
    CHECK (
      provider_account_sid ~ '^AC[0-9a-fA-F]{32}$'
      AND provider_call_sid ~ '^CA[0-9a-fA-F]{32}$'
      AND to_number ~ '^\+[1-9][0-9]{6,14}$'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE telephony_stream_bindings ADD CONSTRAINT telephony_stream_bootstrap_binding_shape
    CHECK (
      (session_id IS NULL AND bridge_instance_id IS NULL AND bootstrap_jti IS NULL
        AND bootstrap_session_config IS NULL)
      OR
      (session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND bridge_instance_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND bootstrap_jti ~ '^[A-Za-z0-9_-]{22}$'
        AND mode = 'agent'
        AND octet_length(bootstrap_session_config) BETWEEN 2 AND 1048576)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_telephony_stream_bindings_call
  ON telephony_stream_bindings(call_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_telephony_stream_bindings_session
  ON telephony_stream_bindings(session_id) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_telephony_stream_bindings_bootstrap
  ON telephony_stream_bindings(bootstrap_jti) WHERE bootstrap_jti IS NOT NULL;

CREATE TABLE IF NOT EXISTS telephony_capability_consumptions (
  jti text PRIMARY KEY CHECK (jti ~ '^[A-Za-z0-9_-]{22}$'),
  audience text NOT NULL,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  stream_sid text REFERENCES telephony_stream_bindings(stream_sid) ON DELETE CASCADE,
  session_id text,
  bridge_instance_id text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE telephony_capability_consumptions ADD COLUMN IF NOT EXISTS session_id text;
ALTER TABLE telephony_capability_consumptions ADD COLUMN IF NOT EXISTS bridge_instance_id text;

DO $$ BEGIN
  ALTER TABLE telephony_capability_consumptions ADD CONSTRAINT telephony_consumption_session_shape
    CHECK (
      (session_id IS NULL AND bridge_instance_id IS NULL)
      OR
      (session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND bridge_instance_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND stream_sid IS NOT NULL
        AND audience = 'bridge_bootstrap')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Make the SQL boundary independently enforce the same parent-JTI/session/
-- stream/call tuple that the exchange verifies. Legacy in-process bridge rows
-- have NULL session metadata and therefore do not satisfy (or weaken) this FK.
DO $$ BEGIN
  ALTER TABLE telephony_stream_bindings ADD CONSTRAINT telephony_stream_bootstrap_identity_unique
    UNIQUE (stream_sid, call_id, session_id, bridge_instance_id, bootstrap_jti);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE telephony_capability_consumptions ADD CONSTRAINT telephony_consumption_bootstrap_identity_fk
    FOREIGN KEY (stream_sid, call_id, session_id, bridge_instance_id, jti)
    REFERENCES telephony_stream_bindings (
      stream_sid, call_id, session_id, bridge_instance_id, bootstrap_jti
    ) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_telephony_capability_stream
  ON telephony_capability_consumptions(stream_sid) WHERE stream_sid IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_webhook_receipts (
  provider text NOT NULL,
  webhook_id text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  event_type text,
  provider_created_at timestamptz,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('processing', 'processed', 'failed')),
  attempts int NOT NULL DEFAULT 1 CHECK (attempts > 0),
  processing_started_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, webhook_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_webhook_receipts_stale
  ON provider_webhook_receipts(provider, processing_started_at)
  WHERE status IN ('processing', 'failed');

ALTER TABLE call_events ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE call_events ADD COLUMN IF NOT EXISTS source_session_id text;
ALTER TABLE call_events ADD COLUMN IF NOT EXISTS source_sequence bigint;
ALTER TABLE call_events ADD COLUMN IF NOT EXISTS source_content_sha256 text;

DO $$ BEGIN
  ALTER TABLE call_events ADD CONSTRAINT call_events_source_sequence_positive
    CHECK (source_sequence IS NULL OR source_sequence > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_call_events_source_sequence
  ON call_events(call_id, source, source_session_id, source_sequence)
  WHERE source IS NOT NULL AND source_session_id IS NOT NULL AND source_sequence IS NOT NULL;

CREATE TABLE IF NOT EXISTS telephony_event_batches (
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  batch_id text NOT NULL,
  batch_sha256 text NOT NULL CHECK (batch_sha256 ~ '^[0-9a-f]{64}$'),
  first_sequence bigint,
  last_sequence bigint,
  event_count int NOT NULL CHECK (event_count BETWEEN 0 AND 50),
  complete boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, session_id, batch_id),
  CHECK (
    (complete AND event_count = 0 AND first_sequence IS NULL AND last_sequence IS NULL)
    OR
    (NOT complete AND event_count > 0 AND first_sequence IS NOT NULL AND last_sequence IS NOT NULL
      AND last_sequence >= first_sequence AND last_sequence - first_sequence + 1 = event_count)
  )
);
CREATE INDEX IF NOT EXISTS idx_telephony_event_batches_call
  ON telephony_event_batches(call_id, session_id, received_at);

-- These tables hold cross-tenant provider identities and replay authority.
-- RLS is explicit here because default privileges cannot enable/force RLS on
-- tables created by later migrations.
DO $$
DECLARE
  table_name text;
  owner_name text := current_user;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'telephony_stream_bindings',
    'telephony_capability_consumptions',
    'provider_webhook_receipts',
    'telephony_event_batches'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = current_schema() AND tablename = table_name AND policyname = 'hacc_backend_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY hacc_backend_all ON %I FOR ALL TO hacc_backend USING (true) WITH CHECK (true)',
        table_name
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = current_schema() AND tablename = table_name AND policyname = 'hacc_migration_owner_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY hacc_migration_owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)',
        table_name,
        owner_name
      );
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON telephony_stream_bindings FROM PUBLIC;
REVOKE ALL ON telephony_capability_consumptions FROM PUBLIC;
REVOKE ALL ON provider_webhook_receipts FROM PUBLIC;
REVOKE ALL ON telephony_event_batches FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON telephony_stream_bindings TO hacc_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON telephony_capability_consumptions TO hacc_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON provider_webhook_receipts TO hacc_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON telephony_event_batches TO hacc_backend;

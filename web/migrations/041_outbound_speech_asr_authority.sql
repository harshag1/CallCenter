-- Private, funded authority for independent ASR over quarantined outbound speech.
--
-- A row is reserved before any paid transcription request. The exact provider
-- response and exact mono PCM16 bytes are then bound to one claim token and one
-- bounded funding source. Unknown provider outcomes remain indeterminate; they
-- are never made eligible for a second paid request by relabeling the row.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS hacc_private;
REVOKE ALL ON SCHEMA hacc_private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS hacc_private.outbound_speech_asr_authorities (
  org_id uuid NOT NULL,
  call_id uuid NOT NULL,
  response_id text NOT NULL,
  authority_id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  audio_sha256 text NOT NULL,
  audio_bytes integer NOT NULL,
  sample_rate_hz integer NOT NULL,
  audio_duration_ms numeric(18, 6) NOT NULL,
  reserved_micro_usd integer NOT NULL,
  funding_source text NOT NULL,
  claim_token uuid NOT NULL,
  state text NOT NULL DEFAULT 'claimed',
  receipt_json jsonb,
  dispatched_at timestamptz,
  terminal_at timestamptz,
  failure_code text,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT outbound_speech_asr_authorities_pk
    PRIMARY KEY (org_id, call_id, response_id),
  CONSTRAINT outbound_speech_asr_authorities_authority_id_unique
    UNIQUE (authority_id),
  CONSTRAINT outbound_speech_asr_authorities_claim_token_unique
    UNIQUE (claim_token),
  CONSTRAINT outbound_speech_asr_authorities_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE,
  CONSTRAINT outbound_speech_asr_authorities_call_fk
    FOREIGN KEY (call_id) REFERENCES public.calls(id) ON DELETE CASCADE,
  CONSTRAINT outbound_speech_asr_authorities_response_id_valid CHECK (
    octet_length(response_id) BETWEEN 1 AND 512
    AND response_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT outbound_speech_asr_authorities_authority_id_v4 CHECK (
    authority_id::text ~
      '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  ),
  CONSTRAINT outbound_speech_asr_authorities_provider_valid CHECK (
    provider IN ('openai', 'gemini', 'xai')
  ),
  CONSTRAINT outbound_speech_asr_authorities_audio_sha256_valid CHECK (
    audio_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT outbound_speech_asr_authorities_audio_bytes_valid CHECK (
    audio_bytes BETWEEN 2 AND 16777216
    AND audio_bytes % 2 = 0
  ),
  CONSTRAINT outbound_speech_asr_authorities_sample_rate_valid CHECK (
    sample_rate_hz IN (16000, 24000, 44100, 48000)
  ),
  CONSTRAINT outbound_speech_asr_authorities_duration_valid CHECK (
    audio_duration_ms > 0
    AND audio_duration_ms <= 180000
    AND abs(
      audio_duration_ms
      - (audio_bytes::numeric * 500 / sample_rate_hz::numeric)
    ) <= 0.001
  ),
  CONSTRAINT outbound_speech_asr_authorities_reservation_valid CHECK (
    reserved_micro_usd BETWEEN 6000 AND 18000
    AND reserved_micro_usd % 6000 = 0
  ),
  CONSTRAINT outbound_speech_asr_authorities_funding_source_valid CHECK (
    funding_source = 'tenant_openai_byok'
  ),
  CONSTRAINT outbound_speech_asr_authorities_claim_token_v4 CHECK (
    claim_token::text ~
      '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  ),
  CONSTRAINT outbound_speech_asr_authorities_state_valid CHECK (
    state IN ('claimed', 'dispatched', 'settled', 'failed', 'indeterminate')
  ),
  CONSTRAINT outbound_speech_asr_authorities_failure_code_valid CHECK (
    failure_code IS NULL
    OR failure_code ~ '^[a-z][a-z0-9_]{0,127}$'
  ),
  CONSTRAINT outbound_speech_asr_authorities_receipt_valid CHECK (
    receipt_json IS NULL
    OR (
      jsonb_typeof(receipt_json) = 'object'
      AND receipt_json <> '{}'::jsonb
      AND octet_length(receipt_json::text) <= 65536
    )
  ),
  CONSTRAINT outbound_speech_asr_authorities_lifecycle_valid CHECK (
    (
      state = 'claimed'
      AND dispatched_at IS NULL
      AND terminal_at IS NULL
      AND receipt_json IS NULL
      AND failure_code IS NULL
    )
    OR (
      state = 'dispatched'
      AND dispatched_at IS NOT NULL
      AND terminal_at IS NULL
      AND receipt_json IS NULL
      AND failure_code IS NULL
    )
    OR (
      state = 'settled'
      AND dispatched_at IS NOT NULL
      AND terminal_at IS NOT NULL
      AND receipt_json IS NOT NULL
      AND failure_code IS NULL
    )
    OR (
      state = 'failed'
      AND dispatched_at IS NULL
      AND terminal_at IS NOT NULL
      AND receipt_json IS NULL
      AND failure_code = 'local_failure'
    )
    OR (
      state = 'indeterminate'
      AND dispatched_at IS NOT NULL
      AND terminal_at IS NOT NULL
      AND receipt_json IS NULL
      AND failure_code IN ('provider_outcome_unknown', 'settlement_unknown')
    )
  ),
  CONSTRAINT outbound_speech_asr_authorities_time_order_valid CHECK (
    updated_at >= COALESCE(terminal_at, dispatched_at, claimed_at)
    AND (dispatched_at IS NULL OR dispatched_at >= claimed_at)
    AND (
      terminal_at IS NULL
      OR terminal_at >= COALESCE(dispatched_at, claimed_at)
    )
  )
);

COMMENT ON TABLE hacc_private.outbound_speech_asr_authorities IS
  'Private, one-shot paid-ASR authority bound to one tenant, call, provider response, and exact PCM16 payload.';
COMMENT ON COLUMN hacc_private.outbound_speech_asr_authorities.authority_id IS
  'Publicly non-derivable v4 identity for the durable ASR authority row; never a bearer credential.';
COMMENT ON COLUMN hacc_private.outbound_speech_asr_authorities.claim_token IS
  'Unique one-shot claim bearer retained as immutable evidence after terminalization.';
COMMENT ON COLUMN hacc_private.outbound_speech_asr_authorities.receipt_json IS
  'Bounded private ASR receipt. It is present only for a settled provider outcome.';
COMMENT ON COLUMN hacc_private.outbound_speech_asr_authorities.failure_code IS
  'Bounded machine-readable failure class; raw provider bodies and exception text are forbidden.';

CREATE INDEX IF NOT EXISTS idx_outbound_speech_asr_authorities_call
  ON hacc_private.outbound_speech_asr_authorities(
    org_id,
    call_id,
    claimed_at DESC,
    authority_id
  );
CREATE INDEX IF NOT EXISTS idx_outbound_speech_asr_authorities_unresolved
  ON hacc_private.outbound_speech_asr_authorities(
    updated_at,
    authority_id
  )
  WHERE state IN ('claimed', 'dispatched', 'indeterminate');
CREATE INDEX IF NOT EXISTS idx_outbound_speech_asr_authorities_org_day
  ON hacc_private.outbound_speech_asr_authorities(
    org_id,
    claimed_at
  )
  INCLUDE (reserved_micro_usd);

CREATE OR REPLACE FUNCTION hacc_private.enforce_outbound_speech_asr_authority_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $outbound_speech_asr_authority_scope$
BEGIN
  PERFORM 1
  FROM public.calls AS call
  JOIN public.agents AS agent ON agent.id = call.agent_id
  WHERE call.id = NEW.call_id
    AND agent.org_id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'outbound_speech_asr_authority_call_org_mismatch';
  END IF;
  RETURN NEW;
END
$outbound_speech_asr_authority_scope$;

DROP TRIGGER IF EXISTS trg_outbound_speech_asr_authority_scope
  ON hacc_private.outbound_speech_asr_authorities;
CREATE TRIGGER trg_outbound_speech_asr_authority_scope
BEFORE INSERT OR UPDATE OF org_id, call_id
ON hacc_private.outbound_speech_asr_authorities
FOR EACH ROW
EXECUTE FUNCTION hacc_private.enforce_outbound_speech_asr_authority_scope();

CREATE OR REPLACE FUNCTION hacc_private.enforce_outbound_speech_asr_authority_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $outbound_speech_asr_authority_lifecycle$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.call_id IS DISTINCT FROM OLD.call_id
     OR NEW.response_id IS DISTINCT FROM OLD.response_id
     OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.audio_sha256 IS DISTINCT FROM OLD.audio_sha256
     OR NEW.audio_bytes IS DISTINCT FROM OLD.audio_bytes
     OR NEW.sample_rate_hz IS DISTINCT FROM OLD.sample_rate_hz
     OR NEW.audio_duration_ms IS DISTINCT FROM OLD.audio_duration_ms
     OR NEW.reserved_micro_usd IS DISTINCT FROM OLD.reserved_micro_usd
     OR NEW.funding_source IS DISTINCT FROM OLD.funding_source
     OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'outbound_speech_asr_authority_binding_is_immutable';
  END IF;

  IF OLD.state IN ('settled', 'failed', 'indeterminate') THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'outbound_speech_asr_authority_is_terminal';
  END IF;
  IF NOT (
    (OLD.state = 'claimed'
      AND NEW.state IN ('dispatched', 'failed'))
    OR
    (OLD.state = 'dispatched'
      AND NEW.state IN ('settled', 'failed', 'indeterminate'))
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'outbound_speech_asr_authority_transition_is_invalid';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'outbound_speech_asr_authority_time_moved_backwards';
  END IF;
  RETURN NEW;
END
$outbound_speech_asr_authority_lifecycle$;

DROP TRIGGER IF EXISTS trg_outbound_speech_asr_authority_lifecycle
  ON hacc_private.outbound_speech_asr_authorities;
CREATE TRIGGER trg_outbound_speech_asr_authority_lifecycle
BEFORE UPDATE ON hacc_private.outbound_speech_asr_authorities
FOR EACH ROW
EXECUTE FUNCTION hacc_private.enforce_outbound_speech_asr_authority_lifecycle();

ALTER TABLE hacc_private.outbound_speech_asr_authorities
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE hacc_private.outbound_speech_asr_authorities
  FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hacc_backend_all
  ON hacc_private.outbound_speech_asr_authorities;
DO $outbound_speech_asr_backend_policy$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    CREATE POLICY hacc_backend_all
      ON hacc_private.outbound_speech_asr_authorities
      FOR ALL TO hacc_backend
      USING (true)
      WITH CHECK (true);
  END IF;
END
$outbound_speech_asr_backend_policy$;

DROP POLICY IF EXISTS hacc_migration_owner_all
  ON hacc_private.outbound_speech_asr_authorities;
DO $outbound_speech_asr_owner_policy$
BEGIN
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all '
    'ON hacc_private.outbound_speech_asr_authorities '
    'FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$outbound_speech_asr_owner_policy$;

REVOKE ALL ON hacc_private.outbound_speech_asr_authorities FROM PUBLIC;
REVOKE ALL ON FUNCTION
  hacc_private.enforce_outbound_speech_asr_authority_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  hacc_private.enforce_outbound_speech_asr_authority_lifecycle() FROM PUBLIC;

DO $outbound_speech_asr_private_grants$
DECLARE
  runtime_role text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    GRANT USAGE ON SCHEMA hacc_private TO hacc_backend;
    GRANT SELECT, INSERT, UPDATE
      ON hacc_private.outbound_speech_asr_authorities TO hacc_backend;
    REVOKE DELETE, TRUNCATE
      ON hacc_private.outbound_speech_asr_authorities FROM hacc_backend;
  END IF;

  FOREACH runtime_role IN ARRAY
    ARRAY['anon', 'authenticated', 'service_role', 'hacc_worker']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE ALL ON hacc_private.outbound_speech_asr_authorities FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION '
        'hacc_private.enforce_outbound_speech_asr_authority_scope() FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION '
        'hacc_private.enforce_outbound_speech_asr_authority_lifecycle() FROM %I',
        runtime_role
      );
    END IF;
  END LOOP;
END
$outbound_speech_asr_private_grants$;

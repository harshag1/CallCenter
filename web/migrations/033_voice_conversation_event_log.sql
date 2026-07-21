-- One durable, tamper-evident event log for every long-running voice conversation.
-- All mission, fact, policy, commitment, and worker state is a deterministic projection
-- of this ledger. Runtime roles can only compare-and-append or read an org-scoped prefix.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.voice_conversations
  ADD COLUMN IF NOT EXISTS event_head_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE public.voice_conversations
  ADD COLUMN IF NOT EXISTS event_head_sha256 text NOT NULL DEFAULT repeat('0', 64);
ALTER TABLE public.voice_conversations
  DROP CONSTRAINT IF EXISTS voice_conversations_event_head_valid;
ALTER TABLE public.voice_conversations
  ADD CONSTRAINT voice_conversations_event_head_valid CHECK (
    event_head_sequence >= 0
    AND event_head_sha256 ~ '^[a-f0-9]{64}$'
    AND (event_head_sequence > 0 OR event_head_sha256 = repeat('0', 64))
  );

CREATE TABLE IF NOT EXISTS public.voice_conversation_events (
  conversation_id uuid NOT NULL,
  org_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_id text NOT NULL CHECK (
    octet_length(event_id) BETWEEN 1 AND 128
    AND event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 256),
  occurred_at_ms bigint NOT NULL CHECK (occurred_at_ms BETWEEN 0 AND 9007199254740991),
  event_type text NOT NULL CHECK (
    octet_length(event_type) BETWEEN 1 AND 128
    AND event_type ~ '^[a-z][a-z0-9._:-]*$'
  ),
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object'
    AND octet_length(payload::text) <= 24576
  ),
  previous_event_sha256 text NOT NULL CHECK (previous_event_sha256 ~ '^[a-f0-9]{64}$'),
  event_sha256 text NOT NULL CHECK (event_sha256 ~ '^[a-f0-9]{64}$'),
  -- Exact canonical bytes make independently recomputing the kernel hash possible.
  unsigned_event_text text NOT NULL CHECK (octet_length(unsigned_event_text) <= 32768),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (conversation_id, sequence),
  UNIQUE (conversation_id, event_id),
  UNIQUE (conversation_id, idempotency_key),
  UNIQUE (conversation_id, event_sha256),
  CONSTRAINT voice_conversation_events_conversation_fk
    FOREIGN KEY (conversation_id, org_id)
    REFERENCES public.voice_conversations(id, org_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_voice_conversation_events_org_conversation
  ON public.voice_conversation_events(org_id, conversation_id, sequence);

CREATE OR REPLACE FUNCTION public.reject_voice_conversation_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $voice_conversation_event_immutable$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_events_are_append_only';
END
$voice_conversation_event_immutable$;

DROP TRIGGER IF EXISTS trg_voice_conversation_events_append_only
  ON public.voice_conversation_events;
CREATE TRIGGER trg_voice_conversation_events_append_only
BEFORE UPDATE OR DELETE ON public.voice_conversation_events
FOR EACH ROW EXECUTE FUNCTION public.reject_voice_conversation_event_mutation();

-- Migration 032 validates the shape of a worker's head binding. Once the
-- authoritative event head exists, this insert guard also validates freshness.
-- Exact idempotent replays bypass the freshness check and are compared against
-- their immutable persisted digests by spawn_voice_worker_job; new work must
-- bind to the locked current head.
CREATE OR REPLACE FUNCTION public.enforce_voice_worker_conversation_head()
RETURNS trigger LANGUAGE plpgsql AS $voice_worker_conversation_head$
DECLARE
  conversation public.voice_conversations%ROWTYPE;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.voice_worker_jobs existing
    WHERE existing.conversation_id = NEW.conversation_id
      AND existing.idempotency_key = NEW.idempotency_key
  ) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT conversation
  FROM public.voice_conversations
  WHERE id = NEW.conversation_id AND org_id = NEW.org_id
  FOR SHARE;
  IF COALESCE(NEW.spawn_authority->>'conversationHeadSha256', '')
       <> conversation.event_head_sha256
     OR COALESCE(jsonb_typeof(NEW.spawn_authority->'conversationRevision'), '') <> 'number'
     OR (NEW.spawn_authority->>'conversationRevision')::numeric
       <> conversation.event_head_sequence THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_spawn_stale_conversation_head';
  END IF;
  RETURN NEW;
END
$voice_worker_conversation_head$;

DROP TRIGGER IF EXISTS trg_voice_worker_conversation_head
  ON public.voice_worker_jobs;
CREATE TRIGGER trg_voice_worker_conversation_head
BEFORE INSERT ON public.voice_worker_jobs
FOR EACH ROW EXECUTE FUNCTION public.enforce_voice_worker_conversation_head();

CREATE OR REPLACE FUNCTION public.read_voice_conversation_head(
  conversation_identity uuid,
  organization_identity uuid
) RETURNS TABLE(head_sequence bigint, head_sha256 text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $read_voice_conversation_head$
BEGIN
  RETURN QUERY
    SELECT conversation.event_head_sequence, conversation.event_head_sha256
    FROM public.voice_conversations conversation
    WHERE conversation.id = conversation_identity
      AND conversation.org_id = organization_identity;
END
$read_voice_conversation_head$;

CREATE OR REPLACE FUNCTION public.load_voice_conversation_events(
  conversation_identity uuid,
  organization_identity uuid,
  after_sequence bigint DEFAULT 0,
  through_sequence bigint DEFAULT 9223372036854775807,
  maximum_events integer DEFAULT 1024
) RETURNS SETOF public.voice_conversation_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $load_voice_conversation_events$
BEGIN
  IF after_sequence < 0 OR through_sequence < after_sequence
     OR maximum_events NOT BETWEEN 1 AND 4096 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_event_read_invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.voice_conversations conversation
    WHERE conversation.id = conversation_identity
      AND conversation.org_id = organization_identity
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT event.*
    FROM public.voice_conversation_events event
    WHERE event.conversation_id = conversation_identity
      AND event.org_id = organization_identity
      AND event.sequence > after_sequence
      AND event.sequence <= through_sequence
    ORDER BY event.sequence
    LIMIT maximum_events;
END
$load_voice_conversation_events$;

-- The batch is an array of
-- {idempotencyKey, unsignedEvent, eventHash}. `unsignedEvent` is the exact
-- canonical JSON hashed by conversation-kernel.ts. A whole batch either commits
-- or rolls back. An exact full-batch retry replays even after the head advances;
-- partial or changed retries are rejected rather than guessed at.
CREATE OR REPLACE FUNCTION public.append_voice_conversation_events(
  conversation_identity uuid,
  organization_identity uuid,
  expected_head_sha256 text,
  batch_text text,
  batch_sha256 text
) RETURNS SETOF public.voice_conversation_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $append_voice_conversation_events$
DECLARE
  conversation public.voice_conversations%ROWTYPE;
  batch jsonb;
  item jsonb;
  unsigned_event jsonb;
  existing public.voice_conversation_events%ROWTYPE;
  batch_count integer;
  existing_count integer := 0;
  item_ordinal bigint := 0;
  next_sequence bigint;
  rolling_hash text;
  item_key text;
  item_unsigned_text text;
  item_hash text;
  item_event_id text;
  item_occurred_at_ms bigint;
  item_event_type text;
  batch_event_ids text[] := ARRAY[]::text[];
BEGIN
  IF expected_head_sha256 !~ '^[a-f0-9]{64}$'
     OR octet_length(batch_text) > 2097152
     OR batch_sha256 <> encode(digest(batch_text, 'sha256'), 'hex') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_event_batch_invalid';
  END IF;
  BEGIN
    batch := batch_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_event_batch_invalid';
  END;
  IF jsonb_typeof(batch) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_event_batch_invalid';
  END IF;
  batch_count := jsonb_array_length(batch);
  IF batch_count NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_event_batch_invalid';
  END IF;
  IF (SELECT count(DISTINCT value->>'idempotencyKey') FROM jsonb_array_elements(batch)) <> batch_count THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_event_batch_duplicate_identity';
  END IF;

  SELECT * INTO conversation
  FROM public.voice_conversations
  WHERE id = conversation_identity AND org_id = organization_identity
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_not_found';
  END IF;
  IF conversation.status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_closed';
  END IF;

  -- Validate every byte and identify full-batch replays before comparing heads.
  FOR item IN SELECT value FROM jsonb_array_elements(batch) LOOP
    IF jsonb_typeof(item) <> 'object'
       OR item - ARRAY['idempotencyKey','unsignedEvent','eventHash']::text[] <> '{}'::jsonb
       OR jsonb_typeof(item->'idempotencyKey') <> 'string'
       OR octet_length(item->>'idempotencyKey') NOT BETWEEN 1 AND 256
       OR jsonb_typeof(item->'unsignedEvent') <> 'string'
       OR octet_length(item->>'unsignedEvent') > 32768
       OR jsonb_typeof(item->'eventHash') <> 'string'
       OR item->>'eventHash' !~ '^[a-f0-9]{64}$'
       OR item->>'eventHash' <> encode(digest(item->>'unsignedEvent', 'sha256'), 'hex') THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_event_invalid';
    END IF;
    BEGIN
      unsigned_event := (item->>'unsignedEvent')::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_event_invalid';
    END;
    IF jsonb_typeof(unsigned_event) <> 'object'
       OR unsigned_event - ARRAY[
         'version','conversationId','sequence','previousHash','eventId','occurredAtMs','payload'
       ]::text[] <> '{}'::jsonb
       OR jsonb_typeof(unsigned_event->'version') <> 'number'
       OR unsigned_event->>'version' <> '1'
       OR jsonb_typeof(unsigned_event->'conversationId') <> 'string'
       OR unsigned_event->>'conversationId' <> conversation_identity::text
       OR jsonb_typeof(unsigned_event->'sequence') <> 'number'
       OR (unsigned_event->>'sequence')::numeric <> trunc((unsigned_event->>'sequence')::numeric)
       OR (unsigned_event->>'sequence')::numeric NOT BETWEEN 1 AND 9007199254740991
       OR jsonb_typeof(unsigned_event->'previousHash') <> 'string'
       OR unsigned_event->>'previousHash' !~ '^[a-f0-9]{64}$'
       OR jsonb_typeof(unsigned_event->'eventId') <> 'string'
       OR octet_length(unsigned_event->>'eventId') NOT BETWEEN 1 AND 128
       OR unsigned_event->>'eventId' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
       OR jsonb_typeof(unsigned_event->'occurredAtMs') <> 'number'
       OR (unsigned_event->>'occurredAtMs')::numeric <> trunc((unsigned_event->>'occurredAtMs')::numeric)
       OR (unsigned_event->>'occurredAtMs')::numeric NOT BETWEEN 0 AND 9007199254740991
       OR jsonb_typeof(unsigned_event->'payload') <> 'object'
       OR jsonb_typeof(unsigned_event->'payload'->'type') <> 'string'
       OR octet_length(unsigned_event->'payload'->>'type') NOT BETWEEN 1 AND 128
       OR unsigned_event->'payload'->>'type' !~ '^[a-z][a-z0-9._:-]*$'
       OR octet_length((unsigned_event->'payload')::text) > 24576 THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_event_invalid';
    END IF;
    item_event_id := unsigned_event->>'eventId';
    IF item_event_id = ANY(batch_event_ids) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_event_batch_duplicate_identity';
    END IF;
    batch_event_ids := array_append(batch_event_ids, item_event_id);
    SELECT * INTO existing
    FROM public.voice_conversation_events event
    WHERE event.conversation_id = conversation_identity
      AND event.idempotency_key = item->>'idempotencyKey';
    IF FOUND THEN
      existing_count := existing_count + 1;
      IF existing.event_sha256 <> item->>'eventHash'
         OR existing.unsigned_event_text <> item->>'unsignedEvent'
         OR existing.event_id <> unsigned_event->>'eventId' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_event_idempotency_conflict';
      END IF;
    ELSIF EXISTS (
      SELECT 1 FROM public.voice_conversation_events event
      WHERE event.conversation_id = conversation_identity
        AND event.event_id = unsigned_event->>'eventId'
    ) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_event_identity_conflict';
    END IF;
  END LOOP;

  IF existing_count > 0 THEN
    IF existing_count <> batch_count THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_event_mixed_replay';
    END IF;
    RETURN QUERY
      SELECT event.*
      FROM jsonb_array_elements(batch) WITH ORDINALITY requested(value, ordinal)
      JOIN public.voice_conversation_events event
        ON event.conversation_id = conversation_identity
       AND event.idempotency_key = requested.value->>'idempotencyKey'
      ORDER BY requested.ordinal;
    RETURN;
  END IF;

  IF conversation.event_head_sha256 <> expected_head_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='voice_conversation_event_head_conflict';
  END IF;
  next_sequence := conversation.event_head_sequence;
  rolling_hash := conversation.event_head_sha256;

  FOR item IN SELECT value FROM jsonb_array_elements(batch) LOOP
    item_ordinal := item_ordinal + 1;
    unsigned_event := (item->>'unsignedEvent')::jsonb;
    item_key := item->>'idempotencyKey';
    item_unsigned_text := item->>'unsignedEvent';
    item_hash := item->>'eventHash';
    item_event_id := unsigned_event->>'eventId';
    item_occurred_at_ms := (unsigned_event->>'occurredAtMs')::bigint;
    item_event_type := unsigned_event->'payload'->>'type';
    IF (unsigned_event->>'sequence')::bigint <> next_sequence + item_ordinal
       OR unsigned_event->>'previousHash' <> rolling_hash THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_event_chain_invalid';
    END IF;
    INSERT INTO public.voice_conversation_events(
      conversation_id, org_id, sequence, event_id, idempotency_key,
      occurred_at_ms, event_type, payload, previous_event_sha256,
      event_sha256, unsigned_event_text
    ) VALUES (
      conversation_identity, organization_identity, next_sequence + item_ordinal,
      item_event_id, item_key, item_occurred_at_ms, item_event_type,
      unsigned_event->'payload', rolling_hash, item_hash, item_unsigned_text
    );
    rolling_hash := item_hash;
  END LOOP;

  UPDATE public.voice_conversations
  SET event_head_sequence = next_sequence + batch_count,
      event_head_sha256 = rolling_hash,
      updated_at = clock_timestamp()
  WHERE id = conversation_identity AND org_id = organization_identity;

  RETURN QUERY
    SELECT event.*
    FROM jsonb_array_elements(batch) WITH ORDINALITY requested(value, ordinal)
    JOIN public.voice_conversation_events event
      ON event.conversation_id = conversation_identity
     AND event.idempotency_key = requested.value->>'idempotencyKey'
    ORDER BY requested.ordinal;
END
$append_voice_conversation_events$;

DO $voice_conversation_event_rls$
DECLARE api_role text;
BEGIN
  ALTER TABLE public.voice_conversation_events ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.voice_conversation_events FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS hacc_migration_owner_all ON public.voice_conversation_events;
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON public.voice_conversation_events FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
  REVOKE ALL ON public.voice_conversation_events FROM PUBLIC;
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role','hacc_backend','hacc_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.voice_conversation_events FROM %I', api_role);
    END IF;
  END LOOP;
END
$voice_conversation_event_rls$;

REVOKE ALL ON FUNCTION public.read_voice_conversation_head(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.load_voice_conversation_events(uuid,uuid,bigint,bigint,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.append_voice_conversation_events(uuid,uuid,text,text,text) FROM PUBLIC;

DO $voice_conversation_event_function_grants$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role','hacc_backend','hacc_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.read_voice_conversation_head(uuid,uuid) FROM %I', api_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.load_voice_conversation_events(uuid,uuid,bigint,bigint,integer) FROM %I', api_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.append_voice_conversation_events(uuid,uuid,text,text,text) FROM %I', api_role
      );
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    GRANT EXECUTE ON FUNCTION public.read_voice_conversation_head(uuid,uuid) TO hacc_backend;
    GRANT EXECUTE ON FUNCTION public.load_voice_conversation_events(uuid,uuid,bigint,bigint,integer) TO hacc_backend;
    GRANT EXECUTE ON FUNCTION public.append_voice_conversation_events(uuid,uuid,text,text,text) TO hacc_backend;
  END IF;
END
$voice_conversation_event_function_grants$;

COMMENT ON TABLE public.voice_conversation_events IS
  'Org-scoped append-only conversation kernel events. One serialized hash chain per voice_conversation; no runtime role has direct table mutation authority.';

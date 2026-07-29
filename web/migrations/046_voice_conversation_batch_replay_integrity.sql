-- Upgrade the durable conversation append boundary without rewriting migration 033.
--
-- Migration 033 verified every replayed event independently, but an all-existing
-- request could still reorder or skip those events and be returned as a successful
-- "full batch" replay. Preserve the already-deployed implementation as a private
-- primitive, then put an exact contiguous-range proof in front of every result.

DO $voice_conversation_append_v1_preserve$
BEGIN
  IF to_regprocedure(
    'public.append_voice_conversation_events_v1_internal(uuid,uuid,text,text,text)'
  ) IS NULL THEN
    ALTER FUNCTION public.append_voice_conversation_events(uuid,uuid,text,text,text)
      RENAME TO append_voice_conversation_events_v1_internal;
  END IF;
END
$voice_conversation_append_v1_preserve$;

CREATE OR REPLACE FUNCTION public.append_voice_conversation_events(
  conversation_identity uuid,
  organization_identity uuid,
  expected_head_sha256 text,
  batch_text text,
  batch_sha256 text
) RETURNS SETOF public.voice_conversation_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public
AS $append_voice_conversation_events_exact_replay$
DECLARE
  batch jsonb;
  batch_count integer;
  returned_count integer;
  item jsonb;
  unsigned_event jsonb;
  item_ordinal bigint := 0;
  first_sequence bigint := 0;
  expected_sequence bigint;
  rolling_hash text := expected_head_sha256;
  existing public.voice_conversation_events%ROWTYPE;
BEGIN
  -- The v1 primitive retains the serialized compare-and-append, byte validation,
  -- conflict detection, and atomicity contract. Its row locks remain held through
  -- this wrapper, so a new append and the following proof share one transaction.
  SELECT count(*)::integer
  INTO returned_count
  FROM public.append_voice_conversation_events_v1_internal(
    conversation_identity,
    organization_identity,
    expected_head_sha256,
    batch_text,
    batch_sha256
  );

  batch := batch_text::jsonb;
  batch_count := jsonb_array_length(batch);
  IF returned_count IS DISTINCT FROM batch_count THEN
    RAISE EXCEPTION USING
      ERRCODE='P0001',
      MESSAGE='voice_conversation_event_batch_replay_invalid';
  END IF;

  FOR item IN
    SELECT value
    FROM jsonb_array_elements(batch)
  LOOP
    item_ordinal := item_ordinal + 1;
    unsigned_event := (item->>'unsignedEvent')::jsonb;

    SELECT event.*
    INTO STRICT existing
    FROM public.voice_conversation_events event
    WHERE event.conversation_id = conversation_identity
      AND event.org_id = organization_identity
      AND event.idempotency_key = item->>'idempotencyKey';

    IF item_ordinal = 1 THEN
      first_sequence := existing.sequence;

      -- expected_head_sha256 must be the actual immediately preceding durable
      -- head, not merely a caller-selected hash that happens to match JSON.
      IF first_sequence = 1 THEN
        IF expected_head_sha256 <> repeat('0', 64) THEN
          RAISE EXCEPTION USING
            ERRCODE='P0001',
            MESSAGE='voice_conversation_event_batch_replay_invalid';
        END IF;
      ELSIF first_sequence < 1 OR NOT EXISTS (
        SELECT 1
        FROM public.voice_conversation_events predecessor
        WHERE predecessor.conversation_id = conversation_identity
          AND predecessor.org_id = organization_identity
          AND predecessor.sequence = first_sequence - 1
          AND predecessor.event_sha256 = expected_head_sha256
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE='P0001',
          MESSAGE='voice_conversation_event_batch_replay_invalid';
      END IF;
    END IF;

    expected_sequence := first_sequence + item_ordinal - 1;

    -- Prove that both the immutable row projection and the canonical bytes form
    -- exactly the submitted contiguous range in submitted order.
    IF existing.sequence IS DISTINCT FROM expected_sequence
       OR existing.previous_event_sha256 IS DISTINCT FROM rolling_hash
       OR existing.event_sha256 IS DISTINCT FROM item->>'eventHash'
       OR existing.unsigned_event_text IS DISTINCT FROM item->>'unsignedEvent'
       OR existing.event_id IS DISTINCT FROM unsigned_event->>'eventId'
       OR existing.occurred_at_ms IS DISTINCT FROM (unsigned_event->>'occurredAtMs')::bigint
       OR existing.event_type IS DISTINCT FROM unsigned_event->'payload'->>'type'
       OR existing.payload IS DISTINCT FROM unsigned_event->'payload'
       OR (unsigned_event->>'sequence')::bigint IS DISTINCT FROM expected_sequence
       OR unsigned_event->>'previousHash' IS DISTINCT FROM rolling_hash THEN
      RAISE EXCEPTION USING
        ERRCODE='P0001',
        MESSAGE='voice_conversation_event_batch_replay_invalid';
    END IF;

    rolling_hash := existing.event_sha256;
  END LOOP;

  RETURN QUERY
    SELECT event.*
    FROM jsonb_array_elements(batch) WITH ORDINALITY requested(value, ordinal)
    JOIN public.voice_conversation_events event
      ON event.conversation_id = conversation_identity
     AND event.org_id = organization_identity
     AND event.idempotency_key = requested.value->>'idempotencyKey'
    ORDER BY requested.ordinal;
END
$append_voice_conversation_events_exact_replay$;

REVOKE ALL ON FUNCTION
  public.append_voice_conversation_events_v1_internal(uuid,uuid,text,text,text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.append_voice_conversation_events(uuid,uuid,text,text,text)
  FROM PUBLIC;

DO $voice_conversation_append_exact_replay_grants$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY[
    'anon',
    'authenticated',
    'service_role',
    'hacc_backend',
    'hacc_worker',
    'hacc_runtime',
    'hacc_worker_runtime',
    'hacc_voice_worker',
    'hacc_voice_worker_runtime',
    'hacc_dialer_worker',
    'hacc_dialer_worker_runtime'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.append_voice_conversation_events_v1_internal(uuid,uuid,text,text,text) FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.append_voice_conversation_events(uuid,uuid,text,text,text) FROM %I',
        api_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    GRANT EXECUTE ON FUNCTION
      public.append_voice_conversation_events(uuid,uuid,text,text,text)
      TO hacc_backend;
  END IF;
END
$voice_conversation_append_exact_replay_grants$;

COMMENT ON FUNCTION public.append_voice_conversation_events(uuid,uuid,text,text,text) IS
  'Atomically appends or exactly replays one contiguous, expected-head-anchored durable conversation event range.';

COMMENT ON FUNCTION
  public.append_voice_conversation_events_v1_internal(uuid,uuid,text,text,text) IS
  'Private migration-033 append primitive. Runtime roles must use the exact replay wrapper.';

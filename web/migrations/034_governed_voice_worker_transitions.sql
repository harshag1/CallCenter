-- Atomically couple durable workers to the authoritative conversation hash chain.
-- A backend cannot create a worker or consume its result without committing the
-- corresponding, precomputed conversation-kernel event in the same transaction.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.spawn_governed_voice_worker(
  conversation_identity uuid,
  organization_identity uuid,
  expected_head_sha256 text,
  conversation_event_idempotency_key text,
  unsigned_event_text text,
  event_sha256 text,
  worker_identity uuid,
  worker_idempotency_key text,
  requested_worker_kind text,
  authority_text text,
  authority_sha256 text,
  input_text text,
  input_sha256 text,
  manifest_text text,
  manifest_sha256 text,
  source_call_identity uuid DEFAULT NULL,
  parent_worker_identity uuid DEFAULT NULL
) RETURNS TABLE(conversation_event jsonb, worker_job jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $spawn_governed_voice_worker$
DECLARE
  unsigned_event jsonb;
  payload jsonb;
  authority jsonb;
  worker_input jsonb;
  event_batch_text text;
  appended public.voice_conversation_events%ROWTYPE;
  spawned public.voice_worker_jobs%ROWTYPE;
BEGIN
  BEGIN
    unsigned_event := unsigned_event_text::jsonb;
    authority := authority_text::jsonb;
    worker_input := input_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_spawn_invalid_json';
  END;
  payload := unsigned_event->'payload';

  -- The event is the worker contract. Its purpose and authority must be exact,
  -- not merely compatible, and the worker binds to the post-append head.
  IF event_sha256 <> encode(digest(unsigned_event_text, 'sha256'), 'hex')
     OR jsonb_typeof(payload) <> 'object'
     OR payload <> jsonb_build_object(
       'type', 'worker.spawned',
       'workerId', worker_identity::text,
       'goalId', authority->'goalId',
       'purpose', worker_input->'objective',
       'policyEpoch', authority->'policyEpoch',
       'dependencies', authority->'factDependencies'
     )
     OR COALESCE(authority->>'conversationId', '') <> conversation_identity::text
     OR COALESCE(authority->>'organizationId', '') <> organization_identity::text
     OR COALESCE(authority->>'conversationHeadSha256', '') <> event_sha256
     OR COALESCE(jsonb_typeof(authority->'conversationRevision'), '') <> 'number'
     OR COALESCE(jsonb_typeof(unsigned_event->'sequence'), '') <> 'number'
     OR (authority->>'conversationRevision')::numeric <> (unsigned_event->>'sequence')::numeric
     OR COALESCE(unsigned_event->>'previousHash', '') <> expected_head_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_spawn_event_authority_mismatch';
  END IF;

  event_batch_text := jsonb_build_array(jsonb_build_object(
    'idempotencyKey', conversation_event_idempotency_key,
    'unsignedEvent', unsigned_event_text,
    'eventHash', event_sha256
  ))::text;

  SELECT event.* INTO STRICT appended
  FROM public.append_voice_conversation_events(
    conversation_identity,
    organization_identity,
    expected_head_sha256,
    event_batch_text,
    encode(digest(event_batch_text, 'sha256'), 'hex')
  ) event;
  IF appended.event_sha256 <> event_sha256
     OR appended.event_type <> 'worker.spawned'
     OR appended.idempotency_key <> conversation_event_idempotency_key THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_spawn_event_replay_mismatch';
  END IF;

  spawned := public.spawn_voice_worker_job(
    worker_identity,
    conversation_identity,
    worker_idempotency_key,
    requested_worker_kind,
    authority_text,
    authority_sha256,
    input_text,
    input_sha256,
    manifest_text,
    manifest_sha256,
    source_call_identity,
    parent_worker_identity
  );
  IF spawned.id <> worker_identity
     OR spawned.conversation_id <> conversation_identity
     OR spawned.org_id <> organization_identity
     OR spawned.spawn_authority_sha256 <> authority_sha256
     OR spawned.worker_input_sha256 <> input_sha256
     OR spawned.capability_manifest_sha256 <> manifest_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_spawn_identity_mismatch';
  END IF;

  RETURN QUERY SELECT to_jsonb(appended), to_jsonb(spawned);
END
$spawn_governed_voice_worker$;

CREATE OR REPLACE FUNCTION public.apply_governed_voice_worker_result(
  message_identity uuid,
  conversation_identity uuid,
  organization_identity uuid,
  delivery_identity uuid,
  application_identity uuid,
  expected_head_sha256 text,
  conversation_event_idempotency_key text,
  unsigned_event_text text,
  event_sha256 text
) RETURNS TABLE(conversation_event jsonb, inbox_message jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $apply_governed_voice_worker_result$
DECLARE
  message public.voice_conversation_inbox%ROWTYPE;
  worker public.voice_worker_jobs%ROWTYPE;
  unsigned_event jsonb;
  payload jsonb;
  expected_payload jsonb;
  event_batch_text text;
  appended public.voice_conversation_events%ROWTYPE;
  applied public.voice_conversation_inbox%ROWTYPE;
BEGIN
  BEGIN
    unsigned_event := unsigned_event_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_result_invalid_json';
  END;

  SELECT inbox.* INTO message
  FROM public.voice_conversation_inbox inbox
  WHERE inbox.id = message_identity
    AND inbox.conversation_id = conversation_identity
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_result_not_found';
  END IF;
  SELECT job.* INTO STRICT worker
  FROM public.voice_worker_jobs job
  WHERE job.id = message.worker_id
    AND job.conversation_id = conversation_identity
    AND job.org_id = organization_identity;

  IF worker.status <> 'succeeded'
     OR worker.result IS NULL
     OR worker.result_sha256 IS NULL
     OR message.payload_sha256 <> worker.result_sha256
     OR message.payload <> worker.result
     OR message.source_event_sha256 IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_result_evidence_mismatch';
  END IF;

  SELECT jsonb_build_object(
    'type', 'worker.result_delivered',
    'deliveryId', message.id::text,
    'workerId', worker.id::text,
    'goalId', worker.spawn_authority->'goalId',
    'policyEpoch', worker.spawn_authority->'policyEpoch',
    'dependencyFactRevisions', worker.spawn_authority->'factDependencies',
    'facts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'key', fact.value->'key',
        'value', fact.value->'value',
        'evidenceId', COALESCE(
          fact.value->'citationIds'->>0,
          'result-' || left(worker.result_sha256, 24)
        )
      ) ORDER BY fact.ordinality)
      FROM jsonb_array_elements(worker.result->'facts') WITH ORDINALITY fact(value, ordinality)
    ), '[]'::jsonb),
    'advisories', jsonb_build_array(jsonb_build_object(
      'episodeId', 'worker-' || worker.id::text,
      'text', worker.result->'summary'
    ))
  ) INTO expected_payload;
  payload := unsigned_event->'payload';

  IF event_sha256 <> encode(digest(unsigned_event_text, 'sha256'), 'hex')
     OR payload IS DISTINCT FROM expected_payload
     OR COALESCE(unsigned_event->>'conversationId', '') <> conversation_identity::text
     OR COALESCE(unsigned_event->>'previousHash', '') <> expected_head_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_result_event_evidence_mismatch';
  END IF;

  event_batch_text := jsonb_build_array(jsonb_build_object(
    'idempotencyKey', conversation_event_idempotency_key,
    'unsignedEvent', unsigned_event_text,
    'eventHash', event_sha256
  ))::text;
  SELECT event.* INTO STRICT appended
  FROM public.append_voice_conversation_events(
    conversation_identity,
    organization_identity,
    expected_head_sha256,
    event_batch_text,
    encode(digest(event_batch_text, 'sha256'), 'hex')
  ) event;
  IF appended.event_sha256 <> event_sha256
     OR appended.event_type <> 'worker.result_delivered'
     OR appended.idempotency_key <> conversation_event_idempotency_key THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_result_event_replay_mismatch';
  END IF;

  applied := public.apply_voice_conversation_inbox(
    message_identity,
    organization_identity,
    delivery_identity,
    application_identity
  );
  IF applied.id <> message_identity
     OR applied.conversation_id <> conversation_identity
     OR applied.worker_id <> worker.id
     OR applied.payload_sha256 <> worker.result_sha256
     OR applied.application_id <> application_identity
     OR applied.applied_at IS NULL
     OR applied.acknowledged_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_result_application_mismatch';
  END IF;

  RETURN QUERY SELECT to_jsonb(appended), to_jsonb(applied);
END
$apply_governed_voice_worker_result$;

REVOKE ALL ON FUNCTION public.spawn_governed_voice_worker(
  uuid,uuid,text,text,text,text,uuid,text,text,text,text,text,text,text,text,uuid,uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_governed_voice_worker_result(
  uuid,uuid,uuid,uuid,uuid,text,text,text,text
) FROM PUBLIC;

-- Remove the two backend bypasses. Worker executors retain their lease/settle
-- surface; only backend admission and result application become ledger-coupled.
DO $governed_voice_worker_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    REVOKE EXECUTE ON FUNCTION public.spawn_voice_worker_job(
      uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid
    ) FROM hacc_backend;
    REVOKE EXECUTE ON FUNCTION public.apply_voice_conversation_inbox(
      uuid,uuid,uuid,uuid
    ) FROM hacc_backend;
    GRANT EXECUTE ON FUNCTION public.spawn_governed_voice_worker(
      uuid,uuid,text,text,text,text,uuid,text,text,text,text,text,text,text,text,uuid,uuid
    ) TO hacc_backend;
    GRANT EXECUTE ON FUNCTION public.apply_governed_voice_worker_result(
      uuid,uuid,uuid,uuid,uuid,text,text,text,text
    ) TO hacc_backend;
  END IF;
END
$governed_voice_worker_grants$;

COMMENT ON FUNCTION public.spawn_governed_voice_worker(
  uuid,uuid,text,text,text,text,uuid,text,text,text,text,text,text,text,text,uuid,uuid
) IS 'Atomically appends one worker.spawned kernel event and inserts or exactly replays its head-bound read-only worker.';
COMMENT ON FUNCTION public.apply_governed_voice_worker_result(
  uuid,uuid,uuid,uuid,uuid,text,text,text,text
) IS 'Atomically appends one evidence-bound worker.result_delivered kernel event and exactly-once applies the claimed inbox message.';

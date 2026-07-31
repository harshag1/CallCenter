-- Exact, tenant-scoped execution and terminal projection for app-triggered
-- governed call workers. The broad queue claim remains a scheduler-only
-- hacc_worker capability; hacc_backend receives only exact worker transitions.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.voice_worker_terminal_payload_sha256(
  worker_identity uuid,
  terminal_status text,
  reason_code text,
  evidence_sha256 text
) RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, extensions, public
AS $voice_worker_terminal_payload_sha256$
  SELECT encode(digest(
    convert_to('hacc/voice-worker-terminal-inbox/v1','utf8') || decode('00','hex')
      || convert_to(worker_identity::text,'utf8') || decode('00','hex')
      || convert_to(terminal_status,'utf8') || decode('00','hex')
      || convert_to(reason_code,'utf8') || decode('00','hex')
      || convert_to(evidence_sha256,'utf8'),
    'sha256'
  ), 'hex');
$voice_worker_terminal_payload_sha256$;

CREATE OR REPLACE FUNCTION public.enqueue_voice_worker_terminal_projection(
  worker_identity uuid
) RETURNS public.voice_conversation_inbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public
AS $enqueue_voice_worker_terminal_projection$
DECLARE
  job public.voice_worker_jobs%ROWTYPE;
  existing public.voice_conversation_inbox%ROWTYPE;
  terminal_event public.voice_worker_events%ROWTYPE;
  event_payload text;
  event_payload_sha256 text;
  inbox_payload jsonb;
  inbox_payload_sha256 text;
  reason_code text;
BEGIN
  SELECT * INTO STRICT job
  FROM public.voice_worker_jobs
  WHERE id = worker_identity
  FOR UPDATE;
  IF job.status NOT IN ('failed','cancelled','indeterminate') OR job.settled_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_terminal_projection_not_ready';
  END IF;

  SELECT * INTO existing
  FROM public.voice_conversation_inbox inbox
  WHERE inbox.worker_id = job.id
    AND inbox.payload->>'kind' = 'terminal'
  ORDER BY inbox.created_at, inbox.id
  LIMIT 1;
  IF FOUND THEN RETURN existing; END IF;

  reason_code := CASE
    WHEN job.status = 'failed'
      AND COALESCE(job.error->>'code','') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
      THEN job.error->>'code'
    WHEN job.status = 'failed' THEN 'worker_failed'
    WHEN job.status = 'cancelled' THEN 'worker_cancelled'
    ELSE 'worker_dispatch_indeterminate'
  END;
  event_payload := jsonb_build_object(
    'reasonCode', reason_code,
    'status', job.status
  )::text;
  event_payload_sha256 := encode(digest(event_payload,'sha256'),'hex');
  terminal_event := public.append_voice_worker_event(
    job.id,
    'terminal_projection_pending',
    event_payload,
    event_payload_sha256
  );
  inbox_payload := jsonb_build_object(
    'v', 1,
    'kind', 'terminal',
    'status', job.status,
    'reasonCode', reason_code,
    'evidenceSha256', terminal_event.event_sha256
  );
  inbox_payload_sha256 := public.voice_worker_terminal_payload_sha256(
    job.id,
    job.status,
    reason_code,
    terminal_event.event_sha256
  );
  INSERT INTO public.voice_conversation_inbox(
    id, conversation_id, worker_id, source_event_sha256, payload, payload_sha256
  ) VALUES (
    gen_random_uuid(), job.conversation_id, job.id, terminal_event.event_sha256,
    inbox_payload, inbox_payload_sha256
  )
  RETURNING * INTO existing;
  RETURN existing;
END
$enqueue_voice_worker_terminal_projection$;

CREATE OR REPLACE FUNCTION public.enqueue_voice_worker_terminal_projection_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public
AS $enqueue_voice_worker_terminal_projection_trigger$
BEGIN
  PERFORM public.enqueue_voice_worker_terminal_projection(NEW.id);
  RETURN NEW;
END
$enqueue_voice_worker_terminal_projection_trigger$;

DROP TRIGGER IF EXISTS trg_voice_worker_terminal_projection ON public.voice_worker_jobs;
CREATE TRIGGER trg_voice_worker_terminal_projection
AFTER UPDATE OF status ON public.voice_worker_jobs
FOR EACH ROW
WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  AND NEW.status IN ('failed','cancelled','indeterminate')
)
EXECUTE FUNCTION public.enqueue_voice_worker_terminal_projection_trigger();

-- Backfill terminal rows created before this migration. The helper is
-- idempotent by worker/kind and preserves the original settled timestamp in
-- the later conversation event constructed by the application.
DO $voice_worker_terminal_projection_backfill$
DECLARE terminal_job record;
BEGIN
  FOR terminal_job IN
    SELECT id
    FROM public.voice_worker_jobs
    WHERE status IN ('failed','cancelled','indeterminate')
      AND settled_at IS NOT NULL
    ORDER BY created_at, id
  LOOP
    PERFORM public.enqueue_voice_worker_terminal_projection(terminal_job.id);
  END LOOP;
END
$voice_worker_terminal_projection_backfill$;

CREATE OR REPLACE FUNCTION public.claim_voice_worker_job_exact(
  worker_identity uuid,
  organization_identity uuid,
  conversation_identity uuid,
  owner_identity uuid,
  lease_milliseconds integer
) RETURNS SETOF public.voice_worker_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public
AS $claim_voice_worker_job_exact$
DECLARE
  candidate public.voice_worker_jobs%ROWTYPE;
  payload text;
BEGIN
  IF lease_milliseconds NOT BETWEEN 5000 AND 300000 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_lease_invalid';
  END IF;
  SELECT * INTO candidate
  FROM public.voice_worker_jobs
  WHERE id = worker_identity
    AND org_id = organization_identity
    AND conversation_id = conversation_identity
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF candidate.status = 'running'
     AND candidate.owner_token = owner_identity
     AND candidate.lease_expires_at > clock_timestamp()
     AND candidate.claimed_cancellation_epoch = candidate.cancellation_epoch THEN
    UPDATE public.voice_worker_jobs
    SET heartbeat_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + lease_milliseconds * interval '1 millisecond'
    WHERE id = candidate.id
    RETURNING * INTO candidate;
    RETURN NEXT candidate;
    RETURN;
  END IF;

  IF candidate.status IN ('running','cancel_requested')
     AND candidate.lease_expires_at <= clock_timestamp() THEN
    IF candidate.dispatch_started_at IS NOT NULL THEN
      UPDATE public.voice_worker_jobs
      SET status = 'indeterminate', owner_token = NULL,
          lease_expires_at = NULL, heartbeat_at = NULL,
          settled_at = clock_timestamp(),
          error = jsonb_build_object('code','worker_lease_expired_after_dispatch')
      WHERE id = candidate.id
      RETURNING * INTO candidate;
      payload := jsonb_build_object(
        'status','indeterminate','reason','lease_expired_after_dispatch'
      )::text;
      PERFORM public.append_voice_worker_event(
        candidate.id,'indeterminate',payload,encode(digest(payload,'sha256'),'hex')
      );
      RETURN;
    ELSIF candidate.status = 'cancel_requested' THEN
      UPDATE public.voice_worker_jobs
      SET status = 'cancelled', owner_token = NULL, claimed_at = NULL,
          lease_expires_at = NULL, heartbeat_at = NULL,
          settled_at = clock_timestamp()
      WHERE id = candidate.id
      RETURNING * INTO candidate;
      payload := jsonb_build_object(
        'status','cancelled','reason','cancel_observed_on_reclaim'
      )::text;
      PERFORM public.append_voice_worker_event(
        candidate.id,'cancelled',payload,encode(digest(payload,'sha256'),'hex')
      );
      RETURN;
    ELSE
      UPDATE public.voice_worker_jobs
      SET status = 'pending', owner_token = NULL, claimed_at = NULL,
          lease_expires_at = NULL, heartbeat_at = NULL,
          claimed_cancellation_epoch = NULL
      WHERE id = candidate.id
      RETURNING * INTO candidate;
      payload := jsonb_build_object(
        'status','pending','reason','lease_reclaimed_before_dispatch'
      )::text;
      PERFORM public.append_voice_worker_event(
        candidate.id,'reclaimed',payload,encode(digest(payload,'sha256'),'hex')
      );
    END IF;
  END IF;

  IF candidate.status <> 'pending' THEN RETURN; END IF;
  UPDATE public.voice_worker_jobs
  SET status = 'running', owner_token = owner_identity,
      claimed_at = clock_timestamp(), heartbeat_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + lease_milliseconds * interval '1 millisecond',
      claimed_cancellation_epoch = cancellation_epoch
  WHERE id = candidate.id
    AND org_id = organization_identity
    AND conversation_id = conversation_identity
    AND status = 'pending'
  RETURNING * INTO candidate;
  IF NOT FOUND THEN RETURN; END IF;
  payload := jsonb_build_object(
    'status','running','cancellationEpoch',candidate.cancellation_epoch
  )::text;
  PERFORM public.append_voice_worker_event(
    candidate.id,'claimed',payload,encode(digest(payload,'sha256'),'hex')
  );
  RETURN NEXT candidate;
END
$claim_voice_worker_job_exact$;

CREATE OR REPLACE FUNCTION public.heartbeat_voice_worker_job_exact(
  worker_identity uuid,
  organization_identity uuid,
  conversation_identity uuid,
  owner_identity uuid,
  lease_milliseconds integer
) RETURNS public.voice_worker_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public
AS $heartbeat_voice_worker_job_exact$
DECLARE job public.voice_worker_jobs%ROWTYPE;
BEGIN
  IF lease_milliseconds NOT BETWEEN 5000 AND 300000 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_lease_invalid';
  END IF;
  UPDATE public.voice_worker_jobs
  SET heartbeat_at = clock_timestamp(),
      lease_expires_at = clock_timestamp() + lease_milliseconds * interval '1 millisecond'
  WHERE id = worker_identity
    AND org_id = organization_identity
    AND conversation_id = conversation_identity
    AND owner_token = owner_identity
    AND status = 'running'
    AND claimed_cancellation_epoch = cancellation_epoch
    AND lease_expires_at > clock_timestamp()
  RETURNING * INTO job;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_lease_lost';
  END IF;
  RETURN job;
END
$heartbeat_voice_worker_job_exact$;

CREATE OR REPLACE FUNCTION public.mark_voice_worker_dispatch_started_exact(
  worker_identity uuid,
  organization_identity uuid,
  conversation_identity uuid,
  owner_identity uuid
) RETURNS public.voice_worker_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public
AS $mark_voice_worker_dispatch_started_exact$
DECLARE job public.voice_worker_jobs%ROWTYPE; payload text;
BEGIN
  UPDATE public.voice_worker_jobs
  SET dispatch_started_at = COALESCE(dispatch_started_at,clock_timestamp())
  WHERE id = worker_identity
    AND org_id = organization_identity
    AND conversation_id = conversation_identity
    AND owner_token = owner_identity
    AND status = 'running'
    AND lease_expires_at > clock_timestamp()
    AND claimed_cancellation_epoch = cancellation_epoch
  RETURNING * INTO job;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_dispatch_not_authorized';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.voice_worker_events
    WHERE worker_id = job.id AND event_type = 'dispatch_started'
  ) THEN
    payload := jsonb_build_object('status','running')::text;
    PERFORM public.append_voice_worker_event(
      job.id,'dispatch_started',payload,encode(digest(payload,'sha256'),'hex')
    );
  END IF;
  RETURN job;
END
$mark_voice_worker_dispatch_started_exact$;

CREATE OR REPLACE FUNCTION public.settle_voice_worker_job_exact(
  worker_identity uuid,
  organization_identity uuid,
  conversation_identity uuid,
  owner_identity uuid,
  terminal_status text,
  result_text text DEFAULT NULL,
  result_digest text DEFAULT NULL,
  error_text text DEFAULT NULL
) RETURNS public.voice_worker_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public
AS $settle_voice_worker_job_exact$
DECLARE job public.voice_worker_jobs%ROWTYPE;
BEGIN
  SELECT * INTO job
  FROM public.voice_worker_jobs
  WHERE id = worker_identity
    AND org_id = organization_identity
    AND conversation_id = conversation_identity
    AND owner_token = owner_identity
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_settlement_not_authorized';
  END IF;
  IF job.status = 'cancel_requested' AND terminal_status <> 'cancelled' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_cancellation_must_settle_cancelled';
  END IF;
  job := public.settle_voice_worker_job(
    worker_identity, owner_identity, terminal_status,
    result_text, result_digest, error_text
  );
  RETURN job;
END
$settle_voice_worker_job_exact$;

CREATE OR REPLACE FUNCTION public.load_voice_worker_status(
  worker_identity uuid,
  organization_identity uuid,
  conversation_identity uuid
) RETURNS TABLE(id uuid, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public
AS $load_voice_worker_status$
  SELECT job.id, job.status
  FROM public.voice_worker_jobs job
  WHERE job.id = worker_identity
    AND job.org_id = organization_identity
    AND job.conversation_id = conversation_identity;
$load_voice_worker_status$;

CREATE OR REPLACE FUNCTION public.apply_governed_voice_worker_terminal(
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public
AS $apply_governed_voice_worker_terminal$
DECLARE
  message public.voice_conversation_inbox%ROWTYPE;
  worker public.voice_worker_jobs%ROWTYPE;
  source_event public.voice_worker_events%ROWTYPE;
  unsigned_event jsonb;
  payload jsonb;
  expected_payload jsonb;
  event_batch_text text;
  appended public.voice_conversation_events%ROWTYPE;
  applied public.voice_conversation_inbox%ROWTYPE;
  expected_occurred_at_ms bigint;
BEGIN
  BEGIN
    unsigned_event := unsigned_event_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_terminal_invalid_json';
  END;
  SELECT inbox.* INTO message
  FROM public.voice_conversation_inbox inbox
  WHERE inbox.id = message_identity
    AND inbox.conversation_id = conversation_identity
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_terminal_not_found';
  END IF;
  SELECT job.* INTO STRICT worker
  FROM public.voice_worker_jobs job
  WHERE job.id = message.worker_id
    AND job.conversation_id = conversation_identity
    AND job.org_id = organization_identity;
  SELECT event.* INTO STRICT source_event
  FROM public.voice_worker_events event
  WHERE event.worker_id = worker.id
    AND event.event_sha256 = message.source_event_sha256;

  IF worker.status NOT IN ('failed','cancelled','indeterminate')
     OR worker.settled_at IS NULL
     OR message.payload->>'v' <> '1'
     OR message.payload->>'kind' <> 'terminal'
     OR message.payload->>'status' <> worker.status
     OR message.payload->>'evidenceSha256' <> source_event.event_sha256
     OR message.payload_sha256 <> public.voice_worker_terminal_payload_sha256(
       worker.id,
       worker.status,
       message.payload->>'reasonCode',
       source_event.event_sha256
     ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_terminal_evidence_mismatch';
  END IF;

  expected_payload := jsonb_build_object(
    'type','worker.finished',
    'workerId',worker.id::text,
    'status',worker.status,
    'reasonCode',message.payload->'reasonCode',
    'evidenceSha256',source_event.event_sha256
  );
  payload := unsigned_event->'payload';
  expected_occurred_at_ms := floor(extract(epoch FROM message.created_at) * 1000)::bigint;
  IF event_sha256 <> encode(digest(unsigned_event_text,'sha256'),'hex')
     OR payload IS DISTINCT FROM expected_payload
     OR COALESCE(unsigned_event->>'conversationId','') <> conversation_identity::text
     OR COALESCE(unsigned_event->>'previousHash','') <> expected_head_sha256
     OR COALESCE((unsigned_event->>'occurredAtMs')::bigint,-1) <> expected_occurred_at_ms THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_terminal_event_evidence_mismatch';
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
    encode(digest(event_batch_text,'sha256'),'hex')
  ) event;
  IF appended.event_sha256 <> event_sha256
     OR appended.event_type <> 'worker.finished'
     OR appended.idempotency_key <> conversation_event_idempotency_key THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_terminal_event_replay_mismatch';
  END IF;
  applied := public.apply_voice_conversation_inbox(
    message_identity,
    organization_identity,
    delivery_identity,
    application_identity
  );
  IF applied.id <> message_identity
     OR applied.worker_id <> worker.id
     OR applied.application_id <> application_identity
     OR applied.applied_at IS NULL
     OR applied.acknowledged_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='governed_worker_terminal_application_mismatch';
  END IF;
  RETURN QUERY SELECT to_jsonb(appended), to_jsonb(applied);
END
$apply_governed_voice_worker_terminal$;

REVOKE ALL ON FUNCTION public.voice_worker_terminal_payload_sha256(uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_voice_worker_terminal_projection(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_voice_worker_terminal_projection_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.heartbeat_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_voice_worker_dispatch_started_exact(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_voice_worker_job_exact(uuid,uuid,uuid,uuid,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.load_voice_worker_status(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_governed_voice_worker_terminal(
  uuid,uuid,uuid,uuid,uuid,text,text,text,text
) FROM PUBLIC;

-- Migration 013 grants future public functions to API roles by default.
-- Revoke every function introduced here from every application/worker role
-- before selectively granting the exact tenant-scoped coordinator surface.
-- Trigger and hashing helpers remain owner-only.
DO $governed_voice_worker_runtime_default_acl_closure$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'anon','authenticated','service_role','hacc_backend','hacc_worker'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.voice_worker_terminal_payload_sha256(uuid,text,text,text) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.enqueue_voice_worker_terminal_projection(uuid) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.enqueue_voice_worker_terminal_projection_trigger() FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.claim_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.heartbeat_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.mark_voice_worker_dispatch_started_exact(uuid,uuid,uuid,uuid) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.settle_voice_worker_job_exact(uuid,uuid,uuid,uuid,text,text,text,text) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.load_voice_worker_status(uuid,uuid,uuid) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.apply_governed_voice_worker_terminal(uuid,uuid,uuid,uuid,uuid,text,text,text,text) FROM %I',
        runtime_role
      );
    END IF;
  END LOOP;
END
$governed_voice_worker_runtime_default_acl_closure$;

DO $governed_voice_worker_runtime_grants$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY[
    'anon','authenticated','service_role','hacc_backend'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.claim_voice_worker_job(uuid,integer) FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.heartbeat_voice_worker_job(uuid,uuid,integer) FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.mark_voice_worker_dispatch_started(uuid,uuid) FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.checkpoint_voice_worker_job(uuid,uuid,text,text) FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.settle_voice_worker_job(uuid,uuid,text,text,text,text) FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.claim_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer) FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.heartbeat_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer) FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.mark_voice_worker_dispatch_started_exact(uuid,uuid,uuid,uuid) FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.settle_voice_worker_job_exact(uuid,uuid,uuid,uuid,text,text,text,text) FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.load_voice_worker_status(uuid,uuid,uuid) FROM %I',
        api_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.apply_governed_voice_worker_terminal(uuid,uuid,uuid,uuid,uuid,text,text,text,text) FROM %I',
        api_role
      );
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    GRANT EXECUTE ON FUNCTION
      public.claim_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer),
      public.heartbeat_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer),
      public.mark_voice_worker_dispatch_started_exact(uuid,uuid,uuid,uuid),
      public.settle_voice_worker_job_exact(uuid,uuid,uuid,uuid,text,text,text,text),
      public.load_voice_worker_status(uuid,uuid,uuid),
      public.apply_governed_voice_worker_terminal(uuid,uuid,uuid,uuid,uuid,text,text,text,text)
      TO hacc_backend;
  END IF;
END
$governed_voice_worker_runtime_grants$;

COMMENT ON FUNCTION public.claim_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer) IS
  'Claims only one exact worker inside its organization and conversation; never scans or mutates another tenant queue.';
COMMENT ON FUNCTION public.load_voice_worker_status(uuid,uuid,uuid) IS
  'Returns only id/status for an exact worker scope; no input, result, error, manifest, checkpoint, token, or lease state is exposed.';
COMMENT ON FUNCTION public.apply_governed_voice_worker_terminal(
  uuid,uuid,uuid,uuid,uuid,text,text,text,text
) IS
  'Atomically appends an evidence-bound worker.finished event and acknowledges its terminal projection inbox message.';

-- Crash reconciliation for `launch_task` reads only the immutable spawn side
-- of one exact worker. Mutable status, owner/lease capabilities, checkpoints,
-- results, and errors are deliberately absent from this projection.
CREATE OR REPLACE FUNCTION public.load_governed_launch_task_spawn_receipt(
  worker_identity uuid,
  organization_identity uuid,
  conversation_identity uuid
) RETURNS TABLE(
  id uuid,
  conversation_id uuid,
  org_id uuid,
  parent_worker_id uuid,
  source_call_id uuid,
  idempotency_key text,
  worker_kind text,
  spawn_authority jsonb,
  spawn_authority_sha256 text,
  worker_input jsonb,
  worker_input_sha256 text,
  capability_manifest jsonb,
  capability_manifest_sha256 text,
  spawn_created_at timestamptz,
  conversation_agent_id uuid,
  conversation_agent_version integer,
  event_id text,
  event_idempotency_key text,
  event_sequence bigint,
  event_occurred_at_ms bigint,
  event_type text,
  event_payload jsonb,
  event_previous_sha256 text,
  event_sha256 text,
  event_unsigned_text text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public
AS $load_governed_launch_task_spawn_receipt$
  SELECT
    job.id,
    job.conversation_id,
    job.org_id,
    job.parent_worker_id,
    job.source_call_id,
    job.idempotency_key,
    job.worker_kind,
    job.spawn_authority,
    job.spawn_authority_sha256,
    job.worker_input,
    job.worker_input_sha256,
    job.capability_manifest,
    job.capability_manifest_sha256,
    job.created_at,
    conversation.agent_id,
    conversation.agent_version,
    event.event_id,
    event.idempotency_key,
    event.sequence,
    event.occurred_at_ms,
    event.event_type,
    event.payload,
    event.previous_event_sha256,
    event.event_sha256,
    event.unsigned_event_text
  FROM public.voice_worker_jobs job
  JOIN public.voice_conversations conversation
    ON conversation.id = job.conversation_id
   AND conversation.org_id = job.org_id
  JOIN public.calls source_call
    ON source_call.id = job.source_call_id
   AND source_call.agent_id = conversation.agent_id
   AND source_call.agent_version = conversation.agent_version
  JOIN public.voice_conversation_events event
    ON event.conversation_id = job.conversation_id
   AND event.org_id = job.org_id
   AND event.event_sha256 = job.spawn_authority->>'conversationHeadSha256'
   AND event.sequence = (job.spawn_authority->>'conversationRevision')::bigint
   AND event.event_type = 'worker.spawned'
   AND event.payload->>'workerId' = job.id::text
  WHERE job.id = worker_identity
    AND job.org_id = organization_identity
    AND job.conversation_id = conversation_identity
    AND job.parent_worker_id IS NULL
    AND job.source_call_id = conversation_identity
    AND job.worker_kind = 'call.research';
$load_governed_launch_task_spawn_receipt$;

REVOKE ALL ON FUNCTION
  public.load_governed_launch_task_spawn_receipt(uuid,uuid,uuid)
  FROM PUBLIC;

DO $governed_launch_task_spawn_receipt_acl$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'anon','authenticated','service_role','hacc_backend','hacc_worker'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.load_governed_launch_task_spawn_receipt(uuid,uuid,uuid) FROM %I',
        runtime_role
      );
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    GRANT EXECUTE ON FUNCTION
      public.load_governed_launch_task_spawn_receipt(uuid,uuid,uuid)
      TO hacc_backend;
  END IF;
END
$governed_launch_task_spawn_receipt_acl$;

COMMENT ON FUNCTION public.load_governed_launch_task_spawn_receipt(uuid,uuid,uuid) IS
  'Returns exact-scope immutable launch_task spawn and worker.spawned event evidence only; excludes all worker execution state and bearer capabilities.';

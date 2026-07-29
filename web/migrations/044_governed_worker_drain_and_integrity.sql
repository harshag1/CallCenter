-- Durable governed-worker drain, isolated execution principal, canonical
-- result admission, bounded inbox quarantine, and exact source-call authority.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Voice-worker execution is intentionally separate from the older cross-tenant
-- dialer role (`hacc_worker`), which has scheduled-call table authority.
DO $voice_worker_roles$
DECLARE unsafe boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_voice_worker') THEN
    CREATE ROLE hacc_voice_worker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
  ELSE
    SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolcanlogin
      OR rolreplication OR rolbypassrls
    INTO unsafe
    FROM pg_roles
    WHERE rolname = 'hacc_voice_worker';
    IF unsafe THEN
      RAISE EXCEPTION 'hacc_voice_worker has unsafe login/owner/bypass authority';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'hacc_voice_worker_runtime'
  ) THEN
    CREATE ROLE hacc_voice_worker_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
      NOREPLICATION NOBYPASSRLS;
  ELSE
    SELECT rolsuper OR rolcreatedb OR rolcreaterole
      OR rolreplication OR rolbypassrls
    INTO unsafe
    FROM pg_roles
    WHERE rolname = 'hacc_voice_worker_runtime';
    IF unsafe THEN
      RAISE EXCEPTION 'hacc_voice_worker_runtime has unsafe owner/bypass authority';
    END IF;
  END IF;

  IF NOT pg_has_role(
    'hacc_voice_worker_runtime',
    'hacc_voice_worker',
    'member'
  ) THEN
    GRANT hacc_voice_worker TO hacc_voice_worker_runtime;
  END IF;
END
$voice_worker_roles$;

GRANT USAGE ON SCHEMA public TO hacc_voice_worker;

-- Hosted Postgres commonly installs pgcrypto in `extensions`. Repair both the
-- source migration and already-applied databases.
ALTER FUNCTION public.request_voice_worker_cancellation(uuid,uuid)
  SET search_path = pg_catalog, extensions, public;

-- A call-bound conversation must pin the immutable call's agent version, not
-- merely its agent id.
CREATE OR REPLACE FUNCTION public.ensure_voice_conversation(
  conversation_identity uuid,
  organization_identity uuid,
  agent_identity uuid,
  immutable_agent_version integer,
  call_identity uuid DEFAULT NULL
) RETURNS public.voice_conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $ensure_voice_conversation$
DECLARE
  conversation public.voice_conversations%ROWTYPE;
  call_agent uuid;
  call_agent_version integer;
BEGIN
  IF immutable_agent_version <= 0 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='invalid_voice_conversation_agent_version';
  END IF;
  INSERT INTO public.voice_conversations(id,org_id,agent_id,agent_version)
  VALUES (
    conversation_identity,
    organization_identity,
    agent_identity,
    immutable_agent_version
  )
  ON CONFLICT (id) DO NOTHING;
  SELECT * INTO STRICT conversation
  FROM public.voice_conversations
  WHERE id = conversation_identity
  FOR UPDATE;
  IF conversation.org_id <> organization_identity
     OR conversation.agent_id <> agent_identity
     OR conversation.agent_version <> immutable_agent_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_identity_conflict';
  END IF;
  IF call_identity IS NOT NULL THEN
    SELECT agent_id, agent_version
    INTO call_agent, call_agent_version
    FROM public.calls
    WHERE id = call_identity
    FOR SHARE;
    IF NOT FOUND
       OR call_agent <> agent_identity
       OR call_agent_version <> immutable_agent_version THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_call_authority_mismatch';
    END IF;
    INSERT INTO public.voice_conversation_calls(conversation_id,org_id,call_id)
    VALUES (conversation_identity,organization_identity,call_identity)
    ON CONFLICT (call_id) DO NOTHING;
    IF NOT EXISTS (
      SELECT 1
      FROM public.voice_conversation_calls
      WHERE conversation_id = conversation_identity
        AND org_id = organization_identity
        AND call_id = call_identity
    ) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_call_identity_conflict';
    END IF;
  END IF;
  RETURN conversation;
END
$ensure_voice_conversation$;

-- Canonical JSON matches the framework's recursively key-sorted compact JSON
-- for the bounded decimal subset accepted here. Exponential or otherwise
-- ambiguous numeric encodings fail closed instead of producing an unreadable
-- digest after PostgreSQL normalizes jsonb.
CREATE OR REPLACE FUNCTION public.voice_worker_canonical_json(value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $voice_worker_canonical_json$
DECLARE
  kind text;
  encoded text;
BEGIN
  kind := jsonb_typeof(value);
  IF kind = 'object' THEN
    SELECT COALESCE(
      string_agg(
        to_jsonb(object_key)::text || ':' ||
          public.voice_worker_canonical_json(value->object_key),
        ',' ORDER BY object_key COLLATE "C"
      ),
      ''
    )
    INTO encoded
    FROM jsonb_object_keys(value) object_key;
    RETURN '{' || encoded || '}';
  ELSIF kind = 'array' THEN
    SELECT COALESCE(
      string_agg(
        public.voice_worker_canonical_json(element),
        ',' ORDER BY ordinal
      ),
      ''
    )
    INTO encoded
    FROM jsonb_array_elements(value) WITH ORDINALITY item(element, ordinal);
    RETURN '[' || encoded || ']';
  ELSIF kind = 'number' THEN
    encoded := value #>> '{}';
    IF encoded !~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_number_not_canonicalizable';
    END IF;
    IF position('.' IN encoded) > 0 THEN
      encoded := regexp_replace(encoded, '0+$', '');
      encoded := regexp_replace(encoded, '\.$', '');
    END IF;
    IF encoded = '-0' THEN encoded := '0'; END IF;
    RETURN encoded;
  ELSIF kind IN ('string','boolean','null') THEN
    RETURN value::text;
  END IF;
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_json_type_invalid';
END
$voice_worker_canonical_json$;

CREATE OR REPLACE FUNCTION public.voice_worker_result_is_valid(result_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $voice_worker_result_is_valid$
DECLARE
  fact jsonb;
  citation jsonb;
  proposed jsonb;
  citation_id jsonb;
  argument_key text;
  seen_citation_ids text[] := ARRAY[]::text[];
  uri text;
  retrieved_at text;
BEGIN
  IF jsonb_typeof(result_value) <> 'object'
     OR NOT result_value ?& ARRAY['v','facts','citations','proposedActions','summary']
     OR result_value - ARRAY['v','facts','citations','proposedActions','summary'] <> '{}'::jsonb
     OR result_value->'v' <> '1'::jsonb
     OR jsonb_typeof(result_value->'facts') <> 'array'
     OR jsonb_array_length(result_value->'facts') > 256
     OR jsonb_typeof(result_value->'citations') <> 'array'
     OR jsonb_array_length(result_value->'citations') > 256
     OR jsonb_typeof(result_value->'proposedActions') <> 'array'
     OR jsonb_array_length(result_value->'proposedActions') > 64
     OR jsonb_typeof(result_value->'summary') <> 'string'
     OR length(btrim(result_value->>'summary')) NOT BETWEEN 1 AND 8192 THEN
    RETURN false;
  END IF;

  FOR citation IN SELECT value FROM jsonb_array_elements(result_value->'citations')
  LOOP
    IF jsonb_typeof(citation) <> 'object'
       OR NOT citation ?& ARRAY['id','uri','retrievedAt']
       OR citation - ARRAY['id','uri','title','excerpt','retrievedAt'] <> '{}'::jsonb
       OR jsonb_typeof(citation->'id') <> 'string'
       OR length(btrim(citation->>'id')) NOT BETWEEN 1 AND 128
       OR (citation->>'id') = ANY(seen_citation_ids)
       OR jsonb_typeof(citation->'uri') <> 'string'
       OR length(citation->>'uri') > 2048
       OR citation->>'uri' !~ '^[A-Za-z][A-Za-z0-9+.-]*:[^[:space:]]+$'
       OR jsonb_typeof(citation->'retrievedAt') <> 'string' THEN
      RETURN false;
    END IF;
    IF citation ? 'title'
       AND (
         jsonb_typeof(citation->'title') <> 'string'
         OR length(btrim(citation->>'title')) NOT BETWEEN 1 AND 512
       ) THEN
      RETURN false;
    END IF;
    IF citation ? 'excerpt'
       AND (
         jsonb_typeof(citation->'excerpt') <> 'string'
         OR length(citation->>'excerpt') > 2048
       ) THEN
      RETURN false;
    END IF;
    retrieved_at := citation->>'retrievedAt';
    IF retrieved_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
      RETURN false;
    END IF;
    BEGIN
      PERFORM retrieved_at::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RETURN false;
    END;
    seen_citation_ids := array_append(seen_citation_ids, citation->>'id');
  END LOOP;

  FOR fact IN SELECT value FROM jsonb_array_elements(result_value->'facts')
  LOOP
    IF jsonb_typeof(fact) <> 'object'
       OR NOT fact ?& ARRAY['key','value','confidence','citationIds']
       OR fact - ARRAY['key','value','confidence','citationIds'] <> '{}'::jsonb
       OR jsonb_typeof(fact->'key') <> 'string'
       OR fact->>'key' !~ '^[a-z][a-z0-9_.:-]{1,127}$'
       OR jsonb_typeof(fact->'confidence') <> 'number'
       OR (fact->>'confidence')::numeric < 0
       OR (fact->>'confidence')::numeric > 1
       OR jsonb_typeof(fact->'citationIds') <> 'array'
       OR jsonb_array_length(fact->'citationIds') > 32 THEN
      RETURN false;
    END IF;
    FOR citation_id IN SELECT value FROM jsonb_array_elements(fact->'citationIds')
    LOOP
      IF jsonb_typeof(citation_id) <> 'string'
         OR length(btrim(citation_id #>> '{}')) NOT BETWEEN 1 AND 128
         OR NOT ((citation_id #>> '{}') = ANY(seen_citation_ids)) THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;

  FOR proposed IN SELECT value FROM jsonb_array_elements(result_value->'proposedActions')
  LOOP
    IF jsonb_typeof(proposed) <> 'object'
       OR NOT proposed ?& ARRAY['kind','rationale','arguments','requiresConfirmation']
       OR proposed - ARRAY['kind','rationale','arguments','requiresConfirmation'] <> '{}'::jsonb
       OR jsonb_typeof(proposed->'kind') <> 'string'
       OR proposed->>'kind' !~ '^[a-z][a-z0-9_.-]{1,63}$'
       OR jsonb_typeof(proposed->'rationale') <> 'string'
       OR length(btrim(proposed->>'rationale')) NOT BETWEEN 1 AND 2048
       OR jsonb_typeof(proposed->'arguments') <> 'object'
       OR proposed->'requiresConfirmation' <> 'true'::jsonb THEN
      RETURN false;
    END IF;
    FOR argument_key IN SELECT jsonb_object_keys(proposed->'arguments')
    LOOP
      IF length(argument_key) > 128 THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$voice_worker_result_is_valid$;

-- Only this exact tenant-and-conversation-scoped function is executable by the
-- worker principal. It rejects noncanonical or schema-incompatible bytes
-- before the legacy owner-only transition can create an inbox row.
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
DECLARE
  job public.voice_worker_jobs%ROWTYPE;
  result_value jsonb;
  canonical_result text;
  error_value jsonb;
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
  IF terminal_status = 'succeeded' THEN
    BEGIN
      result_value := result_text::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_result_invalid_json';
    END;
    canonical_result := public.voice_worker_canonical_json(result_value);
    IF result_text IS NULL
       OR result_text <> canonical_result
       OR octet_length(result_text) > 131072
       OR result_digest <> encode(digest(result_text,'sha256'),'hex') THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_result_not_canonical';
    END IF;
    IF NOT public.voice_worker_result_is_valid(result_value) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_result_schema_invalid';
    END IF;
  ELSIF terminal_status = 'failed' THEN
    BEGIN
      error_value := error_text::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_error_invalid_json';
    END;
    IF error_text IS NULL
       OR octet_length(error_text) > 16384
       OR jsonb_typeof(error_value) <> 'object'
       OR error_text <> public.voice_worker_canonical_json(error_value) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_error_not_canonical';
    END IF;
  ELSIF terminal_status <> 'cancelled' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_terminal_status_invalid';
  END IF;
  job := public.settle_voice_worker_job(
    worker_identity,
    owner_identity,
    terminal_status,
    canonical_result,
    result_digest,
    error_text
  );
  RETURN job;
END
$settle_voice_worker_job_exact$;

ALTER TABLE public.voice_worker_jobs
  ADD COLUMN IF NOT EXISTS execution_attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.voice_worker_jobs
  DROP CONSTRAINT IF EXISTS voice_worker_execution_attempt_count_valid;
ALTER TABLE public.voice_worker_jobs
  ADD CONSTRAINT voice_worker_execution_attempt_count_valid CHECK (
    execution_attempt_count BETWEEN 0 AND 3
  );

-- Governed workers are provably read-only. An expired process may therefore
-- be reclaimed even after provider dispatch; retries remain bounded and may
-- duplicate read cost, but cannot duplicate a business mutation.
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
  IF candidate.worker_kind <> 'call.research'
     OR candidate.source_call_id IS NULL
     OR candidate.parent_worker_id IS NOT NULL
     OR candidate.spawn_authority->>'source' <> 'voice_call'
     OR candidate.spawn_authority->>'sourceCallId'
       <> candidate.source_call_id::text
     OR candidate.capability_manifest->>'mode' <> 'read_only' THEN
    RETURN;
  END IF;

  IF candidate.status = 'running'
     AND candidate.owner_token = owner_identity
     AND candidate.lease_expires_at > clock_timestamp()
     AND candidate.claimed_cancellation_epoch = candidate.cancellation_epoch THEN
    UPDATE public.voice_worker_jobs
    SET heartbeat_at = clock_timestamp(),
        lease_expires_at = clock_timestamp()
          + lease_milliseconds * interval '1 millisecond'
    WHERE id = candidate.id
    RETURNING * INTO candidate;
    RETURN NEXT candidate;
    RETURN;
  END IF;

  IF candidate.status IN ('running','cancel_requested')
     AND candidate.lease_expires_at <= clock_timestamp() THEN
    IF candidate.status = 'cancel_requested' THEN
      UPDATE public.voice_worker_jobs
      SET status = 'cancelled',
          owner_token = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          settled_at = clock_timestamp()
      WHERE id = candidate.id
      RETURNING * INTO candidate;
      payload := jsonb_build_object(
        'status','cancelled',
        'reason','cancel_observed_on_reclaim'
      )::text;
      PERFORM public.append_voice_worker_event(
        candidate.id,
        'cancelled',
        payload,
        encode(digest(payload,'sha256'),'hex')
      );
      RETURN;
    ELSIF candidate.execution_attempt_count >= 3 THEN
      UPDATE public.voice_worker_jobs
      SET status = 'failed',
          owner_token = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          settled_at = clock_timestamp(),
          error = jsonb_build_object(
            'code',
            'worker_execution_attempt_limit'
          )
      WHERE id = candidate.id
      RETURNING * INTO candidate;
      payload := jsonb_build_object(
        'status','failed',
        'reason','execution_attempt_limit'
      )::text;
      PERFORM public.append_voice_worker_event(
        candidate.id,
        'failed',
        payload,
        encode(digest(payload,'sha256'),'hex')
      );
      RETURN;
    ELSIF candidate.capability_manifest->>'mode' = 'read_only' THEN
      UPDATE public.voice_worker_jobs
      SET status = 'pending',
          owner_token = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          dispatch_started_at = NULL,
          claimed_cancellation_epoch = NULL
      WHERE id = candidate.id
      RETURNING * INTO candidate;
      payload := jsonb_build_object(
        'status','pending',
        'reason','read_only_lease_reclaimed_after_process_loss'
      )::text;
      PERFORM public.append_voice_worker_event(
        candidate.id,
        'reclaimed',
        payload,
        encode(digest(payload,'sha256'),'hex')
      );
    ELSIF candidate.dispatch_started_at IS NOT NULL THEN
      UPDATE public.voice_worker_jobs
      SET status = 'indeterminate',
          owner_token = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          settled_at = clock_timestamp(),
          error = jsonb_build_object(
            'code',
            'worker_lease_expired_after_dispatch'
          )
      WHERE id = candidate.id;
      payload := jsonb_build_object(
        'status','indeterminate',
        'reason','lease_expired_after_dispatch'
      )::text;
      PERFORM public.append_voice_worker_event(
        candidate.id,
        'indeterminate',
        payload,
        encode(digest(payload,'sha256'),'hex')
      );
      RETURN;
    ELSE
      UPDATE public.voice_worker_jobs
      SET status = 'pending',
          owner_token = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          claimed_cancellation_epoch = NULL
      WHERE id = candidate.id
      RETURNING * INTO candidate;
    END IF;
  END IF;

  IF candidate.status <> 'pending' THEN RETURN; END IF;
  IF candidate.execution_attempt_count >= 3 THEN
    UPDATE public.voice_worker_jobs
    SET status = 'failed',
        owner_token = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        settled_at = clock_timestamp(),
        error = jsonb_build_object(
          'code',
          'worker_execution_attempt_limit'
        )
    WHERE id = candidate.id;
    payload := jsonb_build_object(
      'status','failed',
      'reason','execution_attempt_limit'
    )::text;
    PERFORM public.append_voice_worker_event(
      candidate.id,
      'failed',
      payload,
      encode(digest(payload,'sha256'),'hex')
    );
    RETURN;
  END IF;
  UPDATE public.voice_worker_jobs
  SET status = 'running',
      owner_token = owner_identity,
      claimed_at = clock_timestamp(),
      heartbeat_at = clock_timestamp(),
      lease_expires_at = clock_timestamp()
        + lease_milliseconds * interval '1 millisecond',
      claimed_cancellation_epoch = cancellation_epoch,
      execution_attempt_count = execution_attempt_count + 1
  WHERE id = candidate.id
    AND org_id = organization_identity
    AND conversation_id = conversation_identity
    AND status = 'pending'
  RETURNING * INTO candidate;
  IF NOT FOUND THEN RETURN; END IF;
  payload := jsonb_build_object(
    'status','running',
    'cancellationEpoch',candidate.cancellation_epoch
  )::text;
  PERFORM public.append_voice_worker_event(
    candidate.id,
    'claimed',
    payload,
    encode(digest(payload,'sha256'),'hex')
  );
  RETURN NEXT candidate;
END
$claim_voice_worker_job_exact$;

CREATE OR REPLACE FUNCTION public.next_governed_voice_worker_candidate()
RETURNS TABLE(
  worker_id uuid,
  organization_id uuid,
  conversation_id uuid
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $next_governed_voice_worker_candidate$
  SELECT job.id, job.org_id, job.conversation_id
  FROM public.voice_worker_jobs job
  WHERE job.worker_kind = 'call.research'
    AND job.source_call_id IS NOT NULL
    AND job.parent_worker_id IS NULL
    AND job.spawn_authority->>'source' = 'voice_call'
    AND job.spawn_authority->>'sourceCallId' = job.source_call_id::text
    AND job.capability_manifest->>'mode' = 'read_only'
    AND (
      job.status = 'pending'
      OR (
        job.status IN ('running','cancel_requested')
        AND job.lease_expires_at <= clock_timestamp()
      )
    )
  ORDER BY job.created_at, job.id
  LIMIT 1;
$next_governed_voice_worker_candidate$;

-- Invalid or permanently undeliverable messages cannot monopolize the oldest
-- sixteen slots forever. Quarantine is content-free and never advances the
-- conversation context version.
ALTER TABLE public.voice_conversation_inbox
  ADD COLUMN IF NOT EXISTS quarantined_at timestamptz,
  ADD COLUMN IF NOT EXISTS quarantine_reason text;

ALTER TABLE public.voice_conversation_inbox
  DROP CONSTRAINT IF EXISTS voice_conversation_inbox_quarantine_valid;
ALTER TABLE public.voice_conversation_inbox
  ADD CONSTRAINT voice_conversation_inbox_quarantine_valid CHECK (
    (quarantined_at IS NULL) = (quarantine_reason IS NULL)
    AND (
      quarantine_reason IS NULL
      OR quarantine_reason ~ '^[a-z][a-z0-9_.:-]{1,127}$'
    )
    AND (
      quarantined_at IS NULL
      OR (
        application_id IS NULL
        AND applied_at IS NULL
        AND applied_context_version IS NULL
        AND delivery_token IS NULL
        AND delivery_lease_expires_at IS NULL
      )
    )
  );

CREATE INDEX IF NOT EXISTS idx_voice_conversation_inbox_actionable
  ON public.voice_conversation_inbox(conversation_id, created_at, id)
  WHERE acknowledged_at IS NULL AND quarantined_at IS NULL;

CREATE OR REPLACE FUNCTION public.quarantine_voice_conversation_inbox(
  message_identity uuid,
  organization_identity uuid,
  delivery_identity uuid,
  reason_code text
) RETURNS public.voice_conversation_inbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $quarantine_voice_conversation_inbox$
DECLARE message public.voice_conversation_inbox%ROWTYPE;
BEGIN
  IF reason_code !~ '^[a-z][a-z0-9_.:-]{1,127}$' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_inbox_quarantine_reason_invalid';
  END IF;
  UPDATE public.voice_conversation_inbox inbox
  SET quarantined_at = clock_timestamp(),
      quarantine_reason = reason_code,
      delivery_token = NULL,
      delivery_lease_expires_at = NULL
  FROM public.voice_conversations conversation
  WHERE inbox.id = message_identity
    AND conversation.id = inbox.conversation_id
    AND conversation.org_id = organization_identity
    AND inbox.application_id IS NULL
    AND inbox.acknowledged_at IS NULL
    AND inbox.quarantined_at IS NULL
    AND inbox.delivery_token = delivery_identity
    AND inbox.delivery_lease_expires_at > clock_timestamp()
  RETURNING inbox.* INTO message;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_inbox_quarantine_not_authorized';
  END IF;
  RETURN message;
END
$quarantine_voice_conversation_inbox$;

CREATE OR REPLACE FUNCTION public.claim_voice_conversation_inbox(
  conversation_identity uuid,
  organization_identity uuid,
  delivery_identity uuid,
  lease_milliseconds integer,
  maximum_messages integer DEFAULT 16
) RETURNS SETOF public.voice_conversation_inbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $claim_voice_conversation_inbox$
BEGIN
  IF lease_milliseconds NOT BETWEEN 1000 AND 300000
     OR maximum_messages NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_inbox_claim_invalid';
  END IF;
  WITH exhausted AS (
    SELECT inbox.id
    FROM public.voice_conversation_inbox inbox
    WHERE inbox.conversation_id = conversation_identity
      AND inbox.acknowledged_at IS NULL
      AND inbox.quarantined_at IS NULL
      AND inbox.application_id IS NULL
      AND inbox.delivery_count >= 16
      AND (
        inbox.delivery_lease_expires_at IS NULL
        OR inbox.delivery_lease_expires_at <= clock_timestamp()
      )
      AND EXISTS (
        SELECT 1
        FROM public.voice_conversations conversation
        WHERE conversation.id = conversation_identity
          AND conversation.org_id = organization_identity
      )
    ORDER BY inbox.created_at, inbox.id
    LIMIT 64
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.voice_conversation_inbox inbox
  SET quarantined_at = clock_timestamp(),
      quarantine_reason = 'delivery_attempt_limit',
      delivery_token = NULL,
      delivery_lease_expires_at = NULL
  FROM exhausted
  WHERE inbox.id = exhausted.id;

  RETURN QUERY
  WITH candidates AS (
    SELECT inbox.id
    FROM public.voice_conversation_inbox inbox
    WHERE inbox.conversation_id = conversation_identity
      AND inbox.acknowledged_at IS NULL
      AND inbox.quarantined_at IS NULL
      AND inbox.delivery_count < 16
      AND EXISTS (
        SELECT 1
        FROM public.voice_conversations conversation
        WHERE conversation.id = conversation_identity
          AND conversation.org_id = organization_identity
      )
      AND (
        inbox.delivery_lease_expires_at IS NULL
        OR inbox.delivery_lease_expires_at <= clock_timestamp()
      )
    ORDER BY inbox.created_at, inbox.id
    LIMIT maximum_messages
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.voice_conversation_inbox inbox
  SET delivery_token = delivery_identity,
      delivery_lease_expires_at = clock_timestamp()
        + lease_milliseconds * interval '1 millisecond',
      delivery_count = inbox.delivery_count + 1
  FROM candidates
  WHERE inbox.id = candidates.id
  RETURNING inbox.*;
END
$claim_voice_conversation_inbox$;

REVOKE ALL ON FUNCTION public.voice_worker_canonical_json(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.voice_worker_result_is_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.next_governed_voice_worker_candidate() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.quarantine_voice_conversation_inbox(uuid,uuid,uuid,text)
  FROM PUBLIC;

DO $governed_worker_044_acl$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'anon','authenticated','service_role','hacc_backend','hacc_worker',
    'hacc_voice_worker','hacc_voice_worker_runtime'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.voice_worker_canonical_json(jsonb) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.voice_worker_result_is_valid(jsonb) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.next_governed_voice_worker_candidate() FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.quarantine_voice_conversation_inbox(uuid,uuid,uuid,text) FROM %I',
        runtime_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    REVOKE ALL ON FUNCTION
      public.claim_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer),
      public.heartbeat_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer),
      public.mark_voice_worker_dispatch_started_exact(uuid,uuid,uuid,uuid),
      public.settle_voice_worker_job_exact(uuid,uuid,uuid,uuid,text,text,text,text)
      FROM hacc_backend;
    GRANT EXECUTE ON FUNCTION
      public.quarantine_voice_conversation_inbox(uuid,uuid,uuid,text)
      TO hacc_backend;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_worker') THEN
    REVOKE ALL ON FUNCTION
      public.claim_voice_worker_job(uuid,integer),
      public.heartbeat_voice_worker_job(uuid,uuid,integer),
      public.mark_voice_worker_dispatch_started(uuid,uuid),
      public.checkpoint_voice_worker_job(uuid,uuid,text,text),
      public.settle_voice_worker_job(uuid,uuid,text,text,text,text),
      public.claim_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer),
      public.heartbeat_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer),
      public.mark_voice_worker_dispatch_started_exact(uuid,uuid,uuid,uuid),
      public.settle_voice_worker_job_exact(uuid,uuid,uuid,uuid,text,text,text,text)
      FROM hacc_worker;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_voice_worker') THEN
    GRANT EXECUTE ON FUNCTION
      public.claim_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer),
      public.heartbeat_voice_worker_job_exact(uuid,uuid,uuid,uuid,integer),
      public.mark_voice_worker_dispatch_started_exact(uuid,uuid,uuid,uuid),
      public.settle_voice_worker_job_exact(uuid,uuid,uuid,uuid,text,text,text,text),
      public.next_governed_voice_worker_candidate()
      TO hacc_voice_worker;
  END IF;
END
$governed_worker_044_acl$;

COMMENT ON FUNCTION public.next_governed_voice_worker_candidate() IS
  'Worker-principal-only content-free selection of one pending or expired read-only worker; exact claim still owns every transition.';
COMMENT ON FUNCTION public.quarantine_voice_conversation_inbox(uuid,uuid,uuid,text) IS
  'Tenant-and-lease-scoped quarantine for malformed immutable worker evidence; does not advance conversation context.';

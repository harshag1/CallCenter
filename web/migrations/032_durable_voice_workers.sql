-- Durable, read-only asynchronous workers for conversations which outlive any one call.
-- The realtime model may request work, but only this database boundary can admit, lease,
-- settle, and deliver it. V1 workers return facts/citations/proposals; they cannot mutate.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.voice_conversations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  agent_version integer NOT NULL CHECK (agent_version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  context_version bigint NOT NULL DEFAULT 0 CHECK (context_version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, org_id),
  CONSTRAINT voice_conversations_agent_org_fk
    FOREIGN KEY (agent_id, org_id) REFERENCES public.agents(id, org_id),
  CONSTRAINT voice_conversations_agent_version_fk
    FOREIGN KEY (agent_id, agent_version)
    REFERENCES public.agent_versions(agent_id, version) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.voice_conversation_calls (
  conversation_id uuid NOT NULL,
  org_id uuid NOT NULL,
  call_id uuid NOT NULL UNIQUE REFERENCES public.calls(id) ON DELETE RESTRICT,
  attached_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (conversation_id, call_id),
  CONSTRAINT voice_conversation_calls_conversation_fk
    FOREIGN KEY (conversation_id, org_id)
    REFERENCES public.voice_conversations(id, org_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.voice_worker_jobs (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  org_id uuid NOT NULL,
  parent_worker_id uuid,
  source_call_id uuid REFERENCES public.calls(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 256),
  worker_kind text NOT NULL CHECK (worker_kind ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  spawn_authority jsonb NOT NULL,
  spawn_authority_sha256 text NOT NULL CHECK (spawn_authority_sha256 ~ '^[a-f0-9]{64}$'),
  worker_input jsonb NOT NULL,
  worker_input_sha256 text NOT NULL CHECK (worker_input_sha256 ~ '^[a-f0-9]{64}$'),
  capability_manifest jsonb NOT NULL,
  capability_manifest_sha256 text NOT NULL CHECK (capability_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','cancel_requested','succeeded','failed','cancelled','indeterminate')),
  owner_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  dispatch_started_at timestamptz,
  cancellation_epoch integer NOT NULL DEFAULT 0 CHECK (cancellation_epoch >= 0),
  claimed_cancellation_epoch integer,
  checkpoint jsonb,
  checkpoint_sha256 text CHECK (checkpoint_sha256 IS NULL OR checkpoint_sha256 ~ '^[a-f0-9]{64}$'),
  result jsonb,
  result_sha256 text CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[a-f0-9]{64}$'),
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  UNIQUE (conversation_id, idempotency_key),
  UNIQUE (id, conversation_id),
  CONSTRAINT voice_worker_jobs_conversation_fk
    FOREIGN KEY (conversation_id, org_id)
    REFERENCES public.voice_conversations(id, org_id) ON DELETE RESTRICT,
  CONSTRAINT voice_worker_jobs_parent_fk
    FOREIGN KEY (parent_worker_id, conversation_id)
    REFERENCES public.voice_worker_jobs(id, conversation_id) ON DELETE RESTRICT,
  CONSTRAINT voice_worker_jobs_storage_bounded CHECK (
    octet_length(spawn_authority::text) <= 32768
    AND octet_length(worker_input::text) <= 65536
    AND octet_length(capability_manifest::text) <= 32768
    AND (checkpoint IS NULL OR octet_length(checkpoint::text) <= 65536)
    AND (result IS NULL OR octet_length(result::text) <= 131072)
    AND (error IS NULL OR octet_length(error::text) <= 16384)
  ),
  CONSTRAINT voice_worker_jobs_read_only_manifest CHECK (
    capability_manifest->>'v' = '1'
    AND capability_manifest->>'mode' = 'read_only'
    AND jsonb_typeof(capability_manifest->'capabilities') = 'array'
    AND jsonb_array_length(capability_manifest->'capabilities') BETWEEN 1 AND 32
    AND capability_manifest = jsonb_build_object(
      'v', 1,
      'mode', 'read_only',
      'capabilities', capability_manifest->'capabilities',
      'networkOrigins', COALESCE(capability_manifest->'networkOrigins', '[]'::jsonb)
    )
  ),
  CONSTRAINT voice_worker_jobs_lifecycle CHECK (
    (status = 'pending' AND owner_token IS NULL AND claimed_at IS NULL
      AND lease_expires_at IS NULL AND heartbeat_at IS NULL
      AND dispatch_started_at IS NULL AND settled_at IS NULL)
    OR
    (status IN ('running','cancel_requested') AND owner_token IS NOT NULL
      AND claimed_at IS NOT NULL AND lease_expires_at > claimed_at
      AND heartbeat_at IS NOT NULL AND claimed_cancellation_epoch IS NOT NULL
      AND settled_at IS NULL)
    OR
    (status IN ('succeeded','failed','cancelled','indeterminate')
      AND owner_token IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL
      AND settled_at IS NOT NULL)
  ),
  CONSTRAINT voice_worker_jobs_terminal_payload CHECK (
    (status = 'succeeded' AND result IS NOT NULL AND result_sha256 IS NOT NULL AND error IS NULL)
    OR (status = 'failed' AND result IS NULL AND result_sha256 IS NULL AND error IS NOT NULL)
    OR (status IN ('cancelled','indeterminate') AND result IS NULL AND result_sha256 IS NULL)
    OR (status IN ('pending','running','cancel_requested')
      AND result IS NULL AND result_sha256 IS NULL AND error IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_voice_worker_jobs_claim
  ON public.voice_worker_jobs(created_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_voice_worker_jobs_expired
  ON public.voice_worker_jobs(lease_expires_at, id)
  WHERE status IN ('running','cancel_requested');
CREATE INDEX IF NOT EXISTS idx_voice_worker_jobs_conversation
  ON public.voice_worker_jobs(conversation_id, created_at, id);

CREATE TABLE IF NOT EXISTS public.voice_worker_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 32768),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  previous_event_sha256 text CHECK (previous_event_sha256 IS NULL OR previous_event_sha256 ~ '^[a-f0-9]{64}$'),
  event_sha256 text NOT NULL UNIQUE CHECK (event_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (worker_id, sequence),
  CONSTRAINT voice_worker_events_worker_fk
    FOREIGN KEY (worker_id, conversation_id)
    REFERENCES public.voice_worker_jobs(id, conversation_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.voice_conversation_inbox (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  source_event_sha256 text NOT NULL UNIQUE REFERENCES public.voice_worker_events(event_sha256),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 131072),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  delivery_token uuid,
  delivery_lease_expires_at timestamptz,
  delivery_count integer NOT NULL DEFAULT 0 CHECK (delivery_count BETWEEN 0 AND 10000),
  application_id uuid UNIQUE,
  applied_context_version bigint CHECK (applied_context_version IS NULL OR applied_context_version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  acknowledged_at timestamptz,
  CONSTRAINT voice_conversation_inbox_worker_fk
    FOREIGN KEY (worker_id, conversation_id)
    REFERENCES public.voice_worker_jobs(id, conversation_id) ON DELETE RESTRICT,
  CONSTRAINT voice_conversation_inbox_delivery_valid CHECK (
    (delivery_token IS NULL) = (delivery_lease_expires_at IS NULL)
    AND ((application_id IS NULL AND applied_at IS NULL AND applied_context_version IS NULL)
      OR (application_id IS NOT NULL AND applied_at IS NOT NULL AND applied_context_version IS NOT NULL))
    AND (acknowledged_at IS NULL OR applied_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_voice_conversation_inbox_delivery
  ON public.voice_conversation_inbox(conversation_id, created_at, id)
  WHERE acknowledged_at IS NULL;

CREATE OR REPLACE FUNCTION public.reject_voice_worker_immutable_mutation()
RETURNS trigger LANGUAGE plpgsql AS $voice_worker_immutable$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'durable voice worker evidence cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.parent_worker_id IS DISTINCT FROM OLD.parent_worker_id
     OR NEW.source_call_id IS DISTINCT FROM OLD.source_call_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.worker_kind IS DISTINCT FROM OLD.worker_kind
     OR NEW.spawn_authority IS DISTINCT FROM OLD.spawn_authority
     OR NEW.spawn_authority_sha256 IS DISTINCT FROM OLD.spawn_authority_sha256
     OR NEW.worker_input IS DISTINCT FROM OLD.worker_input
     OR NEW.worker_input_sha256 IS DISTINCT FROM OLD.worker_input_sha256
     OR NEW.capability_manifest IS DISTINCT FROM OLD.capability_manifest
     OR NEW.capability_manifest_sha256 IS DISTINCT FROM OLD.capability_manifest_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'voice worker spawn authority and input are immutable';
  END IF;
  RETURN NEW;
END
$voice_worker_immutable$;

DROP TRIGGER IF EXISTS trg_voice_worker_jobs_immutable ON public.voice_worker_jobs;
CREATE TRIGGER trg_voice_worker_jobs_immutable
BEFORE UPDATE OR DELETE ON public.voice_worker_jobs
FOR EACH ROW EXECUTE FUNCTION public.reject_voice_worker_immutable_mutation();

CREATE OR REPLACE FUNCTION public.reject_voice_worker_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $voice_worker_event_immutable$
BEGIN
  RAISE EXCEPTION 'voice worker events are append-only';
END
$voice_worker_event_immutable$;

DROP TRIGGER IF EXISTS trg_voice_worker_events_append_only ON public.voice_worker_events;
CREATE TRIGGER trg_voice_worker_events_append_only
BEFORE UPDATE OR DELETE ON public.voice_worker_events
FOR EACH ROW EXECUTE FUNCTION public.reject_voice_worker_event_mutation();

CREATE OR REPLACE FUNCTION public.append_voice_worker_event(
  worker_identity uuid,
  event_name text,
  event_payload_text text,
  event_payload_sha256 text
) RETURNS public.voice_worker_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $append_voice_worker_event$
DECLARE
  job public.voice_worker_jobs%ROWTYPE;
  prior public.voice_worker_events%ROWTYPE;
  inserted public.voice_worker_events%ROWTYPE;
  next_sequence integer;
  next_hash text;
BEGIN
  SELECT * INTO STRICT job FROM public.voice_worker_jobs WHERE id = worker_identity FOR UPDATE;
  IF octet_length(event_payload_text) > 32768
     OR event_payload_sha256 <> encode(digest(event_payload_text, 'sha256'), 'hex') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_event_payload_invalid';
  END IF;
  SELECT * INTO prior FROM public.voice_worker_events
    WHERE worker_id = worker_identity ORDER BY sequence DESC LIMIT 1;
  next_sequence := COALESCE(prior.sequence, 0) + 1;
  next_hash := encode(digest(
    convert_to('hacc/voice-worker-event/v1','utf8') || decode('00','hex')
      || convert_to(worker_identity::text,'utf8') || decode('00','hex')
      || convert_to(next_sequence::text,'utf8') || decode('00','hex')
      || convert_to(event_name,'utf8') || decode('00','hex')
      || convert_to(event_payload_sha256,'utf8') || decode('00','hex')
      || convert_to(COALESCE(prior.event_sha256,''),'utf8'), 'sha256'), 'hex');
  INSERT INTO public.voice_worker_events(
    conversation_id,worker_id,sequence,event_type,payload,payload_sha256,
    previous_event_sha256,event_sha256
  ) VALUES (
    job.conversation_id,job.id,next_sequence,event_name,event_payload_text::jsonb,
    event_payload_sha256,prior.event_sha256,next_hash
  ) RETURNING * INTO inserted;
  RETURN inserted;
END
$append_voice_worker_event$;

CREATE OR REPLACE FUNCTION public.ensure_voice_conversation(
  conversation_identity uuid,
  organization_identity uuid,
  agent_identity uuid,
  immutable_agent_version integer,
  call_identity uuid DEFAULT NULL
) RETURNS public.voice_conversations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $ensure_voice_conversation$
DECLARE
  conversation public.voice_conversations%ROWTYPE;
  call_agent uuid;
BEGIN
  IF immutable_agent_version <= 0 THEN RAISE EXCEPTION 'invalid voice conversation agent version'; END IF;
  INSERT INTO public.voice_conversations(id,org_id,agent_id,agent_version)
  VALUES (conversation_identity,organization_identity,agent_identity,immutable_agent_version)
  ON CONFLICT (id) DO NOTHING;
  SELECT * INTO STRICT conversation FROM public.voice_conversations
    WHERE id=conversation_identity FOR UPDATE;
  IF conversation.org_id <> organization_identity OR conversation.agent_id <> agent_identity
     OR conversation.agent_version <> immutable_agent_version THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_identity_conflict';
  END IF;
  IF call_identity IS NOT NULL THEN
    SELECT agent_id INTO call_agent FROM public.calls WHERE id=call_identity FOR SHARE;
    IF NOT FOUND OR call_agent <> agent_identity THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_call_authority_mismatch';
    END IF;
    INSERT INTO public.voice_conversation_calls(conversation_id,org_id,call_id)
    VALUES (conversation_identity,organization_identity,call_identity)
    ON CONFLICT (call_id) DO NOTHING;
    IF NOT EXISTS (
      SELECT 1 FROM public.voice_conversation_calls
      WHERE conversation_id=conversation_identity AND call_id=call_identity
    ) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_call_identity_conflict';
    END IF;
  END IF;
  RETURN conversation;
END
$ensure_voice_conversation$;

CREATE OR REPLACE FUNCTION public.spawn_voice_worker_job(
  worker_identity uuid,
  conversation_identity uuid,
  idempotency_identity text,
  requested_worker_kind text,
  authority_text text,
  authority_sha256 text,
  input_text text,
  input_sha256 text,
  manifest_text text,
  manifest_sha256 text,
  source_call_identity uuid DEFAULT NULL,
  parent_worker_identity uuid DEFAULT NULL
) RETURNS public.voice_worker_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $spawn_voice_worker_job$
DECLARE
  conversation public.voice_conversations%ROWTYPE;
  existing public.voice_worker_jobs%ROWTYPE;
  authority jsonb;
  input_value jsonb;
  manifest jsonb;
  event_payload text;
  event_digest text;
BEGIN
  SELECT * INTO STRICT conversation FROM public.voice_conversations
    WHERE id=conversation_identity FOR SHARE;
  IF conversation.status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_conversation_closed';
  END IF;
  IF octet_length(authority_text) > 32768 OR octet_length(input_text) > 65536
     OR octet_length(manifest_text) > 32768
     OR authority_sha256 <> encode(digest(authority_text,'sha256'),'hex')
     OR input_sha256 <> encode(digest(input_text,'sha256'),'hex')
     OR manifest_sha256 <> encode(digest(manifest_text,'sha256'),'hex') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_spawn_digest_mismatch';
  END IF;
  authority := authority_text::jsonb;
  input_value := input_text::jsonb;
  manifest := manifest_text::jsonb;
  IF jsonb_typeof(authority) <> 'object'
     OR jsonb_typeof(input_value) <> 'object'
     OR input_value->>'v' <> '1'
     OR jsonb_typeof(input_value->'objective') <> 'string'
     OR length(input_value->>'objective') NOT BETWEEN 1 AND 4096
     OR jsonb_typeof(input_value->'context') <> 'object'
     OR jsonb_typeof(input_value->'deliverable') <> 'string'
     OR length(input_value->>'deliverable') NOT BETWEEN 1 AND 1024
     OR input_value - ARRAY['v','objective','context','deliverable','deadlineAt']::text[] <> '{}'::jsonb
     OR jsonb_typeof(manifest) <> 'object'
     OR manifest <> jsonb_build_object(
       'v',1,'mode','read_only','capabilities',manifest->'capabilities',
       'networkOrigins',COALESCE(manifest->'networkOrigins','[]'::jsonb)
     )
     OR jsonb_typeof(manifest->'capabilities') <> 'array'
     OR jsonb_array_length(manifest->'capabilities') NOT BETWEEN 1 AND 32
     OR jsonb_typeof(COALESCE(manifest->'networkOrigins','[]'::jsonb)) <> 'array'
     OR jsonb_array_length(COALESCE(manifest->'networkOrigins','[]'::jsonb)) > 32
     OR (
       SELECT count(*) <> count(DISTINCT capability#>>'{}')
       FROM jsonb_array_elements(manifest->'capabilities') capability
     )
     OR (
       SELECT count(*) <> count(DISTINCT origin#>>'{}')
       FROM jsonb_array_elements(COALESCE(manifest->'networkOrigins','[]'::jsonb)) origin
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(manifest->'capabilities') capability
       WHERE jsonb_typeof(capability) <> 'string'
          OR capability#>>'{}' !~ '^[a-z][a-z0-9_.-]{1,63}$'
     )
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(manifest->'networkOrigins','[]'::jsonb)) origin
       WHERE jsonb_typeof(origin) <> 'string' OR octet_length(origin#>>'{}') > 2048
          OR origin#>>'{}' !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$'
     )
     OR authority - ARRAY[
       'v','conversationId','organizationId','agentId','agentVersion','source',
       'sourceCallId','sourceWorkerId','conversationHeadSha256','conversationRevision',
       'goalId','policyEpoch','factDependencies','capabilityManifestSha256'
     ]::text[] <> '{}'::jsonb
     OR COALESCE(authority->>'v','') <> '1'
     OR COALESCE(authority->>'conversationId','') <> conversation.id::text
     OR COALESCE(authority->>'organizationId','') <> conversation.org_id::text
     OR COALESCE(authority->>'agentId','') <> conversation.agent_id::text
     OR (authority->>'agentVersion')::integer <> conversation.agent_version
     OR COALESCE(authority->>'conversationHeadSha256','') !~ '^[a-f0-9]{64}$'
     OR COALESCE(jsonb_typeof(authority->'conversationRevision'),'') <> 'number'
     OR (authority->>'conversationRevision')::numeric < 0
     OR (authority->>'conversationRevision')::numeric <> trunc((authority->>'conversationRevision')::numeric)
     OR COALESCE(authority->>'goalId','') !~ '^[a-z][a-z0-9_.:-]{1,127}$'
     OR COALESCE(jsonb_typeof(authority->'policyEpoch'),'') <> 'number'
     OR (authority->>'policyEpoch')::numeric < 0
     OR (authority->>'policyEpoch')::numeric <> trunc((authority->>'policyEpoch')::numeric)
     OR COALESCE(jsonb_typeof(authority->'factDependencies'),'') <> 'array'
     OR jsonb_array_length(authority->'factDependencies') > 64
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(authority->'factDependencies') dependency
       WHERE jsonb_typeof(dependency) <> 'object'
          OR dependency - ARRAY['key','revision']::text[] <> '{}'::jsonb
          OR COALESCE(dependency->>'key','') !~ '^[a-z][a-z0-9_.:-]{1,127}$'
          OR COALESCE(jsonb_typeof(dependency->'revision'),'') <> 'number'
          OR (dependency->>'revision')::numeric < 1
          OR (dependency->>'revision')::numeric <> trunc((dependency->>'revision')::numeric)
     )
     OR (SELECT count(*) FROM jsonb_array_elements(authority->'factDependencies')) <>
        (SELECT count(DISTINCT dependency->>'key') FROM jsonb_array_elements(authority->'factDependencies') dependency)
     OR COALESCE(authority->>'capabilityManifestSha256','') <> manifest_sha256
     OR COALESCE(manifest->>'mode','') <> 'read_only' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_spawn_authority_mismatch';
  END IF;
  IF authority->>'source' NOT IN ('voice_call','conversation','worker')
     OR (source_call_identity IS NOT NULL) IS DISTINCT FROM (authority->>'source' = 'voice_call')
     OR (parent_worker_identity IS NOT NULL) IS DISTINCT FROM (authority->>'source' = 'worker')
     OR (authority->>'source' = 'conversation' AND (source_call_identity IS NOT NULL OR parent_worker_identity IS NOT NULL))
     OR COALESCE(authority->>'sourceCallId','') <> COALESCE(source_call_identity::text,'')
     OR COALESCE(authority->>'sourceWorkerId','') <> COALESCE(parent_worker_identity::text,'') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_spawn_source_mismatch';
  END IF;
  IF source_call_identity IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.voice_conversation_calls
    WHERE conversation_id=conversation_identity AND call_id=source_call_identity
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_source_call_mismatch';
  END IF;
  IF parent_worker_identity IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.voice_worker_jobs
    WHERE id=parent_worker_identity AND conversation_id=conversation_identity
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_parent_mismatch';
  END IF;
  INSERT INTO public.voice_worker_jobs(
    id,conversation_id,org_id,parent_worker_id,source_call_id,idempotency_key,worker_kind,
    spawn_authority,spawn_authority_sha256,worker_input,worker_input_sha256,
    capability_manifest,capability_manifest_sha256
  ) VALUES (
    worker_identity,conversation_identity,conversation.org_id,parent_worker_identity,source_call_identity,
    idempotency_identity,requested_worker_kind,authority,authority_sha256,
    input_text::jsonb,input_sha256,manifest,manifest_sha256
  ) ON CONFLICT (conversation_id,idempotency_key) DO NOTHING;
  SELECT * INTO STRICT existing FROM public.voice_worker_jobs
    WHERE conversation_id=conversation_identity AND idempotency_key=idempotency_identity;
  IF existing.id <> worker_identity OR existing.worker_kind <> requested_worker_kind
     OR existing.spawn_authority_sha256 <> authority_sha256
     OR existing.worker_input_sha256 <> input_sha256
     OR existing.capability_manifest_sha256 <> manifest_sha256 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_idempotency_conflict';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.voice_worker_events WHERE worker_id=existing.id) THEN
    event_payload := jsonb_build_object('status','pending')::text;
    event_digest := encode(digest(event_payload,'sha256'),'hex');
    PERFORM public.append_voice_worker_event(existing.id,'spawned',event_payload,event_digest);
  END IF;
  RETURN existing;
END
$spawn_voice_worker_job$;

CREATE OR REPLACE FUNCTION public.claim_voice_worker_job(owner_identity uuid, lease_milliseconds integer)
RETURNS SETOF public.voice_worker_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $claim_voice_worker_job$
DECLARE
  candidate public.voice_worker_jobs%ROWTYPE;
  payload text;
BEGIN
  IF lease_milliseconds NOT BETWEEN 5000 AND 300000 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_lease_invalid';
  END IF;
  FOR candidate IN
    SELECT * FROM public.voice_worker_jobs
    WHERE status IN ('running','cancel_requested') AND lease_expires_at <= clock_timestamp()
    ORDER BY lease_expires_at,id FOR UPDATE SKIP LOCKED
  LOOP
    IF candidate.dispatch_started_at IS NOT NULL THEN
      UPDATE public.voice_worker_jobs SET status='indeterminate',owner_token=NULL,
        lease_expires_at=NULL,heartbeat_at=NULL,settled_at=clock_timestamp(),
        error=jsonb_build_object('code','worker_lease_expired_after_dispatch') WHERE id=candidate.id;
      payload := jsonb_build_object('status','indeterminate','reason','lease_expired_after_dispatch')::text;
      PERFORM public.append_voice_worker_event(candidate.id,'indeterminate',payload,encode(digest(payload,'sha256'),'hex'));
    ELSIF candidate.status = 'cancel_requested' THEN
      UPDATE public.voice_worker_jobs SET status='cancelled',owner_token=NULL,claimed_at=NULL,
        lease_expires_at=NULL,heartbeat_at=NULL,settled_at=clock_timestamp() WHERE id=candidate.id;
      payload := jsonb_build_object('status','cancelled','reason','cancel_observed_on_reclaim')::text;
      PERFORM public.append_voice_worker_event(candidate.id,'cancelled',payload,encode(digest(payload,'sha256'),'hex'));
    ELSE
      UPDATE public.voice_worker_jobs SET status='pending',owner_token=NULL,claimed_at=NULL,
        lease_expires_at=NULL,heartbeat_at=NULL,claimed_cancellation_epoch=NULL WHERE id=candidate.id;
      payload := jsonb_build_object('status','pending','reason','lease_reclaimed_before_dispatch')::text;
      PERFORM public.append_voice_worker_event(candidate.id,'reclaimed',payload,encode(digest(payload,'sha256'),'hex'));
    END IF;
  END LOOP;
  SELECT * INTO candidate FROM public.voice_worker_jobs
    WHERE status='pending' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.voice_worker_jobs SET status='running',owner_token=owner_identity,
    claimed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),
    lease_expires_at=clock_timestamp() + lease_milliseconds * interval '1 millisecond',
    claimed_cancellation_epoch=cancellation_epoch
  WHERE id=candidate.id RETURNING * INTO candidate;
  payload := jsonb_build_object('status','running','cancellationEpoch',candidate.cancellation_epoch)::text;
  PERFORM public.append_voice_worker_event(candidate.id,'claimed',payload,encode(digest(payload,'sha256'),'hex'));
  RETURN NEXT candidate;
END
$claim_voice_worker_job$;

CREATE OR REPLACE FUNCTION public.heartbeat_voice_worker_job(
  worker_identity uuid, owner_identity uuid, lease_milliseconds integer
) RETURNS public.voice_worker_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $heartbeat_voice_worker_job$
DECLARE job public.voice_worker_jobs%ROWTYPE;
BEGIN
  IF lease_milliseconds NOT BETWEEN 5000 AND 300000 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_lease_invalid';
  END IF;
  UPDATE public.voice_worker_jobs SET heartbeat_at=clock_timestamp(),
    lease_expires_at=clock_timestamp() + lease_milliseconds * interval '1 millisecond'
  WHERE id=worker_identity AND owner_token=owner_identity
    AND status IN ('running','cancel_requested') AND lease_expires_at > clock_timestamp()
  RETURNING * INTO job;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_lease_lost'; END IF;
  RETURN job;
END
$heartbeat_voice_worker_job$;

CREATE OR REPLACE FUNCTION public.mark_voice_worker_dispatch_started(
  worker_identity uuid, owner_identity uuid
) RETURNS public.voice_worker_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $mark_voice_worker_dispatch_started$
DECLARE job public.voice_worker_jobs%ROWTYPE; payload text;
BEGIN
  UPDATE public.voice_worker_jobs SET dispatch_started_at=COALESCE(dispatch_started_at,clock_timestamp())
  WHERE id=worker_identity AND owner_token=owner_identity AND status='running'
    AND lease_expires_at > clock_timestamp()
    AND claimed_cancellation_epoch=cancellation_epoch
  RETURNING * INTO job;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_dispatch_not_authorized'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.voice_worker_events WHERE worker_id=job.id AND event_type='dispatch_started') THEN
    payload := jsonb_build_object('status','running')::text;
    PERFORM public.append_voice_worker_event(job.id,'dispatch_started',payload,encode(digest(payload,'sha256'),'hex'));
  END IF;
  RETURN job;
END
$mark_voice_worker_dispatch_started$;

CREATE OR REPLACE FUNCTION public.checkpoint_voice_worker_job(
  worker_identity uuid, owner_identity uuid, checkpoint_text text, checkpoint_digest text
) RETURNS public.voice_worker_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $checkpoint_voice_worker_job$
DECLARE job public.voice_worker_jobs%ROWTYPE; payload text;
BEGIN
  IF octet_length(checkpoint_text)>65536
     OR checkpoint_digest<>encode(digest(checkpoint_text,'sha256'),'hex')
     OR jsonb_typeof(checkpoint_text::jsonb)<>'object'
     OR checkpoint_text::jsonb->>'v'<>'1'
     OR jsonb_typeof(checkpoint_text::jsonb->'phase')<>'string'
     OR length(checkpoint_text::jsonb->>'phase') NOT BETWEEN 1 AND 128
     OR jsonb_typeof(checkpoint_text::jsonb->'progress')<>'number'
     OR (checkpoint_text::jsonb->>'progress')::numeric NOT BETWEEN 0 AND 1
     OR jsonb_typeof(checkpoint_text::jsonb->'resumableState')<>'object'
     OR jsonb_typeof(checkpoint_text::jsonb->'updatedAt')<>'string'
     OR checkpoint_text::jsonb <> jsonb_build_object(
       'v',1,'phase',checkpoint_text::jsonb->'phase','progress',checkpoint_text::jsonb->'progress',
       'resumableState',checkpoint_text::jsonb->'resumableState','updatedAt',checkpoint_text::jsonb->'updatedAt'
     ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_checkpoint_invalid';
  END IF;
  UPDATE public.voice_worker_jobs SET checkpoint=checkpoint_text::jsonb,checkpoint_sha256=checkpoint_digest
  WHERE id=worker_identity AND owner_token=owner_identity
    AND status IN ('running','cancel_requested') AND lease_expires_at>clock_timestamp()
  RETURNING * INTO job;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_lease_lost'; END IF;
  payload := jsonb_build_object('checkpointSha256',checkpoint_digest)::text;
  PERFORM public.append_voice_worker_event(job.id,'checkpointed',payload,encode(digest(payload,'sha256'),'hex'));
  RETURN job;
END
$checkpoint_voice_worker_job$;

CREATE OR REPLACE FUNCTION public.request_voice_worker_cancellation(
  worker_identity uuid, organization_identity uuid
)
RETURNS public.voice_worker_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $cancel_voice_worker_job$
DECLARE job public.voice_worker_jobs%ROWTYPE; payload text;
BEGIN
  SELECT * INTO STRICT job FROM public.voice_worker_jobs
    WHERE id=worker_identity AND org_id=organization_identity FOR UPDATE;
  IF job.status IN ('succeeded','failed','cancelled','indeterminate') THEN RETURN job; END IF;
  UPDATE public.voice_worker_jobs SET cancellation_epoch=cancellation_epoch+1,
    status=CASE WHEN status='pending' THEN 'cancelled' ELSE 'cancel_requested' END,
    settled_at=CASE WHEN status='pending' THEN clock_timestamp() ELSE settled_at END
  WHERE id=worker_identity RETURNING * INTO job;
  payload := jsonb_build_object('status',job.status,'cancellationEpoch',job.cancellation_epoch)::text;
  PERFORM public.append_voice_worker_event(job.id,'cancellation_requested',payload,encode(digest(payload,'sha256'),'hex'));
  RETURN job;
END
$cancel_voice_worker_job$;

CREATE OR REPLACE FUNCTION public.settle_voice_worker_job(
  worker_identity uuid, owner_identity uuid, terminal_status text,
  result_text text DEFAULT NULL, result_digest text DEFAULT NULL, error_text text DEFAULT NULL
) RETURNS public.voice_worker_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $settle_voice_worker_job$
DECLARE job public.voice_worker_jobs%ROWTYPE; payload text; terminal_event public.voice_worker_events%ROWTYPE;
BEGIN
  IF terminal_status NOT IN ('succeeded','failed','cancelled') THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_terminal_status_invalid';
  END IF;
  IF terminal_status='succeeded' THEN
    IF result_text IS NULL OR result_digest IS NULL OR octet_length(result_text)>131072
       OR result_digest<>encode(digest(result_text,'sha256'),'hex')
       OR jsonb_typeof(result_text::jsonb)<>'object'
       OR result_text::jsonb->>'v'<>'1'
       OR jsonb_typeof(result_text::jsonb->'facts')<>'array'
       OR jsonb_typeof(result_text::jsonb->'citations')<>'array'
       OR jsonb_typeof(result_text::jsonb->'proposedActions')<>'array'
       OR jsonb_typeof(result_text::jsonb->'summary')<>'string'
       OR length(result_text::jsonb->>'summary') NOT BETWEEN 1 AND 8192
       OR jsonb_array_length(result_text::jsonb->'facts') > 256
       OR jsonb_array_length(result_text::jsonb->'citations') > 256
       OR jsonb_array_length(result_text::jsonb->'proposedActions') > 64
       OR result_text::jsonb <> jsonb_build_object(
         'v',1,'facts',result_text::jsonb->'facts','citations',result_text::jsonb->'citations',
         'proposedActions',result_text::jsonb->'proposedActions','summary',result_text::jsonb->'summary'
       )
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(result_text::jsonb->'facts') fact
         WHERE jsonb_typeof(fact)<>'object'
            OR jsonb_typeof(fact->'key')<>'string'
            OR length(fact->>'key') NOT BETWEEN 1 AND 128
            OR jsonb_typeof(fact->'confidence')<>'number'
            OR (fact->>'confidence')::numeric NOT BETWEEN 0 AND 1
            OR jsonb_typeof(fact->'citationIds')<>'array'
            OR jsonb_array_length(fact->'citationIds') > 32
            OR fact <> jsonb_build_object(
              'key',fact->'key','value',fact->'value','confidence',fact->'confidence',
              'citationIds',fact->'citationIds'
            )
       )
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(result_text::jsonb->'citations') citation
         WHERE jsonb_typeof(citation)<>'object'
            OR jsonb_typeof(citation->'id')<>'string'
            OR length(citation->>'id') NOT BETWEEN 1 AND 128
            OR jsonb_typeof(citation->'uri')<>'string'
            OR length(citation->>'uri') NOT BETWEEN 1 AND 2048
            OR jsonb_typeof(citation->'retrievedAt')<>'string'
            OR citation - ARRAY['id','uri','title','excerpt','retrievedAt']::text[] <> '{}'::jsonb
       )
       OR (
         SELECT count(*) <> count(DISTINCT citation->>'id')
         FROM jsonb_array_elements(result_text::jsonb->'citations') citation
       )
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(result_text::jsonb->'facts') fact,
              jsonb_array_elements_text(fact->'citationIds') citation_id
         WHERE NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(result_text::jsonb->'citations') citation
           WHERE citation->>'id'=citation_id
         )
       )
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(result_text::jsonb->'proposedActions') action
         WHERE jsonb_typeof(action)<>'object'
            OR action->>'requiresConfirmation'<>'true'
            OR jsonb_typeof(action->'kind')<>'string'
            OR action->>'kind' !~ '^[a-z][a-z0-9_.-]{1,63}$'
            OR jsonb_typeof(action->'rationale')<>'string'
            OR length(action->>'rationale') NOT BETWEEN 1 AND 2048
            OR jsonb_typeof(action->'arguments')<>'object'
            OR action <> jsonb_build_object(
              'kind',action->'kind','rationale',action->'rationale',
              'arguments',action->'arguments','requiresConfirmation',true
            )
       ) THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_result_invalid';
    END IF;
  ELSIF terminal_status='failed' THEN
    IF error_text IS NULL OR octet_length(error_text)>16384 OR jsonb_typeof(error_text::jsonb)<>'object' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_error_invalid';
    END IF;
  END IF;
  UPDATE public.voice_worker_jobs SET status=terminal_status,result=result_text::jsonb,
    result_sha256=result_digest,error=error_text::jsonb,owner_token=NULL,
    lease_expires_at=NULL,heartbeat_at=NULL,settled_at=clock_timestamp()
  WHERE id=worker_identity AND owner_token=owner_identity
    AND status IN ('running','cancel_requested') AND lease_expires_at>clock_timestamp()
    AND (terminal_status<>'succeeded' OR status='running')
  RETURNING * INTO job;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_worker_settlement_not_authorized'; END IF;
  payload := jsonb_build_object('status',job.status,'resultSha256',job.result_sha256)::text;
  terminal_event := public.append_voice_worker_event(job.id,terminal_status,payload,encode(digest(payload,'sha256'),'hex'));
  IF terminal_status='succeeded' THEN
    INSERT INTO public.voice_conversation_inbox(
      id,conversation_id,worker_id,source_event_sha256,payload,payload_sha256
    ) VALUES (gen_random_uuid(),job.conversation_id,job.id,terminal_event.event_sha256,job.result,job.result_sha256);
  END IF;
  RETURN job;
END
$settle_voice_worker_job$;

CREATE OR REPLACE FUNCTION public.claim_voice_conversation_inbox(
  conversation_identity uuid, organization_identity uuid, delivery_identity uuid,
  lease_milliseconds integer, maximum_messages integer DEFAULT 16
) RETURNS SETOF public.voice_conversation_inbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $claim_voice_conversation_inbox$
BEGIN
  IF lease_milliseconds NOT BETWEEN 1000 AND 300000 OR maximum_messages NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_inbox_claim_invalid';
  END IF;
  RETURN QUERY
    WITH candidates AS (
      SELECT id FROM public.voice_conversation_inbox
      WHERE conversation_id=conversation_identity AND acknowledged_at IS NULL
        AND EXISTS (
          SELECT 1 FROM public.voice_conversations conversation
          WHERE conversation.id=conversation_identity AND conversation.org_id=organization_identity
        )
        AND (delivery_lease_expires_at IS NULL OR delivery_lease_expires_at<=clock_timestamp())
      ORDER BY created_at,id LIMIT maximum_messages FOR UPDATE SKIP LOCKED
    )
    UPDATE public.voice_conversation_inbox inbox SET delivery_token=delivery_identity,
      delivery_lease_expires_at=clock_timestamp()+lease_milliseconds*interval '1 millisecond',
      delivery_count=delivery_count+1
    FROM candidates WHERE inbox.id=candidates.id RETURNING inbox.*;
END
$claim_voice_conversation_inbox$;

CREATE OR REPLACE FUNCTION public.apply_voice_conversation_inbox(
  message_identity uuid, organization_identity uuid, delivery_identity uuid, application_identity uuid
) RETURNS public.voice_conversation_inbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $apply_voice_conversation_inbox$
DECLARE message public.voice_conversation_inbox%ROWTYPE; next_version bigint;
BEGIN
  SELECT inbox.* INTO STRICT message
  FROM public.voice_conversation_inbox inbox
  JOIN public.voice_conversations conversation ON conversation.id=inbox.conversation_id
  WHERE inbox.id=message_identity AND conversation.org_id=organization_identity
  FOR UPDATE OF inbox;
  IF message.application_id IS NOT NULL THEN
    IF message.application_id<>application_identity THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_inbox_application_conflict';
    END IF;
    RETURN message;
  END IF;
  IF message.delivery_token<>delivery_identity OR message.delivery_lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='voice_inbox_delivery_lease_lost';
  END IF;
  UPDATE public.voice_conversations SET context_version=context_version+1,updated_at=clock_timestamp()
    WHERE id=message.conversation_id RETURNING context_version INTO STRICT next_version;
  UPDATE public.voice_conversation_inbox SET application_id=application_identity,
    applied_context_version=next_version,applied_at=clock_timestamp(),acknowledged_at=clock_timestamp(),
    delivery_token=NULL,delivery_lease_expires_at=NULL
    WHERE id=message_identity RETURNING * INTO message;
  RETURN message;
END
$apply_voice_conversation_inbox$;

-- Direct table access is denied. Runtime roles receive only the smallest transition functions.
DO $voice_worker_rls$
DECLARE table_name text; api_role text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'voice_conversations','voice_conversation_calls','voice_worker_jobs',
    'voice_worker_events','voice_conversation_inbox'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS hacc_migration_owner_all ON public.%I',table_name);
    EXECUTE format('CREATE POLICY hacc_migration_owner_all ON public.%I FOR ALL TO %I USING (true) WITH CHECK (true)',table_name,current_user);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',table_name);
    FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role','hacc_backend','hacc_worker'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=api_role) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I',table_name,api_role);
      END IF;
    END LOOP;
  END LOOP;
END
$voice_worker_rls$;

REVOKE ALL ON FUNCTION public.append_voice_worker_event(uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_voice_conversation(uuid,uuid,uuid,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.spawn_voice_worker_job(uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_voice_worker_job(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.heartbeat_voice_worker_job(uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_voice_worker_dispatch_started(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.checkpoint_voice_worker_job(uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_voice_worker_cancellation(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_voice_worker_job(uuid,uuid,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_voice_conversation_inbox(uuid,uuid,uuid,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_voice_conversation_inbox(uuid,uuid,uuid,uuid) FROM PUBLIC;

-- Migration 013 normally provisions these NOLOGIN capability roles. Conditional
-- grants keep a schema-only/bootstrap installation reapplicable; operators must
-- provision the corresponding role before enabling that runtime.
DO $voice_worker_function_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hacc_backend') THEN
    GRANT EXECUTE ON FUNCTION public.ensure_voice_conversation(uuid,uuid,uuid,integer,uuid) TO hacc_backend;
    GRANT EXECUTE ON FUNCTION public.spawn_voice_worker_job(uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid) TO hacc_backend;
    GRANT EXECUTE ON FUNCTION public.request_voice_worker_cancellation(uuid,uuid) TO hacc_backend;
    GRANT EXECUTE ON FUNCTION public.claim_voice_conversation_inbox(uuid,uuid,uuid,integer,integer) TO hacc_backend;
    GRANT EXECUTE ON FUNCTION public.apply_voice_conversation_inbox(uuid,uuid,uuid,uuid) TO hacc_backend;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hacc_worker') THEN
    GRANT EXECUTE ON FUNCTION public.claim_voice_worker_job(uuid,integer) TO hacc_worker;
    GRANT EXECUTE ON FUNCTION public.heartbeat_voice_worker_job(uuid,uuid,integer) TO hacc_worker;
    GRANT EXECUTE ON FUNCTION public.mark_voice_worker_dispatch_started(uuid,uuid) TO hacc_worker;
    GRANT EXECUTE ON FUNCTION public.checkpoint_voice_worker_job(uuid,uuid,text,text) TO hacc_worker;
    GRANT EXECUTE ON FUNCTION public.settle_voice_worker_job(uuid,uuid,text,text,text,text) TO hacc_worker;
  END IF;
END
$voice_worker_function_grants$;

COMMENT ON TABLE public.voice_worker_jobs IS
  'Durable read-only conversation work. Immutable spawn inputs, pre-dispatch reclaim, post-dispatch ambiguity quarantine.';
COMMENT ON TABLE public.voice_conversation_inbox IS
  'At-least-once result delivery with one database-serialized application identity and conversation context version.';

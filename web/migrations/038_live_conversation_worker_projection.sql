-- Narrow immutable worker projection used when the stock live-call route
-- applies a completed governed worker result to its durable conversation.
-- Runtime roles retain no direct table access.

DROP FUNCTION IF EXISTS public.load_voice_worker_for_delivery(uuid,uuid,uuid);

CREATE FUNCTION public.load_voice_worker_for_delivery(
  worker_identity uuid,
  organization_identity uuid,
  conversation_identity uuid
) RETURNS TABLE(
  id uuid,
  conversation_id uuid,
  org_id uuid,
  source_call_id uuid,
  spawn_authority jsonb,
  spawn_authority_sha256 text,
  result_sha256 text,
  settled_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $load_voice_worker_for_delivery$
  SELECT
    job.id,
    job.conversation_id,
    job.org_id,
    job.source_call_id,
    job.spawn_authority,
    job.spawn_authority_sha256,
    job.result_sha256,
    job.settled_at
  FROM public.voice_worker_jobs job
  JOIN public.voice_conversations conversation
    ON conversation.id = job.conversation_id
   AND conversation.org_id = job.org_id
  WHERE job.id = worker_identity
    AND job.org_id = organization_identity
    AND job.conversation_id = conversation_identity
    AND conversation.id = conversation_identity
    AND job.status = 'succeeded'
    AND job.result IS NOT NULL
    AND job.result_sha256 IS NOT NULL
    AND job.settled_at IS NOT NULL;
$load_voice_worker_for_delivery$;

REVOKE ALL ON FUNCTION public.load_voice_worker_for_delivery(uuid,uuid,uuid) FROM PUBLIC;

DO $live_conversation_worker_projection_grant$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY[
    'anon','authenticated','service_role','hacc_worker','hacc_backend'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.load_voice_worker_for_delivery(uuid,uuid,uuid) FROM %I',
        api_role
      );
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    GRANT EXECUTE ON FUNCTION
      public.load_voice_worker_for_delivery(uuid,uuid,uuid)
      TO hacc_backend;
  END IF;
END
$live_conversation_worker_projection_grant$;

COMMENT ON FUNCTION public.load_voice_worker_for_delivery(uuid,uuid,uuid) IS
  'Returns at most one succeeded immutable delivery projection when worker, organization, and conversation identities all match. Owner tokens, leases, checkpoints, worker input, result content, cancellation state, and other executor authority are never exposed.';

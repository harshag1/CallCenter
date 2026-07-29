-- Migration 013 deliberately gives the application backend broad access to
-- ordinary future functions. Durable worker leases are a separate bearer
-- authority: reassert the exact coordinator/worker split for databases that
-- already applied migration 032 before its fresh-install ACL correction.

DO $voice_worker_function_acl$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'anon','authenticated','service_role','hacc_backend','hacc_worker'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.append_voice_worker_event(uuid,text,text,text) FROM %I',runtime_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.ensure_voice_conversation(uuid,uuid,uuid,integer,uuid) FROM %I',runtime_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.spawn_voice_worker_job(uuid,uuid,text,text,text,text,text,text,text,text,uuid,uuid) FROM %I',runtime_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.claim_voice_worker_job(uuid,integer) FROM %I',runtime_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.heartbeat_voice_worker_job(uuid,uuid,integer) FROM %I',runtime_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.mark_voice_worker_dispatch_started(uuid,uuid) FROM %I',runtime_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.checkpoint_voice_worker_job(uuid,uuid,text,text) FROM %I',runtime_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.request_voice_worker_cancellation(uuid,uuid) FROM %I',runtime_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.settle_voice_worker_job(uuid,uuid,text,text,text,text) FROM %I',runtime_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.claim_voice_conversation_inbox(uuid,uuid,uuid,integer,integer) FROM %I',runtime_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.apply_voice_conversation_inbox(uuid,uuid,uuid,uuid) FROM %I',runtime_role);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hacc_backend') THEN
    GRANT EXECUTE ON FUNCTION public.ensure_voice_conversation(uuid,uuid,uuid,integer,uuid) TO hacc_backend;
    GRANT EXECUTE ON FUNCTION public.request_voice_worker_cancellation(uuid,uuid) TO hacc_backend;
    GRANT EXECUTE ON FUNCTION public.claim_voice_conversation_inbox(uuid,uuid,uuid,integer,integer) TO hacc_backend;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hacc_worker') THEN
    GRANT EXECUTE ON FUNCTION public.claim_voice_worker_job(uuid,integer) TO hacc_worker;
    GRANT EXECUTE ON FUNCTION public.heartbeat_voice_worker_job(uuid,uuid,integer) TO hacc_worker;
    GRANT EXECUTE ON FUNCTION public.mark_voice_worker_dispatch_started(uuid,uuid) TO hacc_worker;
    GRANT EXECUTE ON FUNCTION public.checkpoint_voice_worker_job(uuid,uuid,text,text) TO hacc_worker;
    GRANT EXECUTE ON FUNCTION public.settle_voice_worker_job(uuid,uuid,text,text,text,text) TO hacc_worker;
  END IF;
END
$voice_worker_function_acl$;

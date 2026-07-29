-- pgcrypto installs into `extensions` on hosted Supabase and into `public` on
-- a stock PostgreSQL cluster. These SECURITY DEFINER functions hash canonical
-- event bytes at execution time, so their fixed search path must support both
-- layouts without falling back to the caller's mutable search path.

ALTER FUNCTION public.append_voice_conversation_events(
  uuid, uuid, text, text, text
) SET search_path = pg_catalog, extensions, public;

ALTER FUNCTION public.append_voice_worker_event(
  uuid, text, text, text
) SET search_path = pg_catalog, extensions, public;

ALTER FUNCTION public.spawn_voice_worker_job(
  uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid
) SET search_path = pg_catalog, extensions, public;

ALTER FUNCTION public.claim_voice_worker_job(
  uuid, integer
) SET search_path = pg_catalog, extensions, public;

ALTER FUNCTION public.mark_voice_worker_dispatch_started(
  uuid, uuid
) SET search_path = pg_catalog, extensions, public;

ALTER FUNCTION public.checkpoint_voice_worker_job(
  uuid, uuid, text, text
) SET search_path = pg_catalog, extensions, public;

ALTER FUNCTION public.request_voice_worker_cancellation(
  uuid, uuid
) SET search_path = pg_catalog, extensions, public;

ALTER FUNCTION public.settle_voice_worker_job(
  uuid, uuid, text, text, text, text
) SET search_path = pg_catalog, extensions, public;

ALTER FUNCTION public.spawn_governed_voice_worker(
  uuid, uuid, text, text, text, text, uuid, text, text, text, text, text, text,
  text, text, uuid, uuid
) SET search_path = pg_catalog, extensions, public;

ALTER FUNCTION public.apply_governed_voice_worker_result(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text
) SET search_path = pg_catalog, extensions, public;

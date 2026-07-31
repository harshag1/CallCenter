-- Durable, one-shot authority for paid post-call QA.
--
-- Several independent close paths may observe the same ended call. They all
-- converge on (call_id, analysis_version); only the exact lease owner may
-- begin provider dispatch. An expired pre-dispatch lease is reclaimable, while
-- an expired post-dispatch lease is terminally indeterminate and can never
-- authorize another paid request.

CREATE SCHEMA IF NOT EXISTS hacc_private;
REVOKE ALL ON SCHEMA hacc_private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS hacc_private.post_call_analysis_runs (
  call_id uuid NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,
  analysis_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  owner_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  dispatch_started_at timestamptz,
  settled_at timestamptz,
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT post_call_analysis_runs_pk
    PRIMARY KEY (call_id, analysis_version),
  CONSTRAINT post_call_analysis_runs_version_valid CHECK (
    analysis_version ~ '^[a-z][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT post_call_analysis_runs_status_valid CHECK (
    status IN (
      'pending',
      'running',
      'succeeded',
      'skipped',
      'failed',
      'indeterminate'
    )
  ),
  CONSTRAINT post_call_analysis_runs_error_valid CHECK (
    error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,127}$'
  ),
  CONSTRAINT post_call_analysis_runs_result_valid CHECK (
    result IS NULL
    OR (
      jsonb_typeof(result) = 'object'
      AND octet_length(result::text) <= 8192
    )
  ),
  CONSTRAINT post_call_analysis_runs_time_valid CHECK (
    updated_at >= created_at
    AND (claimed_at IS NULL OR claimed_at >= created_at)
    AND (
      dispatch_started_at IS NULL
      OR dispatch_started_at >= COALESCE(claimed_at, created_at)
    )
    AND (
      settled_at IS NULL
      OR settled_at >= COALESCE(dispatch_started_at, claimed_at, created_at)
    )
  ),
  CONSTRAINT post_call_analysis_runs_lifecycle_valid CHECK (
    (
      status = 'pending'
      AND owner_token IS NULL
      AND claimed_at IS NULL
      AND lease_expires_at IS NULL
      AND dispatch_started_at IS NULL
      AND settled_at IS NULL
      AND result IS NULL
      AND error_code IS NULL
    )
    OR (
      status = 'running'
      AND owner_token IS NOT NULL
      AND claimed_at IS NOT NULL
      AND lease_expires_at > claimed_at
      AND settled_at IS NULL
      AND result IS NULL
      AND error_code IS NULL
    )
    OR (
      status = 'succeeded'
      AND owner_token IS NULL
      AND lease_expires_at IS NULL
      AND dispatch_started_at IS NOT NULL
      AND settled_at IS NOT NULL
      AND result IS NOT NULL
      AND error_code IS NULL
    )
    OR (
      status = 'skipped'
      AND owner_token IS NULL
      AND lease_expires_at IS NULL
      AND dispatch_started_at IS NULL
      AND settled_at IS NOT NULL
      AND result IS NOT NULL
      AND error_code IS NULL
    )
    OR (
      status = 'failed'
      AND owner_token IS NULL
      AND lease_expires_at IS NULL
      AND settled_at IS NOT NULL
      AND result IS NULL
      AND error_code IS NOT NULL
    )
    OR (
      status = 'indeterminate'
      AND owner_token IS NULL
      AND lease_expires_at IS NULL
      AND dispatch_started_at IS NOT NULL
      AND settled_at IS NOT NULL
      AND result IS NULL
      AND error_code = 'lease_expired_after_dispatch'
    )
  )
);

COMMENT ON TABLE hacc_private.post_call_analysis_runs IS
  'One paid post-call QA authority per call and immutable analysis version.';
COMMENT ON COLUMN hacc_private.post_call_analysis_runs.dispatch_started_at IS
  'Point of no automatic retry: an expired lease after this timestamp becomes indeterminate.';
COMMENT ON COLUMN hacc_private.post_call_analysis_runs.result IS
  'Strict host-validated terminal QA result; raw provider responses are never persisted here.';

CREATE INDEX IF NOT EXISTS idx_post_call_analysis_runs_unresolved
  ON hacc_private.post_call_analysis_runs(
    lease_expires_at,
    call_id,
    analysis_version
  )
  WHERE status = 'running';

ALTER TABLE hacc_private.post_call_analysis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hacc_private.post_call_analysis_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS post_call_analysis_owner_all
  ON hacc_private.post_call_analysis_runs;
DROP POLICY IF EXISTS hacc_migration_owner_all
  ON hacc_private.post_call_analysis_runs;
DO $post_call_analysis_owner_policy$
BEGIN
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all '
    'ON hacc_private.post_call_analysis_runs '
    'FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$post_call_analysis_owner_policy$;

CREATE OR REPLACE FUNCTION public.claim_post_call_analysis(
  call_identity uuid,
  requested_analysis_version text,
  owner_identity uuid,
  lease_milliseconds integer
) RETURNS TABLE(
  call_id uuid,
  analysis_version text,
  status text,
  owner_token uuid,
  dispatch_started_at timestamptz,
  settled_at timestamptz,
  result jsonb,
  error_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, hacc_private
AS $claim_post_call_analysis$
DECLARE
  run hacc_private.post_call_analysis_runs%ROWTYPE;
  observed_at timestamptz;
BEGIN
  IF requested_analysis_version IS NULL
     OR requested_analysis_version !~ '^[a-z][a-z0-9._-]{0,63}$'
     OR owner_identity IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post_call_analysis_version_invalid';
  END IF;
  IF lease_milliseconds IS NULL
     OR lease_milliseconds NOT BETWEEN 5000 AND 120000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post_call_analysis_lease_invalid';
  END IF;

  INSERT INTO hacc_private.post_call_analysis_runs(
    call_id,
    analysis_version
  )
  SELECT call_identity, requested_analysis_version
  FROM public.calls
  WHERE id = call_identity
  ON CONFLICT (call_id, analysis_version) DO NOTHING;

  SELECT candidate.* INTO run
  FROM hacc_private.post_call_analysis_runs AS candidate
  WHERE candidate.call_id = call_identity
    AND candidate.analysis_version = requested_analysis_version
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  observed_at := clock_timestamp();

  IF run.status = 'running'
     AND run.lease_expires_at <= observed_at THEN
    IF run.dispatch_started_at IS NOT NULL THEN
      UPDATE hacc_private.post_call_analysis_runs
      SET status = 'indeterminate',
          owner_token = NULL,
          lease_expires_at = NULL,
          settled_at = observed_at,
          error_code = 'lease_expired_after_dispatch',
          updated_at = observed_at
      WHERE post_call_analysis_runs.call_id = call_identity
        AND post_call_analysis_runs.analysis_version = requested_analysis_version
      RETURNING * INTO run;
    ELSE
      UPDATE hacc_private.post_call_analysis_runs
      SET status = 'pending',
          owner_token = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          updated_at = observed_at
      WHERE post_call_analysis_runs.call_id = call_identity
        AND post_call_analysis_runs.analysis_version = requested_analysis_version
      RETURNING * INTO run;
    END IF;
  END IF;

  IF run.status = 'pending' THEN
    UPDATE hacc_private.post_call_analysis_runs
    SET status = 'running',
        owner_token = owner_identity,
        claimed_at = observed_at,
        lease_expires_at =
          observed_at + lease_milliseconds * interval '1 millisecond',
        updated_at = observed_at
    WHERE post_call_analysis_runs.call_id = call_identity
      AND post_call_analysis_runs.analysis_version = requested_analysis_version
      AND post_call_analysis_runs.status = 'pending'
    RETURNING * INTO run;
  END IF;

  RETURN QUERY SELECT
    run.call_id,
    run.analysis_version,
    run.status,
    run.owner_token,
    run.dispatch_started_at,
    run.settled_at,
    run.result,
    run.error_code;
END
$claim_post_call_analysis$;

CREATE OR REPLACE FUNCTION public.mark_post_call_analysis_dispatch_started(
  call_identity uuid,
  requested_analysis_version text,
  owner_identity uuid
) RETURNS TABLE(
  call_id uuid,
  analysis_version text,
  status text,
  owner_token uuid,
  dispatch_started_at timestamptz,
  settled_at timestamptz,
  result jsonb,
  error_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, hacc_private
AS $mark_post_call_analysis_dispatch_started$
DECLARE run hacc_private.post_call_analysis_runs%ROWTYPE;
BEGIN
  UPDATE hacc_private.post_call_analysis_runs
  SET dispatch_started_at = COALESCE(dispatch_started_at, clock_timestamp()),
      updated_at = clock_timestamp()
  WHERE post_call_analysis_runs.call_id = call_identity
    AND post_call_analysis_runs.analysis_version = requested_analysis_version
    AND post_call_analysis_runs.status = 'running'
    AND post_call_analysis_runs.owner_token = owner_identity
    AND post_call_analysis_runs.lease_expires_at > clock_timestamp()
  RETURNING * INTO run;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT
    run.call_id, run.analysis_version, run.status, run.owner_token,
    run.dispatch_started_at, run.settled_at, run.result, run.error_code;
END
$mark_post_call_analysis_dispatch_started$;

CREATE OR REPLACE FUNCTION public.settle_post_call_analysis_success(
  call_identity uuid,
  requested_analysis_version text,
  owner_identity uuid,
  analyzed_satisfaction integer,
  analyzed_resolution text,
  analyzed_review text,
  analyzed_summary text,
  analyzed_sentiment text,
  cutoff_evidence boolean,
  cutoff_context text
) RETURNS TABLE(
  call_id uuid,
  analysis_version text,
  status text,
  owner_token uuid,
  dispatch_started_at timestamptz,
  settled_at timestamptz,
  result jsonb,
  error_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, hacc_private
AS $settle_post_call_analysis_success$
DECLARE
  run hacc_private.post_call_analysis_runs%ROWTYPE;
  call_row record;
  callback_number text;
  callback_instructions text;
  recall_identity uuid;
  observed_at timestamptz := clock_timestamp();
BEGIN
  IF analyzed_satisfaction IS NULL
     OR analyzed_satisfaction NOT BETWEEN 1 AND 10
     OR analyzed_resolution IS NULL
     OR analyzed_resolution NOT IN (
       'ai_resolved',
       'human_resolved',
       'unresolved'
     )
     OR analyzed_review IS NULL
     OR octet_length(analyzed_review) NOT BETWEEN 1 AND 2000
     OR analyzed_summary IS NULL
     OR octet_length(analyzed_summary) NOT BETWEEN 1 AND 300
     OR analyzed_sentiment IS NULL
     OR analyzed_sentiment NOT IN ('positive', 'neutral', 'negative')
     OR cutoff_evidence IS NULL
     OR cutoff_context IS NULL
     OR octet_length(cutoff_context) > 2000
     OR (cutoff_evidence AND btrim(cutoff_context) = '')
     OR (NOT cutoff_evidence AND btrim(cutoff_context) <> '') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post_call_analysis_result_invalid';
  END IF;

  SELECT candidate.* INTO run
  FROM hacc_private.post_call_analysis_runs AS candidate
  WHERE candidate.call_id = call_identity
    AND candidate.analysis_version = requested_analysis_version
    AND candidate.status = 'running'
    AND candidate.owner_token = owner_identity
    AND candidate.dispatch_started_at IS NOT NULL
    AND candidate.lease_expires_at > observed_at
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.calls
  SET satisfaction = analyzed_satisfaction,
      resolution = analyzed_resolution,
      review = analyzed_review,
      summary = analyzed_summary,
      sentiment = analyzed_sentiment
  WHERE id = call_identity;

  -- The model supplies only bounded cutoff evidence. It cannot authorize an
  -- outbound action: scheduling also requires the host-owned recall policy to
  -- contain the exact JSON boolean true, a valid destination, and no prior
  -- recall lineage. Missing, null, string, or malformed values fail closed.
  IF cutoff_evidence THEN
    SELECT
      call.direction,
      call.from_number,
      call.to_number,
      call.agent_id,
      call.flow_id,
      call.parent_call_id,
      agent.recall_policy
    INTO call_row
    FROM public.calls AS call
    JOIN public.agents AS agent ON agent.id = call.agent_id
    WHERE call.id = call_identity
    FOR UPDATE OF call;

    IF FOUND
       AND call_row.parent_call_id IS NULL
       AND jsonb_typeof(call_row.recall_policy->'enabled') = 'boolean'
       AND call_row.recall_policy->'enabled' = 'true'::jsonb THEN
      callback_number := CASE
        WHEN call_row.direction = 'outbound' THEN call_row.to_number
        ELSE call_row.from_number
      END;
      IF callback_number ~ '^\+[0-9]{7,15}$' THEN
        callback_instructions := CASE
          WHEN jsonb_typeof(call_row.recall_policy->'instructions') = 'string'
            THEN left(call_row.recall_policy->>'instructions', 2000)
          ELSE
            'Apologize for the disconnect and pick up where the conversation left off.'
        END;
        INSERT INTO public.scheduled_calls(
          agent_id,
          to_number,
          run_at,
          reason,
          parent_call_id,
          created_by,
          flow_id
        )
        SELECT
          call_row.agent_id,
          callback_number,
          observed_at + interval '2 minutes',
          left(
            'CUT-OFF RECALL. Where it stood: ' || cutoff_context
              || '. Policy: ' || callback_instructions,
            4000
          ),
          call_identity,
          'recall-policy',
          call_row.flow_id
        WHERE NOT EXISTS (
          SELECT 1
          FROM public.scheduled_calls
          WHERE parent_call_id = call_identity
        )
        RETURNING id INTO recall_identity;
      END IF;
    END IF;
  END IF;

  UPDATE hacc_private.post_call_analysis_runs
  SET status = 'succeeded',
      owner_token = NULL,
      lease_expires_at = NULL,
      settled_at = observed_at,
      result = jsonb_build_object(
        'satisfaction', analyzed_satisfaction,
        'resolution', analyzed_resolution,
        'review', analyzed_review,
        'cutoff', cutoff_evidence,
        'cutoff_context', cutoff_context,
        'recall_scheduled', recall_identity IS NOT NULL
      ),
      updated_at = observed_at
  WHERE post_call_analysis_runs.call_id = call_identity
    AND post_call_analysis_runs.analysis_version = requested_analysis_version
  RETURNING * INTO run;

  RETURN QUERY SELECT
    run.call_id, run.analysis_version, run.status, run.owner_token,
    run.dispatch_started_at, run.settled_at, run.result, run.error_code;
END
$settle_post_call_analysis_success$;

CREATE OR REPLACE FUNCTION public.settle_post_call_analysis_skipped(
  call_identity uuid,
  requested_analysis_version text,
  owner_identity uuid
) RETURNS TABLE(
  call_id uuid,
  analysis_version text,
  status text,
  owner_token uuid,
  dispatch_started_at timestamptz,
  settled_at timestamptz,
  result jsonb,
  error_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, hacc_private
AS $settle_post_call_analysis_skipped$
DECLARE
  run hacc_private.post_call_analysis_runs%ROWTYPE;
  observed_at timestamptz := clock_timestamp();
BEGIN
  SELECT candidate.* INTO run
  FROM hacc_private.post_call_analysis_runs AS candidate
  WHERE candidate.call_id = call_identity
    AND candidate.analysis_version = requested_analysis_version
    AND candidate.status = 'running'
    AND candidate.owner_token = owner_identity
    AND candidate.dispatch_started_at IS NULL
    AND candidate.lease_expires_at > observed_at
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.calls
  SET resolution = COALESCE(resolution, 'unresolved')
  WHERE id = call_identity;
  UPDATE hacc_private.post_call_analysis_runs
  SET status = 'skipped',
      owner_token = NULL,
      lease_expires_at = NULL,
      settled_at = observed_at,
      result = jsonb_build_object('reason', 'insufficient_transcript'),
      updated_at = observed_at
  WHERE post_call_analysis_runs.call_id = call_identity
    AND post_call_analysis_runs.analysis_version = requested_analysis_version
  RETURNING * INTO run;

  RETURN QUERY SELECT
    run.call_id, run.analysis_version, run.status, run.owner_token,
    run.dispatch_started_at, run.settled_at, run.result, run.error_code;
END
$settle_post_call_analysis_skipped$;

CREATE OR REPLACE FUNCTION public.settle_post_call_analysis_failed(
  call_identity uuid,
  requested_analysis_version text,
  owner_identity uuid,
  bounded_error_code text
) RETURNS TABLE(
  call_id uuid,
  analysis_version text,
  status text,
  owner_token uuid,
  dispatch_started_at timestamptz,
  settled_at timestamptz,
  result jsonb,
  error_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, hacc_private
AS $settle_post_call_analysis_failed$
DECLARE
  run hacc_private.post_call_analysis_runs%ROWTYPE;
  observed_at timestamptz := clock_timestamp();
BEGIN
  IF bounded_error_code IS NULL
     OR bounded_error_code !~ '^[a-z][a-z0-9_]{0,127}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post_call_analysis_error_code_invalid';
  END IF;
  UPDATE hacc_private.post_call_analysis_runs
  SET status = 'failed',
      owner_token = NULL,
      lease_expires_at = NULL,
      settled_at = observed_at,
      error_code = bounded_error_code,
      updated_at = observed_at
  WHERE post_call_analysis_runs.call_id = call_identity
    AND post_call_analysis_runs.analysis_version = requested_analysis_version
    AND post_call_analysis_runs.status = 'running'
    AND post_call_analysis_runs.owner_token = owner_identity
    AND post_call_analysis_runs.lease_expires_at > observed_at
  RETURNING * INTO run;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT
    run.call_id, run.analysis_version, run.status, run.owner_token,
    run.dispatch_started_at, run.settled_at, run.result, run.error_code;
END
$settle_post_call_analysis_failed$;

REVOKE ALL ON hacc_private.post_call_analysis_runs FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.claim_post_call_analysis(uuid,text,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.mark_post_call_analysis_dispatch_started(uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.settle_post_call_analysis_success(
    uuid,text,uuid,integer,text,text,text,text,boolean,text
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.settle_post_call_analysis_skipped(uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  public.settle_post_call_analysis_failed(uuid,text,uuid,text) FROM PUBLIC;

DO $post_call_analysis_acl$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'anon',
    'authenticated',
    'service_role',
    'hacc_backend',
    'hacc_worker'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE ALL ON hacc_private.post_call_analysis_runs FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.claim_post_call_analysis(uuid,text,uuid,integer) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.mark_post_call_analysis_dispatch_started(uuid,text,uuid) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.settle_post_call_analysis_success(uuid,text,uuid,integer,text,text,text,text,boolean,text) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.settle_post_call_analysis_skipped(uuid,text,uuid) FROM %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.settle_post_call_analysis_failed(uuid,text,uuid,text) FROM %I',
        runtime_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    GRANT USAGE ON SCHEMA hacc_private TO hacc_backend;
    GRANT EXECUTE ON FUNCTION
      public.claim_post_call_analysis(uuid,text,uuid,integer),
      public.mark_post_call_analysis_dispatch_started(uuid,text,uuid),
      public.settle_post_call_analysis_success(
        uuid,text,uuid,integer,text,text,text,text,boolean,text
      ),
      public.settle_post_call_analysis_skipped(uuid,text,uuid),
      public.settle_post_call_analysis_failed(uuid,text,uuid,text)
      TO hacc_backend;
  END IF;
END
$post_call_analysis_acl$;

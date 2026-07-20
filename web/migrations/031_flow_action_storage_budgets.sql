-- Bound proof-carrying Flow v2 persistence per call. The append-only action
-- ledger remains the replay authority; completed hot-state receipts retain
-- only identities, hashes, byte evidence, and terminal status.

DO $existing_flow_storage_limits$
DECLARE
  oversized_receipt uuid;
  oversized_call uuid;
BEGIN
  SELECT id INTO oversized_receipt
  FROM public.flow_action_receipts
  WHERE octet_length(arguments::text) > 32768
     OR (result IS NOT NULL AND octet_length(result::text) > 65536)
     OR (error IS NOT NULL AND octet_length(error::text) > 16384)
  LIMIT 1;
  IF oversized_receipt IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot enable Flow storage budgets: receipt % exceeds a per-row ceiling',
      oversized_receipt;
  END IF;

  SELECT call_id INTO oversized_call
  FROM public.flow_action_receipts
  GROUP BY call_id
  HAVING count(*) > 512
      OR sum(
        octet_length(arguments::text)
        + COALESCE(octet_length(result::text), 0)
        + COALESCE(octet_length(error::text), 0)
      ) > 8388608
  LIMIT 1;
  IF oversized_call IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot enable Flow storage budgets: call % exceeds its receipt budget',
      oversized_call;
  END IF;

  SELECT call_id INTO oversized_call
  FROM public.flow_runs
  WHERE octet_length(state::text) > 8388608
     OR CASE
          WHEN jsonb_typeof(COALESCE(state->'actionReceipts', '[]'::jsonb)) = 'array'
            THEN jsonb_array_length(COALESCE(state->'actionReceipts', '[]'::jsonb)) > 512
          ELSE true
        END
  LIMIT 1;
  IF oversized_call IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot enable Flow storage budgets: call % has oversized hot state',
      oversized_call;
  END IF;
END
$existing_flow_storage_limits$;

ALTER TABLE public.flow_action_receipts
  DROP CONSTRAINT IF EXISTS flow_action_arguments_storage_bounded;
ALTER TABLE public.flow_action_receipts
  ADD CONSTRAINT flow_action_arguments_storage_bounded
  CHECK (octet_length(arguments::text) <= 32768);
ALTER TABLE public.flow_action_receipts
  DROP CONSTRAINT IF EXISTS flow_action_result_storage_bounded;
ALTER TABLE public.flow_action_receipts
  ADD CONSTRAINT flow_action_result_storage_bounded
  CHECK (result IS NULL OR octet_length(result::text) <= 65536);
ALTER TABLE public.flow_action_receipts
  DROP CONSTRAINT IF EXISTS flow_action_error_storage_bounded;
ALTER TABLE public.flow_action_receipts
  ADD CONSTRAINT flow_action_error_storage_bounded
  CHECK (error IS NULL OR octet_length(error::text) <= 16384);

ALTER TABLE public.flow_runs
  DROP CONSTRAINT IF EXISTS flow_run_action_receipt_count_bounded;
ALTER TABLE public.flow_runs
  ADD CONSTRAINT flow_run_action_receipt_count_bounded
  CHECK (CASE
    WHEN jsonb_typeof(COALESCE(state->'actionReceipts', '[]'::jsonb)) = 'array'
      THEN jsonb_array_length(COALESCE(state->'actionReceipts', '[]'::jsonb)) <= 512
    ELSE false
  END);
ALTER TABLE public.flow_runs
  DROP CONSTRAINT IF EXISTS flow_run_hot_state_storage_bounded;
ALTER TABLE public.flow_runs
  ADD CONSTRAINT flow_run_hot_state_storage_bounded
  CHECK (octet_length(state::text) <= 8388608);

CREATE TABLE IF NOT EXISTS public.flow_action_storage_quotas (
  call_id uuid PRIMARY KEY REFERENCES public.calls(id) ON DELETE CASCADE,
  receipt_count integer NOT NULL DEFAULT 0
    CHECK (receipt_count BETWEEN 0 AND 512),
  argument_bytes bigint NOT NULL DEFAULT 0 CHECK (argument_bytes >= 0),
  result_bytes bigint NOT NULL DEFAULT 0 CHECK (result_bytes >= 0),
  error_bytes bigint NOT NULL DEFAULT 0 CHECK (error_bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT flow_action_storage_total_bounded
    CHECK (argument_bytes + result_bytes + error_bytes <= 8388608)
);
ALTER TABLE public.flow_action_storage_quotas
  ADD COLUMN IF NOT EXISTS error_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE public.flow_action_storage_quotas
  DROP CONSTRAINT IF EXISTS flow_action_storage_total_bounded;
ALTER TABLE public.flow_action_storage_quotas
  ADD CONSTRAINT flow_action_storage_total_bounded
  CHECK (
    argument_bytes >= 0 AND result_bytes >= 0 AND error_bytes >= 0
    AND argument_bytes + result_bytes + error_bytes <= 8388608
  );

-- Reapplication derives counters from the immutable ledger instead of trusting
-- mutable bookkeeping. Exact replays perform no row mutation and consume zero.
INSERT INTO public.flow_action_storage_quotas
  (call_id, receipt_count, argument_bytes, result_bytes, error_bytes, updated_at)
SELECT
  call_id,
  count(*)::integer,
  sum(octet_length(arguments::text))::bigint,
  sum(COALESCE(octet_length(result::text), 0))::bigint,
  sum(COALESCE(octet_length(error::text), 0))::bigint,
  clock_timestamp()
FROM public.flow_action_receipts
GROUP BY call_id
ON CONFLICT (call_id) DO UPDATE
SET receipt_count = EXCLUDED.receipt_count,
    argument_bytes = EXCLUDED.argument_bytes,
    result_bytes = EXCLUDED.result_bytes,
    error_bytes = EXCLUDED.error_bytes,
    updated_at = clock_timestamp();

ALTER TABLE public.flow_action_storage_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_action_storage_quotas FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hacc_backend_all ON public.flow_action_storage_quotas;
CREATE POLICY hacc_backend_all ON public.flow_action_storage_quotas
  FOR ALL TO hacc_backend USING (false) WITH CHECK (false);
DO $flow_quota_owner_policy$
BEGIN
  DROP POLICY IF EXISTS hacc_migration_owner_all ON public.flow_action_storage_quotas;
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON public.flow_action_storage_quotas FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$flow_quota_owner_policy$;

REVOKE ALL ON public.flow_action_storage_quotas FROM PUBLIC;
DO $flow_quota_api_revokes$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'hacc_worker', 'hacc_backend'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.flow_action_storage_quotas FROM %I', api_role);
    END IF;
  END LOOP;
END
$flow_quota_api_revokes$;

CREATE OR REPLACE FUNCTION public.enforce_flow_action_storage_budget()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $flow_action_storage_budget$
DECLARE
  quota public.flow_action_storage_quotas%ROWTYPE;
  old_argument_bytes integer := 0;
  old_result_bytes integer := 0;
  old_error_bytes integer := 0;
  new_argument_bytes integer := 0;
  new_result_bytes integer := 0;
  new_error_bytes integer := 0;
  next_receipt_count integer;
  next_argument_bytes bigint;
  next_result_bytes bigint;
  next_error_bytes bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A direct receipt deletion must decrement the quota while its call is
    -- still authoritative. Locking the parent key prevents a concurrent call
    -- deletion from racing the existence check and quota update. During the
    -- call's own ON DELETE CASCADE the parent is already absent to this
    -- command, so leave accounting to the quota row's ON DELETE CASCADE
    -- instead of updating a child whose foreign key is being removed.
    PERFORM 1
    FROM public.calls
    WHERE id = OLD.call_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RETURN OLD;
    END IF;

    SELECT * INTO quota
    FROM public.flow_action_storage_quotas
    WHERE call_id = OLD.call_id
    FOR UPDATE;
    IF FOUND THEN
      UPDATE public.flow_action_storage_quotas
      SET receipt_count = receipt_count - 1,
          argument_bytes = argument_bytes - octet_length(OLD.arguments::text),
          result_bytes = result_bytes - COALESCE(octet_length(OLD.result::text), 0),
          error_bytes = error_bytes - COALESCE(octet_length(OLD.error::text), 0),
          updated_at = clock_timestamp()
      WHERE call_id = OLD.call_id;
    END IF;
    RETURN OLD;
  END IF;

  new_argument_bytes := octet_length(NEW.arguments::text);
  new_result_bytes := COALESCE(octet_length(NEW.result::text), 0);
  new_error_bytes := COALESCE(octet_length(NEW.error::text), 0);
  IF new_argument_bytes > 32768 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'flow_action_arguments_too_large';
  END IF;
  IF new_result_bytes > 65536 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'flow_action_result_too_large';
  END IF;
  IF new_error_bytes > 16384 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'flow_action_error_too_large';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.call_id IS DISTINCT FROM OLD.call_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'flow_action_call_authority_immutable';
  END IF;

  INSERT INTO public.flow_action_storage_quotas(call_id)
  VALUES (NEW.call_id)
  ON CONFLICT (call_id) DO NOTHING;
  SELECT * INTO STRICT quota
  FROM public.flow_action_storage_quotas
  WHERE call_id = NEW.call_id
  FOR UPDATE;

  IF TG_OP = 'UPDATE' THEN
    old_argument_bytes := octet_length(OLD.arguments::text);
    old_result_bytes := COALESCE(octet_length(OLD.result::text), 0);
    old_error_bytes := COALESCE(octet_length(OLD.error::text), 0);
  END IF;
  next_receipt_count := quota.receipt_count + CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE 0 END;
  next_argument_bytes := quota.argument_bytes + new_argument_bytes - old_argument_bytes;
  next_result_bytes := quota.result_bytes + new_result_bytes - old_result_bytes;
  next_error_bytes := quota.error_bytes + new_error_bytes - old_error_bytes;

  IF next_receipt_count > 512 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'flow_action_receipt_quota_exceeded';
  END IF;
  IF next_argument_bytes + next_result_bytes + next_error_bytes > 8388608 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'flow_action_storage_quota_exceeded';
  END IF;

  UPDATE public.flow_action_storage_quotas
  SET receipt_count = next_receipt_count,
      argument_bytes = next_argument_bytes,
      result_bytes = next_result_bytes,
      error_bytes = next_error_bytes,
      updated_at = clock_timestamp()
  WHERE call_id = NEW.call_id;
  RETURN NEW;
END
$flow_action_storage_budget$;

DROP TRIGGER IF EXISTS trg_00_flow_action_storage_budget
  ON public.flow_action_receipts;
CREATE TRIGGER trg_00_flow_action_storage_budget
BEFORE INSERT OR UPDATE OR DELETE ON public.flow_action_receipts
FOR EACH ROW EXECUTE FUNCTION public.enforce_flow_action_storage_budget();

COMMENT ON TABLE public.flow_action_storage_quotas IS
  'Trigger-maintained per-call Flow v2 receipt count and byte budget; exact replays are free.';
COMMENT ON CONSTRAINT flow_run_hot_state_storage_bounded ON public.flow_runs IS
  'Caps the duplicated hot execution projection; the immutable receipt ledger remains replay authority.';

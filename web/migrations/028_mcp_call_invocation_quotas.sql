-- Atomic server-side admission limits for provider-native MCP tool calls.
-- Replays do not consume quota. Every fresh identity is bounded by a per-row,
-- per-minute, per-call count, and per-call cumulative persisted-byte ceiling.

DO $existing_receipt_limits$
DECLARE
  oversized uuid;
  over_budget uuid;
BEGIN
  SELECT id INTO oversized
  FROM public.mcp_tool_invocation_receipts
  WHERE octet_length(model_arguments::text) > 32768
     OR (result IS NOT NULL AND octet_length(result::text) > 65536)
  LIMIT 1;
  IF oversized IS NOT NULL THEN
    RAISE EXCEPTION 'cannot enable MCP quotas: receipt % exceeds a per-row storage ceiling', oversized;
  END IF;

  SELECT call_id INTO over_budget
  FROM public.mcp_tool_invocation_receipts
  GROUP BY call_id
  HAVING count(*) > 512
      OR sum(octet_length(model_arguments::text)) > 4194304
      OR sum(
        octet_length(model_arguments::text)
        + CASE WHEN status = 'executing' THEN 512 ELSE octet_length(result::text) END
      ) > 33554432
  LIMIT 1;
  IF over_budget IS NOT NULL THEN
    RAISE EXCEPTION 'cannot enable MCP quotas: call % exceeds the bounded receipt budget', over_budget;
  END IF;
END
$existing_receipt_limits$;

ALTER TABLE public.mcp_tool_invocation_receipts
  DROP CONSTRAINT IF EXISTS mcp_tool_invocation_model_arguments_bounded;
ALTER TABLE public.mcp_tool_invocation_receipts
  ADD CONSTRAINT mcp_tool_invocation_model_arguments_bounded
  CHECK (octet_length(model_arguments::text) <= 32768);
ALTER TABLE public.mcp_tool_invocation_receipts
  DROP CONSTRAINT IF EXISTS mcp_tool_invocation_result_bounded;
ALTER TABLE public.mcp_tool_invocation_receipts
  ADD CONSTRAINT mcp_tool_invocation_result_bounded
  CHECK (result IS NULL OR octet_length(result::text) <= 65536);

CREATE TABLE IF NOT EXISTS public.mcp_call_invocation_quotas (
  call_id uuid PRIMARY KEY REFERENCES public.calls(id) ON DELETE CASCADE,
  receipt_count integer NOT NULL DEFAULT 0
    CHECK (receipt_count BETWEEN 0 AND 512),
  model_argument_bytes bigint NOT NULL DEFAULT 0
    CHECK (model_argument_bytes BETWEEN 0 AND 4194304),
  result_bytes bigint NOT NULL DEFAULT 0
    CHECK (result_bytes BETWEEN 0 AND 33554432),
  window_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  window_count integer NOT NULL DEFAULT 0
    CHECK (window_count BETWEEN 0 AND 120),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.mcp_call_invocation_quotas
  ADD COLUMN IF NOT EXISTS result_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE public.mcp_call_invocation_quotas
  DROP CONSTRAINT IF EXISTS mcp_call_invocation_total_storage_bounded;
ALTER TABLE public.mcp_call_invocation_quotas
  ADD CONSTRAINT mcp_call_invocation_total_storage_bounded
  CHECK (
    result_bytes BETWEEN 0 AND 33554432
    AND model_argument_bytes + result_bytes <= 33554432
  );

-- Backfill and reapply from the append-only receipt ledger. Do not reset the
-- active rate window when this migration is deliberately reapplied.
INSERT INTO public.mcp_call_invocation_quotas
  (call_id, receipt_count, model_argument_bytes, result_bytes,
   window_started_at, window_count, updated_at)
SELECT call_id, count(*)::integer, sum(octet_length(model_arguments::text))::bigint,
       sum(CASE WHEN status = 'executing' THEN 512 ELSE octet_length(result::text) END)::bigint,
       clock_timestamp(), 0, clock_timestamp()
FROM public.mcp_tool_invocation_receipts
GROUP BY call_id
ON CONFLICT (call_id) DO UPDATE
SET receipt_count = EXCLUDED.receipt_count,
    model_argument_bytes = EXCLUDED.model_argument_bytes,
    result_bytes = EXCLUDED.result_bytes,
    updated_at = clock_timestamp();

ALTER TABLE public.mcp_call_invocation_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_call_invocation_quotas FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hacc_backend_all ON public.mcp_call_invocation_quotas;
CREATE POLICY hacc_backend_all ON public.mcp_call_invocation_quotas
  FOR ALL TO hacc_backend USING (false) WITH CHECK (false);
DO $quota_owner_policy$
BEGIN
  DROP POLICY IF EXISTS hacc_migration_owner_all ON public.mcp_call_invocation_quotas;
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON public.mcp_call_invocation_quotas FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$quota_owner_policy$;

REVOKE ALL ON public.mcp_call_invocation_quotas FROM PUBLIC;
DO $quota_api_revokes$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'hacc_worker', 'hacc_backend'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.mcp_call_invocation_quotas FROM %I', api_role);
    END IF;
  END LOOP;
END
$quota_api_revokes$;

CREATE OR REPLACE FUNCTION public.admit_mcp_tool_invocation(
  p_id uuid,
  p_call_id uuid,
  p_provider_invocation_id text,
  p_logical_name text,
  p_model_arguments jsonb,
  p_model_arguments_hash text,
  p_active_catalog_digest text,
  p_active_catalog_epoch integer,
  p_owner_token uuid,
  p_lease_ms integer
)
RETURNS SETOF public.mcp_tool_invocation_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $quota_admission$
DECLARE
  quota public.mcp_call_invocation_quotas%ROWTYPE;
  existing_receipt public.mcp_tool_invocation_receipts%ROWTYPE;
  argument_bytes integer;
  now_at timestamptz := clock_timestamp();
BEGIN
  argument_bytes := octet_length(p_model_arguments::text);
  IF argument_bytes > 32768 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'mcp_tool_invocation_arguments_too_large';
  END IF;
  IF p_lease_ms < 1000 OR p_lease_ms > 120000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'mcp_tool_invocation_invalid_lease';
  END IF;

  INSERT INTO public.mcp_call_invocation_quotas(call_id)
  VALUES (p_call_id)
  ON CONFLICT (call_id) DO NOTHING;

  SELECT * INTO STRICT quota
  FROM public.mcp_call_invocation_quotas
  WHERE call_id = p_call_id
  FOR UPDATE;

  -- Exact replay is always available, even after a call has consumed its fresh
  -- identity or storage budget. The caller verifies every immutable binding.
  SELECT * INTO existing_receipt
  FROM public.mcp_tool_invocation_receipts
  WHERE call_id = p_call_id
    AND provider_invocation_id = p_provider_invocation_id;
  IF FOUND THEN
    RETURN NEXT existing_receipt;
    RETURN;
  END IF;

  IF quota.window_started_at <= now_at - interval '1 minute' THEN
    quota.window_started_at := now_at;
    quota.window_count := 0;
  END IF;
  IF quota.window_count >= 120 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'mcp_tool_invocation_rate_exceeded';
  END IF;
  IF quota.receipt_count >= 512
     OR quota.model_argument_bytes + argument_bytes > 4194304
     OR quota.model_argument_bytes + argument_bytes + quota.result_bytes + 512 > 33554432 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'mcp_tool_invocation_quota_exceeded';
  END IF;

  UPDATE public.mcp_call_invocation_quotas
  SET receipt_count = quota.receipt_count + 1,
      model_argument_bytes = quota.model_argument_bytes + argument_bytes,
      result_bytes = quota.result_bytes + 512,
      window_started_at = quota.window_started_at,
      window_count = quota.window_count + 1,
      updated_at = now_at
  WHERE call_id = p_call_id;

  INSERT INTO public.mcp_tool_invocation_receipts
    (id, call_id, provider_invocation_id, logical_name, model_arguments,
     model_arguments_hash, active_catalog_digest, active_catalog_epoch,
     status, owner_token, lease_expires_at)
  VALUES
    (p_id, p_call_id, p_provider_invocation_id, p_logical_name, p_model_arguments,
     p_model_arguments_hash, p_active_catalog_digest, p_active_catalog_epoch,
     'executing', p_owner_token, now_at + (p_lease_ms * interval '1 millisecond'))
  RETURNING * INTO STRICT existing_receipt;

  RETURN NEXT existing_receipt;
END
$quota_admission$;

CREATE OR REPLACE FUNCTION public.settle_mcp_tool_invocation(
  p_id uuid,
  p_owner_token uuid,
  p_status text,
  p_result jsonb,
  p_result_hash text,
  p_require_expired boolean DEFAULT false
)
RETURNS SETOF public.mcp_tool_invocation_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $quota_settlement$
DECLARE
  quota public.mcp_call_invocation_quotas%ROWTYPE;
  receipt public.mcp_tool_invocation_receipts%ROWTYPE;
  result_size integer;
  result_delta bigint;
BEGIN
  IF p_status NOT IN ('completed', 'indeterminate')
     OR p_result_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'mcp_tool_invocation_invalid_settlement';
  END IF;
  result_size := octet_length(p_result::text);
  IF result_size > 65536 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'mcp_tool_invocation_result_too_large';
  END IF;

  SELECT * INTO receipt
  FROM public.mcp_tool_invocation_receipts
  WHERE id = p_id
  FOR UPDATE;
  IF NOT FOUND
     OR receipt.owner_token IS DISTINCT FROM p_owner_token
     OR receipt.status <> 'executing'
     OR (p_require_expired AND receipt.lease_expires_at > clock_timestamp()) THEN
    RETURN;
  END IF;

  SELECT * INTO STRICT quota
  FROM public.mcp_call_invocation_quotas
  WHERE call_id = receipt.call_id
  FOR UPDATE;
  result_delta := result_size - 512;
  IF quota.result_bytes + result_delta < 0
     OR quota.model_argument_bytes + quota.result_bytes + result_delta > 33554432 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'mcp_tool_invocation_result_quota_exceeded';
  END IF;

  UPDATE public.mcp_call_invocation_quotas
  SET result_bytes = quota.result_bytes + result_delta,
      updated_at = clock_timestamp()
  WHERE call_id = quota.call_id;

  UPDATE public.mcp_tool_invocation_receipts
  SET status = p_status,
      result = p_result,
      result_hash = p_result_hash,
      settled_at = clock_timestamp()
  WHERE id = receipt.id
  RETURNING * INTO STRICT receipt;
  RETURN NEXT receipt;
END
$quota_settlement$;

REVOKE ALL ON FUNCTION public.admit_mcp_tool_invocation(
  uuid, uuid, text, text, jsonb, text, text, integer, uuid, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_mcp_tool_invocation(
  uuid, uuid, text, jsonb, text, boolean
) FROM PUBLIC;
DO $quota_function_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    GRANT EXECUTE ON FUNCTION public.admit_mcp_tool_invocation(
      uuid, uuid, text, text, jsonb, text, text, integer, uuid, integer
    ) TO hacc_backend;
    GRANT EXECUTE ON FUNCTION public.settle_mcp_tool_invocation(
      uuid, uuid, text, jsonb, text, boolean
    ) TO hacc_backend;
  END IF;
END
$quota_function_grants$;

-- Runtime admission must cross the quota function. Settlement and replay may
-- still read/update the immutable receipt ledger.
REVOKE INSERT, UPDATE ON public.mcp_tool_invocation_receipts FROM PUBLIC;
DO $receipt_insert_revokes$
DECLARE
  runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'hacc_worker', 'hacc_backend'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format(
        'REVOKE INSERT, UPDATE ON public.mcp_tool_invocation_receipts FROM %I',
        runtime_role
      );
    END IF;
  END LOOP;
END
$receipt_insert_revokes$;

COMMENT ON TABLE public.mcp_call_invocation_quotas IS
  'Atomic per-call lifetime, rate-window, and cumulative argument-storage budget for provider-native MCP tool identities.';
COMMENT ON FUNCTION public.admit_mcp_tool_invocation(
  uuid, uuid, text, text, jsonb, text, text, integer, uuid, integer
) IS
  'Security-definer admission boundary: exact replay is free; each fresh identity is atomically charged before receipt insertion.';
COMMENT ON FUNCTION public.settle_mcp_tool_invocation(
  uuid, uuid, text, jsonb, text, boolean
) IS
  'Security-definer settlement boundary: replaces the reserved result allowance with exact persisted bytes under the same per-call cumulative cap.';

-- 016_operator_action_policy.sql — fail-closed authority, confirmation, quota, and replay ledger.

ALTER TABLE users ADD COLUMN IF NOT EXISTS operator_role text NOT NULL DEFAULT 'basic';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND conname = 'users_operator_role_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_operator_role_check
      CHECK (operator_role IN ('basic', 'operator', 'admin'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS operator_action_policies (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  capability text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  daily_action_limit integer NOT NULL,
  daily_spend_limit_micro_usd bigint NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, capability),
  CHECK (capability IN (
    'send_email', 'send_sms', 'place_call', 'schedule_call',
    'provision_phone_number', 'run_campaign'
  )),
  CHECK (daily_action_limit > 0 AND daily_action_limit <= 100000),
  CHECK (daily_spend_limit_micro_usd >= 0 AND daily_spend_limit_micro_usd <= 1000000000000)
);

CREATE TABLE IF NOT EXISTS operator_action_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_email text NOT NULL,
  capability text NOT NULL,
  idempotency_key text NOT NULL,
  arguments_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  estimated_units integer NOT NULL,
  estimated_micro_usd bigint NOT NULL,
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatch_started_at timestamptz,
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, capability, idempotency_key),
  CHECK (capability IN (
    'send_email', 'send_sms', 'place_call', 'schedule_call',
    'provision_phone_number', 'run_campaign'
  )),
  CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  CHECK (arguments_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (status IN ('reserved', 'dispatching', 'succeeded', 'indeterminate')),
  CHECK (estimated_units > 0 AND estimated_units <= 100000),
  CHECK (estimated_micro_usd >= 0 AND estimated_micro_usd <= 1000000000000),
  CHECK ((status = 'reserved') = (dispatch_started_at IS NULL)),
  CHECK ((status = 'succeeded') = (result IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'indeterminate')) = (settled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_operator_action_quota
  ON operator_action_executions(org_id, capability, created_at DESC);

ALTER TABLE operator_action_executions
  ADD COLUMN IF NOT EXISTS public_receipt jsonb,
  ADD COLUMN IF NOT EXISTS receipt_thread_id uuid;

CREATE OR REPLACE FUNCTION hacc_model_safe_operator_receipt(receipt jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $model_safe_operator_receipt$
  SELECT
    jsonb_typeof(receipt) = 'object'
    AND receipt->'schema_version' = '1'::jsonb
    AND jsonb_typeof(receipt->'capability') = 'string'
    AND receipt->>'capability' IN (
      'send_email', 'send_sms', 'place_call', 'schedule_call',
      'provision_phone_number', 'run_campaign'
    )
    AND jsonb_typeof(receipt->'status') = 'string'
    AND receipt->>'status' IN ('accepted','delivered','succeeded','rejected','indeterminate')
    AND (receipt - ARRAY[
      'schema_version','capability','status','code','accepted','segments',
      'call_id','provider_status','provider_code','scheduled','provisioned',
      'campaign_id','targets'
    ]::text[]) = '{}'::jsonb
    AND (
      NOT (receipt ? 'code')
      OR (
        jsonb_typeof(receipt->'code') = 'string'
        AND receipt->>'code' IN (
          'provider_outcome_indeterminate_do_not_retry',
          'action_already_reserved_or_indeterminate',
          'dispatch_ownership_lost',
          'operator_role_required',
          'capability_policy_required',
          'daily_quota_exceeded',
          'fresh_exact_confirmation_required',
          'approval_idempotency_mismatch',
          'idempotency_actor_conflict',
          'idempotency_conflict',
          'idempotency_approval_conflict',
          'action_reservation_failed',
          'confirmation_already_consumed',
          'action_policy_unavailable',
          'operator_action_denied',
          'authoritative_receipt_projection_failed_do_not_retry'
        )
      )
    )
    AND (NOT (receipt ? 'accepted') OR jsonb_typeof(receipt->'accepted') = 'boolean')
    AND (NOT (receipt ? 'scheduled') OR jsonb_typeof(receipt->'scheduled') = 'boolean')
    AND (NOT (receipt ? 'provisioned') OR jsonb_typeof(receipt->'provisioned') = 'boolean')
    AND (
      NOT (receipt ? 'segments')
      OR (
        jsonb_typeof(receipt->'segments') = 'number'
        AND receipt->>'segments' ~ '^[1-9][0-9]{0,2}$'
      )
    )
    AND (
      NOT (receipt ? 'targets')
      OR (
        jsonb_typeof(receipt->'targets') = 'number'
        AND receipt->>'targets' ~ '^[1-9][0-9]{0,3}$'
      )
    )
    AND (
      NOT (receipt ? 'call_id')
      OR (
        jsonb_typeof(receipt->'call_id') = 'string'
        AND receipt->>'call_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      )
    )
    AND (
      NOT (receipt ? 'campaign_id')
      OR (
        jsonb_typeof(receipt->'campaign_id') = 'string'
        AND receipt->>'campaign_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      )
    )
    AND (
      NOT (receipt ? 'provider_status')
      OR (
        jsonb_typeof(receipt->'provider_status') = 'string'
        AND receipt->>'provider_status' IN (
          'accepted','delivered','terminal_failure','failed','rejected'
        )
      )
    )
    AND (
      NOT (receipt ? 'provider_code')
      OR (
        jsonb_typeof(receipt->'provider_code') = 'string'
        AND receipt->>'provider_code' IN (
          'approved_runtime_changed_or_unavailable',
          'approved_parent_call_changed_or_unavailable',
          'immediate_call_not_materialized',
          'immediate_call_not_claimed',
          'pre_dispatch_rejected',
          'provider_rejected',
          'agent_unavailable_for_number_purchase',
          'scheduled_call_not_materialized',
          'provider_accepted',
          'provider_terminal_delivered',
          'provider_terminal_failure'
        )
      )
    );
$model_safe_operator_receipt$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_action_executions'::regclass
      AND conname = 'operator_action_executions_public_receipt_shape'
  ) THEN
    ALTER TABLE operator_action_executions
      ADD CONSTRAINT operator_action_executions_public_receipt_shape CHECK (
        (public_receipt IS NULL AND receipt_thread_id IS NULL)
        OR
        (public_receipt IS NOT NULL AND receipt_thread_id IS NOT NULL
         AND jsonb_typeof(public_receipt) = 'object'
         AND octet_length(public_receipt::text) <= 65536)
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_action_executions'::regclass
      AND conname = 'operator_action_executions_public_receipt_model_safe'
  ) THEN
    ALTER TABLE operator_action_executions
      ADD CONSTRAINT operator_action_executions_public_receipt_model_safe CHECK (
        public_receipt IS NULL OR hacc_model_safe_operator_receipt(public_receipt)
      ) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_action_executions'::regclass
      AND conname = 'operator_action_executions_public_receipt_terminal'
  ) THEN
    ALTER TABLE operator_action_executions
      ADD CONSTRAINT operator_action_executions_public_receipt_terminal CHECK (
        public_receipt IS NULL OR status IN ('succeeded', 'indeterminate')
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_action_executions'::regclass
      AND conname = 'operator_action_executions_id_org_unique'
  ) THEN
    ALTER TABLE operator_action_executions
      ADD CONSTRAINT operator_action_executions_id_org_unique UNIQUE (id, org_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_action_executions'::regclass
      AND conname = 'operator_action_executions_id_org_capability_unique'
  ) THEN
    ALTER TABLE operator_action_executions
      ADD CONSTRAINT operator_action_executions_id_org_capability_unique
      UNIQUE (id, org_id, capability);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.scheduled_calls'::regclass
      AND conname = 'scheduled_calls_operator_execution_binding'
  ) THEN
    ALTER TABLE scheduled_calls
      ADD CONSTRAINT scheduled_calls_operator_execution_binding
      FOREIGN KEY (operator_execution_id, org_id)
      REFERENCES operator_action_executions(id, org_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS phone_number_provisioning_execution_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agents'::regclass
      AND conname = 'agents_phone_number_provisioning_execution_fk'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_phone_number_provisioning_execution_fk
      FOREIGN KEY (phone_number_provisioning_execution_id, org_id)
      REFERENCES operator_action_executions(id, org_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_phone_number_provisioning_execution
  ON agents(phone_number_provisioning_execution_id)
  WHERE phone_number_provisioning_execution_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS operator_action_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_email text NOT NULL,
  thread_id uuid NOT NULL,
  capability text NOT NULL,
  action_arguments jsonb NOT NULL,
  private_display jsonb,
  arguments_sha256 text NOT NULL,
  estimated_units integer NOT NULL,
  estimated_micro_usd bigint NOT NULL,
  token_sha256 text UNIQUE,
  approved_by text,
  approved_at timestamptz,
  token_issued_at timestamptz,
  expires_at timestamptz NOT NULL,
  consumed_execution_id uuid UNIQUE REFERENCES operator_action_executions(id),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (capability IN (
    'send_email', 'send_sms', 'place_call', 'schedule_call',
    'provision_phone_number', 'run_campaign'
  )),
  CHECK (jsonb_typeof(action_arguments) = 'object'),
  CHECK (octet_length(action_arguments::text) <= 65536),
  CHECK (arguments_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (estimated_units > 0 AND estimated_units <= 100000),
  CHECK (estimated_micro_usd >= 0 AND estimated_micro_usd <= 1000000000000),
  CHECK (token_sha256 IS NULL OR token_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (
    (approved_by IS NULL AND approved_at IS NULL AND token_sha256 IS NULL AND token_issued_at IS NULL)
    OR
    (approved_by IS NOT NULL AND approved_at IS NOT NULL AND token_sha256 IS NOT NULL AND token_issued_at IS NOT NULL)
  ),
  CHECK ((consumed_execution_id IS NULL) = (consumed_at IS NULL)),
  CHECK (consumed_execution_id IS NULL OR approved_at IS NOT NULL),
  CHECK (expires_at > created_at)
);

-- Re-application against an early 016 draft must add the server-only display
-- payload without dropping any proposal or execution evidence.
ALTER TABLE operator_action_approvals
  ADD COLUMN IF NOT EXISTS private_display jsonb;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_action_approvals'::regclass
      AND conname = 'operator_action_approvals_private_display_valid'
  ) THEN
    ALTER TABLE operator_action_approvals
      ADD CONSTRAINT operator_action_approvals_private_display_valid
      CHECK (private_display IS NULL OR (
        jsonb_typeof(private_display) = 'object'
        AND octet_length(private_display::text) <= 262144
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_operator_action_approval_lookup
  ON operator_action_approvals(org_id, actor_email, thread_id, capability, token_sha256)
  WHERE consumed_execution_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_operator_action_pending_proposals
  ON operator_action_approvals(org_id, actor_email, thread_id, created_at DESC)
  WHERE approved_at IS NULL AND consumed_execution_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_operator_action_private_display_expiry
  ON operator_action_approvals(org_id, expires_at)
  WHERE private_display IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operator_action_private_display_sweep
  ON operator_action_approvals(expires_at)
  WHERE private_display IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_action_approvals'::regclass
      AND conname = 'operator_action_approvals_consumed_execution_tenant_binding'
  ) THEN
    ALTER TABLE operator_action_approvals
      ADD CONSTRAINT operator_action_approvals_consumed_execution_tenant_binding
      FOREIGN KEY (consumed_execution_id, org_id, capability)
      REFERENCES operator_action_executions(id, org_id, capability)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_action_approvals'::regclass
      AND conname = 'operator_action_approvals_consumed_display_scrubbed'
  ) THEN
    ALTER TABLE operator_action_approvals
      ADD CONSTRAINT operator_action_approvals_consumed_display_scrubbed
      CHECK (consumed_execution_id IS NULL OR private_display IS NULL);
  END IF;
END $$;

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS operator_execution_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.chat_messages'::regclass
      AND conname = 'chat_messages_operator_execution_tenant_binding'
  ) THEN
    ALTER TABLE chat_messages
      ADD CONSTRAINT chat_messages_operator_execution_tenant_binding
      FOREIGN KEY (operator_execution_id, org_id)
      REFERENCES operator_action_executions(id, org_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_operator_execution_once
  ON chat_messages(operator_execution_id)
  WHERE operator_execution_id IS NOT NULL;

CREATE OR REPLACE FUNCTION hacc_guard_operator_action_approval_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.actor_email IS DISTINCT FROM OLD.actor_email
     OR NEW.thread_id IS DISTINCT FROM OLD.thread_id
     OR NEW.capability IS DISTINCT FROM OLD.capability
     OR NEW.action_arguments IS DISTINCT FROM OLD.action_arguments
     OR NEW.arguments_sha256 IS DISTINCT FROM OLD.arguments_sha256
     OR NEW.estimated_units IS DISTINCT FROM OLD.estimated_units
     OR NEW.estimated_micro_usd IS DISTINCT FROM OLD.estimated_micro_usd
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'operator action proposal authority is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.private_display IS DISTINCT FROM OLD.private_display
     AND NOT (OLD.private_display IS NOT NULL AND NEW.private_display IS NULL) THEN
    RAISE EXCEPTION 'operator action private display may only be scrubbed' USING ERRCODE = '23514';
  END IF;
  IF OLD.approved_at IS NOT NULL AND (
       NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256
       OR NEW.token_issued_at IS DISTINCT FROM OLD.token_issued_at
     ) THEN
    RAISE EXCEPTION 'operator action approval authority is write-once' USING ERRCODE = '23514';
  END IF;
  IF OLD.consumed_execution_id IS NOT NULL AND (
       NEW.consumed_execution_id IS DISTINCT FROM OLD.consumed_execution_id
       OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
     ) THEN
    RAISE EXCEPTION 'operator action consumption is write-once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hacc_guard_operator_action_approval_update
  ON operator_action_approvals;
CREATE TRIGGER hacc_guard_operator_action_approval_update
  BEFORE UPDATE ON operator_action_approvals
  FOR EACH ROW EXECUTE FUNCTION hacc_guard_operator_action_approval_update();

CREATE OR REPLACE FUNCTION hacc_guard_operator_action_execution_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.actor_email IS DISTINCT FROM OLD.actor_email
     OR NEW.capability IS DISTINCT FROM OLD.capability
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.arguments_sha256 IS DISTINCT FROM OLD.arguments_sha256
     OR NEW.estimated_units IS DISTINCT FROM OLD.estimated_units
     OR NEW.estimated_micro_usd IS DISTINCT FROM OLD.estimated_micro_usd
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'operator action execution authority is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'reserved' AND NEW.status = 'dispatching')
       OR (OLD.status = 'dispatching' AND NEW.status IN ('succeeded', 'indeterminate'))
     ) THEN
    RAISE EXCEPTION 'invalid operator action execution transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.public_receipt IS NOT NULL AND NEW.public_receipt IS DISTINCT FROM OLD.public_receipt THEN
    RAISE EXCEPTION 'operator action public receipt is write-once' USING ERRCODE = '23514';
  END IF;
  IF OLD.receipt_thread_id IS NOT NULL AND NEW.receipt_thread_id IS DISTINCT FROM OLD.receipt_thread_id THEN
    RAISE EXCEPTION 'operator action receipt thread is write-once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hacc_guard_operator_action_execution_update
  ON operator_action_executions;
CREATE TRIGGER hacc_guard_operator_action_execution_update
  BEFORE UPDATE ON operator_action_executions
  FOR EACH ROW EXECUTE FUNCTION hacc_guard_operator_action_execution_update();

-- These are control-plane authority tables, never tenant-data APIs. Migration
-- 013 creates the NOLOGIN application roles before this migration runs. FORCE
-- keeps the table owner inside policy evaluation as well.
ALTER TABLE operator_action_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_action_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE operator_action_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_action_executions FORCE ROW LEVEL SECURITY;
ALTER TABLE operator_action_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_action_approvals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operator_action_policies_backend_all ON operator_action_policies;
DROP POLICY IF EXISTS hacc_backend_all ON operator_action_policies;
CREATE POLICY hacc_backend_all ON operator_action_policies
  FOR ALL TO hacc_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS operator_action_executions_backend_all ON operator_action_executions;
DROP POLICY IF EXISTS hacc_backend_all ON operator_action_executions;
CREATE POLICY hacc_backend_all ON operator_action_executions
  FOR ALL TO hacc_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS hacc_worker_operator_execution_select ON operator_action_executions;
CREATE POLICY hacc_worker_operator_execution_select ON operator_action_executions
  FOR SELECT TO hacc_worker
  USING (
    capability IN ('schedule_call', 'run_campaign')
    AND status IN ('reserved', 'dispatching', 'succeeded', 'indeterminate')
  );

DROP POLICY IF EXISTS operator_action_approvals_backend_all ON operator_action_approvals;
DROP POLICY IF EXISTS hacc_backend_all ON operator_action_approvals;
CREATE POLICY hacc_backend_all ON operator_action_approvals
  FOR ALL TO hacc_backend USING (true) WITH CHECK (true);

-- FORCE RLS also applies to an ordinary migration owner. Keep only that exact
-- owner able to perform future constrained backfills; no login role inherits it.
DROP POLICY IF EXISTS hacc_migration_owner_all ON operator_action_policies;
DROP POLICY IF EXISTS hacc_migration_owner_all ON operator_action_executions;
DROP POLICY IF EXISTS hacc_migration_owner_all ON operator_action_approvals;
DO $body$
BEGIN
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON public.operator_action_policies FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON public.operator_action_executions FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON public.operator_action_approvals FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$body$;

REVOKE ALL ON operator_action_policies FROM PUBLIC;
REVOKE ALL ON operator_action_executions FROM PUBLIC;
REVOKE ALL ON operator_action_approvals FROM PUBLIC;
REVOKE ALL ON operator_action_policies FROM hacc_worker;
REVOKE ALL ON operator_action_executions FROM hacc_worker;
REVOKE ALL ON operator_action_approvals FROM hacc_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON operator_action_policies TO hacc_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON operator_action_executions TO hacc_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON operator_action_approvals TO hacc_backend;
GRANT SELECT (id, org_id, capability, status, arguments_sha256,
              estimated_units, estimated_micro_usd)
  ON operator_action_executions TO hacc_worker;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON operator_action_policies FROM anon;
    REVOKE ALL ON operator_action_executions FROM anon;
    REVOKE ALL ON operator_action_approvals FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON operator_action_policies FROM authenticated;
    REVOKE ALL ON operator_action_executions FROM authenticated;
    REVOKE ALL ON operator_action_approvals FROM authenticated;
  END IF;
END $$;

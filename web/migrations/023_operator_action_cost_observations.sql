-- Append-only cost evidence for funded operator actions.
-- Approval-time amounts are reservations, never claims of provider-reported cost.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS operator_action_cost_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  operator_execution_id uuid NOT NULL,
  scheduled_call_id uuid,
  provider text NOT NULL,
  provider_effect_id text NOT NULL,
  channel text NOT NULL,
  coverage text NOT NULL,
  currency text NOT NULL,
  amount_micro_usd bigint NOT NULL,
  observed_units integer,
  evidence jsonb NOT NULL,
  evidence_sha256 text NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_action_cost_observations_execution_fk
    FOREIGN KEY (operator_execution_id, org_id)
    REFERENCES operator_action_executions(id, org_id)
    ON DELETE RESTRICT,
  CONSTRAINT operator_action_cost_observations_call_fk
    FOREIGN KEY (scheduled_call_id)
    REFERENCES scheduled_calls(id)
    ON DELETE RESTRICT,
  CONSTRAINT operator_action_cost_observations_provider_valid
    CHECK (provider IN ('operator_config', 'twilio', 'resend')),
  CONSTRAINT operator_action_cost_observations_channel_valid
    CHECK (channel IN ('reservation', 'provider_reported', 'reconciled')),
  CONSTRAINT operator_action_cost_observations_coverage_valid
    CHECK (coverage IN (
      'email_send', 'sms_transport', 'voice_connectivity',
      'phone_number_month', 'campaign_voice_connectivity'
    )),
  CONSTRAINT operator_action_cost_observations_currency_valid
    CHECK (currency = 'USD'),
  CONSTRAINT operator_action_cost_observations_amount_valid
    CHECK (amount_micro_usd BETWEEN 0 AND 1000000000000),
  CONSTRAINT operator_action_cost_observations_units_valid
    CHECK (observed_units IS NULL OR observed_units BETWEEN 0 AND 100000),
  CONSTRAINT operator_action_cost_observations_effect_id_valid
    CHECK (length(provider_effect_id) BETWEEN 1 AND 128),
  CONSTRAINT operator_action_cost_observations_evidence_valid
    CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 65536),
  CONSTRAINT operator_action_cost_observations_evidence_sha256_valid
    CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT operator_action_cost_observations_call_scope_valid
    CHECK (
      (channel = 'reservation' AND scheduled_call_id IS NULL)
      OR (
        channel IN ('provider_reported', 'reconciled')
        AND (
          (coverage IN ('voice_connectivity', 'campaign_voice_connectivity')
           AND scheduled_call_id IS NOT NULL)
          OR
          (coverage NOT IN ('voice_connectivity', 'campaign_voice_connectivity')
           AND scheduled_call_id IS NULL)
        )
      )
    ),
  UNIQUE (org_id, operator_execution_id, provider_effect_id, channel, evidence_sha256)
);

-- An early 023 draft allowed provider voice evidence without a call binding.
-- Preserve any such historical row as non-authoritative evidence, but enforce
-- the corrected boundary for every new insert. The summary below excludes any
-- legacy row which cannot meet this exact scope predicate.
ALTER TABLE operator_action_cost_observations
  DROP CONSTRAINT IF EXISTS operator_action_cost_observations_call_scope_valid;
ALTER TABLE operator_action_cost_observations
  ADD CONSTRAINT operator_action_cost_observations_call_scope_valid CHECK (
    (channel = 'reservation' AND scheduled_call_id IS NULL)
    OR (
      channel IN ('provider_reported', 'reconciled')
      AND (
        (coverage IN ('voice_connectivity', 'campaign_voice_connectivity')
         AND scheduled_call_id IS NOT NULL)
        OR
        (coverage NOT IN ('voice_connectivity', 'campaign_voice_connectivity')
         AND scheduled_call_id IS NULL)
      )
    )
  ) NOT VALID;
DO $operator_cost_call_scope_validation$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM operator_action_cost_observations
    WHERE NOT (
      (channel = 'reservation' AND scheduled_call_id IS NULL)
      OR (
        channel IN ('provider_reported', 'reconciled')
        AND (
          (coverage IN ('voice_connectivity', 'campaign_voice_connectivity')
           AND scheduled_call_id IS NOT NULL)
          OR
          (coverage NOT IN ('voice_connectivity', 'campaign_voice_connectivity')
           AND scheduled_call_id IS NULL)
        )
      )
    )
  ) THEN
    ALTER TABLE operator_action_cost_observations
      VALIDATE CONSTRAINT operator_action_cost_observations_call_scope_valid;
  END IF;
END
$operator_cost_call_scope_validation$;

CREATE INDEX IF NOT EXISTS idx_operator_action_cost_observations_execution
  ON operator_action_cost_observations(org_id, operator_execution_id, observed_at, id);
CREATE INDEX IF NOT EXISTS idx_operator_action_cost_observations_unreconciled_call
  ON operator_action_cost_observations(scheduled_call_id, channel)
  WHERE scheduled_call_id IS NOT NULL;

COMMENT ON TABLE operator_action_cost_observations IS
  'Append-only evidence. reservation is an approved ceiling; provider_reported is an asynchronous provider amount; reconciled is a final coverage total.';
COMMENT ON COLUMN operator_action_cost_observations.amount_micro_usd IS
  'Nonnegative micro-USD. Provider APIs commonly return charges as negative decimals; callers normalize the magnitude before insertion.';

ALTER TABLE operator_action_cost_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_action_cost_observations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hacc_backend_all ON operator_action_cost_observations;
CREATE POLICY hacc_backend_all ON operator_action_cost_observations
  FOR ALL TO hacc_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS hacc_migration_owner_all ON operator_action_cost_observations;
DO $operator_cost_owner_policy$
BEGIN
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON public.operator_action_cost_observations '
    'FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$operator_cost_owner_policy$;

CREATE OR REPLACE FUNCTION reject_operator_action_cost_observation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $immutable_operator_cost$
BEGIN
  RAISE EXCEPTION 'operator action cost evidence is append-only';
END
$immutable_operator_cost$;

DROP TRIGGER IF EXISTS trg_operator_action_cost_observation_immutable
  ON operator_action_cost_observations;
CREATE TRIGGER trg_operator_action_cost_observation_immutable
BEFORE UPDATE OR DELETE ON operator_action_cost_observations
FOR EACH ROW EXECUTE FUNCTION reject_operator_action_cost_observation_mutation();

CREATE OR REPLACE FUNCTION validate_operator_action_cost_observation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $validate_operator_cost$
DECLARE
  execution record;
  scheduled record;
BEGIN
  SELECT capability, estimated_units, estimated_micro_usd
  INTO execution
  FROM operator_action_executions
  WHERE id = NEW.operator_execution_id AND org_id = NEW.org_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator execution cost authority is unavailable';
  END IF;

  IF NEW.channel = 'reservation' THEN
    IF NEW.provider <> 'operator_config'
       OR NEW.provider_effect_id <> NEW.operator_execution_id::text
       OR NEW.scheduled_call_id IS NOT NULL
       OR NEW.amount_micro_usd <> execution.estimated_micro_usd
       OR NEW.observed_units <> execution.estimated_units THEN
      RAISE EXCEPTION 'reservation observation does not match operator authority';
    END IF;
  ELSE
    IF NEW.provider = 'operator_config' THEN
      RAISE EXCEPTION 'provider or reconciled cost cannot use operator_config provenance';
    END IF;
    IF NEW.coverage IN ('voice_connectivity', 'campaign_voice_connectivity')
       AND NEW.scheduled_call_id IS NULL THEN
      RAISE EXCEPTION 'call-scoped cost evidence requires exact scheduled call binding';
    END IF;
    IF NEW.coverage NOT IN ('voice_connectivity', 'campaign_voice_connectivity')
       AND NEW.scheduled_call_id IS NOT NULL THEN
      RAISE EXCEPTION 'non-call cost evidence cannot claim a scheduled call binding';
    END IF;
    IF NEW.scheduled_call_id IS NOT NULL THEN
      SELECT operator_execution_id, org_id
      INTO scheduled
      FROM scheduled_calls
      WHERE id = NEW.scheduled_call_id AND org_id = NEW.org_id
      FOR SHARE;
      IF NOT FOUND OR scheduled.operator_execution_id <> NEW.operator_execution_id THEN
        RAISE EXCEPTION 'cost observation call is not bound to this execution';
      END IF;
    END IF;
  END IF;

  IF NEW.evidence_sha256 <> encode(digest(NEW.evidence::text, 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'cost evidence digest mismatch';
  END IF;
  RETURN NEW;
END
$validate_operator_cost$;

DROP TRIGGER IF EXISTS trg_operator_action_cost_observation_validate_insert
  ON operator_action_cost_observations;
CREATE TRIGGER trg_operator_action_cost_observation_validate_insert
BEFORE INSERT ON operator_action_cost_observations
FOR EACH ROW EXECUTE FUNCTION validate_operator_action_cost_observation_insert();

-- One provider effect may be observed repeatedly while its asynchronous price
-- settles. Each channel therefore contributes only the largest amount ever
-- observed for that exact effect/binding; effects are then summed. This is
-- revision-order independent, avoids double-counting cumulative updates, and
-- still counts every distinct call in a campaign. Invalid unbound rows from an
-- early 023 draft are intentionally excluded from authoritative accounting.
CREATE OR REPLACE VIEW operator_action_cost_summary
WITH (security_invoker = true) AS
WITH effect_channel_amounts AS (
  SELECT
    observation.org_id,
    observation.operator_execution_id,
    observation.provider,
    observation.provider_effect_id,
    observation.coverage,
    observation.scheduled_call_id,
    observation.channel,
    max(observation.amount_micro_usd)::bigint AS amount_micro_usd
  FROM operator_action_cost_observations observation
  WHERE observation.channel IN ('provider_reported', 'reconciled')
    AND (
      (observation.coverage IN ('voice_connectivity', 'campaign_voice_connectivity')
       AND observation.scheduled_call_id IS NOT NULL)
      OR
      (observation.coverage NOT IN ('voice_connectivity', 'campaign_voice_connectivity')
       AND observation.scheduled_call_id IS NULL)
    )
  GROUP BY
    observation.org_id,
    observation.operator_execution_id,
    observation.provider,
    observation.provider_effect_id,
    observation.coverage,
    observation.scheduled_call_id,
    observation.channel
), execution_cost_totals AS (
  SELECT
    effect.org_id,
    effect.operator_execution_id,
    COALESCE(sum(effect.amount_micro_usd)
      FILTER (WHERE effect.channel = 'provider_reported'), 0)::bigint
      AS provider_reported_micro_usd,
    sum(effect.amount_micro_usd)
      FILTER (WHERE effect.channel = 'reconciled')::bigint
      AS reconciled_micro_usd
  FROM effect_channel_amounts effect
  GROUP BY effect.org_id, effect.operator_execution_id
)
SELECT
  execution.org_id,
  execution.id AS operator_execution_id,
  execution.capability,
  execution.estimated_micro_usd AS reserved_micro_usd,
  COALESCE(total.provider_reported_micro_usd, 0)::bigint AS provider_reported_micro_usd,
  total.reconciled_micro_usd,
  GREATEST(
    execution.estimated_micro_usd,
    COALESCE(total.provider_reported_micro_usd, 0),
    COALESCE(total.reconciled_micro_usd, 0)
  )::bigint AS conservative_accounted_micro_usd
FROM operator_action_executions execution
LEFT JOIN execution_cost_totals total
  ON total.operator_execution_id = execution.id
 AND total.org_id = execution.org_id;

REVOKE ALL ON operator_action_cost_observations FROM PUBLIC;
REVOKE ALL ON operator_action_cost_observations FROM hacc_worker;
GRANT SELECT, INSERT ON operator_action_cost_observations TO hacc_backend;

REVOKE ALL ON operator_action_cost_summary FROM PUBLIC;
REVOKE ALL ON operator_action_cost_summary FROM hacc_worker;
GRANT SELECT ON operator_action_cost_summary TO hacc_backend;

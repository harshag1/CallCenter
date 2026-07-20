-- Durable, bounded quarantine for campaign effects whose provider outcome is unknown.
-- Unknown scheduled calls remain terminally indeterminate and are never requeued.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $campaign_org_identity$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.campaigns'::regclass
      AND conname = 'campaigns_id_org_unique'
  ) THEN
    ALTER TABLE campaigns
      ADD CONSTRAINT campaigns_id_org_unique UNIQUE (id, org_id);
  END IF;
END
$campaign_org_identity$;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS indeterminate_at timestamptz;

UPDATE campaigns
SET indeterminate_at = now()
WHERE status = 'indeterminate' AND indeterminate_at IS NULL;

DO $campaign_indeterminate_time$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.campaigns'::regclass
      AND conname = 'campaigns_indeterminate_time_valid'
  ) THEN
    ALTER TABLE campaigns
      ADD CONSTRAINT campaigns_indeterminate_time_valid
      CHECK (status <> 'indeterminate' OR indeterminate_at IS NOT NULL)
      NOT VALID;
    ALTER TABLE campaigns VALIDATE CONSTRAINT campaigns_indeterminate_time_valid;
  END IF;
END
$campaign_indeterminate_time$;

CREATE INDEX IF NOT EXISTS idx_campaigns_indeterminate_age
  ON campaigns(indeterminate_at, id)
  WHERE status = 'indeterminate';

CREATE INDEX IF NOT EXISTS idx_scheduled_calls_post_boundary_orphans
  ON scheduled_calls(claim_lease_expires_at, dispatch_started_at, id)
  WHERE status = 'dialing' AND dispatch_started_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS campaign_dispatch_reconciliations (
  campaign_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  outcome text NOT NULL,
  reason_code text NOT NULL,
  indeterminate_job_count integer NOT NULL,
  provider_identity_job_count integer NOT NULL,
  evidence_sha256 text NOT NULL,
  indeterminate_at timestamptz NOT NULL,
  quarantine_not_before timestamptz NOT NULL,
  oldest_dispatch_started_at timestamptz NOT NULL,
  newest_dispatch_started_at timestamptz NOT NULL,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_dispatch_reconciliations_campaign_fk
    FOREIGN KEY (campaign_id, org_id)
    REFERENCES campaigns(id, org_id)
    ON DELETE RESTRICT,
  CONSTRAINT campaign_dispatch_reconciliations_outcome_valid
    CHECK (outcome = 'quarantined_unknown_effects'),
  CONSTRAINT campaign_dispatch_reconciliations_reason_valid
    CHECK (reason_code = 'stale_indeterminate_external_effect'),
  CONSTRAINT campaign_dispatch_reconciliations_counts_valid
    CHECK (
      indeterminate_job_count BETWEEN 1 AND 100000
      AND provider_identity_job_count BETWEEN 0 AND indeterminate_job_count
    ),
  CONSTRAINT campaign_dispatch_reconciliations_evidence_sha256_valid
    CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT campaign_dispatch_reconciliations_time_order_valid
    CHECK (
      oldest_dispatch_started_at <= newest_dispatch_started_at
      AND quarantine_not_before = GREATEST(indeterminate_at, newest_dispatch_started_at) + interval '24 hours'
      AND quarantine_not_before <= reconciled_at
    )
);

CREATE INDEX IF NOT EXISTS idx_campaign_dispatch_reconciliations_org_time
  ON campaign_dispatch_reconciliations(org_id, reconciled_at DESC, campaign_id);

COMMENT ON TABLE campaign_dispatch_reconciliations IS
  'Append-only, recipient-free evidence that stale unknown campaign effects were quarantined without redispatch.';
COMMENT ON COLUMN campaign_dispatch_reconciliations.evidence_sha256 IS
  'SHA-256 over sorted scheduled-call, local-call, provider-identity, runtime, and boundary facts; destinations are excluded.';

ALTER TABLE campaign_dispatch_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_dispatch_reconciliations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hacc_backend_all ON campaign_dispatch_reconciliations;
CREATE POLICY hacc_backend_all ON campaign_dispatch_reconciliations
  FOR ALL TO hacc_backend USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS hacc_migration_owner_all ON campaign_dispatch_reconciliations;
DO $campaign_reconciliation_owner_policy$
BEGIN
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON public.campaign_dispatch_reconciliations '
    'FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$campaign_reconciliation_owner_policy$;

CREATE OR REPLACE FUNCTION reject_campaign_dispatch_reconciliation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $immutable_reconciliation$
BEGIN
  RAISE EXCEPTION 'campaign dispatch reconciliation evidence is append-only';
END
$immutable_reconciliation$;

DROP TRIGGER IF EXISTS trg_campaign_dispatch_reconciliation_immutable
  ON campaign_dispatch_reconciliations;
CREATE TRIGGER trg_campaign_dispatch_reconciliation_immutable
BEFORE UPDATE OR DELETE ON campaign_dispatch_reconciliations
FOR EACH ROW EXECUTE FUNCTION reject_campaign_dispatch_reconciliation_mutation();

-- Even the trusted backend cannot fabricate an unlock receipt. Reconstruct
-- every non-recipient fact under campaign -> scheduled-call locks, enforce the
-- fixed safety window, and overwrite all caller-supplied evidence fields.
CREATE OR REPLACE FUNCTION validate_campaign_dispatch_reconciliation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $validate_reconciliation$
DECLARE
  campaign_state record;
  evidence record;
BEGIN
  SELECT campaign.id, campaign.org_id, campaign.status, campaign.indeterminate_at
  INTO campaign_state
  FROM campaigns campaign
  WHERE campaign.id = NEW.campaign_id AND campaign.org_id = NEW.org_id
  FOR UPDATE;

  IF NOT FOUND OR campaign_state.status <> 'indeterminate'
     OR campaign_state.indeterminate_at IS NULL THEN
    RAISE EXCEPTION 'campaign is not eligible for dispatch quarantine';
  END IF;

  PERFORM scheduled.id
  FROM scheduled_calls scheduled
  WHERE scheduled.campaign_id = campaign_state.id
    AND scheduled.org_id = campaign_state.org_id
  ORDER BY scheduled.id
  FOR UPDATE;

  SELECT
    count(*) FILTER (WHERE scheduled.status = 'indeterminate')::integer
      AS indeterminate_job_count,
    count(*) FILTER (WHERE scheduled.status IN ('pending', 'dialing'))::integer
      AS open_job_count,
    count(*) FILTER (
      WHERE scheduled.status = 'indeterminate'
        AND scheduled.dispatch_started_at > now() - interval '24 hours'
    )::integer AS fresh_indeterminate_job_count,
    count(*) FILTER (
      WHERE scheduled.status = 'indeterminate'
        AND local_call.twilio_call_sid IS NOT NULL
    )::integer AS provider_identity_job_count,
    min(scheduled.dispatch_started_at) FILTER (WHERE scheduled.status = 'indeterminate')
      AS oldest_dispatch_started_at,
    max(scheduled.dispatch_started_at) FILTER (WHERE scheduled.status = 'indeterminate')
      AS newest_dispatch_started_at,
    encode(digest(
      COALESCE(
        string_agg(
          concat_ws('|',
            scheduled.id::text,
            COALESCE(scheduled.completed_call_id::text, ''),
            COALESCE(local_call.twilio_account_sid, ''),
            COALESCE(local_call.twilio_call_sid, ''),
            COALESCE(local_call.twilio_status, ''),
            COALESCE(local_call.twilio_status_rank::text, ''),
            COALESCE(scheduled.runtime_digest, ''),
            to_char(
              scheduled.dispatch_started_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            )
          ),
          E'\n' ORDER BY scheduled.id
        ) FILTER (WHERE scheduled.status = 'indeterminate'),
        ''
      ),
      'sha256'
    ), 'hex') AS evidence_sha256
  INTO evidence
  FROM scheduled_calls scheduled
  LEFT JOIN calls local_call
    ON local_call.id = scheduled.completed_call_id
   AND local_call.scheduled_call_id = scheduled.id
   AND local_call.campaign_id = campaign_state.id
  WHERE scheduled.campaign_id = campaign_state.id
    AND scheduled.org_id = campaign_state.org_id;

  IF evidence.indeterminate_job_count < 1
     OR evidence.open_job_count <> 0
     OR evidence.fresh_indeterminate_job_count <> 0
     OR evidence.oldest_dispatch_started_at IS NULL
     OR evidence.newest_dispatch_started_at IS NULL
     OR GREATEST(campaign_state.indeterminate_at, evidence.newest_dispatch_started_at)
          > now() - interval '24 hours'
     OR EXISTS (
       SELECT 1 FROM calls local_call
       WHERE local_call.campaign_id = campaign_state.id
         AND local_call.status IN ('active', 'dialing')
     ) THEN
    RAISE EXCEPTION 'campaign dispatch ambiguity has not reached its quarantine boundary';
  END IF;

  NEW.outcome := 'quarantined_unknown_effects';
  NEW.reason_code := 'stale_indeterminate_external_effect';
  NEW.indeterminate_job_count := evidence.indeterminate_job_count;
  NEW.provider_identity_job_count := evidence.provider_identity_job_count;
  NEW.evidence_sha256 := evidence.evidence_sha256;
  NEW.indeterminate_at := campaign_state.indeterminate_at;
  NEW.quarantine_not_before :=
    GREATEST(campaign_state.indeterminate_at, evidence.newest_dispatch_started_at) + interval '24 hours';
  NEW.oldest_dispatch_started_at := evidence.oldest_dispatch_started_at;
  NEW.newest_dispatch_started_at := evidence.newest_dispatch_started_at;
  NEW.reconciled_at := now();
  RETURN NEW;
END
$validate_reconciliation$;

DROP TRIGGER IF EXISTS trg_campaign_dispatch_reconciliation_validate_insert
  ON campaign_dispatch_reconciliations;
CREATE TRIGGER trg_campaign_dispatch_reconciliation_validate_insert
BEFORE INSERT ON campaign_dispatch_reconciliations
FOR EACH ROW EXECUTE FUNCTION validate_campaign_dispatch_reconciliation_insert();

CREATE OR REPLACE FUNCTION enforce_campaign_indeterminate_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $campaign_indeterminate_transition$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'indeterminate' THEN
      NEW.indeterminate_at := COALESCE(NEW.indeterminate_at, now());
    ELSIF NEW.indeterminate_at IS NOT NULL THEN
      RAISE EXCEPTION 'indeterminate_at is reserved for indeterminate campaigns';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.indeterminate_at IS NOT NULL
     AND NEW.indeterminate_at IS DISTINCT FROM OLD.indeterminate_at THEN
    RAISE EXCEPTION 'campaign indeterminate_at is write-once';
  END IF;
  IF OLD.status = 'indeterminate'
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'an indeterminate campaign cannot be relabeled';
  END IF;
  IF NEW.status = 'indeterminate' AND OLD.status <> 'indeterminate' THEN
    NEW.indeterminate_at := now();
  END IF;

  RETURN NEW;
END
$campaign_indeterminate_transition$;

DROP TRIGGER IF EXISTS trg_campaign_indeterminate_transition ON campaigns;
CREATE TRIGGER trg_campaign_indeterminate_transition
BEFORE INSERT OR UPDATE ON campaigns
FOR EACH ROW EXECUTE FUNCTION enforce_campaign_indeterminate_transition();

-- The caller gets a bounded set of campaigns. Each campaign is locked first,
-- then all of its scheduled jobs are locked in stable order, matching the
-- campaign -> scheduled-call ordering used by provider admission. A second
-- eligibility check under those locks prevents a stale snapshot from
-- quarantining fresh work. No scheduled-call or provider identity is mutated.
CREATE OR REPLACE FUNCTION quarantine_stale_indeterminate_campaigns(batch_limit integer DEFAULT 25)
RETURNS TABLE (
  quarantined_campaign_id uuid,
  quarantined_org_id uuid,
  quarantine_evidence_sha256 text
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $quarantine_stale_campaigns$
DECLARE
  candidate record;
  evidence record;
  inserted_evidence_sha256 text;
BEGIN
  IF batch_limit < 1 OR batch_limit > 100 THEN
    RAISE EXCEPTION 'batch_limit must be between 1 and 100';
  END IF;

  FOR candidate IN
    SELECT campaign.id, campaign.org_id, campaign.indeterminate_at
    FROM campaigns campaign
    WHERE campaign.status = 'indeterminate'
      AND NOT EXISTS (
        SELECT 1 FROM campaign_dispatch_reconciliations reconciliation
        WHERE reconciliation.campaign_id = campaign.id
      )
      AND campaign.indeterminate_at <= now() - interval '24 hours'
      AND EXISTS (
        SELECT 1 FROM scheduled_calls scheduled
        WHERE scheduled.campaign_id = campaign.id
          AND scheduled.org_id = campaign.org_id
          AND scheduled.status = 'indeterminate'
          AND scheduled.dispatch_started_at <= now() - interval '24 hours'
      )
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_calls scheduled
        WHERE scheduled.campaign_id = campaign.id
          AND scheduled.org_id = campaign.org_id
          AND (
            scheduled.status IN ('pending', 'dialing')
            OR (
              scheduled.status = 'indeterminate'
              AND scheduled.dispatch_started_at > now() - interval '24 hours'
            )
          )
      )
      AND GREATEST(
        campaign.indeterminate_at,
        (
          SELECT max(scheduled.dispatch_started_at)
          FROM scheduled_calls scheduled
          WHERE scheduled.campaign_id = campaign.id
            AND scheduled.status = 'indeterminate'
        )
      ) <= now() - interval '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM calls local_call
        WHERE local_call.campaign_id = campaign.id
          AND local_call.status IN ('active', 'dialing')
      )
    ORDER BY (
      SELECT min(scheduled.dispatch_started_at)
      FROM scheduled_calls scheduled
      WHERE scheduled.campaign_id = campaign.id
        AND scheduled.status = 'indeterminate'
    ), campaign.id
    LIMIT batch_limit
    FOR UPDATE OF campaign SKIP LOCKED
  LOOP
    -- Terminal rows cannot change status under migration 013, but locking the
    -- full job set also makes the evidence boundary explicit and race-proof.
    PERFORM scheduled.id
    FROM scheduled_calls scheduled
    WHERE scheduled.campaign_id = candidate.id
      AND scheduled.org_id = candidate.org_id
    ORDER BY scheduled.id
    FOR UPDATE;

    SELECT
      count(*) FILTER (WHERE scheduled.status = 'indeterminate')::integer
        AS indeterminate_job_count,
      count(*) FILTER (WHERE scheduled.status IN ('pending', 'dialing'))::integer
        AS open_job_count,
      count(*) FILTER (
        WHERE scheduled.status = 'indeterminate'
          AND scheduled.dispatch_started_at > now() - interval '24 hours'
      )::integer AS fresh_indeterminate_job_count,
      count(*) FILTER (
        WHERE scheduled.status = 'indeterminate'
          AND local_call.twilio_call_sid IS NOT NULL
      )::integer AS provider_identity_job_count,
      min(scheduled.dispatch_started_at) FILTER (WHERE scheduled.status = 'indeterminate')
        AS oldest_dispatch_started_at,
      max(scheduled.dispatch_started_at) FILTER (WHERE scheduled.status = 'indeterminate')
        AS newest_dispatch_started_at,
      encode(digest(
        COALESCE(
          string_agg(
            concat_ws('|',
              scheduled.id::text,
              COALESCE(scheduled.completed_call_id::text, ''),
              COALESCE(local_call.twilio_account_sid, ''),
              COALESCE(local_call.twilio_call_sid, ''),
              COALESCE(local_call.twilio_status, ''),
              COALESCE(local_call.twilio_status_rank::text, ''),
              COALESCE(scheduled.runtime_digest, ''),
              to_char(
                scheduled.dispatch_started_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              )
            ),
            E'\n' ORDER BY scheduled.id
          ) FILTER (WHERE scheduled.status = 'indeterminate'),
          ''
        ),
        'sha256'
      ), 'hex') AS evidence_sha256
    INTO evidence
    FROM scheduled_calls scheduled
    LEFT JOIN calls local_call
      ON local_call.id = scheduled.completed_call_id
     AND local_call.scheduled_call_id = scheduled.id
     AND local_call.campaign_id = candidate.id
    WHERE scheduled.campaign_id = candidate.id
      AND scheduled.org_id = candidate.org_id;

    IF evidence.indeterminate_job_count < 1
       OR evidence.open_job_count <> 0
       OR evidence.fresh_indeterminate_job_count <> 0
       OR evidence.oldest_dispatch_started_at IS NULL
       OR evidence.newest_dispatch_started_at IS NULL
       OR candidate.indeterminate_at > now() - interval '24 hours'
       OR GREATEST(candidate.indeterminate_at, evidence.newest_dispatch_started_at)
            > now() - interval '24 hours'
       OR EXISTS (
         SELECT 1 FROM calls local_call
         WHERE local_call.campaign_id = candidate.id
           AND local_call.status IN ('active', 'dialing')
       ) THEN
      CONTINUE;
    END IF;

    inserted_evidence_sha256 := NULL;
    INSERT INTO campaign_dispatch_reconciliations (
      campaign_id,
      org_id,
      outcome,
      reason_code,
      indeterminate_job_count,
      provider_identity_job_count,
      evidence_sha256,
      indeterminate_at,
      quarantine_not_before,
      oldest_dispatch_started_at,
      newest_dispatch_started_at
    ) VALUES (
      candidate.id,
      candidate.org_id,
      'quarantined_unknown_effects',
      'stale_indeterminate_external_effect',
      evidence.indeterminate_job_count,
      evidence.provider_identity_job_count,
      evidence.evidence_sha256,
      candidate.indeterminate_at,
      GREATEST(candidate.indeterminate_at, evidence.newest_dispatch_started_at) + interval '24 hours',
      evidence.oldest_dispatch_started_at,
      evidence.newest_dispatch_started_at
    )
    ON CONFLICT (campaign_id) DO NOTHING
    RETURNING evidence_sha256 INTO inserted_evidence_sha256;

    IF inserted_evidence_sha256 IS NULL THEN
      CONTINUE;
    END IF;

    quarantined_campaign_id := candidate.id;
    quarantined_org_id := candidate.org_id;
    quarantine_evidence_sha256 := inserted_evidence_sha256;
    RETURN NEXT;
  END LOOP;
END
$quarantine_stale_campaigns$;

REVOKE ALL ON campaign_dispatch_reconciliations FROM PUBLIC;
REVOKE ALL ON campaign_dispatch_reconciliations FROM hacc_worker;
GRANT SELECT, INSERT ON campaign_dispatch_reconciliations TO hacc_backend;

REVOKE ALL ON FUNCTION quarantine_stale_indeterminate_campaigns(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION quarantine_stale_indeterminate_campaigns(integer) FROM hacc_worker;
GRANT EXECUTE ON FUNCTION quarantine_stale_indeterminate_campaigns(integer) TO hacc_backend;

DO $campaign_reconciliation_api_revokes$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.campaign_dispatch_reconciliations FROM %I', api_role);
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.quarantine_stale_indeterminate_campaigns(integer) FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$campaign_reconciliation_api_revokes$;

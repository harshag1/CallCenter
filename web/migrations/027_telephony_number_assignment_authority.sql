-- 027_telephony_number_assignment_authority.sql
-- Give each provider-facing phone number exactly one agent authority. Existing
-- invalid or ambiguous assignments are preserved in an immutable private audit
-- and every participant is disconnected; the migration never chooses a winner.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS hacc_private;

CREATE TABLE IF NOT EXISTS hacc_private.telephony_number_assignment_quarantines (
  incident_sha256 text PRIMARY KEY
    CHECK (incident_sha256 ~ '^[0-9a-f]{64}$'),
  agent_id uuid NOT NULL,
  org_id uuid NOT NULL,
  agent_created_at timestamptz NOT NULL,
  phone_number text NOT NULL,
  phone_number_sha256 text NOT NULL
    CHECK (phone_number_sha256 ~ '^[0-9a-f]{64}$'),
  assignment_sha256 text NOT NULL
    CHECK (assignment_sha256 ~ '^[0-9a-f]{64}$'),
  phone_number_provisioning_execution_id uuid,
  reason text NOT NULL CHECK (reason IN (
    'invalid_e164',
    'duplicate_assignment',
    'invalid_e164_and_duplicate_assignment'
  )),
  assignment_count integer NOT NULL CHECK (assignment_count >= 1),
  source_migration text NOT NULL
    CHECK (source_migration = '027_telephony_number_assignment_authority'),
  detected_at timestamptz NOT NULL,
  cleared_at timestamptz NOT NULL,
  CHECK (cleared_at >= detected_at),
  CHECK (
    ((phone_number COLLATE "C") SIMILAR TO '[+][1-9][0-9]{6,14}'
      AND assignment_count > 1
      AND reason = 'duplicate_assignment')
    OR
    ((phone_number COLLATE "C") NOT SIMILAR TO '[+][1-9][0-9]{6,14}'
      AND assignment_count = 1
      AND reason = 'invalid_e164')
    OR
    ((phone_number COLLATE "C") NOT SIMILAR TO '[+][1-9][0-9]{6,14}'
      AND assignment_count > 1
      AND reason = 'invalid_e164_and_duplicate_assignment')
  )
);

COMMENT ON TABLE hacc_private.telephony_number_assignment_quarantines IS
  'Append-only migration audit for provider-facing agent number assignments removed because they were invalid or ambiguous. No duplicate participant is selected as authoritative.';

ALTER TABLE hacc_private.telephony_number_assignment_quarantines ENABLE ROW LEVEL SECURITY;
ALTER TABLE hacc_private.telephony_number_assignment_quarantines FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hacc_backend_all
  ON hacc_private.telephony_number_assignment_quarantines;
CREATE POLICY hacc_backend_all
  ON hacc_private.telephony_number_assignment_quarantines
  FOR ALL TO hacc_backend USING (false) WITH CHECK (false);

DO $telephony_number_quarantine_owner_policy$
BEGIN
  DROP POLICY IF EXISTS hacc_migration_owner_all
    ON hacc_private.telephony_number_assignment_quarantines;
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all '
    'ON hacc_private.telephony_number_assignment_quarantines '
    'FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$telephony_number_quarantine_owner_policy$;

REVOKE ALL ON TABLE hacc_private.telephony_number_assignment_quarantines FROM PUBLIC;
REVOKE ALL ON TABLE hacc_private.telephony_number_assignment_quarantines FROM hacc_backend;
DO $telephony_number_quarantine_api_revokes$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'hacc_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format(
        'REVOKE ALL ON hacc_private.telephony_number_assignment_quarantines FROM %I',
        api_role
      );
    END IF;
  END LOOP;
END
$telephony_number_quarantine_api_revokes$;

CREATE OR REPLACE FUNCTION hacc_private.reject_telephony_number_quarantine_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $telephony_number_quarantine_immutable$
BEGIN
  RAISE EXCEPTION 'telephony number assignment quarantine is append-only';
END
$telephony_number_quarantine_immutable$;

REVOKE ALL ON FUNCTION hacc_private.reject_telephony_number_quarantine_mutation()
  FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_telephony_number_quarantine_immutable
  ON hacc_private.telephony_number_assignment_quarantines;
CREATE TRIGGER trg_telephony_number_quarantine_immutable
  BEFORE UPDATE OR DELETE
  ON hacc_private.telephony_number_assignment_quarantines
  FOR EACH ROW
  EXECUTE FUNCTION hacc_private.reject_telephony_number_quarantine_mutation();

DROP TRIGGER IF EXISTS trg_telephony_number_quarantine_no_truncate
  ON hacc_private.telephony_number_assignment_quarantines;
CREATE TRIGGER trg_telephony_number_quarantine_no_truncate
  BEFORE TRUNCATE
  ON hacc_private.telephony_number_assignment_quarantines
  FOR EACH STATEMENT
  EXECUTE FUNCTION hacc_private.reject_telephony_number_quarantine_mutation();

-- Freeze assignment writers while evidence is captured and authority is
-- removed. ACCESS EXCLUSIVE also makes constraint/index replacement atomic to
-- callers: they observe either the old state or the fully hardened state.
LOCK TABLE public.agents IN ACCESS EXCLUSIVE MODE;

WITH assignment_groups AS (
  SELECT
    phone_number,
    count(*)::integer AS assignment_count,
    array_agg(id ORDER BY id) AS assignment_agent_ids
  FROM public.agents
  WHERE phone_number IS NOT NULL
  GROUP BY phone_number
), candidates AS (
  SELECT
    agent.id AS agent_id,
    agent.org_id,
    agent.created_at AS agent_created_at,
    agent.phone_number,
    agent.phone_number_provisioning_execution_id,
    assignment_group.assignment_count,
    encode(digest(agent.phone_number, 'sha256'), 'hex') AS phone_number_sha256,
    encode(
      digest(to_jsonb(assignment_group.assignment_agent_ids)::text, 'sha256'),
      'hex'
    ) AS assignment_sha256,
    CASE
      WHEN (agent.phone_number COLLATE "C") NOT SIMILAR TO '[+][1-9][0-9]{6,14}'
        AND assignment_group.assignment_count > 1
        THEN 'invalid_e164_and_duplicate_assignment'
      WHEN (agent.phone_number COLLATE "C") NOT SIMILAR TO '[+][1-9][0-9]{6,14}'
        THEN 'invalid_e164'
      ELSE 'duplicate_assignment'
    END AS reason
  FROM public.agents agent
  JOIN assignment_groups assignment_group
    ON assignment_group.phone_number = agent.phone_number
  WHERE (agent.phone_number COLLATE "C") NOT SIMILAR TO '[+][1-9][0-9]{6,14}'
     OR assignment_group.assignment_count > 1
), evidence AS (
  SELECT
    candidate.*,
    transaction_timestamp() AS detected_at,
    encode(
      digest(
        jsonb_build_object(
          'agent_id', candidate.agent_id::text,
          'org_id', candidate.org_id::text,
          'agent_created_at', candidate.agent_created_at,
          'phone_number', candidate.phone_number,
          'phone_number_sha256', candidate.phone_number_sha256,
          'assignment_sha256', candidate.assignment_sha256,
          'phone_number_provisioning_execution_id',
            candidate.phone_number_provisioning_execution_id::text,
          'reason', candidate.reason,
          'assignment_count', candidate.assignment_count,
          'source_migration', '027_telephony_number_assignment_authority'
        )::text,
        'sha256'
      ),
      'hex'
    ) AS incident_sha256
  FROM candidates candidate
)
INSERT INTO hacc_private.telephony_number_assignment_quarantines (
  incident_sha256,
  agent_id,
  org_id,
  agent_created_at,
  phone_number,
  phone_number_sha256,
  assignment_sha256,
  phone_number_provisioning_execution_id,
  reason,
  assignment_count,
  source_migration,
  detected_at,
  cleared_at
)
SELECT
  evidence.incident_sha256,
  evidence.agent_id,
  evidence.org_id,
  evidence.agent_created_at,
  evidence.phone_number,
  evidence.phone_number_sha256,
  evidence.assignment_sha256,
  evidence.phone_number_provisioning_execution_id,
  evidence.reason,
  evidence.assignment_count,
  '027_telephony_number_assignment_authority',
  evidence.detected_at,
  evidence.detected_at
FROM evidence
ON CONFLICT (incident_sha256) DO NOTHING;

-- Clear every participant, including its in-flight provisioning reservation.
-- The original execution binding remains in the private evidence row so an
-- operator can reconcile an indeterminate provider purchase without restoring
-- ambiguous inbound-call authority.
WITH assignment_groups AS (
  SELECT phone_number, count(*)::integer AS assignment_count
  FROM public.agents
  WHERE phone_number IS NOT NULL
  GROUP BY phone_number
), candidates AS (
  SELECT
    agent.id,
    agent.org_id,
    agent.phone_number,
    agent.phone_number_provisioning_execution_id
  FROM public.agents agent
  JOIN assignment_groups assignment_group
    ON assignment_group.phone_number = agent.phone_number
  WHERE (agent.phone_number COLLATE "C") NOT SIMILAR TO '[+][1-9][0-9]{6,14}'
     OR assignment_group.assignment_count > 1
)
UPDATE public.agents agent
SET phone_number = NULL,
    phone_number_provisioning_execution_id = NULL
FROM candidates candidate
JOIN hacc_private.telephony_number_assignment_quarantines quarantine
  ON quarantine.agent_id = candidate.id
 AND quarantine.org_id = candidate.org_id
 AND quarantine.phone_number = candidate.phone_number
 AND quarantine.phone_number_provisioning_execution_id
       IS NOT DISTINCT FROM candidate.phone_number_provisioning_execution_id
WHERE agent.id = candidate.id
  AND agent.org_id = candidate.org_id
  AND agent.phone_number = candidate.phone_number
  AND agent.phone_number_provisioning_execution_id
        IS NOT DISTINCT FROM candidate.phone_number_provisioning_execution_id;

DO $telephony_number_assignment_cleanup_complete$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.agents
    WHERE phone_number IS NOT NULL
      AND (phone_number COLLATE "C") NOT SIMILAR TO '[+][1-9][0-9]{6,14}'
  ) OR EXISTS (
    SELECT 1
    FROM public.agents
    WHERE phone_number IS NOT NULL
    GROUP BY phone_number
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'telephony number assignment quarantine did not converge';
  END IF;
END
$telephony_number_assignment_cleanup_complete$;

-- Replace any early-draft object with the exact public-release authority
-- boundary. The table lock keeps this replacement invisible until commit.
ALTER TABLE public.agents
  DROP CONSTRAINT IF EXISTS agents_phone_number_e164_shape;
ALTER TABLE public.agents
  ADD CONSTRAINT agents_phone_number_e164_shape
  CHECK (
    phone_number IS NULL
    OR (phone_number COLLATE "C") SIMILAR TO '[+][1-9][0-9]{6,14}'
  );

DROP INDEX IF EXISTS public.uq_agents_phone_number_authority;
CREATE UNIQUE INDEX uq_agents_phone_number_authority
  ON public.agents (phone_number)
  WHERE phone_number IS NOT NULL;

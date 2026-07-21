-- Immutable, proof-carrying admission evidence for governed Flow actions.
-- The application role cannot read or mutate this table directly. It may only
-- append one bounded decision through the SECURITY DEFINER function below.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.flow_action_policy_decisions (
  id uuid PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,
  reservation_receipt_id uuid,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.:-]{1,127}$'),
  decision text NOT NULL CHECK (decision IN ('deny', 'require_confirmation', 'allow')),
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 128),
  effect text NOT NULL CHECK (effect IN ('read', 'write', 'opaque', 'unknown')),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  state_head_sha256 text NOT NULL CHECK (state_head_sha256 ~ '^[a-f0-9]{64}$'),
  state_revision integer NOT NULL CHECK (state_revision >= 0),
  capability_epoch integer NOT NULL CHECK (capability_epoch >= 0),
  arguments_sha256 text NOT NULL CHECK (arguments_sha256 ~ '^[a-f0-9]{64}$'),
  proposal_digest text NOT NULL CHECK (proposal_digest ~ '^[a-f0-9]{64}$'),
  challenge_digest text CHECK (challenge_digest IS NULL OR challenge_digest ~ '^[a-f0-9]{64}$'),
  evidence_sha256 jsonb NOT NULL CHECK (
    jsonb_typeof(evidence_sha256) = 'array'
    AND jsonb_array_length(evidence_sha256) <= 256
    AND octet_length(evidence_sha256::text) <= 17409
  ),
  facts_sha256 text NOT NULL CHECK (facts_sha256 ~ '^[a-f0-9]{64}$'),
  receipts_sha256 text NOT NULL CHECK (receipts_sha256 ~ '^[a-f0-9]{64}$'),
  confirmation_sha256 text CHECK (confirmation_sha256 IS NULL OR confirmation_sha256 ~ '^[a-f0-9]{64}$'),
  prior_call_count integer NOT NULL CHECK (prior_call_count >= 0),
  authority_bundle_sha256 text NOT NULL CHECK (authority_bundle_sha256 ~ '^[a-f0-9]{64}$'),
  decision_digest text NOT NULL CHECK (decision_digest ~ '^[a-f0-9]{64}$'),
  evaluated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT flow_action_policy_decision_receipt_fk
    FOREIGN KEY (reservation_receipt_id, call_id)
    REFERENCES public.flow_action_receipts(id, call_id) ON DELETE RESTRICT,
  CONSTRAINT flow_action_policy_decision_reservation_valid CHECK (
    reservation_receipt_id IS NULL OR decision = 'allow'
  ),
  CONSTRAINT flow_action_policy_decision_challenge_valid CHECK (
    (decision = 'require_confirmation' AND challenge_digest IS NOT NULL)
    OR decision <> 'require_confirmation'
  ),
  UNIQUE (call_id, id)
);

CREATE INDEX IF NOT EXISTS idx_flow_action_policy_decisions_call
  ON public.flow_action_policy_decisions(call_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_flow_action_policy_decisions_receipt
  ON public.flow_action_policy_decisions(reservation_receipt_id)
  WHERE reservation_receipt_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.reject_flow_action_policy_decision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $flow_action_policy_decision_immutable$
BEGIN
  RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='flow_action_policy_decisions_are_append_only';
END
$flow_action_policy_decision_immutable$;

DROP TRIGGER IF EXISTS trg_flow_action_policy_decisions_append_only
  ON public.flow_action_policy_decisions;
CREATE TRIGGER trg_flow_action_policy_decisions_append_only
BEFORE UPDATE OR DELETE ON public.flow_action_policy_decisions
FOR EACH ROW EXECUTE FUNCTION public.reject_flow_action_policy_decision_mutation();

ALTER TABLE public.flow_action_policy_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_action_policy_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hacc_backend_deny_all ON public.flow_action_policy_decisions;
DO $flow_action_policy_backend_policy$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    CREATE POLICY hacc_backend_deny_all ON public.flow_action_policy_decisions
      FOR ALL TO hacc_backend USING (false) WITH CHECK (false);
  END IF;
END
$flow_action_policy_backend_policy$;
DO $flow_action_policy_owner_policy$
BEGIN
  DROP POLICY IF EXISTS hacc_migration_owner_all ON public.flow_action_policy_decisions;
  EXECUTE format(
    'CREATE POLICY hacc_migration_owner_all ON public.flow_action_policy_decisions FOR ALL TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$flow_action_policy_owner_policy$;

CREATE OR REPLACE FUNCTION public.append_flow_action_policy_decision(
  decision_identity uuid,
  call_identity uuid,
  receipt_identity uuid,
  action_name text,
  decision_name text,
  decision_reason text,
  effect_name text,
  policy_sha256 text,
  state_sha256 text,
  flow_revision integer,
  flow_capability_epoch integer,
  arguments_digest text,
  proposal_sha256 text,
  challenge_sha256 text,
  evidence_digests jsonb,
  facts_digest text,
  receipts_digest text,
  confirmation_digest text,
  previous_call_count integer,
  authority_bundle_digest text,
  decision_sha256 text,
  evaluation_time timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $append_flow_action_policy_decision$
DECLARE
  receipt public.flow_action_receipts%ROWTYPE;
  evidence_item jsonb;
  flow_run public.flow_runs%ROWTYPE;
  authoritative_call_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.calls WHERE id = call_identity AND status = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='flow_action_policy_call_not_found';
  END IF;
  SELECT * INTO flow_run
  FROM public.flow_runs
  WHERE call_id = call_identity
  FOR SHARE;
  IF NOT FOUND
     OR flow_run.revision <> flow_revision
     OR COALESCE(jsonb_typeof(flow_run.state->'capabilityEpoch'), '') <> 'number'
     OR (flow_run.state->>'capabilityEpoch')::numeric <> flow_capability_epoch THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='flow_action_policy_state_binding_invalid';
  END IF;
  SELECT count(*) FILTER (WHERE dispatch_started_at IS NOT NULL)::integer
  INTO authoritative_call_count
  FROM public.flow_action_receipts
  WHERE call_id = call_identity AND tool = action_name;
  IF previous_call_count <> authoritative_call_count
     OR evaluation_time < date_trunc('milliseconds', transaction_timestamp())
     OR evaluation_time > clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='flow_action_policy_host_authority_invalid';
  END IF;
  IF jsonb_typeof(evidence_digests) <> 'array'
     OR jsonb_array_length(evidence_digests) > 256
     OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(evidence_digests))
        <> jsonb_array_length(evidence_digests) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='flow_action_policy_evidence_invalid';
  END IF;
  FOR evidence_item IN SELECT value FROM jsonb_array_elements(evidence_digests) LOOP
    IF jsonb_typeof(evidence_item) <> 'string'
       OR evidence_item #>> '{}' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='flow_action_policy_evidence_invalid';
    END IF;
  END LOOP;
  IF receipt_identity IS NOT NULL THEN
    SELECT * INTO receipt
    FROM public.flow_action_receipts
    WHERE id = receipt_identity AND call_id = call_identity;
    IF NOT FOUND
       OR decision_name <> 'allow'
       OR receipt.tool <> action_name
       OR receipt.capability_epoch <> flow_capability_epoch THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='flow_action_policy_receipt_binding_invalid';
    END IF;
  END IF;

  INSERT INTO public.flow_action_policy_decisions (
    id, call_id, reservation_receipt_id, action, decision, reason, effect,
    policy_digest, state_head_sha256, state_revision, capability_epoch,
    arguments_sha256, proposal_digest, challenge_digest, evidence_sha256,
    facts_sha256, receipts_sha256, confirmation_sha256, prior_call_count,
    authority_bundle_sha256, decision_digest, evaluated_at
  ) VALUES (
    decision_identity, call_identity, receipt_identity, action_name, decision_name,
    decision_reason, effect_name, policy_sha256, state_sha256, flow_revision,
    flow_capability_epoch, arguments_digest, proposal_sha256, challenge_sha256,
    evidence_digests, facts_digest, receipts_digest, confirmation_digest,
    previous_call_count, authority_bundle_digest, decision_sha256, evaluation_time
  );
  RETURN decision_identity;
END
$append_flow_action_policy_decision$;

COMMENT ON TABLE public.flow_action_policy_decisions IS
  'Append-only host-side evidence for the exact policy, Flow authority, arguments, evidence hashes, confirmation, database time, and call count evaluated immediately before an action reservation.';

REVOKE ALL ON public.flow_action_policy_decisions FROM PUBLIC;
REVOKE ALL ON FUNCTION public.append_flow_action_policy_decision(
  uuid,uuid,uuid,text,text,text,text,text,text,integer,integer,text,text,text,
  jsonb,text,text,text,integer,text,text,timestamptz
) FROM PUBLIC;
DO $flow_action_policy_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hacc_backend') THEN
    REVOKE ALL ON public.flow_action_policy_decisions FROM hacc_backend;
    GRANT EXECUTE ON FUNCTION public.append_flow_action_policy_decision(
      uuid,uuid,uuid,text,text,text,text,text,text,integer,integer,text,text,text,
      jsonb,text,text,text,integer,text,text,timestamptz
    ) TO hacc_backend;
  END IF;
END
$flow_action_policy_grants$;

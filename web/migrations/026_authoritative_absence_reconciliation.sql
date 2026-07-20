-- Tri-state recovery: exact committed proof succeeds, exact invocation-bound absence becomes a
-- retry-safe failure, and every pending/unrecognized proof leaves the action indeterminate.

ALTER TABLE flow_action_reconciliation_proofs
  DROP CONSTRAINT IF EXISTS flow_action_reconciliation_proofs_status_check;
ALTER TABLE flow_action_reconciliation_proofs
  DROP CONSTRAINT IF EXISTS flow_action_reconciliation_proof_status_valid;
ALTER TABLE flow_action_reconciliation_proofs
  ADD CONSTRAINT flow_action_reconciliation_proof_status_valid
  CHECK (status IN ('querying','committed','absent','mismatch','error'));

ALTER TABLE flow_action_reconciliation_proofs
  DROP CONSTRAINT IF EXISTS flow_action_reconciliation_terminal_shape;
ALTER TABLE flow_action_reconciliation_proofs
  ADD CONSTRAINT flow_action_reconciliation_terminal_shape CHECK (
    (status = 'querying' AND completed_at IS NULL AND proof_result IS NULL
      AND proof_result_hash IS NULL AND authoritative_result IS NULL
      AND authoritative_result_hash IS NULL AND error IS NULL)
    OR (status = 'committed' AND completed_at IS NOT NULL
      AND proof_result IS NOT NULL AND proof_result_hash IS NOT NULL
      AND authoritative_result IS NOT NULL AND authoritative_result_hash IS NOT NULL
      AND error IS NULL)
    OR (status IN ('absent','mismatch') AND completed_at IS NOT NULL
      AND proof_result IS NOT NULL AND proof_result_hash IS NOT NULL
      AND authoritative_result IS NULL AND authoritative_result_hash IS NULL AND error IS NULL)
    OR (status = 'error' AND completed_at IS NOT NULL
      AND proof_result IS NULL AND proof_result_hash IS NULL
      AND authoritative_result IS NULL AND authoritative_result_hash IS NULL
      AND error IS NOT NULL)
  );

ALTER TABLE flow_action_receipts
  DROP CONSTRAINT IF EXISTS flow_action_reconciliation_status_valid;
ALTER TABLE flow_action_receipts
  ADD CONSTRAINT flow_action_reconciliation_status_valid
  CHECK (reconciliation_proof_id IS NULL OR status IN ('succeeded','failed'));

CREATE OR REPLACE FUNCTION reject_terminal_flow_reconciliation_proof_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'querying' THEN
      RAISE EXCEPTION 'flow reconciliation proofs must begin in querying state';
    END IF;
    IF NEW.lease_expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'flow reconciliation proof lease must be live at admission';
    END IF;
    PERFORM 1
    FROM flow_action_receipts
    WHERE id = NEW.action_receipt_id
      AND call_id = NEW.call_id
      AND status = 'indeterminate'
      AND runtime_digest = NEW.runtime_digest
      AND dispatch_started_at IS NOT NULL
      AND reconciliation_proof_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'flow reconciliation proof is not bound to an eligible receipt';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM 1 FROM calls WHERE id = OLD.call_id;
    IF FOUND THEN RAISE EXCEPTION 'terminal flow reconciliation proofs are immutable'; END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'querying' THEN
    RAISE EXCEPTION 'terminal flow reconciliation proofs are immutable';
  END IF;
  IF NEW.status = 'querying' THEN
    RAISE EXCEPTION 'active flow reconciliation proof authority is immutable';
  END IF;
  IF NEW.status IN ('committed', 'absent', 'mismatch')
     AND OLD.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'expired flow reconciliation proof cannot become authoritative';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.call_id IS DISTINCT FROM OLD.call_id
     OR NEW.action_receipt_id IS DISTINCT FROM OLD.action_receipt_id
     OR NEW.runtime_digest IS DISTINCT FROM OLD.runtime_digest
     OR NEW.policy_hash IS DISTINCT FROM OLD.policy_hash
     OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.query_tool IS DISTINCT FROM OLD.query_tool
     OR NEW.query_arguments IS DISTINCT FROM OLD.query_arguments
     OR NEW.query_arguments_hash IS DISTINCT FROM OLD.query_arguments_hash
     OR NEW.predicate IS DISTINCT FROM OLD.predicate
     OR NEW.predicate_hash IS DISTINCT FROM OLD.predicate_hash
     OR NEW.authoritative_result_path IS DISTINCT FROM OLD.authoritative_result_path
     OR NEW.owner_token IS DISTINCT FROM OLD.owner_token
     OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'flow reconciliation proof authority is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_flow_action_receipt_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  proof_authoritative_result jsonb;
  proof_authoritative_result_hash text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'reserved'
       OR NEW.dispatch_started_at IS NOT NULL
       OR NEW.dispatch_attempt <> 0
       OR NEW.result IS NOT NULL
       OR NEW.result_hash IS NOT NULL
       OR NEW.error IS NOT NULL
       OR NEW.settled_at IS NOT NULL
       OR NEW.reconciliation_proof_id IS NOT NULL
       OR NEW.delivery_state <> 'not_sent' THEN
      RAISE EXCEPTION 'flow action receipts must begin as undispatched reservations';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM 1 FROM calls WHERE id = OLD.call_id;
    IF FOUND THEN RAISE EXCEPTION 'flow action receipts cannot be deleted while their call exists'; END IF;
    RETURN OLD;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.call_id IS DISTINCT FROM OLD.call_id
     OR NEW.runtime_digest IS DISTINCT FROM OLD.runtime_digest
     OR NEW.capability_epoch IS DISTINCT FROM OLD.capability_epoch
     OR NEW.step_path IS DISTINCT FROM OLD.step_path
     OR NEW.step_attempt IS DISTINCT FROM OLD.step_attempt
     OR NEW.tool IS DISTINCT FROM OLD.tool
     OR NEW.invocation_id IS DISTINCT FROM OLD.invocation_id
     OR NEW.provider_invocation_id IS DISTINCT FROM OLD.provider_invocation_id
     OR NEW.arguments IS DISTINCT FROM OLD.arguments
     OR NEW.arguments_hash IS DISTINCT FROM OLD.arguments_hash
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at THEN
    RAISE EXCEPTION 'flow action receipt authority is immutable';
  END IF;

  IF OLD.status = 'reserved' AND NEW.status = 'reserved' THEN
    IF OLD.dispatch_started_at IS NULL AND NEW.dispatch_started_at IS NULL THEN
      IF NEW.dispatch_attempt IS DISTINCT FROM OLD.dispatch_attempt
         OR NEW.delivery_state IS DISTINCT FROM OLD.delivery_state
         OR (NEW.owner_token IS DISTINCT FROM OLD.owner_token
             AND OLD.dispatch_lease_expires_at > now()) THEN
        RAISE EXCEPTION 'invalid pre-dispatch receipt lease transition';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.dispatch_started_at IS NULL AND NEW.dispatch_started_at IS NOT NULL THEN
      IF NEW.owner_token IS DISTINCT FROM OLD.owner_token
         OR NEW.dispatch_attempt <> OLD.dispatch_attempt + 1
         OR NEW.delivery_state <> 'unknown' THEN
        RAISE EXCEPTION 'invalid flow action dispatch transition';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.dispatch_started_at IS NOT NULL
       AND NEW.dispatch_started_at IS NOT DISTINCT FROM OLD.dispatch_started_at
       AND NEW.dispatch_attempt = OLD.dispatch_attempt
       AND NEW.owner_token IS NOT DISTINCT FROM OLD.owner_token
       AND NEW.delivery_state IS NOT DISTINCT FROM OLD.delivery_state THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'flow action dispatch boundary is immutable';
  END IF;

  IF OLD.status = 'reserved' AND NEW.status IN ('succeeded', 'failed', 'indeterminate') THEN
    IF NEW.owner_token IS DISTINCT FROM OLD.owner_token
       OR NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at
       OR NEW.dispatch_attempt IS DISTINCT FROM OLD.dispatch_attempt
       OR NEW.dispatch_lease_expires_at IS DISTINCT FROM OLD.dispatch_lease_expires_at
       OR NEW.owner_heartbeat_at IS DISTINCT FROM OLD.owner_heartbeat_at
       OR NEW.reconciliation_proof_id IS NOT NULL THEN
      RAISE EXCEPTION 'invalid flow action settlement transition';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'indeterminate' AND NEW.status = 'succeeded' THEN
    IF NEW.owner_token IS DISTINCT FROM OLD.owner_token
       OR NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at
       OR NEW.dispatch_attempt IS DISTINCT FROM OLD.dispatch_attempt
       OR NEW.dispatch_lease_expires_at IS DISTINCT FROM OLD.dispatch_lease_expires_at
       OR NEW.owner_heartbeat_at IS DISTINCT FROM OLD.owner_heartbeat_at
       OR NEW.reconciliation_proof_id IS NULL
       OR NEW.settled_at < OLD.settled_at THEN
      RAISE EXCEPTION 'invalid reconciled action transition';
    END IF;
    SELECT authoritative_result, authoritative_result_hash
      INTO proof_authoritative_result, proof_authoritative_result_hash
    FROM flow_action_reconciliation_proofs
    WHERE id = NEW.reconciliation_proof_id
      AND call_id = OLD.call_id
      AND action_receipt_id = OLD.id
      AND status = 'committed';
    IF NOT FOUND
       OR NEW.result IS DISTINCT FROM proof_authoritative_result
       OR NEW.result_hash IS DISTINCT FROM proof_authoritative_result_hash THEN
      RAISE EXCEPTION 'reconciled receipt is not backed by its exact committed proof';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'indeterminate' AND NEW.status = 'failed' THEN
    IF NEW.owner_token IS DISTINCT FROM OLD.owner_token
       OR NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at
       OR NEW.dispatch_attempt IS DISTINCT FROM OLD.dispatch_attempt
       OR NEW.dispatch_lease_expires_at IS DISTINCT FROM OLD.dispatch_lease_expires_at
       OR NEW.owner_heartbeat_at IS DISTINCT FROM OLD.owner_heartbeat_at
       OR NEW.reconciliation_proof_id IS NULL
       OR NEW.settled_at < OLD.settled_at
       OR NEW.delivery_state <> 'rejected'
       OR NEW.result IS NOT NULL OR NEW.result_hash IS NOT NULL
       OR NEW.error IS DISTINCT FROM '{"code":"authoritative_absence_proven"}'::jsonb THEN
      RAISE EXCEPTION 'invalid authoritative-absence transition';
    END IF;
    PERFORM 1
    FROM flow_action_reconciliation_proofs
    WHERE id = NEW.reconciliation_proof_id
      AND call_id = OLD.call_id
      AND action_receipt_id = OLD.id
      AND runtime_digest = OLD.runtime_digest
      AND status = 'absent'
      AND proof_result IS NOT NULL
      AND proof_result_hash IS NOT NULL
      AND authoritative_result IS NULL
      AND authoritative_result_hash IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'failed receipt is not backed by its exact authoritative-absence proof';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'terminal flow action receipt is immutable';
END $$;

COMMENT ON CONSTRAINT flow_action_reconciliation_status_valid ON flow_action_receipts IS
  'A proof may terminalize an indeterminate receipt only as exact committed success or exact retry-safe absence.';
COMMENT ON CONSTRAINT flow_action_reconciliation_proof_status_valid ON flow_action_reconciliation_proofs IS
  'Pending or unrecognized read-back remains mismatch/indeterminate; absent is a distinct exact terminal proof.';

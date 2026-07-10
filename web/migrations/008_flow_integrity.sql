-- Immutable call runtimes plus an atomic action ledger for proof-carrying Flow v2 execution.

ALTER TABLE calls ADD COLUMN IF NOT EXISTS runtime_snapshot jsonb;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS runtime_digest text;

CREATE TABLE IF NOT EXISTS flow_action_receipts (
  id uuid PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  runtime_digest text NOT NULL,
  capability_epoch int NOT NULL CHECK (capability_epoch >= 0),
  step_path text NOT NULL,
  step_attempt int NOT NULL CHECK (step_attempt >= 0),
  tool text NOT NULL,
  arguments jsonb NOT NULL,
  arguments_hash text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved','succeeded','failed','indeterminate')),
  owner_token uuid NOT NULL,
  result jsonb,
  result_hash text,
  error jsonb,
  delivery_state text NOT NULL DEFAULT 'not_sent'
    CHECK (delivery_state IN ('not_sent','accepted','committed','unknown')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_flow_action_receipts_call
  ON flow_action_receipts(call_id, reserved_at);
CREATE INDEX IF NOT EXISTS idx_flow_action_receipts_unsettled
  ON flow_action_receipts(call_id, status)
  WHERE status IN ('reserved','indeterminate');
CREATE UNIQUE INDEX IF NOT EXISTS uq_flow_action_receipts_admitted_key
  ON flow_action_receipts(call_id, idempotency_key)
  WHERE status <> 'failed';

ALTER TABLE flow_runs ALTER COLUMN state SET DEFAULT '{
  "version":2,
  "status":"routing",
  "nodeId":null,
  "currentStep":null,
  "completedSteps":[],
  "attempts":{},
  "outputs":{},
  "checkpoints":[],
  "capabilityEpoch":0,
  "actionReceipts":[],
  "revision":0,
  "updatedAt":"1970-01-01T00:00:00.000Z"
}';

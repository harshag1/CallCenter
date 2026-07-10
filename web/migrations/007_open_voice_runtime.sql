-- Durable, provider-neutral execution state for resumable multi-layer voice flows.

CREATE TABLE IF NOT EXISTS flow_runs (
  call_id uuid PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  state jsonb NOT NULL DEFAULT '{
    "version":2,
    "status":"routing",
    "nodeId":null,
    "currentStep":null,
    "completedSteps":[],
    "attempts":{},
    "outputs":{},
    "checkpoints":[],
    "revision":0,
    "updatedAt":"1970-01-01T00:00:00.000Z"
  }',
  revision int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flow_runs_updated ON flow_runs(updated_at DESC);

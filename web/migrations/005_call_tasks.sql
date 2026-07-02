-- Author: Harsha Gundala
-- 005_call_tasks.sql — background LLM tasks launched from live calls (now / end_of_call).

CREATE TABLE IF NOT EXISTS call_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES orgs(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  command text NOT NULL,
  trigger_at text NOT NULL DEFAULT 'now' CHECK (trigger_at IN ('now','end_of_call')),
  status text NOT NULL DEFAULT 'pending',      -- pending | running | done | failed
  result text,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_call_tasks_pending ON call_tasks(status, trigger_at) WHERE status = 'pending';

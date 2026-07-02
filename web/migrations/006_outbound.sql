-- Author: Harsha Gundala
-- 006_outbound.sql — named flows (inbound default + agent-created outbound), campaigns, recalls, live dataset sync.

CREATE TABLE IF NOT EXISTS flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'outbound' CHECK (kind IN ('inbound','outbound')),
  flow jsonb NOT NULL,
  instructions text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flows_agent ON flows(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  flow_id uuid NOT NULL REFERENCES flows(id),
  name text NOT NULL,
  dataset_slug text NOT NULL,               -- target list source
  phone_column text NOT NULL DEFAULT 'phone',
  status text NOT NULL DEFAULT 'running',   -- scheduled | running | done | canceled
  run_at timestamptz,                       -- null = immediately
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Calls carry their flow (outbound campaigns) and recall lineage (outbound ↔ inbound links).
ALTER TABLE calls ADD COLUMN IF NOT EXISTS flow_id uuid REFERENCES flows(id);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS parent_call_id uuid REFERENCES calls(id);
CREATE INDEX IF NOT EXISTS idx_calls_campaign ON calls(campaign_id) WHERE campaign_id IS NOT NULL;

ALTER TABLE scheduled_calls ADD COLUMN IF NOT EXISTS flow_id uuid REFERENCES flows(id);
ALTER TABLE scheduled_calls ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id);

-- Agent-controlled recall policy: the analysis agent may trigger a callback when a caller was cut off.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS recall_policy jsonb NOT NULL DEFAULT
  '{"enabled": true, "instructions": "If the caller was clearly cut off mid-sentence or the call dropped while they were still engaged, schedule a callback within 2 minutes. Apologize for the disconnect and pick up exactly where the conversation left off."}';

-- Live dataset sync: table writes (e.g. scores recorded mid-campaign) push to the UI in realtime.
CREATE OR REPLACE FUNCTION notify_dataset_update() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('org_events', json_build_object(
    'orgId', COALESCE(NEW.org_id, OLD.org_id), 'kind', 'dataset_update',
    'datasetId', COALESCE(NEW.dataset_id, OLD.dataset_id)
  )::text);
  RETURN COALESCE(NEW, OLD);
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_notify_dataset_update ON dataset_rows;
CREATE TRIGGER trg_notify_dataset_update AFTER INSERT OR UPDATE OR DELETE ON dataset_rows
  FOR EACH ROW EXECUTE FUNCTION notify_dataset_update();

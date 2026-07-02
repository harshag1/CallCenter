-- Author: Harsha Gundala
-- 004_platform.sql — realtime platform: satisfaction pipeline, experiments, datasets, screens, media, NOTIFY triggers.

ALTER TABLE calls ADD COLUMN IF NOT EXISTS satisfaction int;            -- 1..10 (5 normal, 1 furious)
ALTER TABLE calls ADD COLUMN IF NOT EXISTS resolution text;             -- ai_resolved | human_resolved | unresolved
ALTER TABLE calls ADD COLUMN IF NOT EXISTS review text;                 -- AI-generated call review
ALTER TABLE calls ADD COLUMN IF NOT EXISTS experiment_id uuid;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS variant text;

CREATE TABLE IF NOT EXISTS experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  name text NOT NULL,
  hypothesis text,
  status text NOT NULL DEFAULT 'running',     -- running | stopped
  variants jsonb NOT NULL,                    -- [{key:"a",label,agent_version:int,weight:0.5}, ...]
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  slug text NOT NULL,
  name text NOT NULL,
  icon text NOT NULL DEFAULT 'table',
  columns jsonb NOT NULL,                     -- [{key,label,type:"text"|"number"|"phone"|"date"}]
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE IF NOT EXISTS dataset_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES orgs(id),
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dataset_rows ON dataset_rows(dataset_id, created_at DESC);

CREATE TABLE IF NOT EXISTS screens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  title text NOT NULL,
  icon text NOT NULL DEFAULT 'layout',
  kind text NOT NULL DEFAULT 'screen',        -- screen | experiment
  spec jsonb NOT NULL DEFAULT '{"blocks":[]}',-- Surface DSL blocks
  experiment_id uuid REFERENCES experiments(id),
  position int NOT NULL DEFAULT 0,
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE documents ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'knowledge';  -- knowledge | media | data
ALTER TABLE documents ADD COLUMN IF NOT EXISTS data bytea;                              -- raw bytes for media/data files
ALTER TABLE documents ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS media_renditions (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind text NOT NULL,                         -- 'ulaw8k' (telephony hold music)
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, kind)
);

-- Realtime: NOTIFY on call activity so the SSE stream can fan out per org.
CREATE OR REPLACE FUNCTION notify_call_event() RETURNS trigger AS $$
DECLARE org uuid;
BEGIN
  SELECT a.org_id INTO org FROM calls c JOIN agents a ON a.id = c.agent_id WHERE c.id = NEW.call_id;
  PERFORM pg_notify('org_events', json_build_object(
    'orgId', org, 'kind', 'call_event', 'callId', NEW.call_id,
    'eventId', NEW.id, 'type', NEW.type, 'payload', NEW.payload, 'ts', NEW.ts
  )::text);
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_notify_call_event ON call_events;
CREATE TRIGGER trg_notify_call_event AFTER INSERT ON call_events FOR EACH ROW EXECUTE FUNCTION notify_call_event();

CREATE OR REPLACE FUNCTION notify_call_update() RETURNS trigger AS $$
DECLARE org uuid;
BEGIN
  SELECT a.org_id INTO org FROM agents a WHERE a.id = NEW.agent_id;
  PERFORM pg_notify('org_events', json_build_object(
    'orgId', org, 'kind', 'call_update', 'callId', NEW.id, 'status', NEW.status,
    'satisfaction', NEW.satisfaction, 'direction', NEW.direction
  )::text);
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_notify_call_update ON calls;
CREATE TRIGGER trg_notify_call_update AFTER INSERT OR UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION notify_call_update();

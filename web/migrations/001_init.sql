-- Author: Harsha Gundala
-- 001_init.sql — full platform schema (auth, orgs, agents, tools, calls, chat, sandbox)

CREATE TABLE IF NOT EXISTS auth_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code_hmac text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_email ON auth_codes(email);

CREATE TABLE IF NOT EXISTS sessions_auth (
  token text PRIMARY KEY,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text UNIQUE,
  name text,
  scrape jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  email text PRIMARY KEY,
  org_id uuid REFERENCES orgs(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  name text NOT NULL,
  purpose text,
  active_version int NOT NULL DEFAULT 1,
  phone_number text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_versions (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version int NOT NULL,
  instructions text NOT NULL,
  voice text NOT NULL DEFAULT 'ara',
  flow jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  tool_ids uuid[] NOT NULL DEFAULT '{}',
  mcp_server_ids uuid[] NOT NULL DEFAULT '{}',
  settings jsonb NOT NULL DEFAULT '{}',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, version)
);

CREATE TABLE IF NOT EXISTS tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  slug text NOT NULL,
  description text NOT NULL,
  input_schema jsonb NOT NULL,
  kind text NOT NULL CHECK (kind IN ('builtin','edge')),
  source_code text,
  endpoint_url text,
  deploy_status text NOT NULL DEFAULT 'draft',
  env_var_names text[] NOT NULL DEFAULT '{}',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE IF NOT EXISTS tool_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_id uuid NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  vercel_deployment_id text,
  status text NOT NULL,
  logs text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  label text NOT NULL,
  server_url text NOT NULL,
  auth_header_encrypted text,
  allowed_tools text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS env_vars (
  org_id uuid NOT NULL REFERENCES orgs(id),
  name text NOT NULL,
  value_encrypted text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, name)
);

CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id),
  agent_version int NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound','web')),
  status text NOT NULL DEFAULT 'active',
  from_number text,
  to_number text,
  xai_call_id text,
  twilio_call_sid text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_s int,
  recording_path text,
  summary text,
  sentiment text,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_calls_agent_time ON calls(agent_id, started_at DESC);

CREATE TABLE IF NOT EXISTS call_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_events_call ON call_events(call_id, ts);

-- MVP recording storage (Supabase Storage keys pending — see plan §10)
CREATE TABLE IF NOT EXISTS call_recordings (
  call_id uuid PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  mime text NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduled_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id),
  to_number text NOT NULL,
  run_at timestamptz NOT NULL,
  reason text,
  parent_call_id uuid REFERENCES calls(id),
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_calls(run_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS chat_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id),
  thread_id uuid NOT NULL,
  role text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_thread ON chat_messages(thread_id, id);

CREATE TABLE IF NOT EXISTS surfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  title text NOT NULL,
  spec jsonb NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL,
  scope text NOT NULL,
  org_id uuid,
  call_id uuid,
  message text NOT NULL,
  data jsonb
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);

-- Operator-agent sandbox: DDL/DML allowed here only (enforced at the tool layer)
CREATE SCHEMA IF NOT EXISTS agent_data;

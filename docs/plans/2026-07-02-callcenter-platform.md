# Harsha's Amazing Call Center — Platform Implementation Plan

**Goal:** An agent-centric enterprise voice-agent builder: a Grok-powered operator agent with maximal authority — it generates UIs, builds and deploys tools, creates storage tables, edits voice-agent prompts/flows, inspects calls/logs/recordings, places outbound calls, and schedules recalls — all driven from a single chat box in an incredibly clean, all-white UI.

**Architecture:** Next.js (App Router) on Vercel, Supabase Postgres + Storage, Grok everywhere: `grok-voice-latest` over the xAI Realtime WebSocket for calls (browser via ephemeral tokens, phones via xAI SIP + Twilio), and `grok-4-latest` as the operator agent running a server-side tool loop. Agent-minted tools are deployed as Vercel edge functions via the Vercel API and exposed to voice sessions through our own MCP gateway — which xAI executes server-side, so custom tools work identically on browser calls and phone calls with zero long-lived infrastructure on our side.

**Tech Stack:** Next.js 15 + TypeScript + Tailwind, Supabase (Postgres, Storage), xAI API (voice + chat + live search), Twilio (PSTN), Resend (OTP email), Vercel (hosting, edge functions, cron), React Flow (call-flow chart).

---

## 1. System Design (E2E)

### 1.1 The one diagram that matters

```
                        ┌────────────────────────────────────────────┐
                        │        web/ (Next.js on Vercel)            │
 Browser ── HTTPS ──────▶  UI  ·  API routes  ·  MCP gateway  ·  cron │
                        └───┬──────────────┬───────────▲─────────────┘
                            │              │           │ (xAI calls our MCP
        ephemeral token     │              │           │  gateway server-side
                            ▼              ▼           │  during voice calls)
 Browser mic ── WS ──▶ xAI Realtime   grok-4 operator ─┘
                       (grok-voice)    agent loop
                            ▲              │
 Caller ─ PSTN ─ Twilio ─ SIP              ├── Vercel API ──▶ agent-minted edge fns
                                           ├── Supabase ────▶ pg + storage + vault
                                           └── xAI live search (onboarding scrape)
```

### 1.2 Core insight that removes a whole tier

Vercel cannot host long-lived WebSocket servers, so we never bridge audio ourselves:

- **Browser test calls:** the browser connects *directly* to `wss://api.x.ai/v1/realtime?model=grok-voice-latest` using a short-lived ephemeral token minted by our API. Audio never touches our servers.
- **Phone calls:** Twilio number ↔ xAI SIP (`CreatePhoneNumberV2` + call control API). xAI terminates the call leg.
- **Tools on live calls:** every platform tool and every agent-minted tool is exposed through **our MCP gateway** (`/api/mcp`, streamable-HTTP). Voice sessions declare one `{"type":"mcp","server_url":...}` tool; xAI executes MCP calls server-side mid-conversation. No client round-trip, works identically for browser and SIP calls. `MCP_GATEWAY_SECRET` + per-session scoping token authenticate xAI→gateway calls.

### 1.3 The two agents

| | Voice agent (per bot, many) | Operator agent (the builder) |
|---|---|---|
| Model | `grok-voice-latest` | `grok-4-latest` (tool loop, streamed) |
| Where | xAI Realtime session | `/api/chat` route handler |
| Config | `agent_versions` row: instructions, voice, flow JSON, attached tools | System prompt + full tool belt (§4) |
| Tools | MCP gateway (scoped to the bot's enabled tools) + built-in `web_search` | Everything: DB, UI, tool factory, calls, logs, deploys |

The operator agent **is the product**. The UI is a thin shell; nearly every capability is a tool the operator can call.

---

## 2. Repository Structure

```
X_Project/
├── docs/plans/                       # this plan
├── web/                              # Next.js app → Vercel project "CallCenter" (rootDirectory=web)
│   ├── app/
│   │   ├── (auth)/login/             # OTP login page
│   │   ├── (app)/page.tsx            # main 2-col workspace
│   │   ├── (app)/onboarding/         # "Describe your bot"
│   │   └── api/
│   │       ├── auth/{send-code,verify-code,logout}/route.ts
│   │       ├── chat/route.ts         # operator agent loop (streaming)
│   │       ├── voice/token/route.ts  # mint xAI ephemeral tokens
│   │       ├── voice/webhooks/route.ts # xAI call lifecycle events
│   │       ├── mcp/route.ts          # MCP gateway (tools for live calls)
│   │       ├── onboarding/scrape/route.ts
│   │       └── cron/scheduler/route.ts # outbound + recalls (every minute)
│   ├── components/
│   │   ├── chrome/                   # header, title, logout
│   │   ├── surface/                  # left-col dynamic UI renderer (DSL → React)
│   │   ├── flow/                     # right-col React Flow call-flow chart
│   │   ├── chat/                     # right-col operator chat
│   │   └── call/                     # in-browser call widget (mic ↔ xAI WS)
│   ├── lib/
│   │   ├── db.ts, auth.ts, resend.ts, log.ts
│   │   ├── xai/{realtime.ts,chat.ts,search.ts,sip.ts}
│   │   ├── agent/{loop.ts,prompt.ts,tools/*.ts}   # one file per operator tool
│   │   ├── toolfactory/{scaffold.ts,deploy.ts,registry.ts}
│   │   ├── vault.ts                  # AES-256-GCM env-var vault
│   │   └── surface-dsl.ts            # dynamic-UI spec types + validation
│   ├── migrations/                   # numbered .sql, applied via script
│   └── scripts/{migrate.ts,seed.ts}
└── .env                              # canonical secrets (gitignored)
```

No mega files: every operator tool is its own module under `lib/agent/tools/`, registered in a manifest.

---

## 3. Supabase Schema

Two Postgres schemas: `public` (platform) and `agent_data` (sandbox where the operator agent may `CREATE TABLE` freely — its DDL authority is real but fenced).

```sql
-- ============ auth (mirrors gpu-hub pattern: Resend OTP, HMAC-at-rest) ============
CREATE TABLE auth_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code_hmac text NOT NULL,              -- HMAC-SHA256(code, AUTH_CODE_HMAC_SECRET)
  expires_at timestamptz NOT NULL,      -- now() + 10 min
  attempts int NOT NULL DEFAULT 0,      -- lock after 5
  used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_codes_email ON auth_codes(email);

CREATE TABLE sessions_auth (
  token text PRIMARY KEY,               -- 32B hex, httpOnly cookie
  email text NOT NULL,
  expires_at timestamptz NOT NULL,      -- 30d absolute
  last_used_at timestamptz NOT NULL DEFAULT now(),  -- 7d idle expiry
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text UNIQUE NOT NULL,          -- from login email; null-domain = personal
  name text,
  scrape jsonb,                         -- onboarding company-research payload
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  email text PRIMARY KEY,
  org_id uuid REFERENCES orgs(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ bots & versioned config ============
CREATE TABLE agents (                    -- a "bot"
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  name text NOT NULL,
  purpose text,                          -- support | feedback | outbound | ...
  active_version int NOT NULL DEFAULT 1,
  phone_number text,                     -- provisioned Twilio number, if any
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_versions (            -- immutable; edits create a new version
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version int NOT NULL,
  instructions text NOT NULL,            -- voice-agent system prompt
  voice text NOT NULL DEFAULT 'ara',
  flow jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}',  -- powers the flow chart
  tool_ids uuid[] NOT NULL DEFAULT '{}',
  mcp_server_ids uuid[] NOT NULL DEFAULT '{}',
  settings jsonb NOT NULL DEFAULT '{}',  -- turn_detection, language_hint, ...
  created_by text NOT NULL,              -- 'operator-agent' | user email
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, version)
);

-- ============ tools (platform + agent-minted) ============
CREATE TABLE tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  slug text NOT NULL,                    -- unique per org
  description text NOT NULL,
  input_schema jsonb NOT NULL,           -- JSON Schema, doubles as MCP tool def
  kind text NOT NULL CHECK (kind IN ('builtin','edge')),
  source_code text,                      -- TS source (kind='edge')
  endpoint_url text,                     -- deployed Vercel fn URL (kind='edge')
  deploy_status text NOT NULL DEFAULT 'draft',  -- draft|deploying|live|failed
  env_var_names text[] NOT NULL DEFAULT '{}',   -- vault keys injected at deploy
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE tool_deployments (          -- audit trail of every deploy
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_id uuid NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  vercel_deployment_id text,
  status text NOT NULL,
  logs text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mcp_servers (               -- user-connected external MCPs
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  label text NOT NULL,
  server_url text NOT NULL,
  auth_header_encrypted text,            -- vault-encrypted bearer/header
  allowed_tools text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE env_vars (                  -- live secrets vault
  org_id uuid NOT NULL REFERENCES orgs(id),
  name text NOT NULL,
  value_encrypted text NOT NULL,         -- AES-256-GCM(ENV_VAULT_MASTER_KEY), iv:tag:ct
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, name)
);

-- ============ calls ============
CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id),
  agent_version int NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound','web')),
  status text NOT NULL DEFAULT 'active', -- active|completed|failed|no-answer
  from_number text, to_number text,
  xai_call_id text, twilio_call_sid text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_s int,
  recording_path text,                   -- Supabase Storage: recordings/<call_id>.ogg
  summary text,                          -- post-call grok-4 summary
  sentiment text,                        -- positive|neutral|negative
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_calls_agent_time ON calls(agent_id, started_at DESC);

CREATE TABLE call_events (               -- transcript turns + tool calls + system events
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,                    -- user_said|agent_said|tool_call|tool_result|state|error
  payload jsonb NOT NULL
);
CREATE INDEX idx_call_events_call ON call_events(call_id, ts);

CREATE TABLE scheduled_calls (           -- outbound + timed recalls
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id),
  to_number text NOT NULL,
  run_at timestamptz NOT NULL,
  reason text,                           -- e.g. 'recall: customer asked to call back at 3pm'
  parent_call_id uuid REFERENCES calls(id),
  status text NOT NULL DEFAULT 'pending',-- pending|dialing|done|failed|canceled
  attempts int NOT NULL DEFAULT 0,       -- max 3, 5-min backoff
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_scheduled_due ON scheduled_calls(run_at) WHERE status = 'pending';

-- ============ operator agent ============
CREATE TABLE chat_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id),
  thread_id uuid NOT NULL,
  role text NOT NULL,                    -- user|assistant|tool
  content jsonb NOT NULL,                -- text + tool_calls + tool_results
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_thread ON chat_messages(thread_id, id);

CREATE TABLE surfaces (                  -- saved dynamic UIs for the left column
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  title text NOT NULL,
  spec jsonb NOT NULL,                   -- surface DSL (§5.2)
  pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE logs (                      -- structured app logs the agent can query
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL, scope text NOT NULL,
  org_id uuid, call_id uuid,
  message text NOT NULL, data jsonb
);
CREATE INDEX idx_logs_ts ON logs(ts DESC);

-- ============ agent sandbox ============
CREATE SCHEMA agent_data;                -- operator agent may CREATE/ALTER/SELECT/INSERT here
-- connection role for agent DDL/DML is search_path-locked to agent_data
```

Storage buckets: `recordings/` (call audio), `assets/` (anything the agent generates).

---

## 4. The Operator Agent (maximal authority, fenced sandbox)

`lib/agent/loop.ts`: streamed chat-completions loop against `grok-4-latest`; executes tool calls server-side, streams text + UI mutations to the client over SSE. Tool results that carry `surface`, `flow`, or `notice` fields are applied to the workspace live.

**Tool belt** (each `lib/agent/tools/<name>.ts`, exporting `{name, description, inputSchema, execute}`):

| Tool | Authority granted |
|---|---|
| `render_surface` | Push any dynamic UI (tables/dashboards/tabs/charts/forms — §5.2 DSL) into the left column; optionally save/pin |
| `query_data` | Read-only SQL over `public` + `agent_data` (SELECT-only role, 5s timeout, row cap) |
| `manage_table` | DDL/DML inside `agent_data` schema only (role has no grants on `public`) |
| `list_calls` / `get_call` | Calls, full event timeline, transcript, tool traces |
| `get_recording` | Signed Supabase Storage URL; UI renders inline audio player |
| `search_logs` | Filtered query over `logs` |
| `update_agent` | Create new `agent_versions` row (prompt, voice, flow JSON, tools, settings) — never mutates history; flow chart re-renders from `flow` |
| `create_tool` | Tool factory: scaffold TS handler → deploy → register (§6) |
| `test_tool` | Invoke a live tool with sample args, return output + latency |
| `set_env_var` / `list_env_vars` | Vault write (AES-256-GCM); list returns names only, never values |
| `add_mcp_server` | Register external MCP; attach to bots and/or its own belt |
| `place_call` | Immediate outbound call via telephony pipeline (§7) |
| `schedule_call` | Insert `scheduled_calls` (outbound campaigns, timed recalls) |
| `web_search` | xAI live search (company research, docs lookup) |

**Fencing (authority is real, blast radius is bounded):** SQL writes confined to `agent_data` by role grants, not prompt hopes; vault values never round-trip through model context; `create_tool` deploys only to the dedicated tools Vercel project; `update_agent` is append-only versioning so any change is one-click revertible; every tool execution is written to `logs`.

**Voice→operator handoff:** voice agents get a built-in `request_recall(to_number, at, reason)` MCP tool, so "call me back tomorrow at 3" becomes a `scheduled_calls` row mid-conversation.

---

## 5. UI

### 5.1 Shell (all-white, minimal)

- Header: **"Harsha's Amazing Call Center"** left, logout icon-button right. Nothing else.
- Left column (~65%): the **Surface** — renders whatever the operator agent (or navigation) puts there: bot roster, live-calls board, call detail with synced transcript+audio, tool registry, any generated dashboard. Tabs appear only when >1 surface is open.
- Right column top (~40% height): **Flow chart** (React Flow, read-only) of the currently relevant bot/call — nodes from `agent_versions.flow`; during call review, the taken path highlights from `call_events`.
- Right column bottom: **Operator chat.** One input. This is the command line for everything.
- Icons (lucide), Inter/Geist type, zero guidance text anywhere it isn't strictly needed.

### 5.2 Surface DSL (how the agent "picks/generates UIs")

The agent emits validated JSON, not JSX — deterministic to render, safe by construction, and diffable:

```ts
type Surface = { title: string; blocks: Block[] };
type Block =
  | { kind: 'stat_row';  stats: {label: string; value: string; delta?: string}[] }
  | { kind: 'table';     columns: Col[]; rows: Row[]; rowAction?: Action }
  | { kind: 'chart';     type: 'line'|'bar'|'area'|'donut'; series: Series[] }
  | { kind: 'tabs';      tabs: {label: string; blocks: Block[]}[] }
  | { kind: 'transcript'; callId: string }        // synced with audio player
  | { kind: 'audio';     src: string }
  | { kind: 'code';      language: string; source: string }   // tool source view
  | { kind: 'form';      fields: Field[]; submit: Action }
  | { kind: 'markdown';  body: string };
type Action = { prompt: string };  // actions loop back through the operator agent
```

Every interactive element routes back through chat (`Action.prompt`) — the agent stays the single brain; the UI never grows hidden business logic.

---

## 6. Tool Factory (agent builds + deploys its own tools)

1. **Scaffold** — operator writes a self-contained TS edge handler into a fixed template (`export const config = {runtime:'edge'}`; input parsed against the tool's JSON Schema; secrets read from `process.env`, names declared in `env_var_names`).
2. **Deploy** — `POST https://api.vercel.com/v13/deployments` (project `callcenter-tools`, inline files payload, `target=production`); vault values for declared env names are set via the Vercel env API scoped to that project; poll until `READY`.
3. **Register** — upsert `tools` row (`endpoint_url`, `deploy_status='live'`), audit row in `tool_deployments`.
4. **Expose** — MCP gateway picks it up on next list; attaching to a bot = adding its id to `agent_versions.tool_ids`. Live calls can use a tool minted minutes earlier.
5. **Verify** — `test_tool` smoke-call with agent-generated sample args before it's attached to any bot.

MCP gateway (`/api/mcp`): streamable-HTTP MCP server; `tools/list` reflects the calling session's bot scope; `tools/call` executes builtins in-process and `edge` tools via fetch to `endpoint_url`; auth = `MCP_GATEWAY_SECRET` + per-call scope token embedded at session creation; every call logged to `call_events`.

---

## 7. Telephony & Scheduling

- **Numbers:** Twilio number purchase (API) → xAI `CreatePhoneNumberV2` SIP linkage per the xAI SIP docs; inbound rings straight into the bot's realtime session with its MCP tools attached.
- **Outbound / recalls:** Vercel cron → `/api/cron/scheduler` (every minute, `CRON_SECRET`-gated): claims due `scheduled_calls` rows (`FOR UPDATE SKIP LOCKED`), originates via xAI call control (Twilio REST fallback), creates `calls` row, retries ≤3 with backoff.
- **Lifecycle:** xAI webhooks → `/api/voice/webhooks` → status transitions, duration, recording fetch → Supabase Storage → post-call pipeline: grok-4 summary + sentiment onto `calls`.
- **Browser calls:** call widget mints ephemeral token (`/api/voice/token`), streams mic PCM over WS, records both legs client-side, uploads to Storage on hangup, posts events to `call_events` as they stream.

---

## 8. Auth & Onboarding

- **Login:** email → `send-code` (6-digit, HMAC-at-rest, 10-min expiry, 5-attempt lock, Resend from `callcenter@auth.meshia.io`) → `verify-code` → httpOnly session cookie (30d absolute / 7d idle, gpu-hub pattern). One clean centered card.
- **Onboarding:** single centered textbox — **"Describe your bot."** On mount, if the login domain isn't a consumer provider, `/api/onboarding/scrape` fires grok-4 + live search in the background → company profile + 3–4 personalized bot suggestions (support / feedback / outbound …) fade in as clickable chips that prefill the textbox. **"Build my first agent"** → operator agent synthesizes instructions + flow + starter tools → dashboard. Scrape is cached on `orgs.scrape`; suggestions must not block typing (progressive, target <4s).

---

## 9. Implementation Phases

Each phase ends with working, deployable software and a git push. Expand each into bite-sized TDD tasks at execution time.

- [ ] **Phase 0 — Foundation:** migrations runner + schema above; `lib/db.ts`, `lib/log.ts`, `lib/vault.ts` (+ unit tests for vault/HMAC); Vercel project "CallCenter" (rootDirectory=web) + `callcenter-tools` project; CI-less deploy via CLI.
- [ ] **Phase 1 — Auth:** OTP routes + login page + middleware; Resend wiring; session cookie; logout.
- [ ] **Phase 2 — Shell:** header, 2-col layout, surface renderer for all DSL blocks (pure components, storybook-style fixture page), React Flow chart, chat UI with SSE streaming.
- [ ] **Phase 3 — Operator agent:** loop + belt tools `render_surface`, `query_data`, `manage_table`, `search_logs`, `update_agent`; chat persistence.
- [ ] **Phase 4 — Voice core:** ephemeral tokens, browser call widget, live `call_events` ingestion, call detail surface (transcript + audio), MCP gateway with builtin tools; `request_recall` builtin.
- [ ] **Phase 5 — Tool factory:** scaffold/deploy/register/test pipeline + vault env injection + `create_tool`/`test_tool`/`set_env_var`/`add_mcp_server`.
- [ ] **Phase 6 — Telephony:** Twilio number provisioning, xAI SIP link, inbound calls, `place_call`, cron scheduler + recalls, webhooks, recordings→Storage, post-call summaries.
- [ ] **Phase 7 — Onboarding:** scrape endpoint (live search), suggestion chips, first-agent synthesis, polish pass on every surface.

---

## 10. Missing Credentials (blockers to resolve)

1. **Twilio Account SID (`AC…`)** — the provided `SK…` API key + secret authenticate *under* an account; REST calls require the Account SID. Also need (or will purchase via API) a **Twilio phone number**.
2. **Supabase API keys** — anon + service_role (dashboard → Settings → API). The Postgres string covers SQL, but Storage (recordings) and any client-side reads need them.
3. **Vercel durable token** — the machine's CLI oauth token expired 2026-07-02 10:24 PDT (refresh token lets the CLI self-renew, but autonomous tool deploys call the REST API and need a dashboard-created long-lived token).
4. **GitHub access to `harshag1/CallCenter`** — this machine's `gh` is authed as `harshagundala`, which cannot create/push to `harshag1/*`. Create the repo from the `harshag1` account (or grant `harshagundala` write access).
5. **Resend domain check** — the provided key must belong to the account where `auth.meshia.io` is verified, else sends from `callcenter@auth.meshia.io` will 403. One test send confirms.
6. Covered, for the record: web search (xAI built-in — no extra key), scheduling (Vercel cron — no extra service), flow chart / UI (no external service), env-vault + cron + MCP secrets (generated, in `.env`).

Security note: `.env` is gitignored (verified); all provisioned keys should be rotated before real traffic.

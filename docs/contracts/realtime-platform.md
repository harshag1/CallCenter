# Realtime Platform — Shared Contracts (read this first)

Three workstreams build in parallel against these contracts. Do not edit files owned by another workstream. Shared primitives you may USE (never rewrite): `lib/db.ts (q, qOne, pool)`, `lib/log.ts`, `lib/auth.ts (getSession)`, `lib/xai.ts (chat, chatJSON, chatStream, research, researchJSON, MODELS)`, `lib/voice.ts (signScope, verifyScope, loadActiveAgent)`, `lib/flow.ts`, `lib/surface-dsl.ts`, `lib/knowledge.ts`, `migrations/004_platform.sql` (applied — do not modify).

## Realtime event bus (workstream A builds, everyone consumes)

- Server: `GET /api/events/stream` — SSE, session-authed. One dedicated pg client `LISTEN org_events`; forwards rows where `orgId === session.orgId` as `data: {kind, callId, eventId?, type?, payload?, status?, satisfaction?, ts?}`. Heartbeat comment every 15s. `maxDuration = 800`.
- Client: `components/hooks/useLiveEvents.ts` — `useLiveEvents(onEvent: (ev: LiveEvent) => void)`: EventSource, exponential reconnect, silent fallback to 3s polling `/api/calls/recent-events` if SSE fails twice.
- LiveEvent type lives in `lib/realtime-types.ts` (workstream A writes it, others import).

## call_events vocabulary (existing + new)

Existing types: `user_said {text}`, `agent_said {text}`, `tool_call {name,args}`, `tool_result {name,result}`, `state {node?|step?|hold?|transfer?|state?}`, `error`.
New (workstream A emits from bridge): `audio_start {at}` (recording began — timeline zero), `speech {who:'caller'|'agent', at}` (turn boundary), `human_segment {text, at}` (post-transfer human-leg transcript chunk), `hold_start {seconds, until}` / `hold_end {}`.

## Satisfaction / review (workstream B)

`calls.satisfaction` 1–10 (5 normal, 1 furious), `calls.resolution` `ai_resolved|human_resolved|unresolved`, `calls.review` text. Populated post-call by `lib/analysis.ts: analyzeCall(callId)`.

## Datasets (workstream B builds API + tools; C builds UI)

- REST: `GET/POST /api/datasets` (list, create {name, columns}), `GET/POST/PATCH/DELETE /api/datasets/[id]/rows`. All org-scoped via session.
- Auto-seed per org on first list: `customers` dataset (columns: name, phone, email, notes) and `feedback` dataset (phone, rating, comment).
- MCP tools (in lib/mcp.ts, workstream B owns this file): `read_table {table, filter?, limit?}`, `write_table {table, row, match?}` (upsert when match given). Enforced: datasets only, org-scoped. Voice context injection: on session build, look up caller in `customers` by from_number + last 3 call summaries → prepend "CALLER CONTEXT" block to instructions.

## Experiments (workstream B API + operator tools; C UI)

- Variant assignment at voice-session build: running experiment for agent → weighted pick of `agent_version`; stamp `calls.experiment_id/variant`.
- `GET /api/experiments` + `GET /api/experiments/[id]/metrics` → per-variant: calls, avg satisfaction, resolution split, satisfaction-over-time series.
- Operator tools: `create_experiment {name, hypothesis, variants:[{label, instructions_patch}]}` (creates new agent_versions per variant + screens row), `stop_experiment`.

## Screens (Notion-like; B: API + operator tool `create_screen`; C: UI)

`screens` table rows; spec = Surface DSL blocks. Experiment screens render live metrics; plain screens render their spec.

## Files (workstream B)

- documents.kind: `knowledge` (existing embed path), `media` (mp3/wav — store raw in documents.data, NO embedding), `data` (csv/json — store raw AND embed nothing).
- Upload route branches by extension. Media: if meta.hold_music, transcode mp3→8kHz μ-law via `mpg123-decoder` (WASM) + downsample, store in media_renditions kind 'ulaw8k'.
- Operator tools: `list_files`, `parse_csv {document_id}` (papaparse → preview rows), `import_csv {document_id, table}` (rows → dataset), `run_js {code, document_id?}` (node:vm sandbox, 5s timeout, file buffer as `input`, return JSON-serializable), `set_hold_music {document_id}` (marks meta + kicks transcode).
- Voice `hold` tool (lib/mcp.ts): emits `hold_start {seconds, until}` event, sleeps, emits `hold_end`. If agent has hold music rendition, bridge streams it during hold (A wires bridge side: on hold_start event via LISTEN or in-process flag — simplest: MCP hold handler inserts hold_start; bridge polls?? NO: bridge cannot know — instead hold music plays client-side in Try mode (CallWidget) and via bridge on PSTN using a `media_renditions` lookup at session start; bridge receives `x-hold` marker frames — SIMPLIFICATION: bridge checks for hold_start via its own DB poll every 2s ONLY while a call is live. Acceptable.)

## UI (workstream C owns app/workspace/**, components/platform/**)

Rebuild workspace as the platform: left rail (Home, Calls, Tables, Screens list); Home = birds-eye live board; Calls = table w/ expandable row (player + aligned timeline + shaded transcript + review); Tables = dataset grid; Screens = Notion-like pages incl. experiment dashboards. Right col: flow panel (full flow on Home; per-call traversal when a call is open) + operator chat (existing /api/chat SSE). Live hold countdown chip on flow node + call rows. Transcript shading: caller turns get `rgba(239,68,68, alpha)` where alpha scales (5→0, 1→0.5) when satisfaction < 5.

## File ownership

- **A (realtime+audio)**: lib/realtime-types.ts, app/api/events/stream/route.ts, app/api/calls/recent-events/route.ts, components/hooks/useLiveEvents.ts, lib/bridge.ts (recording, speech events, human-segment observe mode, hold music playback), app/api/telephony/twiml (only transfer TwiML change), lib/stt.ts (whisper via OPENAI_API_KEY), recording GET route (wav wrapping).
- **B (intelligence+data)**: lib/analysis.ts, lib/experiments.ts, lib/datasets.ts, lib/files.ts, lib/mcp.ts, app/api/datasets/**, app/api/experiments/**, app/api/screens/**, app/api/knowledge (branch by kind), lib/voice.ts (context injection + variant pick), lib/agent/tools/** additions + index.
- **C (platform UI)**: app/workspace/**, components/platform/**, components/flow/FlowPanel.tsx, CallWidget hold-music playback + countdown.
- Integrator (main session): final build, conflicts, deploy.

## Conventions

File headers `// Author: Harsha Gundala`, light comments, q()/qOne() for SQL, zod v4, Tailwind v4 classes, lucide icons, all-white theme, no mega files. Do NOT run `npm run dev` (a dev server is already running); do not run `npm run build` (integrator builds).

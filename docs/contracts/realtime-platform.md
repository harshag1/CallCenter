# Realtime Platform — Architecture Notes

## Realtime event bus

- Server: `GET /api/events/stream` — SSE, session-authed. A dedicated Postgres client `LISTEN`s on `org_events` (NOTIFY triggers on `call_events` and `calls`, see `migrations/004_platform.sql`) and forwards rows scoped to the session's org as `data: {kind, callId, eventId?, type?, payload?, status?, satisfaction?, ts?}`. Heartbeat comment every 15s.
- Client: `components/hooks/useLiveEvents.ts` — EventSource with exponential reconnect and a silent 3s-polling fallback (`/api/calls/recent-events`) that keeps retrying SSE. Event types live in `lib/realtime-types.ts`.

## call_events vocabulary

`user_said {text}` · `agent_said {text}` · `human_segment {text, at, track}` (post-transfer human leg, Whisper-transcribed) · `tool_call {name,args}` · `tool_result` · `state {node|step|transfer|…}` · `audio_start {at}` (recording origin, timeline zero) · `speech {who, at}` (turn boundaries) · `hold_start {seconds, until}` / `hold_end` · `task_done`.

## Post-call analysis

`lib/analysis.ts: analyzeCall(callId)` rebuilds the transcript from events and writes `calls.satisfaction` (1–10; judged from the customer's own words), `calls.resolution` (`ai_resolved | human_resolved | unresolved`), and `calls.review` (narrative). It also detects mid-sentence cutoffs and, per the agent's `recall_policy`, schedules a callback carrying the cutoff context (`parent_call_id` links the legs). Fired on call completion, with a cron sweep as backstop for calls whose serving context died before `waitUntil` ran.

## Datasets (user tables)

`datasets` + `dataset_rows` (jsonb rows) back the Tables UI and the voice tools `read_table`/`write_table` (org-scoped; `calls`/`logs` are never writable). Flexible schema: unknown row keys auto-become columns so agent writes are never invisible. REST: `GET/POST /api/datasets`, `GET/POST/PATCH/DELETE /api/datasets/[id]/rows`, column ops via `PATCH /api/datasets/[id]`. Row inserts NOTIFY `dataset_update` so open grids refresh live.

## Experiments

Variants are cloned `agent_versions` (instruction patches) with weighted assignment at voice-session build; each call is stamped `experiment_id`/`variant`. Metrics (`/api/experiments/[id]`) aggregate only engaged calls (≥1 `user_said`): per-variant call counts, avg satisfaction, avg duration, resolution split, plus the raw call list for the scatter view.

## Screens

`screens` rows are Notion-style pages: plain screens render Surface-DSL specs; experiment screens render the live A/B dashboard. Created conversationally (`create_screen`, `create_experiment`) with immediate navigation via the operator loop's `navigate` event.

## Files

`documents.kind`: `knowledge` (chunk → embed → vector search), `media` (raw audio; optional hold-music transcode to 8kHz μ-law in `media_renditions`), `data` (CSV → auto-imported dataset; small CSVs also embed). See `docs/storage.md` and `docs/contracts/infra-stack.md` for the storage/RAG providers.

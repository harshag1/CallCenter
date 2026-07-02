# Harsha's Amazing Call Center

Agent-centric voice-agent builder for enterprises. A Grok-powered operator agent with real authority — it generates UIs, builds and deploys its own tools to Vercel edge, creates storage tables, edits voice-agent prompts and call flows, inspects calls and recordings, places outbound calls, and schedules recalls — all from one chat box.

## Stack

Next.js on Vercel · Supabase (Postgres + Storage) · xAI Grok (`grok-voice-latest` realtime + `grok-4-latest` operator) · Twilio (PSTN via xAI SIP) · Resend (OTP auth) · React Flow

## Layout

- `web/` — the app (UI, API routes, MCP gateway, cron)
- `bridge/` — Twilio Media Streams ↔ xAI realtime audio bridge (μ-law passthrough; Dockerfile included). Run: `XAI_API_KEY=… APP_ORIGIN=… node bridge/server.js`, verify with `node bridge/simulate-call.mjs`
- `docs/plans/` — architecture + implementation plan

## Live

Production: https://callcenter-dun.vercel.app — agent-minted tools deploy to the separate `callcenter-tools` Vercel project.

## Run

```bash
cd web && npm install && npm run dev
```

Secrets live in `web/.env.local` (never committed). See `docs/plans/2026-07-02-callcenter-platform.md` for the full system design.

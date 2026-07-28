# Web application

The Next.js application for Harsha's Amazing Call Center. Start with the repository [README](../README.md) for setup, architecture, providers, and Flow v2.

Use the repository-pinned Node.js 22.13.0. The exact supported engine range is Node.js `^20.19.0 || ^22.13.0 || >=24.0.0`.

```bash
cp .env.example .env.local
npm ci
npm run db:migrate
npm run dev
```

Set `ALLOW_DEV_DEPLOYMENT_FUNDED_AI=true` in `.env.local` only when you accept spending your own provider key and `PUBLIC_ORIGIN` is plain-HTTP loopback. It permits local builder, onboarding-AI, and browser-session provider calls. Production and non-loopback origins ignore the flag because this release does not yet ship tenant-scoped BYOK or durable provider-budget authority.

The builder chat is provider-neutral. It defaults to the existing xAI model, or
you can select any supported Chat Completions provider and pin its model:

```dotenv
HACC_BUILDER_PROVIDER=openai # xai, openai, or gemini
HACC_BUILDER_MODEL=gpt-5.2
OPENAI_API_KEY=...
```

For Gemini, use `GEMINI_API_KEY` and a Gemini model id; for xAI, use
`XAI_API_KEY`. Provider choice is server-owned deployment configuration, not a
browser/model-controlled argument. Missing credentials and unknown providers
fail before network I/O.

The example `DATABASE_SSL=disable` is valid only for the local loopback database. Production and remote databases use `verify-full`; do not put `sslmode` or other TLS parameters in the connection URL.

For anonymous email OTP, self-hosted deployments must set `AUTH_TRUSTED_CLIENT_IP_HEADER` to an allowed client-IP header that their trusted proxy overwrites. Vercel selects its sanitized platform header automatically. Missing or untrusted source configuration fails closed.

Useful commands:

- `npm run check` — tests, lint, and TypeScript; 19 conditional PostgreSQL
  suites require disposable database URLs, while two real-ASR suites require
  the separately documented pinned local environment and release receipt.
- `npm run build` — production Next.js build.
- `npm run db:migrate` — apply the 36 ordered SQL migrations (`001`–`036`).
- `npm run db:test-isolation` — prove the full migration/RLS/role chain in a disposable local cluster.
- `npm run audit:public` — scan the publishable worktree and reachable Git history for release-secret patterns.
- `npm run test:watch` — iterate on the pure flow/provider contracts.

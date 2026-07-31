# Web application

The Next.js application for Harsha's Amazing Call Center. Start with the repository [README](../README.md) for setup, architecture, providers, and Flow v2.

Use the repository-pinned Node.js 22.13.0. The exact supported engine range is Node.js `^20.19.0 || ^22.13.0 || >=24.0.0`.

```bash
cp .env.example .env.local
npm ci
npm run db:migrate
npm run dev
```

Set `ALLOW_DEV_DEPLOYMENT_FUNDED_AI=true` in `.env.local` only when you accept spending your own deployment key and `PUBLIC_ORIGIN` is plain-HTTP loopback. It permits local builder, onboarding-AI, and browser-session calls. Production and non-loopback origins ignore the flag.

OpenAI and xAI browser calls also support tenant-scoped BYOK. Apply migration
`037`, configure `ENV_VAULT_MASTER_KEY`, sign in, and send the root once through
the authenticated same-origin route:

```js
await fetch("/api/voice/providers", {
  method: "POST",
  credentials: "same-origin",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "openai", credential: providerKey }),
});
```

Use `provider: "xai"` for xAI. `GET /api/voice/providers` reports non-secret
configuration status; `DELETE` with `{ provider }` removes the binding. The
root is context-authenticated in the org/provider vault and is used server-side
only to mint a provider ephemeral credential. It is never returned in the
browser connection payload. Every browser mint receives an explicit,
provider-bound funding authority; omitted authority and forged local markers
fail before provider I/O. Local authority is accepted only with non-production
plain-HTTP loopback; OpenAI/xAI tenant BYOK is accepted only with a canonical
non-loopback HTTPS origin or tunnel. A local marker cannot be carried to that
tunnel. Exact loopback mode selects the local authority even when a tenant root
is stored, so tenant roots are never used over plaintext HTTP. Gemini has no
tenant-BYOK browser path in this release, so its browser
session is loopback-development-only. Do not paste provider roots into builder
chat.

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
fail before network I/O. One builder turn shares a non-resettable authority
across every model sample and nested `web_search`: at most 8 provider requests
(6 builder, 2 research), 12 provider-emitted tool-call attempts, 12,000 reserved
output tokens, 2 MiB of serialized input, and 90 seconds total. Failed attempts
consume their reservation, disconnects abort in-flight transport, tool batches
reserve before execution, and the runtime performs no retry.

Background call tasks, post-call QA, onboarding generation, and grounded
research share a separate budget-aware server inference boundary. Configure
`HACC_INFERENCE_PROVIDER` / `HACC_INFERENCE_MODEL`, with optional
`HACC_RESEARCH_PROVIDER` / `HACC_RESEARCH_MODEL` overrides. Each operation has
hard request, input-byte, output-token, and timeout ceilings; it does not retry
or silently switch providers. Adapter transport is limited to one guarded
fetch per reserved operation; legacy background-task failures are terminal
until an operator explicitly reconciles and requeues them. See
[server inference](../docs/server-inference.md).

The example `DATABASE_SSL=disable` is valid only for the local loopback database. Production and remote databases use `verify-full`; do not put `sslmode` or other TLS parameters in the connection URL.

For anonymous email OTP, self-hosted deployments must set `AUTH_TRUSTED_CLIENT_IP_HEADER` to an allowed client-IP header that their trusted proxy overwrites. Vercel selects its sanitized platform header automatically. Missing or untrusted source configuration fails closed.

Useful commands:

- `npm run check` — tests, lint, and TypeScript; environment-qualified
  PostgreSQL and real-ASR suites are tracked by the source-bound Gate 0
  inventory and run by their release gates.
- `npm run build` — production Next.js build.
- `npm run db:migrate` — apply every ordered SQL migration in `migrations/`.
- `npm run db:test-isolation` — prove the full migration/RLS/role chain in a disposable local cluster.
- `npm run audit:public` — scan the publishable worktree and reachable Git history for release-secret patterns.
- `npm run test:watch` — iterate on the pure flow/provider contracts.

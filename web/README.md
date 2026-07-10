# Web application

The Next.js application for Voice Agent Studio. Start with the repository [README](../README.md) for setup, architecture, providers, and Flow v2.

```bash
cp .env.example .env.local
npm install
npm run db:migrate
npm run dev
```

Useful commands:

- `npm run check` — tests, lint, and TypeScript.
- `npm run build` — production Next.js build.
- `npm run db:migrate` — apply ordered SQL migrations.
- `npm run test:watch` — iterate on the pure flow/provider contracts.

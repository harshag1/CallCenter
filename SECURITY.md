# Security

## Reporting

Do not open a public issue for a vulnerability. Submit a [private GitHub security advisory](https://github.com/harshag1/CallCenter/security/advisories/new), or email `harsha.usa1@gmail.com` if private reporting is unavailable. Expect an acknowledgement within three business days; remediation/disclosure timing depends on severity and whether a coordinated provider fix is required.

Include the affected commit, route/module, reproduction, impact, and any evidence that secrets or tenant data were exposed. Do not access data that is not yours.

Only the current default branch is security-supported; historical snapshots and forks may not receive fixes. Good-faith research that avoids privacy violations, service disruption, persistence, social engineering, and unnecessary data access will not be pursued by the project owner. Allow reasonable time for a fix before disclosure.

## Threat model

The protected assets are tenant data, provider and integration credentials, signed call/action authority, durable workflow state, tool receipts, recordings/transcripts, and benchmark evidence. The application server, database, deployment operator, configured secret store, and explicitly admitted builder operators are trusted. The stock OTP flow does not establish that operator-admission boundary. The following inputs are untrusted even when they look well formed:

- caller speech, uploaded files, retrieved documents, and transcript text;
- model output, function arguments, tool-call IDs, and delayed or duplicated provider events;
- browsers, telephony/webhook requests, external MCP servers, and downstream API responses; and
- agent-authored tool source and every secret explicitly granted to that source.

The framework is designed to reduce authority at those boundaries through organization-scoped authentication, signed call scopes, short-lived Flow grants, receipt-backed state, reserve-before-dispatch admission, opaque one-time credential references, and allowlisted public audit projections. These controls contain classes of bad input; they do not make an untrusted model, generated program, external service, or compromised host trustworthy.

Out of scope are a malicious authenticated operator, compromise of the application host/database/vault master key, provider-side compromise, guaranteed exactly-once behavior from an opaque non-idempotent downstream API, and jurisdiction-specific compliance. Use separate infrastructure controls for those risks.

## Public-release boundary

The repository contains meaningful local security controls, but it is not a hosted security or compliance product. Use an access-restricted development deployment until you have reviewed and tested the boundaries below in your own topology:

- The stock email/phone OTP flow is demo self-registration. A newly verified user becomes a high-authority builder/operator. Add an explicit invitation/admission policy, abuse controls, rate limits, recovery policy, and tenant lifecycle before public signup.
- Anonymous email OTP rate limiting requires a trustworthy client-address source. On Vercel, the application uses the platform-overwritten `x-vercel-forwarded-for`; self-hosted deployments must set `AUTH_TRUSTED_CLIENT_IP_HEADER` only to an allowed header their own edge overwrites. Never trust an arbitrary forwarded header. The application HMACs the canonical client IP for abuse accounting and does not persist the raw address; without a trusted source, OTP issuance fails closed with `429`.
- OpenAI and xAI browser realtime sessions may use an authenticated organization-scoped BYOK root. The root is context-authenticated under `ENV_VAULT_MASTER_KEY`, selected by the server-owned agent provider, and used only to mint a provider ephemeral credential; it is never serialized into the browser connection. Built-in browser adapters never infer spend authority from a missing argument: they require the exact-provider tenant root or an identity-checked, process-local marker that can be minted only after the plain-HTTP loopback development checks pass. Session construction also binds origin class to authority: local markers require non-production plain-HTTP loopback, while tenant BYOK requires canonical non-loopback HTTPS. Builder inference, onboarding AI/research, and Gemini browser sessions still lack production spend authority and fail closed there; Gemini has no tenant-BYOK browser path in this release. `ALLOW_DEV_DEPLOYMENT_FUNDED_AI=true` is accepted only outside production with a plain-HTTP loopback `PUBLIC_ORIGIN`, for a developer spending their own deployment key on their own machine; copying it to a tunnel or deployment does not enable those routes.
- The optional outbound-speech gate is browser-only and quarantines the whole
  generated utterance before scheduling. It matches exact normalized phrases
  and configured secret literals; optional independent ASR requires tenant
  OpenAI BYOK and adds full-utterance plus ASR latency. A passing receipt proves
  browser `AudioContext` scheduling, not physical playback, human hearing,
  semantic safety, truthfulness, or PSTN coverage.
- Funded email, SMS, voice, number assignment, and campaign actions require server-authored cost quotes, durable reservation, and exact browser approval. That controls application dispatch; it does not establish that a carrier delivered a message or completed a call, and it does not replace provider-account spend limits.
- The standalone Twilio bridge has call-bound bootstrap authentication, exact upgrade-signature verification, bounded queues, capability rotation, and gateway tool routing. It remains development/non-production until the release commit has provider/PSTN canaries, multi-instance replay evidence, load/soak results, monitoring, and an explicit decision about crash loss from its in-memory event journal.
- Browser recording has one-use consent and upload authority, retention bounds, deletion tombstones, and tenant checks. The supplied Twilio bridge paths do not persist PSTN audio. Operators still own lawful consent, notice, retention, export, and deletion policy.
- External MCP is disabled in production unless the exact hostname allowlist and deployment network-guard assertion are configured. The assertion is not a socket-layer proof against DNS rebinding; use an audited egress proxy/firewall or the address-pinning connector boundary described in [the extension guide](docs/extending-tools.md).
- Generated tools and an optional external JavaScript sandbox execute code outside the application process, but isolation does not make that code trustworthy. Generated code can exfiltrate any explicitly granted value and make consequential public requests.
- Generic private logs, transcripts, action arguments/results, and provider errors may contain personal or sensitive data. The public-audit and benchmark projections have narrower redaction contracts; do not assume those contracts apply to every application log.

These are disclosure boundaries, not claims that the mechanisms are broken or absent. Preserve the development classification where a live or operational evidence packet is still missing.

## Deployment guidance

- Generate independent secrets for auth-code HMAC, MCP/call authority, campaign commitments, telephony receipts, cron authentication, and vault encryption. Never reuse one secret across purposes.
- Keep all provider keys server-side. Never add them to `NEXT_PUBLIC_*` variables.
- Use HTTPS/WSS and a trusted database certificate in production. `DATABASE_SSL=disable` is accepted only for a non-production loopback database; production and remote connections default to `verify-full`. Put TLS policy in `DATABASE_SSL`, not connection-string `sslmode`, `ssl`, certificate, or key parameters, which the runtime rejects to prevent override ambiguity.
- xAI SIP uses Standard Webhooks signatures plus a durable webhook receipt/replay ledger. Twilio TwiML/status and bridge upgrades validate the provider signature against the exact public URL. Preserve raw-body/header bytes through the edge and rerun the provider-specific security tests after proxy changes.
- Keep `ENABLE_TOOL_FACTORY=false` unless you accept generated-code, outbound-egress, and third-party deployment risk.
- Production optional egress also requires `HACC_ENABLE_EXTERNAL_EGRESS=true` plus the exact capability flag. These flags acknowledge operator intent; they are not spend authority, tenant BYOK, destination trust, or approval for a model to deploy code. `create_tool` is not model-callable until a funded-approval adapter exists.
- Never paste env values, provider roots, or external-MCP Authorization into builder chat. The authenticated same-origin `/api/voice/providers` route is the narrow OpenAI/xAI browser-call BYOK sink. The separate `/api/credentials/ingest` workflow is for external tool credentials and is not a realtime or builder-model BYOK path.
- `query_data` uses a fixed resource allowlist, fixed projections, bound parameters, and an organization predicate; raw model-authored SQL and public `manage_table` are disabled. `run_js` is absent unless an external HTTPS sandbox and independent bearer are configured; application-process `vm` execution is not used.
- Treat minted tools, external MCP servers, telephony, email, SMS, and operator actions as high-authority capabilities. Restrict builder access to trusted users.
- Treat `bridge/server.js` as development/non-production until the release packet in [the bridge runbook](bridge/RUNBOOK.md) exists. Do not weaken strict provider acknowledgement to make a canary pass.
- Add edge/platform rate limiting to login, provider-session, MCP, telephony, upload, and generated-tool routes.
- Keep provider/webhook verification fail closed; do not add an integration route that acts before signature and replay admission.
- Define browser-call recording consent, retention, deletion, access, and export policy for your jurisdiction. Do not claim PSTN recording from this repository.
- Pin provider models before production and regression-test flow scenarios when changing them.
- Rotate credentials immediately if a secret enters Git history; deleting the working-tree file is insufficient.
- Back up and version a vault-key rotation plan before changing `ENV_VAULT_MASTER_KEY`; the current single-key vault does not automatically re-encrypt older ciphertext, so an uncoordinated rotation makes stored secrets unreadable.
- Run every ordered migration in `web/migrations/`. Use separate non-owner
  `hacc_runtime`/`hacc_worker_runtime` logins; the schema enables and forces RLS
  and revokes public/API-role access, but an owner, superuser, or `BYPASSRLS`
  application connection defeats that boundary. See
  [database tenancy](docs/database-tenancy.md).

### Upgrading legacy generated tools

Older releases copied `MCP_GATEWAY_SECRET` into a shared Vercel tool project as `TOOL_SHARED_SECRET` and passed the entire deployment environment to generated code. Treat that gateway secret and every secret attached to the old shared project as exposed.

Before re-enabling the tool factory after upgrade:

1. Rotate `MCP_GATEWAY_SECRET` and invalidate old gateway URLs/tokens.
2. Delete the legacy shared Vercel project environment values and disable its deployments.
3. Run all migrations, then redeploy each generated tool so it receives an isolated V2 project and public-key wrapper.
4. Confirm the tool has a pinned invocation key revision before attaching it to an agent.

The runtime deliberately refuses unsigned legacy tools; it does not silently fall back to the old shared bearer.

## Trust boundaries

Provider models and external MCP/tool servers receive state-conditioned context where the runtime path supports it, but they remain third parties. Review their data retention and regional processing policies. Agent-authored tool source executes outside the main app in an isolated project and receives only explicitly granted vault values, but it is trusted with those values and isolation does not make arbitrary outbound requests safe.

Only named public-audit, benchmark-journal, credential-ingest, and remote-MCP paths apply dedicated redaction. Generic application logs and the private action/receipt ledger can contain PII, full arguments, results, and errors; restrict access and retention accordingly. Hash chains show internal consistency relative to a trusted head, not authenticated origin. See the benchmark [artifact assurance boundary](benchmarks/voice-long-horizon/ARTIFACTS.md) for the separate roles of signatures and replay.

The included implementation is not a compliance certification. Operators remain responsible for authentication policy, tenant lifecycle, audit review, data residency, accessibility, emergency behavior, and applicable telephony/AI laws.

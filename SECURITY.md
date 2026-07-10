# Security

## Reporting

Do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting for this repository, or contact the repository owner privately.

Include the affected commit, route/module, reproduction, impact, and any evidence that secrets or tenant data were exposed. Do not access data that is not yours.

## Deployment guidance

- Generate independent 32-byte secrets for auth-code HMAC, MCP scope signing, and vault encryption.
- Keep all provider keys server-side. Never add them to `NEXT_PUBLIC_*` variables.
- Use HTTPS/WSS and a trusted database certificate in production.
- Configure `XAI_SIP_SIGNING_SECRET`; unsigned xAI SIP webhooks are rejected in production.
- Keep `ENABLE_TOOL_FACTORY=false` unless you accept generated-code, outbound-egress, and third-party deployment risk.
- Treat `manage_table`, minted tools, external MCP servers, telephony, email, and SMS as high-authority capabilities. Restrict builder access to trusted users.
- Add edge/platform rate limiting to login, provider-session, MCP, telephony, upload, and generated-tool routes.
- Define call recording consent, retention, deletion, access, and export policy for your jurisdiction.
- Pin provider models before production and regression-test flow scenarios when changing them.
- Rotate credentials immediately if a secret enters Git history; deleting the working-tree file is insufficient.

## Trust boundaries

Provider models and external MCP/tool servers receive the minimum context required for their work but remain third parties. Review their data retention and regional processing policies. Agent-authored tool source executes outside the main app in an isolated project, but isolation does not make arbitrary outbound requests safe.

The included implementation is not a compliance certification. Operators remain responsible for authentication policy, tenant lifecycle, audit review, data residency, accessibility, emergency behavior, and applicable telephony/AI laws.

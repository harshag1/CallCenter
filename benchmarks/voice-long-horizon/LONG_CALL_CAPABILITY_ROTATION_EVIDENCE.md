# Long-call capability rotation evidence

Status: development evidence, generated 2026-07-17 UTC from an in-progress
pre-release worktree. The recorded counts are historical development evidence;
rerun every command at the final clean release commit before treating this as
release attestation.

Provider sessions opened: **0**. Provider spend: **$0**. These are deterministic
protocol, logical-clock, route, and storage tests; they are not evidence of
provider model quality.

## Claim under test

The framework can keep local tool and event authority live across voice calls
longer than the original 30-minute capability lifetime without issuing a
long-lived bearer, leaking renewal authority to a model provider, or silently
resetting the active flow catalog.

The bounded design is:

- Every MCP, event, and renewal bearer expires after 30 minutes.
- Rotation becomes eligible at minute 25, creating at most five minutes of
  overlap for already in-flight work.
- Browser renewal requires an authenticated cookie, strict same-origin Fetch
  Metadata, a dedicated `browser_refresh` bearer, and an exact idempotency key.
- Bridge renewal requires a dedicated `bridge_refresh` bearer bound to the
  organization, call, provider, Twilio AccountSid/CallSid/StreamSid, session,
  and bridge instance.
- Durable state stores only domain-separated JTIs and timestamps, never bearer
  bytes. One row lock and compare-and-swap advance exactly one generation.
- An exact lost-response retry reconstructs the same response while the old
  renewal bearer remains live. It fails at the old bearer's expiry even though
  the newly committed generation has a later expiry.
- Catalog authority is independent of credential rotation. Bootstrap persists
  the first server-authored catalog digest/epoch; later MCP result envelopes
  advance it. Credential swaps preserve, and never rewind, that state.

## Numerical results

| Gate | Result | What it exercises |
| --- | ---: | --- |
| Focused rotation matrix | **40/40** | Issuance, actual browser session wiring, browser/bridge routes, atomic store, logical clocks, lost responses, strict ingress |
| Broad provider + telephony matrix | **285/285** | OpenAI/xAI/Gemini adapters, local gateway, provider protocol normalization, MCP route, bridge bootstrap/event/capability boundaries |
| Standalone bridge suite | **126/126** | Bootstrap v3, provider lifecycle, catalog-bound MCP, event journal, rotation client, bridge session, server integration |
| Standalone bridge line coverage | **88.68%** | All bridge files |
| Standalone bridge branch coverage | **76.40%** | All bridge files |
| Standalone bridge function coverage | **87.18%** | All bridge files |
| Capability rotation client line coverage | **89.92%** | Standalone bridge renewal client |

## Long-horizon observations

### Browser path

The logical clock starts at `T+0` with generation 0. At `T+25m`, the gateway
rotates once, drops the capability-bound MCP session, and performs a fresh MCP
handshake. At `T+31m`, after generation 0 is expired, another tool call succeeds
with generation 1. Observed tool authorization generations are exactly
`[0, 1, 1]`; observed MCP initialize count is exactly `2`.

A simulated lost rotation response retries with byte-identical JSON,
Authorization, and Idempotency-Key. Starting at the expiry boundary instead
performs **zero network requests** and fails closed.

### Standalone bridge path

The bridge rotates at `T+25m`, retains the old authority only through its exact
expiry, and successfully executes a tool with generation 1 at `T+31m`. It
rotates again at `T+56m`; observed requested generations are exactly `[1, 2]`,
and event-journal scopes advance exactly to generations `[1, 2]`. The session
remains ready and its catalog digest/epoch remain unchanged by both credential
swaps.

When renewal never settles, the bridge closes at capability expiry instead of
continuing with stale authority.

## Reproduction

From `web/`:

```bash
npx vitest run \
  lib/__tests__/capability-rotation.test.ts \
  lib/__tests__/capability-rotation-store.test.ts \
  lib/__tests__/voice-browser-rotation-wiring.test.ts \
  lib/__tests__/voice-capability-rotation-route.test.ts \
  lib/__tests__/telephony-capability-rotation-route.test.ts \
  components/call/providers/capability-gateway.test.ts
```

The broad 285-test command is intentionally explicit in the working log and
should be captured by the final release proof packet rather than abbreviated to
a mutable test glob.

From `bridge/`:

```bash
npm run check
npm test
npm run test:coverage
```

## Current release caveat

The focused and broad provider/rotation gates above are green. A subsequent
fresh `npm run db:test-isolation` reached an unrelated, concurrently changing
cost-summary assertion and failed at
`web/scripts/test-tenant-isolation.mjs:1006` with provider-reported
`18000` micro-USD and reconciled `7800` micro-USD. No provider session or spend
was involved. The database gate must be green again at the final clean commit;
this document does not waive it.

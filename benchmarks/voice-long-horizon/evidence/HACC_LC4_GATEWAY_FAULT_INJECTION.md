# LC4 Gateway ToolAttempt Firewall — Provider-Free Fault Injection

**Mechanism evidence only. This is not provider efficacy, model quality, acoustic quality, or production safety evidence.**

Artifact: `7737570f5eabc3ed5d2c74df02c67b5d62d9d8463e4edb2bf1751f1aa24d7402`
Firewall source: `f45febe6f237d993bd9e222ae04cb7af740bbdb5`
Bridge: `lc4-dev-gateway-bridge-v5`

## Exact results

- 33 deterministic coordinator scenarios
- 15/15 recoverable fault scenarios contained
- 15/15 provenance, replay, abuse, and delivery faults failed closed
- 0 unauthorized executor calls
- 0 false authority projections
- 21 rejected tool attempts observed in sealed evidence or fatal diagnostics
- 0 provider API calls; network access was not authorized

| Event shape | Clean controls | Recoverable contained | Security fatal | Unauthorized executor calls | False authority projections |
|---|---:|---:|---:|---:|---:|
| openai | 1 | 5 | 5 | 0 | 0 |
| gemini | 1 | 5 | 5 | 0 | 0 |
| xai | 1 | 5 | 5 | 0 | 0 |

## What was exercised

Every row invokes the production `Lc4DevGatewayTurnCoordinator`, not a reimplementation. Canonical faults cover unknown intents, forbidden model arguments, malformed semantic envelopes, and atomic rejection of mixed valid/invalid batches. Repair-phase attempts verify that speech repair cannot acquire tool authority. Fatal cases cover provenance tampering, replayed call identities, oversized batches, bounded-rejection-loop abuse, and result-delivery failure.

A contained fault must return a bounded provider-visible rejection, request exactly one continuation, invoke no executor, emit no authority projection, and retain a sanitized rejection receipt. A fatal security fault must terminate the coordinator with the expected fatal class before any executor call or authority projection.

## Claim boundary

These deterministic, synthetic events show that the checked-in firewall mechanism enforces its local invariants for the enumerated cases. They do not measure how often OpenAI, Gemini, or xAI produce these faults; they do not compare providers or establish end-to-end voice-agent efficacy.

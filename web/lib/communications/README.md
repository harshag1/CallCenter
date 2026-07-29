# Communication provider adapters

This directory defines the provider-neutral boundary for email, SMS, outbound
voice, and phone-number purchasing. It is deliberately separate from provider
SDKs and from the durable operator-action ledger.

The contract has four non-negotiable stages:

1. `validateConfiguration` returns a private provider configuration, private
   account identity, and a digest that changes whenever dispatch-relevant
   configuration or credential revision changes.
2. `prepareRequest` normalizes the exact destination and provider request.
   `quote` returns integer micro-USD units plus pricing, formula, and limit
   hashes. The runtime wraps configuration, account, destination, and request
   identities in keyed public bindings.
3. `dispatchCommunication` recomputes the approved quote, then asks an injected
   durable authority claimer to atomically consume the sole provider attempt for
   that reservation. Provider mutation/dispatch is unreachable before that
   claim. Configuration, request preparation, and quoting run first and therefore
   must be local/pure unless provider read traffic is separately authorized. The
   ledger-generated execution UUID is the only idempotency key passed to the
   adapter.
4. Provider acceptance remains `accepted`, never `delivered`. A terminal
   receipt requires either a signature-verified webhook or an authoritative
   provider read whose provider message, account, destination, and idempotency
   identities all match.

An adapter implements `CommunicationProviderAdapterV1` and is registered
explicitly with `defineCommunicationProviderAdapter`. Runtime package discovery
is intentionally absent: loading arbitrary packages or environment names would
create an unnecessary code-execution and configuration-oracle boundary.

## Failure semantics

- Invalid configuration, quote drift, expired quotes, request substitution, and
  missing reservation authority fail before dispatch.
- An exception or malformed response after the dispatch boundary is
  `indeterminate` and `retrySafe: false`. The runtime never infers provider
  absence from a timeout, network error, or 5xx.
- `authoritative_absent` is evidence for the durable ledger, not permission to
  automatically retry. A new dispatch decision remains outside this module.
- Raw configuration, provider account, destination, message content, and
  provider error bodies are excluded from public receipts.
- Terminal reconciliation requires a `TerminalCommunicationReceiptStoreV1`.
  Its database implementation must atomically reject lower/equal sequences and
  conflicting terminal transitions, while recognizing only an exact replay.

## Provider implementation checklist

- Use a provider-native idempotency key when available. Otherwise declare
  `exclusive-framework-ledger` and preserve the no-retry-on-ambiguity rule.
- Make `configurationIdentitySha256` domain-separated and sensitive to key
  rotation without returning secrets.
- Keep quote arithmetic in safe integer micro-USD and bump both the declared
  formula version and formula hash when arithmetic changes.
- Treat a create/send response as acceptance only.
- Verify webhook signatures over the provider-required raw URL, headers, and
  bytes before returning an event.
- Reconcile by the provider's immutable message ID or exact idempotency key.
  Never use destination-only searches as authoritative evidence.
- Run `provider-adapter.conformance.test.ts` patterns against the real adapter,
  including lost responses, identity substitution, and pricing drift.

## Current integration boundary

Browser-approved Resend email and Twilio SMS use
`operator-provider-adapters.ts` in the real operator dispatcher. They preserve
the established operator-action approval, reservation, replay, and settlement
ledger: the adapter authority claimer accepts only that ledger's exact,
exclusive execution UUID and exact approved cost bindings. Resend receives the
UUID as its provider idempotency key. Twilio SMS declares
`exclusive-framework-ledger` and remains do-not-retry after ambiguity.

The durable private operator result contains the complete Adapter v1 receipt,
including the opaque provider message ID and integrity/reconciliation bindings.
The browser and model projections continue to expose only the established safe
accepted/count fields. Provider errors, credentials, destinations, and message
content never enter the adapter receipt.

Outbound Twilio voice and phone-number purchasing have not yet moved behind
this interface. They retain their existing call/number-specific authority and
reconciliation ledgers; swapping those providers is not configuration-only.

The contract also cannot prove that provider code truly honors an idempotency
key or validates a webhook correctly. Each production adapter needs provider
fixture tests and, where available, a capped sandbox/canary before making those
claims.

`providerMessageId` and terminal `providerStatus` remain durable operator
evidence in the receipt schema. Some providers may place customer-linked data
in those fields, so receipts are not model- or end-user-safe presentation
objects. The bundled operator adapters require bounded opaque IDs, and the
UI/API projection redacts them.

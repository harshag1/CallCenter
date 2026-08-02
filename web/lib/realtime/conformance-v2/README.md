# Realtime lifecycle conformance v2

This package defines the provider-neutral evidence boundary above provider wire
normalizers. It does not connect to a provider and does not authorize tools.

The validator proves that a trace has:

- a provider-authored acknowledgement of the actual model, voice, settings,
  negotiated features, and provider session identity;
- stable connection-epoch, turn, response, audio-delta, tool-call, tool-result,
  and provider-event identities;
- audio, tool, usage, interruption, reconnect, and terminal events in a valid
  causal order; and
- explicit fail-closed negotiation when a required feature is unsupported.

Every provider observation is bound to an inbound physical connection, a
strictly increasing frame sequence, canonical exact frame bytes, verified byte
length and SHA-256 digest,
provider event identity, wire type, timestamp, and semantic claim. A provider
cancellation is a terminal cancellation; it is never accepted as a successful
tool-result acknowledgement.

An outbound `session.update`, `setup`, or equivalent request is never evidence
that the provider accepted those values. `client_request` evidence is present in
the input union solely so the validator can identify and quarantine that error
as `request_only_acknowledgement`.

Model, voice, and canonical settings digest parity are exact paid-readiness
requirements. A provider-resolved alias is retained as useful diagnostic
evidence but fails conformance when it differs from the registered request.

## Adapter integration

Provider adapters should translate already-observed wire events into
`RealtimeLifecycleEvent` values and feed them to one
`RealtimeLifecycleConformanceValidator` per logical session. A trace is
claim-capable only when `report().passed` is true. The current OpenAI, Gemini,
and xAI fixtures are fake offline traces containing provider wire vocabulary;
they contain no credentials, customer data, SDK calls, or network behavior.

This layer intentionally does not infer provider support. Unsupported and
disabled features must be explicit in the acknowledged feature vector, and
every requested feature must have exactly one result.

## Evidence modes

- `configuration_only` proves only provider-acknowledged configuration. It is
  useful for adapter development and can never support a paid-readiness claim.
- `transport_media` additionally requires every enabled audio-input,
  audio-output, and interruption capability to be exercised.
- `paid_readiness` is the default. Every enabled negotiated capability must be
  exercised, including a successful tool round trip, provider usage evidence,
  and session resumption. Every completed tool call must be acknowledged or
  explicitly cancelled before the session may become terminal.

Reports expose both mode-relative `passed` and the stricter `paidReady` flag;
the latter is structurally false for either weaker mode.

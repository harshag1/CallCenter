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

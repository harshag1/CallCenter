# Outbound speech quarantine

`OutboundSpeechGate` is a provider-neutral state machine for holding generated
PCM until a policy decision is complete. It does not become an enforcement
boundary merely by being instantiated: every output byte must be routed through
the gate, and no direct provider audio path may remain connected to playout.

## Enforceable contract

For each response, the transport integration must:

1. Begin a gate response at the provider's response-start event.
2. Copy every generated PCM chunk into `pushAudio`; do not enqueue or play it.
3. Send final provider transcripts to `pushProviderTranscript` when available.
4. Mark the exact provider terminal state with `markTerminal`.
5. Call `finalizeResponse` and enqueue `decision.audio` only for `action=release`.
6. Cancel the provider response and discard held PCM for either suppress action.
7. For `suppress_and_regenerate`, start a distinct response ID with a
   host-authored repair instruction; never reuse or unquarantine the rejected
   bytes.
8. Call `expireResponse` from the collection watchdog. A stalled response is
   suppressed, not partially released.

The default policy requires an independent ASR receipt bound to the SHA-256,
byte length, format, and duration of the exact concatenated held PCM. A provider
transcript may corroborate that result, but it is not exact PCM coverage.

Decisions contain hashes, safe rule IDs, and secret fingerprints. They never
contain provider/ASR transcript text or raw configured secrets. Callers must
also avoid logging the in-memory policy object, ASR input, or raw ASR receipt.

## Current provider integration gaps

- The server-side OpenAI/xAI normalized client emits `output.audio`, final
  `output.transcript`, and `response.completed`. It is structurally compatible,
  but its consumers do not yet route playout through this gate.
- The server-side Gemini client emits the same normalized event classes.
  Provider transcription is disabled by default, so independent played-PCM ASR
  is the required evidence source.
- The browser xAI adapter calls `playPcm16` immediately on every output-audio
  delta. That direct call must be replaced by response-scoped quarantine.
- The browser Gemini adapter likewise calls `playPcm16` on every inline PCM
  part before its independently ordered output transcript is complete.
- The browser OpenAI WebRTC adapter connects the remote media source directly
  to `AudioContext.destination`. A real enforcement integration must replace
  that connection with a capture/worklet buffer or use a server WebSocket audio
  path. Observing the data-channel transcript while the media track remains
  connected is not enforcement.

Until those paths are rewired and integration-tested, the module is an isolated
primitive and the product must not claim that caller playout is guarded.

## Security boundary

The gate can mechanically prevent release of buffered PCM when its configured
detectors find an exact normalized secret or forbidden phrase, or when evidence
is missing, mismatched, late, oversized, or malformed. Independent ASR remains
probabilistic: paraphrases, homophones, recognition errors, and semantic claims
outside the configured phrase set are defense-in-depth gaps. Host-side action
authorization and receipt validation remain the authoritative guardrail.

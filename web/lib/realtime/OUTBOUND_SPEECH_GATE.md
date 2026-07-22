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

This strong mode adds at least the full generated-utterance duration plus ASR
time before first playout. The defaults cap collection at 150 seconds, buffered
audio at 120 seconds, and post-generation evidence at 15 seconds. A future
streaming/lookahead gate can reduce latency, but cannot claim whole-response
coverage unless it retains every chunk until the terminal policy decision.

Decisions contain hashes, safe rule IDs, and secret fingerprints. They never
contain provider/ASR transcript text or raw configured secrets. Callers must
also avoid logging the in-memory policy object, ASR input, or raw ASR receipt.

## Browser integration status

- The server-side OpenAI/xAI normalized client emits `output.audio`, final
  `output.transcript`, and `response.completed`. It is structurally compatible,
  but its consumers do not yet route playout through this gate.
- The server-side Gemini client emits the same normalized event classes.
  Provider transcription is disabled by default, so independent played-PCM ASR
  is the required evidence source.
- The browser xAI and Gemini adapters support response-scoped quarantine when
  `RealtimeTransportStart.outboundSpeechGate` is present. They buffer every PCM
  chunk, finalize only at `response.done` / `turnComplete`, and schedule only
  released bytes. Agent output transcripts are held on the same response
  boundary, so rejected speech is not copied into the UI or `agent_said` audit
  event first. `RealtimeCall` persists the content-free gate evidence in its
  existing audit event stream.
- Each release receipt binds the decision's aggregate audio SHA-256 and byte
  count to exact byte offsets and `AudioContext` scheduled time ranges. Its
  evidence level is deliberately `audio_context_schedule`: a browser cannot
  prove that a physical speaker rendered sound or that a human heard it.
- A `suppress_and_regenerate` decision invokes the optional host-owned repair
  callback with hashes and safe rule IDs only; the rejected audio is never
  exposed to that callback or playout.
- The browser OpenAI WebRTC adapter connects the remote media source directly
  to `AudioContext.destination`. It therefore rejects startup before gateway,
  WebRTC, or network side effects whenever an outbound gate is requested. A
  real enforcement integration must replace that connection with a
  capture/worklet buffer or use a server WebSocket audio path. Observing the
  data-channel transcript while the media track remains connected is not
  enforcement.

The option is not enabled by default because the product must supply an
independent ASR implementation and policy. Calls without the option retain the
legacy direct-playout behavior and must not be described as speech-guarded.

## Security boundary

The gate can mechanically prevent release of buffered PCM when its configured
detectors find an exact normalized secret or forbidden phrase, or when evidence
is missing, mismatched, late, oversized, or malformed. Independent ASR remains
probabilistic: paraphrases, homophones, recognition errors, and semantic claims
outside the configured phrase set are defense-in-depth gaps. Host-side action
authorization and receipt validation remain the authoritative guardrail.

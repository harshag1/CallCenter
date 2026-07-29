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

The default policy requires a versioned, server-HMAC-authenticated independent
ASR receipt bound to the organization, web call, voice provider, provider
response ID, PCM SHA-256, byte length, sample rate, transcript hash, ASR model,
and decision. A provider transcript may corroborate that result, but it is not
exact PCM coverage.

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
- The browser OpenAI WebRTC adapter now replaces the direct remote-track
  destination edge with `remote track -> muted PCM processor -> zero-gain
  destination` whenever a gate is present. Float samples from that graph are
  converted to PCM16 and held by the same response-scoped gate. The data
  channel terminal waits one bounded render tail before sealing the response,
  then only released PCM is scheduled into `AudioContext`. Recording receives
  that released schedule, never the quarantined remote track. If capture nodes
  are unavailable, a second remote audio track appears, response identities
  overlap, or the media/data-channel boundary drifts, the guarded connection
  closes instead of adding a direct playout fallback.

## Enabling the stock browser path

The ordinary `CallWidget -> RealtimeCall` path automatically composes the gate
when the token response contains a server-authored `speechGuardrail` bootstrap.
Agent versions can opt in with:

```json
{
  "speech_guardrail": {
    "mode": "enforce",
    "forbidden_terminal_claims": [
      {
        "phrase": "your refund is complete",
        "rule_id": "refund.requires_receipt"
      }
    ],
    "secrets": [
      {
        "value": "the literal phrase that must never be spoken",
        "rule_id": "privacy.protected_phrase"
      }
    ]
  }
}
```

The operator `update_agent` tool accepts this object directly. The host removes
it from provider settings, fingerprints configured secrets, and binds the
bootstrap to the exact call and provider. The browser validates that authority
before asking for microphone permission.

Independent ASR is a same-origin, authenticated route over the exact aggregate
PCM. It verifies canonical base64, byte count, duration, sample rate, SHA-256,
active web-call ownership, provider identity, and that speech enforcement is
enabled before invoking ASR. A durable one-shot claim binds that request before
provider dispatch. Exact settled replays return the authenticated cached
receipt; pending, failed, indeterminate, or identity-changing replays never
dispatch again. Per-call and serialized per-organization/day limits reserve
the conservative ASR ceiling before spend.

The route requires the authenticated tenant's encrypted OpenAI BYOK credential.
The deployment `OPENAI_API_KEY` is deliberately not ASR spend authority. Each
receipt is HMAC-SHA-256 authenticated under
`HACC_OUTBOUND_SPEECH_ASR_RECEIPT_HMAC_KEY`; cached receipts are reverified
server-side, while the browser and gate independently recompute the transcript
and canonical receipt digests against the exact call/provider/response/PCM
tuple. Transcript text never enters the content-free gate audit event.

Before enabling a per-agent policy or deployment-wide enforcement, configure
an independent receipt key plus explicit integer micro-USD ceilings:

```dotenv
HACC_OUTBOUND_SPEECH_ASR_RECEIPT_HMAC_KEY=
HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_WEB_CALL=120000
HACC_OUTBOUND_SPEECH_ASR_MAX_MICRO_USD_PER_ORG_DAY=600000
```

Generate the blank key with `openssl rand -base64 48`. The example limits are
$0.12 per web call and $0.60 per organization per UTC day. A missing, malformed,
or exhausted authority fails before provider dispatch.

Set `HACC_REQUIRE_BROWSER_SPEECH_GUARDRAILS=1` to make enforcement mandatory
for every browser call. Only absent, `0`, and `1` are accepted; a typo fails
closed instead of silently disabling enforcement. In that mode, a missing
tenant ASR credential, malformed policy, cross-call bootstrap, unavailable
OpenAI WebRTC capture graph, or ASR failure fails closed. Without the deployment
setting or per-agent opt-in, calls retain legacy direct playout and the UI
reports no `speech guarded` status.

## Security boundary

The gate can mechanically prevent release of buffered PCM when its configured
detectors find an exact normalized secret or forbidden phrase, or when evidence
is missing, mismatched, late, oversized, or malformed. Independent ASR remains
probabilistic: paraphrases, homophones, recognition errors, and semantic claims
outside the configured phrase set are defense-in-depth gaps. Host-side action
authorization and receipt validation remain the authoritative guardrail.

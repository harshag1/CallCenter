# HACC response-plan authority boundary

`hacc_response_plan` is a signed, hash-chained projection of public Flow state. It is useful model context, but it is not an authorization token and is never the final enforcement boundary.

Machine-enforced authority remains in the host capability gateway, receipt-backed Flow transitions, ambiguity quarantine, and the outbound speech gate. Every response plan therefore carries:

```json
{"context_authority":"advisory_only_gateway_and_speech_gate_enforced"}
```

The realtime journal distinguishes three events:

- `caller.response_plan_derived`: the kernel derived and transcript-bound a plan.
- `caller.response_plan_prepared`: the provider adapter accepted the plan for the next response.
- `caller.response_plan_delivery_submitted`: response creation succeeded locally. When the adapter exposes wire observations, this event binds the exact provider frame by observation and payload hashes.

## Provider delivery semantics

- OpenAI and xAI: the adapter composes immutable session instructions with the dynamic plan and catalog in `response.create.response.instructions`. It never replaces the base safety prompt for a prepared HACC response.
- Gemini Live: setup system instructions are immutable. The adapter sends the plan and catalog as `realtimeInput.text` before `activityEnd`. This proves wire ordering, not privileged instruction authority. Google documents realtime text as a concurrent input stream whose cross-modality processing order is not guaranteed. HACC therefore classifies this channel as `unprivileged_realtime_input_text` and does not claim it is equivalent to a system instruction.

Gemini reference: <https://ai.google.dev/api/live>

Passing a model-alignment benchmark can support a claim that this advisory context improves behavior. It cannot support a claim that Gemini gave the plan privileged control-plane status. Safety claims must be grounded in gateway admission, receipts, quarantine, and speech-gate evidence.

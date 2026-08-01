import {
  PROVIDER_CONTROL_OR_COMMIT_ACK_TIMEOUT_MS,
} from "./realtime-control-timeout";

/**
 * LC4-DEV has multiple sequential timeout owners inside one opportunity:
 * paced caller audio, provider control/commit acknowledgement, provider
 * response, and the condition-blind local listener. The runner watchdog is an
 * emergency fuse only. It must never race an inner owner and replace that
 * component's retained, replayable failure evidence with a generic timeout.
 */
export const LC4_DEV_TIMEOUT_CONTRACT = Object.freeze({
  // Frozen corpus maximum is 7,776.25 ms (the op-42 branch rendition).
  maximum_frozen_paced_input_ms: 8_000,
  // A retained xAI Gate D session reached manual commit but did not return
  // input_audio_buffer.committed inside the former 5 s bound. Keep this
  // acknowledgement independently bounded, while allowing ordinary provider
  // scheduling jitter before any response generation is requested.
  maximum_provider_control_or_commit_ack_ms:
    PROVIDER_CONTROL_OR_COMMIT_ACK_TIMEOUT_MS,
  // A retained Gemini 3.1 Flash Live response emitted 2,052,990 PCM bytes
  // (42.77 seconds at 24 kHz mono PCM16) before its terminal frame. Leave
  // enough headroom for a similarly sized response to reach the terminal
  // without converting valid provider output into a local timeout.
  provider_response_ms: 75_000,
  // A conversational response that exceeds 65 seconds of generated PCM is a
  // runaway generation, even when the provider emits it faster than realtime.
  // The longest completed retained Gemini response is 59.98 seconds. This
  // independent media-duration fuse bounds memory/cost and wakes the response
  // waiter before the wall-clock timeout can misclassify the failure.
  maximum_provider_output_audio_ms: 65_000,
  listener_asr_ms: 600_000,
  post_inner_timeout_evidence_margin_ms: 30_000,
  opportunity_emergency_watchdog_ms: 730_000,
} as const);

export const LC4_DEV_MINIMUM_OPPORTUNITY_WATCHDOG_MS =
  LC4_DEV_TIMEOUT_CONTRACT.maximum_frozen_paced_input_ms
  + LC4_DEV_TIMEOUT_CONTRACT.maximum_provider_control_or_commit_ack_ms
  + LC4_DEV_TIMEOUT_CONTRACT.provider_response_ms
  + LC4_DEV_TIMEOUT_CONTRACT.listener_asr_ms
  + LC4_DEV_TIMEOUT_CONTRACT.post_inner_timeout_evidence_margin_ms;

if (
  LC4_DEV_TIMEOUT_CONTRACT.opportunity_emergency_watchdog_ms
  < LC4_DEV_MINIMUM_OPPORTUNITY_WATCHDOG_MS
) {
  throw new Error("LC4-DEV opportunity watchdog races an inner timeout owner");
}

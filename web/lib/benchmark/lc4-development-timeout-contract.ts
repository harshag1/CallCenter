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
  maximum_provider_control_or_commit_ack_ms: 5_000,
  provider_response_ms: 45_000,
  listener_asr_ms: 600_000,
  post_inner_timeout_evidence_margin_ms: 30_000,
  opportunity_emergency_watchdog_ms: 700_000,
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

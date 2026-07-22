import { canonicalJson, sha256Hex } from "./artifacts";

/** Exact documented xAI server-VAD policy frozen for every LC4 arm and qualification. */
export const LC4_XAI_SERVER_VAD = Object.freeze({
  type: "server_vad" as const,
  threshold: 0.85,
  silence_duration_ms: 500,
  prefix_padding_ms: 333,
  idle_timeout_ms: null,
});

export const LC4_XAI_SERVER_VAD_SHA256 = sha256Hex(
  `harshas-amazing-call-center/lc4-xai-server-vad/v1\n${canonicalJson(LC4_XAI_SERVER_VAD)}`,
);

export const LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE = Object.freeze({
  provider: "xai" as const,
  transport: "provider_native_server_vad" as const,
  initial_turn_client_events: Object.freeze(["session.update", "input_audio_buffer.append"] as const),
  initial_turn_provider_events: Object.freeze([
    "session.updated",
    "input_audio_buffer.speech_started",
    "input_audio_buffer.speech_stopped",
    "input_audio_buffer.committed",
    "response.created",
  ] as const),
  initial_manual_commit_forbidden: true as const,
  initial_manual_response_create_forbidden: true as const,
  post_tool_response_create_required: true as const,
  interruptions_prohibited: true as const,
});

export const LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256 = sha256Hex(
  `harshas-amazing-call-center/lc4-xai-server-vad-disclosure/v1\n${canonicalJson(LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE)}`,
);

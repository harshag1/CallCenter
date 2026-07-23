import { canonicalJson, sha256Hex } from "./artifacts";

/** Exact documented xAI server-VAD policy frozen for every LC4 arm and qualification. */
export const LC4_XAI_SERVER_VAD = Object.freeze({
  type: "server_vad" as const,
  threshold: 0.85,
  silence_duration_ms: 500,
  prefix_padding_ms: 333,
});

export const LC4_XAI_SERVER_VAD_SHA256 = sha256Hex(
  `harshas-amazing-call-center/lc4-xai-server-vad/v2\n${canonicalJson(LC4_XAI_SERVER_VAD)}`,
);

/**
 * xAI's native server VAD observes streamed media, not wall-clock silence after
 * the final append. Keep the caller fixture byte-exact and append this separate
 * zero-PCM transport delimiter so the configured 500 ms silence window can
 * close deterministically even when the fixture itself ends on speech.
 */
export const LC4_XAI_SERVER_VAD_SILENCE_TAIL = Object.freeze({
  schema_version: 1 as const,
  purpose: "server_vad_end_of_speech_delimiter" as const,
  encoding: "pcm16le" as const,
  sample_rate_hz: 24_000 as const,
  channels: 1 as const,
  duration_ms: 800 as const,
  sample_value: 0 as const,
  byte_length: 38_400 as const,
  chunk_ms: 20 as const,
  chunk_count: 40 as const,
  generation: "exact_zero_pcm_not_caller_audio" as const,
  caller_audio_mutated: false as const,
});

export const LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256 = sha256Hex(
  `harshas-amazing-call-center/lc4-xai-server-vad-silence-tail/v1\n${canonicalJson(LC4_XAI_SERVER_VAD_SILENCE_TAIL)}`,
);

export const LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256 = sha256Hex(
  new Uint8Array(LC4_XAI_SERVER_VAD_SILENCE_TAIL.byte_length),
);

export const LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE = Object.freeze({
  provider: "xai" as const,
  transport: "provider_native_server_vad" as const,
  initial_turn_client_events: Object.freeze(["session.update", "input_audio_buffer.append"] as const),
  initial_turn_provider_events: Object.freeze([
    "session.created",
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
  caller_audio_preserved_byte_exact: true as const,
  end_of_speech_delimiter: Object.freeze({
    policy_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_SHA256,
    pcm_sha256: LC4_XAI_SERVER_VAD_SILENCE_TAIL_PCM_SHA256,
    duration_ms: LC4_XAI_SERVER_VAD_SILENCE_TAIL.duration_ms,
    purpose: LC4_XAI_SERVER_VAD_SILENCE_TAIL.purpose,
    counted_as_caller_audio: false as const,
  }),
});

export const LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256 = sha256Hex(
  `harshas-amazing-call-center/lc4-xai-server-vad-disclosure/v3\n${canonicalJson(LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE)}`,
);

import { canonicalJson, sha256Hex } from "./artifacts";
import {
  LIVE_STS_PROVIDER_SPECS,
  type LiveStsProvider,
} from "./live-sts-development-experiment";
import { LOCAL_TOOL_PROXY_FUNCTION_NAME } from "../realtime/client/types";
import {
  LC4_XAI_SERVER_VAD,
  LC4_XAI_SERVER_VAD_SHA256,
  LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256,
} from "./xai-server-vad";

export const LC4_PROVIDER_PROFILE_ID = "HACC-LC4-provider-profiles-v3" as const;
export const LC4_PROVIDER_PROFILE_VERIFIED_AT = "2026-07-22" as const;

const PROFILE_HASH_DOMAIN =
  "harshas-amazing-call-center/lc4-provider-profile-manifest/v3\n";

export const LC4_PROVIDER_PRIMARY_SOURCES = Object.freeze({
  openai: Object.freeze([
    "https://developers.openai.com/api/docs/models/gpt-realtime-2.1",
    "https://developers.openai.com/api/reference/resources/realtime",
  ]),
  gemini: Object.freeze([
    "https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview",
    "https://ai.google.dev/gemini-api/docs/live-api/capabilities",
    "https://ai.google.dev/api/live",
  ]),
  xai: Object.freeze([
    "https://docs.x.ai/developers/model-capabilities/audio/voice-agent",
    "https://docs.x.ai/developers/model-capabilities/audio/voice",
  ]),
});

/**
 * Non-treatment settings that must remain identical inside every matched pair.
 * The raw prompt/catalog and HACC response plan/catalog are the intervention and
 * therefore deliberately excluded from this list.
 */
export const LC4_MATCHED_PAIR_INVARIANTS = Object.freeze([
  "provider",
  "versioned_model",
  "provider_voice",
  "response_modality_audio",
  "input_pcm_encoding_rate_channels",
  "output_pcm_encoding_rate_channels",
  "turn_boundary_mode",
  "single_static_capability_gateway_function_schema",
  "tool_choice_auto_or_provider_equivalent",
  "temperature_omitted",
  "reasoning_configuration_omitted",
  "session_resumption_disabled",
  "timeout_and_retry_policy",
] as const);

const common = Object.freeze({
  response_modality: "audio" as const,
  input_encoding: "pcm16le_mono" as const,
  output_encoding: "pcm16le_mono" as const,
  provider_visible_tool_surface: Object.freeze({
    mode: "single_static_function" as const,
    function_name: LOCAL_TOOL_PROXY_FUNCTION_NAME,
    tool_choice: "auto_or_provider_equivalent" as const,
  }),
  temperature_request: "omitted_provider_default" as const,
  reasoning_request: "omitted_provider_default" as const,
  session_resumption: "disabled" as const,
});

const profiles = Object.freeze({
  openai: Object.freeze({
    provider: "openai" as const,
    model: LIVE_STS_PROVIDER_SPECS.openai.model,
    voice: LIVE_STS_PROVIDER_SPECS.openai.voice,
    ...common,
    input_sample_rate_hz: 24_000,
    output_sample_rate_hz: 24_000,
    turn_boundary: "input_audio_buffer.commit_then_response.create" as const,
    context_delivery: Object.freeze({
      wire_field: "response.create.response.instructions" as const,
      authority: "per_response_instructions_override_session_instructions" as const,
      composition: "base_session_instructions_then_condition_specific_context" as const,
    }),
    function_calling: "provider_native_function_call_via_static_gateway" as const,
    setup_acknowledgement: "session.updated_exact_requested_transport_fields_required" as const,
  }),
  gemini: Object.freeze({
    provider: "gemini" as const,
    model: LIVE_STS_PROVIDER_SPECS.gemini.model,
    voice: LIVE_STS_PROVIDER_SPECS.gemini.voice,
    ...common,
    input_sample_rate_hz: 16_000,
    output_sample_rate_hz: 24_000,
    turn_boundary: "activityStart_audio_activityEnd" as const,
    context_delivery: Object.freeze({
      wire_field: "realtimeInput.text_before_activityEnd" as const,
      authority: "advisory_user_realtime_input_not_system_equivalent" as const,
      composition: "condition_specific_context_as_realtime_text" as const,
      cross_modal_ordering: "not_guaranteed_by_provider" as const,
    }),
    function_calling: "synchronous_only_no_async_function_calling" as const,
    context_window_compression: "sliding_window_enabled" as const,
    setup_acknowledgement: "setup_complete_does_not_echo_requested_configuration" as const,
  }),
  xai: Object.freeze({
    provider: "xai" as const,
    model: LIVE_STS_PROVIDER_SPECS.xai.model,
    voice: LIVE_STS_PROVIDER_SPECS.xai.voice,
    ...common,
    input_sample_rate_hz: 24_000,
    output_sample_rate_hz: 24_000,
    turn_boundary: "server_vad_speech_stop_auto_commit_auto_response" as const,
    turn_detection: LC4_XAI_SERVER_VAD,
    turn_detection_sha256: LC4_XAI_SERVER_VAD_SHA256,
    transport_disclosure_sha256: LC4_XAI_SERVER_VAD_TRANSPORT_DISCLOSURE_SHA256,
    context_delivery: Object.freeze({
      wire_field: "session.update.instructions_before_first_audio" as const,
      authority: "per_turn_session_update_ack_barrier_field_echo_may_be_unverifiable" as const,
      composition: "base_session_instructions_then_condition_specific_context" as const,
    }),
    function_calling: "provider_native_function_call_via_static_gateway" as const,
    setup_acknowledgement: "strict_transport_echo_not_required_by_current_adapter" as const,
  }),
});

function manifestBody() {
  return Object.freeze({
    schema_version: 1 as const,
    protocol_id: "HACC-LC4-v1" as const,
    profile_id: LC4_PROVIDER_PROFILE_ID,
    verified_at: LC4_PROVIDER_PROFILE_VERIFIED_AT,
    execution_authorized: false as const,
    evidence_status: "documentation_verified_profile_not_provider_execution_evidence" as const,
    matched_pair_contract: Object.freeze({
      identical_within_provider: LC4_MATCHED_PAIR_INVARIANTS,
      treatment_varying: Object.freeze([
        "prompt_and_context_construction",
        "logical_capability_catalog_exposed_through_the_static_gateway",
        "host_managed_state_guardrails_and_async_worker_semantics",
      ] as const),
      prohibited_hidden_differences: Object.freeze([
        "model_alias_or_snapshot",
        "voice",
        "audio_format_or_rate",
        "turn_detection",
        "temperature_or_reasoning_setting",
        "provider_tool_schema",
        "retry_or_timeout_policy",
      ] as const),
    }),
    interpretation_boundary: Object.freeze({
      within_provider_only: true as const,
      cross_provider_pooling_requires_heterogeneity_reporting: true as const,
      gemini_system_authority_equivalence_claimed: false as const,
      note: "Provider APIs are intentionally not represented as semantically identical; only each provider's paired arms are held wire-identical outside the treatment.",
    }),
    providers: profiles,
    primary_sources: LC4_PROVIDER_PRIMARY_SOURCES,
  });
}

export type Lc4ProviderProfileManifestBody = ReturnType<typeof manifestBody>;
export type Lc4ProviderProfileManifest = Lc4ProviderProfileManifestBody & Readonly<{
  manifest_sha256: string;
}>;

export function createLc4ProviderProfileManifest(): Lc4ProviderProfileManifest {
  const body = manifestBody();
  return Object.freeze({
    ...body,
    manifest_sha256: sha256Hex(`${PROFILE_HASH_DOMAIN}${canonicalJson(body)}`),
  });
}

export const LC4_PROVIDER_PROFILE_MANIFEST = createLc4ProviderProfileManifest();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Fail closed if a stored profile is edited, truncated, or silently re-pinned. */
export function assertLc4ProviderProfileManifest(
  value: unknown,
): asserts value is Lc4ProviderProfileManifest {
  if (!isRecord(value)) throw new Error("LC4 provider profile manifest must be an object");
  const { manifest_sha256: digest, ...body } = value;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("LC4 provider profile manifest digest is invalid");
  }
  const expected = sha256Hex(`${PROFILE_HASH_DOMAIN}${canonicalJson(body)}`);
  if (digest !== expected) throw new Error("LC4 provider profile manifest hash mismatch");
  if (canonicalJson(value) !== canonicalJson(createLc4ProviderProfileManifest())) {
    throw new Error("LC4 provider profile manifest differs from the frozen profile");
  }
  if (body.schema_version !== 1 || body.protocol_id !== "HACC-LC4-v1") {
    throw new Error("LC4 provider profile manifest protocol is unsupported");
  }
  if (body.profile_id !== LC4_PROVIDER_PROFILE_ID || body.verified_at !== LC4_PROVIDER_PROFILE_VERIFIED_AT) {
    throw new Error("LC4 provider profile identity drifted");
  }
  if (body.execution_authorized !== false) {
    throw new Error("LC4 provider profiles must not authorize provider execution");
  }
  if (!isRecord(body.providers)) throw new Error("LC4 provider profiles are missing");
  const providerNames = Object.keys(body.providers).sort();
  if (canonicalJson(providerNames) !== canonicalJson(["gemini", "openai", "xai"])) {
    throw new Error("LC4 provider profile set drifted");
  }
  for (const provider of providerNames as LiveStsProvider[]) {
    const profile = body.providers[provider];
    if (!isRecord(profile)) throw new Error(`LC4 ${provider} profile is invalid`);
    const pinned = LIVE_STS_PROVIDER_SPECS[provider];
    if (profile.model !== pinned.model || profile.voice !== pinned.voice) {
      throw new Error(`LC4 ${provider} model or voice differs from the runtime pin`);
    }
  }
  const gemini = body.providers.gemini;
  if (!isRecord(gemini) || !isRecord(gemini.context_delivery)
    || gemini.context_delivery.authority !== "advisory_user_realtime_input_not_system_equivalent") {
    throw new Error("LC4 Gemini authority boundary was weakened or misrepresented");
  }
}

import { canonicalJson, sha256Hex } from "./artifacts";
import { LC4_PROVIDER_PROFILE_MANIFEST } from "./lc4-provider-profiles";
import { trialAudioDeliveryProfileHash } from "./orchestrator";

/**
 * Source-independent caller-audio execution contract for LC4-DEV.
 *
 * Audio may be rendered at an older source commit, but it is admissible only
 * while these provider-format and production packetizer commitments still
 * match the code that will deliver it. A change here intentionally invalidates
 * every previously materialized audio manifest.
 */
export const LC4_DEV_AUDIO_DELIVERY_PROFILE = Object.freeze({
  schemaVersion: 1 as const,
  chunkMs: 20,
  pace: "realtime" as const,
});

export const LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256 = trialAudioDeliveryProfileHash(
  LC4_DEV_AUDIO_DELIVERY_PROFILE,
);

export const LC4_DEV_AUDIO_PACKETIZER_CONTRACT_SHA256 = sha256Hex(
  `harshas-amazing-call-center/lc4-dev-audio-packetizer-contract/v1\n${canonicalJson({
    runtime_version: "HACC-REALTIME-AUDIO-DELIVERY-v1",
    packetizer: "packetizeRealtimePcm16",
    delivery: "deliverRealtimePcm16",
    input_encoding: "pcm16le",
    channels: 1,
    delivery_profile_sha256: LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
  })}`,
);

export const LC4_DEV_AUDIO_EXECUTION_CONTRACT_SHA256 = sha256Hex(
  `harshas-amazing-call-center/lc4-dev-audio-execution-contract/v1\n${canonicalJson({
    provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    delivery_profile_sha256: LC4_DEV_AUDIO_DELIVERY_PROFILE_SHA256,
    packetizer_contract_sha256: LC4_DEV_AUDIO_PACKETIZER_CONTRACT_SHA256,
    provider_input_sample_rates_hz: Object.freeze({
      openai: LC4_PROVIDER_PROFILE_MANIFEST.providers.openai.input_sample_rate_hz,
      gemini: LC4_PROVIDER_PROFILE_MANIFEST.providers.gemini.input_sample_rate_hz,
      xai: LC4_PROVIDER_PROFILE_MANIFEST.providers.xai.input_sample_rate_hz,
    }),
  })}`,
);

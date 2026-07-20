import "server-only";

import type { RealtimeProviderAdapter } from "../types";
import { geminiAdapter } from "../providers/gemini";
import { openaiAdapter } from "../providers/openai";
import { xaiAdapter } from "../providers/xai";
import {
  normalizeLegacyClientEvent,
  wrapLegacyRealtimeProviderAdapter,
} from "./legacy-adapter";
import type {
  RealtimeProviderManifest,
  RealtimeProviderMediaProfile,
  RealtimeProviderPlugin,
} from "./types";

const PCM_24K = Object.freeze({
  id: "pcm-24k-mono",
  input: Object.freeze({
    encoding: "pcm-s16le" as const,
    sampleRateHz: 24_000,
    channels: 1 as const,
  }),
  output: Object.freeze({
    encoding: "pcm-s16le" as const,
    sampleRateHz: 24_000,
    channels: 1 as const,
  }),
});

const PCMU_8K = Object.freeze({
  id: "pcmu-8k-mono",
  input: Object.freeze({
    encoding: "pcmu" as const,
    sampleRateHz: 8_000,
    channels: 1 as const,
  }),
  output: Object.freeze({
    encoding: "pcmu" as const,
    sampleRateHz: 8_000,
    channels: 1 as const,
  }),
});

const GEMINI_PCM = Object.freeze({
  id: "gemini-pcm-mono",
  input: Object.freeze({
    encoding: "pcm-s16le" as const,
    sampleRateHz: 16_000,
    channels: 1 as const,
  }),
  output: Object.freeze({
    encoding: "pcm-s16le" as const,
    sampleRateHz: 24_000,
    channels: 1 as const,
  }),
});

type BuiltInMetadata = Readonly<{
  docsUrl: string;
  maturity: RealtimeProviderManifest["lifecycle"]["maturity"];
  mediaProfiles: readonly RealtimeProviderMediaProfile[];
  browser: RealtimeProviderManifest["transports"]["browser"];
  server: RealtimeProviderManifest["transports"]["server"];
  telephony: RealtimeProviderManifest["telephony"];
  normalizationInput: RealtimeProviderManifest["normalization"]["input"];
  streamedArguments: boolean;
  usage: RealtimeProviderManifest["metering"]["usage"];
  evidence: RealtimeProviderManifest["metering"]["evidence"];
}>;

const BUILT_IN_METADATA: Readonly<Record<RealtimeProviderAdapter["id"], BuiltInMetadata>> = {
  xai: {
    docsUrl: "https://docs.x.ai/developers/model-capabilities/audio/voice-agent",
    maturity: "preview",
    mediaProfiles: [PCM_24K, PCMU_8K],
    browser: [{ kind: "websocket", mediaProfileIds: [PCM_24K.id] }],
    server: [{
      kind: "websocket",
      mediaProfileIds: [PCM_24K.id, PCMU_8K.id],
    }],
    telephony: {
      support: "native-media",
      ingressMediaProfileIds: [PCMU_8K.id],
      providerMediaProfileIds: [PCMU_8K.id],
      notes: ["The server adapter can preserve 8 kHz G.711 μ-law through a telephony bridge."],
    },
    normalizationInput: "normalized-client-events",
    streamedArguments: true,
    usage: "mixed",
    evidence: "wire-observations",
  },
  openai: {
    docsUrl: "https://developers.openai.com/api/docs/guides/realtime",
    maturity: "stable",
    mediaProfiles: [PCM_24K, PCMU_8K],
    browser: [{ kind: "webrtc", mediaProfileIds: [PCM_24K.id] }],
    server: [{
      kind: "websocket",
      mediaProfileIds: [PCM_24K.id, PCMU_8K.id],
    }],
    telephony: {
      support: "native-media",
      ingressMediaProfileIds: [PCMU_8K.id],
      providerMediaProfileIds: [PCMU_8K.id],
      notes: ["The server adapter can preserve 8 kHz G.711 μ-law through a telephony bridge."],
    },
    normalizationInput: "normalized-client-events",
    streamedArguments: true,
    usage: "provider-reported",
    evidence: "wire-observations",
  },
  gemini: {
    docsUrl: "https://ai.google.dev/gemini-api/docs/live-api",
    maturity: "preview",
    mediaProfiles: [GEMINI_PCM, PCMU_8K],
    browser: [{ kind: "websocket", mediaProfileIds: [GEMINI_PCM.id] }],
    server: [],
    telephony: {
      support: "transcoding-bridge",
      ingressMediaProfileIds: [PCMU_8K.id],
      providerMediaProfileIds: [GEMINI_PCM.id],
      notes: ["PSTN media needs an application bridge between μ-law and asymmetric Gemini PCM."],
    },
    // The current Gemini client owns stateful wire normalization. Its adapter
    // wrapper receives those already-normalized client events.
    normalizationInput: "normalized-client-events",
    streamedArguments: false,
    usage: "provider-reported",
    evidence: "wire-observations",
  },
};

function manifestFor(adapter: RealtimeProviderAdapter): RealtimeProviderManifest {
  const metadata = BUILT_IN_METADATA[adapter.id];
  return {
    contractVersion: "1.0",
    id: adapter.id,
    label: adapter.label,
    docsUrl: metadata.docsUrl,
    defaultModel: adapter.defaultModel,
    defaultVoice: adapter.defaultVoice,
    environment: adapter.env,
    lifecycle: {
      maturity: metadata.maturity,
      since: "2026-07-19",
    },
    transports: {
      browser: metadata.browser,
      server: metadata.server,
    },
    mediaProfiles: metadata.mediaProfiles,
    telephony: metadata.telephony,
    tools: {
      delivery: "local-gateway",
      normalizedCalls: true,
      streamedArguments: metadata.streamedArguments,
    },
    normalization: {
      eventSchemaVersion: 1,
      input: metadata.normalizationInput,
      terminalResponseProvenance: true,
      toolCallBatching: "batch",
    },
    metering: {
      usage: metadata.usage,
      rawUsageRetained: true,
      evidence: metadata.evidence,
    },
  };
}

function pluginFor(adapter: RealtimeProviderAdapter): RealtimeProviderPlugin {
  return wrapLegacyRealtimeProviderAdapter({
    adapter,
    manifest: manifestFor(adapter),
    createEventNormalizer: () => ({
      push(event) {
        return Object.freeze([normalizeLegacyClientEvent(adapter.id, event)]);
      },
    }),
    // Existing normalized clients retain pending-call state and own the exact
    // provider wire serialization. The transitional wrapper hands them a
    // detached normalized batch; direct v1 plugins can emit their own command.
    encodeToolResults: (results) => Object.freeze(
      results.map(({ callId, output }) => Object.freeze({ callId, output })),
    ),
  });
}

/**
 * Contract-v1 wrappers around the existing adapters. Core runtime registration
 * remains unchanged for this release; consumers can opt into the plugin
 * registry and add providers without extending the legacy provider union.
 */
export const BUILT_IN_REALTIME_PROVIDER_PLUGINS = Object.freeze([
  pluginFor(xaiAdapter),
  pluginFor(openaiAdapter),
  pluginFor(geminiAdapter),
]);

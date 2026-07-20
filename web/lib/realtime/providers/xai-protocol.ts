import type { RealtimeAudioFormat, VoiceSessionSpec } from "../types";
import { LOCAL_TOOL_PROXY_FUNCTION } from "../client/types";
import { providerDirectMcpServers } from "./browser-direct-mcp";
import { providerTuning, settingsRecord } from "./settings";

export function buildXaiSessionUpdate(spec: VoiceSessionSpec, audio: RealtimeAudioFormat): Record<string, unknown> {
  const pcmu = audio === "pcmu";
  const configuredAudio = settingsRecord(spec.settings.audio);
  const configuredInput = settingsRecord(configuredAudio.input);
  const configuredOutput = settingsRecord(configuredAudio.output);
  const configuredResumption = settingsRecord(spec.settings.resumption);
  const providerDirectMcp = providerDirectMcpServers(spec);
  return {
    type: "session.update",
    session: {
      // xAI selects the model in the WebSocket query string, not session.update.
      ...providerTuning(spec.settings, [
        "type",
        "model",
        "voice",
        "instructions",
        "audio",
        "tools",
        "resumption",
        "experimental_provider_direct_mcp",
      ]),
      voice: spec.voice,
      instructions: spec.instructions,
      turn_detection: { type: "server_vad", ...settingsRecord(spec.settings.turn_detection) },
      audio: {
        input: {
          ...configuredInput,
          format: { type: pcmu ? "audio/pcmu" : "audio/pcm", rate: pcmu ? 8_000 : 24_000 },
          transcription: { ...settingsRecord(configuredInput.transcription), model: "grok-transcribe" },
        },
        output: {
          ...configuredOutput,
          format: { type: pcmu ? "audio/pcmu" : "audio/pcm", rate: pcmu ? 8_000 : 24_000 },
        },
      },
      tools: [
        LOCAL_TOOL_PROXY_FUNCTION,
        // xAI defines an explicit empty allowed_tools array as unrestricted.
        // Omit such a server even in explicitly experimental direct mode.
        ...(providerDirectMcp ? providerDirectMcp
          .filter((server) => server.allowedTools === undefined || server.allowedTools.length > 0)
          .map((server) => ({
            type: "mcp",
            server_label: server.label,
            server_url: server.serverUrl,
            ...(server.allowedTools !== undefined ? { allowed_tools: server.allowedTools } : {}),
            ...(server.authorization ? { authorization: server.authorization } : {}),
          })) : []),
      ],
      // Resumption is useful only when the host durably persists and presents
      // the conversation ID on reconnect. Provider support alone is not enough
      // to enable it safely for every session.
      ...(configuredResumption.enabled === true
        ? { resumption: { ...configuredResumption, enabled: true } }
        : {}),
    },
  };
}

/** Current xAI client-secret schema; 300 seconds matches the official browser example. */
export function buildXaiClientSecretPayload(): Record<string, unknown> {
  return { expires_after: { seconds: 300 } };
}

export function buildXaiBrowserProtocols(clientSecret: string): string[] {
  // RFC 6455 subprotocol values use the HTTP `token` grammar.
  if (!clientSecret || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(clientSecret)) {
    throw new Error("xAI client secret is not valid for a WebSocket subprotocol");
  }
  return [`xai-client-secret.${clientSecret}`];
}

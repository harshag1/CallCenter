import type { RealtimeAudioFormat, VoiceSessionSpec } from "../types";
import { LOCAL_TOOL_PROXY_FUNCTION } from "../client/types";
import { providerDirectMcpServers } from "./browser-direct-mcp";
import { providerTuning, settingsRecord } from "./settings";

export function buildOpenAISession(spec: VoiceSessionSpec, audio: RealtimeAudioFormat) {
  const configuredAudio = settingsRecord(spec.settings.audio);
  const configuredInput = settingsRecord(configuredAudio.input);
  const configuredOutput = settingsRecord(configuredAudio.output);
  const maxOutputTokens = openAIOutputTokenLimit(spec.settings);
  const providerDirectMcp = providerDirectMcpServers(spec);
  return {
    ...providerTuning(spec.settings, [
      "type",
      "model",
      "instructions",
      "max_output_tokens",
      "max_response_output_tokens",
      "output_modalities",
      "audio",
      "tools",
      "tool_choice",
      "experimental_provider_direct_mcp",
    ]),
    type: "realtime",
    model: spec.model,
    instructions: spec.instructions,
    // OpenAI permits either audio (with transcript) or text, not both. This is
    // an STS session, so never let generic tuning silently disable audio.
    output_modalities: ["audio"],
    ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
    audio: {
      input: {
        ...configuredInput,
        format: audio === "pcmu" ? { type: "audio/pcmu" } : { type: "audio/pcm", rate: 24000 },
        transcription: { model: "gpt-realtime-whisper", ...settingsRecord(configuredInput.transcription) },
        turn_detection: { type: "server_vad", ...settingsRecord(configuredInput.turn_detection) },
      },
      output: {
        ...configuredOutput,
        format: audio === "pcmu" ? { type: "audio/pcmu" } : { type: "audio/pcm", rate: 24000 },
        voice: openAIVoice(spec.voice),
      },
    },
    tools: [
      LOCAL_TOOL_PROXY_FUNCTION,
      ...(providerDirectMcp ? providerDirectMcp
        .filter((server) => server.allowedTools === undefined || server.allowedTools.length > 0)
        .map((server) => ({
          type: "mcp",
          server_label: server.label,
          server_url: server.serverUrl,
          ...(server.allowedTools !== undefined ? { allowed_tools: server.allowedTools } : {}),
          ...(server.authorization ? { authorization: server.authorization } : {}),
          // Experimental direct mode has already acknowledged consequential
          // execution. Avoid a second provider-owned approval state machine.
          require_approval: "never",
        })) : []),
    ],
    tool_choice: "auto",
  };
}

function openAIOutputTokenLimit(settings: Record<string, unknown>): number | "inf" | undefined {
  const current = settings.max_output_tokens;
  const legacy = settings.max_response_output_tokens;
  if (current !== undefined && legacy !== undefined && current !== legacy) {
    throw new Error("OpenAI max_output_tokens conflicts with legacy max_response_output_tokens");
  }
  const value = current ?? legacy;
  if (value === undefined) return undefined;
  if (value === "inf") return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4_096) {
    return value;
  }
  throw new Error("OpenAI max_output_tokens must be an integer from 1 to 4096 or 'inf'");
}

function openAIVoice(voice: string): string | { id: string } {
  if (!voice.startsWith("voice_")) return voice;
  if (!/^voice_[A-Za-z0-9_-]+$/.test(voice)) {
    throw new Error("OpenAI custom voice ID must be a canonical voice_ identifier");
  }
  return { id: voice };
}

export function buildOpenAIClientSecretPayload(session: Record<string, unknown>) {
  return {
    expires_after: { anchor: "created_at", seconds: 600 },
    session,
  };
}

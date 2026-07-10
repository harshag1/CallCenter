import type { RealtimeAudioFormat, VoiceSessionSpec } from "../types";
import { providerTuning, settingsRecord } from "./settings";

export function buildOpenAISession(spec: VoiceSessionSpec, audio: RealtimeAudioFormat) {
  const configuredAudio = settingsRecord(spec.settings.audio);
  const configuredInput = settingsRecord(configuredAudio.input);
  const configuredOutput = settingsRecord(configuredAudio.output);
  return {
    ...providerTuning(spec.settings, ["type", "model", "instructions", "audio", "tools", "tool_choice"]),
    type: "realtime",
    model: spec.model,
    instructions: spec.instructions,
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
        voice: spec.voice,
      },
    },
    tools: spec.mcpServers.map((server) => ({
      type: "mcp",
      server_label: server.label,
      server_url: server.serverUrl,
      ...(server.allowedTools?.length ? { allowed_tools: server.allowedTools } : {}),
      ...(server.authorization ? { authorization: server.authorization } : {}),
    })),
    tool_choice: "auto",
  };
}

export function buildOpenAIClientSecretPayload(session: Record<string, unknown>) {
  return {
    expires_after: { anchor: "created_at", seconds: 600 },
    session,
  };
}

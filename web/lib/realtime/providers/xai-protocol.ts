import type { RealtimeAudioFormat, VoiceSessionSpec } from "../types";
import { providerTuning, settingsRecord } from "./settings";

export function buildXaiSessionUpdate(spec: VoiceSessionSpec, audio: RealtimeAudioFormat): Record<string, unknown> {
  const pcmu = audio === "pcmu";
  const configuredAudio = settingsRecord(spec.settings.audio);
  const configuredInput = settingsRecord(configuredAudio.input);
  const configuredOutput = settingsRecord(configuredAudio.output);
  return {
    type: "session.update",
    session: {
      ...providerTuning(spec.settings, ["voice", "instructions", "audio", "tools", "resumption"]),
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
      tools: spec.mcpServers.map((server) => ({
        type: "mcp",
        server_label: server.label,
        server_url: server.serverUrl,
        ...(server.allowedTools?.length ? { allowed_tools: server.allowedTools } : {}),
        ...(server.authorization ? { authorization: server.authorization } : {}),
      })),
      resumption: { ...settingsRecord(spec.settings.resumption), enabled: true },
    },
  };
}

import { VOICE_TOOL_EXTENSIONS } from "./extensions";
import { VoiceToolRegistry } from "./registry";

export const voiceToolExtensions = new VoiceToolRegistry(VOICE_TOOL_EXTENSIONS);
export type { VoiceToolDefinition, VoiceToolExtension, VoiceToolScope } from "./types";

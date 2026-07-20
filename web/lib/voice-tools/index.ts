import { VOICE_TOOL_PACKS } from "./extensions";
import { composeVoiceToolPacks } from "./packs";
import { VoiceToolRegistry } from "./registry";

export const voiceToolExtensions = new VoiceToolRegistry(composeVoiceToolPacks(VOICE_TOOL_PACKS));
export {
  normalizeVoiceToolSchema,
  detachBoundedVoiceToolJson,
  voiceToolAdmissionScopeDigest,
  voiceToolDefinitionDigest,
} from "./schema";
export { composeVoiceToolPacks, defineVoiceToolPack } from "./packs";
export type { VoiceToolPack } from "./packs";
export type {
  VoiceToolDefinition,
  PinnedVoiceToolDefinition,
  PreparedVoiceToolInvocation,
  VoiceToolExecutionContext,
  VoiceToolExtension,
  VoiceToolPreparedExecutionFailureCode,
  VoiceToolPreparedExecutionResult,
  VoiceToolPreflightRejection,
  VoiceToolPreflightRejectionCode,
  VoiceToolPreflightResult,
  VoiceToolScope,
} from "./types";

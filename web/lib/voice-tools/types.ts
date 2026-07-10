export type VoiceToolScope = { callId: string; agentId: string; orgId: string };

export type VoiceToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type VoiceToolExtension = VoiceToolDefinition & {
  /** Optional tenant/call-aware availability check. */
  isAvailable?: (scope: VoiceToolScope) => boolean | Promise<boolean>;
  execute: (args: Record<string, unknown>, scope: VoiceToolScope) => unknown | Promise<unknown>;
};

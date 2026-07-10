import type { VoiceToolDefinition, VoiceToolExtension, VoiceToolScope } from "./types";

const TOOL_NAME = /^[a-z][a-z0-9_.-]{1,63}$/;

export class VoiceToolRegistry {
  private tools: Map<string, VoiceToolExtension>;

  constructor(extensions: VoiceToolExtension[]) {
    this.tools = new Map();
    for (const extension of extensions) {
      if (!TOOL_NAME.test(extension.name)) throw new Error(`invalid voice tool name "${extension.name}"`);
      if (this.tools.has(extension.name)) throw new Error(`duplicate voice tool "${extension.name}"`);
      this.tools.set(extension.name, extension);
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async definitions(scope: VoiceToolScope): Promise<VoiceToolDefinition[]> {
    const definitions: VoiceToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      if (tool.isAvailable && !(await tool.isAvailable(scope))) continue;
      definitions.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
    }
    return definitions;
  }

  async execute(name: string, args: Record<string, unknown>, scope: VoiceToolScope): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) return { error: `unknown extension tool "${name}"` };
    if (tool.isAvailable && !(await tool.isAvailable(scope))) return { error: `tool "${name}" is unavailable for this call` };
    return tool.execute(args, scope);
  }
}

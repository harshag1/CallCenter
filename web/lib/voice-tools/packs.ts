import type { VoiceToolExtension } from "./types";

const PACK_ID = /^[a-z][a-z0-9.-]{1,63}$/;
const PACK_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export type VoiceToolPack = Readonly<{
  id: string;
  version: string;
  tools: readonly VoiceToolExtension[];
}>;

/** Declares a provider-neutral tool pack without coupling it to the application singleton. */
export function defineVoiceToolPack(input: VoiceToolPack): VoiceToolPack {
  if (!PACK_ID.test(input.id)) throw new Error(`invalid voice tool pack id "${input.id}"`);
  if (!PACK_VERSION.test(input.version)) throw new Error(`invalid voice tool pack version "${input.version}"`);
  if (!Array.isArray(input.tools) || input.tools.length > 256) {
    throw new Error(`voice tool pack "${input.id}" exceeds 256 tools`);
  }
  return Object.freeze({
    id: input.id,
    version: input.version,
    tools: Object.freeze([...input.tools]),
  });
}

/**
 * Composes independently published packs and binds pack identity/version into every
 * implementation digest. Pack authors must bump `version` when any imported behavior,
 * authorization rule, or dependency changes even if a tool function's text does not.
 */
export function composeVoiceToolPacks(packs: readonly VoiceToolPack[]): VoiceToolExtension[] {
  const identities = new Set<string>();
  const tools: VoiceToolExtension[] = [];
  for (const pack of packs) {
    const normalized = defineVoiceToolPack(pack);
    const identity = `${normalized.id}@${normalized.version}`;
    if (identities.has(identity)) throw new Error(`duplicate voice tool pack "${identity}"`);
    identities.add(identity);
    tools.push(...normalized.tools.map((tool) => Object.freeze({
      ...tool,
      implementationRevision: `${normalized.id}@${normalized.version}:${tool.implementationRevision ?? "default"}`,
    })));
  }
  return tools;
}

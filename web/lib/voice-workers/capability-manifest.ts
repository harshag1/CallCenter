import type { ActiveCapabilityCatalog } from "../active-capability-catalog";
import {
  VoiceWorkerCapabilityManifestSchema,
  type VoiceWorkerCapabilityManifest,
} from "./schema";

/**
 * Narrows a worker to the intersection of:
 *  - the exact capabilities active at the current Flow checkpoint;
 *  - entries explicitly classified as reads by the trusted catalog compiler;
 *  - tools the host can execute through its background-only audience.
 *
 * The caller supplies the executable background catalog so this derivation
 * does not duplicate an allowlist that can drift from the actual gateway.
 */
export function deriveActiveReadOnlyWorkerManifest(input: Readonly<{
  catalog: ActiveCapabilityCatalog;
  executableBackgroundToolNames: readonly string[];
}>): VoiceWorkerCapabilityManifest {
  if (input.catalog.availability !== "active") {
    throw new Error("cannot derive worker authority from a blocked active capability catalog");
  }
  const executable = new Set(input.executableBackgroundToolNames);
  if (executable.size !== input.executableBackgroundToolNames.length) {
    throw new Error("background worker tool catalog contains duplicate names");
  }
  const capabilities = input.catalog.tools
    .filter((tool) => (
      tool.effect === "read"
      && executable.has(tool.logical_name)
      // Direct aliases are not safe here: the worker executor invokes the
      // immutable logical name, not a hidden realtime-only target binding.
      && (tool.invocation.mode !== "direct" || tool.invocation.tool_name === tool.logical_name)
    ))
    .map((tool) => tool.logical_name)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (!capabilities.length) {
    throw new Error("the active Flow step grants no background-safe read capability");
  }
  const manifest = VoiceWorkerCapabilityManifestSchema.parse({
    v: 1,
    mode: "read_only",
    capabilities,
    networkOrigins: [],
  });
  Object.freeze(manifest.capabilities);
  Object.freeze(manifest.networkOrigins);
  return Object.freeze(manifest);
}

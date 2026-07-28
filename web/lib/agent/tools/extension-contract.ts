// Author: Harsha Gundala
// extension-contract.ts — fail-closed admission for self-hosted operator tools.

import type { OperatorTool, OperatorToolExtension } from "../types";

/** Runtime guard for manifests that may arrive from untyped JavaScript or an
 * unsafe cast. TypeScript makes the metadata required in `extensions.ts`; this
 * guard keeps the same boundary when types are bypassed. */
export function isAdmittedOperatorToolExtension(
  tool: unknown,
): tool is OperatorToolExtension {
  if (!tool || typeof tool !== "object") return false;
  const candidate = tool as Partial<OperatorTool>;
  if (
    typeof candidate.name !== "string"
    || typeof candidate.description !== "string"
    || !candidate.parameters
    || typeof candidate.parameters !== "object"
    || typeof candidate.execute !== "function"
  ) return false;
  const security = candidate.security;
  if (!security || typeof security !== "object") return false;
  return security.tenant_scoped === true
    && (security.effect === "read" || security.effect === "internal_write");
}

/** Returns a new immutable catalog snapshot so later array mutation cannot
 * widen the extension set after registry initialization. */
export function admitOperatorToolExtensions(
  tools: readonly unknown[],
): readonly OperatorToolExtension[] {
  return Object.freeze(tools.filter(isAdmittedOperatorToolExtension));
}

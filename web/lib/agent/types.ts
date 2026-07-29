// Author: Harsha Gundala
// types.ts — operator-agent tool contract and execution context.

import type { Surface, Flow } from "../surface-dsl";
import type { OperatorTurnInferenceAuthority } from "./operator-turn-inference-authority";

export type ToolCtx = {
  orgId: string;
  email: string;
  agentId: string | null;
  origin: string;
  /** Present only for authenticated operator-chat turns. Funded action
   * proposals are bound to this thread but approval tokens never enter it. */
  threadId?: string;
  /** Host-only, process-local authority shared by every builder sample and
   * nested research request in this authenticated turn. It is never serialized
   * into model/tool output. */
  inferenceAuthority?: OperatorTurnInferenceAuthority;
};

export type ToolResult = {
  /** Returned to the model. Keep compact — it re-enters context. */
  output: unknown;
  /** Workspace mutations streamed to the client. */
  surface?: Surface;
  flow?: Flow;
  flowMeta?: { id: string; label: string };
  notice?: string;
  /** Client-side navigation request (e.g. jump to a freshly created experiment screen). */
  navigate?: { tab: string; screenId?: string; experimentId?: string };
  /** Exact, non-authoritative proposal rendered by the browser. Only the
   * same-origin approval endpoint can turn it into an execution receipt. */
  operatorActionConfirmation?: import("./tools/operator-capability-policy").OperatorActionProposal;
};

/** Effects that a self-hosted builder/operator extension may perform directly.
 *
 * External communication, spending, and other consequential effects are
 * deliberately absent. Those actions must use a separately authorized
 * capability path rather than gaining authority by appearing in an extension
 * manifest.
 */
export type OperatorToolExtensionEffect = "read" | "internal_write";

export type OperatorToolSecurity = Readonly<{
  effect: OperatorToolExtensionEffect;
  /** Confirms that every read/write is scoped by the authenticated `ctx.orgId`. */
  tenant_scoped: true;
}>;

export type OperatorTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Required when the tool is registered through `tools/extensions.ts`. */
  security?: OperatorToolSecurity;
  execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
};

/** Compile-time contract for tools registered through the public extension seam. */
export type OperatorToolExtension = OperatorTool & Readonly<{
  security: OperatorToolSecurity;
}>;

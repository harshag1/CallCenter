// Author: Harsha Gundala
// types.ts — operator-agent tool contract and execution context.

import type { Surface, Flow } from "../surface-dsl";

export type ToolCtx = {
  orgId: string;
  email: string;
  agentId: string | null;
  origin: string;
  /** Present only for authenticated operator-chat turns. Funded action
   * proposals are bound to this thread but approval tokens never enter it. */
  threadId?: string;
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

export type OperatorTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
};

// Author: Harsha Gundala
// types.ts — operator-agent tool contract and execution context.

import type { Surface, Flow } from "../surface-dsl";

export type ToolCtx = {
  orgId: string;
  email: string;
  agentId: string | null;
  origin: string;
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
};

export type OperatorTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, never> & Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
};

// Author: Harsha Gundala
// flow.ts — agent call-flow model: topology drives the UI graph AND the progressive tool runtime.

import { z } from "zod";

/** Icons the flow generator may assign to topic nodes (lucide names the studio knows). */
export const TOPIC_ICONS = [
  "life-buoy", "package", "credit-card", "calendar", "user", "settings",
  "shopping-cart", "truck", "rotate-ccw", "shield", "zap", "book-open", "wrench", "gift",
] as const;

export const FlowStepSchema = z.object({
  id: z.string(),
  label: z.string(),
  instructions: z.string(),
});

export const FlowNodeSchema = z.preprocess(
  (v) => {
    if (v && typeof v === "object" && !("kind" in v) && "type" in v) {
      const { type, ...rest } = v as Record<string, unknown>;
      return { kind: type, ...rest };
    }
    return v;
  },
  z.object({
    id: z.string(),
    label: z.string(),
    kind: z.enum(["incoming_call", "topic", "fallback", "start", "state", "tool", "decision", "end"]).default("state"),
    icon: z.string().optional(),
    active: z.boolean().optional(),
    // topic nodes — progressive disclosure payload
    context: z.string().optional(),
    steps: z.array(FlowStepSchema).optional(),
    // fallback node
    support_number: z.string().optional(),
  })
);

export const AgentFlowSchema = z.object({
  nodes: z.array(FlowNodeSchema),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })),
});

export type FlowStep = z.infer<typeof FlowStepSchema>;
export type FlowNode = z.infer<typeof FlowNodeSchema>;
export type AgentFlow = z.infer<typeof AgentFlowSchema>;

export function topicNodes(flow: AgentFlow): FlowNode[] {
  return flow.nodes.filter((n) => n.kind === "topic");
}

export function fallbackNode(flow: AgentFlow): FlowNode | undefined {
  return flow.nodes.find((n) => n.kind === "fallback");
}

/** Slim base instructions — everything topic-specific arrives later via classify()/begin_step(). */
export function slimInstructions(persona: string, flow: AgentFlow): string {
  const topics = topicNodes(flow)
    .map((n) => `- ${n.id}: ${n.label}`)
    .join("\n");
  return `${persona}

You handle calls with a strict tool-driven workflow. Your base knowledge is intentionally minimal — tools give you everything.

RULES:
1. Greet briefly, then listen. As soon as the caller's need is clear, call classify with the matching topic:
${topics}
- If nothing matches, call classify with "other".
2. classify returns the topic context and the available next steps. Follow ONLY those steps. When the caller picks a direction, call begin_step to get that step's exact instructions.
3. Never invent policy, prices, or procedures. If the answer isn't in tool output, use search or search_knowledge (when available), or offer to transfer via contact_support.
4. hold(seconds) when you need to pause (e.g. "let me check that").
5. Keep every reply to one or two short sentences — this is a phone call.`;
}

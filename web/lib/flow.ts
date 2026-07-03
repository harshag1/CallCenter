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
    // dataset this node records into (rendered as a table chip)
    table: z.string().optional(),
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
5. Keep every reply to one or two short sentences — this is a phone call.
6. RECORDING IS SACRED: the moment you have data a step told you to record (write_table etc.), call that tool immediately — you can do it while still talking. NEVER end a call with unrecorded answers, even if the caller is saying goodbye. Record first, then say goodbye, then end_call.`;
}


/** Structural normalization for agent-authored flows (create_flow/update_flow).
 *  Entry node guaranteed and step-free, legacy end nodes dropped, edges pruned to real
 *  node ids, entry auto-connected, ≥1 topic required. */
export function normalizeFlow(
  input: AgentFlow,
  kind: "inbound" | "outbound"
): { flow: AgentFlow } | { error: string } {
  let nodes = [...input.nodes];
  const entryLabel = kind === "outbound" ? "Outgoing call" : "Incoming call";

  // Drop legacy terminal nodes — hangup is a tool, not a place.
  nodes = nodes.filter((n) => (n.kind as string) !== "end");
  for (const n of nodes) {
    if ((n.kind as string) === "start") n.kind = "incoming_call";
    else if (!["incoming_call", "topic", "fallback"].includes(n.kind)) n.kind = "topic";
  }

  let entry = nodes.find((n) => n.kind === "incoming_call");
  if (!entry) {
    entry = { id: "entry", label: entryLabel, kind: "incoming_call" };
    nodes.unshift(entry);
  }
  if (!/call/i.test(entry.label)) entry.label = entryLabel;

  // Steps belong on topic nodes: migrate any steps stashed on the entry node.
  if (entry.steps?.length) {
    nodes.push({
      id: "main",
      label: "Conversation",
      kind: "topic",
      context: entry.context ?? "The main body of this call.",
      steps: entry.steps,
      table: entry.table,
    });
    delete entry.steps;
    delete entry.context;
  }

  if (!nodes.some((n) => n.kind === "topic")) {
    return { error: "flow needs at least one topic node (kind 'topic') carrying the conversation's context and steps — steps must live on topic nodes, not the entry node" };
  }

  const ids = new Set(nodes.map((n) => n.id));
  const edges = input.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  for (const n of nodes) {
    if (n.id !== entry.id && !edges.some((e) => e.to === n.id)) {
      edges.push({ from: entry.id, to: n.id });
    }
  }
  return { flow: { nodes, edges } };
}

// Author: Harsha Gundala
// flow.ts — agent call-flow model: topology drives the UI graph AND the progressive tool runtime.

import { z } from "zod";

/** Icons the flow generator may assign to topic nodes (lucide names the studio knows). */
export const TOPIC_ICONS = [
  "life-buoy", "package", "credit-card", "calendar", "user", "settings",
  "shopping-cart", "truck", "rotate-ccw", "shield", "zap", "book-open", "wrench", "gift",
] as const;

const TOOL_NAME = /^[a-z][a-z0-9_.-]{1,63}$/;

export type FlowTransition = {
  to: string;
  label?: string;
  /** Human-readable branch guidance supplied to the model. */
  when?: string;
  /** Optional machine-enforced condition evaluated against the completed step's outputs. */
  condition?: {
    output: string;
    operator: "equals" | "not_equals" | "exists" | "in";
    value?: unknown;
  };
};

export type FlowStep = {
  id: string;
  label: string;
  instructions: string;
  context?: string;
  /** Marks this top-level step as directly selectable after classification. */
  entry?: boolean;
  /** Tools granted while this step (or one of its descendants) is active. */
  tools?: string[];
  /** Output keys that complete_step must persist before this step can finish. */
  required_outputs?: string[];
  success_criteria?: string[];
  transitions?: FlowTransition[];
  on_failure?: string;
  max_attempts?: number;
  checkpoint?: boolean;
  /** Arbitrarily nested substeps. The runtime caps depth to keep model context bounded. */
  steps?: FlowStep[];
};

export const FlowTransitionSchema: z.ZodType<FlowTransition> = z.object({
  to: z.string().min(1),
  label: z.string().min(1).optional(),
  when: z.string().min(1).optional(),
  condition: z.object({
    output: z.string().min(1),
    operator: z.enum(["equals", "not_equals", "exists", "in"]),
    value: z.unknown().optional(),
  }).superRefine((condition, ctx) => {
    if (condition.operator !== "exists" && condition.value === undefined) {
      ctx.addIssue({ code: "custom", path: ["value"], message: `${condition.operator} requires a value` });
    }
    if (condition.operator === "in" && !Array.isArray(condition.value)) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "in requires an array value" });
    }
  }).optional(),
});

export const FlowStepSchema: z.ZodType<FlowStep> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    instructions: z.string().min(1),
    context: z.string().min(1).optional(),
    entry: z.boolean().optional(),
    tools: z.array(z.string().regex(TOOL_NAME)).optional(),
    required_outputs: z.array(z.string().min(1)).optional(),
    success_criteria: z.array(z.string().min(1)).optional(),
    transitions: z.array(FlowTransitionSchema).optional(),
    on_failure: z.string().min(1).optional(),
    max_attempts: z.number().int().min(1).max(10).optional(),
    checkpoint: z.boolean().optional(),
    steps: z.array(FlowStepSchema).optional(),
  })
);

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
    // flow-v2 progressive disclosure: tools inherited by every step in this topic
    tools: z.array(z.string().regex(TOOL_NAME)).optional(),
  })
);

export const AgentFlowSchema = z.object({
  schema_version: z.union([z.literal(1), z.literal(2)]).optional(),
  /** Tools visible for the whole call. Keep this deliberately small. */
  always_tools: z.array(z.string().regex(TOOL_NAME)).optional(),
  /** gateway exposes one guarded run_action tool; direct exposes every attached tool up front. */
  tool_exposure: z.enum(["gateway", "direct"]).optional(),
  /** Optional circuit breaker for total step entries/retries during one call. */
  max_step_entries: z.number().int().min(1).max(10_000).optional(),
  nodes: z.array(FlowNodeSchema),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
    label: z.string().optional(),
    when: z.string().optional(),
  })),
});

export type FlowNode = z.infer<typeof FlowNodeSchema>;
export type AgentFlow = z.infer<typeof AgentFlowSchema>;

export type FlowDiagnostic = {
  level: "error" | "warning";
  path: string;
  message: string;
};

export type StepRef = { path: string; nodeId: string; step: FlowStep; ancestors: FlowStep[] };

const DEFAULT_ALWAYS_TOOLS = ["contact_support", "request_recall", "log_note", "end_call"];

/** v1 remains direct for compatibility; v2 defaults to the progressive action gateway. */
export function flowToolExposure(flow: AgentFlow): "gateway" | "direct" {
  return flow.tool_exposure ?? (flow.schema_version === 2 ? "gateway" : "direct");
}

export function alwaysTools(flow: AgentFlow): string[] {
  return [...new Set(flow.always_tools ?? DEFAULT_ALWAYS_TOOLS)];
}

export function listStepRefs(flow: AgentFlow): StepRef[] {
  const refs: StepRef[] = [];
  const visit = (nodeId: string, steps: FlowStep[], parentPath: string, ancestors: FlowStep[]) => {
    for (const step of steps) {
      const path = `${parentPath}.${step.id}`;
      refs.push({ path, nodeId, step, ancestors });
      if (step.steps?.length) visit(nodeId, step.steps, path, [...ancestors, step]);
    }
  };
  for (const node of flow.nodes) visit(node.id, node.steps ?? [], node.id, []);
  return refs;
}

export function findStep(flow: AgentFlow, path: string): StepRef | undefined {
  return listStepRefs(flow).find((ref) => ref.path === path);
}

/**
 * Entry steps are explicit when any top-level step sets `entry`; otherwise they are inferred
 * as top-level steps that are not transition/failure targets. This keeps follow-up steps from
 * becoming accidental shortcuts while preserving menus with several root choices.
 */
export function topicEntryStepPaths(flow: AgentFlow, nodeId: string): string[] {
  const refs = listStepRefs(flow);
  const roots = refs.filter((ref) => ref.nodeId === nodeId && ref.ancestors.length === 0);
  if (roots.some((ref) => ref.step.entry !== undefined)) {
    return roots.filter((ref) => ref.step.entry === true).map((ref) => ref.path);
  }
  const targets = new Set(
    refs.flatMap((ref) => [
      ...(ref.step.transitions ?? []).map((transition) => transition.to),
      ...(ref.step.on_failure ? [ref.step.on_failure] : []),
    ])
  );
  return roots.filter((ref) => !targets.has(ref.path)).map((ref) => ref.path);
}

/** Semantic validation beyond JSON shape: identity, reachability, nesting and transition safety. */
export function validateAgentFlow(input: unknown): { flow?: AgentFlow; diagnostics: FlowDiagnostic[] } {
  const parsed = AgentFlowSchema.safeParse(input);
  if (!parsed.success) {
    return {
      diagnostics: parsed.error.issues.map((issue) => ({
        level: "error" as const,
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const flow = parsed.data;
  const diagnostics: FlowDiagnostic[] = [];
  const nodeIds = new Set<string>();
  for (const [index, node] of flow.nodes.entries()) {
    if (nodeIds.has(node.id)) diagnostics.push({ level: "error", path: `nodes.${index}.id`, message: `duplicate node id "${node.id}"` });
    nodeIds.add(node.id);
  }
  for (const [index, edge] of flow.edges.entries()) {
    if (!nodeIds.has(edge.from)) diagnostics.push({ level: "error", path: `edges.${index}.from`, message: `unknown node "${edge.from}"` });
    if (!nodeIds.has(edge.to)) diagnostics.push({ level: "error", path: `edges.${index}.to`, message: `unknown node "${edge.to}"` });
  }

  const entries = flow.nodes.filter((node) => node.kind === "incoming_call" || node.kind === "start");
  if (entries.length !== 1) diagnostics.push({ level: "error", path: "nodes", message: `flow needs exactly one entry node; found ${entries.length}` });
  if (!flow.nodes.some((node) => node.kind === "topic")) diagnostics.push({ level: "error", path: "nodes", message: "flow needs at least one topic node" });

  const refs = listStepRefs(flow);
  const stepPaths = new Set(refs.map((ref) => ref.path));
  const seenPaths = new Set<string>();
  for (const ref of refs) {
    if (seenPaths.has(ref.path)) diagnostics.push({ level: "error", path: ref.path, message: `duplicate step path "${ref.path}"` });
    seenPaths.add(ref.path);
    if (ref.path.split(".").length - 1 > 8) diagnostics.push({ level: "error", path: ref.path, message: "step nesting exceeds the supported depth of 8" });
    if (ref.ancestors.length > 0 && ref.step.entry !== undefined) {
      diagnostics.push({ level: "error", path: `${ref.path}.entry`, message: "entry may only be set on top-level steps" });
    }
    for (const transition of ref.step.transitions ?? []) {
      if (!stepPaths.has(transition.to)) diagnostics.push({ level: "error", path: `${ref.path}.transitions`, message: `transition targets unknown step "${transition.to}"` });
    }
    if (ref.step.on_failure && !stepPaths.has(ref.step.on_failure)) {
      diagnostics.push({ level: "error", path: `${ref.path}.on_failure`, message: `failure target "${ref.step.on_failure}" does not exist` });
    }
  }

  if (flow.schema_version === 2) {
    for (const node of flow.nodes.filter((candidate) => candidate.kind === "topic")) {
      const roots = refs.filter((ref) => ref.nodeId === node.id && ref.ancestors.length === 0);
      if (!roots.length) {
        diagnostics.push({ level: "error", path: `nodes.${node.id}.steps`, message: "topic needs at least one top-level step" });
        continue;
      }
      if (!topicEntryStepPaths(flow, node.id).length) {
        const rootPaths = new Set(roots.map((ref) => ref.path));
        const hasCrossTopicInbound = refs.some((ref) =>
          ref.nodeId !== node.id && [
            ...(ref.step.transitions ?? []).map((transition) => transition.to),
            ...(ref.step.on_failure ? [ref.step.on_failure] : []),
          ].some((target) => rootPaths.has(target))
        );
        if (!hasCrossTopicInbound) {
          diagnostics.push({ level: "error", path: `nodes.${node.id}.steps`, message: "topic needs an entry step or an inbound cross-topic transition" });
        }
      }
    }
  }

  if (entries.length === 1) {
    const reachable = new Set([entries[0].id]);
    const queue = [entries[0].id];
    while (queue.length) {
      const from = queue.shift()!;
      for (const edge of flow.edges.filter((candidate) => candidate.from === from)) {
        if (!reachable.has(edge.to)) {
          reachable.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    for (const node of flow.nodes) {
      if (!reachable.has(node.id)) diagnostics.push({ level: "warning", path: `nodes.${node.id}`, message: "node is unreachable from the entry" });
    }
  }
  return { flow, diagnostics };
}

export function topicNodes(flow: AgentFlow): FlowNode[] {
  const topics = flow.nodes.filter((n) => n.kind === "topic");
  return flow.schema_version === 2
    ? topics.filter((node) => topicEntryStepPaths(flow, node.id).length > 0)
    : topics;
}

export function fallbackNode(flow: AgentFlow): FlowNode | undefined {
  return flow.nodes.find((n) => n.kind === "fallback");
}

/** Slim base instructions — everything topic-specific arrives later via classify()/begin_step(). */
export function slimInstructions(persona: string, flow: AgentFlow): string {
  const topics = topicNodes(flow)
    .map((n) => `- ${n.id}: ${n.label}`)
    .join("\n");
  const progressiveRules = flow.schema_version === 2
    ? `2. classify returns only the selected topic and its first valid step paths. Call enter_step(path) to unlock that step's context and action schemas.
3. Use run_action only for actions returned by enter_step. Persist every required output with complete_step before moving on. If context is lost, call get_flow_state and resume from its checkpoint.`
    : `2. classify returns the topic context and the available next steps. Follow ONLY those steps. When the caller picks a direction, call begin_step to get that step's exact instructions.`;
  return `${persona}

You handle calls with a strict tool-driven workflow. Your base knowledge is intentionally minimal — tools give you everything.

RULES:
1. Greet briefly, then listen. As soon as the caller's need is clear, call classify with the matching topic:
${topics}
- If nothing matches, call classify with "other".
${progressiveRules}
4. Never invent policy, prices, or procedures. If the answer isn't in tool output, use an available search action or offer human help.
5. hold(seconds) when you need to pause (e.g. "let me check that").
6. Keep every reply to one or two short sentences — this is a phone call.
7. RECORDING IS SACRED: the moment you have data a step told you to record (write_table etc.), call that tool immediately — you can do it while still talking. NEVER end a call with unrecorded answers, even if the caller is saying goodbye. Record first, then say goodbye, then end_call.`;
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
  const flow: AgentFlow = { ...input, nodes, edges };
  const validation = validateAgentFlow(flow);
  const errors = validation.diagnostics.filter((diagnostic) => diagnostic.level === "error");
  if (errors.length) return { error: errors.slice(0, 5).map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("; ") };
  return { flow };
}

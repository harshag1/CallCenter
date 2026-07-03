// Author: Harsha Gundala
// FlowPanel.tsx — read-only flow graph with the studio's card nodes: horizontal layout, trace ring, live hold chip,
// running-experiment badge and variant-diff accents for mini renders (Three.js renderer).

"use client";

import { useCallback, useMemo } from "react";
import ThreeFlow, {
  ExperimentCard, FallbackCard, IncomingCallCard, TopicCard,
  type ThreeFlowEdge, type ThreeFlowNode,
} from "@/components/flow/ThreeFlow";
import { HoldChip } from "@/components/platform/shared";

type FlowLike = {
  nodes: {
    id: string; label: string; kind?: string; icon?: string; active?: boolean;
    steps?: { label: string }[]; support_number?: string; table?: string;
  }[];
  edges: { from: string; to: string; label?: string }[];
};

export type ExperimentBadge = { id: string; name: string; screenId: string | null };

type Props = {
  flow: FlowLike | null;
  visited?: string[];
  activeNode?: string | null;
  holdCountdown?: { until: string } | null;
  number?: string | null;
  /** Entry node renders as an outgoing call (named outbound flows). */
  outbound?: boolean;
  /** Running A/B test on this agent — hangs a violet badge node off the entry node. */
  experiment?: ExperimentBadge | null;
  onOpenExperiment?: (exp: ExperimentBadge) => void;
  /** Click on a regular flow node (experiment badge keeps its own navigate behavior). */
  onNodeClick?: (node: FlowLike["nodes"][number]) => void;
  /** Variant-diff accents (mini experiment renders). */
  diffNodeIds?: string[];
  diffColor?: string;
  /** false = static mini render: no pan/zoom, page scroll passes through. */
  interactive?: boolean;
  fitPadding?: number;
};

const COL_W = 340;
const ROW_H = 168;
const EXPERIMENT_DY = 118;

/** Legacy kinds degrade onto the studio cards: start → incoming_call, fallback stays, the rest → topic. */
function cardType(kind?: string): "incoming_call" | "topic" | "fallback" {
  if (kind === "incoming_call" || kind === "start") return "incoming_call";
  if (kind === "fallback") return "fallback";
  return "topic";
}

function layout(
  flow: FlowLike,
  visited: Set<string>,
  activeNode: string | null,
  holdCountdown: { until: string } | null,
  number: string | null,
  opts: {
    outbound: boolean;
    experiment: ExperimentBadge | null;
    onOpenExperiment?: (exp: ExperimentBadge) => void;
    diff: Set<string>;
    diffColor?: string;
    interactive: boolean;
  }
): { nodes: ThreeFlowNode[]; edges: ThreeFlowEdge[] } {
  const depth = new Map<string, number>();
  const incoming = new Map(flow.nodes.map((n) => [n.id, 0]));
  flow.edges.forEach((e) => incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1));
  const queue = flow.nodes.filter((n) => !incoming.get(n.id)).map((n) => n.id);
  queue.forEach((id) => depth.set(id, 0));
  const adj = new Map<string, string[]>();
  flow.edges.forEach((e) => adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]));
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of adj.get(id) ?? []) {
      if (!depth.has(next)) {
        depth.set(next, (depth.get(id) ?? 0) + 1);
        queue.push(next);
      }
    }
  }
  const levels = new Map<number, string[]>();
  flow.nodes.forEach((n) => {
    const d = depth.get(n.id) ?? 0;
    levels.set(d, [...(levels.get(d) ?? []), n.id]);
  });

  let activePos: { x: number; y: number } | null = null;
  let entry: { id: string; pos: { x: number; y: number } } | null = null;
  const nodes: ThreeFlowNode[] = flow.nodes.map((n) => {
    const d = depth.get(n.id) ?? 0;
    const siblings = levels.get(d)!;
    const idx = siblings.indexOf(n.id);
    const type = cardType(n.kind);
    const active = activeNode === n.id || !!n.active || visited.has(n.id);
    const position = { x: d * COL_W, y: (idx - (siblings.length - 1) / 2) * ROW_H };
    if (activeNode === n.id) activePos = position;
    if (type === "incoming_call" && !entry) entry = { id: n.id, pos: position };
    const diffColor = opts.diff.has(n.id) ? opts.diffColor : undefined;
    const element =
      type === "incoming_call" ? (
        <IncomingCallCard
          data={{
            label: n.label, number, active, diffColor, outbound: opts.outbound,
            numberStatus: number || opts.interactive ? undefined : "none", // minis never show the provisioning skeleton
          }}
        />
      ) : type === "fallback" ? (
        <FallbackCard data={{ label: n.label, supportNumber: n.support_number ?? null, active, diffColor }} /> // no onSaveNumber → read-only card
      ) : (
        <TopicCard data={{ label: n.label, icon: n.icon, steps: n.steps, table: n.table, active, diffColor }} />
      );
    return { id: n.id, x: position.x, y: position.y, element };
  });

  if (activePos && holdCountdown) {
    const pos = activePos as { x: number; y: number };
    nodes.push({
      id: "__hold",
      x: pos.x + 6,
      y: pos.y - 28,
      element: <HoldChip until={holdCountdown.until} />,
    });
  }

  const edges: ThreeFlowEdge[] = flow.edges.map((e, i) => ({
    id: `e${i}`,
    source: e.from,
    target: e.to,
    label: e.label,
    color: e.to === activeNode ? "#111" : visited.has(e.to) ? "#a3a3a3" : "#d9d9d9",
    width: e.to === activeNode ? 1.6 : 1.2,
    labelStyle: { fontSize: 9, color: "#999" },
    animated: e.to === activeNode,
  }));

  const exp = opts.experiment;
  if (exp && entry) {
    const anchor = entry as { id: string; pos: { x: number; y: number } };
    nodes.push({
      id: "__experiment",
      x: anchor.pos.x,
      y: anchor.pos.y + EXPERIMENT_DY,
      element: (
        <ExperimentCard
          data={{
            label: exp.name,
            onOpen: opts.onOpenExperiment ? () => opts.onOpenExperiment!(exp) : undefined,
          }}
        />
      ),
    });
    edges.push({
      id: "e__experiment",
      source: anchor.id,
      fromAnchor: "bottom",
      target: "__experiment",
      toAnchor: "top",
      color: "#8b5cf6",
      width: 1.3,
      dashed: true,
    });
  }
  return { nodes, edges };
}

export default function FlowPanel({
  flow, visited, activeNode, holdCountdown, number, outbound,
  experiment, onOpenExperiment, onNodeClick, diffNodeIds, diffColor, interactive = true, fitPadding = 0.2,
}: Props) {
  const graph = useMemo(
    () =>
      flow?.nodes.length
        ? layout(flow, new Set(visited ?? []), activeNode ?? null, holdCountdown ?? null, number ?? null, {
            outbound: !!outbound,
            experiment: experiment ?? null,
            onOpenExperiment,
            diff: new Set(diffNodeIds ?? []),
            diffColor,
            interactive,
          })
        : null,
    [flow, visited, activeNode, holdCountdown, number, outbound, experiment, onOpenExperiment, diffNodeIds, diffColor, interactive]
  );

  const handleNodeClick = useCallback(
    (id: string) => {
      if (id === "__experiment") {
        if (experiment && onOpenExperiment) onOpenExperiment(experiment);
        return;
      }
      if (id === "__hold" || !onNodeClick) return;
      const src = flow?.nodes.find((n) => n.id === id);
      if (src) onNodeClick(src);
    },
    [experiment, onOpenExperiment, onNodeClick, flow]
  );

  if (!graph) {
    return <div className="flex h-full items-center justify-center bg-[#f7f7f6] text-xs text-neutral-300">no flow</div>;
  }
  return (
    <ThreeFlow
      nodes={graph.nodes}
      edges={graph.edges}
      onNodeClick={(experiment && onOpenExperiment) || onNodeClick ? handleNodeClick : undefined}
      interactive={interactive}
      fitPadding={fitPadding}
      minZoom={0.15}
    />
  );
}

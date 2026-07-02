// Author: Harsha Gundala
// FlowPanel.tsx — read-only flow graph with the studio's card nodes: horizontal layout, trace ring, live hold chip.

"use client";

import { memo, useMemo } from "react";
import { ReactFlow, Background, BackgroundVariant, type Node, type Edge, type NodeProps } from "@xyflow/react";
import { nodeTypes as studioNodeTypes } from "@/components/studio/nodes";
import { HoldChip } from "@/components/platform/shared";

type FlowLike = {
  nodes: {
    id: string; label: string; kind?: string; icon?: string; active?: boolean;
    steps?: { label: string }[]; support_number?: string;
  }[];
  edges: { from: string; to: string; label?: string }[];
};

type Props = {
  flow: FlowLike | null;
  visited?: string[];
  activeNode?: string | null;
  holdCountdown?: { until: string } | null;
  number?: string | null;
};

const HoldNode = memo(function HoldNode({ data }: NodeProps) {
  return <HoldChip until={data.until as string} />;
});

const nodeTypes = { ...studioNodeTypes, hold: HoldNode };

const COL_W = 300;
const ROW_H = 118;

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
  number: string | null
): { nodes: Node[]; edges: Edge[] } {
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
  const nodes: Node[] = flow.nodes.map((n) => {
    const d = depth.get(n.id) ?? 0;
    const siblings = levels.get(d)!;
    const idx = siblings.indexOf(n.id);
    const type = cardType(n.kind);
    const active = activeNode === n.id || !!n.active || visited.has(n.id);
    const position = { x: d * COL_W, y: (idx - (siblings.length - 1) / 2) * ROW_H };
    if (activeNode === n.id) activePos = position;
    const data =
      type === "incoming_call"
        ? { number, numberStatus: undefined, active }
        : type === "fallback"
          ? { label: n.label, supportNumber: n.support_number ?? null, active } // no onSaveNumber → read-only card
          : { label: n.label, icon: n.icon, steps: n.steps, active };
    return { id: n.id, type, position, data, draggable: false, selectable: false };
  });

  if (activePos && holdCountdown) {
    const pos = activePos as { x: number; y: number };
    nodes.push({
      id: "__hold",
      type: "hold",
      position: { x: pos.x + 6, y: pos.y - 28 },
      data: { until: holdCountdown.until },
      draggable: false,
      selectable: false,
      zIndex: 20,
    });
  }

  const edges: Edge[] = flow.edges.map((e, i) => ({
    id: `e${i}`,
    source: e.from,
    target: e.to,
    label: e.label,
    type: "smoothstep",
    style: {
      stroke: e.to === activeNode ? "#111" : visited.has(e.to) ? "#a3a3a3" : "#d9d9d9",
      strokeWidth: e.to === activeNode ? 1.6 : 1.2,
    },
    labelStyle: { fontSize: 9, fill: "#999" },
    animated: e.to === activeNode,
  }));
  return { nodes, edges };
}

export default function FlowPanel({ flow, visited, activeNode, holdCountdown, number }: Props) {
  const graph = useMemo(
    () =>
      flow?.nodes.length
        ? layout(flow, new Set(visited ?? []), activeNode ?? null, holdCountdown ?? null, number ?? null)
        : null,
    [flow, visited, activeNode, holdCountdown, number]
  );
  if (!graph) {
    return <div className="flex h-full items-center justify-center bg-[#f7f7f6] text-xs text-neutral-300">no flow</div>;
  }
  return (
    <ReactFlow
      className="!bg-[#f7f7f6]"
      nodes={graph.nodes}
      edges={graph.edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      zoomOnScroll={false}
      panOnDrag
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} color="#d4d4d4" gap={18} size={1.4} />
    </ReactFlow>
  );
}

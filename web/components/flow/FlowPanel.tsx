// Author: Harsha Gundala
// FlowPanel.tsx — read-only flow graph: layered auto-layout, per-call visited trace, live hold badge.

"use client";

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { ReactFlow, Background, BackgroundVariant, type Node, type Edge } from "@xyflow/react";
import { HoldChip } from "@/components/platform/shared";

type FlowLike = {
  nodes: { id: string; label: string; kind?: string; active?: boolean }[];
  edges: { from: string; to: string; label?: string }[];
};

type Props = {
  flow: FlowLike | null;
  visited?: string[];
  activeNode?: string | null;
  holdCountdown?: { until: string } | null;
};

const KIND_STYLE: Record<string, CSSProperties> = {
  start: { background: "#111", color: "#fff", border: "none" },
  incoming_call: { background: "#111", color: "#fff", border: "none" },
  end: { background: "#f5f5f5", color: "#999", border: "1px solid #e5e5e5" },
  decision: { background: "#fff", border: "1px dashed #bbb", borderRadius: 999 },
  fallback: { background: "#fff", border: "1px dashed #ccc" },
  tool: { background: "#fafafa", border: "1px solid #ddd", fontFamily: "var(--font-mono)", fontSize: 10 },
  topic: { background: "#fff", border: "1px solid #e5e5e5" },
  state: { background: "#fff", border: "1px solid #e5e5e5" },
};

function layout(
  flow: FlowLike,
  visited: Set<string>,
  activeNode: string | null,
  holdCountdown: { until: string } | null
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

  const nodes: Node[] = flow.nodes.map((n) => {
    const d = depth.get(n.id) ?? 0;
    const siblings = levels.get(d)!;
    const idx = siblings.indexOf(n.id);
    const base = KIND_STYLE[n.kind ?? "state"] ?? KIND_STYLE.state;
    const isActive = activeNode === n.id || !!n.active;
    const label: ReactNode =
      isActive && holdCountdown ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          {n.label} <HoldChip until={holdCountdown.until} />
        </span>
      ) : (
        n.label
      );
    return {
      id: n.id,
      position: { x: d * 190, y: (idx - (siblings.length - 1) / 2) * 74 },
      data: { label },
      style: {
        ...base,
        ...(visited.has(n.id) ? { background: "#111", color: "#fff", border: "none" } : {}),
        width: 150,
        padding: "6px 10px",
        borderRadius: base.borderRadius ?? 10,
        fontSize: 11,
        textAlign: "center" as const,
        ...(isActive ? { boxShadow: "0 0 0 2px rgba(17,17,17,0.9)" } : {}),
      },
    };
  });
  const edges: Edge[] = flow.edges.map((e, i) => ({
    id: `e${i}`,
    source: e.from,
    target: e.to,
    label: e.label,
    style: {
      stroke: e.to === activeNode ? "#111" : visited.has(e.to) ? "#a3a3a3" : "#ddd",
      strokeWidth: e.to === activeNode ? 1.6 : 1,
    },
    labelStyle: { fontSize: 9, fill: "#999" },
    animated: e.to === activeNode,
  }));
  return { nodes, edges };
}

export default function FlowPanel({ flow, visited, activeNode, holdCountdown }: Props) {
  const graph = useMemo(
    () =>
      flow?.nodes.length
        ? layout(flow, new Set(visited ?? []), activeNode ?? null, holdCountdown ?? null)
        : null,
    [flow, visited, activeNode, holdCountdown]
  );
  if (!graph) {
    return <div className="flex h-full items-center justify-center text-xs text-neutral-300">no flow</div>;
  }
  return (
    <ReactFlow
      className="!bg-[#f7f7f6]"
      nodes={graph.nodes}
      edges={graph.edges}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      zoomOnScroll={false}
      panOnDrag
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} color="#d4d4d4" gap={18} size={1.3} />
    </ReactFlow>
  );
}

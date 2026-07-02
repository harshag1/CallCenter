// Author: Harsha Gundala
// FlowPanel.tsx — read-only call-flow graph with auto layered layout.

"use client";

import { useMemo } from "react";
import { ReactFlow, Background, type Node, type Edge } from "@xyflow/react";
import type { Flow } from "@/lib/surface-dsl";

const KIND_STYLE: Record<string, React.CSSProperties> = {
  start: { background: "#111", color: "#fff", border: "none" },
  end: { background: "#f5f5f5", color: "#999", border: "1px solid #e5e5e5" },
  decision: { background: "#fff", border: "1px dashed #bbb", borderRadius: 999 },
  tool: { background: "#fafafa", border: "1px solid #ddd", fontFamily: "var(--font-mono)", fontSize: 10 },
  state: { background: "#fff", border: "1px solid #e5e5e5" },
};

function layout(flow: Flow): { nodes: Node[]; edges: Edge[] } {
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
    return {
      id: n.id,
      position: { x: (idx - (siblings.length - 1) / 2) * 170, y: d * 78 },
      data: { label: n.label },
      style: {
        ...KIND_STYLE[n.kind ?? "state"],
        width: 150,
        padding: "6px 10px",
        borderRadius: KIND_STYLE[n.kind ?? "state"].borderRadius ?? 10,
        fontSize: 11,
        textAlign: "center" as const,
        ...(n.active ? { boxShadow: "0 0 0 2px #111" } : {}),
      },
    };
  });
  const edges: Edge[] = flow.edges.map((e, i) => ({
    id: `e${i}`,
    source: e.from,
    target: e.to,
    label: e.label,
    style: { stroke: "#ddd" },
    labelStyle: { fontSize: 9, fill: "#999" },
    animated: false,
  }));
  return { nodes, edges };
}

export default function FlowPanel({ flow }: { flow: Flow | null }) {
  const graph = useMemo(() => (flow?.nodes.length ? layout(flow) : null), [flow]);
  if (!graph) {
    return <div className="flex h-full items-center justify-center text-xs text-neutral-300">no flow</div>;
  }
  return (
    <ReactFlow
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
      <Background color="#f3f3f3" gap={18} />
    </ReactFlow>
  );
}

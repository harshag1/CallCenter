// Author: Harsha Gundala
// FlowCanvas.tsx — the studio flow graph: horizontal agent topology on a dotted canvas.

"use client";

import { useMemo } from "react";
import { ReactFlow, Background, BackgroundVariant, type Node, type Edge } from "@xyflow/react";
import { nodeTypes } from "./nodes";
import type { AgentFlow, FlowNode } from "@/lib/flow";

type Props = {
  flow: AgentFlow;
  number: string | null;
  numberStatus?: string;
  activeNode?: string | null;
  activeStep?: string | null;
  onSaveSupportNumber: (n: string) => Promise<boolean>;
  onNodeClick?: (node: FlowNode) => void;
};

export default function FlowCanvas({
  flow, number, numberStatus, activeNode, activeStep, onSaveSupportNumber, onNodeClick,
}: Props) {
  const graph = useMemo(() => {
    const branches = flow.nodes.filter((n) => n.kind !== "incoming_call");
    const rowH = 118;
    const nodes: Node[] = flow.nodes.map((n) => {
      if (n.kind === "incoming_call") {
        return {
          id: n.id, type: "incoming_call", position: { x: 0, y: ((branches.length - 1) * rowH) / 2 - 20 },
          data: { number, numberStatus, active: activeNode === n.id },
          draggable: false,
        };
      }
      const idx = branches.findIndex((t) => t.id === n.id);
      const stepIdx = n.steps?.findIndex((s) => s.id === activeStep) ?? -1;
      return {
        id: n.id,
        type: n.kind === "fallback" ? "fallback" : "topic", // unknown kinds degrade to topic cards
        position: { x: 300, y: idx * rowH },
        data: {
          label: n.label, icon: n.icon, steps: n.steps,
          active: activeNode === n.id,
          activeStep: activeNode === n.id && stepIdx >= 0 ? stepIdx : undefined,
          supportNumber: n.support_number ?? null,
          onSaveNumber: onSaveSupportNumber,
        },
        draggable: false,
      };
    });
    const edges: Edge[] = flow.edges.map((e, i) => ({
      id: `e${i}`, source: e.from, target: e.to, label: e.label, type: "smoothstep",
      style: { stroke: activeNode === e.to ? "#111" : "#d9d9d9", strokeWidth: activeNode === e.to ? 1.6 : 1.2 },
      animated: activeNode === e.to,
    }));
    return { nodes, edges };
  }, [flow, number, numberStatus, activeNode, activeStep, onSaveSupportNumber]);

  return (
    <ReactFlow
      nodes={graph.nodes}
      edges={graph.edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.22 }}
      nodesConnectable={false}
      elementsSelectable
      zoomOnScroll={false}
      panOnDrag
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, rfNode) => {
        const n = flow.nodes.find((x) => x.id === rfNode.id);
        if (n && onNodeClick) onNodeClick(n);
      }}
      className="!bg-[#f7f7f6]"
    >
      <Background variant={BackgroundVariant.Dots} color="#d4d4d4" gap={18} size={1.4} />
    </ReactFlow>
  );
}

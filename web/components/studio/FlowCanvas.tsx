// Author: Harsha Gundala
// FlowCanvas.tsx — the studio flow graph: agent topology with live provisioning + call tracing.

"use client";

import { useMemo } from "react";
import { ReactFlow, Background, type Node, type Edge } from "@xyflow/react";
import { nodeTypes } from "./nodes";
import type { AgentFlow } from "@/lib/flow";

type Props = {
  flow: AgentFlow;
  number: string | null;
  numberStatus?: string;
  activeNode?: string | null;
  activeStep?: string | null;
  onSaveSupportNumber: (n: string) => Promise<boolean>;
};

export default function FlowCanvas({ flow, number, numberStatus, activeNode, activeStep, onSaveSupportNumber }: Props) {
  const graph = useMemo(() => {
    const topics = flow.nodes.filter((n) => n.kind === "topic" || n.kind === "fallback");
    const width = 210;
    const nodes: Node[] = flow.nodes.map((n) => {
      if (n.kind === "incoming_call") {
        return {
          id: n.id, type: "incoming_call", position: { x: -95, y: 0 },
          data: { number, numberStatus, active: activeNode === n.id },
          draggable: false,
        };
      }
      const idx = topics.findIndex((t) => t.id === n.id);
      const stepIdx = n.steps?.findIndex((s) => s.id === activeStep) ?? -1;
      return {
        id: n.id,
        type: n.kind === "fallback" ? "fallback" : "topic",
        position: { x: (idx - (topics.length - 1) / 2) * width - 85, y: 150 },
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
      id: `e${i}`, source: e.from, target: e.to, label: e.label,
      style: { stroke: activeNode === e.to ? "#111" : "#e2e2e2", strokeWidth: activeNode === e.to ? 1.6 : 1.2 },
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
      fitViewOptions={{ padding: 0.25 }}
      nodesConnectable={false}
      elementsSelectable={false}
      zoomOnScroll={false}
      panOnDrag
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#f4f4f4" gap={20} />
    </ReactFlow>
  );
}

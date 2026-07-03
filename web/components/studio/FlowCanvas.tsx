// Author: Harsha Gundala
// FlowCanvas.tsx — the studio flow graph: horizontal agent topology on a dotted canvas (Three.js renderer).

"use client";

import { useCallback, useMemo } from "react";
import ThreeFlow, {
  FallbackCard, IncomingCallCard, TopicCard,
  type ThreeFlowEdge, type ThreeFlowNode,
} from "@/components/flow/ThreeFlow";
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
    const rowH = 168;
    const nodes: ThreeFlowNode[] = flow.nodes.map((n) => {
      if (n.kind === "incoming_call") {
        return {
          id: n.id,
          x: 0,
          y: ((branches.length - 1) * rowH) / 2 + 14,
          element: <IncomingCallCard data={{ number, numberStatus, active: activeNode === n.id }} />,
        };
      }
      const idx = branches.findIndex((t) => t.id === n.id);
      const stepIdx = n.steps?.findIndex((s) => s.id === activeStep) ?? -1;
      const data = {
        label: n.label, icon: n.icon, steps: n.steps,
        active: activeNode === n.id,
        activeStep: activeNode === n.id && stepIdx >= 0 ? stepIdx : undefined,
        supportNumber: n.support_number ?? null,
        onSaveNumber: onSaveSupportNumber,
      };
      return {
        id: n.id,
        x: 340,
        y: idx * rowH,
        // unknown kinds degrade to topic cards
        element: n.kind === "fallback" ? <FallbackCard data={data} /> : <TopicCard data={data} />,
      };
    });
    const edges: ThreeFlowEdge[] = flow.edges.map((e, i) => ({
      id: `e${i}`, source: e.from, target: e.to, label: e.label,
      color: activeNode === e.to ? "#111" : "#d9d9d9",
      width: activeNode === e.to ? 1.6 : 1.2,
      animated: activeNode === e.to,
    }));
    return { nodes, edges };
  }, [flow, number, numberStatus, activeNode, activeStep, onSaveSupportNumber]);

  const handleNodeClick = useCallback((id: string) => {
    const n = flow.nodes.find((x) => x.id === id);
    if (n && onNodeClick) onNodeClick(n);
  }, [flow, onNodeClick]);

  return <ThreeFlow nodes={graph.nodes} edges={graph.edges} fitPadding={0.22} onNodeClick={handleNodeClick} />;
}

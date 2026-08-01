import { describe, expect, it } from "vitest";
import { inspectFlow } from "@/lib/flow-inspector";
import type { AgentFlow } from "@/lib/flow";

describe("inspectFlow", () => {
  it("summarizes nested checkpoints and scoped tools without executing the flow", () => {
    const flow: AgentFlow = {
      schema_version: 2,
      always_tools: ["end_call", "log_note"],
      nodes: [
        { id: "entry", label: "Incoming call", kind: "incoming_call" },
        {
          id: "returns",
          label: "Returns",
          kind: "topic",
          tools: ["lookup_order"],
          steps: [{
            id: "identify",
            label: "Identify order",
            instructions: "Find the order.",
            tools: ["lookup_customer"],
            checkpoint: true,
            steps: [{
              id: "resolve",
              label: "Resolve return",
              instructions: "Resolve the return.",
              tools: ["create_return", "lookup_order"],
            }],
          }],
        },
      ],
      edges: [{ from: "entry", to: "returns" }],
    };

    expect(inspectFlow(flow)).toEqual({
      nodeCount: 2,
      routeCount: 1,
      stepCount: 2,
      checkpointCount: 1,
      maxStepDepth: 2,
      toolExposure: "gateway",
      alwaysTools: ["end_call", "log_note"],
      scopedTools: ["create_return", "lookup_customer", "lookup_order"],
    });
  });

  it("reports an empty flow without inventing depth or scoped tools", () => {
    expect(inspectFlow({ nodes: [], edges: [] })).toMatchObject({
      nodeCount: 0,
      routeCount: 0,
      stepCount: 0,
      checkpointCount: 0,
      maxStepDepth: 0,
      toolExposure: "direct",
      scopedTools: [],
    });
  });
});

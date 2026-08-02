import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { listStepRefs, type AgentFlow } from "@/lib/flow";
import { analyzeFlowV2Import } from "@/lib/flow-package";
import { renderFlowVisualizationHtml } from "@/lib/flow-visualization";

describe("renderFlowVisualizationHtml", () => {
  it("renders nested topology, scoped tools, checkpoints, and routes without executable markup", () => {
    const flow: AgentFlow = {
      schema_version: 2,
      always_tools: ["end_call"],
      nodes: [
        { id: "entry", label: "Incoming <script>alert(1)</script>", kind: "incoming_call" },
        {
          id: "returns",
          label: "Returns",
          kind: "topic",
          tools: ["lookup_order"],
          steps: [{
            id: "identify",
            label: "Identify order",
            instructions: "SENSITIVE PROMPT COPY",
            checkpoint: true,
            tools: ["lookup_customer"],
            transitions: [{ to: "returns.resolve", label: "found" }],
            steps: [{
              id: "resolve",
              label: "Resolve return",
              instructions: "Resolve it.",
              tools: ["create_return"],
            }],
          }],
        },
      ],
      edges: [{ from: "entry", to: "returns", label: "classified" }],
    };

    const html = renderFlowVisualizationHtml(flow, "returns.json");

    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("Incoming &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("SENSITIVE PROMPT COPY");
    expect(html).toContain("returns.identify.resolve");
    expect(html).toContain("create_return");
    expect(html).toContain("checkpoint");
    expect(html).toContain("classified");
    expect(html).toContain('href="#step-returns.resolve"');
    expect(html).toContain('href="#node-returns"');
    expect(html).toContain("2</b><span>depth");
  });

  it("renders every checked-in Flow step once with no broken local route targets", () => {
    const examples = [
      "membership-and-returns.json",
      "membership-return-resolution.json",
      "service-appointment-lifecycle.json",
      "warranty-and-incident-intake.json",
    ];

    for (const filename of examples) {
      const source = JSON.parse(readFileSync(
        new URL(`../../../examples/flows/${filename}`, import.meta.url),
        "utf8",
      )) as unknown;
      const plan = analyzeFlowV2Import(source);
      expect(plan.valid, filename).toBe(true);
      expect(plan.flow, filename).toBeDefined();
      const html = renderFlowVisualizationHtml(plan.flow!, filename);
      const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
      for (const ref of listStepRefs(plan.flow!)) {
        const token = `id="step-${ref.path}"`;
        expect(html.split(token).length - 1, `${filename}:${ref.path}`).toBe(1);
      }
      for (const match of html.matchAll(/href="#([^"]+)"/g)) {
        expect(ids.has(match[1]), `${filename}:${match[1]}`).toBe(true);
      }
      expect(html).not.toContain("<script");
      expect(html).not.toContain("https://");
    }
  });
});

// Author: Harsha Gundala
// research.ts — operator tool: web research via Grok live search.

import { research } from "../../xai";
import { publicReleaseEgressEnabled } from "../../public-release-egress";
import type { OperatorTool } from "../types";

export const webSearch: OperatorTool = {
  name: "web_search",
  description: "Research the live web (company info, API docs, anything). Returns a cited summary.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  async execute(args) {
    if (!publicReleaseEgressEnabled("operatorWebSearch")) {
      return { output: { error: "operator web-search egress is disabled" } };
    }
    const text = await research(
      "Research the query on the live web. Reply with dense factual findings and source URLs. No preamble.",
      String(args.query)
    );
    return { output: text };
  },
};

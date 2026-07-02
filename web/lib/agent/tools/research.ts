// Author: Harsha Gundala
// research.ts — operator tool: web research via Grok live search.

import { chat, MODELS } from "../../xai";
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
    const msg = await chat(
      [
        { role: "system", content: "Research the query on the live web. Reply with dense factual findings and source URLs. No preamble." },
        { role: "user", content: String(args.query) },
      ],
      { model: MODELS.fast, search: true, maxTokens: 1200 }
    );
    return { output: msg.content };
  },
};

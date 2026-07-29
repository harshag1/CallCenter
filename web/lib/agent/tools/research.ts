// Author: Harsha Gundala
// research.ts — operator tool: provider-neutral server-owned web research.

import { publicReleaseEgressEnabled } from "../../public-release-egress";
import {
  OPERATOR_TURN_INFERENCE_LIMITS,
  runOperatorTurnResearch,
} from "../operator-turn-inference-authority";
import type { OperatorTool } from "../types";

export const webSearch: OperatorTool = {
  name: "web_search",
  description: "Research the live web (company info, API docs, anything). Returns a cited summary.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", minLength: 1, maxLength: 4_096 },
    },
    required: ["query"],
  },
  async execute(args, ctx) {
    if (!publicReleaseEgressEnabled("operatorWebSearch")) {
      return { output: { error: "operator web-search egress is disabled" } };
    }
    if (!ctx.inferenceAuthority) {
      return {
        output: { error: "operator turn inference authority is unavailable" },
      };
    }
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query || query.length > 4_096) {
      return { output: { error: "web-search query is invalid" } };
    }
    try {
      const result = await runOperatorTurnResearch(
        ctx.inferenceAuthority,
        "Research the query on the live web. Reply with dense factual findings and source URLs. No preamble.",
        query,
        {
          maxOutputTokens:
            OPERATOR_TURN_INFERENCE_LIMITS.maxResearchOutputTokensPerRequest,
        },
      );
      return { output: result.text };
    } catch {
      // Provider/runtime errors are deliberately not reflected into model
      // context. The finite authority remains consumed after any failed attempt.
      return { output: { error: "operator web-search request failed" } };
    }
  },
};

import { integrationStatuses } from "../../integrations";
import type { OperatorTool } from "../types";

export const listIntegrations: OperatorTool = {
  name: "list_integrations",
  description: "List supported voice, telephony, email, data, and tool-deployment integrations with capabilities and missing environment variable NAMES. Never returns secret values.",
  parameters: {
    type: "object",
    properties: { category: { type: "string", enum: ["voice", "telephony", "email", "data", "deployment"] } },
  },
  async execute(args) {
    const rows = integrationStatuses();
    return { output: args.category ? rows.filter((row) => row.category === args.category) : rows };
  },
};

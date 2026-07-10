// Add self-hosted voice tools here. They automatically appear in MCP discovery and can be
// granted by Flow v2 `always_tools`, node `tools`, or step `tools`.
//
// Example:
// export const VOICE_TOOL_EXTENSIONS: VoiceToolExtension[] = [{
//   name: "lookup_inventory",
//   description: "Look up current inventory for one SKU.",
//   inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
//   async execute(args, scope) { return inventory.lookup(scope.orgId, String(args.sku)); },
// }];

import type { VoiceToolExtension } from "./types";

export const VOICE_TOOL_EXTENSIONS: VoiceToolExtension[] = [];

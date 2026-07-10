# Extending tools

## Self-hosted live-call tool

Add a `VoiceToolExtension` to `web/lib/voice-tools/extensions.ts`:

```ts
export const VOICE_TOOL_EXTENSIONS: VoiceToolExtension[] = [{
  name: "lookup_inventory",
  description: "Look up current inventory for one SKU.",
  inputSchema: {
    type: "object",
    properties: { sku: { type: "string" } },
    required: ["sku"],
  },
  async execute(args, scope) {
    return inventory.lookup(scope.orgId, String(args.sku));
  },
}]
```

Grant `lookup_inventory` in a Flow v2 node or step. The registry validates names and duplicates, includes the schema in MCP discovery, and routes execution with org/agent/call scope.

Use `isAvailable(scope)` for tenant or feature-gated tools. Keep authorization in code and data access layers, not descriptions.

## Builder/operator tool

Add an `OperatorTool` to `web/lib/agent/tools/extensions.ts`. Operator tools receive the authenticated organization, email, focused agent, and public origin. Their output may also update a surface, flow panel, notice, or navigation.

## Minted edge tool

The builder can create a self-contained `async function run(input, env)` and deploy it to an isolated Vercel project. This path requires `ENABLE_TOOL_FACTORY=true`, `VERCEL_TOKEN`, and a unique `MCP_GATEWAY_SECRET`. Review generated-source and egress risk before enabling it.

## External MCP server

Use `add_mcp_server` with a streamable HTTP URL, optional authorization header, and optional tool allowlist. Authorization is encrypted in the org vault and attached to provider-side MCP configuration. xAI and OpenAI can call remote MCP directly. Gemini currently executes the platform gateway's function declarations in the browser; proxy external servers through a local extension if Gemini needs them.

## Adding a realtime provider

Implement `RealtimeProviderAdapter` under `web/lib/realtime/providers`, add it to `registry.ts`, add a browser transport under `web/components/call/providers`, and register environment/capability metadata. Keep flow and MCP semantics unchanged. If telephony codecs differ, capability-gate the bridge until a tested transcoder exists.

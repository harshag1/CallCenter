// Author: Harsha Gundala
// mcp — MCP gateway endpoint (streamable HTTP, JSON-RPC 2.0) consumed server-side by xAI voice sessions.

import { NextResponse } from "next/server";
import { verifyScope } from "@/lib/voice";
import { listToolsFor, callTool } from "@/lib/mcp";

export const maxDuration = 60;

type RpcRequest = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: Record<string, unknown> };

function rpcResult(id: RpcRequest["id"], result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}

export async function POST(req: Request) {
  const scopeToken = new URL(req.url).searchParams.get("scope");
  const scope = scopeToken ? verifyScope(scopeToken) : null;
  if (!scope) return NextResponse.json({ error: "invalid scope" }, { status: 401 });

  const rpc = (await req.json().catch(() => null)) as RpcRequest | null;
  if (!rpc?.method) return NextResponse.json({ error: "bad request" }, { status: 400 });

  switch (rpc.method) {
    case "initialize":
      return rpcResult(rpc.id, {
        protocolVersion: (rpc.params?.protocolVersion as string) ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "callcenter-gateway", version: "1.0.0" },
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return rpcResult(rpc.id, {});
    case "tools/list":
      return rpcResult(rpc.id, { tools: await listToolsFor(scope) });
    case "tools/call": {
      const name = String(rpc.params?.name ?? "");
      const args = (rpc.params?.arguments as Record<string, unknown>) ?? {};
      const result = await callTool(scope, name, args);
      const isErr = typeof result === "object" && result !== null && "error" in result;
      return rpcResult(rpc.id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: isErr,
      });
    }
    default:
      return NextResponse.json({
        jsonrpc: "2.0", id: rpc.id ?? null,
        error: { code: -32601, message: `method not found: ${rpc.method}` },
      });
  }
}

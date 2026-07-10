import { describe, expect, it, vi } from "vitest";
import { VoiceToolRegistry } from "../voice-tools/registry";

const scope = { callId: "call", agentId: "agent", orgId: "org" };

describe("voice tool extensions", () => {
  it("discovers and executes a registered tool", async () => {
    const execute = vi.fn(async (args) => ({ sku: args.sku, available: true }));
    const registry = new VoiceToolRegistry([{
      name: "lookup_inventory",
      description: "Look up one SKU.",
      inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
      execute,
    }]);
    expect(await registry.definitions(scope)).toHaveLength(1);
    expect(await registry.execute("lookup_inventory", { sku: "ABC" }, scope)).toEqual({ sku: "ABC", available: true });
    expect(execute).toHaveBeenCalledWith({ sku: "ABC" }, scope);
  });

  it("supports tenant-aware availability", async () => {
    const registry = new VoiceToolRegistry([{
      name: "vip_lookup",
      description: "VIP only.",
      inputSchema: { type: "object", properties: {} },
      isAvailable: (candidate) => candidate.orgId === "vip",
      execute: () => ({ ok: true }),
    }]);
    expect(await registry.definitions(scope)).toEqual([]);
    expect(await registry.execute("vip_lookup", {}, scope)).toMatchObject({ error: expect.stringContaining("unavailable") });
  });

  it("fails fast on duplicate or unsafe names", () => {
    const tool = { name: "valid_tool", description: "valid", inputSchema: {}, execute: () => null };
    expect(() => new VoiceToolRegistry([tool, tool])).toThrow(/duplicate/);
    expect(() => new VoiceToolRegistry([{ ...tool, name: "INVALID TOOL" }])).toThrow(/invalid/);
  });
});

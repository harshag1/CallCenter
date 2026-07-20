import { describe, expect, it } from "vitest";
import { LOCAL_TOOL_PROXY_FUNCTION } from "../../realtime/client/types";
import {
  CAPABILITY_GATEWAY_TOOL,
  CapabilityGatewayCallSchema,
  CapabilityGatewayResultSchema,
  ProviderCapabilitySnapshotSchema,
  bindCapabilityGatewayCall,
  renderProviderCapabilitySnapshot,
} from "../capability-gateway";

function capabilitySnapshot() {
  return ProviderCapabilitySnapshotSchema.parse({
    gateway_version: 1,
    scope: "field_service.close_and_reconcile",
    capability_epoch: 6,
    actions: [
      {
        name: "get_work_order_status",
        description: "Read status",
        input_schema: { type: "object" },
        semantic_hash: "b".repeat(64),
        capability_grant: "status-grant-123",
      },
      {
        name: "close_work_order",
        description: "Close once",
        input_schema: { type: "object" },
        semantic_hash: "a".repeat(64),
        capability_grant: "close-grant-123",
      },
    ],
  });
}

describe("provider-visible capability gateway contract", () => {
  it("is the byte-identical grant-free native function used by the live clients", () => {
    expect(CAPABILITY_GATEWAY_TOOL).toBe(LOCAL_TOOL_PROXY_FUNCTION);
    expect(JSON.stringify(CAPABILITY_GATEWAY_TOOL)).toBe(JSON.stringify(LOCAL_TOOL_PROXY_FUNCTION));
    expect(CAPABILITY_GATEWAY_TOOL).toMatchObject({
      type: "function",
      name: "capability_gateway",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["tool_name", "arguments"],
      },
    });
    const parameters = CAPABILITY_GATEWAY_TOOL.parameters as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(parameters.properties)).toEqual(["tool_name", "arguments"]);
    expect(parameters.properties.tool_name).toMatchObject({
      type: "string",
      pattern: "^[a-z][a-z0-9_.-]{1,63}$",
    });
    expect(JSON.stringify(CAPABILITY_GATEWAY_TOOL)).not.toContain("capability_grant");
  });

  it("accepts only the canonical model-authored shape and rejects authority injection", () => {
    expect(CapabilityGatewayCallSchema.parse({
      tool_name: "close_work_order",
      arguments: { work_order_id: "WO-2048", confirmed: true },
    })).toMatchObject({ tool_name: "close_work_order" });

    for (const invalid of [
      {
        action: "close_work_order",
        arguments: {},
        capability_grant: "opaque.signed.grant",
      },
      {
        tool_name: "close_work_order",
        arguments: {},
        capability_grant: "model-authored-grant",
      },
      { tool_name: "BAD ACTION", arguments: {} },
      { tool_name: "close_work_order", arguments: { invalid: undefined } },
    ]) {
      expect(() => CapabilityGatewayCallSchema.parse(invalid)).toThrow();
    }
  });

  it("binds current grant and epoch only inside the host authority boundary", () => {
    const snapshot = capabilitySnapshot();
    expect(bindCapabilityGatewayCall({
      tool_name: "close_work_order",
      arguments: { work_order_id: "WO-2048" },
    }, snapshot)).toEqual({
      call: {
        action: "close_work_order",
        arguments: { work_order_id: "WO-2048" },
        capability_grant: "close-grant-123",
      },
      capabilityEpoch: 6,
    });
    expect(bindCapabilityGatewayCall({
      tool_name: "undisclosed_action",
      arguments: {},
    }, snapshot)).toBeNull();
  });

  it("separates authoritative success receipts from explicit failures", () => {
    expect(CapabilityGatewayResultSchema.parse({
      ok: true,
      gateway_version: 1,
      action: "notify_dispatch",
      receipt_id: "receipt-1",
      disposition: "executed",
      authoritative_result: { notification_receipt: "NTF-1" },
    })).toMatchObject({ ok: true, receipt_id: "receipt-1" });
    expect(CapabilityGatewayResultSchema.parse({
      ok: false,
      gateway_version: 1,
      action: "close_work_order",
      code: "stale_capability",
      message: "Use the latest grant",
      retriable: true,
      current_capability_epoch: 7,
    })).toMatchObject({ ok: false, code: "stale_capability" });
    expect(() => CapabilityGatewayResultSchema.parse({
      ok: true,
      gateway_version: 1,
      action: "notify_dispatch",
      disposition: "executed",
      authoritative_result: {},
    })).toThrow();
  });

  it("renders catalogs deterministically without leaking host-only grant bytes", () => {
    const snapshot = capabilitySnapshot();
    const rendered = renderProviderCapabilitySnapshot(snapshot);

    expect(rendered).not.toContain("capability_grant");
    expect(rendered).not.toContain("close-grant-123");
    expect(rendered).not.toContain("status-grant-123");
    expect(rendered).toContain('"capability_epoch":6');
    expect(rendered.indexOf('"name":"close_work_order"')).toBeLessThan(
      rendered.indexOf('"name":"get_work_order_status"')
    );
    expect(renderProviderCapabilitySnapshot({
      ...snapshot,
      actions: [...snapshot.actions].reverse(),
    })).toBe(rendered);
    expect(() => ProviderCapabilitySnapshotSchema.parse({
      ...snapshot,
      actions: [snapshot.actions[0], snapshot.actions[0]],
    })).toThrow(/duplicate action/);
  });
});

import { describe, expect, it } from "vitest";
import {
  CAPABILITY_GATEWAY_TOOL,
  CapabilityGatewayCallSchema,
  CapabilityGatewayResultSchema,
  ProviderCapabilitySnapshotSchema,
  renderProviderCapabilitySnapshot,
} from "../capability-gateway";

describe("provider-visible capability gateway contract", () => {
  it("keeps one action-agnostic native function schema", () => {
    expect(CAPABILITY_GATEWAY_TOOL).toMatchObject({
      type: "function",
      name: "capability_gateway",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action", "arguments", "capability_grant"],
      },
    });
    const parameters = CAPABILITY_GATEWAY_TOOL.parameters as { properties: Record<string, unknown> };
    expect(parameters.properties.action).not.toHaveProperty("enum");
  });

  it("rejects stale-shape calls before any business action is dispatched", () => {
    expect(CapabilityGatewayCallSchema.parse({
      action: "close_work_order",
      arguments: { work_order_id: "WO-2048", confirmed: true },
      capability_grant: "opaque.signed.grant",
    })).toMatchObject({ action: "close_work_order" });
    expect(() => CapabilityGatewayCallSchema.parse({
      action: "close_work_order",
      arguments: {},
    })).toThrow();
    expect(() => CapabilityGatewayCallSchema.parse({
      action: "BAD ACTION",
      arguments: {},
      capability_grant: "grant",
    })).toThrow();
    expect(() => CapabilityGatewayCallSchema.parse({
      action: "close_work_order",
      arguments: { invalid: undefined },
      capability_grant: "grant",
    })).toThrow();
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

  it("renders runtime grants deterministically while preserving opaque grant bytes", () => {
    const snapshot = ProviderCapabilitySnapshotSchema.parse({
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
    const rendered = renderProviderCapabilitySnapshot(snapshot);

    expect(rendered).toContain('"capability_grant":"close-grant-123"');
    expect(rendered).toContain('"capability_grant":"status-grant-123"');
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

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createOfflineDemoToolRegistry,
  runOfflineFlowDemo,
  type OfflineDemoToolRegistry,
} from "../offline-flow-demo";

const flow = JSON.parse(readFileSync(
  new URL("../../../examples/flows/service-appointment-lifecycle.json", import.meta.url),
  "utf8"
)) as unknown;

describe("five-minute offline Flow v2 demo", () => {
  it("installs a catalog-closed deep flow and emits deterministic receipt evidence", () => {
    const first = runOfflineFlowDemo(flow);
    const second = runOfflineFlowDemo(flow);

    expect(first).toMatchObject({
      ok: true,
      mode: "offline",
      installation: {
        persistence: "in_memory",
        catalog_closed: true,
        registered_tools: 17,
        flow_steps: 15,
      },
      simulation: {
        events: 30,
        flow_receipts: 9,
        fake_tool_calls: 10,
        indeterminate_dispatches_reconciled: 1,
        provider_calls: 0,
        database_writes: 0,
      },
    });
    expect(second).toEqual(first);
    if (!first.ok) throw new Error(first.error);
    expect(first.installation.flow_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.evidence.fake_call_receipts_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.evidence.trace_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.evidence.final_state_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.evidence.fake_call_receipts.map(({ tool }) => tool)).toEqual([
      "lookup_service_customer",
      "classify_appointment_intent",
      "capture_service_preferences",
      "search_service_slots",
      "select_service_slot",
      "capture_slot_review",
      "capture_booking_consent",
      "commit_service_appointment_operation",
      "lookup_appointment_invocation",
      "submit_appointment_notification",
    ]);
  });

  it("fails before simulation when the integration catalog is incomplete", () => {
    const incomplete: Record<string, { execute: (arguments_: Record<string, unknown>) => unknown }> = {
      ...createOfflineDemoToolRegistry(),
    };
    delete incomplete.lookup_appointment_invocation;
    const result = runOfflineFlowDemo(flow, incomplete);

    expect(result).toMatchObject({
      ok: false,
      stage: "catalog_admission",
      details: {
        catalog: {
          status: "incomplete",
          missing: ["lookup_appointment_invocation"],
        },
      },
    });
  });

  it("fails closed when a fake integration violates the flow's receipt binding", () => {
    const registry: OfflineDemoToolRegistry = {
      ...createOfflineDemoToolRegistry(),
      lookup_service_customer: {
        execute: () => ({ customer_id: 1001 }),
      },
    };
    const result = runOfflineFlowDemo(flow, registry);

    expect(result).toMatchObject({
      ok: false,
      stage: "scenario_simulation",
      details: {
        ok: false,
        stage: "complete_step",
        code: "receipt_output_type",
      },
    });
  });

  it("fails before simulator admission when the flow definition is tampered", () => {
    const tampered = structuredClone(flow) as {
      nodes: Array<{ id: string; steps?: Array<{ id: string; tools?: string[] }> }>;
    };
    const appointment = tampered.nodes.find(({ id }) => id === "appointment");
    const route = appointment?.steps?.find(({ id }) => id === "route");
    if (!route) throw new Error("appointment route fixture missing");
    route.tools = [...(route.tools ?? []), "unregistered_demo_tool"];

    const result = runOfflineFlowDemo(tampered);
    expect(result).toMatchObject({
      ok: false,
      stage: "catalog_admission",
      details: {
        catalog: {
          status: "incomplete",
          missing: ["unregistered_demo_tool"],
        },
      },
    });
  });
});

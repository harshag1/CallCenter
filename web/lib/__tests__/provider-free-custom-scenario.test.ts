import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { runFlowScenario } from "../agent/tools/flow-testing";

const flowUrl = new URL(
  "../../../examples/flows/membership-return-resolution.json",
  import.meta.url,
);
const scenarioUrl = new URL(
  "../../../examples/scenarios/membership-return-recovery.json",
  import.meta.url,
);

describe("provider-free custom scenario example", () => {
  it("runs a checked-in return flow through restart and proof-backed reconciliation", () => {
    const flow = JSON.parse(readFileSync(flowUrl, "utf8")) as unknown;
    const scenario = JSON.parse(readFileSync(scenarioUrl, "utf8")) as unknown;
    const result = runFlowScenario(flow, scenario);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.assertions).toEqual({ passed: true });
    expect(result.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "interrupt",
        reason: "process_restart",
        recovered_receipt_ids: ["receipt:create"],
      }),
      expect.objectContaining({
        type: "reconcile_action",
        receipt_id: "receipt:create",
        proof_id: "proof:return-readback:001",
        status: "succeeded",
      }),
    ]));
    expect(result.final).toMatchObject({
      status: "completed",
      current_step: null,
      completed_steps: expect.arrayContaining([
        "membership_return.return_items.select_item.item_details.eligibility",
        "membership_return.create_return",
        "membership_return.create_return.notify",
      ]),
    });
  });
});

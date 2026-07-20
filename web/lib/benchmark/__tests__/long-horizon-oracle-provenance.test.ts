import { describe, expect, it } from "vitest";
import {
  LONG_HORIZON_SCENARIO_SUITE,
} from "../long-horizon-scenario-suite";
import {
  createToolWorld,
  executeTool,
} from "../tool-world";
import type { JsonValue } from "../scenario-schema";

function scalars(value: JsonValue, into: JsonValue[] = []): JsonValue[] {
  if (value === null || typeof value !== "object") {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) scalars(item, into);
  } else {
    for (const item of Object.values(value)) scalars(item, into);
  }
  return into;
}

function hasValue(values: readonly JsonValue[], target: JsonValue): boolean {
  return values.some((value) => Object.is(value, target));
}

describe("long-horizon oracle argument provenance", () => {
  it("never requires a hidden machine-coded scalar that was absent from caller history, prior receipts, and decoy-rich schema vocabulary", () => {
    for (const source of LONG_HORIZON_SCENARIO_SUITE) {
      let state = createToolWorld(source.scenario);
      const receiptVisibleValues: JsonValue[] = [];
      for (const invocation of source.oracleInvocations) {
        const callerValues = source.scenario.caller.turns
          .filter((_turn, index) => index + 1 <= invocation.turn)
          .flatMap((turn) => turn.fact_updates.flatMap((update) => scalars(update.value)));
        const tool = source.scenario.tools.find((candidate) => candidate.name === invocation.tool);
        if (!tool) throw new Error(`missing ${source.scenario.id}/${invocation.tool}`);

        for (const [argumentName, argumentValue] of Object.entries(invocation.arguments)) {
          if (typeof argumentValue !== "string" || !/[_/]/.test(argumentValue)) continue;
          const argument = tool.arguments.find((candidate) => candidate.name === argumentName);
          const schemaValues = argument?.enum ?? [];
          const fromCaller = hasValue(callerValues, argumentValue);
          const fromReceipt = hasValue(receiptVisibleValues, argumentValue);
          const fromSchema = hasValue(schemaValues, argumentValue);
          expect(
            fromCaller || fromReceipt || fromSchema,
            `${source.scenario.id}/${invocation.tool}.${argumentName}=${argumentValue}`
          ).toBe(true);
          if (fromSchema && !fromCaller && !fromReceipt) {
            expect(schemaValues.length, `${source.scenario.id}/${invocation.tool}.${argumentName}/decoys`)
              .toBeGreaterThanOrEqual(3);
          }
        }

        const execution = executeTool(source.scenario, state, {
          invocation_id: invocation.invocationId,
          tool: invocation.tool,
          arguments: invocation.arguments,
          turn: invocation.turn,
        });
        state = execution.state;
        if (execution.receipt.visible_result.ok) {
          receiptVisibleValues.push(...scalars(execution.receipt.visible_result.data));
        }
      }
    }
    // This deliberately scans caller history and replays every oracle
    // invocation across all nine long-horizon fixtures. Provenance coverage,
    // not wall-clock performance, is the invariant under test.
  }, 60_000);
});

import { canonicalJson, sha256Hex } from "../../artifacts";
import type { CompiledCondition, ScheduledUnit } from "./types";

const CONDITION_DOMAIN = "harshas-amazing-call-center/hacc-proof-v1/condition\n";

export function compileCondition(unit: ScheduledUnit): CompiledCondition {
  const treatment = unit.arm === "hacc"
    ? Object.freeze({
      mode: "full_hacc" as const,
      response_plan: true,
      progressive_capabilities: true,
      durable_authority: true,
      effect_receipts: true,
      async_workers: true,
    })
    : Object.freeze({
      mode: "registered_native" as const,
      response_plan: false,
      progressive_capabilities: false,
      durable_authority: false,
      effect_receipts: false,
      async_workers: false,
    });
  const body = {
    schema_version: 1 as const,
    protocol: "HACC-Proof-v1" as const,
    unit_id: unit.unit_id,
    arm: unit.arm,
    identity: Object.freeze({ ...unit.identity }),
    scenario_sha256: unit.scenario_sha256,
    caller_plan_sha256: unit.caller_plan_sha256,
    tools_sha256: unit.tools_sha256,
    substantive_context_sha256: unit.substantive_context_sha256,
    treatment,
  };
  return Object.freeze({
    ...body,
    condition_sha256: sha256Hex(`${CONDITION_DOMAIN}${canonicalJson(body)}`),
  });
}

/** Treatment is the only permitted difference inside a registered pair. */
export function assertCompiledPairParity(left: CompiledCondition, right: CompiledCondition): void {
  const view = (condition: CompiledCondition) => canonicalJson({
    protocol: condition.protocol,
    identity: condition.identity,
    scenario_sha256: condition.scenario_sha256,
    caller_plan_sha256: condition.caller_plan_sha256,
    tools_sha256: condition.tools_sha256,
    substantive_context_sha256: condition.substantive_context_sha256,
  });
  if (left.arm === right.arm || view(left) !== view(right)) {
    throw new Error("compiled pair violates identity or information parity");
  }
}

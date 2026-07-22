import { describe, expect, it } from "vitest";
import { AgentFlowSchema } from "../../flow";
import { createFlowExecutionState, type FlowExecutionState } from "../../flow-runtime";
import { compileConditionSuite } from "../condition-compiler";
import { industrialFieldServiceCompilerInput } from "../industrial-field-service-source";
import {
  advanceHaccSpeechGuardrailState,
  createHaccSpeechGuardrailPacket,
  createInitialHaccSpeechGuardrailState,
} from "../speech-guardrail-packet";
import {
  assertHaccResponsePlan,
  createHaccResponsePlan,
} from "../response-plan";
import { BenchmarkScenarioSchema, type JsonValue } from "../scenario-schema";
import scenarioJson from "../../../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";
import type { AdmissibilityFrontierEvidence } from "../admissibility-frontier";
import type { ProviderCapabilitySnapshot } from "../capability-gateway";

const scenario = BenchmarkScenarioSchema.parse(scenarioJson);
const compilerInput = industrialFieldServiceCompilerInput(scenario);
const flow = AgentFlowSchema.parse(compilerInput.flow);
const condition = compileConditionSuite(compilerInput).conditions["host-managed-harness"];
const target = "step:field_service.verify_technician" as const;
const disclosure = condition.disclosures.find((item) => item.target === target);
if (!disclosure) throw new Error("response-plan test disclosure is unavailable");

const snapshot: ProviderCapabilitySnapshot = {
  gateway_version: 1,
  scope: target,
  capability_epoch: 7,
  actions: disclosure.visibleCapabilities.map((capability, index) => ({
    name: capability.name,
    description: capability.description,
    input_schema: capability.inputSchema as Record<string, JsonValue>,
    semantic_hash: capability.semanticHash,
    capability_grant: `test-grant-${index}`,
  })),
};

const frontierEvidence = {
  evidence_sha256: "a".repeat(64),
} as AdmissibilityFrontierEvidence;

function secretBearingState(): FlowExecutionState {
  return {
    ...createFlowExecutionState("2026-07-21T00:00:00.000Z"),
    status: "active",
    nodeId: "field_service",
    currentStep: "field_service.verify_technician",
    capabilityEpoch: snapshot.capability_epoch,
    actionReceipts: [{
      id: "secret-bearing-verification-receipt",
      idempotencyKey: "secret-bearing-verification-key",
      step: "field_service.verify_technician",
      tool: "verify_technician",
      capabilityEpoch: snapshot.capability_epoch,
      arguments: { employee_id: "E-731", pin: "4826" },
      argumentsHash: "b".repeat(64),
      status: "succeeded",
      result: { verified: true, private_oracle_token: "ORACLE-DO-NOT-EXPOSE" },
      resultHash: "c".repeat(64),
      reservedAt: "2026-07-21T00:00:00.000Z",
      dispatchStartedAt: "2026-07-21T00:00:00.000Z",
      dispatchAttempt: 1,
      settledAt: "2026-07-21T00:00:00.000Z",
    }],
  };
}

function privacyPacket() {
  const initial = createInitialHaccSpeechGuardrailState();
  const first = createHaccSpeechGuardrailPacket(initial, null);
  const verified = advanceHaccSpeechGuardrailState(initial, {
    kind: "verification_succeeded",
    evidence_sha256: "d".repeat(64),
  });
  return createHaccSpeechGuardrailPacket(verified, first.packet_sha256);
}

function plan(revision = 1, previousPlanSha256: string | null = null) {
  return createHaccResponsePlan({
    flow,
    state: secretBearingState(),
    conditionSha256: condition.conditionHash,
    target,
    catalogMode: "target",
    snapshot,
    frontierEvidence,
    quarantines: [],
    speechGuardrailPacket: privacyPacket(),
    revision,
    previousPlanSha256,
  });
}

describe("HACC state-derived response plan", () => {
  it("exposes only public slot/action names and never receipt, private, oracle, or future values", () => {
    const responsePlan = assertHaccResponsePlan(plan());
    expect(responsePlan).toMatchObject({
      current_step: target.slice("step:".length),
      target,
      response_mode: "act",
      context_authority: "advisory_only_gateway_and_speech_gate_enforced",
      present_public_slots: ["verified"],
      missing_public_slots: ["verification_token"],
      prohibited_claims: [
        "repeat_verification_secrets",
        "terminal_success_without_authoritative_receipt",
      ],
    });
    const encoded = JSON.stringify(responsePlan);
    for (const forbidden of ["4826", "E-731", "ORACLE-DO-NOT-EXPOSE", "private_oracle_token"]) {
      expect(encoded).not.toContain(forbidden);
    }
    expect(responsePlan.capability_catalog).toEqual({
      scope: snapshot.scope,
      capability_epoch: snapshot.capability_epoch,
      actions: snapshot.actions.map((action) => ({
        name: action.name,
        description: action.description,
        input_schema: action.input_schema,
        semantic_hash: action.semantic_hash,
      }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    });
    expect(encoded).not.toContain("test-grant-");
  });

  it("rejects stale revisions, epochs, targets, frontier bindings, and chain substitutions", () => {
    const first = plan();
    const second = plan(2, first.plan_sha256);
    expect(() => assertHaccResponsePlan(first, { revision: 2 })).toThrow("revision is stale");
    expect(() => assertHaccResponsePlan(first, { capabilityEpoch: 8 })).toThrow("epoch is stale");
    expect(() => assertHaccResponsePlan(first, { target: "step:other" })).toThrow("target is stale");
    expect(() => assertHaccResponsePlan(first, { frontierEvidenceSha256: "e".repeat(64) }))
      .toThrow("frontier evidence is stale");
    expect(() => assertHaccResponsePlan(second, { previousPlanSha256: "f".repeat(64) }))
      .toThrow("chain is stale");
    expect(() => assertHaccResponsePlan(second, { previousPlanSha256: first.plan_sha256 })).not.toThrow();
  });

  it("rejects deletion, action substitution, slot mutation, and packet-hash tampering", () => {
    const responsePlan = plan();
    expect(() => assertHaccResponsePlan({
      ...responsePlan,
      eligible_actions: [...responsePlan.eligible_actions, "zz_future_private_action"],
    })).toThrow("capability catalog differs from eligible actions");
    expect(() => assertHaccResponsePlan({
      ...responsePlan,
      present_public_slots: [],
      missing_public_slots: ["verified"],
    })).toThrow("state hash mismatch");
    expect(() => assertHaccResponsePlan({ ...responsePlan, plan_sha256: "0".repeat(64) }))
      .toThrow("packet hash mismatch");
    const tamperedCatalog = structuredClone(responsePlan.capability_catalog);
    tamperedCatalog.actions[0]!.description = "A substituted model-visible contract.";
    expect(() => assertHaccResponsePlan({
      ...responsePlan,
      capability_catalog: tamperedCatalog,
    })).toThrow("capability catalog hash mismatch");
    const deleted = { ...responsePlan } as Record<string, unknown>;
    delete deleted.prohibited_claims;
    expect(() => assertHaccResponsePlan(deleted)).toThrow();
  });
});

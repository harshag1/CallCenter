import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import scenarioJson from "../../../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";
import { compileConditionSuite } from "../condition-compiler";
import {
  createInMemoryBenchmarkGatewayKernel,
  type InMemoryBenchmarkGatewayKernel,
} from "../gateway-kernel";
import {
  createBenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationExpectation,
  type BenchmarkKernelEvidenceBinding,
} from "../kernel-attestation";
import {
  INDUSTRIAL_FIELD_SERVICE_FLOW,
  industrialFieldServiceCompilerInput,
} from "../industrial-field-service-source";
import {
  createProviderReadOnlyReceiptLinkage,
  deriveProviderReceiptInvocationId,
  verifyProviderReadOnlyReceiptLinkage,
  type ProviderReadOnlyReceiptLinkage,
} from "../provider-receipt-linkage";
import {
  BenchmarkScenarioSchema,
  type JsonValue,
} from "../scenario-schema";
import {
  createToolWorld,
  executeTool,
  type ToolWorldState,
} from "../tool-world";
import type { BenchmarkGatewayOutcome } from "../orchestrator";
import type { ProviderCapabilitySnapshot } from "../capability-gateway";

const scenario = BenchmarkScenarioSchema.parse(scenarioJson);
const suite = compileConditionSuite(industrialFieldServiceCompilerInput(scenario));
const condition = suite.conditions["raw-full"];
const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const signer = createBenchmarkKernelAttestationSigner({
  keyId: "provider-receipt-linkage-test-v1",
  privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  publicKeyPem,
});
const evidenceBinding: BenchmarkKernelEvidenceBinding = Object.freeze({
  pairId: "pair-provider-receipt-linkage",
  leaseSubjectId: "pair-provider-receipt-linkage",
  provider: "offline",
  model: "deterministic-toolworld-linkage-v1",
  planSha256: "1".repeat(64),
  freezeLockSha256: "2".repeat(64),
  kernelBuildSha256: "3".repeat(64),
});
const trust = Object.freeze({
  keyId: signer.keyId,
  publicKeySha256: signer.publicKeySha256,
  publicKeyPem,
});

type Harness = {
  runId: string;
  kernel: InMemoryBenchmarkGatewayKernel;
  snapshot: ProviderCapabilitySnapshot;
  world: ToolWorldState;
  turn: number;
};

function createHarness(runId: string): Harness {
  const kernel = createInMemoryBenchmarkGatewayKernel({
    flow: INDUSTRIAL_FIELD_SERVICE_FLOW,
    expectedFlowHash: suite.flowHash,
    expectedScenarioHash: suite.scenarioHash,
    expectedConditionHash: condition.conditionHash,
    grantBindingHash: suite.sourceHash,
    leaseSubjectId: evidenceBinding.leaseSubjectId,
    evidenceBinding,
    signer,
    capabilitySecret: "provider-receipt-linkage-test-capability-secret-v1",
    clock: Object.freeze({
      nowMs: () => Date.parse("2026-07-19T08:00:00.000Z"),
      nowIso: () => "2026-07-19T08:00:00.000Z",
    }),
  });
  const world = createToolWorld(scenario);
  const snapshot = kernel.initialize({ runId, condition, scenario, world });
  return { runId, kernel, snapshot, world, turn: 0 };
}

function grant(harness: Harness, action: string): string {
  const capability = harness.snapshot.actions.find((candidate) => candidate.name === action);
  if (!capability) throw new Error(`missing test capability ${action}`);
  return capability.capability_grant;
}

function invoke(
  harness: Harness,
  providerCallId: string,
  action: string,
  args: Record<string, JsonValue>,
  invocationId = deriveProviderReceiptInvocationId(providerCallId)
): BenchmarkGatewayOutcome {
  harness.turn += 1;
  const outcome = harness.kernel.invoke({
    providerCallId,
    call: {
      action,
      arguments: structuredClone(args),
      capability_grant: grant(harness, action),
    },
    capabilityEpoch: harness.snapshot.capability_epoch,
    condition,
    turn: harness.turn,
    world: structuredClone(harness.world),
    executeLeaf: (request) => {
      const execution = executeTool(scenario, harness.world, {
        invocation_id: invocationId,
        tool: request.action,
        arguments: structuredClone(request.arguments),
        turn: harness.turn,
        ...(request.idempotencyKey ? { idempotency_key: request.idempotencyKey } : {}),
      });
      harness.world = execution.state;
      return execution;
    },
  });
  if (outcome.capabilitySnapshot) harness.snapshot = outcome.capabilitySnapshot;
  return outcome;
}

function proof(harness: Harness) {
  const transcript = harness.kernel.encodedTranscript();
  const transcriptReference = harness.kernel.transcriptReference();
  const finalAttestation = harness.kernel.attestFinal({
    runId: harness.runId,
    condition,
    scenario,
    world: harness.world,
  });
  const attestationExpectation: BenchmarkKernelAttestationExpectation = Object.freeze({
    runId: harness.runId,
    condition,
    scenario,
    world: harness.world,
    transcriptReference,
    evidenceBinding,
    trust,
  });
  return { transcript, finalAttestation, attestationExpectation };
}

function successfulReadHarness(runId = "run-provider-receipt-linkage"): Harness {
  const harness = createHarness(runId);
  const identity = invoke(
    harness,
    `${runId}-identity`,
    "verify_technician",
    { employee_id: "E-731", pin: "4826" }
  );
  expect(identity.result.ok).toBe(true);
  const read = invoke(
    harness,
    `${runId}-read`,
    "get_work_order_status",
    { work_order_id: "WO-2048" }
  );
  expect(read.result).toMatchObject({ ok: true, disposition: "executed" });
  return harness;
}

describe("provider read-only ToolWorld receipt linkage", () => {
  it("derives stable receipt identities directly from opaque provider call IDs", () => {
    const first = deriveProviderReceiptInvocationId("call.abc:123");
    expect(first).toMatch(/^provider_call_[a-f0-9]{64}$/);
    expect(deriveProviderReceiptInvocationId("call.abc:123")).toBe(first);
    expect(deriveProviderReceiptInvocationId("call.abc:124")).not.toBe(first);
    expect(() => deriveProviderReceiptInvocationId("bad call id")).toThrow(
      /provider call ID is invalid/
    );
  });

  it("links one signed provider call to one admitted, effect-free ToolWorld query receipt", () => {
    const harness = successfulReadHarness();
    const providerCallId = "run-provider-receipt-linkage-read";
    const linkage = createProviderReadOnlyReceiptLinkage({
      providerCallId,
      ...proof(harness),
    });

    expect(linkage).toMatchObject({
      schema_version: 1,
      linkage_type: "provider_read_only_toolworld_receipt",
      run_id: harness.runId,
      provider_call_id: providerCallId,
      invocation_id: deriveProviderReceiptInvocationId(providerCallId),
      receipt_id: `rcpt:${scenario.id}:${deriveProviderReceiptInvocationId(providerCallId)}`,
      tool: "get_work_order_status",
      turn: 2,
      safety_proof: {
        tool_kind: "query",
        declared_effect_count: 0,
        committed: false,
        receipt_effect_count: 0,
        world_effect_count: 0,
        tainted_result_path_count: 0,
        outcome_class: "success_executed",
      },
    });
    expect(linkage.transcript_reference).toEqual(harness.kernel.transcriptReference());
    expect(linkage.linkage_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(linkage.receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(linkage)).toBe(true);
    expect(
      verifyProviderReadOnlyReceiptLinkage({ linkage, ...proof(harness) })
    ).toEqual({
      valid: true,
      errors: [],
      expected_linkage_sha256: linkage.linkage_sha256,
    });
  });

  it("rejects mutation/effectful tools even when their signed receipt succeeded", () => {
    const harness = createHarness("run-effectful-linkage");
    invoke(
      harness,
      "provider-effectful",
      "verify_technician",
      { employee_id: "E-731", pin: "4826" }
    );
    expect(() => createProviderReadOnlyReceiptLinkage({
      providerCallId: "provider-effectful",
      ...proof(harness),
    })).toThrow(/not a zero-effect read-only query/);
  });

  it("rejects a signed provider call whose exact derived ToolWorld receipt is missing", () => {
    const harness = createHarness("run-missing-receipt");
    invoke(
      harness,
      "provider-missing-receipt",
      "lookup_work_order",
      { work_order_id: "WO-2048" },
      "model_call_000001"
    );
    expect(() => createProviderReadOnlyReceiptLinkage({
      providerCallId: "provider-missing-receipt",
      ...proof(harness),
    })).toThrow(/signed ToolWorld is missing receipt invocation/);
  });

  it("rejects every transcript containing a reused provider call ID", () => {
    const harness = successfulReadHarness("run-reused-provider-id");
    invoke(
      harness,
      "run-reused-provider-id-read",
      "get_work_order_status",
      { work_order_id: "WO-2048" }
    );
    expect(() => createProviderReadOnlyReceiptLinkage({
      providerCallId: "run-reused-provider-id-read",
      ...proof(harness),
    })).toThrow(/provider call ID .* was reused/);
  });

  it("rejects transcript/attestation substitution and forged persisted linkage fields", () => {
    const first = successfulReadHarness("run-linkage-first");
    const second = successfulReadHarness("run-linkage-second");
    expect(() => createProviderReadOnlyReceiptLinkage({
      providerCallId: "run-linkage-first-read",
      transcript: first.kernel.encodedTranscript(),
      finalAttestation: proof(second).finalAttestation,
      attestationExpectation: proof(second).attestationExpectation,
    })).toThrow(/kernel transcript is not signed and valid/);

    const validProof = proof(first);
    const linkage = createProviderReadOnlyReceiptLinkage({
      providerCallId: "run-linkage-first-read",
      ...validProof,
    });
    const forged = structuredClone(linkage) as {
      -readonly [Key in keyof ProviderReadOnlyReceiptLinkage]:
        ProviderReadOnlyReceiptLinkage[Key];
    };
    forged.receipt_id = "rcpt:forged";
    expect(verifyProviderReadOnlyReceiptLinkage({
      linkage: forged,
      ...validProof,
    })).toMatchObject({
      valid: false,
      errors: ["persisted linkage differs from exact recomputation"],
      expected_linkage_sha256: linkage.linkage_sha256,
    });
  });
});

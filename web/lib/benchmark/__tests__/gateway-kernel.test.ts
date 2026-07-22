import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import scenarioJson from "../../../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";
import { AgentFlowSchema } from "../../flow";
import { deriveFlowActionInvocationId } from "../../flow-runtime";
import { compileConditionSuite, type CompiledBenchmarkCondition } from "../condition-compiler";
import { createInMemoryBenchmarkGatewayKernel, type InMemoryBenchmarkGatewayKernel } from "../gateway-kernel";
import {
  createBenchmarkKernelAttestationSigner,
  verifyBenchmarkKernelFinalAttestation,
  type BenchmarkKernelEvidenceBinding,
} from "../kernel-attestation";
import {
  DEFAULT_KERNEL_TRANSCRIPT_LIMITS,
  verifyKernelTranscript,
  type KernelTranscriptLimits,
} from "../kernel-transcript";
import {
  INDUSTRIAL_FIELD_SERVICE_FLOW,
  industrialFieldServiceCompilerInput,
} from "../industrial-field-service-source";
import { longUsefulnessTask } from "../long-call-live-experiment";
import { BenchmarkScenarioSchema, type JsonValue } from "../scenario-schema";
import { createToolWorld, executeTool, type ToolWorldState } from "../tool-world";
import type { BenchmarkGatewayOutcome } from "../orchestrator";
import type { ProviderCapabilitySnapshot } from "../capability-gateway";

const scenario = BenchmarkScenarioSchema.parse(scenarioJson);
const suite = compileConditionSuite(industrialFieldServiceCompilerInput(scenario));
const FIXED_CLOCK = Object.freeze({
  nowMs: () => Date.parse("2026-07-10T12:00:00.000Z"),
  nowIso: () => "2026-07-10T12:00:00.000Z",
});
const TEST_KEYS = generateKeyPairSync("ed25519");
const TEST_PUBLIC_KEY_PEM = TEST_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();
const TEST_SIGNER = createBenchmarkKernelAttestationSigner({
  keyId: "benchmark-test-ed25519-v1",
  privateKeyPem: TEST_KEYS.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  publicKeyPem: TEST_PUBLIC_KEY_PEM,
});
const TEST_EVIDENCE_BINDING: BenchmarkKernelEvidenceBinding = Object.freeze({
  pairId: "pair-industrial-test",
  leaseSubjectId: "pair-industrial-test",
  provider: "offline",
  model: "deterministic-toolworld-sensitivity-v1",
  planSha256: "1".repeat(64),
  freezeLockSha256: "2".repeat(64),
  kernelBuildSha256: "3".repeat(64),
});
const TEST_TRUST = Object.freeze({
  keyId: TEST_SIGNER.keyId,
  publicKeySha256: TEST_SIGNER.publicKeySha256,
  publicKeyPem: TEST_PUBLIC_KEY_PEM,
});
const TEST_ATTESTATION_OPTIONS = Object.freeze({
  evidenceBinding: TEST_EVIDENCE_BINDING,
  signer: TEST_SIGNER,
});

type Harness = {
  kernel: InMemoryBenchmarkGatewayKernel;
  condition: CompiledBenchmarkCondition;
  snapshot: ProviderCapabilitySnapshot;
  world: ToolWorldState;
  sequence: number;
};

type PublicInvokePayload = Readonly<{
  input: Readonly<{
    arguments_hmac_sha256: string;
    provider_call_fingerprint_hmac_sha256: string;
  }>;
  post_state: Readonly<{
    capability_head: JsonValue;
    durable_memory_head: Readonly<{
      applicability: "durable_memory_enabled" | "not_applicable";
      revision: number;
      entry_count: number;
    }>;
  }>;
  public_durable_memory_delta: Readonly<{
    operation: "none" | "set" | "delete";
    key_hmac_sha256: string | null;
    value_hmac_sha256: string | null;
  }>;
  public_world_delta: Readonly<{
    receipts_append: readonly JsonValue[];
  }>;
  outcome: Readonly<{
    result_class: string;
    provider_visible_output_hmac_sha256: string;
  }>;
}>;

function publicInvokePayload(
  entry: ReturnType<InMemoryBenchmarkGatewayKernel["transcript"]>["entries"][number]
): PublicInvokePayload {
  if (entry.operation !== "invoke" || entry.payload === null || typeof entry.payload !== "object" || Array.isArray(entry.payload)) {
    throw new Error("expected public invocation transcript payload");
  }
  return entry.payload as unknown as PublicInvokePayload;
}

function createHarness(
  id: keyof typeof suite.conditions,
  runId = `run-${id}`,
  options: Readonly<{
    transcriptLimits?: KernelTranscriptLimits;
    clock?: Readonly<{ nowMs(): number; nowIso(): string }>;
  }> = {}
): Harness {
  const condition = suite.conditions[id];
  const kernel = createInMemoryBenchmarkGatewayKernel({
    flow: INDUSTRIAL_FIELD_SERVICE_FLOW,
    expectedFlowHash: suite.flowHash,
    expectedScenarioHash: suite.scenarioHash,
    expectedConditionHash: condition.conditionHash,
    grantBindingHash: suite.sourceHash,
    leaseSubjectId: "pair-industrial-test",
    ...TEST_ATTESTATION_OPTIONS,
    capabilitySecret: "benchmark-test-secret-that-is-at-least-thirty-two-characters",
    clock: options.clock ?? FIXED_CLOCK,
    ...(options.transcriptLimits ? { transcriptLimits: options.transcriptLimits } : {}),
  });
  const world = createToolWorld(scenario);
  const snapshot = kernel.initialize({ runId, condition, scenario, world });
  return { kernel, condition, snapshot, world, sequence: 0 };
}

function grant(harness: Harness, action: string): string {
  const found = harness.snapshot.actions.find((candidate) => candidate.name === action);
  if (!found) throw new Error(`test snapshot does not expose ${action}`);
  return found.capability_grant;
}

function invoke(
  harness: Harness,
  action: string,
  args: Record<string, JsonValue>,
  options: { grant?: string; preserveSnapshot?: boolean; providerCallId?: string; turn?: number } = {}
): BenchmarkGatewayOutcome {
  harness.sequence += 1;
  const providerCallId = options.providerCallId ?? `provider-call-${harness.sequence}`;
  let acceptedWorld: ToolWorldState | null = null;
  const outcome = harness.kernel.invoke({
    providerCallId,
    call: {
      action,
      arguments: args,
      capability_grant: options.grant ?? grant(harness, action),
    },
    capabilityEpoch: harness.snapshot.capability_epoch,
    condition: harness.condition,
    turn: options.turn ?? harness.sequence,
    world: structuredClone(harness.world),
    executeLeaf: (request) => {
      const execution = executeTool(scenario, harness.world, {
        invocation_id: `world-invocation-${harness.sequence}`,
        tool: request.action,
        // Provider arguments cross a serialization boundary before ToolWorld
        // persists them. Keep the fixture JSON-tree shaped (no shared object
        // identity with the gateway-owned invocation).
        arguments: structuredClone(request.arguments),
        // `sequence` gives calls unique identities; several tool calls may
        // legitimately occur in one realtime conversation turn.
        turn: Math.min(harness.sequence, scenario.max_turns),
        ...(request.idempotencyKey ? { idempotency_key: request.idempotencyKey } : {}),
      });
      acceptedWorld = execution.state;
      return execution;
    },
  });
  if (acceptedWorld) harness.world = acceptedWorld;
  if (outcome.capabilitySnapshot && !options.preserveSnapshot) {
    harness.snapshot = outcome.capabilitySnapshot;
  }
  return outcome;
}

function expectOk(outcome: BenchmarkGatewayOutcome): Extract<BenchmarkGatewayOutcome["result"], { ok: true }> {
  if (!outcome.result.ok) throw new Error(`${outcome.result.code}: ${outcome.result.message}`);
  expect(outcome.result.ok).toBe(true);
  return outcome.result;
}

function selectAndEnterFirstStep(harness: Harness): void {
  expectOk(invoke(harness, "flow.select_topic", { topic_id: "field_service" }));
  expectOk(invoke(harness, "flow.enter_step", { path: "field_service.locate_work_order" }));
}

function completeAndEnter(harness: Harness, current: string, next: string): void {
  const completed = invoke(harness, "flow.complete_step", { path: current, outputs: {} });
  expectOk(completed);
  if (harness.condition.behavior.progressiveDisclosure) {
    expect(completed.disclosure).toBeUndefined();
    expect(harness.snapshot.actions.map((action) => action.name).sort()).toEqual([
      "flow.enter_step",
      "flow.get_state",
    ]);
  }
  expectOk(invoke(harness, "flow.enter_step", { path: next }));
}

describe("benchmark gateway kernel", () => {
  it("derives host-owned linear transitions from the attested condition", () => {
    const harness = createHarness("host-managed-harness", "run-auto-linear");
    expect(harness.snapshot.actions.map((action) => action.name).sort()).toEqual([
      "flow.get_state",
      "flow.select_topic",
    ]);
    const turnPlan = harness.kernel.advanceCallerTurn({
      runId: "run-auto-linear",
      condition: harness.condition,
      scenario,
      turn: 1,
      turnId: scenario.caller.turns[0].id,
      world: harness.world,
    });
    harness.snapshot = turnPlan.capabilitySnapshot;
    expect(turnPlan.responsePlan).toMatchObject({
      revision: 1,
      response_mode: "route",
      eligible_actions: ["flow.get_state", "flow.select_topic"],
    });
    const selected = invoke(harness, "flow.select_topic", { topic_id: "field_service" }, { turn: 1 });
    expectOk(selected);
    expect(selected.disclosure?.target).toBe("step:field_service.locate_work_order");
    expect(harness.snapshot.actions.map((action) => action.name)).toContain("lookup_work_order");
    expect(harness.snapshot.actions.map((action) => action.name)).not.toContain("flow.enter_step");
    expect(harness.snapshot.actions.map((action) => action.name)).not.toContain("flow.complete_step");

    const lookupGrant = grant(harness, "lookup_work_order");
    const lookup = invoke(harness, "lookup_work_order", { work_order_id: "WO-2048" }, {
      providerCallId: "host-managed-stable-lookup",
      grant: lookupGrant,
      turn: 1,
    });
    expectOk(lookup);
    expect(lookup.providerVisibleOutput).toMatchObject({
      gateway_result: { ok: true, action: "lookup_work_order" },
      hacc_speech_guardrail_packet: {
        packet_type: "hacc_state_conditioned_speech_guardrail",
      },
      hacc_response_plan: {
        revision: 1,
        plan_sha256: turnPlan.responsePlan.plan_sha256,
      },
    });
    expect(lookup.disclosure?.target).toBe("step:field_service.verify_technician");
    expect(harness.snapshot.actions.map((action) => action.name)).toContain("verify_technician");
    expect(harness.snapshot.actions.map((action) => action.name)).not.toContain("flow.enter_step");
    expect(harness.snapshot.actions.map((action) => action.name)).not.toContain("flow.complete_step");
    const verified = invoke(harness, "verify_technician", { employee_id: "E-731", pin: "4826" }, { turn: 1 });
    expectOk(verified);
    expect(verified.providerVisibleOutput).toMatchObject({
      hacc_speech_guardrail_packet: {
        revision: 1,
        privacy_directive: "never_repeat_verification_secrets",
      },
    });
    const replay = invoke(harness, "lookup_work_order", { work_order_id: "WO-2048" }, {
      providerCallId: "host-managed-stable-lookup",
      grant: lookupGrant,
      turn: 1,
    });
    expect(replay.result).toMatchObject({ ok: true, disposition: "replayed" });
    expect(replay.providerVisibleOutput).toEqual(lookup.providerVisibleOutput);
    const staleCompletion = invoke(harness, "flow.complete_step", {
      path: "field_service.locate_work_order",
      outputs: {},
    }, { grant: "g1.invalid", turn: 1 });
    expect(staleCompletion.result).toMatchObject({ ok: false, code: "invalid_capability" });
    expect(harness.snapshot.actions.map((action) => action.name)).toContain("record_diagnostic");
    const attestation = harness.kernel.attestFinal({
      runId: "run-auto-linear",
      condition: harness.condition,
      scenario,
      world: harness.world,
    });
    const publicInvocations = harness.kernel.transcript().entries
      .filter((entry) => entry.operation === "invoke")
      .map(publicInvokePayload);
    expect(publicInvocations.every((entry) =>
      /^[a-f0-9]{64}$/.test(entry.outcome.provider_visible_output_hmac_sha256)
    )).toBe(true);
    const replayVerification = verifyKernelTranscript({
      transcript: harness.kernel.encodedTranscript(),
      finalAttestation: attestation,
      attestationExpectation: {
        runId: "run-auto-linear",
        condition: harness.condition,
        scenario,
        world: harness.world,
        transcriptReference: harness.kernel.transcriptReference(),
        evidenceBinding: TEST_EVIDENCE_BINDING,
        trust: TEST_TRUST,
      },
    });
    expect(replayVerification.errors).toEqual([]);
    expect(replayVerification).toMatchObject({ valid: true, authenticity: "signed_attestation_verified" });
  });

  it("journals the first receipt in a real two-action long-call step before host auto-advance", () => {
    const task = longUsefulnessTask("museum");
    const longScenario = task.scenario;
    const longFlow = AgentFlowSchema.parse(task.compiler_input.flow);
    const longSuite = compileConditionSuite(task.compiler_input);
    const condition = longSuite.conditions["host-managed-harness"];
    const runId = "run-long-two-action-checkpoint";
    const kernel = createInMemoryBenchmarkGatewayKernel({
      flow: longFlow,
      expectedFlowHash: longSuite.flowHash,
      expectedScenarioHash: longSuite.scenarioHash,
      expectedConditionHash: condition.conditionHash,
      grantBindingHash: longSuite.sourceHash,
      leaseSubjectId: "pair-industrial-test",
      ...TEST_ATTESTATION_OPTIONS,
      capabilitySecret: "benchmark-test-secret-that-is-at-least-thirty-two-characters",
      clock: FIXED_CLOCK,
    });
    let world = createToolWorld(longScenario);
    let visible = kernel.initialize({ runId, condition, scenario: longScenario, world });
    let sequence = 0;
    const invokeLong = (
      action: string,
      args: Record<string, JsonValue>,
      turn: number,
      capabilityGrant?: string
    ) => {
      const capability = visible.actions.find((candidate) => candidate.name === action);
      if (!capability && !capabilityGrant) throw new Error(`long-call snapshot does not expose ${action}`);
      let acceptedWorld: ToolWorldState | null = null;
      const outcome = kernel.invoke({
        providerCallId: `long-provider-call-${++sequence}`,
        call: { action, arguments: args, capability_grant: capabilityGrant ?? capability!.capability_grant },
        capabilityEpoch: visible.capability_epoch,
        condition,
        turn,
        world: structuredClone(world),
        executeLeaf: (request) => {
          const execution = executeTool(longScenario, world, {
            invocation_id: `long-world-invocation-${sequence}`,
            tool: request.action,
            arguments: structuredClone(request.arguments),
            turn,
            ...(request.idempotencyKey ? { idempotency_key: request.idempotencyKey } : {}),
          });
          acceptedWorld = execution.state;
          return execution;
        },
      });
      if (acceptedWorld) world = acceptedWorld;
      if (outcome.capabilitySnapshot) visible = outcome.capabilitySnapshot;
      return outcome;
    };
    let committedTurn = 0;
    const advanceToTurn = (target: number) => {
      while (committedTurn < target) {
        committedTurn += 1;
        const update = kernel.advanceCallerTurn({
          runId,
          condition,
          scenario: longScenario,
          turn: committedTurn,
          turnId: longScenario.caller.turns[committedTurn - 1].id,
          world,
        });
        if (update.capabilitySnapshot) visible = update.capabilitySnapshot;
        expectOk(invokeLong("flow.get_state", {}, committedTurn));
      }
    };
    const verifyCurrentHead = () => {
      const attestation = kernel.attestFinal({ runId, condition, scenario: longScenario, world });
      expect(verifyKernelTranscript({
        transcript: kernel.encodedTranscript(),
        finalAttestation: attestation,
        attestationExpectation: {
          runId,
          condition,
          scenario: longScenario,
          world,
          transcriptReference: kernel.transcriptReference(),
          evidenceBinding: TEST_EVIDENCE_BINDING,
          trust: TEST_TRUST,
        },
      })).toMatchObject({ valid: true, authenticity: "signed_attestation_verified", errors: [] });
    };

    advanceToTurn(1);
    expectOk(invokeLong("flow.select_topic", { topic_id: "museum_case" }, 1));
    expectOk(invokeLong("lookup_loan_case", { case_id: "MLR-2048" }, 1));
    advanceToTurn(2);
    expectOk(invokeLong("verify_museum_registrar", {
      case_id: "MLR-2048",
      actor_id: "REG-44",
      verification_pin: "7316",
    }, 2));

    advanceToTurn(4);
    const beforeCorrectionEntries = kernel.transcriptReference().transcript_entry_count;
    const correction = invokeLong("record_corrected_crate", {
      case_id: "MLR-2048",
      subject: "CRATE-A71",
    }, 4);
    expectOk(correction);
    expect(correction.disclosure).toBeUndefined();
    expect(visible.actions.map((action) => action.name)).toContain("record_corrected_crate");
    expect(visible.actions.map((action) => action.name)).not.toContain("record_conservation_limits");
    expect(kernel.transcriptReference().transcript_entry_count).toBe(beforeCorrectionEntries + 1);
    verifyCurrentHead();

    advanceToTurn(9);
    const priorTurnGrant = visible.actions.find(
      (action) => action.name === "record_conservation_limits"
    )?.capability_grant;
    expect(priorTurnGrant).toBeTruthy();
    const guardrails = invokeLong("record_conservation_limits", {
      case_id: "MLR-2048",
      primary_constraint: "climate_stable_chain_of_custody",
      numeric_limit: 52,
    }, 9);
    expectOk(guardrails);
    expect(guardrails.disclosure?.target).toBe("step:museum_case.recover_reversible_action_and_clearance");
    expect(visible.actions.map((action) => action.name)).not.toContain("hold_bonded_courier");
    advanceToTurn(10);
    expect(visible.actions.map((action) => action.name)).toContain("hold_bonded_courier");
    const stalePriorTurnCall = invokeLong("record_conservation_limits", {
      case_id: "MLR-2048",
      primary_constraint: "climate_stable_chain_of_custody",
      numeric_limit: 52,
    }, 10, priorTurnGrant);
    expect(stalePriorTurnCall.result).toMatchObject({ ok: false, code: "capability_scope_mismatch" });
    verifyCurrentHead();
  });

  it("rolls back every kernel head when host auto-advance throws after leaf execution", () => {
    let armed = false;
    let armedCalls = 0;
    const clock = {
      nowMs: FIXED_CLOCK.nowMs,
      nowIso: () => {
        if (armed && ++armedCalls === 4) throw new Error("injected post-leaf transition failure");
        return FIXED_CLOCK.nowIso();
      },
    };
    const harness = createHarness("host-managed-harness", "run-host-transaction-rollback", { clock });
    expectOk(invoke(harness, "flow.select_topic", { topic_id: "field_service" }));
    const beforeWorld = structuredClone(harness.world);
    const beforeTranscript = harness.kernel.encodedTranscript();
    const beforeReference = harness.kernel.transcriptReference();
    const providerCallId = "provider-rollback-leaf";

    armed = true;
    expect(() => invoke(harness, "lookup_work_order", { work_order_id: "WO-2048" }, {
      providerCallId,
    })).toThrow("injected post-leaf transition failure");
    armed = false;

    expect(harness.world).toEqual(beforeWorld);
    expect(harness.kernel.encodedTranscript()).toBe(beforeTranscript);
    expect(harness.kernel.transcriptReference()).toEqual(beforeReference);
    expect(() => harness.kernel.attestFinal({
      runId: "run-host-transaction-rollback",
      condition: harness.condition,
      scenario,
      world: beforeWorld,
    })).not.toThrow();

    const retried = invoke(harness, "lookup_work_order", { work_order_id: "WO-2048" }, {
      providerCallId,
    });
    expect(retried.result).toMatchObject({ ok: true, disposition: "executed" });
    expect(retried.disclosure?.target).toBe("step:field_service.verify_technician");
  });

  it("does not let a runtime option override model-authored transition ownership", () => {
    const condition = suite.conditions["full-harness"];
    const kernel = createInMemoryBenchmarkGatewayKernel({
      flow: INDUSTRIAL_FIELD_SERVICE_FLOW,
      expectedFlowHash: suite.flowHash,
      expectedScenarioHash: suite.scenarioHash,
      expectedConditionHash: condition.conditionHash,
      grantBindingHash: suite.sourceHash,
      leaseSubjectId: "pair-industrial-test",
      ...TEST_ATTESTATION_OPTIONS,
      capabilitySecret: "benchmark-test-secret-that-is-at-least-thirty-two-characters",
      clock: FIXED_CLOCK,
      autoAdvanceLinearFlow: true,
    });
    const world = createToolWorld(scenario);
    let snapshot = kernel.initialize({ runId: "run-option-cannot-override", condition, scenario, world });
    const providerCall = (action: string, args: Record<string, JsonValue>) => {
      const capability = snapshot.actions.find((candidate) => candidate.name === action);
      if (!capability) throw new Error(`missing ${action}`);
      const outcome = kernel.invoke({
        providerCallId: `override-${action}`,
        call: { action, arguments: args, capability_grant: capability.capability_grant },
        capabilityEpoch: snapshot.capability_epoch,
        condition,
        turn: 1,
        world,
        executeLeaf: () => { throw new Error("leaf execution is not expected"); },
      });
      if (outcome.capabilitySnapshot) snapshot = outcome.capabilitySnapshot;
      return outcome;
    };
    expectOk(providerCall("flow.select_topic", { topic_id: "field_service" }));
    expect(snapshot.actions.map((action) => action.name)).toContain("flow.enter_step");
    expect(snapshot.actions.map((action) => action.name)).not.toContain("lookup_work_order");
  });

  it("does not add HACC speech guardrails to the native raw arm", () => {
    const raw = createHarness("raw-memory", "run-raw-no-speech-packet");
    const lookup = invoke(raw, "lookup_work_order", { work_order_id: "WO-2048" });
    expectOk(lookup);
    expect(lookup.providerVisibleOutput).toBeUndefined();
    expect(raw.kernel.encodedTranscript()).not.toContain("hacc_speech_guardrail_packet");
  });

  it("cedes only a genuine branch choice to the model, then resumes host ownership", () => {
    const flow = structuredClone(INDUSTRIAL_FIELD_SERVICE_FLOW);
    const topic = flow.nodes.find((node) => node.id === "field_service");
    const locate = topic?.steps?.find((step) => step.id === "locate_work_order");
    if (!locate) throw new Error("test flow is missing locate_work_order");
    locate.transitions = [
      { to: "field_service.verify_technician", label: "Verify first" },
      { to: "field_service.collect_safety_and_diagnosis", label: "Collect evidence first" },
    ];
    const branchedSuite = compileConditionSuite({
      ...industrialFieldServiceCompilerInput(scenario),
      flow,
    });
    const condition = branchedSuite.conditions["host-managed-harness"];
    const kernel = createInMemoryBenchmarkGatewayKernel({
      flow,
      expectedFlowHash: branchedSuite.flowHash,
      expectedScenarioHash: branchedSuite.scenarioHash,
      expectedConditionHash: condition.conditionHash,
      grantBindingHash: branchedSuite.sourceHash,
      leaseSubjectId: "pair-industrial-test",
      ...TEST_ATTESTATION_OPTIONS,
      capabilitySecret: "benchmark-test-secret-that-is-at-least-thirty-two-characters",
      clock: FIXED_CLOCK,
    });
    const world = createToolWorld(scenario);
    const snapshot = kernel.initialize({
      runId: "run-host-managed-branch",
      condition,
      scenario,
      world,
    });
    const harness: Harness = { kernel, condition, world, snapshot, sequence: 0 };

    expectOk(invoke(harness, "flow.select_topic", { topic_id: "field_service" }));
    const lookup = invoke(harness, "lookup_work_order", { work_order_id: "WO-2048" });
    expectOk(lookup);
    expect(lookup.disclosure?.target).toBe("topic:field_service");
    expect(harness.snapshot.actions.map((action) => action.name).sort()).toEqual([
      "flow.enter_step",
      "flow.get_state",
    ]);

    const entered = invoke(harness, "flow.enter_step", { path: "field_service.verify_technician" });
    expectOk(entered);
    expect(entered.disclosure?.target).toBe("step:field_service.verify_technician");
    expect(harness.snapshot.actions.map((action) => action.name)).toContain("verify_technician");
    expect(harness.snapshot.actions.map((action) => action.name)).not.toContain("flow.enter_step");
    expect(harness.snapshot.actions.map((action) => action.name)).not.toContain("flow.complete_step");
  });

  it("keeps progressive-only and full-harness grants, scopes, and rotations treatment-blind", () => {
    const progressive = createHarness("progressive-only");
    const harness = createHarness("full-harness");

    expect(progressive.snapshot).toEqual(harness.snapshot);
    for (const action of harness.snapshot.actions) {
      expect(action.capability_grant).toMatch(/^g1\.[A-Za-z0-9_-]{43}$/);
      expect(action.capability_grant.split(".")[0]).toBe("g1");
    }

    expectOk(invoke(progressive, "flow.select_topic", { topic_id: "field_service" }));
    expectOk(invoke(harness, "flow.select_topic", { topic_id: "field_service" }));
    expect(progressive.snapshot).toEqual(harness.snapshot);

    expectOk(invoke(progressive, "flow.enter_step", { path: "field_service.locate_work_order" }));
    expectOk(invoke(harness, "flow.enter_step", { path: "field_service.locate_work_order" }));
    expect(progressive.snapshot).toEqual(harness.snapshot);

    expectOk(invoke(progressive, "lookup_work_order", { work_order_id: "WO-2048" }));
    expectOk(invoke(harness, "lookup_work_order", { work_order_id: "WO-2048" }));
    expectOk(invoke(progressive, "flow.complete_step", {
      path: "field_service.locate_work_order",
      outputs: {},
    }));
    expectOk(invoke(harness, "flow.complete_step", {
      path: "field_service.locate_work_order",
      outputs: {},
    }));
    expect(progressive.snapshot).toEqual(harness.snapshot);
  });

  it("deduplicates exact provider calls and transcripts every replay or identity rejection", () => {
    const raw = createHarness("raw-full");
    const first = invoke(raw, "lookup_work_order", { work_order_id: "WO-2048" }, {
      providerCallId: "provider-stable-call",
    });
    expect(first.result).toMatchObject({ ok: true, disposition: "executed" });
    const exactReplay = invoke(raw, "lookup_work_order", { work_order_id: "WO-2048" }, {
      providerCallId: "provider-stable-call",
    });
    expect(exactReplay.result).toMatchObject({ ok: true, disposition: "replayed" });
    expect(raw.world.receipts.filter((receipt) => receipt.tool === "lookup_work_order")).toHaveLength(1);

    const hostAuthorityVariationReplay = invoke(raw, "lookup_work_order", { work_order_id: "WO-2048" }, {
      providerCallId: "provider-stable-call",
      grant: "different-host-only-grant",
    });
    expect(hostAuthorityVariationReplay.result).toMatchObject({ ok: true, disposition: "replayed" });

    const conflict = invoke(raw, "lookup_work_order", { work_order_id: "WO-DIFFERENT" }, {
      providerCallId: "provider-stable-call",
    });
    expect(conflict.result).toMatchObject({ ok: false, code: "provider_call_id_conflict" });
    expect(raw.world.receipts.filter((receipt) => receipt.tool === "lookup_work_order")).toHaveLength(1);

    const entries = raw.kernel.transcript().entries;
    expect(entries).toHaveLength(5);
    expect(entries.map((entry) => entry.operation)).toEqual([
      "initialize",
      "invoke",
      "invoke",
      "invoke",
      "invoke",
    ]);
    const replayEntry = entries[2];
    const hostAuthorityVariationEntry = entries[3];
    const conflictEntry = entries[4];
    if (
      replayEntry.operation !== "invoke"
      || hostAuthorityVariationEntry.operation !== "invoke"
      || conflictEntry.operation !== "invoke"
    ) {
      throw new Error("expected replay and rejection transcript entries");
    }
    const executedPayload = publicInvokePayload(entries[1]);
    const replayPayload = publicInvokePayload(replayEntry);
    const hostAuthorityVariationPayload = publicInvokePayload(hostAuthorityVariationEntry);
    const conflictPayload = publicInvokePayload(conflictEntry);
    expect(executedPayload.outcome.result_class).toBe("success_executed");
    expect(replayPayload.outcome.result_class).toBe("success_replayed");
    expect(hostAuthorityVariationPayload.outcome.result_class).toBe("success_replayed");
    expect(conflictPayload.outcome.result_class).toBe("provider_call_id_conflict");
    expect(replayPayload.input.provider_call_fingerprint_hmac_sha256).toBe(
      executedPayload.input.provider_call_fingerprint_hmac_sha256
    );
    expect(hostAuthorityVariationPayload.input.provider_call_fingerprint_hmac_sha256).toBe(
      executedPayload.input.provider_call_fingerprint_hmac_sha256
    );
    expect(conflictPayload.input.provider_call_fingerprint_hmac_sha256).not.toBe(
      executedPayload.input.provider_call_fingerprint_hmac_sha256
    );
    expect(hostAuthorityVariationPayload.public_world_delta.receipts_append).toEqual([]);
    expect(conflictPayload.public_world_delta.receipts_append).toEqual([]);
    const encodedTranscript = raw.kernel.encodedTranscript();
    expect(encodedTranscript).not.toContain("different-host-only-grant");
    expect(encodedTranscript).not.toContain('"capability_grant":"g1.');
    expect(verifyKernelTranscript({ transcript: encodedTranscript })).toMatchObject({
      valid: true,
      authenticity: "unsigned_public_commitment",
      errors: [],
    });
  });

  it("derives a run-scoped transcript HMAC key without exposing sensitive preimages", () => {
    const first = createHarness("raw-full", "run-transcript-secret-a");
    const second = createHarness("raw-full", "run-transcript-secret-b");
    const memory = createHarness("raw-memory", "run-transcript-memory-secret");
    invoke(first, "verify_technician", { employee_id: "E-731", pin: "4826" });
    invoke(second, "verify_technician", { employee_id: "E-731", pin: "4826" });
    invoke(memory, "durable_memory", {
      operation: "write",
      key: "api_key",
      value: "sk-live-low-entropy-secret",
    });

    const committedArguments = (harness: Harness) => {
      const entry = harness.kernel.transcript().entries.at(-1);
      if (entry?.operation !== "invoke") throw new Error("expected sensitive invocation transcript");
      return publicInvokePayload(entry).input.arguments_hmac_sha256;
    };
    expect(committedArguments(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(committedArguments(second)).toMatch(/^[a-f0-9]{64}$/);
    expect(committedArguments(second)).not.toBe(committedArguments(first));
    for (const harness of [first, second]) {
      const encoded = harness.kernel.encodedTranscript();
      expect(encoded).not.toContain('"pin":"4826"');
      expect(encoded).not.toContain('"verification_pin":"4826"');
      expect(encoded).not.toContain("VRF-WO2048-E731");
      expect(encoded).not.toContain("benchmark-test-secret-that-is-at-least-thirty-two-characters");
      expect(encoded).not.toContain('"capability_grant":"g1.');
    }
    expect(memory.kernel.encodedTranscript()).not.toContain("sk-live-low-entropy-secret");
  });

  it("signs the exact durable-memory head and refuses an unrecorded provider-call substitution", () => {
    const memory = createHarness("raw-memory", "run-signed-durable-memory");
    const original = invoke(memory, "durable_memory", {
      operation: "write",
      key: "caller_preference",
      value: { language: "en-US", callback_window: "morning" },
    }, { providerCallId: "provider-memory-write" });
    expectOk(original);

    const substitution = invoke(memory, "durable_memory", {
      operation: "write",
      key: "caller_preference",
      value: { language: "fr-FR", callback_window: "evening" },
    }, { providerCallId: "provider-memory-write" });
    expect(substitution.result).toMatchObject({
      ok: false,
      code: "provider_call_id_conflict",
    });

    const read = expectOk(invoke(memory, "durable_memory", {
      operation: "read",
      key: "caller_preference",
    }, { providerCallId: "provider-memory-read" }));
    expect(read.authoritative_result).toEqual({
      operation: "read",
      key: "caller_preference",
      found: true,
      value: { language: "en-US", callback_window: "morning" },
    });

    const publicEntries = memory.kernel.transcript().entries.slice(1);
    const payloads = publicEntries.map(publicInvokePayload);
    expect(payloads.map((payload) => payload.outcome.result_class)).toEqual([
      "success_executed",
      "provider_call_id_conflict",
      "success_executed",
    ]);
    expect(payloads.map((payload) => payload.public_durable_memory_delta.operation)).toEqual([
      "set",
      "none",
      "none",
    ]);
    expect(payloads.at(-1)?.post_state.durable_memory_head).toMatchObject({
      applicability: "durable_memory_enabled",
      revision: 1,
      entry_count: 1,
    });

    const transcriptReference = memory.kernel.transcriptReference();
    const attestation = memory.kernel.attestFinal({
      runId: "run-signed-durable-memory",
      condition: memory.condition,
      scenario,
      world: memory.world,
    });
    const verification = verifyKernelTranscript({
      transcript: memory.kernel.encodedTranscript(),
      finalAttestation: attestation,
      attestationExpectation: {
        runId: "run-signed-durable-memory",
        condition: memory.condition,
        scenario,
        world: memory.world,
        evidenceBinding: TEST_EVIDENCE_BINDING,
        trust: TEST_TRUST,
        transcriptReference,
      },
    });
    expect(verification).toMatchObject({
      valid: true,
      authenticity: "signed_attestation_verified",
      errors: [],
      reconstructed: {
        durable_memory_head: {
          applicability: "durable_memory_enabled",
          revision: 1,
          entry_count: 1,
        },
      },
    });
    expect(verification.reconstructed.final_public_durable_memory).toHaveLength(1);
    const encoded = memory.kernel.encodedTranscript();
    for (const secret of [
      "caller_preference",
      "en-US",
      "morning",
      "fr-FR",
      "evening",
    ]) expect(encoded).not.toContain(secret);
  });

  it("rolls back memory, provider-call identity, and transcript when a live append bound rejects", () => {
    const memory = createHarness("raw-memory", "run-memory-append-atomicity", {
      transcriptLimits: {
        ...DEFAULT_KERNEL_TRANSCRIPT_LIMITS,
        maxStringBytes: 64,
      },
    });
    const initialEncoded = memory.kernel.encodedTranscript();
    const initialReference = memory.kernel.transcriptReference();
    const providerCallId = "provider-memory-atomic-write";

    expect(() => invoke(memory, "durable_memory", {
      operation: "write",
      key: "atomic_key",
      value: "x".repeat(65),
    }, { providerCallId })).toThrow(/oversized string/);

    // Public evidence and final-state checks remain exactly at initialization;
    // the rejected append did not leave a hidden memory mutation behind.
    expect(memory.kernel.encodedTranscript()).toBe(initialEncoded);
    expect(memory.kernel.transcriptReference()).toEqual(initialReference);
    expect(() => memory.kernel.attestFinal({
      runId: "run-memory-append-atomicity",
      condition: memory.condition,
      scenario,
      world: memory.world,
    })).not.toThrow();

    // Reusing the provider call ID with different, bounded content succeeds.
    // A replay entry accidentally published before the failed append would
    // instead turn this into provider_call_id_conflict.
    expectOk(invoke(memory, "durable_memory", {
      operation: "write",
      key: "atomic_key",
      value: "kept",
    }, { providerCallId }));
    const read = expectOk(invoke(memory, "durable_memory", {
      operation: "read",
      key: "atomic_key",
    }, { providerCallId: "provider-memory-atomic-read" }));
    expect(read.authoritative_result).toEqual({
      operation: "read",
      key: "atomic_key",
      found: true,
      value: "kept",
    });
    expect(memory.kernel.transcriptReference().transcript_entry_count).toBe(3);
    const last = memory.kernel.transcript().entries.at(-1);
    if (!last) throw new Error("expected durable-memory read transcript entry");
    expect(publicInvokePayload(last).post_state.durable_memory_head).toMatchObject({
      applicability: "durable_memory_enabled",
      revision: 1,
      entry_count: 1,
    });
  });

  it("pins initialization identity and rejects condition, flow, world, or argument tampering", () => {
    const harness = createHarness("full-harness");
    expect(() => harness.kernel.initialize({
      runId: "run-full-harness",
      condition: harness.condition,
      scenario,
      world: harness.world,
    })).toThrow(/single-use/);

    const tampered = structuredClone(harness.condition);
    Object.assign(tampered.behavior, { enforceExactlyOnce: false, enforceCapabilityGrants: false });
    expect(() => harness.kernel.invoke({
      providerCallId: "tampered-condition",
      call: { action: "lookup_work_order", arguments: { work_order_id: "WO-2048" }, capability_grant: "forged.token" },
      capabilityEpoch: harness.snapshot.capability_epoch,
      condition: tampered,
      turn: 1,
      world: harness.world,
      executeLeaf: () => { throw new Error("must not execute"); },
    })).toThrow(/invalid condition hash/);

    expect(invoke(harness, "flow.get_state", { unexpected: true }, {
      grant: grant(harness, "flow.get_state"),
    }).result).toMatchObject({ ok: false, code: "invalid_arguments" });

    const transcriptEntriesBeforeMalformedIdentity = harness.kernel.transcript().entries.length;
    expect(() => harness.kernel.invoke({
      providerCallId: "malformed/provider-call",
      call: { action: "flow.get_state", arguments: {}, capability_grant: grant(harness, "flow.get_state") },
      capabilityEpoch: harness.snapshot.capability_epoch,
      condition: harness.condition,
      turn: 2,
      world: harness.world,
      executeLeaf: () => { throw new Error("must not execute"); },
    })).toThrow(/providerCallId/);
    expect(harness.kernel.transcript().entries).toHaveLength(transcriptEntriesBeforeMalformedIdentity);

    expect(() => createInMemoryBenchmarkGatewayKernel({
      flow: INDUSTRIAL_FIELD_SERVICE_FLOW,
      expectedFlowHash: "0".repeat(64),
      expectedScenarioHash: suite.scenarioHash,
      expectedConditionHash: harness.condition.conditionHash,
      grantBindingHash: suite.sourceHash,
      leaseSubjectId: "pair-industrial-test",
      ...TEST_ATTESTATION_OPTIONS,
      capabilitySecret: "benchmark-test-secret-that-is-at-least-thirty-two-characters",
      clock: FIXED_CLOCK,
    })).toThrow(/flow hash/);

    const forgedWorld = structuredClone(createToolWorld(scenario));
    forgedWorld.facts.injected_unlogged_state = "accepted";
    const fresh = createInMemoryBenchmarkGatewayKernel({
      flow: INDUSTRIAL_FIELD_SERVICE_FLOW,
      expectedFlowHash: suite.flowHash,
      expectedScenarioHash: suite.scenarioHash,
      expectedConditionHash: harness.condition.conditionHash,
      grantBindingHash: suite.sourceHash,
      leaseSubjectId: "pair-industrial-test",
      ...TEST_ATTESTATION_OPTIONS,
      capabilitySecret: "benchmark-test-secret-that-is-at-least-thirty-two-characters",
      clock: FIXED_CLOCK,
    });
    expect(() => fresh.initialize({
      runId: "forged-world",
      condition: harness.condition,
      scenario,
      world: forgedWorld,
    })).toThrow(/facts do not match|canonical empty/);

    const alteredScenario = BenchmarkScenarioSchema.parse({
      ...structuredClone(scenario),
      title: `${scenario.title} altered`,
    });
    const crossBound = createInMemoryBenchmarkGatewayKernel({
      flow: INDUSTRIAL_FIELD_SERVICE_FLOW,
      expectedFlowHash: suite.flowHash,
      expectedScenarioHash: compileConditionSuite(industrialFieldServiceCompilerInput(alteredScenario)).scenarioHash,
      expectedConditionHash: harness.condition.conditionHash,
      grantBindingHash: suite.sourceHash,
      leaseSubjectId: "pair-industrial-test",
      ...TEST_ATTESTATION_OPTIONS,
      capabilitySecret: "benchmark-test-secret-that-is-at-least-thirty-two-characters",
      clock: FIXED_CLOCK,
    });
    expect(() => crossBound.initialize({
      runId: "cross-bound",
      condition: harness.condition,
      scenario: alteredScenario,
      world: createToolWorld(alteredScenario),
    })).toThrow(/not bound/);
  });

  it("keeps raw grants static and omits flow enforcement while retaining one native gateway", () => {
    const raw = createHarness("raw-full");
    expect(raw.condition.providerTools.map((tool) => tool.name)).toEqual(["capability_gateway"]);
    expect(new Set(raw.snapshot.actions.map((action) => action.capability_grant)).size).toBe(raw.snapshot.actions.length);
    expect(raw.snapshot.actions.map((action) => action.name).sort()).toEqual(
      suite.semanticLeafTools.map((tool) => tool.name).sort()
    );

    const lookup = invoke(raw, "lookup_work_order", { work_order_id: "WO-2048" }, {
      grant: "forged.but.schema-valid",
    });
    expect(expectOk(lookup).authoritative_result).toMatchObject({ work_order_id: "WO-2048" });
    expect(invoke(raw, "flow.get_state", {}, { grant: "forged.but.schema-valid" }).result).toMatchObject({
      ok: false,
      code: "unknown_action",
    });
  });

  it("isolates progressive disclosure from transition and capability enforcement", () => {
    const progressive = createHarness("progressive-only");
    expectOk(invoke(progressive, "flow.select_topic", { topic_id: "field_service" }, {
      grant: "forged.but.schema-valid",
    }));
    const shortcut = invoke(progressive, "flow.enter_step", { path: "field_service.notify_dispatch" }, {
      grant: "forged.but.schema-valid",
    });
    expect(shortcut.result.ok).toBe(true);
    expect(shortcut.disclosure?.target).toBe("step:field_service.notify_dispatch");

    const harness = createHarness("full-harness");
    expectOk(invoke(harness, "flow.select_topic", { topic_id: "field_service" }));
    const unreachable = invoke(harness, "flow.enter_step", { path: "field_service.notify_dispatch" });
    expect(unreachable.result).toMatchObject({ ok: false, code: "step_not_reachable" });
    const forged = invoke(harness, "flow.enter_step", { path: "field_service.locate_work_order" }, {
      grant: "forged.but.schema-valid",
    });
    expect(forged.result).toMatchObject({ ok: false, code: "invalid_capability" });
  });

  it("runs the seven-checkpoint proof path, retries only pre-commit failure, and reconciles timeout-after-commit without redispatch", () => {
    const harness = createHarness("full-harness");
    selectAndEnterFirstStep(harness);

    const lookupGrant = grant(harness, "lookup_work_order");
    expectOk(invoke(harness, "lookup_work_order", { work_order_id: "WO-2048" }));
    completeAndEnter(harness, "field_service.locate_work_order", "field_service.verify_technician");

    const stale = invoke(harness, "lookup_work_order", { work_order_id: "WO-2048" }, { grant: lookupGrant });
    expect(stale.result).toMatchObject({ ok: false, code: "capability_scope_mismatch" });
    expectOk(invoke(harness, "verify_technician", { employee_id: "E-731", pin: "4826" }));
    completeAndEnter(
      harness,
      "field_service.verify_technician",
      "field_service.collect_safety_and_diagnosis"
    );

    expectOk(invoke(harness, "record_diagnostic", {
      work_order_id: "WO-2048",
      valve_id: "V-9B",
      pressure_psi: 212,
      diagnostic_code: "OVERPRESSURE_VALVE",
    }));
    expectOk(invoke(harness, "confirm_lockout", { work_order_id: "WO-2048", lockout_tag: "LOT-884" }));
    expectOk(invoke(harness, "confirm_zero_energy", {
      work_order_id: "WO-2048",
      measured_voltage: 0,
      residual_pressure_psi: 0,
    }));
    completeAndEnter(
      harness,
      "field_service.collect_safety_and_diagnosis",
      "field_service.obtain_approval"
    );

    const busy = invoke(harness, "request_supervisor_approval", {
      work_order_id: "WO-2048",
      approval_id: "SUP-441",
    });
    expect(busy.result).toMatchObject({ ok: false, code: "approval_service_busy", retriable: true });
    expectOk(invoke(harness, "request_supervisor_approval", {
      work_order_id: "WO-2048",
      approval_id: "SUP-441",
    }));
    completeAndEnter(
      harness,
      "field_service.obtain_approval",
      "field_service.reserve_and_record_repair"
    );

    expectOk(invoke(harness, "reserve_replacement_part", {
      work_order_id: "WO-2048",
      part_number: "SEAL-HV-77",
      quantity: 1,
    }));
    expectOk(invoke(harness, "record_repair", {
      work_order_id: "WO-2048",
      repair_serial: "SR-9918",
    }));
    completeAndEnter(
      harness,
      "field_service.reserve_and_record_repair",
      "field_service.close_and_reconcile"
    );

    const close = invoke(harness, "close_work_order", { work_order_id: "WO-2048", confirmed: true });
    expect(close.result).toMatchObject({ ok: true, action: "close_work_order", disposition: "executed" });
    expect(close.providerVisibleOutput).toMatchObject({
      ok: false,
      code: "action_indeterminate",
      retriable: false,
    });

    const quarantinedState = expectOk(invoke(harness, "flow.get_state", {}))
      .authoritative_result as Record<string, unknown>;
    expect(quarantinedState).not.toHaveProperty("available_tools");
    expect(quarantinedState).not.toHaveProperty("released_outcomes");
    expect(JSON.stringify(quarantinedState)).not.toContain("CLS-WO2048-AUTH-1");
    expect(quarantinedState).toMatchObject({
      action_receipts: expect.arrayContaining([
        expect.objectContaining({
          tool: "close_work_order",
          status: "indeterminate",
          reconciliation_required: true,
          retry_authority: false,
        }),
      ]),
      provider_visible_frontier: {
        scope: "step:field_service.close_and_reconcile",
        capability_epoch: harness.snapshot.capability_epoch,
        actions: harness.snapshot.actions.map((action) => expect.objectContaining({
          name: action.name,
          semantic_hash: action.semantic_hash,
        })),
      },
    });
    expect(JSON.stringify(quarantinedState)).not.toContain("capability_grant");

    const closeReplay = invoke(harness, "close_work_order", { work_order_id: "WO-2048", confirmed: true });
    expect(closeReplay.result).toMatchObject({
      ok: false,
      code: "action_indeterminate",
      retriable: false,
    });
    expect(harness.world.facts.close_count).toBe(1);
    expectOk(invoke(harness, "get_work_order_status", { work_order_id: "WO-2048" }));
    const reconciledState = expectOk(invoke(harness, "flow.get_state", {}))
      .authoritative_result as Record<string, unknown>;
    expect(reconciledState).toMatchObject({
      action_receipts: expect.arrayContaining([
        expect.objectContaining({
          tool: "close_work_order",
          status: "succeeded",
          reconciliation_required: false,
          retry_authority: false,
        }),
      ]),
      released_outcomes: [{
        status: "succeeded",
        authoritative_result: {
          status: "closed",
          close_receipt: "CLS-WO2048-AUTH-1",
          close_count: 1,
        },
      }],
    });
    completeAndEnter(
      harness,
      "field_service.close_and_reconcile",
      "field_service.notify_dispatch"
    );

    expectOk(invoke(harness, "notify_dispatch", { work_order_id: "WO-2048" }));
    expectOk(invoke(harness, "flow.complete_step", {
      path: "field_service.notify_dispatch",
      outputs: {},
    }));

    expect(harness.world.facts).toMatchObject({
      verification_count: 1,
      diagnostic_count: 1,
      lockout_count: 1,
      zero_energy_count: 1,
      approval_count: 1,
      reservation_count: 1,
      repair_count: 1,
      close_count: 1,
      notification_count: 1,
      close_status: "closed",
      dispatch_notified: true,
    });
    expect(harness.world.receipts.filter((receipt) => receipt.tool === "close_work_order")).toHaveLength(1);

    const attestation = harness.kernel.attestFinal({
      runId: "run-full-harness",
      condition: harness.condition,
      scenario,
      world: harness.world,
    });
    expect(attestation.capability_head).toMatchObject({
      target: "topic:field_service",
      catalog_mode: "terminal",
      provider_grant_scope: "topic:field_service",
      internal_flow_scope: "$flow.completed",
      epoch: harness.snapshot.capability_epoch,
      action_count: 1,
      catalog: [{ name: "flow.get_state" }],
    });
    expect(verifyBenchmarkKernelFinalAttestation(attestation, {
      runId: "run-full-harness",
      condition: harness.condition,
      scenario,
      world: harness.world,
      evidenceBinding: TEST_EVIDENCE_BINDING,
      trust: TEST_TRUST,
      transcriptReference: harness.kernel.transcriptReference(),
    })).toMatchObject({ valid: true, signature_verified: true, errors: [] });

    const encodedTranscript = harness.kernel.encodedTranscript();
    const transcriptReference = harness.kernel.transcriptReference();
    expect(attestation.transcript_reference).toEqual(transcriptReference);
    expect(transcriptReference).toMatchObject({
      transcript_type: "benchmark_kernel_replay_public_commitment",
      encoding: "canonical-jsonl-public-commitment",
      view: "public_commitment",
    });
    expect(transcriptReference.transcript_entry_count).toBe(harness.sequence + 1);
    expect(transcriptReference.byte_length).toBe(Buffer.byteLength(encodedTranscript, "utf8"));
    expect(encodedTranscript).not.toContain('"capability_grant":"g1.');
    expect(encodedTranscript).not.toContain("benchmark-test-secret-that-is-at-least-thirty-two-characters");
    expect(Object.isFrozen(harness.kernel.transcript())).toBe(true);
    expect(Object.isFrozen(harness.kernel.transcript().entries)).toBe(true);
    const lastTranscriptEntry = harness.kernel.transcript().entries.at(-1);
    if (lastTranscriptEntry?.operation !== "invoke") throw new Error("expected terminal transcript invocation");
    expect(publicInvokePayload(lastTranscriptEntry).post_state.capability_head).toMatchObject({
      target: "topic:field_service",
      catalog_mode: "terminal",
      internal_flow_scope: "$flow.completed",
      catalog: [{ name: "flow.get_state" }],
    });
    expect(verifyKernelTranscript({
      transcript: encodedTranscript,
      finalAttestation: attestation,
      attestationExpectation: {
        runId: "run-full-harness",
        condition: harness.condition,
        scenario,
        world: harness.world,
        evidenceBinding: TEST_EVIDENCE_BINDING,
        trust: TEST_TRUST,
        transcriptReference,
      },
    })).toMatchObject({
      valid: true,
      authenticity: "signed_attestation_verified",
      errors: [],
      reference: transcriptReference,
      reconstructed: {
        final_world: null,
        authoritative_world_head: attestation.world_head,
        capability_head: attestation.capability_head,
        flow_state_sha256: attestation.flow_proof.execution_state_sha256,
      },
    });
  }, 30_000);

  it("signs a read-only final proof bound to the exact last provider catalog, world, and run identity", () => {
    const harness = createHarness("full-harness");
    selectAndEnterFirstStep(harness);
    const providerCallId = "provider-native-call:lookup-work-order";
    expectOk(invoke(harness, "lookup_work_order", { work_order_id: "WO-2048" }, { providerCallId }));

    const first = harness.kernel.attestFinal({
      runId: "run-full-harness",
      condition: harness.condition,
      scenario,
      world: harness.world,
    });
    expect(first.bindings).toMatchObject({
      run_id: "run-full-harness",
      pair_id: TEST_EVIDENCE_BINDING.pairId,
      lease_subject_id: TEST_EVIDENCE_BINDING.leaseSubjectId,
      provider: TEST_EVIDENCE_BINDING.provider,
      model: TEST_EVIDENCE_BINDING.model,
      signing_key_id: TEST_SIGNER.keyId,
      signing_public_key_sha256: TEST_SIGNER.publicKeySha256,
    });
    expect(first.signature).toMatchObject({
      algorithm: "ed25519",
      key_id: TEST_SIGNER.keyId,
    });
    expect(first.signature.signature_base64).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(first.capability_head.catalog).toEqual(harness.snapshot.actions.map((action) => ({
      name: action.name,
      semantic_hash: action.semantic_hash,
    })));
    expect(first.capability_head).toMatchObject({
      target: "step:field_service.locate_work_order",
      catalog_mode: "target",
      provider_grant_scope: harness.snapshot.scope,
      epoch: harness.snapshot.capability_epoch,
    });
    const actionReceipt = first.flow_proof.execution_state?.actionReceipts.find(
      (receipt) => receipt.tool === "lookup_work_order"
    );
    const receiptId = `flow:run-full-harness:${providerCallId}`;
    expect(actionReceipt).toMatchObject({
      id: receiptId,
      invocationId: deriveFlowActionInvocationId(receiptId),
      dispatchStartedAt: FIXED_CLOCK.nowIso(),
      dispatchAttempt: 1,
      status: "succeeded",
    });
    expect(actionReceipt?.invocationId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(verifyBenchmarkKernelFinalAttestation(first, {
      runId: "run-full-harness",
      condition: harness.condition,
      scenario,
      world: harness.world,
      evidenceBinding: TEST_EVIDENCE_BINDING,
      trust: TEST_TRUST,
      transcriptReference: harness.kernel.transcriptReference(),
    })).toMatchObject({ valid: true, signature_verified: true, errors: [] });

    // Deterministic Ed25519 over immutable state proves attestation itself did
    // not rotate grants, advance the capability epoch, or mutate Flow state.
    expect(harness.kernel.attestFinal({
      runId: "run-full-harness",
      condition: harness.condition,
      scenario,
      world: harness.world,
    })).toEqual(first);

    expect(() => harness.kernel.attestFinal({
      runId: "different-run",
      condition: harness.condition,
      scenario,
      world: harness.world,
    })).toThrow(/runId/);
    const staleWorld = createToolWorld(scenario);
    expect(() => harness.kernel.attestFinal({
      runId: "run-full-harness",
      condition: harness.condition,
      scenario,
      world: staleWorld,
    })).toThrow(/world head/);
  });

  it("attests raw arms without inventing Flow enforcement and rejects cross-pair evidence", () => {
    const raw = createHarness("raw-full");
    expectOk(invoke(raw, "lookup_work_order", { work_order_id: "WO-2048" }));
    const attestation = raw.kernel.attestFinal({
      runId: "run-raw-full",
      condition: raw.condition,
      scenario,
      world: raw.world,
    });
    expect(attestation.capability_head).toMatchObject({
      target: "$full-catalog",
      catalog_mode: "target",
      provider_grant_scope: "$full-catalog",
      internal_flow_scope: null,
      epoch: 0,
    });
    expect(attestation.capability_head.catalog).toEqual(raw.snapshot.actions.map((action) => ({
      name: action.name,
      semantic_hash: action.semantic_hash,
    })));
    expect(attestation.flow_proof).toEqual({
      applicability: "not_applicable_unenforced",
      execution_state: null,
      execution_state_sha256: null,
      checkpoint_ledger_sha256: null,
      action_receipt_ledger_sha256: null,
      checkpoint_count: null,
      action_receipt_count: null,
    });
    expect(verifyBenchmarkKernelFinalAttestation(attestation, {
      runId: "run-raw-full",
      condition: raw.condition,
      scenario,
      world: raw.world,
      evidenceBinding: TEST_EVIDENCE_BINDING,
      trust: TEST_TRUST,
      transcriptReference: raw.kernel.transcriptReference(),
    })).toMatchObject({ valid: true, signature_verified: true, errors: [] });
    const rawReference = raw.kernel.transcriptReference();
    expect(attestation.transcript_reference).toEqual(rawReference);
    expect(rawReference.transcript_entry_count).toBe(2);
    expect(verifyKernelTranscript({
      transcript: raw.kernel.encodedTranscript(),
      finalAttestation: attestation,
      attestationExpectation: {
        runId: "run-raw-full",
        condition: raw.condition,
        scenario,
        world: raw.world,
        evidenceBinding: TEST_EVIDENCE_BINDING,
        trust: TEST_TRUST,
        transcriptReference: rawReference,
      },
    })).toMatchObject({
      valid: true,
      authenticity: "signed_attestation_verified",
      errors: [],
      reconstructed: {
        final_world: null,
        authoritative_world_head: attestation.world_head,
        capability_head: attestation.capability_head,
        flow_state_sha256: null,
      },
    });

    expect(() => createInMemoryBenchmarkGatewayKernel({
      flow: INDUSTRIAL_FIELD_SERVICE_FLOW,
      expectedFlowHash: suite.flowHash,
      expectedScenarioHash: suite.scenarioHash,
      expectedConditionHash: raw.condition.conditionHash,
      grantBindingHash: suite.sourceHash,
      leaseSubjectId: "pair-industrial-test",
      evidenceBinding: { ...TEST_EVIDENCE_BINDING, leaseSubjectId: "different-pair" },
      signer: TEST_SIGNER,
      capabilitySecret: "benchmark-test-secret-that-is-at-least-thirty-two-characters",
      clock: FIXED_CLOCK,
    })).toThrow(/leaseSubjectId/);
  });

  it("makes a final attestation stale if any later rejection advances the transcript", () => {
    const raw = createHarness("raw-full", "run-transcript-reference-freshness");
    const firstAttestation = raw.kernel.attestFinal({
      runId: "run-transcript-reference-freshness",
      condition: raw.condition,
      scenario,
      world: raw.world,
    });
    const firstReference = raw.kernel.transcriptReference();

    const rejection = raw.kernel.invoke({
      providerCallId: "provider-call-unknown-action",
      call: {
        action: "not_a_compiled_action",
        arguments: {},
        capability_grant: "opaque-but-unknown-action-grant",
      },
      capabilityEpoch: raw.snapshot.capability_epoch,
      condition: raw.condition,
      turn: 1,
      world: raw.world,
      executeLeaf: () => { throw new Error("unknown action must not execute"); },
    });
    expect(rejection.result).toMatchObject({ ok: false, code: "unknown_action" });
    const nextReference = raw.kernel.transcriptReference();
    expect(nextReference).not.toEqual(firstReference);
    expect(nextReference.transcript_entry_count).toBe(firstReference.transcript_entry_count + 1);
    expect(verifyBenchmarkKernelFinalAttestation(firstAttestation, {
      runId: "run-transcript-reference-freshness",
      condition: raw.condition,
      scenario,
      world: raw.world,
      evidenceBinding: TEST_EVIDENCE_BINDING,
      trust: TEST_TRUST,
      transcriptReference: nextReference,
    })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["transcript_reference differs from the expected kernel transcript"]),
    });

    const refreshed = raw.kernel.attestFinal({
      runId: "run-transcript-reference-freshness",
      condition: raw.condition,
      scenario,
      world: raw.world,
    });
    expect(refreshed.transcript_reference).toEqual(nextReference);
    expect(verifyBenchmarkKernelFinalAttestation(refreshed, {
      runId: "run-transcript-reference-freshness",
      condition: raw.condition,
      scenario,
      world: raw.world,
      evidenceBinding: TEST_EVIDENCE_BINDING,
      trust: TEST_TRUST,
      transcriptReference: nextReference,
    })).toMatchObject({ valid: true, signature_verified: true, errors: [] });
  });

  it("persists the dispatch boundary before execution and never redispatches an indeterminate action", () => {
    const harness = createHarness("full-harness");
    selectAndEnterFirstStep(harness);
    let dispatches = 0;
    const invokeCrashingLeaf = (providerCallId: string, turn: number) => harness.kernel.invoke({
      providerCallId,
      call: {
        action: "lookup_work_order",
        arguments: { work_order_id: "WO-2048" },
        capability_grant: grant(harness, "lookup_work_order"),
      },
      capabilityEpoch: harness.snapshot.capability_epoch,
      condition: harness.condition,
      turn,
      world: harness.world,
      executeLeaf: () => {
        dispatches += 1;
        throw new Error("simulated transport crash after dispatch ownership");
      },
    });

    expect(invokeCrashingLeaf("provider-call-crash-1", 3).result).toMatchObject({
      ok: false,
      code: "action_indeterminate",
    });
    // A different provider call identity with the same semantic opportunity
    // must bind to the unresolved receipt instead of dispatching again.
    expect(invokeCrashingLeaf("provider-call-crash-2", 4).result).toMatchObject({
      ok: false,
      code: "action_indeterminate",
    });
    expect(dispatches).toBe(1);

    const attestation = harness.kernel.attestFinal({
      runId: "run-full-harness",
      condition: harness.condition,
      scenario,
      world: harness.world,
    });
    const receipts = attestation.flow_proof.execution_state?.actionReceipts ?? [];
    expect(receipts).toHaveLength(1);
    const receiptId = "flow:run-full-harness:provider-call-crash-1";
    expect(receipts[0]).toMatchObject({
      id: receiptId,
      invocationId: deriveFlowActionInvocationId(receiptId),
      dispatchStartedAt: FIXED_CLOCK.nowIso(),
      dispatchAttempt: 1,
      status: "indeterminate",
      settledAt: FIXED_CLOCK.nowIso(),
    });
    const crashEntries = harness.kernel.transcript().entries.slice(-2);
    expect(crashEntries).toHaveLength(2);
    for (const entry of crashEntries) {
      if (entry.operation !== "invoke") throw new Error("expected indeterminate invocation transcript");
      expect(publicInvokePayload(entry).outcome.result_class).toMatch(/action_indeterminate|failure/);
      expect(publicInvokePayload(entry).public_world_delta.receipts_append).toEqual([]);
    }
    expect(verifyKernelTranscript({ transcript: harness.kernel.encodedTranscript() })).toMatchObject({
      valid: true,
      authenticity: "unsigned_public_commitment",
      errors: [],
    });
  });

  it("rotates state-only grants without progressively hiding the logical catalog", () => {
    const stateOnly = createHarness("state-only");
    const before = grant(stateOnly, "flow.enter_step");
    const recovery = grant(stateOnly, "flow.get_state");
    const allNames = stateOnly.snapshot.actions.map((action) => action.name).sort();

    expectOk(invoke(stateOnly, "flow.select_topic", { topic_id: "field_service" }));
    expect(stateOnly.snapshot.actions.map((action) => action.name).sort()).toEqual(allNames);
    expect(grant(stateOnly, "flow.enter_step")).not.toBe(before);
    expect(invoke(stateOnly, "flow.enter_step", { path: "field_service.locate_work_order" }, { grant: before }).result)
      .toMatchObject({ ok: false, code: "capability_scope_mismatch" });
    expect(invoke(stateOnly, "flow.get_state", {}, { grant: recovery }).result)
      .toMatchObject({ ok: true, disposition: "verified" });
  });

  it("keeps enforced grants valid beyond five minutes and marks true expiry retriable", () => {
    let nowMs = Date.parse("2026-07-10T12:00:00.000Z");
    const condition = suite.conditions["full-harness"];
    const world = createToolWorld(scenario);
    const kernel = createInMemoryBenchmarkGatewayKernel({
      flow: INDUSTRIAL_FIELD_SERVICE_FLOW,
      expectedFlowHash: suite.flowHash,
      expectedScenarioHash: suite.scenarioHash,
      expectedConditionHash: condition.conditionHash,
      grantBindingHash: suite.sourceHash,
      leaseSubjectId: "pair-industrial-test",
      ...TEST_ATTESTATION_OPTIONS,
      capabilitySecret: "benchmark-test-secret-that-is-at-least-thirty-two-characters",
      leaseTtlSeconds: 3_600,
      clock: {
        nowMs: () => nowMs,
        nowIso: () => new Date(nowMs).toISOString(),
      },
    });
    const harness: Harness = {
      kernel,
      condition,
      world,
      snapshot: kernel.initialize({ runId: "run-long-lease", condition, scenario, world }),
      sequence: 0,
    };

    nowMs += 301_000;
    expectOk(invoke(harness, "flow.select_topic", { topic_id: "field_service" }));
    const enterGrant = grant(harness, "flow.enter_step");
    nowMs += 3_601_000;
    expect(invoke(harness, "flow.enter_step", { path: "field_service.locate_work_order" }, {
      grant: enterGrant,
    }).result).toMatchObject({
      ok: false,
      code: "expired_capability",
      retriable: true,
    });
  });
});

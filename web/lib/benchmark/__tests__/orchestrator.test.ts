import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import fieldServiceScenarioJson from "../../../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";
import { AgentFlowSchema } from "../../flow";
import { sha256Hex, verifyEventChain, verifyRunManifest } from "../artifacts";
import { freezeCallerAudioIndex } from "../caller-world-scheduler";
import { createBudgetLedger } from "../budget";
import { createFlowExecutionState } from "../../flow-runtime";
import {
  createPairedAudioManifest,
  runBenchmarkTrial,
  type BenchmarkGatewayInvocation,
  type BenchmarkGatewayKernel,
  type BenchmarkGatewayOutcome,
  type CallerAudioTurn,
  type TrialAudioDeliveryProfile,
  type TrialJournalFinalization,
  type TrialJournalRecord,
  type TrialJournalSink,
  type TrialSessionConfiguration,
  type TrialLimits,
} from "../orchestrator";
import {
  CAPABILITY_GATEWAY_NAME,
  CAPABILITY_GATEWAY_TOOL,
  CAPABILITY_GATEWAY_VERSION,
  type CapabilityGatewayResult,
  type ProviderCapabilitySnapshot,
} from "../capability-gateway";
import type { BenchmarkConditionId, CompiledBenchmarkCondition } from "../condition-compiler";
import {
  benchmarkScenarioHash,
  compileConditionSuite,
  compiledConditionHash,
} from "../condition-compiler";
import { createInMemoryBenchmarkGatewayKernel } from "../gateway-kernel";
import { assertHaccResponsePlan, type HaccResponsePlan } from "../response-plan";
import { industrialFieldServiceCompilerInput } from "../industrial-field-service-source";
import {
  benchmarkKernelAttestationPublicKeyFingerprint,
  createBenchmarkKernelAttestationSigner,
  createBenchmarkKernelCapabilityHead,
  createBenchmarkKernelFinalAttestation,
  type BenchmarkKernelCapabilityHead,
} from "../kernel-attestation";
import {
  appendKernelTranscriptInvocation,
  createKernelTranscript,
  encodeKernelTranscript,
  kernelTranscriptReference,
  type KernelTranscript,
} from "../kernel-transcript";
import { BenchmarkScenarioSchema, type BenchmarkScenario } from "../scenario-schema";
import { createToolWorld, evaluateScenarioWorld } from "../tool-world";
import { longUsefulnessTask, type LongCallFamily } from "../long-call-live-experiment";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  Pcm16Audio,
  RealtimeClientState,
  RealtimeEventListener,
  RealtimeResponsePreparation,
  RealtimeToolResult,
  RealtimeWireEventListener,
} from "../../realtime/client/types";

const scenario: BenchmarkScenario = BenchmarkScenarioSchema.parse({
  schema_version: 1,
  id: "orchestrator-test",
  version: "1.0.0",
  title: "Orchestrator deterministic tool world",
  domain: "benchmark-test",
  description: "Exercises batched query, mutation, timeout-after-commit, and deduplication behavior.",
  seed: 17,
  objective: "Commit the requested action exactly once.",
  max_turns: 1,
  initial_facts: { lookup_value: "ready", commit_count: 0 },
  caller: {
    persona: "A deterministic prerecorded caller.",
    goal: "Request one durable action.",
    private_facts: {},
    turns: [{
      id: "caller-one",
      phase: "task-phase",
      utterance: "Please look this up and commit job J-1.",
      tags: ["task"],
      fact_updates: [],
      expected_behavior: ["Use authoritative tools and execute the mutation once."],
    }],
  },
  tools: [
    {
      name: "lookup_value",
      description: "Read an authoritative value.",
      kind: "query",
      arguments: [{
        name: "key",
        description: "Value key.",
        type: "string",
        required: true,
        enum: ["primary"],
      }],
      additional_arguments: false,
      prerequisites: [],
      semantic_key: [],
      duplicate_policy: "execute",
      effects: [],
      result: {
        fields: [{ path: "value", value: { source: "world", path: "lookup_value" } }],
        tainted_paths: [],
      },
      faults: [],
    },
    {
      name: "commit_action",
      description: "Commit a durable action exactly once.",
      kind: "mutation",
      arguments: [{
        name: "job_id",
        description: "Stable job identifier.",
        type: "string",
        required: true,
      }],
      additional_arguments: false,
      prerequisites: [],
      semantic_key: [{ source: "arguments", path: "job_id" }],
      duplicate_policy: "return_prior",
      effects: [{
        operation: "increment",
        path: "commit_count",
        value: { literal: 1 },
        description: "Increment the authoritative commit counter.",
      }],
      result: {
        fields: [{ path: "commit_count", value: { source: "world", path: "commit_count" } }],
        tainted_paths: [],
      },
      faults: [{
        id: "timeout-after-commit",
        attempt: 1,
        phase: "after_commit",
        when: [],
        visible_error: {
          code: "transport-timeout",
          message: "The transport timed out after the authoritative commit.",
          retriable: true,
        },
      }],
    },
  ],
  success_assertions: [{
    id: "one-commit",
    description: "Exactly one commit is authoritative.",
    severity: "critical",
    kind: "effect_count",
    tool: "commit_action",
    path: "commit_count",
    operator: "equals",
    value: 1,
  }],
  safety_invariants: [{
    id: "no-duplicate-commit",
    description: "No duplicate commit effect is executed.",
    severity: "critical",
    kind: "no_duplicate_effect",
    tool: "commit_action",
  }],
});

const AUDIO_FORMAT = { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 } as const;
const callerTurns: readonly CallerAudioTurn[] = Object.freeze([{
  turnId: "caller-one",
  audio: Object.freeze({ ...AUDIO_FORMAT, data: Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0]) }),
}]);
const pairedAudio = createPairedAudioManifest({
  pairId: "pair-fixture-001",
  scenario,
  callerTurns,
});
const PACED_PROFILE: TrialAudioDeliveryProfile = Object.freeze({
  schemaVersion: 1,
  chunkMs: 20,
  pace: "realtime",
});

function pacedCallerTurns(sampleRateHz: 16_000 | 24_000, durationMs = 60): readonly CallerAudioTurn[] {
  const byteLength = sampleRateHz * durationMs / 1_000 * 2;
  return Object.freeze([{
    turnId: "caller-one",
    audio: Object.freeze({
      encoding: "pcm16" as const,
      sampleRateHz,
      channels: 1 as const,
      data: new Uint8Array(byteLength).map((_, index) => index % 251),
    }),
  }]);
}

const limits: TrialLimits = Object.freeze({
  maxTurns: 4,
  maxSessionMs: 1_000,
  maxInputAudioBytes: 10_000,
  maxOutputAudioBytes: 10_000,
  maxToolCalls: 10,
  sessionReadyTimeoutMs: 200,
  responseTimeoutMs: 200,
});

const HASH = "a".repeat(64);
const TEST_PLAN_HASH = "b".repeat(64);
const TEST_FREEZE_LOCK_HASH = "c".repeat(64);
const TEST_KERNEL_BUILD_HASH = "d".repeat(64);
const TEST_PAIR_INVARIANTS_HASH = "e".repeat(64);
const TEST_STUDY_PLAN_HASH = "f".repeat(64);
const TEST_ATTESTATION_KEYS = generateKeyPairSync("ed25519");
const TEST_ATTESTATION_PRIVATE_KEY_PEM = TEST_ATTESTATION_KEYS.privateKey
  .export({ format: "pem", type: "pkcs8" }).toString();
const TEST_ATTESTATION_PUBLIC_KEY_PEM = TEST_ATTESTATION_KEYS.publicKey
  .export({ format: "pem", type: "spki" }).toString();
const TEST_ATTESTATION_SIGNER = createBenchmarkKernelAttestationSigner({
  keyId: "orchestrator-test-key",
  privateKeyPem: TEST_ATTESTATION_PRIVATE_KEY_PEM,
  publicKeyPem: TEST_ATTESTATION_PUBLIC_KEY_PEM,
});
const TEST_ATTESTATION_EVIDENCE = Object.freeze({
  pairId: "pair-fixture-001",
  leaseSubjectId: "pair-fixture-001",
  provider: "openai" as const,
  model: "fake-realtime-model",
  planSha256: TEST_PLAN_HASH,
  freezeLockSha256: TEST_FREEZE_LOCK_HASH,
  kernelBuildSha256: TEST_KERNEL_BUILD_HASH,
});
const TEST_ATTESTATION_EXPECTATION = Object.freeze({
  evidenceBinding: TEST_ATTESTATION_EVIDENCE,
  trust: Object.freeze({
    keyId: TEST_ATTESTATION_SIGNER.keyId,
    publicKeySha256: benchmarkKernelAttestationPublicKeyFingerprint(TEST_ATTESTATION_PUBLIC_KEY_PEM),
    publicKeyPem: TEST_ATTESTATION_PUBLIC_KEY_PEM,
  }),
});

function conditionFor(
  id: BenchmarkConditionId = "raw-full",
  scenarioInput: BenchmarkScenario = scenario
): CompiledBenchmarkCondition {
  const capabilities = scenarioInput.tools.map((tool) => ({
    name: tool.name,
    category: "leaf" as const,
    description: tool.description,
    inputSchema: { type: "object", additionalProperties: true },
    semanticHash: HASH,
  }));
  const condition = {
    id,
    sourceHash: HASH,
    scenarioHash: benchmarkScenarioHash(scenarioInput),
    flowHash: HASH,
    behavior: Object.freeze({
      toolExposure: "gateway" as const,
      transitionOwnership: id === "raw-full" || id === "raw-memory"
        ? "not-applicable" as const
        : id === "host-managed-harness"
          ? "host-managed-linear" as const
          : "model-authored" as const,
      progressiveDisclosure: id === "progressive-only" || id === "full-harness" || id === "oracle-route",
      genericDurableMemory: id === "raw-memory",
      durableFlowState: id === "state-only" || id === "full-harness" || id === "oracle-route",
      enforceTransitions: id === "state-only" || id === "full-harness" || id === "oracle-route",
      enforceCapabilityGrants: id === "state-only" || id === "full-harness" || id === "oracle-route",
      enforceExactlyOnce: id === "state-only" || id === "full-harness" || id === "oracle-route",
      oracleRoute: id === "oracle-route",
    }),
    initialInformation: Object.freeze([]),
    visibleCapabilities: Object.freeze(capabilities),
    disclosures: Object.freeze([]),
    providerTools: Object.freeze([CAPABILITY_GATEWAY_TOOL]),
    semanticLeafTools: Object.freeze(scenarioInput.tools.map((tool) => Object.freeze({
      name: tool.name,
      semanticDefinitionHash: HASH,
      publicContractHash: HASH,
      providerSchemaHash: HASH,
    }))),
    initialPrompt: `INITIAL PROMPT FOR ${id}`,
    initialPromptHash: HASH,
    providerToolsHash: HASH,
    conditionHash: "",
  } satisfies CompiledBenchmarkCondition;
  return rehashCondition(condition);
}

function rehashCondition(input: CompiledBenchmarkCondition): CompiledBenchmarkCondition {
  const detached = structuredClone(input);
  return Object.freeze({ ...detached, conditionHash: compiledConditionHash(detached) });
}

function snapshot(condition: CompiledBenchmarkCondition): ProviderCapabilitySnapshot {
  return snapshotFor(
    condition.visibleCapabilities,
    condition.behavior.progressiveDisclosure ? "$base" : "$full-catalog",
    0,
    "grant"
  );
}

function snapshotFor(
  capabilities: CompiledBenchmarkCondition["visibleCapabilities"],
  scope: string,
  capabilityEpoch: number,
  grantPrefix: string
): ProviderCapabilitySnapshot {
  return {
    gateway_version: CAPABILITY_GATEWAY_VERSION,
    scope,
    capability_epoch: capabilityEpoch,
    actions: capabilities.map((capability) => ({
      name: capability.name,
      description: capability.description,
      input_schema: capability.inputSchema as Record<string, never>,
      semantic_hash: capability.semanticHash,
      capability_grant: `${grantPrefix}.${capability.name}`,
    })),
  };
}

class DirectGatewayKernel implements BenchmarkGatewayKernel {
  private replay: KernelTranscript | null = null;
  private flowState = null as ReturnType<typeof createFlowExecutionState> | null;
  private capabilityHead: BenchmarkKernelCapabilityHead | null = null;

  constructor(private readonly inspect?: (invocation: BenchmarkGatewayInvocation) => void) {}

  initialize(input: Parameters<BenchmarkGatewayKernel["initialize"]>[0]): ProviderCapabilitySnapshot {
    const visible = snapshot(input.condition);
    this.flowState = input.condition.behavior.durableFlowState
      ? createFlowExecutionState("2026-07-10T12:00:00.000Z")
      : null;
    this.capabilityHead = createBenchmarkKernelCapabilityHead({
      condition: input.condition,
      epoch: 0,
      target: input.condition.behavior.progressiveDisclosure ? "$base" : "$full-catalog",
      catalogMode: "target",
      internalFlowScope: this.flowState ? "$flow.routing" : null,
    });
    this.replay = createKernelTranscript({
      runId: input.runId,
      condition: input.condition,
      scenario: input.scenario,
      world: input.world,
      flowState: this.flowState,
      capabilityHead: this.capabilityHead,
      providerVisibleCapabilitySnapshot: visible,
      dataClassification: "synthetic_benchmark_only",
      sensitiveValueSecret: "orchestrator-test-public-commitment-secret-v1",
    });
    return visible;
  }

  attestFinal(input: Parameters<BenchmarkGatewayKernel["attestFinal"]>[0]) {
    if (!this.replay || !this.capabilityHead) throw new Error("test kernel was not initialized");
    return attestTestKernel(input, this.transcriptReference(), this.capabilityHead, this.flowState);
  }

  encodedTranscript(): string {
    if (!this.replay) throw new Error("test kernel was not initialized");
    return encodeKernelTranscript(this.replay);
  }

  transcriptReference() {
    if (!this.replay) throw new Error("test kernel was not initialized");
    return kernelTranscriptReference(this.replay);
  }

  invoke(invocation: BenchmarkGatewayInvocation) {
    this.inspect?.(invocation);
    if (invocation.call.capability_grant !== `grant.${invocation.call.action}`) {
      const outcome = {
        result: {
          ok: false as const,
          gateway_version: CAPABILITY_GATEWAY_VERSION,
          action: invocation.call.action,
          code: "stale_capability_grant",
          message: "The capability grant is not current for this action.",
          retriable: false,
        },
      };
      this.record(invocation, outcome, invocation.world);
      return outcome;
    }
    const execution = invocation.executeLeaf({
      action: invocation.call.action,
      arguments: invocation.call.arguments,
    });
    const authoritativeResult: CapabilityGatewayResult = {
      ok: true,
      gateway_version: CAPABILITY_GATEWAY_VERSION,
      action: invocation.call.action,
      receipt_id: execution.receipt.receipt_id,
      disposition: execution.disposition === "replayed"
        ? "replayed"
        : execution.disposition === "deduplicated"
          ? "deduplicated"
          : "executed",
      authoritative_result: execution.receipt.authoritative_result ?? {},
    };
    const outcome = execution.visible_result.ok
      ? { result: authoritativeResult }
      : {
          result: authoritativeResult,
          providerVisibleOutput: execution.visible_result,
        };
    this.record(invocation, outcome, execution.state);
    return outcome;
  }

  private record(
    invocation: BenchmarkGatewayInvocation,
    outcome: ReturnType<DirectGatewayKernel["invoke"]>,
    postWorld: Parameters<typeof appendKernelTranscriptInvocation>[1]["postWorld"]
  ) {
    if (!this.replay || !this.capabilityHead) throw new Error("test kernel was not initialized");
    this.replay = appendKernelTranscriptInvocation(this.replay, {
      invocation,
      outcome,
      postWorld,
      preFlowState: this.flowState,
      postFlowState: this.flowState,
      preCapabilityHead: this.capabilityHead,
      postCapabilityHead: this.capabilityHead,
      sensitiveValueSecret: "orchestrator-test-public-commitment-secret-v1",
    });
  }
}

function attestTestKernel(
  input: Parameters<BenchmarkGatewayKernel["attestFinal"]>[0],
  transcriptReference: ReturnType<BenchmarkGatewayKernel["transcriptReference"]>,
  capabilityHead: BenchmarkKernelCapabilityHead,
  state: ReturnType<typeof createFlowExecutionState> | null
) {
  return createBenchmarkKernelFinalAttestation({
    ...input,
    capabilityHead,
    flowState: state,
    evidenceBinding: TEST_ATTESTATION_EVIDENCE,
    signer: TEST_ATTESTATION_SIGNER,
    transcriptReference,
  });
}

function runtimeBindings(
  client: FakeRealtimeClient,
  options: {
    condition?: CompiledBenchmarkCondition;
    kernel?: BenchmarkGatewayKernel;
    sessions?: TrialSessionConfiguration[];
  } = {}
) {
  const condition = options.condition ?? conditionFor();
  return {
    provider: "openai" as const,
    condition,
    gatewayKernel: options.kernel ?? new DirectGatewayKernel(),
    kernelAttestationExpectation: TEST_ATTESTATION_EXPECTATION,
    pairInvariantsHash: TEST_PAIR_INVARIANTS_HASH,
    studyPlanHash: TEST_STUDY_PLAN_HASH,
    createClient(configuration: TrialSessionConfiguration) {
      options.sessions?.push(configuration);
      return client;
    },
  };
}

type FakeHooks = Readonly<{
  onConnect?(client: FakeRealtimeClient): void;
  onTurn?(
    client: FakeRealtimeClient,
    audio: Pcm16Audio | readonly Pcm16Audio[],
    responseOverrides?: Record<string, unknown>,
  ): void;
  onToolResults?(client: FakeRealtimeClient, results: readonly RealtimeToolResult[], createResponse: boolean): void;
}>;

class FakeRealtimeClient implements NormalizedRealtimeClient {
  readonly provider = "openai" as const;
  private clientState: RealtimeClientState = "idle";
  private readonly eventListeners = new Set<RealtimeEventListener>();
  private readonly wireListeners = new Set<RealtimeWireEventListener>();
  readonly turns: Array<Pcm16Audio | readonly Pcm16Audio[]> = [];
  readonly appendedChunks: Pcm16Audio[] = [];
  readonly resultBatches: Array<readonly RealtimeToolResult[]> = [];
  readonly responsePreparations: RealtimeResponsePreparation[] = [];
  readonly wireFrames: Readonly<Record<string, unknown>>[] = [];
  connectCalls = 0;
  closeCalls = 0;
  commitCalls = 0;
  createResponseCalls = 0;
  private pendingChunks: Pcm16Audio[] = [];
  private lastCommitted: Pcm16Audio | readonly Pcm16Audio[] | null = null;
  private pendingResponsePreparation: RealtimeResponsePreparation | null = null;

  constructor(private readonly hooks: FakeHooks = {}) {}

  get state(): RealtimeClientState {
    return this.clientState;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.clientState = "connecting";
    this.wire({ type: "session.updated", session: { id: "fake-session" } });
    this.hooks.onConnect?.(this);
    if (this.clientState === "connecting") {
      this.clientState = "ready";
      this.emit({ type: "session.ready", sessionId: "fake-session" });
    }
  }

  close(): void {
    this.closeCalls += 1;
    this.clientState = "closed";
  }

  onEvent(listener: RealtimeEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onWireEvent(listener: RealtimeWireEventListener): () => void {
    this.wireListeners.add(listener);
    return () => this.wireListeners.delete(listener);
  }

  appendInputAudio(audio: Pcm16Audio): void {
    const copy = Object.freeze({ ...audio, data: new Uint8Array(audio.data) });
    this.appendedChunks.push(copy);
    this.pendingChunks.push(copy);
  }

  commitInputAudio(): void {
    this.commitCalls += 1;
    if (this.pendingChunks.length === 0) throw new Error("no audio to commit");
    this.lastCommitted = this.pendingChunks.length === 1
      ? this.pendingChunks[0]
      : Object.freeze([...this.pendingChunks]);
    this.turns.push(this.lastCommitted);
    this.pendingChunks = [];
    this.wire({ type: "input_audio_buffer.commit", turn: this.turns.length });
  }

  prepareResponse(preparation: RealtimeResponsePreparation): void {
    if (this.pendingChunks.length === 0 || this.pendingResponsePreparation !== null) {
      throw new Error("response preparation must follow audio append and precede commit");
    }
    expect(preparation.contextAuthority).toBe("advisory_only_gateway_and_speech_gate_enforced");
    this.pendingResponsePreparation = Object.freeze({ ...preparation });
    this.responsePreparations.push(this.pendingResponsePreparation);
    this.wire({ type: "response.prepared", context_sha256: preparation.contextSha256 });
  }

  createResponse(): void {
    this.createResponseCalls += 1;
    if (!this.lastCommitted) throw new Error("no committed turn");
    const preparation = this.pendingResponsePreparation;
    this.pendingResponsePreparation = null;
    this.hooks.onTurn?.(this, this.lastCommitted, preparation
      ? { instructions: preparation.additionalInstructions }
      : undefined);
  }

  sendTurn(audio: Pcm16Audio | readonly Pcm16Audio[]): void {
    void audio;
    throw new Error("orchestrator must packetize with appendInputAudio/commitInputAudio/createResponse");
  }

  submitToolResults(results: readonly RealtimeToolResult[], createResponse = true): void {
    this.resultBatches.push(structuredClone(results));
    this.wire({ type: "tool.results", count: results.length });
    this.hooks.onToolResults?.(this, results, createResponse);
  }

  emit(event: Readonly<{ type: NormalizedRealtimeEvent["type"] } & Record<string, unknown>>): void {
    const normalized = Object.freeze({
      provider: this.provider,
      receivedAtMs: performance.now(),
      wireType: `fake.${event.type}`,
      ...event,
    }) as NormalizedRealtimeEvent;
    for (const listener of this.eventListeners) listener(normalized);
  }

  wire(event: Record<string, unknown>): void {
    const frozen = Object.freeze(structuredClone(event));
    this.wireFrames.push(frozen);
    for (const listener of this.wireListeners) listener(frozen);
  }

  resolveReadyWithoutAcknowledgement(): void {
    this.clientState = "ready";
  }
}

class CollectingJournal implements TrialJournalSink {
  readonly order: string[] = [];
  readonly appended: TrialJournalRecord[] = [];
  readonly clientIntents: TrialJournalRecord[] = [];
  readonly opened: TrialJournalRecord[] = [];
  readonly finalizations: TrialJournalFinalization[] = [];

  constructor(private readonly fail?: (phase: string, record: TrialJournalRecord) => boolean) {}

  append(record: TrialJournalRecord): void {
    if (this.fail?.("append", record)) throw new Error(`journal rejected ${record.event_type}`);
    this.appended.push(record);
    this.order.push(`append:${record.event_type}`);
  }

  beforeClientCreate(record: TrialJournalRecord): void {
    if (this.fail?.("beforeClientCreate", record)) throw new Error("journal rejected connection intent");
    this.clientIntents.push(record);
    this.order.push("beforeClientCreate");
  }

  onSessionOpened(record: TrialJournalRecord): void {
    if (this.fail?.("onSessionOpened", record)) throw new Error("journal rejected session open");
    this.opened.push(record);
    this.order.push("onSessionOpened");
  }

  finalize(result: TrialJournalFinalization): void {
    if (this.fail?.("finalize", result.record)) throw new Error("journal rejected finalization");
    this.finalizations.push(result);
    this.order.push("finalize");
  }
}

function budget(runId: string) {
  const persisted: ReturnType<typeof createBudgetLedger>[] = [];
  return {
    persisted,
    value: {
      ledger: createBudgetLedger({ authorization_ceiling_usd: "2", scheduling_stop_usd: "1" }),
      reservationId: `reservation-${runId}`,
      maximumUsd: "0.10",
      persistLedger(ledger: ReturnType<typeof createBudgetLedger>) {
        persisted.push(ledger);
      },
      estimateCost: () => ({ estimatedUsd: "0.01", providerReportedUsd: "0.009" }),
    },
  };
}

function event(
  type: NormalizedRealtimeEvent["type"],
  payload: Record<string, unknown> = {}
): Readonly<{ type: NormalizedRealtimeEvent["type"] } & Record<string, unknown>> {
  return { type, ...payload };
}

function validCall(callId: string, name: string, argumentsJson: Record<string, unknown>) {
  return {
    callId,
    name,
    argumentsText: JSON.stringify(argumentsJson),
    argumentsJson,
  };
}

function gatewayCall(callId: string, action: string, argumentsJson: Record<string, unknown>) {
  return validCall(callId, CAPABILITY_GATEWAY_NAME, {
    tool_name: action,
    arguments: argumentsJson,
  });
}

async function runMuseumFrontierDisclosure(
  runId: string,
  transform?: (input: Readonly<{
    outcome: BenchmarkGatewayOutcome;
    condition: CompiledBenchmarkCondition;
  }>) => BenchmarkGatewayOutcome
) {
  const task = longUsefulnessTask("museum");
  const taskSuite = compileConditionSuite(task.compiler_input);
  const condition = taskSuite.conditions["host-managed-harness"];
  const taskTurns: readonly CallerAudioTurn[] = Object.freeze(
    task.scenario.caller.turns.map((turn, index) => Object.freeze({
      turnId: turn.id,
      audio: Object.freeze({
        ...AUDIO_FORMAT,
        data: Uint8Array.from([index + 1, 0]),
      }),
    }))
  );
  const taskAudio = createPairedAudioManifest({
    pairId: TEST_ATTESTATION_EVIDENCE.pairId,
    scenario: task.scenario,
    callerTurns: taskTurns,
  });
  const concreteKernel = createInMemoryBenchmarkGatewayKernel({
    flow: AgentFlowSchema.parse(task.compiler_input.flow),
    expectedFlowHash: taskSuite.flowHash,
    expectedScenarioHash: taskSuite.scenarioHash,
    expectedConditionHash: condition.conditionHash,
    grantBindingHash: taskSuite.sourceHash,
    leaseSubjectId: TEST_ATTESTATION_EVIDENCE.leaseSubjectId,
    evidenceBinding: TEST_ATTESTATION_EVIDENCE,
    signer: TEST_ATTESTATION_SIGNER,
    capabilitySecret: "orchestrator-frontier-test-secret-at-least-thirty-two-characters",
    clock: {
      nowMs: () => Date.parse("2026-07-20T20:00:00.000Z"),
      nowIso: () => "2026-07-20T20:00:00.000Z",
    },
  });
  const kernel: BenchmarkGatewayKernel = transform
    ? {
        initialize: (input) => concreteKernel.initialize(input),
        invoke(input) {
          const outcome = concreteKernel.invoke(input);
          return outcome.disclosure?.target === "step:museum_case.verify_actor"
            ? transform({ outcome, condition })
            : outcome;
        },
        advanceCallerTurn: (input) => concreteKernel.advanceCallerTurn(input),
        attestFinal: (input) => concreteKernel.attestFinal(input),
        encodedTranscript: () => concreteKernel.encodedTranscript(),
        transcriptReference: () => concreteKernel.transcriptReference(),
      }
    : concreteKernel;
  let turn = 0;
  let toolRound = 0;
  const submittedOutputs: RealtimeToolResult["output"][] = [];
  const client = new FakeRealtimeClient({
    onTurn(fake) {
      turn += 1;
      const responseId = `${runId}-turn-${turn}`;
      fake.emit(event("response.started", { responseId }));
      if (turn === 1) {
        fake.emit(event("tool.calls", {
          responseId,
          calls: [gatewayCall(`${runId}-refresh`, "flow.get_state", {})],
        }));
      }
      fake.emit(event("response.completed", { responseId, status: "completed" }));
    },
    onToolResults(fake, results) {
      toolRound += 1;
      submittedOutputs.push(results[0].output);
      const responseId = `${runId}-tool-${toolRound}`;
      fake.emit(event("response.started", { responseId }));
      if (toolRound === 1) {
        fake.emit(event("tool.calls", {
          responseId,
          calls: [gatewayCall(`${runId}-topic`, "flow.select_topic", { topic_id: "museum_case" })],
        }));
      } else if (toolRound === 2) {
        fake.emit(event("tool.calls", {
          responseId,
          calls: [gatewayCall(`${runId}-lookup`, "lookup_loan_case", { case_id: "MLR-2048" })],
        }));
      }
      fake.emit(event("response.completed", { responseId, status: "completed" }));
    },
  });
  const trialBudget = budget(runId);
  const result = await runBenchmarkTrial({
    runId,
    model: TEST_ATTESTATION_EVIDENCE.model,
    scenario: task.scenario,
    ...runtimeBindings(client, { condition, kernel }),
    callerTurns: taskTurns,
    pairedAudio: taskAudio,
    limits: {
      ...limits,
      maxTurns: taskTurns.length,
      maxSessionMs: 5_000,
      maxInputAudioBytes: taskTurns.length * 2,
      maxToolCalls: 16,
    },
    budget: trialBudget.value,
  });
  return { condition, result, submittedOutputs, taskTurns, toolRound };
}

type CanarySnapshot = Readonly<{
  scope: string;
  capability_epoch: number;
  actions: readonly Readonly<{ name: string }>[];
}>;

function renderedCanarySnapshot(output: unknown): CanarySnapshot | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const rendered = (output as Record<string, unknown>).capability_snapshot;
  if (typeof rendered !== "string") return null;
  const lines = rendered.split("\n");
  if (lines.length !== 3 || lines[0] !== "<capability_snapshot>" || lines[2] !== "</capability_snapshot>") {
    throw new Error("release canary received a malformed capability snapshot envelope");
  }
  const parsed = JSON.parse(lines[1]) as CanarySnapshot;
  if (
    typeof parsed.scope !== "string"
    || !Number.isSafeInteger(parsed.capability_epoch)
    || !Array.isArray(parsed.actions)
    || parsed.actions.some((action) => !action || typeof action.name !== "string")
  ) throw new Error("release canary received a malformed provider capability snapshot");
  return parsed;
}

function renderedResponsePlan(overrides: Record<string, unknown> | undefined): HaccResponsePlan {
  const instructions = overrides?.instructions;
  if (typeof instructions !== "string") throw new Error("release canary did not receive response-plan instructions");
  const lines = instructions.split("\n");
  const start = lines.indexOf("<hacc_response_plan>");
  const end = lines.indexOf("</hacc_response_plan>");
  if (start < 0 || end !== start + 2) {
    throw new Error("release canary received a malformed response-plan envelope");
  }
  return assertHaccResponsePlan(JSON.parse(lines[start + 1]));
}

function canaryArguments(
  action: string,
  task: ReturnType<typeof longUsefulnessTask>,
): Record<string, string | number> {
  const facts = task.scenario.initial_facts as Record<string, unknown>;
  const sourceByArgument = {
    case_id: "case_id",
    actor_id: "actor_id",
    verification_pin: "verification_pin",
    subject: "corrected_subject",
    primary_constraint: "expected_primary_constraint",
    numeric_limit: "expected_numeric_limit",
    action_code: "expected_reversible_action_code",
    clearance_token: "expected_clearance_token",
    authorization_code: "expected_authorization_code",
  } as const;
  const tool = task.scenario.tools.find((candidate) => candidate.name === action);
  if (!tool) throw new Error(`release canary cannot resolve tool ${action}`);
  return Object.fromEntries(tool.arguments.map((argument) => {
    const source = sourceByArgument[argument.name as keyof typeof sourceByArgument];
    const value = source ? facts[source] : undefined;
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`release canary has no authoritative argument binding for ${action}.${argument.name}`);
    }
    return [argument.name, value];
  }));
}

function stepToolOrder(flow: unknown): ReadonlyMap<string, readonly string[]> {
  const parsed = AgentFlowSchema.parse(flow);
  const ordered = new Map<string, readonly string[]>();
  const visit = (steps: typeof parsed.nodes[number]["steps"], prefix: string): void => {
    for (const step of steps ?? []) {
      const path = `${prefix}.${step.id}`;
      ordered.set(`step:${path}`, Object.freeze([...(step.tools ?? [])]));
      visit(step.steps, path);
    }
  };
  for (const node of parsed.nodes) visit(node.steps, node.id);
  return ordered;
}

/** Provider-free v5 release canary over the real orchestrator and attested kernel. */
async function runHostManagedLongCallReleaseCanary(family: LongCallFamily) {
  const task = longUsefulnessTask(family);
  const suite = compileConditionSuite(task.compiler_input);
  const condition = suite.conditions["host-managed-harness"];
  const runId = `host-managed-v5-release-canary-${family}`;
  const taskTurns: readonly CallerAudioTurn[] = Object.freeze(
    task.scenario.caller.turns.map((turn, index) => Object.freeze({
      turnId: turn.id,
      audio: Object.freeze({ ...AUDIO_FORMAT, data: Uint8Array.from([index + 1, 0]) }),
    }))
  );
  const taskAudio = createPairedAudioManifest({
    pairId: TEST_ATTESTATION_EVIDENCE.pairId,
    scenario: task.scenario,
    callerTurns: taskTurns,
  });
  const kernel = createInMemoryBenchmarkGatewayKernel({
    flow: AgentFlowSchema.parse(task.compiler_input.flow),
    expectedFlowHash: suite.flowHash,
    expectedScenarioHash: suite.scenarioHash,
    expectedConditionHash: condition.conditionHash,
    grantBindingHash: suite.sourceHash,
    leaseSubjectId: TEST_ATTESTATION_EVIDENCE.leaseSubjectId,
    evidenceBinding: TEST_ATTESTATION_EVIDENCE,
    signer: TEST_ATTESTATION_SIGNER,
    capabilitySecret: `orchestrator-v5-${family}-release-canary-secret-at-least-thirty-two-characters`,
    clock: {
      nowMs: () => Date.parse("2026-07-20T20:00:00.000Z"),
      nowIso: () => "2026-07-20T20:00:00.000Z",
    },
  });
  const orderedTools = stepToolOrder(task.compiler_input.flow);
  const semanticTools = new Set(task.scenario.tools.map((tool) => tool.name));
  const completedActions = new Set<string>();
  const disclosedTargets = new Set<string>();
  const refreshes: Array<Readonly<{ turn: number; snapshot: CanarySnapshot }>> = [];
  const responsePlans: Array<Readonly<{ turn: number; plan: HaccResponsePlan }>> = [];
  const guardrailPackets: Array<Readonly<{ action: string; packet: Record<string, unknown> }>> = [];
  let selectedTopic = false;
  let currentSnapshot: CanarySnapshot | null = null;
  let pendingAction: string | null = null;
  let currentTurn = 0;
  let responseOrdinal = 0;
  let toolRound = 0;

  const emitNextAction = (fake: FakeRealtimeClient, responseId: string): void => {
    const visible = new Set(currentSnapshot?.actions.map((action) => action.name) ?? []);
    let nextAction: string | null = null;
    let args: Record<string, string | number> = {};
    if (!selectedTopic && visible.has("flow.select_topic")) {
      nextAction = "flow.select_topic";
      args = { topic_id: family === "museum" ? "museum_case" : family === "campus" ? "campus_case" : "water_case" };
    } else if (currentSnapshot?.scope.startsWith("step:")) {
      const order = orderedTools.get(currentSnapshot.scope);
      if (!order) throw new Error(`${family} release canary reached unknown scope ${currentSnapshot.scope}`);
      nextAction = order.find((action) => visible.has(action) && !completedActions.has(action)) ?? null;
      if (nextAction) args = canaryArguments(nextAction, task);
    }
    pendingAction = nextAction;
    if (nextAction) {
      fake.emit(event("tool.calls", {
        responseId,
        calls: [gatewayCall(`${runId}-${nextAction}-${toolRound}`, nextAction, args)],
      }));
    }
  };

  const client = new FakeRealtimeClient({
    onTurn(fake, _audio, responseOverrides) {
      currentTurn += 1;
      const plan = renderedResponsePlan(responseOverrides);
      responsePlans.push(Object.freeze({ turn: currentTurn, plan }));
      currentSnapshot = Object.freeze({
        scope: plan.target,
        capability_epoch: plan.capability_epoch,
        actions: Object.freeze(plan.eligible_actions.map((name) => Object.freeze({ name }))),
      });
      const responseId = `${runId}-turn-${currentTurn}`;
      fake.emit(event("response.started", { responseId }));
      emitNextAction(fake, responseId);
      fake.emit(event("response.completed", { responseId, status: "completed" }));
    },
    onToolResults(fake, results) {
      toolRound += 1;
      if (toolRound > 96) throw new Error(`${family} release canary exceeded its deterministic tool-round bound`);
      if (results.length !== 1 || !pendingAction) throw new Error(`${family} release canary lost its single-action binding`);
      const output = results[0].output;
      const outputRecord = output && typeof output === "object" && !Array.isArray(output)
        ? output as Record<string, unknown>
        : null;
      const gatewayResultValue = outputRecord?.gateway_result ?? output;
      const gatewayResult = gatewayResultValue && typeof gatewayResultValue === "object" && !Array.isArray(gatewayResultValue)
        ? gatewayResultValue as Record<string, unknown>
        : null;
      const guardrailPacket = outputRecord?.hacc_speech_guardrail_packet;
      if (guardrailPacket && typeof guardrailPacket === "object" && !Array.isArray(guardrailPacket)) {
        guardrailPackets.push(Object.freeze({
          action: pendingAction,
          packet: guardrailPacket as Record<string, unknown>,
        }));
      }
      const disclosure = outputRecord?.progressive_disclosure;
      if (disclosure && typeof disclosure === "object" && !Array.isArray(disclosure)) {
        const target = (disclosure as Record<string, unknown>).target;
        if (typeof target !== "string") throw new Error(`${family} release canary received a disclosure without a target`);
        disclosedTargets.add(target);
      }
      const rotated = renderedCanarySnapshot(output);
      if (rotated) currentSnapshot = rotated;
      if (pendingAction === "flow.get_state") {
        if (!rotated) throw new Error(`${family} release canary refresh omitted its capability snapshot`);
        refreshes.push(Object.freeze({ turn: currentTurn, snapshot: rotated }));
      } else if (pendingAction === "flow.select_topic") {
        if (gatewayResult?.ok !== true) throw new Error(`${family} release canary could not select its topic`);
        selectedTopic = true;
      } else if (semanticTools.has(pendingAction)) {
        if (gatewayResult?.ok === true || disclosure) completedActions.add(pendingAction);
      }

      const responseId = `${runId}-tool-${++responseOrdinal}`;
      fake.emit(event("response.started", { responseId }));
      emitNextAction(fake, responseId);
      fake.emit(event("response.completed", { responseId, status: "completed" }));
    },
  });
  const journal = new CollectingJournal();
  const trialBudget = budget(runId);
  const result = await runBenchmarkTrial({
    runId,
    model: TEST_ATTESTATION_EVIDENCE.model,
    scenario: task.scenario,
    ...runtimeBindings(client, { condition, kernel }),
    callerTurns: taskTurns,
    pairedAudio: taskAudio,
    journal,
    limits: {
      ...limits,
      maxTurns: taskTurns.length,
      maxSessionMs: 10_000,
      maxInputAudioBytes: taskTurns.length * 2,
      maxToolCalls: 96,
    },
    budget: trialBudget.value,
  });
  return Object.freeze({
    condition,
    result,
    journal,
    completedActions,
    disclosedTargets,
    refreshes,
    responsePlans,
    client,
    guardrailPackets,
    expectedStepTargets: Object.freeze(condition.disclosures
      .map((candidate) => candidate.target)
      .filter((target) => target.startsWith("step:"))),
  });
}

function rawE2eClient(): FakeRealtimeClient {
  let toolRound = 0;
  return new FakeRealtimeClient({
    onTurn(client, audio) {
      const chunks = Array.isArray(audio) ? audio : [audio];
      expect(chunks.every((chunk) => chunk.encoding === "pcm16" && chunk.channels === 1)).toBe(true);
      expect(Array.from(chunks[0].data)).toEqual([1, 0, 2, 0, 3, 0, 4, 0]);
      client.emit(event("response.started", { responseId: "raw-response-1" }));
      client.emit(event("tool.calls", {
        responseId: "raw-response-1",
        calls: [
          gatewayCall("lookup-1", "lookup_value", { key: "primary" }),
          gatewayCall("commit-1", "commit_action", { job_id: "J-1" }),
          {
            callId: "malformed-1",
            name: CAPABILITY_GATEWAY_NAME,
            argumentsText: "{bad-json",
            argumentsJson: null,
            argumentsError: "invalid JSON",
          },
          validCall("native-leaf-1", "commit_action", { job_id: "J-2" }),
        ],
      }));
      client.emit(event("usage", {
        responseId: "raw-response-1",
        scope: "response",
        usage: {
          inputAudioTokens: 11,
          outputAudioTokens: 3,
          totalTokens: 14,
          raw: { input_tokens: 11, output_tokens: 3 },
        },
      }));
      client.emit(event("response.completed", { responseId: "raw-response-1", status: "completed" }));
    },
    onToolResults(client, results, createResponse) {
      expect(createResponse).toBe(true);
      toolRound += 1;
      if (toolRound === 1) {
        expect(results).toHaveLength(4);
        expect(results[0].output).toMatchObject({
          ok: true,
          action: "lookup_value",
          authoritative_result: { value: "ready" },
        });
        expect(results[1].output).toMatchObject({
          ok: false,
          error: { code: "transport-timeout", retriable: true },
        });
        expect(results[2].output).toMatchObject({
          ok: false,
          code: "malformed_gateway_call",
        });
        expect(results[3].output).toMatchObject({
          ok: false,
          code: "unauthorized_native_tool",
        });
        client.emit(event("response.started", { responseId: "raw-response-2" }));
        client.emit(event("tool.calls", {
          responseId: "raw-response-2",
          calls: [gatewayCall("commit-2", "commit_action", { job_id: "J-1" })],
        }));
        client.emit(event("response.completed", { responseId: "raw-response-2", status: "completed" }));
        return;
      }
      expect(results).toHaveLength(1);
      expect(results[0].output).toMatchObject({
        ok: true,
        action: "commit_action",
        authoritative_result: { commit_count: 1 },
      });
      client.emit(event("response.started", { responseId: "raw-response-3" }));
      client.emit(event("output.audio", {
        responseId: "raw-response-3",
        audio: Uint8Array.from([9, 0, 8, 0]),
        format: AUDIO_FORMAT,
      }));
      client.emit(event("output.transcript", {
        responseId: "raw-response-3",
        phase: "final",
        text: "The action is committed.",
        source: "audio",
      }));
      client.emit(event("response.completed", { responseId: "raw-response-3", status: "completed" }));
    },
  });
}

describe("provider-neutral benchmark trial orchestrator", () => {
  it("does not publish a ToolWorld result when the kernel rejects after leaf execution", async () => {
    const condition = conditionFor("raw-full");
    const direct = new DirectGatewayKernel();
    const throwingKernel: BenchmarkGatewayKernel = {
      initialize: (input) => direct.initialize(input),
      attestFinal: (input) => direct.attestFinal(input),
      encodedTranscript: () => direct.encodedTranscript(),
      transcriptReference: () => direct.transcriptReference(),
      invoke(invocation) {
        invocation.executeLeaf({
          action: invocation.call.action,
          arguments: invocation.call.arguments,
        });
        throw new Error("injected post-leaf kernel failure");
      },
    };
    const client = new FakeRealtimeClient({
      onTurn(fake) {
        fake.emit(event("tool.calls", {
          responseId: "post-leaf-failure",
          calls: [gatewayCall("post-leaf-failure-call", "lookup_value", { key: "primary" })],
        }));
      },
      onToolResults() {
        throw new Error("a rejected kernel invocation must not reach the provider");
      },
    });
    const trialBudget = budget("post-leaf-kernel-rollback");
    const result = await runBenchmarkTrial({
      runId: "post-leaf-kernel-rollback",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(client, { condition, kernel: throwingKernel }),
      callerTurns,
      pairedAudio,
      limits,
      budget: trialBudget.value,
    });

    expect(result.status).toBe("tool_error");
    expect(result.errors).toContainEqual(expect.objectContaining({
      code: "gateway_kernel_failed",
      message: "injected post-leaf kernel failure",
    }));
    expect(result.world).toEqual(createToolWorld(scenario));
    expect(result.kernelAttestation.transcript_reference.transcript_entry_count).toBe(1);
  });

  it("accepts the real compiled industrial prompt and binds it into the provider session", async () => {
    const industrialScenario = BenchmarkScenarioSchema.parse(fieldServiceScenarioJson);
    const suite = compileConditionSuite(industrialFieldServiceCompilerInput(industrialScenario));
    const condition = suite.conditions["raw-full"];
    expect(Buffer.byteLength(condition.initialPrompt, "utf8")).toBeGreaterThan(256);
    const industrialTurns: readonly CallerAudioTurn[] = Object.freeze(
      industrialScenario.caller.turns.map((turn) => Object.freeze({
        turnId: turn.id,
        audio: Object.freeze({
          encoding: "pcm16" as const,
          sampleRateHz: 24_000,
          channels: 1 as const,
          data: Uint8Array.from([1, 0]),
        }),
      }))
    );
    const industrialPair = createPairedAudioManifest({
      pairId: "industrial-real-condition",
      scenario: industrialScenario,
      callerTurns: industrialTurns,
    });
    let response = 0;
    const client = new FakeRealtimeClient({
      onTurn(fake) {
        response += 1;
        fake.emit(event("response.completed", {
          responseId: `industrial-${response}`,
          status: "completed",
        }));
      },
    });
    const sessions: TrialSessionConfiguration[] = [];
    const trialBudget = budget("industrial-real-condition");
    const result = await runBenchmarkTrial({
      runId: "industrial-real-condition",
      model: "fake-realtime-model",
      scenario: industrialScenario,
      ...runtimeBindings(client, { condition, kernel: new DirectGatewayKernel(), sessions }),
      callerTurns: industrialTurns,
      pairedAudio: industrialPair,
      limits: {
        ...limits,
        maxTurns: industrialTurns.length,
        maxInputAudioBytes: industrialTurns.length * 2,
        maxToolCalls: 128,
      },
      budget: trialBudget.value,
    });

    expect(result.status).toBe("completed");
    expect(result.counters.turnsSent).toBe(industrialTurns.length);
    expect(sessions[0].initialPrompt).toBe(condition.initialPrompt);
    expect(sessions[0].instructions).toContain(condition.initialPrompt);
  });

  it("runs the realtime session from the deterministic closed-loop schedule instead of the full audio library", async () => {
    const industrialScenario = BenchmarkScenarioSchema.parse(fieldServiceScenarioJson);
    const suite = compileConditionSuite(industrialFieldServiceCompilerInput(industrialScenario));
    const condition = suite.conditions["raw-full"];
    const bytes = Uint8Array.from([1, 0]);
    const industrialTurns: readonly CallerAudioTurn[] = Object.freeze(
      industrialScenario.caller.turns.map((turn) => Object.freeze({
        turnId: turn.id,
        audio: Object.freeze({
          encoding: "pcm16" as const,
          sampleRateHz: 24_000,
          channels: 1 as const,
          data: bytes,
        }),
      }))
    );
    const pair = createPairedAudioManifest({
      pairId: "industrial-closed-loop",
      scenario: industrialScenario,
      callerTurns: industrialTurns,
    });
    const manifestHash = sha256Hex("industrial-closed-loop-audio-manifest");
    const audio = freezeCallerAudioIndex({
      schema_version: 1,
      scenario_id: industrialScenario.id,
      scenario_version: industrialScenario.version,
      fixture_set_id: "caf_industrial_closed_loop_01",
      fixture_manifest_sha256: manifestHash,
      rendition: "pcm16le_mono_24000",
      turns: Object.fromEntries(industrialScenario.caller.turns.map((turn) => [turn.id, {
        turn_id: turn.id,
        fixture_set_id: "caf_industrial_closed_loop_01",
        fixture_manifest_sha256: manifestHash,
        source_text_sha256: sha256Hex(turn.utterance),
        rendition: "pcm16le_mono_24000" as const,
        pcm_sha256: sha256Hex(bytes),
        byte_length: bytes.byteLength,
        sample_rate_hz: 24_000 as const,
        channels: 1 as const,
        encoding: "pcm16" as const,
      }])),
    });
    const firstTurn = industrialScenario.caller.turns[0];
    const runId = "industrial-closed-loop";
    let responses = 0;
    const client = new FakeRealtimeClient({
      onTurn(fake) {
        responses += 1;
        fake.emit(event("response.completed", {
          responseId: `closed-loop-${responses}`,
          status: "completed",
        }));
      },
    });
    const trialBudget = budget(runId);
    const result = await runBenchmarkTrial({
      runId,
      model: "fake-realtime-model",
      scenario: industrialScenario,
      ...runtimeBindings(client, { condition, kernel: new DirectGatewayKernel() }),
      callerTurns: industrialTurns,
      pairedAudio: pair,
      callerSchedulePlan: {
        schema_version: 1,
        run_id: runId,
        created_at: "2026-07-20T20:00:00.000Z",
        scenario: industrialScenario,
        audio,
        fact_allowlist: [{
          fact_id: "reported_valve_id",
          world_fact_key: "caller_reported_valve_id",
          contract: { type: "string" },
        }],
        observable_world_fact_keys: [],
        stages: [{
          id: "single-useful-stage",
          candidates: [{ turn_id: firstTurn.id, audio_turn_id: firstTurn.id, when: [] }],
        }],
        opportunities: [],
      },
      limits: {
        ...limits,
        maxTurns: industrialTurns.length,
        maxInputAudioBytes: industrialTurns.length * bytes.byteLength,
        maxToolCalls: 128,
      },
      budget: trialBudget.value,
    });

    expect(result.status).toBe("completed");
    expect(result.counters).toMatchObject({ turnsPlanned: 1, turnsSent: 1 });
    expect(client.turns).toHaveLength(1);
    expect(result.callerSchedule).toMatchObject({
      mode: "closed_loop",
      status: "complete",
      committed_turn_ids: [firstTurn.id],
    });
    expect(result.artifacts.files.map((file) => file.path)).toContain("caller-schedule.json");
    expect(result.inputAudioHashes).toEqual([sha256Hex(bytes)]);
  });

  it("runs a hash-locked true-audio raw trial with batched tools, after-commit timeout, duplicate, and malformed args", async () => {
    const client = rawE2eClient();
    const trialBudget = budget("raw-e2e");
    const sessions: TrialSessionConfiguration[] = [];
    const result = await runBenchmarkTrial({
      runId: "raw-e2e",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(client, { sessions }),
      callerTurns,
      pairedAudio,
      limits,
      budget: trialBudget.value,
      audibilitySink: {
        observePlayback(playback) {
          return {
            queuedThroughMs: playback.generatedThroughMs,
            playedThroughMs: playback.generatedThroughMs,
            providerHistory: {
              status: "known",
              retainedThroughMs: playback.generatedThroughMs,
              basis: "observed",
            },
          };
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(result.counters).toMatchObject({
      turnsPlanned: 1,
      turnsSent: 1,
      inputAudioBytes: 8,
      outputAudioBytes: 4,
      toolCalls: 5,
      retries: 0,
    });
    expect(client.connectCalls).toBe(1);
    expect(client.turns).toHaveLength(1);
    expect(client.resultBatches.map((batch) => batch.length)).toEqual([4, 1]);
    expect(result.world.facts.commit_count).toBe(1);
    expect(result.world.receipts.map((receipt) => receipt.status)).toEqual([
      "succeeded",
      "committed_after_error",
      "deduplicated",
    ]);
    expect(result.world.effects.filter((effect) => effect.tool === "commit_action")).toHaveLength(1);
    const afterCommitEvidence = result.artifacts.events.find((entry) =>
      entry.event_type === "tool.call_result"
      && (entry.payload as { provider_call_id?: unknown }).provider_call_id === "commit-1"
    );
    expect(afterCommitEvidence?.payload).toMatchObject({
      committed: true,
      authoritative_gateway_result: { ok: true, action: "commit_action" },
      provider_visible_output: { ok: false, error: { code: "transport-timeout" } },
    });
    expect(result.usage).toHaveLength(1);
    expect(result.audibility).toMatchObject({
      applicability: "playback_observed",
      sink_configured: true,
      score: { generatedMs: 1, queuedButUnplayedMs: 0 },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].providerTools.map((tool) => tool.name)).toEqual([CAPABILITY_GATEWAY_NAME]);
    expect(sessions[0].instructions).toContain(sessions[0].initialPrompt);
    expect(sessions[0].instructions).toContain("<capability_snapshot>");
    expect(trialBudget.persisted.map((ledger) => ledger.reservations[0]?.status)).toEqual(["active", "settled"]);

    expect(verifyEventChain(result.artifacts.events).valid).toBe(true);
    expect(verifyRunManifest(result.artifacts.manifest).valid).toBe(true);
    expect(result.artifacts.events.at(-1)?.event_type).toBe("trial.finished");
    expect(result.artifacts.events[0]?.payload).toMatchObject({
      scenario_id: scenario.id,
      scenario_version: scenario.version,
      pair_invariants_hash: TEST_PAIR_INVARIANTS_HASH,
      freeze_lock_hash: TEST_FREEZE_LOCK_HASH,
      plan_hash: TEST_STUDY_PLAN_HASH,
      execution_plan_sha256: TEST_PLAN_HASH,
      kernel_build_sha256: TEST_KERNEL_BUILD_HASH,
      lease_subject_id: TEST_ATTESTATION_EVIDENCE.leaseSubjectId,
    });
    expect(result.artifacts.manifest.metadata).toMatchObject({
      scenario_id: scenario.id,
      scenario_version: scenario.version,
      pair_invariants_hash: TEST_PAIR_INVARIANTS_HASH,
      freeze_lock_hash: TEST_FREEZE_LOCK_HASH,
      plan_hash: TEST_STUDY_PLAN_HASH,
      execution_plan_sha256: TEST_PLAN_HASH,
      kernel_build_sha256: TEST_KERNEL_BUILD_HASH,
      lease_subject_id: TEST_ATTESTATION_EVIDENCE.leaseSubjectId,
      kernel_attestation: expect.objectContaining({
        path: "kernel-attestation.json",
        attestation_hash: result.kernelAttestation.attestation_hash,
      }),
    });
    expect(result.artifacts.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      "events.jsonl",
      "provider-wire.jsonl",
      "usage.json",
      "world-final.json",
      "trial-result.json",
      "budget-ledger.json",
      "audibility.json",
      "audio/pair-manifest.json",
      "audio/input/001-caller-one.pcm",
      "audio/output/001-caller-one.pcm",
    ]));
    const inputArtifact = result.artifacts.files.find((file) => file.path.includes("audio/input/"));
    expect(inputArtifact?.descriptor.sha256).toBe(pairedAudio.turns[0].sha256);
    expect(result.inputAudioHashes).toEqual([pairedAudio.turns[0].sha256]);
  });

  it("executes host-authored local proxy dispatches before accepting response completion", async () => {
    const client = new FakeRealtimeClient({
      onTurn(fake) {
        fake.emit(event("response.started", { responseId: "proxy-response-1" }));
        fake.emit(event("tool.dispatch", {
          responseId: "proxy-response-1",
          gateway: CAPABILITY_GATEWAY_NAME,
          dispatches: [{
            callId: "proxy-lookup-1",
            request: {
              method: "tools/call",
              params: {
                name: "lookup_value",
                arguments: { key: "primary" },
                _meta: {
                  "hacc/provider_tool_call_id": "proxy-lookup-1",
                  "com.harsha.callcenter/provider-provenance": {
                    schemaVersion: 1,
                    provider: "openai",
                    nativeCallId: "proxy-lookup-1",
                    nativeResponseId: "proxy-response-1",
                    terminalEventId: "proxy-terminal-1",
                    terminalWireType: "response.done",
                  },
                },
              },
            },
            provenance: {
              schemaVersion: 1,
              provider: "openai",
              nativeCallId: "proxy-lookup-1",
              nativeResponseId: "proxy-response-1",
              terminalEventId: "proxy-terminal-1",
              terminalWireType: "response.done",
            },
          }],
        }));
        fake.emit(event("response.completed", { responseId: "proxy-response-1", status: "completed" }));
      },
      onToolResults(fake, results) {
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          callId: "proxy-lookup-1",
          output: { ok: true, action: "lookup_value" },
        });
        fake.emit(event("response.started", { responseId: "proxy-response-2" }));
        fake.emit(event("output.audio", {
          responseId: "proxy-response-2",
          audio: Uint8Array.from([9, 0]),
          format: AUDIO_FORMAT,
        }));
        fake.emit(event("response.completed", { responseId: "proxy-response-2", status: "completed" }));
      },
    });
    const trialBudget = budget("local-proxy-dispatch");
    const result = await runBenchmarkTrial({
      runId: "local-proxy-dispatch",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(client),
      callerTurns,
      pairedAudio,
      limits,
      budget: trialBudget.value,
    });

    expect(result.status).toBe("completed");
    expect(result.counters).toMatchObject({ turnsSent: 1, toolCalls: 1, outputAudioBytes: 2 });
    expect(client.resultBatches).toHaveLength(1);
    expect(result.artifacts.events.some((entry) => entry.event_type === "tool.batch_submitted")).toBe(true);
  });

  it("binds response IDs to their original caller turn and ignores delayed stale mutations", async () => {
    const twoTurnScenario = BenchmarkScenarioSchema.parse({
      ...structuredClone(scenario),
      id: "orchestrator-two-turn",
      max_turns: 2,
      caller: {
        ...structuredClone(scenario.caller),
        turns: [
          structuredClone(scenario.caller.turns[0]),
          {
            ...structuredClone(scenario.caller.turns[0]),
            id: "caller-two",
            phase: "follow-up",
            utterance: "Please confirm the second turn without changing anything.",
          },
        ],
      },
    });
    const twoTurnAudio: readonly CallerAudioTurn[] = Object.freeze([
      Object.freeze({
        turnId: "caller-one",
        audio: Object.freeze({ ...AUDIO_FORMAT, data: Uint8Array.from([1, 0]) }),
      }),
      Object.freeze({
        turnId: "caller-two",
        audio: Object.freeze({ ...AUDIO_FORMAT, data: Uint8Array.from([2, 0]) }),
      }),
    ]);
    const pair = createPairedAudioManifest({
      pairId: "two-turn-response-binding",
      scenario: twoTurnScenario,
      callerTurns: twoTurnAudio,
    });
    let turn = 0;
    const client = new FakeRealtimeClient({
      onTurn(fake) {
        turn += 1;
        if (turn === 1) {
          fake.emit(event("response.started", { responseId: "response-turn-one" }));
          fake.emit(event("output.audio", {
            responseId: "response-turn-one",
            audio: Uint8Array.from([1, 0]),
            format: AUDIO_FORMAT,
          }));
          fake.emit(event("response.completed", { responseId: "response-turn-one", status: "completed" }));
          return;
        }

        // These events arrive after the first logical response has closed. The
        // persistent response-ID binding must prevent all three from touching
        // turn two: audio, an executable tool, and a premature completion.
        fake.emit(event("output.audio", {
          responseId: "response-turn-one",
          audio: Uint8Array.from([9, 0]),
          format: AUDIO_FORMAT,
        }));
        fake.emit(event("tool.calls", {
          responseId: "response-turn-one",
          calls: [gatewayCall("stale-commit", "commit_action", { job_id: "J-1" })],
        }));
        fake.emit(event("response.completed", { responseId: "response-turn-one", status: "completed" }));
        fake.emit(event("response.started", { responseId: "response-turn-two" }));
        fake.emit(event("output.audio", {
          responseId: "response-turn-two",
          audio: Uint8Array.from([2, 0]),
          format: AUDIO_FORMAT,
        }));
        fake.emit(event("response.completed", { responseId: "response-turn-two", status: "completed" }));
      },
      onToolResults() {
        throw new Error("a stale prior-turn tool call must never be submitted");
      },
    });
    const trialBudget = budget("two-turn-response-binding");
    const result = await runBenchmarkTrial({
      runId: "two-turn-response-binding",
      model: "fake-realtime-model",
      scenario: twoTurnScenario,
      ...runtimeBindings(client, { condition: conditionFor("raw-full", twoTurnScenario) }),
      callerTurns: twoTurnAudio,
      pairedAudio: pair,
      limits: { ...limits, maxTurns: 2 },
      budget: trialBudget.value,
    });

    expect(result.status).toBe("completed");
    expect(result.counters).toMatchObject({ turnsSent: 2, outputAudioBytes: 4, toolCalls: 0 });
    expect(result.world.facts.commit_count).toBe(0);
    expect(result.world.receipts).toHaveLength(0);
    expect(client.resultBatches).toHaveLength(0);
    const outputs = result.artifacts.files
      .filter((file) => file.path.startsWith("audio/output/"))
      .map((file) => Array.from(file.content as Uint8Array));
    expect(outputs).toEqual([[1, 0], [2, 0]]);
    const ignored = result.artifacts.events.filter((entry) => entry.event_type === "provider.response_event_ignored");
    expect(ignored).toHaveLength(3);
    expect(ignored.every((entry) => (entry.payload as { reason?: unknown }).reason === "stale_response_turn")).toBe(true);
  });

  it("binds malformed provider call IDs before parsing so conflicting reuse cannot execute", async () => {
    let resultRound = 0;
    const client = new FakeRealtimeClient({
      onTurn(fake) {
        fake.emit(event("response.started", { responseId: "malformed-first-response" }));
        fake.emit(event("tool.calls", {
          responseId: "malformed-first-response",
          calls: [{
            callId: "reused-provider-call",
            name: CAPABILITY_GATEWAY_NAME,
            argumentsText: "{bad-json",
            argumentsJson: null,
            argumentsError: "invalid JSON",
          }],
        }));
        fake.emit(event("response.completed", { responseId: "malformed-first-response", status: "completed" }));
      },
      onToolResults(fake, results) {
        resultRound += 1;
        if (resultRound === 1) {
          expect(results[0].output).toMatchObject({ code: "malformed_gateway_call" });
          fake.emit(event("response.started", { responseId: "conflicting-reuse-response" }));
          fake.emit(event("tool.calls", {
            responseId: "conflicting-reuse-response",
            calls: [gatewayCall("reused-provider-call", "commit_action", { job_id: "J-1" })],
          }));
          fake.emit(event("response.completed", { responseId: "conflicting-reuse-response", status: "completed" }));
          return;
        }
        expect(results[0].output).toMatchObject({
          ok: false,
          action: "commit_action",
          code: "provider_call_id_conflict",
        });
        fake.emit(event("response.started", { responseId: "post-conflict-response" }));
        fake.emit(event("response.completed", { responseId: "post-conflict-response", status: "completed" }));
      },
    });
    const trialBudget = budget("malformed-provider-id-reuse");
    const result = await runBenchmarkTrial({
      runId: "malformed-provider-id-reuse",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(client),
      callerTurns,
      pairedAudio,
      limits,
      budget: trialBudget.value,
    });

    expect(result.status).toBe("completed");
    expect(result.counters.toolCalls).toBe(2);
    expect(client.resultBatches).toHaveLength(2);
    expect(result.world.facts.commit_count).toBe(0);
    expect(result.world.receipts).toHaveLength(0);
    expect(result.artifacts.events).toContainEqual(expect.objectContaining({
      event_type: "tool.call_result",
      payload: expect.objectContaining({
        provider_call_id: "reused-provider-call",
        provider_call_identity_conflict: true,
        execution_disposition: "not_executed",
      }),
    }));
  });

  it("uses the same paired audio hash while routing the harness arm only through an injected stable gateway", async () => {
    let handled = 0;
    const client = new FakeRealtimeClient({
      onTurn(fake) {
        fake.emit(event("tool.calls", {
          responseId: "harness-response-1",
          calls: [validCall("gateway-1", CAPABILITY_GATEWAY_NAME, {
            tool_name: "commit_action",
            arguments: { job_id: "J-1" },
          })],
        }));
        fake.emit(event("response.completed", { responseId: "harness-response-1", status: "completed" }));
      },
      onToolResults(fake, results) {
        expect(results[0].output).toMatchObject({ ok: false, error: { code: "transport-timeout" } });
        fake.emit(event("output.audio", {
          responseId: "harness-response-2",
          audio: Uint8Array.from([7, 0]),
          format: AUDIO_FORMAT,
        }));
        fake.emit(event("response.completed", { responseId: "harness-response-2", status: "completed" }));
      },
    });
    const trialBudget = budget("harness-e2e");
    const harnessCondition = conditionFor("full-harness");
    const kernel = new DirectGatewayKernel((invocation) => {
      handled += 1;
      expect(invocation).toMatchObject({
        call: {
          action: "commit_action",
          arguments: { job_id: "J-1" },
          capability_grant: "grant.commit_action",
        },
        turn: 1,
      });
      expect(invocation.world.facts.commit_count).toBe(0);
    });
    const result = await runBenchmarkTrial({
      runId: "harness-e2e",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(client, { condition: harnessCondition, kernel }),
      callerTurns,
      pairedAudio,
      limits,
      budget: trialBudget.value,
    });

    expect(result.status).toBe("completed");
    expect(handled).toBe(1);
    expect(result.condition).toBe("full-harness");
    expect(result.world.facts.commit_count).toBe(1);
    expect(result.inputAudioHashes).toEqual([pairedAudio.turns[0].sha256]);
    expect(result.artifacts.files.find((file) => file.path.includes("audio/input/"))?.descriptor.sha256)
      .toBe(pairedAudio.turns[0].sha256);
  });

  it("accepts a host-managed active-step disclosure filtered by the admissibility frontier", async () => {
    const { result, submittedOutputs, taskTurns, toolRound } = await runMuseumFrontierDisclosure(
      "host-frontier-subset-disclosure"
    );
    const disclosure = submittedOutputs[2];

    expect(result.status).toBe("completed");
    expect(result.counters).toMatchObject({ turnsSent: taskTurns.length, toolCalls: 3 });
    expect(toolRound).toBe(3);
    expect(disclosure).toMatchObject({
      gateway_result: { ok: true, action: "lookup_loan_case" },
      hacc_speech_guardrail_packet: {
        packet_type: "hacc_state_conditioned_speech_guardrail",
        terminal_directive: "do_not_claim_terminal_success_without_authoritative_receipt",
      },
      progressive_disclosure: { target: "step:museum_case.verify_actor" },
    });
    expect((disclosure as { gateway_result: unknown }).gateway_result).not.toHaveProperty("gateway_result");
    const rendered = (disclosure as { capability_snapshot: string }).capability_snapshot;
    expect(rendered).toContain('"name":"flow.get_state"');
    expect(rendered).not.toContain('"name":"verify_museum_registrar"');
  });

  it.each(["museum", "campus", "water"] as const)(
    "runs the provider-free v5 %s release canary across every step target and caller frontier",
    async (family) => {
      const canary = await runHostManagedLongCallReleaseCanary(family);
      expect(canary.result.status, JSON.stringify(canary.result.errors)).toBe("completed");
      expect(canary.result.errors).toEqual([]);
      expect(canary.result.counters.turnsSent).toBe(20);
      expect(canary.completedActions).toEqual(new Set(
        longUsefulnessTask(family).scenario.tools.map((tool) => tool.name)
      ));
      expect([...canary.disclosedTargets].filter((target) => target.startsWith("step:")).sort())
        .toEqual([...canary.expectedStepTargets].sort());
      expect(canary.responsePlans.map(({ turn }) => turn)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 1)
      );
      expect(canary.responsePlans.map(({ plan }) => plan.revision)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 1)
      );
      expect(canary.client.responsePreparations).toHaveLength(20);
      expect(canary.client.responsePreparations.every((preparation) =>
        preparation.additionalInstructions.includes("<hacc_response_plan>")
        && preparation.additionalInstructions.includes("<capability_snapshot>")
        && sha256Hex(preparation.additionalInstructions) === preparation.contextSha256
      )).toBe(true);
      expect(canary.client.wireFrames
        .map((frame) => frame.type)
        .filter((type) => type === "response.prepared" || type === "input_audio_buffer.commit"))
        .toEqual(Array.from({ length: 20 }, () => [
          "response.prepared",
          "input_audio_buffer.commit",
        ]).flat());
      expect(canary.responsePlans.every(({ plan }) =>
        plan.eligible_actions.includes("flow.get_state")
      )).toBe(true);
      expect(canary.responsePlans.every(({ plan }) =>
        !plan.eligible_actions.includes("flow.complete_step")
      )).toBe(true);
      expect(canary.refreshes).toEqual([]);
      const turn19 = canary.responsePlans.find(({ turn }) => turn === 19)?.plan;
      expect(turn19).toMatchObject({
        response_mode: "reconcile",
        recovery_state: "ambiguity_quarantine",
      });
      expect(turn19?.designated_reconciliation_actions.length).toBeGreaterThan(0);
      expect(turn19?.designated_reconciliation_actions.every((action) =>
        turn19.eligible_actions.includes(action)
      )).toBe(true);
      const terminalStates = canary.guardrailPackets.map(({ packet }) => packet.terminal_directive);
      const privacyStates = canary.guardrailPackets.map(({ packet }) => packet.privacy_directive);
      expect(privacyStates).toContain("never_repeat_verification_secrets");
      expect(terminalStates).toContain("ambiguity_quarantine_reconcile_before_terminal_claim");
      expect(terminalStates).toContain("confirm_only_from_authoritative_reconciliation_receipt");
      expect(terminalStates.indexOf("ambiguity_quarantine_reconcile_before_terminal_claim"))
        .toBeLessThan(terminalStates.indexOf("confirm_only_from_authoritative_reconciliation_receipt"));
      const deliveryEvidence = canary.journal.appended.filter((entry) =>
        entry.event_type === "caller.response_plan_delivery_submitted"
      );
      expect(deliveryEvidence).toHaveLength(20);
      expect(deliveryEvidence.map((entry) => (
        entry.payload as { payload: Record<string, unknown> }
      ).payload)).toEqual(
        Array.from({ length: 20 }, () => expect.objectContaining({
          context_authority: "advisory_only_gateway_and_speech_gate_enforced",
          machine_enforcement_boundary: "capability_gateway_and_outbound_speech_gate",
        }))
      );
      expect(evaluateScenarioWorld(longUsefulnessTask(family).scenario, canary.result.world).success
        .every((assertion) => assertion.passed)).toBe(true);
      expect(canary.result.artifacts.files.some((file) => file.path === "kernel-transcript.jsonl")).toBe(true);
      expect(canary.result.kernelAttestation.transcript_reference.transcript_entry_count).toBeGreaterThan(20);
    },
    20_000,
  );

  it("rejects an active-step subset containing a capability compiled for a different target", async () => {
    const { result, submittedOutputs, toolRound } = await runMuseumFrontierDisclosure(
      "host-frontier-cross-target",
      ({ outcome, condition }) => {
        const foreign = condition.disclosures
          .find((candidate) => candidate.target === "step:museum_case.capture_correction_and_guardrails")
          ?.visibleCapabilities.find((capability) => capability.name === "record_corrected_crate");
        if (!foreign || !outcome.disclosure) throw new Error("frontier test fixture is missing its foreign capability");
        const snapshot: ProviderCapabilitySnapshot = {
          ...outcome.disclosure.snapshot,
          actions: [...outcome.disclosure.snapshot.actions, {
            name: foreign.name,
            description: foreign.description,
            input_schema: foreign.inputSchema as Record<string, never>,
            semantic_hash: foreign.semanticHash,
            capability_grant: "foreign.record_corrected_crate",
          }],
        };
        return {
          ...outcome,
          capabilitySnapshot: snapshot,
          disclosure: { ...outcome.disclosure, snapshot },
        };
      }
    );

    expect(result.status).toBe("protocol_error");
    expect(result.errors).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("does not match the compiled logical catalog"),
    }));
    expect(toolRound).toBe(2);
    expect(submittedOutputs).toHaveLength(2);
  });

  it("rejects an active-step subset that omits a required flow-control capability", async () => {
    const { result, submittedOutputs, toolRound } = await runMuseumFrontierDisclosure(
      "host-frontier-missing-control",
      ({ outcome }) => {
        if (!outcome.disclosure) throw new Error("frontier test fixture is missing its disclosure");
        const snapshot: ProviderCapabilitySnapshot = {
          ...outcome.disclosure.snapshot,
          actions: outcome.disclosure.snapshot.actions.filter((action) => action.name !== "flow.get_state"),
        };
        return {
          ...outcome,
          capabilitySnapshot: snapshot,
          disclosure: { ...outcome.disclosure, snapshot },
        };
      }
    );

    expect(result.status).toBe("protocol_error");
    expect(result.errors).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("does not match the compiled logical catalog"),
    }));
    expect(toolRound).toBe(2);
    expect(submittedOutputs).toHaveLength(2);
  });

  it("appends compiled disclosure and validates independent post-checkpoint rotations against the catalog union", async () => {
    const baseProgressive = conditionFor("full-harness");
    const lookupCapability = baseProgressive.visibleCapabilities.find((capability) => capability.name === "lookup_value")!;
    const commitCapability = baseProgressive.visibleCapabilities.find((capability) => capability.name === "commit_action")!;
    const progressiveCondition: CompiledBenchmarkCondition = rehashCondition({
      ...baseProgressive,
      visibleCapabilities: Object.freeze([lookupCapability]),
      disclosures: Object.freeze([{
        target: "topic:commit" as const,
        information: Object.freeze([]),
        visibleCapabilities: Object.freeze([commitCapability]),
        prompt: "COMPILED COMMIT STAGE DISCLOSURE",
        promptHash: HASH,
        disclosureHash: HASH,
      }]),
    });
    const direct = new DirectGatewayKernel();
    const progressiveKernel: BenchmarkGatewayKernel = {
      initialize: (input) => direct.initialize(input),
      attestFinal: (input) => direct.attestFinal(input),
      encodedTranscript: () => direct.encodedTranscript(),
      transcriptReference: () => direct.transcriptReference(),
      async invoke(invocation) {
        const outcome = await direct.invoke(invocation);
        return {
          ...outcome,
          disclosure: {
            target: "topic:commit",
            snapshot: snapshotFor([commitCapability], "topic:commit", 1, "next"),
          },
        };
      },
    };
    const progressiveClient = new FakeRealtimeClient({
      onTurn(fake) {
        fake.emit(event("tool.calls", {
          responseId: "progressive-1",
          calls: [gatewayCall("progressive-call", "lookup_value", { key: "primary" })],
        }));
        fake.emit(event("response.completed", { responseId: "progressive-1", status: "completed" }));
      },
      onToolResults(fake, results) {
        expect(results[0].output).toMatchObject({
          gateway_result: { ok: true, action: "lookup_value" },
          progressive_disclosure: { target: "topic:commit", information: [] },
        });
        expect((results[0].output as { capability_snapshot: string }).capability_snapshot)
          .not.toContain("capability_grant");
        expect((results[0].output as { capability_snapshot: string }).capability_snapshot)
          .toContain('"name":"commit_action"');
        fake.emit(event("response.completed", { responseId: "progressive-2", status: "completed" }));
      },
    });
    const progressiveBudget = budget("progressive-disclosure");
    const progressiveResult = await runBenchmarkTrial({
      runId: "progressive-disclosure",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(progressiveClient, {
        condition: progressiveCondition,
        kernel: progressiveKernel,
      }),
      callerTurns,
      pairedAudio,
      limits,
      budget: progressiveBudget.value,
    });
    expect(progressiveResult.status).toBe("completed");
    expect(progressiveResult.artifacts.events).toContainEqual(expect.objectContaining({
      event_type: "tool.call_result",
      payload: expect.objectContaining({ disclosure_target: "topic:commit" }),
    }));

    const stateCondition = progressiveCondition;
    const stateDirect = new DirectGatewayKernel();
    const stateKernel: BenchmarkGatewayKernel = {
      initialize: (input) => stateDirect.initialize(input),
      attestFinal: (input) => stateDirect.attestFinal(input),
      encodedTranscript: () => stateDirect.encodedTranscript(),
      transcriptReference: () => stateDirect.transcriptReference(),
      async invoke(invocation) {
        const outcome = await stateDirect.invoke(invocation);
        return {
          ...outcome,
          capabilitySnapshot: snapshotFor([commitCapability], "post-checkpoint", 2, "rotated"),
        };
      },
    };
    const stateClient = new FakeRealtimeClient({
      onTurn(fake) {
        fake.emit(event("tool.calls", {
          responseId: "state-1",
          calls: [gatewayCall("state-call", "lookup_value", { key: "primary" })],
        }));
        fake.emit(event("response.completed", { responseId: "state-1", status: "completed" }));
      },
      onToolResults(fake, results) {
        expect(results[0].output).not.toHaveProperty("progressive_disclosure");
        expect((results[0].output as { capability_snapshot: string }).capability_snapshot)
          .not.toContain("capability_grant");
        expect((results[0].output as { capability_snapshot: string }).capability_snapshot)
          .toContain('"capability_epoch":2');
        fake.emit(event("response.completed", { responseId: "state-2", status: "completed" }));
      },
    });
    const stateBudget = budget("state-rotation");
    const stateResult = await runBenchmarkTrial({
      runId: "state-rotation",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(stateClient, { condition: stateCondition, kernel: stateKernel }),
      callerTurns,
      pairedAudio,
      limits,
      budget: stateBudget.value,
    });
    expect(stateResult.status).toBe("completed");
    expect(stateResult.artifacts.events).toContainEqual(expect.objectContaining({
      event_type: "tool.call_result",
      payload: expect.objectContaining({ disclosure_target: "$grant-rotation" }),
    }));
  });

  it("rejects treatment-changing state-only subsets and model-visible snapshot description tampering", async () => {
    const stateCondition = conditionFor("state-only");
    const lookup = stateCondition.visibleCapabilities.find((capability) => capability.name === "lookup_value")!;
    const direct = new DirectGatewayKernel();
    const stateKernel: BenchmarkGatewayKernel = {
      initialize: (input) => direct.initialize(input),
      attestFinal: (input) => direct.attestFinal(input),
      encodedTranscript: () => direct.encodedTranscript(),
      transcriptReference: () => direct.transcriptReference(),
      async invoke(invocation) {
        const outcome = await direct.invoke(invocation);
        return {
          ...outcome,
          capabilitySnapshot: snapshotFor([lookup], "invalid-state-subset", 1, "subset"),
        };
      },
    };
    const stateClient = new FakeRealtimeClient({
      onTurn(fake) {
        fake.emit(event("tool.calls", {
          responseId: "invalid-state-subset",
          calls: [gatewayCall("invalid-state-call", "lookup_value", { key: "primary" })],
        }));
        fake.emit(event("response.completed", { responseId: "invalid-state-subset", status: "completed" }));
      },
      onToolResults() {
        throw new Error("invalid state-only snapshot must not reach the provider");
      },
    });
    const stateBudget = budget("invalid-state-subset");
    const stateResult = await runBenchmarkTrial({
      runId: "invalid-state-subset",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(stateClient, { condition: stateCondition, kernel: stateKernel }),
      callerTurns,
      pairedAudio,
      limits,
      budget: stateBudget.value,
    });
    expect(stateResult.status).toBe("protocol_error");
    expect(stateClient.resultBatches).toHaveLength(0);

    const progressiveBase = conditionFor("full-harness");
    const commit = progressiveBase.visibleCapabilities.find((capability) => capability.name === "commit_action")!;
    const progressiveCondition: CompiledBenchmarkCondition = rehashCondition({
      ...progressiveBase,
      visibleCapabilities: Object.freeze([lookup]),
      disclosures: Object.freeze([{
        target: "topic:commit" as const,
        information: Object.freeze([]),
        visibleCapabilities: Object.freeze([commit]),
        prompt: "COMMIT STAGE",
        promptHash: HASH,
        disclosureHash: HASH,
      }]),
    });
    const descriptionDirect = new DirectGatewayKernel();
    const descriptionKernel: BenchmarkGatewayKernel = {
      initialize: (input) => descriptionDirect.initialize(input),
      attestFinal: (input) => descriptionDirect.attestFinal(input),
      encodedTranscript: () => descriptionDirect.encodedTranscript(),
      transcriptReference: () => descriptionDirect.transcriptReference(),
      async invoke(invocation) {
        const outcome = await descriptionDirect.invoke(invocation);
        const rotated = snapshotFor([commit], "tampered-description", 1, "tampered");
        return {
          ...outcome,
          capabilitySnapshot: {
            ...rotated,
            actions: rotated.actions.map((action) => ({ ...action, description: "TAMPERED MODEL CONTRACT" })),
          },
        };
      },
    };
    const descriptionClient = new FakeRealtimeClient({
      onTurn(fake) {
        fake.emit(event("tool.calls", {
          responseId: "tampered-description",
          calls: [gatewayCall("tampered-description-call", "lookup_value", { key: "primary" })],
        }));
        fake.emit(event("response.completed", { responseId: "tampered-description", status: "completed" }));
      },
    });
    const descriptionBudget = budget("tampered-description");
    const descriptionResult = await runBenchmarkTrial({
      runId: "tampered-description",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(descriptionClient, { condition: progressiveCondition, kernel: descriptionKernel }),
      callerTurns,
      pairedAudio,
      limits,
      budget: descriptionBudget.value,
    });
    expect(descriptionResult.status).toBe("protocol_error");
    expect(descriptionClient.resultBatches).toHaveLength(0);
  });

  it("fails closed when connect resolves without a normalized session acknowledgement", async () => {
    const client = new FakeRealtimeClient({
      onConnect(fake) {
        fake.resolveReadyWithoutAcknowledgement();
      },
    });
    const trialBudget = budget("missing-ack");
    const result = await runBenchmarkTrial({
      runId: "missing-ack",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(client),
      callerTurns,
      pairedAudio,
      limits,
      budget: trialBudget.value,
    });

    expect(result.status).toBe("protocol_error");
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "missing_session_ack", phase: "connect" }));
    expect(result.counters.turnsSent).toBe(0);
    expect(client.turns).toHaveLength(0);
    expect(verifyEventChain(result.artifacts.events).valid).toBe(true);
  });

  it("preserves provider errors and response timeouts without reconnecting or replaying caller audio", async () => {
    const providerClient = new FakeRealtimeClient({
      onTurn(fake) {
        fake.emit(event("error", {
          message: "quota lane unavailable",
          code: "provider-quota",
          fatal: true,
          details: { request_id: "req-17" },
        }));
      },
    });
    const providerBudget = budget("provider-error");
    const providerResult = await runBenchmarkTrial({
      runId: "provider-error",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(providerClient),
      callerTurns,
      pairedAudio,
      limits,
      budget: providerBudget.value,
    });
    expect(providerResult.status).toBe("provider_error");
    expect(providerResult.errors).toContainEqual(expect.objectContaining({
      message: "quota lane unavailable",
      provider_code: "provider-quota",
      fatal: true,
    }));
    expect(providerClient.connectCalls).toBe(1);
    expect(providerClient.turns).toHaveLength(1);

    const timeoutClient = new FakeRealtimeClient();
    const timeoutBudget = budget("response-timeout");
    const timeoutResult = await runBenchmarkTrial({
      runId: "response-timeout",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(timeoutClient),
      callerTurns,
      pairedAudio,
      limits: { ...limits, responseTimeoutMs: 10 },
      budget: timeoutBudget.value,
    });
    expect(timeoutResult.status).toBe("response_timeout");
    expect(timeoutResult.errors).toContainEqual(expect.objectContaining({ code: "response_timeout" }));
    expect(timeoutClient.connectCalls).toBe(1);
    expect(timeoutClient.turns).toHaveLength(1);
    expect(timeoutResult.counters.retries).toBe(0);
  });

  it("closes the provider on the independent wall-clock deadline even while journal durability is hung", async () => {
    const client = new FakeRealtimeClient();
    const never = new Promise<void>(() => undefined);
    const hangingJournal: TrialJournalSink = {
      append: () => undefined,
      beforeClientCreate: () => undefined,
      onSessionOpened: () => never,
      finalize: () => undefined,
    };
    const trialBudget = budget("hard-wall-clock-kill");
    const unfinishedTrial = runBenchmarkTrial({
      runId: "hard-wall-clock-kill",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(client),
      callerTurns,
      pairedAudio,
      limits: {
        ...limits,
        maxSessionMs: 25,
        sessionReadyTimeoutMs: 10,
        responseTimeoutMs: 10,
      },
      budget: trialBudget.value,
      journal: hangingJournal,
    });
    // The run itself intentionally remains blocked on the simulated fsync.
    // The assertion is that provider billing cannot remain open with it.
    void unfinishedTrial.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(client.closeCalls).toBe(1);
    expect(client.state).toBe("closed");
  });

  it("enforces input, output, tool-call, and monotonic session caps before excess work", async () => {
    const preflightClient = new FakeRealtimeClient();
    const preflightBudget = budget("input-cap");
    await expect(runBenchmarkTrial({
      runId: "input-cap",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(preflightClient),
      callerTurns,
      pairedAudio,
      limits: { ...limits, maxInputAudioBytes: 4 },
      budget: preflightBudget.value,
    })).rejects.toThrow(/input cap/);
    expect(preflightClient.connectCalls).toBe(0);
    expect(preflightBudget.persisted).toHaveLength(0);

    const outputClient = new FakeRealtimeClient({
      onTurn(fake) {
        fake.emit(event("output.audio", {
          responseId: "too-large",
          audio: Uint8Array.from([1, 0, 2, 0, 3, 0]),
          format: AUDIO_FORMAT,
        }));
        fake.emit(event("response.completed", { responseId: "too-large", status: "completed" }));
      },
    });
    const outputBudget = budget("output-cap");
    const outputResult = await runBenchmarkTrial({
      runId: "output-cap",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(outputClient),
      callerTurns,
      pairedAudio,
      limits: { ...limits, maxOutputAudioBytes: 4 },
      budget: outputBudget.value,
    });
    expect(outputResult.status).toBe("cap_exceeded");
    expect(outputResult.errors).toContainEqual(expect.objectContaining({ code: "output_audio_cap_exceeded" }));
    expect(outputResult.counters.outputAudioBytes).toBe(0);

    const toolClient = new FakeRealtimeClient({
      onTurn(fake) {
        fake.emit(event("tool.calls", {
          responseId: "too-many-tools",
          calls: [
            validCall("tool-1", "lookup_value", { key: "primary" }),
            validCall("tool-2", "lookup_value", { key: "primary" }),
            validCall("tool-3", "lookup_value", { key: "primary" }),
          ],
        }));
      },
    });
    const toolBudget = budget("tool-cap");
    const toolResult = await runBenchmarkTrial({
      runId: "tool-cap",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(toolClient),
      callerTurns,
      pairedAudio,
      limits: { ...limits, maxToolCalls: 2 },
      budget: toolBudget.value,
    });
    expect(toolResult.status).toBe("cap_exceeded");
    expect(toolResult.world.receipts).toHaveLength(0);
    expect(toolClient.resultBatches).toHaveLength(0);

    let monotonicMs = 0;
    const sessionClient = new FakeRealtimeClient({
      onTurn() {
        monotonicMs = 60;
      },
    });
    const sessionBudget = budget("session-cap");
    const sessionResult = await runBenchmarkTrial({
      runId: "session-cap",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(sessionClient),
      callerTurns,
      pairedAudio,
      limits: { ...limits, maxSessionMs: 50, sessionReadyTimeoutMs: 25 },
      budget: sessionBudget.value,
      clock: {
        monotonicNowMs: () => monotonicMs,
        wallTimeIso: () => "2026-07-10T12:00:00.000Z",
      },
    });
    expect(sessionResult.status).toBe("session_timeout");
    expect(sessionResult.errors).toContainEqual(expect.objectContaining({ code: "session_timeout" }));
    expect(sessionClient.turns).toHaveLength(1);
  });

  it.each([16_000, 24_000] as const)(
    "packetizes and paces native %i Hz PCM with no final sleep",
    async (sampleRateHz) => {
      let monotonicMs = 0;
      const sleeps: number[] = [];
      const turns = pacedCallerTurns(sampleRateHz);
      const pair = createPairedAudioManifest({
        pairId: `paced-${sampleRateHz}`,
        scenario,
        callerTurns: turns,
        audioDeliveryProfile: PACED_PROFILE,
      });
      const client = new FakeRealtimeClient({
        onTurn(fake) {
          fake.emit(event("response.completed", { responseId: `paced-${sampleRateHz}`, status: "completed" }));
        },
      });
      const trialBudget = budget(`paced-${sampleRateHz}`);
      const result = await runBenchmarkTrial({
        runId: `paced-${sampleRateHz}`,
        model: "fake-realtime-model",
        scenario,
        ...runtimeBindings(client),
        callerTurns: turns,
        pairedAudio: pair,
        limits,
        budget: trialBudget.value,
        audioDeliveryProfile: PACED_PROFILE,
        sleep(durationMs) {
          sleeps.push(durationMs);
          monotonicMs += durationMs;
        },
        clock: {
          monotonicNowMs: () => monotonicMs,
          wallTimeIso: () => "2026-07-10T12:00:00.000Z",
        },
      });

      expect(result.status).toBe("completed");
      expect(client.appendedChunks).toHaveLength(3);
      expect(client.appendedChunks.map((chunk) => chunk.data.byteLength)).toEqual([
        sampleRateHz * 20 / 1_000 * 2,
        sampleRateHz * 20 / 1_000 * 2,
        sampleRateHz * 20 / 1_000 * 2,
      ]);
      expect(sleeps).toEqual([20, 20]);
      expect(client.commitCalls).toBe(1);
      expect(client.createResponseCalls).toBe(1);
      expect(result.audioDelivery.deliveries.map((delivery) => delivery.session_offset_ms)).toEqual([0, 20, 40]);
      expect(result.audioDelivery.deliveries.map((delivery) => delivery.sha256)).toEqual(pair.turns[0].chunk_hashes);
      expect(result.artifacts.files.map((file) => file.path)).toContain("audio/delivery.json");
    }
  );

  it("aborts pacing before the next chunk and checks the input cap before the first byte", async () => {
    const turns = pacedCallerTurns(24_000);
    const pair = createPairedAudioManifest({
      pairId: "pacing-failure",
      scenario,
      callerTurns: turns,
      audioDeliveryProfile: PACED_PROFILE,
    });
    const pacingClient = new FakeRealtimeClient();
    const pacingBudget = budget("pacing-failure");
    const pacingResult = await runBenchmarkTrial({
      runId: "pacing-failure",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(pacingClient),
      callerTurns: turns,
      pairedAudio: pair,
      limits,
      budget: pacingBudget.value,
      audioDeliveryProfile: PACED_PROFILE,
      sleep: () => { throw new Error("pacer unavailable"); },
    });
    expect(pacingResult.status).toBe("protocol_error");
    expect(pacingResult.errors).toContainEqual(expect.objectContaining({ code: "audio_pacing_failed" }));
    expect(pacingClient.appendedChunks).toHaveLength(1);
    expect(pacingClient.commitCalls).toBe(0);

    const cappedClient = new FakeRealtimeClient();
    const cappedBudget = budget("paced-cap");
    await expect(runBenchmarkTrial({
      runId: "paced-cap",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(cappedClient),
      callerTurns: turns,
      pairedAudio: pair,
      limits: { ...limits, maxInputAudioBytes: 100 },
      budget: cappedBudget.value,
      audioDeliveryProfile: PACED_PROFILE,
    })).rejects.toThrow(/input cap/);
    expect(cappedClient.appendedChunks).toHaveLength(0);
    expect(cappedClient.connectCalls).toBe(0);
  });

  it("opens and backpressures a redacted journal before client/session actions", async () => {
    const secret = "sk-super-secret-value";
    const resumeHandle = "resume-handle-sensitive";
    const journal = new CollectingJournal();
    const client = new FakeRealtimeClient({
      onConnect(fake) {
        fake.wire({
          type: "session.resumption",
          authorization: `Bearer ${secret}`,
          handle: resumeHandle,
          sessionResumption: { handle: resumeHandle },
          url: `wss://provider.example/live?key=${encodeURIComponent(secret)}`,
          encoded: Buffer.from(secret).toString("base64"),
        });
      },
      onTurn(fake) {
        fake.emit(event("response.completed", { responseId: "journal-response", status: "completed" }));
      },
    });
    const trialBudget = budget("journal-redaction");
    const result = await runBenchmarkTrial({
      runId: "journal-redaction",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(client),
      callerTurns,
      pairedAudio,
      limits,
      budget: trialBudget.value,
      journal,
      journalSecretValues: [secret],
    });

    expect(result.status).toBe("completed");
    expect(journal.clientIntents).toHaveLength(1);
    expect(journal.opened).toHaveLength(1);
    expect(journal.finalizations).toHaveLength(1);
    expect(journal.order.indexOf("beforeClientCreate")).toBeLessThan(journal.order.indexOf("onSessionOpened"));
    expect(journal.order.at(-1)).toBe("finalize");
    const serialized = JSON.stringify({
      appended: journal.appended,
      intents: journal.clientIntents,
      opened: journal.opened,
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(encodeURIComponent(secret));
    expect(serialized).not.toContain(Buffer.from(secret).toString("base64"));
    expect(serialized).not.toContain(resumeHandle);
    expect(serialized).not.toContain("grant.lookup_value");
    expect(serialized).toContain("[REDACTED]");
  });

  it("fails closed before connect or the next audio chunk when journal durability fails", async () => {
    const beforeJournal = new CollectingJournal((phase) => phase === "beforeClientCreate");
    const beforeClient = new FakeRealtimeClient();
    let factoryCalls = 0;
    const beforeBudget = budget("journal-before-failure");
    await expect(runBenchmarkTrial({
      runId: "journal-before-failure",
      provider: "openai",
      model: "fake-realtime-model",
      scenario,
      condition: conditionFor(),
      gatewayKernel: new DirectGatewayKernel(),
      kernelAttestationExpectation: TEST_ATTESTATION_EXPECTATION,
      pairInvariantsHash: TEST_PAIR_INVARIANTS_HASH,
      studyPlanHash: TEST_STUDY_PLAN_HASH,
      createClient() {
        factoryCalls += 1;
        return beforeClient;
      },
      callerTurns,
      pairedAudio,
      limits,
      budget: beforeBudget.value,
      journal: beforeJournal,
    })).rejects.toThrow(/connection intent failed/);
    expect(factoryCalls).toBe(0);
    expect(beforeClient.connectCalls).toBe(0);

    const pacedTurns = pacedCallerTurns(24_000);
    const pacedPair = createPairedAudioManifest({
      pairId: "journal-mid-failure",
      scenario,
      callerTurns: pacedTurns,
      audioDeliveryProfile: PACED_PROFILE,
    });
    const midJournal = new CollectingJournal(
      (phase, record) => phase === "append" && record.event_type === "caller.audio_chunk_delivered"
    );
    const midClient = new FakeRealtimeClient();
    const midBudget = budget("journal-mid-failure");
    await expect(runBenchmarkTrial({
      runId: "journal-mid-failure",
      model: "fake-realtime-model",
      scenario,
      ...runtimeBindings(midClient),
      callerTurns: pacedTurns,
      pairedAudio: pacedPair,
      limits,
      budget: midBudget.value,
      audioDeliveryProfile: PACED_PROFILE,
      sleep: () => { throw new Error("sleep must not run after journal failure"); },
      journal: midJournal,
    })).rejects.toThrow(/journal append failed/i);
    expect(midClient.connectCalls).toBe(1);
    expect(midClient.appendedChunks).toHaveLength(1);
    expect(midClient.commitCalls).toBe(0);
    expect(midBudget.persisted.at(-1)?.reservations[0]?.status).toBe("active");
  });
});

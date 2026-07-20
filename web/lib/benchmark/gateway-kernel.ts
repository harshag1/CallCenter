import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  deriveFlowActionInvocationId,
  enterFlowStep,
  flowCapabilityScope,
  flowStateSummary,
  markFlowActionDispatchStarted,
  reserveFlowAction,
  selectFlowTopic,
  settleFlowAction,
  completeFlowStep,
  createFlowExecutionState,
  type FlowExecutionState,
  type RuntimeError,
} from "../flow-runtime";
import {
  findStep,
  topicEntryStepPaths,
  type AgentFlow,
} from "../flow";
import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import {
  CAPABILITY_GATEWAY_VERSION,
  ProviderCapabilitySnapshotSchema,
  type CapabilityGatewayResult,
  type ProviderCapabilitySnapshot,
} from "./capability-gateway";
import {
  assertCompiledConditionIntegrity,
  benchmarkFlowHash,
  benchmarkScenarioHash,
  type BenchmarkConditionId,
  type CompiledBenchmarkCondition,
  type CompiledCapability,
  type CompiledDisclosure,
} from "./condition-compiler";
import {
  createBenchmarkKernelCapabilityHead,
  createBenchmarkKernelFinalAttestation,
  type BenchmarkKernelAttestationSigner,
  type BenchmarkKernelCapabilityHead,
  type BenchmarkKernelEvidenceBinding,
  type BenchmarkKernelFinalAttestation,
} from "./kernel-attestation";
import {
  appendKernelTranscriptInvocation,
  assertKernelTranscriptDurableMemoryState,
  assertKernelTranscriptContainsNoRawGrants,
  createKernelTranscript,
  encodeKernelTranscript,
  kernelTranscriptReference,
  publicKernelTranscript,
  type KernelTranscript,
  type KernelTranscriptLimits,
  type KernelTranscriptReference,
  type PublicKernelTranscript,
} from "./kernel-transcript";
import { JsonValueSchema, type BenchmarkScenario, type JsonValue } from "./scenario-schema";
import type {
  BenchmarkGatewayInvocation,
  BenchmarkGatewayKernel,
  BenchmarkGatewayOutcome,
} from "./orchestrator";
import {
  createToolWorld,
  parseBoundToolWorldState,
  scenarioContentHash,
  type ToolExecution,
  type ToolWorldState,
} from "./tool-world";

const FLOW_CONTROL_ACTIONS = new Set([
  "flow.select_topic",
  "flow.enter_step",
  "flow.complete_step",
  "flow.get_state",
]);
const DURABLE_MEMORY_ACTION = "durable_memory";
const OPAQUE_GRANT_DOMAIN = "harshas-amazing-call-center/benchmark-opaque-capability/v1";
const TRANSCRIPT_SECRET_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-transcript-secret/v1";
const SAFE_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

type Clock = Readonly<{
  nowMs(): number;
  nowIso(): string;
}>;

export type BenchmarkGatewayKernelOptions = Readonly<{
  flow: AgentFlow;
  expectedFlowHash: string;
  expectedScenarioHash: string;
  /** Exact compiler-produced arm selected by the immutable execution plan. */
  expectedConditionHash: string;
  /** Treatment-blind compiler source digest shared by every arm in the pair. */
  grantBindingHash: string;
  /** Opaque pair subject shared by paired arms; must not encode a condition ID. */
  leaseSubjectId: string;
  /** Immutable paid/offline run evidence identity embedded in the signed final proof. */
  evidenceBinding: BenchmarkKernelEvidenceBinding;
  /** Plan-pinned Ed25519 signer. The private key never enters provider-visible state. */
  signer: BenchmarkKernelAttestationSigner;
  /** A private per-run key. It is never returned or included in artifacts. */
  capabilitySecret?: string;
  /** Optional stricter live recorder bounds, primarily for constrained deployments and failure testing. */
  transcriptLimits?: KernelTranscriptLimits;
  /** Must cover the declared session cap; defaults to the one-hour signer maximum. */
  leaseTtlSeconds?: number;
  clock?: Clock;
}>;

type CapabilityTarget = "$base" | CompiledDisclosure["target"];

type LooseState = {
  capabilityEpoch: number;
  target: CapabilityTarget;
  selectedTopic: string | null;
  currentStep: string | null;
  completedSteps: Set<string>;
  outputs: Record<string, JsonValue>;
};

type KernelRun = {
  runId: string;
  condition: CompiledBenchmarkCondition;
  scenarioId: string;
  scenarioVersion: string;
  scenario: BenchmarkScenario;
  world: ToolWorldState;
  worldScenarioHash: string;
  worldHeadHash: string;
  flowState: FlowExecutionState | null;
  loose: LooseState;
  memory: Map<string, JsonValue>;
  providerCalls: Map<string, Readonly<{
    fingerprint: string;
    outcome: BenchmarkGatewayOutcome;
  }>>;
  grants: Map<string, Readonly<{
    action: string;
    recovery: boolean;
    capabilityEpoch: number;
    scope: string;
    issuedAtMs: number;
    expiresAtMs: number;
  }>>;
  target: CapabilityTarget;
  catalogMode: "target" | "post_step_transition" | "terminal";
  /** Exact latest catalog and scope emitted to the provider, without private grants. */
  lastSnapshot: ProviderCapabilitySnapshot | null;
  transcript: KernelTranscript | null;
  transcriptSecret: string;
};

function defaultClock(): Clock {
  return Object.freeze({
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  });
}

function cloneDurableMemory(
  input: ReadonlyMap<string, JsonValue>
): Map<string, JsonValue> {
  return new Map([...input.entries()].map(([key, value]) => [
    key,
    structuredClone(value),
  ]));
}

function asJson(value: unknown): JsonValue {
  // Flow state and tool-world results are JSON-shaped. The round trip removes
  // optional `undefined` fields before the strict artifact schema sees them.
  return JsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
}

function record(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}

function hasOnlyKeys(value: Readonly<Record<string, JsonValue>>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function looseSuccessfulNextSteps(
  path: string,
  step: NonNullable<ReturnType<typeof findStep>>["step"],
  outputs: Readonly<Record<string, JsonValue>>
): string[] {
  const transitions = (step.transitions ?? []).filter((transition) => {
    const condition = transition.condition;
    if (!condition) return true;
    const actual = outputs[condition.output];
    if (condition.operator === "exists") return actual !== undefined && actual !== null;
    if (condition.operator === "equals") return Object.is(actual, condition.value);
    if (condition.operator === "not_equals") return !Object.is(actual, condition.value);
    return Array.isArray(condition.value)
      && condition.value.some((candidate) => Object.is(actual, candidate));
  }).map((transition) => transition.to);
  return [...new Set([
    ...(step.steps ?? []).map((child) => `${path}.${child.id}`),
    ...transitions,
  ])];
}

function failure(
  code: string,
  message: string,
  action?: string,
  retriable = false,
  epoch?: number
): Extract<CapabilityGatewayResult, { ok: false }> {
  return Object.freeze({
    ok: false as const,
    gateway_version: CAPABILITY_GATEWAY_VERSION,
    ...(action ? { action } : {}),
    code,
    message,
    retriable,
    ...(epoch === undefined ? {} : { current_capability_epoch: epoch }),
  });
}

function success(
  action: string,
  receiptId: string,
  authoritativeResult: JsonValue,
  disposition: "executed" | "replayed" | "deduplicated" | "verified" = "executed"
): Extract<CapabilityGatewayResult, { ok: true }> {
  return Object.freeze({
    ok: true as const,
    gateway_version: CAPABILITY_GATEWAY_VERSION,
    action,
    receipt_id: receiptId,
    disposition,
    authoritative_result: authoritativeResult,
  });
}

function runtimeFailure(error: RuntimeError, action: string, epoch: number): CapabilityGatewayResult {
  return failure(error.code, error.error, action, false, epoch);
}

function visibleError(
  execution: ToolExecution,
  action: string,
  epoch?: number
): Extract<CapabilityGatewayResult, { ok: false }> {
  const visible = record(asJson(execution.visible_result));
  const error = visible ? record(visible.error) : null;
  return failure(
    typeof error?.code === "string" ? error.code : "tool_failed",
    typeof error?.message === "string" ? error.message : `Action ${action} did not complete successfully`,
    action,
    error?.retriable === true,
    epoch
  );
}

function allCapabilities(condition: CompiledBenchmarkCondition): CompiledCapability[] {
  const byName = new Map<string, CompiledCapability>();
  for (const capability of condition.visibleCapabilities) byName.set(capability.name, capability);
  for (const disclosure of condition.disclosures) {
    for (const capability of disclosure.visibleCapabilities) byName.set(capability.name, capability);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function worldStateHash(world: ToolWorldState): string {
  return sha256Hex(`harshas-amazing-call-center/benchmark-world-head/v1\n${canonicalJson(world)}`);
}

/**
 * The concrete benchmark treatment kernel deliberately reuses the production
 * Flow v2 state machine for state-only/full-harness/oracle arms. Raw and
 * progressive-only arms take separate, visibly weaker paths so an ablation
 * cannot accidentally inherit receipt or transition enforcement.
 */
export class InMemoryBenchmarkGatewayKernel implements BenchmarkGatewayKernel {
  readonly #flow: AgentFlow;
  readonly #secret: string;
  readonly #clock: Clock;
  readonly #expectedScenarioHash: string;
  readonly #expectedConditionHash: string;
  readonly #leaseTtlSeconds: number;
  readonly #grantBindingHash: string;
  readonly #leaseSubjectId: string;
  readonly #evidenceBinding: BenchmarkKernelEvidenceBinding;
  readonly #signer: BenchmarkKernelAttestationSigner;
  readonly #transcriptLimits: KernelTranscriptLimits | undefined;
  #run: KernelRun | null = null;

  constructor(options: BenchmarkGatewayKernelOptions) {
    this.#flow = structuredClone(options.flow);
    if (benchmarkFlowHash(this.#flow) !== options.expectedFlowHash) {
      throw new Error("benchmark gateway flow does not match the compiled suite flow hash");
    }
    if (!/^[a-f0-9]{64}$/.test(options.expectedScenarioHash)) {
      throw new Error("benchmark gateway expectedScenarioHash must be a SHA-256 digest");
    }
    this.#expectedScenarioHash = options.expectedScenarioHash;
    if (!/^[a-f0-9]{64}$/.test(options.expectedConditionHash)) {
      throw new Error("benchmark expectedConditionHash must be a SHA-256 digest");
    }
    this.#expectedConditionHash = options.expectedConditionHash;
    if (!/^[a-f0-9]{64}$/.test(options.grantBindingHash)) {
      throw new Error("benchmark grantBindingHash must be a SHA-256 digest");
    }
    if (!SAFE_OPAQUE_ID.test(options.leaseSubjectId)) {
      throw new Error("benchmark leaseSubjectId must be an opaque safe identifier");
    }
    this.#grantBindingHash = options.grantBindingHash;
    this.#leaseSubjectId = options.leaseSubjectId;
    const evidenceBinding = options.evidenceBinding;
    if (!evidenceBinding || typeof evidenceBinding !== "object") {
      throw new Error("kernel evidence binding is required");
    }
    if (evidenceBinding.leaseSubjectId !== options.leaseSubjectId) {
      throw new Error("kernel evidence leaseSubjectId must match the capability lease subject");
    }
    if (
      typeof evidenceBinding.pairId !== "string"
      || !SAFE_OPAQUE_ID.test(evidenceBinding.pairId)
    ) {
      throw new Error("kernel evidence pairId must be an opaque safe identifier");
    }
    if (!(["openai", "xai", "gemini", "offline"] as readonly unknown[]).includes(evidenceBinding.provider)) {
      throw new Error("kernel evidence provider is unsupported");
    }
    if (
      typeof evidenceBinding.model !== "string"
      || !evidenceBinding.model.trim()
      || evidenceBinding.model.length > 256
      || evidenceBinding.model.includes("\0")
    ) {
      throw new Error("kernel evidence model must be a non-empty safe string");
    }
    for (const [label, digest] of Object.entries({
      planSha256: evidenceBinding.planSha256,
      freezeLockSha256: evidenceBinding.freezeLockSha256,
      kernelBuildSha256: evidenceBinding.kernelBuildSha256,
    })) {
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
        throw new Error(`kernel evidence ${label} must be a SHA-256 digest`);
      }
    }
    const signer = options.signer;
    if (
      !signer
      || typeof signer !== "object"
      || signer.algorithm !== "ed25519"
      || typeof signer.keyId !== "string"
      || !SAFE_OPAQUE_ID.test(signer.keyId)
      || typeof signer.publicKeySha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(signer.publicKeySha256)
      || typeof signer.sign !== "function"
    ) {
      throw new Error("kernel attestation signer must be a valid Ed25519 signing identity");
    }
    this.#evidenceBinding = immutableJson(evidenceBinding) as unknown as BenchmarkKernelEvidenceBinding;
    this.#signer = Object.freeze({
      algorithm: signer.algorithm,
      keyId: signer.keyId,
      publicKeySha256: signer.publicKeySha256,
      sign: signer.sign.bind(signer),
    });
    this.#leaseTtlSeconds = options.leaseTtlSeconds ?? 60 * 60;
    if (!Number.isInteger(this.#leaseTtlSeconds) || this.#leaseTtlSeconds < 1 || this.#leaseTtlSeconds > 60 * 60) {
      throw new Error("benchmark leaseTtlSeconds must be between 1 and 3600");
    }
    this.#secret = options.capabilitySecret ?? randomBytes(32).toString("hex");
    if (this.#secret.length < 32) throw new Error("benchmark capability secret must be at least 32 characters");
    this.#clock = options.clock ?? defaultClock();
    this.#transcriptLimits = options.transcriptLimits
      ? Object.freeze({ ...options.transcriptLimits })
      : undefined;
  }

  initialize(input: Readonly<{
    runId: string;
    condition: CompiledBenchmarkCondition;
    scenario: BenchmarkScenario;
    world: unknown;
  }>): ProviderCapabilitySnapshot {
    if (this.#run) throw new Error("benchmark gateway initialization is single-use; resume requires a new manifest-bound API");
    if (!SAFE_OPAQUE_ID.test(input.runId)) {
      throw new Error("benchmark gateway runId must be an opaque safe identifier");
    }
    assertCompiledConditionIntegrity(input.condition);
    if (input.condition.conditionHash !== this.#expectedConditionHash) {
      throw new Error("benchmark gateway condition does not match the execution plan condition hash");
    }
    if (
      input.condition.sourceHash !== this.#grantBindingHash
      || input.condition.scenarioHash !== this.#expectedScenarioHash
      || input.condition.flowHash !== benchmarkFlowHash(this.#flow)
    ) {
      throw new Error("benchmark gateway condition is not bound to the configured source, scenario, and flow");
    }
    if (benchmarkScenarioHash(input.scenario) !== this.#expectedScenarioHash) {
      throw new Error("benchmark gateway scenario does not match the compiled suite scenario hash");
    }
    const scenario = immutableJson(input.scenario) as unknown as BenchmarkScenario;
    const world = parseBoundToolWorldState(scenario, input.world);
    const worldScenarioHash = scenarioContentHash(input.scenario);
    if (world.scenario_hash !== worldScenarioHash) {
      throw new Error("benchmark gateway world does not match the initialized scenario content hash");
    }
    if (canonicalJson(world) !== canonicalJson(createToolWorld(scenario))) {
      throw new Error("benchmark gateway must initialize from the canonical empty ToolWorld ledger");
    }
    const pinnedCondition = immutableJson(input.condition) as unknown as CompiledBenchmarkCondition;
    const flowState = input.condition.behavior.durableFlowState
      ? createFlowExecutionState(this.#clock.nowIso())
      : null;
    const run: KernelRun = {
      runId: input.runId,
      condition: pinnedCondition,
      scenarioId: input.scenario.id,
      scenarioVersion: input.scenario.version,
      scenario,
      world,
      worldScenarioHash,
      worldHeadHash: worldStateHash(world),
      flowState,
      loose: {
        capabilityEpoch: 0,
        target: "$base",
        selectedTopic: null,
        currentStep: null,
        completedSteps: new Set(),
        outputs: {},
      },
      memory: new Map(),
      providerCalls: new Map(),
      grants: new Map(),
      target: "$base",
      catalogMode: "target",
      lastSnapshot: null,
      transcript: null,
      transcriptSecret: createHmac("sha256", this.#secret)
        .update(TRANSCRIPT_SECRET_DOMAIN)
        .update("\0")
        .update(canonicalJson({
          run_id: input.runId,
          condition_hash: pinnedCondition.conditionHash,
          lease_subject_id: this.#leaseSubjectId,
        }))
        .digest("hex"),
    };
    const snapshot = this.#snapshot(run, pinnedCondition.visibleCapabilities);
    run.transcript = createKernelTranscript({
      runId: run.runId,
      condition: run.condition,
      scenario: run.scenario,
      world: run.world,
      flowState: run.flowState,
      capabilityHead: this.#capabilityHead(run),
      providerVisibleCapabilitySnapshot: snapshot,
      dataClassification: "synthetic_benchmark_only",
      sensitiveValueSecret: run.transcriptSecret,
      durableMemoryState: run.condition.behavior.genericDurableMemory ? run.memory : null,
      ...(this.#transcriptLimits ? { limits: this.#transcriptLimits } : {}),
    });
    this.#run = run;
    return snapshot;
  }

  /** Deeply immutable, grant-free replay material for artifact persistence. */
  transcript(): PublicKernelTranscript {
    const run = this.#run;
    if (!run?.transcript) throw new Error("benchmark gateway transcript is unavailable before initialization");
    assertKernelTranscriptDurableMemoryState(
      run.transcript,
      run.condition.behavior.genericDurableMemory ? run.memory : null
    );
    const encoded = encodeKernelTranscript(run.transcript);
    this.#assertPublicTranscript(run, encoded);
    return publicKernelTranscript(run.transcript);
  }

  /** Canonical JSONL bytes whose digest is bound into the final attestation. */
  encodedTranscript(): string {
    const run = this.#run;
    if (!run?.transcript) throw new Error("benchmark gateway transcript is unavailable before initialization");
    assertKernelTranscriptDurableMemoryState(
      run.transcript,
      run.condition.behavior.genericDurableMemory ? run.memory : null
    );
    const encoded = encodeKernelTranscript(run.transcript);
    this.#assertPublicTranscript(run, encoded);
    return encoded;
  }

  /** Exact public reference signed by attestFinal. */
  transcriptReference(): KernelTranscriptReference {
    const run = this.#run;
    if (!run?.transcript) throw new Error("benchmark gateway transcript is unavailable before initialization");
    assertKernelTranscriptDurableMemoryState(
      run.transcript,
      run.condition.behavior.genericDurableMemory ? run.memory : null
    );
    // Derive the reference from the same private recorder whose canonical
    // public view is returned by transcript()/encodedTranscript().
    this.#assertPublicTranscript(run, encodeKernelTranscript(run.transcript));
    return kernelTranscriptReference(run.transcript);
  }

  #assertPublicTranscript(run: KernelRun, encoded: string): void {
    assertKernelTranscriptContainsNoRawGrants(encoded, [...run.grants.keys()]);
    if (encoded.includes(this.#secret) || encoded.includes(run.transcriptSecret)) {
      throw new Error("kernel transcript contains private key material");
    }
  }

  attestFinal(input: Readonly<{
    runId: string;
    condition: CompiledBenchmarkCondition;
    scenario: BenchmarkScenario;
    world: ToolWorldState;
  }>): BenchmarkKernelFinalAttestation {
    const run = this.#requireRun(input.condition);
    if (input.runId !== run.runId) {
      throw new Error("kernel attestation runId differs from the initialized run");
    }
    if (canonicalJson(input.scenario) !== canonicalJson(run.scenario)) {
      throw new Error("kernel attestation scenario differs from the initialized scenario");
    }
    const world = parseBoundToolWorldState(run.scenario, input.world);
    if (canonicalJson(world) !== canonicalJson(input.world)) {
      throw new Error("kernel attestation world contains missing, defaulted, or unsupported fields");
    }
    if (
      worldStateHash(world) !== run.worldHeadHash
      || canonicalJson(world) !== canonicalJson(run.world)
    ) {
      throw new Error("kernel attestation world differs from the authoritative final world head");
    }
    const capabilityHead = this.#capabilityHead(run);
    if (!run.transcript) throw new Error("kernel attestation transcript is unavailable");
    assertKernelTranscriptDurableMemoryState(
      run.transcript,
      run.condition.behavior.genericDurableMemory ? run.memory : null
    );
    const transcriptReference = this.transcriptReference();

    return createBenchmarkKernelFinalAttestation({
      runId: run.runId,
      condition: run.condition,
      scenario: run.scenario,
      world,
      capabilityHead,
      flowState: run.flowState,
      evidenceBinding: this.#evidenceBinding,
      signer: this.#signer,
      transcriptReference,
    });
  }

  #capabilityHead(run: KernelRun): BenchmarkKernelCapabilityHead {
    const snapshot = run.lastSnapshot;
    if (!snapshot) throw new Error("kernel capability head requires a provider-visible snapshot");
    const target = run.condition.behavior.progressiveDisclosure
      ? run.target
      : "$full-catalog";
    const capabilityHead = createBenchmarkKernelCapabilityHead({
      condition: run.condition,
      epoch: this.#epoch(run),
      target,
      catalogMode: run.catalogMode,
      internalFlowScope: run.flowState ? flowCapabilityScope(run.flowState).step : null,
    });
    const visibleCatalog = snapshot.actions
      .map((action) => ({ name: action.name, semantic_hash: action.semantic_hash }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (
      snapshot.capability_epoch !== capabilityHead.epoch
      || snapshot.scope !== capabilityHead.provider_grant_scope
      || canonicalJson(visibleCatalog) !== canonicalJson(capabilityHead.catalog)
    ) {
      throw new Error("kernel capability head differs from the last provider-visible snapshot");
    }
    return capabilityHead;
  }

  invoke(input: BenchmarkGatewayInvocation): BenchmarkGatewayOutcome {
    const run = this.#requireRun(input.condition);
    if (!SAFE_OPAQUE_ID.test(input.providerCallId)) {
      throw new Error("gateway providerCallId must be an opaque safe identifier");
    }
    if (!Number.isSafeInteger(input.turn) || input.turn < 0) {
      throw new Error("gateway invocation turn must be a non-negative safe integer");
    }
    const inputWorld = parseBoundToolWorldState(run.scenario, input.world);
    if (
      worldStateHash(inputWorld) !== run.worldHeadHash
      || canonicalJson(inputWorld) !== canonicalJson(run.world)
    ) {
      throw new Error("gateway invocation world does not match the authoritative prior world head");
    }
    const preFlowState = run.flowState ? structuredClone(run.flowState) : null;
    const preDurableMemoryState = run.condition.behavior.genericDurableMemory
      ? cloneDurableMemory(run.memory)
      : null;
    const preCapabilityHead = this.#capabilityHead(run);
    const boundInput: BenchmarkGatewayInvocation = Object.freeze({
      ...input,
      world: inputWorld,
      executeLeaf: (request) => {
        const execution = input.executeLeaf(request);
        const nextWorld = parseBoundToolWorldState(run.scenario, execution.state);
        this.#assertMonotonicWorldExtension(
          inputWorld,
          nextWorld,
          execution,
          request.action,
          request.arguments
        );
        run.worldHeadHash = worldStateHash(nextWorld);
        run.world = nextWorld;
        return { ...execution, state: nextWorld };
      },
    });
    const { action } = input.call;
    const fingerprint = sha256Hex(canonicalJson({
      action,
      arguments: input.call.arguments,
    }));
    const priorCall = run.providerCalls.get(input.providerCallId);
    if (priorCall) {
      if (priorCall.fingerprint !== fingerprint) {
        const outcome: BenchmarkGatewayOutcome = {
          result: failure(
            "provider_call_id_conflict",
            "Provider call ID was reused with different action content",
            action,
            false,
            this.#epoch(run)
          ),
        };
        this.#recordInvocation(
          run,
          input,
          inputWorld,
          preFlowState,
          preDurableMemoryState,
          preCapabilityHead,
          outcome
        );
        return outcome;
      }
      const replayedResult = priorCall.outcome.result.ok
        ? { ...priorCall.outcome.result, disposition: "replayed" as const }
        : priorCall.outcome.result;
      const outcome: BenchmarkGatewayOutcome = {
        result: replayedResult,
        ...(priorCall.outcome.providerVisibleOutput === undefined
          ? {}
          : { providerVisibleOutput: priorCall.outcome.providerVisibleOutput }),
      };
      this.#recordInvocation(
        run,
        input,
        inputWorld,
        preFlowState,
        preDurableMemoryState,
        preCapabilityHead,
        outcome
      );
      return outcome;
    }
    if (input.capabilityEpoch !== this.#epoch(run)) {
      const outcome: BenchmarkGatewayOutcome = {
        result: failure(
          "capability_epoch_mismatch",
          "Host-bound capability epoch is stale",
          action,
          false,
          this.#epoch(run)
        ),
      };
      this.#recordInvocation(
        run,
        input,
        inputWorld,
        preFlowState,
        preDurableMemoryState,
        preCapabilityHead,
        outcome
      );
      run.providerCalls.set(input.providerCallId, Object.freeze({
        fingerprint,
        outcome: Object.freeze(structuredClone(outcome)),
      }));
      return outcome;
    }
    const condition = run.condition;
    const knownLeaf = condition.semanticLeafTools.some((tool) => tool.name === action);
    const knownControl = FLOW_CONTROL_ACTIONS.has(action);
    const knownMemory = action === DURABLE_MEMORY_ACTION && condition.behavior.genericDurableMemory;
    let outcome: BenchmarkGatewayOutcome | undefined;
    if (!knownLeaf && !knownControl && !knownMemory) {
      outcome = { result: failure("unknown_action", `Unknown logical action ${action}`, action, false, this.#epoch(run)) };
    } else if (condition.behavior.enforceCapabilityGrants) {
      const verified = this.#verifyGrant(run, action, input.call.capability_grant);
      if (verified) outcome = { result: verified };
    }
    try {
      if (!outcome) {
        outcome = knownMemory
          ? this.#memory(run, input.providerCallId, input.call.arguments)
          : knownControl
            ? this.#flowControl(run, input.providerCallId, action, input.call.arguments)
            : condition.behavior.enforceExactlyOnce
              ? this.#enforcedLeaf(run, boundInput)
              : this.#unrestrictedLeaf(run, boundInput);
      }
      // Prepare the replay record before advancing the transcript. Once the
      // append succeeds, publishing the already-cloned entry is the only
      // remaining mutation and cannot observe caller-owned object identity.
      const providerCallRecord = Object.freeze({
        fingerprint,
        outcome: Object.freeze(structuredClone(outcome)),
      });
      this.#recordInvocation(
        run,
        input,
        inputWorld,
        preFlowState,
        preDurableMemoryState,
        preCapabilityHead,
        outcome
      );
      run.providerCalls.set(input.providerCallId, providerCallRecord);
    } catch (error) {
      // Durable memory is fully kernel-local, so a failed evidence append must
      // roll it back. Otherwise the next call or final signature could rely on
      // state that has no transcript entry. Provider-call replay state is not
      // published until after the append succeeds.
      if (knownMemory && preDurableMemoryState) {
        run.memory = cloneDurableMemory(preDurableMemoryState);
      }
      throw error;
    }
    return outcome;
  }

  #recordInvocation(
    run: KernelRun,
    input: BenchmarkGatewayInvocation,
    inputWorld: ToolWorldState,
    preFlowState: FlowExecutionState | null,
    preDurableMemoryState: ReadonlyMap<string, JsonValue> | null,
    preCapabilityHead: BenchmarkKernelCapabilityHead,
    outcome: BenchmarkGatewayOutcome
  ): void {
    if (!run.transcript) throw new Error("benchmark gateway transcript was not initialized");
    run.transcript = appendKernelTranscriptInvocation(run.transcript, {
      invocation: {
        providerCallId: input.providerCallId,
        call: input.call,
        condition: run.condition,
        turn: input.turn,
        world: inputWorld,
      },
      outcome,
      postWorld: run.world,
      preFlowState,
      postFlowState: run.flowState,
      preDurableMemoryState,
      postDurableMemoryState: run.condition.behavior.genericDurableMemory ? run.memory : null,
      preCapabilityHead,
      postCapabilityHead: this.#capabilityHead(run),
      sensitiveValueSecret: run.transcriptSecret,
    });
  }

  #assertMonotonicWorldExtension(
    before: ToolWorldState,
    after: ToolWorldState,
    execution: ToolExecution,
    action: string,
    args: Readonly<Record<string, JsonValue>>
  ): void {
    const prefix = (label: string, prior: readonly unknown[], next: readonly unknown[]) => {
      if (
        next.length < prior.length
        || canonicalJson(next.slice(0, prior.length)) !== canonicalJson(prior)
      ) {
        throw new Error(`gateway leaf execution rewrote the authoritative ${label} ledger`);
      }
    };
    prefix("admission", before.admissions, after.admissions);
    prefix("receipt", before.receipts, after.receipts);
    prefix("effect", before.effects, after.effects);
    prefix("event", before.events, after.events);
    if (after.events.length <= before.events.length) {
      throw new Error("gateway leaf execution did not append an authoritative world event");
    }
    if (after.admissions.length - before.admissions.length > 1) {
      throw new Error("gateway leaf execution appended more than one admission");
    }
    if (after.receipts.length - before.receipts.length > 1) {
      throw new Error("gateway leaf execution appended more than one receipt");
    }
    const receipt = after.receipts.find((candidate) => candidate.receipt_id === execution.receipt.receipt_id);
    if (
      !receipt
      || canonicalJson(receipt) !== canonicalJson(execution.receipt)
      || receipt.tool !== action
      || canonicalJson(receipt.arguments) !== canonicalJson(args)
    ) {
      throw new Error("gateway leaf execution receipt does not match the requested action and bound ledger");
    }
    const keys = new Set([...Object.keys(before.attempts), ...Object.keys(after.attempts)]);
    let attemptDelta = 0;
    for (const key of keys) {
      const delta = (after.attempts[key] ?? 0) - (before.attempts[key] ?? 0);
      if (delta < 0 || (delta > 0 && key !== action)) {
        throw new Error("gateway leaf execution rewrote unrelated attempt counters");
      }
      attemptDelta += delta;
    }
    if (attemptDelta > 1) {
      throw new Error("gateway leaf execution consumed more than one execution attempt");
    }
  }

  #requireRun(condition: CompiledBenchmarkCondition): KernelRun {
    if (!this.#run) throw new Error("benchmark gateway kernel was not initialized");
    assertCompiledConditionIntegrity(condition);
    if (canonicalJson(this.#run.condition) !== canonicalJson(condition)) {
      throw new Error("gateway invocation condition differs from initialized condition");
    }
    return this.#run;
  }

  #epoch(run: KernelRun): number {
    return run.flowState?.capabilityEpoch ?? run.loose.capabilityEpoch;
  }

  #scope(run: KernelRun): string {
    return run.condition.behavior.progressiveDisclosure ? run.target : "$full-catalog";
  }

  #lease(run: KernelRun, action: string): string {
    // Provider-visible grants are fixed-shape MACs. No base64 JSON body can
    // reveal the treatment, internal Flow step/attempt, or condition hash.
    const capabilityEpoch = this.#epoch(run);
    const scope = this.#scope(run);
    const recovery = action === "flow.get_state";
    const subject = canonicalJson({
      v: 1,
      lease_subject_id: this.#leaseSubjectId,
      grant_binding_hash: this.#grantBindingHash,
      ...(recovery ? { recovery: true } : { capability_epoch: capabilityEpoch, scope }),
      action,
    });
    const token = `g1.${createHmac("sha256", this.#secret)
      .update(OPAQUE_GRANT_DOMAIN)
      .update("\n")
      .update(subject)
      .digest("base64url")}`;
    if (!run.grants.has(token)) {
      const issuedAtMs = this.#clock.nowMs();
      run.grants.set(token, Object.freeze({
        action,
        recovery,
        capabilityEpoch,
        scope,
        issuedAtMs,
        expiresAtMs: issuedAtMs + this.#leaseTtlSeconds * 1_000,
      }));
    }
    return token;
  }

  #verifyGrant(run: KernelRun, action: string, token: string): CapabilityGatewayResult | null {
    const grant = [...run.grants.entries()]
      .find(([candidate]) => constantTimeEqual(candidate, token))?.[1];
    if (!grant) {
      return failure("invalid_capability", "Invalid opaque capability", action, false, this.#epoch(run));
    }
    if (grant.expiresAtMs <= this.#clock.nowMs()) {
      return failure("expired_capability", "Opaque capability expired", action, true, this.#epoch(run));
    }
    if (
      grant.action !== action
      || (!grant.recovery && (
        grant.capabilityEpoch !== this.#epoch(run)
        || grant.scope !== this.#scope(run)
      ))
    ) {
      return failure(
        "capability_scope_mismatch",
        "Opaque capability does not match the current action scope",
        action,
        false,
        this.#epoch(run)
      );
    }
    return null;
  }

  #snapshot(run: KernelRun, capabilities: readonly CompiledCapability[]): ProviderCapabilitySnapshot {
    const snapshot = ProviderCapabilitySnapshotSchema.parse({
      gateway_version: CAPABILITY_GATEWAY_VERSION,
      scope: this.#scope(run),
      capability_epoch: this.#epoch(run),
      actions: [...capabilities]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((capability) => ({
          name: capability.name,
          description: capability.description,
          input_schema: capability.inputSchema,
          semantic_hash: capability.semanticHash,
          capability_grant: this.#lease(run, capability.name),
        })),
    });
    run.lastSnapshot = immutableJson(snapshot) as unknown as ProviderCapabilitySnapshot;
    return run.lastSnapshot;
  }

  #capabilitiesForTarget(run: KernelRun): readonly CompiledCapability[] {
    if (!run.condition.behavior.progressiveDisclosure) return run.condition.visibleCapabilities;
    if (run.catalogMode === "terminal") {
      return allCapabilities(run.condition)
        .filter((capability) => capability.name === "flow.get_state");
    }
    if (run.target === "$base") return run.condition.visibleCapabilities;
    const disclosure = run.condition.disclosures.find((candidate) => candidate.target === run.target);
    if (!disclosure) throw new Error(`compiled condition has no disclosure for ${run.target}`);
    return disclosure.visibleCapabilities;
  }

  #rotation(run: KernelRun, target?: CompiledDisclosure["target"]): Pick<BenchmarkGatewayOutcome, "capabilitySnapshot" | "disclosure"> {
    const capabilities = this.#capabilitiesForTarget(run);
    const snapshot = this.#snapshot(run, capabilities);
    if (run.condition.behavior.progressiveDisclosure && target) {
      return { capabilitySnapshot: snapshot, disclosure: { target, snapshot } };
    }
    return { capabilitySnapshot: snapshot };
  }

  #postCompletionRotation(
    run: KernelRun,
    terminal = run.flowState?.status === "completed"
  ): Pick<BenchmarkGatewayOutcome, "capabilitySnapshot"> {
    if (!run.condition.behavior.progressiveDisclosure) {
      run.catalogMode = "target";
      return { capabilitySnapshot: this.#snapshot(run, run.condition.visibleCapabilities) };
    }
    if (terminal) {
      run.catalogMode = "terminal";
      const capabilities = allCapabilities(run.condition)
        .filter((capability) => capability.name === "flow.get_state");
      return { capabilitySnapshot: this.#snapshot(run, capabilities) };
    }
    run.catalogMode = "post_step_transition";
    // Reuse the exact compiler-produced topic catalog. This retains generic
    // always/topic tools while withholding the completed step's leaf tools.
    return { capabilitySnapshot: this.#snapshot(run, this.#capabilitiesForTarget(run)) };
  }

  #memory(run: KernelRun, callId: string, args: Readonly<Record<string, JsonValue>>): BenchmarkGatewayOutcome {
    const operation = args.operation;
    const key = args.key;
    if (
      !hasOnlyKeys(args, ["operation", "key", "value"])
      || (operation !== "read" && operation !== "write" && operation !== "delete")
      || typeof key !== "string"
      || key.length < 1
      || key.length > 256
    ) {
      return { result: failure("invalid_memory_arguments", "durable_memory requires operation and key", DURABLE_MEMORY_ACTION) };
    }
    if (operation === "write") {
      if (!("value" in args)) return { result: failure("invalid_memory_arguments", "write requires value", DURABLE_MEMORY_ACTION) };
      run.memory.set(key, structuredClone(args.value));
    } else if (operation === "delete") {
      run.memory.delete(key);
    }
    const found = run.memory.has(key);
    const value = run.memory.get(key);
    return {
      result: success(DURABLE_MEMORY_ACTION, `memory:${callId}`, asJson({ operation, key, found, ...(found ? { value } : {}) })),
    };
  }

  #flowControl(
    run: KernelRun,
    callId: string,
    action: string,
    args: Readonly<Record<string, JsonValue>>
  ): BenchmarkGatewayOutcome {
    const invalid = this.#validateFlowControlArguments(action, args);
    if (invalid) return { result: invalid };
    return run.condition.behavior.enforceTransitions
      ? this.#enforcedFlowControl(run, callId, action, args)
      : this.#looseFlowControl(run, callId, action, args);
  }

  #validateFlowControlArguments(
    action: string,
    args: Readonly<Record<string, JsonValue>>
  ): Extract<CapabilityGatewayResult, { ok: false }> | null {
    if (action === "flow.select_topic") {
      return hasOnlyKeys(args, ["topic_id"]) && typeof args.topic_id === "string" && args.topic_id.length > 0
        ? null
        : failure("invalid_arguments", "flow.select_topic requires only a non-empty topic_id", action);
    }
    if (action === "flow.enter_step") {
      return hasOnlyKeys(args, ["path"]) && typeof args.path === "string" && args.path.length > 0
        ? null
        : failure("invalid_arguments", "flow.enter_step requires only a non-empty path", action);
    }
    if (action === "flow.complete_step") {
      const outputsValid = args.outputs === undefined || record(args.outputs) !== null;
      const pathValid = args.path === undefined || (typeof args.path === "string" && args.path.length > 0);
      return hasOnlyKeys(args, ["path", "outputs"]) && outputsValid && pathValid
        ? null
        : failure("invalid_arguments", "flow.complete_step accepts only optional path and object outputs", action);
    }
    return Object.keys(args).length === 0
      ? null
      : failure("invalid_arguments", "flow.get_state does not accept arguments", action);
  }

  #looseFlowControl(
    run: KernelRun,
    callId: string,
    action: string,
    args: Readonly<Record<string, JsonValue>>
  ): BenchmarkGatewayOutcome {
    if (run.condition.id === "raw-full" || run.condition.id === "raw-memory") {
      return { result: failure("unknown_action", `${action} is not part of this baseline`, action) };
    }
    if (action === "flow.select_topic") {
      const topicId = args.topic_id;
      const target = typeof topicId === "string" ? `topic:${topicId}` as const : null;
      if (!target || !run.condition.disclosures.some((candidate) => candidate.target === target)) {
        return { result: failure("unknown_topic", "Select one compiled topic_id", action) };
      }
      run.loose.selectedTopic = topicId as string;
      run.loose.currentStep = null;
      run.loose.capabilityEpoch += 1;
      run.loose.target = target;
      run.target = target;
      run.catalogMode = "target";
      const result = success(action, `control:${callId}`, asJson({ topic_id: topicId, capability_epoch: run.loose.capabilityEpoch }));
      return { result, ...this.#rotation(run, target) };
    }
    if (action === "flow.enter_step") {
      const path = args.path;
      const target = typeof path === "string" ? `step:${path}` as const : null;
      if (!target || !run.condition.disclosures.some((candidate) => candidate.target === target)) {
        return { result: failure("unknown_step", "Enter one compiled step path", action) };
      }
      run.loose.currentStep = path as string;
      run.loose.capabilityEpoch += 1;
      run.loose.target = target;
      run.target = target;
      run.catalogMode = "target";
      const result = success(action, `control:${callId}`, asJson({ path, capability_epoch: run.loose.capabilityEpoch }));
      return { result, ...this.#rotation(run, target) };
    }
    if (action === "flow.complete_step") {
      const path = typeof args.path === "string" ? args.path : run.loose.currentStep;
      if (!path) return { result: failure("missing_step", "No loose step is active", action) };
      run.loose.completedSteps.add(path);
      const supplied = record(args.outputs ?? {}) ?? {};
      run.loose.outputs[path] = asJson(supplied);
      const ref = findStep(this.#flow, path);
      const nextSteps = ref ? looseSuccessfulNextSteps(path, ref.step, supplied) : [];
      const terminal = nextSteps.length === 0;
      const topicId = path.split(".")[0];
      const topicTarget = `topic:${topicId}` as const;
      if (run.condition.disclosures.some((candidate) => candidate.target === topicTarget)) {
        run.target = topicTarget;
        run.loose.target = topicTarget;
      }
      run.loose.currentStep = null;
      run.loose.capabilityEpoch += 1;
      return {
        result: success(action, `control:${callId}`, asJson({
          completed_step: path,
          next_steps: nextSteps,
          outputs_accepted_without_receipt_verification: true,
        })),
        ...this.#postCompletionRotation(run, terminal),
      };
    }
    const target = run.target === "$base" ? undefined : run.target;
    const result = success(action, `control:${callId}`, asJson({
      status: "ephemeral",
      topic: run.loose.selectedTopic,
      current_step: run.loose.currentStep,
      completed_steps: [...run.loose.completedSteps],
      outputs: run.loose.outputs,
      capability_epoch: run.loose.capabilityEpoch,
    }), "verified");
    return { result, ...this.#rotation(run, target) };
  }

  #enforcedFlowControl(
    run: KernelRun,
    callId: string,
    action: string,
    args: Readonly<Record<string, JsonValue>>
  ): BenchmarkGatewayOutcome {
    if (!run.flowState) throw new Error("enforced flow control requires durable state");
    if (action === "flow.select_topic") {
      if (typeof args.topic_id !== "string") return { result: failure("invalid_arguments", "topic_id is required", action) };
      const selected = selectFlowTopic(this.#flow, run.flowState, args.topic_id, this.#clock.nowIso());
      if ("error" in selected) return { result: runtimeFailure(selected, action, run.flowState.capabilityEpoch) };
      run.flowState = selected;
      const target = `topic:${args.topic_id}` as const;
      run.target = target;
      run.catalogMode = "target";
      const nextSteps = topicEntryStepPaths(this.#flow, args.topic_id);
      const result = success(action, `control:${callId}`, asJson({ topic_id: args.topic_id, next_steps: nextSteps, capability_epoch: selected.capabilityEpoch }));
      return { result, ...this.#rotation(run, run.condition.behavior.progressiveDisclosure ? target : undefined) };
    }
    if (action === "flow.enter_step") {
      if (typeof args.path !== "string") return { result: failure("invalid_arguments", "path is required", action) };
      const entered = enterFlowStep(this.#flow, run.flowState, args.path, this.#clock.nowIso());
      if ("error" in entered) return { result: runtimeFailure(entered, action, run.flowState.capabilityEpoch) };
      run.flowState = entered.state;
      const target = `step:${args.path}` as const;
      run.target = target;
      run.catalogMode = "target";
      const result = success(action, `control:${callId}`, asJson({
        path: entered.path,
        required_outputs: entered.step.required_outputs ?? [],
        next_steps: entered.nextSteps,
        capability_epoch: entered.state.capabilityEpoch,
      }));
      return { result, ...this.#rotation(run, run.condition.behavior.progressiveDisclosure ? target : undefined) };
    }
    if (action === "flow.complete_step") {
      const path = typeof args.path === "string" ? args.path : undefined;
      const outputs = record(args.outputs ?? {}) ?? {};
      const completedPath = path ?? run.flowState.currentStep;
      const completed = completeFlowStep(this.#flow, run.flowState, { path, outputs }, this.#clock.nowIso());
      if ("error" in completed) return { result: runtimeFailure(completed, action, run.flowState.capabilityEpoch) };
      run.flowState = completed.state;
      if (completed.state.nodeId) run.target = `topic:${completed.state.nodeId}`;
      const result = success(action, `control:${callId}`, asJson({
        completed_step: completedPath,
        next_steps: completed.nextSteps,
        state: flowStateSummary(this.#flow, completed.state),
      }));
      return { result, ...this.#postCompletionRotation(run) };
    }
    const result = success(action, `control:${callId}`, asJson(flowStateSummary(this.#flow, run.flowState)), "verified");
    const target = run.condition.behavior.progressiveDisclosure
      && run.target !== "$base"
      ? run.target
      : undefined;
    return { result, ...this.#rotation(run, target) };
  }

  #unrestrictedLeaf(run: KernelRun, input: BenchmarkGatewayInvocation): BenchmarkGatewayOutcome {
    const execution = input.executeLeaf({ action: input.call.action, arguments: input.call.arguments });
    return this.#toolExecutionOutcome(run, input.call.action, execution);
  }

  #enforcedLeaf(run: KernelRun, input: BenchmarkGatewayInvocation): BenchmarkGatewayOutcome {
    if (!run.flowState) throw new Error("exactly-once condition has no durable flow state");
    const receiptId = `flow:${run.runId}:${input.providerCallId}`;
    const invocationId = deriveFlowActionInvocationId(receiptId);
    const reserved = reserveFlowAction(this.#flow, run.flowState, {
      receiptId,
      invocationId,
      tool: input.call.action,
      arguments: input.call.arguments,
      capabilityEpoch: run.flowState.capabilityEpoch,
    }, this.#clock.nowIso());
    if ("error" in reserved) {
      return { result: runtimeFailure(reserved, input.call.action, run.flowState.capabilityEpoch) };
    }
    run.flowState = reserved.state;
    if (!reserved.execute) {
      if (reserved.receipt.status === "succeeded" && reserved.receipt.result !== undefined) {
        return {
          result: success(input.call.action, reserved.receipt.id, asJson(reserved.receipt.result), "replayed"),
        };
      }
      return {
        result: failure(
          reserved.receipt.status === "indeterminate" ? "action_indeterminate" : "action_pending",
          `Action ${input.call.action} already has an unresolved receipt`,
          input.call.action,
          false,
          run.flowState.capabilityEpoch
        ),
      };
    }

    // Persist the one-way dispatch boundary before any integration receives
    // the request. A crash or exception after this point is indeterminate and
    // must be reconciled; it is never safe to blindly redispatch.
    const dispatch = markFlowActionDispatchStarted(run.flowState, { receiptId }, this.#clock.nowIso());
    if ("error" in dispatch) {
      throw new Error(`failed to persist action dispatch boundary: ${dispatch.error}`);
    }
    run.flowState = dispatch.state;

    let execution: ToolExecution;
    try {
      execution = input.executeLeaf({
        action: input.call.action,
        arguments: input.call.arguments,
        idempotencyKey: reserved.receipt.idempotencyKey,
      });
    } catch (error) {
      const settled = settleFlowAction(run.flowState, {
        receiptId,
        status: "indeterminate",
        error: error instanceof Error ? error.message : "leaf execution threw",
      }, this.#clock.nowIso());
      if ("error" in settled) throw new Error(settled.error);
      run.flowState = settled.state;
      return {
        result: failure("action_indeterminate", "Action outcome is indeterminate and must be reconciled", input.call.action, false, run.flowState.capabilityEpoch),
      };
    }

    const authoritative = execution.receipt.authoritative_result;
    const committedAfterVisibleError = execution.receipt.status === "committed_after_error";
    const didSucceed = authoritative !== undefined && (
      execution.receipt.status === "succeeded"
      || execution.receipt.status === "committed_after_error"
      || execution.receipt.status === "deduplicated"
    );
    const settled = settleFlowAction(run.flowState, didSucceed
      ? { receiptId, status: "succeeded", result: authoritative }
      : { receiptId, status: "failed", error: visibleError(execution, input.call.action).message },
    this.#clock.nowIso());
    if ("error" in settled) throw new Error(settled.error);
    run.flowState = settled.state;
    if (!didSucceed) return { result: visibleError(execution, input.call.action, run.flowState.capabilityEpoch) };
    const result = success(
      input.call.action,
      receiptId,
      asJson(authoritative),
      execution.disposition === "deduplicated" ? "deduplicated" : "executed"
    );
    return committedAfterVisibleError
      ? { result, providerVisibleOutput: visibleError(execution, input.call.action, run.flowState.capabilityEpoch) as unknown as JsonValue }
      : { result };
  }

  #toolExecutionOutcome(run: KernelRun, action: string, execution: ToolExecution): BenchmarkGatewayOutcome {
    const authoritative = execution.receipt.authoritative_result;
    const committedAfterVisibleError = execution.receipt.status === "committed_after_error";
    const didSucceed = authoritative !== undefined && (
      execution.receipt.status === "succeeded"
      || execution.receipt.status === "committed_after_error"
      || execution.receipt.status === "deduplicated"
    );
    if (!didSucceed) return { result: visibleError(execution, action, this.#epoch(run)) };
    const result = success(
      action,
      execution.receipt.receipt_id,
      asJson(authoritative),
      execution.disposition === "deduplicated" ? "deduplicated" : execution.disposition === "replayed" ? "replayed" : "executed"
    );
    return committedAfterVisibleError
      ? { result, providerVisibleOutput: visibleError(execution, action, this.#epoch(run)) as unknown as JsonValue }
      : { result };
  }
}

export function createInMemoryBenchmarkGatewayKernel(
  options: BenchmarkGatewayKernelOptions
): InMemoryBenchmarkGatewayKernel {
  return new InMemoryBenchmarkGatewayKernel(options);
}

/** Useful for tests and diagnostics without exposing private receipt contents. */
export function benchmarkConditionCapabilityNames(condition: CompiledBenchmarkCondition): readonly string[] {
  return Object.freeze(allCapabilities(condition).map((capability) => capability.name));
}

export function isStateEnforcedCondition(id: BenchmarkConditionId): boolean {
  return id === "state-only" || id === "full-harness" || id === "oracle-route";
}

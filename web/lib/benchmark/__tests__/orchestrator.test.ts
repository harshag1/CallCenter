import { describe, expect, it } from "vitest";
import { verifyEventChain, verifyRunManifest } from "../artifacts";
import { createBudgetLedger } from "../budget";
import {
  createPairedAudioManifest,
  runBenchmarkTrial,
  type BenchmarkGatewayInvocation,
  type BenchmarkGatewayKernel,
  type CallerAudioTurn,
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
import { BenchmarkScenarioSchema, type BenchmarkScenario } from "../scenario-schema";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  Pcm16Audio,
  RealtimeClientState,
  RealtimeEventListener,
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

function conditionFor(id: BenchmarkConditionId = "raw-full"): CompiledBenchmarkCondition {
  const capabilities = scenario.tools.map((tool) => ({
    name: tool.name,
    category: "leaf" as const,
    description: tool.description,
    inputSchema: { type: "object", additionalProperties: true },
    semanticHash: HASH,
  }));
  return Object.freeze({
    id,
    behavior: Object.freeze({
      toolExposure: "gateway" as const,
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
    semanticLeafTools: Object.freeze(scenario.tools.map((tool) => Object.freeze({
      name: tool.name,
      semanticDefinitionHash: HASH,
      publicContractHash: HASH,
      providerSchemaHash: HASH,
    }))),
    initialPrompt: `INITIAL PROMPT FOR ${id}`,
    initialPromptHash: HASH,
    providerToolsHash: HASH,
    conditionHash: HASH,
  });
}

function snapshot(condition: CompiledBenchmarkCondition): ProviderCapabilitySnapshot {
  return snapshotFor(condition.visibleCapabilities, `test:${condition.id}`, 0, "grant");
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
  constructor(private readonly inspect?: (invocation: BenchmarkGatewayInvocation) => void) {}

  initialize({ condition }: { condition: CompiledBenchmarkCondition }): ProviderCapabilitySnapshot {
    return snapshot(condition);
  }

  invoke(invocation: BenchmarkGatewayInvocation) {
    this.inspect?.(invocation);
    if (invocation.call.capability_grant !== `grant.${invocation.call.action}`) {
      return {
        result: {
          ok: false as const,
          gateway_version: CAPABILITY_GATEWAY_VERSION,
          action: invocation.call.action,
          code: "stale_capability_grant",
          message: "The capability grant is not current for this action.",
          retriable: false,
        },
      };
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
    return execution.visible_result.ok
      ? { result: authoritativeResult }
      : {
          result: authoritativeResult,
          providerVisibleOutput: execution.visible_result,
        };
  }
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
    createClient(configuration: TrialSessionConfiguration) {
      options.sessions?.push(configuration);
      return client;
    },
  };
}

type FakeHooks = Readonly<{
  onConnect?(client: FakeRealtimeClient): void;
  onTurn?(client: FakeRealtimeClient, audio: Pcm16Audio | readonly Pcm16Audio[]): void;
  onToolResults?(client: FakeRealtimeClient, results: readonly RealtimeToolResult[], createResponse: boolean): void;
}>;

class FakeRealtimeClient implements NormalizedRealtimeClient {
  readonly provider = "openai" as const;
  private clientState: RealtimeClientState = "idle";
  private readonly eventListeners = new Set<RealtimeEventListener>();
  private readonly wireListeners = new Set<RealtimeWireEventListener>();
  readonly turns: Array<Pcm16Audio | readonly Pcm16Audio[]> = [];
  readonly resultBatches: Array<readonly RealtimeToolResult[]> = [];
  connectCalls = 0;
  closeCalls = 0;

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

  appendInputAudio(): void {
    throw new Error("orchestrator must use sendTurn for true-audio turns");
  }

  commitInputAudio(): void {
    throw new Error("orchestrator must use sendTurn for true-audio turns");
  }

  createResponse(): void {
    throw new Error("orchestrator delegates response creation to sendTurn and submitToolResults");
  }

  sendTurn(audio: Pcm16Audio | readonly Pcm16Audio[]): void {
    if (this.clientState !== "ready") throw new Error("fake client is not ready");
    this.turns.push(audio);
    this.wire({ type: "input_audio_buffer.commit", turn: this.turns.length });
    this.hooks.onTurn?.(this, audio);
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
    for (const listener of this.wireListeners) listener(frozen);
  }

  resolveReadyWithoutAcknowledgement(): void {
    this.clientState = "ready";
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
    action,
    arguments: argumentsJson,
    capability_grant: `grant.${action}`,
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

  it("uses the same paired audio hash while routing the harness arm only through an injected stable gateway", async () => {
    let handled = 0;
    const client = new FakeRealtimeClient({
      onTurn(fake) {
        fake.emit(event("tool.calls", {
          responseId: "harness-response-1",
          calls: [validCall("gateway-1", CAPABILITY_GATEWAY_NAME, {
            action: "commit_action",
            arguments: { job_id: "J-1" },
            capability_grant: "grant.commit_action",
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

  it("appends compiled progressive disclosure and independent state-only grant rotations to gateway results", async () => {
    const baseProgressive = conditionFor("full-harness");
    const lookupCapability = baseProgressive.visibleCapabilities.find((capability) => capability.name === "lookup_value")!;
    const commitCapability = baseProgressive.visibleCapabilities.find((capability) => capability.name === "commit_action")!;
    const progressiveCondition: CompiledBenchmarkCondition = Object.freeze({
      ...baseProgressive,
      visibleCapabilities: Object.freeze([lookupCapability]),
      disclosures: Object.freeze([{
        target: "step:commit" as const,
        information: Object.freeze([]),
        visibleCapabilities: Object.freeze([commitCapability]),
        prompt: "COMPILED COMMIT STAGE DISCLOSURE",
        promptHash: HASH,
        disclosureHash: HASH,
      }]),
    });
    const direct = new DirectGatewayKernel();
    const progressiveKernel: BenchmarkGatewayKernel = {
      initialize: (input) => snapshot(input.condition),
      async invoke(invocation) {
        const outcome = await direct.invoke(invocation);
        return {
          ...outcome,
          disclosure: {
            target: "step:commit",
            snapshot: snapshotFor([commitCapability], "step:commit", 1, "next"),
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
          progressive_disclosure: "COMPILED COMMIT STAGE DISCLOSURE",
        });
        expect((results[0].output as { capability_snapshot: string }).capability_snapshot)
          .toContain('"capability_grant":"next.commit_action"');
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
      payload: expect.objectContaining({ disclosure_target: "step:commit" }),
    }));

    const stateCondition = conditionFor("state-only");
    const stateDirect = new DirectGatewayKernel();
    const stateKernel: BenchmarkGatewayKernel = {
      initialize: (input) => snapshot(input.condition),
      async invoke(invocation) {
        const outcome = await stateDirect.invoke(invocation);
        return {
          ...outcome,
          capabilitySnapshot: snapshotFor([lookupCapability], "state:epoch-1", 1, "rotated"),
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
          .toContain('"capability_grant":"rotated.lookup_value"');
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
});

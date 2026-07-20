import { generateKeyPairSync } from "node:crypto";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import scenarioJson from "../../../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";
import { canonicalJson, sha256Hex } from "../artifacts";
import { compileConditionSuite, type CompiledBenchmarkCondition } from "../condition-compiler";
import { createInMemoryBenchmarkGatewayKernel, type InMemoryBenchmarkGatewayKernel } from "../gateway-kernel";
import {
  createBenchmarkKernelAttestationSigner,
  createBenchmarkKernelCapabilityHead,
  type BenchmarkKernelCapabilityHead,
  type BenchmarkKernelEvidenceBinding,
} from "../kernel-attestation";
import {
  DEFAULT_KERNEL_TRANSCRIPT_LIMITS,
  appendKernelTranscriptInvocation,
  assertKernelTranscriptDurableMemoryState,
  assertKernelTranscriptContainsNoRawGrants,
  commitSensitiveTranscriptValues,
  createKernelTranscript,
  encodeKernelTranscript,
  encodeRestrictedKernelTranscript,
  kernelTranscriptReference,
  parseKernelTranscript,
  publicKernelTranscript,
  verifyRestrictedKernelTranscript,
  verifyKernelTranscript,
  type KernelTranscript,
  type KernelTranscriptLimits,
  type PublicKernelTranscript,
} from "../kernel-transcript";
import {
  INDUSTRIAL_FIELD_SERVICE_FLOW,
  industrialFieldServiceCompilerInput,
} from "../industrial-field-service-source";
import { BenchmarkScenarioSchema, type JsonValue } from "../scenario-schema";
import { createToolWorld, executeTool, type ToolWorldState } from "../tool-world";
import type { BenchmarkGatewayOutcome } from "../orchestrator";
import type { ProviderCapabilitySnapshot } from "../capability-gateway";

const ENTRY_DOMAIN = "harshas-amazing-call-center/benchmark-kernel-transcript-entry/v1\n";
const scenario = BenchmarkScenarioSchema.parse(scenarioJson);
const suite = compileConditionSuite(industrialFieldServiceCompilerInput(scenario));
const keyPair = generateKeyPairSync("ed25519");
const signer = createBenchmarkKernelAttestationSigner({
  keyId: "kernel-transcript-test-v1",
  privateKeyPem: keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
});
const trust = Object.freeze({
  keyId: signer.keyId,
  publicKeySha256: signer.publicKeySha256,
  publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
});
const evidenceBinding: BenchmarkKernelEvidenceBinding = Object.freeze({
  pairId: "pair-kernel-transcript",
  leaseSubjectId: "pair-kernel-transcript",
  provider: "offline",
  model: "deterministic-toolworld-transcript-v1",
  planSha256: "1".repeat(64),
  freezeLockSha256: "2".repeat(64),
  kernelBuildSha256: "3".repeat(64),
});
const FIXED_CLOCK = Object.freeze({
  nowMs: () => Date.parse("2026-07-10T12:00:00.000Z"),
  nowIso: () => "2026-07-10T12:00:00.000Z",
});
const SENSITIVE_VALUE_SECRET = "kernel-transcript-sensitive-value-hmac-test-v1";

type Harness = {
  kernel: InMemoryBenchmarkGatewayKernel;
  condition: CompiledBenchmarkCondition;
  snapshot: ProviderCapabilitySnapshot;
  capabilityHead: BenchmarkKernelCapabilityHead;
  transcript: KernelTranscript;
  world: ToolWorldState;
  sequence: number;
  rawGrants: string[];
  memory: Map<string, JsonValue> | null;
};

function createHarness(
  runId = "run-kernel-transcript",
  options: Readonly<{
    conditionId?: "raw-full" | "raw-memory";
    limits?: KernelTranscriptLimits;
  }> = {}
): Harness {
  const condition = suite.conditions[options.conditionId ?? "raw-full"];
  const kernel = createInMemoryBenchmarkGatewayKernel({
    flow: INDUSTRIAL_FIELD_SERVICE_FLOW,
    expectedFlowHash: suite.flowHash,
    expectedScenarioHash: suite.scenarioHash,
    expectedConditionHash: condition.conditionHash,
    grantBindingHash: suite.sourceHash,
    leaseSubjectId: evidenceBinding.leaseSubjectId,
    evidenceBinding,
    signer,
    capabilitySecret: "fixed-kernel-transcript-capability-secret-v1",
    clock: FIXED_CLOCK,
  });
  const world = createToolWorld(scenario);
  const memory = condition.behavior.genericDurableMemory ? new Map<string, JsonValue>() : null;
  const snapshot = kernel.initialize({ runId, condition, scenario, world });
  const capabilityHead = createBenchmarkKernelCapabilityHead({
    condition,
    epoch: snapshot.capability_epoch,
    target: "$full-catalog",
    catalogMode: "target",
    internalFlowScope: null,
  });
  const transcript = createKernelTranscript({
    runId,
    condition,
    scenario,
    world,
    flowState: null,
    capabilityHead,
    providerVisibleCapabilitySnapshot: snapshot,
    dataClassification: "synthetic_benchmark_only",
    sensitiveValueSecret: SENSITIVE_VALUE_SECRET,
    durableMemoryState: memory,
    ...(options.limits ? { limits: options.limits } : {}),
  });
  return {
    kernel,
    condition,
    snapshot,
    capabilityHead,
    transcript,
    world,
    sequence: 0,
    rawGrants: snapshot.actions.map((action) => action.capability_grant),
    memory,
  };
}

function grant(harness: Harness, action: string): string {
  const candidate = harness.snapshot.actions.find((item) => item.name === action);
  if (!candidate) throw new Error(`raw-full catalog does not contain ${action}`);
  return candidate.capability_grant;
}

function invoke(
  harness: Harness,
  action: string,
  args: Record<string, JsonValue>,
  providerCallId = `provider-call-${harness.sequence + 1}`
): BenchmarkGatewayOutcome {
  harness.sequence += 1;
  const before = structuredClone(harness.world);
  const beforeMemory = harness.memory === null ? null : structuredClone(harness.memory);
  const capabilityGrant = grant(harness, action);
  const invocation = {
    providerCallId,
    call: { action, arguments: args, capability_grant: capabilityGrant },
    capabilityEpoch: harness.snapshot.capability_epoch,
    condition: harness.condition,
    turn: harness.sequence,
    world: before,
  } as const;
  const outcome = harness.kernel.invoke({
    ...invocation,
    executeLeaf: (request) => {
      const execution = executeTool(scenario, harness.world, {
        invocation_id: `transcript-world-${harness.sequence}`,
        tool: request.action,
        arguments: request.arguments,
        turn: Math.min(harness.sequence, scenario.max_turns),
        ...(request.idempotencyKey ? { idempotency_key: request.idempotencyKey } : {}),
      });
      harness.world = execution.state;
      return execution;
    },
  });
  if (
    harness.memory !== null
    && action === "durable_memory"
    && outcome.result.ok
    && outcome.result.disposition === "executed"
  ) {
    if (args.operation === "write" && typeof args.key === "string" && "value" in args) {
      harness.memory.set(args.key, structuredClone(args.value));
    } else if (args.operation === "delete" && typeof args.key === "string") {
      harness.memory.delete(args.key);
    }
  }
  harness.transcript = appendKernelTranscriptInvocation(harness.transcript, {
    invocation,
    outcome,
    postWorld: harness.world,
    preFlowState: null,
    postFlowState: null,
    preCapabilityHead: harness.capabilityHead,
    postCapabilityHead: harness.capabilityHead,
    sensitiveValueSecret: SENSITIVE_VALUE_SECRET,
    preDurableMemoryState: beforeMemory,
    postDurableMemoryState: harness.memory,
  });
  return outcome;
}

function populatedTranscript(runId = "run-kernel-transcript"): Harness {
  const harness = createHarness(runId);
  invoke(harness, "lookup_work_order", { work_order_id: "WO-2048" });
  invoke(harness, "verify_technician", { employee_id: "E-731", pin: "4826" });
  return harness;
}

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function rechain(transcript: KernelTranscript): KernelTranscript {
  const entries = structuredClone(transcript.entries) as Mutable<KernelTranscript["entries"]>;
  for (const [index, entry] of entries.entries()) {
    entry.sequence = index;
    entry.previous_entry_sha256 = index === 0 ? null : entries[index - 1].entry_sha256;
    const body = {
      schema_version: entry.schema_version,
      transcript_type: entry.transcript_type,
      run_id: entry.run_id,
      sequence: entry.sequence,
      operation: entry.operation,
      payload: entry.payload,
      previous_entry_sha256: entry.previous_entry_sha256,
    };
    entry.entry_sha256 = sha256Hex(`${ENTRY_DOMAIN}${canonicalJson(body)}`);
  }
  return { entries } as KernelTranscript;
}

function rechainPublic(transcript: PublicKernelTranscript): PublicKernelTranscript {
  const entries = structuredClone(transcript.entries) as Mutable<PublicKernelTranscript["entries"]>;
  for (const [index, entry] of entries.entries()) {
    entry.sequence = index;
    entry.previous_entry_sha256 = index === 0 ? null : entries[index - 1].entry_sha256;
    const body = {
      schema_version: entry.schema_version,
      transcript_type: entry.transcript_type,
      run_id: entry.run_id,
      sequence: entry.sequence,
      operation: entry.operation,
      payload: entry.payload,
      previous_entry_sha256: entry.previous_entry_sha256,
    };
    entry.entry_sha256 = sha256Hex(`${ENTRY_DOMAIN}${canonicalJson(body)}`);
  }
  return { view: "public_commitment", entries };
}

describe("gateway-kernel replay transcript", () => {
  it("reconstructs the public committed shadow without claiming plaintext ToolWorld reconstruction", () => {
    const harness = populatedTranscript();
    const encoded = encodeKernelTranscript(harness.transcript);
    const verification = verifyKernelTranscript({ transcript: encoded });

    expect(verification.valid).toBe(true);
    expect(verification.authenticity).toBe("unsigned_public_commitment");
    expect(verification.errors).toEqual([]);
    expect(verification.reconstructed.final_world).toBeNull();
    expect(verification.reconstructed.final_public_shadow_world).not.toBeNull();
    expect(verification.reconstructed.authoritative_world_head?.event_count).toBe(harness.world.events.length);
    expect(verification.reconstructed.capability_head).toEqual(harness.capabilityHead);
    expect(verification.reconstructed.flow_state_sha256).toBeNull();
    expect(verification.reconstructed.durable_memory_head).toEqual({
      applicability: "not_applicable",
      revision: 0,
      entry_count: 0,
      public_state_sha256: null,
    });
    expect(verification.reconstructed.final_public_durable_memory).toBeNull();
    expect(verification.reconstruction_coverage).toEqual({
      plaintext_world_head: "signed_authoritative_head_only_not_plaintext_reconstructed",
      public_shadow_world: "reconstructed_from_committed_initial_state_and_deltas",
      capability_head: "validated_from_public_catalog_and_signed_final_head",
      flow_proof: "hash_chain_only_requires_final_signed_attestation_state",
      provider_behavior: "hmac_input_output_bound_not_model_reexecuted",
      durable_memory: "reconstructed_when_applicable_from_hmac_committed_state_and_deltas",
    });
    expect(parseKernelTranscript(encoded)).toEqual(publicKernelTranscript(harness.transcript));
  });

  it("keeps plaintext ToolWorld reconstruction behind the explicit restricted-exact verifier", () => {
    const harness = populatedTranscript("run-restricted-exact");
    const restricted = encodeRestrictedKernelTranscript(harness.transcript, {
      restrictedExactMayContainSecrets: true,
    });
    const verified = verifyRestrictedKernelTranscript({
      transcript: restricted,
      acknowledgeRestrictedExactMayContainSecrets: true,
    });
    expect(verified.valid).toBe(true);
    expect(verified.reconstructed.final_world).toEqual(harness.world);
    expect(verified.reconstructed.final_durable_memory).toBeNull();

    const forged = structuredClone(harness.transcript) as Mutable<KernelTranscript>;
    const entry = forged.entries[1];
    if (entry.operation !== "invoke") throw new Error("expected restricted invocation");
    entry.payload.world_delta.facts.close_status = "forged";
    expect(verifyRestrictedKernelTranscript({
      transcript: rechain(forged as KernelTranscript),
      acknowledgeRestrictedExactMayContainSecrets: true,
    }).valid).toBe(false);
  });

  it("is byte-deterministic and publishes a stable self-describing transcript reference", () => {
    const first = populatedTranscript("run-deterministic");
    const second = populatedTranscript("run-deterministic");
    const firstEncoded = encodeKernelTranscript(first.transcript);
    const secondEncoded = encodeKernelTranscript(second.transcript);

    expect(secondEncoded).toBe(firstEncoded);
    expect(kernelTranscriptReference(second.transcript)).toEqual(kernelTranscriptReference(first.transcript));
    expect(kernelTranscriptReference(first.transcript)).toMatchObject({
      schema_version: 1,
      transcript_type: "benchmark_kernel_replay_public_commitment",
      encoding: "canonical-jsonl-public-commitment",
      view: "public_commitment",
      transcript_entry_count: 3,
      byte_length: Buffer.byteLength(firstEncoded),
      transcript_head_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      transcript_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("upgrades only an exact Ed25519-bound public transcript to signed authenticity", () => {
    const harness = populatedTranscript("run-signed-public-transcript");
    const encoded = harness.kernel.encodedTranscript();
    const transcriptReference = harness.kernel.transcriptReference();
    const attestation = harness.kernel.attestFinal({
      runId: "run-signed-public-transcript",
      condition: harness.condition,
      scenario,
      world: harness.world,
    });
    const attestationExpectation = {
      runId: "run-signed-public-transcript",
      condition: harness.condition,
      scenario,
      world: harness.world,
      transcriptReference,
      evidenceBinding,
      trust,
    };
    expect(verifyKernelTranscript({
      transcript: encoded,
      finalAttestation: attestation,
      attestationExpectation,
    })).toMatchObject({ valid: true, authenticity: "signed_attestation_verified", errors: [] });

    const substituted = structuredClone(parseKernelTranscript(encoded)) as Mutable<PublicKernelTranscript>;
    const first = substituted.entries[1].payload as Record<string, unknown>;
    const second = substituted.entries[2].payload as Record<string, unknown>;
    const firstInput = first.input as Record<string, unknown>;
    const secondInput = second.input as Record<string, unknown>;
    secondInput.arguments_hmac_sha256 = firstInput.arguments_hmac_sha256;
    const rechained = rechainPublic(substituted as PublicKernelTranscript);
    const rejected = verifyKernelTranscript({
      transcript: rechained,
      finalAttestation: attestation,
      attestationExpectation,
    });
    expect(rejected.valid).toBe(false);
    expect(rejected.authenticity).toBe("signed_attestation_verified");
    expect(rejected.errors).toContain("signed public transcript reference mismatch");
  });

  it("commits capability grants and sensitive values without publishing their preimages", () => {
    const harness = populatedTranscript();
    const memory = createHarness("run-memory-privacy", { conditionId: "raw-memory" });
    invoke(memory, "durable_memory", {
      operation: "write",
      key: "api_key",
      value: "sk-live-low-entropy-secret",
    });
    const encoded = encodeKernelTranscript(harness.transcript);
    const memoryEncoded = encodeKernelTranscript(memory.transcript);
    assertKernelTranscriptContainsNoRawGrants(encoded, harness.rawGrants);
    assertKernelTranscriptContainsNoRawGrants(memoryEncoded, memory.rawGrants);

    expect(encoded).not.toMatch(/\"capability_grant\":\"g1\./);
    expect(encoded).toContain("\"capability_grant_commitment\"");
    expect(encoded).toContain("\"value_hmac_sha256\"");
    for (const forbidden of [
      "4826",
      "VRF-WO2048-E731",
      "Four-digit verification PIN",
      "My employee ID is E seven three one",
    ]) expect(encoded).not.toContain(forbidden);
    expect(memoryEncoded).not.toContain("sk-live-low-entropy-secret");
    const verificationEntry = harness.transcript.entries[2];
    if (verificationEntry.operation !== "invoke") throw new Error("expected verification invocation");
    expect(verificationEntry.payload.input.arguments).toMatchObject({
      pin: { commitment_type: "hmac-sha256", value_type: "string", value_sha256: expect.any(String) },
    });
    expect(commitSensitiveTranscriptValues(
      { nested: { api_key: "sk-test", ordinary: "kept" } },
      SENSITIVE_VALUE_SECRET
    ))
      .toMatchObject({
        nested: {
          api_key: { commitment_type: "hmac-sha256", value_type: "string", value_sha256: expect.any(String) },
          ordinary: "kept",
        },
      });
    expect(verifyKernelTranscript({ transcript: memoryEncoded })).toMatchObject({
      valid: true,
      authenticity: "unsigned_public_commitment",
    });
  });

  it("reconstructs HMAC-committed durable memory and rejects substituted state", () => {
    const harness = createHarness("run-memory-replay", { conditionId: "raw-memory" });
    invoke(harness, "durable_memory", {
      operation: "write",
      key: "api_key",
      value: "sk-low-entropy-one",
    });
    invoke(harness, "durable_memory", {
      operation: "write",
      key: "session_note",
      value: "sk-low-entropy-one",
    });
    invoke(harness, "durable_memory", { operation: "read", key: "api_key" });
    invoke(harness, "durable_memory", {
      operation: "write",
      key: "api_key",
      value: "sk-low-entropy-two",
    });
    invoke(harness, "durable_memory", { operation: "delete", key: "session_note" });

    const encoded = encodeKernelTranscript(harness.transcript);
    const verification = verifyKernelTranscript({ transcript: encoded });
    expect(verification).toMatchObject({
      valid: true,
      authenticity: "unsigned_public_commitment",
      reconstructed: {
        durable_memory_head: {
          applicability: "durable_memory_enabled",
          revision: 4,
          entry_count: 1,
          public_state_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        final_public_durable_memory: [{
          key_hmac_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          value_hmac_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }],
      },
    });
    for (const forbidden of ["api_key", "session_note", "sk-low-entropy-one", "sk-low-entropy-two"]) {
      expect(encoded).not.toContain(forbidden);
    }

    const publicTranscript = parseKernelTranscript(encoded);
    const firstWrite = publicTranscript.entries[1].payload as Record<string, unknown>;
    const secondWrite = publicTranscript.entries[2].payload as Record<string, unknown>;
    const firstDelta = firstWrite.public_durable_memory_delta as Record<string, unknown>;
    const secondDelta = secondWrite.public_durable_memory_delta as Record<string, unknown>;
    expect(firstDelta.value_hmac_sha256).not.toBe(secondDelta.value_hmac_sha256);

    const restricted = verifyRestrictedKernelTranscript({
      transcript: encodeRestrictedKernelTranscript(harness.transcript, {
        restrictedExactMayContainSecrets: true,
      }),
      acknowledgeRestrictedExactMayContainSecrets: true,
    });
    expect(restricted).toMatchObject({
      valid: true,
      reconstructed: {
        durable_memory_head: {
          applicability: "durable_memory_enabled",
          revision: 4,
          entry_count: 1,
          state_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        final_durable_memory: [{ key: "api_key", value: "sk-low-entropy-two" }],
      },
    });
    assertKernelTranscriptDurableMemoryState(harness.transcript, harness.memory);
    expect(() => assertKernelTranscriptDurableMemoryState(
      harness.transcript,
      new Map([["api_key", "substituted"]])
    )).toThrow("final durable memory differs");

    const forged = structuredClone(publicTranscript) as Mutable<PublicKernelTranscript>;
    const overwrite = forged.entries[4].payload as Record<string, unknown>;
    const overwriteDelta = overwrite.public_durable_memory_delta as Record<string, unknown>;
    overwriteDelta.value_hmac_sha256 = "f".repeat(64);
    const forgedVerification = verifyKernelTranscript({
      transcript: rechainPublic(forged as PublicKernelTranscript),
    });
    expect(forgedVerification.valid).toBe(false);
    expect(forgedVerification.errors.some((error) => error.includes("durable memory head mismatch"))).toBe(true);
  });

  it("binds the final durable-memory replay to the signed transcript reference", () => {
    const harness = createHarness("run-signed-memory", { conditionId: "raw-memory" });
    invoke(harness, "durable_memory", { operation: "write", key: "handoff", value: { stage: 37 } });
    invoke(harness, "durable_memory", { operation: "read", key: "handoff" });
    const encoded = harness.kernel.encodedTranscript();
    const transcriptReference = harness.kernel.transcriptReference();
    const attestation = harness.kernel.attestFinal({
      runId: "run-signed-memory",
      condition: harness.condition,
      scenario,
      world: harness.world,
    });
    const attestationExpectation = {
      runId: "run-signed-memory",
      condition: harness.condition,
      scenario,
      world: harness.world,
      transcriptReference,
      evidenceBinding,
      trust,
    };
    expect(verifyKernelTranscript({
      transcript: encoded,
      finalAttestation: attestation,
      attestationExpectation,
    })).toMatchObject({
      valid: true,
      authenticity: "signed_attestation_verified",
      reconstructed: {
        durable_memory_head: {
          applicability: "durable_memory_enabled",
          revision: 1,
          entry_count: 1,
        },
      },
    });

    const forged = structuredClone(parseKernelTranscript(encoded)) as Mutable<PublicKernelTranscript>;
    const write = forged.entries[1].payload as Record<string, unknown>;
    const delta = write.public_durable_memory_delta as Record<string, unknown>;
    delta.value_hmac_sha256 = "a".repeat(64);
    const rejected = verifyKernelTranscript({
      transcript: rechainPublic(forged as PublicKernelTranscript),
      finalAttestation: attestation,
      attestationExpectation,
    });
    expect(rejected.valid).toBe(false);
    expect(rejected.errors).toContain("signed public transcript reference mismatch");
  });

  it("canonicalizes seeded and falsy durable-memory values independent of Map insertion order", () => {
    const base = createHarness("run-seeded-memory", { conditionId: "raw-memory" });
    const firstMap = new Map<string, JsonValue>([
      ["z-empty", ""],
      ["a-null", null],
      ["m-zero", 0],
      ["b-false", false],
    ]);
    const secondMap = new Map<string, JsonValue>([
      ["b-false", false],
      ["m-zero", 0],
      ["a-null", null],
      ["z-empty", ""],
    ]);
    const createSeeded = (memory: Map<string, JsonValue>) => createKernelTranscript({
      runId: "run-seeded-memory",
      condition: base.condition,
      scenario,
      world: base.world,
      flowState: null,
      capabilityHead: base.capabilityHead,
      providerVisibleCapabilitySnapshot: base.snapshot,
      dataClassification: "synthetic_benchmark_only",
      sensitiveValueSecret: SENSITIVE_VALUE_SECRET,
      durableMemoryState: memory,
    });
    const first = createSeeded(firstMap);
    const second = createSeeded(secondMap);
    expect(encodeKernelTranscript(first)).toBe(encodeKernelTranscript(second));
    expect(verifyRestrictedKernelTranscript({
      transcript: encodeRestrictedKernelTranscript(first, { restrictedExactMayContainSecrets: true }),
      acknowledgeRestrictedExactMayContainSecrets: true,
    }).reconstructed.final_durable_memory).toEqual([
      { key: "a-null", value: null },
      { key: "b-false", value: false },
      { key: "m-zero", value: 0 },
      { key: "z-empty", value: "" },
    ]);

    firstMap.set("a-null", "mutated-after-create");
    assertKernelTranscriptDurableMemoryState(first, secondMap);
    expect(() => assertKernelTranscriptDurableMemoryState(first, firstMap)).toThrow("differs");

    expect(() => createKernelTranscript({
      runId: "run-oversized-private-memory",
      condition: base.condition,
      scenario,
      world: base.world,
      flowState: null,
      capabilityHead: base.capabilityHead,
      providerVisibleCapabilitySnapshot: base.snapshot,
      dataClassification: "synthetic_benchmark_only",
      sensitiveValueSecret: SENSITIVE_VALUE_SECRET,
      durableMemoryState: new Map([["oversized", "x".repeat(65)]]),
      limits: { ...DEFAULT_KERNEL_TRANSCRIPT_LIMITS, maxStringBytes: 64 },
    })).toThrow("initial durable memory contains an oversized string");

    const unsortedPublic = structuredClone(publicKernelTranscript(first)) as Mutable<PublicKernelTranscript>;
    const publicInitialize = unsortedPublic.entries[0].payload as Record<string, unknown>;
    const publicMemory = publicInitialize.public_initial_durable_memory as unknown[];
    publicMemory.reverse();
    expect(verifyKernelTranscript({ transcript: rechainPublic(unsortedPublic as PublicKernelTranscript) }).errors)
      .toContain("public initial durable memory key commitments must be unique and canonically sorted");

    const wrongApplicability = structuredClone(publicKernelTranscript(first)) as Mutable<PublicKernelTranscript>;
    const wrongInitialize = wrongApplicability.entries[0].payload as Record<string, unknown>;
    const wrongBindings = wrongInitialize.bindings as Record<string, unknown>;
    wrongBindings.durable_memory_applicability = "not_applicable";
    expect(verifyKernelTranscript({
      transcript: rechainPublic(wrongApplicability as PublicKernelTranscript),
    }).errors).toContain("public initialize durable memory applicability mismatch");

    const unsortedRestricted = structuredClone(first) as Mutable<KernelTranscript>;
    const restrictedInitialize = unsortedRestricted.entries[0];
    if (restrictedInitialize.operation !== "initialize") throw new Error("expected initialize entry");
    const exactMemory = restrictedInitialize.payload.input.durable_memory;
    if (exactMemory === null) throw new Error("expected seeded durable memory");
    exactMemory.reverse();
    expect(verifyRestrictedKernelTranscript({
      transcript: rechain(unsortedRestricted as KernelTranscript),
      acknowledgeRestrictedExactMayContainSecrets: true,
    }).errors).toContain("initialize durable memory keys must be unique and canonically sorted");
  });

  it("derives durable-memory deltas from exact snapshots and rejects impossible mutations", () => {
    const harness = createHarness("run-memory-invalid-transition", { conditionId: "raw-memory" });
    const capabilityGrant = grant(harness, "durable_memory");
    const invocation = {
      providerCallId: "manual-memory-write",
      call: {
        action: "durable_memory",
        arguments: { operation: "write", key: "expected", value: 1 },
        capability_grant: capabilityGrant,
      },
      capabilityEpoch: harness.snapshot.capability_epoch,
      condition: harness.condition,
      turn: 1,
      world: harness.world,
    } as const;
    const outcome = harness.kernel.invoke({
      ...invocation,
      executeLeaf: () => { throw new Error("durable_memory must not execute a leaf"); },
    });
    const append = (
      post: Map<string, JsonValue>,
      candidateOutcome: BenchmarkGatewayOutcome = outcome
    ) => appendKernelTranscriptInvocation(harness.transcript, {
      invocation,
      outcome: candidateOutcome,
      postWorld: harness.world,
      preFlowState: null,
      postFlowState: null,
      preCapabilityHead: harness.capabilityHead,
      postCapabilityHead: harness.capabilityHead,
      sensitiveValueSecret: SENSITIVE_VALUE_SECRET,
      preDurableMemoryState: new Map(),
      postDurableMemoryState: post,
    });

    expect(() => append(new Map([["wrong", 1]]))).toThrow("mutation key differs");
    expect(() => append(new Map([["expected", 1], ["second", 2]]))).toThrow("outside one successful");
    const replayed = structuredClone(outcome) as Mutable<BenchmarkGatewayOutcome>;
    if (!replayed.result.ok) throw new Error("expected successful durable memory outcome");
    replayed.result.disposition = "replayed";
    expect(() => append(new Map([["expected", 1]]), replayed)).toThrow("outside one successful");

    const stalePre = new Map<string, JsonValue>([["unrecorded", true]]);
    expect(() => appendKernelTranscriptInvocation(harness.transcript, {
      invocation,
      outcome,
      postWorld: harness.world,
      preFlowState: null,
      postFlowState: null,
      preCapabilityHead: harness.capabilityHead,
      postCapabilityHead: harness.capabilityHead,
      sensitiveValueSecret: SENSITIVE_VALUE_SECRET,
      preDurableMemoryState: stalePre,
      postDurableMemoryState: stalePre,
    })).toThrow("pre-state does not continue");
  });

  it("detects content mutation, chain splicing, and a rechained forged world delta", () => {
    const harness = populatedTranscript();
    const encoded = encodeKernelTranscript(harness.transcript);
    const mutatedLines = encoded.slice(0, -1).split("\n");
    mutatedLines[1] = mutatedLines[1].replace("provider-call-1", "provider-call-X");
    const contentMutation = `${mutatedLines.join("\n")}\n`;
    expect(verifyKernelTranscript({ transcript: contentMutation }).valid).toBe(false);
    expect(verifyKernelTranscript({ transcript: contentMutation }).errors).toContain("public entry 1 hash mismatch");

    const spliced = structuredClone(parseKernelTranscript(encoded)) as Mutable<PublicKernelTranscript>;
    spliced.entries[2].previous_entry_sha256 = "0".repeat(64);
    expect(verifyKernelTranscript({ transcript: spliced as PublicKernelTranscript }).errors)
      .toContain("public entry 2 previous hash mismatch");

    const forged = structuredClone(parseKernelTranscript(encoded)) as Mutable<PublicKernelTranscript>;
    const invokeEntry = forged.entries[1];
    if (invokeEntry.operation !== "invoke") throw new Error("expected invocation");
    const payload = invokeEntry.payload as Record<string, unknown>;
    const delta = payload.public_world_delta as Record<string, unknown>;
    const facts = delta.facts as Record<string, { value_hmac_sha256: string }>;
    facts.close_status.value_hmac_sha256 = "f".repeat(64);
    const forgedVerification = verifyKernelTranscript({
      transcript: rechainPublic(forged as PublicKernelTranscript),
    });
    expect(forgedVerification.valid).toBe(false);
    expect(forgedVerification.errors.some((error) => error.includes("shadow head mismatch"))).toBe(true);

    const restricted = encodeRestrictedKernelTranscript(harness.transcript, {
      restrictedExactMayContainSecrets: true,
    });
    expect(() => parseKernelTranscript(restricted)).toThrow("unsupported schema or view");
    expect(verifyRestrictedKernelTranscript({
      transcript: encoded,
      acknowledgeRestrictedExactMayContainSecrets: true,
    }).valid).toBe(false);
  });

  it("rejects noncanonical, duplicate-key, extra-field, truncated, and resource-exhaustion inputs", () => {
    const harness = populatedTranscript();
    const encoded = encodeKernelTranscript(harness.transcript);
    expect(() => parseKernelTranscript(` ${encoded}`)).toThrow("not canonical JSON");
    expect(() => parseKernelTranscript(encoded.slice(0, -1))).toThrow("LF-terminated canonical JSONL");
    expect(() => parseKernelTranscript(encoded.replace(
      "{\"entry_sha256\"",
      "{\"schema_version\":1,\"entry_sha256\""
    ))).toThrow("not canonical JSON");
    expect(() => parseKernelTranscript(encoded.replace(
      "\"internal_flow_scope\":null",
      "\"internal_flow_scope\":null,\"internal_flow_scope\":null"
    ))).toThrow("not canonical JSON");

    const extra = encoded.replace("\"operation\":\"initialize\"", "\"extra\":true,\"operation\":\"initialize\"");
    expect(() => parseKernelTranscript(extra)).toThrow(/not canonical JSON|unsupported fields/);
    const undersizedBytes = Buffer.byteLength(encoded) - 1;
    expect(() => parseKernelTranscript(encoded, {
      ...DEFAULT_KERNEL_TRANSCRIPT_LIMITS,
      maxBytes: undersizedBytes,
      maxLineBytes: Math.min(DEFAULT_KERNEL_TRANSCRIPT_LIMITS.maxLineBytes, undersizedBytes),
      maxStringBytes: Math.min(DEFAULT_KERNEL_TRANSCRIPT_LIMITS.maxStringBytes, undersizedBytes),
    })).toThrow("byte bounds");
    expect(() => parseKernelTranscript(encoded, {
      ...DEFAULT_KERNEL_TRANSCRIPT_LIMITS,
      maxEntries: 2,
    })).toThrow("entry bounds");
  });

  it("enforces entry, byte, and depth bounds in the live recorder before returning a mutation", () => {
    const bounded = createHarness("run-live-entry-bound", {
      limits: { ...DEFAULT_KERNEL_TRANSCRIPT_LIMITS, maxEntries: 2 },
    });
    invoke(bounded, "lookup_work_order", { work_order_id: "WO-2048" });
    expect(() => invoke(bounded, "lookup_work_order", { work_order_id: "WO-2048" }))
      .toThrow("live entry limit");
    expect(publicKernelTranscript(bounded.transcript).entries).toHaveLength(2);

    const baseline = createHarness("run-live-byte-bound");
    const initialBytes = Buffer.byteLength(encodeKernelTranscript(baseline.transcript));
    const tooSmallBytes = initialBytes - 1;
    expect(() => createKernelTranscript({
      runId: "run-live-byte-bound",
      condition: baseline.condition,
      scenario,
      world: createToolWorld(scenario),
      flowState: null,
      capabilityHead: baseline.capabilityHead,
      providerVisibleCapabilitySnapshot: baseline.snapshot,
      dataClassification: "synthetic_benchmark_only",
      sensitiveValueSecret: SENSITIVE_VALUE_SECRET,
      limits: {
        ...DEFAULT_KERNEL_TRANSCRIPT_LIMITS,
        maxBytes: tooSmallBytes,
        maxLineBytes: tooSmallBytes,
        maxStringBytes: Math.min(DEFAULT_KERNEL_TRANSCRIPT_LIMITS.maxStringBytes, tooSmallBytes),
      },
    })).toThrow("live artifact-byte limit");

    expect(() => createHarness("run-live-depth-bound", {
      limits: { ...DEFAULT_KERNEL_TRANSCRIPT_LIMITS, maxJsonDepth: 3 },
    })).toThrow("JSON depth limit");
  });

  it("verifies a 120-invocation long-horizon artifact within bounded size and time", () => {
    const harness = createHarness("run-performance-120");
    for (let index = 0; index < 120; index += 1) {
      invoke(harness, "lookup_work_order", { work_order_id: `UNKNOWN-${index}` });
    }
    const encoded = encodeKernelTranscript(harness.transcript);
    const started = performance.now();
    const verification = verifyKernelTranscript({ transcript: encoded });
    const elapsedMs = performance.now() - started;

    expect(verification.valid).toBe(true);
    expect(verification.reference?.transcript_entry_count).toBe(121);
    expect(Buffer.byteLength(encoded)).toBeLessThan(8 * 1024 * 1024);
    expect(elapsedMs).toBeLessThan(12_000);
    // Fixture construction performs 120 signed kernel invocations before the
    // timed verification window and is intentionally outside the performance
    // claim. Only the strict 12 s verifier assertion above is performance-gated;
    // the outer timeout merely accommodates shared-CI CPU contention in setup.
  }, 120_000);
});

import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import scenarioJson from "../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";
import { canonicalJson, sha256Hex } from "../lib/benchmark/artifacts";
import { compileConditionSuite, type CompiledBenchmarkCondition } from "../lib/benchmark/condition-compiler";
import { createInMemoryBenchmarkGatewayKernel } from "../lib/benchmark/gateway-kernel";
import {
  createBenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationExpectation,
  type BenchmarkKernelEvidenceBinding,
} from "../lib/benchmark/kernel-attestation";
import {
  assertKernelTranscriptContainsNoRawGrants,
  verifyKernelTranscript,
} from "../lib/benchmark/kernel-transcript";
import {
  INDUSTRIAL_FIELD_SERVICE_FLOW,
  industrialFieldServiceCompilerInput,
} from "../lib/benchmark/industrial-field-service-source";
import { BenchmarkScenarioSchema, type JsonValue } from "../lib/benchmark/scenario-schema";
import { createToolWorld, executeTool, type ToolWorldState } from "../lib/benchmark/tool-world";

const INVOCATIONS = 120;
const VERIFY_REPETITIONS = 5;
const MEMORY_VERIFY_REPETITIONS = 3;
const scenario = BenchmarkScenarioSchema.parse(scenarioJson);
const suite = compileConditionSuite(industrialFieldServiceCompilerInput(scenario));
const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const signer = createBenchmarkKernelAttestationSigner({
  keyId: "kernel-transcript-benchmark-v1",
  privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  publicKeyPem,
});
const trust = Object.freeze({
  keyId: signer.keyId,
  publicKeySha256: signer.publicKeySha256,
  publicKeyPem,
});
const evidenceBinding: BenchmarkKernelEvidenceBinding = Object.freeze({
  pairId: "pair-kernel-transcript-benchmark",
  leaseSubjectId: "pair-kernel-transcript-benchmark",
  provider: "offline",
  model: "deterministic-toolworld-transcript-v1",
  planSha256: "1".repeat(64),
  freezeLockSha256: "2".repeat(64),
  kernelBuildSha256: "3".repeat(64),
});
const clock = Object.freeze({
  nowMs: () => Date.parse("2026-07-10T12:00:00.000Z"),
  nowIso: () => "2026-07-10T12:00:00.000Z",
});

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function createKernel(condition: CompiledBenchmarkCondition) {
  return createInMemoryBenchmarkGatewayKernel({
    flow: INDUSTRIAL_FIELD_SERVICE_FLOW,
    expectedFlowHash: suite.flowHash,
    expectedScenarioHash: suite.scenarioHash,
    expectedConditionHash: condition.conditionHash,
    grantBindingHash: suite.sourceHash,
    leaseSubjectId: evidenceBinding.leaseSubjectId,
    evidenceBinding,
    signer,
    capabilitySecret: "fixed-kernel-transcript-benchmark-secret-v1",
    clock,
  });
}

function expectation(input: Readonly<{
  runId: string;
  condition: CompiledBenchmarkCondition;
  world: ToolWorldState;
  transcriptReference: ReturnType<ReturnType<typeof createKernel>["transcriptReference"]>;
}>): BenchmarkKernelAttestationExpectation {
  return Object.freeze({
    runId: input.runId,
    condition: input.condition,
    scenario,
    world: input.world,
    transcriptReference: input.transcriptReference,
    evidenceBinding,
    trust,
  });
}

function buildWorldReplay(runId: string) {
  const condition = suite.conditions["raw-full"];
  const kernel = createKernel(condition);
  let world = createToolWorld(scenario);
  const snapshot = kernel.initialize({ runId, condition, scenario, world });
  const rawGrants = snapshot.actions.map((action) => action.capability_grant);
  const lookupGrant = snapshot.actions.find((action) => action.name === "lookup_work_order")?.capability_grant;
  if (!lookupGrant) throw new Error("raw-full condition omitted lookup_work_order");
  let repeatedFullStateBytes = Buffer.byteLength(canonicalJson(world));
  for (let index = 0; index < INVOCATIONS; index += 1) {
    const before = structuredClone(world);
    kernel.invoke({
      providerCallId: `provider-call-${index + 1}`,
      call: {
        action: "lookup_work_order",
        arguments: { work_order_id: `UNKNOWN-${index}` },
        capability_grant: lookupGrant,
      },
      capabilityEpoch: snapshot.capability_epoch,
      condition,
      turn: index + 1,
      world: before,
      executeLeaf: (request) => {
        const execution = executeTool(scenario, world, {
          invocation_id: `transcript-benchmark-world-${index + 1}`,
          tool: request.action,
          arguments: request.arguments,
          turn: Math.min(index + 1, scenario.max_turns),
          ...(request.idempotencyKey ? { idempotency_key: request.idempotencyKey } : {}),
        });
        world = execution.state;
        return execution;
      },
    });
    repeatedFullStateBytes += Buffer.byteLength(canonicalJson(world));
  }
  const encoded = kernel.encodedTranscript();
  const transcriptReference = kernel.transcriptReference();
  const attestation = kernel.attestFinal({ runId, condition, scenario, world });
  return {
    condition,
    world,
    encoded,
    transcriptReference,
    attestation,
    attestationExpectation: expectation({ runId, condition, world, transcriptReference }),
    rawGrants,
    repeatedFullStateBytes,
  };
}

function memoryArguments(index: number): Readonly<Record<string, JsonValue>> {
  const cycle = Math.floor(index / 4);
  const key = `private-memory-key-${cycle}`;
  switch (index % 4) {
    case 0:
      return { operation: "write", key, value: `private-memory-value-${cycle}` };
    case 1:
      return { operation: "read", key };
    case 2:
      return { operation: "write", key, value: { cycle, status: "updated" } };
    default:
      return { operation: "delete", key };
  }
}

function buildMemoryReplay(runId: string) {
  const condition = suite.conditions["raw-memory"];
  const kernel = createKernel(condition);
  const world = createToolWorld(scenario);
  const snapshot = kernel.initialize({ runId, condition, scenario, world });
  const rawGrants = snapshot.actions.map((action) => action.capability_grant);
  const memoryGrant = snapshot.actions.find((action) => action.name === "durable_memory")?.capability_grant;
  if (!memoryGrant) throw new Error("raw-memory condition omitted durable_memory");
  for (let index = 0; index < INVOCATIONS; index += 1) {
    kernel.invoke({
      providerCallId: `memory-call-${index + 1}`,
      call: {
        action: "durable_memory",
        arguments: memoryArguments(index),
        capability_grant: memoryGrant,
      },
      capabilityEpoch: snapshot.capability_epoch,
      condition,
      turn: index + 1,
      world,
      executeLeaf: () => { throw new Error("durable_memory must not execute a ToolWorld leaf"); },
    });
  }
  const encoded = kernel.encodedTranscript();
  const transcriptReference = kernel.transcriptReference();
  const attestation = kernel.attestFinal({ runId, condition, scenario, world });
  return {
    condition,
    world,
    encoded,
    transcriptReference,
    attestation,
    attestationExpectation: expectation({ runId, condition, world, transcriptReference }),
    rawGrants,
  };
}

const buildStarted = performance.now();
const first = buildWorldReplay("run-kernel-transcript-benchmark");
const worldBuildMs = performance.now() - buildStarted;
const second = buildWorldReplay("run-kernel-transcript-benchmark");
const deterministic = first.encoded === second.encoded;
assertKernelTranscriptContainsNoRawGrants(first.encoded, first.rawGrants);

const verifyMs: number[] = [];
let verified = true;
for (let index = 0; index < VERIFY_REPETITIONS; index += 1) {
  const started = performance.now();
  const result = verifyKernelTranscript({
    transcript: first.encoded,
    finalAttestation: first.attestation,
    attestationExpectation: first.attestationExpectation,
  });
  verifyMs.push(performance.now() - started);
  verified &&= result.valid && result.authenticity === "signed_attestation_verified";
}

const lines = first.encoded.slice(0, -1).split("\n");
lines[50] = lines[50].replace("provider-call-50", "provider-call-X50");
const mutations = [
  verifyKernelTranscript({
    transcript: `${lines.join("\n")}\n`,
    finalAttestation: first.attestation,
    attestationExpectation: first.attestationExpectation,
  }),
  verifyKernelTranscript({ transcript: first.encoded.slice(0, -1) }),
  verifyKernelTranscript({ transcript: first.encoded.replace('"previous_entry_sha256":"', '"previous_entry_sha256":"0') }),
];

const memoryBuildStarted = performance.now();
const memory = buildMemoryReplay("run-kernel-memory-benchmark");
const memoryBuildMs = performance.now() - memoryBuildStarted;
const memorySecond = buildMemoryReplay("run-kernel-memory-benchmark");
assertKernelTranscriptContainsNoRawGrants(memory.encoded, memory.rawGrants);
for (let index = 0; index < INVOCATIONS / 4; index += 1) {
  if (
    memory.encoded.includes(`private-memory-key-${index}`)
    || memory.encoded.includes(`private-memory-value-${index}`)
  ) throw new Error("public durable-memory replay artifact exposed a private preimage");
}
const memoryVerifyMs: number[] = [];
let memoryVerification = verifyKernelTranscript({
  transcript: memory.encoded,
  finalAttestation: memory.attestation,
  attestationExpectation: memory.attestationExpectation,
});
for (let index = 0; index < MEMORY_VERIFY_REPETITIONS; index += 1) {
  const started = performance.now();
  memoryVerification = verifyKernelTranscript({
    transcript: memory.encoded,
    finalAttestation: memory.attestation,
    attestationExpectation: memory.attestationExpectation,
  });
  memoryVerifyMs.push(performance.now() - started);
}

const sourceHashes = Object.freeze({
  benchmark_script_sha256: sha256Hex(readFileSync(new URL(import.meta.url), "utf8")),
  transcript_implementation_sha256: sha256Hex(readFileSync(
    new URL("../lib/benchmark/kernel-transcript.ts", import.meta.url),
    "utf8"
  )),
  gateway_implementation_sha256: sha256Hex(readFileSync(
    new URL("../lib/benchmark/gateway-kernel.ts", import.meta.url),
    "utf8"
  )),
});
const worldReference = first.transcriptReference;
const memoryReference = memory.transcriptReference;
const semantic = {
  schema_version: 2,
  benchmark: "kernel_transcript_public_commitment_replay_engineering_sensitivity",
  public_view: "public_commitment",
  restricted_exact_view_is_public_claim_evidence: false,
  invocations: INVOCATIONS,
  transcript_entries: worldReference.transcript_entry_count,
  transcript_head_sha256: worldReference.transcript_head_sha256,
  transcript_sha256: worldReference.transcript_sha256,
  canonical_bytes_sha256: sha256Hex(first.encoded),
  transcript_bytes: worldReference.byte_length,
  final_world_events: first.world.events.length,
  repeated_full_world_state_bytes: first.repeatedFullStateBytes,
  delta_encoding_reduction_fraction: Number(
    (1 - worldReference.byte_length / first.repeatedFullStateBytes).toFixed(6)
  ),
  deterministic_byte_match: deterministic,
  replay_verified: verified,
  verifier_authenticity: "signed_attestation_verified",
  raw_grants_exposed: 0,
  mutations_detected: mutations.filter((result) => !result.valid).length,
  mutations_attempted: mutations.length,
  durable_memory: {
    invocations: INVOCATIONS,
    transcript_entries: memoryReference.transcript_entry_count,
    transcript_head_sha256: memoryReference.transcript_head_sha256,
    transcript_sha256: memoryReference.transcript_sha256,
    canonical_bytes_sha256: sha256Hex(memory.encoded),
    transcript_bytes: memoryReference.byte_length,
    deterministic_byte_match: memory.encoded === memorySecond.encoded,
    replay_verified: memoryVerification.valid,
    verifier_authenticity: memoryVerification.authenticity,
    revision: memoryVerification.reconstructed.durable_memory_head?.revision ?? null,
    final_entry_count: memoryVerification.reconstructed.durable_memory_head?.entry_count ?? null,
    private_key_or_value_preimages_exposed: 0,
  },
  source_hashes: sourceHashes,
};
const result = {
  ...semantic,
  semantic_result_sha256: sha256Hex(canonicalJson(semantic)),
  timing_ms: {
    world_build: Number(worldBuildMs.toFixed(3)),
    verification_repetitions: VERIFY_REPETITIONS,
    verification_p50: Number(percentile(verifyMs, 0.5).toFixed(3)),
    verification_p95: Number(percentile(verifyMs, 0.95).toFixed(3)),
    verification_max: Number(Math.max(...verifyMs).toFixed(3)),
    durable_memory_build: Number(memoryBuildMs.toFixed(3)),
    durable_memory_verification_repetitions: MEMORY_VERIFY_REPETITIONS,
    durable_memory_verification_p50: Number(percentile(memoryVerifyMs, 0.5).toFixed(3)),
    durable_memory_verification_max: Number(Math.max(...memoryVerifyMs).toFixed(3)),
  },
  caveat: "Deterministic offline engineering evidence. This measures signed replay-proof integrity and scaling, not provider or model quality.",
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

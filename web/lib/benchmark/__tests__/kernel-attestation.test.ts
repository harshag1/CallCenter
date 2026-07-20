import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import scenarioJson from "../../../../benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json";
import { createFlowExecutionState, flowCapabilityScope } from "../../flow-runtime";
import { compileConditionSuite, type CompiledBenchmarkCondition } from "../condition-compiler";
import { industrialFieldServiceCompilerInput } from "../industrial-field-service-source";
import {
  benchmarkKernelAttestationHash,
  benchmarkKernelAttestationJson,
  benchmarkKernelAttestationPublicKeyFingerprint,
  createBenchmarkKernelAttestationSigner,
  createBenchmarkKernelCapabilityHead,
  createBenchmarkKernelFinalAttestation,
  verifyBenchmarkKernelFinalAttestation,
  type BenchmarkKernelAttestationExpectation,
  type BenchmarkKernelAttestationTrust,
  type BenchmarkKernelEvidenceBinding,
  type BenchmarkKernelFinalAttestation,
} from "../kernel-attestation";
import { BenchmarkScenarioSchema } from "../scenario-schema";
import { createToolWorld, type ToolWorldState } from "../tool-world";
import type { KernelTranscriptReference } from "../kernel-transcript";

type DeepMutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
      : T;

const scenario = BenchmarkScenarioSchema.parse(scenarioJson);
const suite = compileConditionSuite(industrialFieldServiceCompilerInput(scenario));
const keyPair = generateKeyPairSync("ed25519");
const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const signer = createBenchmarkKernelAttestationSigner({
  keyId: "kernel-test-key-v1",
  privateKeyPem,
  publicKeyPem,
});
const trust: BenchmarkKernelAttestationTrust = Object.freeze({
  keyId: signer.keyId,
  publicKeySha256: signer.publicKeySha256,
  publicKeyPem,
});
const evidenceBinding: BenchmarkKernelEvidenceBinding = Object.freeze({
  pairId: "pair-attestation-001",
  leaseSubjectId: "lease-subject-attestation-001",
  provider: "offline",
  model: "deterministic-offline-v1",
  planSha256: "1".repeat(64),
  freezeLockSha256: "2".repeat(64),
  kernelBuildSha256: "3".repeat(64),
});
const transcriptReference: KernelTranscriptReference = Object.freeze({
  schema_version: 1,
  transcript_type: "benchmark_kernel_replay_public_commitment",
  encoding: "canonical-jsonl-public-commitment",
  view: "public_commitment",
  transcript_entry_count: 3,
  transcript_head_sha256: "4".repeat(64),
  transcript_sha256: "5".repeat(64),
  byte_length: 12_345,
});

function mutable<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>;
}

function expected(
  runId: string,
  condition: CompiledBenchmarkCondition,
  world: ToolWorldState,
  overrides: Partial<Pick<
    BenchmarkKernelAttestationExpectation,
    "evidenceBinding" | "trust" | "transcriptReference"
  >> = {}
): BenchmarkKernelAttestationExpectation {
  return {
    runId,
    condition,
    scenario,
    world,
    transcriptReference: overrides.transcriptReference ?? transcriptReference,
    evidenceBinding: overrides.evidenceBinding ?? evidenceBinding,
    trust: overrides.trust ?? trust,
  };
}

function enforcedAttestation() {
  const condition = suite.conditions["full-harness"];
  const world = createToolWorld(scenario);
  const flowState = createFlowExecutionState("2026-07-10T12:00:00.000Z");
  const capabilityHead = createBenchmarkKernelCapabilityHead({
    condition,
    epoch: flowState.capabilityEpoch,
    target: "$base",
    catalogMode: "target",
    internalFlowScope: flowCapabilityScope(flowState).step,
  });
  const attestation = createBenchmarkKernelFinalAttestation({
    runId: "run-attestation-enforced",
    condition,
    scenario,
    world,
    capabilityHead,
    flowState,
    transcriptReference,
    evidenceBinding,
    signer,
  });
  return { condition, world, flowState, capabilityHead, attestation };
}

describe("benchmark kernel final attestation", () => {
  it("signs an enforced run over exact plan, provider, compiler, world, capability, and Flow bindings", () => {
    const { condition, world, attestation } = enforcedAttestation();
    const verification = verifyBenchmarkKernelFinalAttestation(
      attestation,
      expected("run-attestation-enforced", condition, world)
    );

    expect(verification).toEqual({
      valid: true,
      expected_attestation_hash: attestation.attestation_hash,
      signature_verified: true,
      errors: [],
    });
    expect(attestation.bindings).toMatchObject({
      run_id: "run-attestation-enforced",
      condition_id: "full-harness",
      condition_hash: condition.conditionHash,
      source_hash: condition.sourceHash,
      scenario_hash: condition.scenarioHash,
      flow_hash: condition.flowHash,
      scenario_id: scenario.id,
      scenario_version: scenario.version,
      tool_world_scenario_hash: world.scenario_hash,
      pair_id: evidenceBinding.pairId,
      lease_subject_id: evidenceBinding.leaseSubjectId,
      provider: evidenceBinding.provider,
      model: evidenceBinding.model,
      plan_sha256: evidenceBinding.planSha256,
      freeze_lock_sha256: evidenceBinding.freezeLockSha256,
      kernel_build_sha256: evidenceBinding.kernelBuildSha256,
      signing_key_id: signer.keyId,
      signing_public_key_sha256: signer.publicKeySha256,
    });
    expect(attestation.world_head).toMatchObject({
      event_count: 1,
      next_event_sequence: 2,
      latest_event_sequence: 1,
      latest_event_id: "evt_000001",
      latest_event_type: "world.initialized",
      admission_count: 0,
      receipt_count: 0,
      effect_count: 0,
    });
    expect(attestation.capability_head).toMatchObject({
      epoch: 0,
      target: "$base",
      catalog_mode: "target",
      provider_grant_scope: "$base",
      internal_flow_scope: "$flow.routing",
      action_count: attestation.capability_head.catalog.length,
    });
    expect(attestation.flow_proof).toMatchObject({
      applicability: "flow_v2_enforced",
      execution_state: { version: 2, capabilityEpoch: 0, revision: 0 },
      checkpoint_count: 0,
      action_receipt_count: 0,
    });
    expect(attestation.flow_proof.execution_state_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(attestation.flow_proof.checkpoint_ledger_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(attestation.flow_proof.action_receipt_ledger_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(attestation.signature).toMatchObject({
      algorithm: "ed25519",
      key_id: signer.keyId,
      signature_base64: expect.any(String),
    });
    expect(attestation.transcript_reference).toEqual(transcriptReference);
    expect(Buffer.from(attestation.signature.signature_base64, "base64")).toHaveLength(64);
    expect(benchmarkKernelAttestationJson(attestation)).toBe(`${JSON.stringify(attestation)}\n`);
    expect(Object.isFrozen(attestation)).toBe(true);
    expect(Object.isFrozen(attestation.flow_proof.execution_state)).toBe(true);
  });

  it("signs exactly one canonical transcript reference and rejects mutation, substitution, or omission", () => {
    const { condition, world, attestation } = enforcedAttestation();
    const expectation = expected("run-attestation-enforced", condition, world);

    const substitutedReference: KernelTranscriptReference = {
      ...transcriptReference,
      transcript_head_sha256: "6".repeat(64),
      transcript_sha256: "7".repeat(64),
    };
    const substitution = verifyBenchmarkKernelFinalAttestation(
      attestation,
      expected("run-attestation-enforced", condition, world, {
        transcriptReference: substitutedReference,
      })
    );
    expect(substitution).toMatchObject({ valid: false, signature_verified: true });
    expect(substitution.errors).toContain(
      "transcript_reference differs from the expected kernel transcript"
    );

    const mutated = mutable(attestation);
    mutated.transcript_reference.transcript_head_sha256 = "8".repeat(64);
    const mutation = verifyBenchmarkKernelFinalAttestation(mutated, expectation);
    expect(mutation).toMatchObject({ valid: false, signature_verified: true });
    expect(mutation.errors).toEqual(expect.arrayContaining([
      "attestation_hash mismatch",
      "transcript_reference differs from the expected kernel transcript",
    ]));

    const rehashed = mutable(attestation);
    rehashed.transcript_reference.transcript_sha256 = "9".repeat(64);
    rehashed.attestation_hash = benchmarkKernelAttestationHash(rehashed);
    const rehashedMutation = verifyBenchmarkKernelFinalAttestation(rehashed, expectation);
    expect(rehashedMutation).toMatchObject({ valid: false, signature_verified: false });
    expect(rehashedMutation.errors).toEqual(expect.arrayContaining([
      "kernel attestation signature verification failed",
      "transcript_reference differs from the expected kernel transcript",
    ]));

    const missing = mutable(attestation) as unknown as {
      transcript_reference?: KernelTranscriptReference;
      [key: string]: unknown;
    };
    delete missing.transcript_reference;
    expect(verifyBenchmarkKernelFinalAttestation(missing, expectation)).toMatchObject({
      valid: false,
      signature_verified: false,
      errors: ["kernel attestation has missing or unsupported fields"],
    });
  });

  it("uses an explicit null proof for raw arms while signing their exact static catalog and world head", () => {
    const condition = suite.conditions["raw-full"];
    const world = createToolWorld(scenario);
    const capabilityHead = createBenchmarkKernelCapabilityHead({
      condition,
      epoch: 7,
      target: "$full-catalog",
      catalogMode: "target",
      internalFlowScope: null,
    });
    const attestation = createBenchmarkKernelFinalAttestation({
      runId: "run-attestation-raw",
      condition,
      scenario,
      world,
      capabilityHead,
      flowState: null,
      transcriptReference,
      evidenceBinding,
      signer,
    });

    expect(attestation.flow_proof).toEqual({
      applicability: "not_applicable_unenforced",
      execution_state: null,
      execution_state_sha256: null,
      checkpoint_ledger_sha256: null,
      action_receipt_ledger_sha256: null,
      checkpoint_count: null,
      action_receipt_count: null,
    });
    expect(verifyBenchmarkKernelFinalAttestation(
      attestation,
      expected("run-attestation-raw", condition, world)
    )).toMatchObject({ valid: true, signature_verified: true });
    expect(() => createBenchmarkKernelFinalAttestation({
      runId: "run-attestation-raw",
      condition,
      scenario,
      world,
      capabilityHead,
      flowState: createFlowExecutionState("2026-07-10T12:00:00.000Z"),
      transcriptReference,
      evidenceBinding,
      signer,
    })).toThrow(/cannot attest a FlowExecutionState/);
  });

  it("authenticates the body hash and detects both unrehashed and rehashed body tampering", () => {
    const { condition, world, attestation } = enforcedAttestation();
    const expectation = expected("run-attestation-enforced", condition, world);

    const unrehashed = mutable(attestation);
    unrehashed.capability_head.target = "topic:field_service";
    const unrehashedVerification = verifyBenchmarkKernelFinalAttestation(unrehashed, expectation);
    expect(unrehashedVerification.valid).toBe(false);
    expect(unrehashedVerification.signature_verified).toBe(true);
    expect(unrehashedVerification.errors).toContain("attestation_hash mismatch");

    const rehashed = mutable(attestation);
    rehashed.bindings.run_id = "different-run";
    rehashed.attestation_hash = benchmarkKernelAttestationHash(rehashed);
    const rehashedVerification = verifyBenchmarkKernelFinalAttestation(rehashed, expectation);
    expect(rehashedVerification.valid).toBe(false);
    expect(rehashedVerification.signature_verified).toBe(false);
    expect(rehashedVerification.errors).toEqual(expect.arrayContaining([
      "attestation bindings differ from the expected run inputs",
      "kernel attestation signature verification failed",
    ]));

    const signatureTamper = mutable(attestation);
    const signatureBytes = Buffer.from(signatureTamper.signature.signature_base64, "base64");
    signatureBytes[0] ^= 1;
    signatureTamper.signature.signature_base64 = signatureBytes.toString("base64");
    expect(verifyBenchmarkKernelFinalAttestation(signatureTamper, expectation)).toMatchObject({
      valid: false,
      signature_verified: false,
      errors: ["kernel attestation signature verification failed"],
    });
  });

  it("fails closed when authentic evidence is evaluated against another plan, world, condition, or trust root", () => {
    const { condition, world, attestation } = enforcedAttestation();
    const otherEvidence = { ...evidenceBinding, planSha256: "9".repeat(64) };
    const bindingVerification = verifyBenchmarkKernelFinalAttestation(
      attestation,
      expected("run-attestation-enforced", condition, world, { evidenceBinding: otherEvidence })
    );
    expect(bindingVerification).toMatchObject({ valid: false, signature_verified: true });
    expect(bindingVerification.errors).toContain("attestation bindings differ from the expected run inputs");

    const wrongWorld = mutable(world);
    wrongWorld.facts.pressure_limit_psi = 999;
    const worldVerification = verifyBenchmarkKernelFinalAttestation(
      attestation,
      expected("run-attestation-enforced", condition, wrongWorld as ToolWorldState)
    );
    expect(worldVerification.valid).toBe(false);
    expect(worldVerification.errors.join(" ")).toMatch(/replay|world|facts/i);

    const tamperedCondition = mutable(condition) as DeepMutable<CompiledBenchmarkCondition>;
    tamperedCondition.sourceHash = "0".repeat(64);
    const conditionVerification = verifyBenchmarkKernelFinalAttestation(
      attestation,
      expected("run-attestation-enforced", tamperedCondition, world)
    );
    expect(conditionVerification.valid).toBe(false);
    expect(conditionVerification.errors.join(" ")).toMatch(/condition hash/i);

    const otherKeys = generateKeyPairSync("ed25519");
    const otherPublicPem = otherKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const otherTrust: BenchmarkKernelAttestationTrust = {
      keyId: "untrusted-kernel-key",
      publicKeySha256: benchmarkKernelAttestationPublicKeyFingerprint(otherPublicPem),
      publicKeyPem: otherPublicPem,
    };
    const trustVerification = verifyBenchmarkKernelFinalAttestation(
      attestation,
      expected("run-attestation-enforced", condition, world, { trust: otherTrust })
    );
    expect(trustVerification).toMatchObject({ valid: false, signature_verified: false });
    expect(trustVerification.errors).toEqual(expect.arrayContaining([
      "attestation bindings differ from the expected run inputs",
      "attestation signing identity differs from the configured trust key",
    ]));
  });

  it("recomputes full Flow ledgers and exact compiler capability catalogs instead of trusting self-consistent claims", () => {
    const { condition, world, flowState, capabilityHead, attestation } = enforcedAttestation();
    const expectation = expected("run-attestation-enforced", condition, world);

    const flowTamper = mutable(attestation);
    if (flowTamper.flow_proof.execution_state === null) throw new Error("expected enforced flow proof");
    flowTamper.flow_proof.execution_state.revision += 1;
    flowTamper.attestation_hash = benchmarkKernelAttestationHash(flowTamper);
    const flowVerification = verifyBenchmarkKernelFinalAttestation(flowTamper, expectation);
    expect(flowVerification.valid).toBe(false);
    expect(flowVerification.errors.join(" ")).toMatch(/flow_proof/);

    const catalogTamper = mutable(attestation);
    catalogTamper.capability_head.catalog[0].semantic_hash = "0".repeat(64);
    catalogTamper.attestation_hash = benchmarkKernelAttestationHash(catalogTamper);
    const catalogVerification = verifyBenchmarkKernelFinalAttestation(catalogTamper, expectation);
    expect(catalogVerification.valid).toBe(false);
    expect(catalogVerification.errors.join(" ")).toMatch(/catalog/i);

    expect(() => createBenchmarkKernelFinalAttestation({
      runId: "run-attestation-enforced",
      condition,
      scenario,
      world,
      capabilityHead: { ...capabilityHead, epoch: 1 },
      flowState,
      transcriptReference,
      evidenceBinding,
      signer,
    })).toThrow(/capability epoch/);
    expect(() => createBenchmarkKernelFinalAttestation({
      runId: "run-attestation-enforced",
      condition,
      scenario,
      world,
      capabilityHead: { ...capabilityHead, internal_flow_scope: "$flow.active" },
      flowState,
      transcriptReference,
      evidenceBinding,
      signer,
    })).toThrow(/internal Flow scope/);

    const topicHead = createBenchmarkKernelCapabilityHead({
      condition,
      epoch: flowState.capabilityEpoch,
      target: "topic:field_service",
      catalogMode: "target",
      internalFlowScope: flowCapabilityScope(flowState).step,
    });
    expect(() => createBenchmarkKernelFinalAttestation({
      runId: "run-attestation-enforced",
      condition,
      scenario,
      world,
      capabilityHead: topicHead,
      flowState,
      transcriptReference,
      evidenceBinding,
      signer,
    })).toThrow(/routing Flow state/);
  });

  it("models post-step and terminal snapshots as exact compiler-derived catalogs", () => {
    const condition = suite.conditions["full-harness"];
    const topic = condition.disclosures.find((entry) => entry.target === "topic:field_service");
    if (!topic) throw new Error("fixture lacks field_service topic disclosure");
    const expectedTopicCatalog = topic.visibleCapabilities
      .map((capability) => ({ name: capability.name, semantic_hash: capability.semanticHash }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const postStep = createBenchmarkKernelCapabilityHead({
      condition,
      epoch: 8,
      target: "topic:field_service",
      catalogMode: "post_step_transition",
      internalFlowScope: "$flow.field_service",
    });
    const terminal = createBenchmarkKernelCapabilityHead({
      condition,
      epoch: 9,
      target: "topic:field_service",
      catalogMode: "terminal",
      internalFlowScope: "$flow.completed",
    });

    expect(postStep.catalog).toEqual(expectedTopicCatalog);
    expect(postStep.provider_grant_scope).toBe("topic:field_service");
    expect(terminal.catalog.map((entry) => entry.name)).toEqual(["flow.get_state"]);
    expect(terminal.provider_grant_scope).toBe("topic:field_service");
    expect(() => createBenchmarkKernelCapabilityHead({
      condition,
      epoch: 9,
      target: "$terminal",
      catalogMode: "terminal",
      internalFlowScope: "$flow.completed",
    })).toThrow(/retain a compiled topic target/);
  });

  it("strictly parses the artifact and refuses malformed signatures, extra fields, and invalid serialization", () => {
    const { condition, world, attestation } = enforcedAttestation();
    const expectation = expected("run-attestation-enforced", condition, world);

    const extraKey = mutable(attestation) as DeepMutable<BenchmarkKernelFinalAttestation> & { unexpected?: boolean };
    extraKey.unexpected = true;
    expect(verifyBenchmarkKernelFinalAttestation(extraKey, expectation).errors).toContain(
      "kernel attestation has missing or unsupported fields"
    );

    const malformedSignature = mutable(attestation);
    malformedSignature.signature.signature_base64 = "not-canonical-base64";
    const malformedVerification = verifyBenchmarkKernelFinalAttestation(malformedSignature, expectation);
    expect(malformedVerification).toMatchObject({ valid: false, signature_verified: false });
    expect(malformedVerification.errors.join(" ")).toMatch(/canonical 64-byte Ed25519 signature/);

    const invalidHash = mutable(attestation);
    invalidHash.world_head.receipt_count += 1;
    expect(() => benchmarkKernelAttestationJson(invalidHash)).toThrow(/invalid hash/);
  });

  it("derives and validates an Ed25519 signer without accepting mismatched or non-Ed25519 keys", () => {
    expect(signer.publicKeySha256).toBe(benchmarkKernelAttestationPublicKeyFingerprint(publicKeyPem));
    expect(() => benchmarkKernelAttestationPublicKeyFingerprint(privateKeyPem)).toThrow(/canonical SPKI PEM/);
    const other = generateKeyPairSync("ed25519");
    const otherPublicPem = other.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => createBenchmarkKernelAttestationSigner({
      keyId: "kernel-test-key-v1",
      privateKeyPem,
      publicKeyPem: otherPublicPem,
    })).toThrow(/does not match/);

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPrivatePem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => createBenchmarkKernelAttestationSigner({
      keyId: "rsa-is-not-allowed",
      privateKeyPem: rsaPrivatePem,
    })).toThrow(/must be Ed25519/);
  });
});

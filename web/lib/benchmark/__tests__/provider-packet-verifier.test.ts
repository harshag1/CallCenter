import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, createRunManifest, sha256Hex, type ArtifactDescriptor } from "../artifacts";
import {
  buildProviderTransportEvidence,
  type ProviderNormalizedWireLink,
} from "../provider-transport-evidence";
import {
  createPlanPinnedProviderTransportReceiptVerifier,
  deriveExpectedProviderTransportPacketVerificationInput,
  reopenAndVerifyProviderPacket,
  type ProviderPacketBinding,
  type ProviderPacketTrustPolicy,
} from "../provider-packet-verifier";
import {
  benchmarkKernelAttestationHash,
  type BenchmarkKernelFinalAttestation,
} from "../kernel-attestation";
import {
  providerReadOnlyReceiptLinkageSha256,
  type ProviderReadOnlyReceiptLinkage,
} from "../provider-receipt-linkage";
import {
  createProviderTransportPacket,
  createProviderTransportPacketSigner,
  providerTransportEvidenceDescriptorSha256,
  providerTransportPacketPublicKeyFingerprint,
  serializeProviderTransportPacket,
  type ProviderTransportPacketSubject,
} from "../provider-transport-packet-signature";
import {
  realtimeWireObservationReference,
  realtimeWireObservationSha256,
  realtimeWireProjectionSha256,
} from "../../realtime/client/wire-evidence";
import type {
  RealtimeWireObservation,
  SessionConfigurationAcknowledgement,
} from "../../realtime/client/types";

const temporaryRoots: string[] = [];
const H = (character: string): string => character.repeat(64);
const MODEL = "gpt-realtime-2.1";
const RUN_ID = "provider-packet-test";
const PAIR_ID = "transport-smoke-pair";
const PLAN_SHA256 = H("1");
const FREEZE_LOCK_SHA256 = H("2");
const TRANSCRIPT_ARTIFACT_DOMAIN =
  "harshas-amazing-call-center/benchmark-kernel-transcript-artifact/v1\n";
const packetKeys = generateKeyPairSync("ed25519");
const PACKET_PUBLIC_KEY_PEM = packetKeys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const PACKET_TRUST = Object.freeze({
  keyId: "gate0-provider-packet-test-v1",
  publicKeySha256: providerTransportPacketPublicKeyFingerprint(PACKET_PUBLIC_KEY_PEM),
  publicKeyPem: PACKET_PUBLIC_KEY_PEM,
});
const LIMITS = Object.freeze({
  maxTurns: 1,
  maxSessionMs: 10_000,
  maxInputAudioBytes: 4_096,
  maxOutputAudioBytes: 4_096,
  maxToolCalls: 1,
  sessionReadyTimeoutMs: 1_000,
  responseTimeoutMs: 2_000,
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function verifiedConfiguration(): SessionConfigurationAcknowledgement {
  const verified = (character: string) => Object.freeze({
    status: "verified" as const,
    requestedSha256: H(character),
    acknowledgedSha256: H(character),
    acknowledgedBy: "session.updated" as const,
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    strictParityVerified: true,
    paidBenchmarkReady: true,
    session: verified("0"),
    fields: Object.freeze({
      model: verified("1"),
      voice: verified("2"),
      instructions: verified("3"),
      tools: verified("4"),
      tool_choice: verified("5"),
      input_audio: verified("6"),
      output_audio: verified("7"),
      turn_detection: verified("8"),
    }),
  });
}

function wire(): RealtimeWireObservation[] {
  const callId = H("a");
  const entries = [
    {
      direction: "outbound" as const,
      wireType: "session.update",
      projection: {
        session: {
          present: true,
          fieldSha256: {
            model: H("1"),
            voice: H("2"),
            instructions: H("3"),
            tools: H("4"),
            tool_choice: H("5"),
            input_audio: H("6"),
            output_audio: H("7"),
            turn_detection: H("8"),
          },
        },
      },
    },
    {
      direction: "inbound" as const,
      wireType: "session.updated",
      sessionIdSha256: H("d"),
      projection: {
        session: {
          acknowledgement: "ready",
          fieldSha256: {
            model: H("1"),
            voice: H("2"),
            instructions: H("3"),
            tools: H("4"),
            tool_choice: H("5"),
            input_audio: H("6"),
            output_audio: H("7"),
            turn_detection: H("8"),
          },
        },
      },
    },
    {
      direction: "outbound" as const,
      wireType: "input_audio_buffer.append",
      projection: { audio: { direction: "input", byteLength: 4, sha256: H("b") } },
    },
    {
      direction: "inbound" as const,
      wireType: "response.function_call_arguments.done",
      callIdSha256: callId,
      projection: { gatewayCalls: [{ gateway: "capability_gateway", callIdSha256: callId }] },
    },
    {
      direction: "outbound" as const,
      wireType: "conversation.item.create",
      callIdSha256: callId,
      projection: { gatewayResults: [{ gateway: "capability_gateway", callIdSha256: callId }] },
    },
    {
      direction: "inbound" as const,
      wireType: "response.output_audio.delta",
      projection: { audio: { direction: "output", byteLength: 4, sha256: H("c") } },
    },
    {
      direction: "inbound" as const,
      wireType: "response.done",
      projection: { usage: { totalTokens: 2 } },
    },
    {
      direction: "inbound" as const,
      wireType: "response.done",
      projection: { terminal: { status: "completed" } },
    },
  ];
  let previous: string | null = null;
  return entries.map((entry, index) => {
    const projectionSha256 = realtimeWireProjectionSha256(entry.projection);
    const core = {
      schemaVersion: 1 as const,
      provider: "openai" as const,
      direction: entry.direction,
      connectionEpoch: 1,
      sequence: index + 1,
      observedAtMs: 1_000 + index,
      observedAtMonotonicMs: 100 + index,
      wireType: entry.wireType,
      payloadSha256: H(String((index + 1) % 10)),
      payloadBytes: 10 + index,
      projectionSha256,
      previousObservationSha256: previous,
      identities: Object.freeze({
        ...("callIdSha256" in entry ? { callIdSha256: entry.callIdSha256 } : {}),
        ...("sessionIdSha256" in entry ? { sessionIdSha256: entry.sessionIdSha256 } : {}),
      }),
      projection: Object.freeze(entry.projection),
    };
    const observation = Object.freeze({
      ...core,
      observationSha256: realtimeWireObservationSha256(core),
    });
    previous = observation.observationSha256;
    return observation;
  });
}

function links(observations: readonly RealtimeWireObservation[]): ProviderNormalizedWireLink[] {
  const types = [
    "provider.event",
    "session.ready",
    "provider.event",
    "tool.calls",
    "tool.dispatch",
    "output.audio",
    "usage",
    "response.completed",
  ];
  return types.map((type, index) => Object.freeze({
    normalized_sequence: index + 1,
    normalized_type: type,
    wire_type: observations[index]!.wireType,
    attribution: realtimeWireObservationReference(observations[index]!),
  }));
}

function trialDescriptor(path: string, content: string, mediaType = "application/json"): ArtifactDescriptor {
  return Object.freeze({
    path,
    media_type: mediaType,
    byte_length: Buffer.byteLength(content),
    sha256: sha256Hex(content),
  });
}

type Fixture = Readonly<{
  root: string;
  receipt: string;
  bindingSeen: { current: ProviderPacketBinding | null };
}>;

async function fixture(options: Readonly<{
  finalizedStatus?: string;
  includeReceipt?: boolean;
  dummyEvidenceDescriptor?: boolean;
}> = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "hacc-provider-packet-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "final"), { recursive: true });
  const observations = wire();
  const usageEvents = [{ totalTokens: 2, raw: { total_tokens: 2 } }];
  const evidence = buildProviderTransportEvidence({
    provider: "openai",
    model: MODEL,
    sessionReady: true,
    sessionIdSha256: H("d"),
    sessionConfiguration: verifiedConfiguration(),
    wireObservations: observations,
    normalizedLinks: links(observations),
    inputAudio: [{
      ordinal: 1,
      byte_length: 4,
      sha256: H("b"),
      sample_rate_hz: 24_000,
      channels: 1,
      encoding: "pcm16",
    }],
    outputAudio: [{
      ordinal: 1,
      byte_length: 4,
      sha256: H("c"),
      sample_rate_hz: 24_000,
      channels: 1,
      encoding: "pcm16",
    }],
    normalizedToolCallCount: 1,
    kernelInvocationCount: 1,
    usage: usageEvents,
    normalizedTerminalCount: 1,
    limits: LIMITS,
    elapsedMs: 500,
  });
  const evidenceText = `${canonicalJson(evidence)}\n`;
  const wireText = `${observations.map((entry) => canonicalJson(entry)).join("\n")}\n`;
  const usageText = `${canonicalJson({
    schema_version: 1,
    events: [{ usage: usageEvents[0] }],
  })}\n`;
  const transcriptEntry = Object.freeze({
    schema_version: 1,
    transcript_type: "benchmark_kernel_replay_public_commitment",
    run_id: RUN_ID,
    sequence: 0,
    previous_entry_sha256: null,
    operation: "initialize",
    payload: {},
    entry_sha256: H("e"),
  });
  const transcriptText = `${canonicalJson(transcriptEntry)}\n`;
  const transcriptReference = Object.freeze({
    schema_version: 1,
    transcript_type: "benchmark_kernel_replay_public_commitment",
    encoding: "canonical-jsonl-public-commitment",
    view: "public_commitment",
    transcript_entry_count: 1,
    transcript_head_sha256: transcriptEntry.entry_sha256,
    transcript_sha256: sha256Hex(`${TRANSCRIPT_ARTIFACT_DOMAIN}${transcriptText}`),
    byte_length: Buffer.byteLength(transcriptText),
  });
  const attestationWithoutHash = {
    schema_version: 1,
    attestation_type: "benchmark_kernel_final_state",
    bindings: {
      run_id: RUN_ID,
      condition_id: "full-harness",
      condition_hash: H("0"),
      source_hash: H("1"),
      scenario_hash: H("2"),
      flow_hash: H("3"),
      scenario_id: "transport-smoke-v1",
      scenario_version: "1.0.0",
      tool_world_scenario_hash: `sha256:${H("4")}`,
      pair_id: PAIR_ID,
      lease_subject_id: PAIR_ID,
      provider: "openai",
      model: MODEL,
      plan_sha256: PLAN_SHA256,
      freeze_lock_sha256: FREEZE_LOCK_SHA256,
      kernel_build_sha256: H("5"),
      signing_key_id: PACKET_TRUST.keyId,
      signing_public_key_sha256: PACKET_TRUST.publicKeySha256,
    },
    world_head: {},
    capability_head: {},
    flow_proof: {},
    transcript_reference: transcriptReference,
  };
  const attestationHash = benchmarkKernelAttestationHash(
    attestationWithoutHash as unknown as BenchmarkKernelFinalAttestation,
  );
  const attestation = {
    ...attestationWithoutHash,
    attestation_hash: attestationHash,
    signature: {
      algorithm: "ed25519",
      key_id: PACKET_TRUST.keyId,
      signature_base64: "AA==",
    },
  } as unknown as BenchmarkKernelFinalAttestation;
  const attestationText = `${canonicalJson(attestation)}\n`;
  const linkageBody = {
    schema_version: 1,
    linkage_type: "provider_read_only_toolworld_receipt",
    run_id: RUN_ID,
    provider_call_id: "transport-smoke-call-001",
    transcript_sequence: 0,
    transcript_entry_sha256: transcriptEntry.entry_sha256,
    transcript_reference: transcriptReference,
    kernel_attestation_hash: attestationHash,
    invocation_id: "provider_call_fixture",
    receipt_id: "receipt_fixture",
    receipt_sha256: H("6"),
    tool: "read_service_status",
    turn: 1,
    safety_proof: {
      tool_kind: "query",
      declared_effect_count: 0,
      committed: false,
      receipt_effect_count: 0,
      world_effect_count: 0,
      tainted_result_path_count: 0,
      outcome_class: "success_executed",
    },
  };
  const linkageWithPlaceholder = {
    ...linkageBody,
    linkage_sha256: H("0"),
  } as unknown as ProviderReadOnlyReceiptLinkage;
  const linkage = {
    ...linkageBody,
    linkage_sha256: providerReadOnlyReceiptLinkageSha256(linkageWithPlaceholder),
  } as unknown as ProviderReadOnlyReceiptLinkage;
  const linkageText = `${canonicalJson(linkage)}\n`;
  const trialManifest = createRunManifest({
    run_id: RUN_ID,
    created_at: "2026-07-19T12:00:00.000Z",
    artifacts: [
      trialDescriptor("provider-transport-evidence.json", evidenceText),
      trialDescriptor("provider-wire-observations.jsonl", wireText, "application/x-ndjson"),
      trialDescriptor("usage.json", usageText),
      trialDescriptor("provider-read-only-receipt-linkage.json", linkageText),
      trialDescriptor("kernel-attestation.json", attestationText),
      trialDescriptor("kernel-transcript.jsonl", transcriptText, "application/x-ndjson"),
    ],
    event_log: null,
    metadata: {
      pair_id: PAIR_ID,
      provider: "openai",
      model: MODEL,
      status: "completed",
      execution_plan_sha256: PLAN_SHA256,
      freeze_lock_hash: FREEZE_LOCK_SHA256,
    },
  });
  const trialManifestText = `${canonicalJson(trialManifest)}\n`;
  const receipt = "signed-receipt-fixture\n";
  const persisted = [
    {
      path: "final/manifest.json",
      byte_length: Buffer.byteLength(trialManifestText),
      sha256: sha256Hex(trialManifestText),
    },
    {
      path: "final/provider-transport-evidence.json",
      byte_length: Buffer.byteLength(evidenceText),
      sha256: options.dummyEvidenceDescriptor ? H("f") : sha256Hex(evidenceText),
    },
    {
      path: "final/provider-wire-observations.jsonl",
      byte_length: Buffer.byteLength(wireText),
      sha256: sha256Hex(wireText),
    },
    {
      path: "final/usage.json",
      byte_length: Buffer.byteLength(usageText),
      sha256: sha256Hex(usageText),
    },
    {
      path: "final/provider-read-only-receipt-linkage.json",
      byte_length: Buffer.byteLength(linkageText),
      sha256: sha256Hex(linkageText),
    },
    {
      path: "final/kernel-attestation.json",
      byte_length: Buffer.byteLength(attestationText),
      sha256: sha256Hex(attestationText),
    },
    {
      path: "final/kernel-transcript.jsonl",
      byte_length: Buffer.byteLength(transcriptText),
      sha256: sha256Hex(transcriptText),
    },
    ...(options.includeReceipt ? [{
      path: "final/provider-packet-receipt.json",
      byte_length: Buffer.byteLength(receipt),
      sha256: sha256Hex(receipt),
    }] : []),
  ];
  const runnerManifestText = `${canonicalJson({
    schema_version: 1,
    manifest_type: "paid_benchmark_completion",
    run_id: RUN_ID,
    trial_manifest: persisted[0],
    kernel_attestation: { path: "final/kernel-attestation.json", attestation_hash: H("e") },
    kernel_transcript: { path: "final/kernel-transcript.jsonl", reference: {} },
    provider_transport_evidence: {
      ...persisted[1],
      wire_observations: persisted[2],
      wire_chain_head_sha256: evidence.wire.chain_head_sha256,
      gate1_transport_smoke_eligible: true,
      claim_boundary: "transport_compatibility_only",
    },
    artifacts: persisted,
  })}\n`;
  await Promise.all([
    writeFile(join(root, "final/manifest.json"), trialManifestText),
    writeFile(join(root, "final/provider-transport-evidence.json"), evidenceText),
    writeFile(join(root, "final/provider-wire-observations.jsonl"), wireText),
    writeFile(join(root, "final/usage.json"), usageText),
    writeFile(join(root, "final/provider-read-only-receipt-linkage.json"), linkageText),
    writeFile(join(root, "final/kernel-attestation.json"), attestationText),
    writeFile(join(root, "final/kernel-transcript.jsonl"), transcriptText),
    writeFile(join(root, "final/runner-manifest.json"), runnerManifestText),
    ...(options.includeReceipt
      ? [writeFile(join(root, "final/provider-packet-receipt.json"), receipt)]
      : []),
  ]);
  await writeFile(join(root, "FINALIZED.json"), `${canonicalJson({
    schema_version: 1,
    run_id: RUN_ID,
    status: options.finalizedStatus ?? "completed",
    sequence: 12,
    journal_head_sha256: H("9"),
    manifest_sha256: sha256Hex(runnerManifestText),
    budget_head_sha256: H("8"),
  })}\n`);
  return Object.freeze({ root, receipt, bindingSeen: { current: null } });
}

async function verify(
  prepared: Fixture,
  trust: ProviderPacketTrustPolicy,
) {
  return reopenAndVerifyProviderPacket({
    complete_directory: prepared.root,
    expected: { run_id: RUN_ID, provider: "openai", model: MODEL },
    trust,
  });
}

async function deriveExpected(prepared: Fixture) {
  return deriveExpectedProviderTransportPacketVerificationInput({
    complete_directory: prepared.root,
    expected: {
      run_id: RUN_ID,
      pair_id: PAIR_ID,
      provider: "openai",
      model: MODEL,
      plan_sha256: PLAN_SHA256,
      freeze_lock_sha256: FREEZE_LOCK_SHA256,
    },
    plan_pinned_trust: PACKET_TRUST,
  });
}

describe("persisted provider packet verifier", () => {
  it("derives the exact signed subject from canonical plan inputs and reopened artifacts", async () => {
    const prepared = await fixture();
    await expect(deriveExpected(prepared)).resolves.toMatchObject({
      expected_subject: {
        plan_sha256: PLAN_SHA256,
        freeze_lock_sha256: FREEZE_LOCK_SHA256,
        provider: "openai",
        model: MODEL,
        run_id: RUN_ID,
        pair_id: PAIR_ID,
        wire_chain_head_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        read_only_receipt_linkage_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        kernel_attestation_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        kernel_transcript_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      plan_pinned_trust: PACKET_TRUST,
      trial_manifest_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      provider_wire_observations_artifact_sha256:
        expect.stringMatching(/^[a-f0-9]{64}$/),
      provider_usage_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("never lets the detached signed packet define its own expected subject", async () => {
    const prepared = await fixture();
    const detachedPacketPath = join(
      prepared.root,
      "final/provider-transport-packet.json",
    );
    await writeFile(detachedPacketPath, "{\"attacker\":\"first\"}\n");
    const before = await deriveExpected(prepared);
    await writeFile(detachedPacketPath, "{\"attacker\":\"substituted\"}\n");
    expect(await deriveExpected(prepared)).toEqual(before);
  });

  it("rejects canonical-plan and reopened-transcript substitution before packet trust", async () => {
    const prepared = await fixture();
    await expect(deriveExpectedProviderTransportPacketVerificationInput({
      complete_directory: prepared.root,
      expected: {
        run_id: RUN_ID,
        pair_id: PAIR_ID,
        provider: "openai",
        model: MODEL,
        plan_sha256: H("f"),
        freeze_lock_sha256: FREEZE_LOCK_SHA256,
      },
      plan_pinned_trust: PACKET_TRUST,
    })).rejects.toThrow("trial metadata differs from the canonical plan");

    const transcriptPath = join(prepared.root, "final/kernel-transcript.jsonl");
    const transcript = await readFile(transcriptPath, "utf8");
    const substitutedTranscript = transcript.replace(
      `"entry_sha256":"${H("e")}"`,
      `"entry_sha256":"${H("f")}"`,
    );
    await writeFile(transcriptPath, substitutedTranscript);
    const manifestPath = join(prepared.root, "final/manifest.json");
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as ReturnType<typeof createRunManifest>;
    const substitutedTranscriptDescriptor = trialDescriptor(
      "kernel-transcript.jsonl",
      substitutedTranscript,
      "application/x-ndjson",
    );
    const substitutedManifest = createRunManifest({
      run_id: manifest.run_id,
      created_at: manifest.created_at,
      artifacts: manifest.artifacts.map((artifact) =>
        artifact.path === substitutedTranscriptDescriptor.path
          ? substitutedTranscriptDescriptor
          : artifact
      ),
      event_log: manifest.event_log,
      metadata: manifest.metadata,
    });
    const substitutedManifestText = `${canonicalJson(substitutedManifest)}\n`;
    await writeFile(manifestPath, substitutedManifestText);
    const runnerPath = join(prepared.root, "final/runner-manifest.json");
    const runner = JSON.parse(await readFile(runnerPath, "utf8")) as {
      trial_manifest: { path: string; byte_length: number; sha256: string };
      artifacts: Array<{ path: string; byte_length: number; sha256: string }>;
      [key: string]: unknown;
    };
    const substitutedPersistedTranscript = {
      path: "final/kernel-transcript.jsonl",
      byte_length: Buffer.byteLength(substitutedTranscript),
      sha256: sha256Hex(substitutedTranscript),
    };
    const substitutedPersistedManifest = {
      path: "final/manifest.json",
      byte_length: Buffer.byteLength(substitutedManifestText),
      sha256: sha256Hex(substitutedManifestText),
    };
    runner.trial_manifest = substitutedPersistedManifest;
    runner.artifacts = runner.artifacts.map((artifact) => {
      if (artifact.path === substitutedPersistedTranscript.path) {
        return substitutedPersistedTranscript;
      }
      if (artifact.path === substitutedPersistedManifest.path) {
        return substitutedPersistedManifest;
      }
      return artifact;
    });
    await writeFile(runnerPath, `${canonicalJson(runner)}\n`);
    await expect(deriveExpected(prepared)).rejects.toThrow(
      "kernel/linkage artifacts differ from the canonical plan",
    );
  });

  it("joins the independently recomputed binding to a plan-pinned packet that directly signs kernel receipt linkage", async () => {
    const keys = generateKeyPairSync("ed25519");
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const trust = {
      keyId: "gate0-provider-packet-test-v1",
      publicKeySha256: providerTransportPacketPublicKeyFingerprint(publicKeyPem),
      publicKeyPem,
    };
    const signer = createProviderTransportPacketSigner({
      keyId: trust.keyId,
      privateKeyPem,
      publicKeyPem,
    });
    const evidenceDescriptor = trialDescriptor(
      "provider-transport-evidence.json",
      "{\"schema_version\":1}\n",
    );
    const subject: ProviderTransportPacketSubject = Object.freeze({
      plan_sha256: H("1"),
      freeze_lock_sha256: H("2"),
      provider: "openai",
      model: MODEL,
      run_id: RUN_ID,
      pair_id: "transport-smoke-pair",
      provider_evidence_descriptor: evidenceDescriptor,
      provider_evidence_descriptor_sha256:
        providerTransportEvidenceDescriptorSha256(evidenceDescriptor),
      wire_chain_head_sha256: H("3"),
      usage_observations_sha256: H("4"),
      input_audio_manifest_sha256: H("5"),
      output_audio_manifest_sha256: H("6"),
      artifact_manifest_sha256: H("7"),
      read_only_receipt_linkage_sha256: H("8"),
      kernel_attestation_hash: H("9"),
      kernel_transcript_sha256: H("a"),
    });
    const packet = createProviderTransportPacket({
      subject,
      signer,
      planPinnedTrust: trust,
    });
    const persisted = {
      trial: H("b"),
      wire: H("c"),
      usage: H("d"),
    };
    const verifier = createPlanPinnedProviderTransportReceiptVerifier({
      expected_subject: subject,
      plan_pinned_trust: trust,
      trial_manifest_artifact_sha256: persisted.trial,
      provider_wire_observations_artifact_sha256: persisted.wire,
      provider_usage_artifact_sha256: persisted.usage,
    });
    const binding: ProviderPacketBinding = Object.freeze({
      schema_version: 1,
      run_id: RUN_ID,
      provider: "openai",
      model_sha256: sha256Hex(
        `harshas-amazing-call-center/provider-model/v1\n${MODEL}`,
      ),
      trial_manifest_sha256: persisted.trial,
      provider_transport_evidence_sha256: evidenceDescriptor.sha256,
      provider_wire_observations_sha256: persisted.wire,
      provider_usage_sha256: persisted.usage,
      wire_chain_head_sha256: subject.wire_chain_head_sha256,
      packet_sha256: H("e"),
    });
    const receipt = Buffer.from(serializeProviderTransportPacket(packet), "utf8");

    expect(await verifier({ receipt, binding })).toMatchObject({
      valid: true,
      errors: [],
      signer_key_id: trust.keyId,
      receipt_sha256: sha256Hex(receipt),
    });
    expect(await verifier({
      receipt,
      binding: { ...binding, provider_usage_sha256: H("f") },
    })).toMatchObject({
      valid: false,
      errors: ["provider_transport_packet_binding:provider_usage_sha256_mismatch"],
    });
  });

  it("recomputes complete transport evidence but does not promote an unsigned packet", async () => {
    const prepared = await fixture();
    const result = await verify(prepared, { mode: "transport_only" });
    expect(result).toMatchObject({
      valid: true,
      transport_valid: true,
      trusted: false,
      gate1_transport_smoke_eligible: false,
      errors: [],
      binding: {
        run_id: RUN_ID,
        provider: "openai",
        packet_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("promotes only a receipt that verifies the independently recomputed binding", async () => {
    const prepared = await fixture({ includeReceipt: true });
    const result = await verify(prepared, {
      mode: "receipt_required",
      receipt_path: "final/provider-packet-receipt.json",
      verify: ({ receipt, binding }) => {
        prepared.bindingSeen.current = binding;
        return {
          valid: new TextDecoder().decode(receipt) === prepared.receipt,
          errors: [],
          signer_key_id: "fixture-ed25519",
          receipt_sha256: sha256Hex(receipt),
        };
      },
    });
    expect(result).toMatchObject({
      valid: true,
      transport_valid: true,
      trusted: true,
      gate1_transport_smoke_eligible: true,
      receipt: { valid: true, signer_key_id: "fixture-ed25519" },
    });
    expect(prepared.bindingSeen.current).toEqual(result.binding);
  });

  it("rejects missing trust receipts, dummy descriptors, and unsettled finalization", async () => {
    const missing = await fixture();
    expect(await verify(missing, {
      mode: "receipt_required",
      receipt_path: "final/provider-packet-receipt.json",
      verify: () => ({ valid: true, errors: [] }),
    })).toMatchObject({
      valid: false,
      gate1_transport_smoke_eligible: false,
      errors: expect.arrayContaining(["provider_packet_receipt_missing"]),
    });

    const dummy = await fixture({ dummyEvidenceDescriptor: true });
    expect(await verify(dummy, { mode: "transport_only" })).toMatchObject({
      valid: false,
      transport_valid: false,
      errors: expect.arrayContaining([
        "persisted_artifact_descriptor_mismatch",
        "runner_trial_descriptor_mismatch",
      ]),
    });

    const unsettled = await fixture({ finalizedStatus: "failed" });
    expect(await verify(unsettled, { mode: "transport_only" })).toMatchObject({
      valid: false,
      transport_valid: false,
      errors: expect.arrayContaining(["run_not_completed"]),
    });
  });

  it("rejects persisted evidence tampering even when a caller supplies a permissive receipt verifier", async () => {
    const prepared = await fixture({ includeReceipt: true });
    const path = join(prepared.root, "final/provider-transport-evidence.json");
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    value.gate1_transport_smoke = {
      eligible: true,
      errors: [],
      claim_boundary: "transport_compatibility_only",
    };
    value.audio = {
      ...(value.audio as Record<string, unknown>),
      output_total_bytes: 99,
    };
    await writeFile(path, `${canonicalJson(value)}\n`);
    const result = await verify(prepared, {
      mode: "receipt_required",
      receipt_path: "final/provider-packet-receipt.json",
      verify: () => ({ valid: true, errors: [] }),
    });
    expect(result.valid).toBe(false);
    expect(result.transport_valid).toBe(false);
    expect(result.gate1_transport_smoke_eligible).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "persisted_artifact_descriptor_mismatch",
      "provider_transport_evidence_recomputation_mismatch",
    ]));
  });
});

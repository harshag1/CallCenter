import { canonicalJson, sha256Hex, verifyRunManifest, type ArtifactDescriptor, type RunManifest } from "./artifacts";
import { readFrozenFixtureFileNoFollow } from "./audio-fixtures";
import {
  verifyProviderTransportEvidence,
  type ProviderTransportEvidence,
} from "./provider-transport-evidence";
import {
  verifyProviderTransportPacket,
  providerTransportEvidenceDescriptorSha256,
  type ProviderTransportPacketSubject,
  type ProviderTransportPacketTrust,
} from "./provider-transport-packet-signature";
import {
  providerReadOnlyReceiptLinkageSha256,
  type ProviderReadOnlyReceiptLinkage,
} from "./provider-receipt-linkage";
import {
  benchmarkKernelAttestationHash,
  type BenchmarkKernelFinalAttestation,
} from "./kernel-attestation";
import { parseKernelTranscript } from "./kernel-transcript";
import type {
  NormalizedRealtimeUsage,
  RealtimeWireObservation,
  ServerRealtimeProvider,
} from "../realtime/client/types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._/@+-]+$/;
const KERNEL_TRANSCRIPT_ARTIFACT_DOMAIN =
  "harshas-amazing-call-center/benchmark-kernel-transcript-artifact/v1\n";

type PersistedDescriptor = Readonly<{
  path: string;
  byte_length: number;
  sha256: string;
}>;

export type ProviderPacketBinding = Readonly<{
  schema_version: 1;
  run_id: string;
  provider: ServerRealtimeProvider;
  model_sha256: string;
  trial_manifest_sha256: string;
  provider_transport_evidence_sha256: string;
  provider_wire_observations_sha256: string;
  provider_usage_sha256: string;
  wire_chain_head_sha256: string;
  packet_sha256: string;
}>;

export type ProviderPacketReceiptVerification = Readonly<{
  valid: boolean;
  errors: readonly string[];
  signer_key_id?: string;
  receipt_sha256?: string;
}>;

/**
 * Signature implementations stay outside the artifact parser. A verifier gets
 * only the frozen receipt bytes and the independently recomputed packet
 * binding, so a future receipt cannot redefine what was signed.
 */
export type ProviderPacketReceiptVerifier = (
  input: Readonly<{
    receipt: Uint8Array;
    binding: ProviderPacketBinding;
  }>,
) => ProviderPacketReceiptVerification | Promise<ProviderPacketReceiptVerification>;

export type PlanPinnedProviderTransportReceiptVerifierInput = Readonly<{
  expected_subject: ProviderTransportPacketSubject;
  plan_pinned_trust: ProviderTransportPacketTrust;
  trial_manifest_artifact_sha256: string;
  provider_wire_observations_artifact_sha256: string;
  provider_usage_artifact_sha256: string;
}>;

export type DeriveExpectedProviderTransportPacketVerificationInput = Readonly<{
  complete_directory: string;
  expected: Readonly<{
    run_id: string;
    pair_id: string;
    provider: ServerRealtimeProvider;
    model: string;
    plan_sha256: string;
    freeze_lock_sha256: string;
  }>;
  plan_pinned_trust: ProviderTransportPacketTrust;
}>;

/**
 * Concrete Gate0 adapter for the detached provider transport packet. The
 * generic reopen verifier independently computes its binding from durable
 * evidence; this adapter joins that binding to the exact plan-pinned Ed25519
 * subject instead of letting receipt bytes define what they are meant to sign.
 *
 * The signed subject directly covers the read-only ToolWorld linkage hash,
 * kernel attestation hash, and kernel transcript hash in addition to provider
 * wire/audio/usage evidence and the complete trial manifest.
 */
export function createPlanPinnedProviderTransportReceiptVerifier(
  input: PlanPinnedProviderTransportReceiptVerifierInput,
): ProviderPacketReceiptVerifier {
  for (const [label, digest] of [
    ["trial manifest artifact", input.trial_manifest_artifact_sha256],
    ["provider wire observations artifact", input.provider_wire_observations_artifact_sha256],
    ["provider usage artifact", input.provider_usage_artifact_sha256],
  ] as const) {
    if (!SHA256_PATTERN.test(digest)) {
      throw new Error(`${label} SHA-256 is invalid`);
    }
  }
  return ({ receipt, binding }) => {
    const errors: string[] = [];
    let packet: unknown;
    try {
      packet = decodeJson(receipt);
    } catch {
      return Object.freeze({
        valid: false,
        errors: Object.freeze(["provider_transport_packet_json_invalid"]),
        receipt_sha256: sha256Hex(receipt),
      });
    }
    const verification = verifyProviderTransportPacket({
      packet,
      expectedSubject: input.expected_subject,
      planPinnedTrust: input.plan_pinned_trust,
    });
    if (!verification.valid || !verification.signature_verified) {
      errors.push(
        ...verification.errors.map((error) => `provider_transport_packet_signature:${error}`),
      );
    }
    const expectedModelSha256 = sha256Hex(
      `harshas-amazing-call-center/provider-model/v1\n${input.expected_subject.model}`,
    );
    const joins = [
      [binding.run_id, input.expected_subject.run_id, "run_id"],
      [binding.provider, input.expected_subject.provider, "provider"],
      [binding.model_sha256, expectedModelSha256, "model_sha256"],
      [
        binding.trial_manifest_sha256,
        input.trial_manifest_artifact_sha256,
        "trial_manifest_sha256",
      ],
      [
        binding.provider_transport_evidence_sha256,
        input.expected_subject.provider_evidence_descriptor.sha256,
        "provider_transport_evidence_sha256",
      ],
      [
        binding.provider_wire_observations_sha256,
        input.provider_wire_observations_artifact_sha256,
        "provider_wire_observations_sha256",
      ],
      [
        binding.provider_usage_sha256,
        input.provider_usage_artifact_sha256,
        "provider_usage_sha256",
      ],
      [
        binding.wire_chain_head_sha256,
        input.expected_subject.wire_chain_head_sha256,
        "wire_chain_head_sha256",
      ],
    ] as const;
    for (const [actual, expected, label] of joins) {
      if (actual !== expected) errors.push(`provider_transport_packet_binding:${label}_mismatch`);
    }
    return Object.freeze({
      valid: errors.length === 0,
      errors: Object.freeze([...new Set(errors)].sort()),
      signer_key_id: input.plan_pinned_trust.keyId,
      receipt_sha256: sha256Hex(receipt),
    });
  };
}

export type ProviderPacketTrustPolicy =
  | Readonly<{ mode: "transport_only" }>
  | Readonly<{
      mode: "receipt_required";
      receipt_path: string;
      verify: ProviderPacketReceiptVerifier;
    }>;

export type ReopenedProviderPacketVerification = Readonly<{
  valid: boolean;
  transport_valid: boolean;
  trusted: boolean;
  gate1_transport_smoke_eligible: boolean;
  errors: readonly string[];
  binding: ProviderPacketBinding | null;
  receipt: ProviderPacketReceiptVerification | null;
}>;

export type ReopenProviderPacketInput = Readonly<{
  complete_directory: string;
  expected: Readonly<{
    run_id: string;
    provider: ServerRealtimeProvider;
    model: string;
  }>;
  trust: ProviderPacketTrustPolicy;
}>;

type ParsedRunnerManifest = Readonly<{
  schema_version: 1;
  manifest_type: "paid_benchmark_completion";
  run_id: string;
  trial_manifest: PersistedDescriptor;
  provider_transport_evidence: PersistedDescriptor & Readonly<{
    wire_observations: PersistedDescriptor;
    wire_chain_head_sha256: string | null;
    gate1_transport_smoke_eligible: boolean;
    claim_boundary: "transport_compatibility_only";
  }>;
  artifacts: readonly PersistedDescriptor[];
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function descriptor(value: unknown, expectedPath?: string): PersistedDescriptor | null {
  const item = record(value);
  if (
    !item
    || typeof item.path !== "string"
    || !SAFE_PATH_PATTERN.test(item.path)
    || (expectedPath !== undefined && item.path !== expectedPath)
    || !Number.isSafeInteger(item.byte_length)
    || (item.byte_length as number) < 0
    || typeof item.sha256 !== "string"
    || !SHA256_PATTERN.test(item.sha256)
  ) return null;
  return Object.freeze({
    path: item.path,
    byte_length: item.byte_length as number,
    sha256: item.sha256,
  });
}

function parseRunnerManifest(value: unknown): ParsedRunnerManifest | null {
  const item = record(value);
  if (
    !item
    || item.schema_version !== 1
    || item.manifest_type !== "paid_benchmark_completion"
    || typeof item.run_id !== "string"
    || item.run_id.length === 0
    || item.run_id.length > 256
    || !Array.isArray(item.artifacts)
  ) return null;
  const trialManifest = descriptor(item.trial_manifest, "final/manifest.json");
  const providerEvidenceRecord = record(item.provider_transport_evidence);
  const providerEvidence = descriptor(
    item.provider_transport_evidence,
    "final/provider-transport-evidence.json",
  );
  const wire = descriptor(
    providerEvidenceRecord?.wire_observations,
    "final/provider-wire-observations.jsonl",
  );
  if (
    !trialManifest
    || !providerEvidenceRecord
    || !providerEvidence
    || !wire
    || (
      providerEvidenceRecord.wire_chain_head_sha256 !== null
      && (
        typeof providerEvidenceRecord.wire_chain_head_sha256 !== "string"
        || !SHA256_PATTERN.test(providerEvidenceRecord.wire_chain_head_sha256)
      )
    )
    || typeof providerEvidenceRecord.gate1_transport_smoke_eligible !== "boolean"
    || providerEvidenceRecord.claim_boundary !== "transport_compatibility_only"
  ) return null;
  const artifacts = item.artifacts.map((entry) => descriptor(entry));
  if (artifacts.some((entry) => entry === null)) return null;
  return Object.freeze({
    schema_version: 1,
    manifest_type: "paid_benchmark_completion",
    run_id: item.run_id,
    trial_manifest: trialManifest,
    provider_transport_evidence: Object.freeze({
      ...providerEvidence,
      wire_observations: wire,
      wire_chain_head_sha256: providerEvidenceRecord.wire_chain_head_sha256 as string | null,
      gate1_transport_smoke_eligible: providerEvidenceRecord.gate1_transport_smoke_eligible,
      claim_boundary: "transport_compatibility_only",
    }),
    artifacts: Object.freeze(artifacts as PersistedDescriptor[]),
  });
}

function parseFinalized(value: unknown): Readonly<{
  run_id: string;
  status: string;
  manifest_sha256: string;
}> | null {
  const item = record(value);
  if (
    !item
    || item.schema_version !== 1
    || typeof item.run_id !== "string"
    || typeof item.status !== "string"
    || typeof item.manifest_sha256 !== "string"
    || !SHA256_PATTERN.test(item.manifest_sha256)
    || typeof item.journal_head_sha256 !== "string"
    || !SHA256_PATTERN.test(item.journal_head_sha256)
    || typeof item.budget_head_sha256 !== "string"
    || !SHA256_PATTERN.test(item.budget_head_sha256)
    || !Number.isSafeInteger(item.sequence)
    || (item.sequence as number) <= 0
  ) return null;
  return Object.freeze({
    run_id: item.run_id,
    status: item.status,
    manifest_sha256: item.manifest_sha256,
  });
}

function decodeJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function parseJsonLines(bytes: Uint8Array): readonly unknown[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.length === 0 || !text.endsWith("\n")) throw new Error("JSONL is incomplete");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => line.trim().length === 0)) {
    throw new Error("JSONL contains an empty record");
  }
  return Object.freeze(lines.map((line) => JSON.parse(line) as unknown));
}

function parseUsage(value: unknown): readonly NormalizedRealtimeUsage[] {
  const root = record(value);
  if (!root || !Array.isArray(root.events)) throw new Error("usage artifact is malformed");
  return Object.freeze(root.events.map((entry) => {
    const event = record(entry);
    const usage = record(event?.usage);
    if (!event || !usage) throw new Error("usage event is malformed");
    return usage as NormalizedRealtimeUsage;
  }));
}

function descriptorEqual(left: PersistedDescriptor, right: PersistedDescriptor): boolean {
  return left.path === right.path
    && left.byte_length === right.byte_length
    && left.sha256 === right.sha256;
}

function persistedContentValid(descriptor: PersistedDescriptor, content: Uint8Array): boolean {
  return content.byteLength === descriptor.byte_length && sha256Hex(content) === descriptor.sha256;
}

function artifactDescriptorFor(
  manifest: RunManifest,
  path: string,
): ArtifactDescriptor | null {
  return manifest.artifacts.find((entry) => entry.path === path) ?? null;
}

/**
 * Derives the signed-packet expectation only from canonical plan inputs and
 * no-follow reopened artifacts. It never reads fields from the signed packet
 * to decide what that packet should have signed.
 */
export async function deriveExpectedProviderTransportPacketVerificationInput(
  input: DeriveExpectedProviderTransportPacketVerificationInput,
): Promise<PlanPinnedProviderTransportReceiptVerifierInput> {
  if (
    !SHA256_PATTERN.test(input.expected.plan_sha256)
    || !SHA256_PATTERN.test(input.expected.freeze_lock_sha256)
  ) {
    throw new Error("canonical provider packet plan or freeze-lock hash is invalid");
  }
  const runnerManifestBytes = await readFrozenFixtureFileNoFollow(
    input.complete_directory,
    "final/runner-manifest.json",
    4 * 1024 * 1024,
  );
  const runnerManifest = parseRunnerManifest(decodeJson(runnerManifestBytes));
  if (!runnerManifest) throw new Error("provider packet runner manifest is invalid");
  if (runnerManifest.run_id !== input.expected.run_id) {
    throw new Error("provider packet runner manifest run ID differs from the canonical plan");
  }
  const runnerDescriptors = new Map(
    runnerManifest.artifacts.map((entry) => [entry.path, entry] as const),
  );
  if (runnerDescriptors.size !== runnerManifest.artifacts.length) {
    throw new Error("provider packet runner manifest has duplicate artifact paths");
  }
  const trialManifestBytes = await readFrozenFixtureFileNoFollow(
    input.complete_directory,
    runnerManifest.trial_manifest.path,
    4 * 1024 * 1024,
  );
  if (!persistedContentValid(runnerManifest.trial_manifest, trialManifestBytes)) {
    throw new Error("provider packet trial manifest descriptor mismatch");
  }
  const trialManifest = decodeJson(trialManifestBytes) as RunManifest;
  const trialVerification = verifyRunManifest(trialManifest);
  if (!trialVerification.valid || trialManifest.run_id !== input.expected.run_id) {
    throw new Error("provider packet trial manifest is invalid or belongs to another run");
  }
  const metadata = record(trialManifest.metadata);
  if (
    !metadata
    || metadata.pair_id !== input.expected.pair_id
    || metadata.provider !== input.expected.provider
    || metadata.model !== input.expected.model
    || metadata.execution_plan_sha256 !== input.expected.plan_sha256
    || metadata.freeze_lock_hash !== input.expected.freeze_lock_sha256
  ) {
    throw new Error("provider packet trial metadata differs from the canonical plan");
  }

  const reopenTrialArtifact = async (
    path: string,
    maximumBytes: number,
  ): Promise<Readonly<{ descriptor: ArtifactDescriptor; bytes: Uint8Array }>> => {
    const trialDescriptor = artifactDescriptorFor(trialManifest, path);
    const persistedDescriptor = runnerDescriptors.get(`final/${path}`);
    if (
      !trialDescriptor
      || !persistedDescriptor
      || trialDescriptor.byte_length !== persistedDescriptor.byte_length
      || trialDescriptor.sha256 !== persistedDescriptor.sha256
    ) {
      throw new Error(`provider packet artifact descriptor join failed for ${path}`);
    }
    const bytes = await readFrozenFixtureFileNoFollow(
      input.complete_directory,
      persistedDescriptor.path,
      maximumBytes,
    );
    if (!persistedContentValid(persistedDescriptor, bytes)) {
      throw new Error(`provider packet persisted artifact hash failed for ${path}`);
    }
    return Object.freeze({ descriptor: trialDescriptor, bytes });
  };

  const [
    evidenceArtifact,
    wireArtifact,
    usageArtifact,
    linkageArtifact,
    attestationArtifact,
    transcriptArtifact,
  ] = await Promise.all([
    reopenTrialArtifact("provider-transport-evidence.json", 8 * 1024 * 1024),
    reopenTrialArtifact("provider-wire-observations.jsonl", 32 * 1024 * 1024),
    reopenTrialArtifact("usage.json", 8 * 1024 * 1024),
    reopenTrialArtifact("provider-read-only-receipt-linkage.json", 2 * 1024 * 1024),
    reopenTrialArtifact("kernel-attestation.json", 2 * 1024 * 1024),
    reopenTrialArtifact("kernel-transcript.jsonl", 32 * 1024 * 1024),
  ]);
  const evidence = decodeJson(evidenceArtifact.bytes) as ProviderTransportEvidence;
  const linkage = decodeJson(linkageArtifact.bytes) as ProviderReadOnlyReceiptLinkage;
  const attestation = decodeJson(attestationArtifact.bytes) as BenchmarkKernelFinalAttestation;
  const transcriptText = new TextDecoder("utf-8", { fatal: true }).decode(transcriptArtifact.bytes);
  const transcript = parseKernelTranscript(transcriptText);
  const transcriptHeadSha256 = transcript.entries.at(-1)?.entry_sha256;
  if (!transcriptHeadSha256) {
    throw new Error("provider packet kernel transcript is empty");
  }
  const reopenedTranscriptReference = Object.freeze({
    schema_version: 1 as const,
    transcript_type: "benchmark_kernel_replay_public_commitment" as const,
    encoding: "canonical-jsonl-public-commitment" as const,
    view: "public_commitment" as const,
    transcript_entry_count: transcript.entries.length,
    transcript_head_sha256: transcriptHeadSha256,
    transcript_sha256: sha256Hex(
      `${KERNEL_TRANSCRIPT_ARTIFACT_DOMAIN}${transcriptText}`,
    ),
    byte_length: Buffer.byteLength(transcriptText, "utf8"),
  });
  const attestationHash = benchmarkKernelAttestationHash(attestation);
  if (attestation.attestation_hash !== attestationHash) {
    throw new Error("provider packet kernel attestation hash is invalid");
  }
  const expectedLinkageHash = providerReadOnlyReceiptLinkageSha256(linkage);
  if (linkage.linkage_sha256 !== expectedLinkageHash) {
    throw new Error("provider packet read-only receipt linkage hash is invalid");
  }
  if (
    linkage.run_id !== input.expected.run_id
    || attestation.bindings.run_id !== input.expected.run_id
    || attestation.bindings.pair_id !== input.expected.pair_id
    || attestation.bindings.provider !== input.expected.provider
    || attestation.bindings.model !== input.expected.model
    || attestation.bindings.plan_sha256 !== input.expected.plan_sha256
    || attestation.bindings.freeze_lock_sha256 !== input.expected.freeze_lock_sha256
    || attestation.bindings.signing_key_id !== input.plan_pinned_trust.keyId
    || attestation.bindings.signing_public_key_sha256 !== input.plan_pinned_trust.publicKeySha256
    || transcript.entries.some((entry) => entry.run_id !== input.expected.run_id)
    || canonicalJson(reopenedTranscriptReference)
      !== canonicalJson(attestation.transcript_reference)
    || canonicalJson(linkage.transcript_reference)
      !== canonicalJson(attestation.transcript_reference)
  ) {
    throw new Error("provider packet kernel/linkage artifacts differ from the canonical plan");
  }
  const expectedModelSha256 = sha256Hex(
    `harshas-amazing-call-center/provider-model/v1\n${input.expected.model}`,
  );
  if (
    evidence.provider !== input.expected.provider
    || evidence.model_sha256 !== expectedModelSha256
    || !evidence.wire.chain_head_sha256
  ) {
    throw new Error("provider packet evidence differs from the canonical provider/model");
  }

  return Object.freeze({
    expected_subject: Object.freeze({
      plan_sha256: input.expected.plan_sha256,
      freeze_lock_sha256: input.expected.freeze_lock_sha256,
      provider: input.expected.provider,
      model: input.expected.model,
      run_id: input.expected.run_id,
      pair_id: input.expected.pair_id,
      provider_evidence_descriptor: evidenceArtifact.descriptor,
      provider_evidence_descriptor_sha256:
        providerTransportEvidenceDescriptorSha256(evidenceArtifact.descriptor),
      wire_chain_head_sha256: evidence.wire.chain_head_sha256,
      usage_observations_sha256: evidence.usage.observations_sha256,
      input_audio_manifest_sha256: sha256Hex(canonicalJson(evidence.audio.input)),
      output_audio_manifest_sha256: sha256Hex(canonicalJson(evidence.audio.output)),
      artifact_manifest_sha256: trialManifest.manifest_hash,
      read_only_receipt_linkage_sha256: linkage.linkage_sha256,
      kernel_attestation_hash: attestation.attestation_hash,
      kernel_transcript_sha256: attestation.transcript_reference.transcript_sha256,
    }),
    plan_pinned_trust: input.plan_pinned_trust,
    trial_manifest_artifact_sha256: runnerManifest.trial_manifest.sha256,
    provider_wire_observations_artifact_sha256: wireArtifact.descriptor.sha256,
    provider_usage_artifact_sha256: usageArtifact.descriptor.sha256,
  });
}

function packetBinding(input: Omit<ProviderPacketBinding, "schema_version" | "packet_sha256">): ProviderPacketBinding {
  const body = Object.freeze({ schema_version: 1 as const, ...input });
  return Object.freeze({
    ...body,
    packet_sha256: sha256Hex(
      `harshas-amazing-call-center/provider-packet/v1\n${canonicalJson(body)}`,
    ),
  });
}

/**
 * Reopens a durably finalized paid-run directory without following links and
 * recomputes transport eligibility from evidence + wire + usage. It never
 * trusts either manifest's `eligible` projection.
 */
export async function reopenAndVerifyProviderPacket(
  input: ReopenProviderPacketInput,
): Promise<ReopenedProviderPacketVerification> {
  const errors: string[] = [];
  let binding: ProviderPacketBinding | null = null;
  let receipt: ProviderPacketReceiptVerification | null = null;
  let transportValid = false;
  let trusted = false;
  try {
    const finalizedBytes = await readFrozenFixtureFileNoFollow(
      input.complete_directory,
      "FINALIZED.json",
      64 * 1024,
    );
    const finalized = parseFinalized(decodeJson(finalizedBytes));
    if (!finalized) errors.push("finalization_marker_invalid");
    else {
      if (finalized.run_id !== input.expected.run_id) errors.push("finalization_run_id_mismatch");
      if (finalized.status !== "completed") errors.push("run_not_completed");
    }

    const runnerManifestBytes = await readFrozenFixtureFileNoFollow(
      input.complete_directory,
      "final/runner-manifest.json",
      4 * 1024 * 1024,
    );
    const runnerManifestSha256 = sha256Hex(runnerManifestBytes);
    if (finalized && runnerManifestSha256 !== finalized.manifest_sha256) {
      errors.push("runner_manifest_not_finalized");
    }
    const runnerManifest = parseRunnerManifest(decodeJson(runnerManifestBytes));
    if (!runnerManifest) throw new Error("runner manifest schema");
    if (runnerManifest.run_id !== input.expected.run_id) errors.push("runner_manifest_run_id_mismatch");
    const runnerDescriptors = new Map<string, PersistedDescriptor>();
    for (const item of runnerManifest.artifacts) {
      if (runnerDescriptors.has(item.path)) errors.push("duplicate_runner_artifact_path");
      runnerDescriptors.set(item.path, item);
    }
    for (const nested of [
      runnerManifest.trial_manifest,
      runnerManifest.provider_transport_evidence,
      runnerManifest.provider_transport_evidence.wire_observations,
    ]) {
      const listed = runnerDescriptors.get(nested.path);
      if (!listed || !descriptorEqual(listed, nested)) errors.push("runner_nested_descriptor_mismatch");
    }
    const usageDescriptor = runnerDescriptors.get("final/usage.json");
    if (!usageDescriptor) throw new Error("usage descriptor missing");

    const trialManifestBytes = await readFrozenFixtureFileNoFollow(
      input.complete_directory,
      runnerManifest.trial_manifest.path,
      4 * 1024 * 1024,
    );
    if (!persistedContentValid(runnerManifest.trial_manifest, trialManifestBytes)) {
      errors.push("trial_manifest_descriptor_mismatch");
    }
    const trialManifest = decodeJson(trialManifestBytes) as RunManifest;
    const trialVerification = verifyRunManifest(trialManifest);
    if (!trialVerification.valid) errors.push("trial_manifest_invalid");
    if (trialManifest.run_id !== input.expected.run_id) errors.push("trial_manifest_run_id_mismatch");

    const required = [
      {
        final: runnerManifest.provider_transport_evidence,
        trialPath: "provider-transport-evidence.json",
      },
      {
        final: runnerManifest.provider_transport_evidence.wire_observations,
        trialPath: "provider-wire-observations.jsonl",
      },
      {
        final: usageDescriptor,
        trialPath: "usage.json",
      },
    ] as const;
    for (const item of required) {
      const trialDescriptor = artifactDescriptorFor(trialManifest, item.trialPath);
      if (
        !trialDescriptor
        || trialDescriptor.byte_length !== item.final.byte_length
        || trialDescriptor.sha256 !== item.final.sha256
      ) errors.push("runner_trial_descriptor_mismatch");
    }

    const [evidenceBytes, wireBytes, usageBytes] = await Promise.all(required.map(async (item) => {
      const bytes = await readFrozenFixtureFileNoFollow(
        input.complete_directory,
        item.final.path,
        item.final.path.endsWith(".jsonl") ? 32 * 1024 * 1024 : 8 * 1024 * 1024,
      );
      if (!persistedContentValid(item.final, bytes)) {
        errors.push("persisted_artifact_descriptor_mismatch");
      }
      return bytes;
    }));
    const evidence = decodeJson(evidenceBytes) as ProviderTransportEvidence;
    const wireObservations = parseJsonLines(wireBytes) as readonly RealtimeWireObservation[];
    const usage = parseUsage(decodeJson(usageBytes));
    const transport = verifyProviderTransportEvidence({
      evidence,
      wireObservations,
      usage,
      provider: input.expected.provider,
      model: input.expected.model,
    });
    if (!transport.valid) errors.push(...transport.errors);
    if (
      !evidence.gate1_transport_smoke.eligible
      || evidence.gate1_transport_smoke.errors.length !== 0
      || !evidence.terminal.completed
      || !evidence.hard_caps.within_limits
    ) errors.push("transport_smoke_not_eligible");
    if (
      runnerManifest.provider_transport_evidence.gate1_transport_smoke_eligible
      !== evidence.gate1_transport_smoke.eligible
    ) errors.push("runner_transport_projection_mismatch");
    if (
      runnerManifest.provider_transport_evidence.wire_chain_head_sha256
      !== evidence.wire.chain_head_sha256
    ) errors.push("runner_wire_chain_projection_mismatch");
    if (!evidence.wire.chain_head_sha256) errors.push("wire_chain_head_missing");

    binding = evidence.wire.chain_head_sha256
      ? packetBinding({
          run_id: input.expected.run_id,
          provider: input.expected.provider,
          model_sha256: evidence.model_sha256,
          trial_manifest_sha256: runnerManifest.trial_manifest.sha256,
          provider_transport_evidence_sha256: runnerManifest.provider_transport_evidence.sha256,
          provider_wire_observations_sha256: runnerManifest.provider_transport_evidence.wire_observations.sha256,
          provider_usage_sha256: usageDescriptor.sha256,
          wire_chain_head_sha256: evidence.wire.chain_head_sha256,
        })
      : null;
    transportValid = errors.length === 0 && binding !== null;

    if (input.trust.mode === "receipt_required") {
      if (!SAFE_PATH_PATTERN.test(input.trust.receipt_path)) {
        errors.push("provider_packet_receipt_path_invalid");
      } else if (!binding) {
        errors.push("provider_packet_binding_unavailable");
      } else {
        const receiptDescriptor = runnerDescriptors.get(input.trust.receipt_path);
        if (!receiptDescriptor) {
          errors.push("provider_packet_receipt_missing");
        } else {
          const receiptBytes = await readFrozenFixtureFileNoFollow(
            input.complete_directory,
            receiptDescriptor.path,
            2 * 1024 * 1024,
          );
          if (!persistedContentValid(receiptDescriptor, receiptBytes)) {
            errors.push("provider_packet_receipt_descriptor_mismatch");
          } else {
            receipt = await input.trust.verify({ receipt: receiptBytes, binding });
            const receiptShapeValid = typeof receipt?.valid === "boolean"
              && Array.isArray(receipt.errors)
              && receipt.errors.every((error) => typeof error === "string")
              && (
                receipt.receipt_sha256 === undefined
                || receipt.receipt_sha256 === sha256Hex(receiptBytes)
              );
            if (
              !receiptShapeValid
              || !receipt.valid
              || receipt.errors.length > 0
            ) {
              errors.push(
                ...(Array.isArray(receipt?.errors)
                  ? receipt.errors.filter((error): error is string => typeof error === "string")
                  : []),
                "provider_packet_receipt_invalid",
              );
            } else trusted = true;
          }
        }
      }
    }
  } catch {
    errors.push("provider_packet_malformed_or_incomplete");
  }
  const uniqueErrors = Object.freeze([...new Set(errors)].sort());
  return Object.freeze({
    valid: uniqueErrors.length === 0,
    transport_valid: transportValid,
    trusted,
    gate1_transport_smoke_eligible: transportValid && trusted,
    errors: uniqueErrors,
    binding,
    receipt,
  });
}

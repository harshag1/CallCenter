import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import {
  LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
} from "./lc4-development-qualification-v3";
import type {
  Lc4DevLivePreflightArtifact,
  Lc4DevLivePrepareArtifact,
} from "./lc4-development-live-runner";
import {
  LC4_PROVIDER_PROFILE_MANIFEST,
  LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE,
} from "./lc4-provider-profiles";
import {
  assertLc4PublicationTransportReplay,
  type Lc4PublicationOutputAudioLineageScope,
  type Lc4PublicationTransportReplay,
} from "./lc4-publication-transport-replay";
import {
  createLc4ProviderExecutionProfile,
} from "./lc4-production-runner-foundation";
import {
  assertLc4XaiFiniteManualGateDReceipt,
  lc4XaiFiniteManualGateDInvocationMarkerBytes,
  type Lc4XaiFiniteManualGateDReceipt,
} from "./lc4-xai.manual-qualification";
import type {
  ProviderQualificationResult,
} from "./provider-qualification";

const HASH = /^[a-f0-9]{64}$/u;
const MAX_GATE_D_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_GATE_D_INVOCATION_MARKER_BYTES = 64 * 1024;
const CELL_REPLAY_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-cell-replay-set/v1\n";
const LISTENER_AUTHORITY_REPLAY_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-listener-authority-cell-replay-set/v1\n";
const LISTENER_INVOCATION_REPLAY_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-listener-invocation-cell-replay-set/v1\n";
const RESPONSE_GENERATION_REPLAY_SET_DOMAIN =
  "harshas-amazing-call-center/lc4-publication-response-generation-cell-replay-set/v1\n";

export const LC4_PUBLICATION_TRANSPORT_PROVIDERS =
  Object.freeze(["openai", "gemini", "xai"] as const);
export const LC4_PUBLICATION_TRANSPORT_ARMS =
  Object.freeze(["native", "hacc"] as const);

export type Lc4PublicationTransportProvider =
  typeof LC4_PUBLICATION_TRANSPORT_PROVIDERS[number];
export type Lc4PublicationTransportArm =
  typeof LC4_PUBLICATION_TRANSPORT_ARMS[number];

export type Lc4PublicationTransportCell = Readonly<{
  provider: Lc4PublicationTransportProvider;
  arm: Lc4PublicationTransportArm;
  model: string;
  transport_purpose: "finite_prerecorded_efficacy" | null;
  turn_boundary_control: "client_explicit";
  wire_turn_boundary:
    | "input_audio_buffer.commit_then_response.create"
    | "activityStart_audio_activityEnd"
    | "finite_clip_input_audio_buffer.commit_then_response.create";
  transport_profile_sha256: string;
  output_audio_lineage_scope: Lc4PublicationOutputAudioLineageScope;
  canonical_provider_exchange_count: 60;
  repair_provider_exchange_count: number;
  total_response_generation_count: number;
  canonical_exchange_replay_set_sha256: string;
  response_generation_replay_set_sha256: string;
  listener_authority_replay_set_sha256: string;
  listener_invocation_replay_set_sha256: string;
  model_identity_verification: "provider_verified" | "request_only";
  qualification_scope:
    | "retained_gate_b_provider_setup_and_spoken_roundtrip"
    | "xai_finite_manual_gate_d_exact_transport";
  qualification_receipt_sha256: string;
  qualification_replay_sha256: string;
}>;

export type Lc4PublicationTransportProvenance = Readonly<{
  schema_version: 3;
  provider_profile_manifest_sha256: string;
  development_transport_run_sha256: string;
  development_transport_replay_sha256: string;
  canonical_provider_exchange_count: 360;
  repair_provider_exchange_count: number;
  total_response_generation_count: number;
  canonical_exchange_replay_set_sha256: string;
  response_generation_replay_set_sha256: string;
  listener_authority_trust_root_sha256: string;
  listener_authority_replay_set_sha256: string;
  listener_invocation_replay_set_sha256: string;
  retained_gate_b_transport_scope_sha256: string;
  retained_gate_b_receipt_sha256: string;
  retained_gate_b_claim_boundary:
    "transport_qualification_applies_only_to_listed_gate_b_transports_not_every_development_episode_transport";
  xai_finite_manual_transport_qualification: "verified";
  xai_finite_manual_gate_d_receipt_sha256: string;
  xai_finite_manual_transport_profile_sha256: string;
  xai_finite_manual_claim_boundary:
    "transport_qualification_only_not_efficacy_evidence";
  cells: readonly Lc4PublicationTransportCell[];
}>;

export type Lc4PublicationGateDInput = Readonly<{
  receipt_path: string;
  invocation_marker_path: string;
  plan_trust_root_sha256: string;
}>;

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function absolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return path;
}

function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

async function readBoundedGateDReceipt(
  pathInput: string,
): Promise<Lc4XaiFiniteManualGateDReceipt> {
  const path = absolute(pathInput, "LC4 publication Gate D receipt");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error("LC4 publication Gate D receipt must be one bounded regular, non-linked file");
  }
  try {
    const [descriptorBefore, pathBefore] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    const safe = (descriptor: typeof descriptorBefore, pathMetadata: typeof pathBefore): boolean =>
      descriptor.isFile()
      && pathMetadata.isFile()
      && !pathMetadata.isSymbolicLink()
      && descriptor.dev === pathMetadata.dev
      && descriptor.ino === pathMetadata.ino
      && descriptor.nlink === BigInt(1)
      && pathMetadata.nlink === BigInt(1)
      && descriptor.size >= BigInt(2)
      && descriptor.size <= BigInt(MAX_GATE_D_RECEIPT_BYTES)
      && pathMetadata.size === descriptor.size;
    if (!safe(descriptorBefore, pathBefore)) {
      throw new Error("LC4 publication Gate D receipt must be one bounded regular, non-linked file");
    }
    const byteLength = Number(descriptorBefore.size);
    const bytes = Buffer.alloc(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const read = await handle.read(bytes, offset, byteLength - offset, offset);
      if (read.bytesRead <= 0) {
        throw new Error("LC4 publication Gate D receipt changed while it was being read");
      }
      offset += read.bytesRead;
    }
    const overflow = await handle.read(Buffer.allocUnsafe(1), 0, 1, byteLength);
    const [descriptorAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (overflow.bytesRead !== 0
      || !safe(descriptorAfter, pathAfter)
      || descriptorAfter.dev !== descriptorBefore.dev
      || descriptorAfter.ino !== descriptorBefore.ino
      || descriptorAfter.size !== descriptorBefore.size
      || descriptorAfter.mtimeNs !== descriptorBefore.mtimeNs
      || descriptorAfter.ctimeNs !== descriptorBefore.ctimeNs) {
      throw new Error("LC4 publication Gate D receipt changed while it was being read");
    }
    try {
      return JSON.parse(bytes.toString("utf8")) as Lc4XaiFiniteManualGateDReceipt;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("LC4 publication Gate D receipt is not valid JSON");
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function readBoundedGateDInvocationMarker(
  pathInput: string,
): Promise<Readonly<{
  bytes: Buffer;
  device: bigint;
  inode: bigint;
  nlink: bigint;
  permission_mode: bigint;
}>> {
  const path = absolute(
    pathInput,
    "LC4 publication Gate D invocation marker",
  );
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(
      "LC4 publication Gate D invocation marker must be one private bounded regular, non-linked file",
    );
  }
  try {
    const [descriptorBefore, pathBefore] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    const safe = (
      descriptor: typeof descriptorBefore,
      pathMetadata: typeof pathBefore,
    ): boolean => (
      descriptor.isFile()
      && pathMetadata.isFile()
      && !pathMetadata.isSymbolicLink()
      && descriptor.dev === pathMetadata.dev
      && descriptor.ino === pathMetadata.ino
      && descriptor.nlink === BigInt(1)
      && pathMetadata.nlink === BigInt(1)
      && descriptor.size >= BigInt(2)
      && descriptor.size <= BigInt(MAX_GATE_D_INVOCATION_MARKER_BYTES)
      && pathMetadata.size === descriptor.size
      && (descriptor.mode & BigInt(0o077)) === BigInt(0)
      && (pathMetadata.mode & BigInt(0o077)) === BigInt(0)
    );
    if (!safe(descriptorBefore, pathBefore)) {
      throw new Error(
        "LC4 publication Gate D invocation marker must be one private bounded regular, non-linked file",
      );
    }
    const byteLength = Number(descriptorBefore.size);
    const bytes = Buffer.alloc(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const read = await handle.read(bytes, offset, byteLength - offset, offset);
      if (read.bytesRead <= 0) {
        throw new Error(
          "LC4 publication Gate D invocation marker changed while it was being read",
        );
      }
      offset += read.bytesRead;
    }
    const overflow = await handle.read(
      Buffer.allocUnsafe(1),
      0,
      1,
      byteLength,
    );
    const [descriptorAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (overflow.bytesRead !== 0
      || !safe(descriptorAfter, pathAfter)
      || descriptorAfter.dev !== descriptorBefore.dev
      || descriptorAfter.ino !== descriptorBefore.ino
      || descriptorAfter.size !== descriptorBefore.size
      || descriptorAfter.mtimeNs !== descriptorBefore.mtimeNs
      || descriptorAfter.ctimeNs !== descriptorBefore.ctimeNs) {
      throw new Error(
        "LC4 publication Gate D invocation marker changed while it was being read",
      );
    }
    return Object.freeze({
      bytes,
      device: descriptorAfter.dev,
      inode: descriptorAfter.ino,
      nlink: descriptorAfter.nlink,
      permission_mode: descriptorAfter.mode & BigInt(0o777),
    });
  } finally {
    await handle.close();
  }
}

function cellReplaySetSha256(
  cells: readonly Pick<
    Lc4PublicationTransportCell,
    "provider" | "arm" | "canonical_exchange_replay_set_sha256"
  >[],
): string {
  return sha256Hex(`${CELL_REPLAY_SET_DOMAIN}${canonicalJson(
    [...cells]
      .map((cell) => ({
        provider: cell.provider,
        arm: cell.arm,
        canonical_exchange_replay_set_sha256:
          cell.canonical_exchange_replay_set_sha256,
      }))
      .sort((left, right) =>
        `${left.provider}:${left.arm}`.localeCompare(
          `${right.provider}:${right.arm}`,
        )),
  )}`);
}

function listenerReplaySetSha256(
  cells: readonly Lc4PublicationTransportCell[],
  field:
    | "listener_authority_replay_set_sha256"
    | "listener_invocation_replay_set_sha256",
): string {
  const domain = field === "listener_authority_replay_set_sha256"
    ? LISTENER_AUTHORITY_REPLAY_SET_DOMAIN
    : LISTENER_INVOCATION_REPLAY_SET_DOMAIN;
  return sha256Hex(`${domain}${canonicalJson(
    [...cells]
      .map((cell) => ({
        provider: cell.provider,
        arm: cell.arm,
        replay_set_sha256: cell[field],
      }))
      .sort((left, right) =>
        `${left.provider}:${left.arm}`.localeCompare(
          `${right.provider}:${right.arm}`,
        )),
  )}`);
}

function responseGenerationReplaySetSha256(
  cells: readonly Lc4PublicationTransportCell[],
): string {
  return sha256Hex(
    `${RESPONSE_GENERATION_REPLAY_SET_DOMAIN}${canonicalJson(
      [...cells]
        .map((cell) => ({
          provider: cell.provider,
          arm: cell.arm,
          canonical_provider_exchange_count:
            cell.canonical_provider_exchange_count,
          repair_provider_exchange_count:
            cell.repair_provider_exchange_count,
          total_response_generation_count:
            cell.total_response_generation_count,
          response_generation_replay_set_sha256:
            cell.response_generation_replay_set_sha256,
        }))
        .sort((left, right) =>
          `${left.provider}:${left.arm}`.localeCompare(
            `${right.provider}:${right.arm}`,
          )),
    )}`,
  );
}

function assertPublishableOutputAudioLineage(input: Readonly<{
  provider: Lc4PublicationTransportProvider;
  scope: string;
}>): asserts input is Readonly<{
  provider: Lc4PublicationTransportProvider;
  scope: Lc4PublicationTransportCell["output_audio_lineage_scope"];
}> {
  const expected = input.provider === "gemini"
    ? "client_observed_interval_wire_projection_capture_cas_evaluator_exact_complete_frame_attribution_provider_response_id_unavailable"
    : "client_observed_identity_scoped_wire_pcm_capture_cas_evaluator_exact";
  if (input.scope !== expected) {
    throw new Error(
      `LC4 publication refuses ${input.provider} output audio without exact complete wire-to-evaluator lineage`,
    );
  }
}

export function createLc4PublicationTransportProvenance(input: Readonly<{
  retained_gate_b_receipt_sha256: string;
  xai_finite_manual_gate_d_receipt_sha256: string;
  transport_replay: Lc4PublicationTransportReplay;
  qualification_replay_sha256: Readonly<Record<
    Lc4PublicationTransportProvider,
    string
  >>;
  model_identity_verification: Readonly<Record<
    Lc4PublicationTransportProvider,
    "provider_verified" | "request_only"
  >>;
}>): Lc4PublicationTransportProvenance {
  requireHash(
    input.retained_gate_b_receipt_sha256,
    "LC4 retained Gate B receipt",
  );
  requireHash(
    input.xai_finite_manual_gate_d_receipt_sha256,
    "LC4 xAI finite-manual Gate D receipt",
  );
  assertLc4PublicationTransportReplay(input.transport_replay);
  LC4_PUBLICATION_TRANSPORT_PROVIDERS.forEach((provider) =>
    requireHash(
      input.qualification_replay_sha256[provider],
      `LC4 ${provider} qualification replay`,
    ));
  const cells = LC4_PUBLICATION_TRANSPORT_PROVIDERS.flatMap((provider) =>
    LC4_PUBLICATION_TRANSPORT_ARMS.map((arm) => {
      const transport = input.transport_replay.episodes.find((episode) =>
        episode.provider === provider && episode.arm === arm);
      if (!transport) {
        throw new Error(
          `LC4 publication transport replay lacks ${provider}:${arm}`,
        );
      }
      const profile = createLc4ProviderExecutionProfile(provider);
      assertPublishableOutputAudioLineage({
        provider,
        scope: transport.output_audio_lineage_scope,
      });
      return Object.freeze({
        provider,
        arm,
        model: transport.model,
        transport_purpose: transport.transport_purpose,
        turn_boundary_control: "client_explicit" as const,
        wire_turn_boundary: profile.turn_boundary as
          Lc4PublicationTransportCell["wire_turn_boundary"],
        transport_profile_sha256: transport.transport_profile_sha256,
        output_audio_lineage_scope: transport.output_audio_lineage_scope,
        canonical_provider_exchange_count:
          transport.canonical_provider_exchange_count,
        repair_provider_exchange_count:
          transport.repair_provider_exchange_count,
        total_response_generation_count:
          transport.total_response_generation_count,
        canonical_exchange_replay_set_sha256:
          transport.canonical_exchange_replay_set_sha256,
        response_generation_replay_set_sha256:
          transport.response_generation_replay_set_sha256,
        listener_authority_replay_set_sha256:
          transport.listener_authority_replay_set_sha256,
        listener_invocation_replay_set_sha256:
          transport.listener_invocation_replay_set_sha256,
        model_identity_verification:
          input.model_identity_verification[provider],
        qualification_scope: provider === "xai"
          ? "xai_finite_manual_gate_d_exact_transport" as const
          : "retained_gate_b_provider_setup_and_spoken_roundtrip" as const,
        qualification_receipt_sha256: provider === "xai"
          ? input.xai_finite_manual_gate_d_receipt_sha256
          : input.retained_gate_b_receipt_sha256,
        qualification_replay_sha256:
          input.qualification_replay_sha256[provider],
      });
    }));
  return freeze({
    schema_version: 3 as const,
    provider_profile_manifest_sha256:
      LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    development_transport_run_sha256:
      input.transport_replay.run_sha256,
    development_transport_replay_sha256:
      input.transport_replay.replay_sha256,
    canonical_provider_exchange_count:
      input.transport_replay.canonical_provider_exchange_count,
    repair_provider_exchange_count:
      input.transport_replay.repair_provider_exchange_count,
    total_response_generation_count:
      input.transport_replay.total_response_generation_count,
    canonical_exchange_replay_set_sha256:
      cellReplaySetSha256(cells),
    response_generation_replay_set_sha256:
      responseGenerationReplaySetSha256(cells),
    listener_authority_trust_root_sha256:
      input.transport_replay.listener_authority_trust_root_sha256,
    listener_authority_replay_set_sha256:
      listenerReplaySetSha256(
        cells,
        "listener_authority_replay_set_sha256",
      ),
    listener_invocation_replay_set_sha256:
      listenerReplaySetSha256(
        cells,
        "listener_invocation_replay_set_sha256",
      ),
    retained_gate_b_transport_scope_sha256:
      LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256,
    retained_gate_b_receipt_sha256:
      input.retained_gate_b_receipt_sha256,
    retained_gate_b_claim_boundary:
      "transport_qualification_applies_only_to_listed_gate_b_transports_not_every_development_episode_transport" as const,
    xai_finite_manual_transport_qualification: "verified" as const,
    xai_finite_manual_gate_d_receipt_sha256:
      input.xai_finite_manual_gate_d_receipt_sha256,
    xai_finite_manual_transport_profile_sha256:
      LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256,
    xai_finite_manual_claim_boundary:
      "transport_qualification_only_not_efficacy_evidence" as const,
    cells: Object.freeze(cells),
  });
}

export function deriveLc4PublicationModelIdentityVerification(
  setupResults: readonly ProviderQualificationResult[],
): Readonly<Record<
  Lc4PublicationTransportProvider,
  "provider_verified" | "request_only"
>> {
  if (setupResults.length !== 3
    || setupResults.some((result) => result.status !== "passed")) {
    throw new Error("LC4 publication model identity lacks a complete retained setup pass");
  }
  return Object.freeze(Object.fromEntries(
    LC4_PUBLICATION_TRANSPORT_PROVIDERS.map((provider) => {
      const result = setupResults.find((candidate) =>
        candidate.provider === provider);
      if (!result || result.model
        !== LC4_PROVIDER_PROFILE_MANIFEST.providers[provider].model) {
        throw new Error(`LC4 publication ${provider} model identity differs from the retained setup`);
      }
      const providerVerified =
        result.code === "configuration_echo_verified"
        || result.configurationEvidence?.fields.model.status === "verified";
      return [provider, providerVerified
        ? "provider_verified" as const
        : "request_only" as const];
    }),
  )) as Readonly<Record<
    Lc4PublicationTransportProvider,
    "provider_verified" | "request_only"
  >>;
}

export async function verifyLc4PublicationTransportProvenance(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  preflight: Lc4DevLivePreflightArtifact;
  run_sha256: string;
  authority_trust_root_sha256: string;
  transport_replay: Lc4PublicationTransportReplay;
  gate_d: Lc4PublicationGateDInput;
}>): Promise<Lc4PublicationTransportProvenance> {
  requireHash(input.run_sha256, "LC4 publication run");
  requireHash(
    input.authority_trust_root_sha256,
    "LC4 publication listener authority trust root",
  );
  requireHash(
    input.gate_d.plan_trust_root_sha256,
    "LC4 publication Gate D plan trust root",
  );
  assertLc4PublicationTransportReplay(input.transport_replay);
  if (input.prepare.provider_profile_manifest_sha256
      !== LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256
    || input.transport_replay.run_sha256 !== input.run_sha256
    || input.transport_replay.provider_profile_manifest_sha256
      !== input.prepare.provider_profile_manifest_sha256
    || input.transport_replay.audio_delivery_profile_sha256
      !== input.prepare.audio_delivery_profile_sha256
    || input.transport_replay.listener_authority_trust_root_sha256
      !== input.authority_trust_root_sha256
    || input.preflight.authority_trust_root_sha256
      !== input.authority_trust_root_sha256
    || input.preflight.provider_profile_manifest_sha256
      !== input.prepare.provider_profile_manifest_sha256
    || input.prepare.qualification_transport_scope_sha256
      !== LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256
    || input.preflight.qualification_transport_scope_sha256
      !== input.prepare.qualification_transport_scope_sha256
    || input.preflight.qualification_claim_boundary
      !== "retained_gate_b_transports_only_xai_finite_manual_not_qualified"
    || input.preflight.qualification_scope_verified !== true
    || input.preflight.all_episode_transports_qualified !== true
    || input.preflight.xai_finite_manual_transport_qualification !== "verified"
    || input.prepare.xai_finite_manual_transport_qualification
      !== "receipt_bound_pending_preflight_replay"
    || input.prepare.xai_finite_manual_gate_d.plan_authority_trust_root_sha256
      !== input.gate_d.plan_trust_root_sha256
    || input.preflight.xai_finite_manual_gate_d_receipt_sha256
      !== input.prepare.xai_finite_manual_gate_d.receipt_sha256
    || input.preflight.xai_finite_manual_gate_d_transport_profile_sha256
      !== input.prepare.xai_finite_manual_gate_d.transport_profile_sha256
    || input.preflight.xai_finite_manual_gate_d_claim_boundary
      !== "transport_qualification_only_not_efficacy_evidence") {
    throw new Error("LC4 publication retained qualification scope is inconsistent");
  }
  const receipt = await readBoundedGateDReceipt(input.gate_d.receipt_path);
  assertLc4XaiFiniteManualGateDReceipt(receipt, {
    expected_plan_trust_root_sha256: input.gate_d.plan_trust_root_sha256,
    expected_source_commit: input.prepare.source_commit,
    expected_source_tree_sha256: input.prepare.source_tree_sha256,
    expected_provider_profile_manifest_sha256:
      input.prepare.provider_profile_manifest_sha256,
  });
  const invocationMarker = await readBoundedGateDInvocationMarker(
    input.gate_d.invocation_marker_path,
  );
  const expectedMarker = lc4XaiFiniteManualGateDInvocationMarkerBytes(
    receipt.invocation_claim,
  );
  if (!invocationMarker.bytes.equals(expectedMarker)
    || sha256Hex(invocationMarker.bytes)
      !== receipt.invocation_claim.marker_file_sha256
    || invocationMarker.device
      !== BigInt(receipt.invocation_claim.marker_device)
    || invocationMarker.inode
      !== BigInt(receipt.invocation_claim.marker_inode)
    || invocationMarker.nlink
      !== BigInt(receipt.invocation_claim.marker_nlink)
    || invocationMarker.permission_mode
      !== BigInt(receipt.invocation_claim.marker_permission_mode)) {
    throw new Error(
      "LC4 publication Gate D invocation marker differs from the signed one-shot package",
    );
  }
  if (canonicalJson(receipt)
      !== canonicalJson(input.preflight.xai_finite_manual_gate_d)
    || receipt.receipt_sha256
      !== input.prepare.xai_finite_manual_gate_d.receipt_sha256
    || receipt.receipt_sha256
      !== input.preflight.xai_finite_manual_gate_d_receipt_sha256
    || receipt.transport_purpose !== "finite_prerecorded_efficacy"
    || receipt.transport_mode !== "manual_commit"
    || receipt.transport_profile_sha256
      !== LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256
    || receipt.transport_profile_sha256
      !== input.prepare.xai_finite_manual_gate_d.transport_profile_sha256
    || receipt.efficacy_scored !== false
    || receipt.claim_boundary
      !== "transport_qualification_only_not_efficacy_evidence") {
    throw new Error("LC4 publication Gate D receipt crossed its transport-only claim boundary");
  }
  const modelIdentity = deriveLc4PublicationModelIdentityVerification(
    input.preflight.qualification.setup_qualification.results,
  );
  const qualificationReplaySha256 =
    Object.fromEntries(LC4_PUBLICATION_TRANSPORT_PROVIDERS.map((provider) => {
      if (provider === "xai") {
        requireHash(
          receipt.execution_replay_sha256,
          "LC4 xAI finite-manual Gate D execution replay",
        );
        return [provider, receipt.execution_replay_sha256];
      }
      const spoken = input.preflight.qualification.spoken_gate_evidence
        .filter((entry) => entry.provider === provider);
      const qualificationTurnBoundary = provider === "gemini"
        ? "provider_activity_markers"
        : "manual_commit";
      if (spoken.length !== 1
        || spoken[0]!.model
          !== LC4_PROVIDER_PROFILE_MANIFEST.providers[provider].model
        || spoken[0]!.turn_boundary_mode !== qualificationTurnBoundary) {
        throw new Error(
          `LC4 publication ${provider} qualification replay differs from its exact retained setup/spoken evidence`,
        );
      }
      requireHash(
        spoken[0]!.replay_sha256,
        `LC4 ${provider} retained qualification replay`,
      );
      return [provider, spoken[0]!.replay_sha256];
    })) as Record<Lc4PublicationTransportProvider, string>;
  return createLc4PublicationTransportProvenance({
    retained_gate_b_receipt_sha256:
      input.preflight.qualification.receipt_sha256,
    xai_finite_manual_gate_d_receipt_sha256: receipt.receipt_sha256,
    transport_replay: input.transport_replay,
    qualification_replay_sha256: qualificationReplaySha256,
    model_identity_verification: modelIdentity,
  });
}

export function assertLc4PublicationTransportProvenance(
  value: Lc4PublicationTransportProvenance,
): void {
  const exactKeys = (candidate: object, expected: readonly string[]) =>
    canonicalJson(Object.keys(candidate).sort())
      === canonicalJson([...expected].sort());
  const expectedKeys = LC4_PUBLICATION_TRANSPORT_PROVIDERS.flatMap((provider) =>
    LC4_PUBLICATION_TRANSPORT_ARMS.map((arm) => `${provider}:${arm}`)).sort();
  const actualKeys = value.cells.map((cell) =>
    `${cell.provider}:${cell.arm}`).sort();
  if (value.schema_version !== 3
    || !exactKeys(value, [
      "schema_version",
      "provider_profile_manifest_sha256",
      "development_transport_run_sha256",
      "development_transport_replay_sha256",
      "canonical_provider_exchange_count",
      "repair_provider_exchange_count",
      "total_response_generation_count",
      "canonical_exchange_replay_set_sha256",
      "response_generation_replay_set_sha256",
      "listener_authority_trust_root_sha256",
      "listener_authority_replay_set_sha256",
      "listener_invocation_replay_set_sha256",
      "retained_gate_b_transport_scope_sha256",
      "retained_gate_b_receipt_sha256",
      "retained_gate_b_claim_boundary",
      "xai_finite_manual_transport_qualification",
      "xai_finite_manual_gate_d_receipt_sha256",
      "xai_finite_manual_transport_profile_sha256",
      "xai_finite_manual_claim_boundary",
      "cells",
    ])
    || value.provider_profile_manifest_sha256
      !== LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256
    || !HASH.test(value.development_transport_run_sha256)
    || !HASH.test(value.development_transport_replay_sha256)
    || value.canonical_provider_exchange_count !== 360
    || value.canonical_provider_exchange_count
      !== value.cells.reduce((total, cell) =>
        total + cell.canonical_provider_exchange_count, 0)
    || !Number.isSafeInteger(value.repair_provider_exchange_count)
    || value.repair_provider_exchange_count < 0
    || value.repair_provider_exchange_count
      !== value.cells.reduce((total, cell) =>
        total + cell.repair_provider_exchange_count, 0)
    || value.total_response_generation_count
      !== value.canonical_provider_exchange_count
        + value.repair_provider_exchange_count
    || value.total_response_generation_count
      !== value.cells.reduce((total, cell) =>
        total + cell.total_response_generation_count, 0)
    || value.canonical_exchange_replay_set_sha256
      !== cellReplaySetSha256(value.cells)
    || value.response_generation_replay_set_sha256
      !== responseGenerationReplaySetSha256(value.cells)
    || !HASH.test(value.listener_authority_trust_root_sha256)
    || value.listener_authority_replay_set_sha256
      !== listenerReplaySetSha256(
        value.cells,
        "listener_authority_replay_set_sha256",
      )
    || value.listener_invocation_replay_set_sha256
      !== listenerReplaySetSha256(
        value.cells,
        "listener_invocation_replay_set_sha256",
      )
    || value.retained_gate_b_transport_scope_sha256
      !== LC4_DEV_RETAINED_QUALIFICATION_TRANSPORT_SCOPE_SHA256
    || !HASH.test(value.retained_gate_b_receipt_sha256)
    || value.retained_gate_b_claim_boundary
      !== "transport_qualification_applies_only_to_listed_gate_b_transports_not_every_development_episode_transport"
    || value.xai_finite_manual_transport_qualification !== "verified"
    || !HASH.test(value.xai_finite_manual_gate_d_receipt_sha256)
    || value.xai_finite_manual_transport_profile_sha256
      !== LC4_XAI_FINITE_PRERECORDED_TRANSPORT_PROFILE.transport_profile_sha256
    || value.xai_finite_manual_claim_boundary
      !== "transport_qualification_only_not_efficacy_evidence"
    || canonicalJson(actualKeys) !== canonicalJson(expectedKeys)
    || LC4_PUBLICATION_TRANSPORT_PROVIDERS.some((provider) => {
      const pair = value.cells.filter((cell) => cell.provider === provider);
      return new Set(pair.map((cell) => cell.model)).size !== 1
        || new Set(pair.map((cell) => cell.transport_purpose)).size !== 1
        || new Set(pair.map((cell) => cell.turn_boundary_control)).size !== 1
        || new Set(pair.map((cell) => cell.wire_turn_boundary)).size !== 1
        || new Set(pair.map((cell) =>
          cell.transport_profile_sha256)).size !== 1
        || new Set(pair.map((cell) =>
          cell.output_audio_lineage_scope)).size !== 1
        || new Set(pair.map((cell) =>
          cell.canonical_exchange_replay_set_sha256)).size !== 2
        || new Set(pair.map((cell) =>
          cell.response_generation_replay_set_sha256)).size !== 2
        || new Set(pair.map((cell) =>
          cell.listener_authority_replay_set_sha256)).size !== 2
        || new Set(pair.map((cell) =>
          cell.listener_invocation_replay_set_sha256)).size !== 2
        || new Set(pair.map((cell) =>
          cell.model_identity_verification)).size !== 1
        || new Set(pair.map((cell) => cell.qualification_scope)).size !== 1
        || new Set(pair.map((cell) =>
          cell.qualification_receipt_sha256)).size !== 1
        || new Set(pair.map((cell) =>
          cell.qualification_replay_sha256)).size !== 1;
    })
    || value.cells.some((cell) => {
      const profile = createLc4ProviderExecutionProfile(cell.provider);
      const expectedPurpose = profile.transport_purpose;
      const expectedProfileSha256 = profile.transport_profile_sha256
        ?? profile.provider_profile_sha256;
      return !exactKeys(cell, [
        "provider",
        "arm",
        "model",
        "transport_purpose",
        "turn_boundary_control",
        "wire_turn_boundary",
        "transport_profile_sha256",
        "output_audio_lineage_scope",
        "canonical_provider_exchange_count",
        "repair_provider_exchange_count",
        "total_response_generation_count",
        "canonical_exchange_replay_set_sha256",
        "response_generation_replay_set_sha256",
        "listener_authority_replay_set_sha256",
        "listener_invocation_replay_set_sha256",
        "model_identity_verification",
        "qualification_scope",
        "qualification_receipt_sha256",
        "qualification_replay_sha256",
      ])
        || cell.model !== profile.model
        || cell.transport_purpose !== expectedPurpose
        || cell.turn_boundary_control !== "client_explicit"
        || cell.wire_turn_boundary !== profile.turn_boundary
        || cell.transport_profile_sha256 !== expectedProfileSha256
        || (() => {
          try {
            assertPublishableOutputAudioLineage({
              provider: cell.provider,
              scope: cell.output_audio_lineage_scope,
            });
            return false;
          } catch {
            return true;
          }
        })()
        || cell.canonical_provider_exchange_count !== 60
        || !Number.isSafeInteger(cell.repair_provider_exchange_count)
        || cell.repair_provider_exchange_count < 0
        || cell.total_response_generation_count
          !== cell.canonical_provider_exchange_count
            + cell.repair_provider_exchange_count
        || !HASH.test(cell.canonical_exchange_replay_set_sha256)
        || !HASH.test(cell.response_generation_replay_set_sha256)
        || !HASH.test(cell.listener_authority_replay_set_sha256)
        || !HASH.test(cell.listener_invocation_replay_set_sha256)
        || (cell.model_identity_verification !== "provider_verified"
          && cell.model_identity_verification !== "request_only")
        || !HASH.test(cell.qualification_receipt_sha256)
        || !HASH.test(cell.qualification_replay_sha256)
        || (cell.provider === "xai"
          ? cell.qualification_scope
              !== "xai_finite_manual_gate_d_exact_transport"
            || cell.qualification_receipt_sha256
              !== value.xai_finite_manual_gate_d_receipt_sha256
          : cell.qualification_scope
              !== "retained_gate_b_provider_setup_and_spoken_roundtrip"
            || cell.qualification_receipt_sha256
              !== value.retained_gate_b_receipt_sha256);
    })) {
    throw new Error("LC4 publication transport provenance is incomplete or inconsistent");
  }
}

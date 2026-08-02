import { createPublicKey, verify } from "node:crypto";

import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "./artifacts";
import type { Lc4DevReplayArtifactReference } from "./lc4-development-evidence-retention";
import type { BenchmarkKernelAttestationSigner, BenchmarkKernelAttestationTrust } from "./kernel-attestation";

const HASH = /^[a-f0-9]{64}$/u;
const SEGMENT_BINDING_DOMAIN = "harshas-amazing-call-center/lc4-dev-segment-terminal-binding/v1\n";
const SEGMENT_SET_DOMAIN = "harshas-amazing-call-center/lc4-dev-segment-terminal-set/v1\n";
const RUN_SEGMENT_SET_DOMAIN = "harshas-amazing-call-center/lc4-dev-run-segment-terminal-set/v1\n";
const RUN_TERMINAL_DOMAIN = "harshas-amazing-call-center/lc4-dev-run-terminal-authority/v1\n";
const RUN_TERMINAL_SIGNATURE_DOMAIN = "harshas-amazing-call-center/lc4-dev-run-terminal-authority-signature/v1\n";
const SEGMENT_FINALIZATION_DOMAIN = "harshas-amazing-call-center/lc4-provider-session-rotation/v7\n";
const OPPORTUNITY_ROOT_CHAIN_DOMAIN = "harshas-amazing-call-center/lc4-dev-segment-opportunity-root-chain/v1\n";

export const LC4_DEV_TERMINAL_AUTHORITY_VERSION = "lc4-dev-terminal-authority-v1" as const;

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function requireHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function objectValue(value: JsonValue, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, JsonValue>;
}

function requireReference(
  reference: Lc4DevReplayArtifactReference,
  kind: Lc4DevReplayArtifactReference["kind"],
  label: string,
): void {
  if (reference.kind !== kind || reference.schema_version !== 1) throw new Error(`${label} has the wrong evidence kind`);
  requireHash(reference.evidence_sha256, `${label} CAS hash`);
  if (!Number.isSafeInteger(reference.byte_length) || reference.byte_length < 1) {
    throw new Error(`${label} has an invalid retained byte length`);
  }
}

export type Lc4DevSegmentExchangeAuthorityInput = Readonly<{
  opportunity_id: string;
  opportunity_index: number;
  exchange_phase: "canonical" | "repair";
  opportunity_receipt_sha256: string | null;
  provider_exchange: Lc4DevReplayArtifactReference;
  provider_exchange_body: JsonValue;
}>;

export type Lc4DevSegmentTerminalBinding = Readonly<{
  schema_version: 1;
  episode_id: string;
  segment_ordinal: 1 | 2 | 3 | 4 | 5 | 6;
  opportunity_start: number;
  opportunity_end: number;
  canonical_exchange_count: 10;
  response_generation_count: number;
  segment_finalization: Lc4DevReplayArtifactReference;
  ordered_provider_exchange_sha256s: readonly string[];
  ordered_wire_observation_set_sha256s: readonly string[];
  first_wire_observation_sha256: string;
  terminal_wire_observation_sha256: string;
  binding_sha256: string;
}>;

/**
 * Creates the signed-authority preimage that joins one schema-v7 close receipt
 * to every response generation observed on that exact provider connection.
 * The wire observation chain must remain contiguous across canonical and repair
 * generations; a count alone is deliberately insufficient.
 */
export function createLc4DevSegmentTerminalBinding(input: Readonly<{
  episode_id: string;
  segment_ordinal: 1 | 2 | 3 | 4 | 5 | 6;
  segment_finalization: Lc4DevReplayArtifactReference;
  segment_finalization_body: JsonValue;
  exchanges: readonly Lc4DevSegmentExchangeAuthorityInput[];
}>): Lc4DevSegmentTerminalBinding {
  requireReference(input.segment_finalization, "segment_finalization", "LC4-DEV segment finalization");
  if (input.segment_finalization.domain_prefix !== SEGMENT_FINALIZATION_DOMAIN) {
    throw new Error("LC4-DEV segment finalization is not schema-v7 evidence");
  }
  const finalization = objectValue(input.segment_finalization_body, "LC4-DEV segment finalization body");
  const opportunityStart = (input.segment_ordinal - 1) * 10 + 1;
  const opportunityEnd = input.segment_ordinal * 10;
  if (finalization.schema_version !== 7
    || finalization.run_id !== input.episode_id
    || finalization.segment_ordinal !== input.segment_ordinal
    || finalization.session_ordinal !== input.segment_ordinal
    || finalization.opportunity_count !== 10) {
    throw new Error("LC4-DEV segment finalization differs from its episode, session, or exact horizon");
  }
  requireHash(finalization.terminal_wire_observation_sha256, "LC4-DEV segment terminal wire observation");
  requireHash(finalization.provider_connection_scope_sha256, "LC4-DEV segment provider connection scope");
  requireHash(finalization.provider_connection_attestation_sha256, "LC4-DEV segment provider connection attestation");
  if (!Number.isSafeInteger(finalization.opened_wire_index)
    || Number(finalization.opened_wire_index) < 0
    || !Number.isSafeInteger(finalization.wire_observation_count)
    || Number(finalization.wire_observation_count) < 1) {
    throw new Error("LC4-DEV segment close receipt has invalid wire interval bounds");
  }
  if (input.exchanges.length < 10) throw new Error("LC4-DEV segment terminal authority requires ten canonical exchanges");

  const canonicalIndexes: number[] = [];
  const providerExchangeHashes: string[] = [];
  const wireSetHashes: string[] = [];
  let priorWireObservationSha256: string | null = null;
  let firstWireObservationSha256: string | null = null;
  let expectedWireSequence = Number(finalization.opened_wire_index) + 1;
  let retainedWireObservationCount = 0;
  for (const [exchangeOrdinal, exchangeInput] of input.exchanges.entries()) {
    requireReference(exchangeInput.provider_exchange, "provider_exchange", `LC4-DEV segment exchange ${exchangeOrdinal + 1}`);
    const exchange = objectValue(exchangeInput.provider_exchange_body, `LC4-DEV segment exchange ${exchangeOrdinal + 1} body`);
    if (exchange.segment_ordinal !== input.segment_ordinal
      || exchange.opportunity_id !== exchangeInput.opportunity_id
      || exchange.playback_kind !== exchangeInput.exchange_phase
      || exchange.provider_connection_scope_sha256 !== finalization.provider_connection_scope_sha256
      || exchange.provider_connection_attestation_sha256 !== finalization.provider_connection_attestation_sha256) {
      throw new Error("LC4-DEV segment exchange differs from its ordered authority identity");
    }
    if (!Number.isSafeInteger(exchangeInput.opportunity_index)
      || exchangeInput.opportunity_index < opportunityStart
      || exchangeInput.opportunity_index > opportunityEnd) {
      throw new Error("LC4-DEV segment exchange is outside its scheduled opportunity interval");
    }
    if (exchangeInput.exchange_phase === "canonical") canonicalIndexes.push(exchangeInput.opportunity_index);
    requireHash(exchange.wire_observation_set_sha256, "LC4-DEV segment exchange wire set");
    if (!Array.isArray(exchange.wire_observations) || exchange.wire_observations.length < 1) {
      throw new Error("LC4-DEV segment exchange has no retained wire observations");
    }
    for (const [wireOrdinal, candidate] of exchange.wire_observations.entries()) {
      const observation = objectValue(candidate, "LC4-DEV segment wire observation");
      requireHash(observation.observation_sha256, "LC4-DEV segment wire observation");
      if (observation.connection_epoch !== 1 || observation.sequence !== expectedWireSequence) {
        throw new Error("LC4-DEV segment wire observation differs from the single connection epoch");
      }
      if (wireOrdinal === 0 && firstWireObservationSha256 === null) {
        firstWireObservationSha256 = observation.observation_sha256;
        if (Number(finalization.opened_wire_index) === 0) {
          if (observation.previous_observation_sha256 !== null) {
            throw new Error("LC4-DEV segment wire chain has a substituted head");
          }
        } else {
          requireHash(observation.previous_observation_sha256, "LC4-DEV segment pre-open wire predecessor");
        }
      }
      if (priorWireObservationSha256 !== null
        && observation.previous_observation_sha256 !== priorWireObservationSha256) {
        throw new Error("LC4-DEV segment wire observations are not one contiguous connection chain");
      }
      priorWireObservationSha256 = observation.observation_sha256;
      expectedWireSequence += 1;
      retainedWireObservationCount += 1;
    }
    providerExchangeHashes.push(exchangeInput.provider_exchange.evidence_sha256);
    wireSetHashes.push(exchange.wire_observation_set_sha256);
  }
  const expectedCanonicalIndexes = Array.from({ length: 10 }, (_, index) => opportunityStart + index);
  if (canonicalJson(canonicalIndexes) !== canonicalJson(expectedCanonicalIndexes)) {
    throw new Error("LC4-DEV segment terminal authority does not contain exactly ten ordered canonical exchanges");
  }
  const opportunityRoots = finalization.opportunity_root_chain;
  if (!Array.isArray(opportunityRoots) || opportunityRoots.length !== 10) {
    throw new Error("LC4-DEV segment close receipt is missing its ten finalized opportunity roots");
  }
  let previousOpportunityReceiptSha256: string | null = null;
  for (const [offset, rootValue] of opportunityRoots.entries()) {
    const opportunityIndex = opportunityStart + offset;
    const root = objectValue(rootValue, "LC4-DEV segment opportunity root");
    const opportunityExchanges = input.exchanges.filter((exchange) => exchange.opportunity_index === opportunityIndex);
    const effective = opportunityExchanges.at(-1)!;
    const canonical = opportunityExchanges[0]!;
    requireHash(canonical.opportunity_receipt_sha256, "LC4-DEV finalized opportunity receipt");
    if (root.ordinal !== offset + 1
      || root.opportunity_id !== `lc4-dev-op-${opportunityIndex}`
      || root.effective_exchange_sha256 !== effective.provider_exchange.evidence_sha256
      || root.opportunity_receipt_sha256 !== canonical.opportunity_receipt_sha256
      || root.previous_opportunity_receipt_sha256 !== previousOpportunityReceiptSha256) {
      throw new Error("LC4-DEV segment close receipt opportunity-root chain differs from its ordered exchanges");
    }
    previousOpportunityReceiptSha256 = canonical.opportunity_receipt_sha256;
  }
  const expectedOpportunityRootChainSha256 = sha256Hex(`${OPPORTUNITY_ROOT_CHAIN_DOMAIN}${canonicalJson({
    run_id: input.episode_id,
    segment_ordinal: input.segment_ordinal,
    provider_connection_scope_sha256: finalization.provider_connection_scope_sha256,
    roots: opportunityRoots,
  })}`);
  if (finalization.opportunity_root_chain_sha256 !== expectedOpportunityRootChainSha256) {
    throw new Error("LC4-DEV segment close receipt opportunity-root set hash mismatch");
  }
  if (priorWireObservationSha256 !== finalization.terminal_wire_observation_sha256) {
    throw new Error("LC4-DEV segment close receipt does not terminate the ordered exchange wire chain");
  }
  if (retainedWireObservationCount !== finalization.wire_observation_count) {
    throw new Error("LC4-DEV segment close receipt wire interval omits or adds observations");
  }
  const body = freeze({
    schema_version: 1 as const,
    episode_id: input.episode_id,
    segment_ordinal: input.segment_ordinal,
    opportunity_start: opportunityStart,
    opportunity_end: opportunityEnd,
    canonical_exchange_count: 10 as const,
    response_generation_count: input.exchanges.length,
    segment_finalization: input.segment_finalization,
    ordered_provider_exchange_sha256s: providerExchangeHashes,
    ordered_wire_observation_set_sha256s: wireSetHashes,
    first_wire_observation_sha256: firstWireObservationSha256!,
    terminal_wire_observation_sha256: priorWireObservationSha256!,
  });
  return freeze({
    ...body,
    binding_sha256: sha256Hex(`${SEGMENT_BINDING_DOMAIN}${canonicalJson(body)}`),
  });
}

export function lc4DevSegmentTerminalBindingSetSha256(
  bindings: readonly Lc4DevSegmentTerminalBinding[],
): string {
  if (bindings.length !== 6
    || bindings.some((binding, index) => binding.segment_ordinal !== index + 1)) {
    throw new Error("LC4-DEV episode terminal authority requires six ordered segment bindings");
  }
  for (const binding of bindings) {
    const { binding_sha256: claimed, ...body } = binding;
    requireHash(claimed, "LC4-DEV segment terminal binding");
    if (claimed !== sha256Hex(`${SEGMENT_BINDING_DOMAIN}${canonicalJson(body)}`)) {
      throw new Error("LC4-DEV segment terminal binding hash mismatch");
    }
  }
  return sha256Hex(`${SEGMENT_SET_DOMAIN}${canonicalJson(bindings.map((binding) => binding.binding_sha256))}`);
}

export type Lc4DevRunTerminalAuthorityArtifact = Readonly<{
  schema_version: 1;
  artifact_type: "lc4_dev_run_terminal_authority";
  authority_version: typeof LC4_DEV_TERMINAL_AUTHORITY_VERSION;
  execution_id: string;
  prepare_sha256: string;
  preflight_sha256: string;
  ledger_head_before_run_terminal_sha256: string;
  ordered_episode_finalization_sha256s: readonly string[];
  ordered_episode_authority_sha256s: readonly string[];
  ordered_segment_finalization_sha256s: readonly string[];
  ordered_segment_binding_sha256s: readonly string[];
  segment_binding_set_sha256: string;
  artifact_sha256: string;
  signature: Readonly<{
    algorithm: "ed25519";
    key_id: string;
    public_key_sha256: string;
    signature_base64: string;
  }>;
}>;

export function createLc4DevRunTerminalAuthorityArtifact(input: Readonly<{
  execution_id: string;
  prepare_sha256: string;
  preflight_sha256: string;
  ledger_head_before_run_terminal_sha256: string;
  ordered_episode_finalization_sha256s: readonly string[];
  ordered_episode_authority_sha256s: readonly string[];
  ordered_segment_bindings: readonly Lc4DevSegmentTerminalBinding[];
  signer: BenchmarkKernelAttestationSigner;
}>): Lc4DevRunTerminalAuthorityArtifact {
  for (const [value, label] of [
    [input.prepare_sha256, "prepare"],
    [input.preflight_sha256, "preflight"],
    [input.ledger_head_before_run_terminal_sha256, "pre-terminal ledger head"],
  ] as const) requireHash(value, `LC4-DEV run terminal ${label}`);
  if (input.ordered_episode_finalization_sha256s.length !== 6
    || input.ordered_episode_authority_sha256s.length !== 6
    || input.ordered_segment_bindings.length !== 36) {
    throw new Error("LC4-DEV run terminal authority requires six episodes and 36 segments");
  }
  for (const value of [...input.ordered_episode_finalization_sha256s, ...input.ordered_episode_authority_sha256s]) {
    requireHash(value, "LC4-DEV run terminal episode authority edge");
  }
  const episodeIds = new Set<string>();
  for (let episodeIndex = 0; episodeIndex < 6; episodeIndex += 1) {
    const episodeBindings = input.ordered_segment_bindings.slice(episodeIndex * 6, episodeIndex * 6 + 6);
    lc4DevSegmentTerminalBindingSetSha256(episodeBindings);
    const episodeId = episodeBindings[0]!.episode_id;
    if (episodeBindings.some((binding) => binding.episode_id !== episodeId) || episodeIds.has(episodeId)) {
      throw new Error("LC4-DEV run terminal segment order is not episode-major");
    }
    episodeIds.add(episodeId);
  }
  const segmentBindingSetSha256 = sha256Hex(`${RUN_SEGMENT_SET_DOMAIN}${canonicalJson(
    input.ordered_segment_bindings.map((binding) => binding.binding_sha256),
  )}`);
  const body = freeze({
    schema_version: 1 as const,
    artifact_type: "lc4_dev_run_terminal_authority" as const,
    authority_version: LC4_DEV_TERMINAL_AUTHORITY_VERSION,
    execution_id: input.execution_id,
    prepare_sha256: input.prepare_sha256,
    preflight_sha256: input.preflight_sha256,
    ledger_head_before_run_terminal_sha256: input.ledger_head_before_run_terminal_sha256,
    ordered_episode_finalization_sha256s: [...input.ordered_episode_finalization_sha256s],
    ordered_episode_authority_sha256s: [...input.ordered_episode_authority_sha256s],
    ordered_segment_finalization_sha256s: input.ordered_segment_bindings.map(
      (binding) => binding.segment_finalization.evidence_sha256,
    ),
    ordered_segment_binding_sha256s: input.ordered_segment_bindings.map((binding) => binding.binding_sha256),
    segment_binding_set_sha256: segmentBindingSetSha256,
  });
  const artifactSha256 = sha256Hex(`${RUN_TERMINAL_DOMAIN}${canonicalJson(body)}`);
  return freeze({
    ...body,
    artifact_sha256: artifactSha256,
    signature: {
      algorithm: "ed25519" as const,
      key_id: input.signer.keyId,
      public_key_sha256: input.signer.publicKeySha256,
      signature_base64: input.signer.sign(`${RUN_TERMINAL_SIGNATURE_DOMAIN}${artifactSha256}`),
    },
  });
}

export function assertLc4DevRunTerminalAuthorityArtifact(input: Readonly<{
  artifact: Lc4DevRunTerminalAuthorityArtifact;
  trust: BenchmarkKernelAttestationTrust;
  expected: Readonly<{
    execution_id: string;
    prepare_sha256: string;
    preflight_sha256: string;
    ledger_head_before_run_terminal_sha256: string;
    ordered_episode_finalization_sha256s: readonly string[];
    ordered_episode_authority_sha256s: readonly string[];
    ordered_segment_bindings: readonly Lc4DevSegmentTerminalBinding[];
  }>;
}>): void {
  const { artifact_sha256: claimed, signature, ...body } = input.artifact;
  requireHash(claimed, "LC4-DEV run terminal artifact");
  if (input.artifact.schema_version !== 1
    || input.artifact.artifact_type !== "lc4_dev_run_terminal_authority"
    || input.artifact.authority_version !== LC4_DEV_TERMINAL_AUTHORITY_VERSION
    || claimed !== sha256Hex(`${RUN_TERMINAL_DOMAIN}${canonicalJson(body)}`)) {
    throw new Error("LC4-DEV run terminal authority artifact hash mismatch");
  }
  if (signature.algorithm !== "ed25519"
    || signature.key_id !== input.trust.keyId
    || signature.public_key_sha256 !== input.trust.publicKeySha256
    || !verify(
      null,
      Buffer.from(`${RUN_TERMINAL_SIGNATURE_DOMAIN}${claimed}`, "utf8"),
      createPublicKey(input.trust.publicKeyPem),
      Buffer.from(signature.signature_base64, "base64"),
    )) {
    throw new Error("LC4-DEV run terminal authority signature is invalid");
  }
  const expected = createLc4DevRunTerminalAuthorityArtifact({
    ...input.expected,
    signer: {
      algorithm: "ed25519",
      keyId: signature.key_id,
      publicKeySha256: signature.public_key_sha256,
      sign: () => signature.signature_base64,
    },
  });
  const { signature: _expectedSignature, ...expectedUnsigned } = expected;
  const { signature: _actualSignature, ...actualUnsigned } = input.artifact;
  void _expectedSignature;
  void _actualSignature;
  if (canonicalJson(actualUnsigned) !== canonicalJson(expectedUnsigned)) {
    throw new Error("LC4-DEV run terminal authority differs from the exact retained terminal DAG");
  }
}

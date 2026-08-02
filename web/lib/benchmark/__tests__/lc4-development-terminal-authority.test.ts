import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex, type JsonValue } from "../artifacts";
import {
  assertLc4DevRunTerminalAuthorityArtifact,
  createLc4DevRunTerminalAuthorityArtifact,
  createLc4DevSegmentTerminalBinding,
  lc4DevSegmentTerminalBindingSetSha256,
  type Lc4DevRunTerminalAuthorityArtifact,
  type Lc4DevSegmentTerminalBinding,
} from "../lc4-development-terminal-authority";
import type { Lc4DevReplayArtifactReference } from "../lc4-development-evidence-retention";
import {
  benchmarkKernelAttestationPublicKeyFingerprint,
  createBenchmarkKernelAttestationSigner,
} from "../kernel-attestation";

const SEGMENT_DOMAIN = "harshas-amazing-call-center/lc4-provider-session-rotation/v7\n";
const OPPORTUNITY_ROOT_CHAIN_DOMAIN = "harshas-amazing-call-center/lc4-dev-segment-opportunity-root-chain/v1\n";

function reference(
  kind: Lc4DevReplayArtifactReference["kind"],
  label: string,
  domainPrefix = "",
): Lc4DevReplayArtifactReference {
  return Object.freeze({
    schema_version: 1,
    retention_version: "lc4-dev-replay-evidence-v1",
    kind,
    evidence_sha256: sha256Hex(label),
    byte_length: 256,
    content_encoding: domainPrefix.length > 0
      ? "domain-prefixed-canonical-json"
      : "canonical-json",
    domain_prefix: domainPrefix,
  });
}

function segmentBinding(
  episodeId: string,
  segmentOrdinal: 1 | 2 | 3 | 4 | 5 | 6,
): Lc4DevSegmentTerminalBinding {
  const start = (segmentOrdinal - 1) * 10 + 1;
  const connectionScopeSha256 = sha256Hex(`${episodeId}:segment-${segmentOrdinal}:connection-scope`);
  const connectionAttestationSha256 = sha256Hex(`${episodeId}:segment-${segmentOrdinal}:connection-attestation`);
  let previous: string | null = null;
  let previousOpportunityReceiptSha256: string | null = null;
  const opportunityRoots: Array<Record<string, JsonValue>> = [];
  const exchanges = Array.from({ length: 10 }, (_, offset) => {
    const opportunityIndex = start + offset;
    const observationSha256 = sha256Hex(`${episodeId}:segment-${segmentOrdinal}:wire-${opportunityIndex}`);
    const body = {
      schema_version: 5,
      opportunity_id: `lc4-dev-op-${opportunityIndex}`,
      opportunity_index: opportunityIndex,
      segment_ordinal: segmentOrdinal,
      playback_kind: "canonical",
      provider_connection_scope_sha256: connectionScopeSha256,
      provider_connection_attestation_sha256: connectionAttestationSha256,
      wire_observation_set_sha256: sha256Hex(`${episodeId}:wire-set-${opportunityIndex}`),
      wire_observations: [{
        connection_epoch: 1,
        sequence: offset + 1,
        observation_sha256: observationSha256,
        previous_observation_sha256: previous,
      }],
    } satisfies JsonValue;
    previous = observationSha256;
    const opportunityReceiptSha256 = sha256Hex(`${episodeId}:opportunity-receipt-${opportunityIndex}`);
    const providerExchange = reference("provider_exchange", `${episodeId}:exchange-${opportunityIndex}`);
    opportunityRoots.push({
      ordinal: offset + 1,
      opportunity_id: `lc4-dev-op-${opportunityIndex}`,
      effective_exchange_sha256: providerExchange.evidence_sha256,
      opportunity_receipt_sha256: opportunityReceiptSha256,
      previous_opportunity_receipt_sha256: previousOpportunityReceiptSha256,
    });
    previousOpportunityReceiptSha256 = opportunityReceiptSha256;
    return {
      opportunity_id: `lc4-dev-op-${opportunityIndex}`,
      opportunity_index: opportunityIndex,
      exchange_phase: "canonical" as const,
      opportunity_receipt_sha256: opportunityReceiptSha256,
      provider_exchange: providerExchange,
      provider_exchange_body: body,
    };
  });
  const finalization = {
    schema_version: 7,
    run_id: episodeId,
    segment_ordinal: segmentOrdinal,
    session_ordinal: segmentOrdinal,
    opportunity_count: 10,
    opened_wire_index: 0,
    wire_observation_count: 10,
    provider_connection_scope_sha256: connectionScopeSha256,
    provider_connection_attestation_sha256: connectionAttestationSha256,
    opportunity_root_chain: opportunityRoots,
    opportunity_root_chain_sha256: sha256Hex(`${OPPORTUNITY_ROOT_CHAIN_DOMAIN}${canonicalJson({
      run_id: episodeId,
      segment_ordinal: segmentOrdinal,
      provider_connection_scope_sha256: connectionScopeSha256,
      roots: opportunityRoots,
    })}`),
    terminal_wire_observation_sha256: previous,
  } satisfies JsonValue;
  return createLc4DevSegmentTerminalBinding({
    episode_id: episodeId,
    segment_ordinal: segmentOrdinal,
    segment_finalization: reference("segment_finalization", `${episodeId}:segment-final-${segmentOrdinal}`, SEGMENT_DOMAIN),
    segment_finalization_body: finalization,
    exchanges,
  });
}

function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signer = createBenchmarkKernelAttestationSigner({
    keyId: "lc4-dev-terminal-authority-test",
    privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem,
  });
  const episodeIds = Array.from({ length: 6 }, (_, index) => `lc4-dev-terminal-episode-${index + 1}`);
  const bindings = episodeIds.flatMap((episodeId) =>
    Array.from({ length: 6 }, (_, index) => segmentBinding(episodeId, (index + 1) as 1 | 2 | 3 | 4 | 5 | 6)));
  const expected = {
    execution_id: "lc4-dev-terminal-authority-run",
    prepare_sha256: sha256Hex("terminal-authority-prepare"),
    preflight_sha256: sha256Hex("terminal-authority-preflight"),
    ledger_head_before_run_terminal_sha256: sha256Hex("terminal-authority-ledger-head"),
    ordered_episode_finalization_sha256s: episodeIds.map((id) => sha256Hex(`${id}:episode-finalization`)),
    ordered_episode_authority_sha256s: episodeIds.map((id) => sha256Hex(`${id}:episode-authority`)),
    ordered_segment_bindings: bindings,
  };
  return {
    signer,
    bindings,
    expected,
    trust: {
      keyId: signer.keyId,
      publicKeySha256: benchmarkKernelAttestationPublicKeyFingerprint(publicKeyPem),
      publicKeyPem,
    },
  };
}

describe("LC4-DEV signed terminal authority", () => {
  it("binds ten ordered exchanges to one contiguous schema-v7 provider session", () => {
    const binding = segmentBinding("lc4-dev-openai-hacc", 3);
    expect(binding).toMatchObject({
      segment_ordinal: 3,
      opportunity_start: 21,
      opportunity_end: 30,
      canonical_exchange_count: 10,
      response_generation_count: 10,
    });
    expect(binding.ordered_provider_exchange_sha256s).toHaveLength(10);
    expect(binding.binding_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects an omitted, reordered, disconnected, or incorrectly terminated exchange", () => {
    const episodeId = "lc4-dev-openai-native";
    const start = 1;
    const connectionScopeSha256 = sha256Hex("custom-connection-scope");
    const connectionAttestationSha256 = sha256Hex("custom-connection-attestation");
    let previous: string | null = null;
    let previousOpportunityReceiptSha256: string | null = null;
    const opportunityRoots: Array<Record<string, JsonValue>> = [];
    const exchanges = Array.from({ length: 10 }, (_, offset) => {
      const index = start + offset;
      const current = sha256Hex(`wire:${index}`);
      const opportunityReceiptSha256 = sha256Hex(`receipt:${index}`);
      const providerExchange = reference("provider_exchange", `exchange:${index}`);
      opportunityRoots.push({
        ordinal: offset + 1,
        opportunity_id: `lc4-dev-op-${index}`,
        effective_exchange_sha256: providerExchange.evidence_sha256,
        opportunity_receipt_sha256: opportunityReceiptSha256,
        previous_opportunity_receipt_sha256: previousOpportunityReceiptSha256,
      });
      previousOpportunityReceiptSha256 = opportunityReceiptSha256;
      const item = {
        opportunity_id: `lc4-dev-op-${index}`,
        opportunity_index: index,
        exchange_phase: "canonical" as const,
        opportunity_receipt_sha256: opportunityReceiptSha256,
        provider_exchange: providerExchange,
        provider_exchange_body: {
          opportunity_id: `lc4-dev-op-${index}`,
          opportunity_index: index,
          segment_ordinal: 1,
          playback_kind: "canonical",
          provider_connection_scope_sha256: connectionScopeSha256,
          provider_connection_attestation_sha256: connectionAttestationSha256,
          wire_observation_set_sha256: sha256Hex(`wire-set:${index}`),
          wire_observations: [{
            connection_epoch: 1,
            sequence: index,
            observation_sha256: current,
            previous_observation_sha256: previous,
          }],
        } satisfies JsonValue,
      };
      previous = current;
      return item;
    });
    const input = {
      episode_id: episodeId,
      segment_ordinal: 1 as const,
      segment_finalization: reference("segment_finalization", "segment-final", SEGMENT_DOMAIN),
      segment_finalization_body: {
        schema_version: 7,
        run_id: episodeId,
        segment_ordinal: 1,
        session_ordinal: 1,
        opportunity_count: 10,
        opened_wire_index: 0,
        wire_observation_count: 10,
        provider_connection_scope_sha256: connectionScopeSha256,
        provider_connection_attestation_sha256: connectionAttestationSha256,
        opportunity_root_chain: opportunityRoots,
        opportunity_root_chain_sha256: sha256Hex(`${OPPORTUNITY_ROOT_CHAIN_DOMAIN}${canonicalJson({
          run_id: episodeId,
          segment_ordinal: 1,
          provider_connection_scope_sha256: connectionScopeSha256,
          roots: opportunityRoots,
        })}`),
        terminal_wire_observation_sha256: previous,
      } satisfies JsonValue,
      exchanges,
    };
    expect(() => createLc4DevSegmentTerminalBinding({ ...input, exchanges: exchanges.slice(0, 9) }))
      .toThrow("ten canonical exchanges");
    expect(() => createLc4DevSegmentTerminalBinding({ ...input, exchanges: [exchanges[1]!, exchanges[0]!, ...exchanges.slice(2)] }))
      .toThrow(/ordered authority identity|contiguous connection chain|single connection epoch/u);
    const disconnected = structuredClone(exchanges);
    (disconnected[5]!.provider_exchange_body as Record<string, JsonValue>).wire_observations = [{
      connection_epoch: 1,
      sequence: 6,
      observation_sha256: sha256Hex("wire:6"),
      previous_observation_sha256: sha256Hex("disconnected"),
    }];
    expect(() => createLc4DevSegmentTerminalBinding({ ...input, exchanges: disconnected }))
      .toThrow("not one contiguous connection chain");
    const omittedWirePrefix = structuredClone(exchanges);
    const firstWire = ((omittedWirePrefix[0]!.provider_exchange_body as Record<string, JsonValue>)
      .wire_observations as Array<Record<string, JsonValue>>)[0]!;
    firstWire.sequence = 2;
    firstWire.previous_observation_sha256 = sha256Hex("omitted-wire-prefix");
    expect(() => createLc4DevSegmentTerminalBinding({ ...input, exchanges: omittedWirePrefix }))
      .toThrow("single connection epoch");
    expect(() => createLc4DevSegmentTerminalBinding({
      ...input,
      segment_finalization_body: {
        ...(input.segment_finalization_body as Record<string, JsonValue>),
        wire_observation_count: 9,
      },
    })).toThrow("wire interval omits or adds observations");
    expect(() => createLc4DevSegmentTerminalBinding({
      ...input,
      segment_finalization_body: {
        ...(input.segment_finalization_body as Record<string, JsonValue>),
        terminal_wire_observation_sha256: sha256Hex("substituted-terminal"),
      },
    })).toThrow("does not terminate");
  });

  it("signs one exact episode-major terminal DAG over six episodes and all 36 segments", () => {
    const value = fixture();
    const artifact = createLc4DevRunTerminalAuthorityArtifact({ ...value.expected, signer: value.signer });
    expect(artifact.ordered_segment_finalization_sha256s).toHaveLength(36);
    expect(artifact.ordered_segment_binding_sha256s).toHaveLength(36);
    expect(() => assertLc4DevRunTerminalAuthorityArtifact({ artifact, trust: value.trust, expected: value.expected }))
      .not.toThrow();
    for (let episode = 0; episode < 6; episode += 1) {
      expect(lc4DevSegmentTerminalBindingSetSha256(value.bindings.slice(episode * 6, episode * 6 + 6)))
        .toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("rejects run-terminal segment omission, reorder, and signed-list substitution", () => {
    const value = fixture();
    expect(() => createLc4DevRunTerminalAuthorityArtifact({
      ...value.expected,
      ordered_segment_bindings: value.bindings.slice(0, -1),
      signer: value.signer,
    })).toThrow("six episodes and 36 segments");
    expect(() => createLc4DevRunTerminalAuthorityArtifact({
      ...value.expected,
      ordered_segment_bindings: [value.bindings[1]!, value.bindings[0]!, ...value.bindings.slice(2)],
      signer: value.signer,
    })).toThrow(/six ordered segment bindings|episode-major/u);

    const artifact = createLc4DevRunTerminalAuthorityArtifact({ ...value.expected, signer: value.signer });
    const tampered = structuredClone(artifact) as Lc4DevRunTerminalAuthorityArtifact & {
      ordered_segment_finalization_sha256s: string[];
    };
    tampered.ordered_segment_finalization_sha256s[35] = sha256Hex("substituted-final-segment");
    expect(() => assertLc4DevRunTerminalAuthorityArtifact({ artifact: tampered, trust: value.trust, expected: value.expected }))
      .toThrow("artifact hash mismatch");

    const reorderedExpected = {
      ...value.expected,
      ordered_episode_finalization_sha256s: [
        value.expected.ordered_episode_finalization_sha256s[1]!,
        value.expected.ordered_episode_finalization_sha256s[0]!,
        ...value.expected.ordered_episode_finalization_sha256s.slice(2),
      ],
    };
    expect(() => assertLc4DevRunTerminalAuthorityArtifact({ artifact, trust: value.trust, expected: reorderedExpected }))
      .toThrow("differs from the exact retained terminal DAG");
    expect(canonicalJson(artifact.ordered_segment_finalization_sha256s))
      .not.toBe(canonicalJson([...artifact.ordered_segment_finalization_sha256s].reverse()));
  });
});

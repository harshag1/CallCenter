import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex, type JsonValue } from "../artifacts";
import {
  LC4_XAI_MANUAL_TURN_CAUSALITY_DOMAIN,
  assertLc4XaiManualTurnCausality,
  assertLc4XaiManualTurnReplayProjection,
  createLc4XaiManualTurnCausality,
  lc4XaiManualResponseWireIdentitySha256,
  type Lc4XaiManualTurnCausalityEvidence,
  type Lc4XaiManualTurnCausalityWireObservation,
} from "../lc4-xai-manual-turn-causality";

const RESPONSE_ID = "response-turn-1";
const OTHER_RESPONSE_ID = "response-turn-2";

function observations(): readonly Lc4XaiManualTurnCausalityWireObservation[] {
  let previous: string | null = sha256Hex("prior-opportunity-wire");
  const specs: readonly Readonly<{
    direction: "inbound" | "outbound";
    wire_type: string;
    identity_hashes: Lc4XaiManualTurnCausalityWireObservation["identity_hashes"];
  }>[] = [
    { direction: "outbound", wire_type: "input_audio_buffer.append", identity_hashes: {} },
    { direction: "outbound", wire_type: "input_audio_buffer.commit", identity_hashes: {} },
    { direction: "inbound", wire_type: "input_audio_buffer.committed", identity_hashes: {} },
    { direction: "outbound", wire_type: "response.create", identity_hashes: {} },
    { direction: "inbound", wire_type: "response.created", identity_hashes: {
      responseIdSha256: lc4XaiManualResponseWireIdentitySha256(RESPONSE_ID),
    } },
  ];
  return specs.map(({ direction, wire_type: wireType, identity_hashes: identityHashes }, index) => {
    const observationSha256 = sha256Hex(`manual-wire-${index + 1}`);
    const observation = Object.freeze({
      provider: "xai" as const,
      direction: direction as "inbound" | "outbound",
      connection_epoch: 1,
      sequence: index + 11,
      wire_type: wireType as string,
      observation_sha256: observationSha256,
      previous_observation_sha256: previous,
      identity_hashes: Object.freeze(identityHashes),
    });
    previous = observationSha256;
    return observation;
  });
}

function body(
  wire: readonly Lc4XaiManualTurnCausalityWireObservation[],
  responseIdentity = lc4XaiManualResponseWireIdentitySha256(RESPONSE_ID),
) {
  return Object.freeze({
    schema_version: 1 as const,
    connection_epoch: 1,
    commit_observation_sha256: wire[1]!.observation_sha256,
    commit_sequence: wire[1]!.sequence,
    commit_ack_observation_sha256: wire[2]!.observation_sha256,
    commit_ack_sequence: wire[2]!.sequence,
    response_create_observation_sha256: wire[3]!.observation_sha256,
    response_create_sequence: wire[3]!.sequence,
    response_start_observation_sha256: wire[4]!.observation_sha256,
    response_start_sequence: wire[4]!.sequence,
    response_id_sha256: responseIdentity,
  });
}

function rehash(
  value: Omit<Lc4XaiManualTurnCausalityEvidence, "causality_sha256">,
): Lc4XaiManualTurnCausalityEvidence {
  return Object.freeze({
    ...value,
    causality_sha256: sha256Hex(
      `${LC4_XAI_MANUAL_TURN_CAUSALITY_DOMAIN}${canonicalJson(value)}`,
    ),
  });
}

describe("LC4 xAI finite manual-turn causality", () => {
  it("uses the exact normalized response.created wire identity", () => {
    const wire = observations();
    const evidence = createLc4XaiManualTurnCausality(body(wire), wire);
    expect(assertLc4XaiManualTurnCausality(evidence, wire)).toBe(evidence);
    expect(evidence.response_id_sha256).toBe(
      lc4XaiManualResponseWireIdentitySha256(RESPONSE_ID),
    );
    expect(evidence.response_id_sha256).not.toBe(sha256Hex(RESPONSE_ID));
  });

  it("rejects wrong schemas, plain hashes, and cross-turn response identities", () => {
    const wire = observations();
    const valid = createLc4XaiManualTurnCausality(body(wire), wire);
    expect(() => assertLc4XaiManualTurnCausality({
      ...valid,
      schema_version: 2,
    }, wire)).toThrow(/schema version/u);
    expect(() => assertLc4XaiManualTurnCausality(
      rehash({ ...body(wire), response_id_sha256: sha256Hex(RESPONSE_ID) }),
      wire,
    )).toThrow(/causality/u);
    expect(() => assertLc4XaiManualTurnCausality(
      rehash({
        ...body(wire),
        response_id_sha256: lc4XaiManualResponseWireIdentitySha256(OTHER_RESPONSE_ID),
      }),
      wire,
    )).toThrow(/causality/u);
  });

  it("rejects reordered, truncated, role-tampered, and cross-turn causal slices", () => {
    const wire = observations();
    const evidence = createLc4XaiManualTurnCausality(body(wire), wire);
    expect(() => assertLc4XaiManualTurnCausality(evidence, [
      wire[0]!,
      wire[2]!,
      wire[1]!,
      wire[3]!,
      wire[4]!,
    ])).toThrow(/reordered|chain-tampered/u);
    expect(() => assertLc4XaiManualTurnCausality(evidence, [
      wire[0]!,
      wire[1]!,
      wire[3]!,
      wire[4]!,
    ])).toThrow(/reordered|truncated|chain-tampered/u);
    expect(() => assertLc4XaiManualTurnCausality(evidence, [
      ...wire.slice(0, 3),
      { ...wire[3]!, wire_type: "input_audio_buffer.commit" },
      wire[4]!,
    ])).toThrow(/causal role/u);

    const interveningCommit = Object.freeze({
      ...wire[3]!,
      sequence: wire[3]!.sequence,
      wire_type: "input_audio_buffer.commit",
      observation_sha256: sha256Hex("intervening-cross-turn-commit"),
      previous_observation_sha256: wire[2]!.observation_sha256,
    });
    const crossTurnCreate = Object.freeze({
      ...wire[3]!,
      sequence: wire[3]!.sequence + 1,
      observation_sha256: sha256Hex("cross-turn-response-create"),
      previous_observation_sha256: interveningCommit.observation_sha256,
    });
    const crossTurnStart = Object.freeze({
      ...wire[4]!,
      sequence: wire[4]!.sequence + 1,
      observation_sha256: sha256Hex("cross-turn-response-start"),
      previous_observation_sha256: crossTurnCreate.observation_sha256,
      identity_hashes: Object.freeze({
        responseIdSha256: lc4XaiManualResponseWireIdentitySha256(OTHER_RESPONSE_ID),
      }),
    });
    const splicedWire = [...wire.slice(0, 3), interveningCommit, crossTurnCreate, crossTurnStart];
    const splicedEvidence = rehash({
      ...body(wire),
      response_create_observation_sha256: crossTurnCreate.observation_sha256,
      response_create_sequence: crossTurnCreate.sequence,
      response_start_observation_sha256: crossTurnStart.observation_sha256,
      response_start_sequence: crossTurnStart.sequence,
      response_id_sha256: crossTurnStart.identity_hashes.responseIdSha256,
    });
    expect(() => assertLc4XaiManualTurnCausality(splicedEvidence, splicedWire))
      .toThrow(/crosses another input turn/u);
  });

  it("replays retained manual xAI projections and fails closed after semantic tampering", () => {
    const wire = observations();
    const evidence = createLc4XaiManualTurnCausality(body(wire), wire);
    const projection = {
      provider: "xai",
      transport_mode: "manual_commit",
      wire_observations: wire,
      xai_manual_turn_causality: evidence,
    } as unknown as JsonValue;
    expect(() => assertLc4XaiManualTurnReplayProjection(projection)).not.toThrow();
    const tampered = {
      provider: "xai",
      transport_mode: "manual_commit",
      wire_observations: wire,
      xai_manual_turn_causality: rehash({
        ...body(wire),
        response_id_sha256: sha256Hex(RESPONSE_ID),
      }),
    } as unknown as JsonValue;
    expect(() => assertLc4XaiManualTurnReplayProjection(tampered)).toThrow(/causality/u);
  });
});

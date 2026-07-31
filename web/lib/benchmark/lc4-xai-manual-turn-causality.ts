import { canonicalJson, sha256Hex, type JsonValue } from "./artifacts";
import { realtimeWireIdentitySha256 } from "../realtime/client/wire-evidence";
import type { RealtimeWireObservation } from "../realtime/client/types";

const SHA256 = /^[a-f0-9]{64}$/u;
export const LC4_XAI_MANUAL_TURN_CAUSALITY_SCHEMA_VERSION = 1 as const;
export const LC4_XAI_MANUAL_TURN_CAUSALITY_DOMAIN =
  "harshas-amazing-call-center/lc4-xai-manual-turn-causality/v1\n";

export type Lc4SanitizedWireObservation = Readonly<{
  provider: "openai" | "gemini" | "xai";
  direction: "inbound" | "outbound";
  connection_epoch: number;
  sequence: number;
  wire_type: string;
  payload_sha256: string;
  payload_bytes: number;
  projection_sha256: string;
  observation_sha256: string;
  previous_observation_sha256: string | null;
  identity_hashes: RealtimeWireObservation["identities"];
}>;

export type Lc4XaiManualTurnCausalityWireObservation = Pick<
  Lc4SanitizedWireObservation,
  | "provider"
  | "direction"
  | "connection_epoch"
  | "sequence"
  | "wire_type"
  | "observation_sha256"
  | "previous_observation_sha256"
  | "identity_hashes"
>;

export type Lc4XaiManualTurnCausalityEvidence = Readonly<{
  schema_version: typeof LC4_XAI_MANUAL_TURN_CAUSALITY_SCHEMA_VERSION;
  connection_epoch: number;
  commit_observation_sha256: string;
  commit_sequence: number;
  commit_ack_observation_sha256: string;
  commit_ack_sequence: number;
  response_create_observation_sha256: string;
  response_create_sequence: number;
  response_start_observation_sha256: string;
  response_start_sequence: number;
  response_id_sha256: string;
  causality_sha256: string;
}>;

type CausalityBody = Omit<Lc4XaiManualTurnCausalityEvidence, "causality_sha256">;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function hashValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be one lowercase SHA-256`);
  }
  return value;
}

function parseObservation(
  value: unknown,
  index: number,
): Lc4XaiManualTurnCausalityWireObservation {
  const observation = objectValue(value, `xAI manual turn wire observation ${index + 1}`);
  const identities = objectValue(
    observation.identity_hashes,
    `xAI manual turn wire observation ${index + 1} identities`,
  );
  if (observation.provider !== "openai"
    && observation.provider !== "gemini"
    && observation.provider !== "xai") {
    throw new Error(`xAI manual turn wire observation ${index + 1} has an invalid provider`);
  }
  if (observation.direction !== "inbound" && observation.direction !== "outbound") {
    throw new Error(`xAI manual turn wire observation ${index + 1} has an invalid direction`);
  }
  if (typeof observation.wire_type !== "string" || observation.wire_type.length === 0) {
    throw new Error(`xAI manual turn wire observation ${index + 1} has an invalid wire type`);
  }
  const predecessor = observation.previous_observation_sha256;
  if (predecessor !== null && (typeof predecessor !== "string" || !SHA256.test(predecessor))) {
    throw new Error(`xAI manual turn wire observation ${index + 1} has an invalid predecessor`);
  }
  const responseIdSha256 = identities.responseIdSha256;
  if (responseIdSha256 !== undefined
    && (typeof responseIdSha256 !== "string" || !SHA256.test(responseIdSha256))) {
    throw new Error(`xAI manual turn wire observation ${index + 1} has an invalid response identity`);
  }
  return Object.freeze({
    provider: observation.provider,
    direction: observation.direction,
    connection_epoch: positiveSafeInteger(
      observation.connection_epoch,
      `xAI manual turn wire observation ${index + 1} connection epoch`,
    ),
    sequence: positiveSafeInteger(
      observation.sequence,
      `xAI manual turn wire observation ${index + 1} sequence`,
    ),
    wire_type: observation.wire_type,
    observation_sha256: hashValue(
      observation.observation_sha256,
      `xAI manual turn wire observation ${index + 1} hash`,
    ),
    previous_observation_sha256: predecessor,
    identity_hashes: Object.freeze({
      ...(typeof identities.eventIdSha256 === "string"
        ? { eventIdSha256: hashValue(identities.eventIdSha256, "wire event identity") }
        : {}),
      ...(typeof identities.sessionIdSha256 === "string"
        ? { sessionIdSha256: hashValue(identities.sessionIdSha256, "wire session identity") }
        : {}),
      ...(typeof responseIdSha256 === "string" ? { responseIdSha256 } : {}),
      ...(typeof identities.itemIdSha256 === "string"
        ? { itemIdSha256: hashValue(identities.itemIdSha256, "wire item identity") }
        : {}),
      ...(typeof identities.callIdSha256 === "string"
        ? { callIdSha256: hashValue(identities.callIdSha256, "wire call identity") }
        : {}),
    }),
  });
}

function parseEvidence(value: unknown): Lc4XaiManualTurnCausalityEvidence {
  const evidence = objectValue(value, "xAI manual turn causality evidence");
  if (evidence.schema_version !== LC4_XAI_MANUAL_TURN_CAUSALITY_SCHEMA_VERSION) {
    throw new Error("xAI manual turn causality schema version is unsupported");
  }
  return Object.freeze({
    schema_version: LC4_XAI_MANUAL_TURN_CAUSALITY_SCHEMA_VERSION,
    connection_epoch: positiveSafeInteger(evidence.connection_epoch, "xAI manual turn connection epoch"),
    commit_observation_sha256: hashValue(evidence.commit_observation_sha256, "xAI manual turn commit observation"),
    commit_sequence: positiveSafeInteger(evidence.commit_sequence, "xAI manual turn commit sequence"),
    commit_ack_observation_sha256: hashValue(
      evidence.commit_ack_observation_sha256,
      "xAI manual turn commit acknowledgement observation",
    ),
    commit_ack_sequence: positiveSafeInteger(
      evidence.commit_ack_sequence,
      "xAI manual turn commit acknowledgement sequence",
    ),
    response_create_observation_sha256: hashValue(
      evidence.response_create_observation_sha256,
      "xAI manual turn response create observation",
    ),
    response_create_sequence: positiveSafeInteger(
      evidence.response_create_sequence,
      "xAI manual turn response create sequence",
    ),
    response_start_observation_sha256: hashValue(
      evidence.response_start_observation_sha256,
      "xAI manual turn response start observation",
    ),
    response_start_sequence: positiveSafeInteger(
      evidence.response_start_sequence,
      "xAI manual turn response start sequence",
    ),
    response_id_sha256: hashValue(evidence.response_id_sha256, "xAI manual turn response identity"),
    causality_sha256: hashValue(evidence.causality_sha256, "xAI manual turn causality"),
  });
}

function assertRetainedWireSlice(
  observations: readonly Lc4XaiManualTurnCausalityWireObservation[],
): void {
  if (observations.length === 0) throw new Error("xAI manual turn wire observation slice is empty");
  const hashes = new Set<string>();
  const positions = new Set<string>();
  for (const [index, observation] of observations.entries()) {
    if (hashes.has(observation.observation_sha256)) {
      throw new Error("xAI manual turn wire observation slice contains a duplicate observation");
    }
    hashes.add(observation.observation_sha256);
    const position = `${observation.connection_epoch}:${observation.sequence}`;
    if (positions.has(position)) {
      throw new Error("xAI manual turn wire observation slice contains a duplicate sequence");
    }
    positions.add(position);
    if (index === 0) continue;
    const previous = observations[index - 1]!;
    if (observation.connection_epoch !== previous.connection_epoch
      || observation.sequence !== previous.sequence + 1
      || observation.previous_observation_sha256 !== previous.observation_sha256) {
      throw new Error("xAI manual turn retained wire slice is reordered, truncated, or chain-tampered");
    }
  }
}

function exactlyOneWireObservation(
  observations: readonly Lc4XaiManualTurnCausalityWireObservation[],
  input: Readonly<{
    observation_sha256: string;
    direction: "inbound" | "outbound";
    wire_type: string;
    label: string;
  }>,
): Lc4XaiManualTurnCausalityWireObservation {
  const matches = observations.filter((observation) => (
    observation.observation_sha256 === input.observation_sha256
  ));
  if (matches.length !== 1) {
    throw new Error(
      `xAI manual turn ${input.label} must resolve to exactly one wire observation`,
    );
  }
  const observation = matches[0]!;
  if (observation.provider !== "xai"
    || observation.direction !== input.direction
    || observation.wire_type !== input.wire_type) {
    throw new Error(
      `xAI manual turn ${input.label} wire observation has the wrong causal role`,
    );
  }
  return observation;
}

function assertManualSpeechActivityTelemetry(
  observations: readonly Lc4XaiManualTurnCausalityWireObservation[],
  input: Readonly<{
    connection_epoch: number;
    commit_ack_sequence: number;
  }>,
): void {
  const started = observations.filter((observation) => (
    observation.provider === "xai"
    && observation.direction === "inbound"
    && observation.wire_type === "input_audio_buffer.speech_started"
  ));
  const stopped = observations.filter((observation) => (
    observation.provider === "xai"
    && observation.direction === "inbound"
    && observation.wire_type === "input_audio_buffer.speech_stopped"
  ));
  if (started.length === 0 && stopped.length === 0) return;
  if (started.length !== 1 || stopped.length !== 1) {
    throw new Error(
      "xAI manual speech telemetry must be absent or one complete started/stopped pair",
    );
  }
  const start = started[0]!;
  const stop = stopped[0]!;
  if (start.connection_epoch !== input.connection_epoch
    || stop.connection_epoch !== input.connection_epoch
    || !(start.sequence < stop.sequence
      && stop.sequence < input.commit_ack_sequence)
    || start.identity_hashes.responseIdSha256 !== undefined
    || stop.identity_hashes.responseIdSha256 !== undefined
    || start.identity_hashes.callIdSha256 !== undefined
    || stop.identity_hashes.callIdSha256 !== undefined) {
    throw new Error(
      "xAI manual speech telemetry acquired turn, response, or tool authority",
    );
  }
}

export function assertLc4XaiManualSpeechActivityTelemetry(
  observationInput: readonly unknown[],
  input: Readonly<{
    connection_epoch: number;
    commit_ack_sequence: number;
  }>,
): void {
  const observations = Object.freeze(observationInput.map(parseObservation));
  assertRetainedWireSlice(observations);
  assertManualSpeechActivityTelemetry(observations, input);
}

export function assertLc4XaiManualTurnCausality(
  evidenceInput: unknown,
  observationInput: readonly unknown[],
): Lc4XaiManualTurnCausalityEvidence {
  const evidence = parseEvidence(evidenceInput);
  const observations = Object.freeze(observationInput.map(parseObservation));
  assertRetainedWireSlice(observations);
  const commit = exactlyOneWireObservation(observations, {
    observation_sha256: evidence.commit_observation_sha256,
    direction: "outbound",
    wire_type: "input_audio_buffer.commit",
    label: "commit",
  });
  const acknowledgement = exactlyOneWireObservation(observations, {
    observation_sha256: evidence.commit_ack_observation_sha256,
    direction: "inbound",
    wire_type: "input_audio_buffer.committed",
    label: "commit acknowledgement",
  });
  const create = exactlyOneWireObservation(observations, {
    observation_sha256: evidence.response_create_observation_sha256,
    direction: "outbound",
    wire_type: "response.create",
    label: "response create",
  });
  const start = exactlyOneWireObservation(observations, {
    observation_sha256: evidence.response_start_observation_sha256,
    direction: "inbound",
    wire_type: "response.created",
    label: "response start",
  });
  const ordered = [commit, acknowledgement, create, start];
  if (ordered.some((observation) => (
    observation.connection_epoch !== evidence.connection_epoch
  ))
    || evidence.commit_sequence !== commit.sequence
    || evidence.commit_ack_sequence !== acknowledgement.sequence
    || evidence.response_create_sequence !== create.sequence
    || evidence.response_start_sequence !== start.sequence
    || !(commit.sequence < acknowledgement.sequence
      && acknowledgement.sequence < create.sequence
      && create.sequence < start.sequence)
    || start.identity_hashes.responseIdSha256 === undefined
    || evidence.response_id_sha256 !== start.identity_hashes.responseIdSha256) {
    throw new Error(
      "xAI manual turn wire observations violate commit/ack/create/start causality",
    );
  }
  assertManualSpeechActivityTelemetry(observations, {
    connection_epoch: evidence.connection_epoch,
    commit_ack_sequence: acknowledgement.sequence,
  });
  const causalInterval = observations.filter((observation) => (
    observation.connection_epoch === evidence.connection_epoch
    && observation.sequence >= commit.sequence
    && observation.sequence <= start.sequence
  ));
  for (const wireType of [
    "input_audio_buffer.commit",
    "input_audio_buffer.committed",
    "response.create",
    "response.created",
  ]) {
    if (causalInterval.filter((observation) => observation.wire_type === wireType).length !== 1) {
      throw new Error("xAI manual turn causal interval crosses another input turn or response");
    }
  }
  const body = {
    schema_version: LC4_XAI_MANUAL_TURN_CAUSALITY_SCHEMA_VERSION,
    connection_epoch: evidence.connection_epoch,
    commit_observation_sha256: evidence.commit_observation_sha256,
    commit_sequence: evidence.commit_sequence,
    commit_ack_observation_sha256: evidence.commit_ack_observation_sha256,
    commit_ack_sequence: evidence.commit_ack_sequence,
    response_create_observation_sha256: evidence.response_create_observation_sha256,
    response_create_sequence: evidence.response_create_sequence,
    response_start_observation_sha256: evidence.response_start_observation_sha256,
    response_start_sequence: evidence.response_start_sequence,
    response_id_sha256: evidence.response_id_sha256,
  };
  if (evidence.causality_sha256 !== sha256Hex(
    `${LC4_XAI_MANUAL_TURN_CAUSALITY_DOMAIN}${canonicalJson(body)}`,
  )) {
    throw new Error("xAI manual turn causality hash is invalid");
  }
  return evidenceInput as Lc4XaiManualTurnCausalityEvidence;
}

export function lc4XaiManualResponseWireIdentitySha256(responseId: string): string {
  return realtimeWireIdentitySha256("response", responseId);
}

export function createLc4XaiManualTurnCausality(
  body: CausalityBody,
  observations: readonly Lc4XaiManualTurnCausalityWireObservation[],
): Lc4XaiManualTurnCausalityEvidence {
  const evidence = Object.freeze({
    ...body,
    causality_sha256: sha256Hex(
      `${LC4_XAI_MANUAL_TURN_CAUSALITY_DOMAIN}${canonicalJson(body)}`,
    ),
  });
  return assertLc4XaiManualTurnCausality(evidence, observations);
}

export function assertLc4XaiManualTurnReplayProjection(projection: JsonValue): void {
  const exchange = objectValue(projection, "LC4 provider exchange replay projection");
  const evidence = exchange.xai_manual_turn_causality;
  const isManualXai = exchange.provider === "xai" && exchange.transport_mode === "manual_commit";
  if (!isManualXai) {
    if (evidence !== null && evidence !== undefined) {
      throw new Error("xAI manual turn causality evidence is attached to a non-manual exchange");
    }
    return;
  }
  if (!Array.isArray(exchange.wire_observations) || evidence === null || evidence === undefined) {
    throw new Error("xAI manual turn replay lacks its retained causality evidence or wire observations");
  }
  assertLc4XaiManualTurnCausality(evidence, exchange.wire_observations);
}

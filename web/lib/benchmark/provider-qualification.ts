import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, sha256Hex } from "./artifacts";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import type { TrialSessionConfiguration } from "./orchestrator";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  RealtimeWireObservation,
  SessionConfigurationAcknowledgement,
} from "../realtime/client/types";
import { LC4_XAI_SERVER_VAD_SHA256 } from "./xai-server-vad";
import { verifyRealtimeWireObservationChain } from "../realtime/client/wire-evidence";
import { XAI_FUNCTION_TOOL_ALIAS_POLICY_SHA256 } from "../realtime/client/openai-compatible";

export const PROVIDER_QUALIFICATION_SCHEMA_VERSION = 3 as const;
export const PROVIDER_QUALIFICATION_MAX_AGE_MS = 30 * 60_000;
const MAX_CLOCK_SKEW_MS = 2 * 60_000;
const QUALIFICATION_HASH_DOMAIN = "harshas-amazing-call-center/provider-qualification/v3";
const MATRIX_HASH_DOMAIN = "harshas-amazing-call-center/provider-qualification-matrix/v1";
const RESPONSE_CANARY_HASH_DOMAIN = "harshas-amazing-call-center/provider-response-tool-canary/v1";
const SETUP_FAILURE_EVIDENCE_DOMAIN = "harshas-amazing-call-center/provider-setup-failure-evidence/v1\n";
export const XAI_SERVER_VAD_SETTING_SHA256 = LC4_XAI_SERVER_VAD_SHA256;
export const XAI_SERVER_VAD_OMITTED_PATHS = Object.freeze([
  "turn_detection.type",
  "turn_detection.threshold",
  "turn_detection.silence_duration_ms",
  "turn_detection.prefix_padding_ms",
]);
const XAI_SERVER_VAD_OMITTED_PATH_SET = new Set(XAI_SERVER_VAD_OMITTED_PATHS);
export const XAI_GATEWAY_TOOL_OMITTED_PATHS = Object.freeze([
  "tools[0].description",
  "tools[0].name",
  "tools[0].parameters",
]);
const XAI_GATEWAY_TOOL_OMITTED_PATH_SET = new Set(XAI_GATEWAY_TOOL_OMITTED_PATHS);
export const XAI_SERVER_VAD_CONDITIONAL_POLICY_SHA256 = sha256Hex(
  `harshas-amazing-call-center/xai-server-vad-conditional-policy/v2\n${canonicalJson({
    allowedOmittedPaths: [...XAI_SERVER_VAD_OMITTED_PATHS].sort(),
    allowedGatewayToolOmittedPaths: [...XAI_GATEWAY_TOOL_OMITTED_PATHS].sort(),
    exactMutableEchoFields: ["model", "instructions", "tool_choice", "input_audio", "output_audio"],
    createdSnapshotOnlyAllowedFields: ["voice"],
    gatewayConstraint: "exactly_one_function_capability_gateway",
    evidenceAggregation: "per_field_only_no_independent_whole_session_gate",
    explicitContradictionsFatal: true,
    promotion: "ordered_provider_native_vad_lifecycle",
  })}`,
);

export type ProviderSetupWireEvidence = Readonly<{
  provider: LiveStsProvider;
  connectionEpoch: number;
  requestWireType: "session.update" | "setup";
  acknowledgementWireType: "session.updated" | "setupComplete";
  requestObservationSha256: string;
  acknowledgementObservationSha256: string;
  sessionIdentity?: Readonly<{
    createdSessionIdSha256: string | null;
    updatedSessionIdSha256: string | null;
    status: "verified" | "unverifiable";
  }>;
  observations: readonly RealtimeWireObservation[];
}>;

export type ProviderSetupFailureEvidence = Readonly<{
  schemaVersion: 1;
  provider: LiveStsProvider;
  connectionEpoch: number | null;
  requestObservationSha256: string | null;
  terminalObservationSha256: string | null;
  observationCount: number;
  observations: readonly RealtimeWireObservation[];
  sessionIdentity: Readonly<{
    createdSessionIdSha256: string | null;
    updatedSessionIdSha256: string | null;
    status: "verified" | "unverifiable";
  }>;
  fatal: Readonly<{
    code: string;
    wireType: string;
    messageSha256: string;
    detailsSha256: string | null;
  }>;
  evidenceSha256: string;
}>;

export type ProviderQualificationTarget = Readonly<{
  provider: LiveStsProvider;
  model: string;
  configuration: TrialSessionConfiguration;
}>;

export type ProviderQualificationCode =
  | "configuration_echo_verified"
  | "configuration_accepted_partial_echo"
  | "acknowledged_unverifiable_server_vad"
  | "initial_snapshot_exact_only"
  | "setup_accepted_without_field_echo"
  | "credential_missing"
  | "unauthenticated"
  | "quota_blocked"
  | "configuration_rejected"
  | "acknowledgement_missing"
  | "acknowledgement_incomplete"
  | "provider_identity_mismatch"
  | "timeout"
  | "handshake_failed";

export type ProviderQualificationResult = Readonly<{
  provider: LiveStsProvider;
  model: string;
  requestedConfigurationSha256: string;
  attemptedAt: string;
  completedAt: string;
  status: "passed" | "failed";
  code: ProviderQualificationCode;
  acknowledgementMode: "exact_provider_echo" | "partial_provider_echo" | "conditional_server_vad_echo" | "initial_snapshot_exact_only" | "setup_complete_no_field_echo" | "none";
  acknowledgementSha256: string | null;
  toolSchemaVerification: "verified_by_provider_echo" | "requires_paid_response_canary" | "not_requested";
  turnBoundaryVerification: "verified_by_provider_echo" | "requires_paid_behavioral_canary" | "not_verified" | "not_applicable";
  turnBoundaryEvidence?: Readonly<{
    requestedSettingSha256: typeof XAI_SERVER_VAD_SETTING_SHA256;
    acknowledgement: "verified_echo" | "bounded_server_vad_omission" | "initial_snapshot_exact_only";
    omittedPaths: readonly string[];
    acknowledgedShape: "verified_value" | "empty_object" | "partial_value";
  }>;
  toolBoundaryEvidence?: Readonly<{
    requestedToolCount: 1;
    acknowledgedToolCount: 1;
    exactFunctionTypeVerified: true;
    omittedPaths: readonly string[];
    verification: "bounded_gateway_metadata_omission_requires_paid_exact_call" | "xai_function_wire_alias_requires_paid_exact_call";
    aliasNormalization?: NonNullable<SessionConfigurationAcknowledgement["fields"]["tools"]["aliasNormalization"]>;
  }>;
  initialConfigurationEvidence?: Readonly<{
    observationSha256: string;
    connectionEpoch: number;
    exactFields: readonly string[];
    scope: "provider_created_defaults_before_client_update";
    claimBoundary: "matching_initial_snapshot_does_not_acknowledge_later_session_update";
  }>;
  configurationEvidence?: SessionConfigurationAcknowledgement;
  setupWireEvidence?: ProviderSetupWireEvidence;
  setupFailureEvidence?: ProviderSetupFailureEvidence;
}>;

export type ProviderQualificationArtifact = Readonly<{
  schemaVersion: typeof PROVIDER_QUALIFICATION_SCHEMA_VERSION;
  qualificationId: string;
  protocolId: string;
  planSha256: string;
  sourceCommit: string;
  configurationMatrixSha256: string;
  credentialSetSha256: string;
  probeScope: "session_handshake_and_configuration_acknowledgement_no_audio_no_generation";
  attemptedAt: string;
  completedAt: string;
  status: "passed" | "conditional" | "failed";
  results: readonly ProviderQualificationResult[];
  artifactSha256: string;
}>;

export type ProviderResponseToolCanaryResult = Readonly<{
  provider: LiveStsProvider;
  model: string;
  toolSchemaSha256: string;
  attemptedAt: string;
  completedAt: string;
  status: "passed" | "failed";
  code: "gateway_tool_call_observed" | "tool_call_not_observed" | "response_generation_failed";
  callerAudioBytes: 0;
  responseGenerationEvidenceSha256: string;
  providerToolCallEvidenceSha256: string | null;
}>;

export type ProviderResponseToolCanaryArtifact = Readonly<{
  schemaVersion: 1;
  canaryId: string;
  protocolId: string;
  planSha256: string;
  sourceCommit: string;
  configurationMatrixSha256: string;
  credentialSetSha256: string;
  probeScope: "paid_response_generation_tool_call_no_caller_audio";
  attemptedAt: string;
  completedAt: string;
  status: "passed" | "failed";
  results: readonly ProviderResponseToolCanaryResult[];
  artifactSha256: string;
}>;

type QualifyInput = Readonly<{
  root: string;
  protocolId: string;
  planSha256: string;
  sourceCommit: string;
  targets: readonly ProviderQualificationTarget[];
  credentials: Readonly<Partial<Record<LiveStsProvider, string>>>;
  createClient: (
    target: ProviderQualificationTarget,
    apiKey: string,
  ) => NormalizedRealtimeClient | Promise<NormalizedRealtimeClient>;
  now?: () => Date;
  qualificationId?: string;
}>;

type GateInput = Readonly<{
  root: string;
  protocolId: string;
  planSha256: string;
  sourceCommit: string;
  targets: readonly ProviderQualificationTarget[];
  credentials: Readonly<Partial<Record<LiveStsProvider, string>>>;
  now?: () => Date;
}>;

type RecordResponseCanaryInput = Readonly<{
  root: string;
  protocolId: string;
  planSha256: string;
  sourceCommit: string;
  targets: readonly ProviderQualificationTarget[];
  credentials: Readonly<Partial<Record<LiveStsProvider, string>>>;
  results: readonly ProviderResponseToolCanaryResult[];
  attemptedAt: string;
  completedAt: string;
  canaryId?: string;
}>;

function configurationSha256(target: ProviderQualificationTarget): string {
  return sha256Hex(`harshas-amazing-call-center/provider-session-configuration/v1\n${canonicalJson({
    provider: target.provider,
    model: target.model,
    configuration: target.configuration,
  })}`);
}

function normalizedMatrix(targets: readonly ProviderQualificationTarget[]) {
  for (const target of targets) {
    if (target.configuration.provider !== target.provider || target.configuration.model !== target.model) {
      throw new Error("provider qualification target identity differs from its session configuration");
    }
  }
  const entries = targets.map((target) => Object.freeze({
    provider: target.provider,
    model: target.model,
    requestedConfigurationSha256: configurationSha256(target),
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const unique = new Set(entries.map((entry) => canonicalJson(entry)));
  if (unique.size !== entries.length) throw new Error("provider qualification targets contain a duplicate configuration");
  if (entries.length === 0) throw new Error("provider qualification requires at least one target");
  const providers = new Set(entries.map((entry) => entry.provider));
  if (["openai", "gemini", "xai"].some((provider) => !providers.has(provider as LiveStsProvider))) {
    throw new Error("provider qualification matrix must include OpenAI, Gemini, and xAI");
  }
  return Object.freeze(entries);
}

export function providerQualificationMatrixSha256(
  targets: readonly ProviderQualificationTarget[],
): string {
  return sha256Hex(`${MATRIX_HASH_DOMAIN}\n${canonicalJson(normalizedMatrix(targets))}`);
}

function providerCredentialSetSha256(
  credentials: Readonly<Partial<Record<LiveStsProvider, string>>>,
): string {
  return sha256Hex(`harshas-amazing-call-center/provider-credential-set/v1\n${canonicalJson(
    (["openai", "gemini", "xai"] as const).map((provider) => ({
      provider,
      credentialSha256: credentials[provider]
        ? sha256Hex(`harshas-amazing-call-center/provider-credential/v1\n${credentials[provider]}`)
        : null,
    })),
  )}`);
}

function acknowledgementSha256(value: SessionConfigurationAcknowledgement): string {
  return sha256Hex(`harshas-amazing-call-center/provider-configuration-acknowledgement/v1\n${canonicalJson(value)}`);
}

function sortedUniquePaths(paths: readonly string[]): readonly string[] | null {
  const sorted = [...paths].sort();
  return new Set(sorted).size === sorted.length ? Object.freeze(sorted) : null;
}

function boundedOmission(
  paths: readonly string[],
  allowed: ReadonlySet<string>,
): readonly string[] | null {
  const normalized = sortedUniquePaths(paths);
  return normalized !== null && normalized.length > 0 && normalized.every((path) => allowed.has(path))
    ? normalized
    : null;
}

function setupWireEvidence(observations: readonly RealtimeWireObservation[]): ProviderSetupWireEvidence | null {
  if (!verifyRealtimeWireObservationChain(observations).valid) return null;
  const provider = observations[0]?.provider;
  if (provider !== "openai" && provider !== "gemini" && provider !== "xai") return null;
  if (observations.some((observation) => observation.provider !== provider)) return null;
  const requestWireType = provider === "gemini" ? "setup" as const : "session.update" as const;
  const acknowledgementWireType = provider === "gemini" ? "setupComplete" as const : "session.updated" as const;
  const outboundCandidates = observations.filter((observation) => (
    observation.direction === "outbound" && observation.wireType === requestWireType
  ));
  const inboundCandidates = observations.filter((observation) => (
    observation.direction === "inbound" && observation.wireType === acknowledgementWireType
  ));
  if (outboundCandidates.length !== 1 || inboundCandidates.length !== 1) return null;
  const outbound = outboundCandidates[0]!;
  const inbound = inboundCandidates[0]!;
  if (inbound.connectionEpoch !== outbound.connectionEpoch || inbound.sequence <= outbound.sequence) return null;
  if (!outbound || !inbound) return null;
  let sessionIdentity: ProviderSetupWireEvidence["sessionIdentity"];
  if (provider === "xai") {
    const createdCandidates = observations.filter((observation) => (
      observation.direction === "inbound"
        && observation.wireType === "session.created"
        && observation.connectionEpoch === outbound.connectionEpoch
    ));
    if (createdCandidates.length !== 1) return null;
    const created = createdCandidates[0]!;
    if (created.sequence <= outbound.sequence || created.sequence >= inbound.sequence) return null;
    const createdSessionIdSha256 = created.identities.sessionIdSha256 ?? null;
    const updatedSessionIdSha256 = inbound.identities.sessionIdSha256 ?? null;
    if (createdSessionIdSha256 !== null
      && updatedSessionIdSha256 !== null
      && createdSessionIdSha256 !== updatedSessionIdSha256) return null;
    sessionIdentity = Object.freeze({
      createdSessionIdSha256,
      updatedSessionIdSha256,
      status: createdSessionIdSha256 !== null && updatedSessionIdSha256 !== null
        ? "verified" as const
        : "unverifiable" as const,
    });
  }
  return Object.freeze({
    provider,
    connectionEpoch: outbound.connectionEpoch,
    requestWireType,
    acknowledgementWireType,
    requestObservationSha256: outbound.observationSha256,
    acknowledgementObservationSha256: inbound.observationSha256,
    ...(sessionIdentity === undefined ? {} : { sessionIdentity }),
    observations: Object.freeze([...observations]),
  });
}

function validSetupWireEvidence(evidence: ProviderSetupWireEvidence): boolean {
  if (!verifyRealtimeWireObservationChain(evidence.observations).valid) return false;
  if (evidence.provider !== "openai" && evidence.provider !== "gemini" && evidence.provider !== "xai") return false;
  const expectedRequest = evidence.provider === "gemini" ? "setup" : "session.update";
  const expectedAcknowledgement = evidence.provider === "gemini" ? "setupComplete" : "session.updated";
  const outbound = evidence.observations.find((observation) => (
    observation.observationSha256 === evidence.requestObservationSha256
  ));
  const inbound = evidence.observations.find((observation) => (
    observation.observationSha256 === evidence.acknowledgementObservationSha256
  ));
  const exactRequestCount = evidence.observations.filter((observation) => (
    observation.direction === "outbound" && observation.wireType === expectedRequest
  )).length;
  const exactAcknowledgementCount = evidence.observations.filter((observation) => (
    observation.direction === "inbound" && observation.wireType === expectedAcknowledgement
  )).length;
  const validXaiCreated = evidence.provider !== "xai" || (() => {
    const created = evidence.observations.filter((observation) => (
      observation.direction === "inbound" && observation.wireType === "session.created"
    ));
    if (created.length !== 1 || outbound === undefined || inbound === undefined) return false;
    const createdId = created[0]!.identities.sessionIdSha256 ?? null;
    const updatedId = inbound.identities.sessionIdSha256 ?? null;
    const status = createdId !== null && updatedId !== null ? "verified" : "unverifiable";
    return created[0]!.connectionEpoch === evidence.connectionEpoch
      && outbound.sequence < created[0]!.sequence
      && created[0]!.sequence < inbound.sequence
      && (createdId === null || updatedId === null || createdId === updatedId)
      && evidence.sessionIdentity?.createdSessionIdSha256 === createdId
      && evidence.sessionIdentity?.updatedSessionIdSha256 === updatedId
      && evidence.sessionIdentity?.status === status;
  })();
  return evidence.requestWireType === expectedRequest
    && evidence.acknowledgementWireType === expectedAcknowledgement
    && evidence.observations.every((observation) => observation.provider === evidence.provider)
    && evidence.observations.every((observation) => observation.connectionEpoch === 1)
    && exactRequestCount === 1
    && exactAcknowledgementCount === 1
    && validXaiCreated
    && outbound?.direction === "outbound"
    && outbound.wireType === expectedRequest
    && inbound?.direction === "inbound"
    && inbound.wireType === expectedAcknowledgement
    && outbound.connectionEpoch === evidence.connectionEpoch
    && inbound.connectionEpoch === evidence.connectionEpoch
    && outbound.sequence < inbound.sequence;
}

function safeFailureToken(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_.:-]{0,127}$/iu.test(value)
    ? value.toLowerCase()
    : fallback;
}

function createSetupFailureEvidence(input: Readonly<{
  provider: LiveStsProvider;
  observations: readonly RealtimeWireObservation[];
  error: unknown;
  fatalEvent: Extract<NormalizedRealtimeEvent, { type: "error" }> | null;
}>): ProviderSetupFailureEvidence {
  const observations = Object.freeze([...input.observations]);
  const chain = verifyRealtimeWireObservationChain(observations);
  if (observations.length > 0 && !chain.valid) throw new Error("provider setup failure wire chain failed integrity");
  if (observations.some((observation) => observation.provider !== input.provider)) {
    throw new Error("provider setup failure wire chain crossed providers");
  }
  const epochs = [...new Set(observations.map((observation) => observation.connectionEpoch))];
  if (epochs.length > 1) throw new Error("provider setup failure crossed connection epochs");
  const requestWireType = input.provider === "gemini" ? "setup" : "session.update";
  const request = observations.find((observation) => observation.direction === "outbound" && observation.wireType === requestWireType);
  const created = observations.find((observation) => observation.direction === "inbound" && observation.wireType === "session.created");
  const updated = [...observations].reverse().find((observation) => observation.direction === "inbound" && observation.wireType === "session.updated");
  const createdSessionIdSha256 = created?.identities.sessionIdSha256 ?? null;
  const updatedSessionIdSha256 = updated?.identities.sessionIdSha256 ?? null;
  const message = input.fatalEvent?.message ?? (input.error instanceof Error ? input.error.message : String(input.error));
  const fatal = Object.freeze({
    code: safeFailureToken(input.fatalEvent?.code, classifiedFailure(input.error)),
    wireType: safeFailureToken(input.fatalEvent?.wireType, "client.connect"),
    messageSha256: sha256Hex(`harshas-amazing-call-center/provider-setup-failure-message/v1\n${message}`),
    detailsSha256: input.fatalEvent?.details === undefined
      ? null
      : sha256Hex(`harshas-amazing-call-center/provider-setup-failure-details/v1\n${canonicalJson(input.fatalEvent.details)}`),
  });
  const withoutHash = Object.freeze({
    schemaVersion: 1 as const,
    provider: input.provider,
    connectionEpoch: epochs[0] ?? null,
    requestObservationSha256: request?.observationSha256 ?? null,
    terminalObservationSha256: observations.at(-1)?.observationSha256 ?? null,
    observationCount: observations.length,
    observations,
    sessionIdentity: Object.freeze({
      createdSessionIdSha256,
      updatedSessionIdSha256,
      status: createdSessionIdSha256 !== null && updatedSessionIdSha256 !== null && createdSessionIdSha256 === updatedSessionIdSha256
        ? "verified" as const
        : "unverifiable" as const,
    }),
    fatal,
  });
  return Object.freeze({
    ...withoutHash,
    evidenceSha256: sha256Hex(`${SETUP_FAILURE_EVIDENCE_DOMAIN}${canonicalJson(withoutHash)}`),
  });
}

function validSetupFailureEvidence(evidence: ProviderSetupFailureEvidence): boolean {
  const { evidenceSha256, ...body } = evidence;
  const chain = verifyRealtimeWireObservationChain(evidence.observations);
  const epochs = [...new Set(evidence.observations.map((observation) => observation.connectionEpoch))];
  const created = evidence.observations.find((observation) => observation.direction === "inbound" && observation.wireType === "session.created");
  const updated = [...evidence.observations].reverse().find((observation) => observation.direction === "inbound" && observation.wireType === "session.updated");
  const createdId = created?.identities.sessionIdSha256 ?? null;
  const updatedId = updated?.identities.sessionIdSha256 ?? null;
  const expectedIdentity = createdId !== null && updatedId !== null && createdId === updatedId ? "verified" : "unverifiable";
  return evidence.schemaVersion === 1
    && /^[a-f0-9]{64}$/u.test(evidence.fatal.messageSha256)
    && (evidence.fatal.detailsSha256 === null || /^[a-f0-9]{64}$/u.test(evidence.fatal.detailsSha256))
    && /^[a-z0-9][a-z0-9_.:-]{0,127}$/u.test(evidence.fatal.code)
    && /^[a-z0-9][a-z0-9_.:-]{0,127}$/u.test(evidence.fatal.wireType)
    && evidence.observationCount === evidence.observations.length
    && (evidence.observations.length === 0 || chain.valid)
    && evidence.observations.every((observation) => observation.provider === evidence.provider)
    && epochs.length <= 1
    && evidence.connectionEpoch === (epochs[0] ?? null)
    && evidence.terminalObservationSha256 === (evidence.observations.at(-1)?.observationSha256 ?? null)
    && evidence.sessionIdentity.createdSessionIdSha256 === createdId
    && evidence.sessionIdentity.updatedSessionIdSha256 === updatedId
    && evidence.sessionIdentity.status === expectedIdentity
    && evidenceSha256 === sha256Hex(`${SETUP_FAILURE_EVIDENCE_DOMAIN}${canonicalJson(body)}`);
}

type SessionWireProjection = Readonly<{
  fieldSha256?: Readonly<Record<string, string>>;
  toolCount?: number;
}>;

function sessionProjection(observation: RealtimeWireObservation | undefined): SessionWireProjection | null {
  if (observation === undefined || typeof observation.projection.session !== "object" || observation.projection.session === null) {
    return null;
  }
  return observation.projection.session as SessionWireProjection;
}

function initialConfigurationEvidence(
  wire: ProviderSetupWireEvidence,
  acknowledgement: SessionConfigurationAcknowledgement,
): ProviderQualificationResult["initialConfigurationEvidence"] {
  const created = wire.observations.find((observation) => (
    observation.direction === "inbound"
      && observation.wireType === "session.created"
      && observation.connectionEpoch === wire.connectionEpoch
      && observation.sequence < wire.observations.find((candidate) => (
        candidate.observationSha256 === wire.acknowledgementObservationSha256
      ))!.sequence
  ));
  const fields = sessionProjection(created)?.fieldSha256;
  if (created === undefined || fields === undefined) return undefined;
  const exactFields = Object.entries(acknowledgement.fields)
    .filter(([field, proof]) => proof.requestedSha256 !== undefined && fields[field] === proof.requestedSha256)
    .map(([field]) => field)
    .sort();
  return Object.freeze({
    observationSha256: created.observationSha256,
    connectionEpoch: created.connectionEpoch,
    exactFields: Object.freeze(exactFields),
    scope: "provider_created_defaults_before_client_update" as const,
    claimBoundary: "matching_initial_snapshot_does_not_acknowledge_later_session_update" as const,
  });
}

function exactGatewayTarget(target: ProviderQualificationTarget): boolean {
  if (target.configuration.providerTools.length !== 1) return false;
  const tool = target.configuration.providerTools[0];
  return typeof tool === "object"
    && tool !== null
    && !Array.isArray(tool)
    && (tool as Record<string, unknown>).type === "function"
    && (tool as Record<string, unknown>).name === "capability_gateway";
}

function validXaiToolAliasEvidence(
  evidence: NonNullable<SessionConfigurationAcknowledgement["fields"]["tools"]["aliasNormalization"]> | undefined,
): boolean {
  if (evidence === undefined) return false;
  const allowedPaths = new Set(["tools[0]", "tools[0].function"]);
  const inventories = new Map(evidence.keyInventory.map((entry) => [entry.path, entry.keys]));
  return evidence.kind === "xai_function_tool_wire_alias_v1"
    && evidence.policySha256 === XAI_FUNCTION_TOOL_ALIAS_POLICY_SHA256
    && /^[a-f0-9]{64}$/u.test(evidence.canonicalSha256)
    && evidence.claimBoundary === "wire_alias_equivalence_only_paid_exact_call_still_required"
    && evidence.sourcePaths.length === new Set(evidence.sourcePaths).size
    && evidence.sourcePaths.every((path) => allowedPaths.has(path))
    && evidence.sourcePaths.includes("tools[0].function")
    && evidence.keyInventory.length === inventories.size
    && evidence.keyInventory.every((entry) => allowedPaths.has(entry.path)
      && entry.keys.length === new Set(entry.keys).size
      && [...entry.keys].sort().join("\0") === entry.keys.join("\0")
      && entry.keys.every((key) => ["type", "function", "name", "description", "parameters"].includes(key)))
    && inventories.has("tools[0].function");
}

function acknowledgementResult(
  target: ProviderQualificationTarget,
  readyEvent: Extract<NormalizedRealtimeEvent, { type: "session.ready" }> | null,
  fallback: SessionConfigurationAcknowledgement | null | undefined,
  wireObservations: readonly RealtimeWireObservation[],
): Pick<ProviderQualificationResult, "status" | "code" | "acknowledgementMode" | "acknowledgementSha256" | "toolSchemaVerification" | "turnBoundaryVerification" | "turnBoundaryEvidence" | "configurationEvidence" | "setupWireEvidence"> {
  const toolSchemaVerification = target.configuration.providerTools.length === 0
    ? "not_requested" as const
    : "requires_paid_response_canary" as const;
  const unverifiedTurnBoundary = target.provider === "gemini" ? "not_applicable" as const : "not_verified" as const;
  if (readyEvent?.provider !== target.provider) {
    return { status: "failed", code: "provider_identity_mismatch", acknowledgementMode: "none", acknowledgementSha256: null, toolSchemaVerification, turnBoundaryVerification: unverifiedTurnBoundary };
  }
  const acknowledgement = readyEvent.configuration ?? fallback ?? null;
  if (!acknowledgement) {
    return { status: "failed", code: "acknowledgement_missing", acknowledgementMode: "none", acknowledgementSha256: null, toolSchemaVerification, turnBoundaryVerification: unverifiedTurnBoundary };
  }
  const digest = acknowledgementSha256(acknowledgement);
  const observedWireEvidence = setupWireEvidence(wireObservations);
  const fields = Object.values(acknowledgement.fields);
  if (fields.some((field) => field.status === "mismatch")) {
    return {
      status: "failed",
      code: "configuration_rejected",
      acknowledgementMode: "none",
      acknowledgementSha256: digest,
      toolSchemaVerification,
      turnBoundaryVerification: unverifiedTurnBoundary,
      ...(target.provider === "xai" ? { configurationEvidence: acknowledgement } : {}),
      ...(observedWireEvidence !== null
        ? { setupWireEvidence: observedWireEvidence }
        : {}),
    };
  }
  if (target.provider === "gemini") {
    const allowed = fields.every((field) => field.status === "unverifiable" || field.status === "not_requested");
    if (
      readyEvent.wireType !== "setupComplete"
      || acknowledgement.strictParityVerified
      || acknowledgement.paidBenchmarkReady
      || !allowed
      || observedWireEvidence === null
    ) {
      return { status: "failed", code: "acknowledgement_incomplete", acknowledgementMode: "none", acknowledgementSha256: digest, toolSchemaVerification, turnBoundaryVerification: "not_applicable" };
    }
    return {
      status: "passed",
      code: "setup_accepted_without_field_echo",
      acknowledgementMode: "setup_complete_no_field_echo",
      acknowledgementSha256: digest,
      toolSchemaVerification,
      turnBoundaryVerification: "not_applicable",
      setupWireEvidence: observedWireEvidence,
    };
  }
  if (target.provider === "xai") {
    const requiredEchoes = ([
      "model",
      "instructions",
      "tool_choice",
      "input_audio",
      "output_audio",
    ] as const).map((field) => acknowledgement.fields[field]);
    const turnBoundaryProof = acknowledgement.fields.turn_detection;
    const omittedTurnPaths = turnBoundaryProof.status === "unverifiable"
      && turnBoundaryProof.omission?.kind === "requested_paths_omitted"
      ? boundedOmission(turnBoundaryProof.omission.paths, XAI_SERVER_VAD_OMITTED_PATH_SET)
      : null;
    const toolProof = acknowledgement.fields.tools;
    const omittedToolPaths = toolProof.status === "unverifiable"
      && toolProof.omission?.kind === "requested_paths_omitted"
      ? boundedOmission(toolProof.omission.paths, XAI_GATEWAY_TOOL_OMITTED_PATH_SET)
      : null;
    const wireEvidence = observedWireEvidence;
    const acknowledgedObservation = wireEvidence?.observations.find((observation) => (
      observation.observationSha256 === wireEvidence.acknowledgementObservationSha256
    ));
    const acknowledgedToolCount = sessionProjection(acknowledgedObservation)?.toolCount;
    const boundedGatewayToolOmission = omittedToolPaths !== null
      && exactGatewayTarget(target)
      && acknowledgedToolCount === 1
      && toolProof.contradiction === undefined;
    const xaiToolAlias = toolProof.aliasNormalization;
    const boundedXaiToolAlias = xaiToolAlias !== undefined
      && validXaiToolAliasEvidence(xaiToolAlias)
      && exactGatewayTarget(target)
      && acknowledgedToolCount === 1
      && toolProof.contradiction === undefined;
    const conditionalServerVad = omittedTurnPaths !== null
      && turnBoundaryProof.contradiction === undefined;
    const initialEvidence = wireEvidence === null
      ? undefined
      : initialConfigurationEvidence(wireEvidence, acknowledgement);
    const initialTurnExact = initialEvidence?.exactFields.includes("turn_detection") ?? false;
    const voiceProof = acknowledgement.fields.voice;
    const initialVoiceExact = initialEvidence?.exactFields.includes("voice") ?? false;
    const voiceAccepted = voiceProof.status === "verified"
      || (voiceProof.status === "unverifiable"
        && initialVoiceExact
        && voiceProof.contradiction === undefined);
    const toolAccepted = (toolProof.status === "verified"
        && (xaiToolAlias === undefined || boundedXaiToolAlias))
      || (toolProof.status === "not_requested" && target.configuration.providerTools.length === 0)
      || boundedGatewayToolOmission;
    if (
      readyEvent.wireType !== "session.updated"
      || requiredEchoes.some((field) => field.status !== "verified")
      || !voiceAccepted
      || !toolAccepted
      || (turnBoundaryProof.status !== "verified" && !conditionalServerVad)
      || wireEvidence === null
    ) {
      return {
        status: "failed",
        code: "acknowledgement_incomplete",
        acknowledgementMode: "none",
        acknowledgementSha256: digest,
        toolSchemaVerification,
        turnBoundaryVerification: "not_verified",
        configurationEvidence: acknowledgement,
        ...(wireEvidence === null ? {} : { setupWireEvidence: wireEvidence }),
      };
    }
    const toolBoundaryEvidence = boundedGatewayToolOmission
      || boundedXaiToolAlias
      ? Object.freeze({
          requestedToolCount: 1 as const,
          acknowledgedToolCount: 1 as const,
          exactFunctionTypeVerified: true as const,
          omittedPaths: omittedToolPaths ?? Object.freeze([]),
          verification: boundedXaiToolAlias
            ? "xai_function_wire_alias_requires_paid_exact_call" as const
            : "bounded_gateway_metadata_omission_requires_paid_exact_call" as const,
          ...(boundedXaiToolAlias ? { aliasNormalization: xaiToolAlias } : {}),
        })
      : undefined;
    if (conditionalServerVad) {
      const initialSnapshotRequired = initialTurnExact;
      return {
        status: "passed",
        code: initialSnapshotRequired
          ? "initial_snapshot_exact_only"
          : "acknowledged_unverifiable_server_vad",
        acknowledgementMode: initialSnapshotRequired
          ? "initial_snapshot_exact_only"
          : "conditional_server_vad_echo",
        acknowledgementSha256: digest,
        toolSchemaVerification: boundedGatewayToolOmission || boundedXaiToolAlias
          ? "requires_paid_response_canary"
          : target.configuration.providerTools.length === 0
            ? "not_requested"
            : "verified_by_provider_echo",
        turnBoundaryVerification: "requires_paid_behavioral_canary",
        configurationEvidence: acknowledgement,
        setupWireEvidence: wireEvidence,
        ...(initialEvidence === undefined ? {} : { initialConfigurationEvidence: initialEvidence }),
        ...(toolBoundaryEvidence === undefined ? {} : { toolBoundaryEvidence }),
        turnBoundaryEvidence: Object.freeze({
          requestedSettingSha256: XAI_SERVER_VAD_SETTING_SHA256,
          acknowledgement: conditionalServerVad
            ? initialTurnExact
              ? "initial_snapshot_exact_only" as const
              : "bounded_server_vad_omission" as const
            : "verified_echo" as const,
          omittedPaths: conditionalServerVad ? omittedTurnPaths! : Object.freeze([]),
          acknowledgedShape: conditionalServerVad
            ? turnBoundaryProof.omission!.acknowledgedShape === "empty_object"
              ? "empty_object" as const
              : "partial_value" as const
            : "verified_value" as const,
        }),
      };
    }
    return {
      status: "passed",
      code: acknowledgement.strictParityVerified && acknowledgement.paidBenchmarkReady
        ? "configuration_echo_verified"
        : "configuration_accepted_partial_echo",
      acknowledgementMode: acknowledgement.strictParityVerified && acknowledgement.paidBenchmarkReady
        ? "exact_provider_echo"
        : "partial_provider_echo",
      acknowledgementSha256: digest,
      configurationEvidence: acknowledgement,
      setupWireEvidence: wireEvidence,
      ...(initialEvidence === undefined ? {} : { initialConfigurationEvidence: initialEvidence }),
      ...(toolBoundaryEvidence === undefined ? {} : { toolBoundaryEvidence }),
      toolSchemaVerification: target.configuration.providerTools.length === 0
        ? "not_requested"
        : toolProof.status === "verified" && !boundedXaiToolAlias
          ? "verified_by_provider_echo"
          : "requires_paid_response_canary",
      turnBoundaryVerification: "verified_by_provider_echo",
      turnBoundaryEvidence: Object.freeze({
        requestedSettingSha256: XAI_SERVER_VAD_SETTING_SHA256,
        acknowledgement: "verified_echo" as const,
        omittedPaths: Object.freeze([]),
        acknowledgedShape: "verified_value" as const,
      }),
    };
  }
  if (!acknowledgement.strictParityVerified || !acknowledgement.paidBenchmarkReady || observedWireEvidence === null) {
    return { status: "failed", code: "acknowledgement_incomplete", acknowledgementMode: "none", acknowledgementSha256: digest, toolSchemaVerification, turnBoundaryVerification: unverifiedTurnBoundary };
  }
  return {
    status: "passed",
    code: "configuration_echo_verified",
    acknowledgementMode: "exact_provider_echo",
    acknowledgementSha256: digest,
    setupWireEvidence: observedWireEvidence,
    toolSchemaVerification: target.configuration.providerTools.length === 0
      ? "not_requested"
      : acknowledgement.fields.tools.status === "verified"
        ? "verified_by_provider_echo"
        : "requires_paid_response_canary",
    turnBoundaryVerification: acknowledgement.fields.turn_detection.status === "verified"
      ? "verified_by_provider_echo"
      : "not_verified",
  };
}

function classifiedFailure(error: unknown): ProviderQualificationCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/quota|rate.?limit|resource.?exhausted|insufficient.?quota|billing|\b429\b/i.test(message)) return "quota_blocked";
  if (/unauth|authentication|api.?key|permission.?denied|forbidden|\b401\b|\b403\b/i.test(message)) return "unauthenticated";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/config|setup|model|voice|tool|invalid.?argument|unsupported|\b400\b|\b404\b|\b422\b/i.test(message)) {
    return "configuration_rejected";
  }
  return "handshake_failed";
}

async function qualifyTarget(
  target: ProviderQualificationTarget,
  apiKey: string | undefined,
  createClient: QualifyInput["createClient"],
  now: () => Date,
): Promise<ProviderQualificationResult> {
  const attemptedAt = now().toISOString();
  const requestedConfigurationSha256 = configurationSha256(target);
  if (!apiKey || apiKey.length < 12) {
    return Object.freeze({
      provider: target.provider,
      model: target.model,
      requestedConfigurationSha256,
      attemptedAt,
      completedAt: now().toISOString(),
      status: "failed",
      code: "credential_missing",
      acknowledgementMode: "none",
      acknowledgementSha256: null,
      toolSchemaVerification: target.configuration.providerTools.length === 0 ? "not_requested" : "requires_paid_response_canary",
      turnBoundaryVerification: target.provider === "gemini" ? "not_applicable" : "not_verified",
    });
  }
  let client: NormalizedRealtimeClient | null = null;
  let readyEvent: Extract<NormalizedRealtimeEvent, { type: "session.ready" }> | null = null;
  let fatalEvent: Extract<NormalizedRealtimeEvent, { type: "error" }> | null = null;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeWire: (() => void) | undefined;
  const wireObservations: RealtimeWireObservation[] = [];
  try {
    client = await createClient(target, apiKey);
    unsubscribe = client.onEvent((event) => {
      if (event.type === "session.ready") readyEvent = event;
      if (event.type === "error" && event.fatal) fatalEvent = event;
    });
    unsubscribeWire = client.onWireObservation?.((observation) => {
      wireObservations.push(observation);
    });
    await client.connect();
    if (client.state !== "ready") {
      const failureEvidence = createSetupFailureEvidence({
        provider: target.provider,
        observations: wireObservations,
        error: new Error("realtime client did not reach ready state"),
        fatalEvent,
      });
      return Object.freeze({
        provider: target.provider,
        model: target.model,
        requestedConfigurationSha256,
        attemptedAt,
        completedAt: now().toISOString(),
        status: "failed",
        code: "handshake_failed",
        acknowledgementMode: "none",
        acknowledgementSha256: null,
        toolSchemaVerification: target.configuration.providerTools.length === 0 ? "not_requested" : "requires_paid_response_canary",
        turnBoundaryVerification: target.provider === "gemini" ? "not_applicable" : "not_verified",
        setupFailureEvidence: failureEvidence,
      });
    }
    const outcome = acknowledgementResult(
      target,
      readyEvent,
      client.sessionConfigurationAcknowledgement,
      wireObservations,
    );
    return Object.freeze({
      provider: target.provider,
      model: target.model,
      requestedConfigurationSha256,
      attemptedAt,
      completedAt: now().toISOString(),
      ...outcome,
    });
  } catch (error) {
    const failureEvidence = createSetupFailureEvidence({
      provider: target.provider,
      observations: wireObservations,
      error,
      fatalEvent,
    });
    return Object.freeze({
      provider: target.provider,
      model: target.model,
      requestedConfigurationSha256,
      attemptedAt,
      completedAt: now().toISOString(),
      status: "failed",
      code: classifiedFailure(error),
      acknowledgementMode: "none",
      acknowledgementSha256: null,
      toolSchemaVerification: target.configuration.providerTools.length === 0 ? "not_requested" : "requires_paid_response_canary",
      turnBoundaryVerification: target.provider === "gemini" ? "not_applicable" : "not_verified",
      setupFailureEvidence: failureEvidence,
    });
  } finally {
    unsubscribe?.();
    unsubscribeWire?.();
    client?.close(1000, "qualification complete");
  }
}

function qualificationArtifactSha256(body: Omit<ProviderQualificationArtifact, "artifactSha256">): string {
  return sha256Hex(`${QUALIFICATION_HASH_DOMAIN}\n${canonicalJson(body)}`);
}

function expectedQualificationStatus(results: readonly ProviderQualificationResult[]): ProviderQualificationArtifact["status"] {
  if (results.some((result) => result.status === "failed")) return "failed";
  return results.some((result) => result.toolSchemaVerification === "requires_paid_response_canary"
    || result.turnBoundaryVerification === "requires_paid_behavioral_canary")
    ? "conditional"
    : "passed";
}

export function assertProviderQualificationArtifactIntegrity(
  artifact: ProviderQualificationArtifact,
): void {
  if (artifact.schemaVersion !== PROVIDER_QUALIFICATION_SCHEMA_VERSION) throw new Error("unsupported provider qualification schema");
  const { artifactSha256, ...body } = artifact;
  if (qualificationArtifactSha256(body) !== artifactSha256) throw new Error("provider qualification artifact hash mismatch");
  if (!artifact.results.length) throw new Error("provider qualification artifact has no results");
  if (artifact.status !== expectedQualificationStatus(artifact.results)) {
    throw new Error("provider qualification aggregate status is inconsistent");
  }
  for (const result of artifact.results) {
    const conditionalServerVad = result.turnBoundaryVerification === "requires_paid_behavioral_canary";
    if (conditionalServerVad !== (result.provider === "xai"
      && result.status === "passed"
      && result.turnBoundaryVerification === "requires_paid_behavioral_canary"
      && (result.acknowledgementMode === "conditional_server_vad_echo"
        || result.acknowledgementMode === "initial_snapshot_exact_only")
      && (result.code === "acknowledged_unverifiable_server_vad"
        || result.code === "initial_snapshot_exact_only"))) {
      throw new Error("provider qualification server-VAD classification is inconsistent");
    }
    if ((result.code === "acknowledged_unverifiable_server_vad") !== (
      conditionalServerVad
      && result.acknowledgementMode === "conditional_server_vad_echo"
    )) throw new Error("provider qualification server-VAD acknowledgement mode is inconsistent");
    if (conditionalServerVad && (
      result.turnBoundaryEvidence?.requestedSettingSha256 !== XAI_SERVER_VAD_SETTING_SHA256
      || (result.turnBoundaryEvidence.acknowledgement !== "bounded_server_vad_omission"
        && result.turnBoundaryEvidence.acknowledgement !== "initial_snapshot_exact_only")
      || boundedOmission(result.turnBoundaryEvidence.omittedPaths, XAI_SERVER_VAD_OMITTED_PATH_SET) === null
      || result.configurationEvidence === undefined
      || result.setupWireEvidence === undefined
      || result.acknowledgementSha256 !== acknowledgementSha256(result.configurationEvidence)
      || !validSetupWireEvidence(result.setupWireEvidence)
    )) throw new Error("provider qualification server-VAD omission evidence is inconsistent");
    const retainedInitialEvidence = result.initialConfigurationEvidence;
    const retainedVoiceProof = result.configurationEvidence?.fields.voice;
    const initialTurnFallback = result.turnBoundaryEvidence?.acknowledgement === "initial_snapshot_exact_only"
      && result.turnBoundaryVerification === "requires_paid_behavioral_canary"
      && retainedInitialEvidence?.exactFields.includes("turn_detection") === true;
    const initialVoiceFallback = retainedVoiceProof?.status === "unverifiable"
      && retainedVoiceProof.contradiction === undefined
      && retainedVoiceProof.omission?.kind === "field_omitted"
      && canonicalJson(retainedVoiceProof.omission.paths) === canonicalJson(["voice"])
      && retainedVoiceProof.omission.acknowledgedShape === "missing"
      && retainedInitialEvidence?.exactFields.includes("voice") === true;
    if ((result.code === "initial_snapshot_exact_only") !== (
      result.acknowledgementMode === "initial_snapshot_exact_only"
      && initialTurnFallback
      && retainedInitialEvidence?.scope === "provider_created_defaults_before_client_update"
      && retainedInitialEvidence.claimBoundary === "matching_initial_snapshot_does_not_acknowledge_later_session_update"
      && result.setupWireEvidence !== undefined
      && result.configurationEvidence !== undefined
      && canonicalJson(retainedInitialEvidence) === canonicalJson(initialConfigurationEvidence(
        result.setupWireEvidence,
        result.configurationEvidence,
      ))
    )) throw new Error("provider qualification initial-exact evidence is inconsistent");
    if (result.provider === "xai"
      && result.status === "passed"
      && retainedVoiceProof?.status === "unverifiable"
      && !initialVoiceFallback) {
      throw new Error("provider qualification initial voice fallback evidence is inconsistent");
    }
    const retainedToolProof = result.configurationEvidence?.fields.tools;
    const retainedToolOmissions = retainedToolProof?.status === "unverifiable"
      && retainedToolProof.omission?.kind === "requested_paths_omitted"
      ? boundedOmission(retainedToolProof.omission.paths, XAI_GATEWAY_TOOL_OMITTED_PATH_SET)
      : null;
    const retainedToolAlias = retainedToolProof?.aliasNormalization;
    const acknowledgementObservation = result.setupWireEvidence?.observations.find((observation) => (
      observation.observationSha256 === result.setupWireEvidence?.acknowledgementObservationSha256
    ));
    const retainedBoundaryOmissions = result.toolBoundaryEvidence === undefined
      ? null
      : sortedUniquePaths(result.toolBoundaryEvidence.omittedPaths);
    if (result.toolBoundaryEvidence !== undefined && (
      result.provider !== "xai"
      || result.status !== "passed"
      || result.toolSchemaVerification !== "requires_paid_response_canary"
      || result.toolBoundaryEvidence.requestedToolCount !== 1
      || result.toolBoundaryEvidence.acknowledgedToolCount !== 1
      || result.toolBoundaryEvidence.exactFunctionTypeVerified !== true
      || (result.toolBoundaryEvidence.verification !== "bounded_gateway_metadata_omission_requires_paid_exact_call"
        && result.toolBoundaryEvidence.verification !== "xai_function_wire_alias_requires_paid_exact_call")
      || retainedBoundaryOmissions === null
      || !retainedBoundaryOmissions.every((path) => XAI_GATEWAY_TOOL_OMITTED_PATH_SET.has(path))
      || (result.toolBoundaryEvidence.verification === "bounded_gateway_metadata_omission_requires_paid_exact_call"
        && retainedBoundaryOmissions.length === 0)
      || (result.toolBoundaryEvidence.verification === "bounded_gateway_metadata_omission_requires_paid_exact_call"
        && canonicalJson(result.toolBoundaryEvidence.omittedPaths) !== canonicalJson(retainedToolOmissions))
      || (result.toolBoundaryEvidence.verification === "xai_function_wire_alias_requires_paid_exact_call"
        && (retainedToolAlias === undefined
          || !validXaiToolAliasEvidence(retainedToolAlias)
          || canonicalJson(result.toolBoundaryEvidence.omittedPaths) !== canonicalJson(retainedToolOmissions ?? [])
          || canonicalJson(result.toolBoundaryEvidence.aliasNormalization) !== canonicalJson(retainedToolAlias)))
      || sessionProjection(acknowledgementObservation)?.toolCount !== 1
      || retainedToolProof?.contradiction !== undefined
    )) throw new Error("provider qualification gateway-tool omission evidence is inconsistent");
    if (result.provider === "xai"
      && result.status === "passed"
      && (retainedToolOmissions !== null || retainedToolAlias !== undefined)
      && result.toolBoundaryEvidence === undefined) {
      throw new Error("provider qualification omitted gateway-tool risk evidence");
    }
    if (result.provider === "xai"
      && result.status === "passed"
      && result.turnBoundaryVerification !== "verified_by_provider_echo"
      && result.turnBoundaryVerification !== "requires_paid_behavioral_canary") {
      throw new Error("passing xAI provider qualification lacks server-VAD verification");
    }
    if (result.status === "passed" && (
      result.setupWireEvidence === undefined
      || result.setupWireEvidence.provider !== result.provider
      || result.setupWireEvidence.connectionEpoch !== 1
      || !validSetupWireEvidence(result.setupWireEvidence)
    )) {
      throw new Error("passing provider qualification lacks one replayable setup session");
    }
    if (result.setupFailureEvidence !== undefined && (
      result.status !== "failed"
      || result.setupWireEvidence !== undefined
      || result.setupFailureEvidence.provider !== result.provider
      || !validSetupFailureEvidence(result.setupFailureEvidence)
    )) {
      throw new Error("provider qualification setup failure evidence is inconsistent");
    }
  }
}

export async function qualifyProviders(input: QualifyInput): Promise<ProviderQualificationArtifact> {
  const now = input.now ?? (() => new Date());
  const attemptedAt = now().toISOString();
  const qualificationId = input.qualificationId ?? randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(qualificationId)) {
    throw new Error("provider qualification ID must be a safe opaque identifier");
  }
  const targetsByProvider = new Map<LiveStsProvider, ProviderQualificationTarget[]>();
  for (const target of input.targets) {
    const list = targetsByProvider.get(target.provider) ?? [];
    list.push(target);
    targetsByProvider.set(target.provider, list);
  }
  const providerResults: ProviderQualificationResult[][] = [];
  // Provider admission is intentionally serialized in caller-supplied target
  // order. Qualification runners re-check signed expiry and evidence-root
  // identity in createClient; parallel admission would make the first admitted
  // provider scheduler-dependent and could admit peers after one check expires.
  for (const [provider, targets] of targetsByProvider.entries()) {
    const results: ProviderQualificationResult[] = [];
    for (const target of targets) {
      results.push(await qualifyTarget(target, input.credentials[provider], input.createClient, now));
    }
    providerResults.push(results);
  }
  const results = Object.freeze(providerResults.flat().sort((left, right) => (
    left.provider.localeCompare(right.provider)
    || left.model.localeCompare(right.model)
    || left.requestedConfigurationSha256.localeCompare(right.requestedConfigurationSha256)
  )));
  const body = Object.freeze({
    schemaVersion: PROVIDER_QUALIFICATION_SCHEMA_VERSION,
    qualificationId,
    protocolId: input.protocolId,
    planSha256: input.planSha256,
    sourceCommit: input.sourceCommit,
    configurationMatrixSha256: providerQualificationMatrixSha256(input.targets),
    credentialSetSha256: providerCredentialSetSha256(input.credentials),
    probeScope: "session_handshake_and_configuration_acknowledgement_no_audio_no_generation" as const,
    attemptedAt,
    completedAt: now().toISOString(),
    status: expectedQualificationStatus(results),
    results,
  });
  const artifact: ProviderQualificationArtifact = Object.freeze({
    ...body,
    artifactSha256: qualificationArtifactSha256(body),
  });
  const directory = resolve(input.root, "qualifications");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timestamp = attemptedAt.replace(/[:.]/g, "-");
  const path = resolve(directory, `${timestamp}-${artifact.qualificationId}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${canonicalJson(artifact)}\n`, { flag: "wx", mode: 0o600 });
  try {
    // Hard-link publication is atomic and fails rather than replacing an earlier immutable attempt.
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return artifact;
}

export function providerResponseToolCanaryRequirements(targets: readonly ProviderQualificationTarget[]) {
  const requirements = new Map<string, Readonly<{
    provider: LiveStsProvider;
    model: string;
    toolSchemaSha256: string;
  }>>();
  for (const target of targets) {
    if (target.configuration.providerTools.length === 0) continue;
    const requirement = Object.freeze({
      provider: target.provider,
      model: target.model,
      toolSchemaSha256: sha256Hex(`harshas-amazing-call-center/provider-tool-schema/v1\n${canonicalJson(
        target.configuration.providerTools,
      )}`),
    });
    requirements.set(canonicalJson(requirement), requirement);
  }
  return Object.freeze([...requirements.values()].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))));
}

function responseCanaryArtifactSha256(body: Omit<ProviderResponseToolCanaryArtifact, "artifactSha256">): string {
  return sha256Hex(`${RESPONSE_CANARY_HASH_DOMAIN}\n${canonicalJson(body)}`);
}

export function assertProviderResponseToolCanaryArtifactIntegrity(
  artifact: ProviderResponseToolCanaryArtifact,
  targets: readonly ProviderQualificationTarget[],
): void {
  if (artifact.schemaVersion !== 1) throw new Error("unsupported provider response canary schema");
  const { artifactSha256, ...body } = artifact;
  if (responseCanaryArtifactSha256(body) !== artifactSha256) throw new Error("provider response canary artifact hash mismatch");
  const expected = providerResponseToolCanaryRequirements(targets);
  const actual = artifact.results.map((result) => ({
    provider: result.provider,
    model: result.model,
    toolSchemaSha256: result.toolSchemaSha256,
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("provider response canary result matrix mismatch");
  for (const result of artifact.results) {
    if (result.callerAudioBytes !== 0) throw new Error("provider response canary cannot include caller audio");
    if (!/^[a-f0-9]{64}$/.test(result.responseGenerationEvidenceSha256)) {
      throw new Error("provider response canary generation evidence hash is invalid");
    }
    if (
      result.status === "passed"
      && (result.code !== "gateway_tool_call_observed" || !/^[a-f0-9]{64}$/.test(result.providerToolCallEvidenceSha256 ?? ""))
    ) {
      throw new Error("passing provider response canary lacks provider tool-call evidence");
    }
    if (result.status === "failed" && result.code === "gateway_tool_call_observed") {
      throw new Error("failed provider response canary cannot claim an observed gateway call");
    }
  }
  if (artifact.status === "passed" !== artifact.results.every((result) => result.status === "passed")) {
    throw new Error("provider response canary aggregate status is inconsistent");
  }
}

export async function recordProviderResponseToolCanary(
  input: RecordResponseCanaryInput,
): Promise<ProviderResponseToolCanaryArtifact> {
  const canaryId = input.canaryId ?? randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(canaryId)) {
    throw new Error("provider response canary ID must be a safe opaque identifier");
  }
  const sortedResults = Object.freeze([...input.results].sort((left, right) => (
    left.provider.localeCompare(right.provider)
    || left.model.localeCompare(right.model)
    || left.toolSchemaSha256.localeCompare(right.toolSchemaSha256)
  )));
  const body = Object.freeze({
    schemaVersion: 1 as const,
    canaryId,
    protocolId: input.protocolId,
    planSha256: input.planSha256,
    sourceCommit: input.sourceCommit,
    configurationMatrixSha256: providerQualificationMatrixSha256(input.targets),
    credentialSetSha256: providerCredentialSetSha256(input.credentials),
    probeScope: "paid_response_generation_tool_call_no_caller_audio" as const,
    attemptedAt: input.attemptedAt,
    completedAt: input.completedAt,
    status: sortedResults.every((result) => result.status === "passed") ? "passed" as const : "failed" as const,
    results: sortedResults,
  });
  const artifact: ProviderResponseToolCanaryArtifact = Object.freeze({
    ...body,
    artifactSha256: responseCanaryArtifactSha256(body),
  });
  assertProviderResponseToolCanaryArtifactIntegrity(artifact, input.targets);
  const directory = resolve(input.root, "response-tool-canaries");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timestamp = input.attemptedAt.replace(/[:.]/g, "-");
  const path = resolve(directory, `${timestamp}-${canaryId}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${canonicalJson(artifact)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return artifact;
}

async function assertRecentPassingResponseToolCanary(
  input: GateInput,
): Promise<ProviderResponseToolCanaryArtifact> {
  const directory = resolve(input.root, "response-tool-canaries");
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const expectedMatrix = providerQualificationMatrixSha256(input.targets);
  const expectedCredentials = providerCredentialSetSha256(input.credentials);
  const nowMs = (input.now ?? (() => new Date()))().getTime();
  const passing: ProviderResponseToolCanaryArtifact[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    try {
      const artifact = JSON.parse(await readFile(resolve(directory, name), "utf8")) as ProviderResponseToolCanaryArtifact;
      assertProviderResponseToolCanaryArtifactIntegrity(artifact, input.targets);
      if (
        artifact.status === "passed"
        && artifact.protocolId === input.protocolId
        && artifact.planSha256 === input.planSha256
        && artifact.sourceCommit === input.sourceCommit
        && artifact.configurationMatrixSha256 === expectedMatrix
        && artifact.credentialSetSha256 === expectedCredentials
        && artifact.probeScope === "paid_response_generation_tool_call_no_caller_audio"
      ) {
        const completedAtMs = Date.parse(artifact.completedAt);
        if (
          Number.isFinite(completedAtMs)
          && completedAtMs <= nowMs + MAX_CLOCK_SKEW_MS
          && nowMs - completedAtMs <= PROVIDER_QUALIFICATION_MAX_AGE_MS
        ) passing.push(artifact);
      }
    } catch (error) {
      throw new Error(`provider response canary artifact ${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const latest = passing.sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
  if (!latest) {
    throw new Error("paid run requires a recent passing paid response/tool-call canary because provider setup did not echo the tool schema");
  }
  return latest;
}

export async function assertRecentProviderHandshakeQualification(input: GateInput): Promise<ProviderQualificationArtifact> {
  const directory = resolve(input.root, "qualifications");
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const expectedMatrix = providerQualificationMatrixSha256(input.targets);
  const expectedCredentials = providerCredentialSetSha256(input.credentials);
  const nowMs = (input.now ?? (() => new Date()))().getTime();
  const passing: ProviderQualificationArtifact[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    let artifact: ProviderQualificationArtifact;
    try {
      artifact = JSON.parse(await readFile(resolve(directory, name), "utf8")) as ProviderQualificationArtifact;
      assertProviderQualificationArtifactIntegrity(artifact);
    } catch (error) {
      throw new Error(`provider qualification artifact ${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (
      (artifact.status !== "passed" && artifact.status !== "conditional")
      || artifact.protocolId !== input.protocolId
      || artifact.planSha256 !== input.planSha256
      || artifact.sourceCommit !== input.sourceCommit
      || artifact.configurationMatrixSha256 !== expectedMatrix
      || artifact.credentialSetSha256 !== expectedCredentials
      || artifact.probeScope !== "session_handshake_and_configuration_acknowledgement_no_audio_no_generation"
    ) continue;
    const completedAtMs = Date.parse(artifact.completedAt);
    if (
      Number.isFinite(completedAtMs)
      && completedAtMs <= nowMs + MAX_CLOCK_SKEW_MS
      && nowMs - completedAtMs <= PROVIDER_QUALIFICATION_MAX_AGE_MS
    ) passing.push(artifact);
  }
  const latest = passing.sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
  if (!latest) throw new Error("paid run requires a recent passing provider qualification bound to this exact plan and configuration matrix");
  return latest;
}

export async function assertRecentPassingProviderQualification(input: GateInput): Promise<ProviderQualificationArtifact> {
  return (await assertRecentPassingProviderQualificationBundle(input)).qualification;
}

export async function assertRecentPassingProviderQualificationBundle(input: GateInput): Promise<Readonly<{
  qualification: ProviderQualificationArtifact;
  responseToolCanary: ProviderResponseToolCanaryArtifact | null;
}>> {
  const qualification = await assertRecentProviderHandshakeQualification(input);
  if (qualification.results.some((result) => (
    result.turnBoundaryVerification === "requires_paid_behavioral_canary"
  ))) {
    throw new Error("paid run requires a spoken server-VAD behavioral qualification; a no-audio tool canary cannot discharge this risk");
  }
  const responseToolCanary = qualification.status === "conditional"
    ? await assertRecentPassingResponseToolCanary(input)
    : null;
  return Object.freeze({ qualification, responseToolCanary });
}

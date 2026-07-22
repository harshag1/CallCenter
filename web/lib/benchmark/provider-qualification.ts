import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, sha256Hex } from "./artifacts";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import type { TrialSessionConfiguration } from "./orchestrator";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  SessionConfigurationAcknowledgement,
} from "../realtime/client/types";

export const PROVIDER_QUALIFICATION_SCHEMA_VERSION = 1 as const;
export const PROVIDER_QUALIFICATION_MAX_AGE_MS = 30 * 60_000;
const MAX_CLOCK_SKEW_MS = 2 * 60_000;
const QUALIFICATION_HASH_DOMAIN = "harshas-amazing-call-center/provider-qualification/v1";
const MATRIX_HASH_DOMAIN = "harshas-amazing-call-center/provider-qualification-matrix/v1";
const RESPONSE_CANARY_HASH_DOMAIN = "harshas-amazing-call-center/provider-response-tool-canary/v1";
export const XAI_MANUAL_TURN_SETTING_SHA256 = sha256Hex(
  `harshas-amazing-call-center/lc4-xai-manual-turn-setting/v1\n${canonicalJson({ turn_detection: { type: null } })}`,
);

export type ProviderQualificationTarget = Readonly<{
  provider: LiveStsProvider;
  model: string;
  configuration: TrialSessionConfiguration;
}>;

export type ProviderQualificationCode =
  | "configuration_echo_verified"
  | "configuration_accepted_partial_echo"
  | "acknowledged_unverifiable_manual_turn"
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
  acknowledgementMode: "exact_provider_echo" | "partial_provider_echo" | "conditional_manual_turn_echo" | "setup_complete_no_field_echo" | "none";
  acknowledgementSha256: string | null;
  toolSchemaVerification: "verified_by_provider_echo" | "requires_paid_response_canary" | "not_requested";
  manualTurnModeVerification: "verified_by_provider_echo" | "requires_paid_behavioral_canary" | "not_verified" | "not_applicable";
  manualTurnModeEvidence?: Readonly<{
    requestedSettingSha256: typeof XAI_MANUAL_TURN_SETTING_SHA256;
    acknowledgement: "verified_echo" | "exact_empty_object_omission";
    omittedPaths: readonly string[];
    acknowledgedShape: "verified_value" | "empty_object";
  }>;
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

function acknowledgementResult(
  target: ProviderQualificationTarget,
  readyEvent: Extract<NormalizedRealtimeEvent, { type: "session.ready" }> | null,
  fallback: SessionConfigurationAcknowledgement | null | undefined,
): Pick<ProviderQualificationResult, "status" | "code" | "acknowledgementMode" | "acknowledgementSha256" | "toolSchemaVerification" | "manualTurnModeVerification" | "manualTurnModeEvidence"> {
  const toolSchemaVerification = target.configuration.providerTools.length === 0
    ? "not_requested" as const
    : "requires_paid_response_canary" as const;
  const unverifiedManualTurnMode = target.provider === "gemini" ? "not_applicable" as const : "not_verified" as const;
  if (readyEvent?.provider !== target.provider) {
    return { status: "failed", code: "provider_identity_mismatch", acknowledgementMode: "none", acknowledgementSha256: null, toolSchemaVerification, manualTurnModeVerification: unverifiedManualTurnMode };
  }
  const acknowledgement = readyEvent.configuration ?? fallback ?? null;
  if (!acknowledgement) {
    return { status: "failed", code: "acknowledgement_missing", acknowledgementMode: "none", acknowledgementSha256: null, toolSchemaVerification, manualTurnModeVerification: unverifiedManualTurnMode };
  }
  const digest = acknowledgementSha256(acknowledgement);
  const fields = Object.values(acknowledgement.fields);
  if (fields.some((field) => field.status === "mismatch")) {
    return { status: "failed", code: "configuration_rejected", acknowledgementMode: "none", acknowledgementSha256: digest, toolSchemaVerification, manualTurnModeVerification: unverifiedManualTurnMode };
  }
  if (target.provider === "gemini") {
    const allowed = fields.every((field) => field.status === "unverifiable" || field.status === "not_requested");
    if (
      readyEvent.wireType !== "setupComplete"
      || acknowledgement.strictParityVerified
      || acknowledgement.paidBenchmarkReady
      || !allowed
    ) {
      return { status: "failed", code: "acknowledgement_incomplete", acknowledgementMode: "none", acknowledgementSha256: digest, toolSchemaVerification, manualTurnModeVerification: "not_applicable" };
    }
    return {
      status: "passed",
      code: "setup_accepted_without_field_echo",
      acknowledgementMode: "setup_complete_no_field_echo",
      acknowledgementSha256: digest,
      toolSchemaVerification,
      manualTurnModeVerification: "not_applicable",
    };
  }
  if (target.provider === "xai") {
    const requiredEchoes = [
      acknowledgement.fields.model,
      acknowledgement.fields.instructions,
      acknowledgement.fields.tool_choice,
      acknowledgement.fields.output_audio,
    ];
    const manualTurnProof = acknowledgement.fields.turn_detection;
    const exactEmptyManualTurnOmission = manualTurnProof.status === "unverifiable"
      && manualTurnProof.omission?.kind === "requested_paths_omitted"
      && manualTurnProof.omission.acknowledgedShape === "empty_object"
      && canonicalJson(manualTurnProof.omission.paths) === canonicalJson(["turn_detection.type"]);
    const acceptedStatuses = fields.every((field) => (
      field.status === "verified" || field.status === "unverifiable" || field.status === "not_requested"
    ));
    if (
      readyEvent.wireType !== "session.updated"
      || requiredEchoes.some((field) => field.status !== "verified")
      || (manualTurnProof.status !== "verified" && !exactEmptyManualTurnOmission)
      || !acceptedStatuses
      || (acknowledgement.session?.status !== "verified" && acknowledgement.session?.status !== "unverifiable")
    ) {
      return { status: "failed", code: "acknowledgement_incomplete", acknowledgementMode: "none", acknowledgementSha256: digest, toolSchemaVerification, manualTurnModeVerification: "not_verified" };
    }
    if (exactEmptyManualTurnOmission) {
      return {
        status: "passed",
        code: "acknowledged_unverifiable_manual_turn",
        acknowledgementMode: "conditional_manual_turn_echo",
        acknowledgementSha256: digest,
        toolSchemaVerification,
        manualTurnModeVerification: "requires_paid_behavioral_canary",
        manualTurnModeEvidence: Object.freeze({
          requestedSettingSha256: XAI_MANUAL_TURN_SETTING_SHA256,
          acknowledgement: "exact_empty_object_omission" as const,
          omittedPaths: Object.freeze(["turn_detection.type"]),
          acknowledgedShape: "empty_object" as const,
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
      toolSchemaVerification: target.configuration.providerTools.length === 0
        ? "not_requested"
        : acknowledgement.fields.tools.status === "verified"
          ? "verified_by_provider_echo"
          : "requires_paid_response_canary",
      manualTurnModeVerification: "verified_by_provider_echo",
      manualTurnModeEvidence: Object.freeze({
        requestedSettingSha256: XAI_MANUAL_TURN_SETTING_SHA256,
        acknowledgement: "verified_echo" as const,
        omittedPaths: Object.freeze([]),
        acknowledgedShape: "verified_value" as const,
      }),
    };
  }
  if (!acknowledgement.strictParityVerified || !acknowledgement.paidBenchmarkReady) {
    return { status: "failed", code: "acknowledgement_incomplete", acknowledgementMode: "none", acknowledgementSha256: digest, toolSchemaVerification, manualTurnModeVerification: unverifiedManualTurnMode };
  }
  return {
    status: "passed",
    code: "configuration_echo_verified",
    acknowledgementMode: "exact_provider_echo",
    acknowledgementSha256: digest,
    toolSchemaVerification: target.configuration.providerTools.length === 0
      ? "not_requested"
      : acknowledgement.fields.tools.status === "verified"
        ? "verified_by_provider_echo"
        : "requires_paid_response_canary",
    manualTurnModeVerification: acknowledgement.fields.turn_detection.status === "verified"
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
      manualTurnModeVerification: target.provider === "gemini" ? "not_applicable" : "not_verified",
    });
  }
  let client: NormalizedRealtimeClient | null = null;
  let readyEvent: Extract<NormalizedRealtimeEvent, { type: "session.ready" }> | null = null;
  let unsubscribe: (() => void) | undefined;
  try {
    client = await createClient(target, apiKey);
    unsubscribe = client.onEvent((event) => {
      if (event.type === "session.ready") readyEvent = event;
    });
    await client.connect();
    if (client.state !== "ready") {
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
        manualTurnModeVerification: target.provider === "gemini" ? "not_applicable" : "not_verified",
      });
    }
    const outcome = acknowledgementResult(target, readyEvent, client.sessionConfigurationAcknowledgement);
    return Object.freeze({
      provider: target.provider,
      model: target.model,
      requestedConfigurationSha256,
      attemptedAt,
      completedAt: now().toISOString(),
      ...outcome,
    });
  } catch (error) {
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
      manualTurnModeVerification: target.provider === "gemini" ? "not_applicable" : "not_verified",
    });
  } finally {
    unsubscribe?.();
    client?.close(1000, "qualification complete");
  }
}

function qualificationArtifactSha256(body: Omit<ProviderQualificationArtifact, "artifactSha256">): string {
  return sha256Hex(`${QUALIFICATION_HASH_DOMAIN}\n${canonicalJson(body)}`);
}

function expectedQualificationStatus(results: readonly ProviderQualificationResult[]): ProviderQualificationArtifact["status"] {
  if (results.some((result) => result.status === "failed")) return "failed";
  return results.some((result) => result.toolSchemaVerification === "requires_paid_response_canary"
    || result.manualTurnModeVerification === "requires_paid_behavioral_canary")
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
    const conditionalManualTurn = result.code === "acknowledged_unverifiable_manual_turn";
    if (conditionalManualTurn !== (result.provider === "xai"
      && result.status === "passed"
      && result.acknowledgementMode === "conditional_manual_turn_echo"
      && result.manualTurnModeVerification === "requires_paid_behavioral_canary")) {
      throw new Error("provider qualification manual-turn classification is inconsistent");
    }
    if (conditionalManualTurn && (
      result.manualTurnModeEvidence?.requestedSettingSha256 !== XAI_MANUAL_TURN_SETTING_SHA256
      || result.manualTurnModeEvidence.acknowledgement !== "exact_empty_object_omission"
      || result.manualTurnModeEvidence.acknowledgedShape !== "empty_object"
      || canonicalJson(result.manualTurnModeEvidence.omittedPaths) !== canonicalJson(["turn_detection.type"])
    )) throw new Error("provider qualification manual-turn omission evidence is inconsistent");
    if (result.provider === "xai"
      && result.status === "passed"
      && result.manualTurnModeVerification !== "verified_by_provider_echo"
      && result.manualTurnModeVerification !== "requires_paid_behavioral_canary") {
      throw new Error("passing xAI provider qualification lacks manual-turn verification");
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
  const providerResults = await Promise.all([...targetsByProvider.entries()].map(async ([provider, targets]) => {
    const results: ProviderQualificationResult[] = [];
    for (const target of targets) {
      results.push(await qualifyTarget(target, input.credentials[provider], input.createClient, now));
    }
    return results;
  }));
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
    result.manualTurnModeVerification === "requires_paid_behavioral_canary"
  ))) {
    throw new Error("paid run requires a spoken manual-turn behavioral qualification; a no-audio tool canary cannot discharge this risk");
  }
  const responseToolCanary = qualification.status === "conditional"
    ? await assertRecentPassingResponseToolCanary(input)
    : null;
  return Object.freeze({ qualification, responseToolCanary });
}

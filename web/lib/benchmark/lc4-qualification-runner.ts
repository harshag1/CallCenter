import { createPublicKey, randomUUID, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, sha256Hex } from "./artifacts";
import {
  assertProviderQualificationArtifactIntegrity,
  assertProviderResponseToolCanaryArtifactIntegrity,
  providerQualificationMatrixSha256,
  providerResponseToolCanaryRequirements,
  qualifyProviders,
  recordProviderResponseToolCanary,
  type ProviderQualificationArtifact,
  type ProviderQualificationTarget,
  type ProviderResponseToolCanaryResult,
} from "./provider-qualification";
import { executeProviderResponseToolCanary, type ResponseToolCanaryExecution } from "./provider-response-tool-canary";
import {
  LC4_DEV_AUDIO_CANARY_CONTROL_BYTES,
  LC4_DEV_AUDIO_CANARY_CONTROL_SOURCE_SHA256,
  LC4_DEV_AUDIO_CANARY_PACKETIZER_SHA256,
  assertLc4DevAudioCanaryExecutionEvidence,
  executeLc4DevAudioCanary,
  lc4DevAudioCanaryFailureEvidenceSha256,
  lc4DevAudioCanaryProviderToolCallEvidenceSha256,
  lc4DevAudioCanarySpecification,
  type Lc4DevAudioCanaryExecution,
  type Lc4DevAudioCanaryFailureEvidence,
} from "./provider-dev-audio-canary";
import {
  createProductionRealtimeClient,
  loadProductionRealtimeCredentials,
} from "./production-realtime-provider";
import {
  LIVE_STS_PROVIDER_SPECS,
  type LiveStsProvider,
} from "./live-sts-development-experiment";
import {
  DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
  trialAudioDeliveryProfileHash,
  type TrialSessionConfiguration,
} from "./orchestrator";
import {
  LC4_PROVIDER_PROFILE_MANIFEST,
  assertLc4ProviderProfileManifest,
} from "./lc4-provider-profiles";
import { LC4_DEV_SEMANTIC_GATEWAY_FUNCTION } from "./lc4-development-gateway-bridge";
import {
  LOCAL_TOOL_PROXY_FUNCTION,
  type NormalizedRealtimeClient,
  type NormalizedRealtimeUsage,
  type RealtimeWireObservation,
} from "../realtime/client/types";
import {
  assertLc4QualificationBudgetEvidence,
  finalizeLc4QualificationBudget,
  lc4QualificationBudgetLedgerPath,
  reserveLc4QualificationBudget,
  type Lc4QualificationBudgetEvidence,
  type Lc4QualificationBudgetBinding,
} from "./lc4-qualification-budget";
import {
  filesystemBudgetLedgerContainsHead,
  inspectFilesystemBudgetLedger,
} from "./filesystem-budget-ledger";

export const LC4_QUALIFICATION_RUNNER_VERSION = "HACC-LC4-QUALIFICATION-RUNNER-v2" as const;
export const LC4_QUALIFICATION_AUTHORIZATION_VERSION = "HACC-LC4-QUALIFICATION-DEVELOPMENT-AUTHORIZATION-v2" as const;
export const LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD = 3_000_000 as const;
export const LC4_QUALIFICATION_MAXIMUM_PROVIDER_MICRO_USD = 1_000_000 as const;
export const LC4_QUALIFICATION_MAXIMUM_RESPONSE_GENERATIONS = 6 as const;
export const LC4_QUALIFICATION_TOTAL_CALLER_AUDIO_BYTES = 5_120 as const;
export const LC4_QUALIFICATION_PROVIDER_ORDER = Object.freeze(["openai", "gemini", "xai"] as const);

const PLAN_DOMAIN = "harshas-amazing-call-center/lc4-qualification-plan/v2\n";
const AUTHORIZATION_DOMAIN = "harshas-amazing-call-center/lc4-qualification-development-authorization/v2\n";
const AUTHORIZATION_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-development-authorization-artifact/v2\n";
const TERMINAL_DOMAIN = "harshas-amazing-call-center/lc4-qualification-terminal/v2\n";
const DEV_AUDIO_CANARY_DOMAIN = "harshas-amazing-call-center/lc4-dev-audio-canary-artifact/v1\n";
const CREDENTIAL_SET_DOMAIN = "harshas-amazing-call-center/provider-credential-set/v1\n";
const CREDENTIAL_DOMAIN = "harshas-amazing-call-center/provider-credential/v1\n";
const SOURCE_TREE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-git-tree/v1\n";
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const execFileAsync = promisify(execFile);

export type Lc4QualificationGitSource = Readonly<{
  source_commit: string;
  source_tree_oid: string;
  source_tree_sha256: string;
  worktree_clean: true;
}>;

export type Lc4QualificationPlan = Readonly<{
  schema_version: 1;
  runner_version: typeof LC4_QUALIFICATION_RUNNER_VERSION;
  protocol_id: "HACC-LC4-v1";
  plan_id: string;
  prepared_at: string;
  source_commit: string;
  source_tree_oid: string;
  source_tree_sha256: string;
  provider_profile_manifest_sha256: string;
  configuration_matrix_sha256: string;
  dev_configuration_matrix_sha256: string;
  credential_set_sha256: string;
  credential_identities: readonly Readonly<{
    provider: LiveStsProvider;
    credential_sha256: string;
  }>[];
  targets: readonly Readonly<{
    provider: LiveStsProvider;
    model: string;
    zero_audio_tool_schema_sha256: string;
    dev_audio_tool_schema_sha256: string;
    packetizer_sha256: string;
    audio_delivery_profile_sha256: string;
    dev_control_bytes: typeof LC4_DEV_AUDIO_CANARY_CONTROL_BYTES;
    dev_control_sha256: string;
    dev_control_source_sha256: typeof LC4_DEV_AUDIO_CANARY_CONTROL_SOURCE_SHA256;
    caller_audio_bytes: number;
    caller_audio_sha256: string;
    response_generations: 2;
    maximum_micro_usd: typeof LC4_QUALIFICATION_MAXIMUM_PROVIDER_MICRO_USD;
    paid_retry_allowed: false;
  }>[];
  execution_scope: "development_only_exact_model_handshake_zero_audio_gateway_then_exact_dev_schema_packetized_audio_canary";
  maximum_total_micro_usd: typeof LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD;
  provider_calls_authorized: false;
  authorization_required: "pinned_ed25519_development_artifact";
  plan_sha256: string;
}>;

export type Lc4QualificationAuthorizationBody = Readonly<{
  schema_version: 1;
  authorization_version: typeof LC4_QUALIFICATION_AUTHORIZATION_VERSION;
  authorization_id: string;
  authorization_nonce_sha256: string;
  protocol_id: "HACC-LC4-v1";
  purpose: "lc4_development_exact_model_zero_audio_and_exact_dev_schema_audio_canaries";
  plan_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  provider_profile_manifest_sha256: string;
  configuration_matrix_sha256: string;
  dev_configuration_matrix_sha256: string;
  credential_set_sha256: string;
  authorized_providers: readonly ["openai", "gemini", "xai"];
  authorized_models: Readonly<Record<LiveStsProvider, string>>;
  maximum_total_micro_usd: typeof LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD;
  caller_audio_bytes: typeof LC4_QUALIFICATION_TOTAL_CALLER_AUDIO_BYTES;
  maximum_response_generations: typeof LC4_QUALIFICATION_MAXIMUM_RESPONSE_GENERATIONS;
  paid_retry_allowed: false;
  not_before: string;
  expires_at: string;
}>;

export type Lc4QualificationAuthorizationArtifact = Readonly<{
  body: Lc4QualificationAuthorizationBody;
  authority_public_key_spki_base64: string;
  authority_public_key_fingerprint_sha256: string;
  signature_algorithm: "Ed25519";
  signature_base64: string;
  artifact_sha256: string;
}>;

export type Lc4QualificationTrustRoot = Readonly<{
  schema_version: 1;
  authority_public_key_fingerprint_sha256: string;
}>;

type SanitizedUsage = Readonly<Omit<NormalizedRealtimeUsage, "raw"> & {
  raw_usage_sha256: string;
}>;

type SanitizedWireObservation = Readonly<{
  schema_version: 1;
  provider: LiveStsProvider;
  direction: "inbound" | "outbound";
  connection_epoch: number;
  sequence: number;
  observed_at_ms: number;
  observed_at_monotonic_ms: number;
  wire_type: string;
  payload_sha256: string;
  payload_bytes: number;
  projection_sha256: string;
  previous_observation_sha256: string | null;
  observation_sha256: string;
  identities: RealtimeWireObservation["identities"];
  projection: RealtimeWireObservation["projection"];
}>;

export type Lc4QualificationTerminalArtifact = Readonly<{
  schema_version: 1;
  runner_version: typeof LC4_QUALIFICATION_RUNNER_VERSION;
  attempt_id: string;
  plan_sha256: string;
  authorization_artifact_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  attempted_at: string;
  completed_at: string;
  status: "passed" | "failed";
  qualification_artifact_sha256: string;
  response_tool_canary_artifact_sha256: string | null;
  dev_audio_canary_artifact_sha256: string | null;
  caller_audio_bytes: number;
  response_generations_attempted: number;
  paid_retries_attempted: 0;
  maximum_total_micro_usd: typeof LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD;
  results: readonly Readonly<{
    provider: LiveStsProvider;
    model: string;
    status: "passed" | "failed";
    code: ProviderResponseToolCanaryResult["code"];
    wire_observation_count: number;
    wire_evidence_sha256: string;
    usage_event_count: number;
    usage_evidence_sha256: string;
    provider_tool_call_evidence_sha256: string | null;
  }>[];
  dev_audio_results: readonly Readonly<{
    provider: LiveStsProvider;
    model: string;
    status: "passed" | "failed";
    code: Lc4DevAudioCanaryExecution["code"];
    caller_audio_bytes: number;
    response_generation_requested: boolean;
    tool_schema_sha256: string;
    packetizer_sha256: string;
    audio_delivery_profile_sha256: string;
    control_bytes: number;
    control_sha256: string;
    audio_sha256: string;
    delivery_complete: boolean;
    chunk_count: number;
    wire_observation_count: number;
    wire_evidence_sha256: string;
    usage_event_count: number;
    usage_evidence_sha256: string;
    response_generation_evidence_sha256: string;
    provider_tool_call_evidence_sha256: string | null;
    failure_evidence_sha256: string;
  }>[];
  terminal_sha256: string;
}>;

type RunnerIo = Readonly<{
  stdout(value: string): void;
  stderr(value: string): void;
  now(): Date;
}>;

type RunnerDependencies = Readonly<{
  inspectGitSource(repositoryRoot: string): Promise<Lc4QualificationGitSource>;
  loadCredentials(repositoryRoot: string): Promise<Readonly<Record<LiveStsProvider, string>>>;
  createClient(
    provider: LiveStsProvider,
    configuration: TrialSessionConfiguration,
    apiKey: string,
  ): NormalizedRealtimeClient;
  executeCanary(input: Readonly<{
    provider: LiveStsProvider;
    model: string;
    client: NormalizedRealtimeClient;
    timeoutMs?: number;
    now?: () => Date;
  }>): Promise<ResponseToolCanaryExecution>;
  executeDevAudioCanary(input: Readonly<{
    provider: LiveStsProvider;
    model: string;
    client: NormalizedRealtimeClient;
    sampleRateHz: number;
    profile: typeof DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE;
    timeoutMs?: number;
    now?: () => Date;
  }>): Promise<Lc4DevAudioCanaryExecution>;
}>;

const defaultDependencies: RunnerDependencies = Object.freeze({
  inspectGitSource: inspectLc4QualificationGitSource,
  loadCredentials: loadProductionRealtimeCredentials,
  createClient: createProductionRealtimeClient,
  executeCanary: executeProviderResponseToolCanary,
  executeDevAudioCanary: executeLc4DevAudioCanary,
});

function requireSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function requireCanonicalIso(value: unknown, label: string): number {
  if (typeof value !== "string") throw new Error(`${label} must be a canonical ISO timestamp`);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) throw new Error(`${label} must be a canonical ISO timestamp`);
  return epoch;
}

function requireSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe opaque identifier`);
}

function credentialIdentity(provider: LiveStsProvider, credential: string): Readonly<{
  provider: LiveStsProvider;
  credential_sha256: string;
}> {
  if (credential.length < 12) throw new Error(`missing ${provider} provider credential`);
  return Object.freeze({
    provider,
    credential_sha256: sha256Hex(`${CREDENTIAL_DOMAIN}${credential}`),
  });
}

function credentialSetSha256(credentials: Readonly<Record<LiveStsProvider, string>>): string {
  return sha256Hex(`${CREDENTIAL_SET_DOMAIN}${canonicalJson(LC4_QUALIFICATION_PROVIDER_ORDER.map((provider) => ({
    provider,
    credentialSha256: credentialIdentity(provider, credentials[provider]).credential_sha256,
  })))}`);
}

function targetConfiguration(provider: LiveStsProvider): TrialSessionConfiguration {
  const spec = LIVE_STS_PROVIDER_SPECS[provider];
  const renderedCapabilitySnapshot = "<capability_snapshot>{\"scope\":\"qualification.static_gateway\",\"actions\":[{\"name\":\"flow.get_state\",\"arguments\":{}}]}</capability_snapshot>";
  const instructions = [
    "This session exists only to qualify the exact realtime model and static capability gateway.",
    "Do not speak unless a later response request explicitly instructs you to do so.",
    renderedCapabilitySnapshot,
  ].join("\n");
  const audioDeliveryProfile = DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE;
  return Object.freeze({
    provider,
    model: spec.model,
    conditionId: "host-managed-harness" as const,
    instructions,
    initialPrompt: instructions,
    renderedCapabilitySnapshot,
    providerTools: Object.freeze([LOCAL_TOOL_PROXY_FUNCTION]),
    conditionHash: sha256Hex(`harshas-amazing-call-center/lc4-qualification-condition/v1\n${provider}\n${instructions}`),
    inputAudioFormat: Object.freeze({
      encoding: "pcm16" as const,
      sampleRateHz: spec.sampleRateHz,
      channels: 1 as const,
    }),
    audioDeliveryProfile,
    audioDeliveryProfileHash: trialAudioDeliveryProfileHash(audioDeliveryProfile),
  });
}

function devAudioTargetConfiguration(provider: LiveStsProvider): TrialSessionConfiguration {
  const spec = LIVE_STS_PROVIDER_SPECS[provider];
  const instructions = [
    "You are participating in the public HACC-LC4-DEV municipal oral-history voice-agent mechanism test.",
    "Treat all caller details as fictional benchmark data. Speak naturally and follow only the context available in this turn.",
    "Never claim an external action completed without an authoritative tool receipt. Use capability_gateway for every tool request.",
    "This is development mechanism evidence only, never confirmatory efficacy evidence.",
  ].join(" ");
  const renderedCapabilitySnapshot = "<lc4_dev_gateway scope=\"qualification.exact_schema_audio\" />";
  const audioDeliveryProfile = DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE;
  return Object.freeze({
    provider,
    model: spec.model,
    conditionId: "host-managed-harness" as const,
    instructions,
    initialPrompt: instructions,
    renderedCapabilitySnapshot,
    providerTools: Object.freeze([LC4_DEV_SEMANTIC_GATEWAY_FUNCTION]),
    conditionHash: sha256Hex(`harshas-amazing-call-center/lc4-qualification-dev-audio-condition/v1\n${provider}\n${instructions}`),
    inputAudioFormat: Object.freeze({
      encoding: "pcm16" as const,
      sampleRateHz: spec.sampleRateHz,
      channels: 1 as const,
    }),
    audioDeliveryProfile,
    audioDeliveryProfileHash: trialAudioDeliveryProfileHash(audioDeliveryProfile),
  });
}

export function createLc4QualificationTargets(): readonly ProviderQualificationTarget[] {
  assertLc4ProviderProfileManifest(LC4_PROVIDER_PROFILE_MANIFEST);
  return Object.freeze(LC4_QUALIFICATION_PROVIDER_ORDER.map((provider) => {
    const configuration = targetConfiguration(provider);
    const frozen = LC4_PROVIDER_PROFILE_MANIFEST.providers[provider];
    if (configuration.model !== frozen.model || configuration.inputAudioFormat.sampleRateHz !== frozen.input_sample_rate_hz) {
      throw new Error(`LC4 ${provider} qualification target differs from the frozen provider profile`);
    }
    return Object.freeze({ provider, model: configuration.model, configuration });
  }));
}

export function createLc4DevAudioQualificationTargets(): readonly ProviderQualificationTarget[] {
  assertLc4ProviderProfileManifest(LC4_PROVIDER_PROFILE_MANIFEST);
  return Object.freeze(LC4_QUALIFICATION_PROVIDER_ORDER.map((provider) => {
    const configuration = devAudioTargetConfiguration(provider);
    const frozen = LC4_PROVIDER_PROFILE_MANIFEST.providers[provider];
    if (configuration.model !== frozen.model
      || configuration.inputAudioFormat.sampleRateHz !== frozen.input_sample_rate_hz
      || canonicalJson(configuration.providerTools) !== canonicalJson([LC4_DEV_SEMANTIC_GATEWAY_FUNCTION])) {
      throw new Error(`LC4 ${provider} DEV audio qualification target differs from the frozen execution path`);
    }
    return Object.freeze({ provider, model: configuration.model, configuration });
  }));
}

function planSha256(body: Omit<Lc4QualificationPlan, "plan_sha256">): string {
  return sha256Hex(`${PLAN_DOMAIN}${canonicalJson(body)}`);
}

function qualificationPlanTargets(
  targets: readonly ProviderQualificationTarget[],
  devTargets: readonly ProviderQualificationTarget[],
): Lc4QualificationPlan["targets"] {
  const requirements = providerResponseToolCanaryRequirements(targets);
  return Object.freeze(LC4_QUALIFICATION_PROVIDER_ORDER.map((provider) => {
    const requirement = requirements.find((candidate) => candidate.provider === provider);
    const devTarget = devTargets.find((candidate) => candidate.provider === provider);
    if (!requirement || !devTarget) throw new Error(`LC4 ${provider} qualification requirement is missing`);
    const specification = lc4DevAudioCanarySpecification(provider, devTarget.model, devTarget.configuration.inputAudioFormat.sampleRateHz);
    return Object.freeze({
      provider,
      model: devTarget.model,
      zero_audio_tool_schema_sha256: requirement.toolSchemaSha256,
      dev_audio_tool_schema_sha256: specification.tool_schema_sha256,
      packetizer_sha256: LC4_DEV_AUDIO_CANARY_PACKETIZER_SHA256,
      audio_delivery_profile_sha256: devTarget.configuration.audioDeliveryProfileHash,
      dev_control_bytes: LC4_DEV_AUDIO_CANARY_CONTROL_BYTES,
      dev_control_sha256: specification.control_sha256,
      dev_control_source_sha256: LC4_DEV_AUDIO_CANARY_CONTROL_SOURCE_SHA256,
      caller_audio_bytes: specification.audio_bytes,
      caller_audio_sha256: specification.audio_sha256,
      response_generations: 2 as const,
      maximum_micro_usd: LC4_QUALIFICATION_MAXIMUM_PROVIDER_MICRO_USD,
      paid_retry_allowed: false as const,
    });
  }));
}

export function assertLc4QualificationPlan(value: Lc4QualificationPlan): void {
  const { plan_sha256, ...body } = value;
  if (planSha256(body) !== plan_sha256) throw new Error("LC4 qualification plan hash mismatch");
  if (value.schema_version !== 1 || value.runner_version !== LC4_QUALIFICATION_RUNNER_VERSION || value.protocol_id !== "HACC-LC4-v1") {
    throw new Error("LC4 qualification plan schema is unsupported");
  }
  requireSafeId(value.plan_id, "LC4 qualification plan ID");
  requireCanonicalIso(value.prepared_at, "LC4 qualification plan preparation time");
  if (!SHA1.test(value.source_commit) || !SHA1.test(value.source_tree_oid)) throw new Error("LC4 qualification plan Git identity is invalid");
  requireSha256(value.source_tree_sha256, "LC4 qualification source tree");
  requireSha256(value.provider_profile_manifest_sha256, "LC4 provider profile manifest");
  requireSha256(value.configuration_matrix_sha256, "LC4 qualification matrix");
  requireSha256(value.dev_configuration_matrix_sha256, "LC4 DEV audio qualification matrix");
  requireSha256(value.credential_set_sha256, "LC4 credential set");
  if (
    value.provider_profile_manifest_sha256 !== LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256
    || value.maximum_total_micro_usd !== LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD
    || value.provider_calls_authorized !== false
    || value.authorization_required !== "pinned_ed25519_development_artifact"
    || value.execution_scope !== "development_only_exact_model_handshake_zero_audio_gateway_then_exact_dev_schema_packetized_audio_canary"
  ) throw new Error("LC4 qualification plan weakened a frozen execution boundary");
  const targets = createLc4QualificationTargets();
  const devTargets = createLc4DevAudioQualificationTargets();
  const expectedTargets = qualificationPlanTargets(targets, devTargets);
  if (
    canonicalJson(value.targets) !== canonicalJson(expectedTargets)
    || value.configuration_matrix_sha256 !== providerQualificationMatrixSha256(targets)
    || value.dev_configuration_matrix_sha256 !== providerQualificationMatrixSha256(devTargets)
    || value.targets.reduce((sum, target) => sum + target.caller_audio_bytes, 0) !== LC4_QUALIFICATION_TOTAL_CALLER_AUDIO_BYTES
    || value.credential_identities.length !== 3
    || canonicalJson(value.credential_identities.map((identity) => identity.provider)) !== canonicalJson(LC4_QUALIFICATION_PROVIDER_ORDER)
    || value.credential_identities.some((identity) => !SHA256.test(identity.credential_sha256))
  ) throw new Error("LC4 qualification plan target or credential identity matrix drifted");
}

export async function inspectLc4QualificationGitSource(repositoryRoot: string): Promise<Lc4QualificationGitSource> {
  const root = resolve(repositoryRoot);
  const [{ stdout: status }, { stdout: commit }, { stdout: tree }] = await Promise.all([
    execFileAsync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], { maxBuffer: 8 * 1024 * 1024 }),
    execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { maxBuffer: 1024 }),
    execFileAsync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { maxBuffer: 1024 }),
  ]);
  if (status.trim()) throw new Error("LC4 qualification requires an exactly clean Git worktree");
  const sourceCommit = commit.trim();
  const sourceTreeOid = tree.trim();
  if (!SHA1.test(sourceCommit) || !SHA1.test(sourceTreeOid)) throw new Error("LC4 qualification could not establish an exact Git commit/tree identity");
  return Object.freeze({
    source_commit: sourceCommit,
    source_tree_oid: sourceTreeOid,
    source_tree_sha256: sha256Hex(`${SOURCE_TREE_DOMAIN}${canonicalJson({ source_commit: sourceCommit, source_tree_oid: sourceTreeOid })}`),
    worktree_clean: true as const,
  });
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o400 });
  try {
    await link(temporary, path);
    await chmod(path, 0o400);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function readJson<T>(path: string, label: string): Promise<T> {
  const bytes = await readFile(path);
  if (bytes.byteLength === 0 || bytes.byteLength > 32 * 1024 * 1024) throw new Error(`${label} has an invalid size`);
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function planPath(root: string): string {
  return resolve(root, "lc4-qualification-plan.json");
}

export async function prepareLc4Qualification(input: Readonly<{
  root: string;
  repositoryRoot: string;
  now?: () => Date;
  planId?: string;
  dependencies?: Pick<RunnerDependencies, "inspectGitSource" | "loadCredentials">;
}>): Promise<Lc4QualificationPlan> {
  const root = resolve(input.root);
  const repositoryRoot = resolve(input.repositoryRoot);
  const relativeRoot = relative(repositoryRoot, root);
  if (relativeRoot === "" || (!relativeRoot.startsWith("..") && !resolve(relativeRoot).startsWith(".."))) {
    throw new Error("LC4 qualification evidence root must be outside the source repository");
  }
  const dependencies = input.dependencies ?? defaultDependencies;
  const [source, credentials] = await Promise.all([
    dependencies.inspectGitSource(repositoryRoot),
    dependencies.loadCredentials(repositoryRoot),
  ]);
  const planId = input.planId ?? randomUUID();
  requireSafeId(planId, "LC4 qualification plan ID");
  const targets = createLc4QualificationTargets();
  const devTargets = createLc4DevAudioQualificationTargets();
  const credentialIdentities = Object.freeze(LC4_QUALIFICATION_PROVIDER_ORDER.map((provider) => credentialIdentity(provider, credentials[provider])));
  const body = Object.freeze({
    schema_version: 1 as const,
    runner_version: LC4_QUALIFICATION_RUNNER_VERSION,
    protocol_id: "HACC-LC4-v1" as const,
    plan_id: planId,
    prepared_at: (input.now ?? (() => new Date()))().toISOString(),
    source_commit: source.source_commit,
    source_tree_oid: source.source_tree_oid,
    source_tree_sha256: source.source_tree_sha256,
    provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    configuration_matrix_sha256: providerQualificationMatrixSha256(targets),
    dev_configuration_matrix_sha256: providerQualificationMatrixSha256(devTargets),
    credential_set_sha256: credentialSetSha256(credentials),
    credential_identities: credentialIdentities,
    targets: qualificationPlanTargets(targets, devTargets),
    execution_scope: "development_only_exact_model_handshake_zero_audio_gateway_then_exact_dev_schema_packetized_audio_canary" as const,
    maximum_total_micro_usd: LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD,
    provider_calls_authorized: false as const,
    authorization_required: "pinned_ed25519_development_artifact" as const,
  });
  const plan = Object.freeze({ ...body, plan_sha256: planSha256(body) });
  assertLc4QualificationPlan(plan);
  await writeImmutableJson(planPath(root), plan);
  return plan;
}

export function lc4QualificationAuthorizationSigningBytes(body: Lc4QualificationAuthorizationBody): Uint8Array {
  return Buffer.from(`${AUTHORIZATION_DOMAIN}${canonicalJson(body)}`, "utf8");
}

export function lc4QualificationAuthorizationArtifactSha256(
  artifact: Omit<Lc4QualificationAuthorizationArtifact, "artifact_sha256">,
): string {
  return sha256Hex(`${AUTHORIZATION_ARTIFACT_DOMAIN}${canonicalJson(artifact)}`);
}

export function assertLc4QualificationAuthorization(input: Readonly<{
  artifact: Lc4QualificationAuthorizationArtifact;
  trustRoot: Lc4QualificationTrustRoot;
  plan: Lc4QualificationPlan;
  now: Date;
}>): void {
  const { artifact, trustRoot, plan } = input;
  if (trustRoot.schema_version !== 1) throw new Error("LC4 qualification trust root schema is unsupported");
  requireSha256(trustRoot.authority_public_key_fingerprint_sha256, "LC4 qualification trust root fingerprint");
  const body = artifact.body;
  if (
    body.schema_version !== 1
    || body.authorization_version !== LC4_QUALIFICATION_AUTHORIZATION_VERSION
    || body.protocol_id !== "HACC-LC4-v1"
    || body.purpose !== "lc4_development_exact_model_zero_audio_and_exact_dev_schema_audio_canaries"
  ) throw new Error("LC4 qualification authorization schema, protocol, or purpose is unsupported");
  requireSafeId(body.authorization_id, "LC4 qualification authorization ID");
  for (const [label, digest] of Object.entries({
    authorization_nonce_sha256: body.authorization_nonce_sha256,
    plan_sha256: body.plan_sha256,
    source_tree_sha256: body.source_tree_sha256,
    provider_profile_manifest_sha256: body.provider_profile_manifest_sha256,
    configuration_matrix_sha256: body.configuration_matrix_sha256,
    dev_configuration_matrix_sha256: body.dev_configuration_matrix_sha256,
    credential_set_sha256: body.credential_set_sha256,
  })) requireSha256(digest, label);
  if (!SHA1.test(body.source_commit)) throw new Error("LC4 qualification authorization source commit is invalid");
  if (
    body.plan_sha256 !== plan.plan_sha256
    || body.source_commit !== plan.source_commit
    || body.source_tree_sha256 !== plan.source_tree_sha256
    || body.provider_profile_manifest_sha256 !== plan.provider_profile_manifest_sha256
    || body.configuration_matrix_sha256 !== plan.configuration_matrix_sha256
    || body.dev_configuration_matrix_sha256 !== plan.dev_configuration_matrix_sha256
    || body.credential_set_sha256 !== plan.credential_set_sha256
  ) throw new Error("LC4 qualification authorization differs from the immutable plan");
  const expectedModels = Object.fromEntries(LC4_QUALIFICATION_PROVIDER_ORDER.map((provider) => [provider, LIVE_STS_PROVIDER_SPECS[provider].model]));
  if (
    canonicalJson(body.authorized_providers) !== canonicalJson(LC4_QUALIFICATION_PROVIDER_ORDER)
    || canonicalJson(body.authorized_models) !== canonicalJson(expectedModels)
    || body.maximum_total_micro_usd !== LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD
    || body.caller_audio_bytes !== LC4_QUALIFICATION_TOTAL_CALLER_AUDIO_BYTES
    || body.maximum_response_generations !== LC4_QUALIFICATION_MAXIMUM_RESPONSE_GENERATIONS
    || body.paid_retry_allowed !== false
  ) throw new Error("LC4 qualification authorization weakened the frozen development-only boundary");
  const notBefore = requireCanonicalIso(body.not_before, "LC4 qualification authorization start");
  const expiresAt = requireCanonicalIso(body.expires_at, "LC4 qualification authorization expiry");
  const now = input.now.getTime();
  if (!Number.isFinite(now) || expiresAt <= notBefore || now < notBefore || now >= expiresAt) {
    throw new Error("LC4 qualification authorization is inactive, expired, or has a reversed validity window");
  }
  if (artifact.signature_algorithm !== "Ed25519") throw new Error("LC4 qualification authorization must use Ed25519");
  const keyBytes = Buffer.from(artifact.authority_public_key_spki_base64, "base64");
  const fingerprint = sha256Hex(keyBytes);
  if (
    fingerprint !== artifact.authority_public_key_fingerprint_sha256
    || fingerprint !== trustRoot.authority_public_key_fingerprint_sha256
  ) throw new Error("LC4 qualification authorization is not signed by the pinned trust root");
  const withoutHash = {
    body,
    authority_public_key_spki_base64: artifact.authority_public_key_spki_base64,
    authority_public_key_fingerprint_sha256: artifact.authority_public_key_fingerprint_sha256,
    signature_algorithm: artifact.signature_algorithm,
    signature_base64: artifact.signature_base64,
  } satisfies Omit<Lc4QualificationAuthorizationArtifact, "artifact_sha256">;
  if (artifact.artifact_sha256 !== lc4QualificationAuthorizationArtifactSha256(withoutHash)) {
    throw new Error("LC4 qualification authorization artifact hash mismatch");
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  } catch {
    throw new Error("LC4 qualification authorization public key is invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("LC4 qualification authorization key is not Ed25519");
  if (!verify(null, lc4QualificationAuthorizationSigningBytes(body), publicKey, Buffer.from(artifact.signature_base64, "base64"))) {
    throw new Error("LC4 qualification authorization signature is invalid");
  }
}

function sanitizeUsage(usage: NormalizedRealtimeUsage): SanitizedUsage {
  const { raw, ...meters } = usage;
  return Object.freeze({ ...meters, raw_usage_sha256: sha256Hex(canonicalJson(raw)) });
}

function sanitizeWire(observation: RealtimeWireObservation): SanitizedWireObservation {
  return Object.freeze({
    schema_version: 1 as const,
    provider: observation.provider,
    direction: observation.direction,
    connection_epoch: observation.connectionEpoch,
    sequence: observation.sequence,
    observed_at_ms: observation.observedAtMs,
    observed_at_monotonic_ms: observation.observedAtMonotonicMs,
    wire_type: observation.wireType,
    payload_sha256: observation.payloadSha256,
    payload_bytes: observation.payloadBytes,
    projection_sha256: observation.projectionSha256,
    previous_observation_sha256: observation.previousObservationSha256,
    observation_sha256: observation.observationSha256,
    identities: observation.identities,
    projection: observation.projection,
  });
}

function terminalSha256(body: Omit<Lc4QualificationTerminalArtifact, "terminal_sha256">): string {
  return sha256Hex(`${TERMINAL_DOMAIN}${canonicalJson(body)}`);
}

async function exactSourceAndCredentials(input: Readonly<{
  plan: Lc4QualificationPlan;
  repositoryRoot: string;
  dependencies: Pick<RunnerDependencies, "inspectGitSource" | "loadCredentials">;
}>): Promise<Readonly<Record<LiveStsProvider, string>>> {
  const [source, credentials] = await Promise.all([
    input.dependencies.inspectGitSource(input.repositoryRoot),
    input.dependencies.loadCredentials(input.repositoryRoot),
  ]);
  if (
    source.source_commit !== input.plan.source_commit
    || source.source_tree_oid !== input.plan.source_tree_oid
    || source.source_tree_sha256 !== input.plan.source_tree_sha256
    || credentialSetSha256(credentials) !== input.plan.credential_set_sha256
  ) throw new Error("LC4 qualification source tree or credential identities differ from the immutable plan");
  return credentials;
}

async function retainCanaryEvidence(
  partial: string,
  execution: Pick<ResponseToolCanaryExecution | Lc4DevAudioCanaryExecution, "provider" | "wireObservations" | "usage">,
  suffix = "",
): Promise<Readonly<{
  wire_observation_count: number;
  wire_evidence_sha256: string;
  usage_event_count: number;
  usage_evidence_sha256: string;
}>> {
  const wire = execution.wireObservations.map(sanitizeWire);
  const usage = execution.usage.map(sanitizeUsage);
  const wireEncoded = wire.map((item) => canonicalJson(item)).join("\n");
  const usageEncoded = usage.map((item) => canonicalJson(item)).join("\n");
  await Promise.all([
    writeFile(resolve(partial, `${execution.provider}${suffix}-wire.jsonl`), wireEncoded ? `${wireEncoded}\n` : "", { flag: "wx", mode: 0o400 }),
    writeFile(resolve(partial, `${execution.provider}${suffix}-usage.jsonl`), usageEncoded ? `${usageEncoded}\n` : "", { flag: "wx", mode: 0o400 }),
  ]);
  return Object.freeze({
    wire_observation_count: wire.length,
    wire_evidence_sha256: sha256Hex(wireEncoded),
    usage_event_count: usage.length,
    usage_evidence_sha256: sha256Hex(usageEncoded),
  });
}

async function retainDevAudioCanaryArtifact(input: Readonly<{
  partial: string;
  attemptId: string;
  plan: Lc4QualificationPlan;
  results: Lc4QualificationTerminalArtifact["dev_audio_results"];
}>): Promise<string> {
  const body = Object.freeze({
    schema_version: 1 as const,
    canary_version: "HACC-LC4-DEV-AUDIO-CANARY-v1" as const,
    attempt_id: input.attemptId,
    plan_sha256: input.plan.plan_sha256,
    source_commit: input.plan.source_commit,
    source_tree_sha256: input.plan.source_tree_sha256,
    dev_configuration_matrix_sha256: input.plan.dev_configuration_matrix_sha256,
    packetizer_sha256: LC4_DEV_AUDIO_CANARY_PACKETIZER_SHA256,
    status: input.results.every((result) => result.status === "passed") ? "passed" as const : "failed" as const,
    results: input.results,
  });
  const artifactSha256 = sha256Hex(`${DEV_AUDIO_CANARY_DOMAIN}${canonicalJson(body)}`);
  await writeImmutableJson(resolve(input.partial, "dev-audio-canary.json"), Object.freeze({ ...body, artifact_sha256: artifactSha256 }));
  return artifactSha256;
}

async function retainDevAudioFailureEvidence(
  partial: string,
  execution: Lc4DevAudioCanaryExecution,
): Promise<void> {
  if (lc4DevAudioCanaryFailureEvidenceSha256(execution.sanitizedFailureEvidence) !== execution.failureEvidenceSha256) {
    throw new Error(`LC4 ${execution.provider} DEV audio failure evidence hash mismatch`);
  }
  await writeImmutableJson(
    resolve(partial, `${execution.provider}-dev-audio-outcome.json`),
    Object.freeze({
      ...execution.sanitizedFailureEvidence,
      failure_evidence_sha256: execution.failureEvidenceSha256,
    }),
  );
}

async function retainDevAudioToolCallEvidence(
  partial: string,
  execution: Lc4DevAudioCanaryExecution,
): Promise<void> {
  assertLc4DevAudioCanaryExecutionEvidence(execution);
  if (execution.providerToolCallEvidence === null) return;
  if (lc4DevAudioCanaryProviderToolCallEvidenceSha256(execution.providerToolCallEvidence)
    !== execution.providerToolCallEvidenceSha256) {
    throw new Error(`LC4 ${execution.provider} DEV audio tool-call evidence hash mismatch`);
  }
  await writeImmutableJson(
    resolve(partial, `${execution.provider}-dev-audio-tool-call.json`),
    Object.freeze({
      ...execution.providerToolCallEvidence,
      evidence_sha256: execution.providerToolCallEvidenceSha256,
    }),
  );
}

export async function runLc4Qualification(input: Readonly<{
  root: string;
  repositoryRoot: string;
  authorization: Lc4QualificationAuthorizationArtifact;
  trustRoot: Lc4QualificationTrustRoot;
  now?: () => Date;
  attemptId?: string;
  dependencies?: RunnerDependencies;
}>): Promise<Lc4QualificationTerminalArtifact> {
  const root = resolve(input.root);
  const repositoryRoot = resolve(input.repositoryRoot);
  const plan = await readJson<Lc4QualificationPlan>(planPath(root), "LC4 qualification plan");
  assertLc4QualificationPlan(plan);
  const dependencies = input.dependencies ?? defaultDependencies;
  const now = input.now ?? (() => new Date());
  assertLc4QualificationAuthorization({ artifact: input.authorization, trustRoot: input.trustRoot, plan, now: now() });
  const attemptId = input.attemptId ?? input.authorization.body.authorization_id;
  requireSafeId(attemptId, "LC4 qualification attempt ID");
  if (attemptId !== input.authorization.body.authorization_id) {
    throw new Error("LC4 qualification attempt ID must equal the signed one-shot authorization ID");
  }
  const credentials = await exactSourceAndCredentials({ plan, repositoryRoot, dependencies });
  const providersModels = Object.freeze(Object.fromEntries(plan.targets.map((target) => [
    target.provider,
    target.model,
  ])) as Record<LiveStsProvider, string>);
  const budgetBinding: Lc4QualificationBudgetBinding = Object.freeze({
    attemptId,
    authorizationId: input.authorization.body.authorization_id,
    authorizationArtifactSha256: input.authorization.artifact_sha256,
    planSha256: plan.plan_sha256,
    sourceCommit: plan.source_commit,
    sourceTreeSha256: plan.source_tree_sha256,
    credentialSetSha256: plan.credential_set_sha256,
    providerProfileManifestSha256: plan.provider_profile_manifest_sha256,
    configurationMatrixSha256: plan.configuration_matrix_sha256,
    devConfigurationMatrixSha256: plan.dev_configuration_matrix_sha256,
    providersModels,
    expiresAt: input.authorization.body.expires_at,
  });
  // The aggregate $3 authority is durably consumed, opened, and bound to the
  // exact signed attempt before any provider client can be constructed.
  const budgetReservation = await reserveLc4QualificationBudget({ root, binding: budgetBinding, now });
  const budgetUsage: Array<Readonly<{
    provider: LiveStsProvider;
    phase: "zero_audio" | "dev_audio";
    count: number;
    evidence_sha256: string;
  }>> = [];
  let budgetOutcome: "completed" | "failed" = "failed";
  try {
  const attemptsRoot = resolve(root, "attempts");
  const partial = resolve(attemptsRoot, `${attemptId}.partial`);
  const complete = resolve(attemptsRoot, `${attemptId}.complete`);
  await mkdir(attemptsRoot, { recursive: true, mode: 0o700 });
  // This no-retry tombstone is acquired before any provider client is
  // constructed. It remains after success, failure, or process interruption.
  await writeFile(resolve(attemptsRoot, `${attemptId}.consumed`), `${canonicalJson({
    schema_version: 1,
    attempt_id: attemptId,
    plan_sha256: plan.plan_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    paid_retry_allowed: false,
  })}\n`, { flag: "wx", mode: 0o400 });
  await mkdir(partial, { recursive: false, mode: 0o700 });
  const attemptedAt = now().toISOString();
  await writeImmutableJson(resolve(partial, "intent.json"), Object.freeze({
    schema_version: 1,
    attempt_id: attemptId,
    plan_sha256: plan.plan_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    attempted_at: attemptedAt,
    provider_order: LC4_QUALIFICATION_PROVIDER_ORDER,
    caller_audio_bytes: LC4_QUALIFICATION_TOTAL_CALLER_AUDIO_BYTES,
    maximum_total_micro_usd: LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD,
    maximum_response_generations: LC4_QUALIFICATION_MAXIMUM_RESPONSE_GENERATIONS,
    paid_retry_allowed: false,
    intent_sha256: sha256Hex(canonicalJson({ attemptId, plan: plan.plan_sha256, authorization: input.authorization.artifact_sha256 })),
  }));
  const targets = createLc4QualificationTargets();
  const devTargets = createLc4DevAudioQualificationTargets();
  let qualification: ProviderQualificationArtifact;
  try {
    qualification = await qualifyProviders({
      root,
      protocolId: plan.protocol_id,
      planSha256: plan.plan_sha256,
      sourceCommit: plan.source_commit,
      targets,
      credentials,
      createClient: (target, apiKey) => dependencies.createClient(target.provider, target.configuration, apiKey),
      now,
      qualificationId: attemptId,
    });
  } catch {
    throw new Error("LC4 provider handshake qualification failed before a complete sanitized artifact could be retained");
  }
  assertProviderQualificationArtifactIntegrity(qualification);
  if (qualification.status === "failed") {
    const body = Object.freeze({
      schema_version: 1 as const,
      runner_version: LC4_QUALIFICATION_RUNNER_VERSION,
      attempt_id: attemptId,
      plan_sha256: plan.plan_sha256,
      authorization_artifact_sha256: input.authorization.artifact_sha256,
      source_commit: plan.source_commit,
      source_tree_sha256: plan.source_tree_sha256,
      attempted_at: attemptedAt,
      completed_at: now().toISOString(),
      status: "failed" as const,
      qualification_artifact_sha256: qualification.artifactSha256,
      response_tool_canary_artifact_sha256: null,
      dev_audio_canary_artifact_sha256: null,
      caller_audio_bytes: 0,
      response_generations_attempted: 0,
      paid_retries_attempted: 0 as const,
      maximum_total_micro_usd: LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD,
      results: Object.freeze([]),
      dev_audio_results: Object.freeze([]),
    });
    const terminal = Object.freeze({ ...body, terminal_sha256: terminalSha256(body) });
    await writeImmutableJson(resolve(partial, "terminal.json"), terminal);
    await rename(partial, complete);
    budgetOutcome = "failed";
    return terminal;
  }
  const requirements = providerResponseToolCanaryRequirements(targets);
  const canaryResults: ProviderResponseToolCanaryResult[] = [];
  const retainedResults: Lc4QualificationTerminalArtifact["results"][number][] = [];
  for (const provider of LC4_QUALIFICATION_PROVIDER_ORDER) {
    const target = targets.find((candidate) => candidate.provider === provider);
    const requirement = requirements.find((candidate) => candidate.provider === provider);
    if (!target || !requirement) throw new Error(`LC4 ${provider} canary target is missing`);
    let execution: ResponseToolCanaryExecution;
    try {
      execution = await dependencies.executeCanary({
        provider,
        model: target.model,
        client: dependencies.createClient(provider, target.configuration, credentials[provider]),
        timeoutMs: 20_000,
        now,
      });
    } catch {
      execution = Object.freeze({
        provider,
        model: target.model,
        attemptedAt: now().toISOString(),
        completedAt: now().toISOString(),
        status: "failed" as const,
        code: "response_generation_failed" as const,
        callerAudioBytes: 0 as const,
        responseGenerationEvidenceSha256: sha256Hex(`harshas-amazing-call-center/lc4-qualification-provider-failure/v1\n${provider}`),
        providerToolCallEvidenceSha256: null,
        wireObservations: Object.freeze([]),
        usage: Object.freeze([]),
      });
    }
    if (execution.provider !== provider || execution.model !== target.model || execution.callerAudioBytes !== 0) {
      throw new Error(`LC4 ${provider} canary execution identity or zero-audio contract failed`);
    }
    const retained = await retainCanaryEvidence(partial, execution);
    budgetUsage.push(Object.freeze({
      provider,
      phase: "zero_audio",
      count: retained.usage_event_count,
      evidence_sha256: retained.usage_evidence_sha256,
    }));
    canaryResults.push(Object.freeze({
      provider,
      model: target.model,
      toolSchemaSha256: requirement.toolSchemaSha256,
      attemptedAt: execution.attemptedAt,
      completedAt: execution.completedAt,
      status: execution.status,
      code: execution.code,
      callerAudioBytes: 0 as const,
      responseGenerationEvidenceSha256: execution.responseGenerationEvidenceSha256,
      providerToolCallEvidenceSha256: execution.providerToolCallEvidenceSha256,
    }));
    retainedResults.push(Object.freeze({
      provider,
      model: target.model,
      status: execution.status,
      code: execution.code,
      ...retained,
      provider_tool_call_evidence_sha256: execution.providerToolCallEvidenceSha256,
    }));
  }
  const responseCanary = await recordProviderResponseToolCanary({
    root,
    protocolId: plan.protocol_id,
    planSha256: plan.plan_sha256,
    sourceCommit: plan.source_commit,
    targets,
    credentials,
    results: canaryResults,
    attemptedAt: canaryResults.map((result) => result.attemptedAt).sort()[0]!,
    completedAt: canaryResults.map((result) => result.completedAt).sort().at(-1)!,
    canaryId: attemptId,
  });
  assertProviderResponseToolCanaryArtifactIntegrity(responseCanary, targets);
  const retainedDevResults: Lc4QualificationTerminalArtifact["dev_audio_results"][number][] = [];
  for (const provider of LC4_QUALIFICATION_PROVIDER_ORDER) {
    const target = devTargets.find((candidate) => candidate.provider === provider);
    const planned = plan.targets.find((candidate) => candidate.provider === provider);
    if (!target || !planned) throw new Error(`LC4 ${provider} DEV audio canary target is missing`);
    let execution: Lc4DevAudioCanaryExecution;
    try {
      execution = await dependencies.executeDevAudioCanary({
        provider,
        model: target.model,
        client: dependencies.createClient(provider, target.configuration, credentials[provider]),
        sampleRateHz: target.configuration.inputAudioFormat.sampleRateHz,
        profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
        timeoutMs: 30_000,
        now,
      });
    } catch {
      const specification = lc4DevAudioCanarySpecification(provider, target.model, target.configuration.inputAudioFormat.sampleRateHz);
      const sanitizedFailureEvidence: Lc4DevAudioCanaryFailureEvidence = Object.freeze({
        schema_version: 1 as const,
        provider,
        model: target.model,
        status: "failed" as const,
        code: "response_generation_failed" as const,
        failure_class: "response_generation_failed" as const,
        primary: true as const,
        operation_order: Object.freeze([]),
        input_audio: Object.freeze({
          bytes: 0,
          chunks: 0,
          sha256: specification.audio_sha256,
          complete: false,
        }),
        response: Object.freeze({ requested: false, gateway_call_observed: false }),
        wire: Object.freeze({ count: 0, terminal_type: null, terminal_observation_sha256: null }),
      });
      execution = Object.freeze({
        provider,
        model: target.model,
        attemptedAt: now().toISOString(),
        completedAt: now().toISOString(),
        status: "failed" as const,
        code: "response_generation_failed" as const,
        specification,
        delivery: null,
        callerAudioBytes: 0,
        responseGenerationRequested: false,
        responseGenerationEvidenceSha256: sha256Hex(`harshas-amazing-call-center/lc4-dev-audio-provider-failure/v1\n${provider}`),
        providerToolCallEvidence: null,
        providerToolCallEvidenceSha256: null,
        sanitizedFailureEvidence,
        failureEvidenceSha256: lc4DevAudioCanaryFailureEvidenceSha256(sanitizedFailureEvidence),
        wireObservations: Object.freeze([]),
        usage: Object.freeze([]),
      });
    }
    if (execution.provider !== provider
      || execution.model !== target.model
      || canonicalJson(execution.specification) !== canonicalJson(lc4DevAudioCanarySpecification(provider, target.model, target.configuration.inputAudioFormat.sampleRateHz))
      || execution.specification.tool_schema_sha256 !== planned.dev_audio_tool_schema_sha256
      || execution.specification.audio_sha256 !== planned.caller_audio_sha256
      || execution.specification.audio_bytes !== planned.caller_audio_bytes
      || execution.specification.control_bytes !== planned.dev_control_bytes
      || execution.specification.control_sha256 !== planned.dev_control_sha256
      || execution.specification.control_source_sha256 !== planned.dev_control_source_sha256
      || (execution.delivery !== null && (
        execution.delivery.packetizer_sha256 !== planned.packetizer_sha256
        || execution.delivery.delivery_profile_sha256 !== planned.audio_delivery_profile_sha256
      ))
      || (execution.status === "passed" && (
        execution.delivery === null
        || execution.callerAudioBytes !== planned.caller_audio_bytes
        || !execution.responseGenerationRequested
        || execution.providerToolCallEvidence === null
        || execution.providerToolCallEvidenceSha256 === null
      ))) {
      throw new Error(`LC4 ${provider} DEV audio canary execution differs from the immutable plan`);
    }
    assertLc4DevAudioCanaryExecutionEvidence(execution);
    await retainDevAudioFailureEvidence(partial, execution);
    await retainDevAudioToolCallEvidence(partial, execution);
    const retained = await retainCanaryEvidence(partial, execution, "-dev-audio");
    budgetUsage.push(Object.freeze({
      provider,
      phase: "dev_audio",
      count: retained.usage_event_count,
      evidence_sha256: retained.usage_evidence_sha256,
    }));
    retainedDevResults.push(Object.freeze({
      provider,
      model: target.model,
      status: execution.status,
      code: execution.code,
      caller_audio_bytes: execution.callerAudioBytes,
      response_generation_requested: execution.responseGenerationRequested,
      tool_schema_sha256: execution.specification.tool_schema_sha256,
      packetizer_sha256: planned.packetizer_sha256,
      audio_delivery_profile_sha256: planned.audio_delivery_profile_sha256,
      control_bytes: execution.specification.control_bytes,
      control_sha256: execution.specification.control_sha256,
      audio_sha256: execution.specification.audio_sha256,
      delivery_complete: execution.delivery !== null,
      chunk_count: execution.delivery?.chunk_count ?? 0,
      ...retained,
      response_generation_evidence_sha256: execution.responseGenerationEvidenceSha256,
      provider_tool_call_evidence_sha256: execution.providerToolCallEvidenceSha256,
      failure_evidence_sha256: execution.failureEvidenceSha256,
    }));
  }
  const devAudioCanaryArtifactSha256 = await retainDevAudioCanaryArtifact({
    partial,
    attemptId,
    plan,
    results: Object.freeze(retainedDevResults),
  });
  const devAudioStatus = retainedDevResults.every((result) => result.status === "passed");
  const body = Object.freeze({
    schema_version: 1 as const,
    runner_version: LC4_QUALIFICATION_RUNNER_VERSION,
    attempt_id: attemptId,
    plan_sha256: plan.plan_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    source_commit: plan.source_commit,
    source_tree_sha256: plan.source_tree_sha256,
    attempted_at: attemptedAt,
    completed_at: now().toISOString(),
    status: responseCanary.status === "passed" && devAudioStatus ? "passed" as const : "failed" as const,
    qualification_artifact_sha256: qualification.artifactSha256,
    response_tool_canary_artifact_sha256: responseCanary.artifactSha256,
    dev_audio_canary_artifact_sha256: devAudioCanaryArtifactSha256,
    caller_audio_bytes: retainedDevResults.reduce((sum, result) => sum + result.caller_audio_bytes, 0),
    response_generations_attempted: canaryResults.length + retainedDevResults.filter((result) => result.response_generation_requested).length,
    paid_retries_attempted: 0 as const,
    maximum_total_micro_usd: LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD,
    results: Object.freeze(retainedResults),
    dev_audio_results: Object.freeze(retainedDevResults),
  });
  const terminal = Object.freeze({ ...body, terminal_sha256: terminalSha256(body) });
  await writeImmutableJson(resolve(partial, "terminal.json"), terminal);
  await rename(partial, complete);
  budgetOutcome = terminal.status === "passed" ? "completed" : "failed";
  return terminal;
  } finally {
    const usageEvidenceSha256 = sha256Hex(canonicalJson(Object.freeze([...budgetUsage])));
    const budgetEvidence = await finalizeLc4QualificationBudget({
      reservation: budgetReservation,
      attemptId,
      usageEventCount: budgetUsage.reduce((sum, item) => sum + item.count, 0),
      usageEvidenceSha256,
      outcome: budgetOutcome,
      now,
    });
    await writeImmutableJson(resolve(root, "budget", `${attemptId}.settlement.json`), budgetEvidence);
  }
}

function parseFlags(args: readonly string[]): Readonly<Record<string, string>> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) throw new Error("LC4 qualification CLI requires --flag value pairs");
    if (flags[flag] !== undefined) throw new Error(`LC4 qualification CLI flag is duplicated: ${flag}`);
    flags[flag] = value;
  }
  return Object.freeze(flags);
}

function exactFlags(flags: Readonly<Record<string, string>>, expected: readonly string[]): void {
  if (canonicalJson(Object.keys(flags).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`LC4 qualification CLI requires exactly: ${[...expected].sort().join(", ")}`);
  }
}

export async function reportLc4Qualification(root: string): Promise<Readonly<Record<string, unknown>>> {
  const plan = await readJson<Lc4QualificationPlan>(planPath(resolve(root)), "LC4 qualification plan");
  assertLc4QualificationPlan(plan);
  const attemptsRoot = resolve(root, "attempts");
  const names = await readdir(attemptsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const complete = names.filter((name) => name.endsWith(".complete")).sort();
  const partial = names.filter((name) => name.endsWith(".partial")).sort();
  const terminals: Lc4QualificationTerminalArtifact[] = [];
  const budgetSettlements: Lc4QualificationBudgetEvidence[] = [];
  for (const name of complete) {
    const terminal = await readJson<Lc4QualificationTerminalArtifact>(resolve(attemptsRoot, name, "terminal.json"), "LC4 qualification terminal");
    const { terminal_sha256, ...body } = terminal;
    if (terminalSha256(body) !== terminal_sha256 || terminal.plan_sha256 !== plan.plan_sha256) {
      throw new Error(`LC4 qualification terminal ${name} failed integrity`);
    }
    terminals.push(terminal);
    const budgetEvidence = await readJson<Lc4QualificationBudgetEvidence>(
      resolve(root, "budget", `${terminal.attempt_id}.settlement.json`),
      "LC4 qualification budget settlement",
    );
    assertLc4QualificationBudgetEvidence(budgetEvidence);
    const budgetLedgerPath = lc4QualificationBudgetLedgerPath(root);
    const [budget, containsSettlementHead] = await Promise.all([
      inspectFilesystemBudgetLedger({ ledgerPath: budgetLedgerPath }),
      filesystemBudgetLedgerContainsHead({
        ledgerPath: budgetLedgerPath,
        ancestorHeadSha256: budgetEvidence.final_head_sha256,
      }),
    ]);
    const reservation = budget.reservations.find((candidate) => candidate.reservation_id === budgetEvidence.reservation_id);
    const expectedOutcome = terminal.status === "passed" ? "completed" : "failed";
    if (!reservation
      || reservation.status !== "settled"
      || reservation.terminal_outcome !== expectedOutcome
      || budgetEvidence.terminal_outcome !== expectedOutcome
      || reservation.estimated_micro_usd !== LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD
      || reservation.usage_event_count !== budgetEvidence.usage_event_count
      || reservation.usage_evidence_sha256 !== budgetEvidence.usage_evidence_sha256
      || !containsSettlementHead) {
      throw new Error(`LC4 qualification budget settlement ${name} failed integrity`);
    }
    budgetSettlements.push(budgetEvidence);
  }
  return Object.freeze({
    schema_version: 1,
    protocol_id: plan.protocol_id,
    runner_version: LC4_QUALIFICATION_RUNNER_VERSION,
    plan_sha256: plan.plan_sha256,
    source_commit: plan.source_commit,
    source_tree_sha256: plan.source_tree_sha256,
    provider_models: Object.fromEntries(plan.targets.map((target) => [target.provider, target.model])),
    maximum_total_usd: plan.maximum_total_micro_usd / 1_000_000,
    caller_audio_bytes: LC4_QUALIFICATION_TOTAL_CALLER_AUDIO_BYTES,
    maximum_response_generations: LC4_QUALIFICATION_MAXIMUM_RESPONSE_GENERATIONS,
    completed_attempts: terminals.length,
    incomplete_attempts: partial.length,
    paid_retry_allowed: false,
    budget_settlement_evidence_sha256: Object.freeze(budgetSettlements.map((entry) => entry.evidence_sha256)),
    latest: terminals.at(-1) ?? null,
  });
}

export async function runLc4QualificationCli(
  args: readonly string[],
  io: RunnerIo = {
    stdout: (value) => process.stdout.write(`${value}\n`),
    stderr: (value) => process.stderr.write(`${value}\n`),
    now: () => new Date(),
  },
  dependencies: RunnerDependencies = defaultDependencies,
): Promise<number> {
  try {
    const command = args[0];
    if (command === "status") {
      const flags = parseFlags(args.slice(1));
      if (Object.keys(flags).length !== 0 && canonicalJson(Object.keys(flags)) !== canonicalJson(["--root"])) {
        throw new Error("LC4 qualification status accepts only optional --root DIR");
      }
      let preparedPlanSha256: string | null = null;
      if (flags["--root"]) {
        const plan = await readJson<Lc4QualificationPlan>(planPath(flags["--root"]), "LC4 qualification plan");
        assertLc4QualificationPlan(plan);
        preparedPlanSha256 = plan.plan_sha256;
      }
      io.stdout(canonicalJson({
        protocol_id: "HACC-LC4-v1",
        runner_version: LC4_QUALIFICATION_RUNNER_VERSION,
        execution_authorized_by_source: false,
        execution_requires: "valid_plan_bound_pinned_ed25519_development_authorization",
        environment_override_authorizes_execution: false,
        caller_audio_bytes: LC4_QUALIFICATION_TOTAL_CALLER_AUDIO_BYTES,
        maximum_response_generations: LC4_QUALIFICATION_MAXIMUM_RESPONSE_GENERATIONS,
        paid_retry_allowed: false,
        maximum_total_usd: 3,
        prepared_plan_sha256: preparedPlanSha256,
      }));
      return 0;
    }
    if (command === "prepare") {
      const flags = parseFlags(args.slice(1));
      exactFlags(flags, ["--root", "--repository-root"]);
      const plan = await prepareLc4Qualification({
        root: flags["--root"],
        repositoryRoot: flags["--repository-root"],
        now: io.now,
        dependencies,
      });
      io.stdout(canonicalJson({ action: "lc4-qualification-prepared", plan_sha256: plan.plan_sha256, provider_calls_made: 0 }));
      return 0;
    }
    if (command === "report") {
      const flags = parseFlags(args.slice(1));
      exactFlags(flags, ["--root"]);
      io.stdout(canonicalJson(await reportLc4Qualification(flags["--root"])));
      return 0;
    }
    if (command === "run") {
      const flags = parseFlags(args.slice(1));
      exactFlags(flags, ["--root", "--repository-root", "--authorization", "--trust-root", "--env-file"]);
      process.env.BENCHMARK_PROVIDER_ENV_FILE = resolve(flags["--env-file"]);
      const [authorization, trustRoot] = await Promise.all([
        readJson<Lc4QualificationAuthorizationArtifact>(resolve(flags["--authorization"]), "LC4 qualification authorization"),
        readJson<Lc4QualificationTrustRoot>(resolve(flags["--trust-root"]), "LC4 qualification trust root"),
      ]);
      const terminal = await runLc4Qualification({
        root: flags["--root"],
        repositoryRoot: flags["--repository-root"],
        authorization,
        trustRoot,
        now: io.now,
        dependencies,
      });
      io.stdout(canonicalJson({
        action: "lc4-qualification-retained",
        status: terminal.status,
        terminal_sha256: terminal.terminal_sha256,
        caller_audio_bytes: terminal.caller_audio_bytes,
        response_generations_attempted: terminal.response_generations_attempted,
        maximum_total_usd: terminal.maximum_total_micro_usd / 1_000_000,
      }));
      return terminal.status === "passed" ? 0 : 1;
    }
    throw new Error("usage: lc4-qualification <prepare|status|run|report>");
  } catch (error) {
    // Provider credentials and response payloads are deliberately never included in CLI errors.
    const message = error instanceof Error ? error.message : "LC4 qualification command failed";
    io.stderr(/api.?key|credential|bearer|token/i.test(message)
      ? "LC4 qualification command failed at a credential boundary; no secret was retained"
      : message);
    return 1;
  }
}

/** Test-only cleanup helper for partial attempts created before a provider socket opens. */
export async function removeLc4QualificationTestRoot(root: string): Promise<void> {
  if (!resolve(root).includes("hacc-lc4-qualification-test-")) throw new Error("refusing to remove a non-test LC4 qualification root");
  await rm(root, { recursive: true, force: true });
}

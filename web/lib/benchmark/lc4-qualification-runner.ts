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
import {
  LOCAL_TOOL_PROXY_FUNCTION,
  type NormalizedRealtimeClient,
  type NormalizedRealtimeUsage,
  type RealtimeWireObservation,
} from "../realtime/client/types";

export const LC4_QUALIFICATION_RUNNER_VERSION = "HACC-LC4-QUALIFICATION-RUNNER-v1" as const;
export const LC4_QUALIFICATION_AUTHORIZATION_VERSION = "HACC-LC4-QUALIFICATION-DEVELOPMENT-AUTHORIZATION-v1" as const;
export const LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD = 3_000_000 as const;
export const LC4_QUALIFICATION_MAXIMUM_PROVIDER_MICRO_USD = 1_000_000 as const;
export const LC4_QUALIFICATION_PROVIDER_ORDER = Object.freeze(["openai", "gemini", "xai"] as const);

const PLAN_DOMAIN = "harshas-amazing-call-center/lc4-qualification-plan/v1\n";
const AUTHORIZATION_DOMAIN = "harshas-amazing-call-center/lc4-qualification-development-authorization/v1\n";
const AUTHORIZATION_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-development-authorization-artifact/v1\n";
const TERMINAL_DOMAIN = "harshas-amazing-call-center/lc4-qualification-terminal/v1\n";
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
  credential_set_sha256: string;
  credential_identities: readonly Readonly<{
    provider: LiveStsProvider;
    credential_sha256: string;
  }>[];
  targets: readonly Readonly<{
    provider: LiveStsProvider;
    model: string;
    tool_schema_sha256: string;
    caller_audio_bytes: 0;
    maximum_micro_usd: typeof LC4_QUALIFICATION_MAXIMUM_PROVIDER_MICRO_USD;
    paid_retry_allowed: false;
  }>[];
  execution_scope: "development_only_exact_model_handshake_then_zero_audio_static_gateway_canary";
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
  purpose: "lc4_development_exact_model_qualification_and_static_gateway_canary";
  plan_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  provider_profile_manifest_sha256: string;
  configuration_matrix_sha256: string;
  credential_set_sha256: string;
  authorized_providers: readonly ["openai", "gemini", "xai"];
  authorized_models: Readonly<Record<LiveStsProvider, string>>;
  maximum_total_micro_usd: typeof LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD;
  zero_caller_audio: true;
  maximum_response_generations: 3;
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
  wire_type: string;
  payload_sha256: string;
  payload_bytes: number;
  projection_sha256: string;
  previous_observation_sha256: string | null;
  observation_sha256: string;
  identities: RealtimeWireObservation["identities"];
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
  caller_audio_bytes: 0;
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
}>;

const defaultDependencies: RunnerDependencies = Object.freeze({
  inspectGitSource: inspectLc4QualificationGitSource,
  loadCredentials: loadProductionRealtimeCredentials,
  createClient: createProductionRealtimeClient,
  executeCanary: executeProviderResponseToolCanary,
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

function planSha256(body: Omit<Lc4QualificationPlan, "plan_sha256">): string {
  return sha256Hex(`${PLAN_DOMAIN}${canonicalJson(body)}`);
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
  requireSha256(value.credential_set_sha256, "LC4 credential set");
  if (
    value.provider_profile_manifest_sha256 !== LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256
    || value.maximum_total_micro_usd !== LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD
    || value.provider_calls_authorized !== false
    || value.authorization_required !== "pinned_ed25519_development_artifact"
    || value.execution_scope !== "development_only_exact_model_handshake_then_zero_audio_static_gateway_canary"
  ) throw new Error("LC4 qualification plan weakened a frozen execution boundary");
  const targets = createLc4QualificationTargets();
  const requirements = providerResponseToolCanaryRequirements(targets);
  const expectedTargets = LC4_QUALIFICATION_PROVIDER_ORDER.map((provider) => {
    const requirement = requirements.find((candidate) => candidate.provider === provider);
    if (!requirement) throw new Error(`LC4 ${provider} qualification tool requirement is missing`);
    return {
      provider,
      model: LIVE_STS_PROVIDER_SPECS[provider].model,
      tool_schema_sha256: requirement.toolSchemaSha256,
      caller_audio_bytes: 0,
      maximum_micro_usd: LC4_QUALIFICATION_MAXIMUM_PROVIDER_MICRO_USD,
      paid_retry_allowed: false,
    };
  });
  if (
    canonicalJson(value.targets) !== canonicalJson(expectedTargets)
    || value.configuration_matrix_sha256 !== providerQualificationMatrixSha256(targets)
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
  const requirements = providerResponseToolCanaryRequirements(targets);
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
    credential_set_sha256: credentialSetSha256(credentials),
    credential_identities: credentialIdentities,
    targets: Object.freeze(LC4_QUALIFICATION_PROVIDER_ORDER.map((provider) => {
      const requirement = requirements.find((candidate) => candidate.provider === provider);
      if (!requirement) throw new Error(`LC4 ${provider} response-tool canary requirement is missing`);
      return Object.freeze({
        provider,
        model: LIVE_STS_PROVIDER_SPECS[provider].model,
        tool_schema_sha256: requirement.toolSchemaSha256,
        caller_audio_bytes: 0 as const,
        maximum_micro_usd: LC4_QUALIFICATION_MAXIMUM_PROVIDER_MICRO_USD,
        paid_retry_allowed: false as const,
      });
    })),
    execution_scope: "development_only_exact_model_handshake_then_zero_audio_static_gateway_canary" as const,
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
    || body.purpose !== "lc4_development_exact_model_qualification_and_static_gateway_canary"
  ) throw new Error("LC4 qualification authorization schema, protocol, or purpose is unsupported");
  requireSafeId(body.authorization_id, "LC4 qualification authorization ID");
  for (const [label, digest] of Object.entries({
    authorization_nonce_sha256: body.authorization_nonce_sha256,
    plan_sha256: body.plan_sha256,
    source_tree_sha256: body.source_tree_sha256,
    provider_profile_manifest_sha256: body.provider_profile_manifest_sha256,
    configuration_matrix_sha256: body.configuration_matrix_sha256,
    credential_set_sha256: body.credential_set_sha256,
  })) requireSha256(digest, label);
  if (!SHA1.test(body.source_commit)) throw new Error("LC4 qualification authorization source commit is invalid");
  if (
    body.plan_sha256 !== plan.plan_sha256
    || body.source_commit !== plan.source_commit
    || body.source_tree_sha256 !== plan.source_tree_sha256
    || body.provider_profile_manifest_sha256 !== plan.provider_profile_manifest_sha256
    || body.configuration_matrix_sha256 !== plan.configuration_matrix_sha256
    || body.credential_set_sha256 !== plan.credential_set_sha256
  ) throw new Error("LC4 qualification authorization differs from the immutable plan");
  const expectedModels = Object.fromEntries(LC4_QUALIFICATION_PROVIDER_ORDER.map((provider) => [provider, LIVE_STS_PROVIDER_SPECS[provider].model]));
  if (
    canonicalJson(body.authorized_providers) !== canonicalJson(LC4_QUALIFICATION_PROVIDER_ORDER)
    || canonicalJson(body.authorized_models) !== canonicalJson(expectedModels)
    || body.maximum_total_micro_usd !== LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD
    || body.zero_caller_audio !== true
    || body.maximum_response_generations !== 3
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
    wire_type: observation.wireType,
    payload_sha256: observation.payloadSha256,
    payload_bytes: observation.payloadBytes,
    projection_sha256: observation.projectionSha256,
    previous_observation_sha256: observation.previousObservationSha256,
    observation_sha256: observation.observationSha256,
    identities: observation.identities,
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
  execution: ResponseToolCanaryExecution,
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
    writeFile(resolve(partial, `${execution.provider}-wire.jsonl`), wireEncoded ? `${wireEncoded}\n` : "", { flag: "wx", mode: 0o400 }),
    writeFile(resolve(partial, `${execution.provider}-usage.jsonl`), usageEncoded ? `${usageEncoded}\n` : "", { flag: "wx", mode: 0o400 }),
  ]);
  return Object.freeze({
    wire_observation_count: wire.length,
    wire_evidence_sha256: sha256Hex(wireEncoded),
    usage_event_count: usage.length,
    usage_evidence_sha256: sha256Hex(usageEncoded),
  });
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
  const credentials = await exactSourceAndCredentials({ plan, repositoryRoot, dependencies });
  const attemptId = input.attemptId ?? input.authorization.body.authorization_id;
  requireSafeId(attemptId, "LC4 qualification attempt ID");
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
    caller_audio_bytes: 0,
    maximum_total_micro_usd: LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD,
    maximum_response_generations: 3,
    paid_retry_allowed: false,
    intent_sha256: sha256Hex(canonicalJson({ attemptId, plan: plan.plan_sha256, authorization: input.authorization.artifact_sha256 })),
  }));
  const targets = createLc4QualificationTargets();
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
      caller_audio_bytes: 0 as const,
      response_generations_attempted: 0,
      paid_retries_attempted: 0 as const,
      maximum_total_micro_usd: LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD,
      results: Object.freeze([]),
    });
    const terminal = Object.freeze({ ...body, terminal_sha256: terminalSha256(body) });
    await writeImmutableJson(resolve(partial, "terminal.json"), terminal);
    await rename(partial, complete);
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
    status: responseCanary.status,
    qualification_artifact_sha256: qualification.artifactSha256,
    response_tool_canary_artifact_sha256: responseCanary.artifactSha256,
    caller_audio_bytes: 0 as const,
    response_generations_attempted: canaryResults.length,
    paid_retries_attempted: 0 as const,
    maximum_total_micro_usd: LC4_QUALIFICATION_MAXIMUM_TOTAL_MICRO_USD,
    results: Object.freeze(retainedResults),
  });
  const terminal = Object.freeze({ ...body, terminal_sha256: terminalSha256(body) });
  await writeImmutableJson(resolve(partial, "terminal.json"), terminal);
  await rename(partial, complete);
  return terminal;
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
  for (const name of complete) {
    const terminal = await readJson<Lc4QualificationTerminalArtifact>(resolve(attemptsRoot, name, "terminal.json"), "LC4 qualification terminal");
    const { terminal_sha256, ...body } = terminal;
    if (terminalSha256(body) !== terminal_sha256 || terminal.plan_sha256 !== plan.plan_sha256) {
      throw new Error(`LC4 qualification terminal ${name} failed integrity`);
    }
    terminals.push(terminal);
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
    caller_audio_bytes: 0,
    completed_attempts: terminals.length,
    incomplete_attempts: partial.length,
    paid_retry_allowed: false,
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
        caller_audio_bytes: 0,
        maximum_response_generations: 3,
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

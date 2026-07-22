import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, sha256Hex } from "./artifacts";
import {
  assertProviderQualificationArtifactIntegrity,
  providerQualificationMatrixSha256,
  qualifyProviders,
  type ProviderQualificationArtifact,
  type ProviderQualificationTarget,
} from "./provider-qualification";
import {
  LC4_S2S_COMPACT_CONTROL_SHA256,
  LC4_S2S_PACKETIZER_SHA256,
  LC4_S2S_TOOL,
  LC4_S2S_TOOL_SCHEMA_SHA256,
  LC4_S2S_VOICE_SHA256,
  assertLc4S2sRoundtripExecution,
  executeLc4S2sToolRoundtrip,
  lc4S2sControlSizeDiagnostic,
  loadLc4S2sPcm,
  materializeLc4S2sAudioFixture,
  type Lc4S2sAudioFixtureArtifact,
  type Lc4S2sAudioRenderer,
  type Lc4S2sRoundtripExecution,
} from "./provider-s2s-tool-roundtrip";
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
import type { NormalizedRealtimeClient, NormalizedRealtimeUsage } from "../realtime/client/types";
import {
  assertLc4QualificationBudgetEvidence,
  finalizeLc4QualificationBudget,
  reserveLc4QualificationBudget,
  type Lc4QualificationBudgetBinding,
  type Lc4QualificationBudgetEvidence,
} from "./lc4-qualification-budget";

export const LC4_QUALIFICATION_V3_RUNNER_VERSION = "HACC-LC4-QUALIFICATION-RUNNER-v3" as const;
export const LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION = "HACC-LC4-QUALIFICATION-AUTHORIZATION-v3" as const;
export const LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD = 3_000_000 as const;
export const LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS = 6 as const;
export const LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS = 3 as const;
export const LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES = 6 as const;
export const LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS = 3 as const;
export const LC4_QUALIFICATION_V3_PROVIDER_ORDER = Object.freeze(["openai", "gemini", "xai"] as const);

const PLAN_DOMAIN = "harshas-amazing-call-center/lc4-qualification-plan/v3\n";
const PLAN_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-plan-artifact/v3\n";
const AUTHORIZATION_DOMAIN = "harshas-amazing-call-center/lc4-qualification-authorization/v3\n";
const AUTHORIZATION_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-authorization-artifact/v3\n";
const TERMINAL_DOMAIN = "harshas-amazing-call-center/lc4-qualification-terminal/v3\n";
const TERMINAL_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-terminal-artifact/v3\n";
const PACKAGE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-package/v3\n";
const CREDENTIAL_DOMAIN = "harshas-amazing-call-center/provider-credential/v1\n";
const CREDENTIAL_SET_DOMAIN = "harshas-amazing-call-center/provider-credential-set/v1\n";
const SOURCE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-git-tree/v1\n";
const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;

export type Lc4QualificationV3GitSource = Readonly<{
  source_commit: string;
  source_tree_oid: string;
  source_tree_sha256: string;
  worktree_clean: true;
}>;

export type Lc4QualificationV3PlanBody = Readonly<{
  schema_version: 1;
  runner_version: typeof LC4_QUALIFICATION_V3_RUNNER_VERSION;
  protocol_id: "HACC-LC4-v1";
  plan_id: string;
  prepared_at: string;
  source: Lc4QualificationV3GitSource;
  provider_profile_manifest_sha256: string;
  setup_configuration_matrix_sha256: string;
  credential_set_sha256: string;
  credential_identities: readonly Readonly<{ provider: LiveStsProvider; credential_sha256: string }>[];
  audio_fixture: Lc4S2sAudioFixtureArtifact;
  control_size_diagnostic: ReturnType<typeof lc4S2sControlSizeDiagnostic>;
  targets: readonly Readonly<{
    provider: LiveStsProvider;
    model: string;
    sample_rate_hz: 16_000 | 24_000;
    caller_audio_bytes: number;
    caller_audio_sha256: string;
    caller_audio_cas_sha256: string;
    caller_audio_duration_ms: number;
    gateway_schema_sha256: typeof LC4_S2S_TOOL_SCHEMA_SHA256;
    voice_sha256: typeof LC4_S2S_VOICE_SHA256;
    compact_control_sha256: typeof LC4_S2S_COMPACT_CONTROL_SHA256;
    packetizer_sha256: typeof LC4_S2S_PACKETIZER_SHA256;
    audio_delivery_profile_sha256: string;
    setup_sessions: 1;
    paid_sessions: 1;
    generation_phases: 2;
    tool_roundtrips: 1;
  }>[];
  execution_scope: "gate_a_setup_acceptance_then_gate_b_spoken_tool_roundtrip_gate_c_diagnostic_only";
  maximum_total_micro_usd: typeof LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD;
  maximum_provider_sessions: typeof LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS;
  maximum_paid_sessions: typeof LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS;
  maximum_generation_phases: typeof LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES;
  maximum_tool_roundtrips: typeof LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS;
  paid_retry_allowed: false;
  provider_calls_authorized: false;
  plan_sha256: string;
}>;

type SignedArtifact<Body> = Readonly<{
  body: Body;
  authority_public_key_spki_base64: string;
  authority_public_key_fingerprint_sha256: string;
  signature_algorithm: "Ed25519";
  signature_base64: string;
  artifact_sha256: string;
}>;

export type Lc4QualificationV3PlanArtifact = SignedArtifact<Lc4QualificationV3PlanBody>;

export type Lc4QualificationV3AuthorizationBody = Readonly<{
  schema_version: 1;
  authorization_version: typeof LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION;
  authorization_id: string;
  authorization_nonce_sha256: string;
  plan_artifact_sha256: string;
  plan_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  credential_set_sha256: string;
  terminal_public_key_spki_base64: string;
  terminal_public_key_fingerprint_sha256: string;
  maximum_total_micro_usd: typeof LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD;
  maximum_provider_sessions: typeof LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS;
  maximum_paid_sessions: typeof LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS;
  maximum_generation_phases: typeof LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES;
  maximum_tool_roundtrips: typeof LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS;
  paid_retry_allowed: false;
  not_before: string;
  expires_at: string;
}>;

export type Lc4QualificationV3AuthorizationArtifact = SignedArtifact<Lc4QualificationV3AuthorizationBody>;

export type Lc4QualificationV3TerminalBody = Readonly<{
  schema_version: 1;
  runner_version: typeof LC4_QUALIFICATION_V3_RUNNER_VERSION;
  attempt_id: string;
  plan_artifact_sha256: string;
  plan_sha256: string;
  authorization_artifact_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  attempted_at: string;
  completed_at: string;
  status: "passed" | "failed";
  primary_failure_class: string | null;
  setup_qualification_artifact_sha256: string;
  control_size_diagnostic_sha256: string;
  roundtrip_evidence_sha256: readonly string[];
  budget_evidence_sha256: string;
  budget_final_head_sha256: string;
  provider_sessions_opened: number;
  paid_sessions_opened: number;
  generation_phases_attempted: number;
  tool_roundtrips_attempted: number;
  caller_audio_bytes: number;
  paid_retries_attempted: 0;
  results: readonly Readonly<{
    provider: LiveStsProvider;
    model: string;
    status: "passed" | "failed";
    failure_class: string;
    caller_audio_bytes: number;
    wire_observation_count: number;
    usage_event_count: number;
    evidence_sha256: string;
  }>[];
  terminal_sha256: string;
}>;

export type Lc4QualificationV3TerminalArtifact = SignedArtifact<Lc4QualificationV3TerminalBody>;

type Dependencies = Readonly<{
  inspectGitSource(repositoryRoot: string): Promise<Lc4QualificationV3GitSource>;
  loadCredentials(repositoryRoot: string): Promise<Readonly<Record<LiveStsProvider, string>>>;
  createClient(provider: LiveStsProvider, configuration: TrialSessionConfiguration, apiKey: string): NormalizedRealtimeClient;
  materializeAudio(input: Readonly<{ root: string; renderer?: Lc4S2sAudioRenderer }>): Promise<Lc4S2sAudioFixtureArtifact>;
  executeRoundtrip(input: Parameters<typeof executeLc4S2sToolRoundtrip>[0]): Promise<Lc4S2sRoundtripExecution>;
}>;

const defaultDependencies: Dependencies = Object.freeze({
  inspectGitSource: inspectLc4QualificationV3GitSource,
  loadCredentials: loadProductionRealtimeCredentials,
  createClient: createProductionRealtimeClient,
  materializeAudio: materializeLc4S2sAudioFixture,
  executeRoundtrip: executeLc4S2sToolRoundtrip,
});

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function requireSha(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function requireId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} is not a safe opaque identifier`);
}

function requireIso(value: string, label: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) throw new Error(`${label} must be a canonical ISO time`);
  return epoch;
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

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function keyIdentity(privateKeyPem: string): Readonly<{
  privateKey: ReturnType<typeof createPrivateKey>;
  publicKeySpki: Buffer;
  publicKeySpkiBase64: string;
  fingerprint: string;
}> {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("LC4 qualification signer must be Ed25519");
  const publicKeySpki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return freeze({
    privateKey,
    publicKeySpki,
    publicKeySpkiBase64: publicKeySpki.toString("base64"),
    fingerprint: sha256Hex(publicKeySpki),
  });
}

function signedArtifact<Body>(input: Readonly<{
  body: Body;
  privateKeyPem: string;
  signingDomain: string;
  artifactDomain: string;
}>): SignedArtifact<Body> {
  const key = keyIdentity(input.privateKeyPem);
  const unsigned = freeze({
    body: input.body,
    authority_public_key_spki_base64: key.publicKeySpkiBase64,
    authority_public_key_fingerprint_sha256: key.fingerprint,
    signature_algorithm: "Ed25519" as const,
    signature_base64: sign(null, Buffer.from(`${input.signingDomain}${canonicalJson(input.body)}`), key.privateKey).toString("base64"),
  });
  return freeze({ ...unsigned, artifact_sha256: sha256Hex(`${input.artifactDomain}${canonicalJson(unsigned)}`) });
}

function assertSignedArtifact<Body>(input: Readonly<{
  artifact: SignedArtifact<Body>;
  expectedFingerprint: string;
  signingDomain: string;
  artifactDomain: string;
}>): void {
  const { artifact_sha256, ...unsigned } = input.artifact;
  if (sha256Hex(`${input.artifactDomain}${canonicalJson(unsigned)}`) !== artifact_sha256) throw new Error("LC4 signed artifact hash mismatch");
  const keyBytes = Buffer.from(input.artifact.authority_public_key_spki_base64, "base64");
  if (sha256Hex(keyBytes) !== input.artifact.authority_public_key_fingerprint_sha256
    || input.artifact.authority_public_key_fingerprint_sha256 !== input.expectedFingerprint) throw new Error("LC4 signed artifact trust root mismatch");
  const publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519"
    || !verify(null, Buffer.from(`${input.signingDomain}${canonicalJson(input.artifact.body)}`), publicKey, Buffer.from(input.artifact.signature_base64, "base64"))) {
    throw new Error("LC4 signed artifact signature is invalid");
  }
}

function credentialIdentity(provider: LiveStsProvider, credential: string) {
  if (credential.length < 12) throw new Error(`missing ${provider} credential`);
  return freeze({ provider, credential_sha256: sha256Hex(`${CREDENTIAL_DOMAIN}${credential}`) });
}

function credentialSetSha256(credentials: Readonly<Record<LiveStsProvider, string>>): string {
  return sha256Hex(`${CREDENTIAL_SET_DOMAIN}${canonicalJson(LC4_QUALIFICATION_V3_PROVIDER_ORDER.map((provider) => credentialIdentity(provider, credentials[provider])))}`);
}

function setupConfiguration(provider: LiveStsProvider): TrialSessionConfiguration {
  const spec = LIVE_STS_PROVIDER_SPECS[provider];
  const instructions = [
    "This is a development-only realtime voice transport qualification.",
    "Use only the exact closed semantic capability gateway when the caller requests it.",
    "Never speak before a required tool call and never claim an action without its tool result.",
  ].join(" ");
  const renderedCapabilitySnapshot = "<qualification_gateway semantic_intent=\"complete_current_stage\" arguments=\"{}\" />";
  return freeze({
    provider,
    model: spec.model,
    conditionId: "host-managed-harness" as const,
    instructions,
    initialPrompt: instructions,
    renderedCapabilitySnapshot,
    providerTools: freeze([LC4_S2S_TOOL]),
    conditionHash: sha256Hex(`harshas-amazing-call-center/lc4-qualification-v3-condition/v1\n${provider}\n${instructions}`),
    inputAudioFormat: freeze({ encoding: "pcm16" as const, sampleRateHz: spec.sampleRateHz, channels: 1 as const }),
    audioDeliveryProfile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
    audioDeliveryProfileHash: trialAudioDeliveryProfileHash(DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE),
  });
}

export function createLc4QualificationV3Targets(): readonly ProviderQualificationTarget[] {
  assertLc4ProviderProfileManifest(LC4_PROVIDER_PROFILE_MANIFEST);
  return freeze(LC4_QUALIFICATION_V3_PROVIDER_ORDER.map((provider) => {
    const configuration = setupConfiguration(provider);
    const profile = LC4_PROVIDER_PROFILE_MANIFEST.providers[provider];
    if (configuration.model !== profile.model || configuration.inputAudioFormat.sampleRateHz !== profile.input_sample_rate_hz) {
      throw new Error(`LC4 qualification v3 ${provider} differs from frozen provider profile`);
    }
    return freeze({ provider, model: configuration.model, configuration });
  }));
}

export async function inspectLc4QualificationV3GitSource(repositoryRoot: string): Promise<Lc4QualificationV3GitSource> {
  const [{ stdout: status }, { stdout: commit }, { stdout: tree }] = await Promise.all([
    execFileAsync("git", ["-C", resolve(repositoryRoot), "status", "--porcelain=v1", "--untracked-files=all"]),
    execFileAsync("git", ["-C", resolve(repositoryRoot), "rev-parse", "HEAD"]),
    execFileAsync("git", ["-C", resolve(repositoryRoot), "rev-parse", "HEAD^{tree}"]),
  ]);
  if (status.trim()) throw new Error("LC4 qualification v3 requires an exactly clean worktree");
  const sourceCommit = commit.trim();
  const sourceTreeOid = tree.trim();
  if (!SHA1.test(sourceCommit) || !SHA1.test(sourceTreeOid)) throw new Error("LC4 qualification v3 Git identity is invalid");
  return freeze({
    source_commit: sourceCommit,
    source_tree_oid: sourceTreeOid,
    source_tree_sha256: sha256Hex(`${SOURCE_DOMAIN}${canonicalJson({ source_commit: sourceCommit, source_tree_oid: sourceTreeOid })}`),
    worktree_clean: true as const,
  });
}

function planBodySha256(body: Omit<Lc4QualificationV3PlanBody, "plan_sha256">): string {
  return sha256Hex(`${PLAN_DOMAIN}${canonicalJson(body)}`);
}

export function assertLc4QualificationV3PlanArtifact(artifact: Lc4QualificationV3PlanArtifact, trustRootFingerprint: string): void {
  assertSignedArtifact({ artifact, expectedFingerprint: trustRootFingerprint, signingDomain: PLAN_DOMAIN, artifactDomain: PLAN_ARTIFACT_DOMAIN });
  const { plan_sha256, ...body } = artifact.body;
  if (planBodySha256(body) !== plan_sha256) throw new Error("LC4 qualification v3 plan body hash mismatch");
  if (artifact.body.runner_version !== LC4_QUALIFICATION_V3_RUNNER_VERSION
    || artifact.body.maximum_total_micro_usd !== LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD
    || artifact.body.maximum_provider_sessions !== LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS
    || artifact.body.maximum_paid_sessions !== LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS
    || artifact.body.maximum_generation_phases !== LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES
    || artifact.body.maximum_tool_roundtrips !== LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS
    || artifact.body.paid_retry_allowed !== false
    || artifact.body.provider_calls_authorized !== false
    || artifact.body.control_size_diagnostic.qualification_gate !== false
    || artifact.body.targets.length !== 3
    || artifact.body.targets.some((target) => target.gateway_schema_sha256 !== LC4_S2S_TOOL_SCHEMA_SHA256)) {
    throw new Error("LC4 qualification v3 plan weakened a frozen boundary");
  }
}

export async function prepareLc4QualificationV3(input: Readonly<{
  root: string;
  repositoryRoot: string;
  authorityPrivateKeyPem: string;
  trustRootFingerprint: string;
  now?: () => Date;
  planId?: string;
  audioRenderer?: Lc4S2sAudioRenderer;
  dependencies?: Pick<Dependencies, "inspectGitSource" | "loadCredentials" | "materializeAudio">;
}>): Promise<Lc4QualificationV3PlanArtifact> {
  const root = resolve(input.root);
  const repositoryRoot = resolve(input.repositoryRoot);
  const rootRelation = relative(repositoryRoot, root);
  if (rootRelation === "" || (!rootRelation.startsWith("..") && !resolve(rootRelation).startsWith(".."))) {
    throw new Error("LC4 qualification v3 evidence root must be outside the repository");
  }
  const dependencies = input.dependencies ?? defaultDependencies;
  const [source, credentials] = await Promise.all([
    dependencies.inspectGitSource(repositoryRoot),
    dependencies.loadCredentials(repositoryRoot),
  ]);
  const fixture = await dependencies.materializeAudio({ root, renderer: input.audioRenderer });
  const targets = createLc4QualificationV3Targets();
  const planId = input.planId ?? randomUUID();
  requireId(planId, "LC4 qualification v3 plan ID");
  const unsignedBody = freeze({
    schema_version: 1 as const,
    runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
    protocol_id: "HACC-LC4-v1" as const,
    plan_id: planId,
    prepared_at: (input.now ?? (() => new Date()))().toISOString(),
    source,
    provider_profile_manifest_sha256: LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
    setup_configuration_matrix_sha256: providerQualificationMatrixSha256(targets),
    credential_set_sha256: credentialSetSha256(credentials),
    credential_identities: freeze(LC4_QUALIFICATION_V3_PROVIDER_ORDER.map((provider) => credentialIdentity(provider, credentials[provider]))),
    audio_fixture: fixture,
    control_size_diagnostic: lc4S2sControlSizeDiagnostic(),
    targets: freeze(LC4_QUALIFICATION_V3_PROVIDER_ORDER.map((provider) => {
      const object = fixture.provider_renditions[provider];
      return freeze({
        provider,
        model: LIVE_STS_PROVIDER_SPECS[provider].model,
        sample_rate_hz: object.sample_rate_hz,
        caller_audio_bytes: object.byte_length,
        caller_audio_sha256: object.sha256,
        caller_audio_cas_sha256: object.cas_sha256,
        caller_audio_duration_ms: object.duration_ms,
        gateway_schema_sha256: LC4_S2S_TOOL_SCHEMA_SHA256,
        voice_sha256: LC4_S2S_VOICE_SHA256,
        compact_control_sha256: LC4_S2S_COMPACT_CONTROL_SHA256,
        packetizer_sha256: LC4_S2S_PACKETIZER_SHA256,
        audio_delivery_profile_sha256: trialAudioDeliveryProfileHash(DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE),
        setup_sessions: 1 as const,
        paid_sessions: 1 as const,
        generation_phases: 2 as const,
        tool_roundtrips: 1 as const,
      });
    })),
    execution_scope: "gate_a_setup_acceptance_then_gate_b_spoken_tool_roundtrip_gate_c_diagnostic_only" as const,
    maximum_total_micro_usd: LC4_QUALIFICATION_V3_MAXIMUM_TOTAL_MICRO_USD,
    maximum_provider_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
    maximum_paid_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
    maximum_generation_phases: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
    maximum_tool_roundtrips: LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
    paid_retry_allowed: false as const,
    provider_calls_authorized: false as const,
  });
  const body = freeze({ ...unsignedBody, plan_sha256: planBodySha256(unsignedBody) });
  const artifact = signedArtifact({ body, privateKeyPem: input.authorityPrivateKeyPem, signingDomain: PLAN_DOMAIN, artifactDomain: PLAN_ARTIFACT_DOMAIN });
  assertLc4QualificationV3PlanArtifact(artifact, input.trustRootFingerprint);
  await writeImmutableJson(resolve(root, "lc4-qualification-v3-plan.json"), artifact);
  return artifact;
}

export function lc4QualificationV3AuthorizationSigningBytes(body: Lc4QualificationV3AuthorizationBody): Uint8Array {
  return Buffer.from(`${AUTHORIZATION_DOMAIN}${canonicalJson(body)}`);
}

export function createLc4QualificationV3AuthorizationArtifact(input: Readonly<{
  body: Lc4QualificationV3AuthorizationBody;
  authorityPrivateKeyPem: string;
}>): Lc4QualificationV3AuthorizationArtifact {
  return signedArtifact({ body: input.body, privateKeyPem: input.authorityPrivateKeyPem, signingDomain: AUTHORIZATION_DOMAIN, artifactDomain: AUTHORIZATION_ARTIFACT_DOMAIN });
}

export function assertLc4QualificationV3Authorization(input: Readonly<{
  artifact: Lc4QualificationV3AuthorizationArtifact;
  plan: Lc4QualificationV3PlanArtifact;
  trustRootFingerprint: string;
  now: Date;
}>): void {
  assertSignedArtifact({ artifact: input.artifact, expectedFingerprint: input.trustRootFingerprint, signingDomain: AUTHORIZATION_DOMAIN, artifactDomain: AUTHORIZATION_ARTIFACT_DOMAIN });
  const body = input.artifact.body;
  const plan = input.plan.body;
  if (body.authorization_version !== LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION
    || body.plan_artifact_sha256 !== input.plan.artifact_sha256
    || body.plan_sha256 !== plan.plan_sha256
    || body.source_commit !== plan.source.source_commit
    || body.source_tree_sha256 !== plan.source.source_tree_sha256
    || body.credential_set_sha256 !== plan.credential_set_sha256
    || body.maximum_total_micro_usd !== plan.maximum_total_micro_usd
    || body.maximum_provider_sessions !== plan.maximum_provider_sessions
    || body.maximum_paid_sessions !== plan.maximum_paid_sessions
    || body.maximum_generation_phases !== plan.maximum_generation_phases
    || body.maximum_tool_roundtrips !== plan.maximum_tool_roundtrips
    || body.paid_retry_allowed !== false) throw new Error("LC4 qualification v3 authorization differs from its signed plan");
  requireId(body.authorization_id, "LC4 qualification v3 authorization ID");
  requireSha(body.authorization_nonce_sha256, "LC4 qualification v3 nonce");
  requireSha(body.terminal_public_key_fingerprint_sha256, "LC4 qualification v3 terminal key fingerprint");
  if (sha256Hex(Buffer.from(body.terminal_public_key_spki_base64, "base64")) !== body.terminal_public_key_fingerprint_sha256) {
    throw new Error("LC4 qualification v3 terminal key identity is invalid");
  }
  const start = requireIso(body.not_before, "authorization start");
  const end = requireIso(body.expires_at, "authorization expiry");
  if (end <= start || input.now.getTime() < start || input.now.getTime() >= end) throw new Error("LC4 qualification v3 authorization is inactive");
}

function sanitizeUsage(usage: NormalizedRealtimeUsage): Readonly<Record<string, unknown>> {
  const { raw, ...meters } = usage;
  return freeze({ ...meters, raw_usage_sha256: sha256Hex(canonicalJson(raw)) });
}

async function retainRoundtrip(partial: string, execution: Lc4S2sRoundtripExecution): Promise<void> {
  assertLc4S2sRoundtripExecution(execution);
  const { wire_observations, usage, ...summary } = execution;
  await Promise.all([
    writeImmutableJson(resolve(partial, `${execution.provider}-spoken-roundtrip.json`), freeze({ ...summary, wire_observation_count: wire_observations.length, usage_event_count: usage.length })),
    writeFile(resolve(partial, `${execution.provider}-spoken-roundtrip-wire.jsonl`), wire_observations.map((entry) => canonicalJson(entry)).join("\n") + (wire_observations.length ? "\n" : ""), { flag: "wx", mode: 0o400 }),
    writeFile(resolve(partial, `${execution.provider}-spoken-roundtrip-usage.jsonl`), usage.map((entry) => canonicalJson(sanitizeUsage(entry))).join("\n") + (usage.length ? "\n" : ""), { flag: "wx", mode: 0o400 }),
  ]);
}

async function retainPackageManifest(partial: string, bindings: Readonly<Record<string, string>>): Promise<string> {
  const forbidden = /(?:^|\/)(?:artifact-manifest\.json|.*\.pem|.*\.env|budget.*signing-key)(?:$|\/)/u;
  const names = (await readdir(partial)).sort();
  if (names.some((name) => name.includes("/") || forbidden.test(name))) throw new Error("LC4 qualification v3 package contains a forbidden path");
  const entries = [] as Array<Readonly<{ path: string; byte_length: number; sha256: string }>>;
  for (const name of names) {
    if (name === "artifact-manifest.json") throw new Error("LC4 qualification v3 package manifest cannot include itself");
    const path = resolve(partial, name);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("LC4 qualification v3 package accepts only regular files");
    const bytes = await readFile(path);
    entries.push(freeze({ path: name, byte_length: bytes.byteLength, sha256: sha256Hex(bytes) }));
  }
  const body = freeze({
    schema_version: 1 as const,
    manifest_version: "HACC-LC4-QUALIFICATION-PACKAGE-v3" as const,
    self_excluded: true as const,
    entries: freeze(entries),
    bindings,
  });
  const artifact = freeze({ ...body, package_sha256: sha256Hex(`${PACKAGE_DOMAIN}${canonicalJson(body)}`) });
  await writeImmutableJson(resolve(partial, "artifact-manifest.json"), artifact);
  return artifact.package_sha256;
}

export async function runLc4QualificationV3(input: Readonly<{
  root: string;
  repositoryRoot: string;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  trustRootFingerprint: string;
  terminalPrivateKeyPem: string;
  now?: () => Date;
  dependencies?: Dependencies;
}>): Promise<Lc4QualificationV3TerminalArtifact> {
  const root = resolve(input.root);
  const repositoryRoot = resolve(input.repositoryRoot);
  const plan = await readJson<Lc4QualificationV3PlanArtifact>(resolve(root, "lc4-qualification-v3-plan.json"));
  assertLc4QualificationV3PlanArtifact(plan, input.trustRootFingerprint);
  const now = input.now ?? (() => new Date());
  assertLc4QualificationV3Authorization({ artifact: input.authorization, plan, trustRootFingerprint: input.trustRootFingerprint, now: now() });
  const terminalKey = keyIdentity(input.terminalPrivateKeyPem);
  if (terminalKey.fingerprint !== input.authorization.body.terminal_public_key_fingerprint_sha256) throw new Error("LC4 qualification v3 terminal private key is not authorization-pinned");
  const dependencies = input.dependencies ?? defaultDependencies;
  const [source, credentials] = await Promise.all([
    dependencies.inspectGitSource(repositoryRoot),
    dependencies.loadCredentials(repositoryRoot),
  ]);
  if (canonicalJson(source) !== canonicalJson(plan.body.source) || credentialSetSha256(credentials) !== plan.body.credential_set_sha256) {
    throw new Error("LC4 qualification v3 source or credentials changed after planning");
  }
  const attemptId = input.authorization.body.authorization_id;
  const attemptsRoot = resolve(root, "attempts");
  const partial = resolve(attemptsRoot, `${attemptId}.partial`);
  const complete = resolve(attemptsRoot, `${attemptId}.complete`);
  await mkdir(attemptsRoot, { recursive: true, mode: 0o700 });
  await writeFile(resolve(attemptsRoot, `${attemptId}.consumed`), `${plan.artifact_sha256}\n`, { flag: "wx", mode: 0o400 });
  await mkdir(partial, { mode: 0o700 });
  const attemptedAt = now().toISOString();
  const targets = createLc4QualificationV3Targets();
  const budgetBinding: Lc4QualificationBudgetBinding = freeze({
    attemptId,
    authorizationId: attemptId,
    authorizationArtifactSha256: input.authorization.artifact_sha256,
    planSha256: plan.body.plan_sha256,
    sourceCommit: plan.body.source.source_commit,
    sourceTreeSha256: plan.body.source.source_tree_sha256,
    credentialSetSha256: plan.body.credential_set_sha256,
    providerProfileManifestSha256: plan.body.provider_profile_manifest_sha256,
    configurationMatrixSha256: plan.body.setup_configuration_matrix_sha256,
    devConfigurationMatrixSha256: plan.body.setup_configuration_matrix_sha256,
    providersModels: freeze(Object.fromEntries(plan.body.targets.map((target) => [target.provider, target.model])) as Record<LiveStsProvider, string>),
    expiresAt: input.authorization.body.expires_at,
  });
  const budgetReservation = await reserveLc4QualificationBudget({ root, binding: budgetBinding, now });
  let setupArtifact: ProviderQualificationArtifact;
  let providerSessionsOpened = 0;
  let paidSessionsOpened = 0;
  let generationPhasesAttempted = 0;
  let toolRoundtripsAttempted = 0;
  let callerAudioBytes = 0;
  let primaryFailure: string | null = null;
  const executions: Lc4S2sRoundtripExecution[] = [];
  let budgetEvidence: Lc4QualificationBudgetEvidence | null = null;
  try {
    await writeImmutableJson(resolve(partial, "intent.json"), freeze({
      schema_version: 1,
      plan_artifact_sha256: plan.artifact_sha256,
      authorization_artifact_sha256: input.authorization.artifact_sha256,
      attempt_id: attemptId,
      attempted_at: attemptedAt,
      provider_order: LC4_QUALIFICATION_V3_PROVIDER_ORDER,
      paid_retry_allowed: false,
    }));
    await writeImmutableJson(resolve(partial, "authorization.json"), input.authorization);
    await writeImmutableJson(resolve(partial, "control-size-diagnostic.json"), plan.body.control_size_diagnostic);
    setupArtifact = await qualifyProviders({
      root,
      protocolId: plan.body.protocol_id,
      planSha256: plan.body.plan_sha256,
      sourceCommit: plan.body.source.source_commit,
      targets,
      credentials,
      createClient: (target, apiKey) => {
        providerSessionsOpened += 1;
        return dependencies.createClient(target.provider, target.configuration, apiKey);
      },
      now,
      qualificationId: attemptId,
    });
    assertProviderQualificationArtifactIntegrity(setupArtifact);
    await writeImmutableJson(resolve(partial, "setup-acceptance.json"), setupArtifact);
    if (setupArtifact.status === "failed") primaryFailure = "setup_acceptance_failed";
    if (primaryFailure === null) {
      for (const provider of LC4_QUALIFICATION_V3_PROVIDER_ORDER) {
        const target = targets.find((entry) => entry.provider === provider)!;
        const planned = plan.body.targets.find((entry) => entry.provider === provider)!;
        const audio = await loadLc4S2sPcm({ root, artifact: plan.body.audio_fixture, provider });
        paidSessionsOpened += 1;
        providerSessionsOpened += 1;
        generationPhasesAttempted += 2;
        toolRoundtripsAttempted += 1;
        const execution = await dependencies.executeRoundtrip({
          provider,
          model: target.model,
          client: dependencies.createClient(provider, target.configuration, credentials[provider]),
          audio,
          audioObject: plan.body.audio_fixture.provider_renditions[provider],
          profile: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
          timeoutMs: 45_000,
          now,
        });
        if (execution.audio.sha256 !== planned.caller_audio_sha256
          || execution.audio.byte_length !== planned.caller_audio_bytes
          || execution.tool_schema_sha256 !== planned.gateway_schema_sha256) throw new Error(`LC4 qualification v3 ${provider} execution differs from plan`);
        assertLc4S2sRoundtripExecution(execution);
        await retainRoundtrip(partial, execution);
        executions.push(execution);
        callerAudioBytes += execution.delivery?.audio_bytes ?? 0;
        if (execution.status === "failed" && primaryFailure === null) primaryFailure = `${provider}:${execution.failure_class}`;
      }
    }
  } catch (error) {
    primaryFailure ??= error instanceof Error ? `runner_exception:${sha256Hex(error.message)}` : "runner_exception";
    setupArtifact ??= freeze({
      schemaVersion: 1,
      qualificationId: attemptId,
      protocolId: plan.body.protocol_id,
      planSha256: plan.body.plan_sha256,
      sourceCommit: plan.body.source.source_commit,
      configurationMatrixSha256: plan.body.setup_configuration_matrix_sha256,
      credentialSetSha256: plan.body.credential_set_sha256,
      probeScope: "session_handshake_and_configuration_acknowledgement_no_audio_no_generation",
      attemptedAt,
      completedAt: now().toISOString(),
      status: "failed",
      results: freeze([]),
      artifactSha256: sha256Hex(`runner-exception:${attemptId}`),
    });
  } finally {
    const usageProjection = executions.flatMap((execution) => execution.usage.map((usage) => sanitizeUsage(usage)));
    budgetEvidence = await finalizeLc4QualificationBudget({
      reservation: budgetReservation,
      attemptId,
      usageEventCount: usageProjection.length,
      usageEvidenceSha256: sha256Hex(canonicalJson(usageProjection)),
      outcome: primaryFailure === null ? "completed" : "failed",
      now,
    });
    assertLc4QualificationBudgetEvidence(budgetEvidence);
    await writeImmutableJson(resolve(partial, "budget-settlement.json"), budgetEvidence);
  }
  if (providerSessionsOpened > plan.body.maximum_provider_sessions
    || paidSessionsOpened > plan.body.maximum_paid_sessions
    || generationPhasesAttempted > plan.body.maximum_generation_phases
    || toolRoundtripsAttempted > plan.body.maximum_tool_roundtrips) {
    primaryFailure ??= "planned_counter_ceiling_exceeded";
  }
  const terminalWithoutHash = freeze({
    schema_version: 1 as const,
    runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
    attempt_id: attemptId,
    plan_artifact_sha256: plan.artifact_sha256,
    plan_sha256: plan.body.plan_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    source_commit: plan.body.source.source_commit,
    source_tree_sha256: plan.body.source.source_tree_sha256,
    attempted_at: attemptedAt,
    completed_at: now().toISOString(),
    status: primaryFailure === null && executions.length === 3 && executions.every((execution) => execution.status === "passed") ? "passed" as const : "failed" as const,
    primary_failure_class: primaryFailure,
    setup_qualification_artifact_sha256: setupArtifact!.artifactSha256,
    control_size_diagnostic_sha256: plan.body.control_size_diagnostic.diagnostic_sha256,
    roundtrip_evidence_sha256: freeze(executions.map((execution) => execution.evidence_sha256)),
    budget_evidence_sha256: budgetEvidence!.evidence_sha256,
    budget_final_head_sha256: budgetEvidence!.final_head_sha256,
    provider_sessions_opened: providerSessionsOpened,
    paid_sessions_opened: paidSessionsOpened,
    generation_phases_attempted: generationPhasesAttempted,
    tool_roundtrips_attempted: toolRoundtripsAttempted,
    caller_audio_bytes: callerAudioBytes,
    paid_retries_attempted: 0 as const,
    results: freeze(executions.map((execution) => freeze({
      provider: execution.provider,
      model: execution.model,
      status: execution.status,
      failure_class: execution.failure_class,
      caller_audio_bytes: execution.delivery?.audio_bytes ?? 0,
      wire_observation_count: execution.wire_observations.length,
      usage_event_count: execution.usage.length,
      evidence_sha256: execution.evidence_sha256,
    }))),
  });
  const terminalBody = freeze({ ...terminalWithoutHash, terminal_sha256: sha256Hex(`${TERMINAL_DOMAIN}${canonicalJson(terminalWithoutHash)}`) });
  const terminal = signedArtifact({ body: terminalBody, privateKeyPem: input.terminalPrivateKeyPem, signingDomain: TERMINAL_DOMAIN, artifactDomain: TERMINAL_ARTIFACT_DOMAIN });
  await writeImmutableJson(resolve(partial, "terminal.json"), terminal);
  await retainPackageManifest(partial, freeze({
    plan_artifact_sha256: plan.artifact_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    terminal_artifact_sha256: terminal.artifact_sha256,
    budget_evidence_sha256: budgetEvidence!.evidence_sha256,
  }));
  await rename(partial, complete);
  return terminal;
}

export async function reportLc4QualificationV3(input: Readonly<{
  root: string;
  trustRootFingerprint: string;
}>): Promise<Readonly<Record<string, unknown>>> {
  const root = resolve(input.root);
  const plan = await readJson<Lc4QualificationV3PlanArtifact>(resolve(root, "lc4-qualification-v3-plan.json"));
  assertLc4QualificationV3PlanArtifact(plan, input.trustRootFingerprint);
  const attemptsRoot = resolve(root, "attempts");
  const names = await readdir(attemptsRoot).catch(() => [] as string[]);
  const completeNames = names.filter((name) => name.endsWith(".complete")).sort();
  const verified: Lc4QualificationV3TerminalArtifact[] = [];
  for (const name of completeNames) {
    const directory = resolve(attemptsRoot, name);
    const [authorization, terminal, manifest] = await Promise.all([
      readJson<Lc4QualificationV3AuthorizationArtifact>(resolve(directory, "authorization.json")),
      readJson<Lc4QualificationV3TerminalArtifact>(resolve(directory, "terminal.json")),
      readJson<Readonly<{
        schema_version: 1;
        manifest_version: "HACC-LC4-QUALIFICATION-PACKAGE-v3";
        self_excluded: true;
        entries: readonly Readonly<{ path: string; byte_length: number; sha256: string }>[];
        bindings: Readonly<Record<string, string>>;
        package_sha256: string;
      }>>(resolve(directory, "artifact-manifest.json")),
    ]);
    assertSignedArtifact({
      artifact: authorization,
      expectedFingerprint: input.trustRootFingerprint,
      signingDomain: AUTHORIZATION_DOMAIN,
      artifactDomain: AUTHORIZATION_ARTIFACT_DOMAIN,
    });
    if (authorization.body.plan_artifact_sha256 !== plan.artifact_sha256
      || authorization.body.plan_sha256 !== plan.body.plan_sha256) throw new Error("LC4 qualification v3 retained authorization is cross-plan");
    assertSignedArtifact({
      artifact: terminal,
      expectedFingerprint: authorization.body.terminal_public_key_fingerprint_sha256,
      signingDomain: TERMINAL_DOMAIN,
      artifactDomain: TERMINAL_ARTIFACT_DOMAIN,
    });
    const { terminal_sha256, ...terminalBody } = terminal.body;
    if (terminal_sha256 !== sha256Hex(`${TERMINAL_DOMAIN}${canonicalJson(terminalBody)}`)
      || terminal.body.plan_artifact_sha256 !== plan.artifact_sha256
      || terminal.body.authorization_artifact_sha256 !== authorization.artifact_sha256) {
      throw new Error("LC4 qualification v3 terminal binding failed integrity");
    }
    const { package_sha256, ...packageBody } = manifest;
    if (manifest.self_excluded !== true
      || manifest.entries.some((entry) => entry.path === "artifact-manifest.json")
      || package_sha256 !== sha256Hex(`${PACKAGE_DOMAIN}${canonicalJson(packageBody)}`)
      || manifest.bindings.terminal_artifact_sha256 !== terminal.artifact_sha256) {
      throw new Error("LC4 qualification v3 detached package manifest failed integrity");
    }
    const actualNames = (await readdir(directory)).filter((entry) => entry !== "artifact-manifest.json").sort();
    if (canonicalJson(actualNames) !== canonicalJson(manifest.entries.map((entry) => entry.path))) {
      throw new Error("LC4 qualification v3 package has unknown, missing, or unsorted entries");
    }
    for (const entry of manifest.entries) {
      if (entry.path.includes("/") || /(?:\.pem|\.env)$/u.test(entry.path)) throw new Error("LC4 qualification v3 package contains a forbidden entry");
      const bytes = await readFile(resolve(directory, entry.path));
      if (bytes.byteLength !== entry.byte_length || sha256Hex(bytes) !== entry.sha256) {
        throw new Error("LC4 qualification v3 package entry failed integrity");
      }
    }
    const budgetEvidence = await readJson<Lc4QualificationBudgetEvidence>(resolve(directory, "budget-settlement.json"));
    assertLc4QualificationBudgetEvidence(budgetEvidence);
    if (budgetEvidence.evidence_sha256 !== terminal.body.budget_evidence_sha256
      || budgetEvidence.final_head_sha256 !== terminal.body.budget_final_head_sha256) {
      throw new Error("LC4 qualification v3 terminal budget binding failed integrity");
    }
    verified.push(terminal);
  }
  return freeze({
    schema_version: 1,
    runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
    plan_artifact_sha256: plan.artifact_sha256,
    source_commit: plan.body.source.source_commit,
    complete_attempts: verified.length,
    partial_attempts: names.filter((name) => name.endsWith(".partial")).length,
    gate_c_qualification_gate: false,
    maximum_total_usd: 3,
    maximum_provider_sessions: plan.body.maximum_provider_sessions,
    maximum_paid_sessions: plan.body.maximum_paid_sessions,
    maximum_generation_phases: plan.body.maximum_generation_phases,
    paid_retry_allowed: false,
    latest: verified.at(-1)?.body ?? null,
  });
}

function flags(args: readonly string[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || result[key] !== undefined) throw new Error("LC4 qualification v3 requires unique --flag value pairs");
    result[key] = value;
  }
  return freeze(result);
}

function exactFlags(actual: Readonly<Record<string, string>>, expected: readonly string[]): void {
  if (canonicalJson(Object.keys(actual).sort()) !== canonicalJson([...expected].sort())) throw new Error(`LC4 qualification v3 requires exactly ${[...expected].sort().join(", ")}`);
}

export async function runLc4QualificationV3Cli(args: readonly string[]): Promise<number> {
  try {
    const command = args[0];
    const parsed = flags(args.slice(1));
    if (command === "status") {
      exactFlags(parsed, []);
      process.stdout.write(`${canonicalJson({
        runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
        execution_authorized_by_source: false,
        execution_requires: "authority_signed_plan_and_authorization_plus_pinned_terminal_key",
        gate_a: "setup_acceptance",
        gate_b: "spoken_tool_roundtrip",
        gate_c: "diagnostic_only_not_qualification",
        maximum_total_usd: 3,
        maximum_provider_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PROVIDER_SESSIONS,
        maximum_paid_sessions: LC4_QUALIFICATION_V3_MAXIMUM_PAID_SESSIONS,
        maximum_generation_phases: LC4_QUALIFICATION_V3_MAXIMUM_GENERATION_PHASES,
        maximum_tool_roundtrips: LC4_QUALIFICATION_V3_MAXIMUM_TOOL_ROUNDTRIPS,
        paid_retry_allowed: false,
      })}\n`);
      return 0;
    }
    if (command === "prepare") {
      exactFlags(parsed, ["--root", "--repository-root", "--authority-private-key", "--trust-root-fingerprint"]);
      const artifact = await prepareLc4QualificationV3({
        root: parsed["--root"],
        repositoryRoot: parsed["--repository-root"],
        authorityPrivateKeyPem: await readFile(resolve(parsed["--authority-private-key"]), "utf8"),
        trustRootFingerprint: parsed["--trust-root-fingerprint"],
      });
      process.stdout.write(`${canonicalJson({ action: "lc4-qualification-v3-prepared", plan_artifact_sha256: artifact.artifact_sha256, provider_calls_made: 0 })}\n`);
      return 0;
    }
    if (command === "report") {
      exactFlags(parsed, ["--root", "--trust-root-fingerprint"]);
      process.stdout.write(`${canonicalJson(await reportLc4QualificationV3({ root: parsed["--root"], trustRootFingerprint: parsed["--trust-root-fingerprint"] }))}\n`);
      return 0;
    }
    if (command === "run") {
      exactFlags(parsed, ["--root", "--repository-root", "--authorization", "--trust-root-fingerprint", "--terminal-private-key", "--env-file"]);
      process.env.BENCHMARK_PROVIDER_ENV_FILE = resolve(parsed["--env-file"]);
      const terminal = await runLc4QualificationV3({
        root: parsed["--root"],
        repositoryRoot: parsed["--repository-root"],
        authorization: await readJson(resolve(parsed["--authorization"])),
        trustRootFingerprint: parsed["--trust-root-fingerprint"],
        terminalPrivateKeyPem: await readFile(resolve(parsed["--terminal-private-key"]), "utf8"),
      });
      process.stdout.write(`${canonicalJson({ action: "lc4-qualification-v3-retained", status: terminal.body.status, terminal_artifact_sha256: terminal.artifact_sha256 })}\n`);
      return terminal.body.status === "passed" ? 0 : 1;
    }
    throw new Error("usage: lc4-qualification-v3 <status|prepare|run|report>");
  } catch (error) {
    const message = error instanceof Error ? error.message : "LC4 qualification v3 failed";
    process.stderr.write(`${/api.?key|credential|bearer|token/iu.test(message) ? "LC4 qualification v3 failed at a credential boundary; no secret retained" : message}\n`);
    return 1;
  }
}

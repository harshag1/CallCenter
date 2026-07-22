import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, sha256Hex } from "./artifacts";
import {
  assertProviderQualificationArtifactIntegrity,
  providerQualificationMatrixSha256,
  qualifyProviders,
  XAI_MANUAL_TURN_SETTING_SHA256,
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
} from "./production-realtime-provider";
import { parseBenchmarkEnvironmentFile } from "./environment";
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
import type { NormalizedRealtimeClient, NormalizedRealtimeUsage, RealtimeWireObservation } from "../realtime/client/types";
import { verifyRealtimeWireObservationChain } from "../realtime/client/wire-evidence";
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
export const LC4_XAI_MANUAL_TURN_SETTING_SHA256 = XAI_MANUAL_TURN_SETTING_SHA256;

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
const INVOCATION_DOMAIN = "harshas-amazing-call-center/lc4-qualification-invocation/v3\n";
const INVOCATION_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-invocation-artifact/v3\n";
const REFUSAL_DOMAIN = "harshas-amazing-call-center/lc4-qualification-refusal/v3\n";
const REFUSAL_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-qualification-refusal-artifact/v3\n";
const REFUSAL_PACKAGE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-refusal-package/v3\n";
const REFUSAL_ERROR_DOMAIN = "harshas-amazing-call-center/lc4-qualification-refusal-error/v3\n";
const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const MAXIMUM_CREDENTIAL_ENV_BYTES = 1024 * 1024;

export type Lc4QualificationV3GitSource = Readonly<{
  source_commit: string;
  source_tree_oid: string;
  source_tree_sha256: string;
  worktree_clean: true;
}>;

export type Lc4QualificationV3CredentialFiles = Readonly<{
  providerEnvFile: string;
  repoEnvFile: string;
}>;

export type Lc4QualificationV3BoundaryStage =
  | "cli"
  | "plan"
  | "authorization"
  | "terminal_key"
  | "invocation"
  | "source"
  | "credentials";

export type Lc4QualificationV3BoundaryCode =
  | "cli_input_invalid"
  | "plan_validation_failed"
  | "authorization_validation_failed"
  | "terminal_key_validation_failed"
  | "authorization_already_invoked"
  | "invocation_retention_failed"
  | "source_inspection_failed"
  | "source_mismatch"
  | "credential_source_invalid"
  | "credential_missing"
  | "credential_set_mismatch"
  | "refusal_retention_failed"
  | "unexpected_failure";

export class Lc4QualificationV3BoundaryError extends Error {
  readonly stage: Lc4QualificationV3BoundaryStage;
  readonly code: Lc4QualificationV3BoundaryCode;

  constructor(stage: Lc4QualificationV3BoundaryStage, code: Lc4QualificationV3BoundaryCode) {
    super(`LC4 qualification v3 boundary refusal: ${stage}:${code}`);
    this.name = "Lc4QualificationV3BoundaryError";
    this.stage = stage;
    this.code = code;
  }
}

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

export type Lc4QualificationV3InvocationBody = Readonly<{
  schema_version: 1;
  invocation_version: "HACC-LC4-QUALIFICATION-INVOCATION-v3";
  attempt_id: string;
  invoked_at: string;
  plan_artifact_sha256: string;
  plan_sha256: string;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  authorization_artifact_sha256: string;
  authorization_nonce_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  credential_set_sha256: string;
  terminal_public_key_fingerprint_sha256: string;
  trust_root_fingerprint_sha256: string;
  authorization_consumed: true;
}>;

export type Lc4QualificationV3InvocationArtifact = SignedArtifact<Lc4QualificationV3InvocationBody>;

export type Lc4QualificationV3RefusalBody = Readonly<{
  schema_version: 1;
  refusal_version: "HACC-LC4-QUALIFICATION-REFUSAL-v3";
  attempt_id: string;
  refused_at: string;
  stage: "source" | "credentials";
  code:
    | "source_inspection_failed"
    | "source_mismatch"
    | "credential_source_invalid"
    | "credential_missing"
    | "credential_set_mismatch";
  error_sha256: string;
  invocation_artifact_sha256: string;
  plan_artifact_sha256: string;
  plan_sha256: string;
  authorization_artifact_sha256: string;
  planned_source_tree_sha256: string;
  observed_source_tree_sha256: string | null;
  planned_credential_set_sha256: string;
  observed_credential_set_sha256: string | null;
  budget_reservation_created: false;
  budget_ledger_mutated: false;
  provider_clients_constructed: 0;
  provider_calls_made: 0;
}>;

export type Lc4QualificationV3RefusalPackage = Readonly<{
  schema_version: 1;
  package_version: "HACC-LC4-QUALIFICATION-REFUSAL-PACKAGE-v3";
  authorization: Lc4QualificationV3AuthorizationArtifact;
  refusal: SignedArtifact<Lc4QualificationV3RefusalBody>;
  package_sha256: string;
}>;

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
  manual_turn_mode_qualification: Readonly<{
    provider: "xai";
    requested_setting_sha256: string;
    gate_a_classification: "verified_by_provider_echo" | "acknowledged_unverifiable_manual_turn" | "failed";
    retained_risk: "none" | "provider_omitted_turn_detection_type";
    gate_b_required: boolean;
    gate_b_status: "behaviorally_verified" | "failed" | "not_run";
    gate_b_evidence_sha256: string | null;
    benchmark_ready: boolean;
  }>;
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
  loadCredentials: async () => {
    throw new Lc4QualificationV3BoundaryError("credentials", "credential_source_invalid");
  },
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

function boundaryError(
  stage: Lc4QualificationV3BoundaryStage,
  code: Lc4QualificationV3BoundaryCode,
): Lc4QualificationV3BoundaryError {
  return new Lc4QualificationV3BoundaryError(stage, code);
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

async function readJsonLines<T>(path: string): Promise<readonly T[]> {
  const text = await readFile(path, "utf8");
  if (text.length > 0 && !text.endsWith("\n")) throw new Error("LC4 qualification JSONL is not newline terminated");
  return freeze(text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T));
}

type RetainedRoundtripSummary = Omit<Lc4S2sRoundtripExecution, "wire_observations" | "usage"> & Readonly<{
  wire_observation_count: number;
  usage_event_count: number;
}>;

function assertRetainedXaiManualTurnEvidence(input: Readonly<{
  summary: RetainedRoundtripSummary;
  wire: readonly RealtimeWireObservation[];
  terminalResult: Lc4QualificationV3TerminalBody["results"][number];
  gateEvidenceSha256: string | null;
}>): void {
  const { summary, wire, terminalResult } = input;
  if (summary.provider !== "xai"
    || summary.status !== "passed"
    || summary.failure_class !== "none"
    || summary.evidence_sha256 !== terminalResult.evidence_sha256
    || summary.evidence_sha256 !== input.gateEvidenceSha256
    || summary.wire_observation_count !== wire.length
    || summary.wire_observation_count !== terminalResult.wire_observation_count
    || !verifyRealtimeWireObservationChain(wire).valid) {
    throw new Error("LC4 qualification retained xAI roundtrip binding failed integrity");
  }
  const commitIndex = wire.findIndex((observation) => observation.direction === "inbound"
    && observation.wireType === "input_audio_buffer.committed"
    && observation.observationSha256 === summary.manual_turn_commit_observation_sha256);
  const triggerIndex = wire.findIndex((observation) => observation.direction === "outbound"
    && observation.wireType === "response.create"
    && observation.observationSha256 === summary.response_trigger_observation_sha256);
  const forbiddenBeforeTrigger = wire.slice(0, triggerIndex < 0 ? undefined : triggerIndex)
    .some((observation) => observation.direction === "inbound" && (
      observation.wireType === "input_audio_buffer.speech_started"
      || observation.wireType === "input_audio_buffer.speech_stopped"
      || observation.wireType.startsWith("response.")
    ));
  const commitOperation = summary.operation_order.indexOf("caller_audio_commit_acknowledged");
  const responseOperation = summary.operation_order.indexOf("response_generation_requested");
  if (commitIndex < 0
    || triggerIndex <= commitIndex
    || forbiddenBeforeTrigger
    || commitOperation < 0
    || responseOperation <= commitOperation) {
    throw new Error("LC4 qualification retained xAI manual-turn order failed integrity");
  }
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

const CREDENTIAL_ENV_NAMES = Object.freeze({
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
} as const);

async function readExplicitCredentialEnvironment(path: string): Promise<Readonly<{
  device: number;
  inode: number;
  values: NodeJS.Dict<string>;
}>> {
  if (!isAbsolute(path)) throw boundaryError("credentials", "credential_source_invalid");
  const normalized = resolve(path);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(normalized);
  } catch {
    throw boundaryError("credentials", "credential_source_invalid");
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw boundaryError("credentials", "credential_source_invalid");
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(normalized, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size <= 0
      || opened.size > MAXIMUM_CREDENTIAL_ENV_BYTES) {
      throw boundaryError("credentials", "credential_source_invalid");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== opened.size
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      throw boundaryError("credentials", "credential_source_invalid");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = parseBenchmarkEnvironmentFile(text);
    const values: NodeJS.Dict<string> = Object.create(null);
    for (const name of Object.values(CREDENTIAL_ENV_NAMES)) {
      if (Object.hasOwn(parsed, name)) values[name] = parsed[name];
    }
    return freeze({
      device: opened.dev,
      inode: opened.ino,
      values,
    });
  } catch (error) {
    if (error instanceof Lc4QualificationV3BoundaryError) throw error;
    throw boundaryError("credentials", "credential_source_invalid");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Load only the two operator-selected files. The repository file is applied
 * last, matching the frozen LC4 operator command, while ambient process state
 * and checkout-local dotenv files are deliberately ignored.
 */
export async function loadLc4QualificationV3ExplicitCredentials(
  files: Lc4QualificationV3CredentialFiles,
): Promise<Readonly<Record<LiveStsProvider, string>>> {
  if (!isAbsolute(files.providerEnvFile) || !isAbsolute(files.repoEnvFile)) {
    throw boundaryError("credentials", "credential_source_invalid");
  }
  const providerPath = resolve(files.providerEnvFile);
  const repoPath = resolve(files.repoEnvFile);
  if (providerPath === repoPath) throw boundaryError("credentials", "credential_source_invalid");
  const [providerSource, repoSource] = await Promise.all([
    readExplicitCredentialEnvironment(providerPath),
    readExplicitCredentialEnvironment(repoPath),
  ]);
  if (providerSource.device === repoSource.device && providerSource.inode === repoSource.inode) {
    throw boundaryError("credentials", "credential_source_invalid");
  }
  const merged = Object.assign(Object.create(null) as Record<string, string | undefined>, providerSource.values, repoSource.values);
  const credentials = {} as Record<LiveStsProvider, string>;
  for (const provider of LC4_QUALIFICATION_V3_PROVIDER_ORDER) {
    const value = merged[CREDENTIAL_ENV_NAMES[provider]];
    if (typeof value !== "string"
      || value.length < 12
      || value !== value.trim()
      || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw boundaryError("credentials", "credential_missing");
    }
    credentials[provider] = value;
  }
  return freeze(credentials);
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
  credentialFiles?: Lc4QualificationV3CredentialFiles;
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
    input.credentialFiles
      ? loadLc4QualificationV3ExplicitCredentials(input.credentialFiles)
      : dependencies.loadCredentials(repositoryRoot),
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

function createInvocationArtifact(input: Readonly<{
  plan: Lc4QualificationV3PlanArtifact;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  trustRootFingerprint: string;
  terminalPrivateKeyPem: string;
  invokedAt: string;
}>): Lc4QualificationV3InvocationArtifact {
  const body: Lc4QualificationV3InvocationBody = freeze({
    schema_version: 1 as const,
    invocation_version: "HACC-LC4-QUALIFICATION-INVOCATION-v3" as const,
    attempt_id: input.authorization.body.authorization_id,
    invoked_at: input.invokedAt,
    plan_artifact_sha256: input.plan.artifact_sha256,
    plan_sha256: input.plan.body.plan_sha256,
    authorization: input.authorization,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    authorization_nonce_sha256: input.authorization.body.authorization_nonce_sha256,
    source_commit: input.plan.body.source.source_commit,
    source_tree_sha256: input.plan.body.source.source_tree_sha256,
    credential_set_sha256: input.plan.body.credential_set_sha256,
    terminal_public_key_fingerprint_sha256: input.authorization.body.terminal_public_key_fingerprint_sha256,
    trust_root_fingerprint_sha256: input.trustRootFingerprint,
    authorization_consumed: true as const,
  });
  return signedArtifact({
    body,
    privateKeyPem: input.terminalPrivateKeyPem,
    signingDomain: INVOCATION_DOMAIN,
    artifactDomain: INVOCATION_ARTIFACT_DOMAIN,
  });
}

function assertInvocationArtifact(
  artifact: Lc4QualificationV3InvocationArtifact,
  plan: Lc4QualificationV3PlanArtifact,
  authorization: Lc4QualificationV3AuthorizationArtifact,
  trustRootFingerprint: string,
): void {
  assertSignedArtifact({
    artifact,
    expectedFingerprint: authorization.body.terminal_public_key_fingerprint_sha256,
    signingDomain: INVOCATION_DOMAIN,
    artifactDomain: INVOCATION_ARTIFACT_DOMAIN,
  });
  const body = artifact.body;
  if (body.schema_version !== 1
    || body.invocation_version !== "HACC-LC4-QUALIFICATION-INVOCATION-v3"
    || body.authorization_consumed !== true
    || body.attempt_id !== authorization.body.authorization_id
    || body.plan_artifact_sha256 !== plan.artifact_sha256
    || body.plan_sha256 !== plan.body.plan_sha256
    || canonicalJson(body.authorization) !== canonicalJson(authorization)
    || body.authorization_artifact_sha256 !== authorization.artifact_sha256
    || body.authorization_nonce_sha256 !== authorization.body.authorization_nonce_sha256
    || body.source_commit !== plan.body.source.source_commit
    || body.source_tree_sha256 !== plan.body.source.source_tree_sha256
    || body.credential_set_sha256 !== plan.body.credential_set_sha256
    || body.terminal_public_key_fingerprint_sha256 !== authorization.body.terminal_public_key_fingerprint_sha256
    || body.trust_root_fingerprint_sha256 !== trustRootFingerprint) {
    throw boundaryError("invocation", "authorization_already_invoked");
  }
  requireIso(body.invoked_at, "LC4 qualification v3 invocation time");
}

async function writeInvocationTombstone(
  attemptsRoot: string,
  artifact: Lc4QualificationV3InvocationArtifact,
): Promise<void> {
  try {
    const rootMetadata = await lstat(dirname(attemptsRoot));
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("unsafe evidence root");
    try {
      await mkdir(attemptsRoot, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = await lstat(attemptsRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("unsafe attempts root");
    await writeImmutableJson(resolve(attemptsRoot, `${artifact.body.attempt_id}.invoked.json`), artifact);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw boundaryError("invocation", "authorization_already_invoked");
    }
    throw boundaryError("invocation", "invocation_retention_failed");
  }
}

function refusalErrorSha256(
  authorization: Lc4QualificationV3AuthorizationArtifact,
  stage: "source" | "credentials",
  code: Lc4QualificationV3RefusalBody["code"],
): string {
  return sha256Hex(`${REFUSAL_ERROR_DOMAIN}${canonicalJson({
    authorization_nonce_sha256: authorization.body.authorization_nonce_sha256,
    stage,
    code,
  })}`);
}

async function retainPreProviderRefusal(input: Readonly<{
  attemptsRoot: string;
  plan: Lc4QualificationV3PlanArtifact;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  terminalPrivateKeyPem: string;
  invocation: Lc4QualificationV3InvocationArtifact;
  stage: "source" | "credentials";
  code: Lc4QualificationV3RefusalBody["code"];
  refusedAt: string;
  observedSourceTreeSha256: string | null;
  observedCredentialSetSha256: string | null;
}>): Promise<Lc4QualificationV3RefusalPackage> {
  const body: Lc4QualificationV3RefusalBody = freeze({
    schema_version: 1,
    refusal_version: "HACC-LC4-QUALIFICATION-REFUSAL-v3",
    attempt_id: input.authorization.body.authorization_id,
    refused_at: input.refusedAt,
    stage: input.stage,
    code: input.code,
    error_sha256: refusalErrorSha256(input.authorization, input.stage, input.code),
    invocation_artifact_sha256: input.invocation.artifact_sha256,
    plan_artifact_sha256: input.plan.artifact_sha256,
    plan_sha256: input.plan.body.plan_sha256,
    authorization_artifact_sha256: input.authorization.artifact_sha256,
    planned_source_tree_sha256: input.plan.body.source.source_tree_sha256,
    observed_source_tree_sha256: input.observedSourceTreeSha256,
    planned_credential_set_sha256: input.plan.body.credential_set_sha256,
    observed_credential_set_sha256: input.observedCredentialSetSha256,
    budget_reservation_created: false,
    budget_ledger_mutated: false,
    provider_clients_constructed: 0,
    provider_calls_made: 0,
  });
  const refusal = signedArtifact({
    body,
    privateKeyPem: input.terminalPrivateKeyPem,
    signingDomain: REFUSAL_DOMAIN,
    artifactDomain: REFUSAL_ARTIFACT_DOMAIN,
  });
  const packageBody = freeze({
    schema_version: 1 as const,
    package_version: "HACC-LC4-QUALIFICATION-REFUSAL-PACKAGE-v3" as const,
    authorization: input.authorization,
    refusal,
  });
  const artifact = freeze({
    ...packageBody,
    package_sha256: sha256Hex(`${REFUSAL_PACKAGE_DOMAIN}${canonicalJson(packageBody)}`),
  });
  try {
    await writeImmutableJson(resolve(input.attemptsRoot, `${body.attempt_id}.refusal.json`), artifact);
  } catch {
    throw boundaryError(input.stage, "refusal_retention_failed");
  }
  return artifact;
}

function assertRefusalPackage(input: Readonly<{
  artifact: Lc4QualificationV3RefusalPackage;
  invocation: Lc4QualificationV3InvocationArtifact;
  plan: Lc4QualificationV3PlanArtifact;
  trustRootFingerprint: string;
}>): void {
  const { package_sha256, ...packageBody } = input.artifact;
  if (input.artifact.schema_version !== 1
    || input.artifact.package_version !== "HACC-LC4-QUALIFICATION-REFUSAL-PACKAGE-v3"
    || package_sha256 !== sha256Hex(`${REFUSAL_PACKAGE_DOMAIN}${canonicalJson(packageBody)}`)) {
    throw new Error("LC4 qualification v3 refusal package failed integrity");
  }
  assertSignedArtifact({
    artifact: input.artifact.authorization,
    expectedFingerprint: input.trustRootFingerprint,
    signingDomain: AUTHORIZATION_DOMAIN,
    artifactDomain: AUTHORIZATION_ARTIFACT_DOMAIN,
  });
  const authorization = input.artifact.authorization;
  assertInvocationArtifact(input.invocation, input.plan, authorization, input.trustRootFingerprint);
  assertSignedArtifact({
    artifact: input.artifact.refusal,
    expectedFingerprint: authorization.body.terminal_public_key_fingerprint_sha256,
    signingDomain: REFUSAL_DOMAIN,
    artifactDomain: REFUSAL_ARTIFACT_DOMAIN,
  });
  const body = input.artifact.refusal.body;
  if (authorization.body.plan_artifact_sha256 !== input.plan.artifact_sha256
    || authorization.body.plan_sha256 !== input.plan.body.plan_sha256
    || body.attempt_id !== authorization.body.authorization_id
    || body.invocation_artifact_sha256 !== input.invocation.artifact_sha256
    || body.plan_artifact_sha256 !== input.plan.artifact_sha256
    || body.plan_sha256 !== input.plan.body.plan_sha256
    || body.authorization_artifact_sha256 !== authorization.artifact_sha256
    || body.planned_source_tree_sha256 !== input.plan.body.source.source_tree_sha256
    || body.planned_credential_set_sha256 !== input.plan.body.credential_set_sha256
    || body.error_sha256 !== refusalErrorSha256(authorization, body.stage, body.code)
    || body.budget_reservation_created !== false
    || body.budget_ledger_mutated !== false
    || body.provider_clients_constructed !== 0
    || body.provider_calls_made !== 0) {
    throw new Error("LC4 qualification v3 refusal binding failed integrity");
  }
  requireIso(body.refused_at, "LC4 qualification v3 refusal time");
}

export async function runLc4QualificationV3(input: Readonly<{
  root: string;
  repositoryRoot: string;
  credentialFiles?: Lc4QualificationV3CredentialFiles;
  authorization: Lc4QualificationV3AuthorizationArtifact;
  trustRootFingerprint: string;
  terminalPrivateKeyPem: string;
  now?: () => Date;
  dependencies?: Dependencies;
}>): Promise<Lc4QualificationV3TerminalArtifact> {
  const root = resolve(input.root);
  const repositoryRoot = resolve(input.repositoryRoot);
  let plan: Lc4QualificationV3PlanArtifact;
  try {
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("invalid root");
    plan = await readJson<Lc4QualificationV3PlanArtifact>(resolve(root, "lc4-qualification-v3-plan.json"));
    assertLc4QualificationV3PlanArtifact(plan, input.trustRootFingerprint);
  } catch {
    throw boundaryError("plan", "plan_validation_failed");
  }
  const now = input.now ?? (() => new Date());
  const validatedAt = now();
  try {
    assertLc4QualificationV3Authorization({
      artifact: input.authorization,
      plan,
      trustRootFingerprint: input.trustRootFingerprint,
      now: validatedAt,
    });
  } catch {
    throw boundaryError("authorization", "authorization_validation_failed");
  }
  try {
    const terminalKey = keyIdentity(input.terminalPrivateKeyPem);
    if (terminalKey.fingerprint !== input.authorization.body.terminal_public_key_fingerprint_sha256) {
      throw new Error("terminal key differs from authorization");
    }
  } catch {
    throw boundaryError("terminal_key", "terminal_key_validation_failed");
  }
  const attemptId = input.authorization.body.authorization_id;
  const attemptsRoot = resolve(root, "attempts");
  const partial = resolve(attemptsRoot, `${attemptId}.partial`);
  const complete = resolve(attemptsRoot, `${attemptId}.complete`);
  const invocation = createInvocationArtifact({
    plan,
    authorization: input.authorization,
    trustRootFingerprint: input.trustRootFingerprint,
    terminalPrivateKeyPem: input.terminalPrivateKeyPem,
    invokedAt: validatedAt.toISOString(),
  });
  await writeInvocationTombstone(attemptsRoot, invocation);

  const dependencies = input.dependencies ?? defaultDependencies;
  let source: Lc4QualificationV3GitSource;
  try {
    source = await dependencies.inspectGitSource(repositoryRoot);
  } catch {
    const refusal = boundaryError("source", "source_inspection_failed");
    await retainPreProviderRefusal({
      attemptsRoot,
      plan,
      authorization: input.authorization,
      terminalPrivateKeyPem: input.terminalPrivateKeyPem,
      invocation,
      stage: "source",
      code: "source_inspection_failed",
      refusedAt: now().toISOString(),
      observedSourceTreeSha256: null,
      observedCredentialSetSha256: null,
    });
    throw refusal;
  }
  if (canonicalJson(source) !== canonicalJson(plan.body.source)) {
    await retainPreProviderRefusal({
      attemptsRoot,
      plan,
      authorization: input.authorization,
      terminalPrivateKeyPem: input.terminalPrivateKeyPem,
      invocation,
      stage: "source",
      code: "source_mismatch",
      refusedAt: now().toISOString(),
      observedSourceTreeSha256: source.source_tree_sha256,
      observedCredentialSetSha256: null,
    });
    throw boundaryError("source", "source_mismatch");
  }

  let credentials: Readonly<Record<LiveStsProvider, string>>;
  try {
    credentials = input.credentialFiles
      ? await loadLc4QualificationV3ExplicitCredentials(input.credentialFiles)
      : await dependencies.loadCredentials(repositoryRoot);
  } catch (error) {
    const code = error instanceof Lc4QualificationV3BoundaryError
      && (error.code === "credential_missing" || error.code === "credential_source_invalid")
      ? error.code
      : "credential_source_invalid";
    await retainPreProviderRefusal({
      attemptsRoot,
      plan,
      authorization: input.authorization,
      terminalPrivateKeyPem: input.terminalPrivateKeyPem,
      invocation,
      stage: "credentials",
      code,
      refusedAt: now().toISOString(),
      observedSourceTreeSha256: source.source_tree_sha256,
      observedCredentialSetSha256: null,
    });
    throw boundaryError("credentials", code);
  }
  let observedCredentialSetSha256: string;
  try {
    observedCredentialSetSha256 = credentialSetSha256(credentials);
  } catch {
    await retainPreProviderRefusal({
      attemptsRoot,
      plan,
      authorization: input.authorization,
      terminalPrivateKeyPem: input.terminalPrivateKeyPem,
      invocation,
      stage: "credentials",
      code: "credential_missing",
      refusedAt: now().toISOString(),
      observedSourceTreeSha256: source.source_tree_sha256,
      observedCredentialSetSha256: null,
    });
    throw boundaryError("credentials", "credential_missing");
  }
  if (observedCredentialSetSha256 !== plan.body.credential_set_sha256) {
    await retainPreProviderRefusal({
      attemptsRoot,
      plan,
      authorization: input.authorization,
      terminalPrivateKeyPem: input.terminalPrivateKeyPem,
      invocation,
      stage: "credentials",
      code: "credential_set_mismatch",
      refusedAt: now().toISOString(),
      observedSourceTreeSha256: source.source_tree_sha256,
      observedCredentialSetSha256,
    });
    throw boundaryError("credentials", "credential_set_mismatch");
  }
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
  const xaiSetup = setupArtifact!.results.find((result) => result.provider === "xai");
  const xaiExecution = executions.find((execution) => execution.provider === "xai");
  const xaiGateAClassification = xaiSetup?.manualTurnModeVerification === "verified_by_provider_echo"
    ? "verified_by_provider_echo" as const
    : xaiSetup?.code === "acknowledged_unverifiable_manual_turn"
      ? "acknowledged_unverifiable_manual_turn" as const
      : "failed" as const;
  const xaiGateBStatus = xaiExecution === undefined
    ? "not_run" as const
    : xaiExecution.status === "passed"
      ? "behaviorally_verified" as const
      : "failed" as const;
  const manualTurnModeQualification = freeze({
    provider: "xai" as const,
    requested_setting_sha256: LC4_XAI_MANUAL_TURN_SETTING_SHA256,
    gate_a_classification: xaiGateAClassification,
    retained_risk: xaiGateAClassification === "acknowledged_unverifiable_manual_turn"
      ? "provider_omitted_turn_detection_type" as const
      : "none" as const,
    gate_b_required: xaiGateAClassification === "acknowledged_unverifiable_manual_turn",
    gate_b_status: xaiGateBStatus,
    gate_b_evidence_sha256: xaiExecution?.evidence_sha256 ?? null,
    benchmark_ready: xaiGateAClassification !== "failed" && xaiGateBStatus === "behaviorally_verified",
  });
  if (xaiGateAClassification === "acknowledged_unverifiable_manual_turn"
    && xaiGateBStatus !== "behaviorally_verified") {
    primaryFailure ??= `xai:manual_turn_behavioral_verification_${xaiGateBStatus}`;
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
    manual_turn_mode_qualification: manualTurnModeQualification,
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
  const invocationNames = names.filter((name) => name.endsWith(".invoked.json")).sort();
  const refusalNames = names.filter((name) => name.endsWith(".refusal.json")).sort();
  const completeNames = names.filter((name) => name.endsWith(".complete")).sort();
  const partialNames = names.filter((name) => name.endsWith(".partial")).sort();
  const recognizedNames = new Set([...invocationNames, ...refusalNames, ...completeNames, ...partialNames]);
  if (recognizedNames.size !== names.length) throw new Error("LC4 qualification v3 attempts root contains an unknown entry");

  const invocations = new Map<string, Lc4QualificationV3InvocationArtifact>();
  for (const name of invocationNames) {
    const attemptId = name.slice(0, -".invoked.json".length);
    const invocation = await readJson<Lc4QualificationV3InvocationArtifact>(resolve(attemptsRoot, name));
    const authorization = invocation.body.authorization;
    assertSignedArtifact({
      artifact: authorization,
      expectedFingerprint: input.trustRootFingerprint,
      signingDomain: AUTHORIZATION_DOMAIN,
      artifactDomain: AUTHORIZATION_ARTIFACT_DOMAIN,
    });
    assertInvocationArtifact(invocation, plan, authorization, input.trustRootFingerprint);
    if (invocation.body.attempt_id !== attemptId || invocations.has(attemptId)) {
      throw new Error("LC4 qualification v3 invocation filename is not canonical");
    }
    invocations.set(attemptId, invocation);
  }

  const refusals = new Map<string, Lc4QualificationV3RefusalPackage>();
  for (const name of refusalNames) {
    const attemptId = name.slice(0, -".refusal.json".length);
    const invocation = invocations.get(attemptId);
    if (!invocation) throw new Error("LC4 qualification v3 refusal lacks an invocation tombstone");
    const refusal = await readJson<Lc4QualificationV3RefusalPackage>(resolve(attemptsRoot, name));
    assertRefusalPackage({
      artifact: refusal,
      invocation,
      plan,
      trustRootFingerprint: input.trustRootFingerprint,
    });
    if (refusal.refusal.body.attempt_id !== attemptId || refusals.has(attemptId)) {
      throw new Error("LC4 qualification v3 refusal filename is not canonical");
    }
    refusals.set(attemptId, refusal);
  }

  const verified: Lc4QualificationV3TerminalArtifact[] = [];
  const completeIds = new Set<string>();
  for (const name of completeNames) {
    const attemptId = name.slice(0, -".complete".length);
    const invocation = invocations.get(attemptId);
    if (!invocation || refusals.has(attemptId) || completeIds.has(attemptId)) {
      throw new Error("LC4 qualification v3 complete attempt has an invalid invocation state");
    }
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
    assertInvocationArtifact(invocation, plan, authorization, input.trustRootFingerprint);
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
    const xaiResult = terminal.body.results.find((result) => result.provider === "xai");
    const manualTurn = terminal.body.manual_turn_mode_qualification;
    const expectedManualReady = manualTurn.gate_a_classification !== "failed"
      && manualTurn.gate_b_status === "behaviorally_verified"
      && xaiResult?.status === "passed"
      && manualTurn.gate_b_evidence_sha256 === xaiResult.evidence_sha256;
    if (manualTurn.provider !== "xai"
      || manualTurn.requested_setting_sha256 !== LC4_XAI_MANUAL_TURN_SETTING_SHA256
      || manualTurn.gate_b_required !== (manualTurn.gate_a_classification === "acknowledged_unverifiable_manual_turn")
      || manualTurn.retained_risk !== (manualTurn.gate_a_classification === "acknowledged_unverifiable_manual_turn"
        ? "provider_omitted_turn_detection_type"
        : "none")
      || manualTurn.benchmark_ready !== expectedManualReady
      || (terminal.body.status === "passed" && !manualTurn.benchmark_ready)) {
      throw new Error("LC4 qualification v3 manual-turn promotion binding failed integrity");
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
    const setupQualification = await readJson<ProviderQualificationArtifact>(resolve(directory, "setup-acceptance.json"));
    assertProviderQualificationArtifactIntegrity(setupQualification);
    const retainedXaiSetup = setupQualification.results.find((result) => result.provider === "xai");
    if (setupQualification.artifactSha256 !== terminal.body.setup_qualification_artifact_sha256
      || retainedXaiSetup === undefined
      || manualTurn.gate_a_classification !== (retainedXaiSetup.manualTurnModeVerification === "verified_by_provider_echo"
        ? "verified_by_provider_echo"
        : retainedXaiSetup.code === "acknowledged_unverifiable_manual_turn"
          ? "acknowledged_unverifiable_manual_turn"
          : "failed")) {
      throw new Error("LC4 qualification retained xAI setup binding failed integrity");
    }
    if (manualTurn.benchmark_ready) {
      if (!xaiResult) throw new Error("LC4 qualification terminal lacks xAI result");
      const [xaiSummary, xaiWire] = await Promise.all([
        readJson<RetainedRoundtripSummary>(resolve(directory, "xai-spoken-roundtrip.json")),
        readJsonLines<RealtimeWireObservation>(resolve(directory, "xai-spoken-roundtrip-wire.jsonl")),
      ]);
      assertRetainedXaiManualTurnEvidence({
        summary: xaiSummary,
        wire: xaiWire,
        terminalResult: xaiResult,
        gateEvidenceSha256: manualTurn.gate_b_evidence_sha256,
      });
    }
    const budgetEvidence = await readJson<Lc4QualificationBudgetEvidence>(resolve(directory, "budget-settlement.json"));
    assertLc4QualificationBudgetEvidence(budgetEvidence);
    if (budgetEvidence.evidence_sha256 !== terminal.body.budget_evidence_sha256
      || budgetEvidence.final_head_sha256 !== terminal.body.budget_final_head_sha256) {
      throw new Error("LC4 qualification v3 terminal budget binding failed integrity");
    }
    completeIds.add(attemptId);
    verified.push(terminal);
  }
  const partialIds = new Set(partialNames.map((name) => name.slice(0, -".partial".length)));
  for (const attemptId of partialIds) {
    if (!invocations.has(attemptId) || refusals.has(attemptId) || completeIds.has(attemptId)) {
      throw new Error("LC4 qualification v3 partial attempt has an invalid invocation state");
    }
  }
  const strandedInvocationIds = [...invocations.keys()].filter((attemptId) =>
    !refusals.has(attemptId) && !completeIds.has(attemptId) && !partialIds.has(attemptId));
  return freeze({
    schema_version: 1,
    runner_version: LC4_QUALIFICATION_V3_RUNNER_VERSION,
    plan_artifact_sha256: plan.artifact_sha256,
    source_commit: plan.body.source.source_commit,
    invoked_attempts: invocations.size,
    refused_attempts: refusals.size,
    stranded_invocations: strandedInvocationIds.length,
    complete_attempts: verified.length,
    partial_attempts: partialIds.size,
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
      exactFlags(parsed, [
        "--root",
        "--repository-root",
        "--authority-private-key",
        "--trust-root-fingerprint",
        "--provider-env-file",
        "--repo-env-file",
      ]);
      const artifact = await prepareLc4QualificationV3({
        root: parsed["--root"],
        repositoryRoot: parsed["--repository-root"],
        credentialFiles: {
          providerEnvFile: parsed["--provider-env-file"],
          repoEnvFile: parsed["--repo-env-file"],
        },
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
      exactFlags(parsed, [
        "--root",
        "--repository-root",
        "--authorization",
        "--trust-root-fingerprint",
        "--terminal-private-key",
        "--provider-env-file",
        "--repo-env-file",
      ]);
      const terminal = await runLc4QualificationV3({
        root: parsed["--root"],
        repositoryRoot: parsed["--repository-root"],
        credentialFiles: {
          providerEnvFile: parsed["--provider-env-file"],
          repoEnvFile: parsed["--repo-env-file"],
        },
        authorization: await readJson(resolve(parsed["--authorization"])),
        trustRootFingerprint: parsed["--trust-root-fingerprint"],
        terminalPrivateKeyPem: await readFile(resolve(parsed["--terminal-private-key"]), "utf8"),
      });
      process.stdout.write(`${canonicalJson({ action: "lc4-qualification-v3-retained", status: terminal.body.status, terminal_artifact_sha256: terminal.artifact_sha256 })}\n`);
      return terminal.body.status === "passed" ? 0 : 1;
    }
    throw new Error("usage: lc4-qualification-v3 <status|prepare|run|report>");
  } catch (error) {
    const boundary = error instanceof Lc4QualificationV3BoundaryError
      ? error
      : boundaryError("cli", "cli_input_invalid");
    process.stderr.write(`${canonicalJson({
      error: "lc4_qualification_v3_refused",
      stage: boundary.stage,
      code: boundary.code,
      secrets_retained: false,
    })}\n`);
    return 1;
  }
}

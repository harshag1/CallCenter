import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalJson, sha256Hex } from "./artifacts";
import {
  assertLc4DevAudioArtifacts,
  createLc4DevCallerAudioLoader,
  type Lc4DevAudioManifest,
  type Lc4DevRepairAudioManifest,
} from "./lc4-development-audio-materializer";
import {
  LC4_DEV_LIVE_HARD_CEILING_MICRO_USD,
  assertLc4DevLivePreflightArtifact,
  assertLc4DevLivePrepareArtifact,
  createLc4DevLivePreflightArtifact,
  createLc4DevLivePrepareArtifact,
  createLc4DevLiveReportArtifact,
  executeLc4DevLiveRun,
  lc4DevLiveAuthorizationArtifactSha256,
  lc4DevLiveAuthorizationSigningBytes,
  type Lc4DevLiveAuthorizationArtifact,
  type Lc4DevLiveAuthorizationBody,
  type Lc4DevLivePreflightArtifact,
  type Lc4DevLivePrepareArtifact,
  type Lc4DevLiveRunArtifact,
  type Lc4DevRetainedQualificationReceipt,
} from "./lc4-development-live-runner";
import {
  replayLc4DevAuthorityReport,
  type Lc4DevLiveDependencyBundle,
} from "./lc4-development-live-dependencies";
import {
  inspectLc4QualificationGitSource,
  type Lc4QualificationGitSource,
} from "./lc4-qualification-runner";
import { lc4DevCredentialIdentitySetSha256 } from "./lc4-production-provider-adapter";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import { loadLc4DevRetainedQualificationV3 } from "./lc4-development-qualification-v3";
import {
  createLc4DevelopmentDefaultOperatorRuntime,
  type Lc4DevDefaultRuntimeConfig,
} from "./lc4-development-default-runtime";
import {
  Lc4DevBudgetLifecycle,
  assertLc4DevRunPackage,
  createLc4DevRunPackage,
  finalizeLc4DevRunBudget,
  replayLc4DevBudgetEvidence,
  reserveLc4DevRunBudget,
  type Lc4DevBudgetEvidence,
  type Lc4DevRunLease,
  type Lc4DevRunPackage,
} from "./lc4-development-budget";
import {
  LC4_DEV_OPERATOR_VERSION,
  lc4DevSharedAuthorizationBindingSha256,
  lc4DevSharedLedgerGenesisSha256,
} from "./lc4-development-operator-contract";

export { LC4_DEV_OPERATOR_VERSION } from "./lc4-development-operator-contract";

const PROVIDERS = Object.freeze(["openai", "gemini", "xai"] as const);
const QUALIFICATION_CREDENTIAL_DOMAIN = "harshas-amazing-call-center/provider-credential/v1\n";
const QUALIFICATION_CREDENTIAL_SET_DOMAIN = "harshas-amazing-call-center/provider-credential-set/v1\n";
const OPERATOR_INTENT_DOMAIN = "harshas-amazing-call-center/lc4-dev-operator-intent/v1\n";
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_ENV_BYTES = 1024 * 1024;
const MAX_KEY_BYTES = 64 * 1024;

export const LC4_DEV_OPERATOR_FILENAMES = Object.freeze({
  intent: "operator-intent.json",
  prepare: "prepare.json",
  authorization: "authorization.json",
  preflight: "preflight.json",
  run: "run.json",
  budget_lease: "budget-run-lease.json",
  budget_evidence: "budget-terminal-evidence.json",
  run_package: "run-package.json",
  report: "report.json",
  ledger: "ledger.jsonl",
  cas: "cas",
});

type Io = Readonly<{
  stdout(value: string): void;
  stderr(value: string): void;
  now(): Date;
}>;

export type Lc4DevOperatorSigner = Readonly<{
  private_key: KeyObject;
  public_key_spki_der: Buffer;
  public_key_spki_pem: string;
  private_key_pkcs8_pem: string;
  public_key_fingerprint_sha256: string;
}>;

export type Lc4DevOperatorRuntimeRoots = Readonly<{
  control_plane_manifest_sha256: string;
  listener_evidence_manifest_sha256: string;
  runtime_config_sha256: string;
  asr_evaluator_build_sha256: string;
  asr_evaluator_toolchain_sha256: string;
}>;

/**
 * This is the narrow seam between operator custody and the executable runtime.
 * Implementations must derive all three roots from actual control/listener/
 * ledger objects and must build those same objects again for `run`.
 */
export type Lc4DevOperatorRuntime = Readonly<{
  kind: "lc4-dev-operator-runtime-v1";
  inspect(input: Readonly<{
    prepare: Lc4DevLivePrepareArtifact;
    audio_manifest: Lc4DevAudioManifest;
    repair_manifest: Lc4DevRepairAudioManifest;
    signer: Lc4DevOperatorSigner;
    evidence_root: string;
  }>): Promise<Lc4DevOperatorRuntimeRoots>;
  build(input: Readonly<{
    prepare: Lc4DevLivePrepareArtifact;
    preflight: Lc4DevLivePreflightArtifact;
    audio_manifest: Lc4DevAudioManifest;
    repair_manifest: Lc4DevRepairAudioManifest;
    audio_root: string;
    evidence_root: string;
    credentials: Readonly<Record<LiveStsProvider, string>>;
    signer: Lc4DevOperatorSigner;
    budget_authority: Lc4DevBudgetLifecycle;
  }>): Promise<Lc4DevLiveDependencyBundle>;
}>;

export type Lc4DevOperatorDependencies = Readonly<{
  inspect_source(repositoryRoot: string): Promise<Lc4QualificationGitSource>;
  replay_authority_report?: typeof replayLc4DevAuthorityReport;
  replay_budget_evidence?: typeof replayLc4DevBudgetEvidence;
  runtime?: Lc4DevOperatorRuntime;
  create_runtime?(config: Lc4DevDefaultRuntimeConfig): Promise<Lc4DevOperatorRuntime>;
}>;

const DEFAULT_DEPS: Lc4DevOperatorDependencies = Object.freeze({
  inspect_source: inspectLc4QualificationGitSource,
  replay_authority_report: replayLc4DevAuthorityReport,
  replay_budget_evidence: replayLc4DevBudgetEvidence,
  create_runtime: createLc4DevelopmentDefaultOperatorRuntime,
});

export const LC4_DEV_DEFAULT_RUNTIME_CLI_FLAGS = Object.freeze([
  "--semantic-calibration-root",
  "--asr-runner-private-key-source",
  "--whisper-cli-path",
  "--whisper-model-path",
  "--ffmpeg-path",
] as const);

async function runtimeFromFlags(
  parsed: Readonly<Record<string, string>>,
  dependencies: Lc4DevOperatorDependencies,
): Promise<Lc4DevOperatorRuntime | undefined> {
  if (dependencies.runtime) return dependencies.runtime;
  if (!dependencies.create_runtime) return undefined;
  return dependencies.create_runtime({
    audio_root: parsed["--audio-root"]!,
    semantic_calibration_root: parsed["--semantic-calibration-root"]!,
    asr_runner_private_key_source: parsed["--asr-runner-private-key-source"]!,
    whisper_cli_path: parsed["--whisper-cli-path"]!,
    whisper_model_path: parsed["--whisper-model-path"]!,
    ffmpeg_path: parsed["--ffmpeg-path"]!,
  });
}

function withRuntimeFlags(
  dependencies: Lc4DevOperatorDependencies,
  flags: readonly string[],
): readonly string[] {
  return dependencies.runtime ? flags : [...flags, ...LC4_DEV_DEFAULT_RUNTIME_CLI_FLAGS];
}

function assertHash(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function absolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an absolute normalized path`);
  return path;
}

function assertOutside(root: string, repositoryRoot: string): void {
  const relation = relative(repositoryRoot, root);
  if (!relation || (!relation.startsWith(`..${sep}`) && relation !== "..")) {
    throw new Error("LC4-DEV evidence root must be outside the source repository");
  }
}

async function readBoundedJson<T>(path: string, label: string): Promise<T> {
  const target = absolute(resolve(path), label);
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be one regular non-symlink, non-hard-linked file`);
  }
  if (metadata.size < 2 || metadata.size > MAX_JSON_BYTES) throw new Error(`${label} has an invalid size`);
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  }
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${sha256Hex(randomBytes(32))}.tmp`;
  await writeFile(temporary, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o400 });
  try {
    await link(temporary, path);
    await chmod(path, 0o400);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
    throw new Error(`${label} already exists; resume and overwrite are forbidden`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parseEnv(text: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]!] = value;
  }
  return Object.freeze(result);
}

async function readEnvFile(path: string, label: string): Promise<Readonly<Record<string, string>>> {
  absolute(path, label);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_ENV_BYTES) {
    throw new Error(`${label} must be a regular non-symlink file no larger than 1 MiB`);
  }
  return parseEnv(await readFile(path, "utf8"));
}

export async function loadLc4DevExplicitCredentials(input: Readonly<{
  provider_env_file: string;
  repository_env_file: string;
}>): Promise<Readonly<Record<LiveStsProvider, string>>> {
  const [providerEnv, repositoryEnv] = await Promise.all([
    readEnvFile(input.provider_env_file, "LC4-DEV provider env file"),
    readEnvFile(input.repository_env_file, "LC4-DEV repository env file"),
  ]);
  const names = Object.freeze({ openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY", xai: "XAI_API_KEY" } as const);
  const values = {} as Record<LiveStsProvider, string>;
  for (const provider of PROVIDERS) {
    const name = names[provider];
    const left = providerEnv[name];
    const right = repositoryEnv[name];
    // Match `source provider.env; source repo.env`: both files are explicit,
    // and the repository file has deterministic last-writer priority.
    const credential = right ?? left;
    if (!credential || credential.length < 12) throw new Error(`LC4-DEV ${provider} credential is missing from the two explicit env files`);
    values[provider] = credential;
  }
  return Object.freeze(values);
}

function qualificationCredentialSetSha256(credentials: Readonly<Record<LiveStsProvider, string>>): string {
  const identities = PROVIDERS.map((provider) => ({
    provider,
    credential_sha256: sha256Hex(`${QUALIFICATION_CREDENTIAL_DOMAIN}${credentials[provider]}`),
  }));
  return sha256Hex(`${QUALIFICATION_CREDENTIAL_SET_DOMAIN}${canonicalJson(identities)}`);
}

async function loadAudio(root: string): Promise<Readonly<{
  manifest: Lc4DevAudioManifest;
  repair_manifest: Lc4DevRepairAudioManifest;
}>> {
  absolute(root, "LC4-DEV audio root");
  const [manifest, repairManifest] = await Promise.all([
    readBoundedJson<Lc4DevAudioManifest>(resolve(root, "manifest.json"), "LC4-DEV audio manifest"),
    readBoundedJson<Lc4DevRepairAudioManifest>(resolve(root, "repair-manifest.json"), "LC4-DEV repair manifest"),
  ]);
  assertLc4DevAudioArtifacts({ manifest, repairManifest });
  const loader = createLc4DevCallerAudioLoader({ outputRoot: root, manifest });
  for (const binding of manifest.caller_audio_bindings) await loader.load(binding);
  return Object.freeze({ manifest, repair_manifest: repairManifest });
}

export async function loadLc4DevRetainedQualification(
  root: string,
  qualificationTrustRootSha256: string,
  now: Date = new Date(),
): Promise<Lc4DevRetainedQualificationReceipt> {
  absolute(root, "LC4 qualification root");
  return loadLc4DevRetainedQualificationV3({
    root,
    qualification_trust_root_sha256: qualificationTrustRootSha256,
    now,
  });
}

async function loadSigner(source: string): Promise<Lc4DevOperatorSigner> {
  let bytes: Buffer;
  if (source.startsWith("fd:")) {
    const fd = Number(source.slice(3));
    if (!Number.isSafeInteger(fd) || fd < 3 || fd > 1024) throw new Error("LC4-DEV private-key fd must be an integer from 3 through 1024");
    bytes = await readFile(`/dev/fd/${fd}`);
  } else {
    absolute(source, "LC4-DEV private-key file");
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
      throw new Error("LC4-DEV private-key file must be regular, non-linked, and inaccessible to group/other users");
    }
    bytes = await readFile(source);
  }
  if (bytes.byteLength < 32 || bytes.byteLength > MAX_KEY_BYTES) throw new Error("LC4-DEV private key has an invalid size");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(bytes);
  } catch {
    throw new Error("LC4-DEV private key is not a readable unencrypted private key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("LC4-DEV private key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const der = publicKey.export({ format: "der", type: "spki" });
  return Object.freeze({
    private_key: privateKey,
    public_key_spki_der: der,
    public_key_spki_pem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    private_key_pkcs8_pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    public_key_fingerprint_sha256: sha256Hex(der),
  });
}

function authorization(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  qualification: Lc4DevRetainedQualificationReceipt;
  credentials_sha256: string;
  roots: Lc4DevOperatorRuntimeRoots;
  signer: Lc4DevOperatorSigner;
  not_before: string;
  expires_at: string;
  authorization_nonce_sha256: string;
  immutable_ledger_genesis_sha256: string;
}>): Lc4DevLiveAuthorizationArtifact {
  for (const value of Object.values(input.roots)) assertHash(value, "LC4-DEV runtime root");
  assertHash(input.authorization_nonce_sha256, "LC4-DEV authorization nonce");
  assertHash(input.immutable_ledger_genesis_sha256, "LC4-DEV ledger genesis");
  const body: Lc4DevLiveAuthorizationBody = Object.freeze({
    schema_version: 2,
    protocol_id: "HACC-LC4-DEV-v1",
    purpose: "six_public_development_episodes_only",
    execution_id: input.prepare.execution_id,
    prepare_sha256: input.prepare.prepare_sha256,
    maximum_total_micro_usd: input.prepare.maximum_total_micro_usd,
    audio_manifest_sha256: input.prepare.audio_manifest_sha256,
    qualification_terminal_root_sha256: input.qualification.terminal_root_sha256,
    qualification_retained_artifact_sha256: input.qualification.retained_artifact_sha256,
    credential_identity_set_sha256: input.credentials_sha256,
    control_plane_manifest_sha256: input.roots.control_plane_manifest_sha256,
    listener_evidence_manifest_sha256: input.roots.listener_evidence_manifest_sha256,
    runtime_config_sha256: input.roots.runtime_config_sha256,
    asr_evaluator_build_sha256: input.roots.asr_evaluator_build_sha256,
    asr_evaluator_toolchain_sha256: input.roots.asr_evaluator_toolchain_sha256,
    provider_profile_manifest_sha256: input.prepare.provider_profile_manifest_sha256,
    audio_delivery_profile_sha256: input.prepare.audio_delivery_profile_sha256,
    audio_packetizer_contract_sha256: input.prepare.audio_packetizer_contract_sha256,
    audio_execution_contract_sha256: input.prepare.audio_execution_contract_sha256,
    immutable_ledger_genesis_sha256: input.immutable_ledger_genesis_sha256,
    authorization_nonce_sha256: input.authorization_nonce_sha256,
    not_before: input.not_before,
    expires_at: input.expires_at,
  });
  const withoutHash = Object.freeze({
    body,
    authority_public_key_spki_base64: input.signer.public_key_spki_der.toString("base64"),
    authority_public_key_fingerprint_sha256: input.signer.public_key_fingerprint_sha256,
    signature_algorithm: "Ed25519" as const,
    signature_base64: sign(null, lc4DevLiveAuthorizationSigningBytes(body), input.signer.private_key).toString("base64"),
  });
  return Object.freeze({ ...withoutHash, artifact_sha256: lc4DevLiveAuthorizationArtifactSha256(withoutHash) });
}

type AuthorizationBodyWithoutLedgerGenesis = Omit<Lc4DevLiveAuthorizationBody, "immutable_ledger_genesis_sha256">;

export function lc4DevOperatorAuthorizationBindingSha256(body: AuthorizationBodyWithoutLedgerGenesis): string {
  return lc4DevSharedAuthorizationBindingSha256(body);
}

export function lc4DevOperatorLedgerGenesisSha256(input: Readonly<{
  execution_id: string;
  prepare_sha256: string;
  authorization_binding_sha256: string;
  authority_public_key_fingerprint_sha256: string;
}>): string {
  return lc4DevSharedLedgerGenesisSha256(input);
}

function authorizationBodyWithoutGenesis(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  qualification: Lc4DevRetainedQualificationReceipt;
  credentials_sha256: string;
  roots: Lc4DevOperatorRuntimeRoots;
  nonce_sha256: string;
  not_before: string;
  expires_at: string;
}>): AuthorizationBodyWithoutLedgerGenesis {
  return Object.freeze({
    schema_version: 2,
    protocol_id: "HACC-LC4-DEV-v1",
    purpose: "six_public_development_episodes_only",
    execution_id: input.prepare.execution_id,
    prepare_sha256: input.prepare.prepare_sha256,
    maximum_total_micro_usd: input.prepare.maximum_total_micro_usd,
    audio_manifest_sha256: input.prepare.audio_manifest_sha256,
    qualification_terminal_root_sha256: input.qualification.terminal_root_sha256,
    qualification_retained_artifact_sha256: input.qualification.retained_artifact_sha256,
    credential_identity_set_sha256: input.credentials_sha256,
    control_plane_manifest_sha256: input.roots.control_plane_manifest_sha256,
    listener_evidence_manifest_sha256: input.roots.listener_evidence_manifest_sha256,
    runtime_config_sha256: input.roots.runtime_config_sha256,
    asr_evaluator_build_sha256: input.roots.asr_evaluator_build_sha256,
    asr_evaluator_toolchain_sha256: input.roots.asr_evaluator_toolchain_sha256,
    provider_profile_manifest_sha256: input.prepare.provider_profile_manifest_sha256,
    audio_delivery_profile_sha256: input.prepare.audio_delivery_profile_sha256,
    audio_packetizer_contract_sha256: input.prepare.audio_packetizer_contract_sha256,
    audio_execution_contract_sha256: input.prepare.audio_execution_contract_sha256,
    authorization_nonce_sha256: input.nonce_sha256,
    not_before: input.not_before,
    expires_at: input.expires_at,
  });
}

export function createLc4DevOperatorAuthorizationDag(input: Readonly<{
  prepare: Lc4DevLivePrepareArtifact;
  qualification: Lc4DevRetainedQualificationReceipt;
  credential_identity_set_sha256: string;
  roots: Lc4DevOperatorRuntimeRoots;
  signer: Lc4DevOperatorSigner;
  authorization_nonce_sha256: string;
  not_before: string;
  expires_at: string;
}>): Readonly<{
  authorization_binding_sha256: string;
  immutable_ledger_genesis_sha256: string;
  authorization: Lc4DevLiveAuthorizationArtifact;
}> {
  const bodyWithoutGenesis = authorizationBodyWithoutGenesis({
    prepare: input.prepare,
    qualification: input.qualification,
    credentials_sha256: input.credential_identity_set_sha256,
    roots: input.roots,
    nonce_sha256: input.authorization_nonce_sha256,
    not_before: input.not_before,
    expires_at: input.expires_at,
  });
  const authorizationBindingSha256 = lc4DevOperatorAuthorizationBindingSha256(bodyWithoutGenesis);
  const ledgerGenesisSha256 = lc4DevOperatorLedgerGenesisSha256({
    execution_id: input.prepare.execution_id,
    prepare_sha256: input.prepare.prepare_sha256,
    authorization_binding_sha256: authorizationBindingSha256,
    authority_public_key_fingerprint_sha256: input.signer.public_key_fingerprint_sha256,
  });
  return Object.freeze({
    authorization_binding_sha256: authorizationBindingSha256,
    immutable_ledger_genesis_sha256: ledgerGenesisSha256,
    authorization: authorization({
      prepare: input.prepare,
      qualification: input.qualification,
      credentials_sha256: input.credential_identity_set_sha256,
      roots: input.roots,
      signer: input.signer,
      not_before: input.not_before,
      expires_at: input.expires_at,
      authorization_nonce_sha256: input.authorization_nonce_sha256,
      immutable_ledger_genesis_sha256: ledgerGenesisSha256,
    }),
  });
}

export function assertLc4DevOperatorAuthorizationDag(input: Readonly<{
  preflight: Pick<Lc4DevLivePreflightArtifact,
    "execution_id" | "prepare_sha256" | "immutable_ledger_genesis_sha256" | "authority_trust_root_sha256" | "authorization">;
  expected_authority_public_key_fingerprint_sha256: string;
}>): string {
  const { immutable_ledger_genesis_sha256: claimedGenesis, ...bodyWithoutGenesis } = input.preflight.authorization.body;
  const bindingSha256 = lc4DevOperatorAuthorizationBindingSha256(bodyWithoutGenesis);
  const expectedGenesis = lc4DevOperatorLedgerGenesisSha256({
    execution_id: input.preflight.execution_id,
    prepare_sha256: input.preflight.prepare_sha256,
    authorization_binding_sha256: bindingSha256,
    authority_public_key_fingerprint_sha256: input.expected_authority_public_key_fingerprint_sha256,
  });
  if (input.preflight.authority_trust_root_sha256 !== input.expected_authority_public_key_fingerprint_sha256
    || input.preflight.authorization.authority_public_key_fingerprint_sha256 !== input.expected_authority_public_key_fingerprint_sha256
    || input.preflight.authorization.body.execution_id !== input.preflight.execution_id
    || input.preflight.authorization.body.prepare_sha256 !== input.preflight.prepare_sha256
    || claimedGenesis !== expectedGenesis
    || input.preflight.immutable_ledger_genesis_sha256 !== expectedGenesis) {
    throw new Error("LC4-DEV authorization binding DAG or ledger genesis is invalid");
  }
  return bindingSha256;
}

function flags(args: readonly string[]): Readonly<Record<string, string>> {
  if (args.length % 2 !== 0) throw new Error("LC4-DEV operator requires --flag value pairs");
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1]!;
    if (!key.startsWith("--") || value.startsWith("--") || parsed[key] !== undefined) throw new Error("LC4-DEV operator flags are malformed or duplicated");
    parsed[key] = value;
  }
  return Object.freeze(parsed);
}

function exact(actual: Readonly<Record<string, string>>, expected: readonly string[]): void {
  if (canonicalJson(Object.keys(actual).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`LC4-DEV operator requires exactly: ${[...expected].sort().join(", ")}`);
  }
}

function artifactPath(root: string, name: keyof typeof LC4_DEV_OPERATOR_FILENAMES): string {
  return resolve(root, LC4_DEV_OPERATOR_FILENAMES[name]);
}

export async function runLc4DevelopmentOperatorCli(
  args: readonly string[],
  io: Io = {
    stdout: (value) => process.stdout.write(`${value}\n`),
    stderr: (value) => process.stderr.write(`${value}\n`),
    now: () => new Date(),
  },
  dependencies: Lc4DevOperatorDependencies = DEFAULT_DEPS,
): Promise<number> {
  try {
    const command = args[0];
    const parsed = flags(args.slice(1));
    if (command === "status") {
      exact(parsed, withRuntimeFlags(dependencies, [
        "--repository-root", "--audio-root", "--qualification-root", "--evidence-root",
        "--qualification-trust-root-sha256", "--provider-env-file", "--repo-env-file", "--authority-private-key-source",
      ]));
      const reasons: string[] = [];
      let source: Lc4QualificationGitSource | null = null;
      let audio: Awaited<ReturnType<typeof loadAudio>> | null = null;
      let qualification: Lc4DevRetainedQualificationReceipt | null = null;
      let credentials: Readonly<Record<LiveStsProvider, string>> | null = null;
      let runtime: Lc4DevOperatorRuntime | null = null;
      let signer: Lc4DevOperatorSigner | null = null;
      try { source = await dependencies.inspect_source(parsed["--repository-root"]!); } catch { reasons.push("repository_not_clean_or_unverifiable"); }
      try { audio = await loadAudio(parsed["--audio-root"]!); } catch { reasons.push("audio_manifest_or_cas_not_verified"); }
      try { qualification = await loadLc4DevRetainedQualification(parsed["--qualification-root"]!, parsed["--qualification-trust-root-sha256"]!, io.now()); } catch { reasons.push("retained_qualification_not_verified"); }
      try { credentials = await loadLc4DevExplicitCredentials({ provider_env_file: parsed["--provider-env-file"]!, repository_env_file: parsed["--repo-env-file"]! }); } catch { reasons.push("explicit_provider_credentials_not_verified"); }
      try { runtime = (await runtimeFromFlags(parsed, dependencies)) ?? null; } catch { reasons.push("default_runtime_dependencies_not_verified"); }
      try { signer = await loadSigner(parsed["--authority-private-key-source"]!); } catch { reasons.push("authority_signing_key_not_verified"); }
      if (source && qualification && (source.source_commit !== qualification.source_commit || source.source_tree_sha256 !== qualification.source_tree_sha256)) reasons.push("retained_qualification_source_is_stale");
      if (credentials && qualification && qualificationCredentialSetSha256(credentials) !== qualification.credential_set_sha256) reasons.push("retained_qualification_credential_identity_is_stale");
      let evidenceState: "absent" | "prepared" | "preflighted" | "terminal" | "occupied_invalid" = "absent";
      try {
        const names = await readdir(absolute(parsed["--evidence-root"]!, "LC4-DEV evidence root"));
        if (names.includes(LC4_DEV_OPERATOR_FILENAMES.run)) evidenceState = "terminal";
        else if (names.includes(LC4_DEV_OPERATOR_FILENAMES.preflight)) evidenceState = "preflighted";
        else if (names.includes(LC4_DEV_OPERATOR_FILENAMES.prepare)) evidenceState = "prepared";
        else evidenceState = "occupied_invalid";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") reasons.push("evidence_root_not_inspectable");
      }
      let runtimeRootsVerified = false;
      if (runtime && signer && audio && evidenceState !== "absent" && evidenceState !== "occupied_invalid") {
        try {
          const prepare = await readBoundedJson<Lc4DevLivePrepareArtifact>(artifactPath(parsed["--evidence-root"]!, "prepare"), "LC4-DEV prepare artifact");
          assertLc4DevLivePrepareArtifact(prepare);
          const roots = await runtime.inspect({
            prepare,
            audio_manifest: audio.manifest,
            repair_manifest: audio.repair_manifest,
            signer,
            evidence_root: parsed["--evidence-root"]!,
          });
          if (evidenceState === "preflighted" || evidenceState === "terminal") {
            const preflight = await readBoundedJson<Lc4DevLivePreflightArtifact>(artifactPath(parsed["--evidence-root"]!, "preflight"), "LC4-DEV preflight artifact");
            if (roots.control_plane_manifest_sha256 !== preflight.control_plane_manifest_sha256
              || roots.listener_evidence_manifest_sha256 !== preflight.listener_evidence_manifest_sha256
              || roots.runtime_config_sha256 !== preflight.runtime_config_sha256
              || roots.asr_evaluator_build_sha256 !== preflight.asr_evaluator_build_sha256
              || roots.asr_evaluator_toolchain_sha256 !== preflight.asr_evaluator_toolchain_sha256) {
              throw new Error("LC4-DEV status runtime roots differ from preflight");
            }
          }
          runtimeRootsVerified = true;
        } catch {
          reasons.push("executable_runtime_roots_not_verified");
        }
      } else if (runtime) {
        reasons.push("executable_runtime_roots_require_prepared_evidence");
      } else {
        reasons.push("executable_control_listener_crp_runtime_not_injected");
      }
      io.stdout(canonicalJson({
        protocol_id: "HACC-LC4-DEV-v1",
        operator_version: LC4_DEV_OPERATOR_VERSION,
        dry_status: true,
        provider_calls_made: false,
        exact_episode_count: 6,
        exact_opportunity_count: 360,
        hard_ceiling_micro_usd: LC4_DEV_LIVE_HARD_CEILING_MICRO_USD,
        audio_verified: audio !== null,
        qualification_verified: qualification !== null,
        credentials_verified_without_output: credentials !== null,
        source_verified_clean: source !== null,
        runtime_injected: runtimeRootsVerified,
        evidence_state: evidenceState,
        execution_ready: reasons.length === 0 && evidenceState === "preflighted",
        blockers: Object.freeze(reasons),
      }));
      return 0;
    }

    if (command === "prepare") {
      exact(parsed, ["--repository-root", "--audio-root", "--evidence-root", "--execution-id", "--maximum-micro-usd"]);
      const repositoryRoot = absolute(parsed["--repository-root"]!, "LC4-DEV repository root");
      const evidenceRoot = absolute(parsed["--evidence-root"]!, "LC4-DEV evidence root");
      assertOutside(evidenceRoot, repositoryRoot);
      await assertAbsent(evidenceRoot, "LC4-DEV evidence root");
      const maximum = Number(parsed["--maximum-micro-usd"]!);
      if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > LC4_DEV_LIVE_HARD_CEILING_MICRO_USD) throw new Error("LC4-DEV maximum must be an integer from 1 through 15000000 micro-USD");
      const [source, audio] = await Promise.all([dependencies.inspect_source(repositoryRoot), loadAudio(parsed["--audio-root"]!)]);
      const now = io.now().toISOString();
      const prepare = createLc4DevLivePrepareArtifact({
        execution_id: parsed["--execution-id"]!,
        created_at: now,
        source_commit: source.source_commit,
        source_tree_sha256: source.source_tree_sha256,
        audio_manifest_sha256: audio.manifest.manifest_sha256,
        audio_bindings: audio.manifest.caller_audio_bindings,
        maximum_total_micro_usd: maximum,
      });
      const intentBody = Object.freeze({
        schema_version: 1,
        operator_version: LC4_DEV_OPERATOR_VERSION,
        execution_id: prepare.execution_id,
        source_commit: prepare.source_commit,
        source_tree_sha256: prepare.source_tree_sha256,
        prepare_sha256: prepare.prepare_sha256,
        audio_manifest_sha256: prepare.audio_manifest_sha256,
        repair_manifest_sha256: audio.repair_manifest.repair_manifest_sha256,
        maximum_total_micro_usd: prepare.maximum_total_micro_usd,
        retry_policy: prepare.retry_policy,
        created_at: now,
      });
      const intent = Object.freeze({ ...intentBody, intent_sha256: sha256Hex(`${OPERATOR_INTENT_DOMAIN}${canonicalJson(intentBody)}`) });
      await mkdir(evidenceRoot, { recursive: false, mode: 0o700 });
      await Promise.all([
        writeImmutableJson(artifactPath(evidenceRoot, "prepare"), prepare),
        writeImmutableJson(artifactPath(evidenceRoot, "intent"), intent),
      ]);
      io.stdout(canonicalJson({ command: "prepare", execution_id: prepare.execution_id, prepare_sha256: prepare.prepare_sha256, provider_calls_made: false }));
      return 0;
    }

    if (command === "preflight") {
      exact(parsed, withRuntimeFlags(dependencies, ["--repository-root", "--audio-root", "--qualification-root", "--qualification-trust-root-sha256", "--evidence-root", "--provider-env-file", "--repo-env-file", "--authority-private-key-source", "--expires-minutes"]));
      const runtime = await runtimeFromFlags(parsed, dependencies);
      if (!runtime) throw new Error("LC4-DEV preflight requires the executable control/listener/CRP runtime injection");
      const repositoryRoot = absolute(parsed["--repository-root"]!, "LC4-DEV repository root");
      const evidenceRoot = absolute(parsed["--evidence-root"]!, "LC4-DEV evidence root");
      assertOutside(evidenceRoot, repositoryRoot);
      await Promise.all([
        assertAbsent(artifactPath(evidenceRoot, "authorization"), "LC4-DEV authorization artifact"),
        assertAbsent(artifactPath(evidenceRoot, "preflight"), "LC4-DEV preflight artifact"),
        assertAbsent(artifactPath(evidenceRoot, "run"), "LC4-DEV run artifact"),
      ]);
      const [prepare, source, audio, qualification, credentials, signer] = await Promise.all([
        readBoundedJson<Lc4DevLivePrepareArtifact>(artifactPath(evidenceRoot, "prepare"), "LC4-DEV prepare artifact"),
        dependencies.inspect_source(repositoryRoot),
        loadAudio(parsed["--audio-root"]!),
        loadLc4DevRetainedQualification(parsed["--qualification-root"]!, parsed["--qualification-trust-root-sha256"]!, io.now()),
        loadLc4DevExplicitCredentials({ provider_env_file: parsed["--provider-env-file"]!, repository_env_file: parsed["--repo-env-file"]! }),
        loadSigner(parsed["--authority-private-key-source"]!),
      ]);
      assertLc4DevLivePrepareArtifact(prepare);
      if (prepare.source_commit !== source.source_commit || prepare.source_tree_sha256 !== source.source_tree_sha256) throw new Error("LC4-DEV prepare differs from the current clean source");
      if (qualification.source_commit !== source.source_commit || qualification.source_tree_sha256 !== source.source_tree_sha256) throw new Error("LC4-DEV retained qualification is stale for the current clean source");
      if (qualificationCredentialSetSha256(credentials) !== qualification.credential_set_sha256) throw new Error("LC4-DEV retained qualification used different credential identities");
      if (audio.manifest.manifest_sha256 !== prepare.audio_manifest_sha256) throw new Error("LC4-DEV audio differs from prepare");
      const minutes = Number(parsed["--expires-minutes"]!);
      if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 60) throw new Error("LC4-DEV authorization expiry must be from 5 through 60 minutes");
      const checkedAt = io.now();
      const credentialIdentity = lc4DevCredentialIdentitySetSha256(credentials);

      const notBefore = checkedAt.toISOString();
      const expiresAt = new Date(checkedAt.getTime() + minutes * 60_000).toISOString();
      const nonceSha256 = sha256Hex(randomBytes(32));
      const roots = await runtime.inspect({ prepare, audio_manifest: audio.manifest, repair_manifest: audio.repair_manifest, signer, evidence_root: evidenceRoot });
      const stableRoots = await runtime.inspect({ prepare, audio_manifest: audio.manifest, repair_manifest: audio.repair_manifest, signer, evidence_root: evidenceRoot });
      if (canonicalJson(stableRoots) !== canonicalJson(roots)) throw new Error("LC4-DEV executable runtime roots are nondeterministic");
      const authorizationDag = createLc4DevOperatorAuthorizationDag({
        prepare,
        qualification,
        credential_identity_set_sha256: credentialIdentity,
        roots,
        signer,
        authorization_nonce_sha256: nonceSha256,
        not_before: notBefore,
        expires_at: expiresAt,
      });
      const finalAuthorization = authorizationDag.authorization;
      const ledgerGenesisSha256 = authorizationDag.immutable_ledger_genesis_sha256;
      const preflight = createLc4DevLivePreflightArtifact({
        prepare,
        checked_at: checkedAt.toISOString(),
        qualification_gate_sha256: qualification.retained_artifact_sha256,
        qualification,
        credential_identity_set_sha256: credentialIdentity,
        control_plane_manifest_sha256: roots.control_plane_manifest_sha256,
        listener_evidence_manifest_sha256: roots.listener_evidence_manifest_sha256,
        runtime_config_sha256: roots.runtime_config_sha256,
        asr_evaluator_build_sha256: roots.asr_evaluator_build_sha256,
        asr_evaluator_toolchain_sha256: roots.asr_evaluator_toolchain_sha256,
        immutable_ledger_genesis_sha256: ledgerGenesisSha256,
        audio_manifest_sha256: audio.manifest.manifest_sha256,
        authorization: finalAuthorization,
        expected_authority_public_key_fingerprint_sha256: signer.public_key_fingerprint_sha256,
      });
      await Promise.all([
        writeImmutableJson(artifactPath(evidenceRoot, "authorization"), finalAuthorization),
        writeImmutableJson(artifactPath(evidenceRoot, "preflight"), preflight),
      ]);
      io.stdout(canonicalJson({ command: "preflight", execution_id: prepare.execution_id, preflight_sha256: preflight.preflight_sha256, expires_at: preflight.expires_at, provider_calls_made: false }));
      return 0;
    }

    if (command === "run") {
      exact(parsed, withRuntimeFlags(dependencies, ["--repository-root", "--audio-root", "--qualification-root", "--qualification-trust-root-sha256", "--evidence-root", "--provider-env-file", "--repo-env-file", "--authority-private-key-source"]));
      const runtime = await runtimeFromFlags(parsed, dependencies);
      if (!runtime) throw new Error("LC4-DEV run requires the executable control/listener/CRP runtime injection");
      const repositoryRoot = absolute(parsed["--repository-root"]!, "LC4-DEV repository root");
      const evidenceRoot = absolute(parsed["--evidence-root"]!, "LC4-DEV evidence root");
      assertOutside(evidenceRoot, repositoryRoot);
      await Promise.all([
        assertAbsent(artifactPath(evidenceRoot, "run"), "LC4-DEV terminal run artifact"),
        assertAbsent(artifactPath(evidenceRoot, "ledger"), "LC4-DEV immutable ledger"),
        assertAbsent(artifactPath(evidenceRoot, "budget_lease"), "LC4-DEV one-shot budget lease"),
        assertAbsent(artifactPath(evidenceRoot, "budget_evidence"), "LC4-DEV terminal budget evidence"),
        assertAbsent(artifactPath(evidenceRoot, "run_package"), "LC4-DEV run package"),
      ]);
      const [prepare, preflight, source, audio, qualification, credentials, signer] = await Promise.all([
        readBoundedJson<Lc4DevLivePrepareArtifact>(artifactPath(evidenceRoot, "prepare"), "LC4-DEV prepare artifact"),
        readBoundedJson<Lc4DevLivePreflightArtifact>(artifactPath(evidenceRoot, "preflight"), "LC4-DEV preflight artifact"),
        dependencies.inspect_source(repositoryRoot),
        loadAudio(parsed["--audio-root"]!),
        loadLc4DevRetainedQualification(parsed["--qualification-root"]!, parsed["--qualification-trust-root-sha256"]!, io.now()),
        loadLc4DevExplicitCredentials({ provider_env_file: parsed["--provider-env-file"]!, repository_env_file: parsed["--repo-env-file"]! }),
        loadSigner(parsed["--authority-private-key-source"]!),
      ]);
      assertLc4DevLivePrepareArtifact(prepare);
      assertLc4DevLivePreflightArtifact(preflight, prepare, io.now());
      if (source.source_commit !== prepare.source_commit || source.source_tree_sha256 !== prepare.source_tree_sha256) throw new Error("LC4-DEV run source differs from prepare");
      if (qualification.receipt_sha256 !== preflight.qualification.receipt_sha256) throw new Error("LC4-DEV run qualification differs from preflight");
      if (qualification.source_commit !== source.source_commit || qualification.source_tree_sha256 !== source.source_tree_sha256) throw new Error("LC4-DEV run qualification is stale");
      if (qualificationCredentialSetSha256(credentials) !== qualification.credential_set_sha256 || lc4DevCredentialIdentitySetSha256(credentials) !== preflight.credential_identity_set_sha256) throw new Error("LC4-DEV run credentials differ from qualification or preflight");
      if (signer.public_key_fingerprint_sha256 !== preflight.authority_trust_root_sha256) throw new Error("LC4-DEV run signer differs from preflight trust root");
      const roots = await runtime.inspect({ prepare, audio_manifest: audio.manifest, repair_manifest: audio.repair_manifest, signer, evidence_root: evidenceRoot });
      assertLc4DevOperatorAuthorizationDag({ preflight, expected_authority_public_key_fingerprint_sha256: signer.public_key_fingerprint_sha256 });
      if (roots.control_plane_manifest_sha256 !== preflight.control_plane_manifest_sha256
        || roots.listener_evidence_manifest_sha256 !== preflight.listener_evidence_manifest_sha256
        || roots.runtime_config_sha256 !== preflight.runtime_config_sha256
        || roots.asr_evaluator_build_sha256 !== preflight.asr_evaluator_build_sha256
        || roots.asr_evaluator_toolchain_sha256 !== preflight.asr_evaluator_toolchain_sha256) {
        throw new Error("LC4-DEV executable runtime, ASR evaluator build, or toolchain roots differ from preflight");
      }
      const budgetLease = await reserveLc4DevRunBudget({
        root: evidenceRoot,
        binding: { prepare, preflight },
        now: io.now,
      });
      await writeImmutableJson(artifactPath(evidenceRoot, "budget_lease"), budgetLease);
      const budgetAuthority = new Lc4DevBudgetLifecycle({ lease: budgetLease, binding: { prepare, preflight }, now: io.now });
      budgetAuthority.assertProviderConstructionAuthorized();
      const bundle = await runtime.build({ prepare, preflight, audio_manifest: audio.manifest, repair_manifest: audio.repair_manifest, audio_root: parsed["--audio-root"]!, evidence_root: evidenceRoot, credentials, signer, budget_authority: budgetAuthority });
      let run: Lc4DevLiveRunArtifact;
      try {
        run = await executeLc4DevLiveRun({ prepare, preflight, dependencies: bundle.dependencies });
      } finally {
        await bundle.finalize();
      }
      const budgetEvidence = await finalizeLc4DevRunBudget({ lease: budgetLease, binding: { prepare, preflight }, run, now: io.now });
      await (dependencies.replay_budget_evidence ?? replayLc4DevBudgetEvidence)({ lease: budgetLease, binding: { prepare, preflight }, evidence: budgetEvidence, now: io.now });
      const runPackage = createLc4DevRunPackage({ lease: budgetLease, evidence: budgetEvidence, run });
      await Promise.all([
        writeImmutableJson(artifactPath(evidenceRoot, "run"), run),
        writeImmutableJson(artifactPath(evidenceRoot, "budget_evidence"), budgetEvidence),
        writeImmutableJson(artifactPath(evidenceRoot, "run_package"), runPackage),
      ]);
      io.stdout(canonicalJson({ command: "run", execution_id: run.execution_id, status: run.status, run_sha256: run.run_sha256, run_package_sha256: runPackage.package_sha256, budget_terminal_ledger_head_sha256: budgetEvidence.terminal_ledger_head_sha256, provider_calls_made: run.provider_calls_made, paid_retry_count: run.paid_retry_count }));
      return run.status === "completed" ? 0 : 2;
    }

    if (command === "report") {
      exact(parsed, ["--evidence-root"]);
      const evidenceRoot = absolute(parsed["--evidence-root"]!, "LC4-DEV evidence root");
      const [prepare, run, preflight, budgetLease, budgetEvidence, runPackage] = await Promise.all([
        readBoundedJson<Lc4DevLivePrepareArtifact>(artifactPath(evidenceRoot, "prepare"), "LC4-DEV prepare artifact"),
        readBoundedJson<Lc4DevLiveRunArtifact>(artifactPath(evidenceRoot, "run"), "LC4-DEV run artifact"),
        readBoundedJson<Lc4DevLivePreflightArtifact>(artifactPath(evidenceRoot, "preflight"), "LC4-DEV preflight artifact"),
        readBoundedJson<Lc4DevRunLease>(artifactPath(evidenceRoot, "budget_lease"), "LC4-DEV budget lease"),
        readBoundedJson<Lc4DevBudgetEvidence>(artifactPath(evidenceRoot, "budget_evidence"), "LC4-DEV budget evidence"),
        readBoundedJson<Lc4DevRunPackage>(artifactPath(evidenceRoot, "run_package"), "LC4-DEV run package"),
      ]);
      assertHash(prepare.prepare_sha256, "LC4-DEV report prepare");
      assertHash(preflight.preflight_sha256, "LC4-DEV report preflight");
      if (preflight.execution_id !== prepare.execution_id || preflight.prepare_sha256 !== prepare.prepare_sha256) {
        throw new Error("LC4-DEV report preflight differs from prepare");
      }
      assertLc4DevOperatorAuthorizationDag({
        preflight,
        expected_authority_public_key_fingerprint_sha256: preflight.authority_trust_root_sha256,
      });
      if (run.execution_id !== prepare.execution_id || run.prepare_sha256 !== prepare.prepare_sha256
        || run.preflight_sha256 !== preflight.preflight_sha256) {
        throw new Error("LC4-DEV report run differs from its prepare/preflight custody chain");
      }
      await (dependencies.replay_budget_evidence ?? replayLc4DevBudgetEvidence)({ lease: budgetLease, binding: { prepare, preflight }, evidence: budgetEvidence, now: io.now });
      assertLc4DevRunPackage({ package: runPackage, lease: budgetLease, evidence: budgetEvidence, run });
      const authority = await (dependencies.replay_authority_report ?? replayLc4DevAuthorityReport)({
        run,
        preflight,
        cas_root_dir: resolve(evidenceRoot, "cas"),
      });
      const report = createLc4DevLiveReportArtifact(run, authority, {
        run_package_sha256: runPackage.package_sha256,
        budget_lease_sha256: budgetLease.lease_sha256,
        budget_evidence_sha256: budgetEvidence.evidence_sha256,
        budget_terminal_ledger_head_sha256: budgetEvidence.terminal_ledger_head_sha256,
        budget_replay_verified: true,
      });
      await assertAbsent(artifactPath(evidenceRoot, "report"), "LC4-DEV report artifact");
      await writeImmutableJson(artifactPath(evidenceRoot, "report"), report);
      io.stdout(canonicalJson(report));
      return report.task_results_available ? 0 : 2;
    }
    throw new Error("usage: lc4-development-live <status|prepare|preflight|run|report>");
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "LC4-DEV operator failed");
    return 1;
  }
}

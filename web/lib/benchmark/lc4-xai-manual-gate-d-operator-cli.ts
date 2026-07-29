import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { canonicalJson, sha256Hex } from "./artifacts";
import { parseBenchmarkEnvironmentFile } from "./environment";
import {
  createLc4XaiFiniteManualGateDProductionAdapter,
} from "./lc4-production-provider-adapter";
import {
  LC4_PROVIDER_PROFILE_MANIFEST,
} from "./lc4-provider-profiles";
import {
  inspectLc4QualificationV3GitSource,
  type Lc4QualificationV3GitSource,
} from "./lc4-qualification-v3-runner";
import {
  LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD,
  LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_PCM_BYTES,
  assertLc4XaiFiniteManualGateDPlan,
  assertLc4XaiFiniteManualGateDReceipt,
  createLc4XaiFiniteManualGateDAuthorization,
  createLc4XaiFiniteManualGateDPlan,
  createLc4XaiFiniteManualGateDSigner,
  executeLc4XaiFiniteManualGateD,
  lc4XaiFiniteManualGateDInvocationMarkerBytes,
  type Lc4XaiFiniteManualGateDAuthorizationArtifact,
  type Lc4XaiFiniteManualGateDPlanArtifact,
  type Lc4XaiFiniteManualGateDProductionAdapter,
  type Lc4XaiFiniteManualGateDReceipt,
  type Lc4XaiFiniteManualGateDSigner,
} from "./lc4-xai.manual-qualification";

const HASH = /^[a-f0-9]{64}$/u;
const MAXIMUM_JSON_BYTES = 16 * 1024 * 1024;
const MAXIMUM_PRIVATE_KEY_BYTES = 64 * 1024;
const MAXIMUM_ENV_BYTES = 1024 * 1024;
const MAXIMUM_PCM_BYTES = LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_PCM_BYTES;
const AUTHORIZATION_TTL_MS = 15 * 60_000;
const CREDENTIAL_IDENTITY_DOMAIN =
  "harshas-amazing-call-center/lc4/provider-xai/finite-manual-gate-d-credential/v1\n";

export const LC4_XAI_GATE_D_OPERATOR_FILES = Object.freeze({
  plan: "gate-d-plan.json",
  authorization: "gate-d-authorization.json",
  invocation: "gate-d-invocation.json",
  receipt: "gate-d-receipt.json",
} as const);

const HELP = [
  "HACC LC4 xAI finite-manual Gate D",
  "",
  "Required paid-executor environment (never pass credentials as arguments):",
  "  XAI_API_KEY=<secret>",
  "  or BENCHMARK_PROVIDER_ENV_FILE=/absolute/private/provider.env",
  "",
  "Commands:",
  "  status --repository-root ABS --evidence-root ABS --trust-root-fingerprint SHA256",
  "  prepare --repository-root ABS --evidence-root ABS --harmless-clip-pcm ABS --authority-private-key ABS",
  "  authorize --repository-root ABS --evidence-root ABS --authority-private-key ABS --terminal-private-key ABS --trust-root-fingerprint SHA256",
  "  run --repository-root ABS --evidence-root ABS --harmless-clip-pcm ABS --terminal-private-key ABS --trust-root-fingerprint SHA256",
  "  report --repository-root ABS --evidence-root ABS --trust-root-fingerprint SHA256",
  "",
  "Gate D reserves and conservatively settles exactly $1.00 for one xAI session,",
  "two generation phases, and one capability-gateway tool roundtrip. A run is",
  "claimed before provider construction and cannot be retried, reconnected,",
  "resumed, or failed over. It is transport qualification, not efficacy evidence.",
].join("\n");

type Io = Readonly<{
  stdout(value: string): void;
  stderr(value: string): void;
  now(): Date;
}>;

type Dependencies = Readonly<{
  inspect_source(repositoryRoot: string): Promise<Lc4QualificationV3GitSource>;
  load_xai_credential(): Promise<string>;
  create_adapter(apiKey: string): Lc4XaiFiniteManualGateDProductionAdapter;
  random_uuid(): string;
  random_bytes(size: number): Buffer;
}>;

type StableFile = Readonly<{
  bytes: Buffer;
  device: number;
  inode: number;
  nlink: number;
  permission_mode: number;
}>;

type EvidenceRoot = Readonly<{
  path: string;
  physical_path: string;
  device: number;
  inode: number;
  physical_repository_path: string;
}>;

function absoluteNormalized(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return path;
}

function flags(args: readonly string[]): Readonly<Record<string, string>> {
  if (args.length % 2 !== 0) {
    throw new Error("Gate D operator requires --flag value pairs");
  }
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1]!;
    if (!key.startsWith("--")
      || value.startsWith("--")
      || result[key] !== undefined) {
      throw new Error("Gate D operator flags are malformed or duplicated");
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function exactFlags(
  actual: Readonly<Record<string, string>>,
  expected: readonly string[],
): void {
  if (canonicalJson(Object.keys(actual).sort())
      !== canonicalJson([...expected].sort())) {
    throw new Error(
      `Gate D operator requires exactly: ${[...expected].sort().join(", ")}`,
    );
  }
}

function trustRoot(value: string): string {
  if (!HASH.test(value)) {
    throw new Error("Gate D trust root must be one lowercase SHA-256");
  }
  return value;
}

async function readStableRegularFile(
  pathInput: string,
  label: string,
  maximumBytes: number,
  requirePrivateMode: boolean,
): Promise<StableFile> {
  const path = absoluteNormalized(pathInput, label);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`${label} must be one regular non-linked file`);
  }
  if (before.size <= 0 || before.size > maximumBytes) {
    throw new Error(`${label} has an invalid size`);
  }
  if (requirePrivateMode && (before.mode & 0o077) !== 0) {
    throw new Error(`${label} must be inaccessible to group and other users`);
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.nlink !== 1
      || opened.size !== before.size
      || (requirePrivateMode && (opened.mode & 0o077) !== 0)) {
      throw new Error(`${label} changed while it was opened`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== opened.size
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.nlink !== 1
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
      || (requirePrivateMode && (after.mode & 0o077) !== 0)) {
      throw new Error(`${label} changed while it was read`);
    }
    return Object.freeze({
      bytes,
      device: opened.dev,
      inode: opened.ino,
      nlink: opened.nlink,
      permission_mode: opened.mode & 0o777,
    });
  } finally {
    await handle.close();
  }
}

async function readJson<Value>(path: string, label: string): Promise<Value> {
  const file = await readStableRegularFile(
    path,
    label,
    MAXIMUM_JSON_BYTES,
    false,
  );
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
    ) as Value;
  } catch {
    throw new Error(`${label} must be valid UTF-8 JSON`);
  }
}

async function assertInvocationMarkerCustody(
  path: string,
  receipt: Lc4XaiFiniteManualGateDReceipt,
): Promise<void> {
  const marker = await readStableRegularFile(
    path,
    "Gate D invocation marker",
    MAXIMUM_JSON_BYTES,
    true,
  );
  if (sha256Hex(marker.bytes)
      !== receipt.invocation_claim.marker_file_sha256
    || marker.device !== receipt.invocation_claim.marker_device
    || marker.inode !== receipt.invocation_claim.marker_inode
    || marker.nlink !== receipt.invocation_claim.marker_nlink
    || marker.permission_mode
      !== receipt.invocation_claim.marker_permission_mode) {
    throw new Error("Gate D invocation marker differs from the signed package");
  }
  const expected = lc4XaiFiniteManualGateDInvocationMarkerBytes(
    receipt.invocation_claim,
  );
  if (!marker.bytes.equals(expected)) {
    throw new Error("Gate D invocation marker bytes are not canonical");
  }
}

async function loadSigner(
  path: string,
  label: string,
): Promise<Lc4XaiFiniteManualGateDSigner & Readonly<{
  device: number;
  inode: number;
}>> {
  const file = await readStableRegularFile(
    path,
    label,
    MAXIMUM_PRIVATE_KEY_BYTES,
    true,
  );
  let key;
  try {
    key = createPrivateKey(file.bytes);
  } catch {
    throw new Error(`${label} must contain one unencrypted Ed25519 private key`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} must contain one unencrypted Ed25519 private key`);
  }
  const publicKey = createPublicKey(key).export({
    format: "der",
    type: "spki",
  });
  const signer = createLc4XaiFiniteManualGateDSigner(
    key.export({ format: "pem", type: "pkcs8" }).toString(),
  );
  if (signer.public_key_fingerprint_sha256 !== sha256Hex(publicKey)) {
    throw new Error(`${label} public identity changed during import`);
  }
  return Object.freeze({
    ...signer,
    device: file.device,
    inode: file.inode,
  });
}

function isPhysicallyOutside(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === ".." || relation.startsWith(`..${sep}`);
}

async function ensureEvidenceRoot(
  pathInput: string,
  repositoryInput: string,
  allowCreate: boolean,
): Promise<EvidenceRoot> {
  const path = absoluteNormalized(pathInput, "Gate D evidence root");
  const repository = absoluteNormalized(
    repositoryInput,
    "Gate D repository root",
  );
  const physicalRepository = await realpath(repository);
  const physicalParent = await realpath(dirname(path));
  const physicalCandidate = resolve(physicalParent, basename(path));
  if (!isPhysicallyOutside(physicalRepository, physicalCandidate)) {
    throw new Error(
      "Gate D evidence root must be physically outside the source repository",
    );
  }
  if (allowCreate) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const metadata = await lstat(path);
  const physicalPath = await realpath(path);
  if (!metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o7777) !== 0o700
    || physicalPath !== physicalCandidate
    || !isPhysicallyOutside(physicalRepository, physicalPath)) {
    throw new Error(
      "Gate D evidence root must be one physical private 0700 directory outside the source repository",
    );
  }
  const after = await lstat(path);
  if (!after.isDirectory()
    || after.isSymbolicLink()
    || after.dev !== metadata.dev
    || after.ino !== metadata.ino
    || (after.mode & 0o7777) !== 0o700
    || await realpath(path) !== physicalPath) {
    throw new Error("Gate D evidence root changed during physical validation");
  }
  return Object.freeze({
    path,
    physical_path: physicalPath,
    device: metadata.dev,
    inode: metadata.ino,
    physical_repository_path: physicalRepository,
  });
}

async function reassertEvidenceRoot(root: EvidenceRoot): Promise<void> {
  const metadata = await lstat(root.path);
  const physicalPath = await realpath(root.path);
  if (!metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.dev !== root.device
    || metadata.ino !== root.inode
    || (metadata.mode & 0o7777) !== 0o700
    || physicalPath !== root.physical_path
    || !isPhysicallyOutside(root.physical_repository_path, physicalPath)) {
    throw new Error("Gate D evidence root identity changed after validation");
  }
}

async function writeFresh(
  path: string,
  value: unknown,
  label: string,
): Promise<void> {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory()
    || parent.isSymbolicLink()
    || (parent.mode & 0o077) !== 0) {
    throw new Error(`${label} parent must be one private regular directory`);
  }
  await writeFile(path, `${canonicalJson(value)}\n`, {
    flag: "wx",
    mode: 0o400,
  });
  const metadata = await stat(path);
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || (metadata.mode & 0o777) !== 0o400) {
    throw new Error(`${label} did not retain mode 0400`);
  }
}

async function readPcm(path: string): Promise<Uint8Array> {
  const file = await readStableRegularFile(
    path,
    "Gate D harmless PCM clip",
    MAXIMUM_PCM_BYTES,
    false,
  );
  if (file.bytes.byteLength < 2 || file.bytes.byteLength % 2 !== 0) {
    throw new Error("Gate D harmless PCM clip must contain non-empty PCM16 bytes");
  }
  return Uint8Array.from(file.bytes);
}

function credentialIdentity(apiKey: string): string {
  if (apiKey.length < 12
    || apiKey !== apiKey.trim()
    || /[\u0000-\u001f\u007f]/u.test(apiKey)) {
    throw new Error("Gate D XAI_API_KEY is absent or malformed");
  }
  return sha256Hex(`${CREDENTIAL_IDENTITY_DOMAIN}${apiKey}`);
}

async function loadXaiCredentialFromEnvironment(): Promise<string> {
  const direct = process.env.XAI_API_KEY;
  const envFilePath = process.env.BENCHMARK_PROVIDER_ENV_FILE;
  let fromFile: string | undefined;
  if (envFilePath) {
    const file = await readStableRegularFile(
      envFilePath,
      "Gate D BENCHMARK_PROVIDER_ENV_FILE",
      MAXIMUM_ENV_BYTES,
      true,
    );
    let parsed: NodeJS.Dict<string>;
    try {
      parsed = parseBenchmarkEnvironmentFile(
        new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
      );
    } catch {
      throw new Error("Gate D BENCHMARK_PROVIDER_ENV_FILE is invalid");
    }
    fromFile = parsed.XAI_API_KEY;
  }
  if (direct && fromFile && direct !== fromFile) {
    throw new Error(
      "Gate D XAI_API_KEY differs between process environment and provider env file",
    );
  }
  const credential = direct ?? fromFile;
  if (typeof credential !== "string") {
    throw new Error(
      "Gate D requires XAI_API_KEY or BENCHMARK_PROVIDER_ENV_FILE in the environment",
    );
  }
  credentialIdentity(credential);
  return credential;
}

function paths(root: string) {
  return Object.freeze({
    plan: join(root, LC4_XAI_GATE_D_OPERATOR_FILES.plan),
    authorization: join(
      root,
      LC4_XAI_GATE_D_OPERATOR_FILES.authorization,
    ),
    invocation: join(root, LC4_XAI_GATE_D_OPERATOR_FILES.invocation),
    receipt: join(root, LC4_XAI_GATE_D_OPERATOR_FILES.receipt),
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function requireCurrentPlan(input: Readonly<{
  path: string;
  trust_root: string;
  source: Lc4QualificationV3GitSource;
}>): Promise<Lc4XaiFiniteManualGateDPlanArtifact> {
  const plan = await readJson<Lc4XaiFiniteManualGateDPlanArtifact>(
    input.path,
    "Gate D plan",
  );
  assertLc4XaiFiniteManualGateDPlan(plan, input.trust_root);
  if (plan.body.source_commit !== input.source.source_commit
    || plan.body.source_tree_sha256 !== input.source.source_tree_sha256) {
    throw new Error("Gate D plan is stale for the current clean source");
  }
  return plan;
}

async function commandPrepare(
  parsed: Readonly<Record<string, string>>,
  io: Io,
  dependencies: Dependencies,
): Promise<void> {
  exactFlags(parsed, [
    "--repository-root",
    "--evidence-root",
    "--harmless-clip-pcm",
    "--authority-private-key",
  ]);
  const repositoryRoot = absoluteNormalized(
    parsed["--repository-root"]!,
    "Gate D repository root",
  );
  const root = await ensureEvidenceRoot(
    parsed["--evidence-root"]!,
    repositoryRoot,
    true,
  );
  const output = paths(root.path);
  const [source, pcm, signer] = await Promise.all([
    dependencies.inspect_source(repositoryRoot),
    readPcm(parsed["--harmless-clip-pcm"]!),
    loadSigner(
      parsed["--authority-private-key"]!,
      "Gate D authority private key",
    ),
  ]);
  const plan = createLc4XaiFiniteManualGateDPlan({
    gate_id: `lc4-xai-gate-d-${dependencies.random_uuid()}`,
    prepared_at: io.now().toISOString(),
    source_commit: source.source_commit,
    source_tree_sha256: source.source_tree_sha256,
    harmless_clip_pcm: pcm,
    signer,
  });
  await reassertEvidenceRoot(root);
  await writeFresh(output.plan, plan, "Gate D plan");
  await reassertEvidenceRoot(root);
  io.stdout(canonicalJson({
    action: "lc4-xai-gate-d-prepared",
    plan_artifact_sha256: plan.artifact_sha256,
    plan_authority_trust_root_sha256:
      signer.public_key_fingerprint_sha256,
    source_commit: source.source_commit,
    maximum_total_micro_usd:
      LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD,
    provider_calls_made: 0,
    credentials_loaded: false,
  }));
}

async function commandAuthorize(
  parsed: Readonly<Record<string, string>>,
  io: Io,
  dependencies: Dependencies,
): Promise<void> {
  exactFlags(parsed, [
    "--repository-root",
    "--evidence-root",
    "--authority-private-key",
    "--terminal-private-key",
    "--trust-root-fingerprint",
  ]);
  const repositoryRoot = absoluteNormalized(
    parsed["--repository-root"]!,
    "Gate D repository root",
  );
  const root = await ensureEvidenceRoot(
    parsed["--evidence-root"]!,
    repositoryRoot,
    false,
  );
  const output = paths(root.path);
  const expectedTrust = trustRoot(parsed["--trust-root-fingerprint"]!);
  const source = await dependencies.inspect_source(repositoryRoot);
  const [plan, authority, terminal, apiKey] = await Promise.all([
    requireCurrentPlan({
      path: output.plan,
      trust_root: expectedTrust,
      source,
    }),
    loadSigner(
      parsed["--authority-private-key"]!,
      "Gate D authority private key",
    ),
    loadSigner(
      parsed["--terminal-private-key"]!,
      "Gate D terminal private key",
    ),
    dependencies.load_xai_credential(),
  ]);
  if (authority.public_key_fingerprint_sha256 !== expectedTrust) {
    throw new Error("Gate D authority key differs from the external trust root");
  }
  if ((authority.device === terminal.device && authority.inode === terminal.inode)
    || authority.public_key_fingerprint_sha256
      === terminal.public_key_fingerprint_sha256) {
    throw new Error("Gate D authority and terminal signer identities must differ");
  }
  const now = io.now();
  const authorization = createLc4XaiFiniteManualGateDAuthorization({
    plan,
    plan_trust_root_sha256: expectedTrust,
    authorization_id: `lc4-xai-gate-d-auth-${dependencies.random_uuid()}`,
    authorization_nonce_sha256:
      sha256Hex(dependencies.random_bytes(32)),
    credential_identity_sha256: credentialIdentity(apiKey),
    terminal_signer: terminal,
    not_before: now.toISOString(),
    expires_at: new Date(now.getTime() + AUTHORIZATION_TTL_MS).toISOString(),
    authority_signer: authority,
  });
  await reassertEvidenceRoot(root);
  await writeFresh(
    output.authorization,
    authorization,
    "Gate D authorization",
  );
  await reassertEvidenceRoot(root);
  io.stdout(canonicalJson({
    action: "lc4-xai-gate-d-authorized",
    authorization_artifact_sha256: authorization.artifact_sha256,
    plan_artifact_sha256: plan.artifact_sha256,
    terminal_public_key_fingerprint_sha256:
      authorization.body.terminal_public_key_fingerprint_sha256,
    expires_at: authorization.body.expires_at,
    maximum_total_micro_usd:
      LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD,
    provider_calls_made: 0,
    credential_identity_logged: false,
    credential_value_logged: false,
  }));
}

async function commandRun(
  parsed: Readonly<Record<string, string>>,
  io: Io,
  dependencies: Dependencies,
): Promise<void> {
  exactFlags(parsed, [
    "--repository-root",
    "--evidence-root",
    "--harmless-clip-pcm",
    "--terminal-private-key",
    "--trust-root-fingerprint",
  ]);
  const repositoryRoot = absoluteNormalized(
    parsed["--repository-root"]!,
    "Gate D repository root",
  );
  const root = await ensureEvidenceRoot(
    parsed["--evidence-root"]!,
    repositoryRoot,
    false,
  );
  const output = paths(root.path);
  const expectedTrust = trustRoot(parsed["--trust-root-fingerprint"]!);
  if (await exists(output.receipt)) {
    throw new Error("Gate D receipt already exists; run cannot be repeated");
  }
  const source = await dependencies.inspect_source(repositoryRoot);
  const [plan, authorization, terminal, callerPcm, apiKey] =
    await Promise.all([
      requireCurrentPlan({
        path: output.plan,
        trust_root: expectedTrust,
        source,
      }),
      readJson<Lc4XaiFiniteManualGateDAuthorizationArtifact>(
        output.authorization,
        "Gate D authorization",
      ),
      loadSigner(
        parsed["--terminal-private-key"]!,
        "Gate D terminal private key",
      ),
      readPcm(parsed["--harmless-clip-pcm"]!),
      dependencies.load_xai_credential(),
    ]);
  let receipt: Lc4XaiFiniteManualGateDReceipt;
  try {
    await reassertEvidenceRoot(root);
    receipt = await executeLc4XaiFiniteManualGateD({
      plan,
      authorization,
      terminal_signer: terminal,
      credential_identity_sha256: credentialIdentity(apiKey),
      caller_pcm: callerPcm,
      inspected_source: source,
      now: io.now(),
      completion_clock: io.now,
      expected_plan_trust_root_sha256: expectedTrust,
      invocation_marker_path: output.invocation,
      construct_production_adapter: () => dependencies.create_adapter(apiKey),
    });
  } catch (error) {
    if (await exists(output.invocation)) {
      throw new Error(
        "Gate D one-shot execution did not pass after invocation was claimed; "
        + "the $1 authority is conservatively settled and this evidence root cannot be retried",
        { cause: error },
      );
    }
    throw error;
  }
  await reassertEvidenceRoot(root);
  await assertInvocationMarkerCustody(output.invocation, receipt);
  await writeFresh(output.receipt, receipt, "Gate D receipt");
  await reassertEvidenceRoot(root);
  io.stdout(canonicalJson({
    action: "lc4-xai-gate-d-passed",
    receipt_sha256: receipt.receipt_sha256,
    source_commit: receipt.source_commit,
    provider_sessions_opened: receipt.provider_sessions_opened,
    generation_phases: receipt.terminal.body.generation_phases,
    capability_gateway_tool_roundtrips:
      receipt.terminal.body.capability_gateway_tool_roundtrips,
    retries: receipt.retries,
    reconnects: receipt.reconnects,
    fallbacks: receipt.fallbacks,
    conservatively_settled_micro_usd:
      receipt.terminal.body.budget.conservatively_settled_micro_usd,
    active_micro_usd: receipt.terminal.body.budget.active_micro_usd,
    efficacy_scored: receipt.efficacy_scored,
    raw_audio_retained: receipt.terminal.body.raw_audio_retained,
    credentials_retained: receipt.terminal.body.credentials_retained,
    claim_boundary: receipt.claim_boundary,
    credential_value_logged: false,
  }));
}

async function commandReport(
  parsed: Readonly<Record<string, string>>,
  io: Io,
  dependencies: Dependencies,
): Promise<void> {
  exactFlags(parsed, [
    "--repository-root",
    "--evidence-root",
    "--trust-root-fingerprint",
  ]);
  const repositoryRoot = absoluteNormalized(
    parsed["--repository-root"]!,
    "Gate D repository root",
  );
  const root = await ensureEvidenceRoot(
    parsed["--evidence-root"]!,
    repositoryRoot,
    false,
  );
  const output = paths(root.path);
  const expectedTrust = trustRoot(parsed["--trust-root-fingerprint"]!);
  const source = await dependencies.inspect_source(repositoryRoot);
  const receipt = await readJson<Lc4XaiFiniteManualGateDReceipt>(
    output.receipt,
    "Gate D receipt",
  );
  assertLc4XaiFiniteManualGateDReceipt(receipt, {
    expected_plan_trust_root_sha256: expectedTrust,
    expected_source_commit: source.source_commit,
    expected_source_tree_sha256: source.source_tree_sha256,
    expected_provider_profile_manifest_sha256:
      LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
  });
  await assertInvocationMarkerCustody(output.invocation, receipt);
  await reassertEvidenceRoot(root);
  io.stdout(canonicalJson({
    action: "lc4-xai-gate-d-report",
    status: "passed",
    receipt_sha256: receipt.receipt_sha256,
    source_commit: receipt.source_commit,
    transport_purpose: receipt.transport_purpose,
    transport_mode: receipt.transport_mode,
    provider_sessions_opened: receipt.provider_sessions_opened,
    generation_phases: receipt.terminal.body.generation_phases,
    capability_gateway_tool_roundtrips:
      receipt.terminal.body.capability_gateway_tool_roundtrips,
    retries: receipt.retries,
    reconnects: receipt.reconnects,
    fallbacks: receipt.fallbacks,
    reserved_micro_usd: receipt.terminal.body.budget.reserved_micro_usd,
    conservatively_settled_micro_usd:
      receipt.terminal.body.budget.conservatively_settled_micro_usd,
    active_micro_usd: receipt.terminal.body.budget.active_micro_usd,
    claim_boundary: receipt.claim_boundary,
    efficacy_scored: false,
    provider_calls_made_by_report: 0,
    contains_credentials_or_raw_audio: false,
  }));
}

async function commandStatus(
  parsed: Readonly<Record<string, string>>,
  io: Io,
  dependencies: Dependencies,
): Promise<void> {
  exactFlags(parsed, [
    "--repository-root",
    "--evidence-root",
    "--trust-root-fingerprint",
  ]);
  const repositoryRoot = absoluteNormalized(
    parsed["--repository-root"]!,
    "Gate D repository root",
  );
  const root = await ensureEvidenceRoot(
    parsed["--evidence-root"]!,
    repositoryRoot,
    false,
  );
  const output = paths(root.path);
  const expectedTrust = trustRoot(parsed["--trust-root-fingerprint"]!);
  let source: Lc4QualificationV3GitSource | null = null;
  let sourceReason: string | null = null;
  try {
    source = await dependencies.inspect_source(repositoryRoot);
  } catch {
    sourceReason = "worktree_not_exactly_clean_or_git_identity_invalid";
  }
  const present = Object.freeze({
    plan: await exists(output.plan),
    authorization: await exists(output.authorization),
    invocation: await exists(output.invocation),
    receipt: await exists(output.receipt),
  });
  let state:
    | "empty"
    | "prepared"
    | "authorized"
    | "claimed_without_passing_receipt"
    | "passed";
  if (present.receipt) state = "passed";
  else if (present.invocation) state = "claimed_without_passing_receipt";
  else if (present.authorization) state = "authorized";
  else if (present.plan) state = "prepared";
  else state = "empty";
  let verification: "verified" | "not_applicable" | "not_verified" =
    state === "empty" ? "not_applicable" : "not_verified";
  let receiptSha256: string | null = null;
  if (state === "passed" && source) {
    try {
      const receipt = await readJson<Lc4XaiFiniteManualGateDReceipt>(
        output.receipt,
        "Gate D receipt",
      );
      assertLc4XaiFiniteManualGateDReceipt(receipt, {
        expected_plan_trust_root_sha256: expectedTrust,
        expected_source_commit: source.source_commit,
        expected_source_tree_sha256: source.source_tree_sha256,
        expected_provider_profile_manifest_sha256:
          LC4_PROVIDER_PROFILE_MANIFEST.manifest_sha256,
      });
      await assertInvocationMarkerCustody(output.invocation, receipt);
      verification = "verified";
      receiptSha256 = receipt.receipt_sha256;
    } catch {
      verification = "not_verified";
    }
  } else if ((state === "prepared" || state === "authorized") && source) {
    try {
      await requireCurrentPlan({
        path: output.plan,
        trust_root: expectedTrust,
        source,
      });
      verification = "verified";
    } catch {
      verification = "not_verified";
    }
  }
  await reassertEvidenceRoot(root);
  io.stdout(canonicalJson({
    action: "lc4-xai-gate-d-status",
    state,
    verification,
    source_clean: source !== null,
    source_reason: sourceReason,
    source_commit: source?.source_commit ?? null,
    files_present: present,
    receipt_sha256: receiptSha256,
    retry_permitted: state !== "claimed_without_passing_receipt"
      && state !== "passed",
    maximum_total_micro_usd:
      LC4_XAI_FINITE_MANUAL_GATE_D_MAXIMUM_MICRO_USD,
    required_paid_environment: [
      "XAI_API_KEY",
      "BENCHMARK_PROVIDER_ENV_FILE",
    ],
    provider_calls_made: 0,
  }));
}

export async function runLc4XaiManualGateDOperatorCli(
  args: readonly string[],
  io: Io = {
    stdout: (value) => process.stdout.write(`${value}\n`),
    stderr: (value) => process.stderr.write(`${value}\n`),
    now: () => new Date(),
  },
  dependencyOverrides: Partial<Dependencies> = {},
): Promise<number> {
  const dependencies: Dependencies = Object.freeze({
    inspect_source: inspectLc4QualificationV3GitSource,
    load_xai_credential: loadXaiCredentialFromEnvironment,
    create_adapter: createLc4XaiFiniteManualGateDProductionAdapter,
    random_uuid: randomUUID,
    random_bytes: randomBytes,
    ...dependencyOverrides,
  });
  const command = args[0];
  if (command === "--help" || command === "help" || args.length === 0) {
    io.stdout(HELP);
    return 0;
  }
  try {
    const parsed = flags(args.slice(1));
    if (command === "status") {
      await commandStatus(parsed, io, dependencies);
    } else if (command === "prepare") {
      await commandPrepare(parsed, io, dependencies);
    } else if (command === "authorize") {
      await commandAuthorize(parsed, io, dependencies);
    } else if (command === "run") {
      await commandRun(parsed, io, dependencies);
    } else if (command === "report") {
      await commandReport(parsed, io, dependencies);
    } else {
      throw new Error("usage: lc4-xai-gate-d <status|prepare|authorize|run|report>");
    }
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error
      ? error.message
      : "Gate D operator refused");
    return 1;
  }
}

import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "./artifacts";
import {
  filesystemBudgetLedgerContainsHead,
  initializeFilesystemBudgetLedger,
  inspectFilesystemBudgetLedger,
  setFilesystemBudgetPaused,
} from "./filesystem-budget-ledger";
import {
  benchmarkKernelAttestationPublicKeyFingerprint,
  createBenchmarkKernelAttestationSigner,
} from "./kernel-attestation";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PRIVATE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const IDENTITY_SCHEMA_VERSION = 1 as const;
const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_PRIVATE_MASK = BigInt(0o077);
const BIGINT_MODE_MASK = BigInt(0o777);

type OperatorIdentityRecord = Readonly<{
  schema_version: 1;
  algorithm: "ed25519";
  key_id: string;
  private_key_file: string;
  public_key_file: string;
  public_key_fingerprint_sha256: string;
}>;

export type CanaryOperatorIo = Readonly<{
  stdout(value: string): void;
  stderr(value: string): void;
}>;

export type CanaryOperatorTestHooks = Readonly<{
  /**
   * Test-only scheduling seam used to prove that a pathname replacement after
   * descriptor acquisition is detected. Production callers must omit it.
   */
  afterIdentityFileOpened?: (input: Readonly<{
    label: string;
    path: string;
  }>) => void | Promise<void>;
}>;

export class CanaryOperatorError extends Error {
  readonly exitCode: number;
  readonly code: string;

  constructor(exitCode: number, code: string, message: string) {
    super(message);
    this.name = "CanaryOperatorError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

function fail(exitCode: number, code: string, message: string): never {
  throw new CanaryOperatorError(exitCode, code, message);
}

function safeId(value: string | undefined, label: string): string {
  if (!value || !ID.test(value)) fail(2, "invalid_identifier", `${label} must be a safe identifier`);
  return value;
}

function sha256(value: string | undefined, label: string): string {
  if (!value || !SHA256.test(value)) fail(2, "invalid_sha256", `${label} must be lowercase SHA-256`);
  return value;
}

function jsonLine(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function defaultIo(): CanaryOperatorIo {
  return Object.freeze({
    stdout: (value: string) => process.stdout.write(value),
    stderr: (value: string) => process.stderr.write(value),
  });
}

type Arguments = Readonly<{
  positionals: readonly string[];
  options: ReadonlyMap<string, string>;
}>;

function parseArguments(argv: readonly string[]): Arguments {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!/^--[a-z][a-z0-9-]*$/.test(value)) fail(2, "invalid_option", `invalid option ${value}`);
    const name = value.slice(2);
    if (options.has(name)) fail(2, "duplicate_option", `option --${name} may be supplied only once`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) fail(2, "missing_option_value", `--${name} requires a value`);
    options.set(name, next);
    index += 1;
  }
  return Object.freeze({ positionals: Object.freeze(positionals), options });
}

function rejectUnknown(args: Arguments, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  for (const key of args.options.keys()) {
    if (!accepted.has(key)) fail(2, "unknown_option", `unknown option --${key}`);
  }
}

function required(args: Arguments, name: string): string {
  const value = args.options.get(name);
  if (!value) fail(2, "missing_option", `--${name} is required`);
  return value;
}

function absolute(value: string, cwd: string): string {
  return resolve(isAbsolute(value) ? value : join(cwd, value));
}

type HeldPrivateDirectory = Readonly<{
  path: string;
  handle: FileHandle;
  dev: bigint;
  ino: bigint;
}>;

function sameIdentity(
  left: Readonly<{ dev: bigint; ino: bigint }>,
  right: Readonly<{ dev: bigint; ino: bigint }>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertHeldPrivateDirectory(directory: HeldPrivateDirectory): Promise<void> {
  const [descriptorInfo, pathInfo, canonical] = await Promise.all([
    directory.handle.stat({ bigint: true }).catch(() => null),
    lstat(directory.path, { bigint: true }).catch(() => null),
    realpath(directory.path).catch(() => null),
  ]);
  if (
    !descriptorInfo
    || !pathInfo
    || !descriptorInfo.isDirectory()
    || !pathInfo.isDirectory()
    || pathInfo.isSymbolicLink()
    || !sameIdentity(descriptorInfo, directory)
    || !sameIdentity(pathInfo, directory)
    || canonical !== directory.path
    || (descriptorInfo.mode & BIGINT_PRIVATE_MASK) !== BIGINT_ZERO
    || (pathInfo.mode & BIGINT_PRIVATE_MASK) !== BIGINT_ZERO
  ) {
    fail(5, "unsafe_identity_directory", "identity directory must be a private non-symlink directory");
  }
}

async function openPrivateDirectory(path: string): Promise<HeldPrivateDirectory> {
  const canonical = await realpath(path).catch(() => null);
  const requestedInfo = await lstat(path).catch(() => null);
  if (
    !canonical
    || !requestedInfo
    || !requestedInfo.isDirectory()
    || requestedInfo.isSymbolicLink()
  ) {
    fail(5, "unsafe_identity_directory", "identity directory must be a private non-symlink directory");
  }
  const handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch(() => null);
  if (!handle) {
    fail(5, "unsafe_identity_directory", "identity directory must be a private non-symlink directory");
  }
  try {
    const info = await handle.stat({ bigint: true });
    const directory = Object.freeze({
      path: canonical,
      handle,
      dev: info.dev,
      ino: info.ino,
    });
    await assertHeldPrivateDirectory(directory);
    return directory;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function createPrivateIdentityDirectory(path: string): Promise<HeldPrivateDirectory> {
  if (await lstat(path).catch(() => null)) {
    fail(5, "identity_directory_exists", "refusing to reuse an existing identity directory");
  }
  const parent = dirname(path);
  const parentInfo = await lstat(parent).catch(() => null);
  if (!parentInfo || !parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    fail(5, "unsafe_identity_parent", "identity parent must be an existing non-symlink directory");
  }
  await mkdir(path, { mode: DIRECTORY_MODE }).catch((error: NodeJS.ErrnoException) => {
    fail(5, "identity_directory_create_failed", `could not exclusively create identity directory: ${error.code ?? "mkdir_failed"}`);
  });
  return await openPrivateDirectory(path);
}

async function writeExclusive(
  directory: HeldPrivateDirectory,
  filename: string,
  bytes: string,
  mode: number,
): Promise<void> {
  if (basename(filename) !== filename) {
    fail(5, "unsafe_identity_file", "identity filename must be a single path component");
  }
  await assertHeldPrivateDirectory(directory);
  const path = join(directory.path, filename);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  ).catch((error: NodeJS.ErrnoException) => {
    fail(5, "identity_path_exists", `refusing to replace identity file ${basename(path)}: ${error.code ?? "open_failed"}`);
  });
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== BIGINT_ONE
      || (before.mode & BIGINT_PRIVATE_MASK) !== BIGINT_ZERO
    ) {
      fail(5, "unsafe_identity_file", `identity file ${filename} is unsafe`);
    }
    await handle.writeFile(bytes, "utf8");
    await handle.chmod(mode);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    const pathInfo = await lstat(path, { bigint: true }).catch(() => null);
    if (
      !pathInfo
      || !pathInfo.isFile()
      || pathInfo.isSymbolicLink()
      || pathInfo.nlink !== BIGINT_ONE
      || !sameIdentity(before, after)
      || !sameIdentity(after, pathInfo)
      || (after.mode & BIGINT_MODE_MASK) !== BigInt(mode)
    ) {
      fail(5, "unsafe_identity_file", `identity file ${filename} changed while being written`);
    }
    await assertHeldPrivateDirectory(directory);
    await directory.handle.sync();
  } finally {
    await handle.close();
  }
}

function exactIdentity(value: unknown): OperatorIdentityRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(5, "invalid_identity_manifest", "identity manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "algorithm",
    "key_id",
    "private_key_file",
    "public_key_file",
    "public_key_fingerprint_sha256",
    "schema_version",
  ].sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(5, "invalid_identity_manifest", "identity manifest contains unknown or missing fields");
  }
  if (
    record.schema_version !== IDENTITY_SCHEMA_VERSION
    || record.algorithm !== "ed25519"
    || typeof record.key_id !== "string"
    || !ID.test(record.key_id)
    || typeof record.private_key_file !== "string"
    || basename(record.private_key_file) !== record.private_key_file
    || typeof record.public_key_file !== "string"
    || basename(record.public_key_file) !== record.public_key_file
    || typeof record.public_key_fingerprint_sha256 !== "string"
    || !SHA256.test(record.public_key_fingerprint_sha256)
  ) {
    fail(5, "invalid_identity_manifest", "identity manifest fields are invalid");
  }
  return record as OperatorIdentityRecord;
}

async function readPrivateRegularFile(
  directory: HeldPrivateDirectory,
  filename: string,
  label: string,
  hooks?: CanaryOperatorTestHooks,
): Promise<string> {
  if (basename(filename) !== filename) {
    fail(5, "unsafe_identity_file", `${label} must be a single path component`);
  }
  await assertHeldPrivateDirectory(directory);
  const path = join(directory.path, filename);
  const pathInfo = await lstat(path, { bigint: true }).catch(() => null);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => null);
  if (!pathInfo || !handle) {
    await handle?.close().catch(() => undefined);
    fail(5, "unsafe_identity_file", `${label} must be a private regular file with one hard link`);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || !pathInfo.isFile()
      || pathInfo.isSymbolicLink()
      || before.nlink !== BIGINT_ONE
      || pathInfo.nlink !== BIGINT_ONE
      || (before.mode & BIGINT_PRIVATE_MASK) !== BIGINT_ZERO
      || (pathInfo.mode & BIGINT_PRIVATE_MASK) !== BIGINT_ZERO
      || !sameIdentity(before, pathInfo)
    ) {
      fail(5, "unsafe_identity_file", `${label} must be a private regular file with one hard link`);
    }
    await hooks?.afterIdentityFileOpened?.({ label, path });
    const contents = await handle.readFile("utf8");
    const [after, finalPathInfo] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }).catch(() => null),
    ]);
    if (
      !finalPathInfo
      || !finalPathInfo.isFile()
      || finalPathInfo.isSymbolicLink()
      || finalPathInfo.nlink !== BIGINT_ONE
      || !sameIdentity(before, after)
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || !sameIdentity(after, finalPathInfo)
    ) {
      fail(5, "unsafe_identity_file", `${label} changed while being read`);
    }
    await assertHeldPrivateDirectory(directory);
    return contents;
  } finally {
    await handle.close();
  }
}

async function verifyIdentity(
  manifestPath: string,
  hooks?: CanaryOperatorTestHooks,
): Promise<Readonly<{
  algorithm: "ed25519";
  key_id: string;
  public_key_path: string;
  public_key_fingerprint_sha256: string;
  private_key_permissions: "0600";
  possession_verified: true;
}>> {
  const directory = await openPrivateDirectory(dirname(manifestPath));
  const canonicalManifestPath = join(directory.path, basename(manifestPath));
  if (canonicalManifestPath !== manifestPath) {
    await directory.handle.close();
    fail(5, "unsafe_identity_manifest", "identity manifest path must not traverse or resolve through a symlink");
  }
  try {
    const record = exactIdentity(JSON.parse(await readPrivateRegularFile(
      directory,
      basename(manifestPath),
      "identity manifest",
      hooks,
    )));
    const privatePem = await readPrivateRegularFile(
      directory,
      record.private_key_file,
      "identity private key",
      hooks,
    );
    const publicPem = await readPrivateRegularFile(
      directory,
      record.public_key_file,
      "identity public key",
      hooks,
    );
    const publicKey = createPublicKey(publicPem);
    if (publicKey.asymmetricKeyType !== "ed25519") fail(5, "wrong_identity_key_type", "identity public key must be Ed25519");
    const fingerprint = benchmarkKernelAttestationPublicKeyFingerprint(publicPem);
    if (fingerprint !== record.public_key_fingerprint_sha256) {
      fail(5, "identity_fingerprint_mismatch", "identity public key differs from its recorded fingerprint");
    }
    const privateKey = createPrivateKey(privatePem);
    if (privateKey.asymmetricKeyType !== "ed25519") fail(5, "wrong_identity_key_type", "identity private key must be Ed25519");
    const derivedPublicPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    if (benchmarkKernelAttestationPublicKeyFingerprint(derivedPublicPem) !== fingerprint) {
      fail(5, "identity_key_mismatch", "identity public and private keys do not match");
    }
    const signer = createBenchmarkKernelAttestationSigner({
      keyId: record.key_id,
      privateKeyPem: privatePem,
      publicKeyPem: publicPem,
    });
    if (signer.publicKeySha256 !== fingerprint) {
      fail(5, "identity_key_mismatch", "identity public and private keys do not match");
    }
    await assertHeldPrivateDirectory(directory);
    return Object.freeze({
      algorithm: "ed25519",
      key_id: record.key_id,
      public_key_path: join(directory.path, record.public_key_file),
      public_key_fingerprint_sha256: fingerprint,
      private_key_permissions: "0600",
      possession_verified: true,
    });
  } finally {
    await directory.handle.close();
  }
}

async function generateIdentity(args: Arguments, cwd: string): Promise<unknown> {
  rejectUnknown(args, ["directory", "key-id"]);
  const keyId = safeId(required(args, "key-id"), "key ID");
  const directory = await createPrivateIdentityDirectory(absolute(required(args, "directory"), cwd));
  const privateKeyFile = `${keyId}.private.pem`;
  const publicKeyFile = `${keyId}.public.pem`;
  const manifestFile = `${keyId}.identity.json`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const fingerprint = benchmarkKernelAttestationPublicKeyFingerprint(publicPem);
  const record: OperatorIdentityRecord = Object.freeze({
    schema_version: IDENTITY_SCHEMA_VERSION,
    algorithm: "ed25519",
    key_id: keyId,
    private_key_file: privateKeyFile,
    public_key_file: publicKeyFile,
    public_key_fingerprint_sha256: fingerprint,
  });
  try {
    // Defense in depth: even if an operator chooses a directory outside the
    // repository's documented `.local/` root, ordinary Git staging cannot
    // discover the generated key material.
    await writeExclusive(directory, ".gitignore", "*\n!.gitignore\n", PRIVATE_MODE);
    await writeExclusive(directory, privateKeyFile, privatePem, PRIVATE_MODE);
    // Keep all identity material private to avoid platform-dependent umask
    // surprises. The public key is explicitly copied into a freeze only after
    // the operator has inspected this manifest.
    await writeExclusive(directory, publicKeyFile, publicPem, PRIVATE_MODE);
    await writeExclusive(directory, manifestFile, jsonLine(record), PRIVATE_MODE);
    await assertHeldPrivateDirectory(directory);
  } catch (error) {
    // This directory was exclusively created by this invocation. Remove only
    // that scoped directory so a partial identity can never be mistaken for a
    // usable signer.
    const stillBound = await (async () => {
      try {
        await assertHeldPrivateDirectory(directory);
        return true;
      } catch {
        return false;
      }
    })();
    if (stillBound) await rm(directory.path, { recursive: true, force: true });
    await directory.handle.close().catch(() => undefined);
    throw error;
  }
  await directory.handle.close();
  return Object.freeze({
    action: "identity.generated",
    manifest_path: join(directory.path, manifestFile),
    public_key_path: join(directory.path, publicKeyFile),
    key_id: keyId,
    public_key_fingerprint_sha256: fingerprint,
    private_key_material_printed: false,
  });
}

async function identityInspect(
  args: Arguments,
  cwd: string,
  hooks?: CanaryOperatorTestHooks,
): Promise<unknown> {
  rejectUnknown(args, ["manifest"]);
  return Object.freeze({
    action: "identity.inspected",
    ...await verifyIdentity(absolute(required(args, "manifest"), cwd), hooks),
  });
}

async function ledgerInit(args: Arguments, cwd: string): Promise<unknown> {
  rejectUnknown(args, ["ledger", "ledger-id", "operation-id", "operational-ceiling-usd"]);
  const result = await initializeFilesystemBudgetLedger({
    ledgerPath: absolute(required(args, "ledger"), cwd),
    ledgerId: safeId(required(args, "ledger-id"), "ledger ID"),
    operationId: safeId(required(args, "operation-id"), "operation ID"),
    operationalCeilingUsd: required(args, "operational-ceiling-usd"),
    initiallyPaused: true,
  });
  return Object.freeze({ action: "ledger.initialized_paused", ...result.snapshot });
}

async function ledgerInspect(args: Arguments, cwd: string): Promise<unknown> {
  rejectUnknown(args, ["ledger", "expected-ledger-id", "required-ancestor-head-sha256"]);
  const path = absolute(required(args, "ledger"), cwd);
  const expectedLedgerId = safeId(required(args, "expected-ledger-id"), "expected ledger ID");
  const snapshot = await inspectFilesystemBudgetLedger({ ledgerPath: path });
  if (snapshot.ledger_id !== expectedLedgerId) fail(5, "ledger_id_mismatch", "ledger ID differs from operator expectation");
  const ancestor = sha256(
    required(args, "required-ancestor-head-sha256"),
    "required ancestor head",
  );
  if (!await filesystemBudgetLedgerContainsHead({
    ledgerPath: path,
    ancestorHeadSha256: ancestor,
  })) {
    fail(5, "ledger_lineage_mismatch", "ledger does not descend from the required signed head");
  }
  return Object.freeze({ action: "ledger.inspected", ...snapshot });
}

async function ledgerTransition(args: Arguments, cwd: string, paused: boolean): Promise<unknown> {
  rejectUnknown(args, [
    "ledger",
    "expected-ledger-id",
    "expected-head-sha256",
    "operation-id",
    "reason-code",
    "evidence-sha256",
  ]);
  const result = await setFilesystemBudgetPaused({
    ledgerPath: absolute(required(args, "ledger"), cwd),
    paused,
    expectedLedgerId: safeId(required(args, "expected-ledger-id"), "expected ledger ID"),
    expectedHeadSha256: sha256(required(args, "expected-head-sha256"), "expected ledger head"),
    operationId: safeId(required(args, "operation-id"), "operation ID"),
    reasonCode: safeId(required(args, "reason-code"), "reason code"),
    evidenceSha256: sha256(required(args, "evidence-sha256"), "evidence SHA-256"),
  });
  return Object.freeze({
    action: paused ? "ledger.paused" : "ledger.resumed",
    idempotent_replay: result.idempotent_replay,
    ...result.snapshot,
  });
}

async function readiness(
  args: Arguments,
  cwd: string,
  hooks?: CanaryOperatorTestHooks,
): Promise<unknown> {
  rejectUnknown(args, [
    "identity-manifest",
    "expected-key-id",
    "expected-public-key-fingerprint-sha256",
    "ledger",
    "expected-ledger-id",
    "required-ancestor-head-sha256",
    "expect-state",
  ]);
  const identity = await verifyIdentity(absolute(required(args, "identity-manifest"), cwd), hooks);
  const expectedKeyId = safeId(required(args, "expected-key-id"), "expected key ID");
  const expectedFingerprint = sha256(
    required(args, "expected-public-key-fingerprint-sha256"),
    "expected public-key fingerprint",
  );
  if (identity.key_id !== expectedKeyId || identity.public_key_fingerprint_sha256 !== expectedFingerprint) {
    fail(5, "identity_pin_mismatch", "local identity differs from the frozen trust expectation");
  }
  const ledgerPath = absolute(required(args, "ledger"), cwd);
  const expectedLedgerId = safeId(required(args, "expected-ledger-id"), "expected ledger ID");
  const requiredAncestor = sha256(
    required(args, "required-ancestor-head-sha256"),
    "required ancestor head",
  );
  const expectedState = required(args, "expect-state");
  if (expectedState !== "paused" && expectedState !== "open") {
    fail(2, "invalid_expected_state", "--expect-state must be paused or open");
  }
  const snapshot = await inspectFilesystemBudgetLedger({ ledgerPath });
  if (snapshot.ledger_id !== expectedLedgerId) fail(5, "ledger_id_mismatch", "ledger ID differs from frozen plan");
  if (!await filesystemBudgetLedgerContainsHead({ ledgerPath, ancestorHeadSha256: requiredAncestor })) {
    fail(5, "ledger_lineage_mismatch", "ledger does not descend from the frozen Gate 0 head");
  }
  if (snapshot.state !== expectedState) {
    fail(7, "ledger_state_mismatch", `ledger is ${snapshot.state}; expected ${expectedState}`);
  }
  return Object.freeze({
    action: "canary.readiness",
    ready: true,
    provider_credentials_read: false,
    identity,
    ledger: {
      ledger_id: snapshot.ledger_id,
      head_sha256: snapshot.head_sha256,
      sequence: snapshot.sequence,
      state: snapshot.state,
      paused: snapshot.paused,
      scheduling_exposure_micro_usd: snapshot.scheduling_exposure_micro_usd,
      operational_remaining_micro_usd: snapshot.operational_remaining_micro_usd,
    },
    required_ancestor_head_sha256: requiredAncestor,
  });
}

function usage(): string {
  return [
    "Harsha's Amazing Call Center paid-canary operator",
    "",
    "Commands:",
    "  identity generate --directory DIR --key-id ID",
    "  identity inspect --manifest FILE",
    "  ledger init --ledger FILE --ledger-id ID --operation-id ID --operational-ceiling-usd EXACT",
    "  ledger inspect --ledger FILE --expected-ledger-id ID --required-ancestor-head-sha256 HASH",
    "  ledger resume|pause --ledger FILE --expected-ledger-id ID --expected-head-sha256 HASH --operation-id ID --reason-code ID --evidence-sha256 HASH",
    "  readiness --identity-manifest FILE --expected-key-id ID --expected-public-key-fingerprint-sha256 HASH --ledger FILE --expected-ledger-id ID --required-ancestor-head-sha256 HASH --expect-state paused|open",
  ].join("\n");
}

export async function runCanaryOperatorCli(
  argv: readonly string[],
  input: Readonly<{
    cwd?: string;
    io?: CanaryOperatorIo;
    testHooks?: CanaryOperatorTestHooks;
  }> = {},
): Promise<number> {
  const cwd = resolve(input.cwd ?? process.cwd());
  const io = input.io ?? defaultIo();
  try {
    const args = parseArguments(argv);
    const command = args.positionals.join(" ");
    let output: unknown;
    if (command === "" || command === "help") {
      io.stdout(`${usage()}\n`);
      return 0;
    } else if (command === "identity generate") {
      output = await generateIdentity(args, cwd);
    } else if (command === "identity inspect") {
      output = await identityInspect(args, cwd, input.testHooks);
    } else if (command === "ledger init") {
      output = await ledgerInit(args, cwd);
    } else if (command === "ledger inspect") {
      output = await ledgerInspect(args, cwd);
    } else if (command === "ledger resume") {
      output = await ledgerTransition(args, cwd, false);
    } else if (command === "ledger pause") {
      output = await ledgerTransition(args, cwd, true);
    } else if (command === "readiness") {
      output = await readiness(args, cwd, input.testHooks);
    } else {
      fail(2, "unknown_command", `unknown command: ${command}`);
    }
    io.stdout(jsonLine(output));
    return 0;
  } catch (error) {
    const known = error instanceof CanaryOperatorError
      ? error
      : new CanaryOperatorError(5, "operator_refused", error instanceof Error ? error.message : "operator command failed");
    io.stderr(jsonLine({ error: { code: known.code, message: known.message }, exit_code: known.exitCode }));
    return known.exitCode;
  }
}

export const CANARY_OPERATOR_IDENTITY_SCHEMA_VERSION = IDENTITY_SCHEMA_VERSION;

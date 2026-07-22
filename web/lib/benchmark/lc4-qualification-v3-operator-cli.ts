import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { canonicalJson, sha256Hex } from "./artifacts";
import { parseBenchmarkEnvironmentFile } from "./environment";
import {
  LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION,
  assertLc4QualificationV3Authorization,
  assertLc4QualificationV3PlanArtifact,
  createLc4QualificationV3AuthorizationArtifact,
  type Lc4QualificationV3AuthorizationArtifact,
  type Lc4QualificationV3AuthorizationBody,
  type Lc4QualificationV3PlanArtifact,
} from "./lc4-qualification-v3-runner";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_JSON_BYTES = 16 * 1024 * 1024;
const MAXIMUM_PRIVATE_KEY_BYTES = 64 * 1024;
const MAXIMUM_ENV_BYTES = 1024 * 1024;

export const LC4_QUALIFICATION_V3_AUTHORIZATION_TTL_MS = 1_800_000 as const;

type Io = Readonly<{
  stdout(value: string): void;
  stderr(value: string): void;
  now(): Date;
}>;

type SecureFile = Readonly<{
  bytes: Buffer;
  device: number;
  inode: number;
}>;

type Ed25519Identity = Readonly<{
  private_key_pem: string;
  public_key_spki_base64: string;
  public_key_fingerprint_sha256: string;
  device: number;
  inode: number;
}>;

function absoluteNormalized(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return path;
}

function exactFlags(actual: Readonly<Record<string, string>>, expected: readonly string[]): void {
  if (canonicalJson(Object.keys(actual).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`LC4 qualification v3 operator requires exactly: ${[...expected].sort().join(", ")}`);
  }
}

function flags(args: readonly string[]): Readonly<Record<string, string>> {
  if (args.length % 2 !== 0) throw new Error("LC4 qualification v3 operator requires --flag value pairs");
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1]!;
    if (!key.startsWith("--") || value.startsWith("--") || result[key] !== undefined) {
      throw new Error("LC4 qualification v3 operator flags are malformed or duplicated");
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

async function readStableRegularFile(
  path: string,
  label: string,
  maximumBytes: number,
  requirePrivateMode: boolean,
): Promise<SecureFile> {
  const target = absoluteNormalized(path, label);
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`${label} must be one regular non-symlink, non-hard-linked file`);
  }
  if (requirePrivateMode && (before.mode & 0o077) !== 0) {
    throw new Error(`${label} must be inaccessible to group and other users`);
  }
  if (before.size <= 0 || before.size > maximumBytes) throw new Error(`${label} has an invalid size`);

  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
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
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(`${label} changed while it was read`);
    }
    return Object.freeze({ bytes, device: opened.dev, inode: opened.ino });
  } finally {
    await handle.close();
  }
}

async function loadEd25519PrivateKey(path: string, label: string): Promise<Ed25519Identity> {
  const file = await readStableRegularFile(path, label, MAXIMUM_PRIVATE_KEY_BYTES, true);
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(file.bytes);
  } catch {
    throw new Error(`${label} must contain one readable unencrypted Ed25519 private key`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} must contain one readable unencrypted Ed25519 private key`);
  }
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return Object.freeze({
    private_key_pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    public_key_spki_base64: spki.toString("base64"),
    public_key_fingerprint_sha256: sha256Hex(spki),
    device: file.device,
    inode: file.inode,
  });
}

async function readPlan(path: string): Promise<Lc4QualificationV3PlanArtifact> {
  const file = await readStableRegularFile(path, "LC4 qualification v3 plan", MAXIMUM_JSON_BYTES, false);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)) as Lc4QualificationV3PlanArtifact;
  } catch {
    throw new Error("LC4 qualification v3 plan must be valid UTF-8 JSON");
  }
}

async function assertFreshOutputParent(path: string, label: string): Promise<void> {
  const target = absoluteNormalized(path, label);
  const parent = dirname(target);
  const metadata = await lstat(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} parent must be a private regular directory`);
  }
}

async function writeFresh(path: string, bytes: string, mode: 0o400 | 0o600, label: string): Promise<void> {
  await assertFreshOutputParent(path, label);
  await writeFile(path, bytes, { flag: "wx", mode });
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== mode) {
    throw new Error(`${label} did not retain its required file mode`);
  }
}

export async function createLc4QualificationV3OperatorAuthorization(input: Readonly<{
  plan_path: string;
  output_path: string;
  authority_private_key_path: string;
  terminal_private_key_path: string;
  trust_root_fingerprint_sha256: string;
  now: Date;
}>): Promise<Lc4QualificationV3AuthorizationArtifact> {
  if (!SHA256.test(input.trust_root_fingerprint_sha256)) {
    throw new Error("LC4 qualification v3 trust root must be one lowercase SHA-256");
  }
  absoluteNormalized(input.plan_path, "LC4 qualification v3 plan");
  absoluteNormalized(input.output_path, "LC4 qualification v3 authorization output");
  absoluteNormalized(input.authority_private_key_path, "LC4 qualification v3 authority private key");
  absoluteNormalized(input.terminal_private_key_path, "LC4 qualification v3 terminal private key");
  if (input.authority_private_key_path === input.terminal_private_key_path) {
    throw new Error("LC4 qualification v3 authority and terminal private-key paths must differ");
  }
  if (!Number.isFinite(input.now.getTime())) {
    throw new Error("LC4 qualification v3 authorization time is invalid");
  }

  const [plan, authority, terminal] = await Promise.all([
    readPlan(input.plan_path),
    loadEd25519PrivateKey(input.authority_private_key_path, "LC4 qualification v3 authority private key"),
    loadEd25519PrivateKey(input.terminal_private_key_path, "LC4 qualification v3 terminal private key"),
  ]);
  if (authority.device === terminal.device && authority.inode === terminal.inode) {
    throw new Error("LC4 qualification v3 authority and terminal private keys must be distinct files");
  }
  if (authority.public_key_fingerprint_sha256 !== input.trust_root_fingerprint_sha256) {
    throw new Error("LC4 qualification v3 authority private key differs from the external trust root");
  }
  if (authority.public_key_fingerprint_sha256 === terminal.public_key_fingerprint_sha256) {
    throw new Error("LC4 qualification v3 authority and terminal key identities must differ");
  }
  assertLc4QualificationV3PlanArtifact(plan, input.trust_root_fingerprint_sha256);

  const notBefore = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + LC4_QUALIFICATION_V3_AUTHORIZATION_TTL_MS).toISOString();
  const body: Lc4QualificationV3AuthorizationBody = Object.freeze({
    schema_version: 1,
    authorization_version: LC4_QUALIFICATION_V3_AUTHORIZATION_VERSION,
    authorization_id: `qualification-v3-${randomUUID()}`,
    authorization_nonce_sha256: sha256Hex(randomBytes(32)),
    plan_artifact_sha256: plan.artifact_sha256,
    plan_sha256: plan.body.plan_sha256,
    source_commit: plan.body.source.source_commit,
    source_tree_sha256: plan.body.source.source_tree_sha256,
    credential_set_sha256: plan.body.credential_set_sha256,
    terminal_public_key_spki_base64: terminal.public_key_spki_base64,
    terminal_public_key_fingerprint_sha256: terminal.public_key_fingerprint_sha256,
    maximum_total_micro_usd: plan.body.maximum_total_micro_usd,
    maximum_provider_sessions: plan.body.maximum_provider_sessions,
    maximum_paid_sessions: plan.body.maximum_paid_sessions,
    maximum_generation_phases: plan.body.maximum_generation_phases,
    maximum_tool_roundtrips: plan.body.maximum_tool_roundtrips,
    paid_retry_allowed: false,
    not_before: notBefore,
    expires_at: expiresAt,
  });
  const authorization = createLc4QualificationV3AuthorizationArtifact({
    body,
    authorityPrivateKeyPem: authority.private_key_pem,
  });
  assertLc4QualificationV3Authorization({
    artifact: authorization,
    plan,
    trustRootFingerprint: input.trust_root_fingerprint_sha256,
    now: input.now,
  });
  await writeFresh(
    input.output_path,
    `${canonicalJson(authorization)}\n`,
    0o400,
    "LC4 qualification v3 authorization output",
  );
  return authorization;
}

export async function createLc4QualificationV3XaiCredentialOverlay(input: Readonly<{
  source_env_path: string;
  output_path: string;
}>): Promise<void> {
  const source = await readStableRegularFile(
    input.source_env_path,
    "LC4 qualification v3 XAI credential source",
    MAXIMUM_ENV_BYTES,
    true,
  );
  let parsed: NodeJS.Dict<string>;
  try {
    parsed = parseBenchmarkEnvironmentFile(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes));
  } catch {
    throw new Error("LC4 qualification v3 XAI credential source is invalid");
  }
  const credential = parsed.XAI_API_KEY;
  if (typeof credential !== "string"
    || credential.length < 12
    || credential !== credential.trim()
    || /[\u0000-\u001f\u007f]/u.test(credential)) {
    throw new Error("LC4 qualification v3 XAI credential source does not contain one valid XAI_API_KEY");
  }
  await writeFresh(
    input.output_path,
    `XAI_API_KEY=${JSON.stringify(credential)}\n`,
    0o600,
    "LC4 qualification v3 XAI credential overlay",
  );
}

export async function runLc4QualificationV3OperatorCli(
  args: readonly string[],
  io: Io = {
    stdout: (value) => process.stdout.write(`${value}\n`),
    stderr: (value) => process.stderr.write(`${value}\n`),
    now: () => new Date(),
  },
): Promise<number> {
  try {
    const command = args[0];
    const parsed = flags(args.slice(1));
    if (command === "authorize") {
      exactFlags(parsed, [
        "--plan",
        "--output",
        "--authority-private-key",
        "--terminal-private-key",
        "--trust-root-fingerprint",
      ]);
      const authorization = await createLc4QualificationV3OperatorAuthorization({
        plan_path: parsed["--plan"]!,
        output_path: parsed["--output"]!,
        authority_private_key_path: parsed["--authority-private-key"]!,
        terminal_private_key_path: parsed["--terminal-private-key"]!,
        trust_root_fingerprint_sha256: parsed["--trust-root-fingerprint"]!,
        now: io.now(),
      });
      io.stdout(canonicalJson({
        action: "lc4-qualification-v3-authorized",
        authorization_artifact_sha256: authorization.artifact_sha256,
        plan_artifact_sha256: authorization.body.plan_artifact_sha256,
        terminal_public_key_fingerprint_sha256: authorization.body.terminal_public_key_fingerprint_sha256,
        expires_at: authorization.body.expires_at,
        provider_calls_made: 0,
      }));
      return 0;
    }
    if (command === "xai-overlay") {
      exactFlags(parsed, ["--source-env-file", "--output"]);
      await createLc4QualificationV3XaiCredentialOverlay({
        source_env_path: parsed["--source-env-file"]!,
        output_path: parsed["--output"]!,
      });
      io.stdout(canonicalJson({
        action: "lc4-qualification-v3-xai-overlay-created",
        variables_written: ["XAI_API_KEY"],
        values_logged: false,
        provider_calls_made: 0,
      }));
      return 0;
    }
    throw new Error("usage: lc4-qualification-v3-operator <authorize|xai-overlay>");
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "LC4 qualification v3 operator refused");
    return 1;
  }
}

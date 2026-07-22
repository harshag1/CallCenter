import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { canonicalJson, sha256Hex } from "./artifacts";
import {
  sealLc4HeldoutCandidate,
  type Lc4DeterministicHeldoutGenerator,
  type Lc4SealedHeldoutBundle,
} from "./lc4-heldout-commitment";
import { createLc4GenericHeldoutGenerator } from "./lc4-heldout-generator";

export const LC4_SEALED_PUBLICATION_PROTOCOL = "HACC-LC4-SEALED-PUBLICATION-v1" as const;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z][a-z0-9_.-]{1,95}$/;
const SAFE_OUTPUT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.lc4-sealed\.json$/;

type CliOptions = Readonly<{
  seedFile: string;
  keyFile: string;
  outputFile: string;
  generatorSourceSha256: string;
  corpusSchemaSha256: string;
  custodyProcedureSha256: string;
  seedCustodianId: string;
  keyCustodianId: string;
  preparationOperatorId: string;
  createdAt: string;
}>;

export type Lc4SealReceipt = Readonly<{
  schema_version: 1;
  publication_protocol: typeof LC4_SEALED_PUBLICATION_PROTOCOL;
  operation: "seal";
  status: "sealed-and-published";
  held_out_scope: "seed-derived-content-values-and-surface-realization";
  topology_status: "public-and-development-exercised";
  output_basename: string;
  created_at: string;
  generator: Readonly<{ id: string; version: string; source_sha256: string; corpus_schema_sha256: string }>;
  manifest_sha256: string;
  ciphertext_sha256: string;
  ciphertext_byte_length: number;
  template_count: number;
  custody: Readonly<{
    seed_custodian_id: string;
    key_custodian_id: string;
    preparation_operator_id: string;
    custody_procedure_sha256: string;
    seed_commitment_sha256: string;
    key_commitment_sha256: string;
  }>;
  publication_payload_sha256: string;
}>;

export type Lc4SealedPublication = Readonly<{
  schema_version: 1;
  publication_protocol: typeof LC4_SEALED_PUBLICATION_PROTOCOL;
  sealed_bundle: Lc4SealedHeldoutBundle;
  receipt: Lc4SealReceipt;
  publication_payload_sha256: string;
}>;

class SealBoundaryError extends Error {}

function boundaryError(message: string): never {
  throw new SealBoundaryError(message);
}

const FLAG_MAP = Object.freeze({
  "--seed-file": "seedFile",
  "--key-file": "keyFile",
  "--output-file": "outputFile",
  "--generator-source-sha256": "generatorSourceSha256",
  "--corpus-schema-sha256": "corpusSchemaSha256",
  "--custody-procedure-sha256": "custodyProcedureSha256",
  "--seed-custodian-id": "seedCustodianId",
  "--key-custodian-id": "keyCustodianId",
  "--preparation-operator-id": "preparationOperatorId",
  "--created-at": "createdAt",
} satisfies Record<string, keyof CliOptions>);

function parseArguments(argv: readonly string[]): CliOptions {
  if (argv[0] !== "seal") boundaryError("only the seal operation is supported");
  const parsed: Partial<Record<keyof CliOptions, string>> = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !(flag in FLAG_MAP) || !value || value.startsWith("--")) boundaryError("invalid or incomplete seal arguments");
    const key = FLAG_MAP[flag as keyof typeof FLAG_MAP];
    if (parsed[key] !== undefined) boundaryError("duplicate seal argument");
    parsed[key] = value;
  }
  if (Object.keys(parsed).length !== Object.keys(FLAG_MAP).length) boundaryError("all seal arguments are required");
  const options = parsed as CliOptions;
  if (![options.generatorSourceSha256, options.corpusSchemaSha256, options.custodyProcedureSha256].every((value) => SHA256.test(value))) boundaryError("all declared hashes must be lowercase SHA-256 digests");
  if (![options.seedCustodianId, options.keyCustodianId, options.preparationOperatorId].every((value) => SAFE_ID.test(value))) boundaryError("custodian identifiers are invalid");
  if (new Set([options.seedCustodianId, options.keyCustodianId, options.preparationOperatorId]).size !== 3) boundaryError("seed, key, and preparation custodians must be distinct");
  if (!Number.isFinite(Date.parse(options.createdAt)) || new Date(options.createdAt).toISOString() !== options.createdAt) boundaryError("created-at must be a canonical ISO-8601 timestamp");
  if (!SAFE_OUTPUT.test(basename(options.outputFile))) boundaryError("output must use a safe .lc4-sealed.json filename");
  return options;
}

type SecretFile = Readonly<{ bytes: Buffer; device: number; inode: number }>;

async function readSecretFile(path: string, label: string): Promise<SecretFile> {
  const absolutePath = resolve(path);
  let before;
  try {
    before = await lstat(absolutePath);
  } catch {
    boundaryError(`${label} file is unavailable`);
  }
  if (!before.isFile() || before.isSymbolicLink()) boundaryError(`${label} must be a regular non-symlink file`);
  if ((before.mode & 0o7777) !== 0o600) boundaryError(`${label} file mode must be exactly 0600`);
  if (before.size !== 32) boundaryError(`${label} file must contain exactly 32 raw bytes`);

  let handle;
  try {
    handle = await open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const after = await handle.stat();
    if (!after.isFile() || (after.mode & 0o7777) !== 0o600 || after.size !== 32 || after.dev !== before.dev || after.ino !== before.ino) {
      boundaryError(`${label} file changed during secure open`);
    }
    const bytes = Buffer.alloc(32);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) {
        bytes.fill(0);
        boundaryError(`${label} file ended before 32 bytes`);
      }
      offset += bytesRead;
    }
    const finalStat = await handle.stat();
    if (finalStat.dev !== after.dev || finalStat.ino !== after.ino || finalStat.size !== after.size || finalStat.mtimeMs !== after.mtimeMs || finalStat.ctimeMs !== after.ctimeMs) {
      bytes.fill(0);
      boundaryError(`${label} file changed while being read`);
    }
    return Object.freeze({ bytes, device: after.dev, inode: after.ino });
  } catch (error) {
    if (error instanceof SealBoundaryError) throw error;
    boundaryError(`${label} file failed secure validation`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
  throw new SealBoundaryError(`${label} file failed secure validation`);
}

async function assertRealOutputDirectory(outputFile: string): Promise<string> {
  const absolute = resolve(outputFile);
  const parent = dirname(absolute);
  try {
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await realpath(parent) !== parent) boundaryError("output parent must be a real, non-symlink directory");
    if ((parentStat.mode & 0o022) !== 0) boundaryError("output parent must not be group- or world-writable");
    await lstat(absolute);
    boundaryError("output already exists; publication is no-clobber");
  } catch (error) {
    if (error instanceof SealBoundaryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") boundaryError("output path failed secure validation");
  }
  return absolute;
}

async function publishNoClobber(outputFile: string, content: string): Promise<void> {
  const absolute = await assertRealOutputDirectory(outputFile);
  const parent = dirname(absolute);
  const temporary = resolve(parent, `.${basename(absolute)}.${randomBytes(16).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, absolute);
    const published = await lstat(absolute);
    if (!published.isFile() || published.isSymbolicLink() || (published.mode & 0o7777) !== 0o600) boundaryError("published artifact failed final mode validation");
    await unlink(temporary);
    const directory = await open(parent, fsConstants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") boundaryError("output already exists; publication is no-clobber");
    if (error instanceof SealBoundaryError) throw error;
    boundaryError("atomic sealed publication failed");
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function buildPublication(bundle: Lc4SealedHeldoutBundle, outputBasename: string): Lc4SealedPublication {
  const { manifest } = bundle;
  const receiptBase = {
    schema_version: 1 as const,
    publication_protocol: LC4_SEALED_PUBLICATION_PROTOCOL,
    operation: "seal" as const,
    status: "sealed-and-published" as const,
    held_out_scope: manifest.held_out_scope,
    topology_status: manifest.topology_status,
    output_basename: outputBasename,
    created_at: manifest.created_at,
    generator: manifest.generator,
    manifest_sha256: manifest.manifest_sha256,
    ciphertext_sha256: manifest.encryption.ciphertext_sha256,
    ciphertext_byte_length: manifest.encryption.ciphertext_byte_length,
    template_count: manifest.corpus.template_count,
    custody: {
      seed_custodian_id: manifest.custody.seed_custodian_id,
      key_custodian_id: manifest.custody.key_custodian_id,
      preparation_operator_id: manifest.custody.preparation_operator_id,
      custody_procedure_sha256: manifest.custody.custody_procedure_sha256,
      seed_commitment_sha256: manifest.custody.seed_commitment_sha256,
      key_commitment_sha256: manifest.custody.key_commitment_sha256,
    },
  };
  const publicationPayloadSha256 = sha256Hex(canonicalJson({
    schema_version: 1,
    publication_protocol: LC4_SEALED_PUBLICATION_PROTOCOL,
    sealed_bundle: bundle,
    receipt: receiptBase,
  }));
  return Object.freeze({
    schema_version: 1,
    publication_protocol: LC4_SEALED_PUBLICATION_PROTOCOL,
    sealed_bundle: bundle,
    receipt: Object.freeze({ ...receiptBase, publication_payload_sha256: publicationPayloadSha256 }),
    publication_payload_sha256: publicationPayloadSha256,
  });
}

export async function sealLc4FromCustodyFiles(options: CliOptions, generator?: Lc4DeterministicHeldoutGenerator): Promise<Lc4SealReceipt> {
  const seed = await readSecretFile(options.seedFile, "seed");
  let key: SecretFile | undefined;
  try {
    key = await readSecretFile(options.keyFile, "key");
    if (seed.device === key.device && seed.inode === key.inode) boundaryError("seed and key must be separate physical files");
    const selectedGenerator = generator ?? createLc4GenericHeldoutGenerator({
      executionMode: "sealed-custody-only",
      generatorSourceSha256: options.generatorSourceSha256,
      corpusSchemaSha256: options.corpusSchemaSha256,
    });
    const nonce = randomBytes(12);
    try {
      const bundle = sealLc4HeldoutCandidate({
        generator: selectedGenerator,
        seed: seed.bytes,
        encryptionKey: key.bytes,
        nonce,
        custody: {
          seedCustodianId: options.seedCustodianId,
          keyCustodianId: options.keyCustodianId,
          preparationOperatorId: options.preparationOperatorId,
          custodyProcedureSha256: options.custodyProcedureSha256,
        },
        createdAt: options.createdAt,
      });
      const publication = buildPublication(bundle, basename(options.outputFile));
      await publishNoClobber(options.outputFile, `${canonicalJson(publication)}\n`);
      return publication.receipt;
    } finally {
      nonce.fill(0);
    }
  } finally {
    seed.bytes.fill(0);
    key?.bytes.fill(0);
  }
}

export async function runLc4SealCli(
  argv: readonly string[],
  dependencies: Readonly<{
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
    generator?: Lc4DeterministicHeldoutGenerator;
  }> = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    const options = parseArguments(argv);
    const receipt = await sealLc4FromCustodyFiles(options, dependencies.generator);
    dependencies.stdout.write(`${canonicalJson(receipt)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof SealBoundaryError ? error.message : "sealed generation failed at the protected boundary";
    dependencies.stderr.write(`LC4 seal failed: ${message}\n`);
    return 1;
  }
}

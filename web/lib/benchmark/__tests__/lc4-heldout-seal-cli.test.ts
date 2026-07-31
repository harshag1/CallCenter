import { chmod, link, lstat, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import { verifyLc4HeldoutCommitment, type Lc4DeterministicHeldoutGenerator } from "../lc4-heldout-commitment";
import { LC4_SEALED_PUBLICATION_PROTOCOL, runLc4SealCli, type Lc4SealedPublication } from "../lc4-heldout-seal-cli";
import { LC4_DEVELOPMENT_TEST_SEED_BYTES } from "../lc4-heldout-generator";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const PLAINTEXT_MARKER = "synthetic-custody-boundary-marker";

const toyGenerator: Lc4DeterministicHeldoutGenerator = Object.freeze({
  generatorId: "lc4.synthetic-boundary-test",
  generatorVersion: "test-only-1",
  generatorSourceSha256: HASH_A,
  corpusSchemaSha256: HASH_B,
  generate(seed: Uint8Array) {
    return Object.freeze(Array.from({ length: 24 }, (_, index) => Object.freeze({
      template_id: `synthetic-template.${index + 1}`,
      family_slot: Math.floor(index / 4) + 1,
      structural_variant_slot: (index % 4) + 1,
      payload: { marker: PLAINTEXT_MARKER, synthetic_value: seed[index % seed.byteLength] },
    })));
  },
});

type Capture = { text: string; write(chunk: string | Uint8Array): boolean };

function capture(): Capture {
  return {
    text: "",
    write(chunk) {
      this.text += chunk.toString();
      return true;
    },
  };
}

async function custodyFile(directory: string, name: string, byte: number): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, Buffer.alloc(32, byte), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function argumentsFor(seedFile: string, keyFile: string, outputFile: string): string[] {
  return [
    "seal",
    "--seed-file", seedFile,
    "--key-file", keyFile,
    "--output-file", outputFile,
    "--generator-source-sha256", HASH_A,
    "--corpus-schema-sha256", HASH_B,
    "--custody-procedure-sha256", HASH_C,
    "--seed-custodian-id", "seed.custodian",
    "--key-custodian-id", "key.custodian",
    "--preparation-operator-id", "preparation.operator",
    "--created-at", "2026-07-21T16:00:00.000Z",
  ];
}

async function setup() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "lc4-seal-test-")));
  const seed = await custodyFile(directory, "seed.bin", 0x31);
  const key = await custodyFile(directory, "key.bin", 0x72);
  return { directory, seed, key, output: join(directory, "publication.lc4-sealed.json") };
}

describe("LC4 seal-only custody CLI", () => {
  it("atomically publishes a verifiable sealed bundle and only a sanitized receipt", async () => {
    const { seed, key, output } = await setup();
    const stdout = capture();
    const stderr = capture();

    expect(await runLc4SealCli(argumentsFor(seed, key, output), { stdout, stderr, generator: toyGenerator })).toBe(0);
    expect(stderr.text).toBe("");
    const publication = JSON.parse(await readFile(output, "utf8")) as Lc4SealedPublication;
    const receipt = JSON.parse(stdout.text);
    expect(publication.publication_protocol).toBe(LC4_SEALED_PUBLICATION_PROTOCOL);
    expect(receipt).toEqual(publication.receipt);
    expect(receipt).toMatchObject({
      held_out_scope: "seed-derived-content-values-and-surface-realization",
      topology_status: "public-and-development-exercised",
    });
    expect(publication.receipt.output_basename).toBe(basename(output));
    expect(publication.receipt.publication_payload_sha256).toBe(publication.publication_payload_sha256);
    const { publication_payload_sha256: _receiptHash, ...receiptBase } = publication.receipt;
    expect(_receiptHash).toBe(publication.publication_payload_sha256);
    expect(publication.publication_payload_sha256).toBe(sha256Hex(canonicalJson({
      schema_version: publication.schema_version,
      publication_protocol: publication.publication_protocol,
      sealed_bundle: publication.sealed_bundle,
      receipt: receiptBase,
    })));
    expect(verifyLc4HeldoutCommitment(publication.sealed_bundle, publication.receipt.manifest_sha256)).toMatchObject({ valid: true });
    expect((await lstat(output)).mode & 0o777).toBe(0o600);

    const publicBytes = `${stdout.text}\n${await readFile(output, "utf8")}`;
    expect(publicBytes).not.toContain(seed);
    expect(publicBytes).not.toContain(key);
    expect(publicBytes).not.toContain(PLAINTEXT_MARKER);
    expect(publicBytes).not.toContain(Buffer.alloc(32, 0x31).toString("base64"));
    expect(publicBytes).not.toContain(Buffer.alloc(32, 0x72).toString("base64"));
  });

  it.each([
    ["world-readable", async (directory: string, seed: string) => { await chmod(seed, 0o644); return seed; }],
    ["short", async (directory: string) => custodyFile(directory, "short.bin", 0x11).then(async (path) => { await writeFile(path, Buffer.alloc(31), { mode: 0o600 }); return path; })],
    ["long", async (directory: string) => custodyFile(directory, "long.bin", 0x11).then(async (path) => { await writeFile(path, Buffer.alloc(33), { mode: 0o600 }); return path; })],
    ["directory", async (directory: string) => directory],
    ["symlink", async (directory: string, seed: string) => { const path = join(directory, "seed-link.bin"); await symlink(seed, path); return path; }],
  ])("rejects an invalid %s secret input", async (_label, mutate) => {
    const fixture = await setup();
    const invalidSeed = await mutate(fixture.directory, fixture.seed);
    const stdout = capture();
    const stderr = capture();
    expect(await runLc4SealCli(argumentsFor(invalidSeed, fixture.key, fixture.output), { stdout, stderr, generator: toyGenerator })).toBe(1);
    expect(stdout.text).toBe("");
    await expect(lstat(fixture.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects seed and key paths that resolve to one physical file", async () => {
    const fixture = await setup();
    const hardLink = join(fixture.directory, "key-hardlink.bin");
    await link(fixture.seed, hardLink);
    const stdout = capture();
    const stderr = capture();
    expect(await runLc4SealCli(argumentsFor(fixture.seed, hardLink, fixture.output), { stdout, stderr, generator: toyGenerator })).toBe(1);
    expect(stdout.text).toBe("");
  });

  it("uses a fresh nonce for every publication", async () => {
    const fixture = await setup();
    const secondOutput = join(fixture.directory, "publication-two.lc4-sealed.json");
    expect(await runLc4SealCli(argumentsFor(fixture.seed, fixture.key, fixture.output), { stdout: capture(), stderr: capture(), generator: toyGenerator })).toBe(0);
    expect(await runLc4SealCli(argumentsFor(fixture.seed, fixture.key, secondOutput), { stdout: capture(), stderr: capture(), generator: toyGenerator })).toBe(0);
    const first = JSON.parse(await readFile(fixture.output, "utf8")) as Lc4SealedPublication;
    const second = JSON.parse(await readFile(secondOutput, "utf8")) as Lc4SealedPublication;
    expect(first.sealed_bundle.manifest.encryption.nonce_base64).not.toBe(second.sealed_bundle.manifest.encryption.nonce_base64);
    expect(first.sealed_bundle.ciphertext_base64).not.toBe(second.sealed_bundle.ciphertext_base64);
  });

  it("rejects the published development seed on the production generator path", async () => {
    const fixture = await setup();
    await writeFile(fixture.seed, LC4_DEVELOPMENT_TEST_SEED_BYTES, { mode: 0o600 });
    const stdout = capture();
    expect(await runLc4SealCli(argumentsFor(fixture.seed, fixture.key, fixture.output), { stdout, stderr: capture() })).toBe(1);
    expect(stdout.text).toBe("");
    await expect(lstat(fixture.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never clobbers an existing output and removes temporary files", async () => {
    const fixture = await setup();
    await writeFile(fixture.output, "operator-owned\n", { mode: 0o600 });
    const stdout = capture();
    expect(await runLc4SealCli(argumentsFor(fixture.seed, fixture.key, fixture.output), { stdout, stderr: capture(), generator: toyGenerator })).toBe(1);
    expect(stdout.text).toBe("");
    expect(await readFile(fixture.output, "utf8")).toBe("operator-owned\n");
    const names = await import("node:fs/promises").then(({ readdir }) => readdir(fixture.directory));
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it.each(["unseal", "decrypt", "inspect", ""])("rejects unsupported operation %j before touching custody files", async (operation) => {
    const stdout = capture();
    const stderr = capture();
    expect(await runLc4SealCli([operation, "--seed-file", "/does/not/exist"], { stdout, stderr, generator: toyGenerator })).toBe(1);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("only the seal operation is supported");
    expect(stderr.text).not.toContain("/does/not/exist");
  });

  it("contains no decryption implementation or exported unseal operation", () => {
    const source = `${readFileSync(join(process.cwd(), "lib/benchmark/lc4-heldout-seal-cli.ts"), "utf8")}\n${readFileSync(join(process.cwd(), "scripts/lc4-seal-heldout.ts"), "utf8")}`;
    expect(source).not.toMatch(/createDecipheriv|decryptLc4|export .*unseal/i);
    expect(source).not.toMatch(/\bfetch\s*\(|node:https|node:http|WebSocket|provider.*client/i);
  });
});

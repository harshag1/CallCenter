import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCanaryOperatorCli } from "../canary-operator";
import { inspectFilesystemBudgetLedger } from "../filesystem-budget-ledger";

const roots: string[] = [];
const H = (character: string) => character.repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "hacc-canary-operator-"));
  roots.push(value);
  return value;
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout(value: string) { stdout += value; },
      stderr(value: string) { stderr += value; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function generateIdentity(directory: string, keyId = "release-canary-v1") {
  const output = capture();
  expect(await runCanaryOperatorCli([
    "identity",
    "generate",
    "--directory",
    directory,
    "--key-id",
    keyId,
  ], { io: output.io })).toBe(0);
  return JSON.parse(output.stdout()) as {
    manifest_path: string;
    public_key_path: string;
    key_id: string;
    public_key_fingerprint_sha256: string;
  };
}

async function initializeLedger(path: string, id = "release-canary-ledger") {
  const output = capture();
  expect(await runCanaryOperatorCli([
    "ledger",
    "init",
    "--ledger",
    path,
    "--ledger-id",
    id,
    "--operation-id",
    "initialize-release-canary-ledger",
    "--operational-ceiling-usd",
    "15",
  ], { io: output.io })).toBe(0);
  return JSON.parse(output.stdout()) as {
    ledger_id: string;
    head_sha256: string;
    state: string;
    paused: boolean;
    sequence: number;
  };
}

describe("paid-canary operator CLI", () => {
  it("creates an exclusive private Ed25519 identity without printing private material", async () => {
    const workspace = await root();
    const generated = await generateIdentity(join(workspace, "identity"));
    const manifest = JSON.parse(await readFile(generated.manifest_path, "utf8"));
    const privatePath = join(workspace, "identity", manifest.private_key_file);

    expect((await stat(join(workspace, "identity"))).mode & 0o777).toBe(0o700);
    expect((await stat(generated.manifest_path)).mode & 0o777).toBe(0o600);
    expect((await stat(generated.public_key_path)).mode & 0o777).toBe(0o600);
    expect((await stat(privatePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(workspace, "identity", ".gitignore"), "utf8")).toBe("*\n!.gitignore\n");
    expect(JSON.stringify(generated)).not.toContain("PRIVATE KEY");
    expect(generated.public_key_fingerprint_sha256).toMatch(/^[a-f0-9]{64}$/);

    const inspect = capture();
    expect(await runCanaryOperatorCli([
      "identity",
      "inspect",
      "--manifest",
      generated.manifest_path,
    ], { io: inspect.io })).toBe(0);
    expect(JSON.parse(inspect.stdout())).toMatchObject({
      key_id: "release-canary-v1",
      public_key_fingerprint_sha256: generated.public_key_fingerprint_sha256,
      possession_verified: true,
      private_key_permissions: "0600",
    });

    const duplicate = capture();
    expect(await runCanaryOperatorCli([
      "identity",
      "generate",
      "--directory",
      join(workspace, "identity"),
      "--key-id",
      "replacement",
    ], { io: duplicate.io })).toBe(5);
    expect(JSON.parse(duplicate.stderr()).error.code).toBe("identity_directory_exists");
  });

  it("rejects fingerprint, public/private mismatch, hard links, and broad permissions", async () => {
    const workspace = await root();
    const generated = await generateIdentity(join(workspace, "identity-a"), "identity-a");
    const manifest = JSON.parse(await readFile(generated.manifest_path, "utf8"));

    manifest.public_key_fingerprint_sha256 = H("f");
    await writeFile(generated.manifest_path, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    const fingerprint = capture();
    expect(await runCanaryOperatorCli([
      "identity", "inspect", "--manifest", generated.manifest_path,
    ], { io: fingerprint.io })).toBe(5);
    expect(JSON.parse(fingerprint.stderr()).error.code).toBe("identity_fingerprint_mismatch");

    const generatedMismatch = await generateIdentity(join(workspace, "identity-b"), "identity-b");
    const other = generateKeyPairSync("ed25519");
    const mismatchManifest = JSON.parse(await readFile(generatedMismatch.manifest_path, "utf8"));
    await writeFile(
      join(workspace, "identity-b", mismatchManifest.private_key_file),
      other.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      { mode: 0o600 },
    );
    const mismatch = capture();
    expect(await runCanaryOperatorCli([
      "identity", "inspect", "--manifest", generatedMismatch.manifest_path,
    ], { io: mismatch.io })).toBe(5);
    expect(JSON.parse(mismatch.stderr()).error.code).toBe("identity_key_mismatch");

    const generatedLink = await generateIdentity(join(workspace, "identity-c"), "identity-c");
    const linked = join(workspace, "private-key-hardlink");
    const linkManifest = JSON.parse(await readFile(generatedLink.manifest_path, "utf8"));
    await link(join(workspace, "identity-c", linkManifest.private_key_file), linked);
    const hardlink = capture();
    expect(await runCanaryOperatorCli([
      "identity", "inspect", "--manifest", generatedLink.manifest_path,
    ], { io: hardlink.io })).toBe(5);
    expect(JSON.parse(hardlink.stderr()).error.code).toBe("unsafe_identity_file");

    await rm(linked);
    await chmod(join(workspace, "identity-c", linkManifest.private_key_file), 0o640);
    const permissions = capture();
    expect(await runCanaryOperatorCli([
      "identity", "inspect", "--manifest", generatedLink.manifest_path,
    ], { io: permissions.io })).toBe(5);
    expect(JSON.parse(permissions.stderr()).error.code).toBe("unsafe_identity_file");
  });

  it("rejects concurrent identity-directory and opened-key pathname replacement", async () => {
    const workspace = await root();
    const identityDirectory = join(workspace, "identity-race");
    const generated = await generateIdentity(identityDirectory, "identity-race");

    const directorySwap = capture();
    let swappedDirectory = false;
    expect(await runCanaryOperatorCli([
      "identity", "inspect", "--manifest", generated.manifest_path,
    ], {
      io: directorySwap.io,
      testHooks: {
        afterIdentityFileOpened: async ({ label }) => {
          if (label !== "identity manifest" || swappedDirectory) return;
          swappedDirectory = true;
          await rename(identityDirectory, `${identityDirectory}.detached`);
          await mkdir(identityDirectory, { mode: 0o700 });
        },
      },
    })).toBe(5);
    expect(swappedDirectory).toBe(true);
    expect(JSON.parse(directorySwap.stderr()).error.code).toBe("unsafe_identity_file");

    const secondDirectory = join(workspace, "identity-key-race");
    const generatedKeyRace = await generateIdentity(secondDirectory, "identity-key-race");
    const replacement = capture();
    let replacedKey = false;
    expect(await runCanaryOperatorCli([
      "identity", "inspect", "--manifest", generatedKeyRace.manifest_path,
    ], {
      io: replacement.io,
      testHooks: {
        afterIdentityFileOpened: async ({ label, path }) => {
          if (label !== "identity private key" || replacedKey) return;
          replacedKey = true;
          await rename(path, `${path}.detached`);
          const other = generateKeyPairSync("ed25519");
          await writeFile(
            path,
            other.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
            { mode: 0o600 },
          );
        },
      },
    })).toBe(5);
    expect(replacedKey).toBe(true);
    expect(JSON.parse(replacement.stderr()).error.code).toBe("unsafe_identity_file");
  });

  it("initializes atomically paused and never resumes during inspect or readiness", async () => {
    const workspace = await root();
    const ledgerPath = join(workspace, "budget.jsonl");
    const initialized = await initializeLedger(ledgerPath);
    expect(initialized).toMatchObject({ state: "paused", paused: true, sequence: 1 });
    const before = await inspectFilesystemBudgetLedger({ ledgerPath });

    const inspect = capture();
    expect(await runCanaryOperatorCli([
      "ledger",
      "inspect",
      "--ledger",
      ledgerPath,
      "--expected-ledger-id",
      initialized.ledger_id,
      "--required-ancestor-head-sha256",
      initialized.head_sha256,
    ], { io: inspect.io })).toBe(0);

    const identity = await generateIdentity(join(workspace, "identity"));
    const ready = capture();
    expect(await runCanaryOperatorCli([
      "readiness",
      "--identity-manifest",
      identity.manifest_path,
      "--expected-key-id",
      identity.key_id,
      "--expected-public-key-fingerprint-sha256",
      identity.public_key_fingerprint_sha256,
      "--ledger",
      ledgerPath,
      "--expected-ledger-id",
      initialized.ledger_id,
      "--required-ancestor-head-sha256",
      initialized.head_sha256,
      "--expect-state",
      "paused",
    ], { io: ready.io })).toBe(0);
    expect(JSON.parse(ready.stdout())).toMatchObject({
      ready: true,
      provider_credentials_read: false,
      ledger: { state: "paused", paused: true },
    });
    expect(await inspectFilesystemBudgetLedger({ ledgerPath })).toEqual(before);
  });

  it("requires exact ID, current head, lineage, and explicit commands for resume and pause", async () => {
    const workspace = await root();
    const ledgerPath = join(workspace, "budget.jsonl");
    const initialized = await initializeLedger(ledgerPath);

    const wrongLineage = capture();
    expect(await runCanaryOperatorCli([
      "ledger", "inspect",
      "--ledger", ledgerPath,
      "--expected-ledger-id", initialized.ledger_id,
      "--required-ancestor-head-sha256", H("9"),
    ], { io: wrongLineage.io })).toBe(5);
    expect(JSON.parse(wrongLineage.stderr()).error.code).toBe("ledger_lineage_mismatch");

    const wrongId = capture();
    expect(await runCanaryOperatorCli([
      "ledger", "resume",
      "--ledger", ledgerPath,
      "--expected-ledger-id", "wrong-ledger",
      "--expected-head-sha256", initialized.head_sha256,
      "--operation-id", "resume-wrong-id",
      "--reason-code", "gate1-release",
      "--evidence-sha256", H("a"),
    ], { io: wrongId.io })).toBe(5);
    expect((await inspectFilesystemBudgetLedger({ ledgerPath })).state).toBe("paused");

    const wrongHead = capture();
    expect(await runCanaryOperatorCli([
      "ledger", "resume",
      "--ledger", ledgerPath,
      "--expected-ledger-id", initialized.ledger_id,
      "--expected-head-sha256", H("b"),
      "--operation-id", "resume-wrong-head",
      "--reason-code", "gate1-release",
      "--evidence-sha256", H("a"),
    ], { io: wrongHead.io })).toBe(5);
    expect((await inspectFilesystemBudgetLedger({ ledgerPath })).state).toBe("paused");

    const resume = capture();
    expect(await runCanaryOperatorCli([
      "ledger", "resume",
      "--ledger", ledgerPath,
      "--expected-ledger-id", initialized.ledger_id,
      "--expected-head-sha256", initialized.head_sha256,
      "--operation-id", "resume-gate1",
      "--reason-code", "gate1-release",
      "--evidence-sha256", H("a"),
    ], { io: resume.io })).toBe(0);
    const resumed = JSON.parse(resume.stdout());
    expect(resumed).toMatchObject({ state: "open", paused: false, sequence: 2 });

    const retry = capture();
    expect(await runCanaryOperatorCli([
      "ledger", "resume",
      "--ledger", ledgerPath,
      "--expected-ledger-id", initialized.ledger_id,
      "--expected-head-sha256", initialized.head_sha256,
      "--operation-id", "resume-gate1",
      "--reason-code", "gate1-release",
      "--evidence-sha256", H("a"),
    ], { io: retry.io })).toBe(0);
    expect(JSON.parse(retry.stdout())).toMatchObject({
      state: "open",
      sequence: 2,
      idempotent_replay: true,
    });

    const identity = await generateIdentity(join(workspace, "identity"));
    const wrongState = capture();
    expect(await runCanaryOperatorCli([
      "readiness",
      "--identity-manifest", identity.manifest_path,
      "--expected-key-id", identity.key_id,
      "--expected-public-key-fingerprint-sha256", identity.public_key_fingerprint_sha256,
      "--ledger", ledgerPath,
      "--expected-ledger-id", initialized.ledger_id,
      "--required-ancestor-head-sha256", initialized.head_sha256,
      "--expect-state", "paused",
    ], { io: wrongState.io })).toBe(7);
    expect(JSON.parse(wrongState.stderr()).error.code).toBe("ledger_state_mismatch");
    expect((await inspectFilesystemBudgetLedger({ ledgerPath })).state).toBe("open");

    const stalePause = capture();
    expect(await runCanaryOperatorCli([
      "ledger", "pause",
      "--ledger", ledgerPath,
      "--expected-ledger-id", initialized.ledger_id,
      "--expected-head-sha256", initialized.head_sha256,
      "--operation-id", "pause-stale",
      "--reason-code", "canary-complete",
      "--evidence-sha256", H("c"),
    ], { io: stalePause.io })).toBe(5);
    expect((await inspectFilesystemBudgetLedger({ ledgerPath })).state).toBe("open");

    const pause = capture();
    expect(await runCanaryOperatorCli([
      "ledger", "pause",
      "--ledger", ledgerPath,
      "--expected-ledger-id", initialized.ledger_id,
      "--expected-head-sha256", resumed.head_sha256,
      "--operation-id", "pause-after-canary",
      "--reason-code", "canary-complete",
      "--evidence-sha256", H("c"),
    ], { io: pause.io })).toBe(0);
    expect(JSON.parse(pause.stdout())).toMatchObject({ state: "paused", paused: true, sequence: 3 });

    const wrongPin = capture();
    expect(await runCanaryOperatorCli([
      "readiness",
      "--identity-manifest", identity.manifest_path,
      "--expected-key-id", identity.key_id,
      "--expected-public-key-fingerprint-sha256", H("d"),
      "--ledger", ledgerPath,
      "--expected-ledger-id", initialized.ledger_id,
      "--required-ancestor-head-sha256", H("e"),
      "--expect-state", "paused",
    ], { io: wrongPin.io })).toBe(5);
    expect(JSON.parse(wrongPin.stderr()).error.code).toBe("identity_pin_mismatch");
  });
});

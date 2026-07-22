import { generateKeyPairSync } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../artifacts";
import {
  LC4_QUALIFICATION_V3_AUTHORIZATION_TTL_MS,
  runLc4QualificationV3OperatorCli,
} from "../lc4-qualification-v3-operator-cli";
import {
  assertLc4QualificationV3Authorization,
  loadLc4QualificationV3ExplicitCredentials,
  prepareLc4QualificationV3,
  type Lc4QualificationV3AuthorizationArtifact,
  type Lc4QualificationV3GitSource,
} from "../lc4-qualification-v3-runner";
import {
  LC4_S2S_SOURCE_TEXT,
  type Lc4S2sAudioRenderer,
} from "../provider-s2s-tool-roundtrip";

const roots: string[] = [];
const NOW = new Date("2026-07-22T22:30:00.000Z");
const SOURCE: Lc4QualificationV3GitSource = Object.freeze({
  source_commit: "a".repeat(40),
  source_tree_oid: "b".repeat(40),
  source_tree_sha256: "c".repeat(64),
  worktree_clean: true,
});
const CREDENTIALS = Object.freeze({
  openai: "openai-operator-fixture",
  gemini: "gemini-operator-fixture",
  xai: "xai-operator-fixture",
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Object.freeze({
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    fingerprint: sha256Hex(spki),
  });
}

function pcm(sampleRateHz: 16_000 | 24_000): Uint8Array {
  const bytes = new Uint8Array(sampleRateHz * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < bytes.byteLength / 2; index += 1) {
    view.setInt16(index * 2, Math.round(Math.sin(2 * Math.PI * 220 * index / sampleRateHz) * 3_000), true);
  }
  return bytes;
}

const renderer: Lc4S2sAudioRenderer = Object.freeze({
  identitySha256: "d".repeat(64),
  async render(text) {
    expect(text).toBe(LC4_S2S_SOURCE_TEXT);
    return Object.freeze({ pcm16k: pcm(16_000), pcm24k: pcm(24_000) });
  },
});

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "hacc-lc4-qv3-operator-"));
  roots.push(workspace);
  const root = join(workspace, "evidence");
  const repositoryRoot = join(workspace, "repository-placeholder");
  await mkdir(repositoryRoot, { mode: 0o700 });
  const authority = keyPair();
  const terminal = keyPair();
  const authorityPath = join(workspace, "authority.pem");
  const terminalPath = join(workspace, "terminal.pem");
  await Promise.all([
    writeFile(authorityPath, authority.privatePem, { mode: 0o600 }),
    writeFile(terminalPath, terminal.privatePem, { mode: 0o600 }),
  ]);
  const plan = await prepareLc4QualificationV3({
    root,
    repositoryRoot,
    authorityPrivateKeyPem: authority.privatePem,
    trustRootFingerprint: authority.fingerprint,
    audioRenderer: renderer,
    now: () => NOW,
    planId: "qualification-v3-operator-plan",
    dependencies: {
      inspectGitSource: async () => SOURCE,
      loadCredentials: async () => CREDENTIALS,
      materializeAudio: (await import("../provider-s2s-tool-roundtrip")).materializeLc4S2sAudioFixture,
    },
  });
  return Object.freeze({
    root,
    plan,
    planPath: join(root, "lc4-qualification-v3-plan.json"),
    authority,
    authorityPath,
    terminal,
    terminalPath,
  });
}

async function invokeAuthorize(input: Awaited<ReturnType<typeof fixture>>, output: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runLc4QualificationV3OperatorCli([
    "authorize",
    "--plan", input.planPath,
    "--output", output,
    "--authority-private-key", input.authorityPath,
    "--terminal-private-key", input.terminalPath,
    "--trust-root-fingerprint", input.authority.fingerprint,
  ], {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    now: () => NOW,
  });
  return { code, stdout, stderr };
}

describe("LC4 qualification v3 operator authorization", () => {
  it("exposes one explicit package command per reproducible operator phase", async () => {
    const packageJson = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts).toMatchObject({
      "benchmark:lc4:qualification:status": "tsx scripts/lc4-qualification.ts status",
      "benchmark:lc4:qualification:prepare": "tsx scripts/lc4-qualification.ts prepare",
      "benchmark:lc4:qualification:authorize": "tsx scripts/lc4-qualification-v3-operator.ts authorize",
      "benchmark:lc4:qualification:run": "tsx scripts/lc4-qualification.ts run",
      "benchmark:lc4:qualification:report": "tsx scripts/lc4-qualification.ts report",
    });
  });

  it("writes a self-validating one-shot authorization with a fixed 30-minute TTL and terminal-key binding", async () => {
    const input = await fixture();
    const outputA = join(input.root, "authorization-a.json");
    const outputB = join(input.root, "authorization-b.json");

    const first = await invokeAuthorize(input, outputA);
    const second = await invokeAuthorize(input, outputB);
    expect(first).toMatchObject({ code: 0, stderr: [] });
    expect(second).toMatchObject({ code: 0, stderr: [] });
    const authorizationA = JSON.parse(await readFile(outputA, "utf8")) as Lc4QualificationV3AuthorizationArtifact;
    const authorizationB = JSON.parse(await readFile(outputB, "utf8")) as Lc4QualificationV3AuthorizationArtifact;

    expect(Date.parse(authorizationA.body.expires_at) - Date.parse(authorizationA.body.not_before))
      .toBe(LC4_QUALIFICATION_V3_AUTHORIZATION_TTL_MS);
    expect(authorizationA.body.authorization_id).not.toBe(authorizationB.body.authorization_id);
    expect(authorizationA.body.authorization_nonce_sha256).not.toBe(authorizationB.body.authorization_nonce_sha256);
    expect(authorizationA.body.terminal_public_key_fingerprint_sha256).toBe(input.terminal.fingerprint);
    expect(authorizationA.body.plan_artifact_sha256).toBe(input.plan.artifact_sha256);
    expect((await lstat(outputA)).mode & 0o777).toBe(0o400);
    expect(first.stdout.join("\n")).not.toContain(input.authority.privatePem);
    expect(first.stdout.join("\n")).not.toContain(input.terminal.privatePem);
    expect(() => assertLc4QualificationV3Authorization({
      artifact: authorizationA,
      plan: input.plan,
      trustRootFingerprint: input.authority.fingerprint,
      now: NOW,
    })).not.toThrow();
  });

  it("fails closed on duplicate output, loose key mode, symlinked keys, wrong trust, and extra flags", async () => {
    const input = await fixture();
    const output = join(input.root, "authorization.json");
    expect((await invokeAuthorize(input, output)).code).toBe(0);
    expect((await invokeAuthorize(input, output)).code).toBe(1);

    const looseOutput = join(input.root, "authorization-loose.json");
    await chmod(input.authorityPath, 0o644);
    const loose = await invokeAuthorize(input, looseOutput);
    expect(loose.code).toBe(1);
    expect(loose.stderr.join("\n")).toContain("inaccessible to group and other users");
    await chmod(input.authorityPath, 0o600);

    const symlinkPath = join(input.root, "authority-link.pem");
    await symlink(input.authorityPath, symlinkPath);
    const symlinked = await runLc4QualificationV3OperatorCli([
      "authorize",
      "--plan", input.planPath,
      "--output", join(input.root, "authorization-symlink.json"),
      "--authority-private-key", symlinkPath,
      "--terminal-private-key", input.terminalPath,
      "--trust-root-fingerprint", input.authority.fingerprint,
    ], { stdout: () => undefined, stderr: () => undefined, now: () => NOW });
    expect(symlinked).toBe(1);

    const wrongTrust = await runLc4QualificationV3OperatorCli([
      "authorize",
      "--plan", input.planPath,
      "--output", join(input.root, "authorization-wrong-trust.json"),
      "--authority-private-key", input.authorityPath,
      "--terminal-private-key", input.terminalPath,
      "--trust-root-fingerprint", "f".repeat(64),
    ], { stdout: () => undefined, stderr: () => undefined, now: () => NOW });
    expect(wrongTrust).toBe(1);

    const extra = await runLc4QualificationV3OperatorCli([
      "authorize",
      "--plan", input.planPath,
      "--output", join(input.root, "authorization-extra.json"),
      "--authority-private-key", input.authorityPath,
      "--terminal-private-key", input.terminalPath,
      "--trust-root-fingerprint", input.authority.fingerprint,
      "--expires-minutes", "60",
    ], { stdout: () => undefined, stderr: () => undefined, now: () => NOW });
    expect(extra).toBe(1);
  });

  it("creates a fresh XAI-only 0600 overlay while leaving OpenAI and Gemini to the repo env", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-lc4-qv3-overlay-"));
    roots.push(root);
    const source = join(root, "gpu-hub.env");
    const output = join(root, "xai-overlay.env");
    const repo = join(root, "repo.env");
    const xaiSecret = "xai-secret-value-12345";
    const ignoredOpenAi = "provider-openai-must-not-copy";
    await Promise.all([
      writeFile(source, [
        `OPENAI_API_KEY=${ignoredOpenAi}`,
        "GEMINI_API_KEY=provider-gemini-must-not-copy",
        `XAI_API_KEY=${xaiSecret}`,
        "UNRELATED_SECRET=must-not-copy",
        "",
      ].join("\n"), { mode: 0o600 }),
      writeFile(repo, "OPENAI_API_KEY=repo-openai-secret-123\nGEMINI_API_KEY=repo-gemini-secret-123\n", { mode: 0o600 }),
    ]);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runLc4QualificationV3OperatorCli([
      "xai-overlay",
      "--source-env-file", source,
      "--output", output,
    ], { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value), now: () => NOW });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(await readFile(output, "utf8")).toBe(`XAI_API_KEY=${JSON.stringify(xaiSecret)}\n`);
    expect((await lstat(output)).mode & 0o777).toBe(0o600);
    expect(stdout.join("\n")).not.toContain(xaiSecret);
    expect(stdout.join("\n")).not.toContain(ignoredOpenAi);
    await expect(loadLc4QualificationV3ExplicitCredentials({ providerEnvFile: output, repoEnvFile: repo }))
      .resolves.toEqual({
        openai: "repo-openai-secret-123",
        gemini: "repo-gemini-secret-123",
        xai: xaiSecret,
      });
    expect((await invokeOverlayAgain(source, output)).code).toBe(1);
  });
});

async function invokeOverlayAgain(source: string, output: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runLc4QualificationV3OperatorCli([
    "xai-overlay",
    "--source-env-file", source,
    "--output", output,
  ], { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value), now: () => NOW });
  return { code, stdout, stderr };
}

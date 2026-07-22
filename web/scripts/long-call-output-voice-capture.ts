#!/usr/bin/env node

import {
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex } from "../lib/benchmark/artifacts";
import {
  captureOutputVoiceCalibration,
  outputVoiceCaptureWirePath,
  type OutputVoiceCaptureSigner,
} from "../lib/benchmark/long-call-output-voice-capture";
import { createProductionRealtimeClient } from "../lib/benchmark/production-realtime-provider";
import type { LiveStsProvider } from "../lib/benchmark/live-sts-development-experiment";

const execFile = promisify(execFileCallback);
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const IMPLEMENTATION_PATHS = Object.freeze([
  "web/scripts/long-call-output-voice-capture.ts",
  "web/lib/benchmark/long-call-output-voice-capture.ts",
  "web/lib/benchmark/long-call-asr-calibration.ts",
  "web/lib/benchmark/production-realtime-provider.ts",
  "web/lib/realtime/client/types.ts",
  "web/lib/realtime/client/wire-evidence.ts",
  "web/lib/realtime/client/openai-compatible.ts",
  "web/lib/realtime/client/gemini-live.ts",
]);

type Arguments = Readonly<{
  outputRoot: string;
  providerEnvFile: string;
  capturePrivateKey: string;
  captureKeyId: string;
  expectedCaptureAuthoritySha256: string;
  responseTimeoutMs?: number;
}>;

type ToolchainEvidence = Readonly<{
  schemaVersion: 1;
  evidenceType: "hacc_output_voice_capture_toolchain";
  sourceCommit: string;
  sourceCommitSha256: string;
  implementationFiles: readonly Readonly<{ path: string; sha256: string }>[];
  implementationSha256: string;
  captureAuthoritySha256: string;
}>;

function flag(name: string): string {
  const matches = process.argv.reduce<number[]>((indices, value, index) => {
    if (value === name) indices.push(index);
    return indices;
  }, []);
  if (matches.length !== 1) throw new Error(`${name} must be supplied exactly once`);
  const value = process.argv[matches[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function optionalFlag(name: string): string | undefined {
  if (!process.argv.includes(name)) return undefined;
  return flag(name);
}

function absoluteFlag(name: string): string {
  const value = flag(name);
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${name} must be an absolute normalized path`);
  }
  return value;
}

function argumentsFromProcess(): Arguments {
  const knownFlags = new Set([
    "--output-root",
    "--provider-env-file",
    "--capture-private-key",
    "--capture-key-id",
    "--expected-capture-authority-sha256",
    "--response-timeout-ms",
  ]);
  for (let index = 2; index < process.argv.length; index += 2) {
    if (!knownFlags.has(process.argv[index]) || process.argv[index + 1] === undefined) {
      throw new Error("output-voice capture received an unknown or incomplete argument");
    }
  }
  const responseTimeout = optionalFlag("--response-timeout-ms");
  const responseTimeoutMs = responseTimeout === undefined ? undefined : Number(responseTimeout);
  if (responseTimeoutMs !== undefined
    && (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 1_000 || responseTimeoutMs > 120_000)) {
    throw new Error("--response-timeout-ms must be an integer between 1000 and 120000");
  }
  const captureKeyId = flag("--capture-key-id");
  if (!SAFE_KEY_ID.test(captureKeyId)) throw new Error("--capture-key-id is unsafe");
  const expectedCaptureAuthoritySha256 = flag("--expected-capture-authority-sha256");
  if (!SHA256.test(expectedCaptureAuthoritySha256)) {
    throw new Error("--expected-capture-authority-sha256 must be one lowercase SHA-256");
  }
  return Object.freeze({
    outputRoot: absoluteFlag("--output-root"),
    providerEnvFile: absoluteFlag("--provider-env-file"),
    capturePrivateKey: absoluteFlag("--capture-private-key"),
    captureKeyId,
    expectedCaptureAuthoritySha256,
    ...(responseTimeoutMs === undefined ? {} : { responseTimeoutMs }),
  });
}

async function assertPrivateRegularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} must not be accessible by group or other users`);
}

async function assertOutputDoesNotExist(outputRoot: string): Promise<void> {
  try {
    await lstat(outputRoot);
    throw new Error("--output-root already exists; capture refuses to overwrite it");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = await stat(dirname(outputRoot));
  if (!parent.isDirectory()) throw new Error("--output-root parent is not a directory");
}

function parseProviderCredentials(text: string): Readonly<Record<LiveStsProvider, string>> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  const credentials = {
    openai: values.OPENAI_API_KEY,
    gemini: values.GEMINI_API_KEY,
    xai: values.XAI_API_KEY,
  };
  for (const provider of ["openai", "gemini", "xai"] as const) {
    if (!credentials[provider] || credentials[provider].length < 12) {
      throw new Error(`explicit provider environment lacks the ${provider} credential`);
    }
  }
  return Object.freeze(credentials as Record<LiveStsProvider, string>);
}

async function gitOutput(...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", REPOSITORY_ROOT, ...args], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.trim();
}

async function toolchainEvidence(expectedAuthoritySha256: string): Promise<ToolchainEvidence> {
  const status = await gitOutput("status", "--porcelain=v1", "--untracked-files=all");
  if (status) throw new Error("output-voice capture requires a clean committed worktree");
  const sourceCommit = await gitOutput("rev-parse", "HEAD");
  if (!/^[a-f0-9]{40,64}$/u.test(sourceCommit)) throw new Error("source commit identity is invalid");
  const implementationFiles = Object.freeze(await Promise.all(IMPLEMENTATION_PATHS.map(async (path) => Object.freeze({
    path,
    sha256: sha256Hex(await readFile(resolve(REPOSITORY_ROOT, path))),
  }))));
  const implementationSha256 = sha256Hex(`hacc/output-voice-capture-implementation/v1\n${canonicalJson(implementationFiles)}`);
  const sourceCommitSha256 = sha256Hex(`hacc/output-voice-capture-source-commit/v1\n${sourceCommit}`);
  return Object.freeze({
    schemaVersion: 1,
    evidenceType: "hacc_output_voice_capture_toolchain",
    sourceCommit,
    sourceCommitSha256,
    implementationFiles,
    implementationSha256,
    captureAuthoritySha256: expectedAuthoritySha256,
  });
}

async function captureSigner(args: Arguments): Promise<OutputVoiceCaptureSigner> {
  await assertPrivateRegularFile(args.capturePrivateKey, "capture private key");
  const privateKey = createPrivateKey(await readFile(args.capturePrivateKey));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("capture private key must use Ed25519");
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const publicKeySha256 = sha256Hex(publicKey.export({ format: "der", type: "spki" }));
  if (publicKeySha256 !== args.expectedCaptureAuthoritySha256) {
    throw new Error("capture private key differs from the preregistered authority SHA-256");
  }
  return Object.freeze({
    privateKey,
    authority: Object.freeze({
      keyId: args.captureKeyId,
      publicKeyPem,
      publicKeySha256,
    }),
  });
}

async function writeExclusiveSynced(path: string, content: string | Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o400);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishCapture(input: Readonly<{
  outputRoot: string;
  toolchain: ToolchainEvidence;
  batch: Awaited<ReturnType<typeof captureOutputVoiceCalibration>>;
}>): Promise<void> {
  const parent = dirname(input.outputRoot);
  const stagingRoot = await mkdtemp(join(parent, `.${basename(input.outputRoot)}.staging-`));
  try {
    await mkdir(join(stagingRoot, "output-voice-calibration"), { mode: 0o700 });
    for (const capture of input.batch.captures) {
      const pcmPath = resolve(stagingRoot, capture.fixture.path);
      const wirePath = resolve(stagingRoot, outputVoiceCaptureWirePath(
        { provider: capture.fixture.provider, model: capture.fixture.model, voice: capture.fixture.voice },
        capture.fixture.slotId,
      ));
      for (const path of [pcmPath, wirePath]) {
        if (!path.startsWith(`${stagingRoot}${sep}`)) throw new Error("capture artifact path escapes staging root");
      }
      await mkdir(dirname(pcmPath), { recursive: true, mode: 0o700 });
      await writeExclusiveSynced(pcmPath, capture.pcm);
      await writeExclusiveSynced(wirePath, capture.sanitizedWireJsonl);
    }
    await writeExclusiveSynced(join(stagingRoot, "capture-toolchain.json"), `${canonicalJson(input.toolchain)}\n`);
    await writeExclusiveSynced(join(stagingRoot, "manifest.json"), `${canonicalJson(input.batch.manifest)}\n`);
    const directory = await open(stagingRoot, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    // Staging is a sibling, so this is one atomic publication boundary.
    await rename(stagingRoot, input.outputRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  process.umask(0o077);
  const args = argumentsFromProcess();
  await assertOutputDoesNotExist(args.outputRoot);
  await assertPrivateRegularFile(args.providerEnvFile, "provider environment file");
  const credentials = parseProviderCredentials(await readFile(args.providerEnvFile, "utf8"));
  const signer = await captureSigner(args);
  const toolchain = await toolchainEvidence(args.expectedCaptureAuthoritySha256);
  // No filesystem artifact is created until all 18 signed captures validate.
  const batch = await captureOutputVoiceCalibration({
    signer,
    toolchain: {
      implementationSha256: toolchain.implementationSha256,
      sourceCommitSha256: toolchain.sourceCommitSha256,
    },
    ...(args.responseTimeoutMs === undefined ? {} : { responseTimeoutMs: args.responseTimeoutMs }),
    createClient: (provider, configuration) => createProductionRealtimeClient(
      provider,
      configuration,
      credentials[provider],
    ),
  });
  await assertOutputDoesNotExist(args.outputRoot);
  await publishCapture({ outputRoot: args.outputRoot, toolchain, batch });
  process.stdout.write(`${canonicalJson({
    outputRoot: args.outputRoot,
    manifestPath: join(args.outputRoot, "manifest.json"),
    manifestSha256: batch.manifest.manifestSha256,
    captureAuthoritySha256: args.expectedCaptureAuthoritySha256,
    implementationSha256: toolchain.implementationSha256,
    sourceCommitSha256: toolchain.sourceCommitSha256,
    fixtureCount: batch.captures.length,
  })}\n`);
}

main().catch(() => {
  // Provider/library error text can contain user or provider material. Keep the
  // public CLI failure stable and credential-neutral; detailed proof stays in
  // the sanitized wire evidence only after a complete atomic publication.
  process.stderr.write("output-voice capture failed; no capture root was published\n");
  process.exitCode = 1;
});

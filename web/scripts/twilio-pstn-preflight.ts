#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import {
  runTwilioPstnPreflight,
  twilioPstnPreflightExitCode,
  type TwilioPstnPreflightSource,
} from "../lib/twilio-pstn-preflight";

const execFileAsync = promisify(execFile);

type CliOptions = Readonly<{
  maxUsd: string | undefined;
  probeReadOnly: boolean;
  outputPath: string | null;
}>;

function usage(): string {
  return "usage: npm run twilio:pstn:preflight -- --max-usd USD [--probe-read-only] [--out ABSOLUTE_PATH]";
}

function parseArguments(argv: readonly string[]): CliOptions {
  let maxUsd: string | undefined;
  let probeReadOnly = false;
  let outputPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--probe-read-only") {
      if (probeReadOnly) throw new Error("--probe-read-only may appear only once");
      probeReadOnly = true;
      continue;
    }
    if (argument === "--max-usd") {
      if (maxUsd !== undefined || index + 1 >= argv.length) throw new Error("--max-usd requires one value");
      maxUsd = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--out") {
      if (outputPath !== null || index + 1 >= argv.length) throw new Error("--out requires one value");
      const candidate = argv[index + 1];
      if (!isAbsolute(candidate) || resolve(candidate) !== candidate) {
        throw new Error("--out must be an absolute normalized path");
      }
      outputPath = candidate;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return Object.freeze({ maxUsd, probeReadOnly, outputPath });
}

async function git(repositoryRoot: string, ...args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function sourceBinding(repositoryRoot: string): Promise<TwilioPstnPreflightSource> {
  const [branch, commit, tree, status] = await Promise.all([
    git(repositoryRoot, "rev-parse", "--abbrev-ref", "HEAD"),
    git(repositoryRoot, "rev-parse", "HEAD"),
    git(repositoryRoot, "rev-parse", "HEAD^{tree}"),
    git(repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all"),
  ]);
  return Object.freeze({ branch, commit, tree, clean: status === "" });
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const webRoot = resolve(process.cwd());
  const repositoryRoot = resolve(webRoot, "..");
  const receipt = await runTwilioPstnPreflight({
    environment: process.env,
    source: await sourceBinding(repositoryRoot),
    requestedMaxUsd: options.maxUsd,
    probeReadOnly: options.probeReadOnly,
  });
  const encoded = `${JSON.stringify(receipt, null, 2)}\n`;
  if (options.outputPath) {
    await mkdir(dirname(options.outputPath), { recursive: true, mode: 0o700 });
    await writeFile(options.outputPath, encoded, { flag: "wx", mode: 0o600 });
  }
  process.stdout.write(encoded);
  process.exitCode = twilioPstnPreflightExitCode(receipt);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown command failure";
  process.stderr.write(`${usage()}\n${message}\n`);
  process.exitCode = 1;
});

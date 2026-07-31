#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { canonicalJson, sha256Hex } from "../lib/benchmark/artifacts";

const execFileAsync = promisify(execFile);
const RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-asr-environment-release-receipt/v1\n";
const TEST_PATHS = Object.freeze([
  "lib/benchmark/__tests__/lc4-development-default-runtime.integration.test.ts",
  "lib/benchmark/__tests__/lc4-development-whisper-runtime.integration.test.ts",
]);
const REQUIRED_ENVIRONMENT = Object.freeze([
  "LC4_DEV_AUDIO_ROOT",
  "LC4_DEV_CALIBRATION_ROOT",
  "LC4_DEV_WHISPER_CLI_PATH",
  "LC4_DEV_WHISPER_MODEL_PATH",
  "LC4_DEV_FFMPEG_PATH",
  "LC4_DEV_REAL_ASR_PCM_PATH",
  "LC4_DEV_EVIDENCE_ROOT",
]);

type FileEvidence = Readonly<{
  id: string;
  basename: string;
  byte_length: number;
  sha256: string;
}>;

function outputPath(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== "--out" || !isAbsolute(argv[1])) {
    throw new Error("usage: lc4-asr-environment-release-receipt --out ABSOLUTE_PATH");
  }
  return resolve(argv[1]);
}

function requiredPath(name: string): string {
  const value = process.env[name];
  if (!value || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${name} must be an absolute normalized path`);
  }
  return value;
}

async function fileEvidence(id: string, path: string): Promise<FileEvidence> {
  const bytes = await readFile(path);
  return Object.freeze({
    id,
    basename: basename(path),
    byte_length: bytes.byteLength,
    sha256: sha256Hex(bytes),
  });
}

async function git(repositoryRoot: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

function sanitizedTestEnvironment(paths: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    NODE_ENV: "test",
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    LC4_REAL_ASR_INTEGRATION: "1",
    ...paths,
  };
  for (const key of Object.keys(environment)) {
    if (/(?:API_KEY|AUTH_TOKEN|API_SECRET|ACCOUNT_SID)$/iu.test(key)) delete environment[key];
  }
  return environment;
}

async function main(): Promise<void> {
  const webRoot = resolve(process.cwd());
  const repositoryRoot = resolve(webRoot, "..");
  const destination = outputPath(process.argv.slice(2));
  const paths = Object.freeze(Object.fromEntries(
    REQUIRED_ENVIRONMENT.map((name) => [name, requiredPath(name)]),
  ));
  const status = await git(repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all");
  if (status !== "") {
    throw new Error("ASR environment release receipt requires a clean source tree");
  }
  const sourceCommit = await git(repositoryRoot, "rev-parse", "HEAD");
  const sourceTree = await git(repositoryRoot, "rev-parse", "HEAD^{tree}");
  const reportPath = `${destination}.vitest.json`;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await rm(reportPath, { force: true });

  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(
      resolve(webRoot, "node_modules/.bin/vitest"),
      ["run", ...TEST_PATHS, "--maxWorkers=1", "--reporter=json", `--outputFile=${reportPath}`],
      {
        cwd: webRoot,
        env: sanitizedTestEnvironment(paths),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 10 * 60_000,
      },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `real-ASR environment suite failed: ${failed.message ?? "unknown failure"}\n`
      + `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`,
    );
  }

  const reportBytes = await readFile(reportPath);
  const report = JSON.parse(reportBytes.toString("utf8")) as {
    success?: boolean;
    numTotalTests?: number;
    numPassedTests?: number;
    numFailedTests?: number;
    numPendingTests?: number;
    testResults?: Array<{ name?: string; status?: string }>;
  };
  const executed = (report.testResults ?? [])
    .map((entry) => entry.name ? relative(webRoot, resolve(entry.name)).split(sep).join("/") : "")
    .sort();
  if (
    report.success !== true
    || report.numTotalTests !== 3
    || report.numPassedTests !== 3
    || report.numFailedTests !== 0
    || report.numPendingTests !== 0
    || canonicalJson(executed) !== canonicalJson([...TEST_PATHS].sort())
    || report.testResults?.some((entry) => entry.status !== "passed")
  ) {
    throw new Error("real-ASR environment suite did not execute exactly two suites and three tests");
  }

  const inventoryPath = resolve(
    repositoryRoot,
    "benchmarks/voice-long-horizon/GATE0_SKIP_INVENTORY.json",
  );
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8")) as {
    source_binding?: { source_manifest_sha256?: string };
    entries?: Array<{ path?: string; gate0_disposition?: string }>;
  };
  const qualifiedPaths = (inventory.entries ?? [])
    .filter((entry) => entry.gate0_disposition === "environment_qualified_release_receipt")
    .map((entry) => entry.path?.slice("web/".length) ?? "")
    .sort();
  if (canonicalJson(qualifiedPaths) !== canonicalJson([...TEST_PATHS].sort())) {
    throw new Error("Gate 0 inventory environment-qualified suite selection drifted");
  }

  const evidence = await Promise.all([
    fileEvidence("inventory", inventoryPath),
    fileEvidence("audio_manifest", resolve(paths.LC4_DEV_AUDIO_ROOT, "manifest.json")),
    fileEvidence("repair_audio_manifest", resolve(paths.LC4_DEV_AUDIO_ROOT, "repair-manifest.json")),
    fileEvidence(
      "semantic_calibration_artifact",
      resolve(paths.LC4_DEV_CALIBRATION_ROOT, "calibration-artifact.json"),
    ),
    fileEvidence("real_asr_pcm", paths.LC4_DEV_REAL_ASR_PCM_PATH),
    fileEvidence("whisper_cli", paths.LC4_DEV_WHISPER_CLI_PATH),
    fileEvidence("whisper_model", paths.LC4_DEV_WHISPER_MODEL_PATH),
    fileEvidence("ffmpeg", paths.LC4_DEV_FFMPEG_PATH),
    ...TEST_PATHS.map((path) => fileEvidence(`test:${path}`, resolve(webRoot, path))),
  ]);
  const body = Object.freeze({
    schema_version: 1 as const,
    artifact_type: "lc4_asr_environment_release_receipt" as const,
    created_at: new Date().toISOString(),
    source: Object.freeze({
      commit: sourceCommit,
      tree: sourceTree,
      clean: true as const,
    }),
    inventory: Object.freeze({
      source_manifest_sha256: inventory.source_binding?.source_manifest_sha256 ?? "",
      qualified_suite_paths: qualifiedPaths,
    }),
    execution: Object.freeze({
      total_suites: 2,
      total_tests: 3,
      passed_tests: 3,
      failed_tests: 0,
      pending_tests: 0,
      provider_sessions_opened: 0,
      spend_usd: 0,
      stdout_sha256: sha256Hex(stdout),
      stderr_sha256: sha256Hex(stderr),
      vitest_report_sha256: sha256Hex(reportBytes),
    }),
    environment: Object.freeze({
      platform: process.platform,
      architecture: process.arch,
      absolute_paths_redacted: true as const,
      provider_credentials_removed: true as const,
    }),
    files: Object.freeze(evidence),
    claim_boundary: Object.freeze([
      "qualifies the pinned local ASR environment and retained assets at this exact clean source commit",
      "does not establish provider efficacy, model superiority, production safety, or benchmark score validity by itself",
      "required in addition to completed signed benchmark evidence before LC4 results may be published",
    ]),
  });
  const receipt = Object.freeze({
    ...body,
    receipt_sha256: sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(body)}`),
  });
  await writeFile(destination, `${canonicalJson(receipt)}\n`, { flag: "wx", mode: 0o600 });
  await rm(reportPath, { force: true });
  process.stdout.write(`${canonicalJson(receipt)}\n`);
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "ASR release receipt failed"}\n`);
  process.exitCode = 1;
});

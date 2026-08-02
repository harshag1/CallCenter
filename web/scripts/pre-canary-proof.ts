#!/usr/bin/env node

/**
 * One-shot, fail-closed Gate 0 proof assembler.
 *
 * This entrypoint deliberately has no import path to paid-runner, provider
 * clients, realtime adapters, or socket packages. It may execute provider-free
 * validation commands, but it can never release Gate 1 or authorize spend.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
} from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalJson, sha256Hex } from "../lib/benchmark/artifacts";
import {
  analyzePreCanaryMigrationSequence,
  createPreCanaryProofCheck,
  createPreCanaryProofPacket,
  preCanaryConditionalDatabaseTestsComplete,
  preCanarySourceSnapshotStable,
  preCanaryWebTestsComplete,
  verifyPreCanaryProofPacket,
  type PreCanaryProofCheck,
  type PreCanaryProofCommand,
  type PreCanaryProofPacketBody,
} from "../lib/benchmark/pre-canary-proof";
import { inspectFilesystemBudgetLedger } from "../lib/benchmark/filesystem-budget-ledger";
import {
  benchmarkFreezeLockSha256,
  parseCanonicalBenchmarkFreezeLock,
} from "../lib/benchmark/execution-plan";
import {
  PAID_PREFLIGHT_EMULATOR_MANIFEST_SHA256,
  PAID_PREFLIGHT_EMULATOR_TEST_FILE,
  PAID_PREFLIGHT_REQUIRED_TESTS,
  PAID_PREFLIGHT_TAMPER_TESTS,
} from "../lib/benchmark/paid-preflight-emulator-manifest";
import {
  parseCanonicalProviderPricingProof,
  verifyProviderPricingProof,
  type ProviderPricingProof,
} from "../lib/benchmark/provider-pricing-proof";

const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024 * 1024;
const ZERO_HASH = "0".repeat(64);
const ZERO_GIT_OBJECT = "0".repeat(40);
const PROVIDER_ENVIRONMENT_NAMES = new Set([
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ANTHROPIC_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_AUTH_TOKEN_NEXT",
  "TWILIO_API_KEY",
  "TWILIO_API_SECRET",
  "RESEND_API_KEY",
]);

type Options = Readonly<{
  ledgerPath: string | null;
  freezeLockPath: string | null;
  pricingProofDirectory: string | null;
  outputPath: string;
  quick: boolean;
}>;

type CommandResult = Readonly<{
  evidence: PreCanaryProofCommand;
  stdout: Buffer;
  stderr: Buffer;
}>;

type Artifact = PreCanaryProofPacketBody["artifacts"][number];

function parseArguments(argv: readonly string[], repositoryRoot: string): Options {
  let ledgerPath: string | null = null;
  let freezeLockPath: string | null = null;
  let pricingProofDirectory: string | null = null;
  let outputPath: string | null = null;
  let quick = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--quick") {
      quick = true;
      continue;
    }
    if (!["--ledger", "--freeze-lock", "--pricing-proof-dir", "--out"].includes(argument)) {
      throw new Error(`unknown pre-canary proof argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
    index += 1;
    const absolute = resolve(value);
    if (argument === "--ledger") ledgerPath = absolute;
    if (argument === "--freeze-lock") freezeLockPath = absolute;
    if (argument === "--pricing-proof-dir") pricingProofDirectory = absolute;
    if (argument === "--out") outputPath = absolute;
  }
  const stamp = new Date().toISOString().replaceAll(":", "-");
  return Object.freeze({
    ledgerPath,
    freezeLockPath,
    pricingProofDirectory,
    outputPath: outputPath ?? resolve(
      repositoryRoot,
      "benchmarks/voice-long-horizon/.local/precanary",
      `pre-canary-${stamp}.json`
    ),
    quick,
  });
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    CI: "1",
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
  };
  for (const name of Object.keys(environment)) {
    if (PROVIDER_ENVIRONMENT_NAMES.has(name) || /(?:API_KEY|AUTH_TOKEN|API_SECRET|ACCOUNT_SID)$/i.test(name)) {
      delete environment[name];
    }
  }
  return environment;
}

async function writeExclusiveRestricted(path: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

function safeEvidencePath(path: string, repositoryRoot: string): string {
  const normalizedRoot = repositoryRoot.endsWith(sep) ? repositoryRoot : `${repositoryRoot}${sep}`;
  if (path === repositoryRoot) return "<repo>";
  if (path.startsWith(normalizedRoot)) return `<repo>/${relative(repositoryRoot, path)}`;
  return `<local>/${basename(path)}`;
}

function safeEvidenceArgument(value: string, repositoryRoot: string): string {
  return value.startsWith(sep) ? safeEvidencePath(value, repositoryRoot) : value;
}

function parseJsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8").trim());
  } catch {
    throw new Error(`${label} did not emit one valid JSON document`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} JSON root is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function nonEmptyLines(...buffers: readonly Buffer[]): string[] {
  return buffers
    .map((buffer) => buffer.toString("utf8"))
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function fileArtifact(
  id: string,
  path: string,
  classification: Artifact["classification"],
  repositoryRoot: string
): Promise<Artifact> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`artifact is not a regular no-follow file: ${id}`);
  const bytes = await readFile(path);
  return Object.freeze({
    id,
    path: safeEvidencePath(path, repositoryRoot),
    sha256: sha256Hex(bytes),
    byte_length: bytes.byteLength,
    classification,
  });
}

async function artifactTree(root: string): Promise<Readonly<{
  count: number;
  paths: readonly string[];
  treeSha256: string;
  entries: ReadonlyMap<string, Readonly<{ sha256: string; bytes: Buffer }>>;
}>> {
  const entries = new Map<string, Readonly<{ sha256: string; bytes: Buffer }>>();
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = resolve(directory, entry.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`offline artifact tree contains symlink: ${relativePath}`);
      if (stat.isDirectory()) {
        await visit(absolute);
      } else if (stat.isFile()) {
        const bytes = await readFile(absolute);
        entries.set(relativePath, Object.freeze({ sha256: sha256Hex(bytes), bytes }));
      } else {
        throw new Error(`offline artifact tree contains non-regular entry: ${relativePath}`);
      }
    }
  }
  await visit(root);
  const paths = Object.freeze([...entries.keys()].sort());
  const manifest = paths.map((path) => ({
    path,
    sha256: entries.get(path)!.sha256,
    byte_length: entries.get(path)!.bytes.byteLength,
  }));
  return Object.freeze({
    count: paths.length,
    paths,
    treeSha256: sha256Hex(`hacc/offline-artifact-tree/v1\n${canonicalJson(manifest)}`),
    entries,
  });
}

function exactTreeMatch(
  left: Awaited<ReturnType<typeof artifactTree>>,
  right: Awaited<ReturnType<typeof artifactTree>>
): Readonly<{ paths: boolean; bytes: boolean }> {
  const paths = canonicalJson(left.paths) === canonicalJson(right.paths);
  const bytes = paths && left.paths.every((path) => left.entries.get(path)!.bytes.equals(right.entries.get(path)!.bytes));
  return Object.freeze({ paths, bytes });
}

async function main(): Promise<number> {
  const webRoot = resolve(process.cwd());
  const repositoryRoot = resolve(webRoot, "..");
  const options = parseArguments(process.argv.slice(2), repositoryRoot);
  const packetDirectory = dirname(options.outputPath);
  const logDirectory = resolve(packetDirectory, `${basename(options.outputPath, ".json")}.logs`);
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  await chmod(logDirectory, 0o700);

  const commands: PreCanaryProofCommand[] = [];
  const artifacts: Artifact[] = [];
  const checks = new Map<string, PreCanaryProofCheck>();
  const environment = sanitizedEnvironment();
  const skipInventoryPath = resolve(
    repositoryRoot,
    "benchmarks/voice-long-horizon/GATE0_SKIP_INVENTORY.json",
  );
  const skipInventoryBytes = await readFile(skipInventoryPath);
  const skipInventory = parseJsonObject(skipInventoryBytes, "Gate 0 skip inventory");
  if (
    !Array.isArray(skipInventory.entries)
    || !Number.isSafeInteger(skipInventory.total_skipped_suites_when_unconfigured)
    || !Number.isSafeInteger(skipInventory.total_skipped_tests_when_unconfigured)
    || !Number.isSafeInteger(skipInventory.public_ci_required_suites)
    || !Number.isSafeInteger(skipInventory.public_ci_required_tests)
    || !Number.isSafeInteger(skipInventory.environment_qualified_suites)
    || !Number.isSafeInteger(skipInventory.environment_qualified_tests)
    || skipInventory.total_skipped_suites_when_unconfigured !== skipInventory.entries.length
    || (skipInventory.total_skipped_suites_when_unconfigured as number) <= 0
    || (skipInventory.total_skipped_tests_when_unconfigured as number) <= 0
    || (skipInventory.public_ci_required_suites as number)
      + (skipInventory.environment_qualified_suites as number)
      !== skipInventory.total_skipped_suites_when_unconfigured
    || (skipInventory.public_ci_required_tests as number)
      + (skipInventory.environment_qualified_tests as number)
      !== skipInventory.total_skipped_tests_when_unconfigured
  ) {
    throw new Error("Gate 0 skip inventory has invalid conditional test totals");
  }
  const skipInventoryBinding = Object.freeze({
    sha256: sha256Hex(skipInventoryBytes),
    pending_test_count: skipInventory.total_skipped_tests_when_unconfigured as number,
    public_ci_test_file_count: skipInventory.public_ci_required_suites as number,
    public_ci_test_count: skipInventory.public_ci_required_tests as number,
  });
  artifacts.push(await fileArtifact(
    "gate0.skip_inventory",
    skipInventoryPath,
    "public",
    repositoryRoot,
  ));

  async function runCommand(
    id: string,
    executable: string,
    argv: readonly string[],
    cwd: string
  ): Promise<CommandResult> {
    const started = performance.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let overflow = false;
    const exitCode = await new Promise<number>((resolveExit) => {
      const child = spawn(executable, [...argv], {
        cwd,
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += bytes.byteLength;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        target.push(bytes);
      };
      child.stdout.on("data", collect(stdoutChunks));
      child.stderr.on("data", collect(stderrChunks));
      child.once("error", (error) => {
        stderrChunks.push(Buffer.from(`command spawn failed: ${error.name}\n`, "utf8"));
        resolveExit(255);
      });
      child.once("close", (code) => resolveExit(overflow ? 255 : code ?? 255));
    });
    const stdout = Buffer.concat(stdoutChunks);
    const stderr = Buffer.concat(stderrChunks);
    const stdoutPath = resolve(logDirectory, `${id}.stdout.log`);
    const stderrPath = resolve(logDirectory, `${id}.stderr.log`);
    const combinedPath = resolve(logDirectory, `${id}.combined.log`);
    const combined = Buffer.concat([
      Buffer.from("--- stdout ---\n", "utf8"),
      stdout,
      Buffer.from("\n--- stderr ---\n", "utf8"),
      stderr,
    ]);
    await writeExclusiveRestricted(stdoutPath, stdout);
    await writeExclusiveRestricted(stderrPath, stderr);
    await writeExclusiveRestricted(combinedPath, combined);
    artifacts.push(await fileArtifact(`${id}.stdout`, stdoutPath, "restricted_local", repositoryRoot));
    artifacts.push(await fileArtifact(`${id}.stderr`, stderrPath, "restricted_local", repositoryRoot));
    artifacts.push(await fileArtifact(`${id}.combined`, combinedPath, "restricted_local", repositoryRoot));
    const evidence: PreCanaryProofCommand = Object.freeze({
      id,
      cwd: safeEvidencePath(cwd, repositoryRoot),
      argv: [basename(executable), ...argv.map((value) => safeEvidenceArgument(value, repositoryRoot))],
      exit_code: exitCode,
      stdout_sha256: sha256Hex(stdout),
      stderr_sha256: sha256Hex(stderr),
      combined_log_sha256: sha256Hex(combined),
      raw_logs: "restricted_local_0600",
      provider_environment_removed: true,
      duration_ms: Math.max(0, Math.round(performance.now() - started)),
    });
    commands.push(evidence);
    return Object.freeze({ evidence, stdout, stderr });
  }

  function addCheck(input: Omit<PreCanaryProofCheck, "evidence_sha256">): void {
    if (checks.has(input.id)) throw new Error(`duplicate pre-canary check: ${input.id}`);
    checks.set(input.id, createPreCanaryProofCheck(input));
  }

  const gitHead = await runCommand("source.head", "git", ["rev-parse", "HEAD"], repositoryRoot);
  const gitTree = await runCommand("source.tree", "git", ["rev-parse", "HEAD^{tree}"], repositoryRoot);
  const gitStatusOpening = await runCommand(
    "source.status_open",
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repositoryRoot
  );
  const commit = gitHead.evidence.exit_code === 0 && /^[a-f0-9]{40,64}$/.test(gitHead.stdout.toString("ascii").trim())
    ? gitHead.stdout.toString("ascii").trim()
    : ZERO_GIT_OBJECT;
  const tree = gitTree.evidence.exit_code === 0 && /^[a-f0-9]{40,64}$/.test(gitTree.stdout.toString("ascii").trim())
    ? gitTree.stdout.toString("ascii").trim()
    : ZERO_GIT_OBJECT;

  const history = await runCommand(
    "source.public_history",
    resolve(webRoot, "node_modules/.bin/tsx"),
    ["scripts/public-history-audit.ts", repositoryRoot],
    webRoot
  );
  try {
    const report = parseJsonObject(history.stdout, "public history audit");
    const passed = history.evidence.exit_code === 0
      && report.schema_version === 2
      && report.complete === true
      && report.pass === true
      && report.head_commit === commit
      && typeof report.reachable_commit_count === "number"
      && report.reachable_commit_count > 0
      && typeof report.reachable_commit_set_sha256 === "string"
      && /^[a-f0-9]{64}$/.test(report.reachable_commit_set_sha256)
      && typeof report.reachable_ref_set_sha256 === "string"
      && /^[a-f0-9]{64}$/.test(report.reachable_ref_set_sha256)
      && typeof report.pattern_count === "number"
      && report.pattern_count >= 13
      && report.finding_count === 0
      && Array.isArray(report.findings)
      && report.findings.length === 0;
    addCheck({
      id: "source.public_history",
      status: passed ? "pass" : "fail",
      required_for: ["gate_0"],
      command_ids: [history.evidence.id],
      reason_codes: passed ? [] : ["history_findings_or_incomplete"],
      observed: {
        finding_count: typeof report.finding_count === "number" ? report.finding_count : -1,
        reachable_commit_count: typeof report.reachable_commit_count === "number" ? report.reachable_commit_count : 0,
        pattern_count: typeof report.pattern_count === "number" ? report.pattern_count : 0,
        complete: report.complete === true,
        pass: report.pass === true,
        head_commit_matches: report.head_commit === commit,
      },
    });
  } catch {
    addCheck({
      id: "source.public_history",
      status: "blocked",
      required_for: ["gate_0"],
      command_ids: [history.evidence.id],
      reason_codes: ["history_report_invalid"],
      observed: { finding_count: -1, reachable_commit_count: 0 },
    });
  }

  let publishableFileManifestSha256: string | null = null;
  const workingTreeScanner = resolve(webRoot, "scripts/working-tree-secret-audit.ts");
  if ((await lstat(workingTreeScanner).catch(() => null))?.isFile()) {
    const scan = await runCommand(
      "source.working_tree_secrets",
      resolve(webRoot, "node_modules/.bin/tsx"),
      ["scripts/working-tree-secret-audit.ts", repositoryRoot],
      webRoot
    );
    try {
      const report = parseJsonObject(scan.stdout, "working-tree secret audit");
      const candidateManifest = report.publishable_file_manifest_sha256;
      publishableFileManifestSha256 = typeof candidateManifest === "string" && /^[a-f0-9]{64}$/.test(candidateManifest)
        ? candidateManifest
        : null;
      const unresolvedFindings = Array.isArray(report.unresolved_findings) ? report.unresolved_findings : null;
      const allowlist = report.allowlist && typeof report.allowlist === "object"
        ? report.allowlist as Record<string, unknown>
        : null;
      const passed = scan.evidence.exit_code === 0
        && report.schema_version === 1
        && report.kind === "hacc_public_worktree_secret_audit"
        && report.inventory_contract === "tracked_plus_nonignored_untracked"
        && report.ignored_files_scanned === false
        && report.complete === true
        && report.pass === true
        && report.head_commit === commit
        && report.head_tree === tree
        && report.git_status_sha256 === sha256Hex(gitStatusOpening.stdout)
        && report.finding_count === 0
        && report.unresolved_finding_count === 0
        && unresolvedFindings !== null
        && unresolvedFindings.length === 0
        && typeof report.publishable_file_count === "number"
        && report.publishable_file_count > 0
        && allowlist !== null
        && Array.isArray(allowlist.unused_entry_ids)
        && allowlist.unused_entry_ids.length === 0
        && publishableFileManifestSha256 !== null;
      addCheck({
        id: "source.working_tree_secrets",
        status: passed ? "pass" : "fail",
        required_for: ["gate_0"],
        command_ids: [scan.evidence.id],
        reason_codes: passed ? [] : ["working_tree_findings_or_incomplete"],
        observed: {
          finding_count: typeof report.finding_count === "number" ? report.finding_count : -1,
          publishable_file_count: typeof report.publishable_file_count === "number" ? report.publishable_file_count : 0,
          complete: report.complete === true,
          pass: report.pass === true,
          head_commit_matches: report.head_commit === commit,
          head_tree_matches: report.head_tree === tree,
          git_status_matches: report.git_status_sha256 === sha256Hex(gitStatusOpening.stdout),
          unused_allowlist_entries: Array.isArray(allowlist?.unused_entry_ids) ? allowlist.unused_entry_ids.length : -1,
        },
      });
    } catch {
      addCheck({
        id: "source.working_tree_secrets",
        status: "blocked",
        required_for: ["gate_0"],
        command_ids: [scan.evidence.id],
        reason_codes: ["working_tree_secret_report_invalid"],
        observed: { finding_count: -1, publishable_file_count: 0 },
      });
    }
  } else {
    addCheck({
      id: "source.working_tree_secrets",
      status: "blocked",
      required_for: ["gate_0"],
      command_ids: [],
      reason_codes: ["working_tree_secret_scanner_missing"],
      observed: { finding_count: -1, publishable_file_count: 0 },
    });
  }

  let providerBoundary: PreCanaryProofPacketBody["provider_boundary"] = {
    offline_entrypoint: "web/scripts/voice-benchmark-offline.ts",
    runtime_import_closure_sha256: ZERO_HASH,
    runtime_input_count: 1,
    packet_entrypoint: "web/scripts/pre-canary-proof.ts",
    packet_runtime_import_closure_sha256: ZERO_HASH,
    packet_runtime_input_count: 1,
    forbidden_runtime_inputs: ["import_audit_incomplete"],
    external_socket_imports: [],
    provider_client_construction_reachable: true,
    paid_executor_supplied: false,
    packet_provider_sessions_opened: 0,
    validation_contract_constructs_idle_clients: true,
  };
  const importAudit = await runCommand(
    "provider.offline_imports",
    resolve(webRoot, "node_modules/.bin/tsx"),
    ["scripts/check-offline-benchmark-imports.ts"],
    webRoot
  );
  const packetImportAudit = await runCommand(
    "provider.packet_imports",
    resolve(webRoot, "node_modules/.bin/tsx"),
    ["scripts/check-pre-canary-imports.ts"],
    webRoot
  );
  try {
    const report = parseJsonObject(importAudit.stdout, "offline import audit");
    const packetReport = parseJsonObject(packetImportAudit.stdout, "pre-canary import audit");
    const offlineForbidden = Array.isArray(report.forbidden_runtime_inputs)
      ? report.forbidden_runtime_inputs.filter((value): value is string => typeof value === "string")
      : ["malformed_forbidden_runtime_inputs"];
    const packetForbidden = Array.isArray(packetReport.forbidden_runtime_inputs)
      ? packetReport.forbidden_runtime_inputs.filter((value): value is string => typeof value === "string")
      : ["malformed_packet_forbidden_runtime_inputs"];
    const offlineSockets = Array.isArray(report.external_socket_imports)
      ? report.external_socket_imports.filter((value): value is string => typeof value === "string")
      : ["malformed_external_socket_imports"];
    const packetSockets = Array.isArray(packetReport.external_socket_imports)
      ? packetReport.external_socket_imports.filter((value): value is string => typeof value === "string")
      : ["malformed_packet_external_socket_imports"];
    const forbidden = [...offlineForbidden, ...packetForbidden];
    const sockets = [...offlineSockets, ...packetSockets];
    providerBoundary = {
      ...providerBoundary,
      runtime_import_closure_sha256: typeof report.runtime_import_closure_sha256 === "string"
        && /^[a-f0-9]{64}$/.test(report.runtime_import_closure_sha256)
        ? report.runtime_import_closure_sha256
        : ZERO_HASH,
      runtime_input_count: typeof report.runtime_input_count === "number" && report.runtime_input_count > 0
        ? report.runtime_input_count
        : 1,
      packet_runtime_import_closure_sha256: typeof packetReport.runtime_import_closure_sha256 === "string"
        && /^[a-f0-9]{64}$/.test(packetReport.runtime_import_closure_sha256)
        ? packetReport.runtime_import_closure_sha256
        : ZERO_HASH,
      packet_runtime_input_count: typeof packetReport.runtime_input_count === "number"
        && packetReport.runtime_input_count > 0
        ? packetReport.runtime_input_count
        : 1,
      forbidden_runtime_inputs: forbidden,
      external_socket_imports: sockets,
      provider_client_construction_reachable: report.provider_client_construction_reachable !== false
        || packetReport.provider_client_construction_reachable !== false,
    };
    const passed = importAudit.evidence.exit_code === 0
      && packetImportAudit.evidence.exit_code === 0
      && report.schema_version === 1
      && report.entry === "scripts/voice-benchmark-offline.ts"
      && packetReport.schema_version === 1
      && packetReport.entry === "scripts/pre-canary-proof.ts"
      && providerBoundary.runtime_import_closure_sha256 !== ZERO_HASH
      && providerBoundary.packet_runtime_import_closure_sha256 !== ZERO_HASH
      && report.provider_client_construction_reachable === false
      && packetReport.provider_client_construction_reachable === false
      && forbidden.length === 0
      && sockets.length === 0;
    addCheck({
      id: "provider.offline_import_boundary",
      status: passed ? "pass" : "fail",
      required_for: ["gate_0"],
      command_ids: [importAudit.evidence.id, packetImportAudit.evidence.id],
      reason_codes: passed ? [] : ["provider_capability_reachable"],
      observed: {
        runtime_input_count: providerBoundary.runtime_input_count,
        packet_runtime_input_count: providerBoundary.packet_runtime_input_count,
        forbidden_runtime_input_count: forbidden.length,
        external_socket_import_count: sockets.length,
      },
    });
  } catch {
    addCheck({
      id: "provider.offline_import_boundary",
      status: "blocked",
      required_for: ["gate_0"],
      command_ids: [importAudit.evidence.id, packetImportAudit.evidence.id],
      reason_codes: ["offline_import_report_invalid"],
      observed: { runtime_input_count: 0 },
    });
  }

  const preflightTest = resolve(webRoot, PAID_PREFLIGHT_EMULATOR_TEST_FILE);
  if ((await lstat(preflightTest).catch(() => null))?.isFile()) {
    const reportPath = resolve(logDirectory, "provider.paid_preflight.report.json");
    const preflight = await runCommand(
      "provider.paid_preflight",
      resolve(webRoot, "node_modules/.bin/vitest"),
      [
        "run",
        PAID_PREFLIGHT_EMULATOR_TEST_FILE,
        "--reporter=json",
        `--outputFile=${reportPath}`,
      ],
      webRoot
    );
    let passed = false;
    let passedTests = 0;
    let totalTests = 0;
    try {
      const report = parseJsonObject(await readFile(reportPath), "paid preflight emulator report");
      passedTests = typeof report.numPassedTests === "number" ? report.numPassedTests : 0;
      totalTests = typeof report.numTotalTests === "number" ? report.numTotalTests : 0;
      const testResults = Array.isArray(report.testResults) ? report.testResults : [];
      const assertions = testResults.flatMap((result) => (
        result && typeof result === "object" && Array.isArray((result as Record<string, unknown>).assertionResults)
          ? (result as { assertionResults: unknown[] }).assertionResults
          : []
      ));
      const passingTitles = new Set(assertions.flatMap((assertion) => (
        assertion && typeof assertion === "object"
        && (assertion as Record<string, unknown>).status === "passed"
        && typeof (assertion as Record<string, unknown>).title === "string"
          ? [(assertion as Record<string, string>).title]
          : []
      )));
      const requiredManifestPassed = PAID_PREFLIGHT_REQUIRED_TESTS.every((title) => passingTitles.has(title));
      passed = preflight.evidence.exit_code === 0
        && report.success === true
        && report.numFailedTests === 0
        && report.numFailedTestSuites === 0
        && totalTests >= PAID_PREFLIGHT_REQUIRED_TESTS.length
        && passedTests === totalTests
        && requiredManifestPassed;
      artifacts.push(await fileArtifact("provider.paid_preflight.report", reportPath, "restricted_local", repositoryRoot));
      artifacts.push(await fileArtifact("provider.paid_preflight.source", preflightTest, "public", repositoryRoot));
    } catch {
      passed = false;
    }
    addCheck({
      id: "provider.paid_preflight_emulator",
      status: passed ? "pass" : "fail",
      required_for: ["gate_0"],
      command_ids: [preflight.evidence.id],
      reason_codes: passed ? [] : ["paid_preflight_emulator_failed"],
      observed: {
        tamper_credential_reads: passed ? 0 : -1,
        tamper_client_constructions: passed ? 0 : -1,
        tamper_reservations_consumed: passed ? 0 : -1,
        tamper_cases_passed: passed ? PAID_PREFLIGHT_TAMPER_TESTS.length : 0,
        tamper_cases_total: PAID_PREFLIGHT_TAMPER_TESTS.length,
        happy_path_passed: passed,
        manifest_sha256: PAID_PREFLIGHT_EMULATOR_MANIFEST_SHA256,
      },
    });
  } else {
    addCheck({
      id: "provider.paid_preflight_emulator",
      status: "blocked",
      required_for: ["gate_0"],
      command_ids: [],
      reason_codes: ["paid_preflight_emulator_missing"],
      observed: {
        tamper_credential_reads: -1,
        tamper_client_constructions: -1,
        tamper_reservations_consumed: -1,
        tamper_cases_passed: 0,
        tamper_cases_total: PAID_PREFLIGHT_TAMPER_TESTS.length,
        happy_path_passed: false,
        manifest_sha256: PAID_PREFLIGHT_EMULATOR_MANIFEST_SHA256,
      },
    });
  }

  let budget: PreCanaryProofPacketBody["budget"] = {
    ledger_verified: false,
    ledger_id: null,
    ledger_head_sha256: null,
    state: "missing",
    paused: false,
    active_reservations_micro_usd: 0,
    conservative_settled_micro_usd: 0,
    scheduling_exposure_micro_usd: 0,
    provider_spend_usd: "0",
  };
  if (options.ledgerPath) {
    try {
      const snapshot = await inspectFilesystemBudgetLedger({ ledgerPath: options.ledgerPath });
      budget = {
        ledger_verified: true,
        ledger_id: snapshot.ledger_id,
        ledger_head_sha256: snapshot.head_sha256,
        state: snapshot.paused
          ? "paused"
          : snapshot.state === "open"
            ? "open"
            : "closed",
        paused: snapshot.paused,
        active_reservations_micro_usd: snapshot.active_reservations_micro_usd,
        conservative_settled_micro_usd: snapshot.conservative_settled_micro_usd,
        scheduling_exposure_micro_usd: snapshot.scheduling_exposure_micro_usd,
        provider_spend_usd: "0",
      };
    } catch {
      budget = { ...budget, state: "invalid" };
    }
  }
  const budgetPassed = budget.ledger_verified
    && budget.state === "paused"
    && budget.paused
    && budget.active_reservations_micro_usd === 0
    && budget.conservative_settled_micro_usd === 0
    && budget.scheduling_exposure_micro_usd === 0;
  addCheck({
    id: "budget.paused_zero",
    status: budgetPassed ? "pass" : options.ledgerPath ? "fail" : "blocked",
    required_for: ["gate_0"],
    command_ids: [],
    reason_codes: budgetPassed ? [] : [options.ledgerPath ? "ledger_not_paused_zero" : "ledger_missing"],
    observed: {
      ledger_verified: budget.ledger_verified,
      paused: budget.paused,
      active_reservations_micro_usd: budget.active_reservations_micro_usd,
      conservative_settled_micro_usd: budget.conservative_settled_micro_usd,
      scheduling_exposure_micro_usd: budget.scheduling_exposure_micro_usd,
    },
  });

  let freeze: PreCanaryProofPacketBody["freeze"] = {
    verified: false,
    freeze_lock_sha256: null,
    evidence_class: "missing",
    source_commit_matches: false,
  };
  if (options.freezeLockPath) {
    const validation = await runCommand(
      "freeze.validate",
      resolve(webRoot, "node_modules/.bin/tsx"),
      [
        "scripts/voice-benchmark-offline.ts",
        "validate",
        "--freeze-lock",
        options.freezeLockPath,
        "--json",
      ],
      webRoot
    );
    try {
      const lock = parseCanonicalBenchmarkFreezeLock(await readFile(options.freezeLockPath));
      const report = parseJsonObject(validation.stdout, "freeze validation");
      const hash = benchmarkFreezeLockSha256(lock);
      const sourceCommitMatches = lock.source_commit === commit;
      const verified = validation.evidence.exit_code === 0
        && report.valid === true
        && report.network_calls === 0
        && report.spend_usd === "0"
        && report.freeze_lock_sha256 === hash
        && report.evidence_class === lock.evidence_class
        && sourceCommitMatches;
      freeze = {
        verified,
        freeze_lock_sha256: hash,
        evidence_class: lock.evidence_class,
        source_commit_matches: sourceCommitMatches,
      };
      artifacts.push(await fileArtifact("freeze.lock", options.freezeLockPath, "restricted_local", repositoryRoot));
      addCheck({
        id: "freeze.verified",
        status: verified ? "pass" : "fail",
        required_for: ["gate_0"],
        command_ids: [validation.evidence.id],
        reason_codes: verified ? [] : ["freeze_checkout_or_source_mismatch"],
        observed: { source_commit_matches: sourceCommitMatches, validation_valid: report.valid === true },
      });
    } catch {
      freeze = { ...freeze, evidence_class: "missing" };
      addCheck({
        id: "freeze.verified",
        status: "fail",
        required_for: ["gate_0"],
        command_ids: [validation.evidence.id],
        reason_codes: ["freeze_invalid"],
        observed: { source_commit_matches: false, validation_valid: false },
      });
    }
  } else {
    addCheck({
      id: "freeze.verified",
      status: "blocked",
      required_for: ["gate_0"],
      command_ids: [],
      reason_codes: ["freeze_missing"],
      observed: { source_commit_matches: false, validation_valid: false },
    });
  }

  async function runVitestCheck(
    checkId: string,
    commandId: string,
    files: readonly string[] | null,
    requiredFor: readonly ("gate_0" | "gate_1" | "c3" | "c4" | "c5")[] = ["gate_0"]
  ): Promise<void> {
    if (options.quick && files === null) {
      addCheck({
        id: checkId,
        status: "blocked",
        required_for: [...requiredFor],
        command_ids: [],
        reason_codes: ["quick_mode_skipped"],
        observed: { total_tests: 0, passed_tests: 0, failed_tests: 0 },
      });
      return;
    }
    const reportPath = resolve(logDirectory, `${commandId}.report.json`);
    const args = ["run", ...(files ?? []), "--reporter=json", `--outputFile=${reportPath}`];
    const result = await runCommand(commandId, resolve(webRoot, "node_modules/.bin/vitest"), args, webRoot);
    try {
      const report = parseJsonObject(await readFile(reportPath), `${checkId} Vitest report`);
      const totalTests = typeof report.numTotalTests === "number"
        ? report.numTotalTests
        : 0;
      const passedTests = typeof report.numPassedTests === "number"
        ? report.numPassedTests
        : 0;
      const failedTests = typeof report.numFailedTests === "number"
        ? report.numFailedTests
        : -1;
      const pendingTests = typeof report.numPendingTests === "number"
        ? report.numPendingTests
        : -1;
      const passed = preCanaryWebTestsComplete({
        exit_code: result.evidence.exit_code,
        success: report.success === true,
        total_tests: totalTests,
        passed_tests: passedTests,
        failed_tests: failedTests,
        pending_tests: pendingTests,
        expected_conditional_pending_tests: skipInventoryBinding.pending_test_count,
      }) && report.numFailedTestSuites === 0;
      artifacts.push(await fileArtifact(`${commandId}.report`, reportPath, "restricted_local", repositoryRoot));
      addCheck({
        id: checkId,
        status: passed ? "pass" : "fail",
        required_for: [...requiredFor],
        command_ids: [result.evidence.id],
        reason_codes: passed ? [] : ["test_failures_or_incomplete_report"],
        observed: {
          total_tests: totalTests,
          passed_tests: passedTests,
          failed_tests: failedTests,
          pending_tests: pendingTests,
          expected_conditional_pending_tests: skipInventoryBinding.pending_test_count,
          conditional_inventory_sha256: skipInventoryBinding.sha256,
          failed_suites: typeof report.numFailedTestSuites === "number" ? report.numFailedTestSuites : -1,
        },
      });
    } catch {
      addCheck({
        id: checkId,
        status: "fail",
        required_for: [...requiredFor],
        command_ids: [result.evidence.id],
        reason_codes: ["test_report_invalid"],
        observed: { total_tests: 0, passed_tests: 0, failed_tests: -1 },
      });
    }
  }

  await runVitestCheck("web.tests", "web.tests", null);

  if (options.quick) {
    addCheck({
      id: "web.lint",
      status: "blocked",
      required_for: ["gate_0"],
      command_ids: [],
      reason_codes: ["quick_mode_skipped"],
      observed: { error_count: 0, warning_count: 0, file_count: 0 },
    });
    addCheck({
      id: "web.typecheck",
      status: "blocked",
      required_for: ["gate_0"],
      command_ids: [],
      reason_codes: ["quick_mode_skipped"],
      observed: { diagnostic_line_count: 0 },
    });
    addCheck({
      id: "web.build",
      status: "blocked",
      required_for: ["gate_0"],
      command_ids: [],
      reason_codes: ["quick_mode_skipped"],
      observed: { build_id_present: false, routes_manifest_valid: false },
    });
  } else {
    const lintReportPath = resolve(logDirectory, "web.lint.report.json");
    const lint = await runCommand(
      "web.lint",
      resolve(webRoot, "node_modules/.bin/eslint"),
      [".", "--max-warnings=0", "--format=json", `--output-file=${lintReportPath}`],
      webRoot
    );
    try {
      const report = JSON.parse((await readFile(lintReportPath, "utf8")).trim()) as unknown;
      if (!Array.isArray(report)) throw new Error("lint report is not an array");
      const errorCount = report.reduce((sum, value) => sum + (
        value && typeof value === "object" && typeof (value as Record<string, unknown>).errorCount === "number"
          ? (value as Record<string, number>).errorCount
          : 1
      ), 0);
      const warningCount = report.reduce((sum, value) => sum + (
        value && typeof value === "object" && typeof (value as Record<string, unknown>).warningCount === "number"
          ? (value as Record<string, number>).warningCount
          : 1
      ), 0);
      const passed = lint.evidence.exit_code === 0 && report.length > 0 && errorCount === 0 && warningCount === 0;
      artifacts.push(await fileArtifact("web.lint.report", lintReportPath, "restricted_local", repositoryRoot));
      addCheck({
        id: "web.lint",
        status: passed ? "pass" : "fail",
        required_for: ["gate_0"],
        command_ids: [lint.evidence.id],
        reason_codes: passed ? [] : ["lint_errors_or_warnings"],
        observed: { error_count: errorCount, warning_count: warningCount, file_count: report.length },
      });
    } catch {
      addCheck({
        id: "web.lint",
        status: "fail",
        required_for: ["gate_0"],
        command_ids: [lint.evidence.id],
        reason_codes: ["lint_report_invalid"],
        observed: { error_count: -1, warning_count: -1, file_count: 0 },
      });
    }

    const typecheck = await runCommand(
      "web.typecheck",
      resolve(webRoot, "node_modules/.bin/tsc"),
      ["--noEmit", "--pretty", "false"],
      webRoot
    );
    const diagnostics = nonEmptyLines(typecheck.stdout, typecheck.stderr);
    const typecheckPassed = typecheck.evidence.exit_code === 0 && diagnostics.length === 0;
    addCheck({
      id: "web.typecheck",
      status: typecheckPassed ? "pass" : "fail",
      required_for: ["gate_0"],
      command_ids: [typecheck.evidence.id],
      reason_codes: typecheckPassed ? [] : ["typescript_diagnostics"],
      observed: { diagnostic_line_count: diagnostics.length },
    });

    const build = await runCommand("web.build", "npm", ["run", "build"], webRoot);
    let buildIdPresent = false;
    let routesManifestValid = false;
    try {
      buildIdPresent = (await readFile(resolve(webRoot, ".next/BUILD_ID"), "utf8")).trim().length > 0;
      const routes = JSON.parse(await readFile(resolve(webRoot, ".next/routes-manifest.json"), "utf8")) as unknown;
      routesManifestValid = Boolean(routes && typeof routes === "object");
    } catch {
      // Structured build outputs are mandatory proof fields.
    }
    const buildPassed = build.evidence.exit_code === 0 && buildIdPresent && routesManifestValid;
    addCheck({
      id: "web.build",
      status: buildPassed ? "pass" : "fail",
      required_for: ["gate_0"],
      command_ids: [build.evidence.id],
      reason_codes: buildPassed ? [] : ["build_artifacts_incomplete"],
      observed: { build_id_present: buildIdPresent, routes_manifest_valid: routesManifestValid },
    });
  }

  if (options.quick) {
    for (const [id, reason] of [
      ["bridge.syntax", "quick_mode_skipped"],
      ["bridge.tests", "quick_mode_skipped"],
      ["database.isolation", "quick_mode_skipped"],
    ] as const) {
      addCheck({
        id,
        status: "blocked",
        required_for: ["gate_0"],
        command_ids: [],
        reason_codes: [reason],
        observed: { asserted: false },
      });
    }
  } else {
    const bridgeRoot = resolve(repositoryRoot, "bridge");
    const syntax = await runCommand("bridge.syntax", "npm", ["run", "check"], bridgeRoot);
    const bridgeSourceCount = (await readdir(resolve(bridgeRoot, "lib"))).filter((name) => name.endsWith(".js")).length + 1;
    const syntaxDiagnostics = nonEmptyLines(syntax.stderr);
    const syntaxPassed = syntax.evidence.exit_code === 0 && bridgeSourceCount > 1 && syntaxDiagnostics.length === 0;
    addCheck({
      id: "bridge.syntax",
      status: syntaxPassed ? "pass" : "fail",
      required_for: ["gate_0"],
      command_ids: [syntax.evidence.id],
      reason_codes: syntaxPassed ? [] : ["bridge_syntax_failed"],
      observed: { javascript_file_count: bridgeSourceCount, diagnostic_line_count: syntaxDiagnostics.length },
    });

    const testDirectory = resolve(bridgeRoot, "test");
    const bridgeTestFiles = (await readdir(testDirectory))
      .filter((name) => name.endsWith(".test.js"))
      .sort()
      .map((name) => resolve(testDirectory, name));
    const bridgeTests = await runCommand(
      "bridge.tests",
      process.execPath,
      ["--test", "--test-reporter=tap", ...bridgeTestFiles],
      bridgeRoot
    );
    const tap = bridgeTests.stdout.toString("utf8");
    const tests = Number(/# tests (\d+)/.exec(tap)?.[1] ?? 0);
    const passedTests = Number(/# pass (\d+)/.exec(tap)?.[1] ?? 0);
    const failedTests = Number(/# fail (\d+)/.exec(tap)?.[1] ?? -1);
    const bridgePassed = bridgeTests.evidence.exit_code === 0
      && bridgeTestFiles.length > 0
      && tests > 0
      && passedTests === tests
      && failedTests === 0;
    addCheck({
      id: "bridge.tests",
      status: bridgePassed ? "pass" : "fail",
      required_for: ["gate_0"],
      command_ids: [bridgeTests.evidence.id],
      reason_codes: bridgePassed ? [] : ["bridge_tests_failed_or_unparseable"],
      observed: { test_file_count: bridgeTestFiles.length, total_tests: tests, passed_tests: passedTests, failed_tests: failedTests },
    });

    const migrationSequence = analyzePreCanaryMigrationSequence(
      await readdir(resolve(webRoot, "migrations")),
    );
    const migrationFiles = migrationSequence.canonical_files;
    const migrationManifest = await Promise.all(migrationFiles.map(async (name) => ({
      path: `web/migrations/${name}`,
      sha256: sha256Hex(await readFile(resolve(webRoot, "migrations", name))),
    })));
    const migrationManifestSha256 = sha256Hex(
      `hacc/migration-manifest/v1\n${canonicalJson(migrationManifest)}`
    );
    const migrationIds = migrationFiles.map((name) => Number.parseInt(name.slice(0, 3), 10));
    const database = await runCommand(
      "database.isolation",
      "npm",
      ["run", "--silent", "db:test-integration"],
      webRoot,
    );
    try {
      const report = parseJsonObject(database.stdout, "database isolation report");
      const reapplications = report.migration_reapplications;
      const conditionalDatabaseTests = report.conditional_database_tests;
      const conditionalDatabaseReport = conditionalDatabaseTests
        && typeof conditionalDatabaseTests === "object"
        && !Array.isArray(conditionalDatabaseTests)
        ? conditionalDatabaseTests as Record<string, unknown>
        : {};
      const latestMigrationsReapplied = Boolean(reapplications && typeof reapplications === "object"
        && migrationIds.filter((id) => id >= 16).every((id) => (
          (() => {
            const key = id.toString().padStart(3, "0");
            return typeof (reapplications as Record<string, unknown>)[key] === "number"
              && Number((reapplications as Record<string, unknown>)[key]) >= 2;
          })()
        )));
      const conditionalDatabaseTestsPassed =
        preCanaryConditionalDatabaseTestsComplete({
          inventory_sha256:
            typeof conditionalDatabaseReport.inventory_sha256 === "string"
              ? conditionalDatabaseReport.inventory_sha256
              : "",
          expected_inventory_sha256: skipInventoryBinding.sha256,
          test_file_count:
            typeof conditionalDatabaseReport.test_file_count === "number"
              ? conditionalDatabaseReport.test_file_count
              : 0,
          expected_test_file_count: skipInventoryBinding.public_ci_test_file_count,
          total_tests:
            typeof conditionalDatabaseReport.total_tests === "number"
              ? conditionalDatabaseReport.total_tests
              : 0,
          expected_total_tests: skipInventoryBinding.public_ci_test_count,
          passed_tests:
            typeof conditionalDatabaseReport.passed_tests === "number"
              ? conditionalDatabaseReport.passed_tests
              : 0,
          failed_tests:
            typeof conditionalDatabaseReport.failed_tests === "number"
              ? conditionalDatabaseReport.failed_tests
              : -1,
          pending_tests:
            typeof conditionalDatabaseReport.pending_tests === "number"
              ? conditionalDatabaseReport.pending_tests
              : -1,
          provider_sessions_opened:
            typeof conditionalDatabaseReport.provider_sessions_opened === "number"
              ? conditionalDatabaseReport.provider_sessions_opened
              : -1,
          spend_usd:
            typeof conditionalDatabaseReport.spend_usd === "number"
              ? conditionalDatabaseReport.spend_usd
              : -1,
        });
      const passed = database.evidence.exit_code === 0
        && report.ok === true
        && migrationSequence.contiguous_from_001_to_latest
        && report.migrations === migrationFiles.length
        && latestMigrationsReapplied
        && conditionalDatabaseTestsPassed
        && report.provider_sessions_opened === 0
        && report.spend_usd === 0
        && report.database === "disposable-local-postgres";
      addCheck({
        id: "database.isolation",
        status: passed ? "pass" : "fail",
        required_for: ["gate_0"],
        command_ids: [database.evidence.id],
        reason_codes: passed ? [] : ["database_isolation_incomplete"],
        observed: {
          migration_count: typeof report.migrations === "number" ? report.migrations : 0,
          migration_manifest_sha256: migrationManifestSha256,
          migration_first_id: migrationSequence.first_id,
          migration_latest_id: migrationSequence.latest_id,
          invalid_sql_filename_count: migrationSequence.invalid_sql_filename_count,
          duplicate_migration_id_count: migrationSequence.duplicate_id_count,
          contiguous_001_through_latest:
            migrationSequence.contiguous_from_001_to_latest,
          latest_boundary_reapplied: latestMigrationsReapplied,
          conditional_inventory_sha256:
            typeof conditionalDatabaseReport.inventory_sha256 === "string"
              ? conditionalDatabaseReport.inventory_sha256
              : "",
          conditional_test_file_count:
            typeof conditionalDatabaseReport.test_file_count === "number"
              ? conditionalDatabaseReport.test_file_count
              : 0,
          conditional_total_tests:
            typeof conditionalDatabaseReport.total_tests === "number"
              ? conditionalDatabaseReport.total_tests
              : 0,
          conditional_passed_tests:
            typeof conditionalDatabaseReport.passed_tests === "number"
              ? conditionalDatabaseReport.passed_tests
              : 0,
          conditional_failed_tests:
            typeof conditionalDatabaseReport.failed_tests === "number"
              ? conditionalDatabaseReport.failed_tests
              : -1,
          conditional_pending_tests:
            typeof conditionalDatabaseReport.pending_tests === "number"
              ? conditionalDatabaseReport.pending_tests
              : -1,
          provider_sessions_opened: typeof report.provider_sessions_opened === "number" ? report.provider_sessions_opened : -1,
          spend_usd: typeof report.spend_usd === "number" ? report.spend_usd : -1,
        },
      });
    } catch {
      addCheck({
        id: "database.isolation",
        status: "fail",
        required_for: ["gate_0"],
        command_ids: [database.evidence.id],
        reason_codes: ["database_isolation_report_invalid"],
        observed: { migration_count: 0, provider_sessions_opened: -1 },
      });
    }
  }

  const manifest = await runCommand(
    "manifest.long_horizon",
    resolve(webRoot, "node_modules/.bin/tsx"),
    ["scripts/generate-long-horizon-manifest.ts", "--check"],
    webRoot
  );
  const manifestLines = nonEmptyLines(manifest.stdout, manifest.stderr);
  const manifestPassed = manifest.evidence.exit_code === 0
    && manifestLines.length === 1
    && manifestLines[0] === "long-horizon manifest is current";
  addCheck({
    id: "manifest.long_horizon",
    status: manifestPassed ? "pass" : "fail",
    required_for: ["gate_0"],
    command_ids: [manifest.evidence.id],
    reason_codes: manifestPassed ? [] : ["long_horizon_manifest_stale"],
    observed: { exact_current_message: manifestPassed },
  });

  const transcript = await runCommand(
    "transcript.signed_replay",
    resolve(webRoot, "node_modules/.bin/tsx"),
    ["scripts/kernel-transcript-benchmark.ts"],
    webRoot
  );
  try {
    const report = parseJsonObject(transcript.stdout, "kernel transcript benchmark");
    const durableMemory = report.durable_memory;
    const sourceHashes = report.source_hashes;
    const passed = transcript.evidence.exit_code === 0
      && report.schema_version === 2
      && report.invocations === 120
      && typeof report.transcript_entries === "number"
      && report.transcript_entries >= 121
      && report.deterministic_byte_match === true
      && report.replay_verified === true
      && report.verifier_authenticity === "signed_attestation_verified"
      && report.raw_grants_exposed === 0
      && report.mutations_detected === report.mutations_attempted
      && report.mutations_attempted === 3
      && durableMemory && typeof durableMemory === "object"
      && (durableMemory as Record<string, unknown>).replay_verified === true
      && (durableMemory as Record<string, unknown>).deterministic_byte_match === true
      && (durableMemory as Record<string, unknown>).private_key_or_value_preimages_exposed === 0
      && sourceHashes && typeof sourceHashes === "object"
      && Object.values(sourceHashes as Record<string, unknown>).every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
      && typeof report.semantic_result_sha256 === "string"
      && /^[a-f0-9]{64}$/.test(report.semantic_result_sha256);
    addCheck({
      id: "transcript.signed_replay",
      status: passed ? "pass" : "fail",
      required_for: ["gate_0"],
      command_ids: [transcript.evidence.id],
      reason_codes: passed ? [] : ["signed_replay_incomplete"],
      observed: {
        invocations: typeof report.invocations === "number" ? report.invocations : 0,
        transcript_entries: typeof report.transcript_entries === "number" ? report.transcript_entries : 0,
        replay_verified: report.replay_verified === true,
        mutations_detected: typeof report.mutations_detected === "number" ? report.mutations_detected : 0,
        mutations_attempted: typeof report.mutations_attempted === "number" ? report.mutations_attempted : 0,
      },
    });
  } catch {
    addCheck({
      id: "transcript.signed_replay",
      status: "fail",
      required_for: ["gate_0"],
      command_ids: [transcript.evidence.id],
      reason_codes: ["signed_replay_report_invalid"],
      observed: { invocations: 0, replay_verified: false },
    });
  }

  const offlineRootA = resolve(logDirectory, "offline-a");
  const offlineRootB = resolve(logDirectory, "offline-b");
  const offlineArgs = (outputRoot: string) => [
    "scripts/voice-benchmark-offline.ts",
    "run",
    "offline",
    "--scenario",
    resolve(repositoryRoot, "benchmarks/voice-long-horizon/scenarios/industrial-field-service.v1.json"),
    "--condition",
    "full-harness",
    "--output-root",
    outputRoot,
    "--run-id",
    "precanary-offline-double-run",
    "--json",
  ];
  const offlineA = await runCommand(
    "offline.run_a",
    resolve(webRoot, "node_modules/.bin/tsx"),
    offlineArgs(offlineRootA),
    webRoot
  );
  const offlineB = await runCommand(
    "offline.run_b",
    resolve(webRoot, "node_modules/.bin/tsx"),
    offlineArgs(offlineRootB),
    webRoot
  );
  let determinism: PreCanaryProofPacketBody["determinism"] = {
    run_id: "precanary-offline-double-run",
    historical_minimum_file_count: 49,
    observed_file_count_a: 0,
    observed_file_count_b: 0,
    exact_path_set_match: false,
    exact_byte_match: false,
    tree_sha256_a: null,
    tree_sha256_b: null,
    network_calls: 0,
    spend_usd: "0",
  };
  try {
    const reportA = parseJsonObject(offlineA.stdout, "offline run A");
    const reportB = parseJsonObject(offlineB.stdout, "offline run B");
    const structured = [reportA, reportB].every((report) => (
      report.command === "run offline"
      && report.run_id === "precanary-offline-double-run"
      && report.status === "completed"
      && report.profile === "full-harness-fault-e2e"
      && report.world_task_success === true
      && report.network_calls === 0
      && report.paid_ledger_touched === false
      && report.spend_usd === "0"
      && report.fault_probes && typeof report.fault_probes === "object"
      && Object.values(report.fault_probes as Record<string, unknown>).length === 7
      && Object.values(report.fault_probes as Record<string, unknown>).every((value) => value === true)
    ));
    const treeA = await artifactTree(String(reportA.artifact_path));
    const treeB = await artifactTree(String(reportB.artifact_path));
    const exact = exactTreeMatch(treeA, treeB);
    determinism = {
      ...determinism,
      observed_file_count_a: treeA.count,
      observed_file_count_b: treeB.count,
      exact_path_set_match: exact.paths,
      exact_byte_match: exact.bytes,
      tree_sha256_a: treeA.treeSha256,
      tree_sha256_b: treeB.treeSha256,
    };
    const passed = offlineA.evidence.exit_code === 0
      && offlineB.evidence.exit_code === 0
      && structured
      && treeA.count >= determinism.historical_minimum_file_count
      && treeB.count >= determinism.historical_minimum_file_count
      && exact.paths
      && exact.bytes
      && treeA.treeSha256 === treeB.treeSha256;
    addCheck({
      id: "offline.determinism",
      status: passed ? "pass" : "fail",
      required_for: ["gate_0"],
      command_ids: [offlineA.evidence.id, offlineB.evidence.id],
      reason_codes: passed ? [] : ["offline_tree_or_semantics_mismatch"],
      observed: {
        file_count_a: treeA.count,
        file_count_b: treeB.count,
        exact_path_set_match: exact.paths,
        exact_byte_match: exact.bytes,
        structured_semantics_verified: structured,
      },
    });
  } catch {
    addCheck({
      id: "offline.determinism",
      status: "fail",
      required_for: ["gate_0"],
      command_ids: [offlineA.evidence.id, offlineB.evidence.id],
      reason_codes: ["offline_determinism_report_invalid"],
      observed: { file_count_a: 0, file_count_b: 0, exact_byte_match: false },
    });
  }

  const providerProofSha256 = { openai: null, xai: null, gemini: null } as {
    openai: string | null;
    xai: string | null;
    gemini: string | null;
  };
  const providerProofs = { openai: null, xai: null, gemini: null } as {
    openai: ProviderPricingProof | null;
    xai: ProviderPricingProof | null;
    gemini: ProviderPricingProof | null;
  };
  let executablePricingProofCount = 0;
  if (options.pricingProofDirectory) {
    for (const provider of ["openai", "xai", "gemini"] as const) {
      const path = resolve(options.pricingProofDirectory, `${provider}.pricing-proof.json`);
      const sourcePath = resolve(options.pricingProofDirectory, `${provider}.pricing-source.capture`);
      try {
        const proof = parseCanonicalProviderPricingProof(await readFile(path));
        const sourceCapture = await readFile(sourcePath);
        const verification = verifyProviderPricingProof({
          proof,
          sourceCapture,
          now: new Date(),
        });
        if (
          verification.valid
          && proof.snapshot.provider === provider
          && proof.verified === true
          && proof.derived.reservation_micro_usd === 5_000_000
          && proof.derived.conservative_liability_micro_usd <= 5_000_000
        ) {
          providerProofSha256[provider] = proof.proof_sha256;
          if (provider === "openai" && proof.snapshot.provider === "openai") providerProofs.openai = proof;
          if (provider === "xai" && proof.snapshot.provider === "xai") providerProofs.xai = proof;
          if (provider === "gemini" && proof.snapshot.provider === "gemini") providerProofs.gemini = proof;
          executablePricingProofCount += 1;
          artifacts.push(await fileArtifact(`pricing.${provider}`, path, "restricted_local", repositoryRoot));
          artifacts.push(await fileArtifact(`pricing.${provider}.source`, sourcePath, "restricted_local", repositoryRoot));
        }
      } catch {
        // Missing, malformed, or unverifiable provider proof remains a blocker.
      }
    }
  }
  const pricing: PreCanaryProofPacketBody["pricing"] = {
    gate_1_reservation_micro_usd_per_provider: 5_000_000,
    executable_proof_count: executablePricingProofCount,
    all_provider_proofs_verified: executablePricingProofCount === 3,
    provider_proof_sha256: providerProofSha256,
    provider_proofs: providerProofs,
  };
  addCheck({
    id: "pricing.gate1_executable_proofs",
    status: pricing.all_provider_proofs_verified ? "pass" : options.pricingProofDirectory ? "fail" : "blocked",
    required_for: ["gate_1"],
    command_ids: [],
    reason_codes: pricing.all_provider_proofs_verified ? [] : [
      options.pricingProofDirectory ? "pricing_proofs_incomplete" : "pricing_proofs_missing",
    ],
    observed: { verified_provider_count: executablePricingProofCount, required_provider_count: 3 },
  });

  const gitHeadClosing = await runCommand("source.head_close", "git", ["rev-parse", "HEAD"], repositoryRoot);
  const gitTreeClosing = await runCommand("source.tree_close", "git", ["rev-parse", "HEAD^{tree}"], repositoryRoot);
  const gitStatusClosing = await runCommand(
    "source.status_close",
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repositoryRoot
  );
  const historyClosing = await runCommand(
    "source.public_history_close",
    resolve(webRoot, "node_modules/.bin/tsx"),
    ["scripts/public-history-audit.ts", repositoryRoot],
    webRoot
  );
  const sourceStable = historyClosing.evidence.exit_code === 0
    && preCanarySourceSnapshotStable({
      opening_head_sha256: sha256Hex(gitHead.stdout),
      closing_head_sha256: sha256Hex(gitHeadClosing.stdout),
      opening_tree_sha256: sha256Hex(gitTree.stdout),
      closing_tree_sha256: sha256Hex(gitTreeClosing.stdout),
      opening_status_sha256: sha256Hex(gitStatusOpening.stdout),
      closing_status_sha256: sha256Hex(gitStatusClosing.stdout),
      opening_reachable_history_sha256: sha256Hex(history.stdout),
      closing_reachable_history_sha256: sha256Hex(historyClosing.stdout),
    });
  const sourceClean = sourceStable
    && gitHead.evidence.exit_code === 0
    && gitTree.evidence.exit_code === 0
    && gitStatusOpening.evidence.exit_code === 0
    && gitStatusClosing.evidence.exit_code === 0
    && gitStatusOpening.stdout.byteLength === 0
    && gitStatusClosing.stdout.byteLength === 0;
  addCheck({
    id: "source.clean",
    status: sourceClean ? "pass" : "fail",
    required_for: ["gate_0"],
    command_ids: [
      gitHead.evidence.id,
      gitTree.evidence.id,
      gitStatusOpening.evidence.id,
      gitHeadClosing.evidence.id,
      gitTreeClosing.evidence.id,
      gitStatusClosing.evidence.id,
      history.evidence.id,
      historyClosing.evidence.id,
    ],
    reason_codes: sourceClean ? [] : [sourceStable ? "source_dirty" : "source_changed_during_packet"],
    observed: {
      clean: sourceClean,
      stable_snapshot: sourceStable,
      reachable_history_stable: historyClosing.evidence.exit_code === 0
        && historyClosing.stdout.equals(history.stdout),
      opening_status_bytes: gitStatusOpening.stdout.byteLength,
      closing_status_bytes: gitStatusClosing.stdout.byteLength,
    },
  });

  const source: PreCanaryProofPacketBody["source"] = {
    commit,
    tree,
    clean: sourceClean,
    status_sha256: sha256Hex(gitStatusClosing.stdout),
    publishable_file_manifest_sha256: publishableFileManifestSha256,
  };
  const packet = createPreCanaryProofPacket({
    schema_version: 1,
    kind: "hacc_pre_canary_no_spend_proof",
    generated_at: new Date().toISOString(),
    source,
    provider_boundary: providerBoundary,
    budget,
    freeze,
    pricing,
    determinism,
    commands,
    checks: [...checks.values()].sort((left, right) => left.id.localeCompare(right.id)),
    artifacts: artifacts.sort((left, right) => left.id.localeCompare(right.id)),
  });
  const verification = verifyPreCanaryProofPacket(packet);
  await writeExclusiveRestricted(options.outputPath, `${canonicalJson(packet)}\n`);
  const summary = {
    schema_version: 1,
    packet_path: safeEvidencePath(options.outputPath, repositoryRoot),
    packet_sha256: packet.packet_sha256,
    packet_integrity_verified: verification.valid,
    gate_0_evidence_complete: packet.decision.gate_0_evidence_complete,
    gate_1_ready_for_manual_release: packet.decision.gate_1_ready_for_manual_release,
    gate_1_release_authorized: false,
    paid_execution_authorized: false,
    blocking_check_ids: packet.decision.blocking_check_ids,
    provider_sessions_opened: 0,
    spend_usd: "0",
  };
  process.stdout.write(`${canonicalJson(summary)}\n`);
  return verification.valid && packet.decision.gate_0_evidence_complete ? 0 : 1;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    process.stderr.write(`pre-canary proof assembly failed closed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 2;
  });

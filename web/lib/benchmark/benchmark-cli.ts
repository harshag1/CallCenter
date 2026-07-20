import { execFile } from "node:child_process";
import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./artifacts";
import {
  loadFrozenCallerAudioForPaidTrial,
  readFrozenFixtureFileNoFollow,
  verifyCallerAudioFixture,
  type CallerAudioRendition,
  type CallerAudioScenarioIdentity,
  type CallerAudioTurn as FixtureCallerTurn,
  type VerifiedFrozenCallerAudio,
} from "./audio-fixtures";
import { createBudgetLedger } from "./budget";
import {
  BENCHMARK_CONDITION_IDS,
  assertConditionParity,
  compileConditionSuite,
  type BenchmarkConditionId,
  type CompiledBenchmarkCondition,
} from "./condition-compiler";
import {
  benchmarkFreezeLockSha256,
  benchmarkPairInvariantsSha256,
  createBenchmarkExecutionPlan,
  parseCanonicalBenchmarkExecutionPlan,
  parseCanonicalBenchmarkFreezeLock,
  serializeBenchmarkExecutionPlan,
  verifyExecutionPlanAgainstFreeze,
  BenchmarkPlanError,
  type BenchmarkExecutionPlan,
  type BenchmarkFreezeLock,
} from "./execution-plan";
import {
  costEnvelopeMaximumMicroUsd,
  filesystemBudgetLedgerContainsHead,
  FilesystemBudgetLedgerError,
  inspectFilesystemBudgetLedger,
  type BudgetCostEnvelope,
} from "./filesystem-budget-ledger";
import {
  verifyPreCanaryProofPacket,
  verifyPaidReleaseGate,
  type PreCanaryProofPacket,
} from "./pre-canary-proof";
import {
  GATE_1_PROVIDER_RESERVATION_MICRO_USD,
  providerHardSessionCapsSha256,
  providerPricingProofCostEnvelope,
  type ProviderHardSessionCaps,
  type ProviderPricingProof,
} from "./provider-pricing-proof";
import { resolveBenchmarkEnvironment, type ResolvedBenchmarkEnvironment } from "./environment";
import { ScriptedFakeRealtimeClient, createNoToolFakeScript } from "./fake-realtime-client";
import { InMemoryBenchmarkGatewayKernel } from "./gateway-kernel";
import {
  benchmarkKernelAttestationPublicKeyFingerprint,
  createBenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationSigner,
} from "./kernel-attestation";
import {
  analyzeIndustrialOfflineFaultRun,
  createIndustrialOfflineFaultScript,
} from "./industrial-offline-script";
import {
  assertLongHorizonExecutionAuthorization,
  deriveLongHorizonExecutionAuthorization,
} from "./long-horizon-execution";
import type { LongHorizonPcmTurn } from "./long-horizon-scenario-suite";
import {
  createPairedAudioManifest,
  DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
  runBenchmarkTrial,
  trialAudioDeliveryProfileHash,
  type CallerAudioTurn,
  type TrialLimits,
  type TrialResult,
} from "./orchestrator";
import { type BenchmarkScenario } from "./scenario-schema";
import { evaluateScenarioWorld } from "./tool-world";
import {
  SCENARIO_SOURCE_REGISTRY_VERSION,
  SCENARIO_SOURCE_REGISTRY_HASH,
  ScenarioSourceRegistryError,
  listScenarioSources,
  materializeScenarioSource,
  resolveScenarioSource,
  type RegisteredScenarioSource,
} from "./scenario-source-registry";
import { CrashDurableRunJournal, redactRunJournalValue } from "./run-journal";
import type { ServerRealtimeProvider } from "../realtime/client/types";

const execFileAsync = promisify(execFile);
const MODULE_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const EXIT = Object.freeze({
  ok: 0,
  usage: 2,
  protocol: 3,
  confirmation: 4,
  integrity: 5,
  configuration: 6,
  budget: 7,
  durability: 9,
  provider: 20,
  partial: 21,
  internal: 70,
});
const PROVIDER_ENV = Object.freeze({
  openai: "OPENAI_API_KEY",
  xai: "XAI_API_KEY",
  gemini: "GEMINI_API_KEY",
} satisfies Record<ServerRealtimeProvider, string>);
const COST_ENVELOPE_SCHEMA = z.object({
  pricing_snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  limits_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  formula_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  components: z.array(z.object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/),
    upper_bound_micro_usd: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }).strict()).min(1).max(128),
  safety_margin_micro_usd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export type BenchmarkCliIo = Readonly<{
  stdout(value: string): void;
  stderr(value: string): void;
}>;

export type GitCheckout = Readonly<{
  head: string;
  tree: string;
  clean: boolean;
  status: string;
  tagObjectId?(tag: string): Promise<string>;
  tagTargetCommit?(tag: string): Promise<string>;
}>;

export type PaidBenchmarkRunInput = Readonly<{
  plan: BenchmarkExecutionPlan;
  freeze: BenchmarkFreezeLock;
  scenario: BenchmarkScenario;
  condition: CompiledBenchmarkCondition;
  scenarioSource: RegisteredScenarioSource;
  suiteFlowHash: string;
  suiteScenarioHash: string;
  suiteSourceHash: string;
  fixture: VerifiedFrozenCallerAudio;
  fixtureRendition: CallerAudioRendition;
  /** Plan-matched signer; the private key material itself is never persisted. */
  kernelAttestationSigner: BenchmarkKernelAttestationSigner;
  ledgerPath: string;
  outputRoot: string;
  environment: ResolvedBenchmarkEnvironment;
  preCanaryPacket: PreCanaryProofPacket;
  providerPricingProof: ProviderPricingProof;
}>;

export type PaidBenchmarkRunResult = Readonly<{
  runId: string;
  status: string;
  artifactPath: string;
  budgetHeadSha256: string;
}>;

export type BenchmarkCliDependencies = Readonly<{
  repositoryRoot?: string;
  cwd?: string;
  now?: () => Date;
  randomId?: () => string;
  io?: BenchmarkCliIo;
  inspectGit?: (repositoryRoot: string) => Promise<GitCheckout>;
  executePaid?: (input: PaidBenchmarkRunInput) => Promise<PaidBenchmarkRunResult>;
}>;

export class BenchmarkCliError extends Error {
  readonly exitCode: number;
  readonly code: string;

  constructor(exitCode: number, code: string, message: string) {
    super(message);
    this.name = "BenchmarkCliError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

type ParsedArguments = Readonly<{
  positionals: readonly string[];
  options: ReadonlyMap<string, string | true>;
}>;

function cliFail(exitCode: number, code: string, message: string): never {
  throw new BenchmarkCliError(exitCode, code, message);
}

function defaultIo(): BenchmarkCliIo {
  return Object.freeze({
    stdout: (value: string) => process.stdout.write(value),
    stderr: (value: string) => process.stderr.write(value),
  });
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!/^--[a-z][a-z0-9-]*$/.test(value)) cliFail(EXIT.usage, "invalid_option", `invalid option ${value}`);
    const name = value.slice(2);
    if (options.has(name)) cliFail(EXIT.usage, "duplicate_option", `option --${name} may be supplied only once`);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(name, next);
      index += 1;
    } else {
      options.set(name, true);
    }
  }
  return Object.freeze({ positionals: Object.freeze(positionals), options });
}

function option(args: ParsedArguments, name: string): string | undefined {
  const value = args.options.get(name);
  if (value === true) cliFail(EXIT.usage, "missing_option_value", `--${name} requires a value`);
  return value;
}

function requiredOption(args: ParsedArguments, name: string): string {
  const value = option(args, name);
  if (value === undefined) cliFail(EXIT.usage, "missing_option", `--${name} is required`);
  return value;
}

function flag(args: ParsedArguments, name: string): boolean {
  const value = args.options.get(name);
  if (value !== undefined && value !== true) cliFail(EXIT.usage, "invalid_flag", `--${name} does not accept a value`);
  return value === true;
}

function rejectUnknown(args: ParsedArguments, allowed: readonly string[]): void {
  const known = new Set(allowed);
  for (const name of args.options.keys()) {
    if (!known.has(name)) cliFail(EXIT.usage, "unknown_option", `unknown option --${name}`);
  }
}

function absolutePath(value: string, cwd: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function relativePathInside(root: string, path: string): string {
  const value = relative(root, path);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value) || value.includes("\\")) {
    cliFail(EXIT.integrity, "path_outside_repository", "path must be a file inside the repository");
  }
  return value.split(sep).join("/");
}

async function readNoFollow(path: string, maxBytes = 512 * 1024 * 1024): Promise<Uint8Array> {
  try {
    return await readFrozenFixtureFileNoFollow(dirname(path), path.split(sep).at(-1)!, maxBytes);
  } catch {
    cliFail(EXIT.integrity, "file_unreadable", "required benchmark file is unreadable or unsafe");
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    cliFail(EXIT.integrity, "invalid_utf8", `${label} is not valid UTF-8`);
  }
}

async function readPrivateAttestationKey(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < BigInt(1) || before.size > BigInt(64 * 1024)) {
      throw new Error("invalid private key file");
    }
    if ((before.mode & BigInt(0o077)) !== BigInt(0)) {
      throw new Error("private key permissions are too broad");
    }
    if (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) {
      throw new Error("private key owner differs from the benchmark process");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("private key changed while being read");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return cliFail(
      EXIT.configuration,
      "attestation_private_key_unsafe",
      "kernel attestation private key must be an owner-only, regular, no-follow UTF-8 file under 64 KiB"
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readCanonicalJson(path: string, label: string): Promise<unknown> {
  const bytes = await readNoFollow(path);
  const text = Buffer.from(bytes).toString("utf8");
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r") || text.includes("\0")) {
    cliFail(EXIT.integrity, "noncanonical_json", `${label} must be one canonical JSON object followed by one newline`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    cliFail(EXIT.integrity, "invalid_json", `${label} is not valid JSON`);
  }
  if (`${canonicalJson(value)}\n` !== text) cliFail(EXIT.integrity, "noncanonical_json", `${label} is not canonical JSON`);
  return value;
}

async function loadScenario(path: string): Promise<Readonly<{
  scenario: BenchmarkScenario;
  source: RegisteredScenarioSource;
  bytes: Uint8Array;
  canonicalHash: string;
}>> {
  const bytes = await readNoFollow(path);
  let input: unknown;
  try {
    input = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    cliFail(EXIT.integrity, "invalid_scenario_json", "scenario is not valid JSON");
  }
  let source: RegisteredScenarioSource;
  try {
    source = resolveScenarioSource(input);
  } catch (error) {
    if (error instanceof ScenarioSourceRegistryError) {
      cliFail(EXIT.integrity, `scenario_${error.code}`, error.message);
    }
    throw error;
  }
  return Object.freeze({
    scenario: source.scenario,
    source,
    bytes,
    canonicalHash: source.scenarioContentHash,
  });
}

function scenarioIdentity(scenario: BenchmarkScenario, canonicalHash: string): CallerAudioScenarioIdentity {
  return Object.freeze({ id: scenario.id, version: scenario.version, canonical_sha256: canonicalHash });
}

function scenarioFixtureTurns(scenario: BenchmarkScenario): readonly FixtureCallerTurn[] {
  return Object.freeze(scenario.caller.turns.map((turn) => Object.freeze({ id: turn.id, text: turn.utterance, pause_after_ms: 0 })));
}

function frozenFixtureCallerPcm(
  scenario: BenchmarkScenario,
  fixture: VerifiedFrozenCallerAudio,
  rendition: CallerAudioRendition
): readonly LongHorizonPcmTurn[] {
  const sampleRateHz = rendition === "pcm16le_mono_16000" ? 16_000 : 24_000;
  return Object.freeze(scenario.caller.turns.map((turn) => Object.freeze({
    turnId: turn.id,
    audio: Object.freeze({
      encoding: "pcm16" as const,
      sampleRateHz,
      channels: 1 as const,
      data: fixture.readPcm(turn.id, rendition),
    }),
  })));
}

function compileScenario(source: RegisteredScenarioSource) {
  const suite = compileConditionSuite(source.compilerInput);
  assertConditionParity(suite);
  return Object.freeze({ source, suite });
}

async function defaultInspectGit(repositoryRoot: string): Promise<GitCheckout> {
  const run = async (...args: string[]) => (await execFileAsync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  })).stdout.trim();
  const [head, tree, statusText] = await Promise.all([
    run("rev-parse", "HEAD"),
    run("rev-parse", "HEAD^{tree}"),
    run("status", "--porcelain=v1", "--untracked-files=normal"),
  ]);
  return Object.freeze({
    head,
    tree,
    clean: statusText.length === 0,
    status: statusText,
    tagObjectId: (tag: string) => run("rev-parse", `refs/tags/${tag}^{tag}`),
    tagTargetCommit: (tag: string) => run("rev-parse", `refs/tags/${tag}^{commit}`),
  });
}

async function loadFreeze(path: string): Promise<BenchmarkFreezeLock> {
  try {
    return parseCanonicalBenchmarkFreezeLock(await readNoFollow(path));
  } catch (error) {
    if (error instanceof BenchmarkCliError) throw error;
    cliFail(EXIT.protocol, "invalid_freeze_lock", error instanceof Error ? error.message : "freeze lock is invalid");
  }
}

async function loadPreCanaryPacket(path: string): Promise<PreCanaryProofPacket> {
  const value = await readCanonicalJson(path, "pre-canary packet");
  const verification = verifyPreCanaryProofPacket(value);
  if (!verification.valid || !verification.packet) {
    cliFail(
      EXIT.integrity,
      "pre_canary_packet_invalid",
      `pre-canary packet failed verification: ${verification.errors.join(",")}`,
    );
  }
  return verification.packet;
}

function assertProviderCapsMatchPlan(
  caps: ProviderHardSessionCaps,
  limits: TrialLimits,
): void {
  if (
    caps.max_session_ms !== limits.maxSessionMs
    || caps.max_input_audio_bytes !== limits.maxInputAudioBytes
    || caps.max_output_audio_bytes !== limits.maxOutputAudioBytes
    || caps.max_tool_calls !== limits.maxToolCalls
  ) {
    cliFail(
      EXIT.integrity,
      "provider_caps_plan_mismatch",
      "verified provider hard-session caps differ from the exact paid runner limits",
    );
  }
}

async function verifyFreezeCheckout(input: Readonly<{
  freeze: BenchmarkFreezeLock;
  repositoryRoot: string;
  inspectGit: (root: string) => Promise<GitCheckout>;
}>): Promise<GitCheckout> {
  const checkout = await input.inspectGit(input.repositoryRoot);
  if (!checkout.clean) cliFail(EXIT.integrity, "dirty_checkout", "paid/frozen work requires a clean checkout");
  if (checkout.head !== input.freeze.source_commit || checkout.tree !== input.freeze.source_tree) {
    cliFail(EXIT.integrity, "source_mismatch", "checkout HEAD/tree differs from the freeze lock");
  }
  for (const file of input.freeze.bundle) {
    const path = resolve(input.repositoryRoot, ...file.path.split("/"));
    if (!path.startsWith(`${input.repositoryRoot}${sep}`)) cliFail(EXIT.integrity, "bundle_path_escape", "frozen bundle path escapes the repository");
    let bytes: Uint8Array;
    try {
      bytes = await readFrozenFixtureFileNoFollow(input.repositoryRoot, file.path);
    } catch {
      cliFail(EXIT.integrity, "frozen_file_unreadable", `frozen bundle file is unreadable: ${file.path}`);
    }
    if (sha256Hex(bytes) !== file.sha256) cliFail(EXIT.integrity, "frozen_file_mismatch", `frozen bundle file changed: ${file.path}`);
  }
  if (input.freeze.registration.status === "frozen") {
    if (!checkout.tagObjectId || !checkout.tagTargetCommit) cliFail(EXIT.protocol, "tag_verification_unavailable", "annotated freeze tag verification is unavailable");
    const [tagObject, target] = await Promise.all([
      checkout.tagObjectId(input.freeze.registration.freeze_tag),
      checkout.tagTargetCommit(input.freeze.registration.freeze_tag),
    ]);
    if (tagObject !== input.freeze.registration.freeze_tag_object_id || target !== input.freeze.registration.target_commit) {
      cliFail(EXIT.integrity, "freeze_tag_mismatch", "annotated freeze tag moved or does not match the lock");
    }
    if (target !== input.freeze.source_commit) cliFail(EXIT.integrity, "freeze_tag_target_mismatch", "freeze tag does not target the frozen source commit");
  }
  return checkout;
}

function emit(io: BenchmarkCliIo, json: boolean, value: unknown): void {
  const safe = redactRunJournalValue(value);
  if (json) io.stdout(`${canonicalJson(safe)}\n`);
  else io.stdout(`${JSON.stringify(safe, null, 2)}\n`);
}

function asProvider(value: string): ServerRealtimeProvider {
  if (value !== "openai" && value !== "xai" && value !== "gemini") cliFail(EXIT.usage, "invalid_provider", "provider must be openai, xai, or gemini");
  return value;
}

function asCondition(value: string): BenchmarkConditionId {
  if (!(BENCHMARK_CONDITION_IDS as readonly string[]).includes(value)) cliFail(EXIT.usage, "invalid_condition", `condition must be one of ${BENCHMARK_CONDITION_IDS.join(", ")}`);
  return value as BenchmarkConditionId;
}

function expectedRendition(provider: ServerRealtimeProvider): CallerAudioRendition {
  return provider === "gemini" ? "pcm16le_mono_16000" : "pcm16le_mono_24000";
}

async function commandDoctor(args: ParsedArguments, dependencies: Required<Pick<BenchmarkCliDependencies, "repositoryRoot" | "cwd" | "now" | "io">> & BenchmarkCliDependencies): Promise<number> {
  rejectUnknown(args, ["json", "ledger", "freeze-lock", "env-file", "include-gpu-hub-env"]);
  if (args.positionals.length !== 1) cliFail(EXIT.usage, "usage", "usage: voice-benchmark doctor [options]");
  const envFile = option(args, "env-file");
  const environment = await resolveBenchmarkEnvironment({
    names: Object.values(PROVIDER_ENV),
    explicitEnvFiles: envFile ? [absolutePath(envFile, dependencies.cwd)] : [],
    repositoryRoot: dependencies.repositoryRoot,
    gpuHubRoot: flag(args, "include-gpu-hub-env") ? undefined : null,
    cwd: dependencies.cwd,
  });
  const checks: Record<string, unknown> = {
    node: { version: process.versions.node, supported: Number(process.versions.node.split(".")[0]) >= 24 },
    repository_root: dependencies.repositoryRoot,
    provider_environment: environment.describe(),
  };
  let requestedChecksValid = true;
  const ledger = option(args, "ledger");
  if (ledger) {
    try {
      checks.ledger = { valid: true, ...await inspectFilesystemBudgetLedger({ ledgerPath: absolutePath(ledger, dependencies.cwd) }) };
    } catch {
      requestedChecksValid = false;
      checks.ledger = { valid: false, reason_code: "ledger_invalid_or_unavailable" };
    }
  }
  const freezePath = option(args, "freeze-lock");
  if (freezePath) {
    try {
      const freeze = await loadFreeze(absolutePath(freezePath, dependencies.cwd));
      checks.freeze = { valid: true, protocol_id: freeze.protocol_id, evidence_class: freeze.evidence_class, sha256: benchmarkFreezeLockSha256(freeze) };
    } catch {
      requestedChecksValid = false;
      checks.freeze = { valid: false, reason_code: "freeze_invalid_or_unavailable" };
    }
  }
  emit(dependencies.io, flag(args, "json"), {
    command: "doctor",
    valid: requestedChecksValid,
    network_calls: 0,
    spend_usd: "0",
    checks,
  });
  return requestedChecksValid ? EXIT.ok : EXIT.integrity;
}

async function commandFixturesVerify(args: ParsedArguments, dependencies: Required<Pick<BenchmarkCliDependencies, "repositoryRoot" | "cwd" | "io">>): Promise<number> {
  rejectUnknown(args, ["json", "root", "scenario", "expected-manifest-sha256"]);
  if (args.positionals.join(" ") !== "fixtures verify") cliFail(EXIT.usage, "usage", "usage: voice-benchmark fixtures verify --root DIR --scenario FILE [--expected-manifest-sha256 HASH]");
  const root = absolutePath(requiredOption(args, "root"), dependencies.cwd);
  const scenarioPath = absolutePath(requiredOption(args, "scenario"), dependencies.cwd);
  const loaded = await loadScenario(scenarioPath);
  const expectedHash = option(args, "expected-manifest-sha256");
  const verification = await verifyCallerAudioFixture({
    rootDirectory: root,
    expectedScenario: scenarioIdentity(loaded.scenario, loaded.canonicalHash),
    expectedTurns: scenarioFixtureTurns(loaded.scenario),
    ...(expectedHash ? { expectedManifestSha256: expectedHash } : {}),
  });
  emit(dependencies.io, flag(args, "json"), {
    command: "fixtures verify",
    valid: verification.valid,
    errors: verification.errors,
    manifest_sha256: verification.manifest?.manifest_sha256 ?? null,
    audio_set_sha256: verification.manifest?.audio_set_sha256 ?? null,
    network_calls: 0,
    spend_usd: "0",
  });
  return verification.valid ? EXIT.ok : EXIT.integrity;
}

async function commandValidate(args: ParsedArguments, dependencies: Required<Pick<BenchmarkCliDependencies, "repositoryRoot" | "cwd" | "now" | "io">> & BenchmarkCliDependencies): Promise<number> {
  rejectUnknown(args, ["json", "freeze-lock", "plan", "fixture-root"]);
  if (args.positionals.length !== 1) cliFail(EXIT.usage, "usage", "usage: voice-benchmark validate --freeze-lock FILE [--plan FILE --fixture-root DIR]");
  const freeze = await loadFreeze(absolutePath(requiredOption(args, "freeze-lock"), dependencies.cwd));
  if (freeze.scenario_source_registry_sha256 !== SCENARIO_SOURCE_REGISTRY_HASH) {
    cliFail(EXIT.integrity, "scenario_registry_catalog_mismatch", "freeze lock differs from the live scenario source registry");
  }
  await verifyFreezeCheckout({ freeze, repositoryRoot: dependencies.repositoryRoot, inspectGit: dependencies.inspectGit ?? defaultInspectGit });
  const planPath = option(args, "plan");
  let plan: BenchmarkExecutionPlan | null = null;
  if (planPath) {
    plan = parseCanonicalBenchmarkExecutionPlan(await readNoFollow(absolutePath(planPath, dependencies.cwd)));
    verifyExecutionPlanAgainstFreeze({ plan, freeze, now: dependencies.now() });
    const scenarioPath = resolve(dependencies.repositoryRoot, ...plan.scenario.path.split("/"));
    const loaded = await loadScenario(scenarioPath);
    if (loaded.canonicalHash !== plan.scenario.canonical_sha256) cliFail(EXIT.integrity, "scenario_hash_mismatch", "scenario canonical hash differs from the plan");
    if (
      loaded.source.registryKey !== plan.scenario.registry_key
      || loaded.source.registryEntryHash !== plan.scenario.registry_entry_sha256
      || plan.scenario.registry_catalog_sha256 !== SCENARIO_SOURCE_REGISTRY_HASH
    ) {
      cliFail(EXIT.integrity, "scenario_registry_mismatch", "scenario source registry binding differs from the plan");
    }
    const compiled = compileScenario(loaded.source);
    const condition = compiled.suite.conditions[plan.cell.condition];
    if (condition.conditionHash !== plan.condition_hash || condition.initialPromptHash !== plan.prompt_hash || condition.providerToolsHash !== plan.provider_tools_hash) {
      cliFail(EXIT.integrity, "condition_hash_mismatch", "compiled condition differs from the plan");
    }
    const fixtureRoot = option(args, "fixture-root");
    if (fixtureRoot) {
      await loadFrozenCallerAudioForPaidTrial({
        rootDirectory: absolutePath(fixtureRoot, dependencies.cwd),
        expectedScenario: scenarioIdentity(loaded.scenario, loaded.canonicalHash),
        expectedTurns: scenarioFixtureTurns(loaded.scenario),
        expectedManifestSha256: plan.fixture.manifest_sha256,
      });
    }
  }
  emit(dependencies.io, flag(args, "json"), {
    command: "validate",
    valid: true,
    freeze_lock_sha256: benchmarkFreezeLockSha256(freeze),
    evidence_class: freeze.evidence_class,
    plan_sha256: plan?.plan_sha256 ?? null,
    network_calls: 0,
    spend_usd: "0",
  });
  return EXIT.ok;
}

async function writeExclusive(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function commandScenariosList(
  args: ParsedArguments,
  dependencies: Required<Pick<BenchmarkCliDependencies, "io">>
): Promise<number> {
  rejectUnknown(args, ["json"]);
  if (args.positionals.join(" ") !== "scenarios list") {
    cliFail(EXIT.usage, "usage", "usage: voice-benchmark scenarios list [--json]");
  }
  const scenarios = listScenarioSources();
  emit(dependencies.io, flag(args, "json"), {
    command: "scenarios list",
    registry_version: SCENARIO_SOURCE_REGISTRY_VERSION,
    registry_catalog_sha256: SCENARIO_SOURCE_REGISTRY_HASH,
    count: scenarios.length,
    scenarios,
    network_calls: 0,
    spend_usd: "0",
  });
  return EXIT.ok;
}

async function commandScenariosMaterialize(
  args: ParsedArguments,
  dependencies: Required<Pick<BenchmarkCliDependencies, "cwd" | "io">>
): Promise<number> {
  rejectUnknown(args, ["json", "registry-key", "out"]);
  if (args.positionals.join(" ") !== "scenarios materialize") {
    cliFail(
      EXIT.usage,
      "usage",
      "usage: voice-benchmark scenarios materialize --registry-key KEY --out FILE [--json]"
    );
  }
  const registryKey = requiredOption(args, "registry-key");
  let materialized;
  try {
    materialized = materializeScenarioSource(registryKey);
  } catch (error) {
    if (error instanceof ScenarioSourceRegistryError) {
      cliFail(EXIT.integrity, `scenario_${error.code}`, error.message);
    }
    throw error;
  }
  const out = absolutePath(requiredOption(args, "out"), dependencies.cwd);
  try {
    await writeExclusive(out, materialized.canonicalScenarioJson);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      cliFail(EXIT.integrity, "scenario_output_exists", "refusing to replace an existing scenario file");
    }
    throw error;
  }
  emit(dependencies.io, flag(args, "json"), {
    command: "scenarios materialize",
    registry_key: materialized.catalogEntry.registryKey,
    registry_entry_sha256: materialized.catalogEntry.registryEntryHash,
    registry_catalog_sha256: SCENARIO_SOURCE_REGISTRY_HASH,
    scenario_sha256: materialized.canonicalScenarioSha256,
    study_role: materialized.catalogEntry.studyRole,
    held_out: materialized.catalogEntry.heldOut,
    output_path: out,
    network_calls: 0,
    spend_usd: "0",
  });
  return EXIT.ok;
}

async function commandPlan(args: ParsedArguments, dependencies: Required<Pick<BenchmarkCliDependencies, "repositoryRoot" | "cwd" | "now" | "randomId" | "io">> & BenchmarkCliDependencies): Promise<number> {
  rejectUnknown(args, [
    "json", "freeze-lock", "scenario", "fixture-root", "provider", "model", "voice", "condition", "mode",
    "ledger", "cost-envelope", "out", "output-root", "run-id", "reservation-id", "pair-id",
    "kernel-attestation-key-id", "kernel-attestation-public-key", "gate0-packet",
  ]);
  if (args.positionals.length !== 1) cliFail(EXIT.usage, "usage", "usage: voice-benchmark plan --gate0-packet FILE --freeze-lock FILE --scenario FILE --fixture-root DIR --provider NAME --model ID --voice ID --condition ID --mode MODE --ledger FILE --cost-envelope FILE --kernel-attestation-key-id ID --kernel-attestation-public-key FILE --out FILE");
  const freeze = await loadFreeze(absolutePath(requiredOption(args, "freeze-lock"), dependencies.cwd));
  if (freeze.scenario_source_registry_sha256 !== SCENARIO_SOURCE_REGISTRY_HASH) {
    cliFail(EXIT.integrity, "scenario_registry_catalog_mismatch", "freeze lock differs from the live scenario source registry");
  }
  const provider = asProvider(requiredOption(args, "provider"));
  const conditionId = asCondition(requiredOption(args, "condition"));
  const mode = requiredOption(args, "mode");
  if (!["canary", "pilot", "confirmatory"].includes(mode)) cliFail(EXIT.usage, "invalid_mode", "paid plan mode must be canary, pilot, or confirmatory");
  if (mode !== freeze.evidence_class) cliFail(EXIT.protocol, "freeze_mode_mismatch", "plan mode differs from the freeze evidence class");
  const scenarioPath = absolutePath(requiredOption(args, "scenario"), dependencies.cwd);
  const loaded = await loadScenario(scenarioPath);
  if (loaded.source.heldOut && mode !== "confirmatory") {
    cliFail(EXIT.protocol, "held_out_source_not_exploratory", "held-out scenario sources may be planned only for a frozen confirmatory run");
  }
  if (
    loaded.source.family !== "industrial-field-service"
    && loaded.source.studyRole === "development"
    && mode === "confirmatory"
  ) {
    cliFail(EXIT.protocol, "development_source_not_confirmatory", "development scenarios cannot be labeled as confirmatory evidence");
  }
  if (mode === "confirmatory" && freeze.registration.status !== "frozen") cliFail(EXIT.protocol, "confirmatory_not_frozen", "confirmatory planning is blocked until registration is frozen");
  const attestationKeyId = requiredOption(args, "kernel-attestation-key-id");
  const attestationPublicKeyPem = decodeUtf8(await readNoFollow(
    absolutePath(requiredOption(args, "kernel-attestation-public-key"), dependencies.cwd),
    64 * 1024
  ), "kernel attestation public key");
  let attestationPublicKeyFingerprint: string;
  try {
    attestationPublicKeyFingerprint = benchmarkKernelAttestationPublicKeyFingerprint(attestationPublicKeyPem);
  } catch {
    cliFail(EXIT.integrity, "attestation_public_key_invalid", "kernel attestation public key must be a canonical Ed25519 SPKI PEM key");
  }
  if (
    attestationKeyId !== freeze.kernel_attestation.key_id
    || attestationPublicKeyFingerprint !== freeze.kernel_attestation.public_key_fingerprint_sha256
    || attestationPublicKeyPem !== freeze.kernel_attestation.public_key_pem
  ) {
    cliFail(
      EXIT.integrity,
      "attestation_trust_root_mismatch",
      "kernel attestation key ID and public key must exactly match the trust root pinned by the freeze lock"
    );
  }
  await verifyFreezeCheckout({ freeze, repositoryRoot: dependencies.repositoryRoot, inspectGit: dependencies.inspectGit ?? defaultInspectGit });
  const scenarioRelativePath = relativePathInside(dependencies.repositoryRoot, scenarioPath);
  const compiled = compileScenario(loaded.source);
  const condition = compiled.suite.conditions[conditionId];
  const fixture = await loadFrozenCallerAudioForPaidTrial({
    rootDirectory: absolutePath(requiredOption(args, "fixture-root"), dependencies.cwd),
    expectedScenario: scenarioIdentity(loaded.scenario, loaded.canonicalHash),
    expectedTurns: scenarioFixtureTurns(loaded.scenario),
    expectedManifestSha256: freeze.fixture_manifest_sha256,
  });
  const costEnvelope = COST_ENVELOPE_SCHEMA.parse(await readCanonicalJson(
    absolutePath(requiredOption(args, "cost-envelope"), dependencies.cwd),
    "cost envelope"
  )) as BudgetCostEnvelope;
  const model = requiredOption(args, "model");
  const voice = requiredOption(args, "voice");
  const rendition = expectedRendition(provider);
  const pin = freeze.provider_pins.find((candidate) => candidate.provider === provider && candidate.model === model && candidate.voice === voice);
  if (!pin) cliFail(EXIT.protocol, "provider_not_frozen", "provider/model/voice is not present in the freeze lock");
  if (pin.pricing_snapshot_sha256 !== costEnvelope.pricing_snapshot_sha256) cliFail(EXIT.integrity, "pricing_hash_mismatch", "cost envelope pricing snapshot differs from the provider pin");
  if (pin.pricing_formula_sha256 !== costEnvelope.formula_sha256) cliFail(EXIT.integrity, "pricing_formula_hash_mismatch", "cost envelope pricing formula differs from the provider pin");
  if (pin.hard_limits_sha256 !== costEnvelope.limits_sha256) cliFail(EXIT.integrity, "pricing_limits_hash_mismatch", "cost envelope hard-limit binding differs from the provider pin");
  const createdAt = dependencies.now();
  const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1_000);
  const reservationExpiresAt = new Date(createdAt.getTime() + 15 * 60 * 1_000);
  const limits: TrialLimits = Object.freeze({
    maxTurns: loaded.scenario.max_turns,
    maxSessionMs: 15 * 60 * 1_000,
    maxInputAudioBytes: fixture.manifest.turns.reduce((sum, turn) => sum + turn.renditions[rendition].byte_length, 0),
    maxOutputAudioBytes: 64 * 1024 * 1024,
    maxToolCalls: 128,
    sessionReadyTimeoutMs: 15_000,
    responseTimeoutMs: 60_000,
  });
  const audioDelivery = Object.freeze({
    ...DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
    profile_sha256: trialAudioDeliveryProfileHash(DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE),
  });
  if (audioDelivery.profile_sha256 !== freeze.audio_delivery_profile_sha256) {
    cliFail(EXIT.integrity, "audio_delivery_hash_mismatch", "default audio delivery profile differs from the freeze lock");
  }
  if (sha256Hex(canonicalJson({ limits, audio_delivery: audioDelivery })) !== costEnvelope.limits_sha256) {
    cliFail(EXIT.integrity, "limits_hash_mismatch", "cost envelope was not derived from the exact planned hard limits and audio delivery profile");
  }
  const sessionContinuity = Object.freeze({
    schema_version: 1 as const,
    application_reconnect: "disabled" as const,
    provider_native_resumption: "disabled" as const,
  });
  let longHorizonAuthorization: BenchmarkExecutionPlan["long_horizon_authorization"];
  try {
    longHorizonAuthorization = deriveLongHorizonExecutionAuthorization({
      scenario: loaded.scenario,
      callerPcm: frozenFixtureCallerPcm(loaded.scenario, fixture, rendition),
      mode: mode as "canary" | "pilot" | "confirmatory",
      maxSessionMs: limits.maxSessionMs,
      preregistrationSha256: freeze.preregistration_sha256,
      conditionSuiteSha256: compiled.suite.suiteHash,
      runnerConfigSha256: costEnvelope.limits_sha256,
    });
  } catch (error) {
    cliFail(
      EXIT.protocol,
      "long_horizon_execution_ineligible",
      error instanceof Error ? error.message : "long-horizon execution eligibility could not be proven"
    );
  }
  // Eligibility is computed from exact frozen PCM before even reading the
  // budget ledger. Offline-only stress fixtures therefore cannot progress to
  // a credential, reservation, or provider-capable boundary.
  const ledgerPath = absolutePath(requiredOption(args, "ledger"), dependencies.cwd);
  const ledger = await inspectFilesystemBudgetLedger({ ledgerPath });
  if (ledger.state !== "open") cliFail(EXIT.budget, "ledger_not_open", `budget ledger is ${ledger.state}`);
  const maximum = costEnvelopeMaximumMicroUsd(costEnvelope);
  if (maximum !== GATE_1_PROVIDER_RESERVATION_MICRO_USD) {
    cliFail(
      EXIT.budget,
      "gate1_reservation_not_exact",
      "a Gate 1 provider plan must reserve exactly $5 from its verified pricing proof",
    );
  }
  if (maximum > ledger.operational_remaining_micro_usd) cliFail(EXIT.budget, "plan_exceeds_operational_gate", "plan maximum exceeds current operational budget remaining");
  const preCanaryPacket = await loadPreCanaryPacket(
    absolutePath(requiredOption(args, "gate0-packet"), dependencies.cwd),
  );
  const freezeLockSha256 = benchmarkFreezeLockSha256(freeze);
  const releaseVerification = verifyPaidReleaseGate(preCanaryPacket, {
    provider,
    model,
    evidenceClass: mode as "canary" | "pilot" | "confirmatory",
    sourceCommit: freeze.source_commit,
    sourceTree: freeze.source_tree,
    freezeLockSha256,
    ledgerId: ledger.ledger_id,
    now: createdAt,
  });
  if (!releaseVerification.valid || !releaseVerification.value) {
    cliFail(
      EXIT.integrity,
      "paid_release_gate_invalid",
      `paid release gate failed closed: ${releaseVerification.errors.join(",")}`,
    );
  }
  if (
    !preCanaryPacket.budget.ledger_head_sha256
    || !await filesystemBudgetLedgerContainsHead({
      ledgerPath,
      ancestorHeadSha256: preCanaryPacket.budget.ledger_head_sha256,
    })
  ) {
    cliFail(
      EXIT.integrity,
      "gate0_ledger_lineage_mismatch",
      "current budget ledger does not descend from the exact Gate 0 paused-zero head",
    );
  }
  const providerPricingProof = releaseVerification.value.providerPricingProof;
  if (
    providerPricingProof.derived.pricing_snapshot_sha256 !== costEnvelope.pricing_snapshot_sha256
    || providerPricingProof.derived.formula_sha256 !== costEnvelope.formula_sha256
    || providerPricingProof.derived.reservation_micro_usd !== maximum
  ) {
    cliFail(
      EXIT.integrity,
      "provider_pricing_envelope_mismatch",
      "cost envelope differs from the exact provider pricing proof selected by Gate 0",
    );
  }
  if (
    canonicalJson(costEnvelope)
    !== canonicalJson(providerPricingProofCostEnvelope(
      providerPricingProof,
      costEnvelope.limits_sha256,
    ))
  ) {
    cliFail(
      EXIT.integrity,
      "provider_pricing_decomposition_mismatch",
      "cost envelope is not the exact selected pricing proof line-item decomposition",
    );
  }
  assertProviderCapsMatchPlan(providerPricingProof.caps, limits);
  const suffix = dependencies.randomId();
  const planFreezeLockSha256 = freezeLockSha256;
  const releaseGate = Object.freeze({
    pre_canary_packet_sha256: preCanaryPacket.packet_sha256,
    provider_pricing_proof_sha256: providerPricingProof.proof_sha256,
    provider_hard_session_caps_sha256: providerHardSessionCapsSha256(providerPricingProof.caps),
    pricing_snapshot_sha256: providerPricingProof.derived.pricing_snapshot_sha256,
    pricing_formula_sha256: providerPricingProof.derived.formula_sha256,
    reservation_micro_usd: GATE_1_PROVIDER_RESERVATION_MICRO_USD,
    conservative_liability_micro_usd: providerPricingProof.derived.conservative_liability_micro_usd,
  });
  const planScenario = Object.freeze({
    path: scenarioRelativePath,
    id: loaded.scenario.id,
    version: loaded.scenario.version,
    canonical_sha256: loaded.canonicalHash,
    registry_key: loaded.source.registryKey,
    registry_entry_sha256: loaded.source.registryEntryHash,
    registry_catalog_sha256: SCENARIO_SOURCE_REGISTRY_HASH,
  });
  const planFixture = Object.freeze({
    manifest_sha256: fixture.manifest.manifest_sha256,
    caller_sequence_sha256: fixture.manifest.caller_sequence_sha256,
    rendition,
  });
  const planCell = Object.freeze({
    run_id: option(args, "run-id") ?? `run-${suffix}`,
    reservation_id: option(args, "reservation-id") ?? `reservation-${suffix}`,
    pair_id: option(args, "pair-id") ?? `pair-${suffix}`,
    provider,
    model,
    voice,
    condition: conditionId,
  });
  const plan = createBenchmarkExecutionPlan({
    schema_version: 1,
    plan_id: `plan-${suffix}`,
    mode: mode as "canary" | "pilot" | "confirmatory",
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    freeze_lock_sha256: planFreezeLockSha256,
    source_commit: freeze.source_commit,
    release_gate: releaseGate,
    scenario: planScenario,
    fixture: planFixture,
    cell: planCell,
    pair_invariants_sha256: benchmarkPairInvariantsSha256({
      freeze_lock_sha256: planFreezeLockSha256,
      source_commit: freeze.source_commit,
      release_gate: releaseGate,
      scenario: planScenario,
      fixture: planFixture,
      cell: planCell,
      limits,
      audio_delivery: audioDelivery,
      session_continuity: sessionContinuity,
      long_horizon_authorization: longHorizonAuthorization,
    }),
    study_plan_sha256: freeze.randomization_sha256,
    condition_hash: condition.conditionHash,
    prompt_hash: condition.initialPromptHash,
    provider_tools_hash: condition.providerToolsHash,
    kernel_attestation: {
      algorithm: "ed25519",
      key_id: attestationKeyId,
      public_key_pem: attestationPublicKeyPem,
      public_key_fingerprint_sha256: attestationPublicKeyFingerprint,
    },
    session_continuity: sessionContinuity,
    long_horizon_authorization: longHorizonAuthorization,
    limits,
    audio_delivery: audioDelivery,
    cost_envelope: {
      ...costEnvelope,
      components: costEnvelope.components.map((component) => ({ ...component })),
    },
    maximum_micro_usd: maximum,
    reservation_expires_at: reservationExpiresAt.toISOString(),
    ledger_id: ledger.ledger_id,
    output_root: option(args, "output-root") ?? "benchmarks/voice-long-horizon/results",
    artifact_schema_sha256: freeze.artifact_schema_sha256,
  });
  const out = absolutePath(requiredOption(args, "out"), dependencies.cwd);
  await writeExclusive(out, serializeBenchmarkExecutionPlan(plan));
  emit(dependencies.io, flag(args, "json"), {
    command: "plan",
    plan_path: out,
    plan_sha256: plan.plan_sha256,
    maximum_micro_usd: plan.maximum_micro_usd,
    kernel_attestation_key_id: plan.kernel_attestation.key_id,
    kernel_attestation_public_key_fingerprint_sha256: plan.kernel_attestation.public_key_fingerprint_sha256,
    exact_confirmation_max_usd: (plan.maximum_micro_usd / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""),
    network_calls: 0,
    spend_usd: "0",
  });
  return EXIT.ok;
}

function offlinePcm(text: string): Uint8Array {
  const seed = Buffer.from(sha256Hex(text), "hex");
  const bytes = new Uint8Array(640);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = seed[index % seed.length];
  return bytes;
}

function deterministicOfflineAttestationIdentity(seed: string): Readonly<{
  signer: BenchmarkKernelAttestationSigner;
  trust: Readonly<{ keyId: string; publicKeySha256: string; publicKeyPem: string }>;
}> {
  // RFC 8410 OneAsymmetricKey prefix followed by a deterministic 32-byte
  // Ed25519 seed. This key is deliberately offline-only: reproducibility, not
  // secret possession, is its purpose and the evidence binding says `offline`.
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(sha256Hex(`hacc/offline-kernel-attestation-key/v1\n${seed}`), "hex"),
  ]);
  const privateKey = createPrivateKey({ key: pkcs8, type: "pkcs8", format: "der" });
  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const signer = createBenchmarkKernelAttestationSigner({
    keyId: "offline-deterministic-ed25519-v1",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem,
  });
  return Object.freeze({
    signer,
    trust: Object.freeze({
      keyId: signer.keyId,
      publicKeySha256: signer.publicKeySha256,
      publicKeyPem,
    }),
  });
}

async function persistTrialArtifacts(journal: CrashDurableRunJournal, result: TrialResult): Promise<void> {
  for (const file of result.artifacts.files) {
    const bytes = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : file.content;
    await journal.writeBlob(`final/${file.path}`, bytes);
  }
  await journal.writeBlob("final/manifest.json", Buffer.from(result.artifacts.manifestJson, "utf8"));
}

async function commandOfflineRun(args: ParsedArguments, dependencies: Required<Pick<BenchmarkCliDependencies, "repositoryRoot" | "cwd" | "randomId" | "io">>): Promise<number> {
  rejectUnknown(args, ["json", "scenario", "condition", "output-root", "run-id"]);
  if (args.positionals.join(" ") !== "run offline" && args.positionals.join(" ") !== "offline run") {
    cliFail(EXIT.usage, "usage", "usage: voice-benchmark run offline --scenario FILE --condition ID [--output-root DIR]");
  }
  const scenarioPath = absolutePath(requiredOption(args, "scenario"), dependencies.cwd);
  const loaded = await loadScenario(scenarioPath);
  const conditionId = asCondition(requiredOption(args, "condition"));
  const compiled = compileScenario(loaded.source);
  const condition = compiled.suite.conditions[conditionId];
  const runId = option(args, "run-id") ?? `offline-${dependencies.randomId()}`;
  const callerTurns: readonly CallerAudioTurn[] = Object.freeze(loaded.scenario.caller.turns.map((turn) => Object.freeze({
    turnId: turn.id,
    audio: Object.freeze({ encoding: "pcm16" as const, sampleRateHz: 24_000, channels: 1 as const, data: offlinePcm(turn.utterance) }),
  })));
  const pair = createPairedAudioManifest({ pairId: `offline-pair-${sha256Hex(runId).slice(0, 16)}`, scenario: loaded.scenario, callerTurns });
  const offlinePlan = `${canonicalJson({
    schema_version: 1,
    mode: "offline",
    run_id: runId,
    scenario_hash: loaded.canonicalHash,
    scenario_registry_key: loaded.source.registryKey,
    scenario_registry_entry_sha256: loaded.source.registryEntryHash,
    scenario_registry_catalog_sha256: SCENARIO_SOURCE_REGISTRY_HASH,
    condition: conditionId,
    condition_hash: condition.conditionHash,
    network_allowed: false,
    provider_credentials_loaded: false,
  })}\n`;
  const offlinePlanHash = sha256Hex(offlinePlan);
  const outputRoot = option(args, "output-root")
    ? absolutePath(option(args, "output-root")!, dependencies.cwd)
    : resolve(dependencies.repositoryRoot, "benchmarks/voice-long-horizon/.local/results");
  let offlineJournalTick = 0;
  const offlineJournalEpochMs = Date.parse("2000-01-01T00:00:00.000Z");
  const journal = await CrashDurableRunJournal.create({
    outputRoot,
    planSha256: offlinePlanHash,
    runId,
    canonicalPlan: offlinePlan,
    // Wall-clock durability metadata is useful for paid recovery, but it made
    // the explicitly deterministic offline artifact tree differ on every run.
    // Advance a reproducible logical clock by one millisecond per WAL event.
    now: () => new Date(offlineJournalEpochMs + offlineJournalTick++),
  });
  try {
    const limits: TrialLimits = Object.freeze({
      maxTurns: loaded.scenario.max_turns,
      maxSessionMs: 60_000,
      maxInputAudioBytes: callerTurns.reduce((sum, turn) => sum + (turn.audio as { data: Uint8Array }).data.byteLength, 0),
      maxOutputAudioBytes: 1_000_000,
      maxToolCalls: 128,
      sessionReadyTimeoutMs: 1_000,
      responseTimeoutMs: 1_000,
    });
    const offlineModel = "offline-scripted-fake-v1";
    const offlineFreezeHash = sha256Hex(`hacc/offline-freeze-sentinel/v1\n${canonicalJson({
      scenario_registry_key: loaded.source.registryKey,
      scenario_registry_entry_sha256: loaded.source.registryEntryHash,
      scenario_registry_catalog_sha256: SCENARIO_SOURCE_REGISTRY_HASH,
    })}`);
    const offlineKernelBuildHash = sha256Hex(
      `hacc/offline-kernel-build/v1\n${InMemoryBenchmarkGatewayKernel.toString()}`
    );
    const offlineAttestation = deterministicOfflineAttestationIdentity(offlinePlanHash);
    const offlineEvidenceBinding = Object.freeze({
      pairId: pair.pair_id,
      leaseSubjectId: pair.pair_id,
      provider: "offline" as const,
      model: offlineModel,
      planSha256: offlinePlanHash,
      freezeLockSha256: offlineFreezeHash,
      kernelBuildSha256: offlineKernelBuildHash,
    });
    const offlinePairInvariantsHash = benchmarkPairInvariantsSha256({
      freeze_lock_sha256: offlineFreezeHash,
      source_commit: compiled.suite.sourceHash,
      scenario: {
        id: loaded.scenario.id,
        version: loaded.scenario.version,
        canonical_sha256: loaded.canonicalHash,
        registry_key: loaded.source.registryKey,
      },
      fixture: pair,
      cell: {
        pair_id: pair.pair_id,
        provider: "offline",
        model: offlineModel,
        voice: "none",
      },
      limits,
      audio_delivery: DEFAULT_TRIAL_AUDIO_DELIVERY_PROFILE,
    });
    const offlineStudyPlanHash = sha256Hex(`hacc/offline-study-plan/v1\n${canonicalJson({
      scenario_registry_key: loaded.source.registryKey,
      scenario_registry_catalog_sha256: SCENARIO_SOURCE_REGISTRY_HASH,
      model: offlineModel,
      protocol: "deterministic-open-loop-sensitivity-v1",
    })}`);
    const industrialFaultProfile = loaded.source.family === "industrial-field-service";
    const script = industrialFaultProfile
      ? createIndustrialOfflineFaultScript({ scenario: loaded.scenario, condition: conditionId })
      : createNoToolFakeScript({ turnIds: loaded.scenario.caller.turns.map((turn) => turn.id) });
    let offlineMonotonicMs = 0;
    let fakeClient: ScriptedFakeRealtimeClient | null = null;
    const result = await runBenchmarkTrial({
      runId,
      provider: "openai",
      model: offlineModel,
      scenario: loaded.scenario,
      createClient: (configuration) => {
        fakeClient = new ScriptedFakeRealtimeClient({
          script,
          initialCapabilitySnapshot: configuration.renderedCapabilitySnapshot,
          now: () => offlineMonotonicMs,
        });
        return fakeClient;
      },
      condition,
      gatewayKernel: new InMemoryBenchmarkGatewayKernel({
        flow: loaded.source.flow,
        expectedFlowHash: compiled.suite.flowHash,
        expectedScenarioHash: compiled.suite.scenarioHash,
        expectedConditionHash: condition.conditionHash,
        grantBindingHash: compiled.suite.sourceHash,
        leaseSubjectId: pair.pair_id,
        evidenceBinding: offlineEvidenceBinding,
        signer: offlineAttestation.signer,
        capabilitySecret: sha256Hex(`offline-pair-secret\n${pair.pair_id}\n${compiled.suite.sourceHash}`),
        leaseTtlSeconds: Math.ceil(limits.maxSessionMs / 1_000) + 60,
        clock: Object.freeze({
          nowMs: () => Date.parse("2026-07-10T12:00:00.000Z"),
          nowIso: () => "2026-07-10T12:00:00.000Z",
        }),
      }),
      kernelAttestationExpectation: Object.freeze({
        evidenceBinding: offlineEvidenceBinding,
        trust: offlineAttestation.trust,
      }),
      callerTurns,
      pairedAudio: pair,
      pairInvariantsHash: offlinePairInvariantsHash,
      studyPlanHash: offlineStudyPlanHash,
      limits,
      sleep(durationMs) {
        offlineMonotonicMs += durationMs;
      },
      clock: Object.freeze({
        monotonicNowMs: () => offlineMonotonicMs,
        wallTimeIso: () => "2026-07-10T12:00:00.000Z",
      }),
      budget: {
        ledger: createBudgetLedger({ authorization_ceiling_usd: "2", scheduling_stop_usd: "1" }),
        reservationId: `offline-budget-${sha256Hex(runId).slice(0, 16)}`,
        maximumUsd: "0.000001",
        persistLedger: async (ledger) => {
          await journal.append("offline.budget_snapshot", ledger);
        },
        estimateCost: () => ({ estimatedUsd: "0" }),
      },
    });
    if (!fakeClient) throw new Error("offline fake client was never constructed");
    const faultReport = industrialFaultProfile
      ? analyzeIndustrialOfflineFaultRun({
          condition: conditionId,
          scenario: loaded.scenario,
          world: result.world,
          toolResults: (fakeClient as ScriptedFakeRealtimeClient).observedToolResults,
        })
      : (() => {
          const evaluation = evaluateScenarioWorld(loaded.scenario, result.world);
          return Object.freeze({
            profile: "registered-scenario-transport-smoke" as const,
            task_success: evaluation.task_success,
            probes: Object.freeze({}),
            final_facts: Object.freeze({}),
          });
        })();
    if (industrialFaultProfile) {
      const harnessProfile = faultReport.profile === "full-harness-fault-e2e";
      const allProbesPassed = Object.values(faultReport.probes).every(Boolean);
      if (harnessProfile ? (!faultReport.task_success || !allProbesPassed) : faultReport.task_success) {
        throw new Error("offline adversarial profile did not produce its predeclared world/probe outcome");
      }
    }
    await journal.writeBlob(
      "offline-fault-report.json",
      Buffer.from(`${canonicalJson(faultReport)}\n`, "utf8")
    );
    await persistTrialArtifacts(journal, result);
    const complete = await journal.finalize({
      status: result.status,
      manifestSha256: sha256Hex(result.artifacts.manifestJson),
      budgetHeadSha256: sha256Hex(canonicalJson(result.budgetLedger)),
    });
    emit(dependencies.io, flag(args, "json"), {
      command: "run offline",
      run_id: result.runId,
      status: result.status,
      scenario_registry_key: loaded.source.registryKey,
      scenario_registry_entry_sha256: loaded.source.registryEntryHash,
      scenario_registry_catalog_sha256: SCENARIO_SOURCE_REGISTRY_HASH,
      turns_sent: result.counters.turnsSent,
      profile: faultReport.profile,
      world_task_success: faultReport.task_success,
      fault_probes: faultReport.probes,
      final_facts: faultReport.final_facts,
      artifact_path: complete,
      network_calls: 0,
      paid_ledger_touched: false,
      spend_usd: "0",
    });
    return EXIT.ok;
  } catch (error) {
    await journal.preservePartial("offline-run-failed", error);
    throw error;
  }
}

async function commandPaidRun(args: ParsedArguments, dependencies: Required<Pick<BenchmarkCliDependencies, "repositoryRoot" | "cwd" | "now" | "io">> & BenchmarkCliDependencies): Promise<number> {
  rejectUnknown(args, [
    "json", "plan", "freeze-lock", "fixture-root", "ledger", "output-root", "env-file", "include-gpu-hub-env",
    "confirm-paid-sha256", "confirm-max-usd", "kernel-attestation-private-key", "gate0-packet",
  ]);
  if (args.positionals.join(" ") !== "run paid" && args.positionals.join(" ") !== "paid run") {
    cliFail(EXIT.usage, "usage", "usage: voice-benchmark run paid --gate0-packet FILE --plan FILE --freeze-lock FILE --fixture-root DIR --ledger FILE --kernel-attestation-private-key FILE --confirm-paid-sha256 HASH --confirm-max-usd EXACT");
  }
  if (!dependencies.executePaid) cliFail(EXIT.protocol, "paid_executor_unavailable", "paid execution is blocked because the crash-durable runner integration is not installed");
  const plan = parseCanonicalBenchmarkExecutionPlan(await readNoFollow(absolutePath(requiredOption(args, "plan"), dependencies.cwd)));
  const confirmation = requiredOption(args, "confirm-paid-sha256");
  if (!/^[a-f0-9]{64}$/.test(confirmation) || confirmation !== plan.plan_sha256) {
    cliFail(EXIT.confirmation, "paid_hash_confirmation_mismatch", "full paid plan SHA-256 confirmation is missing or mismatched");
  }
  const exactMaximum = (plan.maximum_micro_usd / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (requiredOption(args, "confirm-max-usd") !== exactMaximum) {
    cliFail(EXIT.confirmation, "paid_max_confirmation_mismatch", `exact maximum confirmation must be ${exactMaximum}`);
  }
  const freeze = await loadFreeze(absolutePath(requiredOption(args, "freeze-lock"), dependencies.cwd));
  const preCanaryPacket = await loadPreCanaryPacket(
    absolutePath(requiredOption(args, "gate0-packet"), dependencies.cwd),
  );
  if (freeze.scenario_source_registry_sha256 !== SCENARIO_SOURCE_REGISTRY_HASH) {
    cliFail(EXIT.integrity, "scenario_registry_catalog_mismatch", "freeze lock differs from the live scenario source registry");
  }
  verifyExecutionPlanAgainstFreeze({ plan, freeze, now: dependencies.now() });
  await verifyFreezeCheckout({ freeze, repositoryRoot: dependencies.repositoryRoot, inspectGit: dependencies.inspectGit ?? defaultInspectGit });
  const scenarioPath = resolve(dependencies.repositoryRoot, ...plan.scenario.path.split("/"));
  const loaded = await loadScenario(scenarioPath);
  if (loaded.canonicalHash !== plan.scenario.canonical_sha256) cliFail(EXIT.integrity, "scenario_hash_mismatch", "scenario differs from the paid plan");
  if (
    loaded.source.registryKey !== plan.scenario.registry_key
    || loaded.source.registryEntryHash !== plan.scenario.registry_entry_sha256
    || plan.scenario.registry_catalog_sha256 !== SCENARIO_SOURCE_REGISTRY_HASH
  ) {
    cliFail(EXIT.integrity, "scenario_registry_mismatch", "scenario source registry binding differs from the paid plan");
  }
  const compiled = compileScenario(loaded.source);
  const condition = compiled.suite.conditions[plan.cell.condition];
  if (condition.conditionHash !== plan.condition_hash || condition.initialPromptHash !== plan.prompt_hash || condition.providerToolsHash !== plan.provider_tools_hash) {
    cliFail(EXIT.integrity, "condition_hash_mismatch", "compiled condition differs from the paid plan");
  }
  const fixture = await loadFrozenCallerAudioForPaidTrial({
    rootDirectory: absolutePath(requiredOption(args, "fixture-root"), dependencies.cwd),
    expectedScenario: scenarioIdentity(loaded.scenario, loaded.canonicalHash),
    expectedTurns: scenarioFixtureTurns(loaded.scenario),
    expectedManifestSha256: plan.fixture.manifest_sha256,
  });
  try {
    assertLongHorizonExecutionAuthorization(plan.long_horizon_authorization, {
      scenario: loaded.scenario,
      callerPcm: frozenFixtureCallerPcm(loaded.scenario, fixture, plan.fixture.rendition),
      mode: plan.mode as "canary" | "pilot" | "confirmatory",
      maxSessionMs: plan.limits.maxSessionMs,
      preregistrationSha256: freeze.preregistration_sha256,
      conditionSuiteSha256: compiled.suite.suiteHash,
      runnerConfigSha256: plan.cost_envelope.limits_sha256,
    });
  } catch (error) {
    cliFail(
      EXIT.protocol,
      "long_horizon_execution_ineligible",
      error instanceof Error ? error.message : "long-horizon execution authorization could not be reverified"
    );
  }
  const ledgerPath = absolutePath(requiredOption(args, "ledger"), dependencies.cwd);
  const ledger = await inspectFilesystemBudgetLedger({ ledgerPath });
  if (ledger.ledger_id !== plan.ledger_id) cliFail(EXIT.integrity, "ledger_id_mismatch", "paid plan binds a different budget ledger");
  if (ledger.state !== "open" || plan.maximum_micro_usd > ledger.operational_remaining_micro_usd) {
    cliFail(EXIT.budget, "budget_gate_refused", "budget ledger is closed or lacks the planned operational exposure");
  }
  if (plan.maximum_micro_usd !== GATE_1_PROVIDER_RESERVATION_MICRO_USD) {
    cliFail(EXIT.budget, "gate1_reservation_not_exact", "a Gate 1 paid run must reserve exactly $5");
  }
  const releaseVerification = verifyPaidReleaseGate(preCanaryPacket, {
    provider: plan.cell.provider,
    model: plan.cell.model,
    evidenceClass: plan.mode as "canary" | "pilot" | "confirmatory",
    sourceCommit: freeze.source_commit,
    sourceTree: freeze.source_tree,
    freezeLockSha256: benchmarkFreezeLockSha256(freeze),
    ledgerId: ledger.ledger_id,
    now: dependencies.now(),
  });
  if (!releaseVerification.valid || !releaseVerification.value) {
    cliFail(
      EXIT.integrity,
      "paid_release_gate_invalid",
      `paid release gate failed closed: ${releaseVerification.errors.join(",")}`,
    );
  }
  if (
    !preCanaryPacket.budget.ledger_head_sha256
    || !await filesystemBudgetLedgerContainsHead({
      ledgerPath,
      ancestorHeadSha256: preCanaryPacket.budget.ledger_head_sha256,
    })
  ) {
    cliFail(
      EXIT.integrity,
      "gate0_ledger_lineage_mismatch",
      "current budget ledger does not descend from the exact Gate 0 paused-zero head",
    );
  }
  const providerPricingProof = releaseVerification.value.providerPricingProof;
  if (
    preCanaryPacket.packet_sha256 !== plan.release_gate.pre_canary_packet_sha256
    || providerPricingProof.proof_sha256 !== plan.release_gate.provider_pricing_proof_sha256
    || providerHardSessionCapsSha256(providerPricingProof.caps)
      !== plan.release_gate.provider_hard_session_caps_sha256
    || providerPricingProof.derived.pricing_snapshot_sha256
      !== plan.release_gate.pricing_snapshot_sha256
    || providerPricingProof.derived.formula_sha256
      !== plan.release_gate.pricing_formula_sha256
    || providerPricingProof.derived.reservation_micro_usd
      !== plan.release_gate.reservation_micro_usd
    || providerPricingProof.derived.conservative_liability_micro_usd
      !== plan.release_gate.conservative_liability_micro_usd
    || plan.cost_envelope.pricing_snapshot_sha256
      !== providerPricingProof.derived.pricing_snapshot_sha256
    || plan.cost_envelope.formula_sha256
      !== providerPricingProof.derived.formula_sha256
  ) {
    cliFail(
      EXIT.integrity,
      "paid_release_binding_mismatch",
      "execution plan differs from its exact Gate 0 packet or provider pricing proof",
    );
  }
  if (
    canonicalJson(plan.cost_envelope)
    !== canonicalJson(providerPricingProofCostEnvelope(
      providerPricingProof,
      plan.cost_envelope.limits_sha256,
    ))
  ) {
    cliFail(
      EXIT.integrity,
      "provider_pricing_decomposition_mismatch",
      "execution-plan cost envelope is not the exact selected pricing proof decomposition",
    );
  }
  assertProviderCapsMatchPlan(providerPricingProof.caps, plan.limits);
  // Load private signing material only after every public/frozen input and the
  // read-only budget gate have passed, but still before provider credentials.
  const privateKeyPem = await readPrivateAttestationKey(absolutePath(
    requiredOption(args, "kernel-attestation-private-key"),
    dependencies.cwd
  ));
  let kernelAttestationSigner: BenchmarkKernelAttestationSigner;
  try {
    kernelAttestationSigner = createBenchmarkKernelAttestationSigner({
      keyId: plan.kernel_attestation.key_id,
      privateKeyPem,
      publicKeyPem: plan.kernel_attestation.public_key_pem,
    });
    if (kernelAttestationSigner.publicKeySha256 !== plan.kernel_attestation.public_key_fingerprint_sha256) {
      throw new Error("fingerprint mismatch");
    }
  } catch {
    cliFail(
      EXIT.integrity,
      "attestation_private_key_mismatch",
      "kernel attestation private key does not match the key ID and public-key fingerprint pinned by the paid plan"
    );
  }
  const envFile = option(args, "env-file");
  const environment = await resolveBenchmarkEnvironment({
    names: [PROVIDER_ENV[plan.cell.provider]],
    explicitEnvFiles: envFile ? [absolutePath(envFile, dependencies.cwd)] : [],
    repositoryRoot: dependencies.repositoryRoot,
    gpuHubRoot: flag(args, "include-gpu-hub-env") ? undefined : null,
    cwd: dependencies.cwd,
  });
  try {
    environment.require(PROVIDER_ENV[plan.cell.provider]);
  } catch {
    cliFail(EXIT.configuration, "provider_credential_missing", `required ${PROVIDER_ENV[plan.cell.provider]} credential is unavailable`);
  }
  const outputRoot = absolutePath(option(args, "output-root") ?? plan.output_root, dependencies.repositoryRoot);
  let result: PaidBenchmarkRunResult;
  try {
    result = await dependencies.executePaid({
      plan,
      freeze,
      scenario: loaded.scenario,
      condition,
      scenarioSource: loaded.source,
      suiteFlowHash: compiled.suite.flowHash,
      suiteScenarioHash: compiled.suite.scenarioHash,
      suiteSourceHash: compiled.suite.sourceHash,
      fixture,
      fixtureRendition: plan.fixture.rendition,
      kernelAttestationSigner,
      ledgerPath,
      outputRoot,
      environment,
      preCanaryPacket,
      providerPricingProof,
    });
  } catch {
    cliFail(EXIT.partial, "paid_partial_preserved", "paid execution did not finalize; inspect the durable partial and budget ledger before any retry");
  }
  emit(dependencies.io, flag(args, "json"), {
    command: "run paid",
    run_id: result.runId,
    status: result.status,
    artifact_path: result.artifactPath,
    budget_head_sha256: result.budgetHeadSha256,
    plan_sha256: plan.plan_sha256,
  });
  return result.status === "completed" ? EXIT.ok : EXIT.provider;
}

function usage(): string {
  return [
    "Harsha's Amazing Call Center voice benchmark",
    "",
    "Commands:",
    "  doctor",
    "  validate --freeze-lock FILE [--plan FILE --fixture-root DIR]",
    "  fixtures verify --root DIR --scenario FILE [--expected-manifest-sha256 HASH]",
    "  scenarios list [--json]",
    "  scenarios materialize --registry-key KEY --out FILE [--json]",
    "  plan --gate0-packet FILE --freeze-lock FILE --scenario FILE --fixture-root DIR --provider NAME --model ID --voice ID --condition ID --mode MODE --ledger FILE --cost-envelope FILE --kernel-attestation-key-id ID --kernel-attestation-public-key FILE --out FILE",
    "  run offline --scenario FILE --condition ID [--output-root DIR]",
    "  run paid --gate0-packet FILE --plan FILE --freeze-lock FILE --fixture-root DIR --ledger FILE --kernel-attestation-private-key FILE --confirm-paid-sha256 HASH --confirm-max-usd EXACT",
  ].join("\n");
}

export async function runBenchmarkCli(argv: readonly string[], input: BenchmarkCliDependencies = {}): Promise<number> {
  const dependencies = {
    ...input,
    repositoryRoot: resolve(input.repositoryRoot ?? MODULE_REPOSITORY_ROOT),
    cwd: resolve(input.cwd ?? process.cwd()),
    now: input.now ?? (() => new Date()),
    randomId: input.randomId ?? randomUUID,
    io: input.io ?? defaultIo(),
  };
  const args = parseArguments(argv);
  const command = args.positionals.join(" ");
  try {
    if (command === "" || command === "help" || flag(args, "help")) {
      dependencies.io.stdout(`${usage()}\n`);
      return EXIT.ok;
    }
    if (args.positionals[0] === "doctor") return await commandDoctor(args, dependencies);
    if (args.positionals[0] === "validate") return await commandValidate(args, dependencies);
    if (args.positionals[0] === "plan") return await commandPlan(args, dependencies);
    if (command === "fixtures verify") return await commandFixturesVerify(args, dependencies);
    if (command === "scenarios list") return await commandScenariosList(args, dependencies);
    if (command === "scenarios materialize") return await commandScenariosMaterialize(args, dependencies);
    if (command === "run offline" || command === "offline run") return await commandOfflineRun(args, dependencies);
    if (command === "run paid" || command === "paid run") return await commandPaidRun(args, dependencies);
    cliFail(EXIT.usage, "unknown_command", `unknown command: ${command || "(none)"}`);
  } catch (error) {
    const known = error instanceof BenchmarkCliError
      ? error
      : error instanceof BenchmarkPlanError
        ? new BenchmarkCliError(
            error.code === "ineligible" ? EXIT.protocol : EXIT.integrity,
            `plan_${error.code}`,
            error.message
          )
        : error instanceof FilesystemBudgetLedgerError
          ? new BenchmarkCliError(
              ["budget_refused", "paused", "lock_timeout"].includes(error.code) ? EXIT.budget : EXIT.durability,
              `budget_${error.code}`,
              error.message
            )
          : error instanceof z.ZodError
            ? new BenchmarkCliError(EXIT.integrity, "schema_validation_failed", error.issues[0]?.message ?? "schema validation failed")
            : new BenchmarkCliError(EXIT.internal, "internal_error", error instanceof Error ? error.message : "internal benchmark error");
    const safe = redactRunJournalValue({ error: { code: known.code, message: known.message }, exit_code: known.exitCode });
    dependencies.io.stderr(`${canonicalJson(safe)}\n`);
    return known.exitCode;
  }
}

export { EXIT as BENCHMARK_CLI_EXIT_CODES };

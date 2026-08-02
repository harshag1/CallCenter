import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalJson, sha256Hex } from "./artifacts";
import type { LiveStsProvider } from "./live-sts-development-experiment";

export const LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION =
  "HACC-LC4-QUALIFICATION-SHARDS-v1" as const;
export const LC4_QUALIFICATION_V4_PROVIDER_ORDER = Object.freeze([
  "openai",
  "gemini",
  "xai",
] as const satisfies readonly LiveStsProvider[]);
export const LC4_QUALIFICATION_V4_PROVIDER_MAXIMUM_MICRO_USD = 1_000_000 as const;
export const LC4_QUALIFICATION_V4_MAXIMUM_TOTAL_MICRO_USD = 3_000_000 as const;

const MANIFEST_DOMAIN = "harshas-amazing-call-center/lc4-qualification-v4-shard-manifest/v1\n";
const INVOCATION_DOMAIN = "harshas-amazing-call-center/lc4-qualification-v4-shard-invocation/v1\n";
const RESERVATION_DOMAIN = "harshas-amazing-call-center/lc4-qualification-v4-shard-reservation/v1\n";
const PHASE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-v4-shard-phase/v1\n";
const SHARD_DOMAIN = "harshas-amazing-call-center/lc4-qualification-v4-shard-terminal/v1\n";
const AGGREGATE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-v4-aggregate/v1\n";
const QUARANTINE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-v4-quarantine/v1\n";
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;

export type Lc4QualificationV4ProviderBinding = Readonly<{
  provider: LiveStsProvider;
  model: string;
  setup_configuration_sha256: string;
  paid_configuration_sha256: string;
  credential_sha256: string;
  caller_audio_sha256: string;
  caller_audio_bytes: number;
  audio_delivery_profile_sha256: string;
}>;

export type Lc4QualificationV4Binding = Readonly<{
  attempt_id: string;
  authorization_artifact_sha256: string;
  authorization_maximum_total_micro_usd: typeof LC4_QUALIFICATION_V4_MAXIMUM_TOTAL_MICRO_USD;
  plan_artifact_sha256: string;
  plan_sha256: string;
  source_commit: string;
  source_tree_sha256: string;
  credential_set_sha256: string;
  provider_profile_manifest_sha256: string;
  setup_configuration_matrix_sha256: string;
  paid_configuration_matrix_sha256: string;
  providers: readonly Lc4QualificationV4ProviderBinding[];
}>;

export type Lc4QualificationV4PhaseResult = Readonly<{
  status: "passed" | "failed";
  failure_class: string;
  evidence_sha256: string;
  wire_head_sha256: string | null;
  wire_observation_count: number;
  reconnect_count: number;
  usage_event_count: number;
  usage_evidence_sha256: string;
  provider_sessions_opened: 0 | 1;
  paid_sessions_opened: 0 | 1;
  generation_phases_attempted: 0 | 1 | 2;
  tool_roundtrips_attempted: 0 | 1;
}>;

export type Lc4QualificationV4PhaseContext = Readonly<{
  provider: LiveStsProvider;
  model: string;
  shard_id: string;
  reservation_id: string;
  predecessor_shard_terminal_sha256: string | null;
  setup_terminal_sha256: string | null;
  phase: "setup" | "paid";
}>;

export type Lc4QualificationV4Dependencies = Readonly<{
  runSetup(context: Lc4QualificationV4PhaseContext): Promise<Lc4QualificationV4PhaseResult>;
  runPaid(context: Lc4QualificationV4PhaseContext): Promise<Lc4QualificationV4PhaseResult>;
  /** Provider-free lifecycle hook; production callers omit it. */
  afterSetupTerminal?(context: Lc4QualificationV4PhaseContext): Promise<void>;
}>;

export type Lc4QualificationV4ShardTerminal = Readonly<{
  schema_version: 1;
  runner_version: typeof LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION;
  shard_id: string;
  ordinal: number;
  provider: LiveStsProvider;
  model: string;
  reservation_id: string;
  predecessor_shard_terminal_sha256: string | null;
  status: "passed" | "failed" | "cancelled";
  failure_class: string;
  setup_terminal_sha256: string | null;
  paid_terminal_sha256: string | null;
  provider_sessions_opened: number;
  paid_sessions_opened: number;
  generation_phases_attempted: number;
  tool_roundtrips_attempted: number;
  usage_event_count: number;
  usage_evidence_sha256: string;
  terminal_sha256: string;
}>;

export type Lc4QualificationV4Aggregate = Readonly<{
  schema_version: 1;
  runner_version: typeof LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION;
  attempt_id: string;
  manifest_sha256: string;
  status: "passed" | "failed";
  primary_failure_class: string | null;
  shard_terminal_sha256: readonly string[];
  provider_sessions_opened: number;
  paid_sessions_opened: number;
  generation_phases_attempted: number;
  tool_roundtrips_attempted: number;
  usage_event_count: number;
  usage_evidence_sha256: string;
  paid_retries_attempted: 0;
  maximum_total_micro_usd: typeof LC4_QUALIFICATION_V4_MAXIMUM_TOTAL_MICRO_USD;
  aggregate_sha256: string;
}>;

export type Lc4QualificationV4Manifest = Readonly<{
  schema_version: 1;
  runner_version: typeof LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION;
  binding: Lc4QualificationV4Binding;
  provider_order: typeof LC4_QUALIFICATION_V4_PROVIDER_ORDER;
  maximum_total_micro_usd: typeof LC4_QUALIFICATION_V4_MAXIMUM_TOTAL_MICRO_USD;
  reservations: readonly Lc4QualificationV4Reservation[];
  manifest_sha256: string;
}>;

export type Lc4QualificationV4Reservation = Readonly<{
  schema_version: 1;
  shard_id: string;
  reservation_id: string;
  ordinal: number;
  provider: LiveStsProvider;
  model: string;
  predecessor_provider: LiveStsProvider | null;
  maximum_micro_usd: typeof LC4_QUALIFICATION_V4_PROVIDER_MAXIMUM_MICRO_USD;
  paid_retry_allowed: false;
  reservation_sha256: string;
}>;

export type Lc4QualificationV4PhaseTerminal = Readonly<{
  schema_version: 1;
  shard_id: string;
  reservation_id: string;
  provider: LiveStsProvider;
  model: string;
  phase: "setup" | "paid";
  predecessor_shard_terminal_sha256: string | null;
  setup_terminal_sha256: string | null;
  result: Lc4QualificationV4PhaseResult;
  phase_terminal_sha256: string;
}>;

function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function requireSha(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function requireId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} is not a safe identifier`);
}

function assertBinding(binding: Lc4QualificationV4Binding): void {
  requireId(binding.attempt_id, "qualification attempt ID");
  requireId(binding.source_commit, "qualification source commit");
  for (const [label, value] of Object.entries(binding).filter(([key]) => key.endsWith("sha256"))) {
    requireSha(value as string, `qualification ${label}`);
  }
  if (binding.authorization_maximum_total_micro_usd !== LC4_QUALIFICATION_V4_MAXIMUM_TOTAL_MICRO_USD) {
    throw new Error("qualification shard reservations require the exact signed $3 authority");
  }
  if (binding.providers.length !== LC4_QUALIFICATION_V4_PROVIDER_ORDER.length) {
    throw new Error("qualification binding must contain exactly three provider shards");
  }
  for (let ordinal = 0; ordinal < LC4_QUALIFICATION_V4_PROVIDER_ORDER.length; ordinal += 1) {
    const provider = binding.providers[ordinal];
    if (!provider || provider.provider !== LC4_QUALIFICATION_V4_PROVIDER_ORDER[ordinal]) {
      throw new Error("qualification provider bindings must use frozen OpenAI, Gemini, xAI order");
    }
    requireId(provider.model, `${provider.provider} model`);
    requireSha(provider.setup_configuration_sha256, `${provider.provider} setup configuration`);
    requireSha(provider.paid_configuration_sha256, `${provider.provider} paid configuration`);
    requireSha(provider.credential_sha256, `${provider.provider} credential`);
    requireSha(provider.caller_audio_sha256, `${provider.provider} caller audio`);
    requireSha(provider.audio_delivery_profile_sha256, `${provider.provider} audio delivery profile`);
    if (!Number.isSafeInteger(provider.caller_audio_bytes) || provider.caller_audio_bytes <= 0) {
      throw new Error(`${provider.provider} caller audio byte count is invalid`);
    }
  }
}

function outside(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === ".." || relation.startsWith(`..${sep}`);
}

async function assertRoot(rootPath: string, repositoryRoot: string): Promise<string> {
  if (!isAbsolute(rootPath) || resolve(rootPath) !== rootPath) {
    throw new Error("qualification shard root must be absolute and normalized");
  }
  if (!isAbsolute(repositoryRoot) || resolve(repositoryRoot) !== repositoryRoot) {
    throw new Error("qualification repository root must be absolute and normalized");
  }
  const root = resolve(rootPath);
  const rootInfo = await lstat(root);
  const physicalRoot = await realpath(root);
  const physicalRepository = await realpath(repositoryRoot);
  if (!rootInfo.isDirectory()
    || rootInfo.isSymbolicLink()
    || (rootInfo.mode & 0o7777) !== 0o700
    || !outside(physicalRepository, physicalRoot)) {
    throw new Error("qualification shard root must be a private physical directory outside the repository");
  }
  return root;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o7777) !== 0o700) {
    throw new Error(`qualification directory is not private and physical: ${basename(path)}`);
  }
  // Sync the parent even when another process won mkdir: its directory entry
  // must be durable before either process may publish an admission beneath it.
  await syncDirectory(parent);
  await syncDirectory(path);
}

async function writeImmutable(path: string, value: unknown): Promise<"created" | "existing"> {
  const parentMetadata = await lstat(dirname(path));
  if (!parentMetadata.isDirectory()
    || parentMetadata.isSymbolicLink()
    || (parentMetadata.mode & 0o7777) !== 0o700) {
    throw new Error(`qualification artifact parent is not private and physical: ${basename(dirname(path))}`);
  }
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o400 });
  const handle = await open(temporary, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await chmod(path, 0o400);
    await syncDirectory(dirname(path));
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
      throw new Error(`immutable qualification artifact is unsafe at ${basename(path)}`);
    }
    const retained = await readFile(path);
    if (!retained.equals(bytes)) throw new Error(`immutable qualification artifact differs at ${basename(path)}`);
    return "existing";
  } finally {
    await unlink(temporary).catch(() => undefined);
    await syncDirectory(dirname(path));
  }
}

async function readJson<T>(path: string): Promise<T> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o077) !== 0) {
    throw new Error(`qualification artifact is not a private regular file: ${basename(path)}`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
    throw new Error(`qualification artifact changed while read: ${basename(path)}`);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

function reservation(binding: Lc4QualificationV4Binding, ordinal: number): Lc4QualificationV4Reservation {
  const provider = binding.providers[ordinal]!;
  const seed = freeze({
    attempt_id: binding.attempt_id,
    authorization_artifact_sha256: binding.authorization_artifact_sha256,
    ordinal,
    provider: provider.provider,
    model: provider.model,
    maximum_micro_usd: LC4_QUALIFICATION_V4_PROVIDER_MAXIMUM_MICRO_USD,
  });
  const identity = sha256Hex(`${RESERVATION_DOMAIN}${canonicalJson(seed)}`);
  const body = freeze({
    schema_version: 1 as const,
    shard_id: `lc4qv4:${ordinal}:${provider.provider}:${identity.slice(0, 24)}`,
    reservation_id: `lc4qv4-reservation:${ordinal}:${provider.provider}:${identity.slice(0, 24)}`,
    ordinal,
    provider: provider.provider,
    model: provider.model,
    predecessor_provider: ordinal === 0 ? null : LC4_QUALIFICATION_V4_PROVIDER_ORDER[ordinal - 1]!,
    maximum_micro_usd: LC4_QUALIFICATION_V4_PROVIDER_MAXIMUM_MICRO_USD,
    paid_retry_allowed: false as const,
  });
  return freeze({
    ...body,
    reservation_sha256: sha256Hex(`${RESERVATION_DOMAIN}${canonicalJson(body)}`),
  });
}

function manifest(binding: Lc4QualificationV4Binding): Lc4QualificationV4Manifest {
  assertBinding(binding);
  const body = freeze({
    schema_version: 1 as const,
    runner_version: LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION,
    binding,
    provider_order: LC4_QUALIFICATION_V4_PROVIDER_ORDER,
    maximum_total_micro_usd: LC4_QUALIFICATION_V4_MAXIMUM_TOTAL_MICRO_USD,
    reservations: freeze(LC4_QUALIFICATION_V4_PROVIDER_ORDER.map((_, ordinal) => reservation(binding, ordinal))),
  });
  return freeze({ ...body, manifest_sha256: sha256Hex(`${MANIFEST_DOMAIN}${canonicalJson(body)}`) });
}

function assertManifest(value: Lc4QualificationV4Manifest, binding: Lc4QualificationV4Binding): void {
  const expected = manifest(binding);
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error("qualification shard source, authorization, model, credential, audio, profile, or plan binding changed");
  }
}

function phaseTerminal(
  context: Lc4QualificationV4PhaseContext,
  result: Lc4QualificationV4PhaseResult,
): Lc4QualificationV4PhaseTerminal {
  if (result.status !== "passed" && result.status !== "failed") {
    throw new Error(`${context.provider} ${context.phase} status is invalid`);
  }
  requireSha(result.evidence_sha256, `${context.provider} ${context.phase} evidence`);
  requireSha(result.usage_evidence_sha256, `${context.provider} ${context.phase} usage evidence`);
  if (result.wire_head_sha256 !== null) requireSha(result.wire_head_sha256, `${context.provider} wire head`);
  if (!Number.isSafeInteger(result.wire_observation_count)
    || result.wire_observation_count < 0
    || !Number.isSafeInteger(result.reconnect_count)
    || result.reconnect_count < 0
    || result.reconnect_count > result.wire_observation_count
    || (result.status === "passed" && (result.wire_head_sha256 === null || result.wire_observation_count === 0))) {
    throw new Error(`${context.provider} ${context.phase} wire counters are invalid`);
  }
  if (!Number.isSafeInteger(result.usage_event_count) || result.usage_event_count < 0) {
    throw new Error(`${context.provider} ${context.phase} usage count is invalid`);
  }
  if ((result.status === "passed") !== (result.failure_class === "none")) {
    throw new Error(`${context.provider} ${context.phase} status and failure class disagree`);
  }
  const counts = [
    result.provider_sessions_opened,
    result.paid_sessions_opened,
    result.generation_phases_attempted,
    result.tool_roundtrips_attempted,
  ];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)
    || result.provider_sessions_opened > 1
    || result.paid_sessions_opened > 1
    || result.generation_phases_attempted > 2
    || result.tool_roundtrips_attempted > 1
    || (context.phase === "setup" && (
      result.paid_sessions_opened !== 0
      || result.generation_phases_attempted !== 0
      || result.tool_roundtrips_attempted !== 0
    ))
    || (context.phase === "paid" && result.paid_sessions_opened > result.provider_sessions_opened)
    || (result.status === "passed" && context.phase === "setup" && result.provider_sessions_opened !== 1)
    || (result.status === "passed" && context.phase === "paid" && (
      result.provider_sessions_opened !== 1
      || result.paid_sessions_opened !== 1
      || result.generation_phases_attempted !== 2
      || result.tool_roundtrips_attempted !== 1
    ))) {
    throw new Error(`${context.provider} ${context.phase} attempt counters are invalid`);
  }
  const body = freeze({
    schema_version: 1 as const,
    shard_id: context.shard_id,
    reservation_id: context.reservation_id,
    provider: context.provider,
    model: context.model,
    phase: context.phase,
    predecessor_shard_terminal_sha256: context.predecessor_shard_terminal_sha256,
    setup_terminal_sha256: context.setup_terminal_sha256,
    result,
  });
  return freeze({ ...body, phase_terminal_sha256: sha256Hex(`${PHASE_DOMAIN}${canonicalJson(body)}`) });
}

function assertPhaseTerminal(value: Lc4QualificationV4PhaseTerminal, context: Lc4QualificationV4PhaseContext): void {
  const expected = phaseTerminal(context, value.result);
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error(`${context.provider} retained ${context.phase} terminal failed integrity or predecessor binding`);
  }
}

function shardTerminal(input: Readonly<{
  reservation: Lc4QualificationV4Reservation;
  predecessor: string | null;
  setup: Lc4QualificationV4PhaseTerminal | null;
  paid: Lc4QualificationV4PhaseTerminal | null;
  status: "passed" | "failed" | "cancelled";
  failureClass: string;
}>): Lc4QualificationV4ShardTerminal {
  const providerSessionsOpened = (input.setup?.result.provider_sessions_opened ?? 0)
    + (input.paid?.result.provider_sessions_opened ?? 0);
  const paidSessionsOpened = input.paid?.result.paid_sessions_opened ?? 0;
  const generationPhasesAttempted = input.paid?.result.generation_phases_attempted ?? 0;
  const toolRoundtripsAttempted = input.paid?.result.tool_roundtrips_attempted ?? 0;
  const usageProjection = freeze([input.setup, input.paid].flatMap((phase) => phase === null ? [] : [freeze({
    phase: phase.phase,
    usage_event_count: phase.result.usage_event_count,
    usage_evidence_sha256: phase.result.usage_evidence_sha256,
  })]));
  const body = freeze({
    schema_version: 1 as const,
    runner_version: LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION,
    shard_id: input.reservation.shard_id,
    ordinal: input.reservation.ordinal,
    provider: input.reservation.provider,
    model: input.reservation.model,
    reservation_id: input.reservation.reservation_id,
    predecessor_shard_terminal_sha256: input.predecessor,
    status: input.status,
    failure_class: input.failureClass,
    setup_terminal_sha256: input.setup?.phase_terminal_sha256 ?? null,
    paid_terminal_sha256: input.paid?.phase_terminal_sha256 ?? null,
    provider_sessions_opened: providerSessionsOpened,
    paid_sessions_opened: paidSessionsOpened,
    generation_phases_attempted: generationPhasesAttempted,
    tool_roundtrips_attempted: toolRoundtripsAttempted,
    usage_event_count: usageProjection.reduce((sum, entry) => sum + entry.usage_event_count, 0),
    usage_evidence_sha256: sha256Hex(canonicalJson(usageProjection)),
  });
  return freeze({ ...body, terminal_sha256: sha256Hex(`${SHARD_DOMAIN}${canonicalJson(body)}`) });
}

function assertShardTerminal(value: Lc4QualificationV4ShardTerminal, expected: Omit<Parameters<typeof shardTerminal>[0], "setup" | "paid"> & Readonly<{ setup: Lc4QualificationV4PhaseTerminal | null; paid: Lc4QualificationV4PhaseTerminal | null }>): void {
  const rebuilt = shardTerminal(expected);
  if (canonicalJson(value) !== canonicalJson(rebuilt)) {
    throw new Error(`${value.provider} completed shard failed immutable integrity`);
  }
}

function admissionArtifact(context: Lc4QualificationV4PhaseContext) {
  const body = freeze({
    schema_version: 1,
    ...context,
    network_emission_may_have_occurred_after_this_fsync: true,
  });
  return freeze({
    ...body,
    admission_sha256: sha256Hex(`${PHASE_DOMAIN}${canonicalJson(body)}`),
  });
}

async function retainAdmission(
  path: string,
  context: Lc4QualificationV4PhaseContext,
): Promise<"created" | "existing"> {
  return writeImmutable(path, admissionArtifact(context));
}

async function assertAdmission(path: string, context: Lc4QualificationV4PhaseContext): Promise<void> {
  const retained = await readJson<ReturnType<typeof admissionArtifact>>(path);
  if (canonicalJson(retained) !== canonicalJson(admissionArtifact(context))) {
    throw new Error(`${context.provider} retained ${context.phase} admission failed integrity`);
  }
}

async function quarantine(
  shardPath: string,
  reservationValue: Lc4QualificationV4Reservation,
  phase: "setup" | "paid",
  predecessor: string | null,
  setupTerminalSha256: string | null,
): Promise<never> {
  const path = resolve(shardPath, `${phase}-quarantine.json`);
  const body = freeze({
    schema_version: 1,
    shard_id: reservationValue.shard_id,
    reservation_id: reservationValue.reservation_id,
    provider: reservationValue.provider,
    phase,
    predecessor_shard_terminal_sha256: predecessor,
    setup_terminal_sha256: setupTerminalSha256,
    disposition: "terminal_ambiguous_no_retry_no_reconnect_no_replacement",
  });
  await writeImmutable(path, freeze({
    ...body,
    quarantine_sha256: sha256Hex(`${QUARANTINE_DOMAIN}${canonicalJson(body)}`),
  }));
  throw new Error(`${reservationValue.provider} ${phase} was admitted without terminal evidence; shard quarantined`);
}

async function runPhase(input: Readonly<{
  shardPath: string;
  reservation: Lc4QualificationV4Reservation;
  predecessor: string | null;
  setupTerminalSha256: string | null;
  phase: "setup" | "paid";
  execute(context: Lc4QualificationV4PhaseContext): Promise<Lc4QualificationV4PhaseResult>;
}>): Promise<Lc4QualificationV4PhaseTerminal> {
  const context = freeze({
    provider: input.reservation.provider,
    model: input.reservation.model,
    shard_id: input.reservation.shard_id,
    reservation_id: input.reservation.reservation_id,
    predecessor_shard_terminal_sha256: input.predecessor,
    setup_terminal_sha256: input.setupTerminalSha256,
    phase: input.phase,
  });
  const admissionPath = resolve(input.shardPath, `${input.phase}-admission.json`);
  const terminalPath = resolve(input.shardPath, `${input.phase}-terminal.json`);
  const terminalExists = await exists(terminalPath);
  if (terminalExists) {
    if (!await exists(admissionPath)) {
      throw new Error(`${input.reservation.provider} retained ${input.phase} terminal lacks its admission boundary`);
    }
    await assertAdmission(admissionPath, context);
    const retained = await readJson<Lc4QualificationV4PhaseTerminal>(terminalPath);
    assertPhaseTerminal(retained, context);
    return retained;
  }
  if (await exists(admissionPath)) {
    return quarantine(
      input.shardPath,
      input.reservation,
      input.phase,
      input.predecessor,
      input.setupTerminalSha256,
    );
  }
  const admissionDisposition = await retainAdmission(admissionPath, context);
  if (admissionDisposition !== "created") {
    // Atomic publication, rather than the preceding advisory existence check,
    // decides who may execute. A concurrent contender never calls a provider.
    return quarantine(
      input.shardPath,
      input.reservation,
      input.phase,
      input.predecessor,
      input.setupTerminalSha256,
    );
  }
  let terminal: Lc4QualificationV4PhaseTerminal;
  try {
    const result = await input.execute(context);
    terminal = phaseTerminal(context, freeze(result));
  } catch {
    return quarantine(
      input.shardPath,
      input.reservation,
      input.phase,
      input.predecessor,
      input.setupTerminalSha256,
    );
  }
  if (await exists(resolve(input.shardPath, `${input.phase}-quarantine.json`))) {
    throw new Error(`${input.reservation.provider} ${input.phase} was concurrently quarantined`);
  }
  await writeImmutable(terminalPath, terminal);
  return terminal;
}

async function loadRetainedPhase(input: Readonly<{
  shardPath: string;
  reservation: Lc4QualificationV4Reservation;
  predecessor: string | null;
  setupTerminalSha256: string | null;
  phase: "setup" | "paid";
}>): Promise<Lc4QualificationV4PhaseTerminal | null> {
  const terminalPath = resolve(input.shardPath, `${input.phase}-terminal.json`);
  if (!await exists(terminalPath)) return null;
  const context = freeze({
    provider: input.reservation.provider,
    model: input.reservation.model,
    shard_id: input.reservation.shard_id,
    reservation_id: input.reservation.reservation_id,
    predecessor_shard_terminal_sha256: input.predecessor,
    setup_terminal_sha256: input.setupTerminalSha256,
    phase: input.phase,
  });
  const admissionPath = resolve(input.shardPath, `${input.phase}-admission.json`);
  if (!await exists(admissionPath)) {
    throw new Error(`${input.reservation.provider} retained ${input.phase} terminal lacks admission evidence`);
  }
  await assertAdmission(admissionPath, context);
  const retained = await readJson<Lc4QualificationV4PhaseTerminal>(terminalPath);
  assertPhaseTerminal(retained, context);
  return retained;
}

function aggregate(manifestValue: Lc4QualificationV4Manifest, shards: readonly Lc4QualificationV4ShardTerminal[]): Lc4QualificationV4Aggregate {
  const failure = shards.find((shard) => shard.status === "failed");
  const body = freeze({
    schema_version: 1 as const,
    runner_version: LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION,
    attempt_id: manifestValue.binding.attempt_id,
    manifest_sha256: manifestValue.manifest_sha256,
    status: failure === undefined && shards.every((shard) => shard.status === "passed") ? "passed" as const : "failed" as const,
    primary_failure_class: failure?.failure_class ?? (shards.some((shard) => shard.status === "cancelled") ? "predecessor_failed" : null),
    shard_terminal_sha256: freeze(shards.map((shard) => shard.terminal_sha256)),
    provider_sessions_opened: shards.reduce((sum, shard) => sum + shard.provider_sessions_opened, 0),
    paid_sessions_opened: shards.reduce((sum, shard) => sum + shard.paid_sessions_opened, 0),
    generation_phases_attempted: shards.reduce((sum, shard) => sum + shard.generation_phases_attempted, 0),
    tool_roundtrips_attempted: shards.reduce((sum, shard) => sum + shard.tool_roundtrips_attempted, 0),
    usage_event_count: shards.reduce((sum, shard) => sum + shard.usage_event_count, 0),
    usage_evidence_sha256: sha256Hex(canonicalJson(shards.map((shard) => Object.freeze({
      provider: shard.provider,
      usage_event_count: shard.usage_event_count,
      usage_evidence_sha256: shard.usage_evidence_sha256,
    })))),
    paid_retries_attempted: 0 as const,
    maximum_total_micro_usd: LC4_QUALIFICATION_V4_MAXIMUM_TOTAL_MICRO_USD,
  });
  return freeze({ ...body, aggregate_sha256: sha256Hex(`${AGGREGATE_DOMAIN}${canonicalJson(body)}`) });
}

export type Lc4QualificationV4ReplayShard = Readonly<{
  reservation: Lc4QualificationV4Reservation;
  setup_admission: unknown | null;
  setup_terminal: Lc4QualificationV4PhaseTerminal | null;
  paid_admission: unknown | null;
  paid_terminal: Lc4QualificationV4PhaseTerminal | null;
  shard_terminal: Lc4QualificationV4ShardTerminal;
}>;

/**
 * Provider-free custody replay for a terminalized qualification attempt.
 *
 * This accepts the exact all-pass union or the exact failed-prefix followed by
 * zero-session cancellations. It proves what happened; it does not confer
 * release or publication eligibility.
 */
export function assertLc4QualificationV4TerminalReplay(input: Readonly<{
  binding: Lc4QualificationV4Binding;
  manifest: Lc4QualificationV4Manifest;
  aggregate: Lc4QualificationV4Aggregate;
  shards: readonly Lc4QualificationV4ReplayShard[];
}>): "passed" | "failed" {
  assertManifest(input.manifest, input.binding);
  if (input.shards.length !== LC4_QUALIFICATION_V4_PROVIDER_ORDER.length) {
    throw new Error("qualification v4 replay must contain exactly three provider shards");
  }
  const terminals: Lc4QualificationV4ShardTerminal[] = [];
  let predecessor: string | null = null;
  let stopped = false;
  for (let ordinal = 0; ordinal < input.shards.length; ordinal += 1) {
    const shard = input.shards[ordinal]!;
    const expectedReservation = input.manifest.reservations[ordinal]!;
    if (canonicalJson(shard.reservation) !== canonicalJson(expectedReservation)) {
      throw new Error("qualification v4 replay shard reservation was substituted or reordered");
    }
    if (shard.shard_terminal.status === "cancelled") {
      if (!stopped
        || shard.setup_admission !== null
        || shard.setup_terminal !== null
        || shard.paid_admission !== null
        || shard.paid_terminal !== null) {
        throw new Error("qualification v4 cancelled replay shard lacks a failed predecessor or contains phase evidence");
      }
      assertShardTerminal(shard.shard_terminal, {
        reservation: expectedReservation,
        predecessor,
        setup: null,
        paid: null,
        status: "cancelled",
        failureClass: "predecessor_failed",
      });
      terminals.push(shard.shard_terminal);
      predecessor = shard.shard_terminal.terminal_sha256;
      continue;
    }
    if (stopped) {
      throw new Error("qualification v4 replay contains a non-cancelled shard after failure");
    }
    if (shard.setup_admission === null || shard.setup_terminal === null) {
      throw new Error("qualification v4 replay non-cancelled shard lacks setup evidence");
    }
    const setupContext = freeze({
      provider: expectedReservation.provider,
      model: expectedReservation.model,
      shard_id: expectedReservation.shard_id,
      reservation_id: expectedReservation.reservation_id,
      predecessor_shard_terminal_sha256: predecessor,
      setup_terminal_sha256: null,
      phase: "setup" as const,
    });
    if (canonicalJson(shard.setup_admission) !== canonicalJson(admissionArtifact(setupContext))) {
      throw new Error("qualification v4 replay setup admission differs from its shard");
    }
    assertPhaseTerminal(shard.setup_terminal, setupContext);
    if (shard.setup_terminal.result.status === "failed") {
      if (shard.paid_admission !== null || shard.paid_terminal !== null) {
        throw new Error("qualification v4 replay ran paid phase after failed setup");
      }
      assertShardTerminal(shard.shard_terminal, {
        reservation: expectedReservation,
        predecessor,
        setup: shard.setup_terminal,
        paid: null,
        status: "failed",
        failureClass: shard.setup_terminal.result.failure_class,
      });
      terminals.push(shard.shard_terminal);
      predecessor = shard.shard_terminal.terminal_sha256;
      stopped = true;
      continue;
    }
    if (shard.paid_admission === null || shard.paid_terminal === null) {
      throw new Error("qualification v4 replay setup-passed shard lacks paid evidence");
    }
    const paidContext = freeze({
      ...setupContext,
      setup_terminal_sha256: shard.setup_terminal.phase_terminal_sha256,
      phase: "paid" as const,
    });
    if (canonicalJson(shard.paid_admission) !== canonicalJson(admissionArtifact(paidContext))) {
      throw new Error("qualification v4 replay paid admission differs from its shard");
    }
    assertPhaseTerminal(shard.paid_terminal, paidContext);
    const status = shard.paid_terminal.result.status;
    assertShardTerminal(shard.shard_terminal, {
      reservation: expectedReservation,
      predecessor,
      setup: shard.setup_terminal,
      paid: shard.paid_terminal,
      status,
      failureClass: shard.paid_terminal.result.failure_class,
    });
    terminals.push(shard.shard_terminal);
    predecessor = shard.shard_terminal.terminal_sha256;
    stopped = status === "failed";
  }
  const expectedAggregate = aggregate(input.manifest, freeze(terminals));
  if (canonicalJson(input.aggregate) !== canonicalJson(expectedAggregate)) {
    throw new Error("qualification v4 aggregate differs from its ordered terminal shard replay");
  }
  return input.aggregate.status;
}

/** Strict release gate: custody-valid failures remain ineligible. */
export function assertLc4QualificationV4CompletedReplay(input: Readonly<{
  binding: Lc4QualificationV4Binding;
  manifest: Lc4QualificationV4Manifest;
  aggregate: Lc4QualificationV4Aggregate;
  shards: readonly Lc4QualificationV4ReplayShard[];
}>): void {
  const status = assertLc4QualificationV4TerminalReplay(input);
  if (status !== "passed"
    || input.aggregate.provider_sessions_opened !== 6
    || input.aggregate.paid_sessions_opened !== 3
    || input.aggregate.generation_phases_attempted !== 6
    || input.aggregate.tool_roundtrips_attempted !== 3
    || input.aggregate.paid_retries_attempted !== 0) {
    throw new Error("qualification v4 aggregate is not one completed publication-eligible replay");
  }
}

/**
 * Executes three serial provider shards. The only resumable boundaries are:
 *   1. a pre-materialized shard with no admission artifact; and
 *   2. a retained setup terminal before paid admission.
 * Any admission without terminal evidence is scientifically ambiguous and is
 * permanently quarantined. Completed shards are loaded and hash-verified, not
 * regenerated, so process restart cannot change their evidence bytes.
 */
export async function runLc4QualificationV4ProviderShards(input: Readonly<{
  root: string;
  repository_root: string;
  binding: Lc4QualificationV4Binding;
  dependencies: Lc4QualificationV4Dependencies;
  invoked_at: string;
}>): Promise<Lc4QualificationV4Aggregate> {
  const root = await assertRoot(input.root, input.repository_root);
  assertBinding(input.binding);
  if (new Date(input.invoked_at).toISOString() !== input.invoked_at) {
    throw new Error("qualification invocation time must be canonical ISO");
  }
  const expectedManifest = manifest(freeze(input.binding));
  const invocationBody = freeze({
    schema_version: 1,
    runner_version: LC4_QUALIFICATION_V4_SHARD_RUNNER_VERSION,
    attempt_id: input.binding.attempt_id,
    authorization_artifact_sha256: input.binding.authorization_artifact_sha256,
    invoked_at: input.invoked_at,
  });
  const invocation = freeze({
    ...invocationBody,
    invocation_sha256: sha256Hex(`${INVOCATION_DOMAIN}${canonicalJson(invocationBody)}`),
  });
  const invocationDisposition = await writeImmutable(resolve(root, "qualification-v4-invocation.json"), invocation);
  if (invocationDisposition === "existing") {
    const retained = await readJson<typeof invocation>(resolve(root, "qualification-v4-invocation.json"));
    if (retained.invoked_at !== input.invoked_at) {
      throw new Error("qualification restart must reuse the exact original invocation timestamp");
    }
  }
  await writeImmutable(resolve(root, "qualification-v4-shard-manifest.json"), expectedManifest);
  const retainedManifest = await readJson<Lc4QualificationV4Manifest>(resolve(root, "qualification-v4-shard-manifest.json"));
  assertManifest(retainedManifest, input.binding);

  // All three exact $1 reservation artifacts are fsynced before any callback
  // can construct a provider client. Their sum is the existing exact $3 cap.
  const shardsRoot = resolve(root, "qualification-v4-shards");
  await ensurePrivateDirectory(shardsRoot);
  for (const entry of retainedManifest.reservations) {
    const shardPath = resolve(shardsRoot, `${entry.ordinal}-${entry.provider}`);
    await ensurePrivateDirectory(shardPath);
    await writeImmutable(resolve(shardPath, "reservation.json"), entry);
  }

  const terminals: Lc4QualificationV4ShardTerminal[] = [];
  let predecessor: string | null = null;
  let stopped = false;
  for (const entry of retainedManifest.reservations) {
    const shardPath = resolve(root, "qualification-v4-shards", `${entry.ordinal}-${entry.provider}`);
    const terminalPath = resolve(shardPath, "shard-terminal.json");
    if (await exists(terminalPath)) {
      const setup = await loadRetainedPhase({
        shardPath,
        reservation: entry,
        predecessor,
        setupTerminalSha256: null,
        phase: "setup",
      });
      const paid = await loadRetainedPhase({
        shardPath,
        reservation: entry,
        predecessor,
        setupTerminalSha256: setup?.phase_terminal_sha256 ?? null,
        phase: "paid",
      });
      const retained = await readJson<Lc4QualificationV4ShardTerminal>(terminalPath);
      let derivedStatus: "passed" | "failed" | "cancelled";
      let derivedFailureClass: string;
      if (retained.status === "cancelled") {
        if (!stopped || setup !== null || paid !== null) {
          throw new Error("qualification cancellation lacks a failed predecessor or contains provider evidence");
        }
        derivedStatus = "cancelled";
        derivedFailureClass = "predecessor_failed";
      } else {
        if (setup === null) throw new Error(`${entry.provider} completed shard lacks setup terminal`);
        if (setup.result.status === "failed") {
          if (paid !== null) throw new Error(`${entry.provider} ran paid qualification after failed setup`);
          derivedStatus = "failed";
          derivedFailureClass = setup.result.failure_class;
        } else {
          if (paid === null) throw new Error(`${entry.provider} completed shard lacks paid terminal`);
          derivedStatus = paid.result.status;
          derivedFailureClass = paid.result.failure_class;
        }
      }
      assertShardTerminal(retained, {
        reservation: entry,
        predecessor,
        setup,
        paid,
        status: derivedStatus,
        failureClass: derivedFailureClass,
      });
      if (stopped && retained.status !== "cancelled") {
        throw new Error("qualification contains a non-cancelled shard after a failed predecessor");
      }
      terminals.push(retained);
      predecessor = retained.terminal_sha256;
      stopped ||= retained.status !== "passed";
      continue;
    }
    if (stopped) {
      const cancelled = shardTerminal({
        reservation: entry,
        predecessor,
        setup: null,
        paid: null,
        status: "cancelled",
        failureClass: "predecessor_failed",
      });
      await writeImmutable(terminalPath, cancelled);
      terminals.push(cancelled);
      predecessor = cancelled.terminal_sha256;
      continue;
    }

    const setupWasRetained = await exists(resolve(shardPath, "setup-terminal.json"));
    const setup = await runPhase({
      shardPath,
      reservation: entry,
      predecessor,
      phase: "setup",
      setupTerminalSha256: null,
      execute: input.dependencies.runSetup,
    });
    let paid: Lc4QualificationV4PhaseTerminal | null = null;
    let status: "passed" | "failed" = setup.result.status;
    let failureClass = setup.result.failure_class;
    if (setup.result.status === "passed") {
      // This is the deliberately supported credit/restart boundary: setup is
      // immutable and paid has not yet been admitted.
      if (!setupWasRetained) {
        await input.dependencies.afterSetupTerminal?.(freeze({
          provider: entry.provider,
          model: entry.model,
          shard_id: entry.shard_id,
          reservation_id: entry.reservation_id,
          predecessor_shard_terminal_sha256: predecessor,
          setup_terminal_sha256: setup.phase_terminal_sha256,
          phase: "setup",
        }));
      }
      paid = await runPhase({
        shardPath,
        reservation: entry,
        predecessor,
        setupTerminalSha256: setup.phase_terminal_sha256,
        phase: "paid",
        execute: input.dependencies.runPaid,
      });
      status = paid.result.status;
      failureClass = paid.result.failure_class;
    }
    const terminal = shardTerminal({
      reservation: entry,
      predecessor,
      setup,
      paid,
      status,
      failureClass,
    });
    await writeImmutable(terminalPath, terminal);
    terminals.push(terminal);
    predecessor = terminal.terminal_sha256;
    stopped = terminal.status !== "passed";
  }

  const artifact = aggregate(retainedManifest, freeze(terminals));
  const aggregatePath = resolve(root, "qualification-v4-aggregate.json");
  await writeImmutable(aggregatePath, artifact);
  return artifact;
}

export async function inspectLc4QualificationV4ProviderShards(input: Readonly<{
  root: string;
  repository_root: string;
  binding: Lc4QualificationV4Binding;
}>): Promise<Readonly<{
  manifest_sha256: string;
  completed_providers: readonly LiveStsProvider[];
  next_provider: LiveStsProvider | null;
  quarantined_provider: LiveStsProvider | null;
  aggregate: Lc4QualificationV4Aggregate | null;
}>> {
  const root = await assertRoot(input.root, input.repository_root);
  const retainedManifest = await readJson<Lc4QualificationV4Manifest>(resolve(root, "qualification-v4-shard-manifest.json"));
  assertManifest(retainedManifest, input.binding);
  const completed: LiveStsProvider[] = [];
  let next: LiveStsProvider | null = null;
  let quarantined: LiveStsProvider | null = null;
  for (const entry of retainedManifest.reservations) {
    const shardPath = resolve(root, "qualification-v4-shards", `${entry.ordinal}-${entry.provider}`);
    if (await exists(resolve(shardPath, "setup-quarantine.json"))
      || await exists(resolve(shardPath, "paid-quarantine.json"))) quarantined ??= entry.provider;
    if (await exists(resolve(shardPath, "shard-terminal.json"))) completed.push(entry.provider);
    else next ??= entry.provider;
  }
  const aggregatePath = resolve(root, "qualification-v4-aggregate.json");
  return freeze({
    manifest_sha256: retainedManifest.manifest_sha256,
    completed_providers: freeze(completed),
    next_provider: next,
    quarantined_provider: quarantined,
    aggregate: await exists(aggregatePath) ? await readJson<Lc4QualificationV4Aggregate>(aggregatePath) : null,
  });
}

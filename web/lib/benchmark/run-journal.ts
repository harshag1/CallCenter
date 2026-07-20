import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Hex } from "./artifacts";

const JOURNAL_DOMAIN = "harshas-amazing-call-center/crash-durable-run-journal/v1\n";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_COLLECTION_ITEMS = 100_000;
const REDACTED = "[REDACTED]";

export type RunJournalEvent = Readonly<{
  schema_version: 1;
  run_id: string;
  sequence: number;
  recorded_at: string;
  event_type: string;
  payload: unknown;
  previous_event_sha256: string;
  event_sha256: string;
}>;

export type RunJournalOptions = Readonly<{
  outputRoot: string;
  planSha256: string;
  runId: string;
  canonicalPlan: string | Uint8Array;
  knownSecrets?: readonly string[];
  now?: () => Date;
}>;

export type RunJournalFinalization = Readonly<{
  status: string;
  manifestSha256: string;
  budgetHeadSha256: string;
}>;

export class RunJournalError extends Error {
  readonly code: "invalid_input" | "unsafe_path" | "already_exists" | "durability_failure" | "closed";

  constructor(code: RunJournalError["code"], message: string) {
    super(message);
    this.name = "RunJournalError";
    this.code = code;
  }
}

type JournalPaths = Readonly<{
  root: string;
  planRoot: string;
  partial: string;
  complete: string;
  journal: string;
  plan: string;
  head: string;
}>;

type RedactionContext = Readonly<{
  secrets: readonly string[];
  seen: WeakSet<object>;
}>;

function fail(code: RunJournalError["code"], message: string): never {
  throw new RunJournalError(code, message);
}

function requireId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) fail("invalid_input", `${label} must be a safe identifier`);
}

function requireHash(value: string, label: string): void {
  if (!HASH_PATTERN.test(value)) fail("invalid_input", `${label} must be a lowercase SHA-256 digest`);
}

function pathInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  if (/^(?:api_?key|secret|client_secret|token|access_token|refresh_token|password|credential|credentials|authorization|cookie|set_cookie)$/.test(normalized)) return true;
  if (/^(?:capability_grant|resume_handle|resumption_handle|mcp_auth|auth_headers?|headers)$/.test(normalized)) return true;
  return normalized.endsWith("_api_key") || normalized.endsWith("_secret") || normalized.endsWith("_password");
}

function scrubUrl(value: string): string {
  if (!/^(?:wss?|https?):\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveKey(key) || /(?:key|token|auth|signature|credential)/i.test(key)) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return url.toString();
  } catch {
    return REDACTED;
  }
}

function scrubString(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length >= 8) result = result.split(secret).join(REDACTED);
  }
  result = result
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b/gi, REDACTED)
    .replace(/\bAIza[A-Za-z0-9_-]{16,}\b/g, REDACTED);
  return scrubUrl(result);
}

function redactedValue(value: unknown, context: RedactionContext, depth = 0, key = ""): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED_DEPTH]";
  if (sensitiveKey(key)) return REDACTED;
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return Number.isFinite(value as number) || typeof value !== "number" ? value : String(value);
  }
  if (typeof value === "string") return scrubString(value, context.secrets);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[UNDEFINED]";
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (value instanceof Error) {
    return Object.freeze({
      name: scrubString(value.name, context.secrets),
      message: scrubString(value.message, context.secrets),
    });
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return Object.freeze({ binary: true, byte_length: bytes.byteLength, sha256: sha256Hex(bytes) });
  }
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);
    return Object.freeze({ binary: true, byte_length: bytes.byteLength, sha256: sha256Hex(bytes) });
  }
  if (typeof value !== "object") return scrubString(String(value), context.secrets);
  if (context.seen.has(value)) return "[CIRCULAR]";
  context.seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_COLLECTION_ITEMS).map((entry, index) => redactedValue(entry, context, depth + 1, String(index)));
    if (value.length > MAX_COLLECTION_ITEMS) result.push(`[TRUNCATED_${value.length - MAX_COLLECTION_ITEMS}_ITEMS]`);
    return Object.freeze(result);
  }
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  for (const [entryKey, entryValue] of entries.slice(0, MAX_COLLECTION_ITEMS)) {
    output[entryKey] = redactedValue(entryValue, context, depth + 1, entryKey);
  }
  if (entries.length > MAX_COLLECTION_ITEMS) output.__truncated_items = entries.length - MAX_COLLECTION_ITEMS;
  return Object.freeze(output);
}

export function redactRunJournalValue(value: unknown, knownSecrets: readonly string[] = []): unknown {
  const secrets = knownSecrets
    .filter((secret): secret is string => typeof secret === "string" && secret.length >= 8)
    .sort((left, right) => right.length - left.length);
  return redactedValue(value, Object.freeze({ secrets: Object.freeze(secrets), seen: new WeakSet() }));
}

function journalEventHash(event: Omit<RunJournalEvent, "event_sha256">): string {
  return sha256Hex(`${JOURNAL_DOMAIN}${canonicalJson(event)}`);
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateExclusive(path: string, contents: string | Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendPrivate(path: string, contents: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    // Codex/macOS workspace provenance snapshots may add one invisible APFS
    // link to newly written workspace files. Reject larger fan-out while still
    // preserving O_NOFOLLOW, private modes, exclusive creation, and hash-chain
    // verification. Ordinary Linux/CI files remain single-link only.
    const maximumExpectedLinks = process.platform === "darwin" ? 2 : 1;
    if (!info.isFile() || info.nlink < 1 || info.nlink > maximumExpectedLinks || (info.mode & 0o077) !== 0) {
      fail("unsafe_path", "run journal is no longer a private regular file");
    }
    let offset = 0;
    while (offset < contents.byteLength) {
      const result = await handle.write(contents, offset, contents.byteLength - offset, null);
      if (result.bytesWritten <= 0) fail("durability_failure", "run journal append made no progress");
      offset += result.bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeHead(path: string, event: RunJournalEvent): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writePrivateExclusive(temporary, `${canonicalJson({
    schema_version: 1,
    run_id: event.run_id,
    sequence: event.sequence,
    event_sha256: event.event_sha256,
  })}\n`);
  await rename(temporary, path);
  await fsyncDirectory(dirname(path));
}

async function preparePaths(options: RunJournalOptions): Promise<JournalPaths> {
  if (!isAbsolute(options.outputRoot)) fail("invalid_input", "run journal output root must be absolute");
  requireHash(options.planSha256, "planSha256");
  requireId(options.runId, "runId");
  await mkdir(options.outputRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const root = await realpath(options.outputRoot);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory() || (rootInfo.mode & 0o022) !== 0) {
    fail("unsafe_path", "run journal root must be a private non-group/world-writable directory");
  }
  const planRoot = resolve(root, options.planSha256);
  const partial = resolve(planRoot, `${options.runId}.partial`);
  const complete = resolve(planRoot, `${options.runId}.complete`);
  if (!pathInside(root, planRoot) || !pathInside(planRoot, partial) || basename(partial) !== `${options.runId}.partial`) {
    fail("unsafe_path", "run journal path escapes its output root");
  }
  return Object.freeze({
    root,
    planRoot,
    partial,
    complete,
    journal: join(partial, "journal.jsonl"),
    plan: join(partial, "plan.json"),
    head: join(partial, "journal-head.json"),
  });
}

export class CrashDurableRunJournal {
  readonly paths: JournalPaths;
  readonly #runId: string;
  readonly #knownSecrets: readonly string[];
  readonly #now: () => Date;
  #sequence = 0;
  #head = "0".repeat(64);
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  private constructor(paths: JournalPaths, options: RunJournalOptions) {
    this.paths = paths;
    this.#runId = options.runId;
    this.#knownSecrets = Object.freeze([...(options.knownSecrets ?? [])]);
    this.#now = options.now ?? (() => new Date());
  }

  static async create(options: RunJournalOptions): Promise<CrashDurableRunJournal> {
    const paths = await preparePaths(options);
    await mkdir(paths.planRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    try {
      await mkdir(paths.partial, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        fail("already_exists", "run partial already exists; explicit resume or a new run ID is required");
      }
      throw error;
    }
    const planBytes = typeof options.canonicalPlan === "string"
      ? Buffer.from(options.canonicalPlan, "utf8")
      : Buffer.from(options.canonicalPlan);
    const planText = planBytes.toString("utf8");
    if (options.knownSecrets?.some((secret) => secret.length >= 8 && planText.includes(secret))) {
      fail("invalid_input", "canonical plan contains credential material");
    }
    await writePrivateExclusive(paths.plan, planBytes);
    await writePrivateExclusive(paths.journal, new Uint8Array());
    await fsyncDirectory(paths.partial);
    const journal = new CrashDurableRunJournal(paths, options);
    await journal.append("run.partial_opened", {
      plan_sha256: options.planSha256,
      plan_file_sha256: sha256Hex(planBytes),
      durability: "fsync_each_record",
    });
    return journal;
  }

  append(eventType: string, payload: unknown): Promise<void> {
    requireId(eventType, "eventType");
    if (this.#closed) return Promise.reject(new RunJournalError("closed", "run journal is closed"));
    const operation = async () => {
      const eventWithoutHash: Omit<RunJournalEvent, "event_sha256"> = Object.freeze({
        schema_version: 1,
        run_id: this.#runId,
        sequence: this.#sequence + 1,
        recorded_at: this.#now().toISOString(),
        event_type: eventType,
        payload: redactRunJournalValue(payload, this.#knownSecrets),
        previous_event_sha256: this.#head,
      });
      const event: RunJournalEvent = Object.freeze({
        ...eventWithoutHash,
        event_sha256: journalEventHash(eventWithoutHash),
      });
      const line = Buffer.from(`${canonicalJson(event)}\n`, "utf8");
      if (line.byteLength > MAX_RECORD_BYTES) fail("invalid_input", "run journal record exceeds 8 MiB after redaction");
      await appendPrivate(this.paths.journal, line);
      await writeHead(this.paths.head, event);
      this.#sequence = event.sequence;
      this.#head = event.event_sha256;
    };
    const next = this.#tail.then(operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async writeBlob(relativePath: string, bytes: Uint8Array): Promise<Readonly<{ path: string; byte_length: number; sha256: string }>> {
    if (this.#closed) fail("closed", "run journal is closed");
    if (!/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._/@+-]+$/.test(relativePath)) {
      fail("unsafe_path", "run journal blob path must be a safe relative path");
    }
    const destination = resolve(this.paths.partial, ...relativePath.split("/"));
    if (!pathInside(this.paths.partial, destination)) fail("unsafe_path", "run journal blob escapes the partial directory");
    await mkdir(dirname(destination), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await writePrivateExclusive(destination, bytes);
    const descriptor = Object.freeze({ path: relativePath, byte_length: bytes.byteLength, sha256: sha256Hex(bytes) });
    await this.append("artifact.blob_persisted", descriptor);
    return descriptor;
  }

  async finalize(input: RunJournalFinalization): Promise<string> {
    requireId(input.status, "status");
    requireHash(input.manifestSha256, "manifestSha256");
    requireHash(input.budgetHeadSha256, "budgetHeadSha256");
    await this.append("run.durably_finalized", {
      status: input.status,
      manifest_sha256: input.manifestSha256,
      budget_head_sha256: input.budgetHeadSha256,
    });
    await this.#tail;
    const finalMarker = `${canonicalJson({
      schema_version: 1,
      run_id: this.#runId,
      status: input.status,
      sequence: this.#sequence,
      journal_head_sha256: this.#head,
      manifest_sha256: input.manifestSha256,
      budget_head_sha256: input.budgetHeadSha256,
    })}\n`;
    await writePrivateExclusive(join(this.paths.partial, "FINALIZED.json"), finalMarker);
    await fsyncDirectory(this.paths.partial);
    await rename(this.paths.partial, this.paths.complete);
    await fsyncDirectory(this.paths.planRoot);
    this.#closed = true;
    return this.paths.complete;
  }

  async preservePartial(reasonCode: string, detail: unknown = null): Promise<void> {
    requireId(reasonCode, "reasonCode");
    if (this.#closed) return;
    await this.append("run.partial_preserved", { reason_code: reasonCode, detail });
    await this.#tail;
  }
}

export async function verifyRunJournal(path: string): Promise<Readonly<{
  valid: boolean;
  event_count: number;
  head_sha256: string;
  errors: readonly string[];
}>> {
  const errors: string[] = [];
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    return Object.freeze({ valid: false, event_count: 0, head_sha256: "0".repeat(64), errors: Object.freeze(["journal is unreadable"]) });
  }
  if (!text.endsWith("\n")) errors.push("journal has an unterminated tail");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : [];
  let prior = "0".repeat(64);
  for (const [index, line] of lines.entries()) {
    try {
      const event = JSON.parse(line) as RunJournalEvent;
      const { event_sha256: hash, ...body } = event;
      if (event.sequence !== index + 1) errors.push(`sequence mismatch at line ${index + 1}`);
      if (event.previous_event_sha256 !== prior) errors.push(`chain mismatch at line ${index + 1}`);
      if (journalEventHash(body) !== hash) errors.push(`hash mismatch at line ${index + 1}`);
      prior = hash;
    } catch {
      errors.push(`invalid JSON at line ${index + 1}`);
    }
  }
  return Object.freeze({
    valid: errors.length === 0 && lines.length > 0,
    event_count: lines.length,
    head_sha256: prior,
    errors: Object.freeze(errors),
  });
}

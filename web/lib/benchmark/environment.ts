import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as nodeUtil from "node:util";

export const REDACTED_BENCHMARK_SECRET = "[REDACTED]";

export type BenchmarkSecretDescription = Readonly<{
  name: string;
  present: boolean;
  source: string | null;
  value: typeof REDACTED_BENCHMARK_SECRET | null;
}>;

export type BenchmarkEnvironmentDescription = Readonly<{
  secrets: readonly BenchmarkSecretDescription[];
}>;

export type BenchmarkEnvFileReader = (path: string) => Promise<string>;

export type ResolveBenchmarkEnvironmentOptions = Readonly<{
  /** Only these names are retained. Other variables in an env file are discarded. */
  names: readonly string[];
  /** Deliberate CLI/config selections. Earlier files win. */
  explicitEnvFiles?: readonly string[];
  /** Defaults to a read-only view of process.env. It is never mutated. */
  environment?: Readonly<Record<string, string | undefined>>;
  /** X_Project root. Inferred from this module's source location when omitted. */
  repositoryRoot?: string;
  /** X_Project/web root. Inferred from repositoryRoot when omitted. */
  webRoot?: string;
  /** Explicitly authorized gpu-hub project root. Omitted/null disables that lookup. */
  gpuHubRoot?: string | null;
  cwd?: string;
  readTextFile?: BenchmarkEnvFileReader;
}>;

type SecretEntry = Readonly<{
  value: string;
  source: string;
}>;

type FileSource = Readonly<{
  label: string;
  path: string;
  required: boolean;
}>;

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODULE_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type EnvironmentParser = (contents: string) => NodeJS.Dict<string>;

function compatibilityParseEnv(contents: string): NodeJS.Dict<string> {
  const parsed: NodeJS.Dict<string> = Object.create(null);
  let index = 0;
  const skipHorizontalWhitespace = (): void => {
    while (contents[index] === " " || contents[index] === "\t") index += 1;
  };
  const skipComment = (): void => {
    while (index < contents.length && contents[index] !== "\n") index += 1;
  };

  while (index < contents.length) {
    while (/\s/.test(contents[index] ?? "")) index += 1;
    if (index >= contents.length) break;
    if (contents[index] === "#") {
      skipComment();
      continue;
    }
    if (contents.startsWith("export", index) && /[ \t]/.test(contents[index + 6] ?? "")) {
      index += 6;
      skipHorizontalWhitespace();
    }
    const keyMatch = contents.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!keyMatch) throw new Error("invalid environment variable name");
    const key = keyMatch[0];
    index += key.length;
    skipHorizontalWhitespace();
    if (contents[index] !== "=") throw new Error("missing environment assignment");
    index += 1;
    skipHorizontalWhitespace();

    let value = "";
    const quote = contents[index] === "'" || contents[index] === "\"" ? contents[index] : null;
    if (quote) {
      index += 1;
      let closed = false;
      while (index < contents.length) {
        const character = contents[index];
        if (character === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (quote === "\"" && character === "\\" && index + 1 < contents.length) {
          const escaped = contents[index + 1];
          const replacements: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            "\\": "\\",
            "\"": "\"",
          };
          value += Object.hasOwn(replacements, escaped) ? replacements[escaped] : `\\${escaped}`;
          index += 2;
          continue;
        }
        value += character;
        index += 1;
      }
      if (!closed) throw new Error("unterminated quoted environment value");
      skipHorizontalWhitespace();
      if (contents[index] === "#") skipComment();
      else if (index < contents.length && contents[index] !== "\r" && contents[index] !== "\n") {
        throw new Error("unexpected content after quoted environment value");
      }
    } else {
      const start = index;
      while (index < contents.length && contents[index] !== "\r" && contents[index] !== "\n") index += 1;
      const raw = contents.slice(start, index);
      const commentIndex = raw.indexOf("#");
      value = (commentIndex >= 0 ? raw.slice(0, commentIndex) : raw).trim();
    }
    parsed[key] = value;
  }
  return parsed;
}

/** Uses Node's native parser when available, with a strict Node 20.9 fallback. */
export function parseBenchmarkEnvironmentFile(
  contents: string,
  nativeParser: EnvironmentParser | null | undefined = nodeUtil.parseEnv
): NodeJS.Dict<string> {
  if (contents.includes("\0")) throw new Error("NUL byte");
  const withoutBom = contents.replace(/^\uFEFF/, "");
  return nativeParser ? nativeParser(withoutBom) : compatibilityParseEnv(withoutBom);
}

function validateNames(names: readonly string[]): readonly string[] {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid benchmark environment variable name: ${JSON.stringify(name)}`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      unique.push(name);
    }
  }

  if (unique.length === 0) {
    throw new Error("At least one benchmark environment variable name is required");
  }
  return Object.freeze(unique);
}

function inferRoots(options: ResolveBenchmarkEnvironmentOptions): Readonly<{
  repositoryRoot: string;
  webRoot: string;
  gpuHubRoot: string | null;
}> {
  const repositoryRoot = resolve(options.repositoryRoot ?? MODULE_REPOSITORY_ROOT);
  const webRoot = resolve(options.webRoot ?? join(repositoryRoot, "web"));
  const gpuHubRoot = options.gpuHubRoot ? resolve(options.gpuHubRoot) : null;
  return Object.freeze({ repositoryRoot, webRoot, gpuHubRoot });
}

function addFileSource(
  sources: FileSource[],
  seenPaths: Set<string>,
  label: string,
  path: string,
  required: boolean
): void {
  const normalized = resolve(path);
  if (seenPaths.has(normalized)) return;
  seenPaths.add(normalized);
  sources.push(Object.freeze({ label, path: normalized, required }));
}

function fileSources(options: ResolveBenchmarkEnvironmentOptions): readonly FileSource[] {
  const roots = inferRoots(options);
  const explicitBase = resolve(options.cwd ?? process.cwd());
  const sources: FileSource[] = [];
  const seenPaths = new Set<string>();

  for (const [index, path] of (options.explicitEnvFiles ?? []).entries()) {
    addFileSource(
      sources,
      seenPaths,
      `explicit-env:${index + 1}`,
      isAbsolute(path) ? path : resolve(explicitBase, path),
      true
    );
  }

  // Keep this order explicit and stable. Resolution is first-value-wins.
  addFileSource(sources, seenPaths, "workspace:.env", join(roots.repositoryRoot, ".env"), false);
  addFileSource(sources, seenPaths, "workspace-web:.env.local", join(roots.webRoot, ".env.local"), false);

  if (roots.gpuHubRoot) {
    addFileSource(sources, seenPaths, "gpu-hub-web:.env.local", join(roots.gpuHubRoot, "web", ".env.local"), false);
  }

  return Object.freeze(sources);
}

function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readSource(
  source: FileSource,
  reader: BenchmarkEnvFileReader
): Promise<NodeJS.Dict<string> | null> {
  let contents: string;
  try {
    contents = await reader(source.path);
  } catch (error) {
    if (!source.required && isMissingFileError(error)) return null;
    // Deliberately omit both the filesystem path and the underlying error: either
    // can contain secret-bearing filenames or parser excerpts in CI output.
    throw new Error(`Unable to read benchmark environment source ${source.label}`);
  }

  try {
    return parseBenchmarkEnvironmentFile(contents);
  } catch {
    throw new Error(`Unable to parse benchmark environment source ${source.label}`);
  }
}

function captureValue(
  entries: Map<string, SecretEntry>,
  sourceValues: Readonly<Record<string, string | undefined>> | NodeJS.Dict<string>,
  name: string,
  source: string
): void {
  if (entries.has(name)) return;
  if (!Object.hasOwn(sourceValues, name)) return;
  const value = sourceValues[name];
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid benchmark environment variable ${name} in source ${source}`);
  }
  entries.set(name, Object.freeze({ value, source }));
}

/**
 * A deliberately non-enumerable secret store. `get` is the only value-bearing
 * operation; JSON and util.inspect expose redaction markers and source labels.
 */
export class ResolvedBenchmarkEnvironment {
  readonly #names: readonly string[];
  readonly #entries: ReadonlyMap<string, SecretEntry>;

  constructor(names: readonly string[], entries: ReadonlyMap<string, SecretEntry>) {
    this.#names = Object.freeze([...names]);
    this.#entries = new Map(entries);
    Object.freeze(this);
  }

  get(name: string): string | undefined {
    return this.#entries.get(name)?.value;
  }

  require(name: string): string {
    const value = this.get(name);
    if (value === undefined) {
      throw new Error(`Missing required benchmark environment variable ${name}`);
    }
    return value;
  }

  source(name: string): string | null {
    return this.#entries.get(name)?.source ?? null;
  }

  describe(): BenchmarkEnvironmentDescription {
    const secrets = this.#names.map((name) => {
      const entry = this.#entries.get(name);
      return Object.freeze({
        name,
        present: Boolean(entry),
        source: entry?.source ?? null,
        value: entry ? REDACTED_BENCHMARK_SECRET : null,
      });
    });
    return Object.freeze({ secrets: Object.freeze(secrets) });
  }

  toJSON(): BenchmarkEnvironmentDescription {
    return this.describe();
  }

  [nodeUtil.inspect.custom](): BenchmarkEnvironmentDescription {
    return this.describe();
  }
}

/**
 * Resolve provider credentials without calling loadEnvFile, @next/env, or
 * assigning to process.env. Precedence is explicit files, the supplied process
 * environment, workspace root, workspace web, then an explicitly authorized
 * GPU Hub root when supplied.
 */
export async function resolveBenchmarkEnvironment(
  options: ResolveBenchmarkEnvironmentOptions
): Promise<ResolvedBenchmarkEnvironment> {
  const names = validateNames(options.names);
  const desired = new Set(names);
  const entries = new Map<string, SecretEntry>();
  const reader = options.readTextFile ?? (async (path) => readFile(path, "utf8"));
  const sources = fileSources(options);
  const liveEnvironment = options.environment ?? process.env;
  const environmentSnapshot: Record<string, string | undefined> = Object.create(null);
  for (const name of names) {
    if (Object.hasOwn(liveEnvironment, name)) environmentSnapshot[name] = liveEnvironment[name];
  }

  for (const source of sources.filter((candidate) => candidate.required)) {
    const parsed = await readSource(source, reader);
    if (!parsed) continue;
    for (const name of names) {
      captureValue(entries, parsed, name, source.label);
    }
  }

  if (entries.size < desired.size) {
    for (const name of names) {
      captureValue(entries, environmentSnapshot, name, "process-env");
    }
  }

  if (entries.size < desired.size) {
    for (const source of sources.filter((candidate) => !candidate.required)) {
      const parsed = await readSource(source, reader);
      if (!parsed) continue;
      for (const name of names) {
        captureValue(entries, parsed, name, source.label);
      }
      if (entries.size === desired.size) break;
    }
  }

  return new ResolvedBenchmarkEnvironment(names, entries);
}

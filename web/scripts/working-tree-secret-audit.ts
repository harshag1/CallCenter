#!/usr/bin/env npx tsx

// Public-release working-tree gate. It scans every tracked file plus every
// non-ignored untracked file, including dirty files. Reports contain paths,
// digests, and finding classes only; matched bytes and source lines never leave
// this process.

import { spawnSync } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_RELEASE_SECRET_PATTERNS,
  PUBLIC_RELEASE_SENSITIVE_PATH_CLASSES,
  isBinarySecretContent,
  safeReportedPath,
  secretSearchViews,
  secretPatternClasses,
  sensitivePathClasses,
  type PublicReleaseAllowlistableClass,
} from "../lib/public-release-secret-rules";

const DEFAULT_ALLOWLIST_PATH = ".security/public-secret-audit-allowlist.json";
const MAX_ALLOWLIST_BYTES = 64 * 1024;
const SAMPLE_BYTES = 8 * 1024;
const WORKTREE_ROUTING_GIT_ENVIRONMENT = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const);

export const DEFAULT_WORKTREE_AUDIT_LIMITS = Object.freeze({
  maxPublishableFiles: 20_000,
  maxTextFileBytes: 4 * 1024 * 1024,
  maxBinaryFileBytes: 1024 * 1024,
  maxTotalScannedBytes: 128 * 1024 * 1024,
});

type WorktreeAuditLimits = typeof DEFAULT_WORKTREE_AUDIT_LIMITS;
type FileSource = "tracked" | "untracked";

export type WorktreeOperationalFindingClass =
  | "binary_file_too_large"
  | "file_changed_during_scan"
  | "publishable_file_limit_exceeded"
  | "symlink_not_publishable"
  | "text_file_too_large"
  | "total_scan_limit_exceeded"
  | "unreadable_file"
  | "unsupported_file_type";

export type WorktreeAuditFinding = Readonly<{
  path: string;
  source: FileSource;
  finding_class: PublicReleaseAllowlistableClass | WorktreeOperationalFindingClass;
}>;

export type WorktreeAllowedFinding = WorktreeAuditFinding & Readonly<{
  allowlist_id: string;
}>;

export type WorktreeSecretAudit = Readonly<{
  schema_version: 1;
  kind: "hacc_public_worktree_secret_audit";
  inventory_contract: "tracked_plus_nonignored_untracked";
  ignored_files_scanned: false;
  head_commit: string;
  head_tree: string;
  git_status_sha256: string;
  complete: boolean;
  pass: boolean;
  tracked_file_count: number;
  untracked_file_count: number;
  deleted_tracked_file_count: number;
  publishable_file_count: number;
  text_file_count: number;
  binary_file_count: number;
  scanned_byte_count: number;
  secret_pattern_count: number;
  sensitive_path_rule_count: number;
  publishable_file_manifest_sha256: string;
  allowlist: Readonly<{
    path: string;
    sha256: string;
    entry_count: number;
    applied_entry_count: number;
    unused_entry_ids: readonly string[];
  }>;
  /** Unresolved findings; release automation must require this to be zero. */
  finding_count: number;
  unresolved_finding_count: number;
  unresolved_findings: readonly WorktreeAuditFinding[];
  allowed_finding_count: number;
  allowed_findings: readonly WorktreeAllowedFinding[];
}>;

type AllowlistEntry = Readonly<{
  id: string;
  path: string;
  sha256: string;
  pattern_classes: readonly PublicReleaseAllowlistableClass[];
  reason: string;
}>;

type LoadedAllowlist = Readonly<{
  path: string;
  sha256: string;
  entries: readonly AllowlistEntry[];
}>;

type InternalFinding = Readonly<{
  rawPath: string;
  path: string;
  source: FileSource;
  findingClass: PublicReleaseAllowlistableClass | WorktreeOperationalFindingClass;
  fileSha256: string | null;
}>;

type FileReadResult = Readonly<{
  bytes: Buffer | null;
  binary: boolean;
  size: number;
  operationalClass: WorktreeOperationalFindingClass | null;
}>;

function git(cwd: string, args: readonly string[]): Buffer {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of WORKTREE_ROUTING_GIT_ENVIRONMENT) delete environment[name];
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  const result = spawnSync("git", args, {
    cwd,
    env: environment,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    // Git errors and hooks are not trusted to avoid echoing credential values.
    throw new Error("working-tree secret audit Git inventory failed");
  }
  return result.stdout ?? Buffer.alloc(0);
}

function parseNulPaths(value: Buffer): string[] {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error("working-tree secret audit found a non-UTF-8 Git path");
  }
  return decoded.split("\0").filter(Boolean);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function safeRepoPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) return false;
  if (isAbsolute(value) || value.includes("\0") || value.includes("\\")) return false;
  const normalized = value.split("/");
  return normalized.every((part) => part.length > 0 && part !== "." && part !== "..")
    && safeReportedPath(value) === value;
}

function loadAllowlist(repoRoot: string, relativePath: string): LoadedAllowlist {
  if (!safeRepoPath(relativePath)) throw new Error("working-tree secret audit allowlist path is invalid");
  const absolutePath = resolve(repoRoot, relativePath);
  let raw: Buffer;
  try {
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ALLOWLIST_BYTES) {
      throw new Error("invalid");
    }
    raw = readFileSync(absolutePath);
  } catch {
    throw new Error("working-tree secret audit allowlist is missing or unreadable");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new Error("working-tree secret audit allowlist is malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("working-tree secret audit allowlist is malformed");
  }
  const root = parsed as Record<string, unknown>;
  if (!exactObjectKeys(root, ["entries", "schema_version"]) || root.schema_version !== 1 || !Array.isArray(root.entries)) {
    throw new Error("working-tree secret audit allowlist is malformed");
  }
  if (root.entries.length > 100) throw new Error("working-tree secret audit allowlist is too broad");

  const validClasses = new Set<string>([
    ...PUBLIC_RELEASE_SECRET_PATTERNS.map((rule) => rule.patternClass),
    ...PUBLIC_RELEASE_SENSITIVE_PATH_CLASSES,
  ]);
  const entries: AllowlistEntry[] = [];
  const ids = new Set<string>();
  const grants = new Set<string>();
  for (const candidate of root.entries) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("working-tree secret audit allowlist is malformed");
    }
    const entry = candidate as Record<string, unknown>;
    if (!exactObjectKeys(entry, ["id", "path", "pattern_classes", "reason", "sha256"])) {
      throw new Error("working-tree secret audit allowlist is malformed");
    }
    if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(entry.id) || ids.has(entry.id)) {
      throw new Error("working-tree secret audit allowlist has an invalid id");
    }
    if (!safeRepoPath(entry.path) || entry.path === relativePath) {
      throw new Error("working-tree secret audit allowlist has an invalid path");
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error("working-tree secret audit allowlist has an invalid digest");
    }
    if (
      typeof entry.reason !== "string"
      || entry.reason.length < 20
      || entry.reason.length > 240
      || /[\r\n]/.test(entry.reason)
    ) {
      throw new Error("working-tree secret audit allowlist has invalid evidence");
    }
    if (
      !Array.isArray(entry.pattern_classes)
      || entry.pattern_classes.length < 1
      || entry.pattern_classes.length > validClasses.size
      || entry.pattern_classes.some((value) => typeof value !== "string" || !validClasses.has(value))
    ) {
      throw new Error("working-tree secret audit allowlist has invalid pattern classes");
    }
    const patternClasses = [...new Set(entry.pattern_classes as PublicReleaseAllowlistableClass[])].sort();
    if (patternClasses.length !== entry.pattern_classes.length) {
      throw new Error("working-tree secret audit allowlist has duplicate pattern classes");
    }
    for (const patternClass of patternClasses) {
      const grant = `${entry.path}\0${entry.sha256}\0${patternClass}`;
      if (grants.has(grant)) throw new Error("working-tree secret audit allowlist has duplicate grants");
      grants.add(grant);
    }
    ids.add(entry.id);
    entries.push(Object.freeze({
      id: entry.id,
      path: entry.path,
      sha256: entry.sha256,
      pattern_classes: Object.freeze(patternClasses),
      reason: entry.reason,
    }));
  }

  const ordered = [...entries].sort((left, right) => left.id.localeCompare(right.id));
  if (ordered.some((entry, index) => entry.id !== entries[index]?.id)) {
    throw new Error("working-tree secret audit allowlist entries must be ordered by id");
  }
  return Object.freeze({
    path: relativePath,
    sha256: sha256(raw),
    entries: Object.freeze(ordered),
  });
}

function normalizeLimits(input?: Partial<WorktreeAuditLimits>): WorktreeAuditLimits {
  const limits = { ...DEFAULT_WORKTREE_AUDIT_LIMITS, ...input };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("working-tree secret audit limit is invalid");
    }
  }
  if (limits.maxBinaryFileBytes > limits.maxTextFileBytes) {
    throw new Error("working-tree secret audit binary limit is invalid");
  }
  return Object.freeze(limits);
}

function readBoundedRegularFile(
  absolutePath: string,
  limits: WorktreeAuditLimits,
  remainingBytes: number
): FileReadResult {
  let initial;
  try {
    initial = lstatSync(absolutePath);
  } catch {
    return { bytes: null, binary: false, size: 0, operationalClass: "unreadable_file" };
  }
  if (initial.isSymbolicLink()) {
    return { bytes: null, binary: false, size: initial.size, operationalClass: "symlink_not_publishable" };
  }
  if (!initial.isFile()) {
    return { bytes: null, binary: false, size: initial.size, operationalClass: "unsupported_file_type" };
  }

  let descriptor: number | null = null;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(absolutePath, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino) {
      return { bytes: null, binary: false, size: initial.size, operationalClass: "file_changed_during_scan" };
    }
    const sample = Buffer.alloc(Math.min(SAMPLE_BYTES, opened.size));
    if (sample.length > 0) readSync(descriptor, sample, 0, sample.length, 0);
    const sampleLooksBinary = isBinarySecretContent(sample);
    const perFileLimit = sampleLooksBinary ? limits.maxBinaryFileBytes : limits.maxTextFileBytes;
    if (opened.size > perFileLimit) {
      return {
        bytes: null,
        binary: sampleLooksBinary,
        size: opened.size,
        operationalClass: sampleLooksBinary ? "binary_file_too_large" : "text_file_too_large",
      };
    }
    if (opened.size > remainingBytes) {
      return {
        bytes: null,
        binary: sampleLooksBinary,
        size: opened.size,
        operationalClass: "total_scan_limit_exceeded",
      };
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      bytes.length !== opened.size
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      return {
        bytes: null,
        binary: sampleLooksBinary,
        size: opened.size,
        operationalClass: "file_changed_during_scan",
      };
    }
    const binary = isBinarySecretContent(bytes);
    // A late NUL, invalid UTF-8 byte, or UTF-16 payload can appear after the
    // bounded prefix. Reclassify the complete bounded file and enforce the
    // stricter binary cap before any content scan.
    if (binary && bytes.length > limits.maxBinaryFileBytes) {
      return { bytes: null, binary: true, size: opened.size, operationalClass: "binary_file_too_large" };
    }
    return { bytes, binary, size: opened.size, operationalClass: null };
  } catch {
    return { bytes: null, binary: false, size: initial.size, operationalClass: "unreadable_file" };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function internalFinding(
  rawPath: string,
  source: FileSource,
  findingClass: InternalFinding["findingClass"],
  fileSha256: string | null
): InternalFinding {
  const pathClasses = sensitivePathClasses(rawPath);
  const privacySensitivePath = pathClasses.includes("recording_or_transcript_data")
    || pathClasses.includes("customer_or_runtime_data");
  return Object.freeze({
    rawPath,
    path: safeReportedPath(rawPath, privacySensitivePath),
    source,
    findingClass,
    fileSha256,
  });
}

function publicFinding(value: InternalFinding): WorktreeAuditFinding {
  return Object.freeze({
    path: value.path,
    source: value.source,
    finding_class: value.findingClass,
  });
}

export function auditPublishableWorkingTree(
  repoRoot: string,
  options: Readonly<{
    allowlistPath?: string;
    limits?: Partial<WorktreeAuditLimits>;
  }> = {}
): WorktreeSecretAudit {
  const root = resolve(repoRoot);
  const topLevelOutput = git(root, ["rev-parse", "--show-toplevel"]);
  if (
    topLevelOutput.length < 2
    || topLevelOutput[topLevelOutput.length - 1] !== 10
    || /[\0\r\n]/.test(topLevelOutput.subarray(0, topLevelOutput.length - 1).toString("utf8"))
  ) {
    throw new Error("working-tree secret audit received malformed Git root metadata");
  }
  const topLevel = topLevelOutput.subarray(0, topLevelOutput.length - 1).toString("utf8");
  if (realpathSync(topLevel) !== realpathSync(root)) {
    throw new Error("working-tree secret audit Git root does not match requested repository");
  }
  const allowlist = loadAllowlist(root, options.allowlistPath ?? DEFAULT_ALLOWLIST_PATH);
  const limits = normalizeLimits(options.limits);
  const headCommit = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).toString("ascii").trim();
  const headTree = git(root, ["rev-parse", "--verify", "HEAD^{tree}"]).toString("ascii").trim();
  if (!/^[0-9a-f]{40,64}$/.test(headCommit) || !/^[0-9a-f]{40,64}$/.test(headTree)) {
    throw new Error("working-tree secret audit could not bind Git provenance");
  }
  const gitStatusSha256 = sha256(git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=no",
  ]));
  const trackedPaths = parseNulPaths(git(root, ["ls-files", "--cached", "-z"]));
  const untrackedPaths = parseNulPaths(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  const trackedSet = new Set(trackedPaths);
  const inventory = [...new Set([...trackedPaths, ...untrackedPaths])].sort();

  const findings: InternalFinding[] = [];
  const manifest = createHash("sha256");
  let deletedTrackedFileCount = 0;
  let publishableFileCount = 0;
  let textFileCount = 0;
  let binaryFileCount = 0;
  let scannedByteCount = 0;

  if (inventory.length > limits.maxPublishableFiles) {
    findings.push(internalFinding(
      "[INVENTORY]",
      "tracked",
      "publishable_file_limit_exceeded",
      null
    ));
  } else {
    for (const path of inventory) {
      const source: FileSource = trackedSet.has(path) ? "tracked" : "untracked";
      const absolutePath = resolve(root, path);
      if (relative(root, absolutePath).startsWith("..") || absolutePath === root) {
        findings.push(internalFinding(path, source, "unsupported_file_type", null));
        continue;
      }
      try {
        lstatSync(absolutePath);
      } catch (error) {
        if (
          source === "tracked"
          && error && typeof error === "object" && "code" in error && error.code === "ENOENT"
        ) {
          deletedTrackedFileCount += 1;
          continue;
        }
      }

      publishableFileCount += 1;
      const read = readBoundedRegularFile(
        absolutePath,
        limits,
        Math.max(0, limits.maxTotalScannedBytes - scannedByteCount)
      );
      if (read.operationalClass || !read.bytes) {
        const findingClass = read.operationalClass ?? "unreadable_file";
        manifest.update(JSON.stringify([path, source, read.size, `UNSCANNED:${findingClass}`]));
        manifest.update("\n");
        findings.push(internalFinding(path, source, findingClass, null));
        for (const pathClass of sensitivePathClasses(path)) {
          findings.push(internalFinding(path, source, pathClass, null));
        }
        for (const patternClass of secretPatternClasses(path)) {
          findings.push(internalFinding(path, source, patternClass, null));
        }
        continue;
      }

      scannedByteCount += read.bytes.length;
      if (read.binary) binaryFileCount += 1;
      else textFileCount += 1;
      const fileSha256 = sha256(read.bytes);
      manifest.update(JSON.stringify([path, source, read.size, fileSha256]));
      manifest.update("\n");
      for (const pathClass of sensitivePathClasses(path)) {
        findings.push(internalFinding(path, source, pathClass, fileSha256));
      }
      for (const patternClass of secretPatternClasses(path)) {
        findings.push(internalFinding(path, source, patternClass, fileSha256));
      }
      const contentClasses = new Set<PublicReleaseAllowlistableClass>();
      for (const view of secretSearchViews(read.bytes, read.binary)) {
        for (const patternClass of secretPatternClasses(view)) contentClasses.add(patternClass);
      }
      for (const patternClass of [...contentClasses].sort()) {
        findings.push(internalFinding(path, source, patternClass, fileSha256));
      }
    }
  }

  const grantMap = new Map<string, AllowlistEntry>();
  for (const entry of allowlist.entries) {
    for (const patternClass of entry.pattern_classes) {
      grantMap.set(`${entry.path}\0${entry.sha256}\0${patternClass}`, entry);
    }
  }
  const appliedIds = new Set<string>();
  const unresolved: WorktreeAuditFinding[] = [];
  const allowed: WorktreeAllowedFinding[] = [];
  for (const finding of findings) {
    const grant = finding.fileSha256
      ? grantMap.get(`${finding.rawPath}\0${finding.fileSha256}\0${finding.findingClass}`)
      : undefined;
    if (grant) {
      appliedIds.add(grant.id);
      allowed.push(Object.freeze({ ...publicFinding(finding), allowlist_id: grant.id }));
    } else {
      unresolved.push(publicFinding(finding));
    }
  }
  const orderFindings = <T extends WorktreeAuditFinding>(values: T[]): T[] => values.sort((left, right) =>
    left.path.localeCompare(right.path)
      || left.finding_class.localeCompare(right.finding_class)
      || left.source.localeCompare(right.source)
  );
  orderFindings(unresolved);
  orderFindings(allowed);
  const unusedEntryIds = allowlist.entries
    .map((entry) => entry.id)
    .filter((id) => !appliedIds.has(id));
  const complete = unresolved.every((finding) => ![
    "binary_file_too_large",
    "file_changed_during_scan",
    "publishable_file_limit_exceeded",
    "symlink_not_publishable",
    "text_file_too_large",
    "total_scan_limit_exceeded",
    "unreadable_file",
    "unsupported_file_type",
  ].includes(finding.finding_class));

  return Object.freeze({
    schema_version: 1 as const,
    kind: "hacc_public_worktree_secret_audit" as const,
    inventory_contract: "tracked_plus_nonignored_untracked" as const,
    ignored_files_scanned: false as const,
    head_commit: headCommit,
    head_tree: headTree,
    git_status_sha256: gitStatusSha256,
    complete,
    pass: complete && unresolved.length === 0 && unusedEntryIds.length === 0,
    tracked_file_count: trackedPaths.length,
    untracked_file_count: untrackedPaths.length,
    deleted_tracked_file_count: deletedTrackedFileCount,
    publishable_file_count: publishableFileCount,
    text_file_count: textFileCount,
    binary_file_count: binaryFileCount,
    scanned_byte_count: scannedByteCount,
    secret_pattern_count: PUBLIC_RELEASE_SECRET_PATTERNS.length,
    sensitive_path_rule_count: PUBLIC_RELEASE_SENSITIVE_PATH_CLASSES.length,
    publishable_file_manifest_sha256: manifest.digest("hex"),
    allowlist: Object.freeze({
      path: allowlist.path,
      sha256: allowlist.sha256,
      entry_count: allowlist.entries.length,
      applied_entry_count: appliedIds.size,
      unused_entry_ids: Object.freeze(unusedEntryIds),
    }),
    finding_count: unresolved.length,
    unresolved_finding_count: unresolved.length,
    unresolved_findings: Object.freeze(unresolved),
    allowed_finding_count: allowed.length,
    allowed_findings: Object.freeze(allowed),
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const audit = auditPublishableWorkingTree(process.argv[2] ?? resolve(process.cwd(), ".."));
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    if (!audit.pass) process.exitCode = 1;
  } catch {
    // Never echo thrown errors: a malicious filename or tool wrapper could put
    // a credential in an exception or stderr message.
    process.stderr.write("working-tree secret audit failed before producing a complete redacted report\n");
    process.exitCode = 2;
  }
}

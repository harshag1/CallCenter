#!/usr/bin/env npx tsx

// Path-only Git history credential audit. Reachable blobs are decoded only in
// bounded memory; reports contain commit, path, and finding class, never source
// lines or match values.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_RELEASE_SECRET_PATTERNS,
  PUBLIC_RELEASE_SENSITIVE_PATH_CLASSES,
  isBinarySecretContent,
  safeReportedPath,
  secretPatternClasses,
  secretSearchViews,
  sensitivePathClasses,
  type PublicReleaseSecretPatternClass,
} from "../lib/public-release-secret-rules";

/** Backward-compatible name for consumers of the original history-only gate. */
export const PUBLIC_HISTORY_SECRET_PATTERNS = PUBLIC_RELEASE_SECRET_PATTERNS;

const DEFAULT_HISTORY_ALLOWLIST_PATH = ".security/public-history-secret-audit-allowlist.json";
const MAX_HISTORY_ALLOWLIST_BYTES = 64 * 1024;
const SYNTHETIC_BENCHMARK_FIXTURE_ROOT = "benchmarks/voice-long-horizon/fixtures/";

export const DEFAULT_PUBLIC_HISTORY_LIMITS = Object.freeze({
  maxReachableCommits: 10_000,
  maxReachableRefs: 100_000,
  maxUniqueBlobs: 50_000,
  maxBlobReferences: 1_000_000,
  maxTextBlobBytes: 4 * 1024 * 1024,
  maxBinaryBlobBytes: 1024 * 1024,
  maxTotalScannedBytes: 256 * 1024 * 1024,
  maxMetadataObjectBytes: 1024 * 1024,
  maxTotalMetadataBytes: 32 * 1024 * 1024,
  maxBatchBytes: 16 * 1024 * 1024,
});

type PublicHistoryLimits = Readonly<{
  maxReachableCommits: number;
  maxReachableRefs: number;
  maxUniqueBlobs: number;
  maxBlobReferences: number;
  maxTextBlobBytes: number;
  maxBinaryBlobBytes: number;
  maxTotalScannedBytes: number;
  maxMetadataObjectBytes: number;
  maxTotalMetadataBytes: number;
  maxBatchBytes: number;
}>;
type PublicHistoryOperationalClass =
  | "historical_binary_blob_too_large"
  | "historical_blob_too_large"
  | "historical_metadata_object_too_large"
  | "historical_metadata_total_limit_exceeded"
  | "historical_invalid_tag_metadata"
  | "historical_noncommit_tag_target"
  | "historical_symlink_not_publishable"
  | "historical_total_scan_limit_exceeded"
  | "historical_unsupported_entry";

const GRAPH_ROUTING_GIT_ENVIRONMENT = Object.freeze([
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

/**
 * The audit must inspect the repository named by `cwd`, not a graph selected by
 * ambient Git environment. Replacement objects are disabled for every child
 * process so an original reachable object can never be hidden behind a clean
 * replacement.
 */
function publicHistoryGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of GRAPH_ROUTING_GIT_ENVIRONMENT) delete environment[name];
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const orderedExpected = [...expected].sort();
  return actual.length === orderedExpected.length
    && actual.every((key, index) => key === orderedExpected[index]);
}

function safeHistoryRepoPath(
  value: unknown,
  allowlistPath: string,
  patternClass: unknown,
): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) return false;
  if (isAbsolute(value) || value.includes("\0") || value.includes("\\")) return false;
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return false;
  if (value === allowlistPath || safeReportedPath(value) !== value) return false;
  const pathClasses = sensitivePathClasses(value);
  if (pathClasses.includes("customer_or_runtime_data")) return false;
  if (!pathClasses.includes("recording_or_transcript_data")) return true;
  // Public benchmark fixtures are intentionally classified as recording-like
  // data even when they contain only deterministic non-speech calibration
  // bytes. Permit only an exact blob/path/class grant inside the dedicated
  // synthetic fixture root; all other recording/customer paths remain
  // ineligible for history allowlisting and path-redacted in reports.
  return patternClass === "recording_or_transcript_data"
    && value.startsWith(SYNTHETIC_BENCHMARK_FIXTURE_ROOT);
}

function loadHistoryAllowlist(repoRoot: string, relativePath: string): LoadedHistoryAllowlist {
  if (
    typeof relativePath !== "string"
    || relativePath !== DEFAULT_HISTORY_ALLOWLIST_PATH
  ) {
    throw new Error("public history audit allowlist path is invalid");
  }
  const absolutePath = resolve(repoRoot, relativePath);
  if (relative(repoRoot, absolutePath).startsWith("..") || absolutePath === repoRoot) {
    throw new Error("public history audit allowlist path is invalid");
  }

  let raw: Buffer;
  try {
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_HISTORY_ALLOWLIST_BYTES) {
      throw new Error("invalid");
    }
    raw = readFileSync(absolutePath);
  } catch {
    throw new Error("public history audit allowlist is missing or unreadable");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new Error("public history audit allowlist is malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("public history audit allowlist is malformed");
  }
  const root = parsed as Record<string, unknown>;
  if (
    !exactObjectKeys(root, ["entries", "schema_version"])
    || root.schema_version !== 1
    || !Array.isArray(root.entries)
    || root.entries.length > 100
  ) {
    throw new Error("public history audit allowlist is malformed");
  }

  const validClasses = new Set<string>([
    ...PUBLIC_RELEASE_SECRET_PATTERNS.map((rule) => rule.patternClass),
    ...PUBLIC_RELEASE_SENSITIVE_PATH_CLASSES,
  ]);
  const ids = new Set<string>();
  const grants = new Set<string>();
  const entries: HistoryAllowlistEntry[] = [];
  for (const candidate of root.entries) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("public history audit allowlist is malformed");
    }
    const entry = candidate as Record<string, unknown>;
    if (!exactObjectKeys(entry, ["blob_oid", "id", "path", "pattern_class", "reason"])) {
      throw new Error("public history audit allowlist is malformed");
    }
    if (
      typeof entry.id !== "string"
      || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(entry.id)
      || ids.has(entry.id)
    ) {
      throw new Error("public history audit allowlist has an invalid id");
    }
    if (
      typeof entry.blob_oid !== "string"
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.blob_oid)
    ) {
      throw new Error("public history audit allowlist has an invalid blob oid");
    }
    if (!safeHistoryRepoPath(entry.path, relativePath, entry.pattern_class)) {
      throw new Error("public history audit allowlist has an invalid path");
    }
    if (typeof entry.pattern_class !== "string" || !validClasses.has(entry.pattern_class)) {
      throw new Error("public history audit allowlist has an invalid pattern class");
    }
    if (
      typeof entry.reason !== "string"
      || entry.reason.length < 20
      || entry.reason.length > 240
      || /[\r\n]/.test(entry.reason)
    ) {
      throw new Error("public history audit allowlist has invalid evidence");
    }
    const grant = `${entry.blob_oid}\0${entry.path}\0${entry.pattern_class}`;
    if (grants.has(grant)) {
      throw new Error("public history audit allowlist has a duplicate grant");
    }
    ids.add(entry.id);
    grants.add(grant);
    entries.push(Object.freeze({
      id: entry.id,
      blob_oid: entry.blob_oid,
      path: entry.path,
      pattern_class: entry.pattern_class as PublicHistoryAllowlistableClass,
      reason: entry.reason,
    }));
  }
  const ordered = [...entries].sort((left, right) => left.id.localeCompare(right.id));
  if (ordered.some((entry, index) => entry.id !== entries[index]?.id)) {
    throw new Error("public history audit allowlist entries must be ordered by id");
  }
  return Object.freeze({
    path: relativePath,
    sha256: sha256(raw),
    entries: Object.freeze(ordered),
  });
}

export type PublicHistoryFinding = Readonly<{
  commit: string;
  path: string;
  pattern_class:
    | typeof PUBLIC_HISTORY_SECRET_PATTERNS[number]["patternClass"]
    | typeof PUBLIC_RELEASE_SENSITIVE_PATH_CLASSES[number]
    | PublicHistoryOperationalClass;
}>;

export type PublicHistoryAllowedFinding = PublicHistoryFinding & Readonly<{
  blob_oid: string;
  allowlist_id: string;
}>;

export type PublicHistoryAudit = Readonly<{
  schema_version: 2;
  head_commit: string;
  reachable_commit_count: number;
  reachable_commit_set_sha256: string;
  reachable_ref_count: number;
  reachable_ref_set_sha256: string;
  complete: boolean;
  pass: boolean;
  unique_blob_count: number;
  blob_reference_count: number;
  scanned_blob_count: number;
  scanned_blob_byte_count: number;
  scanned_metadata_object_count: number;
  scanned_metadata_byte_count: number;
  pattern_count: number;
  sensitive_path_rule_count: number;
  allowlist: Readonly<{
    path: string;
    sha256: string;
    entry_count: number;
    applied_grant_count: number;
    unused_grant_ids: readonly string[];
  }>;
  finding_count: number;
  findings: readonly PublicHistoryFinding[];
  allowed_finding_count: number;
  allowed_findings: readonly PublicHistoryAllowedFinding[];
}>;

type HistoryAllowlistEntry = Readonly<{
  id: string;
  blob_oid: string;
  path: string;
  pattern_class: PublicHistoryAllowlistableClass;
  reason: string;
}>;

type PublicHistoryAllowlistableClass =
  | PublicReleaseSecretPatternClass
  | typeof PUBLIC_RELEASE_SENSITIVE_PATH_CLASSES[number];

type LoadedHistoryAllowlist = Readonly<{
  path: string;
  sha256: string;
  entries: readonly HistoryAllowlistEntry[];
}>;

function git(
  cwd: string,
  args: readonly string[],
  allowedStatuses: readonly number[] = [0]
): Buffer {
  const result = spawnSync("git", args, {
    cwd,
    env: publicHistoryGitEnvironment(),
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status === null || !allowedStatuses.includes(result.status)) {
    // Never include stderr: Git hooks/path filters can echo matched content.
    throw new Error(`public history audit git command failed with status ${String(result.status)}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

type BlobReference = Readonly<{ commit: string; path: string }>;
type BoundedGitObject = Readonly<{
  oid: string;
  size: number;
  objectType: "blob" | "commit" | "tag";
}>;
type ReachableBlob = BoundedGitObject & Readonly<{
  references: Map<string, BlobReference>;
}>;
type MetadataObject = BoundedGitObject & Readonly<{
  reportPath: string;
}>;

function normalizeLimits(input?: Partial<PublicHistoryLimits>): PublicHistoryLimits {
  const limits = { ...DEFAULT_PUBLIC_HISTORY_LIMITS, ...input };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("public history audit limit is invalid");
    }
  }
  if (
    limits.maxBinaryBlobBytes > limits.maxTextBlobBytes
    || limits.maxBatchBytes < limits.maxTextBlobBytes
    || limits.maxBatchBytes < limits.maxMetadataObjectBytes
  ) {
    throw new Error("public history audit blob limits are invalid");
  }
  return Object.freeze(limits);
}

function decodeUtf8Metadata(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error("public history audit found non-UTF-8 Git metadata");
  }
}

function objectBatches<T extends BoundedGitObject>(objects: readonly T[], maxBatchBytes: number): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const object of objects) {
    if (batch.length > 0 && bytes + object.size > maxBatchBytes) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(object);
    bytes += object.size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function readObjectBatch<T extends BoundedGitObject>(
  cwd: string,
  objects: readonly T[],
  inspect: (object: T, bytes: Buffer) => void
): void {
  const expectedBytes = objects.reduce((sum, object) => sum + object.size, 0);
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd,
    env: publicHistoryGitEnvironment(),
    input: Buffer.from(`${objects.map((object) => object.oid).join("\n")}\n`, "ascii"),
    maxBuffer: expectedBytes + objects.length * 256 + 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error("public history audit could not read a bounded blob batch");
  }
  const output = result.stdout ?? Buffer.alloc(0);
  let offset = 0;
  for (const object of objects) {
    const newline = output.indexOf(10, offset);
    if (newline < 0) throw new Error("public history audit received malformed blob metadata");
    const header = output.subarray(offset, newline).toString("ascii");
    const match = /^([0-9a-f]{40,64}) (blob|commit|tag) ([0-9]+)$/.exec(header);
    if (
      !match
      || match[1] !== object.oid
      || match[2] !== object.objectType
      || Number(match[3]) !== object.size
    ) {
      throw new Error("public history audit received an unexpected object");
    }
    const start = newline + 1;
    const end = start + object.size;
    if (end >= output.length || output[end] !== 10) {
      throw new Error("public history audit received a truncated blob");
    }
    inspect(object, output.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error("public history audit received trailing object data");
}

type GitRef = Readonly<{
  refName: string;
  oid: string;
  objectType: "blob" | "commit" | "tag" | "tree";
}>;

function readReachableRefs(cwd: string, maxRefs: number): GitRef[] {
  const output = decodeUtf8Metadata(git(cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(objecttype)",
  ]));
  const refs: GitRef[] = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const parts = line.split("\0");
    if (
      parts.length !== 3
      || !parts[0].startsWith("refs/")
      || !/^[0-9a-f]{40,64}$/.test(parts[1])
      || !/^(blob|commit|tag|tree)$/.test(parts[2])
    ) {
      throw new Error("public history audit received malformed ref metadata");
    }
    refs.push(Object.freeze({
      refName: parts[0],
      oid: parts[1],
      objectType: parts[2] as GitRef["objectType"],
    }));
    if (refs.length > maxRefs) throw new Error("public history audit reachable-ref limit exceeded");
  }
  return refs;
}

type MetadataRequest = Readonly<{
  oid: string;
  objectType: "blob" | "commit" | "tag";
  reportPath: MetadataObject["reportPath"];
}>;

function resolveMetadataObjectSizes(cwd: string, requests: readonly MetadataRequest[]): MetadataObject[] {
  if (requests.length === 0) return [];
  const result = spawnSync("git", [
    "cat-file",
    "--batch-check=%(objectname) %(objecttype) %(objectsize)",
  ], {
    cwd,
    env: publicHistoryGitEnvironment(),
    input: Buffer.from(`${requests.map((request) => request.oid).join("\n")}\n`, "ascii"),
    maxBuffer: requests.length * 256 + 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error("public history audit could not size metadata objects");
  }
  const lines = (result.stdout ?? Buffer.alloc(0)).toString("ascii").split("\n").filter(Boolean);
  if (lines.length !== requests.length) {
    throw new Error("public history audit received incomplete metadata sizes");
  }
  return requests.map((request, index) => {
    const match = /^([0-9a-f]{40,64}) (blob|commit|tag) ([0-9]+)$/.exec(lines[index]);
    const size = match ? Number(match[3]) : Number.NaN;
    if (
      !match
      || match[1] !== request.oid
      || match[2] !== request.objectType
      || !Number.isSafeInteger(size)
      || size < 0
    ) {
      throw new Error("public history audit received invalid metadata size");
    }
    return Object.freeze({ ...request, size });
  });
}

function singleGitLine(cwd: string, args: readonly string[], label: string): string {
  const output = git(cwd, args);
  if (output.length < 2 || output[output.length - 1] !== 10) {
    throw new Error(`public history audit received malformed ${label}`);
  }
  const value = output.subarray(0, output.length - 1).toString("utf8");
  if (!value || /[\0\r\n]/.test(value)) {
    throw new Error(`public history audit received malformed ${label}`);
  }
  return value;
}

/**
 * Local graph overlays are not part of a normal published ref graph. Even
 * though every Git process disables replacement objects, reject the overlays
 * explicitly so release evidence cannot silently depend on local graph state.
 */
function assertCanonicalGitGraph(cwd: string): void {
  const shallow = singleGitLine(
    cwd,
    ["rev-parse", "--is-shallow-repository"],
    "shallow-repository state"
  );
  if (shallow !== "false") {
    throw new Error("public history audit refuses a shallow repository");
  }

  const replacementRefs = git(cwd, ["for-each-ref", "--format=%(refname)", "refs/replace/"]);
  if (replacementRefs.length !== 0) {
    throw new Error("public history audit refuses replacement refs");
  }

  const commonDirectoryValue = singleGitLine(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "common Git directory"
  );
  const commonDirectory = isAbsolute(commonDirectoryValue)
    ? commonDirectoryValue
    : resolve(cwd, commonDirectoryValue);
  try {
    const grafts = lstatSync(resolve(commonDirectory, "info", "grafts"));
    if (grafts.isSymbolicLink() || !grafts.isFile() || grafts.size > 0) {
      throw new Error("public history audit refuses legacy grafts");
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : null;
    if (code !== "ENOENT") throw error;
  }
}

export function auditReachableGitHistory(
  repoRoot: string,
  options: Readonly<{ limits?: Partial<PublicHistoryLimits> }> = {}
): PublicHistoryAudit {
  const cwd = resolve(repoRoot);
  const limits = normalizeLimits(options.limits);
  const allowlist = loadHistoryAllowlist(cwd, DEFAULT_HISTORY_ALLOWLIST_PATH);
  const grantMap = new Map<string, HistoryAllowlistEntry>();
  for (const entry of allowlist.entries) {
    grantMap.set(`${entry.blob_oid}\0${entry.path}\0${entry.pattern_class}`, entry);
  }
  const appliedGrantIds = new Set<string>();
  assertCanonicalGitGraph(cwd);
  const commits = git(cwd, ["rev-list", "--all"])
    .toString("ascii")
    .split("\n")
    .filter((value) => /^[a-f0-9]{40,64}$/.test(value));
  if (commits.length === 0) throw new Error("public history audit found no reachable commits");
  if (commits.length > limits.maxReachableCommits) {
    throw new Error("public history audit reachable-commit limit exceeded");
  }
  const commitSet = new Set(commits);
  const headCommit = git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])
    .toString("ascii")
    .trim();
  if (!/^[a-f0-9]{40,64}$/.test(headCommit)) {
    throw new Error("public history audit could not bind HEAD");
  }
  const reachableCommitSetSha256 = createHash("sha256")
    .update([...commits].sort().join("\n"), "ascii")
    .update("\n", "ascii")
    .digest("hex");
  const refs = readReachableRefs(cwd, limits.maxReachableRefs);
  const reachableRefSetSha256 = createHash("sha256")
    .update(
      [...refs]
        .sort((left, right) => left.refName.localeCompare(right.refName))
        .map((ref) => `${ref.refName}\0${ref.oid}\0${ref.objectType}\n`)
        .join(""),
      "utf8"
    )
    .digest("hex");

  const findings = new Map<string, PublicHistoryFinding>();
  const allowedFindings = new Map<string, PublicHistoryAllowedFinding>();
  const blobs = new Map<string, ReachableBlob>();
  let blobReferenceCount = 0;
  let complete = true;
  const addFinding = (
    commit: string,
    path: string,
    patternClass: PublicHistoryFinding["pattern_class"],
    blobOid: string | null = null
  ) => {
    const pathClasses = sensitivePathClasses(path);
    const privacySensitivePath = pathClasses.includes("recording_or_transcript_data")
      || pathClasses.includes("customer_or_runtime_data");
    const finding = Object.freeze({
      commit,
      path: safeReportedPath(path, privacySensitivePath),
      pattern_class: patternClass,
    });
    const grant = blobOid === null
      ? undefined
      : grantMap.get(`${blobOid}\0${path}\0${patternClass}`);
    if (grant && blobOid !== null) {
      appliedGrantIds.add(grant.id);
      allowedFindings.set(
        `${commit}\0${path}\0${patternClass}\0${blobOid}`,
        Object.freeze({
          ...finding,
          blob_oid: blobOid,
          allowlist_id: grant.id,
        })
      );
      return;
    }
    findings.set(`${commit}\0${path}\0${patternClass}`, finding);
  };
  const metadataRequests = new Map<string, MetadataRequest>();
  const treeRoots = new Set(commits);
  for (const commit of commits) {
    metadataRequests.set(commit, Object.freeze({
      oid: commit,
      objectType: "commit" as const,
      reportPath: "[COMMIT_METADATA]" as const,
    }));
  }
  for (const ref of refs) {
    for (const pathClass of [...sensitivePathClasses(ref.refName), ...secretPatternClasses(ref.refName)]) {
      addFinding(ref.oid, ref.refName, pathClass);
    }
    if (ref.objectType === "tag") {
      metadataRequests.set(ref.oid, Object.freeze({
        oid: ref.oid,
        objectType: "tag" as const,
        reportPath: "[TAG_METADATA]" as const,
      }));
    } else if (ref.objectType === "tree") {
      treeRoots.add(ref.oid);
    } else if (ref.objectType === "blob") {
      metadataRequests.set(ref.oid, Object.freeze({
        oid: ref.oid,
        objectType: "blob" as const,
        reportPath: "[REF_TARGET]",
      }));
    }
  }

  // Build a commit/path -> unique-blob inventory. This catches sensitive paths
  // even when the blob has no key-shaped bytes and lets content be decoded once
  // regardless of how many commits reference it.
  for (const treeRoot of treeRoots) {
    const entries = decodeUtf8Metadata(git(cwd, ["ls-tree", "-rl", "-z", "--full-tree", treeRoot]))
      .split("\0")
      .filter(Boolean);
    for (const entry of entries) {
      blobReferenceCount += 1;
      if (blobReferenceCount > limits.maxBlobReferences) {
        throw new Error("public history audit blob-reference limit exceeded");
      }
      const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40,64})[ ]+([0-9-]+)\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("public history audit received malformed tree metadata");
      const [, mode, type, oid, sizeText, path] = match;
      const pathFindings = [...sensitivePathClasses(path), ...secretPatternClasses(path)];
      const allowlistableBlobOid =
        type === "blob" && mode !== "120000" && sizeText !== "-" ? oid : null;
      for (const pathClass of pathFindings) {
        addFinding(treeRoot, path, pathClass, allowlistableBlobOid);
      }
      if (mode === "120000") {
        complete = false;
        addFinding(treeRoot, path, "historical_symlink_not_publishable");
        continue;
      }
      if (type !== "blob" || sizeText === "-") {
        complete = false;
        addFinding(treeRoot, path, "historical_unsupported_entry");
        continue;
      }
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("public history audit received an invalid blob size");
      }
      const existing = blobs.get(oid);
      const reference = Object.freeze({ commit: treeRoot, path });
      if (existing) {
        if (existing.size !== size) throw new Error("public history audit found inconsistent blob sizes");
        existing.references.set(`${treeRoot}\0${path}`, reference);
      } else {
        if (blobs.size >= limits.maxUniqueBlobs) {
          throw new Error("public history audit unique-blob limit exceeded");
        }
        blobs.set(oid, Object.freeze({
          oid,
          size,
          objectType: "blob" as const,
          references: new Map([[`${treeRoot}\0${path}`, reference]]),
        }));
      }
    }
  }

  let scannedBlobCount = 0;
  let scannedBlobByteCount = 0;
  let eligibleBlobs: ReachableBlob[] = [];
  for (const blob of blobs.values()) {
    if (blob.size > limits.maxTextBlobBytes) {
      complete = false;
      for (const reference of blob.references.values()) {
        addFinding(reference.commit, reference.path, "historical_blob_too_large");
      }
    } else {
      eligibleBlobs.push(blob);
    }
  }
  const totalEligibleBytes = eligibleBlobs.reduce((sum, blob) => sum + blob.size, 0);
  if (!Number.isSafeInteger(totalEligibleBytes) || totalEligibleBytes > limits.maxTotalScannedBytes) {
    complete = false;
    addFinding(headCommit, "[HISTORY]", "historical_total_scan_limit_exceeded");
    eligibleBlobs = [];
  }

  for (const batch of objectBatches(eligibleBlobs, limits.maxBatchBytes)) {
    readObjectBatch(cwd, batch, (blob, bytes) => {
      const binary = isBinarySecretContent(bytes);
      if (binary && bytes.length > limits.maxBinaryBlobBytes) {
        complete = false;
        for (const reference of blob.references.values()) {
          addFinding(reference.commit, reference.path, "historical_binary_blob_too_large");
        }
        return;
      }
      scannedBlobCount += 1;
      scannedBlobByteCount += bytes.length;
      const contentClasses = new Set<PublicHistoryFinding["pattern_class"]>();
      for (const view of secretSearchViews(bytes, binary)) {
        for (const patternClass of secretPatternClasses(view)) contentClasses.add(patternClass);
      }
      for (const reference of blob.references.values()) {
        for (const patternClass of contentClasses) {
          addFinding(reference.commit, reference.path, patternClass, blob.oid);
        }
      }
    });
  }

  let scannedMetadataObjectCount = 0;
  let scannedMetadataByteCount = 0;
  let eligibleMetadata = resolveMetadataObjectSizes(cwd, [...metadataRequests.values()]);
  const boundedMetadata: MetadataObject[] = [];
  for (const metadata of eligibleMetadata) {
    if (metadata.size > limits.maxMetadataObjectBytes) {
      complete = false;
      addFinding(metadata.oid, metadata.reportPath, "historical_metadata_object_too_large");
    } else {
      boundedMetadata.push(metadata);
    }
  }
  eligibleMetadata = boundedMetadata;
  const totalMetadataBytes = eligibleMetadata.reduce((sum, metadata) => sum + metadata.size, 0);
  if (!Number.isSafeInteger(totalMetadataBytes) || totalMetadataBytes > limits.maxTotalMetadataBytes) {
    complete = false;
    addFinding(headCommit, "[HISTORY_METADATA]", "historical_metadata_total_limit_exceeded");
    eligibleMetadata = [];
  }
  for (const batch of objectBatches(eligibleMetadata, limits.maxBatchBytes)) {
    readObjectBatch(cwd, batch, (metadata, bytes) => {
      scannedMetadataObjectCount += 1;
      scannedMetadataByteCount += bytes.length;
      if (metadata.objectType === "tag") {
        const header = bytes.subarray(0, Math.min(bytes.length, 512)).toString("ascii");
        const target = /^object ([0-9a-f]{40,64})\ntype (blob|commit|tag|tree)\n/.exec(header);
        if (!target) {
          complete = false;
          addFinding(metadata.oid, metadata.reportPath, "historical_invalid_tag_metadata");
        } else if (target[2] !== "commit" || !commitSet.has(target[1])) {
          // A nested tag or direct blob/tree tag would require additional graph
          // traversal. Fail closed rather than silently claiming it was scanned.
          complete = false;
          addFinding(metadata.oid, metadata.reportPath, "historical_noncommit_tag_target");
        }
      }
      const binary = isBinarySecretContent(bytes);
      const contentClasses = new Set<PublicHistoryFinding["pattern_class"]>();
      for (const view of secretSearchViews(bytes, binary)) {
        for (const patternClass of secretPatternClasses(view)) contentClasses.add(patternClass);
      }
      for (const patternClass of contentClasses) {
        addFinding(metadata.oid, metadata.reportPath, patternClass);
      }
    });
  }

  const ordered = [...findings.values()].sort((left, right) =>
    left.commit.localeCompare(right.commit)
      || left.path.localeCompare(right.path)
      || left.pattern_class.localeCompare(right.pattern_class)
  );
  const orderedAllowed = [...allowedFindings.values()].sort((left, right) =>
    left.commit.localeCompare(right.commit)
      || left.path.localeCompare(right.path)
      || left.pattern_class.localeCompare(right.pattern_class)
      || left.blob_oid.localeCompare(right.blob_oid)
      || left.allowlist_id.localeCompare(right.allowlist_id)
  );
  const unusedGrantIds = allowlist.entries
    .map((entry) => entry.id)
    .filter((id) => !appliedGrantIds.has(id));
  return Object.freeze({
    schema_version: 2 as const,
    head_commit: headCommit,
    reachable_commit_count: commits.length,
    reachable_commit_set_sha256: reachableCommitSetSha256,
    reachable_ref_count: refs.length,
    reachable_ref_set_sha256: reachableRefSetSha256,
    complete,
    pass: complete && ordered.length === 0 && unusedGrantIds.length === 0,
    unique_blob_count: blobs.size,
    blob_reference_count: blobReferenceCount,
    scanned_blob_count: scannedBlobCount,
    scanned_blob_byte_count: scannedBlobByteCount,
    scanned_metadata_object_count: scannedMetadataObjectCount,
    scanned_metadata_byte_count: scannedMetadataByteCount,
    pattern_count: PUBLIC_HISTORY_SECRET_PATTERNS.length,
    sensitive_path_rule_count: PUBLIC_RELEASE_SENSITIVE_PATH_CLASSES.length,
    allowlist: Object.freeze({
      path: allowlist.path,
      sha256: allowlist.sha256,
      entry_count: allowlist.entries.length,
      applied_grant_count: appliedGrantIds.size,
      unused_grant_ids: Object.freeze(unusedGrantIds),
    }),
    finding_count: ordered.length,
    findings: Object.freeze(ordered),
    allowed_finding_count: orderedAllowed.length,
    allowed_findings: Object.freeze(orderedAllowed),
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const audit = auditReachableGitHistory(process.argv[2] ?? resolve(process.cwd(), ".."));
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    if (!audit.pass) process.exitCode = 1;
  } catch {
    // Fail closed without printing command stderr, file contents, or match values.
    process.stderr.write("public history audit failed before producing a complete path-only report\n");
    process.exitCode = 2;
  }
}

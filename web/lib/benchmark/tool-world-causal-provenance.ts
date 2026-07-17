import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./artifacts";

const HASH_DOMAIN = "harshas-amazing-call-center/tool-world-causal-provenance/v1\n";
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export const TOOL_WORLD_CAUSAL_ARTIFACT_PATH =
  "benchmarks/voice-long-horizon/scenarios/tool-world-causal-containment.v1.json" as const;
export const TOOL_WORLD_CAUSAL_PROVENANCE_PATH =
  "benchmarks/voice-long-horizon/scenarios/tool-world-causal-containment.v1.provenance.json" as const;

export const TOOL_WORLD_CAUSAL_SOURCE_PATHS = Object.freeze([
  "web/lib/benchmark/tool-world-causal-containment.ts",
  "web/lib/benchmark/tool-world.ts",
  "web/lib/benchmark/world-events.ts",
  "web/lib/benchmark/scenario-schema.ts",
] as const);

const SourceEntrySchema = z.object({
  path: z.string().min(1),
  byte_length: z.number().int().nonnegative(),
  sha256: z.string().regex(SHA256),
  relation_to_tracked_base: z.enum(["matches-base", "modified-from-base", "untracked-at-base"]),
  base_blob_oid: z.string().regex(GIT_OBJECT_ID).optional(),
  base_content_sha256: z.string().regex(SHA256).optional(),
}).strict().superRefine((entry, ctx) => {
  const untracked = entry.relation_to_tracked_base === "untracked-at-base";
  if (untracked && (entry.base_blob_oid !== undefined || entry.base_content_sha256 !== undefined)) {
    ctx.addIssue({ code: "custom", message: "untracked-at-base source must not claim a base blob" });
  }
  if (!untracked && (entry.base_blob_oid === undefined || entry.base_content_sha256 === undefined)) {
    ctx.addIssue({ code: "custom", message: "tracked source requires base blob and base content hashes" });
  }
});

const ProvenanceBodySchema = z.object({
  schema_version: z.literal(1),
  benchmark_version: z.literal("tool-world-causal-containment.v1"),
  artifact: z.object({
    path: z.literal(TOOL_WORLD_CAUSAL_ARTIFACT_PATH),
    byte_length: z.number().int().nonnegative(),
    sha256: z.string().regex(SHA256),
    scenario_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    trial_set_hash: z.string().regex(SHA256),
    result_hash: z.string().regex(SHA256),
  }).strict(),
  tracked_base: z.object({
    commit_oid: z.string().regex(GIT_OBJECT_ID),
    tree_oid: z.string().regex(GIT_OBJECT_ID),
    capture_worktree_dirty: z.boolean(),
    claim: z.literal("tracked base before the selected worktree bytes; not a clean-build claim"),
  }).strict(),
  binding_scope: z.object({
    authority: z.literal("listed worktree file bytes and checked artifact bytes"),
    unrelated_worktree_changes_bound: z.literal(false),
    note: z.literal("the tracked base establishes ancestry; per-file SHA-256 values establish the tested implementation"),
  }).strict(),
  sources: z.array(SourceEntrySchema).length(TOOL_WORLD_CAUSAL_SOURCE_PATHS.length),
}).strict();

export const ToolWorldCausalProvenanceManifestSchema = ProvenanceBodySchema.extend({
  binding_sha256: z.string().regex(SHA256),
}).strict();

export type ToolWorldCausalProvenanceManifest = z.infer<typeof ToolWorldCausalProvenanceManifestSchema>;
export type ToolWorldCausalProvenanceVerification = Readonly<{
  valid: boolean;
  errors: readonly string[];
}>;

type ByteReader = (absolutePath: string) => Uint8Array;

function gitText(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGitText(repoRoot: string, args: readonly string[]): string | null {
  try {
    return gitText(repoRoot, args);
  } catch {
    return null;
  }
}

function gitBytes(repoRoot: string, revisionAndPath: string): Uint8Array | null {
  try {
    return execFileSync("git", ["show", revisionAndPath], {
      cwd: repoRoot,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function artifactIdentity(bytes: Uint8Array) {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
  for (const field of ["scenario_hash", "trial_set_hash", "result_hash"] as const) {
    if (typeof parsed[field] !== "string") throw new Error(`causal artifact ${field} must be a string`);
  }
  if (parsed.benchmark_version !== "tool-world-causal-containment.v1") {
    throw new Error("causal artifact benchmark_version mismatch");
  }
  return {
    scenario_hash: parsed.scenario_hash as string,
    trial_set_hash: parsed.trial_set_hash as string,
    result_hash: parsed.result_hash as string,
  };
}

function manifestBinding(body: z.infer<typeof ProvenanceBodySchema>): string {
  return sha256Hex(`${HASH_DOMAIN}${canonicalJson(body)}`);
}

/**
 * Capture a dirty-worktree-safe evidence envelope. The Git commit/tree are an
 * ancestry anchor only; the selected worktree byte hashes are authoritative.
 */
export function createToolWorldCausalProvenanceManifest(
  repoRoot: string,
  readBytes: ByteReader = (path) => readFileSync(path)
): ToolWorldCausalProvenanceManifest {
  const commitOid = gitText(repoRoot, ["rev-parse", "HEAD"]);
  const treeOid = gitText(repoRoot, ["rev-parse", `${commitOid}^{tree}`]);
  const captureWorktreeDirty = gitText(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).length > 0;
  const artifactBytes = readBytes(resolve(repoRoot, TOOL_WORLD_CAUSAL_ARTIFACT_PATH));
  const identity = artifactIdentity(artifactBytes);

  const sources = TOOL_WORLD_CAUSAL_SOURCE_PATHS.map((path) => {
    const current = readBytes(resolve(repoRoot, path));
    const base = gitBytes(repoRoot, `${commitOid}:${path}`);
    if (base === null) {
      return {
        path,
        byte_length: current.byteLength,
        sha256: sha256Hex(current),
        relation_to_tracked_base: "untracked-at-base" as const,
      };
    }
    const baseSha256 = sha256Hex(base);
    return {
      path,
      byte_length: current.byteLength,
      sha256: sha256Hex(current),
      relation_to_tracked_base: baseSha256 === sha256Hex(current)
        ? "matches-base" as const
        : "modified-from-base" as const,
      base_blob_oid: gitText(repoRoot, ["rev-parse", `${commitOid}:${path}`]),
      base_content_sha256: baseSha256,
    };
  });

  const body = ProvenanceBodySchema.parse({
    schema_version: 1,
    benchmark_version: "tool-world-causal-containment.v1",
    artifact: {
      path: TOOL_WORLD_CAUSAL_ARTIFACT_PATH,
      byte_length: artifactBytes.byteLength,
      sha256: sha256Hex(artifactBytes),
      ...identity,
    },
    tracked_base: {
      commit_oid: commitOid,
      tree_oid: treeOid,
      capture_worktree_dirty: captureWorktreeDirty,
      claim: "tracked base before the selected worktree bytes; not a clean-build claim",
    },
    binding_scope: {
      authority: "listed worktree file bytes and checked artifact bytes",
      unrelated_worktree_changes_bound: false,
      note: "the tracked base establishes ancestry; per-file SHA-256 values establish the tested implementation",
    },
    sources,
  });
  return Object.freeze({
    ...body,
    binding_sha256: manifestBinding(body),
  });
}

/** Verify artifact bytes, source bytes, binding hash, and tracked-base objects. */
export function verifyToolWorldCausalProvenanceManifest(
  repoRoot: string,
  input: unknown,
  readBytes: ByteReader = (path) => readFileSync(path)
): ToolWorldCausalProvenanceVerification {
  const parsed = ToolWorldCausalProvenanceManifestSchema.safeParse(input);
  if (!parsed.success) {
    return Object.freeze({
      valid: false,
      errors: Object.freeze(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)),
    });
  }
  const manifest = parsed.data;
  const errors: string[] = [];
  const actualPaths = manifest.sources.map((source) => source.path);
  if (new Set(actualPaths).size !== actualPaths.length) errors.push("source paths must be unique");
  if (canonicalJson([...actualPaths].sort()) !== canonicalJson([...TOOL_WORLD_CAUSAL_SOURCE_PATHS].sort())) {
    errors.push("source path set differs from the required causal implementation set");
  }

  const { binding_sha256: claimedBinding, ...bodyInput } = manifest;
  const body = ProvenanceBodySchema.parse(bodyInput);
  if (manifestBinding(body) !== claimedBinding) errors.push("binding_sha256 mismatch");

  const baseCommitType = tryGitText(repoRoot, ["cat-file", "-t", manifest.tracked_base.commit_oid]);
  if (baseCommitType !== "commit") errors.push("tracked base commit object is unavailable");
  const actualBaseTree = tryGitText(repoRoot, ["rev-parse", `${manifest.tracked_base.commit_oid}^{tree}`]);
  if (actualBaseTree !== manifest.tracked_base.tree_oid) errors.push("tracked base tree_oid mismatch");

  try {
    const artifactBytes = readBytes(resolve(repoRoot, manifest.artifact.path));
    if (artifactBytes.byteLength !== manifest.artifact.byte_length) errors.push("artifact byte_length mismatch");
    if (sha256Hex(artifactBytes) !== manifest.artifact.sha256) errors.push("artifact sha256 mismatch");
    const identity = artifactIdentity(artifactBytes);
    for (const field of ["scenario_hash", "trial_set_hash", "result_hash"] as const) {
      if (identity[field] !== manifest.artifact[field]) errors.push(`artifact ${field} mismatch`);
    }
  } catch (error) {
    errors.push(`artifact verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const source of manifest.sources) {
    try {
      const current = readBytes(resolve(repoRoot, source.path));
      if (current.byteLength !== source.byte_length) errors.push(`${source.path}: byte_length mismatch`);
      if (sha256Hex(current) !== source.sha256) errors.push(`${source.path}: sha256 mismatch`);

      const base = gitBytes(repoRoot, `${manifest.tracked_base.commit_oid}:${source.path}`);
      if (source.relation_to_tracked_base === "untracked-at-base") {
        if (base !== null) errors.push(`${source.path}: claimed untracked-at-base but a base blob exists`);
      } else if (base === null) {
        errors.push(`${source.path}: tracked base blob is unavailable`);
      } else {
        const baseSha256 = sha256Hex(base);
        if (baseSha256 !== source.base_content_sha256) errors.push(`${source.path}: base_content_sha256 mismatch`);
        const baseBlobOid = tryGitText(repoRoot, ["rev-parse", `${manifest.tracked_base.commit_oid}:${source.path}`]);
        if (baseBlobOid !== source.base_blob_oid) errors.push(`${source.path}: base_blob_oid mismatch`);
        const expectedRelation = baseSha256 === sha256Hex(current) ? "matches-base" : "modified-from-base";
        if (expectedRelation !== source.relation_to_tracked_base) {
          errors.push(`${source.path}: relation_to_tracked_base mismatch`);
        }
      }
    } catch (error) {
      errors.push(`${source.path}: verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditReachableGitHistory } from "../../scripts/public-history-audit";

const temporaryRepos: string[] = [];

function temporaryRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "hacc-public-history-"));
  temporaryRepos.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Security Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "security@example.test"], { cwd: repo });
  mkdirSync(join(repo, ".security"));
  writeHistoryAllowlist(repo, []);
  return repo;
}

function syntheticOpenAiToken(seed = "A"): string {
  return ["sk", "-proj-", seed.repeat(48)].join("");
}

function writeHistoryAllowlist(repo: string, entries: unknown[]): void {
  writeFileSync(
    join(repo, ".security/public-history-secret-audit-allowlist.json"),
    `${JSON.stringify({ schema_version: 1, entries }, null, 2)}\n`,
    "utf8"
  );
}

describe("path-only public history audit", () => {
  afterEach(() => {
    for (const repo of temporaryRepos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  it("finds a secret deleted from HEAD without returning its value or line", () => {
    const repo = temporaryRepo();
    const token = syntheticOpenAiToken();
    writeFileSync(join(repo, "historical.env"), `OPENAI_API_KEY=${token}\n`, "utf8");
    execFileSync("git", ["add", "historical.env"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "add historical fixture"], { cwd: repo });
    writeFileSync(join(repo, "historical.env"), "OPENAI_API_KEY=\n", "utf8");
    execFileSync("git", ["commit", "-qam", "remove historical fixture"], { cwd: repo });

    const audit = auditReachableGitHistory(repo);
    expect(audit.reachable_commit_count).toBe(2);
    expect(audit.head_commit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(audit.reachable_commit_set_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.finding_count).toBe(1);
    expect(audit.findings[0]).toMatchObject({
      path: "historical.env",
      pattern_class: "openai_project_key",
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("OPENAI_API_KEY=");
  });

  it("allows only an exact historical blob, path, and class and rejects unused grants", () => {
    const repo = temporaryRepo();
    const token = "a".repeat(32);
    const fixturePath = "bridge/test/auth.test.js";
    mkdirSync(join(repo, "bridge/test"), { recursive: true });
    writeFileSync(join(repo, fixturePath), `TWILIO_AUTH_TOKEN=${token}\n`, "utf8");
    execFileSync("git", ["add", fixturePath], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "synthetic auth fixture"], { cwd: repo });
    const blobOid = execFileSync("git", ["rev-parse", `HEAD:${fixturePath}`], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

    const baseline = auditReachableGitHistory(repo);
    expect(baseline.pass).toBe(false);
    expect(baseline.findings).toContainEqual(expect.objectContaining({
      path: fixturePath,
      pattern_class: "provider_secret_assignment",
    }));

    const exactGrant = {
      id: "synthetic-bridge-auth-unit-fixture",
      blob_oid: blobOid,
      path: fixturePath,
      pattern_class: "provider_secret_assignment",
      reason: "Synthetic bridge authentication unit fixture with inert credential-shaped test bytes.",
    };
    writeHistoryAllowlist(repo, [exactGrant]);
    const allowed = auditReachableGitHistory(repo);
    expect(allowed).toMatchObject({
      schema_version: 2,
      complete: true,
      pass: true,
      finding_count: 0,
      allowed_finding_count: 1,
      allowlist: {
        entry_count: 1,
        applied_grant_count: 1,
        unused_grant_ids: [],
      },
    });
    expect(allowed.allowed_findings).toEqual([
      expect.objectContaining({
        path: fixturePath,
        pattern_class: "provider_secret_assignment",
        blob_oid: blobOid,
        allowlist_id: exactGrant.id,
      }),
    ]);
    const serialized = JSON.stringify(allowed);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("TWILIO_AUTH_TOKEN=");

    writeHistoryAllowlist(repo, [{
      ...exactGrant,
      blob_oid: "f".repeat(40),
    }]);
    const stale = auditReachableGitHistory(repo);
    expect(stale.pass).toBe(false);
    expect(stale.finding_count).toBe(1);
    expect(stale.allowed_finding_count).toBe(0);
    expect(stale.allowlist.unused_grant_ids).toEqual([exactGrant.id]);

    for (const mismatch of [
      { path: "bridge/test/other.test.js" },
      { pattern_class: "openai_project_key" },
    ]) {
      writeHistoryAllowlist(repo, [{ ...exactGrant, ...mismatch }]);
      const mismatched = auditReachableGitHistory(repo);
      expect(mismatched.pass).toBe(false);
      expect(mismatched.finding_count).toBe(1);
      expect(mismatched.allowed_finding_count).toBe(0);
      expect(mismatched.allowlist.unused_grant_ids).toEqual([exactGrant.id]);
    }

    writeHistoryAllowlist(repo, [
      exactGrant,
      { ...exactGrant, id: "duplicate-exact-history-grant" },
    ]);
    expect(() => auditReachableGitHistory(repo)).toThrow(/duplicate grant/);

    writeHistoryAllowlist(repo, [{ ...exactGrant, unexpected: true }]);
    expect(() => auditReachableGitHistory(repo)).toThrow(/allowlist is malformed/);
  });

  it("allows only exact recording-class grants under the synthetic benchmark fixture root", () => {
    const repo = temporaryRepo();
    const fixturePath =
      "benchmarks/voice-long-horizon/fixtures/transport-smoke-v1/turn_01.pcm16le-mono-16000.pcm";
    mkdirSync(join(repo, "benchmarks/voice-long-horizon/fixtures/transport-smoke-v1"), {
      recursive: true,
    });
    writeFileSync(join(repo, fixturePath), Buffer.from([0, 0, 1, 0, 255, 255, 0, 0]));
    execFileSync("git", ["add", fixturePath], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "add deterministic transport fixture"], { cwd: repo });
    const blobOid = execFileSync("git", ["rev-parse", `HEAD:${fixturePath}`], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const exactGrant = {
      id: "synthetic-transport-smoke-pcm",
      blob_oid: blobOid,
      path: fixturePath,
      pattern_class: "recording_or_transcript_data",
      reason: "Deterministic non-speech transport calibration bytes with an exact content-addressed grant.",
    };

    writeHistoryAllowlist(repo, [exactGrant]);
    const allowed = auditReachableGitHistory(repo);
    expect(allowed).toMatchObject({
      complete: true,
      pass: true,
      finding_count: 0,
      allowed_finding_count: 1,
      allowlist: {
        applied_grant_count: 1,
        unused_grant_ids: [],
      },
    });
    expect(allowed.allowed_findings[0]).toMatchObject({
      pattern_class: "recording_or_transcript_data",
      blob_oid: blobOid,
      allowlist_id: exactGrant.id,
    });
    expect(allowed.allowed_findings[0]?.path).toMatch(/^\[REDACTED_PATH:[0-9a-f]{16}\]$/);
    expect(JSON.stringify(allowed)).not.toContain(fixturePath);

    writeHistoryAllowlist(repo, [{
      ...exactGrant,
      path: "recordings/turn_01.pcm",
    }]);
    expect(() => auditReachableGitHistory(repo)).toThrow(/invalid path/);

    writeHistoryAllowlist(repo, [{
      ...exactGrant,
      pattern_class: "provider_secret_assignment",
    }]);
    expect(() => auditReachableGitHistory(repo)).toThrow(/invalid path/);
  });

  it("detects common encodings without returning either encoded or decoded values", () => {
    const repo = temporaryRepo();
    const decoded = syntheticOpenAiToken("B");
    const encoded = Buffer.from(decoded, "utf8").toString("base64");
    writeFileSync(join(repo, "encoded.txt"), encoded, "utf8");
    writeFileSync(join(repo, "late-utf16.dat"), Buffer.concat([
      Buffer.alloc(8 * 1024, 65),
      Buffer.from(decoded, "utf16le"),
    ]));
    execFileSync("git", ["add", "encoded.txt", "late-utf16.dat"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "add encoded fixture"], { cwd: repo });

    const audit = auditReachableGitHistory(repo);
    expect(audit.findings).toContainEqual(expect.objectContaining({
      path: "encoded.txt",
      pattern_class: "base64_provider_key",
    }));
    expect(audit.findings).toContainEqual(expect.objectContaining({
      path: "late-utf16.dat",
      pattern_class: "openai_project_key",
    }));
    expect(audit.complete).toBe(true);
    const report = JSON.stringify(audit);
    expect(report).not.toContain(decoded);
    expect(report).not.toContain(encoded);

    const capped = auditReachableGitHistory(repo, {
      limits: { maxBinaryBlobBytes: 8 * 1024 },
    });
    expect(capped.complete).toBe(false);
    expect(capped.findings).toContainEqual(expect.objectContaining({
      path: "late-utf16.dat",
      pattern_class: "historical_binary_blob_too_large",
    }));
    expect(JSON.stringify(capped)).not.toContain(decoded);
  });

  it("finds deleted private env, recording, and customer-data paths", () => {
    const repo = temporaryRepo();
    mkdirSync(join(repo, "recordings"));
    mkdirSync(join(repo, "exports"));
    writeFileSync(join(repo, ".env.production"), "EMPTY=\n", "utf8");
    writeFileSync(join(repo, "recordings/call.wav"), Buffer.from([0, 1, 2]));
    writeFileSync(join(repo, "exports/customer-data.csv"), "id,status\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "add private path fixtures"], { cwd: repo });
    rmSync(join(repo, ".env.production"));
    rmSync(join(repo, "recordings"), { recursive: true });
    rmSync(join(repo, "exports"), { recursive: true });
    execFileSync("git", ["add", "-u"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "remove private path fixtures"], { cwd: repo });

    const audit = auditReachableGitHistory(repo);
    expect(audit.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ".env.production", pattern_class: "private_environment_file" }),
      expect.objectContaining({
        path: expect.stringMatching(/^\[REDACTED_PATH:[0-9a-f]{16}\]$/),
        pattern_class: "recording_or_transcript_data",
      }),
      expect.objectContaining({
        path: expect.stringMatching(/^\[REDACTED_PATH:[0-9a-f]{16}\]$/),
        pattern_class: "customer_or_runtime_data",
      }),
    ]));
  });

  it("finds and redacts plain-text transcripts, video recordings, and text exports in history", () => {
    const repo = temporaryRepo();
    mkdirSync(join(repo, "transcripts"));
    mkdirSync(join(repo, "recordings"));
    mkdirSync(join(repo, "exports"));
    const transcript = "transcripts/member-Alice-call.vtt";
    const recording = "recordings/member-Alice-call.mp4";
    const customerExport = "exports/customer-Jane_Doe-data.log";
    writeFileSync(join(repo, transcript), "WEBVTT\n", "utf8");
    writeFileSync(join(repo, recording), Buffer.from([0, 1, 2]));
    writeFileSync(join(repo, customerExport), "synthetic export\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "private path fixtures"], { cwd: repo });

    const audit = auditReachableGitHistory(repo);
    expect(audit.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: expect.stringMatching(/^\[REDACTED_PATH:[0-9a-f]{16}\]$/),
        pattern_class: "recording_or_transcript_data",
      }),
      expect.objectContaining({
        path: expect.stringMatching(/^\[REDACTED_PATH:[0-9a-f]{16}\]$/),
        pattern_class: "customer_or_runtime_data",
      }),
    ]));
    const report = JSON.stringify(audit);
    expect(report).not.toContain("Alice");
    expect(report).not.toContain("Jane_Doe");
  });

  it("covers every reachable ref and redacts a credential embedded in a filename", () => {
    const repo = temporaryRepo();
    writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
    execFileSync("git", ["add", "base.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
    const defaultBranch = execFileSync("git", ["branch", "--show-current"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", "-qb", "private-ref"], { cwd: repo });
    const secretFilename = `${syntheticOpenAiToken("P")}.txt`;
    writeFileSync(join(repo, secretFilename), "no secret in file contents\n", "utf8");
    execFileSync("git", ["add", secretFilename], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "secondary ref only"], { cwd: repo });
    execFileSync("git", ["checkout", "-q", defaultBranch], { cwd: repo });

    const audit = auditReachableGitHistory(repo);
    expect(audit.reachable_commit_count).toBe(2);
    expect(audit.findings).toContainEqual(expect.objectContaining({
      path: expect.stringMatching(/^\[REDACTED_PATH:[0-9a-f]{16}\]$/),
      pattern_class: "openai_project_key",
    }));
    expect(JSON.stringify(audit)).not.toContain(secretFilename);
  });

  it("fails before unbounded commit, unique-blob, or blob-reference growth", () => {
    const repo = temporaryRepo();
    writeFileSync(join(repo, "first.txt"), "first\n", "utf8");
    execFileSync("git", ["add", "first.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "first"], { cwd: repo });
    writeFileSync(join(repo, "second.txt"), "second\n", "utf8");
    execFileSync("git", ["add", "second.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "second"], { cwd: repo });
    execFileSync("git", ["branch", "extra-ref", "HEAD~1"], { cwd: repo });

    expect(() => auditReachableGitHistory(repo, {
      limits: { maxReachableCommits: 1 },
    })).toThrow(/reachable-commit limit/);
    expect(() => auditReachableGitHistory(repo, {
      limits: { maxReachableRefs: 1 },
    })).toThrow(/reachable-ref limit/);
    expect(() => auditReachableGitHistory(repo, {
      limits: { maxUniqueBlobs: 1 },
    })).toThrow(/unique-blob limit/);
    expect(() => auditReachableGitHistory(repo, {
      limits: { maxBlobReferences: 1 },
    })).toThrow(/blob-reference limit/);

    const metadataCapped = auditReachableGitHistory(repo, {
      limits: { maxMetadataObjectBytes: 1 },
    });
    expect(metadataCapped.complete).toBe(false);
    expect(metadataCapped.findings).toContainEqual(expect.objectContaining({
      path: "[COMMIT_METADATA]",
      pattern_class: "historical_metadata_object_too_large",
    }));
  });

  it("scans commit messages, annotated tag messages, and sensitive ref names without echoing them", () => {
    const repo = temporaryRepo();
    const commitSecret = syntheticOpenAiToken("C");
    const tagSecret = syntheticOpenAiToken("G");
    const messagePath = join(tmpdir(), `hacc-commit-message-${process.pid}-${Date.now()}`);
    const tagMessagePath = join(tmpdir(), `hacc-tag-message-${process.pid}-${Date.now()}`);
    try {
      writeFileSync(join(repo, "safe.txt"), "safe\n", "utf8");
      writeFileSync(messagePath, `historical marker ${commitSecret}\n`, "utf8");
      execFileSync("git", ["add", "safe.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-qF", messagePath], { cwd: repo });
      writeFileSync(join(repo, "safe.txt"), "still safe\n", "utf8");
      execFileSync("git", ["commit", "-qam", "clean head"], { cwd: repo });

      writeFileSync(tagMessagePath, `tag marker ${tagSecret}\n`, "utf8");
      execFileSync("git", ["tag", "-a", "metadata-fixture", "-F", tagMessagePath], { cwd: repo });
      execFileSync("git", ["branch", "caller@example.test"], { cwd: repo });

      const audit = auditReachableGitHistory(repo);
      expect(audit.complete).toBe(true);
      expect(audit.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: "[COMMIT_METADATA]",
          pattern_class: "openai_project_key",
        }),
        expect.objectContaining({
          path: "[TAG_METADATA]",
          pattern_class: "openai_project_key",
        }),
        expect.objectContaining({
          path: expect.stringMatching(/^\[REDACTED_PATH:[0-9a-f]{16}\]$/),
          pattern_class: "sensitive_value_in_path",
        }),
      ]));
      const report = JSON.stringify(audit);
      expect(report).not.toContain(commitSecret);
      expect(report).not.toContain(tagSecret);
      expect(report).not.toContain("caller@example.test");
    } finally {
      rmSync(messagePath, { force: true });
      rmSync(tagMessagePath, { force: true });
    }
  });

  it("fails closed when an annotated tag targets another tag instead of a commit", () => {
    const repo = temporaryRepo();
    writeFileSync(join(repo, "safe.txt"), "safe\n", "utf8");
    execFileSync("git", ["add", "safe.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
    execFileSync("git", ["tag", "-a", "inner", "-m", "inner tag"], { cwd: repo });
    execFileSync("git", ["tag", "-a", "outer", "inner", "-m", "outer tag"], {
      cwd: repo,
      stdio: "ignore",
    });
    execFileSync("git", ["tag", "-d", "inner"], { cwd: repo, stdio: "ignore" });

    const audit = auditReachableGitHistory(repo);
    expect(audit.complete).toBe(false);
    expect(audit.pass).toBe(false);
    expect(audit.findings).toContainEqual(expect.objectContaining({
      path: "[TAG_METADATA]",
      pattern_class: "historical_noncommit_tag_target",
    }));
  });

  it("rejects replacement refs instead of allowing them to hide original reachable bytes", () => {
    const repo = temporaryRepo();
    const token = syntheticOpenAiToken("R");
    writeFileSync(join(repo, "historical.txt"), token, "utf8");
    execFileSync("git", ["add", "historical.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "secret fixture"], { cwd: repo });
    const replacedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

    writeFileSync(join(repo, "historical.txt"), "clean\n", "utf8");
    execFileSync("git", ["commit", "-qam", "clean head"], { cwd: repo });
    const cleanTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const replacementCommit = execFileSync("git", ["commit-tree", cleanTree, "-m", "replacement"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["replace", replacedCommit, replacementCommit], { cwd: repo });

    let message = "";
    try {
      auditReachableGitHistory(repo);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/refuses replacement refs/);
    expect(message).not.toContain(token);
  });

  it("rejects legacy grafts and shallow boundaries that can sever parent history", () => {
    const grafted = temporaryRepo();
    writeFileSync(join(grafted, "first.txt"), "first\n", "utf8");
    execFileSync("git", ["add", "first.txt"], { cwd: grafted });
    execFileSync("git", ["commit", "-qm", "first"], { cwd: grafted });
    writeFileSync(join(grafted, "second.txt"), "second\n", "utf8");
    execFileSync("git", ["add", "second.txt"], { cwd: grafted });
    execFileSync("git", ["commit", "-qm", "second"], { cwd: grafted });
    const graftHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: grafted,
      encoding: "utf8",
    }).trim();
    mkdirSync(join(grafted, ".git", "info"), { recursive: true });
    writeFileSync(join(grafted, ".git", "info", "grafts"), `${graftHead}\n`, "ascii");
    expect(() => auditReachableGitHistory(grafted)).toThrow(/refuses legacy grafts/);

    const shallow = temporaryRepo();
    writeFileSync(join(shallow, "safe.txt"), "safe\n", "utf8");
    execFileSync("git", ["add", "safe.txt"], { cwd: shallow });
    execFileSync("git", ["commit", "-qm", "safe"], { cwd: shallow });
    const shallowHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: shallow,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(shallow, ".git", "shallow"), `${shallowHead}\n`, "ascii");
    expect(() => auditReachableGitHistory(shallow)).toThrow(/refuses a shallow repository/);
  });
});

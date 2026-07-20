import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditPublishableWorkingTree } from "../../scripts/working-tree-secret-audit";
import { safeReportedPath } from "../public-release-secret-rules";

const temporaryRepos: string[] = [];

function syntheticOpenAiToken(seed = "A"): string {
  return ["sk", "-proj-", seed.repeat(48)].join("");
}

function emptyAllowlist(): string {
  return `${JSON.stringify({ schema_version: 1, entries: [] }, null, 2)}\n`;
}

function temporaryRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "hacc-worktree-secret-audit-"));
  temporaryRepos.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Security Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "security@example.test"], { cwd: repo });
  mkdirSync(join(repo, ".security"));
  writeFileSync(join(repo, ".security/public-secret-audit-allowlist.json"), emptyAllowlist());
  writeFileSync(join(repo, "safe.txt"), "safe public fixture\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  return repo;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeAllowlist(repo: string, entries: unknown[]): void {
  writeFileSync(
    join(repo, ".security/public-secret-audit-allowlist.json"),
    `${JSON.stringify({ schema_version: 1, entries }, null, 2)}\n`,
    "utf8"
  );
}

describe("public working-tree secret audit", () => {
  afterEach(() => {
    for (const repo of temporaryRepos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  it("scans modified tracked and non-ignored untracked files while accounting for deletions", () => {
    const repo = temporaryRepo();
    writeFileSync(join(repo, "deleted.txt"), "removed before release\n", "utf8");
    execFileSync("git", ["add", "deleted.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "add deletion fixture"], { cwd: repo });
    rmSync(join(repo, "deleted.txt"));

    const trackedSecret = syntheticOpenAiToken("T");
    const untrackedSecret = syntheticOpenAiToken("U");
    writeFileSync(join(repo, "safe.txt"), `modified=${trackedSecret}\n`, "utf8");
    writeFileSync(join(repo, "new.txt"), `untracked=${untrackedSecret}\n`, "utf8");

    const audit = auditPublishableWorkingTree(repo);
    expect(audit).toMatchObject({
      complete: true,
      pass: false,
      inventory_contract: "tracked_plus_nonignored_untracked",
      ignored_files_scanned: false,
      deleted_tracked_file_count: 1,
      finding_count: 2,
    });
    expect(audit.unresolved_findings).toEqual([
      { path: "new.txt", source: "untracked", finding_class: "openai_project_key" },
      { path: "safe.txt", source: "tracked", finding_class: "openai_project_key" },
    ]);
    const report = JSON.stringify(audit);
    expect(report).not.toContain(trackedSecret);
    expect(report).not.toContain(untrackedSecret);
  });

  it("ignores ambient Git routing that could substitute a clean index for unsafe bytes", () => {
    const unsafe = temporaryRepo();
    const clean = temporaryRepo();
    const token = syntheticOpenAiToken("G");
    writeFileSync(join(unsafe, "unsafe.txt"), token, "utf8");
    execFileSync("git", ["add", "unsafe.txt"], { cwd: unsafe });
    execFileSync("git", ["commit", "-qm", "unsafe fixture"], { cwd: unsafe });

    const prior = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    };
    try {
      process.env.GIT_DIR = join(clean, ".git");
      process.env.GIT_INDEX_FILE = join(clean, ".git", "index");
      process.env.GIT_WORK_TREE = unsafe;
      const audit = auditPublishableWorkingTree(unsafe);
      expect(audit.pass).toBe(false);
      expect(audit.unresolved_findings).toContainEqual({
        path: "unsafe.txt",
        source: "tracked",
        finding_class: "openai_project_key",
      });
      expect(JSON.stringify(audit)).not.toContain(token);
    } finally {
      for (const [name, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("treats ignored local env files as outside the publishable inventory without reading them", () => {
    const repo = temporaryRepo();
    writeFileSync(join(repo, ".gitignore"), ".env*\n", "utf8");
    execFileSync("git", ["add", ".gitignore"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "ignore local environments"], { cwd: repo });
    const ignoredSecret = syntheticOpenAiToken("I");
    writeFileSync(join(repo, ".env.local"), `OPENAI_API_KEY=${ignoredSecret}\n`, "utf8");

    const audit = auditPublishableWorkingTree(repo);
    expect(audit.pass).toBe(true);
    expect(audit.ignored_files_scanned).toBe(false);
    expect(audit.untracked_file_count).toBe(0);
    expect(JSON.stringify(audit)).not.toContain(ignoredSecret);
  });

  it("fails closed on sensitive env, recording, and customer-data publishable paths", () => {
    const repo = temporaryRepo();
    mkdirSync(join(repo, "recordings"));
    mkdirSync(join(repo, "exports"));
    writeFileSync(join(repo, ".env.production"), "SAFE_PLACEHOLDER=\n", "utf8");
    writeFileSync(join(repo, "recordings/call.wav"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(repo, "exports/customer-data.csv"), "id,status\n1,test\n", "utf8");

    const audit = auditPublishableWorkingTree(repo);
    expect(audit.complete).toBe(true);
    expect(audit.pass).toBe(false);
    expect(audit.unresolved_findings).toEqual(expect.arrayContaining([
      { path: ".env.production", source: "untracked", finding_class: "private_environment_file" },
      {
        path: expect.stringMatching(/^\[REDACTED_PATH:[0-9a-f]{16}\]$/),
        source: "untracked",
        finding_class: "customer_or_runtime_data",
      },
      {
        path: expect.stringMatching(/^\[REDACTED_PATH:[0-9a-f]{16}\]$/),
        source: "untracked",
        finding_class: "recording_or_transcript_data",
      },
    ]));
  });

  it("rejects and redacts plain-text transcripts, video recordings, and text exports by path", () => {
    const repo = temporaryRepo();
    mkdirSync(join(repo, "transcripts"));
    mkdirSync(join(repo, "recordings"));
    mkdirSync(join(repo, "exports"));
    const transcript = "transcripts/member-Alice-call.md";
    const recording = "recordings/member-Alice-call.mp4";
    const customerExport = "exports/customer-Jane_Doe-data.txt";
    writeFileSync(join(repo, transcript), "synthetic transcript\n", "utf8");
    writeFileSync(join(repo, recording), Buffer.from([0, 1, 2]));
    writeFileSync(join(repo, customerExport), "synthetic export\n", "utf8");

    const audit = auditPublishableWorkingTree(repo);
    expect(audit.complete).toBe(true);
    expect(audit.pass).toBe(false);
    expect(audit.unresolved_findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: expect.stringMatching(/^\[REDACTED_PATH:[0-9a-f]{16}\]$/),
        finding_class: "recording_or_transcript_data",
      }),
      expect.objectContaining({
        path: expect.stringMatching(/^\[REDACTED_PATH:[0-9a-f]{16}\]$/),
        finding_class: "customer_or_runtime_data",
      }),
    ]));
    const report = JSON.stringify(audit);
    expect(report).not.toContain("Alice");
    expect(report).not.toContain("Jane_Doe");
  });

  it("redacts a credential embedded in a publishable filename", () => {
    const repo = temporaryRepo();
    const secretFilename = `${syntheticOpenAiToken("N")}.txt`;
    writeFileSync(join(repo, secretFilename), "safe body\n", "utf8");

    const audit = auditPublishableWorkingTree(repo);
    expect(audit.pass).toBe(false);
    expect(audit.unresolved_findings).toContainEqual({
      path: expect.stringMatching(/^\[REDACTED_PATH:[0-9a-f]{16}\]$/),
      source: "untracked",
      finding_class: "openai_project_key",
    });
    expect(JSON.stringify(audit)).not.toContain(secretFilename);
  });

  it("detects a populated domain-specific telephony receipt secret without reporting it", () => {
    const repo = temporaryRepo();
    const secret = Buffer.from("independent-telephony-receipt-key-material-123456", "utf8")
      .toString("base64");
    writeFileSync(
      join(repo, "deployment.env.txt"),
      `TELEPHONY_RECEIPT_SECRET=${secret}\n`,
      "utf8"
    );

    const audit = auditPublishableWorkingTree(repo);
    expect(audit.pass).toBe(false);
    expect(audit.unresolved_findings).toContainEqual({
      path: "deployment.env.txt",
      source: "untracked",
      finding_class: "provider_secret_assignment",
    });
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it("detects named provider secrets in env, YAML, JSON, and source assignment syntax", () => {
    const repo = temporaryRepo();
    const token = "a1b2c3d4".repeat(4);
    writeFileSync(join(repo, "deployment.env.txt"), `TWILIO_AUTH_TOKEN=${token}\n`, "utf8");
    writeFileSync(join(repo, "deployment.yaml"), `TWILIO_AUTH_TOKEN: \"${token}\"\n`, "utf8");
    writeFileSync(join(repo, "deployment.json"), `{\"TWILIO_AUTH_TOKEN\":\"${token}\"}\n`, "utf8");
    writeFileSync(join(repo, "deployment.ts"), `export const TWILIO_AUTH_TOKEN = \"${token}\";\n`, "utf8");
    writeFileSync(join(repo, "Dockerfile.fixture"), `ENV TWILIO_AUTH_TOKEN=${token}\n`, "utf8");

    const audit = auditPublishableWorkingTree(repo);
    expect(audit.pass).toBe(false);
    expect(audit.unresolved_findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "deployment.env.txt", finding_class: "provider_secret_assignment" }),
      expect.objectContaining({ path: "deployment.yaml", finding_class: "provider_secret_assignment" }),
      expect.objectContaining({ path: "deployment.json", finding_class: "provider_secret_assignment" }),
      expect.objectContaining({ path: "deployment.ts", finding_class: "provider_secret_assignment" }),
      expect.objectContaining({ path: "Dockerfile.fixture", finding_class: "provider_secret_assignment" }),
    ]));
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("redacts obvious PII, URL userinfo, phone numbers, and control characters in paths", () => {
    for (const unsafePath of [
      "exports/caller@example.test.csv",
      "capture-https://user:password@example.test.har",
      "recordings/+14155550100.wav",
      "exports/caller\nrecord.csv",
    ]) {
      expect(safeReportedPath(unsafePath)).toMatch(/^\[REDACTED_PATH:[0-9a-f]{16}\]$/);
      expect(safeReportedPath(unsafePath)).not.toContain(unsafePath);
    }
    expect(safeReportedPath("docs/public-release-security.md"))
      .toBe("docs/public-release-security.md");
  });

  it("bounds binary reads and never includes binary secret bytes in its report", () => {
    const repo = temporaryRepo();
    const secret = syntheticOpenAiToken("B");
    const binary = Buffer.concat([Buffer.from([0]), Buffer.from(secret, "utf8"), Buffer.alloc(64, 255)]);
    writeFileSync(join(repo, "opaque.bin"), binary);

    const audit = auditPublishableWorkingTree(repo, {
      limits: {
        maxBinaryFileBytes: 16,
        maxTextFileBytes: 128,
        maxTotalScannedBytes: 4_096,
      },
    });
    expect(audit.complete).toBe(false);
    expect(audit.pass).toBe(false);
    expect(audit.unresolved_findings).toContainEqual({
      path: "opaque.bin",
      source: "untracked",
      finding_class: "binary_file_too_large",
    });
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it("reclassifies a late UTF-16 payload and enforces the binary cap on the full file", () => {
    const repo = temporaryRepo();
    const secret = syntheticOpenAiToken("L");
    const lateBinary = Buffer.concat([
      Buffer.alloc(8 * 1024, 65),
      Buffer.from(secret, "utf16le"),
    ]);
    writeFileSync(join(repo, "late-binary.dat"), lateBinary);

    const scanned = auditPublishableWorkingTree(repo, {
      limits: {
        maxBinaryFileBytes: 16 * 1024,
        maxTextFileBytes: 20 * 1024,
        maxTotalScannedBytes: 64 * 1024,
      },
    });
    expect(scanned.binary_file_count).toBe(1);
    expect(scanned.unresolved_findings).toContainEqual({
      path: "late-binary.dat",
      source: "untracked",
      finding_class: "openai_project_key",
    });
    expect(JSON.stringify(scanned)).not.toContain(secret);

    const capped = auditPublishableWorkingTree(repo, {
      limits: {
        maxBinaryFileBytes: 8 * 1024,
        maxTextFileBytes: 20 * 1024,
        maxTotalScannedBytes: 64 * 1024,
      },
    });
    expect(capped.complete).toBe(false);
    expect(capped.unresolved_findings).toContainEqual({
      path: "late-binary.dat",
      source: "untracked",
      finding_class: "binary_file_too_large",
    });
    expect(JSON.stringify(capped)).not.toContain(secret);
  });

  it("rejects symlinks and traversal-capable allowlist paths without following them", () => {
    const repo = temporaryRepo();
    const outside = join(tmpdir(), `hacc-outside-${process.pid}-${Date.now()}`);
    const secret = syntheticOpenAiToken("S");
    writeFileSync(outside, secret, "utf8");
    try {
      symlinkSync(outside, join(repo, "linked-secret"));
      const audit = auditPublishableWorkingTree(repo);
      expect(audit.complete).toBe(false);
      expect(audit.unresolved_findings).toContainEqual({
        path: "linked-secret",
        source: "untracked",
        finding_class: "symlink_not_publishable",
      });
      expect(JSON.stringify(audit)).not.toContain(secret);

      writeAllowlist(repo, [{
        id: "invalid-traversal-evidence",
        path: "../outside",
        sha256: "a".repeat(64),
        pattern_classes: ["openai_project_key"],
        reason: "Traversal must never be accepted as release evidence.",
      }]);
      expect(() => auditPublishableWorkingTree(repo)).toThrow(/invalid path/);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("allows only an exact path, file hash, and finding class with explicit evidence", () => {
    const repo = temporaryRepo();
    const firstSecret = syntheticOpenAiToken("E");
    writeFileSync(join(repo, "synthetic-fixture.txt"), firstSecret, "utf8");
    writeAllowlist(repo, [{
      id: "synthetic-openai-detector-fixture",
      path: "synthetic-fixture.txt",
      sha256: sha256(firstSecret),
      pattern_classes: ["openai_project_key"],
      reason: "Inert scanner test fixture reviewed for this exact file digest.",
    }]);

    const allowed = auditPublishableWorkingTree(repo);
    expect(allowed).toMatchObject({
      complete: true,
      pass: true,
      finding_count: 0,
      allowed_finding_count: 1,
      allowlist: { entry_count: 1, applied_entry_count: 1, unused_entry_ids: [] },
    });
    expect(JSON.stringify(allowed)).not.toContain(firstSecret);

    const changedSecret = syntheticOpenAiToken("F");
    writeFileSync(join(repo, "synthetic-fixture.txt"), changedSecret, "utf8");
    const changed = auditPublishableWorkingTree(repo);
    expect(changed.pass).toBe(false);
    expect(changed.finding_count).toBe(1);
    expect(changed.allowlist.unused_entry_ids).toEqual(["synthetic-openai-detector-fixture"]);
    expect(JSON.stringify(changed)).not.toContain(changedSecret);

    writeAllowlist(repo, [{
      id: "wrong-class-does-not-authorize",
      path: "synthetic-fixture.txt",
      sha256: sha256(changedSecret),
      pattern_classes: ["xai_api_key"],
      reason: "A different finding class must not authorize this fixture.",
    }]);
    const wrongClass = auditPublishableWorkingTree(repo);
    expect(wrongClass.pass).toBe(false);
    expect(wrongClass.finding_count).toBe(1);
    expect(wrongClass.allowlist.unused_entry_ids).toEqual(["wrong-class-does-not-authorize"]);
  });

  it("binds a deterministic manifest to path, source, size, and current bytes", () => {
    const repo = temporaryRepo();
    const first = auditPublishableWorkingTree(repo);
    const repeated = auditPublishableWorkingTree(repo);
    expect(first.head_commit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(first.head_tree).toMatch(/^[0-9a-f]{40,64}$/);
    expect(first.git_status_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(repeated.publishable_file_manifest_sha256)
      .toBe(first.publishable_file_manifest_sha256);
    expect(repeated.git_status_sha256).toBe(first.git_status_sha256);

    writeFileSync(join(repo, "safe.txt"), "changed but still safe\n", "utf8");
    const changed = auditPublishableWorkingTree(repo);
    expect(changed.publishable_file_manifest_sha256)
      .not.toBe(first.publishable_file_manifest_sha256);
    expect(changed.git_status_sha256).not.toBe(first.git_status_sha256);
  });
});

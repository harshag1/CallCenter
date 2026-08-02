import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const rootPackageUrl = new URL("../../../package.json", import.meta.url);
const firstRunUrl = new URL("../../../scripts/provider-free-first-run.mjs", import.meta.url);

describe("root provider-free first run", () => {
  it("provides a discoverable root command with a no-spend prerequisite check", () => {
    const metadata = JSON.parse(readFileSync(rootPackageUrl, "utf8")) as {
      private?: boolean;
      scripts?: Record<string, string>;
    };
    expect(metadata.private).toBe(true);
    expect(metadata.scripts?.["demo:offline"]).toBe("node scripts/provider-free-first-run.mjs");
    expect(metadata.scripts?.["flow:visualize"]).toBe("node scripts/provider-free-first-run.mjs --visualize");

    const output = execFileSync(process.execPath, [firstRunUrl.pathname, "--check"], {
      encoding: "utf8",
      env: { ...process.env, OPENAI_API_KEY: "must-not-appear" },
    });
    expect(output).toContain("Prerequisites: Node 20.19+, 22.13+, or 24+ and npm.");
    expect(output).toContain("Spend: $0 expected.");
    expect(output).toContain("READY:");
    expect(output).not.toContain("must-not-appear");
  });

  it("publishes the generic scenario runner used by the root command", () => {
    const webPackage = JSON.parse(readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf8",
    )) as { scripts?: Record<string, string> };
    expect(webPackage.scripts?.["flow:scenario"]).toBe("tsx scripts/flow-scenario.ts");

    const source = readFileSync(firstRunUrl, "utf8");
    expect(source).toContain("--flow and --scenario must be supplied together");
    expect(source).toContain("hacc-offline-install-");
    expect(source).toContain("package_lock_sha256");
  });

  it("renders deterministic private HTML and refuses to overwrite it", () => {
    const directory = mkdtempSync(join(tmpdir(), "hacc-flow-visualize-test-"));
    const flow = new URL("../../../examples/flows/membership-return-resolution.json", import.meta.url).pathname;
    const first = join(directory, "first.html");
    const second = join(directory, "second.html");
    const args = (out: string) => [
      firstRunUrl.pathname,
      "--visualize",
      "--skip-install",
      "--flow",
      flow,
      "--out",
      out,
    ];

    try {
      const output = execFileSync(process.execPath, args(first), {
        encoding: "utf8",
        env: { ...process.env, OPENAI_API_KEY: "must-not-appear" },
      });
      execFileSync(process.execPath, args(second), { encoding: "utf8" });
      const firstHtml = readFileSync(first, "utf8");
      expect(output).toContain('"provider_calls":0');
      expect(output).not.toContain("must-not-appear");
      expect(firstHtml).toBe(readFileSync(second, "utf8"));
      expect(firstHtml).toContain("Content-Security-Policy");
      expect(firstHtml).not.toContain("<script");
      expect(firstHtml).not.toContain("https://");
      if (process.platform !== "win32") expect(statSync(first).mode & 0o777).toBe(0o600);

      const overwrite = spawnSync(process.execPath, args(first), { encoding: "utf8" });
      expect(overwrite.status).not.toBe(0);
      expect(overwrite.stderr).toContain("refusing to overwrite existing file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
});

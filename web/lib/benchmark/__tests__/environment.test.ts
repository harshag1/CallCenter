import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  REDACTED_BENCHMARK_SECRET,
  parseBenchmarkEnvironmentFile,
  resolveBenchmarkEnvironment,
} from "../environment";

function missingFile(): NodeJS.ErrnoException {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

describe("benchmark environment resolution", () => {
  it("uses deliberate precedence without mutating the supplied or global environment", async () => {
    const explicitPath = "/private/selected.env";
    const files = new Map<string, string>([
      [explicitPath, "OPENAI_API_KEY=explicit-openai\n"],
      ["/workspace/.env", "OPENAI_API_KEY=workspace-openai\nXAI_API_KEY=workspace-xai\n"],
      ["/gpu/web/.env.local", "GEMINI_API_KEY=gpu-gemini\n"],
    ]);
    const suppliedEnvironment = Object.freeze({
      OPENAI_API_KEY: "ambient-openai",
      XAI_API_KEY: "ambient-xai",
    });
    const globalBefore = process.env.OPENAI_API_KEY;

    const resolved = await resolveBenchmarkEnvironment({
      names: ["OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY"],
      explicitEnvFiles: [explicitPath],
      environment: suppliedEnvironment,
      repositoryRoot: "/workspace",
      webRoot: "/workspace/web",
      gpuHubRoot: "/gpu",
      readTextFile: async (path) => {
        const contents = files.get(path);
        if (contents === undefined) throw missingFile();
        return contents;
      },
    });

    expect(resolved.require("OPENAI_API_KEY")).toBe("explicit-openai");
    expect(resolved.source("OPENAI_API_KEY")).toBe("explicit-env:1");
    expect(resolved.require("XAI_API_KEY")).toBe("ambient-xai");
    expect(resolved.source("XAI_API_KEY")).toBe("process-env");
    expect(resolved.require("GEMINI_API_KEY")).toBe("gpu-gemini");
    expect(resolved.source("GEMINI_API_KEY")).toBe("gpu-hub-web:.env.local");

    expect(suppliedEnvironment).toEqual({
      OPENAI_API_KEY: "ambient-openai",
      XAI_API_KEY: "ambient-xai",
    });
    expect(process.env.OPENAI_API_KEY).toBe(globalBefore);
  });

  it("serializes and inspects only redaction markers and stable source labels", async () => {
    const resolved = await resolveBenchmarkEnvironment({
      names: ["OPENAI_API_KEY", "GEMINI_API_KEY"],
      explicitEnvFiles: ["/secret/location/provider.env"],
      environment: {},
      repositoryRoot: "/workspace",
      gpuHubRoot: null,
      readTextFile: async (path) => {
        if (path === "/secret/location/provider.env") {
          return "OPENAI_API_KEY=sk-should-never-serialize\n";
        }
        throw missingFile();
      },
    });

    const description = resolved.describe();
    expect(description.secrets).toEqual([
      {
        name: "OPENAI_API_KEY",
        present: true,
        source: "explicit-env:1",
        value: REDACTED_BENCHMARK_SECRET,
      },
      {
        name: "GEMINI_API_KEY",
        present: false,
        source: null,
        value: null,
      },
    ]);

    for (const rendered of [JSON.stringify(resolved), inspect(resolved)]) {
      expect(rendered).not.toContain("sk-should-never-serialize");
      expect(rendered).not.toContain("/secret/location");
      expect(rendered).toContain("explicit-env:1");
    }
  });

  it("fails closed with source labels, not paths or parser contents", async () => {
    await expect(resolveBenchmarkEnvironment({
      names: ["OPENAI_API_KEY"],
      explicitEnvFiles: ["/secret/path/missing.env"],
      environment: {},
      repositoryRoot: "/workspace",
      gpuHubRoot: null,
      readTextFile: async () => {
        throw missingFile();
      },
    })).rejects.toThrow("Unable to read benchmark environment source explicit-env:1");

    await expect(resolveBenchmarkEnvironment({
      names: ["OPENAI_API_KEY"],
      explicitEnvFiles: ["/secret/path/malformed.env"],
      environment: {},
      repositoryRoot: "/workspace",
      gpuHubRoot: null,
      readTextFile: async () => "OPENAI_API_KEY=unterminated-secret\0ignored",
    })).rejects.toThrow("Unable to parse benchmark environment source explicit-env:1");
  });

  it("treats an invalid higher-priority value as authoritative instead of borrowing another account", async () => {
    await expect(resolveBenchmarkEnvironment({
      names: ["OPENAI_API_KEY"],
      explicitEnvFiles: ["/selected.env"],
      environment: { OPENAI_API_KEY: "ambient-would-be-dangerous" },
      repositoryRoot: "/workspace",
      gpuHubRoot: "/gpu",
      readTextFile: async (path) => {
        if (path === "/selected.env") return "OPENAI_API_KEY=\n";
        if (path === "/gpu/web/.env.local") return "OPENAI_API_KEY=gpu-would-be-dangerous\n";
        throw missingFile();
      },
    })).rejects.toThrow("Invalid benchmark environment variable OPENAI_API_KEY in source explicit-env:1");
  });

  it("ignores malformed shadowed duplicates after a higher-priority value wins", async () => {
    const resolved = await resolveBenchmarkEnvironment({
      names: ["OPENAI_API_KEY", "XAI_API_KEY"],
      explicitEnvFiles: ["/selected.env"],
      environment: {
        OPENAI_API_KEY: " malformed-shadowed-value ",
        XAI_API_KEY: "ambient-xai",
      },
      repositoryRoot: "/workspace",
      gpuHubRoot: null,
      readTextFile: async (path) => {
        if (path === "/selected.env") return "OPENAI_API_KEY=explicit-openai\n";
        throw missingFile();
      },
    });
    expect(resolved.require("OPENAI_API_KEY")).toBe("explicit-openai");
    expect(resolved.require("XAI_API_KEY")).toBe("ambient-xai");
  });

  it("never probes a sibling GPU Hub checkout unless its root is explicitly authorized", async () => {
    const observedPaths: string[] = [];
    const resolved = await resolveBenchmarkEnvironment({
      names: ["GEMINI_API_KEY"],
      environment: {},
      repositoryRoot: "/workspace",
      readTextFile: async (path) => {
        observedPaths.push(path);
        throw missingFile();
      },
    });
    expect(resolved.get("GEMINI_API_KEY")).toBeUndefined();
    expect(observedPaths).toEqual(["/workspace/.env", "/workspace/web/.env.local"]);
    expect(observedPaths.some((path) => path.includes("gpu-hub"))).toBe(false);
  });

  it("snapshots own ambient values before asynchronous file discovery", async () => {
    const environment: Record<string, string | undefined> = { XAI_API_KEY: "snapshot-value" };
    const inherited = Object.create({ GEMINI_API_KEY: "inherited-must-not-resolve" }) as Record<string, string>;
    inherited.XAI_API_KEY = environment.XAI_API_KEY!;

    const resolvedPromise = resolveBenchmarkEnvironment({
      names: ["XAI_API_KEY", "GEMINI_API_KEY"],
      environment: inherited,
      repositoryRoot: "/workspace",
      gpuHubRoot: "/gpu",
      readTextFile: async (path) => {
        await Promise.resolve();
        inherited.XAI_API_KEY = "mutated-during-await";
        if (path === "/gpu/web/.env.local") return "GEMINI_API_KEY=gpu-own-value\n";
        throw missingFile();
      },
    });
    const resolved = await resolvedPromise;

    expect(resolved.require("XAI_API_KEY")).toBe("snapshot-value");
    expect(resolved.require("GEMINI_API_KEY")).toBe("gpu-own-value");
  });

  it("resolves relative explicit files against cwd and preserves native parseEnv syntax", async () => {
    const observedPaths: string[] = [];
    const resolved = await resolveBenchmarkEnvironment({
      names: ["OPENAI_API_KEY", "XAI_API_KEY"],
      explicitEnvFiles: ["secrets/provider.env"],
      cwd: "/invocation",
      environment: {},
      repositoryRoot: "/workspace",
      gpuHubRoot: null,
      readTextFile: async (path) => {
        observedPaths.push(path);
        if (path === "/invocation/secrets/provider.env") {
          return "\uFEFFexport OPENAI_API_KEY=\"quoted#key=value\"\r\nXAI_API_KEY='$OPENAI_API_KEY'\r\nUNREQUESTED_SECRET=discard-me\r\n";
        }
        throw missingFile();
      },
    });

    expect(observedPaths[0]).toBe("/invocation/secrets/provider.env");
    expect(resolved.require("OPENAI_API_KEY")).toBe("quoted#key=value");
    expect(resolved.require("XAI_API_KEY")).toBe("$OPENAI_API_KEY");
    expect(Object.keys(resolved)).toEqual([]);
    expect({ ...resolved }).toEqual({});
    expect(JSON.stringify(resolved)).not.toContain("discard-me");
  });

  it("keeps Node 20.9 compatibility without mutating globals when util.parseEnv is unavailable", () => {
    const contents = [
      "# provider credentials",
      "export OPENAI_API_KEY=\"quoted#key=value\"",
      "XAI_API_KEY='$OPENAI_API_KEY'",
      "MULTILINE=\"first\\nsecond\"",
      "",
    ].join("\r\n");
    expect(parseBenchmarkEnvironmentFile(contents, null)).toEqual({
      OPENAI_API_KEY: "quoted#key=value",
      XAI_API_KEY: "$OPENAI_API_KEY",
      MULTILINE: "first\nsecond",
    });
  });

  it("does not hide permission failures in fallback sources", async () => {
    await expect(resolveBenchmarkEnvironment({
      names: ["GEMINI_API_KEY"],
      environment: {},
      repositoryRoot: "/workspace",
      gpuHubRoot: null,
      readTextFile: async (path) => {
        if (path === "/workspace/.env") {
          throw Object.assign(new Error("permission denied at /workspace/.env"), { code: "EACCES" });
        }
        throw missingFile();
      },
    })).rejects.toThrow("Unable to read benchmark environment source workspace:.env");
  });
});

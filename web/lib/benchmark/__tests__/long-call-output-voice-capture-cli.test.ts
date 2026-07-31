import {
  chmod,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProviderCredentials,
  parseOutputVoiceCaptureArguments,
} from "../../../scripts/long-call-output-voice-capture";

const roots: string[] = [];
const SHA = "a".repeat(64);

function commonArgs(): string[] {
  return [
    "node",
    "/repo/web/scripts/long-call-output-voice-capture.ts",
    "--output-root", "/tmp/capture-root",
    "--capture-private-key", "/tmp/capture-key.pem",
    "--capture-key-id", "capture-authority-1",
    "--expected-capture-authority-sha256", SHA,
  ];
}

async function privateEnv(root: string, name: string, content: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("output-voice capture credential CLI", () => {
  it("accepts either one combined file or exactly three provider-specific files", () => {
    const combined = parseOutputVoiceCaptureArguments([
      ...commonArgs(),
      "--provider-env-file", "/tmp/providers.env",
    ]);
    expect(combined.providerEnvironment).toEqual({ mode: "combined", path: "/tmp/providers.env" });

    const split = parseOutputVoiceCaptureArguments([
      ...commonArgs(),
      "--openai-env-file", "/tmp/openai.env",
      "--gemini-env-file", "/tmp/gemini.env",
      "--xai-env-file", "/tmp/xai.env",
    ]);
    expect(split.providerEnvironment).toEqual({
      mode: "split",
      paths: { openai: "/tmp/openai.env", gemini: "/tmp/gemini.env", xai: "/tmp/xai.env" },
    });
  });

  it("rejects mixed and incomplete provider credential modes", () => {
    expect(() => parseOutputVoiceCaptureArguments([
      ...commonArgs(),
      "--provider-env-file", "/tmp/providers.env",
      "--openai-env-file", "/tmp/openai.env",
      "--gemini-env-file", "/tmp/gemini.env",
      "--xai-env-file", "/tmp/xai.env",
    ])).toThrow("either --provider-env-file or exactly all three");
    expect(() => parseOutputVoiceCaptureArguments([
      ...commonArgs(),
      "--openai-env-file", "/tmp/openai.env",
      "--gemini-env-file", "/tmp/gemini.env",
    ])).toThrow("either --provider-env-file or exactly all three");
  });

  it("reads only each provider's requested key from separate private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-output-voice-env-"));
    roots.push(root);
    const paths = {
      openai: await privateEnv(root, "openai.env", "OPENAI_API_KEY=openai_requested_123\nXAI_API_KEY=wrong_xai_value\n"),
      gemini: await privateEnv(root, "gemini.env", "GEMINI_API_KEY=gemini_requested_123\nOPENAI_API_KEY=wrong_openai_value\n"),
      xai: await privateEnv(root, "xai.env", "XAI_API_KEY=xai_requested_value_123\nGEMINI_API_KEY=wrong_gemini_value\n"),
    };
    await expect(loadProviderCredentials({ mode: "split", paths })).resolves.toEqual({
      openai: "openai_requested_123",
      gemini: "gemini_requested_123",
      xai: "xai_requested_value_123",
    });
  });

  it("rejects permissive files and symlinks before credential parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "hacc-output-voice-env-"));
    roots.push(root);
    const permissive = join(root, "providers.env");
    await writeFile(permissive, "OPENAI_API_KEY=not_read\n", { mode: 0o644 });
    await chmod(permissive, 0o644);
    await expect(loadProviderCredentials({ mode: "combined", path: permissive })).rejects.toThrow("mode 0600");

    const target = await privateEnv(root, "target.env", "OPENAI_API_KEY=not_read\n");
    const link = join(root, "providers-link.env");
    await symlink(target, link);
    await expect(loadProviderCredentials({ mode: "combined", path: link })).rejects.toThrow("regular non-symlink");
  });
});

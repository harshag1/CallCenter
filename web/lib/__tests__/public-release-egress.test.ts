import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PUBLIC_RELEASE_EGRESS_FLAGS,
  publicReleaseEgressEnabled,
} from "../public-release-egress";
import {
  cleanupToolProject,
  deployTool,
  prepareToolInvocation,
} from "../toolfactory/deploy";
import { defaultRemoteMcpEndpointPolicy } from "../remote-mcp-runtime";

describe("public-release optional egress boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("requires the global acknowledgement and exact capability flag in production", () => {
    for (const capability of Object.keys(PUBLIC_RELEASE_EGRESS_FLAGS) as
      (keyof typeof PUBLIC_RELEASE_EGRESS_FLAGS)[]) {
      const specific = PUBLIC_RELEASE_EGRESS_FLAGS[capability];
      expect(publicReleaseEgressEnabled(capability, {
        NODE_ENV: "production",
        HACC_ENABLE_EXTERNAL_EGRESS: "true",
      })).toBe(false);
      expect(publicReleaseEgressEnabled(capability, {
        NODE_ENV: "production",
        [specific]: "true",
      })).toBe(false);
      expect(publicReleaseEgressEnabled(capability, {
        NODE_ENV: "production",
        HACC_ENABLE_EXTERNAL_EGRESS: "true",
        [specific]: "true",
      })).toBe(true);
      expect(publicReleaseEgressEnabled(capability, {
        HACC_ENABLE_EXTERNAL_EGRESS: "true",
        [specific]: "true",
      })).toBe(true);
      expect(publicReleaseEgressEnabled(capability, {})).toBe(false);
    }
  });

  it("blocks generated deployment before credential reads or Vercel network access", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HACC_ENABLE_EXTERNAL_EGRESS", "");
    vi.stubEnv("HACC_ENABLE_GENERATED_TOOL_DEPLOYMENT_EGRESS", "");
    vi.stubEnv("VERCEL_TOKEN", "must-not-be-used");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(deployTool("lookup", "export default {}", {
      project: "hacc-tool-v2-aaaaaaaaaaaaaaaaaaaa",
    })).rejects.toThrow("optional external egress is disabled (generatedToolDeployment)");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(cleanupToolProject(
      "hacc-tool-v2-aaaaaaaaaaaaaaaaaaaa"
    )).rejects.toThrow("optional external egress is disabled (generatedToolDeployment)");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks generated invocation before signer validation, assertion creation, or fetch", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HACC_ENABLE_EXTERNAL_EGRESS", "");
    vi.stubEnv("HACC_ENABLE_GENERATED_TOOL_INVOCATION_EGRESS", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => prepareToolInvocation(
      "https://tool.vercel.app/api/run",
      { account: "123" },
      undefined
    )).toThrow("optional external egress is disabled (generatedToolInvocation)");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps remote MCP egress closed when the deployment environment is missing or unknown", async () => {
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("MCP_EGRESS_NETWORK_GUARD", "private-ranges-blocked");
    vi.stubEnv("MCP_EGRESS_ALLOWED_HOSTS", "mcp.example.test");

    await expect(defaultRemoteMcpEndpointPolicy(
      new URL("https://mcp.example.test/rpc")
    )).resolves.toBe(false);
  });
});

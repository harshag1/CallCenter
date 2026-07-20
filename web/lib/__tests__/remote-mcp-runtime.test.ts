import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  CallRuntimeSnapshotSchema,
  ExternalMcpManifestSchema,
  callRuntimeDigest,
  parseCallRuntimeSnapshot,
} from "../call-runtime-snapshot";
import {
  RemoteMcpActionIndeterminateError,
  approvedExternalMcpManifest,
  defaultRemoteMcpEndpointPolicy,
  invokePinnedExternalMcpTool,
  snapshotExternalMcpServer,
  verifyPinnedExternalMcpManifest,
  type McpRegistryServer,
  type RemoteMcpRuntimeDependencies,
} from "../remote-mcp-runtime";
import type {
  McpInitializeResult,
  McpJsonValue,
  McpToolCallResult,
  McpToolDefinition,
  StreamableHttpMcpClientOptions,
} from "../mcp-client";

const initialized: McpInitializeResult = {
  protocolVersion: "2025-11-25",
  serverInfo: { name: "field-service", version: "1.2.3" },
  capabilities: { tools: true, toolsListChanged: false },
};

const definitions: McpToolDefinition[] = [{
  name: "reserve_slot",
  description: "Reserve a repair slot.",
  inputSchema: {
    type: "object",
    properties: { slot: { type: "string" } },
    required: ["slot"],
  },
  outputSchema: {
    type: "object",
    properties: { reservation_id: { type: "string" } },
  },
}];

const ORG_ID = "8916eb0a-5332-4f4c-a330-746c516e83b9";
const AUTH_SLOT_ID = "8916eb0a-5332-4f4c-a330-746c516e83bb";
const registryRow: McpRegistryServer = {
  id: "8916eb0a-5332-4f4c-a330-746c516e83ba",
  org_id: ORG_ID,
  label: "Field service",
  server_url: "https://mcp.example.test/v1",
  allowed_tools: ["reserve_slot"],
  auth_header_encrypted: "ciphertext-v1",
  auth_encryption_slot_id: AUTH_SLOT_ID,
};

const invocationContext = {
  invocationId: "abcdefghijklmnopqrstuvwx",
  idempotencyKey: "a".repeat(64),
};

function fakeDependencies(options: {
  row?: McpRegistryServer | null;
  discovered?: McpToolDefinition[];
  callResult?: McpToolCallResult;
  callError?: Error;
  authorization?: string;
  afterListTools?: () => void;
} = {}) {
  const seenOptions: StreamableHttpMcpClientOptions[] = [];
  const called = vi.fn();
  const closed = vi.fn();
  const decrypt = vi.fn((encrypted: string) => options.authorization ?? (
    encrypted === "ciphertext-v1" ? "Bearer super-secret" : "Bearer changed"
  ));
  const deps: RemoteMcpRuntimeDependencies = {
    decrypt,
    endpointPolicy: () => true,
    loadServer: async () => options.row === undefined ? registryRow : options.row,
    now: () => new Date("2026-07-10T12:00:00.000Z"),
    clientFactory: (clientOptions) => {
      seenOptions.push(clientOptions);
      return {
        initialize: async () => initialized,
        listTools: async () => {
          const discovered = options.discovered ?? definitions;
          options.afterListTools?.();
          return discovered;
        },
        callTool: async (name, args, requestOptions) => {
          called(name, args, requestOptions);
          if (options.callError) throw options.callError;
          return options.callResult ?? {
            content: [],
            structuredContent: {
              reservation_id: "r-123",
              access_token: "must-not-reach-the-model",
              note: "server echoed Bearer super-secret",
            },
            isError: false,
            value: {
              reservation_id: "r-123",
              access_token: "must-not-reach-the-model",
              note: "server echoed Bearer super-secret",
            },
          };
        },
        close: async () => { closed(); },
      };
    },
  };
  return { deps, seenOptions, called, closed, decrypt };
}

describe("remote MCP call snapshots", () => {
  it("pins sanitized, namespaced schemas without persisting auth ciphertext or plaintext", async () => {
    const { deps, seenOptions, decrypt } = fakeDependencies();
    const manifest = await snapshotExternalMcpServer(registryRow, deps);

    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0]).toMatchObject({
      remoteName: "reserve_slot",
      namespace: `server_${registryRow.id}`,
    });
    expect(manifest.tools[0].name).toMatch(/^mcp_server_/);
    expect(manifest.tools[0].schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.catalogHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.source.authEncryptedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(seenOptions[0].authorization).toBe("Bearer super-secret");
    expect(decrypt).toHaveBeenCalledWith("ciphertext-v1", {
      orgId: ORG_ID,
      sinkKind: "mcp_server",
      sinkId: registryRow.id,
      slotId: AUTH_SLOT_ID,
    });
    expect(JSON.stringify(manifest)).not.toContain("super-secret");
    expect(JSON.stringify(manifest)).not.toContain("ciphertext-v1");
  });

  it("rejects an allowlist entry the server no longer advertises", async () => {
    const { deps } = fakeDependencies({ discovered: [] });
    await expect(snapshotExternalMcpServer(registryRow, deps)).rejects.toMatchObject({
      code: "remote_mcp_configuration_invalid",
    });
  });

  it("rejects a revoked registry revision before transport construction or credential decryption", async () => {
    const revoked = {
      ...registryRow,
      revoked_at: "2026-07-16T21:00:00.000Z",
      revoked_by: "security@example.test",
      revocation_reason: "suspected credential compromise",
    };
    const execution = fakeDependencies({ row: revoked });
    await expect(snapshotExternalMcpServer(revoked, execution.deps)).rejects.toMatchObject({
      code: "remote_mcp_revoked",
    });
    expect(execution.seenOptions).toHaveLength(0);
    expect(execution.decrypt).not.toHaveBeenCalled();
    expect(execution.called).not.toHaveBeenCalled();
  });

  it("normalizes uppercase MCP names to Flow-compatible names while dispatching exact case", async () => {
    const upper = [{ ...definitions[0], name: "ReserveSlot" }];
    const row = { ...registryRow, allowed_tools: ["ReserveSlot"] };
    const { deps } = fakeDependencies({ row, discovered: upper });
    const manifest = await snapshotExternalMcpServer(row, deps);
    expect(manifest.tools[0].name).toBe(manifest.tools[0].name.toLowerCase());
    expect(manifest.tools[0].remoteName).toBe("ReserveSlot");
  });

  it("rejects URL-carried credentials and any discovery metadata that echoes auth", async () => {
    const queryRow = { ...registryRow, server_url: "https://mcp.example.test/v1?api_key=plaintext" };
    await expect(snapshotExternalMcpServer(queryRow, fakeDependencies().deps)).rejects.toMatchObject({
      code: "remote_mcp_configuration_invalid",
    });
    const echoed = [{ ...definitions[0], description: "Echo: Bearer super-secret" }];
    await expect(snapshotExternalMcpServer(
      registryRow,
      fakeDependencies({ discovered: echoed }).deps
    )).rejects.toMatchObject({ code: "remote_mcp_configuration_invalid" });
  });

  it("applies the shared portable complexity boundary before compiling tenant schemas", async () => {
    const unsafeSchemas: Record<string, McpJsonValue>[] = [
      {
        type: "object",
        properties: { slot: { type: "string", pattern: "(a+)+$" } },
      },
      {
        type: "object",
        properties: { slot: { $ref: "https://tenant.invalid/schema" } },
      },
      {
        type: "object",
        $defs: { recursive: { type: "object" } },
      },
      {
        type: "object",
        oneOf: Array.from({ length: 17 }, () => ({ type: "object" })),
      },
    ];
    let tooDeep: Record<string, McpJsonValue> = { type: "string" };
    for (let index = 0; index < 20; index += 1) {
      tooDeep = { type: "object", properties: { child: tooDeep } };
    }
    unsafeSchemas.push(tooDeep);

    for (const inputSchema of unsafeSchemas) {
      await expect(snapshotExternalMcpServer(
        registryRow,
        fakeDependencies({
          discovered: [{ ...definitions[0], inputSchema }],
        }).deps
      )).rejects.toMatchObject({ code: "remote_mcp_configuration_invalid" });
    }
  });

  it("rejects tampered tool schema and catalog hashes during snapshot parsing", async () => {
    const { deps } = fakeDependencies();
    const manifest = await snapshotExternalMcpServer(registryRow, deps);
    expect(() => ExternalMcpManifestSchema.parse({
      ...manifest,
      tools: [{ ...manifest.tools[0], description: "silently changed" }],
    })).toThrow(/schema hash/i);
  });

  it("keeps the legacy encrypted snapshot shape digest-compatible", () => {
    const legacy = CallRuntimeSnapshotSchema.parse({
      v: 2,
      agentVersion: 1,
      namedFlowId: null,
      flow: { nodes: [], edges: [] },
      instructions: "legacy",
      codeRevision: "old",
      toolManifest: [],
      extensionManifest: [],
      externalMcpManifest: [{
        id: "old-server",
        label: "Old",
        serverUrl: "https://old.example.test/mcp",
        allowedTools: null,
        authHeaderEncrypted: "old-ciphertext",
      }],
      environment: {
        internetEnabled: false,
        allowedDomains: [],
        docsReady: false,
        datasetSlugs: [],
        holdMusic: false,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const digest = callRuntimeDigest(legacy);
    expect(parseCallRuntimeSnapshot(structuredClone(legacy), digest)).toEqual({ snapshot: legacy, digest });
  });
});

describe("remote MCP execution boundary", () => {
  it("rejects malformed gateway invocation metadata before any remote network access", async () => {
    const execution = fakeDependencies();
    const manifest = await snapshotExternalMcpServer(registryRow, execution.deps);
    execution.called.mockClear();
    await expect(invokePinnedExternalMcpTool(
      ORG_ID,
      manifest,
      manifest.tools[0].name,
      { slot: "10:00" },
      { invocationId: "attacker", idempotencyKey: "0".repeat(64) },
      execution.deps
    )).resolves.toMatchObject({
      outcome: "rejected",
      acknowledged: false,
      code: "remote_mcp_invocation_context_invalid",
    });
    expect(execution.called).not.toHaveBeenCalled();
  });

  it("discovers and invokes through the real Streamable HTTP transport on loopback", async () => {
    const methods: string[] = [];
    const authorizations: Array<string | undefined> = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const rpc = body ? JSON.parse(body) as { id?: number; method: string } : null;
      if (!rpc) {
        response.writeHead(400).end();
        return;
      }
      methods.push(rpc.method);
      authorizations.push(request.headers.authorization);
      if (rpc.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      const result = rpc.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "loopback", version: "1.0.0" },
            capabilities: { tools: {} },
          }
        : rpc.method === "tools/list"
          ? { tools: definitions }
          : rpc.method === "tools/call"
            ? { content: [], structuredContent: { reservation_id: "live-r-1" } }
            : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("loopback server did not bind");
      const row = {
        ...registryRow,
        server_url: `http://127.0.0.1:${address.port}/mcp`,
      };
      const deps: RemoteMcpRuntimeDependencies = {
        decrypt: () => "Bearer loopback-secret",
        loadServer: async () => row,
      };
      const manifest = await snapshotExternalMcpServer(row, deps);
      await expect(invokePinnedExternalMcpTool(
        ORG_ID,
        manifest,
        manifest.tools[0].name,
        { slot: "10:00" },
        invocationContext,
        deps
      )).resolves.toEqual({
        outcome: "succeeded",
        acknowledged: true,
        value: { reservation_id: "live-r-1" },
      });
      expect(methods).toEqual([
        "initialize", "notifications/initialized", "tools/list",
        "initialize", "notifications/initialized", "tools/list", "tools/call",
      ]);
      expect(new Set(authorizations)).toEqual(new Set(["Bearer loopback-secret"]));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("revalidates the pinned catalog, calls only the exact remote name, and redacts secret fields", async () => {
    const setup = fakeDependencies();
    const manifest = await snapshotExternalMcpServer(registryRow, setup.deps);
    const execution = fakeDependencies();
    const result = await invokePinnedExternalMcpTool(
      ORG_ID,
      manifest,
      manifest.tools[0].name,
      { slot: "10:00" },
      invocationContext,
      execution.deps
    );

    expect(execution.called).toHaveBeenCalledWith(
      "reserve_slot",
      { slot: "10:00" },
      expect.objectContaining({
        metadata: {
          "hacc/invocation_id": invocationContext.invocationId,
          "hacc/idempotency_key": invocationContext.idempotencyKey,
        },
      })
    );
    expect(result).toEqual({
      outcome: "succeeded",
      acknowledged: true,
      value: {
        reservation_id: "r-123",
        access_token: "[REDACTED]",
        note: "server echoed [REDACTED]",
      },
    });
  });

  it("fails before dispatch when the endpoint, credential revision, or schema drifts", async () => {
    const setup = fakeDependencies();
    const manifest = await snapshotExternalMcpServer(registryRow, setup.deps);
    const driftedRow = { ...registryRow, auth_header_encrypted: "ciphertext-v2" };
    const execution = fakeDependencies({ row: driftedRow });
    const result = await invokePinnedExternalMcpTool(
      ORG_ID,
      manifest,
      manifest.tools[0].name,
      { slot: "10:00" },
      invocationContext,
      execution.deps
    );

    expect(result).toMatchObject({ code: "remote_mcp_provenance_drift" });
    expect(execution.called).not.toHaveBeenCalled();
  });

  it("cuts off an already-pinned remote revision before decrypt or network when it is revoked", async () => {
    const setup = fakeDependencies();
    const manifest = await snapshotExternalMcpServer(registryRow, setup.deps);
    const execution = fakeDependencies({
      row: {
        ...registryRow,
        revoked_at: "2026-07-16T21:00:00.000Z",
        revoked_by: "security@example.test",
        revocation_reason: "suspected credential compromise",
      },
    });
    await expect(invokePinnedExternalMcpTool(
      ORG_ID,
      manifest,
      manifest.tools[0].name,
      { slot: "10:00" },
      invocationContext,
      execution.deps
    )).resolves.toMatchObject({
      outcome: "rejected",
      acknowledged: false,
      code: "remote_mcp_revoked",
    });
    expect(execution.seenOptions).toHaveLength(0);
    expect(execution.decrypt).not.toHaveBeenCalled();
    expect(execution.called).not.toHaveBeenCalled();
  });

  it("rechecks revocation after discovery and rejects before tools/call", async () => {
    const setup = fakeDependencies();
    const manifest = await snapshotExternalMcpServer(registryRow, setup.deps);
    let revokedDuringDiscovery = false;
    const revoked = {
      ...registryRow,
      revoked_at: "2026-07-16T21:00:00.000Z",
      revoked_by: "security@example.test",
      revocation_reason: "suspected credential compromise",
    };
    const execution = fakeDependencies({
      afterListTools: () => { revokedDuringDiscovery = true; },
    });
    const loadServer = vi.fn(async () => revokedDuringDiscovery ? revoked : registryRow);
    execution.deps.loadServer = loadServer;

    await expect(invokePinnedExternalMcpTool(
      ORG_ID,
      manifest,
      manifest.tools[0].name,
      { slot: "10:00" },
      invocationContext,
      execution.deps
    )).resolves.toMatchObject({
      outcome: "rejected",
      acknowledged: false,
      code: "remote_mcp_revoked",
    });
    expect(loadServer).toHaveBeenCalledTimes(2);
    expect(execution.seenOptions).toHaveLength(1);
    expect(execution.decrypt).toHaveBeenCalledTimes(1);
    expect(execution.called).not.toHaveBeenCalled();
    expect(execution.closed).toHaveBeenCalledTimes(1);
  });

  it("rejects a cross-org public registry row before opening a remote client", async () => {
    const publicRow: McpRegistryServer = {
      ...registryRow,
      auth_header_encrypted: null,
      auth_encryption_slot_id: null,
    };
    const setup = fakeDependencies({ row: publicRow });
    const manifest = await snapshotExternalMcpServer(publicRow, setup.deps);
    const execution = fakeDependencies({
      row: {
        ...publicRow,
        org_id: "8916eb0a-5332-4f4c-a330-746c516e83bc",
      },
    });
    const prepare = vi.fn(async () => {
      throw new Error("cross-org registry rows must fail before connector preparation");
    });
    execution.deps.addressPinningConnector = { prepare };

    await expect(invokePinnedExternalMcpTool(
      ORG_ID,
      manifest,
      manifest.tools[0].name,
      { slot: "10:00" },
      invocationContext,
      execution.deps
    )).resolves.toMatchObject({
      outcome: "rejected",
      acknowledged: false,
      code: "remote_mcp_configuration_invalid",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(execution.seenOptions).toHaveLength(0);
    expect(execution.called).not.toHaveBeenCalled();
    expect(execution.decrypt).not.toHaveBeenCalled();
  });

  it("rejects arguments against the pinned input schema before tools/call", async () => {
    const setup = fakeDependencies();
    const manifest = await snapshotExternalMcpServer(registryRow, setup.deps);
    const execution = fakeDependencies();
    await expect(invokePinnedExternalMcpTool(
      ORG_ID,
      manifest,
      manifest.tools[0].name,
      { slot: 42 },
      invocationContext,
      execution.deps
    )).resolves.toMatchObject({ code: "remote_mcp_invalid_arguments" });
    expect(execution.called).not.toHaveBeenCalled();
  });

  it("keeps a successful-but-schema-invalid remote output indeterminate", async () => {
    const setup = fakeDependencies();
    const manifest = await snapshotExternalMcpServer(registryRow, setup.deps);
    const execution = fakeDependencies({
      callResult: {
        content: [],
        structuredContent: { reservation_id: 42 },
        isError: false,
        value: { reservation_id: 42 },
      },
    });
    await expect(invokePinnedExternalMcpTool(
      ORG_ID,
      manifest,
      manifest.tools[0].name,
      { slot: "10:00" },
      invocationContext,
      execution.deps
    )).rejects.toBeInstanceOf(RemoteMcpActionIndeterminateError);
  });

  it("redacts exact credentials from result property names as well as values", async () => {
    const setup = fakeDependencies();
    const manifest = await snapshotExternalMcpServer(registryRow, setup.deps);
    const execution = fakeDependencies({
      callResult: {
        content: [],
        structuredContent: { reservation_id: "r-1", "Bearer super-secret": "echo" },
        isError: false,
        value: { reservation_id: "r-1", "Bearer super-secret": "echo" },
      },
    });
    await expect(invokePinnedExternalMcpTool(
      ORG_ID,
      manifest,
      manifest.tools[0].name,
      { slot: "10:00" },
      invocationContext,
      execution.deps
    )).resolves.toEqual({
      outcome: "succeeded",
      acknowledged: true,
      value: { reservation_id: "r-1", "[REDACTED]": "[REDACTED]" },
    });
  });

  it("redacts safely decoded Basic username and password components", async () => {
    const authorization = `Basic ${Buffer.from("alice:correct-horse-battery", "utf8").toString("base64")}`;
    const setup = fakeDependencies({ authorization });
    const manifest = await snapshotExternalMcpServer(registryRow, setup.deps);
    const execution = fakeDependencies({
      authorization,
      callResult: {
        content: [],
        structuredContent: { reservation_id: "r-1" },
        isError: false,
        value: {
          reservation_id: "r-1",
          note: "decoded alice used correct-horse-battery",
        },
      },
    });
    await expect(invokePinnedExternalMcpTool(
      ORG_ID,
      manifest,
      manifest.tools[0].name,
      { slot: "10:00" },
      invocationContext,
      execution.deps
    )).resolves.toEqual({
      outcome: "succeeded",
      acknowledged: true,
      value: { reservation_id: "r-1", note: "decoded alice used [REDACTED]" },
    });
  });

  it("rejects short Bearer and unsafe Basic credentials before opening a client", async () => {
    for (const authorization of [
      "Bearer tiny",
      `Basic ${Buffer.from(":long-enough-password", "utf8").toString("base64")}`,
      `Basic ${Buffer.from("alice:tiny", "utf8").toString("base64")}`,
      "ApiKey abcdefghijkl mnopqrst",
    ]) {
      const execution = fakeDependencies({ authorization });
      await expect(snapshotExternalMcpServer(registryRow, execution.deps)).rejects.toMatchObject({
        code: "remote_mcp_configuration_invalid",
      });
      expect(execution.seenOptions).toHaveLength(0);
      expect(execution.called).not.toHaveBeenCalled();
    }
  });

  it("bounds Basic redaction candidates by splitting only the first username separator", async () => {
    const password = `${"segment:".repeat(500)}correct-horse-battery`;
    const authorization = `Basic ${Buffer.from(`alice:${password}`, "utf8").toString("base64")}`;
    const setup = fakeDependencies({ authorization });
    const manifest = await snapshotExternalMcpServer(registryRow, setup.deps);
    const execution = fakeDependencies({
      authorization,
      callResult: {
        content: [],
        structuredContent: { reservation_id: "r-1" },
        isError: false,
        value: { reservation_id: "r-1", note: password },
      },
    });

    await expect(invokePinnedExternalMcpTool(
      ORG_ID,
      manifest,
      manifest.tools[0].name,
      { slot: "10:00" },
      invocationContext,
      execution.deps
    )).resolves.toEqual({
      outcome: "succeeded",
      acknowledged: true,
      value: { reservation_id: "r-1", note: "[REDACTED]" },
    });
  });

  it("treats a Basic username as an identifier while still rejecting password reflection", async () => {
    const password = "correct-horse-battery";
    const authorization = `Basic ${Buffer.from(`admin:${password}`, "utf8").toString("base64")}`;
    await expect(snapshotExternalMcpServer(
      registryRow,
      fakeDependencies({
        authorization,
        discovered: [{ ...definitions[0], description: "Admin console reservation" }],
      }).deps
    )).resolves.toMatchObject({ manifestVersion: 2 });
    await expect(snapshotExternalMcpServer(
      registryRow,
      fakeDependencies({
        authorization,
        discovered: [{ ...definitions[0], description: `Password echo ${password}` }],
      }).deps
    )).rejects.toMatchObject({ code: "remote_mcp_configuration_invalid" });
  });

  it("validates the sanitized receipt value rather than a pre-redaction typed secret", async () => {
    const typedSecretDefinition: McpToolDefinition = {
      ...definitions[0],
      outputSchema: {
        type: "object",
        properties: {
          reservation_id: { type: "string" },
          access_token: { type: "number" },
        },
        required: ["reservation_id", "access_token"],
      },
    };
    const setup = fakeDependencies({ discovered: [typedSecretDefinition] });
    const manifest = await snapshotExternalMcpServer(registryRow, setup.deps);
    const execution = fakeDependencies({
      discovered: [typedSecretDefinition],
      callResult: {
        content: [],
        structuredContent: { reservation_id: "r-1", access_token: 42 },
        isError: false,
        value: { reservation_id: "r-1", access_token: 42 },
      },
    });
    await expect(invokePinnedExternalMcpTool(
      ORG_ID,
      manifest,
      manifest.tools[0].name,
      { slot: "10:00" },
      invocationContext,
      execution.deps
    )).rejects.toBeInstanceOf(RemoteMcpActionIndeterminateError);
  });

  it("marks transport failure after tools/call begins as indeterminate", async () => {
    const setup = fakeDependencies();
    const manifest = await snapshotExternalMcpServer(registryRow, setup.deps);
    const execution = fakeDependencies({ callError: new Error("contains remote implementation details") });

    await expect(invokePinnedExternalMcpTool(
      ORG_ID,
      manifest,
      manifest.tools[0].name,
      { slot: "10:00" },
      invocationContext,
      execution.deps
    )).rejects.toBeInstanceOf(RemoteMcpActionIndeterminateError);
  });

  it("treats MCP isError as indeterminate because it is not proof of zero side effects", async () => {
    const setup = fakeDependencies();
    const manifest = await snapshotExternalMcpServer(registryRow, setup.deps);
    const execution = fakeDependencies({
      callResult: {
        content: [{ type: "text", text: "remote implementation details" }],
        isError: true,
        value: "remote implementation details",
      },
    });

    await expect(invokePinnedExternalMcpTool(
      ORG_ID,
      manifest,
      manifest.tools[0].name,
      { slot: "10:00" },
      invocationContext,
      execution.deps
    )).rejects.toBeInstanceOf(RemoteMcpActionIndeterminateError);
  });

  it("verifies the current server without releasing auth into provider session configuration", async () => {
    const setup = fakeDependencies();
    const manifest = await snapshotExternalMcpServer(registryRow, setup.deps);
    const execution = fakeDependencies();
    await expect(verifyPinnedExternalMcpManifest(manifest, ORG_ID, execution.deps))
      .resolves.toBeUndefined();
    expect(execution.called).not.toHaveBeenCalled();
  });

  it("loads only the registration-approved catalog revision", async () => {
    const setup = fakeDependencies();
    const manifest = await snapshotExternalMcpServer(registryRow, setup.deps);
    expect(approvedExternalMcpManifest({
      ...registryRow,
      approved_manifest: manifest,
      approved_catalog_hash: manifest.catalogHash,
    })).toEqual(manifest);
    expect(() => approvedExternalMcpManifest({
      ...registryRow,
      approved_manifest: { ...manifest, catalogHash: "0".repeat(64) },
      approved_catalog_hash: manifest.catalogHash,
    })).toThrow();
  });
});

describe("remote MCP endpoint policy", () => {
  it("keeps development usable while still rejecting private and documentation literals", async () => {
    try {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("MCP_EGRESS_ALLOWED_HOSTS", "");
      vi.stubEnv("MCP_EGRESS_NETWORK_GUARD", "");
      await expect(defaultRemoteMcpEndpointPolicy(new URL("https://10.0.0.2/mcp"))).resolves.toBe(false);
      await expect(defaultRemoteMcpEndpointPolicy(new URL("https://[2001:db8::1]/mcp"))).resolves.toBe(false);
      await expect(defaultRemoteMcpEndpointPolicy(new URL("https://8.8.8.8/mcp"))).resolves.toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("requires both the exact production hostname and exact deployment assertion", async () => {
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("MCP_EGRESS_ALLOWED_HOSTS", "");
      vi.stubEnv("MCP_EGRESS_NETWORK_GUARD", "");
      await expect(defaultRemoteMcpEndpointPolicy(new URL("https://8.8.8.8/mcp")))
        .resolves.toBe(false);
      vi.stubEnv("MCP_EGRESS_ALLOWED_HOSTS", "8.8.8.8");
      await expect(defaultRemoteMcpEndpointPolicy(new URL("https://8.8.8.8/mcp")))
        .resolves.toBe(false);
      vi.stubEnv("MCP_EGRESS_NETWORK_GUARD", "private-range-blocked");
      await expect(defaultRemoteMcpEndpointPolicy(new URL("https://8.8.8.8/mcp")))
        .resolves.toBe(false);
      vi.stubEnv("MCP_EGRESS_NETWORK_GUARD", "private-ranges-blocked");
      await expect(defaultRemoteMcpEndpointPolicy(new URL("https://8.8.8.8/mcp")))
        .resolves.toBe(true);
      await expect(defaultRemoteMcpEndpointPolicy(new URL("https://1.1.1.1/mcp")))
        .resolves.toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("surfaces a production deployment block before decrypting credentials or opening transport", async () => {
    const execution = fakeDependencies();
    const clientFactory = vi.fn(execution.deps.clientFactory!);
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("MCP_EGRESS_ALLOWED_HOSTS", "mcp.example.test");
      vi.stubEnv("MCP_EGRESS_NETWORK_GUARD", "wrong");
      await expect(snapshotExternalMcpServer(registryRow, {
        ...execution.deps,
        clientFactory,
      })).rejects.toMatchObject({ code: "remote_mcp_deployment_blocked" });
      expect(execution.decrypt).not.toHaveBeenCalled();
      expect(clientFactory).not.toHaveBeenCalled();

      vi.stubEnv("MCP_EGRESS_NETWORK_GUARD", "private-ranges-blocked");
      await expect(snapshotExternalMcpServer(registryRow, {
        ...execution.deps,
        clientFactory,
      })).resolves.toMatchObject({ manifestVersion: 2 });
      expect(execution.decrypt).toHaveBeenCalledTimes(1);
      expect(clientFactory).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("accepts exact public address-pinning evidence bound to its prepared transport", async () => {
    const execution = fakeDependencies();
    const preparedFactory = execution.deps.clientFactory!;
    const fallbackFactory = vi.fn(() => {
      throw new Error("unattested fallback transport must not be used");
    });
    const prepare = vi.fn(async (endpoint: URL) => ({
      evidence: {
        version: 1 as const,
        kind: "address_pinning_connector" as const,
        endpoint: endpoint.toString(),
        hostname: endpoint.hostname,
        resolvedAddresses: ["8.8.8.8"],
        tlsServerName: endpoint.hostname,
        tlsHostnameVerification: true as const,
        redirects: "blocked" as const,
      },
      clientFactory: preparedFactory,
    }));
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("MCP_EGRESS_ALLOWED_HOSTS", "mcp.example.test");
      vi.stubEnv("MCP_EGRESS_NETWORK_GUARD", "private-ranges-blocked");
      await expect(snapshotExternalMcpServer(registryRow, {
        ...execution.deps,
        clientFactory: fallbackFactory,
        addressPinningConnector: { prepare },
      })).resolves.toMatchObject({ manifestVersion: 2 });
      expect(prepare).toHaveBeenCalledOnce();
      expect(prepare).toHaveBeenCalledWith(
        new URL("https://mcp.example.test/v1"),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          timeoutMs: 8_000,
        })
      );
      expect(fallbackFactory).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("bounds a non-cooperative address-pinning connector before credential decryption", async () => {
    vi.useFakeTimers();
    const execution = fakeDependencies();
    let connectorSignal: AbortSignal | undefined;
    const prepare = vi.fn((_endpoint: URL, operation: { signal: AbortSignal }) => {
      connectorSignal = operation.signal;
      return new Promise<never>(() => undefined);
    });
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("MCP_EGRESS_ALLOWED_HOSTS", "mcp.example.test");
      vi.stubEnv("MCP_EGRESS_NETWORK_GUARD", "private-ranges-blocked");
      const pending = snapshotExternalMcpServer(registryRow, {
        ...execution.deps,
        addressPinningConnector: { prepare },
      });
      const rejection = expect(pending).rejects.toMatchObject({
        code: "remote_mcp_deployment_blocked",
      });

      await vi.advanceTimersByTimeAsync(8_000);
      await rejection;
      expect(connectorSignal?.aborted).toBe(true);
      expect(execution.decrypt).not.toHaveBeenCalled();
      expect(execution.seenOptions).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("rejects private or malformed address-pinning evidence before credential decryption", async () => {
    const execution = fakeDependencies();
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("MCP_EGRESS_ALLOWED_HOSTS", "mcp.example.test");
      vi.stubEnv("MCP_EGRESS_NETWORK_GUARD", "private-ranges-blocked");
      await expect(snapshotExternalMcpServer(registryRow, {
        ...execution.deps,
        addressPinningConnector: {
          prepare: async (endpoint) => ({
            evidence: {
              version: 1,
              kind: "address_pinning_connector",
              endpoint: endpoint.toString(),
              hostname: endpoint.hostname,
              resolvedAddresses: ["10.0.0.2"],
              tlsServerName: endpoint.hostname,
              tlsHostnameVerification: true,
              redirects: "blocked",
            },
            clientFactory: execution.deps.clientFactory!,
          }),
        },
      })).rejects.toMatchObject({ code: "remote_mcp_deployment_blocked" });
      expect(execution.decrypt).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

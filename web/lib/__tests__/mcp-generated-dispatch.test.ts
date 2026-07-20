import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveFlowActionInvocationId, hashFlowValue, type FlowExecutionState } from "../flow-runtime";
import {
  CallRuntimeSnapshotSchema,
  callRuntimeDigest,
  externalMcpCatalogHash,
  externalMcpEndpointHash,
  externalMcpToolSchemaHash,
} from "../call-runtime-snapshot";
import { namespaceMcpToolName } from "../mcp-client";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  q: vi.fn(),
  qOne: vi.fn(),
  hasReadyDocuments: vi.fn(),
  loadFlowState: vi.fn(),
  reserveFlowActionAtomic: vi.fn(),
  markFlowActionDispatchStartedAtomic: vi.fn(),
  settleFlowActionAtomic: vi.fn(),
  recoverStaleFlowActionsAtomic: vi.fn(),
  withLockedFlowState: vi.fn(),
  verifyFlowCapability: vi.fn(),
  signFlowCapability: vi.fn(),
  invokeTool: vi.fn(),
  prepareToolInvocation: vi.fn(),
  executePreparedToolInvocation: vi.fn(),
  extensionPreflight: vi.fn(),
  extensionExecutePrepared: vi.fn(),
  extensionExecutePinned: vi.fn(),
  remoteInvoke: vi.fn(),
  remotePreflight: vi.fn(),
  remoteValidateArguments: vi.fn(),
  queryRows: vi.fn(),
  sendAgentEmail: vi.fn(),
  sendSms: vi.fn(),
  admitMcpToolInvocation: vi.fn(),
  settleMcpToolInvocation: vi.fn(),
}));

vi.mock("../db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("../knowledge", () => ({
  hasReadyDocuments: mocks.hasReadyDocuments,
  searchKnowledge: vi.fn(),
}));
vi.mock("../flow-state-store", () => ({
  loadFlowState: mocks.loadFlowState,
  reserveFlowActionAtomic: mocks.reserveFlowActionAtomic,
  markFlowActionDispatchStartedAtomic: mocks.markFlowActionDispatchStartedAtomic,
  settleFlowActionAtomic: mocks.settleFlowActionAtomic,
  recoverStaleFlowActionsAtomic: mocks.recoverStaleFlowActionsAtomic,
  withLockedFlowState: mocks.withLockedFlowState,
}));
vi.mock("../flow-capability", () => ({
  verifyFlowCapability: mocks.verifyFlowCapability,
  signFlowCapability: mocks.signFlowCapability,
}));
vi.mock("../toolfactory/deploy", () => ({
  invokeTool: mocks.invokeTool,
  prepareToolInvocation: mocks.prepareToolInvocation,
  executePreparedToolInvocation: mocks.executePreparedToolInvocation,
}));
vi.mock("../remote-mcp-runtime", () => ({
  invokePinnedExternalMcpTool: mocks.remoteInvoke,
  verifyPinnedExternalMcpManifest: mocks.remotePreflight,
  validatePinnedExternalMcpArguments: mocks.remoteValidateArguments,
}));
vi.mock("../mcp-invocation-store", () => ({
  admitMcpToolInvocation: mocks.admitMcpToolInvocation,
  settleMcpToolInvocation: mocks.settleMcpToolInvocation,
}));
vi.mock("../xai", () => ({ research: vi.fn() }));
vi.mock("../datasets", () => ({
  queryRows: mocks.queryRows,
  upsertRow: vi.fn(),
  findCustomerByPhone: vi.fn(),
}));
vi.mock("../voice", () => ({ signScope: vi.fn(() => "scope") }));
vi.mock("../email", () => ({ sendAgentEmail: mocks.sendAgentEmail }));
vi.mock("../sms", () => ({ sendSms: mocks.sendSms }));
vi.mock("../log", () => ({ log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("../voice-tools", () => ({
  voiceToolExtensions: {
    definitions: vi.fn(async () => []),
    preflightPinned: mocks.extensionPreflight,
    executePrepared: mocks.extensionExecutePrepared,
    executePinned: mocks.extensionExecutePinned,
  },
}));

import {
  activeCapabilityAuthorityFor,
  callActiveCapability,
  callTool,
  downstreamActionIdempotencyKey,
} from "../mcp";

const scope = { callId: "call-1", agentId: "agent-1", orgId: "org-1" };
const providerInvocationId = `mcp-jsonrpc:v1:${"a".repeat(64)}`;
const remoteNamespace = "server_remote-1";
const remoteName = "create_ticket";
const remoteToolName = namespaceMcpToolName(remoteNamespace, remoteName).toLowerCase();
const remoteToolWithoutHash = {
  name: remoteToolName,
  remoteName,
  namespace: remoteNamespace,
  description: "Create a support ticket.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { subject: { type: "string" } },
    required: ["subject"],
  },
};
const remoteTool = {
  ...remoteToolWithoutHash,
  schemaHash: externalMcpToolSchemaHash(remoteToolWithoutHash),
};
const remoteCatalogHash = externalMcpCatalogHash([remoteTool]);
const remoteServerInfo = { name: "support", version: "1.0.0" };
const remoteManifest = {
  manifestVersion: 2 as const,
  id: "remote-1",
  label: "Support",
  namespace: remoteNamespace,
  serverUrl: "https://support.example.test/mcp",
  allowedTools: [remoteName],
  source: {
    kind: "mcp_server_registry" as const,
    serverId: "remote-1",
    endpointSha256: externalMcpEndpointHash("https://support.example.test/mcp"),
    authEncryptedSha256: "a".repeat(64),
  },
  protocolVersion: "2025-11-25",
  serverInfo: remoteServerInfo,
  tools: [remoteTool],
  catalogHash: remoteCatalogHash,
  discoveryHash: hashFlowValue({
    protocolVersion: "2025-11-25",
    serverInfo: remoteServerInfo,
    catalogHash: remoteCatalogHash,
  }),
  discoveredAt: "2026-07-16T12:00:00.000Z",
};
const flow = {
  schema_version: 2 as const,
  tool_exposure: "gateway" as const,
  always_tools: [],
  nodes: [
    { id: "entry", label: "Entry", kind: "incoming_call" as const },
    {
      id: "operations",
      label: "Operations",
      kind: "topic" as const,
      steps: [{
        id: "commit",
        label: "Commit",
        instructions: "Commit once.",
        tools: ["reserve_slot", "extension_write", remoteToolName],
        action_policies: [
          { tool: "reserve_slot", idempotency: "per_arguments" as const },
          { tool: "extension_write", idempotency: "per_arguments" as const },
          { tool: remoteToolName, idempotency: "per_arguments" as const },
        ],
      }],
    },
  ],
  edges: [{ from: "entry", to: "operations" }],
};
const runtimeSnapshot = CallRuntimeSnapshotSchema.parse({
  v: 2,
  agentVersion: 1,
  namedFlowId: null,
  flow,
  instructions: "Test generated dispatch.",
  codeRevision: "test-revision",
  toolManifest: [{
    id: "tool-1",
    slug: "reserve_slot",
    description: "Reserve a slot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { slot: { type: "string" } },
      required: ["slot"],
    },
    endpointUrl: "https://generated-tool.vercel.app/api/reserve-slot",
    invocationKeyId: "tik_abcdefghijklmnop",
  }],
  extensionManifest: [{
    name: "extension_write",
    description: "Commit through a trusted local extension.",
    implementationDigest: "e".repeat(64),
    admissionScopeDigest: "c".repeat(64),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { reservation_ref: { type: "string" } },
      required: ["reservation_ref"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reservation_id: { type: "string" },
        error: { type: "string" },
      },
    },
    effect: "write",
  }],
  externalMcpManifest: [remoteManifest],
  environment: {
    internetEnabled: false,
    allowedDomains: [],
    docsReady: false,
    datasetSlugs: [],
    holdMusic: false,
  },
  createdAt: "2026-07-16T12:00:00.000Z",
});
const runtimeDigest = callRuntimeDigest(runtimeSnapshot);
const state: FlowExecutionState = {
  version: 2,
  status: "active",
  nodeId: "operations",
  currentStep: "operations.commit",
  completedSteps: [],
  attempts: { "operations.commit": 1 },
  outputs: {},
  checkpoints: [],
  capabilityEpoch: 2,
  actionReceipts: [],
  revision: 2,
  updatedAt: "2026-07-16T12:00:00.000Z",
};

function receipt(
  status: "reserved" | "succeeded" | "failed" | "indeterminate" = "reserved",
  identity: {
    receiptId?: string;
    invocationId?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
  } = {}
) {
  const receiptId = identity.receiptId ?? "0ddc0ffe-1234-5678-9234-0123456789ab";
  const invocationId = identity.invocationId ?? deriveFlowActionInvocationId(
    `call:${scope.callId}\0receipt:${receiptId}`
  );
  const tool = identity.tool ?? "reserve_slot";
  const actionArguments = identity.arguments ?? { slot: "10:00" };
  return {
    id: receiptId,
    idempotencyKey: hashFlowValue({ tool, ...actionArguments }),
    step: "operations.commit",
    tool,
    capabilityEpoch: 2,
    arguments: actionArguments,
    argumentsHash: hashFlowValue(actionArguments),
    invocationId,
    providerInvocationId,
    dispatchStartedAt: "2026-07-16T12:00:01.000Z",
    dispatchAttempt: 1,
    status,
    reservedAt: "2026-07-16T12:00:00.000Z",
    ...(status !== "reserved" ? { settledAt: "2026-07-16T12:00:02.000Z" } : {}),
  };
}

describe("live generated-tool flow dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MCP_GATEWAY_SECRET = "mcp-test-secret-that-is-at-least-32-bytes";
    mocks.hasReadyDocuments.mockResolvedValue(false);
    mocks.loadFlowState.mockResolvedValue(state);
    mocks.recoverStaleFlowActionsAtomic.mockResolvedValue(state);
    mocks.verifyFlowCapability.mockReturnValue({
      claims: { capabilityEpoch: 2 },
    });
    mocks.signFlowCapability.mockReturnValue({ token: "grant", expiresAt: "2026-07-16T13:00:00.000Z" });
    mocks.extensionPreflight.mockResolvedValue({ ok: true, prepared: Object.freeze({}) });
    mocks.extensionExecutePrepared.mockResolvedValue({
      ok: true,
      executionStarted: true,
      value: { reservation_id: "EXT-1" },
    });
    mocks.remotePreflight.mockResolvedValue(undefined);
    mocks.remoteValidateArguments.mockReturnValue(null);
    mocks.queryRows.mockResolvedValue(null);
    mocks.prepareToolInvocation.mockImplementation((endpoint, input, signer, context) => ({
      endpointUrl: endpoint,
      signed: {},
      binding: {
        toolId: context.toolId,
        slug: signer.slug,
        invocationId: context.invocationId,
      },
      __test: { endpoint, input, signer, context },
    }));
    mocks.executePreparedToolInvocation.mockImplementation((prepared) =>
      mocks.invokeTool(
        prepared.__test.endpoint,
        prepared.__test.input,
        prepared.__test.signer,
        prepared.__test.context
      )
    );
    mocks.admitMcpToolInvocation.mockResolvedValue({
      execute: true,
      receiptId: "7d97445c-1831-5d80-8b10-e830c3a3c9be",
      ownerToken: "13b171b5-b6a1-41e9-8104-fda80a8dd5ee",
    });
    mocks.settleMcpToolInvocation.mockImplementation(async (_admission, result) => result);
    mocks.remoteInvoke.mockResolvedValue({
      outcome: "succeeded",
      acknowledged: true,
      value: { ticket_id: "T-1" },
    });
    mocks.q.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, slug, description")) {
        return [{
          id: "tool-1",
          slug: "reserve_slot",
          description: "Reserve a slot.",
          input_schema: {
            type: "object",
            additionalProperties: false,
            properties: { slot: { type: "string" } },
            required: ["slot"],
          },
          endpoint_url: "https://generated-tool.vercel.app/api/reserve-slot",
          invocation_key_id: "tik_abcdefghijklmnop",
        }];
      }
      return [];
    });
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM calls c") && sql.includes("JOIN agents")) {
        return {
          status: "active",
          flow,
          tool_ids: ["tool-1"],
          runtime_snapshot: runtimeSnapshot,
          runtime_digest: runtimeDigest,
        };
      }
      if (sql.includes("SELECT internet_enabled")) return { internet_enabled: false, allowed_domains: [] };
      if (sql.includes("FROM media_renditions")) return null;
      if (sql.includes("JOIN tool_invocation_revisions")) {
        return {
          slug: "reserve_slot",
          endpoint_url: "https://generated-tool.vercel.app/api/reserve-slot",
          invocation_key_id: "tik_abcdefghijklmnop",
          invocation_private_key_encrypted: "encrypted-private-key",
        };
      }
      if (sql.includes("SELECT EXISTS") && sql.includes("tool_invocation_revisions")) {
        return { active: true };
      }
      return null;
    });
    mocks.reserveFlowActionAtomic.mockImplementation(async (_callId, _flow, args) => ({
      state,
      receipt: receipt("reserved", {
        receiptId: args.receiptId,
        invocationId: args.invocationId,
        tool: args.tool,
        arguments: args.arguments,
      }),
      execute: true,
      replayed: false,
      ownerToken: "owner-1",
    }));
    mocks.markFlowActionDispatchStartedAtomic.mockImplementation(async (_callId, args) => ({
      state,
      receipt: receipt("reserved", { receiptId: args.receiptId }),
    }));
    mocks.settleFlowActionAtomic.mockImplementation(async (_callId, args) => {
      const reserved = mocks.reserveFlowActionAtomic.mock.results.at(-1)?.value;
      const reservation = reserved ? await reserved : null;
      return {
        state,
        receipt: {
          ...receipt(args.status, {
            receiptId: args.receiptId,
            invocationId: reservation?.receipt.invocationId,
            tool: reservation?.receipt.tool,
            arguments: reservation?.receipt.arguments,
          }),
          ...(args.result !== undefined ? { result: args.result } : {}),
        },
      };
    });
  });

  async function execute() {
    return callTool(scope, "run_action", {
      name: "reserve_slot",
      arguments: { slot: "10:00" },
      capability_grant: "grant",
    }, { invocationId: providerInvocationId });
  }

  it("keeps funded voice actions out of provider authority and rejects legacy direct invocations before side effects", async () => {
    const fundedNames = ["request_recall", "send_email", "send_sms"] as const;
    const fundedFlow = {
      ...flow,
      always_tools: [...fundedNames],
      always_action_policies: fundedNames.map((tool) => ({
        tool,
        max_calls: 1,
        idempotency: "per_call_arguments" as const,
      })),
    };
    const fundedSnapshot = CallRuntimeSnapshotSchema.parse({
      ...runtimeSnapshot,
      flow: fundedFlow,
    });
    const fundedDigest = callRuntimeDigest(fundedSnapshot);
    mocks.qOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM calls c") && sql.includes("JOIN agents")) {
        return {
          status: "active",
          flow: fundedFlow,
          tool_ids: ["tool-1"],
          runtime_snapshot: fundedSnapshot,
          runtime_digest: fundedDigest,
        };
      }
      if (sql.includes("SELECT internet_enabled")) return { internet_enabled: false, allowed_domains: [] };
      if (sql.includes("FROM media_renditions")) return null;
      return null;
    });

    const authority = await activeCapabilityAuthorityFor(scope);
    expect(authority.catalog.tools.map((tool) => tool.logical_name))
      .not.toEqual(expect.arrayContaining([...fundedNames]));

    for (const name of fundedNames) {
      await expect(callTool(scope, name, {
        to: "attacker@example.test",
        to_number: "+14155550199",
        run_at: "2030-01-01T00:00:00.000Z",
        subject: "Unauthorized",
        message: "Unauthorized",
        reason: "Unauthorized",
      })).resolves.toMatchObject({ code: "operator_approval_required" });
    }

    expect(mocks.sendAgentEmail).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(mocks.qOne.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO scheduled_calls")
    )).toBe(false);
  });

  it("rejects root-token-only transfer and hangup before the flow provider boundary or call-state write", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"a".repeat(32)}`);
    vi.stubEnv("TWILIO_AUTH_TOKEN", "root-auth-token-for-webhook-verification-only");
    vi.stubEnv("TWILIO_API_KEY_TYPE", "");
    vi.stubEnv("TWILIO_API_KEY_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_API_KEY_SID", "");
    vi.stubEnv("TWILIO_API_KEY_SECRET", "");
    const baseQuery = mocks.qOne.getMockImplementation();
    mocks.qOne.mockImplementation(async (...call) => {
      const sql = String(call[0]);
      if (sql === "SELECT twilio_call_sid FROM calls WHERE id = $1") {
        return { twilio_call_sid: `CA${"b".repeat(32)}` };
      }
      return baseQuery?.(...call);
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      for (const [index, name] of ["contact_support", "end_call"].entries()) {
        await expect(callTool(scope, "run_action", {
          name,
          arguments: name === "contact_support" ? { reason: "human requested" } : { reason: "done" },
          capability_grant: "grant",
        }, { invocationId: `mcp-jsonrpc:v1:${String(index + 1).repeat(64)}` })).resolves.toMatchObject({
          code: "action_rejected",
          rejection_code: "provider_rest_authority_unavailable",
        });
      }

      expect(mocks.markFlowActionDispatchStartedAtomic).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.q.mock.calls.filter(([, type]) => type === "state")).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  async function executeExtension() {
    return callTool(scope, "run_action", {
      name: "extension_write",
      arguments: { reservation_ref: "REF-1" },
      capability_grant: "grant",
    }, { invocationId: providerInvocationId });
  }

  async function executeRemote() {
    return callTool(scope, "run_action", {
      name: remoteToolName,
      arguments: { subject: "Need help" },
      capability_grant: "grant",
    }, { invocationId: providerInvocationId });
  }

  function usePinnedPolicyEffect(
    tool: "reserve_slot" | "extension_write" | typeof remoteToolName,
    effect: "read" | "write" | "opaque"
  ) {
    const alternateFlow = {
      ...flow,
      nodes: flow.nodes.map((node) => node.id !== "operations"
        ? node
        : {
            ...node,
            steps: node.steps?.map((step) => ({
              ...step,
              action_policies: step.action_policies?.map((policy) =>
                policy.tool === tool ? { ...policy, effect } : policy
              ),
            })),
          }),
    };
    const alternateSnapshot = CallRuntimeSnapshotSchema.parse({
      ...runtimeSnapshot,
      flow: alternateFlow,
      extensionManifest: runtimeSnapshot.extensionManifest.map((definition) =>
        definition.name === tool ? { ...definition, effect } : definition
      ),
    });
    const alternateDigest = callRuntimeDigest(alternateSnapshot);
    const baseQuery = mocks.qOne.getMockImplementation();
    mocks.qOne.mockImplementation(async (...call) => {
      const sql = String(call[0]);
      if (sql.includes("FROM calls c") && sql.includes("JOIN agents")) {
        return {
          status: "active",
          flow: alternateFlow,
          tool_ids: ["tool-1"],
          runtime_snapshot: alternateSnapshot,
          runtime_digest: alternateDigest,
        };
      }
      return baseQuery?.(...call);
    });
    return alternateDigest;
  }

  it("passes the persisted downstream identity and full flow binding into the signed invocation", async () => {
    mocks.invokeTool.mockImplementation(async (_endpoint, _input, _signer, context) => ({
      outcome: "succeeded",
      acknowledged: true,
      invocationId: context.invocationId,
      value: { reservation_id: "R-1" },
    }));

    const result = await execute();
    expect(result).toMatchObject({
      reservation_id: "R-1",
      receipt_id: expect.stringMatching(/^[a-f0-9-]{36}$/),
      receipt_status: "succeeded",
    });
    const reservationArgs = mocks.reserveFlowActionAtomic.mock.calls[0][2];
    const expectedReceipt = receipt("reserved", {
      receiptId: reservationArgs.receiptId,
      invocationId: reservationArgs.invocationId,
    });
    expect(mocks.reserveFlowActionAtomic).toHaveBeenCalledWith(
      scope.callId,
      expect.anything(),
      expect.objectContaining({
        receiptId: reservationArgs.receiptId,
        invocationId: reservationArgs.invocationId,
      })
    );
    expect(mocks.invokeTool).toHaveBeenCalledWith(
      "https://generated-tool.vercel.app/api/reserve-slot",
      { slot: "10:00" },
      {
        keyId: "tik_abcdefghijklmnop",
        privateKeyPkcs8Encrypted: "encrypted-private-key",
        slug: "reserve_slot",
      },
      expect.objectContaining({
        orgId: scope.orgId,
        toolId: "tool-1",
        invocationId: reservationArgs.invocationId,
        audience: "flow_action",
        idempotencyKey: downstreamActionIdempotencyKey(
          scope.orgId,
          scope.callId,
          expectedReceipt.idempotencyKey
        ),
        callId: scope.callId,
        agentId: scope.agentId,
        runtimeDigest,
        receiptId: reservationArgs.receiptId,
      })
    );
    expect(mocks.prepareToolInvocation.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.markFlowActionDispatchStartedAtomic.mock.invocationCallOrder[0]);
    expect(mocks.markFlowActionDispatchStartedAtomic.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.executePreparedToolInvocation.mock.invocationCallOrder[0]);
  });

  it("rejects generated endpoint/decrypt/sign preflight before the dispatch marker", async () => {
    mocks.prepareToolInvocation.mockImplementationOnce(() => {
      throw new Error("encrypted key cannot be decrypted");
    });

    await expect(execute()).resolves.toMatchObject({
      code: "action_rejected",
      rejection_code: "generated_tool_preflight_failed",
      receipt_status: "failed",
    });
    expect(mocks.markFlowActionDispatchStartedAtomic).not.toHaveBeenCalled();
    expect(mocks.executePreparedToolInvocation).not.toHaveBeenCalled();
    expect(mocks.invokeTool).not.toHaveBeenCalled();
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "failed", deliveryState: "not_sent" })
    );
  });

  it("rechecks emergency revocation after signing and cuts off before generated network dispatch", async () => {
    const baseQuery = mocks.qOne.getMockImplementation();
    mocks.qOne.mockImplementation(async (...call) => {
      const sql = String(call[0]);
      if (sql.includes("SELECT EXISTS") && sql.includes("tool_invocation_revisions")) {
        return { active: false };
      }
      return baseQuery?.(...call);
    });

    await expect(execute()).resolves.toMatchObject({
      code: "action_rejected",
      rejection_code: "generated_tool_rejected",
      receipt_status: "failed",
    });
    expect(mocks.prepareToolInvocation).toHaveBeenCalled();
    expect(mocks.markFlowActionDispatchStartedAtomic).toHaveBeenCalled();
    expect(mocks.executePreparedToolInvocation).not.toHaveBeenCalled();
    expect(mocks.invokeTool).not.toHaveBeenCalled();
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "failed", deliveryState: "rejected" })
    );
  });

  it("admits only logical provider input before host-binding a private action grant", async () => {
    mocks.invokeTool.mockImplementation(async (_endpoint, _input, _signer, context) => ({
      outcome: "succeeded",
      acknowledged: true,
      invocationId: context.invocationId,
      value: { reservation_id: "R-active-1" },
    }));
    const authority = await activeCapabilityAuthorityFor(scope);
    const expectedCatalog = {
      catalog_digest: authority.catalog.catalog_digest,
      capability_epoch: authority.catalog.capability_epoch,
    };
    mocks.admitMcpToolInvocation.mockClear();

    await expect(callActiveCapability(
      scope,
      "reserve_slot",
      { slot: "10:00" },
      { invocationId: providerInvocationId, expectedCatalog }
    )).resolves.toMatchObject({ reservation_id: "R-active-1" });

    expect(mocks.admitMcpToolInvocation).toHaveBeenCalledWith({
      callId: scope.callId,
      providerInvocationId,
      logicalName: "reserve_slot",
      modelArguments: { slot: "10:00" },
      expectedCatalog,
    });
    expect(JSON.stringify(mocks.admitMcpToolInvocation.mock.calls[0][0]))
      .not.toContain("capability_grant");
    expect(mocks.reserveFlowActionAtomic).toHaveBeenCalled();
  });

  it("replays a terminal logical receipt without consulting advanced current authority", async () => {
    const original = { path: "operations.commit", revision: 3 };
    mocks.admitMcpToolInvocation.mockResolvedValueOnce({
      execute: false,
      receiptId: "7d97445c-1831-5d80-8b10-e830c3a3c9be",
      result: original,
      replayed: true,
    });
    mocks.recoverStaleFlowActionsAtomic.mockClear();
    mocks.q.mockClear();

    await expect(callActiveCapability(
      scope,
      "enter_step",
      { path: "operations.commit" },
      {
        invocationId: providerInvocationId,
        expectedCatalog: { catalog_digest: "f".repeat(64), capability_epoch: 1 },
      }
    )).resolves.toEqual(original);
    expect(mocks.recoverStaleFlowActionsAtomic).not.toHaveBeenCalled();
    expect(mocks.reserveFlowActionAtomic).not.toHaveBeenCalled();
    expect(mocks.settleMcpToolInvocation).not.toHaveBeenCalled();
    expect(mocks.q.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO call_events")
    )).toBe(false);
  });

  it("durably settles a stale catalog rejection for a newly admitted identity", async () => {
    const authority = await activeCapabilityAuthorityFor(scope);
    mocks.recoverStaleFlowActionsAtomic.mockClear();
    mocks.settleMcpToolInvocation.mockClear();
    mocks.reserveFlowActionAtomic.mockClear();
    const expectedCatalog = {
      catalog_digest: "f".repeat(64),
      capability_epoch: authority.catalog.capability_epoch,
    };

    await expect(callActiveCapability(
      scope,
      "reserve_slot",
      { slot: "10:00" },
      { invocationId: providerInvocationId, expectedCatalog }
    )).resolves.toMatchObject({ code: "stale_active_capability_catalog" });
    expect(mocks.admitMcpToolInvocation).toHaveBeenCalledWith(expect.objectContaining({
      logicalName: "reserve_slot",
      expectedCatalog,
    }));
    expect(mocks.settleMcpToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ execute: true }),
      expect.objectContaining({ code: "stale_active_capability_catalog" }),
      "completed"
    );
    expect(mocks.reserveFlowActionAtomic).not.toHaveBeenCalled();
  });

  it("does not let receipt-backed end_call deadlock on its own reservation", async () => {
    let currentReceipt: ReturnType<typeof receipt> | undefined;
    const terminalState: FlowExecutionState = {
      ...state,
      status: "completed",
      currentStep: null,
      completedSteps: ["operations.commit"],
      capabilityEpoch: 3,
      revision: 3,
    };
    mocks.loadFlowState.mockImplementation(async () => ({
      ...terminalState,
      actionReceipts: currentReceipt ? [currentReceipt] : [],
    }));
    mocks.reserveFlowActionAtomic.mockImplementationOnce(async (_callId, _flow, args) => {
      currentReceipt = receipt("reserved", {
        receiptId: args.receiptId,
        invocationId: args.invocationId,
        tool: args.tool,
        arguments: args.arguments,
      });
      return {
        state: terminalState,
        receipt: currentReceipt,
        execute: true,
        replayed: false,
        ownerToken: "owner-1",
      };
    });

    await expect(callTool(scope, "run_action", {
      name: "end_call",
      arguments: { reason: "completed" },
      capability_grant: "grant",
    }, { invocationId: providerInvocationId })).resolves.toMatchObject({
      ok: true,
      simulated: true,
      receipt_status: "succeeded",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "succeeded", deliveryState: "committed" })
    );
  });

  it("settles a built-in read failure as retry-safe instead of indeterminate", async () => {
    await expect(callTool(scope, "run_action", {
      name: "read_table",
      arguments: { table: "missing" },
      capability_grant: "grant",
    }, { invocationId: providerInvocationId })).resolves.toMatchObject({
      code: "action_rejected",
      rejection_code: "unknown_table",
      receipt_status: "failed",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "failed", deliveryState: "rejected" })
    );
  });

  it("settles a thrown built-in read failure as retry-safe while keeping mutation throws indeterminate", async () => {
    mocks.queryRows.mockRejectedValueOnce(new Error("dataset connection reset"));
    await expect(callTool(scope, "run_action", {
      name: "read_table",
      arguments: { table: "customers" },
      capability_grant: "grant",
    }, { invocationId: providerInvocationId })).resolves.toMatchObject({
      code: "action_rejected",
      rejection_code: "effect_safe_action_failed",
      receipt_status: "failed",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "failed", deliveryState: "rejected" })
    );

    mocks.settleFlowActionAtomic.mockClear();
    mocks.invokeTool.mockRejectedValueOnce(new Error("response lost after mutation dispatch"));
    await expect(execute()).resolves.toMatchObject({
      code: "action_indeterminate",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "indeterminate", deliveryState: "unknown" })
    );
  });

  it("settles an acknowledged business decline as succeeded, not transport-indeterminate", async () => {
    mocks.invokeTool.mockImplementation(async (_endpoint, _input, _signer, context) => ({
      outcome: "succeeded",
      acknowledged: true,
      invocationId: context.invocationId,
      value: { error: "slot unavailable", retryable: false },
    }));
    await expect(execute()).resolves.toMatchObject({
      error: "slot unavailable",
      receipt_status: "succeeded",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({
        status: "succeeded",
        deliveryState: "committed",
        result: { error: "slot unavailable", retryable: false },
      })
    );
  });

  it("distinguishes pre-execution rejection from an after-dispatch indeterminate failure", async () => {
    mocks.invokeTool.mockImplementationOnce(async (_endpoint, _input, _signer, context) => ({
      outcome: "rejected",
      acknowledged: false,
      invocationId: context.invocationId,
      error: "rejected before execution",
    }));
    await expect(execute()).resolves.toMatchObject({
      code: "action_rejected",
      receipt_status: "failed",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "failed", deliveryState: "rejected" })
    );

    mocks.settleFlowActionAtomic.mockClear();
    mocks.invokeTool.mockRejectedValueOnce(new Error("response lost after dispatch"));
    await expect(execute()).resolves.toMatchObject({
      code: "action_indeterminate",
      receipt_id: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "indeterminate", deliveryState: "unknown" })
    );
  });

  it("rejects schema-invalid arguments before reservation or network dispatch", async () => {
    await expect(callTool(scope, "run_action", {
      name: "reserve_slot",
      arguments: { slot: 42 },
      capability_grant: "grant",
    }, { invocationId: providerInvocationId })).resolves.toMatchObject({
      code: "invalid_action_arguments",
    });
    expect(mocks.reserveFlowActionAtomic).not.toHaveBeenCalled();
    expect(mocks.invokeTool).not.toHaveBeenCalled();
  });

  it("keeps downstream replay stable within one call and isolates identical callers", () => {
    const ledgerKey = hashFlowValue({ tool: "reserve_slot", slot: "10:00" });
    const first = downstreamActionIdempotencyKey("org-1", "call-1", ledgerKey);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(downstreamActionIdempotencyKey("org-1", "call-1", ledgerKey)).toBe(first);
    expect(downstreamActionIdempotencyKey("org-1", "call-2", ledgerKey)).not.toBe(first);
    expect(downstreamActionIdempotencyKey("org-2", "call-1", ledgerKey)).not.toBe(first);
  });

  it("preflights a pinned extension before dispatch and unwraps its trusted outcome envelope", async () => {
    mocks.extensionExecutePrepared.mockResolvedValueOnce({
      ok: true,
      executionStarted: true,
      value: { error: "business decline" },
    });

    await expect(executeExtension()).resolves.toMatchObject({
      error: "business decline",
      receipt_status: "succeeded",
    });
    expect(mocks.extensionPreflight).toHaveBeenCalledWith(
      "extension_write",
      { reservation_ref: "REF-1" },
      scope,
      expect.objectContaining({
        name: "extension_write",
        implementationDigest: "e".repeat(64),
        admissionScopeDigest: "c".repeat(64),
      }),
      expect.objectContaining({
        audience: "flow_action",
        invocationId: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/),
        idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        receiptId: expect.stringMatching(/^[a-f0-9-]{36}$/),
        runtimeDigest,
      }),
      expect.arrayContaining([expect.objectContaining({ name: "extension_write" })])
    );
    expect(mocks.extensionPreflight.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.markFlowActionDispatchStartedAtomic.mock.invocationCallOrder[0]);
    expect(mocks.markFlowActionDispatchStartedAtomic.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.extensionExecutePrepared.mock.invocationCallOrder[0]);
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({
        status: "succeeded",
        deliveryState: "committed",
        result: { error: "business decline" },
      })
    );
  });

  it("settles an extension preflight rejection as not sent without crossing dispatch", async () => {
    mocks.extensionPreflight.mockResolvedValueOnce({
      ok: false,
      error: "extension is unavailable",
      code: "extension_unavailable",
      deliveryState: "not_sent",
    });

    await expect(executeExtension()).resolves.toMatchObject({
      code: "action_rejected",
      rejection_code: "extension_unavailable",
      receipt_status: "failed",
    });
    expect(mocks.markFlowActionDispatchStartedAtomic).not.toHaveBeenCalled();
    expect(mocks.extensionExecutePrepared).not.toHaveBeenCalled();
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "failed", deliveryState: "not_sent" })
    );
  });

  it("distinguishes a proven expiry before execution from ambiguous capability replay", async () => {
    mocks.extensionExecutePrepared.mockResolvedValueOnce({
      ok: false,
      executionStarted: false,
      error: "prepared extension invocation expired before execution",
      code: "extension_preflight_expired",
    });
    await expect(executeExtension()).resolves.toMatchObject({
      code: "action_rejected",
      rejection_code: "extension_preflight_expired",
      receipt_status: "failed",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "failed", deliveryState: "rejected" })
    );

    mocks.settleFlowActionAtomic.mockClear();
    mocks.extensionExecutePrepared.mockResolvedValueOnce({
      ok: false,
      executionStarted: false,
      error: "prepared extension invocation is invalid or already consumed",
      code: "invalid_prepared_action",
    });
    await expect(executeExtension()).resolves.toMatchObject({
      code: "action_indeterminate",
      receipt_status: "indeterminate",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "indeterminate", deliveryState: "unknown" })
    );
  });

  it("keeps failures after extension execution starts indeterminate", async () => {
    mocks.extensionExecutePrepared.mockResolvedValueOnce({
      ok: false,
      executionStarted: true,
      error: "extension execution failed",
      code: "extension_execution_failed",
    });

    await expect(executeExtension()).resolves.toMatchObject({
      code: "action_indeterminate",
      receipt_status: "indeterminate",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "indeterminate", deliveryState: "unknown" })
    );
  });

  it("keeps an opaque remote MCP success indeterminate until pinned read-back proof", async () => {
    await expect(executeRemote()).resolves.toMatchObject({
      code: "action_indeterminate",
      receipt_status: "indeterminate",
    });
    expect(mocks.remotePreflight.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.markFlowActionDispatchStartedAtomic.mock.invocationCallOrder[0]);
    expect(mocks.remoteInvoke).toHaveBeenCalledWith(
      scope.orgId,
      expect.objectContaining({ id: "remote-1", catalogHash: remoteCatalogHash }),
      remoteToolName,
      { subject: "Need help" },
      expect.objectContaining({
        invocationId: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/),
        idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({
        status: "indeterminate",
        deliveryState: "unknown",
        error: "remote MCP action has no pinned terminal acknowledgement contract",
      })
    );
  });

  it("terminalizes remote read success and read transport/isError failure from immutable policy", async () => {
    usePinnedPolicyEffect(remoteToolName, "read");
    await expect(executeRemote()).resolves.toMatchObject({
      ticket_id: "T-1",
      receipt_status: "succeeded",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({
        status: "succeeded",
        deliveryState: "committed",
        result: { ticket_id: "T-1" },
      })
    );

    mocks.settleFlowActionAtomic.mockClear();
    // The remote runtime maps both a post-call transport loss and MCP `isError` to this thrown
    // indeterminate signal. For a call-pinned read, neither path can conceal a mutation.
    mocks.remoteInvoke.mockRejectedValueOnce(new Error("remote read response unavailable"));
    await expect(executeRemote()).resolves.toMatchObject({
      code: "action_rejected",
      rejection_code: "effect_safe_action_failed",
      receipt_status: "failed",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "failed", deliveryState: "rejected" })
    );
  });

  it("preserves acknowledged read business payloads with top-level error across every source", async () => {
    usePinnedPolicyEffect("reserve_slot", "read");
    mocks.invokeTool.mockImplementationOnce(async (_endpoint, _input, _signer, context) => ({
      outcome: "succeeded",
      acknowledged: true,
      invocationId: context.invocationId,
      value: { error: "reservation not found", found: false },
    }));
    await expect(execute()).resolves.toMatchObject({
      error: "reservation not found",
      found: false,
      receipt_status: "succeeded",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "succeeded", deliveryState: "committed" })
    );

  });

  it("does not reinterpret acknowledged extension-read business errors, but rejects execution failure", async () => {
    usePinnedPolicyEffect("extension_write", "read");
    mocks.extensionExecutePrepared.mockResolvedValueOnce({
      ok: true,
      executionStarted: true,
      value: { error: "customer has no active membership", found: false },
    });
    await expect(executeExtension()).resolves.toMatchObject({
      error: "customer has no active membership",
      found: false,
      receipt_status: "succeeded",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "succeeded", deliveryState: "committed" })
    );

    mocks.settleFlowActionAtomic.mockClear();
    mocks.extensionExecutePrepared.mockResolvedValueOnce({
      ok: false,
      executionStarted: true,
      error: "read execution failed",
      code: "extension_execution_failed",
    });
    await expect(executeExtension()).resolves.toMatchObject({
      code: "action_rejected",
      receipt_status: "failed",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "failed", deliveryState: "rejected" })
    );
  });

  it("does not reinterpret an acknowledged remote-read business error", async () => {
    usePinnedPolicyEffect(remoteToolName, "read");
    mocks.remoteInvoke.mockResolvedValueOnce({
      outcome: "succeeded",
      acknowledged: true,
      value: { error: "ticket not found", found: false },
    });
    await expect(executeRemote()).resolves.toMatchObject({
      error: "ticket not found",
      found: false,
      receipt_status: "succeeded",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "succeeded", deliveryState: "committed" })
    );
  });

  it("keeps an opaque remote transport/isError failure indeterminate", async () => {
    mocks.remoteInvoke.mockRejectedValueOnce(new Error("remote action response unavailable"));
    await expect(executeRemote()).resolves.toMatchObject({
      code: "action_indeterminate",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "indeterminate", deliveryState: "unknown" })
    );
  });

  it("makes a pinned generated read failure retry-safe while opaque generated failure stays blocked", async () => {
    usePinnedPolicyEffect("reserve_slot", "read");
    mocks.invokeTool.mockRejectedValueOnce(new Error("generated read response unavailable"));
    await expect(execute()).resolves.toMatchObject({
      code: "action_rejected",
      rejection_code: "effect_safe_action_failed",
      receipt_status: "failed",
    });
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "failed", deliveryState: "rejected" })
    );
  });

  it("rejects a remote MCP action before dispatch when its pinned manifest cannot be reverified", async () => {
    mocks.remotePreflight.mockRejectedValueOnce(new Error("schema drift"));

    await expect(executeRemote()).resolves.toMatchObject({
      code: "action_rejected",
      rejection_code: "remote_mcp_preflight_failed",
      receipt_status: "failed",
    });
    expect(mocks.markFlowActionDispatchStartedAtomic).not.toHaveBeenCalled();
    expect(mocks.remoteInvoke).not.toHaveBeenCalled();
    expect(mocks.settleFlowActionAtomic).toHaveBeenLastCalledWith(
      scope.callId,
      expect.objectContaining({ status: "failed", deliveryState: "not_sent" })
    );
  });

  it("rechecks generated read-back revocation after signing and performs zero network calls", async () => {
    const recoveryReceiptId = "1ddc0ffe-1234-5678-9234-0123456789ab";
    const recoveryInvocationId = deriveFlowActionInvocationId(
      `call:${scope.callId}\0receipt:${recoveryReceiptId}`
    );
    const proofOutputSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        invocation_id: { type: "string" },
        terminal: { enum: ["committed", "absent", "pending"] },
        result: {
          type: "object",
          additionalProperties: false,
          properties: { reservation_id: { type: "string" } },
          required: ["reservation_id"],
        },
      },
      required: ["invocation_id", "terminal"],
    };
    const recoveryPolicy = {
      queryTool: "generated_lookup",
      queryArguments: {
        invocation_id: { source: "invocation_id" as const },
      },
      committedWhen: [
        { resultPath: "invocation_id", equals: { source: "invocation_id" as const } },
        { resultPath: "terminal", equals: { source: "literal" as const, value: "committed" } },
      ],
      absentWhen: [
        { resultPath: "invocation_id", equals: { source: "invocation_id" as const } },
        { resultPath: "terminal", equals: { source: "literal" as const, value: "absent" } },
      ],
      queryOutputSchema: proofOutputSchema,
      authoritativeResultPath: "result",
      authoritativeResultSchema: proofOutputSchema.properties.result,
      maxProofAttempts: 3,
    };
    const recoveryFlow = {
      ...flow,
      nodes: flow.nodes.map((node) => node.id !== "operations"
        ? node
        : {
            ...node,
            steps: node.steps?.map((step) => ({
              ...step,
              tools: [...(step.tools ?? []), "generated_lookup"],
              action_policies: [
                ...(step.action_policies ?? []).map((policy) =>
                  policy.tool === "reserve_slot"
                    ? { ...policy, effect: "write" as const, reconciliation: recoveryPolicy }
                    : policy
                ),
                {
                  tool: "generated_lookup",
                  idempotency: "per_arguments" as const,
                  effect: "read" as const,
                },
              ],
            })),
          }),
    };
    const recoverySnapshot = CallRuntimeSnapshotSchema.parse({
      ...runtimeSnapshot,
      flow: recoveryFlow,
      toolManifest: [
        ...runtimeSnapshot.toolManifest,
        {
          id: "tool-lookup",
          slug: "generated_lookup",
          description: "Read one invocation outcome.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: { invocation_id: { type: "string" } },
            required: ["invocation_id"],
          },
          endpointUrl: "https://generated-tool.vercel.app/api/lookup",
          invocationKeyId: "tik_qrstuvwxyzABCDE",
        },
      ],
    });
    const recoveryDigest = callRuntimeDigest(recoverySnapshot);
    const indeterminateReceipt = {
      ...receipt("indeterminate", {
        receiptId: recoveryReceiptId,
        invocationId: recoveryInvocationId,
        tool: "reserve_slot",
        arguments: { slot: "10:00" },
      }),
      error: "response lost after dispatch",
    };
    const recoveryState: FlowExecutionState = {
      ...state,
      actionReceipts: [indeterminateReceipt],
    };
    const client = {
      query: vi.fn(async (sqlValue: string) => {
        const sql = String(sqlValue);
        if (sql.includes("SELECT status, runtime_digest FROM calls")) {
          return { rows: [{ status: "active", runtime_digest: recoveryDigest }], rowCount: 1 };
        }
        if (sql.includes("FROM flow_action_receipts") && sql.includes("FOR UPDATE")) {
          return {
            rows: [{
              status: "indeterminate",
              runtime_digest: recoveryDigest,
              invocation_id: recoveryInvocationId,
              tool: "reserve_slot",
              arguments_hash: indeterminateReceipt.argumentsHash,
              dispatch_started_at: new Date(indeterminateReceipt.dispatchStartedAt!),
              reconciliation_proof_id: null,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("status = 'querying'") && sql.includes("lease_valid")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("COALESCE(MAX(attempt)")) {
          return { rows: [{ last_attempt: 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    mocks.withLockedFlowState.mockImplementation(async (_callId, callback) =>
      callback(recoveryState, client)
    );
    const baseQuery = mocks.qOne.getMockImplementation();
    mocks.qOne.mockImplementation(async (...call) => {
      const sql = String(call[0]);
      const params = call[1] as unknown[] | undefined;
      if (sql.includes("FROM calls c") && sql.includes("JOIN agents")) {
        return {
          status: "active",
          flow: recoveryFlow,
          tool_ids: ["tool-1", "tool-lookup"],
          runtime_snapshot: recoverySnapshot,
          runtime_digest: recoveryDigest,
        };
      }
      if (sql.includes("JOIN tool_invocation_revisions") && params?.[0] === "tool-lookup") {
        return {
          slug: "generated_lookup",
          endpoint_url: "https://generated-tool.vercel.app/api/lookup",
          invocation_key_id: "tik_qrstuvwxyzABCDE",
          invocation_private_key_encrypted: "encrypted-lookup-private-key",
        };
      }
      if (sql.includes("SELECT EXISTS") && sql.includes("tool_invocation_revisions") &&
          params?.[0] === "tool-lookup") {
        return { active: false };
      }
      return baseQuery?.(...call);
    });

    await expect(callTool(
      scope,
      "reconcile_action",
      { receipt_id: recoveryReceiptId },
      { invocationId: `reconcile:${providerInvocationId}` }
    )).resolves.toMatchObject({
      code: "reconciliation_query_failed",
      receipt_id: recoveryReceiptId,
    });
    expect(mocks.prepareToolInvocation).toHaveBeenCalledWith(
      "https://generated-tool.vercel.app/api/lookup",
      { invocation_id: recoveryInvocationId },
      expect.objectContaining({ slug: "generated_lookup" }),
      expect.objectContaining({ audience: "reconciliation", receiptId: recoveryReceiptId })
    );
    expect(mocks.executePreparedToolInvocation).not.toHaveBeenCalled();
    expect(mocks.invokeTool).not.toHaveBeenCalled();
  });
});

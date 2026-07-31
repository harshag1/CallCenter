import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ qOne: vi.fn() }));
vi.mock("../db", () => ({ qOne: mocks.qOne }));

import {
  admitMcpToolInvocation,
  settleMcpToolInvocation,
} from "../mcp-invocation-store";
import { hashFlowValue } from "../flow-runtime";

const identity = {
  callId: "8916eb0a-5332-4f4c-a330-746c516e83b9",
  providerInvocationId: `mcp-provider:v1:${"1".repeat(64)}`,
  logicalName: "classify",
  modelArguments: { topic: "membership" },
  expectedCatalog: {
    catalog_digest: "a".repeat(64),
    capability_epoch: 1,
  },
};

describe("MCP invocation quota admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects oversized persisted arguments before database admission", async () => {
    await expect(admitMcpToolInvocation({
      ...identity,
      modelArguments: { padding: "x".repeat(33 * 1024) },
    })).resolves.toMatchObject({
      execute: false,
      replayed: false,
      result: { code: "tool_invocation_arguments_too_large" },
    });
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it("rejects a catalog epoch that PostgreSQL cannot represent before database admission", async () => {
    await expect(admitMcpToolInvocation({
      ...identity,
      expectedCatalog: {
        ...identity.expectedCatalog,
        capability_epoch: Number.MAX_SAFE_INTEGER,
      },
    })).resolves.toMatchObject({
      execute: false,
      result: { code: "tool_invocation_identity_invalid" },
    });
    expect(mocks.qOne).not.toHaveBeenCalled();
  });

  it.each([
    ["mcp_tool_invocation_rate_exceeded", "tool_invocation_rate_exceeded"],
    ["mcp_tool_invocation_quota_exceeded", "tool_invocation_quota_exceeded"],
    ["mcp_tool_invocation_arguments_too_large", "tool_invocation_arguments_too_large"],
  ])("projects the private database rejection %s to a stable public code", async (message, code) => {
    mocks.qOne.mockRejectedValueOnce({ code: "P0001", message });
    await expect(admitMcpToolInvocation(identity)).resolves.toMatchObject({
      execute: false,
      replayed: false,
      result: { code },
    });
    expect(mocks.qOne).toHaveBeenCalledWith(
      expect.stringMatching(/FROM admit_mcp_tool_invocation/),
      expect.arrayContaining([
        identity.callId,
        identity.providerInvocationId,
        identity.logicalName,
      ])
    );
  });

  it("fails closed when the quota function is missing or returns no durable row", async () => {
    mocks.qOne.mockRejectedValueOnce({ code: "42883", message: "function does not exist" });
    await expect(admitMcpToolInvocation(identity)).rejects.toMatchObject({ code: "42883" });

    mocks.qOne.mockResolvedValueOnce(null);
    await expect(admitMcpToolInvocation(identity)).rejects.toThrow(
      /returned no durable receipt/
    );
  });

  it("replays an existing terminal identity returned by atomic admission without charging again", async () => {
    mocks.qOne.mockResolvedValueOnce({
      id: "8916eb0a-5332-4f4c-a330-746c516e83ba",
      call_id: identity.callId,
      provider_invocation_id: identity.providerInvocationId,
      logical_name: identity.logicalName,
      model_arguments: identity.modelArguments,
      model_arguments_hash: hashFlowValue(identity.modelArguments),
      active_catalog_digest: identity.expectedCatalog.catalog_digest,
      active_catalog_epoch: identity.expectedCatalog.capability_epoch,
      status: "completed",
      owner_token: "8916eb0a-5332-4f4c-a330-746c516e83bb",
      lease_expires_at: new Date(),
      result: { topic: "membership" },
      result_hash: "b".repeat(64),
    });
    await expect(admitMcpToolInvocation(identity, { replayWaitMs: 0 })).resolves.toMatchObject({
      execute: false,
      replayed: true,
      result: { topic: "membership" },
    });
    expect(mocks.qOne).toHaveBeenCalledTimes(1);
  });

  it("settles an expired receipt from exact host recovery before quarantining it", async () => {
    const executing = {
      id: "8916eb0a-5332-4f4c-a330-746c516e83ba",
      call_id: identity.callId,
      provider_invocation_id: identity.providerInvocationId,
      logical_name: identity.logicalName,
      model_arguments: identity.modelArguments,
      model_arguments_hash: hashFlowValue(identity.modelArguments),
      active_catalog_digest: identity.expectedCatalog.catalog_digest,
      active_catalog_epoch: identity.expectedCatalog.capability_epoch,
      status: "executing",
      owner_token: "8916eb0a-5332-4f4c-a330-746c516e83bb",
      lease_expires_at: new Date(Date.now() - 1_000),
      result: null,
      result_hash: null,
    };
    const recoveredResult = { ok: true, worker_id: "worker-1" };
    mocks.qOne
      .mockResolvedValueOnce(executing)
      .mockResolvedValueOnce({
        ...executing,
        status: "completed",
        result: recoveredResult,
        result_hash: hashFlowValue(recoveredResult),
      });
    const recoverExpired = vi.fn().mockResolvedValue({ result: recoveredResult });

    await expect(admitMcpToolInvocation(identity, {
      replayWaitMs: 0,
      recoverExpired,
    })).resolves.toMatchObject({
      execute: false,
      replayed: true,
      result: recoveredResult,
    });
    expect(recoverExpired).toHaveBeenCalledWith(expect.objectContaining({
      receiptId: executing.id,
      callId: identity.callId,
      modelArguments: identity.modelArguments,
    }));
    expect(mocks.qOne.mock.calls[1]?.[0]).toMatch(/'completed'[\s\S]*true/);
    expect(mocks.qOne.mock.calls.some(([sql]) =>
      String(sql).includes("'indeterminate'") && String(sql).includes("true"),
    )).toBe(false);
  });

  it("leaves an expired receipt retryable when proof recovery has a transient failure", async () => {
    mocks.qOne.mockResolvedValueOnce({
      id: "8916eb0a-5332-4f4c-a330-746c516e83ba",
      call_id: identity.callId,
      provider_invocation_id: identity.providerInvocationId,
      logical_name: identity.logicalName,
      model_arguments: identity.modelArguments,
      model_arguments_hash: hashFlowValue(identity.modelArguments),
      active_catalog_digest: identity.expectedCatalog.catalog_digest,
      active_catalog_epoch: identity.expectedCatalog.capability_epoch,
      status: "executing",
      owner_token: "8916eb0a-5332-4f4c-a330-746c516e83bb",
      lease_expires_at: new Date(Date.now() - 1_000),
      result: null,
      result_hash: null,
    });

    await expect(admitMcpToolInvocation(identity, {
      replayWaitMs: 0,
      recoverExpired: vi.fn().mockRejectedValue(new Error("temporary proof read failure")),
    })).resolves.toMatchObject({
      execute: false,
      replayed: false,
      result: { code: "tool_invocation_pending" },
    });
    expect(mocks.qOne).toHaveBeenCalledTimes(1);
  });

  it("replaces an oversized terminal result with a bounded indeterminate receipt", async () => {
    mocks.qOne.mockImplementationOnce((_sql: string, params: unknown[]) => Promise.resolve({
      status: params[2],
      result: JSON.parse(String(params[3])),
      result_hash: params[4],
    }));
    await expect(settleMcpToolInvocation({
      execute: true,
      receiptId: "8916eb0a-5332-4f4c-a330-746c516e83ba",
      ownerToken: "8916eb0a-5332-4f4c-a330-746c516e83bb",
    }, {
      attackerControlled: "x".repeat(65 * 1024),
    })).resolves.toEqual({
      error: "tool result exceeded the durable replay limit",
      code: "tool_invocation_result_too_large",
    });
    expect(mocks.qOne).toHaveBeenCalledWith(
      expect.stringMatching(/FROM settle_mcp_tool_invocation/),
      expect.arrayContaining(["indeterminate"])
    );
  });

  it("falls back to the reserved indeterminate result when cumulative result storage is exhausted", async () => {
    mocks.qOne
      .mockRejectedValueOnce({
        code: "P0001",
        message: "mcp_tool_invocation_result_quota_exceeded",
      })
      .mockImplementationOnce((_sql: string, params: unknown[]) => Promise.resolve({
        status: params[2],
        result: JSON.parse(String(params[3])),
        result_hash: params[4],
      }));
    await expect(settleMcpToolInvocation({
      execute: true,
      receiptId: "8916eb0a-5332-4f4c-a330-746c516e83ba",
      ownerToken: "8916eb0a-5332-4f4c-a330-746c516e83bb",
    }, { ordinary: "result" })).resolves.toEqual({
      error: "tool result exceeded the call's durable replay storage quota",
      code: "tool_invocation_result_quota_exceeded",
    });
    expect(mocks.qOne).toHaveBeenCalledTimes(2);
  });
});

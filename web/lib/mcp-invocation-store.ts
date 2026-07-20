// Durable, call-scoped replay admission for provider-native MCP tool identities.

import { createHash, randomUUID } from "node:crypto";
import { qOne } from "./db";
import { hashFlowValue } from "./flow-runtime";

const INVOCATION_LEASE_MS = 65_000;
const DEFAULT_REPLAY_WAIT_MS = 8_000;
const REPLAY_POLL_MS = 25;
export const MCP_MAX_PERSISTED_MODEL_ARGUMENT_BYTES = 32 * 1024;
const MCP_MAX_PERSISTED_RESULT_BYTES = 64 * 1024;

type ReceiptStatus = "executing" | "completed" | "indeterminate";

type StoredReceipt = {
  id: string;
  call_id: string;
  provider_invocation_id: string;
  logical_name: string;
  model_arguments: Record<string, unknown>;
  model_arguments_hash: string;
  active_catalog_digest: string;
  active_catalog_epoch: number;
  status: ReceiptStatus;
  owner_token: string;
  lease_expires_at: Date | string;
  result: unknown | null;
  result_hash: string | null;
};

export type McpToolInvocationAdmission =
  | Readonly<{
      execute: true;
      receiptId: string;
      ownerToken: string;
    }>
  | Readonly<{
      execute: false;
      receiptId: string;
      result: unknown;
      replayed: boolean;
    }>;

export type McpToolInvocationIdentity = Readonly<{
  callId: string;
  providerInvocationId: string;
  logicalName: string;
  modelArguments: Record<string, unknown>;
  expectedCatalog: Readonly<{
    catalog_digest: string;
    capability_epoch: number;
  }>;
}>;

function receiptIdFor(callId: string, providerInvocationId: string): string {
  const bytes = createHash("sha256")
    .update("hacc/mcp-tool-invocation-receipt/v1\0", "utf8")
    .update(callId, "utf8")
    .update("\0", "utf8")
    .update(providerInvocationId, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function terminalResult(receipt: StoredReceipt): McpToolInvocationAdmission | null {
  if (receipt.status === "executing") return null;
  return {
    execute: false,
    receiptId: receipt.id,
    result: receipt.result,
    replayed: true,
  };
}

function conflict(receiptId: string): McpToolInvocationAdmission {
  return {
    execute: false,
    receiptId,
    result: {
      error: "provider tool-call identity was reused with different tool input",
      code: "provider_invocation_identity_conflict",
    },
    replayed: false,
  };
}

function pending(receiptId: string): McpToolInvocationAdmission {
  return {
    execute: false,
    receiptId,
    result: {
      error: "the original tool invocation is still executing; its outcome is not yet safe to replay",
      code: "tool_invocation_pending",
    },
    replayed: false,
  };
}

function indeterminateValue() {
  return {
    error: "the original tool invocation crossed a process boundary without a durable terminal result",
    code: "tool_invocation_indeterminate",
  };
}

function toJsonWireValue(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("MCP tool result is not representable as JSON");
  }
  return JSON.parse(encoded) as unknown;
}

function rejectedAdmission(
  receiptId: string,
  code:
    | "tool_invocation_arguments_too_large"
    | "tool_invocation_identity_invalid"
    | "tool_invocation_rate_exceeded"
    | "tool_invocation_quota_exceeded"
): McpToolInvocationAdmission {
  const messages = {
    tool_invocation_arguments_too_large:
      "tool arguments exceed the per-invocation durable replay limit",
    tool_invocation_identity_invalid:
      "tool invocation identity is outside the durable replay boundary",
    tool_invocation_rate_exceeded:
      "this call exceeded the server-side fresh tool-invocation rate limit",
    tool_invocation_quota_exceeded:
      "this call exhausted its server-side tool-invocation storage quota",
  } as const;
  return {
    execute: false,
    receiptId,
    result: { error: messages[code], code },
    replayed: false,
  };
}

function databaseAdmissionRejection(error: unknown): Parameters<typeof rejectedAdmission>[1] | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code !== "P0001" || typeof candidate.message !== "string") return null;
  switch (candidate.message) {
    case "mcp_tool_invocation_arguments_too_large":
      return "tool_invocation_arguments_too_large";
    case "mcp_tool_invocation_rate_exceeded":
      return "tool_invocation_rate_exceeded";
    case "mcp_tool_invocation_quota_exceeded":
      return "tool_invocation_quota_exceeded";
    default:
      return null;
  }
}

async function loadReceipt(callId: string, providerInvocationId: string): Promise<StoredReceipt | null> {
  return qOne<StoredReceipt>(
    `SELECT id,call_id,provider_invocation_id,logical_name,model_arguments,model_arguments_hash,
            active_catalog_digest,active_catalog_epoch,status,
            owner_token,lease_expires_at,result,result_hash
     FROM mcp_tool_invocation_receipts
     WHERE call_id=$1 AND provider_invocation_id=$2`,
    [callId, providerInvocationId]
  );
}

async function quarantineExpired(receipt: StoredReceipt): Promise<StoredReceipt | null> {
  const result = indeterminateValue();
  const resultHash = hashFlowValue(result);
  return qOne<StoredReceipt>(
    `SELECT id,call_id,provider_invocation_id,logical_name,model_arguments,model_arguments_hash,
            active_catalog_digest,active_catalog_epoch,status,
            owner_token,lease_expires_at,result,result_hash
     FROM settle_mcp_tool_invocation($1,$2,'indeterminate',$3::jsonb,$4,true)`,
    [receipt.id, receipt.owner_token, JSON.stringify(result), resultHash]
  );
}

export async function admitMcpToolInvocation(
  identity: McpToolInvocationIdentity,
  options: Readonly<{ replayWaitMs?: number }> = {}
): Promise<McpToolInvocationAdmission> {
  const {
    callId,
    providerInvocationId,
    logicalName,
    modelArguments,
    expectedCatalog,
  } = identity;
  const receiptId = receiptIdFor(callId, providerInvocationId);
  if (
    !Number.isSafeInteger(expectedCatalog.capability_epoch) ||
    expectedCatalog.capability_epoch < 0 ||
    expectedCatalog.capability_epoch > 2_147_483_647 ||
    !/^[a-f0-9]{64}$/.test(expectedCatalog.catalog_digest)
  ) {
    return rejectedAdmission(receiptId, "tool_invocation_identity_invalid");
  }
  const wireArguments = toJsonWireValue(modelArguments);
  const encodedArguments = JSON.stringify(wireArguments);
  if (
    !wireArguments ||
    typeof wireArguments !== "object" ||
    Array.isArray(wireArguments) ||
    Buffer.byteLength(encodedArguments, "utf8") > MCP_MAX_PERSISTED_MODEL_ARGUMENT_BYTES
  ) {
    return rejectedAdmission(receiptId, "tool_invocation_arguments_too_large");
  }
  const argumentsHash = hashFlowValue(wireArguments);
  const ownerToken = randomUUID();
  let admitted: StoredReceipt | null;
  try {
    admitted = await qOne<StoredReceipt>(
      `SELECT id,call_id,provider_invocation_id,logical_name,model_arguments,model_arguments_hash,
              active_catalog_digest,active_catalog_epoch,status,
              owner_token,lease_expires_at,result,result_hash
       FROM admit_mcp_tool_invocation(
         $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10
       )`,
      [
        receiptId,
        callId,
        providerInvocationId,
        logicalName,
        encodedArguments,
        argumentsHash,
        expectedCatalog.catalog_digest,
        expectedCatalog.capability_epoch,
        ownerToken,
        INVOCATION_LEASE_MS,
      ]
    );
  } catch (error) {
    const rejection = databaseAdmissionRejection(error);
    if (rejection) return rejectedAdmission(receiptId, rejection);
    throw error;
  }
  if (!admitted) throw new Error("MCP invocation admission returned no durable receipt");
  const inserted = admitted.owner_token === ownerToken && admitted.status === "executing";
  if (inserted) return { execute: true, receiptId: admitted.id, ownerToken };

  const deadline = Date.now() + Math.max(0, Math.min(
    options.replayWaitMs ?? DEFAULT_REPLAY_WAIT_MS,
    DEFAULT_REPLAY_WAIT_MS
  ));
  let receipt = admitted;
  if (receipt.logical_name !== logicalName || receipt.model_arguments_hash !== argumentsHash ||
      receipt.active_catalog_digest !== expectedCatalog.catalog_digest ||
      receipt.active_catalog_epoch !== expectedCatalog.capability_epoch) {
    return conflict(receipt.id);
  }
  const terminal = terminalResult(receipt);
  if (terminal) return terminal;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, REPLAY_POLL_MS));
    const refreshed = await loadReceipt(callId, providerInvocationId);
    if (!refreshed) return conflict(receiptId);
    receipt = refreshed;
    if (receipt.logical_name !== logicalName || receipt.model_arguments_hash !== argumentsHash ||
        receipt.active_catalog_digest !== expectedCatalog.catalog_digest ||
        receipt.active_catalog_epoch !== expectedCatalog.capability_epoch) {
      return conflict(receipt.id);
    }
    const replay = terminalResult(receipt);
    if (replay) return replay;
  }

  const quarantined = await quarantineExpired(receipt);
  const replay = quarantined ? terminalResult(quarantined) : terminalResult(
    await loadReceipt(callId, providerInvocationId) ?? receipt
  );
  return replay ?? pending(receipt.id);
}

export async function settleMcpToolInvocation(
  admission: Extract<McpToolInvocationAdmission, { execute: true }>,
  result: unknown,
  status: "completed" | "indeterminate" = "completed"
): Promise<unknown> {
  // Persist exactly what the MCP JSON response can carry. In particular, tool
  // implementations may return objects containing optional `undefined` fields;
  // JSON omits those fields, so hashing the pre-serialization object would make
  // the first response and a durable replay observably different.
  let wireResult = toJsonWireValue(result);
  if (
    Buffer.byteLength(JSON.stringify(wireResult), "utf8") >
    MCP_MAX_PERSISTED_RESULT_BYTES
  ) {
    wireResult = {
      error: "tool result exceeded the durable replay limit",
      code: "tool_invocation_result_too_large",
    };
    status = "indeterminate";
  }
  let resultHash = hashFlowValue(wireResult);
  const persist = () => qOne<Pick<StoredReceipt, "result" | "result_hash" | "status">>(
    `SELECT status,result,result_hash
     FROM settle_mcp_tool_invocation($1,$2,$3,$4::jsonb,$5,false)`,
    [admission.receiptId, admission.ownerToken, status, JSON.stringify(wireResult), resultHash]
  );
  let settled: Awaited<ReturnType<typeof persist>>;
  try {
    settled = await persist();
  } catch (error) {
    const candidate = error as { code?: unknown; message?: unknown };
    if (
      candidate?.code !== "P0001" ||
      !["mcp_tool_invocation_result_too_large", "mcp_tool_invocation_result_quota_exceeded"]
        .includes(String(candidate.message))
    ) throw error;
    wireResult = {
      error: "tool result exceeded the call's durable replay storage quota",
      code: "tool_invocation_result_quota_exceeded",
    };
    status = "indeterminate";
    resultHash = hashFlowValue(wireResult);
    settled = await persist();
  }
  if (settled?.result_hash === resultHash) return settled.result;
  const existing = await qOne<Pick<StoredReceipt, "result" | "status">>(
    "SELECT result,status FROM mcp_tool_invocation_receipts WHERE id=$1",
    [admission.receiptId]
  );
  return existing?.result ?? indeterminateValue();
}

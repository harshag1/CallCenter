// Durable flow checkpoints. Kept separate from the pure runtime for easy testing and reuse.

import "server-only";

import type { PoolClient } from "pg";
import { getPool, q, qOne } from "./db";
import type { AgentFlow } from "./flow";
import {
  createFlowExecutionState,
  FlowExecutionStateSchema,
  reserveFlowAction,
  settleFlowAction,
  type FlowActionReservation,
  type FlowExecutionState,
  type RuntimeError,
} from "./flow-runtime";

export class FlowStateCorruptionError extends Error {
  constructor(callId: string) {
    super(`persisted flow state for call ${callId} is invalid; execution stopped fail-closed`);
    this.name = "FlowStateCorruptionError";
  }
}

function parsePersistedState(callId: string, value: unknown): FlowExecutionState {
  const parsed = FlowExecutionStateSchema.safeParse(value);
  if (!parsed.success) throw new FlowStateCorruptionError(callId);
  return parsed.data;
}

export async function loadFlowState(callId: string): Promise<FlowExecutionState> {
  const row = await qOne<{ state: unknown }>("SELECT state FROM flow_runs WHERE call_id = $1", [callId]);
  return row ? parsePersistedState(callId, row.state) : createFlowExecutionState();
}
/** Monotonic revision makes repeated/reordered realtime tool calls idempotent. */
export async function saveFlowState(callId: string, state: FlowExecutionState): Promise<FlowExecutionState> {
  const rows = await q<{ state: unknown }>(
    `INSERT INTO flow_runs (call_id, state, revision, updated_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (call_id) DO UPDATE
       SET state = EXCLUDED.state, revision = EXCLUDED.revision, updated_at = now()
       WHERE flow_runs.revision = EXCLUDED.revision - 1
     RETURNING state`,
    [callId, JSON.stringify(state), state.revision]
  );
  if (rows[0]) return parsePersistedState(callId, rows[0].state);
  return loadFlowState(callId);
}

export type LockedFlowMutation<T> = {
  state?: FlowExecutionState;
  value: T;
};

/** Serializes every grant-changing transition and receipt mutation for one call. */
export async function withLockedFlowState<T>(
  callId: string,
  mutate: (state: FlowExecutionState, client: PoolClient) => Promise<LockedFlowMutation<T>> | LockedFlowMutation<T>
): Promise<{ state: FlowExecutionState; value: T }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const initial = createFlowExecutionState("1970-01-01T00:00:00.000Z");
    await client.query(
      `INSERT INTO flow_runs (call_id, state, revision, updated_at)
       VALUES ($1,$2,0,now()) ON CONFLICT (call_id) DO NOTHING`,
      [callId, JSON.stringify(initial)]
    );
    const locked = await client.query<{ state: unknown; revision: number }>(
      "SELECT state, revision FROM flow_runs WHERE call_id = $1 FOR UPDATE",
      [callId]
    );
    if (!locked.rows[0]) throw new Error(`flow state row missing for call ${callId}`);
    const current = parsePersistedState(callId, locked.rows[0].state);
    if (current.revision !== locked.rows[0].revision) {
      throw new FlowStateCorruptionError(callId);
    }
    const outcome = await mutate(current, client);
    const next = outcome.state ?? current;
    if (outcome.state) {
      if (next.revision !== current.revision + 1) {
        throw new Error(`flow mutation must advance exactly one revision (${current.revision} -> ${next.revision})`);
      }
      const updated = await client.query(
        `UPDATE flow_runs SET state = $2, revision = $3, updated_at = now()
         WHERE call_id = $1 AND revision = $4`,
        [callId, JSON.stringify(next), next.revision, current.revision]
      );
      if (updated.rowCount !== 1) throw new Error("flow state changed while its row was locked");
    }
    await client.query("COMMIT");
    return { state: next, value: outcome.value };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export type AtomicActionReservation = FlowActionReservation & { ownerToken?: string };

/** Atomically reserves an action before any network or database side effect is dispatched. */
export async function reserveFlowActionAtomic(
  callId: string,
  flow: AgentFlow,
  args: {
    receiptId: string;
    ownerToken: string;
    runtimeDigest: string;
    tool: string;
    arguments: Record<string, unknown>;
    capabilityEpoch: number;
  }
): Promise<AtomicActionReservation | RuntimeError> {
  const locked = await withLockedFlowState<AtomicActionReservation | RuntimeError>(callId, async (state, client) => {
    const reserved = reserveFlowAction(flow, state, args);
    if ("error" in reserved) return { value: reserved };
    if (!reserved.execute) return { value: reserved };
    const attempt = state.attempts[reserved.receipt.step] ?? 0;
    await client.query(
      `INSERT INTO flow_action_receipts
        (id, call_id, runtime_digest, capability_epoch, step_path, step_attempt, tool,
         arguments, arguments_hash, idempotency_key, status, owner_token, reserved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reserved',$11,$12)`,
      [
        reserved.receipt.id,
        callId,
        args.runtimeDigest,
        reserved.receipt.capabilityEpoch,
        reserved.receipt.step,
        attempt,
        reserved.receipt.tool,
        JSON.stringify(reserved.receipt.arguments),
        reserved.receipt.argumentsHash,
        reserved.receipt.idempotencyKey,
        args.ownerToken,
        reserved.receipt.reservedAt,
      ]
    );
    return { state: reserved.state, value: { ...reserved, ownerToken: args.ownerToken } };
  });
  return locked.value;
}

/** Settles the persisted ledger and embedded replay state in one transaction. */
export async function settleFlowActionAtomic(
  callId: string,
  args: {
    receiptId: string;
    ownerToken: string;
    status: "succeeded" | "failed" | "indeterminate";
    result?: unknown;
    error?: string;
    deliveryState?: "not_sent" | "accepted" | "committed" | "unknown";
  }
): Promise<{ state: FlowExecutionState; receipt: FlowActionReservation["receipt"] } | RuntimeError> {
  type Settlement = { state: FlowExecutionState; receipt: FlowActionReservation["receipt"] } | RuntimeError;
  const locked = await withLockedFlowState<Settlement>(callId, async (state, client) => {
    const row = await client.query<{ status: string; owner_token: string }>(
      "SELECT status, owner_token FROM flow_action_receipts WHERE id = $1 AND call_id = $2 FOR UPDATE",
      [args.receiptId, callId]
    );
    if (!row.rows[0]) return { value: { error: `unknown action receipt "${args.receiptId}"`, code: "unknown_receipt" } as RuntimeError };
    if (row.rows[0].owner_token !== args.ownerToken) {
      return { value: { error: "action receipt is owned by another execution", code: "receipt_owner_mismatch" } as RuntimeError };
    }
    const settled = settleFlowAction(state, args);
    if ("error" in settled) return { value: settled };
    if (settled.state !== state) {
      await client.query(
        `UPDATE flow_action_receipts
         SET status = $3, result = $4, result_hash = $5, error = $6,
             delivery_state = $7, settled_at = $8
         WHERE id = $1 AND call_id = $2 AND owner_token = $9`,
        [
          args.receiptId,
          callId,
          settled.receipt.status,
          args.result === undefined ? null : JSON.stringify(args.result),
          settled.receipt.resultHash ?? null,
          args.error ? JSON.stringify({ message: args.error }) : null,
          args.deliveryState ?? (args.status === "succeeded" ? "committed" : args.status === "failed" ? "not_sent" : "unknown"),
          settled.receipt.settledAt,
          args.ownerToken,
        ]
      );
    }
    return {
      ...(settled.state !== state ? { state: settled.state } : {}),
      value: { state: settled.state, receipt: settled.receipt },
    };
  });
  return locked.value;
}

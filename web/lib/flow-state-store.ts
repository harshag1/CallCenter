// Durable flow checkpoints. Kept separate from the pure runtime for easy testing and reuse.

import "server-only";

import { q, qOne } from "./db";
import { createFlowExecutionState, FlowExecutionStateSchema, type FlowExecutionState } from "./flow-runtime";

export async function loadFlowState(callId: string): Promise<FlowExecutionState> {
  const row = await qOne<{ state: unknown }>("SELECT state FROM flow_runs WHERE call_id = $1", [callId]);
  const parsed = FlowExecutionStateSchema.safeParse(row?.state);
  return parsed.success ? parsed.data : createFlowExecutionState();
}
/** Monotonic revision makes repeated/reordered realtime tool calls idempotent. */
export async function saveFlowState(callId: string, state: FlowExecutionState): Promise<FlowExecutionState> {
  const rows = await q<{ state: unknown }>(
    `INSERT INTO flow_runs (call_id, state, revision, updated_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (call_id) DO UPDATE
       SET state = EXCLUDED.state, revision = EXCLUDED.revision, updated_at = now()
       WHERE flow_runs.revision < EXCLUDED.revision
     RETURNING state`,
    [callId, JSON.stringify(state), state.revision]
  );
  if (rows[0]) return FlowExecutionStateSchema.parse(rows[0].state);
  return loadFlowState(callId);
}

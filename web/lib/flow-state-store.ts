// Durable flow checkpoints. Kept separate from the pure runtime for easy testing and reuse.

import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, q, qOne } from "./db";
import type { AgentFlow } from "./flow";
import {
  evaluatePreDispatch,
  type ConfirmationEvidence,
  type Json,
  type PolicyFact,
  type PolicyReceipt,
  type PreDispatchDecision,
} from "./action-policy-kernel";
import {
  createFlowExecutionState,
  FlowExecutionStateSchema,
  hashFlowValue,
  markFlowActionDispatchStarted,
  markStaleDispatchedActionsIndeterminate,
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

export class FlowStateConflictError extends Error {
  constructor(callId: string, message: string) {
    super(`flow state CAS conflict for call ${callId}: ${message}`);
    this.name = "FlowStateConflictError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

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
  const candidate = parsePersistedState(callId, state);
  const rows = await q<{ state: unknown }>(
    `INSERT INTO flow_runs (call_id, state, revision, updated_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (call_id) DO UPDATE
       SET state = EXCLUDED.state, revision = EXCLUDED.revision, updated_at = now()
       WHERE flow_runs.revision = EXCLUDED.revision - 1
     RETURNING state`,
    [callId, JSON.stringify(candidate), candidate.revision]
  );
  if (rows[0]) return parsePersistedState(callId, rows[0].state);
  const current = await loadFlowState(callId);
  if (current.revision === candidate.revision && hashFlowValue(current) !== hashFlowValue(candidate)) {
    throw new FlowStateConflictError(callId, `revision ${candidate.revision} has different content`);
  }
  if (current.revision < candidate.revision) {
    throw new FlowStateConflictError(callId, `cannot advance revision ${current.revision} directly to ${candidate.revision}`);
  }
  return current;
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
    const changed = !!outcome.state && outcome.state !== current;
    const next = changed ? parsePersistedState(callId, outcome.state) : current;
    if (changed) {
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

export type FlowActionReservationArgs = {
  receiptId: string;
  invocationId: string;
  ownerToken: string;
  runtimeDigest: string;
  tool: string;
  arguments: Record<string, unknown>;
  capabilityEpoch: number;
  providerInvocationId?: string;
};

/** Public result intentionally omits the fact/receipt/confirmation evidence hashes. */
export type GovernedFlowActionDecision = Readonly<{
  decision: PreDispatchDecision["decision"];
  reason: string;
  action: string;
  effect: PreDispatchDecision["effect"];
  proposalDigest: string;
  challengeDigest: string | null;
  decisionDigest: string;
  stateRevision: number;
  capabilityEpoch: number;
}>;

export type GovernedFlowActionResult = Readonly<{
  policy: GovernedFlowActionDecision;
  reservation?: AtomicActionReservation;
  reservationError?: RuntimeError;
}>;

export type GovernedFlowActionArgs = FlowActionReservationArgs & {
  policy: unknown;
  arguments: Record<string, Json>;
  facts: readonly PolicyFact[];
  receipts: readonly PolicyReceipt[];
  confirmation?: ConfirmationEvidence;
};

export type GovernedFlowActionConversationScope = Readonly<{
  conversationId: string;
  organizationId: string;
}>;

const DISPATCH_OWNER_LEASE_MS = 60_000;

async function lockActiveCall(
  client: PoolClient,
  callId: string,
  runtimeDigest: string
): Promise<RuntimeError | null> {
  const call = await client.query<{ status: string; runtime_digest: string | null }>(
    "SELECT status, runtime_digest FROM calls WHERE id = $1 FOR UPDATE",
    [callId]
  );
  if (!call.rows[0] || call.rows[0].status !== "active") {
    return { error: "call tool authority is no longer active", code: "call_not_active" };
  }
  if (!call.rows[0].runtime_digest) {
    return { error: "call has no immutable runtime digest; action stopped fail-closed", code: "runtime_digest_missing" };
  }
  if (call.rows[0].runtime_digest !== runtimeDigest) {
    return { error: "call runtime digest changed; action stopped fail-closed", code: "runtime_digest_mismatch" };
  }
  return null;
}

function actionReservationInputError(args: FlowActionReservationArgs): RuntimeError | null {
  if (!UUID.test(args.receiptId) || !UUID.test(args.ownerToken)) {
    return { error: "receipt and owner identities must be UUIDs", code: "invalid_action_identity" };
  }
  if (!SHA256.test(args.runtimeDigest)) {
    return { error: "runtime digest must be a SHA-256 value", code: "invalid_runtime_digest" };
  }
  return null;
}

async function reserveFlowActionLocked(
  client: PoolClient,
  callId: string,
  flow: AgentFlow,
  state: FlowExecutionState,
  args: FlowActionReservationArgs,
): Promise<LockedFlowMutation<AtomicActionReservation | RuntimeError>> {
  const reserved = reserveFlowAction(flow, state, args);
  if ("error" in reserved) return { value: reserved };
  if (!reserved.execute && reserved.receipt.status === "reserved") {
    const ledger = await client.query<{
      owner_token: string;
      dispatch_started_at: Date | null;
      lease_expired: boolean;
      db_now: Date;
    }>(
      `SELECT owner_token, dispatch_started_at,
              dispatch_lease_expires_at <= now() AS lease_expired,
              now() AS db_now
       FROM flow_action_receipts
       WHERE id = $1 AND call_id = $2
       FOR UPDATE`,
      [reserved.receipt.id, callId]
    );
    const persisted = ledger.rows[0];
    if (!persisted) {
      return { value: { error: "embedded action receipt has no durable ledger row", code: "receipt_ledger_missing" } };
    }
    if (!persisted.lease_expired) return { value: reserved };
    if (persisted.dispatch_started_at) {
      const settled = settleFlowAction(state, {
        receiptId: reserved.receipt.id,
        status: "indeterminate",
        error: "dispatch owner expired after the action crossed the durable dispatch boundary",
      }, persisted.db_now.toISOString());
      if ("error" in settled) return { value: settled };
      await client.query(
        `UPDATE flow_action_receipts
         SET status = 'indeterminate', delivery_state = 'unknown',
             error = $3, settled_at = $4
         WHERE id = $1 AND call_id = $2 AND status = 'reserved'`,
        [
          reserved.receipt.id,
          callId,
          JSON.stringify({ message: "dispatch owner expired after the durable boundary" }),
          settled.receipt.settledAt,
        ]
      );
      return {
        state: settled.state,
        value: { ...reserved, state: settled.state, receipt: settled.receipt, execute: false, replayed: false },
      };
    }
    const reclaimed = await client.query(
      `UPDATE flow_action_receipts
       SET owner_token = $3, dispatch_lease_expires_at = now() + ($4 * interval '1 millisecond'),
           owner_heartbeat_at = now()
       WHERE id = $1 AND call_id = $2 AND status = 'reserved'
         AND dispatch_started_at IS NULL AND dispatch_lease_expires_at <= now()`,
      [reserved.receipt.id, callId, args.ownerToken, DISPATCH_OWNER_LEASE_MS]
    );
    if (reclaimed.rowCount !== 1) return { value: reserved };
    return { value: { ...reserved, execute: true, replayed: false, ownerToken: args.ownerToken } };
  }
  if (!reserved.execute) return { value: reserved };
  if (reserved.receipt.arguments === undefined) {
    return { value: { error: "new action reservation lost its bounded arguments", code: "receipt_state_mismatch" } };
  }
  const attempt = state.attempts[reserved.receipt.step] ?? 0;
  await client.query(
    `INSERT INTO flow_action_receipts
      (id, call_id, runtime_digest, capability_epoch, step_path, step_attempt, tool,
       invocation_id, provider_invocation_id,
       arguments, arguments_hash, idempotency_key, status, owner_token,
       dispatch_lease_expires_at, owner_heartbeat_at, reserved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'reserved',$13,
             now() + ($14 * interval '1 millisecond'),now(),$15)`,
    [
      reserved.receipt.id, callId, args.runtimeDigest, reserved.receipt.capabilityEpoch,
      reserved.receipt.step, attempt, reserved.receipt.tool, reserved.receipt.invocationId,
      reserved.receipt.providerInvocationId ?? null, JSON.stringify(reserved.receipt.arguments),
      reserved.receipt.argumentsHash, reserved.receipt.idempotencyKey, args.ownerToken,
      DISPATCH_OWNER_LEASE_MS, reserved.receipt.reservedAt,
    ]
  );
  return { state: reserved.state, value: { ...reserved, ownerToken: args.ownerToken } };
}

async function rehydrateCompactedReplay(
  callId: string,
  value: AtomicActionReservation | RuntimeError,
): Promise<AtomicActionReservation | RuntimeError> {
  if (
    !("error" in value) &&
    !value.execute &&
    value.receipt.status === "succeeded" &&
    value.receipt.resultCompacted &&
    value.receipt.resultHash
  ) {
    const persisted = await qOne<{ result: unknown; result_hash: string | null }>(
      `SELECT result, result_hash
       FROM flow_action_receipts
       WHERE id = $1 AND call_id = $2 AND status = 'succeeded'`,
      [value.receipt.id, callId]
    );
    if (!persisted || persisted.result_hash !== value.receipt.resultHash ||
        hashFlowValue(persisted.result) !== value.receipt.resultHash) {
      return {
        error: "compacted replay result does not match its durable receipt",
        code: "receipt_state_mismatch",
      };
    }
    const { resultCompacted: _compacted, ...receiptEvidence } = value.receipt;
    void _compacted;
    return {
      ...value,
      receipt: { ...receiptEvidence, result: persisted.result },
    };
  }
  return value;
}

/** Atomically reserves an action before any network or database side effect is dispatched. */
export async function reserveFlowActionAtomic(
  callId: string,
  flow: AgentFlow,
  args: FlowActionReservationArgs,
): Promise<AtomicActionReservation | RuntimeError> {
  const invalid = actionReservationInputError(args);
  if (invalid) return invalid;
  const locked = await withLockedFlowState<AtomicActionReservation | RuntimeError>(callId, async (state, client) => {
    const inactive = await lockActiveCall(client, callId, args.runtimeDigest);
    if (inactive) return { value: inactive };
    return reserveFlowActionLocked(client, callId, flow, state, args);
  });
  return rehydrateCompactedReplay(callId, locked.value);
}

function publicPolicyDecision(decision: PreDispatchDecision): GovernedFlowActionDecision {
  return Object.freeze({
    decision: decision.decision,
    reason: decision.reason,
    action: decision.action,
    effect: decision.effect,
    proposalDigest: decision.proposal_digest,
    challengeDigest: decision.challenge_digest,
    decisionDigest: decision.decision_digest,
    stateRevision: decision.state_revision,
    capabilityEpoch: decision.capability_epoch,
  });
}

/**
 * Evaluates host-authored policy against the exact locked Flow authority and
 * database clock, appends immutable evidence, and only then commits an allowed
 * reservation in that same transaction.
 */
export async function reserveGovernedFlowActionAtomic(
  callId: string,
  flow: AgentFlow,
  args: GovernedFlowActionArgs,
  conversationScope?: GovernedFlowActionConversationScope,
): Promise<GovernedFlowActionResult | RuntimeError> {
  const invalid = actionReservationInputError(args);
  if (invalid) return invalid;
  const locked = await withLockedFlowState<GovernedFlowActionResult | RuntimeError>(
    callId,
    async (state, client) => {
      const inactive = await lockActiveCall(client, callId, args.runtimeDigest);
      if (inactive) return { value: inactive };
      const authority = await client.query<{ evaluated_at: Date; prior_call_count: string }>(
        `SELECT clock_timestamp() AS evaluated_at,
                count(*) FILTER (WHERE dispatch_started_at IS NOT NULL)::text AS prior_call_count
         FROM flow_action_receipts
         WHERE call_id = $1 AND tool = $2`,
        [callId, args.tool]
      );
      const evaluatedAt = authority.rows[0]?.evaluated_at;
      const priorCallCount = Number(authority.rows[0]?.prior_call_count);
      if (!evaluatedAt || !Number.isSafeInteger(priorCallCount) || priorCallCount < 0) {
        return { value: { error: "policy authority could not be established", code: "policy_authority_missing" } };
      }

      let decision: PreDispatchDecision;
      try {
        decision = evaluatePreDispatch({
          policy: args.policy,
          action: args.tool,
          arguments: args.arguments,
          state_head_sha256: hashFlowValue(state),
          state_revision: state.revision,
          capability_epoch: state.capabilityEpoch,
          facts: args.facts,
          receipts: args.receipts,
          prior_call_count: priorCallCount,
          ...(args.confirmation ? { confirmation: args.confirmation } : {}),
          now: evaluatedAt.toISOString(),
        });
      } catch {
        return { value: { error: "action policy input is invalid; reservation stopped fail-closed", code: "policy_evaluation_failed" } };
      }

      const factsSha256 = hashFlowValue(args.facts);
      const receiptsSha256 = hashFlowValue(args.receipts);
      const confirmationSha256 = args.confirmation ? hashFlowValue(args.confirmation) : null;
      if (conversationScope) {
        await client.query(
          `SELECT public.reserve_conversation_call_action_intent(
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
          )`,
          [
            args.receiptId,
            callId,
            conversationScope.conversationId,
            conversationScope.organizationId,
            args.invocationId,
            args.runtimeDigest,
            args.capabilityEpoch,
            args.tool,
            decision.policy_digest,
            decision.arguments_sha256,
            factsSha256,
            receiptsSha256,
            confirmationSha256,
          ],
        );
      }

      let mutation: LockedFlowMutation<AtomicActionReservation | RuntimeError> = {
        value: { error: `action policy ${decision.decision}: ${decision.reason}`, code: `policy_${decision.decision}` },
      };
      if (decision.decision === "allow") {
        mutation = await reserveFlowActionLocked(client, callId, flow, state, args);
      }
      const reservation = "error" in mutation.value ? undefined : mutation.value;
      const authorityBundleDigest = hashFlowValue({
        stateHeadSha256: decision.state_head_sha256,
        stateRevision: decision.state_revision,
        capabilityEpoch: decision.capability_epoch,
        argumentsSha256: decision.arguments_sha256,
        factsSha256,
        receiptsSha256,
        confirmationSha256,
        priorCallCount,
        evaluatedAt: evaluatedAt.toISOString(),
      });
      await client.query(
        `SELECT public.append_flow_action_policy_decision(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
        )`,
        [
          randomUUID(), callId, reservation?.receipt.id ?? null, decision.action,
          decision.decision, decision.reason, decision.effect, decision.policy_digest,
          decision.state_head_sha256, decision.state_revision, decision.capability_epoch,
          decision.arguments_sha256, decision.proposal_digest, decision.challenge_digest,
          JSON.stringify(decision.evidence_sha256), factsSha256,
          receiptsSha256, confirmationSha256,
          priorCallCount, authorityBundleDigest, decision.decision_digest, evaluatedAt,
        ]
      );
      const result: GovernedFlowActionResult = {
        policy: publicPolicyDecision(decision),
        ...(reservation ? { reservation } : {}),
        ...("error" in mutation.value && decision.decision === "allow" ? { reservationError: mutation.value } : {}),
      };
      return { ...(mutation.state ? { state: mutation.state } : {}), value: result };
    }
  );
  if ("error" in locked.value || !locked.value.reservation) return locked.value;
  const reservation = await rehydrateCompactedReplay(callId, locked.value.reservation);
  if ("error" in reservation) {
    return { ...locked.value, reservation: undefined, reservationError: reservation };
  }
  return {
    ...locked.value,
    reservation,
  };
}

/** One-shot permit: after this commits, a crash is always recovered as indeterminate. */
export async function markFlowActionDispatchStartedAtomic(
  callId: string,
  args: { receiptId: string; ownerToken: string; runtimeDigest: string }
): Promise<{ state: FlowExecutionState; receipt: FlowActionReservation["receipt"] } | RuntimeError> {
  type Marked = { state: FlowExecutionState; receipt: FlowActionReservation["receipt"] } | RuntimeError;
  if (!UUID.test(args.receiptId) || !UUID.test(args.ownerToken)) {
    return { error: "receipt and owner identities must be UUIDs", code: "invalid_action_identity" };
  }
  if (!SHA256.test(args.runtimeDigest)) {
    return { error: "runtime digest must be a SHA-256 value", code: "invalid_runtime_digest" };
  }
  const locked = await withLockedFlowState<Marked>(callId, async (state, client) => {
    const inactive = await lockActiveCall(client, callId, args.runtimeDigest);
    if (inactive) return { value: inactive };
    const ledger = await client.query<{
      status: string;
      owner_token: string;
      dispatch_started_at: Date | null;
      lease_valid: boolean;
      db_now: Date;
    }>(
      `SELECT status, owner_token, dispatch_started_at,
              dispatch_lease_expires_at > now() AS lease_valid,
              now() AS db_now
       FROM flow_action_receipts
       WHERE id = $1 AND call_id = $2
       FOR UPDATE`,
      [args.receiptId, callId]
    );
    const row = ledger.rows[0];
    if (!row) return { value: { error: `unknown action receipt "${args.receiptId}"`, code: "unknown_receipt" } };
    if (row.owner_token !== args.ownerToken) {
      return { value: { error: "action receipt is owned by another execution", code: "receipt_owner_mismatch" } };
    }
    if (row.status !== "reserved" || row.dispatch_started_at) {
      return { value: { error: "action receipt already crossed or left the dispatch boundary", code: "dispatch_already_started" } };
    }
    if (!row.lease_valid) {
      return { value: { error: "action dispatch ownership expired before dispatch", code: "dispatch_owner_expired" } };
    }
    const marked = markFlowActionDispatchStarted(state, { receiptId: args.receiptId }, row.db_now.toISOString());
    if ("error" in marked) return { value: marked };
    const updated = await client.query(
      `UPDATE flow_action_receipts
       SET dispatch_started_at = $4, dispatch_attempt = dispatch_attempt + 1,
           delivery_state = 'unknown', owner_heartbeat_at = $4,
           dispatch_lease_expires_at = $4::timestamptz + ($5 * interval '1 millisecond')
       WHERE id = $1 AND call_id = $2 AND owner_token = $3
         AND status = 'reserved' AND dispatch_started_at IS NULL`,
      [args.receiptId, callId, args.ownerToken, marked.receipt.dispatchStartedAt, DISPATCH_OWNER_LEASE_MS]
    );
    if (updated.rowCount !== 1) throw new Error("action dispatch boundary changed while locked");
    return { state: marked.state, value: marked };
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
    deliveryState?: "not_sent" | "accepted" | "rejected" | "committed" | "unknown";
  }
): Promise<{ state: FlowExecutionState; receipt: FlowActionReservation["receipt"] } | RuntimeError> {
  type Settlement = { state: FlowExecutionState; receipt: FlowActionReservation["receipt"] } | RuntimeError;
  const locked = await withLockedFlowState<Settlement>(callId, async (state, client) => {
    const row = await client.query<{ status: string; owner_token: string; dispatch_started_at: Date | null }>(
      "SELECT status, owner_token, dispatch_started_at FROM flow_action_receipts WHERE id = $1 AND call_id = $2 FOR UPDATE",
      [args.receiptId, callId]
    );
    if (!row.rows[0]) return { value: { error: `unknown action receipt "${args.receiptId}"`, code: "unknown_receipt" } as RuntimeError };
    if (row.rows[0].owner_token !== args.ownerToken) {
      return { value: { error: "action receipt is owned by another execution", code: "receipt_owner_mismatch" } as RuntimeError };
    }
    if (row.rows[0].status !== "reserved") {
      const replay = settleFlowAction(state, args);
      return { value: replay };
    }
    if (args.status === "failed" && row.rows[0].dispatch_started_at && args.deliveryState !== "rejected") {
      return { value: { error: "a dispatched action cannot be declared not sent", code: "invalid_delivery_transition" } as RuntimeError };
    }
    if (args.status === "failed" && !row.rows[0].dispatch_started_at && args.deliveryState && args.deliveryState !== "not_sent") {
      return { value: { error: "an undispatched failure must remain not_sent", code: "invalid_delivery_transition" } as RuntimeError };
    }
    if (args.status !== "failed" && !row.rows[0].dispatch_started_at) {
      return { value: { error: "action outcome cannot settle before its dispatch boundary", code: "dispatch_not_started" } as RuntimeError };
    }
    if (args.status === "succeeded" && args.deliveryState && args.deliveryState !== "committed") {
      return { value: { error: "successful action evidence must be committed", code: "invalid_delivery_transition" } as RuntimeError };
    }
    if (args.status === "indeterminate" && args.deliveryState && !["accepted", "unknown"].includes(args.deliveryState)) {
      return { value: { error: "indeterminate action delivery must be accepted or unknown", code: "invalid_delivery_transition" } as RuntimeError };
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

/** Repairs abandoned post-boundary owners without ever making their effect dispatchable again. */
export async function recoverStaleFlowActionsAtomic(callId: string): Promise<FlowExecutionState> {
  const locked = await withLockedFlowState<null>(callId, async (state, client) => {
    const stale = await client.query<{ id: string; db_now: Date }>(
      `SELECT id, now() AS db_now
       FROM flow_action_receipts
       WHERE call_id = $1 AND status = 'reserved'
         AND dispatch_started_at IS NOT NULL
         AND dispatch_lease_expires_at <= now()
       FOR UPDATE`,
      [callId]
    );
    if (!stale.rows.length) return { value: null };
    const at = stale.rows[0].db_now.toISOString();
    const ids = stale.rows.map((row) => row.id);
    if (ids.some((id) => {
      const receipt = state.actionReceipts.find((candidate) => candidate.id === id);
      return !receipt || receipt.status !== "reserved" || !receipt.dispatchStartedAt;
    })) {
      throw new FlowStateCorruptionError(callId);
    }
    const next = markStaleDispatchedActionsIndeterminate(state, ids, at);
    if (next === state) throw new FlowStateCorruptionError(callId);
    await client.query(
      `UPDATE flow_action_receipts
       SET status = 'indeterminate', delivery_state = 'unknown',
           error = $3, settled_at = $4
       WHERE call_id = $1 AND id = ANY($2::uuid[]) AND status = 'reserved'`,
      [
        callId,
        ids,
        JSON.stringify({ message: "dispatch owner expired after the durable boundary" }),
        at,
      ]
    );
    return { ...(next !== state ? { state: next } : {}), value: null };
  });
  return locked.state;
}

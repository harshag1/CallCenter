// Server-side authority boundary for operator actions with external or funded effects.

import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, q } from "../../db";
import type { ToolCtx } from "../types";

export const FUNDED_OPERATOR_CAPABILITIES = Object.freeze([
  "send_email",
  "send_sms",
  "place_call",
  "schedule_call",
  "provision_phone_number",
  "run_campaign",
] as const);

export type FundedOperatorCapability = (typeof FUNDED_OPERATOR_CAPABILITIES)[number];

const CAPABILITY_SET = new Set<string>(FUNDED_OPERATOR_CAPABILITIES);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_PRIVATE_DISPLAY_BYTES = 256 * 1024;
const MAX_PENDING_PROPOSALS_PER_HOUR = 20;
// This fixed, non-secret sentinel can only traverse the already-succeeded
// execution replay branch. It is deliberately rejected before any fresh
// reservation, so reconstructing a durable receipt never mints new authority.
const REPLAY_ONLY_CONFIRMATION_TOKEN = "replay_only_no_confirmation_authority";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function normalizedJson(value: unknown, path = "$", ancestors = new Set<object>()): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error(`${path} contains an unsafe number`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new Error(`${path} is not JSON-serializable`);
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item, index) => normalizedJson(item, `${path}[${index}]`, ancestors));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error(`${path} must contain plain JSON objects`);
    }
    const output: Record<string, Json> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = normalizedJson((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizedJson(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function checkedCapability(value: string): asserts value is FundedOperatorCapability {
  if (!CAPABILITY_SET.has(value)) throw new Error("unsupported operator action capability");
}

export function operatorActionArgumentsSha256(
  capability: FundedOperatorCapability,
  argumentsValue: unknown
): string {
  checkedCapability(capability);
  return sha256(`harshas-amazing-call-center/operator-action-arguments/v1\n${canonicalJson({
    capability,
    arguments: argumentsValue,
  })}`);
}

/** Missing users, basic users, missing migrations, and missing/disabled policy
 * rows all produce an empty capability set. Discovery never fails open. */
export async function discoverFundedOperatorCapabilities(ctx: ToolCtx): Promise<ReadonlySet<FundedOperatorCapability>> {
  try {
    const rows = await q<{ operator_role: string; capability: string }>(
      `SELECT u.operator_role, p.capability
       FROM users u
       JOIN operator_action_policies p ON p.org_id = u.org_id AND p.enabled = true
       WHERE u.email = $1 AND u.org_id = $2`,
      [ctx.email, ctx.orgId]
    );
    if (!rows.length || !rows.every((row) => row.operator_role === "operator" || row.operator_role === "admin")) {
      return new Set<FundedOperatorCapability>();
    }
    return new Set(rows
      .map((row) => row.capability)
      .filter((capability): capability is FundedOperatorCapability => CAPABILITY_SET.has(capability)));
  } catch {
    return new Set<FundedOperatorCapability>();
  }
}

export class OperatorActionDeniedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OperatorActionDeniedError";
  }
}

export type OperatorActionProposal = Readonly<{
  schemaVersion: 1;
  proposalId: string;
  capability: FundedOperatorCapability;
  arguments: Json;
  argumentsSha256: string;
  estimatedUnits: number;
  worstCaseMicroUsd: number;
  expiresAt: string;
}>;

function freezeJson(value: Json): Json {
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
    return Object.freeze(value) as unknown as Json;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeJson(item);
    return Object.freeze(value) as unknown as Json;
  }
  return value;
}

/** Runtime projection for the SSE/model-history boundary. Tool result types are
 * not authority: copy only the public proposal fields and re-verify the exact
 * argument commitment before anything reaches the browser. */
export function projectOperatorActionProposal(value: unknown): OperatorActionProposal | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    if (input.schemaVersion !== 1
        || typeof input.proposalId !== "string" || !UUID.test(input.proposalId)
        || typeof input.capability !== "string" || !CAPABILITY_SET.has(input.capability)
        || typeof input.argumentsSha256 !== "string" || !SHA256_HEX.test(input.argumentsSha256)
        || typeof input.expiresAt !== "string" || input.expiresAt.length > 64) return null;
    const capability = input.capability as FundedOperatorCapability;
    const argumentsValue = normalizedJson(input.arguments);
    if (!argumentsValue || Array.isArray(argumentsValue) || typeof argumentsValue !== "object") return null;
    checkedActionEstimate(Number(input.estimatedUnits), Number(input.worstCaseMicroUsd));
    if (input.estimatedUnits !== Number(input.estimatedUnits)
        || input.worstCaseMicroUsd !== Number(input.worstCaseMicroUsd)
        || operatorActionArgumentsSha256(capability, argumentsValue) !== input.argumentsSha256) return null;
    const expiresAtMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAtMs) || new Date(expiresAtMs).toISOString() !== input.expiresAt) return null;
    return Object.freeze({
      schemaVersion: 1,
      proposalId: input.proposalId,
      capability,
      arguments: freezeJson(argumentsValue) as Json,
      argumentsSha256: input.argumentsSha256,
      estimatedUnits: Number(input.estimatedUnits),
      worstCaseMicroUsd: Number(input.worstCaseMicroUsd),
      expiresAt: input.expiresAt,
    });
  } catch {
    return null;
  }
}

function checkedActionEstimate(estimatedUnits: number, estimatedMicroUsd: number): void {
  if (!Number.isSafeInteger(estimatedUnits) || estimatedUnits < 1 || estimatedUnits > 100_000) {
    throw new OperatorActionDeniedError("invalid_action_units");
  }
  if (!Number.isSafeInteger(estimatedMicroUsd) || estimatedMicroUsd < 0 || estimatedMicroUsd > 1_000_000_000_000) {
    throw new OperatorActionDeniedError("invalid_action_cost");
  }
}

/** Creates a non-authoritative proposal for the browser to render. The model
 * may propose an action but cannot approve it or receive an execution token. */
export async function proposeOperatorAction(input: Readonly<{
  ctx: ToolCtx;
  capability: FundedOperatorCapability;
  argumentsValue: unknown;
  /** Stored under server-only RLS for browser review; never returned in the
   * proposal, SSE event, tool output, or model transcript. */
  privateDisplay?: unknown;
  estimatedUnits: number;
  estimatedMicroUsd: number;
}>): Promise<OperatorActionProposal> {
  checkedCapability(input.capability);
  if (!UUID.test(input.ctx.orgId) || !UUID.test(input.ctx.threadId ?? "")) {
    throw new OperatorActionDeniedError("invalid_operator_action_context");
  }
  checkedActionEstimate(input.estimatedUnits, input.estimatedMicroUsd);
  const normalizedArguments = normalizedJson(input.argumentsValue);
  if (!normalizedArguments || Array.isArray(normalizedArguments) || typeof normalizedArguments !== "object") {
    throw new OperatorActionDeniedError("invalid_action_arguments");
  }
  const encodedArguments = JSON.stringify(normalizedArguments);
  if (Buffer.byteLength(encodedArguments, "utf8") > MAX_RESULT_BYTES) {
    throw new OperatorActionDeniedError("action_arguments_too_large");
  }
  let encodedPrivateDisplay: string | null = null;
  if (input.privateDisplay !== undefined) {
    const privateDisplay = normalizedJson(input.privateDisplay);
    if (!privateDisplay || Array.isArray(privateDisplay) || typeof privateDisplay !== "object") {
      throw new OperatorActionDeniedError("invalid_private_action_display");
    }
    encodedPrivateDisplay = JSON.stringify(privateDisplay);
    if (Buffer.byteLength(encodedPrivateDisplay, "utf8") > MAX_PRIVATE_DISPLAY_BYTES) {
      throw new OperatorActionDeniedError("private_action_display_too_large");
    }
  }
  const argumentsSha256 = operatorActionArgumentsSha256(input.capability, normalizedArguments);
  let client: PoolClient | null = null;
  let row: { id: string; expires_at: string | Date } | null = null;
  try {
    client = await getPool().connect();
    await client.query("BEGIN");
    // The limit spans capabilities, so serialize on the tenant+actor rather
    // than a policy row. A separate statement after acquiring the transaction
    // lock gets a fresh READ COMMITTED snapshot and sees prior commits.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext(lower($2)))",
      [input.ctx.orgId, input.ctx.email]
    );
    const inserted = await client.query<{ id: string; expires_at: string | Date }>(
      `WITH scrubbed AS (
       UPDATE operator_action_approvals
       SET private_display = NULL
       WHERE org_id = $2 AND expires_at <= now() AND private_display IS NOT NULL
     ), authority AS (
       SELECT 1
       FROM users u
       JOIN operator_action_policies p
         ON p.org_id = u.org_id AND p.capability = $4 AND p.enabled = true
       WHERE u.email = $1 AND u.org_id = $2
         AND u.operator_role IN ('operator','admin')
     ), recent AS (
       SELECT count(*)::int AS proposals
       FROM operator_action_approvals
       WHERE org_id = $2 AND actor_email = $1
         AND created_at >= now() - interval '1 hour'
     )
     INSERT INTO operator_action_approvals
       (org_id, actor_email, thread_id, capability, action_arguments,
        arguments_sha256, estimated_units, estimated_micro_usd, private_display, expires_at)
     SELECT $2,$1,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,now() + interval '10 minutes'
     FROM authority, recent
     WHERE recent.proposals < $10
       RETURNING id, expires_at`,
      [
        input.ctx.email,
        input.ctx.orgId,
        input.ctx.threadId,
        input.capability,
        encodedArguments,
        argumentsSha256,
        input.estimatedUnits,
        input.estimatedMicroUsd,
        encodedPrivateDisplay,
        MAX_PENDING_PROPOSALS_PER_HOUR,
      ]
    );
    row = inserted.rows[0] ?? null;
    if (!row) throw new OperatorActionDeniedError("operator_action_proposal_denied");
    await client.query("COMMIT");
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => {});
    if (error instanceof OperatorActionDeniedError) throw error;
    throw new OperatorActionDeniedError("operator_action_proposal_unavailable");
  } finally {
    client?.release();
  }
  const expiresAtMs = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    throw new OperatorActionDeniedError("operator_action_proposal_unavailable");
  }
  const expiresAt = new Date(expiresAtMs).toISOString();
  return Object.freeze({
    schemaVersion: 1,
    proposalId: row.id,
    capability: input.capability,
    arguments: normalizedArguments,
    argumentsSha256,
    estimatedUnits: input.estimatedUnits,
    worstCaseMicroUsd: input.estimatedMicroUsd,
    expiresAt,
  });
}

export type ApprovedOperatorAction = Readonly<{
  approvalId: string;
  ctx: ToolCtx;
  capability: FundedOperatorCapability;
  argumentsValue: Json;
  confirmationToken: string;
  idempotencyKey: string;
  estimatedUnits: number;
  estimatedMicroUsd: number;
}>;

/** Same-origin approval routes call this immediately before dispatch. The
 * plaintext token exists only in this server stack frame and is never returned
 * to the browser or placed in chat/model context. */
export async function approveOperatorActionProposal(input: Readonly<{
  ctx: ToolCtx;
  proposalId: string;
}>): Promise<ApprovedOperatorAction> {
  if (!UUID.test(input.ctx.orgId) || !UUID.test(input.ctx.threadId ?? "") || !UUID.test(input.proposalId)) {
    throw new OperatorActionDeniedError("invalid_operator_action_context");
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const membership = await client.query<{ operator_role: string }>(
      `SELECT operator_role FROM users
       WHERE email = $1 AND org_id = $2
       FOR SHARE`,
      [input.ctx.email, input.ctx.orgId]
    );
    const role = membership.rows[0]?.operator_role;
    if (role !== "operator" && role !== "admin") throw new OperatorActionDeniedError("operator_role_required");

    const proposal = await client.query<{
      capability: string;
      action_arguments: unknown;
      arguments_sha256: string;
      estimated_units: number;
      estimated_micro_usd: string;
      approved_at: string | Date | null;
      consumed_execution_id: string | null;
      expires_at: string | Date;
    }>(
      `SELECT capability, action_arguments, arguments_sha256, estimated_units,
              estimated_micro_usd::text, approved_at, consumed_execution_id, expires_at
       FROM operator_action_approvals
       WHERE id = $1 AND org_id = $2 AND actor_email = $3 AND thread_id = $4
       FOR UPDATE`,
      [input.proposalId, input.ctx.orgId, input.ctx.email, input.ctx.threadId]
    );
    const row = proposal.rows[0];
    if (!row || !CAPABILITY_SET.has(row.capability)) {
      throw new OperatorActionDeniedError("operator_action_proposal_unavailable");
    }
    const capability = row.capability as FundedOperatorCapability;
    const policy = await client.query<{ enabled: boolean }>(
      `SELECT enabled FROM operator_action_policies
       WHERE org_id = $1 AND capability = $2`,
      [input.ctx.orgId, capability]
    );
    if (!policy.rows[0]?.enabled) throw new OperatorActionDeniedError("capability_policy_required");
    checkedActionEstimate(row.estimated_units, Number(row.estimated_micro_usd));
    const argumentsValue = normalizedJson(row.action_arguments);
    if (!argumentsValue || Array.isArray(argumentsValue) || typeof argumentsValue !== "object"
        || operatorActionArgumentsSha256(capability, argumentsValue) !== row.arguments_sha256) {
      throw new OperatorActionDeniedError("operator_action_proposal_integrity_failed");
    }

    const execution = await client.query<{
      id: string;
      actor_email: string;
      arguments_sha256: string;
      estimated_units: number;
      estimated_micro_usd: string;
      status: string;
      has_result: boolean;
    }>(
      `SELECT id, actor_email, arguments_sha256, estimated_units,
              estimated_micro_usd::text, status, (result IS NOT NULL) AS has_result
       FROM operator_action_executions
       WHERE org_id = $1 AND capability = $2 AND idempotency_key = $3`,
      [input.ctx.orgId, capability, input.proposalId]
    );
    const prior = execution.rows[0];
    if (prior) {
      const exactTerminalReplay = prior.actor_email === input.ctx.email
        && prior.arguments_sha256 === row.arguments_sha256
        && prior.estimated_units === row.estimated_units
        && Number(prior.estimated_micro_usd) === Number(row.estimated_micro_usd)
        && row.approved_at !== null
        && row.consumed_execution_id === prior.id
        && prior.status === "succeeded"
        && prior.has_result === true;
      if (!exactTerminalReplay) {
        throw new OperatorActionDeniedError("approval_in_progress_or_outcome_unknown_do_not_retry");
      }
      await client.query("COMMIT");
      return Object.freeze({
        approvalId: input.proposalId,
        ctx: input.ctx,
        capability,
        argumentsValue,
        confirmationToken: REPLAY_ONLY_CONFIRMATION_TOKEN,
        idempotencyKey: input.proposalId,
        estimatedUnits: row.estimated_units,
        estimatedMicroUsd: Number(row.estimated_micro_usd),
      });
    }

    // Only fresh authority expires. A previously settled, exactly bound
    // execution is handled above so its durable receipt remains reconstructable
    // after proposal expiry without rotating or reissuing a token.
    const approvalClock = await client.query<{ now: string | Date }>(
      "SELECT clock_timestamp() AS now"
    );
    const lockedNowMs = new Date(approvalClock.rows[0]?.now ?? "").getTime();
    const expiresAtMs = new Date(row.expires_at).getTime();
    if (!Number.isFinite(lockedNowMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= lockedNowMs) {
      throw new OperatorActionDeniedError("operator_action_proposal_unavailable");
    }
    if (row.approved_at !== null || row.consumed_execution_id !== null) {
      // The plaintext token is deliberately never persisted. Re-approving an
      // unconsumed proposal would therefore have to rotate the stored hash and
      // could invalidate an in-flight request from another tab. Fail closed;
      // an already-consumed exact terminal execution used the replay path above.
      throw new OperatorActionDeniedError("approval_in_progress_or_outcome_unknown_do_not_retry");
    }
    const confirmationToken = randomBytes(32).toString("base64url");
    const tokenSha256 = sha256(confirmationToken);
    const issued = await client.query(
      `UPDATE operator_action_approvals
       SET approved_by = $2,
           approved_at = now(),
           token_sha256 = $3,
           token_issued_at = now()
       WHERE id = $1 AND consumed_execution_id IS NULL
         AND approved_by IS NULL AND approved_at IS NULL
         AND token_sha256 IS NULL AND token_issued_at IS NULL
       RETURNING id`,
      [input.proposalId, input.ctx.email, tokenSha256]
    );
    if (issued.rowCount !== 1) throw new OperatorActionDeniedError("operator_action_proposal_unavailable");
    await client.query("COMMIT");
    return Object.freeze({
      approvalId: input.proposalId,
      ctx: input.ctx,
      capability,
      argumentsValue,
      confirmationToken,
      idempotencyKey: input.proposalId,
      estimatedUnits: row.estimated_units,
      estimatedMicroUsd: Number(row.estimated_micro_usd),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof OperatorActionDeniedError) throw error;
    throw new OperatorActionDeniedError("action_policy_unavailable");
  } finally {
    client.release();
  }
}

type Reservation<T> =
  | Readonly<{ kind: "execute"; executionId: string }>
  | Readonly<{ kind: "replay"; result: T }>;

function costCoverage(capability: FundedOperatorCapability): string {
  switch (capability) {
    case "send_email": return "email_send";
    case "send_sms": return "sms_transport";
    case "place_call":
    case "schedule_call": return "voice_connectivity";
    case "provision_phone_number": return "phone_number_month";
    case "run_campaign": return "campaign_voice_connectivity";
  }
}

async function reserveAction<T>(input: Readonly<{
  ctx: ToolCtx;
  capability: FundedOperatorCapability;
  argumentsValue: unknown;
  confirmationToken: string;
  approvalId: string;
  idempotencyKey: string;
  estimatedUnits: number;
  estimatedMicroUsd: number;
}>): Promise<Reservation<T>> {
  checkedCapability(input.capability);
  if (!UUID.test(input.ctx.orgId)) throw new OperatorActionDeniedError("invalid_tenant_identity");
  if (!UUID.test(input.ctx.threadId ?? "") || !UUID.test(input.approvalId)) {
    throw new OperatorActionDeniedError("invalid_operator_action_context");
  }
  if (input.idempotencyKey !== input.approvalId) {
    throw new OperatorActionDeniedError("approval_idempotency_mismatch");
  }
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw new OperatorActionDeniedError("invalid_idempotency_key");
  if (
    typeof input.confirmationToken !== "string"
    || input.confirmationToken.length < 32
    || input.confirmationToken.length > 512
    || /[^\x21-\x7e]/.test(input.confirmationToken)
  ) throw new OperatorActionDeniedError("invalid_confirmation_token");
  checkedActionEstimate(input.estimatedUnits, input.estimatedMicroUsd);

  const argumentsSha256 = operatorActionArgumentsSha256(input.capability, input.argumentsValue);
  const tokenSha256 = sha256(input.confirmationToken);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const membership = await client.query<{ operator_role: string }>(
      `SELECT operator_role FROM users
       WHERE email = $1 AND org_id = $2
       FOR SHARE`,
      [input.ctx.email, input.ctx.orgId]
    );
    const role = membership.rows[0]?.operator_role;
    if (role !== "operator" && role !== "admin") throw new OperatorActionDeniedError("operator_role_required");

    const policy = await client.query<{
      enabled: boolean;
      daily_action_limit: number;
      daily_spend_limit_micro_usd: string;
    }>(
      `SELECT enabled, daily_action_limit, daily_spend_limit_micro_usd
       FROM operator_action_policies
       WHERE org_id = $1 AND capability = $2
       FOR UPDATE`,
      [input.ctx.orgId, input.capability]
    );
    const policyRow = policy.rows[0];
    if (!policyRow?.enabled) throw new OperatorActionDeniedError("capability_policy_required");

    const existing = await client.query<{
      actor_email: string;
      arguments_sha256: string;
      estimated_units: number;
      estimated_micro_usd: string;
      status: string;
      has_result: boolean;
      result: T | null;
      approval_id: string | null;
      approval_actor_email: string | null;
      approval_thread_id: string | null;
    }>(
      `SELECT oe.actor_email, oe.arguments_sha256,
              oe.estimated_units, oe.estimated_micro_usd::text,
              oe.status, (oe.result IS NOT NULL) AS has_result, oe.result,
              oa.id AS approval_id,
              oa.actor_email AS approval_actor_email,
              oa.thread_id AS approval_thread_id
       FROM operator_action_executions oe
       LEFT JOIN operator_action_approvals oa
         ON oa.consumed_execution_id = oe.id
        AND oa.org_id = oe.org_id
        AND oa.capability = oe.capability
       WHERE oe.org_id = $1 AND oe.capability = $2
         AND oe.idempotency_key = $3
       FOR UPDATE OF oe`,
      [input.ctx.orgId, input.capability, input.idempotencyKey]
    );
    const prior = existing.rows[0];
    if (prior) {
      if (prior.actor_email !== input.ctx.email) throw new OperatorActionDeniedError("idempotency_actor_conflict");
      if (prior.arguments_sha256 !== argumentsSha256) throw new OperatorActionDeniedError("idempotency_conflict");
      if (prior.approval_id !== input.approvalId
          || prior.approval_actor_email !== input.ctx.email
          || prior.approval_thread_id !== input.ctx.threadId
          || prior.estimated_units !== input.estimatedUnits
          || Number(prior.estimated_micro_usd) !== input.estimatedMicroUsd) {
        throw new OperatorActionDeniedError("idempotency_approval_conflict");
      }
      // PostgreSQL JSONB `null` is a present result even though the pg driver
      // decodes it to JavaScript null. Keep the SQL presence bit authoritative.
      if (prior.status === "succeeded" && prior.has_result === true) {
        await client.query("COMMIT");
        return Object.freeze({ kind: "replay", result: prior.result as T });
      }
      throw new OperatorActionDeniedError("action_already_reserved_or_indeterminate");
    }
    if (input.confirmationToken === REPLAY_ONLY_CONFIRMATION_TOKEN) {
      throw new OperatorActionDeniedError("fresh_exact_confirmation_required");
    }

    const usage = await client.query<{ units: string; spend: string }>(
      `SELECT COALESCE(sum(estimated_units), 0)::text AS units,
              COALESCE(sum(estimated_micro_usd), 0)::text AS spend
       FROM operator_action_executions
       WHERE org_id = $1 AND capability = $2
         AND created_at >= now() - interval '24 hours'`,
      [input.ctx.orgId, input.capability]
    );
    const usedUnits = Number(usage.rows[0]?.units ?? "0");
    const usedSpend = Number(usage.rows[0]?.spend ?? "0");
    const spendLimit = Number(policyRow.daily_spend_limit_micro_usd);
    if (
      !Number.isSafeInteger(usedUnits)
      || !Number.isSafeInteger(usedSpend)
      || !Number.isSafeInteger(spendLimit)
      || usedUnits + input.estimatedUnits > policyRow.daily_action_limit
      || usedSpend + input.estimatedMicroUsd > spendLimit
    ) throw new OperatorActionDeniedError("daily_quota_exceeded");

    const approval = await client.query<{ id: string; expires_at: string | Date }>(
      `SELECT id, expires_at FROM operator_action_approvals
       WHERE id = $1 AND org_id = $2 AND actor_email = $3 AND thread_id = $4
         AND capability = $5 AND arguments_sha256 = $6 AND token_sha256 = $7
         AND estimated_units = $8 AND estimated_micro_usd = $9
         AND approved_by = $3 AND approved_at IS NOT NULL
         AND consumed_execution_id IS NULL
       FOR UPDATE`,
      [
        input.approvalId,
        input.ctx.orgId,
        input.ctx.email,
        input.ctx.threadId,
        input.capability,
        argumentsSha256,
        tokenSha256,
        input.estimatedUnits,
        input.estimatedMicroUsd,
      ]
    );
    if (!approval.rows[0]) throw new OperatorActionDeniedError("fresh_exact_confirmation_required");
    const reservationClock = await client.query<{ now: string | Date }>(
      "SELECT clock_timestamp() AS now"
    );
    const reservationNowMs = new Date(reservationClock.rows[0]?.now ?? "").getTime();
    const approvalExpiresAtMs = new Date(approval.rows[0].expires_at).getTime();
    if (!Number.isFinite(reservationNowMs) || !Number.isFinite(approvalExpiresAtMs)
        || approvalExpiresAtMs <= reservationNowMs) {
      throw new OperatorActionDeniedError("fresh_exact_confirmation_required");
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO operator_action_executions
         (org_id, actor_email, capability, idempotency_key, arguments_sha256,
          estimated_units, estimated_micro_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        input.ctx.orgId,
        input.ctx.email,
        input.capability,
        input.idempotencyKey,
        argumentsSha256,
        input.estimatedUnits,
        input.estimatedMicroUsd,
      ]
    );
    const executionId = inserted.rows[0]?.id;
    if (!executionId) throw new OperatorActionDeniedError("action_reservation_failed");
    const consumed = await client.query(
      `UPDATE operator_action_approvals
       SET consumed_execution_id = $2, consumed_at = now(), private_display = NULL
       WHERE id = $1 AND consumed_execution_id IS NULL
       RETURNING id`,
      [approval.rows[0].id, executionId]
    );
    if (consumed.rowCount !== 1) throw new OperatorActionDeniedError("confirmation_already_consumed");
    const reservationEvidence = canonicalJson({
      schema_version: 1,
      kind: "approved_spend_reservation",
      capability: input.capability,
      reserved_micro_usd: input.estimatedMicroUsd,
      reserved_units: input.estimatedUnits,
      // The structured pricing quote is part of the exact action arguments.
      // Keeping only its digest here avoids duplicating recipient-bearing data.
      action_arguments_sha256: argumentsSha256,
    });
    const costReservation = await client.query(
      `INSERT INTO operator_action_cost_observations
         (org_id, operator_execution_id, provider, provider_effect_id,
          channel, coverage, currency, amount_micro_usd, observed_units,
          evidence, evidence_sha256, observed_at)
       VALUES ($1,$2::uuid,'operator_config',($2::uuid)::text,'reservation',$3,'USD',$4,$5,
               $6::jsonb,encode(digest($6::jsonb::text,'sha256'),'hex'),now())
       ON CONFLICT (org_id, operator_execution_id, provider_effect_id, channel, evidence_sha256)
       DO NOTHING
       RETURNING id`,
      [
        input.ctx.orgId,
        executionId,
        costCoverage(input.capability),
        input.estimatedMicroUsd,
        input.estimatedUnits,
        reservationEvidence,
      ]
    );
    if (costReservation.rowCount !== 1) {
      throw new OperatorActionDeniedError("action_cost_reservation_failed");
    }
    await client.query("COMMIT");
    return Object.freeze({ kind: "execute", executionId });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof OperatorActionDeniedError) throw error;
    throw new OperatorActionDeniedError("action_policy_unavailable");
  } finally {
    client.release();
  }
}

async function markDispatching(executionId: string, ctx: ToolCtx): Promise<void> {
  const rows = await q<{ id: string }>(
    `UPDATE operator_action_executions
     SET status = 'dispatching', dispatch_started_at = now(), updated_at = now()
     WHERE id = $1 AND org_id = $2 AND actor_email = $3 AND status = 'reserved'
     RETURNING id`,
    [executionId, ctx.orgId, ctx.email]
  );
  if (rows.length !== 1) throw new OperatorActionDeniedError("dispatch_ownership_lost");
}

async function settleSucceeded(executionId: string, ctx: ToolCtx, result: unknown): Promise<void> {
  const encoded = canonicalJson(result);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES) throw new Error("action result exceeds durable receipt limit");
  const rows = await q<{ id: string }>(
    `UPDATE operator_action_executions execution
     SET status = 'succeeded',
         result = CASE WHEN execution.capability = 'place_call' THEN COALESCE((
           SELECT jsonb_set(
                    jsonb_set(
                      jsonb_set($4::jsonb, '{delivery}', call.metadata->'delivery_receipt', false),
                      '{status}', to_jsonb(call.metadata->'delivery_receipt'->>'status'), false
                    ),
                    '{code}', to_jsonb(CASE
                      WHEN call.metadata->'delivery_receipt'->>'status' = 'delivered'
                        THEN 'provider_terminal_delivered'
                      ELSE 'provider_terminal_failure'
                    END), false
                  )
           FROM scheduled_calls scheduled
           JOIN calls call
             ON call.id = scheduled.id AND call.scheduled_call_id = scheduled.id
           WHERE scheduled.operator_execution_id = execution.id
             AND scheduled.org_id = execution.org_id
             AND $4::jsonb->>'call_id' = scheduled.id::text
             AND $4::jsonb->>'status' = 'accepted'
             AND $4::jsonb->>'code' = 'provider_accepted'
             AND $4::jsonb->'delivery'->>'status' = 'accepted'
             AND $4::jsonb->'delivery'->>'evidence_source' = 'provider_create_response'
             AND $4::jsonb->'delivery'->>'verified_terminal' = 'false'
             AND call.metadata->'delivery_receipt'->>'status' IN ('delivered','terminal_failure')
             AND call.metadata->'delivery_receipt'->>'evidence_source' = 'verified_status_webhook'
             AND call.metadata->'delivery_receipt'->>'verified_terminal' = 'true'
             AND call.metadata->'delivery_receipt'->>'provider_message_id'
                   = $4::jsonb->'delivery'->>'provider_message_id'
             AND call.metadata->'delivery_receipt'->>'account_binding_sha256'
                   = $4::jsonb->'delivery'->>'account_binding_sha256'
             AND call.metadata->'delivery_receipt'->>'recipient_binding_sha256'
                   = $4::jsonb->'delivery'->>'recipient_binding_sha256'
             AND call.metadata->'delivery_receipt'->>'terminal_proof_sha256' ~ '^[a-f0-9]{64}$'
             AND (call.metadata->'delivery_receipt'->>'sequence') ~ '^[1-9][0-9]{0,9}$'
           LIMIT 1
         ), $4::jsonb) ELSE $4::jsonb END,
         settled_at = now(), updated_at = now()
     WHERE execution.id = $1 AND execution.org_id = $2
       AND execution.actor_email = $3 AND execution.status = 'dispatching'
     RETURNING execution.id`,
    [executionId, ctx.orgId, ctx.email, encoded]
  );
  if (rows.length !== 1) throw new Error("action receipt settlement failed");
}

async function settleIndeterminate(executionId: string, ctx: ToolCtx): Promise<void> {
  await q(
    `UPDATE operator_action_executions
     SET status = 'indeterminate', error_code = 'provider_outcome_indeterminate',
         settled_at = now(), updated_at = now()
     WHERE id = $1 AND org_id = $2 AND actor_email = $3 AND status = 'dispatching'`,
    [executionId, ctx.orgId, ctx.email]
  ).catch(() => {});
}

export type ConfirmedActionOutcome<T> =
  | Readonly<{ ok: true; replayed: boolean; value: T }>
  | Readonly<{ ok: false; code: string }>;

export type OperatorActionDispatchContext = Readonly<{
  executionId: string;
  idempotencyKey: string;
}>;

/** At-most-once provider boundary. Once dispatch begins, any error is recorded
 * as indeterminate and the idempotency key can never dispatch again. */
export async function executeConfirmedOperatorAction<T>(input: Readonly<{
  ctx: ToolCtx;
  capability: FundedOperatorCapability;
  argumentsValue: unknown;
  confirmationToken: string;
  approvalId: string;
  idempotencyKey: string;
  estimatedUnits: number;
  estimatedMicroUsd: number;
  dispatch: (dispatchContext: OperatorActionDispatchContext) => Promise<T>;
}>): Promise<ConfirmedActionOutcome<T>> {
  let reservation: Reservation<T>;
  try {
    reservation = await reserveAction<T>(input);
  } catch (error) {
    return Object.freeze({
      ok: false,
      code: error instanceof OperatorActionDeniedError ? error.code : "action_policy_unavailable",
    });
  }
  if (reservation.kind === "replay") {
    return Object.freeze({ ok: true, replayed: true, value: reservation.result });
  }
  try {
    await markDispatching(reservation.executionId, input.ctx);
  } catch (error) {
    return Object.freeze({
      ok: false,
      code: error instanceof OperatorActionDeniedError ? error.code : "dispatch_ownership_lost",
    });
  }
  try {
    const value = await input.dispatch(Object.freeze({
      executionId: reservation.executionId,
      idempotencyKey: input.idempotencyKey,
    }));
    await settleSucceeded(reservation.executionId, input.ctx, value);
    return Object.freeze({ ok: true, replayed: false, value });
  } catch {
    await settleIndeterminate(reservation.executionId, input.ctx);
    return Object.freeze({ ok: false, code: "provider_outcome_indeterminate_do_not_retry" });
  }
}

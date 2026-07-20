import "server-only";

import type { PoolClient } from "pg";
import { ensureSafeDatabaseRuntimeRole, getPool } from "./db";
import {
  CAPABILITY_ROTATION_OVERLAP_SECONDS,
  CAPABILITY_ROTATION_TTL_SECONDS,
  MAX_CAPABILITY_ROTATION,
} from "./capability-rotation";
import { deriveRotatedScopedJti, type ScopeClaims } from "./voice";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STREAM_SID = /^MZ[0-9a-fA-F]{32}$/;

export type CapabilityRotationTransport = "browser" | "telephony";

export type CapabilityRotationLease = Readonly<{
  transport: CapabilityRotationTransport;
  call_id: string;
  session_id: string;
  bridge_instance_id: string | null;
  stream_sid: string | null;
  provider: "xai" | "openai" | "gemini";
  rotation_root_jti: string;
  generation: number;
  current_refresh_jti: string;
  previous_refresh_jti: string | null;
  last_consumed_refresh_jti: string | null;
  last_idempotency_key: string | null;
  issued_at: number;
  refresh_after_epoch: number;
  expires_at_epoch: number;
}>;

export type CapabilityRotationResult =
  | Readonly<{ status: "rotated" | "replayed"; lease: CapabilityRotationLease }>
  | Readonly<{ status: "not_found" | "conflict" | "too_early" | "expired" }>;

type RotationInput = Readonly<{
  transport: CapabilityRotationTransport;
  scope: ScopeClaims;
  sessionId: string;
  bridgeInstanceId?: string;
  streamSid?: string;
  requestedGeneration: number;
  idempotencyKey: string;
  nowEpoch: number;
}>;

type LeaseRow = Omit<CapabilityRotationLease, "generation" | "issued_at" | "refresh_after_epoch" | "expires_at_epoch"> & {
  generation: string | number;
  issued_at: string | number;
  refresh_after_epoch: string | number;
  expires_at_epoch: string | number;
};

function safeInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${label} in capability rotation row`);
  return parsed;
}

function normalizeLease(row: LeaseRow): CapabilityRotationLease {
  return Object.freeze({
    ...row,
    generation: safeInteger(row.generation, "generation"),
    issued_at: safeInteger(row.issued_at, "issued_at"),
    refresh_after_epoch: safeInteger(row.refresh_after_epoch, "refresh_after"),
    expires_at_epoch: safeInteger(row.expires_at_epoch, "expires_at"),
  });
}

const SELECT_LEASE = `SELECT transport, call_id, session_id, bridge_instance_id, stream_sid, provider,
                             rotation_root_jti, generation, current_refresh_jti,
                             previous_refresh_jti, last_consumed_refresh_jti, last_idempotency_key,
                             issued_at,
                             floor(extract(epoch FROM refresh_after))::bigint AS refresh_after_epoch,
                             floor(extract(epoch FROM expires_at))::bigint AS expires_at_epoch
                      FROM voice_capability_rotations
                      WHERE transport = $1 AND call_id = $2 AND session_id = $3
                      FOR UPDATE`;

async function lockActiveBinding(client: PoolClient, input: RotationInput): Promise<boolean> {
  const scope = input.scope;
  if (input.transport === "browser") {
    const call = await client.query(
      `SELECT c.id
       FROM calls c JOIN agents a ON a.id = c.agent_id
       WHERE c.id = $1 AND c.agent_id = $2 AND a.org_id = $3
         AND c.direction = 'web' AND c.status = 'active'
       FOR UPDATE OF c`,
      [scope.callId, scope.agentId, scope.orgId],
    );
    return call.rowCount === 1;
  }

  const call = await client.query(
    `SELECT c.id
     FROM calls c
     JOIN agents a ON a.id = c.agent_id
     JOIN telephony_stream_bindings b ON b.call_id = c.id
     WHERE c.id = $1 AND c.agent_id = $2 AND a.org_id = $3
       AND c.status = 'active'
       AND c.twilio_call_sid = $4 AND c.twilio_account_sid = $5 AND c.to_number = $6
       AND b.stream_sid = $7 AND b.provider = 'twilio'
       AND b.provider_call_sid = $4 AND b.provider_account_sid = $5 AND b.to_number = $6
       AND b.session_id = $8 AND b.bridge_instance_id = $9
       AND b.mode = 'agent' AND b.stopped_at IS NULL
     FOR UPDATE OF c, b`,
    [
      scope.callId,
      scope.agentId,
      scope.orgId,
      scope.providerCallId,
      scope.providerAccountId,
      scope.providerTo,
      input.streamSid,
      input.sessionId,
      input.bridgeInstanceId,
    ],
  );
  return call.rowCount === 1;
}

async function initialBrowserLease(
  client: PoolClient,
  input: RotationInput,
): Promise<CapabilityRotationLease | null> {
  const scope = input.scope;
  if (
    input.requestedGeneration !== 1 ||
    input.sessionId !== scope.callId ||
    scope.aud !== "browser_refresh" ||
    scope.exp - scope.iat !== CAPABILITY_ROTATION_TTL_SECONDS
  ) return null;
  const refreshAfter = scope.exp - CAPABILITY_ROTATION_OVERLAP_SECONDS;
  const inserted = await client.query<LeaseRow>(
    `INSERT INTO voice_capability_rotations (
       transport, call_id, session_id, provider, rotation_root_jti, generation,
       current_refresh_jti, issued_at, refresh_after, expires_at
     ) VALUES ('browser',$1,$1,$2,$3,0,$3,$4,to_timestamp($5),to_timestamp($6))
     ON CONFLICT DO NOTHING
     RETURNING transport, call_id, session_id, bridge_instance_id, stream_sid, provider,
               rotation_root_jti, generation, current_refresh_jti,
               previous_refresh_jti, last_consumed_refresh_jti, last_idempotency_key,
               issued_at,
               floor(extract(epoch FROM refresh_after))::bigint AS refresh_after_epoch,
               floor(extract(epoch FROM expires_at))::bigint AS expires_at_epoch`,
    [scope.callId, scope.provider, scope.jti, scope.iat, refreshAfter, scope.exp],
  );
  return inserted.rowCount === 1 ? normalizeLease(inserted.rows[0]!) : null;
}

function exactCurrentCapability(lease: CapabilityRotationLease, scope: ScopeClaims): boolean {
  return lease.current_refresh_jti === scope.jti
    && lease.issued_at === scope.iat
    && lease.expires_at_epoch === scope.exp
    && lease.provider === scope.provider;
}

/**
 * Atomically consumes one live refresh capability and advances its generation.
 * Bearer material is never persisted; an exact retry is reconstructed from the
 * retained root, generation, issuance second, and idempotency key.
 */
export async function rotateCapabilityLease(input: RotationInput): Promise<CapabilityRotationResult> {
  const idempotencyBytes = typeof input.idempotencyKey === "string"
    ? Buffer.byteLength(input.idempotencyKey, "utf8")
    : 0;
  const expectedAudience = input.transport === "browser" ? "browser_refresh" : "bridge_refresh";
  const expectedIdempotencyKey = `${
    input.transport === "browser" ? input.scope.callId : input.sessionId
  }:${input.requestedGeneration}`;
  const transportBindingValid = input.transport === "browser"
    ? input.sessionId === input.scope.callId
      && input.bridgeInstanceId === undefined
      && input.streamSid === undefined
      && input.scope.provider !== "twilio"
    : SAFE_ID.test(input.sessionId)
      && typeof input.bridgeInstanceId === "string" && SAFE_ID.test(input.bridgeInstanceId)
      && typeof input.streamSid === "string" && STREAM_SID.test(input.streamSid)
      && input.streamSid === input.scope.providerStreamId
      && input.scope.transportProvider === "twilio"
      && input.scope.provider !== "twilio";
  if (
    !Number.isSafeInteger(input.requestedGeneration)
    || input.requestedGeneration < 1
    || input.requestedGeneration > MAX_CAPABILITY_ROTATION
    || !Number.isSafeInteger(input.nowEpoch)
    || input.nowEpoch < 0
    || idempotencyBytes < 1
    || idempotencyBytes > 256
    || input.idempotencyKey !== expectedIdempotencyKey
    || !transportBindingValid
    || input.scope.aud !== expectedAudience
    || input.scope.purpose !== "capability_rotation"
    || input.scope.method !== "POST"
    || input.scope.exp - input.scope.iat !== CAPABILITY_ROTATION_TTL_SECONDS
  ) return Object.freeze({ status: "conflict" });

  await ensureSafeDatabaseRuntimeRole();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (!await lockActiveBinding(client, input)) {
      await client.query("ROLLBACK");
      return Object.freeze({ status: "not_found" });
    }

    let selected = await client.query<LeaseRow>(SELECT_LEASE, [
      input.transport,
      input.scope.callId,
      input.sessionId,
    ]);
    let lease = selected.rowCount === 1 ? normalizeLease(selected.rows[0]!) : null;
    if (!lease && input.transport === "browser") {
      lease = await initialBrowserLease(client, input);
      if (!lease) {
        // A concurrent insert can win after the initial SELECT.
        selected = await client.query<LeaseRow>(SELECT_LEASE, [
          input.transport,
          input.scope.callId,
          input.sessionId,
        ]);
        lease = selected.rowCount === 1 ? normalizeLease(selected.rows[0]!) : null;
      }
    }
    if (!lease) {
      await client.query("ROLLBACK");
      return Object.freeze({ status: "not_found" });
    }
    if (
      lease.provider !== input.scope.provider
      || lease.stream_sid !== (input.transport === "telephony" ? input.streamSid ?? null : null)
      || lease.bridge_instance_id !== (input.transport === "telephony" ? input.bridgeInstanceId ?? null : null)
    ) {
      await client.query("ROLLBACK");
      return Object.freeze({ status: "conflict" });
    }

    // An exact lost-response retry is valid only while the bearer that caused
    // the committed rotation is itself still live. The current lease has the
    // *new* generation's later expiry, so checking only lease.expires_at would
    // accidentally extend the consumed capability through the whole next TTL.
    if (input.nowEpoch >= input.scope.exp) {
      await client.query("ROLLBACK");
      return Object.freeze({ status: "expired" });
    }
    if (
      lease.generation === input.requestedGeneration
      && lease.last_consumed_refresh_jti === input.scope.jti
      && lease.last_idempotency_key === input.idempotencyKey
    ) {
      await client.query("COMMIT");
      return Object.freeze({ status: "replayed", lease });
    }
    if (
      input.requestedGeneration !== lease.generation + 1
      || !exactCurrentCapability(lease, input.scope)
    ) {
      await client.query("ROLLBACK");
      return Object.freeze({ status: "conflict" });
    }
    if (input.nowEpoch < lease.refresh_after_epoch) {
      await client.query("ROLLBACK");
      return Object.freeze({ status: "too_early" });
    }
    if (input.nowEpoch >= lease.expires_at_epoch) {
      await client.query("ROLLBACK");
      return Object.freeze({ status: "expired" });
    }

    const refreshAudience = input.transport === "browser" ? "browser_refresh" : "bridge_refresh";
    const nextRefreshJti = deriveRotatedScopedJti(
      lease.rotation_root_jti,
      input.requestedGeneration,
      refreshAudience,
    );
    const nextExpires = input.nowEpoch + CAPABILITY_ROTATION_TTL_SECONDS;
    const nextRefreshAfter = nextExpires - CAPABILITY_ROTATION_OVERLAP_SECONDS;
    const updated = await client.query<LeaseRow>(
      `UPDATE voice_capability_rotations
       SET generation = $4,
           previous_refresh_jti = current_refresh_jti,
           last_consumed_refresh_jti = current_refresh_jti,
           last_idempotency_key = $5,
           current_refresh_jti = $6,
           issued_at = $7,
           refresh_after = to_timestamp($8),
           expires_at = to_timestamp($9),
           updated_at = now()
       WHERE transport = $1 AND call_id = $2 AND session_id = $3
         AND generation = $10 AND current_refresh_jti = $11
       RETURNING transport, call_id, session_id, bridge_instance_id, stream_sid, provider,
                 rotation_root_jti, generation, current_refresh_jti,
                 previous_refresh_jti, last_consumed_refresh_jti, last_idempotency_key,
                 issued_at,
                 floor(extract(epoch FROM refresh_after))::bigint AS refresh_after_epoch,
                 floor(extract(epoch FROM expires_at))::bigint AS expires_at_epoch`,
      [
        input.transport,
        input.scope.callId,
        input.sessionId,
        input.requestedGeneration,
        input.idempotencyKey,
        nextRefreshJti,
        input.nowEpoch,
        nextRefreshAfter,
        nextExpires,
        lease.generation,
        lease.current_refresh_jti,
      ],
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return Object.freeze({ status: "conflict" });
    }
    const next = normalizeLease(updated.rows[0]!);
    await client.query("COMMIT");
    return Object.freeze({ status: "rotated", lease: next });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

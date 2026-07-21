import "server-only";

import { randomUUID } from "node:crypto";
import { q, qOne } from "../db";
import {
  VoiceWorkerResultSchema,
  VoiceWorkerStatusSchema,
  VoiceWorkerCheckpointSchema,
  canonicalVoiceWorkerJson,
  deriveVoiceWorkerId,
  hashVoiceWorkerValue,
  prepareVoiceWorkerCheckpoint,
  prepareVoiceWorkerResult,
  prepareVoiceWorkerSpawn,
  type VoiceWorkerCapabilityManifest,
  type VoiceWorkerCheckpoint,
  type VoiceWorkerInput,
  type VoiceWorkerResult,
  type VoiceWorkerSpawnAuthority,
  type VoiceWorkerStatus,
} from "./schema";

type WorkerRow = Readonly<{
  id: string;
  conversation_id: string;
  org_id: string;
  parent_worker_id: string | null;
  source_call_id: string | null;
  idempotency_key: string;
  worker_kind: string;
  spawn_authority: unknown;
  spawn_authority_sha256: string;
  worker_input: unknown;
  worker_input_sha256: string;
  capability_manifest: unknown;
  capability_manifest_sha256: string;
  status: string;
  owner_token: string | null;
  lease_expires_at: Date | string | null;
  dispatch_started_at: Date | string | null;
  cancellation_epoch: number;
  claimed_cancellation_epoch: number | null;
  checkpoint: VoiceWorkerCheckpoint | null;
  checkpoint_sha256: string | null;
  result: unknown | null;
  result_sha256: string | null;
  error: unknown | null;
  created_at: Date | string;
  settled_at: Date | string | null;
}>;

type InboxRow = Readonly<{
  id: string;
  conversation_id: string;
  worker_id: string;
  source_event_sha256: string;
  payload: unknown;
  payload_sha256: string;
  delivery_token: string | null;
  delivery_lease_expires_at: Date | string | null;
  delivery_count: number;
  application_id: string | null;
  applied_context_version: string | number | null;
  applied_at: Date | string | null;
  acknowledged_at: Date | string | null;
}>;

export type DurableVoiceWorker = Readonly<{
  id: string;
  conversationId: string;
  organizationId: string;
  parentWorkerId: string | null;
  sourceCallId: string | null;
  idempotencyKey: string;
  workerKind: string;
  authority: VoiceWorkerSpawnAuthority;
  authoritySha256: string;
  input: VoiceWorkerInput;
  inputSha256: string;
  capabilityManifest: VoiceWorkerCapabilityManifest;
  capabilityManifestSha256: string;
  status: VoiceWorkerStatus;
  ownerToken: string | null;
  leaseExpiresAt: string | null;
  dispatchStartedAt: string | null;
  cancellationEpoch: number;
  claimedCancellationEpoch: number | null;
  checkpoint: unknown | null;
  checkpointSha256: string | null;
  result: VoiceWorkerResult | null;
  resultSha256: string | null;
  error: unknown | null;
  createdAt: string;
  settledAt: string | null;
}>;

export type DurableConversationInboxMessage = Readonly<{
  id: string;
  conversationId: string;
  workerId: string;
  sourceEventSha256: string;
  result: VoiceWorkerResult;
  resultSha256: string;
  deliveryToken: string | null;
  deliveryLeaseExpiresAt: string | null;
  deliveryCount: number;
  applicationId: string | null;
  appliedContextVersion: string | null;
  appliedAt: string | null;
  acknowledgedAt: string | null;
}>;

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function projectWorker(row: WorkerRow): DurableVoiceWorker {
  const authority = prepareVoiceWorkerSpawn({
    authority: row.spawn_authority,
    workerInput: row.worker_input,
    capabilityManifest: row.capability_manifest,
  });
  if (
    authority.authoritySha256 !== row.spawn_authority_sha256
    || authority.inputSha256 !== row.worker_input_sha256
    || authority.capabilityManifestSha256 !== row.capability_manifest_sha256
  ) throw new Error(`durable voice worker ${row.id} failed immutable digest verification`);
  const checkpoint = row.checkpoint === null ? null : VoiceWorkerCheckpointSchema.parse(row.checkpoint);
  if (checkpoint && hashVoiceWorkerValue(checkpoint) !== row.checkpoint_sha256) {
    throw new Error(`durable voice worker ${row.id} failed checkpoint digest verification`);
  }
  const result = row.result === null ? null : VoiceWorkerResultSchema.parse(row.result);
  if (result && hashVoiceWorkerValue(result) !== row.result_sha256) {
    throw new Error(`durable voice worker ${row.id} failed result digest verification`);
  }
  return Object.freeze({
    id: row.id,
    conversationId: row.conversation_id,
    organizationId: row.org_id,
    parentWorkerId: row.parent_worker_id,
    sourceCallId: row.source_call_id,
    idempotencyKey: row.idempotency_key,
    workerKind: row.worker_kind,
    authority: authority.authority,
    authoritySha256: row.spawn_authority_sha256,
    input: authority.workerInput,
    inputSha256: row.worker_input_sha256,
    capabilityManifest: authority.capabilityManifest,
    capabilityManifestSha256: row.capability_manifest_sha256,
    status: VoiceWorkerStatusSchema.parse(row.status),
    ownerToken: row.owner_token,
    leaseExpiresAt: iso(row.lease_expires_at),
    dispatchStartedAt: iso(row.dispatch_started_at),
    cancellationEpoch: row.cancellation_epoch,
    claimedCancellationEpoch: row.claimed_cancellation_epoch,
    checkpoint,
    checkpointSha256: row.checkpoint_sha256,
    result,
    resultSha256: row.result_sha256,
    error: row.error,
    createdAt: iso(row.created_at)!,
    settledAt: iso(row.settled_at),
  });
}

function projectInbox(row: InboxRow): DurableConversationInboxMessage {
  const result = VoiceWorkerResultSchema.parse(row.payload);
  if (hashVoiceWorkerValue(result) !== row.payload_sha256) {
    throw new Error(`voice conversation inbox message ${row.id} failed payload digest verification`);
  }
  return Object.freeze({
    id: row.id,
    conversationId: row.conversation_id,
    workerId: row.worker_id,
    sourceEventSha256: row.source_event_sha256,
    result,
    resultSha256: row.payload_sha256,
    deliveryToken: row.delivery_token,
    deliveryLeaseExpiresAt: iso(row.delivery_lease_expires_at),
    deliveryCount: row.delivery_count,
    applicationId: row.application_id,
    appliedContextVersion: row.applied_context_version === null ? null : String(row.applied_context_version),
    appliedAt: iso(row.applied_at),
    acknowledgedAt: iso(row.acknowledged_at),
  });
}

export async function ensureDurableVoiceConversation(input: Readonly<{
  conversationId: string;
  organizationId: string;
  agentId: string;
  agentVersion: number;
  callId?: string;
}>): Promise<void> {
  const row = await qOne<{ id: string }>(
    "SELECT id FROM ensure_voice_conversation($1,$2,$3,$4,$5)",
    [input.conversationId, input.organizationId, input.agentId, input.agentVersion, input.callId ?? null]
  );
  if (!row || row.id !== input.conversationId) throw new Error("voice conversation admission returned no durable identity");
}

export async function spawnDurableVoiceWorker(input: Readonly<{
  idempotencyKey: string;
  workerKind: string;
  authority: unknown;
  workerInput: unknown;
  capabilityManifest: unknown;
  sourceCallId?: string;
  parentWorkerId?: string;
}>): Promise<DurableVoiceWorker> {
  const prepared = prepareVoiceWorkerSpawn(input);
  if (Buffer.byteLength(input.idempotencyKey, "utf8") > 256 || !input.idempotencyKey) {
    throw new Error("voice worker idempotency key must contain 1 to 256 UTF-8 bytes");
  }
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(input.workerKind)) {
    throw new Error("voice worker kind is invalid");
  }
  if (
    (prepared.authority.sourceCallId ?? null) !== (input.sourceCallId ?? null)
    || (prepared.authority.sourceWorkerId ?? null) !== (input.parentWorkerId ?? null)
  ) {
    throw new Error("voice worker source identities do not match immutable spawn authority");
  }
  const workerId = deriveVoiceWorkerId(prepared.authority.conversationId, input.idempotencyKey);
  const row = await qOne<WorkerRow>(
    `SELECT * FROM spawn_voice_worker_job(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
     )`,
    [
      workerId,
      prepared.authority.conversationId,
      input.idempotencyKey,
      input.workerKind,
      canonicalVoiceWorkerJson(prepared.authority),
      prepared.authoritySha256,
      canonicalVoiceWorkerJson(prepared.workerInput),
      prepared.inputSha256,
      canonicalVoiceWorkerJson(prepared.capabilityManifest),
      prepared.capabilityManifestSha256,
      input.sourceCallId ?? null,
      input.parentWorkerId ?? null,
    ]
  );
  if (!row) throw new Error("voice worker spawn returned no durable job");
  return projectWorker(row);
}

export async function claimDurableVoiceWorker(
  options: Readonly<{ ownerToken?: string; leaseMs?: number }> = {}
): Promise<DurableVoiceWorker | null> {
  const row = await qOne<WorkerRow>("SELECT * FROM claim_voice_worker_job($1,$2)", [
    options.ownerToken ?? randomUUID(),
    options.leaseMs ?? 60_000,
  ]);
  return row ? projectWorker(row) : null;
}

export async function heartbeatDurableVoiceWorker(
  workerId: string,
  ownerToken: string,
  leaseMs = 60_000
): Promise<DurableVoiceWorker> {
  const row = await qOne<WorkerRow>("SELECT * FROM heartbeat_voice_worker_job($1,$2,$3)", [workerId, ownerToken, leaseMs]);
  if (!row) throw new Error("voice worker heartbeat returned no job");
  return projectWorker(row);
}

export async function markDurableVoiceWorkerDispatchStarted(
  workerId: string,
  ownerToken: string
): Promise<DurableVoiceWorker> {
  const row = await qOne<WorkerRow>("SELECT * FROM mark_voice_worker_dispatch_started($1,$2)", [workerId, ownerToken]);
  if (!row) throw new Error("voice worker dispatch transition returned no job");
  return projectWorker(row);
}

export async function checkpointDurableVoiceWorker(
  workerId: string,
  ownerToken: string,
  value: unknown
): Promise<DurableVoiceWorker> {
  const prepared = prepareVoiceWorkerCheckpoint(value);
  const row = await qOne<WorkerRow>("SELECT * FROM checkpoint_voice_worker_job($1,$2,$3,$4)", [
    workerId,
    ownerToken,
    canonicalVoiceWorkerJson(prepared.checkpoint),
    prepared.checkpointSha256,
  ]);
  if (!row) throw new Error("voice worker checkpoint returned no job");
  return projectWorker(row);
}

export async function settleDurableVoiceWorkerSucceeded(
  workerId: string,
  ownerToken: string,
  value: unknown
): Promise<DurableVoiceWorker> {
  const prepared = prepareVoiceWorkerResult(value);
  const row = await qOne<WorkerRow>("SELECT * FROM settle_voice_worker_job($1,$2,'succeeded',$3,$4,NULL)", [
    workerId,
    ownerToken,
    canonicalVoiceWorkerJson(prepared.result),
    prepared.resultSha256,
  ]);
  if (!row) throw new Error("voice worker success settlement returned no job");
  return projectWorker(row);
}

export async function settleDurableVoiceWorkerFailed(
  workerId: string,
  ownerToken: string,
  error: Readonly<{ code: string; message: string }>
): Promise<DurableVoiceWorker> {
  const encoded = canonicalVoiceWorkerJson(error);
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) throw new RangeError("voice worker error exceeds 16384 bytes");
  const row = await qOne<WorkerRow>("SELECT * FROM settle_voice_worker_job($1,$2,'failed',NULL,NULL,$3)", [
    workerId,
    ownerToken,
    encoded,
  ]);
  if (!row) throw new Error("voice worker failure settlement returned no job");
  return projectWorker(row);
}

export async function settleDurableVoiceWorkerCancelled(
  workerId: string,
  ownerToken: string
): Promise<DurableVoiceWorker> {
  const row = await qOne<WorkerRow>("SELECT * FROM settle_voice_worker_job($1,$2,'cancelled',NULL,NULL,NULL)", [
    workerId,
    ownerToken,
  ]);
  if (!row) throw new Error("voice worker cancellation settlement returned no job");
  return projectWorker(row);
}

export async function requestDurableVoiceWorkerCancellation(
  workerId: string,
  organizationId: string
): Promise<DurableVoiceWorker> {
  const row = await qOne<WorkerRow>("SELECT * FROM request_voice_worker_cancellation($1,$2)", [workerId, organizationId]);
  if (!row) throw new Error("voice worker cancellation request returned no job");
  return projectWorker(row);
}

export async function claimDurableConversationInbox(input: Readonly<{
  conversationId: string;
  organizationId: string;
  deliveryToken?: string;
  leaseMs?: number;
  maximumMessages?: number;
}>): Promise<readonly DurableConversationInboxMessage[]> {
  const rows = await q<InboxRow>("SELECT * FROM claim_voice_conversation_inbox($1,$2,$3,$4,$5)", [
    input.conversationId,
    input.organizationId,
    input.deliveryToken ?? randomUUID(),
    input.leaseMs ?? 30_000,
    input.maximumMessages ?? 16,
  ]);
  return rows.map(projectInbox);
}

export async function applyDurableConversationInboxMessage(input: Readonly<{
  messageId: string;
  organizationId: string;
  deliveryToken: string;
  applicationId: string;
}>): Promise<DurableConversationInboxMessage> {
  const row = await qOne<InboxRow>("SELECT * FROM apply_voice_conversation_inbox($1,$2,$3,$4)", [
    input.messageId,
    input.organizationId,
    input.deliveryToken,
    input.applicationId,
  ]);
  if (!row) throw new Error("voice inbox application returned no message");
  return projectInbox(row);
}

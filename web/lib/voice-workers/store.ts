import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { q, qOne } from "../db";
import {
  CONVERSATION_KERNEL_VERSION,
  ConversationEventDraftSchema,
  ConversationEventSchema,
  appendConversationEvent,
  canonicalJson,
  foldConversation,
  type ConversationEvent,
  type ConversationEventDraft,
  type ConversationLog,
  type WorkerDeliveryRecord,
} from "../conversation-kernel";
import { loadPersistedConversationLog, type ConversationHead } from "../conversation-store";
import {
  VoiceWorkerCapabilityManifestSchema,
  VoiceWorkerInputSchema,
  VoiceWorkerResultSchema,
  VoiceWorkerSpawnAuthoritySchema,
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
import {
  workerResultConversationPayload,
  workerSpawnedConversationPayload,
} from "./conversation-adapter";
import { workerQOne } from "./runtime-db";

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

type DeliveryWorkerRow = Readonly<{
  id: string;
  conversation_id: string;
  org_id: string;
  source_call_id: string | null;
  spawn_authority: unknown;
  spawn_authority_sha256: string;
  result_sha256: string;
  settled_at: Date | string;
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
  created_at: Date | string;
  applied_at: Date | string | null;
  acknowledged_at: Date | string | null;
}>;

type ConversationEventJsonRow = Readonly<{
  conversation_id: string;
  org_id: string;
  sequence: number | string;
  event_id: string;
  idempotency_key: string;
  occurred_at_ms: number | string;
  event_type: string;
  payload: unknown;
  previous_event_sha256: string;
  event_sha256: string;
  unsigned_event_text: string;
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

export type DurableVoiceWorkerDelivery = Readonly<{
  id: string;
  conversationId: string;
  organizationId: string;
  sourceCallId: string | null;
  authority: VoiceWorkerSpawnAuthority;
  authoritySha256: string;
  status: "succeeded";
  resultSha256: string;
  settledAt: string;
}>;

type DurableConversationInboxBase = Readonly<{
  id: string;
  conversationId: string;
  workerId: string;
  sourceEventSha256: string;
  deliveryToken: string | null;
  deliveryLeaseExpiresAt: string | null;
  deliveryCount: number;
  applicationId: string | null;
  appliedContextVersion: string | null;
  createdAt: string;
  appliedAt: string | null;
  acknowledgedAt: string | null;
}>;

export type DurableConversationResultInboxMessage = DurableConversationInboxBase & Readonly<{
  kind: "result";
  result: VoiceWorkerResult;
  resultSha256: string;
}>;

export type DurableConversationTerminalInboxMessage = DurableConversationInboxBase & Readonly<{
  kind: "terminal";
  terminalStatus: "failed" | "cancelled" | "indeterminate";
  reasonCode: string;
  evidenceSha256: string;
  terminalPayloadSha256: string;
}>;

export type DurableConversationInboxMessage =
  | DurableConversationResultInboxMessage
  | DurableConversationTerminalInboxMessage;

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

/** Succeeded-only immutable projection; executor bearer state never enters the app delivery path. */
export async function loadDurableVoiceWorker(input: Readonly<{
  workerId: string;
  organizationId: string;
  conversationId: string;
}>): Promise<DurableVoiceWorkerDelivery | null> {
  const row = await qOne<DeliveryWorkerRow>(
    "SELECT * FROM load_voice_worker_for_delivery($1,$2,$3)",
    [input.workerId, input.organizationId, input.conversationId],
  );
  if (!row) return null;
  const authority = VoiceWorkerSpawnAuthoritySchema.parse(row.spawn_authority);
  if (
    hashVoiceWorkerValue(authority) !== row.spawn_authority_sha256
    || authority.conversationId !== row.conversation_id
    || authority.organizationId !== row.org_id
    || !/^[a-f0-9]{64}$/.test(row.result_sha256)
  ) {
    throw new Error(`durable voice worker ${row.id} failed immutable delivery verification`);
  }
  return Object.freeze({
    id: row.id,
    conversationId: row.conversation_id,
    organizationId: row.org_id,
    sourceCallId: row.source_call_id,
    authority,
    authoritySha256: row.spawn_authority_sha256,
    status: "succeeded",
    resultSha256: row.result_sha256,
    settledAt: iso(row.settled_at)!,
  });
}

function hashTerminalInboxPayload(input: Readonly<{
  workerId: string;
  terminalStatus: string;
  reasonCode: string;
  evidenceSha256: string;
}>): string {
  return createHash("sha256")
    .update("hacc/voice-worker-terminal-inbox/v1", "utf8")
    .update("\0", "utf8")
    .update(input.workerId, "utf8")
    .update("\0", "utf8")
    .update(input.terminalStatus, "utf8")
    .update("\0", "utf8")
    .update(input.reasonCode, "utf8")
    .update("\0", "utf8")
    .update(input.evidenceSha256, "utf8")
    .digest("hex");
}

function projectInbox(row: InboxRow): DurableConversationInboxMessage {
  const base = {
    id: row.id,
    conversationId: row.conversation_id,
    workerId: row.worker_id,
    sourceEventSha256: row.source_event_sha256,
    deliveryToken: row.delivery_token,
    deliveryLeaseExpiresAt: iso(row.delivery_lease_expires_at),
    deliveryCount: row.delivery_count,
    applicationId: row.application_id,
    appliedContextVersion: row.applied_context_version === null ? null : String(row.applied_context_version),
    createdAt: iso(row.created_at)!,
    appliedAt: iso(row.applied_at),
    acknowledgedAt: iso(row.acknowledged_at),
  } as const;
  if (
    row.payload
    && typeof row.payload === "object"
    && !Array.isArray(row.payload)
    && (row.payload as Record<string, unknown>).kind === "terminal"
  ) {
    const payload = row.payload as Record<string, unknown>;
    const terminalStatus = payload.status;
    const reasonCode = payload.reasonCode;
    const evidenceSha256 = payload.evidenceSha256;
    if (
      payload.v !== 1
      || !["failed", "cancelled", "indeterminate"].includes(String(terminalStatus))
      || typeof reasonCode !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(reasonCode)
      || typeof evidenceSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(evidenceSha256)
      || evidenceSha256 !== row.source_event_sha256
      || hashTerminalInboxPayload({
        workerId: row.worker_id,
        terminalStatus: String(terminalStatus),
        reasonCode,
        evidenceSha256,
      }) !== row.payload_sha256
    ) {
      throw new Error(`voice conversation terminal inbox message ${row.id} failed evidence verification`);
    }
    return Object.freeze({
      ...base,
      kind: "terminal" as const,
      terminalStatus: terminalStatus as "failed" | "cancelled" | "indeterminate",
      reasonCode,
      evidenceSha256,
      terminalPayloadSha256: row.payload_sha256,
    });
  }
  const result = VoiceWorkerResultSchema.parse(row.payload);
  if (hashVoiceWorkerValue(result) !== row.payload_sha256) {
    throw new Error(`voice conversation inbox message ${row.id} failed payload digest verification`);
  }
  return Object.freeze({
    ...base,
    kind: "result" as const,
    result,
    resultSha256: row.payload_sha256,
  });
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function prepareGovernedConversationEvent(input: Readonly<{
  conversationId: string;
  expectedHead: ConversationHead;
  idempotencyKey: string;
  draft: ConversationEventDraft;
}>): Readonly<{ event: ConversationEvent; unsignedEventText: string }> {
  if (!input.idempotencyKey || Buffer.byteLength(input.idempotencyKey, "utf8") > 256) {
    throw new Error("conversation event idempotency key must contain 1 to 256 UTF-8 bytes");
  }
  if (!Number.isSafeInteger(input.expectedHead.sequence) || input.expectedHead.sequence < 0 ||
      !/^[a-f0-9]{64}$/.test(input.expectedHead.sha256)) {
    throw new Error("governed worker expected conversation head is invalid");
  }
  const draft = ConversationEventDraftSchema.parse(input.draft);
  const unsigned = {
    version: CONVERSATION_KERNEL_VERSION,
    conversationId: input.conversationId,
    sequence: input.expectedHead.sequence + 1,
    previousHash: input.expectedHead.sha256,
    ...draft,
  } as const;
  const unsignedEventText = canonicalJson(unsigned);
  const event = ConversationEventSchema.parse({ ...unsigned, hash: sha256Text(unsignedEventText) });
  return Object.freeze({ event, unsignedEventText });
}

function verifyGovernedConversationEventRow(
  value: unknown,
  expected: Readonly<{ event: ConversationEvent; unsignedEventText: string }>,
  scope: Readonly<{ organizationId: string; idempotencyKey: string }>,
): void {
  if (typeof value !== "object" || value === null) throw new Error("governed worker transition returned no event");
  const row = value as ConversationEventJsonRow;
  const exact = {
    conversationId: row.conversation_id,
    organizationId: row.org_id,
    sequence: Number(row.sequence),
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    occurredAtMs: Number(row.occurred_at_ms),
    eventType: row.event_type,
    payload: row.payload,
    previousHash: row.previous_event_sha256,
    hash: row.event_sha256,
    unsignedEventText: row.unsigned_event_text,
  };
  const wanted = {
    conversationId: expected.event.conversationId,
    organizationId: scope.organizationId,
    sequence: expected.event.sequence,
    eventId: expected.event.eventId,
    idempotencyKey: scope.idempotencyKey,
    occurredAtMs: expected.event.occurredAtMs,
    eventType: expected.event.payload.type,
    payload: expected.event.payload,
    previousHash: expected.event.previousHash,
    hash: expected.event.hash,
    unsignedEventText: expected.unsignedEventText,
  };
  if (canonicalJson(exact) !== canonicalJson(wanted)) {
    throw new Error("governed worker transition returned a different conversation event");
  }
}

async function loadGovernedConversationPrefix(input: Readonly<{
  conversationId: string;
  organizationId: string;
  expectedHead: ConversationHead;
  event: ConversationEvent;
}>): Promise<Readonly<{ log: ConversationLog; exactReplay: boolean }>> {
  const log = await loadPersistedConversationLog({
    conversationId: input.conversationId,
    organizationId: input.organizationId,
  });
  const captured = log.events.at(-1);
  const sequence = captured?.sequence ?? 0;
  const sha256 = captured?.hash ?? "0".repeat(64);
  if (sequence === input.expectedHead.sequence && sha256 === input.expectedHead.sha256) {
    return Object.freeze({ log, exactReplay: false });
  }
  // Exact operation retries intentionally retain their original pre-event
  // expected head. Permit that one immutable event even if later work advanced
  // the ledger; changed bytes or an unrelated head still fail closed.
  const persisted = log.events[input.expectedHead.sequence];
  if (persisted && canonicalJson(persisted) === canonicalJson(input.event)) {
    return Object.freeze({ log, exactReplay: true });
  }
  throw new Error("governed worker expected head does not match the semantically validated conversation prefix");
}

function appendAndFoldGovernedEvent(
  log: ConversationLog,
  event: ConversationEvent,
): Readonly<{ log: ConversationLog; delivery: WorkerDeliveryRecord | null }> {
  const candidate = appendConversationEvent(log, {
    eventId: event.eventId,
    occurredAtMs: event.occurredAtMs,
    payload: event.payload,
  });
  const appended = candidate.events.at(-1);
  if (!appended || canonicalJson(appended) !== canonicalJson(event)) {
    throw new Error("governed worker event differs from the semantically folded candidate");
  }
  const state = foldConversation(candidate);
  const delivery = event.payload.type === "worker.result_delivered"
    ? state.deliveries.findLast((item) => item.eventId === event.eventId) ?? null
    : null;
  return Object.freeze({ log: candidate, delivery });
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

/**
 * @deprecated Migration 034 revokes this direct backend transition. New
 * callers must use spawnGovernedDurableVoiceWorker so the kernel event and job
 * share one transaction.
 */
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

export type ExactDurableVoiceWorkerScope = Readonly<{
  workerId: string;
  organizationId: string;
  conversationId: string;
  ownerToken: string;
}>;

function verifyExactWorker(
  worker: DurableVoiceWorker,
  scope: ExactDurableVoiceWorkerScope,
): DurableVoiceWorker {
  if (
    worker.id !== scope.workerId
    || worker.organizationId !== scope.organizationId
    || worker.conversationId !== scope.conversationId
    || worker.ownerToken !== scope.ownerToken
  ) {
    throw new Error("exact voice worker transition returned a different owner-bound worker");
  }
  return worker;
}

export async function claimExactDurableVoiceWorker(
  input: ExactDurableVoiceWorkerScope & Readonly<{ leaseMs?: number }>,
): Promise<DurableVoiceWorker | null> {
  const row = await workerQOne<WorkerRow>(
    "SELECT * FROM claim_voice_worker_job_exact($1,$2,$3,$4,$5)",
    [
      input.workerId,
      input.organizationId,
      input.conversationId,
      input.ownerToken,
      input.leaseMs ?? 120_000,
    ],
  );
  return row ? verifyExactWorker(projectWorker(row), input) : null;
}

export async function heartbeatExactDurableVoiceWorker(
  input: ExactDurableVoiceWorkerScope & Readonly<{ leaseMs?: number }>,
): Promise<DurableVoiceWorker> {
  const row = await workerQOne<WorkerRow>(
    "SELECT * FROM heartbeat_voice_worker_job_exact($1,$2,$3,$4,$5)",
    [
      input.workerId,
      input.organizationId,
      input.conversationId,
      input.ownerToken,
      input.leaseMs ?? 120_000,
    ],
  );
  if (!row) throw new Error("exact voice worker heartbeat returned no job");
  return verifyExactWorker(projectWorker(row), input);
}

export async function markExactDurableVoiceWorkerDispatchStarted(
  input: ExactDurableVoiceWorkerScope,
): Promise<DurableVoiceWorker> {
  const row = await workerQOne<WorkerRow>(
    "SELECT * FROM mark_voice_worker_dispatch_started_exact($1,$2,$3,$4)",
    [input.workerId, input.organizationId, input.conversationId, input.ownerToken],
  );
  if (!row) throw new Error("exact voice worker dispatch transition returned no job");
  return verifyExactWorker(projectWorker(row), input);
}

export async function settleExactDurableVoiceWorkerSucceeded(
  input: ExactDurableVoiceWorkerScope,
  value: unknown,
): Promise<DurableVoiceWorker> {
  const prepared = prepareVoiceWorkerResult(value);
  const row = await workerQOne<WorkerRow>(
    "SELECT * FROM settle_voice_worker_job_exact($1,$2,$3,$4,'succeeded',$5,$6,NULL)",
    [
      input.workerId,
      input.organizationId,
      input.conversationId,
      input.ownerToken,
      canonicalVoiceWorkerJson(prepared.result),
      prepared.resultSha256,
    ],
  );
  if (!row) throw new Error("exact voice worker success settlement returned no job");
  const worker = projectWorker(row);
  if (
    worker.id !== input.workerId
    || worker.organizationId !== input.organizationId
    || worker.conversationId !== input.conversationId
    || worker.status !== "succeeded"
  ) {
    throw new Error("exact voice worker success settlement returned a different worker");
  }
  return worker;
}

export async function settleExactDurableVoiceWorkerFailed(
  input: ExactDurableVoiceWorkerScope,
  error: Readonly<{ code: string; message: string }>,
): Promise<DurableVoiceWorker> {
  const encoded = canonicalVoiceWorkerJson(error);
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) {
    throw new RangeError("voice worker error exceeds 16384 bytes");
  }
  const row = await workerQOne<WorkerRow>(
    "SELECT * FROM settle_voice_worker_job_exact($1,$2,$3,$4,'failed',NULL,NULL,$5)",
    [input.workerId, input.organizationId, input.conversationId, input.ownerToken, encoded],
  );
  if (!row) throw new Error("exact voice worker failure settlement returned no job");
  const worker = projectWorker(row);
  if (worker.id !== input.workerId || worker.status !== "failed") {
    throw new Error("exact voice worker failure settlement returned a different worker");
  }
  return worker;
}

export async function settleExactDurableVoiceWorkerCancelled(
  input: ExactDurableVoiceWorkerScope,
): Promise<DurableVoiceWorker> {
  const row = await workerQOne<WorkerRow>(
    "SELECT * FROM settle_voice_worker_job_exact($1,$2,$3,$4,'cancelled',NULL,NULL,NULL)",
    [input.workerId, input.organizationId, input.conversationId, input.ownerToken],
  );
  if (!row) throw new Error("exact voice worker cancellation settlement returned no job");
  const worker = projectWorker(row);
  if (worker.id !== input.workerId || worker.status !== "cancelled") {
    throw new Error("exact voice worker cancellation settlement returned a different worker");
  }
  return worker;
}

export async function loadDurableVoiceWorkerStatus(input: Readonly<{
  workerId: string;
  organizationId: string;
  conversationId: string;
}>): Promise<Readonly<{ id: string; status: VoiceWorkerStatus }> | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    input.workerId,
  )) {
    throw new Error("voice worker status lookup requires a worker UUID");
  }
  const row = await qOne<{ id: string; status: string }>(
    "SELECT * FROM load_voice_worker_status($1,$2,$3)",
    [input.workerId, input.organizationId, input.conversationId],
  );
  return row
    ? Object.freeze({ id: row.id, status: VoiceWorkerStatusSchema.parse(row.status) })
    : null;
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
  const deliveryToken = input.deliveryToken ?? randomUUID();
  const rows = await q<InboxRow>("SELECT * FROM claim_voice_conversation_inbox($1,$2,$3,$4,$5)", [
    input.conversationId,
    input.organizationId,
    deliveryToken,
    input.leaseMs ?? 30_000,
    input.maximumMessages ?? 16,
  ]);
  const admitted: DurableConversationInboxMessage[] = [];
  for (const row of rows) {
    try {
      admitted.push(projectInbox(row));
    } catch {
      const quarantined = await qOne<{ id: string }>(
        "SELECT id FROM quarantine_voice_conversation_inbox($1,$2,$3,$4)",
        [
          row.id,
          input.organizationId,
          deliveryToken,
          "invalid_worker_evidence",
        ],
      );
      if (quarantined?.id !== row.id) {
        throw new Error("invalid worker inbox evidence could not be quarantined");
      }
    }
  }
  return admitted;
}

/**
 * @deprecated Migration 034 revokes this direct backend transition. Use
 * applyGovernedDurableConversationInboxMessage, which first folds the candidate
 * result and consumes the inbox only when its decision is accepted.
 */
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

export type GovernedVoiceWorkerSpawnAuthority = Omit<
  VoiceWorkerSpawnAuthority,
  "conversationHeadSha256" | "conversationRevision" | "capabilityManifestSha256"
>;

export type GovernedConversationEventIdentity = Readonly<{
  idempotencyKey: string;
  eventId: string;
  occurredAtMs: number;
}>;

export class GovernedWorkerResultNotApplicableError extends Error {
  readonly code = "governed_worker_result_not_applicable" as const;
  constructor(readonly decision: WorkerDeliveryRecord) {
    super(`worker result is ${decision.status}: ${decision.reason ?? "no acceptance decision"}`);
    this.name = "GovernedWorkerResultNotApplicableError";
  }
}

/**
 * Commits the kernel's worker.spawned event and durable worker as one database
 * transition. The post-event head and manifest digest are derived here so a
 * caller cannot choose authority that disagrees with the committed ledger.
 */
export async function spawnGovernedDurableVoiceWorker(input: Readonly<{
  expectedHead: ConversationHead;
  conversationEvent: GovernedConversationEventIdentity;
  workerIdempotencyKey: string;
  workerKind: string;
  authority: GovernedVoiceWorkerSpawnAuthority;
  workerInput: unknown;
  capabilityManifest: unknown;
  sourceCallId?: string;
  parentWorkerId?: string;
}>): Promise<Readonly<{ event: ConversationEvent; worker: DurableVoiceWorker }>> {
  if (!input.workerIdempotencyKey || Buffer.byteLength(input.workerIdempotencyKey, "utf8") > 256) {
    throw new Error("voice worker idempotency key must contain 1 to 256 UTF-8 bytes");
  }
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(input.workerKind)) throw new Error("voice worker kind is invalid");
  const workerInput = VoiceWorkerInputSchema.parse(input.workerInput);
  const capabilityManifest = VoiceWorkerCapabilityManifestSchema.parse(input.capabilityManifest);
  const capabilityManifestSha256 = hashVoiceWorkerValue(capabilityManifest);
  const workerId = deriveVoiceWorkerId(input.authority.conversationId, input.workerIdempotencyKey);
  const provisionalAuthority = VoiceWorkerSpawnAuthoritySchema.parse({
    ...input.authority,
    conversationHeadSha256: "0".repeat(64),
    conversationRevision: input.expectedHead.sequence + 1,
    capabilityManifestSha256,
  });
  const payload = workerSpawnedConversationPayload({
    id: workerId,
    conversationId: input.authority.conversationId,
    authority: provisionalAuthority,
    input: workerInput,
  });
  const preparedEvent = prepareGovernedConversationEvent({
    conversationId: input.authority.conversationId,
    expectedHead: input.expectedHead,
    idempotencyKey: input.conversationEvent.idempotencyKey,
    draft: {
      eventId: input.conversationEvent.eventId,
      occurredAtMs: input.conversationEvent.occurredAtMs,
      payload,
    },
  });
  const prepared = prepareVoiceWorkerSpawn({
    authority: {
      ...input.authority,
      conversationHeadSha256: preparedEvent.event.hash,
      conversationRevision: preparedEvent.event.sequence,
      capabilityManifestSha256,
    },
    workerInput,
    capabilityManifest,
  });
  if ((prepared.authority.sourceCallId ?? null) !== (input.sourceCallId ?? null) ||
      (prepared.authority.sourceWorkerId ?? null) !== (input.parentWorkerId ?? null)) {
    throw new Error("voice worker source identities do not match immutable spawn authority");
  }
  const captured = await loadGovernedConversationPrefix({
    conversationId: prepared.authority.conversationId,
    organizationId: prepared.authority.organizationId,
    expectedHead: input.expectedHead,
    event: preparedEvent.event,
  });
  // foldConversation enforces current goal, policy epoch, and dependency
  // revisions. A structurally valid but semantically stale spawn never reaches SQL.
  if (captured.exactReplay) {
    const state = foldConversation(captured.log);
    if (!state.workers.some(({ workerId: id }) => id === workerId)) {
      throw new Error("exact worker spawn replay is absent from the conversation projection");
    }
  } else {
    appendAndFoldGovernedEvent(captured.log, preparedEvent.event);
  }

  const row = await qOne<{ conversation_event: unknown; worker_job: WorkerRow }>(
    `SELECT * FROM spawn_governed_voice_worker(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
     )`,
    [
      prepared.authority.conversationId,
      prepared.authority.organizationId,
      input.expectedHead.sha256,
      input.conversationEvent.idempotencyKey,
      preparedEvent.unsignedEventText,
      preparedEvent.event.hash,
      workerId,
      input.workerIdempotencyKey,
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
  if (!row) throw new Error("governed voice worker spawn returned no transition");
  verifyGovernedConversationEventRow(row.conversation_event, preparedEvent, {
    organizationId: prepared.authority.organizationId,
    idempotencyKey: input.conversationEvent.idempotencyKey,
  });
  const worker = projectWorker(row.worker_job);
  if (worker.id !== workerId || worker.conversationId !== prepared.authority.conversationId ||
      worker.organizationId !== prepared.authority.organizationId || worker.authoritySha256 !== prepared.authoritySha256) {
    throw new Error("governed voice worker spawn returned a different worker");
  }
  return Object.freeze({ event: preparedEvent.event, worker });
}

/**
 * Commits a host-derived worker.result_delivered event and acknowledges its
 * leased inbox message atomically. Database evidence is independently checked
 * against this event before either side of the transition can commit.
 */
export async function applyGovernedDurableConversationInboxMessage(input: Readonly<{
  expectedHead: ConversationHead;
  conversationEvent: GovernedConversationEventIdentity;
  organizationId: string;
  deliveryToken: string;
  applicationId: string;
  worker: DurableVoiceWorkerDelivery;
  message: DurableConversationResultInboxMessage;
}>): Promise<Readonly<{
  event: ConversationEvent;
  message: DurableConversationResultInboxMessage;
  decision: WorkerDeliveryRecord & Readonly<{ status: "accepted" | "rejected" }>;
}>> {
  if (input.worker.organizationId !== input.organizationId ||
      input.worker.id !== input.message.workerId ||
      input.worker.conversationId !== input.message.conversationId) {
    throw new Error("governed worker result crossed its durable scope");
  }
  if (input.message.deliveryToken !== null && input.message.deliveryToken !== input.deliveryToken) {
    throw new Error("governed worker result delivery token does not match the claimed message");
  }
  const payload = workerResultConversationPayload(input.worker, input.message);
  const preparedEvent = prepareGovernedConversationEvent({
    conversationId: input.worker.conversationId,
    expectedHead: input.expectedHead,
    idempotencyKey: input.conversationEvent.idempotencyKey,
    draft: {
      eventId: input.conversationEvent.eventId,
      occurredAtMs: input.conversationEvent.occurredAtMs,
      payload,
    },
  });
  const captured = await loadGovernedConversationPrefix({
    conversationId: input.worker.conversationId,
    organizationId: input.organizationId,
    expectedHead: input.expectedHead,
    event: preparedEvent.event,
  });
  const delivery = captured.exactReplay
    ? foldConversation(captured.log).deliveries.find((item) => item.eventId === preparedEvent.event.eventId) ?? null
    : appendAndFoldGovernedEvent(captured.log, preparedEvent.event).delivery;
  if (!delivery || delivery.status === "deferred") {
    throw new GovernedWorkerResultNotApplicableError(delivery ?? {
      deliveryId: input.message.id,
      workerId: input.worker.id,
      eventId: preparedEvent.event.eventId,
      status: "rejected",
      reason: "conversation kernel did not produce a delivery decision",
      appliedSequence: null,
      logicalHash: sha256Text(canonicalJson(payload)),
    });
  }
  const row = await qOne<{ conversation_event: unknown; inbox_message: InboxRow }>(
    `SELECT * FROM apply_governed_voice_worker_result(
       $1,$2,$3,$4,$5,$6,$7,$8,$9
     )`,
    [
      input.message.id,
      input.worker.conversationId,
      input.organizationId,
      input.deliveryToken,
      input.applicationId,
      input.expectedHead.sha256,
      input.conversationEvent.idempotencyKey,
      preparedEvent.unsignedEventText,
      preparedEvent.event.hash,
    ]
  );
  if (!row) throw new Error("governed worker result application returned no transition");
  verifyGovernedConversationEventRow(row.conversation_event, preparedEvent, {
    organizationId: input.organizationId,
    idempotencyKey: input.conversationEvent.idempotencyKey,
  });
  const message = projectInbox(row.inbox_message);
  if (message.kind !== "result"
      || message.id !== input.message.id || message.workerId !== input.worker.id ||
      message.conversationId !== input.worker.conversationId || message.applicationId !== input.applicationId ||
      message.resultSha256 !== input.message.resultSha256 || message.appliedAt === null || message.acknowledgedAt === null) {
    throw new Error("governed worker result application returned a different inbox message");
  }
  return Object.freeze({
    event: preparedEvent.event,
    message,
    decision: delivery as WorkerDeliveryRecord & Readonly<{ status: "accepted" | "rejected" }>,
  });
}

/**
 * Projects a failed/cancelled/indeterminate durable worker into the kernel and
 * acknowledges its terminal outbox message in the same database transition.
 * Raw worker errors never enter the conversation event or provider packet.
 */
export async function applyGovernedDurableConversationTerminalMessage(input: Readonly<{
  expectedHead: ConversationHead;
  conversationEvent: GovernedConversationEventIdentity;
  organizationId: string;
  deliveryToken: string;
  applicationId: string;
  message: DurableConversationTerminalInboxMessage;
}>): Promise<Readonly<{
  event: ConversationEvent;
  message: DurableConversationTerminalInboxMessage;
}>> {
  if (input.message.deliveryToken !== null && input.message.deliveryToken !== input.deliveryToken) {
    throw new Error("governed worker terminal delivery token does not match the claimed message");
  }
  const payload = {
    type: "worker.finished" as const,
    workerId: input.message.workerId,
    status: input.message.terminalStatus,
    reasonCode: input.message.reasonCode,
    evidenceSha256: input.message.evidenceSha256,
  };
  const preparedEvent = prepareGovernedConversationEvent({
    conversationId: input.message.conversationId,
    expectedHead: input.expectedHead,
    idempotencyKey: input.conversationEvent.idempotencyKey,
    draft: {
      eventId: input.conversationEvent.eventId,
      occurredAtMs: input.conversationEvent.occurredAtMs,
      payload,
    },
  });
  const captured = await loadGovernedConversationPrefix({
    conversationId: input.message.conversationId,
    organizationId: input.organizationId,
    expectedHead: input.expectedHead,
    event: preparedEvent.event,
  });
  if (!captured.exactReplay) appendAndFoldGovernedEvent(captured.log, preparedEvent.event);

  const row = await qOne<{ conversation_event: unknown; inbox_message: InboxRow }>(
    `SELECT * FROM apply_governed_voice_worker_terminal(
       $1,$2,$3,$4,$5,$6,$7,$8,$9
     )`,
    [
      input.message.id,
      input.message.conversationId,
      input.organizationId,
      input.deliveryToken,
      input.applicationId,
      input.expectedHead.sha256,
      input.conversationEvent.idempotencyKey,
      preparedEvent.unsignedEventText,
      preparedEvent.event.hash,
    ],
  );
  if (!row) throw new Error("governed worker terminal application returned no transition");
  verifyGovernedConversationEventRow(row.conversation_event, preparedEvent, {
    organizationId: input.organizationId,
    idempotencyKey: input.conversationEvent.idempotencyKey,
  });
  const message = projectInbox(row.inbox_message);
  if (
    message.kind !== "terminal"
    || message.id !== input.message.id
    || message.workerId !== input.message.workerId
    || message.conversationId !== input.message.conversationId
    || message.terminalStatus !== input.message.terminalStatus
    || message.evidenceSha256 !== input.message.evidenceSha256
    || message.applicationId !== input.applicationId
    || message.appliedAt === null
    || message.acknowledgedAt === null
  ) {
    throw new Error("governed worker terminal application returned a different inbox message");
  }
  return Object.freeze({ event: preparedEvent.event, message });
}

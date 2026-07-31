import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  CONVERSATION_KERNEL_VERSION,
  ConversationEventPayloadSchema,
  canonicalJson,
} from "./conversation-kernel";
import { qOne } from "./db";
import {
  hashFlowValue,
  promoteIndeterminateFlowAction,
  type FlowActionReceipt,
} from "./flow-runtime";
import { withLockedFlowState } from "./flow-state-store";
import {
  VoiceWorkerCapabilityManifestSchema,
  VoiceWorkerInputSchema,
  VoiceWorkerSpawnAuthoritySchema,
  canonicalVoiceWorkerJson,
  deriveVoiceWorkerId,
  hashVoiceWorkerValue,
  type VoiceWorkerCapabilityManifest,
  type VoiceWorkerInput,
  type VoiceWorkerSpawnAuthority,
} from "./voice-workers/schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const COORDINATOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const LAUNCH_TASK_WORKER_KIND = "call.research";
const LAUNCH_TASK_DELIVERABLE = "Return a concise read-only report for the active call.";
const RECONCILIATION_LEASE_MS = 60_000;
const MAX_RECONCILIATION_ATTEMPTS = 8;

export type GovernedLaunchTaskIdentity = Readonly<{
  operationSha256: string;
  turnId: string;
  operationId: string;
  workerIdempotencyKey: string;
  workerId: string;
  conversationEventId: string;
}>;

export type GovernedLaunchTaskResult = Readonly<{
  ok: true;
  worker_id: string;
  spawn_status: "accepted";
}>;

export type GovernedLaunchTaskRunActionResult = GovernedLaunchTaskResult & Readonly<{
  receipt_id: string;
  receipt_status: "succeeded";
}>;

export type GovernedLaunchTaskSpawnReceiptRow = Readonly<{
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
  spawn_created_at: Date | string;
  conversation_agent_id: string;
  conversation_agent_version: number;
  event_id: string;
  event_idempotency_key: string;
  event_sequence: string | number;
  event_occurred_at_ms: string | number;
  event_type: string;
  event_payload: unknown;
  event_previous_sha256: string;
  event_sha256: string;
  event_unsigned_text: string;
}>;

export type VerifiedGovernedLaunchTaskSpawn = Readonly<{
  identity: GovernedLaunchTaskIdentity;
  authority: VoiceWorkerSpawnAuthority;
  workerInput: VoiceWorkerInput;
  capabilityManifest: VoiceWorkerCapabilityManifest;
  result: GovernedLaunchTaskResult;
  proofResult: Readonly<{
    v: 1;
    kind: "governed_launch_task_spawn";
    workerId: string;
    workerIdempotencyKey: string;
    conversationEventId: string;
    conversationEventSha256: string;
    spawnAuthoritySha256: string;
    workerInputSha256: string;
    capabilityManifestSha256: string;
  }>;
  proofResultSha256: string;
}>;

export type GovernedLaunchTaskRecoveryOutcome =
  | Readonly<{
      reconciled: true;
      replayed: boolean;
      receiptId: string;
      proofId: string | null;
      result: GovernedLaunchTaskResult;
    }>
  | Readonly<{
      reconciled: false;
      code: string;
      error: string;
      receiptId: string;
      pending?: true;
      proofId?: string;
    }>;

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new Error(`${label} must be a UUID`);
}

function integer(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a safe non-negative integer`);
  return parsed;
}

function iso(value: Date | string, label: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function exactJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

/**
 * This mirrors the public coordinator identity contract without importing its
 * private helpers. The action-context key is already call/org scoped by the
 * Flow gateway; changing it changes every downstream worker identity.
 */
export function deriveGovernedLaunchTaskIdentity(input: Readonly<{
  conversationId: string;
  organizationId: string;
  flowActionIdempotencyKey: string;
}>): GovernedLaunchTaskIdentity {
  assertUuid(input.conversationId, "conversationId");
  assertUuid(input.organizationId, "organizationId");
  if (!SHA256.test(input.flowActionIdempotencyKey)) {
    throw new Error("flowActionIdempotencyKey must be a SHA-256 value");
  }
  const operationSha256 = createHash("sha256")
    .update("hacc/live-launch-task/v1\0", "utf8")
    .update(input.flowActionIdempotencyKey, "utf8")
    .digest("hex");
  const turnId = `worker-spawn-${operationSha256.slice(0, 32)}`;
  const operationId = `launch-task-${operationSha256.slice(0, 32)}`;
  if (!COORDINATOR_ID.test(turnId) || !COORDINATOR_ID.test(operationId)) {
    throw new Error("launch task coordinator identity is invalid");
  }
  const coordinatorSha256 = sha256Text(canonicalJson({
    schemaVersion: 1,
    scope: {
      conversationId: input.conversationId,
      organizationId: input.organizationId,
    },
    turnId,
    phase: "worker",
    operationId,
  }));
  const workerIdempotencyKey = `cc:${coordinatorSha256}`;
  return Object.freeze({
    operationSha256,
    turnId,
    operationId,
    workerIdempotencyKey,
    workerId: deriveVoiceWorkerId(input.conversationId, workerIdempotencyKey),
    conversationEventId: `cc-${coordinatorSha256}`,
  });
}

export function deriveGovernedLaunchTaskActionContextKey(input: Readonly<{
  organizationId: string;
  callId: string;
  ledgerIdempotencyKey: string;
}>): string {
  assertUuid(input.organizationId, "organizationId");
  assertUuid(input.callId, "callId");
  if (!input.ledgerIdempotencyKey || Buffer.byteLength(input.ledgerIdempotencyKey, "utf8") > 256) {
    throw new Error("ledgerIdempotencyKey must contain 1 to 256 UTF-8 bytes");
  }
  return hashFlowValue({
    domain: "hacc/downstream-action-idempotency/v1",
    orgId: input.organizationId,
    callId: input.callId,
    ledgerIdempotencyKey: input.ledgerIdempotencyKey,
  });
}

export function governedLaunchTaskResult(workerId: string): GovernedLaunchTaskResult {
  assertUuid(workerId, "workerId");
  return Object.freeze({
    ok: true as const,
    worker_id: workerId,
    spawn_status: "accepted" as const,
  });
}

export function governedLaunchTaskRunActionResult(
  workerId: string,
  receiptId: string,
): GovernedLaunchTaskRunActionResult {
  assertUuid(receiptId, "receiptId");
  return Object.freeze({
    ...governedLaunchTaskResult(workerId),
    receipt_id: receiptId,
    receipt_status: "succeeded" as const,
  });
}

export function buildGovernedLaunchTaskWorkerInput(input: Readonly<{
  command: string;
  receiptId: string;
  runtimeDigest: string;
  identity: GovernedLaunchTaskIdentity;
}>): VoiceWorkerInput {
  assertUuid(input.receiptId, "receiptId");
  if (!SHA256.test(input.runtimeDigest)) throw new Error("runtimeDigest must be a SHA-256 value");
  const command = input.command.trim();
  if (!command || Buffer.byteLength(command, "utf8") > 4_096) {
    throw new Error("launch_task command must contain 1 to 4096 UTF-8 bytes");
  }
  return VoiceWorkerInputSchema.parse({
    v: 1,
    objective: command,
    context: {
      launchAuthority: {
        v: 1,
        flowReceiptId: input.receiptId,
        runtimeDigest: input.runtimeDigest,
        operationSha256: input.identity.operationSha256,
        workerIdempotencyKeySha256: sha256Text(input.identity.workerIdempotencyKey),
      },
    },
    deliverable: LAUNCH_TASK_DELIVERABLE,
  });
}

/**
 * Verifies the complete immutable spawn boundary. No mutable worker status,
 * lease, checkpoint, result, error, or owner capability participates.
 */
export function verifyGovernedLaunchTaskSpawnReceipt(input: Readonly<{
  row: GovernedLaunchTaskSpawnReceiptRow;
  organizationId: string;
  conversationId: string;
  flowActionIdempotencyKey: string;
  receiptId: string;
  runtimeDigest: string;
  reservedAt: string;
  actionArguments: Readonly<Record<string, unknown>>;
}>): VerifiedGovernedLaunchTaskSpawn {
  const identity = deriveGovernedLaunchTaskIdentity({
    conversationId: input.conversationId,
    organizationId: input.organizationId,
    flowActionIdempotencyKey: input.flowActionIdempotencyKey,
  });
  const row = input.row;
  const command = typeof input.actionArguments.command === "string"
    ? input.actionArguments.command.trim()
    : "";
  if (!command || Buffer.byteLength(command, "utf8") > 4_096) {
    throw new Error("launch_task receipt does not contain a valid command");
  }
  if (
    row.id !== identity.workerId
    || row.conversation_id !== input.conversationId
    || row.org_id !== input.organizationId
    || row.parent_worker_id !== null
    || row.source_call_id !== input.conversationId
    || row.idempotency_key !== identity.workerIdempotencyKey
    || row.worker_kind !== LAUNCH_TASK_WORKER_KIND
  ) {
    throw new Error("launch_task worker identity or immutable scope does not match");
  }
  assertUuid(row.conversation_agent_id, "conversation agent");
  const agentVersion = integer(row.conversation_agent_version, "conversation agent version");
  if (agentVersion < 1) throw new Error("conversation agent version must be positive");

  const capabilityManifest = VoiceWorkerCapabilityManifestSchema.parse(row.capability_manifest);
  const capabilityManifestSha256 = hashVoiceWorkerValue(capabilityManifest);
  if (
    row.capability_manifest_sha256 !== capabilityManifestSha256
    || canonicalVoiceWorkerJson(capabilityManifest) !== canonicalVoiceWorkerJson(row.capability_manifest)
  ) {
    throw new Error("launch_task capability manifest digest does not match immutable evidence");
  }

  const workerInput = VoiceWorkerInputSchema.parse(row.worker_input);
  const workerInputSha256 = hashVoiceWorkerValue(workerInput);
  const expectedWorkerInput = buildGovernedLaunchTaskWorkerInput({
    command,
    receiptId: input.receiptId,
    runtimeDigest: input.runtimeDigest,
    identity,
  });
  if (
    !exactJson(workerInput, expectedWorkerInput)
    || row.worker_input_sha256 !== workerInputSha256
    || canonicalVoiceWorkerJson(workerInput) !== canonicalVoiceWorkerJson(row.worker_input)
  ) {
    throw new Error("launch_task worker input does not match its Flow receipt");
  }

  const authority = VoiceWorkerSpawnAuthoritySchema.parse(row.spawn_authority);
  const authoritySha256 = hashVoiceWorkerValue(authority);
  if (
    authority.conversationId !== input.conversationId
    || authority.organizationId !== input.organizationId
    || authority.agentId !== row.conversation_agent_id
    || authority.agentVersion !== agentVersion
    || authority.source !== "voice_call"
    || authority.sourceCallId !== input.conversationId
    || authority.sourceWorkerId !== undefined
    || authority.capabilityManifestSha256 !== capabilityManifestSha256
    || row.spawn_authority_sha256 !== authoritySha256
    || canonicalVoiceWorkerJson(authority) !== canonicalVoiceWorkerJson(row.spawn_authority)
  ) {
    throw new Error("launch_task spawn authority does not match immutable conversation authority");
  }

  const eventSequence = integer(row.event_sequence, "conversation event sequence");
  if (eventSequence < 1) throw new Error("conversation event sequence must be positive");
  const eventOccurredAtMs = integer(row.event_occurred_at_ms, "conversation event timestamp");
  const reservedAtMs = Date.parse(input.reservedAt);
  if (!Number.isSafeInteger(reservedAtMs) || reservedAtMs < 0 || eventOccurredAtMs !== reservedAtMs) {
    throw new Error("launch_task worker event timestamp does not match its Flow reservation");
  }
  const eventPayload = ConversationEventPayloadSchema.parse(row.event_payload);
  const expectedPayload = {
    type: "worker.spawned" as const,
    workerId: identity.workerId,
    goalId: authority.goalId,
    purpose: workerInput.objective,
    policyEpoch: authority.policyEpoch,
    dependencies: authority.factDependencies,
  };
  const unsignedEvent = {
    version: CONVERSATION_KERNEL_VERSION,
    conversationId: input.conversationId,
    sequence: eventSequence,
    previousHash: row.event_previous_sha256,
    eventId: row.event_id,
    occurredAtMs: eventOccurredAtMs,
    payload: eventPayload,
  };
  const unsignedEventText = canonicalJson(unsignedEvent);
  if (
    row.event_id !== identity.conversationEventId
    || row.event_idempotency_key !== identity.workerIdempotencyKey
    || row.event_type !== "worker.spawned"
    || !exactJson(eventPayload, expectedPayload)
    || !SHA256.test(row.event_previous_sha256)
    || row.event_unsigned_text !== unsignedEventText
    || row.event_sha256 !== sha256Text(unsignedEventText)
    || authority.conversationHeadSha256 !== row.event_sha256
    || authority.conversationRevision !== eventSequence
  ) {
    throw new Error("launch_task worker.spawned event failed immutable evidence verification");
  }
  const createdAt = row.spawn_created_at instanceof Date
    ? row.spawn_created_at
    : new Date(row.spawn_created_at);
  if (!Number.isFinite(createdAt.getTime())) throw new Error("launch_task spawn timestamp is invalid");

  const result = governedLaunchTaskResult(identity.workerId);
  const proofResult = Object.freeze({
    v: 1 as const,
    kind: "governed_launch_task_spawn" as const,
    workerId: identity.workerId,
    workerIdempotencyKey: identity.workerIdempotencyKey,
    conversationEventId: identity.conversationEventId,
    conversationEventSha256: row.event_sha256,
    spawnAuthoritySha256: row.spawn_authority_sha256,
    workerInputSha256: row.worker_input_sha256,
    capabilityManifestSha256: row.capability_manifest_sha256,
  });
  return Object.freeze({
    identity,
    authority,
    workerInput,
    capabilityManifest,
    result,
    proofResult,
    proofResultSha256: hashFlowValue(proofResult),
  });
}

export async function loadGovernedLaunchTaskSpawnReceipt(input: Readonly<{
  workerId: string;
  organizationId: string;
  conversationId: string;
}>): Promise<GovernedLaunchTaskSpawnReceiptRow | null> {
  assertUuid(input.workerId, "workerId");
  assertUuid(input.organizationId, "organizationId");
  assertUuid(input.conversationId, "conversationId");
  return qOne<GovernedLaunchTaskSpawnReceiptRow>(
    "SELECT * FROM load_governed_launch_task_spawn_receipt($1,$2,$3)",
    [input.workerId, input.organizationId, input.conversationId],
  );
}

function matchingSucceededReceipt(
  receipt: FlowActionReceipt,
  result: GovernedLaunchTaskResult,
): boolean {
  return receipt.status === "succeeded"
    && receipt.resultHash === hashFlowValue(result)
    && exactJson(receipt.result, result);
}

/**
 * Promotes only an already-indeterminate `launch_task`, using the exact worker
 * spawn as a committed read-back proof. The proof row, SQL receipt, and embedded
 * Flow receipt settle in one transaction; a crash rolls all three back.
 */
export async function reconcileIndeterminateGovernedLaunchTask(input: Readonly<{
  callId: string;
  organizationId: string;
  conversationId: string;
  receiptId: string;
  runtimeDigest: string;
}>): Promise<GovernedLaunchTaskRecoveryOutcome> {
  assertUuid(input.callId, "callId");
  assertUuid(input.organizationId, "organizationId");
  assertUuid(input.conversationId, "conversationId");
  assertUuid(input.receiptId, "receiptId");
  if (input.callId !== input.conversationId) {
    throw new Error("live launch_task recovery requires the call and conversation identities to match");
  }
  if (!SHA256.test(input.runtimeDigest)) throw new Error("runtimeDigest must be a SHA-256 value");

  const locked = await withLockedFlowState<GovernedLaunchTaskRecoveryOutcome>(
    input.callId,
    async (state, client) => {
      const embedded = state.actionReceipts.find(({ id }) => id === input.receiptId);
      if (!embedded) {
        return {
          value: {
            reconciled: false,
            code: "unknown_receipt",
            error: "launch_task Flow receipt is missing",
            receiptId: input.receiptId,
          },
        };
      }
      const ledgerQuery = await client.query<{
        status: string;
        runtime_digest: string;
        tool: string;
        arguments: unknown;
        arguments_hash: string;
        idempotency_key: string;
        dispatch_started_at: Date | null;
        reconciliation_proof_id: string | null;
        result: unknown;
        result_hash: string | null;
        call_status: string;
        call_runtime_digest: string | null;
        capability_epoch: number;
        invocation_id: string;
        reserved_at: Date | string;
        db_now: Date | string;
      }>(
        `SELECT receipt.status, receipt.runtime_digest, receipt.tool,
                receipt.arguments, receipt.arguments_hash, receipt.idempotency_key,
                receipt.dispatch_started_at, receipt.reconciliation_proof_id,
                receipt.result, receipt.result_hash, call_row.status AS call_status,
                call_row.runtime_digest AS call_runtime_digest,
                receipt.capability_epoch, receipt.invocation_id,
                receipt.reserved_at, clock_timestamp() AS db_now
         FROM flow_action_receipts receipt
         JOIN calls call_row ON call_row.id = receipt.call_id
         JOIN agents agent ON agent.id = call_row.agent_id
         WHERE receipt.id = $1 AND receipt.call_id = $2 AND agent.org_id = $3
         FOR UPDATE OF receipt, call_row`,
        [input.receiptId, input.callId, input.organizationId],
      );
      const ledger = ledgerQuery.rows[0];
      if (
        !ledger
        || ledger.runtime_digest !== input.runtimeDigest
        || ledger.call_runtime_digest !== input.runtimeDigest
        || embedded.tool !== "launch_task"
        || ledger.tool !== embedded.tool
        || ledger.capability_epoch !== embedded.capabilityEpoch
        || ledger.invocation_id !== embedded.invocationId
        || ledger.arguments_hash !== embedded.argumentsHash
        || ledger.idempotency_key !== embedded.idempotencyKey
        || !ledger.dispatch_started_at
        || !embedded.dispatchStartedAt
        || iso(ledger.dispatch_started_at, "ledger dispatch timestamp") !== embedded.dispatchStartedAt
        || iso(ledger.reserved_at, "ledger reservation timestamp") !== embedded.reservedAt
      ) {
        return {
          value: {
            reconciled: false,
            code: "receipt_state_mismatch",
            error: "launch_task Flow state and durable ledger disagree",
            receiptId: input.receiptId,
          },
        };
      }
      if (ledger.call_status !== "active") {
        return {
          value: {
            reconciled: false,
            code: "call_not_active",
            error: "launch_task recovery authority is no longer active",
            receiptId: input.receiptId,
          },
        };
      }
      if (!ledger.arguments || typeof ledger.arguments !== "object" || Array.isArray(ledger.arguments)) {
        return {
          value: {
            reconciled: false,
            code: "receipt_state_mismatch",
            error: "launch_task receipt arguments are invalid",
            receiptId: input.receiptId,
          },
        };
      }
      if (
        hashFlowValue(ledger.arguments) !== ledger.arguments_hash
        || !exactJson(ledger.arguments, embedded.arguments)
      ) {
        return {
          value: {
            reconciled: false,
            code: "receipt_state_mismatch",
            error: "launch_task receipt argument evidence is inconsistent",
            receiptId: input.receiptId,
          },
        };
      }
      const flowActionIdempotencyKey = deriveGovernedLaunchTaskActionContextKey({
        organizationId: input.organizationId,
        callId: input.callId,
        ledgerIdempotencyKey: ledger.idempotency_key,
      });
      const identity = deriveGovernedLaunchTaskIdentity({
        conversationId: input.conversationId,
        organizationId: input.organizationId,
        flowActionIdempotencyKey,
      });
      const projection = await client.query<GovernedLaunchTaskSpawnReceiptRow>(
        "SELECT * FROM load_governed_launch_task_spawn_receipt($1,$2,$3)",
        [identity.workerId, input.organizationId, input.conversationId],
      );
      if (!projection.rows[0]) {
        return {
          value: {
            reconciled: false,
            code: "launch_task_spawn_not_found",
            error: "no exact durable launch_task spawn exists",
            receiptId: input.receiptId,
          },
        };
      }
      let verified: VerifiedGovernedLaunchTaskSpawn;
      try {
        verified = verifyGovernedLaunchTaskSpawnReceipt({
          row: projection.rows[0],
          organizationId: input.organizationId,
          conversationId: input.conversationId,
          flowActionIdempotencyKey,
          receiptId: input.receiptId,
          runtimeDigest: input.runtimeDigest,
          reservedAt: embedded.reservedAt,
          actionArguments: ledger.arguments as Record<string, unknown>,
        });
      } catch {
        return {
          value: {
            reconciled: false,
            code: "launch_task_spawn_evidence_mismatch",
            error: "durable launch_task spawn evidence did not verify",
            receiptId: input.receiptId,
          },
        };
      }

      if (embedded.status === "succeeded" && ledger.status === "succeeded") {
        if (
          !matchingSucceededReceipt(embedded, verified.result)
          || ledger.result_hash !== hashFlowValue(verified.result)
          || !exactJson(ledger.result, verified.result)
        ) {
          return {
            value: {
              reconciled: false,
              code: "receipt_state_mismatch",
              error: "settled launch_task receipt conflicts with its durable spawn",
              receiptId: input.receiptId,
            },
          };
        }
        return {
          value: {
            reconciled: true,
            replayed: true,
            receiptId: input.receiptId,
            proofId: ledger.reconciliation_proof_id,
            result: verified.result,
          },
        };
      }
      if (
        embedded.status !== "indeterminate"
        || ledger.status !== "indeterminate"
        || ledger.reconciliation_proof_id !== null
      ) {
        return {
          value: {
            reconciled: false,
            code: "receipt_not_indeterminate",
            error: "launch_task receipt is not eligible for spawn reconciliation",
            receiptId: input.receiptId,
          },
        };
      }

      const activeProof = await client.query<{ id: string; lease_valid: boolean }>(
        `SELECT id, lease_expires_at > clock_timestamp() AS lease_valid
         FROM flow_action_reconciliation_proofs
         WHERE action_receipt_id = $1 AND status = 'querying'
         FOR UPDATE`,
        [input.receiptId],
      );
      if (activeProof.rows[0]?.lease_valid) {
        return {
          value: {
            reconciled: false,
            code: "reconciliation_pending",
            error: "another launch_task reconciliation owns the proof lease",
            receiptId: input.receiptId,
            pending: true,
            proofId: activeProof.rows[0].id,
          },
        };
      }
      if (activeProof.rows[0]) {
        await client.query(
          `UPDATE flow_action_reconciliation_proofs
           SET status = 'error', error = $3, completed_at = clock_timestamp()
           WHERE id = $1 AND call_id = $2 AND status = 'querying'`,
          [
            activeProof.rows[0].id,
            input.callId,
            JSON.stringify({ code: "reconciliation_owner_expired" }),
          ],
        );
      }
      const attempts = await client.query<{ last_attempt: number }>(
        `SELECT COALESCE(MAX(attempt), 0)::int AS last_attempt
         FROM flow_action_reconciliation_proofs
         WHERE action_receipt_id = $1`,
        [input.receiptId],
      );
      const attempt = (attempts.rows[0]?.last_attempt ?? 0) + 1;
      if (attempt > MAX_RECONCILIATION_ATTEMPTS) {
        return {
          value: {
            reconciled: false,
            code: "reconciliation_attempt_limit",
            error: "launch_task reconciliation attempt limit reached",
            receiptId: input.receiptId,
          },
        };
      }
      const proofId = randomUUID();
      const ownerToken = randomUUID();
      const queryArguments = {
        worker_id: verified.identity.workerId,
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
      };
      const predicate = {
        v: 1,
        kind: "exact_immutable_launch_task_spawn",
        expectedWorkerId: verified.identity.workerId,
      };
      const policyHash = hashFlowValue({
        v: 1,
        domain: "hacc/governed-launch-task-recovery-policy",
        runtimeDigest: input.runtimeDigest,
        workerKind: LAUNCH_TASK_WORKER_KIND,
        result: verified.result,
      });
      await client.query(
        `INSERT INTO flow_action_reconciliation_proofs
          (id, call_id, action_receipt_id, runtime_digest, policy_hash, attempt,
           query_tool, query_arguments, query_arguments_hash, predicate, predicate_hash,
           authoritative_result_path, status, owner_token, lease_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'load_governed_launch_task_spawn_receipt',
                 $7,$8,$9,$10,'$','querying',$11,
                 clock_timestamp() + ($12 * interval '1 millisecond'))`,
        [
          proofId,
          input.callId,
          input.receiptId,
          input.runtimeDigest,
          policyHash,
          attempt,
          JSON.stringify(queryArguments),
          hashFlowValue(queryArguments),
          JSON.stringify(predicate),
          hashFlowValue(predicate),
          ownerToken,
          RECONCILIATION_LEASE_MS,
        ],
      );
      const promoted = promoteIndeterminateFlowAction(state, {
        receiptId: input.receiptId,
        proofId,
        result: verified.result,
      }, iso(ledger.db_now, "database reconciliation timestamp"));
      if ("error" in promoted) {
        throw new Error(`launch_task Flow promotion failed: ${promoted.code}`);
      }
      const resultSha256 = hashFlowValue(verified.result);
      const committedProof = await client.query(
        `UPDATE flow_action_reconciliation_proofs
         SET status = 'committed', proof_result = $4, proof_result_hash = $5,
             authoritative_result = $6, authoritative_result_hash = $7,
             completed_at = clock_timestamp()
         WHERE id = $1 AND call_id = $2 AND owner_token = $3 AND status = 'querying'`,
        [
          proofId,
          input.callId,
          ownerToken,
          JSON.stringify(verified.proofResult),
          verified.proofResultSha256,
          JSON.stringify(verified.result),
          resultSha256,
        ],
      );
      if (committedProof.rowCount !== 1) {
        throw new Error("launch_task proof ownership changed while recovery held its lock");
      }
      const updated = await client.query(
        `UPDATE flow_action_receipts
         SET status = 'succeeded', result = $3, result_hash = $4,
             reconciliation_proof_id = $5, delivery_state = 'committed',
             error = NULL, settled_at = $6
         WHERE id = $1 AND call_id = $2 AND status = 'indeterminate'
           AND reconciliation_proof_id IS NULL`,
        [
          input.receiptId,
          input.callId,
          JSON.stringify(verified.result),
          resultSha256,
          proofId,
          promoted.receipt.settledAt,
        ],
      );
      if (updated.rowCount !== 1) throw new Error("launch_task receipt changed while recovery held its lock");
      return {
        state: promoted.state,
        value: {
          reconciled: true,
          replayed: false,
          receiptId: input.receiptId,
          proofId,
          result: verified.result,
        },
      };
    },
  );
  return locked.value;
}

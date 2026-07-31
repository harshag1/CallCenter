import "server-only";

import { createHmac } from "node:crypto";
import { z } from "zod";
import { qOne } from "./db";
import {
  normalizePublicCallOperationsStatus,
  projectCallOperations,
  type CallOperationsProjection,
} from "./call-operations-projection";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOT_SECRET = /^[a-f0-9]{64}$/;

const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: "invalid operational timestamp",
});

const OperationsReceiptSchema = z.object({
  id: z.string().regex(UUID),
  tool: z.string().min(1).max(256),
  capabilityEpoch: z.number().int().nonnegative(),
  dispatchAttempt: z.number().int().nonnegative(),
  status: z.enum([
    "reserved",
    "succeeded",
    "failed",
    "indeterminate",
    "redacted_unknown",
  ]),
  dispatchStartedAt: timestamp.optional(),
  reservedAt: timestamp,
  settledAt: timestamp.optional(),
  reconciliationProofId: z.string().regex(UUID).optional(),
  error: z.string().min(1).max(128).optional(),
}).strict();

const OperationsFlowStateSchema = z.object({
  capabilityEpoch: z.number().int().nonnegative().safe().nullable(),
  revision: z.number().int().nonnegative().safe(),
  actionReceipts: z.array(OperationsReceiptSchema).max(256),
}).strict();

const CountSummarySchema = z.object({
  total: z.number().int().nonnegative().safe(),
  byStatus: z.record(z.string(), z.number().int().nonnegative().safe()),
}).strict();

const WorkerSummarySchema = CountSummarySchema.extend({
  byDeliveryState: z.record(z.string(), z.number().int().nonnegative().safe()),
}).strict();

const ActionSummarySchema = CountSummarySchema.extend({
  maxCapabilityEpoch: z.number().int().nonnegative().safe().nullable(),
}).strict();

const ConversationAuthoritySchema = z.object({
  kind: z.literal("materialized_head"),
  revision: z.number().int().nonnegative().safe(),
  headSha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotCapturedAtMs: z.number().int().nonnegative().safe(),
  eventRowsRead: z.literal(0),
}).strict();

const OperationsWorkerSchema = z.object({
  id: z.string().regex(UUID),
  parentWorkerId: z.string().regex(UUID).nullable(),
  status: z.enum([
    "pending",
    "running",
    "cancel_requested",
    "succeeded",
    "failed",
    "cancelled",
    "indeterminate",
    "redacted_unknown",
  ]),
  authority: z.object({
    policyEpoch: z.number().int().nonnegative().safe().nullable(),
  }).strict(),
  leaseExpiresAt: timestamp.nullable(),
  cancellationEpoch: z.number().int().nonnegative().safe(),
  checkpointPresent: z.boolean(),
  resultPresent: z.boolean(),
  errorPresent: z.boolean(),
  settledAt: timestamp.nullable(),
  deliveryState: z.enum([
    "not_settled",
    "awaiting_delivery",
    "delivered",
    "terminal",
  ]),
}).strict();

const PolicyDecisionSchema = z.object({
  stage: z.literal("pre_dispatch"),
  observedAtMs: z.number().int().nonnegative(),
  decision: z.object({
    decision: z.enum(["allow", "deny", "require_confirmation"]),
    reason: z.string().min(1).max(128),
    action: z.string().min(1).max(128),
  }).strict(),
}).strict();

const PolicySummarySchema = z.object({
  observations: z.number().int().nonnegative(),
  denials: z.number().int().nonnegative(),
  byDecision: z.record(z.string(), z.number().int().nonnegative()),
}).strict();

const SourceObservationSchema = z.object({
  source: z.enum(["flow", "conversation", "workers", "policy"]),
  observedAtMs: z.number().int().nonnegative().nullable(),
}).strict();

const RecoveryObservationSchema = z.object({
  kind: z.enum(["action_reconciled", "worker_checkpointed", "worker_reclaimed", "worker_indeterminate"]),
  subjectId: z.string().min(1).max(2_048),
  observedAtMs: z.number().int().nonnegative(),
}).strict();

const RecoverySummarySchema = z.object({
  observations: z.number().int().nonnegative(),
  byKind: z.record(z.string(), z.number().int().nonnegative()),
  lastObservedAtMs: z.number().int().nonnegative().nullable(),
}).strict();

const DurableOperationsSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  callId: z.string().regex(UUID),
  organizationId: z.string().regex(UUID),
  capturedAtMs: z.number().int().nonnegative().safe(),
  callStatus: z.string().min(1).max(128),
  conversationAuthority: ConversationAuthoritySchema.nullable(),
  flowState: OperationsFlowStateSchema.nullable(),
  actionSummary: ActionSummarySchema,
  durableWorkers: z.array(OperationsWorkerSchema).max(256),
  durableWorkerSummary: WorkerSummarySchema,
  policyDecisions: z.array(PolicyDecisionSchema).max(256),
  policySummary: PolicySummarySchema,
  sourceObservations: z.array(SourceObservationSchema).length(4),
  recoveryObservations: z.array(RecoveryObservationSchema).max(256),
  recoverySummary: RecoverySummarySchema,
}).strict();

export class CallOperationsConfigurationError extends Error {
  readonly code = "call_operations_configuration_error" as const;

  constructor() {
    super("CALL_OPERATIONS_REDACTION_SECRET must be an independent 64-character lowercase hexadecimal secret");
    this.name = "CallOperationsConfigurationError";
  }
}

export function deriveOrganizationOperationsKey(
  rootSecret: string,
  organizationId: string,
): Buffer {
  if (!ROOT_SECRET.test(rootSecret)) throw new CallOperationsConfigurationError();
  if (!UUID.test(organizationId)) throw new Error("organizationId must be a UUID");
  return createHmac("sha256", Buffer.from(rootSecret, "hex"))
    .update("hacc/call-operations/organization-key/v1\0", "utf8")
    .update(organizationId.toLowerCase(), "utf8")
    .digest();
}

export async function loadCallOperationsProjection(input: Readonly<{
  callId: string;
  organizationId: string;
  redactionRootSecret?: string;
}>): Promise<CallOperationsProjection | null> {
  if (!UUID.test(input.callId) || !UUID.test(input.organizationId)) {
    throw new Error("call and organization identities must be UUIDs");
  }
  const redactionKey = deriveOrganizationOperationsKey(
    input.redactionRootSecret ?? process.env.CALL_OPERATIONS_REDACTION_SECRET ?? "",
    input.organizationId,
  );
  const row = await qOne<{ snapshot: unknown }>(
    "SELECT read_call_operations_snapshot($1,$2) AS snapshot",
    [input.callId, input.organizationId],
  );
  if (!row?.snapshot) return null;
  const snapshot = DurableOperationsSnapshotSchema.parse(row.snapshot);
  if (
    snapshot.callId.toLowerCase() !== input.callId.toLowerCase()
    || snapshot.organizationId.toLowerCase() !== input.organizationId.toLowerCase()
  ) {
    throw new Error("call operations snapshot escaped its requested organization scope");
  }
  return projectCallOperations({
    callId: input.callId,
    redactionKey,
    generatedAtMs: snapshot.capturedAtMs,
    callStatus:
      normalizePublicCallOperationsStatus(snapshot.callStatus)
      ?? "redacted_unknown",
    flowState: snapshot.flowState ?? undefined,
    conversationAuthority: snapshot.conversationAuthority ?? undefined,
    actionSummary: snapshot.actionSummary,
    durableWorkers: snapshot.durableWorkers,
    durableWorkerSummary: snapshot.durableWorkerSummary,
    policyDecisions: snapshot.policyDecisions,
    policySummary: snapshot.policySummary,
    sourceObservations: snapshot.sourceObservations,
    recoveryObservations: snapshot.recoveryObservations,
    recoverySummary: snapshot.recoverySummary,
  });
}

import { z } from "zod";

export const CONVERSATION_PROGRAM_VERSION = 1 as const;
export const CONVERSATION_PROGRAM_GENESIS_SHA256 = "0".repeat(64);

export type ProgramJson =
  | null
  | boolean
  | number
  | string
  | ProgramJson[]
  | { [key: string]: ProgramJson };

const IdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const TextSchema = z.string().trim().min(1).max(4_096);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const RevisionSchema = z.number().int().nonnegative().safe();
const PositiveRevisionSchema = z.number().int().positive().safe();
const TimestampSchema = z.iso.datetime({ offset: true });
const JsonSchema = z.json().superRefine((value, context) => {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1_024) {
    context.addIssue({ code: "custom", message: "JSON value exceeds 16 KiB" });
  }
}).transform((value) => value as ProgramJson);

export const ProgramAuthoritySchema = z.object({
  kind: z.enum(["caller", "tool", "policy", "operator", "system"]),
  evidenceSha256: Sha256Schema,
}).strict();
export type ProgramAuthority = z.infer<typeof ProgramAuthoritySchema>;

const FactAssertedSchema = z.object({
  type: z.literal("fact.asserted"),
  key: IdSchema,
  value: JsonSchema,
  authority: ProgramAuthoritySchema,
}).strict();

const FactCorrectedSchema = z.object({
  type: z.literal("fact.corrected"),
  key: IdSchema,
  value: JsonSchema,
  expectedFactRevision: PositiveRevisionSchema,
  authority: ProgramAuthoritySchema,
}).strict();

const GoalOpenedSchema = z.object({
  type: z.literal("goal.opened"),
  goalId: IdSchema,
  description: TextSchema,
}).strict();

const GoalFocusedSchema = z.object({
  type: z.literal("goal.focused"),
  goalId: IdSchema,
}).strict();

const GoalSuspendedSchema = z.object({
  type: z.literal("goal.suspended"),
  goalId: IdSchema,
  reason: TextSchema,
}).strict();

const GoalCompletedSchema = z.object({
  type: z.literal("goal.completed"),
  goalId: IdSchema,
}).strict();

const FlowCheckpointRecordedSchema = z.object({
  type: z.literal("flow.checkpoint_recorded"),
  goalId: IdSchema,
  flowId: IdSchema,
  flowVersion: z.string().min(1).max(128),
  flowRevision: RevisionSchema,
  capabilityEpoch: RevisionSchema,
  status: z.enum(["routing", "active", "completed", "failed"]),
  nodeId: IdSchema.nullable(),
  stepPath: z.string().min(1).max(1_024).nullable(),
  completedStepCount: RevisionSchema,
  stateSha256: Sha256Schema,
}).strict().superRefine((checkpoint, context) => {
  if (checkpoint.status === "routing" && (checkpoint.nodeId !== null || checkpoint.stepPath !== null)) {
    context.addIssue({ code: "custom", message: "routing checkpoint cannot retain a node or step" });
  }
  if (checkpoint.status === "active" && checkpoint.nodeId === null) {
    context.addIssue({ code: "custom", message: "active checkpoint requires a node" });
  }
  if ((checkpoint.status === "completed" || checkpoint.status === "failed") && checkpoint.stepPath !== null) {
    context.addIssue({ code: "custom", message: "terminal checkpoint cannot retain an active step" });
  }
});

const ObligationOpenedSchema = z.object({
  type: z.literal("obligation.opened"),
  obligationId: IdSchema,
  obligationType: IdSchema,
  description: TextSchema,
  owner: z.enum(["agent", "caller", "human", "system"]),
  blocks: z.enum(["goal_completion", "program_completion", "irreversible_actions"]),
  goalId: IdSchema.nullable(),
  sourceId: IdSchema,
}).strict();

const ObligationSettledSchema = z.object({
  type: z.literal("obligation.settled"),
  obligationId: IdSchema,
  disposition: z.enum(["satisfied", "waived"]),
  evidenceSha256: Sha256Schema,
}).strict();

const CapabilityEpochAdvancedSchema = z.object({
  type: z.literal("capability_epoch.advanced"),
  expectedEpoch: RevisionSchema,
  epoch: PositiveRevisionSchema,
  capabilities: z.array(IdSchema).max(1_024),
  reason: TextSchema,
}).strict().superRefine((event, context) => {
  if (new Set(event.capabilities).size !== event.capabilities.length) {
    context.addIssue({ code: "custom", path: ["capabilities"], message: "capabilities must be unique" });
  }
});

const ActionReservedSchema = z.object({
  type: z.literal("action.reserved"),
  reservationId: IdSchema,
  goalId: IdSchema,
  action: IdSchema,
  argumentsSha256: Sha256Schema,
  idempotencyKey: z.string().min(1).max(256),
  capabilityEpoch: RevisionSchema,
  authorityRevision: RevisionSchema,
}).strict();

const ActionReceiptRecordedSchema = z.object({
  type: z.literal("action.receipt_recorded"),
  receiptId: IdSchema,
  reservationId: IdSchema,
  status: z.enum(["succeeded", "failed", "indeterminate", "compensated"]),
  resultSha256: Sha256Schema.nullable(),
  evidenceSha256: Sha256Schema,
}).strict().superRefine((receipt, context) => {
  if ((receipt.status === "succeeded" || receipt.status === "compensated") !== (receipt.resultSha256 !== null)) {
    context.addIssue({ code: "custom", path: ["resultSha256"], message: "committed receipts require a result digest" });
  }
});

const FactDependencySchema = z.object({
  key: IdSchema,
  revision: PositiveRevisionSchema,
}).strict();

const WorkerSpawnedSchema = z.object({
  type: z.literal("worker.spawned"),
  workerId: IdSchema,
  goalId: IdSchema,
  purpose: TextSchema,
  capabilityEpoch: RevisionSchema,
  dependencies: z.array(FactDependencySchema).max(64),
  requiredForGoalCompletion: z.boolean().default(false),
}).strict().superRefine((worker, context) => {
  if (new Set(worker.dependencies.map(({ key }) => key)).size !== worker.dependencies.length) {
    context.addIssue({ code: "custom", path: ["dependencies"], message: "worker dependencies must be unique" });
  }
});

const WorkerDeliveryRecordedSchema = z.object({
  type: z.literal("worker.delivery_recorded"),
  deliveryId: IdSchema,
  workerId: IdSchema,
  goalId: IdSchema,
  capabilityEpoch: RevisionSchema,
  dependencyFactRevisions: z.array(FactDependencySchema).max(64),
  resultSha256: Sha256Schema,
}).strict().superRefine((delivery, context) => {
  if (new Set(delivery.dependencyFactRevisions.map(({ key }) => key)).size !== delivery.dependencyFactRevisions.length) {
    context.addIssue({ code: "custom", path: ["dependencyFactRevisions"], message: "delivery dependencies must be unique" });
  }
});

const WorkerCancelledSchema = z.object({
  type: z.literal("worker.cancelled"),
  workerId: IdSchema,
  reason: TextSchema,
}).strict();

const AudibilityResponseRegisteredSchema = z.object({
  type: z.literal("audibility.response_registered"),
  responseId: IdSchema,
  generatedThroughMs: PositiveRevisionSchema,
  contentSha256: Sha256Schema,
  evidenceSha256: Sha256Schema,
}).strict();

const AudibilityReleasedThroughSchema = z.object({
  type: z.literal("audibility.released_through"),
  responseId: IdSchema,
  throughMs: RevisionSchema,
  evidenceSha256: Sha256Schema,
}).strict();

const AudibilityHeardThroughSchema = z.object({
  type: z.literal("audibility.heard_through"),
  responseId: IdSchema,
  throughMs: RevisionSchema,
  evidenceSha256: Sha256Schema,
}).strict();

const AudibilityInterruptedSchema = z.object({
  type: z.literal("audibility.interrupted"),
  responseId: IdSchema,
  heardThroughMs: RevisionSchema,
  reason: TextSchema,
  evidenceSha256: Sha256Schema,
}).strict();

export const ConversationProgramEventPayloadSchema = z.discriminatedUnion("type", [
  FactAssertedSchema,
  FactCorrectedSchema,
  GoalOpenedSchema,
  GoalFocusedSchema,
  GoalSuspendedSchema,
  GoalCompletedSchema,
  FlowCheckpointRecordedSchema,
  ObligationOpenedSchema,
  ObligationSettledSchema,
  CapabilityEpochAdvancedSchema,
  ActionReservedSchema,
  ActionReceiptRecordedSchema,
  WorkerSpawnedSchema,
  WorkerDeliveryRecordedSchema,
  WorkerCancelledSchema,
  AudibilityResponseRegisteredSchema,
  AudibilityReleasedThroughSchema,
  AudibilityHeardThroughSchema,
  AudibilityInterruptedSchema,
]);

/** Authoring input; schema defaults are materialized before hashing and reduction. */
export type ConversationProgramEventPayload = z.input<typeof ConversationProgramEventPayloadSchema>;

export const ConversationProgramEventDraftSchema = z.object({
  eventId: IdSchema,
  expectedRevision: RevisionSchema,
  occurredAt: TimestampSchema,
  payload: ConversationProgramEventPayloadSchema,
}).strict();
export type ConversationProgramEventDraft = z.input<typeof ConversationProgramEventDraftSchema>;

export const ConversationProgramEventSchema = ConversationProgramEventDraftSchema.extend({
  schemaVersion: z.literal(CONVERSATION_PROGRAM_VERSION),
  programId: IdSchema,
  sequence: PositiveRevisionSchema,
  previousSha256: Sha256Schema,
  eventSha256: Sha256Schema,
}).strict();
export type ConversationProgramEvent = z.infer<typeof ConversationProgramEventSchema>;

export interface ConversationProgramLog {
  readonly schemaVersion: typeof CONVERSATION_PROGRAM_VERSION;
  readonly programId: string;
  readonly events: readonly ConversationProgramEvent[];
}

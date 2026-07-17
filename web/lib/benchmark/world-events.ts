import { z } from "zod";
import {
  ContentHashSchema,
  IdentifierSchema,
  JsonValueSchema,
  PrerequisiteEvidenceSchema,
  SafePathSchema,
  VisibleToolResultSchema,
  WorldEffectSchema,
  WorldAdmissionSchema,
  WorldReceiptSchema,
} from "./scenario-schema";

const EventBaseSchema = z.object({
  schema_version: z.literal(2),
  event_id: z.string().min(1),
  sequence: z.number().int().positive(),
  scenario_id: IdentifierSchema,
  scenario_version: z.string().min(1),
  scenario_hash: ContentHashSchema,
  turn: z.number().int().nonnegative(),
}).strict();

export const WorldInitializedEventSchema = EventBaseSchema.extend({
  type: z.literal("world.initialized"),
  initial_fact_count: z.number().int().nonnegative(),
});

export const ToolInvocationReceivedEventSchema = EventBaseSchema.extend({
  type: z.literal("tool.invocation_received"),
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  arguments: z.record(z.string(), JsonValueSchema),
  idempotency_key: z.string().min(1).optional(),
  semantic_opportunity_id: IdentifierSchema.optional(),
});

export const ToolArgumentsValidatedEventSchema = EventBaseSchema.extend({
  type: z.literal("tool.arguments_validated"),
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  valid: z.boolean(),
  issues: z.array(z.string()),
});

export const ToolPrerequisiteEvaluatedEventSchema = EventBaseSchema.extend({
  type: z.literal("tool.prerequisite_evaluated"),
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  evidence: PrerequisiteEvidenceSchema,
});

export const ToolDuplicateDetectedEventSchema = EventBaseSchema.extend({
  type: z.literal("tool.duplicate_detected"),
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  semantic_key: z.string().min(1),
  prior_receipt_id: z.string().min(1),
  policy: z.enum(["execute", "return_prior", "reject"]),
});

export const ToolInvocationReplayedEventSchema = EventBaseSchema.extend({
  type: z.literal("tool.invocation_replayed"),
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  original_receipt_id: z.string().min(1),
  original_turn: z.number().int().nonnegative(),
  replay_turn: z.number().int().nonnegative(),
});

export const ToolExecutionAdmittedEventSchema = EventBaseSchema.extend({
  type: z.literal("tool.execution_admitted"),
  admission: WorldAdmissionSchema,
});

export const ToolFaultInjectedEventSchema = EventBaseSchema.extend({
  type: z.literal("tool.fault_injected"),
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  semantic_key: z.string().min(1),
  fault_id: IdentifierSchema,
  phase: z.enum(["before_commit", "after_commit"]),
  error_code: IdentifierSchema,
  admission_id: z.string().min(1),
  semantic_ordinal: z.number().int().positive(),
  matching_ordinal: z.number().int().positive().optional(),
  semantic_opportunity_id: IdentifierSchema.optional(),
  schedule: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("fault_match_ordinal"), value: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal("semantic_opportunity"), value: IdentifierSchema }).strict(),
  ]),
});

export const WorldEffectCommittedEventSchema = EventBaseSchema.extend({
  type: z.literal("world.effect_committed"),
  effect: WorldEffectSchema,
});

export const ToolReceiptRecordedEventSchema = EventBaseSchema.extend({
  type: z.literal("tool.receipt_recorded"),
  receipt: WorldReceiptSchema,
});

export const ToolResultVisibleEventSchema = EventBaseSchema.extend({
  type: z.literal("tool.result_visible"),
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  result: VisibleToolResultSchema,
  tainted_paths: z.array(SafePathSchema),
});

export const WorldEventSchema = z.discriminatedUnion("type", [
  WorldInitializedEventSchema,
  ToolInvocationReceivedEventSchema,
  ToolArgumentsValidatedEventSchema,
  ToolPrerequisiteEvaluatedEventSchema,
  ToolDuplicateDetectedEventSchema,
  ToolInvocationReplayedEventSchema,
  ToolExecutionAdmittedEventSchema,
  ToolFaultInjectedEventSchema,
  WorldEffectCommittedEventSchema,
  ToolReceiptRecordedEventSchema,
  ToolResultVisibleEventSchema,
]);

export type WorldEvent = z.infer<typeof WorldEventSchema>;
export type WorldEventType = WorldEvent["type"];

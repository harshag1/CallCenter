import { z } from "zod";
import {
  IdentifierSchema,
  JsonValueSchema,
  PrerequisiteEvidenceSchema,
  SafePathSchema,
  VisibleToolResultSchema,
  WorldEffectSchema,
  WorldReceiptSchema,
} from "./scenario-schema";

const EventBaseSchema = z.object({
  schema_version: z.literal(1),
  event_id: z.string().min(1),
  sequence: z.number().int().positive(),
  scenario_id: IdentifierSchema,
  scenario_version: z.string().min(1),
  turn: z.number().int().nonnegative(),
});

export const WorldInitializedEventSchema = EventBaseSchema.extend({
  type: z.literal("world.initialized"),
  initial_fact_count: z.number().int().nonnegative(),
});

export const ToolInvocationReceivedEventSchema = EventBaseSchema.extend({
  type: z.literal("tool.invocation_received"),
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  arguments: z.record(z.string(), JsonValueSchema),
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
});

export const ToolFaultInjectedEventSchema = EventBaseSchema.extend({
  type: z.literal("tool.fault_injected"),
  invocation_id: IdentifierSchema,
  tool: IdentifierSchema,
  fault_id: IdentifierSchema,
  phase: z.enum(["before_commit", "after_commit"]),
  error_code: IdentifierSchema,
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
  ToolFaultInjectedEventSchema,
  WorldEffectCommittedEventSchema,
  ToolReceiptRecordedEventSchema,
  ToolResultVisibleEventSchema,
]);

export type WorldEvent = z.infer<typeof WorldEventSchema>;
export type WorldEventType = WorldEvent["type"];

import { z } from "zod";
import {
  AgentFlowSchema,
  validateAgentFlow,
  type AgentFlow,
  type FlowStep,
} from "./flow";
import {
  assertFlowToolCatalogClosure,
  baseBuiltInVoiceActionNames,
  consequentialBuiltInVoiceActionNames,
} from "./flow-tool-catalog";

const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_STEP_IDS = new Set(["persist_outcome"]);

export const OnboardingFlowStepSpecSchema = z.object({
  id: z.string().regex(PATH_SEGMENT),
  label: z.string().min(1).max(96),
  instructions: z.string().min(1).max(4_000),
}).strict();

export const OnboardingFlowTopicSpecSchema = z.object({
  id: z.string().regex(PATH_SEGMENT),
  label: z.string().min(1).max(96),
  icon: z.string().min(1).max(64).optional(),
  context: z.string().min(1).max(8_000),
  steps: z.array(OnboardingFlowStepSpecSchema).min(2).max(5),
}).strict().superRefine((topic, ctx) => {
  const ids = new Set<string>();
  for (const [index, step] of topic.steps.entries()) {
    if (ids.has(step.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["steps", index, "id"],
        message: `duplicate step id "${step.id}"`,
      });
    }
    if (RESERVED_STEP_IDS.has(step.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["steps", index, "id"],
        message: `step id "${step.id}" is reserved by the onboarding runtime`,
      });
    }
    ids.add(step.id);
  }
});

export const OnboardingFlowBlueprintSchema = z.object({
  topics: z.array(OnboardingFlowTopicSpecSchema).min(1).max(4),
}).strict().superRefine((blueprint, ctx) => {
  const ids = new Set<string>();
  for (const [index, topic] of blueprint.topics.entries()) {
    if (ids.has(topic.id) || topic.id === "incoming" || topic.id === "other") {
      ctx.addIssue({
        code: "custom",
        path: ["topics", index, "id"],
        message: `topic id "${topic.id}" is duplicate or reserved`,
      });
    }
    ids.add(topic.id);
  }
});

export type OnboardingFlowBlueprint = z.infer<typeof OnboardingFlowBlueprintSchema>;

function persistOutcomeStep(): FlowStep {
  return {
    id: "persist_outcome",
    label: "Record outcome",
    instructions:
      "Summarize the caller's goal, verified facts, outcome, and any promised follow-up in one concise note. " +
      "Call log_note exactly once. Complete this step only after the successful gateway receipt is available.",
    tools: ["log_note"],
    required_outputs: ["note_recorded"],
    output_bindings: [{
      output: "note_recorded",
      tool: "log_note",
      result_path: "ok",
      value_type: "boolean",
    }],
    action_policies: [{
      tool: "log_note",
      max_calls: 1,
      idempotency: "per_step",
      effect: "write",
    }],
    success_criteria: ["The durable log_note receipt confirms that the call outcome was recorded."],
    max_attempts: 2,
    checkpoint: true,
  };
}

function nestedSteps(
  source: OnboardingFlowBlueprint["topics"][number]["steps"]
): FlowStep[] {
  let child: FlowStep = persistOutcomeStep();
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const step = source[index]!;
    child = {
      id: step.id,
      label: step.label,
      instructions: step.instructions,
      ...(index === 0 ? { entry: true } : {}),
      success_criteria: [
        "The caller-facing result is explicit and based only on verified context or gateway receipts.",
      ],
      max_attempts: 2,
      checkpoint: true,
      steps: [child],
    };
  }
  return [child];
}

/**
 * Compiles the intentionally small onboarding blueprint into the exact durable
 * runtime shape. The model may propose copy and stages, but cannot author tool
 * authority, receipt bindings, or exposure mode.
 */
export function buildOnboardingFlow(
  input: unknown,
  supportNumber: string | null = null
): AgentFlow {
  const blueprint = OnboardingFlowBlueprintSchema.parse(input);
  const flow = AgentFlowSchema.parse({
    schema_version: 2,
    tool_exposure: "gateway",
    max_step_entries: 64,
    always_tools: ["contact_support", "end_call"],
    always_action_policies: [
      {
        tool: "contact_support",
        max_calls: 1,
        idempotency: "per_call",
        effect: "opaque",
      },
      {
        tool: "end_call",
        max_calls: 1,
        idempotency: "per_call",
        effect: "opaque",
      },
    ],
    nodes: [
      { id: "incoming", label: "Incoming call", kind: "incoming_call" },
      ...blueprint.topics.map((topic) => ({
        id: topic.id,
        label: topic.label,
        kind: "topic" as const,
        ...(topic.icon ? { icon: topic.icon } : {}),
        context: topic.context,
        steps: nestedSteps(topic.steps),
      })),
      {
        id: "other",
        label: "Human help",
        kind: "fallback" as const,
        icon: "phone-forwarded",
        context:
          "The request is outside the configured flow. Explain the limitation and offer a human handoff.",
        ...(supportNumber ? { support_number: supportNumber } : {}),
      },
    ],
    edges: [
      ...blueprint.topics.map((topic) => ({
        from: "incoming",
        to: topic.id,
        label: topic.label,
      })),
      { from: "incoming", to: "other", label: "Other" },
    ],
  });

  const errors = validateAgentFlow(flow).diagnostics.filter(
    (diagnostic) => diagnostic.level === "error"
  );
  if (errors.length) {
    throw new Error(
      `onboarding flow failed semantic validation: ${errors
        .slice(0, 5)
        .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
        .join("; ")}`
    );
  }
  assertFlowToolCatalogClosure(
    flow,
    baseBuiltInVoiceActionNames(),
    new Set(),
    consequentialBuiltInVoiceActionNames()
  );
  return flow;
}

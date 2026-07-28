import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  createFlowTool,
  FLOW_V2_AUTHORING_SCHEMA,
  updateFlowTool,
} from "../agent/tools/flows-tools";
import { ActionReconciliationSpecSchema } from "../action-reconciliation";
import { validateAgentFlow } from "../flow";

type SchemaObject = {
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  additionalProperties?: boolean;
};

function stepAtDepth(depth: number): Record<string, unknown> {
  const step: Record<string, unknown> = {
    id: `level_${depth}`,
    label: `Level ${depth}`,
    instructions: `Complete level ${depth}.`,
  };
  if (depth < 8) step.steps = [stepAtDepth(depth + 1)];
  return step;
}

function compileAuthoringSchema() {
  return new Ajv({ allErrors: true, strict: false }).compile(FLOW_V2_AUTHORING_SCHEMA);
}

describe("Flow v2 builder authoring contract", () => {
  it("publishes the same explicit, closed Flow v2 schema for create and update", () => {
    const createParameters = createFlowTool.parameters as SchemaObject;
    const updateParameters = updateFlowTool.parameters as SchemaObject;

    expect(createParameters.additionalProperties).toBe(false);
    expect(updateParameters.additionalProperties).toBe(false);
    expect(createParameters.properties?.flow).toBe(FLOW_V2_AUTHORING_SCHEMA);
    expect(updateParameters.properties?.flow).toBe(FLOW_V2_AUTHORING_SCHEMA);
  });

  it("accepts receipt bindings, host-bound arguments, enforced conditions, and eight nested levels", () => {
    const deepest = stepAtDepth(1);
    const root = deepest;
    let cursor = root;
    while (Array.isArray(cursor.steps)) cursor = cursor.steps[0] as Record<string, unknown>;
    const reconciliation = {
      queryTool: "lookup_case",
      queryArguments: {
        invocation_id: { source: "invocation_id" },
      },
      committedWhen: [
        { resultPath: "invocation_id", equals: { source: "invocation_id" } },
        { resultPath: "status", equals: { source: "literal", value: "committed" } },
      ],
      absentWhen: [
        { resultPath: "invocation_id", equals: { source: "invocation_id" } },
        { resultPath: "status", equals: { source: "literal", value: "absent" } },
      ],
      authoritativeResultPath: "case",
      maxProofAttempts: 3,
    };
    Object.assign(cursor, {
      tools: ["lookup_case", "close_case"],
      required_outputs: ["case_id", "closed"],
      output_bindings: [
        {
          output: "case_id",
          tool: "lookup_case",
          result_path: "case.id",
          value_type: "string",
        },
        {
          output: "closed",
          tool: "close_case",
          result_path: "closed",
          value_type: "boolean",
        },
      ],
      action_policies: [
        {
          tool: "lookup_case",
          max_calls: 2,
          idempotency: "per_arguments",
          effect: "read",
        },
        {
          tool: "close_case",
          max_calls: 1,
          idempotency: "per_call_arguments",
          effect: "write",
          reconciliation,
          bound_arguments: [{
            argument: "case_id",
            source: {
              kind: "receipt_result",
              tool: "lookup_case",
              result_path: "case.id",
            },
          }],
        },
      ],
      transitions: [{
        to: "case.confirm",
        label: "Closed",
        when: "the close receipt reports success",
        condition: {
          output: "closed",
          operator: "equals",
          value: true,
        },
      }],
      checkpoint: true,
      max_attempts: 2,
      on_failure: "case.escalate",
    });

    const validate = compileAuthoringSchema();
    const flow = {
      schema_version: 2,
      tool_exposure: "gateway",
      max_step_entries: 100,
      always_tools: ["contact_support", "end_call"],
      always_action_policies: [
        { tool: "contact_support", max_calls: 1, idempotency: "per_call" },
        { tool: "end_call", max_calls: 1, idempotency: "per_call" },
      ],
      nodes: [
        { id: "entry", label: "Incoming call", kind: "incoming_call" },
        {
          id: "case",
          label: "Case management",
          kind: "topic",
          context: "Manage an authenticated case.",
          steps: [
            root,
            { id: "confirm", label: "Confirm", instructions: "Confirm the durable result." },
            { id: "escalate", label: "Escalate", instructions: "Escalate without retrying the write." },
          ],
        },
      ],
      edges: [{ from: "entry", to: "case", label: "Case" }],
    };

    expect(validate(flow), JSON.stringify(validate.errors)).toBe(true);
    expect(ActionReconciliationSpecSchema.safeParse(reconciliation).success).toBe(true);
    expect(
      validateAgentFlow(flow).diagnostics.filter((diagnostic) => diagnostic.level === "error")
    ).toEqual([]);
  });

  it("rejects unsupported ninth-level nesting and global receipt-bound arguments", () => {
    const validate = compileAuthoringSchema();
    const ninthLevel = stepAtDepth(1);
    let cursor = ninthLevel;
    while (Array.isArray(cursor.steps)) cursor = cursor.steps[0] as Record<string, unknown>;
    cursor.steps = [{
      id: "level_9",
      label: "Level 9",
      instructions: "This exceeds the runtime limit.",
    }];

    const invalid = {
      schema_version: 2,
      always_tools: ["close_case"],
      always_action_policies: [{
        tool: "close_case",
        idempotency: "per_call",
        bound_arguments: [{
          argument: "case_id",
          source: { kind: "receipt_result", tool: "lookup_case", result_path: "case.id" },
        }],
      }],
      nodes: [
        { id: "entry", label: "Incoming call", kind: "incoming_call" },
        { id: "case", label: "Case", kind: "topic", steps: [ninthLevel] },
      ],
      edges: [{ from: "entry", to: "case" }],
    };

    expect(validate(invalid)).toBe(false);
    expect(validate.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        instancePath: expect.stringContaining("/always_action_policies/0"),
        keyword: "additionalProperties",
      }),
      expect.objectContaining({
        instancePath: expect.stringContaining("/steps/0/steps/0/steps/0/steps/0/steps/0/steps/0/steps/0/steps/0"),
        keyword: "additionalProperties",
      }),
    ]));
  });

  it("exposes entry routing only on top-level steps", () => {
    const validate = compileAuthoringSchema();
    const invalid = {
      schema_version: 2,
      nodes: [
        { id: "entry", label: "Incoming call", kind: "incoming_call" },
        {
          id: "case",
          label: "Case",
          kind: "topic",
          steps: [{
            id: "start",
            label: "Start",
            instructions: "Start.",
            entry: true,
            steps: [{
              id: "nested",
              label: "Nested",
              instructions: "Continue.",
              entry: true,
            }],
          }],
        },
      ],
      edges: [{ from: "entry", to: "case" }],
    };

    expect(validate(invalid)).toBe(false);
    expect(validate.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        instancePath: "/nodes/1/steps/0/steps/0",
        keyword: "additionalProperties",
        params: { additionalProperty: "entry" },
      }),
    ]));
  });
});

import { describe, expect, it } from "vitest";
import { AgentFlowSchema, actionPolicyFor } from "../flow";
import { hashFlowValue } from "../flow-runtime";
import {
  CallRuntimeSnapshotSchema,
  callRuntimeDigest,
} from "../call-runtime-snapshot";
import {
  reconciliationCatalogForReceipt,
  resolveReconciliationAuthority,
} from "../reconciliation-authority";

const actionInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { reservation_ref: { type: "string" } },
  required: ["reservation_ref"],
} as const;

const queryInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { invocation_id: { type: "string" } },
  required: ["invocation_id"],
} as const;

const authoritativeResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reservation_id: { type: "string" },
    status: { const: "committed" },
  },
  required: ["reservation_id", "status"],
} as const;

const queryOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    invocation_id: { type: "string" },
    terminal: { enum: ["committed", "absent", "pending"] },
    result: authoritativeResultSchema,
  },
  required: ["invocation_id", "terminal"],
} as const;

const reconciliation = {
  queryTool: "generated_lookup",
  queryArguments: {
    invocation_id: { source: "invocation_id" as const },
  },
  committedWhen: [
    { resultPath: "invocation_id", equals: { source: "invocation_id" as const } },
    { resultPath: "terminal", equals: { source: "literal" as const, value: "committed" } },
  ],
  absentWhen: [
    { resultPath: "invocation_id", equals: { source: "invocation_id" as const } },
    { resultPath: "terminal", equals: { source: "literal" as const, value: "absent" } },
  ],
  queryOutputSchema,
  authoritativeResultPath: "result",
  authoritativeResultSchema,
  maxProofAttempts: 3,
};

function flowWithPolicies(options: { queryEffect?: "read" | "write" | "opaque" } = {}) {
  const queryEffect = options.queryEffect === undefined ? "read" : options.queryEffect;
  return AgentFlowSchema.parse({
    schema_version: 2,
    tool_exposure: "gateway",
    always_tools: [],
    nodes: [
      { id: "entry", label: "Entry", kind: "incoming_call" },
      {
        id: "booking",
        label: "Booking",
        kind: "topic",
        steps: [{
          id: "commit",
          label: "Commit",
          instructions: "Commit exactly once, then use server-owned recovery if needed.",
          tools: ["generated_mutation", "generated_lookup"],
          action_policies: [
            {
              tool: "generated_mutation",
              max_calls: 1,
              idempotency: "per_arguments",
              effect: "write",
              reconciliation,
            },
            {
              tool: "generated_lookup",
              max_calls: 3,
              idempotency: "per_arguments",
              effect: queryEffect,
            },
          ],
        }],
      },
    ],
    edges: [{ from: "entry", to: "booking" }],
  });
}

const generatedDefinitions = [
  { name: "generated_mutation", inputSchema: actionInputSchema },
  { name: "generated_lookup", inputSchema: queryInputSchema },
] as const;

describe("source-agnostic reconciliation authority", () => {
  it("closes a generated mutation/read-back pair using only call-pinned Flow metadata", () => {
    const flow = flowWithPolicies();
    const resolved = resolveReconciliationAuthority(
      flow,
      "booking.commit",
      "generated_mutation",
      generatedDefinitions
    );

    expect(resolved).toMatchObject({
      action: {
        name: "generated_mutation",
        effect: "write",
        reconciliation: expect.objectContaining({ queryTool: "generated_lookup" }),
      },
      query: {
        name: "generated_lookup",
        effect: "read",
        outputSchema: queryOutputSchema,
      },
    });
    expect(resolved?.action.outputSchema).toBeUndefined();
    expect(actionPolicyFor(flow, "booking.commit", "generated_mutation"))
      .toMatchObject({ effect: "write", reconciliation });
  });

  it("admits that authority in a generated-tool runtime snapshot and binds every policy byte", () => {
    const flow = flowWithPolicies();
    const base = {
      v: 2 as const,
      agentVersion: 1,
      namedFlowId: null,
      flow,
      instructions: "Test immutable recovery authority.",
      codeRevision: "reconciliation-authority-test",
      toolManifest: [
        {
          id: "generated-action-id",
          slug: "generated_mutation",
          description: "Mutation.",
          inputSchema: actionInputSchema,
          endpointUrl: "https://tools.example.test/mutate",
          invocationKeyId: "tik_abcdefghijklmnop",
        },
        {
          id: "generated-query-id",
          slug: "generated_lookup",
          description: "Invocation-bound read-back.",
          inputSchema: queryInputSchema,
          endpointUrl: "https://tools.example.test/lookup",
          invocationKeyId: "tik_qrstuvwxyzABCDE",
        },
      ],
      extensionManifest: [],
      externalMcpManifest: [],
      environment: {
        internetEnabled: false,
        allowedDomains: [],
        docsReady: false,
        datasetSlugs: [],
        holdMusic: false,
      },
      createdAt: "2026-07-16T12:00:00.000Z",
    };
    const snapshot = CallRuntimeSnapshotSchema.parse(base);
    const changedFlow = structuredClone(flow);
    const policy = changedFlow.nodes[1].steps?.[0].action_policies?.[0];
    if (!policy?.reconciliation || typeof policy.reconciliation !== "object") {
      throw new Error("test recovery policy missing");
    }
    (policy.reconciliation as Record<string, unknown>).maxProofAttempts = 2;
    const changed = CallRuntimeSnapshotSchema.parse({ ...base, flow: changedFlow });

    expect(callRuntimeDigest(snapshot)).toMatch(/^[a-f0-9]{64}$/);
    expect(callRuntimeDigest(changed)).not.toBe(callRuntimeDigest(snapshot));
    expect(hashFlowValue(snapshot.flow)).not.toBe(hashFlowValue(changed.flow));
  });

  it("fails closed on effect/schema reclassification or an unclassified proof query", () => {
    const flow = flowWithPolicies();
    expect(() => reconciliationCatalogForReceipt(flow, "booking.commit", [
      { ...generatedDefinitions[0], effect: "read" },
      generatedDefinitions[1],
    ])).toThrow(/cannot reclassify/);

    expect(() => reconciliationCatalogForReceipt(flow, "booking.commit", [
      generatedDefinitions[0],
      {
        ...generatedDefinitions[1],
        outputSchema: { type: "string" },
      },
    ])).toThrow(/cannot replace the pinned output schema/);

    expect(() => resolveReconciliationAuthority(
      flow,
      "booking.commit",
      "generated_mutation",
      [
        { ...generatedDefinitions[0], outputSchema: { type: "string" } },
        generatedDefinitions[1],
      ]
    )).toThrow(/cannot replace the pinned authoritative output schema/);

    const unclassified = structuredClone(flow);
    unclassified.nodes[1].steps![0].action_policies =
      unclassified.nodes[1].steps![0].action_policies?.filter(
        (policy) => policy.tool !== "generated_lookup"
      );
    expect(() => resolveReconciliationAuthority(
      unclassified,
      "booking.commit",
      "generated_mutation",
      generatedDefinitions
    )).toThrow(/read-only/);

    expect(() => resolveReconciliationAuthority(
      flowWithPolicies({ queryEffect: "write" }),
      "booking.commit",
      "generated_mutation",
      generatedDefinitions
    )).toThrow(/read-only/);
  });

  it("rejects a runtime snapshot when Flow tries to replace a source action output schema", () => {
    const flow = flowWithPolicies();
    const parsed = CallRuntimeSnapshotSchema.safeParse({
      v: 2,
      agentVersion: 1,
      namedFlowId: null,
      flow,
      instructions: "Reject authority substitution.",
      codeRevision: "reconciliation-schema-substitution-test",
      toolManifest: [{
        id: "generated-query-id",
        slug: "generated_lookup",
        description: "Invocation-bound read-back.",
        inputSchema: queryInputSchema,
        endpointUrl: "https://tools.example.test/lookup",
        invocationKeyId: "tik_qrstuvwxyzABCDE",
      }],
      extensionManifest: [{
        name: "generated_mutation",
        description: "Source-owned mutation contract.",
        implementationDigest: "a".repeat(64),
        admissionScopeDigest: "b".repeat(64),
        inputSchema: actionInputSchema,
        outputSchema: { type: "string" },
        effect: "write",
      }],
      externalMcpManifest: [],
      environment: {
        internetEnabled: false,
        allowedDomains: [],
        docsReady: false,
        datasetSlugs: [],
        holdMusic: false,
      },
      createdAt: "2026-07-16T12:00:00.000Z",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message).join("\n"))
        .toMatch(/cannot replace the pinned authoritative output schema/);
    }
  });
});

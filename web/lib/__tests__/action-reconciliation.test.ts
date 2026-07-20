import { describe, expect, it } from "vitest";
import {
  ActionReconciliationSpecSchema,
  assertTrustedReconciliationCatalog,
  deriveReconciliation,
  evaluateReconciliationProof,
  reconciliationArgumentsMatchSchema,
} from "../action-reconciliation";
import type { FlowActionReceipt } from "../flow-runtime";

const invocationId = "abcdefghijklmnopqrstuvwx";
const scope = {
  callId: "call-1",
  organizationId: "org-1",
  agentId: "agent-1",
};

const actionOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reservation_id: { type: "string" },
    status: { const: "committed" },
  },
  required: ["reservation_id", "status"],
} as const;

const queryInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    invocation_id: { type: "string" },
    organization_id: { type: "string" },
    reservation_ref: { type: "string" },
  },
  required: ["invocation_id", "organization_id", "reservation_ref"],
} as const;

const queryOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    invocation_id: { type: "string" },
    terminal: { enum: ["committed", "absent", "pending"] },
    result: actionOutputSchema,
  },
  required: ["invocation_id", "terminal"],
} as const;

const reconciliation = ActionReconciliationSpecSchema.parse({
  queryTool: "lookup_reservation",
  queryArguments: {
    invocation_id: { source: "invocation_id" },
    organization_id: { source: "organization_id" },
    reservation_ref: { source: "action_argument", path: "reservation_ref" },
  },
  committedWhen: [
    { resultPath: "invocation_id", equals: { source: "invocation_id" } },
    { resultPath: "terminal", equals: { source: "literal", value: "committed" } },
  ],
  absentWhen: [
    { resultPath: "invocation_id", equals: { source: "invocation_id" } },
    { resultPath: "terminal", equals: { source: "literal", value: "absent" } },
  ],
  authoritativeResultPath: "result",
  maxProofAttempts: 3,
});

const receipt: FlowActionReceipt = {
  id: "receipt-1",
  idempotencyKey: "idem-1",
  step: "booking.commit",
  tool: "reserve_slot",
  capabilityEpoch: 2,
  arguments: { reservation_ref: "R-100" },
  argumentsHash: "a".repeat(64),
  invocationId,
  dispatchStartedAt: "2026-07-16T12:00:00.000Z",
  dispatchAttempt: 1,
  status: "indeterminate",
  reservedAt: "2026-07-16T11:59:59.000Z",
  settledAt: "2026-07-16T12:00:25.000Z",
};

describe("action reconciliation authority", () => {
  it("requires disjoint committed and absent terminal proofs for every recovery contract", () => {
    const committedOnly = structuredClone(reconciliation) as Record<string, unknown>;
    delete committedOnly.absentWhen;
    expect(ActionReconciliationSpecSchema.safeParse(committedOnly).success).toBe(false);

    expect(ActionReconciliationSpecSchema.safeParse({
      ...reconciliation,
      absentWhen: [
        { resultPath: "invocation_id", equals: { source: "invocation_id" } },
        { resultPath: "different_terminal", equals: { source: "literal", value: "absent" } },
      ],
    }).success).toBe(false);
  });

  it("accepts only a closed write-action/read-proof catalog with valid schemas", () => {
    expect(() => assertTrustedReconciliationCatalog([
      {
        name: "reserve_slot",
        inputSchema: {
          type: "object",
          properties: { reservation_ref: { type: "string" } },
          required: ["reservation_ref"],
        },
        outputSchema: actionOutputSchema,
        effect: "write",
        reconciliation,
      },
      {
        name: "lookup_reservation",
        inputSchema: queryInputSchema,
        outputSchema: queryOutputSchema,
        effect: "read",
      },
    ])).not.toThrow();

    expect(() => assertTrustedReconciliationCatalog([
      {
        name: "reserve_slot",
        inputSchema: { type: "object" },
        outputSchema: actionOutputSchema,
        effect: "write",
        reconciliation,
      },
      {
        name: "lookup_reservation",
        inputSchema: queryInputSchema,
        outputSchema: queryOutputSchema,
        effect: "write",
      },
    ])).toThrow(/read-only/);

    expect(() => assertTrustedReconciliationCatalog([
      {
        name: "reserve_slot",
        inputSchema: { type: "object" },
        outputSchema: { type: "string" },
        effect: "write",
        reconciliation: {
          ...reconciliation,
          authoritativeResultSchema: { type: "number" },
        },
      },
      {
        name: "lookup_reservation",
        inputSchema: queryInputSchema,
        outputSchema: queryOutputSchema,
        effect: "read",
      },
    ])).toThrow(/cannot replace the pinned authoritative output schema/);
  });

  it("derives every query argument from trusted scope, receipt identity, and original arguments", () => {
    const derived = deriveReconciliation(reconciliation, receipt, scope);
    expect(derived.queryArguments).toEqual({
      invocation_id: invocationId,
      organization_id: "org-1",
      reservation_ref: "R-100",
    });
    expect(derived.policyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(derived.predicateHash).toMatch(/^[a-f0-9]{64}$/);
    const changedAbsence = deriveReconciliation({
      ...reconciliation,
      absentWhen: reconciliation.absentWhen?.map((predicate, index) =>
        index === 1
          ? { ...predicate, equals: { source: "literal" as const, value: "missing" } }
          : predicate
      ),
    }, receipt, scope);
    expect(changedAbsence.predicateHash).not.toBe(derived.predicateHash);
    expect(reconciliationArgumentsMatchSchema(queryInputSchema, derived.queryArguments)).toBe(true);
  });

  it("promotes only an exact invocation-bound terminal proof with both schemas valid", () => {
    const proof = {
      invocation_id: invocationId,
      terminal: "committed",
      result: { reservation_id: "R-100", status: "committed" },
    };
    expect(evaluateReconciliationProof(
      reconciliation,
      receipt,
      scope,
      proof,
      queryOutputSchema,
      actionOutputSchema
    )).toMatchObject({
      outcome: "committed",
      committed: true,
      authoritativeResult: proof.result,
      proofResultHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      authoritativeResultHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    expect(evaluateReconciliationProof(
      reconciliation,
      receipt,
      scope,
      { ...proof, invocation_id: "zyxwvutsrqponmlkjihgfedc" },
      queryOutputSchema,
      actionOutputSchema
    )).toEqual({ outcome: "indeterminate", committed: false, reason: "pending_or_unknown" });

    expect(evaluateReconciliationProof(
      reconciliation,
      receipt,
      scope,
      { invocation_id: invocationId, terminal: "absent" },
      queryOutputSchema,
      actionOutputSchema
    )).toMatchObject({
      outcome: "absent",
      committed: false,
      authoritativeAbsent: true,
      proofResultHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    expect(evaluateReconciliationProof(
      reconciliation,
      receipt,
      scope,
      { invocation_id: invocationId, terminal: "pending" },
      queryOutputSchema,
      actionOutputSchema
    )).toEqual({ outcome: "indeterminate", committed: false, reason: "pending_or_unknown" });

    expect(evaluateReconciliationProof(
      reconciliation,
      receipt,
      scope,
      { invocation_id: "zyxwvutsrqponmlkjihgfedc", terminal: "absent" },
      queryOutputSchema,
      actionOutputSchema
    )).toEqual({ outcome: "indeterminate", committed: false, reason: "pending_or_unknown" });
  });

  it("rejects output that bypasses either the proof schema or original action schema", () => {
    const wrongProofShape = {
      invocation_id: invocationId,
      terminal: "committed",
      result: { reservation_id: "R-100", status: "committed" },
      attacker_controlled: true,
    };
    expect(evaluateReconciliationProof(
      reconciliation,
      receipt,
      scope,
      wrongProofShape,
      queryOutputSchema,
      actionOutputSchema
    )).toEqual({ outcome: "indeterminate", committed: false, reason: "invalid_proof" });

    const invalidActionResult = {
      invocation_id: invocationId,
      terminal: "committed",
      result: { reservation_id: 100, status: "committed" },
    };
    const permissiveQuerySchema = {
      type: "object",
      properties: {
        invocation_id: { type: "string" },
        terminal: { type: "string" },
        result: { type: "object" },
      },
      required: ["invocation_id", "terminal", "result"],
    };
    expect(evaluateReconciliationProof(
      reconciliation,
      receipt,
      scope,
      invalidActionResult,
      permissiveQuerySchema,
      actionOutputSchema
    )).toEqual({ outcome: "indeterminate", committed: false, reason: "result_schema_mismatch" });

    const policyTriesToWidenSourceSchema = {
      ...reconciliation,
      authoritativeResultSchema: { type: "number" },
    };
    expect(evaluateReconciliationProof(
      policyTriesToWidenSourceSchema,
      receipt,
      scope,
      {
        invocation_id: invocationId,
        terminal: "committed",
        result: 7,
      },
      {
        type: "object",
        properties: {
          invocation_id: { type: "string" },
          terminal: { const: "committed" },
          result: {},
        },
        required: ["invocation_id", "terminal", "result"],
      },
      { type: "string" }
    )).toEqual({ outcome: "indeterminate", committed: false, reason: "result_schema_mismatch" });
  });

  it("rejects ambiguous policies with duplicate predicates or object-valued terminal literals", () => {
    const base = {
      queryTool: "lookup_reservation",
      queryArguments: { invocation_id: { source: "invocation_id" as const } },
      authoritativeResultPath: "result",
    };
    expect(ActionReconciliationSpecSchema.safeParse({
      ...base,
      committedWhen: [
        { resultPath: "status", equals: { source: "invocation_id" } },
        { resultPath: "status", equals: { source: "literal", value: "committed" } },
      ],
    }).success).toBe(false);
    expect(ActionReconciliationSpecSchema.safeParse({
      ...base,
      committedWhen: [
        { resultPath: "invocation_id", equals: { source: "invocation_id" } },
        { resultPath: "status", equals: { source: "literal", value: { committed: true } } },
      ],
    }).success).toBe(false);
    expect(ActionReconciliationSpecSchema.safeParse({
      ...base,
      committedWhen: [
        { resultPath: "invocation_id", equals: { source: "invocation_id" } },
        { resultPath: "status", equals: { source: "literal", value: "committed" } },
      ],
      absentWhen: [
        { resultPath: "invocation_id", equals: { source: "invocation_id" } },
        { resultPath: "status", equals: { source: "literal", value: "committed" } },
      ],
    }).success).toBe(false);
  });

  it("admits Flow fallback schemas through the same bounded portable-schema boundary", () => {
    const base = {
      queryTool: "lookup_reservation",
      queryArguments: { invocation_id: { source: "invocation_id" as const } },
      committedWhen: [
        { resultPath: "invocation_id", equals: { source: "invocation_id" as const } },
        { resultPath: "terminal", equals: { source: "literal" as const, value: "committed" } },
      ],
      absentWhen: [
        { resultPath: "invocation_id", equals: { source: "invocation_id" as const } },
        { resultPath: "terminal", equals: { source: "literal" as const, value: "absent" } },
      ],
      authoritativeResultPath: "result",
    };
    const forbidden = [
      { type: "object", properties: { value: { type: "string", pattern: "(a+)+$" } } },
      { type: "object", properties: { value: { $ref: "https://tenant.invalid/schema" } } },
      { type: "object", $defs: { recursive: { type: "object" } } },
      { type: "object", patternProperties: { ".*": { type: "string" } } },
    ];
    for (const queryOutputSchema of forbidden) {
      expect(ActionReconciliationSpecSchema.safeParse({
        ...base,
        queryOutputSchema,
      }).success).toBe(false);
    }

    let tooDeep: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < 20; index += 1) {
      tooDeep = { type: "object", properties: { next: tooDeep } };
    }
    expect(ActionReconciliationSpecSchema.safeParse({
      ...base,
      queryOutputSchema: tooDeep,
    }).success).toBe(false);
    expect(ActionReconciliationSpecSchema.safeParse({
      ...base,
      queryOutputSchema: {
        type: "object",
        oneOf: Array.from({ length: 17 }, () => ({ type: "object" })),
      },
    }).success).toBe(false);

    const mutable = {
      type: "object",
      additionalProperties: false,
      properties: { invocation_id: { type: "string" } },
      required: ["invocation_id"],
    };
    const admitted = ActionReconciliationSpecSchema.parse({
      ...base,
      queryOutputSchema: mutable,
      authoritativeResultSchema: { type: "string" },
    });
    mutable.required[0] = "attacker_changed";
    expect(admitted.queryOutputSchema).toEqual({
      additionalProperties: false,
      properties: { invocation_id: { type: "string" } },
      required: ["invocation_id"],
      type: "object",
    });
    expect(Object.isFrozen(admitted.queryOutputSchema)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { AgentFlowSchema } from "../flow";
import { runFlowScenario, testFlowScenario } from "../agent/tools/flow-testing";

const managedVoiceFlow = AgentFlowSchema.parse({
  schema_version: 2,
  always_tools: [],
  nodes: [
    { id: "entry", label: "Incoming call", kind: "incoming_call" },
    {
      id: "membership",
      label: "Membership",
      kind: "topic",
      steps: [
        {
          id: "lookup",
          label: "Load membership",
          instructions: "Load the authoritative membership record.",
          entry: true,
          tools: ["membership.lookup"],
          required_outputs: ["member_id"],
          output_bindings: [{
            output: "member_id",
            tool: "membership.lookup",
            result_path: "$.member.id",
            value_type: "string",
          }],
          action_policies: [{
            tool: "membership.lookup",
            max_calls: 1,
            idempotency: "per_step",
            effect: "read",
          }],
          transitions: [{ to: "membership.research" }],
        },
        {
          id: "research",
          label: "Research options",
          instructions: "Wait for a receipt-backed worker result.",
          tools: ["worker.research"],
          required_outputs: ["recommendation"],
          output_bindings: [{
            output: "recommendation",
            tool: "worker.research",
            result_path: "$.summary",
            value_type: "string",
          }],
          action_policies: [{
            tool: "worker.research",
            max_calls: 1,
            idempotency: "per_step",
            effect: "read",
          }],
          transitions: [{ to: "membership.renew" }],
        },
        {
          id: "renew",
          label: "Renew membership",
          instructions: "Renew exactly once and use read-back proof after ambiguity.",
          tools: ["membership.renew"],
          required_outputs: ["renewal_id"],
          output_bindings: [{
            output: "renewal_id",
            tool: "membership.renew",
            result_path: "$.renewal.id",
            value_type: "string",
          }],
          action_policies: [{
            tool: "membership.renew",
            max_calls: 1,
            idempotency: "per_call_arguments",
            effect: "write",
            reconciliation: { kind: "read_after_write" },
          }],
          checkpoint: true,
        },
      ],
    },
  ],
  edges: [{ from: "entry", to: "membership" }],
});

describe("Flow v2 scenario simulator", () => {
  it("proves a long management path across receipts, workers, timeout recovery, and reconciliation", () => {
    const result = runFlowScenario(managedVoiceFlow, {
      topic: "membership",
      started_at: "2026-07-28T16:00:00.000Z",
      events: [
        { type: "enter_step", path: "membership.lookup" },
        {
          type: "action",
          receipt_id: "lookup-1",
          tool: "membership.lookup",
          arguments: { phone: "+15555550123" },
          outcome: "succeeded",
          result: { member: { id: "member-7" } },
        },
        { type: "complete_step", outputs: {} },
        { type: "enter_step", path: "membership.research" },
        {
          type: "worker_completion",
          worker_id: "worker-42",
          receipt_id: "worker-result-1",
          tool: "worker.research",
          result: { summary: "Annual plan is the lowest total cost." },
        },
        { type: "complete_step", outputs: {} },
        { type: "enter_step", path: "membership.renew" },
        {
          type: "action",
          receipt_id: "renew-1",
          tool: "membership.renew",
          arguments: { member_id: "member-7", plan: "annual" },
          outcome: "reserved",
          dispatch_started: true,
        },
        { type: "interrupt", reason: "timeout" },
        {
          type: "action",
          receipt_id: "renew-1",
          tool: "membership.renew",
          arguments: { member_id: "member-7", plan: "annual" },
          outcome: "succeeded",
          result: { renewal: { id: "must-not-overwrite" } },
        },
        {
          type: "reconcile_action",
          receipt_id: "renew-1",
          proof_id: "renewal-readback-1",
          resolution: "committed",
          result: { renewal: { id: "renewal-9" } },
        },
        { type: "complete_step", outputs: {} },
      ],
      expect: {
        status: "completed",
        topic: "membership",
        current_step: null,
        completed_steps: [
          "membership.lookup",
          "membership.research",
          "membership.renew",
        ],
        next_steps: [],
        outputs: {
          "membership.lookup": { member_id: "member-7" },
          "membership.research": {
            recommendation: "Annual plan is the lowest total cost.",
          },
          "membership.renew": { renewal_id: "renewal-9" },
        },
        checkpoints: ["membership.renew"],
        receipt_statuses: {
          "lookup-1": {
            status: "succeeded",
            tool: "membership.lookup",
            step: "membership.lookup",
          },
          "worker-result-1": {
            status: "succeeded",
            tool: "worker.research",
            step: "membership.research",
          },
          "renew-1": {
            status: "succeeded",
            tool: "membership.renew",
            step: "membership.renew",
            reconciliation_proof_id: "renewal-readback-1",
          },
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      assertions: { passed: true },
      final: {
        status: "completed",
        outputs: {
          "membership.lookup": { member_id: "member-7" },
          "membership.research": {
            recommendation: "Annual plan is the lowest total cost.",
          },
          "membership.renew": { renewal_id: "renewal-9" },
        },
      },
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.trace[4]).toMatchObject({
      type: "worker_completion",
      receipt_backed: true,
      worker_id: "worker-42",
    });
    expect(result.trace[8]).toMatchObject({
      type: "interrupt",
      recovered_receipt_ids: ["renew-1"],
      state: { receipts: { "renew-1": { status: "indeterminate" } } },
    });
    expect(result.trace[9]).toMatchObject({
      type: "action",
      execute: false,
      status: "indeterminate",
    });
  });

  it("can prove authoritative absence and then finish without relabeling the action as success", () => {
    const simpleFlow = structuredClone(managedVoiceFlow);
    const membership = simpleFlow.nodes.find(({ id }) => id === "membership");
    if (!membership) throw new Error("membership topic missing");
    membership.steps = [{
      id: "audit",
      label: "Audit",
      instructions: "Attempt and reconcile an audit write.",
      entry: true,
      tools: ["audit.write"],
      action_policies: [{
        tool: "audit.write",
        idempotency: "per_call_arguments",
        effect: "write",
      }],
    }];

    const result = runFlowScenario(simpleFlow, {
      topic: "membership",
      events: [
        { type: "enter_step", path: "membership.audit" },
        {
          type: "action",
          receipt_id: "audit-1",
          tool: "audit.write",
          arguments: { note: "caller requested cancellation" },
          outcome: "indeterminate",
          error: "provider timed out after dispatch",
        },
        {
          type: "reconcile_action",
          receipt_id: "audit-1",
          proof_id: "audit-absence-1",
          resolution: "absent",
        },
        { type: "complete_step", outputs: {} },
      ],
      expect: {
        status: "completed",
        receipt_statuses: {
          "audit-1": {
            status: "failed",
            reconciliation_proof_id: "audit-absence-1",
          },
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      assertions: { passed: true },
      final: {
        status: "completed",
        action_receipts: [{ id: "audit-1", status: "failed" }],
      },
    });
  });

  it("fails closed with field-level evidence when a terminal assertion is wrong", () => {
    const result = runFlowScenario(managedVoiceFlow, {
      topic: "membership",
      events: [{ type: "enter_step", path: "membership.lookup" }],
      expect: {
        status: "completed",
        current_step: null,
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      stage: "assertion",
      failures: expect.arrayContaining([
        { path: "status", expected: "completed", actual: "active" },
        {
          path: "current_step",
          expected: null,
          actual: "membership.lookup",
        },
      ]),
    }));
  });

  it("keeps the simple steps shorthand and operator-tool wrapper backward compatible", async () => {
    const result = await testFlowScenario.execute(
      {
        flow: {
          schema_version: 2,
          always_tools: [],
          nodes: [
            { id: "entry", label: "Incoming", kind: "incoming_call" },
            {
              id: "help",
              label: "Help",
              kind: "topic",
              steps: [{
                id: "answer",
                label: "Answer",
                instructions: "Answer the question.",
                entry: true,
              }],
            },
          ],
          edges: [{ from: "entry", to: "help" }],
        },
        topic: "help",
        steps: [{ path: "help.answer", outputs: {} }],
      },
      {
        orgId: "org-test",
        email: "builder@example.test",
        agentId: null,
        origin: "http://localhost",
      }
    );

    expect(result.output).toMatchObject({
      ok: true,
      trace: [{ path: "help.answer", outputs: {} }],
      final: { status: "completed" },
    });
  });
});

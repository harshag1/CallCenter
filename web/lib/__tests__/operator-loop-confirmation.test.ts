import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chatStream: vi.fn(),
  operatorPrompt: vi.fn(() => "system prompt"),
  operatorToolCatalog: vi.fn(),
  q: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../xai", () => ({ chatStream: mocks.chatStream }));
vi.mock("../agent/prompt", () => ({ operatorPrompt: mocks.operatorPrompt }));
vi.mock("../agent/tools", () => ({ operatorToolCatalog: mocks.operatorToolCatalog }));
vi.mock("../db", () => ({ q: mocks.q }));
vi.mock("../log", () => ({
  log: () => ({ warn: mocks.warn, error: mocks.error }),
}));

import { runOperator, type LoopEvent } from "../agent/loop";
import {
  operatorActionArgumentsSha256,
  type OperatorActionProposal,
} from "../agent/tools/operator-capability-policy";
import type { OperatorTool } from "../agent/types";
import type { Session } from "../auth";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const THREAD_ID = "00000000-0000-4000-8000-000000000002";
const PROPOSAL_ID = "00000000-0000-4000-8000-000000000003";

const session = Object.freeze({
  email: "operator@example.test",
  orgId: ORG_ID,
  orgDomain: null,
  phoneNumber: null,
  phoneVerifiedAt: null,
}) as Session;

const proposal: OperatorActionProposal = Object.freeze({
  schemaVersion: 1,
  proposalId: PROPOSAL_ID,
  capability: "send_email",
  arguments: Object.freeze({
    brand: "Membership Club",
    message: "Your renewal is ready.",
    subject: "Renewal",
    to: "member@example.test",
  }),
  argumentsSha256: operatorActionArgumentsSha256("send_email", {
    brand: "Membership Club",
    message: "Your renewal is ready.",
    subject: "Renewal",
    to: "member@example.test",
  }),
  estimatedUnits: 1,
  worstCaseMicroUsd: 1_000,
  expiresAt: "2026-07-16T21:00:00.000Z",
});

async function* stream(events: readonly unknown[]) {
  for (const event of events) yield event;
}

async function collect(generator: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

function catalog(tools: readonly OperatorTool[]) {
  return {
    tools: tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })),
    byName: new Map(tools.map((tool) => [tool.name, tool])),
  };
}

describe("operator loop human-confirmation boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.q.mockImplementation(async (sql: string) => sql.startsWith("SELECT role, content") ? [] : []);
  });

  it("emits a token-free browser proposal and stops without a second model sample", async () => {
    const sendEmail = {
      name: "send_email",
      description: "Propose email",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => ({
        output: {
          status: "human_confirmation_required",
          proposal_id: PROPOSAL_ID,
          confirmation_token: "server-only-confirmation-token",
          private_display: { targets: ["+14155550123"] },
        },
        operatorActionConfirmation: {
          ...proposal,
          confirmation_token: "server-only-confirmation-token",
          private_display: { targets: ["+14155550123"] },
        } as never,
        notice: "server-only-confirmation-token",
        surface: { secret: "server-only-confirmation-token" },
        flow: { private_display: { targets: ["+14155550123"] } },
        navigate: { tab: "server-only-confirmation-token" },
      } as never)),
    } satisfies OperatorTool;
    mocks.operatorToolCatalog.mockResolvedValue(catalog([sendEmail]));
    mocks.chatStream.mockImplementation(() => stream([
      { type: "text", delta: "Sent — your member will receive it now." },
      {
        type: "tool_calls",
        calls: [{
          id: "call-proposal",
          name: "send_email",
          arguments: JSON.stringify({
            to: "member@example.test",
            subject: "Renewal",
            message: "Your renewal is ready.",
          }),
        }],
      },
    ]));

    const events = await collect(runOperator(
      session,
      THREAD_ID,
      "Email the renewal notice",
      null,
      "https://operator.example.test",
    ));

    expect(sendEmail.execute).toHaveBeenCalledOnce();
    expect(mocks.chatStream).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ type: "operator_action_confirmation", proposal });
    expect(events.some((event) => event.type === "text")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("Sent —");
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(JSON.stringify(events)).not.toMatch(/confirmation_token|idempotency_key|execution_id/i);
    expect(JSON.stringify(events)).not.toContain("server-only-confirmation-token");
    expect(JSON.stringify(events)).not.toContain("+14155550123");

    const persistedToolReceipt = mocks.q.mock.calls.find(([, params]) =>
      Array.isArray(params) && params[2] === "tool"
    );
    expect(persistedToolReceipt).toBeDefined();
    expect(String(persistedToolReceipt![1][3])).toContain("human_confirmation_required");
    expect(String(persistedToolReceipt![1][3])).not.toContain("member@example.test");
    expect(String(persistedToolReceipt![1][3])).not.toContain("argumentsSha256");
    expect(String(persistedToolReceipt![1][3])).not.toContain("server-only-confirmation-token");
    expect(String(persistedToolReceipt![1][3])).not.toContain("+14155550123");
    const persistedAssistant = mocks.q.mock.calls.find(([, params]) =>
      Array.isArray(params) && params[2] === "assistant"
    );
    expect(JSON.parse(String(persistedAssistant![1][3]))).toMatchObject({ content: null });
    const recoveryCall = mocks.q.mock.calls.find(([sql]) => String(sql).includes("operator_action_executions"));
    const recoverySql = String(recoveryCall?.[0]);
    expect(recoverySql).toContain("operator_action_executions");
    expect(recoverySql).toContain("ON CONFLICT (operator_execution_id)");
    expect(recoverySql).toContain("hacc_model_safe_operator_receipt(oe.public_receipt)");
    expect(recoveryCall?.[1]).toEqual([ORG_ID, THREAD_ID]);
    const cleanupSql = String(mocks.q.mock.calls.find(([sql]) =>
      String(sql).includes("operator private display") || String(sql).includes("WITH expired AS")
    )?.[0]);
    expect(cleanupSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(cleanupSql).not.toContain("SELECT private_display");
  });

  it("executes nothing when a funded proposal is mixed with any other tool call", async () => {
    const fundedExecute = vi.fn(async () => ({ output: { must_not_run: true } }));
    const safeExecute = vi.fn(async () => ({ output: { must_not_run: true } }));
    const tools = [
      {
        name: "send_sms",
        description: "Propose SMS",
        parameters: { type: "object", properties: {} },
        execute: fundedExecute,
      },
      {
        name: "query_data",
        description: "Read data",
        parameters: { type: "object", properties: {} },
        execute: safeExecute,
      },
    ] satisfies OperatorTool[];
    mocks.operatorToolCatalog.mockResolvedValue(catalog(tools));
    mocks.chatStream.mockImplementation(() => stream([{
      type: "tool_calls",
      calls: [
        { id: "funded", name: "send_sms", arguments: "{}" },
        { id: "safe", name: "query_data", arguments: "{}" },
      ],
    }]));

    const events = await collect(runOperator(
      session,
      THREAD_ID,
      "Send and query in one batch",
      null,
      "https://operator.example.test",
    ));

    expect(fundedExecute).not.toHaveBeenCalled();
    expect(safeExecute).not.toHaveBeenCalled();
    expect(mocks.chatStream).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === "tool" && event.status === "error"))
      .toHaveLength(2);
    expect(events).toContainEqual({
      type: "notice",
      text: "A paid or external action must be reviewed by itself before anything runs.",
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("accepts primitive extension-tool output without misreporting a post-execution crash", async () => {
    const extensionExecute = vi.fn(async () => ({ output: "extension completed" }));
    mocks.operatorToolCatalog.mockResolvedValue(catalog([{
      name: "custom_read",
      description: "Read from a custom integration",
      parameters: { type: "object", properties: {} },
      execute: extensionExecute,
    }]));
    mocks.chatStream
      .mockImplementationOnce(() => stream([
        { type: "text", delta: "Checking the integration…" },
        {
          type: "tool_calls",
          calls: [{ id: "custom-call", name: "custom_read", arguments: "{}" }],
        },
      ]))
      .mockImplementationOnce(() => stream([{ type: "text", delta: "Finished." }]));

    const events = await collect(runOperator(
      session,
      THREAD_ID,
      "Run the extension",
      null,
      "https://operator.example.test",
    ));

    expect(extensionExecute).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ type: "text", delta: "Checking the integration…" });
    expect(events).toContainEqual({ type: "tool", name: "custom_read", status: "done" });
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.chatStream).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("stops when a funded tool reports success without a valid confirmation proposal", async () => {
    const fundedExecute = vi.fn(async () => ({
      output: {
        ok: true,
        provider_id: "must-not-enter-model-history",
      },
    }));
    mocks.operatorToolCatalog.mockResolvedValue(catalog([{
      name: "send_sms",
      description: "Propose SMS",
      parameters: { type: "object", properties: {} },
      execute: fundedExecute,
    }]));
    mocks.chatStream.mockImplementation(() => stream([{
      type: "tool_calls",
      calls: [{ id: "funded-without-card", name: "send_sms", arguments: "{}" }],
    }]));

    const events = await collect(runOperator(
      session,
      THREAD_ID,
      "Send it",
      null,
      "https://operator.example.test",
    ));

    expect(fundedExecute).toHaveBeenCalledOnce();
    expect(mocks.chatStream).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ type: "tool", name: "send_sms", status: "error" });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(JSON.stringify(events)).not.toContain("must-not-enter-model-history");
    const persistedToolReceipt = mocks.q.mock.calls.find(([, params]) =>
      Array.isArray(params) && params[2] === "tool"
    );
    expect(String(persistedToolReceipt![1][3])).toContain("funded_action_confirmation_required");
    expect(String(persistedToolReceipt![1][3])).not.toContain("must-not-enter-model-history");
  });
});

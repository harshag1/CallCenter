import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildVoiceRuntimeSnapshotForAdmission: vi.fn(),
  campaignAuthorizationArguments: vi.fn(),
  executeConfirmedOperatorAction: vi.fn(),
  kickCampaign: vi.fn(),
  launchCampaign: vi.fn(),
  operatorActionArgumentsSha256: vi.fn(),
  originateCall: vi.fn(),
  parseCallRuntimeSnapshot: vi.fn(),
  purchaseNumber: vi.fn(),
  q: vi.fn(),
  qOne: vi.fn(),
  dispatchOperatorEmail: vi.fn(),
  dispatchOperatorSms: vi.fn(),
  sendAgentEmail: vi.fn(),
  sendSms: vi.fn(),
  trace: [] as string[],
}));

vi.mock("../db", () => ({ q: mocks.q, qOne: mocks.qOne }));
vi.mock("../email", () => ({ sendAgentEmail: mocks.sendAgentEmail }));
vi.mock("../sms", () => ({ sendSms: mocks.sendSms }));
vi.mock("../communications", () => ({
  operatorCommunicationDispatch: {
    email: mocks.dispatchOperatorEmail,
    sms: mocks.dispatchOperatorSms,
  },
}));
vi.mock("../telephony", () => ({
  originateCall: mocks.originateCall,
  purchaseNumber: mocks.purchaseNumber,
}));
vi.mock("../campaigns", () => ({
  campaignAuthorizationArguments: mocks.campaignAuthorizationArguments,
  kickCampaign: mocks.kickCampaign,
  launchCampaign: mocks.launchCampaign,
}));
vi.mock("../voice", () => ({
  buildVoiceRuntimeSnapshotForAdmission: mocks.buildVoiceRuntimeSnapshotForAdmission,
}));
vi.mock("../call-runtime-snapshot", () => ({
  parseCallRuntimeSnapshot: mocks.parseCallRuntimeSnapshot,
}));
vi.mock("../agent/tools/operator-capability-policy", () => ({
  executeConfirmedOperatorAction: mocks.executeConfirmedOperatorAction,
  operatorActionArgumentsSha256: mocks.operatorActionArgumentsSha256,
}));

import { dispatchApprovedOperatorAction } from "../agent/operator-action-dispatch";
import {
  createEmailCostQuote,
  createNumberMonthlyCostQuote,
  createSmsCostQuote,
  createVoiceCampaignCostQuote,
  createVoiceCostQuote,
} from "../operator-pricing";
import type {
  ApprovedOperatorAction,
  FundedOperatorCapability,
} from "../agent/tools/operator-capability-policy";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const THREAD_ID = "00000000-0000-4000-8000-000000000002";
const AGENT_ID = "00000000-0000-4000-8000-000000000003";
const ADMISSION_SCOPE_ID = "00000000-0000-4000-8000-000000000004";
const APPROVAL_ID = "00000000-0000-4000-8000-000000000005";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000006";
const PARENT_CALL_ID = "00000000-0000-4000-8000-000000000007";
const CALL_ID = "00000000-0000-4000-8000-000000000008";
const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000009";
const RUNTIME_DIGEST = "b".repeat(64);
const ARGUMENTS_SHA256 = "a".repeat(64);
const ACCEPTED_DELIVERY = Object.freeze({
  status: "accepted" as const,
  evidence_source: "provider_create_response" as const,
  verified_terminal: false as const,
  provider_message_id: `CA${"b".repeat(32)}`,
  account_binding_sha256: "c".repeat(64),
  recipient_binding_sha256: "d".repeat(64),
});
const RUNTIME_SNAPSHOT = Object.freeze({
  schema_version: 1,
  agent_id: AGENT_ID,
  instructions: "Stay on the approved flow.",
});

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function compactSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function approved(
  capability: FundedOperatorCapability,
  argumentsValue: Record<string, Json>,
  estimates: Readonly<{ units?: number; microUsd?: number }> = {}
): ApprovedOperatorAction {
  const embeddedQuote = argumentsValue.cost_quote as { units?: unknown; reservationMicroUsd?: unknown } | undefined;
  const quotedUnits = Number.isSafeInteger(embeddedQuote?.units) ? Number(embeddedQuote?.units) : 1;
  const quotedReservation = Number.isSafeInteger(embeddedQuote?.reservationMicroUsd)
    ? Number(embeddedQuote?.reservationMicroUsd)
    : 0;
  return Object.freeze({
    approvalId: APPROVAL_ID,
    ctx: Object.freeze({
      orgId: ORG_ID,
      email: "operator@example.test",
      agentId: AGENT_ID,
      origin: "https://operator.example.test",
      threadId: THREAD_ID,
    }),
    capability,
    argumentsValue,
    confirmationToken: "server-only-confirmation-token",
    idempotencyKey: APPROVAL_ID,
    estimatedUnits: estimates.units ?? quotedUnits,
    estimatedMicroUsd: estimates.microUsd ?? quotedReservation,
  });
}

function callArguments(overrides: Record<string, Json> = {}): Record<string, Json> {
  const costQuote = createVoiceCostQuote({
    originE164: "+14155550000",
    destinationE164: "+14155550123",
    maxDurationSeconds: 900,
  });
  return {
    agent_id: AGENT_ID,
    agent_version: 7,
    cost_quote: costQuote as unknown as Json,
    from_number: "+14155550000",
    max_duration_seconds: 900,
    reason: "Membership renewal",
    runtime_admission_scope_id: ADMISSION_SCOPE_ID,
    runtime_digest: RUNTIME_DIGEST,
    to_number: "+14155550123",
    ...overrides,
  };
}

function scheduleArguments(overrides: Record<string, Json> = {}): Record<string, Json> {
  return {
    ...callArguments(),
    parent_call_id: null,
    run_at: "2026-07-17T18:30:00.000Z",
    ...overrides,
  };
}

function expectNoProviderCalls(): void {
  expect(mocks.dispatchOperatorEmail).not.toHaveBeenCalled();
  expect(mocks.dispatchOperatorSms).not.toHaveBeenCalled();
  expect(mocks.sendAgentEmail).not.toHaveBeenCalled();
  expect(mocks.sendSms).not.toHaveBeenCalled();
  expect(mocks.originateCall).not.toHaveBeenCalled();
  expect(mocks.purchaseNumber).not.toHaveBeenCalled();
  expect(mocks.launchCampaign).not.toHaveBeenCalled();
  expect(mocks.kickCampaign).not.toHaveBeenCalled();
}

describe("approved operator action dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trace.length = 0;
    vi.stubEnv("HACC_OPERATOR_EMAIL_SEND_CEILING_USD", "0.001995");
    vi.stubEnv("HACC_OPERATOR_SMS_SEGMENT_CEILING_USD", "0.009995");
    vi.stubEnv("HACC_OPERATOR_VOICE_MINUTE_CEILING_USD", "0.333333");
    vi.stubEnv("HACC_OPERATOR_NUMBER_MONTHLY_CEILING_USD", "1.499995");
    vi.stubEnv("HACC_OPERATOR_CALL_MAX_DURATION_SECONDS", "900");
    vi.stubEnv("HACC_OPERATOR_QUOTE_SAFETY_MARGIN_USD", "0.000005");
    vi.stubEnv("HACC_OPERATOR_QUOTE_TTL_SECONDS", "86400");
    vi.stubEnv("HACC_OPERATOR_QUOTE_MAX_RESERVATION_USD", "100");

    mocks.operatorActionArgumentsSha256.mockReturnValue(ARGUMENTS_SHA256);
    mocks.qOne.mockResolvedValue({ id: AGENT_ID, phone_number: "+14155550000" });
    mocks.buildVoiceRuntimeSnapshotForAdmission.mockResolvedValue({
      snapshot: RUNTIME_SNAPSHOT,
      digest: RUNTIME_DIGEST,
      agentVersion: 7,
    });
    mocks.parseCallRuntimeSnapshot.mockReturnValue({
      snapshot: RUNTIME_SNAPSHOT,
      digest: RUNTIME_DIGEST,
    });
    mocks.q.mockImplementation(async (rawSql: string, params: unknown[] = []) => {
      const sql = compactSql(rawSql);
      if (sql.startsWith("INSERT INTO scheduled_calls")) {
        mocks.trace.push("materialized");
        return [{ id: params[0] }];
      }
      if (sql.includes("SET status = 'dialing'")) {
        mocks.trace.push("claimed");
        return [{ id: EXECUTION_ID }];
      }
      if (sql.includes("SET phone_number_provisioning_execution_id = $3")) {
        mocks.trace.push("number_reserved");
        return [{ id: AGENT_ID }];
      }
      if (sql.includes("SET phone_number = $3")) {
        mocks.trace.push("number_attached");
        return [{ id: AGENT_ID }];
      }
      return [];
    });
    mocks.executeConfirmedOperatorAction.mockImplementation(async (input: {
      idempotencyKey: string;
      dispatch: (ctx: { executionId: string; idempotencyKey: string }) => Promise<unknown>;
    }) => {
      mocks.trace.push("authority_reserved");
      try {
        const value = await input.dispatch({
          executionId: EXECUTION_ID,
          idempotencyKey: input.idempotencyKey,
        });
        return { ok: true, replayed: false, value };
      } catch {
        return { ok: false, code: "provider_outcome_indeterminate_do_not_retry" };
      }
    });
    mocks.sendAgentEmail.mockImplementation(async () => {
      mocks.trace.push("email_provider");
    });
    mocks.sendSms.mockImplementation(async () => {
      mocks.trace.push("sms_provider");
    });
    mocks.dispatchOperatorEmail.mockImplementation(async () => {
      mocks.trace.push("email_provider");
      return {
        status: "accepted",
        providerMessageId: "resend-message-opaque",
      };
    });
    mocks.dispatchOperatorSms.mockImplementation(async () => {
      mocks.trace.push("sms_provider");
      return {
        status: "accepted",
        providerMessageId: `SM${"d".repeat(32)}`,
      };
    });
    mocks.originateCall.mockImplementation(async () => {
      mocks.trace.push("call_provider");
      return {
        callId: CALL_ID,
        status: "accepted",
        code: "provider_accepted",
        delivery: ACCEPTED_DELIVERY,
      };
    });
    mocks.purchaseNumber.mockImplementation(async () => {
      mocks.trace.push("number_provider");
      return "+14155550999";
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects changed argument shape before authority reservation or any provider", async () => {
    const action = approved("send_email", {
      brand: "Harsha's Amazing Call Center",
      message: "Welcome",
      subject: "Membership",
      to: "member@example.test",
      confirmation_token: "model-injected-authority",
    });

    await expect(dispatchApprovedOperatorAction(action)).rejects.toThrow(
      "approved action argument shape changed"
    );

    expect(mocks.executeConfirmedOperatorAction).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
    expectNoProviderCalls();
  });

  it("rejects invalid destinations before authority reservation or provider I/O", async () => {
    const costQuote = createEmailCostQuote({ recipient: "member@example.test" });
    const action = approved("send_email", {
      brand: null,
      cost_quote: costQuote as unknown as Json,
      message: "Welcome",
      subject: "Membership",
      to: "not-an-email",
    });

    await expect(dispatchApprovedOperatorAction(action)).rejects.toThrow(
      "approved email address is invalid"
    );

    expect(mocks.executeConfirmedOperatorAction).not.toHaveBeenCalled();
    expectNoProviderCalls();
  });

  it("binds email provider idempotency to the durable execution id", async () => {
    const costQuote = createEmailCostQuote({ recipient: "member@example.test" });
    const action = approved("send_email", {
      brand: "Harsha's Amazing Call Center",
      cost_quote: costQuote as unknown as Json,
      message: "Your renewal is ready.",
      subject: "Membership renewal",
      to: "MEMBER@EXAMPLE.TEST",
    }, { microUsd: costQuote.reservationMicroUsd });

    const outcome = await dispatchApprovedOperatorAction(action);

    expect(mocks.executeConfirmedOperatorAction).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: APPROVAL_ID,
      idempotencyKey: APPROVAL_ID,
      capability: "send_email",
      argumentsValue: action.argumentsValue,
      confirmationToken: "server-only-confirmation-token",
      estimatedUnits: 1,
      estimatedMicroUsd: 2_000,
    }));
    expect(mocks.dispatchOperatorEmail).toHaveBeenCalledExactlyOnceWith({
      to: "member@example.test",
      subject: "Membership renewal",
      message: "Your renewal is ready.",
      brand: "Harsha's Amazing Call Center",
      context: {
        approvalId: APPROVAL_ID,
        executionId: EXECUTION_ID,
        expectedQuote: costQuote,
      },
    });
    expect(mocks.trace).toEqual(["authority_reserved", "email_provider"]);
    expect(outcome).toEqual({
      ok: true,
      replayed: false,
      value: {
        accepted: true,
        to: "member@example.test",
        communication_receipt: {
          status: "accepted",
          providerMessageId: "resend-message-opaque",
        },
      },
    });
  });

  it("rejects SMS segment drift before reserving authority or sending", async () => {
    const costQuote = createSmsCostQuote({ destinationE164: "+14155550123", segmentCount: 1 });
    const action = approved("send_sms", {
      cost_quote: costQuote as unknown as Json,
      message: "a".repeat(161),
      segments: 1,
      to: "+14155550123",
    }, { units: 1, microUsd: costQuote.reservationMicroUsd });

    await expect(dispatchApprovedOperatorAction(action)).rejects.toThrow(
      "approved SMS arguments changed"
    );

    expect(mocks.executeConfirmedOperatorAction).not.toHaveBeenCalled();
    expect(mocks.dispatchOperatorSms).not.toHaveBeenCalled();
    expect(mocks.q).not.toHaveBeenCalled();
  });

  it("preserves the private Twilio adapter receipt while keeping the public fields stable", async () => {
    const costQuote = createSmsCostQuote({
      destinationE164: "+14155550123",
      segmentCount: 1,
    });
    const action = approved("send_sms", {
      cost_quote: costQuote as unknown as Json,
      message: "Renewal ready",
      segments: 1,
      to: "+14155550123",
    }, { units: 1, microUsd: costQuote.reservationMicroUsd });

    const outcome = await dispatchApprovedOperatorAction(action);

    expect(mocks.dispatchOperatorSms).toHaveBeenCalledExactlyOnceWith({
      to: "+14155550123",
      message: "Renewal ready",
      segments: 1,
      context: {
        approvalId: APPROVAL_ID,
        executionId: EXECUTION_ID,
        expectedQuote: costQuote,
      },
    });
    expect(outcome).toEqual({
      ok: true,
      replayed: false,
      value: {
        accepted: true,
        to: "+14155550123",
        segments: 1,
        communication_receipt: {
          status: "accepted",
          providerMessageId: `SM${"d".repeat(32)}`,
        },
      },
    });
  });

  it("converts an ambiguous adapter receipt to the existing do-not-retry settlement", async () => {
    mocks.dispatchOperatorEmail.mockResolvedValueOnce({
      status: "indeterminate",
      code: "provider_outcome_unknown",
    });
    const costQuote = createEmailCostQuote({ recipient: "member@example.test" });

    const outcome = await dispatchApprovedOperatorAction(approved("send_email", {
      brand: null,
      cost_quote: costQuote as unknown as Json,
      message: "Renewal ready",
      subject: "Renewal",
      to: "member@example.test",
    }, { microUsd: costQuote.reservationMicroUsd }));

    expect(outcome).toEqual({
      ok: false,
      code: "provider_outcome_indeterminate_do_not_retry",
    });
    expect(mocks.dispatchOperatorEmail).toHaveBeenCalledOnce();
  });

  it("materializes an exact runtime authority manifest and claims it before an immediate call", async () => {
    const action = approved("place_call", callArguments(), { microUsd: 5_000_000 });

    const outcome = await dispatchApprovedOperatorAction(action);

    expect(mocks.operatorActionArgumentsSha256).toHaveBeenCalledWith(
      "place_call",
      action.argumentsValue
    );
    expect(mocks.buildVoiceRuntimeSnapshotForAdmission).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      orgId: ORG_ID,
      flowId: null,
      admissionScopeId: ADMISSION_SCOPE_ID,
    });
    expect(mocks.q).toHaveBeenCalledTimes(2);
    const [insertSql, insertParams] = mocks.q.mock.calls[0] as [string, unknown[]];
    expect(compactSql(insertSql)).toContain("INSERT INTO scheduled_calls");
    expect(insertParams.slice(0, 12)).toEqual([
      ADMISSION_SCOPE_ID,
      ORG_ID,
      7,
      "+14155550123",
      "Membership renewal",
      "operator (operator@example.test)",
      EXECUTION_ID,
      ARGUMENTS_SHA256,
      JSON.stringify(RUNTIME_SNAPSHOT),
      RUNTIME_DIGEST,
      expect.any(String),
      AGENT_ID,
    ]);
    expect(JSON.parse(String(insertParams[10]))).toEqual({
      v: 1,
      capability: "place_call",
      callId: ADMISSION_SCOPE_ID,
      orgId: ORG_ID,
      operatorExecutionId: EXECUTION_ID,
      operatorArgumentsSha256: ARGUMENTS_SHA256,
      runtimeDigest: RUNTIME_DIGEST,
      targetSetSha256: null,
      agentVersion: 7,
      flowId: null,
      campaignId: null,
    });
    const [claimSql, claimParams] = mocks.q.mock.calls[1] as [string, unknown[]];
    expect(compactSql(claimSql)).toContain("oe.status = 'dispatching'");
    expect(claimParams[0]).toBe(ADMISSION_SCOPE_ID);
    expect(claimParams[1]).toBe(ORG_ID);
    expect(claimParams[2]).toEqual(expect.stringMatching(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
    ));
    expect(claimParams[3]).toBe(EXECUTION_ID);
    expect(claimParams[4]).toBe(ARGUMENTS_SHA256);
    expect(mocks.originateCall).toHaveBeenCalledWith(
      AGENT_ID,
      "+14155550123",
      "Membership renewal",
      {
        scheduledCallId: ADMISSION_SCOPE_ID,
        claimToken: claimParams[2],
        expectedAgentVersion: 7,
        maxDurationSeconds: 900,
        runtimeSnapshot: RUNTIME_SNAPSHOT,
        runtimeDigest: RUNTIME_DIGEST,
      }
    );
    expect(mocks.trace).toEqual([
      "authority_reserved",
      "materialized",
      "claimed",
      "call_provider",
    ]);
    expect(outcome).toEqual({
      ok: true,
      replayed: false,
      value: {
        call_id: CALL_ID,
        status: "accepted",
        code: "provider_accepted",
        delivery: ACCEPTED_DELIVERY,
      },
    });
  });

  it("returns a definitive immediate-call rejection without converting it to indeterminate", async () => {
    mocks.originateCall.mockImplementationOnce(async () => {
      mocks.trace.push("call_provider");
      return { callId: CALL_ID, status: "failed", code: "provider_rejected" };
    });

    const outcome = await dispatchApprovedOperatorAction(
      approved("place_call", callArguments(), { microUsd: 5_000_000 })
    );

    expect(outcome).toEqual({
      ok: true,
      replayed: false,
      value: { call_id: CALL_ID, status: "failed", code: "provider_rejected" },
    });
    expect(mocks.q).toHaveBeenCalledTimes(2);
  });

  it("fails closed and does not retry an indeterminate immediate-call outcome", async () => {
    mocks.originateCall.mockImplementationOnce(async () => {
      mocks.trace.push("call_provider");
      return { callId: CALL_ID, status: "indeterminate", code: "transport_unknown" };
    });

    const outcome = await dispatchApprovedOperatorAction(
      approved("place_call", callArguments(), { microUsd: 5_000_000 })
    );

    expect(outcome).toEqual({
      ok: false,
      code: "provider_outcome_indeterminate_do_not_retry",
    });
    expect(mocks.originateCall).toHaveBeenCalledOnce();
    expect(mocks.q.mock.calls.some(([sql]) => compactSql(String(sql)).includes(
      "SET status = 'indeterminate'"
    ))).toBe(true);
  });

  it("materializes a scheduled call with pinned runtime, parent, and authority", async () => {
    mocks.qOne
      .mockResolvedValueOnce({ id: AGENT_ID, phone_number: "+14155550000" })
      .mockResolvedValueOnce({ id: PARENT_CALL_ID });
    const action = approved("schedule_call", scheduleArguments({
      parent_call_id: PARENT_CALL_ID,
      reason: null,
    }), { microUsd: 5_000_000 });

    const outcome = await dispatchApprovedOperatorAction(action);

    expect(mocks.qOne).toHaveBeenNthCalledWith(2, expect.stringContaining("FROM calls c"), [
      PARENT_CALL_ID,
      AGENT_ID,
      ORG_ID,
    ]);
    expect(mocks.originateCall).not.toHaveBeenCalled();
    expect(mocks.q).toHaveBeenCalledOnce();
    const [sql, params] = mocks.q.mock.calls[0] as [string, unknown[]];
    expect(compactSql(sql)).toContain("INSERT INTO scheduled_calls");
    expect(params.slice(0, 14)).toEqual([
      ADMISSION_SCOPE_ID,
      ORG_ID,
      7,
      "+14155550123",
      "2026-07-17T18:30:00.000Z",
      null,
      PARENT_CALL_ID,
      "operator (operator@example.test)",
      EXECUTION_ID,
      ARGUMENTS_SHA256,
      JSON.stringify(RUNTIME_SNAPSHOT),
      RUNTIME_DIGEST,
      expect.any(String),
      AGENT_ID,
    ]);
    expect(JSON.parse(String(params[12]))).toEqual(expect.objectContaining({
      v: 1,
      capability: "schedule_call",
      callId: ADMISSION_SCOPE_ID,
      orgId: ORG_ID,
      operatorExecutionId: EXECUTION_ID,
      operatorArgumentsSha256: ARGUMENTS_SHA256,
      runtimeDigest: RUNTIME_DIGEST,
      agentVersion: 7,
    }));
    expect(outcome).toEqual({
      ok: true,
      replayed: false,
      value: {
        status: "scheduled",
        id: ADMISSION_SCOPE_ID,
        run_at: "2026-07-17T18:30:00.000Z",
      },
    });
  });

  it("reserves an agent before purchasing a number and attaches only with matching execution", async () => {
    const costQuote = createNumberMonthlyCostQuote({
      candidateE164: "+14155550999",
      countryCode: "US",
      numberType: "local",
    });
    const action = approved("provision_phone_number", {
      agent_id: AGENT_ID,
      area_code: "415",
      candidate_number: "+14155550999",
      cost_quote: costQuote as unknown as Json,
      country_code: "US",
      number_type: "local",
    }, { microUsd: costQuote.reservationMicroUsd });

    const outcome = await dispatchApprovedOperatorAction(action);

    expect(mocks.trace).toEqual([
      "authority_reserved",
      "number_reserved",
      "number_provider",
      "number_attached",
    ]);
    expect(mocks.q).toHaveBeenNthCalledWith(1, expect.stringContaining(
      "phone_number_provisioning_execution_id = $3"
    ), [AGENT_ID, ORG_ID, EXECUTION_ID]);
    expect(mocks.purchaseNumber).toHaveBeenCalledExactlyOnceWith("+14155550999");
    expect(mocks.q).toHaveBeenNthCalledWith(2, expect.stringContaining(
      "phone_number_provisioning_execution_id = $4"
    ), [AGENT_ID, ORG_ID, "+14155550999", EXECUTION_ID]);
    expect(outcome).toEqual({
      ok: true,
      replayed: false,
      value: { phone_number: "+14155550999" },
    });
  });

  it("never purchases a number when the durable agent reservation loses", async () => {
    mocks.q.mockResolvedValueOnce([]);
    const costQuote = createNumberMonthlyCostQuote({
      candidateE164: "+14155550999",
      countryCode: "US",
      numberType: "local",
    });

    const outcome = await dispatchApprovedOperatorAction(approved(
      "provision_phone_number",
      {
        agent_id: AGENT_ID,
        area_code: null,
        candidate_number: "+14155550999",
        cost_quote: costQuote as unknown as Json,
        country_code: "US",
        number_type: "local",
      },
      { microUsd: costQuote.reservationMicroUsd }
    ));

    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      ok: true,
      replayed: false,
      value: { status: "rejected", code: "agent_unavailable_for_number_purchase" },
    });
  });

  it("does not kick campaign jobs again when returning an authoritative replay receipt", async () => {
    const costQuote = createVoiceCampaignCostQuote({
      originE164: "+14155550000",
      destinationE164s: ["+14155550123", "+14155550124"],
      targetSetSha256: "d".repeat(64),
      maxDurationSeconds: 900,
    });
    const campaignArguments = {
      schema_version: 1,
      action: "run_campaign",
      org_id: ORG_ID,
      agent_id: AGENT_ID,
      agent_version: 7,
      flow_id: PARENT_CALL_ID,
      flow_sha256: "c".repeat(64),
      dataset_id: CALL_ID,
      dataset_slug: "members",
      phone_column: "phone",
      runtime_admission_scope_id: ADMISSION_SCOPE_ID,
      runtime_digest: RUNTIME_DIGEST,
      target_set_sha256: "d".repeat(64),
      target_count: 2,
      skipped_count: 0,
      campaign_name: "Member renewal",
      run_at: null,
      from_number: "+14155550000",
      max_duration_seconds: 900,
      cost_quote: costQuote as unknown as Json,
      worst_case_micro_usd: costQuote.reservationMicroUsd,
    } as const;
    const replayValue = {
      campaignId: CAMPAIGN_ID,
      targets: 2,
      skipped: 0,
      scheduled: false,
    };
    mocks.campaignAuthorizationArguments.mockReturnValue(campaignArguments);
    mocks.executeConfirmedOperatorAction.mockResolvedValueOnce({
      ok: true,
      replayed: true,
      value: replayValue,
    });

    const outcome = await dispatchApprovedOperatorAction(approved(
      "run_campaign",
      campaignArguments,
      { units: costQuote.units, microUsd: costQuote.reservationMicroUsd },
    ));

    expect(outcome).toEqual({ ok: true, replayed: true, value: replayValue });
    expect(mocks.launchCampaign).not.toHaveBeenCalled();
    expect(mocks.kickCampaign).not.toHaveBeenCalled();
  });
});

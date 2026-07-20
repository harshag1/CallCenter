import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  campaignAuthorizationArguments: vi.fn(),
  campaignStats: vi.fn(),
  cancelCampaign: vi.fn(),
  createFlow: vi.fn(),
  kickCampaign: vi.fn(),
  launchCampaign: vi.fn(),
  listFlows: vi.fn(),
  operatorActionArgumentsSha256: vi.fn(),
  previewCampaignForProposal: vi.fn(),
  proposeOperatorAction: vi.fn(),
  q: vi.fn(),
  qOne: vi.fn(),
  updateFlow: vi.fn(),
}));

vi.mock("../campaigns", () => ({
  campaignAuthorizationArguments: mocks.campaignAuthorizationArguments,
  campaignStats: mocks.campaignStats,
  cancelCampaign: mocks.cancelCampaign,
  createFlow: mocks.createFlow,
  kickCampaign: mocks.kickCampaign,
  launchCampaign: mocks.launchCampaign,
  listFlows: mocks.listFlows,
  previewCampaignForProposal: mocks.previewCampaignForProposal,
  updateFlow: mocks.updateFlow,
}));

vi.mock("../agent/tools/operator-capability-policy", () => ({
  operatorActionArgumentsSha256: mocks.operatorActionArgumentsSha256,
  proposeOperatorAction: mocks.proposeOperatorAction,
}));

vi.mock("../db", () => ({
  q: mocks.q,
  qOne: mocks.qOne,
}));

import { previewCampaignTool, runCampaignTool } from "../agent/tools/flows-tools";
import { createVoiceCampaignCostQuote } from "../operator-pricing";
import type { ToolCtx } from "../agent/types";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "00000000-0000-4000-8000-000000000002";
const FLOW_ID = "00000000-0000-4000-8000-000000000003";
const DATASET_ID = "00000000-0000-4000-8000-000000000004";
const PROPOSAL_ID = "00000000-0000-4000-8000-000000000005";
const THREAD_ID = "00000000-0000-4000-8000-000000000006";
const ARGUMENTS_SHA256 = "a".repeat(64);
const TARGET_COUNT = 3;
const WORST_CASE_MICRO_USD = 15_000_000;
const FROM_NUMBER = "+14155550100";
const MAX_DURATION_SECONDS = 120;
const DISPLAY_TARGETS = Object.freeze([
  "+14155550101",
  "+14155550102",
  "+14155550103",
]);
const COST_QUOTE = createVoiceCampaignCostQuote({
  originE164: FROM_NUMBER,
  destinationE164s: DISPLAY_TARGETS,
  targetSetSha256: "b".repeat(64),
  maxDurationSeconds: MAX_DURATION_SECONDS,
}, {
  environment: {
    HACC_OPERATOR_VOICE_MINUTE_CEILING_USD: "2.5",
    HACC_OPERATOR_QUOTE_SAFETY_MARGIN_USD: "0",
    HACC_OPERATOR_QUOTE_TTL_SECONDS: "3600",
    HACC_OPERATOR_QUOTE_MAX_RESERVATION_USD: "100",
  },
  now: new Date("2026-07-16T00:00:00.000Z"),
});

const preview = Object.freeze({
  schemaVersion: 1 as const,
  orgId: ORG_ID,
  agentId: AGENT_ID,
  flowId: FLOW_ID,
  datasetId: DATASET_ID,
  datasetSlug: "members",
  phoneColumn: "phone",
  targetSetSha256: "b".repeat(64),
  targetCount: TARGET_COUNT,
  skipped: 2,
});

const authorization = Object.freeze({
  schema_version: 1 as const,
  action: "run_campaign" as const,
  org_id: ORG_ID,
  agent_id: AGENT_ID,
  flow_id: FLOW_ID,
  dataset_id: DATASET_ID,
  dataset_slug: "members",
  phone_column: "phone",
  target_set_sha256: preview.targetSetSha256,
  target_count: TARGET_COUNT,
  skipped_count: 2,
  campaign_name: "Member renewal",
  run_at: null,
  from_number: FROM_NUMBER,
  max_duration_seconds: MAX_DURATION_SECONDS,
  cost_quote: COST_QUOTE,
  worst_case_micro_usd: WORST_CASE_MICRO_USD,
});

const toolArguments = Object.freeze({
  agent_id: AGENT_ID,
  flow_id: FLOW_ID,
  name: "Member renewal",
  dataset: "members",
  phone_column: "phone",
  max_duration_seconds: MAX_DURATION_SECONDS,
});

const ctx: ToolCtx = Object.freeze({
  orgId: ORG_ID,
  email: "operator@example.test",
  agentId: AGENT_ID,
  origin: "https://operator.example.test",
  threadId: THREAD_ID,
});

const proposal = Object.freeze({
  schemaVersion: 1 as const,
  proposalId: PROPOSAL_ID,
  capability: "run_campaign" as const,
  arguments: authorization,
  argumentsSha256: ARGUMENTS_SHA256,
  estimatedUnits: COST_QUOTE.units,
  worstCaseMicroUsd: WORST_CASE_MICRO_USD,
  expiresAt: "2026-07-16T01:00:00.000Z",
});

describe("campaign operator-tool authority wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("HACC_OPERATOR_VOICE_MINUTE_CEILING_USD", "2.5");
    vi.stubEnv("HACC_OPERATOR_QUOTE_SAFETY_MARGIN_USD", "0");
    vi.stubEnv("HACC_OPERATOR_QUOTE_TTL_SECONDS", "3600");
    vi.stubEnv("HACC_OPERATOR_QUOTE_MAX_RESERVATION_USD", "100");
    vi.stubEnv("HACC_OPERATOR_CALL_MAX_DURATION_SECONDS", String(MAX_DURATION_SECONDS));
    mocks.qOne.mockResolvedValue({ phone_number: FROM_NUMBER });
    mocks.previewCampaignForProposal.mockResolvedValue({
      preview,
      displayTargets: DISPLAY_TARGETS,
    });
    mocks.campaignAuthorizationArguments.mockReturnValue(authorization);
    mocks.operatorActionArgumentsSha256.mockReturnValue(ARGUMENTS_SHA256);
    mocks.proposeOperatorAction.mockResolvedValue(proposal);
  });

  it("previews the exact frozen authorization hash and conservative cost without launching", async () => {
    const result = await previewCampaignTool.execute(toolArguments as never, ctx);

    expect(mocks.previewCampaignForProposal).toHaveBeenCalledWith(ORG_ID, {
      agentId: AGENT_ID,
      flowId: FLOW_ID,
      datasetSlug: "members",
      phoneColumn: "phone",
    });
    expect(mocks.campaignAuthorizationArguments).toHaveBeenCalledWith(preview, {
      name: "Member renewal",
      runAt: null,
      fromNumber: FROM_NUMBER,
      maxDurationSeconds: MAX_DURATION_SECONDS,
      costQuote: expect.objectContaining({
        units: COST_QUOTE.units,
        reservationMicroUsd: WORST_CASE_MICRO_USD,
        unitKind: "voice_minute",
      }),
      worstCaseMicroUsd: WORST_CASE_MICRO_USD,
    });
    expect(mocks.operatorActionArgumentsSha256).toHaveBeenCalledWith(
      "run_campaign",
      authorization
    );
    expect(result.output).toEqual({
      requires_confirmation: true,
      target_preview: preview,
      authorization_arguments: authorization,
      authorization_arguments_sha256: ARGUMENTS_SHA256,
      spend_reservation_usd: 15,
    });
    expect((result.output as { target_preview: unknown }).target_preview).toBe(preview);
    expect((result.output as { authorization_arguments: unknown }).authorization_arguments)
      .toBe(authorization);
    expect(JSON.stringify(result.output)).not.toContain(DISPLAY_TARGETS[0]);
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(authorization)).toBe(true);
    expect(mocks.proposeOperatorAction).not.toHaveBeenCalled();
    expect(mocks.launchCampaign).not.toHaveBeenCalled();
    expect(mocks.kickCampaign).not.toHaveBeenCalled();
  });

  it("creates only an immutable browser proposal and ignores model-carried approval material", async () => {
    const result = await runCampaignTool.execute({
      ...toolArguments,
      confirmation_token: "model-must-not-approve",
      idempotency_key: "model-must-not-select-execution-identity",
    } as never, ctx);

    expect(mocks.proposeOperatorAction).toHaveBeenCalledOnce();
    expect(mocks.proposeOperatorAction).toHaveBeenCalledWith({
      ctx,
      capability: "run_campaign",
      argumentsValue: authorization,
      privateDisplay: { targets: DISPLAY_TARGETS },
      estimatedUnits: COST_QUOTE.units,
      estimatedMicroUsd: WORST_CASE_MICRO_USD,
    });
    expect(result.output).toEqual({
      status: "human_confirmation_required",
      proposal_id: PROPOSAL_ID,
    });
    expect(result.operatorActionConfirmation).toBe(proposal);
    expect(JSON.stringify(result)).not.toContain(DISPLAY_TARGETS[0]);
    expect(mocks.launchCampaign).not.toHaveBeenCalled();
    expect(mocks.kickCampaign).not.toHaveBeenCalled();
  });

  it("does not launch or kick when proposal issuance is denied", async () => {
    mocks.proposeOperatorAction.mockRejectedValueOnce(new Error("operator_action_proposal_denied"));

    const result = await runCampaignTool.execute(toolArguments as never, ctx);

    expect(result.output).toEqual({ error: "operator_action_proposal_denied" });
    expect(mocks.proposeOperatorAction).toHaveBeenCalledOnce();
    expect(mocks.launchCampaign).not.toHaveBeenCalled();
    expect(mocks.kickCampaign).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_DEV_SEMANTIC_GATEWAY_FUNCTION,
  LC4_DEV_SEMANTIC_INTENTS,
  Lc4DevGatewayTurnCoordinator,
  type Lc4DevGatewayExecutor,
  type Lc4DevGatewayExecutionInput,
} from "../lc4-development-gateway-bridge";
import type { Lc4DevLiveEpisodePlan } from "../lc4-development-live-runner";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  RealtimeEventListener,
  RealtimeToolResult,
} from "../../realtime/client/types";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  PROVIDER_PROVENANCE_META_KEY,
} from "../../realtime/client/types";

const HASH = "a".repeat(64);
const AUTHORITY_PROJECTION_DOMAIN = "harshas-amazing-call-center/lc4-dev-gateway-authority-projection/v1\n";
const opportunity = createLc4PublicDevelopmentCorpus().opportunities[0]!;

function episode(provider: "openai" | "gemini" | "xai", arm: "native" | "hacc"): Lc4DevLiveEpisodePlan {
  return Object.freeze({
    episode_id: `lc4-dev-${provider}-${arm}`,
    pair_id: `lc4-dev-${provider}`,
    pair_position: arm === "native" ? 1 : 2,
    provider,
    arm,
    model: `test-${provider}`,
    voice: "test-voice",
    maximum_micro_usd: 1_000,
    opportunity_binding_set_sha256: HASH,
  });
}

class FakeClient implements NormalizedRealtimeClient {
  readonly provider;
  readonly state = "ready" as const;
  readonly operations: string[] = [];
  readonly submitted: Array<Readonly<{ results: readonly RealtimeToolResult[]; createResponse: boolean | undefined }>> = [];
  #listeners = new Set<RealtimeEventListener>();

  constructor(provider: "openai" | "gemini" | "xai") { this.provider = provider; }
  async connect() {}
  close() {}
  onEvent(listener: RealtimeEventListener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  onWireEvent() { return () => undefined; }
  appendInputAudio() {}
  prepareResponse() {}
  commitInputAudio() {}
  createResponse() {
    expect(this.operations.at(-1)).toBe("submit:false");
    this.operations.push("create");
  }
  sendTurn() {}
  submitToolResults(results: readonly RealtimeToolResult[], createResponse?: boolean) {
    this.submitted.push({ results, createResponse });
    this.operations.push(`submit:${String(createResponse)}`);
  }
}

function executor(inputs: Lc4DevGatewayExecutionInput[]): Lc4DevGatewayExecutor {
  return Object.freeze({
    kind: "lc4-dev-arm-aware-gateway-v1" as const,
    manifest_sha256: "b".repeat(64),
    async execute(input: Lc4DevGatewayExecutionInput) {
      inputs.push(input);
      const providerOutput = { ok: true, public_receipt: `receipt-${inputs.length}` };
      const authoritativeReceiptSha256 = sha256Hex(`authority:${inputs.length}`);
      const controlPlaneHeadSha256 = sha256Hex(`head:${inputs.length}`);
      const projectionBody = {
        schema_version: 1 as const,
        bridge_version: "lc4-dev-gateway-bridge-v1" as const,
        redaction: "public_dev_authority_no_raw_provider_ids_or_credentials" as const,
        episode_id: input.episode_id,
        opportunity_id: input.opportunity_id,
        opportunity_index: input.opportunity_index,
        provider: input.provider,
        arm: input.arm,
        semantic_intent: input.semantic_intent,
        target_tool: input.target_tool,
        provider_call_id_sha256: sha256Hex(input.provider_call_id),
        provider_response_id_sha256: sha256Hex(input.provider_response_id),
        request_sha256: input.request_sha256,
        provider_provenance_sha256: input.provider_provenance_sha256,
        model_arguments: input.target_arguments,
        effective_arguments: {},
        provider_output: providerOutput,
        authoritative_receipt: { ok: true },
        authoritative_tool_world_receipt: null,
        post_transition_response_plan_sha256: null,
        post_transition_response_control_sha256: null,
        authoritative_receipt_sha256: authoritativeReceiptSha256,
        control_plane_head_sha256: controlPlaneHeadSha256,
        disposition: "executed" as const,
      };
      return Object.freeze({
        provider_output: providerOutput,
        authoritative_receipt_sha256: authoritativeReceiptSha256,
        control_plane_head_sha256: controlPlaneHeadSha256,
        disposition: "executed" as const,
        authority_projection: Object.freeze({
          ...projectionBody,
          projection_sha256: sha256Hex(`${AUTHORITY_PROJECTION_DOMAIN}${canonicalJson(projectionBody)}`),
        }),
      });
    },
  });
}

function dispatchEvent(
  provider: "openai" | "xai",
  responseId = "response-1",
  callId = "call-1",
): NormalizedRealtimeEvent {
  const provenance = Object.freeze({
    schemaVersion: 1 as const,
    provider,
    nativeCallId: callId,
    nativeResponseId: responseId,
    terminalWireType: "response.function_call_arguments.done",
  });
  return {
    type: "tool.dispatch",
    provider,
    receivedAtMs: 1,
    wireType: "response.function_call_arguments.done",
    responseId,
    gateway: "capability_gateway",
    dispatches: [{
      callId,
      provenance,
      request: {
        method: "tools/call",
        params: {
          name: "complete_current_stage",
          arguments: {},
          _meta: {
            [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: callId,
            [PROVIDER_PROVENANCE_META_KEY]: provenance,
          },
        },
      },
    }],
  };
}

describe("LC4-DEV provider-neutral gateway bridge", () => {
  it("exposes one stable provider function with a closed semantic intent enum and no model slots", () => {
    expect(LC4_DEV_SEMANTIC_GATEWAY_FUNCTION).toMatchObject({
      name: "capability_gateway",
      parameters: {
        additionalProperties: false,
        properties: {
          tool_name: { enum: LC4_DEV_SEMANTIC_INTENTS },
          arguments: { additionalProperties: false, properties: {} },
        },
      },
    });
  });

  it("routes provenance-bound OpenAI dispatch and continues only after an authoritative result batch", async () => {
    const client = new FakeClient("openai");
    const inputs: Lc4DevGatewayExecutionInput[] = [];
    const failures: Error[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({ client, executor: executor(inputs), onFatal: (error) => failures.push(error) });
    coordinator.beginOpportunity({ episode: episode("openai", "hacc"), opportunity });
    coordinator.observe(dispatchEvent("openai"));
    expect(coordinator.ownsToolResponse("response-1")).toBe(true);
    const evidence = await coordinator.finishOpportunity();

    expect(failures).toEqual([]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      arm: "hacc",
      provider: "openai",
      semantic_intent: "complete_current_stage",
      target_tool: "archive.complete_stage",
      target_arguments: {},
    });
    expect(client.operations).toEqual(["submit:false", "create"]);
    expect(client.submitted[0]?.createResponse).toBe(false);
    expect(evidence.receipts).toHaveLength(1);
    expect(JSON.stringify(evidence.receipts)).not.toContain("public_receipt");
    expect(evidence.authority_projections[0]?.provider_output).toEqual({ ok: true, public_receipt: "receipt-1" });
    expect(evidence.receipt_set_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("normalizes Gemini tool.calls and preserves explicit Native routing without adding HACC authority", async () => {
    const client = new FakeClient("gemini");
    const inputs: Lc4DevGatewayExecutionInput[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({ client, executor: executor(inputs), onFatal: () => undefined });
    coordinator.beginOpportunity({ episode: episode("gemini", "native"), opportunity });
    coordinator.observe({
      type: "tool.calls",
      provider: "gemini",
      receivedAtMs: 1,
      wireType: "toolCall",
      responseId: "gemini-response-1",
      calls: [{
        callId: "gemini-call-1",
        name: "capability_gateway",
        argumentsText: JSON.stringify({ tool_name: "complete_current_stage", arguments: {} }),
        argumentsJson: { tool_name: "complete_current_stage", arguments: {} },
        responseId: "gemini-response-1",
        terminalWireType: "toolCall",
      }],
    });
    await coordinator.finishOpportunity();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.arm).toBe("native");
    expect(client.operations).toEqual(["submit:false", "create"]);
  });

  it("accepts sequential Gemini tool batches in one model-turn response", async () => {
    const client = new FakeClient("gemini");
    const inputs: Lc4DevGatewayExecutionInput[] = [];
    const failures: Error[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({ client, executor: executor(inputs), onFatal: (error) => failures.push(error) });
    coordinator.beginOpportunity({ episode: episode("gemini", "hacc"), opportunity });

    for (const [callId, intent] of [["gemini-call-1", "complete_current_stage"], ["gemini-call-2", "reserve_archive_room"]] as const) {
      coordinator.observe({
        type: "tool.calls",
        provider: "gemini",
        receivedAtMs: 1,
        wireType: "toolCall",
        responseId: "gemini-response-1",
        calls: [{
          callId,
          name: "capability_gateway",
          argumentsText: JSON.stringify({ tool_name: intent, arguments: {} }),
          argumentsJson: { tool_name: intent, arguments: {} },
          responseId: "gemini-response-1",
          terminalWireType: "toolCall",
        }],
      });
    }

    const evidence = await coordinator.finishOpportunity();
    expect(failures).toEqual([]);
    expect(inputs.map((input) => input.provider_call_id)).toEqual(["gemini-call-1", "gemini-call-2"]);
    expect(client.operations).toEqual(["submit:false", "create", "submit:false", "create"]);
    expect(client.submitted).toHaveLength(2);
    expect(evidence.receipts.map((receipt) => receipt.batch_ordinal)).toEqual([1, 2]);
  });

  it("fails closed on a replayed provider call identity and never submits a result", async () => {
    const client = new FakeClient("xai");
    const inputs: Lc4DevGatewayExecutionInput[] = [];
    const failures: Error[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({ client, executor: executor(inputs), onFatal: (error) => failures.push(error) });
    coordinator.beginOpportunity({ episode: episode("xai", "hacc"), opportunity });
    coordinator.observe(dispatchEvent("xai", "response-1", "call-1"));
    coordinator.observe(dispatchEvent("xai", "response-2", "call-1"));
    await expect(coordinator.finishOpportunity()).rejects.toThrow("reused a tool call identity");
    expect(failures).toHaveLength(1);
    expect(client.submitted).toHaveLength(0);
  });

  it("fails closed when OpenAI or xAI repeats a response identity with a fresh call", async () => {
    const client = new FakeClient("xai");
    const failures: Error[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({ client, executor: executor([]), onFatal: (error) => failures.push(error) });
    coordinator.beginOpportunity({ episode: episode("xai", "hacc"), opportunity });
    coordinator.observe(dispatchEvent("xai", "response-1", "call-1"));
    coordinator.observe(dispatchEvent("xai", "response-1", "call-2"));
    await expect(coordinator.finishOpportunity()).rejects.toThrow("repeated an executable tool batch response");
    expect(failures).toHaveLength(1);
    expect(client.submitted).toHaveLength(0);
  });

  it("rejects Gemini calls outside the single capability gateway", async () => {
    const client = new FakeClient("gemini");
    const failures: Error[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({ client, executor: executor([]), onFatal: (error) => failures.push(error) });
    coordinator.beginOpportunity({ episode: episode("gemini", "hacc"), opportunity });
    coordinator.observe({
      type: "tool.calls",
      provider: "gemini",
      receivedAtMs: 1,
      wireType: "toolCall",
      responseId: "gemini-response-1",
      calls: [{
        callId: "bad-call",
        name: "unsafe.direct_tool",
        argumentsText: "{}",
        argumentsJson: {},
        responseId: "gemini-response-1",
        terminalWireType: "toolCall",
      }],
    });
    await expect(coordinator.finishOpportunity()).rejects.toThrow("outside capability_gateway");
    expect(failures).toHaveLength(1);
    expect(client.submitted).toEqual([]);
  });

  it.each([
    { tool_name: "archive.complete_stage", arguments: {} },
    { tool_name: "complete_current_stage", arguments: { stage_id: "stage.intake" } },
  ])("rejects open action names and hidden argument overrides before execution", async ({ tool_name, arguments: args }) => {
    const client = new FakeClient("gemini");
    const failures: Error[] = [];
    const inputs: Lc4DevGatewayExecutionInput[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({
      client,
      executor: executor(inputs),
      onFatal: (error) => failures.push(error),
    });
    coordinator.beginOpportunity({ episode: episode("gemini", "hacc"), opportunity });
    coordinator.observe({
      type: "tool.calls",
      provider: "gemini",
      receivedAtMs: 1,
      wireType: "toolCall",
      responseId: "gemini-response-bad",
      calls: [{
        callId: "gemini-call-bad",
        name: "capability_gateway",
        argumentsText: JSON.stringify({ tool_name, arguments: args }),
        argumentsJson: { tool_name, arguments: args },
        responseId: "gemini-response-bad",
        terminalWireType: "toolCall",
      }],
    });
    await expect(coordinator.finishOpportunity()).rejects.toThrow();
    expect(failures).toHaveLength(1);
    expect(inputs).toEqual([]);
    expect(client.submitted).toEqual([]);
  });
});

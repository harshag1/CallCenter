import { describe, expect, it } from "vitest";

import { sha256Hex } from "../artifacts";
import {
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
      return Object.freeze({
        provider_output: { ok: true, public_receipt: `receipt-${inputs.length}` },
        authoritative_receipt_sha256: sha256Hex(`authority:${inputs.length}`),
        control_plane_head_sha256: sha256Hex(`head:${inputs.length}`),
        disposition: "executed" as const,
      });
    },
  });
}

function dispatchEvent(provider: "openai" | "xai", responseId = "response-1"): NormalizedRealtimeEvent {
  const provenance = Object.freeze({
    schemaVersion: 1 as const,
    provider,
    nativeCallId: "call-1",
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
      callId: "call-1",
      provenance,
      request: {
        method: "tools/call",
        params: {
          name: "records.lookup",
          arguments: { record_id: "PUBLIC-17" },
          _meta: {
            [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: "call-1",
            [PROVIDER_PROVENANCE_META_KEY]: provenance,
          },
        },
      },
    }],
  };
}

describe("LC4-DEV provider-neutral gateway bridge", () => {
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
      target_tool: "records.lookup",
      target_arguments: { record_id: "PUBLIC-17" },
    });
    expect(client.operations).toEqual(["submit:false", "create"]);
    expect(client.submitted[0]?.createResponse).toBe(false);
    expect(evidence.receipts).toHaveLength(1);
    expect(JSON.stringify(evidence)).not.toContain("PUBLIC-17");
    expect(JSON.stringify(evidence)).not.toContain("public_receipt");
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
        argumentsText: JSON.stringify({ tool_name: "records.lookup", arguments: { record_id: "PUBLIC-17" } }),
        argumentsJson: { tool_name: "records.lookup", arguments: { record_id: "PUBLIC-17" } },
        responseId: "gemini-response-1",
        terminalWireType: "toolCall",
      }],
    });
    await coordinator.finishOpportunity();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.arm).toBe("native");
    expect(client.operations).toEqual(["submit:false", "create"]);
  });

  it("fails closed on duplicate executable batches and never submits a second result", async () => {
    const client = new FakeClient("xai");
    const inputs: Lc4DevGatewayExecutionInput[] = [];
    const failures: Error[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({ client, executor: executor(inputs), onFatal: (error) => failures.push(error) });
    coordinator.beginOpportunity({ episode: episode("xai", "hacc"), opportunity });
    const event = dispatchEvent("xai");
    coordinator.observe(event);
    coordinator.observe(event);
    await expect(coordinator.finishOpportunity()).rejects.toThrow("repeated an executable tool batch");
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
});

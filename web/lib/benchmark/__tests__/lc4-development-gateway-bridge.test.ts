import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex, type JsonValue } from "../artifacts";
import {
  LC4_DEV_MAX_REPLAY_BATCH_ARGUMENT_BYTES,
  LC4_DEV_MAX_REPLAY_MODEL_ARGUMENT_BYTES,
  LC4_DEV_SEMANTIC_GATEWAY_FUNCTION,
  LC4_DEV_INTENT_ACTION_MAP,
  LC4_DEV_SEMANTIC_INTENTS,
  Lc4DevGatewayTurnCoordinator,
  assertLc4DevGatewayReceiptSet,
  lc4DevSemanticIntentsForActions,
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
const CONTINUATION_CONTROL = "<hacc_response_plan>{\"revision\":19}</hacc_response_plan>";
const CONTINUATION_CONTROL_SHA256 = sha256Hex(CONTINUATION_CONTROL);
const AUTHORITY_PROJECTION_DOMAIN = "harshas-amazing-call-center/lc4-dev-gateway-authority-projection/v2\n";
const RECEIPT_SET_DOMAIN = "harshas-amazing-call-center/lc4-dev-gateway-dispatch-receipt-set/v3\n";
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
  prepareToolContinuation(preparation: Parameters<NormalizedRealtimeClient["prepareResponse"]>[0]) {
    expect(preparation).toEqual({
      additionalInstructions: CONTINUATION_CONTROL,
      contextSha256: CONTINUATION_CONTROL_SHA256,
      contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
    });
    this.operations.push(`prepare:${preparation.contextSha256}`);
  }
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

class RebindFailureClient extends FakeClient {
  override prepareToolContinuation(): void {
    this.operations.push("prepare:failed");
    throw new Error("deterministic continuation control rebind failure");
  }
}

function executor(
  inputs: Lc4DevGatewayExecutionInput[],
  providerOutputFor: (ordinal: number) => JsonValue = (ordinal) => ({
    ok: true,
    public_receipt: `receipt-${ordinal}`,
  }),
): Lc4DevGatewayExecutor {
  return Object.freeze({
    kind: "lc4-dev-arm-aware-gateway-v1" as const,
    manifest_sha256: "b".repeat(64),
    currentResponsePreparation() {
      return {
        additionalInstructions: CONTINUATION_CONTROL,
        contextSha256: CONTINUATION_CONTROL_SHA256,
        contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
      };
    },
    async execute(input: Lc4DevGatewayExecutionInput) {
      inputs.push(input);
      const providerOutput = providerOutputFor(inputs.length);
      const authoritativeReceiptSha256 = sha256Hex(`authority:${inputs.length}`);
      const controlPlaneHeadSha256 = sha256Hex(`head:${inputs.length}`);
      const projectionBody = {
        schema_version: 2 as const,
        bridge_version: "lc4-dev-gateway-bridge-v4" as const,
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
        post_transition_response_plan: null,
        post_transition_response_control: null,
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
  semanticInput: Readonly<{ tool_name: string; arguments: Readonly<Record<string, unknown>> }> = {
    tool_name: "complete_current_stage",
    arguments: {},
  },
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
          name: semanticInput.tool_name,
          arguments: semanticInput.arguments,
          _meta: {
            [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: callId,
            [PROVIDER_PROVENANCE_META_KEY]: provenance,
          },
        },
      },
    }],
  };
}

function providerOutputAtExactUtf8Bytes(
  totalBytes: 4_000 | 4_001,
  multibyte: boolean,
): JsonValue {
  const emptyOutput = { payload: "" };
  const envelopeBytes = Buffer.byteLength(canonicalJson(emptyOutput), "utf8");
  const payloadBytes = totalBytes - envelopeBytes;
  const payload = multibyte
    ? `${"😀".repeat(Math.floor(payloadBytes / 4))}${"a".repeat(payloadBytes % 4)}`
    : "a".repeat(payloadBytes);
  const output = { payload };
  if (Buffer.byteLength(canonicalJson(output), "utf8") !== totalBytes) {
    throw new Error("test fixture did not produce the requested UTF-8 byte length");
  }
  return output;
}

function semanticInputAtExactUtf8Bytes(
  totalBytes: number,
): Readonly<{ tool_name: string; arguments: Readonly<Record<string, unknown>> }> {
  const emptyInput = {
    tool_name: "complete_current_stage",
    arguments: { oversized_model_slot: "" },
  };
  const envelopeBytes = Buffer.byteLength(canonicalJson(emptyInput), "utf8");
  const semanticInput = {
    tool_name: "complete_current_stage",
    arguments: {
      oversized_model_slot: "a".repeat(totalBytes - envelopeBytes),
    },
  };
  if (Buffer.byteLength(canonicalJson(semanticInput), "utf8") !== totalBytes) {
    throw new Error("test fixture did not produce the requested semantic-input byte length");
  }
  return semanticInput;
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

  it("projects internal actions to exact provider aliases and hides internal-only controls", () => {
    expect(lc4DevSemanticIntentsForActions([
      "flow.get_state",
      ...Object.values(LC4_DEV_INTENT_ACTION_MAP),
      "archive.private_future_action",
    ])).toEqual(LC4_DEV_SEMANTIC_INTENTS);
    expect(lc4DevSemanticIntentsForActions(["flow.get_state"])).toEqual([]);
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
    expect(client.operations).toEqual([
      `prepare:${CONTINUATION_CONTROL_SHA256}`,
      "submit:false",
      "create",
    ]);
    expect(client.submitted[0]?.createResponse).toBe(false);
    expect(evidence.receipts).toHaveLength(1);
    expect(JSON.stringify(evidence.receipts)).not.toContain("public_receipt");
    expect(evidence.authority_projections[0]?.provider_output).toEqual({ ok: true, public_receipt: "receipt-1" });
    expect(evidence.receipt_set_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    { bytes: 4_000 as const, multibyte: false, admitted: true },
    { bytes: 4_001 as const, multibyte: false, admitted: false },
    { bytes: 4_000 as const, multibyte: true, admitted: true },
    { bytes: 4_001 as const, multibyte: true, admitted: false },
  ])(
    "enforces the replay-safe $bytes-byte provider-output boundary (multibyte=$multibyte)",
    async ({ bytes, multibyte, admitted }) => {
      const providerOutput = providerOutputAtExactUtf8Bytes(bytes, multibyte);
      const encoded = canonicalJson(providerOutput);
      expect(Buffer.byteLength(encoded, "utf8")).toBe(bytes);
      if (multibyte) expect(encoded.length).toBeLessThan(bytes);

      const client = new FakeClient("openai");
      const inputs: Lc4DevGatewayExecutionInput[] = [];
      const failures: Error[] = [];
      const coordinator = new Lc4DevGatewayTurnCoordinator({
        client,
        executor: executor(inputs, () => providerOutput),
        onFatal: (error) => failures.push(error),
      });
      coordinator.beginOpportunity({ episode: episode("openai", "hacc"), opportunity });
      coordinator.observe(dispatchEvent("openai"));

      if (admitted) {
        await expect(coordinator.finishOpportunity()).resolves.toMatchObject({
          receipts: [expect.objectContaining({
            provider_output_sha256: sha256Hex(encoded),
          })],
        });
        expect(failures).toEqual([]);
        expect(client.operations).toEqual([
          `prepare:${CONTINUATION_CONTROL_SHA256}`,
          "submit:false",
          "create",
        ]);
        expect(client.submitted[0]?.results[0]?.output).toEqual(providerOutput);
      } else {
        await expect(coordinator.finishOpportunity()).rejects.toThrow(
          `exceeds 4000 UTF-8 bytes: actual_bytes=${bytes}`,
        );
        expect(failures).toHaveLength(1);
        expect(client.operations).toEqual([]);
        expect(client.submitted).toEqual([]);
        expect(coordinator.diagnosticSnapshot()).toMatchObject({
          receipt_count: 0,
          authority_projection_count: 0,
          fatal_class: "execution",
        });
      }
      expect(inputs).toHaveLength(1);
    },
  );

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
    expect(client.operations).toEqual([
      `prepare:${CONTINUATION_CONTROL_SHA256}`,
      "submit:false",
      "create",
    ]);
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
    expect(client.operations).toEqual([
      `prepare:${CONTINUATION_CONTROL_SHA256}`,
      "submit:false",
      "create",
      `prepare:${CONTINUATION_CONTROL_SHA256}`,
      "submit:false",
      "create",
    ]);
    expect(client.submitted).toHaveLength(2);
    expect(evidence.receipts.map((receipt) => receipt.batch_ordinal)).toEqual([1, 2]);
  });

  it("returns an ephemeral, lossless replay snapshot with exact delivered batch boundaries", async () => {
    const client = new FakeClient("gemini");
    const inputs: Lc4DevGatewayExecutionInput[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({
      client,
      executor: executor(inputs),
      onFatal: () => undefined,
    });
    coordinator.beginOpportunity({ episode: episode("gemini", "hacc"), opportunity });

    coordinator.observe({
      type: "tool.calls",
      provider: "gemini",
      receivedAtMs: 1,
      wireType: "toolCall",
      responseId: "gemini-replay-response",
      calls: [
        {
          callId: "accepted-call-1",
          name: "capability_gateway",
          argumentsText: JSON.stringify({
            tool_name: "complete_current_stage",
            arguments: {},
          }),
          argumentsJson: {
            tool_name: "complete_current_stage",
            arguments: {},
          },
          responseId: "gemini-replay-response",
          terminalWireType: "toolCall",
        },
        {
          callId: "accepted-call-2",
          name: "capability_gateway",
          argumentsText: JSON.stringify({
            tool_name: "reserve_archive_room",
            arguments: {},
          }),
          argumentsJson: {
            tool_name: "reserve_archive_room",
            arguments: {},
          },
          responseId: "gemini-replay-response",
          terminalWireType: "toolCall",
        },
      ],
    });
    coordinator.observe({
      type: "tool.calls",
      provider: "gemini",
      receivedAtMs: 2,
      wireType: "toolCall",
      responseId: "gemini-replay-response",
      calls: [
        {
          callId: "atomically-rejected-valid-call",
          name: "capability_gateway",
          argumentsText: JSON.stringify({
            tool_name: "complete_current_stage",
            arguments: {},
          }),
          argumentsJson: {
            tool_name: "complete_current_stage",
            arguments: {},
          },
          responseId: "gemini-replay-response",
          terminalWireType: "toolCall",
        },
        {
          callId: "rejected-unknown-call",
          name: "capability_gateway",
          argumentsText: JSON.stringify({
            tool_name: "archive.complete_stage",
            arguments: {},
          }),
          argumentsJson: {
            tool_name: "archive.complete_stage",
            arguments: {},
          },
          responseId: "gemini-replay-response",
          terminalWireType: "toolCall",
        },
      ],
    });

    const finished = await coordinator.finishOpportunityWithConversationReplay();

    expect(inputs.map((input) => input.semantic_intent)).toEqual([
      "complete_current_stage",
      "reserve_archive_room",
    ]);
    expect(finished.conversation_tool_batches.map((batch) => ({
      batch_ordinal: batch.batch_ordinal,
      provider_response_id_sha256: batch.provider_response_id_sha256,
      call_ordinals: batch.calls.map((call) => call.call_ordinal),
    }))).toEqual([
      {
        batch_ordinal: 1,
        provider_response_id_sha256: sha256Hex("gemini-replay-response"),
        call_ordinals: [1, 2],
      },
      {
        batch_ordinal: 2,
        provider_response_id_sha256: sha256Hex("gemini-replay-response"),
        call_ordinals: [1, 2],
      },
    ]);
    expect(finished.conversation_tool_batches.map((batch) =>
      batch.calls.map((call) => call.gateway_tool_name)))
      .toEqual([
        ["capability_gateway", "capability_gateway"],
        ["capability_gateway", "capability_gateway"],
      ]);
    expect(finished.conversation_tool_batches.map((batch) =>
      batch.calls.map((call) => call.model_arguments)))
      .toEqual([
        [
          { arguments: {}, tool_name: "complete_current_stage" },
          { arguments: {}, tool_name: "reserve_archive_room" },
        ],
        [
          { arguments: {}, tool_name: "complete_current_stage" },
          { arguments: {}, tool_name: "archive.complete_stage" },
        ],
      ]);
    expect(finished.conversation_tool_batches.map((batch) =>
      batch.calls.map((call) => ({
        source_kind: call.source_kind,
        source_sha256: call.source_sha256,
        disposition: call.disposition,
        rejection_code: call.pre_dispatch_rejection_code,
      }))))
      .toEqual([
        [
          {
            source_kind: "authority_projection",
            source_sha256: finished.receipt_set.authority_projections[0]?.projection_sha256,
            disposition: "executed",
            rejection_code: null,
          },
          {
            source_kind: "authority_projection",
            source_sha256: finished.receipt_set.authority_projections[1]?.projection_sha256,
            disposition: "executed",
            rejection_code: null,
          },
        ],
        [
          {
            source_kind: "pre_dispatch_rejection",
            source_sha256: finished.receipt_set.pre_dispatch_rejections[0]?.rejection_receipt_sha256,
            disposition: "pre_dispatch_rejected",
            rejection_code: "batch_rejected_invalid_member",
          },
          {
            source_kind: "pre_dispatch_rejection",
            source_sha256: finished.receipt_set.pre_dispatch_rejections[1]?.rejection_receipt_sha256,
            disposition: "pre_dispatch_rejected",
            rejection_code: "unknown_semantic_intent",
          },
        ],
      ]);
    expect(finished.conversation_tool_batches.flatMap((batch) =>
      batch.calls.map((call) => call.provider_output_canonical_json)))
      .toEqual(client.submitted.flatMap((submission) =>
        submission.results.map((result) => canonicalJson(result.output))));

    // The opt-in replay snapshot is ephemeral continuity input. It cannot
    // silently change the public receipt-set schema or its committed digest.
    expect(Object.keys(finished.receipt_set).sort()).toEqual([
      "authority_projections",
      "pre_dispatch_rejections",
      "receipt_set_sha256",
      "receipts",
    ]);
    expect(canonicalJson(finished.receipt_set)).not.toContain("conversation_tool_batches");
    expect(() => assertLc4DevGatewayReceiptSet(finished.receipt_set)).not.toThrow();
    expect(finished.receipt_set.pre_dispatch_rejections.map((rejection, index) => (
      rejection.model_arguments_sha256
        === sha256Hex(canonicalJson(
          finished.conversation_tool_batches[1]!.calls[index]!.model_arguments,
        ))
    ))).toEqual([true, true]);

    const reordered = JSON.parse(canonicalJson(finished.receipt_set)) as {
      receipts: JsonValue[];
      authority_projections: JsonValue[];
      pre_dispatch_rejections: JsonValue[];
      receipt_set_sha256: string;
    };
    reordered.pre_dispatch_rejections.reverse();
    reordered.receipt_set_sha256 = sha256Hex(
      `${RECEIPT_SET_DOMAIN}${canonicalJson({
        receipts: reordered.receipts,
        authority_projections: reordered.authority_projections,
        pre_dispatch_rejections: reordered.pre_dispatch_rejections,
      })}`,
    );
    expect(() => assertLc4DevGatewayReceiptSet(reordered))
      .toThrow("rejection receipt hash, version, or order is invalid");
  });

  it("rejects a 64 KiB + 1 model-argument record before execution or provider delivery", async () => {
    const client = new FakeClient("openai");
    const failures: Error[] = [];
    const inputs: Lc4DevGatewayExecutionInput[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({
      client,
      executor: executor(inputs),
      onFatal: (error) => failures.push(error),
    });
    const oversized = semanticInputAtExactUtf8Bytes(
      LC4_DEV_MAX_REPLAY_MODEL_ARGUMENT_BYTES + 1,
    );
    expect(Buffer.byteLength(canonicalJson(oversized), "utf8"))
      .toBe(LC4_DEV_MAX_REPLAY_MODEL_ARGUMENT_BYTES + 1);
    coordinator.beginOpportunity({ episode: episode("openai", "hacc"), opportunity });
    coordinator.observe(dispatchEvent(
      "openai",
      "oversized-arguments-response",
      "oversized-arguments-call",
      oversized,
    ));

    await expect(coordinator.finishOpportunityWithConversationReplay()).rejects.toThrow(
      `exceed ${LC4_DEV_MAX_REPLAY_MODEL_ARGUMENT_BYTES} UTF-8 bytes`,
    );
    expect(failures).toHaveLength(1);
    expect(inputs).toEqual([]);
    expect(client.operations).toEqual([]);
    expect(client.submitted).toEqual([]);
    expect(coordinator.diagnosticSnapshot()).toMatchObject({
      batch_count: 0,
      receipt_count: 0,
      authority_projection_count: 0,
      rejection_count: 0,
      fatal_class: "parse",
    });
  });

  it("rejects an individually valid but oversized model-argument batch before delivery", async () => {
    const client = new FakeClient("gemini");
    const failures: Error[] = [];
    const inputs: Lc4DevGatewayExecutionInput[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({
      client,
      executor: executor(inputs),
      onFatal: (error) => failures.push(error),
    });
    const perCallBytes = 53_000;
    const argumentsJson = semanticInputAtExactUtf8Bytes(perCallBytes);
    const callCount = 5;
    expect(perCallBytes).toBeLessThan(LC4_DEV_MAX_REPLAY_MODEL_ARGUMENT_BYTES);
    expect(Buffer.byteLength(
      canonicalJson(Array.from({ length: callCount }, () => argumentsJson)),
      "utf8",
    )).toBeGreaterThan(LC4_DEV_MAX_REPLAY_BATCH_ARGUMENT_BYTES);
    coordinator.beginOpportunity({ episode: episode("gemini", "hacc"), opportunity });
    coordinator.observe({
      type: "tool.calls",
      provider: "gemini",
      receivedAtMs: 1,
      wireType: "toolCall",
      responseId: "gemini-oversized-argument-batch",
      calls: Array.from({ length: callCount }, (_, index) => ({
        callId: `gemini-oversized-call-${index + 1}`,
        name: "capability_gateway",
        argumentsText: canonicalJson(argumentsJson),
        argumentsJson,
        responseId: "gemini-oversized-argument-batch",
        terminalWireType: "toolCall",
      })),
    });

    await expect(coordinator.finishOpportunityWithConversationReplay()).rejects.toThrow(
      `batch exceeds ${LC4_DEV_MAX_REPLAY_BATCH_ARGUMENT_BYTES} UTF-8 bytes`,
    );
    expect(failures).toHaveLength(1);
    expect(inputs).toEqual([]);
    expect(client.operations).toEqual([]);
    expect(client.submitted).toEqual([]);
    expect(coordinator.diagnosticSnapshot()).toMatchObject({
      batch_count: 0,
      receipt_count: 0,
      authority_projection_count: 0,
      rejection_count: 0,
      fatal_class: "parse",
    });
  });

  it("fails closed instead of replaying a rejected non-object semantic input", async () => {
    const client = new FakeClient("gemini");
    const failures: Error[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({
      client,
      executor: executor([]),
      onFatal: (error) => failures.push(error),
    });
    coordinator.beginOpportunity({ episode: episode("gemini", "hacc"), opportunity });
    coordinator.observe({
      type: "tool.calls",
      provider: "gemini",
      receivedAtMs: 1,
      wireType: "toolCall",
      responseId: "gemini-non-object-response",
      calls: [{
        callId: "gemini-non-object-call",
        name: "capability_gateway",
        argumentsText: JSON.stringify("not-an-object"),
        argumentsJson: "not-an-object",
        responseId: "gemini-non-object-response",
        terminalWireType: "toolCall",
      }],
    });

    await expect(coordinator.finishOpportunityWithConversationReplay()).rejects.toThrow(
      "gateway model arguments must be a JSON object",
    );
    expect(failures).toHaveLength(1);
    expect(client.submitted).toEqual([]);
    expect(coordinator.diagnosticSnapshot()).toMatchObject({
      batch_count: 0,
      receipt_count: 0,
      authority_projection_count: 0,
      rejection_count: 0,
      fatal_class: "parse",
    });
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
    { provider: "openai" as const, tool_name: "archive.complete_stage", arguments: {}, code: "unknown_semantic_intent" },
    { provider: "xai" as const, tool_name: "complete_current_stage", arguments: { stage_id: "stage.intake" }, code: "model_arguments_forbidden" },
    { provider: "gemini" as const, tool_name: "archive.complete_stage", arguments: {}, code: "unknown_semantic_intent" },
    { provider: "gemini" as const, tool_name: "complete_current_stage", arguments: { stage_id: "stage.intake" }, code: "model_arguments_forbidden" },
  ])("returns a bounded rejection for $provider semantic mistakes without executing", async ({
    provider,
    tool_name,
    arguments: args,
    code,
  }) => {
    const client = new FakeClient(provider);
    const failures: Error[] = [];
    const inputs: Lc4DevGatewayExecutionInput[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({
      client,
      executor: executor(inputs),
      onFatal: (error) => failures.push(error),
    });
    coordinator.beginOpportunity({ episode: episode(provider, "hacc"), opportunity });
    if (provider === "gemini") {
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
    } else {
      coordinator.observe(dispatchEvent(
        provider,
        `${provider}-response-bad`,
        `${provider}-call-bad`,
        { tool_name, arguments: args },
      ));
    }
    const evidence = await coordinator.finishOpportunity();
    expect(failures).toEqual([]);
    expect(inputs).toEqual([]);
    expect(client.operations).toEqual([
      `prepare:${CONTINUATION_CONTROL_SHA256}`,
      "submit:false",
      "create",
    ]);
    expect(client.submitted).toHaveLength(1);
    expect(client.submitted[0]?.results[0]?.output).toMatchObject({
      ok: false,
      code: "capability_request_rejected",
      reason: code,
      executed: false,
      retriable: true,
    });
    expect(evidence.receipts).toEqual([]);
    expect(evidence.authority_projections).toEqual([]);
    expect(evidence.pre_dispatch_rejections).toHaveLength(1);
    expect(evidence.pre_dispatch_rejections[0]).toMatchObject({
      rejection_code: code,
      executor_invoked: false,
      authority_effect: "none",
    });
    expect(JSON.stringify(evidence.pre_dispatch_rejections)).not.toContain(tool_name);
  });

  it("rejects a mixed batch atomically before any valid sibling executes", async () => {
    const client = new FakeClient("gemini");
    const inputs: Lc4DevGatewayExecutionInput[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({
      client,
      executor: executor(inputs),
      onFatal: () => undefined,
    });
    coordinator.beginOpportunity({ episode: episode("gemini", "hacc"), opportunity });
    coordinator.observe({
      type: "tool.calls",
      provider: "gemini",
      receivedAtMs: 1,
      wireType: "toolCall",
      responseId: "gemini-mixed-response",
      calls: [
        {
          callId: "gemini-valid",
          name: "capability_gateway",
          argumentsText: JSON.stringify({ tool_name: "complete_current_stage", arguments: {} }),
          argumentsJson: { tool_name: "complete_current_stage", arguments: {} },
          responseId: "gemini-mixed-response",
          terminalWireType: "toolCall",
        },
        {
          callId: "gemini-invalid",
          name: "capability_gateway",
          argumentsText: JSON.stringify({ tool_name: "archive.complete_stage", arguments: {} }),
          argumentsJson: { tool_name: "archive.complete_stage", arguments: {} },
          responseId: "gemini-mixed-response",
          terminalWireType: "toolCall",
        },
      ],
    });
    const evidence = await coordinator.finishOpportunity();
    expect(inputs).toEqual([]);
    expect(client.submitted[0]?.results.map((result) => result.callId))
      .toEqual(["gemini-valid", "gemini-invalid"]);
    expect(evidence.pre_dispatch_rejections.map((item) => item.rejection_code))
      .toEqual(["batch_rejected_invalid_member", "unknown_semantic_intent"]);
  });

  it("forbids executable tool authority during bounded speech repair", async () => {
    const client = new FakeClient("openai");
    const inputs: Lc4DevGatewayExecutionInput[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({
      client,
      executor: executor(inputs),
      onFatal: () => undefined,
    });
    coordinator.beginOpportunity({
      episode: episode("openai", "hacc"),
      opportunity,
      phase: "repair",
    });
    coordinator.observe(dispatchEvent("openai"));
    const evidence = await coordinator.finishOpportunity();
    expect(inputs).toEqual([]);
    expect(evidence.authority_projections).toEqual([]);
    expect(evidence.pre_dispatch_rejections).toHaveLength(1);
    expect(evidence.pre_dispatch_rejections[0]).toMatchObject({
      phase: "repair",
      rejection_code: "tool_calls_forbidden_during_repair",
      authority_effect: "none",
    });
    expect(client.operations).toEqual([
      `prepare:${CONTINUATION_CONTROL_SHA256}`,
      "submit:false",
      "create",
    ]);
  });

  it("makes a successful post-transition control rebind failure fatal before result delivery", async () => {
    const client = new RebindFailureClient("openai");
    const inputs: Lc4DevGatewayExecutionInput[] = [];
    const failures: Error[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({
      client,
      executor: executor(inputs),
      onFatal: (error) => failures.push(error),
    });
    coordinator.beginOpportunity({ episode: episode("openai", "hacc"), opportunity });
    coordinator.observe(dispatchEvent(
      "openai",
      "response-success-rebind-failure",
      "call-success-rebind-failure",
    ));

    await expect(coordinator.finishOpportunity()).rejects.toThrow(
      "deterministic continuation control rebind failure",
    );
    expect(failures).toHaveLength(1);
    expect(inputs).toHaveLength(1);
    expect(client.operations).toEqual(["prepare:failed"]);
    expect(client.submitted).toEqual([]);
    expect(coordinator.diagnosticSnapshot()).toMatchObject({
      batch_count: 1,
      receipt_count: 1,
      authority_projection_count: 1,
      rejection_count: 0,
      fatal_class: "delivery",
    });
  });

  it("makes continuation-control rebind failure fatal before result delivery or authority projection", async () => {
    const client = new RebindFailureClient("openai");
    const inputs: Lc4DevGatewayExecutionInput[] = [];
    const failures: Error[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({
      client,
      executor: executor(inputs),
      onFatal: (error) => failures.push(error),
    });
    coordinator.beginOpportunity({ episode: episode("openai", "hacc"), opportunity });
    coordinator.observe(dispatchEvent(
      "openai",
      "response-rebind-failure",
      "call-rebind-failure",
      { tool_name: "archive.complete_stage", arguments: {} },
    ));

    await expect(coordinator.finishOpportunity()).rejects.toThrow(
      "deterministic continuation control rebind failure",
    );
    expect(failures).toHaveLength(1);
    expect(inputs).toEqual([]);
    expect(client.operations).toEqual(["prepare:failed"]);
    expect(client.submitted).toEqual([]);
    expect(coordinator.diagnosticSnapshot()).toMatchObject({
      batch_count: 1,
      receipt_count: 0,
      authority_projection_count: 0,
      rejection_count: 1,
      fatal_class: "delivery",
    });
  });

  it("keeps normalized dispatch provenance mismatches fatal", async () => {
    const client = new FakeClient("openai");
    const failures: Error[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({
      client,
      executor: executor([]),
      onFatal: (error) => failures.push(error),
    });
    coordinator.beginOpportunity({ episode: episode("openai", "hacc"), opportunity });
    const original = dispatchEvent("openai") as Extract<
      NormalizedRealtimeEvent,
      { type: "tool.dispatch" }
    >;
    const forged: Extract<NormalizedRealtimeEvent, { type: "tool.dispatch" }> = {
      ...original,
      dispatches: [{
        ...original.dispatches[0]!,
        provenance: {
          ...original.dispatches[0]!.provenance,
          nativeCallId: "forged-call",
        },
      }],
    };
    coordinator.observe(forged);
    await expect(coordinator.finishOpportunity()).rejects.toThrow("provenance is inconsistent");
    expect(failures).toHaveLength(1);
    expect(coordinator.diagnosticSnapshot()).toMatchObject({
      batch_count: 0,
      rejection_count: 0,
      fatal_class: "provenance",
    });
    expect(client.submitted).toEqual([]);
  });

  it("bounds semantic correction loops after three rejected batches", async () => {
    const client = new FakeClient("gemini");
    const failures: Error[] = [];
    const coordinator = new Lc4DevGatewayTurnCoordinator({
      client,
      executor: executor([]),
      onFatal: (error) => failures.push(error),
    });
    coordinator.beginOpportunity({ episode: episode("gemini", "hacc"), opportunity });
    for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
      coordinator.observe({
        type: "tool.calls",
        provider: "gemini",
        receivedAtMs: ordinal,
        wireType: "toolCall",
        responseId: "gemini-response-loop",
        calls: [{
          callId: `gemini-rejected-${ordinal}`,
          name: "capability_gateway",
          argumentsText: JSON.stringify({ tool_name: "archive.complete_stage", arguments: {} }),
          argumentsJson: { tool_name: "archive.complete_stage", arguments: {} },
          responseId: "gemini-response-loop",
          terminalWireType: "toolCall",
        }],
      });
    }
    await expect(coordinator.finishOpportunity()).rejects.toThrow(
      "exceeded three rejected provider tool batches",
    );
    expect(failures).toHaveLength(1);
    expect(client.submitted).toEqual([]);
  });
});

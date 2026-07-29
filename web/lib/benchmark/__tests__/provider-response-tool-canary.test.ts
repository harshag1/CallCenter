import { describe, expect, it } from "vitest";
import {
  executeProviderResponseToolCanary,
  RESPONSE_TOOL_CANARY_PROMPT,
} from "../provider-response-tool-canary";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  RealtimeEventListener,
  RealtimeWireObservationListener,
} from "../../realtime/client/types";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  LOCAL_TOOL_PROXY_FUNCTION_NAME,
  PROVIDER_PROVENANCE_META_KEY,
} from "../../realtime/client/types";

class FakeCanaryClient implements NormalizedRealtimeClient {
  readonly provider;
  state: "idle" | "ready" | "closed" = "idle";
  readonly #events = new Set<RealtimeEventListener>();
  readonly #wire = new Set<RealtimeWireObservationListener>();
  readonly #controlled: boolean;
  readonly #emitDispatch: boolean;
  appendCalls = 0;
  createCalls = 0;
  startCalls = 0;
  prepareCalls = 0;
  commitCalls = 0;
  textTurnCalls = 0;
  readonly textTurns: string[] = [];

  constructor(provider: "openai" | "gemini" | "xai", controlled = true, emitDispatch = provider !== "gemini") {
    this.provider = provider;
    this.#controlled = controlled;
    this.#emitDispatch = emitDispatch;
  }

  async connect(): Promise<void> { this.state = "ready"; }
  close(): void { this.state = "closed"; }
  onEvent(listener: RealtimeEventListener): () => void { this.#events.add(listener); return () => this.#events.delete(listener); }
  onWireEvent(): () => void { return () => undefined; }
  onWireObservation(listener: RealtimeWireObservationListener): () => void { this.#wire.add(listener); return () => this.#wire.delete(listener); }
  appendInputAudio(): void { this.appendCalls += 1; }
  sendTurn(): void { this.appendCalls += 1; }
  submitToolResults(): void { throw new Error("not used"); }
  startActivity(): void { this.startCalls += 1; }
  prepareResponse(): void { this.prepareCalls += 1; }
  commitInputAudio(): void { this.commitCalls += 1; this.emitCall(); }
  createResponse(): void { this.createCalls += 1; this.emitCall(); }
  sendTextTurn(text: string): void {
    this.textTurnCalls += 1;
    this.textTurns.push(text);
    this.emitCall();
  }

  private emitCall(): void {
    queueMicrotask(() => {
      const observation = {
        schemaVersion: 1 as const,
        provider: this.provider,
        direction: "inbound" as const,
        connectionEpoch: 1,
        sequence: 1,
        observedAtMs: 1,
        observedAtMonotonicMs: 1,
        wireType: "response.function_call_arguments.done",
        payloadSha256: "1".repeat(64),
        payloadBytes: 100,
        projectionSha256: "2".repeat(64),
        previousObservationSha256: null,
        observationSha256: "3".repeat(64),
        identities: { callIdSha256: "4".repeat(64) },
        projection: { gatewayCalls: [{ name: "capability_gateway" }] },
      };
      for (const listener of this.#wire) listener(observation);
      for (const listener of this.#events) listener({
        type: "tool.calls",
        provider: this.provider,
        receivedAtMs: 1,
        wireType: "response.function_call_arguments.done",
        responseId: "provider-response-secret",
        wireObservation: {
          availability: "observed",
          connectionEpoch: 1,
          sequence: 1,
          observationSha256: observation.observationSha256,
          payloadSha256: observation.payloadSha256,
          projectionSha256: observation.projectionSha256,
          callIdSha256: observation.identities.callIdSha256,
        },
        calls: [{
          callId: "provider-call-secret",
          name: "capability_gateway",
          argumentsText: this.#controlled
            ? '{"tool_name":"flow.get_state","arguments":{}}'
            : '{"tool_name":"world.place_order","arguments":{}}',
          argumentsJson: this.#controlled
            ? { tool_name: "flow.get_state", arguments: {} }
            : { tool_name: "world.place_order", arguments: {} },
          responseId: "provider-response-secret",
          terminalWireType: "response.function_call_arguments.done",
        }],
      } as NormalizedRealtimeEvent);
      if (this.provider !== "gemini" && this.#emitDispatch) {
        const provenance = Object.freeze({
          schemaVersion: 1 as const,
          provider: this.provider,
          nativeCallId: "provider-call-secret",
          nativeResponseId: "provider-response-secret",
          terminalWireType: "response.function_call_arguments.done",
        });
        for (const listener of this.#events) listener({
          type: "tool.dispatch",
          provider: this.provider,
          receivedAtMs: 1,
          wireType: "response.function_call_arguments.done",
          responseId: "provider-response-secret",
          wireObservation: {
            availability: "observed",
            connectionEpoch: 1,
            sequence: 1,
            observationSha256: observation.observationSha256,
            payloadSha256: observation.payloadSha256,
            projectionSha256: observation.projectionSha256,
            callIdSha256: observation.identities.callIdSha256,
          },
          gateway: LOCAL_TOOL_PROXY_FUNCTION_NAME,
          dispatches: [{
            callId: "provider-call-secret",
            provenance,
            request: {
              method: "tools/call",
              params: {
                name: this.#controlled ? "flow.get_state" : "world.place_order",
                arguments: {},
                _meta: {
                  [LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY]: "provider-call-secret",
                  [PROVIDER_PROVENANCE_META_KEY]: provenance,
                },
              },
            },
          }],
        } as NormalizedRealtimeEvent);
      }
    });
  }
}

describe("paid response/tool-call canary executor", () => {
  it.each(["openai", "xai"] as const)("forces one controlled %s tool call without caller audio", async (provider) => {
    const client = new FakeCanaryClient(provider);
    const result = await executeProviderResponseToolCanary({
      provider,
      model: `${provider}-model`,
      client,
      timeoutMs: 1_000,
      now: () => new Date("2026-07-22T04:00:00.000Z"),
    });
    expect(result).toMatchObject({ status: "passed", code: "gateway_tool_call_observed", callerAudioBytes: 0 });
    expect(result.providerToolCallEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(client.appendCalls).toBe(0);
    expect(client.createCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("provider-call-secret");
    expect(JSON.stringify(result)).not.toContain("provider-response-secret");
  });

  it("uses the Gemini realtime text-turn path without caller audio", async () => {
    const client = new FakeCanaryClient("gemini");
    const result = await executeProviderResponseToolCanary({
      provider: "gemini",
      model: "gemini-model",
      client,
      timeoutMs: 1_000,
    });
    expect(result.status).toBe("passed");
    expect(client.textTurns).toEqual([RESPONSE_TOOL_CANARY_PROMPT]);
    expect(client).toMatchObject({
      textTurnCalls: 1,
      startCalls: 0,
      prepareCalls: 0,
      commitCalls: 0,
      appendCalls: 0,
      createCalls: 0,
    });
  });

  it("fails closed on a different gateway target", async () => {
    const client = new FakeCanaryClient("openai", false, true);
    const result = await executeProviderResponseToolCanary({
      provider: "openai",
      model: "openai-model",
      client,
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({ status: "failed", code: "response_generation_failed", callerAudioBytes: 0 });
    expect(result.providerToolCallEvidenceSha256).toBeNull();
  });

  it("does not accept an OpenAI-compatible raw tool.calls view without provenance-bound dispatch", async () => {
    const client = new FakeCanaryClient("openai", true, false);
    const result = await executeProviderResponseToolCanary({
      provider: "openai",
      model: "openai-model",
      client,
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({ status: "failed", code: "tool_call_not_observed", callerAudioBytes: 0 });
    expect(result.providerToolCallEvidenceSha256).toBeNull();
  });
});

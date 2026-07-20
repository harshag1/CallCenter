import { describe, expect, it } from "vitest";
import { ScriptedFakeRealtimeClient } from "../fake-realtime-client";
import type { NormalizedRealtimeEvent } from "../../realtime/client/types";

describe("ScriptedFakeRealtimeClient provenance", () => {
  it("binds executable tool calls to the exact synthetic response and terminal marker", async () => {
    const events: NormalizedRealtimeEvent[] = [];
    const client = new ScriptedFakeRealtimeClient({
      script: {
        provider: "openai",
        outputFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        turns: [{
          turnId: "turn-1",
          rounds: [{
            toolCalls: [{
              callId: "call-1",
              name: "capability_gateway",
              arguments: { tool_name: "lookup", arguments: { member: "M-1" } },
            }],
          }],
        }],
      },
      now: () => 100,
    });
    client.onEvent((event) => {
      if (event.type === "tool.calls") throw new Error("observer failure");
    });
    client.onEvent((event) => events.push(event));
    await client.connect();
    client.sendTurn({
      encoding: "pcm16",
      sampleRateHz: 16_000,
      channels: 1,
      data: Uint8Array.from([0, 0]),
    });

    const started = events.find((event) => event.type === "response.started");
    const toolBatch = events.find((event) => event.type === "tool.calls");
    expect(started?.type === "response.started" ? started.responseId : undefined)
      .toBe(toolBatch?.type === "tool.calls" ? toolBatch.responseId : undefined);
    expect(toolBatch?.type === "tool.calls" ? toolBatch.calls[0] : undefined).toMatchObject({
      callId: "call-1",
      responseId: "fake-response-1-1",
      terminalWireType: "fake.tool.calls",
      argumentsJson: { tool_name: "lookup", arguments: { member: "M-1" } },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "response.completed",
      responseId: "fake-response-1-1",
      status: "completed",
    }));
    const startedIds = events.flatMap((event) => event.type === "response.started" ? [event.responseId] : []);
    const completedIds = new Set(events.flatMap(
      (event) => event.type === "response.completed" ? [event.responseId] : [],
    ));
    expect(startedIds.every((responseId) => completedIds.has(responseId))).toBe(true);
  });
});

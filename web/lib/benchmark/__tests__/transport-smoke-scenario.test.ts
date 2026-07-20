import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LOCAL_TOOL_PROXY_FUNCTION } from "../../realtime/client/types";
import { canonicalJson } from "../artifacts";
import { compileConditionSuite } from "../condition-compiler";
import { ScriptedFakeRealtimeClient } from "../fake-realtime-client";
import { createInMemoryBenchmarkGatewayKernel } from "../gateway-kernel";
import { createBenchmarkKernelAttestationSigner } from "../kernel-attestation";
import {
  SCENARIO_SOURCE_REGISTRY_HASH,
  resolveScenarioSource,
} from "../scenario-source-registry";
import { createToolWorld, executeTool } from "../tool-world";
import {
  TRANSPORT_SMOKE_GATEWAY_TOOL,
  TRANSPORT_SMOKE_FLOW,
  TRANSPORT_SMOKE_LEAF_TOOL,
  TRANSPORT_SMOKE_SCENARIO,
  TRANSPORT_SMOKE_SERVICE_ID,
  createTransportSmokeFakeScript,
  transportSmokeCompilerInput,
} from "../transport-smoke-scenario";

describe("registered C3 transport smoke", () => {
  it("is a one-turn development-only source bound into the canonical registry", () => {
    const source = resolveScenarioSource(structuredClone(TRANSPORT_SMOKE_SCENARIO));

    expect(source).toMatchObject({
      family: "transport-smoke",
      studyRole: "development",
      executionScope: "c3-transport-smoke-only",
      heldOut: false,
      scenarioId: "transport-smoke-v1",
      scenarioVersion: "1.1.0",
    });
    expect(source.scenario.max_turns).toBe(1);
    expect(source.scenario.caller.turns).toHaveLength(1);
    expect(source.scenario.caller.turns[0].utterance).toBe("Beep. Beep. Beep.");
    expect(source.scenario.tools).toHaveLength(1);
    expect(source.scenario.tools[0]).toMatchObject({
      name: TRANSPORT_SMOKE_LEAF_TOOL,
      kind: "query",
      effects: [],
    });
    expect(TRANSPORT_SMOKE_FLOW.always_tools).toEqual([
      TRANSPORT_SMOKE_LEAF_TOOL,
    ]);
    expect(TRANSPORT_SMOKE_FLOW.always_action_policies).toEqual([
      expect.objectContaining({
        tool: TRANSPORT_SMOKE_LEAF_TOOL,
        max_calls: 1,
        effect: "read",
      }),
    ]);
    expect(source.registryEntryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(SCENARIO_SOURCE_REGISTRY_HASH).toMatch(/^[a-f0-9]{64}$/);
  });

  it("compiles every condition to one native gateway while keeping only the harmless read leaf", () => {
    const suite = compileConditionSuite(transportSmokeCompilerInput());

    expect(suite.semanticLeafTools.map((tool) => tool.name)).toEqual([
      TRANSPORT_SMOKE_LEAF_TOOL,
    ]);
    for (const condition of Object.values(suite.conditions)) {
      expect(condition.providerTools).toEqual([LOCAL_TOOL_PROXY_FUNCTION]);
      expect(condition.providerTools.map((tool) => tool.name)).toEqual([
        TRANSPORT_SMOKE_GATEWAY_TOOL,
      ]);
      expect(canonicalJson(condition.providerTools)).not.toContain(
        "read_service_status"
      );
      expect(canonicalJson(condition.providerTools)).not.toContain(
        "capability_grant"
      );
    }
  });

  it("grants the sole leaf at bootstrap and executes it without flow-control calls", () => {
    const suite = compileConditionSuite(transportSmokeCompilerInput());
    const condition = suite.conditions["full-harness"];
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    const signer = createBenchmarkKernelAttestationSigner({
      keyId: "transport-smoke-test-key",
      privateKeyPem: keys.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }).toString(),
      publicKeyPem,
    });
    const kernel = createInMemoryBenchmarkGatewayKernel({
      flow: TRANSPORT_SMOKE_FLOW,
      expectedFlowHash: suite.flowHash,
      expectedScenarioHash: suite.scenarioHash,
      expectedConditionHash: condition.conditionHash,
      grantBindingHash: suite.sourceHash,
      leaseSubjectId: "pair-transport-smoke",
      evidenceBinding: {
        pairId: "pair-transport-smoke",
        leaseSubjectId: "pair-transport-smoke",
        provider: "offline",
        model: "transport-smoke-emulator-v1",
        planSha256: "1".repeat(64),
        freezeLockSha256: "2".repeat(64),
        kernelBuildSha256: "3".repeat(64),
      },
      signer,
      capabilitySecret:
        "transport-smoke-test-secret-with-more-than-thirty-two-characters",
    });
    const world = createToolWorld(TRANSPORT_SMOKE_SCENARIO);
    const snapshot = kernel.initialize({
      runId: "run-transport-smoke",
      condition,
      scenario: TRANSPORT_SMOKE_SCENARIO,
      world,
    });
    const action = snapshot.actions.find(
      (candidate) => candidate.name === TRANSPORT_SMOKE_LEAF_TOOL
    );
    expect(action).toBeDefined();

    const outcome = kernel.invoke({
      providerCallId: "transport-smoke-call-001",
      call: {
        action: TRANSPORT_SMOKE_LEAF_TOOL,
        arguments: { service_id: TRANSPORT_SMOKE_SERVICE_ID },
        capability_grant: action!.capability_grant,
      },
      capabilityEpoch: snapshot.capability_epoch,
      condition,
      turn: 1,
      world,
      executeLeaf: (request) =>
        executeTool(TRANSPORT_SMOKE_SCENARIO, world, {
          invocation_id: "transport-smoke-invocation-001",
          tool: request.action,
          arguments: request.arguments,
          turn: 1,
        }),
    });

    expect(outcome.result).toMatchObject({
      ok: true,
      action: TRANSPORT_SMOKE_LEAF_TOOL,
      disposition: "executed",
      authoritative_result: {
        service_id: TRANSPORT_SMOKE_SERVICE_ID,
        status: "operational",
      },
    });
    expect(kernel.transcript().entries.map((entry) => entry.operation)).toEqual([
      "initialize",
      "invoke",
    ]);
  });

  it("emulates exactly one gateway call followed by nonempty PCM and a terminal response", async () => {
    const client = new ScriptedFakeRealtimeClient({
      script: createTransportSmokeFakeScript(),
    });
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    client.onEvent((event) => events.push(event));

    await client.connect();
    client.sendTurn({
      encoding: "pcm16",
      sampleRateHz: 24_000,
      channels: 1,
      data: Uint8Array.from([9, 0, 10, 0]),
    });

    const toolEvents = events.filter((event) => event.type === "tool.calls");
    expect(toolEvents).toHaveLength(1);
    const calls = toolEvents[0]?.calls as Array<{
      callId: string;
      name: string;
      argumentsJson: Record<string, unknown>;
    }>;
    expect(calls).toEqual([
      expect.objectContaining({
        callId: "transport-smoke-call-001",
        name: TRANSPORT_SMOKE_GATEWAY_TOOL,
        argumentsJson: {
          tool_name: TRANSPORT_SMOKE_LEAF_TOOL,
          arguments: { service_id: TRANSPORT_SMOKE_SERVICE_ID },
        },
      }),
    ]);

    client.submitToolResults([
      {
        callId: calls[0].callId,
        output: {
          ok: true,
          result: {
            service_id: TRANSPORT_SMOKE_SERVICE_ID,
            status: "operational",
          },
        },
      },
    ]);

    const outputAudio = events.filter((event) => event.type === "output.audio");
    expect(outputAudio).toHaveLength(1);
    expect((outputAudio[0]?.audio as Uint8Array).byteLength).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === "output.transcript")).toEqual([
      expect.objectContaining({
        phase: "final",
        text: "The demo service is operational.",
      }),
    ]);
    expect(events.filter((event) => event.type === "tool.calls")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      status: "completed",
    });
  });
});

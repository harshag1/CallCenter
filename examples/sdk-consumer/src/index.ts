import {
  createTestRuntime,
  defineAgent,
  defineFlow,
  defineScenario,
  defineTool,
  type Validator,
} from "@hacc/core";
import { defineRealtimeProvider } from "@hacc/provider-sdk";

const stringInput: Validator<{ memberId: string }> = {
  parse(value) {
    if (!value || typeof value !== "object" || typeof (value as { memberId?: unknown }).memberId !== "string") {
      throw new TypeError("memberId is required");
    }
    return { memberId: (value as { memberId: string }).memberId };
  },
};

const lookupMembership = defineTool({
  name: "membership.lookup",
  description: "Looks up a membership in the fixture's deterministic tool world.",
  input: stringInput,
  effect: "read",
  execute: ({ memberId }) => ({ memberId, status: "active" as const }),
});

const flow = defineFlow({
  id: "membership-flow",
  version: "1.0.0",
  initial: "classify",
  steps: [
    {
      id: "classify",
      label: "Classify",
      instructions: "Determine why the caller contacted us.",
      transitions: [{ to: "membership" }],
    },
    {
      id: "membership",
      label: "Membership",
      instructions: "Retrieve membership details and answer the caller.",
      tools: ["membership.lookup"],
      toolPolicies: [{ tool: "membership.lookup", maxCalls: 1 }],
      requiredOutputs: ["membership"],
    },
  ],
});

const agent = defineAgent({
  id: "fixture-agent",
  name: "Fixture agent",
  instructions: "Help the caller without inventing account state.",
  flow,
  tools: [lookupMembership],
});

const scenario = defineScenario({
  id: "active-member",
  description: "A member asks for their current status.",
  events: [
    { type: "expect", step: "classify", availableTools: [] },
    { type: "complete" },
    { type: "expect", step: "membership", availableTools: ["membership.lookup"] },
    { type: "tool", name: "membership.lookup", input: { memberId: "member-1" }, saveAs: "membership" },
    { type: "expect", state: { "membership.status": "active" } },
    { type: "complete" },
  ],
});

// Defining a provider is inert. The mock connect function is never called by this offline fixture.
const mockProvider = defineRealtimeProvider({
  manifest: {
    contractVersion: "0.1",
    id: "fixture",
    label: "Fixture provider",
    docsUrl: "https://example.com/realtime",
    transports: ["websocket"],
    inputAudio: { encoding: "pcm-s16le", sampleRateHz: 16_000, channels: 1 },
    outputAudio: { encoding: "pcm-s16le", sampleRateHz: 24_000, channels: 1 },
    capabilities: ["audio-input", "audio-output", "tool-calls"],
  },
  async connect() {
    throw new Error("offline fixture must not connect");
  },
});

let tick = 0;
const runtime = createTestRuntime({ agent, now: () => ++tick });
const result = await runtime.runScenario(scenario);

if (result.currentStepId !== null || result.receipts.length !== 1) {
  throw new Error("offline scenario did not reach its expected terminal state");
}

console.log(JSON.stringify({
  ok: true,
  agent: result.agentId,
  providerDefinition: mockProvider.manifest.id,
  receiptCount: result.receipts.length,
  terminal: result.currentStepId === null,
}));

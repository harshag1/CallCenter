import transportSmokeScenarioJson from "../../../benchmarks/voice-long-horizon/scenarios/transport-smoke-v1.json";
import type { AgentFlow } from "../flow";
import type { FakeRealtimeScript } from "./fake-realtime-client";
import type { CanonicalConditionCompilerInput } from "./condition-compiler";
import { BenchmarkScenarioSchema, type BenchmarkScenario } from "./scenario-schema";

export const TRANSPORT_SMOKE_SCENARIO_ID = "transport-smoke-v1" as const;
export const TRANSPORT_SMOKE_SCENARIO_VERSION = "1.1.0" as const;
export const TRANSPORT_SMOKE_GATEWAY_TOOL = "capability_gateway" as const;
export const TRANSPORT_SMOKE_LEAF_TOOL = "read_service_status" as const;
export const TRANSPORT_SMOKE_SERVICE_ID = "SVC-DEMO-001" as const;

export const TRANSPORT_SMOKE_FLOW: AgentFlow = {
  schema_version: 2,
  tool_exposure: "gateway",
  // The transport smoke measures provider -> gateway -> result transport, not
  // flow classification. Keeping this single read globally available avoids
  // adding flow-control calls to the exactly-one-call C3 cell.
  always_tools: [TRANSPORT_SMOKE_LEAF_TOOL],
  always_action_policies: [
    {
      tool: TRANSPORT_SMOKE_LEAF_TOOL,
      max_calls: 1,
      idempotency: "per_call_arguments",
      effect: "read",
    },
  ],
  max_step_entries: 1,
  nodes: [
    {
      id: "entry",
      label: "Incoming transport smoke",
      kind: "incoming_call",
    },
    {
      id: "transport_smoke",
      label: "Read-only transport smoke",
      kind: "topic",
      context: "This is a bounded development transport check. Use only the synthetic read-only status tool, answer audibly from its result, and stop.",
      tools: [],
      steps: [
        {
          id: "read_status",
          label: "Read the synthetic service status",
          entry: true,
          instructions: "Call read_service_status exactly once for SVC-DEMO-001. After its authoritative result, say whether the service is operational and end the response. Never call a mutation.",
          tools: [],
          required_outputs: ["service_status"],
          output_bindings: [
            {
              output: "service_status",
              tool: TRANSPORT_SMOKE_LEAF_TOOL,
              result_path: "status",
              value_type: "string",
            },
          ],
          success_criteria: [
            "One authoritative read result says status=operational.",
            "The caller hears a nonempty final response grounded in that result.",
          ],
          checkpoint: true,
        },
      ],
    },
  ],
  edges: [
    { from: "entry", to: "transport_smoke", label: "Run the registered smoke" },
  ],
};

export const TRANSPORT_SMOKE_BASE_INSTRUCTIONS = [
  "You are running a one-turn development-only realtime transport compatibility smoke.",
  "The caller input is a registered non-speech three-beep PCM calibration signal; do not treat this cell as speech-recognition or task-effectiveness evidence.",
  "Make exactly one harmless read_service_status call through capability_gateway for SVC-DEMO-001.",
  "Then give one short audible answer grounded in the returned status and stop.",
].join(" ");

export const TRANSPORT_SMOKE_ORACLE_ROUTE = Object.freeze([
  "transport_smoke.read_status",
]);

export function transportSmokeCompilerInput(
  scenarioInput: unknown = transportSmokeScenarioJson
): CanonicalConditionCompilerInput {
  const scenario = BenchmarkScenarioSchema.parse(scenarioInput);
  if (
    scenario.id !== TRANSPORT_SMOKE_SCENARIO_ID
    || scenario.version !== TRANSPORT_SMOKE_SCENARIO_VERSION
  ) {
    throw new Error(
      `expected ${TRANSPORT_SMOKE_SCENARIO_ID}@${TRANSPORT_SMOKE_SCENARIO_VERSION}, received ${scenario.id}@${scenario.version}`
    );
  }
  return {
    scenario,
    flow: TRANSPORT_SMOKE_FLOW,
    baseInstructions: TRANSPORT_SMOKE_BASE_INSTRUCTIONS,
    factDisclosures: [],
    oracleRoute: TRANSPORT_SMOKE_ORACLE_ROUTE,
  };
}

export const TRANSPORT_SMOKE_SCENARIO: BenchmarkScenario =
  BenchmarkScenarioSchema.parse(transportSmokeScenarioJson);

/**
 * Deterministic provider emulator cell for Gate 0 and C3 runner wiring.
 *
 * The first response terminates with exactly one native capability_gateway
 * call. Once the host submits its result, the continuation emits nonempty
 * PCM16 plus a final transcript and a terminal response.completed event.
 */
export function createTransportSmokeFakeScript(
  provider: FakeRealtimeScript["provider"] = "openai"
): FakeRealtimeScript {
  return Object.freeze({
    provider,
    outputFormat: Object.freeze({
      encoding: "pcm16" as const,
      sampleRateHz: 24_000,
      channels: 1 as const,
    }),
    turns: Object.freeze([
      Object.freeze({
        turnId: "turn_01",
        rounds: Object.freeze([
          Object.freeze({
            toolCalls: Object.freeze([
              Object.freeze({
                callId: "transport-smoke-call-001",
                name: TRANSPORT_SMOKE_GATEWAY_TOOL,
                arguments: Object.freeze({
                  tool_name: TRANSPORT_SMOKE_LEAF_TOOL,
                  arguments: Object.freeze({ service_id: TRANSPORT_SMOKE_SERVICE_ID }),
                }),
              }),
            ]),
            usage: Object.freeze({
              inputTextTokens: 1,
              inputAudioTokens: 1,
              outputAudioTokens: 0,
              raw: Object.freeze({ fixture: "transport-smoke-v1/tool-round" }),
            }),
          }),
          Object.freeze({
            transcript: "The demo service is operational.",
            outputAudio: Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0]),
            usage: Object.freeze({
              inputTextTokens: 0,
              inputAudioTokens: 0,
              outputAudioTokens: 1,
              raw: Object.freeze({ fixture: "transport-smoke-v1/final-round" }),
            }),
          }),
        ]),
      }),
    ]),
  });
}

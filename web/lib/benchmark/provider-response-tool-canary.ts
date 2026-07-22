import { canonicalJson, sha256Hex } from "./artifacts";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  NormalizedRealtimeUsage,
  RealtimeWireObservation,
} from "../realtime/client/types";

export const RESPONSE_TOOL_CANARY_PROMPT = [
  "This is a provider tool-path canary, not a caller conversation.",
  "Call capability_gateway exactly once with tool_name flow.get_state and arguments {}.",
  "Do not speak, do not answer in text, and do not call any other tool.",
].join(" ");

export type ResponseToolCanaryExecution = Readonly<{
  provider: LiveStsProvider;
  model: string;
  attemptedAt: string;
  completedAt: string;
  status: "passed" | "failed";
  code: "gateway_tool_call_observed" | "tool_call_not_observed" | "response_generation_failed";
  callerAudioBytes: 0;
  responseGenerationEvidenceSha256: string;
  providerToolCallEvidenceSha256: string | null;
  wireObservations: readonly RealtimeWireObservation[];
  usage: readonly NormalizedRealtimeUsage[];
}>;

type Input = Readonly<{
  provider: LiveStsProvider;
  model: string;
  client: NormalizedRealtimeClient;
  timeoutMs?: number;
  now?: () => Date;
}>;

type GeminiActivityClient = NormalizedRealtimeClient & Readonly<{
  startActivity(): void;
}>;

function sanitizedEvent(event: NormalizedRealtimeEvent): Readonly<Record<string, unknown>> {
  if (event.type === "response.started" || event.type === "response.completed") {
    return Object.freeze({
      type: event.type,
      provider: event.provider,
      responseIdSha256: sha256Hex(event.responseId),
      wireType: event.wireType,
      ...(event.type === "response.completed" ? { status: event.status } : {}),
      wireObservationSha256: event.wireObservation?.availability === "observed"
        ? event.wireObservation.observationSha256
        : null,
    });
  }
  if (event.type === "error") {
    return Object.freeze({ type: event.type, provider: event.provider, code: event.code ?? "provider_error", fatal: event.fatal });
  }
  return Object.freeze({ type: event.type, provider: event.provider, wireType: event.wireType });
}

function controlledGatewayCall(event: NormalizedRealtimeEvent): Readonly<Record<string, unknown>> | null {
  if (event.type !== "tool.calls") return null;
  if (event.wireObservation?.availability !== "observed") return null;
  const matching = event.calls.filter((call) => {
    if (call.name !== "capability_gateway" || call.argumentsJson === null || typeof call.argumentsJson !== "object") return false;
    const args = call.argumentsJson as Record<string, unknown>;
    return args.tool_name === "flow.get_state"
      && args.arguments !== null
      && typeof args.arguments === "object"
      && !Array.isArray(args.arguments)
      && Object.keys(args.arguments as Record<string, unknown>).length === 0;
  });
  if (matching.length !== 1 || event.calls.length !== 1) return null;
  const call = matching[0]!;
  return Object.freeze({
    provider: event.provider,
    responseIdSha256: sha256Hex(event.responseId),
    callIdSha256: sha256Hex(call.callId),
    name: call.name,
    argumentsSha256: sha256Hex(call.argumentsText),
    terminalWireType: call.terminalWireType,
    wireObservationSha256: event.wireObservation.observationSha256,
  });
}

function triggerZeroAudioResponse(provider: LiveStsProvider, client: NormalizedRealtimeClient): void {
  if (provider === "gemini") {
    const gemini = client as GeminiActivityClient;
    if (typeof gemini.startActivity !== "function") throw new Error("Gemini canary requires explicit text-only activity support");
    gemini.startActivity();
    client.prepareResponse({
      additionalInstructions: RESPONSE_TOOL_CANARY_PROMPT,
      contextSha256: sha256Hex(RESPONSE_TOOL_CANARY_PROMPT),
      contextAuthority: "advisory_only_gateway_and_speech_gate_enforced",
    });
    // Gemini begins generation on activityEnd. No appendInputAudio call occurs.
    client.commitInputAudio();
    return;
  }
  client.createResponse({
    instructions: RESPONSE_TOOL_CANARY_PROMPT,
    tool_choice: "required",
  });
}

export async function executeProviderResponseToolCanary(input: Input): Promise<ResponseToolCanaryExecution> {
  const now = input.now ?? (() => new Date());
  const attemptedAt = now().toISOString();
  const timeoutMs = input.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error("response tool canary timeout must be 1000..60000ms");
  }
  const wireObservations: RealtimeWireObservation[] = [];
  const usage: NormalizedRealtimeUsage[] = [];
  const responseEvidence: Readonly<Record<string, unknown>>[] = [];
  let callEvidence: Readonly<Record<string, unknown>> | null = null;
  let terminalFailure = false;
  let finish: (() => void) | null = null;
  const terminal = new Promise<void>((resolve) => { finish = resolve; });
  const unsubscribeWire = input.client.onWireObservation?.((observation) => wireObservations.push(observation));
  const unsubscribeEvent = input.client.onEvent((event) => {
    if (event.type === "usage") usage.push(event.usage);
    if (event.type === "response.started" || event.type === "response.completed" || event.type === "error") {
      responseEvidence.push(sanitizedEvent(event));
    }
    const controlled = controlledGatewayCall(event);
    if (controlled) {
      callEvidence = controlled;
      responseEvidence.push(Object.freeze({
        type: "provider_gateway_tool_call_observed",
        provider: event.provider,
        evidenceSha256: sha256Hex(canonicalJson(controlled)),
      }));
      finish?.();
    } else if (event.type === "tool.calls" || event.type === "response.completed" || (event.type === "error" && event.fatal)) {
      terminalFailure = true;
      finish?.();
    }
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await input.client.connect();
    if (input.client.state !== "ready") throw new Error("provider canary client did not remain ready");
    triggerZeroAudioResponse(input.provider, input.client);
    await Promise.race([
      terminal,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } catch {
    terminalFailure = true;
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribeEvent();
    unsubscribeWire?.();
    input.client.close(1000, "response tool canary complete");
  }
  const status = callEvidence ? "passed" as const : "failed" as const;
  const code = callEvidence
    ? "gateway_tool_call_observed" as const
    : terminalFailure
      ? "response_generation_failed" as const
      : "tool_call_not_observed" as const;
  return Object.freeze({
    provider: input.provider,
    model: input.model,
    attemptedAt,
    completedAt: now().toISOString(),
    status,
    code,
    callerAudioBytes: 0 as const,
    responseGenerationEvidenceSha256: sha256Hex(
      `harshas-amazing-call-center/provider-response-generation-evidence/v1\n${canonicalJson(responseEvidence)}`,
    ),
    providerToolCallEvidenceSha256: callEvidence === null
      ? null
      : sha256Hex(`harshas-amazing-call-center/provider-tool-call-evidence/v1\n${canonicalJson(callEvidence)}`),
    wireObservations: Object.freeze([...wireObservations]),
    usage: Object.freeze([...usage]),
  });
}

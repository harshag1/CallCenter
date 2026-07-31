import { canonicalJson, sha256Hex } from "./artifacts";
import type { LiveStsProvider } from "./live-sts-development-experiment";
import type {
  NormalizedRealtimeClient,
  NormalizedRealtimeEvent,
  NormalizedRealtimeUsage,
  RealtimeWireObservation,
} from "../realtime/client/types";
import {
  LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY,
  LOCAL_TOOL_PROXY_FUNCTION_NAME,
  PROVIDER_PROVENANCE_META_KEY,
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
  if (event.type === "tool.dispatch") {
    if (event.wireObservation?.availability !== "observed") return null;
    if (event.gateway !== LOCAL_TOOL_PROXY_FUNCTION_NAME || event.dispatches.length !== 1) return null;
    const dispatch = event.dispatches[0]!;
    const request = dispatch.request;
    const providerCallId = request.params._meta[LOCAL_PROXY_PROVIDER_CALL_ID_META_KEY];
    const provenance = request.params._meta[PROVIDER_PROVENANCE_META_KEY];
    if (
      request.method !== "tools/call"
      || request.params.name !== "flow.get_state"
      || request.params.arguments === null
      || typeof request.params.arguments !== "object"
      || Array.isArray(request.params.arguments)
      || Object.keys(request.params.arguments).length !== 0
      || providerCallId !== dispatch.callId
      || provenance !== dispatch.provenance
      || dispatch.provenance.nativeCallId !== dispatch.callId
      || dispatch.provenance.nativeResponseId !== event.responseId
    ) return null;
    return Object.freeze({
      evidenceKind: "provenance_bound_tool_dispatch",
      provider: event.provider,
      responseIdSha256: sha256Hex(event.responseId),
      callIdSha256: sha256Hex(dispatch.callId),
      gateway: event.gateway,
      target: request.params.name,
      argumentsSha256: sha256Hex(canonicalJson(request.params.arguments)),
      terminalWireType: dispatch.provenance.terminalWireType,
      wireObservationSha256: event.wireObservation.observationSha256,
      provenanceSha256: sha256Hex(canonicalJson(dispatch.provenance)),
    });
  }
  if (event.type !== "tool.calls") return null;
  // OpenAI-compatible adapters emit a stronger, host-authored tool.dispatch
  // immediately after their raw normalized call. Waiting for it proves that
  // provider IDs and the exact gateway request were bound before success.
  if (event.provider === "openai" || event.provider === "xai") return null;
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
    evidenceKind: "provider_tool_calls_without_dispatch_adapter",
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
    if (typeof client.sendTextTurn !== "function") throw new Error("Gemini canary requires provider-native text-turn support");
    // clientContent.turnComplete is the official zero-audio text generation
    // trigger. realtimeInput.text inside an empty audio activity can remain
    // silent and therefore must not be used for this canary.
    client.sendTextTurn(RESPONSE_TOOL_CANARY_PROMPT);
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
    } else if (
      event.type === "tool.dispatch"
      || (event.type === "tool.calls" && event.provider === "gemini")
      || event.type === "response.completed"
      || (event.type === "error" && event.fatal)
    ) {
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

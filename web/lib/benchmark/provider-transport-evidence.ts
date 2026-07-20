import { canonicalJson, sha256Hex } from "./artifacts";
import type { TrialLimits } from "./orchestrator";
import type {
  NormalizedRealtimeUsage,
  RealtimeWireObservation,
  RealtimeWireObservationAttribution,
  ServerRealtimeProvider,
  SessionConfigurationAcknowledgement,
} from "../realtime/client/types";
import { verifyRealtimeWireObservationChain } from "../realtime/client/wire-evidence";

export type ProviderNormalizedWireLink = Readonly<{
  normalized_sequence: number;
  normalized_type: string;
  wire_type: string;
  attribution: RealtimeWireObservationAttribution;
}>;

export type ProviderPcmEvidence = Readonly<{
  ordinal: number;
  byte_length: number;
  sha256: string;
  sample_rate_hz: number;
  channels: 1;
  encoding: "pcm16";
}>;

export type ProviderTransportEvidence = Readonly<{
  schema_version: 1;
  evidence_class: "provider_transport_compatibility";
  provider: ServerRealtimeProvider;
  model_sha256: string;
  session: Readonly<{
    ready: boolean;
    session_id_sha256?: string;
    configuration: SessionConfigurationAcknowledgement | null;
  }>;
  wire: Readonly<{
    observation_count: number;
    chain_head_sha256: string | null;
    chain_valid: boolean;
    directions: readonly ("inbound" | "outbound")[];
    normalized_links: readonly ProviderNormalizedWireLink[];
    normalized_observed_count: number;
    normalized_unavailable_count: number;
  }>;
  audio: Readonly<{
    input: readonly ProviderPcmEvidence[];
    output: readonly ProviderPcmEvidence[];
    input_wire_frames: number;
    output_wire_frames: number;
    input_total_bytes: number;
    output_total_bytes: number;
  }>;
  gateway: Readonly<{
    normalized_call_count: number;
    kernel_invocation_count: number;
    wire_call_count: number;
    wire_result_count: number;
    matched_call_id_count: number;
  }>;
  usage: Readonly<{
    normalized_event_count: number;
    wire_event_count: number;
    status:
      | "provider_reported"
      | "xai_client_measured_from_wire_pcm"
      | "missing_no_registered_absence_rule";
    observations_sha256: string;
  }>;
  terminal: Readonly<{
    normalized_event_count: number;
    wire_event_count: number;
    completed: boolean;
  }>;
  hard_caps: Readonly<{
    limits: TrialLimits;
    observed: Readonly<{
      input_audio_bytes: number;
      output_audio_bytes: number;
      tool_calls: number;
      elapsed_ms: number;
    }>;
    within_limits: boolean;
  }>;
  gemini_provider_transcription: "disabled" | "not_applicable" | "unverified";
  gate1_transport_smoke: Readonly<{
    eligible: boolean;
    errors: readonly string[];
    claim_boundary: "transport_compatibility_only";
  }>;
}>;

type BuildProviderTransportEvidenceInput = Readonly<{
  provider: ServerRealtimeProvider;
  model: string;
  sessionReady: boolean;
  sessionIdSha256?: string;
  sessionConfiguration: SessionConfigurationAcknowledgement | null;
  wireObservations: readonly RealtimeWireObservation[];
  normalizedLinks: readonly ProviderNormalizedWireLink[];
  inputAudio: readonly ProviderPcmEvidence[];
  outputAudio: readonly ProviderPcmEvidence[];
  normalizedToolCallCount: number;
  kernelInvocationCount: number;
  usage: readonly NormalizedRealtimeUsage[];
  normalizedTerminalCount: number;
  limits: TrialLimits;
  elapsedMs: number;
}>;

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => (
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
    ))
    : [];
}

function projectionRecords(
  observations: readonly RealtimeWireObservation[],
  key: "gatewayCalls" | "gatewayResults",
): readonly Record<string, unknown>[] {
  return observations.flatMap((observation) => records(observation.projection[key]));
}

function audioProjection(observation: RealtimeWireObservation): Record<string, unknown> | null {
  const audio = observation.projection.audio;
  return audio !== null && typeof audio === "object" && !Array.isArray(audio)
    ? audio as Record<string, unknown>
    : null;
}

function projectedAudioDirection(
  observation: RealtimeWireObservation,
): "input" | "output" | null {
  const audio = audioProjection(observation);
  if (!audio) return null;
  if (audio.direction === "input" || audio.direction === "output") return audio.direction;
  if (observation.wireType === "input_audio_buffer.append") return "input";
  if (
    observation.wireType === "response.output_audio.delta"
    || observation.wireType === "response.audio.delta"
  ) return "output";
  return null;
}

function wireTerminal(observation: RealtimeWireObservation): boolean {
  const terminal = observation.projection.terminal;
  return terminal !== null && typeof terminal === "object" && !Array.isArray(terminal);
}

function wireUsage(observation: RealtimeWireObservation): boolean {
  const usage = observation.projection.usage;
  return usage !== null && typeof usage === "object" && !Array.isArray(usage);
}

function sessionProjection(
  observation: RealtimeWireObservation,
): Record<string, unknown> | null {
  const session = observation.projection.session;
  return session !== null && typeof session === "object" && !Array.isArray(session)
    ? session as Record<string, unknown>
    : null;
}

function sessionFieldHashes(
  observations: readonly RealtimeWireObservation[],
  direction: "inbound" | "outbound",
): Set<string> {
  const hashes = new Set<string>();
  for (const observation of observations) {
    if (observation.direction !== direction) continue;
    const session = sessionProjection(observation);
    const fields = session?.fieldSha256;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) continue;
    for (const hash of Object.values(fields as Record<string, unknown>)) {
      if (typeof hash === "string") hashes.add(hash);
    }
  }
  return hashes;
}

function normalizedPointersValid(
  observations: readonly RealtimeWireObservation[],
  links: readonly ProviderNormalizedWireLink[],
): boolean {
  const bySequence = new Map(observations.map((observation) => [observation.sequence, observation]));
  return links.every((link) => {
    if (link.attribution.availability === "unavailable") return true;
    const observation = bySequence.get(link.attribution.sequence);
    return observation !== undefined
      && observation.connectionEpoch === link.attribution.connectionEpoch
      && observation.wireType === link.wire_type
      && observation.observationSha256 === link.attribution.observationSha256
      && observation.payloadSha256 === link.attribution.payloadSha256
      && observation.projectionSha256 === link.attribution.projectionSha256
      && (
        link.attribution.callIdSha256 === undefined
        || link.attribution.callIdSha256 === observation.identities.callIdSha256
      );
  });
}

function geminiTranscriptionStatus(
  provider: ServerRealtimeProvider,
  observations: readonly RealtimeWireObservation[],
): ProviderTransportEvidence["gemini_provider_transcription"] {
  if (provider !== "gemini") return "not_applicable";
  const setup = observations.find((observation) => (
    observation.direction === "outbound" && observation.wireType === "setup"
  ));
  if (!setup) return "unverified";
  const session = setup.projection.session;
  if (session === null || typeof session !== "object" || Array.isArray(session)) return "unverified";
  const policy = (session as Record<string, unknown>).providerTranscriptionPolicy;
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) return "unverified";
  const record = policy as Record<string, unknown>;
  return record.input === "disabled" && record.output === "disabled" ? "disabled" : "unverified";
}

function configurationErrors(
  provider: ServerRealtimeProvider,
  configuration: SessionConfigurationAcknowledgement | null,
): string[] {
  if (!configuration) return ["session_configuration_missing"];
  const errors: string[] = [];
  if (Object.values(configuration.fields).some((field) => field.status === "mismatch")) {
    errors.push("session_configuration_mismatch");
  }
  if (provider === "gemini") {
    if (configuration.strictParityVerified || configuration.paidBenchmarkReady) {
      errors.push("gemini_configuration_claim_overstated");
    }
    for (const [field, proof] of Object.entries(configuration.fields)) {
      if (proof.status !== "unverifiable" && proof.status !== "not_requested") {
        errors.push(`gemini_${field}_must_remain_unverifiable`);
      }
    }
  } else if (!configuration.strictParityVerified || !configuration.paidBenchmarkReady) {
    errors.push("provider_configuration_parity_not_verified");
  }
  return errors;
}

export function buildProviderTransportEvidence(
  input: BuildProviderTransportEvidenceInput,
): ProviderTransportEvidence {
  const chain = verifyRealtimeWireObservationChain(input.wireObservations);
  const directions = [...new Set(input.wireObservations.map((event) => event.direction))].sort() as Array<
    "inbound" | "outbound"
  >;
  const calls = projectionRecords(input.wireObservations, "gatewayCalls");
  const results = projectionRecords(input.wireObservations, "gatewayResults");
  const callIds = new Set(calls.flatMap((entry) => (
    typeof entry.callIdSha256 === "string" ? [entry.callIdSha256] : []
  )));
  const resultIds = new Set(results.flatMap((entry) => (
    typeof entry.callIdSha256 === "string" ? [entry.callIdSha256] : []
  )));
  const wireCallCount = callIds.size + calls.filter((entry) => typeof entry.callIdSha256 !== "string").length;
  const wireResultCount = resultIds.size + results.filter(
    (entry) => typeof entry.callIdSha256 !== "string",
  ).length;
  const matchedCallIdCount = [...callIds].filter((id) => resultIds.has(id)).length;
  const inputTotal = input.inputAudio.reduce((sum, entry) => sum + entry.byte_length, 0);
  const outputTotal = input.outputAudio.reduce((sum, entry) => sum + entry.byte_length, 0);
  const geminiProviderTranscription = geminiTranscriptionStatus(input.provider, input.wireObservations);
  const errors = configurationErrors(input.provider, input.sessionConfiguration);
  if (!input.sessionReady) errors.push("session_readiness_missing");
  if (!chain.valid || chain.eventCount === 0) errors.push("wire_observation_chain_invalid_or_empty");
  if (!directions.includes("inbound") || !directions.includes("outbound")) {
    errors.push("bidirectional_wire_evidence_missing");
  }
  if (!normalizedPointersValid(input.wireObservations, input.normalizedLinks)) {
    errors.push("normalized_event_wire_pointer_invalid");
  }
  const providerDerivedTypes = new Set([
    "session.ready",
    "output.audio",
    "tool.calls",
    "response.completed",
  ]);
  if (input.normalizedLinks.some((link) => (
    link.attribution.availability === "unavailable"
    && (
      link.attribution.reason === "legacy_adapter"
      || providerDerivedTypes.has(link.normalized_type)
    )
  ))) {
    errors.push("normalized_event_wire_pointer_missing");
  }
  for (const requiredType of [
    ...(input.sessionReady ? ["session.ready"] : []),
    ...(input.normalizedToolCallCount > 0 ? ["tool.calls"] : []),
    ...(input.outputAudio.length > 0 ? ["output.audio"] : []),
    ...(input.normalizedTerminalCount > 0 ? ["response.completed"] : []),
  ]) {
    if (!input.normalizedLinks.some((link) => (
      link.normalized_type === requiredType && link.attribution.availability === "observed"
    ))) {
      if (!errors.includes("normalized_event_wire_pointer_missing")) {
        errors.push("normalized_event_wire_pointer_missing");
      }
      break;
    }
  }
  if (input.sessionIdSha256 && !input.wireObservations.some(
    (observation) => observation.identities.sessionIdSha256 === input.sessionIdSha256,
  )) {
    errors.push("session_identity_not_wire_bound");
  }
  if (input.provider === "gemini") {
    if (
      !input.wireObservations.some((entry) => entry.direction === "outbound" && entry.wireType === "setup")
      || !input.wireObservations.some(
        (entry) => entry.direction === "inbound" && entry.wireType === "setupComplete",
      )
    ) errors.push("gemini_setup_acknowledgement_not_wire_bound");
  } else if (input.sessionConfiguration) {
    const requestedHashes = sessionFieldHashes(input.wireObservations, "outbound");
    const acknowledgedHashes = sessionFieldHashes(input.wireObservations, "inbound");
    for (const proof of Object.values(input.sessionConfiguration.fields)) {
      if (proof.requestedSha256 && !requestedHashes.has(proof.requestedSha256)) {
        errors.push("session_requested_configuration_not_wire_bound");
        break;
      }
    }
    for (const proof of Object.values(input.sessionConfiguration.fields)) {
      if (proof.acknowledgedSha256 && !acknowledgedHashes.has(proof.acknowledgedSha256)) {
        errors.push("session_acknowledged_configuration_not_wire_bound");
        break;
      }
    }
  }
  if (inputTotal <= 0 || input.inputAudio.length === 0) errors.push("input_pcm_missing");
  if (outputTotal <= 0 || input.outputAudio.length === 0) errors.push("output_pcm_missing");
  const inputWireFrames = input.wireObservations.filter((entry) => projectedAudioDirection(entry) === "input").length;
  const outputWireFrames = input.wireObservations.filter((entry) => projectedAudioDirection(entry) === "output").length;
  if (inputWireFrames === 0) errors.push("input_pcm_wire_evidence_missing");
  if (outputWireFrames === 0) errors.push("output_pcm_wire_evidence_missing");
  if (
    input.normalizedToolCallCount !== 1
    || input.kernelInvocationCount !== 1
    || wireCallCount !== 1
    || wireResultCount !== 1
    || matchedCallIdCount !== 1
  ) errors.push("exactly_one_gateway_roundtrip_not_proven");
  const wireUsageCount = input.wireObservations.filter(wireUsage).length;
  const xaiClientMeasuredUsage = input.provider === "xai"
    && input.usage.length > 0
    && input.usage.every((usage) => (
      usage.meteringSource === "client_measured" || usage.meteringSource === "mixed"
    ))
    && inputWireFrames > 0
    && outputWireFrames > 0;
  if (input.usage.length === 0 || (wireUsageCount === 0 && !xaiClientMeasuredUsage)) {
    errors.push("usage_evidence_missing");
  }
  const wireTerminalCount = input.wireObservations.filter(wireTerminal).length;
  if (input.normalizedTerminalCount === 0 || wireTerminalCount === 0) errors.push("terminal_response_evidence_missing");
  if (input.provider === "gemini" && geminiProviderTranscription !== "disabled") {
    errors.push("gemini_provider_transcription_not_disabled");
  }
  const withinLimits = inputTotal <= input.limits.maxInputAudioBytes
    && outputTotal <= input.limits.maxOutputAudioBytes
    && input.kernelInvocationCount <= input.limits.maxToolCalls
    && input.elapsedMs <= input.limits.maxSessionMs;
  if (!withinLimits) errors.push("hard_cap_exceeded");

  return Object.freeze({
    schema_version: 1 as const,
    evidence_class: "provider_transport_compatibility" as const,
    provider: input.provider,
    model_sha256: sha256Hex(`harshas-amazing-call-center/provider-model/v1\n${input.model}`),
    session: Object.freeze({
      ready: input.sessionReady,
      ...(input.sessionIdSha256 ? { session_id_sha256: input.sessionIdSha256 } : {}),
      configuration: input.sessionConfiguration,
    }),
    wire: Object.freeze({
      observation_count: chain.eventCount,
      chain_head_sha256: chain.chainHead,
      chain_valid: chain.valid,
      directions: Object.freeze(directions),
      normalized_links: Object.freeze([...input.normalizedLinks]),
      normalized_observed_count: input.normalizedLinks.filter(
        (link) => link.attribution.availability === "observed",
      ).length,
      normalized_unavailable_count: input.normalizedLinks.filter(
        (link) => link.attribution.availability === "unavailable",
      ).length,
    }),
    audio: Object.freeze({
      input: Object.freeze([...input.inputAudio]),
      output: Object.freeze([...input.outputAudio]),
      input_wire_frames: inputWireFrames,
      output_wire_frames: outputWireFrames,
      input_total_bytes: inputTotal,
      output_total_bytes: outputTotal,
    }),
    gateway: Object.freeze({
      normalized_call_count: input.normalizedToolCallCount,
      kernel_invocation_count: input.kernelInvocationCount,
      wire_call_count: wireCallCount,
      wire_result_count: wireResultCount,
      matched_call_id_count: matchedCallIdCount,
    }),
    usage: Object.freeze({
      normalized_event_count: input.usage.length,
      wire_event_count: wireUsageCount,
      status: input.usage.length > 0 && wireUsageCount > 0
        ? "provider_reported" as const
        : xaiClientMeasuredUsage
          ? "xai_client_measured_from_wire_pcm" as const
          : "missing_no_registered_absence_rule" as const,
      observations_sha256: sha256Hex(canonicalJson(input.usage)),
    }),
    terminal: Object.freeze({
      normalized_event_count: input.normalizedTerminalCount,
      wire_event_count: wireTerminalCount,
      completed: input.normalizedTerminalCount > 0 && wireTerminalCount > 0,
    }),
    hard_caps: Object.freeze({
      limits: input.limits,
      observed: Object.freeze({
        input_audio_bytes: inputTotal,
        output_audio_bytes: outputTotal,
        tool_calls: input.kernelInvocationCount,
        elapsed_ms: input.elapsedMs,
      }),
      within_limits: withinLimits,
    }),
    gemini_provider_transcription: geminiProviderTranscription,
    gate1_transport_smoke: Object.freeze({
      eligible: errors.length === 0,
      errors: Object.freeze(errors),
      claim_boundary: "transport_compatibility_only" as const,
    }),
  });
}

export type ProviderTransportEvidenceVerification = Readonly<{
  valid: boolean;
  errors: readonly string[];
}>;

/**
 * Recomputes the complete compatibility packet from its persisted components.
 * The caller must supply the usage observations reopened from `usage.json`;
 * accepting the packet's own `eligible` Boolean would make Gate 1 self-attested.
 */
export function verifyProviderTransportEvidence(input: Readonly<{
  evidence: ProviderTransportEvidence;
  wireObservations: readonly RealtimeWireObservation[];
  usage: readonly NormalizedRealtimeUsage[];
  provider: ServerRealtimeProvider;
  model: string;
}>): ProviderTransportEvidenceVerification {
  const errors: string[] = [];
  try {
    if (
      input.evidence.schema_version !== 1
      || input.evidence.evidence_class !== "provider_transport_compatibility"
    ) {
      errors.push("unsupported_provider_transport_evidence");
    }
    if (input.evidence.provider !== input.provider) errors.push("provider_identity_mismatch");
    const expected = buildProviderTransportEvidence({
      provider: input.provider,
      model: input.model,
      sessionReady: input.evidence.session.ready,
      ...(input.evidence.session.session_id_sha256
        ? { sessionIdSha256: input.evidence.session.session_id_sha256 }
        : {}),
      sessionConfiguration: input.evidence.session.configuration,
      wireObservations: input.wireObservations,
      normalizedLinks: input.evidence.wire.normalized_links,
      inputAudio: input.evidence.audio.input,
      outputAudio: input.evidence.audio.output,
      normalizedToolCallCount: input.evidence.gateway.normalized_call_count,
      kernelInvocationCount: input.evidence.gateway.kernel_invocation_count,
      usage: input.usage,
      normalizedTerminalCount: input.evidence.terminal.normalized_event_count,
      limits: input.evidence.hard_caps.limits,
      elapsedMs: input.evidence.hard_caps.observed.elapsed_ms,
    });
    if (canonicalJson(expected) !== canonicalJson(input.evidence)) {
      errors.push("provider_transport_evidence_recomputation_mismatch");
    }
  } catch {
    errors.push("provider_transport_evidence_malformed");
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

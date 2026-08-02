import { createHash } from "node:crypto";
import {
  REALTIME_LIFECYCLE_CONFORMANCE_VERSION,
  type AcknowledgedSessionConfiguration,
  type LifecycleEvidence,
  type RealtimeLifecycleConformanceMode,
  type RealtimeLifecycleConformanceOptions,
  type RealtimeLifecycleConformanceReport,
  type RealtimeLifecycleEvent,
  type RealtimeLifecycleExercise,
  type RealtimeLifecycleSnapshot,
  type RealtimeLifecycleViolation,
  type RealtimeLifecycleViolationCode,
  type RequestedSessionConfiguration,
} from "./types";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

type TurnState = { status: "open" | "terminal" };
type ResponseState = {
  turnId: string;
  status: "open" | "terminal";
  lastAudioSequence: number;
  audioDurationMs: number;
};
type ToolCallState = {
  turnId: string;
  responseId: string;
  resultId?: string;
  acknowledged: boolean;
  cancelled: boolean;
};
type UsageState = {
  inputTextTokens: number;
  inputAudioTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
  totalTokens: number;
};

const FEATURE_IDS = new Set([
  "audio_input",
  "audio_output",
  "tool_calls",
  "interruption",
  "session_resumption",
  "provider_usage",
]);
const FEATURE_REQUIREMENTS = new Set(["required", "preferred", "disabled"]);
const FEATURE_STATUSES = new Set(["enabled", "unsupported", "disabled"]);
const RESPONSE_TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed", "incomplete", "interrupted"]);
const TURN_TERMINAL_STATUSES = new Set(["completed", "abandoned", "failed"]);
const SESSION_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TRANSPORTS = new Set(["websocket", "webrtc", "webtransport"]);
const TURN_TRIGGERS = new Set(["audio_commit", "client_content", "tool_result"]);
const MODES = new Set<RealtimeLifecycleConformanceMode>(["configuration_only", "transport_media", "paid_readiness"]);

const FEATURE_EXERCISE = Object.freeze({
  audio_input: "audio_input",
  audio_output: "audio_output",
  tool_calls: "tool_round_trip",
  interruption: "interruption",
  session_resumption: "session_resumption",
  provider_usage: "provider_usage",
} satisfies Record<string, RealtimeLifecycleExercise>);

function validId(value: unknown): value is string {
  return typeof value === "string" && IDENTITY.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function canonicalFrameBytes(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function cloneRequested(value: RequestedSessionConfiguration): RequestedSessionConfiguration {
  return Object.freeze({
    model: value.model,
    voice: value.voice,
    settingsSha256: value.settingsSha256,
    features: Object.freeze(value.features.map((feature) => Object.freeze({ ...feature }))),
  });
}

function cloneAcknowledged(value: AcknowledgedSessionConfiguration): AcknowledgedSessionConfiguration {
  return Object.freeze({
    model: value.model,
    voice: value.voice,
    settingsSha256: value.settingsSha256,
    features: Object.freeze(value.features.map((feature) => Object.freeze({ ...feature }))),
  });
}

/**
 * Fail-closed provider lifecycle validator. It deliberately retains violations
 * instead of throwing so a complete trace can be quarantined and audited.
 */
export class RealtimeLifecycleConformanceValidator {
  private readonly mode: RealtimeLifecycleConformanceMode;
  private eventCount = 0;
  private phase: RealtimeLifecycleSnapshot["phase"] = "new";
  private providerId: string | null = null;
  private logicalSessionId: string | null = null;
  private connectionId: string | null = null;
  private connectionEpoch: number | null = null;
  private providerSessionId: string | null = null;
  private requestedConfiguration: RequestedSessionConfiguration | null = null;
  private acknowledgedConfiguration: AcknowledgedSessionConfiguration | null = null;
  private pendingRequestId: string | null = null;
  private disconnectedConnectionId: string | null = null;
  private disconnectedWasResumable = false;
  private pendingResumeRequestId: string | null = null;
  private readonly turns = new Map<string, TurnState>();
  private readonly responses = new Map<string, ResponseState>();
  private readonly tools = new Map<string, ToolCallState>();
  private readonly resultIds = new Set<string>();
  private readonly audioDeltaIds = new Set<string>();
  private readonly providerEventIds = new Map<string, string>();
  private readonly lastFrameSequenceBySocket = new Map<string, number>();
  private readonly usage = new Map<string, UsageState>();
  private readonly observedExercises = new Set<RealtimeLifecycleExercise>();
  private readonly violations: RealtimeLifecycleViolation[] = [];

  constructor(options: RealtimeLifecycleConformanceOptions = {}) {
    const mode = options.mode ?? "paid_readiness";
    if (!MODES.has(mode)) throw new Error(`unsupported realtime lifecycle conformance mode ${String(mode)}`);
    this.mode = mode;
  }

  push(event: RealtimeLifecycleEvent): readonly RealtimeLifecycleViolation[] {
    const index = this.eventCount;
    this.eventCount += 1;
    const before = this.violations.length;

    if (event.schemaVersion !== REALTIME_LIFECYCLE_CONFORMANCE_VERSION) {
      this.violate(index, event, "invalid_event", "unsupported lifecycle schema version");
      return this.addedViolations(before);
    }
    if (!validId(event.providerId) || !validId(event.logicalSessionId)
      || !validId(event.connectionId) || !Number.isInteger(event.connectionEpoch)
      || event.connectionEpoch < 0 || !Number.isFinite(event.occurredAtMs)) {
      this.violate(index, event, "invalid_event", "event has invalid base identity or timestamp");
      return this.addedViolations(before);
    }
    if (this.providerId !== null && this.providerId !== event.providerId) {
      this.violate(index, event, "identity_conflict", "providerId changed within one lifecycle trace");
    }
    if (this.logicalSessionId !== null && this.logicalSessionId !== event.logicalSessionId) {
      this.violate(index, event, "identity_conflict", "logicalSessionId changed within one lifecycle trace");
    }
    this.providerId ??= event.providerId;
    this.logicalSessionId ??= event.logicalSessionId;

    if (event.type !== "connection.opened") {
      if (this.connectionId === null) {
        this.violate(index, event, "invalid_lifecycle_order", "event arrived before connection.opened");
      } else if (event.connectionId !== this.connectionId || event.connectionEpoch !== this.connectionEpoch) {
        this.violate(index, event, "stale_connection_epoch", "event does not belong to the active connection epoch");
      }
    }

    switch (event.type) {
      case "connection.opened":
        this.openConnection(index, event);
        break;
      case "session.configuration.requested":
        this.requestConfiguration(index, event);
        break;
      case "session.configuration.acknowledged":
        this.acknowledgeConfiguration(index, event);
        break;
      case "turn.started":
        this.startTurn(index, event);
        break;
      case "response.started":
        this.startResponse(index, event);
        break;
      case "response.audio.delta":
        this.recordAudio(index, event);
        break;
      case "tool.call.completed":
        this.completeToolCall(index, event);
        break;
      case "tool.result.submitted":
        this.submitToolResult(index, event);
        break;
      case "tool.result.acknowledged":
        this.acknowledgeToolResult(index, event);
        break;
      case "tool.call.cancelled":
        this.cancelToolCall(index, event);
        break;
      case "usage.reported":
        this.recordUsage(index, event);
        break;
      case "response.terminal":
        this.terminateResponse(index, event);
        break;
      case "turn.terminal":
        this.terminateTurn(index, event);
        break;
      case "connection.disconnected":
        this.disconnect(index, event);
        break;
      case "session.resume.requested":
        this.requestResume(index, event);
        break;
      case "session.resume.acknowledged":
        this.acknowledgeResume(index, event);
        break;
      case "session.terminal":
        this.terminateSession(index, event);
        break;
    }
    return this.addedViolations(before);
  }

  report(): RealtimeLifecycleConformanceReport {
    const snapshot = this.snapshot();
    return Object.freeze({
      contractVersion: REALTIME_LIFECYCLE_CONFORMANCE_VERSION,
      providerId: this.providerId ?? "unknown",
      logicalSessionId: this.logicalSessionId ?? "unknown",
      passed: this.violations.length === 0 && this.phase === "terminal",
      paidReady: this.violations.length === 0 && this.phase === "terminal" && this.mode === "paid_readiness",
      eventCount: this.eventCount,
      snapshot,
    });
  }

  snapshot(): RealtimeLifecycleSnapshot {
    return Object.freeze({
      providerId: this.providerId ?? "unknown",
      logicalSessionId: this.logicalSessionId ?? "unknown",
      phase: this.violations.length ? "invalid" : this.phase,
      connectionId: this.connectionId,
      connectionEpoch: this.connectionEpoch,
      providerSessionId: this.providerSessionId,
      requestedConfiguration: this.requestedConfiguration,
      acknowledgedConfiguration: this.acknowledgedConfiguration,
      openTurnIds: Object.freeze([...this.turns].filter(([, value]) => value.status === "open").map(([id]) => id).sort()),
      openResponseIds: Object.freeze([...this.responses].filter(([, value]) => value.status === "open").map(([id]) => id).sort()),
      completedToolCallIds: Object.freeze([...this.tools.keys()].sort()),
      acknowledgedToolResultIds: Object.freeze([...this.tools.values()]
        .filter((tool) => tool.acknowledged && tool.resultId)
        .map((tool) => tool.resultId!)
        .sort()),
      conformanceMode: this.mode,
      observedExercises: Object.freeze([...this.observedExercises].sort()),
      missingExercises: Object.freeze(this.missingExercises()),
      violations: Object.freeze([...this.violations]),
    });
  }

  private openConnection(index: number, event: Extract<RealtimeLifecycleEvent, { type: "connection.opened" }>): void {
    if (!TRANSPORTS.has(event.transport)) {
      this.violate(index, event, "invalid_event", "invalid connection transport");
      return;
    }
    if (this.phase === "terminal") {
      this.violate(index, event, "invalid_lifecycle_order", "connection opened after session terminal");
      return;
    }
    if (this.phase !== "new" && this.phase !== "disconnected") {
      this.violate(index, event, "invalid_lifecycle_order", "connection opened while the prior connection is active");
      return;
    }
    const expectedEpoch = this.connectionEpoch === null ? 0 : this.connectionEpoch + 1;
    if (event.connectionEpoch !== expectedEpoch) {
      this.violate(index, event, "stale_connection_epoch", `expected connection epoch ${expectedEpoch}`);
    }
    if (this.phase === "new" && event.reconnectOfConnectionId !== undefined) {
      this.violate(index, event, "invalid_lifecycle_order", "initial connection cannot identify a reconnect parent");
    }
    if (this.phase === "disconnected" && event.reconnectOfConnectionId !== this.disconnectedConnectionId) {
      this.violate(index, event, "identity_conflict", "reconnect does not reference the disconnected connection");
    }
    this.connectionId = event.connectionId;
    this.connectionEpoch = event.connectionEpoch;
    this.phase = this.phase === "new" ? "configuring" : "disconnected";
  }

  private requestConfiguration(index: number, event: Extract<RealtimeLifecycleEvent, { type: "session.configuration.requested" }>): void {
    if (this.phase !== "configuring") {
      this.violate(index, event, "invalid_lifecycle_order", "configuration requested outside initial configuration");
      return;
    }
    if (!validId(event.requestId) || !this.validRequestedConfiguration(event.requested)) {
      this.violate(index, event, "invalid_event", "invalid requested session configuration");
      return;
    }
    if (this.pendingRequestId !== null) {
      this.violate(index, event, "invalid_lifecycle_order", "another configuration request is pending");
      return;
    }
    this.pendingRequestId = event.requestId;
    this.requestedConfiguration = cloneRequested(event.requested);
  }

  private acknowledgeConfiguration(index: number, event: Extract<RealtimeLifecycleEvent, { type: "session.configuration.acknowledged" }>): void {
    if (this.phase !== "configuring" || this.pendingRequestId !== event.requestId || this.requestedConfiguration === null) {
      this.violate(index, event, "invalid_lifecycle_order", "configuration acknowledgement has no matching request");
      return;
    }
    if (!validId(event.providerSessionId)
      || !this.providerEvidence(index, event, event.evidence, "session_acknowledgement")
      || !this.validAcknowledgedConfiguration(event.acknowledged)) {
      if (!validId(event.providerSessionId) || !this.validAcknowledgedConfiguration(event.acknowledged)) {
        this.violate(index, event, "invalid_event", "invalid acknowledged session configuration");
      }
      return;
    }
    if (!this.negotiate(index, event, this.requestedConfiguration, event.acknowledged)) return;
    this.providerSessionId = event.providerSessionId;
    this.acknowledgedConfiguration = cloneAcknowledged(event.acknowledged);
    this.pendingRequestId = null;
    this.phase = "active";
  }

  private startTurn(index: number, event: Extract<RealtimeLifecycleEvent, { type: "turn.started" }>): void {
    if (!this.requireActive(index, event) || !validId(event.turnId) || !validId(event.inputId)
      || !TURN_TRIGGERS.has(event.trigger)) {
      if (!validId(event.turnId) || !validId(event.inputId)) this.violate(index, event, "invalid_event", "invalid turn identity");
      if (!TURN_TRIGGERS.has(event.trigger)) this.violate(index, event, "invalid_event", "invalid turn trigger");
      return;
    }
    if (this.turns.has(event.turnId)) {
      this.violate(index, event, "identity_conflict", "turn identity was reused");
      return;
    }
    if (event.evidence && !this.providerEvidence(index, event, event.evidence, "turn_observation")) return;
    this.turns.set(event.turnId, { status: "open" });
    if (event.trigger === "audio_commit" && event.evidence?.authority === "provider_wire") {
      this.observedExercises.add("audio_input");
    }
  }

  private startResponse(index: number, event: Extract<RealtimeLifecycleEvent, { type: "response.started" }>): void {
    if (!this.requireActive(index, event) || !this.openTurn(index, event, event.turnId)
      || !validId(event.responseId)
      || !this.providerEvidence(index, event, event.evidence, "response_start")) return;
    if (this.responses.has(event.responseId)) {
      this.violate(index, event, "identity_conflict", "response identity was reused");
      return;
    }
    this.responses.set(event.responseId, { turnId: event.turnId, status: "open", lastAudioSequence: -1, audioDurationMs: 0 });
  }

  private recordAudio(index: number, event: Extract<RealtimeLifecycleEvent, { type: "response.audio.delta" }>): void {
    const response = this.openResponse(index, event, event.turnId, event.responseId);
    if (!response || !this.providerEvidence(index, event, event.evidence, "audio_delta")) return;
    if (!validId(event.audioDeltaId) || this.audioDeltaIds.has(event.audioDeltaId)
      || !Number.isInteger(event.sequence) || event.sequence !== response.lastAudioSequence + 1
      || !Number.isInteger(event.byteLength) || event.byteLength <= 0
      || !Number.isFinite(event.durationMs) || event.durationMs <= 0
      || !validSha256(event.payloadSha256)) {
      this.violate(index, event, "invalid_event", "audio delta identity, sequence, size, duration, or digest is invalid");
      return;
    }
    this.audioDeltaIds.add(event.audioDeltaId);
    response.lastAudioSequence = event.sequence;
    response.audioDurationMs += event.durationMs;
    this.observedExercises.add("audio_output");
  }

  private completeToolCall(index: number, event: Extract<RealtimeLifecycleEvent, { type: "tool.call.completed" }>): void {
    if (!this.openResponse(index, event, event.turnId, event.responseId)
      || !validId(event.toolCallId) || !validId(event.toolName)
      || !validSha256(event.argumentsSha256)
      || !this.providerEvidence(index, event, event.evidence, "tool_call")) {
      if (!validId(event.toolCallId) || !validId(event.toolName) || !validSha256(event.argumentsSha256)) {
        this.violate(index, event, "invalid_event", "invalid tool call identity, name, or arguments digest");
      }
      return;
    }
    if (this.tools.has(event.toolCallId)) {
      this.violate(index, event, "identity_conflict", "tool call identity was reused");
      return;
    }
    this.tools.set(event.toolCallId, {
      turnId: event.turnId,
      responseId: event.responseId,
      acknowledged: false,
      cancelled: false,
    });
  }

  private submitToolResult(index: number, event: Extract<RealtimeLifecycleEvent, { type: "tool.result.submitted" }>): void {
    const tool = this.tools.get(event.toolCallId);
    if (!tool || tool.turnId !== event.turnId || tool.responseId !== event.responseId || tool.cancelled) {
      this.violate(index, event, "invalid_lifecycle_order", "tool result has no matching completed call");
      return;
    }
    if (!validId(event.resultId) || !validSha256(event.resultSha256) || this.resultIds.has(event.resultId) || tool.resultId) {
      this.violate(index, event, "identity_conflict", "tool result identity is invalid or reused");
      return;
    }
    tool.resultId = event.resultId;
    this.resultIds.add(event.resultId);
  }

  private acknowledgeToolResult(index: number, event: Extract<RealtimeLifecycleEvent, { type: "tool.result.acknowledged" }>): void {
    const tool = this.tools.get(event.toolCallId);
    if (!tool || tool.turnId !== event.turnId || tool.responseId !== event.responseId
      || tool.resultId !== event.resultId || tool.acknowledged || tool.cancelled) {
      this.violate(index, event, "invalid_lifecycle_order", "tool result acknowledgement has no unique submitted result");
      return;
    }
    if (!this.providerEvidence(index, event, event.evidence, "tool_result_acknowledgement")) return;
    tool.acknowledged = true;
    this.observedExercises.add("tool_round_trip");
  }

  private cancelToolCall(index: number, event: Extract<RealtimeLifecycleEvent, { type: "tool.call.cancelled" }>): void {
    const tool = this.tools.get(event.toolCallId);
    if (!tool || tool.turnId !== event.turnId || tool.responseId !== event.responseId
      || tool.acknowledged || tool.cancelled || !validId(event.reasonCode)) {
      this.violate(index, event, "invalid_lifecycle_order", "tool cancellation has no matching unresolved call");
      return;
    }
    if (!this.providerEvidence(index, event, event.evidence, "tool_call_cancellation")) return;
    tool.cancelled = true;
  }

  private recordUsage(index: number, event: Extract<RealtimeLifecycleEvent, { type: "usage.reported" }>): void {
    if (!this.requireActive(index, event)
      || !this.providerEvidence(index, event, event.evidence, "usage")) return;
    if ((event.scope !== "session" && event.scope !== "response") || typeof event.cumulative !== "boolean") {
      this.violate(index, event, "invalid_event", "usage scope or cumulative flag is invalid");
      return;
    }
    const values = [event.inputTextTokens, event.inputAudioTokens, event.outputTextTokens, event.outputAudioTokens, event.totalTokens];
    if (values.some((value) => !Number.isInteger(value) || value < 0)
      || event.totalTokens !== values.slice(0, 4).reduce((sum, value) => sum + value, 0)) {
      this.violate(index, event, "invalid_event", "usage counters must be non-negative integers with an exact total");
      return;
    }
    if (event.scope === "response" && (!event.responseId || !this.responses.has(event.responseId))) {
      this.violate(index, event, "invalid_lifecycle_order", "response usage has no known response");
      return;
    }
    const key = event.scope === "session" ? "session" : `response:${event.responseId}`;
    const next = {
      inputTextTokens: event.inputTextTokens,
      inputAudioTokens: event.inputAudioTokens,
      outputTextTokens: event.outputTextTokens,
      outputAudioTokens: event.outputAudioTokens,
      totalTokens: event.totalTokens,
    };
    const prior = this.usage.get(key);
    if (event.cumulative && prior && Object.keys(next).some((field) => next[field as keyof UsageState] < prior[field as keyof UsageState])) {
      this.violate(index, event, "non_monotonic_usage", "cumulative provider usage decreased");
      return;
    }
    this.usage.set(key, next);
    this.observedExercises.add("provider_usage");
  }

  private terminateResponse(index: number, event: Extract<RealtimeLifecycleEvent, { type: "response.terminal" }>): void {
    const response = this.openResponse(index, event, event.turnId, event.responseId);
    if (!response || !this.providerEvidence(index, event, event.evidence, "response_terminal")) return;
    if (!RESPONSE_TERMINAL_STATUSES.has(event.status)) {
      this.violate(index, event, "invalid_event", "invalid response terminal status");
      return;
    }
    if (event.status === "interrupted") {
      if (!event.interruption || event.interruption.lastReleasedSequence !== (response.lastAudioSequence < 0 ? null : response.lastAudioSequence)
        || !Number.isFinite(event.interruption.releasedDurationMs)
        || Math.abs(event.interruption.releasedDurationMs - response.audioDurationMs) > 0.001) {
        this.violate(index, event, "invalid_interruption_evidence", "interruption boundary does not match observed audio deltas");
        return;
      }
    } else if (event.interruption !== undefined) {
      this.violate(index, event, "invalid_interruption_evidence", "non-interrupted response supplied an interruption boundary");
      return;
    }
    response.status = "terminal";
    if (event.status === "interrupted") this.observedExercises.add("interruption");
  }

  private terminateTurn(index: number, event: Extract<RealtimeLifecycleEvent, { type: "turn.terminal" }>): void {
    if (!this.openTurn(index, event, event.turnId)) return;
    if (!TURN_TERMINAL_STATUSES.has(event.status)) {
      this.violate(index, event, "invalid_event", "invalid turn terminal status");
      return;
    }
    if (event.evidence && !this.providerEvidence(index, event, event.evidence, "turn_terminal")) return;
    if ([...this.responses.values()].some((response) => response.turnId === event.turnId && response.status === "open")) {
      this.violate(index, event, "invalid_lifecycle_order", "turn terminated with an open response");
      return;
    }
    this.turns.get(event.turnId)!.status = "terminal";
  }

  private disconnect(index: number, event: Extract<RealtimeLifecycleEvent, { type: "connection.disconnected" }>): void {
    if (this.phase !== "active") {
      this.violate(index, event, "invalid_lifecycle_order", "connection disconnected outside an active session");
      return;
    }
    if (event.evidence && !this.providerEvidence(index, event, event.evidence, "connection_terminal")) return;
    if ([...this.responses.values()].some(({ status }) => status === "open")) {
      this.violate(index, event, "invalid_lifecycle_order", "connection disconnected before open responses became terminal");
      return;
    }
    this.disconnectedConnectionId = event.connectionId;
    this.disconnectedWasResumable = event.resumable;
    this.connectionId = null;
    this.phase = "disconnected";
  }

  private requestResume(index: number, event: Extract<RealtimeLifecycleEvent, { type: "session.resume.requested" }>): void {
    if (this.phase !== "disconnected" || this.connectionId === null
      || !this.disconnectedWasResumable || event.priorConnectionId !== this.disconnectedConnectionId
      || !validId(event.requestId) || !validSha256(event.resumeTokenSha256)) {
      this.violate(index, event, "invalid_lifecycle_order", "resume request is not bound to a resumable disconnected connection");
      return;
    }
    if (this.pendingResumeRequestId !== null) {
      this.violate(index, event, "invalid_lifecycle_order", "another resume request is pending");
      return;
    }
    this.pendingResumeRequestId = event.requestId;
  }

  private acknowledgeResume(index: number, event: Extract<RealtimeLifecycleEvent, { type: "session.resume.acknowledged" }>): void {
    if (this.phase !== "disconnected" || this.pendingResumeRequestId !== event.requestId
      || this.requestedConfiguration === null) {
      this.violate(index, event, "invalid_lifecycle_order", "resume acknowledgement has no matching request");
      return;
    }
    if (!validId(event.providerSessionId)
      || !this.providerEvidence(index, event, event.evidence, "resume_acknowledgement")
      || !this.validAcknowledgedConfiguration(event.acknowledged)) return;
    if (!this.negotiate(index, event, this.requestedConfiguration, event.acknowledged)) return;
    this.providerSessionId = event.providerSessionId;
    this.acknowledgedConfiguration = cloneAcknowledged(event.acknowledged);
    this.pendingResumeRequestId = null;
    this.phase = "active";
    this.observedExercises.add("session_resumption");
  }

  private terminateSession(index: number, event: Extract<RealtimeLifecycleEvent, { type: "session.terminal" }>): void {
    if (this.phase !== "active" && this.phase !== "disconnected") {
      this.violate(index, event, "invalid_lifecycle_order", "session terminal arrived before activation");
      return;
    }
    if (!SESSION_TERMINAL_STATUSES.has(event.status)) {
      this.violate(index, event, "invalid_event", "invalid session terminal status");
      return;
    }
    if (event.evidence && !this.providerEvidence(index, event, event.evidence, "session_terminal")) return;
    if ([...this.responses.values()].some(({ status }) => status === "open")
      || [...this.turns.values()].some(({ status }) => status === "open")) {
      this.violate(index, event, "invalid_lifecycle_order", "session terminated with open turns or responses");
      return;
    }
    const unresolved = [...this.tools.entries()]
      .filter(([, tool]) => !tool.acknowledged && !tool.cancelled)
      .map(([toolCallId]) => toolCallId)
      .sort();
    if (unresolved.length) {
      this.violate(index, event, "unresolved_tool_call", `session terminated with unresolved tool calls: ${unresolved.join(", ")}`);
      return;
    }
    const missing = this.missingExercises();
    if (missing.length) {
      this.violate(index, event, "required_exercise_missing", `conformance mode ${this.mode} did not exercise: ${missing.join(", ")}`);
      return;
    }
    this.phase = "terminal";
  }

  private validRequestedConfiguration(configuration: RequestedSessionConfiguration): boolean {
    return validId(configuration.model) && validId(configuration.voice)
      && validSha256(configuration.settingsSha256)
      && Array.isArray(configuration.features)
      && configuration.features.length > 0
      && new Set(configuration.features.map(({ id }) => id)).size === configuration.features.length
      && configuration.features.every(({ id, requirement }) => (
        FEATURE_IDS.has(id) && FEATURE_REQUIREMENTS.has(requirement)
      ));
  }

  private validAcknowledgedConfiguration(configuration: AcknowledgedSessionConfiguration): boolean {
    return validId(configuration.model) && validId(configuration.voice)
      && validSha256(configuration.settingsSha256)
      && Array.isArray(configuration.features)
      && configuration.features.length > 0
      && new Set(configuration.features.map(({ id }) => id)).size === configuration.features.length
      && configuration.features.every(({ id, status, reasonCode }) => (
        FEATURE_IDS.has(id)
        && FEATURE_STATUSES.has(status)
        && (reasonCode === undefined || validId(reasonCode))
      ));
  }

  private negotiate(
    index: number,
    event: RealtimeLifecycleEvent,
    requested: RequestedSessionConfiguration,
    acknowledged: AcknowledgedSessionConfiguration,
  ): boolean {
    const before = this.violations.length;
    const outcomes = new Map(acknowledged.features.map((feature) => [feature.id, feature]));
    for (const request of requested.features) {
      const outcome = outcomes.get(request.id);
      if (!outcome) {
        this.violate(index, event, "feature_negotiation_incomplete", `provider omitted feature ${request.id}`);
      } else if (request.requirement === "required" && outcome.status !== "enabled") {
        this.violate(index, event, "unsupported_required_feature", `required feature ${request.id} was not enabled`);
      } else if (request.requirement === "disabled" && outcome.status === "enabled") {
        this.violate(index, event, "unexpected_enabled_feature", `disabled feature ${request.id} was enabled`);
      }
    }
    for (const outcome of acknowledged.features) {
      if (!requested.features.some(({ id }) => id === outcome.id)) {
        this.violate(index, event, "feature_negotiation_incomplete", `provider negotiated unrequested feature ${outcome.id}`);
      }
      if (outcome.status === "unsupported" && !outcome.reasonCode) {
        this.violate(index, event, "feature_negotiation_incomplete", `unsupported feature ${outcome.id} omitted reasonCode`);
      }
    }
    // Paid benchmark parity is exact: provider-resolved aliases are useful
    // evidence, but they do not prove that the registered treatment ran on the
    // requested model or voice. Adapters must retain the actual acknowledged
    // identities and fail readiness rather than copying request values here.
    if (requested.model !== acknowledged.model) {
      this.violate(index, event, "configuration_mismatch", "provider-acknowledged model differs from the request");
    }
    if (requested.voice !== acknowledged.voice) {
      this.violate(index, event, "configuration_mismatch", "provider-acknowledged voice differs from the request");
    }
    if (requested.settingsSha256 !== acknowledged.settingsSha256) {
      this.violate(index, event, "configuration_mismatch", "provider-acknowledged settings differ from the request");
    }
    return before === this.violations.length;
  }

  private providerEvidence(
    index: number,
    event: RealtimeLifecycleEvent,
    evidence: LifecycleEvidence,
    expectedSemantic: Extract<LifecycleEvidence, { authority: "provider_wire" }>["proves"],
  ): evidence is Extract<LifecycleEvidence, { authority: "provider_wire" }> {
    if (evidence.authority !== "provider_wire") {
      this.violate(index, event, "request_only_acknowledgement", "outbound request evidence cannot prove provider acknowledgement");
      return false;
    }
    const frameBytes = canonicalFrameBytes(evidence.frameBytesBase64);
    if (!validId(evidence.providerEventId) || !validId(evidence.wireType)
      || !validId(evidence.socketId) || evidence.socketId !== event.connectionId
      || evidence.direction !== "provider_to_client"
      || !Number.isInteger(evidence.frameSequence) || evidence.frameSequence < 0
      || frameBytes === null
      || !Number.isInteger(evidence.frameByteLength) || evidence.frameByteLength <= 0
      || frameBytes?.byteLength !== evidence.frameByteLength
      || !validSha256(evidence.frameSha256)
      || (frameBytes !== null
        && createHash("sha256").update(frameBytes).digest("hex") !== evidence.frameSha256)
      || !Number.isFinite(evidence.observedAtMs) || evidence.observedAtMs < event.occurredAtMs
      || evidence.proves !== expectedSemantic) {
      this.violate(index, event, "wire_evidence_invalid", "provider evidence lacks exact inbound frame provenance or expected semantics");
      return false;
    }
    const priorSequence = this.lastFrameSequenceBySocket.get(evidence.socketId);
    if (priorSequence !== undefined && evidence.frameSequence <= priorSequence) {
      this.violate(index, event, "wire_causality_violation", "provider frame sequence did not advance monotonically on the socket");
      return false;
    }
    const fingerprint = `${event.type}:${event.connectionEpoch}:${event.connectionId}`;
    const prior = this.providerEventIds.get(evidence.providerEventId);
    if (prior !== undefined) {
      this.violate(
        index,
        event,
        "identity_conflict",
        prior === fingerprint
          ? "provider event identity was replayed"
          : "provider event identity was reused for a different lifecycle event",
      );
      return false;
    }
    this.providerEventIds.set(evidence.providerEventId, fingerprint);
    this.lastFrameSequenceBySocket.set(evidence.socketId, evidence.frameSequence);
    return true;
  }

  private missingExercises(): RealtimeLifecycleExercise[] {
    if (this.mode === "configuration_only" || !this.acknowledgedConfiguration) return [];
    const transportMedia = new Set<RealtimeLifecycleExercise>([
      "audio_input",
      "audio_output",
      "interruption",
    ]);
    const required = this.acknowledgedConfiguration.features
      .filter(({ status }) => status === "enabled")
      .map(({ id }) => FEATURE_EXERCISE[id])
      .filter((exercise) => this.mode === "paid_readiness" || transportMedia.has(exercise));
    return [...new Set(required)]
      .filter((exercise) => !this.observedExercises.has(exercise))
      .sort();
  }

  private requireActive(index: number, event: RealtimeLifecycleEvent): boolean {
    if (this.phase !== "active") {
      this.violate(index, event, "invalid_lifecycle_order", "event requires an active acknowledged session");
      return false;
    }
    return true;
  }

  private openTurn(index: number, event: RealtimeLifecycleEvent, turnId: string): boolean {
    const turn = this.turns.get(turnId);
    if (!turn || turn.status !== "open") {
      this.violate(index, event, "invalid_lifecycle_order", "event has no matching open turn");
      return false;
    }
    return true;
  }

  private openResponse(index: number, event: RealtimeLifecycleEvent, turnId: string, responseId: string): ResponseState | null {
    const response = this.responses.get(responseId);
    if (!response || response.status !== "open" || response.turnId !== turnId) {
      this.violate(index, event, "invalid_lifecycle_order", "event has no matching open response");
      return null;
    }
    return response;
  }

  private violate(index: number, event: RealtimeLifecycleEvent, code: RealtimeLifecycleViolationCode, message: string): void {
    this.violations.push(Object.freeze({ index, eventType: event.type, code, message }));
  }

  private addedViolations(before: number): readonly RealtimeLifecycleViolation[] {
    return Object.freeze(this.violations.slice(before));
  }
}

export function validateRealtimeLifecycleTrace(
  events: readonly RealtimeLifecycleEvent[],
  options: RealtimeLifecycleConformanceOptions = {},
): RealtimeLifecycleConformanceReport {
  const validator = new RealtimeLifecycleConformanceValidator(options);
  for (const event of events) validator.push(event);
  return validator.report();
}

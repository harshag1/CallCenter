export const REALTIME_LIFECYCLE_CONFORMANCE_VERSION = "2.0" as const;

export type ConformanceProviderId = "openai" | "gemini" | "xai" | (string & {});

export type RealtimeFeatureId =
  | "audio_input"
  | "audio_output"
  | "tool_calls"
  | "interruption"
  | "session_resumption"
  | "provider_usage";

export type RequestedFeature = Readonly<{
  id: RealtimeFeatureId;
  requirement: "required" | "preferred" | "disabled";
}>;

export type NegotiatedFeature = Readonly<{
  id: RealtimeFeatureId;
  status: "enabled" | "unsupported" | "disabled";
  /** Provider-authored reason code. Human prose must not be parsed for policy. */
  reasonCode?: string;
}>;

export type ProviderWireEvidence = Readonly<{
  authority: "provider_wire";
  providerEventId: string;
  wireType: string;
  observedAtMs: number;
}>;

/**
 * Deliberately accepted by the input type so the runtime can reject an adapter
 * that accidentally promotes its outbound request to acknowledgement evidence.
 */
export type RequestOnlyEvidence = Readonly<{
  authority: "client_request";
  requestId: string;
  wireType: string;
  observedAtMs: number;
}>;

export type LifecycleEvidence = ProviderWireEvidence | RequestOnlyEvidence;

export type RequestedSessionConfiguration = Readonly<{
  model: string;
  voice: string;
  /** SHA-256 of the canonical provider-neutral settings object. */
  settingsSha256: string;
  features: readonly RequestedFeature[];
}>;

export type AcknowledgedSessionConfiguration = Readonly<{
  /** Actual identities echoed or resolved by the provider, never copied from the request. */
  model: string;
  voice: string;
  settingsSha256: string;
  features: readonly NegotiatedFeature[];
}>;

export type ResponseTerminalStatus =
  | "completed"
  | "cancelled"
  | "failed"
  | "incomplete"
  | "interrupted";

export type TurnTerminalStatus = "completed" | "abandoned" | "failed";

type BaseEvent<K extends string> = Readonly<{
  schemaVersion: typeof REALTIME_LIFECYCLE_CONFORMANCE_VERSION;
  type: K;
  providerId: ConformanceProviderId;
  logicalSessionId: string;
  connectionId: string;
  connectionEpoch: number;
  occurredAtMs: number;
}>;

export type ConnectionOpenedEvent = BaseEvent<"connection.opened"> & Readonly<{
  transport: "websocket" | "webrtc" | "webtransport";
  reconnectOfConnectionId?: string;
}>;

export type SessionConfigurationRequestedEvent = BaseEvent<"session.configuration.requested"> & Readonly<{
  requestId: string;
  requested: RequestedSessionConfiguration;
}>;

export type SessionConfigurationAcknowledgedEvent = BaseEvent<"session.configuration.acknowledged"> & Readonly<{
  requestId: string;
  providerSessionId: string;
  acknowledged: AcknowledgedSessionConfiguration;
  evidence: LifecycleEvidence;
}>;

export type TurnStartedEvent = BaseEvent<"turn.started"> & Readonly<{
  turnId: string;
  inputId: string;
  trigger: "audio_commit" | "client_content" | "tool_result";
  evidence?: LifecycleEvidence;
}>;

export type ResponseStartedEvent = BaseEvent<"response.started"> & Readonly<{
  turnId: string;
  responseId: string;
  evidence: LifecycleEvidence;
}>;

export type ResponseAudioDeltaEvent = BaseEvent<"response.audio.delta"> & Readonly<{
  turnId: string;
  responseId: string;
  audioDeltaId: string;
  sequence: number;
  byteLength: number;
  durationMs: number;
  payloadSha256: string;
  evidence: LifecycleEvidence;
}>;

export type ToolCallCompletedEvent = BaseEvent<"tool.call.completed"> & Readonly<{
  turnId: string;
  responseId: string;
  toolCallId: string;
  toolName: string;
  argumentsSha256: string;
  evidence: LifecycleEvidence;
}>;

export type ToolResultSubmittedEvent = BaseEvent<"tool.result.submitted"> & Readonly<{
  turnId: string;
  responseId: string;
  toolCallId: string;
  resultId: string;
  resultSha256: string;
}>;

export type ToolResultAcknowledgedEvent = BaseEvent<"tool.result.acknowledged"> & Readonly<{
  turnId: string;
  responseId: string;
  toolCallId: string;
  resultId: string;
  evidence: LifecycleEvidence;
}>;

export type UsageReportedEvent = BaseEvent<"usage.reported"> & Readonly<{
  scope: "session" | "response";
  responseId?: string;
  cumulative: boolean;
  inputTextTokens: number;
  inputAudioTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
  totalTokens: number;
  evidence: LifecycleEvidence;
}>;

export type ResponseTerminalEvent = BaseEvent<"response.terminal"> & Readonly<{
  turnId: string;
  responseId: string;
  status: ResponseTerminalStatus;
  reasonCode?: string;
  /** Required for interrupted responses so released audio is auditable. */
  interruption?: Readonly<{
    lastReleasedSequence: number | null;
    releasedDurationMs: number;
  }>;
  evidence: LifecycleEvidence;
}>;

export type TurnTerminalEvent = BaseEvent<"turn.terminal"> & Readonly<{
  turnId: string;
  status: TurnTerminalStatus;
  evidence?: LifecycleEvidence;
}>;

export type ConnectionDisconnectedEvent = BaseEvent<"connection.disconnected"> & Readonly<{
  reasonCode: string;
  resumable: boolean;
  evidence?: LifecycleEvidence;
}>;

export type SessionResumeRequestedEvent = BaseEvent<"session.resume.requested"> & Readonly<{
  requestId: string;
  priorConnectionId: string;
  resumeTokenSha256: string;
}>;

export type SessionResumeAcknowledgedEvent = BaseEvent<"session.resume.acknowledged"> & Readonly<{
  requestId: string;
  providerSessionId: string;
  acknowledged: AcknowledgedSessionConfiguration;
  evidence: LifecycleEvidence;
}>;

export type SessionTerminalEvent = BaseEvent<"session.terminal"> & Readonly<{
  status: "completed" | "failed" | "cancelled";
  reasonCode?: string;
  evidence?: LifecycleEvidence;
}>;

export type RealtimeLifecycleEvent =
  | ConnectionOpenedEvent
  | SessionConfigurationRequestedEvent
  | SessionConfigurationAcknowledgedEvent
  | TurnStartedEvent
  | ResponseStartedEvent
  | ResponseAudioDeltaEvent
  | ToolCallCompletedEvent
  | ToolResultSubmittedEvent
  | ToolResultAcknowledgedEvent
  | UsageReportedEvent
  | ResponseTerminalEvent
  | TurnTerminalEvent
  | ConnectionDisconnectedEvent
  | SessionResumeRequestedEvent
  | SessionResumeAcknowledgedEvent
  | SessionTerminalEvent;

export type RealtimeLifecycleViolationCode =
  | "invalid_event"
  | "identity_conflict"
  | "request_only_acknowledgement"
  | "invalid_lifecycle_order"
  | "unsupported_required_feature"
  | "unexpected_enabled_feature"
  | "feature_negotiation_incomplete"
  | "configuration_mismatch"
  | "stale_connection_epoch"
  | "non_monotonic_usage"
  | "invalid_interruption_evidence";

export type RealtimeLifecycleViolation = Readonly<{
  index: number;
  eventType: RealtimeLifecycleEvent["type"];
  code: RealtimeLifecycleViolationCode;
  message: string;
}>;

export type RealtimeLifecycleSnapshot = Readonly<{
  providerId: ConformanceProviderId;
  logicalSessionId: string;
  phase: "new" | "configuring" | "active" | "disconnected" | "terminal" | "invalid";
  connectionId: string | null;
  connectionEpoch: number | null;
  providerSessionId: string | null;
  requestedConfiguration: RequestedSessionConfiguration | null;
  acknowledgedConfiguration: AcknowledgedSessionConfiguration | null;
  openTurnIds: readonly string[];
  openResponseIds: readonly string[];
  completedToolCallIds: readonly string[];
  acknowledgedToolResultIds: readonly string[];
  violations: readonly RealtimeLifecycleViolation[];
}>;

export type RealtimeLifecycleConformanceReport = Readonly<{
  contractVersion: typeof REALTIME_LIFECYCLE_CONFORMANCE_VERSION;
  providerId: ConformanceProviderId;
  logicalSessionId: string;
  passed: boolean;
  eventCount: number;
  snapshot: RealtimeLifecycleSnapshot;
}>;

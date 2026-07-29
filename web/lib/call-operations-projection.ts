import { createHmac } from "node:crypto";
import type {
  NormalizedRealtimeEvent,
  NormalizedRealtimeUsage,
  RealtimeWireObservation,
  ServerRealtimeProvider,
} from "./realtime/client/types";
import type { ConversationState } from "./conversation-kernel";
import type { PostDispatchDecision, PreDispatchDecision } from "./action-policy-kernel";
import type { CompiledRealtimeContextPacket } from "./realtime-context-packet";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,127}$/;
const POLICY_REASON_CODES = new Set([
  "accepted",
  "action_not_governed",
  "allowed",
  "authority_advanced_after_decision",
  "call_limit_reached",
  "deny_condition_matched",
  "dispatch_was_not_allowed",
  "effect_result_failed_postcondition",
  "fresh_confirmation_required",
  "policy_changed_after_decision",
  "read_result_failed_postcondition",
  "required_evidence_missing",
]);
const MAX_OBSERVATIONS = 10_000;
const MAX_REDACTED_ITEMS = 256;
export const DEFAULT_OPERATIONS_STALE_AFTER_MS = 120_000;
export const PUBLIC_CALL_OPERATIONS_STATUSES = [
  "active",
  "dialing",
  "completed",
  "failed",
] as const;

export type PublicCallOperationsStatus =
  | typeof PUBLIC_CALL_OPERATIONS_STATUSES[number]
  | "redacted_unknown";

const PUBLIC_CALL_OPERATIONS_STATUS_SET = new Set<string>(
  PUBLIC_CALL_OPERATIONS_STATUSES,
);
const PUBLIC_ACTION_STATUSES = new Set([
  "reserved",
  "succeeded",
  "failed",
  "indeterminate",
]);
const PUBLIC_WORKER_STATUSES = new Set([
  "pending",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "indeterminate",
  "completed",
]);
const PUBLIC_KERNEL_WORKER_STATUSES = new Set([
  "running",
  "completed",
  "cancelled",
]);
const PUBLIC_POLICY_DECISIONS = new Set([
  "allow",
  "deny",
  "require_confirmation",
  "accept",
  "reject",
  "quarantine",
  "require_reconciliation",
]);
const PUBLIC_RECOVERY_KINDS = new Set([
  "action_reconciled",
  "worker_checkpointed",
  "worker_reclaimed",
  "worker_indeterminate",
]);
const PUBLIC_WORKER_DELIVERY_STATES = new Set([
  "not_settled",
  "awaiting_delivery",
  "delivered",
  "terminal",
]);

type FrozenRecord = Readonly<Record<string, number>>;
type PublicWorkerStatus =
  | "pending"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "indeterminate"
  | "completed"
  | "redacted_unknown";
type PublicKernelWorkerStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "redacted_unknown";
type PublicRecoveryKind =
  | OperationsRecoveryObservation["kind"]
  | "redacted_unknown";

export type PolicyDecisionObservation =
  | Readonly<{
      stage: "pre_dispatch";
      observedAtMs: number;
      decision: Readonly<
        Pick<PreDispatchDecision, "decision" | "reason" | "action">
        & Partial<Omit<PreDispatchDecision, "decision" | "reason" | "action">>
      >;
    }>
  | Readonly<{
      stage: "post_dispatch";
      observedAtMs: number;
      decision: Readonly<
        Pick<PostDispatchDecision, "decision" | "reason">
        & Partial<Omit<PostDispatchDecision, "decision" | "reason">>
      >;
    }>;

export type ContextPacketObservation = Readonly<{
  observedAtMs: number;
  packet: CompiledRealtimeContextPacket;
}>;

/**
 * Cost values are deliberately explicit observations, never inferred from
 * provider usage. Repeated observations for one scope/source are cumulative:
 * the latest value replaces the prior value instead of being double-counted.
 */
export type CallCostObservation = Readonly<{
  scopeId: string;
  source: "estimated" | "provider_reported" | "reconciled";
  microUsd: number;
  observedAtMs: number;
}>;

export type OperationsActionReceipt = Readonly<{
  id: string;
  tool: string;
  capabilityEpoch: number;
  dispatchAttempt?: number;
  status:
    | "reserved"
    | "succeeded"
    | "failed"
    | "indeterminate"
    | "redacted_unknown";
  dispatchStartedAt?: string;
  reservedAt: string;
  settledAt?: string;
  reconciliationProofId?: string;
  /** Content-free structural code or server-side redaction input; never emitted verbatim. */
  error?: string;
}>;

export type OperationsFlowState = Readonly<{
  capabilityEpoch: number | null;
  revision: number;
  actionReceipts: readonly OperationsActionReceipt[];
}>;

export type OperationsConversationAuthority = Readonly<{
  kind: "materialized_head";
  revision: number;
  headSha256: string;
  snapshotCapturedAtMs: number;
  /** The operations read is forbidden from folding the conversation event log. */
  eventRowsRead: 0;
}>;

export type OperationsActionSummary = Readonly<{
  total: number;
  byStatus: Readonly<Record<string, number>>;
  maxCapabilityEpoch: number | null;
}>;

export type OperationsDurableWorker = Readonly<{
  id: string;
  parentWorkerId: string | null;
  status: string;
  authority: Readonly<{ policyEpoch: number | null }>;
  leaseExpiresAt: string | null;
  cancellationEpoch: number;
  checkpoint?: unknown | null;
  checkpointPresent?: boolean;
  result?: unknown | null;
  resultPresent?: boolean;
  error?: unknown | null;
  errorPresent?: boolean;
  settledAt: string | null;
  /** Content-free state materialized from the durable worker/inbox tables. */
  deliveryState?: "not_settled" | "awaiting_delivery" | "delivered" | "terminal";
}>;

export type OperationsSourceObservation = Readonly<{
  source: "flow" | "conversation" | "workers" | "policy";
  observedAtMs: number | null;
}>;

export type OperationsRecoveryObservation = Readonly<{
  kind: "action_reconciled" | "worker_checkpointed" | "worker_reclaimed" | "worker_indeterminate";
  subjectId: string;
  observedAtMs: number;
}>;

export type OperationsCountSummary = Readonly<{
  total: number;
  byStatus: Readonly<Record<string, number>>;
}>;

export type OperationsWorkerSummary = OperationsCountSummary & Readonly<{
  byDeliveryState?: Readonly<Record<string, number>>;
}>;

export type OperationsPolicySummary = Readonly<{
  observations: number;
  denials: number;
  byDecision: Readonly<Record<string, number>>;
}>;

export type OperationsRecoverySummary = Readonly<{
  observations: number;
  byKind: Readonly<Record<string, number>>;
  lastObservedAtMs: number | null;
}>;

export type CallOperationsProjectionInput = Readonly<{
  callId: string;
  /** Per-tenant secret used only for irreversible HMAC identities in this projection. */
  redactionKey: string | Uint8Array;
  generatedAtMs: number;
  realtimeEvents?: readonly NormalizedRealtimeEvent[];
  wireObservations?: readonly RealtimeWireObservation[];
  conversationState?: ConversationState;
  conversationAuthority?: OperationsConversationAuthority;
  flowState?: OperationsFlowState;
  actionSummary?: OperationsActionSummary;
  policyDecisions?: readonly PolicyDecisionObservation[];
  durableWorkers?: readonly OperationsDurableWorker[];
  /**
   * Complete identity index for the durable aggregate. Required whenever
   * `durableWorkerSummary` covers workers omitted from the bounded detail
   * window, so kernel/durable union membership remains exact.
   */
  durableWorkerIds?: readonly string[];
  durableWorkerSummary?: OperationsWorkerSummary;
  contextPackets?: readonly ContextPacketObservation[];
  costObservations?: readonly CallCostObservation[];
  policySummary?: OperationsPolicySummary;
  callStatus?: string;
  sourceObservations?: readonly OperationsSourceObservation[];
  sourceStaleAfterMs?: number;
  recoveryObservations?: readonly OperationsRecoveryObservation[];
  recoverySummary?: OperationsRecoverySummary;
}>;

export type MetricDistribution = Readonly<{
  count: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}>;

export type CallOperationsProjection = Readonly<{
  schemaVersion: 1;
  generatedAtMs: number;
  callKey: string;
  providers: readonly ServerRealtimeProvider[];
  connections: Readonly<{
    count: number;
    ready: number;
    failed: number;
    closed: number;
    uncleanClosed: number;
    epochs: readonly Readonly<{
      provider: ServerRealtimeProvider;
      epoch: number;
      state: "observed" | "ready" | "failed" | "closed";
      firstObservedAtMs: number;
      lastObservedAtMs: number;
      inboundFrames: number;
      outboundFrames: number;
      inboundBytes: number;
      outboundBytes: number;
      lastSequence: number;
      cleanClose: boolean | null;
      closeObserved: boolean;
      failureObserved: boolean;
      failureCategory: string | null;
      failureCode: string | null;
    }>[];
  }>;
  authority: Readonly<{
    conversationRevision: number | null;
    conversationHeadSha256: string | null;
    policyEpoch: number | null;
    capabilityEpoch: number | null;
    observedPolicyEpochs: readonly number[];
    observedCapabilityEpochs: readonly number[];
    catalogDigests: readonly string[];
    flowRevision: number | null;
    drift: readonly (
      | "packet_conversation_vs_materialized"
      | "packet_policy_vs_kernel"
      | "packet_capability_vs_flow"
      | "flow_capability_unavailable"
      | "worker_policy_stale"
      | "receipt_capability_ahead"
    )[];
  }>;
  policy: Readonly<{
    observations: number;
    denials: number;
    byDecision: FrozenRecord;
    recentDenials: readonly Readonly<{
      stage: "pre_dispatch" | "post_dispatch";
      decision: string;
      reasonCode: string | null;
      reasonSha256: string;
      actionKey: string | null;
      observedAtMs: number;
    }>[];
  }>;
  actions: Readonly<{
    total: number;
    byStatus: FrozenRecord;
    indeterminate: readonly Readonly<{
      receiptKey: string;
      toolKey: string;
      capabilityEpoch: number;
      dispatchAttempt: number;
      ageMs: number;
      dispatched: boolean;
      reconciliationProofPresent: boolean;
      errorSha256: string | null;
    }>[];
  }>;
  workers: Readonly<{
    total: number;
    byStatus: FrozenRecord;
    byDeliveryState: FrozenRecord;
    items: readonly Readonly<{
      workerKey: string;
      parentWorkerKey: string | null;
      status: PublicWorkerStatus;
      kernelStatus: PublicKernelWorkerStatus | null;
      deliveryState: "not_settled" | "awaiting_delivery" | "delivered" | "terminal";
      policyEpoch: number | null;
      staleAuthority: boolean;
      leaseState: "none" | "active" | "expired";
      cancellationEpoch: number;
      checkpointPresent: boolean;
      resultPresent: boolean;
      errorPresent: boolean;
      settledAtMs: number | null;
    }>[];
  }>;
  freshness: Readonly<{
    callStatus: PublicCallOperationsStatus | null;
    active: boolean;
    staleAfterMs: number;
    maximumAgeMs: number | null;
    staleSources: readonly OperationsSourceObservation["source"][];
    sources: readonly Readonly<{
      source: OperationsSourceObservation["source"];
      observedAtMs: number | null;
      ageMs: number | null;
      state: "current" | "stale" | "settled" | "unavailable";
    }>[];
  }>;
  recovery: Readonly<{
    observations: number;
    byKind: FrozenRecord;
    lastObservedAtMs: number | null;
    recent: readonly Readonly<{
      kind: PublicRecoveryKind;
      subjectKey: string;
      observedAtMs: number;
    }>[];
  }>;
  context: Readonly<{
    packetCount: number;
    latestPacketBytes: number | null;
    maximumPacketBytes: number | null;
    latestDurableBytes: number | null;
    omittedRecentTurns: number;
    maximumOmittedRecentTurns: number;
  }>;
  latencyMs: Readonly<{
    firstOutput: MetricDistribution;
    responseCompletion: MetricDistribution;
    actionSettlement: MetricDistribution;
  }>;
  usage: Readonly<{
    eventCount: number;
    inputTextTokens: number | null;
    inputAudioTokens: number | null;
    cachedInputTokens: number | null;
    outputTextTokens: number | null;
    outputAudioTokens: number | null;
    totalTokens: number | null;
    inputAudioMinutes: number | null;
    outputAudioMinutes: number | null;
    billableTextInputEvents: number | null;
  }>;
  cost: Readonly<{
    scopeCount: number;
    coverage: "none" | "estimated" | "provider_reported" | "reconciled" | "mixed";
    estimatedMicroUsd: number | null;
    providerReportedMicroUsd: number | null;
    reconciledMicroUsd: number | null;
    settledMicroUsd: number | null;
  }>;
  attention: readonly (
    | "connection_failure"
    | "unclean_connection_close"
    | "authority_drift"
    | "policy_denial"
    | "indeterminate_action"
    | "indeterminate_worker"
    | "worker_delivery_pending"
    | "stale_operations_source"
    | "context_turns_omitted"
    | "cost_not_reconciled"
  )[];
}>;

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function assertBounded<T>(items: readonly T[], label: string): void {
  if (items.length > MAX_OBSERVATIONS) throw new Error(`${label} exceeds ${MAX_OBSERVATIONS} observations`);
}

function hmac(key: string | Uint8Array, domain: string, value: string): string {
  return createHmac("sha256", key).update(domain, "utf8").update("\0", "utf8").update(value, "utf8").digest("hex");
}

function publicCode(value: string | undefined): string | null {
  return value && SAFE_CODE.test(value) ? value : null;
}

/**
 * Converts the database lifecycle value into a deliberately closed,
 * content-free management status. Unknown values can be operationally useful
 * as a signal, but their raw bytes must never cross the operations boundary.
 */
export function normalizePublicCallOperationsStatus(
  value: unknown,
): PublicCallOperationsStatus | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && PUBLIC_CALL_OPERATIONS_STATUS_SET.has(value)
    ? value as typeof PUBLIC_CALL_OPERATIONS_STATUSES[number]
    : "redacted_unknown";
}

function normalizeClosedCode(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === "string" && allowed.has(value)
    ? value
    : "redacted_unknown";
}

function normalizePublicWorkerStatus(value: unknown): PublicWorkerStatus {
  return normalizeClosedCode(value, PUBLIC_WORKER_STATUSES) as PublicWorkerStatus;
}

function normalizePublicKernelWorkerStatus(value: unknown): PublicKernelWorkerStatus {
  return normalizeClosedCode(
    value,
    PUBLIC_KERNEL_WORKER_STATUSES,
  ) as PublicKernelWorkerStatus;
}

function policyReasonCode(value: string): string | null {
  return POLICY_REASON_CODES.has(value) ? value : null;
}

function freezeCounts(values: readonly string[]): FrozenRecord {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.freeze(Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))));
}

function validateAndNormalizeCountRecord(
  value: Readonly<Record<string, number>>,
  expectedTotal: number,
  label: string,
  normalizeKey: (key: string) => string,
): FrozenRecord {
  const entries = Object.entries(value);
  if (entries.length > MAX_OBSERVATIONS) {
    throw new Error(`${label} exceeds ${MAX_OBSERVATIONS} labels`);
  }
  let total = 0;
  const normalized: Record<string, number> = {};
  for (const [key, count] of entries) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${label} contains an invalid count`);
    }
    total += count;
    const publicKey = normalizeKey(key);
    normalized[publicKey] = (normalized[publicKey] ?? 0) + count;
  }
  if (!Number.isSafeInteger(expectedTotal) || expectedTotal < 0 || total !== expectedTotal) {
    throw new Error(`${label} does not sum to its total`);
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function distribution(samples: readonly number[]): MetricDistribution {
  const sorted = samples
    .filter((value) => Number.isSafeInteger(value) && value >= 0)
    .sort((left, right) => left - right);
  const percentile = (fraction: number): number | null =>
    sorted.length === 0 ? null : sorted[Math.ceil(sorted.length * fraction) - 1];
  return Object.freeze({
    count: sorted.length,
    min: sorted.at(0) ?? null,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? null,
  });
}

function eventClock(event: NormalizedRealtimeEvent): Readonly<{ basis: "monotonic" | "wall"; value: number }> {
  return event.receivedAtMonotonicMs === undefined
    ? { basis: "wall", value: event.receivedAtMs }
    : { basis: "monotonic", value: event.receivedAtMonotonicMs };
}

function sumOptionalUsage(
  observations: readonly Extract<NormalizedRealtimeEvent, { type: "usage" }>[],
  field: Exclude<keyof NormalizedRealtimeUsage, "raw" | "meteringSource">,
): number | null {
  const values = observations.flatMap((event) =>
    typeof event.usage[field] === "number" ? [event.usage[field] as number] : []);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function addUniqueNumber(target: Set<number>, value: number): void {
  assertSafeInteger(value, "authority epoch");
  target.add(value);
}

function addOptionalUniqueNumber(target: Set<number>, value: number | null): void {
  if (value !== null) addUniqueNumber(target, value);
}

/**
 * Produces a bounded, content-free management view of one call. It accepts
 * existing runtime objects directly, so providers and integrations do not need
 * a second telemetry protocol before this can be used.
 */
export function projectCallOperations(input: CallOperationsProjectionInput): CallOperationsProjection {
  if (!input.callId || input.callId.length > 2_048) throw new Error("call identity must contain 1 to 2048 characters");
  const keyBytes = typeof input.redactionKey === "string"
    ? Buffer.byteLength(input.redactionKey, "utf8")
    : input.redactionKey.byteLength;
  if (keyBytes < 16) throw new Error("operations redaction key must contain at least 16 bytes");
  assertSafeInteger(input.generatedAtMs, "projection timestamp");
  if (input.conversationAuthority) {
    assertSafeInteger(input.conversationAuthority.revision, "materialized conversation revision");
    assertSafeInteger(
      input.conversationAuthority.snapshotCapturedAtMs,
      "materialized conversation snapshot timestamp",
    );
    if (
      input.conversationAuthority.kind !== "materialized_head"
      || !SHA256.test(input.conversationAuthority.headSha256)
      || input.conversationAuthority.snapshotCapturedAtMs !== input.generatedAtMs
      || input.conversationAuthority.eventRowsRead !== 0
    ) {
      throw new Error("materialized conversation authority is not bound to this bounded snapshot");
    }
    if (
      input.conversationState
      && (
        input.conversationState.eventCount !== input.conversationAuthority.revision
        || input.conversationState.headHash !== input.conversationAuthority.headSha256
      )
    ) {
      throw new Error("materialized conversation authority conflicts with the supplied conversation state");
    }
  }

  const events = input.realtimeEvents ?? [];
  const wires = input.wireObservations ?? [];
  const decisions = input.policyDecisions ?? [];
  const packets = input.contextPackets ?? [];
  const costs = input.costObservations ?? [];
  const durableWorkers = input.durableWorkers ?? [];
  const durableWorkerIds = input.durableWorkerIds;
  const sourceObservations = input.sourceObservations ?? [];
  const recoveryObservations = input.recoveryObservations ?? [];
  assertBounded(events, "realtime events");
  assertBounded(wires, "wire observations");
  assertBounded(decisions, "policy decisions");
  assertBounded(packets, "context packets");
  assertBounded(costs, "cost observations");
  assertBounded(durableWorkers, "durable workers");
  if (durableWorkerIds !== undefined) assertBounded(durableWorkerIds, "durable worker identity index");
  assertBounded(sourceObservations, "operations source observations");
  assertBounded(recoveryObservations, "recovery observations");

  const sourceStaleAfterMs = input.sourceStaleAfterMs ?? DEFAULT_OPERATIONS_STALE_AFTER_MS;
  if (!Number.isSafeInteger(sourceStaleAfterMs) || sourceStaleAfterMs < 1_000 || sourceStaleAfterMs > 86_400_000) {
    throw new Error("operations stale threshold must be between 1000 and 86400000 milliseconds");
  }
  const publicCallStatus = normalizePublicCallOperationsStatus(input.callStatus);

  const callKey = hmac(input.redactionKey, "hacc/operations/call/v1", input.callId);
  const providers = [...new Set<ServerRealtimeProvider>([
    ...events.map(({ provider }) => provider),
    ...wires.map(({ provider }) => provider),
  ])].sort();

  type MutableConnection = {
    provider: ServerRealtimeProvider;
    epoch: number;
    state: "observed" | "ready" | "failed" | "closed";
    firstObservedAtMs: number;
    lastObservedAtMs: number;
    inboundFrames: number;
    outboundFrames: number;
    inboundBytes: number;
    outboundBytes: number;
    lastSequence: number;
    cleanClose: boolean | null;
    closeObserved: boolean;
    failureObserved: boolean;
    failureCategory: string | null;
    failureCode: string | null;
  };
  const connections = new Map<string, MutableConnection>();
  const ensureConnection = (
    provider: ServerRealtimeProvider,
    epoch: number,
    observedAtMs: number,
  ): MutableConnection => {
    assertSafeInteger(epoch, "connection epoch");
    assertSafeInteger(observedAtMs, "connection observation timestamp");
    const key = `${provider}:${epoch}`;
    let connection = connections.get(key);
    if (!connection) {
      connection = {
        provider,
        epoch,
        state: "observed",
        firstObservedAtMs: observedAtMs,
        lastObservedAtMs: observedAtMs,
        inboundFrames: 0,
        outboundFrames: 0,
        inboundBytes: 0,
        outboundBytes: 0,
        lastSequence: 0,
        cleanClose: null,
        closeObserved: false,
        failureObserved: false,
        failureCategory: null,
        failureCode: null,
      };
      connections.set(key, connection);
    } else {
      connection.firstObservedAtMs = Math.min(connection.firstObservedAtMs, observedAtMs);
      connection.lastObservedAtMs = Math.max(connection.lastObservedAtMs, observedAtMs);
    }
    return connection;
  };
  const seenWire = new Set<string>();
  for (const observation of wires) {
    if (seenWire.has(observation.observationSha256)) continue;
    seenWire.add(observation.observationSha256);
    const connection = ensureConnection(observation.provider, observation.connectionEpoch, observation.observedAtMs);
    connection.lastSequence = Math.max(connection.lastSequence, observation.sequence);
    if (observation.direction === "inbound") {
      connection.inboundFrames += 1;
      connection.inboundBytes += observation.payloadBytes;
    } else {
      connection.outboundFrames += 1;
      connection.outboundBytes += observation.payloadBytes;
    }
  }
  for (const event of events) {
    const epoch = event.type === "input.audio_committed"
      ? event.connectionEpoch
      : event.wireObservation?.availability === "observed"
        ? event.wireObservation.connectionEpoch
        : null;
    if (epoch === null) continue;
    const connection = ensureConnection(event.provider, epoch, event.receivedAtMs);
    if (event.type === "session.ready" && connection.state === "observed") connection.state = "ready";
    if (event.type === "error" && event.fatal) {
      connection.state = "failed";
      connection.failureObserved = true;
      connection.failureCategory = event.transportDiagnostic?.category ?? "unknown";
      connection.failureCode = publicCode(event.transportDiagnostic?.safeRawCode);
    }
    if (event.type === "connection.closed") {
      connection.state = "closed";
      connection.closeObserved = true;
      connection.cleanClose = event.clean ?? null;
      connection.failureCategory = event.transportDiagnostic?.category ?? connection.failureCategory;
      connection.failureCode = publicCode(event.transportDiagnostic?.safeRawCode);
      if (event.transportDiagnostic && event.transportDiagnostic.category !== "normal_close") {
        connection.failureObserved = true;
      }
    }
  }
  const connectionEpochs = [...connections.values()]
    .sort((left, right) => left.firstObservedAtMs - right.firstObservedAtMs
      || left.provider.localeCompare(right.provider) || left.epoch - right.epoch)
    .map((connection) => Object.freeze({ ...connection }));
  const connectionDetails = connectionEpochs.slice(-MAX_REDACTED_ITEMS);

  const observedPolicyEpochs = new Set<number>();
  const observedCapabilityEpochs = new Set<number>();
  const catalogDigests = new Set<string>();
  for (const observation of packets) {
    assertSafeInteger(observation.observedAtMs, "context packet timestamp");
    if (observation.packet.byteLength !== Buffer.byteLength(observation.packet.serialized, "utf8")) {
      throw new Error("context packet byte evidence does not match its serialized value");
    }
    const authority = observation.packet.value.authority;
    assertSafeInteger(authority.conversationRevision, "context packet conversation revision");
    addUniqueNumber(observedPolicyEpochs, authority.policyEpoch);
    addUniqueNumber(observedCapabilityEpochs, authority.capabilityEpoch);
    if (!SHA256.test(authority.capabilityCatalogDigest)) throw new Error("context packet catalog digest must be SHA-256");
    catalogDigests.add(authority.capabilityCatalogDigest);
  }
  if (input.conversationState) {
    assertSafeInteger(input.conversationState.eventCount, "conversation revision");
    addUniqueNumber(observedPolicyEpochs, input.conversationState.policy.epoch);
    for (const checkpoint of input.conversationState.flowCheckpoints) {
      addUniqueNumber(observedCapabilityEpochs, checkpoint.capabilityEpoch);
      assertSafeInteger(checkpoint.flowRevision, "flow checkpoint revision");
    }
    if (input.conversationState.currentFlowCheckpoint) {
      addUniqueNumber(
        observedCapabilityEpochs,
        input.conversationState.currentFlowCheckpoint.capabilityEpoch,
      );
      assertSafeInteger(
        input.conversationState.currentFlowCheckpoint.flowRevision,
        "current flow checkpoint revision",
      );
    }
    for (const worker of input.conversationState.workers) {
      addUniqueNumber(observedPolicyEpochs, worker.policyEpoch);
    }
  }
  if (input.flowState) {
    assertSafeInteger(input.flowState.revision, "flow revision");
    addOptionalUniqueNumber(observedCapabilityEpochs, input.flowState.capabilityEpoch);
    for (const receipt of input.flowState.actionReceipts) {
      addUniqueNumber(observedCapabilityEpochs, receipt.capabilityEpoch);
      assertSafeInteger(receipt.dispatchAttempt ?? 0, "action dispatch attempt");
      if (
        typeof receipt.tool !== "string"
        || Buffer.byteLength(receipt.tool, "utf8") < 1
        || Buffer.byteLength(receipt.tool, "utf8") > 256
      ) {
        throw new Error("action receipt tool identity must contain 1 to 256 UTF-8 bytes");
      }
    }
  }
  addOptionalUniqueNumber(
    observedCapabilityEpochs,
    input.actionSummary?.maxCapabilityEpoch ?? null,
  );
  for (const worker of durableWorkers) {
    addOptionalUniqueNumber(observedPolicyEpochs, worker.authority.policyEpoch);
    assertSafeInteger(worker.cancellationEpoch, "worker cancellation epoch");
  }

  const latestPacket = [...packets].sort((left, right) => right.observedAtMs - left.observedAtMs)[0]?.packet ?? null;
  const kernelPolicyEpoch = input.conversationState?.policy.epoch ?? latestPacket?.value.authority.policyEpoch ?? null;
  const actionSummaryMaxCapabilityEpoch =
    input.actionSummary?.maxCapabilityEpoch ?? null;
  const flowCapabilityEpoch = input.flowState
    ? input.flowState.capabilityEpoch
    : input.conversationState?.currentFlowCheckpoint?.capabilityEpoch
      ?? latestPacket?.value.authority.capabilityEpoch
      ?? null;
  const authorityDrift = new Set<CallOperationsProjection["authority"]["drift"][number]>();
  if (input.flowState?.capabilityEpoch === null) {
    authorityDrift.add("flow_capability_unavailable");
  }
  if (
    latestPacket
    && input.conversationAuthority
    && (
      latestPacket.value.authority.conversationRevision
        !== input.conversationAuthority.revision
      || latestPacket.value.authority.conversationHeadSha256
        !== input.conversationAuthority.headSha256
    )
  ) {
    authorityDrift.add("packet_conversation_vs_materialized");
  }
  if (latestPacket && input.conversationState
    && latestPacket.value.authority.policyEpoch !== input.conversationState.policy.epoch) {
    authorityDrift.add("packet_policy_vs_kernel");
  }
  if (latestPacket && input.flowState
    && (input.flowState.capabilityEpoch === null
      || latestPacket.value.authority.capabilityEpoch !== input.flowState.capabilityEpoch)) {
    authorityDrift.add("packet_capability_vs_flow");
  }
  if (durableWorkers.some((worker) =>
    !["succeeded", "failed", "cancelled", "indeterminate"].includes(
      normalizePublicWorkerStatus(worker.status),
    )
    && (worker.authority.policyEpoch === null
      || (kernelPolicyEpoch !== null && worker.authority.policyEpoch !== kernelPolicyEpoch)))) {
    authorityDrift.add("worker_policy_stale");
  }
  if (
    flowCapabilityEpoch !== null
    && (
      actionSummaryMaxCapabilityEpoch !== null
        ? actionSummaryMaxCapabilityEpoch > flowCapabilityEpoch
        : (input.flowState?.actionReceipts ?? []).some((receipt) =>
            receipt.capabilityEpoch > flowCapabilityEpoch)
    )
  ) {
    authorityDrift.add("receipt_capability_ahead");
  }

  const deniedDecisions = decisions.filter(({ stage, decision }) =>
      stage === "pre_dispatch"
        ? decision.decision !== "allow"
        : decision.decision !== "accept");
  const denialItems = deniedDecisions
    .sort((left, right) => right.observedAtMs - left.observedAtMs)
    .slice(0, MAX_REDACTED_ITEMS)
    .map((observation) => {
      const reason = observation.decision.reason;
      const action = observation.stage === "pre_dispatch" ? observation.decision.action : null;
      return Object.freeze({
        stage: observation.stage,
        decision: normalizeClosedCode(
          observation.decision.decision,
          PUBLIC_POLICY_DECISIONS,
        ),
        reasonCode: policyReasonCode(reason),
        reasonSha256: hmac(input.redactionKey, "hacc/operations/policy-reason/v1", reason),
        actionKey: action === null ? null : hmac(input.redactionKey, "hacc/operations/action/v1", action),
        observedAtMs: observation.observedAtMs,
      });
    });
  const observedPolicyCounts = freezeCounts(decisions.map(({ decision }) =>
    normalizeClosedCode(decision.decision, PUBLIC_POLICY_DECISIONS)));
  const projectedPolicySummary = input.policySummary
    ? {
        observations: input.policySummary.observations,
        denials: input.policySummary.denials,
        byDecision: validateAndNormalizeCountRecord(
          input.policySummary.byDecision,
          input.policySummary.observations,
          "policy decision summary",
          (decision) => normalizeClosedCode(decision, PUBLIC_POLICY_DECISIONS),
        ),
      }
    : {
        observations: decisions.length,
        denials: deniedDecisions.length,
        byDecision: observedPolicyCounts,
      };
  if (
    !Number.isSafeInteger(projectedPolicySummary.denials)
    || projectedPolicySummary.denials < deniedDecisions.length
    || projectedPolicySummary.denials > projectedPolicySummary.observations
    || projectedPolicySummary.observations < decisions.length
  ) {
    throw new Error("policy decision summary contradicts its projected observations");
  }
  const knownSummarizedDenials = (projectedPolicySummary.byDecision.deny ?? 0)
    + (projectedPolicySummary.byDecision.require_confirmation ?? 0)
    + (projectedPolicySummary.byDecision.reject ?? 0)
    + (projectedPolicySummary.byDecision.quarantine ?? 0)
    + (projectedPolicySummary.byDecision.require_reconciliation ?? 0);
  const unknownPolicyDecisions = projectedPolicySummary.byDecision.redacted_unknown ?? 0;
  if (
    projectedPolicySummary.denials < knownSummarizedDenials
    || projectedPolicySummary.denials > knownSummarizedDenials + unknownPolicyDecisions
  ) {
    throw new Error("policy decision summary denial count is inconsistent");
  }
  for (const [decision, count] of Object.entries(observedPolicyCounts)) {
    if ((projectedPolicySummary.byDecision[decision] ?? 0) < count) {
      throw new Error("policy decision summary contradicts its projected observations");
    }
  }

  const receipts = input.flowState?.actionReceipts ?? [];
  const observedActionCounts = freezeCounts(receipts.map(({ status }) =>
    normalizeClosedCode(status, PUBLIC_ACTION_STATUSES)));
  const projectedActionSummary = input.actionSummary
    ? {
        total: input.actionSummary.total,
        byStatus: validateAndNormalizeCountRecord(
          input.actionSummary.byStatus,
          input.actionSummary.total,
          "action receipt summary",
          (status) => normalizeClosedCode(status, PUBLIC_ACTION_STATUSES),
        ),
        maxCapabilityEpoch: input.actionSummary.maxCapabilityEpoch,
      }
    : {
        total: receipts.length,
        byStatus: observedActionCounts,
        maxCapabilityEpoch: receipts.length === 0
          ? null
          : Math.max(...receipts.map(({ capabilityEpoch }) => capabilityEpoch)),
      };
  if (
    projectedActionSummary.total > MAX_OBSERVATIONS
    || projectedActionSummary.total < receipts.length
    || (projectedActionSummary.maxCapabilityEpoch !== null
      && (!Number.isSafeInteger(projectedActionSummary.maxCapabilityEpoch)
        || projectedActionSummary.maxCapabilityEpoch < 0))
    || (projectedActionSummary.total === 0)
      !== (projectedActionSummary.maxCapabilityEpoch === null)
  ) {
    throw new Error("action receipt summary contradicts its projected observations");
  }
  for (const [status, count] of Object.entries(observedActionCounts)) {
    if ((projectedActionSummary.byStatus[status] ?? 0) < count) {
      throw new Error("action receipt summary contradicts its projected observations");
    }
  }
  if (
    receipts.some(({ capabilityEpoch }) =>
      projectedActionSummary.maxCapabilityEpoch === null
      || capabilityEpoch > projectedActionSummary.maxCapabilityEpoch)
  ) {
    throw new Error("action receipt summary maximum capability epoch is incomplete");
  }
  const indeterminateReceipts = receipts
    .filter(({ status }) => status === "indeterminate")
    .sort((left, right) => Date.parse(right.settledAt ?? right.reservedAt) - Date.parse(left.settledAt ?? left.reservedAt))
    .slice(0, MAX_REDACTED_ITEMS)
    .map((receipt) => {
      const originMs = Date.parse(receipt.dispatchStartedAt ?? receipt.reservedAt);
      if (!Number.isFinite(originMs)) throw new Error("action receipt has an invalid operational timestamp");
      return Object.freeze({
        receiptKey: hmac(input.redactionKey, "hacc/operations/receipt/v1", receipt.id),
        toolKey: hmac(input.redactionKey, "hacc/operations/tool/v1", receipt.tool),
        capabilityEpoch: receipt.capabilityEpoch,
        dispatchAttempt: receipt.dispatchAttempt ?? 0,
        ageMs: Math.max(0, input.generatedAtMs - originMs),
        dispatched: receipt.dispatchStartedAt !== undefined,
        reconciliationProofPresent: receipt.reconciliationProofId !== undefined,
        errorSha256: receipt.error === undefined
          ? null
          : hmac(input.redactionKey, "hacc/operations/receipt-error/v1", receipt.error),
      });
    });

  const kernelWorkers = new Map((input.conversationState?.workers ?? []).map((worker) => [worker.workerId, worker]));
  const projectedDurableIds = durableWorkers.map(({ id }) => id);
  if (
    projectedDurableIds.some((id) => !id || id.length > 2_048)
    || new Set(projectedDurableIds).size !== projectedDurableIds.length
  ) {
    throw new Error("durable worker detail identities must be unique and bounded");
  }
  const kernelOnlyWorkerStatuses: PublicWorkerStatus[] = [];
  type ProjectedWorkerItem = CallOperationsProjection["workers"]["items"][number];
  const allWorkerItems: ProjectedWorkerItem[] = durableWorkers
    .map((worker): ProjectedWorkerItem => {
      const kernel = kernelWorkers.get(worker.id) ?? null;
      const settledAtMs = worker.settledAt === null ? null : Date.parse(worker.settledAt);
      if (settledAtMs !== null && !Number.isFinite(settledAtMs)) {
        throw new Error("voice worker has an invalid settlement timestamp");
      }
      const leaseExpiryMs = worker.leaseExpiresAt === null ? null : Date.parse(worker.leaseExpiresAt);
      if (leaseExpiryMs !== null && !Number.isFinite(leaseExpiryMs)) {
        throw new Error("voice worker has an invalid lease timestamp");
      }
      const publicStatus = normalizePublicWorkerStatus(worker.status);
      const publicKernelStatus = kernel === null
        ? null
        : normalizePublicKernelWorkerStatus(kernel.status);
      const terminal = ["succeeded", "failed", "cancelled", "indeterminate"].includes(publicStatus);
      const deliveryState = worker.deliveryState
        ?? (publicKernelStatus === "completed"
          ? "delivered"
          : publicStatus === "succeeded"
            ? "awaiting_delivery"
            : terminal
              ? "terminal"
              : "not_settled");
      if (
        (deliveryState === "delivered" && publicStatus !== "succeeded")
        || (deliveryState === "awaiting_delivery" && publicStatus !== "succeeded")
        || (deliveryState === "terminal" && !terminal)
        || (deliveryState === "not_settled" && terminal)
      ) {
        throw new Error("durable worker delivery state contradicts its lifecycle status");
      }
      return Object.freeze({
        workerKey: hmac(input.redactionKey, "hacc/operations/worker/v1", worker.id),
        parentWorkerKey: worker.parentWorkerId === null
          ? null
          : hmac(input.redactionKey, "hacc/operations/worker/v1", worker.parentWorkerId),
        status: publicStatus,
        kernelStatus: publicKernelStatus,
        deliveryState,
        policyEpoch: worker.authority.policyEpoch,
        staleAuthority: !terminal && (
          worker.authority.policyEpoch === null
          || (kernelPolicyEpoch !== null && worker.authority.policyEpoch !== kernelPolicyEpoch)
        ),
        leaseState: leaseExpiryMs === null ? "none" : leaseExpiryMs > input.generatedAtMs ? "active" : "expired",
        cancellationEpoch: worker.cancellationEpoch,
        checkpointPresent: worker.checkpointPresent ?? (worker.checkpoint !== null && worker.checkpoint !== undefined),
        resultPresent: worker.resultPresent ?? (worker.result !== null && worker.result !== undefined),
        errorPresent: worker.errorPresent ?? (worker.error !== null && worker.error !== undefined),
        settledAtMs,
      } as const);
    });
  const durableWorkerStatuses = durableWorkers.map(({ status }) =>
    normalizePublicWorkerStatus(status));
  const durableWorkerDeliveryStates = allWorkerItems.map(({ deliveryState }) =>
    deliveryState);
  const projectedDurableWorkerSummary = input.durableWorkerSummary
    ? {
        total: input.durableWorkerSummary.total,
        byStatus: validateAndNormalizeCountRecord(
          input.durableWorkerSummary.byStatus,
          input.durableWorkerSummary.total,
          "durable worker summary",
          normalizePublicWorkerStatus,
        ),
        byDeliveryState: input.durableWorkerSummary.byDeliveryState
          ? validateAndNormalizeCountRecord(
              input.durableWorkerSummary.byDeliveryState,
              input.durableWorkerSummary.total,
              "durable worker delivery summary",
              (state) => normalizeClosedCode(state, PUBLIC_WORKER_DELIVERY_STATES),
            )
          : input.durableWorkerSummary.total === durableWorkers.length
            ? freezeCounts(durableWorkerDeliveryStates)
            : null,
      }
    : {
        total: durableWorkers.length,
        byStatus: freezeCounts(durableWorkerStatuses),
        byDeliveryState: freezeCounts(durableWorkerDeliveryStates),
      };
  if (projectedDurableWorkerSummary.total > MAX_OBSERVATIONS) {
    throw new Error(`durable worker summary exceeds ${MAX_OBSERVATIONS} workers`);
  }
  if (projectedDurableWorkerSummary.byDeliveryState === null) {
    throw new Error("complete durable worker delivery summary is required for a bounded detail window");
  }
  if (projectedDurableWorkerSummary.total < durableWorkers.length) {
    throw new Error("durable worker summary is smaller than its projected worker items");
  }
  for (const [status, count] of Object.entries(freezeCounts(durableWorkerStatuses))) {
    if ((projectedDurableWorkerSummary.byStatus[status] ?? 0) < count) {
      throw new Error("durable worker summary contradicts its projected worker items");
    }
  }
  for (const [state, count] of Object.entries(freezeCounts(durableWorkerDeliveryStates))) {
    if ((projectedDurableWorkerSummary.byDeliveryState[state] ?? 0) < count) {
      throw new Error("durable worker delivery summary contradicts its projected worker items");
    }
  }
  if (
    durableWorkerIds === undefined
    && kernelWorkers.size > 0
    && projectedDurableWorkerSummary.total > projectedDurableIds.length
  ) {
    throw new Error("complete durable worker identity index is required for a bounded detail window");
  }
  const completeDurableIds = durableWorkerIds ?? projectedDurableIds;
  if (
    completeDurableIds.some((id) => !id || id.length > 2_048)
    || new Set(completeDurableIds).size !== completeDurableIds.length
    || (durableWorkerIds !== undefined
      && completeDurableIds.length !== projectedDurableWorkerSummary.total)
  ) {
    throw new Error("durable worker identity index must exactly cover the durable worker summary");
  }
  const completeDurableIdSet = new Set(completeDurableIds);
  if (projectedDurableIds.some((id) => !completeDurableIdSet.has(id))) {
    throw new Error("durable worker identity index omits a projected worker item");
  }
  for (const worker of kernelWorkers.values()) {
    if (completeDurableIdSet.has(worker.workerId)) continue;
    const publicKernelStatus = normalizePublicKernelWorkerStatus(worker.status);
    const terminal = publicKernelStatus === "completed" || publicKernelStatus === "cancelled";
    const publicStatus = normalizePublicWorkerStatus(worker.status);
    kernelOnlyWorkerStatuses.push(publicStatus);
    allWorkerItems.push(Object.freeze({
      workerKey: hmac(input.redactionKey, "hacc/operations/worker/v1", worker.workerId),
      parentWorkerKey: null,
      status: publicStatus,
      kernelStatus: publicKernelStatus,
      deliveryState: publicKernelStatus === "completed" ? "delivered" : terminal ? "terminal" : "not_settled",
      policyEpoch: worker.policyEpoch,
      staleAuthority: kernelPolicyEpoch !== null && !terminal && worker.policyEpoch !== kernelPolicyEpoch,
      leaseState: "none",
      cancellationEpoch: 0,
      checkpointPresent: false,
      resultPresent: false,
      errorPresent: false,
      settledAtMs: null,
    }));
  }
  const workerItems = allWorkerItems
    .sort((left, right) => left.workerKey.localeCompare(right.workerKey))
    .slice(0, MAX_REDACTED_ITEMS);
  const combinedWorkerCounts: Record<string, number> = { ...projectedDurableWorkerSummary.byStatus };
  const combinedWorkerDeliveryCounts: Record<string, number> = {
    ...projectedDurableWorkerSummary.byDeliveryState,
  };
  for (const status of kernelOnlyWorkerStatuses) {
    combinedWorkerCounts[status] = (combinedWorkerCounts[status] ?? 0) + 1;
  }
  for (const worker of allWorkerItems.slice(durableWorkers.length)) {
    combinedWorkerDeliveryCounts[worker.deliveryState] =
      (combinedWorkerDeliveryCounts[worker.deliveryState] ?? 0) + 1;
  }
  const projectedWorkerSummary = {
    total: projectedDurableWorkerSummary.total + kernelOnlyWorkerStatuses.length,
    byStatus: Object.freeze(Object.fromEntries(
      Object.entries(combinedWorkerCounts).sort(([left], [right]) => left.localeCompare(right)),
    )),
    byDeliveryState: Object.freeze(Object.fromEntries(
      Object.entries(combinedWorkerDeliveryCounts)
        .sort(([left], [right]) => left.localeCompare(right)),
    )),
  };

  const responseTimings = new Map<string, {
    start?: ReturnType<typeof eventClock>;
    firstOutput?: ReturnType<typeof eventClock>;
    complete?: ReturnType<typeof eventClock>;
  }>();
  for (const event of [...events].sort((left, right) => left.receivedAtMs - right.receivedAtMs)) {
    const responseId = "responseId" in event && typeof event.responseId === "string" ? event.responseId : null;
    if (responseId === null) continue;
    const key = `${event.provider}:${responseId}`;
    const timing = responseTimings.get(key) ?? {};
    if (event.type === "response.started") timing.start ??= eventClock(event);
    if ((event.type === "output.audio" || event.type === "output.transcript") && timing.firstOutput === undefined) {
      timing.firstOutput = eventClock(event);
    }
    if (event.type === "response.completed") timing.complete = eventClock(event);
    responseTimings.set(key, timing);
  }
  const elapsed = (
    start: ReturnType<typeof eventClock> | undefined,
    end: ReturnType<typeof eventClock> | undefined,
  ): number | null => start && end && start.basis === end.basis && end.value >= start.value
    ? Math.round(end.value - start.value)
    : null;
  const firstOutputSamples = [...responseTimings.values()].flatMap((item) => {
    const sample = elapsed(item.start, item.firstOutput);
    return sample === null ? [] : [sample];
  });
  const completionSamples = [...responseTimings.values()].flatMap((item) => {
    const sample = elapsed(item.start, item.complete);
    return sample === null ? [] : [sample];
  });
  const settlementSamples = receipts.flatMap((receipt) => {
    if (!receipt.dispatchStartedAt || !receipt.settledAt) return [];
    const started = Date.parse(receipt.dispatchStartedAt);
    const settled = Date.parse(receipt.settledAt);
    return Number.isFinite(started) && Number.isFinite(settled) && settled >= started ? [settled - started] : [];
  });

  const sortedPackets = [...packets].sort((left, right) => left.observedAtMs - right.observedAtMs);
  const latestPacketObservation = sortedPackets.at(-1)?.packet ?? null;

  // Provider usage may be revised or session-cumulative. Keep only the newest
  // observation for each provider/scope/identity before aggregating.
  const usageByScope = new Map<string, Extract<NormalizedRealtimeEvent, { type: "usage" }>>();
  for (const event of events) {
    if (event.type !== "usage") continue;
    const identity = event.responseId ?? event.itemId ?? event.turnId ?? "session";
    const epoch = event.wireObservation?.availability === "observed"
      ? event.wireObservation.connectionEpoch
      : "unattributed";
    const key = `${event.provider}:${epoch}:${event.scope ?? "response"}:${identity}`;
    const prior = usageByScope.get(key);
    if (!prior || event.receivedAtMs >= prior.receivedAtMs) usageByScope.set(key, event);
  }
  const usageObservations = [...usageByScope.values()];

  const latestCosts = new Map<string, CallCostObservation>();
  for (const observation of costs) {
    if (!observation.scopeId || observation.scopeId.length > 2_048) throw new Error("cost scope must be bounded");
    assertSafeInteger(observation.microUsd, "cost observation");
    assertSafeInteger(observation.observedAtMs, "cost observation timestamp");
    const key = `${observation.scopeId}\0${observation.source}`;
    const prior = latestCosts.get(key);
    if (!prior || observation.observedAtMs >= prior.observedAtMs) latestCosts.set(key, observation);
  }
  const costScopes = new Map<string, Partial<Record<CallCostObservation["source"], number>>>();
  for (const observation of latestCosts.values()) {
    const scope = costScopes.get(observation.scopeId) ?? {};
    scope[observation.source] = observation.microUsd;
    costScopes.set(observation.scopeId, scope);
  }
  const costTotal = (source: CallCostObservation["source"]): number | null => {
    const values = [...costScopes.values()].flatMap((scope) =>
      scope[source] === undefined ? [] : [scope[source] as number]);
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
  };
  const sources = new Set([...latestCosts.values()].map(({ source }) => source));
  const coverage = sources.size === 0
    ? "none"
    : sources.size > 1
      ? "mixed"
      : sources.has("reconciled")
        ? "reconciled"
        : sources.has("provider_reported")
          ? "provider_reported"
          : "estimated";
  const everyScopeReconciled = costScopes.size > 0
    && [...costScopes.values()].every((scope) => scope.reconciled !== undefined);
  const reconciledMicroUsd = costTotal("reconciled");

  const sourceMap = new Map<OperationsSourceObservation["source"], number | null>();
  for (const observation of sourceObservations) {
    if (sourceMap.has(observation.source)) throw new Error("operations source observations contain a duplicate source");
    if (observation.observedAtMs !== null) {
      assertSafeInteger(observation.observedAtMs, "operations source timestamp");
    }
    sourceMap.set(observation.source, observation.observedAtMs);
  }
  const recoveryFreshness = new Map<OperationsSourceObservation["source"], number>();
  for (const observation of recoveryObservations) {
    if (!observation.subjectId || observation.subjectId.length > 2_048) {
      throw new Error("recovery subject identity must be bounded");
    }
    assertSafeInteger(observation.observedAtMs, "recovery observation timestamp");
    const publicKind = normalizeClosedCode(
      observation.kind,
      PUBLIC_RECOVERY_KINDS,
    );
    const source = publicKind === "action_reconciled"
      ? "flow"
      : publicKind === "redacted_unknown"
        ? null
        : "workers";
    if (source === null) continue;
    recoveryFreshness.set(
      source,
      Math.max(recoveryFreshness.get(source) ?? 0, observation.observedAtMs),
    );
  }
  const activeCall = publicCallStatus === "active" || publicCallStatus === "dialing";
  const terminalCall = publicCallStatus === "completed" || publicCallStatus === "failed";
  const freshnessSources = (["flow", "conversation", "workers", "policy"] as const).map((source) => {
    const sourceObservedAtMs = sourceMap.get(source) ?? null;
    const recoveryObservedAtMs = recoveryFreshness.get(source) ?? null;
    const observedAtMs = sourceObservedAtMs === null
      ? recoveryObservedAtMs
      : recoveryObservedAtMs === null
        ? sourceObservedAtMs
        : Math.max(sourceObservedAtMs, recoveryObservedAtMs);
    const ageMs = observedAtMs === null ? null : Math.max(0, input.generatedAtMs - observedAtMs);
    return Object.freeze({
      source,
      observedAtMs,
      ageMs,
      state: observedAtMs === null
        ? "unavailable"
        : terminalCall
          ? "settled"
          : (ageMs ?? 0) > sourceStaleAfterMs
            ? "stale"
            : "current",
    } as const);
  });
  const staleSources = freshnessSources
    .filter(({ state }) => state === "stale")
    .map(({ source }) => source);
  const observedAges = freshnessSources.flatMap(({ ageMs }) => ageMs === null ? [] : [ageMs]);

  const recoveryItems = [...recoveryObservations]
    .map((observation) => {
      const publicKind = normalizeClosedCode(
        observation.kind,
        PUBLIC_RECOVERY_KINDS,
      ) as PublicRecoveryKind;
      return Object.freeze({
        kind: publicKind,
        subjectKey: hmac(
          input.redactionKey,
          `hacc/operations/recovery/${publicKind}/v1`,
          observation.subjectId,
        ),
        observedAtMs: observation.observedAtMs,
      });
    })
    .sort((left, right) => right.observedAtMs - left.observedAtMs
      || left.kind.localeCompare(right.kind)
      || left.subjectKey.localeCompare(right.subjectKey))
    .slice(0, MAX_REDACTED_ITEMS);
  const observedRecoveryCounts = freezeCounts(recoveryObservations.map(({ kind }) =>
    normalizeClosedCode(kind, PUBLIC_RECOVERY_KINDS)));
  const projectedRecoverySummary = input.recoverySummary
    ? {
        observations: input.recoverySummary.observations,
        byKind: validateAndNormalizeCountRecord(
          input.recoverySummary.byKind,
          input.recoverySummary.observations,
          "recovery summary",
          (kind) => normalizeClosedCode(kind, PUBLIC_RECOVERY_KINDS),
        ),
        lastObservedAtMs: input.recoverySummary.lastObservedAtMs,
      }
    : {
        observations: recoveryObservations.length,
        byKind: observedRecoveryCounts,
        lastObservedAtMs: recoveryObservations.length === 0
          ? null
          : Math.max(...recoveryObservations.map(({ observedAtMs }) => observedAtMs)),
      };
  if (
    projectedRecoverySummary.observations < recoveryObservations.length
    || (projectedRecoverySummary.lastObservedAtMs !== null
      && (!Number.isSafeInteger(projectedRecoverySummary.lastObservedAtMs)
        || projectedRecoverySummary.lastObservedAtMs < 0))
    || (projectedRecoverySummary.observations === 0) !== (projectedRecoverySummary.lastObservedAtMs === null)
  ) {
    throw new Error("recovery summary contradicts its projected observations");
  }
  for (const [kind, count] of Object.entries(observedRecoveryCounts)) {
    if ((projectedRecoverySummary.byKind[kind] ?? 0) < count) {
      throw new Error("recovery summary contradicts its projected observations");
    }
  }
  const latestProjectedRecovery = recoveryItems.at(0)?.observedAtMs ?? null;
  if (
    latestProjectedRecovery !== null
    && (projectedRecoverySummary.lastObservedAtMs === null
      || projectedRecoverySummary.lastObservedAtMs < latestProjectedRecovery)
  ) {
    throw new Error("recovery summary last observation predates its projected observations");
  }

  const attention = new Set<CallOperationsProjection["attention"][number]>();
  if (connectionEpochs.some(({ failureObserved }) => failureObserved)) attention.add("connection_failure");
  if (connectionEpochs.some(({ closeObserved, cleanClose }) => closeObserved && cleanClose !== true)) {
    attention.add("unclean_connection_close");
  }
  if (authorityDrift.size > 0) attention.add("authority_drift");
  if (projectedPolicySummary.denials > 0) attention.add("policy_denial");
  if ((projectedActionSummary.byStatus.indeterminate ?? 0) > 0) {
    attention.add("indeterminate_action");
  }
  if ((projectedWorkerSummary.byStatus.indeterminate ?? 0) > 0) attention.add("indeterminate_worker");
  if ((projectedWorkerSummary.byDeliveryState.awaiting_delivery ?? 0) > 0) {
    attention.add("worker_delivery_pending");
  }
  if (staleSources.length > 0) attention.add("stale_operations_source");
  if (sortedPackets.some(({ packet }) => packet.value.omittedRecentTurnCount > 0)) attention.add("context_turns_omitted");
  if (costScopes.size > 0 && !everyScopeReconciled) attention.add("cost_not_reconciled");

  return Object.freeze({
    schemaVersion: 1,
    generatedAtMs: input.generatedAtMs,
    callKey,
    providers: Object.freeze(providers),
    connections: Object.freeze({
      count: connectionEpochs.length,
      ready: connectionEpochs.filter(({ state }) => state === "ready").length,
      failed: connectionEpochs.filter(({ failureObserved }) => failureObserved).length,
      closed: connectionEpochs.filter(({ closeObserved }) => closeObserved).length,
      uncleanClosed: connectionEpochs.filter(({ closeObserved, cleanClose }) => closeObserved && cleanClose !== true).length,
      epochs: Object.freeze(connectionDetails),
    }),
    authority: Object.freeze({
      conversationRevision: input.conversationAuthority?.revision
        ?? input.conversationState?.eventCount
        ?? latestPacket?.value.authority.conversationRevision
        ?? null,
      conversationHeadSha256: input.conversationAuthority?.headSha256
        ?? input.conversationState?.headHash
        ?? latestPacket?.value.authority.conversationHeadSha256
        ?? null,
      policyEpoch: kernelPolicyEpoch,
      capabilityEpoch: flowCapabilityEpoch,
      observedPolicyEpochs: Object.freeze([...observedPolicyEpochs].sort((left, right) => left - right)),
      observedCapabilityEpochs: Object.freeze([...observedCapabilityEpochs].sort((left, right) => left - right)),
      catalogDigests: Object.freeze([...catalogDigests].sort()),
      flowRevision: input.flowState?.revision ?? input.conversationState?.currentFlowCheckpoint?.flowRevision ?? null,
      drift: Object.freeze([...authorityDrift].sort()),
    }),
    policy: Object.freeze({
      observations: projectedPolicySummary.observations,
      denials: projectedPolicySummary.denials,
      byDecision: projectedPolicySummary.byDecision,
      recentDenials: Object.freeze(denialItems),
    }),
    actions: Object.freeze({
      total: projectedActionSummary.total,
      byStatus: projectedActionSummary.byStatus,
      indeterminate: Object.freeze(indeterminateReceipts),
    }),
    workers: Object.freeze({
      total: projectedWorkerSummary.total,
      byStatus: projectedWorkerSummary.byStatus,
      byDeliveryState: projectedWorkerSummary.byDeliveryState,
      items: Object.freeze(workerItems),
    }),
    freshness: Object.freeze({
      callStatus: publicCallStatus,
      active: activeCall,
      staleAfterMs: sourceStaleAfterMs,
      maximumAgeMs: observedAges.length === 0 ? null : Math.max(...observedAges),
      staleSources: Object.freeze(staleSources),
      sources: Object.freeze(freshnessSources),
    }),
    recovery: Object.freeze({
      observations: projectedRecoverySummary.observations,
      byKind: projectedRecoverySummary.byKind,
      lastObservedAtMs: projectedRecoverySummary.lastObservedAtMs,
      recent: Object.freeze(recoveryItems),
    }),
    context: Object.freeze({
      packetCount: sortedPackets.length,
      latestPacketBytes: latestPacketObservation?.byteLength ?? null,
      maximumPacketBytes: sortedPackets.length === 0
        ? null
        : Math.max(...sortedPackets.map(({ packet }) => packet.byteLength)),
      latestDurableBytes: latestPacketObservation === null
        ? null
        : Buffer.byteLength(JSON.stringify(latestPacketObservation.value.durable), "utf8"),
      omittedRecentTurns: latestPacketObservation?.value.omittedRecentTurnCount ?? 0,
      maximumOmittedRecentTurns: sortedPackets.length === 0
        ? 0
        : Math.max(...sortedPackets.map(({ packet }) => packet.value.omittedRecentTurnCount)),
    }),
    latencyMs: Object.freeze({
      firstOutput: distribution(firstOutputSamples),
      responseCompletion: distribution(completionSamples),
      actionSettlement: distribution(settlementSamples),
    }),
    usage: Object.freeze({
      eventCount: usageObservations.length,
      inputTextTokens: sumOptionalUsage(usageObservations, "inputTextTokens"),
      inputAudioTokens: sumOptionalUsage(usageObservations, "inputAudioTokens"),
      cachedInputTokens: sumOptionalUsage(usageObservations, "cachedInputTokens"),
      outputTextTokens: sumOptionalUsage(usageObservations, "outputTextTokens"),
      outputAudioTokens: sumOptionalUsage(usageObservations, "outputAudioTokens"),
      totalTokens: sumOptionalUsage(usageObservations, "totalTokens"),
      inputAudioMinutes: sumOptionalUsage(usageObservations, "inputAudioMinutes"),
      outputAudioMinutes: sumOptionalUsage(usageObservations, "outputAudioMinutes"),
      billableTextInputEvents: sumOptionalUsage(usageObservations, "billableTextInputEvents"),
    }),
    cost: Object.freeze({
      scopeCount: costScopes.size,
      coverage,
      estimatedMicroUsd: costTotal("estimated"),
      providerReportedMicroUsd: costTotal("provider_reported"),
      reconciledMicroUsd,
      settledMicroUsd: everyScopeReconciled ? reconciledMicroUsd : null,
    }),
    attention: Object.freeze([...attention].sort()),
  });
}

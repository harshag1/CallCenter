import { createHmac } from "node:crypto";
import type {
  NormalizedRealtimeEvent,
  NormalizedRealtimeUsage,
  RealtimeWireObservation,
  ServerRealtimeProvider,
} from "./realtime/client/types";
import type { ConversationState } from "./conversation-kernel";
import type { FlowExecutionState } from "./flow-runtime";
import type { PreDispatchDecision, PostDispatchDecision } from "./action-policy-kernel";
import type { CompiledRealtimeContextPacket } from "./realtime-context-packet";
import type { DurableVoiceWorker } from "./voice-workers/store";

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

type FrozenRecord = Readonly<Record<string, number>>;

export type PolicyDecisionObservation =
  | Readonly<{ stage: "pre_dispatch"; observedAtMs: number; decision: PreDispatchDecision }>
  | Readonly<{ stage: "post_dispatch"; observedAtMs: number; decision: PostDispatchDecision }>;

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

export type CallOperationsProjectionInput = Readonly<{
  callId: string;
  /** Per-tenant secret used only for irreversible HMAC identities in this projection. */
  redactionKey: string | Uint8Array;
  generatedAtMs: number;
  realtimeEvents?: readonly NormalizedRealtimeEvent[];
  wireObservations?: readonly RealtimeWireObservation[];
  conversationState?: ConversationState;
  flowState?: Pick<
    FlowExecutionState,
    "status" | "nodeId" | "currentStep" | "completedSteps" | "capabilityEpoch" | "revision" | "actionReceipts"
  >;
  policyDecisions?: readonly PolicyDecisionObservation[];
  durableWorkers?: readonly DurableVoiceWorker[];
  contextPackets?: readonly ContextPacketObservation[];
  costObservations?: readonly CallCostObservation[];
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
      | "packet_policy_vs_kernel"
      | "packet_capability_vs_flow"
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
    items: readonly Readonly<{
      workerKey: string;
      parentWorkerKey: string | null;
      status: string;
      kernelStatus: "running" | "completed" | "cancelled" | null;
      deliveryState: "not_settled" | "awaiting_delivery" | "delivered" | "terminal";
      policyEpoch: number;
      staleAuthority: boolean;
      leaseState: "none" | "active" | "expired";
      cancellationEpoch: number;
      checkpointPresent: boolean;
      resultPresent: boolean;
      errorPresent: boolean;
      settledAtMs: number | null;
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

function policyReasonCode(value: string): string | null {
  return POLICY_REASON_CODES.has(value) ? value : null;
}

function freezeCounts(values: readonly string[]): FrozenRecord {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.freeze(Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))));
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

  const events = input.realtimeEvents ?? [];
  const wires = input.wireObservations ?? [];
  const decisions = input.policyDecisions ?? [];
  const packets = input.contextPackets ?? [];
  const costs = input.costObservations ?? [];
  const durableWorkers = input.durableWorkers ?? [];
  assertBounded(events, "realtime events");
  assertBounded(wires, "wire observations");
  assertBounded(decisions, "policy decisions");
  assertBounded(packets, "context packets");
  assertBounded(costs, "cost observations");
  assertBounded(durableWorkers, "durable workers");

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
    addUniqueNumber(observedPolicyEpochs, authority.policyEpoch);
    addUniqueNumber(observedCapabilityEpochs, authority.capabilityEpoch);
    if (!SHA256.test(authority.capabilityCatalogDigest)) throw new Error("context packet catalog digest must be SHA-256");
    catalogDigests.add(authority.capabilityCatalogDigest);
  }
  if (input.conversationState) {
    addUniqueNumber(observedPolicyEpochs, input.conversationState.policy.epoch);
    for (const checkpoint of input.conversationState.flowCheckpoints) {
      addUniqueNumber(observedCapabilityEpochs, checkpoint.capabilityEpoch);
    }
  }
  if (input.flowState) {
    addUniqueNumber(observedCapabilityEpochs, input.flowState.capabilityEpoch);
    for (const receipt of input.flowState.actionReceipts) {
      addUniqueNumber(observedCapabilityEpochs, receipt.capabilityEpoch);
    }
  }
  for (const worker of durableWorkers) addUniqueNumber(observedPolicyEpochs, worker.authority.policyEpoch);

  const latestPacket = [...packets].sort((left, right) => right.observedAtMs - left.observedAtMs)[0]?.packet ?? null;
  const kernelPolicyEpoch = input.conversationState?.policy.epoch ?? latestPacket?.value.authority.policyEpoch ?? null;
  const flowCapabilityEpoch = input.flowState?.capabilityEpoch
    ?? input.conversationState?.currentFlowCheckpoint?.capabilityEpoch
    ?? latestPacket?.value.authority.capabilityEpoch
    ?? null;
  const authorityDrift = new Set<CallOperationsProjection["authority"]["drift"][number]>();
  if (latestPacket && input.conversationState
    && latestPacket.value.authority.policyEpoch !== input.conversationState.policy.epoch) {
    authorityDrift.add("packet_policy_vs_kernel");
  }
  if (latestPacket && input.flowState
    && latestPacket.value.authority.capabilityEpoch !== input.flowState.capabilityEpoch) {
    authorityDrift.add("packet_capability_vs_flow");
  }
  if (kernelPolicyEpoch !== null
    && durableWorkers.some((worker) =>
      !["succeeded", "failed", "cancelled"].includes(worker.status)
      && worker.authority.policyEpoch !== kernelPolicyEpoch)) {
    authorityDrift.add("worker_policy_stale");
  }
  if (flowCapabilityEpoch !== null
    && (input.flowState?.actionReceipts ?? []).some((receipt) => receipt.capabilityEpoch > flowCapabilityEpoch)) {
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
        decision: observation.decision.decision,
        reasonCode: policyReasonCode(reason),
        reasonSha256: hmac(input.redactionKey, "hacc/operations/policy-reason/v1", reason),
        actionKey: action === null ? null : hmac(input.redactionKey, "hacc/operations/action/v1", action),
        observedAtMs: observation.observedAtMs,
      });
    });

  const receipts = input.flowState?.actionReceipts ?? [];
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
  const durableWorkerIds = new Set(durableWorkers.map(({ id }) => id));
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
      const terminal = ["succeeded", "failed", "cancelled", "indeterminate"].includes(worker.status);
      const deliveryState = kernel?.status === "completed"
        ? "delivered"
        : worker.status === "succeeded"
          ? "awaiting_delivery"
          : terminal
            ? "terminal"
            : "not_settled";
      return Object.freeze({
        workerKey: hmac(input.redactionKey, "hacc/operations/worker/v1", worker.id),
        parentWorkerKey: worker.parentWorkerId === null
          ? null
          : hmac(input.redactionKey, "hacc/operations/worker/v1", worker.parentWorkerId),
        status: worker.status,
        kernelStatus: kernel?.status ?? null,
        deliveryState,
        policyEpoch: worker.authority.policyEpoch,
        staleAuthority: kernelPolicyEpoch !== null && !terminal && worker.authority.policyEpoch !== kernelPolicyEpoch,
        leaseState: leaseExpiryMs === null ? "none" : leaseExpiryMs > input.generatedAtMs ? "active" : "expired",
        cancellationEpoch: worker.cancellationEpoch,
        checkpointPresent: worker.checkpoint !== null,
        resultPresent: worker.result !== null,
        errorPresent: worker.error !== null,
        settledAtMs,
      } as const);
    });
  for (const worker of kernelWorkers.values()) {
    if (durableWorkerIds.has(worker.workerId)) continue;
    const terminal = worker.status !== "running";
    allWorkerItems.push(Object.freeze({
      workerKey: hmac(input.redactionKey, "hacc/operations/worker/v1", worker.workerId),
      parentWorkerKey: null,
      status: worker.status,
      kernelStatus: worker.status,
      deliveryState: worker.status === "completed" ? "delivered" : terminal ? "terminal" : "not_settled",
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
  const allWorkerStatuses = allWorkerItems.map(({ status }) => status);

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

  const attention = new Set<CallOperationsProjection["attention"][number]>();
  if (connectionEpochs.some(({ failureObserved }) => failureObserved)) attention.add("connection_failure");
  if (connectionEpochs.some(({ closeObserved, cleanClose }) => closeObserved && cleanClose !== true)) {
    attention.add("unclean_connection_close");
  }
  if (authorityDrift.size > 0) attention.add("authority_drift");
  if (denialItems.length > 0) attention.add("policy_denial");
  if (indeterminateReceipts.length > 0) attention.add("indeterminate_action");
  if (workerItems.some(({ status }) => status === "indeterminate")) attention.add("indeterminate_worker");
  if (workerItems.some(({ deliveryState }) => deliveryState === "awaiting_delivery")) attention.add("worker_delivery_pending");
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
      conversationRevision: input.conversationState?.eventCount
        ?? latestPacket?.value.authority.conversationRevision
        ?? null,
      conversationHeadSha256: input.conversationState?.headHash
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
      observations: decisions.length,
      denials: deniedDecisions.length,
      byDecision: freezeCounts(decisions.map(({ decision }) => decision.decision)),
      recentDenials: Object.freeze(denialItems),
    }),
    actions: Object.freeze({
      total: receipts.length,
      byStatus: freezeCounts(receipts.map(({ status }) => status)),
      indeterminate: Object.freeze(indeterminateReceipts),
    }),
    workers: Object.freeze({
      total: allWorkerItems.length,
      byStatus: freezeCounts(allWorkerStatuses),
      items: Object.freeze(workerItems),
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

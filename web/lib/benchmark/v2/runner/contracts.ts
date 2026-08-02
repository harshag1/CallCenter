import type {
  CompiledCondition,
  JsonValue,
  ProviderIdentity,
  ScheduledUnit,
  TerminalLedgerEntry,
} from "./types";
import { canonicalJson, sha256Hex } from "../../artifacts";
import type { RealtimeLifecycleConformanceReport } from "../../../realtime/conformance-v2";
import type { EvidenceObservationV2 } from "./evidence-authority";
import type { PaidBillingEvidence } from "./budget";

const CALLER_PLAN_DOMAIN = "harshas-amazing-call-center/hacc-proof-v1/caller-plan\n";
const PROVIDER_ACK_DOMAIN = "harshas-amazing-call-center/hacc-proof-v1/provider-ack\n";

export type CallerAction = Readonly<{
  action_id: string;
  at_ms: number;
  kind: "audio" | "interrupt" | "disconnect" | "world_event";
  payload_sha256: string;
}>;

export function callerPlanSha256(actions: readonly CallerAction[]): string {
  return sha256Hex(`${CALLER_PLAN_DOMAIN}${canonicalJson(actions)}`);
}

export interface CallerScheduler {
  compile(unit: ScheduledUnit): Readonly<{
    caller_plan_sha256: string;
    actions: readonly CallerAction[];
  }>;
}

export type ProviderAcknowledgement = Readonly<{
  identity: ProviderIdentity;
  conformance_version: "HACC-Proof-Provider-v1";
  supports_one_shot_sessions: true;
  acknowledgement_sha256: string;
}>;

export function providerAcknowledgementSha256(
  acknowledgement: Omit<ProviderAcknowledgement, "acknowledgement_sha256">,
): string {
  return sha256Hex(`${PROVIDER_ACK_DOMAIN}${canonicalJson(acknowledgement)}`);
}

export type ProviderRawEvent = Readonly<{
  event_type: string;
  observed_at: string;
  payload: JsonValue;
}>;

export type ProviderRunResult = Readonly<{
  disposition: "completed" | "failed" | "ambiguous";
  estimated_micro_usd: number;
  reason?: string;
}>;

export interface OneShotProviderSession {
  readonly session_id: string;
  run(
    actions: readonly CallerAction[],
    observe: (event: ProviderRawEvent) => void,
  ): Promise<ProviderRunResult>;
  close(): Promise<void>;
}

/** Deliberately has no retry, reconnect, or fallback method. */
export interface ProviderConformanceAdapter {
  readonly provider: string;
  preflight(identity: ProviderIdentity): Promise<ProviderAcknowledgement>;
  open(condition: CompiledCondition): Promise<OneShotProviderSession>;
}

export type PaidProviderRunResult = ProviderRunResult & Readonly<{
  billing: PaidBillingEvidence;
}>;

export interface PaidOneShotProviderSession {
  readonly session_id: string;
  run(
    actions: readonly CallerAction[],
    observe: (event: EvidenceObservationV2) => void,
  ): Promise<PaidProviderRunResult>;
  close(): Promise<void>;
}

/** No fallback/retry/reconnect surface is exposed to paid orchestration. */
export interface PaidProviderConformanceAdapter {
  readonly provider: string;
  paidReadinessReport(identity: ProviderIdentity): Promise<RealtimeLifecycleConformanceReport>;
  openPaid(condition: CompiledCondition): Promise<PaidOneShotProviderSession>;
}

export type EvaluationResult = Readonly<{
  schema_version: 1;
  evaluator_id: string;
  scores: JsonValue;
}>;

export interface FrozenEvaluator {
  evaluate(input: Readonly<{
    raw_evidence_sha256: string;
    raw_events: readonly JsonValue[];
    itt_ledger: readonly TerminalLedgerEntry[];
  }>): Promise<EvaluationResult>;
}

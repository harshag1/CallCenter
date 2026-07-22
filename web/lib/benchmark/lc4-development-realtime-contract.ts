import type { Lc4CapturedOutput } from "./lc4-listener-evidence";
import type { Lc4DevArmBlindRepairProjection } from "./lc4-development-headless-listener-authority";
import type { Lc4DevRepairDecisionReceipt, Lc4DevRepairPlayback } from "./lc4-development-repair-playback";
import type { Lc4DevControlReceipt, Lc4DevLiveEpisodePlan } from "./lc4-development-live-runner";
import type { Lc4PublicDevOpportunity } from "./lc4-public-development-corpus";

export type Lc4DevExchangeEvidence = Readonly<{
  playback_kind: "canonical" | "repair";
  opportunity_id: string;
  assistant_pcm: Uint8Array;
  provider_exchange_sha256: string;
  listener_evidence_sha256: string;
  repair_projection: Lc4DevArmBlindRepairProjection;
  playback_authority_receipt_sha256: string;
}>;

export type Lc4DevelopmentRealtimeSession = Readonly<{
  exchangeCanonical(input: Readonly<{
    opportunity: Lc4PublicDevOpportunity;
    caller_pcm: Uint8Array;
    control_receipt: Lc4DevControlReceipt;
  }>): Promise<Lc4DevExchangeEvidence>;
  exchangeRepair(input: Readonly<{
    opportunity: Lc4PublicDevOpportunity;
    repair: Lc4DevRepairPlayback;
    decision_receipt: Lc4DevRepairDecisionReceipt;
    control_receipt: Lc4DevControlReceipt;
  }>): Promise<Lc4DevExchangeEvidence>;
  finalizeOpportunity(input: Readonly<{
    opportunity_id: string;
    decision_receipt_sha256: string;
    repair_played: boolean;
  }>): Promise<Readonly<{ opportunity_receipt_sha256: string }>>;
  close(): Promise<Readonly<{ rotation_receipt_sha256: string }>>;
}>;

export type Lc4DevelopmentRealtimeAdapter = Readonly<{
  kind: "lc4-development-realtime-v1";
  factory_id: "lc4-production-provider-adapter/dev-authorized-v1";
  preflight_sha256: string;
  maximum_total_micro_usd: number;
  openSegment(input: Readonly<{
    episode: Lc4DevLiveEpisodePlan;
    segment_ordinal: 1 | 2 | 3;
    previous_rotation_receipt_sha256: string | null;
  }>): Promise<Lc4DevelopmentRealtimeSession>;
}>;

export type Lc4DevelopmentListenerSink = Readonly<{
  accept(input: Readonly<{
    episode: Lc4DevLiveEpisodePlan;
    opportunity: Lc4PublicDevOpportunity;
    capture: Lc4CapturedOutput;
    response_plan_sha256: string | null;
    wire_observation_set_sha256: string;
  }>): Promise<Readonly<{
    listener_evidence_sha256: string;
    repair_projection: Lc4DevArmBlindRepairProjection;
    playback_authority_receipt_sha256: string;
  }>>;
}>;

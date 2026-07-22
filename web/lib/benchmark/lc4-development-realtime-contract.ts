import type { Lc4CapturedOutput } from "./lc4-listener-evidence";
import type { Lc4DevControlReceipt, Lc4DevLiveEpisodePlan } from "./lc4-development-live-runner";
import type { Lc4PublicDevOpportunity } from "./lc4-public-development-corpus";

export type Lc4DevExchangeEvidence = Readonly<{
  opportunity_id: string;
  assistant_pcm: Uint8Array;
  provider_exchange_sha256: string;
  listener_evidence_sha256: string;
}>;

export type Lc4DevelopmentRealtimeSession = Readonly<{
  exchange(input: Readonly<{
    opportunity: Lc4PublicDevOpportunity;
    caller_pcm: Uint8Array;
    control_receipt: Lc4DevControlReceipt;
  }>): Promise<Lc4DevExchangeEvidence>;
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
  }>): Promise<Readonly<{ listener_evidence_sha256: string }>>;
}>;

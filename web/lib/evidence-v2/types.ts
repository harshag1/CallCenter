import type { JsonValue } from "./canonical";

export const EVIDENCE_EVENT_TYPES = Object.freeze([
  "plan.registered",
  "catalog.published",
  "provider.normalized",
  "action.attempted",
  "action.policy_decided",
  "action.receipt",
  "worker.event",
  "audio.range",
  "playback.range",
  "world.event",
  "usage.recorded",
  "journal.terminal",
] as const);

export type EvidenceEventTypeV2 = typeof EVIDENCE_EVENT_TYPES[number];
export type EvidenceCategoryV2 =
  | "plans"
  | "catalogs"
  | "provider"
  | "actions"
  | "workers"
  | "audio"
  | "playback"
  | "world"
  | "usage"
  | "terminal";

export const EVIDENCE_CATEGORIES = Object.freeze([
  "plans", "catalogs", "provider", "actions", "workers",
  "audio", "playback", "world", "usage", "terminal",
] as const satisfies readonly EvidenceCategoryV2[]);

export type PlanRegisteredPayload = Readonly<{
  plan_id: string;
  revision: number;
  plan_sha256: string;
  required_step_ids: readonly string[];
  required_obligation_ids: readonly string[];
  forbidden_claim_ids: readonly string[];
}>;

export type CatalogPublishedPayload = Readonly<{
  catalog_id: string;
  plan_id: string;
  revision: number;
  catalog_sha256: string;
  capability_ids: readonly string[];
}>;

export type ProviderNormalizedPayload = Readonly<{
  provider: string;
  session_id: string;
  provider_event_id: string;
  provider_sequence: number;
  kind: "session_open" | "model_ack" | "input_audio_end" | "response_start" | "response_end"
    | "tool_call" | "tool_result" | "reconnect" | "session_close" | "error";
  turn_id: string | null;
  raw_event_sha256: string;
}>;

export type ActionAttemptedPayload = Readonly<{
  attempt_id: string;
  action_id: string;
  capability_id: string;
  plan_revision: number;
  arguments_sha256: string;
}>;

export type ActionPolicyPayload = Readonly<{
  attempt_id: string;
  decision: "allow" | "deny";
  policy_sha256: string;
  reason_code: string;
}>;

export type ActionReceiptPayload = Readonly<{
  attempt_id: string;
  receipt_id: string;
  status: "committed" | "rejected" | "indeterminate" | "reconciled";
  semantic_effect_id: string | null;
  result_sha256: string;
  world_revision: number;
}>;

export type WorkerEventPayload = Readonly<{
  worker_event_id: string;
  worker_id: string;
  parent_worker_id: string | null;
  call_id: string;
  plan_revision: number;
  kind: "spawned" | "started" | "completed" | "failed" | "cancelled" | "result_accepted" | "result_rejected_stale";
  result_sha256: string | null;
}>;

export type AudioRangePayload = Readonly<{
  response_id: string;
  audio_sha256: string;
  byte_length: number;
  sample_rate_hz: number;
  channel_count: number;
  start_sample: number;
  end_sample: number;
  claim_ids: readonly string[];
}>;

export type PlaybackRangePayload = Readonly<{
  playback_event_id: string;
  response_id: string;
  start_sample: number;
  end_sample: number;
  status: "released" | "heard" | "interrupted";
}>;

export type WorldEventPayload = Readonly<{
  world_event_id: string;
  kind: "goal.completed" | "step.completed" | "obligation.completed" | "correction.applied"
    | "effect.committed" | "effect.reconciled";
  required_step_id: string | null;
  obligation_id: string | null;
  correction_id: string | null;
  authorized_attempt_id: string | null;
  semantic_effect_id: string | null;
}>;

export type UsageRecordedPayload = Readonly<{
  usage_id: string;
  provider: string;
  model: string;
  input_audio_tokens: number;
  output_audio_tokens: number;
  input_text_tokens: number;
  output_text_tokens: number;
  cost_microusd: number;
}>;

export type TerminalJournalPayload = Readonly<{
  disposition_id: string;
  status: "completed" | "failed" | "aborted";
  reason_code: string | null;
}>;

export type EvidencePayloadByTypeV2 = Readonly<{
  "plan.registered": PlanRegisteredPayload;
  "catalog.published": CatalogPublishedPayload;
  "provider.normalized": ProviderNormalizedPayload;
  "action.attempted": ActionAttemptedPayload;
  "action.policy_decided": ActionPolicyPayload;
  "action.receipt": ActionReceiptPayload;
  "worker.event": WorkerEventPayload;
  "audio.range": AudioRangePayload;
  "playback.range": PlaybackRangePayload;
  "world.event": WorldEventPayload;
  "usage.recorded": UsageRecordedPayload;
  "journal.terminal": TerminalJournalPayload;
}>;

export type EvidenceEventV2<T extends EvidenceEventTypeV2 = EvidenceEventTypeV2> = Readonly<{
  schema_version: 2;
  run_id: string;
  sequence: number;
  observed_at: string;
  event_type: T;
  payload: EvidencePayloadByTypeV2[T];
  previous_event_sha256: string | null;
  event_sha256: string;
}>;

export type EvidenceCategoryRootV2 = Readonly<{
  event_count: number;
  root_sha256: string;
}>;

export type EvidenceManifestV2 = Readonly<{
  schema_version: 2;
  manifest_type: "hacc_evidence_manifest";
  run_id: string;
  created_at: string;
  event_count: number;
  event_chain_head_sha256: string;
  category_roots: Readonly<Record<EvidenceCategoryV2, EvidenceCategoryRootV2>>;
  signer_id: string;
  signing_public_key_sha256: string;
  manifest_root_sha256: string;
  signature: Readonly<{
    algorithm: "ed25519";
    signer_id: string;
    signature_base64: string;
  }>;
}>;

export type EvidenceBundleV2 = Readonly<{
  schema_version: 2;
  bundle_type: "hacc_evidence_bundle";
  run_id: string;
  events: readonly EvidenceEventV2[];
  terminal_manifest: EvidenceManifestV2;
}>;

export type EvidenceSignerV2 = Readonly<{
  algorithm: "ed25519";
  signer_id: string;
  public_key_pem: string;
  sign(payload: string): string;
}>;

export type EvidenceTrustV2 = Readonly<{
  signer_id: string;
  public_key_pem: string;
}>;

export type EvidenceUsageTotalsV2 = Readonly<{
  input_audio_tokens: number;
  output_audio_tokens: number;
  input_text_tokens: number;
  output_text_tokens: number;
  cost_microusd: number;
}>;

export type EvidenceEndpointsV2 = Readonly<{
  useful_mission_success: boolean;
  terminal_status: TerminalJournalPayload["status"];
  goal_completed: boolean;
  required_steps_total: number;
  required_steps_completed: number;
  required_obligations_total: number;
  required_obligations_completed: number;
  unauthorized_effect_count: number;
  duplicate_effect_count: number;
  unresolved_indeterminate_effect_count: number;
  unsafe_released_claim_count: number;
  heard_audio_sample_count: number;
  safe_first_audio_latency_ms: number | null;
  worker_spawn_count: number;
  worker_terminal_count: number;
  usage: EvidenceUsageTotalsV2;
}>;

export type EvidenceReplaySuccessV2 = Readonly<{
  ok: true;
  run_id: string;
  manifest_root_sha256: string;
  event_chain_head_sha256: string;
  endpoints: EvidenceEndpointsV2;
}>;

export type EvidenceReplayFailureV2 = Readonly<{
  ok: false;
  errors: readonly Readonly<{ code: string; message: string }>[];
}>;

export type EvidenceReplayResultV2 = EvidenceReplaySuccessV2 | EvidenceReplayFailureV2;

export type EvidenceJsonValue = JsonValue;

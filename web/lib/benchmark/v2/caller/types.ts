import type { KeyLike } from "node:crypto";
import type { JsonValue } from "../../artifacts";

export type ProviderStratum = "openai" | "gemini" | "xai";

export const COMMON_CALLER_OPPORTUNITY_IDS = Object.freeze([
  "opp-01-intake-obligation",
  "opp-02-detour",
  "opp-03-correction-barge-in",
  "opp-04-forbidden-action-worker",
  "opp-05-reconnect",
  "opp-06-ambiguous-effect",
  "opp-07-async-result",
  "opp-08-closeout",
] as const);

export type CommonCallerOpportunityId = typeof COMMON_CALLER_OPPORTUNITY_IDS[number];

export type DevelopmentTemplateDescriptor = Readonly<{
  template_id: string;
  seed: number;
  allocation: Readonly<{
    provider_stratum: ProviderStratum;
    ordinal_within_stratum: number;
  }>;
  domain: string;
  persona: string;
  primary_goal: string;
  reference_v1: string;
  reference_v2: string;
  detour_goal: string;
  delayed_obligation: string;
  forbidden_action: string;
  async_job: string;
  ambiguous_effect: string;
  terminal_goal: string;
}>;

export type DevelopmentCorpus = Readonly<{
  schema_version: 1;
  corpus_id: string;
  created_at: string;
  license: "CC0-1.0";
  study_role: "development";
  confirmatory_eligible: false;
  provider_content_policy: string;
  common_opportunity_ids: readonly CommonCallerOpportunityId[];
  templates: readonly DevelopmentTemplate[];
  source_manifest_sha256: string;
  corpus_sha256: string;
}>;

export type CallerEventKind =
  | "delayed_obligation"
  | "detour"
  | "correction"
  | "barge_in"
  | "forbidden_action"
  | "async_worker_launch"
  | "reconnect"
  | "ambiguous_effect"
  | "async_result"
  | "closeout";

export type CallerFactAssertion = Readonly<{
  fact_id: string;
  revision: number;
  value: JsonValue;
  supersedes_value_sha256: string | null;
}>;

export type CallerCandidate = Readonly<{
  candidate_id: string;
  utterance: string;
  utterance_sha256: string;
  path: "advance" | "repair" | "settled" | "pending";
  fact_assertions: readonly CallerFactAssertion[];
}>;

export type DevelopmentOpportunity = Readonly<{
  opportunity_id: CommonCallerOpportunityId;
  ordinal: number;
  event_kinds: readonly CallerEventKind[];
  required_heard_semantic_ids: readonly string[];
  world_branch?: Readonly<{
    fact_key: "async_result_status" | "ambiguous_effect_status";
    settled_values: readonly JsonValue[];
  }>;
  delivery: Readonly<{
    mode: "normal" | "barge_in" | "reconnect_after_turn";
    after_output_ms?: number;
    reconnect_mode?: "cold";
  }>;
  candidates: Readonly<{
    advance: CallerCandidate;
    repair: CallerCandidate;
    settled?: CallerCandidate;
    pending?: CallerCandidate;
  }>;
}>;

export type DevelopmentTemplate = Readonly<DevelopmentTemplateDescriptor & {
  lineage: Readonly<{
    independence_unit_id: string;
    parent_template_id: null;
    confirmatory_ancestor: false;
    shared_structure_cluster_id: "hacc-proof-v1-dev-eight-opportunity-v2";
  }>;
  permitted_world_fact_keys: readonly ["ambiguous_effect_status", "async_result_status"];
  opportunities: readonly DevelopmentOpportunity[];
  content_sha256: string;
  template_sha256: string;
}>;

export type PlayedAudioSemantic = Readonly<{
  semantic_id: string;
  disposition: "heard" | "not_heard" | "unverifiable";
  playback_range_id: string;
  played_audio_sha256: string;
}>;

export type ArmBlindCallerObservation = Readonly<{
  schema_version: 1;
  listener: Readonly<{
    played_audio_semantics: readonly PlayedAudioSemantic[];
  }>;
  world: Readonly<{
    facts: Readonly<Record<string, JsonValue>>;
  }>;
}>;

export type CallerObservationEvidenceBinding = Readonly<{
  audibility_projection_sha256: string;
  audibility_ledger_head_sha256: string;
  world_projection_sha256: string;
  world_ledger_head_sha256: string;
}>;

export type SignedArmBlindCallerObservation = Readonly<{
  schema_version: 1;
  run_id: string;
  corpus_sha256: string;
  template_id: string;
  template_sha256: string;
  opportunity_id: CommonCallerOpportunityId;
  selection_sequence: number;
  projection: ArmBlindCallerObservation;
  projection_sha256: string;
  source_evidence: CallerObservationEvidenceBinding;
  payload_sha256: string;
  signature: LedgerSignature;
}>;

export type CallerSelectionLedgerEntry = Readonly<{
  schema_version: 1;
  sequence: number;
  opportunity_id: CommonCallerOpportunityId;
  candidate_id: string;
  path: CallerCandidate["path"];
  selected_at: string;
  observation_receipt: SignedArmBlindCallerObservation;
  input_projection_sha256: string;
  utterance_sha256: string;
  previous_entry_sha256: string | null;
  entry_sha256: string;
}>;

export type CallerFactLedgerEntry = Readonly<{
  schema_version: 1;
  sequence: number;
  fact_id: string;
  revision: number;
  value: JsonValue;
  supersedes_value_sha256: string | null;
  source_opportunity_id: CommonCallerOpportunityId;
  source_selection_entry_sha256: string;
  previous_entry_sha256: string | null;
  entry_sha256: string;
}>;

export type ClosedLoopCallerState = Readonly<{
  schema_version: 1;
  run_id: string;
  corpus_sha256: string;
  template_id: string;
  template_sha256: string;
  next_opportunity_index: number;
  selection_entries: readonly CallerSelectionLedgerEntry[];
  fact_entries: readonly CallerFactLedgerEntry[];
}>;

export type CallerAdvanceResult = Readonly<{
  state: ClosedLoopCallerState;
  selection: Readonly<{
    opportunity_id: CommonCallerOpportunityId;
    candidate_id: string;
    path: CallerCandidate["path"];
    utterance: string;
    utterance_sha256: string;
    delivery: DevelopmentOpportunity["delivery"];
    event_kinds: readonly CallerEventKind[];
    input_projection_sha256: string;
  }>;
}>;

export type CallerSigningAuthority = Readonly<{
  key_id: string;
  private_key: KeyLike;
}>;

export type CallerVerificationAuthority = Readonly<{
  key_id: string;
  public_key: KeyLike;
}>;

export type LedgerSignature = Readonly<{
  algorithm: "Ed25519";
  key_id: string;
  public_key_fingerprint_sha256: string;
  signed_payload_sha256: string;
  signature_base64: string;
}>;

export type SignedCallerSelectionLedger = Readonly<{
  schema_version: 1;
  ledger_kind: "caller_selections";
  run_id: string;
  corpus_sha256: string;
  template_id: string;
  template_sha256: string;
  schedule_status: "complete" | "incomplete";
  entry_count: number;
  chain_head_sha256: string | null;
  entries: readonly CallerSelectionLedgerEntry[];
  payload_sha256: string;
  signature: LedgerSignature;
}>;

export type SignedCallerFactLedger = Readonly<{
  schema_version: 1;
  ledger_kind: "caller_fact_ledger";
  run_id: string;
  corpus_sha256: string;
  template_id: string;
  template_sha256: string;
  schedule_status: "complete" | "incomplete";
  entry_count: number;
  chain_head_sha256: string | null;
  entries: readonly CallerFactLedgerEntry[];
  payload_sha256: string;
  signature: LedgerSignature;
}>;

export type SignedCallerLedgers = Readonly<{
  caller_selections: SignedCallerSelectionLedger;
  caller_fact_ledger: SignedCallerFactLedger;
}>;

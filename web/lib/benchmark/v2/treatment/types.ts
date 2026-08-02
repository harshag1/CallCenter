import type { KeyLike } from "node:crypto";

export type Sha256 = string;

export type TreatmentId =
  | "registered_native"
  | "full_hacc"
  | "hacc_without_context_compiler"
  | "hacc_without_capability_scoping"
  | "hacc_without_effect_receipts";

export type TreatmentSwitches = Readonly<{
  context_delivery: "chronological_provider_history" | "compiled_turn_contract";
  state_authority: "provider_session" | "hacc_event_log";
  capability_disclosure: "complete_registered_catalog" | "scoped_capability_frontier";
  effect_admission: "shared_gateway_schema" | "revision_bound_policy_lease";
  effect_evidence: "provider_acknowledgement" | "authoritative_effect_receipt";
  asynchronous_work: "provider_inline" | "durable_revision_bound_worker";
  repair_control: "provider_default" | "deterministic_reconciliation";
  speech_release: "provider_output" | "claim_grant_and_playback_ledger";
}>;

export type HarnessTreatmentManifest = Readonly<{
  schema_version: 1;
  treatment_id: TreatmentId;
  arm: "native" | "hacc";
  confirmatory_eligible: boolean;
  intervention_family: "registered_native" | "hacc";
  switches: TreatmentSwitches;
  manifest_sha256: Sha256;
}>;

export type TreatmentSignature = Readonly<{
  schema_version: 1;
  algorithm: "ed25519";
  key_id: string;
  public_key_fingerprint_sha256: Sha256;
  signed_payload_sha256: Sha256;
  signature_base64: string;
}>;

export type TreatmentRuntimeImplementation = Readonly<{
  condition_compiler_sha256: Sha256;
  context_delivery_sha256: Sha256;
  state_authority_sha256: Sha256;
  capability_disclosure_sha256: Sha256;
  effect_admission_sha256: Sha256;
  effect_evidence_sha256: Sha256;
  asynchronous_work_sha256: Sha256;
  repair_control_sha256: Sha256;
  speech_release_sha256: Sha256;
}>;

export type TreatmentExecutionBinding = Readonly<{
  schema_version: 1;
  shared_semantics_sha256: Sha256;
  runtime_implementation: TreatmentRuntimeImplementation;
}>;

export type SignedHarnessTreatment = Readonly<{
  manifest: HarnessTreatmentManifest;
  execution_binding: TreatmentExecutionBinding;
  signature: TreatmentSignature;
}>;

export type TreatmentSigningAuthority = Readonly<{
  key_id: string;
  private_key: KeyLike;
}>;

export type TreatmentVerificationAuthority = Readonly<{
  key_id: string;
  public_key: KeyLike;
}>;

export type ToolSemanticIdentity = Readonly<{
  name: string;
  input_schema_sha256: Sha256;
  semantic_contract_sha256: Sha256;
  implementation_sha256: Sha256;
}>;

/**
 * Everything in this object is a controlled constant shared by both paired
 * conditions. Treatment code cannot override any of these values.
 */
export type SharedConditionSemantics = Readonly<{
  schema_version: 1;
  benchmark_id: string;
  protocol_sha256: Sha256;
  pair_id: string;
  scenario_sha256: Sha256;
  caller_schedule_sha256: Sha256;
  task_policy_sha256: Sha256;
  safety_policy_sha256: Sha256;
  provider: Readonly<{
    provider_id: string;
    model_id: string;
    voice_id: string;
    base_session_configuration_sha256: Sha256;
  }>;
  audio: Readonly<{
    input_manifest_sha256: Sha256;
    delivery_profile_sha256: Sha256;
    codec_profile_sha256: Sha256;
  }>;
  world: Readonly<{
    world_manifest_sha256: Sha256;
    initial_state_sha256: Sha256;
  }>;
  gateway: Readonly<{
    schema_sha256: Sha256;
    implementation_sha256: Sha256;
  }>;
  tools: readonly ToolSemanticIdentity[];
  limits: Readonly<{
    opportunity_count: number;
    maximum_session_count: number;
    maximum_duration_ms: number;
    maximum_output_tokens_per_response: number;
    maximum_tool_calls_per_opportunity: number;
  }>;
  registered_native_contract: Readonly<{
    complete_task_and_safety_policy: true;
    complete_logical_tool_catalog: true;
    chronological_continuity_across_planned_connections: true;
    provider_recommended_resumption_and_context_management: true;
    identical_world_gateway_and_tool_implementations: true;
  }>;
}>;

export type CompiledTreatmentRuntime = Readonly<{
  context_delivery: TreatmentSwitches["context_delivery"];
  state_authority: TreatmentSwitches["state_authority"];
  capability_disclosure: TreatmentSwitches["capability_disclosure"];
  effect_admission: TreatmentSwitches["effect_admission"];
  effect_evidence: TreatmentSwitches["effect_evidence"];
  asynchronous_work: TreatmentSwitches["asynchronous_work"];
  repair_control: TreatmentSwitches["repair_control"];
  speech_release: TreatmentSwitches["speech_release"];
}>;

export type CompiledBenchmarkCondition = Readonly<{
  schema_version: 1;
  condition_id: string;
  pair_id: string;
  arm: "native" | "hacc";
  execution_mode: "offline_development" | "paid_development" | "confirmatory";
  shared_semantics: SharedConditionSemantics;
  signed_treatment: SignedHarnessTreatment;
  runtime: CompiledTreatmentRuntime;
  shared_semantics_sha256: Sha256;
  condition_sha256: Sha256;
}>;

export type ConditionExecutionAttestation = Readonly<{
  schema_version: 1;
  observation_source: "runner_observed";
  condition_sha256: Sha256;
  observed_shared_semantics: SharedConditionSemantics;
  observed_runtime_implementation: TreatmentRuntimeImplementation;
  attestation_sha256: Sha256;
}>;

export type TreatmentParityManifest = Readonly<{
  schema_version: 1;
  pair_id: string;
  native_condition_sha256: Sha256;
  hacc_condition_sha256: Sha256;
  native_treatment_sha256: Sha256;
  hacc_treatment_sha256: Sha256;
  treatment_authority_key_id: string;
  treatment_authority_fingerprint_sha256: Sha256;
  shared_semantics_sha256: Sha256;
  allowed_difference_paths: readonly string[];
  observed_difference_paths: readonly string[];
  parity_sha256: Sha256;
}>;

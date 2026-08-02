export type ProofArm = "native" | "hacc";
export type ProofPhase = "testing" | "benchmark";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | {
  readonly [key: string]: JsonValue;
};

export type ProviderIdentity = Readonly<{
  provider: string;
  model: string;
  voice: string;
  settings_sha256: string;
}>;
export type ScheduledUnit = Readonly<{
  unit_id: string;
  pair_id: string;
  pair_position: 1 | 2;
  phase: ProofPhase;
  arm: ProofArm;
  identity: ProviderIdentity;
  scenario_sha256: string;
  caller_plan_sha256: string;
  tools_sha256: string;
  substantive_context_sha256: string;
  maximum_micro_usd: number;
}>;

export type ScheduleBody = Readonly<{
  schema_version: 1;
  protocol: "HACC-Proof-v1";
  study_id: string;
  created_at: string;
  source_commit: string;
  units: readonly ScheduledUnit[];
}>;

export type SignedSchedule = Readonly<{
  body: ScheduleBody;
  schedule_sha256: string;
  signer: Readonly<{
    algorithm: "ed25519";
    public_key_spki_base64: string;
    public_key_fingerprint_sha256: string;
  }>;
  signature_base64: string;
}>;

export type CompiledCondition = Readonly<{
  schema_version: 1;
  protocol: "HACC-Proof-v1";
  unit_id: string;
  arm: ProofArm;
  identity: ProviderIdentity;
  scenario_sha256: string;
  caller_plan_sha256: string;
  tools_sha256: string;
  substantive_context_sha256: string;
  treatment: Readonly<{
    mode: "registered_native" | "full_hacc";
    response_plan: boolean;
    progressive_capabilities: boolean;
    durable_authority: boolean;
    effect_receipts: boolean;
    async_workers: boolean;
  }>;
  condition_sha256: string;
}>;

export type TerminalDisposition =
  | "completed"
  | "failed"
  | "ambiguous"
  | "not_opened_gate_stopped";

export type TerminalLedgerEntry = Readonly<{
  unit_id: string;
  pair_id: string;
  arm: ProofArm;
  phase: ProofPhase;
  opening_count: 0 | 1;
  session_id: string | null;
  disposition: TerminalDisposition;
  estimated_micro_usd: number;
  reason: string | null;
}>;

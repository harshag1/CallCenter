export const HACC_OFFLINE_STRESS_SCHEMA_VERSION = 1 as const;

export type OfflineStressConfig = Readonly<{
  proposalCount: number;
  raceScheduleCount: number;
  replayScheduleCount: number;
  seedStart: number;
  sourceSha256: string;
}>;

export type StressPhaseTiming = Readonly<{
  wall_ms: number;
  operations_per_second: number;
}>;

export type OfflineStressReport = Readonly<{
  schema_version: typeof HACC_OFFLINE_STRESS_SCHEMA_VERSION;
  report_type: "hacc_offline_deterministic_stress";
  status: "passed" | "failed";
  config: Readonly<{
    proposal_count: number;
    race_schedule_count: number;
    replay_schedule_count: number;
    seed_start: number;
    seed_end: number;
  }>;
  digests: Readonly<{
    source_sha256: string;
    config_sha256: string;
    logical_result_sha256: string;
    evidence_manifest_sha256: string;
  }>;
  proposals: Readonly<{
    total: number;
    allowed: number;
    denied_forged: number;
    rejected_stale: number;
    terminal_replays: number;
    unauthorized_effects: number;
    stale_dispatches: number;
    duplicate_effects: number;
  }>;
  races: Readonly<{
    total: number;
    normal_settlements: number;
    stale_before_dispatch: number;
    indeterminate_reconciled: number;
    idempotency_conflicts: number;
    dispatches: number;
    duplicate_effects: number;
    stale_dispatches: number;
    blind_retries: number;
  }>;
  replay: Readonly<{
    total: number;
    exact_replays: number;
    reconnect_recoveries: number;
    corrections_applied: number;
    stale_worker_deliveries_rejected: number;
    forbidden_claim_release_attempts: number;
    forbidden_claims_released: number;
    replay_mismatches: number;
  }>;
  evidence: Readonly<{
    replay_ok: boolean;
    useful_mission_success: boolean;
    tamper_rejected: boolean;
    replay_errors: readonly Readonly<{ code: string; message: string }>[];
  }>;
  timings: Readonly<{
    proposals: StressPhaseTiming;
    races: StressPhaseTiming;
    replay: StressPhaseTiming;
    evidence: StressPhaseTiming;
    total_wall_ms: number;
  }>;
  hard_gates: Readonly<{
    zero_unauthorized_effects: boolean;
    zero_duplicate_effects: boolean;
    zero_stale_dispatches: boolean;
    zero_blind_retries: boolean;
    zero_forbidden_released_claims: boolean;
    exact_replay: boolean;
    evidence_replay_and_tamper_detection: boolean;
  }>;
}>;

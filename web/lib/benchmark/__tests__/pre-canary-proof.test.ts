import { describe, expect, it } from "vitest";
import {
  PRE_CANARY_GATE_0_REQUIRED_CHECK_IDS,
  analyzePreCanaryMigrationSequence,
  createPreCanaryProofCheck,
  createPreCanaryProofPacket,
  preCanaryConditionalDatabaseTestsComplete,
  preCanarySourceSnapshotStable,
  preCanaryProofPacketSha256,
  preCanaryWebTestsComplete,
  verifyPreCanaryProofPacket,
  type PreCanaryProofPacket,
  type PreCanaryProofPacketBody,
} from "../pre-canary-proof";
import {
  PAID_PREFLIGHT_EMULATOR_MANIFEST_SHA256,
  PAID_PREFLIGHT_TAMPER_TESTS,
} from "../paid-preflight-emulator-manifest";

const H = (character: string): string => character.repeat(64);
const COMMAND_ID = "proof.command";

describe("pre-canary discovery and conditional-test completeness", () => {
  it("discovers a canonical migration chain without a stale latest-version constant", () => {
    const through = (latest: number): string[] => Array.from(
      { length: latest },
      (_, index) => `${String(index + 1).padStart(3, "0")}_migration_${index + 1}.sql`,
    );

    expect(analyzePreCanaryMigrationSequence([
      ...through(31),
      "README.md",
    ])).toMatchObject({
      migration_count: 31,
      first_id: 1,
      latest_id: 31,
      invalid_sql_filename_count: 0,
      duplicate_id_count: 0,
      contiguous_from_001_to_latest: true,
    });
    expect(
      analyzePreCanaryMigrationSequence(through(32))
        .contiguous_from_001_to_latest,
    ).toBe(true);
    expect(
      analyzePreCanaryMigrationSequence(
        through(31).filter((name) => !name.startsWith("017_")),
      ).contiguous_from_001_to_latest,
    ).toBe(false);
    expect(
      analyzePreCanaryMigrationSequence([
        ...through(31),
        "031_duplicate.sql",
      ]),
    ).toMatchObject({
      duplicate_id_count: 1,
      contiguous_from_001_to_latest: false,
    });
    expect(
      analyzePreCanaryMigrationSequence([
        ...through(31),
        "migration_032.sql",
      ]),
    ).toMatchObject({
      invalid_sql_filename_count: 1,
      contiguous_from_001_to_latest: false,
    });
    expect(analyzePreCanaryMigrationSequence([])).toMatchObject({
      migration_count: 0,
      first_id: null,
      latest_id: null,
      contiguous_from_001_to_latest: false,
    });
  });

  it("accepts the main Vitest run only with the exact inventory-backed pending count", () => {
    const complete = {
      exit_code: 0,
      success: true,
      total_tests: 1_700,
      passed_tests: 1_641,
      failed_tests: 0,
      pending_tests: 59,
      expected_conditional_pending_tests: 59,
    };
    expect(preCanaryWebTestsComplete(complete)).toBe(true);
    expect(preCanaryWebTestsComplete({
      ...complete,
      passed_tests: 1_642,
      pending_tests: 58,
    })).toBe(false);
    expect(preCanaryWebTestsComplete({
      ...complete,
      passed_tests: 1_640,
      pending_tests: 60,
    })).toBe(false);
    expect(preCanaryWebTestsComplete({
      ...complete,
      failed_tests: 1,
    })).toBe(false);
    expect(preCanaryWebTestsComplete({
      ...complete,
      total_tests: 1_701,
    })).toBe(false);
  });

  it("accepts the disposable database run only with the exact 19-file/56-test inventory binding", () => {
    const complete = {
      inventory_sha256: H("a"),
      expected_inventory_sha256: H("a"),
      test_file_count: 19,
      expected_test_file_count: 19,
      total_tests: 56,
      expected_total_tests: 56,
      passed_tests: 56,
      failed_tests: 0,
      pending_tests: 0,
      provider_sessions_opened: 0,
      spend_usd: 0,
    };
    expect(preCanaryConditionalDatabaseTestsComplete(complete)).toBe(true);
    for (const mutation of [
      { inventory_sha256: H("b") },
      { test_file_count: 18 },
      { total_tests: 55 },
      { passed_tests: 55 },
      { failed_tests: 1 },
      { pending_tests: 1 },
      { provider_sessions_opened: 1 },
      { spend_usd: 0.01 },
    ]) {
      expect(preCanaryConditionalDatabaseTestsComplete({
        ...complete,
        ...mutation,
      })).toBe(false);
    }
  });
});

function observedFor(checkId: string): Readonly<Record<string, string | number | boolean | null>> {
  switch (checkId) {
    case "source.clean":
      return {
        clean: true,
        stable_snapshot: true,
        reachable_history_stable: true,
        opening_status_bytes: 0,
        closing_status_bytes: 0,
      };
    case "source.public_history":
      return { finding_count: 0, reachable_commit_count: 133 };
    case "source.working_tree_secrets":
      return { finding_count: 0, publishable_file_count: 412 };
    case "provider.paid_preflight_emulator":
      return {
        tamper_credential_reads: 0,
        tamper_client_constructions: 0,
        tamper_reservations_consumed: 0,
        tamper_cases_passed: PAID_PREFLIGHT_TAMPER_TESTS.length,
        tamper_cases_total: PAID_PREFLIGHT_TAMPER_TESTS.length,
        happy_path_passed: true,
        manifest_sha256: PAID_PREFLIGHT_EMULATOR_MANIFEST_SHA256,
      };
    default:
      return { asserted: true };
  }
}

function body(overrides: Partial<Omit<PreCanaryProofPacketBody, "decision">> = {}): Omit<PreCanaryProofPacketBody, "decision"> {
  const checks = PRE_CANARY_GATE_0_REQUIRED_CHECK_IDS.map((id) => createPreCanaryProofCheck({
    id,
    status: "pass",
    required_for: ["gate_0"],
    command_ids: [COMMAND_ID],
    reason_codes: [],
    observed: observedFor(id),
  }));
  checks.push(createPreCanaryProofCheck({
    id: "pricing.gate1_executable_proofs",
    status: "blocked",
    required_for: ["gate_1"],
    command_ids: [],
    reason_codes: ["proofs_missing"],
    observed: { verified_provider_count: 0 },
  }));
  return {
    schema_version: 1,
    kind: "hacc_pre_canary_no_spend_proof",
    generated_at: "2026-07-16T20:00:00.000Z",
    source: {
      commit: "1".repeat(40),
      tree: "2".repeat(40),
      clean: true,
      status_sha256: H("3"),
      publishable_file_manifest_sha256: H("4"),
    },
    provider_boundary: {
      offline_entrypoint: "web/scripts/voice-benchmark-offline.ts",
      runtime_import_closure_sha256: H("5"),
      runtime_input_count: 32,
      packet_entrypoint: "web/scripts/pre-canary-proof.ts",
      packet_runtime_import_closure_sha256: H("f"),
      packet_runtime_input_count: 9,
      forbidden_runtime_inputs: [],
      external_socket_imports: [],
      provider_client_construction_reachable: false,
      paid_executor_supplied: false,
      packet_provider_sessions_opened: 0,
      validation_contract_constructs_idle_clients: true,
    },
    budget: {
      ledger_verified: true,
      ledger_id: "precanary-ledger",
      ledger_head_sha256: H("6"),
      state: "paused",
      paused: true,
      active_reservations_micro_usd: 0,
      conservative_settled_micro_usd: 0,
      scheduling_exposure_micro_usd: 0,
      provider_spend_usd: "0",
    },
    freeze: {
      verified: true,
      freeze_lock_sha256: H("7"),
      evidence_class: "canary",
      source_commit_matches: true,
    },
    pricing: {
      gate_1_reservation_micro_usd_per_provider: 5_000_000,
      executable_proof_count: 0,
      all_provider_proofs_verified: false,
      provider_proof_sha256: { openai: null, xai: null, gemini: null },
      provider_proofs: { openai: null, xai: null, gemini: null },
    },
    determinism: {
      run_id: "offline-double-run",
      historical_minimum_file_count: 49,
      observed_file_count_a: 49,
      observed_file_count_b: 49,
      exact_path_set_match: true,
      exact_byte_match: true,
      tree_sha256_a: H("8"),
      tree_sha256_b: H("8"),
      network_calls: 0,
      spend_usd: "0",
    },
    commands: [{
      id: COMMAND_ID,
      cwd: "/workspace/web",
      argv: ["npm", "test"],
      exit_code: 0,
      stdout_sha256: H("9"),
      stderr_sha256: H("a"),
      combined_log_sha256: H("b"),
      raw_logs: "restricted_local_0600",
      provider_environment_removed: true,
      duration_ms: 10,
    }],
    checks,
    artifacts: [],
    ...overrides,
  };
}

function rehash(packet: PreCanaryProofPacket, mutate: (body: PreCanaryProofPacketBody) => PreCanaryProofPacketBody): PreCanaryProofPacket {
  const { packet_sha256: _oldHash, ...originalBody } = packet;
  void _oldHash;
  const nextBody = mutate(structuredClone(originalBody));
  return { ...nextBody, packet_sha256: preCanaryProofPacketSha256(nextBody) };
}

describe("pre-canary proof packet", () => {
  it("treats a reachable-ref change as source drift even when HEAD, tree, and worktree status are unchanged", () => {
    const unchanged = {
      opening_head_sha256: H("1"),
      closing_head_sha256: H("1"),
      opening_tree_sha256: H("2"),
      closing_tree_sha256: H("2"),
      opening_status_sha256: H("3"),
      closing_status_sha256: H("3"),
      opening_reachable_history_sha256: H("4"),
      closing_reachable_history_sha256: H("4"),
    };
    expect(preCanarySourceSnapshotStable(unchanged)).toBe(true);
    expect(preCanarySourceSnapshotStable({
      ...unchanged,
      closing_reachable_history_sha256: H("5"),
    })).toBe(false);
  });

  it("keeps paid execution and Gate 1 release closed even when Gate 0 is complete", () => {
    const packet = createPreCanaryProofPacket(body());
    expect(verifyPreCanaryProofPacket(packet)).toMatchObject({ valid: true, errors: [] });
    expect(packet.decision).toMatchObject({
      gate_0_evidence_complete: true,
      gate_1_ready_for_manual_release: false,
      gate_1_release_authorized: false,
      paid_execution_authorized: false,
      c3_transport_ready: false,
      c4_effectiveness_ready: false,
      c5_confirmatory_ready: false,
    });
  });

  it("derives NO-GO when any required Gate 0 check is missing", () => {
    const input = body();
    const packet = createPreCanaryProofPacket({
      ...input,
      checks: input.checks.filter((check) => check.id !== "database.isolation"),
    });
    expect(verifyPreCanaryProofPacket(packet).valid).toBe(true);
    expect(packet.decision.gate_0_evidence_complete).toBe(false);
    expect(packet.decision.blocking_check_ids).toContain("database.isolation");
  });

  it("rejects a clean-source pass without an exact opening/closing reachable-history match", () => {
    const input = body();
    input.checks = input.checks.map((check) => check.id === "source.clean"
      ? createPreCanaryProofCheck({
          id: check.id,
          status: "pass",
          required_for: ["gate_0"],
          command_ids: [COMMAND_ID],
          reason_codes: [],
          observed: {
            ...check.observed,
            reachable_history_stable: false,
          },
        })
      : check);
    const packet = createPreCanaryProofPacket(input);
    expect(verifyPreCanaryProofPacket(packet)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["pass_status_incoherent"]),
    });
    expect(packet.decision.gate_1_release_authorized).toBe(false);
    expect(packet.decision.paid_execution_authorized).toBe(false);
  });

  it("rejects a forged decision even when the attacker recomputes the packet hash", () => {
    const packet = createPreCanaryProofPacket(body());
    const forged = rehash(packet, (value) => ({
      ...value,
      decision: { ...value.decision, gate_0_evidence_complete: false },
    }));
    expect(verifyPreCanaryProofPacket(forged)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["decision_not_derived_from_checks"]),
    });
  });

  it("rejects packet and check mutations that are not hash-bound", () => {
    const packet = createPreCanaryProofPacket(body());
    const sourceMutation = structuredClone(packet);
    sourceMutation.source.tree = "f".repeat(40);
    expect(verifyPreCanaryProofPacket(sourceMutation).errors).toContain("packet_hash_mismatch");

    const checkMutation = rehash(packet, (value) => ({
      ...value,
      checks: value.checks.map((check) => check.id === "web.tests"
        ? { ...check, observed: { asserted: false } }
        : check),
    }));
    expect(verifyPreCanaryProofPacket(checkMutation).errors).toContain("check_evidence_hash_mismatch");
  });

  it("rejects provider-capable or socket-capable offline import closures", () => {
    const packet = createPreCanaryProofPacket(body());
    const forged = rehash(packet, (value) => ({
      ...value,
      provider_boundary: {
        ...value.provider_boundary,
        provider_client_construction_reachable: true,
        forbidden_runtime_inputs: ["lib/benchmark/paid-runner.ts"],
        external_socket_imports: ["ws"],
      },
    }));
    expect(verifyPreCanaryProofPacket(forged)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        "provider_client_reachable",
        "forbidden_runtime_input",
        "external_socket_import",
        "pass_status_incoherent",
      ]),
    });
  });

  it.each(["missing", "invalid", "open", "closed"] as const)(
    "cannot pass budget.paused_zero with a %s ledger",
    (state) => {
      const packet = createPreCanaryProofPacket(body());
      const forged = rehash(packet, (value) => ({
        ...value,
        budget: {
          ...value.budget,
          ledger_verified: false,
          ledger_id: null,
          ledger_head_sha256: null,
          state,
          paused: false,
        },
      }));
      expect(verifyPreCanaryProofPacket(forged).errors).toContain("pass_status_incoherent");
    }
  );

  it("rejects any attempt to mark Gate 1 or paid execution authorized", () => {
    const packet = createPreCanaryProofPacket(body());
    const gateMutation = structuredClone(packet) as unknown as Record<string, unknown>;
    gateMutation.decision = {
      ...(packet.decision as object),
      gate_1_release_authorized: true,
      paid_execution_authorized: true,
    };
    expect(verifyPreCanaryProofPacket(gateMutation)).toEqual({
      valid: false,
      errors: ["packet_schema_invalid"],
      packet: null,
    });
  });

  it("rejects a paid-preflight pass whose zero-side-effect or exact manifest evidence is forged", () => {
    const packet = createPreCanaryProofPacket(body());
    const forged = rehash(packet, (value) => ({
      ...value,
      checks: value.checks.map((check) => check.id === "provider.paid_preflight_emulator"
        ? createPreCanaryProofCheck({
            id: check.id,
            status: "pass",
            required_for: ["gate_0"],
            command_ids: [COMMAND_ID],
            reason_codes: [],
            observed: {
              ...check.observed,
              tamper_credential_reads: 1,
              manifest_sha256: H("e"),
            },
          })
        : check),
    }));
    expect(verifyPreCanaryProofPacket(forged)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["pass_status_incoherent"]),
    });
    expect(forged.decision.gate_0_evidence_complete).toBe(true);
    expect(forged.decision.gate_1_release_authorized).toBe(false);
    expect(forged.decision.paid_execution_authorized).toBe(false);
  });

  it("does not accept arbitrary non-null hashes as executable Gate 1 proofs", () => {
    const input = body({
      pricing: {
        gate_1_reservation_micro_usd_per_provider: 5_000_000,
        executable_proof_count: 3,
        all_provider_proofs_verified: true,
        provider_proof_sha256: { openai: H("c"), xai: H("d"), gemini: H("e") },
        provider_proofs: { openai: null, xai: null, gemini: null },
      },
    });
    input.checks = input.checks.map((check) => check.id === "pricing.gate1_executable_proofs"
      ? createPreCanaryProofCheck({
          id: check.id,
          status: "pass",
          required_for: ["gate_1"],
          command_ids: [COMMAND_ID],
          reason_codes: [],
          observed: { verified_provider_count: 3 },
        })
      : check);
    const packet = createPreCanaryProofPacket(input);
    expect(verifyPreCanaryProofPacket(packet)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["pass_status_incoherent", "pricing_proof_claim_invalid"]),
    });
    expect(packet.decision.gate_1_ready_for_manual_release).toBe(false);
    expect(packet.decision.gate_1_release_authorized).toBe(false);
    expect(packet.decision.paid_execution_authorized).toBe(false);
  });
});

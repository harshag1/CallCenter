import { describe, expect, it } from "vitest";

import { runLc4MechanismCanary } from "../lc4-mechanism-canary";

describe("LC4 provider-free end-to-end mechanism canary", () => {
  it("composes the full mechanism stack for both arms through an exact signed 60-opportunity replay", async () => {
    const canary = await runLc4MechanismCanary();

    expect(canary).toMatchObject({
      schema_version: 1,
      protocol_id: "HACC-LC4-MECHANISM-CANARY-v1",
      provider_free: true,
      provider_calls_authorized: false,
      provider_calls_made: 0,
      arm_common_infrastructure_parity: { valid: true },
    });
    expect(canary.canary_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(canary.arm_common_infrastructure_parity.native_projection_sha256)
      .toBe(canary.arm_common_infrastructure_parity.hacc_projection_sha256);

    for (const arm of [canary.arms.native, canary.arms.hacc]) {
      expect(arm).toMatchObject({
        provider_calls_made: 0,
        canonical_opportunities_planned: 60,
        canonical_opportunities_completed: 60,
        listener_evidence_callbacks: 60,
        caller_automaton_status: "completed",
        audio_bound_slot: {
          opportunity_id: "opportunity.014",
          status: "succeeded",
          canonical_value: "goal.secondary",
          replay_verified: true,
        },
        worker: {
          evidence_verified: true,
          session_rotations: 2,
          committed_effect_count: 1,
        },
        repair: {
          terminal_class: "recovered",
          canonical_horizon_executed: 60,
          repair_turns_played: 1,
          repair_count: 1,
        },
        gateway: {
          caller_turn_entries: 60,
          provider_schema_omits_bound_argument: true,
        },
        signed_replay: {
          valid: true,
          authenticity: "signed_attestation_verified",
          transcript_entry_count: 65,
        },
      });
      expect(arm.worker.committed_after_error_receipt_id).toContain("lc4.apply.07");
      expect(arm.worker.reconciliation_receipt_id).toContain("lc4.read.07.reconcile");
      expect(arm.gateway.bound_argument_value).toMatch(/^FREIGHT-/);
      expect(arm.gateway.argument_binding_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(arm.signed_replay.transcript_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(arm.signed_replay.attestation_sha256).toMatch(/^[a-f0-9]{64}$/);
    }

    expect(canary.arms.native.audio_bound_slot.receipt_sha256)
      .toBe(canary.arms.hacc.audio_bound_slot.receipt_sha256);
    expect(canary.arms.native.worker).toEqual(canary.arms.hacc.worker);
    expect(canary.arms.native.repair.trace_sha256).toBe(canary.arms.hacc.repair.trace_sha256);
    expect(canary.arms.native.gateway.condition_hash).toBe(canary.arms.hacc.gateway.condition_hash);
    expect(canary.arms.native.gateway.flow_hash).toBe(canary.arms.hacc.gateway.flow_hash);
    expect(canary.arms.native.gateway.bound_argument_value).toBe(canary.arms.hacc.gateway.bound_argument_value);
  }, 30_000);
});

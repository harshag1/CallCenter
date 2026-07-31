import { describe, expect, it } from "vitest";
import {
  advanceHaccSpeechGuardrailState,
  assertHaccSpeechGuardrailPacket,
  createHaccSpeechGuardrailPacket,
  createInitialHaccSpeechGuardrailState,
  haccSpeechGuardrailEvidenceSha256,
  type HaccSpeechGuardrailEvidenceKind,
  type HaccSpeechGuardrailPacket,
  type HaccSpeechGuardrailState,
} from "../speech-guardrail-packet";

function advance(
  state: HaccSpeechGuardrailState,
  packet: HaccSpeechGuardrailPacket,
  kind: HaccSpeechGuardrailEvidenceKind,
  evidence: unknown = { receipt: kind },
) {
  const nextState = advanceHaccSpeechGuardrailState(state, {
    kind,
    evidence_sha256: haccSpeechGuardrailEvidenceSha256(evidence),
  });
  return {
    state: nextState,
    packet: createHaccSpeechGuardrailPacket(nextState, packet.packet_sha256),
  };
}

function sequence() {
  const initialState = createInitialHaccSpeechGuardrailState();
  const initial = createHaccSpeechGuardrailPacket(initialState, null);
  const verified = advance(initialState, initial, "verification_succeeded");
  const ambiguous = advance(verified.state, verified.packet, "commit_ambiguous_after_commit");
  const reconciled = advance(ambiguous.state, ambiguous.packet, "reconciliation_succeeded");
  return { initial, verified, ambiguous, reconciled };
}

function changed(packet: HaccSpeechGuardrailPacket, patch: Record<string, unknown>): unknown {
  return { ...packet, ...patch };
}

describe("state-conditioned HACC speech guardrail packet", () => {
  it("reproduces the xAI v5 post-verification PIN-disclosure risk state", () => {
    const { verified } = sequence();
    expect(verified.packet.privacy_directive).toBe("never_repeat_verification_secrets");
    expect(verified.packet.revision).toBe(1);
    expect(() => assertHaccSpeechGuardrailPacket(verified.packet)).not.toThrow();
  });

  it("reproduces the Gemini v5 premature-success ambiguity quarantine", () => {
    const { ambiguous } = sequence();
    expect(ambiguous.packet.terminal_directive)
      .toBe("ambiguity_quarantine_reconcile_before_terminal_claim");
    expect(ambiguous.packet.control_boundary)
      .toBe("defense_in_depth_instruction_gateway_enforced_quarantine");
    expect(ambiguous.packet.revision).toBe(2);
  });

  it("allows receipt-grounded confirmation only after designated reconciliation", () => {
    const { ambiguous, reconciled } = sequence();
    expect(ambiguous.packet.terminal_directive)
      .toBe("ambiguity_quarantine_reconcile_before_terminal_claim");
    expect(reconciled.packet.terminal_directive)
      .toBe("confirm_only_from_authoritative_reconciliation_receipt");
    expect(reconciled.packet.previous_packet_sha256).toBe(ambiguous.packet.packet_sha256);
  });

  it("re-enters quarantine if a new after-commit ambiguity follows reconciliation", () => {
    const { reconciled } = sequence();
    const repeatedCommit = advance(
      reconciled.state,
      reconciled.packet,
      "commit_ambiguous_after_commit",
      { public_receipt: "new-commit-after-reconcile" },
    );
    expect(repeatedCommit.packet.revision).toBe(reconciled.packet.revision + 1);
    expect(repeatedCommit.packet.terminal_directive)
      .toBe("ambiguity_quarantine_reconcile_before_terminal_claim");
  });

  it("rejects packet deletion, substitution, mutation, and chain reordering", () => {
    const { initial, verified, ambiguous, reconciled } = sequence();
    expect(() => assertHaccSpeechGuardrailPacket(
      changed(ambiguous.packet, { packet_sha256: "0".repeat(64) })
    )).toThrow("packet hash mismatch");
    expect(() => assertHaccSpeechGuardrailPacket(
      changed(ambiguous.packet, { terminal_directive: "confirm_only_from_authoritative_reconciliation_receipt" })
    )).toThrow();
    const deleted = { ...ambiguous.packet } as Record<string, unknown>;
    delete deleted.state_sha256;
    expect(() => assertHaccSpeechGuardrailPacket(deleted)).toThrow("unsupported keys");
    expect(() => assertHaccSpeechGuardrailPacket(ambiguous.packet, verified.packet.packet_sha256)).not.toThrow();
    expect(() => assertHaccSpeechGuardrailPacket(reconciled.packet, ambiguous.packet.packet_sha256)).not.toThrow();
    expect(() => assertHaccSpeechGuardrailPacket(reconciled.packet, verified.packet.packet_sha256))
      .toThrow("chain mismatch");
    expect(initial.revision).toBeLessThan(verified.packet.revision);
    expect(verified.packet.revision).toBeLessThan(ambiguous.packet.revision);
  });

  it("commits secret-bearing evidence without copying any secret or oracle value", () => {
    const state = createInitialHaccSpeechGuardrailState();
    const initial = createHaccSpeechGuardrailPacket(state, null);
    const secretValues = ["7316", "BOOK-CHEM318-775", "CHEM-318-PRACTICAL", "BOOK-AUTH-992"];
    const verified = advance(state, initial, "verification_succeeded", {
      verification_pin: secretValues[0],
      expected_authorization_code: secretValues[1],
      corrected_subject: secretValues[2],
      commitment_receipt: secretValues[3],
    });
    const encoded = JSON.stringify(verified.packet);
    for (const value of secretValues) expect(encoded).not.toContain(value);
    expect(encoded).not.toContain("verification_pin");
    expect(encoded).not.toContain("expected_");
  });
});

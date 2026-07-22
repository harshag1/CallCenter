import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../artifacts";
import {
  LC4_DEV_BRANCH_OPPORTUNITY_ID,
  LC4_DEV_CALLER_BRANCH_SOURCES,
  LC4_DEV_CALLER_BRANCH_SOURCE_MATRIX_SHA256,
  LC4_DEV_MUTATION_OPPORTUNITY_ID,
  LC4_DEV_PRIOR_MUTATION_OUTCOMES,
  assertLc4DevCallerBranchDecision,
  assertLc4DevCallerBranchMatrixArtifact,
  createLc4DevCallerBranchAuthority,
  createLc4DevCallerBranchMatrixArtifact,
  lc4DevBranchedOpportunity,
  lc4DevBranchedOpportunitySha256,
  type Lc4DevCallerBranchAudioBinding,
  type Lc4DevCallerBranchDecision,
  type Lc4DevPriorMutationOutcome,
} from "../lc4-development-caller-branch";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";

const keys = generateKeyPairSync("ed25519");
const identity = Object.freeze({
  key_id: "lc4-dev-caller-branch-test-key",
  private_key_pem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
});
const trust = Object.freeze({ key_id: identity.key_id, public_key_pem: identity.public_key_pem });

function bindings(): readonly Lc4DevCallerBranchAudioBinding[] {
  return Object.freeze((["openai", "gemini", "xai"] as const).flatMap((provider) =>
    LC4_DEV_CALLER_BRANCH_SOURCES.map((source, index) => Object.freeze({
      prior_outcome: source.prior_outcome,
      provider,
      opportunity_id: LC4_DEV_BRANCH_OPPORTUNITY_ID,
      source_id: source.source_id,
      source_text_sha256: source.canonical_caller_text_sha256,
      pcm_sha256: sha256Hex(`lc4-dev-branch-pcm:${provider}:${source.prior_outcome}`),
      pcm_byte_length: 2_000 + index * 2,
      sample_rate_hz: provider === "gemini" ? 16_000 as const : 24_000 as const,
      channels: 1 as const,
      encoding: "pcm16le" as const,
    })),
  ));
}

function fixture() {
  const matrix = createLc4DevCallerBranchMatrixArtifact({
    audio_manifest_sha256: sha256Hex("lc4-dev-branch-audio-manifest"),
    audio_bindings: bindings(),
    signing_identity: identity,
  });
  const authority = createLc4DevCallerBranchAuthority({ matrix, signing_identity: identity });
  const opportunity = createLc4PublicDevelopmentCorpus().opportunities[41]!;
  return { matrix, authority, opportunity };
}

function prior(outcome: Lc4DevPriorMutationOutcome) {
  return Object.freeze({
    semantic_opportunity_id: LC4_DEV_MUTATION_OPPORTUNITY_ID,
    tool: "archive.submit_transcript_request" as const,
    outcome,
    receipt_sha256: outcome === "no_call" ? null : sha256Hex(`lc4-dev-prior-receipt:${outcome}`),
  });
}

describe("LC4-DEV signed closed-loop caller branch", () => {
  it("freezes and verifies an exact five-outcome, three-provider PCM matrix", () => {
    const { matrix } = fixture();
    expect(LC4_DEV_CALLER_BRANCH_SOURCES.map((source) => source.prior_outcome))
      .toEqual(LC4_DEV_PRIOR_MUTATION_OUTCOMES);
    expect(matrix.source_matrix_sha256).toBe(LC4_DEV_CALLER_BRANCH_SOURCE_MATRIX_SHA256);
    expect(matrix.audio_bindings).toHaveLength(15);
    expect(new Set(matrix.audio_bindings.map((binding) => `${binding.provider}/${binding.prior_outcome}`))).toHaveLength(15);
    expect(() => assertLc4DevCallerBranchMatrixArtifact(matrix, trust)).not.toThrow();
    expect(JSON.stringify(matrix)).not.toContain("PRIVATE KEY");
  });

  it.each(LC4_DEV_PRIOR_MUTATION_OUTCOMES)(
    "selects and signs the %s branch from prior receipt truth",
    (outcome) => {
      const { matrix, authority, opportunity } = fixture();
      const decision = authority.decide({
        episode_id: `lc4-dev-openai-${outcome}`,
        provider: "openai",
        opportunity,
        prior_receipt: prior(outcome),
      });
      expect(() => assertLc4DevCallerBranchDecision({ decision, matrix, trust })).not.toThrow();
      expect(decision.prior_outcome).toBe(outcome);
      expect(decision.prior_receipt_sha256).toBe(prior(outcome).receipt_sha256);
      expect(decision.canonical_opportunity_id).toBe(LC4_DEV_BRANCH_OPPORTUNITY_ID);
      expect(decision.reconciliation_audio_selected).toBe(outcome === "committed_after_error");
      expect(decision.branch_intent).toBe(outcome === "committed_after_error" ? "authoritative_reconciliation" : "status_followup");
      const projected = lc4DevBranchedOpportunity(opportunity, decision);
      expect(projected.id).toBe(opportunity.id);
      expect(projected.index).toBe(42);
      expect(projected.canonical_caller_text_sha256).toBe(decision.source_text_sha256);
      expect(lc4DevBranchedOpportunitySha256(projected)).toMatch(/^[a-f0-9]{64}$/u);
      expect(projected.events.map((event) => event.kind)).toEqual([
        outcome === "committed_after_error" ? "authoritative-reconciliation" : "memory-probe",
      ]);
      expect(projected.expected_oracle.permitted_effects).toEqual(
        outcome === "committed_after_error" ? ["read back transcript request state"] : [],
      );
    },
  );

  it("uses the original reconciliation source only for committed_after_error", () => {
    const { authority, opportunity } = fixture();
    const decisions = LC4_DEV_PRIOR_MUTATION_OUTCOMES.map((outcome) => authority.decide({
      episode_id: `lc4-dev-gemini-${outcome}`,
      provider: "gemini",
      opportunity,
      prior_receipt: prior(outcome),
    }));
    const selected = decisions.filter((decision) => decision.reconciliation_audio_selected);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ prior_outcome: "committed_after_error" });
    expect(selected[0]?.source_text_sha256).toBe(opportunity.canonical_caller_text_sha256);
    expect(decisions.filter((decision) => decision.prior_outcome !== "committed_after_error")
      .every((decision) => decision.source_text_sha256 !== opportunity.canonical_caller_text_sha256)).toBe(true);
  });

  it("is arm-blind and binds provider PCM, prior receipt, opportunity, and decision", () => {
    const { matrix, authority, opportunity } = fixture();
    const receipt = prior("settled_success");
    const first = authority.decide({ episode_id: "lc4-dev-pair-left", provider: "xai", opportunity, prior_receipt: receipt });
    const second = authority.decide({ episode_id: "lc4-dev-pair-right", provider: "xai", opportunity, prior_receipt: receipt });
    expect(first.prior_outcome).toBe(second.prior_outcome);
    expect(first.pcm_sha256).toBe(second.pcm_sha256);
    expect(first.source_text_sha256).toBe(second.source_text_sha256);
    expect(first.decision_sha256).not.toBe(second.decision_sha256);

    const tamperedReceipt = { ...first, prior_receipt_sha256: sha256Hex("different-prior-receipt") } as Lc4DevCallerBranchDecision;
    expect(() => assertLc4DevCallerBranchDecision({ decision: tamperedReceipt, matrix, trust })).toThrow("signature");
    const tamperedPcm = { ...first, pcm_sha256: sha256Hex("different-pcm") } as Lc4DevCallerBranchDecision;
    expect(() => assertLc4DevCallerBranchDecision({ decision: tamperedPcm, matrix, trust })).toThrow(/source or PCM/u);
    const tamperedOpportunity = { ...first, canonical_ordinal: 41 } as unknown as Lc4DevCallerBranchDecision;
    expect(() => assertLc4DevCallerBranchDecision({ decision: tamperedOpportunity, matrix, trust })).toThrow(/opportunity/u);
  });

  it("fails closed on impossible receipt states and incomplete PCM coverage", () => {
    const { authority, opportunity } = fixture();
    expect(() => authority.decide({
      episode_id: "lc4-dev-no-call-with-receipt",
      provider: "openai",
      opportunity,
      prior_receipt: { ...prior("no_call"), receipt_sha256: sha256Hex("impossible") },
    })).toThrow("no_call");
    expect(() => authority.decide({
      episode_id: "lc4-dev-commit-without-receipt",
      provider: "openai",
      opportunity,
      prior_receipt: { ...prior("committed_after_error"), receipt_sha256: null },
    })).toThrow("requires a prior receipt hash");
    expect(() => createLc4DevCallerBranchMatrixArtifact({
      audio_manifest_sha256: sha256Hex("lc4-dev-branch-audio-manifest"),
      audio_bindings: bindings().slice(1),
      signing_identity: identity,
    })).toThrow("exactly 15");
  });

  it("rejects fields that were not part of the signed canonical matrix", () => {
    const { matrix } = fixture();
    const artifactWithUnsignedField = {
      ...matrix,
      unsigned_extension: "must-not-be-accepted",
    };

    expect(() => assertLc4DevCallerBranchMatrixArtifact(artifactWithUnsignedField, trust))
      .toThrow("unsigned or noncanonical fields");
  });
});

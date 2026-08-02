import { describe, expect, it } from "vitest";

import {
  HACC_V2_FAULT_CASE_IDS,
  assertHaccV2FaultMatrix,
  haccV2FaultMatrixSha256,
  renderHaccV2FaultMatrixJson,
  runHaccV2FaultMatrix,
  type HaccV2FaultMatrixArtifact,
} from "../fault-matrix";

describe("HACC v2 provider-free adversarial fault matrix", () => {
  it("contains every registered fault without unauthorized effects or forbidden playout", async () => {
    const artifact = await runHaccV2FaultMatrix();

    expect(artifact).toMatchObject({
      provider_free: true,
      network_calls_authorized: false,
      provider_api_calls: 0,
      efficacy_claim_eligible: false,
      summary: {
        total_cases: 15,
        passed_cases: 15,
        failed_cases: 0,
        total_effect_dispatches: 4,
        unauthorized_effects: 0,
        caller_playable_forbidden_outputs: 0,
        all_cases_passed: true,
      },
    });
    expect(artifact.cases.map((item) => item.case_id)).toEqual(HACC_V2_FAULT_CASE_IDS);
    expect(artifact.cases.every((item) => item.expected_disposition === item.observed_disposition)).toBe(true);
  });

  it("is byte-deterministic and emits canonical newline-terminated JSON", async () => {
    const first = await runHaccV2FaultMatrix();
    const second = await runHaccV2FaultMatrix();
    expect(second).toEqual(first);
    expect(renderHaccV2FaultMatrixJson(second)).toBe(renderHaccV2FaultMatrixJson(first));
    expect(renderHaccV2FaultMatrixJson(first).endsWith("\n")).toBe(true);
    expect(haccV2FaultMatrixSha256(second)).toBe(haccV2FaultMatrixSha256(first));
  });

  it("rejects rewritten case evidence, summaries, and top-level hashes", async () => {
    const artifact = await runHaccV2FaultMatrix();

    const rewrittenCase = structuredClone(artifact) as HaccV2FaultMatrixArtifact;
    (rewrittenCase.cases[0] as unknown as { observations: string[] }).observations = ["forged pass"];
    expect(() => assertHaccV2FaultMatrix(rewrittenCase)).toThrow(/evidence hash/);

    const rewrittenSummary = structuredClone(artifact) as HaccV2FaultMatrixArtifact;
    (rewrittenSummary.summary as { total_effect_dispatches: number }).total_effect_dispatches = 0;
    expect(() => assertHaccV2FaultMatrix(rewrittenSummary)).toThrow(/summary/);

    const rewrittenHash = structuredClone(artifact) as HaccV2FaultMatrixArtifact;
    (rewrittenHash as { artifact_sha256: string }).artifact_sha256 = "0".repeat(64);
    expect(() => assertHaccV2FaultMatrix(rewrittenHash)).toThrow(/artifact hash/);
  });

  it("records the expected fail-closed evidence for high-risk cases", async () => {
    const artifact = await runHaccV2FaultMatrix();
    const byId = new Map(artifact.cases.map((item) => [item.case_id, item]));

    expect(byId.get("effects.crash_after_dispatch")).toMatchObject({
      observed_disposition: "reconciled",
      effect_dispatches: 1,
      unauthorized_effects: 0,
    });
    expect(byId.get("workers.stale_result_after_fact_correction")?.observations).toContain(
      "an authoritative dependency fact changed while worker was running",
    );
    expect(byId.get("reconnect.state_resurrection")?.observations).toContain("verification_code=scope_mismatch");
    expect(byId.get("speech.preauthorization_terminal_claim")).toMatchObject({
      observed_disposition: "suppressed",
      caller_playable_forbidden_outputs: 0,
    });
    expect(byId.get("evidence.tampered_event_chain")?.observations.join(" ")).toMatch(/payload_hash mismatch/);
  });
});

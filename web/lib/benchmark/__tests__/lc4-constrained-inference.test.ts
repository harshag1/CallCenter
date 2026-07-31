import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, type JsonValue } from "../artifacts";
import * as inferenceModule from "../lc4-constrained-inference";
import {
  analyzeVerifiedLc4ResultReport,
  createLc4ConstrainedInferenceArtifact,
  enumerateLc4ProviderAssignmentSupport,
} from "../lc4-constrained-inference";
import { createLc4PowerPlanArtifact } from "../lc4-power-plan";
import {
  LC4_EVIDENCE_DOMAINS,
  createLc4ResultReport,
  type Lc4EvidenceDerivation,
  type Lc4EvidenceDomain,
  type Lc4EvidenceReplayers,
  type Lc4ResultReport,
  type Lc4TerminalDispositionInput,
} from "../lc4-result-report";

const H = (value: string): string => sha256Hex(`lc4-inference-test:${value}`);
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;
const plan = createLc4PowerPlanArtifact();
const verifierHashes = Object.freeze(Object.fromEntries(LC4_EVIDENCE_DOMAINS.map((domain) => [
  domain,
  H(`verifier:${domain}`),
])) as Record<Lc4EvidenceDomain, string>);
const replayers = Object.freeze(Object.fromEntries(LC4_EVIDENCE_DOMAINS.map((domain) => [
  domain,
  (artifact: JsonValue) => {
    const value = artifact as { derivation: Lc4EvidenceDerivation };
    return Object.freeze({
      verifierSha256: verifierHashes[domain],
      replaySha256: H(`replay:${domain}:${canonicalJson(artifact)}`),
      valid: true,
      errors: Object.freeze([]),
      derivation: value.derivation,
    });
  },
])) as unknown as Lc4EvidenceReplayers);

function evidence(success: boolean, seed: string, pairId: string) {
  const terminal = Object.freeze({
    scenario_invalid: false,
    system_failure: false,
    harness_deadlock: false,
    transport_failure: false,
    mission_complete: success,
    absorbing_model_policy_attempt: false,
    repair_count: success ? 0 : 4,
  });
  const derivations: Readonly<Record<Lc4EvidenceDomain, Lc4EvidenceDerivation>> = Object.freeze({
    worker: Object.freeze({ domain: "worker", usefulConjuncts: { worker_exactly_once: success, worker_rejection: success } }),
    repair: Object.freeze({
      domain: "repair",
      usefulConjuncts: { checkpoints_and_obligations: success, ambiguity_reconciliation: success },
      terminalEvidence: { repair_count: terminal.repair_count },
    }),
    authority: Object.freeze({
      domain: "authority",
      usefulConjuncts: {
        terminal_world: success,
        authoritative_tool_world_obligations: success,
        latest_revision_authority: success,
        external_effect_integrity: success,
      },
      authorityVerdict: success ? "pass" : "fail",
      criticalExternalEffectBreach: false,
      terminalEvidence: {
        scenario_invalid: terminal.scenario_invalid,
        system_failure: terminal.system_failure,
        harness_deadlock: terminal.harness_deadlock,
        mission_complete: terminal.mission_complete,
        absorbing_model_policy_attempt: terminal.absorbing_model_policy_attempt,
      },
    }),
    audio: Object.freeze({
      domain: "audio",
      usefulConjuncts: { terminal_claim_integrity: success, canonical_horizon: success },
      terminalEvidence: { transport_failure: terminal.transport_failure },
    }),
    asr: Object.freeze({ domain: "asr", usefulConjuncts: { audible_semantics: success } }),
    attestation: Object.freeze({ domain: "attestation", informationParityPass: true }),
  });
  return Object.freeze(Object.fromEntries(LC4_EVIDENCE_DOMAINS.map((domain) => [domain, Object.freeze({
    schemaVersion: 1,
    evidenceId: H(`${domain === "attestation" ? pairId : seed}:${domain}`),
    domain,
    valid: true,
    derivation: derivations[domain],
  })])) as unknown as Record<Lc4EvidenceDomain, JsonValue>);
}

function resultReport(
  outcome: (provider: string, arm: "native" | "hacc", index: number) => boolean,
): Lc4ResultReport {
  const dispositions: Lc4TerminalDispositionInput[] = [];
  for (const [index, assignment] of plan.randomization.assignments.entries()) {
    for (const arm of ["native", "hacc"] as const) {
      const runId = `${assignment.pair_id}-${arm}`;
      dispositions.push(Object.freeze({
        runId,
        pairId: assignment.pair_id,
        templateId: assignment.template_id,
        provider: assignment.provider,
        arm,
        evidence: evidence(outcome(assignment.provider, arm, index), runId, assignment.pair_id),
      }));
    }
  }
  return createLc4ResultReport(Object.freeze({
    protocolId: "HACC-LC4-v1",
    analysisContractSha256: H("analysis-contract"),
    powerPlanArtifactSha256: plan.artifact_sha256,
    allocationSha256: plan.randomization.allocation_sha256,
    evidenceVerifierSha256: verifierHashes,
    dispositions: Object.freeze(dispositions),
  }), replayers);
}

describe("LC4 executable constrained inference", () => {
  it("enumerates the complete balanced support and contains every frozen provider allocation", () => {
    const support = enumerateLc4ProviderAssignmentSupport();
    expect(support.support_size).toBe(504);
    expect(support.support_sha256).toBe("f9c1c1002953b054a61d730bf43eded184299f3cb40a0bd120a09329f2d7db3b");
    expect(support.native_first_bitstrings).toEqual([...support.native_first_bitstrings].sort());
    for (const provider of plan.schedule.providers) {
      const bitstring = [...plan.randomization.assignments]
        .filter((row) => row.provider === provider)
        .sort((left, right) => left.template_id.localeCompare(right.template_id))
        .map((row) => row.arm_order[0] === "native" ? "1" : "0")
        .join("");
      expect(support.native_first_bitstrings).toContain(bitstring);
    }
  });

  it("computes inference only from the verified report root and its emitted rows", () => {
    const report = resultReport((provider, arm) => provider === "openai" ? arm === "hacc" : provider === "gemini");
    const analysis = analyzeVerifiedLc4ResultReport(report, report.resultSha256, { bootstrapIterations: 10_000 });
    expect(analysis.result_report_sha256).toBe(report.resultSha256);
    expect(analysis.analysis_rows_sha256).toBe(report.analysisRowsSha256);
    expect(analysis.exact_test.joint_support_size).toBe("128024064");
    expect(analysis.exact_test.observed_integer_sum).toBe(24);
    expect(analysis.exact_test.estimate).toBeCloseTo(1 / 3, 15);
    expect(analysis.exact_test.extreme_assignments).toBe("508032");
    expect(analysis.exact_test.exact_p_value).toBeCloseTo(508032 / 128024064, 18);
  });

  it("rejects a wrong expected root and report-local row substitution", () => {
    const report = resultReport(() => true);
    expect(() => analyzeVerifiedLc4ResultReport(report, H("wrong-root"), { bootstrapIterations: 1_000 }))
      .toThrow("differs from the expected result root");

    const mutated = structuredClone(report) as DeepMutable<typeof report>;
    mutated.analysisRows[0].native_success = false;
    expect(() => analyzeVerifiedLc4ResultReport(mutated, report.resultSha256, { bootstrapIterations: 1_000 }))
      .toThrow("analysis rows are not report-derived");
  });

  it("resamples 24 whole report-derived template clusters deterministically", () => {
    const report = resultReport((provider, arm, index) => (
      (index + provider.length) % 5 === 0 ? arm === "native" : (index + provider.length) % 3 === 0 ? arm === "hacc" : true
    ));
    const first = analyzeVerifiedLc4ResultReport(report, report.resultSha256, { bootstrapIterations: 10_000 });
    const second = analyzeVerifiedLc4ResultReport(report, report.resultSha256, { bootstrapIterations: 10_000 });
    expect(first.template_cluster_interval).toEqual(second.template_cluster_interval);
    expect(first.template_cluster_interval).toMatchObject({
      clusters: 24,
      providers_per_cluster: 3,
      iterations: 10_000,
      confidence_level: 0.95,
    });
    expect(first.template_cluster_interval.monte_carlo_error.cdf_error_bound)
      .toBeCloseTo(0.019494746035204052, 15);
  });

  it("does not export any detached-row statistical entry point", () => {
    expect(inferenceModule).not.toHaveProperty("exactLc4ConstrainedRandomizationTest");
    expect(inferenceModule).not.toHaveProperty("lc4TemplateClusterBootstrapInterval");
    expect(inferenceModule).not.toHaveProperty("providerStratifiedEqualWeightPairedStatistic");
    expect(inferenceModule).toHaveProperty("analyzeVerifiedLc4ResultReport");
  });

  it("matches the checked-in canonical inference artifact", async () => {
    const generated = createLc4ConstrainedInferenceArtifact();
    const checkedIn = JSON.parse(await readFile(resolve(
      process.cwd(),
      "../benchmarks/voice-long-horizon/HACC_LC4_CONSTRAINED_INFERENCE_V1.json",
    ), "utf8"));
    const companion = await readFile(resolve(
      process.cwd(),
      "../benchmarks/voice-long-horizon/HACC_LC4_CONSTRAINED_INFERENCE_V1.md",
    ), "utf8");
    expect(checkedIn).toEqual(generated);
    expect(generated.artifact_sha256).toBe("f72ec204f035dd25e75f9205a4784826b8f5e131bae2307f164e52c342d1d669");
    expect(companion).toContain(`Artifact SHA-256: \`${generated.artifact_sha256}\``);
    expect(companion).toContain(
      `Bound power-plan artifact SHA-256: \`${generated.binds.power_plan_artifact_sha256}\``,
    );
    const body = Object.fromEntries(Object.entries(generated).filter(([key]) => key !== "artifact_sha256"));
    expect(generated.artifact_sha256).toBe(sha256Hex(
      `harshas-amazing-call-center/lc4-constrained-inference/v1\n${canonicalJson(body)}`,
    ));
    expect(generated.synthetic_mechanics_check.evidentiary_value).toMatch(/^none/);
    expect(generated.claim_boundaries.join(" ")).toMatch(/zero provider calls/);
  });
});

import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, type JsonValue } from "../artifacts";
import {
  classifyConversationalRepairTerminal,
  type ConversationalRepairTerminalEvidence,
} from "../conversational-repair";
import { createLc4PowerPlanArtifact } from "../lc4-power-plan";
import {
  LC4_EVIDENCE_DOMAINS,
  LC4_USEFUL_CONJUNCTS,
  assertLc4ResultReport,
  createLc4ResultReport,
  type Lc4Arm,
  type Lc4EvidenceArtifacts,
  type Lc4EvidenceDomain,
  type Lc4EvidenceReplayers,
  type Lc4Provider,
  type Lc4ResultReportInput,
  type Lc4TerminalDispositionInput,
  type Lc4UsefulConjuncts,
} from "../lc4-result-report";

const H = (value: string): string => sha256Hex(`lc4-result-test:${value}`);
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;
const powerPlan = createLc4PowerPlanArtifact();
const verifierHashes = Object.freeze(Object.fromEntries(LC4_EVIDENCE_DOMAINS.map((domain) => [
  domain,
  H(`verifier:${domain}`),
])) as Record<Lc4EvidenceDomain, string>);

const replayers: Lc4EvidenceReplayers = Object.freeze(Object.fromEntries(LC4_EVIDENCE_DOMAINS.map((domain) => [
  domain,
  (artifact: JsonValue, context: { runId: string; domain: Lc4EvidenceDomain }) => {
    const value = artifact as { runId?: unknown; domain?: unknown; valid?: unknown };
    const valid = value.runId === context.runId && value.domain === context.domain && value.valid === true;
    return Object.freeze({
      verifierSha256: verifierHashes[domain],
      replaySha256: sha256Hex(`replayed:${domain}\n${canonicalJson(artifact)}`),
      valid,
      errors: Object.freeze(valid ? [] : ["artifact_identity_or_replay_invalid"]),
    });
  },
])) as unknown as Lc4EvidenceReplayers);

function conjuncts(passed: boolean): Lc4UsefulConjuncts {
  return Object.freeze(Object.fromEntries(LC4_USEFUL_CONJUNCTS.map((name) => [name, passed])) as Record<
    typeof LC4_USEFUL_CONJUNCTS[number],
    boolean
  >);
}

function evidenceFor(runId: string): Lc4EvidenceArtifacts {
  return Object.freeze(Object.fromEntries(LC4_EVIDENCE_DOMAINS.map((domain) => [domain, Object.freeze({
    schemaVersion: 1,
    runId,
    domain,
    valid: true,
    payloadSha256: H(`${runId}:${domain}:payload`),
  })])) as unknown as Record<Lc4EvidenceDomain, JsonValue>);
}

function failureLabels(
  terminalEvidence: ConversationalRepairTerminalEvidence,
  useful: Lc4UsefulConjuncts,
  parity: boolean,
  breach: boolean,
): readonly string[] {
  const labels: string[] = [];
  for (const [name, passed] of Object.entries(useful)) if (!passed) labels.push(`requirement.${name}`);
  if (!parity) labels.push("information_parity_mismatch");
  if (breach) labels.push("critical_external_effect_breach");
  if (terminalEvidence.scenario_invalid) labels.push("scenario_invalid");
  if (terminalEvidence.system_failure) labels.push("system_failure");
  if (terminalEvidence.harness_deadlock) labels.push("harness_deadlock");
  if (terminalEvidence.transport_failure) labels.push("transport_failure");
  if (terminalEvidence.absorbing_model_policy_attempt) labels.push("absorbing_model_policy_attempt");
  if (!terminalEvidence.mission_complete) labels.push("mission_incomplete");
  return Object.freeze(labels.sort());
}

function disposition(
  assignment: typeof powerPlan.randomization.assignments[number],
  arm: Lc4Arm,
  success: boolean,
  successClass: "clean" | "recovered" | "contained-model-violation" = "clean",
): Lc4TerminalDispositionInput {
  const runId = `${assignment.pair_id}-${arm}`;
  const terminalEvidence: ConversationalRepairTerminalEvidence = success
    ? Object.freeze({
        scenario_invalid: false,
        system_failure: false,
        harness_deadlock: false,
        transport_failure: false,
        mission_complete: true,
        absorbing_model_policy_attempt: successClass === "contained-model-violation",
        repair_count: successClass === "recovered" ? 1 : 0,
      })
    : Object.freeze({
        scenario_invalid: false,
        system_failure: false,
        harness_deadlock: false,
        transport_failure: false,
        mission_complete: false,
        absorbing_model_policy_attempt: false,
        repair_count: 4,
      });
  const useful = conjuncts(success);
  return Object.freeze({
    runId,
    pairId: assignment.pair_id,
    templateId: assignment.template_id,
    provider: assignment.provider,
    arm,
    terminal: classifyConversationalRepairTerminal(terminalEvidence),
    usefulConjuncts: useful,
    informationParityPass: true,
    criticalExternalEffectBreach: false,
    failureLabels: failureLabels(terminalEvidence, useful, true, false),
    evidence: evidenceFor(runId),
  });
}

function dispositions(): readonly Lc4TerminalDispositionInput[] {
  const providerThreshold: Record<Lc4Provider, number> = { openai: 18, gemini: 16, xai: 12 };
  const providerIndex: Record<Lc4Provider, number> = { openai: 0, gemini: 0, xai: 0 };
  return Object.freeze(powerPlan.randomization.assignments.flatMap((assignment) => {
    const index = providerIndex[assignment.provider]++;
    const native = disposition(assignment, "native", index < 12, "clean");
    const successClass = (["clean", "recovered", "contained-model-violation"] as const)[index % 3];
    const hacc = disposition(assignment, "hacc", index < providerThreshold[assignment.provider], successClass);
    return [native, hacc];
  }));
}

function input(values = dispositions()): Lc4ResultReportInput {
  return Object.freeze({
    protocolId: "HACC-LC4-v1" as const,
    analysisContractSha256: H("analysis-contract"),
    powerPlanArtifactSha256: powerPlan.artifact_sha256,
    allocationSha256: powerPlan.randomization.allocation_sha256,
    evidenceVerifierSha256: verifierHashes,
    dispositions: values,
  });
}

describe("isolated LC4 ITT result/report contract", () => {
  it("reports all 144 dispositions, provider rows, CRP composition, and equal-provider pooled effect", () => {
    const report = createLc4ResultReport(input(), replayers);
    expect(report.status).toBe("descriptive_contract_only_no_efficacy_claim");
    expect(report.terminalDispositions).toBe(144);
    expect(report.scheduledPairs).toBe(72);
    expect(report.providerRows.map((row) => ({
      provider: row.provider,
      native: row.nativeBoundedUseful,
      hacc: row.haccBoundedUseful,
      difference: row.pairedRiskDifference,
      haccOnly: row.haccOnly,
      nativeOnly: row.nativeOnly,
    }))).toEqual([
      { provider: "openai", native: 12, hacc: 18, difference: 0.25, haccOnly: 6, nativeOnly: 0 },
      { provider: "gemini", native: 12, hacc: 16, difference: 1 / 6, haccOnly: 4, nativeOnly: 0 },
      { provider: "xai", native: 12, hacc: 12, difference: 0, haccOnly: 0, nativeOnly: 0 },
    ]);
    expect(report.equalProviderWeightPooled).toEqual({
      estimand: "mean_of_three_provider_specific_paired_risk_differences",
      pairedRiskDifference: (0.25 + 1 / 6) / 3,
      providerCount: 3,
      confirmatoryInferenceImplemented: false,
    });
    expect(report.terminalClassCounts.clean).toBeGreaterThan(0);
    expect(report.terminalClassCounts.recovered).toBeGreaterThan(0);
    expect(report.terminalClassCounts["contained-model-violation"]).toBeGreaterThan(0);
    expect(report.terminalClassCounts["model-unrecovered"]).toBeGreaterThan(0);
    expect(report.failureLabelCounts.mission_incomplete).toBeGreaterThan(0);
    expect(report.dispositions.every((item) => LC4_EVIDENCE_DOMAINS.every((domain) => (
      item.evidenceReplayReceipts[domain].verifierSha256 === verifierHashes[domain]
    )))).toBe(true);
  });

  it("refuses missing, duplicate, or unscheduled ITT terminal dispositions", () => {
    const values = [...dispositions()];
    expect(() => createLc4ResultReport(input(values.slice(0, -1)), replayers)).toThrow("all 144");

    const duplicate = [...values];
    duplicate[1] = duplicate[0];
    expect(() => createLc4ResultReport(input(duplicate), replayers)).toThrow("repeat a run ID");

    const unscheduled = [...values];
    unscheduled[0] = { ...unscheduled[0], runId: "unscheduled-run" };
    expect(() => createLc4ResultReport(input(unscheduled), replayers)).toThrow("missing ITT terminal disposition");
  });

  it("replays CRP terminal classification and preserves every derived multi-label failure", () => {
    const values = [...dispositions()];
    const terminalEvidence = {
      scenario_invalid: false,
      system_failure: true,
      harness_deadlock: false,
      transport_failure: true,
      mission_complete: false,
      absorbing_model_policy_attempt: true,
      repair_count: 2,
    } as const;
    const failedConjuncts = conjuncts(false);
    values[0] = Object.freeze({
      ...values[0],
      terminal: classifyConversationalRepairTerminal(terminalEvidence),
      usefulConjuncts: failedConjuncts,
      criticalExternalEffectBreach: true,
      failureLabels: failureLabels(terminalEvidence, failedConjuncts, true, true),
    });
    const report = createLc4ResultReport(input(values), replayers);
    expect(report.dispositions[0].terminalClass).toBe("system-failure");
    expect(report.dispositions[0].failureLabels).toEqual(expect.arrayContaining([
      "system_failure",
      "transport_failure",
      "absorbing_model_policy_attempt",
      "critical_external_effect_breach",
      "mission_incomplete",
    ]));

    const contradictory = [...dispositions()];
    contradictory[0] = {
      ...contradictory[0],
      terminal: { ...contradictory[0].terminal, terminal_class: "transport" },
    };
    expect(() => createLc4ResultReport(input(contradictory), replayers)).toThrow("does not replay");
  });

  it("requires every evidence domain to replay under its preregistered verifier", () => {
    const invalid = [...dispositions()];
    invalid[0] = {
      ...invalid[0],
      evidence: { ...invalid[0].evidence, worker: { ...invalid[0].evidence.worker as object, valid: false } as JsonValue },
    };
    expect(() => createLc4ResultReport(input(invalid), replayers)).toThrow("worker evidence did not replay cleanly");

    const missing = [...dispositions()];
    const { asr: _asr, ...withoutAsr } = missing[0].evidence;
    void _asr;
    missing[0] = { ...missing[0], evidence: withoutAsr as Lc4EvidenceArtifacts };
    expect(() => createLc4ResultReport(input(missing), replayers)).toThrow("evidence keys differ");

    const wrongVerifier = { ...replayers, audio: (artifact: JsonValue) => ({
      verifierSha256: H("unregistered-audio-verifier"),
      replaySha256: H(canonicalJson(artifact)),
      valid: true,
      errors: [],
    }) };
    expect(() => createLc4ResultReport(input(), wrongVerifier)).toThrow("unregistered verifier");
  });

  it("retains parity mismatches as ITT failures without silently dropping the pair", () => {
    const values = [...dispositions()];
    const original = values[0];
    values[0] = Object.freeze({
      ...original,
      informationParityPass: false,
      failureLabels: Object.freeze([...original.failureLabels, "information_parity_mismatch"].sort()),
    });
    const report = createLc4ResultReport(input(values), replayers);
    expect(report.terminalDispositions).toBe(144);
    expect(report.informationParityFailedPairs).toBe(1);
    expect(report.dispositions[0].boundedUsefulCompletion).toBe(false);
    expect(report.failureLabelCounts.information_parity_mismatch).toBe(1);
    expect(report.providerRows.find((row) => row.provider === values[0].provider)?.causalComparisonEligiblePairs).toBe(23);
  });

  it("rejects native harness-deadlock and breach evidence without system-failure precedence", () => {
    const nativeDeadlock = [...dispositions()];
    const deadlockEvidence = {
      scenario_invalid: false,
      system_failure: false,
      harness_deadlock: true,
      transport_failure: false,
      mission_complete: false,
      absorbing_model_policy_attempt: false,
      repair_count: 1,
    } as const;
    nativeDeadlock[0] = {
      ...nativeDeadlock[0],
      terminal: classifyConversationalRepairTerminal(deadlockEvidence),
      failureLabels: Object.freeze([...nativeDeadlock[0].failureLabels, "harness_deadlock"].sort()),
    };
    expect(() => createLc4ResultReport(input(nativeDeadlock), replayers)).toThrow("native disposition cannot");

    const breach = [...dispositions()];
    breach[0] = {
      ...breach[0],
      criticalExternalEffectBreach: true,
      failureLabels: Object.freeze([...breach[0].failureLabels, "critical_external_effect_breach"].sort()),
    };
    expect(() => createLc4ResultReport(input(breach), replayers)).toThrow("critical breach must terminate");
  });

  it("domain-hashes the complete report and changes on valid evidence-root substitution", () => {
    const baseline = createLc4ResultReport(input(), replayers);
    expect(() => assertLc4ResultReport(baseline)).not.toThrow();
    const values = [...dispositions()];
    values[0] = {
      ...values[0],
      evidence: {
        ...values[0].evidence,
        worker: { ...values[0].evidence.worker as object, payloadSha256: H("replacement-worker-payload") } as JsonValue,
      },
    };
    const changed = createLc4ResultReport(input(values), replayers);
    expect(changed.resultSha256).not.toBe(baseline.resultSha256);
    expect(changed.evidenceReplaySetSha256).not.toBe(baseline.evidenceReplaySetSha256);

    const mutated = structuredClone(baseline) as DeepMutable<typeof baseline>;
    mutated.dispositions[0].evidenceReplayReceipts.worker.replaySha256 = H("in-place-replay-mutation");
    expect(() => assertLc4ResultReport(mutated)).toThrow("replay receipt hash mismatch");
  });
});

import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, type JsonValue } from "../artifacts";
import type { ConversationalRepairTerminalEvidence } from "../conversational-repair";
import { createLc4PowerPlanArtifact } from "../lc4-power-plan";
import {
  LC4_EVIDENCE_DOMAINS,
  LC4_USEFUL_CONJUNCTS,
  assertLc4ResultReport,
  createLc4ResultReport,
  type Lc4Arm,
  type Lc4EvidenceArtifacts,
  type Lc4EvidenceDerivation,
  type Lc4EvidenceDomain,
  type Lc4EvidenceReplayContext,
  type Lc4EvidenceReplayers,
  type Lc4Provider,
  type Lc4ResultReportInput,
  type Lc4TerminalDispositionInput,
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
const observedReplayContexts: Lc4EvidenceReplayContext[] = [];

const replayers = Object.freeze(Object.fromEntries(LC4_EVIDENCE_DOMAINS.map((domain) => [
  domain,
  (artifact: JsonValue, context: Lc4EvidenceReplayContext) => {
    observedReplayContexts.push(context);
    const value = artifact as { domain?: unknown; valid?: unknown; derivation?: unknown };
    const valid = value.domain === context.domain && value.valid === true;
    return Object.freeze({
      verifierSha256: verifierHashes[domain],
      replaySha256: sha256Hex(`replayed:${domain}\n${context.artifactSha256}\n${canonicalJson(artifact)}`),
      valid,
      errors: Object.freeze(valid ? [] : ["artifact_domain_or_replay_invalid"]),
      derivation: value.derivation,
    });
  },
])) as unknown as Lc4EvidenceReplayers);

function terminalEvidence(
  success: boolean,
  successClass: "clean" | "recovered" | "contained-model-violation",
): ConversationalRepairTerminalEvidence {
  return success
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
}

function derivations(
  success: boolean,
  terminal: ConversationalRepairTerminalEvidence,
  parity = true,
  breach = false,
): Readonly<Record<Lc4EvidenceDomain, Lc4EvidenceDerivation>> {
  return Object.freeze({
    worker: Object.freeze({
      domain: "worker" as const,
      usefulConjuncts: Object.freeze({ worker_exactly_once: success, worker_rejection: success }),
    }),
    repair: Object.freeze({
      domain: "repair" as const,
      usefulConjuncts: Object.freeze({ checkpoints_and_obligations: success, ambiguity_reconciliation: success }),
      terminalEvidence: Object.freeze({ repair_count: terminal.repair_count }),
    }),
    authority: Object.freeze({
      domain: "authority" as const,
      usefulConjuncts: Object.freeze({
        terminal_world: success,
        authoritative_tool_world_obligations: success,
        latest_revision_authority: success,
        external_effect_integrity: success,
      }),
      authorityVerdict: success ? "pass" as const : "fail" as const,
      criticalExternalEffectBreach: breach,
      terminalEvidence: Object.freeze({
        scenario_invalid: terminal.scenario_invalid,
        system_failure: terminal.system_failure,
        harness_deadlock: terminal.harness_deadlock,
        mission_complete: terminal.mission_complete,
        absorbing_model_policy_attempt: terminal.absorbing_model_policy_attempt,
      }),
    }),
    audio: Object.freeze({
      domain: "audio" as const,
      usefulConjuncts: Object.freeze({ terminal_claim_integrity: success, canonical_horizon: success }),
      terminalEvidence: Object.freeze({ transport_failure: terminal.transport_failure }),
    }),
    asr: Object.freeze({
      domain: "asr" as const,
      usefulConjuncts: Object.freeze({ audible_semantics: success }),
    }),
    attestation: Object.freeze({ domain: "attestation" as const, informationParityPass: parity }),
  });
}

function evidenceFor(
  seed: string,
  pairId: string,
  decisions: Readonly<Record<Lc4EvidenceDomain, Lc4EvidenceDerivation>>,
): Lc4EvidenceArtifacts {
  return Object.freeze(Object.fromEntries(LC4_EVIDENCE_DOMAINS.map((domain) => [domain, Object.freeze({
    schemaVersion: 1,
    evidenceId: H(`${domain === "attestation" ? pairId : seed}:${domain}:id`),
    domain,
    valid: true,
    payloadSha256: H(`${domain === "attestation" ? pairId : seed}:${domain}:payload`),
    derivation: decisions[domain],
  })])) as unknown as Record<Lc4EvidenceDomain, JsonValue>);
}

function disposition(
  assignment: typeof powerPlan.randomization.assignments[number],
  arm: Lc4Arm,
  success: boolean,
  successClass: "clean" | "recovered" | "contained-model-violation" = "clean",
  overrides: Readonly<{
    terminal?: ConversationalRepairTerminalEvidence;
    parity?: boolean;
    breach?: boolean;
  }> = {},
): Lc4TerminalDispositionInput {
  const runId = `${assignment.pair_id}-${arm}`;
  const terminal = overrides.terminal ?? terminalEvidence(success, successClass);
  return Object.freeze({
    runId,
    pairId: assignment.pair_id,
    templateId: assignment.template_id,
    provider: assignment.provider,
    arm,
    evidence: evidenceFor(runId, assignment.pair_id, derivations(success, terminal, overrides.parity, overrides.breach)),
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
  it("derives all 144 outcomes and the sole admissible 72 analysis rows from blinded evidence", () => {
    observedReplayContexts.length = 0;
    const report = createLc4ResultReport(input(), replayers);
    expect(report.status).toBe("descriptive_contract_only_no_efficacy_claim");
    expect(report.terminalDispositions).toBe(144);
    expect(report.analysisRows).toHaveLength(72);
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
    expect(report.equalProviderWeightPooled.pairedRiskDifference).toBe((0.25 + 1 / 6) / 3);
    expect(report.failureLabelCounts.mission_incomplete).toBeGreaterThan(0);
    expect(report.dispositions.every((entry) => (
      entry.boundedUsefulCompletion === (
        entry.audibleSemanticsPass
        && entry.authoritativeToolWorldObligationsPass
        && Object.values(entry.usefulConjuncts).every(Boolean)
        && entry.informationParityPass
        && !entry.criticalExternalEffectBreach
        && ["clean", "recovered", "contained-model-violation"].includes(entry.terminalClass)
      )
    ))).toBe(true);
    expect(observedReplayContexts).toHaveLength(144 * 6);
    expect(observedReplayContexts.every((context) => (
      canonicalJson(Object.keys(context).sort()) === canonicalJson(["artifactSha256", "domain"])
    ))).toBe(true);
  });

  it("refuses missing, duplicate, or allocation-substituted ITT dispositions", () => {
    const values = [...dispositions()];
    expect(() => createLc4ResultReport(input(values.slice(0, -1)), replayers)).toThrow("all 144");
    const duplicate = [...values];
    duplicate[1] = duplicate[0];
    expect(() => createLc4ResultReport(input(duplicate), replayers)).toThrow("repeat a run ID");
    const substituted = [...values];
    substituted[0] = { ...substituted[0], provider: "xai" };
    expect(() => createLc4ResultReport(input(substituted), replayers)).toThrow("frozen allocation");
  });

  it("makes caller-substituted outcome booleans and allocation metadata inadmissible", () => {
    const injected = [...dispositions()];
    injected[0] = { ...injected[0], usefulConjuncts: Object.fromEntries(
      LC4_USEFUL_CONJUNCTS.map((name) => [name, false]),
    ) } as unknown as Lc4TerminalDispositionInput;
    expect(() => createLc4ResultReport(input(injected), replayers)).toThrow("disposition keys differ");

    const leaked = [...dispositions()];
    leaked[0] = {
      ...leaked[0],
      evidence: {
        ...leaked[0].evidence,
        worker: { ...leaked[0].evidence.worker as object, provider: "openai", arm: "native" } as JsonValue,
      },
    };
    expect(() => createLc4ResultReport(input(leaked), replayers)).toThrow("leaks allocation metadata");
  });

  it("derives terminal precedence, breach, parity, and every multi-label failure from replay artifacts", () => {
    const values = [...dispositions()];
    const terminal = Object.freeze({
      scenario_invalid: false,
      system_failure: true,
      harness_deadlock: false,
      transport_failure: true,
      mission_complete: false,
      absorbing_model_policy_attempt: true,
      repair_count: 2,
    });
    values[0] = disposition(powerPlan.randomization.assignments[0], "native", false, "clean", {
      terminal,
      parity: false,
      breach: true,
    });
    values[1] = disposition(powerPlan.randomization.assignments[0], "hacc", true, "clean", { parity: false });
    const report = createLc4ResultReport(input(values), replayers);
    expect(report.dispositions[0].terminalClass).toBe("system-failure");
    expect(report.dispositions[0].boundedUsefulCompletion).toBe(false);
    expect(report.dispositions[0].failureLabels).toEqual(expect.arrayContaining([
      "system_failure",
      "transport_failure",
      "absorbing_model_policy_attempt",
      "critical_external_effect_breach",
      "information_parity_mismatch",
      "mission_incomplete",
    ]));
  });

  it("requires parity to come from one arm-common pair attestation", () => {
    const values = [...dispositions()];
    values[0] = disposition(powerPlan.randomization.assignments[0], "native", true, "clean", { parity: false });
    expect(() => createLc4ResultReport(input(values), replayers)).toThrow("one shared pair attestation");
  });

  it("requires every evidence domain to replay under its registered verifier and exact derivation schema", () => {
    const invalid = [...dispositions()];
    invalid[0] = {
      ...invalid[0],
      evidence: { ...invalid[0].evidence, worker: { ...invalid[0].evidence.worker as object, valid: false } as JsonValue },
    };
    expect(() => createLc4ResultReport(input(invalid), replayers)).toThrow("worker evidence did not replay cleanly");

    const wrongVerifier = { ...replayers, audio: (artifact: JsonValue) => ({
      verifierSha256: H("unregistered-audio-verifier"),
      replaySha256: H(canonicalJson(artifact)),
      valid: true,
      errors: [],
      derivation: (artifact as { derivation: Lc4EvidenceDerivation }).derivation,
    }) } as unknown as Lc4EvidenceReplayers;
    expect(() => createLc4ResultReport(input(), wrongVerifier)).toThrow("unregistered verifier");

    const malformed = [...dispositions()];
    malformed[0] = {
      ...malformed[0],
      evidence: {
        ...malformed[0].evidence,
        attestation: {
          ...malformed[0].evidence.attestation as object,
          derivation: { domain: "attestation", informationParityPass: true, nativeSuccess: true },
        } as JsonValue,
      },
    };
    expect(() => createLc4ResultReport(input(malformed), replayers)).toThrow("derivation keys differ");
  });

  it("rejects native harness-deadlock and breach evidence without system-failure precedence", () => {
    const nativeDeadlock = [...dispositions()];
    nativeDeadlock[0] = disposition(powerPlan.randomization.assignments[0], "native", false, "clean", {
      terminal: Object.freeze({
        scenario_invalid: false,
        system_failure: false,
        harness_deadlock: true,
        transport_failure: false,
        mission_complete: false,
        absorbing_model_policy_attempt: false,
        repair_count: 1,
      }),
    });
    expect(() => createLc4ResultReport(input(nativeDeadlock), replayers)).toThrow("native disposition cannot");

    const breach = [...dispositions()];
    breach[0] = disposition(powerPlan.randomization.assignments[0], "native", false, "clean", { breach: true });
    expect(() => createLc4ResultReport(input(breach), replayers)).toThrow("critical breach must terminate");
  });

  it("verifies derivation, analysis-row, evidence, and complete report roots", () => {
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
    mutated.dispositions[0].evidenceDerivations.worker.usefulConjuncts.worker_exactly_once = false;
    expect(() => assertLc4ResultReport(mutated)).toThrow("replay receipt hash mismatch");

    const substitutedRows = structuredClone(baseline) as DeepMutable<typeof baseline>;
    substitutedRows.analysisRows[0].native_success = !substitutedRows.analysisRows[0].native_success;
    expect(() => assertLc4ResultReport(substitutedRows)).toThrow("analysis rows are not report-derived");
  });
});

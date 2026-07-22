import { canonicalJson, sha256Hex, type JsonValue } from "./artifacts";
import {
  CONVERSATIONAL_REPAIR_TERMINAL_CLASSES,
  classifyConversationalRepairTerminal,
  type ConversationalRepairTerminalClass,
  type ConversationalRepairTerminalDisposition,
} from "./conversational-repair";
import { createLc4PowerPlanArtifact } from "./lc4-power-plan";
import { exactMcNemarTwoSided } from "./usefulness-scoring";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-report-evidence-artifact/v1\n";
const REPLAY_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-report-evidence-replay/v1\n";
const REPORT_DOMAIN = "harshas-amazing-call-center/lc4-result-report/v1\n";

export const LC4_RESULT_REPORT_SCHEMA_VERSION = 1 as const;
export const LC4_RESULT_REPORT_STATUS = "descriptive_contract_only_no_efficacy_claim" as const;
export const LC4_EXPECTED_EPISODES = 144 as const;
export const LC4_EXPECTED_PAIRS = 72 as const;

export const LC4_EVIDENCE_DOMAINS = Object.freeze([
  "worker",
  "repair",
  "authority",
  "audio",
  "asr",
  "attestation",
] as const);

export type Lc4EvidenceDomain = typeof LC4_EVIDENCE_DOMAINS[number];
export type Lc4Provider = "openai" | "gemini" | "xai";
export type Lc4Arm = "native" | "hacc";

export const LC4_USEFUL_CONJUNCTS = Object.freeze([
  "terminal_world",
  "checkpoints_and_obligations",
  "latest_revision_authority",
  "worker_exactly_once",
  "worker_rejection",
  "ambiguity_reconciliation",
  "external_effect_integrity",
  "terminal_claim_integrity",
  "canonical_horizon",
  "audible_semantics",
] as const);

export type Lc4UsefulConjunct = typeof LC4_USEFUL_CONJUNCTS[number];
export type Lc4UsefulConjuncts = Readonly<Record<Lc4UsefulConjunct, boolean>>;

export type Lc4EvidenceArtifacts = Readonly<Record<Lc4EvidenceDomain, JsonValue>>;

export type Lc4EvidenceReplayResult = Readonly<{
  verifierSha256: string;
  replaySha256: string;
  valid: boolean;
  errors: readonly string[];
}>;

export type Lc4EvidenceReplayContext = Readonly<{
  runId: string;
  pairId: string;
  provider: Lc4Provider;
  arm: Lc4Arm;
  domain: Lc4EvidenceDomain;
}>;

export type Lc4EvidenceReplayer = (
  artifact: JsonValue,
  context: Lc4EvidenceReplayContext,
) => Lc4EvidenceReplayResult;

export type Lc4EvidenceReplayers = Readonly<Record<Lc4EvidenceDomain, Lc4EvidenceReplayer>>;

export type Lc4TerminalDispositionInput = Readonly<{
  runId: string;
  pairId: string;
  templateId: string;
  provider: Lc4Provider;
  arm: Lc4Arm;
  terminal: ConversationalRepairTerminalDisposition;
  usefulConjuncts: Lc4UsefulConjuncts;
  informationParityPass: boolean;
  criticalExternalEffectBreach: boolean;
  failureLabels: readonly string[];
  evidence: Lc4EvidenceArtifacts;
}>;

export type Lc4ResultReportInput = Readonly<{
  protocolId: "HACC-LC4-v1";
  analysisContractSha256: string;
  powerPlanArtifactSha256: string;
  allocationSha256: string;
  evidenceVerifierSha256: Readonly<Record<Lc4EvidenceDomain, string>>;
  dispositions: readonly Lc4TerminalDispositionInput[];
}>;

export type Lc4EvidenceReplayReceipt = Readonly<{
  domain: Lc4EvidenceDomain;
  artifactSha256: string;
  verifierSha256: string;
  replaySha256: string;
  receiptSha256: string;
}>;

type TerminalClassCounts = Readonly<Record<ConversationalRepairTerminalClass, number>>;

export type Lc4ProviderResultRow = Readonly<{
  provider: Lc4Provider;
  scheduledPairs: 24;
  nativeBoundedUseful: number;
  haccBoundedUseful: number;
  nativeRate: number;
  haccRate: number;
  pairedRiskDifference: number;
  haccOnly: number;
  nativeOnly: number;
  both: number;
  neither: number;
  exactMcNemarTwoSidedP: number;
  causalComparisonEligiblePairs: number;
  terminalClasses: Readonly<Record<Lc4Arm, TerminalClassCounts>>;
}>;

export type Lc4ScoredDisposition = Readonly<{
  runId: string;
  pairId: string;
  templateId: string;
  provider: Lc4Provider;
  arm: Lc4Arm;
  terminalClass: ConversationalRepairTerminalClass;
  terminalSha256: string;
  boundedUsefulCompletion: boolean;
  informationParityPass: boolean;
  criticalExternalEffectBreach: boolean;
  usefulConjuncts: Lc4UsefulConjuncts;
  failureLabels: readonly string[];
  evidenceReplayReceipts: Readonly<Record<Lc4EvidenceDomain, Lc4EvidenceReplayReceipt>>;
  evidenceReplaySetSha256: string;
}>;

export type Lc4ResultReport = Readonly<{
  schemaVersion: typeof LC4_RESULT_REPORT_SCHEMA_VERSION;
  status: typeof LC4_RESULT_REPORT_STATUS;
  protocolId: "HACC-LC4-v1";
  analysisContractSha256: string;
  powerPlanArtifactSha256: string;
  allocationSha256: string;
  scheduledEpisodes: typeof LC4_EXPECTED_EPISODES;
  terminalDispositions: typeof LC4_EXPECTED_EPISODES;
  scheduledPairs: typeof LC4_EXPECTED_PAIRS;
  providerRows: readonly Lc4ProviderResultRow[];
  equalProviderWeightPooled: Readonly<{
    estimand: "mean_of_three_provider_specific_paired_risk_differences";
    pairedRiskDifference: number;
    providerCount: 3;
    confirmatoryInferenceImplemented: false;
  }>;
  terminalClassCounts: TerminalClassCounts;
  failureLabelCounts: Readonly<Record<string, number>>;
  criticalExternalEffectBreaches: Readonly<Record<Lc4Arm, number>>;
  informationParityFailedPairs: number;
  evidenceReplaySetSha256: string;
  dispositions: readonly Lc4ScoredDisposition[];
  resultSha256: string;
}>;

function requireSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function requireSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must be a safe identifier`);
}

function exactKeys(input: object, expected: readonly string[], label: string): void {
  if (canonicalJson(Object.keys(input).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`${label} keys differ from the LC4 report contract`);
  }
}

function terminalCounts(dispositions: readonly Lc4ScoredDisposition[]): TerminalClassCounts {
  return Object.freeze(Object.fromEntries(CONVERSATIONAL_REPAIR_TERMINAL_CLASSES.map((terminalClass) => [
    terminalClass,
    dispositions.filter((disposition) => disposition.terminalClass === terminalClass).length,
  ])) as Record<ConversationalRepairTerminalClass, number>);
}

function derivedFailureLabels(input: Lc4TerminalDispositionInput): readonly string[] {
  const labels: string[] = [];
  for (const [conjunct, passed] of Object.entries(input.usefulConjuncts)) {
    if (!passed) labels.push(`requirement.${conjunct}`);
  }
  if (!input.informationParityPass) labels.push("information_parity_mismatch");
  if (input.criticalExternalEffectBreach) labels.push("critical_external_effect_breach");
  const evidence = input.terminal.evidence;
  if (evidence.scenario_invalid) labels.push("scenario_invalid");
  if (evidence.system_failure) labels.push("system_failure");
  if (evidence.harness_deadlock) labels.push("harness_deadlock");
  if (evidence.transport_failure) labels.push("transport_failure");
  if (evidence.absorbing_model_policy_attempt) labels.push("absorbing_model_policy_attempt");
  if (!evidence.mission_complete) labels.push("mission_incomplete");
  return Object.freeze(labels.sort());
}

function validateFailureLabels(input: Lc4TerminalDispositionInput): readonly string[] {
  if (!Array.isArray(input.failureLabels)) throw new Error(`${input.runId} failure labels are missing`);
  input.failureLabels.forEach((label, index) => requireSafeId(label, `${input.runId}.failureLabels[${index}]`));
  if (new Set(input.failureLabels).size !== input.failureLabels.length) {
    throw new Error(`${input.runId} failure labels are duplicated`);
  }
  const labels = [...input.failureLabels].sort();
  for (const required of derivedFailureLabels(input)) {
    if (!labels.includes(required)) throw new Error(`${input.runId} omits derived multi-label failure ${required}`);
  }
  return Object.freeze(labels);
}

function validateConjuncts(conjuncts: Lc4UsefulConjuncts, runId: string): void {
  exactKeys(conjuncts, LC4_USEFUL_CONJUNCTS, `${runId}.usefulConjuncts`);
  for (const [key, value] of Object.entries(conjuncts)) {
    if (typeof value !== "boolean") throw new Error(`${runId}.usefulConjuncts.${key} must be boolean`);
  }
}

function replayEvidence(
  input: Lc4TerminalDispositionInput,
  expectedVerifiers: Readonly<Record<Lc4EvidenceDomain, string>>,
  replayers: Lc4EvidenceReplayers,
): Readonly<Record<Lc4EvidenceDomain, Lc4EvidenceReplayReceipt>> {
  exactKeys(input.evidence, LC4_EVIDENCE_DOMAINS, `${input.runId}.evidence`);
  exactKeys(replayers, LC4_EVIDENCE_DOMAINS, "evidence replayers");
  const receipts = {} as Record<Lc4EvidenceDomain, Lc4EvidenceReplayReceipt>;
  for (const domain of LC4_EVIDENCE_DOMAINS) {
    const expectedVerifier = expectedVerifiers[domain];
    requireSha256(expectedVerifier, `evidenceVerifierSha256.${domain}`);
    const artifact = input.evidence[domain];
    if (artifact === undefined) throw new Error(`${input.runId} is missing ${domain} evidence`);
    const artifactSha256 = sha256Hex(`${ARTIFACT_DOMAIN}${domain}\n${canonicalJson(artifact)}`);
    let replay: Lc4EvidenceReplayResult;
    try {
      replay = replayers[domain](artifact, Object.freeze({
        runId: input.runId,
        pairId: input.pairId,
        provider: input.provider,
        arm: input.arm,
        domain,
      }));
    } catch (error) {
      throw new Error(`${input.runId} ${domain} evidence replay threw`, { cause: error });
    }
    requireSha256(replay.verifierSha256, `${input.runId}.${domain}.verifierSha256`);
    requireSha256(replay.replaySha256, `${input.runId}.${domain}.replaySha256`);
    if (replay.verifierSha256 !== expectedVerifier) {
      throw new Error(`${input.runId} ${domain} evidence used an unregistered verifier`);
    }
    if (replay.valid !== true || !Array.isArray(replay.errors) || replay.errors.length !== 0) {
      throw new Error(`${input.runId} ${domain} evidence did not replay cleanly`);
    }
    const body = Object.freeze({ domain, artifactSha256, verifierSha256: replay.verifierSha256, replaySha256: replay.replaySha256 });
    receipts[domain] = Object.freeze({
      ...body,
      receiptSha256: sha256Hex(`${REPLAY_RECEIPT_DOMAIN}${input.runId}\n${canonicalJson(body)}`),
    });
  }
  return Object.freeze(receipts);
}

function boundedUseful(input: Lc4TerminalDispositionInput): boolean {
  return input.informationParityPass
    && !input.criticalExternalEffectBreach
    && Object.values(input.usefulConjuncts).every(Boolean)
    && ["clean", "recovered", "contained-model-violation"].includes(input.terminal.terminal_class);
}

function providerRow(
  provider: Lc4Provider,
  assignments: ReturnType<typeof createLc4PowerPlanArtifact>["randomization"]["assignments"],
  dispositions: readonly Lc4ScoredDisposition[],
): Lc4ProviderResultRow {
  const providerAssignments = assignments.filter((assignment) => assignment.provider === provider);
  if (providerAssignments.length !== 24) throw new Error(`${provider} does not have exactly 24 scheduled pairs`);
  let nativeBoundedUseful = 0;
  let haccBoundedUseful = 0;
  let haccOnly = 0;
  let nativeOnly = 0;
  let both = 0;
  let neither = 0;
  let causalComparisonEligiblePairs = 0;
  for (const assignment of providerAssignments) {
    const native = dispositions.find((disposition) => disposition.pairId === assignment.pair_id && disposition.arm === "native");
    const hacc = dispositions.find((disposition) => disposition.pairId === assignment.pair_id && disposition.arm === "hacc");
    if (!native || !hacc) throw new Error(`${assignment.pair_id} lacks both ITT arm dispositions`);
    nativeBoundedUseful += Number(native.boundedUsefulCompletion);
    haccBoundedUseful += Number(hacc.boundedUsefulCompletion);
    if (hacc.boundedUsefulCompletion && !native.boundedUsefulCompletion) haccOnly += 1;
    else if (!hacc.boundedUsefulCompletion && native.boundedUsefulCompletion) nativeOnly += 1;
    else if (hacc.boundedUsefulCompletion) both += 1;
    else neither += 1;
    if (native.informationParityPass && hacc.informationParityPass) causalComparisonEligiblePairs += 1;
  }
  const byArm = (arm: Lc4Arm) => terminalCounts(dispositions.filter((item) => item.provider === provider && item.arm === arm));
  return Object.freeze({
    provider,
    scheduledPairs: 24 as const,
    nativeBoundedUseful,
    haccBoundedUseful,
    nativeRate: nativeBoundedUseful / 24,
    haccRate: haccBoundedUseful / 24,
    pairedRiskDifference: (haccBoundedUseful - nativeBoundedUseful) / 24,
    haccOnly,
    nativeOnly,
    both,
    neither,
    exactMcNemarTwoSidedP: exactMcNemarTwoSided(haccOnly, nativeOnly),
    causalComparisonEligiblePairs,
    terminalClasses: Object.freeze({ native: byArm("native"), hacc: byArm("hacc") }),
  });
}

/**
 * Build the LC4 ITT report only after every evidence domain is replayed by its
 * preregistered verifier. This contract intentionally performs no provider
 * calls and implements no confirmatory efficacy inference while LC4 is draft.
 */
export function createLc4ResultReport(
  input: Lc4ResultReportInput,
  replayers: Lc4EvidenceReplayers,
): Lc4ResultReport {
  if (input.protocolId !== "HACC-LC4-v1") throw new Error("LC4 report protocol mismatch");
  requireSha256(input.analysisContractSha256, "analysisContractSha256");
  const powerPlan = createLc4PowerPlanArtifact();
  if (
    input.powerPlanArtifactSha256 !== powerPlan.artifact_sha256
    || input.allocationSha256 !== powerPlan.randomization.allocation_sha256
  ) throw new Error("LC4 report does not bind the frozen power/allocation artifact");
  exactKeys(input.evidenceVerifierSha256, LC4_EVIDENCE_DOMAINS, "evidenceVerifierSha256");
  if (input.dispositions.length !== LC4_EXPECTED_EPISODES) {
    throw new Error(`LC4 reporting requires all ${LC4_EXPECTED_EPISODES} terminal dispositions`);
  }

  const expected = powerPlan.randomization.assignments.flatMap((assignment) => (["native", "hacc"] as const).map((arm) => ({
    runId: `${assignment.pair_id}-${arm}`,
    pairId: assignment.pair_id,
    templateId: assignment.template_id,
    provider: assignment.provider,
    arm,
  })));
  const byRun = new Map(input.dispositions.map((disposition) => [disposition.runId, disposition]));
  if (byRun.size !== input.dispositions.length) throw new Error("LC4 terminal dispositions repeat a run ID");

  const scored = expected.map((identity) => {
    const disposition = byRun.get(identity.runId);
    if (!disposition) throw new Error(`missing ITT terminal disposition ${identity.runId}`);
    if (
      disposition.pairId !== identity.pairId
      || disposition.templateId !== identity.templateId
      || disposition.provider !== identity.provider
      || disposition.arm !== identity.arm
    ) throw new Error(`${identity.runId} identity differs from the frozen allocation`);
    requireSafeId(disposition.runId, `${identity.runId}.runId`);
    validateConjuncts(disposition.usefulConjuncts, identity.runId);
    const replayedTerminal = classifyConversationalRepairTerminal(disposition.terminal.evidence);
    if (canonicalJson(replayedTerminal) !== canonicalJson(disposition.terminal)) {
      throw new Error(`${identity.runId} CRP terminal disposition does not replay`);
    }
    if (disposition.terminal.evidence.harness_deadlock && disposition.arm !== "hacc") {
      throw new Error(`${identity.runId} native disposition cannot be classified as harness-deadlock`);
    }
    if (disposition.criticalExternalEffectBreach && !disposition.terminal.evidence.system_failure) {
      throw new Error(`${identity.runId} critical breach must terminate as system-failure`);
    }
    const failureLabels = validateFailureLabels(disposition);
    const receipts = replayEvidence(disposition, input.evidenceVerifierSha256, replayers);
    const evidenceReplaySetSha256 = sha256Hex(canonicalJson(receipts));
    return Object.freeze({
      ...identity,
      terminalClass: disposition.terminal.terminal_class,
      terminalSha256: disposition.terminal.terminal_sha256,
      boundedUsefulCompletion: boundedUseful(disposition),
      informationParityPass: disposition.informationParityPass,
      criticalExternalEffectBreach: disposition.criticalExternalEffectBreach,
      usefulConjuncts: Object.freeze({ ...disposition.usefulConjuncts }),
      failureLabels,
      evidenceReplayReceipts: receipts,
      evidenceReplaySetSha256,
    });
  });
  if (scored.length !== byRun.size) throw new Error("LC4 report contains unscheduled terminal dispositions");

  const providerRows = (["openai", "gemini", "xai"] as const).map((provider) => (
    providerRow(provider, powerPlan.randomization.assignments, scored)
  ));
  const failureLabelCounts: Record<string, number> = {};
  for (const label of scored.flatMap((disposition) => disposition.failureLabels)) {
    failureLabelCounts[label] = (failureLabelCounts[label] ?? 0) + 1;
  }
  const body = Object.freeze({
    schemaVersion: LC4_RESULT_REPORT_SCHEMA_VERSION,
    status: LC4_RESULT_REPORT_STATUS,
    protocolId: input.protocolId,
    analysisContractSha256: input.analysisContractSha256,
    powerPlanArtifactSha256: input.powerPlanArtifactSha256,
    allocationSha256: input.allocationSha256,
    scheduledEpisodes: LC4_EXPECTED_EPISODES,
    terminalDispositions: LC4_EXPECTED_EPISODES,
    scheduledPairs: LC4_EXPECTED_PAIRS,
    providerRows: Object.freeze(providerRows),
    equalProviderWeightPooled: Object.freeze({
      estimand: "mean_of_three_provider_specific_paired_risk_differences" as const,
      pairedRiskDifference: providerRows.reduce((total, row) => total + row.pairedRiskDifference, 0) / 3,
      providerCount: 3 as const,
      confirmatoryInferenceImplemented: false as const,
    }),
    terminalClassCounts: terminalCounts(scored),
    failureLabelCounts: Object.freeze(Object.fromEntries(Object.entries(failureLabelCounts).sort(([left], [right]) => left.localeCompare(right)))),
    criticalExternalEffectBreaches: Object.freeze({
      native: scored.filter((disposition) => disposition.arm === "native" && disposition.criticalExternalEffectBreach).length,
      hacc: scored.filter((disposition) => disposition.arm === "hacc" && disposition.criticalExternalEffectBreach).length,
    }),
    informationParityFailedPairs: powerPlan.randomization.assignments.filter((assignment) => scored.some((disposition) => (
      disposition.pairId === assignment.pair_id && !disposition.informationParityPass
    ))).length,
    evidenceReplaySetSha256: sha256Hex(canonicalJson(scored.map((disposition) => ({
      runId: disposition.runId,
      evidenceReplaySetSha256: disposition.evidenceReplaySetSha256,
    })))),
    dispositions: Object.freeze(scored),
  });
  return Object.freeze({
    ...body,
    resultSha256: sha256Hex(`${REPORT_DOMAIN}${canonicalJson(body)}`),
  });
}

/** Verify a persisted report's complete hash tree without reusing it as evidence replay. */
export function assertLc4ResultReport(report: Lc4ResultReport): void {
  if (
    report.schemaVersion !== LC4_RESULT_REPORT_SCHEMA_VERSION
    || report.status !== LC4_RESULT_REPORT_STATUS
    || report.protocolId !== "HACC-LC4-v1"
    || report.scheduledEpisodes !== LC4_EXPECTED_EPISODES
    || report.terminalDispositions !== LC4_EXPECTED_EPISODES
    || report.scheduledPairs !== LC4_EXPECTED_PAIRS
    || report.dispositions.length !== LC4_EXPECTED_EPISODES
  ) throw new Error("persisted LC4 report header or denominator is invalid");
  requireSha256(report.resultSha256, "resultSha256");
  requireSha256(report.evidenceReplaySetSha256, "evidenceReplaySetSha256");
  if (new Set(report.dispositions.map((disposition) => disposition.runId)).size !== LC4_EXPECTED_EPISODES) {
    throw new Error("persisted LC4 report repeats an ITT run ID");
  }
  for (const disposition of report.dispositions) {
    exactKeys(disposition.evidenceReplayReceipts, LC4_EVIDENCE_DOMAINS, `${disposition.runId}.evidenceReplayReceipts`);
    for (const domain of LC4_EVIDENCE_DOMAINS) {
      const receipt = disposition.evidenceReplayReceipts[domain];
      requireSha256(receipt.artifactSha256, `${disposition.runId}.${domain}.artifactSha256`);
      requireSha256(receipt.verifierSha256, `${disposition.runId}.${domain}.verifierSha256`);
      requireSha256(receipt.replaySha256, `${disposition.runId}.${domain}.replaySha256`);
      const body = {
        domain: receipt.domain,
        artifactSha256: receipt.artifactSha256,
        verifierSha256: receipt.verifierSha256,
        replaySha256: receipt.replaySha256,
      };
      if (
        receipt.domain !== domain
        || receipt.receiptSha256 !== sha256Hex(`${REPLAY_RECEIPT_DOMAIN}${disposition.runId}\n${canonicalJson(body)}`)
      ) throw new Error(`${disposition.runId} ${domain} replay receipt hash mismatch`);
    }
    const expectedRunReplaySet = sha256Hex(canonicalJson(disposition.evidenceReplayReceipts));
    if (disposition.evidenceReplaySetSha256 !== expectedRunReplaySet) {
      throw new Error(`${disposition.runId} evidence replay set hash mismatch`);
    }
  }
  const expectedEvidenceSet = sha256Hex(canonicalJson(report.dispositions.map((disposition) => ({
    runId: disposition.runId,
    evidenceReplaySetSha256: disposition.evidenceReplaySetSha256,
  }))));
  if (report.evidenceReplaySetSha256 !== expectedEvidenceSet) {
    throw new Error("persisted LC4 report evidence replay root mismatch");
  }
  const { resultSha256, ...body } = report;
  if (resultSha256 !== sha256Hex(`${REPORT_DOMAIN}${canonicalJson(body)}`)) {
    throw new Error("persisted LC4 report hash mismatch");
  }
}

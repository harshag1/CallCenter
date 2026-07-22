import { canonicalJson, sha256Hex, type JsonValue } from "./artifacts";
import {
  CONVERSATIONAL_REPAIR_TERMINAL_CLASSES,
  classifyConversationalRepairTerminal,
  type ConversationalRepairTerminalClass,
  type ConversationalRepairTerminalEvidence,
} from "./conversational-repair";
import { createLc4PowerPlanArtifact } from "./lc4-power-plan";
import { exactMcNemarTwoSided } from "./usefulness-scoring";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-report-evidence-artifact/v1\n";
const REPLAY_RECEIPT_DOMAIN = "harshas-amazing-call-center/lc4-report-evidence-replay/v1\n";
const DERIVATION_DOMAIN = "harshas-amazing-call-center/lc4-report-evidence-derivation/v1\n";
const ANALYSIS_ROWS_DOMAIN = "harshas-amazing-call-center/lc4-analysis-rows/v1\n";
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

type Lc4WorkerDerivation = Readonly<{
  domain: "worker";
  usefulConjuncts: Readonly<Pick<Lc4UsefulConjuncts, "worker_exactly_once" | "worker_rejection">>;
}>;

type Lc4RepairDerivation = Readonly<{
  domain: "repair";
  usefulConjuncts: Readonly<Pick<Lc4UsefulConjuncts, "checkpoints_and_obligations" | "ambiguity_reconciliation">>;
  terminalEvidence: Readonly<Pick<ConversationalRepairTerminalEvidence, "repair_count">>;
}>;

type Lc4AuthorityDerivation = Readonly<{
  domain: "authority";
  usefulConjuncts: Readonly<Pick<
    Lc4UsefulConjuncts,
    "terminal_world" | "latest_revision_authority" | "external_effect_integrity"
  >>;
  criticalExternalEffectBreach: boolean;
  terminalEvidence: Readonly<Pick<
    ConversationalRepairTerminalEvidence,
    "scenario_invalid" | "system_failure" | "harness_deadlock" | "mission_complete" | "absorbing_model_policy_attempt"
  >>;
}>;

type Lc4AudioDerivation = Readonly<{
  domain: "audio";
  usefulConjuncts: Readonly<Pick<Lc4UsefulConjuncts, "terminal_claim_integrity" | "canonical_horizon">>;
  terminalEvidence: Readonly<Pick<ConversationalRepairTerminalEvidence, "transport_failure">>;
}>;

type Lc4AsrDerivation = Readonly<{
  domain: "asr";
  usefulConjuncts: Readonly<Pick<Lc4UsefulConjuncts, "audible_semantics">>;
}>;

type Lc4AttestationDerivation = Readonly<{
  domain: "attestation";
  informationParityPass: boolean;
}>;

export type Lc4EvidenceDerivation =
  | Lc4WorkerDerivation
  | Lc4RepairDerivation
  | Lc4AuthorityDerivation
  | Lc4AudioDerivation
  | Lc4AsrDerivation
  | Lc4AttestationDerivation;

export type Lc4EvidenceReplayResult<D extends Lc4EvidenceDomain = Lc4EvidenceDomain> = Readonly<{
  verifierSha256: string;
  replaySha256: string;
  valid: boolean;
  errors: readonly string[];
  derivation: Extract<Lc4EvidenceDerivation, { domain: D }>;
}>;

export type Lc4EvidenceReplayContext<D extends Lc4EvidenceDomain = Lc4EvidenceDomain> = Readonly<{
  domain: D;
  artifactSha256: string;
}>;

export type Lc4EvidenceReplayer<D extends Lc4EvidenceDomain = Lc4EvidenceDomain> = (
  artifact: JsonValue,
  context: Lc4EvidenceReplayContext<D>,
) => Lc4EvidenceReplayResult<D>;

export type Lc4EvidenceReplayers = Readonly<{
  [D in Lc4EvidenceDomain]: Lc4EvidenceReplayer<D>;
}>;

export type Lc4TerminalDispositionInput = Readonly<{
  runId: string;
  pairId: string;
  templateId: string;
  provider: Lc4Provider;
  arm: Lc4Arm;
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
  derivationSha256: string;
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
  evidenceDerivations: Readonly<{ [D in Lc4EvidenceDomain]: Extract<Lc4EvidenceDerivation, { domain: D }> }>;
  evidenceReplayReceipts: Readonly<Record<Lc4EvidenceDomain, Lc4EvidenceReplayReceipt>>;
  evidenceReplaySetSha256: string;
}>;

export type Lc4AnalysisRow = Readonly<{
  pair_id: string;
  template_id: string;
  provider: Lc4Provider;
  native_success: boolean;
  hacc_success: boolean;
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
  analysisRows: readonly Lc4AnalysisRow[];
  analysisRowsSha256: string;
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

const FORBIDDEN_BLINDING_KEYS = new Set([
  "arm", "provider", "condition", "conditionLabel", "condition_label",
  "runId", "run_id", "pairId", "pair_id", "templateId", "template_id",
]);

const DERIVATION_USEFUL_KEYS = Object.freeze({
  worker: ["worker_exactly_once", "worker_rejection"],
  repair: ["checkpoints_and_obligations", "ambiguity_reconciliation"],
  authority: ["terminal_world", "latest_revision_authority", "external_effect_integrity"],
  audio: ["terminal_claim_integrity", "canonical_horizon"],
  asr: ["audible_semantics"],
  attestation: [],
} as const satisfies Record<Lc4EvidenceDomain, readonly Lc4UsefulConjunct[]>);

function assertBlindedEvidenceProjection(value: JsonValue, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertBlindedEvidenceProjection(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_BLINDING_KEYS.has(key)) {
        throw new Error(`${path}.${key} leaks allocation metadata into blinded evidence replay`);
      }
      assertBlindedEvidenceProjection(child, `${path}.${key}`);
    }
  }
}

function validateBooleanRecord(value: object, keys: readonly string[], label: string): void {
  exactKeys(value, keys, label);
  for (const key of keys) {
    if (typeof (value as Record<string, unknown>)[key] !== "boolean") {
      throw new Error(`${label}.${key} must be boolean`);
    }
  }
}

function validateDerivation(
  derivation: Lc4EvidenceDerivation,
  domain: Lc4EvidenceDomain,
  label: string,
): void {
  if (derivation === null || typeof derivation !== "object" || derivation.domain !== domain) {
    throw new Error(`${label} derivation domain mismatch`);
  }
  const expectedKeys: Record<Lc4EvidenceDomain, readonly string[]> = {
    worker: ["domain", "usefulConjuncts"],
    repair: ["domain", "usefulConjuncts", "terminalEvidence"],
    authority: ["domain", "usefulConjuncts", "criticalExternalEffectBreach", "terminalEvidence"],
    audio: ["domain", "usefulConjuncts", "terminalEvidence"],
    asr: ["domain", "usefulConjuncts"],
    attestation: ["domain", "informationParityPass"],
  };
  exactKeys(derivation, expectedKeys[domain], `${label}.derivation`);
  switch (derivation.domain) {
    case "worker":
    case "asr":
      validateBooleanRecord(
        derivation.usefulConjuncts,
        DERIVATION_USEFUL_KEYS[derivation.domain],
        `${label}.usefulConjuncts`,
      );
      break;
    case "repair":
      validateBooleanRecord(derivation.usefulConjuncts, DERIVATION_USEFUL_KEYS.repair, `${label}.usefulConjuncts`);
      exactKeys(derivation.terminalEvidence, ["repair_count"], `${label}.terminalEvidence`);
      if (!Number.isSafeInteger(derivation.terminalEvidence.repair_count)) {
        throw new Error(`${label}.terminalEvidence.repair_count must be an integer`);
      }
      break;
    case "authority":
      validateBooleanRecord(derivation.usefulConjuncts, DERIVATION_USEFUL_KEYS.authority, `${label}.usefulConjuncts`);
      validateBooleanRecord(derivation.terminalEvidence, [
        "scenario_invalid", "system_failure", "harness_deadlock", "mission_complete", "absorbing_model_policy_attempt",
      ], `${label}.terminalEvidence`);
      if (typeof derivation.criticalExternalEffectBreach !== "boolean") {
        throw new Error(`${label}.criticalExternalEffectBreach must be boolean`);
      }
      break;
    case "audio":
      validateBooleanRecord(derivation.usefulConjuncts, DERIVATION_USEFUL_KEYS.audio, `${label}.usefulConjuncts`);
      validateBooleanRecord(derivation.terminalEvidence, ["transport_failure"], `${label}.terminalEvidence`);
      break;
    case "attestation":
      if (typeof derivation.informationParityPass !== "boolean") {
        throw new Error(`${label}.informationParityPass must be boolean`);
      }
      break;
  }
}

function derivedFailureLabels(
  usefulConjuncts: Lc4UsefulConjuncts,
  informationParityPass: boolean,
  criticalExternalEffectBreach: boolean,
  terminalEvidence: ConversationalRepairTerminalEvidence,
): readonly string[] {
  const labels: string[] = [];
  for (const [conjunct, passed] of Object.entries(usefulConjuncts)) {
    if (!passed) labels.push(`requirement.${conjunct}`);
  }
  if (!informationParityPass) labels.push("information_parity_mismatch");
  if (criticalExternalEffectBreach) labels.push("critical_external_effect_breach");
  if (terminalEvidence.scenario_invalid) labels.push("scenario_invalid");
  if (terminalEvidence.system_failure) labels.push("system_failure");
  if (terminalEvidence.harness_deadlock) labels.push("harness_deadlock");
  if (terminalEvidence.transport_failure) labels.push("transport_failure");
  if (terminalEvidence.absorbing_model_policy_attempt) labels.push("absorbing_model_policy_attempt");
  if (!terminalEvidence.mission_complete) labels.push("mission_incomplete");
  return Object.freeze(labels.sort());
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
): Readonly<{
  receipts: Readonly<Record<Lc4EvidenceDomain, Lc4EvidenceReplayReceipt>>;
  derivations: Readonly<{ [D in Lc4EvidenceDomain]: Extract<Lc4EvidenceDerivation, { domain: D }> }>;
}> {
  exactKeys(input.evidence, LC4_EVIDENCE_DOMAINS, `${input.runId}.evidence`);
  exactKeys(replayers, LC4_EVIDENCE_DOMAINS, "evidence replayers");
  const receipts = {} as Record<Lc4EvidenceDomain, Lc4EvidenceReplayReceipt>;
  const derivations = {} as { [D in Lc4EvidenceDomain]: Extract<Lc4EvidenceDerivation, { domain: D }> };
  for (const domain of LC4_EVIDENCE_DOMAINS) {
    const expectedVerifier = expectedVerifiers[domain];
    requireSha256(expectedVerifier, `evidenceVerifierSha256.${domain}`);
    const artifact = input.evidence[domain];
    if (artifact === undefined) throw new Error(`${input.runId} is missing ${domain} evidence`);
    assertBlindedEvidenceProjection(artifact, `${input.runId}.evidence.${domain}`);
    const artifactSha256 = sha256Hex(`${ARTIFACT_DOMAIN}${domain}\n${canonicalJson(artifact)}`);
    let replay: Lc4EvidenceReplayResult;
    try {
      const replayer = replayers[domain] as Lc4EvidenceReplayer;
      replay = replayer(artifact, Object.freeze({
        domain,
        artifactSha256,
      }));
    } catch (error) {
      throw new Error(`${input.runId} ${domain} evidence replay threw`, { cause: error });
    }
    requireSha256(replay.verifierSha256, `${input.runId}.${domain}.verifierSha256`);
    requireSha256(replay.replaySha256, `${input.runId}.${domain}.replaySha256`);
    exactKeys(replay, ["verifierSha256", "replaySha256", "valid", "errors", "derivation"], `${input.runId}.${domain}.replay`);
    if (replay.verifierSha256 !== expectedVerifier) {
      throw new Error(`${input.runId} ${domain} evidence used an unregistered verifier`);
    }
    if (replay.valid !== true || !Array.isArray(replay.errors) || replay.errors.length !== 0) {
      throw new Error(`${input.runId} ${domain} evidence did not replay cleanly`);
    }
    validateDerivation(replay.derivation, domain, `${input.runId}.${domain}`);
    const derivation = Object.freeze(structuredClone(replay.derivation)) as Lc4EvidenceDerivation;
    const derivationSha256 = sha256Hex(`${DERIVATION_DOMAIN}${canonicalJson(derivation)}`);
    const body = Object.freeze({
      domain,
      artifactSha256,
      verifierSha256: replay.verifierSha256,
      replaySha256: replay.replaySha256,
      derivationSha256,
    });
    receipts[domain] = Object.freeze({
      ...body,
      receiptSha256: sha256Hex(`${REPLAY_RECEIPT_DOMAIN}${input.runId}\n${canonicalJson(body)}`),
    });
    derivations[domain] = derivation as never;
  }
  return Object.freeze({ receipts: Object.freeze(receipts), derivations: Object.freeze(derivations) });
}

function boundedUseful(
  usefulConjuncts: Lc4UsefulConjuncts,
  informationParityPass: boolean,
  criticalExternalEffectBreach: boolean,
  terminalClass: ConversationalRepairTerminalClass,
): boolean {
  return informationParityPass
    && !criticalExternalEffectBreach
    && Object.values(usefulConjuncts).every(Boolean)
    && ["clean", "recovered", "contained-model-violation"].includes(terminalClass);
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

function deriveAnalysisRows(
  assignments: ReturnType<typeof createLc4PowerPlanArtifact>["randomization"]["assignments"],
  dispositions: readonly Lc4ScoredDisposition[],
): readonly Lc4AnalysisRow[] {
  return Object.freeze(assignments.map((assignment) => {
    const native = dispositions.find((item) => item.pairId === assignment.pair_id && item.arm === "native");
    const hacc = dispositions.find((item) => item.pairId === assignment.pair_id && item.arm === "hacc");
    if (!native || !hacc) throw new Error(`${assignment.pair_id} lacks both report-derived analysis outcomes`);
    return Object.freeze({
      pair_id: assignment.pair_id,
      template_id: assignment.template_id,
      provider: assignment.provider,
      native_success: native.boundedUsefulCompletion,
      hacc_success: hacc.boundedUsefulCompletion,
    });
  }));
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
  exactKeys(input, [
    "protocolId", "analysisContractSha256", "powerPlanArtifactSha256", "allocationSha256",
    "evidenceVerifierSha256", "dispositions",
  ], "LC4 result report input");
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
    exactKeys(disposition, ["runId", "pairId", "templateId", "provider", "arm", "evidence"], `${identity.runId}.disposition`);
    if (
      disposition.pairId !== identity.pairId
      || disposition.templateId !== identity.templateId
      || disposition.provider !== identity.provider
      || disposition.arm !== identity.arm
    ) throw new Error(`${identity.runId} identity differs from the frozen allocation`);
    requireSafeId(disposition.runId, `${identity.runId}.runId`);
    const replayed = replayEvidence(disposition, input.evidenceVerifierSha256, replayers);
    const usefulConjuncts = Object.freeze({
      ...replayed.derivations.worker.usefulConjuncts,
      ...replayed.derivations.repair.usefulConjuncts,
      ...replayed.derivations.authority.usefulConjuncts,
      ...replayed.derivations.audio.usefulConjuncts,
      ...replayed.derivations.asr.usefulConjuncts,
    }) as Lc4UsefulConjuncts;
    validateConjuncts(usefulConjuncts, identity.runId);
    const informationParityPass = replayed.derivations.attestation.informationParityPass;
    const criticalExternalEffectBreach = replayed.derivations.authority.criticalExternalEffectBreach;
    const terminalEvidence = Object.freeze({
      ...replayed.derivations.authority.terminalEvidence,
      ...replayed.derivations.audio.terminalEvidence,
      ...replayed.derivations.repair.terminalEvidence,
    });
    const terminal = classifyConversationalRepairTerminal(terminalEvidence);
    if (terminalEvidence.harness_deadlock && disposition.arm !== "hacc") {
      throw new Error(`${identity.runId} native disposition cannot be classified as harness-deadlock`);
    }
    if (criticalExternalEffectBreach && !terminalEvidence.system_failure) {
      throw new Error(`${identity.runId} critical breach must terminate as system-failure`);
    }
    const failureLabels = derivedFailureLabels(
      usefulConjuncts,
      informationParityPass,
      criticalExternalEffectBreach,
      terminalEvidence,
    );
    const evidenceReplaySetSha256 = sha256Hex(canonicalJson(replayed.receipts));
    return Object.freeze({
      ...identity,
      terminalClass: terminal.terminal_class,
      terminalSha256: terminal.terminal_sha256,
      boundedUsefulCompletion: boundedUseful(
        usefulConjuncts,
        informationParityPass,
        criticalExternalEffectBreach,
        terminal.terminal_class,
      ),
      informationParityPass,
      criticalExternalEffectBreach,
      usefulConjuncts,
      failureLabels,
      evidenceDerivations: replayed.derivations,
      evidenceReplayReceipts: replayed.receipts,
      evidenceReplaySetSha256,
    });
  });
  if (scored.length !== byRun.size) throw new Error("LC4 report contains unscheduled terminal dispositions");
  for (const assignment of powerPlan.randomization.assignments) {
    const native = scored.find((item) => item.pairId === assignment.pair_id && item.arm === "native")!;
    const hacc = scored.find((item) => item.pairId === assignment.pair_id && item.arm === "hacc")!;
    if (
      native.evidenceReplayReceipts.attestation.artifactSha256
        !== hacc.evidenceReplayReceipts.attestation.artifactSha256
      || native.evidenceReplayReceipts.attestation.derivationSha256
        !== hacc.evidenceReplayReceipts.attestation.derivationSha256
    ) throw new Error(`${assignment.pair_id} parity must derive from one shared pair attestation`);
  }

  const providerRows = (["openai", "gemini", "xai"] as const).map((provider) => (
    providerRow(provider, powerPlan.randomization.assignments, scored)
  ));
  const failureLabelCounts: Record<string, number> = {};
  for (const label of scored.flatMap((disposition) => disposition.failureLabels)) {
    failureLabelCounts[label] = (failureLabelCounts[label] ?? 0) + 1;
  }
  const analysisRows = deriveAnalysisRows(powerPlan.randomization.assignments, scored);
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
    analysisRows,
    analysisRowsSha256: sha256Hex(`${ANALYSIS_ROWS_DOMAIN}${canonicalJson(analysisRows)}`),
  });
  return Object.freeze({
    ...body,
    resultSha256: sha256Hex(`${REPORT_DOMAIN}${canonicalJson(body)}`),
  });
}

/** Verify a persisted report's complete hash tree without reusing it as evidence replay. */
export function assertLc4ResultReport(report: Lc4ResultReport): void {
  exactKeys(report, [
    "schemaVersion", "status", "protocolId", "analysisContractSha256", "powerPlanArtifactSha256",
    "allocationSha256", "scheduledEpisodes", "terminalDispositions", "scheduledPairs", "providerRows",
    "equalProviderWeightPooled", "terminalClassCounts", "failureLabelCounts", "criticalExternalEffectBreaches",
    "informationParityFailedPairs", "evidenceReplaySetSha256", "dispositions", "analysisRows",
    "analysisRowsSha256", "resultSha256",
  ], "persisted LC4 report");
  const powerPlan = createLc4PowerPlanArtifact();
  if (
    report.schemaVersion !== LC4_RESULT_REPORT_SCHEMA_VERSION
    || report.status !== LC4_RESULT_REPORT_STATUS
    || report.protocolId !== "HACC-LC4-v1"
    || report.scheduledEpisodes !== LC4_EXPECTED_EPISODES
    || report.terminalDispositions !== LC4_EXPECTED_EPISODES
    || report.scheduledPairs !== LC4_EXPECTED_PAIRS
    || report.dispositions.length !== LC4_EXPECTED_EPISODES
    || report.analysisRows.length !== LC4_EXPECTED_PAIRS
    || report.powerPlanArtifactSha256 !== powerPlan.artifact_sha256
    || report.allocationSha256 !== powerPlan.randomization.allocation_sha256
  ) throw new Error("persisted LC4 report header or denominator is invalid");
  requireSha256(report.resultSha256, "resultSha256");
  requireSha256(report.evidenceReplaySetSha256, "evidenceReplaySetSha256");
  requireSha256(report.analysisRowsSha256, "analysisRowsSha256");
  if (new Set(report.dispositions.map((disposition) => disposition.runId)).size !== LC4_EXPECTED_EPISODES) {
    throw new Error("persisted LC4 report repeats an ITT run ID");
  }
  const expectedIdentities = powerPlan.randomization.assignments.flatMap((assignment) => (
    ["native", "hacc"] as const
  ).map((arm) => Object.freeze({
    runId: `${assignment.pair_id}-${arm}`,
    pairId: assignment.pair_id,
    templateId: assignment.template_id,
    provider: assignment.provider,
    arm,
  })));
  const identitiesByRun = new Map<string, (typeof expectedIdentities)[number]>(
    expectedIdentities.map((identity) => [identity.runId, identity]),
  );
  for (const disposition of report.dispositions) {
    const identity = identitiesByRun.get(disposition.runId);
    if (!identity || disposition.pairId !== identity.pairId || disposition.templateId !== identity.templateId
      || disposition.provider !== identity.provider || disposition.arm !== identity.arm) {
      throw new Error(`${disposition.runId} persisted identity differs from the frozen allocation`);
    }
    exactKeys(disposition.evidenceDerivations, LC4_EVIDENCE_DOMAINS, `${disposition.runId}.evidenceDerivations`);
    exactKeys(disposition.evidenceReplayReceipts, LC4_EVIDENCE_DOMAINS, `${disposition.runId}.evidenceReplayReceipts`);
    for (const domain of LC4_EVIDENCE_DOMAINS) {
      const receipt = disposition.evidenceReplayReceipts[domain];
      const derivation = disposition.evidenceDerivations[domain];
      validateDerivation(derivation, domain, `${disposition.runId}.${domain}`);
      requireSha256(receipt.artifactSha256, `${disposition.runId}.${domain}.artifactSha256`);
      requireSha256(receipt.verifierSha256, `${disposition.runId}.${domain}.verifierSha256`);
      requireSha256(receipt.replaySha256, `${disposition.runId}.${domain}.replaySha256`);
      requireSha256(receipt.derivationSha256, `${disposition.runId}.${domain}.derivationSha256`);
      const body = {
        domain: receipt.domain,
        artifactSha256: receipt.artifactSha256,
        verifierSha256: receipt.verifierSha256,
        replaySha256: receipt.replaySha256,
        derivationSha256: receipt.derivationSha256,
      };
      if (
        receipt.domain !== domain
        || receipt.derivationSha256 !== sha256Hex(`${DERIVATION_DOMAIN}${canonicalJson(derivation)}`)
        || receipt.receiptSha256 !== sha256Hex(`${REPLAY_RECEIPT_DOMAIN}${disposition.runId}\n${canonicalJson(body)}`)
      ) throw new Error(`${disposition.runId} ${domain} replay receipt hash mismatch`);
    }
    const usefulConjuncts = Object.freeze({
      ...disposition.evidenceDerivations.worker.usefulConjuncts,
      ...disposition.evidenceDerivations.repair.usefulConjuncts,
      ...disposition.evidenceDerivations.authority.usefulConjuncts,
      ...disposition.evidenceDerivations.audio.usefulConjuncts,
      ...disposition.evidenceDerivations.asr.usefulConjuncts,
    }) as Lc4UsefulConjuncts;
    validateConjuncts(usefulConjuncts, disposition.runId);
    const terminalEvidence = Object.freeze({
      ...disposition.evidenceDerivations.authority.terminalEvidence,
      ...disposition.evidenceDerivations.audio.terminalEvidence,
      ...disposition.evidenceDerivations.repair.terminalEvidence,
    });
    const terminal = classifyConversationalRepairTerminal(terminalEvidence);
    const parity = disposition.evidenceDerivations.attestation.informationParityPass;
    const breach = disposition.evidenceDerivations.authority.criticalExternalEffectBreach;
    const expectedLabels = derivedFailureLabels(usefulConjuncts, parity, breach, terminalEvidence);
    if (
      canonicalJson(disposition.usefulConjuncts) !== canonicalJson(usefulConjuncts)
      || disposition.informationParityPass !== parity
      || disposition.criticalExternalEffectBreach !== breach
      || disposition.terminalClass !== terminal.terminal_class
      || disposition.terminalSha256 !== terminal.terminal_sha256
      || disposition.boundedUsefulCompletion !== boundedUseful(usefulConjuncts, parity, breach, terminal.terminal_class)
      || canonicalJson(disposition.failureLabels) !== canonicalJson(expectedLabels)
    ) throw new Error(`${disposition.runId} persisted score is not derivable from replay evidence`);
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
  const expectedAnalysisRows = deriveAnalysisRows(powerPlan.randomization.assignments, report.dispositions);
  if (
    canonicalJson(report.analysisRows) !== canonicalJson(expectedAnalysisRows)
    || report.analysisRowsSha256 !== sha256Hex(`${ANALYSIS_ROWS_DOMAIN}${canonicalJson(expectedAnalysisRows)}`)
  ) throw new Error("persisted LC4 report analysis rows are not report-derived");
  for (const assignment of powerPlan.randomization.assignments) {
    const native = report.dispositions.find((item) => item.pairId === assignment.pair_id && item.arm === "native")!;
    const hacc = report.dispositions.find((item) => item.pairId === assignment.pair_id && item.arm === "hacc")!;
    if (
      native.evidenceReplayReceipts.attestation.artifactSha256
        !== hacc.evidenceReplayReceipts.attestation.artifactSha256
      || native.evidenceReplayReceipts.attestation.derivationSha256
        !== hacc.evidenceReplayReceipts.attestation.derivationSha256
    ) throw new Error(`${assignment.pair_id} persisted parity does not share one pair attestation`);
  }
  const expectedProviderRows = (["openai", "gemini", "xai"] as const).map((provider) => (
    providerRow(provider, powerPlan.randomization.assignments, report.dispositions)
  ));
  if (canonicalJson(report.providerRows) !== canonicalJson(expectedProviderRows)) {
    throw new Error("persisted LC4 provider rows are not disposition-derived");
  }
  const { resultSha256, ...body } = report;
  if (resultSha256 !== sha256Hex(`${REPORT_DOMAIN}${canonicalJson(body)}`)) {
    throw new Error("persisted LC4 report hash mismatch");
  }
}

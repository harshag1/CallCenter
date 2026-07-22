import { canonicalJson, sha256Hex } from "./artifacts";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const BUNDLE_HASH_DOMAIN = "harshas-amazing-call-center/long-call-result-provenance/v1\n";
const ASR_INVOCATION_SET_DOMAIN = "harshas-amazing-call-center/long-call-asr-invocation-set/v1\n";
const BUDGET_SETTLEMENT_SET_DOMAIN = "harshas-amazing-call-center/long-call-budget-settlement-set/v1\n";

export const LONG_CALL_PROVENANCE_BOUND_RESULT_SCHEMA_VERSION = 3 as const;
export const LONG_CALL_PROVENANCE_BOUND_SCORER_VERSION = "hacc-long-call-scorer/v3" as const;

export type LongCallAsrInvocationProvenance = Readonly<{
  invocationId: string;
  receiptSha256: string;
}>;

export type LongCallBudgetSettlementProvenance = Readonly<{
  runId: string;
  reservationId: string;
  terminalOutcome: "completed" | "failed";
  estimatedMicroUsd: number;
  providerReportedMicroUsd: number | null;
  reconciledMicroUsd: number | null;
  conservativeMicroUsd: number;
  reconciliationEvidenceSha256: string | null;
}>;

export type LongCallRunProvenance = Readonly<{
  runId: string;
  pairId: string;
  provider: "openai" | "gemini" | "xai";
  condition: "raw-memory" | "host-managed-harness";
  terminalStatus: string;
  callerScheduleStatus: string | null;
  turnsSent: number;
  assistantOutputTurnsAvailable: number;
  assistantOutputTurnsTranscribed: number;
  asrInvocations: readonly LongCallAsrInvocationProvenance[];
  asrInvocationSetSha256: string;
  budgetReservationId: string;
  budgetTerminalOutcome: "completed" | "failed";
  budgetSettledEstimatedMicroUsd: number;
  budgetProviderReportedMicroUsd: number | null;
  budgetReconciledMicroUsd: number | null;
  budgetConservativeSettledMicroUsd: number;
  budgetReconciliationEvidenceSha256: string | null;
  terminalSummarySha256: string;
  runnerManifestSha256: string;
  runnerManifestInternalSha256: string;
  callerAudioBindingsSha256: string;
  assistantAudioBindingsSha256: string;
  pairAudioManifestArtifactSha256: string;
  audioDeliveryArtifactSha256: string;
  asrReceiptManifestSha256: string;
  asrReceiptManifestArtifactSha256: string;
  asrSemanticSha256: string;
  asrSemanticArtifactSha256: string;
  publicKernelTranscriptArtifactSha256: string;
  publicKernelTranscriptSha256: string;
  publicKernelTranscriptHeadSha256: string;
  finalKernelAttestationArtifactSha256: string;
  finalKernelAttestationSha256: string;
  kernelReplayVerificationSha256: string;
  kernelReplayValid: true;
  kernelReplayAuthenticity: "signed_attestation_verified";
  finalWorldArtifactSha256: string;
  modelAttemptEvidenceArtifactSha256: string;
}>;

export type LongCallResultProvenanceBundleInput = Readonly<{
  protocol: Readonly<{
    id: string;
    artifactSha256: string;
  }>;
  plan: Readonly<{
    experimentId: string;
    planSha256: string;
    artifactSha256: string;
  }>;
  source: Readonly<{
    commit: string;
    tree: string;
  }>;
  schedule: Readonly<{
    scheduleSha256: string;
    artifactSha256: string;
    scheduledRunIdsSha256: string;
  }>;
  fixtures: Readonly<{
    manifestSha256: string;
    toolchainSha256: string;
  }>;
  qualification: Readonly<{
    qualificationId: string;
    artifactSha256: string;
    artifactFileSha256: string;
    configurationMatrixSha256: string;
    credentialSetSha256: string;
    resultCount: number;
  }>;
  asr: Readonly<{
    calibrationArtifactSha256: string;
    calibrationArtifactFileSha256: string;
    calibrationResultSha256: string;
    calibrationPlanSha256: string;
    calibrationReceiptsManifestSha256: string;
    calibrationBatchFinalizationSha256: string;
    configSha256: string;
    outputVoiceCalibrationManifestSha256: string;
    outputVoiceCaptureAuthoritySha256: string;
    semanticScorerVersion: "audio-semantics-v2";
    postprocessBatchFinalizations: readonly Readonly<{
      batchId: string;
      finalizationSha256: string;
      inventorySha256: string;
      invocationCount: number;
      invocations: readonly LongCallAsrInvocationProvenance[];
      invocationSetSha256: string;
      artifactFileSha256: string;
    }>[];
  }>;
  budgetLedger: Readonly<{
    ledgerId: string;
    sequence: number;
    headEventSha256: string;
    headArtifactSha256: string;
    ledgerArtifactSha256: string;
    publicKeyFingerprintSha256: string;
    closed: true;
    state: "paused";
    activeReservationCount: 0;
    activeReservationsMicroUsd: 0;
    settledReservationCount: number;
    conservativeSettledMicroUsd: number;
    settlementSetSha256: string;
  }>;
  scorerVersion: typeof LONG_CALL_PROVENANCE_BOUND_SCORER_VERSION;
  runs: readonly LongCallRunProvenance[];
}>;

export type LongCallResultProvenanceBundle = LongCallResultProvenanceBundleInput & Readonly<{
  schemaVersion: 1;
  runEvidenceSetSha256: string;
  bundleSha256: string;
}>;

function requireSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function requireSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must be a safe non-empty identifier`);
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function canonicalInvocations(invocations: readonly LongCallAsrInvocationProvenance[]): readonly LongCallAsrInvocationProvenance[] {
  return [...invocations].sort((left, right) => (
    left.invocationId.localeCompare(right.invocationId) || left.receiptSha256.localeCompare(right.receiptSha256)
  ));
}

export function longCallAsrInvocationSetSha256(invocations: readonly LongCallAsrInvocationProvenance[]): string {
  return sha256Hex(`${ASR_INVOCATION_SET_DOMAIN}${canonicalJson(canonicalInvocations(invocations))}`);
}

export function longCallBudgetSettlementSetSha256(
  settlements: readonly LongCallBudgetSettlementProvenance[],
): string {
  return sha256Hex(`${BUDGET_SETTLEMENT_SET_DOMAIN}${canonicalJson(settlements)}`);
}

function validateRun(run: LongCallRunProvenance, index: number): void {
  requireSafeId(run.runId, `runs[${index}].runId`);
  requireSafeId(run.pairId, `runs[${index}].pairId`);
  requireSafeId(run.terminalStatus, `runs[${index}].terminalStatus`);
  if (run.callerScheduleStatus !== null) requireSafeId(run.callerScheduleStatus, `runs[${index}].callerScheduleStatus`);
  requireNonNegativeInteger(run.turnsSent, `runs[${index}].turnsSent`);
  requireNonNegativeInteger(run.assistantOutputTurnsAvailable, `runs[${index}].assistantOutputTurnsAvailable`);
  requireNonNegativeInteger(run.assistantOutputTurnsTranscribed, `runs[${index}].assistantOutputTurnsTranscribed`);
  requireSafeId(run.budgetReservationId, `runs[${index}].budgetReservationId`);
  requireNonNegativeInteger(run.budgetSettledEstimatedMicroUsd, `runs[${index}].budgetSettledEstimatedMicroUsd`);
  if (run.budgetProviderReportedMicroUsd !== null) {
    requireNonNegativeInteger(run.budgetProviderReportedMicroUsd, `runs[${index}].budgetProviderReportedMicroUsd`);
  }
  if (run.budgetReconciledMicroUsd !== null) {
    requireNonNegativeInteger(run.budgetReconciledMicroUsd, `runs[${index}].budgetReconciledMicroUsd`);
  }
  requireNonNegativeInteger(run.budgetConservativeSettledMicroUsd, `runs[${index}].budgetConservativeSettledMicroUsd`);
  if (run.budgetReconciliationEvidenceSha256 !== null) {
    requireSha256(run.budgetReconciliationEvidenceSha256, `runs[${index}].budgetReconciliationEvidenceSha256`);
  }
  if (run.budgetConservativeSettledMicroUsd !== Math.max(
    run.budgetSettledEstimatedMicroUsd,
    run.budgetProviderReportedMicroUsd ?? 0,
    run.budgetReconciledMicroUsd ?? 0,
  )) throw new Error(`runs[${index}] conservative settled cost is not derived from exact ledger costs`);
  if (run.assistantOutputTurnsTranscribed > run.assistantOutputTurnsAvailable) {
    throw new Error(`runs[${index}] transcribed outputs exceed available outputs`);
  }
  if (run.asrInvocations.length !== run.assistantOutputTurnsTranscribed) {
    throw new Error(`runs[${index}] exact ASR invocation count differs from transcribed outputs`);
  }
  for (const [invocationIndex, invocation] of run.asrInvocations.entries()) {
    requireSafeId(invocation.invocationId, `runs[${index}].asrInvocations[${invocationIndex}].invocationId`);
    requireSha256(invocation.receiptSha256, `runs[${index}].asrInvocations[${invocationIndex}].receiptSha256`);
  }
  if (new Set(run.asrInvocations.map((invocation) => invocation.invocationId)).size !== run.asrInvocations.length) {
    throw new Error(`runs[${index}] repeats an ASR invocation ID`);
  }
  if (new Set(run.asrInvocations.map((invocation) => invocation.receiptSha256)).size !== run.asrInvocations.length) {
    throw new Error(`runs[${index}] repeats an ASR receipt hash`);
  }
  if (run.asrInvocationSetSha256 !== longCallAsrInvocationSetSha256(run.asrInvocations)) {
    throw new Error(`runs[${index}] ASR invocation set hash mismatch`);
  }
  for (const [key, value] of Object.entries(run)) {
    if (key.endsWith("Sha256") && value !== null) requireSha256(value as string, `runs[${index}].${key}`);
  }
  if (run.kernelReplayValid !== true || run.kernelReplayAuthenticity !== "signed_attestation_verified") {
    throw new Error(`runs[${index}] lacks a valid signed kernel replay verification`);
  }
}

function validateBundleInput(
  input: LongCallResultProvenanceBundleInput,
  expectedRunIds: readonly string[],
): void {
  requireSafeId(input.protocol.id, "protocol.id");
  requireSafeId(input.plan.experimentId, "plan.experimentId");
  requireSafeId(input.qualification.qualificationId, "qualification.qualificationId");
  requireSafeId(input.budgetLedger.ledgerId, "budgetLedger.ledgerId");
  if (!GIT_OBJECT_ID.test(input.source.commit) || !GIT_OBJECT_ID.test(input.source.tree)) {
    throw new Error("source commit and tree must be full lowercase Git object IDs");
  }
  if (input.scorerVersion !== LONG_CALL_PROVENANCE_BOUND_SCORER_VERSION) {
    throw new Error("result provenance scorer version mismatch");
  }
  const hashes: readonly [string, string][] = [
    ["protocol.artifactSha256", input.protocol.artifactSha256],
    ["plan.planSha256", input.plan.planSha256],
    ["plan.artifactSha256", input.plan.artifactSha256],
    ["schedule.scheduleSha256", input.schedule.scheduleSha256],
    ["schedule.artifactSha256", input.schedule.artifactSha256],
    ["schedule.scheduledRunIdsSha256", input.schedule.scheduledRunIdsSha256],
    ["fixtures.manifestSha256", input.fixtures.manifestSha256],
    ["fixtures.toolchainSha256", input.fixtures.toolchainSha256],
    ["qualification.artifactSha256", input.qualification.artifactSha256],
    ["qualification.artifactFileSha256", input.qualification.artifactFileSha256],
    ["qualification.configurationMatrixSha256", input.qualification.configurationMatrixSha256],
    ["qualification.credentialSetSha256", input.qualification.credentialSetSha256],
    ["asr.calibrationArtifactSha256", input.asr.calibrationArtifactSha256],
    ["asr.calibrationArtifactFileSha256", input.asr.calibrationArtifactFileSha256],
    ["asr.calibrationResultSha256", input.asr.calibrationResultSha256],
    ["asr.calibrationPlanSha256", input.asr.calibrationPlanSha256],
    ["asr.calibrationReceiptsManifestSha256", input.asr.calibrationReceiptsManifestSha256],
    ["asr.calibrationBatchFinalizationSha256", input.asr.calibrationBatchFinalizationSha256],
    ["asr.configSha256", input.asr.configSha256],
    ["asr.outputVoiceCalibrationManifestSha256", input.asr.outputVoiceCalibrationManifestSha256],
    ["asr.outputVoiceCaptureAuthoritySha256", input.asr.outputVoiceCaptureAuthoritySha256],
    ["budgetLedger.headEventSha256", input.budgetLedger.headEventSha256],
    ["budgetLedger.headArtifactSha256", input.budgetLedger.headArtifactSha256],
    ["budgetLedger.ledgerArtifactSha256", input.budgetLedger.ledgerArtifactSha256],
    ["budgetLedger.publicKeyFingerprintSha256", input.budgetLedger.publicKeyFingerprintSha256],
    ["budgetLedger.settlementSetSha256", input.budgetLedger.settlementSetSha256],
  ];
  for (const [label, value] of hashes) requireSha256(value, label);
  requireNonNegativeInteger(input.qualification.resultCount, "qualification.resultCount");
  if (input.qualification.resultCount !== expectedRunIds.length) {
    throw new Error("qualification result count differs from the exact scheduled matrix");
  }
  if (!Number.isSafeInteger(input.budgetLedger.sequence) || input.budgetLedger.sequence < 1) {
    throw new Error("budget ledger sequence must be a positive safe integer");
  }
  if (
    input.budgetLedger.closed !== true
    || input.budgetLedger.state !== "paused"
    || input.budgetLedger.activeReservationCount !== 0
    || input.budgetLedger.activeReservationsMicroUsd !== 0
  ) throw new Error("budget ledger is not closed with zero active reservations");
  requireNonNegativeInteger(input.budgetLedger.settledReservationCount, "budgetLedger.settledReservationCount");
  requireNonNegativeInteger(input.budgetLedger.conservativeSettledMicroUsd, "budgetLedger.conservativeSettledMicroUsd");
  if (input.asr.postprocessBatchFinalizations.length === 0) {
    throw new Error("at least one ASR postprocess batch finalization is required");
  }
  if (input.asr.semanticScorerVersion !== "audio-semantics-v2") {
    throw new Error("ASR semantic scorer version mismatch");
  }
  let asrInvocationCount = 0;
  const finalizedInvocations: LongCallAsrInvocationProvenance[] = [];
  const batchIds = new Set<string>();
  for (const [index, batch] of input.asr.postprocessBatchFinalizations.entries()) {
    requireSafeId(batch.batchId, `asr.postprocessBatchFinalizations[${index}].batchId`);
    if (batchIds.has(batch.batchId)) throw new Error("ASR postprocess batch finalizations repeat a batch ID");
    batchIds.add(batch.batchId);
    requireSha256(batch.finalizationSha256, `asr.postprocessBatchFinalizations[${index}].finalizationSha256`);
    requireSha256(batch.inventorySha256, `asr.postprocessBatchFinalizations[${index}].inventorySha256`);
    requireSha256(batch.invocationSetSha256, `asr.postprocessBatchFinalizations[${index}].invocationSetSha256`);
    requireSha256(batch.artifactFileSha256, `asr.postprocessBatchFinalizations[${index}].artifactFileSha256`);
    requireNonNegativeInteger(batch.invocationCount, `asr.postprocessBatchFinalizations[${index}].invocationCount`);
    if (batch.invocationCount !== batch.invocations.length) {
      throw new Error(`asr.postprocessBatchFinalizations[${index}] invocation inventory length mismatch`);
    }
    if (batch.invocationSetSha256 !== longCallAsrInvocationSetSha256(batch.invocations)) {
      throw new Error(`asr.postprocessBatchFinalizations[${index}] invocation set hash mismatch`);
    }
    for (const [invocationIndex, invocation] of batch.invocations.entries()) {
      requireSafeId(invocation.invocationId, `asr.postprocessBatchFinalizations[${index}].invocations[${invocationIndex}].invocationId`);
      requireSha256(invocation.receiptSha256, `asr.postprocessBatchFinalizations[${index}].invocations[${invocationIndex}].receiptSha256`);
      finalizedInvocations.push(invocation);
    }
    asrInvocationCount += batch.invocationCount;
  }
  if (input.runs.length !== expectedRunIds.length) {
    throw new Error("provenance bundle does not contain every scheduled run exactly once");
  }
  input.runs.forEach(validateRun);
  const actualRunIds = input.runs.map((run) => run.runId);
  if (canonicalJson(actualRunIds) !== canonicalJson(expectedRunIds)) {
    throw new Error("provenance run order or membership differs from the frozen schedule");
  }
  if (new Set(actualRunIds).size !== actualRunIds.length) throw new Error("provenance bundle repeats a run ID");
  const transcribedOutputs = input.runs.reduce((total, run) => total + run.assistantOutputTurnsTranscribed, 0);
  if (asrInvocationCount !== transcribedOutputs) {
    throw new Error("ASR batch invocation inventory differs from per-run transcribed-output evidence");
  }
  const runInvocations = input.runs.flatMap((run) => run.asrInvocations);
  if (new Set(finalizedInvocations.map((invocation) => invocation.invocationId)).size !== finalizedInvocations.length) {
    throw new Error("ASR batch finalizations repeat an invocation ID");
  }
  if (new Set(finalizedInvocations.map((invocation) => invocation.receiptSha256)).size !== finalizedInvocations.length) {
    throw new Error("ASR batch finalizations repeat a receipt hash");
  }
  if (canonicalJson(canonicalInvocations(finalizedInvocations)) !== canonicalJson(canonicalInvocations(runInvocations))) {
    throw new Error("ASR batch invocation receipts differ from the exact per-run receipt set");
  }
  const settlements = input.runs.map((run) => Object.freeze({
    runId: run.runId,
    reservationId: run.budgetReservationId,
    terminalOutcome: run.budgetTerminalOutcome,
    estimatedMicroUsd: run.budgetSettledEstimatedMicroUsd,
    providerReportedMicroUsd: run.budgetProviderReportedMicroUsd,
    reconciledMicroUsd: run.budgetReconciledMicroUsd,
    conservativeMicroUsd: run.budgetConservativeSettledMicroUsd,
    reconciliationEvidenceSha256: run.budgetReconciliationEvidenceSha256,
  }));
  if (new Set(settlements.map((settlement) => settlement.reservationId)).size !== settlements.length) {
    throw new Error("budget settlement set repeats a reservation ID");
  }
  if (input.budgetLedger.settledReservationCount !== settlements.length) {
    throw new Error("budget settled reservation count differs from scheduled runs");
  }
  const settledMicroUsd = settlements.reduce((total, settlement) => total + settlement.conservativeMicroUsd, 0);
  if (!Number.isSafeInteger(settledMicroUsd) || settledMicroUsd !== input.budgetLedger.conservativeSettledMicroUsd) {
    throw new Error("budget conservative settled total differs from per-run settlements");
  }
  const expectedSettlementSetSha256 = longCallBudgetSettlementSetSha256(settlements);
  if (input.budgetLedger.settlementSetSha256 !== expectedSettlementSetSha256) {
    throw new Error("budget settlement set hash mismatch");
  }
  const expectedRunIdsSha256 = sha256Hex(canonicalJson(expectedRunIds));
  if (input.schedule.scheduledRunIdsSha256 !== expectedRunIdsSha256) {
    throw new Error("scheduled run-ID set hash mismatch");
  }
  canonicalJson(input);
}

export function createLongCallResultProvenanceBundle(
  input: LongCallResultProvenanceBundleInput,
  expectedRunIds: readonly string[],
): LongCallResultProvenanceBundle {
  validateBundleInput(input, expectedRunIds);
  const runEvidenceSetSha256 = sha256Hex(canonicalJson(input.runs));
  const body = Object.freeze({ schemaVersion: 1 as const, ...input, runEvidenceSetSha256 });
  return Object.freeze({
    ...body,
    bundleSha256: sha256Hex(`${BUNDLE_HASH_DOMAIN}${canonicalJson(body)}`),
  });
}

export function assertLongCallResultProvenanceBundle(
  bundle: LongCallResultProvenanceBundle,
  expectedRunIds: readonly string[],
): void {
  const { schemaVersion, runEvidenceSetSha256, bundleSha256, ...input } = bundle;
  if (schemaVersion !== 1) throw new Error("unsupported long-call result provenance schema");
  validateBundleInput(input, expectedRunIds);
  const expectedRunEvidenceSetSha256 = sha256Hex(canonicalJson(input.runs));
  if (runEvidenceSetSha256 !== expectedRunEvidenceSetSha256) throw new Error("run evidence set hash mismatch");
  const body = { schemaVersion, ...input, runEvidenceSetSha256 };
  if (bundleSha256 !== sha256Hex(`${BUNDLE_HASH_DOMAIN}${canonicalJson(body)}`)) {
    throw new Error("long-call result provenance bundle hash mismatch");
  }
}

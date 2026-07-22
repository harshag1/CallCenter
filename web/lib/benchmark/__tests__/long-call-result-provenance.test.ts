import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LONG_CALL_PROTOCOL_ID,
  classifyLongCallFailure,
  createLongCallCells,
  isLongCallMissionCompletionPass,
  isStrictLongCallPass,
  longCallScheduleArtifact,
  provenanceBoundLongCallResultSha256,
  scoreProvenanceBoundLongCallExperiment,
  type LongCallSummary,
} from "../long-call-live-experiment";
import {
  LONG_CALL_PROVENANCE_BOUND_SCORER_VERSION,
  assertLongCallResultProvenanceBundle,
  createLongCallResultProvenanceBundle,
  longCallAsrInvocationSetSha256,
  longCallBudgetSettlementSetSha256,
  type LongCallResultProvenanceBundleInput,
} from "../long-call-result-provenance";

const H = (value: string): string => sha256Hex(`test:${value}`);
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;
type MutableBundleInput = DeepMutable<LongCallResultProvenanceBundleInput>;
const mutableInput = (input: LongCallResultProvenanceBundleInput): MutableBundleInput => (
  structuredClone(input) as MutableBundleInput
);

function summaries(): readonly LongCallSummary[] {
  return createLongCallCells().map((cell) => {
    const core = Object.freeze({
      transportTerminal: true,
      modelIntegrityPass: true,
      worldOutcomePass: true,
      systemIntegrityPass: true,
      audioSemanticPass: true,
      turnsPlanned: 20,
      turnsSent: 20,
      outputAudioTurns: 20,
    });
    return Object.freeze({
      schemaVersion: 1 as const,
      protocolId: LONG_CALL_PROTOCOL_ID,
      runId: cell.runId,
      pairId: cell.pairId,
      provider: cell.provider,
      model: cell.model,
      family: cell.family,
      ttsVoice: cell.ttsVoice,
      condition: cell.condition,
      status: "completed",
      callerScheduleStatus: "complete",
      ...core,
      modelAttemptEvidenceSha256: H(`${cell.runId}:attempts`),
      modelAttemptCount: 1,
      modelAttemptViolationCount: 0,
      modelPreKernelRejectedAttemptCount: 0,
      modelPreKernelContainedAttemptCount: 0,
      asrReceiptsSha256: H(`${cell.runId}:asr-manifest`),
      asrExpectedOutputTurns: 20,
      asrAvailableOutputTurns: 20,
      asrTranscribedOutputTurns: 20,
      asrUnresolvedCriticalTurns: 0,
      audioSemanticViolationCounts: Object.freeze({
        verificationPinDisclosed: 0,
        privateValueDisclosed: 0,
        retiredTargetUsed: 0,
        prematureTerminalClaim: 0,
      }),
      missionCompletionPass: isLongCallMissionCompletionPass(core),
      strictPass: isStrictLongCallPass(core),
      estimatedCostUsd: 0.01,
      artifactManifestSha256: H(`${cell.runId}:runner-manifest`),
      failureClass: classifyLongCallFailure(core),
    });
  });
}

function provenanceInput(values: readonly LongCallSummary[]): LongCallResultProvenanceBundleInput {
  const runIds = values.map((summary) => summary.runId);
  const asrInvocationsByRun = new Map(values.map((summary) => [summary.runId, Array.from(
    { length: summary.asrTranscribedOutputTurns },
    (_, index) => Object.freeze({
      invocationId: `${summary.runId}-asr-${String(index + 1).padStart(3, "0")}`,
      receiptSha256: H(`${summary.runId}:receipt:${index + 1}`),
    }),
  )]));
  const settlements = values.map((summary) => Object.freeze({
    runId: summary.runId,
    reservationId: `${summary.runId}-aggregate-reservation`,
    terminalOutcome: "completed" as const,
    estimatedMicroUsd: 10_000,
    providerReportedMicroUsd: null,
    reconciledMicroUsd: null,
    conservativeMicroUsd: 10_000,
    reconciliationEvidenceSha256: null,
  }));
  return {
    protocol: { id: LONG_CALL_PROTOCOL_ID, artifactSha256: H("protocol") },
    plan: { experimentId: "next-protocol-test", planSha256: H("plan"), artifactSha256: H("plan-file") },
    source: { commit: "1".repeat(40), tree: "2".repeat(40) },
    schedule: {
      scheduleSha256: longCallScheduleArtifact().scheduleSha256,
      artifactSha256: H("schedule-artifact"),
      scheduledRunIdsSha256: sha256Hex(canonicalJson(runIds)),
    },
    fixtures: { manifestSha256: H("fixture-manifest"), toolchainSha256: H("fixture-toolchain") },
    qualification: {
      qualificationId: "qualification-next",
      artifactSha256: H("qualification"),
      artifactFileSha256: H("qualification-file"),
      configurationMatrixSha256: H("qualification-matrix"),
      credentialSetSha256: H("credential-set"),
      resultCount: values.length,
    },
    asr: {
      calibrationArtifactSha256: H("calibration-artifact"),
      calibrationArtifactFileSha256: H("calibration-file"),
      calibrationResultSha256: H("calibration-result"),
      calibrationPlanSha256: H("calibration-plan"),
      calibrationReceiptsManifestSha256: H("calibration-receipts"),
      calibrationBatchFinalizationSha256: H("calibration-batch"),
      configSha256: H("asr-config"),
      outputVoiceCalibrationManifestSha256: H("output-voice-calibration"),
      outputVoiceCaptureAuthoritySha256: H("output-voice-capture-authority"),
      semanticScorerVersion: "audio-semantics-v2",
      postprocessBatchFinalizations: [{
        batchId: "postprocess-batch",
        finalizationSha256: H("postprocess-finalization"),
        inventorySha256: H("postprocess-inventory"),
        invocationCount: [...asrInvocationsByRun.values()].flat().length,
        invocations: [...asrInvocationsByRun.values()].flat(),
        invocationSetSha256: longCallAsrInvocationSetSha256([...asrInvocationsByRun.values()].flat()),
        artifactFileSha256: H("postprocess-file"),
      }],
    },
    budgetLedger: {
      ledgerId: "next-ledger",
      sequence: 91,
      headEventSha256: H("ledger-head"),
      headArtifactSha256: H("ledger-head-file"),
      ledgerArtifactSha256: H("ledger-log-file"),
      publicKeyFingerprintSha256: H("ledger-key"),
      closed: true,
      state: "paused",
      activeReservationCount: 0,
      activeReservationsMicroUsd: 0,
      settledReservationCount: settlements.length,
      conservativeSettledMicroUsd: settlements.length * 10_000,
      settlementSetSha256: longCallBudgetSettlementSetSha256(settlements),
    },
    scorerVersion: LONG_CALL_PROVENANCE_BOUND_SCORER_VERSION,
    runs: values.map((summary) => {
      const asrInvocations = asrInvocationsByRun.get(summary.runId)!;
      return ({
      runId: summary.runId,
      pairId: summary.pairId,
      provider: summary.provider,
      condition: summary.condition,
      terminalStatus: summary.status,
      callerScheduleStatus: summary.callerScheduleStatus,
      turnsSent: summary.turnsSent,
      assistantOutputTurnsAvailable: summary.asrAvailableOutputTurns,
      assistantOutputTurnsTranscribed: summary.asrTranscribedOutputTurns,
      asrInvocations,
      asrInvocationSetSha256: longCallAsrInvocationSetSha256(asrInvocations),
      budgetReservationId: `${summary.runId}-aggregate-reservation`,
      budgetTerminalOutcome: "completed",
      budgetSettledEstimatedMicroUsd: 10_000,
      budgetProviderReportedMicroUsd: null,
      budgetReconciledMicroUsd: null,
      budgetConservativeSettledMicroUsd: 10_000,
      budgetReconciliationEvidenceSha256: null,
      terminalSummarySha256: sha256Hex(`${canonicalJson(summary)}\n`),
      runnerManifestSha256: summary.artifactManifestSha256,
      runnerManifestInternalSha256: H(`${summary.runId}:runner-internal`),
      callerAudioBindingsSha256: H(`${summary.runId}:caller-audio`),
      assistantAudioBindingsSha256: H(`${summary.runId}:output-audio`),
      pairAudioManifestArtifactSha256: H(`${summary.runId}:pair-audio`),
      audioDeliveryArtifactSha256: H(`${summary.runId}:delivery`),
      asrReceiptManifestSha256: summary.asrReceiptsSha256!,
      asrReceiptManifestArtifactSha256: H(`${summary.runId}:asr-file`),
      asrSemanticSha256: H(`${summary.runId}:semantic`),
      asrSemanticArtifactSha256: H(`${summary.runId}:semantic-file`),
      publicKernelTranscriptArtifactSha256: H(`${summary.runId}:transcript-file`),
      publicKernelTranscriptSha256: H(`${summary.runId}:transcript`),
      publicKernelTranscriptHeadSha256: H(`${summary.runId}:transcript-head`),
      finalKernelAttestationArtifactSha256: H(`${summary.runId}:attestation-file`),
      finalKernelAttestationSha256: H(`${summary.runId}:attestation`),
      kernelReplayVerificationSha256: H(`${summary.runId}:replay`),
      kernelReplayValid: true,
      kernelReplayAuthenticity: "signed_attestation_verified",
      finalWorldArtifactSha256: H(`${summary.runId}:world`),
      modelAttemptEvidenceArtifactSha256: H(`${summary.runId}:attempt-file`),
    }); }),
  };
}

describe("next-version provenance-bound long-call result", () => {
  it("hashes the complete evidence root with the aggregate body", () => {
    const values = summaries();
    const runIds = values.map((summary) => summary.runId);
    const bundle = createLongCallResultProvenanceBundle(provenanceInput(values), runIds);
    const result = scoreProvenanceBoundLongCallExperiment(values, bundle);
    const { resultSha256, ...body } = result;
    expect(result.schemaVersion).toBe(3);
    expect(result.provenanceBundle.bundleSha256).toBe(bundle.bundleSha256);
    expect(provenanceBoundLongCallResultSha256(body)).toBe(resultSha256);
  });

  it.each([
    ["protocol artifact", (input: MutableBundleInput) => { input.protocol.artifactSha256 = H("protocol-substitute"); }],
    ["plan artifact", (input: MutableBundleInput) => { input.plan.artifactSha256 = H("plan-substitute"); }],
    ["source tree", (input: MutableBundleInput) => { input.source.tree = "3".repeat(40); }],
    ["schedule artifact", (input: MutableBundleInput) => { input.schedule.artifactSha256 = H("schedule-substitute"); }],
    ["fixture manifest", (input: MutableBundleInput) => { input.fixtures.manifestSha256 = H("fixture-substitute"); }],
    ["qualification artifact", (input: MutableBundleInput) => { input.qualification.artifactSha256 = H("qualification-substitute"); }],
    ["ASR calibration", (input: MutableBundleInput) => { input.asr.calibrationArtifactSha256 = H("calibration-substitute"); }],
    ["ASR finalization", (input: MutableBundleInput) => { input.asr.postprocessBatchFinalizations[0].finalizationSha256 = H("finalization-substitute"); }],
    ["budget head", (input: MutableBundleInput) => { input.budgetLedger.headEventSha256 = H("budget-substitute"); }],
    ["caller audio binding", (input: MutableBundleInput) => { input.runs[0].callerAudioBindingsSha256 = H("caller-substitute"); }],
    ["output audio binding", (input: MutableBundleInput) => { input.runs[0].assistantAudioBindingsSha256 = H("output-substitute"); }],
    ["ASR semantic artifact", (input: MutableBundleInput) => { input.runs[0].asrSemanticArtifactSha256 = H("semantic-substitute"); }],
    ["public transcript", (input: MutableBundleInput) => { input.runs[0].publicKernelTranscriptArtifactSha256 = H("transcript-substitute"); }],
    ["final attestation", (input: MutableBundleInput) => { input.runs[0].finalKernelAttestationArtifactSha256 = H("attestation-substitute"); }],
    ["replay verification", (input: MutableBundleInput) => { input.runs[0].kernelReplayVerificationSha256 = H("replay-substitute"); }],
  ])("changes the final digest after a valid %s substitution", (_label, mutate) => {
    const values = summaries();
    const runIds = values.map((summary) => summary.runId);
    const baseline = scoreProvenanceBoundLongCallExperiment(
      values,
      createLongCallResultProvenanceBundle(provenanceInput(values), runIds),
    );
    const substituted = mutableInput(provenanceInput(values));
    mutate(substituted);
    const changed = scoreProvenanceBoundLongCallExperiment(
      values,
      createLongCallResultProvenanceBundle(substituted, runIds),
    );
    expect(changed.resultSha256).not.toBe(baseline.resultSha256);
  });

  it("rejects missing, reordered, summary-substituted, or unsigned-replay run evidence", () => {
    const values = summaries();
    const runIds = values.map((summary) => summary.runId);
    const missing = mutableInput(provenanceInput(values));
    missing.runs.pop();
    expect(() => createLongCallResultProvenanceBundle(missing, runIds)).toThrow("every scheduled run");

    const reordered = mutableInput(provenanceInput(values));
    [reordered.runs[0], reordered.runs[1]] = [reordered.runs[1], reordered.runs[0]];
    expect(() => createLongCallResultProvenanceBundle(reordered, runIds)).toThrow("order or membership");

    const summarySubstitution = mutableInput(provenanceInput(values));
    summarySubstitution.runs[0].terminalSummarySha256 = H("different-summary");
    const summaryBundle = createLongCallResultProvenanceBundle(summarySubstitution, runIds);
    expect(() => scoreProvenanceBoundLongCallExperiment(values, summaryBundle)).toThrow("differs from terminal summary");

    const unsigned = mutableInput(provenanceInput(values));
    (unsigned.runs[0] as { kernelReplayValid: boolean }).kernelReplayValid = false;
    expect(() => createLongCallResultProvenanceBundle(unsigned as LongCallResultProvenanceBundleInput, runIds)).toThrow("valid signed kernel replay");
  });

  it("rejects count-preserving ASR receipt substitution across batch and run inventories", () => {
    const values = summaries();
    const runIds = values.map((summary) => summary.runId);
    const substituted = mutableInput(provenanceInput(values));
    substituted.asr.postprocessBatchFinalizations[0].invocations[0] = {
      ...substituted.asr.postprocessBatchFinalizations[0].invocations[0],
      receiptSha256: H("substituted-batch-receipt"),
    };
    substituted.asr.postprocessBatchFinalizations[0].invocationSetSha256 = longCallAsrInvocationSetSha256(
      substituted.asr.postprocessBatchFinalizations[0].invocations,
    );
    expect(() => createLongCallResultProvenanceBundle(substituted, runIds)).toThrow("exact per-run receipt set");
  });

  it("binds a coordinated exact ASR receipt substitution into the final result digest", () => {
    const values = summaries();
    const runIds = values.map((summary) => summary.runId);
    const baseline = scoreProvenanceBoundLongCallExperiment(
      values,
      createLongCallResultProvenanceBundle(provenanceInput(values), runIds),
    );
    const substituted = mutableInput(provenanceInput(values));
    const replacement = H("coordinated-receipt-substitution");
    const invocationId = substituted.runs[0].asrInvocations[0].invocationId;
    substituted.runs[0].asrInvocations[0] = { invocationId, receiptSha256: replacement };
    substituted.runs[0].asrInvocationSetSha256 = longCallAsrInvocationSetSha256(substituted.runs[0].asrInvocations);
    const batchIndex = substituted.asr.postprocessBatchFinalizations[0].invocations.findIndex((entry) => (
      entry.invocationId === invocationId
    ));
    substituted.asr.postprocessBatchFinalizations[0].invocations[batchIndex] = { invocationId, receiptSha256: replacement };
    substituted.asr.postprocessBatchFinalizations[0].invocationSetSha256 = longCallAsrInvocationSetSha256(
      substituted.asr.postprocessBatchFinalizations[0].invocations,
    );
    const changed = scoreProvenanceBoundLongCallExperiment(
      values,
      createLongCallResultProvenanceBundle(substituted, runIds),
    );
    expect(changed.resultSha256).not.toBe(baseline.resultSha256);
  });

  it("requires a paused, zero-active, fully settled ledger and summary-matching per-run costs", () => {
    const values = summaries();
    const runIds = values.map((summary) => summary.runId);
    const active = mutableInput(provenanceInput(values));
    (active.budgetLedger.activeReservationCount as number) = 1;
    expect(() => createLongCallResultProvenanceBundle(active, runIds)).toThrow("zero active reservations");

    const unsettled = mutableInput(provenanceInput(values));
    unsettled.budgetLedger.settledReservationCount -= 1;
    expect(() => createLongCallResultProvenanceBundle(unsettled, runIds)).toThrow("settled reservation count");

    const costDrift = mutableInput(provenanceInput(values));
    costDrift.runs[0].budgetSettledEstimatedMicroUsd += 1;
    costDrift.runs[0].budgetConservativeSettledMicroUsd += 1;
    costDrift.budgetLedger.conservativeSettledMicroUsd += 1;
    costDrift.budgetLedger.settlementSetSha256 = longCallBudgetSettlementSetSha256(costDrift.runs.map((run) => ({
      runId: run.runId,
      reservationId: run.budgetReservationId,
      terminalOutcome: run.budgetTerminalOutcome,
      estimatedMicroUsd: run.budgetSettledEstimatedMicroUsd,
      providerReportedMicroUsd: run.budgetProviderReportedMicroUsd,
      reconciledMicroUsd: run.budgetReconciledMicroUsd,
      conservativeMicroUsd: run.budgetConservativeSettledMicroUsd,
      reconciliationEvidenceSha256: run.budgetReconciliationEvidenceSha256,
    })));
    const bundle = createLongCallResultProvenanceBundle(costDrift, runIds);
    expect(() => scoreProvenanceBoundLongCallExperiment(values, bundle)).toThrow("differs from terminal summary");
  });

  it("detects in-place bundle mutation without recomputing its evidence root", () => {
    const values = summaries();
    const runIds = values.map((summary) => summary.runId);
    const bundle = createLongCallResultProvenanceBundle(provenanceInput(values), runIds);
    const mutated = structuredClone(bundle) as DeepMutable<typeof bundle>;
    mutated.runs[0].assistantAudioBindingsSha256 = H("unhashed-mutation");
    expect(() => assertLongCallResultProvenanceBundle(mutated, runIds)).toThrow("run evidence set hash mismatch");
  });
});

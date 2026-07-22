import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function runnerSource(): Promise<string> {
  return readFile(resolve(process.cwd(), "scripts/long-call-live-benchmark.ts"), "utf8");
}

describe("HACC-LC3 live runner release contract", () => {
  it("binds paid execution to the signed append-only aggregate ledger lifecycle", async () => {
    const source = await runnerSource();
    for (const symbol of [
      "initializeFilesystemBudgetLedger",
      "reserveFilesystemBudget",
      "markBudgetConnectionIntent",
      "markBudgetSessionOpened",
      "recordBudgetTerminal",
      "settleFilesystemBudget",
    ]) {
      expect(source).toContain(symbol);
    }
    expect(source).toContain("upper_bound_micro_usd: 5_000_000");
    expect(source).toContain("operationalCeilingUsd: LONG_CALL_MAXIMUM_AGGREGATE_USD");
  });

  it("freezes the long-call bounds and blocks reporting before ASR scoring", async () => {
    const source = await runnerSource();
    expect(source).toContain("leaseTtlSeconds: 12 * 60");
    expect(source).toContain("maxSessionMs: 9 * 60_000");
    expect(source).toContain("maxOutputAudioBytes: 64 * 1024 * 1024");
    expect(source).toContain("ASR semantic scoring is incomplete");
    expect(source).toContain("summary.asrReceiptsSha256 ??");
    expect(source).toContain("evaluateLongCallModelIntegrity(result.world, publicTranscript, result.artifacts.events)");
    expect(source).toContain('createArtifactDescriptor(evidencePath, evidenceJson, "application/json")');
    expect(source).toContain("model_attempt_evidence_sha256: modelAttemptEvidence.evidenceSha256");
    expect(source).toContain("modelAttemptEvidenceSha256: modelAttemptEvidence.evidenceSha256");
    expect(source).toContain("provider-attempt evidence is incomplete");
    expect(source).toContain("assertHostManagedGrantExposure(publicTranscript, condition)");
    expect(source).toContain("isLongCallMissionCompletionPass(summary)");
    expect(source).not.toContain("autoAdvanceLinearFlow:");
  });

  it("retains completed trial measurements when post-trial validation fails closed", async () => {
    const source = await runnerSource();
    const persistence = source.indexOf("await persistArtifacts(partial, result, modelAttemptEvidence)");
    const durableWrite = source.indexOf('resolve(partial, "retained-trial-evidence.json")');
    const retention = source.indexOf("retainedEvidence = parseRetainedTrialEvidence");
    const validation = source.indexOf("const evaluation = evaluateScenarioWorld");
    expect(persistence).toBeGreaterThan(-1);
    expect(durableWrite).toBeGreaterThan(persistence);
    expect(retention).toBeGreaterThan(durableWrite);
    expect(validation).toBeGreaterThan(retention);
    expect(source.indexOf("retainedEvidence = measuredEvidence")).toBeLessThan(durableWrite);
    expect(source).toContain('await readFile(retainedEvidencePath, "utf8")');
    expect(source).toContain("turnsSent: retainedEvidence?.turnsSent ?? 0");
    expect(source).toContain("outputAudioTurns: retainedEvidence?.outputAudioTurns ?? 0");
    expect(source).toContain("estimatedCostUsd: retainedEvidence?.estimatedCostUsd ?? null");
    expect(source).toContain("modelAttemptEvidenceSha256: retainedModelAttemptEvidence?.evidenceSha256 ?? null");
    expect(source).toContain("artifactManifestSha256: retainedAugmentedManifestSha256");
    expect(source).toContain('status: "runner_exception"');
    expect(source).toContain("transportTerminal: false");
    expect(source).toContain("modelIntegrityPass: false");
    expect(source).toContain("worldOutcomePass: false");
    expect(source).toContain("systemIntegrityPass: false");
  });

  it("requires a fresh, plan-bound three-provider qualification before paid execution", async () => {
    const source = await runnerSource();
    expect(source).toContain('if (command === "qualify") return qualify(root)');
    expect(source).toContain("assertRecentPassingProviderQualification({");
    expect(source.indexOf("assertRecentPassingProviderQualification({")).toBeLessThan(
      source.indexOf("await mkdir(resolve(root, \"runs\")"),
    );
    expect(source).toContain("loadProductionRealtimeCredentialCandidates");
  });

  it("does not commit a developer-machine credential path", async () => {
    const source = await runnerSource();
    expect(source).not.toContain("/Users/");
    expect(source).not.toContain("staging-runtime-provider.env");
    expect(source).toContain("--env-file must be an absolute normalized path");
  });

  it("is exposed as the package long-call command", async () => {
    const packageJson = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["benchmark:long-call"]).toBe("tsx scripts/long-call-live-benchmark.ts");
  });
});

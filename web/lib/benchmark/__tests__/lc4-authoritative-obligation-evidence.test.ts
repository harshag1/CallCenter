import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  LC4_AUTHORITY_EVIDENCE_VERSION,
  compileLc4AuthoritativeObligationManifest,
  compileLc4DevelopmentAuthoritativeObligationManifest,
  createLc4AuthorityEvents,
  createLc4AuthoritativeObligationEpisodeArtifact,
  createLc4AuthoritativeObligationEvidenceReplayer,
  createLc4AuthorityManifestRegistry,
  replayLc4AuthoritativeObligationEvidence,
  summarizeLc4AuthoritativeObligationEvidence,
  type Lc4AuthoritativeObligationManifest,
  type Lc4AuthorityEventType,
  type Lc4AuthorityOutcome,
} from "../lc4-authoritative-obligation-evidence";
import {
  LC4_DEVELOPMENT_TEST_SEED_BYTES,
  createLc4GenericHeldoutGenerator,
  type Lc4GenericScenarioPayload,
} from "../lc4-heldout-generator";
import {
  benchmarkKernelAttestationPublicKeyFingerprint,
  createBenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationTrust,
} from "../kernel-attestation";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";

function fixture() {
  const payload = createLc4GenericHeldoutGenerator({
    executionMode: "development-test-only",
    generatorSourceSha256: sha256Hex("lc4-authority-test-generator"),
    corpusSchemaSha256: sha256Hex("lc4-authority-test-schema"),
  }).generate(new Uint8Array(LC4_DEVELOPMENT_TEST_SEED_BYTES))[0]!.payload as Lc4GenericScenarioPayload;
  const manifest = compileLc4AuthoritativeObligationManifest(payload);
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signer = createBenchmarkKernelAttestationSigner({
    keyId: "lc4-authority-test-key",
    privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem,
  });
  const trust: BenchmarkKernelAttestationTrust = Object.freeze({
    keyId: signer.keyId,
    publicKeySha256: benchmarkKernelAttestationPublicKeyFingerprint(publicKeyPem),
    publicKeyPem,
  });
  return { payload, manifest, signer, trust };
}

function passingEntries(manifest: Lc4AuthoritativeObligationManifest) {
  const entries: Array<{
    event_type: Lc4AuthorityEventType;
    subject_id: string;
    opportunity_index: number;
    outcome: Lc4AuthorityOutcome;
    value_sha256: string | null;
    source_receipt_sha256: string;
  }> = [];
  for (const obligation of manifest.obligations) {
    if (obligation.kind === "reconciliation_after_ambiguous_commit"
      || obligation.kind === "invalidated_confirmation_never_used") continue;
    const eventType: Lc4AuthorityEventType = obligation.kind === "tool_outcome_exact" ? "tool_receipt"
      : obligation.kind === "worker_disposition_exact" ? "worker_disposition"
        : obligation.kind === "latest_fact_revision" ? "fact_revision"
          : "terminal_world";
    entries.push({
      event_type: eventType,
      subject_id: obligation.subject_id,
      opportunity_index: obligation.not_before_opportunity ?? 60,
      outcome: obligation.expected_outcome,
      value_sha256: obligation.expected_value_sha256,
      source_receipt_sha256: sha256Hex(`source:${obligation.obligation_id}`),
    });
  }
  entries.sort((left, right) => left.opportunity_index - right.opportunity_index
    || left.subject_id.localeCompare(right.subject_id));
  return entries;
}

function authorityRoots(events: ReturnType<typeof createLc4AuthorityEvents>, registrySha256 = sha256Hex("registry"), assignmentSha256 = sha256Hex("assignment")) {
  return Object.freeze({
    retained_ledger_head_sha256: sha256Hex("ledger-head"),
    ledger_replay_sha256: sha256Hex("ledger-replay"),
    normalized_event_set_sha256: sha256Hex(canonicalJson(events)),
    source_checkpoint_evidence_sha256: sha256Hex("source-checkpoint"),
    manifest_registry_sha256: registrySha256,
    episode_subject_assignment_sha256: assignmentSha256,
  });
}

describe("LC4 authoritative obligation evidence", () => {
  it("precompiles the public DEV conditional oracle as exactly 42 obligations", () => {
    const manifest = compileLc4DevelopmentAuthoritativeObligationManifest(
      createLc4PublicDevelopmentCorpus(),
      sha256Hex("signed-five-row-caller-branch-matrix"),
    );
    expect(manifest.obligation_count).toBe(42);
    expect(manifest.obligations.filter((entry) => entry.kind === "tool_outcome_exact")).toHaveLength(14);
    expect(manifest.obligations.filter((entry) => entry.kind === "conditional_mutation_outcome")).toHaveLength(1);
    expect(manifest.obligations.filter((entry) => entry.kind === "forbidden_effect_never_committed")).toHaveLength(9);
    expect(manifest.obligations.filter((entry) => entry.kind === "worker_disposition_exact")).toHaveLength(4);
    expect(manifest.obligations.filter((entry) => entry.kind === "latest_fact_revision")).toHaveLength(10);
    expect(manifest.obligations.filter((entry) => entry.kind === "conditional_reconciliation_matrix")).toHaveLength(1);
    expect(manifest.obligations.filter((entry) => entry.kind === "invalidated_confirmation_never_used")).toHaveLength(2);
    expect(manifest.obligations.filter((entry) => entry.kind === "terminal_world_complete")).toHaveLength(1);
  });
  it("mechanically freezes the complete tool, worker, revision, reconciliation, confirmation, and terminal oracle", () => {
    const { manifest, payload } = fixture();
    expect(manifest.compiler_version).toBe(LC4_AUTHORITY_EVIDENCE_VERSION);
    expect(manifest.template_id).toBe(payload.template_id);
    expect(manifest.obligation_count).toBe(42);
    expect(manifest.obligations.filter((entry) => entry.kind === "tool_outcome_exact")).toHaveLength(24);
    expect(manifest.obligations.filter((entry) => entry.kind === "worker_disposition_exact")).toHaveLength(4);
    expect(manifest.obligations.filter((entry) => entry.kind === "latest_fact_revision")).toHaveLength(10);
    expect(manifest.obligations.map((entry) => entry.obligation_id)).toEqual(
      [...manifest.obligations.map((entry) => entry.obligation_id)].sort()
    );
    expect(compileLc4AuthoritativeObligationManifest(payload)).toEqual(manifest);
  }, 30_000);

  it("replays a complete signed arm-neutral episode as pass and detects ordinary obligation failure", () => {
    const { manifest, signer, trust } = fixture();
    const entries = passingEntries(manifest);
    const artifact = createLc4AuthoritativeObligationEpisodeArtifact({
      manifest,
      episodeSubjectSha256: sha256Hex("opaque-episode-subject"),
      events: createLc4AuthorityEvents(entries),
      signer,
      authorityRoots: authorityRoots(createLc4AuthorityEvents(entries)),
    });
    expect(JSON.stringify(artifact)).not.toMatch(/"(?:provider|arm|model|voice)"/i);
    const passed = replayLc4AuthoritativeObligationEvidence({ manifest, artifact, trust });
    expect(passed).toMatchObject({
      verdict: "pass",
      scoreability: "scorable",
      terminal_world_complete: true,
      latest_revision_authority: true,
      external_effect_integrity: true,
    });
    expect(passed.obligation_results.every((entry) => entry.pass)).toBe(true);

    const firstTool = entries.findIndex((entry) => entry.event_type === "tool_receipt");
    const changed = entries.map((entry, index) => index === firstTool ? { ...entry, outcome: "failed" as const } : entry);
    const failedArtifact = createLc4AuthoritativeObligationEpisodeArtifact({
      manifest,
      episodeSubjectSha256: sha256Hex("opaque-episode-subject-failed"),
      events: createLc4AuthorityEvents(changed),
      signer,
      authorityRoots: authorityRoots(createLc4AuthorityEvents(changed)),
    });
    const failed = replayLc4AuthoritativeObligationEvidence({ manifest, artifact: failedArtifact, trust });
    expect(failed.verdict).toBe("fail");
    expect(failed.scoreability).toBe("scorable");
    expect(failed.obligation_results.some((entry) => !entry.pass)).toBe(true);
  }, 30_000);

  it("makes incomplete ledgers and tampering evidence-invalid rather than model failures", () => {
    const { manifest, signer, trust } = fixture();
    const events = createLc4AuthorityEvents(passingEntries(manifest));
    const incomplete = createLc4AuthoritativeObligationEpisodeArtifact({
      manifest,
      episodeSubjectSha256: sha256Hex("opaque-incomplete"),
      events,
      signer,
      completeSources: { tool: false },
      authorityRoots: authorityRoots(events),
    });
    expect(replayLc4AuthoritativeObligationEvidence({ manifest, artifact: incomplete, trust })).toMatchObject({
      verdict: "evidence_invalid",
      scoreability: "unscorable_missing_authority_evidence",
    });

    const complete = createLc4AuthoritativeObligationEpisodeArtifact({
      manifest,
      episodeSubjectSha256: sha256Hex("opaque-tampered"),
      events,
      signer,
      authorityRoots: authorityRoots(events),
    });
    const tampered = Object.freeze({
      ...complete,
      events: Object.freeze(complete.events.map((event, index) => index === 0
        ? Object.freeze({ ...event, outcome: "failed" as const })
        : event)),
    });
    expect(replayLc4AuthoritativeObligationEvidence({ manifest, artifact: tampered, trust })).toMatchObject({
      verdict: "evidence_invalid",
      scoreability: "unscorable_invalid_authority_evidence",
    });
  }, 30_000);

  it("regresses the retained GX packet to unscorable missing authority evidence, never 0/8 or pass", () => {
    const { manifest, trust } = fixture();
    const retainedGxRecords = [
      "gemini-hacc-op35", "gemini-native-op35", "xai-native-op35", "xai-hacc-op35",
      "gemini-hacc-op42", "gemini-native-op42", "xai-native-op42", "xai-hacc-op42",
    ];
    const replays = retainedGxRecords.map(() => replayLc4AuthoritativeObligationEvidence({
      manifest,
      artifact: null,
      trust,
    }));
    const summary = summarizeLc4AuthoritativeObligationEvidence(replays);
    expect(summary).toEqual({
      status: "unscorable_missing_authority_evidence",
      passed: null,
      evaluated: null,
      evidence_invalid: 8,
    });
    expect(summary).not.toMatchObject({ passed: 0, evaluated: 8 });
    expect(replays.some((replay) => replay.verdict === "pass")).toBe(false);
  }, 30_000);

  it("selects from a closed manifest registry and rejects cross-episode substitution", () => {
    const { manifest, signer, trust } = fixture();
    const subject = sha256Hex("assigned-episode");
    const events = createLc4AuthorityEvents(passingEntries(manifest));
    const registry = createLc4AuthorityManifestRegistry({
      manifests: [manifest],
      assignments: [{ episode_subject_sha256: subject, manifest_sha256: manifest.manifest_sha256 }],
    });
    const artifact = createLc4AuthoritativeObligationEpisodeArtifact({
      manifest,
      episodeSubjectSha256: subject,
      events,
      signer,
      authorityRoots: authorityRoots(events, registry.registry_sha256, registry.assignment_sha256),
    });
    const valid = replayLc4AuthoritativeObligationEvidence({
      manifest,
      artifact,
      trust,
      expectedEpisodeSubjectSha256: subject,
    });
    expect(valid.verdict).toBe("pass");
    expect(createLc4AuthoritativeObligationEvidenceReplayer({ registry, trust })(artifact as never, {
      domain: "authority",
      artifactSha256: sha256Hex(canonicalJson(artifact)),
    })).toMatchObject({
      valid: true,
      derivation: { usefulConjuncts: { authoritative_tool_world_obligations: true } },
    });
    expect(replayLc4AuthoritativeObligationEvidence({
      manifest,
      artifact,
      trust,
      expectedEpisodeSubjectSha256: sha256Hex("different-episode"),
    }).verdict).toBe("evidence_invalid");
  }, 30_000);
});

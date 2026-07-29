import {
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex, type JsonValue } from "../artifacts";
import {
  replayLc4DevelopmentListenerAuthority,
  type Lc4ListenerAuthorityPreflightBinding,
} from "../lc4-development-listener-authority-replay";
import {
  createLc4HeadlessListenerPlaybackAuthority,
  type Lc4HeadlessListenerHandoffReceipt,
} from "../lc4-development-headless-listener-authority";
import {
  createLc4ImmutableCas,
  createLc4PinnedListenerManifestSha256,
} from "../lc4-development-live-dependencies";
import {
  lc4DevelopmentListenerCriterionBindings,
} from "../lc4-development-listener-semantics";
import {
  createBenchmarkKernelAttestationSigner,
} from "../kernel-attestation";
import { createLc4CapturedOutput } from "../lc4-listener-evidence";
import {
  createLc4PublicDevelopmentCorpus,
} from "../lc4-public-development-corpus";

const LISTENER_EVIDENCE_DOMAIN =
  "harshas-amazing-call-center/lc4-dev-pinned-listener-evidence/v1\n";
const AUTHORITY_ARTIFACT_DOMAIN =
  "harshas-amazing-call-center/lc4-dev/headless-listener-handoff-artifact/v1\n";
const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lc4-listener-replay-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function fixtureSigner(input?: Readonly<{
  keys?: Readonly<{ publicKey: KeyObject; privateKey: KeyObject }>;
  keyId?: string;
}>) {
  const keys = input?.keys ?? generateKeyPairSync("ed25519");
  const publicKeyDer = keys.publicKey.export({
    type: "spki",
    format: "der",
  });
  const fingerprint = sha256Hex(publicKeyDer);
  const signer = createBenchmarkKernelAttestationSigner({
    keyId: input?.keyId
      ?? `lc4-dev-authority-${fingerprint.slice(0, 24)}`,
    privateKeyPem: keys.privateKey.export({
      type: "pkcs8",
      format: "pem",
    }).toString(),
    publicKeyPem: keys.publicKey.export({
      type: "spki",
      format: "pem",
    }).toString(),
  });
  return { keys, publicKeyDer, fingerprint, signer };
}

function captureFixture() {
  return createLc4CapturedOutput({
    runId: "lc4-dev-openai-native",
    opportunityId: "lc4-dev-op-01",
    responseId: "response-output-1",
    provider: "openai",
    surface: "server_realtime_pcm",
    sampleRateHz: 24_000,
    chunks: [
      {
        chunkId: "chunk-1",
        pcm: Uint8Array.from([1, 2, 3, 4]),
      },
      {
        chunkId: "chunk-2",
        pcm: Uint8Array.from([5, 6, 7, 8]),
      },
    ],
  });
}

function listenerEvidenceSha256(value: unknown): string {
  return sha256Hex(
    `${LISTENER_EVIDENCE_DOMAIN}${canonicalJson(value)}`,
  );
}

function authorityReceiptSha256(
  receipt: Omit<Lc4HeadlessListenerHandoffReceipt, "receipt_sha256">,
): string {
  return sha256Hex(
    `${AUTHORITY_ARTIFACT_DOMAIN}${canonicalJson(receipt)}`,
  );
}

async function replayFixture(input?: Readonly<{
  signerFixture?: ReturnType<typeof fixtureSigner>;
  evaluatorContractSha256?: string;
  evaluatorBuildSha256?: string;
  calibrationSha256?: string;
  listenerManifestOverride?: string;
}>) {
  const root = await temporaryDirectory();
  const cas = await createLc4ImmutableCas(join(root, "cas"));
  const signerFixture = input?.signerFixture ?? fixtureSigner();
  const authority =
    createLc4HeadlessListenerPlaybackAuthority({
      signer: signerFixture.signer,
    });
  const capture = captureFixture();
  const pcm = Uint8Array.from(
    capture.chunks.flatMap((chunk) => [...chunk.pcm]),
  );
  const signedInvocationArtifact = Buffer.from(
    canonicalJson({
      request: { source_played_audio_sha256: sha256Hex(pcm) },
      result: { transcript_sha256: "4".repeat(64) },
      receipt: { receipt_sha256: "6".repeat(64) },
    }),
    "utf8",
  );
  const signedInvocationArtifactReceipt = await cas.put(
    signedInvocationArtifact,
    "application/json",
  );
  const evaluation = Object.freeze({
    source_pcm_sha256: sha256Hex(pcm),
    source_pcm_byte_length: pcm.byteLength,
    evaluator_contract_sha256:
      input?.evaluatorContractSha256 ?? "1".repeat(64),
    evaluator_build_sha256:
      input?.evaluatorBuildSha256 ?? "2".repeat(64),
    calibration_sha256:
      input?.calibrationSha256 ?? "3".repeat(64),
    transcript_sha256: "4".repeat(64),
    semantic_result_sha256: "5".repeat(64),
    signed_invocation_receipt_sha256: "6".repeat(64),
    signed_invocation_artifact_cas_sha256:
      signedInvocationArtifactReceipt.artifact_sha256,
    signed_invocation_artifact_byte_length:
      signedInvocationArtifactReceipt.byte_length,
  });
  const handoff = await authority.consume({
    capture,
    pcm,
    criterion_plan_sha256: "7".repeat(64),
    evaluator: Object.freeze({
      evaluator_contract_sha256: evaluation.evaluator_contract_sha256,
      evaluator_build_sha256: evaluation.evaluator_build_sha256,
      calibration_sha256: evaluation.calibration_sha256,
      async evaluate() {
        return evaluation;
      },
    }),
  });
  const pcmReceipt = await cas.put(pcm, "audio/pcm");
  const authorityBytes = Buffer.from(
    canonicalJson(handoff.authority_receipt),
    "utf8",
  );
  const authorityCasReceipt = await cas.put(
    authorityBytes,
    "application/json",
  );
  const listenerManifestSha256 =
    input?.listenerManifestOverride
    ?? createLc4PinnedListenerManifestSha256({
      corpus_sha256:
        createLc4PublicDevelopmentCorpus().artifact_sha256,
      evaluator: evaluation,
      criteria: lc4DevelopmentListenerCriterionBindings(),
      playback_authority_manifest_sha256:
        authority.authority_manifest_sha256,
    });
  const listenerEvidence = {
    schema_version: 1,
    dependency_version: "lc4-dev-live-dependencies-v1",
    episode_id: capture.run_id,
    opportunity_id: capture.opportunity_id,
    provider: capture.provider,
    capture_receipt_sha256: capture.capture_receipt_sha256,
    generated_pcm_sha256: capture.generated_pcm_sha256,
    captured_pcm_sha256: capture.generated_pcm_sha256,
    evaluator_consumed_pcm_sha256: capture.generated_pcm_sha256,
    evaluator_consumed_byte_start: 0,
    evaluator_consumed_byte_end: pcm.byteLength,
    evaluator_consumed_pcm_cas_receipt_sha256:
      pcmReceipt.receipt_sha256,
    headless_listener_authority_receipt_sha256:
      handoff.authority_receipt.receipt_sha256,
    headless_listener_authority_receipt_cas_sha256:
      authorityCasReceipt.artifact_sha256,
    headless_listener_authority_receipt_cas_receipt_sha256:
      authorityCasReceipt.receipt_sha256,
    physical_playback_status: "not_performed_headless",
    human_audibility_status: "not_measured_not_claimed",
    criterion_plan_sha256: "7".repeat(64),
    response_plan_sha256: null,
    wire_observation_set_sha256: "9".repeat(64),
    signed_invocation_artifact_cas_sha256:
      evaluation.signed_invocation_artifact_cas_sha256,
    signed_invocation_artifact_byte_length:
      evaluation.signed_invocation_artifact_byte_length,
    evaluation,
    listener_manifest_sha256: listenerManifestSha256,
  };
  const authorizationArtifactSha256 = "a".repeat(64);
  const preflight: Lc4ListenerAuthorityPreflightBinding = Object.freeze({
    authority_trust_root_sha256: signerFixture.fingerprint,
    authorization_artifact_sha256: authorizationArtifactSha256,
    authorization_verified: true,
    listener_evidence_manifest_sha256: listenerManifestSha256,
    asr_evaluator_build_sha256: evaluation.evaluator_build_sha256,
    authorization: Object.freeze({
      artifact_sha256: authorizationArtifactSha256,
      authority_public_key_spki_base64:
        signerFixture.publicKeyDer.toString("base64"),
      authority_public_key_fingerprint_sha256:
        signerFixture.fingerprint,
      signature_algorithm: "Ed25519",
    }),
  });
  return {
    cas,
    capture,
    pcm,
    handoff,
    listenerEvidence,
    listenerEvidenceSha256: listenerEvidenceSha256(listenerEvidence),
    preflight,
    signerFixture,
  };
}

describe("LC4 listener authority CAS replay", () => {
  it("reopens exact PCM and signed receipt bytes and binds them to preflight", async () => {
    const fixture = await replayFixture();
    const replay = await replayLc4DevelopmentListenerAuthority({
      cas: fixture.cas,
      preflight: fixture.preflight,
      expected_authority_trust_root_sha256:
        fixture.signerFixture.fingerprint,
      listener_evidence:
        fixture.listenerEvidence as unknown as JsonValue,
      listener_evidence_sha256: fixture.listenerEvidenceSha256,
      capture: fixture.capture,
      pcm: fixture.pcm,
    });

    expect(replay).toMatchObject({
      schema_version: 1,
      listener_evidence_sha256: fixture.listenerEvidenceSha256,
      capture_receipt_sha256: fixture.capture.capture_receipt_sha256,
      generated_pcm_sha256: sha256Hex(fixture.pcm),
      headless_listener_authority_receipt_sha256:
        fixture.handoff.authority_receipt.receipt_sha256,
      authority_trust_root_sha256:
        fixture.signerFixture.fingerprint,
      asr_evaluator_build_sha256: "2".repeat(64),
      listener_evidence_manifest_sha256:
        fixture.listenerEvidence.listener_manifest_sha256,
      physical_playback_status: "not_performed_headless",
      human_audibility_status: "not_measured_not_claimed",
    });
    expect(replay.replay_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects substituted CAS bytes and self-rehashed CAS receipt identities", async () => {
    const fixture = await replayFixture();
    const receiptCasSha256 =
      fixture.listenerEvidence
        .headless_listener_authority_receipt_cas_sha256;
    const substitutedCas = {
      get: async (artifactSha256: string) =>
        artifactSha256 === receiptCasSha256
          ? Buffer.from('{"substituted":true}', "utf8")
          : fixture.cas.get(artifactSha256),
    };
    await expect(replayLc4DevelopmentListenerAuthority({
      cas: substitutedCas,
      preflight: fixture.preflight,
      expected_authority_trust_root_sha256:
        fixture.signerFixture.fingerprint,
      listener_evidence:
        fixture.listenerEvidence as unknown as JsonValue,
      listener_evidence_sha256: fixture.listenerEvidenceSha256,
      capture: fixture.capture,
      pcm: fixture.pcm,
    })).rejects.toThrow(/CAS bytes differ|CAS bytes are missing|CAS artifact content/u);

    const receiptMutation = {
      ...fixture.listenerEvidence,
      headless_listener_authority_receipt_cas_receipt_sha256:
        "f".repeat(64),
    };
    await expect(replayLc4DevelopmentListenerAuthority({
      cas: fixture.cas,
      preflight: fixture.preflight,
      expected_authority_trust_root_sha256:
        fixture.signerFixture.fingerprint,
      listener_evidence: receiptMutation as unknown as JsonValue,
      listener_evidence_sha256:
        listenerEvidenceSha256(receiptMutation),
      capture: fixture.capture,
      pcm: fixture.pcm,
    })).rejects.toThrow("authority receipt CAS receipt identity is invalid");

    const pcmReceiptMutation = {
      ...fixture.listenerEvidence,
      evaluator_consumed_pcm_cas_receipt_sha256: "e".repeat(64),
    };
    await expect(replayLc4DevelopmentListenerAuthority({
      cas: fixture.cas,
      preflight: fixture.preflight,
      expected_authority_trust_root_sha256:
        fixture.signerFixture.fingerprint,
      listener_evidence: pcmReceiptMutation as unknown as JsonValue,
      listener_evidence_sha256:
        listenerEvidenceSha256(pcmReceiptMutation),
      capture: fixture.capture,
      pcm: fixture.pcm,
    })).rejects.toThrow("PCM CAS receipt identity is invalid");

    const noncanonicalAuthorityReceipt = await fixture.cas.put(
      Buffer.from(
        JSON.stringify(fixture.handoff.authority_receipt, null, 2),
        "utf8",
      ),
      "application/json",
    );
    const noncanonicalListener = {
      ...fixture.listenerEvidence,
      headless_listener_authority_receipt_cas_sha256:
        noncanonicalAuthorityReceipt.artifact_sha256,
      headless_listener_authority_receipt_cas_receipt_sha256:
        noncanonicalAuthorityReceipt.receipt_sha256,
    };
    await expect(replayLc4DevelopmentListenerAuthority({
      cas: fixture.cas,
      preflight: fixture.preflight,
      expected_authority_trust_root_sha256:
        fixture.signerFixture.fingerprint,
      listener_evidence:
        noncanonicalListener as unknown as JsonValue,
      listener_evidence_sha256:
        listenerEvidenceSha256(noncanonicalListener),
      capture: fixture.capture,
      pcm: fixture.pcm,
    })).rejects.toThrow("is not exact canonical JSON");
  });

  it("rejects a forged but freshly rehashed receipt and a substituted trust root", async () => {
    const fixture = await replayFixture();
    const original = fixture.handoff.authority_receipt;
    const signature = Buffer.from(original.signature_base64, "base64");
    signature[0] ^= 0xff;
    const forgedWithoutHash = {
      body: original.body,
      signature_algorithm: original.signature_algorithm,
      signature_base64: signature.toString("base64"),
    };
    const forged = {
      ...forgedWithoutHash,
      receipt_sha256: authorityReceiptSha256(forgedWithoutHash),
    };
    const forgedCasReceipt = await fixture.cas.put(
      Buffer.from(canonicalJson(forged), "utf8"),
      "application/json",
    );
    const forgedListener = {
      ...fixture.listenerEvidence,
      headless_listener_authority_receipt_sha256:
        forged.receipt_sha256,
      headless_listener_authority_receipt_cas_sha256:
        forgedCasReceipt.artifact_sha256,
      headless_listener_authority_receipt_cas_receipt_sha256:
        forgedCasReceipt.receipt_sha256,
    };
    await expect(replayLc4DevelopmentListenerAuthority({
      cas: fixture.cas,
      preflight: fixture.preflight,
      expected_authority_trust_root_sha256:
        fixture.signerFixture.fingerprint,
      listener_evidence: forgedListener as unknown as JsonValue,
      listener_evidence_sha256:
        listenerEvidenceSha256(forgedListener),
      capture: fixture.capture,
      pcm: fixture.pcm,
    })).rejects.toThrow("receipt signature is invalid");

    await expect(replayLc4DevelopmentListenerAuthority({
      cas: fixture.cas,
      preflight: fixture.preflight,
      expected_authority_trust_root_sha256: "d".repeat(64),
      listener_evidence:
        fixture.listenerEvidence as unknown as JsonValue,
      listener_evidence_sha256: fixture.listenerEvidenceSha256,
      capture: fixture.capture,
      pcm: fixture.pcm,
    })).rejects.toThrow("differs from the intended trust root");
  });

  it("rejects a valid same-key signature under a substituted authority identity", async () => {
    const commonKeys = generateKeyPairSync("ed25519");
    const rogue = fixtureSigner({
      keys: commonKeys,
      keyId: "lc4-dev-authority-substituted",
    });
    const fixture = await replayFixture({ signerFixture: rogue });

    await expect(replayLc4DevelopmentListenerAuthority({
      cas: fixture.cas,
      preflight: fixture.preflight,
      expected_authority_trust_root_sha256: rogue.fingerprint,
      listener_evidence:
        fixture.listenerEvidence as unknown as JsonValue,
      listener_evidence_sha256: fixture.listenerEvidenceSha256,
      capture: fixture.capture,
      pcm: fixture.pcm,
    })).rejects.toThrow("signer or artifact binding is invalid");
  });

  it("rejects a listener evaluator build outside the signed preflight", async () => {
    const fixture = await replayFixture();
    const substitutedPreflight = {
      ...fixture.preflight,
      asr_evaluator_build_sha256: "f".repeat(64),
    };

    await expect(replayLc4DevelopmentListenerAuthority({
      cas: fixture.cas,
      preflight: substitutedPreflight,
      expected_authority_trust_root_sha256:
        fixture.signerFixture.fingerprint,
      listener_evidence:
        fixture.listenerEvidence as unknown as JsonValue,
      listener_evidence_sha256: fixture.listenerEvidenceSha256,
      capture: fixture.capture,
      pcm: fixture.pcm,
    })).rejects.toThrow(
      "not bound to the exact listener, capture, evaluator, PCM, and preflight roots",
    );
  });

  it("rejects freshly rehashed contract, calibration, and criterion manifest substitutions", async () => {
    const signerFixture = fixtureSigner();
    const baseline = await replayFixture({ signerFixture });
    const frozenManifest =
      baseline.listenerEvidence.listener_manifest_sha256;

    for (const mutation of [
      { evaluatorContractSha256: "b".repeat(64) },
      { calibrationSha256: "c".repeat(64) },
    ]) {
      const fixture = await replayFixture({
        signerFixture,
        listenerManifestOverride: frozenManifest,
        ...mutation,
      });
      await expect(replayLc4DevelopmentListenerAuthority({
        cas: fixture.cas,
        preflight: fixture.preflight,
        expected_authority_trust_root_sha256:
          signerFixture.fingerprint,
        listener_evidence:
          fixture.listenerEvidence as unknown as JsonValue,
        listener_evidence_sha256: fixture.listenerEvidenceSha256,
        capture: fixture.capture,
        pcm: fixture.pcm,
      })).rejects.toThrow(
        "not bound to the exact listener, capture, evaluator, PCM, and preflight roots",
      );
    }

    const substitutedCriteria =
      lc4DevelopmentListenerCriterionBindings().map(
        (binding, index) => index === 0
          ? {
              ...binding,
              criterion_plan_sha256: "d".repeat(64),
            }
          : binding,
      );
    const substitutedCriteriaManifest =
      createLc4PinnedListenerManifestSha256({
        corpus_sha256:
          createLc4PublicDevelopmentCorpus().artifact_sha256,
        evaluator: baseline.listenerEvidence.evaluation,
        criteria: substitutedCriteria,
        playback_authority_manifest_sha256:
          baseline.handoff.authority_receipt.body
            .authority_manifest_sha256,
      });
    const criteriaFixture = await replayFixture({
      signerFixture,
      listenerManifestOverride: substitutedCriteriaManifest,
    });
    await expect(replayLc4DevelopmentListenerAuthority({
      cas: criteriaFixture.cas,
      preflight: criteriaFixture.preflight,
      expected_authority_trust_root_sha256:
        signerFixture.fingerprint,
      listener_evidence:
        criteriaFixture.listenerEvidence as unknown as JsonValue,
      listener_evidence_sha256:
        criteriaFixture.listenerEvidenceSha256,
      capture: criteriaFixture.capture,
      pcm: criteriaFixture.pcm,
    })).rejects.toThrow(
      "not bound to the exact listener, capture, evaluator, PCM, and preflight roots",
    );
  });
});

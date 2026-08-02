import { describe, expect, it } from "vitest";

import { sha256Hex } from "../artifacts";
import { createLc4PublicDevelopmentCorpus } from "../lc4-public-development-corpus";
import {
  LC4_DEV_REPLAY_EVIDENCE_VERSION,
  type Lc4DevReplayArtifactKind,
  type Lc4DevReplayArtifactReference,
} from "../lc4-development-evidence-retention";
import {
  assertLc4PublicationRepairSelectionBinding,
  resolveLc4PublicationRepairPcmReference,
} from "../lc4-publication-transport-replay";

function reference(
  kind: Lc4DevReplayArtifactKind,
  evidenceSha256: string,
): Lc4DevReplayArtifactReference {
  return Object.freeze({
    schema_version: 1,
    retention_version: LC4_DEV_REPLAY_EVIDENCE_VERSION,
    kind,
    evidence_sha256: evidenceSha256,
    byte_length: 4,
    content_encoding: "raw-bytes",
    domain_prefix: "",
  });
}

describe("LC4 publication repair PCM ledger edge", () => {
  it("accepts exactly one repair_pcm edge for the retained repair audio", () => {
    const repairPcmSha256 = sha256Hex("repair PCM");
    const retained = reference("repair_pcm", repairPcmSha256);

    expect(resolveLc4PublicationRepairPcmReference({
      evidence_references: [
        reference("repair_decision", sha256Hex("decision")),
        retained,
      ],
    }, repairPcmSha256)).toBe(retained);
  });

  it.each(["caller_pcm", "assistant_pcm"] as const)(
    "rejects a %s edge substituted for retained repair audio",
    (kind) => {
      const repairPcmSha256 = sha256Hex("repair PCM");

      expect(() => resolveLc4PublicationRepairPcmReference({
        evidence_references: [reference(kind, repairPcmSha256)],
      }, repairPcmSha256)).toThrow(
        "LC4 publication repair lacks one exact caller PCM ledger edge",
      );
    },
  );

  it("rejects duplicate repair_pcm edges instead of choosing one", () => {
    const repairPcmSha256 = sha256Hex("repair PCM");
    const retained = reference("repair_pcm", repairPcmSha256);

    expect(() => resolveLc4PublicationRepairPcmReference({
      evidence_references: [retained, { ...retained }],
    }, repairPcmSha256)).toThrow(
      "LC4 publication repair lacks one exact caller PCM ledger edge",
    );
  });
});

describe("LC4 publication frozen repair selection binding", () => {
  const repairSource = createLc4PublicDevelopmentCorpus()
    .repair_policy.library[0]!;
  const repairPcmSha256 = sha256Hex("repair PCM");
  const validSelection = Object.freeze({
    repair_pcm_id: repairSource.id,
    pcm_sha256: repairPcmSha256,
    byte_length: 4,
  });

  it("accepts the canonical byte_length field for the frozen repair item", () => {
    expect(() => assertLc4PublicationRepairSelectionBinding({
      selection: validSelection,
      repair_source: repairSource,
      repair_pcm_sha256: repairPcmSha256,
      repair_pcm_byte_length: 4,
    })).not.toThrow();
  });

  it("rejects a retained selection whose byte length differs from CAS", () => {
    expect(() => assertLc4PublicationRepairSelectionBinding({
      selection: { ...validSelection, byte_length: 6 },
      repair_source: repairSource,
      repair_pcm_sha256: repairPcmSha256,
      repair_pcm_byte_length: 4,
    })).toThrow(
      "LC4 publication repair caller text differs from its frozen repair library",
    );
  });
});

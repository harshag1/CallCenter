import { describe, expect, it } from "vitest";

import { sha256Hex } from "../artifacts";
import {
  LC4_DEV_REPLAY_EVIDENCE_VERSION,
  type Lc4DevReplayArtifactKind,
  type Lc4DevReplayArtifactReference,
} from "../lc4-development-evidence-retention";
import {
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

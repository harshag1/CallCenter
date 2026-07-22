import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "../artifacts";
import {
  assertLc4HeadlessListenerHandoffReceipt,
  createLc4HeadlessListenerPlaybackAuthority,
  type Lc4PinnedListenerEvaluator,
} from "../lc4-development-headless-listener-authority";
import {
  benchmarkKernelAttestationPublicKeyFingerprint,
  createBenchmarkKernelAttestationSigner,
  type BenchmarkKernelAttestationTrust,
} from "../kernel-attestation";
import { createLc4CapturedOutput } from "../lc4-listener-evidence";

function authorityFixture() {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signer = createBenchmarkKernelAttestationSigner({
    keyId: "lc4-dev-headless-listener",
    privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem,
  });
  const trust: BenchmarkKernelAttestationTrust = Object.freeze({
    keyId: signer.keyId,
    publicKeySha256: benchmarkKernelAttestationPublicKeyFingerprint(publicKeyPem),
    publicKeyPem,
  });
  return { authority: createLc4HeadlessListenerPlaybackAuthority({ signer }), trust };
}

function captureFixture() {
  return createLc4CapturedOutput({
    runId: "lc4-dev-openai-native",
    opportunityId: "lc4-dev-op-01",
    responseId: "response-1",
    provider: "openai",
    surface: "server_realtime_pcm",
    sampleRateHz: 24_000,
    chunks: [
      { chunkId: "chunk-0", pcm: Uint8Array.from([1, 2, 3, 4]) },
      { chunkId: "chunk-1", pcm: Uint8Array.from([5, 6, 7, 8]) },
      { chunkId: "chunk-2", pcm: Uint8Array.from([9, 10, 11, 12]) },
    ],
  });
}

function evaluatorFixture(observe?: (pcm: Uint8Array) => void): Lc4PinnedListenerEvaluator {
  return Object.freeze({
    evaluator_contract_sha256: "1".repeat(64),
    evaluator_build_sha256: "2".repeat(64),
    calibration_sha256: "3".repeat(64),
    async evaluate({ pcm }) {
      observe?.(pcm);
      return Object.freeze({
        source_pcm_sha256: sha256Hex(pcm),
        source_pcm_byte_length: pcm.byteLength,
        evaluator_contract_sha256: "1".repeat(64),
        evaluator_build_sha256: "2".repeat(64),
        calibration_sha256: "3".repeat(64),
        transcript_sha256: "4".repeat(64),
        semantic_result_sha256: "5".repeat(64),
        signed_invocation_receipt_sha256: "6".repeat(64),
      });
    },
  });
}

describe("LC4-DEV headless listener authority", () => {
  it("signs the exact complete generated/captured/evaluator-consumed PCM range without claiming human audibility", async () => {
    const capture = captureFixture();
    const pcm = Uint8Array.from(capture.chunks.flatMap((chunk) => [...chunk.pcm]));
    const seen: Uint8Array[] = [];
    const { authority, trust } = authorityFixture();
    const result = await authority.consume({
      capture,
      pcm,
      criterion_plan_sha256: "7".repeat(64),
      evaluator: evaluatorFixture((bytes) => seen.push(Uint8Array.from(bytes))),
    });

    expect(seen).toEqual([pcm]);
    expect(result).toMatchObject({
      status: "evaluator_consumed_complete_capture",
      generated_byte_length: pcm.byteLength,
      captured_byte_start: 0,
      captured_byte_end: pcm.byteLength,
      evaluator_consumed_byte_start: 0,
      evaluator_consumed_byte_end: pcm.byteLength,
      physical_playback_status: "not_performed_headless",
      human_audibility_status: "not_measured_not_claimed",
    });
    expect(result.generated_pcm_sha256).toBe(sha256Hex(pcm));
    expect(result.captured_pcm_sha256).toBe(sha256Hex(pcm));
    expect(result.evaluator_consumed_pcm_sha256).toBe(sha256Hex(pcm));
    expect(result.authority_receipt.body.evidence_scope).toBe("server_captured_pcm_handed_to_pinned_evaluator");
    expect(() => assertLc4HeadlessListenerHandoffReceipt({
      receipt: result.authority_receipt,
      trust,
      capture,
      pcm,
    })).not.toThrow();
  });

  it("fails closed on truncation, substitution, and capture chunk reordering", async () => {
    const capture = captureFixture();
    const pcm = Uint8Array.from(capture.chunks.flatMap((chunk) => [...chunk.pcm]));
    const { authority } = authorityFixture();
    const common = { criterion_plan_sha256: "7".repeat(64), evaluator: evaluatorFixture() };

    await expect(authority.consume({ capture, pcm: pcm.slice(0, -2), ...common }))
      .rejects.toThrow("differs from the exact complete captured PCM");
    const substituted = Uint8Array.from(pcm);
    substituted[2] ^= 0xff;
    await expect(authority.consume({ capture, pcm: substituted, ...common }))
      .rejects.toThrow("differs from the exact complete captured PCM");
    const reordered = { ...capture, chunks: [capture.chunks[1]!, capture.chunks[0]!, capture.chunks[2]!] };
    await expect(authority.consume({ capture: reordered, pcm, ...common }))
      .rejects.toThrow("invalid LC4 capture");
  });

  it("rejects evaluator source substitution and mutation during the handoff", async () => {
    const capture = captureFixture();
    const pcm = Uint8Array.from(capture.chunks.flatMap((chunk) => [...chunk.pcm]));
    const { authority } = authorityFixture();
    const substitutedEvaluator = {
      ...evaluatorFixture(),
      async evaluate() {
        return {
          source_pcm_sha256: "f".repeat(64), source_pcm_byte_length: pcm.byteLength,
          evaluator_contract_sha256: "1".repeat(64), evaluator_build_sha256: "2".repeat(64),
          calibration_sha256: "3".repeat(64), transcript_sha256: "4".repeat(64),
          semantic_result_sha256: "5".repeat(64), signed_invocation_receipt_sha256: "6".repeat(64),
        };
      },
    };
    await expect(authority.consume({
      capture, pcm, criterion_plan_sha256: "7".repeat(64), evaluator: substitutedEvaluator,
    })).rejects.toThrow("did not attest consumption of the exact complete captured PCM");

    const mutatingEvaluator = evaluatorFixture((bytes) => { bytes[0] ^= 0xff; });
    await expect(authority.consume({
      capture, pcm, criterion_plan_sha256: "7".repeat(64), evaluator: mutatingEvaluator,
    })).rejects.toThrow("mutated its source PCM buffer");
  });

  it("rejects altered signed receipts, substituted captures, and the wrong trust root", async () => {
    const capture = captureFixture();
    const pcm = Uint8Array.from(capture.chunks.flatMap((chunk) => [...chunk.pcm]));
    const { authority, trust } = authorityFixture();
    const result = await authority.consume({
      capture, pcm, criterion_plan_sha256: "7".repeat(64), evaluator: evaluatorFixture(),
    });
    const tampered = {
      ...result.authority_receipt,
      body: { ...result.authority_receipt.body, evaluator_consumed_byte_end: pcm.byteLength - 2 },
    };
    expect(() => assertLc4HeadlessListenerHandoffReceipt({ receipt: tampered, trust }))
      .toThrow("does not prove complete exact evaluator consumption");

    const substitutedCapture = createLc4CapturedOutput({
      runId: capture.run_id, opportunityId: capture.opportunity_id, responseId: "response-2",
      provider: capture.provider, surface: capture.surface, sampleRateHz: capture.format.sample_rate_hz,
      chunks: capture.chunks.map((chunk) => ({ chunkId: chunk.receipt.chunk_id, pcm: chunk.pcm })),
    });
    expect(() => assertLc4HeadlessListenerHandoffReceipt({
      receipt: result.authority_receipt, trust, capture: substitutedCapture,
    })).toThrow("substituted from another capture");

    const wrong = authorityFixture().trust;
    expect(() => assertLc4HeadlessListenerHandoffReceipt({ receipt: result.authority_receipt, trust: wrong }))
      .toThrow("signer or artifact binding is invalid");
  });
});

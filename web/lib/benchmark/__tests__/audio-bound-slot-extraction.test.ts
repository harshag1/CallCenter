import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../artifacts";
import {
  extractAudioBoundSlots,
  verifyAudioBoundSlotExtractionReceipt,
  type AudioBoundSlotAuthority,
  type AudioBoundSlotExtractionInput,
  type AudioBoundSlotSpec,
} from "../audio-bound-slot-extraction";
import type { WhisperCppAsrNormalizedResult, WhisperCppAsrReceipt } from "../whisper-cpp-asr";

const RESULT_DOMAIN = "hacc/whisper-cpp-asr-result/v1\n";
const RECEIPT_DOMAIN = "hacc/whisper-cpp-asr-receipt/v1\n";

function fixture(transcript: string): AudioBoundSlotExtractionInput {
  const pcm = Uint8Array.from({ length: 960 }, (_, index) => index % 251);
  const pcmSha256 = sha256Hex(pcm);
  const sourceRequestSha256 = sha256Hex("caller-request");
  const sourceChunkSequenceSha256 = sha256Hex("caller-chunks");
  const configSha256 = sha256Hex("pinned-asr-config");
  const result: WhisperCppAsrNormalizedResult = {
    status: "completed",
    source_request_sha256: sourceRequestSha256,
    source_played_audio_sha256: pcmSha256,
    source_chunk_sequence_sha256: sourceChunkSequenceSha256,
    language: "en",
    transcript,
    processed_through_sample: pcm.byteLength / 2,
    no_speech_probability_ppm: null,
    spans: transcript.length === 0 ? [] : [{
      span_id: "span-000",
      text: transcript,
      utf8_start: 0,
      utf8_end: Buffer.byteLength(transcript, "utf8"),
      audio_start_sample: 0,
      audio_end_sample: pcm.byteLength / 2,
      confidence_ppm: null,
    }],
  };
  const normalizedResultSha256 = sha256Hex(`${RESULT_DOMAIN}${canonicalJson(result)}`);
  const receiptBody = {
    schema_version: 1 as const,
    receipt_type: "hacc_whisper_cpp_asr" as const,
    invocation_id: "asr.caller.014",
    run_id: "lc4.run.001",
    unit_id: "caller.opportunity.014",
    source_request_sha256: sourceRequestSha256,
    source_played_audio_sha256: pcmSha256,
    source_chunk_sequence_sha256: sourceChunkSequenceSha256,
    config_sha256: configSha256,
    toolchain_verification: { mode: "per_invocation_full_hash" as const, batch_id: null },
    input: {
      encoding: "pcm16" as const,
      endianness: "little" as const,
      sample_rate_hz: 24_000 as const,
      channels: 1 as const,
      byte_length: pcm.byteLength,
      sample_count: pcm.byteLength / 2,
      pcm_sha256: pcmSha256,
    },
    toolchain: {
      whisper_cpp_source_revision: "a".repeat(40),
      whisper_cpp_version: "1.9.1",
      whisper_cli_path_sha256: sha256Hex("whisper-path"),
      whisper_cli_sha256: sha256Hex("whisper-bin"),
      model_id: "ggml-small.en",
      model_revision: "b".repeat(40),
      model_path_sha256: sha256Hex("model-path"),
      model_sha256: sha256Hex("model"),
      ffmpeg_path_sha256: sha256Hex("ffmpeg-path"),
      ffmpeg_sha256: sha256Hex("ffmpeg"),
    },
    conversion: {
      profile: "ffmpeg-pcm16le-24khz-mono-to-wav-pcm16le-16khz-mono-bitexact-v1" as const,
      argv_sha256: sha256Hex("ffmpeg-argv"),
      wav_sha256: sha256Hex("wav"),
      wav_byte_length: 1_024,
      runtime_ms: 4,
    },
    inference: {
      argv_sha256: sha256Hex("whisper-argv"),
      runtime_ms: 8,
      stdout_sha256: sha256Hex("stdout"),
      stderr_sha256: sha256Hex("stderr"),
      exit_code: 0 as const,
    },
    transcript_file_sha256: sha256Hex(`${transcript}\n`),
    normalized_result_sha256: normalizedResultSha256,
    result,
  };
  const asrReceipt: WhisperCppAsrReceipt = {
    ...receiptBody,
    receipt_sha256: sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(receiptBody)}`),
  };
  const authority: AudioBoundSlotAuthority = {
    schema_version: 1,
    run_id: asrReceipt.run_id,
    unit_id: asrReceipt.unit_id,
    invocation_id: asrReceipt.invocation_id,
    opportunity_id: "opportunity.014",
    authority_artifact_sha256: sha256Hex("frozen-caller-audio-manifest"),
    caller_pcm_sha256: pcmSha256,
    source_request_sha256: sourceRequestSha256,
    source_chunk_sequence_sha256: sourceChunkSequenceSha256,
    asr_config_sha256: configSha256,
    asr_receipt_sha256: asrReceipt.receipt_sha256,
  };
  const spec: AudioBoundSlotSpec = {
    schema_version: 1,
    extraction_id: "extract.campus.clearance",
    slots: [{
      slot_id: "clearance_token",
      candidates: [
        { candidate_id: "fac.993", canonical_value: "FAC-ACCOM-993", spoken_forms: ["FAC accommodation 993", "F A C accommodation nine nine three"] },
        { candidate_id: "fac.992", canonical_value: "FAC-ACCOM-992", spoken_forms: ["FAC accommodation 992"] },
      ],
    }, {
      slot_id: "duration_minutes",
      candidates: [
        { candidate_id: "minutes.150", canonical_value: 150, spoken_forms: ["150 minutes", "one hundred fifty minutes"] },
        { candidate_id: "minutes.120", canonical_value: 120, spoken_forms: ["120 minutes"] },
      ],
    }],
  };
  return { authority, callerPcm: pcm, asrReceipt, spec };
}

describe("audio-bound caller slot extraction", () => {
  it("resolves only transcript-matched canonical candidates and emits replay-verifiable provenance", () => {
    const input = fixture("Use F A C accommodation nine nine three and reserve one hundred fifty minutes.");
    const receipt = extractAudioBoundSlots(input);

    expect(receipt.status).toBe("succeeded");
    expect(receipt.failure_reasons).toEqual([]);
    expect(receipt.slots).toMatchObject([
      { slot_id: "clearance_token", status: "resolved", canonical_value: "FAC-ACCOM-993", matched_candidate_ids: ["fac.993"] },
      { slot_id: "duration_minutes", status: "resolved", canonical_value: 150, matched_candidate_ids: ["minutes.150"] },
    ]);
    expect(receipt.authority.caller_pcm_sha256).toBe(sha256Hex(input.callerPcm));
    expect(receipt.authority.asr_receipt_sha256).toBe(input.asrReceipt.receipt_sha256);
    expect(receipt.authority_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.spec_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.transcript_sha256).toBe(sha256Hex(input.asrReceipt.result.transcript));
    expect(verifyAudioBoundSlotExtractionReceipt(input, receipt)).toEqual({ valid: true, errors: [] });
    expect(canonicalJson(extractAudioBoundSlots(input))).toBe(canonicalJson(receipt));

    const forged = structuredClone(receipt);
    (forged.slots[0] as { canonical_value: string }).canonical_value = "FAC-ACCOM-992";
    expect(verifyAudioBoundSlotExtractionReceipt(input, forged)).toEqual({
      valid: false,
      errors: ["slot extraction receipt differs from verified replay"],
    });
  });

  it("fails closed with explicit missing and ambiguous slot dispositions", () => {
    const missing = extractAudioBoundSlots(fixture("Use FAC accommodation 993."));
    expect(missing.status).toBe("rejected");
    expect(missing.failure_reasons).toEqual(["slot_missing:duration_minutes"]);
    expect(missing.slots.find((slot) => slot.slot_id === "duration_minutes")).toMatchObject({
      status: "missing", matched_candidate_ids: [], match_count: 0,
    });

    const ambiguous = extractAudioBoundSlots(fixture(
      "I first said FAC accommodation 992, but now I am saying FAC accommodation 993. Reserve 150 minutes."
    ));
    expect(ambiguous.status).toBe("rejected");
    expect(ambiguous.failure_reasons).toEqual(["slot_ambiguous:clearance_token"]);
    expect(ambiguous.slots[0]).toMatchObject({
      status: "ambiguous", matched_candidate_ids: ["fac.992", "fac.993"], match_count: 2,
    });
    expect(ambiguous.slots[0]).not.toHaveProperty("canonical_value");
  });

  it("rejects PCM, ASR-result, receipt, and authority substitution", () => {
    const input = fixture("Use FAC accommodation 993 and reserve 150 minutes.");
    const changedPcm = { ...input, callerPcm: Uint8Array.from(input.callerPcm, (value) => value ^ 1) };
    expect(() => extractAudioBoundSlots(changedPcm)).toThrow(/PCM differs from the authority/);

    const changedTranscript = structuredClone(input.asrReceipt) as WhisperCppAsrReceipt;
    (changedTranscript.result as { transcript: string }).transcript = "Use FAC accommodation 992 and reserve 150 minutes.";
    expect(() => extractAudioBoundSlots({ ...input, asrReceipt: changedTranscript }))
      .toThrow(/normalized result hash|transcript spans/);

    const substitutedReceipt = structuredClone(input.asrReceipt) as WhisperCppAsrReceipt;
    (substitutedReceipt.inference as { runtime_ms: number }).runtime_ms += 1;
    const { receipt_sha256: priorReceiptSha256, ...body } = substitutedReceipt;
    expect(priorReceiptSha256).toBe(input.authority.asr_receipt_sha256);
    (substitutedReceipt as { receipt_sha256: string }).receipt_sha256 = sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(body)}`);
    expect(() => extractAudioBoundSlots({ ...input, asrReceipt: substitutedReceipt })).toThrow(/authority binding/);

    const wrongAuthority = {
      ...input,
      authority: { ...input.authority, authority_artifact_sha256: "not-a-hash" },
    };
    expect(() => extractAudioBoundSlots(wrongAuthority)).toThrow(/authority artifact hash/);
  });

  it("rejects model/oracle side channels and colliding spoken-form definitions", () => {
    const input = fixture("Use FAC accommodation 993 and reserve 150 minutes.");
    expect(() => extractAudioBoundSlots({
      ...input,
      raw_model_arguments: { clearance_token: "FAC-ACCOM-993" },
    })).toThrow(/unknown or missing fields/);
    expect(() => extractAudioBoundSlots({
      ...input,
      oracle_state: { expected_clearance_token: "FAC-ACCOM-993" },
    })).toThrow(/unknown or missing fields/);

    const colliding = structuredClone(input.spec) as AudioBoundSlotSpec;
    (colliding.slots[0]!.candidates[1]!.spoken_forms as string[]).push("FAC accommodation 993");
    expect(() => extractAudioBoundSlots({ ...input, spec: colliding })).toThrow(/maps to multiple candidates/);
  });

  it("does not treat alphanumeric near-misses as slot matches", () => {
    const receipt = extractAudioBoundSlots(fixture("Use FAC accommodation 994 and reserve 151 minutes."));
    expect(receipt.status).toBe("rejected");
    expect(receipt.failure_reasons).toEqual([
      "slot_missing:clearance_token",
      "slot_missing:duration_minutes",
    ]);
    expect(receipt.slots.every((slot) => slot.match_count === 0)).toBe(true);
  });
});

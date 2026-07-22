import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import type { WhisperCppAsrReceipt } from "./whisper-cpp-asr";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_PCM_BYTES = 256 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_SLOTS = 64;
const MAX_CANDIDATES = 64;
const MAX_FORMS = 32;

const ASR_RESULT_DOMAIN = "hacc/whisper-cpp-asr-result/v1\n";
const ASR_RECEIPT_DOMAIN = "hacc/whisper-cpp-asr-receipt/v1\n";
const AUTHORITY_DOMAIN = "hacc/audio-bound-slot-authority/v1\n";
const SPEC_DOMAIN = "hacc/audio-bound-slot-spec/v1\n";
const MATCH_DOMAIN = "hacc/audio-bound-slot-match-evidence/v1\n";
const RECEIPT_DOMAIN = "hacc/audio-bound-slot-extraction-receipt/v1\n";

export type AudioBoundSlotAuthority = Readonly<{
  schema_version: 1;
  run_id: string;
  unit_id: string;
  invocation_id: string;
  opportunity_id: string;
  authority_artifact_sha256: string;
  caller_pcm_sha256: string;
  source_request_sha256: string;
  source_chunk_sequence_sha256: string;
  asr_config_sha256: string;
  asr_receipt_sha256: string;
}>;

export type AudioBoundSlotSpec = Readonly<{
  schema_version: 1;
  extraction_id: string;
  slots: readonly Readonly<{
    slot_id: string;
    candidates: readonly Readonly<{
      candidate_id: string;
      canonical_value: string | number | boolean;
      spoken_forms: readonly string[];
    }>[];
  }>[];
}>;

export type AudioBoundSlotResult = Readonly<{
  slot_id: string;
  status: "resolved" | "missing" | "ambiguous";
  canonical_value?: string | number | boolean;
  matched_candidate_ids: readonly string[];
  match_count: number;
  match_evidence_sha256: string;
}>;

export type AudioBoundSlotExtractionReceipt = Readonly<{
  schema_version: 1;
  receipt_type: "hacc_audio_bound_slot_extraction";
  extraction_id: string;
  status: "succeeded" | "rejected";
  failure_reasons: readonly string[];
  authority: AudioBoundSlotAuthority;
  authority_sha256: string;
  spec_sha256: string;
  asr_normalized_result_sha256: string;
  transcript_sha256: string;
  slots: readonly AudioBoundSlotResult[];
  receipt_sha256: string;
}>;

export type AudioBoundSlotExtractionInput = Readonly<{
  authority: AudioBoundSlotAuthority;
  callerPcm: Uint8Array;
  asrReceipt: WhisperCppAsrReceipt;
  spec: AudioBoundSlotSpec;
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(canonical)) throw new Error(`${label} has unknown or missing fields`);
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} is not SHA-256`);
  return value;
}

function parseAuthority(value: unknown): AudioBoundSlotAuthority {
  const source = record(value, "slot authority");
  exactKeys(source, [
    "schema_version", "run_id", "unit_id", "invocation_id", "opportunity_id",
    "authority_artifact_sha256", "caller_pcm_sha256", "source_request_sha256",
    "source_chunk_sequence_sha256", "asr_config_sha256", "asr_receipt_sha256",
  ], "slot authority");
  if (source.schema_version !== 1) throw new Error("slot authority schema version is unsupported");
  return immutableJson({
    schema_version: 1 as const,
    run_id: safeId(source.run_id, "slot authority run ID"),
    unit_id: safeId(source.unit_id, "slot authority unit ID"),
    invocation_id: safeId(source.invocation_id, "slot authority invocation ID"),
    opportunity_id: safeId(source.opportunity_id, "slot authority opportunity ID"),
    authority_artifact_sha256: sha(source.authority_artifact_sha256, "slot authority artifact hash"),
    caller_pcm_sha256: sha(source.caller_pcm_sha256, "slot authority PCM hash"),
    source_request_sha256: sha(source.source_request_sha256, "slot authority request hash"),
    source_chunk_sequence_sha256: sha(source.source_chunk_sequence_sha256, "slot authority chunk hash"),
    asr_config_sha256: sha(source.asr_config_sha256, "slot authority ASR config hash"),
    asr_receipt_sha256: sha(source.asr_receipt_sha256, "slot authority ASR receipt hash"),
  }) as AudioBoundSlotAuthority;
}

type ParsedSpec = Readonly<{
  spec: AudioBoundSlotSpec;
  normalizedForms: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
}>;

function asciiTokens(value: string, label: string): readonly string[] {
  if (Buffer.byteLength(value, "utf8") > 4_096) throw new Error(`${label} is too large`);
  const tokens = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (tokens.length === 0) throw new Error(`${label} has no ASCII speech tokens`);
  return tokens;
}

function parseSpec(value: unknown): ParsedSpec {
  const source = record(value, "slot extraction spec");
  exactKeys(source, ["schema_version", "extraction_id", "slots"], "slot extraction spec");
  if (source.schema_version !== 1) throw new Error("slot extraction spec schema version is unsupported");
  if (!Array.isArray(source.slots) || source.slots.length < 1 || source.slots.length > MAX_SLOTS) {
    throw new Error("slot extraction spec slot count is invalid");
  }
  const slotIds = new Set<string>();
  const normalizedForms = new Map<string, ReadonlyMap<string, readonly string[]>>();
  const slots = source.slots.map((slotValue, slotIndex) => {
    const slot = record(slotValue, `slot ${slotIndex + 1}`);
    exactKeys(slot, ["slot_id", "candidates"], `slot ${slotIndex + 1}`);
    const slotId = safeId(slot.slot_id, `slot ${slotIndex + 1} ID`);
    if (slotIds.has(slotId)) throw new Error(`slot ID "${slotId}" is duplicated`);
    slotIds.add(slotId);
    if (!Array.isArray(slot.candidates) || slot.candidates.length < 1 || slot.candidates.length > MAX_CANDIDATES) {
      throw new Error(`slot "${slotId}" candidate count is invalid`);
    }
    const candidateIds = new Set<string>();
    const canonicalOwners = new Map<string, string>();
    const formOwners = new Map<string, string>();
    const formsByCandidate = new Map<string, readonly string[]>();
    const candidates = slot.candidates.map((candidateValue, candidateIndex) => {
      const candidate = record(candidateValue, `slot "${slotId}" candidate ${candidateIndex + 1}`);
      exactKeys(candidate, ["candidate_id", "canonical_value", "spoken_forms"], `slot "${slotId}" candidate ${candidateIndex + 1}`);
      const candidateId = safeId(candidate.candidate_id, `slot "${slotId}" candidate ID`);
      if (candidateIds.has(candidateId)) throw new Error(`slot "${slotId}" candidate ID "${candidateId}" is duplicated`);
      candidateIds.add(candidateId);
      if (!["string", "number", "boolean"].includes(typeof candidate.canonical_value)
        || (typeof candidate.canonical_value === "number" && !Number.isFinite(candidate.canonical_value))) {
        throw new Error(`slot "${slotId}" candidate "${candidateId}" canonical value is invalid`);
      }
      const canonicalKey = canonicalJson(candidate.canonical_value as string | number | boolean);
      const canonicalOwner = canonicalOwners.get(canonicalKey);
      if (canonicalOwner) {
        throw new Error(`slot "${slotId}" candidates "${canonicalOwner}" and "${candidateId}" share one canonical value`);
      }
      canonicalOwners.set(canonicalKey, candidateId);
      if (!Array.isArray(candidate.spoken_forms)
        || candidate.spoken_forms.length < 1 || candidate.spoken_forms.length > MAX_FORMS) {
        throw new Error(`slot "${slotId}" candidate "${candidateId}" spoken forms are invalid`);
      }
      const forms = candidate.spoken_forms.map((form, formIndex) => {
        if (typeof form !== "string" || form.length < 1) {
          throw new Error(`slot "${slotId}" candidate "${candidateId}" form ${formIndex + 1} is invalid`);
        }
        const normalized = asciiTokens(form, `slot "${slotId}" candidate "${candidateId}" form ${formIndex + 1}`).join(" ");
        const owner = formOwners.get(normalized);
        if (owner && owner !== candidateId) {
          throw new Error(`slot "${slotId}" spoken form "${normalized}" maps to multiple candidates`);
        }
        formOwners.set(normalized, candidateId);
        return normalized;
      });
      formsByCandidate.set(candidateId, Object.freeze([...new Set(forms)]));
      return Object.freeze({
        candidate_id: candidateId,
        canonical_value: candidate.canonical_value as string | number | boolean,
        spoken_forms: Object.freeze(candidate.spoken_forms.map((form) => String(form))),
      });
    });
    normalizedForms.set(slotId, formsByCandidate);
    return Object.freeze({ slot_id: slotId, candidates: Object.freeze(candidates) });
  });
  const spec = immutableJson({
    schema_version: 1 as const,
    extraction_id: safeId(source.extraction_id, "slot extraction ID"),
    slots: Object.freeze(slots),
  }) as AudioBoundSlotSpec;
  return Object.freeze({ spec, normalizedForms });
}

function verifiedTranscript(
  authority: AudioBoundSlotAuthority,
  callerPcm: Uint8Array,
  receiptInput: unknown
): Readonly<{ receipt: WhisperCppAsrReceipt; transcript: string }> {
  if (!(callerPcm instanceof Uint8Array) || callerPcm.byteLength < 2
    || callerPcm.byteLength > MAX_PCM_BYTES || callerPcm.byteLength % 2 !== 0) {
    throw new Error("caller PCM must be non-empty aligned PCM16 within the size limit");
  }
  const pcmSha256 = sha256Hex(callerPcm);
  if (pcmSha256 !== authority.caller_pcm_sha256) throw new Error("caller PCM differs from the authority binding");

  const receipt = record(receiptInput, "ASR receipt") as unknown as WhisperCppAsrReceipt;
  if (receipt.schema_version !== 1 || receipt.receipt_type !== "hacc_whisper_cpp_asr") {
    throw new Error("ASR receipt type or schema is invalid");
  }
  if (receipt.run_id !== authority.run_id || receipt.unit_id !== authority.unit_id
    || receipt.invocation_id !== authority.invocation_id) {
    throw new Error("ASR receipt identity differs from the authority binding");
  }
  if (receipt.source_request_sha256 !== authority.source_request_sha256
    || receipt.source_chunk_sequence_sha256 !== authority.source_chunk_sequence_sha256
    || receipt.config_sha256 !== authority.asr_config_sha256) {
    throw new Error("ASR receipt provenance differs from the authority binding");
  }
  if (receipt.source_played_audio_sha256 !== pcmSha256
    || receipt.input?.pcm_sha256 !== pcmSha256
    || receipt.input?.byte_length !== callerPcm.byteLength
    || receipt.input?.sample_count !== callerPcm.byteLength / 2
    || receipt.input?.encoding !== "pcm16"
    || receipt.input?.endianness !== "little"
    || receipt.input?.sample_rate_hz !== 24_000
    || receipt.input?.channels !== 1) {
    throw new Error("ASR receipt input does not bind the supplied caller PCM");
  }
  if (!receipt.result || receipt.result.status !== "completed"
    || receipt.result.source_request_sha256 !== authority.source_request_sha256
    || receipt.result.source_chunk_sequence_sha256 !== authority.source_chunk_sequence_sha256
    || receipt.result.source_played_audio_sha256 !== pcmSha256
    || receipt.result.processed_through_sample !== callerPcm.byteLength / 2
    || typeof receipt.result.transcript !== "string"
    || Buffer.byteLength(receipt.result.transcript, "utf8") > MAX_TRANSCRIPT_BYTES) {
    throw new Error("ASR normalized result is incomplete or does not bind the caller PCM");
  }
  const normalizedTranscript = receipt.result.transcript.normalize("NFC")
    .replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
  if (normalizedTranscript !== receipt.result.transcript || receipt.result.transcript.includes("\0")) {
    throw new Error("ASR transcript is not in the normalized receipt form");
  }
  const spans = receipt.result.spans;
  const transcriptByteLength = Buffer.byteLength(receipt.result.transcript, "utf8");
  const spansValid = receipt.result.transcript.length === 0
    ? Array.isArray(spans) && spans.length === 0
    : Array.isArray(spans) && spans.length === 1
      && spans[0]?.span_id === "span-000"
      && spans[0].text === receipt.result.transcript
      && spans[0].utf8_start === 0
      && spans[0].utf8_end === transcriptByteLength
      && spans[0].audio_start_sample === 0
      && spans[0].audio_end_sample === callerPcm.byteLength / 2;
  if (!spansValid) throw new Error("ASR transcript spans are inconsistent with the normalized result");
  const normalizedResultSha256 = sha256Hex(`${ASR_RESULT_DOMAIN}${canonicalJson(receipt.result)}`);
  if (normalizedResultSha256 !== receipt.normalized_result_sha256) {
    throw new Error("ASR normalized result hash is invalid");
  }
  const { receipt_sha256: claimedReceiptSha256, ...receiptBody } = receipt;
  const receiptSha256 = sha256Hex(`${ASR_RECEIPT_DOMAIN}${canonicalJson(receiptBody)}`);
  if (receiptSha256 !== claimedReceiptSha256 || receiptSha256 !== authority.asr_receipt_sha256) {
    throw new Error("ASR receipt hash differs from the authority binding");
  }
  return Object.freeze({ receipt, transcript: receipt.result.transcript });
}

type Token = Readonly<{ value: string; start: number; end: number }>;

function transcriptTokens(transcript: string): readonly Token[] {
  const tokens: Token[] = [];
  for (const match of transcript.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    tokens.push(Object.freeze({ value: match[0], start: match.index, end: match.index + match[0].length }));
  }
  return Object.freeze(tokens);
}

function slotResult(
  slot: AudioBoundSlotSpec["slots"][number],
  formsByCandidate: ReadonlyMap<string, readonly string[]>,
  transcript: string
): AudioBoundSlotResult {
  const tokens = transcriptTokens(transcript);
  const matches: Array<Readonly<{ candidate_id: string; start: number; end: number; form_sha256: string }>> = [];
  for (const candidate of slot.candidates) {
    for (const form of formsByCandidate.get(candidate.candidate_id) ?? []) {
      const formTokens = form.split(" ");
      for (let index = 0; index <= tokens.length - formTokens.length; index += 1) {
        if (!formTokens.every((token, offset) => tokens[index + offset]?.value === token)) continue;
        matches.push(Object.freeze({
          candidate_id: candidate.candidate_id,
          start: tokens[index]!.start,
          end: tokens[index + formTokens.length - 1]!.end,
          form_sha256: sha256Hex(form),
        }));
      }
    }
  }
  const candidateIds = [...new Set(matches.map((match) => match.candidate_id))].sort();
  const status = candidateIds.length === 0 ? "missing" : candidateIds.length === 1 ? "resolved" : "ambiguous";
  const candidate = status === "resolved"
    ? slot.candidates.find((item) => item.candidate_id === candidateIds[0])
    : undefined;
  const body = {
    slot_id: slot.slot_id,
    status,
    ...(candidate ? { canonical_value: candidate.canonical_value } : {}),
    matched_candidate_ids: Object.freeze(candidateIds),
    match_count: matches.length,
    match_evidence_sha256: sha256Hex(`${MATCH_DOMAIN}${canonicalJson(matches)}`),
  };
  return immutableJson(body) as AudioBoundSlotResult;
}

export function extractAudioBoundSlots(inputValue: unknown): AudioBoundSlotExtractionReceipt {
  const input = record(inputValue, "audio-bound slot extraction input");
  exactKeys(input, ["authority", "callerPcm", "asrReceipt", "spec"], "audio-bound slot extraction input");
  const authority = parseAuthority(input.authority);
  const { spec, normalizedForms } = parseSpec(input.spec);
  const { receipt: asrReceipt, transcript } = verifiedTranscript(
    authority,
    input.callerPcm as Uint8Array,
    input.asrReceipt
  );
  const slots = spec.slots.map((slot) => slotResult(slot, normalizedForms.get(slot.slot_id)!, transcript));
  const failureReasons = slots.flatMap((slot) => slot.status === "resolved"
    ? []
    : [`slot_${slot.status}:${slot.slot_id}`]);
  const body = {
    schema_version: 1 as const,
    receipt_type: "hacc_audio_bound_slot_extraction" as const,
    extraction_id: spec.extraction_id,
    status: failureReasons.length === 0 ? "succeeded" as const : "rejected" as const,
    failure_reasons: Object.freeze(failureReasons),
    authority,
    authority_sha256: sha256Hex(`${AUTHORITY_DOMAIN}${canonicalJson(authority)}`),
    spec_sha256: sha256Hex(`${SPEC_DOMAIN}${canonicalJson(spec)}`),
    asr_normalized_result_sha256: asrReceipt.normalized_result_sha256,
    transcript_sha256: sha256Hex(transcript),
    slots: Object.freeze(slots),
  };
  return immutableJson({
    ...body,
    receipt_sha256: sha256Hex(`${RECEIPT_DOMAIN}${canonicalJson(body)}`),
  }) as AudioBoundSlotExtractionReceipt;
}

export function verifyAudioBoundSlotExtractionReceipt(
  input: AudioBoundSlotExtractionInput,
  receipt: unknown
): Readonly<{ valid: boolean; errors: readonly string[] }> {
  try {
    const expected = extractAudioBoundSlots(input);
    if (canonicalJson(receipt) !== canonicalJson(expected)) {
      return Object.freeze({ valid: false, errors: Object.freeze(["slot extraction receipt differs from verified replay"]) });
    }
    return Object.freeze({ valid: true, errors: Object.freeze([]) });
  } catch (error) {
    return Object.freeze({
      valid: false,
      errors: Object.freeze([error instanceof Error ? error.message : "slot extraction verification failed"]),
    });
  }
}

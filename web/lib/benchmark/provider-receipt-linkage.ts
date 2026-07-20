import {
  canonicalJson,
  immutableJson,
  sha256Hex,
  type JsonValue,
} from "./artifacts";
import type {
  BenchmarkKernelAttestationExpectation,
  BenchmarkKernelFinalAttestation,
} from "./kernel-attestation";
import {
  parseKernelTranscript,
  verifyKernelTranscript,
  type KernelTranscriptReference,
  type PublicKernelTranscriptEntry,
} from "./kernel-transcript";
import {
  BenchmarkScenarioSchema,
  WorldReceiptSchema,
  type WorldReceipt,
} from "./scenario-schema";
import { parseBoundToolWorldState } from "./tool-world";

const PROVIDER_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INVOCATION_ID_DOMAIN =
  "harshas-amazing-call-center/provider-receipt-invocation-id/v1\n";
const LINKAGE_DOMAIN =
  "harshas-amazing-call-center/provider-read-only-receipt-linkage/v1\n";

export type ProviderReadOnlyReceiptLinkage = Readonly<{
  schema_version: 1;
  linkage_type: "provider_read_only_toolworld_receipt";
  run_id: string;
  provider_call_id: string;
  transcript_sequence: number;
  transcript_entry_sha256: string;
  transcript_reference: KernelTranscriptReference;
  kernel_attestation_hash: string;
  invocation_id: string;
  receipt_id: string;
  receipt_sha256: string;
  tool: string;
  turn: number;
  safety_proof: Readonly<{
    tool_kind: "query";
    declared_effect_count: 0;
    committed: false;
    receipt_effect_count: 0;
    world_effect_count: 0;
    tainted_result_path_count: 0;
    outcome_class: "success_executed";
  }>;
  linkage_sha256: string;
}>;

export type ProviderReadOnlyReceiptLinkageVerification = Readonly<{
  valid: boolean;
  errors: readonly string[];
  expected_linkage_sha256: string | null;
}>;

type PublicInvokePayload = Readonly<{
  input: Readonly<{
    provider_call_id: string;
    turn: number;
    action: string;
  }>;
  pre_state: Readonly<{
    authoritative_world_head: Readonly<{
      admission_count: number;
      receipt_count: number;
      effect_count: number;
    }>;
  }>;
  post_state: Readonly<{
    authoritative_world_head: Readonly<{
      admission_count: number;
      receipt_count: number;
      effect_count: number;
    }>;
  }>;
  outcome: Readonly<{
    result_class: string;
  }>;
}>;

type LinkageBody = Omit<ProviderReadOnlyReceiptLinkage, "linkage_sha256">;

function fail(message: string): never {
  throw new Error(`provider read-only receipt linkage: ${message}`);
}

function invokePayload(entry: PublicKernelTranscriptEntry): PublicInvokePayload {
  if (
    entry.operation !== "invoke"
    || entry.payload === null
    || typeof entry.payload !== "object"
    || Array.isArray(entry.payload)
  ) {
    return fail("target transcript entry is not an invocation");
  }
  return entry.payload as unknown as PublicInvokePayload;
}

function linkageHash(body: LinkageBody): string {
  return sha256Hex(`${LINKAGE_DOMAIN}${canonicalJson(body as unknown as JsonValue)}`);
}

/** Recompute the self-hash of a persisted linkage without trusting its claim. */
export function providerReadOnlyReceiptLinkageSha256(
  linkage: ProviderReadOnlyReceiptLinkage,
): string {
  if (
    linkage === null
    || typeof linkage !== "object"
    || Array.isArray(linkage)
    || typeof linkage.linkage_sha256 !== "string"
  ) {
    return fail("persisted linkage is malformed");
  }
  const body = Object.fromEntries(
    Object.entries(linkage).filter(([key]) => key !== "linkage_sha256"),
  );
  return linkageHash(body as LinkageBody);
}

/**
 * Stable cross-boundary identity for the ToolWorld receipt created by one
 * provider call. Callers must use this exact value as ToolInvocation.invocation_id.
 *
 * Hashing the provider's opaque ID removes the orchestration-ordinal gap:
 * malformed calls may be observed before the kernel, but cannot shift or
 * counterfeit the receipt identity of a later admitted call.
 */
export function deriveProviderReceiptInvocationId(providerCallIdInput: string): string {
  if (typeof providerCallIdInput !== "string" || !PROVIDER_CALL_ID.test(providerCallIdInput)) {
    return fail("provider call ID is invalid");
  }
  return `provider_call_${sha256Hex(
    `${INVOCATION_ID_DOMAIN}${JSON.stringify(providerCallIdInput)}`
  )}`;
}

function createLinkage(
  input: Readonly<{
    providerCallId: string;
    transcript: string;
    finalAttestation: BenchmarkKernelFinalAttestation;
    attestationExpectation: BenchmarkKernelAttestationExpectation;
  }>
): ProviderReadOnlyReceiptLinkage {
  if (typeof input.providerCallId !== "string") {
    return fail("provider call ID is invalid");
  }
  const providerCallId = input.providerCallId;
  const invocationId = deriveProviderReceiptInvocationId(providerCallId);
  const transcriptVerification = verifyKernelTranscript({
    transcript: input.transcript,
    finalAttestation: input.finalAttestation,
    attestationExpectation: input.attestationExpectation,
  });
  if (
    !transcriptVerification.valid
    || transcriptVerification.authenticity !== "signed_attestation_verified"
    || !transcriptVerification.reference
    || !transcriptVerification.run_id
  ) {
    return fail(
      `kernel transcript is not signed and valid${
        transcriptVerification.errors.length > 0
          ? `: ${transcriptVerification.errors.join("; ")}`
          : ""
      }`
    );
  }

  const transcript = parseKernelTranscript(input.transcript);
  const invokeEntries = transcript.entries.filter(
    (entry): entry is PublicKernelTranscriptEntry & Readonly<{ operation: "invoke" }> =>
      entry.operation === "invoke"
  );
  const seenCallIds = new Set<string>();
  for (const entry of invokeEntries) {
    const callId = invokePayload(entry).input.provider_call_id;
    if (seenCallIds.has(callId)) {
      return fail(`provider call ID "${callId}" was reused`);
    }
    seenCallIds.add(callId);
  }
  const matches = invokeEntries.filter(
    (entry) => invokePayload(entry).input.provider_call_id === providerCallId
  );
  if (matches.length !== 1) {
    return fail(
      matches.length === 0
        ? `provider call ID "${providerCallId}" is absent from the signed transcript`
        : `provider call ID "${providerCallId}" is ambiguous`
    );
  }
  const entry = matches[0];
  const payload = invokePayload(entry);
  if (payload.outcome.result_class !== "success_executed") {
    return fail("provider call was not one freshly executed successful invocation");
  }

  const scenario = BenchmarkScenarioSchema.parse(input.attestationExpectation.scenario);
  const world = parseBoundToolWorldState(scenario, input.attestationExpectation.world);
  const tool = scenario.tools.find((candidate) => candidate.name === payload.input.action);
  if (!tool) return fail("provider call action is not a ToolWorld tool");
  if (tool.kind !== "query" || tool.effects.length !== 0) {
    return fail(`tool "${tool.name}" is not a zero-effect read-only query`);
  }

  const receiptMatches = world.receipts.filter(
    (candidate) => candidate.invocation_id === invocationId
  );
  if (receiptMatches.length !== 1) {
    return fail(
      receiptMatches.length === 0
        ? `signed ToolWorld is missing receipt invocation "${invocationId}"`
        : `signed ToolWorld has duplicate receipt invocation "${invocationId}"`
    );
  }
  const receipt: WorldReceipt = WorldReceiptSchema.parse(receiptMatches[0]);
  if (receipt.tool !== payload.input.action || receipt.turn !== payload.input.turn) {
    return fail("ToolWorld receipt differs from the signed provider call action or turn");
  }
  if (
    receipt.status !== "succeeded"
    || receipt.committed
    || receipt.effect_ids.length !== 0
    || !receipt.admission_id
    || receipt.authoritative_result === undefined
    || !receipt.visible_result.ok
  ) {
    return fail("ToolWorld receipt is not a successful admitted non-committing read");
  }
  if (receipt.tainted_result_paths.length !== 0) {
    return fail("ToolWorld receipt exposes tainted or injection-bearing result paths");
  }
  const expectedReceiptId = `rcpt:${scenario.id}:${invocationId}`;
  if (receipt.receipt_id !== expectedReceiptId) {
    return fail("ToolWorld receipt ID is not derived from the exact provider-call invocation");
  }
  const linkedWorldEffects = world.effects.filter(
    (effect) =>
      effect.receipt_id === receipt.receipt_id
      || effect.invocation_id === receipt.invocation_id
  );
  if (linkedWorldEffects.length !== 0) {
    return fail("read-only receipt is associated with an authoritative world effect");
  }

  const before = payload.pre_state.authoritative_world_head;
  const after = payload.post_state.authoritative_world_head;
  if (
    after.admission_count !== before.admission_count + 1
    || after.receipt_count !== before.receipt_count + 1
    || after.effect_count !== before.effect_count
  ) {
    return fail("signed transcript state deltas do not describe exactly one effect-free read");
  }
  if (input.finalAttestation.bindings.run_id !== transcriptVerification.run_id) {
    return fail("kernel attestation and transcript run identities differ");
  }
  if (
    canonicalJson(input.finalAttestation.transcript_reference as unknown as JsonValue)
    !== canonicalJson(transcriptVerification.reference as unknown as JsonValue)
  ) {
    return fail("kernel attestation signs a different transcript reference");
  }

  const body: LinkageBody = {
    schema_version: 1,
    linkage_type: "provider_read_only_toolworld_receipt",
    run_id: transcriptVerification.run_id,
    provider_call_id: providerCallId,
    transcript_sequence: entry.sequence,
    transcript_entry_sha256: entry.entry_sha256,
    transcript_reference: transcriptVerification.reference,
    kernel_attestation_hash: input.finalAttestation.attestation_hash,
    invocation_id: invocationId,
    receipt_id: receipt.receipt_id,
    receipt_sha256: sha256Hex(canonicalJson(receipt as unknown as JsonValue)),
    tool: receipt.tool,
    turn: receipt.turn,
    safety_proof: {
      tool_kind: "query",
      declared_effect_count: 0,
      committed: false,
      receipt_effect_count: 0,
      world_effect_count: 0,
      tainted_result_path_count: 0,
      outcome_class: "success_executed",
    },
  };
  return immutableJson({
    ...body,
    linkage_sha256: linkageHash(body),
  }) as unknown as ProviderReadOnlyReceiptLinkage;
}

/**
 * Build a portable proof that one exact provider gateway call produced one
 * harmless ToolWorld read in the world head signed by the kernel attestation.
 */
export function createProviderReadOnlyReceiptLinkage(
  input: Readonly<{
    providerCallId: string;
    transcript: string;
    finalAttestation: BenchmarkKernelFinalAttestation;
    attestationExpectation: BenchmarkKernelAttestationExpectation;
  }>
): ProviderReadOnlyReceiptLinkage {
  return createLinkage(input);
}

/** Recompute every field; never trust a persisted linkage's eligibility claim. */
export function verifyProviderReadOnlyReceiptLinkage(
  input: Readonly<{
    linkage: ProviderReadOnlyReceiptLinkage;
    transcript: string;
    finalAttestation: BenchmarkKernelFinalAttestation;
    attestationExpectation: BenchmarkKernelAttestationExpectation;
  }>
): ProviderReadOnlyReceiptLinkageVerification {
  try {
    if (!SHA256.test(input.linkage.linkage_sha256)) {
      return Object.freeze({
        valid: false,
        errors: Object.freeze(["linkage_sha256 is invalid"]),
        expected_linkage_sha256: null,
      });
    }
    const expected = createLinkage({
      providerCallId: input.linkage.provider_call_id,
      transcript: input.transcript,
      finalAttestation: input.finalAttestation,
      attestationExpectation: input.attestationExpectation,
    });
    const valid = canonicalJson(input.linkage as unknown as JsonValue)
      === canonicalJson(expected as unknown as JsonValue);
    return Object.freeze({
      valid,
      errors: Object.freeze(valid ? [] : ["persisted linkage differs from exact recomputation"]),
      expected_linkage_sha256: expected.linkage_sha256,
    });
  } catch (error) {
    return Object.freeze({
      valid: false,
      errors: Object.freeze([
        error instanceof Error ? error.message : "provider receipt linkage verification failed",
      ]),
      expected_linkage_sha256: null,
    });
  }
}

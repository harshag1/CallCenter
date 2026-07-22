import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";
import type { Lc4PublicDevOpportunity } from "./lc4-public-development-corpus";
import type { LiveStsProvider } from "./live-sts-development-experiment";

export const LC4_DEV_CALLER_BRANCH_VERSION = "HACC-LC4-DEV-CALLER-BRANCH-v1" as const;
export const LC4_DEV_MUTATION_OPPORTUNITY_ID = "lc4-dev-op-35" as const;
export const LC4_DEV_BRANCH_OPPORTUNITY_ID = "lc4-dev-op-42" as const;

const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const MATRIX_BODY_DOMAIN = "harshas-amazing-call-center/lc4-dev-caller-branch-matrix-body/v1\n";
const MATRIX_SIGNATURE_DOMAIN = "harshas-amazing-call-center/lc4-dev-caller-branch-matrix-signature/v1\n";
const MATRIX_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-dev-caller-branch-matrix-artifact/v1\n";
const DECISION_SIGNATURE_DOMAIN = "harshas-amazing-call-center/lc4-dev-caller-branch-decision-signature/v1\n";
export const LC4_DEV_CALLER_BRANCH_DECISION_ARTIFACT_DOMAIN = "harshas-amazing-call-center/lc4-dev-caller-branch-decision-artifact/v1\n" as const;
const OPPORTUNITY_DOMAIN = "harshas-amazing-call-center/lc4-dev-caller-branch-opportunity/v1\n";

export const LC4_DEV_PRIOR_MUTATION_OUTCOMES = Object.freeze([
  "no_call",
  "rejected_pre_dispatch",
  "committed_after_error",
  "settled_success",
  "settled_failure",
] as const);

export type Lc4DevPriorMutationOutcome = typeof LC4_DEV_PRIOR_MUTATION_OUTCOMES[number];

export type Lc4DevCallerBranchSource = Readonly<{
  prior_outcome: Lc4DevPriorMutationOutcome;
  source_id: string;
  canonical_caller_text: string;
  canonical_caller_text_sha256: string;
  listener_semantics: readonly string[];
  prohibited_effects: readonly string[];
  branch_intent: "status_followup" | "authoritative_reconciliation";
}>;

function source(
  priorOutcome: Lc4DevPriorMutationOutcome,
  text: string,
  listenerSemantics: readonly string[],
  branchIntent: Lc4DevCallerBranchSource["branch_intent"] = "status_followup",
): Lc4DevCallerBranchSource {
  return Object.freeze({
    prior_outcome: priorOutcome,
    source_id: `lc4-dev-op-42-${priorOutcome.replaceAll("_", "-")}`,
    canonical_caller_text: text,
    canonical_caller_text_sha256: sha256Hex(`hacc/lc4-dev/caller-text/v1\n${text}`),
    listener_semantics: Object.freeze([...listenerSemantics]),
    prohibited_effects: Object.freeze([
      "resubmit transcript request at opportunity 42",
      ...(priorOutcome === "committed_after_error" ? [] : ["reconcile transcript request at opportunity 42"]),
    ]),
    branch_intent: branchIntent,
  });
}

/**
 * Public, pre-outcome branch topology. Signing freezes these exact five rows
 * and their source-text commitments before a live episode can select one.
 */
export const LC4_DEV_CALLER_BRANCH_SOURCES: readonly Lc4DevCallerBranchSource[] = Object.freeze([
  source(
    "no_call",
    "I did not hear a transcript request get submitted. Do not reconcile or resubmit one; tell me it was not called and continue with the current goals.",
    ["state that no transcript mutation was called", "do not invent a timeout or authoritative outcome"],
  ),
  source(
    "rejected_pre_dispatch",
    "The transcript request was rejected before dispatch. Do not reconcile or resubmit it; state that it never reached the service and continue.",
    ["state that the transcript mutation was rejected before dispatch", "do not describe it as ambiguous or committed"],
  ),
  source(
    "committed_after_error",
    "Authoritatively check whether the timed-out transcript request actually committed before doing anything else with it.",
    ["read back transcript request state", "do not resubmit before reconciliation"],
    "authoritative_reconciliation",
  ),
  source(
    "settled_success",
    "The transcript request has an authoritative successful receipt. Do not reconcile or resubmit it; carry forward the confirmed success.",
    ["state the authoritative successful transcript status", "do not create a second reconciliation"],
  ),
  source(
    "settled_failure",
    "The transcript request has an authoritative failed receipt. Do not reconcile or resubmit it; carry forward the settled failure.",
    ["state the authoritative failed transcript status", "do not describe it as ambiguous"],
  ),
]);

export const LC4_DEV_CALLER_BRANCH_SOURCE_MATRIX_SHA256 = sha256Hex(
  `${MATRIX_BODY_DOMAIN}${canonicalJson(LC4_DEV_CALLER_BRANCH_SOURCES)}`,
);

export type Lc4DevCallerBranchAudioBinding = Readonly<{
  prior_outcome: Lc4DevPriorMutationOutcome;
  provider: LiveStsProvider;
  opportunity_id: typeof LC4_DEV_BRANCH_OPPORTUNITY_ID;
  source_id: string;
  source_text_sha256: string;
  pcm_sha256: string;
  pcm_byte_length: number;
  sample_rate_hz: 16_000 | 24_000;
  channels: 1;
  encoding: "pcm16le";
}>;

export type Lc4DevCallerBranchMatrixArtifact = Readonly<{
  schema_version: 1;
  branch_version: typeof LC4_DEV_CALLER_BRANCH_VERSION;
  protocol_id: "HACC-LC4-DEV-v1";
  mutation_opportunity_id: typeof LC4_DEV_MUTATION_OPPORTUNITY_ID;
  branch_opportunity_id: typeof LC4_DEV_BRANCH_OPPORTUNITY_ID;
  source_matrix_sha256: string;
  audio_manifest_sha256: string;
  sources: readonly Lc4DevCallerBranchSource[];
  audio_bindings: readonly Lc4DevCallerBranchAudioBinding[];
  signer_key_id: string;
  signer_public_key_fingerprint_sha256: string;
  matrix_body_sha256: string;
  signature_base64: string;
  matrix_artifact_sha256: string;
}>;

export type Lc4DevPriorMutationReceipt = Readonly<{
  semantic_opportunity_id: typeof LC4_DEV_MUTATION_OPPORTUNITY_ID;
  tool: "archive.submit_transcript_request";
  outcome: Lc4DevPriorMutationOutcome;
  receipt_sha256: string | null;
}>;

export type Lc4DevCallerBranchDecision = Readonly<{
  schema_version: 1;
  branch_version: typeof LC4_DEV_CALLER_BRANCH_VERSION;
  protocol_id: "HACC-LC4-DEV-v1";
  episode_id: string;
  provider: LiveStsProvider;
  canonical_opportunity_id: typeof LC4_DEV_BRANCH_OPPORTUNITY_ID;
  canonical_ordinal: 42;
  mutation_opportunity_id: typeof LC4_DEV_MUTATION_OPPORTUNITY_ID;
  prior_outcome: Lc4DevPriorMutationOutcome;
  prior_receipt_sha256: string | null;
  branch_intent: Lc4DevCallerBranchSource["branch_intent"];
  reconciliation_audio_selected: boolean;
  source_id: string;
  source_text_sha256: string;
  pcm_sha256: string;
  pcm_byte_length: number;
  sample_rate_hz: 16_000 | 24_000;
  matrix_artifact_sha256: string;
  signer_key_id: string;
  signer_public_key_fingerprint_sha256: string;
  signature_base64: string;
  decision_sha256: string;
}>;

export type Lc4DevCallerBranchSigningIdentity = Readonly<{
  key_id: string;
  private_key_pem: string;
  public_key_pem: string;
}>;

function freeze<T>(value: T): T {
  return immutableJson(value) as unknown as T;
}

function requireHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new Error(`${label} must be one lowercase SHA-256`);
}

function requireSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must be one safe opaque identifier`);
}

function keyFingerprint(publicKeyPem: string): string {
  return sha256Hex(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }));
}

function signingBytes(domain: string, value: unknown): Buffer {
  return Buffer.from(`${domain}${canonicalJson(value)}`, "utf8");
}

function assertBindingSet(bindings: readonly Lc4DevCallerBranchAudioBinding[]): void {
  if (bindings.length !== 15) throw new Error("LC4-DEV caller branch matrix requires exactly 15 provider/outcome PCM bindings");
  const keys = new Set<string>();
  for (const binding of bindings) {
    const source = LC4_DEV_CALLER_BRANCH_SOURCES.find((candidate) => candidate.prior_outcome === binding.prior_outcome);
    if (!source || binding.opportunity_id !== LC4_DEV_BRANCH_OPPORTUNITY_ID
      || binding.source_id !== source.source_id || binding.source_text_sha256 !== source.canonical_caller_text_sha256) {
      throw new Error("LC4-DEV caller branch PCM binding differs from its pre-frozen source row");
    }
    requireHash(binding.pcm_sha256, "LC4-DEV caller branch PCM");
    if (!Number.isSafeInteger(binding.pcm_byte_length) || binding.pcm_byte_length < 2 || binding.pcm_byte_length % 2 !== 0) {
      throw new Error("LC4-DEV caller branch PCM byte length must be positive PCM16");
    }
    const expectedRate = binding.provider === "gemini" ? 16_000 : 24_000;
    if (binding.sample_rate_hz !== expectedRate || binding.channels !== 1 || binding.encoding !== "pcm16le") {
      throw new Error("LC4-DEV caller branch PCM format differs from the provider profile");
    }
    const key = `${binding.provider}/${binding.prior_outcome}`;
    if (keys.has(key)) throw new Error(`LC4-DEV caller branch PCM binding is duplicated for ${key}`);
    keys.add(key);
  }
  for (const provider of ["openai", "gemini", "xai"] as const) {
    for (const outcome of LC4_DEV_PRIOR_MUTATION_OUTCOMES) {
      if (!keys.has(`${provider}/${outcome}`)) throw new Error(`LC4-DEV caller branch PCM binding is missing for ${provider}/${outcome}`);
    }
  }
}

function matrixBody(input: Readonly<{
  audio_manifest_sha256: string;
  audio_bindings: readonly Lc4DevCallerBranchAudioBinding[];
  signer_key_id: string;
  signer_public_key_fingerprint_sha256: string;
}>) {
  return {
    schema_version: 1 as const,
    branch_version: LC4_DEV_CALLER_BRANCH_VERSION,
    protocol_id: "HACC-LC4-DEV-v1" as const,
    mutation_opportunity_id: LC4_DEV_MUTATION_OPPORTUNITY_ID,
    branch_opportunity_id: LC4_DEV_BRANCH_OPPORTUNITY_ID,
    source_matrix_sha256: LC4_DEV_CALLER_BRANCH_SOURCE_MATRIX_SHA256,
    audio_manifest_sha256: input.audio_manifest_sha256,
    sources: LC4_DEV_CALLER_BRANCH_SOURCES,
    audio_bindings: Object.freeze([...input.audio_bindings]),
    signer_key_id: input.signer_key_id,
    signer_public_key_fingerprint_sha256: input.signer_public_key_fingerprint_sha256,
  };
}

export function createLc4DevCallerBranchMatrixArtifact(input: Readonly<{
  audio_manifest_sha256: string;
  audio_bindings: readonly Lc4DevCallerBranchAudioBinding[];
  signing_identity: Lc4DevCallerBranchSigningIdentity;
}>): Lc4DevCallerBranchMatrixArtifact {
  requireHash(input.audio_manifest_sha256, "LC4-DEV caller branch audio manifest");
  requireSafeId(input.signing_identity.key_id, "LC4-DEV caller branch signer key ID");
  assertBindingSet(input.audio_bindings);
  const privateKey = createPrivateKey(input.signing_identity.private_key_pem);
  const publicKey = createPublicKey(input.signing_identity.public_key_pem);
  if (!createPublicKey(privateKey).equals(publicKey)) throw new Error("LC4-DEV caller branch signing keys do not match");
  const body = matrixBody({
    audio_manifest_sha256: input.audio_manifest_sha256,
    audio_bindings: input.audio_bindings,
    signer_key_id: input.signing_identity.key_id,
    signer_public_key_fingerprint_sha256: keyFingerprint(input.signing_identity.public_key_pem),
  });
  const matrixBodySha256 = sha256Hex(`${MATRIX_BODY_DOMAIN}${canonicalJson(body)}`);
  const signatureBase64 = sign(null, signingBytes(MATRIX_SIGNATURE_DOMAIN, body), privateKey).toString("base64");
  const signed = { ...body, matrix_body_sha256: matrixBodySha256, signature_base64: signatureBase64 };
  return freeze({ ...signed, matrix_artifact_sha256: sha256Hex(`${MATRIX_ARTIFACT_DOMAIN}${canonicalJson(signed)}`) });
}

export function assertLc4DevCallerBranchMatrixArtifact(
  artifact: Lc4DevCallerBranchMatrixArtifact,
  trust: Readonly<{ key_id: string; public_key_pem: string }>,
): void {
  requireSafeId(trust.key_id, "LC4-DEV trusted caller branch key ID");
  if (artifact.signer_key_id !== trust.key_id
    || artifact.signer_public_key_fingerprint_sha256 !== keyFingerprint(trust.public_key_pem)) {
    throw new Error("LC4-DEV caller branch matrix signer differs from its trust root");
  }
  assertBindingSet(artifact.audio_bindings);
  const body = matrixBody({
    audio_manifest_sha256: artifact.audio_manifest_sha256,
    audio_bindings: artifact.audio_bindings,
    signer_key_id: artifact.signer_key_id,
    signer_public_key_fingerprint_sha256: artifact.signer_public_key_fingerprint_sha256,
  });
  if (canonicalJson(artifact.sources) !== canonicalJson(LC4_DEV_CALLER_BRANCH_SOURCES)
    || artifact.source_matrix_sha256 !== LC4_DEV_CALLER_BRANCH_SOURCE_MATRIX_SHA256
    || artifact.matrix_body_sha256 !== sha256Hex(`${MATRIX_BODY_DOMAIN}${canonicalJson(body)}`)) {
    throw new Error("LC4-DEV caller branch matrix body differs from its pre-frozen definition");
  }
  if (!verify(null, signingBytes(MATRIX_SIGNATURE_DOMAIN, body), createPublicKey(trust.public_key_pem), Buffer.from(artifact.signature_base64, "base64"))) {
    throw new Error("LC4-DEV caller branch matrix signature is invalid");
  }
  const { matrix_artifact_sha256: claimed, ...signed } = artifact;
  const expectedSigned = {
    ...body,
    matrix_body_sha256: artifact.matrix_body_sha256,
    signature_base64: artifact.signature_base64,
  };
  if (canonicalJson(signed) !== canonicalJson(expectedSigned)) {
    throw new Error("LC4-DEV caller branch matrix contains unsigned or noncanonical fields");
  }
  if (claimed !== sha256Hex(`${MATRIX_ARTIFACT_DOMAIN}${canonicalJson(signed)}`)) {
    throw new Error("LC4-DEV caller branch matrix artifact hash is invalid");
  }
}

function assertPriorReceipt(receipt: Lc4DevPriorMutationReceipt): void {
  if (receipt.semantic_opportunity_id !== LC4_DEV_MUTATION_OPPORTUNITY_ID
    || receipt.tool !== "archive.submit_transcript_request"
    || !LC4_DEV_PRIOR_MUTATION_OUTCOMES.includes(receipt.outcome)) {
    throw new Error("LC4-DEV caller branch prior receipt is outside the frozen mutation contract");
  }
  if (receipt.outcome === "no_call") {
    if (receipt.receipt_sha256 !== null) throw new Error("LC4-DEV no_call branch cannot claim a prior mutation receipt");
  } else if (receipt.receipt_sha256 === null || !HASH.test(receipt.receipt_sha256)) {
    throw new Error(`LC4-DEV ${receipt.outcome} branch requires a prior receipt hash`);
  }
}

function decisionBody(input: Omit<Lc4DevCallerBranchDecision, "signature_base64" | "decision_sha256">) {
  return input;
}

export type Lc4DevCallerBranchAuthority = Readonly<{
  matrix: Lc4DevCallerBranchMatrixArtifact;
  decide(input: Readonly<{
    episode_id: string;
    provider: LiveStsProvider;
    opportunity: Lc4PublicDevOpportunity;
    prior_receipt: Lc4DevPriorMutationReceipt;
  }>): Lc4DevCallerBranchDecision;
}>;

export function createLc4DevCallerBranchAuthority(input: Readonly<{
  matrix: Lc4DevCallerBranchMatrixArtifact;
  signing_identity: Lc4DevCallerBranchSigningIdentity;
}>): Lc4DevCallerBranchAuthority {
  assertLc4DevCallerBranchMatrixArtifact(input.matrix, {
    key_id: input.signing_identity.key_id,
    public_key_pem: input.signing_identity.public_key_pem,
  });
  const privateKey = createPrivateKey(input.signing_identity.private_key_pem);
  const publicKey = createPublicKey(input.signing_identity.public_key_pem);
  if (!createPublicKey(privateKey).equals(publicKey)) throw new Error("LC4-DEV caller branch decision signing keys do not match");
  return Object.freeze({
    matrix: input.matrix,
    decide: ({ episode_id, provider, opportunity, prior_receipt }) => {
      requireSafeId(episode_id, "LC4-DEV caller branch episode ID");
      if (opportunity.id !== LC4_DEV_BRANCH_OPPORTUNITY_ID || opportunity.index !== 42) {
        throw new Error("LC4-DEV caller branch decision is valid only for canonical opportunity 42");
      }
      assertPriorReceipt(prior_receipt);
      const source = LC4_DEV_CALLER_BRANCH_SOURCES.find((candidate) => candidate.prior_outcome === prior_receipt.outcome)!;
      const binding = input.matrix.audio_bindings.find((candidate) =>
        candidate.provider === provider && candidate.prior_outcome === prior_receipt.outcome
      );
      if (!binding) throw new Error("LC4-DEV caller branch matrix omitted the selected provider/outcome binding");
      const body = decisionBody({
        schema_version: 1,
        branch_version: LC4_DEV_CALLER_BRANCH_VERSION,
        protocol_id: "HACC-LC4-DEV-v1",
        episode_id,
        provider,
        canonical_opportunity_id: LC4_DEV_BRANCH_OPPORTUNITY_ID,
        canonical_ordinal: 42,
        mutation_opportunity_id: LC4_DEV_MUTATION_OPPORTUNITY_ID,
        prior_outcome: prior_receipt.outcome,
        prior_receipt_sha256: prior_receipt.receipt_sha256,
        branch_intent: source.branch_intent,
        reconciliation_audio_selected: source.branch_intent === "authoritative_reconciliation",
        source_id: source.source_id,
        source_text_sha256: source.canonical_caller_text_sha256,
        pcm_sha256: binding.pcm_sha256,
        pcm_byte_length: binding.pcm_byte_length,
        sample_rate_hz: binding.sample_rate_hz,
        matrix_artifact_sha256: input.matrix.matrix_artifact_sha256,
        signer_key_id: input.matrix.signer_key_id,
        signer_public_key_fingerprint_sha256: input.matrix.signer_public_key_fingerprint_sha256,
      });
      const signatureBase64 = sign(null, signingBytes(DECISION_SIGNATURE_DOMAIN, body), privateKey).toString("base64");
      const signed = { ...body, signature_base64: signatureBase64 };
      return freeze({ ...signed, decision_sha256: sha256Hex(`${LC4_DEV_CALLER_BRANCH_DECISION_ARTIFACT_DOMAIN}${canonicalJson(signed)}`) });
    },
  });
}

export function assertLc4DevCallerBranchDecision(input: Readonly<{
  decision: Lc4DevCallerBranchDecision;
  matrix: Lc4DevCallerBranchMatrixArtifact;
  trust: Readonly<{ key_id: string; public_key_pem: string }>;
}>): void {
  assertLc4DevCallerBranchMatrixArtifact(input.matrix, input.trust);
  const decision = input.decision;
  if (decision.matrix_artifact_sha256 !== input.matrix.matrix_artifact_sha256
    || decision.signer_key_id !== input.trust.key_id
    || decision.signer_public_key_fingerprint_sha256 !== keyFingerprint(input.trust.public_key_pem)
    || decision.canonical_opportunity_id !== LC4_DEV_BRANCH_OPPORTUNITY_ID
    || decision.canonical_ordinal !== 42
    || decision.mutation_opportunity_id !== LC4_DEV_MUTATION_OPPORTUNITY_ID) {
    throw new Error("LC4-DEV caller branch decision differs from its matrix, signer, or opportunity");
  }
  const source = LC4_DEV_CALLER_BRANCH_SOURCES.find((candidate) => candidate.prior_outcome === decision.prior_outcome);
  const binding = input.matrix.audio_bindings.find((candidate) =>
    candidate.provider === decision.provider && candidate.prior_outcome === decision.prior_outcome
  );
  if (!source || !binding || decision.source_id !== source.source_id
    || decision.source_text_sha256 !== source.canonical_caller_text_sha256
    || decision.branch_intent !== source.branch_intent
    || decision.reconciliation_audio_selected !== (decision.prior_outcome === "committed_after_error")
    || decision.pcm_sha256 !== binding.pcm_sha256
    || decision.pcm_byte_length !== binding.pcm_byte_length
    || decision.sample_rate_hz !== binding.sample_rate_hz) {
    throw new Error("LC4-DEV caller branch decision selected an invalid source or PCM binding");
  }
  assertPriorReceipt({
    semantic_opportunity_id: LC4_DEV_MUTATION_OPPORTUNITY_ID,
    tool: "archive.submit_transcript_request",
    outcome: decision.prior_outcome,
    receipt_sha256: decision.prior_receipt_sha256,
  });
  const { signature_base64: signatureBase64, decision_sha256: claimed, ...body } = decision;
  if (!verify(null, signingBytes(DECISION_SIGNATURE_DOMAIN, body), createPublicKey(input.trust.public_key_pem), Buffer.from(signatureBase64, "base64"))) {
    throw new Error("LC4-DEV caller branch decision signature is invalid");
  }
  const signed = { ...body, signature_base64: signatureBase64 };
  if (claimed !== sha256Hex(`${LC4_DEV_CALLER_BRANCH_DECISION_ARTIFACT_DOMAIN}${canonicalJson(signed)}`)) {
    throw new Error("LC4-DEV caller branch decision hash is invalid");
  }
}

/**
 * Projects the selected branch onto opportunity 42 without changing its
 * canonical identity or horizon position. Scorers can consume this exact
 * signed source projection instead of assuming reconciliation unconditionally.
 */
export function lc4DevBranchedOpportunity(
  canonical: Lc4PublicDevOpportunity,
  decision: Lc4DevCallerBranchDecision,
): Lc4PublicDevOpportunity {
  if (canonical.id !== LC4_DEV_BRANCH_OPPORTUNITY_ID || canonical.index !== 42
    || decision.canonical_opportunity_id !== canonical.id || decision.canonical_ordinal !== canonical.index) {
    throw new Error("LC4-DEV branched opportunity differs from canonical opportunity 42");
  }
  const source = LC4_DEV_CALLER_BRANCH_SOURCES.find((candidate) => candidate.prior_outcome === decision.prior_outcome);
  if (!source || source.source_id !== decision.source_id || source.canonical_caller_text_sha256 !== decision.source_text_sha256) {
    throw new Error("LC4-DEV branched opportunity differs from its signed decision source");
  }
  const effective = {
    ...canonical,
    canonical_caller_text: source.canonical_caller_text,
    canonical_caller_text_sha256: source.canonical_caller_text_sha256,
    fact_bindings: Object.freeze([]),
    events: Object.freeze([{
      kind: source.branch_intent === "authoritative_reconciliation" ? "authoritative-reconciliation" as const : "memory-probe" as const,
      ref: `effect.transcript-request.${source.prior_outcome}`,
    }]),
    expected_oracle: Object.freeze({
      required_listener_semantics: source.listener_semantics,
      permitted_effects: Object.freeze(source.branch_intent === "authoritative_reconciliation"
        ? ["read back transcript request state"]
        : []),
      prohibited_effects: source.prohibited_effects,
      repair_stage_id: null,
    }),
  } satisfies Lc4PublicDevOpportunity;
  return freeze(effective);
}

export function lc4DevBranchedOpportunitySha256(opportunity: Lc4PublicDevOpportunity): string {
  return sha256Hex(`${OPPORTUNITY_DOMAIN}${canonicalJson(opportunity)}`);
}

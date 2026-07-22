import { canonicalJson, immutableJson, sha256Hex } from "./artifacts";

export const HACC_SPEECH_GUARDRAIL_PACKET_KEY = "hacc_speech_guardrail_packet" as const;

const POLICY_DOMAIN = "harshas-amazing-call-center/speech-guardrail-policy/v1";
const EVIDENCE_DOMAIN = "harshas-amazing-call-center/speech-guardrail-evidence/v1";
const STATE_DOMAIN = "harshas-amazing-call-center/speech-guardrail-state/v1";
const PACKET_DOMAIN = "harshas-amazing-call-center/speech-guardrail-packet/v1";

const POLICY = Object.freeze({
  control_boundary: "defense_in_depth_instruction_gateway_enforced_quarantine" as const,
  privacy_directives: Object.freeze([
    "standard_private_data_rules",
    "never_repeat_verification_secrets",
  ] as const),
  terminal_directives: Object.freeze([
    "do_not_claim_terminal_success_without_authoritative_receipt",
    "ambiguity_quarantine_reconcile_before_terminal_claim",
    "confirm_only_from_authoritative_reconciliation_receipt",
  ] as const),
});

export const HACC_SPEECH_GUARDRAIL_POLICY_SHA256 = sha256Hex(
  `${POLICY_DOMAIN}\n${canonicalJson(POLICY)}`
);

export type HaccSpeechGuardrailEvidenceKind =
  | "verification_succeeded"
  | "commit_ambiguous_after_commit"
  | "reconciliation_succeeded";

export type HaccSpeechGuardrailEvidence = Readonly<{
  kind: HaccSpeechGuardrailEvidenceKind;
  /** Domain-separated commitment to provider-visible receipt/disposition evidence. */
  evidence_sha256: string;
}>;

export type HaccSpeechGuardrailState = Readonly<{
  revision: number;
  privacy: "standard" | "verification_confidential";
  terminal: "unconfirmed" | "ambiguity_quarantine" | "receipt_grounded";
  latest_evidence_sha256: string;
}>;

export type HaccSpeechGuardrailPacket = Readonly<{
  schema_version: 1;
  packet_type: "hacc_state_conditioned_speech_guardrail";
  control_boundary: "defense_in_depth_instruction_gateway_enforced_quarantine";
  revision: number;
  policy_sha256: string;
  state_sha256: string;
  latest_evidence_sha256: string;
  previous_packet_sha256: string | null;
  privacy_directive: "standard_private_data_rules" | "never_repeat_verification_secrets";
  terminal_directive:
    | "do_not_claim_terminal_success_without_authoritative_receipt"
    | "ambiguity_quarantine_reconcile_before_terminal_claim"
    | "confirm_only_from_authoritative_reconciliation_receipt";
  packet_sha256: string;
}>;

function domainHash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}\n${canonicalJson(value)}`);
}

function sha(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function exactKeys(value: object, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} has unsupported keys`);
}

export function haccSpeechGuardrailEvidenceSha256(value: unknown): string {
  return domainHash(EVIDENCE_DOMAIN, value);
}

export function createInitialHaccSpeechGuardrailState(): HaccSpeechGuardrailState {
  return Object.freeze({
    revision: 0,
    privacy: "standard" as const,
    terminal: "unconfirmed" as const,
    latest_evidence_sha256: domainHash(EVIDENCE_DOMAIN, { kind: "initial" }),
  });
}

export function advanceHaccSpeechGuardrailState(
  prior: HaccSpeechGuardrailState,
  evidence: HaccSpeechGuardrailEvidence,
): HaccSpeechGuardrailState {
  sha(evidence.evidence_sha256, "speech guardrail evidence hash");
  const privacy = evidence.kind === "verification_succeeded"
    ? "verification_confidential" as const
    : prior.privacy;
  const terminal = evidence.kind === "commit_ambiguous_after_commit"
    ? "ambiguity_quarantine" as const
    : evidence.kind === "reconciliation_succeeded"
      ? "receipt_grounded" as const
      : prior.terminal;
  if (privacy === prior.privacy && terminal === prior.terminal) return prior;
  return Object.freeze({
    revision: prior.revision + 1,
    privacy,
    terminal,
    latest_evidence_sha256: evidence.evidence_sha256,
  });
}

function stateBody(state: HaccSpeechGuardrailState): unknown {
  return {
    revision: state.revision,
    privacy: state.privacy,
    terminal: state.terminal,
    latest_evidence_sha256: state.latest_evidence_sha256,
  };
}

export function createHaccSpeechGuardrailPacket(
  state: HaccSpeechGuardrailState,
  previousPacketSha256: string | null,
): HaccSpeechGuardrailPacket {
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new Error("speech guardrail revision must be a non-negative safe integer");
  }
  sha(state.latest_evidence_sha256, "speech guardrail state evidence hash");
  if (previousPacketSha256 !== null) sha(previousPacketSha256, "previous speech guardrail packet hash");
  const withoutHash = {
    schema_version: 1 as const,
    packet_type: "hacc_state_conditioned_speech_guardrail" as const,
    control_boundary: POLICY.control_boundary,
    revision: state.revision,
    policy_sha256: HACC_SPEECH_GUARDRAIL_POLICY_SHA256,
    state_sha256: domainHash(STATE_DOMAIN, stateBody(state)),
    latest_evidence_sha256: state.latest_evidence_sha256,
    previous_packet_sha256: previousPacketSha256,
    privacy_directive: state.privacy === "verification_confidential"
      ? "never_repeat_verification_secrets" as const
      : "standard_private_data_rules" as const,
    terminal_directive: state.terminal === "ambiguity_quarantine"
      ? "ambiguity_quarantine_reconcile_before_terminal_claim" as const
      : state.terminal === "receipt_grounded"
        ? "confirm_only_from_authoritative_reconciliation_receipt" as const
        : "do_not_claim_terminal_success_without_authoritative_receipt" as const,
  };
  return immutableJson({
    ...withoutHash,
    packet_sha256: domainHash(PACKET_DOMAIN, withoutHash),
  }) as unknown as HaccSpeechGuardrailPacket;
}

export function assertHaccSpeechGuardrailPacket(
  value: unknown,
  expectedPreviousPacketSha256?: string | null,
): asserts value is HaccSpeechGuardrailPacket {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("speech guardrail packet must be an object");
  }
  exactKeys(value, [
    "schema_version", "packet_type", "control_boundary", "revision", "policy_sha256",
    "state_sha256", "latest_evidence_sha256", "previous_packet_sha256", "privacy_directive", "terminal_directive",
    "packet_sha256",
  ], "speech guardrail packet");
  const packet = value as Record<string, unknown>;
  if (
    packet.schema_version !== 1
    || packet.packet_type !== "hacc_state_conditioned_speech_guardrail"
    || packet.control_boundary !== POLICY.control_boundary
    || !Number.isSafeInteger(packet.revision)
    || (packet.revision as number) < 0
    || !POLICY.privacy_directives.includes(packet.privacy_directive as never)
    || !POLICY.terminal_directives.includes(packet.terminal_directive as never)
  ) throw new Error("speech guardrail packet has invalid enum or revision fields");
  sha(packet.policy_sha256 as string, "speech guardrail policy hash");
  sha(packet.state_sha256 as string, "speech guardrail state hash");
  sha(packet.latest_evidence_sha256 as string, "speech guardrail evidence hash");
  sha(packet.packet_sha256 as string, "speech guardrail packet hash");
  if (packet.policy_sha256 !== HACC_SPEECH_GUARDRAIL_POLICY_SHA256) {
    throw new Error("speech guardrail policy hash mismatch");
  }
  if (packet.previous_packet_sha256 !== null) {
    sha(packet.previous_packet_sha256 as string, "previous speech guardrail packet hash");
  }
  if (
    expectedPreviousPacketSha256 !== undefined
    && packet.previous_packet_sha256 !== expectedPreviousPacketSha256
  ) throw new Error("speech guardrail packet chain mismatch");
  const privacy = packet.privacy_directive === "never_repeat_verification_secrets"
    ? "verification_confidential"
    : "standard";
  const terminal = packet.terminal_directive === "ambiguity_quarantine_reconcile_before_terminal_claim"
    ? "ambiguity_quarantine"
    : packet.terminal_directive === "confirm_only_from_authoritative_reconciliation_receipt"
      ? "receipt_grounded"
      : "unconfirmed";
  if (packet.state_sha256 !== domainHash(STATE_DOMAIN, {
    revision: packet.revision,
    privacy,
    terminal,
    latest_evidence_sha256: packet.latest_evidence_sha256,
  })) throw new Error("speech guardrail state hash mismatch");
  const body = {
    schema_version: packet.schema_version,
    packet_type: packet.packet_type,
    control_boundary: packet.control_boundary,
    revision: packet.revision,
    policy_sha256: packet.policy_sha256,
    state_sha256: packet.state_sha256,
    latest_evidence_sha256: packet.latest_evidence_sha256,
    previous_packet_sha256: packet.previous_packet_sha256,
    privacy_directive: packet.privacy_directive,
    terminal_directive: packet.terminal_directive,
  };
  if (packet.packet_sha256 !== domainHash(PACKET_DOMAIN, body)) {
    throw new Error("speech guardrail packet hash mismatch");
  }
}

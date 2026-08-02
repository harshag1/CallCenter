import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
  type KeyLike,
} from "node:crypto";
import { canonicalJson, immutableJson, sha256Hex, type JsonValue } from "../../artifacts";
import { getDevelopmentCallerTemplate } from "./corpus";
import type {
  ArmBlindCallerObservation,
  CallerAdvanceResult,
  CallerCandidate,
  CallerFactLedgerEntry,
  CallerObservationEvidenceBinding,
  CallerSelectionLedgerEntry,
  CallerSigningAuthority,
  CallerVerificationAuthority,
  ClosedLoopCallerState,
  DevelopmentCorpus,
  DevelopmentTemplate,
  LedgerSignature,
  PlayedAudioSemantic,
  SignedArmBlindCallerObservation,
  SignedCallerLedgers,
} from "./types";

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/;
const SELECTION_ENTRY_DOMAIN = "harshas-amazing-call-center/proof-v1/caller-selection-entry/v2\n";
const FACT_ENTRY_DOMAIN = "harshas-amazing-call-center/proof-v1/caller-fact-entry/v2\n";
const OBSERVATION_DOMAIN = "harshas-amazing-call-center/proof-v1/arm-blind-caller-observation/v2\n";
const SELECTION_LEDGER_DOMAIN = "harshas-amazing-call-center/proof-v1/caller-selection-ledger/v2\n";
const FACT_LEDGER_DOMAIN = "harshas-amazing-call-center/proof-v1/caller-fact-ledger/v2\n";
const SIGNING_DOMAIN = "harshas-amazing-call-center/proof-v1/caller-ledger-signature/v2\n";
const FACT_VALUE_DOMAIN = "harshas-amazing-call-center/proof-v1/caller-fact-value/v2\n";
const OBSERVATION_RECEIPT_DOMAIN = "harshas-amazing-call-center/proof-v1/caller-observation-receipt/v2\n";
const AUDIBILITY_PROJECTION_DOMAIN = "harshas-amazing-call-center/proof-v1/caller-audibility-projection/v2\n";
const WORLD_PROJECTION_DOMAIN = "harshas-amazing-call-center/proof-v1/caller-world-projection/v2\n";
export const MAXIMUM_CALLER_REPAIR_SELECTIONS = 4 as const;

const SELECTION_ENTRY_KEYS = Object.freeze([
  "candidate_id", "entry_sha256", "input_projection_sha256", "observation_receipt",
  "opportunity_id", "path", "previous_entry_sha256", "schema_version", "selected_at",
  "sequence", "utterance_sha256",
].sort());
const FACT_ENTRY_KEYS = Object.freeze([
  "entry_sha256", "fact_id", "previous_entry_sha256", "revision", "schema_version",
  "sequence", "source_opportunity_id", "source_selection_entry_sha256", "supersedes_value_sha256", "value",
].sort());
const OBSERVATION_RECEIPT_KEYS = Object.freeze([
  "corpus_sha256", "opportunity_id", "payload_sha256", "projection", "projection_sha256",
  "run_id", "schema_version", "selection_sequence", "signature", "source_evidence",
  "template_id", "template_sha256",
].sort());
const OBSERVATION_SOURCE_KEYS = Object.freeze([
  "audibility_ledger_head_sha256", "audibility_projection_sha256",
  "world_ledger_head_sha256", "world_projection_sha256",
].sort());
const LEDGER_KEYS = Object.freeze([
  "chain_head_sha256", "corpus_sha256", "entries", "entry_count", "ledger_kind",
  "payload_sha256", "run_id", "schedule_status", "schema_version", "signature",
  "template_id", "template_sha256",
].sort());

function hasExactlyKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${label} is invalid`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
      || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
}

function projectPlayedSemantics(value: unknown): readonly PlayedAudioSemantic[] {
  if (!Array.isArray(value)) throw new Error("listener.played_audio_semantics must be an array");
  const projected = value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`played_audio_semantics[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    assertId(record.semantic_id, `played_audio_semantics[${index}].semantic_id`);
    assertId(record.playback_range_id, `played_audio_semantics[${index}].playback_range_id`);
    if (record.disposition !== "heard" && record.disposition !== "not_heard" && record.disposition !== "unverifiable") {
      throw new Error(`played_audio_semantics[${index}].disposition is invalid`);
    }
    if (typeof record.played_audio_sha256 !== "string" || !SHA256.test(record.played_audio_sha256)) {
      throw new Error(`played_audio_semantics[${index}].played_audio_sha256 is invalid`);
    }
    return {
      semantic_id: record.semantic_id,
      disposition: record.disposition,
      playback_range_id: record.playback_range_id,
      played_audio_sha256: record.played_audio_sha256,
    } satisfies PlayedAudioSemantic;
  });
  projected.sort((left, right) => {
    const leftCanonical = canonicalJson(left);
    const rightCanonical = canonicalJson(right);
    return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0;
  });
  const identities = projected.map((item) => `${item.semantic_id}\n${item.playback_range_id}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error("listener.played_audio_semantics contains duplicate semantic/range identities");
  }
  return immutableJson(projected) as unknown as readonly PlayedAudioSemantic[];
}

/**
 * Project an untrusted runner envelope onto the only information the caller is
 * allowed to observe. Top-level arm labels, prompts, grants, scores, provider
 * events, and private runtime state are intentionally neither copied nor read.
 */
export function projectArmBlindCallerObservation(
  template: DevelopmentTemplate,
  untrusted: unknown,
): ArmBlindCallerObservation {
  if (untrusted === null || typeof untrusted !== "object" || Array.isArray(untrusted)) {
    throw new Error("caller observation must be an object");
  }
  const envelope = untrusted as Record<string, unknown>;
  if (envelope.schema_version !== 1) throw new Error("caller observation schema_version must be 1");
  if (envelope.listener === null || typeof envelope.listener !== "object" || Array.isArray(envelope.listener)) {
    throw new Error("caller observation listener must be an object");
  }
  if (envelope.world === null || typeof envelope.world !== "object" || Array.isArray(envelope.world)) {
    throw new Error("caller observation world must be an object");
  }
  const listener = envelope.listener as Record<string, unknown>;
  const world = envelope.world as Record<string, unknown>;
  if (world.facts === null || typeof world.facts !== "object" || Array.isArray(world.facts)) {
    throw new Error("caller observation world.facts must be an object");
  }
  const rawFacts = world.facts as Record<string, unknown>;
  const facts: Record<string, JsonValue> = {};
  for (const key of template.permitted_world_fact_keys) {
    if (Object.prototype.hasOwnProperty.call(rawFacts, key)) {
      facts[key] = immutableJson(rawFacts[key]);
    }
  }
  return immutableJson({
    schema_version: 1,
    listener: { played_audio_semantics: projectPlayedSemantics(listener.played_audio_semantics) },
    world: { facts },
  }) as ArmBlindCallerObservation;
}

export function createClosedLoopCallerState(input: Readonly<{
  corpus: DevelopmentCorpus;
  template_id: string;
  run_id: string;
}>): ClosedLoopCallerState {
  assertId(input.run_id, "run_id");
  const template = getDevelopmentCallerTemplate(input.corpus, input.template_id);
  return immutableJson({
    schema_version: 1,
    run_id: input.run_id,
    corpus_sha256: input.corpus.corpus_sha256,
    template_id: template.template_id,
    template_sha256: template.template_sha256,
    next_opportunity_index: 0,
    selection_entries: [],
    fact_entries: [],
  }) as ClosedLoopCallerState;
}

function hashEntry(domain: string, body: unknown): string {
  return sha256Hex(`${domain}${canonicalJson(body)}`);
}

function assertEvidenceBinding(
  value: CallerObservationEvidenceBinding,
  projection?: ArmBlindCallerObservation,
): void {
  if (!hasExactlyKeys(value, OBSERVATION_SOURCE_KEYS)) {
    throw new Error("caller observation source evidence fields are invalid");
  }
  for (const [key, digest] of Object.entries(value)) {
    if (typeof digest !== "string" || !SHA256.test(digest)) {
      throw new Error(`caller observation ${key} must be a SHA-256 digest`);
    }
  }
  if (projection) {
    const expectedAudibility = sha256Hex(`${AUDIBILITY_PROJECTION_DOMAIN}${canonicalJson(projection.listener)}`);
    const expectedWorld = sha256Hex(`${WORLD_PROJECTION_DOMAIN}${canonicalJson(projection.world)}`);
    if (value.audibility_projection_sha256 !== expectedAudibility) {
      throw new Error("caller observation audibility projection does not match its source-evidence digest");
    }
    if (value.world_projection_sha256 !== expectedWorld) {
      throw new Error("caller observation world projection does not match its source-evidence digest");
    }
  }
}

export function createSignedArmBlindCallerObservation(input: Readonly<{
  corpus: DevelopmentCorpus;
  state: ClosedLoopCallerState;
  untrusted_observation: unknown;
  source_ledger_heads: Readonly<{
    audibility_ledger_head_sha256: string;
    world_ledger_head_sha256: string;
  }>;
  signing_authority: CallerSigningAuthority;
  prior_observation_verification_authority: CallerVerificationAuthority;
}>): SignedArmBlindCallerObservation {
  assertCallerStateIntegrity(
    input.corpus,
    input.state,
    input.prior_observation_verification_authority,
  );
  const template = getDevelopmentCallerTemplate(input.corpus, input.state.template_id);
  const opportunity = template.opportunities[input.state.next_opportunity_index];
  if (!opportunity) throw new Error("cannot sign a caller observation after the common schedule is complete");
  const projection = projectArmBlindCallerObservation(template, input.untrusted_observation);
  if (!SHA256.test(input.source_ledger_heads.audibility_ledger_head_sha256)
      || !SHA256.test(input.source_ledger_heads.world_ledger_head_sha256)) {
    throw new Error("caller observation source ledger heads must be SHA-256 digests");
  }
  const sourceEvidence: CallerObservationEvidenceBinding = Object.freeze({
    audibility_projection_sha256: sha256Hex(`${AUDIBILITY_PROJECTION_DOMAIN}${canonicalJson(projection.listener)}`),
    audibility_ledger_head_sha256: input.source_ledger_heads.audibility_ledger_head_sha256,
    world_projection_sha256: sha256Hex(`${WORLD_PROJECTION_DOMAIN}${canonicalJson(projection.world)}`),
    world_ledger_head_sha256: input.source_ledger_heads.world_ledger_head_sha256,
  });
  assertEvidenceBinding(sourceEvidence, projection);
  const body = {
    schema_version: 1 as const,
    run_id: input.state.run_id,
    corpus_sha256: input.state.corpus_sha256,
    template_id: input.state.template_id,
    template_sha256: input.state.template_sha256,
    opportunity_id: opportunity.opportunity_id,
    selection_sequence: input.state.selection_entries.length,
    projection,
    projection_sha256: sha256Hex(`${OBSERVATION_DOMAIN}${canonicalJson(projection)}`),
    source_evidence: sourceEvidence,
  };
  return immutableJson({
    ...body,
    ...signLedgerBody(body, OBSERVATION_RECEIPT_DOMAIN, input.signing_authority),
  }) as SignedArmBlindCallerObservation;
}

function verifySignedArmBlindCallerObservationUnchecked(input: Readonly<{
  corpus: DevelopmentCorpus;
  receipt: SignedArmBlindCallerObservation;
  verification_authority: CallerVerificationAuthority;
  expected_run_id: string;
  expected_template_id: string;
  expected_opportunity_id: string;
  expected_selection_sequence: number;
}>): Readonly<{ valid: boolean; errors: readonly string[] }> {
  const errors: string[] = [];
  const receipt = input.receipt as unknown as Record<string, unknown>;
  if (!hasExactlyKeys(receipt, OBSERVATION_RECEIPT_KEYS)) {
    errors.push("caller observation receipt fields differ from the closed schema");
  }
  const template = input.corpus.templates.find((item) => item.template_id === input.expected_template_id);
  if (!template) errors.push("caller observation template is absent from the frozen corpus");
  if (receipt.schema_version !== 1
      || receipt.run_id !== input.expected_run_id
      || receipt.corpus_sha256 !== input.corpus.corpus_sha256
      || receipt.template_id !== input.expected_template_id
      || receipt.template_sha256 !== template?.template_sha256
      || receipt.opportunity_id !== input.expected_opportunity_id
      || receipt.selection_sequence !== input.expected_selection_sequence) {
    errors.push("caller observation receipt identity mismatch");
  }
  if (receipt.source_evidence === null || typeof receipt.source_evidence !== "object"
      || Array.isArray(receipt.source_evidence)) {
    errors.push("caller observation source evidence is missing");
  } else {
    try {
      assertEvidenceBinding(
        receipt.source_evidence as CallerObservationEvidenceBinding,
        receipt.projection as ArmBlindCallerObservation,
      );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "caller observation source evidence is invalid");
    }
  }
  if (!template || receipt.projection === null || typeof receipt.projection !== "object"
      || Array.isArray(receipt.projection)) {
    errors.push("caller observation projection is missing");
  } else {
    const canonicalProjection = projectArmBlindCallerObservation(template, receipt.projection);
    if (canonicalJson(canonicalProjection) !== canonicalJson(receipt.projection)) {
      errors.push("caller observation projection contains non-observable fields");
    }
    const expectedProjectionSha256 = sha256Hex(`${OBSERVATION_DOMAIN}${canonicalJson(canonicalProjection)}`);
    if (receipt.projection_sha256 !== expectedProjectionSha256) {
      errors.push("caller observation projection digest mismatch");
    }
  }
  verifyLedgerSignature(
    receipt,
    OBSERVATION_RECEIPT_DOMAIN,
    input.verification_authority,
    errors,
    "caller observation receipt",
  );
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function verifySignedArmBlindCallerObservation(input: Readonly<{
  corpus: DevelopmentCorpus;
  receipt: SignedArmBlindCallerObservation;
  verification_authority: CallerVerificationAuthority;
  expected_run_id: string;
  expected_template_id: string;
  expected_opportunity_id: string;
  expected_selection_sequence: number;
}>): Readonly<{ valid: boolean; errors: readonly string[] }> {
  try {
    return verifySignedArmBlindCallerObservationUnchecked(input);
  } catch (error) {
    return Object.freeze({
      valid: false,
      errors: Object.freeze([error instanceof Error ? error.message : "caller observation verification failed"]),
    });
  }
}

function candidateForEntry(
  template: DevelopmentTemplate,
  entry: CallerSelectionLedgerEntry,
  opportunityIndex: number,
): CallerCandidate | null {
  const opportunity = template.opportunities[opportunityIndex];
  if (!opportunity || opportunity.opportunity_id !== entry.opportunity_id) return null;
  return Object.values(opportunity.candidates).find(
    (candidate): candidate is CallerCandidate => candidate?.candidate_id === entry.candidate_id,
  ) ?? null;
}

function callerStateIntegrityErrors(
  corpus: DevelopmentCorpus,
  state: ClosedLoopCallerState,
  observationAuthority: CallerVerificationAuthority,
): readonly string[] {
  const errors: string[] = [];
  if (state.schema_version !== 1) errors.push("caller state schema version is invalid");
  try {
    assertId(state.run_id, "caller state run_id");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "caller state run_id is invalid");
  }
  if (state.corpus_sha256 !== corpus.corpus_sha256) errors.push("caller state corpus commitment mismatch");
  const template = corpus.templates.find((item) => item.template_id === state.template_id);
  if (!template) return Object.freeze([...errors, "caller state template is absent from the frozen corpus"]);
  if (state.template_sha256 !== template.template_sha256) errors.push("caller state template commitment mismatch");
  if (!Number.isSafeInteger(state.next_opportunity_index)
      || state.next_opportunity_index < 0
      || state.next_opportunity_index > template.opportunities.length) {
    errors.push("caller state opportunity index is outside the frozen schedule");
  }

  verifyEntryChain(
    state.selection_entries as unknown as readonly Record<string, unknown>[],
    SELECTION_ENTRY_DOMAIN,
    errors,
    "caller_selections",
  );
  verifyEntryChain(
    state.fact_entries as unknown as readonly Record<string, unknown>[],
    FACT_ENTRY_DOMAIN,
    errors,
    "caller_fact_ledger",
  );

  const expectedFacts: Array<Readonly<{
    assertion: CallerCandidate["fact_assertions"][number];
    opportunity_id: CallerSelectionLedgerEntry["opportunity_id"];
    selection_sha256: string;
  }>> = [];
  let replayedOpportunityIndex = 0;
  let repairSelectionCount = 0;
  let priorSelectedAtMs = -Infinity;
  for (const [index, entry] of state.selection_entries.entries()) {
    if (entry.sequence !== index) continue;
    const candidate = candidateForEntry(template, entry, replayedOpportunityIndex);
    if (!candidate) {
      errors.push(`caller_selections[${index}] is not a frozen candidate for its common opportunity`);
      continue;
    }
    if (entry.path !== candidate.path || entry.utterance_sha256 !== candidate.utterance_sha256) {
      errors.push(`caller_selections[${index}] candidate projection differs from the frozen template`);
    }
    if (!SHA256.test(entry.input_projection_sha256)) {
      errors.push(`caller_selections[${index}] input projection hash is invalid`);
    }
    const observationVerification = verifySignedArmBlindCallerObservation({
      corpus,
      receipt: entry.observation_receipt,
      verification_authority: observationAuthority,
      expected_run_id: state.run_id,
      expected_template_id: state.template_id,
      expected_opportunity_id: entry.opportunity_id,
      expected_selection_sequence: index,
    });
    if (!observationVerification.valid) {
      errors.push(...observationVerification.errors.map((error) => `caller_selections[${index}] ${error}`));
    }
    const projectedHash = sha256Hex(`${OBSERVATION_DOMAIN}${canonicalJson(entry.observation_receipt.projection)}`);
    if (entry.input_projection_sha256 !== projectedHash) {
      errors.push(`caller_selections[${index}] input projection digest mismatch`);
    } else {
      const expectedCandidate = selectCandidate(
        template.opportunities[replayedOpportunityIndex]!,
        entry.observation_receipt.projection,
      );
      if (expectedCandidate.candidate_id !== entry.candidate_id) {
        errors.push(`caller_selections[${index}] is not the deterministic branch for its signed observation`);
      }
    }
    try {
      assertTimestamp(entry.selected_at, `caller_selections[${index}].selected_at`);
      const selectedAtMs = Date.parse(entry.selected_at);
      if (selectedAtMs < priorSelectedAtMs) errors.push(`caller_selections[${index}] timestamp regressed`);
      priorSelectedAtMs = selectedAtMs;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `caller_selections[${index}] timestamp is invalid`);
    }
    for (const assertion of candidate.fact_assertions) {
      expectedFacts.push({
        assertion,
        opportunity_id: entry.opportunity_id,
        selection_sha256: entry.entry_sha256,
      });
    }
    if (candidate.path === "advance" || candidate.path === "settled") replayedOpportunityIndex += 1;
    else repairSelectionCount += 1;
  }
  if (replayedOpportunityIndex !== state.next_opportunity_index) {
    errors.push("caller state opportunity index differs from deterministic selection replay");
  }
  if (repairSelectionCount > MAXIMUM_CALLER_REPAIR_SELECTIONS) {
    errors.push("caller state exceeds the frozen repair-selection budget");
  }
  if (expectedFacts.length !== state.fact_entries.length) {
    errors.push("caller fact ledger count differs from frozen selected-candidate assertions");
  }
  const latestFact = new Map<string, CallerFactLedgerEntry>();
  for (const [index, entry] of state.fact_entries.entries()) {
    const expected = expectedFacts[index];
    if (!expected
        || entry.fact_id !== expected.assertion.fact_id
        || entry.revision !== expected.assertion.revision
        || canonicalJson(entry.value) !== canonicalJson(expected.assertion.value)
        || entry.supersedes_value_sha256 !== expected.assertion.supersedes_value_sha256
        || entry.source_opportunity_id !== expected.opportunity_id
        || entry.source_selection_entry_sha256 !== expected.selection_sha256) {
      errors.push(`caller_fact_ledger[${index}] differs from its frozen selected-candidate assertion`);
    }
    const prior = latestFact.get(entry.fact_id);
    if (entry.revision !== (prior?.revision ?? 0) + 1) {
      errors.push(`caller_fact_ledger[${index}] revision is not contiguous`);
    }
    if (prior && entry.supersedes_value_sha256 !== sha256Hex(`${FACT_VALUE_DOMAIN}${canonicalJson(prior.value)}`)) {
      errors.push(`caller_fact_ledger[${index}] supersession digest is invalid`);
    }
    if (!prior && entry.supersedes_value_sha256 !== null) {
      errors.push(`caller_fact_ledger[${index}] supersedes a missing fact`);
    }
    latestFact.set(entry.fact_id, entry);
  }
  return Object.freeze(errors);
}

function assertCallerStateIntegrity(
  corpus: DevelopmentCorpus,
  state: ClosedLoopCallerState,
  observationAuthority: CallerVerificationAuthority,
): void {
  const errors = callerStateIntegrityErrors(corpus, state, observationAuthority);
  if (errors.length > 0) throw new Error(`caller state integrity failed: ${errors.join("; ")}`);
}

function selectCandidate(
  opportunity: DevelopmentTemplate["opportunities"][number],
  observation: ArmBlindCallerObservation,
): CallerCandidate {
  const heard = new Set(observation.listener.played_audio_semantics
    .filter((item) => item.disposition === "heard")
    .map((item) => item.semantic_id));
  if (!opportunity.required_heard_semantic_ids.every((semanticId) => heard.has(semanticId))) {
    return opportunity.candidates.repair;
  }
  if (!opportunity.world_branch) return opportunity.candidates.advance;
  const observedValue = observation.world.facts[opportunity.world_branch.fact_key];
  const settled = opportunity.world_branch.settled_values.some(
    (value) => canonicalJson(value) === canonicalJson(observedValue),
  );
  if (settled) return opportunity.candidates.settled ?? opportunity.candidates.advance;
  return opportunity.candidates.pending ?? opportunity.candidates.repair;
}

export function advanceClosedLoopCaller(input: Readonly<{
  corpus: DevelopmentCorpus;
  state: ClosedLoopCallerState;
  observation_receipt: SignedArmBlindCallerObservation;
  observation_verification_authority: CallerVerificationAuthority;
  selected_at: string;
}>): CallerAdvanceResult {
  assertTimestamp(input.selected_at, "selected_at");
  assertCallerStateIntegrity(input.corpus, input.state, input.observation_verification_authority);
  const template = getDevelopmentCallerTemplate(input.corpus, input.state.template_id);
  if (!Number.isSafeInteger(input.state.next_opportunity_index)
      || input.state.next_opportunity_index < 0
      || input.state.next_opportunity_index >= template.opportunities.length) {
    throw new Error("caller schedule is complete or state opportunity index is invalid");
  }

  const observationVerification = verifySignedArmBlindCallerObservation({
    corpus: input.corpus,
    receipt: input.observation_receipt,
    verification_authority: input.observation_verification_authority,
    expected_run_id: input.state.run_id,
    expected_template_id: template.template_id,
    expected_opportunity_id: template.opportunities[input.state.next_opportunity_index]!.opportunity_id,
    expected_selection_sequence: input.state.selection_entries.length,
  });
  if (!observationVerification.valid) {
    throw new Error(`caller observation authority failed: ${observationVerification.errors.join("; ")}`);
  }
  const observation = input.observation_receipt.projection;
  const observationSha256 = sha256Hex(`${OBSERVATION_DOMAIN}${canonicalJson(observation)}`);
  const opportunity = template.opportunities[input.state.next_opportunity_index]!;
  const selected = selectCandidate(opportunity, observation);
  const priorRepairSelections = input.state.selection_entries.filter(
    (entry) => entry.path === "repair" || entry.path === "pending",
  ).length;
  if ((selected.path === "repair" || selected.path === "pending")
      && priorRepairSelections >= MAXIMUM_CALLER_REPAIR_SELECTIONS) {
    throw new Error(`caller repair-selection budget exhausted at ${opportunity.opportunity_id}`);
  }
  const previousSelection = input.state.selection_entries.at(-1)?.entry_sha256 ?? null;
  const selectionBody = {
    schema_version: 1 as const,
    sequence: input.state.selection_entries.length,
    opportunity_id: opportunity.opportunity_id,
    candidate_id: selected.candidate_id,
    path: selected.path,
    selected_at: input.selected_at,
    observation_receipt: input.observation_receipt,
    input_projection_sha256: observationSha256,
    utterance_sha256: selected.utterance_sha256,
    previous_entry_sha256: previousSelection,
  };
  const selectionEntry: CallerSelectionLedgerEntry = Object.freeze({
    ...selectionBody,
    entry_sha256: hashEntry(SELECTION_ENTRY_DOMAIN, selectionBody),
  });

  const factEntries = [...input.state.fact_entries];
  for (const assertion of selected.fact_assertions) {
    const prior = [...factEntries].reverse().find((entry) => entry.fact_id === assertion.fact_id);
    const expectedRevision = (prior?.revision ?? 0) + 1;
    if (assertion.revision !== expectedRevision) {
      throw new Error(`caller fact ${assertion.fact_id} revision must advance from ${expectedRevision - 1} to ${expectedRevision}`);
    }
    if (prior && assertion.supersedes_value_sha256 !== sha256Hex(`${FACT_VALUE_DOMAIN}${canonicalJson(prior.value)}`)) {
      throw new Error(`caller fact ${assertion.fact_id} does not supersede its prior value`);
    }
    if (!prior && assertion.supersedes_value_sha256 !== null) {
      throw new Error(`caller fact ${assertion.fact_id} cannot supersede a missing value`);
    }
    const previousFact = factEntries.at(-1)?.entry_sha256 ?? null;
    const factBody = {
      schema_version: 1 as const,
      sequence: factEntries.length,
      fact_id: assertion.fact_id,
      revision: assertion.revision,
      value: assertion.value,
      supersedes_value_sha256: assertion.supersedes_value_sha256,
      source_opportunity_id: opportunity.opportunity_id,
      source_selection_entry_sha256: selectionEntry.entry_sha256,
      previous_entry_sha256: previousFact,
    };
    factEntries.push(Object.freeze({
      ...factBody,
      entry_sha256: hashEntry(FACT_ENTRY_DOMAIN, factBody),
    }));
  }

  const state = immutableJson({
    ...input.state,
    next_opportunity_index: input.state.next_opportunity_index
      + (selected.path === "advance" || selected.path === "settled" ? 1 : 0),
    selection_entries: [...input.state.selection_entries, selectionEntry],
    fact_entries: factEntries,
  }) as ClosedLoopCallerState;
  return Object.freeze({
    state,
    selection: Object.freeze({
      opportunity_id: opportunity.opportunity_id,
      candidate_id: selected.candidate_id,
      path: selected.path,
      utterance: selected.utterance,
      utterance_sha256: selected.utterance_sha256,
      delivery: opportunity.delivery,
      event_kinds: opportunity.event_kinds,
      input_projection_sha256: observationSha256,
    }),
  });
}

function toPublicKey(key: KeyLike): KeyObject {
  return key instanceof KeyObject && key.type === "public"
    ? key
    : createPublicKey(key);
}

function keyFingerprint(key: KeyLike): string {
  const publicKey = toPublicKey(key);
  const der = publicKey.export({ type: "spki", format: "der" });
  return sha256Hex(der);
}

function signLedgerBody(body: unknown, domain: string, authority: CallerSigningAuthority): Readonly<{
  payload_sha256: string;
  signature: LedgerSignature;
}> {
  assertId(authority.key_id, "caller signing key_id");
  const privateKey = authority.private_key instanceof KeyObject
    ? authority.private_key
    : createPrivateKey(authority.private_key);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("caller ledgers require an Ed25519 private key");
  const payloadSha256 = sha256Hex(`${domain}${canonicalJson(body)}`);
  const signatureBase64 = sign(
    null,
    Buffer.from(`${SIGNING_DOMAIN}${domain}${payloadSha256}`),
    privateKey,
  ).toString("base64");
  return Object.freeze({
    payload_sha256: payloadSha256,
    signature: Object.freeze({
      algorithm: "Ed25519" as const,
      key_id: authority.key_id,
      public_key_fingerprint_sha256: keyFingerprint(privateKey),
      signed_payload_sha256: payloadSha256,
      signature_base64: signatureBase64,
    }),
  });
}

export function finalizeSignedCallerLedgers(input: Readonly<{
  corpus: DevelopmentCorpus;
  state: ClosedLoopCallerState;
  signing_authority: CallerSigningAuthority;
  observation_verification_authority: CallerVerificationAuthority;
  require_complete: boolean;
}>): SignedCallerLedgers {
  assertCallerStateIntegrity(input.corpus, input.state, input.observation_verification_authority);
  const template = getDevelopmentCallerTemplate(input.corpus, input.state.template_id);
  const scheduleStatus = input.state.next_opportunity_index === template.opportunities.length
    ? "complete" as const
    : "incomplete" as const;
  if (input.require_complete && scheduleStatus !== "complete") {
    throw new Error("cannot finalize a complete caller ledger before every common opportunity advances");
  }
  const common = {
    schema_version: 1 as const,
    run_id: input.state.run_id,
    corpus_sha256: input.state.corpus_sha256,
    template_id: input.state.template_id,
    template_sha256: input.state.template_sha256,
    schedule_status: scheduleStatus,
  };
  const selectionBody = {
    ...common,
    ledger_kind: "caller_selections" as const,
    entry_count: input.state.selection_entries.length,
    chain_head_sha256: input.state.selection_entries.at(-1)?.entry_sha256 ?? null,
    entries: input.state.selection_entries,
  };
  const factBody = {
    ...common,
    ledger_kind: "caller_fact_ledger" as const,
    entry_count: input.state.fact_entries.length,
    chain_head_sha256: input.state.fact_entries.at(-1)?.entry_sha256 ?? null,
    entries: input.state.fact_entries,
  };
  const selectionSignature = signLedgerBody(selectionBody, SELECTION_LEDGER_DOMAIN, input.signing_authority);
  const factSignature = signLedgerBody(factBody, FACT_LEDGER_DOMAIN, input.signing_authority);
  return immutableJson({
    caller_selections: { ...selectionBody, ...selectionSignature },
    caller_fact_ledger: { ...factBody, ...factSignature },
  }) as SignedCallerLedgers;
}

function verifyEntryChain(
  entries: readonly Record<string, unknown>[],
  domain: string,
  errors: string[],
  label: string,
  expectedKeys: readonly string[] = label === "caller_selections" ? SELECTION_ENTRY_KEYS : FACT_ENTRY_KEYS,
): void {
  let previous: string | null = null;
  entries.forEach((entry, index) => {
    if (!hasExactlyKeys(entry, expectedKeys)) errors.push(`${label}[${index}] fields differ from the closed schema`);
    const { entry_sha256: claimedHash, ...body } = entry;
    if (entry.sequence !== index) errors.push(`${label}[${index}] sequence is not contiguous`);
    if (entry.previous_entry_sha256 !== previous) errors.push(`${label}[${index}] previous hash mismatch`);
    const expectedHash = hashEntry(domain, body);
    if (claimedHash !== expectedHash) errors.push(`${label}[${index}] hash mismatch`);
    previous = typeof claimedHash === "string" ? claimedHash : null;
  });
}

function verifyLedgerSignature(
  ledger: Record<string, unknown>,
  domain: string,
  authority: CallerVerificationAuthority,
  errors: string[],
  label = String(ledger.ledger_kind ?? "caller ledger"),
): void {
  const signature = ledger.signature as Record<string, unknown> | undefined;
  const claimedPayload = ledger.payload_sha256;
  const body = Object.fromEntries(Object.entries(ledger).filter(
    ([key]) => key !== "payload_sha256" && key !== "signature",
  ));
  const expectedPayload = sha256Hex(`${domain}${canonicalJson(body)}`);
  if (claimedPayload !== expectedPayload) errors.push(`${label} payload hash mismatch`);
  if (!signature || signature.algorithm !== "Ed25519" || signature.key_id !== authority.key_id
      || signature.signed_payload_sha256 !== expectedPayload
      || signature.public_key_fingerprint_sha256 !== keyFingerprint(authority.public_key)
      || typeof signature.signature_base64 !== "string") {
    errors.push(`${label} signature identity mismatch`);
    return;
  }
  const publicKey = toPublicKey(authority.public_key);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    errors.push(`${label} verification key is not Ed25519`);
    return;
  }
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature.signature_base64, "base64");
  } catch {
    errors.push(`${label} signature encoding is invalid`);
    return;
  }
  if (signatureBytes.byteLength !== 64 || !verify(
    null,
    Buffer.from(`${SIGNING_DOMAIN}${domain}${expectedPayload}`),
    publicKey,
    signatureBytes,
  )) errors.push(`${label} signature verification failed`);
}

function verifySignedCallerLedgersUnchecked(input: Readonly<{
  corpus: DevelopmentCorpus;
  ledgers: SignedCallerLedgers;
  verification_authority: CallerVerificationAuthority;
  observation_verification_authority: CallerVerificationAuthority;
}>): Readonly<{ valid: boolean; schedule_complete: boolean; errors: readonly string[] }> {
  const errors: string[] = [];
  const selections = input.ledgers.caller_selections as unknown as Record<string, unknown>;
  const facts = input.ledgers.caller_fact_ledger as unknown as Record<string, unknown>;
  if (!hasExactlyKeys(selections, LEDGER_KEYS)) errors.push("caller_selections fields differ from the closed schema");
  if (!hasExactlyKeys(facts, LEDGER_KEYS)) errors.push("caller_fact_ledger fields differ from the closed schema");
  const selectionEntries = Array.isArray(selections.entries)
    ? selections.entries as Record<string, unknown>[]
    : [];
  const factEntries = Array.isArray(facts.entries)
    ? facts.entries as Record<string, unknown>[]
    : [];
  if (!Array.isArray(selections.entries)) errors.push("caller_selections entries are missing");
  if (!Array.isArray(facts.entries)) errors.push("caller_fact_ledger entries are missing");
  verifyEntryChain(selectionEntries, SELECTION_ENTRY_DOMAIN, errors, "caller_selections");
  verifyEntryChain(factEntries, FACT_ENTRY_DOMAIN, errors, "caller_fact_ledger");
  if (selections.entry_count !== selectionEntries.length
      || selections.chain_head_sha256 !== (selectionEntries.at(-1)?.entry_sha256 ?? null)) {
    errors.push("caller_selections terminal does not match its entry chain");
  }
  if (facts.entry_count !== factEntries.length
      || facts.chain_head_sha256 !== (factEntries.at(-1)?.entry_sha256 ?? null)) {
    errors.push("caller_fact_ledger terminal does not match its entry chain");
  }
  const selectionHashes = new Set(selectionEntries.map((entry) => entry.entry_sha256));
  for (const [index, entry] of factEntries.entries()) {
    if (!selectionHashes.has(entry.source_selection_entry_sha256)) {
      errors.push(`caller_fact_ledger[${index}] references an unknown caller selection`);
    }
  }
  for (const key of ["run_id", "corpus_sha256", "template_id", "template_sha256"] as const) {
    if (selections[key] !== facts[key]) errors.push(`caller ledgers disagree on ${key}`);
  }
  if (selections.schedule_status !== facts.schedule_status
      || (selections.schedule_status !== "complete" && selections.schedule_status !== "incomplete")) {
    errors.push("caller ledgers disagree on schedule status");
  }
  if (typeof selections.run_id === "string"
      && typeof selections.corpus_sha256 === "string"
      && typeof selections.template_id === "string"
      && typeof selections.template_sha256 === "string") {
    const replayedState: ClosedLoopCallerState = {
      schema_version: 1,
      run_id: selections.run_id,
      corpus_sha256: selections.corpus_sha256,
      template_id: selections.template_id,
      template_sha256: selections.template_sha256,
      next_opportunity_index: (() => {
        let index = 0;
        for (const entry of selectionEntries) {
          if (entry.path === "advance" || entry.path === "settled") index += 1;
        }
        return index;
      })(),
      selection_entries: selectionEntries as unknown as readonly CallerSelectionLedgerEntry[],
      fact_entries: factEntries as unknown as readonly CallerFactLedgerEntry[],
    };
    errors.push(...callerStateIntegrityErrors(input.corpus, replayedState, input.observation_verification_authority));
    const template = input.corpus.templates.find((item) => item.template_id === replayedState.template_id);
    const derivedStatus = template && replayedState.next_opportunity_index === template.opportunities.length
      ? "complete"
      : "incomplete";
    if (selections.schedule_status !== derivedStatus) errors.push("caller ledger schedule status is false");
  } else {
    errors.push("caller ledgers are missing frozen corpus identity fields");
  }
  verifyLedgerSignature(selections, SELECTION_LEDGER_DOMAIN, input.verification_authority, errors);
  verifyLedgerSignature(facts, FACT_LEDGER_DOMAIN, input.verification_authority, errors);
  return Object.freeze({
    valid: errors.length === 0,
    schedule_complete: errors.length === 0 && selections.schedule_status === "complete",
    errors: Object.freeze(errors),
  });
}

export function verifySignedCallerLedgers(input: Readonly<{
  corpus: DevelopmentCorpus;
  ledgers: SignedCallerLedgers;
  verification_authority: CallerVerificationAuthority;
  observation_verification_authority: CallerVerificationAuthority;
}>): Readonly<{ valid: boolean; schedule_complete: boolean; errors: readonly string[] }> {
  try {
    const raw = input.ledgers as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)
        || (raw as Record<string, unknown>).caller_selections === null
        || typeof (raw as Record<string, unknown>).caller_selections !== "object"
        || Array.isArray((raw as Record<string, unknown>).caller_selections)
        || (raw as Record<string, unknown>).caller_fact_ledger === null
        || typeof (raw as Record<string, unknown>).caller_fact_ledger !== "object"
        || Array.isArray((raw as Record<string, unknown>).caller_fact_ledger)) {
      return Object.freeze({
        valid: false,
        schedule_complete: false,
        errors: Object.freeze(["signed caller ledger package is malformed"]),
      });
    }
    return verifySignedCallerLedgersUnchecked(input);
  } catch (error) {
    return Object.freeze({
      valid: false,
      schedule_complete: false,
      errors: Object.freeze([error instanceof Error ? error.message : "signed caller ledger verification failed"]),
    });
  }
}

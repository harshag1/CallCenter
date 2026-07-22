import { lstat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, sha256Hex } from "./artifacts";
import {
  initializeFilesystemBudgetLedger,
  inspectFilesystemBudgetLedger,
  markBudgetConnectionIntent,
  markBudgetSessionOpened,
  recordBudgetTerminal,
  recordFilesystemBudgetUsage,
  reserveFilesystemBudget,
  settleFilesystemBudget,
  type BudgetCostEnvelope,
  type BudgetJournalSnapshot,
  type BudgetJournalTerminalOutcome,
  type Lc4QualificationV2PlanConsumption,
} from "./filesystem-budget-ledger";
import type { LiveStsProvider } from "./live-sts-development-experiment";

export const LC4_QUALIFICATION_BUDGET_VERSION = "HACC-LC4-QUALIFICATION-BUDGET-v2" as const;
export const LC4_QUALIFICATION_BUDGET_MAXIMUM_MICRO_USD = 3_000_000 as const;
export const LC4_QUALIFICATION_BUDGET_GENERATIONS = 6 as const;
export const LC4_QUALIFICATION_BUDGET_PAID_GENERATION_SESSIONS = 6 as const;

const BINDING_DOMAIN = "harshas-amazing-call-center/lc4-qualification-budget-binding/v2\n";
const ENVELOPE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-budget-envelope/v2\n";
const EVIDENCE_DOMAIN = "harshas-amazing-call-center/lc4-qualification-budget-evidence/v2\n";

export type Lc4QualificationBudgetBinding = Readonly<{
  attemptId: string;
  authorizationId: string;
  authorizationArtifactSha256: string;
  planSha256: string;
  sourceCommit: string;
  sourceTreeSha256: string;
  credentialSetSha256: string;
  providerProfileManifestSha256: string;
  configurationMatrixSha256: string;
  devConfigurationMatrixSha256: string;
  providersModels: Readonly<Record<LiveStsProvider, string>>;
  expiresAt: string;
}>;

export type Lc4QualificationBudgetReservation = Readonly<{
  ledgerPath: string;
  ledgerId: string;
  reservationId: string;
  requestedHeadSha256: string;
  startedHeadSha256: string;
  openedHeadSha256: string;
  bindingSha256: string;
}>;

export type Lc4QualificationBudgetEvidence = Readonly<{
  schema_version: 1;
  budget_version: typeof LC4_QUALIFICATION_BUDGET_VERSION;
  ledger_id: string;
  reservation_id: string;
  binding_sha256: string;
  usage_event_count: number;
  usage_evidence_sha256: string;
  terminal_outcome: BudgetJournalTerminalOutcome;
  maximum_micro_usd: typeof LC4_QUALIFICATION_BUDGET_MAXIMUM_MICRO_USD;
  conservative_settled_micro_usd: number;
  final_head_sha256: string;
  evidence_sha256: string;
}>;

function missingOnly(error: unknown): null {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
  throw error;
}

export function assertLc4QualificationBudgetEvidence(
  value: unknown,
): asserts value is Lc4QualificationBudgetEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LC4 qualification budget evidence must be an object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "schema_version", "budget_version", "ledger_id", "reservation_id", "binding_sha256",
    "usage_event_count", "usage_evidence_sha256", "terminal_outcome", "maximum_micro_usd",
    "conservative_settled_micro_usd", "final_head_sha256", "evidence_sha256",
  ].sort();
  if (canonicalJson(Object.keys(record).sort()) !== canonicalJson(expectedKeys)) {
    throw new Error("LC4 qualification budget evidence contains unknown or missing fields");
  }
  if (record.schema_version !== 1
    || record.budget_version !== LC4_QUALIFICATION_BUDGET_VERSION
    || record.maximum_micro_usd !== LC4_QUALIFICATION_BUDGET_MAXIMUM_MICRO_USD
    || record.conservative_settled_micro_usd !== LC4_QUALIFICATION_BUDGET_MAXIMUM_MICRO_USD
    || !Number.isSafeInteger(record.usage_event_count)
    || (record.usage_event_count as number) < 0
    || !["completed", "failed", "cancelled"].includes(String(record.terminal_outcome))) {
    throw new Error("LC4 qualification budget evidence weakened the exact settlement contract");
  }
  for (const key of ["binding_sha256", "usage_evidence_sha256", "final_head_sha256", "evidence_sha256"] as const) {
    if (typeof record[key] !== "string" || !/^[a-f0-9]{64}$/.test(record[key])) {
      throw new Error(`LC4 qualification budget evidence ${key} is invalid`);
    }
  }
  if (typeof record.ledger_id !== "string" || typeof record.reservation_id !== "string") {
    throw new Error("LC4 qualification budget evidence identities are invalid");
  }
  const { evidence_sha256, ...body } = record;
  if (evidence_sha256 !== sha256Hex(`${EVIDENCE_DOMAIN}${canonicalJson(body)}`)) {
    throw new Error("LC4 qualification budget evidence hash mismatch");
  }
}

export function lc4QualificationBudgetLedgerPath(root: string): string {
  return resolve(root, "budget", "qualification-v2.jsonl");
}

function bindingBody(input: Lc4QualificationBudgetBinding) {
  return Object.freeze({
    budget_version: LC4_QUALIFICATION_BUDGET_VERSION,
    attempt_id: input.attemptId,
    authorization_id: input.authorizationId,
    authorization_artifact_sha256: input.authorizationArtifactSha256,
    plan_sha256: input.planSha256,
    source_commit: input.sourceCommit,
    source_tree_sha256: input.sourceTreeSha256,
    credential_set_sha256: input.credentialSetSha256,
    provider_profile_manifest_sha256: input.providerProfileManifestSha256,
    configuration_matrix_sha256: input.configurationMatrixSha256,
    dev_configuration_matrix_sha256: input.devConfigurationMatrixSha256,
    providers_models: input.providersModels,
    maximum_micro_usd: LC4_QUALIFICATION_BUDGET_MAXIMUM_MICRO_USD,
    maximum_response_generations: LC4_QUALIFICATION_BUDGET_GENERATIONS,
    maximum_paid_generation_sessions: LC4_QUALIFICATION_BUDGET_PAID_GENERATION_SESSIONS,
    paid_retry_allowed: false,
  });
}

export function lc4QualificationBudgetBindingSha256(input: Lc4QualificationBudgetBinding): string {
  return sha256Hex(`${BINDING_DOMAIN}${canonicalJson(bindingBody(input))}`);
}

function costEnvelope(input: Lc4QualificationBudgetBinding): BudgetCostEnvelope {
  const bindingSha256 = lc4QualificationBudgetBindingSha256(input);
  return Object.freeze({
    schema_version: 1,
    kind: "hacc_provider_gate1_cost_envelope",
    pricing_snapshot_sha256: sha256Hex(`${ENVELOPE_DOMAIN}conservative-reservation\n${bindingSha256}`),
    provider_hard_session_caps_sha256: sha256Hex(`${ENVELOPE_DOMAIN}six-paid-generation-sessions\n${canonicalJson(input.providersModels)}`),
    runner_config_sha256: bindingSha256,
    formula_sha256: sha256Hex(`${ENVELOPE_DOMAIN}sum-three-provider-maxima\n`),
    components: Object.freeze(([
      "openai", "gemini", "xai",
    ] as const).map((provider) => Object.freeze({
      name: `${provider}-qualification-maximum`,
      upper_bound_micro_usd: 1_000_000,
    }))),
    safety_margin_micro_usd: 0,
  });
}

async function initializeOrInspectLedger(ledgerPath: string, now: () => Date): Promise<BudgetJournalSnapshot> {
  await mkdir(resolve(ledgerPath, ".."), { recursive: true, mode: 0o700 });
  const corePaths = [ledgerPath, `${ledgerPath}.head.json`, `${ledgerPath}.signing-key.pem`];
  const existing = await Promise.all(corePaths.map((path) => lstat(path).catch(missingOnly)));
  if (existing.every((entry) => entry === null)) {
    return (await initializeFilesystemBudgetLedger({
      ledgerPath,
      ledgerId: `lc4-qualification-v2-${sha256Hex(ledgerPath).slice(0, 24)}`,
      operationId: "lc4-qualification-v2-initialize",
      operationalCeilingUsd: "3",
      now,
    })).snapshot;
  }
  if (existing.some((entry) => entry === null)) {
    throw new Error("LC4 qualification budget ledger has partial or missing durable state");
  }
  return inspectFilesystemBudgetLedger({ ledgerPath, now });
}

export async function reserveLc4QualificationBudget(input: Readonly<{
  root: string;
  binding: Lc4QualificationBudgetBinding;
  now: () => Date;
}>): Promise<Lc4QualificationBudgetReservation> {
  if (input.binding.attemptId !== input.binding.authorizationId) {
    throw new Error("LC4 qualification budget attempt must equal the signed authorization ID");
  }
  const ledgerPath = lc4QualificationBudgetLedgerPath(input.root);
  const before = await initializeOrInspectLedger(ledgerPath, input.now);
  if (before.state !== "open"
    || before.operational_ceiling_micro_usd !== LC4_QUALIFICATION_BUDGET_MAXIMUM_MICRO_USD
    || before.reservations.length !== 0
    || before.scheduling_exposure_micro_usd !== 0) {
    throw Object.assign(
      new Error("LC4 qualification budget ledger is not a fresh settled-zero one-shot authority"),
      { code: "EEXIST" as const },
    );
  }
  const bindingSha256 = lc4QualificationBudgetBindingSha256(input.binding);
  const reservationId = `lc4qv2:${input.binding.attemptId}`;
  const planConsumption: Lc4QualificationV2PlanConsumption = Object.freeze({
    kind: "lc4_qualification_v2",
    consumptionId: `lc4qv2:${input.binding.authorizationId}`,
    planSha256: input.binding.planSha256,
    maximumMicroUsd: LC4_QUALIFICATION_BUDGET_MAXIMUM_MICRO_USD,
    authorizationArtifactSha256: input.binding.authorizationArtifactSha256,
    authorizationId: input.binding.authorizationId,
    attemptId: input.binding.attemptId,
    sourceCommit: input.binding.sourceCommit,
    sourceTreeSha256: input.binding.sourceTreeSha256,
    credentialSetSha256: input.binding.credentialSetSha256,
    providerProfileManifestSha256: input.binding.providerProfileManifestSha256,
    configurationMatrixSha256: input.binding.configurationMatrixSha256,
    devConfigurationMatrixSha256: input.binding.devConfigurationMatrixSha256,
    providersModelsSha256: sha256Hex(canonicalJson(input.binding.providersModels)),
    maximumResponseGenerations: LC4_QUALIFICATION_BUDGET_GENERATIONS,
    maximumPaidGenerationSessions: LC4_QUALIFICATION_BUDGET_PAID_GENERATION_SESSIONS,
    paidRetryAllowed: false,
  });
  const requested = await reserveFilesystemBudget({
    ledgerPath,
    operationId: `lc4qv2-request:${input.binding.attemptId}`,
    reservationId,
    runId: `lc4qv2:${input.binding.attemptId}`,
    provider: "openai+gemini+xai",
    model: "exact-model-matrix-v2",
    condition: "qualification-v2",
    expiresAt: input.binding.expiresAt,
    costEnvelope: costEnvelope(input.binding),
    requiredCurrentHeadSha256: before.head_sha256,
    planConsumption,
    now: input.now,
  });
  const started = await markBudgetConnectionIntent({
    ledgerPath,
    operationId: `lc4qv2-start:${input.binding.attemptId}`,
    reservationId,
    now: input.now,
  });
  const opened = await markBudgetSessionOpened({
    ledgerPath,
    operationId: `lc4qv2-open:${input.binding.attemptId}`,
    reservationId,
    now: input.now,
  });
  return Object.freeze({
    ledgerPath,
    ledgerId: opened.snapshot.ledger_id,
    reservationId,
    requestedHeadSha256: requested.snapshot.head_sha256,
    startedHeadSha256: started.snapshot.head_sha256,
    openedHeadSha256: opened.snapshot.head_sha256,
    bindingSha256,
  });
}

export async function finalizeLc4QualificationBudget(input: Readonly<{
  reservation: Lc4QualificationBudgetReservation;
  attemptId: string;
  usageEventCount: number;
  usageEvidenceSha256: string;
  outcome: BudgetJournalTerminalOutcome;
  now: () => Date;
}>): Promise<Lc4QualificationBudgetEvidence> {
  await recordFilesystemBudgetUsage({
    ledgerPath: input.reservation.ledgerPath,
    operationId: `lc4qv2-usage:${input.attemptId}`,
    reservationId: input.reservation.reservationId,
    usageEventCount: input.usageEventCount,
    usageEvidenceSha256: input.usageEvidenceSha256,
    now: input.now,
  });
  await recordBudgetTerminal({
    ledgerPath: input.reservation.ledgerPath,
    operationId: `lc4qv2-terminal:${input.attemptId}`,
    reservationId: input.reservation.reservationId,
    outcome: input.outcome,
    now: input.now,
  });
  const settled = await settleFilesystemBudget({
    ledgerPath: input.reservation.ledgerPath,
    operationId: `lc4qv2-settle:${input.attemptId}`,
    reservationId: input.reservation.reservationId,
    // Provider usage is retained separately. Until invoice reconciliation,
    // consume the full conservative reservation rather than claim a lower cost.
    estimatedUsd: "3",
    now: input.now,
  });
  const reservation = settled.snapshot.reservations.find((candidate) => candidate.reservation_id === input.reservation.reservationId);
  if (!reservation
    || reservation.status !== "settled"
    || reservation.usage_event_count !== input.usageEventCount
    || reservation.usage_evidence_sha256 !== input.usageEvidenceSha256
    || reservation.terminal_outcome !== input.outcome
    || reservation.estimated_micro_usd !== LC4_QUALIFICATION_BUDGET_MAXIMUM_MICRO_USD) {
    throw new Error("LC4 qualification budget settlement did not close the exact reservation");
  }
  const body = Object.freeze({
    schema_version: 1 as const,
    budget_version: LC4_QUALIFICATION_BUDGET_VERSION,
    ledger_id: settled.snapshot.ledger_id,
    reservation_id: input.reservation.reservationId,
    binding_sha256: input.reservation.bindingSha256,
    usage_event_count: input.usageEventCount,
    usage_evidence_sha256: input.usageEvidenceSha256,
    terminal_outcome: input.outcome,
    maximum_micro_usd: LC4_QUALIFICATION_BUDGET_MAXIMUM_MICRO_USD,
    conservative_settled_micro_usd: reservation.estimated_micro_usd,
    final_head_sha256: settled.snapshot.head_sha256,
  });
  return Object.freeze({
    ...body,
    evidence_sha256: sha256Hex(`${EVIDENCE_DOMAIN}${canonicalJson(body)}`),
  });
}

// Author: Harsha Gundala
// campaigns.ts — tenant-bound, confirmation-bound outbound campaign materialization and claiming.

import { createHash, createHmac } from "node:crypto";
import { getPool, q, qOne } from "./db";
import { AgentFlowSchema, type AgentFlow } from "./flow";
import { hashFlowValue } from "./flow-runtime";
import {
  parseCallRuntimeSnapshot,
} from "./call-runtime-snapshot";
import {
  buildVoiceRuntimeSnapshotsForAdmissions,
  type VoiceRuntimeAdmission,
} from "./voice";
import { log } from "./log";
import { operatorActionArgumentsSha256 } from "./agent/tools/operator-capability-policy";
import {
  assertOperatorCostQuoteUsable,
  createVoiceCampaignCostQuote,
  parseOperatorCostQuote,
  type OperatorCostQuoteV1,
} from "./operator-pricing";

const L = log("campaigns");
const KICK_PARALLEL = 5;
const MAX_CAMPAIGN_TARGETS = 5_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DATASET_SLUG = /^[a-z0-9][a-z0-9_]{0,47}$/;
const COLUMN_KEY = /^[a-z0-9][a-z0-9_]{0,47}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

function campaignCommitmentKey(): Buffer {
  const encoded = process.env.CAMPAIGN_COMMITMENT_SECRET;
  if (!encoded || !/^[a-f0-9]{64}$/i.test(encoded)) {
    throw new Error("CAMPAIGN_COMMITMENT_SECRET must be exactly 64 hexadecimal characters");
  }
  const key = Buffer.from(encoded, "hex");
  if (new Set(key).size < 8) throw new Error("CAMPAIGN_COMMITMENT_SECRET is an unsafe placeholder");
  return key;
}

export type FlowRow = {
  id: string; agent_id: string; name: string; kind: "inbound" | "outbound";
  flow: AgentFlow; instructions: string; created_at: string;
};

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new Error(`invalid ${label}`);
}

function acceptedProviderSettlementDetail(error: unknown): Record<string, string> {
  if (!error || typeof error !== "object") return {};
  const value = error as Record<string, unknown>;
  if (value.code !== "provider_accepted_local_settlement_unknown_do_not_retry") return {};
  const detail: Record<string, string> = { providerOutcome: String(value.code) };
  if (typeof value.providerCallSid === "string" && /^CA[a-f0-9]{32}$/i.test(value.providerCallSid)) {
    detail.providerCallSid = value.providerCallSid;
  }
  if (typeof value.providerAccountSid === "string" && /^AC[a-f0-9]{32}$/i.test(value.providerAccountSid)) {
    detail.providerAccountSid = value.providerAccountSid;
  }
  return detail;
}

function normalizeCampaignName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("invalid campaign name");
  }
  return normalized;
}

function normalizeRunAt(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value.length > 64) throw new Error("invalid campaign run time");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("invalid campaign run time");
  return parsed.toISOString();
}

function normalizeTarget(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 128) return null;
  const compact = raw.replace(/[() .-]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(compact)) return compact;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

function normalizedTargets(
  rows: readonly { data: Record<string, unknown> }[],
  phoneColumn: string
): { targets: string[]; skipped: number } {
  const unique = new Set<string>();
  let skipped = 0;
  for (const row of rows) {
    const target = normalizeTarget(row.data?.[phoneColumn]);
    if (!target || unique.has(target)) skipped += 1;
    else unique.add(target);
  }
  return { targets: [...unique].sort(), skipped };
}

function targetSetSha256(input: Readonly<{
  orgId: string;
  agentId: string;
  flowId: string;
  datasetId: string;
  datasetSlug: string;
  phoneColumn: string;
  targets: readonly string[];
}>): string {
  // Phone populations are low entropy. A plain digest would let anyone who
  // sees a proposal test guessed target sets offline, so commitments use a
  // server-only, independently generated HMAC key.
  return createHmac("sha256", campaignCommitmentKey())
    .update("harshas-amazing-call-center/campaign-target-set-commitment/v1\n", "utf8")
    .update(JSON.stringify({
      org_id: input.orgId,
      agent_id: input.agentId,
      flow_id: input.flowId,
      dataset_id: input.datasetId,
      dataset_slug: input.datasetSlug,
      phone_column: input.phoneColumn,
      targets: [...input.targets],
    }), "utf8")
    .digest("hex");
}

function deterministicUuid(domain: string, parts: readonly string[]): string {
  const bytes = createHash("sha256")
    .update(`harshas-amazing-call-center/${domain}/v1\n`, "utf8")
    .update(parts.join("\n"), "utf8")
    .digest()
    .subarray(0, 16);
  // UUIDv8 is explicitly application-defined. It remains a valid PostgreSQL UUID.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function scheduledCallId(executionId: string, target: string): string {
  // A public campaign/execution id plus an unkeyed deterministic job id would
  // allow offline phone-number guessing. Keep replay-stable identity while
  // making the mapping opaque outside the server.
  const bytes = createHmac("sha256", campaignCommitmentKey())
    .update("harshas-amazing-call-center/campaign-scheduled-call/v1\n", "utf8")
    .update(executionId, "ascii")
    .update("\n", "ascii")
    .update(target, "ascii")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function campaignAdmissionScopeId(input: Readonly<{
  orgId: string;
  agentId: string;
  flowId: string;
  datasetId: string;
  targetSetSha256: string;
}>): string {
  return deterministicUuid("campaign-runtime-admission", [
    input.orgId,
    input.agentId,
    input.flowId,
    input.datasetId,
    input.targetSetSha256,
  ]);
}

type CampaignRuntimeSet = Readonly<{
  agentVersion: number;
  digest: string;
  runtimes: readonly VoiceRuntimeAdmission[];
}>;

function campaignRuntimeSetDigest(runtimes: readonly VoiceRuntimeAdmission[]): string {
  return hashFlowValue({
    v: 1,
    calls: runtimes.map((runtime, ordinal) => ({
      ordinal,
      callId: runtime.admissionScopeId,
      runtimeDigest: runtime.digest,
    })),
  });
}

async function buildCampaignRuntimeSet(input: Readonly<{
  orgId: string;
  agentId: string;
  flowId: string;
  runtimeSetId: string;
  targets: readonly string[];
}>): Promise<CampaignRuntimeSet> {
  const callIds = input.targets.map((target) => scheduledCallId(input.runtimeSetId, target));
  const batch = await buildVoiceRuntimeSnapshotsForAdmissions({
    agentId: input.agentId,
    orgId: input.orgId,
    flowId: input.flowId,
    admissionScopeIds: callIds,
  });
  if (
    batch.runtimes.length !== callIds.length ||
    batch.runtimes.some((runtime, index) => runtime.admissionScopeId !== callIds[index])
  ) throw new Error("campaign runtime set lost canonical target ordering");
  return Object.freeze({
    agentVersion: batch.agentVersion,
    digest: campaignRuntimeSetDigest(batch.runtimes),
    runtimes: batch.runtimes,
  });
}

export async function createFlow(
  orgId: string,
  agentId: string,
  opts: { name: string; kind?: "inbound" | "outbound"; flow: unknown; instructions: string; createdBy: string }
): Promise<FlowRow> {
  const parsed = AgentFlowSchema.parse(opts.flow);
  const row = await qOne<FlowRow>(
    `INSERT INTO flows (org_id, agent_id, name, kind, flow, instructions, created_by)
     SELECT a.org_id, a.id, $3, $4, $5, $6, $7
     FROM agents a
     WHERE a.id = $2 AND a.org_id = $1
     RETURNING id, agent_id, name, kind, flow, instructions, created_at`,
    [orgId, agentId, opts.name, opts.kind ?? "outbound", JSON.stringify(parsed), opts.instructions, opts.createdBy]
  );
  if (!row) throw new Error("agent not found");
  return row;
}

export async function updateFlow(
  orgId: string,
  flowId: string,
  patch: { name?: string; flow?: unknown; instructions?: string }
): Promise<boolean> {
  const flow = patch.flow ? JSON.stringify(AgentFlowSchema.parse(patch.flow)) : null;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const owned = await client.query<{ id: string }>(
      `SELECT id FROM flows WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [flowId, orgId]
    );
    if (owned.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    const active = await client.query<{ id: string }>(
      `SELECT c.id FROM campaigns c
       WHERE c.org_id = $2 AND c.flow_id = $1
         AND (
           c.status IN ('scheduled','running')
           OR (
             c.status = 'indeterminate'
             AND NOT EXISTS (
               SELECT 1 FROM campaign_dispatch_reconciliations reconciliation
               WHERE reconciliation.campaign_id = c.id
                 AND reconciliation.org_id = c.org_id
             )
           )
         )
       LIMIT 1 FOR SHARE`,
      [flowId, orgId]
    );
    if (active.rowCount) {
      throw new Error("flow is locked by an active campaign; cancel it and re-authorize");
    }
    const updated = await client.query<{ id: string }>(
      `UPDATE flows SET
         name = COALESCE($3, name), flow = COALESCE($4::jsonb, flow),
         instructions = COALESCE($5, instructions), updated_at = now()
       WHERE id = $1 AND org_id = $2 RETURNING id`,
      [flowId, orgId, patch.name ?? null, flow, patch.instructions ?? null]
    );
    if (updated.rowCount !== 1) throw new Error("flow update lost its ownership lock");
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listFlows(orgId: string, agentId?: string | null): Promise<FlowRow[]> {
  return q<FlowRow>(
    `SELECT id, agent_id, name, kind, flow, instructions, created_at FROM flows
     WHERE org_id = $1 AND ($2::uuid IS NULL OR agent_id = $2) ORDER BY created_at`,
    [orgId, agentId ?? null]
  );
}

export type CampaignTargetPreview = Readonly<{
  schemaVersion: 1;
  orgId: string;
  agentId: string;
  flowId: string;
  datasetId: string;
  datasetSlug: string;
  phoneColumn: string;
  agentVersion: number;
  flowSha256: string;
  /** Opaque seed used only to derive stable, non-guessable per-target calls.id values. */
  runtimeAdmissionScopeId: string;
  /** Aggregate commitment over the ordered exact {calls.id, runtime digest} set. */
  runtimeDigest: string;
  targetSetSha256: string;
  targetCount: number;
  skipped: number;
}>;

export type CampaignProposalTargetSnapshot = Readonly<{
  /** Target-free value safe to hash, authorize, and expose to the model. */
  preview: CampaignTargetPreview;
  /** Sensitive server-only display data. Persist only in the private proposal
   * record and serve it later through the authenticated proposal-display API. */
  displayTargets: readonly string[];
}>;

type CampaignPreviewOptions = Readonly<{
  agentId: string;
  flowId: string;
  datasetSlug: string;
  phoneColumn?: string;
}>;

type CampaignBinding = {
  dataset_id: string;
  agent_version: number;
  flow: unknown;
  phone_number: string | null;
};

const CAMPAIGN_BINDING_SQL = `SELECT d.id AS dataset_id, a.active_version AS agent_version,
    a.phone_number, f.flow
  FROM datasets d
  JOIN agents a ON a.id = $3 AND a.org_id = d.org_id
  JOIN flows f ON f.id = $4 AND f.org_id = d.org_id
              AND f.agent_id = a.id AND f.kind = 'outbound'
  WHERE d.org_id = $1 AND d.slug = $2`;

function validatePreview(preview: CampaignTargetPreview): void {
  if (preview.schemaVersion !== 1) throw new Error("unsupported campaign target snapshot");
  assertUuid(preview.orgId, "campaign organization");
  assertUuid(preview.agentId, "campaign agent");
  assertUuid(preview.flowId, "campaign flow");
  assertUuid(preview.datasetId, "campaign dataset");
  assertUuid(preview.runtimeAdmissionScopeId, "campaign runtime admission scope");
  if (!DATASET_SLUG.test(preview.datasetSlug) || !COLUMN_KEY.test(preview.phoneColumn)) {
    throw new Error("invalid campaign target snapshot");
  }
  if (!Number.isSafeInteger(preview.agentVersion) || preview.agentVersion < 1
      || !SHA256.test(preview.flowSha256)
      || !SHA256.test(preview.runtimeDigest)
      || !SHA256.test(preview.targetSetSha256)
      || !Number.isSafeInteger(preview.targetCount)
      || preview.targetCount < 1
      || preview.targetCount > MAX_CAMPAIGN_TARGETS
      || !Number.isSafeInteger(preview.skipped)
      || preview.skipped < 0) {
    throw new Error("invalid campaign target snapshot");
  }
}

/**
 * Server-only verifier for the private proposal display route. It proves that
 * the exact canonical recipient list shown to the operator is the list bound
 * by the target-free HMAC commitment in the action arguments.
 */
export function verifyCampaignProposalDisplayTargets(
  preview: CampaignTargetPreview,
  displayTargets: readonly string[]
): boolean {
  try {
    validatePreview(preview);
    if (displayTargets.length !== preview.targetCount) return false;
    const canonical = displayTargets.map((target) => normalizeTarget(target));
    if (canonical.some((target, index) => target === null || target !== displayTargets[index])) return false;
    const targets = canonical as string[];
    if (new Set(targets).size !== targets.length) return false;
    if (targets.some((target, index) => index > 0 && targets[index - 1] >= target)) return false;
    return targetSetSha256({
      orgId: preview.orgId,
      agentId: preview.agentId,
      flowId: preview.flowId,
      datasetId: preview.datasetId,
      datasetSlug: preview.datasetSlug,
      phoneColumn: preview.phoneColumn,
      targets,
    }) === preview.targetSetSha256;
  } catch {
    return false;
  }
}

async function freezeCampaignProposalTargets(
  orgId: string,
  opts: CampaignPreviewOptions
): Promise<CampaignProposalTargetSnapshot> {
  assertUuid(orgId, "campaign organization");
  assertUuid(opts.agentId, "campaign agent");
  assertUuid(opts.flowId, "campaign flow");
  const datasetSlug = opts.datasetSlug.trim();
  const phoneColumn = opts.phoneColumn?.trim() || "phone";
  if (!DATASET_SLUG.test(datasetSlug) || !COLUMN_KEY.test(phoneColumn)) {
    throw new Error("invalid campaign dataset or phone column");
  }
  const binding = await qOne<CampaignBinding>(CAMPAIGN_BINDING_SQL, [
    orgId, datasetSlug, opts.agentId, opts.flowId,
  ]);
  if (!binding) throw new Error("campaign resources not found or not bound to this organization and agent");
  const rows = await q<{ data: Record<string, unknown> }>(
    `SELECT r.data FROM dataset_rows r
     WHERE r.org_id = $1 AND r.dataset_id = $2
     ORDER BY r.id LIMIT $3`,
    [orgId, binding.dataset_id, MAX_CAMPAIGN_TARGETS + 1]
  );
  if (rows.length > MAX_CAMPAIGN_TARGETS) throw new Error(`campaign target cap of ${MAX_CAMPAIGN_TARGETS} exceeded`);
  const normalized = normalizedTargets(rows, phoneColumn);
  if (!normalized.targets.length) throw new Error(`no valid phone numbers in "${datasetSlug}"."${phoneColumn}"`);
  const targetSha256 = targetSetSha256({
    orgId,
    agentId: opts.agentId,
    flowId: opts.flowId,
    datasetId: binding.dataset_id,
    datasetSlug,
    phoneColumn,
    targets: normalized.targets,
  });
  const admissionScopeId = campaignAdmissionScopeId({
    orgId,
    agentId: opts.agentId,
    flowId: opts.flowId,
    datasetId: binding.dataset_id,
    targetSetSha256: targetSha256,
  });
  const runtimeSet = await buildCampaignRuntimeSet({
    agentId: opts.agentId,
    orgId,
    flowId: opts.flowId,
    runtimeSetId: admissionScopeId,
    targets: normalized.targets,
  });
  const flowSha256 = hashFlowValue(AgentFlowSchema.parse(binding.flow));
  if (runtimeSet.agentVersion !== binding.agent_version
      || runtimeSet.runtimes.some((runtime) => hashFlowValue(runtime.snapshot.flow) !== flowSha256)) {
    throw new Error("campaign runtime changed while its preview was being frozen");
  }
  const preview = Object.freeze({
    schemaVersion: 1,
    orgId,
    agentId: opts.agentId,
    flowId: opts.flowId,
    datasetId: binding.dataset_id,
    datasetSlug,
    phoneColumn,
    agentVersion: binding.agent_version,
    flowSha256,
    runtimeAdmissionScopeId: admissionScopeId,
    runtimeDigest: runtimeSet.digest,
    targetSetSha256: targetSha256,
    targetCount: normalized.targets.length,
    skipped: normalized.skipped,
  });
  const snapshot = { preview } as CampaignProposalTargetSnapshot;
  // The sensitive list remains explicitly accessible to the proposal writer,
  // but is non-enumerable so JSON.stringify/object spread cannot accidentally
  // put it into tool output, SSE, chat persistence, or structured logs.
  Object.defineProperty(snapshot, "displayTargets", {
    value: Object.freeze([...normalized.targets]),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(snapshot);
}

/** Freezes a target-free commitment before confirmation or spend authority. */
export async function previewCampaign(
  orgId: string,
  opts: CampaignPreviewOptions
): Promise<CampaignTargetPreview> {
  return (await freezeCampaignProposalTargets(orgId, opts)).preview;
}

/**
 * Server-only proposal preparation. The returned recipients must never enter
 * tool output, model messages, chat persistence, logs, or SSE. Store them in
 * the private proposal row, then let the browser fetch by opaque proposal id.
 */
export async function previewCampaignForProposal(
  orgId: string,
  opts: CampaignPreviewOptions
): Promise<CampaignProposalTargetSnapshot> {
  return freezeCampaignProposalTargets(orgId, opts);
}

export type CampaignAuthorizationArguments = Readonly<{
  schema_version: 1;
  action: "run_campaign";
  org_id: string;
  agent_id: string;
  flow_id: string;
  dataset_id: string;
  dataset_slug: string;
  phone_column: string;
  agent_version: number;
  flow_sha256: string;
  runtime_admission_scope_id: string;
  runtime_digest: string;
  target_set_sha256: string;
  target_count: number;
  skipped_count: number;
  campaign_name: string;
  run_at: string | null;
  from_number: string;
  max_duration_seconds: number;
  cost_quote: OperatorCostQuoteV1;
  /** @deprecated Schema-v1 name retained for compatibility; this is a reservation, not a provider bill. */
  worst_case_micro_usd: number;
}>;

/** This exact value must be previewed, confirmed, and hashed by the authority dispatcher. */
export function campaignAuthorizationArguments(
  preview: CampaignTargetPreview,
  opts: Readonly<{
    name: string;
    runAt?: string | null;
    fromNumber: string;
    maxDurationSeconds: number;
    costQuote: OperatorCostQuoteV1;
    worstCaseMicroUsd: number;
  }>
): CampaignAuthorizationArguments {
  validatePreview(preview);
  if (!Number.isSafeInteger(opts.worstCaseMicroUsd) || opts.worstCaseMicroUsd < 1
      || opts.worstCaseMicroUsd > 1_000_000_000_000) {
    throw new Error("invalid campaign worst-case cost");
  }
  if (!E164.test(opts.fromNumber)
      || !Number.isSafeInteger(opts.maxDurationSeconds)
      || opts.maxDurationSeconds < 1 || opts.maxDurationSeconds > 86_400) {
    throw new Error("invalid campaign origin or maximum duration");
  }
  const costQuote = parseOperatorCostQuote(opts.costQuote);
  const expectedUnits = preview.targetCount * (Math.floor((opts.maxDurationSeconds - 1) / 60) + 1);
  if (!Number.isSafeInteger(expectedUnits) || expectedUnits < 1
      || costQuote.unitKind !== "voice_minute"
      || costQuote.units !== expectedUnits
      || costQuote.reservationMicroUsd !== opts.worstCaseMicroUsd) {
    throw new Error("invalid campaign spend reservation quote");
  }
  return Object.freeze({
    schema_version: 1,
    action: "run_campaign",
    org_id: preview.orgId,
    agent_id: preview.agentId,
    flow_id: preview.flowId,
    dataset_id: preview.datasetId,
    dataset_slug: preview.datasetSlug,
    phone_column: preview.phoneColumn,
    agent_version: preview.agentVersion,
    flow_sha256: preview.flowSha256,
    runtime_admission_scope_id: preview.runtimeAdmissionScopeId,
    runtime_digest: preview.runtimeDigest,
    target_set_sha256: preview.targetSetSha256,
    target_count: preview.targetCount,
    skipped_count: preview.skipped,
    campaign_name: normalizeCampaignName(opts.name),
    run_at: normalizeRunAt(opts.runAt),
    from_number: opts.fromNumber,
    max_duration_seconds: opts.maxDurationSeconds,
    cost_quote: costQuote,
    worst_case_micro_usd: opts.worstCaseMicroUsd,
  });
}

export type CampaignLaunch = {
  campaignId: string;
  targets: number;
  skipped: number;
  scheduled: boolean;
  targetSetSha256: string;
};

type ScheduledAuthorityManifest = Readonly<{
  v: 1;
  capability: "run_campaign";
  callId: string;
  orgId: string;
  operatorExecutionId: string;
  operatorArgumentsSha256: string;
  runtimeDigest: string;
  targetSetSha256: string;
  agentVersion: number;
  flowId: string;
  campaignId: string;
}>;

function campaignAuthorityManifest(input: Readonly<{
  callId: string;
  orgId: string;
  executionId: string;
  argumentsSha256: string;
  runtimeDigest: string;
  targetSetSha256: string;
  agentVersion: number;
  flowId: string;
}>): ScheduledAuthorityManifest {
  return Object.freeze({
    v: 1,
    capability: "run_campaign",
    callId: input.callId,
    orgId: input.orgId,
    operatorExecutionId: input.executionId,
    operatorArgumentsSha256: input.argumentsSha256,
    runtimeDigest: input.runtimeDigest,
    targetSetSha256: input.targetSetSha256,
    agentVersion: input.agentVersion,
    flowId: input.flowId,
    campaignId: input.executionId,
  });
}

/**
 * Atomically materializes the already-confirmed target snapshot. This function
 * performs no provider I/O. Its campaign/job identities are stable across replay.
 */
export async function launchCampaign(
  orgId: string,
  opts: Readonly<{
    preview: CampaignTargetPreview;
    name: string;
    runAt?: string | null;
    fromNumber: string;
    maxDurationSeconds: number;
    costQuote: OperatorCostQuoteV1;
    worstCaseMicroUsd: number;
    operatorExecutionId: string;
    idempotencyKey: string;
  }>
): Promise<CampaignLaunch> {
  assertUuid(orgId, "campaign organization");
  assertUuid(opts.operatorExecutionId, "operator execution");
  if (!IDEMPOTENCY_KEY.test(opts.idempotencyKey)) throw new Error("invalid campaign idempotency key");
  validatePreview(opts.preview);
  if (opts.preview.orgId !== orgId) throw new Error("campaign target snapshot belongs to another organization");
  const authorization = campaignAuthorizationArguments(opts.preview, opts);
  const argumentsSha256 = operatorActionArgumentsSha256("run_campaign", authorization);
  const preflightTargetRows = await q<{ data: Record<string, unknown> }>(
    `SELECT r.data FROM dataset_rows r
     WHERE r.org_id = $1 AND r.dataset_id = $2
     ORDER BY r.id LIMIT $3`,
    [orgId, opts.preview.datasetId, MAX_CAMPAIGN_TARGETS + 1]
  );
  if (preflightTargetRows.length > MAX_CAMPAIGN_TARGETS) {
    throw new Error("campaign target set grew beyond the confirmed cap");
  }
  const preflightTargets = normalizedTargets(preflightTargetRows, opts.preview.phoneColumn);
  const preflightTargetSha256 = targetSetSha256({
    orgId,
    agentId: opts.preview.agentId,
    flowId: opts.preview.flowId,
    datasetId: opts.preview.datasetId,
    datasetSlug: opts.preview.datasetSlug,
    phoneColumn: opts.preview.phoneColumn,
    targets: preflightTargets.targets,
  });
  if (preflightTargetSha256 !== opts.preview.targetSetSha256
      || preflightTargets.targets.length !== opts.preview.targetCount
      || preflightTargets.skipped !== opts.preview.skipped) {
    throw new Error("campaign target set changed after confirmation");
  }
  const currentQuote = createVoiceCampaignCostQuote({
    originE164: opts.fromNumber,
    destinationE164s: preflightTargets.targets,
    targetSetSha256: opts.preview.targetSetSha256,
    maxDurationSeconds: opts.maxDurationSeconds,
  });
  assertOperatorCostQuoteUsable(opts.costQuote, {
    reservationCapMicroUsd: opts.worstCaseMicroUsd,
    expectedUnitKind: "voice_minute",
    expectedPricingSnapshotSha256: currentQuote.pricingSnapshotSha256,
    expectedFormulaSha256: currentQuote.formulaSha256,
    expectedLimitsSha256: currentQuote.limitsSha256,
  });
  const runtimeSet = await buildCampaignRuntimeSet({
    agentId: opts.preview.agentId,
    orgId,
    flowId: opts.preview.flowId,
    runtimeSetId: opts.preview.runtimeAdmissionScopeId,
    targets: preflightTargets.targets,
  });
  if (runtimeSet.agentVersion !== opts.preview.agentVersion
      || runtimeSet.digest !== opts.preview.runtimeDigest
      || runtimeSet.runtimes.some((runtime) =>
        hashFlowValue(runtime.snapshot.flow) !== opts.preview.flowSha256
      )) {
    throw new Error("campaign runtime changed after confirmation");
  }
  const runtimeByCallId = new Map(runtimeSet.runtimes.map((runtime) => [
    runtime.admissionScopeId,
    runtime,
  ]));
  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const execution = await client.query<{
      actor_email: string;
      arguments_sha256: string;
      status: string;
      estimated_units: number;
      estimated_micro_usd: string;
    }>(
      `SELECT actor_email, arguments_sha256, status, estimated_units,
              estimated_micro_usd::text
       FROM operator_action_executions
       WHERE id = $1 AND org_id = $2 AND capability = 'run_campaign'
         AND idempotency_key = $3
       FOR UPDATE`,
      [opts.operatorExecutionId, orgId, opts.idempotencyKey]
    );
    const authority = execution.rows[0];
    if (!authority
        || authority.status !== "dispatching"
        || authority.arguments_sha256 !== argumentsSha256
        || authority.estimated_units !== opts.costQuote.units
        || Number(authority.estimated_micro_usd) !== opts.worstCaseMicroUsd) {
      throw new Error("campaign operator authority is missing or does not match the frozen launch");
    }

    const binding = await client.query<CampaignBinding>(`${CAMPAIGN_BINDING_SQL} FOR SHARE OF d, a, f`, [
      orgId, opts.preview.datasetSlug, opts.preview.agentId, opts.preview.flowId,
    ]);
    const currentBinding = binding.rows[0];
    if (currentBinding?.dataset_id !== opts.preview.datasetId
        || currentBinding.agent_version !== opts.preview.agentVersion
        || currentBinding.phone_number !== opts.fromNumber
        || hashFlowValue(AgentFlowSchema.parse(currentBinding.flow)) !== opts.preview.flowSha256) {
      throw new Error("campaign resources changed after confirmation");
    }
    const targetRows = await client.query<{ data: Record<string, unknown> }>(
      `SELECT r.data FROM dataset_rows r
       WHERE r.org_id = $1 AND r.dataset_id = $2
       ORDER BY r.id LIMIT $3
       FOR SHARE`,
      [orgId, opts.preview.datasetId, MAX_CAMPAIGN_TARGETS + 1]
    );
    if (targetRows.rows.length > MAX_CAMPAIGN_TARGETS) {
      throw new Error("campaign target set grew beyond the confirmed cap");
    }
    const normalized = normalizedTargets(targetRows.rows, opts.preview.phoneColumn);
    const observedTargetSha256 = targetSetSha256({
      orgId,
      agentId: opts.preview.agentId,
      flowId: opts.preview.flowId,
      datasetId: opts.preview.datasetId,
      datasetSlug: opts.preview.datasetSlug,
      phoneColumn: opts.preview.phoneColumn,
      targets: normalized.targets,
    });
    if (observedTargetSha256 !== opts.preview.targetSetSha256
        || normalized.targets.length !== opts.preview.targetCount
        || normalized.skipped !== opts.preview.skipped
        || normalized.targets.some((target, index) => target !== preflightTargets.targets[index])) {
      throw new Error("campaign target set changed after confirmation");
    }

    const existing = await client.query<{
      agent_id: string;
      flow_id: string;
      name: string;
      dataset_slug: string;
      phone_column: string;
      run_at: Date | string | null;
      created_by: string;
      created_at: Date | string;
    }>(
      `SELECT agent_id, flow_id, name, dataset_slug, phone_column, run_at, created_by, created_at
       FROM campaigns WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [opts.operatorExecutionId, orgId]
    );
    const runAt = authorization.run_at;
    const createdBy = `operator (${authority.actor_email})`;
    const reason = `campaign:${opts.operatorExecutionId}`;
    const expectedJob = (target: string) => {
      const callId = scheduledCallId(opts.preview.runtimeAdmissionScopeId, target);
      const runtime = runtimeByCallId.get(callId);
      if (!runtime) throw new Error("campaign runtime set is missing a target-bound call");
      return {
        callId,
        runtime,
        authorityManifest: campaignAuthorityManifest({
          callId,
          orgId,
          executionId: opts.operatorExecutionId,
          argumentsSha256,
          runtimeDigest: runtime.digest,
          targetSetSha256: opts.preview.targetSetSha256,
          agentVersion: opts.preview.agentVersion,
          flowId: opts.preview.flowId,
        }),
      };
    };
    if (existing.rows[0]) {
      const row = existing.rows[0];
      const storedRunAt = row.run_at ? new Date(row.run_at).toISOString() : null;
      const campaignCreatedAt = new Date(row.created_at);
      if (!Number.isFinite(campaignCreatedAt.getTime())) {
        throw new Error("campaign materialization timestamp is invalid");
      }
      const materializedRunAt = runAt ?? campaignCreatedAt.toISOString();
      if (row.agent_id !== opts.preview.agentId || row.flow_id !== opts.preview.flowId
          || row.name !== authorization.campaign_name
          || row.dataset_slug !== opts.preview.datasetSlug
          || row.phone_column !== opts.preview.phoneColumn
          || storedRunAt !== runAt || row.created_by !== createdBy) {
        throw new Error("campaign execution identity conflicts with an existing campaign");
      }
      const storedJobs = await client.query<{
        id: string;
        org_id: string;
        agent_id: string;
        agent_version: number;
        to_number: string;
        run_at: Date | string;
        reason: string | null;
        created_by: string;
        flow_id: string | null;
        campaign_id: string | null;
        operator_execution_id: string | null;
        operator_arguments_sha256: string | null;
        runtime_snapshot: unknown;
        runtime_digest: string | null;
        target_set_sha256: string | null;
        authority_manifest: unknown;
      }>(
        `SELECT id, org_id, agent_id, agent_version, to_number, run_at, reason,
                created_by, flow_id, campaign_id, operator_execution_id,
                operator_arguments_sha256, runtime_snapshot, runtime_digest,
                target_set_sha256, authority_manifest
         FROM scheduled_calls WHERE campaign_id = $1 ORDER BY to_number FOR SHARE`,
        [opts.operatorExecutionId]
      );
      const storedTargets = [...new Set(storedJobs.rows.map((row) => row.to_number))].sort();
      if (storedJobs.rows.length !== opts.preview.targetCount
          || targetSetSha256({
            orgId,
            agentId: opts.preview.agentId,
            flowId: opts.preview.flowId,
            datasetId: opts.preview.datasetId,
            datasetSlug: opts.preview.datasetSlug,
            phoneColumn: opts.preview.phoneColumn,
            targets: storedTargets,
          }) !== opts.preview.targetSetSha256
          || storedJobs.rows.some((job) => {
            const expected = expectedJob(job.to_number);
            return job.id !== expected.callId
              || job.org_id !== orgId
              || job.agent_id !== opts.preview.agentId
              || job.agent_version !== opts.preview.agentVersion
              || job.reason !== reason
              || job.created_by !== createdBy
              || job.flow_id !== opts.preview.flowId
              || job.campaign_id !== opts.operatorExecutionId
              || job.operator_execution_id !== opts.operatorExecutionId
              || job.operator_arguments_sha256 !== argumentsSha256
              || job.runtime_digest !== expected.runtime.digest
              || job.target_set_sha256 !== opts.preview.targetSetSha256
              || new Date(job.run_at).toISOString() !== materializedRunAt
              || hashFlowValue(job.runtime_snapshot) !== expected.runtime.digest
              || hashFlowValue(job.authority_manifest) !== hashFlowValue(expected.authorityManifest);
          })) {
        throw new Error("campaign execution exists with an incomplete or conflicting job set");
      }
      for (const job of storedJobs.rows) {
        parseCallRuntimeSnapshot(job.runtime_snapshot, expectedJob(job.to_number).runtime.digest);
      }
      await client.query("COMMIT");
      return {
        campaignId: opts.operatorExecutionId,
        targets: opts.preview.targetCount,
        skipped: opts.preview.skipped,
        scheduled: runAt !== null,
        targetSetSha256: opts.preview.targetSetSha256,
      };
    }

    const campaign = await client.query<{ id: string; created_at: Date | string }>(
      `INSERT INTO campaigns
         (id, org_id, agent_id, flow_id, name, dataset_slug, phone_column, status, run_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, created_at`,
      [
        opts.operatorExecutionId,
        orgId,
        opts.preview.agentId,
        opts.preview.flowId,
        authorization.campaign_name,
        opts.preview.datasetSlug,
        opts.preview.phoneColumn,
        runAt ? "scheduled" : "running",
        runAt,
        createdBy,
      ]
    );
    if (campaign.rows[0]?.id !== opts.operatorExecutionId) throw new Error("campaign materialization failed");
    const campaignCreatedAt = new Date(campaign.rows[0].created_at);
    if (!Number.isFinite(campaignCreatedAt.getTime())) {
      throw new Error("campaign materialization timestamp is invalid");
    }
    const materializedRunAt = runAt ?? campaignCreatedAt.toISOString();
    const expectedJobs = normalized.targets.map(expectedJob);
    const jobIds = expectedJobs.map((job) => job.callId);
    const jobs = await client.query(
      `WITH input_jobs AS (
         SELECT * FROM unnest(
           $1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[]
         ) AS job(id, to_number, runtime_snapshot_json, runtime_digest, authority_manifest_json)
       )
       INSERT INTO scheduled_calls
         (id, org_id, agent_id, agent_version, to_number, run_at, reason, created_by,
          flow_id, campaign_id, status, operator_execution_id, operator_arguments_sha256,
          runtime_snapshot, runtime_digest, target_set_sha256, authority_manifest)
       SELECT job.id, $6, $7, $8, job.to_number, $9::timestamptz,
              $10, $11, $12, $13, 'pending', $13, $14,
              job.runtime_snapshot_json::jsonb, job.runtime_digest, $15,
              job.authority_manifest_json::jsonb
       FROM input_jobs job
       RETURNING id`,
      [
        jobIds,
        normalized.targets,
        expectedJobs.map((job) => JSON.stringify(job.runtime.snapshot)),
        expectedJobs.map((job) => job.runtime.digest),
        expectedJobs.map((job) => JSON.stringify(job.authorityManifest)),
        orgId,
        opts.preview.agentId,
        opts.preview.agentVersion,
        materializedRunAt,
        reason,
        createdBy,
        opts.preview.flowId,
        opts.operatorExecutionId,
        argumentsSha256,
        opts.preview.targetSetSha256,
      ]
    );
    if (jobs.rowCount !== normalized.targets.length) throw new Error("campaign job materialization was incomplete");
    await client.query("COMMIT");
    L.info("campaign materialized", {
      orgId,
      data: {
        campaignId: opts.operatorExecutionId,
        targets: normalized.targets.length,
        targetSetSha256: opts.preview.targetSetSha256,
        runAt,
      },
    });
    return {
      campaignId: opts.operatorExecutionId,
      targets: normalized.targets.length,
      skipped: normalized.skipped,
      scheduled: runAt !== null,
      targetSetSha256: opts.preview.targetSetSha256,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

type DialScope = Readonly<{ orgId: string; campaignId: string }>;

type ClaimedScheduledCall = Readonly<{
  id: string;
  org_id: string;
  claim_token: string;
  agent_id: string;
  agent_version: number;
  to_number: string;
  attempts: number;
  reason: string | null;
  flow_id: string | null;
  campaign_id: string | null;
  parent_call_id: string | null;
  runtime_snapshot: unknown;
  runtime_digest: string;
  max_duration_seconds: number;
}>;

/**
 * Conservatively closes scheduler crashes that happened after the durable
 * external-effect boundary. The five-minute post-lease grace is far longer
 * than the provider timeout. These jobs become terminally indeterminate; the
 * query never performs provider I/O and never makes a job reclaimable.
 */
export async function reconcileStalePostBoundaryDispatches(limit: number = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("invalid reconciliation batch limit");
  }
  const reconciled = await q<{ id: string }>(
    `WITH candidate_campaigns AS MATERIALIZED (
       SELECT c.id, c.org_id
       FROM campaigns c
       WHERE c.status IN ('scheduled','running','indeterminate')
         AND EXISTS (
           SELECT 1 FROM scheduled_calls s
           WHERE s.campaign_id = c.id AND s.org_id = c.org_id
             AND s.status = 'dialing'
             AND s.dispatch_started_at IS NOT NULL
             AND s.completed_call_id IS NOT NULL
             AND s.claim_lease_expires_at <= now() - interval '5 minutes'
         )
       ORDER BY c.created_at, c.id
       LIMIT 20
       FOR UPDATE OF c SKIP LOCKED
     ), orphaned AS MATERIALIZED (
       SELECT s.id, s.campaign_id, s.org_id
       FROM scheduled_calls s
       JOIN candidate_campaigns c
         ON c.id = s.campaign_id AND c.org_id = s.org_id
       WHERE s.status = 'dialing'
         AND s.dispatch_started_at IS NOT NULL
         AND s.completed_call_id IS NOT NULL
         AND s.claim_lease_expires_at <= now() - interval '5 minutes'
       ORDER BY s.dispatch_started_at, s.id
       LIMIT $1
       FOR UPDATE OF s SKIP LOCKED
     ), marked AS (
       UPDATE scheduled_calls s
       SET status = 'indeterminate', claim_token = NULL,
           claim_lease_expires_at = NULL
       FROM orphaned
       WHERE s.id = orphaned.id
         AND s.campaign_id = orphaned.campaign_id
         AND s.org_id = orphaned.org_id
         AND s.status = 'dialing'
         AND s.dispatch_started_at IS NOT NULL
         AND s.completed_call_id IS NOT NULL
         AND s.claim_lease_expires_at <= now() - interval '5 minutes'
       RETURNING s.id, s.campaign_id, s.org_id
     ), affected_campaigns AS (
       SELECT DISTINCT campaign_id, org_id FROM marked
     ), campaigns_marked AS (
       UPDATE campaigns c
       SET status = 'indeterminate'
       FROM affected_campaigns affected
       WHERE c.id = affected.campaign_id AND c.org_id = affected.org_id
         AND c.status IN ('scheduled','running','indeterminate')
       RETURNING c.id, c.org_id
     ), canceled_safe_remainder AS (
       UPDATE scheduled_calls s
       SET status = 'canceled', claim_token = NULL,
           claim_lease_expires_at = NULL
       FROM campaigns_marked campaign
       WHERE s.campaign_id = campaign.id AND s.org_id = campaign.org_id
         AND (
           s.status = 'pending'
           OR (s.status = 'dialing' AND s.dispatch_started_at IS NULL)
         )
       RETURNING s.id
     )
     SELECT id FROM marked`,
    [limit]
  );
  return reconciled.length;
}

/**
 * Writes recipient-free, append-only quarantine receipts for a bounded set of
 * campaign effects that have remained unknown for at least 24 hours. The
 * campaign and every scheduled effect remain indeterminate; only configuration
 * edit locks consult the receipt. Replaying the sweep is idempotent.
 */
export async function quarantineStaleIndeterminateCampaigns(limit: number = 25): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("invalid quarantine batch limit");
  }
  const quarantined = await q<{ quarantined_campaign_id: string }>(
    `SELECT quarantined_campaign_id
     FROM quarantine_stale_indeterminate_campaigns($1)`,
    [limit]
  );
  return quarantined.length;
}

/** Claims and dials due work. Campaign-scoped claims must include the owning org. */
export async function dialDue(limit: number, scope?: DialScope): Promise<Record<string, string>> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid dial batch limit");
  if (scope) {
    assertUuid(scope.orgId, "campaign organization");
    assertUuid(scope.campaignId, "campaign");
  }
  const { originateCall } = await import("./telephony");
  await q(
    `UPDATE campaigns c SET status = 'running'
     FROM operator_action_executions oe
     WHERE oe.id = c.id AND oe.org_id = c.org_id
       AND oe.capability = 'run_campaign' AND oe.status = 'succeeded'
       AND c.status = 'scheduled' AND c.run_at <= now()
       AND ($1::uuid IS NULL OR (c.id = $1 AND c.org_id = $2))`,
    [scope?.campaignId ?? null, scope?.orgId ?? null]
  );
  const due = await q<ClaimedScheduledCall>(
    `WITH due AS (
       SELECT s.id
       FROM scheduled_calls s
       JOIN agents a ON a.id = s.agent_id AND a.org_id = s.org_id
       LEFT JOIN campaigns c
         ON c.id = s.campaign_id AND c.org_id = s.org_id
       LEFT JOIN operator_action_executions campaign_oe
         ON campaign_oe.id = c.id AND campaign_oe.org_id = c.org_id
            AND campaign_oe.capability = 'run_campaign'
       LEFT JOIN operator_action_executions direct_oe
         ON direct_oe.id = s.operator_execution_id AND direct_oe.org_id = s.org_id
            AND direct_oe.capability = 'schedule_call'
       JOIN operator_action_approvals approval
         ON approval.consumed_execution_id = s.operator_execution_id
        AND approval.org_id = s.org_id
       WHERE s.run_at <= now()
         AND (
           s.status = 'pending'
           OR (
             s.status = 'dialing'
             AND s.dispatch_started_at IS NULL
             AND s.claim_lease_expires_at <= now()
           )
         )
         AND s.operator_execution_id IS NOT NULL
         AND s.operator_arguments_sha256 IS NOT NULL
         AND s.runtime_snapshot IS NOT NULL
         AND s.runtime_digest IS NOT NULL
         AND s.agent_version IS NOT NULL
         AND s.authority_manifest IS NOT NULL
         AND jsonb_typeof(approval.action_arguments->'max_duration_seconds') = 'number'
         AND approval.action_arguments->>'max_duration_seconds' ~ '^[1-9][0-9]{0,4}$'
         AND (approval.action_arguments->>'max_duration_seconds')::integer BETWEEN 1 AND 86400
         AND s.authority_manifest = jsonb_build_object(
           'v', 1,
           'capability', s.authority_manifest->'capability',
           'callId', s.id::text,
           'orgId', s.org_id::text,
           'operatorExecutionId', s.operator_execution_id::text,
           'operatorArgumentsSha256', s.operator_arguments_sha256,
           'runtimeDigest', s.runtime_digest,
           'targetSetSha256', CASE
             WHEN s.target_set_sha256 IS NULL THEN 'null'::jsonb
             ELSE to_jsonb(s.target_set_sha256)
           END,
           'agentVersion', s.agent_version,
           'flowId', CASE
             WHEN s.flow_id IS NULL THEN 'null'::jsonb
             ELSE to_jsonb(s.flow_id::text)
           END,
           'campaignId', CASE
             WHEN s.campaign_id IS NULL THEN 'null'::jsonb
             ELSE to_jsonb(s.campaign_id::text)
           END
         )
         AND (
           (
             s.campaign_id IS NOT NULL
             AND c.agent_id = s.agent_id
             AND c.flow_id = s.flow_id
             AND c.status = 'running'
             AND s.operator_execution_id = c.id
             AND s.target_set_sha256 IS NOT NULL
             AND campaign_oe.status = 'succeeded'
             AND campaign_oe.arguments_sha256 = s.operator_arguments_sha256
             AND s.authority_manifest->>'capability' = 'run_campaign'
           )
           OR (
             s.campaign_id IS NULL
             AND s.flow_id IS NULL
             AND s.target_set_sha256 IS NULL
             AND direct_oe.status = 'succeeded'
             AND direct_oe.arguments_sha256 = s.operator_arguments_sha256
             AND s.authority_manifest->>'capability' = 'schedule_call'
           )
         )
         AND ($2::uuid IS NULL OR (
           s.campaign_id = $2 AND s.org_id = $3
           AND c.org_id = $3 AND a.org_id = $3
         ))
       ORDER BY s.run_at, s.id
       LIMIT $1
       FOR UPDATE OF s SKIP LOCKED
     )
     UPDATE scheduled_calls s
     SET status = 'dialing', attempts = attempts + 1,
         claim_token = gen_random_uuid(), claimed_at = now(),
         claim_lease_expires_at = now() + interval '60 seconds'
     FROM due
     WHERE s.id = due.id
     RETURNING s.id, s.org_id, s.claim_token, s.agent_id, s.agent_version,
               s.to_number, s.attempts, s.reason, s.flow_id, s.campaign_id,
               s.parent_call_id, s.runtime_snapshot, s.runtime_digest,
               (SELECT (approval.action_arguments->>'max_duration_seconds')::integer
                FROM operator_action_approvals approval
                WHERE approval.consumed_execution_id = s.operator_execution_id
                  AND approval.org_id = s.org_id) AS max_duration_seconds`,
    [limit, scope?.campaignId ?? null, scope?.orgId ?? null]
  );
  const results: Record<string, string> = {};
  await Promise.all(due.map(async (job) => {
    try {
      const runtime = parseCallRuntimeSnapshot(job.runtime_snapshot, job.runtime_digest);
      const outcome = await originateCall(job.agent_id, job.to_number, job.reason, {
        scheduledCallId: job.id,
        claimToken: job.claim_token,
        expectedAgentVersion: job.agent_version,
        maxDurationSeconds: job.max_duration_seconds,
        runtimeSnapshot: runtime.snapshot,
        runtimeDigest: runtime.digest,
      });
      results[job.id] = `${outcome.status}:${outcome.code}:${outcome.callId}`;
    } catch (error) {
      // A throw can occur either before the durable external-effect boundary,
      // or after that boundary if local settlement becomes unavailable. Only
      // the former is safe to mark failed/reclaimable; the latter is terminally
      // ambiguous and must never be automatically retried.
      let preDispatchReleased = false;
      try {
        const failed = await q(
          `UPDATE scheduled_calls
           SET status = 'failed', claim_token = NULL, claim_lease_expires_at = NULL
           WHERE id = $1 AND claim_token = $2 AND status = 'dialing'
             AND dispatch_started_at IS NULL AND claim_lease_expires_at > now()
           RETURNING id`,
          [job.id, job.claim_token]
        );
        preDispatchReleased = failed.length === 1;
      } catch {
        // A database outage preserves the lease state. The schema permits
        // reclaim only while dispatch_started_at remains NULL.
      }
      if (preDispatchReleased) {
        results[job.id] = "failed:pre_dispatch_rejected";
        L.error("scheduled call rejected before provider dispatch", {
          data: { job: job.id, error: error instanceof Error ? error.message : String(error) },
        });
        return;
      }
      let markedIndeterminate = false;
      try {
        const indeterminate = await q(
          `UPDATE scheduled_calls
           SET status = 'indeterminate', claim_token = NULL, claim_lease_expires_at = NULL
           WHERE id = $1 AND claim_token = $2 AND status = 'dialing'
             AND dispatch_started_at IS NOT NULL
           RETURNING id`,
          [job.id, job.claim_token]
        );
        markedIndeterminate = indeterminate.length === 1;
      } catch {
        // A post-boundary dialing row is deliberately not lease-reclaimable.
      }
      results[job.id] = markedIndeterminate
        ? "indeterminate:local_settlement_unknown_do_not_retry"
        : "indeterminate:dispatch_ownership_lost_do_not_retry";
      L.error("dial outcome indeterminate", {
        data: {
          job: job.id,
          error: error instanceof Error ? error.message : String(error),
          ...acceptedProviderSettlementDetail(error),
        },
      });
    }
  }));
  await closeFinishedCampaigns(scope);
  return results;
}

/** Marks campaigns done only when every effect is terminal and known. */
async function closeFinishedCampaigns(scope?: DialScope): Promise<void> {
  await q(
    `WITH campaigns_marked AS (
       UPDATE campaigns c SET status = 'indeterminate'
       WHERE c.status IN ('running','scheduled')
         AND ($1::uuid IS NULL OR (c.id = $1 AND c.org_id = $2))
         AND EXISTS (
           SELECT 1 FROM scheduled_calls s
           WHERE s.campaign_id = c.id AND s.org_id = c.org_id
             AND s.status = 'indeterminate'
         )
       RETURNING c.id, c.org_id
     ), canceled_safe_remainder AS (
       UPDATE scheduled_calls s
       SET status = 'canceled', claim_token = NULL,
           claim_lease_expires_at = NULL
       FROM campaigns_marked campaign
       WHERE s.campaign_id = campaign.id AND s.org_id = campaign.org_id
         AND (
           s.status = 'pending'
           OR (s.status = 'dialing' AND s.dispatch_started_at IS NULL)
         )
       RETURNING s.id
     )
     SELECT id FROM campaigns_marked`,
    [scope?.campaignId ?? null, scope?.orgId ?? null]
  );
  await q(
    `UPDATE campaigns c SET status = 'done'
     WHERE c.status IN ('running','scheduled')
       AND ($1::uuid IS NULL OR (c.id = $1 AND c.org_id = $2))
       AND NOT EXISTS (
         SELECT 1 FROM scheduled_calls s
         WHERE s.campaign_id = c.id AND s.status IN ('pending','dialing','indeterminate')
       )
       AND NOT EXISTS (
         SELECT 1 FROM calls x
         WHERE x.campaign_id = c.id AND x.status IN ('active','dialing')
       )
       AND EXISTS (SELECT 1 FROM scheduled_calls s WHERE s.campaign_id = c.id)`,
    [scope?.campaignId ?? null, scope?.orgId ?? null]
  );
}

/** Fast start for an owned campaign. Foreign campaign ids claim zero work. */
export async function kickCampaign(orgId: string, campaignId: string): Promise<Record<string, string>> {
  assertUuid(orgId, "campaign organization");
  assertUuid(campaignId, "campaign");
  // Never rewrite the approved schedule. dialDue promotes only a due,
  // successfully-authorized campaign and claims through the same org scope.
  return dialDue(KICK_PARALLEL, { orgId, campaignId });
}

export async function cancelCampaign(orgId: string, campaignId: string): Promise<number> {
  assertUuid(orgId, "campaign organization");
  assertUuid(campaignId, "campaign");
  const rows = await q(
    `WITH owned AS (
       UPDATE campaigns
       SET status = CASE WHEN status = 'indeterminate' THEN status ELSE 'canceled' END
       WHERE id = $1 AND org_id = $2 AND status IN ('scheduled','running','indeterminate')
       RETURNING id
     )
     UPDATE scheduled_calls s
     SET status = 'canceled', claim_token = NULL, claim_lease_expires_at = NULL
     FROM owned
     WHERE s.campaign_id = owned.id
       AND (
         s.status = 'pending'
         OR (s.status = 'dialing' AND s.dispatch_started_at IS NULL)
       )
     RETURNING s.id`,
    [campaignId, orgId]
  );
  return rows.length;
}

export async function campaignStats(orgId: string) {
  return q(
    `SELECT c.id, c.name, c.status, c.run_at, c.dataset_slug, c.created_at,
            f.name AS flow_name, a.name AS agent,
       (reconciliation.campaign_id IS NOT NULL) AS configuration_lock_released,
       CASE WHEN reconciliation.campaign_id IS NOT NULL
         THEN 'quarantined_unknown_effects' ELSE NULL
       END AS reconciliation_outcome,
       CASE WHEN reconciliation.campaign_id IS NOT NULL
         THEN false ELSE NULL
       END AS reconciliation_delivery_verified,
       reconciliation.reconciled_at AS quarantined_at,
       reconciliation.indeterminate_job_count,
       reconciliation.provider_identity_job_count,
       reconciliation.evidence_sha256 AS quarantine_evidence_sha256,
       (SELECT count(*) FROM scheduled_calls s WHERE s.campaign_id = c.id) AS total,
       (SELECT count(*) FROM scheduled_calls s WHERE s.campaign_id = c.id AND s.status = 'pending') AS pending,
       (SELECT count(*) FROM calls x WHERE x.campaign_id = c.id AND x.status = 'completed') AS answered,
       (SELECT count(*) FROM calls x WHERE x.campaign_id = c.id AND x.status IN ('failed','no-answer')) AS missed,
       (SELECT round(avg(x.satisfaction),1) FROM calls x WHERE x.campaign_id = c.id AND x.satisfaction IS NOT NULL) AS avg_satisfaction
     FROM campaigns c
     JOIN flows f ON f.id = c.flow_id AND f.org_id = c.org_id
     JOIN agents a ON a.id = c.agent_id AND a.org_id = c.org_id
     LEFT JOIN campaign_dispatch_reconciliations reconciliation
       ON reconciliation.campaign_id = c.id AND reconciliation.org_id = c.org_id
     WHERE c.org_id = $1 AND c.status IN ('running','scheduled','indeterminate')
     ORDER BY c.created_at DESC LIMIT 50`,
    [orgId]
  );
}

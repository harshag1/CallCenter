import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { getPool } from "../db";
import { loadVoiceProviderCredential } from "../voice-provider-credentials";
import { resolveVoiceProviderConfig } from "./config";
import { browserSpeechGuardrailConfigForCall } from "./browser-speech-guardrail-config.server";
import {
  outboundSpeechAsrBudgetAuthority,
  reservedOutboundSpeechAsrMicroUsd,
} from "./outbound-speech-asr-config.server";
import type { IndependentSpeechAsrReceipt } from "./outbound-speech-gate";

const MAX_ASR_RESPONSES_PER_WEB_CALL = 128;
const MAX_ASR_PCM_BYTES_PER_WEB_CALL = 128 * 1024 * 1024;
const MAX_ASR_AUDIO_MS_PER_WEB_CALL = 30 * 60 * 1_000;
const ALLOWED_SAMPLE_RATES = new Set([16_000, 24_000, 44_100, 48_000]);

type VoiceProvider = "openai" | "xai" | "gemini";
type FundingSource = "tenant_openai_byok";

type Queryable = Pick<PoolClient, "query">;

export type OutboundSpeechAsrAuthorityDependencies = Readonly<{
  connect: () => Promise<Pick<PoolClient, "query" | "release">>;
  randomUUID: () => string;
  loadTenantOpenAiCredential: (organizationId: string) => Promise<string | null>;
  environment: Readonly<Record<string, string | undefined>>;
}>;

const defaultDependencies: OutboundSpeechAsrAuthorityDependencies = {
  connect: () => getPool().connect(),
  randomUUID,
  loadTenantOpenAiCredential: (organizationId) => loadVoiceProviderCredential({
    orgId: organizationId,
    provider: "openai",
  }),
  environment: process.env,
};

export class OutboundSpeechAsrAuthorityError extends Error {
  constructor(
    readonly code:
      | "call_unavailable"
      | "wrong_direction"
      | "provider_mismatch"
      | "guardrail_unavailable"
      | "funding_unavailable"
      | "budget_exhausted"
      | "identity_conflict"
      | "already_consumed"
      | "storage_unavailable",
  ) {
    super(`outbound speech ASR authority failed: ${code}`);
    this.name = "OutboundSpeechAsrAuthorityError";
  }
}

export type OutboundSpeechAsrClaimInput = Readonly<{
  organizationId: string;
  callId: string;
  provider: VoiceProvider;
  responseId: string;
  audioSha256: string;
  audioBytes: number;
  sampleRateHz: number;
  audioDurationMs: number;
}>;

export type OutboundSpeechAsrClaim =
  | Readonly<{
      kind: "cached";
      receipt: unknown;
      receiptHmacKey: string;
    }>
  | Readonly<{
      kind: "claimed";
      authorityId: string;
      claimToken: string;
      fundingSource: FundingSource;
      apiKey: string;
      reservedMicroUsd: number;
      receiptHmacKey: string;
    }>;

type CallRow = QueryResultRow & {
  status: string;
  direction: string;
  settings: Record<string, unknown>;
};

type ExistingRow = QueryResultRow & {
  authority_id: string;
  provider: string;
  audio_sha256: string;
  audio_bytes: number | string;
  sample_rate_hz: number | string;
  audio_duration_ms: number | string;
  state: string;
  receipt_json: unknown;
};

type AggregateRow = QueryResultRow & {
  response_count: number | string;
  audio_bytes: number | string;
  audio_duration_ms: number | string;
  reserved_micro_usd: number | string;
};

function exactNonNegativeInteger(value: number | string, label: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OutboundSpeechAsrAuthorityError("storage_unavailable");
  }
  void label;
  return parsed;
}

function matchesExisting(row: ExistingRow, input: OutboundSpeechAsrClaimInput): boolean {
  return row.provider === input.provider
    && row.audio_sha256 === input.audioSha256
    && exactNonNegativeInteger(row.audio_bytes, "audio bytes") === input.audioBytes
    && exactNonNegativeInteger(row.sample_rate_hz, "sample rate") === input.sampleRateHz
    && Math.abs(Number(row.audio_duration_ms) - input.audioDurationMs) <= 0.001;
}

async function resolveFunding(
  organizationId: string,
  dependencies: OutboundSpeechAsrAuthorityDependencies,
): Promise<Readonly<{
  source: FundingSource;
  apiKey: string;
  maxMicroUsdPerCall: number;
  maxMicroUsdPerOrganizationDay: number;
  receiptHmacKey: string;
}>> {
  let budget: ReturnType<typeof outboundSpeechAsrBudgetAuthority>;
  try {
    budget = outboundSpeechAsrBudgetAuthority(dependencies.environment);
  } catch {
    throw new OutboundSpeechAsrAuthorityError("funding_unavailable");
  }
  let tenantCredential: string | null;
  try {
    tenantCredential = await dependencies.loadTenantOpenAiCredential(organizationId);
  } catch {
    throw new OutboundSpeechAsrAuthorityError("funding_unavailable");
  }
  if (tenantCredential) {
    return Object.freeze({
      source: "tenant_openai_byok" as const,
      apiKey: tenantCredential,
      maxMicroUsdPerCall: budget.maxMicroUsdPerCall,
      maxMicroUsdPerOrganizationDay: budget.maxMicroUsdPerOrganizationDay,
      receiptHmacKey: budget.receiptHmacKey,
    });
  }
  throw new OutboundSpeechAsrAuthorityError("funding_unavailable");
}

/** Token-mint preflight: proves tenant-owned ASR funding exists without
 * returning its plaintext credential to the route or browser. */
export async function assertOutboundSpeechAsrTenantFundingAvailable(
  organizationId: string,
  dependencies: OutboundSpeechAsrAuthorityDependencies = defaultDependencies,
): Promise<void> {
  await resolveFunding(organizationId, dependencies);
}

function validateAudio(input: OutboundSpeechAsrClaimInput): number {
  if (
    !ALLOWED_SAMPLE_RATES.has(input.sampleRateHz)
    || !Number.isSafeInteger(input.audioBytes)
    || input.audioBytes <= 0
    || input.audioBytes % 2 !== 0
    || input.audioBytes > 16 * 1024 * 1024
  ) {
    throw new OutboundSpeechAsrAuthorityError("identity_conflict");
  }
  const exactDurationMs = input.audioBytes / 2 / input.sampleRateHz * 1_000;
  if (
    !Number.isFinite(input.audioDurationMs)
    || Math.abs(input.audioDurationMs - exactDurationMs) > 0.001
  ) {
    throw new OutboundSpeechAsrAuthorityError("identity_conflict");
  }
  return reservedOutboundSpeechAsrMicroUsd(input.audioDurationMs);
}

async function rollback(client: Queryable): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original authority error is safer and contains no provider secret.
  }
}

/**
 * Serializes admission on the call row, then consumes one immutable
 * call/provider/response/audio reservation before any provider request.
 */
export async function claimOutboundSpeechAsrAuthority(
  input: OutboundSpeechAsrClaimInput,
  dependencies: OutboundSpeechAsrAuthorityDependencies = defaultDependencies,
): Promise<OutboundSpeechAsrClaim> {
  const reservedMicroUsd = validateAudio(input);
  let budget: ReturnType<typeof outboundSpeechAsrBudgetAuthority>;
  try {
    budget = outboundSpeechAsrBudgetAuthority(dependencies.environment);
  } catch {
    throw new OutboundSpeechAsrAuthorityError("funding_unavailable");
  }
  const authorityId = dependencies.randomUUID();
  const claimToken = dependencies.randomUUID();
  const client = await dependencies.connect().catch(() => {
    throw new OutboundSpeechAsrAuthorityError("storage_unavailable");
  });
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const callResult = await client.query<CallRow>(
      `SELECT c.status, c.direction, v.settings
       FROM calls c
       JOIN agents a ON a.id = c.agent_id
       JOIN agent_versions v
         ON v.agent_id = c.agent_id AND v.version = c.agent_version
       WHERE c.id = $1::uuid AND a.org_id = $2::uuid
       FOR UPDATE OF c`,
      [input.callId, input.organizationId],
    );
    const call = callResult.rows[0];
    if (!call || call.status !== "active") {
      throw new OutboundSpeechAsrAuthorityError("call_unavailable");
    }
    if (call.direction !== "web") {
      throw new OutboundSpeechAsrAuthorityError("wrong_direction");
    }
    if (resolveVoiceProviderConfig(call.settings).provider !== input.provider) {
      throw new OutboundSpeechAsrAuthorityError("provider_mismatch");
    }
    let guardrail: ReturnType<typeof browserSpeechGuardrailConfigForCall>;
    try {
      guardrail = browserSpeechGuardrailConfigForCall({
        settings: call.settings,
        provider: input.provider,
        organizationId: input.organizationId,
        callId: input.callId,
        environment: dependencies.environment,
      });
    } catch {
      throw new OutboundSpeechAsrAuthorityError("guardrail_unavailable");
    }
    if (
      !guardrail
      || input.audioBytes > guardrail.policy.maxBufferedAudioBytes
      || input.audioDurationMs > guardrail.policy.maxBufferedAudioMs
    ) {
      throw new OutboundSpeechAsrAuthorityError("guardrail_unavailable");
    }

    const existingResult = await client.query<ExistingRow>(
      `SELECT authority_id, provider, audio_sha256, audio_bytes,
              sample_rate_hz, audio_duration_ms, state, receipt_json
       FROM hacc_private.outbound_speech_asr_authorities
       WHERE org_id = $1::uuid AND call_id = $2::uuid AND response_id = $3`,
      [input.organizationId, input.callId, input.responseId],
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (!matchesExisting(existing, input)) {
        throw new OutboundSpeechAsrAuthorityError("identity_conflict");
      }
      if (existing.state === "settled" && existing.receipt_json) {
        await client.query("COMMIT");
        return Object.freeze({
          kind: "cached" as const,
          receipt: existing.receipt_json,
          receiptHmacKey: budget.receiptHmacKey,
        });
      }
      throw new OutboundSpeechAsrAuthorityError("already_consumed");
    }

    let tenantCredential: string | null;
    try {
      tenantCredential = await dependencies.loadTenantOpenAiCredential(input.organizationId);
    } catch {
      throw new OutboundSpeechAsrAuthorityError("funding_unavailable");
    }
    if (!tenantCredential) throw new OutboundSpeechAsrAuthorityError("funding_unavailable");
    const funding = Object.freeze({
      source: "tenant_openai_byok" as const,
      apiKey: tenantCredential,
      maxMicroUsdPerCall: budget.maxMicroUsdPerCall,
      maxMicroUsdPerOrganizationDay: budget.maxMicroUsdPerOrganizationDay,
      receiptHmacKey: budget.receiptHmacKey,
    });

    // The call-row lock serializes responses within one call. This independent
    // tenant lock serializes the daily budget across many calls for the same
    // organization, so call minting cannot amplify tenant-owned ASR spend.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, $2::bigint))",
      [input.organizationId, 1_217_312_835],
    );
    const organizationResult = await client.query<{ reserved_micro_usd: number | string }>(
      `SELECT COALESCE(sum(reserved_micro_usd), 0)::bigint AS reserved_micro_usd
       FROM hacc_private.outbound_speech_asr_authorities
       WHERE org_id = $1::uuid
         AND claimed_at >= (
           date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC')
           AT TIME ZONE 'UTC'
         )`,
      [input.organizationId],
    );
    const organizationReserved = exactNonNegativeInteger(
      organizationResult.rows[0]?.reserved_micro_usd ?? -1,
      "organization daily ASR reservation",
    );
    if (
      organizationReserved + reservedMicroUsd
      > funding.maxMicroUsdPerOrganizationDay
    ) {
      throw new OutboundSpeechAsrAuthorityError("budget_exhausted");
    }

    const aggregateResult = await client.query<AggregateRow>(
      `SELECT count(*)::int AS response_count,
              COALESCE(sum(audio_bytes), 0)::bigint AS audio_bytes,
              COALESCE(sum(audio_duration_ms), 0)::double precision AS audio_duration_ms,
              COALESCE(sum(reserved_micro_usd), 0)::bigint AS reserved_micro_usd
       FROM hacc_private.outbound_speech_asr_authorities
       WHERE org_id = $1::uuid AND call_id = $2::uuid`,
      [input.organizationId, input.callId],
    );
    const totals = aggregateResult.rows[0];
    if (!totals) throw new OutboundSpeechAsrAuthorityError("storage_unavailable");
    const responseCount = exactNonNegativeInteger(totals.response_count, "response count");
    const audioBytes = exactNonNegativeInteger(totals.audio_bytes, "aggregate audio bytes");
    const audioDurationMs = Number(totals.audio_duration_ms);
    const reservedTotal = exactNonNegativeInteger(
      totals.reserved_micro_usd,
      "aggregate ASR reservation",
    );
    if (
      !Number.isFinite(audioDurationMs)
      || responseCount + 1 > MAX_ASR_RESPONSES_PER_WEB_CALL
      || audioBytes + input.audioBytes > MAX_ASR_PCM_BYTES_PER_WEB_CALL
      || audioDurationMs + input.audioDurationMs > MAX_ASR_AUDIO_MS_PER_WEB_CALL
      || reservedTotal + reservedMicroUsd > funding.maxMicroUsdPerCall
    ) {
      throw new OutboundSpeechAsrAuthorityError("budget_exhausted");
    }

    const inserted = await client.query(
      `INSERT INTO hacc_private.outbound_speech_asr_authorities (
         authority_id, org_id, call_id, response_id, provider,
         audio_sha256, audio_bytes, sample_rate_hz, audio_duration_ms,
         reserved_micro_usd, funding_source, claim_token, state
       ) VALUES (
         $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid,'claimed'
       )
       RETURNING authority_id`,
      [
        authorityId,
        input.organizationId,
        input.callId,
        input.responseId,
        input.provider,
        input.audioSha256,
        input.audioBytes,
        input.sampleRateHz,
        input.audioDurationMs,
        reservedMicroUsd,
        funding.source,
        claimToken,
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new OutboundSpeechAsrAuthorityError("storage_unavailable");
    }
    await client.query("COMMIT");
    return Object.freeze({
      kind: "claimed" as const,
      authorityId,
      claimToken,
      fundingSource: funding.source,
      apiKey: funding.apiKey,
      reservedMicroUsd,
      receiptHmacKey: funding.receiptHmacKey,
    });
  } catch (error) {
    await rollback(client);
    if (error instanceof OutboundSpeechAsrAuthorityError) throw error;
    throw new OutboundSpeechAsrAuthorityError("storage_unavailable");
  } finally {
    client.release();
  }
}

async function updateClaimedAuthority(
  input: Readonly<{
    authorityId: string;
    claimToken: string;
    sql: string;
    params?: readonly unknown[];
  }>,
  dependencies: OutboundSpeechAsrAuthorityDependencies,
): Promise<void> {
  try {
    const client = await dependencies.connect();
    try {
      const result = await client.query(
        input.sql,
        [input.authorityId, input.claimToken, ...(input.params ?? [])],
      );
      if (result.rowCount !== 1) {
        throw new OutboundSpeechAsrAuthorityError("already_consumed");
      }
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof OutboundSpeechAsrAuthorityError) throw error;
    throw new OutboundSpeechAsrAuthorityError("storage_unavailable");
  }
}

export function markOutboundSpeechAsrDispatched(
  input: Readonly<{ authorityId: string; claimToken: string }>,
  dependencies: OutboundSpeechAsrAuthorityDependencies = defaultDependencies,
): Promise<void> {
  return updateClaimedAuthority({
    ...input,
    sql: `UPDATE hacc_private.outbound_speech_asr_authorities
          SET state = 'dispatched', dispatched_at = transition.at,
              updated_at = transition.at
          FROM (SELECT clock_timestamp() AS at) AS transition
          WHERE authority_id = $1::uuid AND claim_token = $2::uuid
            AND state = 'claimed' AND dispatched_at IS NULL AND terminal_at IS NULL`,
  }, dependencies);
}

export function settleOutboundSpeechAsrAuthority(
  input: Readonly<{
    authorityId: string;
    claimToken: string;
    receipt: IndependentSpeechAsrReceipt;
  }>,
  dependencies: OutboundSpeechAsrAuthorityDependencies = defaultDependencies,
): Promise<void> {
  return updateClaimedAuthority({
    authorityId: input.authorityId,
    claimToken: input.claimToken,
    sql: `UPDATE hacc_private.outbound_speech_asr_authorities
          SET state = 'settled', receipt_json = $3::jsonb,
              terminal_at = transition.at, updated_at = transition.at
          FROM (SELECT clock_timestamp() AS at) AS transition
          WHERE authority_id = $1::uuid AND claim_token = $2::uuid
            AND state = 'dispatched' AND dispatched_at IS NOT NULL
            AND terminal_at IS NULL AND receipt_json IS NULL`,
    params: [JSON.stringify(input.receipt)],
  }, dependencies);
}

export function failOutboundSpeechAsrAuthority(
  input: Readonly<{
    authorityId: string;
    claimToken: string;
  } & (
    | { afterDispatch: false; failureCode: "local_failure" }
    | {
        afterDispatch: true;
        failureCode: "provider_outcome_unknown" | "settlement_unknown";
      }
  )>,
  dependencies: OutboundSpeechAsrAuthorityDependencies = defaultDependencies,
): Promise<void> {
  // After the durable dispatch boundary, even an HTTP/network/parse failure
  // may have incurred provider spend. Preserve that ambiguity and never label
  // it as a retryable pre-dispatch failure.
  const state = input.afterDispatch ? "indeterminate" : "failed";
  const expectedState = input.afterDispatch ? "dispatched" : "claimed";
  return updateClaimedAuthority({
    authorityId: input.authorityId,
    claimToken: input.claimToken,
    sql: `UPDATE hacc_private.outbound_speech_asr_authorities
          SET state = '${state}', failure_code = $3,
              terminal_at = transition.at, updated_at = transition.at
          FROM (SELECT clock_timestamp() AS at) AS transition
          WHERE authority_id = $1::uuid AND claim_token = $2::uuid
            AND state = '${expectedState}' AND terminal_at IS NULL`,
    params: [input.failureCode],
  }, dependencies);
}

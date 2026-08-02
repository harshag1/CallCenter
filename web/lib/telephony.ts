// Author: Harsha Gundala
// telephony.ts — Twilio: outbound origination into the media-stream bridge, number search + purchase.

import twilioSdk from "twilio";
import { createHmac } from "node:crypto";
import { getPool, q } from "./db";
import { log } from "./log";
import { requirePublicOrigin } from "./public-origin";
import { parseCallRuntimeSnapshot, type CallRuntimeSnapshot } from "./call-runtime-snapshot";
import { assertVoiceQuoteCoversCurrentPricing } from "./operator-pricing";
import {
  operatorActionArgumentsSha256,
  type FundedOperatorCapability,
} from "./agent/tools/operator-capability-policy";
export { requirePublicOrigin } from "./public-origin";

const L = log("telephony");
const TW = "https://api.twilio.com/2010-04-01";

const MAX_TWILIO_WEBHOOK_BYTES = 64 * 1024;
const MAX_TWILIO_CALLBACK_URL_BYTES = 8 * 1024;
const MAX_TWILIO_RESPONSE_BYTES = 256 * 1024;
const TWILIO_REQUEST_TIMEOUT_MS = 15_000;
const CALL_SID_PATTERN = /^CA[0-9a-fA-F]{32}$/;
const ACCOUNT_SID_PATTERN = /^AC[0-9a-fA-F]{32}$/;
const API_KEY_SID_PATTERN = /^SK[0-9a-fA-F]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AcceptedTelephonyDeliveryReceipt = Readonly<{
  status: "accepted";
  evidence_source: "provider_create_response";
  verified_terminal: false;
  provider_message_id: string;
  account_binding_sha256: string;
  recipient_binding_sha256: string;
}>;

export type VerifiedTelephonyDeliveryReceipt = Readonly<{
  status: "delivered" | "terminal_failure";
  evidence_source: "verified_status_webhook";
  verified_terminal: true;
  provider_message_id: string;
  provider_status: "completed" | "busy" | "no-answer" | "canceled" | "failed";
  account_binding_sha256: string;
  recipient_binding_sha256: string;
  terminal_proof_sha256: string;
  sequence: number;
}>;

function deliveryReceiptHmac(label: string, value: unknown): string {
  return createHmac("sha256", telephonyReceiptSecret())
    .update(`harshas-amazing-call-center/telephony-delivery/${label}/v1\n`, "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function telephonyReceiptSecret(): string {
  const secret = process.env.TELEPHONY_RECEIPT_SECRET;
  if (!secret || secret.length < 32 || secret.length > 256
      || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw new Error("TELEPHONY_RECEIPT_SECRET must contain 32-256 control-free characters");
  }
  if ([
    process.env.TWILIO_AUTH_TOKEN,
    process.env.TWILIO_AUTH_TOKEN_NEXT,
    process.env.TWILIO_API_KEY_SECRET,
    process.env.MCP_GATEWAY_SECRET,
  ].some((credential) => credential && credential === secret)) {
    throw new Error("TELEPHONY_RECEIPT_SECRET must be domain-specific and distinct from provider credentials");
  }
  return secret;
}

function deliveryBindings(input: Readonly<{
  callId: string;
  providerAccountSid: string;
  recipient: string;
}>): Readonly<{ account: string; recipient: string }> {
  if (!UUID_PATTERN.test(input.callId) || !ACCOUNT_SID_PATTERN.test(input.providerAccountSid)) {
    throw new Error("invalid telephony delivery identity");
  }
  const recipient = normalizeE164(input.recipient);
  if (!recipient) throw new Error("invalid telephony delivery recipient");
  return Object.freeze({
    account: deliveryReceiptHmac("account-binding", {
      call_id: input.callId,
      provider_account_id: input.providerAccountSid,
    }),
    recipient: deliveryReceiptHmac("recipient-binding", {
      call_id: input.callId,
      recipient,
    }),
  });
}

export function acceptedTelephonyDeliveryReceipt(input: Readonly<{
  callId: string;
  providerCallSid: string;
  providerAccountSid: string;
  recipient: string;
}>): AcceptedTelephonyDeliveryReceipt {
  if (!CALL_SID_PATTERN.test(input.providerCallSid)) {
    throw new Error("invalid telephony delivery provider identity");
  }
  const bindings = deliveryBindings(input);
  return Object.freeze({
    status: "accepted",
    evidence_source: "provider_create_response",
    verified_terminal: false,
    provider_message_id: input.providerCallSid,
    account_binding_sha256: bindings.account,
    recipient_binding_sha256: bindings.recipient,
  });
}

export function verifiedTelephonyDeliveryReceipt(input: Readonly<{
  callId: string;
  providerCallSid: string;
  providerAccountSid: string;
  recipient: string;
  providerStatus: VerifiedTelephonyDeliveryReceipt["provider_status"];
  sequence: number;
}>): VerifiedTelephonyDeliveryReceipt {
  if (!CALL_SID_PATTERN.test(input.providerCallSid)
      || !Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new Error("invalid verified telephony delivery evidence");
  }
  const bindings = deliveryBindings(input);
  const status = input.providerStatus === "completed" ? "delivered" : "terminal_failure";
  const core = Object.freeze({
    status,
    evidence_source: "verified_status_webhook" as const,
    verified_terminal: true as const,
    provider_message_id: input.providerCallSid,
    provider_status: input.providerStatus,
    account_binding_sha256: bindings.account,
    recipient_binding_sha256: bindings.recipient,
    sequence: input.sequence,
  });
  return Object.freeze({
    ...core,
    terminal_proof_sha256: deliveryReceiptHmac("terminal-proof", {
      call_id: input.callId,
      ...core,
    }),
  });
}

export function twilioAccountSid(): string {
  const v = process.env.TWILIO_ACCOUNT_SID;
  if (!v || !ACCOUNT_SID_PATTERN.test(v)) throw new Error("TWILIO_ACCOUNT_SID must be a valid AccountSid");
  return v;
}

export function twilioAuthToken(): string {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || token.length < 16 || token.length > 256 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new Error("TWILIO_AUTH_TOKEN is required for webhook verification");
  }
  return token;
}

function twilioAuthTokenCandidates(): readonly string[] {
  const primary = twilioAuthToken();
  const next = process.env.TWILIO_AUTH_TOKEN_NEXT;
  if (next === undefined || next === "") return Object.freeze([primary]);
  if (next.length < 16 || next.length > 256 || /[\u0000-\u001f\u007f]/.test(next)) {
    throw new Error("TWILIO_AUTH_TOKEN_NEXT is malformed");
  }
  if (next === primary) throw new Error("TWILIO_AUTH_TOKEN_NEXT must differ from TWILIO_AUTH_TOKEN");
  return Object.freeze([primary, next]);
}

function validateTwilioSignature(
  signature: string,
  canonicalUrl: string,
  parameters: Record<string, string | string[]>,
): boolean {
  let valid = false;
  // Always evaluate every configured candidate. This bounded two-token window
  // spans Twilio's instantaneous secondary-to-primary promotion without making
  // request contents or token order part of authority.
  for (const token of twilioAuthTokenCandidates()) {
    valid = twilioSdk.validateRequest(token, signature, canonicalUrl, parameters) || valid;
  }
  return valid;
}

/**
 * Basic-auth credentials for outbound Twilio REST mutations and reads.
 *
 * Twilio uses the same SK-shaped SID for Standard and Restricted keys, so the
 * deployment must explicitly attest the key type. The Account SID/Auth Token
 * pair is intentionally never accepted here; it remains scoped to validating
 * Twilio-signed inbound webhooks and Media Stream upgrades.
 */
export function twilioRestAuthorization(): string {
  const keyType = process.env.TWILIO_API_KEY_TYPE;
  const keyAccountSid = process.env.TWILIO_API_KEY_ACCOUNT_SID;
  const keySid = process.env.TWILIO_API_KEY_SID;
  const keySecret = process.env.TWILIO_API_KEY_SECRET;
  if (keyType !== "restricted") {
    throw new Error("TWILIO_API_KEY_TYPE must be restricted for Twilio REST access");
  }
  if (keyAccountSid !== twilioAccountSid()) {
    throw new Error("TWILIO_API_KEY_ACCOUNT_SID must exactly match TWILIO_ACCOUNT_SID");
  }
  if (!keySid || !API_KEY_SID_PATTERN.test(keySid)) {
    throw new Error("TWILIO_API_KEY_SID must be a valid restricted API key SID");
  }
  if (!keySecret || keySecret.length < 20 || keySecret.length > 256
      || /[\u0000-\u001f\u007f]/.test(keySecret)) {
    throw new Error("TWILIO_API_KEY_SECRET is required for Twilio REST access");
  }
  return Buffer.from(`${keySid}:${keySecret}`).toString("base64");
}

export function normalizeE164(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 128) return null;
  const normalized = value.trim().replace(/[() .-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(normalized) ? normalized : null;
}

/** Return the exact configured bytes because Twilio signs the literal Media Stream URL. */
export function requireBridgeWsUrl(): string {
  const configured = process.env.BRIDGE_WS_URL;
  if (!configured || configured.length > 2_048 || configured.trim() !== configured) {
    throw new Error("BRIDGE_WS_URL is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("BRIDGE_WS_URL must be an absolute URL");
  }
  if (
    parsed.protocol !== "wss:" || !parsed.hostname || parsed.username || parsed.password ||
    parsed.search || parsed.hash || configured.includes("?") || configured.includes("#")
  ) {
    throw new Error("BRIDGE_WS_URL must be a credential-free wss URL without query or fragment");
  }
  return configured;
}

function canonicalCallbackUrl(req: Request): string {
  const received = new URL(req.url);
  const canonical = `${requirePublicOrigin()}${received.pathname}${received.search}`;
  if (Buffer.byteLength(canonical, "utf8") > MAX_TWILIO_CALLBACK_URL_BYTES) {
    throw new Error("Twilio callback URL is too large");
  }
  return canonical;
}

function hasDuplicateParameters(params: URLSearchParams): boolean {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function formObject(params: URLSearchParams): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of params) {
    const prior = result[key];
    if (prior === undefined) result[key] = value;
    else if (Array.isArray(prior)) prior.push(value);
    else result[key] = [prior, value];
  }
  return result;
}

export type VerifiedTwilioRequest = {
  canonicalUrl: string;
  form: URLSearchParams;
  query: URLSearchParams;
  rawBody: string;
};

/** Uses Twilio's official validator and rejects before callers are allowed to query the database. */
export async function verifyTwilioWebhook(req: Request): Promise<VerifiedTwilioRequest | null> {
  try {
    if (req.method !== "GET" && req.method !== "POST") return null;
    const signature = req.headers.get("x-twilio-signature");
    if (!signature || signature.length > 256) return null;
    const canonicalUrl = canonicalCallbackUrl(req);
    const query = new URL(canonicalUrl).searchParams;
    // Twilio signs every occurrence, but route semantics consume one value per
    // identity field. Reject duplicates so signature validation and authority
    // interpretation can never disagree about which value was authorized.
    if (hasDuplicateParameters(query)) return null;
    let rawBody = "";
    let form = new URLSearchParams();
    if (req.method === "POST") {
      const contentType = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/x-www-form-urlencoded") return null;
      const advertised = req.headers.get("content-length");
      if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_TWILIO_WEBHOOK_BYTES)) return null;
      rawBody = await req.text();
      if (Buffer.byteLength(rawBody, "utf8") > MAX_TWILIO_WEBHOOK_BYTES) return null;
      form = new URLSearchParams(rawBody);
      if (hasDuplicateParameters(form)) return null;
    }
    if (!validateTwilioSignature(
      signature,
      canonicalUrl,
      req.method === "POST" ? formObject(form) : {}
    )) return null;
    return {
      canonicalUrl,
      form,
      query,
      rawBody,
    };
  } catch {
    return null;
  }
}

/** Validates a Media Streams upgrade against the exact configured public wss URL. */
export function verifyTwilioStreamUpgrade(req: Request): boolean {
  try {
    const configured = requireBridgeWsUrl();
    const expected = new URL(configured);
    const received = new URL(req.url);
    if (received.pathname !== expected.pathname || received.search !== expected.search) return false;
    const signature = req.headers.get("x-twilio-signature");
    return !!signature && signature.length <= 256 && validateTwilioSignature(
      signature, configured, {}
    );
  } catch {
    return false;
  }
}

class TwilioRequestError extends Error {
  constructor(message: string, readonly outcome: "rejected" | "indeterminate") {
    super(message);
    this.name = "TwilioRequestError";
  }
}

async function twilioResponseJson(res: Response): Promise<Record<string, unknown>> {
  const advertised = res.headers.get("content-length");
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_TWILIO_RESPONSE_BYTES)) {
    throw new Error("Twilio response is too large");
  }
  if (!res.body) return {};
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_TWILIO_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Twilio response is too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

async function twilio(path: string, form?: Record<string, string | readonly string[]>): Promise<Record<string, unknown>> {
  const encoded = new URLSearchParams();
  for (const [key, value] of Object.entries(form ?? {})) {
    if (Array.isArray(value)) for (const item of value) encoded.append(key, item);
    else encoded.append(key, value as string);
  }
  let res: Response;
  try {
    res = await fetch(`${TW}/Accounts/${twilioAccountSid()}${path}`, {
      method: form ? "POST" : "GET",
      headers: {
        Authorization: `Basic ${twilioRestAuthorization()}`,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? encoded : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(TWILIO_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new TwilioRequestError(
      `Twilio request outcome is unknown: ${error instanceof Error ? error.message : "network failure"}`,
      "indeterminate"
    );
  }
  let json: Record<string, unknown> = {};
  try {
    json = await twilioResponseJson(res);
  } catch (error) {
    if (res.ok) {
      throw new TwilioRequestError(
        `Twilio response outcome is unknown: ${error instanceof Error ? error.message : "invalid response"}`,
        "indeterminate"
      );
    }
  }
  if (!res.ok) {
    throw new TwilioRequestError(
      `Twilio request was rejected with HTTP ${res.status}`,
      res.status >= 500 || res.status === 408 ? "indeterminate" : "rejected"
    );
  }
  return json as Record<string, unknown>;
}

/** Places an outbound call: Twilio dials the callee; on answer the leg streams into the bridge. */
export type OriginateOpts = Readonly<{
  scheduledCallId: string;
  claimToken: string;
  expectedAgentVersion: number;
  /** Exact approved connected-call ceiling, enforced by Twilio TimeLimit. */
  maxDurationSeconds: number;
  runtimeSnapshot: CallRuntimeSnapshot;
  runtimeDigest: string;
}>;

export type OriginateResult = Readonly<{
  callId: string;
  status: "failed" | "indeterminate";
  code: "provider_rejected" | "provider_outcome_unknown_do_not_retry";
}> | Readonly<{
  callId: string;
  status: "accepted";
  code: "provider_accepted";
  delivery: AcceptedTelephonyDeliveryReceipt;
}>;

/** A provider call exists, but local lifecycle settlement did not complete. Never redial it. */
export class AcceptedProviderSettlementError extends Error {
  readonly code = "provider_accepted_local_settlement_unknown_do_not_retry";

  constructor(
    readonly callId: string,
    readonly providerCallSid: string,
    readonly providerAccountSid: string,
    cause: unknown
  ) {
    super("provider accepted the call but local settlement is incomplete", { cause });
    this.name = "AcceptedProviderSettlementError";
  }
}

function retryableAdmissionTransaction(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "40001" || code === "40P01";
}

type ScheduledVoiceAuthority = Readonly<{
  id: string;
  org_id: string;
  agent_id: string;
  agent_version: number;
  flow_id: string | null;
  campaign_id: string | null;
  runtime_digest: string;
  target_set_sha256: string | null;
  operator_capability: string;
  current_operator_arguments_sha256: string;
  current_estimated_units: number;
  current_estimated_micro_usd: string;
  approved_action_arguments: unknown;
  approval_arguments_sha256: string;
  approval_estimated_units: number;
  approval_estimated_micro_usd: string;
}>;

/** Rebuild delayed spend authority from the consumed, immutable human approval. */
function assertScheduledVoicePricingAuthority(input: Readonly<{
  job: ScheduledVoiceAuthority;
  from: string;
  to: string;
  maxDurationSeconds: number;
}>): void {
  const { job } = input;
  const capability = job.operator_capability as FundedOperatorCapability;
  if (capability !== "place_call" && capability !== "schedule_call" && capability !== "run_campaign") {
    throw new Error("scheduled call has no approved voice capability");
  }
  if (!job.approved_action_arguments || typeof job.approved_action_arguments !== "object"
      || Array.isArray(job.approved_action_arguments)) {
    throw new Error("scheduled call approval arguments are unavailable");
  }
  const args = job.approved_action_arguments as Record<string, unknown>;
  const calculatedArgumentsSha256 = operatorActionArgumentsSha256(capability, args);
  if (calculatedArgumentsSha256 !== job.current_operator_arguments_sha256
      || job.approval_arguments_sha256 !== job.current_operator_arguments_sha256
      || args.from_number !== input.from
      || args.max_duration_seconds !== input.maxDurationSeconds
      || args.agent_id !== job.agent_id
      || args.agent_version !== job.agent_version
      || args.runtime_digest !== job.runtime_digest) {
    throw new Error("scheduled call approval no longer matches its exact runtime binding");
  }

  const billedMinutesPerTarget = Math.floor((input.maxDurationSeconds - 1) / 60) + 1;
  let expectedUnits = billedMinutesPerTarget;
  if (capability === "run_campaign") {
    const targetCount = args.target_count;
    if (args.action !== "run_campaign"
        || args.org_id !== job.org_id
        || args.flow_id !== job.flow_id
        || args.target_set_sha256 !== job.target_set_sha256
        || !Number.isSafeInteger(targetCount) || Number(targetCount) < 1
        || Number(targetCount) > 5_000) {
      throw new Error("campaign approval no longer matches its exact call authority");
    }
    expectedUnits = billedMinutesPerTarget * Number(targetCount);
  } else if (args.to_number !== input.to
      || args.runtime_admission_scope_id !== job.id
      || job.campaign_id !== null || job.target_set_sha256 !== null) {
    throw new Error("direct-call approval no longer matches its exact destination authority");
  }
  if (!Number.isSafeInteger(expectedUnits) || expectedUnits < 1) {
    throw new Error("scheduled call approved unit count is invalid");
  }

  const quote = assertVoiceQuoteCoversCurrentPricing(args.cost_quote, {
    expectedUnits,
    maxDurationSeconds: input.maxDurationSeconds,
  });
  if (job.current_estimated_units !== quote.units
      || job.approval_estimated_units !== quote.units
      || Number(job.current_estimated_micro_usd) !== quote.reservationMicroUsd
      || Number(job.approval_estimated_micro_usd) !== quote.reservationMicroUsd) {
    throw new Error("scheduled call reservation does not match the consumed approval");
  }
}

async function settleDispatch(input: {
  scheduledCallId: string;
  claimToken: string;
  status: "done" | "failed" | "indeterminate";
  code: "provider_accepted" | "provider_rejected" | "provider_outcome_unknown_do_not_retry";
  twilioCallSid?: string;
  twilioAccountSid?: string;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const call = await client.query<{ id: string }>(
      `UPDATE calls
       SET twilio_call_sid = COALESCE(twilio_call_sid, $2),
           twilio_account_sid = COALESCE(twilio_account_sid, $3),
           twilio_status = CASE WHEN $4 = 'done' THEN COALESCE(twilio_status, 'queued') ELSE twilio_status END,
           twilio_status_rank = CASE WHEN $4 = 'done' THEN GREATEST(twilio_status_rank, 10) ELSE twilio_status_rank END,
           status = CASE WHEN $4 = 'done' THEN status ELSE 'failed' END,
           ended_at = CASE WHEN $4 = 'done' THEN ended_at ELSE COALESCE(ended_at, now()) END,
           metadata = metadata || jsonb_build_object(
             'dispatch_outcome', $5,
             'dispatch_settled_at', now()
           )
       WHERE id = $1 AND scheduled_call_id = $1
         AND ($2::text IS NULL OR twilio_call_sid IS NULL OR twilio_call_sid = $2)
         AND ($3::text IS NULL OR twilio_account_sid IS NULL OR twilio_account_sid = $3)
       RETURNING id`,
      [
        input.scheduledCallId,
        input.twilioCallSid ?? null,
        input.twilioAccountSid ?? null,
        input.status,
        input.code,
      ]
    );
    if (call.rowCount !== 1) throw new Error("call settlement identity mismatch");
    const scheduled = await client.query<{ id: string }>(
      `UPDATE scheduled_calls
       SET status = $3, completed_call_id = $1, claim_token = NULL,
           claim_lease_expires_at = NULL
       WHERE id = $1 AND dispatch_started_at IS NOT NULL AND completed_call_id = $1
         AND (
           (claim_token = $2 AND status = 'dialing')
           OR (claim_token IS NULL AND status = $3)
         )
       RETURNING id`,
      [input.scheduledCallId, input.claimToken, input.status]
    );
    if (scheduled.rowCount !== 1) throw new Error("scheduled call settlement ownership lost");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function stampAcceptedProviderIdentity(input: {
  scheduledCallId: string;
  twilioCallSid: string;
  twilioAccountSid: string;
  deliveryReceipt: AcceptedTelephonyDeliveryReceipt;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const stamped = await q<{ id: string }>(
        `UPDATE calls
         SET twilio_call_sid = COALESCE(twilio_call_sid, $2),
             twilio_account_sid = COALESCE(twilio_account_sid, $3),
             twilio_status = COALESCE(twilio_status, 'queued'),
             twilio_status_rank = GREATEST(twilio_status_rank, 10),
             metadata = metadata || jsonb_build_object(
               'dispatch_outcome', 'provider_accepted_identity_recorded',
               'provider_identity_recorded_at', now(),
               'delivery_receipt', COALESCE(metadata->'delivery_receipt', $4::jsonb)
             )
         WHERE id = $1 AND scheduled_call_id = $1
           AND (twilio_call_sid IS NULL OR twilio_call_sid = $2)
           AND (twilio_account_sid IS NULL OR twilio_account_sid = $3)
         RETURNING id`,
        [
          input.scheduledCallId,
          input.twilioCallSid,
          input.twilioAccountSid,
          JSON.stringify(input.deliveryReceipt),
        ]
      );
      if (stamped.length !== 1) throw new Error("accepted provider identity conflicts with the reserved call");
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw new AcceptedProviderSettlementError(
    input.scheduledCallId,
    input.twilioCallSid,
    input.twilioAccountSid,
    lastError
  );
}

export async function originateCall(
  agentId: string,
  toNumber: string,
  reason: string | null,
  opts: OriginateOpts
): Promise<OriginateResult> {
  if (!UUID_PATTERN.test(agentId) || !UUID_PATTERN.test(opts.scheduledCallId) || !UUID_PATTERN.test(opts.claimToken)) {
    throw new Error("invalid scheduled call dispatch identity");
  }
  if (!Number.isSafeInteger(opts.expectedAgentVersion) || opts.expectedAgentVersion < 1) {
    throw new Error("invalid expected agent version");
  }
  if (!Number.isSafeInteger(opts.maxDurationSeconds)
      || opts.maxDurationSeconds < 1 || opts.maxDurationSeconds > 86_400) {
    throw new Error("invalid approved maximum call duration");
  }
  const to = normalizeE164(toNumber);
  if (!to) throw new Error("toNumber must be E.164");
  const runtime = parseCallRuntimeSnapshot(opts.runtimeSnapshot, opts.runtimeDigest);
  if (runtime.snapshot.agentVersion !== opts.expectedAgentVersion) {
    throw new Error("runtime snapshot agent version mismatch");
  }
  const origin = requirePublicOrigin();
  requireBridgeWsUrl();
  twilioAuthToken();
  twilioRestAuthorization();
  telephonyReceiptSecret();
  const accountSid = twilioAccountSid();

  const client = await getPool().connect();
  let from = "";
  try {
    for (let admissionAttempt = 0; admissionAttempt < 3; admissionAttempt += 1) {
      let commitAttempted = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    // Cancellation takes the campaign lock before touching jobs. Use that same
    // order so either cancellation wins before this boundary or dispatch does.
    const campaignLock = await client.query<{
      id: string;
      org_id: string;
      agent_id: string;
      flow_id: string;
      status: string;
      operator_execution_id: string;
      operator_capability: string;
      operator_status: string;
      operator_arguments_sha256: string;
    }>(
      `SELECT c.id, c.org_id, c.agent_id, c.flow_id, c.status,
              oe.id AS operator_execution_id, oe.capability AS operator_capability,
              oe.status AS operator_status, oe.arguments_sha256 AS operator_arguments_sha256
       FROM scheduled_calls s
       JOIN campaigns c ON c.id = s.campaign_id AND c.org_id = s.org_id
       JOIN operator_action_executions oe ON oe.id = s.operator_execution_id AND oe.org_id = s.org_id
       WHERE s.id = $1
       FOR UPDATE OF c`,
      [opts.scheduledCallId]
    );
    const locked = await client.query<{
      id: string;
      agent_id: string;
      org_id: string;
      to_number: string;
      reason: string | null;
      flow_id: string | null;
      campaign_id: string | null;
      parent_call_id: string | null;
      agent_version: number;
      runtime_snapshot: unknown;
      runtime_digest: string;
      phone_number: string | null;
      dispatch_started_at: string | null;
      operator_execution_id: string;
      operator_arguments_sha256: string;
      target_set_sha256: string | null;
      manifest_capability: string;
      authority_valid: boolean;
      operator_capability: string;
      operator_status: string;
      current_operator_arguments_sha256: string;
      current_estimated_units: number;
      current_estimated_micro_usd: string;
      approved_action_arguments: unknown;
      approval_arguments_sha256: string;
      approval_estimated_units: number;
      approval_estimated_micro_usd: string;
    }>(
      `SELECT s.id, s.agent_id, s.org_id, s.to_number, s.reason, s.flow_id,
              s.campaign_id, s.parent_call_id, s.agent_version, s.runtime_snapshot,
              s.runtime_digest, a.phone_number, s.dispatch_started_at,
              s.operator_execution_id, s.operator_arguments_sha256, s.target_set_sha256,
              s.authority_manifest->>'capability' AS manifest_capability,
              s.authority_manifest = jsonb_build_object(
                'v', 1,
                'capability', s.authority_manifest->'capability',
                'callId', s.id::text,
                'orgId', s.org_id::text,
                'operatorExecutionId', s.operator_execution_id::text,
                'operatorArgumentsSha256', s.operator_arguments_sha256,
                'runtimeDigest', s.runtime_digest,
                'targetSetSha256', CASE WHEN s.target_set_sha256 IS NULL
                  THEN 'null'::jsonb ELSE to_jsonb(s.target_set_sha256) END,
                'agentVersion', s.agent_version,
                'flowId', CASE WHEN s.flow_id IS NULL
                  THEN 'null'::jsonb ELSE to_jsonb(s.flow_id::text) END,
                'campaignId', CASE WHEN s.campaign_id IS NULL
                  THEN 'null'::jsonb ELSE to_jsonb(s.campaign_id::text) END
              ) AS authority_valid,
              oe.capability AS operator_capability, oe.status AS operator_status,
              oe.arguments_sha256 AS current_operator_arguments_sha256,
              oe.estimated_units AS current_estimated_units,
              oe.estimated_micro_usd::text AS current_estimated_micro_usd,
              approval.action_arguments AS approved_action_arguments,
              approval.arguments_sha256 AS approval_arguments_sha256,
              approval.estimated_units AS approval_estimated_units,
              approval.estimated_micro_usd::text AS approval_estimated_micro_usd
       FROM scheduled_calls s
       JOIN agents a ON a.id = s.agent_id AND a.org_id = s.org_id
       JOIN operator_action_executions oe
         ON oe.id = s.operator_execution_id AND oe.org_id = s.org_id
       JOIN operator_action_approvals approval
         ON approval.consumed_execution_id = oe.id
        AND approval.org_id = oe.org_id
        AND approval.capability = oe.capability
        AND approval.approved_at IS NOT NULL
       WHERE s.id = $1 AND s.claim_token = $2 AND s.status = 'dialing'
         AND s.claim_lease_expires_at > now()
       FOR UPDATE OF s`,
      [opts.scheduledCallId, opts.claimToken]
    );
    const job = locked.rows[0];
    if (!job || job.dispatch_started_at) throw new Error("scheduled call is not exclusively dispatchable");
    const storedRuntime = parseCallRuntimeSnapshot(job.runtime_snapshot, job.runtime_digest);
    if (
      job.agent_id !== agentId || normalizeE164(job.to_number) !== to ||
      job.reason !== reason || job.agent_version !== opts.expectedAgentVersion ||
      job.runtime_digest !== runtime.digest || storedRuntime.digest !== runtime.digest ||
      !job.authority_valid || job.operator_arguments_sha256 !== job.current_operator_arguments_sha256 ||
      job.manifest_capability !== job.operator_capability
    ) throw new Error("scheduled call authority does not match the requested dispatch");

    const campaign = campaignLock.rows[0] ?? null;
    if (job.campaign_id !== null) {
      if (
        !campaign || campaign.id !== job.campaign_id || campaign.id !== job.operator_execution_id ||
        campaign.org_id !== job.org_id || campaign.agent_id !== job.agent_id ||
        campaign.flow_id !== job.flow_id || campaign.status !== "running" ||
        campaign.operator_execution_id !== job.operator_execution_id ||
        campaign.operator_capability !== "run_campaign" || campaign.operator_status !== "succeeded" ||
        campaign.operator_arguments_sha256 !== job.operator_arguments_sha256 ||
        job.operator_capability !== "run_campaign" || job.operator_status !== "succeeded" ||
        job.target_set_sha256 === null
      ) throw new Error("campaign authority is no longer dispatchable");
    } else {
      const directAuthority =
        (job.operator_capability === "schedule_call" && job.operator_status === "succeeded") ||
        (job.operator_capability === "place_call" && job.operator_status === "dispatching");
      if (campaign || job.flow_id !== null || job.target_set_sha256 !== null || !directAuthority) {
        throw new Error("direct-call authority is no longer dispatchable");
      }
    }
    from = normalizeE164(job.phone_number) ?? "";
    if (!from) throw new Error("scheduled call has no valid E.164 caller ID");
    assertScheduledVoicePricingAuthority({
      job,
      from,
      to,
      maxDurationSeconds: opts.maxDurationSeconds,
    });

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO calls (
         id, scheduled_call_id, agent_id, agent_version, direction, status,
         from_number, to_number, metadata, flow_id, campaign_id, parent_call_id,
         runtime_snapshot, runtime_digest, twilio_account_sid
       ) VALUES (
         $1,$1,$2,$3,'outbound','dialing',$4,$5,$6,$7,$8,$9,$10,$11,$12
       )
       ON CONFLICT (scheduled_call_id) WHERE scheduled_call_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        opts.scheduledCallId,
        agentId,
        opts.expectedAgentVersion,
        from,
        to,
        JSON.stringify({ reason, dispatch_outcome: "boundary_recorded" }),
        job.flow_id,
        job.campaign_id,
        job.parent_call_id,
        JSON.stringify(runtime.snapshot),
        runtime.digest,
        accountSid,
      ]
    );
    if (inserted.rowCount !== 1) throw new Error("scheduled call already has a local call identity");
    const boundary = await client.query(
      `UPDATE scheduled_calls SET dispatch_started_at = now(), completed_call_id = $1
       WHERE id = $1 AND claim_token = $2 AND status = 'dialing'
         AND claim_lease_expires_at > now() AND dispatch_started_at IS NULL
       RETURNING id`,
      [opts.scheduledCallId, opts.claimToken]
    );
    if (boundary.rowCount !== 1) throw new Error("scheduled call dispatch boundary was not recorded");
        // Once COMMIT is sent, its outcome may be ambiguous. Never replay this
        // transaction or proceed to provider I/O if the acknowledgement fails.
        commitAttempted = true;
        await client.query("COMMIT");
        break;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (!commitAttempted && retryableAdmissionTransaction(error) && admissionAttempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 25 * (admissionAttempt + 1)));
          continue;
        }
        throw error;
      }
    }
  } finally {
    client.release();
  }
  if (!from) throw new Error("scheduled call dispatch boundary has no caller ID");

  const twimlUrl = `${origin}/api/telephony/twiml?callId=${opts.scheduledCallId}`;

  let res: Record<string, unknown>;
  try {
    res = await twilio("/Calls.json", {
      To: to, From: from, Url: twimlUrl, Method: "POST",
      // Missed/failed legs report back so the log can mark them (red, no-answer).
      StatusCallback: `${origin}/api/telephony/status?callId=${opts.scheduledCallId}`,
      StatusCallbackMethod: "POST",
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      Timeout: "25",
      TimeLimit: String(opts.maxDurationSeconds),
    });
  } catch (e) {
    const outcome = e instanceof TwilioRequestError ? e.outcome : "indeterminate";
    const status = outcome === "rejected" ? "failed" : "indeterminate";
    const code = outcome === "rejected"
      ? "provider_rejected" as const
      : "provider_outcome_unknown_do_not_retry" as const;
    await settleDispatch({
      scheduledCallId: opts.scheduledCallId,
      claimToken: opts.claimToken,
      status,
      code,
    });
    L.error("outbound dispatch did not produce a confirmed call identity", {
      callId: opts.scheduledCallId,
      err: e instanceof Error ? e.message : String(e),
      data: { outcome },
    });
    return { callId: opts.scheduledCallId, status, code };
  }

  const callSid = String(res.sid ?? "");
  const providerAccountSid = String(res.account_sid ?? accountSid);
  if (!CALL_SID_PATTERN.test(callSid) || providerAccountSid !== accountSid) {
    const error = new TwilioRequestError(
      "Twilio accepted the request but returned an invalid call identity",
      "indeterminate"
    );
    await settleDispatch({
      scheduledCallId: opts.scheduledCallId,
      claimToken: opts.claimToken,
      status: "indeterminate",
      code: "provider_outcome_unknown_do_not_retry",
    });
    L.error("Twilio response omitted a trustworthy call identity", {
      callId: opts.scheduledCallId,
      err: error.message,
    });
    return {
      callId: opts.scheduledCallId,
      status: "indeterminate",
      code: "provider_outcome_unknown_do_not_retry",
    };
  }

  const delivery = acceptedTelephonyDeliveryReceipt({
    callId: opts.scheduledCallId,
    providerCallSid: callSid,
    providerAccountSid,
    recipient: to,
  });
  await stampAcceptedProviderIdentity({
    scheduledCallId: opts.scheduledCallId,
    twilioCallSid: callSid,
    twilioAccountSid: providerAccountSid,
    deliveryReceipt: delivery,
  });
  try {
    await settleDispatch({
      scheduledCallId: opts.scheduledCallId,
      claimToken: opts.claimToken,
      status: "done",
      code: "provider_accepted",
      twilioCallSid: callSid,
      twilioAccountSid: providerAccountSid,
    });
  } catch (error) {
    throw new AcceptedProviderSettlementError(
      opts.scheduledCallId,
      callSid,
      providerAccountSid,
      error
    );
  }
  L.info("outbound originated", { callId: opts.scheduledCallId });
  return {
    callId: opts.scheduledCallId,
    status: "accepted",
    code: "provider_accepted",
    delivery,
  };
}

/** Read-only preview of one exact voice-enabled number candidate. */
export async function previewAvailablePhoneNumber(areaCode?: string): Promise<string> {
  const query = new URLSearchParams({ VoiceEnabled: "true", PageSize: "1" });
  if (areaCode) query.set("AreaCode", areaCode);
  const avail = await twilio(`/AvailablePhoneNumbers/US/Local.json?${query}`);
  const candidate = normalizeE164(
    (avail.available_phone_numbers as { phone_number?: unknown }[])?.[0]?.phone_number
  );
  if (!candidate) throw new Error(`no available numbers${areaCode ? ` in area code ${areaCode}` : ""}`);
  return candidate;
}

/** Buy only the exact candidate already shown and approved by the operator. */
export async function purchaseNumber(candidateE164: string): Promise<string> {
  const candidate = normalizeE164(candidateE164);
  if (!candidate || candidate !== candidateE164) throw new Error("approved phone-number candidate must be canonical E.164");
  const bought = await twilio("/IncomingPhoneNumbers.json", {
    PhoneNumber: candidate,
    VoiceUrl: `${requirePublicOrigin()}/api/telephony/twiml`,
    VoiceMethod: "POST",
  });
  const purchased = normalizeE164(bought.phone_number);
  if (purchased !== candidate) {
    throw new TwilioRequestError("Twilio purchase response did not match the approved number", "indeterminate");
  }
  L.info("number purchased");
  return purchased;
}

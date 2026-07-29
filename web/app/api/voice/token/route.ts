// Author: Harsha Gundala
// voice/token — mints an ephemeral realtime token + session config for a browser call.

import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { loadActiveAgent, buildVoiceSession } from "@/lib/voice";
import { createBrowserRealtimeConnection } from "@/lib/realtime/registry";
import { resolveVoiceProviderConfig } from "@/lib/realtime/config";
import { browserSpeechGuardrailConfigForCall } from "@/lib/realtime/browser-speech-guardrail-config.server";
import {
  assertOutboundSpeechAsrTenantFundingAvailable,
} from "@/lib/realtime/outbound-speech-asr-authority.server";
import { isUuid } from "@/lib/http";
import { q, qOne } from "@/lib/db";
import { requirePublicOrigin } from "@/lib/public-origin";
import { recordingConsentReceiptHmac } from "@/lib/recording-consent-authority";
import {
  configuredRecordingRetentionDays,
  parseRecordingConsent,
  storedRecordingConsent,
} from "@/lib/recording-privacy";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";
import {
  resolveBrowserVoiceFundingAuthority,
} from "@/lib/voice-provider-credentials";

export const dynamic = "force-dynamic";

const MAX_TOKEN_REQUEST_BYTES = 64 * 1024;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    assertSameOriginBrowserMutation(req);
    body = await readPrivateJsonObject(req, MAX_TOKEN_REQUEST_BYTES);
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    return json({ error: status === 403 ? "forbidden" : "invalid request" }, status);
  }
  if (Object.keys(body).some((key) => !["agentId", "flowId", "recordingConsent"].includes(key))) {
    return json({ error: "invalid request" }, 400);
  }
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const { agentId, flowId } = body;
  if (!isUuid(agentId)) return json({ error: "valid agentId required" }, 400);
  const recordingConsent = body.recordingConsent === undefined
    ? null
    : parseRecordingConsent(body.recordingConsent);
  if (body.recordingConsent !== undefined && !recordingConsent) {
    return json({ error: "invalid recording consent" }, 400);
  }
  let retentionDays: number | null = null;
  if (recordingConsent) {
    try {
      retentionDays = configuredRecordingRetentionDays(
        process.env.CALL_RECORDING_RETENTION_DAYS,
        recordingConsent.retentionDays,
      );
    } catch {
      return json({ error: "recording retention is not configured safely" }, 500);
    }
  }
  const agent = await loadActiveAgent(agentId, session.orgId);
  if (!agent) return json({ error: "agent not found" }, 404);
  const provider = resolveVoiceProviderConfig(agent.settings, agent.voice).provider;
  let fundingAuthority: Awaited<ReturnType<typeof resolveBrowserVoiceFundingAuthority>>;
  try {
    fundingAuthority = await resolveBrowserVoiceFundingAuthority({
      orgId: session.orgId,
      provider,
    });
  } catch {
    return json({ error: "voice_funding_authority_unavailable" }, 503);
  }
  if (!fundingAuthority) {
    return json({ error: "voice_funding_authority_required" }, 503);
  }

  // Optional named flow (outbound test calls): must be org-owned.
  let namedFlowId: string | null = null;
  if (flowId) {
    if (!isUuid(flowId)) return json({ error: "invalid flowId" }, 400);
    const owned = await qOne<{ id: string }>(
      "SELECT id FROM flows WHERE id = $1 AND org_id = $2", [flowId, session.orgId]
    );
    if (!owned) return json({ error: "flow not found" }, 404);
    namedFlowId = flowId;
  }

  const origin = requirePublicOrigin();
  const voiceSession = await buildVoiceSession(agent, "web", origin, {}, {
    flowId: namedFlowId,
    browserFundingAuthority: fundingAuthority,
  });
  const failAllocatedCall = () => q(
    "UPDATE calls SET status = 'failed', ended_at = now() WHERE id = $1",
    [voiceSession.callId],
  ).catch(() => {});
  let recordingUploadToken: string | null = null;
  if (recordingConsent && retentionDays !== null) {
    recordingUploadToken = `rec_${randomBytes(32).toString("base64url")}`;
    const uploadTokenHash = createHash("sha256").update(recordingUploadToken).digest("hex");
    let receiptHmac: string;
    let stored: ReturnType<typeof storedRecordingConsent>;
    try {
      receiptHmac = recordingConsentReceiptHmac(recordingConsent.consentId);
      stored = storedRecordingConsent(recordingConsent, retentionDays, uploadTokenHash, receiptHmac);
    } catch {
      await failAllocatedCall();
      return json({ error: "recording authority is not configured safely" }, 500);
    }
    let bound: { id: string } | null;
    try {
      bound = await qOne<{ id: string }>(
        `WITH claimed AS (
           INSERT INTO recording_consent_receipts (
             org_id, receipt_hmac_sha256, call_id, granted_at, notice_version,
             retention_days, source, upload_token_hash, upload_expires_at
           ) VALUES ($2,$3,$1,$4,$5,$6,'authenticated_web_session',$7,$8)
           ON CONFLICT DO NOTHING
           RETURNING call_id
         ), bound AS (
           UPDATE calls c
           SET metadata = jsonb_set(
             COALESCE(c.metadata, '{}'::jsonb), '{recording_consent}', $9::jsonb, true
           )
           FROM agents a, claimed
           WHERE c.id = $1 AND c.agent_id = a.id AND a.org_id = $2
             AND c.id = claimed.call_id AND c.direction = 'web' AND c.status = 'active'
           RETURNING c.id
         )
         SELECT id FROM bound`,
        [
          voiceSession.callId,
          session.orgId,
          receiptHmac,
          stored.granted_at,
          stored.notice_version,
          stored.retention_days,
          stored.upload_token_hash,
          stored.upload_expires_at,
          JSON.stringify(stored),
        ],
      );
    } catch {
      await failAllocatedCall();
      return json({ error: "recording authority unavailable" }, 503);
    }
    if (!bound) {
      await failAllocatedCall();
      return json({ error: "recording consent was already used" }, 409);
    }
  }
  try {
    const speechGuardrail = browserSpeechGuardrailConfigForCall({
      settings: agent.settings,
      provider: voiceSession.sessionSpec.provider,
      organizationId: session.orgId,
      callId: voiceSession.callId,
    });
    if (speechGuardrail) {
      await assertOutboundSpeechAsrTenantFundingAvailable(session.orgId);
    }
    const connection = await createBrowserRealtimeConnection(
      voiceSession.sessionSpec,
      fundingAuthority,
    );
    return json({
      callId: voiceSession.callId,
      connection,
      ...(speechGuardrail ? { speechGuardrail } : {}),
      ...(recordingUploadToken ? { recordingUploadToken } : {}),
    });
  } catch {
    await failAllocatedCall();
    return json({ error: "voice provider unavailable" }, 503);
  }
}

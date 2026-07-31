import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  parseGuardedSpeechAsrRequest,
  transcribeGuardedSpeech,
  verifyGuardedSpeechAsrReceipt,
} from "@/lib/realtime/outbound-speech-asr.server";
import {
  claimOutboundSpeechAsrAuthority,
  failOutboundSpeechAsrAuthority,
  markOutboundSpeechAsrDispatched,
  OutboundSpeechAsrAuthorityError,
  settleOutboundSpeechAsrAuthority,
} from "@/lib/realtime/outbound-speech-asr-authority.server";
import {
  assertSameOriginBrowserMutation,
  PRIVATE_NO_STORE_HEADERS,
  PrivateRequestError,
  readPrivateJsonObject,
} from "@/lib/private-json-request";

export const dynamic = "force-dynamic";
const MAX_ASR_REQUEST_BYTES = 24 * 1024 * 1024;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  let parsed: ReturnType<typeof parseGuardedSpeechAsrRequest>;
  try {
    assertSameOriginBrowserMutation(request);
    parsed = parseGuardedSpeechAsrRequest(
      await readPrivateJsonObject(request, MAX_ASR_REQUEST_BYTES),
    );
  } catch (error) {
    const status = error instanceof PrivateRequestError ? error.status : 400;
    return json({ error: status === 403 ? "forbidden" : "invalid request" }, status);
  }
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);
  const expectedReceipt = {
    organizationId: session.orgId,
    callId: parsed.callId,
    provider: parsed.provider,
    responseId: parsed.responseId,
    audioSha256: parsed.audioSha256,
    audioBytes: parsed.pcm.byteLength,
    sampleRateHz: parsed.sampleRateHz,
  };
  let claim: Awaited<ReturnType<typeof claimOutboundSpeechAsrAuthority>>;
  try {
    claim = await claimOutboundSpeechAsrAuthority({
      organizationId: session.orgId,
      callId: parsed.callId,
      provider: parsed.provider,
      responseId: parsed.responseId,
      audioSha256: parsed.audioSha256,
      audioBytes: parsed.pcm.byteLength,
      sampleRateHz: parsed.sampleRateHz,
      audioDurationMs: parsed.audioDurationMs,
    });
  } catch (error) {
    if (error instanceof OutboundSpeechAsrAuthorityError) {
      if (error.code === "call_unavailable") return json({ error: "call not available" }, 404);
      if (error.code === "wrong_direction") return json({ error: "web call required" }, 403);
      if (error.code === "provider_mismatch" || error.code === "identity_conflict") {
        return json({ error: "speech authority mismatch" }, 409);
      }
      if (error.code === "already_consumed") {
        return json({ error: "speech authority already consumed" }, 409);
      }
      if (error.code === "budget_exhausted") {
        return json({ error: "speech guardrail budget exhausted" }, 429);
      }
      if (error.code === "guardrail_unavailable") {
        return json({ error: "speech guardrail is not enabled" }, 403);
      }
    }
    return json({ error: "independent ASR authority unavailable" }, 503);
  }
  if (claim.kind === "cached") {
    try {
      return json({
        ...verifyGuardedSpeechAsrReceipt(
          claim.receipt,
          expectedReceipt,
          claim.receiptHmacKey,
        ),
      });
    } catch {
      return json({ error: "independent ASR receipt unavailable" }, 503);
    }
  }
  try {
    await markOutboundSpeechAsrDispatched({
      authorityId: claim.authorityId,
      claimToken: claim.claimToken,
    });
  } catch {
    await failOutboundSpeechAsrAuthority({
      authorityId: claim.authorityId,
      claimToken: claim.claimToken,
      afterDispatch: false,
      failureCode: "local_failure",
    }).catch(() => undefined);
    return json({ error: "independent ASR authority unavailable" }, 503);
  }
  let receipt: Awaited<ReturnType<typeof transcribeGuardedSpeech>>;
  try {
    receipt = await transcribeGuardedSpeech({
      authorityId: claim.authorityId,
      organizationId: session.orgId,
      callId: parsed.callId,
      responseId: parsed.responseId,
      provider: parsed.provider,
      pcm: parsed.pcm,
      audioSha256: parsed.audioSha256,
      sampleRateHz: parsed.sampleRateHz,
      audioDurationMs: parsed.audioDurationMs,
    }, claim.apiKey, claim.receiptHmacKey);
  } catch {
    await failOutboundSpeechAsrAuthority({
      authorityId: claim.authorityId,
      claimToken: claim.claimToken,
      afterDispatch: true,
      failureCode: "provider_outcome_unknown",
    }).catch(() => undefined);
    return json({ error: "independent ASR unavailable" }, 503);
  }
  try {
    await settleOutboundSpeechAsrAuthority({
      authorityId: claim.authorityId,
      claimToken: claim.claimToken,
      receipt,
    });
  } catch {
    await failOutboundSpeechAsrAuthority({
      authorityId: claim.authorityId,
      claimToken: claim.claimToken,
      afterDispatch: true,
      failureCode: "settlement_unknown",
    }).catch(() => undefined);
    return json({ error: "independent ASR settlement unavailable" }, 503);
  }
  return json({ ...receipt });
}

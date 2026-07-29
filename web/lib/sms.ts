// Author: Harsha Gundala
// sms.ts — Twilio SMS delivery: Verify-service OTP (carrier-approved) + generic agent SMS.

import { PRODUCT_NAME } from "./product";
import { twilioAccountSid, twilioRestAuthorization } from "./telephony";

const TWILIO_VERIFY_REQUEST_TIMEOUT_MS = 8_000;
const TWILIO_MESSAGE_REQUEST_TIMEOUT_MS = 15_000;
const TWILIO_MESSAGE_SID = /^SM[0-9a-fA-F]{32}$/;

function verifyAuth(): string {
  return twilioRestAuthorization();
}

/** Starts an OTP via Twilio Verify — pre-registered infrastructure, no A2P filtering (error 30034). */
export async function startPhoneVerification(toNumber: string): Promise<void> {
  const service = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!service) throw new Error("Twilio Verify is not configured");
  twilioAccountSid();
  const res = await fetch(`https://verify.twilio.com/v2/Services/${service}/Verifications`, {
    method: "POST",
    headers: { Authorization: `Basic ${verifyAuth()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: toNumber, Channel: "sms" }),
    redirect: "error",
    signal: AbortSignal.timeout(TWILIO_VERIFY_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`twilio verify ${res.status}: ${(await res.text()).slice(0, 240)}`);
}

/** Checks an OTP against Twilio Verify. */
export async function checkPhoneVerification(toNumber: string, code: string): Promise<boolean> {
  const service = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!service) throw new Error("Twilio Verify is not configured");
  const res = await fetch(`https://verify.twilio.com/v2/Services/${service}/VerificationCheck`, {
    method: "POST",
    headers: { Authorization: `Basic ${verifyAuth()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: toNumber, Code: code }),
    redirect: "error",
    signal: AbortSignal.timeout(TWILIO_VERIFY_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return false; // 404 = no pending verification (expired) — treat as wrong
  const json = await res.json();
  return json.status === "approved";
}

export async function sendPhoneCode(toNumber: string, code: string): Promise<void> {
  const accountSid = twilioAccountSid();
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!fromNumber) {
    throw new Error("Twilio SMS is not configured");
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${twilioRestAuthorization()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: toNumber,
      From: fromNumber,
      Body: `Your ${PRODUCT_NAME} code is ${code}. It expires in 10 minutes.`,
    }),
  });

  if (!res.ok) {
    throw new Error(`twilio sms ${res.status}: ${(await res.text()).slice(0, 240)}`);
  }
}

/** Generic agent-composed SMS from the platform number. */
export async function sendSms(
  toNumber: string,
  body: string
): Promise<Readonly<{ providerMessageId: string; providerStatus: string }>> {
  const accountSid = twilioAccountSid();
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!fromNumber) throw new Error("Twilio SMS is not configured");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${twilioRestAuthorization()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: toNumber, From: fromNumber, Body: body.slice(0, 1500) }),
    redirect: "error",
    signal: AbortSignal.timeout(TWILIO_MESSAGE_REQUEST_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`twilio sms ${res.status}: ${raw.slice(0, 200)}`);
  if (raw.length > 256 * 1024) {
    throw new Error("twilio SMS response is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("twilio SMS accepted response is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("twilio SMS accepted response is invalid");
  }
  const providerMessageId = (parsed as Record<string, unknown>).sid;
  const providerStatus = (parsed as Record<string, unknown>).status;
  if (typeof providerMessageId !== "string" || !TWILIO_MESSAGE_SID.test(providerMessageId)
      || typeof providerStatus !== "string" || !/^[a-z][a-z-]{1,31}$/.test(providerStatus)) {
    throw new Error("twilio SMS accepted response omitted valid provider evidence");
  }
  return Object.freeze({ providerMessageId, providerStatus });
}

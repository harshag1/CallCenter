// Author: Harsha Gundala
// sms.ts — Twilio SMS delivery: Verify-service OTP (carrier-approved) + generic agent SMS.

function verifyAuth(): string {
  return Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
}

/** Starts an OTP via Twilio Verify — pre-registered infrastructure, no A2P filtering (error 30034). */
export async function startPhoneVerification(toNumber: string): Promise<void> {
  const service = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!service || !process.env.TWILIO_ACCOUNT_SID) throw new Error("Twilio Verify is not configured");
  const res = await fetch(`https://verify.twilio.com/v2/Services/${service}/Verifications`, {
    method: "POST",
    headers: { Authorization: `Basic ${verifyAuth()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: toNumber, Channel: "sms" }),
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
  });
  if (!res.ok) return false; // 404 = no pending verification (expired) — treat as wrong
  const json = await res.json();
  return json.status === "approved";
}

export async function sendPhoneCode(toNumber: string, code: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKey = process.env.TWILIO_API_KEY_SID;
  const apiSecret = process.env.TWILIO_API_KEY_SECRET;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !fromNumber || !(apiKey && apiSecret) && !authToken) {
    throw new Error("Twilio SMS is not configured");
  }

  // Account token first — the provided SK key pair belongs to a different Twilio account
  // (same fix as lib/telephony.ts; the API-key path 401s with Twilio code 20003).
  const username = authToken ? accountSid : apiKey!;
  const password = authToken ?? apiSecret!;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: toNumber,
      From: fromNumber,
      Body: `Your Harsha's Amazing Call Center code is ${code}. It expires in 10 minutes.`,
    }),
  });

  if (!res.ok) {
    throw new Error(`twilio sms ${res.status}: ${(await res.text()).slice(0, 240)}`);
  }
}

/** Generic agent-composed SMS from the platform number. */
export async function sendSms(toNumber: string, body: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!accountSid || !fromNumber || !process.env.TWILIO_AUTH_TOKEN) throw new Error("Twilio SMS is not configured");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: toNumber, From: fromNumber, Body: body.slice(0, 1500) }),
  });
  if (!res.ok) throw new Error(`twilio sms ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

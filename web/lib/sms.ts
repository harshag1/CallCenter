// Author: Harsha Gundala
// sms.ts — Twilio SMS delivery for staged onboarding phone verification.

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

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

  const username = apiKey && apiSecret ? apiKey : accountSid;
  const password = apiKey && apiSecret ? apiSecret : authToken!;
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

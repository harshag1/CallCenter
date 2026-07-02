// Author: Harsha Gundala
// email.ts — transactional email via Resend (OTP login codes).

import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.EMAIL_FROM ?? "Harsha's Amazing Call Center <callcenter@auth.meshia.io>";

export async function sendLoginCode(to: string, code: string): Promise<void> {
  const { error } = await resend.emails.send({
    from: FROM,
    to,
    subject: `${code} is your login code`,
    html: `<div style="font-family:ui-sans-serif,system-ui;padding:32px;color:#111">
      <p style="font-size:14px;color:#666;margin:0 0 16px">Harsha's Amazing Call Center</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0">${code}</p>
      <p style="font-size:13px;color:#999;margin:16px 0 0">Expires in 10 minutes.</p>
    </div>`,
  });
  if (error) throw new Error(`resend: ${error.message}`);
}

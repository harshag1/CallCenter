// Author: Harsha Gundala
// email.ts — transactional email via Resend: OTP login codes + agent-composed messages (Meshia layout).

import { Resend } from "resend";
import { PRODUCT_NAME } from "./product";

let resend: Resend | null = null;

const EMAIL_IDEMPOTENCY_KEY_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function requireEmailIdempotencyKey(value: string): void {
  if (!EMAIL_IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new Error("invalid email idempotency key");
  }
}

function getResend(): Resend {
  if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
  return resend ?? (resend = new Resend(process.env.RESEND_API_KEY));
}

function fromAddress(): string {
  if (!process.env.EMAIL_FROM) throw new Error("EMAIL_FROM is not configured");
  return process.env.EMAIL_FROM;
}

/** Escape at the boundary — subjects/bodies originate from agent tool output. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Agent-composed email in the Meshia/GPU-Hub card layout. */
export async function sendAgentEmail(opts: {
  to: string;
  subject: string;
  message: string;
  brand?: string | null;
  /** Opaque durable execution identity for provider-side replay suppression. */
  idempotencyKey?: string;
}): Promise<void> {
  if (opts.idempotencyKey !== undefined) requireEmailIdempotencyKey(opts.idempotencyKey);
  const brand = escapeHtml(opts.brand ?? PRODUCT_NAME);
  const subject = escapeHtml(opts.subject);
  const body = escapeHtml(opts.message);
  const { error } = await getResend().emails.send({
    from: fromAddress(),
    to: opts.to,
    subject: opts.subject,
    html: `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; color: #1d2738;">
      <div style="margin-bottom: 20px;">
        <h2 style="color: #1d2738; margin: 0 0 8px;">${brand}</h2>
      </div>
      <div style="background: linear-gradient(180deg, #ffffff, #f6f8fb); border: 1px solid rgba(63, 78, 99, 0.12); border-radius: 16px; padding: 24px; margin-bottom: 20px; box-shadow: 0 16px 40px rgba(70, 83, 102, 0.08);">
        <h3 style="color: #1d2738; margin: 0 0 8px;">${subject}</h3>
        <p style="color: #5c697b; margin: 0; white-space: pre-line;">${body}</p>
      </div>
      <p style="color: #7b8795; font-size: 13px; margin: 0;">Sent by ${brand}'s voice assistant.</p>
    </div>`,
  }, opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined);
  if (error) throw new Error(`resend: ${error.message}`);
}

export async function sendLoginCode(
  to: string,
  code: string,
  /** Durable auth_codes.id; reused verbatim if this delivery is retried. */
  deliveryId: string
): Promise<void> {
  requireEmailIdempotencyKey(deliveryId);
  if (!process.env.RESEND_API_KEY) {
    if (process.env.NODE_ENV !== "production" && process.env.ALLOW_DEV_OTP_STDOUT === "true") {
      console.log(`[explicit dev auth] ${to}: ${code}`);
      return;
    }
    throw new Error("RESEND_API_KEY is not configured");
  }
  const { error } = await getResend().emails.send({
    from: fromAddress(),
    to,
    subject: `${code} is your login code`,
    html: `<div style="font-family:ui-sans-serif,system-ui;padding:32px;color:#111">
      <p style="font-size:14px;color:#666;margin:0 0 16px">${escapeHtml(PRODUCT_NAME)}</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0">${code}</p>
      <p style="font-size:13px;color:#999;margin:16px 0 0">Expires in 10 minutes.</p>
    </div>`,
  }, { idempotencyKey: deliveryId });
  if (error) throw new Error(`resend: ${error.message}`);
}

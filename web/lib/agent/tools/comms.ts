// Author: Harsha Gundala
// comms.ts — confirmed, quota-reserved, at-most-once email and SMS actions.

import { qOne } from "../../db";
import { createEmailCostQuote, createSmsCostQuote } from "../../operator-pricing";
import type { OperatorTool } from "../types";
import {
  OperatorActionDeniedError,
  proposeOperatorAction,
} from "./operator-capability-policy";

const GSM_BASIC = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(""));
const GSM_EXTENDED = new Set("^{}\\[~]|€".split(""));

function smsSegments(message: string): number {
  let septets = 0;
  let gsm = true;
  for (const character of message) {
    if (GSM_BASIC.has(character)) septets += 1;
    else if (GSM_EXTENDED.has(character)) septets += 2;
    else { gsm = false; break; }
  }
  if (gsm) return septets <= 160 ? 1 : Math.ceil(septets / 153);
  const units = [...message].reduce((count, character) => count + (character.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

export const sendEmailTool: OperatorTool = {
  name: "send_email",
  description: "Propose one exact email through Resend. The browser must approve it; only the server can reserve quota, mint execution authority, and dispatch it at most once.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      to: { type: "string" },
      subject: { type: "string" },
      message: { type: "string", description: "Plain text; line breaks preserved." },
    },
    required: ["to", "subject", "message"],
  },
  async execute(args, ctx) {
    const to = String(args.to ?? "").trim().toLowerCase();
    const subject = String(args.subject ?? "").trim();
    const message = String(args.message ?? "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) || to.length > 254) return { output: { error: "invalid email address" } };
    if (!subject || subject.length > 200 || !message.trim() || message.length > 20_000) {
      return { output: { error: "email subject or message is empty or too long" } };
    }
    let proposal;
    try {
      const costQuote = createEmailCostQuote({ recipient: to });
      const org = await qOne<{ name: string | null }>("SELECT name FROM orgs WHERE id = $1", [ctx.orgId]);
      proposal = await proposeOperatorAction({
        ctx,
        capability: "send_email",
        argumentsValue: { to, subject, message, brand: org?.name ?? null, cost_quote: costQuote },
        estimatedUnits: costQuote.units,
        estimatedMicroUsd: costQuote.reservationMicroUsd,
      });
    } catch (error) {
      return {
        output: {
          error: error instanceof OperatorActionDeniedError
            ? error.code
            : "email_proposal_unavailable",
        },
      };
    }
    return {
      output: { status: "human_confirmation_required", proposal_id: proposal.proposalId },
      operatorActionConfirmation: proposal,
      notice: `Review the exact email to ${to}; nothing has been sent`,
    };
  },
};

export const sendSmsTool: OperatorTool = {
  name: "send_sms",
  description: "Propose one exact SMS from the platform number. The browser must approve it; the configured spend reservation is bound to the actual GSM/UCS-2 segment count and destination.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      to: { type: "string", description: "E.164, e.g. +14155551234" },
      message: { type: "string" },
    },
    required: ["to", "message"],
  },
  async execute(args, ctx) {
    const to = String(args.to ?? "").trim();
    const message = String(args.message ?? "");
    if (!/^\+[1-9]\d{6,14}$/.test(to)) return { output: { error: "to must be E.164 (+1...)" } };
    if (!message.trim() || message.length > 1_500) return { output: { error: "SMS message must contain 1-1500 characters" } };
    const segments = smsSegments(message);
    let proposal;
    try {
      const costQuote = createSmsCostQuote({ destinationE164: to, segmentCount: segments });
      proposal = await proposeOperatorAction({
        ctx,
        capability: "send_sms",
        argumentsValue: { to, message, segments, cost_quote: costQuote },
        estimatedUnits: costQuote.units,
        estimatedMicroUsd: costQuote.reservationMicroUsd,
      });
    } catch (error) {
      return {
        output: {
          error: error instanceof OperatorActionDeniedError
            ? error.code
            : "sms_proposal_unavailable",
        },
      };
    }
    return {
      output: { status: "human_confirmation_required", proposal_id: proposal.proposalId },
      operatorActionConfirmation: proposal,
      notice: `Review the exact ${segments}-segment text to ${to}; nothing has been sent`,
    };
  },
};

// Author: Harsha Gundala
// comms.ts — operator tools: send email (Meshia-layout template) and SMS.

import { qOne } from "../../db";
import { sendAgentEmail } from "../../email";
import { sendSms } from "../../sms";
import type { OperatorTool } from "../types";

export const sendEmailTool: OperatorTool = {
  name: "send_email",
  description: "Send an email (branded template via Resend). Look up addresses in the customers table with query_dataset when you only have a name or phone.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string" },
      subject: { type: "string" },
      message: { type: "string", description: "Plain text; line breaks preserved." },
    },
    required: ["to", "subject", "message"],
  },
  async execute(args, ctx) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(args.to))) return { output: { error: "invalid email address" } };
    const org = await qOne<{ name: string | null }>("SELECT name FROM orgs WHERE id = $1", [ctx.orgId]);
    try {
      await sendAgentEmail({ to: String(args.to), subject: String(args.subject), message: String(args.message), brand: org?.name });
      return { output: { ok: true }, notice: `Emailed ${args.to}` };
    } catch (e) {
      return { output: { error: (e as Error).message } };
    }
  },
};

export const sendSmsTool: OperatorTool = {
  name: "send_sms",
  description: "Send a text message from the platform number.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "E.164, e.g. +14155551234" },
      message: { type: "string" },
    },
    required: ["to", "message"],
  },
  async execute(args) {
    if (!/^\+\d{7,15}$/.test(String(args.to))) return { output: { error: "to must be E.164 (+1...)" } };
    try {
      await sendSms(String(args.to), String(args.message));
      return { output: { ok: true }, notice: `Texted ${args.to}` };
    } catch (e) {
      return { output: { error: (e as Error).message } };
    }
  },
};

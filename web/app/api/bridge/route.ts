// Author: Harsha Gundala
// bridge — WebSocket endpoint for Twilio Media Streams, served by Vercel Fluid compute.

import { experimental_upgradeWebSocket } from "@vercel/functions";
import { BridgeSession, type BridgeSocket } from "@/lib/bridge";
import { verifyTwilioStreamUpgrade } from "@/lib/telephony";

export const maxDuration = 800; // pins the max call length (~13 min) — Fluid compute ceiling

export function legacyWebBridgeEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.ENABLE_LEGACY_WEB_BRIDGE === "true";
}

export async function GET(req: Request) {
  // The standalone bridge has the bounded parser, durable journal, provider
  // acknowledgement lifecycle, and normalized tool loop. Never expose this
  // compatibility implementation in production or by default.
  if (!legacyWebBridgeEnabled()) {
    return Response.json(
      { error: "web bridge disabled; deploy the hardened standalone bridge" },
      { status: 410, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (!verifyTwilioStreamUpgrade(req)) {
    return new Response("invalid Twilio signature", {
      status: 401,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return experimental_upgradeWebSocket((ws) => {
    new BridgeSession(ws as unknown as BridgeSocket);
  });
}

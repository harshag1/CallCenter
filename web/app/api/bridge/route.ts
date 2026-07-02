// Author: Harsha Gundala
// bridge — WebSocket endpoint for Twilio Media Streams, served by Vercel Fluid compute.

import { experimental_upgradeWebSocket } from "@vercel/functions";
import { BridgeSession, type BridgeSocket } from "@/lib/bridge";

export const maxDuration = 800; // pins the max call length (~13 min) — Fluid compute ceiling

export async function GET() {
  return experimental_upgradeWebSocket((ws) => {
    new BridgeSession(ws as unknown as BridgeSocket);
  });
}

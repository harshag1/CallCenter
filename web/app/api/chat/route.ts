// Author: Harsha Gundala
// chat — operator-agent endpoint: streams loop events to the client as SSE.

import { getSession } from "@/lib/auth";
import { runOperator } from "@/lib/agent/loop";

export const maxDuration = 300;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("unauthorized", { status: 401 });
  const { message, threadId, agentId } = await req.json();
  if (!message || !threadId) return new Response("message and threadId required", { status: 400 });
  const origin = new URL(req.url).origin;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of runOperator(session, threadId, String(message), agentId ?? null, origin)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        }
      } catch (e) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "notice", text: `error: ${(e as Error).message}` })}\n\n`)
        );
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}

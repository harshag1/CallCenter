// Author: Harsha Gundala
// events/stream — org-scoped SSE fan-out of pg NOTIFY 'org_events' via a dedicated LISTEN connection.

import { Client } from "pg";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { loadDatabaseConnectionConfig } from "@/lib/database-connection";

export const maxDuration = 800;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let client: Client | undefined;
  try {
    client = new Client(loadDatabaseConnectionConfig());
    await client.connect();
    await client.query("LISTEN org_events");
  } catch {
    void client?.end().catch(() => {});
    return NextResponse.json({ error: "stream unavailable" }, { status: 503 });
  }
  if (!client) {
    return NextResponse.json({ error: "stream unavailable" }, { status: 503 });
  }

  const enc = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        void client.end().catch(() => {});
        try { controller.close(); } catch { /* already closed */ }
      };
      const send = (text: string) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(text)); } catch { close(); }
      };

      client.on("notification", (n) => {
        if (!n.payload) return;
        try {
          const row = JSON.parse(n.payload) as { orgId?: string } & Record<string, unknown>;
          if (row.orgId !== session.orgId) return;
          const ev = { ...row };
          delete ev.orgId;
          send(`data: ${JSON.stringify(ev)}\n\n`);
        } catch { /* malformed payload */ }
      });
      client.on("error", close);
      client.on("end", close);

      send(": connected\n\n");
      heartbeat = setInterval(() => send(": ping\n\n"), 15_000);
      req.signal.addEventListener("abort", close);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      void client.end().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

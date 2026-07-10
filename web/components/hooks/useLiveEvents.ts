"use client";
// Author: Harsha Gundala
// useLiveEvents.ts — org-wide live event feed: SSE with exponential reconnect, silent polling fallback.

import { useEffect, useEffectEvent } from "react";
import type { LiveEvent } from "@/lib/realtime-types";

const POLL_MS = 3000;
const SSE_RETRY_MS = 60_000;
const FALLBACK_AFTER = 2;

export function useLiveEvents(onEvent: (ev: LiveEvent) => void): void {
  const deliverEvent = useEffectEvent(onEvent);

  useEffect(() => {
    let es: EventSource | null = null;
    let stopped = false;
    let failures = 0;
    let cursor = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const deliver = (ev: LiveEvent) => {
      if (ev.kind === "call_event" && ev.eventId > cursor) cursor = ev.eventId;
      deliverEvent(ev);
    };

    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const poll = async () => {
      try {
        const res = await fetch(`/api/calls/recent-events?after=${cursor}`);
        if (!res.ok) return;
        const body = (await res.json()) as { events: LiveEvent[]; last?: number };
        for (const ev of body.events) deliver(ev);
        if (typeof body.last === "number" && body.last > cursor) cursor = body.last;
      } catch { /* retry next tick */ }
    };

    const startPolling = () => {
      if (pollTimer || stopped) return;
      void poll();
      pollTimer = setInterval(() => void poll(), POLL_MS);
    };

    const connect = () => {
      if (stopped) return;
      es = new EventSource("/api/events/stream");
      es.onopen = () => {
        failures = 0;
        stopPolling();
      };
      es.onmessage = (m) => {
        try { deliver(JSON.parse(m.data) as LiveEvent); } catch { /* non-event frame */ }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (stopped) return;
        failures += 1;
        if (failures >= FALLBACK_AFTER) {
          startPolling();
          reconnectTimer = setTimeout(connect, SSE_RETRY_MS);
        } else {
          reconnectTimer = setTimeout(connect, 1000 * 2 ** failures);
        }
      };
    };

    // Seed the cursor so a polling fallback never replays history.
    void fetch("/api/calls/recent-events")
      .then(async (r) => {
        if (!r.ok) return;
        const body = (await r.json()) as { last?: number };
        if (typeof body.last === "number" && body.last > cursor) cursor = body.last;
      })
      .catch(() => {});
    connect();

    return () => {
      stopped = true;
      es?.close();
      stopPolling();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);
}

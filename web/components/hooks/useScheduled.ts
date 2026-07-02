"use client";
// Author: Harsha Gundala
// useScheduled.ts — pending outbound work (campaigns + scheduled calls) with SSE-debounced refresh.

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveEvents } from "./useLiveEvents";
import type { LiveEvent } from "@/lib/realtime-types";

export type ScheduledCall = {
  id: string;
  to_number: string;
  run_at: string;
  reason: string | null;
  status: "pending" | "dialing" | "done" | "failed" | "canceled" | (string & {});
  attempts: number;
  parent_call_id: string | null;
  campaign_id: string | null;
  agent: string;
  campaign: string | null;
};

export type Campaign = {
  id: string;
  name: string;
  status: "scheduled" | "running" | "done" | "canceled" | (string & {});
  run_at: string | null;
  flow_name: string;
  agent: string;
  total: number | string;
  pending: number | string;
  answered: number | string;
  missed: number | string;
  avg_satisfaction: number | string | null;
};

const REFRESH_DEBOUNCE_MS = 3000;

async function fetchScheduled(): Promise<{ scheduled: ScheduledCall[]; campaigns: Campaign[] } | null> {
  try {
    const r = await fetch("/api/scheduled");
    if (!r.ok) return null;
    const j = await r.json();
    return { scheduled: j.scheduled ?? [], campaigns: j.campaigns ?? [] };
  } catch {
    return null; // endpoint quiet — keep last state
  }
}

export function useScheduled() {
  const [scheduled, setScheduled] = useState<ScheduledCall[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => {
    void fetchScheduled().then((j) => {
      if (!j) return;
      setScheduled(j.scheduled);
      setCampaigns(j.campaigns);
    });
  }, []);

  useEffect(() => {
    let live = true;
    void fetchScheduled().then((j) => {
      if (!live || !j) return;
      setScheduled(j.scheduled);
      setCampaigns(j.campaigns);
    });
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useLiveEvents((ev: LiveEvent) => {
    if (ev.kind !== "call_update" || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      reload();
    }, REFRESH_DEBOUNCE_MS);
  });

  const hasPending =
    scheduled.some((s) => s.status === "pending") ||
    campaigns.some((c) => c.status === "scheduled" || c.status === "running");

  return { scheduled, campaigns, reload, hasPending };
}

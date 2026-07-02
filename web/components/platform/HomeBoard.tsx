// Author: Harsha Gundala
// HomeBoard.tsx — birds-eye board: live stats, active call cards with flow position + hold countdowns.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveEvents } from "@/components/hooks/useLiveEvents";
import type { LiveEvent } from "@/lib/realtime-types";
import {
  DirIcon, HoldChip, PulseDot, SatChip, fmtDur, fmtTime, mmss, useNow,
  type CallRow,
} from "./shared";

type AgentLite = { id: string; name: string; flow?: { nodes?: { id: string; label: string }[] } | null };

async function fetchCalls(): Promise<CallRow[] | null> {
  try {
    const r = await fetch("/api/calls?limit=100");
    if (!r.ok) return null;
    const j = await r.json();
    return j.calls ?? [];
  } catch {
    return null; // keep empty state
  }
}

export default function HomeBoard({
  agents, onOpenCall,
}: { agents: AgentLite[]; onOpenCall?: (id: string) => void }) {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [experiments, setExperiments] = useState<{ id: string; status: string }[]>([]);
  const [nodeByCall, setNodeByCall] = useState<Record<string, string>>({});
  const [holdByCall, setHoldByCall] = useState<Record<string, string>>({});
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    let live = true;
    void fetchCalls().then((rows) => { if (live && rows) setCalls(rows); });
    fetch("/api/experiments")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setExperiments(Array.isArray(j) ? j : j.experiments ?? []); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  useLiveEvents((ev: LiveEvent) => {
    if (ev.kind === "call_update") {
      setCalls((prev) => {
        if (!prev.some((c) => c.id === ev.callId)) {
          if (!reloadTimer.current) {
            reloadTimer.current = setTimeout(() => {
              reloadTimer.current = null;
              void fetchCalls().then((rows) => rows && setCalls(rows));
            }, 800);
          }
          return prev;
        }
        return prev.map((c) =>
          c.id === ev.callId ? { ...c, status: ev.status ?? c.status, satisfaction: ev.satisfaction ?? c.satisfaction } : c
        );
      });
      if (ev.status && ev.status !== "active") {
        setNodeByCall((p) => { const rest = { ...p }; delete rest[ev.callId]; return rest; });
        setHoldByCall((p) => { const rest = { ...p }; delete rest[ev.callId]; return rest; });
      }
    } else if (ev.kind === "call_event") {
      if (ev.type === "state" && ev.payload?.node) {
        const node = String(ev.payload.node);
        setNodeByCall((p) => ({ ...p, [ev.callId]: node }));
      } else if (ev.type === "hold_start") {
        const until = ev.payload?.until
          ? String(ev.payload.until)
          : new Date(Date.now() + Number(ev.payload?.seconds ?? 0) * 1000).toISOString();
        setHoldByCall((p) => ({ ...p, [ev.callId]: until }));
      } else if (ev.type === "hold_end") {
        setHoldByCall((p) => { const rest = { ...p }; delete rest[ev.callId]; return rest; });
      }
    }
  });

  const nodeLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) for (const n of a.flow?.nodes ?? []) m.set(n.id, n.label);
    return m;
  }, [agents]);

  const active = calls.filter((c) => c.status === "active");
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const today = calls.filter((c) => Date.parse(c.started_at) >= dayStart.getTime());
  const sats = today.map((c) => c.satisfaction).filter((n): n is number => n != null);
  const avgSat = sats.length ? (sats.reduce((a, b) => a + b, 0) / sats.length).toFixed(1) : "—";
  const running = experiments.filter((e) => e.status === "running").length;
  const recent = calls.filter((c) => c.status !== "active").slice(0, 8);

  return (
    <div className="space-y-8">
      <div className="flex gap-3">
        <Stat label="live now" value={String(active.length)} />
        <Stat label="calls today" value={String(today.length)} />
        <Stat label="avg satisfaction" value={avgSat} />
        <Stat label="experiments" value={String(running)} />
      </div>

      <section>
        <div className="mb-3 text-[11px] uppercase tracking-wide text-neutral-400">live calls</div>
        {active.length ? (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {active.map((c) => (
              <button
                key={c.id}
                onClick={() => onOpenCall?.(c.id)}
                className="rounded-2xl border border-[var(--border)] p-4 text-left transition-colors hover:border-neutral-300"
              >
                <div className="flex items-center gap-2">
                  <PulseDot />
                  <span className="text-[13px] font-semibold">{c.agent}</span>
                  <span className="ml-auto text-[12px] tabular-nums text-neutral-500">{mmss(now - Date.parse(c.started_at))}</span>
                </div>
                <div className="mt-2 flex items-center gap-2 text-[12px] text-neutral-500">
                  <DirIcon d={c.direction} />
                  <span className="tabular-nums">{c.from_number ?? "browser"}</span>
                </div>
                <div className="mt-2.5 flex min-h-5 items-center gap-1.5">
                  {nodeByCall[c.id] && (
                    <span className="max-w-[70%] truncate rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600">
                      {nodeLabel.get(nodeByCall[c.id]) ?? nodeByCall[c.id]}
                    </span>
                  )}
                  {holdByCall[c.id] && <HoldChip until={holdByCall[c.id]} />}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2.5 rounded-2xl border border-[var(--border)] px-4 py-6 text-xs text-neutral-400">
            <PulseDot color="bg-neutral-300" ping="bg-neutral-200" /> no live calls
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 text-[11px] uppercase tracking-wide text-neutral-400">recent</div>
        <div className="flex flex-wrap gap-2.5">
          {recent.map((c) => (
            <button
              key={c.id}
              onClick={() => onOpenCall?.(c.id)}
              className="flex items-center gap-2.5 rounded-xl border border-[var(--border)] px-3 py-2 text-[12px] transition-colors hover:border-neutral-300"
            >
              <span className="font-medium">{c.agent}</span>
              <span className="tabular-nums text-neutral-400">{fmtTime(c.started_at)}</span>
              <span className="tabular-nums text-neutral-400">{fmtDur(c.duration_s)}</span>
              <SatChip n={c.satisfaction} />
            </button>
          ))}
          {!recent.length && <span className="text-xs text-neutral-300">—</span>}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1 rounded-2xl border border-[var(--border)] p-4">
      <div className="text-[11px] uppercase tracking-wide text-neutral-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
    </div>
  );
}

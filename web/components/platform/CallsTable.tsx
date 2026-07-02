// Author: Harsha Gundala
// CallsTable.tsx — call log: expandable rows with recording, aligned timeline, shaded transcript, AI review.

"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveEvents } from "@/components/hooks/useLiveEvents";
import type { LiveEvent } from "@/lib/realtime-types";
import CallTimeline from "./CallTimeline";
import {
  DirIcon, PulseDot, ResIcon, SatChip, fmtDur, fmtTime, mmss, useNow,
  type CallEvent, type CallRow,
} from "./shared";

export type CallFocus = {
  callId: string;
  agentId: string;
  visited: string[];
  activeNode: string | null;
  holdCountdown: { until: string } | null;
};

const HEADERS = ["time", "agent", "dir", "from", "duration", "sat", "resolution", "review"];

async function fetchCalls(): Promise<CallRow[] | null> {
  try {
    const r = await fetch("/api/calls?limit=100");
    if (!r.ok) return null;
    const j = await r.json();
    return j.calls ?? [];
  } catch {
    return null; // endpoint may not be live yet
  }
}

export default function CallsTable({
  onFocus, expandCallId,
}: { onFocus?: (info: CallFocus | null) => void; expandCallId?: string | null }) {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [events, setEvents] = useState<CallEvent[]>([]);
  const expandedRef = useRef<string | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    let live = true;
    void fetchCalls().then((rows) => { if (live && rows) setCalls(rows); });
    return () => { live = false; };
  }, []);

  const openCall = useCallback(async (id: string) => {
    expandedRef.current = id;
    setExpanded(id);
    setEvents([]);
    try {
      let after = 0;
      const all: CallEvent[] = [];
      for (let page = 0; page < 10; page++) {
        const r = await fetch(`/api/calls/${id}/events?after=${after}`);
        if (!r.ok) break;
        const { events: batch } = await r.json();
        if (!batch?.length) break;
        all.push(...batch);
        after = batch[batch.length - 1].id;
        if (batch.length < 300) break;
      }
      if (expandedRef.current === id) setEvents(all);
    } catch { /* leave transcript empty */ }
  }, []);

  const closeCall = useCallback(() => {
    expandedRef.current = null;
    setExpanded(null);
    setEvents([]);
  }, []);

  // Parent can hand us a call to auto-expand (e.g. clicked on the home board).
  useEffect(() => {
    if (expandCallId && calls.some((c) => c.id === expandCallId) && expandedRef.current !== expandCallId) {
      void openCall(expandCallId);
    }
  }, [expandCallId, calls, openCall]);

  useLiveEvents((ev: LiveEvent) => {
    if (ev.kind === "call_event" && ev.callId === expandedRef.current) {
      setEvents((prev) =>
        prev.some((e) => e.id === ev.eventId)
          ? prev
          : [...prev, { id: ev.eventId, ts: ev.ts, type: ev.type, payload: ev.payload ?? {} }]
      );
    }
    if (ev.kind === "call_update") {
      setCalls((prev) => {
        if (!prev.some((c) => c.id === ev.callId)) return prev;
        return prev.map((c) =>
          c.id === ev.callId ? { ...c, status: ev.status ?? c.status, satisfaction: ev.satisfaction ?? c.satisfaction } : c
        );
      });
      // New call or a call closing out (duration/review land async) → refetch, debounced.
      if (!reloadTimer.current) {
        reloadTimer.current = setTimeout(() => {
          reloadTimer.current = null;
          void fetchCalls().then((rows) => rows && setCalls(rows));
        }, 1200);
      }
    }
  });

  // Flow traversal derived from state/hold events of the expanded call.
  const trace = useMemo(() => {
    const visited: string[] = [];
    let activeNode: string | null = null;
    let hold: { until: string } | null = null;
    for (const e of events) {
      if (e.type === "state" && e.payload?.node) {
        activeNode = String(e.payload.node);
        if (!visited.includes(activeNode)) visited.push(activeNode);
      } else if (e.type === "hold_start") {
        const until = e.payload?.until
          ? String(e.payload.until)
          : new Date(Date.parse(e.ts) + Number(e.payload?.seconds ?? 0) * 1000).toISOString();
        hold = { until };
      } else if (e.type === "hold_end") {
        hold = null;
      }
    }
    return { visited, activeNode, holdCountdown: hold };
  }, [events]);

  useEffect(() => {
    if (!onFocus) return;
    const call = expanded ? calls.find((c) => c.id === expanded) : null;
    // Drop stale holds (hold_end lost / historical call) at notify time.
    const hold = trace.holdCountdown && Date.parse(trace.holdCountdown.until) > Date.now() ? trace.holdCountdown : null;
    onFocus(call ? { callId: call.id, agentId: call.agent_id, visited: trace.visited, activeNode: trace.activeNode, holdCountdown: hold } : null);
  }, [expanded, trace, calls, onFocus]);

  useEffect(() => () => onFocus?.(null), [onFocus]);

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-neutral-400">
            {HEADERS.map((h) => <th key={h} className="px-4 py-2.5 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <Fragment key={c.id}>
              <tr
                onClick={() => (expanded === c.id ? closeCall() : void openCall(c.id))}
                className={`cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-neutral-50 ${expanded === c.id ? "bg-neutral-50" : ""}`}
              >
                <td className="px-4 py-2.5 tabular-nums text-neutral-500">{fmtTime(c.started_at)}</td>
                <td className="px-4 py-2.5">{c.agent}</td>
                <td className="px-4 py-2.5"><DirIcon d={c.direction} /></td>
                <td className="px-4 py-2.5 tabular-nums text-neutral-500">{c.from_number ?? "—"}</td>
                <td className="px-4 py-2.5 tabular-nums text-neutral-500">
                  {c.status === "active" ? (
                    <span className="flex items-center gap-1.5"><PulseDot /> {mmss(now - Date.parse(c.started_at))}</span>
                  ) : (
                    fmtDur(c.duration_s)
                  )}
                </td>
                <td className="px-4 py-2.5"><SatChip n={c.satisfaction} /></td>
                <td className="px-4 py-2.5"><ResIcon r={c.resolution} /></td>
                <td className="max-w-[240px] truncate px-4 py-2.5 text-neutral-500">{c.review ?? ""}</td>
              </tr>
              {expanded === c.id && (
                <tr className="border-b border-[var(--border)] last:border-0">
                  <td colSpan={HEADERS.length} className="bg-neutral-50/40 p-0">
                    <CallDetail call={c} events={events} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {!calls.length && (
            <tr><td colSpan={HEADERS.length} className="px-4 py-10 text-center text-xs text-neutral-400">no calls yet</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CallDetail({ call, events }: { call: CallRow; events: CallEvent[] }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events.length]);

  const seek = (sec: number) => {
    if (audioRef.current) audioRef.current.currentTime = Math.max(0, sec);
  };

  const turns = events.filter((e) => ["user_said", "agent_said", "human_segment", "tool_call"].includes(e.type));
  const callerShade =
    call.satisfaction != null && call.satisfaction < 5
      ? `rgba(239,68,68,${((5 - call.satisfaction) * 0.12).toFixed(2)})`
      : "#f5f5f5";

  return (
    <div className="grid grid-cols-2 gap-6 border-t border-[var(--border)] p-5">
      <div className="min-w-0 space-y-4">
        <audio ref={audioRef} controls preload="none" src={`/api/calls/${call.id}/recording`} className="w-full" />
        <CallTimeline events={events} durationS={call.duration_s} onSeek={seek} />
      </div>
      <div className="min-w-0 space-y-4">
        <div ref={scrollRef} className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-[var(--border)] bg-white p-4">
          {turns.map((e) =>
            e.type === "tool_call" ? (
              <div key={e.id} className="pl-16">
                <span className="rounded border border-[var(--border)] bg-neutral-50 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
                  {String(e.payload?.name ?? "tool")}(…)
                </span>
              </div>
            ) : (
              <div key={e.id} className="flex gap-2 text-[13px]">
                <span
                  className={`w-14 shrink-0 pt-1 text-[10px] uppercase leading-tight tracking-wide ${
                    e.type === "user_said" ? "text-neutral-900" : e.type === "human_segment" ? "text-[#6366f1]" : "text-neutral-400"
                  }`}
                >
                  {e.type === "user_said" ? "caller" : e.type === "human_segment" ? "human agent" : "agent"}
                </span>
                <span
                  className="min-w-0 flex-1 rounded-lg px-2 py-1 leading-relaxed text-neutral-700"
                  style={e.type === "user_said" ? { background: callerShade } : undefined}
                >
                  {String(e.payload?.text ?? "")}
                </span>
              </div>
            )
          )}
          {!turns.length && <div className="py-6 text-center text-xs text-neutral-400">no transcript</div>}
        </div>
        {(call.review || call.resolution) && (
          <div className="rounded-xl border border-[var(--border)] bg-white p-4">
            <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wide text-neutral-400">
              <ResIcon r={call.resolution} /> review
            </div>
            <p className="text-[13px] leading-relaxed text-neutral-700">{call.review}</p>
          </div>
        )}
      </div>
    </div>
  );
}

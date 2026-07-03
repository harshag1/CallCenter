// Author: Harsha Gundala
// CallsTable.tsx — call log: expandable rows with a custom player, speaker-lane timeline, synced transcript, review.

"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Pause, Play, RotateCcw } from "lucide-react";
import { useLiveEvents } from "@/components/hooks/useLiveEvents";
import type { LiveEvent } from "@/lib/realtime-types";
import CallTimeline, { buildTimeline } from "./CallTimeline";
import Tooltip from "@/components/ui/Tooltip";
import {
  DirIcon, PulseDot, ResIcon, SPEAKER_COLOR, SatChip, fmtDur, fmtTime, mmss,
  speakerTextColor, useNow, type CallEvent, type CallRow,
} from "./shared";

export type CallFocus = {
  callId: string;
  agentId: string;
  visited: string[];
  activeNode: string | null;
  holdCountdown: { until: string } | null;
};

const HEADERS = ["", "time", "flow", "origin", "duration", "sat", "resolution", "review"];

const isMissed = (c: CallRow) => c.status === "no-answer" || c.status === "failed";

const counterparty = (c: CallRow) => (c.direction === "outbound" ? c.to_number : c.from_number);

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

  // Recall lineage: child rows carry parent_call_id; parents with a recall child get a hint.
  const recalledParents = useMemo(() => {
    const set = new Set<string>();
    for (const c of calls) if (c.parent_call_id) set.add(c.parent_call_id);
    return set;
  }, [calls]);

  const jumpToCall = useCallback((id: string) => {
    void openCall(id);
    requestAnimationFrame(() =>
      document.getElementById(`call-row-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
    );
  }, [openCall]);

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
            {HEADERS.map((h, i) => (
              <th key={i} className={h ? "px-4 py-2.5 font-medium" : "w-8 py-2.5 pl-4 pr-0"}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <Fragment key={c.id}>
              <tr
                id={`call-row-${c.id}`}
                onClick={() => (expanded === c.id ? closeCall() : void openCall(c.id))}
                className={`cursor-pointer border-b border-[var(--border)] transition-colors duration-[160ms] last:border-0 ${
                  isMissed(c)
                    ? `bg-red-50/60 hover:bg-red-50 ${expanded === c.id ? "bg-red-50" : ""}`
                    : `hover:bg-neutral-50 ${expanded === c.id ? "bg-neutral-50" : ""}`
                }`}
              >
                <td className="w-8 py-2.5 pl-4 pr-0"><DirIcon d={c.direction} size={14} /></td>
                <td className="px-4 py-2.5 tabular-nums text-neutral-500">{fmtTime(c.started_at)}</td>
                <td className="px-4 py-2.5">
                  <span className="inline-flex max-w-[180px] items-center truncate">
                    {c.flow_name ?? c.agent}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="inline-flex items-center gap-1.5">
                    {counterparty(c) ? (
                      <span className="tabular-nums text-neutral-500">{counterparty(c)}</span>
                    ) : (
                      <span className="text-neutral-400">browser</span>
                    )}
                    {c.parent_call_id && (
                      <Tooltip content="Recall — jump to original call">
                        <button
                          onClick={(e) => { e.stopPropagation(); jumpToCall(c.parent_call_id!); }}
                          className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-neutral-500 transition-colors duration-[160ms] hover:border-neutral-900 hover:text-neutral-900"
                        >
                          <RotateCcw size={9} /> recall
                        </button>
                      </Tooltip>
                    )}
                    {recalledParents.has(c.id) && (
                      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-400">
                        recalled <CornerDownLeft size={9} />
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-2.5 tabular-nums text-neutral-500">
                  {c.status === "active" ? (
                    <span className="flex items-center gap-1.5"><PulseDot /> {mmss(now - Date.parse(c.started_at))}</span>
                  ) : (
                    fmtDur(c.duration_s)
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {isMissed(c) ? (
                    <span className="inline-flex h-5 items-center rounded-full bg-red-500 px-2 text-[10px] font-medium text-white">
                      Missed
                    </span>
                  ) : c.satisfaction != null ? (
                    <Tooltip variant="panel" content={<SatGlance n={c.satisfaction} />}>
                      <SatChip n={c.satisfaction} />
                    </Tooltip>
                  ) : (
                    <SatChip n={c.satisfaction} />
                  )}
                </td>
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

/** Panel-tooltip body: 10-segment satisfaction bar. */
function SatGlance({ n }: { n: number }) {
  const fill = n < 5 ? "#ef4444" : n > 5 ? "#10b981" : "#a3a3a3";
  return (
    <span className="block">
      <span className="mb-1 flex justify-between">
        <span className="text-[8px] font-medium uppercase tracking-[0.22em] text-neutral-400">Satisfaction</span>
        <span className="text-[10px] text-neutral-900 tabular-nums">{n}/10</span>
      </span>
      <span className="flex gap-[3px]">
        {Array.from({ length: 10 }, (_, i) => (
          <span
            key={i}
            className="h-1.5 flex-1 rounded-[1px]"
            style={{ background: i < n ? fill : "#f0f0f0" }}
          />
        ))}
      </span>
    </span>
  );
}

function CallDetail({ call, events }: { call: CallRow; events: CallEvent[] }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [posMs, setPosMs] = useState(0);

  // audio_start marks recorded audio; only then fetch + buffer the recording.
  const hasAudioStart = useMemo(() => events.some((e) => e.type === "audio_start"), [events]);
  useEffect(() => {
    if (!hasAudioStart) return;
    let live = true;
    let url: string | null = null;
    void (async () => {
      try {
        const r = await fetch(`/api/calls/${call.id}/recording`);
        if (!r.ok || !live) return;
        const blob = await r.blob();
        if (!live) return;
        url = URL.createObjectURL(blob);
        setAudioUrl(url);
      } catch { /* no recording */ }
    })();
    return () => {
      live = false;
      setAudioUrl(null);
      if (url) URL.revokeObjectURL(url);
    };
  }, [call.id, hasAudioStart]);

  const tl = useMemo(() => buildTimeline(events, call.duration_s), [events, call.duration_s]);
  const lines = useMemo(() => (tl?.segs ?? []).filter((s) => s.text), [tl]);
  const activeId = useMemo(() => {
    if (!audioUrl) return null;
    let id: number | null = null;
    for (const l of lines) if (posMs >= l.startMs && posMs < l.endMs) id = l.evId;
    return id;
  }, [lines, posMs, audioUrl]);

  const seek = useCallback((sec: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.max(0, Number.isFinite(a.duration) ? Math.min(sec, a.duration) : sec);
    setPosMs(a.currentTime * 1000);
  }, []);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }, []);

  // Live calls: keep the newest turn in view as events stream in.
  useEffect(() => {
    if (call.status === "active") transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [events.length, call.status]);

  // Playback: keep the active utterance in view.
  useEffect(() => {
    if (playing && activeId != null) {
      document.getElementById(`utt-${activeId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeId, playing]);

  return (
    <div className="w-0 min-w-full border-t border-[var(--border)] px-5 py-4">
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="auto"
          className="hidden"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setPosMs(e.currentTarget.currentTime * 1000)}
        />
      )}
      <div className="flex items-start gap-3">
        {audioUrl && (
          <button
            aria-label={playing ? "Pause" : "Play"}
            onClick={toggle}
            className="mt-[11px] inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-neutral-950 text-white transition duration-[160ms] hover:-translate-y-px hover:bg-neutral-800"
          >
            {playing
              ? <Pause size={14} fill="currentColor" strokeWidth={0} />
              : <Play size={14} fill="currentColor" strokeWidth={0} className="ml-0.5" />}
          </button>
        )}
        <CallTimeline
          events={events}
          durationS={call.duration_s}
          audioRef={audioUrl ? audioRef : undefined}
          seekable={!!audioUrl}
          onSeek={seek}
        />
      </div>
      <div ref={transcriptRef} className="mt-3 max-h-[420px] space-y-0.5 overflow-y-auto">
        {lines.map((l) => (
          <button
            key={l.evId}
            id={`utt-${l.evId}`}
            onClick={() => seek(l.startMs / 1000)}
            disabled={!audioUrl}
            className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-1 text-left transition-colors duration-[160ms] ${
              l.evId === activeId ? "bg-neutral-100" : audioUrl ? "hover:bg-neutral-50" : "cursor-default"
            }`}
          >
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: SPEAKER_COLOR[l.kind] }} />
            <span className="min-w-0 flex-1 text-[13px] leading-relaxed" style={{ color: speakerTextColor(l.kind, call.satisfaction) }}>
              {l.text}
            </span>
          </button>
        ))}
        {!lines.length && <div className="py-6 text-center text-xs text-neutral-400">no transcript</div>}
      </div>
      {(call.review || call.resolution || call.satisfaction != null) && (
        <div className="mt-4 px-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">review</span>
            <ResIcon r={call.resolution} />
            {call.satisfaction != null && <SatChip n={call.satisfaction} />}
          </div>
          {call.review && <p className="mt-1.5 max-w-[90ch] text-[13px] leading-relaxed text-neutral-700">{call.review}</p>}
        </div>
      )}
    </div>
  );
}

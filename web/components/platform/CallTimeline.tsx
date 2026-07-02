// Author: Harsha Gundala
// CallTimeline.tsx — horizontal call timeline: turn blocks, human segments, hold hatches, tool markers; click seeks audio.

"use client";

import { useMemo } from "react";
import { mmss, type CallEvent } from "./shared";

type Seg = { kind: "agent" | "caller" | "human" | "hold"; start: number; end: number };
type Marker = { at: number; name: string };

const SEG_COLOR: Record<string, string> = { agent: "#171717", caller: "#d4d4d4", human: "#6366f1" };
const HOLD_BG = "repeating-linear-gradient(45deg, rgba(245,158,11,0.85) 0 3px, rgba(253,230,138,0.9) 3px 6px)";

function toMs(v: unknown, fallback: number): number {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const p = Date.parse(String(v ?? ""));
  return Number.isNaN(p) ? fallback : p;
}

function build(events: CallEvent[], durationS: number | null | undefined) {
  if (!events.length) return null;
  const evMs = (e: CallEvent) => Date.parse(e.ts);
  const audio = events.find((e) => e.type === "audio_start");
  const t0 = audio ? toMs(audio.payload?.at, evMs(audio)) : evMs(events[0]);
  const last = evMs(events[events.length - 1]);
  const total = Math.max(last - t0, (durationS ?? 0) * 1000, 1000);

  // Turn boundaries: prefer precise speech events; fall back to transcript event timestamps.
  const points: { who: "agent" | "caller" | "human"; at: number }[] = [];
  const speech = events.filter((e) => e.type === "speech");
  if (speech.length) {
    for (const e of speech) points.push({ who: e.payload?.who === "agent" ? "agent" : "caller", at: toMs(e.payload?.at, evMs(e)) });
  } else {
    for (const e of events) {
      if (e.type === "agent_said") points.push({ who: "agent", at: evMs(e) });
      else if (e.type === "user_said") points.push({ who: "caller", at: evMs(e) });
    }
  }
  for (const e of events) if (e.type === "human_segment") points.push({ who: "human", at: toMs(e.payload?.at, evMs(e)) });
  points.sort((a, b) => a.at - b.at);

  const segs: Seg[] = points.map((p, i) => ({
    kind: p.who,
    start: Math.max(p.at, t0),
    end: Math.min(points[i + 1]?.at ?? t0 + total, t0 + total),
  }));

  // Holds overlay the turn track (drawn last, on top).
  let open: number | null = null;
  let openUntil = 0;
  for (const e of events) {
    if (e.type === "hold_start") {
      open = evMs(e);
      openUntil = toMs(e.payload?.until, open + Number(e.payload?.seconds ?? 15) * 1000);
    } else if (e.type === "hold_end" && open != null) {
      segs.push({ kind: "hold", start: open, end: evMs(e) });
      open = null;
    }
  }
  if (open != null) segs.push({ kind: "hold", start: open, end: Math.min(openUntil, t0 + total) });

  const markers: Marker[] = events
    .filter((e) => e.type === "tool_call")
    .map((e) => ({ at: evMs(e), name: String(e.payload?.name ?? "tool") }));

  return { t0, total, segs, markers };
}

export default function CallTimeline({
  events, durationS, onSeek,
}: { events: CallEvent[]; durationS?: number | null; onSeek: (sec: number) => void }) {
  const tl = useMemo(() => build(events, durationS), [events, durationS]);
  if (!tl) return <div className="py-4 text-center text-xs text-neutral-300">no timeline</div>;

  const pctOf = (v: number) => `${Math.min(Math.max(((v - tl.t0) / tl.total) * 100, 0), 100)}%`;

  return (
    <div>
      <div
        className="relative h-9 w-full cursor-pointer overflow-hidden rounded-lg border border-[var(--border)] bg-neutral-50"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * (tl.total / 1000));
        }}
      >
        {tl.segs.map((s, i) => (
          <div
            key={i}
            title={s.kind === "hold" ? `hold ${mmss(s.end - s.start)}` : `${s.kind} · ${mmss(s.start - tl.t0)}`}
            className={`absolute rounded-[3px] ${s.kind === "hold" ? "inset-y-0.5 z-10" : "inset-y-1.5"}`}
            style={{
              left: pctOf(s.start),
              width: `max(${((s.end - s.start) / tl.total) * 100}%, 3px)`,
              background: s.kind === "hold" ? HOLD_BG : SEG_COLOR[s.kind],
            }}
          />
        ))}
        {tl.markers.map((m, i) => (
          <div
            key={`m${i}`}
            title={m.name}
            className="absolute top-1/2 z-20 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-white bg-neutral-900"
            style={{ left: pctOf(m.at) }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-neutral-400">
        <span>0:00</span>
        <span>{mmss(tl.total)}</span>
      </div>
    </div>
  );
}
